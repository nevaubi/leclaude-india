import "server-only";
import { createHash } from "node:crypto";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage } from "pdf-lib";
import type { Principal } from "@/lib/auth/types";
import { drawAnchoredText, sanitizeWinAnsi, setOutline, wrapLine, type OutlineSpec } from "@/modules/office/pdf/pdf-lib-utils";
import { annexureLabels, computePaperbookIndex, PAPERBOOK_LIMITS, pageRangeLabel, type AnnexurePrefix, type PaperbookIndexRow, type PaperbookSource, type PaperbookSpec } from "../drafting";
import { authorizeSetExport, DocsError, loadSet } from "./access";
import { pagesFromChunks } from "./extract";
import { recordAudit } from "./sets";
import { docStore } from "./store";

/**
 * Paperbook builder: the chosen files in order, an index page, continuous page numbers stamped on every page, an
 * annexure marker on the first page of each annexure, and a bookmark per entry.
 *
 * Building the PDF is an export of the set's documents: a matter set needs the matter's `export` permission (a personal
 * set: its owner), checked and audited before anything is read. The index preview needs read access only.
 *
 * "TRUE COPY" is off unless the request turns it on, and is then printed only on annexure pages whose original bytes are
 * embedded (an attached PDF or image). A page typed by software from extracted or OCR text is never marked TRUE COPY: it
 * carries "TYPED FROM EXTRACTED TEXT" (or "TYPED FROM OCR TEXT") and a header saying it is not a facsimile. The line
 * is a place for the advocate's certification, which is the advocate's act, not the software's.
 *
 * Sources, never substituted:
 *  - an original attached for a set file is used only when its SHA-256 equals the hash stored for that file. The index
 *    preview says whether that hash was computed on the server or only declared by the uploading browser;
 *  - a set file without an attached original is typed from its stored text, one source page at a time, each page headed
 *    as typed text (not a facsimile). Text the built-in PDF fonts cannot print (e.g. Devanagari) is refused, not
 *    replaced with "?": the original must be attached instead. The rupee sign is printed as "Rs." and the page says so;
 *  - an attachment that is not in the set (PDF, PNG or JPEG) is embedded as is (images one per page).
 * The index (title, annexure, page range) is computed in code from the page counts; its own page count comes from a
 * measured layout (wrapped titles, court lines), and titles are wrapped in full, never cut short.
 *
 * Bounded memory: attachments are capped in total bytes; each attachment is parsed once however many entries use it
 * (at most PAPERBOOK_LIMITS.maxUploadUses); a PNG is decoded by pdf-lib, so its IHDR dimensions are checked first
 * (per image and in total); the output size is estimated before anything is drawn and checked again after saving.
 */

export interface PaperbookUpload { key: string; name: string; mime: string; bytes: Uint8Array }

const A4 = { w: 595.28, h: 841.89 };
const MARGIN = 56;
const BODY_SIZE = 11;
const LINE = 15;
const INDEX_SIZE = 10;
const INDEX_LINE = 12;
const INDEX_ROW_GAP = 8;
/** Lowest baseline an index row may use (the page number is stamped below it). */
const INDEX_BOTTOM = MARGIN + 24;
const INDEX_COLS = [MARGIN, MARGIN + 34, A4.w - MARGIN - 150, A4.w - MARGIN - 60];
/** Typed-page header: left of the annexure marker area. */
const HEADER_WIDTH = A4.w - MARGIN * 2 - 110;
/** Rough bytes per drawn text page, for the output estimate. */
const TEXT_PAGE_BYTES = 6 * 1024;

type Source =
  | { kind: "pdf"; upload: string; pages: number }
  | { kind: "image"; upload: string }
  | { kind: "typed"; fileName: string; pages: { page: number | null; lines: string[]; rupee: boolean; ocr: boolean }[] };

