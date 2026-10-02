import "server-only";
import { nanoid } from "nanoid";
import type { ResponseInput, ResponseInputItem } from "openai/resources/responses/responses";
import { db } from "@/lib/db";
import { runAgent, generateJSON, type AgentEvent } from "@/lib/ai/agent";
import { AIConfigError } from "@/lib/ai/config";
import type { ToolContext, ToolDef } from "@/lib/ai/tools";
import { fetchUrlTool } from "@/lib/ai/toolkit/web";
import { getOpinionTextTool, getCfrSectionTool, getFederalRegisterDocumentTool } from "@/lib/ai/toolkit/legal";
import { citingReferencesTool, mapCriminalSectionTool, readJudgment, readJudgmentTool, readSectionTool, readStatuteSection, resolveIndianCitation, searchJudgmentsTool, searchStatutesIndiaTool, visibleMatters } from "@/lib/ai/toolkit/india";
import { formatStatuteCitation } from "./india-citations";
import { isLawActId, LAW_DATASET, lawHref, lawSourceId, normSectionKey, normVariant, publisherLabel, statusLabel } from "@/modules/law/shared";
import { JURISDICTIONS } from "./jurisdictions";
import { getLibraryItemTool, getEdiscoveryDocumentTool } from "@/lib/ai/toolkit/internal";
import { LEGAL_STYLE_RULES, todayLine } from "@/lib/ai/prompts";
import { firmLabel } from "./firm";
import type { LibraryItem } from "@/lib/types/domain";
import { formatBluebook } from "./normalize";
import { ASK_SOURCE_INSTRUCTIONS, EXPAND_QUERY_INSTRUCTIONS, HEADNOTE_INSTRUCTIONS } from "./prompts";
import { extractCitations, type ExtractedCitation } from "./citations";
import { getCached, putCached } from "./engine/cache";
import { ALL_SOURCES, DEFAULT_SETTINGS, type CitationCheck, type ReadRef, type ReadResult, type SavedSearch, type SearchHit, type SearchRun, type SearchRunRequest, type SearchSettings, type SearchSource, type SourceError } from "./types";
import { currentUser } from "@/lib/current-user";

/**
 * The identity that owns research records written on the caller's behalf. One call site
 * so the auth worker's request-scoped principal replaces it in a single line
 * (constitution §21: no hardcoded production user).
 */
export function researchPrincipalId(): string {
  return currentUser().id;
}

export const savedSearches = () => db().collection<SavedSearch>("search_saved");
export const searchRuns = () => db().collection<SearchRun>("search_runs");

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export function sanitizeSettings(raw: Partial<SearchSettings> | undefined | null): SearchSettings {
  const r = raw ?? {};
  const sources = Array.isArray(r.sources) ? r.sources.filter((s): s is SearchSource => (ALL_SOURCES as string[]).includes(s)) : DEFAULT_SETTINGS.sources;
  return {
    sources: sources.length ? Array.from(new Set(sources)) : DEFAULT_SETTINGS.sources,
    jurisdiction: typeof r.jurisdiction === "string" && r.jurisdiction ? r.jurisdiction : DEFAULT_SETTINGS.jurisdiction,
    courts: typeof r.courts === "string" ? r.courts.trim().slice(0, 200) : "",
    datePreset: (["any", "1y", "5y", "10y", "custom"] as const).includes(r.datePreset as never) ? (r.datePreset as SearchSettings["datePreset"]) : "any",
    dateFrom: typeof r.dateFrom === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.dateFrom) ? r.dateFrom : undefined,
    dateTo: typeof r.dateTo === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.dateTo) ? r.dateTo : undefined,
    limit: Math.min(50, Math.max(5, Number(r.limit) || DEFAULT_SETTINGS.limit)),
    order: r.order === "date" ? "date" : "score",
    matterId: typeof r.matterId === "string" && r.matterId ? r.matterId : null,
    fast: Boolean(r.fast),
    ...(typeof r.answerLanguage === "string" && /^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/.test(r.answerLanguage) ? { answerLanguage: r.answerLanguage } : {}),
    ...(isIsoDay(r.offenceDate) ? { offenceDate: r.offenceDate } : {}),
    ...(isIsoDay(r.proceedingDate) ? { proceedingDate: r.proceedingDate } : {}),
    ...(Number.isFinite(Number(r.benchMin)) && Number(r.benchMin) >= 2 ? { benchMin: Math.min(15, Math.floor(Number(r.benchMin))) } : {}),
    ...(typeof r.judge === "string" && r.judge.trim() ? { judge: r.judge.trim().slice(0, 80) } : {}),
    ...(typeof r.disposal === "string" && r.disposal.trim() ? { disposal: r.disposal.trim().slice(0, 40) } : {}),
    ...(typeof r.section === "string" && r.section.trim() ? { section: r.section.trim().slice(0, 60) } : {}),
  };
}

