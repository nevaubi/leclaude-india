/**
 * Small typesetting engine on top of pdf-lib used to generate realistic legal
 * PDFs (templates and seeds): caption blocks, headings, inline bold/italic,
 * hanging numbered paragraphs, tables, signature blocks, AcroForm fields,
 * outlines, footers with "Page x of y" and optional burned-in Bates numbers.
 */
import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb, type PDFForm } from "pdf-lib";
import { formatBates, type BatesConfig } from "./model";
import { drawAnchoredText, sanitizeWinAnsi, setOutline, type OutlineSpec } from "./pdf-lib-utils";
import { BRAND } from "@/lib/brand";

export interface CaptionSpec {
  /** Court name lines (centered, bold). */
  court: string[];
  /** Left column: parties. */
  left: string[];
  /** Right column: case number, judge, etc. */
  right: string[];
  /** Document title lines (centered, bold) below the caption box. */
  title?: string[];
}

export type Block =
  | { type: "heading"; text: string; level?: 1 | 2 | 3; align?: "left" | "center"; bookmark?: boolean }
  | { type: "paragraph"; text: string; indent?: boolean; align?: "left" | "center" | "right"; size?: number; before?: number; after?: number; italic?: boolean; bold?: boolean; font?: "serif" | "sans" | "mono" }
  | { type: "numbered"; number: string; text: string; indent?: number }
  | { type: "bullets"; items: string[] }
  | { type: "keyvalue"; rows: [string, string][]; keyWidth?: number }
  | { type: "table"; columns: string[]; rows: string[][]; widths?: number[]; size?: number }
  | { type: "signature"; lines: string[]; align?: "left" | "right"; dateLine?: string }
  | { type: "field"; name: string; label: string; kind: "text" | "checkbox" | "dropdown"; value?: string | boolean; options?: string[]; width?: number }
  | { type: "spacer"; height: number }
  | { type: "rule" }
  | { type: "pagebreak" };

export interface DocSpec {
  title: string;
  author?: string;
  subject?: string;
  keywords?: string[];
  pageSize?: [number, number];
  margins?: { top: number; right: number; bottom: number; left: number };
  fontSize?: number;
  lineHeight?: number;
  caption?: CaptionSpec;
  blocks: Block[];
  footer?: { left?: string; center?: string; right?: string };
  /** Burn Bates numbers into every page at generation time (produced documents). */
  bates?: Omit<BatesConfig, "applied">;
  /** Build an outline from level 1–2 headings. Default true. */
  outline?: boolean;
  /** Stamp text drawn diagonally on page 1 (e.g. "DRAFT"). */
  draftStamp?: string;
}

interface Fonts { serif: PDFFont; serifBold: PDFFont; serifItalic: PDFFont; serifBoldItalic: PDFFont; sans: PDFFont; sansBold: PDFFont; mono: PDFFont }
interface Run { text: string; bold?: boolean; italic?: boolean }
interface Word { text: string; font: PDFFont; width: number; space: number }

const DEFAULT_MARGINS = { top: 72, right: 72, bottom: 72, left: 72 };

