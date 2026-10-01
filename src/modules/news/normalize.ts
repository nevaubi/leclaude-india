/**
 * Normalisation of parsed feed items into stored headlines (pure, deterministic; tested in tests/legal-news.test.ts).
 */
import { createHash } from "node:crypto";
import { decodeEntities, type RawFeedItem } from "./parse";
import { labelsFor } from "./labels";
import { absoluteImageUrl, type NewsImageCandidate } from "./images";
import type { NewsArticle } from "./types";
import type { NewsSource } from "./sources";

export const SUMMARY_MAX = 400;

const TRACKING_PARAMS = new Set(["fbclid", "gclid", "dclid", "gbraid", "wbraid", "msclkid", "yclid", "mc_cid", "mc_eid", "igshid", "_ga", "_gl", "ref", "ref_src", "cmpid", "share", "amp_js_v", "usqp", "s_cid", "ito"]);

/**
 * Canonical form of an article URL: http(s) only, lowercase host, no fragment, tracking parameters (utm_* and the
 * common click ids) removed, remaining parameters kept in order, path kept exactly. Returns null for non-http URLs.
 */
export function canonicalUrl(raw: string | null | undefined, base?: string): string | null {
  if (!raw) return null;
  let u: URL;
  try { u = new URL(raw.trim(), base); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  u.hash = "";
  u.hostname = u.hostname.toLowerCase();
  const keep: Array<[string, string]> = [];
  for (const [k, v] of u.searchParams) if (!k.toLowerCase().startsWith("utm_") && !TRACKING_PARAMS.has(k.toLowerCase())) keep.push([k, v]);
  u.search = "";
  for (const [k, v] of keep) u.searchParams.append(k, v);
  if ((u.protocol === "https:" && u.port === "443") || (u.protocol === "http:" && u.port === "80")) u.port = "";
  return u.toString();
}

/** Stable article id: hash of the canonical URL without its scheme (http/https duplicates collapse). */
export function articleIdFor(canonical: string): string {
  const keyed = canonical.replace(/^https?:\/\//i, "");
  return `ln_${createHash("sha256").update(keyed).digest("hex").slice(0, 24)}`;
}

const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };
const ZONES: Record<string, number> = { GMT: 0, UT: 0, UTC: 0, Z: 0, IST: 330, EST: -300, EDT: -240, CST: -360, CDT: -300, MST: -420, MDT: -360, PST: -480, PDT: -420, BST: 60 };

function offsetMinutes(zone: string | undefined): number | null {
  if (!zone) return null;
  const z = zone.toUpperCase();
  if (z in ZONES) return ZONES[z];
  const m = z.match(/^([+-])(\d{2}):?(\d{2})$/);
  if (!m) return null;
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

/**
 * Parse a feed date (RFC 822/1123 as in RSS pubDate, or ISO 8601 as in Atom) to an ISO instant. A date without a
 * time zone is not guessed: it returns null, and the raw string is kept by the caller. "IST" is read as India
 * Standard Time (+05:30), which is what Indian publishers mean by it.
 */
export function parseFeedDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.replace(/\s+/g, " ").trim();
  const rfc = s.match(/^(?:[A-Za-z]{3,9},? )?(\d{1,2}) ([A-Za-z]{3,9})\.? (\d{2,4}) (\d{1,2}):(\d{2})(?::(\d{2}))? ?([A-Za-z]{1,4}|[+-]\d{2}:?\d{2})?$/);
  if (rfc) {
    const [, d, mon, y, hh, mm, ss, zone] = rfc;
    const month = MONTHS[mon.toLowerCase().slice(0, mon.toLowerCase().startsWith("sept") ? 4 : 3)];
    const off = offsetMinutes(zone);
    if (month === undefined || off === null) return null;
    let year = Number(y);
    if (y.length === 2) year += year < 70 ? 2000 : 1900;
    const day = Number(d);
    const ms = Date.UTC(year, month, day, Number(hh), Number(mm), Number(ss ?? 0)) - off * 60_000;
    const check = new Date(Date.UTC(year, month, day));
    if (check.getUTCDate() !== day || Number(hh) > 23 || Number(mm) > 59) return null;
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s?(Z|[+-]\d{2}:?\d{2})$/i);
  if (iso) {
    const [, y, mo, d, hh, mm, ss, zone] = iso;
    const off = offsetMinutes(zone);
    if (off === null) return null;
    const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mm), Number(ss ?? 0)) - off * 60_000;
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  return null;
}

