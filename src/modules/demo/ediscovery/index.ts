import type { Conflict, Deposition, IssueCode, PrivilegeLogEntry, Relationship, TimelineEvent } from "@/lib/types/domain";
import type { IndiaEDocument } from "@/modules/ediscovery/india";
import { DEMO_DEPOSITIONS, DEMO_REF_PREFIX } from "../ids";
import { buildCorpus, REF_WIDTH } from "./build-docs";
import { buildDeposition, docIndex, flag, type IndiaDeposition } from "./depo-helpers";
import { PW1_SHEET } from "./depo-pw1";
import { DW1_SHEET } from "./depo-dw1";
import { buildConflicts, buildRelationships, buildTimeline } from "./analysis";
import { buildIssueCodes } from "./issue-codes";
import { buildBatches, buildPrivilegeLog, buildSavedSearches } from "./review";
import { MB, MC, MW, PEOPLE, SOURCES, buildPeople, tagged } from "./people";

/**
 * Case-record half of the India demonstration pack: the Bengaluru commercial suit (documents, exhibits Ex.P1–P25 and
 * Ex.D1–D18, PW-1 and DW-1 depositions, chronology, conflicts), and the Hyderabad writ and bail matters (documents
 * with Telugu originals and English translations, chronology, conflicts).
 *
 * Pure and deterministic: no db access, no clock, no randomness. Every record is tagged `meta.demo = "india-blr-hyd"`,
 * `meta.synthetic = true`.
 */

export { REVIEW_IDS } from "./review";
export { PW1_SHEET } from "./depo-pw1";
export { DW1_SHEET } from "./depo-dw1";

/** Module-private collection names the pack writes (mirror ediscovery/review-store). */
export const INDIA_DEMO_COLLECTIONS = {
  people: "people",
  batches: "ediscovery_batches",
  savedSearches: "ediscovery_saved_searches",
} as const;

/** kv keys the pack writes (the review settings key mirrors ediscovery/ingest). */
export const INDIA_DEMO_KV_KEYS = {
  settings: (matterId: string) => `ediscovery:settings:${matterId}`,
} as const;

export interface IndiaEdiscoveryDemo {
  edocs: IndiaEDocument[];
  issueCodes: IssueCode[];
  depositions: IndiaDeposition[];
  timeline: TimelineEvent[];
  relationships: Relationship[];
  conflicts: Conflict[];
  privilegeLog: PrivilegeLogEntry[];
  collections: { collection: string; docs: { id: string }[] }[];
  kv: Record<string, unknown>;
}

/** Text the keyword index expects for a document (mirrors ediscovery/privilege `indexTextFor`). */
export function demoIndexText(d: IndiaEDocument): string {
  const refs = [d.bates, d.india?.exhibit, d.india?.docNumber].filter(Boolean).join(" · ");
  return `${refs}\n${d.subject}\n${d.custodianName}\n${d.from ?? ""}\n${(d.to ?? []).join("; ")}\n\n${d.text}`;
}

export function buildIndiaEdiscoveryDemo(): IndiaEdiscoveryDemo {
  const edocs = buildCorpus();
  const ix = docIndex(edocs);
  const commercial = edocs.filter((d) => d.matterId === MC);
  const pw1 = tagged(buildDeposition({ id: DEMO_DEPOSITIONS.pw1, matterId: MC, sheet: PW1_SHEET, witness: PEOPLE.bhat, designation: "PW-1", side: "plaintiff", takenBy: "Sri S. Venkatesh Murthy, Advocate for the Defendant (cross-examination)", defendingBy: "Kavya Hegde, Advocate for the Plaintiff", location: "Commercial Court, Bengaluru", examinedOn: ["2024-07-15", "2024-08-05"], sheetDocId: ix.doc("rec_pw1_sheet").id, docs: commercial }));
  const dw1 = tagged(buildDeposition({ id: DEMO_DEPOSITIONS.dw1, matterId: MC, sheet: DW1_SHEET, witness: PEOPLE.patil, designation: "DW-1", side: "defendant", takenBy: "Smt. Kavya Hegde, Advocate for the Plaintiff (cross-examination)", defendingBy: "Sri S. Venkatesh Murthy, Advocate for the Defendant", location: "Commercial Court, Bengaluru", examinedOn: ["2025-01-20", "2025-02-17"], sheetDocId: ix.doc("rec_dw1_sheet").id, docs: commercial }));
  // Reviewer flags on the testimony that matters (the parser leaves flags empty).
  flag(pw1, "It is true that in Ex.D1 I informed the Defendant", ["admission", "key"], "Against chief ¶7 — see Conflicts.");
  flag(pw1, "All milestones were delivered within the timelines agreed in Ex.P3", ["contradiction"]);
  flag(pw1, "Witness volunteers that the slip was due to the Defendant's delay", ["key"]);
  flag(pw1, "It is false to suggest that billing at Hubballi was down till 1.30 p.m.", ["key"]);
  flag(dw1, "It is true that Ex.P9 UAT sign-off e-mail was sent by me.", ["admission", "key"], "Early admission; qualified on further cross (17.02.2025). Cite both.");
  flag(dw1, "It is true that after Ex.P9 the pilot went live in six stores.", ["admission"]);
  flag(dw1, "was not a final acceptance", ["contradiction", "key"], "Late qualification of the admission on 20.01.2025.");
  flag(dw1, "It is true that in Ex.P14 our CFO has stated that the M3 and M4 invoices are due.", ["admission", "key"]);
  flag(dw1, "I did not personally verify the timings at Hubballi.", ["admission"]);
  flag(dw1, "I do not remember the exact date.", ["evasive"]);
  flag(dw1, "That is a legal question. I cannot answer it.", ["evasive"]);
  const depositions = [pw1, dw1];
  const ctx = { ix, pw1, dw1 };

  const counts = new Map<string, number>();
  for (const d of edocs) for (const c of d.coding.issues ?? []) counts.set(`${d.matterId}|${c}`, (counts.get(`${d.matterId}|${c}`) ?? 0) + 1);
  const issueCodes = buildIssueCodes().map((c) => ({ ...c, count: counts.get(`${c.matterId}|${c.code}`) ?? 0 }));

  const kv: Record<string, unknown> = {};
  const sourcesByMatter: Record<string, (keyof typeof DEMO_REF_PREFIX)[]> = { [MC]: ["plaintiff"], [MW]: ["petitioner"], [MB]: ["prosecution"] };
  for (const [matterId, keys] of Object.entries(sourcesByMatter)) {
    const prefix = DEMO_REF_PREFIX[keys[0]];
    let max = 0;
    for (const d of edocs) if (d.matterId === matterId) for (const b of [d.bates, d.batesEnd]) if (b?.startsWith(`${prefix}-`)) max = Math.max(max, Number(b.slice(prefix.length + 1)));
    kv[INDIA_DEMO_KV_KEYS.settings(matterId)] = { batesPrefix: prefix, batesWidth: REF_WIDTH, nextBates: max + 1 };
  }

  return {
    edocs,
    issueCodes,
    depositions,
    timeline: buildTimeline(ctx),
    relationships: buildRelationships(ctx),
    conflicts: buildConflicts(ctx),
    privilegeLog: buildPrivilegeLog(edocs),
    collections: [
      { collection: INDIA_DEMO_COLLECTIONS.people, docs: buildPeople() },
      { collection: INDIA_DEMO_COLLECTIONS.savedSearches, docs: buildSavedSearches() },
      { collection: INDIA_DEMO_COLLECTIONS.batches, docs: buildBatches(edocs) },
    ],
    kv,
  };
}

export { SOURCES };
export type { Deposition };
