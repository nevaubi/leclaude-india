/**
 * Legal news images: candidate extraction (feed markup, article <meta> tags), the vision verdict contract and the
 * display policy (pure, deterministic, client-safe; tested in tests/legal-news-images.test.ts).
 *
 * Display policy (decided here, applied server-side in listLegalNews):
 *  1. A vision verdict for the current image URL decides: `ok: true` shows it (with the model's alt text), anything
 *     else hides it. A deterministic probe verdict (not an image, unreachable, smaller than MIN_IMAGE_SIDE) hides it.
 *  2. An image not yet reviewed (or whose review failed MAX_REVIEW_ATTEMPTS times) is shown only when the cheap
 *     heuristic passes: http(s) URL, no logo/placeholder/icon/avatar/sprite/default naming, not SVG/GIF/ICO, known
 *     dimensions (if any) at least MIN_IMAGE_SIDE on the short side with an aspect ratio between 1:2.2 and 3:1, and the
 *     URL is not shared by REPEATED_IMAGE_THRESHOLD or more stored headlines (a publisher's default image).
 *  3. Otherwise no image: the UI shows the publisher monogram tile.
 */

export type NewsImageSource = "feed" | "og" | "firecrawl";

export type NewsImageOrigin =
  | "media:content"
  | "media:thumbnail"
  | "enclosure"
  | "content-img"
  | "description-img"
  | "og:image"
  | "twitter:image"
  | "image_src"
  | "firecrawl";

export interface NewsImageCandidate {
  url: string;
  origin: NewsImageOrigin;
  width?: number;
  height?: number;
  type?: string;
}

export type NewsImageKind = "photo" | "illustration" | "logo" | "placeholder" | "text-banner" | "other";
export const IMAGE_KINDS: readonly NewsImageKind[] = ["photo", "illustration", "logo", "placeholder", "text-banner", "other"];

export interface NewsImageVerdict {
  ok: boolean;
  reason: string;
  kind: NewsImageKind;
  alt: string;
}

/** Stored review of one image URL (the review is void when the article's imageUrl changes). */
export interface NewsImageReview extends NewsImageVerdict {
  url: string;
  checkedAt: string;
  /** "probe" = deterministic byte check (no model call); "vision" = describeImage verdict. */
  by: "probe" | "vision";
  width?: number;
  height?: number;
}

/** Failed review attempts for one image URL (model error, malformed verdict). Reset when the URL changes. */
export interface NewsImageAttempts {
  url: string;
  count: number;
  lastAt: string;
  lastError: string | null;
}

/** Page lookup (og:image, then Firecrawl) state for an article. */
export interface NewsImageLookup {
  attempts: number;
  lastAt: string;
  status: "found" | "none" | "failed";
  via?: "og" | "firecrawl";
  error?: string;
}

/** What the UI renders for an article (computed at read time; null = monogram tile). */
export interface NewsImageView {
  url: string;
  alt: string;
  width: number | null;
  height: number | null;
  source: NewsImageSource;
  /** "verified" = vision verdict ok; "heuristic" = not yet reviewed, passed the cheap checks. */
  status: "verified" | "heuristic";
}

export const MIN_IMAGE_SIDE = 200;
export const REPEATED_IMAGE_THRESHOLD = 3;
export const MAX_REVIEW_ATTEMPTS = 3;
export const MAX_LOOKUP_ATTEMPTS = 2;

const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (m, e: string) => {
    const l = e.toLowerCase();
    if (l === "amp") return "&";
    if (l === "quot") return "\"";
    if (l === "apos") return "'";
    if (l === "lt") return "<";
    if (l === "gt") return ">";
    const code = l[1] === "x" ? parseInt(l.slice(2), 16) : parseInt(l.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
  });

function attrsOf(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Za-z_:][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  for (let m = re.exec(tag); m; m = re.exec(tag)) out[m[1].toLowerCase()] = decode(m[3] ?? m[4] ?? m[5] ?? "");
  return out;
}

const dim = (v: string | undefined): number | undefined => {
  if (!v) return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 && n < 100_000 ? n : undefined;
};

/** Absolute http(s) URL or null (data:, javascript:, protocol-less junk are refused). */
export function absoluteImageUrl(raw: string | null | undefined, base?: string): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s || /^data:/i.test(s)) return null;
  let u: URL;
  try { u = new URL(s, base); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  u.hash = "";
  return u.toString();
}

