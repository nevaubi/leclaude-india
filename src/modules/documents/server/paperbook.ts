import "server-only";
import { createHash } from "node:crypto";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { Principal } from "@/lib/auth/types";
import { drawAnchoredText, sanitizeWinAnsi, setOutline, wrapLine, type OutlineSpec } from "@/modules/office/pdf/pdf-lib-utils";
import { annexureLabels, computePaperbookIndex, PAPERBOOK_LIMITS, pageRangeLabel, type AnnexurePrefix, type PaperbookIndexRow, type PaperbookSpec } from "../drafting";
import { DocsError, loadSet } from "./access";
import { pagesFromChunks } from "./extract";
import { recordAudit } from "./sets";
import { docStore } from "./store";

/**
 * Paperbook builder: the chosen files in order, an index page, continuous page numbers stamped on every page, an
 * annexure marker on the first page of each annexure, optional "TRUE COPY" on annexure pages, and a bookmark per entry.
 *
 * Sources, never substituted:
 *  - an original PDF attached for a set file is used only when its SHA-256 equals the hash stored for that file;
 *  - a set file without an attached original is typed from its stored text, one source page at a time, each page headed
 *    as typed text (not a facsimile). Text the built-in PDF fonts cannot print (e.g. Devanagari) is refused, not
 *    replaced with "?": the original must be attached instead;
 *  - an attachment that is not in the set (PDF, PNG or JPEG) is embedded as is (images one per page).
 * The index (title, annexure, page range) is computed in code from the page counts.
 */

export interface PaperbookUpload { key: string; name: string; mime: string; bytes: Uint8Array }

const A4 = { w: 595.28, h: 841.89 };
const MARGIN = 56;
const BODY_SIZE = 11;
const LINE = 15;

