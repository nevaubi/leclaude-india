import "server-only";
import type { RemoteStore, Row, SqlValue } from "@/lib/db/remote";
import { isoTimestamp } from "@/modules/india/corpus/directory";
import {
  cleanLawText, isLawActId, lawCitation, NO_SECTION, normSectionKey, normVariant, regulatorLabel, TOC_PAGE_SIZE,
  type LawDatasetRow, type LawFacets, type LawInstrument, type LawInstrumentResponse, type LawSection, type LawSectionRef, type LawSectionResponse, type LawTocEntry,
} from "@/modules/law/shared";
import { bool, instrumentCols, int, lawStore, num, parseArray, sectionKey, toInstrument } from "./common";

/**
 * The statutes directory over the Indian law corpus (Postgres): coverage facets, one instrument with its table of
 * contents, and one section read exactly. Read-only. A section is every provision row with the same act id, section
 * number and variant, in statutory order. Lookups are exact: an unknown section is "not found", never the nearest one.
 */

// ---------------------------------------------------------------------------
// Facets (cached)
// ---------------------------------------------------------------------------

const FACETS_TTL_MS = 10 * 60 * 1000;
let facetsCache: { value: LawFacets; at: number } | null = null;
let facetsPending: Promise<LawFacets> | null = null;

export function resetLawFacetsCacheForTests() { facetsCache = null; facetsPending = null; }

export function shapeLawFacets(groups: Row[], datasets: Row[], now: Date): LawFacets {
  const juris = new Map<string, { instruments: number; sections: number }>();
  const states = new Map<string, { name: string; instruments: number }>();
  const regs = new Map<string, number>();
  const statuses = new Map<string | null, number>();
  let total = 0, sections = 0, minYear: number | null = null, maxYear: number | null = null;
  for (const r of groups) {
    const n = num(r.n);
    const s = num(r.sections);
    total += n;
    sections += s;
    const j = r.jurisdiction ?? "unknown";
    const jv = juris.get(j) ?? { instruments: 0, sections: 0 };
    jv.instruments += n; jv.sections += s;
    juris.set(j, jv);
    if (j === "state" && r.state_code) {
      const sv = states.get(r.state_code) ?? { name: r.state ?? r.state_code, instruments: 0 };
      sv.instruments += n;
      states.set(r.state_code, sv);
    }
    if (j === "regulator" && r.regulator) regs.set(r.regulator, (regs.get(r.regulator) ?? 0) + n);
    statuses.set(r.status ?? null, (statuses.get(r.status ?? null) ?? 0) + n);
    const lo = int(r.min_year), hi = int(r.max_year);
    if (lo != null) minYear = minYear == null ? lo : Math.min(minYear, lo);
    if (hi != null) maxYear = maxYear == null ? hi : Math.max(maxYear, hi);
  }
  const order = ["central", "state", "regulator"];
  const ds: LawDatasetRow[] = datasets.map((d) => ({
    file: String(d.file), version: d.version ?? "", kind: d.kind ?? "", jurisdiction: d.jurisdiction ?? "", label: d.label ?? String(d.file),
    rows_in_file: num(d.rows_in_file), rows_stored: num(d.rows_stored), rows_skipped: num(d.rows_skipped), instruments: num(d.instruments),
    status: d.status ?? "pending", error: d.error ?? null, started_at: isoTimestamp(d.started_at), finished_at: isoTimestamp(d.finished_at),
  }));
  return {
    total,
    sections,
    jurisdictions: [...juris.entries()].map(([value, v]) => ({ value, ...v })).sort((a, b) => (order.indexOf(a.value) + 99) % 99 - (order.indexOf(b.value) + 99) % 99 || b.instruments - a.instruments),
    states: [...states.entries()].map(([code, v]) => ({ code, ...v })).sort((a, b) => a.name.localeCompare(b.name)),
    regulators: [...regs.entries()].map(([value, instruments]) => ({ value, label: regulatorLabel(value) ?? value, instruments })).sort((a, b) => b.instruments - a.instruments || a.label.localeCompare(b.label)),
    statuses: [...statuses.entries()].map(([value, instruments]) => ({ value, instruments })).sort((a, b) => b.instruments - a.instruments),
    minYear, maxYear,
    datasets: ds,
    versions: [...new Set(ds.map((d) => d.version).filter(Boolean))],
    computedAt: now.toISOString(),
  };
}

async function computeLawFacets(store: RemoteStore, now: () => number): Promise<LawFacets> {
  const [groups, datasets] = await Promise.all([
    store.query({ query: `SELECT jurisdiction, state_code, max(state) AS state, regulator, status, count(*)::int AS n, sum(sections)::bigint AS sections, min(year) AS min_year, max(year) AS max_year FROM law_instruments GROUP BY jurisdiction, state_code, regulator, status` }),
    store.query({ query: `SELECT file, version, kind, jurisdiction, label, rows_in_file, rows_stored, rows_skipped, instruments, status, error, started_at::text AS started_at, finished_at::text AS finished_at FROM law_datasets ORDER BY jurisdiction, label, file` }),
  ]);
  return shapeLawFacets(groups, datasets, new Date(now()));
}

