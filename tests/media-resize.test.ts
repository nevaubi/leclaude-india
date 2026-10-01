import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { fitImageForStore, MAX_EDGE_PX } from "@/modules/media/resize";
import { MAX_IMAGE_BYTES, MediaValidationError, sniffImage } from "@/modules/media/validate";

/** A noisy RGB JPEG large enough to exceed the store limit (noise defeats compression). */
async function bigJpeg(width: number, height: number): Promise<Uint8Array> {
  const raw = Buffer.alloc(width * height * 3);
  let s = 12345;
  for (let i = 0; i < raw.length; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; raw[i] = s & 0xff; }
  const out = await sharp(raw, { raw: { width, height, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
  return new Uint8Array(out);
}

describe("media resize before store", () => {
  it("keeps images under the store limit byte-for-byte", async () => {
    const small = new Uint8Array([0xff, 0xd8, 0xff, ...new Array(100).fill(0)]);
    const r = await fitImageForStore(small, "image/jpeg", { sharp: null });
    expect(r.resized).toBe(false);
    expect(r.bytes).toBe(small);
  });

  it("downsizes an oversized portrait to a bounded WebP", async () => {
    const big = await bigJpeg(2400, 3000);
    expect(big.byteLength).toBeGreaterThan(MAX_IMAGE_BYTES);
    const r = await fitImageForStore(big, "image/jpeg");
    expect(r.resized).toBe(true);
    expect(r.declaredType).toBe("image/webp");
    expect(r.bytes.byteLength).toBeLessThanOrEqual(MAX_IMAGE_BYTES);
    const s = sniffImage(r.bytes);
    expect(s?.mime).toBe("image/webp");
    expect(Math.max(s?.width ?? 0, s?.height ?? 0)).toBeLessThanOrEqual(MAX_EDGE_PX);
  }, 30_000);

  it("refuses oversized bytes that are not an image, or when no resizer is available", async () => {
    const junk = new Uint8Array(MAX_IMAGE_BYTES + 10).fill(7);
    await expect(fitImageForStore(junk, "image/jpeg")).rejects.toBeInstanceOf(MediaValidationError);
    const big = await bigJpeg(2400, 3000);
    await expect(fitImageForStore(big, "image/jpeg", { sharp: null })).rejects.toThrow(/no image resizer/);
  }, 30_000);
});
