import { describe, expect, it } from "vitest";
import type { RemoteStore, Row, SqlQuery } from "@/lib/db/remote";
import { isSafeFetchError } from "@/lib/net/safe-fetch";
import { getMedia, storeImageFromUrl } from "@/modules/media/store";
import { MAX_SOURCE_BYTES } from "@/modules/media/resize";
import { isMediaId, MAX_IMAGE_BYTES, MediaValidationError, sniffImage, validateImage } from "@/modules/media/validate";

class FakeStore implements RemoteStore {
  calls: SqlQuery[] = [];
  constructor(private readonly reply: (q: SqlQuery) => Row[] = () => []) {}
  async query(q: SqlQuery): Promise<Row[]> { this.calls.push(q); return this.reply(q); }
  async transaction(qs: SqlQuery[]): Promise<Row[][]> { return Promise.all(qs.map((q) => this.query(q))); }
}

function png(w: number, h: number, pad = 100): Uint8Array {
  const b = new Uint8Array(33 + pad);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
}

function jpeg(w: number, h: number): Uint8Array {
  const b = new Uint8Array(200);
  b.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
  // APP0 length 16 → next marker at 2 + 2 + 16 = 20
  b.set([0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255], 20);
  return b;
}

function gif(w: number, h: number): Uint8Array {
  const b = new Uint8Array(100);
  b.set([...new TextEncoder().encode("GIF89a"), w & 255, w >> 8, h & 255, h >> 8]);
  return b;
}

function webpVp8x(w: number, h: number): Uint8Array {
  const b = new Uint8Array(100);
  b.set(new TextEncoder().encode("RIFF"), 0);
  b.set(new TextEncoder().encode("WEBPVP8X"), 8);
  const W = w - 1, H = h - 1;
  b.set([W & 255, (W >> 8) & 255, (W >> 16) & 255, H & 255, (H >> 8) & 255, (H >> 16) & 255], 24);
  return b;
}

