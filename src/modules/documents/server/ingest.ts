import "server-only";
import { createHash } from "node:crypto";
import { nanoid } from "nanoid";
import type { Principal } from "@/lib/auth/types";
import { describeImage } from "@/lib/ai/agent";
import { extensionOf, safeFileName, scanUpload, type DetectedKind } from "@/lib/net/upload-guard";
import { extractTextFromBytes } from "@/modules/workflows/extract-text";
import { DOCS_ACCEPT, DOCS_LIMITS, type BrowserPdfUpload, type DocFile, type DocFileStatus, type DocSet, type ExtractionMethod, type UploadResult } from "../types";
import { DocsError, loadSet } from "./access";
import { assertStorageAvailable, recordAudit } from "./sets";
import { docStore, DuplicateFileError, publicFile, type ChunkRow, type DocStore, type StoredFile } from "./store";
import { chunkPage, isoFromTimestamp, joinChunks, normalizePageText } from "./text";

/**
 * Ingest: browser-read PDFs (page texts as JSON, batched for large files), server-extracted small files (multipart),
 * and per-page OCR of scanned pages by the vision model. Original bytes are never stored; text is stored by page with
 * the SHA-256, size, type and extraction method. Every file gets an explicit result (created / duplicate / rejected).
 */

/** Characters of page text accepted in one JSON call (the serverless request body is capped near 4.5 MB). */
export const MAX_PAGE_TEXT_PER_CALL = 3_500_000;

const PDF_METHODS: ExtractionMethod[] = ["browser-pdfjs", "server-pdf"];
const isPaged = (f: Pick<DocFile, "method">) => PDF_METHODS.includes(f.method);

const sha256Hex = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

/** Chunk rows for pages (1-based numbers, or null for a non-paged document), numbering from `startIdx`. */
export function pageChunkRows(fileId: string, setId: string, pages: { page: number | null; text: string }[], startIdx = 0): ChunkRow[] {
  const out: ChunkRow[] = [];
  let idx = startIdx;
  for (const p of pages) for (const c of chunkPage(p.text)) out.push({ fileId, setId, idx: idx++, page: p.page, text: c.text, lead: c.lead });
  return out;
}

/** Status from what is stored: scanned pages still needing OCR make a file partial / needs_ocr. */
export function computeStatus(f: Pick<DocFile, "method" | "pages" | "pagesReceived" | "ocrPages" | "chars" | "status">): DocFileStatus {
  if (f.status === "failed") return "failed";
  if (isPaged(f)) {
    if ((f.pagesReceived ?? f.pages) < f.pages) return "partial";
    if (f.ocrPages.length) return f.chars > 0 ? "partial" : "needs_ocr";
  }
  return f.chars > 0 ? "ready" : "empty";
}

interface PageBudget { stored: { page: number; text: string }[]; ocrPages: number[]; chars: number; truncatedAt: number | null }

/** Normalise pages, record pages with no text layer, and stop storing text once the per-file character cap is hit. */
function takePages(texts: string[], firstPage: number, charsSoFar: number, alreadyTruncated: boolean): PageBudget {
  const out: PageBudget = { stored: [], ocrPages: [], chars: charsSoFar, truncatedAt: null };
  let truncated = alreadyTruncated;
  texts.forEach((raw, i) => {
    const page = firstPage + i;
    if (truncated) return;
    let text = normalizePageText(typeof raw === "string" ? raw : "");
    if (!text) { out.ocrPages.push(page); return; }
    const room = DOCS_LIMITS.maxFileChars - out.chars;
    if (text.length > room) {
      text = text.slice(0, Math.max(0, room));
      truncated = true;
      out.truncatedAt = page;
    }
    if (text) { out.stored.push({ page, text }); out.chars += text.length; }
  });
  return out;
}

const truncNote = (page: number | null) => page == null
  ? `Text truncated at ${DOCS_LIMITS.maxFileChars.toLocaleString("en-IN")} characters.`
  : `Text truncated at ${DOCS_LIMITS.maxFileChars.toLocaleString("en-IN")} characters: page ${page} is cut and later pages are not indexed.`;

const isTruncated = (f: Pick<DocFile, "note">) => /Text truncated at/.test(f.note ?? "");

