import { createHash } from "node:crypto";
import { splitPageMarkdown } from "./extract";

/**
 * Page-aware, heading-aware chunking of page-marked markdown (deterministic, no overlap).
 *
 * - Chunks are ~2,500 characters (target) and never longer than 4,000; every block of the document lands in exactly one
 *   chunk, in order, so the stored text can be rebuilt from the chunks (readers fetch neighbours for context instead of
 *   overlapping).
 * - A chunk records the pages it spans (pageStart..pageEnd) and the nearest markdown heading above its first block. A
 *   chunk is closed at a page boundary once it holds ~1,000 characters, so most chunks sit on one page and `#p<page>`
 *   references stay precise; short pages are merged with the next.
 * - A new heading starts a new chunk once the current one is half full.
 * - Blocks longer than the maximum are split at line, then sentence, then word boundaries (hard cut as a last resort).
 * - `textSha256` is the SHA-256 of the full page-marked markdown: chunks bind to the exact text version they came from.
 * - `pageMarks` ([offset, page] pairs, offsets into the chunk text) say on which page every part of a multi-page chunk
 *   sits, so a search excerpt can be cited to the page where it starts rather than the chunk's first page.
 */

export const CHUNK_TARGET = 2_500;
export const CHUNK_MAX = 4_000;
const PAGE_FLUSH = 1_000;

export interface ChunkDraft {
  index: number;
  pageStart: number | null;
  pageEnd: number | null;
  heading: string | null;
  text: string;
  /** [offset in `text`, page] where each page's text starts; null for page-less documents. */
  pageMarks: [number, number][] | null;
}

/** Page of the character at `offset` in a chunk (null when the chunk has no page marks). */
export function pageAt(marks: [number, number][] | null | undefined, offset: number): number | null {
  if (!marks?.length) return null;
  let page: number | null = null;
  for (const [at, p] of marks) {
    if (at > offset) break;
    page = p;
  }
  return page ?? marks[0][1];
}

// ---------------------------------------------------------------------------
// Contact data (personal data) scrubbing
// ---------------------------------------------------------------------------

/**
 * Bump when the patterns change: indexed documents whose `meta.scrubVersion` differs are re-scrubbed in place by the
 * runner's bounded backfill (pipeline.ts `scrubIndexedDocuments`).
 */
export const SCRUB_VERSION = 1;
export const PHONE_REMOVED = "[phone removed]";
export const EMAIL_REMOVED = "[e-mail removed]";
export const LINK_REMOVED = "[link removed]";

export interface ScrubCounts { phones: number; emails: number; links: number }

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
// "registrar[at]nic[dot]in" / "x (at) y (dot) gov (dot) in" — common on Indian government pages.
const EMAIL_OBF_RE = /[A-Za-z0-9._%+-]+\s*[[({]\s*at\s*[\])}]\s*[A-Za-z0-9-]+(?:\s*(?:[[({]\s*dot\s*[\])}]|\.)\s*[A-Za-z0-9-]+)+/gi;
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s|)>\]"']+/gi;
// Video-conference meeting links (court rooms, advocates' personal rooms).
const VC_URL_RE = /\b(?:https?:\/\/|www\.)[^\s|)>\]"']*(?:webex\.com|zoom\.us|meet\.google\.com|teams\.microsoft\.com|teams\.live\.com|gotomeeting\.com|meet\.jit\.si|bluejeans\.com|vidyo)[^\s|)>\]"']*/gi;

