import "server-only";
import { safeFetch, type SafeFetchInit } from "@/lib/net/safe-fetch";
import { isLegacyTlsError, legacyTlsAllowed, legacyTlsFetch } from "./legacy-tls";
import { MAX_SOURCE_BYTES } from "./resize";

/**
 * Regulator logos for the visual library, taken from each regulator's official website (nominative use: shown only
 * beside the publisher they identify). Discovery order: the site's branding logo (Firecrawl), header <img> elements
 * whose src/alt/class/id name a logo, og:image, apple-touch-icon, then icons declared at ≥128 px. Only raster images are
 * stored; an SVG logo is sanitised (no DOCTYPE/entities, no external references, no script) and rasterised to PNG.
 * Keys are the canonical regulator values of the statutes corpus (`law_instruments.regulator`, REGULATOR_LABEL).
 */

export interface RegulatorSite {
  key: string;
  name: string;
  siteUrl: string;
  /** Hosts (bare domains, subdomains included) a logo may come from besides the site's own domain. */
  extraHosts?: string[];
}

export const REGULATOR_SITES: RegulatorSite[] = [
  { key: "rbi", name: "Reserve Bank of India", siteUrl: "https://www.rbi.org.in/" },
  { key: "sebi", name: "Securities and Exchange Board of India", siteUrl: "https://www.sebi.gov.in/" },
  { key: "mca", name: "Ministry of Corporate Affairs", siteUrl: "https://www.mca.gov.in/" },
  { key: "trai", name: "Telecom Regulatory Authority of India", siteUrl: "https://www.trai.gov.in/" },
  { key: "irdai", name: "Insurance Regulatory and Development Authority of India", siteUrl: "https://irdai.gov.in/" },
  { key: "cbic", name: "Central Board of Indirect Taxes and Customs", siteUrl: "https://www.cbic.gov.in/" },
  { key: "dgft", name: "Directorate General of Foreign Trade", siteUrl: "https://www.dgft.gov.in/" },
  { key: "cpcb", name: "Central Pollution Control Board", siteUrl: "https://cpcb.nic.in/" },
  { key: "moefcc", name: "Ministry of Environment, Forest and Climate Change", siteUrl: "https://moef.gov.in/" },
  { key: "dfs", name: "Department of Financial Services", siteUrl: "https://financialservices.gov.in/" },
  { key: "law-commission", name: "Law Commission of India", siteUrl: "https://lawcommissionofindia.nic.in/" },
];

/** Regulator keys with no single official publisher whose logo could identify them. */
export const REGULATORS_WITHOUT_LOGO: Record<string, string> = {
  "state-gst": "State GST is administered by each State's commercial tax department; there is no single publisher logo",
};

export function regulatorSite(key: string): RegulatorSite | null {
  return REGULATOR_SITES.find((r) => r.key === key) ?? null;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export interface LogoCandidate {
  url: string;
  via: "branding" | "header_img" | "og_image" | "apple_touch_icon" | "icon";
}

const attr = (tag: string, name: string): string | null => {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3] ?? "").trim() : null;
};

