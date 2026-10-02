import { describe, expect, it } from "vitest";
import { parseCommonsResponse } from "@/modules/media/commons";

describe("Commons thumbnails", () => {
  it("accepts thumbnails served from thumb.wikimedia.org (current API response shape)", () => {
    const body = { query: { pages: [{ title: "File:Supreme Court of India - 200705.jpg", index: 1, imageinfo: [{
      width: 2048, height: 1536, mime: "image/jpeg",
      url: "https://upload.wikimedia.org/wikipedia/commons/5/51/Supreme_Court_of_India_-_200705.jpg",
      thumburl: "https://thumb.wikimedia.org/wikipedia/commons/thumb/5/51/Supreme_Court_of_India_-_200705.jpg/1280px-Supreme_Court_of_India_-_200705.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail",
      descriptionurl: "https://commons.wikimedia.org/wiki/File:Supreme_Court_of_India_-_200705.jpg",
      extmetadata: { LicenseShortName: { value: "CC BY-SA 3.0" }, Artist: { value: "Legaleagle86" } },
    }] }] } };
    const out = parseCommonsResponse(body, { q: "Supreme Court of India building", label: "Supreme Court of India", require: ["supreme court of india"] });
    expect(out).toHaveLength(1);
    expect(out[0].imageUrl).toMatch(/^https:\/\/thumb\.wikimedia\.org\//);
    expect(out[0].licence.ok).toBe(true);
  });

  it("still rejects images hosted anywhere else", () => {
    const body = { query: { pages: [{ title: "File:X.jpg", index: 1, imageinfo: [{ width: 2000, height: 1200, mime: "image/jpeg", thumburl: "https://example.com/x.jpg", descriptionurl: "https://commons.wikimedia.org/wiki/File:X.jpg", extmetadata: { LicenseShortName: { value: "CC0" } } }] }] } };
    expect(parseCommonsResponse(body, { q: "x", label: "x", require: [] })).toHaveLength(0);
  });
});
