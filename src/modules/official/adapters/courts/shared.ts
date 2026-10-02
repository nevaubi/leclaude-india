import "server-only";
import type { AdapterContext, DiscoverResult, ParseInput } from "../../adapter";
import type { DiscoveredDoc } from "../../types";
import { decodeHtml, htmlText } from "@/modules/india/sources/parse-util";
import type { TextItem } from "../../causelist/table";

/** Courts-stream adapter helpers: HTML anchors / tables (regex-level, publisher markup is simple), cursors, dates. */

export const GOV_TERMS = "Government publication; verify against the official copy";

export interface Anchor {
  href: string;
  text: string;
  html: string;
}

/** Absolute http(s) URL for an href on `base`; null for anything else (javascript:, mailto:, fragments). */
export function absUrl(href: string, base: string): string | null {
  const h = decodeHtml(href.trim());
  if (!h || h.startsWith("#") || /^(?:javascript|mailto|tel):/i.test(h)) return null;
  try {
    const u = new URL(h, base);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Every <a href> in the HTML with its visible text. */
export function anchors(html: string, base: string): Anchor[] {
  const out: Anchor[] = [];
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(m[1]);
    if (!href) continue;
    const url = absUrl(href[1] ?? href[2] ?? href[3] ?? "", base);
    if (!url) continue;
    out.push({ href: url, text: htmlText(m[2]), html: m[0] });
  }
  return out;
}

export interface HtmlRow {
  cells: string[];
  cellHtml: string[];
  html: string;
}

/** Rows of every <table> body: cell text and cell HTML (for links). Header rows (<th> only) are skipped. */
export function tableRows(html: string): HtmlRow[] {
  const rows: HtmlRow[] = [];
  const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let m: RegExpExecArray | null;
  while ((m = trRe.exec(html))) {
    const cellHtml: string[] = [];
    const tdRe = /<td\b[^>]*>([\s\S]*?)<\/td>/gi;
    let c: RegExpExecArray | null;
    while ((c = tdRe.exec(m[1]))) cellHtml.push(c[1]);
    if (!cellHtml.length) continue;
    rows.push({ cells: cellHtml.map((h) => htmlText(h)), cellHtml, html: m[0] });
  }
  return rows;
}

/** Drupal views cell by its field class ("views-field-field-cause-date"), text and HTML. */
export function drupalCell(rowHtml: string, field: string): { text: string; html: string } | null {
  const re = new RegExp(`<td\\b[^>]*class="[^"]*views-field-${field}\\b[^"]*"[^>]*>([\\s\\S]*?)<\\/td>`, "i");
  const m = re.exec(rowHtml);
  return m ? { text: htmlText(m[1]), html: m[1] } : null;
}

export function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** "2026-10-05" → "10/05/2026" (NCLT's GET filter format). */
export function mdy(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${m}/${d}/${y}`;
}

export function fingerprint(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

/** Return a bounded page of a deterministic item list; the cursor is invalidated when the list changes. */
export function pageOf(all: DiscoveredDoc[], ctx: AdapterContext, notes: string[] = []): DiscoverResult {
  const fp = fingerprint(all.map((d) => d.url).join("\n"));
  let offset = 0;
  try {
    const c = ctx.cursor ? (JSON.parse(ctx.cursor) as { o?: number; f?: string }) : null;
    if (c && c.f === fp && Number.isInteger(c.o) && (c.o ?? 0) >= 0) offset = c.o!;
  } catch {
    offset = 0;
  }
  const limit = Math.max(1, Math.trunc(ctx.limit || 1));
  const items = all.slice(offset, offset + limit);
  const next = offset + items.length;
  const done = next >= all.length;
  return { items, nextCursor: done ? null : JSON.stringify({ o: next, f: fp }), done, notes };
}

export interface QueryCursor {
  q: number;
  s: number;
}

export function parseQueryCursor(cursor: string | null): QueryCursor {
  try {
    const c = cursor ? (JSON.parse(cursor) as Partial<QueryCursor>) : null;
    if (c && Number.isInteger(c.q) && Number.isInteger(c.s) && c.q! >= 0 && c.s! >= 0) return { q: c.q!, s: c.s! };
  } catch {
    /* fall through */
  }
  return { q: 0, s: 0 };
}

/**
 * Run a list of listing queries (one per bench / court) under the call's limit and deadline. Each query returns the
 * documents it lists; the cursor remembers which query and how many of its documents were already returned.
 */
export async function runQueries(
  ctx: AdapterContext,
  count: number,
  run: (index: number) => Promise<DiscoveredDoc[]>,
  notes: string[] = [],
): Promise<DiscoverResult> {
  const cur = parseQueryCursor(ctx.cursor);
  const limit = Math.max(1, Math.trunc(ctx.limit || 1));
  const items: DiscoveredDoc[] = [];
  const seen = new Set<string>();
  for (let q = cur.q; q < count; q++) {
    if (Date.now() >= ctx.deadline - 1500 || ctx.signal?.aborted) {
      return { items, nextCursor: JSON.stringify({ q, s: 0 }), done: false, notes: [...notes, "stopped before the deadline"] };
    }
    let docs: DiscoveredDoc[] = [];
    try {
      docs = await run(q);
    } catch (e) {
      notes.push(`query ${q} failed: ${(e as Error).message.slice(0, 200)}`);
      continue;
    }
    const skip = q === cur.q ? cur.s : 0;
    const fresh = docs.slice(skip).filter((d) => (seen.has(d.url) ? false : (seen.add(d.url), true)));
    const room = limit - items.length;
    if (fresh.length > room) {
      items.push(...fresh.slice(0, room));
      return { items, nextCursor: JSON.stringify({ q, s: skip + room }), done: false, notes };
    }
    items.push(...fresh);
    if (items.length >= limit && q + 1 < count) return { items, nextCursor: JSON.stringify({ q: q + 1, s: 0 }), done: false, notes };
  }
  return { items, nextCursor: null, done: true, notes };
}

/** Positional items of a ParseInput in the table walker's shape. */
export function itemsOf(doc: ParseInput): TextItem[] | undefined {
  return doc.items?.map((i) => ({ page: i.page, str: i.str, x: i.x, y: i.y, w: i.w, h: i.h }));
}

export function metaString(meta: Record<string, unknown>, key: string): string | null {
  const v = meta[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export function metaNumber(meta: Record<string, unknown>, key: string): number | null {
  const v = meta[key];
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}
