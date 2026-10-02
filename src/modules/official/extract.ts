import "server-only";
import { loadPdfjs } from "@/lib/pdf/pdfjs-server";
import { defaultLanguageForScript, detectScript } from "@/lib/india/languages";
import { htmlToMarkdown } from "./html-markdown";
import type { ExtractionMethod } from "./types";

/**
 * Text extraction for official documents (deterministic; no model).
 *
 * PDF: pdfjs-dist (legacy build, server) text layer → per-page text AND positional items {page,str,x,y,w,h} (PDF user
 * space, origin bottom-left) for column-aware parsing by adapters, and page-marked markdown ("<!-- page N -->").
 * Every page passes a readability gate (`textQuality`: enough letters, letters dominate the visible characters); a page
 * that fails it and carries an image (a scan) or glyph garbage (a font without a Unicode map) is listed in `ocrPages`.
 * A page with no text and no image is blank and never sent to OCR. Garbage text is never indexed.
 * HTML: ./html-markdown.ts. JSON / CSV / XLSX: tables in markdown. DOCX: mammoth raw text.
 */

export const EXTRACTOR_VERSION = 1;
/** Characters kept per document; beyond this the text is cut and `truncated` is set (recorded, never silent). */
export const MAX_TEXT_CHARS = 4_000_000;
const MAX_ITEMS = 400_000;
const MAX_TABLE_ROWS = 5_000;

export interface PageText { page: number; text: string }
export interface PositionalItem { page: number; str: string; x: number; y: number; w: number; h: number }
export interface PageQuality { page: number; readable: boolean; letters: number; visible: number; hasImages: boolean; needsOcr: boolean }

export type ExtractKind = "pdf" | "html" | "json" | "sheet" | "csv" | "docx" | "text" | "unsupported";

export interface ExtractedDocument {
  kind: ExtractKind;
  /** How the text was obtained; null when nothing usable was extracted. */
  method: ExtractionMethod | null;
  /** True when page numbers are meaningful (PDF). */
  paged: boolean;
  pageCount: number | null;
  /** Text per page (1-based). Pages that need OCR carry "" here. */
  pages: PageText[];
  items: PositionalItem[];
  quality: PageQuality[];
  /** Pages without a usable text layer that need OCR (1-based). */
  ocrPages: number[];
  title: string | null;
  links: string[];
  language: string | null;
  truncated: boolean;
  warning: string | null;
}

/**
 * Deterministic readability gate for an extracted text layer: enough letters, and letters make up most of the visible
 * characters (page markers excluded). Unicode letter classes, so Devanagari / Kannada / Telugu text passes.
 * (Same rule as textQuality in src/modules/india/sources/ingest.ts.)
 */
export function textQuality(text: string): { readable: boolean; letters: number; visible: number } {
  const body = text.replace(/\[Page \d+\]/g, "").replace(/<!-- page \d+ -->/g, "");
  const visible = (body.match(/\S/gu) ?? []).length;
  const letters = (body.match(/[\p{L}\p{M}]/gu) ?? []).length;
  return { readable: letters >= 40 && letters / Math.max(1, visible) >= 0.5, letters, visible };
}

/** Per-page decision: readable text, OCR (scan or glyph garbage), or blank/short (kept as is). */
export function pageNeedsOcr(text: string, hasImages: boolean): { readable: boolean; letters: number; visible: number; needsOcr: boolean } {
  const q = textQuality(text);
  if (q.readable) return { ...q, needsOcr: false };
  const ratio = q.letters / Math.max(1, q.visible);
  if (hasImages) return { ...q, needsOcr: true };
  if (q.visible >= 20 && ratio < 0.5) return { ...q, needsOcr: true }; // glyph garbage without a usable Unicode map
  return { ...q, readable: q.visible > 0 && ratio >= 0.5, needsOcr: false }; // short page (a signature line) or blank
}

export const PAGE_MARKER = (n: number) => `<!-- page ${n} -->`;
const MARKER_RE = /<!-- page (\d{1,6}) -->/g;

