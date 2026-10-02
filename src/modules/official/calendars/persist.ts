import "server-only";
import { createHash } from "node:crypto";
import { jsonParam, type RemoteStore } from "../causelist/db";
import type { HolidayRecord } from "./parse";

/**
 * Store a calendar document's holidays in court_holidays (replaces that document's previous rows) and record on the
 * document which years it covers completely (`meta.coversYears`) and which it speaks for only partially because rows
 * were rejected (`meta.partialYears`), in one transaction. Only covered years are ever answered by courtCalendar();
 * other years stay "unknown" (partial ones say so in its notes).
 */

export function holidayId(documentId: string, r: HolidayRecord): string {
  return `ch_${createHash("sha256").update(`${documentId}\u0000${r.forum}\u0000${r.kind}\u0000${r.dateFrom}\u0000${r.dateTo}\u0000${r.name}`).digest("hex").slice(0, 24)}`;
}

export async function persistHolidays(
  store: RemoteStore,
  doc: { id: string; url: string; fetchedAt: string },
  records: HolidayRecord[],
  coversYears: number[],
  partialYears: number[] = [],
): Promise<{ stored: number }> {
  const partial = partialYears.filter((y) => !coversYears.includes(y));
  const seen = new Set<string>();
  const rows = [];
  for (const r of records) {
    const id = holidayId(doc.id, r);
    if (seen.has(id)) continue;
    seen.add(id);
    rows.push({
      id, forum: r.forum, date_from: r.dateFrom, date_to: r.dateTo, name: r.name.slice(0, 300), kind: r.kind,
      registry_open: r.registryOpen, document_id: doc.id, source_url: doc.url, year: r.year, note: r.note, fetched_at: doc.fetchedAt,
    });
  }
  await store.transaction([
    { query: `DELETE FROM court_holidays WHERE document_id = $1`, params: [doc.id] },
    ...(rows.length
      ? [{
          query: `INSERT INTO court_holidays (id, forum, date_from, date_to, name, kind, registry_open, document_id, source_url, year, note, fetched_at)
            SELECT x.id, x.forum, x.date_from::date, x.date_to::date, x.name, x.kind, x.registry_open, x.document_id, x.source_url, x.year, x.note, x.fetched_at::timestamptz
            FROM jsonb_to_recordset($1::jsonb) AS x(id text, forum text, date_from text, date_to text, name text, kind text, registry_open boolean, document_id text, source_url text, year int, note text, fetched_at text)
            ON CONFLICT (id) DO UPDATE SET forum = EXCLUDED.forum, date_from = EXCLUDED.date_from, date_to = EXCLUDED.date_to, name = EXCLUDED.name,
              kind = EXCLUDED.kind, registry_open = EXCLUDED.registry_open, document_id = EXCLUDED.document_id, source_url = EXCLUDED.source_url,
              year = EXCLUDED.year, note = EXCLUDED.note, fetched_at = EXCLUDED.fetched_at`,
          params: [jsonParam(rows)],
        }]
      : []),
    {
      query: `UPDATE official_documents SET meta = meta || jsonb_build_object('coversYears', $2::jsonb, 'holidaysParsed', $3::int, 'partialYears', $4::jsonb) WHERE id = $1`,
      params: [doc.id, JSON.stringify(coversYears), rows.length, JSON.stringify(partial)],
    },
  ]);
  return { stored: rows.length };
}
