import "server-only";
import type { ResponseInput } from "openai/resources/responses/responses";
import { generateJSON, generateText, runAgent, strictJsonSchema, type AgentEvent } from "@/lib/ai/agent";
import { infer } from "@/lib/ai/runtime";
import { aiConfig } from "@/lib/ai/config";
import type { TokenUsage } from "@/lib/ai/events";
import type { ToolContext, ToolDef } from "@/lib/ai/tools";
import { webSearchTool } from "@/lib/ai/toolkit/web";
import type { CitationResolution } from "@/lib/ai/toolkit/legal";
import { citingReferences, corpusCitingReferences, ikSource, isCorpusJudgmentKey, indianKanoonClient, isIndiaSourceDoc, judgmentRow, resolveIndianCitation, searchJudgments, searchStatuteSections, statuteRow, visibleMatters, type IndianCitationResolution } from "@/lib/ai/toolkit/india";
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
import { normalizeIndiaSection, normalizeJudgment, normalizeLawSection, normalizeToolResult } from "../normalize";
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
import { courtById } from "@/lib/india/courts";
import { chunksToText, readJudgmentText, searchJudgmentText, type TextSearchHit } from "@/modules/india/corpus/text";
import { textKey } from "@/lib/ai/toolkit/india-judgment-text";
import { readOfficialDocument, searchOfficial } from "@/modules/official/service";
import { parseSourceRef, SOURCE_REF_PREFIX, type SourceSearchHit } from "@/modules/official/types";
import { aiBudget } from "@/lib/ai/config";
import type { BudgetProfileId, ResolvedBudget } from "@/lib/ai/context-budget";

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
  /** Indian law corpus coverage block for prompts (cached; "" when unknown). Absent in minimal fakes. */
  coverage?(signal?: AbortSignal): Promise<string>;
  /**
   * Context budget for a profile, resolved against the model the router picks for it (evidence sizes, read caps,
   * reader defaults). Absent in minimal fakes: the engine then keeps its fixed bounds.
   */
  budget?(profile: BudgetProfileId): ResolvedBudget;
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

/** Official-sources facade errors that mean "no official corpus on this deployment" (empty result, not a lane failure). */
export function isOfficialUnavailable(e: unknown): boolean {
  const err = e as { code?: unknown; name?: unknown } | null;
  return err?.code === "official_not_configured" || err?.code === "official_not_implemented" || err?.name === "OfficialNotConfiguredError" || err?.name === "OfficialNotImplementedError";
}

/** One official-sources hit as a research hit: readable through its stable src:// reference (never a guessed id). */
export function officialHit(h: SourceSearchHit): SearchHit {
  const pages = h.pageStart != null ? (h.pageEnd != null && h.pageEnd !== h.pageStart ? `pp. ${h.pageStart}–${h.pageEnd}` : `p. ${h.pageStart}`) : "";
  return {
    id: `official:${h.documentId}${h.pageStart != null ? `#p${h.pageStart}` : `#c${h.chunkIndex}`}`,
    source: "regulations",
    title: h.title,
    subtitle: [h.publisher, h.kind.replace(/_/g, " "), pages, h.extraction === "ocr_model" ? "OCR text — check against the PDF" : ""].filter(Boolean).join(" · "),
    court: h.publisher,
    date: h.docDate ?? undefined,
    snippet: h.text.slice(0, 600),
    url: h.url,
    score: h.score,
    readRef: { kind: "url", url: h.ref },
  };
}

/** Official-document search for a research lane (empty, not an error, when the corpus is not on this deployment). */
export async function officialHits(query: string, o: { from?: string; to?: string; limit: number }): Promise<SearchHit[]> {
  if (!query.trim()) return [];
  try {
    const r = await searchOfficial({ q: query, from: o.from, to: o.to, limit: Math.min(o.limit, 12) });
    return r.hits.map(officialHit);
  } catch (e) {
    if (isOfficialUnavailable(e)) return [];
    throw e;
  }
}

/**
 * Judgment full-text hits (best passage per judgment, with its page), restricted to the courts in scope; judgments
 * already returned by another provider (same neutral citation or record) are skipped. Every hit is readable.
 */
