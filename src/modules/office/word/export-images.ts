import "server-only";
import { blobs } from "@/lib/db";
import { safeFetch, type EgressPolicy } from "@/lib/net/safe-fetch";
import { imageDimensions, type ExportImage } from "./export";

/**
 * Image loader for the Word export (constitution §41 URL fetchers). Images in a document are referenced three ways:
 *
 * - `/api/blobs/<id>`: read from the blob store, only when the caller may read that blob (same check as the blob route);
 * - `data:` URLs: decoded in place, size-capped;
 * - `http(s)://` URLs: fetched through `safeFetch` — HTTP/S only, loopback/private/link-local/metadata addresses
 *   blocked, every redirect hop re-validated, body streamed against a byte limit, total timeout.
 *
 * Anything else (file:, ftp:, javascript:, relative paths) is ignored. A failure never fails the export: the image is
 * left out, as before. Only PNG / JPEG / GIF / BMP bytes (sniffed, not trusted from headers) are embedded.
 */

export const EXPORT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

export const EXPORT_IMAGE_POLICY: EgressPolicy = {
  name: "word-export-image",
  allowedSchemes: ["http:", "https:"],
  maxBytes: EXPORT_IMAGE_MAX_BYTES,
  timeoutMs: 8_000,
  maxRedirects: 3,
};

export interface ExportImageDeps {
  /** May the caller read this blob? Defaults to deny (a route passes the principal's policy check). */
  canReadBlob?: (id: string) => boolean;
  /** Test seams: transport and resolver for safeFetch (the resolver forces the DNS check even with a fake transport). */
  fetchImpl?: typeof fetch;
  resolver?: (hostname: string) => Promise<string[]>;
  signal?: AbortSignal;
}

/** Why an image was left out (for the export report / tests). */
export type ExportImageSkip = "unsupported_src" | "blob_denied" | "blob_missing" | "too_large" | "blocked" | "fetch_failed" | "not_an_image";

function sniff(bytes: Uint8Array | null): ExportImage | null {
  if (!bytes || !bytes.byteLength) return null;
  const dim = imageDimensions(bytes);
  if (!dim) return null;
  return { bytes, type: dim.type, width: dim.width || undefined, height: dim.height || undefined };
}

/** Resolve one image source to bytes, or `{ skip }` with the reason it was left out. */
export async function loadExportImage(src: string, deps: ExportImageDeps = {}): Promise<{ image: ExportImage } | { skip: ExportImageSkip; detail?: string }> {
  const s = typeof src === "string" ? src.trim() : "";
  const blob = /^\/api\/blobs\/([A-Za-z0-9_-]{1,128})(?:[?#].*)?$/.exec(s);
  if (blob) {
    const id = blob[1];
    if (!(deps.canReadBlob?.(id) ?? false)) return { skip: "blob_denied" };
    const b = blobs.get(id);
    if (!b) return { skip: "blob_missing" };
    if (b.bytes.byteLength > EXPORT_IMAGE_MAX_BYTES) return { skip: "too_large" };
    const image = sniff(new Uint8Array(b.bytes));
    return image ? { image } : { skip: "not_an_image" };
  }
  if (/^data:/i.test(s)) {
    const comma = s.indexOf(",");
    if (comma < 0) return { skip: "unsupported_src" };
    const head = s.slice(5, comma);
    const payload = s.slice(comma + 1);
    // Base64 carries 3 bytes per 4 characters; refuse before decoding anything oversized.
    if ((head.includes(";base64") ? Math.floor((payload.length * 3) / 4) : payload.length) > EXPORT_IMAGE_MAX_BYTES) return { skip: "too_large" };
    let bytes: Uint8Array;
    try { bytes = Uint8Array.from(Buffer.from(head.includes(";base64") ? payload : decodeURIComponent(payload), head.includes(";base64") ? "base64" : "utf8")); } catch { return { skip: "unsupported_src" }; }
    const image = sniff(bytes);
    return image ? { image } : { skip: "not_an_image" };
  }
  if (!/^https?:\/\//i.test(s)) return { skip: "unsupported_src" };
  try {
    const res = await safeFetch(s, { fetchImpl: deps.fetchImpl, signal: deps.signal, headers: { accept: "image/png,image/jpeg,image/gif,image/bmp;q=0.9,*/*;q=0.1" } }, { ...EXPORT_IMAGE_POLICY, ...(deps.resolver ? { resolver: deps.resolver } : {}) });
    if (!res.ok) return { skip: "fetch_failed", detail: `HTTP ${res.status}` };
    const image = sniff(res.body);
    return image ? { image } : { skip: "not_an_image" };
  } catch (e) {
    const code = (e as { code?: string })?.code;
    if (code === "body_too_large") return { skip: "too_large" };
    if (code && /^blocked_|insecure_tls|bad_redirect|invalid_url/.test(code)) return { skip: "blocked", detail: code };
    return { skip: "fetch_failed", detail: code ?? (e as Error)?.message };
  }
}

/** `fetchImage` for exportDocx: the image or null (skips are logged by the caller through `onSkip`). */
export function exportImageFetcher(deps: ExportImageDeps & { onSkip?: (src: string, reason: ExportImageSkip, detail?: string) => void } = {}) {
  return async (src: string): Promise<ExportImage | null> => {
    const r = await loadExportImage(src, deps);
    if ("image" in r) return r.image;
    deps.onSkip?.(src.slice(0, 120), r.skip, r.detail);
    return null;
  };
}
