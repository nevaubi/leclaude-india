/**
 * Indian litigation vocabulary for the case-records workspace (client-safe, pure, unit-tested).
 *
 * The review engine (search, coding, batches, productions) is jurisdiction-neutral. This module adds what an Indian
 * trial record needs on top of it:
 *
 *  - exhibit marks as courts record them: Ex.P1 / Ex.D1 / Ex.C1 in Karnataka and most States, Ex.A1 / Ex.B1 for the
 *    plaintiff / defendant in Andhra Pradesh and Telangana civil courts, Ex.R1 for respondents, Ex.X1 for documents
 *    marked through a witness in cross-examination, M.O.1 for material objects; sub-marks such as Ex.P5(a);
 *  - witness designations: PW-1 (plaintiff / prosecution), DW-1 (defendant / defence), CW-1 (court witness),
 *    RW-1 (respondent), AW-1 (applicant / petitioner);
 *  - the document classes of a court file (pleadings, affidavits, interlocutory applications, exhibits, depositions,
 *    orders and daily order sheets);
 *  - privilege wording under the Bharatiya Sakshya Adhiniyam, 2023 (ss.132–134) and the Indian Evidence Act, 1872
 *    (ss.126–129).
 *
 * Evidence contract (constitution §23): an exhibit mark resolves only to the document that carries exactly that mark
 * in the same matter. Ex.P1 never matches Ex.P12, Ex.P1(a) is a different mark from Ex.P1, and an unmarked or unknown
 * exhibit stays `unresolved` — it is never mapped to the nearest mark, the first document or another matter's record.
 */
import type { EDocument } from "@/lib/types/domain";
import type { LocaleCode, TranslationOrigin } from "@/lib/india/languages";
import { EXHIBIT_SERIES_LABEL, EXAMINATION_STAGES, formatExhibit, parseExhibit, parseWitness, type ExaminationStage, type ExhibitSeries } from "@/lib/india/procedure";

// ---------------------------------------------------------------------------
// Exhibit marks (built on the procedure registry in src/lib/india/procedure.ts)
// ---------------------------------------------------------------------------

/**
 * Series a mark belongs to. P, D, C, X and MO come from the procedure registry (`ExhibitSeries`). A and B are the
 * plaintiff's / defendant's series in Andhra Pradesh and Telangana civil courts (Ex.A1 / Ex.B1) and R is used for
 * respondents in some petitions; the registry does not code them yet, so they are parsed here with the same format.
 */
export type ExhibitSide = ExhibitSeries | "A" | "B" | "R";

export const EXHIBIT_SIDES: { id: ExhibitSide; label: string; hint: string }[] = [
  { id: "P", label: "Ex.P", hint: EXHIBIT_SERIES_LABEL.P },
  { id: "D", label: "Ex.D", hint: EXHIBIT_SERIES_LABEL.D },
  { id: "C", label: "Ex.C", hint: EXHIBIT_SERIES_LABEL.C },
  { id: "X", label: "Ex.X", hint: EXHIBIT_SERIES_LABEL.X },
  { id: "MO", label: "MO", hint: EXHIBIT_SERIES_LABEL.MO },
  { id: "A", label: "Ex.A", hint: "Plaintiff's exhibits (Andhra Pradesh and Telangana civil courts)" },
  { id: "B", label: "Ex.B", hint: "Defendant's exhibits (Andhra Pradesh and Telangana civil courts)" },
  { id: "R", label: "Ex.R", hint: "Respondent's exhibits" },
];

export interface ExhibitMark {
  side: ExhibitSide;
  number: number;
  /** Sub-mark: Ex.P5(a) → "a". */
  sub?: string;
  /** Canonical form: "Ex.P5", "Ex.P5(a)", "MO-3" (the registry's format). */
  canonical: string;
  raw: string;
}

/** Ex.A / Ex.B / Ex.R marks (not in the registry). */
const EXTRA_RE = /^\s*Ex(?:h(?:ibit)?)?\.?\s*-?\s*([ABR])\s*-?\s*(\d{1,4})\s*(?:\(\s*([a-z]{1,3}|\d{1,2})\s*\))?\s*$/i;
/** Bare "P25" / "D-12" (only accepted with `allowBare`, e.g. the second half of "Ex.P1 to P25"). */
const BARE_RE = /^\s*([PDCXABR])\s*-?\s*(\d{1,4})\s*(?:\(\s*([a-z]{1,3})\s*\))?\s*$/i;
/** "Ex.P5a" (sub-mark without brackets), normalised to "Ex.P5(a)" before parsing. */
const LETTER_SUB_RE = /^(\s*Ex(?:h(?:ibit)?)?\.?\s*-?\s*[PDCXABR]\s*-?\s*\d{1,4})([a-z])\s*$/i;