/**
 * Counts per jurisdiction, State, regulator and status, the year span, and the loader's dataset rows (file, version,
 * status, row counts). Cached per instance for ten minutes; concurrent callers share one computation; a failed
 * recompute returns the older copy marked `stale`.
 */
export async function lawFacets(storeArg?: RemoteStore | null, now: () => number = Date.now): Promise<LawFacets> {
  const store = await lawStore(storeArg, now);
  if (facetsCache && now() - facetsCache.at < FACETS_TTL_MS) return facetsCache.value;
  if (!facetsPending) {
    facetsPending = computeLawFacets(store, now)
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
// One instrument with its table of contents
// ---------------------------------------------------------------------------

const KEY = `coalesce(nullif(section_number, ''), '${NO_SECTION}')`;

/** TOC page statement (exported for tests): one row per (section, variant), in statutory order. */
export function tocSql(actId: string, offset: number, limit: number): { query: string; params: SqlValue[] } {
  return {
    query: `SELECT ${KEY} AS section, variant, min(ord) AS ord,
  (array_agg(heading ORDER BY ord) FILTER (WHERE heading IS NOT NULL))[1] AS heading,
  (array_agg(chapter ORDER BY ord) FILTER (WHERE chapter IS NOT NULL))[1] AS chapter,
  (array_agg(chapter_title ORDER BY ord) FILTER (WHERE chapter_title IS NOT NULL))[1] AS chapter_title,
  count(*)::int AS parts, count(*) OVER ()::int AS total
FROM law_provisions WHERE act_id = $1
GROUP BY ${KEY}, variant
ORDER BY min(ord), variant
LIMIT ${limit} OFFSET ${offset}`,
    params: [actId],
  };
}

function tocEntry(r: Row): LawTocEntry {
  return {
    section: sectionKey(r.section), variant: int(r.variant) ?? 0, ord: int(r.ord) ?? 0,
    heading: r.heading ? cleanLawText(r.heading) : null, chapter: r.chapter ?? null, chapter_title: r.chapter_title ? cleanLawText(r.chapter_title) : null, parts: int(r.parts) ?? 1,
  };
}

async function instrumentRow(store: RemoteStore, id: string): Promise<LawInstrument | null> {
  const rows = await store.query({ query: `SELECT ${instrumentCols("i")} FROM law_instruments i WHERE i.id = $1`, params: [id] });
  return rows[0] ? toInstrument(rows[0]) : null;
}

/** An instrument and one page of its table of contents (TOC_PAGE_SIZE sections); null when the id is unknown. */
export async function getInstrument(id: string, opts: { tocOffset?: number; tocLimit?: number } = {}, storeArg?: RemoteStore | null): Promise<LawInstrumentResponse | null> {
  if (!isLawActId(id)) return null;
  const store = await lawStore(storeArg);
  const offset = Math.max(0, Math.min(Math.trunc(Number(opts.tocOffset) || 0), 100_000));
  const limit = Math.max(1, Math.min(Math.trunc(Number(opts.tocLimit) || TOC_PAGE_SIZE), 1000));
  const [instrument, toc] = await Promise.all([instrumentRow(store, id), store.query(tocSql(id, offset, limit))]);
  if (!instrument) return null;
  const total = toc[0] ? int(toc[0].total) ?? toc.length : offset;
  return { instrument, toc: { entries: toc.map(tocEntry), total, offset, hasMore: offset + toc.length < total } };
}

// ---------------------------------------------------------------------------
// One section, exactly
// ---------------------------------------------------------------------------

/** Rows of one section, in statutory order (bounded). */
export const SECTION_MAX_ROWS = 400;
/** Text bound for a section page (schedules can be very long). */
export const SECTION_MAX_CHARS = 400_000;

const SECTION_COLS = `id, ord, part, heading, chapter, chapter_title, section_type, provision_type, status, in_force, has_proviso, has_non_obstante, defined_terms, acts_referenced, text, source_url`;

/** Exact section predicate: the printed number (case-insensitive, same index as the loader's), or no number at all. */
export function sectionPredicate(section: string, params: SqlValue[]): string {
  if (section === NO_SECTION) return `(section_number IS NULL OR section_number = '')`;
  params.push(section);
  return `lower(section_number) = lower($${params.length})`;
}

function joinParts(rows: Row[], maxChars: number): { text: string; truncated: boolean; chars: number } {
  let chars = 0;
  const parts: string[] = [];
  let truncated = false;
  for (const r of rows) {
    const t = cleanLawText(r.text ?? "");
    if (!t) continue;
    chars += t.length;
    if (!truncated) {
      const used = parts.reduce((n, p) => n + p.length + 2, 0);
      if (used + t.length > maxChars) { parts.push(t.slice(0, Math.max(0, maxChars - used))); truncated = true; }
      else parts.push(t);
    }
  }
  return { text: parts.join("\n\n"), truncated, chars };
}

function shapeSection(actId: string, section: string, variant: number, rows: Row[], maxChars: number): LawSection {
  const first = rows[0];
  const heading = rows.find((r) => r.heading)?.heading ?? null;
  const { text, truncated, chars } = joinParts(rows, maxChars);
  const terms = new Set<string>();
  const acts = new Set<string>();
  for (const r of rows) { parseArray(r.defined_terms ?? null).forEach((t) => terms.add(t)); parseArray(r.acts_referenced ?? null).forEach((t) => acts.add(t)); }
  return {
    actId, section, variant,
    heading: heading ? cleanLawText(heading) : null,
    chapter: rows.find((r) => r.chapter)?.chapter ?? null,
    chapter_title: (() => { const c = rows.find((r) => r.chapter_title)?.chapter_title; return c ? cleanLawText(c) : null; })(),
    section_type: first.section_type ?? null,
    provision_type: first.provision_type ?? null,
    status: first.status ?? null,
    in_force: rows.some((r) => bool(r.in_force) === true) ? true : rows.every((r) => bool(r.in_force) === false) ? false : null,
    has_proviso: rows.some((r) => bool(r.has_proviso) === true),
    has_non_obstante: rows.some((r) => bool(r.has_non_obstante) === true),
    defined_terms: [...terms],
    acts_referenced: [...acts],
    text, truncated, chars,
    source_url: rows.find((r) => r.source_url)?.source_url ?? null,
    provisionIds: rows.map((r) => String(r.id)),
    ord: int(first.ord) ?? 0,
  };
}

async function neighbour(store: RemoteStore, actId: string, ord: number, dir: "prev" | "next"): Promise<LawSectionRef | null> {
  const rows = await store.query({
    query: `SELECT section_number, variant FROM law_provisions WHERE act_id = $1 AND ord ${dir === "prev" ? "<" : ">"} $2 ORDER BY ord ${dir === "prev" ? "DESC" : "ASC"} LIMIT 1`,
    params: [actId, ord],
  });
  return rows[0] ? { section: sectionKey(rows[0].section_number), variant: int(rows[0].variant) ?? 0 } : null;
}

/**
 * One section by act id, section number (as printed, or NO_SECTION) and variant. Exact: null when the instrument or
 * that section is absent (the caller reports not-found; no other section is offered in its place).
 */
export async function getSection(actId: string, sectionArg: string, variantArg: number = 0, storeArg?: RemoteStore | null, opts: { maxChars?: number } = {}): Promise<LawSectionResponse | null> {
  const section = normSectionKey(sectionArg);
  if (!isLawActId(actId) || !section) return null;
  const variant = normVariant(variantArg);
  const store = await lawStore(storeArg);
  const params: SqlValue[] = [actId];
  const pred = sectionPredicate(section, params);
  const vParams: SqlValue[] = [actId];
  const vPred = sectionPredicate(section, vParams);
  params.push(variant);
  const [instrument, rows, variants] = await Promise.all([
    instrumentRow(store, actId),
    store.query({ query: `SELECT ${SECTION_COLS} FROM law_provisions WHERE act_id = $1 AND ${pred} AND variant = $${params.length} ORDER BY ord, part LIMIT ${SECTION_MAX_ROWS}`, params }),
    store.query({ query: `SELECT DISTINCT variant FROM law_provisions WHERE act_id = $1 AND ${vPred} ORDER BY variant LIMIT 20`, params: vParams }),
  ]);
  if (!instrument || !rows.length) return null;
  const shaped = shapeSection(actId, section, variant, rows, opts.maxChars ?? SECTION_MAX_CHARS);
  const lastOrd = int(rows[rows.length - 1].ord) ?? shaped.ord;
  const [prev, nextRaw] = await Promise.all([neighbour(store, actId, shaped.ord, "prev"), neighbour(store, actId, lastOrd, "next")]);
  // A section longer than SECTION_MAX_ROWS rows continues past the page; its own continuation is not "the next section".
  const next = nextRaw && !(nextRaw.section.toLowerCase() === section.toLowerCase() && nextRaw.variant === variant) ? nextRaw : null;
  return {
    instrument,
    section: shaped,
    variants: variants.map((v) => int(v.variant) ?? 0).filter((v) => v !== variant),
    prev,
    next,
    citation: lawCitation(instrument, section, variant),
  };
}

/**
 * Section text for agents and the research reader: the exact section (never the nearest), truncated to `maxChars`
 * with an explicit marker. Null when absent.
 */
export async function readProvisionText(actId: string, section: string, variant = 0, maxChars = 30_000, storeArg?: RemoteStore | null): Promise<(LawSectionResponse & { text: string }) | null> {
  const res = await getSection(actId, section, variant, storeArg, { maxChars: Math.max(1000, Math.min(maxChars, SECTION_MAX_CHARS)) });
  if (!res) return null;
  const text = res.section.truncated ? `${res.section.text}\n…[truncated: the section has ${res.section.chars.toLocaleString("en-IN")} characters]` : res.section.text;
  return { ...res, text };
}
