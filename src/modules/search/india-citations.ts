/**
 * Indian citation style adapter for research output (memo, table of authorities, evidence titles, reader, exports).
 * Client-safe.
 *
 * Parsing and formatting come from the citation engine (`@/lib/india/citations`, `@/lib/india/citation-style`,
 * `@/lib/india/statutes`); this module maps research hits onto its `CaseAuthority` / statute references.
 *
 * Style (neutral citation first, then the preferred reporter, joined with " : "):
 *   case, reported:   "Arnesh Kumar v. State of Bihar, (2014) 8 SCC 273"
 *   case, unreported: "X v. Y (W.P. No. 1234 of 2023, High Court of Karnataka, decided on 12 March 2024)"
 *   statute:          "Section 103 of the Bharatiya Nyaya Sanhita, 2023"
 * Nothing is invented: when the engine cannot format a citation (unparseable string, court mismatch) the corpus record
 * is shown as recorded and marked "[citation not verified]" with the reason.
 */
import { courtById } from "@/lib/india/courts";
import { extractCitations as parseIndianCitations } from "@/lib/india/citations";
import { formatCaseCitation, formatIndianDate, type CaseAuthority, type FormattedCitation } from "@/lib/india/citation-style";
import { formatStatuteRef, parseStatuteRef } from "@/lib/india/statutes";
import type { SearchHit } from "./types";

/** "2024-03-12" → "12 March 2024" (Indian date style); other strings are returned unchanged. */
export function indianDate(iso?: string | null): string {
  const d = (iso ?? "").slice(0, 10);
  return (d && formatIndianDate(d)) || (iso ?? "");
}

/** Court label for a hit: registry short name, else the unresolved raw code, else the provider's text. */
export function hitCourtLabel(hit: Pick<SearchHit, "courtId" | "court" | "india">): string {
  const c = courtById(hit.india?.courtId ?? hit.courtId ?? undefined);
  if (c) return c.shortName === "SC" ? "SC" : c.shortName;
  if (hit.india?.unresolvedCourt) return `court code ${hit.india.unresolvedCourt} (unresolved)`;
  return hit.court ?? "";
}

export function benchLabel(n?: number): string {
  return n ? `${n}-judge bench` : "";
}

/** Citations of a judgment in preferred order: neutral first, then reporters (SCC before others), de-duplicated. */
export function judgmentCitations(hit: Pick<SearchHit, "cite" | "citations" | "india">): string[] {
  const reporters = [...(hit.india?.reporterCitations ?? []), ...(hit.citations ?? []), ...(hit.cite ? [hit.cite] : [])];
  const rank = (c: string) => (/\bSCC\b(?!\s*OnLine)/.test(c) ? 0 : /\bSCR\b/.test(c) ? 1 : /\bAIR\b/.test(c) ? 2 : /SCC OnLine/.test(c) ? 4 : 3);
  const neutral = hit.india?.neutralCitation;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of [neutral, ...[...reporters].sort((a, b) => rank(a) - rank(b))]) {
    if (!c) continue;
    const k = c.replace(/\s+/g, " ").trim().toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c.replace(/\s+/g, " ").trim());
  }
  return out;
}

/** The research hit as a citation-engine authority (identity from the corpus; nothing inferred). */
export function hitAuthority(hit: SearchHit): CaseAuthority {
  const neutral = hit.india?.neutralCitation;
  const reporters = judgmentCitations(hit).filter((c) => c !== neutral);
  return { id: hit.india?.judgmentId ?? hit.id, caseName: hit.title, neutral, reporters, courtId: hit.india?.courtId ?? hit.courtId ?? undefined, caseNumber: hit.india?.caseNumber ?? hit.docketNumber, decisionDate: hit.date?.slice(0, 10) };
}

export function formatJudgmentFull(hit: SearchHit, opts: { pinpoint?: number | number[] } = {}): FormattedCitation {
  return formatCaseCitation(hitAuthority(hit), { pinpoint: opts.pinpoint });
}

