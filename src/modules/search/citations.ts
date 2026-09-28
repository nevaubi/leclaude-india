/**
 * Offline citation extraction used by the citation checker and the research engine's citation cross-check.
 * LeClaude India: Indian neutral and reporter citations come from the shared deterministic parser
 * (src/modules/search/india-citations.ts → @/lib/india/citations); the US regexes remain for US material. Client-safe.
 */
import { extractAnswerCitations } from "./india-citations";

export type ExtractedCitationKind = "case" | "statute" | "regulation" | "register" | "unknown";

export interface ExtractedCitation {
  citation: string;
  kind: ExtractedCitationKind;
  index: number;
  /** Context around the citation for display. */
  context: string;
  /** Where a public copy can be looked up. */
  lookupUrl?: string;
}

const REPORTERS = [
  "U\\.S\\.", "S\\. ?Ct\\.", "L\\. ?Ed\\. ?(?:2d)?", "F\\.(?: ?2d| ?3d| ?4th)?", "F\\. ?Supp\\.(?: ?2d| ?3d)?", "F\\. ?App'x", "Fed\\. ?Appx\\.", "F\\.R\\.D\\.", "B\\.R\\.",
  "Cal\\.(?: ?2d| ?3d| ?4th| ?5th)?", "Cal\\. ?App\\.(?: ?2d| ?3d| ?4th| ?5th)?", "Cal\\. ?Rptr\\.(?: ?2d| ?3d)?", "P\\.(?: ?2d| ?3d)?", "N\\.E\\.(?: ?2d| ?3d)?", "N\\.W\\.(?: ?2d| ?3d)?", "S\\.E\\.(?: ?2d| ?3d)?", "S\\.W\\.(?: ?2d| ?3d)?", "So\\.(?: ?2d| ?3d)?", "A\\.(?: ?2d| ?3d)?", "N\\.Y\\.(?: ?2d| ?3d)?", "N\\.Y\\.S\\.(?: ?2d| ?3d)?", "Ill\\.(?: ?2d)?", "Ill\\. ?App\\.(?: ?3d)?", "Ill\\. ?Dec\\.", "Tex\\.", "Del\\.", "WL",
];

const CASE_RE = new RegExp(`\\b(\\d{1,4})\\s+(${REPORTERS.join("|")})\\s+(\\d{1,5})(?:,\\s*\\d{1,5}(?:[-–]\\d{1,5})?)?\\b`, "g");
const USC_RE = /\b(\d{1,2})\s+U\.?\s?S\.?\s?C\.?\s*(?:§+|section)?\s*([\d]+[a-z]?(?:[-–][\d]+[a-z]?)?(?:\([\w]+\))*)/gi;
const CFR_RE = /\b(\d{1,2})\s+C\.?\s?F\.?\s?R\.?\s*(?:§+|part|section)?\s*([\d]+(?:\.[\d]+)?(?:\([\w]+\))*)/gi;
const FR_RE = /\b(\d{1,3})\s+Fed\.?\s+Reg\.?\s+([\d,]+)/gi;

function ctx(text: string, start: number, end: number, radius = 60) {
  const s = Math.max(0, start - radius), e = Math.min(text.length, end + radius);
  return `${s > 0 ? "…" : ""}${text.slice(s, e).replace(/\s+/g, " ")}${e < text.length ? "…" : ""}`;
}

export function extractCitations(text: string): ExtractedCitation[] {
  const out: ExtractedCitation[] = [];
  const seen = new Set<string>();
  const push = (c: ExtractedCitation) => { const k = c.citation.replace(/\s+/g, " "); if (seen.has(k)) return; seen.add(k); out.push({ ...c, citation: k }); };
  for (const c of extractAnswerCitations(text)) {
    push({ citation: c.citation, kind: "case", index: c.index, context: ctx(text, Math.max(0, c.index), Math.max(0, c.index) + c.citation.length), lookupUrl: `https://indiankanoon.org/search/?formInput=${encodeURIComponent(`"${c.citation}"`)}` });
  }
  let m: RegExpExecArray | null;
  CASE_RE.lastIndex = 0;
  while ((m = CASE_RE.exec(text))) {
    const citation = m[0].trim();
    push({ citation, kind: "case", index: m.index, context: ctx(text, m.index, m.index + m[0].length), lookupUrl: `https://www.courtlistener.com/c/${encodeURIComponent(m[2].replace(/\s+/g, " "))}/${m[1]}/${m[3]}/` });
  }
  USC_RE.lastIndex = 0;
  while ((m = USC_RE.exec(text))) {
    const sec = m[2].split("(")[0];
    push({ citation: `${m[1]} U.S.C. § ${m[2]}`, kind: "statute", index: m.index, context: ctx(text, m.index, m.index + m[0].length), lookupUrl: `https://uscode.house.gov/view.xhtml?req=granuleid:USC-prelim-title${m[1]}-section${sec}&num=0&edition=prelim` });
  }
  CFR_RE.lastIndex = 0;
  while ((m = CFR_RE.exec(text))) {
    const sec = m[2].split("(")[0];
    push({ citation: `${m[1]} C.F.R. § ${m[2]}`, kind: "regulation", index: m.index, context: ctx(text, m.index, m.index + m[0].length), lookupUrl: sec.includes(".") ? `https://www.ecfr.gov/current/title-${m[1]}/section-${sec}` : `https://www.ecfr.gov/current/title-${m[1]}/part-${sec}` });
  }
  FR_RE.lastIndex = 0;
  while ((m = FR_RE.exec(text))) {
    push({ citation: `${m[1]} Fed. Reg. ${m[2]}`, kind: "register", index: m.index, context: ctx(text, m.index, m.index + m[0].length), lookupUrl: `https://www.federalregister.gov/citation/${m[1]}-FR-${m[2].replace(/,/g, "")}` });
  }
  return out.sort((a, b) => a.index - b.index);
}
