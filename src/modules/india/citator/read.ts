import "server-only";
import { courtById } from "@/lib/india/courts";
import { getAct } from "@/lib/india/statutes";
import { remoteStore, type RemoteStore, type Row, type SqlValue } from "@/lib/db/remote";
import { getState } from "../corpus/backfill";
import { CorpusNotConfiguredError } from "../corpus/directory";
import { canonicalNeutral, findCitationMentions } from "../corpus/text";
import type { CitatorCursor } from "./build";
import { isNegativeSignal, isTreatmentSignal, SIGNAL_PRIORITY, type TreatmentSignal } from "./signals";
import { SIGNAL_NOTE, type CitatorResponse, type CitedByEntry, type CiteEntry, type GoodLawSummary, type SectionStat, type SectionStatsResponse, type StatuteEntry } from "./types";

/**
 * Read side of the citator: what a judgment cites, which corpus judgments cite it (with deterministic text cues), a
 * cautious negative-signal summary with coverage, and statute "section heat". Read-only; never creates tables.
 */

function requireStore(store: RemoteStore | null | undefined): RemoteStore {
  const s = store === undefined ? remoteStore() : store;
  if (!s) throw new CorpusNotConfiguredError();
  return s;
}

let tablesKnown: { at: number; ok: boolean } | null = null;
async function citatorTables(store: RemoteStore): Promise<boolean> {
  if (tablesKnown && Date.now() - tablesKnown.at < 5 * 60_000) return tablesKnown.ok;
  const r = await store.query({ query: `SELECT to_regclass('public.corpus_citations') IS NOT NULL AND to_regclass('public.corpus_citator_scans') IS NOT NULL AS ok` });
  const ok = String(r[0]?.ok) === "true" || String(r[0]?.ok) === "t";
  tablesKnown = { at: Date.now(), ok };
  return ok;
}

let scannedCache: { at: number; n: number; passComplete: boolean } | null = null;
async function scanCoverage(store: RemoteStore): Promise<{ n: number; passComplete: boolean }> {
  if (scannedCache && Date.now() - scannedCache.at < 5 * 60_000) return scannedCache;
  const [r, cursor] = await Promise.all([
    store.query({ query: `SELECT count(*) AS n FROM corpus_citator_scans` }),
    getState<CitatorCursor>(store, "citator_cursor").catch(() => null),
  ]);
  scannedCache = { at: Date.now(), n: Number(r[0]?.n ?? 0), passComplete: Boolean(cursor?.done) };
  return scannedCache;
}

export function resetCitatorReadCachesForTests() { tablesKnown = null; scannedCache = null; sectionCache.clear(); }

const num = (v: string | null | undefined) => (v == null || v === "" ? null : Number(v));
const courtName = (id: string | null) => (id ? courtById(id)?.name ?? id : null);
/** Supreme Court first, then High Courts, then other or unknown courts. */
export function courtRank(id: string | null): number {
  const level = id ? courtById(id)?.level : undefined;
  return level === "supreme" ? 0 : level === "high" ? 1 : level ? 2 : 3;
}
const signalRank = (s: TreatmentSignal | null) => (s ? SIGNAL_PRIORITY.indexOf(s) : SIGNAL_PRIORITY.length);
const citationOf = (r: Row) => (r.neutral_citation ? canonicalNeutral(r.neutral_citation) ?? r.neutral_citation : r.reporter_citation ?? (r.cnr ? `CNR ${r.cnr}${r.decision_date ? `, decided ${r.decision_date}` : ""}` : null));

export function sortCitedBy(a: CitedByEntry, b: CitedByEntry): number {
  return courtRank(a.courtId) - courtRank(b.courtId) || (b.decisionDate ?? "").localeCompare(a.decisionDate ?? "") || (a.citingId ?? "").localeCompare(b.citingId ?? "");
}

/**
 * Summary of negative text cues. "negative_signal" when a negative cue comes from the Supreme Court or from a bench at
 * least as large as the cited judgment's; "caution" for other negative cues; otherwise "no_negative_signal_found"
 * (not built: "not_assessed"). Always carries coverage; never says the judgment is good law.
 */
