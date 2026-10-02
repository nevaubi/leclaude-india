import "server-only";
import { COURTS } from "@/lib/india/courts";
import { CITIES } from "@/lib/india/forums";
import { safeFetch, type SafeFetchInit } from "@/lib/net/safe-fetch";

/**
 * Wikimedia Commons source for the visual library: photographs of court buildings and city landmarks.
 *
 * Search and metadata go through the official MediaWiki Action API (https://commons.wikimedia.org/w/api.php) with a
 * descriptive User-Agent (Wikimedia User-Agent policy), `maxlag`, and backoff on 429/503/maxlag. Only files with a free
 * licence we can honour are candidates (CC0, public domain, CC BY, CC BY-SA, any version; never NC/ND, never non-free,
 * never "insignia"-restricted); the author, licence, licence URL and the file description page are kept for the credit.
 * Candidates are ranked by a deterministic score (licence, size, aspect, title keywords) and then vision-checked.
 */

export const COMMONS_API = "https://commons.wikimedia.org/w/api.php";
export const COMMONS_SOURCE_NAME = "Wikimedia Commons";
/**
 * Thumbnail width requested from Commons. Wikimedia serves a fixed set of standard thumbnail steps (… 960, 1280, 1920)
 * and throttles non-standard widths for automated clients, so a standard step is used rather than an arbitrary 1600.
 */
export const COMMONS_THUMB_WIDTH = 1280;

export function commonsUserAgent(env: NodeJS.ProcessEnv = process.env): string {
  const contact = (env.WIKIMEDIA_CONTACT ?? "").trim().slice(0, 120);
  // Wikimedia's User-Agent policy: tool name/version and a way to reach the operator; generic agents get rate limited.
  return `LeClaude-VisualLibrary/1.0 (https://leclaude-india.vercel.app; Indian law reference pages, attribution kept${contact ? `; ${contact}` : ""}) node-fetch/undici`;
}

// ---------------------------------------------------------------------------
// Licence and credit
// ---------------------------------------------------------------------------

export interface CommonsLicence {
  ok: boolean;
  /** Display name: "CC BY-SA 4.0", "CC BY 2.0", "CC0", "Public domain". */
  license: string | null;
  licenseUrl: string | null;
  /** Whether the licence requires attribution (CC BY / CC BY-SA). */
  attribution: boolean;
  reason?: string;
}

type ExtMeta = Record<string, { value?: unknown } | undefined>;
const meta = (m: ExtMeta | undefined, k: string): string => {
  const v = m?.[k]?.value;
  return typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";
};

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

/** Plain text from Commons extmetadata HTML (Artist, Credit): tags removed, entities decoded, whitespace collapsed. */
export function stripHtml(html: string | null | undefined, max = 200): string | null {
  if (!html) return null;
  const text = html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+|#39);/gi, (m, e: string) => {
      const k = e.toLowerCase();
      if (ENTITIES[k]) return ENTITIES[k];
      const code = k.startsWith("#x") ? parseInt(k.slice(2), 16) : k.startsWith("#") ? parseInt(k.slice(1), 10) : NaN;
      return Number.isFinite(code) && code > 31 && code < 0x110000 ? String.fromCodePoint(code) : m;
    })
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text ? text.slice(0, max) : null;
}

/**
 * Decide whether a Commons file's licence is one we accept, from its extmetadata (LicenseShortName, License,
 * UsageTerms, LicenseUrl, NonFree, Restrictions). Unknown or missing licences are refused.
 */
