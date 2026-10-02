/**
 * Transition-law note for the 1 July 2024 change of criminal codes (client-safe, deterministic; data, not a prompt).
 *
 * Two independent questions, two dates:
 *   - substantive law follows the date of the OFFENCE: before 1 July 2024 → IPC (saved by BNS s.358); on or after → BNS;
 *   - procedure follows the PROCEEDING: an appeal, application, trial, inquiry or investigation pending immediately
 *     before 1 July 2024 continues under the CrPC (BNSS s.531(2)(a)); one instituted on or after that date runs under
 *     the BNSS, even for an earlier offence (how s.531 applies to such cases has been litigated: review).
 *   - evidence: BSA s.170 repeals the Indian Evidence Act with savings for pending proceedings.
 *
 * The provisions are coded below with their wording paraphrased conservatively and marked for verification against the
 * Gazette text. A date the question does not state is never assumed: the note says it is needed.
 */
import { applicableCode, NEW_CODES_IN_FORCE } from "./criminal-code-map";
import { compareIso, isValidIsoDate } from "./holidays";

export interface SavingsProvision {
  code: "BNS" | "BNSS" | "BSA";
  section: string;
  repeals: "IPC" | "CrPC" | "IEA";
  /** What the provision does (paraphrase; verify against the Gazette text before filing). */
  rule: string;
  /** What it decides in a transition question. */
  decides: "substantive" | "procedure" | "evidence";
}

/** The repeal-and-savings provisions of the three new codes. */
export const SAVINGS_PROVISIONS: readonly SavingsProvision[] = [
  { code: "BNS", section: "358", repeals: "IPC", decides: "substantive", rule: "BNS s.358 repeals the Indian Penal Code, 1860; s.358(2) saves anything done, and any liability, penalty or punishment incurred, under the IPC, and proceedings in respect of them continue as if the IPC had not been repealed. An offence committed before 1 July 2024 is therefore charged and punished under the IPC (see also Art. 20(1) of the Constitution)." },
  { code: "BNSS", section: "531", repeals: "CrPC", decides: "procedure", rule: "BNSS s.531 repeals the Code of Criminal Procedure, 1973; under s.531(2)(a) any appeal, application, trial, inquiry or investigation pending immediately before 1 July 2024 is disposed of, continued, held or made under the CrPC as in force before that date. A proceeding instituted on or after 1 July 2024 is governed by the BNSS." },
  { code: "BSA", section: "170", repeals: "IEA", decides: "evidence", rule: "BSA s.170 repeals the Indian Evidence Act, 1872, with savings for proceedings pending immediately before 1 July 2024." },
];

export const SAVINGS_SOURCE = "BNS s.358, BNSS s.531, BSA s.170 (Gazette of India, 25 December 2023); paraphrased — verify against the Gazette text";

export type DateRelation = "on" | "before" | "on_or_after";

export interface TransitionFact {
  /** ISO date when one is stated. */
  date: string | null;
  /** "before 1 July 2024" style statements fix the side of the boundary without an exact date. */
  relation: DateRelation | null;
}