// A phone number never touches a letter, digit, "/" (case numbers are N/YYYY), "@" or "_" and is never a decimal or
// a digit range continuation; amounts ("Rs. 1500000000") are left alone.
const BEFORE = String.raw`(?<![\p{L}\p{N}/@_])(?<!\d[.,-])(?<!(?:Rs|RS|rs|INR|₹|Rupees|rupees)\.?\s{0,2})`;
const AFTER = String.raw`(?![\p{L}\p{N}/@_]|[.,-]\d)`;
const PREFIX = String.raw`(?:\+91[\s-]?|91[\s-])?`;
// 10–12 digits (mobile, landline with STD code, +91 forms) — the same rule as cause-list entries (causelist/text.ts).
const PLAIN_PHONE_RE = new RegExp(`${BEFORE}${PREFIX}\\d{10,12}${AFTER}`, "gu");
// "9810012345/9876543210" (two numbers joined by a slash).
const PHONE_LIST_RE = new RegExp(`${BEFORE}\\d{10,12}(?:\\s*\\/\\s*\\d{10,12})+${AFTER}`, "gu");
// Grouped mobiles: "98765 43210", "+91-98765-43210", "987-654-3210".
const GROUPED_MOBILE_RE = new RegExp(`${BEFORE}(?:\\+91[\\s-]?|91[\\s-]|0)?[6-9](?:\\d{4}[\\s-]\\d{5}|\\d{2}[\\s-]\\d{3}[\\s-]\\d{4})${AFTER}`, "gu");
// Landlines with a trunk 0 or +91: "011-23388922", "(011) 2338 8922", "+91-11-23388922" (10 digits after the prefix).
const LANDLINE_RE = new RegExp(`${BEFORE}(?:\\+91[\\s-]?\\(?|\\(?0)\\d{2,4}\\)?[\\s-]?\\d{3,4}[\\s-]?\\d{3,4}${AFTER}`, "gu");
// A number introduced as one: "Ph: 23388922", "Mob. No. 98100 12345, 98765 43210".
const LABELLED_PHONE_RE = /\b(ph|phone|phones|mob|mobile|tel|telephone|cell|contact|whatsapp|fax)\b\.?\s*(?:no|nos|number|numbers)?\.?\s*[:\-–]?\s*(\+?\d[\d \t-]{5,16}\d(?:\s*[,/]\s*\+?\d[\d \t-]{5,16}\d)*)/giu;

