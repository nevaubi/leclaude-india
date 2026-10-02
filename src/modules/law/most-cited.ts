/**
 * Statutes landing, "Most-cited sections": pure helpers over GET /api/cases/sections (the citator's section heat).
 * Client-safe. Counts are judgments in the case-law collection whose text cites the section, found by the citation
 * parser over the judgments scanned so far; they never claim to be complete.
 */
import { getAct, type Act } from "@/lib/india/statutes";

export interface SectionStatsFilters { act: string; court: string; from: string; to: string }

export const EMPTY_SECTION_FILTERS: SectionStatsFilters = { act: "", court: "", from: "", to: "" };

const YEAR_RE = /^(18[6-9]\d|19\d\d|20\d\d|2100)$/;

/** Query string for /api/cases/sections; malformed years are left out (never sent), from/to are ordered. */
export function sectionStatsQuery(f: SectionStatsFilters, limit = 15): string {
  const sp = new URLSearchParams();
  if (f.act && getAct(f.act)) sp.set("act", f.act);
  if (f.court) sp.set("court", f.court);
  let from = YEAR_RE.test(f.from.trim()) ? Number(f.from.trim()) : null;
  let to = YEAR_RE.test(f.to.trim()) ? Number(f.to.trim()) : null;
  if (from != null && to != null && from > to) [from, to] = [to, from];
  if (from != null) sp.set("from", String(from));
  if (to != null) sp.set("to", String(to));
  sp.set("limit", String(Math.max(1, Math.min(50, Math.trunc(limit)))));
  return sp.toString();
}

/** A year input that is not empty and not a whole year between 1860 and 2100. */
export function badYear(v: string): boolean {
  return Boolean(v.trim()) && !YEAR_RE.test(v.trim());
}

/** Dense per-year series between the first and last year present (missing years are 0, never interpolated). */
export function yearSeries(byYear: { year: number; judgments: number }[]): { year: number; judgments: number }[] {
  const rows = byYear.filter((r) => Number.isInteger(r.year) && Number.isFinite(r.judgments));
  if (!rows.length) return [];
  const map = new Map<number, number>();
  for (const r of rows) map.set(r.year, (map.get(r.year) ?? 0) + r.judgments);
  const years = [...map.keys()].sort((a, b) => a - b);
  const out: { year: number; judgments: number }[] = [];
  for (let y = years[0]; y <= years[years.length - 1] && out.length < 300; y++) out.push({ year: y, judgments: map.get(y) ?? 0 });
  return out;
}

/** SVG polyline points for a sparkline of `series` in a w×h box (baseline at the bottom; y scaled to the max). */
export function sparkPoints(series: { judgments: number }[], w: number, h: number, pad = 1.5): string {
  if (!series.length) return "";
  const max = Math.max(1, ...series.map((s) => s.judgments));
  const step = series.length > 1 ? (w - pad * 2) / (series.length - 1) : 0;
  return series
    .map((s, i) => {
      const x = series.length > 1 ? pad + i * step : w / 2;
      const y = h - pad - (s.judgments / max) * (h - pad * 2);
      return `${round(x)},${round(y)}`;
    })
    .join(" ");
}

const round = (n: number) => Math.round(n * 10) / 10;

/** The citation title a citator act id resolves to in the statutes collection ("Indian Penal Code, 1860"); null for the Constitution and unknown ids. */
export function statuteTitleFor(actId: string): string | null {
  const a: Act | null = getAct(actId);
  if (!a || a.unit !== "section" || a.jurisdiction !== "central") return null;
  return `${a.name}, ${a.year}`;
}

/**
 * True when a citator section can be opened in the statutes reader: a plain section number with an optional letter
 * suffix ("302", "498A"). Order and rule references ("O.39 R.1"), sub-sections and anything else are shown unlinked,
 * so a link never lands on a "no such provision" page.
 */
export function linkableSection(section: string | null | undefined): boolean {
  return typeof section === "string" && /^\d+[A-Z]{0,3}$/.test(section);
}

/** True when the response says the citator tables do not exist yet. */
export function citatorNotBuilt(r: { sections: unknown[]; scannedJudgments: number; note: string }): boolean {
  return !r.sections.length && (r.scannedJudgments === 0 || /not been built/i.test(r.note));
}
