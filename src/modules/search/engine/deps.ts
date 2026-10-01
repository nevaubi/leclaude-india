import "server-only";
import type { ResponseInput } from "openai/resources/responses/responses";
import { generateJSON, generateText, runAgent, strictJsonSchema, type AgentEvent } from "@/lib/ai/agent";
import { infer } from "@/lib/ai/runtime";
import { aiConfig } from "@/lib/ai/config";
import type { TokenUsage } from "@/lib/ai/events";
import type { ToolContext, ToolDef } from "@/lib/ai/tools";
import { webSearchTool } from "@/lib/ai/toolkit/web";
import type { CitationResolution } from "@/lib/ai/toolkit/legal";
import { citingReferences, ikSource, indianKanoonClient, isIndiaSourceDoc, judgmentRow, resolveIndianCitation, searchJudgments, searchStatuteSections, statuteRow, visibleMatters, type IndianCitationResolution } from "@/lib/ai/toolkit/india";
import { htmlToText } from "@/lib/ai/toolkit/http";
import { listEnactments } from "@/modules/india/sources";
import { courtForDocsource } from "@/modules/india/sources/indian-kanoon";
import type { SearchResultBlock } from "@/lib/ai/providers/types";
import { searchLibraryTool, searchEdiscoveryTool } from "@/lib/ai/toolkit/internal";
import { verifyClaims, type VerificationResult } from "@/lib/ai/verify";
import { getDocumentText, intelDocuments, primaryDate, searchIntel } from "@/modules/intel/store";
import type { IntelDocumentKind, IntelSearchHit } from "@/modules/intel/types";
import { extractAnswerCitations } from "../india-citations";
import { classifyAuthority, resolveCourts } from "../jurisdictions";
import { normalizeIndiaSection, normalizeJudgment, normalizeToolResult } from "../normalize";
import { datePresetRange } from "../query-builder";
import { readSource } from "../service";
import type { ReadRef, SearchHit, SearchSettings, SearchSource } from "../types";
import { RESEARCH_MODEL_POLICY as POLICY } from "./model-policy";
import { FOLLOW_UP_INSTRUCTIONS, PLAN_INSTRUCTIONS, REFINE_INSTRUCTIONS, TRANSLATE_QUERY_INSTRUCTIONS } from "./prompts";
import { classifyTreatment, INDIAN_NEGATIVE_TREATMENT_PHRASES } from "./treatment";
import type { AuthorityTreatment, LaneKind } from "./types";
import { FEATURES } from "@/lib/features";
import { currentPrincipal } from "@/lib/auth/context";
import { listDocSets, readDocPassage, searchDocSets } from "@/modules/documents/server";
import type { DocSearchHit } from "@/modules/documents/types";
import { remoteStore } from "@/lib/db/remote";
import { searchCorpus, type CorpusHit } from "@/modules/india/corpus/search";
import { caseHref } from "@/modules/caselaw/shared";
import { chunksToText, readJudgmentText, searchJudgmentText, type TextSearchHit } from "@/modules/india/corpus/text";

/** Model-derived plan: jurisdiction-aware sub-questions and extra retrieval queries per lane kind. */
export interface ResearchPlan {
  subQuestions: string[];
  queries: Partial<Record<LaneKind, string[]>>;
}

/**
 * Everything the research engine needs from the outside world, so the
 * orchestrator can be exercised end to end with fakes (no network, no key).
 */
