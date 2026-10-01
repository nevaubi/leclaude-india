import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.LECLAUDE_DATA_DIR = `${process.env.TMPDIR || "/tmp"}/legal-news-images-vitest-${process.pid}`;
  process.env.LECLAUDE_SEED = "reference";
  process.env.LECLAUDE_BACKGROUND = "off";
  process.env.WORKFLOW_SCHEDULER_DISABLED = "1";
  process.env.INTEL_OFFLINE = "1";
  delete process.env.AUTH_MODE;
  delete process.env.LEGAL_NEWS_FIXTURE_DIR;
});

import { readFileSync } from "node:fs";
import path from "node:path";
import { db, resetSqlite } from "@/lib/db";
import { AIConfigError } from "@/lib/ai/config";
import { parseFeed } from "@/modules/news/parse";
import { normalizeItem } from "@/modules/news/normalize";
import { newsSourceById } from "@/modules/news/sources";
import {
  MAX_REVIEW_ATTEMPTS, displayImageFor, extractMetaImages, htmlImageCandidates, imageDimensions, imageUrlLooksGeneric,
  parseImageVerdict, passesImageHeuristic, publisherMonogram, ImageVerdictError,
} from "@/modules/news/images";
import { COLLECTION, listLegalNews, mergeArticles, resetLegalNews } from "@/modules/news/service";
import { lookupNewsImages, newsImageStats, reviewNewsImages, runNewsImageJobs, type ImageFetcher, type PageFetcher } from "@/modules/news/image-jobs";
import { pickFeatured } from "@/modules/news/featured";
import type { NewsArticle, NewsListItem } from "@/modules/news/types";

const FIXTURES = path.resolve(__dirname, "fixtures/legal-news");
const fixture = (id: string) => readFileSync(path.join(FIXTURES, `${id}.xml`), "utf8");
const NOW = new Date("2026-10-01T06:00:00Z");
const clock = (d: Date) => () => new Date(d);
const col = () => db().collection<NewsArticle>(COLLECTION);

beforeAll(() => { resetSqlite(); db(); });

const rss = (items: string) => `<?xml version="1.0"?><rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>T</title><link>https://lawtrend.in</link><image><url>https://lawtrend.in/logo.png</url></image>${items}</channel></rss>`;

// ---------------------------------------------------------------------------
// Feed image extraction
// ---------------------------------------------------------------------------

describe("feed image candidates (fixtures)", () => {
  it("LiveLaw: image enclosure", () => {
    const f = parseFeed(fixture("livelaw"));
    expect(f.items[0].imageUrl).toBe("https://www.livelaw.in/h-upload/2026/09/30/bombay-hc.jpg");
    expect(f.items[0].imageCandidates[0]).toMatchObject({ origin: "enclosure", type: "image/jpeg" });
  });
  it("Bar & Bench: media:content and media:thumbnail", () => {
    const f = parseFeed(fixture("barandbench"));
    expect(f.items[0].imageCandidates[0]).toMatchObject({ url: "https://media.barandbench.com/haldiram.jpg", origin: "media:content" });
    expect(f.items[1].imageCandidates[0]).toMatchObject({ url: "https://media.barandbench.com/khaitan.jpg", origin: "media:thumbnail" });
    expect(f.items[1].imageUrl).toBe("https://media.barandbench.com/khaitan.jpg");
  });
  it("LawBeat: media:content under a Drupal /sites/default/files path is not treated as a default image", () => {
    const f = parseFeed(fixture("lawbeat"));
    expect(f.items[0].imageUrl).toBe("https://www.lawbeat.in/sites/default/files/ponds.jpg");
    expect(imageUrlLooksGeneric(f.items[0].imageUrl!)).toBe(false);
  });
  it("LawTrend, SCC Times, Verdictum fixtures name no image; the channel <image> logo is never attributed to an item", () => {
    for (const id of ["lawtrend", "scc-times", "verdictum"]) {
      for (const it of parseFeed(fixture(id)).items) {
        expect(it.imageUrl).toBeNull();
        expect(it.imageCandidates).toEqual([]);
      }
    }
  });
  it("normalizeItem stores the source, dimensions and candidates", () => {
    const xml = rss(`<item><title>A</title><link>https://lawtrend.in/a/</link><media:content url="https://lawtrend.in/wp-content/uploads/a.jpg" medium="image" width="1200" height="675"/></item>`);
    const a = normalizeItem(parseFeed(xml).items[0], newsSourceById("lawtrend")!, NOW)!;
    expect(a).toMatchObject({ imageUrl: "https://lawtrend.in/wp-content/uploads/a.jpg", imageSource: "feed", imageWidth: 1200, imageHeight: 675 });
    expect(a.imageCandidates).toHaveLength(1);
  });
});