/** Full Indian-style citation for a judgment hit (the engine's format; the corpus record, marked, when it cannot be formatted). */
export function formatJudgmentCitation(hit: SearchHit): string {
  const f = formatJudgmentFull(hit);
  if (f.citation) return f.citation;
  const cites = judgmentCitations(hit);
  const body = cites.length ? cites.join(" : ") : hit.india?.caseNumber ?? hit.docketNumber ?? "";
  return `${hit.title}${body ? `, ${body}` : ""} [citation not verified: ${f.errors.join("; ") || "no citable form"}]`.replace(/\s+/g, " ").trim();
}

/** Indian statutory citation through the statute registry ("Section 482 of the Bharatiya Nagarik Suraksha Sanhita, 2023"); raw form when the Act is not in the registry. */
export function formatStatuteCitation(input: { enactment: string; year?: number | string; sections?: string[] }): string {
  const secs = (input.sections ?? []).filter(Boolean);
  const act = input.year && !new RegExp(`${input.year}\\s*$`).test(input.enactment) ? `${input.enactment}, ${input.year}` : input.enactment;
  if (secs.length) {
    const ref = parseStatuteRef(`${secs.length > 1 ? "Sections" : "Section"} ${secs.join(", ")} of the ${act}`) ?? parseStatuteRef(`Section ${secs[0]} of ${act}`);
    const formatted = ref ? formatStatuteRef(ref, "full") : null;
    if (formatted && secs.length === 1) return formatted;
  }
  return secs.length ? `${act}, ${secs.length > 1 ? "ss." : "s."} ${secs.join(", ")}` : act;
}

export function formatStatuteHit(hit: SearchHit): string {
  // Statutes-corpus hits carry their own citation (Section / Rule / Regulation as the instrument numbers them).
  if (hit.india?.provider === "open-india-law" && hit.cite) return hit.cite;
  if (hit.india?.enactment) return formatStatuteCitation({ enactment: hit.india.enactment, sections: hit.india.section ? [hit.india.section] : [] });
  return hit.cite ?? hit.title;
}

/** Short form for inline use: first party + first citation ("Arnesh Kumar, (2014) 8 SCC 273"). */
export function shortJudgmentCite(hit: SearchHit): string {
  const short = hit.title.split(/\s+v(?:s)?\.?\s+/i)[0]?.split(",")[0]?.trim() || hit.title;
  const first = judgmentCitations(hit)[0];
  return first ? `${short}, ${first}` : short;
}

export interface AnswerCitation { citation: string; kind: "case"; index: number }

/**
 * Case citations in an answer (neutral and reporter forms), parsed by the shared Indian parser. Unknown forms are not
 * returned (they cannot be cross-checked); statutes and case numbers are ignored here.
 */
export function extractAnswerCitations(text: string): AnswerCitation[] {
  let parsed: ReturnType<typeof parseIndianCitations> = [];
  try { parsed = parseIndianCitations(text ?? ""); } catch { parsed = []; }
  const out: AnswerCitation[] = [];
  const seen = new Set<string>();
  for (const p of parsed) {
    if (p.kind !== "neutral" && p.kind !== "reporter") continue;
    const citation = (p.raw ?? "").replace(/\s+/g, " ").trim();
    if (!citation || seen.has(citation)) continue;
    seen.add(citation);
    out.push({ citation, kind: "case", index: p.start ?? text.indexOf(p.raw) });
  }
  return out.sort((a, b) => a.index - b.index);
}

/** Normalised comparison key for a citation ("(2017) 10 SCC 1" → "(2017)10scc1"). */
export function citationCompareKey(c: string): string {
  return c.replace(/,\s*(?:para(?:graph)?s?\.?\s*)?\d{1,5}(?:[-–]\d{1,5})?\s*$/i, "").replace(/[\s.]+/g, "").trim().toLowerCase();
}
