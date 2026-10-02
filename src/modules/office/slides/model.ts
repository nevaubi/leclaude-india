/**
 * Slides content model (isomorphic: client, server, tests).
 *
 * Coordinates are slide pixels on a fixed 1280×720 (16:9) canvas; font sizes
 * are points (PowerPoint units) — the renderer multiplies by 4/3 to get px on
 * the 1280-wide canvas, and the exporter writes them 1:1 on a 13.333"×7.5" page.
 * Colors are "#RRGGBB" or a theme token (bg | fg | accent | accent2 | muted | surface).
 */
import { nanoid } from "nanoid";

export const SLIDE_W = 1280;
export const SLIDE_H = 720;
export const PT_TO_PX = 4 / 3;
export const GRID = 16;

export type SlideLayout = "title" | "section" | "bullets" | "two_column" | "comparison" | "timeline" | "chart" | "table" | "quote" | "image" | "blank" | "agenda";
export const SLIDE_LAYOUTS: SlideLayout[] = ["title", "section", "bullets", "two_column", "comparison", "timeline", "chart", "table", "quote", "image", "agenda", "blank"];
export const LAYOUT_LABEL: Record<SlideLayout, string> = { title: "Title", section: "Section header", bullets: "Title & bullets", two_column: "Two columns", comparison: "Comparison", timeline: "Timeline", chart: "Chart", table: "Table", quote: "Quote", image: "Image", agenda: "Agenda", blank: "Blank" };

export type ElementType = "text" | "image" | "shape" | "table" | "chart" | "line";
export type ShapeKind = "rect" | "ellipse" | "arrow" | "line";
export type ThemeColorToken = "bg" | "fg" | "accent" | "accent2" | "muted" | "surface";
export type PlaceholderRole = "title" | "subtitle" | "body" | "left" | "right" | "leftTitle" | "rightTitle" | "quote" | "attribution" | "caption" | "number" | "date" | "kicker" | "logo" | "footer" | "item" | "chart" | "table" | "image" | "decor";

export interface ElementStyle {
  fontSize?: number; // pt
  fontFamily?: string; // "heading" | "body" | explicit face
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  color?: string;
  align?: "left" | "center" | "right";
  valign?: "top" | "middle" | "bottom";
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  radius?: number;
  opacity?: number; // 0..1
  lineHeight?: number; // multiple
  letterSpacing?: number; // px
  padding?: number; // px inset for text boxes
  /** Images: how the bitmap fits its box. */
  fit?: "contain" | "cover" | "fill";
  /** Lines: "down" = top-left → bottom-right, "up" = bottom-left → top-right. */
  lineDir?: "down" | "up";
  arrowEnd?: boolean;
  /** Tables */
  headerFill?: string;
  headerColor?: string;
  banded?: boolean;
}

export interface ChartSpec {
  type: "bar" | "line" | "pie";
  categories: string[];
  series: { name: string; values: number[] }[];
  title?: string;
  showLegend?: boolean;
  showValues?: boolean;
  unit?: string; // "$", "%", "ng/L"
}

export interface TableBorder { color?: string; width?: number /* pt */; none?: boolean }

export interface TableCell {
  text: string;
  gridSpan?: number;
  rowSpan?: number;
  /** Covered by a merge from the left / from above (OOXML hMerge / vMerge). */
  hMerge?: boolean;
  vMerge?: boolean;
  fill?: string;
  borders?: { l?: TableBorder; r?: TableBorder; t?: TableBorder; b?: TableBorder };
  bold?: boolean;
  align?: "left" | "center" | "right";
}

export interface TableSpec {
  header: string[];
  rows: string[][];
  /** Column width fractions (sum ≈ 1). */
  colWidths?: number[];
  /** Full cell grid (header row first) with merges, fills and borders; texts mirror header/rows. */
  cells?: TableCell[][];
  /** Row heights as fractions of the table height. */
  rowHeights?: number[];
  /** OOXML table look flags. */
  firstRow?: boolean;
  bandRow?: boolean;
}

