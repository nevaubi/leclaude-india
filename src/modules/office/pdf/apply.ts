/**
 * Apply a PdfModel to its ORIGINAL source bytes with pdf-lib. The source is
 * never re-rendered: fonts, vector content, forms, outlines, page labels and
 * metadata survive; only the requested changes are made.
 *
 *   forms (fill; fields under redactions removed; optional flatten)
 *   → TRUE redaction (content-stream glyph removal; page rasterization only
 *     when editing is not provably safe, reported per page)
 *   → native annotations (deleted/changed ones removed from the file)
 *   → editor annotations (real PDF annotations with appearance streams, or
 *     burned into content when flattening)
 *   → page order / deletion (deleted pages emptied; outline targets pruned)
 *   → rotation → Bates / endorsement / decorations → bookmarks (appended to
 *     the existing outline) → metadata → prune unreachable objects → save.
 */
import { BlendMode, LineCapStyle, PDFDocument, PDFFont, PDFName, PDFPage, StandardFonts, degrees, rgb } from "pdf-lib";
import { annotationSig, readNativeAnnotations, removeNativeAnnotations, writeFreeText, writeInk, writeMarkup, writeNote, writeShape, writeStamp } from "./annotations";
import { clearPageContent, intersects, pruneUnreachable } from "./content-stream";
import { activePages, formatBates, hexToRgb, type BatesConfig, type BatesFont, type PdfAnnotation, type PdfModel, type PdfRect } from "./model";
import { appendOutline, pruneOutlineDests, readOutlineTree, remapOutline } from "./outline";
import { addLinkAnnotation, addTextAnnotation, clearAnnotations, colorOf, drawAnchoredText, drawWatermark, finalRotation, sanitizeWinAnsi, setOutline, wrapLine, type OutlineSpec, type TextAnchor } from "./pdf-lib-utils";
import { redactDocument, redactionRegions, removeFieldsUnder, scrubDocument, scrubText, type RedactionRegion, type RedactionReport } from "./redaction";
import { BRAND } from "@/lib/brand";

/** Server-side page rasterizer for redaction fallback: renders the source page (display orientation) with the boxes painted. */
export type PageRasterizer = (req: { sourcePage: number; boxes: { rect: PdfRect; color: string }[]; rotation: number }) => Promise<Uint8Array>;

export interface ApplyOptions {
  /** Burn annotations into page content. Default false: markups, notes, shapes, ink, text boxes, stamps and links become native PDF annotations. */
  flattenAnnotations?: boolean;
  /** Apply redactions (default true): content under the boxes is removed and the boxes are drawn. */
  applyRedactions?: boolean;
  /** PNG renderings (by SOURCE page number, display orientation, boxes painted) that replace redacted pages. */
  rasterizedPages?: Record<number, Uint8Array>;
  /** Rasterize every redacted page instead of editing its content stream. */
  forceRasterize?: boolean;
  /** Renders pages whose content cannot be edited safely. Without it such pages make the apply fail (never leak). */
  rasterize?: PageRasterizer;
  /** Strings known to be under the redaction boxes (from the text layer) to scrub from metadata, outline and annotations. */
  redactedStrings?: string[];
  /** Stamp Bates numbers from model.bates (default: true when configured and not already applied). */
  bates?: boolean;
  /** Fill AcroForm fields from model.formValues (default true). */
  fillForms?: boolean;
  /** Flatten form fields into static content (also when model.formFlatten). */
  flattenForms?: boolean;
  /** Headers/footers/page numbers/watermark (default true). */
  decorations?: boolean;
  /** Append model.bookmarks to the outline (default true when present). */
  bookmarks?: boolean;
  /** Skip annotations flagged `resolved`. */
  skipResolved?: boolean;
  /** Title to set only when the source carries none and no metadata edit is pending. */
  title?: string;
}

export interface ApplyReport {
  redaction: RedactionReport | null;
  /** Source page number → 1-based output page number (absent = deleted). */
  pageMap: Record<number, number>;
  removedNativeAnnotations: number;
  writtenAnnotations: number;
  prunedObjects: number;
}

interface Fonts { sans: PDFFont; sansBold: PDFFont; serif: PDFFont; mono: PDFFont }

const NOTE_SIZE = 20;

