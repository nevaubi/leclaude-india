import "server-only";
import { remoteStore, type RemoteStore, type Row, type SqlValue } from "@/lib/db/remote";
import { parseArray } from "@/modules/india/corpus/search";
import type { LawInstrument, LawJurisdiction, LawKind, LawStatusFilter } from "@/modules/law/shared";
import { isLawActId, isLawJurisdiction, NO_SECTION, normRegulator, normStateCode } from "@/modules/law/shared";

/**
 * Shared plumbing for the Indian law corpus in Postgres (law_datasets, law_instruments, law_provisions; DDL in
 * scripts/law-corpus/schema.sql, owned by the loader). The application never creates these tables: a deployment without
 * DATABASE_URL, or one where the loader has not created them yet, gets an explicit "not configured" / "not loaded"
 * error instead of an empty result that would read as "no such law".
 */

export class LawCorpusNotConfiguredError extends Error {
  readonly code = "law_corpus_not_configured";
  constructor() {
    super("The statutes corpus is not configured on this deployment (no DATABASE_URL). It lives in Postgres.");
    this.name = "LawCorpusNotConfiguredError";
  }
}

export class LawCorpusNotLoadedError extends Error {
  readonly code = "law_corpus_not_loaded";
  constructor(readonly missing: string[]) {
    super(`The statutes corpus has not been loaded into this database yet (missing: ${missing.join(", ")}).`);
    this.name = "LawCorpusNotLoadedError";
  }
}

export class LawSearchTimeoutError extends Error {
  readonly code = "law_search_timeout";
  constructor() {
    super("The search was too broad to finish in time. Add words, quote a phrase, or narrow the jurisdiction or Act.");
    this.name = "LawSearchTimeoutError";
  }
}

export type LawCorpusError = LawCorpusNotConfiguredError | LawCorpusNotLoadedError | LawSearchTimeoutError;

export function isLawCorpusError(e: unknown): e is LawCorpusError {
  return e instanceof LawCorpusNotConfiguredError || e instanceof LawCorpusNotLoadedError || e instanceof LawSearchTimeoutError;
}

/** HTTP status for a corpus error: 503 when the corpus is absent, 504 for a search that timed out. */
export function lawErrorStatus(e: LawCorpusError): number {
  return e instanceof LawSearchTimeoutError ? 504 : 503;
}

const TABLES = ["law_datasets", "law_instruments", "law_provisions"] as const;
const READY_TTL_MS = 10 * 60 * 1000;
let readyAt = 0;
let readyStore: RemoteStore | null = null;

export function resetLawReadyCacheForTests() { readyAt = 0; readyStore = null; }

/**
 * The configured store, after checking the loader's tables exist (to_regclass). A positive check is cached per
 * instance for ten minutes; a negative one is re-checked on every call so a finished load shows up at once.
 */
export async function lawStore(storeArg?: RemoteStore | null, now: () => number = Date.now): Promise<RemoteStore> {
  const store = storeArg === undefined ? remoteStore() : storeArg;
  if (!store) throw new LawCorpusNotConfiguredError();
  if (readyStore === store && now() - readyAt < READY_TTL_MS) return store;
  const rows = await store.query({ query: `SELECT ${TABLES.map((t) => `to_regclass('public.${t}')::text AS ${t}`).join(", ")}` });
  const missing = TABLES.filter((t) => !rows[0]?.[t]);
  if (missing.length) throw new LawCorpusNotLoadedError([...missing]);
  readyStore = store;
  readyAt = now();
  return store;
}

