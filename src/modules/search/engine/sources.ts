/**
 * Source bookkeeping: dedupe/merge across lanes and rounds, provenance
 * mapping and prompt rendering. Pure and client-safe.
 */
import type { Provenance } from "@/lib/integrity/types";
import { formatBluebook } from "../normalize";
import type { SearchHit, SearchSource } from "../types";
import type { ResearchSource } from "./types";

const PROVENANCE_KIND: Record<SearchSource, Provenance["sources"][number]["kind"]> = {
  caselaw: "case-law", statutes: "regulation", regulations: "regulation", federal_register: "regulation", dockets: "docket", web: "web", library: "library", ediscovery: "document",
};

/** Stable key for a hit: prefer the provider id, fall back to a normalised URL, then the cite/title. */
export function sourceKey(hit: Pick<SearchHit, "id" | "url" | "cite" | "title" | "source">): string {
  // Provider ids are stable; index fallbacks ("caselaw:0", "web:3") and web hits key on the URL instead.
  if (hit.id && !/^web:/.test(hit.id) && !/:undefined$/.test(hit.id) && !(/:\d{1,2}$/.test(hit.id) && hit.url)) return hit.id;
  if (hit.url) return `${hit.source}:${normalizeUrl(hit.url)}`;
  return `${hit.source}:${(hit.cite ?? hit.title).toLowerCase().replace(/\s+/g, " ").trim()}`;
}

export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    for (const k of Array.from(u.searchParams.keys())) if (/^utm_|^ref$|^fbclid$/i.test(k)) u.searchParams.delete(k);
    return (u.host.replace(/^www\./, "") + u.pathname.replace(/\/$/, "") + (u.search || "")).toLowerCase();
  } catch { return url.toLowerCase(); }
}

export function scopeOf(source: SearchSource): ResearchSource["scope"] {
  if (source === "ediscovery") return "record";
  if (source === "library") return "internal";
  if (source === "web") return "web";
  return "authority";
}

export function sourceFromHit(hit: SearchHit, laneId: string, now = Date.now()): ResearchSource {
  return {
    id: sourceKey(hit),
    kind: hit.source,
    title: hit.title,
    cite: hit.cite ?? hit.edoc?.bates,
    url: hit.url,
    court: hit.courtId ?? hit.court,
    date: hit.date,
    authority: hit.authority,
    snippet: hit.snippet?.slice(0, 400),
    read: false,
    laneIds: [laneId],
    hit,
    scope: scopeOf(hit.source),
    foundAt: now,
  };
}

/** Merge `incoming` into `existing` in place semantics (returns a new array): same key → union lanes, keep read state/text stats, prefer the richer record. */
export function mergeSources(existing: ResearchSource[], incoming: ResearchSource[]): ResearchSource[] {
  const map = new Map<string, ResearchSource>();
  for (const s of existing) map.set(s.id, s);
  for (const s of incoming) {
    const cur = map.get(s.id);
    if (!cur) { map.set(s.id, { ...s, laneIds: Array.from(new Set(s.laneIds)) }); continue; }
    map.set(s.id, {
      ...cur,
      ...pickRicher(cur, s),
      n: cur.n ?? s.n,
      read: cur.read || s.read,
      chars: Math.max(cur.chars ?? 0, s.chars ?? 0) || undefined,
      readMs: cur.readMs ?? s.readMs,
      cached: cur.cached ?? s.cached,
      excerpt: cur.excerpt ?? s.excerpt,
      laneIds: Array.from(new Set([...cur.laneIds, ...s.laneIds])),
      foundAt: Math.min(cur.foundAt, s.foundAt),
    });
  }
  return Array.from(map.values());
}

function pickRicher(a: ResearchSource, b: ResearchSource): Partial<ResearchSource> {
  const out: Partial<ResearchSource> = {};
  for (const k of ["title", "cite", "url", "court", "date", "authority", "snippet"] as const) {
    const va = a[k], vb = b[k];
    if ((va == null || va === "" || va === "n/a") && vb) (out as Record<string, unknown>)[k] = vb;
  }
  if (!a.hit.readRef && b.hit.readRef) out.hit = b.hit;
  return out;
}

export function dedupeSources(sources: ResearchSource[]): ResearchSource[] {
  return mergeSources([], sources);
}

/**
 * Rank for synthesis: read first, then binding, then the Supreme Court before High Courts, then larger benches first
 * (deterministic from the corpus record), then by lane order/foundAt.
 */
export function rankSources(sources: ResearchSource[]): ResearchSource[] {
  const auth = (s: ResearchSource) => (s.authority === "binding" ? 0 : s.authority === "persuasive" ? 1 : 2);
  const sc = (s: ResearchSource) => ((s.hit.india?.courtId ?? s.hit.courtId) === "sci" ? 0 : 1);
  const bench = (s: ResearchSource) => s.hit.india?.benchStrength ?? 0;
  return [...sources].sort((a, b) => Number(b.read) - Number(a.read) || auth(a) - auth(b) || sc(a) - sc(b) || bench(b) - bench(a) || a.foundAt - b.foundAt);
}

/** Assign citation numbers (1-based) in rank order and return the cite map. */
export function numberSources(sources: ResearchSource[]): { sources: ResearchSource[]; citeMap: Record<number, string> } {
  const ranked = rankSources(sources);
  const citeMap: Record<number, string> = {};
  const out = ranked.map((s, i) => { citeMap[i + 1] = s.id; return { ...s, n: i + 1 }; });
  return { sources: out, citeMap };
}

export function toProvenanceSources(sources: ResearchSource[]): Provenance["sources"] {
  return sources.map((s) => ({ kind: PROVENANCE_KIND[s.kind], id: s.id, cite: s.cite ?? formatBluebook(s.hit), url: s.url, title: s.title }));
}

/** Strip anything the thread store should not keep (full hit payloads are fine; text never lives on the source). */
export function compactSource(s: ResearchSource): ResearchSource {
  return { ...s, snippet: s.snippet?.slice(0, 400), excerpt: s.excerpt?.slice(0, 600) };
}

/** Render numbered sources for a prompt: read sources carry their text (bounded), unread ones only the snippet. */
export function renderSourcesForPrompt(sources: ResearchSource[], texts: Map<string, string>, opts: { maxCharsPerSource?: number; maxTotalChars?: number } = {}): string {
  const perSource = opts.maxCharsPerSource ?? 7_000;
  const maxTotal = opts.maxTotalChars ?? 90_000;
  const lines: string[] = [];
  let total = 0;
  for (const s of sources) {
    const cite = formatBluebook(s.hit);
    const head = `[${s.n}] ${cite}${s.authority && s.authority !== "n/a" ? ` (${s.authority})` : ""}${s.scope === "record" ? " [MATTER RECORD]" : s.scope === "internal" ? " [FIRM LIBRARY]" : ""}${s.url ? ` ${s.url}` : ""}`;
    const text = s.read ? (texts.get(s.id) ?? s.excerpt ?? "") : "";
    const body = text ? text.slice(0, perSource) : `(not read — snippet only) ${s.snippet ?? ""}`;
    const block = `${head}\n${body}`;
    if (total + block.length > maxTotal) { lines.push(`${head}\n(text omitted for length)`); continue; }
    total += block.length;
    lines.push(block);
  }
  return lines.join("\n\n");
}