/** Inverse of toUserSpace for rasterized pages: user-space rect → displayed-space rect. */
export function rectToDisplayed(r: PdfRect, w: number, h: number, rot: number): PdfRect {
  const map = (x: number, y: number): [number, number] => {
    switch (rot) {
      case 90: return [y, w - x];
      case 180: return [w - x, h - y];
      case 270: return [h - y, x];
      default: return [x, y];
    }
  };
  const [ax, ay] = map(r.x, r.y), [bx, by] = map(r.x + r.w, r.y + r.h);
  return { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) };
}

const MARKUPS = new Set(["highlight", "underline", "strikeout"]);

export async function applyModel(source: Uint8Array, model: PdfModel, opts: ApplyOptions = {}): Promise<Uint8Array> {
  return (await applyModelWithReport(source, model, opts)).bytes;
}

export async function applyModelWithReport(source: Uint8Array, model: PdfModel, opts: ApplyOptions = {}): Promise<{ bytes: Uint8Array; report: ApplyReport }> {
  const doc = await PDFDocument.load(source, { ignoreEncryption: true, updateMetadata: false });
  const fonts: Fonts = {
    sans: await doc.embedFont(StandardFonts.Helvetica), sansBold: await doc.embedFont(StandardFonts.HelveticaBold), serif: await doc.embedFont(StandardFonts.TimesRoman), mono: await doc.embedFont(StandardFonts.Courier),
  };
  const flatten = opts.flattenAnnotations === true;
  const srcPages = doc.getPages();
  const report: ApplyReport = { redaction: null, pageMap: {}, removedNativeAnnotations: 0, writtenAnnotations: 0, prunedObjects: 0 };
  const sourceNative = model.meta.nativeAnnotations ? readNativeAnnotations(doc) : [];

  // 1. Forms: fill, then drop fields under redaction boxes before any flattening can bake their values in.
  const doRedact = opts.applyRedactions !== false;
  const regions: Map<number, RedactionRegion> = doRedact ? redactionRegions(model, (a) => !(opts.skipResolved && a.resolved)) : new Map();
  if (opts.fillForms !== false && model.formValues && Object.keys(model.formValues).length) fillForm(doc, model.formValues);
  const removedFields: Record<number, string[]> = {};
  for (const [p, reg] of regions) removedFields[p] = removeFieldsUnder(doc, p - 1, reg.rects);
  if (opts.flattenForms || model.formFlatten) { try { doc.getForm().flatten(); } catch { /* no form */ } }
  else if (opts.fillForms !== false && model.formValues && Object.keys(model.formValues).length) { try { doc.getForm().updateFieldAppearances(fonts.sans); } catch { /* ignore */ } }

  // 2. True redaction.
  const raster: Record<number, Uint8Array> = { ...(doRedact ? opts.rasterizedPages ?? {} : {}) };
  if (regions.size) {
    const forceRaster = new Set<number>([...Object.keys(raster).map(Number), ...(opts.forceRasterize ? Array.from(regions.keys()) : [])]);
    const r = redactDocument(doc, regions, { forceRaster });
    for (const pr of r.pages) if (removedFields[pr.page]?.length) pr.removedFields = Array.from(new Set([...removedFields[pr.page], ...pr.removedFields]));
    for (const p of r.needsRaster) {
      if (raster[p]) continue;
      if (!opts.rasterize) throw new Error(`Redaction on page ${p} cannot be applied by editing the content stream (${r.pages.find((x) => x.page === p)?.reason ?? "unsafe"}) and no rasterizer is available; nothing was exported`);
      const reg = regions.get(p)!;
      const mp = model.pages.find((x) => x.index === p);
      raster[p] = await opts.rasterize({ sourcePage: p, boxes: reg.rects.map((rect: PdfRect) => ({ rect, color: reg.color })), rotation: finalRotation(srcPages[p - 1], mp?.rotation ?? 0) });
    }
    const strings = Array.from(new Set([...Array.from(regions.values()).flatMap((x) => x.quotes), ...(opts.redactedStrings ?? [])].map((s) => s.trim()).filter(Boolean)));
    report.redaction = { pages: r.pages, strings, scrubbed: scrubDocument(doc, strings) };
  }

  // 3. Rasterized pages: replace the page's content IN PLACE (same page object, so outline targets and links stay valid).
  const rasterized = new Map<number, { rot: number; w: number; h: number }>();
  for (const [k, png] of Object.entries(raster)) {
    const sourceNo = Number(k);
    const page = srcPages[sourceNo - 1];
    if (!page || !png?.length) continue;
    const mp = model.pages.find((p) => p.index === sourceNo);
    const rot = finalRotation(page, mp?.rotation ?? 0);
    const w = page.getWidth(), h = page.getHeight();
    const [dw, dh] = rot === 90 || rot === 270 ? [h, w] : [w, h];
    removeFieldsUnder(doc, sourceNo - 1, [{ x: -1e5, y: -1e5, w: 2e5, h: 2e5 }]);
    clearPageContent(doc, page);
    const img = await doc.embedPng(png);
    for (const box of ["CropBox", "TrimBox", "BleedBox", "ArtBox"]) page.node.delete(PDFName.of(box));
    page.setMediaBox(0, 0, dw, dh);
    page.setRotation(degrees(0));
    page.drawImage(img, { x: 0, y: 0, width: dw, height: dh });
    rasterized.set(sourceNo, { rot, w, h });
    if (!regions.has(sourceNo)) continue;
    const pr = report.redaction?.pages.find((x) => x.page === sourceNo);
    if (pr) { pr.method = "rasterized"; pr.reason = pr.reason ?? "rasterized"; }
  }

  // 4. Native annotations already in the file: remove those the user deleted, resolved-and-skipped or changed.
  if (sourceNative.length) {
    const inModel = new Map(model.annotations.filter((a) => a.native).map((a) => [a.native!.ref, a]));
    const drop = new Map<number, Set<string>>();
    for (const n of sourceNative) {
      const m = inModel.get(n.native.ref);
      const gone = !m || (opts.skipResolved && m.resolved) || annotationSig(m) !== n.native.sig || (flatten && m.type !== "redaction" && m.type !== "note");
      if (!gone) continue;
      const set = drop.get(n.page) ?? new Set<string>();
      set.add(n.native.ref);
      drop.set(n.page, set);
    }
    for (const [p, refs] of drop) { const page = srcPages[p - 1]; if (page && !rasterized.has(p)) report.removedNativeAnnotations += removeNativeAnnotations(doc, page, refs); }
  }

  // 5. Editor annotations (and changed native ones).
  const regionRects = (p: number) => regions.get(p)?.rects ?? [];
  const strings = report.redaction?.strings ?? [];
  for (const a0 of model.annotations) {
    if (opts.skipResolved && a0.resolved) continue;
    const page = srcPages[a0.page - 1];
    if (!page) continue;
    const src = a0.native ? sourceNative.find((n) => n.native.ref === a0.native!.ref) : undefined;
    const unchangedNative = a0.type !== "redaction" && src && annotationSig(a0) === src.native.sig && !(flatten && a0.type !== "note");
    if (unchangedNative) continue; // left in the file untouched
    if (a0.native && !src && a0.type !== "redaction") continue; // native annotation no longer in this source
    if (a0.type === "redaction" && a0.applied) continue;
    const ras = rasterized.get(a0.page);
    if (ras && a0.type === "redaction") continue; // painted into the raster
    if (a0.type === "redaction" && !doRedact) continue;
    // Markups over redacted text are dropped; other annotation text is scrubbed of the redacted strings.
    if (a0.type !== "redaction" && MARKUPS.has(a0.type) && a0.rects.some((r) => regionRects(a0.page).some((g) => intersects(r, g)))) continue;
    let a: PdfAnnotation = a0.type !== "redaction" && strings.length ? { ...a0, text: a0.text ? scrubText(a0.text, strings) : a0.text, quote: a0.quote ? scrubText(a0.quote, strings) : a0.quote } : a0;
    if (ras) a = { ...a, rects: a.rects.map((r) => rectToDisplayed(r, ras.w, ras.h, ras.rot)), paths: a.paths?.map((p) => p.map((pt) => { const r = rectToDisplayed({ x: pt.x, y: pt.y, w: 0, h: 0 }, ras.w, ras.h, ras.rot); return { x: r.x, y: r.y }; })) };
    if (await drawAnnotation(doc, page, a, fonts, flatten)) report.writtenAnnotations++;
  }

  // 6. Page order / blank pages / deletions
  const ordered = activePages(model);
  const outputPages: { page: PDFPage; model: (typeof ordered)[number] }[] = [];
  for (const mp of ordered) {
    if (mp.blank) { outputPages.push({ page: doc.addPage([mp.width, mp.height]), model: mp }); continue; }
    const p = srcPages[mp.index - 1];
    if (p) outputPages.push({ page: p, model: mp });
  }
  const changedOrder = outputPages.length !== srcPages.length || outputPages.some((o, i) => o.page !== srcPages[i]);
  if (changedOrder) {
    const kept = new Set(outputPages.map((o) => o.page));
    const removed = srcPages.filter((p) => !kept.has(p));
    // Deleted pages: nothing of their content (or their form fields' values) may survive in the file, even through a dangling reference.
    for (const p of removed) removeFieldsUnder(doc, srcPages.indexOf(p), [{ x: -1e5, y: -1e5, w: 2e5, h: 2e5 }]);
    for (let i = doc.getPageCount() - 1; i >= 0; i--) doc.removePage(i);
    for (const o of outputPages) doc.addPage(o.page);
    for (const p of removed) clearPageContent(doc, p);
    pruneOutlineDests(doc, new Set(removed.map((p) => p.ref.toString())));
  }
  outputPages.forEach((o, i) => { if (!o.model.blank) report.pageMap[o.model.index] = i + 1; });

  // 7. Rotation
  for (const o of outputPages) {
    if (rasterized.has(o.model.index)) continue;
    if (o.model.rotation) o.page.setRotation(degrees(finalRotation(o.page, o.model.rotation)));
  }

  // 8. Bates + decorations
  const doBates = opts.bates ?? Boolean(model.bates && !model.bates.applied);
  if (doBates && model.bates) await drawBates(doc, outputPages.map((o) => o.page), model.bates);
  if (opts.decorations !== false && model.decorations) {
    const d = model.decorations;
    const total = outputPages.length;
    outputPages.forEach((o, i) => {
      const sub = (t: string) => t.replace(/\{page\}|\{n\}/g, String(i + (d.pageNumbers?.startAt ?? 1))).replace(/\{pages\}|\{total\}/g, String(total)).replace(/\{date\}/g, new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }));
      if (d.header?.text) drawAnchoredText(o.page, { text: sub(d.header.text), font: fonts.sans, size: d.header.fontSize ?? 9, anchor: d.header.position ?? "top-center", margin: 22, color: rgb(0.25, 0.25, 0.25) });
      if (d.footer?.text) drawAnchoredText(o.page, { text: sub(d.footer.text), font: fonts.sans, size: d.footer.fontSize ?? 9, anchor: d.footer.position ?? "bottom-center", margin: 22, color: rgb(0.25, 0.25, 0.25) });
      if (d.pageNumbers) drawAnchoredText(o.page, { text: sub(d.pageNumbers.format || "Page {page} of {pages}"), font: fonts.sans, size: d.pageNumbers.fontSize ?? 9, anchor: d.pageNumbers.position, margin: 22, color: rgb(0.2, 0.2, 0.2) });
      if (d.watermark?.text) drawWatermark(o.page, { text: d.watermark.text, font: fonts.sansBold, size: d.watermark.fontSize, angle: d.watermark.angle, opacity: d.watermark.opacity, color: d.watermark.color ? colorOf(d.watermark.color) : undefined });
    });
  }

  // 9. Bookmarks (appended after the document's own outline)
  if (opts.bookmarks !== false && model.bookmarks?.length) {
    const items = model.bookmarks
      .map((b) => ({ title: b.title, page: outputPages.findIndex((o) => o.model.index === b.page) + 1, level: b.level ?? 1 }))
      .filter((b) => b.page > 0);
    const nested: OutlineSpec[] = [];
    for (const it of items) {
      if (it.level >= 2 && nested.length) { const parent = nested[nested.length - 1]; (parent.children ??= []).push({ title: it.title, page: it.page }); }
      else nested.push({ title: it.title, page: it.page });
    }
    if (nested.length) appendOutline(doc, nested);
  }

  // 10. Metadata: explicit edits win; otherwise keep the source's own values (a fallback title only when it has none).
  const md = model.metadata;
  if (md?.title !== undefined) doc.setTitle(md.title);
  else if (opts.title && !safeGet(() => doc.getTitle())) doc.setTitle(String(opts.title));
  if (md?.author !== undefined) doc.setAuthor(md.author);
  if (md?.subject !== undefined) doc.setSubject(md.subject);
  if (md?.keywords !== undefined) doc.setKeywords(md.keywords.split(/[,;]\s*/).filter(Boolean));
  if (report.redaction && strings.length) scrubDocument(doc, strings); // edits above must not reintroduce redacted text
  doc.setProducer(`${BRAND.name} PDF (pdf-lib)`);
  doc.setModificationDate(new Date());

  await doc.flush();
  report.prunedObjects = pruneUnreachable(doc);
  const bytes = await doc.save({ useObjectStreams: true });
  return { bytes, report };
}

