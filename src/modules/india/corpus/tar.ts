import "server-only";
import { gunzipSync } from "node:zlib";

/**
 * Minimal, dependency-free reader for the metadata archives of the Indian judgment open-data sets (POSIX ustar with
 * optional GNU long names and PAX headers; optionally gzip-compressed). Only regular files are returned. The reader
 * validates header checksums so a truncated or corrupt archive fails loudly instead of yielding partial records.
 */

export interface TarEntry {
  name: string;
  data: Uint8Array;
}

export class TarError extends Error {}

const BLOCK = 512;
const dec = new TextDecoder("utf-8");

function field(buf: Uint8Array, off: number, len: number): string {
  const slice = buf.subarray(off, off + len);
  const nul = slice.indexOf(0);
  return dec.decode(nul >= 0 ? slice.subarray(0, nul) : slice);
}

function octal(buf: Uint8Array, off: number, len: number): number {
  // GNU base-256 encoding for large sizes: high bit of the first byte set.
  if (buf[off] & 0x80) {
    let n = 0;
    for (let i = off + 1; i < off + len; i++) n = n * 256 + buf[i];
    return n;
  }
  const s = field(buf, off, len).trim();
  return s ? parseInt(s, 8) : 0;
}

function checksumOk(h: Uint8Array): boolean {
  const stored = octal(h, 148, 8);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
  return sum === stored;
}

function isZeroBlock(h: Uint8Array): boolean {
  for (let i = 0; i < BLOCK; i++) if (h[i] !== 0) return false;
  return true;
}

function parsePax(data: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  const text = dec.decode(data);
  let i = 0;
  while (i < text.length) {
    const sp = text.indexOf(" ", i);
    if (sp < 0) break;
    const len = Number(text.slice(i, sp));
    if (!Number.isFinite(len) || len <= 0) break;
    const rec = text.slice(sp + 1, i + len - 1);
    const eq = rec.indexOf("=");
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

export function isGzip(bytes: Uint8Array): boolean {
  return bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/** Read every regular file in a (gzipped) tar archive. */
export function readTar(input: Uint8Array): TarEntry[] {
  const buf = isGzip(input) ? new Uint8Array(gunzipSync(input)) : input;
  const out: TarEntry[] = [];
  let off = 0;
  let longName: string | undefined;
  let pax: Record<string, string> | undefined;
  let ended = false;
  while (off + BLOCK <= buf.length) {
    const h = buf.subarray(off, off + BLOCK);
    if (isZeroBlock(h)) { ended = true; break; }
    if (!checksumOk(h)) throw new TarError(`Corrupt tar header at byte ${off}`);
    const size = octal(h, 124, 12);
    const type = String.fromCharCode(h[156] || 48);
    const dataStart = off + BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > buf.length) throw new TarError(`Truncated tar entry at byte ${off} (needs ${size} bytes)`);
    const data = buf.subarray(dataStart, dataEnd);
    off = dataStart + Math.ceil(size / BLOCK) * BLOCK;
    if (type === "L") { longName = field(data, 0, data.length); continue; }
    if (type === "x") { pax = parsePax(data); continue; }
    if (type === "g") continue;
    if (type !== "0" && type !== "\0" && type !== "7") { longName = undefined; pax = undefined; continue; }
    const prefix = field(h, 345, 155);
    const base = field(h, 0, 100);
    const name = pax?.path ?? longName ?? (prefix ? `${prefix}/${base}` : base);
    longName = undefined;
    pax = undefined;
    out.push({ name, data: new Uint8Array(data) });
  }
  // A complete archive ends with a zero block; without it the archive was cut off between entries.
  if (!ended) throw new TarError(`Truncated tar archive: no end-of-archive marker after ${out.length} entries`);
  return out;
}