/** Parse **bold**, *italic* and ***both*** into runs. */
export function parseRuns(text: string): Run[] {
  const runs: Run[] = [];
  const re = /(\*\*\*([^*]+)\*\*\*)|(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(__([^_]+)__)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) runs.push({ text: text.slice(last, m.index) });
    if (m[1]) runs.push({ text: m[2], bold: true, italic: true });
    else if (m[3]) runs.push({ text: m[4], bold: true });
    else if (m[5]) runs.push({ text: m[6], italic: true });
    else if (m[7]) runs.push({ text: m[8], bold: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) runs.push({ text: text.slice(last) });
  return runs.filter((r) => r.text);
}

function fontFor(f: Fonts, run: Run, family: "serif" | "sans" | "mono" = "serif") {
  if (family === "mono") return f.mono;
  if (family === "sans") return run.bold ? f.sansBold : f.sans;
  if (run.bold && run.italic) return f.serifBoldItalic;
  if (run.bold) return f.serifBold;
  if (run.italic) return f.serifItalic;
  return f.serif;
}

/** Break runs into words with per-word font/width. */
function tokenize(f: Fonts, runs: Run[], size: number, family?: "serif" | "sans" | "mono"): Word[] {
  const words: Word[] = [];
  for (const run of runs) {
    const font = fontFor(f, run, family);
    const parts = sanitizeWinAnsi(run.text).split(/(\s+)/);
    for (const part of parts) {
      if (!part) continue;
      if (/^\s+$/.test(part)) { if (words.length) words[words.length - 1].space = font.widthOfTextAtSize(" ", size); continue; }
      words.push({ text: part, font, width: font.widthOfTextAtSize(part, size), space: 0 });
    }
  }
  return words;
}

function layoutLines(words: Word[], maxWidth: number, firstIndent = 0): Word[][] {
  const lines: Word[][] = [];
  let cur: Word[] = [];
  let width = firstIndent;
  for (const w of words) {
    const add = (cur.length ? cur[cur.length - 1].space : 0) + w.width;
    if (cur.length && width + add > maxWidth) { lines.push(cur); cur = [w]; width = w.width; }
    else { cur.push(w); width += add; }
  }
  if (cur.length) lines.push(cur);
  return lines;
}

class Typesetter {
  doc!: PDFDocument;
  fonts!: Fonts;
  page!: PDFPage;
  form!: PDFForm;
  y = 0;
  pages: PDFPage[] = [];
  outline: OutlineSpec[] = [];
  readonly size: number;
  readonly lh: number;
  readonly m: { top: number; right: number; bottom: number; left: number };
  readonly pageSize: [number, number];
  fieldCount = 0;

  constructor(readonly spec: DocSpec) {
    this.size = spec.fontSize ?? 11.5;
    this.lh = (spec.lineHeight ?? 1.32) * this.size;
    this.m = spec.margins ?? DEFAULT_MARGINS;
    this.pageSize = spec.pageSize ?? [612, 792];
  }

  get width() { return this.pageSize[0] - this.m.left - this.m.right; }

  async init() {
    this.doc = await PDFDocument.create();
    const [serif, serifBold, serifItalic, serifBoldItalic, sans, sansBold, mono] = await Promise.all([
      this.doc.embedFont(StandardFonts.TimesRoman), this.doc.embedFont(StandardFonts.TimesRomanBold), this.doc.embedFont(StandardFonts.TimesRomanItalic), this.doc.embedFont(StandardFonts.TimesRomanBoldItalic),
      this.doc.embedFont(StandardFonts.Helvetica), this.doc.embedFont(StandardFonts.HelveticaBold), this.doc.embedFont(StandardFonts.Courier),
    ]);
    this.fonts = { serif, serifBold, serifItalic, serifBoldItalic, sans, sansBold, mono };
    this.form = this.doc.getForm();
    this.newPage();
  }

  newPage() {
    this.page = this.doc.addPage(this.pageSize);
    this.pages.push(this.page);
    this.y = this.pageSize[1] - this.m.top;
  }

  ensure(height: number) {
    if (this.y - height < this.m.bottom) this.newPage();
  }

  /** Draw a line of words at (x, y) with the given font sizes; returns line width. */
  drawWords(words: Word[], x: number, y: number, size: number, justifyTo?: number) {
    let cx = x;
    const natural = words.reduce((s, w, i) => s + w.width + (i < words.length - 1 ? w.space : 0), 0);
    const extra = justifyTo && words.length > 1 ? Math.max(0, (justifyTo - natural) / (words.length - 1)) : 0;
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      this.page.drawText(w.text, { x: cx, y, size, font: w.font, color: rgb(0.08, 0.08, 0.08) });
      cx += w.width + (i < words.length - 1 ? w.space + extra : 0);
    }
    return cx - x;
  }

  paragraph(text: string, o: { indent?: boolean; align?: "left" | "center" | "right"; size?: number; before?: number; after?: number; italic?: boolean; bold?: boolean; hanging?: { label: string; width: number }; family?: "serif" | "sans" | "mono"; x?: number; width?: number } = {}) {
    const size = o.size ?? this.size;
    const lh = size * (this.spec.lineHeight ?? 1.32);
    const runs = parseRuns(text).map((r) => ({ ...r, bold: r.bold || o.bold, italic: r.italic || o.italic }));
    const words = tokenize(this.fonts, runs, size, o.family);
    const x0 = o.x ?? this.m.left + (o.hanging ? o.hanging.width : 0);
    const maxW = (o.width ?? this.width) - (o.hanging ? o.hanging.width : 0);
    const firstIndent = o.indent ? 36 : 0;
    const lines = layoutLines(words, maxW, firstIndent);
    this.y -= o.before ?? 0;
    this.ensure(Math.min(lines.length, 2) * lh);
    lines.forEach((line, i) => {
      if (this.y - lh < this.m.bottom) this.newPage();
      const lw = line.reduce((s, w, j) => s + w.width + (j < line.length - 1 ? w.space : 0), 0);
      let x = x0 + (i === 0 ? firstIndent : 0);
      if (o.align === "center") x = x0 + (maxW - lw) / 2;
      else if (o.align === "right") x = x0 + maxW - lw;
      if (i === 0 && o.hanging) this.page.drawText(sanitizeWinAnsi(o.hanging.label), { x: this.m.left, y: this.y - size, size, font: this.fonts.serif, color: rgb(0.08, 0.08, 0.08) });
      this.drawWords(line, x, this.y - size, size, o.align === undefined && i < lines.length - 1 && lines.length > 1 && line.length > 3 ? maxW - (i === 0 ? firstIndent : 0) : undefined);
      this.y -= lh;
    });
    this.y -= o.after ?? lh * 0.55;
  }

  heading(text: string, level: 1 | 2 | 3 = 1, align: "left" | "center" = level === 1 ? "center" : "left", bookmark = true) {
    const size = level === 1 ? this.size + 1.5 : level === 2 ? this.size + 0.5 : this.size;
    this.ensure(size * 4);
    this.y -= level === 1 ? 10 : 6;
    const pageNo = this.pages.length;
    const label = sanitizeWinAnsi(text);
    const font = level === 3 ? this.fonts.serifBoldItalic : this.fonts.serifBold;
    const lines = layoutLines(tokenize(this.fonts, [{ text: label, bold: true, italic: level === 3 }], size), this.width);
    for (const line of lines) {
      const lw = line.reduce((s, w, j) => s + w.width + (j < line.length - 1 ? w.space : 0), 0);
      const x = align === "center" ? this.m.left + (this.width - lw) / 2 : this.m.left;
      this.drawWords(line, x, this.y - size, size, undefined);
      this.y -= size * 1.4;
    }
    void font;
    this.y -= 4;
    if (bookmark && level <= 2) {
      if (level === 1 || !this.outline.length) this.outline.push({ title: text.replace(/\*/g, ""), page: pageNo, children: [] });
      else this.outline[this.outline.length - 1].children!.push({ title: text.replace(/\*/g, ""), page: pageNo });
    }
  }

  caption(c: CaptionSpec) {
    const size = this.size;
    for (const line of c.court) this.paragraph(`**${line.toUpperCase()}**`, { align: "center", after: 2 });
    this.y -= 14;
    const colW = this.width / 2 - 18;
    const startY = this.y;
    // left column
    const leftLines: string[] = [];
    for (const l of c.left) leftLines.push(...wrapRuns(this.fonts, l, size, colW));
    const rightLines: string[] = [];
    for (const l of c.right) rightLines.push(...wrapRuns(this.fonts, l, size, colW));
    const n = Math.max(leftLines.length, rightLines.length);
    const lh = size * 1.4;
    this.ensure(n * lh + 20);
    let y = this.y;
    for (let i = 0; i < n; i++) {
      const l = leftLines[i], r = rightLines[i];
      if (l !== undefined) this.drawWords(tokenize(this.fonts, parseRuns(l), size), this.m.left, y - size, size);
      this.page.drawText(")", { x: this.m.left + this.width / 2 - 4, y: y - size, size, font: this.fonts.serif });
      if (r !== undefined) this.drawWords(tokenize(this.fonts, parseRuns(r), size), this.m.left + this.width / 2 + 16, y - size, size);
      y -= lh;
    }
    this.y = y - 4;
    this.page.drawLine({ start: { x: this.m.left, y: this.y }, end: { x: this.m.left + this.width / 2 - 2, y: this.y }, thickness: 0.8, color: rgb(0.1, 0.1, 0.1) });
    void startY;
    this.y -= 18;
    for (const t of c.title ?? []) this.paragraph(`**${t.toUpperCase()}**`, { align: "center", after: 4 });
    this.y -= 8;
  }

  table(columns: string[], rows: string[][], widths?: number[], size = this.size - 1.5) {
    const fr = widths ?? columns.map(() => 1 / columns.length);
    const total = fr.reduce((a, b) => a + b, 0);
    const colW = fr.map((f) => (f / total) * this.width);
    const pad = 4;
    const lh = size * 1.3;
    const drawRow = (cells: string[], header: boolean) => {
      const wrapped = cells.map((c, i) => wrapRuns(this.fonts, c, size, colW[i] - pad * 2, header));
      const h = Math.max(1, ...wrapped.map((w) => w.length)) * lh + pad * 2;
      if (this.y - h < this.m.bottom) { this.newPage(); if (!header) drawRow(columns, true); }
      const top = this.y;
      if (header) this.page.drawRectangle({ x: this.m.left, y: top - h, width: this.width, height: h, color: rgb(0.92, 0.92, 0.9) });
      let x = this.m.left;
      cells.forEach((_, i) => {
        this.page.drawRectangle({ x, y: top - h, width: colW[i], height: h, borderColor: rgb(0.45, 0.45, 0.45), borderWidth: 0.6 });
        wrapped[i].forEach((line, li) => this.drawWords(tokenize(this.fonts, (header ? parseRuns(line).map((r) => ({ ...r, bold: true })) : parseRuns(line)), size), x + pad, top - pad - size - li * lh, size));
        x += colW[i];
      });
      this.y = top - h;
    };
    this.ensure(lh * 3);
    drawRow(columns, true);
    for (const r of rows) drawRow(columns.map((_, i) => r[i] ?? ""), false);
    this.y -= this.lh * 0.8;
  }

  keyvalue(rows: [string, string][], keyWidth = 150) {
    for (const [k, v] of rows) {
      const lines = wrapRuns(this.fonts, v, this.size, this.width - keyWidth);
      this.ensure(lines.length * this.lh);
      this.drawWords(tokenize(this.fonts, [{ text: sanitizeWinAnsi(k), bold: true }], this.size), this.m.left, this.y - this.size, this.size);
      lines.forEach((l, i) => { this.drawWords(tokenize(this.fonts, parseRuns(l), this.size), this.m.left + keyWidth, this.y - this.size, this.size); if (i < lines.length - 1) this.y -= this.lh; });
      this.y -= this.lh * 1.15;
    }
    this.y -= this.lh * 0.3;
  }

  signature(lines: string[], align: "left" | "right" = "right", dateLine?: string) {
    const blockW = 250;
    const x = align === "right" ? this.m.left + this.width - blockW : this.m.left;
    this.ensure((lines.length + 4) * this.lh);
    if (dateLine) { this.page.drawText(sanitizeWinAnsi(dateLine), { x: this.m.left, y: this.y - this.size, size: this.size, font: this.fonts.serif }); }
    this.y -= this.lh * 1.2;
    this.page.drawText("Respectfully submitted,", { x, y: this.y - this.size, size: this.size, font: this.fonts.serif });
    this.y -= this.lh * 2.4;
    this.page.drawLine({ start: { x, y: this.y }, end: { x: x + blockW, y: this.y }, thickness: 0.7, color: rgb(0.1, 0.1, 0.1) });
    this.y -= this.lh * 0.2;
    for (const l of lines) { this.drawWords(tokenize(this.fonts, parseRuns(l), this.size - 0.5), x, this.y - this.size, this.size - 0.5); this.y -= this.lh * 0.95; }
    this.y -= this.lh * 0.6;
  }

  field(name: string, label: string, kind: "text" | "checkbox" | "dropdown", value?: string | boolean, options?: string[], width = 260) {
    const h = kind === "checkbox" ? 13 : 20;
    this.ensure(h + this.lh);
    const labelW = this.fonts.serif.widthOfTextAtSize(sanitizeWinAnsi(label), this.size);
    if (kind === "checkbox") {
      const cb = this.form.createCheckBox(name);
      cb.addToPage(this.page, { x: this.m.left, y: this.y - h, width: h, height: h, borderWidth: 1, borderColor: rgb(0.3, 0.3, 0.3), backgroundColor: rgb(1, 1, 1) });
      if (value === true) cb.check();
      this.page.drawText(sanitizeWinAnsi(label), { x: this.m.left + h + 8, y: this.y - h + 3, size: this.size, font: this.fonts.serif });
      this.y -= h + this.lh * 0.5;
      return;
    }
    this.page.drawText(sanitizeWinAnsi(label), { x: this.m.left, y: this.y - this.size - 3, size: this.size, font: this.fonts.serif });
    const fx = this.m.left + labelW + 10;
    if (kind === "dropdown") {
      const dd = this.form.createDropdown(name);
      dd.addOptions(options ?? []);
      if (typeof value === "string" && value) dd.select(value);
      dd.addToPage(this.page, { x: fx, y: this.y - h, width, height: h, borderWidth: 1, borderColor: rgb(0.3, 0.3, 0.3), backgroundColor: rgb(0.99, 0.99, 0.94), font: this.fonts.sans });
    } else {
      const tf = this.form.createTextField(name);
      if (typeof value === "string") tf.setText(sanitizeWinAnsi(value));
      tf.addToPage(this.page, { x: fx, y: this.y - h, width, height: h, borderWidth: 1, borderColor: rgb(0.3, 0.3, 0.3), backgroundColor: rgb(0.99, 0.99, 0.94), font: this.fonts.sans });
    }
    this.fieldCount++;
    this.y -= h + this.lh * 0.6;
  }

  run() {
    const s = this.spec;
    if (s.caption) this.caption(s.caption);
    for (const b of s.blocks) {
      switch (b.type) {
        case "heading": this.heading(b.text, b.level ?? 1, b.align, b.bookmark ?? true); break;
        case "paragraph": {
          const lines = b.text.split("\n");
          lines.forEach((line, i) => this.paragraph(line, { indent: b.indent, align: b.align, size: b.size, before: i === 0 ? b.before : 0, after: i < lines.length - 1 ? 1 : b.after, italic: b.italic, bold: b.bold, family: b.font }));
          break;
        }
        case "numbered": this.paragraph(b.text, { hanging: { label: b.number, width: b.indent ?? 36 } }); break;
        case "bullets": for (const it of b.items) this.paragraph(it, { hanging: { label: "•", width: 18 }, after: this.lh * 0.25 }); this.y -= this.lh * 0.3; break;
        case "keyvalue": this.keyvalue(b.rows, b.keyWidth); break;
        case "table": this.table(b.columns, b.rows, b.widths, b.size); break;
        case "signature": this.signature(b.lines, b.align, b.dateLine); break;
        case "field": this.field(b.name, b.label, b.kind, b.value, b.options, b.width); break;
        case "spacer": this.y -= b.height; break;
        case "rule": this.ensure(12); this.page.drawLine({ start: { x: this.m.left, y: this.y - 4 }, end: { x: this.m.left + this.width, y: this.y - 4 }, thickness: 0.6, color: rgb(0.4, 0.4, 0.4) }); this.y -= 14; break;
        case "pagebreak": this.newPage(); break;
      }
    }
    if (this.fieldCount) this.form.updateFieldAppearances(this.fonts.sans);
    // footers, page numbers, bates
    const total = this.pages.length;
    this.pages.forEach((p, i) => {
      const f = s.footer ?? {};
      const sub = (t?: string) => (t ?? "").replace(/\{page\}/g, String(i + 1)).replace(/\{pages\}/g, String(total));
      const size = 9;
      if (f.left) drawAnchoredText(p, { text: sub(f.left), font: this.fonts.serif, size, anchor: "bottom-left", margin: 36, color: rgb(0.3, 0.3, 0.3) });
      if (f.right) drawAnchoredText(p, { text: sub(f.right), font: this.fonts.serif, size, anchor: "bottom-right", margin: 36, color: rgb(0.3, 0.3, 0.3) });
      drawAnchoredText(p, { text: sub(f.center ?? `Page {page} of {pages}`), font: this.fonts.serif, size, anchor: "bottom-center", margin: 36, color: rgb(0.3, 0.3, 0.3) });
      if (s.bates) {
        drawAnchoredText(p, { text: formatBates(s.bates, i), font: this.fonts.sans, size: s.bates.fontSize ?? 9, anchor: s.bates.position, margin: 20 });
        if (s.bates.legend) drawAnchoredText(p, { text: s.bates.legend, font: this.fonts.sans, size: 7.5, anchor: s.bates.position.endsWith("right") ? "bottom-left" : "bottom-right", margin: 20, color: rgb(0.25, 0.25, 0.25) });
      }
    });
    if (s.draftStamp) {
      const p = this.pages[0];
      const font = this.fonts.sansBold;
      const size = 26;
      const text = sanitizeWinAnsi(s.draftStamp);
      const tw = font.widthOfTextAtSize(text, size);
      p.drawRectangle({ x: this.pageSize[0] - this.m.right - tw - 24, y: this.pageSize[1] - 46, width: tw + 20, height: size + 12, borderColor: rgb(0.75, 0.1, 0.1), borderWidth: 2, opacity: 0, borderOpacity: 0.8 });
      p.drawText(text, { x: this.pageSize[0] - this.m.right - tw - 14, y: this.pageSize[1] - 36, size, font, color: rgb(0.75, 0.1, 0.1), opacity: 0.8 });
    }
    if (s.outline !== false && this.outline.length) setOutline(this.doc, this.outline.map((o) => ({ ...o, children: o.children?.length ? o.children : undefined })));
    this.doc.setTitle(s.title);
    if (s.author) this.doc.setAuthor(s.author);
    if (s.subject) this.doc.setSubject(s.subject);
    if (s.keywords) this.doc.setKeywords(s.keywords);
    this.doc.setCreator(`${BRAND.name} PDF`);
    this.doc.setProducer(`${BRAND.name} PDF (pdf-lib)`);
    this.doc.setCreationDate(new Date());
    this.doc.setModificationDate(new Date());
  }
}

function wrapRuns(f: Fonts, text: string, size: number, maxWidth: number, bold = false): string[] {
  // Wrap while keeping inline markdown; we wrap on the plain words and re-emit markdown per line approximately.
  const words = tokenize(f, parseRuns(bold ? `**${text}**` : text), size);
  const lines = layoutLines(words, maxWidth);
  return lines.map((l) => l.map((w) => (w.font === f.serifBold || w.font === f.sansBold ? `**${w.text}**` : w.font === f.serifItalic ? `*${w.text}*` : w.font === f.serifBoldItalic ? `***${w.text}***` : w.text)).join(" "));
}

/** Generate a PDF from a document spec. */
export async function generatePdf(spec: DocSpec): Promise<Uint8Array> {
  const t = new Typesetter(spec);
  await t.init();
  t.run();
  return t.doc.save({ useObjectStreams: false });
}

/** Generate a blank page document (used for "insert blank" previews and tests). */
export async function blankPdf(pages = 1, size: [number, number] = [612, 792]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage(size);
  return doc.save();
}