function safeGet<T>(fn: () => T): T | undefined { try { return fn(); } catch { return undefined; } }

function oppositeCorner(p: TextAnchor): TextAnchor {
  switch (p) {
    case "bottom-right": return "bottom-left";
    case "bottom-left": return "bottom-right";
    case "top-right": return "top-left";
    case "top-left": return "top-right";
    case "bottom-center": return "top-center";
    case "top-center": return "bottom-center";
    default: return "bottom-left";
  }
}

const BATES_FONT_MAP: Record<BatesFont, StandardFonts> = {
  Helvetica: StandardFonts.Helvetica, "Helvetica-Bold": StandardFonts.HelveticaBold, "Times-Roman": StandardFonts.TimesRoman, "Times-Bold": StandardFonts.TimesRomanBold, Courier: StandardFonts.Courier, "Courier-Bold": StandardFonts.CourierBold,
};

/**
 * Draw Bates numbers (and the endorsement legend, when configured) on pages in
 * order. `cfg.pages` (1-based positions in `pages`) limits which pages are
 * stamped; numbering is consecutive over the stamped pages. Returns labels.
 */
export async function drawBates(doc: PDFDocument, pages: PDFPage[], cfg: BatesConfig): Promise<{ page: number; label: string }[]> {
  const font = await doc.embedFont(BATES_FONT_MAP[cfg.font ?? "Helvetica"] ?? StandardFonts.Helvetica);
  const size = cfg.fontSize ?? 9;
  const only = cfg.pages?.length ? new Set(cfg.pages) : null;
  const out: { page: number; label: string }[] = [];
  let n = 0;
  pages.forEach((p, i) => {
    if (only && !only.has(i + 1)) return;
    const label = formatBates(cfg, n++);
    drawAnchoredText(p, { text: label, font, size, anchor: cfg.position, margin: 20, background: true });
    if (cfg.legend) drawAnchoredText(p, { text: cfg.legend, font, size: Math.max(6.5, size - 1.5), anchor: cfg.legendPosition ?? oppositeCorner(cfg.position), margin: 20, color: rgb(0.25, 0.25, 0.25), background: true });
    out.push({ page: i + 1, label });
  });
  return out;
}

