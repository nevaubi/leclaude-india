import "server-only";
import { remoteStore, type RemoteStore, type Row } from "@/lib/db/remote";
import { courtById } from "@/lib/india/courts";
import { isSourceId, SOURCE_IDS, type SourceId } from "@/modules/official/types";

/**
 * What the Indian law corpus in Postgres actually holds, for prompts (research planner, lanes, chat, personas) so the
 * models pick the strong tool for the material that exists: per court, judgment metadata records and judgments with
 * full text (with year ranges), and the statutes corpus by jurisdiction.
 *
 * Read-only and bounded: a handful of aggregate queries, cached for 10 minutes; when a refresh fails the last good
 * summary is served (marked stale); with no database the summary says so (never invented numbers).
 */

export const COVERAGE_TTL_MS = 10 * 60_000;
/** Wall budget for one refresh (aggregates over ~2M text chunks); a slow refresh serves the stale summary. */
const REFRESH_TIMEOUT_MS = 12_000;

export interface CourtCoverage { courtId: string; label: string; count: number; from: number | null; to: number | null }
export interface StatuteCoverage {
  instruments: number;
  provisions: number;
  central: number;
  state: number;
  /** Distinct State / UT codes with State legislation. */
  states: number;
  regulator: number;
  /** Distinct regulators. */
  regulators: number;
  /** Law Commission and similar reports (kind = report; context, not law). */
  reports: number;
}

/** Indexed official publications per source (official_documents), for the official-sources tools. */
export interface OfficialCoverage { sourceId: SourceId; label: string; count: number; latest: string | null }

export interface CorpusCoverage {
  /** A database is configured on this deployment. */
  configured: boolean;
  /** Judgment metadata records per court (search_judgment_index). Empty when the table is absent. */
  judgments: CourtCoverage[];
  /** Judgments with full text per court (search_judgment_text / read_judgment_text). */
  texts: CourtCoverage[];
  statutes: StatuteCoverage | null;
  /** Indexed official documents per source; null when the official_documents table is absent (not loaded yet). */
  official?: OfficialCoverage[] | null;
  checkedAt: string | null;
  /** True when a refresh failed and an older summary is served. */
  stale: boolean;
  /** Parts that could not be summarised (table absent, query failed). */
  missing: string[];
}

const EMPTY: CorpusCoverage = { configured: false, judgments: [], texts: [], statutes: null, official: null, checkedAt: null, stale: false, missing: [] };

/** Short publisher labels for the prompt block (registry order). */
const OFFICIAL_LABEL: Record<SourceId, string> = {
  "sci-causelist": "SC cause lists", "sci-orders": "SC judgments and orders", "sci-calendar": "SC calendar", "hc-calendars": "HC calendars",
  "dhc-causelist": "Delhi HC cause lists", nclt: "NCLT", nclat: "NCLAT", ibbi: "IBBI (incl. mirrored NCLT/NCLAT/SC IBC orders)",
  "sebi-orders": "SEBI orders (incl. SAT orders)", "sat-orders": "SAT", "cci-orders": "CCI orders", "ngt-orders": "NGT orders", egazette: "e-Gazette",
  cbic: "CBIC notifications and circulars", "gst-council": "GST Council", cbdt: "CBDT circulars and notifications", "mca-master": "MCA company records", sansad: "Parliament papers",
  rbi: "RBI notifications, master directions and master circulars", "itat-orders": "ITAT Special Bench orders", "cestat-orders": "CESTAT orders",
  aptel: "APTEL judgments", ncdrc: "NCDRC judgments", "cic-decisions": "CIC decisions", "rera-appellate": "Real Estate Appellate Tribunal orders",
  lawcommission: "Law Commission reports",
};

let cache: { at: number; value: CorpusCoverage } | null = null;
let inflight: Promise<CorpusCoverage> | null = null;

export function resetCoverageCacheForTests() { cache = null; inflight = null; }

const num = (v: string | null | undefined) => (v == null || v === "" ? 0 : Number(v));
const yr = (v: string | null | undefined) => (v == null || v === "" ? null : Number(v));
const t = (v: unknown) => String(v) === "true" || String(v) === "t";

function courtLabel(id: string | null): string {
  if (!id) return "court not resolved";
  const c = courtById(id);
  return c ? (c.id === "sci" ? "Supreme Court of India" : c.name) : id;
}

/** Supreme Court first, then the High Courts by id; null court ids last (stable order for prompt caching). */
function byCourt(a: CourtCoverage, b: CourtCoverage): number {
  const rank = (c: CourtCoverage) => (c.courtId === "sci" ? 0 : c.courtId ? 1 : 2);
  return rank(a) - rank(b) || a.courtId.localeCompare(b.courtId);
}