function isIsoDay(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
}

// ---------------------------------------------------------------------------
// Saved searches & history
// ---------------------------------------------------------------------------

export function listSavedSearches(): SavedSearch[] {
  return savedSearches().list({ sortBy: (a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updatedAt.localeCompare(a.updatedAt) });
}

export function createSavedSearch(input: { name?: string; query: string; settings?: Partial<SearchSettings>; tags?: string[]; notes?: string; pinned?: boolean; id?: string }): SavedSearch {
  const now = new Date().toISOString();
  const settings = sanitizeSettings(input.settings);
  const s: SavedSearch = {
    id: input.id ?? `ss_${nanoid(10)}`,
    name: (input.name ?? "").trim() || input.query.trim().slice(0, 80),
    query: input.query.trim(),
    settings,
    ownerId: researchPrincipalId(),
    createdAt: now,
    updatedAt: now,
    runCount: 0,
    pinned: Boolean(input.pinned),
    tags: input.tags,
    notes: input.notes,
    matterId: settings.matterId ?? null,
  };
  savedSearches().put(s);
  return s;
}

export function updateSavedSearch(id: string, patch: Partial<Pick<SavedSearch, "name" | "query" | "tags" | "notes" | "pinned" | "lastRunAt" | "runCount">> & { settings?: Partial<SearchSettings> }): SavedSearch | null {
  return savedSearches().update(id, (cur) => ({
    ...cur,
    ...patch,
    settings: patch.settings ? sanitizeSettings({ ...cur.settings, ...patch.settings }) : cur.settings,
    matterId: patch.settings?.matterId !== undefined ? patch.settings.matterId : cur.matterId,
    updatedAt: new Date().toISOString(),
  }));
}

export function deleteSavedSearch(id: string) {
  return savedSearches().delete(id);
}

export function listRuns(limit = 40): SearchRun[] {
  return searchRuns().list({ sortBy: "createdAt", direction: "desc", limit });
}

export function getRun(id: string) {
  return searchRuns().get(id);
}

export function deleteRun(id: string) {
  return searchRuns().delete(id);
}

export function clearRuns() {
  const c = searchRuns();
  for (const r of c.all()) c.delete(r.id);
}

// ---------------------------------------------------------------------------
// Provider helpers
// ---------------------------------------------------------------------------

function toolCtx(signal?: AbortSignal): ToolContext {
  return { emit: () => {}, signal, state: {} };
}

/** Legacy retrieval outcome shape kept for history records and tests. */
export interface RetrievalOutcome {
  hits: Partial<Record<SearchSource, SearchHit[]>>;
  totals: Partial<Record<SearchSource, number>>;
  errors: SourceError[];
  durationMs: number;
}

/** Human-readable provider failure (network, rate limit, proxy refusal) shared by the engine, the reader and cite-check. */
export function providerMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|fetch failed|network|abort|timeout|ETIMEDOUT|ECONNRESET/i.test(msg)) return "Provider unreachable (network). Retry when online.";
  if (/429/.test(msg)) return "Provider rate limit reached. Retry in a minute or add an API token in Settings.";
  if (/403|401/.test(msg)) return "Provider refused the request (HTTP 403/401). Check outbound network/proxy access or the API token in Settings.";
  return msg.length > 160 ? msg.slice(0, 157) + "…" : msg;
}

