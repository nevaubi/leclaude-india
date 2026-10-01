import "server-only";
import { MAX_IMAGE_BYTES, MediaValidationError, validateImage, type ImageMime } from "./validate";

/**
 * Official sites often publish full-resolution originals (Bombay High Court portraits are 1-7 MB). Those are
 * downloaded up to MAX_SOURCE_BYTES, validated by their magic bytes like any other image, and re-encoded to a
 * bounded size before they reach the media store. Images already under the store limit are kept byte-for-byte.
 */

export const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
export const MAX_EDGE_PX = 1200;

type SharpFactory = (input: Uint8Array, options?: { limitInputPixels?: number; failOn?: "none" | "truncated" | "error" | "warning" }) => {
  rotate(): ReturnType<SharpFactory>;
  resize(options: { width: number; height: number; fit: "inside"; withoutEnlargement: boolean }): ReturnType<SharpFactory>;
  webp(options: { quality: number }): ReturnType<SharpFactory>;
  toBuffer(): Promise<Buffer>;
};

let sharpLoader: Promise<SharpFactory | null> | null = null;

async function loadSharp(): Promise<SharpFactory | null> {
  sharpLoader ??= import("sharp")
    .then((m) => ((m as { default?: unknown }).default ?? m) as unknown as SharpFactory)
    .catch(() => null);
  return sharpLoader;
}

export interface FittedImage {
  bytes: Uint8Array;
  declaredType: string | null;
  resized: boolean;
}

/**
 * Return bytes the media store accepts: unchanged when already within MAX_IMAGE_BYTES, otherwise validated as an
 * image (up to MAX_SOURCE_BYTES) and re-encoded as WebP with the long edge at most MAX_EDGE_PX. Throws
 * MediaValidationError when the source is not an image, is too large even as a source, or cannot be reduced.
 */
export async function fitImageForStore(bytes: Uint8Array, declaredType: string | null, deps: { sharp?: SharpFactory | null } = {}): Promise<FittedImage> {
  if (bytes.byteLength <= MAX_IMAGE_BYTES) return { bytes, declaredType, resized: false };
  validateImage(bytes, declaredType, MAX_SOURCE_BYTES);
  const sharp = deps.sharp === undefined ? await loadSharp() : deps.sharp;
  if (!sharp) throw new MediaValidationError("too_large", `Image is ${bytes.byteLength} bytes, above the ${MAX_IMAGE_BYTES}-byte limit, and no image resizer is available`);
  let out: Buffer;
  try {
    out = await sharp(bytes, { limitInputPixels: 60_000_000, failOn: "error" })
      .rotate()
      .resize({ width: MAX_EDGE_PX, height: MAX_EDGE_PX, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer();
  } catch (e) {
    throw new MediaValidationError("not_image", `The image could not be decoded for resizing: ${(e as Error).message.slice(0, 200)}`);
  }
  const resized = new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
  if (resized.byteLength > MAX_IMAGE_BYTES) throw new MediaValidationError("too_large", `Image is still ${resized.byteLength} bytes after resizing`);
  const mime: ImageMime = "image/webp";
  return { bytes: resized, declaredType: mime, resized: true };
}