export interface DeckElement {
  id: string;
  type: ElementType;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation?: number;
  z: number;
  style: ElementStyle;
  /** Markdown-lite: **bold**, *italic*, bullet lines "- ", numbered "1. ", indent with two spaces. */
  text?: string;
  src?: string;
  alt?: string;
  shape?: ShapeKind;
  table?: TableSpec;
  chart?: ChartSpec;
  role?: PlaceholderRole;
  name?: string;
  locked?: boolean;
  groupId?: string;
  /** Mirror the element (imported from / exported to OOXML a:xfrm flipH / flipV). */
  flipH?: boolean;
  flipV?: boolean;
  /** Image crop as fractions of the source bitmap trimmed from each edge (OOXML a:srcRect). */
  crop?: { l: number; t: number; r: number; b: number };
  /** Exact text body of an imported shape (paragraph levels, bullets, runs). `rich.markdown` is the markdown the
   *  element had at import: while `text` still equals it the exporter writes these paragraphs verbatim. */
  rich?: RichText;
  /** Link to the source shape of an imported .pptx (package-preserving export). Never authored by the model. */
  ooxml?: ElementOoxml;
}

// ---------------------------------------------------------------------------
// OOXML fidelity metadata (imported decks)
// ---------------------------------------------------------------------------

export interface RichRun {
  text: string;
  /** Explicit run properties from the source (points; booleans; "#RRGGBB" or "scheme:accent1"). */
  size?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  color?: string;
  font?: string;
  link?: string;
  /** a:br line break (text is "") or a:fld field type (slidenum, datetime…). */
  br?: boolean;
  field?: string;
}

export interface RichParagraph {
  level: number;
  /** Explicit bullet on the paragraph; "inherit" = none specified (placeholder/master decides). */
  bullet: "char" | "number" | "none" | "inherit";
  bulletChar?: string;
  numScheme?: string;
  align?: "left" | "center" | "right" | "justify";
  /** Points (spcPts) or percent (spcPct, as "120%"). */
  spaceBefore?: string;
  spaceAfter?: string;
  lineSpacing?: string;
  runs: RichRun[];
  /** The paragraph's markdown line(s) at import (a:br → "\n"); lets an edit reuse untouched paragraphs verbatim. */
  md?: string;
}

export interface RichText {
  paragraphs: RichParagraph[];
  /** The element's markdown at import; when `text` differs the paragraphs are stale and are regenerated. */
  markdown: string;
  autofit?: "norm" | "shape" | "none";
  fontScale?: number;
  anchor?: "t" | "ctr" | "b";
  wrap?: boolean;
  /** Insets in EMU [l, t, r, b] when explicit. */
  insets?: [number, number, number, number];
}

export interface EmuRect { x: number; y: number; cx: number; cy: number; rot?: number; flipH?: boolean; flipV?: boolean }

export interface ElementOoxml {
  /** p:cNvPr id of the source shape (unique on the slide). */
  spid: number;
  kind: "sp" | "pic" | "cxnSp" | "graphicFrame";
  name?: string;
  ph?: { type?: string; idx?: string };
  /** Absolute slide geometry in EMU (after group transforms). */
  emu: EmuRect;
  /** True when the source shape had no a:xfrm (geometry inherited from the layout/master). */
  inherited?: boolean;
  /** Composed transform of enclosing groups (EMU), for writing child coordinates back. */
  group?: { spids: number[]; offX: number; offY: number; chOffX: number; chOffY: number; scaleX: number; scaleY: number };
  /** Import-time geometry and style in canvas units, used to diff user edits. */
  base: { x: number; y: number; w: number; h: number; rotation?: number; flipH?: boolean; flipV?: boolean; style: ElementStyle; src?: string; crop?: DeckElement["crop"] };
  /** Fingerprint of the element at import (see fingerprint.ts); equal ⇒ the source XML is written verbatim. */
  fp: string;
  media?: string;
  chartPart?: string;
  /** SmartArt/OLE/unknown frames: only geometry may be rewritten. */
  opaque?: boolean;
  /** Hash of the element's data (text/table/chart/src/crop) at import. */
  dataFp?: string;
}

