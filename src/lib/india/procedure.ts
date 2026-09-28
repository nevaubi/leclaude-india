/**
 * Indian court procedure vocabulary (client-safe, deterministic).
 *
 * - Case-type registry for the Supreme Court and the focus High Courts (Karnataka, Telangana, Andhra Pradesh) and
 *   subordinate civil courts, with alias parsing ("W.P.", "WP", "Writ Petition") and canonical case numbers.
 * - Exhibit marking (Ex.P1, Ex.D1, Ex.C1, Ex.X1, MO-1) and witness numbering (PW-1, DW-1, CW-1).
 * - Examination stages and the usual stages of a civil suit and a criminal trial.
 *
 * Only vocabulary and provisions the maintainers are confident of are coded; `basis` cites the provision that
 * founds the proceeding. Naming conventions differ between registries; `usedIn` lists where a label is in use.
 */

export type CaseCategory = "writ" | "civil" | "criminal" | "appeal_civil" | "appeal_criminal" | "revision" | "review" | "transfer" | "contempt" | "original" | "tribunal";

export interface CaseType {
  id: string;
  /** Canonical abbreviation used when formatting ("W.P.", "Crl.P."). */
  abbr: string;
  name: string;
  /** Other spellings; dots, spaces and case are handled by the parser. */
  aliases: string[];
  category: CaseCategory;
  /** Court ids (registry) or "subordinate" where the label is used. */
  usedIn: string[];
  /** Provision(s) the proceeding is ordinarily founded on. */
  basis?: string[];
  notes?: string;
}

const HC_FOCUS = ["hc-karnataka", "hc-telangana", "hc-andhra"];