function joinNotes(...notes: (string | null | undefined)[]): string | null {
  const s = notes.filter((n): n is string => !!n && !!n.trim()).join(" ");
  return s || null;
}

async function admit(store: DocStore, set: DocSet, name: string, sha256: string): Promise<UploadResult | null> {
  const dup = await store.findFileBySha(set.id, sha256);
  if (dup) return { status: "duplicate", file: publicFile(dup) };
  if ((await store.countFiles(set.id)) >= DOCS_LIMITS.maxFilesPerSet) return { status: "rejected", name, reason: `A set holds at most ${DOCS_LIMITS.maxFilesPerSet.toLocaleString("en-IN")} files.` };
  try { await assertStorageAvailable(); } catch (e) { return { status: "rejected", name, reason: (e as Error).message }; }
  return null;
}

async function insert(store: DocStore, set: DocSet, file: StoredFile, chunks: ChunkRow[], principal: Principal): Promise<UploadResult> {
  try {
    await store.insertFile(file, chunks);
  } catch (e) {
    if (e instanceof DuplicateFileError) {
      const dup = await store.findFileBySha(set.id, file.sha256);
      if (dup) return { status: "duplicate", file: publicFile(dup) };
    }
    throw e;
  }
  await store.refreshSetCounts(set.id);
  recordAudit(principal, "import", { kind: "document_file", id: file.id, label: file.name, matterId: set.matterId ?? undefined }, { setId: set.id, sha256: file.sha256, hashOrigin: file.hashOrigin, method: file.method, pages: file.pages, chars: file.chars, status: file.status });
  return { status: "created", file: publicFile(file) };
}

// ---- browser PDF (JSON) -----------------------------------------------------------------------------------------

export type BrowserPdfBody = BrowserPdfUpload & { totalPages?: number };

export async function uploadBrowserPdf(principal: Principal, setId: string, body: BrowserPdfBody): Promise<UploadResult> {
  const set = await loadSet(principal, setId, "write");
  const rawName = typeof body?.name === "string" ? body.name : "";
  const name = safeFileName(rawName.split(/[\\/]/).pop() ?? "") ?? "";
  const reject = (reason: string): UploadResult => ({ status: "rejected", name: name || rawName.slice(0, 200) || "(unnamed)", reason });
  if (body?.kind !== "pdf-text") return reject("Unsupported upload kind");
  if (!name || extensionOf(name) !== "pdf") return reject("Only PDF files are sent as page text");
  const size = Number(body.size);
  if (!Number.isFinite(size) || size <= 0) return reject("File size is missing");
  if (size > DOCS_LIMITS.maxPdfBytes) return reject(`PDFs larger than ${DOCS_LIMITS.maxPdfBytes / 1024 / 1024} MB are not accepted`);
  const sha = typeof body.sha256 === "string" ? body.sha256.trim().toLowerCase() : "";
  if (!/^[0-9a-f]{64}$/.test(sha)) return reject("A SHA-256 of the file is required");
  if (!Array.isArray(body.pages) || !body.pages.length || body.pages.some((p) => typeof p !== "string")) return reject("Page texts are missing");
  const totalPages = body.totalPages == null ? body.pages.length : Number(body.totalPages);
  if (!Number.isInteger(totalPages) || totalPages < body.pages.length) return reject("totalPages must be at least the number of pages sent");
  if (totalPages > DOCS_LIMITS.maxPdfPages) return reject(`PDFs with more than ${DOCS_LIMITS.maxPdfPages} pages are not accepted`);
  const sent = body.pages.reduce((n, p) => n + p.length, 0);
  if (sent > MAX_PAGE_TEXT_PER_CALL) return reject(`Too much text in one request (${sent.toLocaleString("en-IN")} characters); send the pages in batches`);

  const store = await docStore();
  const blocked = await admit(store, set, name, sha);
  if (blocked) return blocked;

  const taken = takePages(body.pages, 1, 0, false);
  const id = `dfile_${nanoid(12)}`;
  const file: StoredFile = {
    id, setId: set.id, name, mime: "application/pdf", size, sha256: sha, hashOrigin: "browser", method: "browser-pdfjs", status: "ready",
    pages: totalPages, pagesReceived: body.pages.length, ocrPages: taken.ocrPages, ocrDonePages: [], chars: taken.chars,
    docDate: isoFromTimestamp(body.docDate ?? null), note: taken.truncatedAt != null ? truncNote(taken.truncatedAt) : null,
    uploadedBy: principal.id, uploadedAt: new Date().toISOString(), extraction: "pending", extractionVersion: null, extractionAttempts: 0,
  };
  file.status = computeStatus(file);
  return insert(store, set, file, pageChunkRows(id, set.id, taken.stored), principal);
}

