/**
 * Pure helpers for the Documents UI (no DOM, no React): labels, dates at their precision, CSV, citation markers, page
 * batching and PDF text assembly. Shared by the components and unit-tested in tests/documents-ui-format.test.ts.
 */
import type { DatePrecision, DocEvent, DocFile, DocFileStatus, ExtractionMethod } from "../types";

/** Workspace tabs (in ?tab=). Kept here, not in the client component, so the server page can validate the param. */
export const WORKSPACE_TABS = ["files", "ask", "facts", "timeline"] as const;
export type WorkspaceTab = (typeof WORKSPACE_TABS)[number];

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export const METHOD_LABEL: Record<ExtractionMethod, string> = {
  "browser-pdfjs": "PDF text",
  "server-pdf": "PDF text",
  "server-docx": "Word text",
  "server-text": "Plain text",
  "server-eml": "Email",
  "ocr-ai": "Scanned — AI OCR",
};

/** Method label that also says when scanned pages remain unread. */
export function methodLabel(f: Pick<DocFile, "method" | "status" | "ocrPages">): string {
  if (f.status === "needs_ocr") return "Scanned — no text layer";
  const base = METHOD_LABEL[f.method] ?? f.method;
  if (f.status === "partial" && f.ocrPages.length) return `${base} + ${f.ocrPages.length} scanned`;
  return base;
}

export type Tone = "success" | "warning" | "destructive" | "info" | "muted";

export const STATUS_META: Record<DocFileStatus, { label: string; tone: Tone }> = {
  ready: { label: "Ready", tone: "success" },
  partial: { label: "Partial", tone: "warning" },
  needs_ocr: { label: "Needs OCR", tone: "warning" },
  empty: { label: "Empty", tone: "info" },
  failed: { label: "Failed", tone: "destructive" },
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Render an ISO date (YYYY, YYYY-MM or YYYY-MM-DD) at its precision: "3 Mar 2021", "Mar 2021", "2021". Never shifts by time zone. */
export function formatPreciseDate(iso: string | null | undefined, precision?: DatePrecision | null): string {
  if (!iso) return "";
  const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/.exec(iso);
  if (!m) return iso;
  const [, y, mo, d] = m;
  const p: DatePrecision = precision ?? (d ? "day" : mo ? "month" : "year");
  if (p === "year" || !mo) return y;
  const month = MONTHS[Number(mo) - 1] ?? mo;
  if (p === "month" || !d) return `${month} ${y}`;
  return `${Number(d)} ${month} ${y}`;
}

/** Sortable key for an event date; year- and month-precision dates sort before day dates in the same period. */
export function dateSortKey(iso: string): string {
  return (iso + "-00-00").slice(0, 10);
}

export function sortEvents<T extends Pick<DocEvent, "date" | "fileName" | "page">>(events: T[]): T[] {
  return [...events].sort((a, b) => dateSortKey(a.date).localeCompare(dateSortKey(b.date)) || a.fileName.localeCompare(b.fileName) || (a.page ?? 0) - (b.page ?? 0));
}

export function groupByYear<T extends Pick<DocEvent, "date">>(events: T[]): { year: string; items: T[] }[] {
  const out: { year: string; items: T[] }[] = [];
  for (const e of events) {
    const year = e.date.slice(0, 4);
    const last = out[out.length - 1];
    if (last && last.year === year) last.items.push(e); else out.push({ year, items: [e] });
  }
  return out;
}

// ---- CSV ------------------------------------------------------------------------------------------------------------

/** One CSV cell: quoted when needed, and formula-leading text neutralised so a spreadsheet does not execute it. */
export function csvCell(v: unknown): string {
  let s = v == null ? "" : Array.isArray(v) ? v.join("; ") : String(v);
  if (/^[=+@\t\r]/.test(s) || /^-[^\d\s]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  return [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

export function safeFileName(s: string): string {
  return s.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "export";
}

// ---- citations ------------------------------------------------------------------------------------------------------

export const CITE_HREF = "#doc-cite-";

/**
 * Turn [n] / [n, m] markers into markdown links (`[n](#doc-cite-n)`) so the renderer can show them as chips. Markdown
 * links (`[text](url)`) and code are left alone. Numbers with no citation are linked too; the renderer shows them as
 * unresolved (never re-bound to another passage).
 */
export function linkCitationMarkers(answer: string): string {
  const parts = answer.split(/(```[\s\S]*?```|`[^`\n]*`)/g);
  return parts.map((part, i) => (i % 2 === 1 ? part : part.replace(/\[(\d{1,3}(?:\s*[,;]\s*\d{1,3})*)\](?![(:])/g, (_, list: string) =>
    list.split(/\s*[,;]\s*/).map((n) => `[${Number(n)}](${CITE_HREF}${Number(n)})`).join(" ")))).join("");
}

/** Markers present in the answer text (in order of first appearance). */
export function markersIn(answer: string): number[] {
  const seen = new Set<number>();
  for (const m of answer.matchAll(/\[(\d{1,3}(?:\s*[,;]\s*\d{1,3})*)\](?!\()/g)) for (const n of m[1].split(/\s*[,;]\s*/)) seen.add(Number(n));
  return [...seen];
}

// ---- PDF reading ----------------------------------------------------------------------------------------------------

/** Minimal shape of a pdf.js text item. */
export interface PdfTextItem { str: string; hasEOL?: boolean; transform?: number[] }

/** Join pdf.js text items into page text: items in reading order, line breaks at EOL marks or a baseline change. */
export function pageTextFromItems(items: PdfTextItem[]): string {
  let out = "";
  let lastY: number | null = null;
  for (const it of items) {
    const y = it.transform ? it.transform[5] : null;
    // A baseline change without an EOL mark is a new line (pdf.js carries spaces within a line itself).
    if (lastY != null && y != null && Math.abs(y - lastY) > 2 && out && !out.endsWith("\n")) out += "\n";
    out += it.str;
    if (it.hasEOL) out += "\n";
    if (y != null) lastY = y;
  }
  return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Pages with fewer than 20 non-space characters count as scanned (no usable text layer). */
export function isScannedText(text: string): boolean {
  return text.replace(/\s+/g, "").length < 20;
}

/** PDF date string ("D:20210303120000+05'30'") → ISO; null when unparseable. */
export function pdfDateToIso(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const m = /^(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(Z|[+-]\d{2}'?\d{2}'?)?/.exec(raw.trim());
  if (!m) return null;
  const [, y, mo = "01", d = "01", h = "00", mi = "00", s = "00", tz] = m;
  let zone = "Z";
  if (tz && tz !== "Z") { const t = tz.replace(/'/g, ""); zone = `${t.slice(0, 3)}:${t.slice(3, 5) || "00"}`; }
  const date = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}${zone}`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Split page texts into consecutive batches whose JSON-encoded size stays under `maxBytes`. */
export function batchPages(pages: string[], maxBytes: number): { fromPage: number; pages: string[] }[] {
  const enc = new TextEncoder();
  const out: { fromPage: number; pages: string[] }[] = [];
  let cur: string[] = [];
  let size = 0;
  let from = 1;
  pages.forEach((p, i) => {
    const b = enc.encode(JSON.stringify(p)).length + 1;
    if (cur.length && size + b > maxBytes) { out.push({ fromPage: from, pages: cur }); cur = []; size = 0; from = i + 1; }
    cur.push(p); size += b;
  });
  if (cur.length || !out.length) out.push({ fromPage: from, pages: cur });
  return out;
}

export function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i).toLowerCase() : "";
}

export function shortHash(sha: string): string {
  return sha ? sha.slice(0, 10) : "—";
}