export const CASE_TYPES: CaseType[] = [
  // Supreme Court
  { id: "slp-c", abbr: "S.L.P. (C)", name: "Special Leave Petition (Civil)", aliases: ["S.L.P.(C)", "S.L.P.(Civil)", "Special Leave Petition (Civil)"], category: "appeal_civil", usedIn: ["sci"], basis: ["Constitution of India, Art. 136"] },
  { id: "slp-crl", abbr: "S.L.P. (Crl.)", name: "Special Leave Petition (Criminal)", aliases: ["S.L.P.(Crl.)", "S.L.P.(Crl)", "S.L.P.(Criminal)", "Special Leave Petition (Criminal)"], category: "appeal_criminal", usedIn: ["sci"], basis: ["Constitution of India, Art. 136"] },
  { id: "slp", abbr: "S.L.P.", name: "Special Leave Petition (civil/criminal not stated)", aliases: ["Special Leave Petition"], category: "appeal_civil", usedIn: ["sci"], basis: ["Constitution of India, Art. 136"], notes: "Side (civil/criminal) not stated in the source." },
  { id: "sc-ca", abbr: "C.A.", name: "Civil Appeal", aliases: ["Civil Appeal"], category: "appeal_civil", usedIn: ["sci"] },
  { id: "crl-a", abbr: "Crl.A.", name: "Criminal Appeal", aliases: ["Crl.Appeal", "Criminal Appeal", "Cri.A."], category: "appeal_criminal", usedIn: ["sci", ...HC_FOCUS], basis: ["CrPC s.374 / BNSS s.415", "CrPC s.378 / BNSS s.419 (against acquittal)"] },
  { id: "wp-c-sc", abbr: "W.P. (C)", name: "Writ Petition (Civil)", aliases: ["W.P.(C)", "W.P.(Civil)", "Writ Petition (Civil)"], category: "writ", usedIn: ["sci", "hc-delhi"], basis: ["Constitution of India, Art. 32 (Supreme Court)", "Art. 226 (High Court)"] },
  { id: "wp-crl", abbr: "W.P. (Crl.)", name: "Writ Petition (Criminal)", aliases: ["W.P.(Crl.)", "W.P.(Crl)", "W.P.(Criminal)", "Writ Petition (Criminal)"], category: "writ", usedIn: ["sci", "hc-delhi"], basis: ["Constitution of India, Art. 32 / Art. 226"] },
  { id: "tp-c", abbr: "T.P. (C)", name: "Transfer Petition (Civil)", aliases: ["T.P.(C)", "T.P.(Civil)", "Transfer Petition (Civil)"], category: "transfer", usedIn: ["sci"], basis: ["CPC s.25"] },
  { id: "tp-crl", abbr: "T.P. (Crl.)", name: "Transfer Petition (Criminal)", aliases: ["T.P.(Crl.)", "T.P.(Crl)", "Transfer Petition (Criminal)"], category: "transfer", usedIn: ["sci"], basis: ["CrPC s.406 / BNSS s.446"] },
  { id: "review", abbr: "R.P.", name: "Review Petition", aliases: ["Review Petition", "Rev.P."], category: "review", usedIn: ["sci", ...HC_FOCUS], basis: ["Constitution of India, Art. 137 (Supreme Court)", "CPC s.114 and Order XLVII"] },
  { id: "contempt-c", abbr: "Cont.P. (C)", name: "Contempt Petition (Civil)", aliases: ["Cont.P.(C)", "Contempt Petition (Civil)", "Con.P.(C)"], category: "contempt", usedIn: ["sci", ...HC_FOCUS], basis: ["Constitution of India, Arts. 129 and 215", "Contempt of Courts Act, 1971"] },
  { id: "contempt-crl", abbr: "Cont.P. (Crl.)", name: "Contempt Petition (Criminal)", aliases: ["Cont.P.(Crl.)", "Cont.P.(Crl)", "Contempt Petition (Criminal)"], category: "contempt", usedIn: ["sci", ...HC_FOCUS], basis: ["Constitution of India, Arts. 129 and 215", "Contempt of Courts Act, 1971"] },
  // High Courts
  { id: "wp-pil", abbr: "W.P. (PIL)", name: "Writ Petition (Public Interest Litigation)", aliases: ["W.P.(PIL)", "W.P.PIL", "PIL"], category: "writ", usedIn: HC_FOCUS, basis: ["Constitution of India, Art. 226"] },
  { id: "wp", abbr: "W.P.", name: "Writ Petition", aliases: ["Writ Petition", "W.P.No"], category: "writ", usedIn: ["sci", ...HC_FOCUS], basis: ["Constitution of India, Arts. 226 and 227"] },
  { id: "wa", abbr: "W.A.", name: "Writ Appeal", aliases: ["Writ Appeal"], category: "appeal_civil", usedIn: HC_FOCUS, basis: ["Karnataka High Court Act, 1961, s.4 (Karnataka)", "Letters Patent, cl. 15 (Telangana and Andhra Pradesh)"] },
  { id: "crl-p", abbr: "Crl.P.", name: "Criminal Petition", aliases: ["Crl.Petition", "Criminal Petition", "Crl.P.No", "Cri.P."], category: "criminal", usedIn: HC_FOCUS, basis: ["CrPC ss.438, 439, 482 / BNSS ss.482, 483, 528"] },
  { id: "crl-rp", abbr: "Crl.R.P.", name: "Criminal Revision Petition", aliases: ["Criminal Revision Petition", "Crl.Rev.P.", "Crl.R.C.", "Criminal Revision Case"], category: "revision", usedIn: HC_FOCUS, basis: ["CrPC ss.397, 401 / BNSS ss.438, 442"], notes: "Karnataka uses Crl.R.P.; Crl.R.C. is used in some other registries. Label per court registry." },
  { id: "rsa", abbr: "R.S.A.", name: "Regular Second Appeal", aliases: ["Regular Second Appeal"], category: "appeal_civil", usedIn: ["hc-karnataka"], basis: ["CPC s.100"] },
  { id: "sa", abbr: "S.A.", name: "Second Appeal", aliases: ["Second Appeal"], category: "appeal_civil", usedIn: ["hc-telangana", "hc-andhra"], basis: ["CPC s.100"] },
  { id: "rfa", abbr: "R.F.A.", name: "Regular First Appeal", aliases: ["Regular First Appeal"], category: "appeal_civil", usedIn: ["hc-karnataka"], basis: ["CPC s.96"] },
  { id: "as", abbr: "A.S.", name: "Appeal Suit (first appeal)", aliases: ["Appeal Suit"], category: "appeal_civil", usedIn: ["hc-telangana", "hc-andhra", "subordinate"], basis: ["CPC s.96"] },
  { id: "mfa", abbr: "M.F.A.", name: "Miscellaneous First Appeal", aliases: ["Miscellaneous First Appeal", "Misc.First Appeal"], category: "appeal_civil", usedIn: ["hc-karnataka"], basis: ["CPC s.104 and Order XLIII", "Motor Vehicles Act, 1988, s.173"] },
  { id: "cma", abbr: "C.M.A.", name: "Civil Miscellaneous Appeal", aliases: ["Civil Miscellaneous Appeal"], category: "appeal_civil", usedIn: ["hc-telangana", "hc-andhra"], basis: ["CPC s.104 and Order XLIII", "Motor Vehicles Act, 1988, s.173"] },
  { id: "crp", abbr: "C.R.P.", name: "Civil Revision Petition", aliases: ["Civil Revision Petition"], category: "revision", usedIn: HC_FOCUS, basis: ["CPC s.115"] },
  // Subordinate courts and tribunals
  { id: "os", abbr: "O.S.", name: "Original Suit", aliases: ["Original Suit"], category: "original", usedIn: ["subordinate"], basis: ["CPC s.26 and Order IV"] },
  { id: "oa", abbr: "O.A.", name: "Original Application", aliases: ["Original Application"], category: "tribunal", usedIn: ["tribunal"], notes: "Tribunal original application (e.g. Administrative Tribunals, Debts Recovery Tribunals); the statute depends on the tribunal." },
  { id: "cc", abbr: "C.C.", name: "Criminal Case (calendar case)", aliases: ["Criminal Case"], category: "criminal", usedIn: ["subordinate"], notes: "Magistrate's case number after cognizance, incl. NI Act s.138 complaints; label varies by district." },
  { id: "sc-case", abbr: "S.C.", name: "Sessions Case", aliases: ["Sessions Case", "S.C.No"], category: "criminal", usedIn: ["subordinate"] },
  { id: "ep", abbr: "E.P.", name: "Execution Petition", aliases: ["Execution Petition", "Ex.Pet."], category: "civil", usedIn: ["subordinate"], basis: ["CPC s.38 and Order XXI"] },
];

