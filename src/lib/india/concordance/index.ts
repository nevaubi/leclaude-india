/**
 * Official concordance loader (client-safe): the three BPR&D tables as data, validated and indexed by section.
 *
 * Lookups are exact on the normalised section; a sub-section query ("302(1)") may fall back to rows printed at the
 * section level ("302"), and the caller is told so. Rows whose section numbers the parser could not trust
 * (`verification: "requires_review"`) are returned separately (`blocked`) and never used as mapping candidates.
 */
import ipcBns from "./data/ipc-bns.json";
import crpcBnss from "./data/crpc-bnss.json";
import ieaBsa from "./data/iea-bsa.json";
import type { ConcordanceRow, ConcordanceTable, ConcordanceTableId, NewCodeId, OldCodeId } from "./types";

export * from "./types";

const RAW: Record<ConcordanceTableId, unknown> = { "ipc-bns": ipcBns, "crpc-bnss": crpcBnss, "iea-bsa": ieaBsa };

export const TABLE_FOR_OLD: Record<OldCodeId, ConcordanceTableId> = { IPC: "ipc-bns", CrPC: "crpc-bnss", IEA: "iea-bsa" };
export const TABLE_FOR_NEW: Record<NewCodeId, ConcordanceTableId> = { BNS: "ipc-bns", BNSS: "crpc-bnss", BSA: "iea-bsa" };

/** Light structural validation; a malformed data file fails loudly at import rather than mapping silently wrong. */
export function validateTable(id: ConcordanceTableId, v: unknown): ConcordanceTable {
  const t = v as ConcordanceTable;
  if (!t || t.id !== id || !Array.isArray(t.rows) || !t.source?.url || !t.source?.title) throw new Error(`concordance ${id}: data file is malformed`);
  const ids = new Set<string>();
  for (const r of t.rows) {
    if (!r.id?.startsWith(`${id}:`) || ids.has(r.id)) throw new Error(`concordance ${id}: bad or duplicate row id ${r.id}`);
    ids.add(r.id);
    if (!Array.isArray(r.newSections) || !Array.isArray(r.oldSections) || !Array.isArray(r.flags) || !Number.isInteger(r.page)) throw new Error(`concordance ${id}: row ${r.id} is malformed`);
    if (r.relation === "corresponds" && !r.oldSections.length) throw new Error(`concordance ${id}: row ${r.id} corresponds to nothing`);
  }
  return t;
}

const TABLES: Record<ConcordanceTableId, ConcordanceTable> = {
  "ipc-bns": validateTable("ipc-bns", RAW["ipc-bns"]),
  "crpc-bnss": validateTable("crpc-bnss", RAW["crpc-bnss"]),
  "iea-bsa": validateTable("iea-bsa", RAW["iea-bsa"]),
};

export function concordanceTable(id: ConcordanceTableId): ConcordanceTable {
  return TABLES[id];
}

export function concordanceTables(): ConcordanceTable[] {
  return Object.values(TABLES);
}

/** "302(1)(a)" → "302". */
export const baseSection = (s: string) => s.replace(/\(.*$/, "");

type Index = Map<string, ConcordanceRow[]>;
const oldIndex = new Map<ConcordanceTableId, Index>();
const newIndex = new Map<ConcordanceTableId, Index>();

function build(id: ConcordanceTableId, side: "old" | "new"): Index {
  const cache = side === "old" ? oldIndex : newIndex;
  const hit = cache.get(id);
  if (hit) return hit;
  const idx: Index = new Map();
  const add = (k: string, r: ConcordanceRow) => { const l = idx.get(k) ?? []; if (!l.includes(r)) l.push(r); idx.set(k, l); };
  for (const r of TABLES[id].rows) for (const s of side === "old" ? r.oldSections : r.newSections) add(s.section, r);
  cache.set(id, idx);
  return idx;
}

export interface ConcordanceLookup {
  table: ConcordanceTable;
  /** Usable rows (no blocking flag) whose section matches. */
  rows: ConcordanceRow[];
  /** Matching rows the parser could not trust (shown, never used to map). */
  blocked: ConcordanceRow[];
  /** "exact": the section itself; "base": the query had a sub-section and rows matched its section; "children": the
   *  query was a section and rows matched its sub-sections (new side, e.g. BNS 318 → 318(1)…318(4)). */
  match: "exact" | "base" | "children" | "none";
}

function lookup(id: ConcordanceTableId, side: "old" | "new", section: string): ConcordanceLookup {
  const idx = build(id, side);
  const table = TABLES[id];
  const split = (rows: ConcordanceRow[]) => ({ rows: rows.filter((r) => r.verification !== "requires_review"), blocked: rows.filter((r) => r.verification === "requires_review") });
  let hits = idx.get(section) ?? [];
  if (hits.length) return { table, ...split(hits), match: "exact" };
  const base = baseSection(section);
  if (base !== section) {
    hits = idx.get(base) ?? [];
    if (hits.length) return { table, ...split(hits), match: "base" };
  } else {
    hits = [...idx.entries()].filter(([k]) => baseSection(k) === section).flatMap(([, v]) => v);
    hits = hits.filter((r, i) => hits.indexOf(r) === i).sort((a, b) => table.rows.indexOf(a) - table.rows.indexOf(b));
    if (hits.length) return { table, ...split(hits), match: "children" };
  }
  return { table, rows: [], blocked: [], match: "none" };
}

/** Rows of the official table that name `section` of the old code. */
export function rowsForOld(code: OldCodeId, section: string): ConcordanceLookup {
  return lookup(TABLE_FOR_OLD[code], "old", section);
}

/** Rows of the official table for `section` of the new code. */
export function rowsForNew(code: NewCodeId, section: string): ConcordanceLookup {
  return lookup(TABLE_FOR_NEW[code], "new", section);
}

/** One line naming the document, for attribution next to any mapping. */
export function concordanceCitation(t: Pick<ConcordanceTable, "source">): string {
  return `${t.source.title} (${t.source.publisher})`;
}