export function formatExhibitMark(side: ExhibitSide, number: number, sub?: string): string {
  if (side === "A" || side === "B" || side === "R") return `Ex.${side}${number}${sub ? `(${sub.toLowerCase()})` : ""}`;
  return formatExhibit(side, number, sub?.toLowerCase());
}

/**
 * Parse an exhibit mark: "Ex.P1", "Ex. P-1", "Exh.D12", "Exhibit P5(a)", "Ex.P5a", "M.O.3", "MO-3", "Ex.A4". Returns
 * null when the text is not an exhibit mark (never a guess).
 */
export function parseExhibitMark(raw: string, opts: { allowBare?: boolean } = {}): ExhibitMark | null {
  if (typeof raw !== "string" || raw.length > 40) return null;
  const text = raw.replace(LETTER_SUB_RE, "$1($2)");
  const reg = parseExhibit(text);
  if (reg) return { side: reg.series, number: reg.number, ...(reg.sub ? { sub: reg.sub } : {}), canonical: reg.canonical, raw };
  const m = text.match(EXTRA_RE) ?? (opts.allowBare ? text.match(BARE_RE) : null);
  if (!m) return null;
  const side = m[1].toUpperCase() as ExhibitSide;
  const number = Number(m[2]);
  if (!number) return null;
  const sub = m[3]?.toLowerCase();
  return { side, number, ...(sub ? { sub } : {}), canonical: formatExhibitMark(side, number, sub), raw };
}

/** Canonical form of a mark, or null. */
export function canonicalExhibit(raw: string | null | undefined): string | null {
  return raw ? parseExhibitMark(raw)?.canonical ?? null : null;
}

const SIDE_ORDER: ExhibitSide[] = ["P", "A", "D", "B", "R", "C", "X", "MO"];

/** Order: side (P, A, D, B, R, C, X, MO), then number, then sub-mark (Ex.P5 before Ex.P5(a) before Ex.P6). */
export function compareExhibitMarks(a: string, b: string): number {
  const pa = parseExhibitMark(a);
  const pb = parseExhibitMark(b);
  if (!pa || !pb) return pa ? -1 : pb ? 1 : a.localeCompare(b);
  return SIDE_ORDER.indexOf(pa.side) - SIDE_ORDER.indexOf(pb.side) || pa.number - pb.number || (pa.sub ?? "").localeCompare(pb.sub ?? "");
}

/**
 * Parse a range of marks: "Ex.P1 to Ex.P25", "Ex.P1 to P25", "Ex.P1–P25", "Ex.D1-D18". Both ends must be the same
 * side; a range never spans sides. Returns null when either end is not a mark.
 */
export function parseExhibitRange(raw: string): { side: ExhibitSide; from: number; to: number } | null {
  const m = raw.match(/^\s*(.+?)\s*(?:–|—|to|-(?=\s*(?:Ex|[PDCABRX]\s*\d)))\s*(.+?)\s*$/i);
  if (!m) {
    const single = parseExhibitMark(raw);
    return single && !single.sub ? { side: single.side, from: single.number, to: single.number } : null;
  }
  const a = parseExhibitMark(m[1]);
  const b = parseExhibitMark(m[2], { allowBare: true });
  if (!a || !b || a.side !== b.side || a.sub || b.sub) return null;
  return { side: a.side, from: Math.min(a.number, b.number), to: Math.max(a.number, b.number) };
}

export function exhibitInRange(mark: string, range: { side: ExhibitSide; from: number; to: number }): boolean {
  const p = parseExhibitMark(mark);
  return !!p && p.side === range.side && p.number >= range.from && p.number <= range.to;
}

/** Every exhibit mark mentioned in free text (testimony, orders, pleadings), in order of first appearance, deduplicated. */
export function findExhibitMarks(text: string): string[] {
  const out: string[] = [];
  const re = /\b(?:Exh?(?:ibit)?\.?\s*(?:No\.?\s*)?[PDCABRX]\s*-?\s*\d{1,4}(?:\s*\([a-z]{1,3}\))?|M\.?\s?O\.?\s?-?\s?\d{1,4})(?![\d])/gi;
  for (const m of text.matchAll(re)) {
    const c = canonicalExhibit(m[0]);
    if (c && !out.includes(c)) out.push(c);
  }
  return out;
}

export type ExhibitResolution =
  | { status: "resolved"; mark: string; docId: string }
  | { status: "unresolved"; mark: string; reason: "not_a_mark" | "not_marked_in_matter" | "marked_twice" };