function abs(u: string | null | undefined, base: string): string | null {
  if (!u) return null;
  const t = u.trim().replace(/&amp;/g, "&");
  if (/^data:image\//i.test(t)) return t;
  try {
    const url = new URL(t, base);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch { return null; }
}

/** Logo candidates from a page's HTML, in preference order (deduplicated). */
export function logoCandidatesFromHtml(html: string, pageUrl: string): LogoCandidate[] {
  const out: LogoCandidate[] = [];
  const push = (url: string | null, via: LogoCandidate["via"]) => { if (url && !out.some((c) => c.url === url)) out.push({ url, via }); };
  const head = html.slice(0, 400_000);
  // Header images that call themselves a logo (src, alt, class or id), in document order; banners and sliders excluded.
  for (const m of head.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const src = attr(tag, "src") ?? attr(tag, "data-src");
    const hint = `${src ?? ""} ${attr(tag, "alt") ?? ""} ${attr(tag, "class") ?? ""} ${attr(tag, "id") ?? ""}`.toLowerCase();
    if (!/logo/.test(hint) || /banner|slider|carousel|footer|g20|azadi|swachh|digital-?india|india-?gov|mygov|data\.gov|pmindia|incredible|qr/.test(hint)) continue;
    push(abs(src, pageUrl), "header_img");
    if (out.filter((c) => c.via === "header_img").length >= 3) break;
  }
  for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
    const p = (attr(m[0], "property") ?? attr(m[0], "name") ?? "").toLowerCase();
    if (p === "og:image" || p === "og:image:url") push(abs(attr(m[0], "content"), pageUrl), "og_image");
  }
  const icons: Array<{ url: string; size: number; apple: boolean }> = [];
  for (const m of head.matchAll(/<link\b[^>]*>/gi)) {
    const rel = (attr(m[0], "rel") ?? "").toLowerCase();
    if (!/icon/.test(rel)) continue;
    const url = abs(attr(m[0], "href"), pageUrl);
    if (!url) continue;
    const sizes = (attr(m[0], "sizes") ?? "").toLowerCase();
    const size = Math.max(0, ...[...sizes.matchAll(/(\d+)x(\d+)/g)].map((s) => Math.min(Number(s[1]), Number(s[2]))));
    icons.push({ url, size, apple: rel.includes("apple-touch-icon") });
  }
  for (const i of icons.filter((x) => x.apple).sort((a, b) => b.size - a.size)) push(i.url, "apple_touch_icon");
  for (const i of icons.filter((x) => !x.apple && x.size >= 128).sort((a, b) => b.size - a.size)) push(i.url, "icon");
  return out;
}

/** Whether a logo URL may be used for `site`: data URIs, the site's own domain, gov.in / nic.in hosts, or listed hosts. */
export function logoHostAllowed(url: string, site: RegulatorSite): boolean {
  if (/^data:image\//i.test(url)) return true;
  let host: string;
  try { const u = new URL(url); if (u.protocol !== "https:" && u.protocol !== "http:") return false; host = u.hostname.toLowerCase(); } catch { return false; }
  const own = new URL(site.siteUrl).hostname.toLowerCase().replace(/^www\./, "");
  const under = (d: string) => host === d || host.endsWith(`.${d}`);
  return under(own) || under("gov.in") || under("nic.in") || (site.extraHosts ?? []).some(under);
}

// ---------------------------------------------------------------------------
// Bytes: fetch, data URIs and SVG rasterisation
// ---------------------------------------------------------------------------

export const MAX_SVG_BYTES = 512 * 1024;

export class LogoError extends Error {
  constructor(readonly code: "svg_unsafe" | "svg_too_large" | "no_rasteriser" | "bad_data_uri" | "http", message: string) {
    super(message);
    this.name = "LogoError";
  }
}

export function looksLikeSvg(bytes: Uint8Array, declared: string | null): boolean {
  if ((declared ?? "").toLowerCase().includes("svg")) return true;
  const head = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, 512)).replace(/^﻿/, "").trimStart().toLowerCase();
  return head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"));
}

/**
 * Validate SVG text before rasterising: refuse DOCTYPE/ENTITY declarations (XXE, billion laughs), foreignObject, and any
 * reference that is not a same-document fragment or an embedded raster data URI; strip scripts and event handlers.
 */
