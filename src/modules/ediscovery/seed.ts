import "server-only";
import type { Database } from "@/lib/db";
import type { EDocument, IssueCode, Person, PrivilegeLogEntry } from "@/lib/types/domain";
import { indexDocuments } from "@/lib/ai/vector-store";
import { VECTOR_COLLECTIONS } from "@/lib/ai/toolkit/internal";
import { tenantId } from "@/lib/auth/principal";
import { VALSARA, NORTHGATE, buildDocs } from "./seed-helpers";
import { VALSARA_DOCS_A } from "./seed-docs-valsara-a";
import { VALSARA_DOCS_B } from "./seed-docs-valsara-b";
import { NORTHGATE_DOCS, NG_CUSTODIANS } from "./seed-docs-northgate";
import { indexTextFor, templatePrivilegeDescription } from "./privilege";
import { CODING_RULES_KEY, DEFAULT_CODING_RULES } from "./rules";
import { SEED_CODING_RULES } from "./seed-rules";
import { seedAnalysis } from "./analysis/seed";
import { seedReview, ensureReviewSeeded, REVIEW_SEED_VERSION } from "./seed-review";
import { detectNearDuplicates, nearDuplicateMap } from "./near-dup";

/** Issue codes per matter (stable ids: ic_<matter-short>_<code>). */
export const VALSARA_ISSUE_CODES: IssueCode[] = [
  { id: "ic_vls_tox01", matterId: VALSARA, code: "TOX-01", label: "Toxicology knowledge", description: "What Meridian knew about the toxicity of MF-3 / MC-8 and when: study results, internal summaries, management briefings.", color: "chart-5" },
  { id: "ic_vls_tox02", matterId: VALSARA, code: "TOX-02", label: "Chronic bioassay", description: "The two-year Sundaram study (SL-2001-0512): design, funding decisions, interim and final results.", color: "chart-5", parentId: "ic_vls_tox01" },
  { id: "ic_vls_reg01", matterId: VALSARA, code: "REG-01", label: "Clause 9.4 notice", description: "Analysis, decisions and timing of substantial-risk notices to the Park under the Supply Agreement.", color: "chart-1" },
  { id: "ic_vls_reg02", matterId: VALSARA, code: "REG-02", label: "CPCB / GPCB communications", description: "Communications with CPCB, GPCB, DQA-T and other regulators.", color: "chart-1", parentId: "ic_vls_reg01" },
  { id: "ic_vls_env01", matterId: VALSARA, code: "ENV-01", label: "Groundwater contamination", description: "Valsara site monitoring wells, Lagoon 2, plume migration, Park wellfield.", color: "chart-2" },
  { id: "ic_vls_env02", matterId: VALSARA, code: "ENV-02", label: "Site operations & discharges", description: "Plant drains, wastewater, outfall and operational practices at Valsara.", color: "chart-2", parentId: "ic_vls_env01" },
  { id: "ic_vls_mkt01", matterId: VALSARA, code: "MKT-01", label: "Marketing claims", description: "'Biodegradable', 'environmentally responsible', 'low toxicity' and similar claims in literature, MSDS and qualification packages.", color: "chart-3" },
  { id: "ic_vls_prd01", matterId: VALSARA, code: "PRD-01", label: "Product formulation", description: "MF-3 chemistry, MSDS content, MF-5 transition and reformulation.", color: "chart-4" },
  { id: "ic_vls_leg01", matterId: VALSARA, code: "LEG-01", label: "Legal advice", description: "Communications with in-house or outside counsel; privilege review required.", color: "destructive" },
  { id: "ic_vls_cus01", matterId: VALSARA, code: "CUS-01", label: "Customer communications", description: "Inquiries, complaints and notices to textile processors, mills and distributors.", color: "info" },
  { id: "ic_vls_gov01", matterId: VALSARA, code: "GOV-01", label: "Defence specification / DTS", description: "Defence qualification, DTS-24385 correspondence — specification-compliance defence.", color: "warning" },
];

