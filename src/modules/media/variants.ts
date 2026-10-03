import "server-only";
import type { MediaRecord } from "./store";
export interface MediaVariant { bytes: Uint8Array; mime: string; }
const MAX_BYTES = 24 * 1024 * 1024;
const cache = new Map<string, MediaVariant>();
const inflight = new Map<string, Promise<MediaVariant>>();
let cachedBytes = 0;
let active = 0;
const waiting: Array<() => void> = [];
async function limited<T>(work: () => Promise<T>): Promise<T> {
  if (active >= 2) await new Promise<void>(resolve => waiting.push(resolve)); else active++;
  try { return await work(); } finally { const next = waiting.shift(); if (next) next(); else active--; }
}
/** Bytes only, after the route authorizes each request. Originals and attribution stay intact. */
export async function mediaVariant(media: MediaRecord, width: number): Promise<MediaVariant> {
  const key = media.id + ":webp-v1:" + width;
  const hit = cache.get(key);
  if (hit) { cache.delete(key); cache.set(key, hit); return hit; }
  const pending = inflight.get(key);
  if (pending) return pending;
  const task = limited(async () => {
    const original = { bytes: media.bytes, mime: media.mime };
    let result = original;
    if (media.mime !== "image/gif") {
      try {
        const { default: sharp } = await import("sharp");
        const bytes = await sharp(media.bytes, { limitInputPixels: 60_000_000, failOn: "error" }).rotate().resize({ width, withoutEnlargement: true }).webp({ quality: 78 }).toBuffer();
        if (bytes.byteLength < media.bytes.byteLength) result = { bytes, mime: "image/webp" };
      } catch { return original; }
    }
    if (result.bytes.byteLength <= MAX_BYTES) {
      while (cache.size && (cachedBytes + result.bytes.byteLength > MAX_BYTES || cache.size >= 128)) {
        const oldest = cache.keys().next().value!; cachedBytes -= cache.get(oldest)!.bytes.byteLength; cache.delete(oldest);
      }
      cache.set(key, result); cachedBytes += result.bytes.byteLength;
    }
    return result;
  });
  inflight.set(key, task);
  try { return await task; } finally { inflight.delete(key); }
}