export interface SlideOoxml {
  /** Package part of the source slide ("ppt/slides/slide3.xml"). */
  part: string;
  layoutPart?: string;
  layoutName?: string;
  /** Fingerprint of the slide content (without notes) at import. */
  fp: string;
  /** Package id (meta.pptx.pkgId) and hash of the source part: a slide is only written from the package it came from. */
  pkg?: string;
  xmlHash?: string;
  notes0: string;
  hidden0: boolean;
  transition0?: DeckSlide["transition"];
  background0?: SlideBackground;
}

export interface PptxPlaceholderInfo { type: string; idx?: string; name?: string; emu?: EmuRect }
export interface PptxLayoutInfo { part: string; name: string; type?: string; master: string; placeholders: PptxPlaceholderInfo[] }

export interface PptxMeta {
  sourceFile: string;
  /** sha256 of the source package; the exporter only reuses a stored package whose bytes match. */
  sha256?: string;
  /** Stable id of the imported package (sha256 when known). */
  pkgId: string;
  slideSize: { cx: number; cy: number };
  /** Canvas mapping: px = emu * scale + off. */
  map: { scale: number; offX: number; offY: number };
  layouts: PptxLayoutInfo[];
  themePart?: string;
  /** Scheme colors (hex) and fonts of the source theme. */
  scheme?: Record<string, string>;
  fonts?: { major: string; minor: string };
  /** Fingerprint of the imported DeckTheme; a different theme on export patches the theme part. */
  themeFp: string;
  sections?: string[];
  warnings?: string[];
}

export interface SlideBackground { color?: string; imageUrl?: string }

export interface DeckSlide {
  id: string;
  layout: SlideLayout;
  background?: SlideBackground;
  elements: DeckElement[];
  notes: string;
  transition?: "none" | "fade" | "push" | "wipe";
  hidden?: boolean;
  name?: string;
  /** PowerPoint section this slide belongs to. */
  section?: string;
  ooxml?: SlideOoxml;
}

export interface DeckTheme {
  id: string;
  name: string;
  fonts: { heading: string; body: string };
  colors: { bg: string; fg: string; accent: string; muted: string; accent2: string; surface?: string };
  logoText?: string;
  /** Title slides use a darker/accent background in some themes. */
  titleBg?: string;
  titleFg?: string;
}

export interface DeckContent {
  version: 1;
  theme: DeckTheme;
  size: { w: 1280; h: 720 };
  slides: DeckSlide[];
  meta?: { createdWith?: string; sourceFile?: string; pptx?: PptxMeta };
}

// ---------------------------------------------------------------------------
// Themes
// ---------------------------------------------------------------------------

export const THEMES: DeckTheme[] = [
  { id: "classic-navy", name: "Navy", fonts: { heading: "Georgia", body: "Calibri" }, colors: { bg: "#FFFFFF", fg: "#14213D", accent: "#1F3A6B", muted: "#6B7280", accent2: "#C8A24A", surface: "#F3F5F9" }, logoText: "", titleBg: "#14213D", titleFg: "#FFFFFF" },
  { id: "counsel-slate", name: "Counsel Slate", fonts: { heading: "Segoe UI", body: "Segoe UI" }, colors: { bg: "#F7F8FA", fg: "#1E2430", accent: "#2F6F8F", muted: "#6E7787", accent2: "#D97706", surface: "#FFFFFF" }, logoText: "", titleBg: "#1E2430", titleFg: "#F7F8FA" },
  { id: "courtroom-serif", name: "Courtroom Serif", fonts: { heading: "Times New Roman", body: "Georgia" }, colors: { bg: "#FBF8F1", fg: "#2B2118", accent: "#7A1F1F", muted: "#7C6F64", accent2: "#B08D57", surface: "#F3EDE0" }, logoText: "", titleBg: "#2B2118", titleFg: "#FBF8F1" },
  { id: "modern-mono", name: "Modern Mono", fonts: { heading: "Consolas", body: "Arial" }, colors: { bg: "#111318", fg: "#F2F4F8", accent: "#7CC4FF", muted: "#9AA3B2", accent2: "#FFB454", surface: "#1B1F27" }, logoText: "", titleBg: "#0B0D12", titleFg: "#F2F4F8" },
  { id: "client-light", name: "Client Light", fonts: { heading: "Calibri", body: "Calibri" }, colors: { bg: "#FFFFFF", fg: "#222222", accent: "#0F766E", muted: "#6B7280", accent2: "#F59E0B", surface: "#F0FDFA" }, logoText: "", titleBg: "#0F766E", titleFg: "#FFFFFF" },
  { id: "verdict-ember", name: "Verdict Ember", fonts: { heading: "Cambria", body: "Arial" }, colors: { bg: "#1C1917", fg: "#FAFAF9", accent: "#F97316", muted: "#A8A29E", accent2: "#FBBF24", surface: "#292524" }, logoText: "", titleBg: "#0C0A09", titleFg: "#FAFAF9" },
];

