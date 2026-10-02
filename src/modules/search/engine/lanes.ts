import "server-only";
import { defineTool, type ToolDef } from "@/lib/ai/tools";
import type { AgentEvent } from "@/lib/ai/agent";
import { AIConfigError } from "@/lib/ai/config";
import { classifyFailure, isAbortError, type FailureKind } from "@/lib/ai/events";
import { isIndianLegalFetchHost, mapCriminalSectionTool } from "@/lib/ai/toolkit/india";
import { matterContextTool } from "@/lib/ai/toolkit/internal";
import { forumContextLine } from "@/modules/courts/context";
import type { IndianCaseInfo } from "@/modules/matters/india";

import { formatCaseCitation } from "@/lib/india/citation-style";
import type { Matter } from "@/lib/types/domain";
import { LEGAL_STYLE_RULES, todayLine } from "@/lib/ai/prompts";
import { firmLabel } from "../firm";
import { formatStatuteCitation } from "../india-citations";
import { bindingCourtIds, jurisdictionByKey } from "../jurisdictions";
import { formatBluebook, normalizeWebCitation } from "../normalize";
import { providerMessage } from "../service";
import { SOURCE_LABEL, type ReadRef, type SearchHit, type SearchSettings, type SearchSource } from "../types";
import { compareAuthorities } from "./authorities";
import type { ReadRegistry } from "./cache";
import type { EngineDeps, ResearchPlan } from "./deps";
import { focusTerms, splitParagraphs } from "./paragraphs";
import { priorQueries } from "./planner";
import { laneInstructions } from "./prompts";
import { abortError, settleWithin, withRetry, type LaneBoard, type MetricsRecorder, type RunPolicy } from "./runtime";
import { mergeSources, sourceFromHit, sourceKey } from "./sources";
import type { LaneStatus, ResearchEventInput, ResearchLane, ResearchSource } from "./types";

/** " Forum: …" for a matter carrying Indian case particulars (empty otherwise). */
const matterForumSuffix = (m: object): string => { const line = forumContextLine((m as { india?: IndianCaseInfo }).india); return line ? ` ${line}` : ""; };

export interface LaneContext {
  question: string;
  settings: SearchSettings;
  matter: Matter | null;
  deps: EngineDeps;
  /** Typed event emitter (runId/at/seq are stamped by the run). */
  emit: (e: ResearchEventInput) => void;
  /** Lane-scoped signal: fires on run cancellation or on this lane's timeout. Every provider/model call receives it. */
  signal?: AbortSignal;
  /** The run's own signal, to tell a cancellation from a lane timeout when classifying the outcome. */
  runSignal?: AbortSignal;
  /** True once this lane's timeout fired. */
  timedOut?: () => boolean;
  /** Shared full-text store (source id → text) for the run. */
  texts: Map<string, string>;
  /** Shared in-flight read registry so two lanes never fetch the same source twice. */
  reads: ReadRegistry;
  /** Sources already known to the run/thread (for dedupe awareness). */
  known: ResearchSource[];
  policy: RunPolicy;
  metrics?: MetricsRecorder;
  /** Results of the lanes this lane hard-depends on (`dependsOn`). */
  priors: LaneResult[];
  /** Soft-dependency board: lanes publish their first-wave sources here; `after` lanes wait on it (bounded). */
  board?: LaneBoard<ResearchSource[]>;
  /** The fast-model plan, resolving while the first retrieval wave runs (null when unavailable). */
  plan?: Promise<ResearchPlan | null>;
  /** Indian law corpus coverage block (courts/years with full text vs metadata, statutes breadth); user turn only. */
  coverage?: string;
}

export interface LaneFailure {
  name: string;
  error: string;
  failure: FailureKind;
}

export interface LaneResult {
  laneId: string;
  status: LaneStatus;
  sources: ResearchSource[];
  read: number;
  note: string;
  agentRan: boolean;
  durationMs: number;
  /** Set when the lane ended in error/timeout, or when it completed with provider/tool failures inside it. */
  error?: string;
  failure?: FailureKind;
  /** Provider/tool failures that did not stop the lane (partial failures the UI lists). */
  failures: LaneFailure[];
}

const SEARCH_TOOL_FOR: Partial<Record<string, SearchSource>> = {
  search_judgments: "caselaw", search_statutes: "statutes", search_library: "library", search_ediscovery: "ediscovery",
  // LeClaude India: the "regulations" provider is the official-sources corpus (see deps.retrieve).
  search_official_sources: "regulations",
};

const SEARCH_TOOL_DESC: Record<string, string> = {
  search_judgments: "Search every judgment source at once: full-text passages with pages (Supreme Court; Karnataka, Andhra Pradesh and Telangana High Courts where loaded), the judgment metadata index (Supreme Court and High Courts), the local store and Indian Kanoon when configured. Keyword queries with Indian terms of art and section numbers work best; results respect this lane's courts and the run's date filters and carry court, bench strength, date, citations, binding/persuasive for the forum and `text`: \"full text\" (readable with read_source / read_judgment) or \"metadata only\" (no text: cite only per the snippet). Returns source ids for read_source, read_judgment and citing_references.",
  search_statutes: "Search the statutes: the full corpus of Central, State and UT Acts and regulator instruments (with in force / repealed status) and the curated India Code store (BNS/BNSS/BSA and the old IPC/CrPC/Evidence Act with successor links). Returns source ids usable with read_section and read_source.",
  search_library: "Search the firm's knowledge library: memos, opinions, pleadings, clause bank, templates.",
  search_ediscovery: "Search this matter's documents and deposition transcripts. Limited to the selected matter.",
  search_official_sources: "Search OFFICIAL publications as published: tribunal and regulator orders (NCLT, NCLAT, IBBI, SEBI incl. SAT orders, CCI, NGT), court orders and cause lists, CBIC / CBDT circulars and notifications, the e-Gazette, GST Council minutes and Parliament papers. Each result carries the publisher, date and page; read it with read_source (same id) before relying on it, and cite the publisher, document and page. Text marked OCR must be checked against the PDF before it is quoted in a filing. Returns nothing when the official corpus is not loaded.",
};