/** Append the next batch of a large browser-read PDF. Re-sending a batch already stored is a no-op. */
export async function appendPages(principal: Principal, setId: string, fileId: string, body: { appendPages?: unknown; fromPage?: unknown }): Promise<{ file: DocFile }> {
  const set = await loadSet(principal, setId, "write");
  const store = await docStore();
  const pages = body?.appendPages;
  const from = Number(body?.fromPage);
  if (!Array.isArray(pages) || !pages.length || pages.some((p) => typeof p !== "string")) throw new DocsError("appendPages must be a list of page texts", 422, "invalid");
  if (!Number.isInteger(from) || from < 1) throw new DocsError("fromPage must be a page number", 422, "invalid");
  const sent = (pages as string[]).reduce((n, p) => n + p.length, 0);
  if (sent > MAX_PAGE_TEXT_PER_CALL) throw new DocsError("Too much text in one request; send smaller batches", 413, "too_large");

  // Serialised with OCR on the same file; each page is written with replacePageChunks, so a retry after a partial
  // write (chunks stored, file row not updated) replaces those pages instead of duplicating their text.
  return withFileLock(fileId, async () => {
    const file = await store.getFile(set.id, fileId);
    if (!file) throw new DocsError("File not found", 404, "not_found");
    if (file.method !== "browser-pdfjs") throw new DocsError("Pages can only be appended to a PDF read in the browser", 409, "conflict");
    const received = file.pagesReceived ?? file.pages;
    const last = from + pages.length - 1;
    if (last <= received) return { file: publicFile(file) }; // already stored (retry)
    if (from !== received + 1) throw new DocsError(`Expected pages from ${received + 1}; got ${from}`, 409, "conflict");
    if (last > file.pages) throw new DocsError(`The file has ${file.pages} pages; got pages up to ${last}`, 422, "invalid");
    await assertStorageAvailable();

    const already = isTruncated(file);
    const taken = takePages(pages as string[], from, file.chars, already);
    let idx = (await store.maxChunkIdx(file.id)) + 1;
    for (let page = from; page <= last; page++) {
      const rows = pageChunkRows(file.id, set.id, taken.stored.filter((p) => p.page === page), idx);
      idx += rows.length;
      await store.replacePageChunks(file.id, page, rows);
    }
    const next: StoredFile = {
      ...file,
      pagesReceived: last,
      ocrPages: already ? file.ocrPages : [...file.ocrPages.filter((p) => p < from || p > last), ...taken.ocrPages],
      chars: taken.chars,
      note: taken.truncatedAt != null ? joinNotes(file.note, truncNote(taken.truncatedAt)) : file.note,
      extraction: "pending",
      extractionAttempts: 0,
    };
    next.status = computeStatus(next);
    await store.updateFile(next);
    await store.deleteExtraction(file.id);
    await store.refreshSetCounts(set.id);
    return { file: publicFile(next) };
  });
}

// ---- server-extracted files (multipart) -------------------------------------------------------------------------

const SERVER_KINDS: DetectedKind[] = ["pdf", "docx", "ooxml", "text", "csv", "json", "html", "eml"];

/** Decode quoted-printable / base64 MIME bodies; best effort. */
function decodeBody(body: string, encoding: string | undefined): string {
  const enc = (encoding ?? "").trim().toLowerCase();
  if (enc === "base64") {
    try { return Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8"); } catch { return body; }
  }
  if (enc === "quoted-printable") {
    const bytes = Buffer.from(body.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16))), "latin1");
    return bytes.toString("utf8");
  }
  return body;
}

function parseHeaders(block: string): Map<string, string> {
  const h = new Map<string, string>();
  const unfolded = block.replace(/\r?\n[ \t]+/g, " ");
  for (const line of unfolded.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) { const k = line.slice(0, i).trim().toLowerCase(); if (!h.has(k)) h.set(k, line.slice(i + 1).trim()); }
  }
  return h;
}