const TRACKER = /(?:feeds\.feedburner\.com|stats\.wordpress\.com|pixel\.wp\.com|\/wp-includes\/images\/smilies\/|s\.w\.org\/images\/core\/emoji|gravatar\.com\/avatar|doubleclick\.net|google-analytics\.com|facebook\.com\/tr)/i;

/** Largest URL in a srcset ("a.jpg 300w, b.jpg 1024w"). */
function bestFromSrcset(srcset: string | undefined): string | null {
  if (!srcset) return null;
  let best: { url: string; w: number } | null = null;
  for (const part of srcset.split(",")) {
    const [url, size] = part.trim().split(/\s+/);
    if (!url) continue;
    const w = size ? Number.parseFloat(size) * (/x$/i.test(size) ? 1000 : 1) : 0;
    if (!best || w > best.w) best = { url, w };
  }
  return best?.url ?? null;
}

/** <img> candidates from feed HTML (content:encoded / description), in document order, trackers and pixels skipped. */
export function htmlImageCandidates(html: string | null | undefined, origin: "content-img" | "description-img", base?: string, max = 3): NewsImageCandidate[] {
  if (!html) return [];
  const out: NewsImageCandidate[] = [];
  const re = /<img\b[^>]*>/gi;
  for (let m = re.exec(html); m && out.length < max; m = re.exec(html)) {
    const a = attrsOf(m[0].slice(4));
    const raw = a["data-src"] || a["data-lazy-src"] || a["data-original"] || bestFromSrcset(a["data-srcset"] || a.srcset) || a.src;
    const url = absoluteImageUrl(raw, base);
    if (!url || TRACKER.test(url)) continue;
    const width = dim(a.width);
    const height = dim(a.height);
    if ((width !== undefined && width <= 2) || (height !== undefined && height <= 2)) continue;
    if (out.some((c) => c.url === url)) continue;
    out.push({ url, origin, width, height });
  }
  return out;
}

/**
 * Image candidates named in an article page's <head>: og:image (+ secure_url, width, height, type), twitter:image,
 * <link rel="image_src">. Only the first 256 KB are scanned. Relative URLs resolve against `base`.
 */
export function extractMetaImages(html: string, base?: string): NewsImageCandidate[] {
  const head = (html ?? "").slice(0, 256 * 1024);
  const end = head.search(/<\/head\s*>/i);
  const scope = end > 0 ? head.slice(0, end) : head;
  const out: NewsImageCandidate[] = [];
  let og: NewsImageCandidate | null = null;
  const push = (c: NewsImageCandidate | null) => { if (c && !out.some((x) => x.url === c.url)) out.push(c); };
  const re = /<(meta|link)\b[^>]*>/gi;
  for (let m = re.exec(scope); m; m = re.exec(scope)) {
    const a = attrsOf(m[0].replace(/^<(meta|link)/i, ""));
    if (m[1].toLowerCase() === "link") {
      if ((a.rel ?? "").toLowerCase().split(/\s+/).includes("image_src")) push(((u) => (u ? { url: u, origin: "image_src" as const } : null))(absoluteImageUrl(a.href, base)));
      continue;
    }
    const key = (a.property || a.name || a.itemprop || "").toLowerCase();
    const content = a.content;
    if (!content) continue;
    if (key === "og:image" || key === "og:image:url" || key === "og:image:secure_url") {
      const url = absoluteImageUrl(content, base);
      if (!url) continue;
      if (og && key === "og:image:secure_url" && og.url.replace(/^http:/, "https:") === url) { og.url = url; continue; }
      if (og && key !== "og:image") continue;
      og = { url, origin: "og:image" };
      push(og);
    } else if (og && key === "og:image:width") og.width = dim(content);
    else if (og && key === "og:image:height") og.height = dim(content);
    else if (og && key === "og:image:type") og.type = content;
    else if (key === "twitter:image" || key === "twitter:image:src") {
      const url = absoluteImageUrl(content, base);
      if (url) push({ url, origin: "twitter:image" });
    }
  }
  return out;
}

