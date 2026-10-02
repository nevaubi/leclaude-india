import "server-only";
import { remoteStore, type RemoteStore, type Row, type SqlQuery, type SqlValue } from "@/lib/db/remote";
import { ensureOfficialSchema } from "../schema";
import { OfficialNotConfiguredError } from "../service";

/**
 * Postgres helpers shared by the courts stream's persistence and queries (server-only).
 * Every read runs under a statement timeout; every value is a bound parameter.
 */

export const QUERY_TIMEOUT_MS = 8000;

/** The official-sources store (schema ensured); OfficialNotConfiguredError when no Postgres is configured. */
export async function officialStore(store?: RemoteStore | null): Promise<RemoteStore> {
  const s = store === undefined ? remoteStore() : store;
  if (!s) throw new OfficialNotConfiguredError();
  await ensureOfficialSchema(s);
  return s;
}

/** One statement under a statement timeout (set_config(..., true) is local to the transaction). */
export async function bounded(store: RemoteStore, query: string, params: SqlValue[], timeoutMs = QUERY_TIMEOUT_MS): Promise<Row[]> {
  const res = await store.transaction([
    { query: `SELECT set_config('statement_timeout', $1, true) AS t`, params: [String(Math.max(500, Math.trunc(timeoutMs)))] },
    { query, params },
  ]);
  return res[1] ?? [];
}

/** JSON parameter with NUL characters removed (Postgres text cannot hold them). */
export function jsonParam(v: unknown): string {
  return JSON.stringify(v).replace(/\\u0000/g, "");
}

/** Postgres text[] literal with proper quoting. */
export function pgTextArray(values: string[]): string {
  return `{${values.map((v) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",")}}`;
}

/** Postgres text[] in text output ({"A B",C}) → strings. */
export function parsePgArray(v: string | null | undefined): string[] {
  if (!v) return [];
  const inner = v.replace(/^\{|\}$/g, "");
  if (!inner) return [];
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|([^,]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner))) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : m[2] === "NULL" ? "" : m[2]);
  return out.filter((x) => x !== "");
}

export const bool = (v: string | null | undefined): boolean => v === "t" || v === "true" || v === "1";
export const int = (v: string | null | undefined): number | null => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Math.trunc(Number(v)));

export function parseJson<T>(v: string | null | undefined, fallback: T): T {
  if (v == null || v === "") return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}

/** SQL expression rendering a timestamptz column as an ISO string in UTC. */
export function isoTs(column: string): string {
  return `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;
}

/** Batches of JSON rows whose serialized size stays under `maxChars` (Neon HTTP request bodies are bounded). */
export function batchRows<T>(rows: T[], maxChars = 900_000, maxRows = 1000): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  let size = 0;
  for (const r of rows) {
    const n = JSON.stringify(r).length;
    if (cur.length && (size + n > maxChars || cur.length >= maxRows)) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(r);
    size += n;
  }
  if (cur.length) out.push(cur);
  return out;
}

export type { RemoteStore, Row, SqlQuery, SqlValue };