function splitMessage(raw: string): { headers: Map<string, string>; body: string } {
  const m = /\r?\n\r?\n/.exec(raw);
  if (!m) return { headers: parseHeaders(raw), body: "" };
  return { headers: parseHeaders(raw.slice(0, m.index)), body: raw.slice(m.index + m[0].length) };
}

/** The readable text body of a MIME entity: text/plain preferred, then text/html stripped of tags. */
function mimeText(headers: Map<string, string>, body: string, depth = 0): { text: string; html: boolean } | null {
  const ct = (headers.get("content-type") ?? "text/plain").toLowerCase();
  if (ct.startsWith("multipart/") && depth < 4) {
    const boundary = /boundary="?([^";]+)"?/i.exec(headers.get("content-type") ?? "")?.[1];
    if (!boundary) return { text: body, html: false };
    const parts = body.split(`--${boundary}`).slice(1).filter((p) => !p.startsWith("--"));
    const decoded = parts.map((p) => { const s = splitMessage(p.replace(/^\r?\n/, "")); return mimeText(s.headers, s.body, depth + 1); }).filter((x): x is { text: string; html: boolean } => !!x && !!x.text.trim());
    return decoded.find((d) => !d.html) ?? decoded[0] ?? null;
  }
  if (!ct.startsWith("text/")) return null;
  return { text: decodeBody(body, headers.get("content-transfer-encoding")), html: ct.startsWith("text/html") };
}

/** RFC 822 email → header lines + body text, and the Date header as the document date. */
export async function parseEml(bytes: Uint8Array): Promise<{ text: string; docDate: string | null }> {
  const raw = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const { headers, body } = splitMessage(raw);
  const part = mimeText(headers, body);
  let text = part?.text ?? "";
  if (part?.html) {
    const { htmlToText } = await import("@/lib/ai/toolkit/http");
    text = htmlToText(text, { maxChars: DOCS_LIMITS.maxFileChars }).text;
  }
  const head = ["from", "to", "cc", "date", "subject"].filter((k) => headers.get(k)).map((k) => `${k[0].toUpperCase()}${k.slice(1)}: ${headers.get(k)}`).join("\n");
  return { text: `${head}\n\n${text}`.trim(), docDate: isoFromTimestamp(headers.get("date")) };
}

/** DOCX core properties: dcterms:created (else modified). */
async function docxDate(bytes: Uint8Array): Promise<string | null> {
  try {
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(bytes);
    const xml = await zip.file("docProps/core.xml")?.async("string");
    if (!xml) return null;
    const created = /<dcterms:created[^>]*>([^<]+)<\/dcterms:created>/.exec(xml)?.[1];
    const modified = /<dcterms:modified[^>]*>([^<]+)<\/dcterms:modified>/.exec(xml)?.[1];
    return isoFromTimestamp(created) ?? isoFromTimestamp(modified);
  } catch {
    return null;
  }
}

interface Extracted { method: ExtractionMethod; pages: { page: number | null; text: string }[]; pageCount: number; docDate: string | null; note: string | null }

async function extractServer(bytes: Uint8Array, name: string, mime: string, ext: string): Promise<Extracted> {
  if (ext === "eml") {
    const { text, docDate } = await parseEml(bytes);
    return { method: "server-eml", pages: [{ page: null, text }], pageCount: 1, docDate, note: null };
  }
  const x = await extractTextFromBytes(bytes, name, mime);
  const cut = x.truncated ? "The extractor stopped at 400,000 characters; later text is not indexed." : null;
  if (ext === "pdf") {
    const parts = x.text.split(/\[Page (\d+)\]\n?/);
    const pages: { page: number; text: string }[] = [];
    for (let i = 1; i < parts.length; i += 2) pages.push({ page: Number(parts[i]), text: parts[i + 1] ?? "" });
    return { method: "server-pdf", pages, pageCount: x.pages ?? pages.length, docDate: null, note: cut };
  }
  if (ext === "docx") return { method: "server-docx", pages: [{ page: null, text: x.text }], pageCount: 1, docDate: await docxDate(bytes), note: cut };
  return { method: "server-text", pages: [{ page: null, text: x.text }], pageCount: 1, docDate: null, note: cut };
}

