/**
 * "Judgments on this section" for the statutes reader: contracts and pure helpers (client-safe).
 *
 * A statutes-collection instrument is matched to the citation parser's coded Act only by exact citation title
 * ("Indian Penal Code, 1860" ↔ ipc); anything else has no judgment links rather than a guessed one. Links come from two
 * origins that are never merged into one claim: "text" (the judgment's full text cites the section; citator) and
 * "headnote" (the official headnote names the section; metadata only, used for judgments without text too).
 */
import { ACTS } from "@/lib/india/statutes";
import { normActTitle } from "./reader";
import { citationTitle, NO_SECTION, type LawInstrument } from "./shared";

/** The citator's coded Act id for an instrument (exact citation title, Central only), else null. */
export function citatorActFor(i: Pick<LawInstrument, "title" | "year" | "jurisdiction">): string | null {
  if (i.jurisdiction !== "central") return null;
  const t = normActTitle(citationTitle(i));
  const a = ACTS.find((x) => x.jurisdiction === "central" && x.unit === "section" && normActTitle(`${x.name}, ${x.year}`) === t);
  return a?.id ?? null;
}

/** A section key the links can be looked up by: a number with an optional letter suffix ("302", "498A"). */
export function linkableSectionKey(section: string | null | undefined): string | null {
  const s = (section ?? "").trim();
  return s && s !== NO_SECTION && /^\d{1,4}[A-Z]{0,3}$/i.test(s) ? s.toUpperCase() : null;
}

export interface InterpretingJudgment {
  id: string;
  title: string;
  courtId: string | null;
  decisionDate: string | null;
  citation: string | null;
  /** The judgment's full text is in the corpus. */
  textAvailable: boolean;
  /** Its full text cites the section (citator). */
  fromText: boolean;
  /** Its official headnote names the section (metadata). */
  fromHeadnote: boolean;
}

export interface InterpretingResponse {
  actId: string | null;
  section: string;
  state: "ok" | "not_built" | "not_applicable";
  /** Distinct judgments linked by either origin. */
  total: number;
  /** Of which: linked from full text; linked from the headnote only; with full text available. */
  fromText: number;
  headnoteOnly: number;
  textAvailable: number;
  judgments: InterpretingJudgment[];
  offset: number;
  hasMore: boolean;
  /** What the counts cover (scan progress), in one sentence. */
  coverage: string;
  note: string | null;
}