/** Page-marked markdown of a document (`paged`), or the single text of a page-less one. */
export function pageMarkdown(pages: PageText[], paged: boolean): string {
  if (!paged) return pages.map((p) => p.text).join("\n\n").trim();
  return pages.map((p) => `${PAGE_MARKER(p.page)}\n\n${p.text.trim()}`.trimEnd()).join("\n\n");
}

/** Split page-marked markdown back into pages; text before the first marker (if any) is page null. */
export function splitPageMarkdown(md: string): { page: number | null; text: string }[] {
  const out: { page: number | null; text: string }[] = [];
  let last = 0;
  let page: number | null = null;
  MARKER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MARKER_RE.exec(md))) {
    const t = md.slice(last, m.index);
    if (t.trim() || page != null) out.push({ page, text: t.trim() });
    page = Number(m[1]);
    last = MARKER_RE.lastIndex;
  }
  const tail = md.slice(last);
  if (tail.trim() || page != null) out.push({ page, text: tail.trim() });
  return out;
}

export function languageOf(text: string): string | null {
  const sample = text.slice(0, 20_000);
  const letters = (sample.match(/\p{L}/gu) ?? []).length;
  if (letters < 20) return null;
  const script = detectScript(sample);
  if (!script || script === "Latin") return "en";
  const latin = (sample.match(/[A-Za-z]/g) ?? []).length;
  return 1 - latin / letters >= 0.4 ? defaultLanguageForScript(script) : "en";
}

// ---------------------------------------------------------------------------
// Kind detection
// ---------------------------------------------------------------------------

