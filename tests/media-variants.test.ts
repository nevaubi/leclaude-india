import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { mediaVariant } from "@/modules/media/variants";
import type { MediaRecord } from "@/modules/media/store";
describe("authenticated image variants", () => {
  it("serves smaller WebP bytes at thumbnail size and reuses a bounded cached result", async () => {
    const bytes = await sharp({ create: { width: 1600, height: 900, channels: 3, background: { r: 90, g: 110, b: 140 } } }).png().toBuffer();
    const image: MediaRecord = { id: "b".repeat(64), mime: "image/png", bytes, size: bytes.length, width:1600, height:900, sourceUrl:"https://court.test/photo", pageUrl:null,publisher:"Court",licenseNote:null,fetchedAt:null,vision:null };
    const [a,b] = await Promise.all([mediaVariant(image,128),mediaVariant(image,128)]);
    expect(a).toBe(b);
    expect(a.mime).toBe("image/webp");
    expect(a.bytes.byteLength).toBeLessThan(bytes.length);
    expect((await sharp(a.bytes).metadata()).width).toBe(128);
    expect(await mediaVariant(image,128)).toBe(a);
    console.log("IMAGE_BYTES",{original:bytes.length,thumbnail:a.bytes.byteLength});
  });
  it("keeps animation bytes intact", async () => {
    const image = {id:"c".repeat(64),mime:"image/gif",bytes:new Uint8Array([71,73,70]),size:3} as MediaRecord;
    const out = await mediaVariant(image,64);
    expect(out.mime).toBe("image/gif"); expect(out.bytes).toBe(image.bytes);
  });
});