/**
 * Resolve an exhibit mark against the documents of ONE matter. Exact canonical match only. Two documents carrying the
 * same mark is a record defect and is reported (`marked_twice`), never silently resolved to one of them.
 */
export function resolveExhibit(mark: string, docs: readonly Pick<IndiaEDocument, "id" | "matterId" | "india">[], matterId: string): ExhibitResolution {
  const c = canonicalExhibit(mark);
  if (!c) return { status: "unresolved", mark, reason: "not_a_mark" };
  const hits = docs.filter((d) => d.matterId === matterId && canonicalExhibit(d.india?.exhibit) === c);
  if (hits.length === 1) return { status: "resolved", mark: c, docId: hits[0].id };
  return { status: "unresolved", mark: c, reason: hits.length ? "marked_twice" : "not_marked_in_matter" };
}

// ---------------------------------------------------------------------------
// Witness designations
// ---------------------------------------------------------------------------

/** PW / DW / CW come from the procedure registry; RW (respondent) and AW (applicant / petitioner) are used in some petitions. */
export type WitnessSide = "PW" | "DW" | "CW" | "RW" | "AW";

export const WITNESS_SIDES: { id: WitnessSide; label: string }[] = [
  { id: "PW", label: "Plaintiff / prosecution witness" },
  { id: "DW", label: "Defendant / defence witness" },
  { id: "CW", label: "Court witness" },
  { id: "RW", label: "Respondent's witness" },
  { id: "AW", label: "Applicant / petitioner's witness" },
];

export interface WitnessDesignation { side: WitnessSide; number: number; canonical: string }

/** "PW-1", "P.W.1", "PW 1", "D.W.-2" → { side, number, canonical "PW-1" }. */
export function parseWitnessDesignation(raw: string | null | undefined): WitnessDesignation | null {
  if (!raw) return null;
  const reg = parseWitness(raw.replace(/\.(?=\s*-)/, ""));
  if (reg) return { side: reg.side, number: reg.number, canonical: reg.canonical };
  const m = raw.match(/^\s*([RA])\.?\s*W\.?\s*[-.]?\s*(\d{1,3})\s*$/i);
  if (!m || !Number(m[2])) return null;
  const side = `${m[1].toUpperCase()}W` as WitnessSide;
  return { side, number: Number(m[2]), canonical: `${side}-${Number(m[2])}` };
}

// ---------------------------------------------------------------------------
// Document classes of an Indian court file
// ---------------------------------------------------------------------------

export type IndianDocClass =
  | "pleading"        // plaint, written statement, replication, writ petition, counter-affidavit, complaint
  | "affidavit"       // affidavits in lieu of chief-examination, verifying affidavits, affidavits of documents
  | "application"     // interlocutory applications (I.A.), memos
  | "exhibit"         // a document admitted and marked in evidence
  | "document"        // a document produced / disclosed but not (yet) marked
  | "deposition"      // deposition sheet of a witness
  | "order"           // orders on applications, judgments
  | "order_sheet"     // daily order sheet / proceedings
  | "notice"          // statutory and legal notices (s.80 CPC, s.138 NI Act, summons)
  | "correspondence"  // emails, letters, WhatsApp exports between the parties
  | "translation";    // a translation of another document in the record

export const DOC_CLASSES: { id: IndianDocClass; label: string }[] = [
  { id: "pleading", label: "Pleading" },
  { id: "affidavit", label: "Affidavit" },
  { id: "application", label: "Application / memo" },
  { id: "exhibit", label: "Marked exhibit" },
  { id: "document", label: "Document (unmarked)" },
  { id: "deposition", label: "Deposition" },
  { id: "order", label: "Order / judgment" },
  { id: "order_sheet", label: "Order sheet" },
  { id: "notice", label: "Notice" },
  { id: "correspondence", label: "Correspondence" },
  { id: "translation", label: "Translation" },
];

export function docClassLabel(c: IndianDocClass | undefined): string {
  return DOC_CLASSES.find((x) => x.id === c)?.label ?? "Document";
}