export function commonsLicence(m: ExtMeta | undefined): CommonsLicence {
  const shortName = meta(m, "LicenseShortName");
  const code = meta(m, "License").toLowerCase();
  const terms = meta(m, "UsageTerms");
  const url = meta(m, "LicenseUrl") || null;
  const all = `${shortName} | ${code} | ${terms}`.toLowerCase();
  const no = (reason: string): CommonsLicence => ({ ok: false, license: shortName || null, licenseUrl: url, attribution: false, reason });
  if (!shortName && !code && !terms) return no("no licence recorded");
  if (/^true$/i.test(meta(m, "NonFree"))) return no("marked non-free");
  if (/insignia/i.test(meta(m, "Restrictions"))) return no("restricted as an insignia");
  if (/all rights reserved|fair use|non-free|noncommercial|non-commercial|\bnc\b|by-nc|no ?deriv|\bnd\b|by-nd/.test(all)) return no(`licence not free enough: ${shortName || code || terms}`);
  if (/\bcc0\b|cc-zero|public domain dedication/.test(all)) {
    return { ok: true, license: "CC0", licenseUrl: url ?? "https://creativecommons.org/publicdomain/zero/1.0/", attribution: false };
  }
  // CC BY / CC BY-SA, any version and jurisdiction port ("CC BY-SA 3.0 IN", "cc-by-sa-4.0").
  const cc = /^cc[- ]by(-sa)?(?:[- ](\d\.\d))?(?:[- ]([a-z]{2}))?$/.exec(shortName.toLowerCase()) ?? /^cc-by(-sa)?(?:-(\d\.\d))?(?:-([a-z]{2}))?$/.exec(code);
  if (cc) {
    const label = `CC BY${cc[1] ? "-SA" : ""}${cc[2] ? ` ${cc[2]}` : ""}${cc[3] ? ` ${cc[3].toUpperCase()}` : ""}`;
    return { ok: true, license: label, licenseUrl: url, attribution: true };
  }
  if (/^public domain$|^pd\b|^pd-|\bpublic domain\b/.test(shortName.toLowerCase()) || /^pd(-|$)/.test(code)) {
    return { ok: true, license: "Public domain", licenseUrl: url, attribution: false };
  }
  return no(`licence not accepted: ${shortName || code || terms}`);
}

// ---------------------------------------------------------------------------
// Candidates and scoring
// ---------------------------------------------------------------------------

export interface CommonsCandidate {
  title: string;
  /** Bounded thumbnail URL (or the original when it is smaller than the thumbnail width). */
  imageUrl: string;
  /** File description page on Commons (the credit link). */
  pageUrl: string;
  width: number;
  height: number;
  mime: string;
  licence: CommonsLicence;
  author: string | null;
  /** The query that found it and its human label ("Bombay High Court building, Mumbai"). */
  query: string;
  label: string;
}

export interface CommonsQuery {
  q: string;
  /** Alt text / subject label for what this query looks for. */
  label: string;
  /** At least one of these phrases must appear in the file title (normalised, case-insensitive). */
  require: string[];
  /**
   * A Commons category to list instead of a full-text search ("Delhi High Court"). Membership of the category is the
   * evidence of subject, so the title requirement does not apply; the vision check still decides.
   */
  category?: string;
}

export interface CommonsTarget {
  kind: "court_building" | "city";
  key: string;
  queries: CommonsQuery[];
}

/** Title words that mark a file as something other than a photograph of the subject. */
const NEGATIVE = /\b(map|maps|locator|location|plan|diagram|logo|emblem|flag|seal|coat of arms|insignia|interior|inside|courtroom|chamber|hall of|people|crowd|protest|rally|signboard|sign board|plaque|stamp|postage|ticket|coin|banknote|note|drawing|sketch|painting|illustration|postcard|poster|screenshot|document|letter|aerial view map|satellite|model of|miniature|selfie|wedding|portrait)\b/;