const byId = new Map(CASE_TYPES.map((t) => [t.id, t]));
export function caseTypeById(id: string): CaseType | null { return byId.get(id) ?? null; }

/** Collapse an alias to its key: letters and parenthesised qualifiers only, upper case ("W. P. (Crl.)" → "WP(CRL)"). */
export function caseTypeKey(s: string): string {
  return s.toUpperCase().replace(/NO\.?$/, "").replace(/[.\s]/g, "").replace(/\((CIVIL)\)/, "(C)").replace(/\((CRIMINAL|CRI)\)/, "(CRL)");
}

const byKey = new Map<string, CaseType>();
for (const t of CASE_TYPES) for (const a of [t.abbr, ...t.aliases]) {
  const k = caseTypeKey(a);
  if (!byKey.has(k)) byKey.set(k, t);
}

/** Resolve a case-type label ("WP", "W.P.", "Writ Petition", "S.L.P.(C)"). Unknown labels return null (never guessed). */
export function resolveCaseType(label: string): CaseType | null {
  return byKey.get(caseTypeKey(label)) ?? null;
}

/**
 * Regex source for one alias: canonical upper-case letters match upper case only (so prose "as 12 of 2019" is not
 * an "A.S."), lower-case letters match either case ("Crl" ↔ "CRL"); dots and spaces are optional.
 */
