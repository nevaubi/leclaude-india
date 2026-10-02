/**
 * Low-level pdf-lib helpers shared by the generator and the export pipeline:
 * WinAnsi-safe text, rotation-aware placement (a page that displays rotated
 * still has its user space unrotated), outlines/bookmarks and native
 * annotation dictionaries (sticky notes, links, text markups).
 */
import { PDFArray, PDFDocument, PDFFont, PDFHexString, PDFName, PDFNull, PDFNumber, PDFObject, PDFPage, PDFRef, PDFString, degrees, rgb, type Color } from "pdf-lib";

/** Literal dictionary accepted by PDFContext.obj(). */
type DictLiteral = Record<string, PDFObject | string | number | boolean | null | undefined | (PDFObject | number | string)[]>;
import { hexToRgb, type PdfRect } from "./model";

export type TextAnchor = "top-left" | "top-center" | "top-right" | "bottom-left" | "bottom-center" | "bottom-right" | "center";

const WINANSI_EXTRA = new Set("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ".split("").map((c) => c.charCodeAt(0)));
const REPLACEMENTS: Record<string, string> = { "→": "->", "←": "<-", "≤": "<=", "≥": ">=", "−": "-", "‑": "-", " ": " ", " ": " ", "′": "'", "″": '"', "­": "", " ": " ", "​": "", "﻿": "", "‐": "-", "‒": "-", "―": "—", "’": "’", "✓": "x", "✔": "x", "□": "[ ]", "☐": "[ ]", "☑": "[x]", "≠": "!=", "·": "·", "…": "…", "₹": "Rs." };

/** Replace characters the 14 standard fonts cannot encode (the rupee sign becomes "Rs."; anything else unknown, "?"). */
export function sanitizeWinAnsi(text: string): string {
  let out = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if ((cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff) || WINANSI_EXTRA.has(cp) || ch === "\n" || ch === "\t") { out += ch; continue; }
    if (REPLACEMENTS[ch] !== undefined) { out += REPLACEMENTS[ch]; continue; }
    out += "?";
  }
  return out.replace(/\t/g, "    ");
}

export function colorOf(hex: string | undefined, fallback = "#111111"): Color {
  const { r, g, b } = hexToRgb(hex || fallback);
  return rgb(r, g, b);
}

/** Final display rotation of a page (intrinsic /Rotate plus the model's extra rotation), normalized to 0/90/180/270. */
export function finalRotation(page: PDFPage, extra = 0) {
  return ((Math.round((page.getRotation().angle + extra) / 90) * 90) % 360 + 360) % 360;
}

/** Size of the page as displayed (swapped for 90/270). */
export function displayedSize(page: PDFPage, rot: number) {
  const w = page.getWidth(), h = page.getHeight();
  return rot === 90 || rot === 270 ? { w: h, h: w } : { w, h };
}

/**
 * Map a point given in "displayed" coordinates (origin bottom-left of the page
 * as the viewer shows it, y up) into user space, and return the text rotation
 * that keeps horizontal text horizontal on screen.
 */
export function toUserSpace(page: PDFPage, rot: number, dx: number, dy: number): { x: number; y: number; rotate: number } {
  const w = page.getWidth(), h = page.getHeight();
  switch (rot) {
    case 90: return { x: w - dy, y: dx, rotate: 90 };
    case 180: return { x: w - dx, y: h - dy, rotate: 180 };
    case 270: return { x: dy, y: h - dx, rotate: 270 };
    default: return { x: dx, y: dy, rotate: 0 };
  }
}

export interface AnchoredTextOptions {
  text: string;
  font: PDFFont;
  size: number;
  anchor: TextAnchor;
  margin?: number;
  color?: Color;
  opacity?: number;
  /** Final display rotation (see finalRotation). */
  rotation?: number;
  /** Draw a white box behind the text (production stamps on dark scans). */
  background?: boolean;
}