describe("feed image candidates (inline styles)", () => {
  it("WordPress content:encoded <img>: lazy data-src / srcset preferred, emoji, trackers and 1x1 pixels skipped", () => {
    const xml = rss(`<item><title>A</title><link>https://lawtrend.in/a/</link>
      <content:encoded><![CDATA[<p><img src="https://s.w.org/images/core/emoji/15/72x72/1f600.png"> <img width="1" height="1" src="https://lawtrend.in/pixel.jpg">
      <img src="https://lawtrend.in/wp-content/uploads/lazy-placeholder.jpg" data-src="https://lawtrend.in/wp-content/uploads/2026/10/court.jpg" width="800" height="450"></p>]]></content:encoded></item>`);
    const it0 = parseFeed(xml).items[0];
    expect(it0.imageCandidates).toEqual([{ url: "https://lawtrend.in/wp-content/uploads/2026/10/court.jpg", origin: "content-img", width: 800, height: 450 }]);
    expect(it0.imageUrl).toBe("https://lawtrend.in/wp-content/uploads/2026/10/court.jpg");
  });
  it("srcset: the widest entry wins", () => {
    expect(htmlImageCandidates(`<img src="a-300.jpg" srcset="https://x.in/a-300.jpg 300w, https://x.in/a-1024.jpg 1024w">`, "content-img")[0].url).toBe("https://x.in/a-1024.jpg");
  });
  it("media:group: the widest image media:content first; video media is ignored", () => {
    const xml = rss(`<item><title>A</title><link>https://lawtrend.in/a/</link><media:group>
      <media:content url="https://cdn.x.in/v.mp4" medium="video" type="video/mp4"/>
      <media:content url="https://cdn.x.in/small.jpg" medium="image" width="320" height="180"/>
      <media:content url="https://cdn.x.in/large.jpg" medium="image" width="1280" height="720"/></media:group></item>`);
    const it0 = parseFeed(xml).items[0];
    expect(it0.imageCandidates.map((c) => c.url)).toEqual(["https://cdn.x.in/large.jpg", "https://cdn.x.in/small.jpg"]);
    expect(it0.imageUrl).toBe("https://cdn.x.in/large.jpg");
  });
  it("escaped <img> in description is found; data: URIs refused", () => {
    const xml = rss(`<item><title>A</title><link>https://lawtrend.in/a/</link><description>&lt;img src="data:image/png;base64,AAAA"&gt;&lt;img src="/wp-content/uploads/rel.jpg"&gt;</description></item>`);
    const it0 = parseFeed(xml).items[0];
    expect(it0.imageCandidates).toEqual([{ url: "https://lawtrend.in/wp-content/uploads/rel.jpg", origin: "description-img" }]);
    const a = normalizeItem(it0, newsSourceById("lawtrend")!, NOW)!;
    expect(a.imageUrl).toBe("https://lawtrend.in/wp-content/uploads/rel.jpg");
  });
  it("a feed that only names its logo keeps it as a candidate but it is never displayed", () => {
    const xml = rss(`<item><title>A</title><link>https://lawtrend.in/a/</link><media:content url="https://lawtrend.in/wp-content/uploads/site-logo.png" medium="image"/></item>`);
    const it0 = parseFeed(xml).items[0];
    expect(it0.imageUrl).toBe("https://lawtrend.in/wp-content/uploads/site-logo.png");
    expect(displayImageFor({ imageUrl: it0.imageUrl })).toBeNull();
  });
  it("Atom entries: enclosure link", () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title>T</title><entry><title>A</title><link rel="alternate" href="https://x.in/a"/><link rel="enclosure" type="image/jpeg" href="https://x.in/a.jpg"/><id>1</id></entry></feed>`;
    expect(parseFeed(xml).items[0]).toMatchObject({ imageUrl: "https://x.in/a.jpg" });
  });
});

// ---------------------------------------------------------------------------
// og:image
// ---------------------------------------------------------------------------

describe("extractMetaImages", () => {
  it("og:image with secure_url, width, height and type (SCC Online shape)", () => {
    const html = `<html><head><meta property="og:image" content="http://blog-images.scconline.com/x/stipend.jpg" />
      <meta property="og:image:secure_url" content="https://blog-images.scconline.com/x/stipend.jpg">
      <meta property="og:image:width" content="886" /><meta property="og:image:height" content="590" /><meta property="og:image:type" content="image/jpeg" />
      <meta name="twitter:image" content="https://blog-images.scconline.com/x/tw.jpg"></head><body><meta property="og:image" content="https://evil/after-head.jpg"></body></html>`;
    expect(extractMetaImages(html, "https://www.scconline.com/blog/post/x/")).toEqual([
      { url: "https://blog-images.scconline.com/x/stipend.jpg", origin: "og:image", width: 886, height: 590, type: "image/jpeg" },
      { url: "https://blog-images.scconline.com/x/tw.jpg", origin: "twitter:image" },
    ]);
  });
  it("attribute order, single quotes, entities and relative URLs", () => {
    const html = `<head><meta content='/uploads/a.jpg?w=1200&amp;h=630' property='og:image'><link rel="image_src" href="https://x.in/b.jpg"></head>`;
    expect(extractMetaImages(html, "https://x.in/news/1")).toEqual([
      { url: "https://x.in/uploads/a.jpg?w=1200&h=630", origin: "og:image" },
      { url: "https://x.in/b.jpg", origin: "image_src" },
    ]);
  });
  it("no meta images, javascript: and data: URLs → nothing", () => {
    expect(extractMetaImages(`<head><meta property="og:image" content="javascript:alert(1)"><meta property="og:image" content="data:image/png;base64,AA"></head>`, "https://x.in")).toEqual([]);
    expect(extractMetaImages("<html></html>")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Heuristics, verdicts, dimensions, display policy
// ---------------------------------------------------------------------------

describe("heuristics", () => {
  it("flags logos, icons, placeholders, svg/gif/ico and tiny size suffixes", () => {
    for (const u of ["https://x.in/logo.png", "https://x.in/img/site-logo-dark.jpg", "https://x.in/favicon.ico", "https://x.in/a/placeholder.jpg", "https://x.in/default.jpg", "https://x.in/i/a.svg", "https://x.in/i/a.gif", "https://x.in/wp/cropped-icon-32x32.jpg", "https://x.in/logos/a.jpg", "https://x.in/uploads/no-image.png"]) {
      expect(imageUrlLooksGeneric(u), u).toBe(true);
    }
    for (const u of ["https://www.lawbeat.in/sites/default/files/ponds.jpg", "https://x.in/uploads/2026/10/supreme-court-1200x675.jpg", "https://www.livelaw.in/h-upload/2026/09/30/sc.jpg"]) {
      expect(imageUrlLooksGeneric(u), u).toBe(false);
    }
  });
  it("min side, aspect ratio and repeats", () => {
    expect(passesImageHeuristic({ url: "https://x.in/a.jpg", width: 1200, height: 675 })).toBe(true);
    expect(passesImageHeuristic({ url: "https://x.in/a.jpg", width: 150, height: 100 })).toBe(false);
    expect(passesImageHeuristic({ url: "https://x.in/a.jpg", width: 1500, height: 300 })).toBe(false);
    expect(passesImageHeuristic({ url: "https://x.in/a.jpg", width: 120 })).toBe(false);
    expect(passesImageHeuristic({ url: "https://x.in/a.jpg" }, 3)).toBe(false);
    expect(passesImageHeuristic({ url: "ftp://x.in/a.jpg" })).toBe(false);
  });
  it("publisher monograms", () => {
    expect(publisherMonogram("Bar & Bench")).toBe("BB");
    expect(publisherMonogram("LiveLaw")).toBe("LL");
    expect(publisherMonogram("SCC Times (SCC Online Blog)")).toBe("ST");
    expect(publisherMonogram("Verdictum")).toBe("VE");
  });
});

describe("parseImageVerdict", () => {
  it("accepts a strict object and a fenced one", () => {
    expect(parseImageVerdict(`{"ok":true,"reason":"news photo","kind":"photo","alt":"The Supreme Court building"}`)).toEqual({ ok: true, reason: "news photo", kind: "photo", alt: "The Supreme Court building" });
    expect(parseImageVerdict("```json\n{\"ok\":false,\"reason\":\"logo\",\"kind\":\"logo\",\"alt\":\"\"}\n```").ok).toBe(false);
  });
  it("rejects prose, arrays, missing or mistyped fields and unknown kinds", () => {
    const bad = [
      `Sure! {"ok":true,"reason":"x","kind":"photo","alt":"y"}`,
      `[{"ok":true}]`,
      `{"ok":"true","reason":"x","kind":"photo","alt":"y"}`,
      `{"ok":true,"kind":"photo","alt":"y"}`,
      `{"ok":true,"reason":"x","kind":"selfie","alt":"y"}`,
      `{"ok":true,"reason":"x","kind":"photo"}`,
      `{"ok":true,"reason":"x","kind":"photo","alt":"   "}`,
      `{not json}`,
      ``,
    ];
    for (const t of bad) expect(() => parseImageVerdict(t), t).toThrow(ImageVerdictError);
  });
  it("never accepts a logo, placeholder or text banner even if the model says ok", () => {
    for (const kind of ["logo", "placeholder", "text-banner"]) expect(parseImageVerdict(`{"ok":true,"reason":"x","kind":"${kind}","alt":"a"}`).ok).toBe(false);
  });
  it("sanitises alt text (control chars and angle brackets) and caps length", () => {
    const v = parseImageVerdict(JSON.stringify({ ok: true, reason: "r", kind: "photo", alt: `<b>Court</b>\u0007 ${"x".repeat(300)}` }));
    expect(v.alt).not.toMatch(/[<>\u0007]/);
    expect(v.alt.length).toBeLessThanOrEqual(160);
  });
});