/**
 * Stamp Bates numbers onto the original bytes only (no other model changes):
 * used to Bates a production set of documents with one continuous sequence.
 * `sourcePages` are the 1-based source pages to stamp, in numbering order.
 */
export async function stampBatesBytes(source: Uint8Array, sourcePages: number[], cfg: BatesConfig): Promise<{ bytes: Uint8Array; labels: { page: number; label: string }[] }> {
  const doc = await PDFDocument.load(source, { ignoreEncryption: true, updateMetadata: false });
  const all = doc.getPages();
  const targets = sourcePages.map((n) => all[n - 1]).filter(Boolean);
  const drawn = await drawBates(doc, targets, { ...cfg, pages: undefined });
  doc.setModificationDate(new Date());
  await doc.flush();
  pruneUnreachable(doc);
  return { bytes: await doc.save({ useObjectStreams: true }), labels: drawn.map((d, i) => ({ page: sourcePages[i], label: d.label })) };
}

export function fillForm(doc: PDFDocument, values: Record<string, string | boolean>) {
  let form: ReturnType<PDFDocument["getForm"]>;
  try { form = doc.getForm(); } catch { return; }
  for (const [name, value] of Object.entries(values)) {
    let field: ReturnType<typeof form.getField> | null = null;
    try { field = form.getField(name); } catch { field = null; }
    if (!field) continue;
    const ctor = field.constructor.name;
    try {
      if (ctor === "PDFTextField") (field as import("pdf-lib").PDFTextField).setText(sanitizeWinAnsi(String(value ?? "")));
      else if (ctor === "PDFCheckBox") { const cb = field as import("pdf-lib").PDFCheckBox; if (value === true || value === "true" || value === "Yes" || value === "on") cb.check(); else cb.uncheck(); }
      else if (ctor === "PDFRadioGroup") { const r = field as import("pdf-lib").PDFRadioGroup; if (typeof value === "string" && r.getOptions().includes(value)) r.select(value); }
      else if (ctor === "PDFDropdown") { const d = field as import("pdf-lib").PDFDropdown; if (typeof value === "string") { if (!d.getOptions().includes(value)) d.addOptions([value]); d.select(value); } }
      else if (ctor === "PDFOptionList") { const d = field as import("pdf-lib").PDFOptionList; if (typeof value === "string" && d.getOptions().includes(value)) d.select(value); }
    } catch { /* skip invalid value */ }
  }
}