export function goodLawSummary(o: { built: boolean; negative: CitedByEntry[]; targetBench: number | null; scanned: number; passComplete: boolean }): GoodLawSummary {
  const coverage = {
    scannedJudgments: o.scanned,
    passComplete: o.passComplete,
    note: `The citator has scanned ${o.scanned.toLocaleString("en-IN")} judgment${o.scanned === 1 ? "" : "s"} with full text${o.passComplete ? "" : " (the scan is still in progress)"}. It covers only the courts and years loaded into this corpus; judgments outside it are not checked. The absence of a negative signal does not establish that a judgment is good law.`,
  };
  if (!o.built) return { status: "not_assessed", summary: "The citator has not scanned citations of this judgment yet. Later mentions are shown as text matches without any signal.", coverage };
  const strong = o.negative.filter((n) => n.courtId === "sci" || (o.targetBench != null && n.benchStrength != null && n.benchStrength >= o.targetBench));
  const word = (n: CitedByEntry) => `"${n.cue ?? n.signal}"`;
  if (strong.length) {
    const n = strong[0];
    return { status: "negative_signal", summary: `A later judgment's text uses ${word(n)} about this judgment (${n.court ?? "court not recorded"}${n.benchStrength ? `, ${n.benchStrength}-judge bench` : ""}${n.decisionDate ? `, ${n.decisionDate}` : ""}). Verify by reading that passage.`, coverage };
  }
  if (o.negative.length) {
    const n = o.negative[0];
    return { status: "caution", summary: `A later judgment's text uses ${word(n)} about this judgment (${n.court ?? "court not recorded"}${n.benchStrength ? `, ${n.benchStrength}-judge bench` : ""}). It is not from the Supreme Court or a bench of equal or greater strength; verify by reading the passage.`, coverage };
  }
  return { status: "no_negative_signal_found", summary: "No negative text cue was found in the judgments scanned. This is not confirmation that the judgment is good law.", coverage };
}