function rowsToCourts(rows: Row[]): CourtCoverage[] {
  return rows
    .map((r) => ({ courtId: r.court_id ?? "", label: courtLabel(r.court_id), count: num(r.n), from: yr(r.y0), to: yr(r.y1) }))
    .filter((c) => c.count > 0)
    .sort(byCourt);
}

async function compute(store: RemoteStore): Promise<CorpusCoverage> {
  const missing: string[] = [];
  const tables = await store.query({
    query: `SELECT to_regclass('public.corpus_judgments') IS NOT NULL AS j, to_regclass('public.corpus_texts') IS NOT NULL AS t,
      to_regclass('public.law_instruments') IS NOT NULL AS l, to_regclass('public.official_documents') IS NOT NULL AS o,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'corpus_texts' AND column_name = 'court_id') AS tc`,
  });
  const has = { j: t(tables[0]?.j), t: t(tables[0]?.t), l: t(tables[0]?.l), o: t(tables[0]?.o), tc: t(tables[0]?.tc) };
  const settle = <T>(name: string, ok: boolean, run: () => Promise<T>, empty: T): Promise<T> => {
    if (!ok) { missing.push(name); return Promise.resolve(empty); }
    return run().catch(() => { missing.push(name); return empty; });
  };
  const textYear = has.tc ? `coalesce(extract(year FROM decision_date)::int, substr(neutral_citation, 1, 4)::int)` : `substr(neutral_citation, 1, 4)::int`;
  // Official publications: absent before the first ingestion (null, not "missing"); a failed count is "missing".
  const officialP: Promise<OfficialCoverage[] | null> = !has.o ? Promise.resolve(null) : store.query({
    query: `SELECT source, count(*) AS n, max(doc_date)::text AS latest FROM official_documents WHERE status = 'indexed' GROUP BY source`,
  }).then((rows) => rows
    .filter((r) => isSourceId(r.source) && num(r.n) > 0)
    .map((r) => ({ sourceId: r.source as SourceId, label: OFFICIAL_LABEL[r.source as SourceId], count: num(r.n), latest: r.latest ? String(r.latest).slice(0, 10) : null }))
    .sort((a, b) => SOURCE_IDS.indexOf(a.sourceId) - SOURCE_IDS.indexOf(b.sourceId)))
    .catch(() => { missing.push("official publications"); return null; });
  const [judgments, texts, statutes, official] = await Promise.all([
    settle("judgment index", has.j, async () => rowsToCourts(await store.query({
      query: `SELECT court_id, count(*) AS n, min(year) AS y0, max(year) AS y1 FROM corpus_judgments GROUP BY court_id`,
    })), [] as CourtCoverage[]),
    settle("judgment full text", has.t, async () => rowsToCourts(await store.query({
      // One chunk 0 per judgment: counts judgments, not chunks.
      query: `SELECT ${has.tc ? "coalesce(court_id, 'sci')" : "'sci'"} AS court_id, count(*) AS n, min(${textYear}) AS y0, max(${textYear}) AS y1
        FROM corpus_texts WHERE chunk_index = 0 GROUP BY 1`,
    })), [] as CourtCoverage[]),
    settle("statutes", has.l, async (): Promise<StatuteCoverage | null> => {
      const rows = await store.query({
        query: `SELECT jurisdiction, kind, count(*) AS n, coalesce(sum(provisions), 0) AS p,
          count(DISTINCT state_code) AS states, count(DISTINCT regulator) AS regulators
          FROM law_instruments GROUP BY jurisdiction, kind`,
      });
      const s: StatuteCoverage = { instruments: 0, provisions: 0, central: 0, state: 0, states: 0, regulator: 0, regulators: 0, reports: 0 };
      for (const r of rows) {
        const n = num(r.n);
        s.instruments += n;
        s.provisions += num(r.p);
        if (r.kind === "report") { s.reports += n; continue; }
        if (r.jurisdiction === "central") s.central += n;
        else if (r.jurisdiction === "state") { s.state += n; s.states = Math.max(s.states, num(r.states)); }
        else if (r.jurisdiction === "regulator") { s.regulator += n; s.regulators = Math.max(s.regulators, num(r.regulators)); }
      }
      return s.instruments ? s : null;
    }, null),
    officialP,
  ]);
  return { configured: true, judgments, texts, statutes, official, checkedAt: new Date().toISOString(), stale: false, missing: missing.sort() };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("coverage summary timed out")), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

/**
 * The coverage summary (cached for 10 minutes; concurrent callers share one refresh). Never throws: no database →
 * `configured: false`; a failed refresh → the last good summary marked stale, else an empty summary listing what is
 * missing.
 */