export interface TransitionFacts {
  offence: TransitionFact | null;
  proceeding: (TransitionFact & { pending?: boolean }) | null;
  /** The question concerns the criminal codes at all (sections, offences, bail, FIR, trial…). */
  criminal: boolean;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MON = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const DATE = `(\\d{4}-\\d{2}-\\d{2}|\\d{1,2}[./-]\\d{1,2}[./-]\\d{4}|\\d{1,2}(?:st|nd|rd|th)?\\s+${MON}\\.?,?\\s+\\d{4}|${MON}\\.?\\s+\\d{1,2},?\\s+\\d{4})`;

function isoOf(s: string): string | null {
  const t = s.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (m) return valid(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(t);
  if (m) return valid(+m[3], +m[2], +m[1]);
  m = new RegExp(`^(\\d{1,2})(?:st|nd|rd|th)?\\s+${MON}\\.?,?\\s+(\\d{4})$`, "i").exec(t);
  if (m) return valid(+m[3], MONTHS.indexOf(m[2].toLowerCase().slice(0, 3)) + 1, +m[1]);
  m = new RegExp(`^${MON}\\.?\\s+(\\d{1,2}),?\\s+(\\d{4})$`, "i").exec(t);
  if (m) return valid(+m[3], MONTHS.indexOf(m[1].toLowerCase().slice(0, 3)) + 1, +m[2]);
  return null;
}

function valid(y: number, mo: number, d: number): string | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const iso = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return isValidIsoDate(iso) ? iso : null;
}

const OFFENCE_WORDS = "(?:offen[cs]es?|incident|occurrence|crime|FIR|alleged|committed|occurred|cheating|assault|theft)";
const PROCEEDING_WORDS = "(?:application|petition|appeal|revision|trial|inquiry|enquiry|investigation|proceedings?|case|bail plea|complaint|charge-?sheet|filed|instituted|registered|moved|pending)";
const REL = "(before|prior to|on or after|after|from|since|on)";

function relationOf(word: string | undefined): DateRelation {
  const w = (word ?? "").toLowerCase();
  return w === "before" || w === "prior to" ? "before" : w === "after" || w === "on or after" || w === "from" || w === "since" ? "on_or_after" : "on";
}

/** Deterministic facts about the transition stated in a question. Pure. */
export function transitionFactsFromText(text: string): TransitionFacts {
  const t = (text ?? "").replace(/\s+/g, " ");
  const criminal = /\b(IPC|BNS|BNSS|CrPC|Cr\.P\.C|BSA|Evidence Act|offen[cs]e|FIR|bail|accused|charge-?sheet|cognizance|quash|trial|convict)/i.test(t);
  const find = (subject: string): TransitionFact | null => {
    // "<subject> … <relation> <date>" within a short window, e.g. "offence committed before 1 July 2024".
    const re = new RegExp(`${subject}[^.;?]{0,60}?\\b${REL}\\s+(?:the\\s+)?${DATE}`, "i");
    const m = re.exec(t);
    if (!m) return null;
    const date = isoOf(m[2]);
    if (!date) return null;
    const relation = relationOf(m[1]);
    return relation === "on" ? { date, relation: "on" } : { date, relation };
  };
  const offence = find(OFFENCE_WORDS);
  let proceeding: TransitionFacts["proceeding"] = find(PROCEEDING_WORDS);
  if (!proceeding && /\bpending\b[^.;?]{0,40}\b(?:on|as on|before)\s+(?:1st|1)\s+July,?\s+2024/i.test(t)) proceeding = { date: NEW_CODES_IN_FORCE, relation: "before", pending: true };
  return { offence, proceeding, criminal };
}

/** Which side of 1 July 2024 a fact falls on: "old" (IPC/CrPC/IEA), "new" (BNS/BNSS/BSA) or null when unknown. */
export function sideOf(f: TransitionFact | null | undefined): "old" | "new" | null {
  if (!f?.date) return null;
  const c = compareIso(f.date, NEW_CODES_IN_FORCE);
  if (f.relation === "before") return c <= 0 ? "old" : null; // "before 1 Aug 2024" does not fix the side
  if (f.relation === "on_or_after") return c >= 0 ? "new" : null;
  return c < 0 ? "old" : "new";
}

export interface TransitionNote {
  /** True when the note applies (a criminal question with a date near the boundary or a pre/post statement). */
  applies: boolean;
  substantive: "IPC" | "BNS" | "requires_review";
  procedure: "CrPC" | "BNSS" | "requires_review";
  /** Deterministic lines for the synthesis context and the answer. */
  lines: string[];
  provisions: SavingsProvision[];
  source: string;
}

/** Dates within this many days of 1 July 2024 make the note apply even without a code word in the question. */
const NEAR_DAYS = 548;

/**
 * The transition note for a question. `offenceDate` (settings or offenceDateFromText) wins over the text; the text adds
 * relational statements ("before 1 July 2024") and the proceeding date. Missing dates are stated as missing.
 */
export function transitionNote(input: { question: string; offenceDate?: string | null; proceedingDate?: string | null }): TransitionNote {
  const facts = transitionFactsFromText(input.question);
  const offence: TransitionFact | null = input.offenceDate && isValidIsoDate(input.offenceDate) ? { date: input.offenceDate, relation: facts.offence?.date === input.offenceDate ? facts.offence.relation : "on" } : facts.offence;
  const proceeding: TransitionFact | null = input.proceedingDate && isValidIsoDate(input.proceedingDate) ? { date: input.proceedingDate, relation: "on" } : facts.proceeding;
  const near = (f: TransitionFact | null) => Boolean(f?.date && Math.abs(Date.parse(f.date) - Date.parse(NEW_CODES_IN_FORCE)) <= NEAR_DAYS * 86_400_000);
  const mentionsBoundary = /\b(1(?:st)?\s+July,?\s+2024|01[./-]07[./-]2024|2024-07-01|BNS|BNSS|BSA|Bharatiya)\b/i.test(input.question);
  const applies = facts.criminal && (near(offence) || near(proceeding) || mentionsBoundary);

  const oSide = sideOf(offence);
  const pSide = sideOf(proceeding);
  const substantive: TransitionNote["substantive"] = oSide === "old" ? "IPC" : oSide === "new" ? "BNS" : offence?.date && offence.relation === "on" ? applicableCode(offence.date).substantive : "requires_review";
  const procedure: TransitionNote["procedure"] = pSide === "old" ? "CrPC" : pSide === "new" ? "BNSS" : "requires_review";
  const [bns, bnss] = SAVINGS_PROVISIONS;
  const lines: string[] = [];
  const describe = (f: TransitionFact | null) => (f?.date ? `${f.relation === "before" ? "before " : f.relation === "on_or_after" ? "on or after " : ""}${f.date}` : "not stated");
  lines.push(`Offence date: ${describe(offence)} → substantive law: ${substantive === "requires_review" ? "cannot be determined without the date of the offence (requires review)" : substantive === "IPC" ? "Indian Penal Code, 1860 (saved by BNS s.358)" : "Bharatiya Nyaya Sanhita, 2023"}.`);
  lines.push(`Proceeding (application, investigation, inquiry, trial or appeal) instituted or pending: ${describe(proceeding)} → procedure: ${procedure === "requires_review" ? "depends on whether the proceeding was pending immediately before 1 July 2024 (CrPC, BNSS s.531(2)(a)) or instituted on or after it (BNSS); the date is needed (requires review)" : procedure === "CrPC" ? "Code of Criminal Procedure, 1973 (pending proceeding saved by BNSS s.531(2)(a))" : "Bharatiya Nagarik Suraksha Sanhita, 2023 (instituted on or after 1 July 2024; BNSS s.531)"}.`);
  if (substantive === "IPC" && procedure === "BNSS") lines.push("The offence predates the new codes while the proceeding postdates them: IPC for the offence, BNSS for the procedure. How s.531 BNSS applies to such proceedings has been litigated; confirm against current authority before filing.");
  lines.push(`Rule: ${bns.rule}`);
  lines.push(`Rule: ${bnss.rule}`);
  return { applies, substantive, procedure, lines, provisions: [bns, bnss], source: SAVINGS_SOURCE };
}