const CASE_TITLE_RE = /\s(?:v|vs|versus)\.?\s/i;

/** Deterministic snippet triage for reading without an agent: binding first, then term overlap, then provider rank. */
export function rankForReading(sources: ResearchSource[], terms: string[]): ResearchSource[] {
  const lower = terms.map((t) => t.toLowerCase());
  const score = (s: ResearchSource) => {
    const hay = `${s.title} ${s.snippet ?? ""}`.toLowerCase();
    const overlap = lower.reduce((a, t) => a + (hay.includes(t) ? 1 : 0), 0);
    // Binding first; within binding/persuasive a larger bench ranks higher (deterministic, from the corpus record).
    return (s.authority === "binding" ? 3 : s.authority === "persuasive" ? 1 : 0) + Math.min(2, ((s.hit.india?.benchStrength ?? 1) - 1) * 0.5) + overlap;
  };
  return sources.map((s, i) => ({ s, i, v: score(s) })).sort((a, b) => b.v - a.v || a.i - b.i).map((x) => x.s);
}

/** Settings for one lane's retrieval: judgment lanes are narrowed to their deterministic court filter (never by the model). */
export function laneSettings(lane: Pick<ResearchLane, "courtFilter">, settings: SearchSettings, source: SearchSource): SearchSettings {
  return source === "caselaw" && lane.courtFilter?.length ? { ...settings, courts: lane.courtFilter.join(" ") } : settings;
}

