import "server-only";
import { defineTool, type EvidenceProvenance, type ToolContext } from "../tools";
import { htmlToText } from "./http";
import { contentHash } from "@/lib/integrity/hash";
import { currentPrincipal } from "@/lib/auth/context";
import { accessibleMatterIds } from "@/lib/auth/scope";
import type { MatterScope, Principal } from "@/lib/auth/types";
import { bindingEffect, courtById, type Court } from "@/lib/india/courts";
import { extractCitations, normalizeCitation } from "@/lib/india/citations";
import type { LocaleCode } from "@/lib/india/languages";
import type { IndianCitation } from "@/lib/india/types";
import { getDocumentText, intelDocuments, listChunks } from "@/modules/intel/store";
import {
  getEnactment, getJudgment, getSection, getSections, indiaConnectorStatuses, judgmentText, listEnactments, listJudgments, searchIndianAuthorities,
  type StoredEnactment, type StoredEnactmentSection, type StoredJudgment,
} from "@/modules/india/sources";
import { createIndianKanoon, courtForDocsource, type IndianKanoonClient } from "@/modules/india/sources/indian-kanoon";
import { isCorpusScope, type RetrievalScope } from "../vector-store";
import { mapCriminalSection } from "./india-criminal-map";
import { JUDGMENT_TEXT_TOOLS } from "./india-judgment-text";
import { jurisdictionLabel, lawCitation, lawSourceId, publisherLabel, statusLabel } from "@/modules/law/shared";

/**
 * Indian legal research tools (LeClaude India; constitution §25, §52, §53.4, Appendix B), built on the India source
 * layer (`@/modules/india/sources`):
 *
 * - `search_judgments` / `read_judgment`: the ingested Supreme Court and High Court judgments (AWS Open Data SC/HC
 *   datasets; Indian Kanoon documents when ingested). Court identity comes from the registry; an unresolved court
 *   never matches a court filter and is shown as unresolved, never mapped to the nearest court.
 * - `indian_kanoon_search` / `indian_kanoon_doc`: the live Indian Kanoon API, offered ONLY when its connector is ready
 *   (firm token set, network on) — `indiaConnectorStatuses()`; fail closed otherwise.
 * - `search_statutes` / `read_section`: India Code enactments and sections in the store (exact section numbers; an
 *   absent section is reported absent, never the nearest one).
 * - `search_law` / `read_law_section` / `list_law_instruments`: the full statutes corpus in Postgres (Open India Law
 *   parse of India Code and regulator publications, CC BY 4.0; `law://<actId>/s/<section>[~<variant>]`), offered only
 *   with a database (same gating as the judgment index). Exact section reads; the parse is labelled third-party.
 * - `map_criminal_section`: IPC↔BNS, CrPC↔BNSS, IEA↔BSA from the coded correspondence table.
 * - `citing_references`: judgments in the corpus that cite a judgment (its neutral/reporter citations parsed out of
 *   their text by the citation engine) and what it cites — a signal to review, not a citator.
 *
 * Every result carries a stable application source (`judgment://<courtId>/<judgmentId>[/para/<n>]`,
 * `statute://<enactmentId>[/s/<n>]`, `authority://indiankanoon/doc/<tid>`) and focused `search_result` blocks;
 * provenance goes out of band via `ctx.emit({ type: "evidence" })`. Judgments are public authority; a judgment whose
 * intelligence record is linked to specific matters is visible only inside those matters (never widened).
 */

// ---------------------------------------------------------------------------
// Capability registry (constitution §53.5): coded, not remembered.
// ---------------------------------------------------------------------------

export interface IndiaCapabilities {
  /** Indian Kanoon live API: the connector is `ready` (firm token set, network allowed). */
  indianKanoon: boolean;
  /** The judgment corpus index in Postgres (DATABASE_URL set). */
  corpus?: boolean;
}