function aliasPattern(alias: string): string {
  let out = "";
  for (const ch of alias.replace(/No\.?$/, "")) {
    if (/[A-Z]/.test(ch)) out += ch;
    else if (/[a-z]/.test(ch)) out += `[${ch}${ch.toUpperCase()}]`;
    else if (ch === ".") out += "\\.?\\s*";
    else if (ch === " ") out += "\\s*";
    else if (ch === "(") out += "\\s*\\(\\s*";
    else if (ch === ")") out += "\\s*\\)";
    else if (ch === "&") out += "&";
  }
  return out;
}

const ALIAS_SOURCES = [...new Set(CASE_TYPES.flatMap((t) => [t.abbr, ...t.aliases]))].sort((a, b) => b.length - a.length).map(aliasPattern);
/** Case number: TYPE [No.|Nos.] NUMBER (of|/) YEAR [(SUBJECT-CODE)]. */
export const CASE_NUMBER_SOURCE = `(?<![A-Za-z])(${ALIAS_SOURCES.join("|")})\\s*\\.?\\s*(?:[Nn][Oo][Ss]?\\.?\\s*)?(\\d{1,7})\\s*(?:of|OF|/)\\s*((?:19|20)\\d{2})(?!\\d)(?:\\s*\\(\\s*([A-Z]{1,6}(?:\\s*-\\s*[A-Z]{1,6})*)\\s*\\))?`;

export interface ParsedCaseNumber {
  raw: string;
  caseType: CaseType;
  number: number;
  year: number;
  /** Karnataka subject classification suffix, e.g. "GM-RES", "LB-RES". */
  subject?: string;
  /** Canonical form: "W.P. No. 12345 of 2023 (GM-RES)". */
  canonical: string;
}

export function formatCaseNumber(t: CaseType, number: number, year: number, subject?: string): string {
  return `${t.abbr} No. ${number} of ${year}${subject ? ` (${subject})` : ""}`;
}

/** Parse one case number. Unknown case types and malformed numbers return null. */
export function parseCaseNumber(raw: string): ParsedCaseNumber | null {
  const m = new RegExp(`^\\s*${CASE_NUMBER_SOURCE}\\s*$`).exec(raw);
  if (!m) return null;
  const t = resolveCaseType(m[1]);
  if (!t) return null;
  const number = Number(m[2]), year = Number(m[3]);
  if (!number) return null;
  const subject = m[4]?.replace(/\s+/g, "");
  return { raw, caseType: t, number, year, subject, canonical: formatCaseNumber(t, number, year, subject) };
}

/* ───────────────────────────── Exhibits and witnesses ───────────────────────────── */

/**
 * Exhibit series. P = plaintiff / prosecution, D = defendant / defence, C = court, X = document marked for
 * identification or confronted but not proved through the witness (practice varies by court), MO = material object
 * (criminal trials). Sub-markings ("Ex.P1(a)") identify a portion such as a signature.
 */
export type ExhibitSeries = "P" | "D" | "C" | "X" | "MO";

export interface ExhibitMark { raw: string; series: ExhibitSeries; number: number; sub?: string; canonical: string }

export const EXHIBIT_SERIES_LABEL: Record<ExhibitSeries, string> = {
  P: "Plaintiff / prosecution exhibit",
  D: "Defendant / defence exhibit",
  C: "Court exhibit",
  X: "Marked for identification (not proved)",
  MO: "Material object",
};

export function formatExhibit(series: ExhibitSeries, number: number, sub?: string): string {
  return series === "MO" ? `MO-${number}${sub ? `(${sub})` : ""}` : `Ex.${series}${number}${sub ? `(${sub})` : ""}`;
}

const EXHIBIT_RE = /^\s*(?:(?:Ex(?:h(?:ibit)?)?\.?\s*-?\s*([PDCX])\s*-?\s*(\d{1,4}))|(?:M\.?\s*O\.?\s*-?\s*(\d{1,4})))\s*(?:\(\s*([a-z]{1,3}|\d{1,2})\s*\))?\s*$/i;

