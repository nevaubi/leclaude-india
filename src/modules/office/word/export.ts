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
  const images = new Map<string, ExportImage | null>();
  await Promise.all(collectImageSrcs(doc).map(async (src) => { try { images.set(src, opts.fetchImage ? await opts.fetchImage(src) : null); } catch { images.set(src, null); } }));
  const author = opts.author ?? "Author";
  const changes = opts.changes ?? "revisions";
  const comments = commentInputs(opts);
  if (opts.basePackage?.byteLength) {
    try {
      const r = await exportPreserving(doc, opts.basePackage, { settings, author, changes, comments, images, imageSrc: (_b, _m, _n, sha) => docxImageSrc(sha), customProps: opts.customProps });
      opts.onReport?.({ mode: "preserve", changedParts: r.changedParts, preservedBlocks: r.preservedBlocks, regeneratedBlocks: r.regeneratedBlocks, warnings: r.warnings });
      return r.bytes;
    } catch (e) {
      // A package the reader cannot re-open (corrupt, encrypted) falls back to a fresh package: content is kept, original parts are not.
      opts.onReport?.({ mode: "fresh", warnings: [`Package-preserving export failed (${(e as Error).message}); wrote a fresh package.`] });
    }
  }
  const buf = await exportFresh(doc, { title: opts.title, settings, author, changes, comments, images, customProps: opts.customProps });
  opts.onReport?.({ mode: "fresh", warnings: [] });
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
