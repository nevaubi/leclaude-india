/**
 * DOCX export. Two paths behind one API:
 *  - documents imported from .docx (`basePackage` given): package-preserving export — the original package is
 *    kept, untouched blocks are re-emitted byte-for-byte and only document.xml plus the parts that need new
 *    content are rewritten (see ooxml/roundtrip.ts);
 *  - documents created in the app: a complete OOXML package written directly (ooxml/fresh.ts) with the app's
 *    styles, multi-level numbering, settings, fonts, footer PAGE field, footnotes/endnotes, comments and media.
 * Tracked changes export as real w:ins/w:del (author/date); comments as Word comments anchored to their ranges.
 */
import type { OfficeComment } from "@/lib/types/domain";
import { DEFAULT_SETTINGS, type DocSettings } from "./constants";
import { docToMarkdown, docToPlainText, type PMNode } from "./doc-model";
import type { CustomProp } from "./ooxml/custom-props";
import { exportFresh, type CommentInput } from "./ooxml/fresh";
import { docxImageSrc } from "./ooxml/images";
import { exportPreserving } from "./ooxml/roundtrip";
import type { DocxImportedComment } from "./ooxml/types";
import { collectImageSrcs, type ExportImageData } from "./ooxml/writer";

export type ExportImage = ExportImageData;

/**
 * Images fetched for one export: at most `maxImages`, `concurrency` at a time, `maxTotalBytes` in all (each image is
 * also capped by the fetcher). Images past a limit are left out of the file and named in the export report.
 */
export const EXPORT_IMAGE_LIMITS = { maxImages: 200, concurrency: 4, maxTotalBytes: 64 * 1024 * 1024 } as const;

/** Load the document's images within EXPORT_IMAGE_LIMITS; returns them by src plus warnings for what was left out. */
export async function loadExportImages(srcs: string[], fetchImage: ExportOptions["fetchImage"]): Promise<{ images: Map<string, ExportImage | null>; warnings: string[] }> {
  const images = new Map<string, ExportImage | null>();
  const warnings: string[] = [];
  const wanted = srcs.slice(0, EXPORT_IMAGE_LIMITS.maxImages);
  for (const src of srcs.slice(EXPORT_IMAGE_LIMITS.maxImages)) images.set(src, null);
  if (srcs.length > wanted.length) warnings.push(`${srcs.length - wanted.length} image${srcs.length - wanted.length === 1 ? "" : "s"} beyond the first ${EXPORT_IMAGE_LIMITS.maxImages} left out.`);
  if (!fetchImage) { for (const src of wanted) images.set(src, null); return { images, warnings }; }
  let total = 0;
  let overBudget = 0;
  let next = 0;
  const worker = async () => {
    while (next < wanted.length) {
      const src = wanted[next++];
      if (total >= EXPORT_IMAGE_LIMITS.maxTotalBytes) { images.set(src, null); overBudget++; continue; }
      let img: ExportImage | null = null;
      try { img = await fetchImage(src); } catch { img = null; }
      if (img && total + img.bytes.byteLength > EXPORT_IMAGE_LIMITS.maxTotalBytes) { images.set(src, null); overBudget++; continue; }
      if (img) total += img.bytes.byteLength;
      images.set(src, img);
    }
  };
  await Promise.all(Array.from({ length: Math.min(EXPORT_IMAGE_LIMITS.concurrency, wanted.length) }, worker));
  if (overBudget) warnings.push(`${overBudget} image${overBudget === 1 ? "" : "s"} left out: images are limited to ${EXPORT_IMAGE_LIMITS.maxTotalBytes / 1024 / 1024} MB per export.`);
  return { images, warnings };
}