/** HTML to plain text: tags and scripts removed, entities decoded, whitespace collapsed. */
export function stripHtml(html: string | null | undefined): string {
  if (!html) return "";
  let s = html.replace(/<(script|style|figure|figcaption|iframe)[\s\S]*?<\/\1\s*>/gi, " ");
  s = s.replace(/<br\s*\/?>|<\/(p|div|li|h\d)>/gi, " ").replace(/<[^>]+>/g, " ");
  s = decodeEntities(decodeEntities(s));
  return s.replace(/[ \s]+/g, " ").trim();
}

/**
 * Summary from the feed's own description/summary only, at most 400 chars. The article body (content:encoded, Atom
 * content) is never used: it is the publisher's full text, which is not reproduced.
 */
export function summarize(description: string | null, title: string): string {
  let text = stripHtml(description);
  // WordPress appends "The post X appeared first on Y." and "[…]" boilerplate.
  text = text.replace(/\s*The post .{1,300}? appeared first on .{1,120}?\.?$/i, "").replace(/\s*\[(?:…|\.\.\.|&hellip;)\]\s*$/, "…").trim();
  if (!text || text === title) return "";
  if (text.length <= SUMMARY_MAX) return text;
  const cut = text.slice(0, SUMMARY_MAX - 1);
  const sp = cut.lastIndexOf(" ");
  return `${(sp > SUMMARY_MAX * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.-]+$/, "")}…`;
}

export function cleanTitle(raw: string): string {
  return stripHtml(raw).replace(/\s+/g, " ").trim().slice(0, 400);
}

/**
 * One parsed item as a stored headline, or null when it has no usable link or title. `now` is the first-seen time;
 * it is never used as the published time.
 */
export function normalizeItem(raw: RawFeedItem, source: NewsSource, now: Date): NewsArticle | null {
  const title = cleanTitle(raw.title);
  const link = raw.link ?? (raw.guidIsPermaLink !== false && raw.guid && /^https?:\/\//i.test(raw.guid) ? raw.guid : null);
  const url = canonicalUrl(link, source.homepage);
  if (!title || !url) return null;
  const ts = now.toISOString();
  const authors = raw.authors.map((a) => stripHtml(a)).filter(Boolean).slice(0, 6);
  const categories = raw.categories.map((c) => stripHtml(c)).filter(Boolean).slice(0, 20);
  const tags = raw.tags.map((c) => stripHtml(c)).filter(Boolean).slice(0, 30);
  const { labels, courtIds } = labelsFor({ title, categories, tags });
  const candidates = (raw.imageCandidates ?? [])
    .map((c) => ({ ...c, url: absoluteImageUrl(c.url, source.homepage) }))
    .filter((c): c is NewsImageCandidate => c.url !== null);
  const image = absoluteImageUrl(raw.imageUrl, source.homepage);
  const chosen = image ? candidates.find((c) => c.url === image) : undefined;
  return {
    id: articleIdFor(url),
    url,
    sourceId: source.id,
    publisher: source.publisher,
    title,
    summary: summarize(raw.description, title),
    authors,
    categories,
    tags,
    publishedAt: parseFeedDate(raw.date),
    publishedRaw: raw.date ?? null,
    firstSeenAt: ts,
    lastSeenAt: ts,
    imageUrl: image,
    imageSource: image ? "feed" : null,
    imageWidth: chosen?.width ?? null,
    imageHeight: chosen?.height ?? null,
    imageCandidates: candidates,
    guid: raw.guid,
    labels,
    courtIds,
    syndicatedBy: [],
  };
}