/** Citator view of one corpus judgment, or null when the id is not in the index. */
export async function citatorFor(id: string, storeArg?: RemoteStore | null): Promise<CitatorResponse | null> {
  const store = requireStore(storeArg);
  if (!id || id.length > 400) return null;
  const tr = await store.query({
    query: `SELECT id, title, court_id, bench_strength, neutral_citation, reporter_citation, cnr, decision_date::text AS decision_date FROM corpus_judgments WHERE id = $1`,
    params: [id],
  });
  const target = tr[0];
  if (!target?.id) return null;
  const targetBench = num(target.bench_strength);

  const cites: CiteEntry[] = [], statutes: StatuteEntry[] = [];
  let citedBy: CitedByEntry[] = [], built = false, scanned = 0, passComplete = false;
  if (await citatorTables(store)) {
    const [citeRows, byRows, scanRow, cov] = await Promise.all([
      store.query({
        query: `SELECT c.seq, c.kind, c.raw, c.key, c.cited_id, c.resolution, c.candidates, c.act_id, c.section, c.page, c.context, c.signal, c.cue, c.occurrences,
            j.title, j.court_id, j.decision_date::text AS decision_date
          FROM corpus_citations c LEFT JOIN corpus_judgments j ON j.id = c.cited_id
          WHERE c.citing_id = $1 ORDER BY c.seq LIMIT 1500`,
        params: [id],
      }),
      store.query({
        query: `SELECT c.citing_id, c.raw, c.page, c.context, c.signal, c.cue,
            j.title, j.court_id, j.bench_strength, j.decision_date::text AS decision_date, j.neutral_citation, j.reporter_citation, j.cnr
          FROM corpus_citations c JOIN corpus_judgments j ON j.id = c.citing_id
          WHERE c.cited_id = $1 AND c.kind = 'case' LIMIT 2000`,
        params: [id],
      }),
      store.query({ query: `SELECT citing_id FROM corpus_citator_scans WHERE citing_id = $1`, params: [id] }),
      scanCoverage(store),
    ]);
    scanned = cov.n;
    passComplete = cov.passComplete;
    built = scanRow.length > 0 || byRows.length > 0;
    for (const r of citeRows) {
      if (r.kind === "statute") {
        statutes.push({ key: r.key ?? "", raw: r.raw ?? "", actId: r.act_id, section: r.section, occurrences: num(r.occurrences) ?? 1 });
        continue;
      }
      const res = r.resolution === "resolved" || r.resolution === "ambiguous" ? r.resolution : "unresolved";
      cites.push({
        seq: num(r.seq) ?? 0, raw: r.raw ?? "", key: r.key ?? "", resolution: res, citedId: res === "resolved" ? r.cited_id : null, candidates: num(r.candidates) ?? 0,
        title: res === "resolved" ? r.title : null, courtId: res === "resolved" ? r.court_id : null, court: res === "resolved" ? courtName(r.court_id) : null,
        decisionDate: res === "resolved" ? r.decision_date : null, page: num(r.page), context: r.context, signal: isTreatmentSignal(r.signal) ? r.signal : null, cue: r.cue, occurrences: num(r.occurrences) ?? 1,
      });
    }
    // One entry per citing judgment; when it cites the judgment more than once (neutral and reporter), keep the
    // strongest cue.
    const byId = new Map<string, CitedByEntry>();
    for (const r of byRows) {
      const signal = isTreatmentSignal(r.signal) ? r.signal : null;
      const e: CitedByEntry = {
        kind: "citation", citingId: r.citing_id, title: r.title, citation: citationOf(r), courtId: r.court_id, court: courtName(r.court_id), benchStrength: num(r.bench_strength),
        decisionDate: r.decision_date, page: num(r.page), context: r.context, signal, cue: signal ? r.cue : null, signalBasis: signal ? "text_cue" : null, raw: r.raw,
      };
      const prev = byId.get(r.citing_id ?? "");
      if (!prev || signalRank(e.signal) < signalRank(prev.signal)) byId.set(r.citing_id ?? "", e);
    }
    citedBy = [...byId.values()].sort(sortCitedBy);
  }

  if (!built) {
    // Not built: fall back to text mentions of the judgment's own citations (no signal; labelled as mentions).
    const searched = [target.neutral_citation ? canonicalNeutral(target.neutral_citation) ?? target.neutral_citation : null, target.reporter_citation].filter((c): c is string => Boolean(c && c.trim()));
    const textKey = target.court_id === "sci" ? canonicalNeutral(target.neutral_citation) ?? undefined : target.cnr && target.decision_date ? `${target.cnr}@${target.decision_date}` : undefined;
    if (searched.length) {
      const m = await findCitationMentions(searched, { excludeKey: textKey, limit: 25 }, store).catch(() => ({ available: false, mentions: [], checked: 0 }));
      citedBy = m.mentions.map((x) => ({
        kind: "mention" as const, citingId: x.judgmentId, title: x.title, citation: x.citation, courtId: x.courtId, court: x.court, benchStrength: null, decisionDate: x.decisionDate,
        page: x.page, context: x.passage, signal: null, cue: null, signalBasis: null, raw: x.matched,
      })).sort(sortCitedBy);
    }
  }

  const negative = citedBy.filter((c) => isNegativeSignal(c.signal));
  return {
    id,
    status: built ? "built" : "not_built",
    cites,
    statutes,
    citedBy,
    negative,
    counts: {
      cites: cites.length, resolved: cites.filter((c) => c.resolution === "resolved").length, unresolved: cites.filter((c) => c.resolution === "unresolved").length,
      ambiguous: cites.filter((c) => c.resolution === "ambiguous").length, statutes: statutes.length, citedBy: citedBy.length, negative: negative.length,
    },
    goodLaw: goodLawSummary({ built, negative, targetBench, scanned, passComplete }),
    signalNote: SIGNAL_NOTE,
  };
}

// ---------------------------------------------------------------------------
// Section heat
// ---------------------------------------------------------------------------

export interface SectionStatsInput { act?: string | null; court?: string | null; from?: number | null; to?: number | null; limit?: number }

const sectionCache = new Map<string, { at: number; value: SectionStatsResponse }>();
const SECTION_TTL = 10 * 60_000;

