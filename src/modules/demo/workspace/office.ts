import "server-only";
/**
 * Office documents for the India demo: drafts produced from the Indian drafting templates for the demo matters
 * (regular bail petition under s.483 BNSS and the Telangana-format writ petition), and a synopsis for arguments in the
 * commercial suit. Built with the Word template builders, so they open in the editor like any template-created draft.
 */
import type { MatterRecord } from "@/modules/matters/types";
import type { PMNode } from "@/modules/office/word/doc-model";
import { buildDoc } from "@/modules/office/word/templates";
import { regularBailDoc, writTelanganaDoc } from "@/modules/office/word/templates-india";
import { DEMO_ID_PREFIX } from "../ids";

export const DEMO_OFFICE_IDS = {
  bail: `${DEMO_ID_PREFIX}office_bail_petition`,
  writ: `${DEMO_ID_PREFIX}office_writ_petition`,
  synopsis: `${DEMO_ID_PREFIX}office_synopsis`,
} as const;

export function bailDraft(m: MatterRecord): PMNode {
  return regularBailDoc(m);
}

export function writDraft(m: MatterRecord): PMNode {
  return writTelanganaDoc(m);
}

/** Synopsis for arguments in the commercial suit, citing exhibits by mark and testimony by designation and page:line. */
export function synopsisDraft(cites: { dw1Admission: string; dw1Qualification: string; dw1Defects: string; pw1Slip: string }): PMNode {
  return buildDoc([
    "@center **IN THE COURT OF THE COMMERCIAL COURT AT BENGALURU**",
    "@center **Com.O.S. No. 1187 of 2023**",
    "Nimbus Cloudworks Private Limited … **PLAINTIFF**",
    "@center **Versus**",
    "Tungabhadra Retail Solutions Private Limited … **DEFENDANT**",
    "@center **SYNOPSIS OF ARGUMENTS ON BEHALF OF THE PLAINTIFF (DRAFT)**",
    "## I. Issue 1 — the amounts are due",
    `@legal 1. UAT was signed off by DW-1 on 21.12.2022 (Ex.P9). DW-1 admitted sending it and that the pilot went live on it (${cites.dw1Admission}); on further cross he described it as conditional and "not a final acceptance" (${cites.dw1Qualification}). The condition was the closure of 14 Sev-3 defects, and DW-1 admits all were closed before rollout (${cites.dw1Defects}).\n2. All 46 stores were billing on the platform from 31.03.2023 (Ex.P13): production use is acceptance under clause 9.3 of the MSA (Ex.P2).\n3. The Defendant's CFO acknowledged in writing that the M3 and M4 invoices were due (Ex.P14) and paid ₹60,00,000 a week later (Ex.P20).`,
    "## II. Issue 3 — no liquidated damages",
    `@legal 1. CR-07 (Ex.P5) made the pilot date subject to complete store master data by 15.10.2022; it was received only on 12.01.2023 (Ex.D8). Clause 11.4 extends the milestone day for day. PW-1 attributed the slip to the missing data (${cites.pw1Slip}), as Ex.D1 itself records.`,
    "## III. Issues 4 and 5 — the counter-claim",
    "@legal 1. Loss of sales is excluded by clause 12.3 of the MSA.\n2. The Hubballi interruption lasted 75 minutes and was caused by the store's own internet line (Ex.P12, Ex.P16 — Kannada original with translation); the Defendant's auditor attributes 8 of 11 interruptions to store network outages (Ex.D5).\n3. Ex.D10 compares Ugadi 2022 (including three stores closed in January 2023) with 2023; it proves no loss caused by the Plaintiff.",
    "Authorities: to be added after reading; each marked [VERIFY] until then.",
    "_Synthetic demonstration draft._",
  ]);
}