function png(w: number, h: number): Uint8Array {
  const b = new Uint8Array(64);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  b.set([(w >>> 24) & 255, (w >>> 16) & 255, (w >>> 8) & 255, w & 255, (h >>> 24) & 255, (h >>> 16) & 255, (h >>> 8) & 255, h & 255], 16);
  return b;
}
function jpeg(w: number, h: number): Uint8Array {
  // SOI, APP0 (16 bytes), SOF0
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
}

describe("imageDimensions", () => {
  it("reads PNG, JPEG, GIF and WebP (VP8X) headers", () => {
    expect(imageDimensions(png(1200, 675))).toEqual({ width: 1200, height: 675, format: "png" });
    expect(imageDimensions(jpeg(886, 590))).toEqual({ width: 886, height: 590, format: "jpeg" });
    expect(imageDimensions(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x10, 0x00, 0x20, 0x00]))).toEqual({ width: 16, height: 32, format: "gif" });
    const webp = new Uint8Array(30);
    webp.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58]);
    webp.set([(799) & 255, (799 >> 8) & 255, 0, (449) & 255, (449 >> 8) & 255, 0], 24);
    expect(imageDimensions(webp)).toEqual({ width: 800, height: 450, format: "webp" });
    expect(imageDimensions(new TextEncoder().encode("<html>not an image</html>"))).toBeNull();
  });
});

