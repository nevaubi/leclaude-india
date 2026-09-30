"use client";
/**
 * Bulk upload manager for a document set. Files are validated in the browser, then uploaded with bounded concurrency
 * (DOCS_LIMITS.uploadConcurrency). PDFs are read here with pdf.js and sent as page text (in batches when large, first
 * POST then PATCH appendPages); other types are posted as bytes. Every file ends in an explicit state: created,
 * duplicate, rejected (with the reason) or failed (retryable), or cancelled.
 *
 * The original File objects are kept in memory for this session (by SHA-256 and by file id) so scanned pages can be
 * rasterised for OCR without asking the user to pick the file again.
 */
import * as React from "react";
import { DOCS_ACCEPT, DOCS_LIMITS, type BrowserPdfUpload, type DocFile, type UploadResult } from "../types";
import { DocsApiError, docsApi, errorMessage, isAbort, setUrl } from "./api";
import { batchPages, extOf, formatBytes } from "./format";
import { PdfReadError, readPdf, sha256Hex } from "./pdf-read";

export type UploadState = "queued" | "reading" | "uploading" | "created" | "duplicate" | "rejected" | "failed" | "cancelled";

export interface UploadItem {
  key: string;
  file: File;
  /** Path inside a dropped/selected folder, else the name. */
  name: string;
  size: number;
  state: UploadState;
  reason?: string;
  /** Reading/uploading progress 0..1 for large PDFs. */
  progress?: number;
  doc?: DocFile;
  /** Resume point after a failed page batch: the created file and the next batch to append. */
  resume?: { fileId: string; batch: number };
}

/** Bytes of page text per request (the server caps request bodies near 4.5 MB). */
const MAX_BATCH_BYTES = 3_400_000;
const ACCEPT = new Set<string>(DOCS_ACCEPT);
export const DOCS_ACCEPT_ATTR = DOCS_ACCEPT.join(",");

const isSettled = (s: UploadState) => s === "created" || s === "duplicate" || s === "rejected" || s === "failed" || s === "cancelled";
const isStorageReason = (r: string) => /storage|database (is )?full|upgrade/i.test(r);

function precheck(file: File): string | null {
  const ext = extOf(file.name);
  if (!ACCEPT.has(ext)) return `File type ${ext || "(none)"} is not supported. Accepted: ${DOCS_ACCEPT.join(", ")}.`;
  if (file.size === 0) return "The file is empty.";
  if (ext === ".pdf") {
    if (file.size > DOCS_LIMITS.maxPdfBytes) return `PDF is ${formatBytes(file.size)}; the limit is ${formatBytes(DOCS_LIMITS.maxPdfBytes)}.`;
  } else if (file.size > DOCS_LIMITS.maxServerFileBytes) {
    return `${ext.slice(1).toUpperCase()} files are limited to ${formatBytes(DOCS_LIMITS.maxServerFileBytes)} (this one is ${formatBytes(file.size)}). Save it as PDF and upload the PDF.`;
  }
  return null;
}

let seq = 0;