/** Run one lane: deterministic provider retrieval (parallel, retried on transient failures), a second targeted wave, then reading. */
export async function runLane(lane: ResearchLane, ctx: LaneContext, slot: { queuedMs?: number } = {}): Promise<LaneResult> {
  const t0 = Date.now();
  const { deps, emit, signal, policy } = ctx;
  let sources: ResearchSource[] = [];
  const found = new Map<string, ResearchSource>();
  let reads = 0;
  let agentRan = false;
  let note = "";
  let toolSeq = 0;
  const failures: LaneFailure[] = [];
  const nextToolId = () => `${lane.id}:t${++toolSeq}`;
  const retry = { retries: policy.retrievalRetries, baseMs: policy.retryBaseMs, maxMs: policy.retryMaxMs, signal };
  const ran = new Set<string>();

  const record = (incoming: ResearchSource[], announce = true) => {
    for (const s of incoming) {
      const prev = found.get(s.id);
      const merged = prev ? mergeSources([prev], [s])[0] : s;
      found.set(s.id, merged);
      if (announce) emit({ type: "source.found", laneId: lane.id, sourceId: merged.id, title: merged.title, cite: merged.cite, kind: merged.kind, source: merged });
    }
    sources = Array.from(found.values());
  };
  const readCount = () => sources.filter((s) => s.read).length;

  /** One retrieval wave: every (provider × query) pair in parallel. */
  const retrieveWave = (queries: string[]) => Promise.all(lane.sources.filter((s) => s !== "web").flatMap((source) => queries.filter((q) => !ran.has(`${source}\u0000${q}`)).map(async (q) => {
    ran.add(`${source}\u0000${q}`);
    const toolId = nextToolId();
    const name = `search_${source}`;
    const label = `Searching ${SOURCE_LABEL[source].toLowerCase()}: ${q}`;
    const started = Date.now();
    emit({ type: "tool.started", laneId: lane.id, toolId, name, label });
    try {
      const { hits } = await withRetry(() => deps.retrieve(source, q, laneSettings(lane, ctx.settings, source), signal), {
        ...retry,
        onRetry: ({ error, failure, delayMs }) => emit({ type: "tool.failed", laneId: lane.id, toolId, name, label, error: `${providerMessage(error)} Retrying in ${(delayMs / 1000).toFixed(1)}s.`, failure, durationMs: Date.now() - started, retrying: true }),
      });
      ctx.metrics?.addToolTime(Date.now() - started);
      record(hits.slice(0, 10).map((h) => sourceFromHit(h, lane.id)));
      emit({ type: "tool.completed", laneId: lane.id, toolId, name, label, durationMs: Date.now() - started });
    } catch (e) {
      if (isAbortError(e)) throw e;
      ctx.metrics?.addToolTime(Date.now() - started);
      const failure = classifyFailure(e);
      const error = `${SOURCE_LABEL[source]}: ${providerMessage(e)}`;
      failures.push({ name, error, failure });
      emit({ type: "tool.failed", laneId: lane.id, toolId, name, label, error, failure, durationMs: Date.now() - started, retrying: false });
    }
  })));

  emit({ type: "lane.started", laneId: lane.id, round: lane.round, queuedMs: slot.queuedMs ?? 0 });
  let afterSources: ResearchSource[] = [];
  try {
    // 1. First wave across the lane's providers (parallel); every hit becomes a "found" source.
    //    Hard dependencies (dependsOn) already settled, so their queries join the first wave.
    await retrieveWave(Array.from(new Set([...lane.queries, ...priorQueries(lane, ctx.priors)])).slice(0, 4));
    if (signal?.aborted) throw abortError();
    ctx.board?.publish(lane.id, sources);

    // 2. Second, targeted wave: queries built from soft dependencies' first-wave results and from the fast-model plan.
    //    Both are awaited with a bound so a slow plan or dependency never stalls the lane.
    const [depResults, plan] = await Promise.all([
      Promise.all((lane.after ?? []).map((id) => ctx.board ? ctx.board.wait(id, policy.softDepWaitMs, signal) : Promise.resolve(undefined))),
      lane.kind === "fast" ? Promise.resolve(undefined) : settleWithin(ctx.plan, policy.planWaitMs, signal),
    ]);
    if (signal?.aborted) throw abortError();
    afterSources = depResults.flatMap((r) => r ?? []);
    const extra = [
      ...priorQueries(lane, afterSources.length ? [{ sources: afterSources }] : []),
      ...((plan?.queries?.[lane.kind] ?? []).filter((q) => !lane.queries.includes(q))),
    ].slice(0, 3);
    if (extra.length) {
      await retrieveWave(extra);
      if (signal?.aborted) throw abortError();
      ctx.board?.publish(lane.id, sources);
    }

    // 3. Reading. Fast lanes (and the no-key path) read the best hits deterministically and in parallel;
    //    deep lanes hand the found list to a bounded fast-model agent.
    const readOne = async (s: ResearchSource, ref: ReadRef) => {
      if (reads >= lane.maxReads) throw new Error(`Read cap (${lane.maxReads}) reached for this lane; write the lane note from what you have already read.`);
      // A read counts against the cap only when it succeeds (a failed or unknown read never costs the lane a read).
      reads++;
      const started = Date.now();
      emit({ type: "source.read_started", laneId: lane.id, sourceId: s.id, title: s.cite ?? s.title });
      let r: Awaited<ReturnType<EngineDeps["read"]>> & { shared: boolean };
      try {
        r = await ctx.reads.read(s.id, () => withRetry(() => deps.read(ref, { title: s.title, signal }), retry), signal);
      } catch (e) {
        reads--;
        throw e;
      }
      const text = r.text ?? "";
      const durationMs = Date.now() - started;
      if (!r.shared) ctx.metrics?.addToolTime(durationMs);
      record([{ ...s, read: true, chars: text.length, readMs: durationMs, cached: r.cached || r.shared, excerpt: text.slice(0, 600), title: s.title || r.title || s.title, url: s.url ?? r.url, cite: s.cite ?? r.cite }], false);
      const merged = found.get(s.id)!;
      emit({ type: "source.read", laneId: lane.id, sourceId: s.id, chars: text.length, cached: Boolean(r.cached || r.shared), durationMs, source: merged });
      return text;
    };

    if (lane.kind === "fast" || !deps.hasKey) {
      const terms = focusTerms([ctx.question, ...lane.queries]);
      const top = rankForReading(Array.from(found.values()).filter((s) => s.hit.readRef && s.kind !== "web"), terms).slice(0, lane.kind === "fast" ? 2 : Math.min(2, lane.maxReads));
      await Promise.all(top.map(async (s) => {
        try { await readOne(s, s.hit.readRef!); } catch (e) {
          if (isAbortError(e)) throw e;
          const failure = classifyFailure(e);
          const error = `Could not read ${s.cite ?? s.title}: ${providerMessage(e)}`;
          failures.push({ name: "read_source", error, failure });
          emit({ type: "tool.failed", laneId: lane.id, toolId: nextToolId(), name: "read_source", label: `Reading ${s.cite ?? s.title}`, error, failure, durationMs: 0, retrying: false });
        }
      }));
    } else {
      agentRan = true;
      const tools = buildLaneTools(lane, ctx, { found, record, readOne, peers: () => [...ctx.priors.flatMap((p) => p.sources), ...afterSources] });
      const j = jurisdictionByKey(ctx.settings.jurisdiction);
      const matterLine = ctx.matter ? `Matter: ${ctx.matter.name} (${ctx.matter.caption ?? ctx.matter.shortName}); client ${ctx.matter.client} (${ctx.matter.clientSide}); ${ctx.matter.court ?? ""}; stage ${ctx.matter.stage ?? "n/a"}; matter id ${ctx.matter.id}.${matterForumSuffix(ctx.matter)}` : "No matter selected.";
      const forumLine = `Forum: ${j.label}. Binding courts: ${bindingCourtIds(j.key).join(", ")}.${lane.courtFilter?.length ? ` This lane searches: ${lane.courtFilter.join(", ")}.` : ""}`;
      // Byte-stable per lane kind (cacheable prefix); everything volatile is in the user turn below.
      const instructions = laneInstructions(lane.kind, lane.name, lane.brief, firmLabel(), lane.maxReads, LEGAL_STYLE_RULES);
      const list = Array.from(found.values()).slice(0, 25).map((s) => `${s.id} · ${formatBluebook(s.hit)}${s.authority && s.authority !== "n/a" ? ` (${s.authority})` : ""}${textTag(s)}${s.snippet ? ` — ${s.snippet.slice(0, 200)}` : ""}`).join("\n");
      const leading = [...ctx.priors.flatMap((p) => p.sources), ...afterSources].filter((s) => s.kind === "caselaw" && CASE_TITLE_RE.test(s.title)).sort((a, b) => Number(b.read) - Number(a.read) || Number(b.authority === "binding") - Number(a.authority === "binding"));
      const priorNote = lane.kind === "contrary" && leading.length ? `\n\nLeading authority the binding lane found (look for judgments that distinguish, doubt, overrule or limit these):\n${Array.from(new Map(leading.map((s) => [s.id, s])).values()).slice(0, 4).map((s) => `- ${s.id} · ${formatBluebook(s.hit)}`).join("\n")}` : "";
      const input = `${todayLine()}\n${matterLine}\n${forumLine}${ctx.coverage ? `\n\n${ctx.coverage}` : ""}\n\nStructured results already found (${found.size}):\n${list || "(none — search first)"}${priorNote}\n\nResearch question: ${ctx.question}`;
      let webSearchId: string | null = null;
      const onEvent = (e: AgentEvent) => {
        if (e.type === "tool.call") emit({ type: "tool.started", laneId: lane.id, toolId: e.id, name: e.name, label: e.label });
        if (e.type === "tool.result") {
          ctx.metrics?.addToolTime(e.durationMs);
          if (e.ok) emit({ type: "tool.completed", laneId: lane.id, toolId: e.id, name: e.name, label: e.name, durationMs: e.durationMs });
          else emit({ type: "tool.failed", laneId: lane.id, toolId: e.id, name: e.name, label: e.name, error: e.error ?? "tool failed", failure: classifyFailure(e.error), durationMs: e.durationMs, retrying: false });
        }
        if (e.type === "web_search") {
          if (e.status === "searching") { webSearchId = nextToolId(); emit({ type: "tool.started", laneId: lane.id, toolId: webSearchId, name: "web_search", label: "Searching the web" }); }
          else { emit({ type: "tool.completed", laneId: lane.id, toolId: webSearchId ?? nextToolId(), name: "web_search", label: e.query ? `Web search: ${e.query}` : "Web search complete", durationMs: 0 }); webSearchId = null; }
        }
        if (e.type === "citation" && e.citation.source === "web" && e.citation.url) {
          const hit = normalizeWebCitation({ title: e.citation.title, url: e.citation.url, snippet: e.citation.snippet }, found.size);
          record([sourceFromHit(hit, lane.id)]);
        }
      };
      const agentStarted = Date.now();
      try {
        const res = await deps.laneAgent({ instructions, input, tools, web: lane.tools.includes("web_search"), maxSteps: lane.maxSteps, signal, onEvent });
        ctx.metrics?.addModelTime(Date.now() - agentStarted, res.usage ?? null);
        note = res.text.trim();
      } catch (e) {
        ctx.metrics?.addModelTime(Date.now() - agentStarted, null);
        if (isAbortError(e)) throw e;
        if (e instanceof AIConfigError) agentRan = false;
        else {
          const failure = classifyFailure(e);
          const error = `Lane agent stopped: ${providerMessage(e)}`;
          failures.push({ name: "lane_agent", error, failure });
          emit({ type: "tool.failed", laneId: lane.id, toolId: nextToolId(), name: "lane_agent", label: `${lane.name} agent`, error, failure, durationMs: Date.now() - agentStarted, retrying: false });
        }
      }
    }

    ctx.board?.publish(lane.id, sources);
    const durationMs = Date.now() - t0;
    const error = failures.length ? failures.map((f) => f.error).join("; ") : undefined;
    const failure = failures.length ? failures[0].failure : undefined;
    emit({ type: "lane.completed", laneId: lane.id, status: "done", durationMs, sources: sources.length, read: readCount(), error, failure, note: note || undefined });
    return { laneId: lane.id, status: "done", sources, read: readCount(), note, agentRan, durationMs, error, failure, failures };
  } catch (e) {
    ctx.board?.publish(lane.id, sources);
    const durationMs = Date.now() - t0;
    const laneAborted = Boolean(signal?.aborted) || isAbortError(e);
    const runCancelled = Boolean(ctx.runSignal?.aborted);
    const status: LaneStatus = laneAborted ? (runCancelled || !ctx.timedOut?.() ? "stopped" : "timeout") : "error";
    const failure: FailureKind = status === "timeout" ? "timeout" : status === "stopped" ? "cancelled" : classifyFailure(e);
    const error = status === "timeout" ? `Lane timed out after ${Math.round(durationMs / 1000)}s; ${sources.length} source${sources.length === 1 ? "" : "s"} kept` : status === "stopped" ? undefined : providerMessage(e);
    emit({ type: "lane.completed", laneId: lane.id, status, durationMs, sources: sources.length, read: readCount(), error, failure, note: note || undefined });
    return { laneId: lane.id, status, sources, read: readCount(), note, agentRan, durationMs, error, failure, failures };
  }
}