/** Run one statement under a statement timeout (one transaction: set_config(..., true) is local to it). */
export async function boundedQuery(store: RemoteStore, query: string, params: SqlValue[], timeoutMs: number): Promise<Row[]> {
  try {
    const res = await store.transaction([
      { query: `SELECT set_config('statement_timeout', $1, true) AS t`, params: [String(Math.max(500, Math.trunc(timeoutMs)))] },
      { query, params },
    ]);
    return res[1] ?? [];
  } catch (e) {
    if (/statement timeout|canceling statement/i.test((e as Error).message)) throw new LawSearchTimeoutError();
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Row decoding (Neon raw text output)
// ---------------------------------------------------------------------------

export const int = (v: string | null | undefined): number | null => (v == null || v === "" ? null : Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : null);
export const num = (v: string | null | undefined): number => (v == null || v === "" || !Number.isFinite(Number(v)) ? 0 : Number(v));
export const bool = (v: string | null | undefined): boolean | null => (v == null || v === "" ? null : v === "t" || v === "true" || v === "1");
export { parseArray };

/** A section number as stored → section key ("" and null become NO_SECTION). */
export const sectionKey = (v: string | null | undefined): string => (v == null || v.trim() === "" ? NO_SECTION : v.trim());

export const INSTRUMENT_COLS = `id, kind, title, jurisdiction, state, state_code, regulator, publisher, year, status, amendment_count, source_url, mirror_url, provisions, sections, subjects, dataset_file, dataset_version`;

export function instrumentCols(alias: string): string {
  return INSTRUMENT_COLS.split(", ").map((c) => `${alias}.${c}`).join(", ");
}

export function toInstrument(r: Row): LawInstrument {
  return {
    id: String(r.id),
    kind: r.kind ?? "act",
    title: r.title ?? String(r.id),
    jurisdiction: r.jurisdiction ?? "central",
    state: r.state ?? null,
    state_code: r.state_code ?? null,
    regulator: r.regulator ?? null,
    publisher: r.publisher ?? null,
    year: int(r.year),
    status: r.status ?? null,
    amendment_count: int(r.amendment_count),
    source_url: r.source_url ?? null,
    mirror_url: r.mirror_url ?? null,
    provisions: num(r.provisions),
    sections: num(r.sections),
    subjects: parseArray(r.subjects ?? null),
    dataset_file: r.dataset_file ?? "",
    dataset_version: r.dataset_version ?? "",
  };
}

// ---------------------------------------------------------------------------
// Instrument filters (statement-level, bound parameters only)
// ---------------------------------------------------------------------------

export interface InstrumentFilterInput {
  jurisdiction?: LawJurisdiction | string | null;
  state?: string | null;
  regulator?: string | null;
  kind?: LawKind | string | null;
  status?: LawStatusFilter;
  /** Shorthand for status = "in_force". */
  inForceOnly?: boolean;
  yearFrom?: number;
  yearTo?: number;
  actId?: string | null;
  /**
   * Territorial scope for State legislation: State Acts only from these State codes (central law and regulator
   * instruments are unaffected). An empty list leaves out every State Act; undefined applies no scope.
   */
  scopeStates?: string[];
  /** Leave out reports (Law Commission reports are context, not law); ignored when a kind is requested. */
  excludeReports?: boolean;
}

/** " AND …" clauses over the instrument alias; values are pushed to `params`. Invalid values are dropped, never guessed. */
export function instrumentFilters(f: InstrumentFilterInput, params: SqlValue[], alias = "i"): string {
  const out: string[] = [];
  const p = (v: SqlValue) => { params.push(v); return `$${params.length}`; };
  if (isLawJurisdiction(f.jurisdiction)) out.push(`${alias}.jurisdiction = ${p(f.jurisdiction)}`);
  const state = normStateCode(f.state);
  if (state) out.push(`${alias}.state_code = ${p(state)}`);
  const reg = normRegulator(f.regulator);
  if (reg) out.push(`${alias}.regulator = ${p(reg)}`);
  if (f.kind === "act" || f.kind === "regulation" || f.kind === "report") out.push(`${alias}.kind = ${p(f.kind)}`);
  else if (f.excludeReports) out.push(`${alias}.kind <> 'report'`);
  const status = f.inForceOnly ? "in_force" : f.status ?? "all";
  if (status === "in_force") out.push(`${alias}.status = 'in_force'`);
  else if (status === "not_in_force") out.push(`${alias}.status IS DISTINCT FROM 'in_force'`);
  if (Number.isInteger(f.yearFrom)) out.push(`${alias}.year >= ${p(f.yearFrom as number)}`);
  if (Number.isInteger(f.yearTo)) out.push(`${alias}.year <= ${p(f.yearTo as number)}`);
  if (f.scopeStates) {
    const codes = f.scopeStates.map((c) => normStateCode(c)).filter(Boolean);
    out.push(codes.length ? `(${alias}.jurisdiction <> 'state' OR ${alias}.state_code = ANY(${p(`{${codes.join(",")}}`)}::text[]))` : `${alias}.jurisdiction <> 'state'`);
  }
  if (f.actId && isLawActId(f.actId)) out.push(`${alias}.id = ${p(f.actId)}`);
  return out.map((c) => ` AND ${c}`).join("");
}
