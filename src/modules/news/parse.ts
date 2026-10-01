/**
 * Dependency-free RSS 2.0 / Atom 1.0 reader for news feeds (pure; client-safe but used on the server).
 *
 * Approach: CDATA sections are lifted out first (so markup inside them cannot confuse element matching), comments
 * and processing instructions are dropped, and items/entries are matched as balanced-enough regions. Element names
 * may carry a namespace prefix (`dc:creator`, `content:encoded`, `media:content`). Text outside CDATA is
 * entity-decoded once as XML; text that is HTML (descriptions, CDATA titles) is decoded again as HTML where needed by
 * the caller (`decodeEntities`).
 */

import { htmlImageCandidates, pickImageCandidate, type NewsImageCandidate } from "./images";

export interface RawFeedItem {
  title: string;
  link: string | null;
  guid: string | null;
  guidIsPermaLink: boolean | null;
  /** The feed's date string, verbatim (pubDate, published, updated or dc:date). */
  date: string | null;
  authors: string[];
  categories: string[];
  /** Non-standard `<tags>` element (Verdictum), split on commas. */
  tags: string[];
  /** description / summary as given (may contain HTML). */
  description: string | null;
  /** content:encoded / Atom content as given (never stored; used only when there is no description). */
  content: string | null;
  /** First usable image (see `imageCandidates`), null when the item names none. */
  imageUrl: string | null;
  /** Every image the item names, in feed order: media:content, enclosure, media:thumbnail, then <img> in content/description. */
  imageCandidates: NewsImageCandidate[];
}

export interface ParsedFeed {
  format: "rss" | "atom" | "unknown";
  title: string | null;
  link: string | null;
  items: RawFeedItem[];
}

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", ndash: "–", mdash: "—",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", sbquo: "‚", bdquo: "„",
  hellip: "…", bull: "•", middot: "·", copy: "©", reg: "®", trade: "™",
  laquo: "«", raquo: "»", rupee: "₹", sect: "§", para: "¶", deg: "°",
  prime: "′", Prime: "″", times: "×", eacute: "é", zwj: "‍", zwnj: "‌", thinsp: " ", ensp: " ", emsp: " ",
};

/** Decode XML/HTML character references (named subset, decimal, hex). Unknown names are left as written. */
export function decodeEntities(s: string): string {
  if (!s || s.indexOf("&") < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g, (m, ent: string) => {
    if (ent[0] === "#") {
      const code = ent[1] === "x" || ent[1] === "X" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return m;
      try { return String.fromCodePoint(code); } catch { return m; }
    }
    return NAMED[ent] ?? m;
  });
}

const CDATA_MARK = "\u0000C";

interface Prepared { xml: string; cdata: string[] }

function prepare(input: string): Prepared {
  const cdata: string[] = [];
  let xml = input.replace(/^﻿/, "");
  xml = xml.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_m, body: string) => { cdata.push(body); return `${CDATA_MARK}${cdata.length - 1}\u0000`; });
  xml = xml.replace(/<!--[\s\S]*?-->/g, "").replace(/<\?[\s\S]*?\?>/g, "").replace(/<!DOCTYPE[^>[]*(\[[\s\S]*?\])?\s*>/gi, "");
  return { xml, cdata };
}

/** Element text: CDATA verbatim, everything else entity-decoded once. */
function textOf(inner: string, p: Prepared): string {
  let out = "";
  const re = /\u0000C(\d+)\u0000/g;
  let last = 0;
  for (let m = re.exec(inner); m; m = re.exec(inner)) {
    out += decodeEntities(inner.slice(last, m.index));
    out += p.cdata[Number(m[1])] ?? "";
    last = m.index + m[0].length;
  }
  out += decodeEntities(inner.slice(last));
  return out;
}

