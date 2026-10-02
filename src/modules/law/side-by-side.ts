/**
 * Side-by-side view of an old-code section and its new-code counterpart(s) (IPC | BNS, CrPC | BNSS, IEA | BSA): pure,
 * client-safe model built from the official concordance data (`mapSection`) and the coded transition rules.
 *
 * The two columns are always "old code" on the left and "new code" on the right, whichever side the reader came from.
 * Only provisions the concordance names are shown opposite; nothing is matched by heading or text.
 */
import { mapSection, type MapResult, type OfficialRowRef } from "@/lib/india/criminal-code-map";
import { transitionRuleFor, type TransitionRule } from "@/lib/india/concordance/transition";
import { CRIMINAL_CODE_TITLES, criminalCodeOf } from "./code-correspondence";
import { NO_SECTION, type LawInstrument } from "./shared";
import type { CodeName } from "@/lib/india/criminal-code-map";

const OLD: CodeName[] = ["IPC", "CrPC", "IEA"];
const SHORT: Record<CodeName, string> = { IPC: "IPC", BNS: "BNS", CrPC: "CrPC", BNSS: "BNSS", IEA: "Evidence Act", BSA: "BSA" };

export interface CompareProvision {
  code: CodeName;
  /** As the concordance prints it ("103(1)"). */
  section: string;
  /** Section key to open in the reader ("103"). */
  readerSection: string;
  /** Sub-section anchor in the reader, when the concordance names one ("ss-1"). */
  anchor: string | null;
  label: string;
  /** Part named by the table ("Explanation", "proviso"). */
  note: string | null;
  /** True for the provision the reader is on. */
  current: boolean;
}

export interface CompareColumn {
  code: CodeName;
  title: string;
  provisions: CompareProvision[];
}

export interface SideBySideModel {
  /** The code of the page the reader is on, and its section. */
  from: { code: CodeName; section: string };
  old: CompareColumn;
  next: CompareColumn;
  status: MapResult["status"];
  verification: MapResult["verification"] | null;
  partial: boolean;
  newProvision: boolean;
  confidence: MapResult["confidence"] | null;
  notes: string[];
  official: OfficialRowRef[];
  officialSource: MapResult["officialSource"] | null;
  transition: TransitionRule | null;
  /** One plain sentence for the header. */
  headline: string;
}

const readerKey = (s: string) => s.replace(/\(.*$/, "");

/** "103(1)" → "ss-1"; "2(1)(a)" → "ss-1"; "498A" → null. Matches the reader's sub-section anchors. */
export function subsectionAnchor(section: string): string | null {
  const m = /^\d+[A-Z]*\((\d+[A-Za-z]?)\)/.exec(section);
  return m ? `ss-${m[1].toLowerCase()}` : null;
}

function provision(code: CodeName, section: string, note: string | null, current: boolean): CompareProvision {
  return { code, section, readerSection: readerKey(section), anchor: subsectionAnchor(section), label: `${SHORT[code]} s.${section}`, note, current };
}

/** The side-by-side model for a section of one of the six codes; null for any other instrument or the unnumbered text. */
export function sideBySide(i: Pick<LawInstrument, "title" | "year" | "jurisdiction">, section: string): SideBySideModel | null {
  const code = criminalCodeOf(i);
  if (!code || !section || section === NO_SECTION) return null;
  const r = mapSection(code, section);
  const isOld = OLD.includes(code);
  const here = provision(code, r.query.section, null, true);
  const others = r.candidates.map((c) => provision(c.code, c.section, c.note ?? null, false));
  const otherCode: CodeName = isOld ? (({ IPC: "BNS", CrPC: "BNSS", IEA: "BSA" }) as Record<string, CodeName>)[code] : (({ BNS: "IPC", BNSS: "CrPC", BSA: "IEA" }) as Record<string, CodeName>)[code];
  const old: CompareColumn = isOld ? { code, title: CRIMINAL_CODE_TITLES[code], provisions: [here] } : { code: otherCode, title: CRIMINAL_CODE_TITLES[otherCode], provisions: others };
  const next: CompareColumn = isOld ? { code: otherCode, title: CRIMINAL_CODE_TITLES[otherCode], provisions: others } : { code, title: CRIMINAL_CODE_TITLES[code], provisions: [here] };
  const headline = r.newProvision
    ? `${SHORT[code]} s.${r.query.section} is a new provision: the official table names no ${SHORT[otherCode]} counterpart.`
    : r.status === "unmapped"
      ? `No counterpart for ${SHORT[code]} s.${r.query.section} in the official correspondence table or the coded table.`
      : `${SHORT[code]} s.${r.query.section} ↔ ${others.map((o) => o.label).join(", ")}${r.status === "split" ? " (split across several provisions)" : ""}.`;
  return {
    from: { code, section: r.query.section },
    old, next,
    status: r.status,
    verification: r.verification ?? null,
    partial: Boolean(r.partial),
    newProvision: Boolean(r.newProvision),
    confidence: r.confidence ?? null,
    notes: r.notes,
    official: r.official ?? [],
    officialSource: r.officialSource ?? null,
    transition: transitionRuleFor(code),
    headline,
  };
}

/** Plain label for a mapping's verification state (never stronger than the data). */
export function verificationLabel(v: SideBySideModel["verification"]): string {
  switch (v) {
    case "official_cross_checked": return "Official table, cross-checked";
    case "official_parsed": return "Official table (machine-read)";
    case "coded_unconfirmed": return "Coded table only";
    case "conflicts_official": return "Conflicts with the official table";
    case "requires_review": return "Requires review";
    default: return "Not mapped";
  }
}
