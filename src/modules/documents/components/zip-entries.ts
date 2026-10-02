/**
 * ZIP archives in bulk upload: plan which entries of an archive become upload items, then unpack them in the browser
 * (jszip, loaded on demand). Every entry ends either as a File for the normal upload queue or as a skipped entry with a
 * reason; nothing is dropped silently.
 *
 * Guards: path traversal and absolute paths are refused, entries are capped at DOCS_LIMITS.maxFilesPerSet, the total
 * uncompressed size at ZIP_LIMITS.maxTotalBytes, and each entry is read through a bounded stream so a member that
 * inflates beyond what it declared (or beyond the per-type limit) is stopped instead of filling memory.
 *
 * The planning helpers are pure (tested in tests/documents-zip.test.ts); `unpackZip` needs jszip and works in the
 * browser and in Node.
 */
import { DOCS_ACCEPT, DOCS_LIMITS } from "../types";
import { extOf, formatBytes } from "./format";

export const ZIP_LIMITS = {
  /** Entries taken from one archive (also the most a set holds). */
  maxEntries: DOCS_LIMITS.maxFilesPerSet,
  /** Total uncompressed bytes taken from one archive. */
  maxTotalBytes: 2 * 1024 * 1024 * 1024,
  /** Archives larger than this are not opened (the whole archive is read into memory). */
  maxArchiveBytes: 2 * 1024 * 1024 * 1024,
} as const;

export const isZipName = (name: string) => extOf(name) === ".zip";

/** Raw entry as listed by the archive. `size` is the declared uncompressed size (untrusted); null when unknown. */
export interface ZipEntryInfo { path: string; dir: boolean; size: number | null }

export interface ZipSkip { name: string; reason: string; size?: number }

export interface ZipPlan {
  /** Entries to unpack: archive path and the display name (folder/sub/name.pdf). */
  take: { path: string; name: string; size: number | null }[];
  skipped: ZipSkip[];
  totalBytes: number;
}

const ACCEPT = new Set<string>(DOCS_ACCEPT);
const JUNK = /^(thumbs\.db|desktop\.ini|\.ds_store)$/i;

/**
 * Normalise an archive path to a safe relative display path ("folder/sub/name.pdf"), or null when the path is unsafe:
 * absolute (/x, C:\x, \\server), containing a ".." segment, a NUL or control character, or empty.
 */
export function safeZipPath(raw: string): string | null {
  if (typeof raw !== "string" || !raw) return null;
  if (/[\u0000-\u001f]/.test(raw)) return null;
  const p = raw.replace(/\\/g, "/");
  if (p.startsWith("/") || /^[a-zA-Z]:/.test(p)) return null;
  const parts = p.split("/").filter((s) => s !== "" && s !== ".");
  if (!parts.length || parts.some((s) => s === "..")) return null;
  return parts.join("/");
}

/** macOS resource forks, hidden files and OS junk: skipped without a row (they are never documents). */
export function isJunkEntry(path: string): boolean {
  const parts = path.split("/");
  return parts[0] === "__MACOSX" || parts.some((s) => s.startsWith(".")) || JUNK.test(parts[parts.length - 1] ?? "");
}

/** Per-file size limit, matching the upload precheck: PDFs are read in the browser, the rest go to the server. */
export function entryTooLarge(name: string, size: number): string | null {
  const ext = extOf(name);
  if (ext === ".pdf") return size > DOCS_LIMITS.maxPdfBytes ? `PDF is ${formatBytes(size)}; the limit is ${formatBytes(DOCS_LIMITS.maxPdfBytes)}.` : null;
  return size > DOCS_LIMITS.maxServerFileBytes ? `${ext.slice(1).toUpperCase()} files are limited to ${formatBytes(DOCS_LIMITS.maxServerFileBytes)} (this one is ${formatBytes(size)}).` : null;
}

export function entryLimit(name: string): number {
  return extOf(name) === ".pdf" ? DOCS_LIMITS.maxPdfBytes : DOCS_LIMITS.maxServerFileBytes;
}

/** Decide, before reading any bytes, which entries are unpacked and why the others are skipped. */
export function planZip(entries: ZipEntryInfo[], limits: { maxEntries?: number; maxTotalBytes?: number } = {}): ZipPlan {
  const maxEntries = limits.maxEntries ?? ZIP_LIMITS.maxEntries;
  const maxTotal = limits.maxTotalBytes ?? ZIP_LIMITS.maxTotalBytes;
  const take: ZipPlan["take"] = [];
  const skipped: ZipSkip[] = [];
  const seen = new Set<string>();
  let total = 0;
  let overCount = 0;
  let overBytes = 0;
  for (const e of entries) {
    if (e.dir) continue;
    const name = safeZipPath(e.path);
    if (!name) { skipped.push({ name: e.path || "(unnamed entry)", reason: "Unsafe path in the archive (absolute or outside the archive); not unpacked." }); continue; }
    if (isJunkEntry(name)) continue;
    if (seen.has(name)) { skipped.push({ name, reason: "Appears twice in the archive; the first copy was used." }); continue; }
    seen.add(name);
    const size = e.size != null && Number.isFinite(e.size) && e.size >= 0 ? e.size : null;
    const ext = extOf(name);
    if (ext === ".zip") { skipped.push({ name, size: size ?? undefined, reason: "Archives inside an archive are not unpacked. Upload it separately." }); continue; }
    if (!ACCEPT.has(ext)) { skipped.push({ name, size: size ?? undefined, reason: `File type ${ext || "(none)"} is not supported.` }); continue; }
    if (size === 0) { skipped.push({ name, size, reason: "The file is empty." }); continue; }
    const big = size != null ? entryTooLarge(name, size) : null;
    if (big) { skipped.push({ name, size: size ?? undefined, reason: big }); continue; }
    if (take.length >= maxEntries) { overCount++; continue; }
    if (total + (size ?? 0) > maxTotal) { overBytes++; continue; }
    total += size ?? 0;
    take.push({ path: e.path, name, size });
  }
  if (overCount) skipped.push({ name: `${overCount.toLocaleString("en-IN")} more file${overCount === 1 ? "" : "s"}`, reason: `An archive is unpacked up to ${maxEntries.toLocaleString("en-IN")} files; the rest were not unpacked.` });
  if (overBytes) skipped.push({ name: `${overBytes.toLocaleString("en-IN")} more file${overBytes === 1 ? "" : "s"}`, reason: `An archive is unpacked up to ${formatBytes(maxTotal)} in total; the rest were not unpacked.` });
  return { take, skipped, totalBytes: total };
}