export interface EngineDeps {
  hasKey: boolean;
  model: string;
  fastModel: string;
  /** Structured provider search for one source kind. Never throws for "no results"; throws for provider failures. */
  retrieve(source: SearchSource, query: string, settings: SearchSettings, signal?: AbortSignal): Promise<{ hits: SearchHit[]; total: number }>;
  /** Full text for a read reference (cached 24h by the service for external reads). */
  read(ref: ReadRef, opts: { title?: string; signal?: AbortSignal }): Promise<{ text: string; title?: string; cite?: string; url?: string; cached: boolean }>;
  /** A bounded lane agent run. Returns the lane note (and token usage when the runtime reports it). */
  laneAgent(input: { instructions: string; input: string; tools: ToolDef<never, unknown>[]; web: boolean; maxSteps: number; signal?: AbortSignal; onEvent: (e: AgentEvent) => void }): Promise<{ text: string; steps: number; usage?: TokenUsage }>;
  /**
   * Synthesis with streaming deltas (primary model, no tools). `instructions` are byte-stable per mode (cacheable prefix);
   * `evidence` carries the numbered sources as citation-native search_result blocks. A plain string is accepted; an object
   * may carry token usage.
   */
  synthesize(input: { instructions: string; input: string | ResponseInput; evidence?: SearchResultBlock[]; signal?: AbortSignal; onDelta: (d: string) => void }): Promise<string | { text: string; usage?: TokenUsage }>;
  verify(input: { answer: string; sources: { title?: string; cite?: string; url?: string; text: string }[]; signal?: AbortSignal }): Promise<VerificationResult>;
  correct(input: { instructions: string; input: string; signal?: AbortSignal }): Promise<string>;
  refine(input: { question: string; gaps: string[]; laneKinds: LaneKind[]; signal?: AbortSignal }): Promise<Partial<Record<LaneKind, string[]>>>;
  followUps(input: { question: string; answer: string; matterLine: string; signal?: AbortSignal }): Promise<string[]>;
  /** Citations that resolve somewhere other than the sources read (LeClaude India: the judgment corpus). */
  verifyCitationsRemote(text: string, signal?: AbortSignal): Promise<string[]>;
  // ---- optional capabilities (absent in minimal fakes; the run degrades to the deterministic path) ----
  /** Fast-model planning: sub-questions and per-lane queries. Runs concurrently with the first retrieval wave. */
  planQueries?(input: { question: string; context: string; laneKinds: LaneKind[]; signal?: AbortSignal }): Promise<ResearchPlan>;
  /** Citing-reference treatment signal for a judgment (corpus) or a CourtListener opinion (never an assertion of good law). */
  citing?(input: { opinionId?: number; judgmentId?: string; signal?: AbortSignal }): Promise<AuthorityTreatment>;
  /** Overrides the run wall (researchWallMs); stage budgets scale with it. Tests only. */
  wallMs?: number;
  /** Resolve one citation without substitution (Indian corpus; the US resolution shape is accepted for compatibility). */
  resolveCitation?(citation: string, signal?: AbortSignal): Promise<CitationResolution | IndianCitationResolution>;
  /**
   * Translate a non-English question into English search terms (legal terms and section numbers preserved). Runs on the
   * fast router role when the privacy policy allows it, else on the internal fast role. Absent in minimal fakes.
   */
  translateQuery?(input: { question: string; language: string; matterId?: string | null; signal?: AbortSignal }): Promise<{ query: string; model?: string }>;
}

function toolCtx(signal?: AbortSignal): ToolContext {
  return { emit: () => {}, signal, state: {} };
}

/**
 * Judgments from the Neon metadata corpus (SC 1950–, focus High Courts) for the case-law lane. Metadata and the
 * dataset's snippet only — no full text — so the hit carries no readRef and is never treated as read; it links to its
 * record page (/cases/<id>), which shows the official PDF and the dataset provenance. A record already returned by
 * another provider (same neutral citation, or same court + case number) is not repeated.
 */
export async function corpusCaselawHits(query: string, o: { courts: string[]; yearFrom?: number; yearTo?: number; limit: number; existing: SearchHit[]; nctx: { jurisdiction: SearchSettings["jurisdiction"]; courts: SearchSettings["courts"] } }): Promise<SearchHit[]> {
  if (!remoteStore() || !query.trim()) return [];
  const { hits } = await searchCorpus({ q: query, courts: o.courts.length ? o.courts : undefined, yearFrom: o.yearFrom, yearTo: o.yearTo, limit: o.limit });
  const norm = (v?: string | null) => (v ?? "").replace(/\s+/g, " ").trim().toUpperCase();
  const seen = new Set<string>();
  for (const h of o.existing) {
    for (const c of h.citations ?? (h.cite ? [h.cite] : [])) seen.add(`cite:${norm(c)}`);
    if (h.courtId && h.docketNumber) seen.add(`case:${h.courtId}:${norm(h.docketNumber)}`);
  }
  const out: SearchHit[] = [];
  for (const h of hits) {
    // Records that match only some of the query words (titles and snippets, not full text) are noise as research
    // sources, e.g. a party named "Bail" for "anticipatory bail". The directory still offers them to a person.
    if (h.match === "partial") continue;
    const keys = [h.neutral_citation ? `cite:${norm(h.neutral_citation)}` : "", h.court_id && h.case_number ? `case:${h.court_id}:${norm(h.case_number)}` : ""].filter(Boolean);
    if (keys.some((k) => seen.has(k))) continue;
    keys.forEach((k) => seen.add(k));
    out.push(corpusHit(h, o.nctx));
  }
  return out;
}