/** Draw (flatten) or write (native) one annotation; returns true when something was produced. */
async function drawAnnotation(doc: PDFDocument, page: PDFPage, a: PdfAnnotation, fonts: Fonts, flatten: boolean): Promise<boolean> {
  const color = colorOf(a.color);
  const opacity = a.opacity ?? 1;
  const rects = a.rects ?? [];
  switch (a.type) {
    case "highlight":
      if (flatten) { for (const r of rects) page.drawRectangle({ x: r.x, y: r.y, width: r.w, height: r.h, color, opacity: Math.min(0.55, opacity || 0.4), blendMode: BlendMode.Multiply }); return rects.length > 0; }
      return Boolean(writeMarkup(doc, page, a, "Highlight"));
    case "underline":
      if (flatten) { for (const r of rects) page.drawLine({ start: { x: r.x, y: r.y + 1 }, end: { x: r.x + r.w, y: r.y + 1 }, thickness: 1.2, color, opacity }); return rects.length > 0; }
      return Boolean(writeMarkup(doc, page, a, "Underline"));
    case "strikeout":
      if (flatten) { for (const r of rects) page.drawLine({ start: { x: r.x, y: r.y + r.h * 0.45 }, end: { x: r.x + r.w, y: r.y + r.h * 0.45 }, thickness: 1.2, color, opacity }); return rects.length > 0; }
      return Boolean(writeMarkup(doc, page, a, "StrikeOut"));
    case "note": {
      // Sticky notes are comments: always a native /Text annotation so the body survives; the icon is also drawn when flattening.
      if (flatten) {
        const r = rects[0] ?? { x: 36, y: page.getHeight() - 56, w: NOTE_SIZE, h: NOTE_SIZE };
        addTextAnnotation(doc, page, { x: r.x, y: r.y }, { author: a.author, contents: a.text ?? "", color: a.color, date: a.createdAt });
        page.drawRectangle({ x: r.x, y: r.y, width: NOTE_SIZE, height: NOTE_SIZE, color, opacity: 0.9, borderColor: rgb(0.3, 0.25, 0), borderWidth: 0.8 });
        page.drawText("…", { x: r.x + 4.5, y: r.y + 7, size: 12, font: fonts.sansBold, color: rgb(0.2, 0.15, 0) });
        return true;
      }
      return Boolean(writeNote(doc, page, a));
    }
    case "text": {
      const r = rects[0];
      if (!r) return false;
      if (!flatten) return Boolean(writeFreeText(doc, page, a, fonts));
      const size = a.fontSize ?? 11;
      const lines = (a.text ?? "").split("\n").flatMap((l) => wrapLine(fonts.sans, size, l, Math.max(10, r.w - 6)));
      let y = r.y + r.h - size - 3;
      for (const line of lines) { if (y < r.y - size * 0.2) break; page.drawText(line, { x: r.x + 3, y, size, font: fonts.sans, color, opacity }); y -= size * 1.25; }
      return true;
    }
    case "rect":
      for (const r of rects) {
        if (flatten) page.drawRectangle({ x: r.x, y: r.y, width: r.w, height: r.h, borderColor: color, borderWidth: a.strokeWidth ?? 1.5, borderOpacity: opacity });
        else writeShape(doc, page, a, "Square", r);
      }
      return rects.length > 0;
    case "ellipse":
      for (const r of rects) {
        if (flatten) page.drawEllipse({ x: r.x + r.w / 2, y: r.y + r.h / 2, xScale: r.w / 2, yScale: r.h / 2, borderColor: color, borderWidth: a.strokeWidth ?? 1.5, borderOpacity: opacity });
        else writeShape(doc, page, a, "Circle", r);
      }
      return rects.length > 0;
    case "freehand": {
      const paths = a.paths ?? [];
      if (!flatten) return Boolean(writeInk(doc, page, a));
      for (const p of paths) for (let i = 1; i < p.length; i++) page.drawLine({ start: p[i - 1], end: p[i], thickness: a.strokeWidth ?? 1.8, color, opacity, lineCap: LineCapStyle.Round });
      return paths.length > 0;
    }
    case "stamp": {
      const r = rects[0];
      if (!r) return false;
      if (!flatten) return Boolean(writeStamp(doc, page, a, fonts));
      const text = sanitizeWinAnsi((a.text ?? "STAMP").toUpperCase());
      let size = Math.min(r.h * 0.6, 28);
      while (size > 6 && fonts.sansBold.widthOfTextAtSize(text, size) > r.w - 14) size -= 1;
      const tw = fonts.sansBold.widthOfTextAtSize(text, size);
      page.drawRectangle({ x: r.x, y: r.y, width: r.w, height: r.h, borderColor: color, borderWidth: 2, borderOpacity: opacity, color: rgb(1, 1, 1), opacity: 0.001 });
      page.drawText(text, { x: r.x + (r.w - tw) / 2, y: r.y + (r.h - size * 0.72) / 2, size, font: fonts.sansBold, color, opacity });
      return true;
    }
    case "redaction": {
      const { r: cr, g: cg, b: cb } = hexToRgb(a.color || "#111111");
      for (const r of rects) {
        page.drawRectangle({ x: r.x - 0.5, y: r.y - 0.5, width: r.w + 1, height: r.h + 1, color: rgb(cr, cg, cb) });
        if (a.reason) {
          const size = 6.5;
          const label = sanitizeWinAnsi(a.reason);
          if (fonts.sans.widthOfTextAtSize(label, size) < r.w - 4 && r.h > size + 2) page.drawText(label, { x: r.x + 2, y: r.y + (r.h - size) / 2 + 1, size, font: fonts.sans, color: rgb(1, 1, 1) });
        }
      }
      return rects.length > 0;
    }
    case "link": {
      const r = rects[0];
      if (!r || !a.href) return false;
      addLinkAnnotation(doc, page, r, a.href, { color: a.color, border: false });
      if (flatten) page.drawLine({ start: { x: r.x, y: r.y + 1 }, end: { x: r.x + r.w, y: r.y + 1 }, thickness: 0.8, color, opacity: 0.8 });
      return true;
    }
    case "signature": {
      const r = rects[0];
      if (!r || !a.imageDataUrl) return false;
      const bytes = dataUrlBytes(a.imageDataUrl);
      if (!bytes) return false;
      const img = a.imageDataUrl.startsWith("data:image/jpeg") ? await doc.embedJpg(bytes) : await doc.embedPng(bytes);
      const scale = Math.min(r.w / img.width, r.h / img.height);
      const w = img.width * scale, h = img.height * scale;
      page.drawImage(img, { x: r.x + (r.w - w) / 2, y: r.y + (r.h - h) / 2, width: w, height: h, opacity });
      return true;
    }
  }
  return false;
}