export function sanitiseSvg(svg: string): string {
  if (svg.length > MAX_SVG_BYTES) throw new LogoError("svg_too_large", `SVG is ${svg.length} bytes, above the ${MAX_SVG_BYTES}-byte limit`);
  if (/<!DOCTYPE|<!ENTITY/i.test(svg)) throw new LogoError("svg_unsafe", "SVG declares a DOCTYPE or entities");
  if (/<foreignObject\b/i.test(svg)) throw new LogoError("svg_unsafe", "SVG embeds foreign content");
  for (const m of svg.matchAll(/(?:xlink:href|href|src)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    const v = (m[1] ?? m[2] ?? "").trim();
    if (v && !v.startsWith("#") && !/^data:image\/(png|jpe?g|gif|webp);base64,/i.test(v)) throw new LogoError("svg_unsafe", "SVG references an external resource");
  }
  for (const m of svg.matchAll(/url\(\s*['"]?([^'")]*)/gi)) {
    const v = m[1].trim();
    if (v && !v.startsWith("#")) throw new LogoError("svg_unsafe", "SVG style references an external resource");
  }
  if (/@import/i.test(svg)) throw new LogoError("svg_unsafe", "SVG style imports an external stylesheet");
  return svg.replace(/<script\b[\s\S]*?<\/script>/gi, "").replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*')/gi, "");
}

type SharpLike = (input: Uint8Array | Buffer, options?: Record<string, unknown>) => {
  resize(o: { width: number; height: number; fit: "inside"; withoutEnlargement?: boolean }): ReturnType<SharpLike>;
  png(): ReturnType<SharpLike>;
  toBuffer(): Promise<Buffer>;
};

let sharpLoader: Promise<SharpLike | null> | null = null;
async function loadSharp(): Promise<SharpLike | null> {
  sharpLoader ??= import("sharp").then((m) => ((m as { default?: unknown }).default ?? m) as unknown as SharpLike).catch(() => null);
  return sharpLoader;
}

/** Rasterise sanitised SVG to a PNG at most 512 px on its long edge. */
export async function rasteriseSvg(svg: string, deps: { sharp?: SharpLike | null } = {}): Promise<Uint8Array> {
  const clean = sanitiseSvg(svg);
  const sharp = deps.sharp === undefined ? await loadSharp() : deps.sharp;
  if (!sharp) throw new LogoError("no_rasteriser", "The logo is SVG and no rasteriser is available");
  const out = await sharp(Buffer.from(clean, "utf8"), { density: 192, limitInputPixels: 16_000_000, failOn: "error" }).resize({ width: 512, height: 512, fit: "inside" }).png().toBuffer();
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}

export function decodeDataUri(uri: string): { bytes: Uint8Array; type: string } {
  const m = /^data:(image\/[a-z0-9.+-]+)((?:;(?!base64,)[a-z0-9=._-]+)*)(;base64)?,(.*)$/is.exec(uri.trim());
  if (!m) throw new LogoError("bad_data_uri", "Unsupported data URI");
  const raw = m[4];
  if (raw.length > MAX_SVG_BYTES * 2) throw new LogoError("svg_too_large", "Data URI is too large");
  const bytes = m[3] ? new Uint8Array(Buffer.from(raw, "base64")) : new TextEncoder().encode(decodeURIComponent(raw));
  return { bytes, type: m[1].toLowerCase() };
}

export interface FetchedBytes { bytes: Uint8Array; contentType: string | null; finalUrl: string }

/** SSRF-safe GET (legacy TLS retry for gov.in / nic.in hosts only, as in the media store). */
export async function fetchPublic(url: string, accept: string, deps: { fetchImpl?: SafeFetchInit["fetchImpl"]; signal?: AbortSignal; maxBytes?: number } = {}): Promise<FetchedBytes> {
  const get = (fetchImpl?: typeof fetch, legacy = false) => safeFetch(url, { headers: { accept, "user-agent": "LeClaude-Enrichment/1.0 (+publisher identity; attribution kept)" }, signal: deps.signal, fetchImpl }, {
    name: "media-logo", maxBytes: deps.maxBytes ?? MAX_SOURCE_BYTES, timeoutMs: 20_000, maxRedirects: 3, ...(legacy ? { dnsCheck: true } : {}),
  });
  let res;
  try {
    res = await get(deps.fetchImpl);
  } catch (e) {
    if (deps.fetchImpl || !isLegacyTlsError(e) || !legacyTlsAllowed(url)) throw e;
    res = await get(legacyTlsFetch, true);
  }
  if (!res.ok) throw new LogoError("http", `HTTP ${res.status} for ${url}`);
  return { bytes: res.body, contentType: res.contentType || null, finalUrl: res.finalUrl || url };
}