function corpusHit(h: CorpusHit, nctx: { jurisdiction: SearchSettings["jurisdiction"]; courts: SearchSettings["courts"] }): SearchHit {
  const citations = [h.neutral_citation, h.reporter_citation].filter((x): x is string => Boolean(x));
  return {
    id: `corpus:${h.id}`,
    source: "caselaw",
    title: h.title || "Untitled judgment",
    subtitle: [h.court ?? (h.court_code ? `Unmapped court code ${h.court_code}` : ""), h.case_number, "metadata record"].filter(Boolean).join(" · "),
    cite: citations[0] ?? h.case_number ?? undefined,
    citations,
    court: h.court ?? undefined,
    courtId: h.court_id ?? undefined,
    date: h.decision_date ?? undefined,
    snippet: (h.snippet ?? "").replace(/\s+/g, " ").trim().slice(0, 600),
    url: caseHref(h.id),
    judge: h.judges.join(", ") || undefined,
    docketNumber: h.case_number ?? undefined,
    authority: classifyAuthority(h.court_id, nctx.jurisdiction, nctx.courts, h.decision_date ?? undefined),
    india: { judgmentId: h.id, courtId: h.court_id, judges: h.judges, neutralCitation: h.neutral_citation ?? undefined, reporterCitations: h.reporter_citation ? [h.reporter_citation] : undefined, caseNumber: h.case_number ?? undefined, provider: "corpus" },
    // Full text exists (Supreme Court text corpus): the reader can read it. Metadata-only records stay unreadable.
    ...(h.text_status === "full" ? { readRef: { kind: "url" as const, url: `${CORPUS_TEXT_PREFIX}${h.id}` } } : {}),
  };
}

export const CORPUS_TEXT_PREFIX = "corpus-text://";

/**
 * Supreme Court full-text hits (best passage per judgment, with its page). Only when the Supreme Court is in scope;
 * judgments already returned by another provider (same neutral citation) are skipped. Every hit is readable.
 */
export async function corpusTextHits(query: string, o: { courts: string[]; yearFrom?: number; yearTo?: number; limit: number; existing: SearchHit[]; nctx: { jurisdiction: SearchSettings["jurisdiction"]; courts: SearchSettings["courts"] } }): Promise<SearchHit[]> {
  if (!remoteStore() || !query.trim()) return [];
  if (o.courts.length && !o.courts.includes("sci")) return [];
  const { hits } = await searchJudgmentText(query, { yearFrom: o.yearFrom, yearTo: o.yearTo, limit: o.limit });
  const norm = (v?: string | null) => (v ?? "").replace(/\s+/g, " ").trim().toUpperCase();
  const seen = new Set<string>();
  for (const h of o.existing) for (const c of h.citations ?? (h.cite ? [h.cite] : [])) seen.add(norm(c));
  const out: SearchHit[] = [];
  for (const h of hits) {
    if (seen.has(norm(h.neutralCitation))) continue;
    seen.add(norm(h.neutralCitation));
    out.push(textHit(h, o.nctx));
  }
  return out;
}

function textHit(h: TextSearchHit, nctx: { jurisdiction: SearchSettings["jurisdiction"]; courts: SearchSettings["courts"] }): SearchHit {
  const citations = [h.neutralCitation, h.reporterCitation].filter((x): x is string => Boolean(x));
  const id = h.judgmentId ?? h.neutralCitation;
  return {
    id: `corpus:${id}`,
    source: "caselaw",
    title: h.title || h.neutralCitation,
    subtitle: [h.court, h.pageStart != null ? `passage at p. ${h.pageStart}` : "", "full text"].filter(Boolean).join(" · "),
    cite: h.neutralCitation,
    citations,
    court: h.court,
    courtId: "sci",
    date: h.decisionDate ?? undefined,
    snippet: h.passage.slice(0, 600),
    url: h.judgmentId ? `${caseHref(h.judgmentId)}${h.pageStart != null ? `#p${h.pageStart}` : ""}` : undefined,
    judge: h.judges.join(", ") || undefined,
    score: h.rank,
    authority: classifyAuthority("sci", nctx.jurisdiction, nctx.courts, h.decisionDate ?? undefined),
    india: { judgmentId: id, courtId: "sci", judges: h.judges, neutralCitation: h.neutralCitation, reporterCitations: h.reporterCitation ? [h.reporterCitation] : undefined, provider: "corpus" },
    readRef: { kind: "url", url: `${CORPUS_TEXT_PREFIX}${id}` },
  };
}

/**
 * "Matter documents" in LeClaude India: the matter's document sets (e-discovery is hidden). Only sets on the selected
 * matter that the principal can read; no matter selected → nothing (never widened to other sets).
 */