export async function corpusTextHits(query: string, o: { courts: string[]; yearFrom?: number; yearTo?: number; limit: number; existing: SearchHit[]; nctx: { jurisdiction: SearchSettings["jurisdiction"]; courts: SearchSettings["courts"] } }): Promise<SearchHit[]> {
  if (!remoteStore() || !query.trim()) return [];
  const { hits } = await searchJudgmentText(query, { courts: o.courts, yearFrom: o.yearFrom, yearTo: o.yearTo, limit: o.limit });
  const norm = (v?: string | null) => (v ?? "").replace(/\s+/g, " ").trim().toUpperCase();
  const seen = new Set<string>();
  for (const h of o.existing) {
    for (const c of h.citations ?? (h.cite ? [h.cite] : [])) seen.add(norm(c));
    if (h.india?.judgmentId) seen.add(`id:${h.india.judgmentId}`);
  }
  const out: SearchHit[] = [];
  for (const h of hits) {
    const keys = [h.neutralCitation ? norm(h.neutralCitation) : "", h.judgmentId ? `id:${h.judgmentId}` : ""].filter(Boolean);
    if (keys.some((k) => seen.has(k))) continue;
    keys.forEach((k) => seen.add(k));
    out.push(textHit(h, o.nctx));
  }
  return out;
}

export function textHit(h: TextSearchHit, nctx: { jurisdiction: SearchSettings["jurisdiction"]; courts: SearchSettings["courts"] }): SearchHit {
  // A High Court text keyed by CNR still carries its record's own neutral citation when the index has one.
  const neutral = h.neutralCitation ?? h.recordNeutralCitation ?? null;
  const citations = [neutral, h.reporterCitation].filter((x): x is string => Boolean(x));
  const id = textKey(h);
  return {
    id: `corpus:${id}`,
    source: "caselaw",
    title: h.title || h.citation,
    subtitle: [h.court, h.caseNumber, h.neutralCitation ? "" : h.citation, h.pageStart != null ? `passage at p. ${h.pageStart}` : "", "full text"].filter(Boolean).join(" · "),
    // A CNR is identity, not a citation: CNR-keyed text formats as "Title (CNR …, High Court of …, decided on …)".
    cite: neutral ?? h.reporterCitation ?? undefined,
    citations,
    court: h.court,
    courtId: h.courtId,
    date: h.decisionDate ?? undefined,
    snippet: h.passage.slice(0, 600),
    url: h.judgmentId ? `${caseHref(h.judgmentId)}${h.pageStart != null ? `#p${h.pageStart}` : ""}` : undefined,
    judge: h.judges.join(", ") || undefined,
    docketNumber: h.caseNumber ?? undefined,
    score: h.rank,
    authority: classifyAuthority(h.courtId, nctx.jurisdiction, nctx.courts, h.decisionDate ?? undefined),
    india: { judgmentId: id, courtId: h.courtId, judges: h.judges, neutralCitation: neutral ?? undefined, reporterCitations: h.reporterCitation ? [h.reporterCitation] : undefined, caseNumber: !neutral && h.cnr ? `CNR ${h.cnr}` : h.caseNumber ?? undefined, provider: "corpus" },
    readRef: { kind: "url", url: `${CORPUS_TEXT_PREFIX}${id}` },
  };
}

/** "The Bharatiya Nyaya Sanhita, 2023" and "Bharatiya Nyaya Sanhita, 2023" → one key (the year is kept: 1956 ≠ 2013). */
export function actTitleKey(title: string): string {
  return title.toLowerCase().replace(/^\s*the\s+/, "").replace(/[^a-z0-9]+/g, "");
}

/**
 * Sections from the statutes corpus in Postgres (Open India Law parse of India Code and regulator publications) for
 * the statutes lane. Each hit is readable in full (readRef kind "law", exact section) and links to /law/<actId>?s=…;
 * its status (in force / repealed) is carried, and a section another provider already returned (same Act title and
 * section number) is not repeated. Nothing when no database is configured.
 */
