/**
 * eCourts services — manual lookup only (pure, client-safe).
 *
 * Case status and orders on eCourts (district courts: services.ecourts.gov.in; High Courts: hcservices.ecourts.gov.in)
 * sit behind a captcha on every search form. LeClaude India never automates past a captcha (Appendix B), so there is
 * no eCourts adapter: this module only validates a CNR and builds the link a person opens to look it up themselves.
 */
import { COURTS, type Court } from "@/lib/india/courts";

export const ECOURTS_DISTRICT_URL = "https://services.ecourts.gov.in/ecourtindia_v6/";
export const ECOURTS_HIGH_COURT_URL = "https://hcservices.ecourts.gov.in/hcservices/main.php";

export interface CnrLookupLink {
  cnr: string;
  valid: boolean;
  /** Registry court whose CNR prefix matches (High Courts only); null when no registry prefix matches. */
  court: Court | null;
  level: "high" | "district" | "unknown";
  url: string;
  automated: false;
  /** What the person does on the page (the page asks for a captcha). */
  instructions: string;
  reason?: string;
}

/** CNR: 16 characters — 4 letters and 2 digits (establishment), 6-digit serial, 4-digit year (e.g. KAHC01 000001 2024). */
export function normalizeCnr(raw: string): string {
  return raw.replace(/[\s-]/g, "").toUpperCase();
}

export function isValidCnr(cnr: string): boolean {
  return /^[A-Z]{4}\d{12}$/.test(cnr);
}

export function ecourtsCnrLink(raw: string): CnrLookupLink {
  const cnr = normalizeCnr(raw);
  if (!isValidCnr(cnr)) {
    return { cnr, valid: false, court: null, level: "unknown", url: ECOURTS_DISTRICT_URL, automated: false, instructions: "Check the CNR: it has 16 characters (4 letters followed by 12 digits).", reason: "invalid_cnr" };
  }
  const prefix = cnr.slice(0, 4);
  const court = COURTS.find((c) => c.cnrPrefix === prefix) ?? null;
  if (court) {
    return { cnr, valid: true, court, level: "high", url: ECOURTS_HIGH_COURT_URL, automated: false, instructions: `Open the High Court case-status page, choose ${court.name}, select "CNR Number", enter ${cnr} and the captcha shown on the page.` };
  }
  return { cnr, valid: true, court: null, level: /HC$/.test(prefix) ? "unknown" : "district", url: ECOURTS_DISTRICT_URL, automated: false, instructions: `Open eCourts case status, enter the CNR ${cnr} in "Search by CNR" and the captcha shown on the page.` };
}