/** Validate filters: an unknown Act or court is an error (never widened to "all"). */
export function parseSectionFilters(i: SectionStatsInput): { act: string | null; court: string | null; from: number | null; to: number | null; limit: number } {
  const act = i.act?.trim() || null;
  if (act && !getAct(act)) throw new RangeError(`Unknown act "${act}"`);
  const court = i.court?.trim() || null;
  if (court && !courtById(court)) throw new RangeError(`Unknown court "${court}"`);
  const year = (v: number | null | undefined) => {
    if (v == null) return null;
    if (!Number.isInteger(v) || v < 1860 || v > 2100) throw new RangeError("Years must be whole years between 1860 and 2100");
    return v;
  };
  let from = year(i.from), to = year(i.to);
  if (from != null && to != null && from > to) [from, to] = [to, from];
  const limit = i.limit != null && Number.isFinite(i.limit) ? Math.max(1, Math.min(Math.floor(i.limit), 50)) : 20;
  return { act, court, from, to, limit };
}

/** Top statute sections by the number of citing judgments (with a per-year breakdown), from the built citator. */
export async function sectionStats(input: SectionStatsInput, storeArg?: RemoteStore | null): Promise<SectionStatsResponse> {
  const store = requireStore(storeArg);
  const f = parseSectionFilters(input);
  const filters = { act: f.act, court: f.court, from: f.from, to: f.to };
  const cacheKey = JSON.stringify(f);
  const hit = sectionCache.get(cacheKey);
  if (hit && Date.now() - hit.at < SECTION_TTL) return hit.value;
  const note = "Counts are judgments in this corpus whose text cites the section (one count per judgment), found by the citation parser. They cover only the judgments scanned so far.";
  if (!(await citatorTables(store))) return { sections: [], filters, scannedJudgments: 0, note: "The citator has not been built on this deployment yet." };
  const params: SqlValue[] = [];
  const where = [`kind = 'statute'`, `act_id IS NOT NULL`, `section IS NOT NULL`];
  if (f.act) { params.push(f.act); where.push(`act_id = $${params.length}`); }
  if (f.court) { params.push(f.court); where.push(`citing_court = $${params.length}`); }
  if (f.from != null) { params.push(f.from); where.push(`citing_year >= $${params.length}`); }
  if (f.to != null) { params.push(f.to); where.push(`citing_year <= $${params.length}`); }
  const w = where.join(" AND ");
  const [top, cov] = await Promise.all([
    store.query({ query: `SELECT act_id, section, count(DISTINCT citing_id) AS n FROM corpus_citations WHERE ${w} GROUP BY act_id, section ORDER BY n DESC, act_id, section LIMIT ${f.limit}`, params }),
    scanCoverage(store),
  ]);
  let sections: SectionStat[] = top.map((r) => {
    const act = getAct(r.act_id);
    return { actId: r.act_id ?? "", act: act?.name ?? null, section: r.section ?? "", label: `${act?.abbr ?? r.act_id} ${act?.unit === "article" ? "art." : r.section?.startsWith("O.") ? "" : "s."}${r.section}`.replace(/\s+$/, ""), judgments: Number(r.n ?? 0), byYear: [] };
  });
  if (sections.length) {
    const p2: SqlValue[] = [...params, `{${sections.map((s) => `"${s.actId.replace(/["\\{}]/g, "")}"`).join(",")}}`, `{${sections.map((s) => `"${s.section.replace(/["\\{}]/g, "")}"`).join(",")}}`];
    const yearRows = await store.query({
      query: `SELECT act_id, section, citing_year AS year, count(DISTINCT citing_id) AS n FROM corpus_citations
        WHERE ${w} AND citing_year IS NOT NULL AND (act_id, section) IN (SELECT * FROM unnest($${params.length + 1}::text[], $${params.length + 2}::text[]))
        GROUP BY act_id, section, citing_year ORDER BY citing_year LIMIT 5000`,
      params: p2,
    });
    const byKey = new Map(sections.map((s) => [`${s.actId}|${s.section}`, s]));
    for (const r of yearRows) byKey.get(`${r.act_id}|${r.section}`)?.byYear.push({ year: Number(r.year), judgments: Number(r.n ?? 0) });
    sections = [...byKey.values()];
  }
  const value: SectionStatsResponse = { sections, filters, scannedJudgments: cov.n, note };
  if (sectionCache.size > 200) sectionCache.clear();
  sectionCache.set(cacheKey, { at: Date.now(), value });
  return value;
}