export function dataUrlBytes(dataUrl: string): Uint8Array | null {
  const i = dataUrl.indexOf(",");
  if (i < 0) return null;
  try { return Uint8Array.from(Buffer.from(dataUrl.slice(i + 1), dataUrl.slice(0, i).includes(";base64") ? "base64" : "utf8")); } catch { return null; }
}

function docLabel(doc: PDFDocument, fallback: string) { return safeGet(() => doc.getTitle()) || fallback; }

/**
 * Append every page of `others` to `base`. The base outline is kept; each
 * appended document contributes a top-level bookmark (its title) with its own
 * outline nested under it. Annotations travel with their pages.
 */
export async function mergePdfs(base: Uint8Array, others: Uint8Array[], names: string[] = []): Promise<{ bytes: Uint8Array; added: { width: number; height: number; rotation: number }[] }> {
  const doc = await PDFDocument.load(base, { ignoreEncryption: true, updateMetadata: false });
  const added: { width: number; height: number; rotation: number }[] = [];
  const outlineItems: OutlineSpec[] = [];
  for (let k = 0; k < others.length; k++) {
    const src = await PDFDocument.load(others[k], { ignoreEncryption: true, updateMetadata: false });
    const firstPage = doc.getPageCount() + 1;
    const tree = readOutlineTree(src);
    const pages = await doc.copyPages(src, src.getPageIndices());
    for (const p of pages) { doc.addPage(p); added.push({ width: p.getWidth(), height: p.getHeight(), rotation: p.getRotation().angle }); }
    const inner = remapOutline(tree, src.getPageIndices()).map(function shift(s: OutlineSpec): OutlineSpec { return { title: s.title, page: s.page + firstPage - 1, children: s.children?.map(shift) }; });
    if (pages.length && (inner.length || readOutlineTree(doc).length)) outlineItems.push({ title: names[k] || docLabel(src, `Document ${k + 2}`), page: firstPage, children: inner.length ? inner : undefined });
  }
  if (outlineItems.length) appendOutline(doc, outlineItems);
  await doc.flush();
  pruneUnreachable(doc);
  return { bytes: await doc.save({ useObjectStreams: true }), added };
}