type Source =
  | { kind: "pdf"; doc: PDFDocument; pages: number }
  | { kind: "image"; bytes: Uint8Array; type: "png" | "jpg" }
  | { kind: "typed"; fileName: string; pages: { page: number | null; lines: string[] }[] };

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function sniff(bytes: Uint8Array): "pdf" | "png" | "jpg" | null {
  if (bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return "pdf";
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  return null;
}

/** Characters the standard PDF fonts cannot print (counted, never silently replaced). */
export function unprintableChars(text: string): number {
  const before = (text.match(/\?/g) ?? []).length;
  return (sanitizeWinAnsi(text).match(/\?/g) ?? []).length - before;
}

/** Lines of one typed page (wrapped to the text width). */
function typedLines(font: PDFFont, text: string): string[] {
  const width = A4.w - MARGIN * 2;
  const out: string[] = [];
  for (const para of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (!para.trim()) { out.push(""); continue; }
    out.push(...wrapLine(font, BODY_SIZE, para, width));
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

async function loadSources(setId: string, spec: PaperbookSpec, uploads: Map<string, PaperbookUpload>, font: PDFFont): Promise<{ sources: Source[]; titles: string[] }> {
  const store = await docStore();
  const sources: Source[] = [];
  const titles: string[] = [];
  const problems: string[] = [];
  for (const [i, e] of spec.entries.entries()) {
    const label = `Entry ${i + 1}`;
    const up = e.uploadKey ? uploads.get(e.uploadKey) : undefined;
    if (e.uploadKey && !up) { problems.push(`${label}: the attached file is missing from the request`); sources.push({ kind: "typed", fileName: "", pages: [] }); titles.push(e.title); continue; }
    const file = e.fileId ? await store.getFile(setId, e.fileId) : null;
    if (e.fileId && !file) { problems.push(`${label}: the file is not in this set`); sources.push({ kind: "typed", fileName: "", pages: [] }); titles.push(e.title); continue; }
    titles.push(e.title || file?.name || up?.name || `Document ${i + 1}`);
    if (up) {
      const type = sniff(up.bytes);
      if (file && up.bytes.length && sha256(up.bytes) !== file.sha256) { problems.push(`${label}: the attached original of “${file.name}” does not match the file in the set (SHA-256 differs)`); sources.push({ kind: "typed", fileName: "", pages: [] }); continue; }
      if (type === "pdf") {
        try {
          const doc = await PDFDocument.load(up.bytes, { updateMetadata: false });
          sources.push({ kind: "pdf", doc, pages: doc.getPageCount() });
        } catch (err) {
          problems.push(`${label}: “${up.name}” could not be read as a PDF (${/encrypt/i.test((err as Error).message) ? "it is encrypted" : "damaged or unsupported"})`);
          sources.push({ kind: "typed", fileName: "", pages: [] });
        }
      } else if (type === "png" || type === "jpg") sources.push({ kind: "image", bytes: up.bytes, type });
      else { problems.push(`${label}: “${up.name}” is not a PDF, PNG or JPEG`); sources.push({ kind: "typed", fileName: "", pages: [] }); }
      continue;
    }
    // A set file typed from its stored text.
    const pages = pagesFromChunks(await store.fileChunks(file!.id));
    if (!pages.some((p) => p.text.trim())) { problems.push(`${label}: “${file!.name}” has no stored text (scanned pages need OCR, or attach the original PDF)`); sources.push({ kind: "typed", fileName: "", pages: [] }); continue; }
    const bad = pages.reduce((n, p) => n + unprintableChars(p.text), 0);
    if (bad) { problems.push(`${label}: “${file!.name}” contains ${bad} character${bad === 1 ? "" : "s"} (for example Indian-language script) that the paperbook's built-in fonts cannot print; attach the original PDF for this file`); sources.push({ kind: "typed", fileName: "", pages: [] }); continue; }
    sources.push({ kind: "typed", fileName: file!.name, pages: pages.map((p) => ({ page: p.page, lines: typedLines(font, p.text) })) });
  }
  if (problems.length) throw new DocsError(problems.slice(0, 12).join("; "), 422, "paperbook_sources");
  return { sources, titles };
}

const count = (s: Source) => (s.kind === "pdf" ? s.pages : s.kind === "image" ? 1 : typedPageCount(s));

function stamp(page: PDFPage, font: PDFFont, bold: PDFFont, o: { number: number; marker: string | null; trueCopy: boolean }) {
  drawAnchoredText(page, { text: String(o.number), font: bold, size: 10, anchor: "bottom-center", margin: 22, background: true });
  if (o.marker) drawAnchoredText(page, { text: o.marker, font: bold, size: 11, anchor: "top-right", margin: 26, background: true });
  if (o.trueCopy) drawAnchoredText(page, { text: "TRUE COPY", font, size: 9, anchor: "bottom-right", margin: 22, background: true });
}

function drawIndex(out: PDFDocument, font: PDFFont, bold: PDFFont, spec: PaperbookSpec, rows: PaperbookIndexRow[], pagesNeeded: number): PDFPage[] {
  const pages: PDFPage[] = [];
  const cols = [MARGIN, MARGIN + 34, A4.w - MARGIN - 150, A4.w - MARGIN - 60];
  const per = PAPERBOOK_LIMITS.indexRowsPerPage;
  for (let pi = 0; pi < pagesNeeded; pi++) {
    const page = out.addPage([A4.w, A4.h]);
    pages.push(page);
    let y = A4.h - MARGIN;
    const center = (t: string, size: number, f: PDFFont) => { const s = sanitizeWinAnsi(t); page.drawText(s, { x: (A4.w - f.widthOfTextAtSize(s, size)) / 2, y, size, font: f }); y -= size + 8; };
    if (spec.court) for (const l of wrapLine(bold, 11, spec.court, A4.w - MARGIN * 2)) center(l, 11, bold);
    center(spec.title, 12, bold);
    center(pi === 0 ? "INDEX" : "INDEX (contd.)", 12, bold);
    y -= 6;
    const head = ["Sl.", "Particulars", "Annexure", "Pages"];
    head.forEach((h, i) => page.drawText(h, { x: cols[i], y, size: 10, font: bold }));
    y -= 6;
    page.drawLine({ start: { x: MARGIN, y }, end: { x: A4.w - MARGIN, y }, thickness: 0.6, color: rgb(0.2, 0.2, 0.2) });
    y -= 14;
    for (const r of rows.slice(pi * per, pi * per + per)) {
      const title = wrapLine(font, 10, r.title, cols[2] - cols[1] - 8);
      page.drawText(`${r.sl}.`, { x: cols[0], y, size: 10, font });
      title.slice(0, 2).forEach((l, i) => page.drawText(i === 1 && title.length > 2 ? `${l} ...` : l, { x: cols[1], y: y - i * 12, size: 10, font }));
      if (r.annexure) page.drawText(sanitizeWinAnsi(r.annexure.replace("ANNEXURE ", "")), { x: cols[2], y, size: 10, font });
      page.drawText(sanitizeWinAnsi(pageRangeLabel(r).replace("–", "-")), { x: cols[3], y, size: 10, font });
      y -= Math.min(2, title.length) * 12 + 8;
    }
  }
  return pages;
}

export interface PaperbookBuild { pdf: Uint8Array; index: PaperbookIndexRow[]; totalPages: number; firstPage: number; fileName: string }

/** Build (or, with `preview`, only lay out and index) a paperbook from a set. */
export async function buildPaperbook(principal: Principal, setId: string, rawSpec: unknown, uploadList: PaperbookUpload[] = [], opts: { preview?: boolean } = {}): Promise<PaperbookBuild> {
  const set = await loadSet(principal, setId, "read");
  const spec = cleanSpec(rawSpec);
  const total = uploadList.reduce((n, u) => n + u.bytes.byteLength, 0);
  if (total > PAPERBOOK_LIMITS.maxUploadBytes) throw new DocsError(`Attachments are limited to ${Math.round(PAPERBOOK_LIMITS.maxUploadBytes / 1024 / 1024)} MB per paperbook request`, 413, "too_large");
  const uploads = new Map(uploadList.map((u) => [u.key, u]));
  const out = await PDFDocument.create();
  const font = await out.embedFont(StandardFonts.TimesRoman);
  const bold = await out.embedFont(StandardFonts.TimesRomanBold);
  const small = await out.embedFont(StandardFonts.Helvetica);
  const { sources, titles } = await loadSources(set.id, spec, uploads, font);
  const counts = sources.map(count);
  const entries = spec.entries.map((e, i) => ({ title: titles[i], annexure: e.annexure }));
  const { rows, indexPages, totalPages, firstPage } = computePaperbookIndex(entries, counts, spec);
  if (totalPages > PAPERBOOK_LIMITS.maxPages) throw new DocsError(`The paperbook would have ${totalPages} pages; the limit is ${PAPERBOOK_LIMITS.maxPages}`, 422, "too_many_pages");
  const fileName = `${spec.title.replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 80) || "Paperbook"}.pdf`;
  if (opts.preview) return { pdf: new Uint8Array(), index: rows, totalPages, firstPage, fileName };

  const labels = annexureLabels(spec.entries, spec.prefix);
  const indexPagesList = drawIndex(out, font, bold, spec, rows, indexPages);
  let number = firstPage;
  for (const p of indexPagesList) stamp(p, small, bold, { number: number++, marker: null, trueCopy: false });
  const outline: OutlineSpec[] = indexPages ? [{ title: "Index", page: 1 }] : [];
  for (const [i, src] of sources.entries()) {
    const startIndex = out.getPageCount() + 1;
    const marker = labels[i];
    const trueCopy = spec.trueCopy && !!marker;
    const added: PDFPage[] = [];
    if (src.kind === "pdf") {
      const copied = await out.copyPages(src.doc, src.doc.getPageIndices());
      for (const pg of copied) added.push(out.addPage(pg));
    } else if (src.kind === "image") {
      const img = src.type === "png" ? await out.embedPng(src.bytes) : await out.embedJpg(src.bytes);
      const page = out.addPage([A4.w, A4.h]);
      const s = Math.min((A4.w - MARGIN * 2) / img.width, (A4.h - MARGIN * 2 - 20) / img.height, 1.5);
      page.drawImage(img, { x: (A4.w - img.width * s) / 2, y: (A4.h - img.height * s) / 2, width: img.width * s, height: img.height * s });
      added.push(page);
    } else {
      for (const sp of src.pages) {
        const chunks = Math.max(1, Math.ceil(sp.lines.length / LINES_PER_PAGE));
        for (let c = 0; c < chunks; c++) {
          const page = out.addPage([A4.w, A4.h]);
          const head = `Typed from the extracted text of ${src.fileName}${sp.page != null ? `, page ${sp.page}` : ""}${c ? " (contd.)" : ""}. Not a facsimile of the original.`;
          page.drawText(sanitizeWinAnsi(head).slice(0, 140), { x: MARGIN, y: A4.h - MARGIN + 8, size: 7.5, font: small, color: rgb(0.4, 0.4, 0.4) });
          let y = A4.h - MARGIN - 20;
          for (const l of sp.lines.slice(c * LINES_PER_PAGE, (c + 1) * LINES_PER_PAGE)) {
            if (l) page.drawText(l, { x: MARGIN, y, size: BODY_SIZE, font });
            y -= LINE;
          }
          added.push(page);
        }
      }
    }
    added.forEach((p, k) => stamp(p, small, bold, { number: number++, marker: k === 0 ? marker : null, trueCopy }));
    outline.push({ title: marker ? `${marker} — ${titles[i]}` : titles[i], page: startIndex });
  }
  if (outline.length) setOutline(out, outline);
  out.setTitle(spec.title);
  out.setProducer("LeClaude paperbook");
  out.setCreator("LeClaude");
  out.setCreationDate(new Date());
  const pdf = await out.save();
  recordAudit(principal, "export", { kind: "document_set", id: set.id, label: set.name, matterId: set.matterId ?? undefined }, { surface: "documents.paperbook", entries: spec.entries.length, pages: totalPages, attached: uploadList.length, sha256: sha256(pdf) });
  return { pdf, index: rows, totalPages, firstPage, fileName };
}
