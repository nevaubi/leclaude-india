import type { PrivilegeLogEntry, ReviewBatch, SavedSearchRecord } from "@/lib/types/domain";
import { sampleIds } from "@/modules/ediscovery/batch-pure";
import { compareBates } from "@/modules/ediscovery/query";
import type { IndiaEDocument } from "@/modules/ediscovery/india";
import { BY_NAME, MB, MC, MW, REVIEWER as R, tagged } from "./people";

/** Review-workflow records for the demo matters: saved searches, review batches and the privilege log. */

export const REVIEW_IDS = {
  savedSearches: {
    plaintiffExhibits: "demo_in_ss_ex_p",
    acceptance: "demo_in_ss_acceptance",
    outage: "demo_in_ss_ugadi_outage",
    privCc: "demo_in_ss_priv_cc",
    writSurvey: "demo_in_ss_writ_survey",
    bailRecord: "demo_in_ss_bail_record",
  },
  batches: { firstPass: "demo_in_rb_first_pass", privilege: "demo_in_rb_privilege" },
} as const;

const T0 = "2026-09-08T09:00:00Z";
const T1 = "2026-09-18T17:30:00Z";

export function buildSavedSearches(): SavedSearchRecord[] {
  const S = REVIEW_IDS.savedSearches;
  const ss = (id: string, matterId: string, name: string, description: string, q: string, ownerId: string, shared: boolean): SavedSearchRecord =>
    tagged<SavedSearchRecord>({ id, matterId, name, description, q, ownerId, shared, createdAt: T0, updatedAt: T0 });
  return [
    ss(S.plaintiffExhibits, MC, "Plaintiff's exhibits Ex.P1 to Ex.P25", "Every document marked through PW-1, in exhibit order.", 'exhibit:"Ex.P1 to P25"', R.junior, true),
    ss(S.acceptance, MC, "Acceptance and UAT sign-off", "Ex.P9 and everything bearing on whether M3–M5 stood accepted (Issue 1).", '("sign-off" OR acceptance OR "UAT") issue:ACC-01', R.junior, true),
    ss(S.outage, MC, "Ugadi-week outages", "Incident reports, the Hubballi letter (Kannada), downtime report and audit.", "(Hubballi OR Ugadi OR outage OR \"sync agent\") issue:DEF-01", R.junior, true),
    ss(S.privCc, MC, "Advocate only copied — not privileged", "Business e-mails where our advocate was merely copied; produced, not logged.", "tag:privilege-cc", R.junior, false),
    ss(S.writSurvey, MW, "Survey, FTL and notice", "Notice, survey report (Telugu and translation), permission and interim order.", "(survey OR FTL OR notice) -tag:pleading", R.clerk, true),
    ss(S.bailRecord, MB, "Bail record", "FIR, remand, wound certificate, Sessions Court order and annexures.", "issue:BAIL-01 OR issue:ALG-01", R.clerk, true),
  ];
}

export function buildBatches(docs: IndiaEDocument[]): ReviewBatch[] {
  const B = REVIEW_IDS.batches;
  const commercial = docs.filter((d) => d.matterId === MC).sort((a, b) => compareBates(a.bates, b.bates));
  const firstIds = commercial.filter((d) => /_ed_g\d{3}$/.test(d.id)).map((d) => d.id);
  const privIds = commercial.filter((d) => d.coding.privileged === true || (d.tags ?? []).includes("privilege-cc")).map((d) => d.id);
  return [
    { id: B.firstPass, matterId: MC, name: "First pass — routine project documents", description: "Status reports, support tickets and routine mails from both sides' disclosures. Code responsiveness and issues; flag anything on acceptance, delay or the Ugadi outages for the arguments note.", docIds: firstIds, source: { kind: "selection" }, assigneeId: R.clerk, priority: "normal", dueAt: "2026-10-02", status: "in_progress", qcSamplePercent: 10, qcSampleIds: sampleIds(firstIds, 10, B.firstPass), secondPass: false, qcDecisions: {}, createdBy: R.junior, createdAt: T0, updatedAt: T1 } as ReviewBatch,
    { id: B.privilege, matterId: MC, name: "Privilege check before disclosure", description: "Confirm each withheld document is an advocate–client communication (BSA s.132 / IEA s.126) or a confidential communication with the legal adviser (BSA s.134 / IEA s.129). An advocate merely copied does not make a business e-mail privileged.", docIds: privIds, source: { kind: "search", q: "priv:yes OR tag:privilege-cc" }, assigneeId: R.junior, priority: "high", dueAt: "2026-10-05", status: "in_progress", qcSamplePercent: 0, qcSampleIds: [], secondPass: true, qcDecisions: {}, createdBy: R.junior, createdAt: T0, updatedAt: T1 } as ReviewBatch,
  ].map((b) => tagged(b));
}

function role(name: string): string {
  const p = BY_NAME.get(name);
  return p ? `${name} (${p.title}${/advocate/i.test(p.title) ? "" : `, ${p.org}`})` : name === "Kavya Hegde" ? "Kavya Hegde (Advocate for the plaintiff)" : name;
}

/** Plaintiff's privilege log for its disclosure: privilege-safe descriptions, Indian statutory basis. */
export function buildPrivilegeLog(docs: IndiaEDocument[]): PrivilegeLogEntry[] {
  const priv = docs.filter((d) => d.coding.privileged === true).sort((a, b) => compareBates(a.bates, b.bates));
  return priv.map((d, i) => {
    const author = d.from ?? d.custodianName;
    const fromCounsel = author === "Kavya Hegde";
    const noun = d.type === "Email" ? "E-mail" : d.type === "Memo" ? "Draft pleading with advocate's comments" : "Document";
    const recipients = (d.to ?? []).map(role);
    const description = d.coding.privilegeBasis === "work-product"
      ? `${noun} prepared by ${role(author)} in contemplation of the suit, reflecting the advocate's advice; confidential communication with the legal adviser (BSA s.134 / IEA s.129).`
      : fromCounsel
        ? `${noun} from ${role(author)} to ${recipients.join(", ")} giving legal advice on pre-suit steps; advocate–client communication (BSA s.132 / IEA s.126).`
        : `${noun} from ${role(author)} to ${recipients.join(", ")} seeking legal advice; advocate–client communication (BSA s.132 / IEA s.126).`;
    return tagged<PrivilegeLogEntry>({ id: `demo_in_pl_${String(i + 1).padStart(2, "0")}`, matterId: d.matterId, docId: d.id, bates: d.batesEnd ? `${d.bates} – ${d.batesEnd}` : d.bates, date: d.date, author, recipients: d.to ?? [], docType: d.type, basis: d.coding.privilegeBasis === "work-product" ? "Work product" : "Attorney-client", description, status: i === 0 ? "final" : "review" });
  });
}