export function indiaCapabilities(env: Readonly<Record<string, string | undefined>> = process.env): IndiaCapabilities {
  let ready = false;
  try { ready = indiaConnectorStatuses(env).some((s) => s.source === "indian-kanoon" && s.state === "ready"); } catch { ready = false; }
  const db = (env.DATABASE_URL || env.POSTGRES_URL || "").trim();
  return { indianKanoon: ready, corpus: /^postgres(ql)?:\/\//.test(db) };
}

/** The firm's Indian Kanoon client (null unless its connector is ready). */
export function indianKanoonClient(env: Readonly<Record<string, string | undefined>> = process.env): IndianKanoonClient | null {
  if (!indiaCapabilities(env).indianKanoon) return null;
  const client = createIndianKanoon({ token: env.INDIAN_KANOON_API_TOKEN });
  return client.status().state === "ready" ? client : null;
}

// ---------------------------------------------------------------------------
// Stable sources
// ---------------------------------------------------------------------------

const enc = (s: string | number) => encodeURIComponent(String(s));

/** judgment://<courtId>/<judgmentId>[/para/<n>] — `unresolved` stands in for an unregistered court (never a guess). */
export function judgmentSource(courtId: string | null | undefined, judgmentId: string, para?: number): string {
  return `judgment://${enc(courtId || "unresolved")}/${enc(judgmentId)}${para != null ? `/para/${para}` : ""}`;
}

/** statute://<enactmentId>[/s/<section>] */
export function statuteSource(enactmentId: string, section?: string): string {
  return `statute://${enc(enactmentId)}${section ? `/s/${enc(section)}` : ""}`;
}

export const ikSource = (tid: number | string, para?: number) => `authority://indiankanoon/doc/${enc(tid)}${para != null ? `/para/${para}` : ""}`;

// ---------------------------------------------------------------------------
// Judgment view over a stored judgment
// ---------------------------------------------------------------------------

export interface JudgmentView {
  id: string;
  source: string;
  title: string;
  court: Court | null;
  courtId: string | null;
  /** Raw court code when the court did not resolve against the registry. */
  unresolvedCourt?: string;
  benchId?: string;
  benchStrength?: number;
  judges: string[];
  neutralCitation?: string;
  /** Reporter citations as recorded ("(2017) 10 SCC 1"). */
  reporterCitations: string[];
  citations: IndianCitation[];
  caseNumber?: string;
  caseType?: string;
  cnr?: string;
  decisionDate?: string;
  language: LocaleCode | string;
  translations: { language: string; origin: string }[];
  statutes: string[];
  url?: string;
  intelDocId?: string;
  matterIds: string[];
  /** Treatment recorded in the corpus by the ingestion/citation workers (overruled by …). Only from sources, never a model. */
  corpusTreatment?: { status: string; by?: string; note?: string }[];
  provider: string;
}

type Meta = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

export function judgmentView(j: StoredJudgment): JudgmentView {
  const court = courtById(j.courtId ?? undefined);
  const doc = j.intelDocId ? intelDocuments().get(j.intelDocId) : null;
  const reporters = Array.from(new Set(j.citations.filter((c) => c.kind === "reporter").map((c) => normalizeCitation(c.raw) ?? c.raw)));
  const recorded = (j as unknown as Meta).treatment;
  const treatment = Array.isArray(recorded) ? (recorded as Meta[]).map((t) => ({ status: str(t.status) ?? "", by: str(t.by), note: str(t.note) })).filter((t) => t.status) : undefined;
  return {
    id: j.id,
    source: judgmentSource(court?.id ?? null, j.id),
    title: j.title,
    court,
    courtId: court?.id ?? null,
    unresolvedCourt: court ? undefined : j.unresolvedCourt ?? (j.courtId ? `unregistered court id ${j.courtId}` : undefined),
    benchId: j.benchId,
    benchStrength: j.benchStrength ?? (j.judges.length || undefined),
    judges: j.judges,
    neutralCitation: j.neutralCitation,
    reporterCitations: reporters,
    citations: j.citations,
    caseNumber: j.caseNumber,
    caseType: j.caseType,
    cnr: j.cnr,
    decisionDate: j.decisionDate,
    language: j.language ?? "en",
    translations: (j.translations ?? []).map((t) => ({ language: t.language, origin: t.origin })),
    statutes: j.statutes ?? [],
    url: j.pdfUrl ?? doc?.url,
    intelDocId: j.intelDocId,
    matterIds: doc?.matterIds ?? [],
    corpusTreatment: treatment?.length ? treatment : undefined,
    provider: j.source,
  };
}

// ---------------------------------------------------------------------------
// Visibility (matter authorization for matter-linked records)
// ---------------------------------------------------------------------------

/** Matters the caller may see, or "*" for all; [] means only unlinked public records are visible (fail closed). */
export function visibleMatters(ctx: Pick<ToolContext, "scope" | "principal" | "state">): "*" | string[] {
  const s = ctx.scope as RetrievalScope | MatterScope | undefined;
  if (s) {
    if (isCorpusScope(s as RetrievalScope)) { const ids = (s as { matterIds?: string[] }).matterIds; return ids ? [...ids] : "*"; }
    return [...((s as MatterScope).matterIds ?? [])];
  }
  let p: Principal | null = ctx.principal ?? null;
  if (!p) { try { p = currentPrincipal(); } catch { p = null; } }
  const m = typeof ctx.state?.matterId === "string" && ctx.state.matterId ? (ctx.state.matterId as string) : null;
  // A run bound to a matter narrows to that matter (never widened), and only if the principal may see it.
  if (m) return !p || p.matterIds === "*" || accessibleMatterIds(p).includes(m) ? [m] : [];
  if (p) return p.matterIds === "*" ? "*" : accessibleMatterIds(p);
  return [];
}

export function judgmentVisible(v: Pick<JudgmentView, "matterIds">, allowed: "*" | string[]): boolean {
  if (!v.matterIds.length) return true;
  if (allowed === "*") return true;
  return v.matterIds.some((m) => allowed.includes(m));
}

// ---------------------------------------------------------------------------
// Search judgments
// ---------------------------------------------------------------------------

export interface JudgmentFilters {
  /** Registry court ids (sci, hc-karnataka…); empty = all. An unresolved court never matches a court filter. */
  courts?: string[];
  bench?: string;
  yearFrom?: number;
  yearTo?: number;
  judge?: string;
  caseType?: string;
  statute?: string;
  language?: string;
  /** Minimum bench strength (2 = division bench or larger). */
  minBench?: number;
}

export interface JudgmentHit {
  view: JudgmentView;
  passage: string;
  page?: number;
  score: number;
}

function yearOf(d?: string): number | undefined {
  const m = d?.match(/^(\d{4})/);
  return m ? Number(m[1]) : undefined;
}

export function matchesFilters(v: JudgmentView, f: JudgmentFilters): boolean {
  if (f.courts?.length && !(v.courtId && f.courts.includes(v.courtId))) return false;
  if (f.bench) {
    const b = f.bench.toLowerCase();
    const city = v.court?.benches.find((x) => x.id === v.benchId)?.city.toLowerCase() ?? "";
    if (v.benchId?.toLowerCase() !== b && !(city && city.includes(b))) return false;
  }
  const y = yearOf(v.decisionDate);
  if (f.yearFrom && (!y || y < f.yearFrom)) return false;
  if (f.yearTo && (!y || y > f.yearTo)) return false;
  if (f.judge && !v.judges.some((j) => j.toLowerCase().includes(f.judge!.toLowerCase()))) return false;
  if (f.caseType && !`${v.caseType ?? ""} ${v.caseNumber ?? ""}`.toLowerCase().includes(f.caseType.toLowerCase())) return false;
  if (f.statute) {
    const needle = f.statute.toLowerCase().replace(/\s+/g, " ");
    if (!v.statutes.some((s) => s.toLowerCase().includes(needle))) return false;
  }
  if (f.language && v.language !== f.language && !v.translations.some((t) => t.language === f.language)) return false;
  if (f.minBench && (v.benchStrength ?? 0) < f.minBench) return false;
  return true;
}

function terms(q: string): string[] {
  return Array.from(new Set(q.toLowerCase().replace(/["()]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !/^(and|or|not|the|of|in|under|for|with)$/.test(w))));
}

function excerpt(text: string, ts: string[], radius = 260): string {
  const lower = text.toLowerCase();
  let at = -1;
  for (const t of ts) { const i = lower.indexOf(t); if (i >= 0 && (at < 0 || i < at)) at = i; }
  if (at < 0) return text.slice(0, radius * 2).trim();
  const s = Math.max(0, at - radius), e = Math.min(text.length, at + radius);
  return `${s > 0 ? "…" : ""}${text.slice(s, e).replace(/\s+/g, " ").trim()}${e < text.length ? "…" : ""}`;
}

/**
 * Search the judgment corpus: the source layer's hybrid search (`searchIndianAuthorities`, keyword + vector over the
 * intel index) first, then a bounded keyword scan of stored judgments when the index returns too little for the
 * filters. Deterministic filters; never throws for "no results".
 */
export async function searchJudgments(query: string, filters: JudgmentFilters, opts: { limit?: number; allowed: "*" | string[] }): Promise<JudgmentHit[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 8, 25));
  const out = new Map<string, JudgmentHit>();
  const q = query.trim();
  const from = filters.yearFrom ? `${filters.yearFrom}-01-01` : undefined;
  const to = filters.yearTo ? `${filters.yearTo}-12-31` : undefined;
  if (q) {
    let hits: Awaited<ReturnType<typeof searchIndianAuthorities>> = [];
    try { hits = await searchIndianAuthorities(q, { courtIds: filters.courts?.length ? filters.courts : undefined, kinds: ["judgment"], from, to, limit: Math.min(100, limit * 4) }); } catch { hits = []; }
    for (const h of hits) {
      if (!h.judgment) continue;
      const v = judgmentView(h.judgment);
      if (!matchesFilters(v, filters) || !judgmentVisible(v, opts.allowed) || out.has(v.id)) continue;
      out.set(v.id, { view: v, passage: h.hit.chunk.text.slice(0, 700), page: h.hit.chunk.page, score: h.hit.score });
      if (out.size >= limit) break;
    }
  }
  if (out.size < limit) {
    const ts = terms(q);
    const scored: JudgmentHit[] = [];
    const rows = listJudgments({ courtIds: filters.courts?.length ? filters.courts : undefined, includeUnresolved: filters.courts?.length ? false : undefined, from, to, limit: 500 }).items;
    for (const j of rows) {
      if (out.has(j.id)) continue;
      const v = judgmentView(j);
      if (!matchesFilters(v, filters) || !judgmentVisible(v, opts.allowed)) continue;
      const head = `${v.title} ${v.neutralCitation ?? ""} ${v.reporterCitations.join(" ")} ${j.headnote ?? ""} ${v.statutes.join(" ")}`.toLowerCase();
      let score = 0;
      let body: string | null = null;
      if (ts.length) {
        for (const t of ts) if (head.includes(t)) score += 2;
        body = judgmentText(j.id);
        const lower = (body ?? "").toLowerCase();
        for (const t of ts) if (lower.includes(t)) score += 1;
        if (score === 0) continue;
      }
      body = body ?? judgmentText(j.id) ?? j.headnote ?? "";
      scored.push({ view: v, passage: excerpt(body, ts), score: ts.length ? score / (ts.length * 3) : 0 });
    }
    scored.sort((a, b) => b.score - a.score || (b.view.decisionDate ?? "").localeCompare(a.view.decisionDate ?? ""));
    for (const h of scored) { if (out.size >= limit) break; out.set(h.view.id, h); }
  }
  return Array.from(out.values()).slice(0, limit);
}

/** Model-facing compact row for a judgment hit, with a focused search_result block. */
export function judgmentRow(h: JudgmentHit, forum?: Court | null) {
  const v = h.view;
  return {
    type: "search_result" as const,
    source: v.source,
    title: judgmentTitleLine(v),
    content: [h.passage],
    id: v.id,
    case_name: v.title,
    court: v.court?.name ?? (v.unresolvedCourt ? `court not resolved (${v.unresolvedCourt})` : undefined),
    court_id: v.courtId,
    unresolved_court: v.unresolvedCourt,
    bench_id: v.benchId,
    bench_strength: v.benchStrength,
    decided: v.decisionDate,
    neutral_citation: v.neutralCitation,
    reporter_citations: v.reporterCitations,
    judges: v.judges,
    case_number: v.caseNumber,
    case_type: v.caseType,
    language: v.language,
    translations: v.translations,
    statutes: v.statutes.slice(0, 12),
    url: v.url,
    provider: v.provider,
    binding_for_forum: forum && v.court ? bindingFor(v.court, forum) : undefined,
    treatment: v.corpusTreatment ?? "treatment not checked",
    score: Number(h.score.toFixed(3)),
  };
}

export function judgmentTitleLine(v: JudgmentView): string {
  const cites = [v.neutralCitation, ...v.reporterCitations].filter(Boolean).join(" : ");
  const bench = v.benchStrength ? `${v.benchStrength}-judge bench` : "bench strength unknown";
  return `${v.title}${cites ? `, ${cites}` : ""} (${v.court?.shortName ?? (v.unresolvedCourt ? `court not resolved: ${v.unresolvedCourt}` : "court not resolved")}, ${bench}${v.decisionDate ? `, ${v.decisionDate.slice(0, 10)}` : ""})`;
}

/** Deterministic precedential effect for the forum (never the model). */
export function bindingFor(decidedBy: Court, forum: Court): "binding" | "persuasive" {
  return bindingEffect(decidedBy, forum);
}

// ---------------------------------------------------------------------------
// Read judgment (paragraph-numbered, page-mapped)
// ---------------------------------------------------------------------------

export interface JudgmentParagraph { n: number; text: string; source: string; page?: number; judgmentPara?: string }

/** Reader paragraphs (the research engine's pinpoint numbering) with PDF pages from the chunk map where known. */
export function judgmentParagraphs(v: JudgmentView, text: string): JudgmentParagraph[] {
  const chunks = v.intelDocId ? listChunks(v.intelDocId).filter((c) => c.page != null) : [];
  const paras: JudgmentParagraph[] = [];
  let cursor = 0;
  let n = 0;
  for (const raw of text.split(/\n+/)) {
    const t = raw.trim();
    const at = text.indexOf(raw, cursor);
    if (at >= 0) cursor = at + raw.length;
    if (!t) continue;
    n++;
    const page = chunks.find((c) => at >= c.startChar && at < c.endChar)?.page;
    const own = t.match(/^(\d{1,3})\.\s/)?.[1];
    paras.push({ n, text: t, source: judgmentSource(v.courtId, v.id, n), page: page ?? undefined, judgmentPara: own });
  }
  return paras;
}

export function readJudgment(id: string, allowed: "*" | string[]): { view: JudgmentView; text: string } {
  const j = getJudgment(id);
  if (!j) throw new Error(`No judgment with id ${id} in the corpus; use an id returned by search_judgments.`);
  const view = judgmentView(j);
  if (!judgmentVisible(view, allowed)) throw new Error(`Judgment ${id} is not available in the current matter scope.`);
  const text = judgmentText(id);
  if (text == null) throw new Error(`No text is stored for judgment ${id} (metadata only).`);
  return { view, text };
}

// ---------------------------------------------------------------------------
// Statutes (India Code)
// ---------------------------------------------------------------------------

export interface StatuteSectionView { id: string; enactmentId: string; enactment: string; year?: number; section: string; heading?: string; text: string; source: string; replacedBy?: string; inForceFrom?: string; url?: string; correspondsTo?: StoredEnactmentSection["correspondsTo"] }

/** Tool id of a section: `<enactmentId>:<section number as printed>` (resolved with getSection; exact numbers only). */
export const sectionToolId = (enactmentId: string, number: string) => `${enactmentId}:${number}`;

function enactmentName(e: StoredEnactment | null, fallback: string): string {
  return e?.shortTitle ?? e?.title ?? fallback;
}

function sectionView(s: StoredEnactmentSection, e: StoredEnactment | null): StatuteSectionView {
  const replaced = e?.replacedBy ? getEnactment(e.replacedBy) : null;
  return { id: sectionToolId(s.enactmentId, s.number), enactmentId: s.enactmentId, enactment: enactmentName(e, s.enactmentId), year: e?.year, section: s.number, heading: s.heading, text: s.text, source: statuteSource(s.enactmentId, s.number), replacedBy: replaced ? enactmentName(replaced, e?.replacedBy ?? "") : e?.replacedBy, inForceFrom: e?.inForceFrom, url: s.url ?? e?.url, correspondsTo: s.correspondsTo };
}

/**
 * Search India Code sections: Acts found by the source layer's hybrid search or by name, then their sections scored by
 * term overlap; an explicit section number ("s. 482", "Section 138") must match exactly.
 */
export async function searchStatuteSections(query: string, opts: { enactment?: string; limit?: number } = {}): Promise<StatuteSectionView[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 8, 25));
  const ts = terms(query);
  const secNo = query.match(/\b(?:s\.|ss\.|sec(?:tion)?s?\.?|u\/s)\s*(\d+[A-Z]?)/i)?.[1]?.toUpperCase();
  const acts = new Map<string, StoredEnactment>();
  if (opts.enactment) for (const e of listEnactments({ q: opts.enactment, limit: 20 })) acts.set(e.id, e);
  else {
    try { for (const h of await searchIndianAuthorities(query, { kinds: ["enactment"], limit: 10 })) if (h.enactment) acts.set(h.enactment.id, h.enactment); } catch { /* keyword path below */ }
    const all = listEnactments({ limit: 1000 });
    for (const e of all) {
      const name = `${e.title} ${e.shortTitle ?? ""}`.toLowerCase();
      if (ts.some((t) => t.length > 3 && name.includes(t))) acts.set(e.id, e);
    }
    if (!acts.size && all.length <= 60) for (const e of all) acts.set(e.id, e);
  }
  const scored: { v: StatuteSectionView; score: number }[] = [];
  for (const e of acts.values()) {
    const name = `${e.title} ${e.shortTitle ?? ""}`.toLowerCase();
    const nameScore = ts.reduce((a, t) => a + (name.includes(t) ? 1 : 0), 0);
    for (const s of getSections(e.id)) {
      if (secNo && s.number.toUpperCase() !== secNo) continue;
      const head = (s.heading ?? "").toLowerCase();
      const body = s.text.toLowerCase();
      let score = nameScore;
      for (const t of ts) { if (head.includes(t)) score += 2; if (body.includes(t)) score += 1; }
      if (secNo) score += 4;
      if (score > 0) scored.push({ v: sectionView(s, e), score });
    }
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((x) => x.v);
}

/** One section by tool id (`<enactmentId>:<number>`); null when absent (never the nearest section). */
export function readStatuteSection(id: string): StatuteSectionView | null {
  const m = id.match(/^(.+?)(?::|\/s\/)([^:/]+)$/);
  if (!m) return null;
  const s = getSection(m[1], m[2]);
  return s ? sectionView(s, getEnactment(s.enactmentId)) : null;
}

// ---------------------------------------------------------------------------
// Citations in the corpus: resolution and citing references
// ---------------------------------------------------------------------------

/** Negative-treatment language in Indian judgments (lower-cased; matched on word boundaries). */
export const INDIAN_NEGATIVE_PHRASES = ["overruled", "overruling", "per incuriam", "no longer good law", "not good law", "doubted", "referred to a larger bench", "reference to a larger bench", "impliedly overruled", "declined to follow", "not followed", "held to be bad law", "does not lay down the correct law"];

/** A judgment's own citable identifiers (neutral + reporters), normalized by the citation engine. */
export function ownCitationKeys(j: Pick<StoredJudgment, "neutralCitation" | "citations">): string[] {
  const raw = [j.neutralCitation, ...j.citations.filter((c) => c.kind === "neutral" || c.kind === "reporter").map((c) => c.neutral ?? c.raw)].filter((x): x is string => Boolean(x));
  return Array.from(new Set(raw.map((c) => normalizeCitation(c) ?? c.replace(/\s+/g, " ").trim())));
}

let indexCache: { size: number; map: Map<string, string[]> } | null = null;

/** normalized citation → ids of stored judgments that carry it as their own citation. */
export function citationIndex(): Map<string, string[]> {
  const rows = listJudgments({ limit: 500 });
  const size = rows.total;
  if (indexCache && indexCache.size === size) return indexCache.map;
  const all = size > rows.items.length ? listJudgments({ limit: 500, offset: 0 }).items.concat(...Array.from({ length: Math.ceil(size / 500) - 1 }, (_, i) => listJudgments({ limit: 500, offset: (i + 1) * 500 }).items)) : rows.items;
  const map = new Map<string, string[]>();
  for (const j of all) for (const k of ownCitationKeys(j)) { const list = map.get(k) ?? []; if (!list.includes(j.id)) list.push(j.id); map.set(k, list); }
  indexCache = { size, map };
  return map;
}

export type IndianCitationResolution =
  | { citation: string; state: "resolved"; source: string; id: string; title: string }
  | { citation: string; state: "ambiguous"; candidates: { source: string; id: string; title: string }[]; reason: string }
  | { citation: string; state: "unresolved"; reason: string };

/** Resolve one citation against the corpus. One match resolves; several are ambiguous (none chosen); none stays unresolved. */
export function resolveIndianCitation(citation: string): IndianCitationResolution {
  const key = normalizeCitation(citation);
  if (!key) return { citation, state: "unresolved", reason: "not a recognised neutral or reporter citation" };
  const ids = citationIndex().get(key) ?? [];
  const row = (id: string) => { const v = judgmentView(getJudgment(id)!); return { source: v.source, id, title: judgmentTitleLine(v) }; };
  if (ids.length === 1) return { citation, state: "resolved", ...row(ids[0]) };
  if (ids.length > 1) return { citation, state: "ambiguous", candidates: ids.slice(0, 5).map(row), reason: `${ids.length} judgments in the corpus carry this citation; none was chosen` };
  return { citation, state: "unresolved", reason: "no judgment in the corpus carries this citation" };
}

/** Parsed case citations of a judgment's text, cached per judgment and text length (bounded). */
const citedCache = new Map<string, { len: number; keys: Set<string> }>();
function citedKeys(id: string, text: string): Set<string> {
  const hit = citedCache.get(id);
  if (hit && hit.len === text.length) return hit.keys;
  const keys = new Set<string>();
  for (const c of extractCitations(text)) if ((c.kind === "neutral" || c.kind === "reporter") && c.valid) keys.add(c.normalized ?? c.raw);
  if (citedCache.size > 2000) citedCache.delete(citedCache.keys().next().value as string);
  citedCache.set(id, { len: text.length, keys });
  return keys;
}

export interface CitingRef { id: string; source: string; title: string; court?: string; decided?: string; context: string; phrase?: string; benchStrength?: number }

/**
 * Judgments in the corpus that cite `targetId` (any of its own citations appears, parsed, in their text), with the
 * passage around the citation and any negative-treatment language there; plus what the target cites, resolved
 * without substitution. Bounded: candidates come from a search for the target's citations, then a scan of the most
 * recent 500 judgments.
 */
export async function citingReferences(targetId: string, allowed: "*" | string[], opts: { limit?: number } = {}): Promise<{ target: JudgmentView; citing: CitingRef[]; cited: { raw: string; resolvedId?: string; state: string }[]; checked: number }> {
  const limit = Math.max(1, Math.min(opts.limit ?? 10, 25));
  const tj = getJudgment(targetId);
  if (!tj) throw new Error(`No judgment with id ${targetId} in the corpus.`);
  const target = judgmentView(tj);
  const keys = new Set(ownCitationKeys(tj));
  const candidates = new Map<string, StoredJudgment>();
  for (const k of keys) {
    try { for (const h of await searchIndianAuthorities(`"${k}"`, { kinds: ["judgment"], limit: 30 })) if (h.judgment) candidates.set(h.judgment.id, h.judgment); } catch { /* scan below */ }
  }
  for (const j of listJudgments({ limit: 500 }).items) candidates.set(j.id, j);
  candidates.delete(targetId);
  const citing: CitingRef[] = [];
  let checked = 0;
  for (const j of candidates.values()) {
    if (!keys.size) break;
    const v = judgmentView(j);
    if (!judgmentVisible(v, allowed)) continue;
    const text = judgmentText(j.id);
    if (!text) continue;
    checked++;
    const found = [...citedKeys(j.id, text)].find((k) => keys.has(k));
    if (!found) continue;
    const at = text.indexOf(found);
    const ctx = at >= 0 ? text.slice(Math.max(0, at - 400), Math.min(text.length, at + 400)).replace(/\s+/g, " ").trim() : "";
    const phrase = INDIAN_NEGATIVE_PHRASES.find((p) => new RegExp(`\\b${p.replace(/\s+/g, "\\s+")}\\b`, "i").test(ctx));
    citing.push({ id: v.id, source: v.source, title: judgmentTitleLine(v), court: v.court?.name, decided: v.decisionDate, context: ctx.slice(0, 600), phrase, benchStrength: v.benchStrength });
    if (citing.length >= limit) break;
  }
  const own = judgmentText(targetId);
  const cited = own ? [...citedKeys(targetId, own)].filter((k) => !keys.has(k)).slice(0, 30).map((raw) => { const r = resolveIndianCitation(raw); return { raw, resolvedId: r.state === "resolved" ? r.id : undefined, state: r.state }; }) : [];
  return { target, citing, cited, checked };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

function emit(ctx: ToolContext, ev: EvidenceProvenance[]) { if (ev.length) ctx.emit({ type: "evidence", evidence: ev }); }

const JUDGMENT_FILTER_PROPS = {
  courts: { type: "array", items: { type: "string" }, description: "Registry court ids: sci, hc-karnataka, hc-telangana, hc-andhra, hc-bombay, hc-madras, hc-delhi…" },
  bench: { type: "string", description: "Bench id or city, e.g. kar-dharwad or Kalaburagi" },
  year_from: { type: "integer" },
  year_to: { type: "integer" },
  judge: { type: "string" },
  case_type: { type: "string", description: "e.g. W.P., Crl.P., RSA, SLP (Crl)" },
  statute: { type: "string", description: "Normalized Act and section, e.g. 'BNSS 2023 s.483' or 'IPC 1860 s.302'" },
  language: { type: "string", description: "Language code of the text of record or a translation: en, hi, kn, te, ta, mr, ur…" },
  min_bench: { type: "integer", description: "Minimum bench strength (2 = division bench)" },
};

type JudgmentArgs = { query: string; courts?: string[]; bench?: string; year_from?: number; year_to?: number; judge?: string; case_type?: string; statute?: string; language?: string; min_bench?: number; limit?: number };

export const searchJudgmentsTool = defineTool<JudgmentArgs>({
  name: "search_judgments",
  description: "Search the ingested corpus of Supreme Court of India and High Court judgments. Filters: court, bench, year range, judge, case type, statute, language, minimum bench strength. Returns focused search_result blocks with stable sources (judgment://<courtId>/<judgmentId>), neutral and reporter citations, bench strength and decision date. A hit proves the judgment exists, not that it supports a proposition — read it (read_judgment) before characterizing it.",
  parameters: { type: "object", properties: { query: { type: "string" }, ...JUDGMENT_FILTER_PROPS, limit: { type: "integer", description: "Default 8, max 25" } }, required: ["query"] },
  examples: [{ query: "anticipatory bail economic offences parity", courts: ["sci", "hc-karnataka"], year_from: 2015, limit: 8 }, { query: "Order XXXIX Rule 1 temporary injunction prima facie", courts: ["hc-telangana"], min_bench: 2 }],
  timeoutMs: 20_000,
  maxResultChars: 24_000,
  access: "read",
  label: (a) => `Searching judgments: ${a.query}`,
  async execute(args, ctx) {
    const allowed = visibleMatters(ctx);
    const filters: JudgmentFilters = { courts: args.courts, bench: args.bench, yearFrom: args.year_from, yearTo: args.year_to, judge: args.judge, caseType: args.case_type, statute: args.statute, language: args.language, minBench: args.min_bench };
    const hits = await searchJudgments(args.query, filters, { limit: args.limit, allowed });
    const retrievedAt = new Date().toISOString();
    emit(ctx, hits.map((h, i) => ({ source: h.view.source, kind: "opinion", provider: h.view.provider, tool: "search_judgments", query: args.query, rank: i + 1, score: h.score, documentId: h.view.id, authorityId: h.view.neutralCitation ?? h.view.reporterCitations[0], url: h.view.url, page: h.page, hash: contentHash(h.passage), retrievedAt })));
    return { count: hits.length, results: hits.map((h) => judgmentRow(h)), ...(hits.length ? {} : { note: "No judgment in the corpus matched; broaden the query or the filters. Do not cite authority that was not found." }) };
  },
});

export const readJudgmentTool = defineTool<{ id: string; start_paragraph?: number; count?: number }>({
  name: "read_judgment",
  description: "Read a judgment from the corpus by id, in numbered paragraph windows (¶1, ¶2 … — the numbering pinpoint cites use), each with its stable source (judgment://<courtId>/<id>/para/<n>), the judgment's own paragraph number where printed and the PDF page where the page map is known. The original-language text is the text of record.",
  parameters: { type: "object", properties: { id: { type: "string" }, start_paragraph: { type: "integer", description: "1-based, default 1" }, count: { type: "integer", description: "Default 40, max 100" } }, required: ["id"] },
  examples: [{ id: "ijdg_8f2a61c0d9e4b7a35c10", start_paragraph: 1, count: 40 }],
  timeoutMs: 20_000,
  maxResultChars: 36_000,
  access: "read",
  label: (a) => `Reading judgment ${a.id}${a.start_paragraph ? ` from ¶${a.start_paragraph}` : ""}`,
  execute(args, ctx) {
    const { view, text } = readJudgment(args.id, visibleMatters(ctx));
    const paras = judgmentParagraphs(view, text);
    const start = Math.max(1, Math.floor(args.start_paragraph ?? 1));
    const n = Math.min(Math.max(1, Math.floor(args.count ?? 40)), 100);
    const slice = paras.slice(start - 1, start - 1 + n);
    emit(ctx, [{ source: view.source, kind: "opinion", provider: view.provider, tool: "read_judgment", rank: 1, documentId: view.id, authorityId: view.neutralCitation ?? view.reporterCitations[0], url: view.url, hash: contentHash(text), retrievedAt: new Date().toISOString() }]);
    return {
      type: "search_result" as const,
      source: view.source,
      title: judgmentTitleLine(view),
      content: slice.map((p) => `¶${p.n}${p.judgmentPara ? ` [para ${p.judgmentPara}]` : ""}${p.page ? ` [p. ${p.page}]` : ""} ${p.text.length > 3000 ? p.text.slice(0, 3000) + " …" : p.text}`),
      id: view.id,
      language: view.language,
      translations: view.translations,
      bench_strength: view.benchStrength,
      judges: view.judges,
      total_paragraphs: paras.length,
      paragraphs: slice.map((p) => ({ n: p.n, source: p.source, page: p.page, judgment_para: p.judgmentPara })),
      next_start: start - 1 + n < paras.length ? start + n : null,
    };
  },
});

export const searchStatutesIndiaTool = defineTool<{ query: string; enactment?: string; limit?: number }>({
  name: "search_statutes",
  description: "Search India Code enactments and sections in the store (central and state Acts: BNS, BNSS, BSA, IPC, CrPC, Evidence Act, CPC, Specific Relief Act, Karnataka / Telangana / Andhra Pradesh Acts…). Returns sections with stable sources (statute://<enactmentId>/s/<n>) and ids for read_section. The old criminal codes still govern offences committed before 1 July 2024; use map_criminal_section for the correspondence. This store holds a curated set of Acts; for any other Central, State or regulator instrument use search_law / list_law_instruments (the full statutes corpus) when available.",
  parameters: { type: "object", properties: { query: { type: "string" }, enactment: { type: "string", description: "Restrict to an Act (title words), e.g. 'Bharatiya Nagarik Suraksha Sanhita'" }, limit: { type: "integer", description: "Default 8, max 25" } }, required: ["query"] },
  examples: [{ query: "anticipatory bail", enactment: "Bharatiya Nagarik Suraksha Sanhita" }, { query: "section 138 dishonour of cheque" }],
  timeoutMs: 15_000,
  maxResultChars: 20_000,
  access: "read",
  label: (a) => `Searching India Code: ${a.query}`,
  async execute(args, ctx) {
    const rows = await searchStatuteSections(args.query, { enactment: args.enactment, limit: args.limit });
    const retrievedAt = new Date().toISOString();
    emit(ctx, rows.map((r, i) => ({ source: r.source, kind: "statute", provider: "india-code", tool: "search_statutes", query: args.query, rank: i + 1, authorityId: `${r.enactment} s. ${r.section}`, url: r.url, hash: contentHash(r.text), retrievedAt })));
    return { count: rows.length, results: rows.map((r) => statuteRow(r)) };
  },
});

/** Model-facing row for a section (also the shape the research engine normalizes). */
export function statuteRow(r: StatuteSectionView) {
  return { type: "search_result" as const, source: r.source, title: `${r.enactment}${r.section ? `, s. ${r.section}` : ""}${r.heading ? ` — ${r.heading}` : ""}`, content: [r.text.slice(0, 900)], id: r.id, enactment: r.enactment, section: r.section, heading: r.heading, year: r.year, url: r.url, replaced_by: r.replacedBy, in_force_from: r.inForceFrom };
}

export const readSectionTool = defineTool<{ id: string }>({
  name: "read_section",
  description: "Read one India Code section in full by id (from search_statutes, '<enactmentId>:<section>'), with its stable source and, where recorded, the corresponding section in the successor code. An absent section is reported absent, never the nearest one. For sections found by search_law use read_law_section.",
  parameters: { type: "object", properties: { id: { type: "string", description: "Section id from search_statutes: '<enactmentId>:<section>'" } }, required: ["id"] },
  examples: [{ id: "ienact_5d0c2e7a9b41f3c8a6e1:482" }],
  timeoutMs: 10_000,
  maxResultChars: 24_000,
  access: "read",
  label: (a) => `Reading section ${a.id}`,
  execute(args, ctx) {
    const r = readStatuteSection(args.id);
    if (!r) throw new Error(`No India Code section ${args.id} in the store; use an id returned by search_statutes.`);
    emit(ctx, [{ source: r.source, kind: "statute", provider: "india-code", tool: "read_section", rank: 1, authorityId: `${r.enactment} s. ${r.section}`, url: r.url, hash: contentHash(r.text), retrievedAt: new Date().toISOString() }]);
    return { type: "search_result" as const, source: r.source, title: `${r.enactment}, s. ${r.section}${r.heading ? ` — ${r.heading}` : ""}`, content: r.text.split(/\n+/).map((s) => s.trim()).filter(Boolean), id: r.id, replaced_by: r.replacedBy, corresponds_to: r.correspondsTo, url: r.url };
  },
});

export const mapCriminalSectionTool = defineTool<{ code: string; section: string; offence_date?: string; proceeding_initiated?: string }>({
  name: "map_criminal_section",
  description: "Map a section between the old and new criminal codes (IPC↔BNS, CrPC↔BNSS, Evidence Act↔BSA) from the coded correspondence table and say which code governs: the date of the offence decides IPC vs BNS (new codes from 1 July 2024); the date the proceeding was initiated decides CrPC vs BNSS and IEA vs BSA (savings clauses). Every candidate is returned (a split stays a split); an unknown section is 'unmapped'; a missing or boundary-spanning date is 'requires_review'. Report those statuses as they are.",
  parameters: { type: "object", properties: { code: { type: "string", description: "IPC, BNS, CrPC, BNSS, IEA or BSA" }, section: { type: "string", description: "e.g. 420, 498A, 438, 65B" }, offence_date: { type: "string", description: "YYYY-MM-DD" }, proceeding_initiated: { type: "string", description: "YYYY-MM-DD, for procedure and evidence" } }, required: ["code", "section"] },
  examples: [{ code: "IPC", section: "420", offence_date: "2024-03-15" }, { code: "BNSS", section: "482", proceeding_initiated: "2024-09-02" }],
  timeoutMs: 2_000,
  access: "read",
  label: (a) => `Mapping ${a.code} s. ${a.section}`,
  execute(args) { return mapCriminalSection({ code: args.code, section: args.section, offenceDate: args.offence_date, proceedingInitiated: args.proceeding_initiated }); },
});

export const citingReferencesTool = defineTool<{ id: string; limit?: number }>({
  name: "citing_references",
  description: "For a judgment in the corpus, list later judgments in the corpus that cite it (with the citing passage and any negative-treatment language such as overruled, per incuriam, doubted, referred to a larger bench), and what it cites. A signal to REVIEW, not a citator: absence of negative language does not establish that a judgment is good law, and the corpus holds only what has been ingested.",
  parameters: { type: "object", properties: { id: { type: "string" }, limit: { type: "integer", description: "Default 10, max 25" } }, required: ["id"] },
  examples: [{ id: "ijdg_8f2a61c0d9e4b7a35c10" }],
  timeoutMs: 20_000,
  maxResultChars: 24_000,
  access: "read",
  label: (a) => `Checking citing judgments for ${a.id}`,
  async execute(args, ctx) {
    const r = await citingReferences(args.id, visibleMatters(ctx), { limit: args.limit });
    return {
      id: r.target.id,
      source: r.target.source,
      title: judgmentTitleLine(r.target),
      checked: r.checked,
      citing: r.citing.map((c) => ({ type: "search_result" as const, source: c.source, title: c.title, content: [c.context || "(cites the judgment)"], negative_language: c.phrase ?? null })),
      cites: r.cited,
      note: r.citing.some((c) => c.phrase) ? "Possibly negative treatment in the corpus: read the citing passages before relying on the judgment." : "No negative-treatment language found in the corpus. This is not a citator result; treatment is only as complete as the corpus.",
    };
  },
});

export const indianKanoonSearchTool = defineTool<{ query: string; page?: number; doctypes?: string }>({
  name: "indian_kanoon_search",
  description: "Live search on Indian Kanoon (firm API token). Returns documents with titles, courts (resolved from the exact docsource name; otherwise unresolved), dates, headlines and stable sources (authority://indiankanoon/doc/<tid>). Use for authority missing from the local corpus; read with indian_kanoon_doc before characterizing.",
  parameters: { type: "object", properties: { query: { type: "string" }, page: { type: "integer", description: "0-based page, default 0" }, doctypes: { type: "string", description: "e.g. supremecourt, karnataka, andhra, highcourts" } }, required: ["query"] },
  examples: [{ query: "anticipatory bail economic offence parity", doctypes: "supremecourt" }],
  timeoutMs: 20_000,
  maxResultChars: 20_000,
  access: "read",
  label: (a) => `Searching Indian Kanoon: ${a.query}`,
  async execute(args, ctx) {
    const ik = indianKanoonClient();
    if (!ik) throw new Error("Indian Kanoon is not configured (the connector is not ready).");
    const data = await ik.search({ formInput: `${args.query}${args.doctypes ? ` doctypes: ${args.doctypes}` : ""}`, pagenum: args.page, signal: ctx.signal });
    const docs = data.docs.slice(0, 15);
    const retrievedAt = new Date().toISOString();
    emit(ctx, docs.map((d, i) => ({ source: ikSource(d.tid), kind: "opinion", provider: "indian-kanoon", tool: "indian_kanoon_search", query: args.query, rank: i + 1, authorityId: String(d.tid), url: ik.webUrl(d.tid), retrievedAt })));
    return {
      found: data.found,
      results: docs.map((d) => {
        const date = typeof d.publishdate === "string" ? d.publishdate.slice(0, 10) : undefined;
        const { court, unresolved } = courtForDocsource(d.docsource, date);
        return { type: "search_result" as const, source: ikSource(d.tid), title: `${htmlToText(d.title ?? "").text} (${court?.shortName ?? unresolved ?? "court not resolved"}${date ? `, ${date}` : ""})`, content: [htmlToText(d.headline ?? "").text.slice(0, 600)], tid: d.tid, court_id: court?.id ?? null, citation: d.citation };
      }),
    };
  },
});

export const indianKanoonDocTool = defineTool<{ tid: number; start_paragraph?: number; count?: number }>({
  name: "indian_kanoon_doc",
  description: "Read an Indian Kanoon document by tid (firm API token) in numbered paragraph windows with stable sources (authority://indiankanoon/doc/<tid>/para/<n>).",
  parameters: { type: "object", properties: { tid: { type: "integer" }, start_paragraph: { type: "integer" }, count: { type: "integer", description: "Default 40, max 100" } }, required: ["tid"] },
  examples: [{ tid: 1712542 }],
  timeoutMs: 25_000,
  maxResultChars: 36_000,
  access: "read",
  label: (a) => `Reading Indian Kanoon ${a.tid}`,
  async execute(args, ctx) {
    const ik = indianKanoonClient();
    if (!ik) throw new Error("Indian Kanoon is not configured (the connector is not ready).");
    const data = await ik.doc(Math.floor(args.tid), { signal: ctx.signal });
    const text = htmlToText(data.doc ?? "", { maxChars: 1_000_000 }).text;
    const paras = text.split(/\n+/).map((s) => s.trim()).filter(Boolean);
    const start = Math.max(1, Math.floor(args.start_paragraph ?? 1));
    const n = Math.min(Math.max(1, Math.floor(args.count ?? 40)), 100);
    emit(ctx, [{ source: ikSource(args.tid), kind: "opinion", provider: "indian-kanoon", tool: "indian_kanoon_doc", rank: 1, authorityId: String(args.tid), url: ik.webUrl(args.tid), hash: contentHash(text), retrievedAt: new Date().toISOString() }]);
    return { type: "search_result" as const, source: ikSource(args.tid), title: htmlToText(data.title ?? "").text, content: paras.slice(start - 1, start - 1 + n).map((p, i) => `¶${start + i} ${p}`), total_paragraphs: paras.length, next_start: start - 1 + n < paras.length ? start + n : null };
  },
});

/** Official Indian legal hosts the research fetch tool may read without open-web scope (no subscription services). */
export const INDIA_FETCH_ALLOWLIST = [
  "indiacode.nic.in", "sci.gov.in", "main.sci.gov.in", "ecourts.gov.in", "judgments.ecourts.gov.in", "services.ecourts.gov.in", "egazette.gov.in", "egazette.nic.in", "legislative.gov.in", "lawmin.gov.in",
  "karnatakajudiciary.kar.nic.in", "judiciary.karnataka.gov.in", "tshc.gov.in", "aphc.gov.in", "dpal.kar.nic.in", "mha.gov.in", "rbi.org.in", "sebi.gov.in", "incometaxindia.gov.in", "cbic-gst.gov.in", "prsindia.org",
];

/** Whether a URL's host is an allowlisted official Indian legal source (exact host or subdomain). */
export function isIndianLegalFetchHost(url: string, allow: string[] = INDIA_FETCH_ALLOWLIST): boolean {
  let host = "";
  try { const u = new URL(url); if (u.protocol !== "https:" && u.protocol !== "http:") return false; host = u.hostname.toLowerCase(); } catch { return false; }
  return allow.some((d) => host === d || host.endsWith(`.${d}`));
}

type CorpusIndexArgs = { query: string; courts?: string[]; year_from?: number; year_to?: number; judge?: string; limit?: number };

export const searchJudgmentIndexTool = defineTool<CorpusIndexArgs>({
  name: "search_judgment_index",
  description: "Search the official judgment index: every Supreme Court of India and High Court judgment backfilled from the court-published open datasets (metadata: title, parties, case number, CNR, neutral/SCR citation, coram, decision date, disposal, the source snippet, and the link to the original PDF). Exact CNR, neutral citation or case number resolves directly. Each result's source is corpus://judgment/<id>. The index holds metadata and the published snippet, not the full judgment text: open the PDF link (fetch) or read_judgment when the judgment is also in the full-text corpus before characterising a holding.",
  parameters: { type: "object", properties: { query: { type: "string", description: "Words, a party name, a CNR (e.g. KAHC020100052022), a neutral citation (2024 INSC 735, 2024:KHC-D:7336) or a case number (WP/98/2024)" }, courts: { type: "array", items: { type: "string" }, description: "Registry court ids: sci, hc-karnataka, hc-telangana, hc-andhra, hc-bombay, hc-madras, hc-delhi…" }, year_from: { type: "integer" }, year_to: { type: "integer" }, judge: { type: "string" }, limit: { type: "integer", description: "Default 10, max 25" } }, required: ["query"] },
  examples: [{ query: "land acquisition compensation enhancement", courts: ["hc-karnataka"], year_from: 2020, limit: 10 }, { query: "KAHC020100052022" }],
  timeoutMs: 20_000,
  maxResultChars: 24_000,
  access: "read",
  label: (a) => `Searching the judgment index: ${a.query}`,
  async execute(args, ctx) {
    const { searchCorpus } = await import("@/modules/india/corpus/search");
    const { hits } = await searchCorpus({ q: args.query, courts: args.courts, yearFrom: args.year_from, yearTo: args.year_to, judge: args.judge, limit: Math.min(args.limit ?? 10, 25) });
    const retrievedAt = new Date().toISOString();
    emit(ctx, hits.map((h, i) => ({ source: `corpus://judgment/${h.id}`, kind: "opinion", provider: h.source, tool: "search_judgment_index", query: args.query, rank: i + 1, score: h.rank, documentId: h.id, authorityId: h.neutral_citation ?? h.reporter_citation ?? h.cnr ?? undefined, url: h.pdf_url ?? undefined, hash: contentHash(`${h.id}|${h.title}|${h.snippet ?? ""}`), retrievedAt })));
    return {
      count: hits.length,
      results: hits.map((h) => ({
        type: "search_result" as const,
        source: `corpus://judgment/${h.id}`,
        title: `${h.title}${h.neutral_citation ? `, ${h.neutral_citation}` : h.reporter_citation ? `, ${h.reporter_citation}` : ""} (${h.court ?? h.court_code ?? "court unresolved"}${h.decision_date ? `, ${h.decision_date}` : ""})`,
        content: [h.snippet ? h.snippet.slice(0, 1200) : "(no snippet published in the source metadata)"],
        id: h.id, match: h.match, court: h.court, court_id: h.court_id, bench: h.bench_code, decided: h.decision_date, case_number: h.case_number, cnr: h.cnr,
        neutral_citation: h.neutral_citation, reporter_citation: h.reporter_citation, judges: h.judges, disposal: h.disposal, pdf_url: h.pdf_url,
        text: h.text_status === "none" ? "metadata and published snippet only; full text not ingested" : h.text_status, issues: h.issues ?? undefined,
      })),
      ...(hits.length ? {} : { note: "No judgment in the index matched. Broaden the query or filters; do not cite authority that was not found." }),
    };
  },
});

// ---------------------------------------------------------------------------
// Indian law corpus (Postgres: Open India Law parse of India Code and regulator publications)
// ---------------------------------------------------------------------------

const LAW_FILTER_PROPS = {
  jurisdiction: { type: "string", enum: ["central", "state", "regulator"], description: "central (Parliament), state (State / UT legislation) or regulator (SEBI, RBI, MCA, CBIC, IRDAI, TRAI…)" },
  state: { type: "string", description: "Two-letter State / UT code for State legislation: KA, TS, AP, MH, DL, TN, KL, WB, UP, GJ…" },
  regulator: { type: "string", description: "Regulator id: sebi, rbi, mca, cbic, irdai, trai, dgft, cpcb, dfs, moefcc, law-commission, state-gst" },
  act_id: { type: "string", description: "Restrict to one instrument id from list_law_instruments or an earlier result (e.g. IND_central_20062)" },
  in_force: { type: "boolean", description: "Only instruments recorded as in force (default false: repealed and superseded instruments are included and labelled)" },
};

const LAW_NOTE = "Open India Law (Vaquill) parse, CC BY 4.0 — third-party; verify against the official text at source_url before relying on it.";

type LawSearchArgs = { query: string; jurisdiction?: string; state?: string; regulator?: string; act_id?: string; in_force?: boolean; limit?: number };

/** Model-facing row for a law-corpus section hit (also the research lane's shape). */
export function lawSectionRow(h: import("@/modules/law/shared").LawProvisionHit) {
  const cite = lawCitation({ kind: h.kind, title: h.actTitle, year: h.year }, h.section, h.variant);
  return {
    type: "search_result" as const,
    source: lawSourceId(h.actId, h.section, h.variant),
    title: `${cite}${h.heading ? ` — ${h.heading}` : ""}`,
    content: [h.snippet.replace(/[«»]/g, "").slice(0, 900) || "(no text excerpt)"],
    act_id: h.actId, section: h.section, variant: h.variant, act: h.actTitle, jurisdiction: jurisdictionLabel(h), year: h.year,
    status: statusLabel(h.instrumentStatus), provision_in_force: h.in_force, source_url: h.source_url, dataset_version: h.dataset_version,
  };
}

export const searchLawTool = defineTool<LawSearchArgs>({
  name: "search_law",
  description: "Search the full Indian statutes and regulations corpus (about 20,000 instruments: every Central Act incl. repealed ones, State and UT Acts, and SEBI / RBI / MCA / CBIC / IRDAI / TRAI and other regulator regulations), section by section. Returns sections as search_result blocks with stable sources (law://<actId>/s/<section>[~<variant>]), the instrument's status (in force / repealed / superseded) and its official publisher URL. A hit shows words in a provision; read it with read_law_section before characterising it. The text is a third-party parse, not the official text.",
  parameters: { type: "object", properties: { query: { type: "string", description: "Words or a quoted phrase, e.g. \"anticipatory bail\" or eviction of tenant arrears of rent" }, ...LAW_FILTER_PROPS, limit: { type: "integer", description: "Default 10, max 25" } }, required: ["query"] },
  examples: [{ query: "eviction arrears of rent", jurisdiction: "state", state: "KA", in_force: true, limit: 10 }, { query: "\"related party transaction\" approval", jurisdiction: "regulator", regulator: "sebi" }],
  timeoutMs: 20_000,
  maxResultChars: 24_000,
  access: "read",
  label: (a) => `Searching statutes: ${a.query}`,
  async execute(args, ctx) {
    const { searchProvisions } = await import("@/modules/india/law/search");
    const { hits, broadened } = await searchProvisions({ q: args.query, jurisdiction: args.jurisdiction, state: args.state, regulator: args.regulator, actId: args.act_id, inForceOnly: Boolean(args.in_force), excludeReports: args.regulator !== "law-commission", limit: Math.min(Math.max(1, args.limit ?? 10), 25) });
    const retrievedAt = new Date().toISOString();
    emit(ctx, hits.map((h, i) => ({ source: lawSourceId(h.actId, h.section, h.variant), kind: "statute", provider: "open-india-law", tool: "search_law", query: args.query, rank: i + 1, score: h.rank, documentId: h.actId, authorityId: lawCitation({ kind: h.kind, title: h.actTitle, year: h.year }, h.section, h.variant), url: h.source_url ?? undefined, hash: contentHash(`${h.actId}|${h.section}|${h.variant}|${h.snippet}`), retrievedAt })));
    return { count: hits.length, results: hits.map(lawSectionRow), note: hits.length ? (broadened ? `No provision contained every word; these match some of the words. ${LAW_NOTE}` : LAW_NOTE) : "No provision in the statutes corpus matched. Broaden the words or filters; do not cite a provision that was not found." };
  },
});

export const readLawSectionTool = defineTool<{ act_id: string; section: string; variant?: number; max_chars?: number }>({
  name: "read_law_section",
  description: "Read one section of an Act or regulation from the statutes corpus, exactly by instrument id and section number as printed (\"303\", \"10A\"; \"_\" for the preamble and unnumbered text). Returns the full section text, its chapter, the instrument's status, the official publisher URL and the citation. An absent section is an error — never the nearest section. variant > 0 reads a second provision printed with the same number (search results say when one exists).",
  parameters: { type: "object", properties: { act_id: { type: "string", description: "Instrument id, e.g. IND_central_20062" }, section: { type: "string", description: "Section number as printed, e.g. 303, 10A" }, variant: { type: "integer", description: "Default 0" }, max_chars: { type: "integer", description: "Default 20000, max 60000" } }, required: ["act_id", "section"] },
  examples: [{ act_id: "IND_central_20062", section: "303" }],
  timeoutMs: 15_000,
  maxResultChars: 64_000,
  access: "read",
  label: (a) => `Reading section ${a.section}`,
  async execute(args, ctx) {
    const { readProvisionText } = await import("@/modules/india/law/directory");
    const r = await readProvisionText(args.act_id, args.section, args.variant ?? 0, Math.min(Math.max(1000, args.max_chars ?? 20_000), 60_000));
    if (!r) throw new Error(`No section ${args.section}${args.variant ? ` (variant ${args.variant})` : ""} in instrument ${args.act_id} in the statutes corpus. It is not substituted with another section; check the id and number with search_law or list_law_instruments.`);
    const source = lawSourceId(r.instrument.id, r.section.section, r.section.variant);
    emit(ctx, [{ source, kind: "statute", provider: "open-india-law", tool: "read_law_section", rank: 1, documentId: r.instrument.id, authorityId: r.citation, url: r.section.source_url ?? r.instrument.source_url ?? undefined, hash: contentHash(r.section.text), retrievedAt: new Date().toISOString() }]);
    return {
      type: "search_result" as const,
      source,
      title: `${r.citation}${r.section.heading ? ` — ${r.section.heading}` : ""}`,
      content: r.text.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean),
      citation: r.citation,
      act_id: r.instrument.id, act: r.instrument.title, section: r.section.section, variant: r.section.variant, chapter: r.section.chapter_title,
      status: statusLabel(r.instrument.status), provision_in_force: r.section.in_force, other_variants: r.variants,
      official_source: r.section.source_url ?? r.instrument.source_url, publisher: publisherLabel(r.instrument), dataset_version: r.instrument.dataset_version,
      truncated: r.section.truncated, note: LAW_NOTE,
    };
  },
});

export const listLawInstrumentsTool = defineTool<{ query: string; jurisdiction?: string; state?: string; regulator?: string; kind?: string; in_force?: boolean; limit?: number }>({
  name: "list_law_instruments",
  description: "Find Acts and regulations in the statutes corpus by title (e.g. \"Karnataka Rent Act\", \"SEBI Listing Obligations\"), State or regulator. Returns instrument ids for read_law_section and search_law (act_id), with jurisdiction, year, status (in force / repealed / superseded), section count and the official publisher URL.",
  parameters: { type: "object", properties: { query: { type: "string" }, jurisdiction: LAW_FILTER_PROPS.jurisdiction, state: LAW_FILTER_PROPS.state, regulator: LAW_FILTER_PROPS.regulator, kind: { type: "string", enum: ["act", "regulation"] }, in_force: LAW_FILTER_PROPS.in_force, limit: { type: "integer", description: "Default 10, max 25" } }, required: ["query"] },
  examples: [{ query: "Karnataka Rent Act", jurisdiction: "state", state: "KA" }, { query: "Bharatiya Nyaya Sanhita" }],
  timeoutMs: 15_000,
  maxResultChars: 16_000,
  access: "read",
  label: (a) => `Finding statutes: ${a.query}`,
  async execute(args) {
    const { searchInstruments } = await import("@/modules/india/law/search");
    const r = await searchInstruments({ q: args.query, jurisdiction: args.jurisdiction, state: args.state, regulator: args.regulator, kind: args.kind, inForceOnly: Boolean(args.in_force), limit: Math.min(Math.max(1, args.limit ?? 10), 25) });
    return {
      count: r.hits.length,
      results: r.hits.map((i) => ({ act_id: i.id, source: lawSourceId(i.id), title: i.title, kind: i.kind, jurisdiction: jurisdictionLabel(i), year: i.year, status: statusLabel(i.status), sections: i.sections, official_source: i.source_url, publisher: publisherLabel(i) })),
      ...(r.hits.length ? {} : { note: "No instrument in the statutes corpus matched this title. Try fewer words or another filter; do not assume the instrument does not exist." }),
    };
  },
});

/** Tools that exist only with a capability (fail closed: absent from the toolset without it). */
export const INDIAN_KANOON_TOOLS = [indianKanoonSearchTool, indianKanoonDocTool];
export const CORPUS_INDEX_TOOLS = [searchJudgmentIndexTool, ...JUDGMENT_TEXT_TOOLS];
/** The statutes corpus (law_* tables in the same Postgres); errors explicitly when the tables are not loaded yet. */
export const LAW_CORPUS_TOOLS = [searchLawTool, readLawSectionTool, listLawInstrumentsTool];

/** Always-available Indian research tools (local corpus, India Code, coded tables). */
export const INDIA_CORE_TOOLS = [searchJudgmentsTool, readJudgmentTool, citingReferencesTool, searchStatutesIndiaTool, readSectionTool, mapCriminalSectionTool];

/** Indian research toolset for the current capabilities. */
import { getForumInfoTool } from "./india-forums";
export function indiaResearchTools(caps: IndiaCapabilities = indiaCapabilities()) {
  return [...INDIA_CORE_TOOLS, ...(caps.corpus ? [...CORPUS_INDEX_TOOLS, ...LAW_CORPUS_TOOLS] : []), ...(caps.indianKanoon ? INDIAN_KANOON_TOOLS : []), getForumInfoTool];
}

/** Every Indian tool (for contract tests); runtime toolsets use indiaResearchTools(). */
export const INDIA_TOOLS = [...INDIA_CORE_TOOLS, ...CORPUS_INDEX_TOOLS, ...LAW_CORPUS_TOOLS, ...INDIAN_KANOON_TOOLS];

/** Intel documents that belong to the India source layer (judgments and India Code Acts); other feeds must not duplicate them. */
export function isIndiaSourceDoc(doc: { meta?: Record<string, unknown> } | null | undefined): boolean {
  return Boolean(doc && (doc.meta as Meta | undefined)?.india === true);
}

/** Raw text of an intel document (used where the source layer has no record). */
export function intelText(id: string): string | null {
  return getDocumentText(id);
}
