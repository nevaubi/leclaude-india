/**
 * Image validation for the media store (pure; no I/O). The bytes decide what a file is: the declared content type is
 * only checked against the sniffed one. Accepted formats are raster images a browser renders without script: PNG,
 * JPEG, GIF and WebP. SVG is refused (it can carry script and is not needed for court emblems or photographs).
 */

export const MAX_IMAGE_BYTES = 1_572_864; // 1.5 MB
export const MIN_IMAGE_BYTES = 64;

export type ImageMime = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export interface SniffedImage {
  mime: ImageMime;
  width: number | null;
  height: number | null;
}

export class MediaValidationError extends Error {
  constructor(readonly code: "too_large" | "too_small" | "not_image" | "type_mismatch" | "bad_dimensions", message: string) {
    super(message);
    this.name = "MediaValidationError";
  }
}

const u16be = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1];
const u16le = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u24le = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
const u32be = (b: Uint8Array, o: number) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
const ascii = (b: Uint8Array, o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));

function jpegSize(b: Uint8Array): { width: number; height: number } | null {
  let o = 2;
  while (o + 9 < b.length) {
    if (b[o] !== 0xff) { o++; continue; }
    const marker = b[o + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { o += 2; continue; }
    if (marker === 0xff) { o++; continue; }
    const len = u16be(b, o + 2);
    if (len < 2) return null;
    // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC) carry the frame size.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: u16be(b, o + 5), width: u16be(b, o + 7) };
    }
    o += 2 + len;
  }
  return null;
}

function webpSize(b: Uint8Array): { width: number; height: number } | null {
  const chunk = ascii(b, 12, 4);
  if (chunk === "VP8X" && b.length >= 30) return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
  if (chunk === "VP8L" && b.length >= 25 && b[20] === 0x2f) {
    const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8 " && b.length >= 30 && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
    return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  }
  return null;
}

/** Identify an image by its magic bytes and read its pixel size where the header carries it. Null for anything else. */
export function sniffImage(b: Uint8Array): SniffedImage | null {
  if (b.length >= 24 && b[0] === 0x89 && ascii(b, 1, 3) === "PNG" && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) {
    return { mime: "image/png", width: u32be(b, 16), height: u32be(b, 20) };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    const s = jpegSize(b);
    return { mime: "image/jpeg", width: s?.width ?? null, height: s?.height ?? null };
  }
  if (b.length >= 10 && (ascii(b, 0, 6) === "GIF87a" || ascii(b, 0, 6) === "GIF89a")) {
    return { mime: "image/gif", width: u16le(b, 6), height: u16le(b, 8) };
  }
  if (b.length >= 16 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") {
    const s = webpSize(b);
    return { mime: "image/webp", width: s?.width ?? null, height: s?.height ?? null };
  }
  return null;
}

/**
 * Validate downloaded bytes as an image we may store and serve. `declaredType` (the response Content-Type) must be
 * image/* when present; a declared type that disagrees with the sniffed format is refused (no polyglots).
 */
export function validateImage(bytes: Uint8Array, declaredType?: string | null, maxBytes = MAX_IMAGE_BYTES): SniffedImage {
  if (bytes.byteLength > maxBytes) throw new MediaValidationError("too_large", `Image is ${bytes.byteLength} bytes, above the ${maxBytes}-byte limit`);
  if (bytes.byteLength < MIN_IMAGE_BYTES) throw new MediaValidationError("too_small", `Image is only ${bytes.byteLength} bytes`);
  const sniffed = sniffImage(bytes);
  if (!sniffed) throw new MediaValidationError("not_image", "The bytes are not a PNG, JPEG, GIF or WebP image");
  const declared = (declaredType ?? "").split(";")[0].trim().toLowerCase();
  if (declared && declared !== "application/octet-stream" && declared !== "binary/octet-stream") {
    if (!declared.startsWith("image/")) throw new MediaValidationError("type_mismatch", `Declared content type ${declared} is not an image`);
    const norm = declared === "image/jpg" || declared === "image/pjpeg" ? "image/jpeg" : declared;
    if (norm !== sniffed.mime) throw new MediaValidationError("type_mismatch", `Declared ${declared} but the bytes are ${sniffed.mime}`);
  }
  if (sniffed.width !== null && sniffed.height !== null && (sniffed.width < 1 || sniffed.height < 1 || sniffed.width > 20_000 || sniffed.height > 20_000)) {
    throw new MediaValidationError("bad_dimensions", `Implausible image size ${sniffed.width}x${sniffed.height}`);
  }
  return sniffed;
}

/** Media ids are the lowercase hex SHA-256 of the bytes. */
export function isMediaId(id: string | null | undefined): id is string {
  return typeof id === "string" && /^[0-9a-f]{64}$/.test(id);
}

export function mediaUrl(id: string): string {
  return `/api/media/${id}`;
}