export const DEFAULT_THEME_ID = "classic-navy";

export function getTheme(id: string | undefined | null): DeckTheme {
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}

const FONT_STACKS: Record<string, string> = {
  Georgia: "Georgia, 'Source Serif 4 Variable', 'Times New Roman', serif",
  "Times New Roman": "'Times New Roman', Times, 'Source Serif 4 Variable', serif",
  Cambria: "Cambria, Georgia, 'Source Serif 4 Variable', serif",
  Garamond: "Garamond, 'EB Garamond', Georgia, serif",
  Calibri: "Calibri, 'Inter Variable', 'Segoe UI', system-ui, sans-serif",
  "Segoe UI": "'Segoe UI', 'Inter Variable', system-ui, sans-serif",
  Arial: "Arial, Helvetica, 'Inter Variable', sans-serif",
  Helvetica: "Helvetica, Arial, 'Inter Variable', sans-serif",
  "Trebuchet MS": "'Trebuchet MS', 'Inter Variable', sans-serif",
  Verdana: "Verdana, Geneva, 'Inter Variable', sans-serif",
  Consolas: "Consolas, 'JetBrains Mono Variable', 'Courier New', monospace",
  "Courier New": "'Courier New', 'JetBrains Mono Variable', monospace",
};
export const FONT_FACES = Object.keys(FONT_STACKS);

export function resolveFontFace(family: string | undefined, theme: DeckTheme): string {
  if (!family || family === "body") return theme.fonts.body;
  if (family === "heading") return theme.fonts.heading;
  return family;
}

export function fontStack(face: string): string {
  return FONT_STACKS[face] ?? `'${face}', 'Inter Variable', system-ui, sans-serif`;
}

const TOKENS: ThemeColorToken[] = ["bg", "fg", "accent", "accent2", "muted", "surface"];
export function isColorToken(v: string | undefined): v is ThemeColorToken {
  return Boolean(v) && (TOKENS as string[]).includes(v as string);
}

export function resolveColor(value: string | undefined, theme: DeckTheme, fallback = "transparent"): string {
  if (!value) return fallback;
  if (isColorToken(value)) return value === "surface" ? (theme.colors.surface ?? theme.colors.bg) : theme.colors[value];
  return value;
}

