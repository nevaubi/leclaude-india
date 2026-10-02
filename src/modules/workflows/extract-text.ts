import "server-only";
import { loadPdfjs } from "@/lib/pdf/pdfjs-server";
import { db } from "@/lib/db";

/**
 * Best-effort text extraction for uploaded run inputs. Plain text, Markdown,
 * CSV and JSON are decoded directly; .docx via mammoth; .xlsx via SheetJS;
 * .pptx by reading slide XML; PDF through pdfjs (text layer only — scanned
 * PDFs need OCR, which is out of scope: the run form lets the user paste text).
 */
export interface ExtractedText { text: string; name?: string; mime: string; method: string; pages?: number; truncated: boolean }

const MAX_CHARS = 400_000;

function finish(text: string, name: string | undefined, mime: string, method: string, pages?: number): ExtractedText {
  const clean = text.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return { text: clean.slice(0, MAX_CHARS), name, mime, method, pages, truncated: clean.length > MAX_CHARS };
}

/** Office Open XML formats are zip packages whose MIME types contain "xml"; they must never be decoded as text. */
function officeKind(ext: string, mime: string): "docx" | "xlsx" | "pptx" | null {
  if (ext === "docx" || /wordprocessingml/.test(mime)) return "docx";
  if (ext === "xlsx" || ext === "xls" || ext === "xlsm" || /spreadsheetml|ms-excel/.test(mime)) return "xlsx";
  if (ext === "pptx" || /presentationml/.test(mime)) return "pptx";
  return null;
}

/** Zip container (PK\x03\x04): binary, whatever the declared type says. */
function isZip(bytes: Uint8Array) {
  return bytes.length > 3 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

export async function extractTextFromBytes(bytes: Uint8Array, name: string | undefined, mime: string): Promise<ExtractedText> {
  const ext = (name ?? "").toLowerCase().split(".").pop() ?? "";
  const office = officeKind(ext, mime);
  if (office === "docx") {
    const mammoth = (await import("mammoth")).default;
    const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    return finish(result.value, name, mime, "mammoth");
  }
  if (office === "xlsx") {
    const XLSX = await import("xlsx");
    const wb = XLSX.read(bytes, { type: "array" });
    const parts = wb.SheetNames.map((s) => `## ${s}\n${XLSX.utils.sheet_to_csv(wb.Sheets[s])}`);
    return finish(parts.join("\n\n"), name, mime, "sheetjs");
  }
  if (office === "pptx") {
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(bytes);
    const slides = Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f)).sort((a, b) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]));
    const parts: string[] = [];
    for (const [i, f] of slides.entries()) {
      const xml = await zip.file(f)!.async("string");
      const text = Array.from(xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)).map((m) => m[1]).join(" ");
      parts.push(`## Slide ${i + 1}\n${text}`);
    }
    return finish(parts.join("\n\n"), name, mime, "pptx-xml", slides.length);
  }
  const isText = !isZip(bytes) && (/^text\/|json|xml|csv|markdown/.test(mime) || ["txt", "md", "csv", "json", "html", "htm", "xml"].includes(ext));
  if (isText) {
    let text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    if (ext === "html" || ext === "htm" || /html/.test(mime)) {
      const { htmlToText } = await import("@/lib/ai/toolkit/http");
      text = htmlToText(text, { maxChars: MAX_CHARS }).text;
    }
    return finish(text, name, mime, "text");
  }
  if (ext === "pdf" || /pdf/.test(mime)) {
    try {
      const pdfjs = await loadPdfjs();
      const doc = await pdfjs.getDocument({ data: bytes, useSystemFonts: true, disableFontFace: true }).promise;
      const parts: string[] = [];
      for (let p = 1; p <= doc.numPages; p++) {
        const page = await doc.getPage(p);
        const content = await page.getTextContent();
        const line = content.items.map((it) => ("str" in it ? it.str : "")).join(" ");
        parts.push(`[Page ${p}]\n${line}`);
      }
      const text = parts.join("\n\n");
      if (text.replace(/\[Page \d+\]/g, "").trim().length < 20) throw new Error("no text layer");
      return finish(text, name, mime, "pdfjs", doc.numPages);
    } catch (e) {
      throw new Error(`Could not extract text from this PDF (${(e as Error).message}). If it is a scanned image, paste the text instead.`);
    }
  }
  throw new Error(`Unsupported file type${name ? ` for ${name}` : ""} (${mime}). Upload .docx, .pdf, .xlsx, .pptx, .txt, .md, .csv or .json, or paste the text.`);
}

export async function extractTextFromBlob(blobId: string): Promise<ExtractedText> {
  const b = db().blobs.get(blobId);
  if (!b) throw new Error("Upload not found");
  return extractTextFromBytes(b.bytes, b.name, b.mime);
}