export type SynthesisStatus = SearchRun["aiStatus"];

// ---------------------------------------------------------------------------
// Whole run
// ---------------------------------------------------------------------------

export function recordRun(input: { id: string; query: string; settings: SearchSettings; startedAt: number; outcome: RetrievalOutcome; synthesis: string; aiStatus: SynthesisStatus; savedSearchId?: string }): SearchRun {
  const counts: Partial<Record<SearchSource, number>> = {};
  const topHits: SearchHit[] = [];
  for (const s of ALL_SOURCES) {
    const list = input.outcome.hits[s];
    if (list) { counts[s] = list.length; topHits.push(...list.slice(0, 3)); }
  }
  const run: SearchRun = {
    id: input.id,
    query: input.query,
    settings: input.settings,
    createdAt: new Date(input.startedAt).toISOString(),
    durationMs: Date.now() - input.startedAt,
    counts,
    totals: input.outcome.totals,
    errors: input.outcome.errors.length ? input.outcome.errors : undefined,
    synthesis: input.synthesis ? input.synthesis.slice(0, 12_000) : undefined,
    topHits: topHits.slice(0, 12),
    ownerId: researchPrincipalId(),
    matterId: input.settings.matterId ?? null,
    savedSearchId: input.savedSearchId,
    aiStatus: input.aiStatus,
  };
  searchRuns().put(run);
  if (input.savedSearchId) updateSavedSearch(input.savedSearchId, { lastRunAt: run.createdAt, runCount: (savedSearches().get(input.savedSearchId)?.runCount ?? 0) + 1 });
  // keep history bounded
  const all = searchRuns().list({ sortBy: "createdAt", direction: "desc" });
  for (const old of all.slice(250)) searchRuns().delete(old.id);
  return run;
}

export interface ParsedRunRequest { query: string; settings: SearchSettings; runId: string; threadId: string | null; savedSearchId?: string }