/** New document from a list of 1-based source page numbers (in the given order); bookmarks into those pages are carried over. */
export async function extractPages(source: Uint8Array, sourcePageNumbers: number[], title?: string): Promise<Uint8Array> {
  const src = await PDFDocument.load(source, { ignoreEncryption: true, updateMetadata: false });
  const out = await PDFDocument.create();
  const idx = sourcePageNumbers.map((n) => n - 1).filter((i) => i >= 0 && i < src.getPageCount());
  const pages = await out.copyPages(src, idx);
  for (const p of pages) out.addPage(p);
  const outline = remapOutline(readOutlineTree(src), idx);
  if (outline.length) setOutline(out, outline);
  const author = safeGet(() => src.getAuthor()), subject = safeGet(() => src.getSubject()), keywords = safeGet(() => src.getKeywords());
  if (author) out.setAuthor(author);
  if (subject) out.setSubject(subject);
  if (keywords) out.setKeywords([keywords]);
  if (title) out.setTitle(title);
  out.setProducer(`${BRAND.name} PDF (pdf-lib)`);
  return out.save({ useObjectStreams: true });
}

/** Re-save with object streams, dropping unreachable objects; the outline, forms, labels and metadata are kept. */
export async function compressPdf(source: Uint8Array): Promise<Uint8Array> {
  const doc = await PDFDocument.load(source, { ignoreEncryption: true, updateMetadata: false });
  doc.setProducer(`${BRAND.name} PDF (pdf-lib, compressed)`);
  await doc.flush();
  pruneUnreachable(doc);
  return doc.save({ useObjectStreams: true, addDefaultPage: false });
}

/** Fill (and optionally flatten) form fields; returns new bytes. */
export async function fillFormFields(source: Uint8Array, values: Record<string, string | boolean>, flatten = false): Promise<Uint8Array> {
  const doc = await PDFDocument.load(source, { ignoreEncryption: true, updateMetadata: false });
  fillForm(doc, values);
  try { if (flatten) doc.getForm().flatten(); else doc.getForm().updateFieldAppearances(await doc.embedFont(StandardFonts.Helvetica)); } catch { /* no form */ }
  await doc.flush();
  pruneUnreachable(doc);
  return doc.save({ useObjectStreams: true });
}

/** Strip every annotation object from all pages (used after flattening). */
export async function stripAnnotations(source: Uint8Array): Promise<Uint8Array> {
  const doc = await PDFDocument.load(source, { ignoreEncryption: true });
  for (const p of doc.getPages()) clearAnnotations(p);
  await doc.flush();
  pruneUnreachable(doc);
  return doc.save({ useObjectStreams: true });
}
