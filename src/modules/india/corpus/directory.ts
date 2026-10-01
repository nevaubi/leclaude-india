import "server-only";
import { courtByDatasetCode, courtById } from "@/lib/india/courts";
import { remoteStore, type RemoteStore, type Row, type SqlValue } from "@/lib/db/remote";
import type {
  CaseFacets, CaseFilters, CaseHit, CaseListResponse, CaseRecord, CaseRecordResponse, CaseTranslation, CaseUnit, CourtFacet, SameCaseRecord, SourceRegistryEntry,
} from "@/modules/caselaw/shared";
import { HC_BUCKET_URL, SCI_BUCKET_URL } from "../sources/s3";
import { ensureCorpusSchema } from "./backfill";
import { COLS, corpusFilters, MAX_SEARCH_WINDOW, searchCorpus, toHit, type CorpusHit, type CorpusQuery } from "./search";

/**
 * Case law directory over the judgment corpus (Postgres): browse and search the metadata index, per-court coverage
 * facets, and one record with its full provenance (dataset, source archive, record hash) and the other records that
 * describe the same case. Read-only. Nothing here infers a field the dataset did not publish: absent values stay null.
 */

export class CorpusNotConfiguredError extends Error {
  readonly code = "corpus_not_configured";
  constructor() {
    super("The case law index is not configured on this deployment (no DATABASE_URL). The judgment corpus lives in Postgres.");
    this.name = "CorpusNotConfiguredError";
  }
}

function requireStore(store: RemoteStore | null | undefined): RemoteStore {
  const s = store === undefined ? remoteStore() : store;
  if (!s) throw new CorpusNotConfiguredError();
  return s;
}

// ---------------------------------------------------------------------------
// Source registry
// ---------------------------------------------------------------------------

/**
 * What each `source` value is. Licence wording is the one the parsers record on every draft; no licence terms are
 * restated here beyond pointing at the registry entry that carries them.
 */
export const SOURCE_REGISTRY: Record<string, SourceRegistryEntry> = {
  "sci-open-data": {
    source: "sci-open-data",
    registered: true,
    name: "Supreme Court of India judgments (open data)",
    dataset: "indian-supreme-court-judgments",
    publisher: "Supreme Court of India (judgments and metadata as published by the Court)",
    host: "AWS Open Data Registry",
    registryUrl: "https://registry.opendata.aws/indian-supreme-court-judgments/",
    bucketUrl: SCI_BUCKET_URL,
    licence: "See the dataset licence in the AWS Open Data Registry entry.",
    licenceUrl: "https://registry.opendata.aws/indian-supreme-court-judgments/",
    coverage: "1950 to present; English judgments, with court-published regional-language translations where the Court issued them.",
  },
  "hc-open-data": {
    source: "hc-open-data",
    registered: true,
    name: "High Court judgments of India (open data)",
    dataset: "indian-high-court-judgments",
    publisher: "The High Courts of India (judgments and metadata as published by each court)",
    host: "AWS Open Data Registry",
    registryUrl: "https://registry.opendata.aws/indian-high-court-judgments/",
    bucketUrl: HC_BUCKET_URL,
    licence: "See the dataset licence in the AWS Open Data Registry entry.",
    licenceUrl: "https://registry.opendata.aws/indian-high-court-judgments/",
    coverage: "Per court and bench, by year. Only some courts and years are in this index; see the coverage strip.",
  },
};

export function sourceInfo(source: string): SourceRegistryEntry {
  return SOURCE_REGISTRY[source] ?? {
    source, registered: false, name: `Unregistered source "${source}"`, dataset: null, publisher: "Unknown (not in the source registry)",
    host: null, registryUrl: null, bucketUrl: null, licence: "Unknown: this source is not in the registry; check its terms before relying on it.", licenceUrl: null, coverage: null,
  };
}

// ---------------------------------------------------------------------------
// Listing and search
// ---------------------------------------------------------------------------

