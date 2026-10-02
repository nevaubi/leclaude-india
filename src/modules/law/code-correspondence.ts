/**
 * Statutes reader: the IPC ↔ BNS, CrPC ↔ BNSS and IEA ↔ BSA correspondence for the section being read (pure,
 * client-safe). The mapping comes only from the coded table in `@/lib/india/criminal-code-map`: every candidate is
 * kept (a split stays a split), a section absent from the table is "unmapped", and nothing is inferred from text.
 *
 * An instrument counts as one of the six codes only when it is Central legislation whose citation title is exactly the
 * code's title ("Indian Penal Code, 1860"); a similar title is not enough.
 */
import { CORRESPONDENCE_SOURCE, mapSection, NEW_CODES_IN_FORCE, type CodeName, type MapResult } from "@/lib/india/criminal-code-map";
import { normActTitle } from "./reader";
import { citationTitle, NO_SECTION, type LawInstrument } from "./shared";

/** Exact citation titles of the six codes (as India Code prints them). */
export const CRIMINAL_CODE_TITLES: Record<CodeName, string> = {
  IPC: "Indian Penal Code, 1860",
  BNS: "Bharatiya Nyaya Sanhita, 2023",
  CrPC: "Code of Criminal Procedure, 1973",
  BNSS: "Bharatiya Nagarik Suraksha Sanhita, 2023",
  IEA: "Indian Evidence Act, 1872",
  BSA: "Bharatiya Sakshya Adhiniyam, 2023",
};

const SHORT: Record<CodeName, string> = { IPC: "IPC", BNS: "BNS", CrPC: "CrPC", BNSS: "BNSS", IEA: "Evidence Act", BSA: "BSA" };

/** The code an instrument is, by exact Central title; null for anything else. */
export function criminalCodeOf(i: Pick<LawInstrument, "title" | "year" | "jurisdiction">): CodeName | null {
  if (i.jurisdiction !== "central") return null;
  const t = normActTitle(citationTitle(i));
  for (const [code, title] of Object.entries(CRIMINAL_CODE_TITLES) as [CodeName, string][]) if (normActTitle(title) === t) return code;
  return null;
}

export interface CorrespondenceTarget {
  code: CodeName;
  /** As coded, possibly with a sub-section ("318(4)"). */
  section: string;
  /** The section key to open in the reader ("318"): the number without its sub-section. */
  readerSection: string;
  /** "BNS s.318(4)". */
  label: string;
  note?: string;
}

export interface SectionCorrespondence {
  from: { code: CodeName; section: string };
  direction: MapResult["direction"];
  status: MapResult["status"];
  /** The other code and its exact title (the one to resolve in the corpus). */
  otherCode: CodeName;
  otherTitle: string;
  targets: CorrespondenceTarget[];
  subject: string | null;
  confidence: MapResult["confidence"] | null;
  notes: string[];
  source: string;
  /** One plain sentence for the heading line. */
  headline: string;
}

const OTHER: Record<CodeName, CodeName> = { IPC: "BNS", CrPC: "BNSS", IEA: "BSA", BNS: "IPC", BNSS: "CrPC", BSA: "IEA" };

/** "1 July 2024" from NEW_CODES_IN_FORCE. */
function inForceText(): string {
  const [y, m, d] = NEW_CODES_IN_FORCE.split("-").map(Number);
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  return `${d} ${months[m - 1]} ${y}`;
}

/** The 2023 code that repealed each old code, and its repeal-and-savings section. */
const REPEALED_BY: Partial<Record<CodeName, { code: CodeName; section: string }>> = {
  IPC: { code: "BNS", section: "358" },
  CrPC: { code: "BNSS", section: "531" },
  IEA: { code: "BSA", section: "170" },
};

export interface CodeRepeal {
  code: CodeName;
  /** "1 July 2024". */
  on: string;
  /** One sentence for the status badge's explanation. */
  note: string;
}

/**
 * For the IPC, CrPC and Indian Evidence Act (by exact Central title), the repeal by the 2023 codes from 1 July 2024;
 * null for every other instrument. The repeal is coded, so it holds even when the dataset still records the code in force.
 */
export function codeRepeal(i: Pick<LawInstrument, "title" | "year" | "jurisdiction">): CodeRepeal | null {
  const code = criminalCodeOf(i);
  const by = code ? REPEALED_BY[code] : undefined;
  if (!code || !by) return null;
  const on = inForceText();
  return {
    code,
    on,
    note: `The ${CRIMINAL_CODE_TITLES[code]} was repealed from ${on} by the ${CRIMINAL_CODE_TITLES[by.code]} (s.${by.section}, repeal and savings). It still governs matters that its savings provision preserves; check the official text and which code applies on the dates.`,
  };
}

/**
 * The correspondence for one section of an instrument, or null when the instrument is not one of the six codes or the
 * key is the unnumbered text. Unmapped sections are returned (status "unmapped", no targets) so the reader can say so.
 */
export function sectionCorrespondence(i: Pick<LawInstrument, "title" | "year" | "jurisdiction">, section: string): SectionCorrespondence | null {
  const code = criminalCodeOf(i);
  if (!code || !section || section === NO_SECTION) return null;
  const r = mapSection(code, section);
  const otherCode = OTHER[code];
  const targets: CorrespondenceTarget[] = r.candidates.map((c) => ({
    code: c.code,
    section: c.section,
    readerSection: c.section.replace(/\(.*$/, ""),
    label: `${SHORT[c.code]} s.${c.section}`,
    ...(c.note ? { note: c.note } : {}),
  }));
  const old = r.direction === "old_to_new";
  const headline = r.status === "unmapped"
    ? old
      ? `Not in the coded correspondence table: consult the ${CRIMINAL_CODE_TITLES[otherCode]}.`
      : `Not in the coded correspondence table: it may be a new provision with no ${SHORT[otherCode]} counterpart, or an uncoded row.`
    : old
      ? `Replaced from ${inForceText()} by the ${CRIMINAL_CODE_TITLES[otherCode]}${r.status === "split" ? ", split across several provisions" : ""}.`
      : `Corresponds to the ${CRIMINAL_CODE_TITLES[otherCode]} (repealed from ${inForceText()})${r.status === "split" ? ", which spread it across several provisions" : ""}.`;
  return {
    from: { code, section: r.query.section },
    direction: r.direction,
    status: r.status,
    otherCode,
    otherTitle: CRIMINAL_CODE_TITLES[otherCode],
    targets,
    subject: r.subject ?? null,
    confidence: r.confidence ?? null,
    notes: r.notes,
    source: r.source || CORRESPONDENCE_SOURCE,
    headline,
  };
}
