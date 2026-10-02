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
    chunks.push({
      index: chunks.length,
      pageStart: pages.length ? Math.min(...pages) : null,
      pageEnd: pages.length ? Math.max(...pages) : null,
      heading: parts[0].heading,
      text: parts.map((b) => b.text).join("\n\n"),
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