export const baseName = (path: string) => path.split("/").pop() || path;

// ---- unpacking ------------------------------------------------------------------------------------------------------

export class ZipOpenError extends Error {
  constructor(message: string) { super(message); this.name = "ZipOpenError"; }
}

interface JsZipObject {
  name: string;
  dir: boolean;
  date: Date;
  _data?: { uncompressedSize?: number };
  internalStream: (type: "uint8array") => {
    on: (ev: "data" | "error" | "end", cb: (...a: never[]) => void) => unknown;
    resume: () => unknown;
    pause: () => unknown;
  };
}

/** Read one entry, refusing to inflate past `max` bytes (zip-bomb guard: the declared size is not trusted). */
function readBounded(entry: JsZipObject, max: number, signal?: AbortSignal): Promise<Uint8Array[]> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    let done = false;
    const stream = entry.internalStream("uint8array");
    const stop = (err: Error) => { if (done) return; done = true; stream.pause(); reject(err); };
    const onAbort = () => stop(Object.assign(new Error("Cancelled"), { name: "AbortError" }));
    signal?.addEventListener("abort", onAbort, { once: true });
    stream.on("data", ((chunk: Uint8Array) => {
      if (done) return;
      total += chunk.length;
      if (total > max) { stop(new Error(`Inflates past ${formatBytes(max)}; not unpacked.`)); return; }
      chunks.push(chunk);
    }) as (...a: never[]) => void);
    stream.on("error", ((e: Error) => stop(e instanceof Error ? e : new Error(String(e)))) as (...a: never[]) => void);
    stream.on("end", (() => { if (done) return; done = true; signal?.removeEventListener("abort", onAbort); resolve(chunks); }) as (...a: never[]) => void);
    stream.resume();
  });
}

export interface UnpackResult { files: File[]; skipped: ZipSkip[] }

/**
 * Unpack the supported entries of a ZIP archive into Files whose `webkitRelativePath` is the display path inside the
 * archive. Entries are read one at a time. Throws ZipOpenError when the archive cannot be opened.
 */
export async function unpackZip(zip: Blob & { name?: string }, opts: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void; limits?: { maxEntries?: number; maxTotalBytes?: number } } = {}): Promise<UnpackResult> {
  if (zip.size > ZIP_LIMITS.maxArchiveBytes) throw new ZipOpenError(`The archive is ${formatBytes(zip.size)}; archives up to ${formatBytes(ZIP_LIMITS.maxArchiveBytes)} are unpacked.`);
  const { default: JSZip } = await import("jszip");
  let archive: { files: Record<string, JsZipObject> };
  try {
    archive = (await JSZip.loadAsync(await zip.arrayBuffer())) as unknown as { files: Record<string, JsZipObject> };
  } catch {
    throw new ZipOpenError("This ZIP archive could not be opened (damaged, encrypted or not a ZIP file).");
  }
  const byPath = new Map(Object.values(archive.files).map((f) => [f.name, f]));
  const plan = planZip([...byPath.values()].map((f) => ({ path: f.name, dir: f.dir, size: typeof f._data?.uncompressedSize === "number" ? f._data.uncompressedSize : null })), opts.limits);
  const files: File[] = [];
  const skipped = [...plan.skipped];
  const maxTotal = opts.limits?.maxTotalBytes ?? ZIP_LIMITS.maxTotalBytes;
  let total = 0;
  opts.onProgress?.(0, plan.take.length);
  for (const [i, t] of plan.take.entries()) {
    if (opts.signal?.aborted) throw Object.assign(new Error("Cancelled"), { name: "AbortError" });
    const entry = byPath.get(t.path)!;
    // Bound by the per-type limit, the declared size (a member that inflates past it is lying) and what remains of the total.
    const max = Math.min(entryLimit(t.name), t.size ?? Infinity, maxTotal - total);
    try {
      const chunks = await readBounded(entry, max, opts.signal);
      const size = chunks.reduce((n, c) => n + c.length, 0);
      total += size;
      if (size === 0) { skipped.push({ name: t.name, size: 0, reason: "The file is empty." }); continue; }
      const file = new File(chunks as BlobPart[], baseName(t.name), { lastModified: entry.date instanceof Date && !Number.isNaN(entry.date.getTime()) ? entry.date.getTime() : Date.now() });
      if (t.name !== file.name) { try { Object.defineProperty(file, "webkitRelativePath", { value: t.name }); } catch { /* read-only in some engines */ } }
      files.push(file);
    } catch (e) {
      if ((e as { name?: string })?.name === "AbortError") throw e;
      skipped.push({ name: t.name, size: t.size ?? undefined, reason: e instanceof Error && /Inflates past/.test(e.message) ? e.message : "This entry could not be read from the archive." });
    }
    opts.onProgress?.(i + 1, plan.take.length);
  }
  return { files, skipped };
}
