import type { IssueCode } from "@/lib/types/domain";
import { MB, MC, MW, tagged } from "./people";

/** Issue codes of the three demo matters (framed around the issues settled by the courts and the bail grounds). */
const CODES: [matter: string, code: string, label: string, description: string, color: string][] = [
  [MC, "DUE-01", "Amounts due and invoices", "Invoices for M3–M5, payments and the balance claimed (Issue 1).", "chart-1"],
  [MC, "ACK-01", "Acknowledgement of debt", "Written acknowledgement and part payment (Limitation Act ss.18–19); Ex.P14, Ex.P20.", "chart-2"],
  [MC, "ACC-01", "Acceptance / UAT sign-off", "Whether M3–M5 stood accepted (MSA cl. 9.3); Ex.P9 and its qualification.", "chart-3"],
  [MC, "DLY-01", "Delay and liquidated damages", "Pilot delay, store master data dependency (cl. 11.4) and LD (cl. 11.2) (Issue 3).", "chart-4"],
  [MC, "DEF-01", "Defects and outages", "Ugadi-week billing interruptions and their cause.", "warning"],
  [MC, "CC-01", "Counter-claim / consequential loss", "Loss of sales and other heads; exclusion in cl. 12.3 (Issues 4–5).", "chart-5"],
  [MC, "LIM-01", "Limitation", "Computation of limitation for the claim; effect of the acknowledgement.", "info"],
  [MC, "PRV-01", "Privilege", "Advocate–client communications (BSA s.132 / IEA s.126) and copied-only e-mails.", "destructive"],
  [MW, "NJ-01", "Natural justice / hearing", "Notice without survey records or a hearing; representation unanswered.", "chart-1"],
  [MW, "FTL-01", "FTL buffer measurement", "Where the building stands relative to the tank's FTL and buffer.", "chart-2"],
  [MW, "BP-01", "Building permission", "Permission of 2019 and the Irrigation NOC.", "chart-3"],
  [MW, "ALG-01", "Survey incident", "What happened at the survey on 12.08.2026.", "warning"],
  [MB, "BAIL-01", "Grounds for bail", "Custody, antecedents, nature of offences, status of investigation.", "chart-4"],
  [MB, "ALG-01", "Allegations v. record", "FIR allegations compared with the survey report and the medical record.", "warning"],
];

export function buildIssueCodes(): IssueCode[] {
  return CODES.map(([matterId, code, label, description, color]) => tagged<IssueCode>({ id: `demo_in_ic_${matterId.slice(-5)}_${code.toLowerCase().replace(/[^a-z0-9]/g, "")}`, matterId, code, label, description, color }));
}