export function parseExhibit(raw: string): ExhibitMark | null {
  const m = EXHIBIT_RE.exec(raw);
  if (!m) return null;
  const series = (m[1] ? m[1].toUpperCase() : "MO") as ExhibitSeries;
  const number = Number(m[2] ?? m[3]);
  if (!number) return null;
  const sub = m[4]?.toLowerCase();
  return { raw, series, number, sub, canonical: formatExhibit(series, number, sub) };
}

/** PW = prosecution / plaintiff witness, DW = defence / defendant witness, CW = court witness. */
export type WitnessSide = "PW" | "DW" | "CW";
export interface WitnessMark { raw: string; side: WitnessSide; number: number; canonical: string }

export function formatWitness(side: WitnessSide, number: number): string { return `${side}-${number}`; }

export function parseWitness(raw: string): WitnessMark | null {
  const m = /^\s*([PDC])\.?\s*W\.?\s*-?\s*(\d{1,4})\s*$/i.exec(raw);
  if (!m || !Number(m[2])) return null;
  const side = `${m[1].toUpperCase()}W` as WitnessSide;
  return { raw, side, number: Number(m[2]), canonical: formatWitness(side, Number(m[2])) };
}

/** Next unused number in a series ("Ex.P" after P1..P7 → 8). Exhibits within a series are numbered consecutively. */
export function nextNumber(existing: { number: number }[]): number {
  return existing.reduce((m, e) => Math.max(m, e.number), 0) + 1;
}

/* ───────────────────────────── Examination and stages ───────────────────────────── */

export type ExaminationStage = "chief" | "cross" | "re_examination";

/** Indian Evidence Act, 1872, s.137 / Bharatiya Sakshya Adhiniyam, 2023, s.142 define the three examinations; s.138 IEA / s.143 BSA fixes their order. */
export const EXAMINATION_STAGES: { id: ExaminationStage; label: string; note?: string }[] = [
  { id: "chief", label: "Examination-in-chief", note: "In civil suits, ordinarily by affidavit (CPC Order XVIII Rule 4)." },
  { id: "cross", label: "Cross-examination" },
  { id: "re_examination", label: "Re-examination", note: "Confined to matters referred to in cross-examination unless the court permits a new matter." },
];

export interface CaseStage { id: string; label: string; basis?: string }

export const CIVIL_SUIT_STAGES: CaseStage[] = [
  { id: "institution", label: "Institution of suit / registration", basis: "CPC s.26, Order IV" },
  { id: "summons", label: "Issue and service of summons", basis: "CPC Order V" },
  { id: "written_statement", label: "Written statement", basis: "CPC Order VIII Rule 1" },
  { id: "issues", label: "Framing of issues", basis: "CPC Order XIV" },
  { id: "plaintiff_evidence", label: "Plaintiff's evidence", basis: "CPC Order XVIII" },
  { id: "defendant_evidence", label: "Defendant's evidence", basis: "CPC Order XVIII" },
  { id: "arguments", label: "Arguments", basis: "CPC Order XVIII Rule 2" },
  { id: "judgment", label: "Judgment and decree", basis: "CPC Order XX" },
  { id: "execution", label: "Execution", basis: "CPC Order XXI" },
];

export const CRIMINAL_TRIAL_STAGES: CaseStage[] = [
  { id: "fir", label: "FIR / information", basis: "CrPC s.154 / BNSS s.173" },
  { id: "investigation", label: "Investigation", basis: "CrPC Chapter XII / BNSS Chapter XIII" },
  { id: "final_report", label: "Final report (charge sheet)", basis: "CrPC s.173 / BNSS s.193" },
  { id: "cognizance", label: "Cognizance", basis: "CrPC s.190 / BNSS s.210" },
  { id: "appearance", label: "Appearance of accused" },
  { id: "charge", label: "Framing of charge / discharge" },
  { id: "prosecution_evidence", label: "Prosecution evidence" },
  { id: "accused_statement", label: "Statement of accused", basis: "CrPC s.313 / BNSS s.351" },
  { id: "defence_evidence", label: "Defence evidence" },
  { id: "arguments", label: "Arguments" },
  { id: "judgment", label: "Judgment" },
];