export async function uploadServerFile(principal: Principal, setId: string, input: { name: string; mime: string; bytes: Uint8Array }): Promise<UploadResult> {
  const set = await loadSet(principal, setId, "write");
  const displayName = (input.name ?? "").split(/[\\/]/).pop()?.slice(0, 200) || "(unnamed)";
  const ext = extensionOf(input.name ?? "");
  if (!(DOCS_ACCEPT as readonly string[]).includes(`.${ext}`)) return { status: "rejected", name: displayName, reason: `.${ext || "?"} files are not accepted (accepted: ${DOCS_ACCEPT.join(", ")})` };
  if (input.bytes.length > DOCS_LIMITS.maxServerFileBytes) return { status: "rejected", name: displayName, reason: `Files sent to the server are limited to ${DOCS_LIMITS.maxServerFileBytes / 1024 / 1024} MB${ext === "pdf" ? " (larger PDFs are read in the browser)" : ""}` };
  const verdict = await scanUpload({ name: input.name, mime: input.mime, size: input.bytes.length, head: input.bytes.subarray(0, 16_384), bytes: input.bytes }, { maxBytes: DOCS_LIMITS.maxServerFileBytes, allowedKinds: SERVER_KINDS });
  if (!verdict.ok) return { status: "rejected", name: displayName, reason: verdict.message };
  const sha = sha256Hex(input.bytes);
  const store = await docStore();
  const blocked = await admit(store, set, verdict.safeName, sha);
  if (blocked) return blocked;

  const id = `dfile_${nanoid(12)}`;
  const base: StoredFile = {
    id, setId: set.id, name: verdict.safeName, mime: verdict.mime, size: input.bytes.length, sha256: sha, hashOrigin: "server", method: "server-text",
    status: "ready", pages: 1, pagesReceived: 1, ocrPages: [], ocrDonePages: [], chars: 0, docDate: null, note: null, uploadedBy: principal.id,
    uploadedAt: new Date().toISOString(), extraction: "pending", extractionVersion: null, extractionAttempts: 0,
  };
  let x: Extracted;
  try {
    x = await extractServer(input.bytes, verdict.safeName, verdict.mime, ext);
  } catch (e) {
    const method: ExtractionMethod = ext === "pdf" ? "server-pdf" : ext === "docx" ? "server-docx" : ext === "eml" ? "server-eml" : "server-text";
    const reason = ext === "pdf" && /no text layer/i.test((e as Error).message)
      ? "This PDF has no text layer. Upload it again so it is read in the browser, where scanned pages can be transcribed."
      : `Could not read the file: ${(e as Error).message}`;
    return insert(store, set, { ...base, method, status: "failed", note: reason.slice(0, 500) }, [], principal);
  }
  if (x.method === "server-pdf") {
    const texts: string[] = Array.from({ length: x.pageCount }, (_, i) => x.pages.find((p) => p.page === i + 1)?.text ?? "");
    const taken = takePages(texts, 1, 0, false);
    const file: StoredFile = { ...base, method: x.method, pages: x.pageCount, pagesReceived: x.pageCount, ocrPages: taken.ocrPages, chars: taken.chars, docDate: x.docDate, note: joinNotes(x.note, taken.truncatedAt != null ? truncNote(taken.truncatedAt) : null) };
    file.status = computeStatus(file);
    return insert(store, set, file, pageChunkRows(id, set.id, taken.stored), principal);
  }
  let text = normalizePageText(x.pages[0]?.text ?? "");
  let note = x.note;
  if (text.length > DOCS_LIMITS.maxFileChars) { text = text.slice(0, DOCS_LIMITS.maxFileChars); note = joinNotes(note, truncNote(null)); }
  const file: StoredFile = { ...base, method: x.method, chars: text.length, docDate: x.docDate, note };
  file.status = computeStatus(file);
  return insert(store, set, file, pageChunkRows(id, set.id, text ? [{ page: null, text }] : []), principal);
}

// ---- OCR ----------------------------------------------------------------------------------------------------------

export const OCR_PROMPT = "This image is one page of a scanned legal document. Transcribe all of the text on the page exactly as written, in reading order, keeping paragraph breaks. Do not summarise, translate, correct or describe the page. Output only the transcription; if the page has no text, output nothing.";