/** Generic asset names, matched on the file name only ("/sites/default/files/x.jpg" is a Drupal path, not a default image). */
const GENERIC_FILE = /(?:^|[_.-])(logo|favicon|apple-touch-icon|icon|sprite|placeholder|default|no[-_]?image|noimage|blank|spacer|avatar|fallback|watermark)(?:[_.-]|\d|$)/i;
const GENERIC_DIR = /\/(logos?|icons?|favicons?|placeholders?|avatars?|sprites?)\//i;
const BAD_EXT = /\.(svg|ico|gif)(?:$|[?#])/i;

/** True when the URL alone says it is a logo, icon, placeholder or other non-photo asset. */
export function imageUrlLooksGeneric(url: string): boolean {
  let path: string;
  try { const u = new URL(url); path = `${u.pathname}`.toLowerCase(); } catch { return true; }
  if (BAD_EXT.test(path)) return true;
  if (TRACKER.test(url)) return true;
  const file = path.split("/").pop() ?? "";
  // "cropped-...-32x32.jpg" style site icons and tiny size suffixes.
  const size = file.match(/[-_](\d{2,4})x(\d{2,4})\.[a-z]+$/);
  if (size && Math.min(Number(size[1]), Number(size[2])) < MIN_IMAGE_SIDE) return true;
  return GENERIC_FILE.test(file) || GENERIC_DIR.test(path);
}

/** Cheap pre-model check; `repeats` = stored headlines sharing this exact URL. */
export function passesImageHeuristic(c: { url: string; width?: number | null; height?: number | null }, repeats = 1): boolean {
  if (!absoluteImageUrl(c.url)) return false;
  if (imageUrlLooksGeneric(c.url)) return false;
  if (repeats >= REPEATED_IMAGE_THRESHOLD) return false;
  const w = c.width ?? null;
  const h = c.height ?? null;
  if (w !== null && h !== null) {
    if (Math.min(w, h) < MIN_IMAGE_SIDE) return false;
    const r = w / h;
    if (r < 1 / 2.2 || r > 3) return false;
  } else if ((w !== null && w < MIN_IMAGE_SIDE) || (h !== null && h < MIN_IMAGE_SIDE)) return false;
  return true;
}

const ORIGIN_RANK: Record<NewsImageOrigin, number> = {
  "media:content": 0, enclosure: 1, "og:image": 2, "media:thumbnail": 3, "content-img": 4, "twitter:image": 5, "description-img": 6, image_src: 7, firecrawl: 8,
};

/** Best usable candidate: heuristic-passing ones first, then by origin rank, then by known area. */
export function pickImageCandidate(cands: NewsImageCandidate[]): NewsImageCandidate | null {
  const ok = cands.filter((c) => passesImageHeuristic(c));
  if (!ok.length) return null;
  return [...ok].sort((a, b) => ORIGIN_RANK[a.origin] - ORIGIN_RANK[b.origin] || (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0))[0];
}

// ---------------------------------------------------------------------------
// Vision verdict
// ---------------------------------------------------------------------------

export const IMAGE_REVIEW_PROMPT = [
  "You are checking whether an image is suitable as the thumbnail for a legal news headline on a professional legal research site.",
  "Reply with ONLY a JSON object, no prose, no code fence:",
  '{"ok": boolean, "reason": string, "kind": "photo"|"illustration"|"logo"|"placeholder"|"text-banner"|"other", "alt": string}',
  "Rules: ok=true only for a real news photograph or a relevant editorial illustration that renders correctly.",
  "ok=false for: a publisher or site logo/wordmark, a generic placeholder or stock 'no image' graphic, a blank or broken image,",
  "an image that is mostly text (headline cards, quote cards, banners), a tiny or badly cropped image, or anything graphic, violent, sexual or otherwise unsafe.",
  "reason: at most 20 words. alt: a neutral, factual description of what is visible in at most 16 words; do not guess names of people.",
].join(" ");

export class ImageVerdictError extends Error {}

/**
 * Strict verdict parser: exactly a JSON object (an optional ```json fence is tolerated) with a boolean `ok`, a
 * `kind` from IMAGE_KINDS, and string `reason`/`alt`. A logo/placeholder/text-banner can never be ok.
 */
export function parseImageVerdict(text: string): NewsImageVerdict {
  const t = (text ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  if (!t.startsWith("{") || !t.endsWith("}")) throw new ImageVerdictError("Verdict is not a JSON object");
  let v: unknown;
  try { v = JSON.parse(t); } catch { throw new ImageVerdictError("Verdict is not valid JSON"); }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new ImageVerdictError("Verdict is not a JSON object");
  const o = v as Record<string, unknown>;
  if (typeof o.ok !== "boolean") throw new ImageVerdictError("Verdict.ok must be a boolean");
  if (typeof o.kind !== "string" || !IMAGE_KINDS.includes(o.kind as NewsImageKind)) throw new ImageVerdictError("Verdict.kind is not an allowed kind");
  if (typeof o.reason !== "string") throw new ImageVerdictError("Verdict.reason must be a string");
  if (typeof o.alt !== "string") throw new ImageVerdictError("Verdict.alt must be a string");
  const kind = o.kind as NewsImageKind;
  const ok = o.ok && kind !== "logo" && kind !== "placeholder" && kind !== "text-banner";
  const clean = (s: string, n: number) => s.replace(/[\u0000-\u001f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
  const alt = clean(o.alt, 160);
  if (ok && !alt) throw new ImageVerdictError("An accepted image needs alt text");
  return { ok, kind, reason: clean(o.reason, 200), alt };
}

// ---------------------------------------------------------------------------
// Image byte probe (dimensions from the header bytes)
// ---------------------------------------------------------------------------

/** Width/height from PNG, GIF, JPEG or WebP header bytes; null when unknown. */
export function imageDimensions(b: Uint8Array): { width: number; height: number; format: "png" | "gif" | "jpeg" | "webp" } | null {
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    const w = (b[16] << 24) | (b[17] << 16) | (b[18] << 8) | b[19];
    const h = (b[20] << 24) | (b[21] << 16) | (b[22] << 8) | b[23];
    return { width: w >>> 0, height: h >>> 0, format: "png" };
  }
  if (b.length >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return { width: b[6] | (b[7] << 8), height: b[8] | (b[9] << 8), format: "gif" };
  if (b.length >= 30 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    const chunk = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (chunk === "VP8X") return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)), format: "webp" };
    if (chunk === "VP8 " && b.length >= 30) return { width: (b[26] | (b[27] << 8)) & 0x3fff, height: (b[28] | (b[29] << 8)) & 0x3fff, format: "webp" };
    if (chunk === "VP8L" && b.length >= 25) {
      const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, format: "webp" };
    }
    return null;
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1];
      if (marker === 0xff) { i++; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const len = (b[i + 2] << 8) | b[i + 3];
      if (len < 2) return null;
      if ((marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: (b[i + 5] << 8) | b[i + 6], width: (b[i + 7] << 8) | b[i + 8], format: "jpeg" };
      }
      i += 2 + len;
    }
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Display decision
// ---------------------------------------------------------------------------

export interface ImageFields {
  imageUrl: string | null;
  imageSource?: NewsImageSource | null;
  imageWidth?: number | null;
  imageHeight?: number | null;
  imageReview?: NewsImageReview | null;
  imageAttempts?: NewsImageAttempts | null;
  title?: string;
}

/** The image the UI may show for an article (see the policy at the top of this file), or null. */
export function displayImageFor(a: ImageFields, repeats = 1): NewsImageView | null {
  const url = a.imageUrl;
  if (!url || !absoluteImageUrl(url)) return null;
  const review = a.imageReview && a.imageReview.url === url ? a.imageReview : null;
  const width = review?.width ?? a.imageWidth ?? null;
  const height = review?.height ?? a.imageHeight ?? null;
  const source = a.imageSource ?? "feed";
  if (review) {
    if (!review.ok) return null;
    if (review.by === "vision") return { url, alt: review.alt, width, height, source, status: "verified" };
  }
  if (!passesImageHeuristic({ url, width, height }, repeats)) return null;
  return { url, alt: "", width, height, source, status: "heuristic" };
}

/** Publisher monogram for the fallback tile ("Bar & Bench" -> "BB", "LiveLaw" -> "LL", "SCC Times (…)" -> "ST"). */
export function publisherMonogram(publisher: string): string {
  const base = publisher.replace(/\(.*?\)/g, "").trim();
  const words = base.split(/[\s&]+/).filter((w) => /[A-Za-z]/.test(w));
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  const caps = base.match(/[A-Z]/g);
  if (caps && caps.length >= 2) return (caps[0] + caps[1]).toUpperCase();
  return base.slice(0, 2).toUpperCase();
}