export async function corpusCoverage(opts: { store?: RemoteStore | null; now?: number; timeoutMs?: number } = {}): Promise<CorpusCoverage> {
  const store = opts.store === undefined ? remoteStore() : opts.store;
  if (!store) return EMPTY;
  const now = opts.now ?? Date.now();
  if (cache && now - cache.at < COVERAGE_TTL_MS) return cache.value;
  if (!inflight) {
    inflight = withTimeout(compute(store), opts.timeoutMs ?? REFRESH_TIMEOUT_MS)
      .then((value) => { cache = { at: Date.now(), value }; return value; })
      .catch(() => {
        if (cache) { const value = { ...cache.value, stale: true }; cache = { at: Date.now() - COVERAGE_TTL_MS + 60_000, value }; return value; }
        return { ...EMPTY, configured: true, missing: ["judgment index", "judgment full text", "official publications", "statutes"] };
      })
      .finally(() => { inflight = null; });
  }
  return inflight;
}

/** 35612 → "35.6k"; 1081234 → "1.08M"; small numbers exactly (3 significant figures keeps the text stable as backfills run). */
export function approx(n: number): string {
  if (n < 1000) return String(n);
  const fmt = (v: number, unit: string) => `${Number(v.toPrecision(3))}${unit}`;
  return n < 1_000_000 ? fmt(n / 1000, "k") : fmt(n / 1_000_000, "M");
}

const years = (c: CourtCoverage) => (c.from && c.to ? (c.from === c.to ? ` (${c.from})` : ` (${c.from}–${c.to})`) : "");
const courtList = (list: CourtCoverage[], noun: string) => list.map((c) => `${c.label} ${approx(c.count)} ${noun}${years(c)}`).join("; ");

/**
 * The prompt block (well under 600 tokens; deterministic text for a given summary, so prompts stay cacheable).
 * Empty string when there is nothing to say beyond "not configured" and `includeUnconfigured` is false.
 */
export function coverageBlock(c: CorpusCoverage, opts: { includeUnconfigured?: boolean } = {}): string {
  const head = "Indian law corpus coverage (use it to choose tools; it is not evidence and is never cited):";
  if (!c.configured) {
    return opts.includeUnconfigured === false ? "" : `${head}\n- The Postgres corpus is not configured on this deployment: search_judgment_index, search_judgment_text, read_judgment_text, search_law and read_law_section are unavailable. Use the local stores (search_judgments / read_judgment, search_statutes / read_section) and say that coverage is limited.`;
  }
  const lines: string[] = [head];
  if (c.texts.length) lines.push(`- Full text with page numbers (search_judgment_text, then read_judgment_text; cite the page): ${courtList(c.texts, "judgments")}.`);
  else lines.push("- Full judgment text: not loaded.");
  if (c.judgments.length) {
    lines.push(`- Metadata only (search_judgment_index: title, parties, case number, CNR, citations, coram, date, disposal, snippet and PDF link; no text to read or quote): ${courtList(c.judgments, "records")}.`);
  } else lines.push("- Judgment metadata index: not loaded.");
  lines.push("- A court or year outside the full-text list has metadata at most: identify the judgment from the index, say its text was not read, and never characterise its holding from the snippet.");
  const s = c.statutes;
  if (s) {
    lines.push(`- Statutes (search_law / list_law_instruments, then read_law_section): ${approx(s.instruments)} instruments, ${approx(s.provisions)} provisions — Central Acts ${approx(s.central)}; State and UT Acts ${approx(s.state)} (${s.states} States/UTs); regulator instruments ${approx(s.regulator)} (${s.regulators} regulators)${s.reports ? `; Law Commission reports ${approx(s.reports)} (regulator law-commission, context only, not law)` : ""}. Repealed and superseded instruments are included and labelled.`);
  } else lines.push("- Statutes corpus: not loaded; use search_statutes / read_section (curated India Code store).");
  if (c.official?.length) {
    lines.push(`- Official publications as published (search_official_sources, then read_official_document; cite publisher, document and page; cause lists: causelist_lookup): ${c.official.map((o) => `${o.label} ${approx(o.count)}${o.latest ? ` (latest ${o.latest})` : ""}`).join("; ")}. Sources not listed are not loaded.`);
  } else if (c.official !== undefined) lines.push("- Official publications (orders, cause lists, circulars, notifications): not loaded yet; the official-sources tools return nothing.");
  if (c.stale) lines.push("- (Coverage figures are from an earlier check; the latest refresh failed.)");
  return lines.join("\n");
}

/** The block for a prompt, waiting at most `waitMs` for a refresh (never throws; "" when unavailable in time). */
export async function coveragePromptBlock(opts: { waitMs?: number; store?: RemoteStore | null } = {}): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const c = await Promise.race([
      corpusCoverage({ store: opts.store }),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), opts.waitMs ?? 2_500); }),
    ]);
    return c ? coverageBlock(c) : "";
  } catch {
    return "";
  } finally {
    if (timer) clearTimeout(timer);
  }
}