export function parseRunRequest(body: unknown): ParsedRunRequest | { error: string } {
  const b = (body ?? {}) as Partial<SearchRunRequest> & { query?: string };
  const query = (typeof b.message === "string" ? b.message : typeof b.query === "string" ? b.query : "").trim();
  if (!query) return { error: "`message` (the research query) is required" };
  if (query.length > 4000) return { error: "Query is too long (max 4000 characters)" };
  return {
    query,
    settings: sanitizeSettings(b),
    runId: typeof b.runId === "string" && b.runId ? b.runId.replace(/[^\w.-]/g, "").slice(0, 40) || `run_${nanoid(10)}` : `run_${nanoid(10)}`,
    threadId: typeof b.threadId === "string" && b.threadId ? b.threadId.replace(/[^\w.-]/g, "").slice(0, 40) : null,
    savedSearchId: typeof b.savedSearchId === "string" ? b.savedSearchId : undefined,
  };
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

const READ_MAX = 160_000;

interface OpinionText { opinion_id: number; url?: string; text: string; length: number }
interface CfrText { cite: string; url: string; as_of: string; text: string }
interface FrText { title?: string; citation?: string; published?: string; url?: string; text: string }
interface UrlText { url: string; title?: string; contentType?: string; text: string }
interface EdocText { id: string; matterId: string; bates: string; batesEnd?: string; date: string; custodianName: string; from?: string; to?: string[]; cc?: string[]; type: string; subject: string; text: string; coding?: unknown; aiSummary?: string }

/** Full text for a read reference. External reads are cached for 24h (engine lanes, the reader sheet and re-runs share it). */
export async function readSource(ref: ReadRef, opts: { title?: string; signal?: AbortSignal } = {}): Promise<ReadResult> {
  const cached = getCached(ref);
  if (cached) return { kind: ref.kind, title: opts.title ?? cached.title ?? ref.kind, cite: cached.cite, url: cached.url, text: cached.text, length: cached.length, meta: { cached: true, fetchedAt: cached.fetchedAt } };
  const r = await readSourceUncached(ref, opts);
  putCached(ref, { title: r.title, cite: r.cite, url: r.url, text: r.text });
  return { ...r, meta: { ...(r.meta ?? {}), cached: false } };
}

async function readSourceUncached(ref: ReadRef, opts: { title?: string; signal?: AbortSignal } = {}): Promise<ReadResult> {
  const ctx = toolCtx(opts.signal);
  switch (ref.kind) {
    case "opinion": {
      const r = (await getOpinionTextTool.execute({ opinion_id: ref.id, max_chars: READ_MAX }, ctx)) as OpinionText;
      return { kind: "opinion", title: opts.title ?? `Opinion #${ref.id}`, url: r.url, text: r.text, length: r.length, meta: { opinionId: ref.id } };
    }
    case "cfr": {
      const r = (await getCfrSectionTool.execute({ title: ref.title, section: ref.section, max_chars: READ_MAX }, ctx)) as CfrText;
      return { kind: "cfr", title: opts.title ?? r.cite, cite: r.cite, url: r.url, text: r.text, length: r.text.length, meta: { asOf: r.as_of } };
    }
    case "fr": {
      const r = (await getFederalRegisterDocumentTool.execute({ document_number: ref.id, max_chars: READ_MAX }, ctx)) as FrText;
      return { kind: "fr", title: r.title ?? opts.title ?? ref.id, cite: r.citation, url: r.url, text: r.text, length: r.text.length, meta: { published: r.published, documentNumber: ref.id } };
    }
    case "url":
    case "statute": {
      const r = (await fetchUrlTool.execute({ url: ref.url, max_chars: READ_MAX }, ctx)) as UrlText;
      return { kind: ref.kind, title: opts.title ?? r.title ?? ref.url, url: r.url, text: r.text, length: r.text.length, meta: { contentType: r.contentType } };
    }
    case "judgment": {
      // Corpus judgments are public authority; a judgment linked to specific matters is readable only inside them.
      const { view, text } = readJudgment(ref.id, visibleMatters({ state: {} }));
      return { kind: "judgment", title: opts.title ?? view.title, cite: view.neutralCitation ?? view.reporterCitations[0], url: view.url, text, length: text.length, meta: { judgmentId: view.id, courtId: view.courtId, unresolvedCourt: view.unresolvedCourt, benchStrength: view.benchStrength, judges: view.judges, language: view.language, translations: view.translations, decided: view.decisionDate, source: view.source } };
    }
    case "section": {
      const r = readStatuteSection(ref.id);
      if (!r) throw new Error(`No India Code section ${ref.id} in the store`);
      const cite = formatStatuteCitation({ enactment: r.enactment, sections: r.section ? [r.section] : [] });
      return { kind: "section", title: opts.title ?? `${cite}${r.heading ? ` — ${r.heading}` : ""}`, cite, url: r.url, text: r.text, length: r.text.length, meta: { enactmentId: r.enactmentId, section: r.section, replacedBy: r.replacedBy, correspondsTo: r.correspondsTo, source: r.source } };
    }
    case "law": {
      // Public law; the route that calls the reader authorizes the principal. Exact section only (never the nearest).
      const { readProvisionText } = await import("@/modules/india/law/directory");
      const r = await readProvisionText(ref.actId, ref.section, ref.variant, READ_MAX);
      if (!r) throw new Error(`No section ${ref.section} in instrument ${ref.actId} in the statutes corpus`);
      const header = `${r.citation}${r.section.heading ? ` — ${r.section.heading}` : ""}\nStatus: ${statusLabel(r.instrument.status)}${r.section.in_force === false ? " (provision marked not in force)" : ""}\nOfficial text: ${r.section.source_url ?? r.instrument.source_url ?? "not recorded"} (${publisherLabel(r.instrument)})\nSource: ${LAW_DATASET.attribution}, dataset ${r.instrument.dataset_version}`;
      return { kind: "law", title: opts.title ?? `${r.citation}${r.section.heading ? ` — ${r.section.heading}` : ""}`, cite: r.citation, url: lawHref(r.instrument.id, r.section.section, r.section.variant), text: `${header}\n\n${r.text}`, length: r.section.chars, meta: { actId: r.instrument.id, section: r.section.section, variant: r.section.variant, status: r.instrument.status, officialUrl: r.section.source_url ?? r.instrument.source_url, datasetVersion: r.instrument.dataset_version, source: lawSourceId(r.instrument.id, r.section.section, r.section.variant) } };
    }
    case "library": {
      const item = (await getLibraryItemTool.execute({ id: ref.id, max_chars: READ_MAX }, ctx)) as LibraryItem & { content: string };
      return { kind: "library", title: item.name, text: item.content || item.description || "(This library item has no text content. Open it in the Office editor.)", url: item.officeDocId ? `/office/word/${item.officeDocId}` : item.url, length: (item.content ?? "").length, meta: { type: item.type, tags: item.tags, practiceArea: item.practiceArea, officeDocId: item.officeDocId, updatedAt: item.updatedAt } };
    }
    case "edoc": {
      const r = (await getEdiscoveryDocumentTool.execute({ id_or_bates: ref.id, max_chars: READ_MAX }, ctx)) as EdocText;
      const header = [`Bates: ${r.bates}${r.batesEnd ? `–${r.batesEnd}` : ""}`, `Date: ${r.date}`, `Custodian: ${r.custodianName}`, r.from ? `From: ${r.from}` : "", r.to?.length ? `To: ${r.to.join("; ")}` : "", r.cc?.length ? `Cc: ${r.cc.join("; ")}` : "", `Type: ${r.type}`].filter(Boolean).join("\n");
      return { kind: "edoc", title: `${r.bates} — ${r.subject}`, cite: r.bates, url: `/ediscovery?matter=${r.matterId}&doc=${r.id}`, text: `${header}\n\n${r.text}`, length: r.text.length, meta: { bates: r.bates, custodian: r.custodianName, coding: r.coding, aiSummary: r.aiSummary, matterId: r.matterId } };
    }
  }
}

export function parseReadRef(body: unknown): ReadRef | null {
  const b = (body ?? {}) as Record<string, unknown>;
  const kind = b.kind;
  const id = b.id;
  const url = typeof b.url === "string" ? b.url : undefined;
  switch (kind) {
    case "opinion": { const n = Number(id); return Number.isFinite(n) && n > 0 ? { kind: "opinion", id: n } : null; }
    case "cfr": { const t = Number(b.title); const s = typeof b.section === "string" ? b.section : ""; return Number.isFinite(t) && s ? { kind: "cfr", title: t, section: s } : null; }
    case "fr": return typeof id === "string" && id ? { kind: "fr", id } : null;
    case "url": return url && /^https?:\/\//i.test(url) ? { kind: "url", url } : null;
    case "statute": return url && /^https?:\/\//i.test(url) ? { kind: "statute", url, id: typeof id === "string" ? id : undefined } : null;
    case "library": return typeof id === "string" && id ? { kind: "library", id } : null;
    case "edoc": return typeof id === "string" && id ? { kind: "edoc", id } : null;
    case "judgment": return typeof id === "string" && id ? { kind: "judgment", id } : null;
    case "section": return typeof id === "string" && id ? { kind: "section", id } : null;
    case "law": {
      const actId = typeof b.actId === "string" && isLawActId(b.actId) ? b.actId : null;
      const section = normSectionKey(b.section);
      return actId && section ? { kind: "law", actId, section, variant: normVariant(b.variant) } : null;
    }
    default: return null;
  }
}

// ---------------------------------------------------------------------------
// Headnote summary, ask-about-source, query expansion, citation check
// ---------------------------------------------------------------------------

export interface Headnotes { syllabus: string; headnotes: string[]; holding: string; disposition: string; keyQuotes: { quote: string; locator: string }[] }

export async function summarizeSource(input: { title: string; cite?: string; text: string; signal?: AbortSignal }): Promise<Headnotes> {
  return generateJSON<Headnotes>({
    fast: true,
    instructions: HEADNOTE_INSTRUCTIONS,
    input: `SOURCE: ${input.title}${input.cite ? ` (${input.cite})` : ""}\n\n${input.text.slice(0, 90_000)}`,
    name: "headnotes",
    maxOutputTokens: 1400,
    signal: input.signal,
    schema: {
      type: "object",
      properties: {
        syllabus: { type: "string" },
        headnotes: { type: "array", items: { type: "string" } },
        holding: { type: "string" },
        disposition: { type: "string" },
        keyQuotes: { type: "array", items: { type: "object", properties: { quote: { type: "string" }, locator: { type: "string" } }, required: ["quote", "locator"] } },
      },
      required: ["syllabus", "headnotes", "holding", "disposition", "keyQuotes"],
    },
  });
}

export interface AskSourceBody { message: string; history?: { role: "user" | "assistant"; content: string }[]; previousResponseId?: string | null; source: { title: string; cite?: string; url?: string; kind?: string }; text: string }

export async function askAboutSource(body: AskSourceBody, send: (e: AgentEvent) => void, signal?: AbortSignal) {
  const instructions = [
    `You are the research agent for ${firmLabel()}. ${todayLine()}`,
    ASK_SOURCE_INSTRUCTIONS,
    LEGAL_STYLE_RULES,
    `SOURCE: ${body.source.title}${body.source.cite ? ` — ${body.source.cite}` : ""}${body.source.url ? ` — ${body.source.url}` : ""}\n"""\n${body.text.slice(0, 70_000)}\n"""`,
  ].join("\n\n");
  const input: ResponseInput = [];
  if (!body.previousResponseId) for (const h of (body.history ?? []).slice(-10)) input.push({ role: h.role, content: h.content.slice(0, 8000) } as ResponseInputItem);
  input.push({ role: "user", content: body.message } as ResponseInputItem);
  const tools = [searchJudgmentsTool, readJudgmentTool, citingReferencesTool, searchStatutesIndiaTool, readSectionTool, mapCriminalSectionTool, fetchUrlTool] as unknown as ToolDef<never, unknown>[];
  try {
    await runAgent({ instructions, input, tools, previousResponseId: body.previousResponseId ?? null, maxSteps: 6, verbosity: "low", signal, metadata: { app: "leclaude", surface: "search-ask" }, onEvent: send });
  } catch (e) {
    if (e instanceof AIConfigError) { send({ type: "error", message: e.message, code: "no_api_key" }); return; }
    throw e;
  }
}

export interface ExpandedQuery { query: string; rationale: string }

export async function expandQuery(query: string, jurisdictionLabel: string, signal?: AbortSignal): Promise<ExpandedQuery[]> {
  const r = await generateJSON<{ queries: ExpandedQuery[] }>({
    fast: true,
    instructions: EXPAND_QUERY_INSTRUCTIONS,
    input: `Jurisdiction: ${jurisdictionLabel}\nQuery: ${query}`,
    name: "expanded_queries",
    maxOutputTokens: 500,
    signal,
    schema: { type: "object", properties: { queries: { type: "array", items: { type: "object", properties: { query: { type: "string" }, rationale: { type: "string" } }, required: ["query", "rationale"] } } }, required: ["queries"] },
  });
  return (r.queries ?? []).slice(0, 3);
}

export interface CiteCheckResult {
  extracted: ExtractedCitation[];
  checks: CitationCheck[];
  providerError?: string;
  summary: { total: number; resolved: number; unresolved: number; unchecked: number };
}

/**
 * Citation check (LeClaude India): extract Indian neutral and reporter citations and resolve each against the judgment
 * corpus without substitution (one match resolves; several are ambiguous; none stays unresolved). No network call.
 */
export async function checkCitations(text: string, signal?: AbortSignal): Promise<CiteCheckResult> {
  void signal;
  const extracted = extractCitations(text);
  let checks: CitationCheck[] = [];
  let providerError: string | undefined;
  try {
    checks = extracted.filter((c) => c.kind === "case").map((c) => {
      const r = resolveIndianCitation(c.citation);
      if (r.state === "resolved") return { citation: c.citation, resolved: true, status: 200, matches: [{ case_name: r.title }] };
      if (r.state === "ambiguous") return { citation: c.citation, resolved: false, status: 300, error: r.reason, matches: r.candidates.map((x) => ({ case_name: x.title })) };
      return { citation: c.citation, resolved: false, status: 404, error: r.reason };
    });
  } catch (e) {
    providerError = providerMessage(e);
  }
  const resolved = checks.filter((c) => c.resolved).length;
  const unresolved = checks.filter((c) => !c.resolved).length;
  const caseCount = extracted.filter((c) => c.kind === "case").length;
  return { extracted, checks, providerError, summary: { total: extracted.length, resolved, unresolved, unchecked: extracted.length - (checks.length ? Math.min(checks.length, caseCount) : 0) } };
}

// ---------------------------------------------------------------------------
// Save to library
// ---------------------------------------------------------------------------

export const SAVED_RESEARCH_FOLDER_ID = "lib_folder_saved_research";

export function saveHitToLibrary(hit: SearchHit, opts: { matterId?: string | null; note?: string } = {}): LibraryItem {
  const d = db();
  const now = new Date().toISOString();
  if (!d.library.get(SAVED_RESEARCH_FOLDER_ID)) {
    d.library.put({ id: SAVED_RESEARCH_FOLDER_ID, parentId: null, name: "Saved research", type: "folder", description: "Authorities saved from the Search agent", createdAt: now, updatedAt: now, ownerId: researchPrincipalId(), sharedWith: ["firm"], tags: ["research"] });
  }
  const cite = formatBluebook(hit);
  const existing = d.library.findOne((l) => l.parentId === SAVED_RESEARCH_FOLDER_ID && l.name === cite);
  if (existing) return existing;
  const isExternal = Boolean(hit.url && /^https?:\/\//.test(hit.url));
  const item: LibraryItem = {
    id: `lib_${nanoid(10)}`,
    parentId: SAVED_RESEARCH_FOLDER_ID,
    name: cite,
    type: isExternal ? "link" : "note",
    matterId: opts.matterId ?? undefined,
    description: hit.snippet?.slice(0, 300),
    url: isExternal ? hit.url : undefined,
    content: [cite, hit.subtitle, hit.snippet, opts.note ? `Note: ${opts.note}` : ""].filter(Boolean).join("\n\n"),
    tags: ["research", hit.source, hit.authority && hit.authority !== "n/a" ? hit.authority : ""].filter(Boolean),
    ownerId: researchPrincipalId(),
    sharedWith: ["firm"],
    createdAt: now,
    updatedAt: now,
    status: "approved",
  };
  d.library.put(item);
  return item;
}

/** Forum keys exposed for the sync test and the UI. */
export function courtGroupKeys() {
  return JURISDICTIONS.map((j) => j.key);
}