export const NORTHGATE_ISSUE_CODES: IssueCode[] = [
  { id: "ic_ng_k01", matterId: NORTHGATE, code: "K-01", label: "Contract terms", description: "MTSA provisions, negotiation history, §11/§12 interplay.", color: "chart-1" },
  { id: "ic_ng_k02", matterId: NORTHGATE, code: "K-02", label: "Change orders", description: "CO-1 through CO-3; §14 written-modification requirement; course of dealing.", color: "chart-1", parentId: "ic_ng_k01" },
  { id: "ic_ng_loss01", matterId: NORTHGATE, code: "LOSS-01", label: "Cargo loss events", description: "September 2025 Joliet losses: chronology, staffing, seals, CCTV.", color: "chart-5" },
  { id: "ic_ng_ind01", matterId: NORTHGATE, code: "IND-01", label: "Indemnity demand", description: "Demand and response correspondence; §11 scope.", color: "chart-3" },
  { id: "ic_ng_dmg01", matterId: NORTHGATE, code: "DMG-01", label: "Damages", description: "Chargebacks, penalties, insurance, lost account.", color: "chart-4" },
  { id: "ic_ng_leg01", matterId: NORTHGATE, code: "LEG-01", label: "Legal advice", description: "Outside counsel communications; litigation hold.", color: "destructive" },
];

const NG_PEOPLE: Person[] = [
  { id: NG_CUSTODIANS.grant.id, name: "Melissa Grant", email: "mgrant@northgatelogistics.com", title: "Vice President, Operations", organization: "Northgate Logistics, Inc.", role: "custodian" },
  { id: NG_CUSTODIANS.salazar.id, name: "Victor Salazar", email: "vsalazar@northgatelogistics.com", title: "Director, Carrier Operations", organization: "Northgate Logistics, Inc.", role: "custodian" },
  { id: NG_CUSTODIANS.whitmore.id, name: "Dana Whitmore", email: "dwhitmore@northgatelogistics.com", title: "Director of Contracts", organization: "Northgate Logistics, Inc.", role: "custodian" },
];

/** Build every seeded document (pure; used by tests as well). */
export function buildSeedDocuments(): EDocument[] {
  const valsara = buildDocs([...VALSARA_DOCS_A, ...VALSARA_DOCS_B], { matterId: VALSARA, prefix: "MFC", start: 41877, tz: "+0530" });
  const ng = buildDocs(NORTHGATE_DOCS, { matterId: NORTHGATE, prefix: "NGL", start: 101 });
  return [...valsara, ...ng];
}

/** Seeded privilege-log entries for privileged documents that have already been through second-level review. */
function buildPrivilegeLog(docs: EDocument[]): PrivilegeLogEntry[] {
  const finalIds = new Set(["ed_vls_0012", "ed_vls_0013", "ed_vls_0016", "ed_vls_0018", "ed_vls_0019", "ed_vls_0036", "ed_vls_0040", "ed_vls_0060", "ed_vls_0067", "ed_vls_kaine_0001", "ed_vls_kaine_0003"]);
  return docs
    .filter((d) => d.coding.privileged === true && finalIds.has(d.id))
    .map((d) => ({
      id: `pl_${d.id}`,
      matterId: d.matterId,
      docId: d.id,
      bates: d.batesEnd ? `${d.bates} – ${d.batesEnd}` : d.bates,
      date: d.date,
      author: d.from ?? d.custodianName,
      recipients: [...(d.to ?? []), ...(d.cc ?? []).map((c) => `${c} (cc)`)],
      docType: d.type,
      basis: d.coding.privilegeBasis === "work-product" ? "Work product" : d.coding.privilegeBasis === "common-interest" ? "Common interest" : d.coding.privilegeBasis === "joint-defense" ? "Joint defense" : "Attorney-client",
      description: templatePrivilegeDescription(d),
      status: "final" as const,
    }));
}

