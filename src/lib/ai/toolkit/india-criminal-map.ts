/**
 * `map_criminal_section` adapter over the citation worker's coded correspondence table
 * (`@/lib/india/criminal-code-map`: IPC↔BNS, CrPC↔BNSS, IEA↔BSA) and its applicable-code rules.
 *
 * Nothing is decided here: the table returns every candidate (a split stays a split), an unknown section is
 * `unmapped`, and a missing, invalid or boundary-spanning date is `requires_review`. Those status values are passed
 * through unchanged so the model and the UI show them as they are. Pure and client-safe.
 */
import { applicableCode, applicableEvidenceCode, mapSection, NEW_CODES_IN_FORCE, type CodeName, type MapResult } from "@/lib/india/criminal-code-map";

export { NEW_CODES_IN_FORCE };

export const CODE_TITLE: Record<CodeName, string> = {
  IPC: "Indian Penal Code, 1860",
  BNS: "Bharatiya Nyaya Sanhita, 2023",
  CrPC: "Code of Criminal Procedure, 1973",
  BNSS: "Bharatiya Nagarik Suraksha Sanhita, 2023",
  IEA: "Indian Evidence Act, 1872",
  BSA: "Bharatiya Sakshya Adhiniyam, 2023",
};

export function parseCode(raw: string): CodeName | null {
  const k = String(raw ?? "").trim().toUpperCase().replace(/[.\s]/g, "");
  if (k === "IPC" || k === "INDIANPENALCODE") return "IPC";
  if (k === "BNS" || k === "BHARATIYANYAYASANHITA") return "BNS";
  if (k === "CRPC" || k === "CODEOFCRIMINALPROCEDURE") return "CrPC";
  if (k === "BNSS" || k === "BHARATIYANAGARIKSURAKSHASANHITA") return "BNSS";
  if (k === "IEA" || k === "EVIDENCEACT" || k === "INDIANEVIDENCEACT") return "IEA";
  if (k === "BSA" || k === "BHARATIYASAKSHYAADHINIYAM") return "BSA";
  return null;
}

export interface CriminalSectionMapping extends MapResult {
  titles: Partial<Record<CodeName, string>>;
  /** Which code governs, from the shared rules; "requires_review" is shown as is, never defaulted. */
  applicable: { family: "substantive" | "procedure" | "evidence"; code: string; notes: string[] };
}

/** Map one section and say which code governs for the given dates. */
export function mapCriminalSection(input: { code: string; section: string; offenceDate?: string | null; proceedingInitiated?: string | null }): CriminalSectionMapping | { error: string } {
  const code = parseCode(input.code);
  if (!code) return { error: `Unknown code "${input.code}". Use IPC, BNS, CrPC, BNSS, IEA or BSA.` };
  if (!String(input.section ?? "").trim()) return { error: "section is required" };
  const map = mapSection(code, input.section);
  const titles: Partial<Record<CodeName, string>> = { [code]: CODE_TITLE[code] };
  for (const c of map.candidates) titles[c.code] = CODE_TITLE[c.code];
  let applicable: CriminalSectionMapping["applicable"];
  if (code === "IPC" || code === "BNS") {
    const a = applicableCode(input.offenceDate ?? null);
    applicable = { family: "substantive", code: a.substantive, notes: a.notes };
  } else if (code === "CrPC" || code === "BNSS") {
    const a = applicableCode(input.offenceDate ?? null, input.proceedingInitiated ? { proceedingInitiated: input.proceedingInitiated } : {});
    applicable = { family: "procedure", code: a.procedure ?? "requires_review", notes: a.procedure ? a.notes : [...a.notes, "Procedure follows the date the proceeding was initiated (BNSS s.531); give proceeding_initiated."] };
  } else {
    const a = applicableEvidenceCode(input.proceedingInitiated ?? null);
    applicable = { family: "evidence", code: a.code, notes: [a.note] };
  }
  return { ...map, titles, applicable };
}
