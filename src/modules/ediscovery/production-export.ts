import "server-only";
import JSZip from "jszip";
import { PDFDocument, StandardFonts, rgb, type PDFFont } from "pdf-lib";
import { db } from "@/lib/db";
import type { EDocument, ProductionSet, Redaction } from "@/lib/types/domain";
import { generateDat, generateOpt } from "./production-pure";
import { formatBates, parseBates } from "./query";
import { applyTextRedactions, pageRects } from "./redaction-pure";
import { redactionsForMatter, productions } from "./review-store";
import { matterDocs } from "./service";
import { BRAND } from "@/lib/brand";

const PAGE_W = 612, PAGE_H = 792, MARGIN = 54, FONT_SIZE = 9.5, LEADING = 12.5;

/** Split extracted text into logical pages the way the viewer does (form feeds, else evenly by paragraph). */
export function splitPages(text: string, pages: number): string[] {
  if (text.includes("\f")) return text.split("\f").map((p) => p.replace(/^\n+/, ""));
  if (pages <= 1) return [text];
  const paras = text.split(/\n\n+/);
  const per = Math.ceil(paras.length / pages);
  const out: string[] = [];
  for (let i = 0; i < paras.length; i += per) out.push(paras.slice(i, i + per).join("\n\n"));
  while (out.length < pages) out.push("");
  return out;
}

function wrap(line: string, font: PDFFont, size: number, width: number): string[] {
  const words = line.split(/\s+/);
  const out: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (font.widthOfTextAtSize(next, size) <= width) { cur = next; continue; }
    if (cur) out.push(cur);
    // very long token: hard-break
    let rest = w;
    while (font.widthOfTextAtSize(rest, size) > width && rest.length > 1) {
      let n = rest.length;
      while (n > 1 && font.widthOfTextAtSize(rest.slice(0, n), size) > width) n--;
      out.push(rest.slice(0, n));
      rest = rest.slice(n);
    }
    cur = rest;
  }
  if (cur) out.push(cur);
  return out.length ? out : [""];
}

const sanitize = (s: string) => s.replace(/[^\x20-\x7E\n]/g, (c) => (c === "\t" ? "    " : c === "—" ? "-" : c === "–" ? "-" : "?"));

/**
 * Render a produced document as an image-surrogate PDF: one PDF page per logical
 * page (overflow continues on extra pages), production Bates on every page, the
 * confidentiality stamp in the footer, text redactions already applied and page
 * rectangles drawn as black boxes with their label.
 */
export async function renderProductionPdf(doc: EDocument, bates: { begin: string; pages: number }, redactions: Redaction[], stampText: string): Promise<Uint8Array> {
  return (await renderProductionPdfWithMap(doc, bates, redactions, stampText)).bytes;
}

/**
 * Same render, plus the logical page each PDF sheet belongs to (a long logical
 * page continues on extra sheets), which the viewer's Image tab uses to attach
 * page redactions to the sheet they will be burned on.
 */