/** Decode and validate a page image data URL (JPEG or PNG by magic bytes, size-limited). */
export function decodePageImage(image: unknown): { mime: "image/jpeg" | "image/png"; bytes: Buffer; dataUrl: string } {
  if (typeof image !== "string") throw new DocsError("image must be a data URL", 422, "invalid");
  const m = /^data:(image\/(?:jpeg|jpg|png));base64,([A-Za-z0-9+/=\s]+)$/.exec(image);
  if (!m) throw new DocsError("image must be a JPEG or PNG data URL", 422, "invalid");
  const b64 = m[2].replace(/\s+/g, "");
  if (Math.floor((b64.length * 3) / 4) > DOCS_LIMITS.maxOcrImageBytes + 3) throw new DocsError(`Page images are limited to ${DOCS_LIMITS.maxOcrImageBytes / 1024 / 1024} MB`, 413, "too_large");
  const bytes = Buffer.from(b64, "base64");
  if (bytes.length > DOCS_LIMITS.maxOcrImageBytes) throw new DocsError(`Page images are limited to ${DOCS_LIMITS.maxOcrImageBytes / 1024 / 1024} MB`, 413, "too_large");
  const jpeg = bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const png = bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const mime = jpeg ? "image/jpeg" : png ? "image/png" : null;
  if (!mime) throw new DocsError("The image content is not a JPEG or PNG", 422, "invalid");
  return { mime, bytes, dataUrl: `data:${mime};base64,${b64}` };
}

/** Serialises OCR writes per file within this instance (the page bookkeeping is read-modify-write). */
const fileLocks = new Map<string, Promise<unknown>>();
async function withFileLock<T>(fileId: string, fn: () => Promise<T>): Promise<T> {
  const prev = fileLocks.get(fileId) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(fn);
  fileLocks.set(fileId, run);
  try { return await run; } finally { if (fileLocks.get(fileId) === run) fileLocks.delete(fileId); }
}

export async function ocrPage(principal: Principal, setId: string, fileId: string, body: { page?: unknown; image?: unknown }): Promise<{ file: DocFile; page: number; chars: number }> {
  const set = await loadSet(principal, setId, "write");
  const store = await docStore();
  const file = await store.getFile(set.id, fileId);
  if (!file) throw new DocsError("File not found", 404, "not_found");
  if (!isPaged(file)) throw new DocsError("OCR applies to PDF pages only", 409, "conflict");
  const page = Number(body?.page);
  if (!Number.isInteger(page) || page < 1 || page > file.pages) throw new DocsError(`page must be between 1 and ${file.pages}`, 422, "invalid");
  if (!file.ocrPages.includes(page) && !(file.ocrDonePages ?? []).includes(page)) throw new DocsError(`Page ${page} has a text layer; it does not need OCR`, 409, "conflict");
  const img = decodePageImage(body?.image);
  await assertStorageAvailable();

  const res = await describeImage(img.dataUrl, OCR_PROMPT, { fast: true });
  const transcribed = normalizePageText(res.text ?? "");

  return withFileLock(file.id, async () => {
    const current = (await store.getFile(set.id, file.id)) ?? file;
    const old = await store.fileChunks(current.id, page);
    const oldChars = joinChunks(old).length;
    const room = Math.max(0, DOCS_LIMITS.maxFileChars - (current.chars - oldChars));
    const text = transcribed.slice(0, room);
    const start = (await store.maxChunkIdx(current.id)) + 1;
    await store.replacePageChunks(current.id, page, pageChunkRows(current.id, set.id, text ? [{ page, text }] : [], start));
    const next: StoredFile = {
      ...current,
      ocrPages: current.ocrPages.filter((p) => p !== page),
      ocrDonePages: Array.from(new Set([...(current.ocrDonePages ?? []), page])).sort((a, b) => a - b),
      chars: current.chars - oldChars + text.length,
      note: text.length < transcribed.length ? joinNotes(current.note, truncNote(page)) : current.note,
      extraction: "pending",
      extractionAttempts: 0,
    };
    next.status = computeStatus(next);
    await store.updateFile(next);
    await store.deleteExtraction(current.id);
    await store.refreshSetCounts(set.id);
    recordAudit(principal, "ai.generate", { kind: "document_file", id: current.id, label: current.name, matterId: set.matterId ?? undefined }, { setId: set.id, page, method: "ocr-ai", chars: text.length });
    return { file: publicFile(next), page, chars: text.length };
  });
}