async function matterDocumentHits(query: string, matterId: string | null | undefined, limit: number): Promise<{ hits: SearchHit[]; total: number }> {
  const principal = currentPrincipal();
  if (!principal || !matterId) return { hits: [], total: 0 };
  const setIds = (await listDocSets(principal)).filter((s) => s.matterId === matterId).map((s) => s.id);
  if (!setIds.length) return { hits: [], total: 0 };
  const found = await searchDocSets(principal, setIds, query, { limit });
  const hits = found.map(docHit);
  return { hits, total: hits.length };
}

function docHit(h: DocSearchHit): SearchHit {
  const where = h.page != null ? `, p. ${h.page}` : "";
  return {
    id: `ediscovery:${h.source}`,
    source: "ediscovery",
    title: `${h.fileName}${where}${h.ocr ? " (OCR)" : ""}`,
    snippet: h.text.slice(0, 400),
    url: `/documents/${encodeURIComponent(h.setId)}?tab=files&file=${encodeURIComponent(h.fileId)}${h.page != null ? `&page=${h.page}` : ""}`,
    score: h.score,
    authority: "n/a",
    readRef: { kind: "url", url: h.source },
  };
}

function withTimeout<T>(p: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    const onAbort = () => { clearTimeout(t); reject(new DOMException("Aborted", "AbortError")); };
    signal?.addEventListener("abort", onAbort, { once: true });
    p.then((v) => { clearTimeout(t); signal?.removeEventListener("abort", onAbort); resolve(v); }, (e) => { clearTimeout(t); signal?.removeEventListener("abort", onAbort); reject(e); });
  });
}

/**
 * Intelligence record kinds that feed each provider source. LeClaude India: judgments and India Code Acts ingested by
 * the India source layer reach the lanes through `searchJudgments` / `searchStatuteSections` (with their registry court
 * and citations), so the intel feed skips those records (`excludeIndiaSourceDocs`) and adds only other intelligence
 * (opinions and statutes from other adapters, local files, news).
 */
export const INTEL_KINDS_FOR_SOURCE: Partial<Record<SearchSource, IntelDocumentKind[]>> = {
  caselaw: ["opinion"],
  statutes: ["statute"],
  library: ["local_file", "news", "web_page", "judge", "attorney", "firm", "expert"],
};

/** True for intel documents the India source layer owns (judgments carry meta.india; Acts are linked from enactments). */
function indiaOwnedDocIds(): Set<string> {
  try { return new Set(listEnactments({ limit: 1000 }).map((e) => e.intelDocId).filter((x): x is string => Boolean(x))); } catch { return new Set(); }
}

const INTEL_KIND_LABEL: Partial<Record<IntelDocumentKind, string>> = { opinion: "Judgment", statute: "Statute", regulation: "Rule", court_rule: "Court rule", register_notice: "Gazette notification", local_file: "Local file", news: "News", web_page: "Web page", judge: "Judge", attorney: "Advocate", firm: "Firm", expert: "Expert" };

/** Read reference scheme for intelligence records (`deps.read` resolves it from the store, no network). */
export const INTEL_READ_PREFIX = "intel://";

/** Read reference scheme for live Indian Kanoon documents (`deps.read` fetches them with the firm token). */
export const IK_READ_PREFIX = "ik://";

/** Normalize an intelligence hit onto a provider source kind so lanes, citations and reading treat it like any other authority. */
export function intelHitToSearchHit(h: IntelSearchHit, source: SearchSource, settings: Pick<SearchSettings, "jurisdiction" | "courts">): SearchHit {
  const d = h.doc;
  const courtId = intelDocuments().get(d.id)?.courtId;
  const kind = INTEL_KIND_LABEL[d.kind] ?? d.kind;
  const flagged = d.flags.filter((f) => f.kind !== "stale").map((f) => f.kind.replace(/_/g, " "));
  return {
    id: `intel:${d.id}`,
    source,
    title: d.caseName && d.kind !== "docket_entry" ? d.caseName : d.title,
    subtitle: [d.court, d.docketNumber ? `No. ${d.docketNumber}` : "", `${kind} · intelligence corpus`, flagged.length ? `flagged: ${flagged.join(", ")}` : ""].filter(Boolean).join(" · "),
    cite: d.citation,
    citations: d.citation ? [d.citation] : [],
    court: d.court,
    courtId,
    date: primaryDate(d.dates),
    snippet: h.chunk.text.slice(0, 400),
    url: d.url,
    score: h.score,
    authority: source === "caselaw" ? classifyAuthority(courtId, settings.jurisdiction, settings.courts, primaryDate(d.dates)) : "n/a",
    readRef: { kind: "url", url: `${INTEL_READ_PREFIX}${d.id}` },
    docketNumber: d.docketNumber,
  };
}