/** Hex → "RRGGBB" for pptxgenjs; tokens resolved first. */
export function hexForExport(value: string | undefined, theme: DeckTheme, fallback = "000000"): string {
  const v = resolveColor(value, theme, "");
  const m = v.match(/^#?([0-9a-f]{6})$/i);
  if (m) return m[1].toUpperCase();
  const short = v.match(/^#?([0-9a-f]{3})$/i);
  if (short) return short[1].split("").map((c) => c + c).join("").toUpperCase();
  return fallback;
}

export function isDark(hex: string): boolean {
  const m = hex.replace("#", "");
  if (m.length < 6) return false;
  const r = parseInt(m.slice(0, 2), 16), g = parseInt(m.slice(2, 4), 16), b = parseInt(m.slice(4, 6), 16);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.5;
}

// ---------------------------------------------------------------------------
// Ids and factories
// ---------------------------------------------------------------------------

export const newSlideId = () => `sl_${nanoid(8)}`;
export const newElementId = () => `el_${nanoid(8)}`;

export function emptyDeck(themeId: string = DEFAULT_THEME_ID): DeckContent {
  return { version: 1, theme: getTheme(themeId), size: { w: SLIDE_W, h: SLIDE_H }, slides: [] };
}

export function makeElement(partial: Partial<DeckElement> & { type: ElementType }): DeckElement {
  return { id: newElementId(), x: 80, y: 80, w: 400, h: 120, z: 0, style: {}, ...partial };
}

export function makeSlide(layout: SlideLayout, elements: DeckElement[] = [], extra: Partial<DeckSlide> = {}): DeckSlide {
  return { id: newSlideId(), layout, elements: elements.map((e, i) => ({ ...e, z: e.z ?? i })), notes: "", ...extra };
}

export function cloneDeck(deck: DeckContent): DeckContent {
  return JSON.parse(JSON.stringify(deck)) as DeckContent;
}

/** Deep copy of a slide with fresh ids (elements and slide). */
export function cloneSlide(slide: DeckSlide, opts: { keepIds?: boolean } = {}): DeckSlide {
  const copy = JSON.parse(JSON.stringify(slide)) as DeckSlide;
  if (opts.keepIds) return copy;
  copy.id = newSlideId();
  const groupMap = new Map<string, string>();
  copy.elements = copy.elements.map((e) => {
    const next: DeckElement = { ...e, id: newElementId() };
    if (e.groupId) { if (!groupMap.has(e.groupId)) groupMap.set(e.groupId, `g_${nanoid(6)}`); next.groupId = groupMap.get(e.groupId); }
    return next;
  });
  return copy;
}

// ---------------------------------------------------------------------------
// Markdown-lite
// ---------------------------------------------------------------------------

export interface TextRun { text: string; bold?: boolean; italic?: boolean; underline?: boolean }
export interface TextLine { indent: number; kind: "para" | "bullet" | "number"; runs: TextRun[] }

/** Parse markdown-lite into lines: "- " bullets, "1. " numbers, two-space indents, **bold**, *italic*, __underline__. */
export function parseMarkdownLite(text: string | undefined): TextLine[] {
  const out: TextLine[] = [];
  for (const raw of (text ?? "").replace(/\r\n/g, "\n").split("\n")) {
    const m = raw.match(/^(\s*)(?:([-•*])\s+|(\d+)[.)]\s+)?(.*)$/);
    const spaces = m?.[1] ?? "";
    const indent = Math.min(4, Math.floor(spaces.replace(/\t/g, "  ").length / 2));
    const kind: TextLine["kind"] = m?.[2] ? "bullet" : m?.[3] ? "number" : "para";
    out.push({ indent, kind, runs: parseInline(m?.[4] ?? raw) });
  }
  return out;
}

export function parseInline(text: string): TextRun[] {
  const runs: TextRun[] = [];
  const re = /(\*\*([^*]+)\*\*)|(__([^_]+)__)|(\*([^*]+)\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) runs.push({ text: text.slice(last, m.index) });
    if (m[1]) runs.push({ text: m[2], bold: true });
    else if (m[3]) runs.push({ text: m[4], underline: true });
    else runs.push({ text: m[6], italic: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) runs.push({ text: text.slice(last) });
  return runs.length ? runs : [{ text: "" }];
}

export function serializeMarkdownLite(lines: TextLine[]): string {
  return lines
    .map((l) => {
      const prefix = "  ".repeat(l.indent) + (l.kind === "bullet" ? "- " : l.kind === "number" ? "1. " : "");
      return prefix + l.runs.map((r) => { let t = r.text; if (r.bold) t = `**${t}**`; if (r.italic) t = `*${t}*`; if (r.underline) t = `__${t}__`; return t; }).join("");
    })
    .join("\n");
}

/** Plain text (markers stripped), one line per paragraph. */
export function plainText(text: string | undefined): string {
  return parseMarkdownLite(text).map((l) => l.runs.map((r) => r.text).join("")).join("\n");
}

export function wordCount(text: string | undefined): number {
  return plainText(text).split(/\s+/).filter(Boolean).length;
}

/** Bullet lines of a text element (plain). */
export function bulletLines(text: string | undefined): string[] {
  return parseMarkdownLite(text).filter((l) => l.runs.some((r) => r.text.trim())).map((l) => l.runs.map((r) => r.text).join("").trim());
}

// ---------------------------------------------------------------------------
// Slide text helpers
// ---------------------------------------------------------------------------

export function findByRole(slide: DeckSlide, role: PlaceholderRole): DeckElement | undefined {
  return slide.elements.find((e) => e.role === role && e.type === "text");
}

export function slideTitle(slide: DeckSlide): string {
  const t = findByRole(slide, "title") ?? findByRole(slide, "quote") ?? slide.elements.filter((e) => e.type === "text" && e.role !== "footer" && e.role !== "logo" && e.role !== "decor" && e.text?.trim()).sort((a, b) => (b.style.fontSize ?? 18) - (a.style.fontSize ?? 18) || a.y - b.y)[0];
  return plainText(t?.text).split("\n")[0]?.trim() ?? "";
}

export function slideBodyText(slide: DeckSlide): string {
  return slide.elements
    .filter((e) => e.type === "text" && e.text?.trim() && e.role !== "title" && e.role !== "footer" && e.role !== "logo")
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map((e) => plainText(e.text))
    .join("\n");
}

export function slidePlainText(slide: DeckSlide): string {
  const parts = [slideTitle(slide), slideBodyText(slide)];
  for (const e of slide.elements) {
    if (e.type === "table" && e.table) parts.push([e.table.header.join(" | "), ...e.table.rows.map((r) => r.join(" | "))].join("\n"));
    if (e.type === "chart" && e.chart) parts.push(`${e.chart.title ?? "Chart"}: ${e.chart.categories.join(", ")}`);
  }
  if (slide.notes) parts.push(slide.notes);
  return parts.filter(Boolean).join("\n");
}

export function deckPlainText(deck: DeckContent): string {
  return deck.slides.map((s, i) => `Slide ${i + 1}\n${slidePlainText(s)}`).join("\n\n");
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

export interface Rect { x: number; y: number; w: number; h: number }

export function clampToSlide(el: DeckElement): DeckElement {
  const w = Math.max(8, Math.min(SLIDE_W, el.w));
  const h = Math.max(8, Math.min(SLIDE_H, el.h));
  const x = Math.max(-w + 8, Math.min(SLIDE_W - 8, el.x));
  const y = Math.max(-h + 8, Math.min(SLIDE_H - 8, el.y));
  return { ...el, x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

export function withinSlide(el: Rect, tolerance = 0): boolean {
  return el.x >= -tolerance && el.y >= -tolerance && el.x + el.w <= SLIDE_W + tolerance && el.y + el.h <= SLIDE_H + tolerance && el.w > 0 && el.h >= 0;
}

export function unionRect(rects: Rect[]): Rect {
  if (!rects.length) return { x: 0, y: 0, w: 0, h: 0 };
  const x1 = Math.min(...rects.map((r) => r.x)), y1 = Math.min(...rects.map((r) => r.y));
  const x2 = Math.max(...rects.map((r) => r.x + r.w)), y2 = Math.max(...rects.map((r) => r.y + r.h));
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/** Relative advance widths (em) for a Helvetica/Calibri-like face; deterministic, no DOM. */
function charEm(c: string): number {
  if (c === " ") return 0.28;
  if (/[iljI|.,;:!'`]/.test(c)) return 0.26;
  if (/[ftr()[\]{}\-"]/.test(c)) return 0.36;
  if (/[mwMW@%]/.test(c)) return 0.86;
  if (/[A-Z]/.test(c)) return 0.66;
  if (/[0-9$#&?*+=<>~^_]/.test(c)) return 0.56;
  if (/[a-z]/.test(c)) return 0.52;
  if (/[\u2014\u2013]/.test(c)) return c === "\u2014" ? 1 : 0.56;
  return c.charCodeAt(0) > 0x2e80 ? 1 : 0.56;
}

/** Width of a string in px at a font size (px) for a face. */
export function measureText(text: string, pxSize: number, face: string, bold = false): number {
  const mono = /Consolas|Courier|Mono/i.test(face);
  const serif = /(Georgia|Times|Cambria|Garamond|Serif)/i.test(face);
  let em = 0;
  for (const c of text) em += mono ? 0.6 : charEm(c);
  return em * pxSize * (serif ? 0.97 : 1) * (bold && !mono ? 1.06 : 1);
}

/** Greedy word wrap: number of lines a paragraph needs in a width. */
export function wrapLineCount(text: string, width: number, pxSize: number, face: string, bold = false): number {
  const words = text.split(/(\s+)/).filter((w) => w.length);
  if (!words.length) return 1;
  let lines = 1, cur = 0;
  const space = measureText(" ", pxSize, face, bold);
  for (const w of words) {
    if (/^\s+$/.test(w)) { cur += space; continue; }
    const ww = measureText(w, pxSize, face, bold);
    if (cur > 0 && cur + ww > width) { lines++; cur = 0; }
    if (ww > width) { lines += Math.floor(ww / width); cur = ww % width; } else cur += ww;
  }
  return lines;
}

/**
 * Deterministic text-fit estimate: wrapped lines the text needs at its font size (greedy word wrap with per-glyph
 * widths) versus the lines that fit in the box. Drives the overflow badge, the agent's verify step and fit_text.
 */
export function estimateTextFit(el: DeckElement, theme: DeckTheme): { needed: number; available: number; overflow: boolean; fontSize: number; neededPx: number; availablePx: number } {
  const fontSize = el.style.fontSize ?? 18;
  const pxSize = fontSize * PT_TO_PX;
  const pad = el.style.padding ?? 8;
  const face = resolveFontFace(el.style.fontFamily, theme);
  const lineH = pxSize * (el.style.lineHeight ?? 1.25);
  const usableW = Math.max(20, el.w - pad * 2);
  const lines = parseMarkdownLite(el.text);
  let needed = 0;
  for (const l of lines) {
    const text = l.runs.map((r) => r.text).join("");
    const bold = Boolean(el.style.bold) || (l.runs.length > 0 && l.runs.every((r) => r.bold || !r.text.trim()));
    const indentPx = l.indent * 28 + (l.kind !== "para" ? 26 : 0);
    needed += wrapLineCount(text, Math.max(20, usableW - indentPx), pxSize, face, bold);
  }
  const availablePx = Math.max(0, el.h - pad * 2);
  const available = Math.max(1, Math.floor((availablePx + 0.5) / lineH));
  const neededPx = needed * lineH;
  return { needed, available, overflow: needed > available, fontSize, neededPx, availablePx };
}

/** Largest font size (≥ min) at which the text fits the box. */
export function fitFontSize(el: DeckElement, theme: DeckTheme, max: number, min: number): number {
  for (let size = max; size >= min; size -= 1) {
    const fit = estimateTextFit({ ...el, style: { ...el.style, fontSize: size } }, theme);
    if (!fit.overflow) return size;
  }
  return min;
}

export function normalizeDeck(raw: unknown): DeckContent {
  const d = (raw && typeof raw === "object" ? raw : {}) as Partial<DeckContent>;
  const theme = d.theme && typeof d.theme === "object" && (d.theme as DeckTheme).colors ? { ...getTheme((d.theme as DeckTheme).id), ...(d.theme as DeckTheme) } : getTheme(DEFAULT_THEME_ID);
  const slides = Array.isArray(d.slides) ? d.slides.map((s, i) => normalizeSlide(s, i)) : [];
  return { version: 1, theme, size: { w: SLIDE_W, h: SLIDE_H }, slides, meta: d.meta };
}

export function normalizeSlide(raw: unknown, index = 0): DeckSlide {
  const s = (raw && typeof raw === "object" ? raw : {}) as Partial<DeckSlide>;
  const layout = (SLIDE_LAYOUTS as string[]).includes(String(s.layout)) ? (s.layout as SlideLayout) : "blank";
  const elements = Array.isArray(s.elements) ? s.elements.map((e, i) => normalizeElement(e, i)) : [];
  const out: DeckSlide = { id: typeof s.id === "string" && s.id ? s.id : `sl_seed_${index}_${nanoid(4)}`, layout, background: s.background, elements, notes: typeof s.notes === "string" ? s.notes : "", transition: s.transition, hidden: Boolean(s.hidden), name: s.name };
  if (typeof s.section === "string") out.section = s.section;
  if (s.ooxml && typeof s.ooxml === "object" && typeof s.ooxml.part === "string") out.ooxml = s.ooxml;
  return out;
}

export function normalizeElement(raw: unknown, index = 0): DeckElement {
  const e = (raw && typeof raw === "object" ? raw : {}) as Partial<DeckElement>;
  const type: ElementType = (["text", "image", "shape", "table", "chart", "line"] as string[]).includes(String(e.type)) ? (e.type as ElementType) : "text";
  return {
    id: typeof e.id === "string" && e.id ? e.id : newElementId(),
    type,
    x: num(e.x, 80), y: num(e.y, 80), w: num(e.w, 400), h: num(e.h, 120),
    rotation: e.rotation ? num(e.rotation, 0) : undefined,
    z: num(e.z, index),
    style: e.style && typeof e.style === "object" ? e.style : {},
    text: typeof e.text === "string" ? e.text : type === "text" ? "" : undefined,
    src: typeof e.src === "string" ? e.src : undefined,
    alt: typeof e.alt === "string" ? e.alt : undefined,
    shape: e.shape,
    table: e.table && Array.isArray(e.table.header) ? normalizeTable(e.table) : undefined,
    chart: e.chart && Array.isArray(e.chart.categories) ? { type: (["bar", "line", "pie"] as string[]).includes(e.chart.type) ? e.chart.type : "bar", categories: e.chart.categories.map(String), series: (e.chart.series ?? []).map((s) => ({ name: String(s.name ?? "Series"), values: (s.values ?? []).map((v) => Number(v) || 0) })), title: e.chart.title, showLegend: e.chart.showLegend, showValues: e.chart.showValues, unit: e.chart.unit } : undefined,
    role: e.role,
    name: e.name,
    locked: e.locked,
    groupId: e.groupId,
    ...(e.flipH ? { flipH: true } : {}),
    ...(e.flipV ? { flipV: true } : {}),
    ...(e.crop && typeof e.crop === "object" ? { crop: { l: num(e.crop.l, 0), t: num(e.crop.t, 0), r: num(e.crop.r, 0), b: num(e.crop.b, 0) } } : {}),
    ...(e.rich && typeof e.rich === "object" && Array.isArray(e.rich.paragraphs) ? { rich: e.rich } : {}),
    ...(e.ooxml && typeof e.ooxml === "object" && typeof e.ooxml.spid === "number" ? { ooxml: e.ooxml } : {}),
  };
}

function normalizeTable(t: TableSpec): TableSpec {
  const out: TableSpec = { header: t.header.map(String), rows: (t.rows ?? []).map((r) => (Array.isArray(r) ? r.map(String) : [])), colWidths: t.colWidths };
  if (Array.isArray(t.cells)) out.cells = t.cells;
  if (Array.isArray(t.rowHeights)) out.rowHeights = t.rowHeights;
  if (t.firstRow !== undefined) out.firstRow = t.firstRow;
  if (t.bandRow !== undefined) out.bandRow = t.bandRow;
  return out;
}

function num(v: unknown, d: number) { const n = Number(v); return Number.isFinite(n) ? n : d; }

export function deckStats(deck: DeckContent) {
  const slides = deck.slides.length;
  const hidden = deck.slides.filter((s) => s.hidden).length;
  const words = deck.slides.reduce((n, s) => n + s.elements.filter((e) => e.type === "text").reduce((m, e) => m + wordCount(e.text), 0), 0);
  const notes = deck.slides.filter((s) => s.notes.trim()).length;
  const images = deck.slides.reduce((n, s) => n + s.elements.filter((e) => e.type === "image").length, 0);
  const charts = deck.slides.reduce((n, s) => n + s.elements.filter((e) => e.type === "chart").length, 0);
  const tables = deck.slides.reduce((n, s) => n + s.elements.filter((e) => e.type === "table").length, 0);
  return { slides, hidden, words, notes, images, charts, tables };
}
