import "server-only";
import ipcBns from "./data/ipc-bns.summaries.json";
import crpcBnss from "./data/crpc-bnss.summaries.json";
import ieaBsa from "./data/iea-bsa.summaries.json";
import { concordanceTable } from "./index";
import type { ConcordanceSummaries, ConcordanceTableId } from "./types";

/**
 * The "summary of comparison" column of the official tables, per row id (server-only: ~110 KB of text that client
 * bundles do not need). Text is as extracted from the publisher's PDF.
 */
const SUMMARIES: Record<ConcordanceTableId, ConcordanceSummaries> = { "ipc-bns": ipcBns, "crpc-bnss": crpcBnss, "iea-bsa": ieaBsa };

const ROW_ID = /^(ipc-bns|crpc-bnss|iea-bsa):(\d{1,4})$/;

export interface ConcordanceRowDetail { id: string; summary: string | null }

/** Summaries for the given row ids; unknown or malformed ids are dropped (at most 40 per call). */
export function concordanceSummaries(ids: string[]): { rows: ConcordanceRowDetail[]; sources: { table: ConcordanceTableId; title: string; publisher: string; url: string; retrievedAt: string; extraction: string }[] } {
  const rows: ConcordanceRowDetail[] = [];
  const tables = new Set<ConcordanceTableId>();
  for (const id of [...new Set(ids)].slice(0, 40)) {
    const m = ROW_ID.exec(id);
    if (!m) continue;
    const t = m[1] as ConcordanceTableId;
    if (!concordanceTable(t).rows.some((r) => r.id === id)) continue;
    tables.add(t);
    rows.push({ id, summary: SUMMARIES[t][id] ?? null });
  }
  const sources = [...tables].map((t) => { const s = concordanceTable(t).source; return { table: t, title: s.title, publisher: s.publisher, url: s.url, retrievedAt: s.retrievedAt, extraction: s.extraction }; });
  return { rows, sources };
}