/** Hits from the intelligence corpus for a provider source (empty when the source has no intel kinds; never throws). */
export async function intelHitsFor(source: SearchSource, query: string, settings: SearchSettings, limit = 6): Promise<SearchHit[]> {
  const kinds = INTEL_KINDS_FOR_SOURCE[source];
  if (!kinds?.length || !query.trim()) return [];
  try {
    const range = datePresetRange(settings.datePreset, { from: settings.dateFrom, to: settings.dateTo });
    const hits = await searchIntel({ q: query, kinds, matterId: settings.matterId ?? undefined, dateFrom: range.from, dateTo: range.to, limit: limit * 2 });
    const seen = new Set<string>();
    const acts = source === "statutes" ? indiaOwnedDocIds() : new Set<string>();
    const docs = intelDocuments();
    return hits
      .filter((h) => { if (seen.has(h.doc.id)) return false; seen.add(h.doc.id); return true; })
      .filter((h) => !acts.has(h.doc.id) && !isIndiaSourceDoc(docs.get(h.doc.id)))
      .slice(0, limit)
      .map((h) => intelHitToSearchHit(h, source, settings));
  } catch (e) {
    console.warn("[research] intel retrieval failed:", (e as Error).message);
    return [];
  }
}

/** Merge provider hits with intel hits, dropping intel rows that duplicate a provider hit (same url or citation). */
export function mergeIntelHits(provider: SearchHit[], intel: SearchHit[]): SearchHit[] {
  const urls = new Set(provider.map((h) => h.url?.toLowerCase()).filter(Boolean));
  const cites = new Set(provider.map((h) => h.cite?.toLowerCase().replace(/\s+/g, " ")).filter(Boolean));
  return [...provider, ...intel.filter((h) => !(h.url && urls.has(h.url.toLowerCase())) && !(h.cite && cites.has(h.cite.toLowerCase().replace(/\s+/g, " "))))];
}

/** Live Indian Kanoon hits (only when the connector is ready), normalized as judgments with an ik:// read reference. Court from the exact docsource name. */
async function indianKanoonHits(query: string, courts: string[], settings: SearchSettings, signal?: AbortSignal): Promise<SearchHit[]> {
  const ik = indianKanoonClient();
  if (!ik) return [];
  const data = await ik.search({ formInput: query, signal });
  const out: SearchHit[] = [];
  for (const d of data.docs.slice(0, 8)) {
    const date = typeof d.publishdate === "string" ? d.publishdate.slice(0, 10) : undefined;
    const { court, unresolved } = courtForDocsource(d.docsource, date);
    if (courts.length && !(court && courts.includes(court.id))) continue;
    out.push({
      id: `ik:${d.tid}`, source: "caselaw", title: htmlToText(d.title ?? "").text || `Indian Kanoon ${d.tid}`, subtitle: [d.docsource, "Indian Kanoon (live)"].filter(Boolean).join(" · "),
      court: court?.name ?? d.docsource, courtId: court?.id, date, snippet: htmlToText(d.headline ?? "").text.slice(0, 400), url: ik.webUrl(d.tid),
      authority: classifyAuthority(court?.id, settings.jurisdiction, settings.courts, date), readRef: { kind: "url", url: `${IK_READ_PREFIX}${d.tid}` },
      india: { courtId: court?.id ?? null, unresolvedCourt: unresolved, provider: "indian-kanoon" },
    });
  }
  return out;
}

/** Stable source for a live Indian Kanoon hit (the evidence id the model sees). */
export const ikEvidenceSource = ikSource;

const LANE_ENUM = ["controlling", "persuasive", "contrary", "statute", "regulatory", "record", "secondary", "fast"];
const PLAN_SCHEMA = { type: "object", properties: { subQuestions: { type: "array", items: { type: "string" } }, lanes: { type: "array", items: { type: "object", properties: { lane: { type: "string", enum: LANE_ENUM }, queries: { type: "array", items: { type: "string" } } }, required: ["lane", "queries"] } } }, required: ["subQuestions", "lanes"] };
const FOLLOWUP_SCHEMA = { type: "object", properties: { questions: { type: "array", items: { type: "string" } } }, required: ["questions"] };
const REFINE_SCHEMA = { type: "object", properties: { refinements: { type: "array", items: { type: "object", properties: { lane: { type: "string", enum: LANE_ENUM }, queries: { type: "array", items: { type: "string" } } }, required: ["lane", "queries"] } } }, required: ["refinements"] };
const TRANSLATE_SCHEMA = { type: "object", properties: { query: { type: "string" } }, required: ["query"] };

