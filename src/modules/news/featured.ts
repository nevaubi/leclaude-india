import type { NewsListItem } from "./types";

/**
 * Front-page arrangement: the lead is the newest of the first six headlines that has an approved image (else the
 * newest); three side stories and four grid cards follow; everything else stays in the chronological list. Search
 * results are not featured (relevance and recency would be confused).
 */
export function pickFeatured(items: NewsListItem[], feature: boolean): { lead: NewsListItem | null; side: NewsListItem[]; grid: NewsListItem[]; rest: NewsListItem[] } {
  if (!feature || items.length < 5) return { lead: null, side: [], grid: [], rest: items };
  const lead = items.slice(0, 6).find((i) => i.image) ?? items[0];
  const others = items.filter((i) => i !== lead);
  const side = others.slice(0, 3);
  const pool = others.slice(3);
  const grid = pool.length >= 8 ? pool.slice(0, 4) : [];
  const used = new Set([lead, ...side, ...grid].map((i) => i.id));
  return { lead, side, grid, rest: items.filter((i) => !used.has(i.id)) };
}