/** Draw single-line text anchored to a corner/edge of the displayed page. */
export function drawAnchoredText(page: PDFPage, o: AnchoredTextOptions) {
  const rot = o.rotation ?? finalRotation(page);
  const { w: W, h: H } = displayedSize(page, rot);
  const text = sanitizeWinAnsi(o.text);
  const tw = o.font.widthOfTextAtSize(text, o.size);
  const m = o.margin ?? 24;
  const asc = o.size * 0.75;
  let dx = m, dy = m;
  if (o.anchor.endsWith("center") && o.anchor !== "center") dx = (W - tw) / 2;
  else if (o.anchor.endsWith("right")) dx = W - m - tw;
  if (o.anchor === "center") { dx = (W - tw) / 2; dy = (H - asc) / 2; }
  else if (o.anchor.startsWith("top")) dy = H - m - asc;
  const u = toUserSpace(page, rot, dx, dy);
  if (o.background) {
    const bg = toUserSpace(page, rot, dx - 3, dy - o.size * 0.25);
    const bw = tw + 6, bh = o.size * 1.25;
    const size = rot === 90 || rot === 270 ? { width: bh, height: bw } : { width: bw, height: bh };
    const pos = rot === 90 ? { x: bg.x - bh, y: bg.y } : rot === 180 ? { x: bg.x - bw, y: bg.y - bh } : rot === 270 ? { x: bg.x, y: bg.y - bw } : { x: bg.x, y: bg.y };
    page.drawRectangle({ ...pos, ...size, color: rgb(1, 1, 1), opacity: 0.85 });
  }
  page.drawText(text, { x: u.x, y: u.y, size: o.size, font: o.font, color: o.color ?? rgb(0.1, 0.1, 0.1), opacity: o.opacity ?? 1, rotate: degrees(u.rotate) });
  return { width: tw, x: u.x, y: u.y };
}

/** Diagonal watermark centered on the displayed page. */
export function drawWatermark(page: PDFPage, o: { text: string; font: PDFFont; size?: number; angle?: number; opacity?: number; color?: Color; rotation?: number }) {
  const rot = o.rotation ?? finalRotation(page);
  const { w: W, h: H } = displayedSize(page, rot);
  const text = sanitizeWinAnsi(o.text);
  const size = o.size ?? Math.min(96, Math.max(28, (W * 1.35) / Math.max(4, text.length)));
  const tw = o.font.widthOfTextAtSize(text, size);
  const a = ((o.angle ?? 45) * Math.PI) / 180;
  const cx = tw / 2, cy = size * 0.35;
  const ox = cx * Math.cos(a) - cy * Math.sin(a);
  const oy = cx * Math.sin(a) + cy * Math.cos(a);
  const u = toUserSpace(page, rot, W / 2 - ox, H / 2 - oy);
  page.drawText(text, { x: u.x, y: u.y, size, font: o.font, color: o.color ?? rgb(0.55, 0.55, 0.55), opacity: o.opacity ?? 0.15, rotate: degrees(u.rotate + (o.angle ?? 45)) });
}

/** Greedy word wrap for a single font. */
export function wrapLine(font: PDFFont, size: number, text: string, maxWidth: number): string[] {
  const words = sanitizeWinAnsi(text).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const candidate = cur ? `${cur} ${w}` : w;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth || !cur) cur = candidate;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines;
}

// ----------------------------------------------------------------------------
// Outlines (bookmarks)
// ----------------------------------------------------------------------------

export interface OutlineSpec { title: string; page: number; children?: OutlineSpec[] }

/** Replace the document outline with the given items (page numbers are 1-based indices into the current page order). */
export function setOutline(doc: PDFDocument, items: OutlineSpec[]) {
  const ctx = doc.context;
  const pages = doc.getPages();
  if (!items.length) { doc.catalog.delete(PDFName.of("Outlines")); return; }
  const rootRef = ctx.nextRef();
  const build = (list: OutlineSpec[], parent: PDFRef): { first: PDFRef; last: PDFRef; count: number } => {
    const refs = list.map(() => ctx.nextRef());
    let total = 0;
    list.forEach((it, i) => {
      const page = pages[Math.min(Math.max(1, it.page), pages.length) - 1];
      const dict: DictLiteral = { Title: PDFHexString.fromText(it.title), Parent: parent, Dest: ctx.obj([page.ref, PDFName.of("XYZ"), PDFNull, PDFNumber.of(page.getHeight()), PDFNull]) };
      if (i > 0) dict.Prev = refs[i - 1];
      if (i < list.length - 1) dict.Next = refs[i + 1];
      total++;
      if (it.children?.length) {
        const sub = build(it.children, refs[i]);
        dict.First = sub.first; dict.Last = sub.last; dict.Count = PDFNumber.of(sub.count);
        total += sub.count;
      }
      ctx.assign(refs[i], ctx.obj(dict));
    });
    return { first: refs[0], last: refs[refs.length - 1], count: total };
  };
  const top = build(items, rootRef);
  ctx.assign(rootRef, ctx.obj({ Type: PDFName.of("Outlines"), First: top.first, Last: top.last, Count: PDFNumber.of(top.count) }));
  doc.catalog.set(PDFName.of("Outlines"), rootRef);
}

// ----------------------------------------------------------------------------
// Native annotations
// ----------------------------------------------------------------------------