export interface ListJudgmentsInput extends Partial<CaseFilters> {
  /** Opaque cursor from a previous page (`nextCursor`). */
  cursor?: string | null;
  limit?: number;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

type Cursor = { kind: "offset"; offset: number } | { kind: "key"; date: string | null; id: string };

export function decodeCursor(c: string | null | undefined): Cursor | null {
  if (!c) return null;
  if (c.startsWith("o:")) {
    const n = Number(c.slice(2));
    return Number.isInteger(n) && n >= 0 && n <= MAX_SEARCH_WINDOW ? { kind: "offset", offset: n } : null;
  }
  if (c.startsWith("k:")) {
    const rest = c.slice(2);
    const bar = rest.indexOf("|");
    if (bar < 0) return null;
    const date = rest.slice(0, bar);
    const id = rest.slice(bar + 1);
    if (!id || id.length > 400 || (date !== "" && !DATE_RE.test(date))) return null;
    return { kind: "key", date: date || null, id };
  }
  return null;
}

const keyCursor = (h: { decision_date: string | null; id: string }) => `k:${h.decision_date ?? ""}|${h.id}`;

function caseHit(h: CorpusHit, match: CaseHit["match"]): CaseHit {
  return {
    id: h.id, source: h.source, title: h.title, court_id: h.court_id, court: h.court, court_code: h.court_code, bench_id: h.bench_id ?? null,
    bench_code: h.bench_code, bench_strength: h.bench_strength ?? null, year: h.year, decision_date: h.decision_date, case_number: h.case_number,
    cnr: h.cnr, neutral_citation: h.neutral_citation, reporter_citation: h.reporter_citation, judges: h.judges, disposal: h.disposal,
    pdf_url: h.pdf_url, snippet: h.snippet, text_status: h.text_status, issues: h.issues, match,
  };
}

const clampLimit = (n: number | undefined) => Math.max(1, Math.min(Math.trunc(Number(n) || 50), 50));

/**
 * One page of the directory. With a query: the corpus search (exact identifiers first, then full text), paged by
 * offset within the first MAX_SEARCH_WINDOW hits. Without: a keyset walk by decision date (stable under inserts, no
 * COUNT over the table). `hasMore` comes from probing one row past the page.
 */
export async function listJudgments(input: ListJudgmentsInput, storeArg?: RemoteStore | null): Promise<CaseListResponse> {
  const store = requireStore(storeArg);
  const started = Date.now();
  const limit = clampLimit(input.limit);
  const q = (input.q ?? "").trim().slice(0, 200);
  const base: CorpusQuery = {
    q,
    courts: input.courts?.length ? input.courts : undefined,
    yearFrom: input.yearFrom, yearTo: input.yearTo,
    judge: input.judge || undefined, disposal: input.disposal || undefined,
  };
  const cursor = decodeCursor(input.cursor);

  if (q) {
    const sort = input.sort ?? "relevance";
    const offset = cursor?.kind === "offset" ? cursor.offset : 0;
    if (offset + limit > MAX_SEARCH_WINDOW) return { mode: "search", sort, hits: [], hasMore: false, nextCursor: null, tookMs: Date.now() - started };
    const res = await searchCorpus({ ...base, limit, offset, order: sort }, store);
    const hasMore = Boolean(res.hasMore) && offset + limit < MAX_SEARCH_WINDOW;
    return { mode: "search", sort, hits: res.hits.map((h) => caseHit(h, h.match)), hasMore, nextCursor: hasMore ? `o:${offset + limit}` : null, tookMs: Date.now() - started };
  }

  await ensureCorpusSchema(store);
  const sort = input.sort === "oldest" ? "oldest" : "newest";
  const params: SqlValue[] = [];
  const f = corpusFilters(base, params);
  let keyset = "";
  if (cursor?.kind === "key") {
    const cmp = sort === "newest" ? "<" : ">";
    if (cursor.date) {
      params.push(cursor.date);
      const d = `$${params.length}::date`;
      params.push(cursor.id);
      const i = `$${params.length}`;
      keyset = ` AND (decision_date ${cmp} ${d} OR (decision_date = ${d} AND id ${cmp} ${i}) OR decision_date IS NULL)`;
    } else {
      params.push(cursor.id);
      keyset = ` AND decision_date IS NULL AND id ${cmp} $${params.length}`;
    }
  }
  const order = sort === "newest" ? "decision_date DESC NULLS LAST, id DESC" : "decision_date ASC NULLS LAST, id ASC";
  const rows = await store.query({ query: `SELECT ${COLS} FROM corpus_judgments WHERE TRUE${f}${keyset} ORDER BY ${order} LIMIT ${limit + 1}`, params });
  const hits = rows.slice(0, limit).map((r) => caseHit(toHit(r, "exact"), "browse"));
  const hasMore = rows.length > limit;
  return { mode: "browse", sort, hits, hasMore, nextCursor: hasMore && hits.length ? keyCursor(hits[hits.length - 1]) : null, tookMs: Date.now() - started };
}

// ---------------------------------------------------------------------------
// Facets (cached)
// ---------------------------------------------------------------------------

const FACETS_TTL_MS = 10 * 60 * 1000;
let facetsCache: { value: CaseFacets; at: number } | null = null;
let facetsPending: Promise<CaseFacets> | null = null;

export function resetFacetsCacheForTests() { facetsCache = null; facetsPending = null; }

/** Postgres text timestamp ("2026-09-30 12:00:00.123+00") → ISO, or null. */
export function isoTimestamp(v: string | null | undefined): string | null {
  if (!v) return null;
  const s = v.trim().replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const int = (v: string | null | undefined) => (v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);

export function shapeFacets(groups: Row[], last: Row | undefined, disposals: Row[], units: Row[], now: Date): CaseFacets {
  const courts = new Map<string, CourtFacet>();
  for (const r of groups) {
    const courtId = r.court_id ?? null;
    const code = courtId ? null : r.court_code ?? null;
    const key = courtId ?? `code:${code ?? "unknown"}`;
    let f = courts.get(key);
    if (!f) {
      const c = courtById(courtId);
      f = {
        key, courtId, courtCode: code,
        name: c?.name ?? (courtId ? courtId : `Unmapped court code ${code ?? "(none)"}`),
        level: c?.level === "supreme" ? "supreme" : c ? "high" : "unmapped",
        records: 0, minDate: null, maxDate: null, minYear: null, maxYear: null, years: [], archives: null,
      };
      courts.set(key, f);
    }
    const n = int(r.n) ?? 0;
    const year = int(r.year);
    f.records += n;
    f.years.push({ year, records: n });
    if (r.min_date && (!f.minDate || r.min_date < f.minDate)) f.minDate = r.min_date;
    if (r.max_date && (!f.maxDate || r.max_date > f.maxDate)) f.maxDate = r.max_date;
    if (year != null) {
      f.minYear = f.minYear == null ? year : Math.min(f.minYear, year);
      f.maxYear = f.maxYear == null ? year : Math.max(f.maxYear, year);
    }
  }
  // Archives: Supreme Court units carry no court code; High Court units carry the dataset code ("29_3").
  for (const u of units) {
    const court = u.source === "sci-open-data" ? courtById("sci") : courtByDatasetCode(u.court_code);
    const key = court ? court.id : `code:${u.court_code ?? "unknown"}`;
    const f = courts.get(key);
    if (!f) continue;
    const a = f.archives ?? { done: 0, total: 0 };
    a.done += int(u.done) ?? 0;
    a.total += int(u.total) ?? 0;
    f.archives = a;
  }
  const rank = (f: CourtFacet) => (f.level === "supreme" ? 0 : f.level === "high" ? 1 : 2);
  const list = [...courts.values()].map((f) => ({ ...f, years: f.years.sort((a, b) => (b.year ?? -1) - (a.year ?? -1)) }))
    .sort((a, b) => rank(a) - rank(b) || b.records - a.records || a.name.localeCompare(b.name));
  return {
    total: list.reduce((n, f) => n + f.records, 0),
    courts: list,
    disposals: disposals.filter((d) => d.disposal).map((d) => ({ value: String(d.disposal), records: int(d.n) ?? 0 })),
    lastIngestedAt: isoTimestamp(last?.last_ingested),
    computedAt: now.toISOString(),
  };
}

async function computeFacets(store: RemoteStore, now: () => number): Promise<CaseFacets> {
  await ensureCorpusSchema(store);
  const [groups, last, disposals, units] = await Promise.all([
    store.query({ query: `SELECT court_id, CASE WHEN court_id IS NULL THEN court_code END AS court_code, year, count(*)::int AS n, min(decision_date)::text AS min_date, max(decision_date)::text AS max_date FROM corpus_judgments GROUP BY 1, 2, 3` }),
    store.query({ query: `SELECT max(ingested_at)::text AS last_ingested FROM corpus_judgments` }),
    store.query({ query: `SELECT disposal, count(*)::int AS n FROM corpus_judgments WHERE disposal IS NOT NULL GROUP BY disposal ORDER BY n DESC, disposal LIMIT 40` }),
    store.query({ query: `SELECT source, court_code, count(*) FILTER (WHERE status = 'done')::int AS done, count(*)::int AS total FROM corpus_units WHERE id NOT LIKE 'discover:%' GROUP BY source, court_code` }),
  ]);
  return shapeFacets(groups, last[0], disposals, units, new Date(now()));
}

/**
 * Counts per court (and per unmapped court code), per year, coverage dates, archive progress, top disposals and the
 * last ingest time. Cached in memory per instance for ten minutes; concurrent callers share one computation; if a
 * recompute fails and an older copy exists, that copy is returned marked `stale`.
 */
export async function corpusFacets(storeArg?: RemoteStore | null, now: () => number = Date.now): Promise<CaseFacets> {
  const store = requireStore(storeArg);
  if (facetsCache && now() - facetsCache.at < FACETS_TTL_MS) return facetsCache.value;
  if (!facetsPending) {
    facetsPending = computeFacets(store, now)
      .then((value) => { facetsCache = { value, at: now() }; return value; })
      .finally(() => { facetsPending = null; });
  }
  try {
    return await facetsPending;
  } catch (e) {
    if (facetsCache) return { ...facetsCache.value, stale: true };
    throw e;
  }
}

// ---------------------------------------------------------------------------
// One record
// ---------------------------------------------------------------------------

const RECORD_COLS = `j.id, j.source, j.unit_id, j.dataset_key, j.court_id, j.court_code, j.bench_id, j.bench_code, j.year, j.title, j.petitioner, j.respondent,
  j.case_number, j.case_type, j.cnr, j.neutral_citation, j.reporter_citation, j.judges, j.author, j.bench_strength,
  j.decision_date::text AS decision_date, j.registration_date::text AS registration_date, j.disposal, j.language, j.translations::text AS translations,
  j.pdf_key, j.pdf_url, j.snippet, j.issues, j.record_sha256, j.text_status, j.ingested_at::text AS ingested_at, j.updated_at::text AS updated_at,
  u.id AS u_id, u.source AS u_source, u.year AS u_year, u.court_code AS u_court_code, u.bench_code AS u_bench_code, u.folder AS u_folder,
  u.object_key AS u_object_key, u.status AS u_status, u.expected AS u_expected, u.stored AS u_stored, u.rejected AS u_rejected, u.note AS u_note,
  u.finished_at::text AS u_finished_at`;

const safeUrl = (u: unknown): string | null => {
  if (typeof u !== "string") return null;
  try { const p = new URL(u); return p.protocol === "https:" || p.protocol === "http:" ? p.toString() : null; } catch { return null; }
};

export function parseTranslations(v: string | null): CaseTranslation[] {
  if (!v) return [];
  try {
    const arr = JSON.parse(v) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.filter((t): t is Record<string, unknown> => Boolean(t) && typeof t === "object").map((t) => ({
      language: typeof t.language === "string" ? t.language : "unknown",
      origin: typeof t.origin === "string" ? t.origin : null,
      url: safeUrl(t.url),
    }));
  } catch {
    return [];
  }
}

function archiveUrl(source: string | null, key: string | null): string | null {
  if (!source || !key) return null;
  const bucket = SOURCE_REGISTRY[source]?.bucketUrl;
  return bucket ? `${bucket}/${key.split("/").map((p) => encodeURIComponent(p).replace(/%3D/g, "=")).join("/")}` : null;
}

function benchName(courtId: string | null, benchId: string | null): string | null {
  const b = courtById(courtId)?.benches.find((x) => x.id === benchId);
  return b ? (b.city && !b.name.includes(b.city) ? `${b.name}, ${b.city}` : b.name) : null;
}

export function recordFromRow(r: Row): CaseRecord {
  const hit = toHit(r, "exact");
  const unit: CaseUnit | null = r.u_id ? {
    id: r.u_id, source: r.u_source, year: int(r.u_year), courtCode: r.u_court_code, benchCode: r.u_bench_code, folder: r.u_folder,
    objectKey: r.u_object_key, archiveUrl: archiveUrl(r.u_source, r.u_object_key), status: r.u_status, expected: int(r.u_expected),
    stored: int(r.u_stored), rejected: int(r.u_rejected), note: r.u_note, finishedAt: isoTimestamp(r.u_finished_at),
  } : null;
  const { match: _match, ...rest } = caseHit(hit, "exact");
  void _match;
  return {
    ...rest,
    pdf_url: safeUrl(hit.pdf_url),
    unit_id: String(r.unit_id),
    dataset_key: String(r.dataset_key),
    petitioner: r.petitioner, respondent: r.respondent, case_type: r.case_type, author: r.author,
    registration_date: r.registration_date, language: r.language,
    translations: parseTranslations(r.translations),
    pdf_key: r.pdf_key,
    record_sha256: String(r.record_sha256),
    ingested_at: isoTimestamp(r.ingested_at), updated_at: isoTimestamp(r.updated_at),
    bench: benchName(hit.court_id, hit.bench_id ?? null),
    unit,
    sourceInfo: sourceInfo(hit.source),
  };
}

/**
 * One record with its provenance, plus the other records in the index that carry the same CNR or the same neutral
 * citation. Those are separate dataset records (another order in the same case, or the same judgment listed by
 * another dataset); they are listed with the reason, never merged into this one.
 */
export async function judgmentRecord(id: string, storeArg?: RemoteStore | null): Promise<CaseRecordResponse | null> {
  const store = requireStore(storeArg);
  if (!id || id.length > 400) return null;
  await ensureCorpusSchema(store);
  const rows = await store.query({ query: `SELECT ${RECORD_COLS} FROM corpus_judgments j LEFT JOIN corpus_units u ON u.id = j.unit_id WHERE j.id = $1`, params: [id] });
  if (!rows[0]) return null;
  const record = recordFromRow(rows[0]);
  let sameCase: SameCaseRecord[] = [];
  if (record.cnr || record.neutral_citation) {
    const same = await store.query({
      query: `SELECT ${COLS} FROM corpus_judgments WHERE id <> $1 AND (cnr = $2 OR neutral_citation = $3) ORDER BY decision_date DESC NULLS LAST, id LIMIT 25`,
      params: [record.id, record.cnr, record.neutral_citation],
    });
    sameCase = same.map((r) => {
      const h = caseHit(toHit(r, "exact"), "exact");
      const reasons: SameCaseRecord["reasons"] = [];
      if (record.cnr && h.cnr === record.cnr) reasons.push("cnr");
      if (record.neutral_citation && h.neutral_citation === record.neutral_citation) reasons.push("neutral_citation");
      return { ...h, reasons };
    }).filter((h) => h.reasons.length > 0);
  }
  return { record, sameCase };
}