function landlineDigits(m: string): boolean {
  let d = m.replace(/\D/g, "");
  if (/^\s*\+91/.test(m)) d = d.slice(2);
  else if (/^\(?0/.test(m)) d = d.slice(1);
  return d.length === 10;
}

/**
 * Remove contact data from text before it is chunked, indexed or embedded: e-mail addresses, phone numbers (Indian
 * mobile / landline forms) and video-conference links (every link with `allLinks`, as for cause lists). Each is
 * replaced by a visible marker ("[phone removed]", "[e-mail removed]", "[link removed]") so the edit is never silent;
 * the official copy stays verifiable at its URL by the stored SHA-256 of the publisher's bytes. Deterministic and
 * idempotent (the markers contain no digits, "@" or links).
 */
export function scrubPersonalData(text: string, opts: { allLinks?: boolean } = {}): { text: string; counts: ScrubCounts } {
  const counts: ScrubCounts = { phones: 0, emails: 0, links: 0 };
  if (!text) return { text, counts };
  let s = text.replace(EMAIL_RE, () => { counts.emails++; return EMAIL_REMOVED; });
  s = s.replace(EMAIL_OBF_RE, () => { counts.emails++; return EMAIL_REMOVED; });
  s = s.replace(opts.allLinks ? URL_RE : VC_URL_RE, () => { counts.links++; return LINK_REMOVED; });
  s = s.replace(LABELLED_PHONE_RE, (m: string, _label: string, num: string) => {
    const digits = num.replace(/\D/g, "").length;
    if (digits < 6) return m;
    counts.phones += Math.max(1, num.split(/\s*[,/]\s*/).length);
    return m.slice(0, m.length - num.length) + PHONE_REMOVED;
  });
  s = s.replace(PHONE_LIST_RE, (m: string) => { counts.phones += m.split("/").length; return PHONE_REMOVED; });
  s = s.replace(GROUPED_MOBILE_RE, () => { counts.phones++; return PHONE_REMOVED; });
  s = s.replace(LANDLINE_RE, (m: string) => {
    if (!landlineDigits(m)) return m;
    counts.phones++;
    return PHONE_REMOVED;
  });
  s = s.replace(PLAIN_PHONE_RE, () => { counts.phones++; return PHONE_REMOVED; });
  return { text: s, counts };
}

export function addCounts(a: ScrubCounts, b: ScrubCounts): ScrubCounts {
  return { phones: a.phones + b.phones, emails: a.emails + b.emails, links: a.links + b.links };
}

export function sha256Hex(s: string | Uint8Array): string {
  return createHash("sha256").update(s).digest("hex");
}

interface Block { text: string; page: number | null; heading: string | null; isHeading: boolean }

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

/** Split a too-long block at the most natural boundary that keeps every piece ≤ max. */
export function splitLong(text: string, max = CHUNK_MAX): string[] {
  if (text.length <= max) return [text];
  const seps: RegExp[] = [/\n/, /(?<=[.!?;:])\s+/, /\s+/];
  for (const sep of seps) {
    const parts = text.split(sep).filter((p) => p.length);
    if (parts.length < 2) continue;
    const joiner = sep.source === "\\n" ? "\n" : " ";
    const out: string[] = [];
    let cur = "";
    for (const p of parts) {
      if (p.length > max) {
        if (cur) { out.push(cur); cur = ""; }
        out.push(...splitLong(p, max));
        continue;
      }
      if (cur && cur.length + joiner.length + p.length > max) { out.push(cur); cur = p; } else cur = cur ? cur + joiner + p : p;
    }
    if (cur) out.push(cur);
    if (out.every((o) => o.length <= max)) return out;
  }
  const out: string[] = [];
  for (let i = 0; i < text.length; i += max) out.push(text.slice(i, i + max));
  return out;
}

function blocksOf(markdown: string): Block[] {
  const blocks: Block[] = [];
  let heading: string | null = null;
  for (const seg of splitPageMarkdown(markdown)) {
    // Paragraph blocks; a markdown table or list stays together as one block (split only if too long).
    const paras = seg.text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    for (const p of paras) {
      const h = HEADING_RE.exec(p.split("\n")[0]);
      const isHeading = Boolean(h) && !p.includes("\n");
      if (h) heading = h[2].replace(/[*_`]/g, "").trim().slice(0, 300) || heading;
      for (const piece of splitLong(p)) blocks.push({ text: piece, page: seg.page, heading, isHeading });
    }
  }
  return blocks;
}

/** Chunk page-marked markdown (see module notes). */
export function chunkMarkdown(markdown: string, opts: { target?: number; max?: number } = {}): ChunkDraft[] {
  const target = Math.max(200, opts.target ?? CHUNK_TARGET);
  const max = Math.max(target, opts.max ?? CHUNK_MAX);
  const blocks = blocksOf(markdown);
  const chunks: ChunkDraft[] = [];
  let parts: Block[] = [];
  let size = 0;
  const flush = () => {
    if (!parts.length) return;
    const pages = parts.map((b) => b.page).filter((p): p is number => p != null);
    const marks: [number, number][] = [];
    let at = 0;
    parts.forEach((b, i) => {
      if (i) at += 2; // the "\n\n" joiner
      if (b.page != null && (!marks.length || marks[marks.length - 1][1] !== b.page)) marks.push([at, b.page]);
      at += b.text.length;
    });
    chunks.push({
      index: chunks.length,
      pageStart: pages.length ? Math.min(...pages) : null,
      pageEnd: pages.length ? Math.max(...pages) : null,
      heading: parts[0].heading,
      text: parts.map((b) => b.text).join("\n\n"),
      pageMarks: marks.length ? marks : null,
    });
    parts = [];
    size = 0;
  };
  for (const b of blocks) {
    const add = (parts.length ? 2 : 0) + b.text.length;
    const last = parts[parts.length - 1];
    const pageChange = last && b.page !== last.page;
    if (parts.length && size + add > max) flush();
    else if (parts.length && b.isHeading && size >= target / 2) flush();
    else if (parts.length && pageChange && size >= PAGE_FLUSH) flush();
    else if (parts.length && size >= target) flush();
    parts.push(b);
    size += (parts.length > 1 ? 2 : 0) + b.text.length;
  }
  flush();
  return chunks;
}

/** Whitespace-normalised concatenation (for the no-loss / no-overlap invariant). */
export function normalizedText(s: string): string {
  return s.replace(/<!-- page \d+ -->/g, " ").replace(/\s+/g, " ").trim();
}