function escapeName(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface El { attrs: Record<string, string>; inner: string }

function parseAttrs(s: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([A-Za-z_][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  for (let m = re.exec(s); m; m = re.exec(s)) attrs[m[1].toLowerCase()] = decodeEntities(m[3] ?? m[4] ?? "");
  return attrs;
}

/** All direct-or-nested elements named `name` (namespace prefix included in `name`, e.g. "dc:creator"). */
function elements(xml: string, name: string): El[] {
  const n = escapeName(name);
  const re = new RegExp(`<${n}((?:\\s[^>]*?)?)(\\/>|>([\\s\\S]*?)<\\/${n}\\s*>)`, "gi");
  const out: El[] = [];
  for (let m = re.exec(xml); m; m = re.exec(xml)) out.push({ attrs: parseAttrs(m[1] ?? ""), inner: m[3] ?? "" });
  return out;
}

function first(xml: string, names: string[], p: Prepared): string | null {
  for (const name of names) {
    const el = elements(xml, name)[0];
    if (el) { const t = textOf(el.inner, p).trim(); if (t) return t; }
  }
  return null;
}

function splitList(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of values) {
    for (const part of v.split(",")) {
      const t = part.replace(/\s+/g, " ").trim();
      if (t && !seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); out.push(t); }
    }
  }
  return out;
}

const posInt = (v: string | undefined) => { const n = v ? Number.parseInt(v, 10) : NaN; return Number.isFinite(n) && n > 0 ? n : undefined; };

/**
 * Image candidates named by the item markup (media:content incl. inside media:group, enclosure, media:thumbnail) plus
 * <img> elements in content:encoded and description. Non-image media (video/audio) is ignored.
 */
function imageCandidatesFrom(xml: string, content: string | null, description: string | null, base?: string): NewsImageCandidate[] {
  const out: NewsImageCandidate[] = [];
  const add = (c: NewsImageCandidate) => { if (!out.some((x) => x.url === c.url)) out.push(c); };
  const isImage = (a: Record<string, string>) => (!a.medium || a.medium === "image") && (!a.type || /^image\//i.test(a.type));
  const media = elements(xml, "media:content").filter((e) => e.attrs.url && isImage(e.attrs))
    .sort((a, b) => (posInt(b.attrs.width) ?? 0) - (posInt(a.attrs.width) ?? 0));
  for (const el of media) add({ url: el.attrs.url.trim(), origin: "media:content", width: posInt(el.attrs.width), height: posInt(el.attrs.height), type: el.attrs.type || undefined });
  for (const el of elements(xml, "enclosure")) if (el.attrs.url && (!el.attrs.type || /^image\//i.test(el.attrs.type))) add({ url: el.attrs.url.trim(), origin: "enclosure", type: el.attrs.type || undefined });
  for (const el of elements(xml, "media:thumbnail")) if (el.attrs.url) add({ url: el.attrs.url.trim(), origin: "media:thumbnail", width: posInt(el.attrs.width), height: posInt(el.attrs.height) });
  for (const c of htmlImageCandidates(content, "content-img", base)) add(c);
  for (const c of htmlImageCandidates(description, "description-img", base)) add(c);
  return out.slice(0, 8);
}

/** The feed's preferred image: the first candidate passing the cheap heuristic, else the first markup-declared one. */
function preferredImage(cands: NewsImageCandidate[]): string | null {
  const picked = pickImageCandidate(cands);
  if (picked) return picked.url;
  return cands.find((c) => c.origin === "media:content" || c.origin === "enclosure" || c.origin === "media:thumbnail")?.url ?? null;
}

/** Region matcher for repeated blocks (`item`, `entry`), tolerant of attributes. */
function blocks(xml: string, name: string): string[] {
  const n = escapeName(name);
  const re = new RegExp(`<${n}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${n}\\s*>`, "gi");
  const out: string[] = [];
  for (let m = re.exec(xml); m; m = re.exec(xml)) out.push(m[1]);
  return out;
}

function rssItem(x: string, p: Prepared): RawFeedItem {
  const guidEl = elements(x, "guid")[0];
  const guid = guidEl ? textOf(guidEl.inner, p).trim() || null : null;
  const guidIsPermaLink = guidEl ? (guidEl.attrs.ispermalink ? guidEl.attrs.ispermalink.toLowerCase() !== "false" : true) : null;
  let link = first(x, ["link"], p);
  if (!link) {
    const atomLink = elements(x, "atom:link").find((e) => !e.attrs.rel || e.attrs.rel === "alternate");
    link = atomLink?.attrs.href ?? null;
  }
  if (!link && guid && guidIsPermaLink && /^https?:\/\//i.test(guid)) link = guid;
  const authors = splitList([...elements(x, "dc:creator"), ...elements(x, "author")].map((e) => textOf(e.inner, p)));
  const description = first(x, ["description"], p);
  const content = first(x, ["content:encoded"], p);
  const imageCandidates = imageCandidatesFrom(x, content, description, link && /^https?:\/\//i.test(link) ? link : undefined);
  return {
    title: first(x, ["title"], p) ?? "",
    link,
    guid,
    guidIsPermaLink,
    date: first(x, ["pubDate", "dc:date", "published", "updated"], p),
    authors,
    categories: splitList(elements(x, "category").map((e) => textOf(e.inner, p))),
    tags: splitList(elements(x, "tags").map((e) => textOf(e.inner, p))),
    description,
    content,
    imageUrl: preferredImage(imageCandidates),
    imageCandidates,
  };
}

function atomEntry(x: string, p: Prepared): RawFeedItem {
  const links = elements(x, "link");
  const alt = links.find((e) => (e.attrs.rel ?? "alternate") === "alternate" && e.attrs.href) ?? links.find((e) => e.attrs.href);
  const authors = splitList(elements(x, "author").map((a) => first(a.inner, ["name"], p) ?? textOf(a.inner, p)));
  const cats = elements(x, "category").map((e) => e.attrs.term || e.attrs.label || textOf(e.inner, p));
  const enclosure = links.find((e) => e.attrs.rel === "enclosure" && /^image\//i.test(e.attrs.type ?? "") && e.attrs.href);
  const description = first(x, ["summary"], p);
  const content = first(x, ["content"], p);
  const imageCandidates = [
    ...(enclosure ? [{ url: enclosure.attrs.href.trim(), origin: "enclosure" as const, type: enclosure.attrs.type }] : []),
    ...imageCandidatesFrom(x, content, description, alt?.attrs.href).filter((c) => c.url !== enclosure?.attrs.href.trim()),
  ];
  return {
    title: first(x, ["title"], p) ?? "",
    link: alt?.attrs.href ?? null,
    guid: first(x, ["id"], p),
    guidIsPermaLink: null,
    date: first(x, ["published", "updated", "dc:date"], p),
    authors,
    categories: splitList(cats),
    tags: [],
    description,
    content,
    imageUrl: preferredImage(imageCandidates),
    imageCandidates,
  };
}

/** Parse an RSS 2.0 or Atom document. Never throws; an unrecognised document yields `format: "unknown"` and no items. */
export function parseFeed(input: string): ParsedFeed {
  const p = prepare(input ?? "");
  const xml = p.xml;
  if (/<rss[\s>]|<rdf:RDF[\s>]/i.test(xml)) {
    const channel = blocks(xml, "channel")[0] ?? xml;
    const head = channel.split(/<item[\s>]/i)[0];
    const items = blocks(xml, "item").map((x) => rssItem(x, p));
    return { format: "rss", title: first(head, ["title"], p), link: first(head, ["link"], p), items };
  }
  if (/<feed[\s>]/i.test(xml)) {
    const head = xml.split(/<entry[\s>]/i)[0];
    const items = blocks(xml, "entry").map((x) => atomEntry(x, p));
    const self = elements(head, "link").find((e) => (e.attrs.rel ?? "alternate") === "alternate");
    return { format: "atom", title: first(head, ["title"], p), link: self?.attrs.href ?? null, items };
  }
  return { format: "unknown", title: null, link: null, items: [] };
}