/**
 * State legislation in scope for the selected courts: the territories of the High Courts (and subordinate forums) in
 * scope. Supreme Court only → no State Acts (central law and regulators still apply).
 */
export function statuteStates(courtIds: string[]): string[] {
  const out = new Set<string>();
  for (const id of courtIds) for (const t of courtById(id)?.territory ?? []) out.add(t);
  return [...out];
}

export async function lawStatuteHits(query: string, o: { limit: number; existing: SearchHit[]; scopeStates?: string[] }): Promise<SearchHit[]> {
  if (!remoteStore() || !query.trim()) return [];
  const { searchProvisions } = await import("@/modules/india/law/search");
  const { hits } = await searchProvisions({ q: query, limit: o.limit, excludeReports: true, scopeStates: o.scopeStates });
  const seen = new Set<string>();
  for (const h of o.existing) if (h.india?.enactment && h.india.section) seen.add(`${actTitleKey(h.india.enactment)}|${h.india.section.toUpperCase()}`);
  const out: SearchHit[] = [];
  for (const h of hits) {
    const hit = normalizeLawSection(h);
    const key = hit.india?.enactment && hit.india.section ? `${actTitleKey(hit.india.enactment)}|${hit.india.section.toUpperCase()}` : null;
    // Variants (a second provision printed with the same number) are distinct sections and are both kept.
    if (key && seen.has(key)) continue;
    out.push(hit);
  }
  return out;
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
            // Full-text passages and metadata records are searched in parallel; the text search has its own budget so a
            // slow text search never costs the lane its other results. A record already found with text is not repeated.
            const yf = year(range.from), yt = year(range.to);
            const [textHits, metaHits] = await Promise.all([
              withTimeout(corpusTextHits(query, { courts, yearFrom: yf, yearTo: yt, limit: Math.min(limit, 8), existing: hits, nctx }), 15_000, signal)
                .catch((e) => { if ((e as Error).name === "AbortError") throw e; console.warn("[research] judgment text search failed:", (e as Error).message); return [] as SearchHit[]; }),
              corpusCaselawHits(query, { courts, yearFrom: yf, yearTo: yt, limit: Math.min(limit, 8), existing: hits, nctx })
                .catch((e) => { if ((e as Error).name === "AbortError") throw e; console.warn("[research] judgment corpus search failed:", (e as Error).message); return [] as SearchHit[]; }),
            ]);
            hits.push(...textHits);
            const withText = new Set(textHits.flatMap((h) => [h.india?.judgmentId, h.cite].filter((x): x is string => Boolean(x)).map((x) => x.toUpperCase())));
            hits.push(...metaHits.filter((h) => ![h.india?.judgmentId, h.cite].some((x) => x && withText.has(x.toUpperCase()))));
            try { hits.push(...(await indianKanoonHits(query, courts, settings, signal))); } catch (e) { if ((e as Error).name === "AbortError") throw e; console.warn("[research] Indian Kanoon search failed:", (e as Error).message); }
            return { hits, total: hits.length };
          }
          case "statutes": {
            const rows = await searchStatuteSections(query, { limit });
            const hits = rows.map((r) => normalizeIndiaSection(statuteRow(r)));
            try { hits.push(...(await lawStatuteHits(query, { limit: Math.min(limit, 8), existing: hits, scopeStates: statuteStates(resolveCourts(settings.jurisdiction, settings.courts).split(" ").filter(Boolean)) }))); } catch (e) { if ((e as Error).name === "AbortError") throw e; console.warn("[research] statutes corpus search failed:", (e as Error).message); }
            return { hits, total: hits.length };
          }
          case "library": return normalizeToolResult(source, await Promise.resolve(searchLibraryTool.execute({ query, matter_id: settings.matterId ?? undefined, limit }, ctx)), nctx);
          case "ediscovery":
            if (!FEATURES.ediscovery) return matterDocumentHits(query, settings.matterId, limit);
            return normalizeToolResult(source, await Promise.resolve(searchEdiscoveryTool.execute({ query, matter_id: settings.matterId ?? undefined, date_after: range.from, date_before: range.to, limit }, ctx)), nctx);
          // LeClaude India: "regulations" is the official-sources corpus (tribunal and regulator orders, circulars,
          // notifications, gazette, cause lists, Parliament papers) — searched by the lanes' search_official_sources tool.
          case "regulations": { const hits = await officialHits(query, { from: range.from, to: range.to, limit }); return { hits, total: hits.length }; }
          // US providers are not offered in LeClaude India (the US toolkit still compiles for the US fork).
          case "federal_register": case "dockets": case "web": return { hits: [], total: 0 };
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
        if (!r || !r.chunks.length) throw new Error(`No full text for judgment ${id} in the judgment text corpus (unknown id or metadata-only record); it is not substituted with another judgment.`);
        return { text: chunksToText(r.chunks), title: r.title ? `${r.title}, ${r.citation}` : r.citation, cite: r.neutralCitation ?? r.citation, url: r.judgmentId ? caseHref(r.judgmentId) : undefined, cached: true };
      }
      if (ref.kind === "url" && ref.url.startsWith(IK_READ_PREFIX)) {
        const ik = indianKanoonClient();
        if (!ik) throw new Error("Indian Kanoon is not configured (the connector is not ready).");
        const tid = Math.floor(Number(ref.url.slice(IK_READ_PREFIX.length)));
        const data = await withTimeout(ik.doc(tid, { signal: opts.signal }), 30_000, opts.signal);
        return { text: htmlToText(data.doc ?? "", { maxChars: 1_000_000 }).text, title: htmlToText(data.title ?? "").text || opts.title, url: ik.webUrl(tid), cached: false };
      }
      if (ref.kind === "url" && ref.url.startsWith(SOURCE_REF_PREFIX)) {
        // Official document: the stable src:// reference resolves server-side; an unknown id is an error, never another document.
        const parsed = parseSourceRef(ref.url);
        if (!parsed) throw new Error(`Not an official source reference: ${ref.url}`);
        let r: Awaited<ReturnType<typeof readOfficialDocument>>;
        try {
          r = await withTimeout(readOfficialDocument(parsed.documentId, { page: parsed.page ?? undefined, fromChunk: parsed.page == null ? parsed.chunk ?? undefined : undefined, maxChars: 400_000 }), 30_000, opts.signal);
        } catch (e) {
          if (isOfficialUnavailable(e)) throw new Error("The official-sources corpus is not available on this deployment.");
          throw e;
        }
        if (!r || !r.chunks.length) throw new Error(`No text for official document ${parsed.documentId}; it is not substituted with another document.`);
        let page: number | null = null;
        const parts: string[] = [];
        for (const c of r.chunks) {
          if (c.pageStart != null && c.pageStart !== page) { parts.push(`[p. ${c.pageStart}]`); page = c.pageStart; }
          parts.push(c.text);
        }
        const d = r.document;
        const ocr = d.extraction === "ocr_model" || (d.ocrPages?.length ?? 0) > 0;
        return { text: `${ocr ? "[OCR text: check quotations against the official PDF before filing]\n\n" : ""}${parts.join("\n\n")}`, title: d.title, cite: `${d.title}${d.docDate ? `, dated ${d.docDate}` : ""}`, url: d.url, cached: true };
      }
      if (ref.kind === "url" && ref.url.startsWith(INTEL_READ_PREFIX)) {
        const id = ref.url.slice(INTEL_READ_PREFIX.length);
        const doc = intelDocuments().get(id);
        const text = getDocumentText(id);
        if (!doc || text == null) throw new Error(`Intelligence record ${id} not found`);
        return { text, title: doc.title, cite: doc.citation ?? doc.docketNumber, url: doc.url, cached: true };
      }
      const r = await withTimeout(readSource(ref, opts), 30_000, opts.signal);
      return { text: r.text, title: r.title, cite: r.cite, url: r.url, cached: Boolean(r.meta?.cached) || ref.kind === "judgment" || ref.kind === "section" || ref.kind === "law" };
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
        budget: POLICY.laneAgent.budget,
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
        budget: POLICY.synthesize.budget,
        maxSteps: 1,
        verbosity: "medium",
        signal: input.signal,
        metadata: { app: "leclaude", surface: "research-synthesis" },
        onEvent: (e) => { if (e.type === "text.delta") input.onDelta(e.delta); },
      });
      return { text: res.text, usage: res.usage };
    },

    verify(input) {
      // The verifier's reach (sources, characters per source, answer length, output) follows the `verify` budget of the
      // fast model; what it could not check is reported (coverage / partial), never counted as verified.
      return verifyClaims({ answer: input.answer, sources: input.sources, maxClaims: 25, signal: input.signal, fast: POLICY.verify.fast, taskType: POLICY.verify.taskType, cacheStablePrefix: POLICY.verify.cacheStablePrefix, budget: aiBudget(POLICY.verify.budget ?? "verify", { fast: POLICY.verify.fast }) });
    },

    async correct(input) {
      const r = await generateText({ fast: POLICY.correct.fast, taskType: POLICY.correct.taskType, reasoningEffort: POLICY.correct.reasoningEffort, cacheStablePrefix: POLICY.correct.cacheStablePrefix, instructions: input.instructions, input: input.input, budget: POLICY.correct.budget, signal: input.signal });
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
        maxOutputTokens: POLICY.refine.maxOutputTokens,
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
        maxOutputTokens: POLICY.followUps.maxOutputTokens,
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
      // Corpus judgments (sc:/hc: ids, neutral citations, CNR@date): later judgments whose text mentions the citation.
      if (isCorpusJudgmentKey(input.judgmentId) && remoteStore()) {
        const c = await withTimeout(corpusCitingReferences(input.judgmentId, { limit: 10 }), 20_000, input.signal);
        const rows = c.mentions.map((m) => ({ title: `${m.title ?? "Untitled"}, ${m.citation}${m.page != null ? `, p. ${m.page}` : ""} — mentions (text match)`, date: m.decisionDate ?? undefined, url: m.judgmentId ? caseHref(m.judgmentId) : undefined, snippet: m.passage }));
        return classifyTreatment({ citing: rows, citingCount: rows.length }, undefined, { basis: "corpus", phrases: INDIAN_NEGATIVE_TREATMENT_PHRASES });
      }
      const r = await citingReferences(input.judgmentId, visibleMatters({ state: {} }), { limit: 10 });
      const row = (c: (typeof r.citing)[number]) => ({ title: c.title, date: c.decided, url: c.source, snippet: c.context });
      // Treatment recorded in the corpus by the ingestion/citation workers is a negative signal only when it says so.
      const recorded = (r.target.corpusTreatment ?? []).map((t) => ({ title: t.by ?? "Treatment recorded in the corpus", snippet: `${t.status}${t.note ? `: ${t.note}` : ""}` }));
      return classifyTreatment({ citing: [...recorded, ...r.citing.map(row)], citingCount: r.citing.length }, undefined, { basis: "corpus", phrases: INDIAN_NEGATIVE_TREATMENT_PHRASES });
    },

    async resolveCitation(citation) {
      return resolveIndianCitation(citation);
    },

    async verifyCitationsRemote(text, signal) {
      // "Remote" for LeClaude India is the judgment corpus: citations some judgment in the local store or the Postgres
      // index carries (found, not read here — they stay "requires review", never "resolved").
      const cites = extractAnswerCitations(text).map((c) => c.citation);
      const local = cites.filter((c) => resolveIndianCitation(c).state === "resolved");
      const rest = cites.filter((c) => !local.includes(c));
      if (!rest.length || !remoteStore()) return local;
      const { corpusCitationsKnown } = await import("@/modules/india/corpus/text");
      const known = await withTimeout(corpusCitationsKnown(rest), 10_000, signal).catch((e) => { if ((e as Error).name === "AbortError") throw e; return new Set<string>(); });
      return [...local, ...rest.filter((c) => known.has(c))];
    },

    budget(profile) {
      return aiBudget(profile);
    },

    async coverage() {
      const { coveragePromptBlock } = await import("@/modules/india/corpus/coverage");
      return coveragePromptBlock({ waitMs: 2_500 });
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
