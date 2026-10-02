import "server-only";
import { loadPdfjs } from "@/lib/pdf/pdfjs-server";
import { htmlToText } from "@/lib/ai/toolkit/http";

/**
 * Text extraction for the local corpus and for binary web documents. PDF via
 * pdfjs (text layer only; page markers "[Page N]" are emitted so chunking stays
 * page-aware), .docx via mammoth, .xlsx via SheetJS, plus txt/md/html/json/csv.
 * Scanned PDFs without a text layer come back with `method: "none"` and an
 * empty text so callers can flag a parse_error instead of indexing garbage.
 */
export interface ExtractedIntelText {
  text: string;
  method: "text" | "html" | "mammoth" | "sheetjs" | "pdfjs" | "none";
  pages?: number;
  truncated: boolean;
  title?: string;
  warning?: string;
}

export const SUPPORTED_EXTENSIONS = ["pdf", "docx", "xlsx", "xls", "csv", "txt", "md", "markdown", "html", "htm", "json"] as const;
export type SupportedExtension = (typeof SUPPORTED_EXTENSIONS)[number];

const MAX_CHARS = 400_000;

function finish(text: string, method: ExtractedIntelText["method"], extra: Partial<ExtractedIntelText> = {}): ExtractedIntelText {
  const clean = text.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return { text: clean.slice(0, MAX_CHARS), method, truncated: clean.length > MAX_CHARS, ...extra };
}

export function extensionOf(name: string | undefined): string {
  return (name ?? "").toLowerCase().split(".").pop() ?? "";
}

export function isSupportedFile(name: string): boolean {
  return (SUPPORTED_EXTENSIONS as readonly string[]).includes(extensionOf(name));
}

export async function extractIntelText(bytes: Uint8Array, name: string | undefined, mime = ""): Promise<ExtractedIntelText> {
  const ext = extensionOf(name);
  if (ext === "pdf" || /pdf/i.test(mime)) return extractPdf(bytes);
  if (ext === "docx" || /wordprocessingml/i.test(mime)) {
    const mammoth = (await import("mammoth")).default;
    const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    return finish(result.value, "mammoth", { warning: result.messages?.length ? result.messages.map((m) => m.message).slice(0, 3).join("; ") : undefined });
  }
  if (ext === "xlsx" || ext === "xls" || /spreadsheetml|ms-excel/i.test(mime)) {
    const XLSX = await import("xlsx");
    const wb = XLSX.read(bytes, { type: "array" });
    const parts = wb.SheetNames.map((s) => `## ${s}\n${XLSX.utils.sheet_to_csv(wb.Sheets[s])}`);
    return finish(parts.join("\n\n"), "sheetjs", { pages: wb.SheetNames.length });
  }
  const raw = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  if (ext === "html" || ext === "htm" || /html/i.test(mime)) {
    const { title, text } = htmlToText(raw, { maxChars: MAX_CHARS });
    return finish(text, "html", { title: title || undefined });
  }
  if (ext === "json" || /json/i.test(mime)) {
    try { return finish(JSON.stringify(JSON.parse(raw), null, 1), "text"); } catch { return finish(raw, "text"); }
  }
  return finish(raw, "text");
}

async function extractPdf(bytes: Uint8Array): Promise<ExtractedIntelText> {
  try {
    const pdfjs = await loadPdfjs();
    const doc = await pdfjs.getDocument({ data: bytes, useSystemFonts: true, disableFontFace: true }).promise;
    const parts: string[] = [];
    let chars = 0;
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      let line = "";
      let lastY: number | null = null;
      for (const it of content.items) {
        if (!("str" in it)) continue;
        const y = Array.isArray(it.transform) ? Number(it.transform[5]) : null;
        if (lastY != null && y != null && Math.abs(y - lastY) > 2) line += "\n";
        line += it.str + (it.hasEOL ? "\n" : " ");
        lastY = y;
      }
      parts.push(`[Page ${p}]\n${line.trim()}`);
      chars += line.length;
      if (chars > MAX_CHARS) break;
    }
    const text = parts.join("\n\n");
    if (text.replace(/\[Page \d+\]/g, "").trim().length < 20) return { text: "", method: "none", pages: doc.numPages, truncated: false, warning: "PDF has no text layer (scanned image); OCR is not available." };
    return finish(text, "pdfjs", { pages: doc.numPages });
  } catch (e) {
    return { text: "", method: "none", truncated: false, warning: `Could not read PDF: ${(e as Error).message}` };
  }
}