function ext(url: string | null | undefined): string {
  if (!url) return "";
  try { return (new URL(url).pathname.split(".").pop() ?? "").toLowerCase(); } catch { return (url.split(/[?#]/)[0].split(".").pop() ?? "").toLowerCase(); }
}

export function detectKind(bytes: Uint8Array, mime: string | null, url?: string | null): ExtractKind {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, Math.min(bytes.length, 1024)));
  if (head.startsWith("%PDF-") || /%PDF-\d/.test(head.slice(0, 1024))) return "pdf";
  const m = (mime ?? "").toLowerCase();
  const e = ext(url);
  const zip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (zip && (/wordprocessingml/.test(m) || e === "docx")) return "docx";
  if (zip && (/spreadsheetml|ms-excel/.test(m) || e === "xlsx" || e === "xls")) return "sheet";
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf && (/ms-excel/.test(m) || e === "xls")) return "sheet";
  if (/pdf/.test(m) || e === "pdf") return "pdf";
  const trimmed = head.replace(/^﻿/, "").trimStart().toLowerCase();
  if (/^<!doctype html|^<html|<head[\s>]|<body[\s>]/.test(trimmed) || /html/.test(m) || e === "html" || e === "htm" || e === "aspx" || e === "php" || e === "jsp") return "html";
  if (/json/.test(m) || e === "json" || /^[[{]/.test(trimmed)) return "json";
  if (/csv/.test(m) || e === "csv") return "csv";
  if (/^text\//.test(m) || e === "txt" || e === "md") return "text";
  if (zip) return "unsupported";
  // Mostly printable UTF-8 → text; otherwise binary we do not read.
  const sample = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, 4096));
  const bad = (sample.match(/[\u0000-\u0008\u000e-\u001f�]/g) ?? []).length;
  return bad / Math.max(1, sample.length) < 0.02 ? "text" : "unsupported";
}

// ---------------------------------------------------------------------------
// Extractors
// ---------------------------------------------------------------------------

function empty(kind: ExtractKind, warning: string | null): ExtractedDocument {
  return { kind, method: null, paged: false, pageCount: null, pages: [], items: [], quality: [], ocrPages: [], title: null, links: [], language: null, truncated: false, warning };
}

function cap(text: string, budget: { left: number }): { text: string; cut: boolean } {
  if (text.length <= budget.left) { budget.left -= text.length; return { text, cut: false }; }
  const t = text.slice(0, Math.max(0, budget.left));
  budget.left = 0;
  return { text: t, cut: true };
}

interface PdfTextItem { str: string; transform?: number[]; width?: number; height?: number; hasEOL?: boolean }

/** Lines from a page's text items: a new line when the baseline moves; a blank line on a large vertical gap. */
export function pageTextFromItems(items: PdfTextItem[]): string {
  let out = "";
  let lastY: number | null = null;
  let lastH = 0;
  for (const it of items) {
    if (typeof it.str !== "string") continue;
    const y = Array.isArray(it.transform) ? Number(it.transform[5]) : null;
    const h = Number(it.height) || (Array.isArray(it.transform) ? Math.abs(Number(it.transform[3])) : 0) || 0;
    if (lastY != null && y != null && Math.abs(y - lastY) > 2) {
      // A new baseline: one line break (an end-of-line flag may already have added it); a blank line on a large gap.
      const gap = Math.abs(lastY - y);
      out = out.replace(/[ \t]+$/, "");
      const want = gap > Math.max(h, lastH, 8) * 1.8 ? "\n\n" : "\n";
      if (out && !out.endsWith(want)) out = out.replace(/\n*$/, "") + want;
    } else if (out && !/[\s]$/.test(out) && it.str && !/^\s/.test(it.str)) {
      out += " ";
    }
    out += it.str;
    if (it.hasEOL) out += "\n";
    if (y != null) lastY = y;
    if (h) lastH = h;
  }
  return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export async function extractPdf(bytes: Uint8Array, opts: { maxChars?: number; withItems?: boolean } = {}): Promise<ExtractedDocument> {
  const pdfjs = await loadPdfjs();
  // pdfjs may transfer (detach) the buffer it is given; the caller keeps its bytes for OCR, so hand it a copy.
  const data = new Uint8Array(bytes);
  const task = pdfjs.getDocument({ data, useSystemFonts: true, disableFontFace: true, verbosity: 0 });
  let doc: Awaited<typeof task.promise>;
  try {
    doc = await task.promise;
  } catch (e) {
    await task.destroy().catch(() => undefined);
    return empty("pdf", `Could not read PDF: ${(e as Error).message.slice(0, 200)}`);
  }
  const imageOps = new Set<number>([pdfjs.OPS.paintImageXObject, pdfjs.OPS.paintInlineImageXObject, pdfjs.OPS.paintImageMaskXObject, pdfjs.OPS.paintImageXObjectRepeat, pdfjs.OPS.paintInlineImageXObjectGroup, pdfjs.OPS.paintImageMaskXObjectGroup].filter((n): n is number => typeof n === "number"));
  const budget = { left: opts.maxChars ?? MAX_TEXT_CHARS };
  const pages: PageText[] = [];
  const items: PositionalItem[] = [];
  const quality: PageQuality[] = [];
  let truncated = false;
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      const raw = content.items.filter((it): it is typeof it & PdfTextItem => "str" in it) as PdfTextItem[];
      let text = pageTextFromItems(raw);
      let hasImages = false;
      if (!textQuality(text).readable) {
        try {
          const ops = await page.getOperatorList();
          hasImages = ops.fnArray.some((f: number) => imageOps.has(f));
        } catch { hasImages = false; }
      }
      const q = pageNeedsOcr(text, hasImages);
      quality.push({ page: p, ...q, hasImages });
      if (q.needsOcr) text = ""; // garbage or a scan: never indexed as text
      const c = cap(text, budget);
      if (c.cut) truncated = true;
      pages.push({ page: p, text: c.text });
      if (opts.withItems !== false && !q.needsOcr && items.length < MAX_ITEMS) {
        for (const it of raw) {
          if (!it.str || !Array.isArray(it.transform)) continue;
          items.push({ page: p, str: it.str, x: round(it.transform[4]), y: round(it.transform[5]), w: round(Number(it.width) || 0), h: round(Number(it.height) || 0) });
          if (items.length >= MAX_ITEMS) break;
        }
      }
      page.cleanup();
      if (budget.left <= 0 && p < doc.numPages) {
        truncated = true;
        for (let rest = p + 1; rest <= doc.numPages; rest++) pages.push({ page: rest, text: "" });
        break;
      }
    }
  } finally {
    await task.destroy().catch(() => undefined);
  }
  const all = pages.map((p) => p.text).join("\n\n");
  const ocrPages = quality.filter((q) => q.needsOcr).map((q) => q.page);
  const anyText = pages.some((p) => p.text.trim());
  return {
    kind: "pdf",
    method: anyText ? "text_layer" : null,
    paged: true,
    pageCount: doc.numPages,
    pages,
    items,
    quality,
    ocrPages,
    title: null,
    links: [],
    language: languageOf(all),
    truncated,
    warning: truncated ? `text cut at ${opts.maxChars ?? MAX_TEXT_CHARS} characters` : null,
  };
}

const round = (n: number) => Math.round(Number(n) * 100) / 100;

export function extractHtml(html: string, baseUrl: string | null): ExtractedDocument {
  const { title, markdown, links } = htmlToMarkdown(html, { baseUrl, maxChars: MAX_TEXT_CHARS });
  const q = textQuality(markdown);
  return {
    kind: "html",
    method: markdown.trim() ? "html" : null,
    paged: false,
    pageCount: null,
    pages: [{ page: 1, text: markdown }],
    items: [],
    quality: [{ page: 1, ...q, hasImages: false, needsOcr: false }],
    ocrPages: [],
    title: title || null,
    links,
    language: languageOf(markdown),
    truncated: markdown.length >= MAX_TEXT_CHARS,
    warning: q.readable ? null : "page has little readable text",
  };
}

function mdCell(v: unknown): string {
  if (v == null) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return s.replace(/\r?\n/g, " <br> ").replace(/\|/g, "\\|").trim();
}

/** Rows (first row = header) → markdown pipe table. */
export function rowsToMarkdown(rows: unknown[][]): string {
  const clean = rows.filter((r) => Array.isArray(r) && r.some((c) => c != null && String(c).trim() !== "")).slice(0, MAX_TABLE_ROWS + 1);
  if (!clean.length) return "";
  const width = Math.max(...clean.map((r) => r.length));
  const line = (r: unknown[]) => `| ${Array.from({ length: width }, (_, i) => mdCell(r[i]) || " ").join(" | ")} |`;
  return [line(clean[0]), `| ${Array.from({ length: width }, () => "---").join(" | ")} |`, ...clean.slice(1).map(line)].join("\n");
}

function jsonToMarkdown(value: unknown): string {
  if (Array.isArray(value) && value.length && value.every((v) => v && typeof v === "object" && !Array.isArray(v))) {
    const keys: string[] = [];
    for (const o of value.slice(0, MAX_TABLE_ROWS)) for (const k of Object.keys(o as object)) if (!keys.includes(k) && keys.length < 40) keys.push(k);
    return rowsToMarkdown([keys, ...value.slice(0, MAX_TABLE_ROWS).map((o) => keys.map((k) => (o as Record<string, unknown>)[k]))]);
  }
  return "```json\n" + JSON.stringify(value, null, 1).slice(0, MAX_TEXT_CHARS) + "\n```";
}

function single(kind: ExtractKind, method: ExtractionMethod, text: string, title: string | null = null): ExtractedDocument {
  const t = text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : text;
  const q = textQuality(t);
  return { kind, method: t.trim() ? method : null, paged: false, pageCount: null, pages: [{ page: 1, text: t }], items: [], quality: [{ page: 1, ...q, hasImages: false, needsOcr: false }], ocrPages: [], title, links: [], language: languageOf(t), truncated: text.length > MAX_TEXT_CHARS, warning: null };
}

/** Extract any fetched official file. Never throws for unreadable content: returns `method: null` with a warning. */
export async function extractDocument(input: { bytes: Uint8Array; mime: string | null; url: string; finalUrl?: string | null }): Promise<ExtractedDocument> {
  const kind = detectKind(input.bytes, input.mime, input.finalUrl ?? input.url);
  try {
    switch (kind) {
      case "pdf": return await extractPdf(input.bytes);
      case "html": return extractHtml(new TextDecoder("utf-8", { fatal: false }).decode(input.bytes), input.finalUrl ?? input.url);
      case "json": {
        const raw = new TextDecoder("utf-8", { fatal: false }).decode(input.bytes);
        try { return single("json", "dataset", jsonToMarkdown(JSON.parse(raw))); } catch { return single("text", "text_layer", raw); }
      }
      case "csv":
      case "sheet": {
        const XLSX = await import("xlsx");
        const wb = kind === "csv" ? XLSX.read(new TextDecoder("utf-8").decode(input.bytes), { type: "string" }) : XLSX.read(input.bytes, { type: "array" });
        const parts = wb.SheetNames.map((s) => {
          const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[s], { header: 1, blankrows: false, defval: "" });
          const table = rowsToMarkdown(rows);
          return wb.SheetNames.length > 1 ? `## ${s}\n\n${table}` : table;
        });
        return single(kind, "dataset", parts.filter(Boolean).join("\n\n"));
      }
      case "docx": {
        const mammoth = (await import("mammoth")).default;
        const r = await mammoth.extractRawText({ buffer: Buffer.from(input.bytes) });
        return single("docx", "text_layer", r.value.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim());
      }
      case "text": return single("text", "text_layer", new TextDecoder("utf-8", { fatal: false }).decode(input.bytes).replace(/\r\n?/g, "\n").trim());
      default: return empty("unsupported", `unsupported file type (${input.mime ?? "unknown"})`);
    }
  } catch (e) {
    return empty(kind, `extraction failed: ${(e as Error).message.slice(0, 200)}`);
  }
}