/** E-discovery seed: documents, issue codes, privilege log, coding rules, keyword index. Idempotent. */
export function seedEdiscovery(db: Database) {
  db.people.putMany(NG_PEOPLE);
  const docs = buildSeedDocuments();
  db.edocs.putMany(docs);
  db.issueCodes.putMany([...VALSARA_ISSUE_CODES, ...NORTHGATE_ISSUE_CODES]);
  db.privilegeLog.putMany(buildPrivilegeLog(docs));
  for (const matterId of [VALSARA, NORTHGATE]) {
    if (db.kv.get<string>(CODING_RULES_KEY(matterId)) == null) db.kv.set(CODING_RULES_KEY(matterId), SEED_CODING_RULES[matterId] ?? DEFAULT_CODING_RULES.default);
  }
  // Keyword index (no embeddings without a key); synchronous when embed:false. Scoped to the two seeded matters; every
  // document declares its matterId in meta so the index never binds a row to a matter it did not come from.
  void indexDocuments(VECTOR_COLLECTIONS.edocs, docs.map((d) => ({ id: d.id, text: indexTextFor(d), meta: { matterId: d.matterId, custodianId: d.custodianId, type: d.type, date: d.date, bates: d.bates } })), { embed: false, scope: { tenantId: tenantId(), matterIds: [VALSARA, NORTHGATE] } }).catch((e) => console.error("[seed:ediscovery] index", e));
  seedAnalysis(db);
  seedNearDuplicates(db, docs);
  seedReview(db);
  db.kv.set("ediscovery:review:seed:version", REVIEW_SEED_VERSION);
}

/** Populate MinHash near-duplicate links (and scores) on top of the hand-linked drafts. Exact duplicates are excluded. */
export function seedNearDuplicates(db: Database, docs: EDocument[]) {
  for (const matterId of [VALSARA, NORTHGATE]) {
    const set = docs.filter((d) => d.matterId === matterId);
    const res = detectNearDuplicates(set.map((d) => ({ id: d.id, text: d.text })), { threshold: 0.5 });
    const byId = new Map(set.map((d) => [d.id, d]));
    const map = nearDuplicateMap(res.pairs.filter((p) => { const a = byId.get(p.a), b = byId.get(p.b); return !(a?.isDuplicateOf === p.b || b?.isDuplicateOf === p.a || a?.hash === b?.hash); }));
    const updates: EDocument[] = [];
    for (const d of set) {
      const detected = map.get(d.id) ?? {};
      const ids = Array.from(new Set([...(d.nearDuplicateIds ?? []), ...Object.keys(detected)]));
      if (!ids.length) continue;
      const scores: Record<string, number> = {};
      for (const id of ids) scores[id] = detected[id] ?? 0.9;
      updates.push({ ...d, nearDuplicateIds: ids, nearDuplicateScores: scores });
    }
    if (updates.length) db.edocs.putMany(updates);
  }
}

export { ensureReviewSeeded };

/** Stable ids exported for other modules and tests. */
export const EDISCOVERY_SEED_IDS = {
  valsaraKeyDocs: {
    sundaramReport: "ed_vls_0001", // MFC-0041877
    haleEhsMemo: "ed_vls_0011", // MFC-0041912
    kaineTiming: "ed_vls_0016", // MFC-0041921
    suarez8eMemo: "ed_vls_0018", // MFC-0041930
    mw7Email: "ed_vls_0057", // MFC-0052210
    bioassayInterim: "ed_vls_0066", // MFC-0052226
    navyResponse: "ed_vls_0069", // MFC-0052238
  },
  northgateKeyDocs: { mtsa: "ed_ng_0001", lossReport: "ed_ng_0008", demand: "ed_ng_0012", apexResponse: "ed_ng_0013" },
} as const;
