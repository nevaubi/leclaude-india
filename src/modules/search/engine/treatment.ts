/**
 * Authority treatment signals and currentness flags (constitution §25: track date/currentness,
 * court hierarchy; never assert good law). Pure and client-safe.
 *
 * LeClaude India: treatment comes from later judgments IN THE CORPUS that cite the judgment (parsed citations) and from
 * treatment the ingestion/citation workers recorded. A citing judgment that uses negative-treatment language near the
 * citation (overruled, per incuriam, doubted, referred to a larger bench…) makes the authority "possibly negative —
 * review"; the absence of such language is reported as "no negative signal found", which is NOT a statement that the
 * authority is good law (the corpus is not a citator). Unchecked authority is "treatment not checked".
 */
import type { AuthorityTreatment, Currentness, ResearchSource } from "./types";

/** Phrases that indicate negative subsequent treatment (lower-cased; matched on word boundaries). */
export const NEGATIVE_TREATMENT_PHRASES = [
  "overruled", "overrule", "overruling", "abrogated", "abrogation", "superseded by statute", "superseded", "disapproved", "declined to follow", "decline to follow",
  "called into doubt", "no longer good law", "questioned", "limited to its facts", "we reject", "rejected the reasoning", "criticized", "not followed",
];

/** Indian negative-treatment vocabulary (in addition to the general phrases). */
export const INDIAN_NEGATIVE_TREATMENT_PHRASES = [
  ...NEGATIVE_TREATMENT_PHRASES, "per incuriam", "doubted", "doubt the correctness", "referred to a larger bench", "reference to a larger bench", "not good law", "does not lay down the correct law", "does not lay down good law", "impliedly overruled", "stands overruled", "held to be bad law",
];

const phraseRe = (phrases: string[]) => new RegExp(`\\b(${phrases.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+")).join("|")})\\b`, "i");
const NEG_RE = phraseRe(NEGATIVE_TREATMENT_PHRASES);

export interface CitingOpinion {
  title: string;
  cite?: string;
  date?: string;
  url?: string;
  snippet?: string;
}

/** First negative-treatment phrase in a snippet, or null. */
export function negativePhrase(text: string | undefined, re: RegExp = NEG_RE): string | null {
  const m = (text ?? "").match(re);
  return m ? m[1].toLowerCase().replace(/\s+/g, " ") : null;
}

/**
 * Treatment signal from citing opinions. `negative` are citing opinions returned by a query that
 * already requires negative language (their phrase is re-derived from the snippet when possible).
 */
export function classifyTreatment(input: { citing: CitingOpinion[]; citingCount?: number; negative?: CitingOpinion[] }, checkedAt = new Date().toISOString(), opts: { basis?: "corpus" | "provider"; phrases?: string[] } = {}): AuthorityTreatment {
  const re = opts.phrases ? phraseRe(opts.phrases) : NEG_RE;
  const noun = opts.basis === "corpus" ? "citing judgment" : "citing opinion";
  const scope = opts.basis === "corpus" ? " in the judgment corpus" : "";
  const flagged = new Map<string, CitingOpinion & { phrase?: string }>();
  for (const c of [...(input.negative ?? []), ...input.citing]) {
    const phrase = negativePhrase(c.snippet, re) ?? (input.negative?.includes(c) ? "negative-treatment language" : null);
    if (phrase && !flagged.has(c.url ?? c.title)) flagged.set(c.url ?? c.title, { ...c, phrase });
  }
  const citingCount = input.citingCount ?? input.citing.length;
  const examples = Array.from(flagged.values()).slice(0, 3).map((c) => ({ title: c.title, cite: c.cite, date: c.date, url: c.url, phrase: c.phrase }));
  const basis = opts.basis ? { basis: opts.basis } : {};
  if (flagged.size) {
    return { ...basis, signal: "possibly_negative", citingCount, negativeCount: flagged.size, examples, checkedAt, note: `Treatment: possibly negative, review. ${flagged.size} ${noun}${flagged.size === 1 ? " uses" : "s use"} negative-treatment language${scope} (${examples.map((e) => `“${e.phrase}”`).filter((v, i, a) => a.indexOf(v) === i).join(", ")}).` };
  }
  return { ...basis, signal: "no_negative_signal", citingCount, negativeCount: 0, examples: [], checkedAt, note: citingCount ? `No negative-treatment language found in ${citingCount} ${noun}${citingCount === 1 ? "" : "s"} checked${scope}. This is not a citator result; confirm before relying.` : `No ${noun}s were found${scope}. This is not a citator result; confirm before relying.` };
}

export function treatmentUnavailable(reason: string, checkedAt = new Date().toISOString()): AuthorityTreatment {
  return { signal: "unavailable", checkedAt, note: `Treatment not checked: ${reason}` };
}

export const TREATMENT_LABEL: Record<AuthorityTreatment["signal"], string> = {
  possibly_negative: "Treatment: possibly negative, review",
  no_negative_signal: "No negative signal found",
  unavailable: "Treatment not checked",
};

/** Old criminal codes replaced on 1 July 2024 (they still govern offences committed before that date). */
const REPLACED_CODES: [RegExp, string][] = [
  [/\bIndian Penal Code\b|\bIPC\b/i, "Replaced by the Bharatiya Nyaya Sanhita, 2023 from 1 July 2024; governs offences committed before that date"],
  [/\bCode of Criminal Procedure\b|\bCr\.?P\.?C\b/i, "Replaced by the Bharatiya Nagarik Suraksha Sanhita, 2023 from 1 July 2024; proceedings pending before that date continue under it (BNSS s. 531)"],
  [/\bIndian Evidence Act\b/i, "Replaced by the Bharatiya Sakshya Adhiniyam, 2023 from 1 July 2024 (BSA s. 170 savings)"],
];

/**
 * Currentness flag: proposed rules are not law; the old criminal codes are flagged as replaced (with the transition rule);
 * judgments older than 25 years and other sources older than 10 are "dated".
 */
export function currentnessOf(s: Pick<ResearchSource, "kind" | "date" | "hit">, now = Date.now()): Currentness {
  if (s.kind === "federal_register" && /PRORULE|proposed/i.test(`${s.hit.fr?.type ?? ""} ${s.hit.title}`)) return { flag: "proposed", label: "Proposed rule, not in force" };
  if (s.kind === "statutes") {
    const name = `${s.hit.india?.enactment ?? ""} ${s.hit.title}`;
    const replaced = REPLACED_CODES.find(([re]) => re.test(name));
    if (replaced || s.hit.india?.replacedBy) return { flag: "dated", label: replaced?.[1] ?? `Replaced by ${s.hit.india?.replacedBy}; check which enactment governs on the relevant date` };
  }
  const m = (s.date ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return { flag: "undated", label: "Date unknown" };
  const years = Math.floor((now - Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) / (365.25 * 86400_000));
  const limit = s.kind === "caselaw" ? 25 : s.kind === "regulations" || s.kind === "statutes" ? 100 : 10;
  if (years >= limit) return { flag: "dated", label: `${years} years old; confirm it is still current`, years };
  return { flag: "current", label: years <= 0 ? "Less than a year old" : `${years} year${years === 1 ? "" : "s"} old`, years };
}