describe("displayImageFor", () => {
  const base = { imageUrl: "https://x.in/a.jpg", imageSource: "feed" as const, imageWidth: 1200, imageHeight: 675 };
  it("unchecked image that passes the heuristic is shown as heuristic", () => {
    expect(displayImageFor(base)).toMatchObject({ url: base.imageUrl, status: "heuristic", alt: "" });
  });
  it("vision ok → verified with alt; vision or probe rejection → hidden", () => {
    const review = { url: base.imageUrl, ok: true, kind: "photo" as const, reason: "", alt: "Court hall", checkedAt: NOW.toISOString(), by: "vision" as const };
    expect(displayImageFor({ ...base, imageReview: review })).toMatchObject({ status: "verified", alt: "Court hall" });
    expect(displayImageFor({ ...base, imageReview: { ...review, ok: false, kind: "logo" } })).toBeNull();
    expect(displayImageFor({ ...base, imageReview: { ...review, ok: false, by: "probe" } })).toBeNull();
  });
  it("a verdict for another URL is ignored; repeated publisher defaults are hidden", () => {
    const review = { url: "https://x.in/old.jpg", ok: false, kind: "logo" as const, reason: "", alt: "", checkedAt: NOW.toISOString(), by: "vision" as const };
    expect(displayImageFor({ ...base, imageReview: review })?.status).toBe("heuristic");
    expect(displayImageFor(base, 5)).toBeNull();
    expect(displayImageFor({ ...base, imageUrl: null })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

let seq = 0;
function article(over: Partial<NewsArticle> = {}): NewsArticle {
  const i = ++seq;
  const iso = new Date(NOW.getTime() - i * 60_000).toISOString();
  return {
    id: `ln_img${i}`, url: `https://lawtrend.in/story-${i}/`, sourceId: "lawtrend", publisher: "LawTrend", title: `Story ${i}`, summary: "", authors: [], categories: [], tags: [],
    publishedAt: iso, publishedRaw: null, firstSeenAt: iso, lastSeenAt: iso, imageUrl: null, guid: null, labels: [], courtIds: [], syndicatedBy: [], ...over,
  };
}
const htmlWithOg = (url: string) => `<html><head><meta property="og:image" content="${url}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"></head></html>`;
const okVerdict = JSON.stringify({ ok: true, reason: "photo of a court", kind: "photo", alt: "A court building" });
const imageOk: ImageFetcher = async () => ({ status: 200, bytes: jpeg(1200, 675), contentType: "image/jpeg" });

describe("lookupNewsImages", () => {
  beforeEach(() => { resetLegalNews(); seq = 0; });

  it("fills a missing image from og:image, only on the publisher's host, once", async () => {
    const a = article();
    const foreign = article({ url: "https://evil.example/story/" });
    col().putMany([a, foreign]);
    const calls: string[] = [];
    const pageFetcher: PageFetcher = async (url) => { calls.push(url); return { status: 200, html: htmlWithOg("https://lawtrend.in/wp-content/uploads/2026/10/og.jpg"), finalUrl: url, contentType: "text/html" }; };
    const r = await lookupNewsImages({ now: clock(NOW), pageFetcher, firecrawl: null });
    expect(r).toMatchObject({ examined: 1, found: 1 });
    expect(calls).toEqual([a.url]);
    expect(col().get(a.id)).toMatchObject({ imageUrl: "https://lawtrend.in/wp-content/uploads/2026/10/og.jpg", imageSource: "og", imageWidth: 1200, imageHeight: 630, imageLookup: { status: "found", attempts: 1, via: "og" } });
    expect(col().get(foreign.id)!.imageUrl).toBeNull();
    const again = await lookupNewsImages({ now: clock(NOW), pageFetcher, firecrawl: null });
    expect(again.examined).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it("replaces a repeated feed default, never with the same URL; falls back to Firecrawl within its cap", async () => {
    const dflt = "https://lawtrend.in/wp-content/uploads/share.jpg";
    const items = [article({ imageUrl: dflt, imageSource: "feed" }), article({ imageUrl: dflt, imageSource: "feed" }), article({ imageUrl: dflt, imageSource: "feed" }), article({ imageUrl: dflt, imageSource: "feed" })];
    col().putMany(items);
    const pageFetcher: PageFetcher = async (url) => ({ status: 200, html: htmlWithOg(dflt), finalUrl: url, contentType: "text/html" });
    const fc = { configured: true, calls: 0, async imageFor(url: string) { this.calls++; return `${url}firecrawl.jpg`; } };
    const r = await lookupNewsImages({ now: clock(NOW), pageFetcher, firecrawl: fc, maxFirecrawl: 2 });
    expect(r).toMatchObject({ examined: 4, found: 2, none: 2, firecrawlCalls: 2 });
    expect(fc.calls).toBe(2);
    const got = items.map((i) => col().get(i.id)!);
    expect(got.filter((g) => g.imageSource === "firecrawl")).toHaveLength(2);
    expect(got.filter((g) => g.imageLookup?.status === "none").every((g) => g.imageUrl === dflt)).toBe(true);
  });

  it("errors count as attempts with a 1 h retry and stop after MAX_LOOKUP_ATTEMPTS", async () => {
    const a = article();
    col().put(a);
    let calls = 0;
    const pageFetcher: PageFetcher = async () => { calls++; throw new Error("ECONNRESET"); };
    await lookupNewsImages({ now: clock(NOW), pageFetcher, firecrawl: null });
    expect(col().get(a.id)!.imageLookup).toMatchObject({ status: "failed", attempts: 1 });
    await lookupNewsImages({ now: clock(new Date(NOW.getTime() + 10 * 60_000)), pageFetcher, firecrawl: null });
    expect(calls).toBe(1);
    await lookupNewsImages({ now: clock(new Date(NOW.getTime() + 61 * 60_000)), pageFetcher, firecrawl: null });
    expect(calls).toBe(2);
    await lookupNewsImages({ now: clock(new Date(NOW.getTime() + 300 * 60_000)), pageFetcher, firecrawl: null });
    expect(calls).toBe(2);
    expect(col().get(a.id)!.imageLookup).toMatchObject({ status: "failed", attempts: 2 });
  });

  it("does nothing offline without an injected fetcher", async () => {
    col().put(article());
    expect(await lookupNewsImages({ now: clock(NOW) })).toMatchObject({ examined: 0 });
  });
});

describe("reviewNewsImages", () => {
  beforeEach(() => { resetLegalNews(); seq = 0; });

  it("caps model calls per run and sends the probed bytes as a data URL", async () => {
    col().putMany(Array.from({ length: 12 }, (_, i) => article({ imageUrl: `https://lawtrend.in/wp-content/uploads/p${i}.jpg`, imageSource: "feed" })));
    const describe = vi.fn(async (...args: [string, string]) => ({ text: args.length ? okVerdict : "" }));
    const r = await reviewNewsImages({ now: clock(NOW), imageFetcher: imageOk, describe, maxReviews: 3 });
    expect(describe).toHaveBeenCalledTimes(3);
    expect(r).toMatchObject({ accepted: 3, modelCalls: 3 });
    expect(describe.mock.calls[0][0]).toMatch(/^data:image\/jpeg;base64,/);
    const listed = listLegalNews({}, NOW).items.filter((i) => i.image?.status === "verified");
    expect(listed).toHaveLength(3);
    expect(listed[0].image).toMatchObject({ alt: "A court building", width: 1200, height: 675 });
  });

  it("rejected verdicts hide the image; one call per shared URL", async () => {
    const url = "https://lawtrend.in/wp-content/uploads/shared.jpg";
    const [a, b] = [article({ imageUrl: url, imageSource: "feed" }), article({ imageUrl: url, imageSource: "feed" })];
    col().putMany([a, b]);
    const describe = vi.fn(async () => ({ text: JSON.stringify({ ok: false, reason: "site logo", kind: "logo", alt: "" }) }));
    await reviewNewsImages({ now: clock(NOW), imageFetcher: imageOk, describe });
    expect(describe).toHaveBeenCalledTimes(1);
    for (const id of [a.id, b.id]) expect(col().get(id)!.imageReview).toMatchObject({ ok: false, kind: "logo", by: "vision", url });
    expect(listLegalNews({}, NOW).items.every((i) => i.image === null)).toBe(true);
  });

  it("probe rejects tiny, non-image and 404 responses without a model call", async () => {
    const tiny = article({ imageUrl: "https://lawtrend.in/u/tiny.jpg", imageSource: "feed" });
    const html = article({ imageUrl: "https://lawtrend.in/u/html.jpg", imageSource: "feed" });
    const gone = article({ imageUrl: "https://lawtrend.in/u/gone.jpg", imageSource: "feed" });
    col().putMany([tiny, html, gone]);
    const imageFetcher: ImageFetcher = async (url) => {
      if (url.endsWith("tiny.jpg")) return { status: 200, bytes: png(120, 90), contentType: "image/png" };
      if (url.endsWith("html.jpg")) return { status: 200, bytes: new TextEncoder().encode("<html>"), contentType: "text/html" };
      return { status: 404, bytes: new Uint8Array(0), contentType: "text/html" };
    };
    const describe = vi.fn(async () => ({ text: okVerdict }));
    const r = await reviewNewsImages({ now: clock(NOW), imageFetcher, describe });
    expect(describe).not.toHaveBeenCalled();
    expect(r.probeRejected).toBe(3);
    expect(col().get(tiny.id)!.imageReview).toMatchObject({ ok: false, by: "probe", width: 120, height: 90 });
  });

  it("malformed verdicts and model errors count attempts with backoff and stop at MAX_REVIEW_ATTEMPTS (no retry storm)", async () => {
    const a = article({ imageUrl: "https://lawtrend.in/u/a.jpg", imageSource: "feed", publishedAt: NOW.toISOString() });
    col().put(a);
    const describe = vi.fn(async () => ({ text: "I think this is a nice photo." }));
    let t = NOW.getTime();
    for (let run = 0; run < 12; run++) {
      await reviewNewsImages({ now: clock(new Date(t)), imageFetcher: imageOk, describe });
      t += 10 * 60_000; // every 10 minutes for 2 hours
    }
    t += 24 * 3600_000;
    await reviewNewsImages({ now: clock(new Date(Math.min(t, NOW.getTime() + 6 * 86_400_000))), imageFetcher: imageOk, describe });
    expect(describe).toHaveBeenCalledTimes(MAX_REVIEW_ATTEMPTS);
    expect(col().get(a.id)!.imageAttempts).toMatchObject({ count: MAX_REVIEW_ATTEMPTS, url: a.imageUrl });
    expect(col().get(a.id)!.imageAttempts!.lastError).toMatch(/vision/);
    // Unreviewable images fall back to the heuristic display.
    expect(listLegalNews({}, NOW).items[0].image?.status).toBe("heuristic");
  });

  it("a missing model configuration stops the pass without charging attempts", async () => {
    col().putMany([article({ imageUrl: "https://lawtrend.in/u/1.jpg", imageSource: "feed" }), article({ imageUrl: "https://lawtrend.in/u/2.jpg", imageSource: "feed" })]);
    const describe = vi.fn(async () => { throw new AIConfigError(); });
    const r = await reviewNewsImages({ now: clock(NOW), imageFetcher: imageOk, describe, concurrency: 1 });
    expect(r.stopped).toBe("ai_not_configured");
    expect(describe).toHaveBeenCalledTimes(1);
    expect(col().all().every((x) => !x.imageAttempts && !x.imageReview)).toBe(true);
  });

  it("a verdict is void once the image URL changes (re-listing with a new feed image)", async () => {
    const src = newsSourceById("lawtrend")!;
    const xml = (img: string) => rss(`<item><title>A</title><link>https://lawtrend.in/a/</link><pubDate>Thu, 01 Oct 2026 05:00:00 +0000</pubDate><media:content url="${img}" medium="image"/></item>`);
    mergeArticles([normalizeItem(parseFeed(xml("https://lawtrend.in/u/first.jpg")).items[0], src, NOW)!], NOW);
    await reviewNewsImages({ now: clock(NOW), imageFetcher: imageOk, describe: async () => ({ text: okVerdict }) });
    expect(listLegalNews({}, NOW).items[0].image?.status).toBe("verified");
    mergeArticles([normalizeItem(parseFeed(xml("https://lawtrend.in/u/second.jpg")).items[0], src, NOW)!], NOW);
    const item = listLegalNews({}, NOW).items[0];
    expect(item.imageUrl).toBe("https://lawtrend.in/u/second.jpg");
    expect(item.image?.status).toBe("heuristic");
  });

  it("re-listing keeps an og image found for a rejected feed image", () => {
    const src = newsSourceById("lawtrend")!;
    const xml = rss(`<item><title>A</title><link>https://lawtrend.in/a/</link><pubDate>Thu, 01 Oct 2026 05:00:00 +0000</pubDate><media:content url="https://lawtrend.in/u/feed.jpg" medium="image"/></item>`);
    const a = normalizeItem(parseFeed(xml).items[0], src, NOW)!;
    mergeArticles([a], NOW);
    col().put({ ...col().get(a.id)!, imageUrl: "https://lawtrend.in/u/og.jpg", imageSource: "og" });
    mergeArticles([normalizeItem(parseFeed(xml).items[0], src, NOW)!], NOW);
    expect(col().get(a.id)).toMatchObject({ imageUrl: "https://lawtrend.in/u/og.jpg", imageSource: "og" });
  });
});

describe("runNewsImageJobs", () => {
  beforeEach(() => { resetLegalNews(); seq = 0; });
  it("runs lookups then reviews within one budget, shares a concurrent pass and reports stats", async () => {
    col().putMany([article(), article({ imageUrl: "https://lawtrend.in/u/feed.jpg", imageSource: "feed" })]);
    const pageFetcher: PageFetcher = async (url) => ({ status: 200, html: htmlWithOg("https://lawtrend.in/u/og.jpg"), finalUrl: url, contentType: "text/html" });
    const describe = vi.fn(async () => ({ text: okVerdict }));
    const opts = { now: clock(NOW), pageFetcher, imageFetcher: imageOk, describe, firecrawl: null, deadlineMs: 5_000 };
    const [r1, r2] = await Promise.all([runNewsImageJobs(opts), runNewsImageJobs(opts)]);
    expect(r1).toBe(r2);
    expect(r1.lookups.found).toBe(1);
    expect(r1.reviews.accepted).toBe(2);
    expect(describe).toHaveBeenCalledTimes(2);
    expect(newsImageStats()).toMatchObject({ total: 2, verified: 2, reviewed: 2 });
  });
  it("respects the deadline: a hung image fetch does not hold the pass", async () => {
    col().put(article({ imageUrl: "https://lawtrend.in/u/slow.jpg", imageSource: "feed" }));
    const imageFetcher: ImageFetcher = (_url, signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
    const t0 = Date.now();
    const r = await runNewsImageJobs({ now: clock(NOW), pageFetcher: async () => { throw new Error("x"); }, imageFetcher, describe: async () => ({ text: okVerdict }), firecrawl: null, deadlineMs: 1_000 });
    expect(Date.now() - t0).toBeLessThan(3_000);
    expect(r.reviews.stopped).toBe("deadline");
    expect(col().all()[0].imageAttempts ?? null).toBeNull();
  });
});

describe("front-page arrangement", () => {
  const item = (i: number, img: boolean): NewsListItem => ({ ...article(), id: `f${i}`, image: img ? { url: `https://x.in/${i}.jpg`, alt: "", width: null, height: null, source: "feed", status: "heuristic" } : null });
  it("leads with the newest of the first six that has an image; no featuring for short lists or searches", () => {
    const items = [item(0, false), item(1, false), item(2, true), ...Array.from({ length: 12 }, (_, i) => item(i + 3, true))];
    const f = pickFeatured(items, true);
    expect(f.lead?.id).toBe("f2");
    expect(f.side.map((x) => x.id)).toEqual(["f0", "f1", "f3"]);
    expect(f.grid).toHaveLength(4);
    expect(f.rest).toHaveLength(items.length - 8);
    expect(pickFeatured(items.slice(0, 4), true).lead).toBeNull();
    expect(pickFeatured(items, false).rest).toHaveLength(items.length);
  });
});