/** Text supplied by a listing / dataset (DiscoveredDoc.text): one page-less document. */
export function extractProvidedText(text: string): ExtractedDocument {
  return single("text", "dataset", text.replace(/\r\n?/g, "\n").trim());
}

/**
 * Pages of Firecrawl PDF markdown parsed with `pageMarkers` ("…end of page 1\n\n---\n\n<!-- page 2 -->…"): text before
 * the first marker is page 1 only when that marker is page 2; page numbers must then rise by one. Anything else → null
 * (the document is kept page-less; page boundaries are never guessed).
 */
export function firecrawlPages(markdown: string): PageText[] | null {
  const segs = splitPageMarkdown(markdown);
  const marked = segs.filter((s) => s.page != null);
  if (!marked.length) return null;
  const pages: PageText[] = [];
  for (const s of segs) {
    const page = s.page ?? (marked[0].page === 2 ? 1 : null);
    if (page == null) { if (s.text.trim()) return null; continue; }
    pages.push({ page, text: s.text.replace(/\n*-{3,}\s*$/, "").trim() });
  }
  for (let i = 0; i < pages.length; i++) if (pages[i].page !== pages[0].page + i) return null;
  return pages[0]?.page === 1 ? pages : null;
}

/** Markdown returned by Firecrawl's PDF parser: paged when its page markers are consistent, else page-less. */
export function extractFirecrawlMarkdown(markdown: string, numPages: number | null): ExtractedDocument {
  const pages = firecrawlPages(markdown);
  if (!pages) return { ...single("pdf", "firecrawl_pdf", markdown.replace(/<!-- page \d+ -->/g, "").trim()), pageCount: numPages };
  const all = pages.map((p) => p.text).join("\n\n");
  const quality = pages.map((p) => ({ page: p.page, ...textQuality(p.text), hasImages: false, needsOcr: false }));
  return { kind: "pdf", method: all.trim() ? "firecrawl_pdf" : null, paged: true, pageCount: numPages ?? pages.length, pages, items: [], quality, ocrPages: [], title: null, links: [], language: languageOf(all), truncated: false, warning: null };
}
