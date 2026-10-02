/**
 * Authority citation strings in text (client-safe, deterministic): neutral (Supreme Court "2024 INSC 735", High Court
 * "2025:AHC-LKO:18131"), SCR, SCC (and its sub-series), SCC OnLine, AIR, Cri LJ and the other coded reporters.
 *
 * A thin, typed layer over the shared parser (`extractCitations` in ./citations): one row per distinct authority string
 * with its format family and canonical key. Used by
 *   - answer verification (every authority string in an answer must resolve to a corpus record), and
 *   - "cited by" counts over judgment text (how many judgments' text carries the citation).
 * Nothing is guessed: a string the parser does not recognise is not returned; an invalid one is returned with
 * `valid: false` and its issues, so callers can show it as unresolved.
 */
import { extractCitations, type ParsedCitation } from "./citations";

export type CitationFormat = "neutral_sc" | "neutral_hc" | "scr" | "scc" | "scc_online" | "air" | "cri_lj" | "other_reporter";

export interface AuthorityCitation {
  /** As printed. */
  raw: string;
  /** Canonical form from the parser ("(2014) 8 SCC 273", "2024 INSC 735"). */
  normalized: string;
  /** Letters and digits only, upper case (the comparison key the citator uses). */
  key: string;
  format: CitationFormat;
  year?: number;
  /** Registry court when certain from the citation itself (SCC/SCR/INSC → sci; a HC neutral prefix → that court). */
  courtId?: string;
  valid: boolean;
  issues: string[];
  start: number;
  end: number;
}

export const compactCitationKey = (s: string) => s.replace(/[^A-Za-z0-9]/g, "").toUpperCase();

function formatOf(p: ParsedCitation): CitationFormat {
  if (p.kind === "neutral") return p.courtToken === "INSC" ? "neutral_sc" : "neutral_hc";
  const r = p.reporter ?? "";
  if (r === "SCR") return "scr";
  if (r === "SCC OnLine") return "scc_online";
  if (r.startsWith("SCC")) return "scc";
  if (r === "AIR") return "air";
  if (r === "Cri LJ") return "cri_lj";
  return "other_reporter";
}

/** Every distinct authority citation in `text`, left to right. Statutes, case numbers and CNRs are not returned. */
export function extractAuthorityCitations(text: string, opts: { now?: Date } = {}): AuthorityCitation[] {
  let parsed: ParsedCitation[] = [];
  try { parsed = extractCitations(text ?? "", { now: opts.now }); } catch { parsed = []; }
  const out: AuthorityCitation[] = [];
  const seen = new Set<string>();
  for (const p of parsed) {
    if (p.kind !== "neutral" && p.kind !== "reporter") continue;
    const raw = p.raw.replace(/\s+/g, " ").trim();
    const normalized = p.normalized ?? raw;
    const key = compactCitationKey(normalized);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ raw, normalized, key, format: formatOf(p), year: p.year, courtId: p.courtId, valid: p.valid, issues: p.issues, start: p.start ?? 0, end: p.end ?? 0 });
  }
  return out;
}

/** Count of citations per format (for eval reports). */
export function citationFormatCounts(list: AuthorityCitation[]): Record<CitationFormat, number> {
  const out: Record<CitationFormat, number> = { neutral_sc: 0, neutral_hc: 0, scr: 0, scc: 0, scc_online: 0, air: 0, cri_lj: 0, other_reporter: 0 };
  for (const c of list) out[c.format]++;
  return out;
}