export async function renderProductionPdfWithMap(doc: EDocument, bates: { begin: string; pages: number }, redactions: Redaction[], stampText: string): Promise<{ bytes: Uint8Array; pageMap: number[] }> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(bates.begin);
  pdf.setSubject(doc.subject);
  pdf.setProducer(`${BRAND.name} e-discovery production`);
  const mono = await pdf.embedFont(StandardFonts.Courier);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const { text } = applyTextRedactions(doc.text, redactions);
  const logical = splitPages(text, bates.pages);
  const start = parseBates(bates.begin);
  const width = PAGE_W - MARGIN * 2;
  const pageMap: number[] = [];
  for (let p = 0; p < Math.max(1, logical.length); p++) {
    const pageBates = start ? formatBates(start.prefix, start.number + Math.min(p, bates.pages - 1), start.width) : bates.begin;
    const lines = sanitize(logical[p] ?? "").split("\n").flatMap((l) => wrap(l, mono, FONT_SIZE, width));
    const perPage = Math.floor((PAGE_H - MARGIN * 2 - 24) / LEADING);
    const chunks: string[][] = [];
    for (let i = 0; i < Math.max(1, lines.length); i += perPage) chunks.push(lines.slice(i, i + perPage));
    chunks.forEach((chunk, ci) => {
      pageMap.push(p + 1);
      const page = pdf.addPage([PAGE_W, PAGE_H]);
      let y = PAGE_H - MARGIN;
      for (const line of chunk) { page.drawText(line, { x: MARGIN, y: y - FONT_SIZE, size: FONT_SIZE, font: mono, color: rgb(0.1, 0.1, 0.1) }); y -= LEADING; }
      // Page-rectangle redactions (normalised to the logical page) on the first PDF page of that logical page.
      if (ci === 0) {
        for (const r of pageRects(redactions, p + 1)) {
          const rect = r.rect!;
          const x = MARGIN + rect.x * width, h = rect.h * (PAGE_H - MARGIN * 2), yTop = PAGE_H - MARGIN - rect.y * (PAGE_H - MARGIN * 2);
          page.drawRectangle({ x, y: yTop - h, width: rect.w * width, height: h, color: rgb(0, 0, 0) });
          const label = sanitize(r.label);
          const size = 7;
          if (bold.widthOfTextAtSize(label, size) < rect.w * width - 4 && h > 10) page.drawText(label, { x: x + 2, y: yTop - h / 2 - size / 2, size, font: bold, color: rgb(1, 1, 1) });
        }
      }
      const footer = `${pageBates}${ci > 0 ? ` (cont. ${ci + 1})` : ""}`;
      page.drawText(footer, { x: PAGE_W - MARGIN - bold.widthOfTextAtSize(footer, 8), y: MARGIN / 2, size: 8, font: bold, color: rgb(0, 0, 0) });
      if (stampText) page.drawText(sanitize(stampText), { x: MARGIN, y: MARGIN / 2, size: 7, font: bold, color: rgb(0.25, 0.25, 0.25) });
    });
  }
  return { bytes: await pdf.save(), pageMap };
}

export function productionLoadFiles(id: string): { dat: string; opt: string; production: ProductionSet } {
  const p = productions().get(id);
  if (!p) throw Object.assign(new Error(`No production ${id}`), { status: 404 });
  const docs = matterDocs(p.matterId);
  const redactedIds = new Set(redactionsForMatter(p.matterId).map((r) => r.docId));
  return { dat: generateDat({ production: p, docs, redactedIds }), opt: generateOpt({ production: p }), production: p };
}

/**
 * Production volume as a zip: DAT/OPT load files, redacted TEXT/, image-surrogate
 * PDFs under IMAGES/, the QC report and a README; documents in production order.
 */
export async function buildProductionZip(id: string, opts: { maxPdfDocs?: number } = {}): Promise<{ bytes: Uint8Array; filename: string; files: number }> {
  const { dat, opt, production: p } = productionLoadFiles(id);
  const matter = db().matters.get(p.matterId);
  const byId = new Map(matterDocs(p.matterId).map((d) => [d.id, d]));
  const allRedactions = redactionsForMatter(p.matterId);
  const zip = new JSZip();
  const vol = p.volume;
  zip.file(`${vol}/DATA/${vol}.dat`, dat);
  zip.file(`${vol}/DATA/${vol}.opt`, opt);
  let files = 2;
  const max = opts.maxPdfDocs ?? 500;
  for (const [i, docId] of p.docIds.entries()) {
    const d = byId.get(docId);
    const b = p.bates[docId];
    if (!d || !b) continue;
    const rds = allRedactions.filter((r) => r.docId === docId);
    zip.file(`${vol}/TEXT/${b.begin}.txt`, applyTextRedactions(d.text, rds).text);
    files++;
    if (i < max) { zip.file(`${vol}/IMAGES/${b.begin}.pdf`, await renderProductionPdf(d, b, rds, p.stampText)); files++; }
  }
  zip.file(`${vol}/QC-report.json`, JSON.stringify(p.qc ?? { note: "QC has not been run" }, null, 2));
  zip.file(`${vol}/README.txt`, [`Production ${p.name} (${vol})`, `Matter: ${matter?.name ?? p.matterId}`, `Status: ${p.status}`, `Documents: ${p.docIds.length}`, `Bates: ${p.prefix} from ${formatBates(p.prefix, p.startNumber, p.padding)}`, `Stamp: ${p.stampText || "(none)"}`, "", "DATA/ — Concordance DAT (þ/¶ delimiters) and Opticon OPT load files", "TEXT/ — extracted text with redactions applied", "IMAGES/ — image surrogates (PDF per document; TIFFs referenced in the OPT are rendered from these at delivery)", "QC-report.json — privilege, family, PII and coding checks at export time"].join("\n"));
  files += 2;
  const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  return { bytes, filename: `${(matter?.slug ?? p.matterId).replace(/[^a-z0-9-]/gi, "-")}-${vol}.zip`, files };
}
