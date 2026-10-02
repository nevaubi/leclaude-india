/**
 * Transition rules between the repealed criminal codes and the 2023 codes, as data (client-safe).
 *
 * Each rule names the date it turns on, the provision it rests on (repeal-and-savings sections of the 2023 codes and
 * Article 20(1) of the Constitution) and a plain statement of the rule. The statement paraphrases the provision; the
 * UI links the provision itself in the statutes reader so the reader can check the words. The deterministic decision
 * for a given date lives in `applicableCode` / `applicableEvidenceCode` (../criminal-code-map); these records are what
 * the UI shows beside a section.
 */
import { NEW_CODES_IN_FORCE } from "../criminal-code-map";
import type { NewCodeId, OldCodeId } from "./types";

export interface TransitionBasis {
  /** "BNSS", "BNS", "BSA" or "Constitution". */
  code: NewCodeId | "Constitution";
  /** Section or Article as printed ("531", "358", "170", "20"). */
  provision: string;
  /** The part relied on ("(2)(a)", "(1)"). */
  part?: string;
  label: string;
  /** Exact Central title used to open the provision in the reader (null: not in the statutes collection). */
  title: string | null;
}

export interface TransitionRule {
  id: "substantive" | "procedure" | "evidence";
  /** Codes on whose section pages the rule is shown. */
  codes: (OldCodeId | NewCodeId)[];
  /** What decides it ("Date of the offence", "Date the proceeding was pending / initiated"). */
  decidedBy: string;
  /** Commencement date of the 2023 codes (ISO). */
  on: string;
  /** One sentence for each side of the date. */
  before: string;
  onOrAfter: string;
  /** Points a practitioner must check (never resolved by the system). */
  caveats: string[];
  basis: TransitionBasis[];
}

export const TRANSITION_RULES: TransitionRule[] = [
  {
    id: "substantive",
    codes: ["IPC", "BNS"],
    decidedBy: "Date of the offence",
    on: NEW_CODES_IN_FORCE,
    before: "An offence committed before 1 July 2024 is governed by the Indian Penal Code, 1860, which BNS s.358 saves for offences committed against it.",
    onOrAfter: "An offence committed on or after 1 July 2024 is governed by the Bharatiya Nyaya Sanhita, 2023.",
    caveats: [
      "No conviction under a law not in force when the act was done, and no greater penalty than the law then in force (Constitution, Art. 20(1)).",
      "A continuing offence that spans 1 July 2024 needs review on the facts; the system does not decide it.",
    ],
    basis: [
      { code: "BNS", provision: "358", label: "BNS s.358 (repeal and savings)", title: "Bharatiya Nyaya Sanhita, 2023" },
      { code: "Constitution", provision: "20", part: "(1)", label: "Constitution, Art. 20(1)", title: null },
    ],
  },
  {
    id: "procedure",
    codes: ["CrPC", "BNSS"],
    decidedBy: "Whether the appeal, application, trial, inquiry or investigation was pending immediately before 1 July 2024",
    on: NEW_CODES_IN_FORCE,
    before: "An appeal, application, trial, inquiry or investigation pending immediately before 1 July 2024 continues under the Code of Criminal Procedure, 1973 (BNSS s.531(2)(a)).",
    onOrAfter: "A proceeding initiated on or after 1 July 2024 follows the Bharatiya Nagarik Suraksha Sanhita, 2023, even for an earlier offence.",
    caveats: ["How s.531 applies to proceedings initiated after 1 July 2024 for earlier offences has been litigated; check current authority before filing."],
    basis: [{ code: "BNSS", provision: "531", part: "(2)(a)", label: "BNSS s.531(2)(a) (repeal and savings)", title: "Bharatiya Nagarik Suraksha Sanhita, 2023" }],
  },
  {
    id: "evidence",
    codes: ["IEA", "BSA"],
    decidedBy: "Whether the proceeding was pending immediately before 1 July 2024",
    on: NEW_CODES_IN_FORCE,
    before: "A proceeding pending immediately before 1 July 2024 is dealt with under the Indian Evidence Act, 1872 (BSA s.170).",
    onOrAfter: "A proceeding initiated on or after 1 July 2024 follows the Bharatiya Sakshya Adhiniyam, 2023.",
    caveats: ["Confirm against the text of BSA s.170 for the kind of proceeding."],
    basis: [{ code: "BSA", provision: "170", part: "(2)", label: "BSA s.170 (repeal and savings)", title: "Bharatiya Sakshya Adhiniyam, 2023" }],
  },
];

/** The rule shown on a section page of `code`; null for codes outside the six. */
export function transitionRuleFor(code: string): TransitionRule | null {
  return TRANSITION_RULES.find((r) => (r.codes as string[]).includes(code)) ?? null;
}