export function useDocUploads(setId: string, opts: { onSettled?: () => void } = {}) {
  const [items, setItems] = React.useState<UploadItem[]>([]);
  const itemsRef = React.useRef(items);
  itemsRef.current = items;
  const [storageFull, setStorageFull] = React.useState<string | null>(null);
  const active = React.useRef(new Map<string, AbortController>());
  const cancelled = React.useRef(false);
  /** Original files kept for OCR, by uploaded file id and by SHA-256. */
  const originals = React.useRef({ byId: new Map<string, File>(), bySha: new Map<string, File>() });
  const onSettledRef = React.useRef(opts.onSettled);
  onSettledRef.current = opts.onSettled;
  const settleTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const patch = React.useCallback((key: string, p: Partial<UploadItem>) => {
    setItems((list) => list.map((it) => (it.key === key ? { ...it, ...p } : it)));
    itemsRef.current = itemsRef.current.map((it) => (it.key === key ? { ...it, ...p } : it));
  }, []);

  const notify = React.useCallback(() => {
    if (settleTimer.current) return;
    settleTimer.current = setTimeout(() => { settleTimer.current = null; onSettledRef.current?.(); }, 600);
  }, []);

  const remember = (doc: DocFile, file: File) => {
    originals.current.byId.set(doc.id, file);
    if (doc.sha256) originals.current.bySha.set(doc.sha256, file);
  };

  const uploadOne = React.useCallback(async (item: UploadItem, signal: AbortSignal) => {
    const { file, key } = item;
    const isPdf = extOf(file.name) === ".pdf";
    let result: UploadResult;
    if (!isPdf) {
      patch(key, { state: "uploading", progress: undefined });
      const fd = new FormData();
      fd.append("file", file, file.name);
      fd.append("lastModified", String(file.lastModified || ""));
      result = await docsApi<UploadResult>(setUrl(setId, "/files"), { method: "POST", body: fd, signal });
      if (result.status !== "rejected") remember(result.file, file);
    } else {
      patch(key, { state: "reading", progress: 0 });
      const read = await readPdf(file, { signal, onPage: (d, t) => { if (d === t || d % 10 === 0) patch(key, { progress: d / t }); } });
      const batches = batchPages(read.pages, MAX_BATCH_BYTES);
      patch(key, { state: "uploading", progress: 0 });
      let fileId = item.resume?.fileId;
      let start = item.resume?.batch ?? 0;
      let doc: DocFile | undefined;
      if (!fileId) {
        const upload: BrowserPdfUpload & { totalPages?: number } = {
          kind: "pdf-text", name: file.name, size: file.size, sha256: read.sha256, pages: batches[0].pages, docDate: read.docDate, lastModified: file.lastModified || undefined,
        };
        if (batches.length > 1) upload.totalPages = read.pages.length;
        result = await docsApi<UploadResult>(setUrl(setId, "/files"), { json: upload, signal });
        if (result.status === "rejected" || result.status === "duplicate") {
          if (result.status === "duplicate") { originals.current.bySha.set(read.sha256, file); remember(result.file, file); }
          return finish(key, result);
        }
        doc = result.file; fileId = doc.id; start = 1;
        remember(doc, file);
      }
      for (let b = start; b < batches.length; b++) {
        try {
          const r = await docsApi<{ file: DocFile }>(setUrl(setId, `/files/${encodeURIComponent(fileId)}`), { method: "PATCH", json: { appendPages: batches[b].pages, fromPage: batches[b].fromPage }, signal });
          doc = r.file;
          patch(key, { progress: (b + 1) / batches.length, doc });
        } catch (e) {
          patch(key, { resume: { fileId, batch: b } });
          throw e instanceof DocsApiError ? new DocsApiError(`${e.message} (stopped at page ${batches[b].fromPage}; retry continues from there)`, e.status, e.kind) : e;
        }
      }
      originals.current.bySha.set(read.sha256, file);
      result = { status: "created", file: doc ?? (await docsApi<{ file: DocFile }>(setUrl(setId, `/files/${encodeURIComponent(fileId)}`), { signal })).file };
    }
    return finish(key, result);

    function finish(k: string, r: UploadResult) {
      if (r.status === "rejected") {
        patch(k, { state: "rejected", reason: r.reason, progress: undefined });
        if (isStorageReason(r.reason)) setStorageFull(r.reason);
      } else patch(k, { state: r.status, doc: r.file, progress: undefined, resume: undefined, reason: r.status === "duplicate" ? `Already in this set as ${r.file.name}` : undefined });
    }
  }, [patch, setId]);

  const pump = React.useCallback(() => {
    if (cancelled.current) return;
    while (active.current.size < DOCS_LIMITS.uploadConcurrency) {
      const next = itemsRef.current.find((it) => it.state === "queued" && !active.current.has(it.key));
      if (!next) break;
      const ctrl = new AbortController();
      active.current.set(next.key, ctrl);
      patch(next.key, { state: next.file.name.toLowerCase().endsWith(".pdf") ? "reading" : "uploading", reason: undefined });
      void uploadOne(next, ctrl.signal)
        .catch((e) => {
          if (isAbort(e) || ctrl.signal.aborted) { patch(next.key, { state: "cancelled", progress: undefined }); return; }
          if (e instanceof PdfReadError) { patch(next.key, { state: "rejected", reason: e.message, progress: undefined }); return; }
          const msg = errorMessage(e);
          if (e instanceof DocsApiError && e.kind === "storage") { setStorageFull(msg); patch(next.key, { state: "rejected", reason: msg, progress: undefined }); return; }
          patch(next.key, { state: "failed", reason: msg, progress: undefined });
        })
        .finally(() => {
          active.current.delete(next.key);
          notify();
          pump();
        });
    }
  }, [notify, patch, uploadOne]);

  // A full store stops the queue: the remaining files get the same explicit reason instead of failing one by one.
  React.useEffect(() => {
    if (!storageFull) return;
    setItems((list) => list.map((it) => (it.state === "queued" ? { ...it, state: "rejected", reason: storageFull } : it)));
  }, [storageFull]);

  const add = React.useCallback((files: File[]) => {
    cancelled.current = false;
    const fresh: UploadItem[] = files
      .filter((f) => !/(^|\/)\.[^/]+$/.test((f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name)) // hidden files (.DS_Store)
      .map((file) => {
        const name = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
        const reason = storageFull ?? precheck(file);
        return { key: `u${++seq}`, file, name, size: file.size, state: reason ? "rejected" : "queued", reason: reason ?? undefined };
      });
    if (!fresh.length) return;
    itemsRef.current = [...itemsRef.current, ...fresh];
    setItems(itemsRef.current);
    pump();
  }, [pump, storageFull]);

  const cancelAll = React.useCallback(() => {
    cancelled.current = true;
    for (const c of active.current.values()) c.abort();
    setItems((list) => list.map((it) => (it.state === "queued" ? { ...it, state: "cancelled" } : it)));
    itemsRef.current = itemsRef.current.map((it) => (it.state === "queued" ? { ...it, state: "cancelled" } : it));
  }, []);

  const retry = React.useCallback((key: string) => {
    cancelled.current = false;
    patch(key, { state: "queued", reason: undefined });
    pump();
  }, [patch, pump]);

  const retryFailed = React.useCallback(() => {
    cancelled.current = false;
    for (const it of itemsRef.current) if (it.state === "failed" || it.state === "cancelled") patch(it.key, { state: "queued", reason: undefined });
    pump();
  }, [patch, pump]);

  const clearFinished = React.useCallback(() => {
    itemsRef.current = itemsRef.current.filter((it) => !isSettled(it.state) || it.state === "failed");
    setItems(itemsRef.current);
  }, []);

  React.useEffect(() => {
    const ctrls = active.current;
    const timer = settleTimer;
    return () => { for (const c of ctrls.values()) c.abort(); if (timer.current) clearTimeout(timer.current); };
  }, []);

  const counts = React.useMemo(() => {
    const c: Record<UploadState, number> = { queued: 0, reading: 0, uploading: 0, created: 0, duplicate: 0, rejected: 0, failed: 0, cancelled: 0 };
    for (const it of items) c[it.state]++;
    return c;
  }, [items]);
  const total = items.length;
  const settled = total - counts.queued - counts.reading - counts.uploading;

  /** Keep upload rows in step with a file that changed later (e.g. scanned pages read with OCR). */
  const updateDoc = React.useCallback((doc: DocFile) => {
    const map = (list: UploadItem[]) => list.map((it) => (it.doc?.id === doc.id ? { ...it, doc } : it));
    itemsRef.current = map(itemsRef.current);
    setItems(map);
  }, []);

  /** Find the original PDF for a stored file (same session), by id or hash. */
  const originalFor = React.useCallback((doc: Pick<DocFile, "id" | "sha256">) => originals.current.byId.get(doc.id) ?? originals.current.bySha.get(doc.sha256) ?? null, []);
  /** Register a re-selected file as the original for a stored file after checking its hash. */
  const adoptOriginal = React.useCallback(async (doc: Pick<DocFile, "id" | "sha256">, file: File): Promise<boolean> => {
    const sha = await sha256Hex(await file.arrayBuffer());
    if (sha !== doc.sha256) return false;
    originals.current.byId.set(doc.id, file);
    originals.current.bySha.set(sha, file);
    return true;
  }, []);

  return { items, counts, total, settled, busy: settled < total, storageFull, add, cancelAll, retry, retryFailed, clearFinished, originalFor, adoptOriginal, updateDoc };
}

export type DocUploads = ReturnType<typeof useDocUploads>;

// ---- folder drop ----------------------------------------------------------------------------------------------------

interface FsEntry { isFile: boolean; isDirectory: boolean; name: string; fullPath: string }
interface FsFileEntry extends FsEntry { file: (ok: (f: File) => void, err: (e: unknown) => void) => void }
interface FsDirEntry extends FsEntry { createReader: () => { readEntries: (ok: (e: FsEntry[]) => void, err: (e: unknown) => void) => void } }

/** Files from a drop, walking dropped folders (webkitGetAsEntry). Paths are kept as webkitRelativePath-like names. */
export async function filesFromDrop(dt: DataTransfer): Promise<File[]> {
  const entries = Array.from(dt.items ?? [])
    .map((i) => (i.kind === "file" && "webkitGetAsEntry" in i ? (i.webkitGetAsEntry() as FsEntry | null) : null))
    .filter((e): e is FsEntry => !!e);
  if (!entries.length) return Array.from(dt.files ?? []);
  const out: File[] = [];
  const walk = async (e: FsEntry): Promise<void> => {
    if (e.isFile) {
      const f = await new Promise<File>((ok, err) => (e as FsFileEntry).file(ok, err)).catch(() => null);
      if (f) {
        const rel = e.fullPath.replace(/^\//, "");
        if (rel !== f.name) { try { Object.defineProperty(f, "webkitRelativePath", { value: rel }); } catch { /* read-only in some engines */ } }
        out.push(f);
      }
    } else if (e.isDirectory) {
      const reader = (e as FsDirEntry).createReader();
      for (;;) {
        const batch = await new Promise<FsEntry[]>((ok, err) => reader.readEntries(ok, err)).catch(() => [] as FsEntry[]);
        if (!batch.length) break;
        for (const c of batch) await walk(c);
      }
    }
  };
  for (const e of entries) await walk(e);
  return out;
}