interface LoadedUpload { up: PaperbookUpload; type: "pdf" | "png" | "jpg"; doc: PDFDocument | null; pixels: number; uses: number }

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function sniff(bytes: Uint8Array): "pdf" | "png" | "jpg" | null {
  if (bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return "pdf";
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  return null;
}

/** PNG dimensions from the IHDR chunk (which must come first), without decoding. */
export function pngSize(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 24 || b[12] !== 0x49 || b[13] !== 0x48 || b[14] !== 0x44 || b[15] !== 0x52) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const width = dv.getUint32(16);
  const height = dv.getUint32(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

/** JPEG dimensions from the first SOF marker (bounded scan), without decoding. */
export function jpgSize(b: Uint8Array): { width: number; height: number } | null {
  let i = 2;
  for (let guard = 0; guard < 10_000 && i + 9 < b.length; guard++) {
    if (b[i] !== 0xff) { i++; continue; }
    const marker = b[i + 1];
    if (marker === 0xff) { i++; continue; }
    const len = (b[i + 2] << 8) | b[i + 3];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = (b[i + 5] << 8) | b[i + 6];
      const width = (b[i + 7] << 8) | b[i + 8];
      return width > 0 && height > 0 ? { width, height } : null;
    }
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

/** Characters the standard PDF fonts cannot print (counted, never silently replaced). */
export function unprintableChars(text: string): number {
  const before = (text.match(/\?/g) ?? []).length;
  return (sanitizeWinAnsi(text).match(/\?/g) ?? []).length - before;
}

const INDIC = /[ऀ-෿]/u;

/** "Indian-language script such as “प”" / "characters such as “✍” (U+270D)": what could not be printed, named exactly. */
export function describeUnprintable(text: string): string {
  const sample: string[] = [];
  for (const ch of text) {
    if (ch === "?" || sample.includes(ch) || sanitizeWinAnsi(ch) !== "?") continue;
    sample.push(ch);
    if (sample.length >= 4) break;
  }
  const indic = sample.find((c) => INDIC.test(c));
  if (indic) return `Indian-language script such as “${indic}”`;
  return `characters such as ${sample.map((c) => `“${c}” (U+${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")})`).join(", ")}`;
}

/** Word wrap that also breaks a single word wider than the line (long file names, URLs) instead of overflowing. */
function wrapHard(font: PDFFont, size: number, text: string, width: number): string[] {
  const out: string[] = [];
  for (const line of wrapLine(font, size, text, width)) {
    if (font.widthOfTextAtSize(line, size) <= width) { out.push(line); continue; }
    let cur = "";
    for (const ch of line) {
      if (cur && font.widthOfTextAtSize(cur + ch, size) > width) { out.push(cur); cur = ch.trimStart(); } else cur += ch;
    }
    if (cur) out.push(cur);
  }
  return out.length ? out : [""];
}

/** Lines of one typed page (wrapped to the text width). */
function typedLines(font: PDFFont, text: string): string[] {
  const width = A4.w - MARGIN * 2;
  const out: string[] = [];
  for (const para of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (!para.trim()) { out.push(""); continue; }
    out.push(...wrapHard(font, BODY_SIZE, para, width));
  }
  return out;
}

const LINES_PER_PAGE = Math.floor((A4.h - MARGIN * 2 - 28) / LINE);

/** Output pages a typed source takes (a long source page continues on the next output page). */
function typedPageCount(src: Extract<Source, { kind: "typed" }>): number {
  return src.pages.reduce((n, p) => n + Math.max(1, Math.ceil(p.lines.length / LINES_PER_PAGE)), 0);
}

function cleanSpec(raw: unknown): PaperbookSpec {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const text = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");
  const prefix: AnnexurePrefix = o.prefix === "R" || o.prefix === "A" ? o.prefix : "P";
  const entries = (Array.isArray(o.entries) ? o.entries : []).slice(0, PAPERBOOK_LIMITS.maxEntries + 1).map((e) => {
    const x = (e && typeof e === "object" ? e : {}) as Record<string, unknown>;
    return { fileId: typeof x.fileId === "string" && x.fileId ? x.fileId : undefined, uploadKey: typeof x.uploadKey === "string" && x.uploadKey ? x.uploadKey.slice(0, 80) : undefined, title: text(x.title, PAPERBOOK_LIMITS.maxTitle), annexure: x.annexure === true };
  });
  if (!entries.length) throw new DocsError("Add at least one document to the paperbook", 422, "invalid");
  if (entries.length > PAPERBOOK_LIMITS.maxEntries) throw new DocsError(`A paperbook can hold at most ${PAPERBOOK_LIMITS.maxEntries} documents`, 422, "invalid");
  entries.forEach((e, i) => { if (!e.fileId && !e.uploadKey) throw new DocsError(`Entry ${i + 1} names no file`, 422, "invalid"); });
  const start = Math.floor(Number(o.startPage));
  return {
    title: text(o.title, 200) || "Paperbook", court: text(o.court, 300) || undefined, prefix,
    startPage: Number.isFinite(start) && start >= 1 && start <= 9999 ? start : 1,
    indexPage: o.indexPage !== false, trueCopy: o.trueCopy === true, entries,
  };
}

interface Loaded { sources: Source[]; titles: string[]; info: PaperbookSource[]; uploads: Map<string, LoadedUpload> }

async function loadSources(setId: string, spec: PaperbookSpec, uploadList: Map<string, PaperbookUpload>, font: PDFFont): Promise<Loaded> {
  const store = await docStore();
  const sources: Source[] = [];
  const titles: string[] = [];
  const info: PaperbookSource[] = [];
  const problems: string[] = [];
  const loaded = new Map<string, LoadedUpload>();
  const none: Source = { kind: "typed", fileName: "", pages: [] };
  const skip = (msg: string) => { problems.push(msg); sources.push(none); info.push({ kind: "typed" }); };

  /** Parse an attachment once, however many entries use it. */
  const load = async (key: string, label: string): Promise<LoadedUpload | null> => {
    const cached = loaded.get(key);
    if (cached) {
      cached.uses++;
      if (cached.uses > PAPERBOOK_LIMITS.maxUploadUses) { problems.push(`${label}: “${cached.up.name}” is used by more than ${PAPERBOOK_LIMITS.maxUploadUses} entries`); return null; }
      return cached;
    }
    const up = uploadList.get(key)!;
    if (!up.bytes.byteLength) { problems.push(`${label}: “${up.name}” is empty`); return null; }
    const type = sniff(up.bytes);
    if (!type) { problems.push(`${label}: “${up.name}” is not a PDF, PNG or JPEG`); return null; }
    let entry: LoadedUpload;
    if (type === "pdf") {
      try {
        entry = { up, type, doc: await PDFDocument.load(up.bytes, { updateMetadata: false }), pixels: 0, uses: 1 };
      } catch (err) {
        problems.push(`${label}: “${up.name}” could not be read as a PDF (${/encrypt/i.test((err as Error).message) ? "it is encrypted" : "damaged or unsupported"})`);
        return null;
      }
    } else {
      const dim = type === "png" ? pngSize(up.bytes) : jpgSize(up.bytes);
      if (!dim) { problems.push(`${label}: “${up.name}” is not a readable ${type === "png" ? "PNG" : "JPEG"} (no image size found)`); return null; }
      const pixels = dim.width * dim.height;
      if (pixels > PAPERBOOK_LIMITS.maxImagePixels) {
        problems.push(`${label}: “${up.name}” is ${dim.width.toLocaleString("en-IN")} × ${dim.height.toLocaleString("en-IN")} pixels; images over ${PAPERBOOK_LIMITS.maxImagePixels / 1_000_000} megapixels are not embedded (scale it down, or convert it to PDF)`);
        return null;
      }
      // Only a PNG is decoded in memory; a JPEG is embedded as is.
      entry = { up, type, doc: null, pixels: type === "png" ? pixels : 0, uses: 1 };
    }
    loaded.set(key, entry);
    return entry;
  };

  for (const [i, e] of spec.entries.entries()) {
    const label = `Entry ${i + 1}`;
    const hasUpload = !!e.uploadKey && uploadList.has(e.uploadKey);
    if (e.uploadKey && !hasUpload) { skip(`${label}: the attached file is missing from the request`); titles.push(e.title); continue; }
    const file = e.fileId ? await store.getFile(setId, e.fileId) : null;
    if (e.fileId && !file) { skip(`${label}: the file is not in this set`); titles.push(e.title); continue; }
    titles.push(e.title || file?.name || uploadList.get(e.uploadKey ?? "")?.name || `Document ${i + 1}`);
    if (hasUpload) {
      const up = uploadList.get(e.uploadKey!)!;
      if (file && sha256(up.bytes) !== file.sha256) { skip(`${label}: the attached original of “${file.name}” does not match the file in the set (SHA-256 differs)`); continue; }
      const l = await load(e.uploadKey!, label);
      if (!l) { sources.push(none); info.push({ kind: "typed" }); continue; }
      sources.push(l.type === "pdf" ? { kind: "pdf", upload: e.uploadKey!, pages: l.doc!.getPageCount() } : { kind: "image", upload: e.uploadKey! });
      info.push(file ? { kind: "original", hash: file.hashOrigin === "server" ? "server" : "browser_declared" } : { kind: "attachment" });
      continue;
    }
    // A set file typed from its stored text.
    const pages = pagesFromChunks(await store.fileChunks(file!.id));
    if (!pages.some((p) => p.text.trim())) { skip(`${label}: “${file!.name}” has no stored text (scanned pages need OCR, or attach the original PDF)`); continue; }
    const all = pages.map((p) => p.text).join("\n");
    const bad = unprintableChars(all);
    if (bad) { skip(`${label}: “${file!.name}” contains ${bad} character${bad === 1 ? "" : "s"} the paperbook's built-in PDF fonts cannot print (${describeUnprintable(all)}); attach the original PDF for this file`); continue; }
    // Pages whose stored text was machine-read from an image (OCR) are labelled as such.
    const ocrPages = new Set(file!.ocrDonePages ?? []);
    const isOcr = (page: number | null) => file!.method === "ocr-ai" || (page != null && ocrPages.has(page));
    const typedPages = pages.map((p) => ({ page: p.page, lines: typedLines(font, p.text), rupee: p.text.includes("₹"), ocr: isOcr(p.page) }));
    sources.push({ kind: "typed", fileName: file!.name, pages: typedPages });
    info.push(typedPages.some((p) => p.ocr) ? { kind: "typed", ocr: true } : { kind: "typed" });
  }
  // Titles and headings are printed in the index and bookmarks: refused, never printed as "?".
  const printable = (t: string, what: string) => { if (unprintableChars(t)) problems.push(`${what} contains ${describeUnprintable(t)}, which the index font cannot print; write it in English (Latin script)`); };
  printable(spec.title, "The paperbook title");
  if (spec.court) printable(spec.court, "The court / cause title line");
  titles.forEach((t, i) => printable(t, `Entry ${i + 1}'s title`));
  const pixels = [...loaded.values()].reduce((n, l) => n + l.pixels, 0);
  if (pixels > PAPERBOOK_LIMITS.maxTotalImagePixels) problems.push(`The PNG images add up to ${Math.round(pixels / 1_000_000)} megapixels; at most ${PAPERBOOK_LIMITS.maxTotalImagePixels / 1_000_000} can be embedded in one paperbook (use JPEG or PDF for scans)`);
  if (problems.length) throw new DocsError(problems.slice(0, 12).join("; "), 422, "paperbook_sources");
  return { sources, titles, info, uploads: loaded };
}

const count = (s: Source) => (s.kind === "pdf" ? s.pages : s.kind === "image" ? 1 : typedPageCount(s));

/** Upper estimate of the built PDF's size: copied PDFs per use, each image once, drawn pages at a flat rate. */
function estimateBytes(sources: Source[], uploads: Map<string, LoadedUpload>, drawnPages: number): number {
  let n = drawnPages * TEXT_PAGE_BYTES;
  const images = new Set<string>();
  for (const s of sources) {
    if (s.kind === "pdf") n += uploads.get(s.upload)?.up.bytes.byteLength ?? 0;
    else if (s.kind === "image" && !images.has(s.upload)) {
      images.add(s.upload);
      const l = uploads.get(s.upload);
      // A PNG is re-encoded from its pixels (RGB, deflated): count its raw size at half; a JPEG is embedded as is.
      n += l ? (l.type === "png" ? Math.max(l.up.bytes.byteLength, Math.ceil(l.pixels * 1.5)) : l.up.bytes.byteLength) : 0;
    }
  }
  return n;
}

/** Footer label of a page typed by software (never "TRUE COPY"). */
export const TYPED_PAGE_LABEL = { extracted: "TYPED FROM EXTRACTED TEXT", ocr: "TYPED FROM OCR TEXT" } as const;

/**
 * Page number, annexure marker and the bottom-right line: "TRUE COPY" (only ever passed for embedded original bytes) or,
 * on a page typed by software, its typed-text label. The two are exclusive.
 */
function stamp(page: PDFPage, font: PDFFont, bold: PDFFont, o: { number: number; marker: string | null; trueCopy: boolean; typed?: "extracted" | "ocr" | null }) {
  drawAnchoredText(page, { text: String(o.number), font: bold, size: 10, anchor: "bottom-center", margin: 22, background: true });
  if (o.marker) drawAnchoredText(page, { text: o.marker, font: bold, size: 11, anchor: "top-right", margin: 26, background: true });
  if (o.typed) drawAnchoredText(page, { text: TYPED_PAGE_LABEL[o.typed], font, size: 8, anchor: "bottom-right", margin: 22, background: true, color: rgb(0.3, 0.3, 0.3) });
  else if (o.trueCopy) drawAnchoredText(page, { text: "TRUE COPY", font, size: 9, anchor: "bottom-right", margin: 22, background: true });
}

/** Whether an entry's pages may carry the "TRUE COPY" line: requested, an annexure, and its original bytes embedded. */
const mayCarryTrueCopy = (spec: PaperbookSpec, src: Source, marker: string | null) => spec.trueCopy && !!marker && (src.kind === "pdf" || src.kind === "image");

interface IndexLayout { pages: number[][]; titleLines: string[][]; court: string[]; title: string[] }

/**
 * Lay the index out by measured height: the header (court lines, title, "INDEX") and every row's wrapped title. The
 * number of index pages comes from this layout, so the page ranges printed in it are right however long the titles are.
 */
function layoutIndex(font: PDFFont, bold: PDFFont, spec: PaperbookSpec, titles: string[]): IndexLayout {
  const width = A4.w - MARGIN * 2;
  const court = spec.court ? wrapHard(bold, 11, spec.court, width) : [];
  const title = wrapHard(bold, 12, spec.title, width);
  const top = A4.h - MARGIN - (court.length * (11 + 8) + title.length * (12 + 8) + (12 + 8) + 6 + 6 + 14);
  const titleLines = titles.map((t) => wrapHard(font, INDEX_SIZE, t, INDEX_COLS[2] - INDEX_COLS[1] - 8));
  const pages: number[][] = [];
  let cur: number[] = [];
  let y = top;
  titleLines.forEach((lines, i) => {
    const n = Math.max(1, lines.length);
    if (cur.length && y - (n - 1) * INDEX_LINE < INDEX_BOTTOM) { pages.push(cur); cur = []; y = top; }
    cur.push(i);
    y -= n * INDEX_LINE + INDEX_ROW_GAP;
  });
  if (cur.length || !pages.length) pages.push(cur);
  return { pages, titleLines, court, title };
}

function drawIndex(out: PDFDocument, font: PDFFont, bold: PDFFont, rows: PaperbookIndexRow[], layout: IndexLayout): PDFPage[] {
  const pages: PDFPage[] = [];
  for (const [pi, rowIdx] of layout.pages.entries()) {
    const page = out.addPage([A4.w, A4.h]);
    pages.push(page);
    let y = A4.h - MARGIN;
    const center = (s: string, size: number, f: PDFFont) => { page.drawText(s, { x: (A4.w - f.widthOfTextAtSize(s, size)) / 2, y, size, font: f }); y -= size + 8; };
    for (const l of layout.court) center(l, 11, bold);
    for (const l of layout.title) center(l, 12, bold);
    center(pi === 0 ? "INDEX" : "INDEX (contd.)", 12, bold);
    y -= 6;
    ["Sl.", "Particulars", "Annexure", "Pages"].forEach((h, i) => page.drawText(h, { x: INDEX_COLS[i], y, size: INDEX_SIZE, font: bold }));
    y -= 6;
    page.drawLine({ start: { x: MARGIN, y }, end: { x: A4.w - MARGIN, y }, thickness: 0.6, color: rgb(0.2, 0.2, 0.2) });
    y -= 14;
    for (const i of rowIdx) {
      const r = rows[i];
      const lines = layout.titleLines[i];
      page.drawText(`${r.sl}.`, { x: INDEX_COLS[0], y, size: INDEX_SIZE, font });
      lines.forEach((l, k) => page.drawText(l, { x: INDEX_COLS[1], y: y - k * INDEX_LINE, size: INDEX_SIZE, font }));
      if (r.annexure) page.drawText(sanitizeWinAnsi(r.annexure.replace("ANNEXURE ", "")), { x: INDEX_COLS[2], y, size: INDEX_SIZE, font });
      page.drawText(sanitizeWinAnsi(pageRangeLabel(r).replace("–", "-")), { x: INDEX_COLS[3], y, size: INDEX_SIZE, font });
      y -= Math.max(1, lines.length) * INDEX_LINE + INDEX_ROW_GAP;
    }
  }
  return pages;
}

/**
 * Header lines above a typed page: what it was typed from (wrapped, at most three lines; a very long file name is
 * shortened in the header only), then the rupee note on a line of its own when it applies (at most four lines).
 */
function typedHeader(small: PDFFont, fileName: string, page: number | null, contd: boolean, rupee: boolean, ocr: boolean): string[] {
  const name = fileName.length > 80 ? `${fileName.slice(0, 77)}…` : fileName;
  const text = `Typed from the ${ocr ? "OCR (machine-read) text" : "extracted text"} of ${name}${page != null ? `, page ${page}` : ""}${contd ? " (contd.)" : ""}. Not a facsimile of the original; not compared with it.`;
  const lines = wrapHard(small, 7.5, text, HEADER_WIDTH).slice(0, 3);
  return rupee ? [...lines, "The rupee sign is printed as Rs."] : lines;
}

export interface PaperbookBuild { pdf: Uint8Array; index: PaperbookIndexRow[]; totalPages: number; firstPage: number; fileName: string }

/** Build (or, with `preview`, only lay out and index) a paperbook from a set. */
export async function buildPaperbook(principal: Principal, setId: string, rawSpec: unknown, uploadList: PaperbookUpload[] = [], opts: { preview?: boolean } = {}): Promise<PaperbookBuild> {
  const set = await loadSet(principal, setId, "read");
  // The built PDF is an export of the set's documents (the index preview is not): refused before anything is read.
  if (!opts.preview) authorizeSetExport(principal, set, "documents.paperbook");
  const spec = cleanSpec(rawSpec);
  const total = uploadList.reduce((n, u) => n + u.bytes.byteLength, 0);
  if (total > PAPERBOOK_LIMITS.maxUploadBytes) throw new DocsError(`Attachments are limited to ${Math.round(PAPERBOOK_LIMITS.maxUploadBytes / 1024 / 1024)} MB per paperbook request`, 413, "too_large");
  if (uploadList.length > PAPERBOOK_LIMITS.maxEntries) throw new DocsError(`At most ${PAPERBOOK_LIMITS.maxEntries} attachments per paperbook`, 422, "invalid");
  const uploads = new Map(uploadList.map((u) => [u.key, u]));
  const out = await PDFDocument.create();
  const font = await out.embedFont(StandardFonts.TimesRoman);
  const bold = await out.embedFont(StandardFonts.TimesRomanBold);
  const small = await out.embedFont(StandardFonts.Helvetica);
  const { sources, titles, info, uploads: loaded } = await loadSources(set.id, spec, uploads, font);
  const counts = sources.map(count);
  const entries = spec.entries.map((e, i) => ({ title: titles[i], annexure: e.annexure }));
  const layout = spec.indexPage ? layoutIndex(font, bold, spec, titles) : null;
  const computed = computePaperbookIndex(entries, counts, { ...spec, indexPages: layout?.pages.length });
  const { indexPages, totalPages, firstPage } = computed;
  const labels = annexureLabels(spec.entries, spec.prefix);
  const rows = computed.rows.map((r, i) => ({ ...r, source: info[i], trueCopy: mayCarryTrueCopy(spec, sources[i], labels[i]) }));
  if (totalPages > PAPERBOOK_LIMITS.maxPages) throw new DocsError(`The paperbook would have ${totalPages} pages; the limit is ${PAPERBOOK_LIMITS.maxPages}`, 422, "too_many_pages");
  const drawn = indexPages + sources.reduce((n, s, i) => n + (s.kind === "typed" ? counts[i] : 0), 0);
  const estimate = estimateBytes(sources, loaded, drawn);
  if (estimate > PAPERBOOK_LIMITS.maxOutputBytes) throw new DocsError(`The paperbook would be about ${Math.ceil(estimate / 1024 / 1024)} MB; the limit is ${PAPERBOOK_LIMITS.maxOutputBytes / 1024 / 1024} MB. Split it into volumes.`, 413, "too_large");
  const fileName = `${spec.title.replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 80) || "Paperbook"}.pdf`;
  if (opts.preview) return { pdf: new Uint8Array(), index: rows, totalPages, firstPage, fileName };

  const indexPagesList = layout ? drawIndex(out, font, bold, rows, layout) : [];
  let number = firstPage;
  for (const p of indexPagesList) stamp(p, small, bold, { number: number++, marker: null, trueCopy: false });
  const outline: OutlineSpec[] = indexPages ? [{ title: "Index", page: 1 }] : [];
  let trueCopyPages = 0;
  const images = new Map<string, PDFImage>();
  for (const [i, src] of sources.entries()) {
    const startIndex = out.getPageCount() + 1;
    const marker = labels[i];
    const trueCopy = mayCarryTrueCopy(spec, src, marker);
    const added: { page: PDFPage; typed: "extracted" | "ocr" | null }[] = [];
    if (src.kind === "pdf") {
      const doc = loaded.get(src.upload)!.doc!;
      const copied = await out.copyPages(doc, doc.getPageIndices());
      for (const pg of copied) added.push({ page: out.addPage(pg), typed: null });
    } else if (src.kind === "image") {
      let img = images.get(src.upload);
      if (!img) {
        const l = loaded.get(src.upload)!;
        img = l.type === "png" ? await out.embedPng(l.up.bytes) : await out.embedJpg(l.up.bytes);
        images.set(src.upload, img);
      }
      const page = out.addPage([A4.w, A4.h]);
      const s = Math.min((A4.w - MARGIN * 2) / img.width, (A4.h - MARGIN * 2 - 20) / img.height, 1.5);
      page.drawImage(img, { x: (A4.w - img.width * s) / 2, y: (A4.h - img.height * s) / 2, width: img.width * s, height: img.height * s });
      added.push({ page, typed: null });
    } else {
      for (const sp of src.pages) {
        const chunks = Math.max(1, Math.ceil(sp.lines.length / LINES_PER_PAGE));
        for (let c = 0; c < chunks; c++) {
          const page = out.addPage([A4.w, A4.h]);
          const head = typedHeader(small, src.fileName, sp.page, c > 0, sp.rupee, sp.ocr);
          head.forEach((l, k) => page.drawText(l, { x: MARGIN, y: A4.h - MARGIN + 8 + (head.length - 1 - k) * 9, size: 7.5, font: small, color: rgb(0.4, 0.4, 0.4) }));
          let y = A4.h - MARGIN - 20;
          for (const l of sp.lines.slice(c * LINES_PER_PAGE, (c + 1) * LINES_PER_PAGE)) {
            if (l) page.drawText(l, { x: MARGIN, y, size: BODY_SIZE, font });
            y -= LINE;
          }
          added.push({ page, typed: sp.ocr ? "ocr" : "extracted" });
        }
      }
    }
    added.forEach((p, k) => stamp(p.page, small, bold, { number: number++, marker: k === 0 ? marker : null, trueCopy, typed: p.typed }));
    if (trueCopy) trueCopyPages += added.length;
    outline.push({ title: marker ? `${marker} — ${titles[i]}` : titles[i], page: startIndex });
  }
  if (outline.length) setOutline(out, outline);
  out.setTitle(spec.title);
  out.setProducer("LeClaude paperbook");
  out.setCreator("LeClaude");
  out.setCreationDate(new Date());
  const pdf = await out.save();
  if (pdf.byteLength > PAPERBOOK_LIMITS.maxOutputBytes) throw new DocsError(`The paperbook came to ${Math.ceil(pdf.byteLength / 1024 / 1024)} MB; the limit is ${PAPERBOOK_LIMITS.maxOutputBytes / 1024 / 1024} MB. Split it into volumes.`, 413, "too_large");
  const basis = { typed: info.filter((s) => s.kind === "typed").length, originalServerHash: info.filter((s) => s.kind === "original" && s.hash === "server").length, originalBrowserHash: info.filter((s) => s.kind === "original" && s.hash === "browser_declared").length, attachments: info.filter((s) => s.kind === "attachment").length };
  recordAudit(principal, "export", { kind: "document_set", id: set.id, label: set.name, matterId: set.matterId ?? undefined }, { surface: "documents.paperbook", entries: spec.entries.length, pages: totalPages, attached: uploadList.length, sources: basis, trueCopyRequested: spec.trueCopy, trueCopyPages, sha256: sha256(pdf) });
  return { pdf, index: rows, totalPages, firstPage, fileName };
}
