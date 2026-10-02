/** Shared (isomorphic) constants for page setup, fonts and export options. */

export type PageSizeId = "letter" | "a4" | "legal";
export type MarginPresetId = "normal" | "narrow" | "moderate" | "wide" | "court";
export type Orientation = "portrait" | "landscape";
export type BodyFont = "serif" | "sans";

export interface DocSettings {
  pageSize: PageSizeId;
  margins: MarginPresetId;
  orientation: Orientation;
  pageNumbers: boolean;
  font: BodyFont;
  fontSize: number; // pt
  lineSpacing: number; // multiplier
  language: string;
}

export const DEFAULT_SETTINGS: DocSettings = { pageSize: "letter", margins: "normal", orientation: "portrait", pageNumbers: true, font: "serif", fontSize: 12, lineSpacing: 1.15, language: "en-US" };

/** Inches. */
export const PAGE_SIZES: Record<PageSizeId, { label: string; width: number; height: number }> = {
  letter: { label: "Letter (8.5 × 11 in)", width: 8.5, height: 11 },
  a4: { label: "A4 (210 × 297 mm)", width: 8.27, height: 11.69 },
  legal: { label: "Legal (8.5 × 14 in)", width: 8.5, height: 14 },
};

/** Inches: top, right, bottom, left. */
export const MARGIN_PRESETS: Record<MarginPresetId, { label: string; top: number; right: number; bottom: number; left: number }> = {
  normal: { label: "Normal (1 in)", top: 1, right: 1, bottom: 1, left: 1 },
  narrow: { label: "Narrow (0.5 in)", top: 0.5, right: 0.5, bottom: 0.5, left: 0.5 },
  moderate: { label: "Moderate (1 × 0.75 in)", top: 1, right: 0.75, bottom: 1, left: 0.75 },
  wide: { label: "Wide (1 × 2 in)", top: 1, right: 2, bottom: 1, left: 2 },
  court: { label: "Court filing (1 in, 1.25 left)", top: 1, right: 1, bottom: 1, left: 1.25 },
};

export const FONT_FAMILIES: { id: string; label: string; css: string; docx: string }[] = [
  { id: "serif", label: "Source Serif", css: "'Source Serif 4 Variable', Georgia, 'Times New Roman', serif", docx: "Times New Roman" },
  { id: "times", label: "Times New Roman", css: "'Times New Roman', Times, serif", docx: "Times New Roman" },
  { id: "garamond", label: "Garamond", css: "Garamond, 'EB Garamond', Georgia, serif", docx: "Garamond" },
  { id: "century", label: "Century Schoolbook", css: "'Century Schoolbook', 'New Century Schoolbook', Georgia, serif", docx: "Century Schoolbook" },
  { id: "sans", label: "Inter", css: "'Inter Variable', system-ui, sans-serif", docx: "Calibri" },
  { id: "arial", label: "Arial", css: "Arial, Helvetica, sans-serif", docx: "Arial" },
  { id: "calibri", label: "Calibri", css: "Calibri, 'Segoe UI', sans-serif", docx: "Calibri" },
  { id: "mono", label: "JetBrains Mono", css: "'JetBrains Mono Variable', Menlo, monospace", docx: "Consolas" },
];

export const FONT_SIZES = [8, 9, 10, 10.5, 11, 12, 13, 14, 16, 18, 20, 24, 28, 36];
export const LINE_SPACINGS: { id: number; label: string }[] = [{ id: 1, label: "Single" }, { id: 1.15, label: "1.15" }, { id: 1.5, label: "1.5" }, { id: 2, label: "Double" }, { id: 2.5, label: "2.5" }];

export const HIGHLIGHT_COLORS: { id: string; label: string; css: string; docx: string }[] = [
  { id: "yellow", label: "Yellow", css: "#fff3a3", docx: "yellow" },
  { id: "green", label: "Green", css: "#c8f7c5", docx: "green" },
  { id: "cyan", label: "Cyan", css: "#c2ecf5", docx: "cyan" },
  { id: "magenta", label: "Pink", css: "#f9c8e2", docx: "magenta" },
  { id: "orange", label: "Orange", css: "#ffd9a8", docx: "darkYellow" },
  { id: "gray", label: "Gray", css: "#e2e2e2", docx: "lightGray" },
];

export const TEXT_COLORS: { id: string; label: string; css: string }[] = [
  { id: "default", label: "Default", css: "" },
  { id: "black", label: "Black", css: "#000000" },
  { id: "gray", label: "Gray", css: "#6b7280" },
  { id: "red", label: "Red", css: "#b91c1c" },
  { id: "orange", label: "Orange", css: "#c2410c" },
  { id: "green", label: "Green", css: "#15803d" },
  { id: "blue", label: "Blue", css: "#1d4ed8" },
  { id: "navy", label: "Navy", css: "#1e3a8a" },
  { id: "purple", label: "Purple", css: "#6d28d9" },
];

export const LANGUAGES = [{ id: "en-US", label: "English (US)" }, { id: "en-GB", label: "English (UK)" }, { id: "en-IN", label: "English (India)" }, { id: "es-US", label: "Spanish (US)" }, { id: "fr-FR", label: "French" }];

/** Indian court templates (ids "word-in-…"): A4 paper and Indian English, as Indian registries expect. */
export function isIndiaTemplate(templateId?: string | null): boolean {
  return typeof templateId === "string" && /^word-in-/.test(templateId);
}

/** Legal templates use serif; internal memos use sans. */
export function settingsForTemplate(templateId?: string | null): DocSettings {
  const sans = templateId ? /memo|minutes|letter|update|issues/i.test(templateId) : false;
  const court = templateId ? /motion|brief|notice|interrogator|deposition|order/i.test(templateId) : false;
  const india = isIndiaTemplate(templateId);
  return { ...DEFAULT_SETTINGS, font: sans ? "sans" : "serif", margins: court ? "court" : "normal", lineSpacing: court ? 2 : 1.15, fontSize: sans ? 11 : 12, ...(india ? { pageSize: "a4" as const, language: "en-IN" } : {}) };
}