/** Indian record metadata stored with a case-record document (`india` on the stored EDocument). */
export interface IndiaDocMeta {
  docClass: IndianDocClass;
  /** Canonical exhibit mark once the document is admitted and marked ("Ex.P7"). Absent until marked. */
  exhibit?: string;
  /** Witness through whom the exhibit was marked ("PW-1"). */
  markedThrough?: string;
  /** Date of marking (YYYY-MM-DD). */
  markedOn?: string;
  /** Marked subject to objection (admissibility / mode of proof reserved to the final hearing). */
  markedSubjectToObjection?: boolean;
  /** Document number in the list of documents / index filed with the pleading ("Doc. 14", "List I, item 3"). */
  docNumber?: string;
  /** Party that filed or produced it. */
  filedBy?: "plaintiff" | "defendant" | "petitioner" | "respondent" | "complainant" | "accused" | "state" | "court" | "third_party";
  /** Language of this text. The original-language document is the text of record. */
  language?: LocaleCode;
  /** For a translation: the document it translates, where the translation came from, and whether it is certified. */
  translationOf?: string;
  translationOrigin?: TranslationOrigin;
  /** Title of the pleading / application as filed ("I.A. No. 1 under Order XXXIX Rules 1 & 2 CPC"). */
  title?: string;
}

/** Stored case-record document with the Indian record metadata (the extra field round-trips through the db). */
export type IndiaEDocument = EDocument & { india?: IndiaDocMeta };

/** Short reference shown in tables: the exhibit mark when marked, else the document number, else the production number. */
export function displayReference(d: Pick<IndiaEDocument, "bates" | "india">): string {
  return d.india?.exhibit ?? d.india?.docNumber ?? d.bates;
}

/** Lowercased exhibit tokens for the search projection ("ex.p7 p7"); empty when unmarked. */
export function exhibitSearchKey(d: Pick<IndiaEDocument, "india">): string {
  const p = d.india?.exhibit ? parseExhibitMark(d.india.exhibit) : null;
  if (!p) return "";
  return `${p.canonical.toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// Examination segments (Indian deposition record)
// ---------------------------------------------------------------------------

/**
 * A civil witness's evidence is recorded as: examination-in-chief by affidavit (Order XVIII Rule 4 CPC), usually in
 * numbered paragraphs; cross-examination recorded by the court in Q/A form or in narrative ("It is true that…",
 * "It is false to suggest that…"); re-examination; and questions put by the court.
 */
export type ExamSegment = ExaminationStage | "court";

export const EXAM_SEGMENTS: { id: ExamSegment; label: string; short: string }[] = [
  ...EXAMINATION_STAGES.map((s) => ({ id: s.id as ExamSegment, label: s.label, short: s.id === "chief" ? "Chief" : s.id === "cross" ? "Cross" : "Re-exam" })),
  { id: "court", label: "Questions by the court", short: "Court" },
];

export function segmentLabel(s: ExamSegment | undefined): string {
  return EXAM_SEGMENTS.find((x) => x.id === s)?.label ?? "";
}

// ---------------------------------------------------------------------------
// Privilege (advocate–client communications)
// ---------------------------------------------------------------------------

/**
 * Privilege bases with Indian statutory wording. The stored ids stay the engine's ids so coding, logs and filters keep
 * working; only the labels and log legend change. BSA 2023 ss.132–134 correspond to IEA 1872 ss.126–129.
 */
export const INDIA_PRIVILEGE_LABELS: Record<"attorney-client" | "work-product" | "common-interest" | "joint-defense", string> = {
  "attorney-client": "Advocate–client communication (BSA s.132 / IEA s.126)",
  "work-product": "Confidential communication with legal adviser (BSA s.134 / IEA s.129)",
  "common-interest": "Common interest",
  "joint-defense": "Joint defence",
};

export const INDIA_PRIVILEGE_LEGEND = [
  "**Advocate–client communication** — communication made in confidence to or by an advocate in the course of and for the purpose of the advocate's employment by the client (Bharatiya Sakshya Adhiniyam, 2023, s.132; Indian Evidence Act, 1872, s.126). Protection extends to interpreters, clerks and staff of the advocate (IEA s.127).",
  "**Confidential communication with legal adviser** — the client cannot be compelled to disclose a confidential communication with its legal professional adviser unless the client offers himself as a witness and only to the extent necessary to explain evidence given (BSA s.134; IEA s.129).",
  "Communications made in furtherance of an illegal purpose, and facts observed showing a crime or fraud committed since the commencement of the employment, are not protected (proviso to BSA s.132 / IEA s.126).",
  "A lawyer who is merely copied on a business communication does not make it privileged; each entry states the legal purpose of the communication.",
];

/** Titles that identify a person as counsel in an Indian record (advocates, vakils, pleaders, legal advisers). */
export const INDIA_COUNSEL_TITLE_RE = /\b(advocate|vakil|pleader|legal\s+advis[eo]r|legal\s+counsel|general\s+counsel|law\s+officer|public\s+prosecutor|government\s+pleader|standing\s+counsel)\b/i;