export function normTitle(t: string): string {
  return t.replace(/^file:/i, "").replace(/\.[a-z0-9]{2,5}$/i, "").replace(/[_\-–—,.;:()[\]'"’]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Deterministic score for a candidate, or null when it must not be used. Higher is better: licence acceptable and
 * attributable, width ≥ 1000 (≥ 1600 better), landscape 1.2–2.2, JPEG, title naming the subject.
 */
/** Marker in `require` for candidates whose subject is established by their Commons category. */
export const ANY_TITLE = "*";

export function scoreCandidate(c: Pick<CommonsCandidate, "title" | "width" | "height" | "mime" | "licence" | "author">, require: string[]): number | null {
  if (!c.licence.ok) return null;
  if (c.licence.attribution && !c.author) return null; // an attribution licence we could not credit
  const mime = c.mime.toLowerCase();
  if (mime !== "image/jpeg" && mime !== "image/png" && mime !== "image/webp") return null; // SVG, GIF, TIFF, video …
  if (!(c.width > 0 && c.height > 0) || c.width < 640) return null;
  const title = normTitle(c.title);
  if (NEGATIVE.test(title)) return null;
  const hits = require.includes(ANY_TITLE) ? 1 : require.filter((p) => title.includes(normTitle(p))).length;
  if (!hits) return null;
  let s = 0;
  s += mime === "image/jpeg" ? 3 : 1;
  s += c.width >= 1000 ? 3 : 0;
  s += c.width >= 1600 ? 1 : 0;
  const aspect = c.width / c.height;
  s += aspect >= 1.2 && aspect <= 2.2 ? 3 : aspect >= 1 && aspect < 1.2 ? 1 : aspect > 2.6 ? -1 : aspect < 1 ? -2 : 0;
  s += Math.min(3, hits) * 2;
  s += c.licence.license === "CC0" || c.licence.license === "Public domain" ? 1 : 0;
  return s;
}

export function rankCandidates(cands: CommonsCandidate[], requireFor: (c: CommonsCandidate) => string[]): Array<CommonsCandidate & { score: number }> {
  const seen = new Set<string>();
  const out: Array<CommonsCandidate & { score: number }> = [];
  for (const c of cands) {
    if (seen.has(c.title)) continue;
    seen.add(c.title);
    const score = scoreCandidate(c, requireFor(c));
    if (score !== null) out.push({ ...c, score });
  }
  return out.sort((a, b) => b.score - a.score || b.width - a.width || a.title.localeCompare(b.title));
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export interface CommonsDeps {
  fetchImpl?: SafeFetchInit["fetchImpl"];
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}

export class CommonsError extends Error {
  constructor(readonly code: "rate_limited" | "http" | "api" | "parse", message: string) {
    super(message);
    this.name = "CommonsError";
  }
}

export function commonsSearchUrl(q: string, limit = 12): string {
  const p = new URLSearchParams({
    action: "query", format: "json", formatversion: "2", maxlag: "5",
    generator: "search", gsrsearch: `${q} filetype:bitmap`, gsrnamespace: "6", gsrlimit: String(limit),
    prop: "imageinfo", iiprop: "url|size|mime|extmetadata", iiurlwidth: String(COMMONS_THUMB_WIDTH),
    iiextmetadatafilter: "LicenseShortName|License|UsageTerms|LicenseUrl|Artist|NonFree|Restrictions|AttributionRequired",
  });
  return `${COMMONS_API}?${p.toString()}`;
}

const sleepDefault = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** GET a Commons API URL as JSON, retrying (max 3 retries) on 429, 503 and maxlag with Retry-After or backoff. */
export async function commonsGet<T>(url: string, deps: CommonsDeps = {}): Promise<T> {
  const sleep = deps.sleep ?? sleepDefault;
  let lastErr: CommonsError | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await safeFetch(url, { headers: { "user-agent": commonsUserAgent(deps.env), "api-user-agent": commonsUserAgent(deps.env), accept: "application/json" }, signal: deps.signal, fetchImpl: deps.fetchImpl }, { name: "wikimedia-commons", allowHosts: ["=commons.wikimedia.org"], maxBytes: 4 * 1024 * 1024, timeoutMs: 20_000, maxRedirects: 2 });
    const retryAfter = Number(res.headers.get("retry-after"));
    const wait = Math.min(10_000, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt);
    if (res.status === 429 || res.status === 503) { lastErr = new CommonsError("rate_limited", `Wikimedia Commons answered HTTP ${res.status}`); await sleep(wait); continue; }
    if (!res.ok) throw new CommonsError("http", `Wikimedia Commons answered HTTP ${res.status}`);
    let body: { error?: { code?: string; info?: string } } & Record<string, unknown>;
    try { body = res.json(); } catch { throw new CommonsError("parse", "Wikimedia Commons returned malformed JSON"); }
    if (body?.error?.code === "maxlag") { lastErr = new CommonsError("rate_limited", "Wikimedia Commons replication lag (maxlag)"); await sleep(wait); continue; }
    if (body?.error) throw new CommonsError("api", `Wikimedia Commons API error ${body.error.code ?? ""}: ${(body.error.info ?? "").slice(0, 200)}`);
    return body as T;
  }
  throw lastErr ?? new CommonsError("rate_limited", "Wikimedia Commons kept rate limiting");
}

interface ApiPage {
  title?: string;
  index?: number;
  imageinfo?: Array<{ url?: string; thumburl?: string; descriptionurl?: string; width?: number; height?: number; mime?: string; extmetadata?: ExtMeta }>;
}

/** Parse a generator=search + imageinfo response into candidates (search order kept). */
export function parseCommonsResponse(body: unknown, query: CommonsQuery): CommonsCandidate[] {
  const pages = ((body as { query?: { pages?: ApiPage[] } })?.query?.pages ?? []).slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const out: CommonsCandidate[] = [];
  for (const p of pages) {
    const ii = p.imageinfo?.[0];
    if (!p.title || !ii) continue;
    const imageUrl = ii.thumburl || ii.url;
    const pageUrl = ii.descriptionurl;
    // Wikimedia serves originals from upload.wikimedia.org and (since 2026) scaled thumbnails from thumb.wikimedia.org.
    if (!imageUrl || !pageUrl || !/^https:\/\/(upload|thumb)\.wikimedia\.org\//.test(imageUrl) || !/^https:\/\/commons\.wikimedia\.org\//.test(pageUrl)) continue;
    out.push({
      title: p.title, imageUrl, pageUrl, width: Number(ii.width) || 0, height: Number(ii.height) || 0, mime: ii.mime ?? "",
      licence: commonsLicence(ii.extmetadata), author: stripHtml(meta(ii.extmetadata, "Artist")), query: query.q, label: query.label,
    });
  }
  return out;
}

/** Files in a Commons category (direct members only), with the same image metadata as a search. */
export function commonsCategoryUrl(category: string, limit = 30): string {
  const p = new URLSearchParams({
    action: "query", format: "json", formatversion: "2", maxlag: "5",
    generator: "categorymembers", gcmtitle: `Category:${category.replace(/^Category:/i, "")}`, gcmtype: "file", gcmlimit: String(limit),
    prop: "imageinfo", iiprop: "url|size|mime|extmetadata", iiurlwidth: String(COMMONS_THUMB_WIDTH),
    iiextmetadatafilter: "LicenseShortName|License|UsageTerms|LicenseUrl|Artist|NonFree|Restrictions|AttributionRequired",
  });
  return `${COMMONS_API}?${p.toString()}`;
}

export async function searchCommons(query: CommonsQuery, deps: CommonsDeps = {}): Promise<CommonsCandidate[]> {
  const url = query.category ? commonsCategoryUrl(query.category) : commonsSearchUrl(query.q);
  return parseCommonsResponse(await commonsGet(url, deps), query);
}

// ---------------------------------------------------------------------------
// Curated targets
// ---------------------------------------------------------------------------

const hcq = (q: string, label: string, ...require: string[]): CommonsQuery => ({ q, label, require });
/** Every file in a Commons category about the subject (title requirement waived; vision still checks). */
const cat = (category: string, label: string): CommonsQuery => ({ q: `category:${category}`, label, require: [ANY_TITLE], category });

/** Search queries per court (Supreme Court + every High Court in COURTS). */
export const COURT_QUERIES: Record<string, CommonsQuery[]> = {
  sci: [hcq("Supreme Court of India building", "Supreme Court of India building, New Delhi", "supreme court of india", "supreme court india")],
  "hc-karnataka": [
    hcq("Attara Kacheri Bangalore", "High Court of Karnataka (Attara Kacheri), Bengaluru", "attara kacheri", "karnataka high court", "high court of karnataka"),
    hcq("Karnataka High Court building", "High Court of Karnataka, Bengaluru", "karnataka high court", "high court of karnataka", "attara kacheri"),
  ],
  "hc-telangana": [hcq("Telangana High Court Hyderabad", "High Court for the State of Telangana, Hyderabad", "telangana high court", "high court of telangana", "high court hyderabad", "hyderabad high court", "andhra pradesh high court hyderabad")],
  "hc-andhra": [hcq("Andhra Pradesh High Court Amaravati", "High Court of Andhra Pradesh, Amaravati", "andhra pradesh high court amaravati", "high court amaravati", "ap high court", "amaravati high court", "high court of andhra pradesh")],
  "hc-jk": [hcq("Jammu and Kashmir High Court Srinagar", "High Court of Jammu & Kashmir and Ladakh, Srinagar", "high court srinagar", "jammu and kashmir high court", "j&k high court", "srinagar high court"), cat("High Court of Jammu and Kashmir and Ladakh", "High Court of Jammu & Kashmir and Ladakh")],
  "hc-hp": [hcq("Himachal Pradesh High Court Shimla", "High Court of Himachal Pradesh, Shimla", "himachal pradesh high court", "high court shimla", "shimla high court", "high court of himachal pradesh")],
  "hc-ph": [hcq("Punjab and Haryana High Court Chandigarh", "High Court of Punjab and Haryana, Chandigarh", "punjab and haryana high court", "high court chandigarh", "chandigarh high court", "palace of justice chandigarh")],
  "hc-uttarakhand": [hcq("Uttarakhand High Court Nainital", "High Court of Uttarakhand, Nainital", "uttarakhand high court", "high court nainital", "nainital high court")],
  "hc-delhi": [hcq("Delhi High Court building", "High Court of Delhi, New Delhi", "delhi high court", "high court of delhi", "high court delhi"), cat("Delhi High Court", "High Court of Delhi, New Delhi")],
  "hc-rajasthan": [hcq("Rajasthan High Court Jodhpur", "High Court of Rajasthan, Jodhpur", "rajasthan high court", "high court jodhpur", "high court of rajasthan"), cat("Rajasthan High Court", "High Court of Rajasthan, Jodhpur")],
  "hc-allahabad": [hcq("Allahabad High Court building", "High Court of Judicature at Allahabad, Prayagraj", "allahabad high court", "high court allahabad", "high court of judicature at allahabad")],
  "hc-patna": [hcq("Patna High Court building", "Patna High Court, Patna", "patna high court", "high court patna"), cat("Patna High Court", "Patna High Court, Patna")],
  "hc-sikkim": [hcq("Sikkim High Court Gangtok", "High Court of Sikkim, Gangtok", "sikkim high court", "high court of sikkim", "high court gangtok")],
  "hc-manipur": [hcq("Manipur High Court Imphal", "High Court of Manipur, Imphal", "manipur high court", "high court of manipur", "high court imphal")],
  "hc-tripura": [hcq("Tripura High Court Agartala", "High Court of Tripura, Agartala", "tripura high court", "high court of tripura", "high court agartala")],
  "hc-meghalaya": [hcq("Meghalaya High Court Shillong", "High Court of Meghalaya, Shillong", "meghalaya high court", "high court of meghalaya", "high court shillong")],
  "hc-gauhati": [hcq("Gauhati High Court Guwahati", "Gauhati High Court, Guwahati", "gauhati high court", "guwahati high court")],
  "hc-calcutta": [hcq("Calcutta High Court building", "High Court at Calcutta, Kolkata", "calcutta high court", "high court calcutta", "high court kolkata", "kolkata high court")],
  "hc-jharkhand": [hcq("Jharkhand High Court Ranchi", "High Court of Jharkhand, Ranchi", "jharkhand high court", "high court of jharkhand", "high court ranchi")],
  "hc-orissa": [hcq("Orissa High Court Cuttack", "High Court of Orissa, Cuttack", "orissa high court", "odisha high court", "high court cuttack")],
  "hc-chhattisgarh": [hcq("Chhattisgarh High Court Bilaspur", "High Court of Chhattisgarh, Bilaspur", "chhattisgarh high court", "high court bilaspur", "high court of chhattisgarh")],
  "hc-mp": [hcq("Madhya Pradesh High Court Jabalpur", "High Court of Madhya Pradesh, Jabalpur", "madhya pradesh high court", "high court jabalpur", "jabalpur high court", "mp high court")],
  "hc-gujarat": [hcq("Gujarat High Court Ahmedabad", "High Court of Gujarat, Ahmedabad", "gujarat high court", "high court of gujarat", "high court ahmedabad"), cat("Gujarat High Court", "High Court of Gujarat, Ahmedabad")],
  "hc-bombay": [hcq("Bombay High Court building", "Bombay High Court building, Fort, Mumbai", "bombay high court", "high court bombay", "high court mumbai", "mumbai high court")],
  "hc-kerala": [hcq("Kerala High Court Kochi", "High Court of Kerala, Kochi", "kerala high court", "high court of kerala", "high court kochi", "high court ernakulam")],
  "hc-madras": [hcq("Madras High Court building", "Madras High Court building, Chennai", "madras high court", "high court madras", "high court chennai", "chennai high court")],
};

/** Landmark or skyline queries per city in CITIES. */
export const CITY_QUERIES: Record<string, CommonsQuery[]> = {
  delhi: [hcq("India Gate New Delhi", "India Gate, New Delhi", "india gate")],
  mumbai: [hcq("Gateway of India Mumbai", "Gateway of India, Mumbai", "gateway of india"), hcq("Chhatrapati Shivaji Terminus", "Chhatrapati Shivaji Maharaj Terminus, Mumbai", "chhatrapati shivaji", "victoria terminus", "csmt", "cst mumbai")],
  bengaluru: [hcq("Vidhana Soudha Bangalore", "Vidhana Soudha, Bengaluru", "vidhana soudha")],
  hyderabad: [hcq("Charminar Hyderabad", "Charminar, Hyderabad", "charminar")],
  chennai: [hcq("Ripon Building Chennai", "Ripon Building, Chennai", "ripon building"), hcq("Marina Beach Chennai", "Marina Beach, Chennai", "marina beach"), cat("Ripon Building", "Ripon Building, Chennai"), cat("Marina Beach", "Marina Beach, Chennai")],
  kolkata: [hcq("Victoria Memorial Kolkata", "Victoria Memorial, Kolkata", "victoria memorial"), hcq("Howrah Bridge", "Howrah Bridge, Kolkata", "howrah bridge")],
  pune: [hcq("Shaniwar Wada Pune", "Shaniwar Wada, Pune", "shaniwar wada", "shaniwarwada"), cat("Shaniwar Wada", "Shaniwar Wada, Pune")],
  ahmedabad: [hcq("Sidi Saiyyed Mosque Ahmedabad", "Sidi Saiyyed Mosque, Ahmedabad", "sidi saiyyed", "sidi sayyed"), hcq("Sabarmati Riverfront Ahmedabad", "Sabarmati Riverfront, Ahmedabad", "sabarmati riverfront"), cat("Sidi Saiyyed Mosque", "Sidi Saiyyed Mosque, Ahmedabad"), cat("Kankaria Lake", "Kankaria Lake, Ahmedabad")],
  amaravati: [hcq("Prakasam Barrage Vijayawada", "Prakasam Barrage, Vijayawada", "prakasam barrage"), hcq("Kanaka Durga Temple Vijayawada", "Kanaka Durga Temple, Vijayawada", "kanaka durga")],
  kochi: [hcq("Chinese fishing nets Kochi", "Chinese fishing nets, Fort Kochi", "chinese fishing net")],
  chandigarh: [hcq("Open Hand Monument Chandigarh", "Open Hand Monument, Chandigarh", "open hand"), hcq("Capitol Complex Chandigarh", "Capitol Complex, Chandigarh", "capitol complex")],
  jaipur: [hcq("Hawa Mahal Jaipur", "Hawa Mahal, Jaipur", "hawa mahal")],
  lucknow: [hcq("Bara Imambara Lucknow", "Bara Imambara, Lucknow", "bara imambara"), hcq("Rumi Darwaza Lucknow", "Rumi Darwaza, Lucknow", "rumi darwaza")],
  prayagraj: [hcq("Triveni Sangam Prayagraj", "Triveni Sangam, Prayagraj", "triveni sangam", "sangam"), hcq("All Saints Cathedral Allahabad", "All Saints Cathedral, Prayagraj", "all saints cathedral")],
  gurugram: [hcq("Cyber City Gurgaon skyline", "Cyber City, Gurugram", "cyber city", "gurgaon skyline", "gurugram skyline")],
  noida: [hcq("Noida skyline", "Noida skyline", "noida skyline", "noida sector", "noida")],
};

export function commonsTargets(): CommonsTarget[] {
  const out: CommonsTarget[] = [];
  for (const c of COURTS) if (COURT_QUERIES[c.id]) out.push({ kind: "court_building", key: c.id, queries: COURT_QUERIES[c.id] });
  for (const c of CITIES) if (CITY_QUERIES[c.id]) out.push({ kind: "city", key: c.id, queries: CITY_QUERIES[c.id] });
  return out;
}
