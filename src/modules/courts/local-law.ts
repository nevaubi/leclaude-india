import "server-only";
import { remoteStore, type RemoteStore, type Row, type SqlValue } from "@/lib/db/remote";
import type { StateCode } from "@/lib/india/courts";
import { cityById, localLawFor, normaliseActTitle, stateName, type LocalLawPointer } from "@/lib/india/forums";

/**
 * Resolve local-law pointers (exact statute titles) against the law corpus (`law_instruments`, Postgres).
 *
 * Matching is exact on the normalised title (case, punctuation, spacing and a leading "The" ignored) and restricted
 * to the pointer's jurisdiction: State legislation of the pointer's State, or central legislation. A title with no
 * exact match is `not_found`; it is never mapped to a similar Act (constitution §23). Two or more exact matches are
 * `ambiguous` and every candidate is returned. Without a configured corpus every pointer is `unavailable` (not
 * checked), which is a different state from `not_found`.
 */

export interface ResolvedAct {
  id: string;
  title: string;
  year?: number;
  status?: string;
  state?: string;
  sourceUrl?: string;
}

export type LocalLawStatus = "resolved" | "ambiguous" | "not_found" | "unavailable";

export interface LocalLawResolution {
  pointer: LocalLawPointer;
  status: LocalLawStatus;
  acts: ResolvedAct[];
}

export interface LocalLawResult {
  /** The State whose pointers were resolved. */
  state: StateCode | null;
  stateName: string;
  /** False when no law corpus is configured (DATABASE_URL); every item is then `unavailable`. */
  configured: boolean;
  /** Set when the corpus could not be queried; every item is then `unavailable`. */
  error?: string;
  items: LocalLawResolution[];
}

const QUERY_TIMEOUT_MS = 8000;

/** SQL twin of `normaliseActTitle` (the JS check below remains the authority on exactness). */
const NORM_SQL = (col: string) => `regexp_replace(trim(regexp_replace(lower(${col}), '[^a-z0-9]+', ' ', 'g')), '^the ', '')`;

function rowToAct(r: Row): ResolvedAct {
  const year = r.year != null && r.year !== "" ? Number(r.year) : undefined;
  return {
    id: String(r.id), title: String(r.title ?? ""),
    ...(year !== undefined && Number.isFinite(year) ? { year } : {}),
    ...(r.status ? { status: r.status } : {}),
    ...(r.state ? { state: r.state } : {}),
    ...(r.source_url ? { sourceUrl: r.source_url } : {}),
  };
}

/** True when a corpus row is in the pointer's jurisdiction (deterministic; the SQL filter is only a pre-filter). */
function inJurisdiction(r: Row, p: LocalLawPointer): boolean {
  if (p.jurisdiction === "central") return r.jurisdiction === "central";
  if (r.jurisdiction !== "state" || !p.stateCode) return false;
  if (r.state_code && r.state_code.toUpperCase() === p.stateCode) return true;
  const name = stateName(p.stateCode);
  return !r.state_code && !!r.state && normaliseActTitle(r.state) === normaliseActTitle(name);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Law corpus did not answer within ${ms / 1000}s`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/** Resolve a list of pointers. `store` defaults to the configured remote store; `null` means not configured. */
export async function resolveLocalLaw(pointers: LocalLawPointer[], store: RemoteStore | null = remoteStore()): Promise<Pick<LocalLawResult, "configured" | "error" | "items">> {
  const unavailable = (): LocalLawResolution[] => pointers.map((pointer) => ({ pointer, status: "unavailable", acts: [] }));
  if (!store) return { configured: false, items: unavailable() };
  if (!pointers.length) return { configured: true, items: [] };

  const titles = Array.from(new Set(pointers.map((p) => normaliseActTitle(p.title))));
  const codes = Array.from(new Set(pointers.filter((p) => p.jurisdiction === "state" && p.stateCode).map((p) => p.stateCode!)));
  const names = codes.map((c) => stateName(c).toLowerCase());
  const params: SqlValue[] = [];
  const ph = (vals: SqlValue[]) => vals.map((v) => { params.push(v); return `$${params.length}`; }).join(", ");
  const titleIn = ph(titles);
  const juris: string[] = [];
  if (pointers.some((p) => p.jurisdiction === "central")) juris.push(`jurisdiction = 'central'`);
  if (codes.length) juris.push(`(jurisdiction = 'state' AND (upper(state_code) IN (${ph(codes)}) OR (state_code IS NULL AND lower(state) IN (${ph(names)}))))`);
  const query = `SELECT id, title, jurisdiction, state, state_code, year, status, source_url FROM law_instruments
    WHERE ${NORM_SQL("title")} IN (${titleIn}) AND (${juris.join(" OR ")}) ORDER BY id LIMIT 200`;

  let rows: Row[];
  try {
    rows = await withTimeout(store.query({ query, params }), QUERY_TIMEOUT_MS);
  } catch (e) {
    const msg = (e as Error).message || "Law corpus query failed";
    return { configured: true, error: /law_instruments/.test(msg) && /does not exist/.test(msg) ? "The law corpus has not been loaded." : msg, items: unavailable() };
  }

  const items = pointers.map((pointer): LocalLawResolution => {
    const want = normaliseActTitle(pointer.title);
    const hits = rows.filter((r) => normaliseActTitle(String(r.title ?? "")) === want && inJurisdiction(r, pointer));
    const acts = Array.from(new Map(hits.map((r) => [String(r.id), rowToAct(r)])).values());
    return { pointer, status: acts.length === 0 ? "not_found" : acts.length === 1 ? "resolved" : "ambiguous", acts };
  });
  return { configured: true, items };
}

/** Local-law pointers for a State, resolved. Unknown or empty States return an empty list. */
export async function resolveLocalLawForState(state: StateCode | null | undefined, store?: RemoteStore | null): Promise<LocalLawResult> {
  const pointers = localLawFor(state);
  const r = store === undefined ? await resolveLocalLaw(pointers) : await resolveLocalLaw(pointers, store);
  return { state: state ?? null, stateName: stateName(state ?? undefined), ...r };
}

export async function resolveLocalLawForCity(cityId: string | null | undefined, store?: RemoteStore | null): Promise<LocalLawResult> {
  const city = cityById(cityId);
  return resolveLocalLawForState(city?.state ?? null, store);
}