export function defaultDeps(): EngineDeps {
  const cfg = aiConfig();
  return {
    hasKey: cfg.hasKey,
    model: cfg.model,
    fastModel: cfg.fastModel,

    async retrieve(source, query, settings, signal) {
      const ctx = toolCtx(signal);
      const range = datePresetRange(settings.datePreset, { from: settings.dateFrom, to: settings.dateTo });
      const limit = Math.min(settings.limit, 12);
      const nctx = { jurisdiction: settings.jurisdiction, courts: settings.courts };
      const year = (d?: string) => (d ? Number(d.slice(0, 4)) : undefined);
      const job = async (): Promise<{ hits: SearchHit[]; total: number }> => {
        switch (source) {
          case "caselaw": {
            const courts = resolveCourts(settings.jurisdiction, settings.courts).split(" ").filter(Boolean);
            // Judgments are public authority; a matter-linked record is visible only inside its matters (never widened).
            const allowed = visibleMatters({ state: { matterId: settings.matterId ?? undefined } });
            const local = await searchJudgments(query, { courts, yearFrom: year(range.from), yearTo: year(range.to) }, { limit, allowed });
            const hits = local.map((h) => normalizeJudgment(judgmentRow(h), nctx));
            try { hits.push(...(await corpusTextHits(query, { courts, yearFrom: year(range.from), yearTo: year(range.to), limit: Math.min(limit, 8), existing: hits, nctx }))); } catch (e) { if ((e as Error).name === "AbortError") throw e; console.warn("[research] judgment text search failed:", (e as Error).message); }
            try { hits.push(...(await corpusCaselawHits(query, { courts, yearFrom: year(range.from), yearTo: year(range.to), limit: Math.min(limit, 8), existing: hits, nctx }))); } catch (e) { if ((e as Error).name === "AbortError") throw e; console.warn("[research] judgment corpus search failed:", (e as Error).message); }
            try { hits.push(...(await indianKanoonHits(query, courts, settings, signal))); } catch (e) { if ((e as Error).name === "AbortError") throw e; console.warn("[research] Indian Kanoon search failed:", (e as Error).message); }
            return { hits, total: hits.length };
          }
          case "statutes": {
            const rows = await searchStatuteSections(query, { limit });
            return { hits: rows.map((r) => normalizeIndiaSection(statuteRow(r))), total: rows.length };
          }
          case "library": return normalizeToolResult(source, await Promise.resolve(searchLibraryTool.execute({ query, matter_id: settings.matterId ?? undefined, limit }, ctx)), nctx);
          case "ediscovery":
            if (!FEATURES.ediscovery) return matterDocumentHits(query, settings.matterId, limit);
            return normalizeToolResult(source, await Promise.resolve(searchEdiscoveryTool.execute({ query, matter_id: settings.matterId ?? undefined, date_after: range.from, date_before: range.to, limit }, ctx)), nctx);
          // US providers are not offered in LeClaude India (the US toolkit still compiles for the US fork).
          case "regulations": case "federal_register": case "dockets": case "web": return { hits: [], total: 0 };
        }
      };
      // The intelligence corpus feeds the same lane in parallel where it adds material (library); its hits are normalized onto the provider kind.
      const intel = intelHitsFor(source, query, settings, 6);
      let provider: { hits: SearchHit[]; total: number };
      try {
        provider = await withTimeout(job(), 25_000, signal);
      } catch (e) {
        const fallback = await intel;
        if (!fallback.length || (e as Error).name === "AbortError") throw e;
        console.warn(`[research] ${source} provider failed; using ${fallback.length} intelligence hit(s):`, (e as Error).message);
        return { hits: fallback, total: fallback.length };
      }
      const extra = await intel;
      const hits = mergeIntelHits(provider.hits, extra);
      return { hits, total: provider.total + (hits.length - provider.hits.length) };
    },

    async read(ref, opts) {
      if (ref.kind === "url" && ref.url.startsWith("docs://")) {
        const principal = currentPrincipal();
        const r = principal ? await readDocPassage(principal, ref.url) : null;
        if (!r) throw new Error("Document passage not found or not accessible");
        return { text: r.context || r.hit.text, title: `${r.hit.fileName}${r.hit.page != null ? `, p. ${r.hit.page}` : ""}`, url: docHit(r.hit).url, cached: true };
      }
      if (ref.kind === "url" && ref.url.startsWith(CORPUS_TEXT_PREFIX)) {
        const id = ref.url.slice(CORPUS_TEXT_PREFIX.length);
        const r = await withTimeout(readJudgmentText(id, { maxChars: 400_000 }), 30_000, opts.signal);
        if (!r || !r.chunks.length) throw new Error(`No full text for judgment ${id}`);
        return { text: chunksToText(r.chunks), title: r.title ? `${r.title}, ${r.neutralCitation}` : r.neutralCitation, cite: r.neutralCitation, url: r.judgmentId ? caseHref(r.judgmentId) : undefined, cached: true };
      }
      if (ref.kind === "url" && ref.url.startsWith(IK_READ_PREFIX)) {
        const ik = indianKanoonClient();
        if (!ik) throw new Error("Indian Kanoon is not configured (the connector is not ready).");
        const tid = Math.floor(Number(ref.url.slice(IK_READ_PREFIX.length)));
        const data = await withTimeout(ik.doc(tid, { signal: opts.signal }), 30_000, opts.signal);
        return { text: htmlToText(data.doc ?? "", { maxChars: 1_000_000 }).text, title: htmlToText(data.title ?? "").text || opts.title, url: ik.webUrl(tid), cached: false };
      }
      if (ref.kind === "url" && ref.url.startsWith(INTEL_READ_PREFIX)) {
        const id = ref.url.slice(INTEL_READ_PREFIX.length);
        const doc = intelDocuments().get(id);
        const text = getDocumentText(id);
        if (!doc || text == null) throw new Error(`Intelligence record ${id} not found`);
        return { text, title: doc.title, cite: doc.citation ?? doc.docketNumber, url: doc.url, cached: true };
      }
      const r = await withTimeout(readSource(ref, opts), 30_000, opts.signal);
      return { text: r.text, title: r.title, cite: r.cite, url: r.url, cached: Boolean(r.meta?.cached) || ref.kind === "judgment" || ref.kind === "section" };
    },

    async laneAgent(input) {
      const res = await runAgent({
        instructions: input.instructions,
        input: input.input,
        tools: input.tools,
        builtinTools: input.web ? [webSearchTool({ contextSize: "low" })] : [],
        model: cfg.fastModel,
        taskType: POLICY.laneAgent.taskType,
        reasoningEffort: POLICY.laneAgent.reasoningEffort,
        cacheStablePrefix: POLICY.laneAgent.cacheStablePrefix,
        verbosity: "low",
        maxSteps: input.maxSteps,
        maxOutputTokens: POLICY.laneAgent.maxOutputTokens,
        signal: input.signal,
        metadata: { app: "leclaude", surface: "research-lane" },
        onEvent: input.onEvent,
      });
      return { text: res.text, steps: res.steps, usage: res.usage };
    },

    async synthesize(input) {
      const res = await runAgent({
        instructions: input.instructions,
        input: input.input,
        evidence: input.evidence?.length ? input.evidence : undefined,
        taskType: POLICY.synthesize.taskType,
        cacheStablePrefix: POLICY.synthesize.cacheStablePrefix,
        maxOutputTokens: POLICY.synthesize.maxOutputTokens,
        maxSteps: 1,
        verbosity: "medium",
        signal: input.signal,
        metadata: { app: "leclaude", surface: "research-synthesis" },
        onEvent: (e) => { if (e.type === "text.delta") input.onDelta(e.delta); },
      });
      return { text: res.text, usage: res.usage };
    },

    verify(input) {
      return verifyClaims({ answer: input.answer, sources: input.sources, maxClaims: 25, signal: input.signal, fast: true });
    },

    async correct(input) {
      const r = await generateText({ fast: POLICY.correct.fast, taskType: POLICY.correct.taskType, reasoningEffort: POLICY.correct.reasoningEffort, cacheStablePrefix: POLICY.correct.cacheStablePrefix, instructions: input.instructions, input: input.input, maxOutputTokens: POLICY.correct.maxOutputTokens, signal: input.signal });
      return r.text;
    },

    async refine(input) {
      const r = await generateJSON<{ refinements: { lane: LaneKind; queries: string[] }[] }>({
        fast: POLICY.refine.fast,
        taskType: POLICY.refine.taskType,
        reasoningEffort: POLICY.refine.reasoningEffort,
        cacheStablePrefix: POLICY.refine.cacheStablePrefix,
        instructions: REFINE_INSTRUCTIONS,
        input: `Question: ${input.question}\nLanes: ${input.laneKinds.join(", ")}\nUnsupported claims:\n${input.gaps.map((g) => `- ${g}`).join("\n")}`,
        schema: REFINE_SCHEMA,
        name: "lane_refinements",
        maxOutputTokens: 600,
        signal: input.signal,
      });
      const out: Partial<Record<LaneKind, string[]>> = {};
      for (const x of r.refinements ?? []) if (x.queries?.length) out[x.lane] = x.queries.slice(0, 2);
      return out;
    },

    async followUps(input) {
      const r = await generateJSON<{ questions: string[] }>({
        fast: POLICY.followUps.fast,
        taskType: POLICY.followUps.taskType,
        reasoningEffort: POLICY.followUps.reasoningEffort,
        cacheStablePrefix: POLICY.followUps.cacheStablePrefix,
        instructions: FOLLOW_UP_INSTRUCTIONS,
        input: `${input.matterLine}\n\nQuestion: ${input.question}\n\nAnswer:\n${input.answer.slice(0, 6000)}`,
        schema: FOLLOWUP_SCHEMA,
        name: "follow_ups",
        maxOutputTokens: 400,
        signal: input.signal,
      });
      return (r.questions ?? []).map((q) => q.trim()).filter(Boolean).slice(0, 3);
    },

    async planQueries(input) {
      const r = await generateJSON<{ subQuestions: string[]; lanes: { lane: LaneKind; queries: string[] }[] }>({
        fast: POLICY.plan.fast,
        taskType: POLICY.plan.taskType,
        reasoningEffort: POLICY.plan.reasoningEffort,
        cacheStablePrefix: POLICY.plan.cacheStablePrefix,
        instructions: PLAN_INSTRUCTIONS,
        input: `${input.context}\nLanes: ${input.laneKinds.join(", ")}\n\nResearch question: ${input.question}`,
        schema: PLAN_SCHEMA,
        name: "research_plan",
        maxOutputTokens: POLICY.plan.maxOutputTokens,
        signal: input.signal,
      });
      const queries: ResearchPlan["queries"] = {};
      for (const x of r.lanes ?? []) if (x.queries?.length) queries[x.lane] = x.queries.map((q) => q.trim()).filter(Boolean).slice(0, 2);
      return { subQuestions: (r.subQuestions ?? []).map((q) => q.trim()).filter(Boolean).slice(0, 5), queries };
    },

    async citing(input) {
      if (!input.judgmentId) return classifyTreatment({ citing: [], citingCount: 0 }, undefined, { basis: "provider" });
      const r = await citingReferences(input.judgmentId, visibleMatters({ state: {} }), { limit: 10 });
      const row = (c: (typeof r.citing)[number]) => ({ title: c.title, date: c.decided, url: c.source, snippet: c.context });
      // Treatment recorded in the corpus by the ingestion/citation workers is a negative signal only when it says so.
      const recorded = (r.target.corpusTreatment ?? []).map((t) => ({ title: t.by ?? "Treatment recorded in the corpus", snippet: `${t.status}${t.note ? `: ${t.note}` : ""}` }));
      return classifyTreatment({ citing: [...recorded, ...r.citing.map(row)], citingCount: r.citing.length }, undefined, { basis: "corpus", phrases: INDIAN_NEGATIVE_TREATMENT_PHRASES });
    },

    async resolveCitation(citation) {
      return resolveIndianCitation(citation);
    },

    async verifyCitationsRemote(text) {
      // "Remote" for LeClaude India is the judgment corpus: citations some judgment in the corpus carries (found, not read here).
      return extractAnswerCitations(text).map((c) => c.citation).filter((c) => resolveIndianCitation(c).state === "resolved");
    },

    async translateQuery(input) {
      const text = `Language: ${input.language}\nQuestion: ${input.question}`;
      // The fast router role may be an external endpoint: a matter-bound question carries privacy "internal", which the router
      // enforces in code (constitution §16). When no eligible router exists, the internal fast role translates instead.
      try {
        const r = await infer({ role: "router", taskType: "route", privacy: input.matterId ? "internal" : "external", matterId: input.matterId ?? undefined, instructions: TRANSLATE_QUERY_INSTRUCTIONS, messages: [{ role: "user", content: [{ type: "text", text }] }], jsonSchema: { name: "search_terms", schema: strictJsonSchema(TRANSLATE_SCHEMA) }, maxOutputTokens: 200, cacheStablePrefix: true, signal: input.signal });
        const json = (r.json ?? JSON.parse(r.text || "{}")) as { query?: string };
        if (json.query?.trim()) return { query: json.query.trim(), model: "router" };
      } catch (e) {
        if ((e as Error).name === "AbortError") throw e;
      }
      const r = await generateJSON<{ query: string }>({ fast: true, taskType: "extract", privacy: "internal", matterId: input.matterId ?? undefined, instructions: TRANSLATE_QUERY_INSTRUCTIONS, input: text, schema: TRANSLATE_SCHEMA, name: "search_terms", maxOutputTokens: 200, cacheStablePrefix: true, signal: input.signal });
      return { query: (r.query ?? "").trim(), model: "fast" };
    },
  };
}