describe("magic-byte validation", () => {
  it("identifies PNG, JPEG, GIF and WebP and reads their size", () => {
    expect(sniffImage(png(320, 400))).toEqual({ mime: "image/png", width: 320, height: 400 });
    expect(sniffImage(jpeg(640, 800))).toEqual({ mime: "image/jpeg", width: 640, height: 800 });
    expect(sniffImage(gif(16, 9))).toEqual({ mime: "image/gif", width: 16, height: 9 });
    expect(sniffImage(webpVp8x(300, 200))).toEqual({ mime: "image/webp", width: 300, height: 200 });
  });

  it("refuses SVG, HTML and other bytes even when labelled as images", () => {
    const svg = new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script>${" ".repeat(100)}</svg>`);
    expect(() => validateImage(svg, "image/svg+xml")).toThrow(MediaValidationError);
    const html = new TextEncoder().encode(`<!doctype html><html>${" ".repeat(100)}</html>`);
    expect(() => validateImage(html, "image/png")).toThrowError(/not a PNG, JPEG, GIF or WebP/);
  });

  it("refuses a declared type that disagrees with the bytes, and a non-image declared type", () => {
    expect(() => validateImage(png(10, 10), "image/jpeg")).toThrowError(/Declared image\/jpeg but the bytes are image\/png/);
    expect(() => validateImage(png(10, 10), "text/html")).toThrowError(/not an image/);
    expect(validateImage(jpeg(10, 10), "image/jpg").mime).toBe("image/jpeg");
    expect(validateImage(png(10, 10), "application/octet-stream").mime).toBe("image/png");
  });

  it("enforces the size limit and refuses implausible dimensions", () => {
    expect(() => validateImage(png(10, 10, MAX_IMAGE_BYTES), "image/png")).toThrow(/limit/);
    expect(() => validateImage(png(0, 10), "image/png")).toThrow(/Implausible/);
    expect(() => validateImage(new Uint8Array(10), null)).toThrow(/only 10 bytes/);
  });

  it("accepts only SHA-256 ids", () => {
    expect(isMediaId("a".repeat(64))).toBe(true);
    expect(isMediaId("../etc/passwd")).toBe(false);
    expect(isMediaId("A".repeat(64))).toBe(false);
  });
});

describe("SSRF-safe image fetch", () => {
  const store = new FakeStore(() => [{ inserted: "t" }]);
  const never = (async () => { throw new Error("must not be called"); }) as unknown as typeof fetch;

  it("refuses non-HTTP schemes, internal names and private or metadata addresses before any request", async () => {
    for (const url of ["file:///etc/passwd", "ftp://example.com/a.png", "http://localhost/a.png", "http://169.254.169.254/latest/meta-data/", "http://10.0.0.5/a.png", "http://[::1]/a.png", "http://user:pw@example.com/a.png"]) {
      const err = await storeImageFromUrl(url, {}, { store, fetchImpl: never }).catch((e) => e);
      expect(isSafeFetchError(err), url).toBe(true);
    }
  });

  it("re-validates every redirect hop", async () => {
    const redirecting = (async () => new Response(null, { status: 302, headers: { location: "http://192.168.1.10/photo.png" } })) as unknown as typeof fetch;
    const err = await storeImageFromUrl("https://judges.example.gov.in/p.png", {}, { store, fetchImpl: redirecting }).catch((e) => e);
    expect(isSafeFetchError(err) && err.code).toBe("blocked_address");
  });

  it("aborts a body above the source download limit", async () => {
    const big = (async () => new Response(new Uint8Array(10), { status: 200, headers: { "content-type": "image/png", "content-length": String(MAX_SOURCE_BYTES + 1) } })) as unknown as typeof fetch;
    const err = await storeImageFromUrl("https://judges.example.gov.in/p.png", {}, { store, fetchImpl: big }).catch((e) => e);
    expect(isSafeFetchError(err) && err.code).toBe("body_too_large");
  });

  it("refuses an HTML error page served with 200", async () => {
    const html = (async () => new Response(`<html>${" ".repeat(200)}</html>`, { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
    await expect(storeImageFromUrl("https://judges.example.gov.in/p.png", {}, { store, fetchImpl: html })).rejects.toThrow(MediaValidationError);
  });

  it("stores a valid image by content hash with its source and attribution", async () => {
    const s = new FakeStore((q) => (q.query.startsWith("INSERT INTO media_assets") ? [{ inserted: "t" }] : []));
    const ok = (async () => new Response(png(300, 375) as unknown as BodyInit, { status: 200, headers: { "content-type": "image/png" } })) as unknown as typeof fetch;
    const m = await storeImageFromUrl("https://judges.example.gov.in/p.png", { pageUrl: "https://judges.example.gov.in/roster", publisher: "High Court X", licenseNote: "attribution" }, { store: s, fetchImpl: ok });
    expect(isMediaId(m.id)).toBe(true);
    expect(m).toMatchObject({ url: `/api/media/${m.id}`, mime: "image/png", width: 300, height: 375, existed: false });
    expect(m.dataUrl.startsWith("data:image/png;base64,")).toBe(true);
    const insert = s.calls.find((c) => c.query.startsWith("INSERT INTO media_assets"))!;
    expect(insert.params?.[0]).toBe(m.id);
    expect(insert.params?.[6]).toBe("https://judges.example.gov.in/p.png");
    expect(insert.params?.[8]).toBe("High Court X");
    expect(s.calls.some((c) => /CREATE TABLE IF NOT EXISTS media_assets/.test(c.query))).toBe(true);
  });

  it("reads bytes back from bytea and never queries for an invalid id", async () => {
    const id = "b".repeat(64);
    const s = new FakeStore((q) => (q.query.startsWith("SELECT id, mime") ? [{ id, mime: "image/png", bytes: "\\x89504e47", size: "4", width: "1", height: "1", source_url: "https://x.gov.in/a.png", page_url: null, publisher: null, license_note: null, fetched_at: null, vision: '{"ok":true,"kind":"portrait","reason":"r","alt":null}' }] : []));
    const m = await getMedia(id, { store: s });
    expect(Array.from(m!.bytes)).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(m!.vision?.ok).toBe(true);
    const before = s.calls.length;
    expect(await getMedia("not-an-id", { store: s })).toBeNull();
    expect(s.calls.length).toBe(before);
  });
});