function annotBase(subtype: string, rect: PdfRect, o: { author?: string; contents?: string; color?: string; opacity?: number; date?: string }) {
  const c = hexToRgb(o.color ?? "#FACC15");
  const d: DictLiteral = {
    Type: PDFName.of("Annot"),
    Subtype: PDFName.of(subtype),
    Rect: [rect.x, rect.y, rect.x + rect.w, rect.y + rect.h],
    F: PDFNumber.of(4),
    C: [c.r, c.g, c.b],
    CA: PDFNumber.of(o.opacity ?? 1),
  };
  if (o.author) d.T = PDFHexString.fromText(o.author);
  if (o.contents) d.Contents = PDFHexString.fromText(o.contents);
  if (o.date) d.M = PDFString.fromDate(new Date(o.date));
  return d;
}

/** Sticky note (/Text) annotation, shown as a comment icon in Acrobat/Preview. */
export function addTextAnnotation(doc: PDFDocument, page: PDFPage, at: { x: number; y: number }, o: { author?: string; contents: string; color?: string; date?: string; open?: boolean }) {
  const dict = annotBase("Text", { x: at.x, y: at.y, w: 20, h: 20 }, o);
  dict.Name = PDFName.of("Comment");
  dict.Open = o.open ?? false;
  const ref = doc.context.register(doc.context.obj(dict));
  page.node.addAnnot(ref);
  return ref;
}

/** Link annotation with a URI action. */
export function addLinkAnnotation(doc: PDFDocument, page: PDFPage, rect: PdfRect, url: string, o: { color?: string; border?: boolean } = {}) {
  const dict = annotBase("Link", rect, { color: o.color ?? "#2563EB" });
  dict.Border = [0, 0, o.border ? 1 : 0];
  dict.A = doc.context.obj({ Type: PDFName.of("Action"), S: PDFName.of("URI"), URI: PDFString.of(url) });
  delete dict.CA;
  const ref = doc.context.register(doc.context.obj(dict));
  page.node.addAnnot(ref);
  return ref;
}

/** Text markup annotation (/Highlight, /Underline, /StrikeOut) from line rects. */
export function addMarkupAnnotation(doc: PDFDocument, page: PDFPage, kind: "Highlight" | "Underline" | "StrikeOut", rects: PdfRect[], o: { author?: string; contents?: string; color?: string; opacity?: number; date?: string }) {
  if (!rects.length) return null;
  const x1 = Math.min(...rects.map((r) => r.x)), y1 = Math.min(...rects.map((r) => r.y));
  const x2 = Math.max(...rects.map((r) => r.x + r.w)), y2 = Math.max(...rects.map((r) => r.y + r.h));
  const dict = annotBase(kind, { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }, o);
  const quads: number[] = [];
  for (const r of rects) quads.push(r.x, r.y + r.h, r.x + r.w, r.y + r.h, r.x, r.y, r.x + r.w, r.y);
  dict.QuadPoints = quads;
  const ref = doc.context.register(doc.context.obj(dict));
  page.node.addAnnot(ref);
  return ref;
}

/** Square / Circle annotation. */
export function addShapeAnnotation(doc: PDFDocument, page: PDFPage, kind: "Square" | "Circle", rect: PdfRect, o: { author?: string; contents?: string; color?: string; opacity?: number; strokeWidth?: number; date?: string }) {
  const dict = annotBase(kind, rect, o);
  dict.BS = doc.context.obj({ W: PDFNumber.of(o.strokeWidth ?? 1.5), S: PDFName.of("S") });
  const ref = doc.context.register(doc.context.obj(dict));
  page.node.addAnnot(ref);
  return ref;
}

/** Ink annotation from freehand paths. */
export function addInkAnnotation(doc: PDFDocument, page: PDFPage, rect: PdfRect, paths: { x: number; y: number }[][], o: { author?: string; contents?: string; color?: string; opacity?: number; strokeWidth?: number; date?: string }) {
  const dict = annotBase("Ink", rect, o);
  dict.InkList = paths.map((p) => doc.context.obj(p.flatMap((pt) => [pt.x, pt.y])));
  dict.BS = doc.context.obj({ W: PDFNumber.of(o.strokeWidth ?? 1.5) });
  const ref = doc.context.register(doc.context.obj(dict));
  page.node.addAnnot(ref);
  return ref;
}

/** Remove every annotation from a page (used when flattening or rasterizing). */
export function clearAnnotations(page: PDFPage) {
  page.node.delete(PDFName.of("Annots"));
}

/** Count annotations on a page. */
export function annotationCount(page: PDFPage) {
  const annots = page.node.lookup(PDFName.of("Annots"));
  return annots instanceof PDFArray ? annots.size() : 0;
}