interface LaneToolHooks {
  found: Map<string, ResearchSource>;
  record: (incoming: ResearchSource[]) => void;
  readOne: (s: ResearchSource, ref: ReadRef) => Promise<string>;
  /** Sources other lanes handed this lane (hard and soft dependencies), so ids shown in the prompt always resolve. */
  peers?: () => ResearchSource[];
}

/** " [full text]" / " [metadata only]" for judgments (whether read_source can read it). */
export function textTag(s: Pick<ResearchSource, "kind" | "hit">): string {
  if (s.kind !== "caselaw") return "";
  return s.hit.readRef ? " [full text]" : " [metadata only]";
}

/** Candidate spellings of a source id a model may pass ("sc:X" for "corpus:sc:X", quoted ids). */
function idVariants(id: string): string[] {
  const t = id.trim().replace(/^["'`]|["'`]$/g, "");
  const out = [t];
  if (t.startsWith("corpus:")) out.push(t.slice(7));
  else out.push(`corpus:${t}`);
  return Array.from(new Set(out));
}

/**
 * Resolve a model-supplied source id against the sources this lane may use (its own finds, the run's known sources,
 * and its dependencies' sources): exact id first, then the "corpus:" spelling, then an exact citation that only one
 * source carries. Never a closest match: an unknown id stays unknown.
 */
export function resolveLaneSource(id: string, pools: Iterable<ResearchSource>[]): ResearchSource | undefined {
  const all: ResearchSource[] = [];
  for (const p of pools) for (const s of p) all.push(s);
  for (const v of idVariants(id)) { const hit = all.find((s) => s.id === v); if (hit) return hit; }
  const norm = (c: string) => c.replace(/\s+/g, " ").trim().toUpperCase();
  const want = norm(id);
  if (want.length < 6) return undefined;
  const byCite = all.filter((s) => [s.cite, ...(s.hit.citations ?? []), s.hit.india?.neutralCitation].some((c) => c && norm(c) === want));
  const ids = new Set(byCite.map((s) => s.id));
  return ids.size === 1 ? byCite[0] : undefined;
}

/** The error for an unknown id: lists ids the lane can use (readable first), so the model can retry correctly. */
export function unknownSourceError(id: string, pools: Iterable<ResearchSource>[], want: "any" | "statutes" = "any"): Error {
  const seen = new Map<string, ResearchSource>();
  for (const p of pools) for (const s of p) if (!seen.has(s.id)) seen.set(s.id, s);
  const list = [...seen.values()].filter((s) => (want === "statutes" ? s.kind === "statutes" : true)).sort((a, b) => Number(Boolean(b.hit.readRef)) - Number(Boolean(a.hit.readRef)));
  const shown = list.slice(0, 12).map((s) => `${s.id}${s.hit.readRef ? "" : " (metadata only, not readable)"}`);
  return new Error(`Unknown source id ${id}. Use an id exactly as a search result listed it${shown.length ? `; valid ids include: ${shown.join(", ")}` : "; search first"}.`);
}

type AnyTool = ToolDef<never, unknown>;

/**
 * Lane-scoped tools (constitution §52): narrow, typed, bounded. Searches go through deps.retrieve (recorded as found
 * sources); reads go through deps.read (recorded, cached, capped) so "read" always means the text reached this run.
 * Tool definitions are byte-stable per lane kind so providers can cache them.
 */
export function buildLaneTools(lane: ResearchLane, ctx: LaneContext, hooks: LaneToolHooks): AnyTool[] {
  const tools: AnyTool[] = [];
  const has = (name: string) => lane.tools.includes(name);
  const compact = (s: ResearchSource) => ({ id: s.id, cite: formatBluebook(s.hit), court: s.hit.court ?? s.court, bench_strength: s.hit.india?.benchStrength, date: s.date, authority: s.authority, language: s.hit.india?.language, ...(s.kind === "caselaw" ? { text: s.hit.readRef ? "full text" : "metadata only" } : {}), snippet: s.snippet?.slice(0, 240), read: s.read });
  const retryOpts = { retries: ctx.policy.retrievalRetries, baseMs: ctx.policy.retryBaseMs, maxMs: ctx.policy.retryMaxMs, signal: ctx.signal };
  const pools = (): Iterable<ResearchSource>[] => [Array.from(hooks.found.values()), ctx.known, hooks.peers?.() ?? []];
  const lookup = (id: string) => resolveLaneSource(id, pools());
  /** Resolve and adopt: a source handed over by another lane is recorded in this lane when used. */
  const adopt = (id: string): ResearchSource => {
    const s = lookup(id);
    if (!s) throw unknownSourceError(id, pools());
    if (!hooks.found.has(s.id)) hooks.record([{ ...s, laneIds: [lane.id] }]);
    return hooks.found.get(s.id) ?? s;
  };
  const textFor = async (s: ResearchSource): Promise<string> => {
    const ref = s.hit.readRef;
    if (!ref) throw new Error("This source is metadata only (no readable full text): cite it only for what its snippet shows, say the text was not read, and mark any characterization [VERIFY]. Search for the same judgment with words from its subject to find a full-text copy.");
    return ctx.texts.get(s.id) ?? (await hooks.readOne(s, ref));
  };

  for (const name of lane.tools) {
    const source = SEARCH_TOOL_FOR[name];
    if (!source) continue;
    tools.push(defineTool<{ query: string; limit?: number }>({
      name,
      description: SEARCH_TOOL_DESC[name],
      parameters: { type: "object", properties: { query: { type: "string" }, limit: { type: "integer", description: "Default 8, max 12" } }, required: ["query"] },
      examples: [{ query: name === "search_judgments" ? "anticipatory bail section 438 CrPC economic offence parity" : name === "search_statutes" ? "Bharatiya Nagarik Suraksha Sanhita anticipatory bail" : name === "search_official_sources" ? "SEBI order insider trading unpublished price sensitive information" : "limitation condonation of delay section 5", limit: 8 }],
      timeoutMs: 30_000,
      label: (a) => `Searching ${SOURCE_LABEL[source].toLowerCase()}: ${a.query}`,
      async execute(args) {
        const { hits, total } = await withRetry(() => ctx.deps.retrieve(source, args.query, { ...laneSettings(lane, ctx.settings, source), limit: Math.min(args.limit ?? 8, 12) }, ctx.signal), retryOpts);
        const incoming = hits.slice(0, 10).map((h) => sourceFromHit(h, lane.id));
        hooks.record(incoming);
        return { total, results: incoming.map((s) => compact(hooks.found.get(s.id) ?? s)) };
      },
    }) as AnyTool);
  }

  // Reader sizes follow the `research_lane` budget of the configured model (real deps); fakes keep 30k / 32k.
  const laneBudget = ctx.deps.budget?.("research_lane");
  const readDefault = laneBudget ? Math.max(30_000, laneBudget.perSourceChars) : 30_000;
  const readResultMax = laneBudget ? Math.max(32_000, Math.min(laneBudget.toolResultChars, readDefault + 4_000)) : 32_000;
  tools.push(defineTool<{ source_id: string; page?: number; max_chars?: number }>({
    name: "read_source",
    description: `Read the full text of a source by its id, exactly as a search result listed it (e.g. corpus:sc:…, corpus:2024 INSC 735, judgment:…, law:…). Judgment text carries page markers ([p. 6]); pass \`page\` to start at the page of a search passage, and cite the page. Required before quoting or characterizing a holding. Sources marked "metadata only" cannot be read. At most ${lane.maxReads} successful reads in this lane (re-reading a source already read is free).`,
    parameters: { type: "object", properties: { source_id: { type: "string" }, page: { type: "integer", description: "Start at this page (judgment text with [p. N] markers)" }, max_chars: { type: "integer", description: `Default ${readDefault}` } }, required: ["source_id"] },
    examples: [{ source_id: "corpus:sc:2024_10_108_125", page: 6 }, { source_id: "judgment:ijdg_8f2a61c0d9e4b7a35c10" }],
    timeoutMs: 45_000,
    maxResultChars: readResultMax,
    label: (a) => { const s = lookup(a.source_id); return `Reading ${s?.cite ?? s?.title ?? a.source_id}${a.page ? `, p. ${a.page}` : ""}`; },
    async execute(args) {
      const s = adopt(args.source_id);
      const full = await textFor(s);
      const at = args.page != null ? pageOffset(full, args.page) : 0;
      if (at < 0) throw new Error(`No page ${args.page} marker in ${s.cite ?? s.id}; read without \`page\` to see the pages it has.`);
      const text = full.slice(at);
      const max = Math.min(args.max_chars ?? readDefault, readResultMax - 2_000);
      return { id: s.id, cite: formatBluebook(s.hit), url: s.url, length: full.length, ...(at ? { from_char: at } : {}), text: text.length > max ? text.slice(0, max) + "\n…[truncated]" : text };
    },
  }) as AnyTool);

  for (const readerName of ["get_opinion", "read_judgment"] as const) {
    if (!has(readerName)) continue;
    tools.push(defineTool<{ source_id: string; start_paragraph?: number; count?: number }>({
      name: readerName,
      description: "Read a source (usually a judgment) in numbered paragraph windows: ¶1, ¶2 … — the same numbering pinpoint cites [n ¶k] use and the reader shows. The original-language text is the text of record. Counts toward the lane's read cap on first use.",
      parameters: { type: "object", properties: { source_id: { type: "string" }, start_paragraph: { type: "integer", description: "1-based, default 1" }, count: { type: "integer", description: "Default 40, max 100" } }, required: ["source_id"] },
      examples: [{ source_id: "judgment:ijdg_8f2a61c0d9e4b7a35c10", start_paragraph: 1, count: 40 }],
      timeoutMs: 45_000,
      maxResultChars: 36_000,
      label: (a) => { const s = hooks.found.get(a.source_id); return `Reading ${s?.cite ?? s?.title ?? a.source_id}${a.start_paragraph ? ` from ¶${a.start_paragraph}` : ""}`; },
      async execute(args) {
        const s = adopt(args.source_id);
        const paras = splitParagraphs(await textFor(s));
        const start = Math.max(1, Math.floor(args.start_paragraph ?? 1));
        const n = Math.min(Math.max(1, Math.floor(args.count ?? 40)), 100);
        return { id: s.id, cite: formatBluebook(s.hit), language: s.hit.india?.language, total_paragraphs: paras.length, paragraphs: paras.slice(start - 1, start - 1 + n).map((text, i) => ({ n: start + i, text: text.length > 3000 ? text.slice(0, 3000) + " …" : text })), next_start: start - 1 + n < paras.length ? start + n : null };
      },
    }) as AnyTool);
  }

  if (has("read_section")) {
    tools.push(defineTool<{ source_id: string }>({
      name: "read_section",
      description: "Read an India Code section found by search_statutes, in full. Counts toward the lane's read cap on first use.",
      parameters: { type: "object", properties: { source_id: { type: "string" } }, required: ["source_id"] },
      examples: [{ source_id: "section:ienact_5d0c2e7a9b41f3c8a6e1:482" }],
      timeoutMs: 20_000,
      maxResultChars: 24_000,
      label: (a) => { const s = hooks.found.get(a.source_id); return `Reading ${s?.cite ?? s?.title ?? a.source_id}`; },
      async execute(args) {
        const s = lookup(args.source_id);
        if (!s || s.kind !== "statutes") throw unknownSourceError(args.source_id, pools(), "statutes");
        if (!hooks.found.has(s.id)) hooks.record([{ ...s, laneIds: [lane.id] }]);
        const text = await textFor(s);
        return { id: s.id, cite: formatBluebook(s.hit), replaced_by: s.hit.india?.replacedBy, currentness: s.currentness?.label, text: text.length > 20_000 ? text.slice(0, 20_000) + "\n…[truncated]" : text };
      },
    }) as AnyTool);
  }

  if (has("map_criminal_section")) tools.push(mapCriminalSectionTool as unknown as AnyTool);

  if (has("citing_references") && ctx.deps.citing) {
    const citing = ctx.deps.citing.bind(ctx.deps);
    tools.push(defineTool<{ source_id: string }>({
      name: "citing_references",
      description: "For a judgment among the sources (its source id), find later judgments that cite it: for corpus judgments (corpus:…), judgments in the full-text corpus whose text MENTIONS its neutral or reporter citation (text match, with passage and page); for the local store, parsed citations. Flags negative-treatment language near the citation (overruled, per incuriam, doubted, referred to a larger bench, not good law). A treatment signal to REVIEW: a mention is not 'followed' or 'overruled', it is not a citator and never establishes good law.",
      parameters: { type: "object", properties: { source_id: { type: "string" } }, required: ["source_id"] },
      examples: [{ source_id: "judgment:ijdg_8f2a61c0d9e4b7a35c10" }],
      timeoutMs: 20_000,
      label: (a) => { const s = hooks.found.get(a.source_id); return `Checking citing judgments for ${s?.cite ?? s?.title ?? a.source_id}`; },
      async execute(args) {
        const s = lookup(args.source_id);
        if (!s) throw unknownSourceError(args.source_id, pools());
        const judgmentId = s.hit.readRef?.kind === "judgment" ? s.hit.readRef.id : s.hit.india?.judgmentId;
        if (s.kind !== "caselaw" || !judgmentId) throw new Error("citing_references needs a judgment source id (from search_judgments); this source is not a judgment in the corpus.");
        const treatment = await citing({ judgmentId, signal: ctx.signal });
        hooks.record([{ ...s, laneIds: [lane.id], treatment }]);
        return { id: s.id, cite: formatBluebook(s.hit), ...treatment };
      },
    }) as AnyTool);
  }

  if (has("find_citing_opinions") && ctx.deps.citing) {
    const citing = ctx.deps.citing.bind(ctx.deps);
    tools.push(defineTool<{ source_id: string }>({
      name: "find_citing_opinions",
      description: "For a case among the sources, find citing opinions and whether any use negative-treatment language (overruled, abrogated, declined to follow…). Returns a treatment signal to REVIEW; it is not a citator and never establishes good law.",
      parameters: { type: "object", properties: { source_id: { type: "string" } }, required: ["source_id"] },
      examples: [{ source_id: "caselaw:112120" }],
      timeoutMs: 20_000,
      label: (a) => { const s = hooks.found.get(a.source_id); return `Checking citing opinions for ${s?.cite ?? s?.title ?? a.source_id}`; },
      async execute(args) {
        const s = lookup(args.source_id);
        const opinionId = s?.hit.readRef?.kind === "opinion" ? s.hit.readRef.id : s?.hit.opinionId;
        if (!s || s.kind !== "caselaw" || opinionId == null) throw new Error("find_citing_opinions needs a case-law source id with a CourtListener opinion.");
        const treatment = await citing({ opinionId, signal: ctx.signal });
        hooks.record([{ ...s, laneIds: [lane.id], treatment }]);
        return { id: s.id, cite: formatBluebook(s.hit), ...treatment };
      },
    }) as AnyTool);
  }

  if (has("resolve_citation") && ctx.deps.resolveCitation) {
    const resolve = ctx.deps.resolveCitation.bind(ctx.deps);
    tools.push(defineTool<{ citation: string }>({
      name: "resolve_citation",
      description: "Resolve one neutral or reporter citation (e.g. '2024 INSC 735', '(2017) 10 SCC 1', '2024:KHC-D:7336') to a judgment in the corpus. Returns resolved, ambiguous (several candidates, none chosen) or unresolved. Never substitute a similar judgment for an unresolved citation.",
      parameters: { type: "object", properties: { citation: { type: "string" } }, required: ["citation"] },
      examples: [{ citation: "(2014) 8 SCC 273" }, { citation: "2024 INSC 735" }],
      timeoutMs: 20_000,
      label: (a) => `Resolving ${a.citation}`,
      async execute(args) { return resolve(args.citation, ctx.signal); },
    }) as AnyTool);
  }

  if (has("build_citation")) {
    tools.push(defineTool<{ fields: Record<string, unknown> }>({
      name: "build_citation",
      description: "Format an Indian citation deterministically from structured fields. case: {type:'case', caseName, neutral?, reporters?[], courtId?, caseNumber?, decisionDate? (YYYY-MM-DD), pinpoint? (para number)}; statute: {type:'statute', enactment, year?, sections[]}. Unparseable citations and missing fields are returned as errors; nothing is invented.",
      parameters: {
        type: "object",
        properties: {
          fields: {
            type: "object",
            description: "type plus the fields for that type (see the tool description).",
            properties: { type: { type: "string", enum: ["case", "statute"] } },
            required: ["type"],
            additionalProperties: true,
          },
        },
        required: ["fields"],
      },
      strict: false,
      examples: [{ fields: { type: "case", caseName: "Arnesh Kumar v. State of Bihar", reporters: ["(2014) 8 SCC 273"], pinpoint: 11 } }, { fields: { type: "statute", enactment: "Bharatiya Nagarik Suraksha Sanhita", year: 2023, sections: ["482"] } }],
      timeoutMs: 2_000,
      label: () => "Formatting a citation",
      execute(args) {
        const f = args.fields ?? {};
        const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
        if (f.type === "statute") {
          const enactment = str(f.enactment);
          const sections = Array.isArray(f.sections) ? f.sections.map(String).filter(Boolean) : [];
          if (!enactment) return { citation: null, errors: ["enactment is required"] };
          return { citation: formatStatuteCitation({ enactment, year: typeof f.year === "number" || typeof f.year === "string" ? f.year : undefined, sections }), errors: [] };
        }
        const pin = typeof f.pinpoint === "number" ? f.pinpoint : typeof f.pinpoint === "string" && /^\d+$/.test(f.pinpoint) ? Number(f.pinpoint) : undefined;
        const r = formatCaseCitation({ caseName: str(f.caseName) ?? "", neutral: str(f.neutral), reporters: Array.isArray(f.reporters) ? f.reporters.map(String) : undefined, courtId: str(f.courtId), caseNumber: str(f.caseNumber), decisionDate: str(f.decisionDate) }, { pinpoint: pin });
        return { citation: r.citation, short: r.short, errors: r.errors, courtId: r.courtId };
      },
    }) as AnyTool);
  }

  if (has("compare_authorities")) {
    tools.push(defineTool<{ source_ids: string[] }>({
      name: "compare_authorities",
      description: "Side-by-side table of sources already found: citation, court, year, binding/persuasive, read state, treatment signal and holding sentences with ¶ pinpoints (only for sources read in full). Use it to reconcile authorities before writing the lane note.",
      parameters: { type: "object", properties: { source_ids: { type: "array", items: { type: "string" }, description: "Up to 8 source ids" } }, required: ["source_ids"] },
      examples: [{ source_ids: ["caselaw:112120", "caselaw:4381234"] }],
      timeoutMs: 5_000,
      label: (a) => `Comparing ${a.source_ids.length} authorities`,
      execute(args) {
        const list = args.source_ids.slice(0, 8).map(lookup).filter((s): s is ResearchSource => Boolean(s));
        return { rows: compareAuthorities(list, (s) => ctx.texts.get(s.id)), unknown: args.source_ids.filter((id) => !lookup(id)) };
      },
    }) as AnyTool);
  }

  // Matter record tools exist only when a matter is selected (never widened to all matters).
  if (ctx.matter && has("search_matter_documents")) {
    const matterId = ctx.matter.id;
    tools.push(defineTool<{ query: string; limit?: number }>({
      name: "search_matter_documents",
      description: "Search the selected matter's documents and deposition transcripts. Limited to this matter.",
      parameters: { type: "object", properties: { query: { type: "string" }, limit: { type: "integer", description: "Default 8, max 12" } }, required: ["query"] },
      examples: [{ query: "legal notice under section 138 Negotiable Instruments Act", limit: 8 }],
      timeoutMs: 30_000,
      label: (a) => `Searching matter documents: ${a.query}`,
      async execute(args) {
        const { hits, total } = await withRetry(() => ctx.deps.retrieve("ediscovery", args.query, { ...ctx.settings, matterId, limit: Math.min(args.limit ?? 8, 12) }, ctx.signal), retryOpts);
        const incoming = hits.slice(0, 10).map((h) => sourceFromHit(h, lane.id));
        hooks.record(incoming);
        return { total, results: incoming.map((s) => compact(hooks.found.get(s.id) ?? s)) };
      },
    }) as AnyTool);
    tools.push(defineTool<{ source_id: string; max_chars?: number }>({
      name: "read_matter_document",
      description: "Read a matter document found by search_matter_documents (selected matter only).",
      parameters: { type: "object", properties: { source_id: { type: "string" }, max_chars: { type: "integer", description: "Default 20000" } }, required: ["source_id"] },
      examples: [{ source_id: "ediscovery:MFC-000123" }],
      timeoutMs: 30_000,
      maxResultChars: 24_000,
      label: (a) => `Reading ${hooks.found.get(a.source_id)?.cite ?? a.source_id}`,
      async execute(args) {
        const s = hooks.found.get(args.source_id);
        if (!s || s.scope !== "record") throw new Error("read_matter_document reads only matter documents found in this lane.");
        const text = await textFor(s);
        const max = args.max_chars ?? 20_000;
        return { id: s.id, bates: s.cite, text: text.length > max ? text.slice(0, max) + "\n…[truncated]" : text };
      },
    }) as AnyTool);
  }

  if (has("fetch_url")) {
    const openWeb = ctx.settings.sources.includes("web");
    tools.push(defineTool<{ url: string; max_chars?: number }>({
      name: "fetch_url",
      description: openWeb ? "Read a public web page (court site, India Code, gazette, regulator page) by URL. Counts toward the lane's read cap." : "Read an official Indian legal web page by URL (India Code, Supreme Court and High Court sites, eCourts, the e-Gazette, ministries and regulators). Other hosts are refused unless web sources are in scope. Subscription services are never read. Counts toward the lane's read cap.",
      parameters: { type: "object", properties: { url: { type: "string" }, max_chars: { type: "integer" } }, required: ["url"] },
      examples: [{ url: "https://indiacode.gov.in/handle/123456789/496413" }],
      timeoutMs: 30_000,
      maxResultChars: 32_000,
      label: (a) => `Reading ${safeHost(a.url)}`,
      async execute(args) {
        if (!/^https?:\/\//i.test(args.url)) throw new Error("Only http(s) URLs are supported");
        if (!openWeb && !isIndianLegalFetchHost(args.url)) throw new Error(`${safeHost(args.url)} is not an allowlisted official legal source; add Web to the sources to read the open web.`);
        const hit: SearchHit = normalizeWebCitation({ title: args.url, url: args.url }, hooks.found.size);
        const existing = hooks.found.get(sourceKey(hit));
        const s = existing ?? sourceFromHit(hit, lane.id);
        if (!existing) hooks.record([s]);
        const text = ctx.texts.get(s.id) ?? (await hooks.readOne(s, { kind: "url", url: args.url }));
        const max = Math.min(args.max_chars ?? readDefault, readResultMax - 2_000);
        return { id: s.id, url: args.url, length: text.length, text: text.length > max ? text.slice(0, max) + "\n…[truncated]" : text };
      },
    }) as AnyTool);
  }

  if (has("get_matter_context")) tools.push(matterContextTool as unknown as AnyTool);

  if (has("verify_citations")) {
    tools.push(defineTool<{ text: string }>({
      name: "verify_citations",
      description: "Check whether the neutral and reporter citations in a passage resolve to judgments in the corpus. Use before relying on a citation you did not read; a citation that resolves still has to be read before it is characterized.",
      parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      examples: [{ text: "Arnesh Kumar v. State of Bihar, (2014) 8 SCC 273" }],
      timeoutMs: 20_000,
      label: () => "Verifying citations",
      async execute(args) {
        try { return { resolved: await ctx.deps.verifyCitationsRemote(args.text, ctx.signal) }; } catch (e) { return { error: providerMessage(e), resolved: [] }; }
      },
    }) as AnyTool);
  }

  return tools;
}

/** Offset of the "[p. N]" marker in judgment text (-1 when the text has no such page). */
export function pageOffset(text: string, page: number): number {
  const m = new RegExp(`(^|\\n)\\[p\\. ${Math.floor(page)}\\]`).exec(text);
  return m ? m.index + m[1].length : -1;
}

function safeHost(url: string) { try { return new URL(url).host; } catch { return "page"; } }
