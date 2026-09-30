"use client";
/**
 * Browser-side PDF reading for document sets: SHA-256 of the original bytes (WebCrypto), page texts in order through
 * pdf.js (scanned pages → ""), the PDF's own metadata date, and page rasterisation for AI OCR. Nothing is uploaded here.
 */
import { openPdf, renderPageToDataUrl, type PDFDocumentProxy } from "@/modules/office/pdf/pdfjs";
import { DOCS_LIMITS } from "../types";
import { isScannedText, pageTextFromItems, pdfDateToIso, type PdfTextItem } from "./format";

export async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const view = data instanceof Uint8Array ? data : new Uint8Array(data);
  const digest = await crypto.subtle.digest("SHA-256", view as unknown as ArrayBuffer);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export class PdfReadError extends Error {}

export interface PdfRead { sha256: string; pages: string[]; docDate: string | null; scanned: number }

function aborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
}

/** Read every page's text. Throws PdfReadError with a user-facing reason (encrypted, too many pages, unreadable). */
export async function readPdf(file: File, opts: { signal?: AbortSignal; onPage?: (done: number, total: number) => void } = {}): Promise<PdfRead> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  aborted(opts.signal);
  const sha256 = await sha256Hex(bytes);
  aborted(opts.signal);
  let doc: PDFDocumentProxy;
  try {
    doc = await openPdf(bytes);
  } catch (e) {
    const name = (e as { name?: string })?.name;
    if (name === "PasswordException") throw new PdfReadError("The PDF is password-protected; remove the password and upload it again.");
    throw new PdfReadError(`The PDF could not be read (${(e as Error)?.message ?? "invalid file"}).`);
  }
  try {
    if (doc.numPages > DOCS_LIMITS.maxPdfPages) throw new PdfReadError(`The PDF has ${doc.numPages} pages; the limit is ${DOCS_LIMITS.maxPdfPages}.`);
    let docDate: string | null = null;
    try {
      const meta = await doc.getMetadata();
      const info = (meta?.info ?? {}) as { CreationDate?: unknown; ModDate?: unknown };
      docDate = pdfDateToIso(info.CreationDate) ?? pdfDateToIso(info.ModDate);
    } catch { /* metadata is optional */ }
    const pages: string[] = [];
    let scanned = 0;
    for (let i = 1; i <= doc.numPages; i++) {
      aborted(opts.signal);
      const page = await doc.getPage(i);
      let text = "";
      try {
        const tc = await page.getTextContent();
        text = pageTextFromItems(tc.items.filter((it): it is typeof it & PdfTextItem => "str" in it) as PdfTextItem[]);
      } finally {
        page.cleanup();
      }
      if (isScannedText(text)) { text = ""; scanned++; }
      pages.push(text);
      opts.onPage?.(i, doc.numPages);
    }
    return { sha256, pages, docDate, scanned };
  } finally {
    void doc.loadingTask.destroy();
  }
}

/** Open a PDF for OCR rasterisation, returning its hash so callers can check it is the file that was uploaded. */
export async function openForOcr(file: File): Promise<{ doc: PDFDocumentProxy; sha256: string }> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const sha256 = await sha256Hex(bytes);
  const doc = await openPdf(bytes);
  return { doc, sha256 };
}

/** Render one page to a JPEG data URL at ~150 dpi, stepping down quality/scale until it fits the OCR limit. */
export async function rasterisePage(doc: PDFDocumentProxy, pageNo: number): Promise<string> {
  const page = await doc.getPage(pageNo);
  try {
    const attempts: { scale: number; quality: number }[] = [
      { scale: 150 / 72, quality: 0.82 }, { scale: 150 / 72, quality: 0.65 }, { scale: 120 / 72, quality: 0.6 }, { scale: 100 / 72, quality: 0.5 },
    ];
    for (const a of attempts) {
      const { dataUrl } = await renderPageToDataUrl(page, { scale: a.scale, type: "image/jpeg", quality: a.quality });
      if (dataUrl.length <= DOCS_LIMITS.maxOcrImageBytes) return dataUrl;
    }
    throw new Error("The page image is too large to send for OCR.");
  } finally {
    page.cleanup();
  }
}