export interface ExportOptions {
  title: string;
  settings?: Partial<DocSettings>;
  comments?: OfficeComment[];
  fetchImage?: (src: string) => Promise<ExportImage | null>;
  author?: string;
  /** "revisions" keeps tracked changes as Word revisions (default); "accepted" exports the clean text. */
  changes?: "revisions" | "accepted";
  /** Original bytes of the imported .docx: enables the package-preserving export. */
  basePackage?: Uint8Array | null;
  /** Comments that came with the imported .docx (officeDoc.meta.docx.comments, with their current state). */
  importedComments?: DocxImportedComment[];
  /** Custom file properties written to docProps/custom.xml (export provenance; LeClaude.* names are replaced). */
  customProps?: CustomProp[];
  /** Receives export diagnostics (preserved/regenerated block counts, rewritten parts). */
  onReport?: (r: { mode: "fresh" | "preserve"; changedParts?: string[]; preservedBlocks?: number; regeneratedBlocks?: number; warnings: string[] }) => void;
}

function commentInputs(opts: ExportOptions): CommentInput[] {
  const out: CommentInput[] = [];
  for (const c of opts.importedComments ?? []) out.push({ key: c.id, author: c.author, date: c.date ?? new Date().toISOString(), text: c.text, initials: c.initials, resolved: c.resolved, sourceId: c.sourceId, anchor: c.anchor });
  for (const c of opts.comments ?? []) out.push({ key: c.id, author: c.authorName, date: c.createdAt, text: `${c.body}${c.replies?.length ? "\n" + c.replies.map((r) => `${r.authorName}: ${r.body}`).join("\n") : ""}`, resolved: c.resolved, anchor: c.anchor });
  return out;
}

/** Build a .docx buffer from a document. */
export async function exportDocx(doc: PMNode, opts: ExportOptions): Promise<Buffer> {
  const settings: DocSettings = { ...DEFAULT_SETTINGS, ...(opts.settings ?? {}) };
  const { images, warnings: imageWarnings } = await loadExportImages(collectImageSrcs(doc), opts.fetchImage);
  const author = opts.author ?? "Author";
  const changes = opts.changes ?? "revisions";
  const comments = commentInputs(opts);
  if (opts.basePackage?.byteLength) {
    try {
      const r = await exportPreserving(doc, opts.basePackage, { settings, author, changes, comments, images, imageSrc: (_b, _m, _n, sha) => docxImageSrc(sha), customProps: opts.customProps });
      opts.onReport?.({ mode: "preserve", changedParts: r.changedParts, preservedBlocks: r.preservedBlocks, regeneratedBlocks: r.regeneratedBlocks, warnings: [...imageWarnings, ...r.warnings] });
      return r.bytes;
    } catch (e) {
      // A package the reader cannot re-open (corrupt, encrypted) falls back to a fresh package: content is kept, original parts are not.
      imageWarnings.push(`Package-preserving export failed (${(e as Error).message}); wrote a fresh package.`);
    }
  }
  const buf = await exportFresh(doc, { title: opts.title, settings, author, changes, comments, images, customProps: opts.customProps });
  opts.onReport?.({ mode: "fresh", warnings: imageWarnings });
  return buf;
}

export function exportMarkdown(doc: PMNode, title: string) { return docToMarkdown(doc, { title }); }
export function exportText(doc: PMNode) { return docToPlainText(doc); }

/** Parse PNG/JPEG/GIF dimensions from bytes (enough for aspect ratio). */
export function imageDimensions(bytes: Uint8Array): { type: ExportImage["type"]; width: number; height: number } | null {
  if (bytes.length > 24 && bytes[0] === 0x89 && bytes[1] === 0x50) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { type: "png", width: dv.getUint32(16), height: dv.getUint32(20) };
  }
  if (bytes.length > 10 && bytes[0] === 0x47 && bytes[1] === 0x49) return { type: "gif", width: bytes[6] | (bytes[7] << 8), height: bytes[8] | (bytes[9] << 8) };
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) { i++; continue; }
      const marker = bytes[i + 1];
      const len = (bytes[i + 2] << 8) | bytes[i + 3];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { type: "jpg", width: (bytes[i + 7] << 8) | bytes[i + 8], height: (bytes[i + 5] << 8) | bytes[i + 6] };
      i += 2 + len;
    }
    return { type: "jpg", width: 0, height: 0 };
  }
  if (bytes.length > 26 && bytes[0] === 0x42 && bytes[1] === 0x4d) { const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); return { type: "bmp", width: dv.getInt32(18, true), height: Math.abs(dv.getInt32(22, true)) }; }
  return null;
}
