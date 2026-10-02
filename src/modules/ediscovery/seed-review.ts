import "server-only";
import type { Database } from "@/lib/db";
import type { EDocument, ProductionSet, Redaction, ReviewBatch, SavedSearchRecord } from "@/lib/types/domain";
import { PEOPLE } from "@/lib/seed/ids";
import { VALSARA } from "./seed-helpers";
import { sampleIds, makeQcDecision } from "./batch-pure";
import { assignBates, isProductionReady, productionOrder, qcProduction } from "./production-pure";
import { compareBates } from "./query";
import { batches, productions, redactions, savedSearches } from "./review-store";

export const REVIEW_SEED_VERSION = 1;
const SEED_KEY = "ediscovery:review:seed:version";

export const REVIEW_SEED_IDS = {
  batches: { firstPass: "rb_vls_first_pass_01", kaineSecondPass: "rb_vls_kaine_second_pass", hotQc: "rb_vls_hot_qc" },
  savedSearches: { eightE: "ss_vls_8e", groundwater: "ss_vls_groundwater", navy: "ss_vls_navy", privReview: "ss_vls_priv_review", uncodedEmail: "ss_vls_uncoded_email" },
  production: "pr_vls_vol001",
} as const;

const T0 = "2026-09-10T09:00:00Z";
const T1 = "2026-09-15T16:30:00Z";

function textRange(doc: EDocument, needle: string): { start: number; end: number } | null {
  const i = doc.text.indexOf(needle);
  return i >= 0 ? { start: i, end: i + needle.length } : null;
}

/** Review-workflow seed for the Valsara matter: three batches, five saved searches, a draft production and a few redactions. Idempotent. */
export function seedReview(db: Database) {
  const docs = db.edocs.find((d) => d.matterId === VALSARA).sort((a, b) => compareBates(a.bates, b.bates));
  if (!docs.length) return;
  const byId = new Map(docs.map((d) => [d.id, d]));

  // Batches ------------------------------------------------------------------
  const uncoded = docs.filter((d) => d.coding.responsive == null).map((d) => d.id);
  const firstPass: ReviewBatch = {
    id: REVIEW_SEED_IDS.batches.firstPass, matterId: VALSARA, name: "First pass — Vasudevan & Hegde custodial 01", description: "Tier 2 first-level review of documents without a responsiveness call. Apply the protocol in Codes & privilege → Coding rules.",
    docIds: uncoded, source: { kind: "search", view: "needs_review" }, assigneeId: PEOPLE.eshaMathur, priority: "high", dueAt: "2026-10-03", status: "open",
    qcSamplePercent: 20, qcSampleIds: sampleIds(uncoded, 20, REVIEW_SEED_IDS.batches.firstPass), secondPass: false, qcDecisions: {}, createdBy: PEOPLE.tanmayBhatt, createdAt: T0, updatedAt: T0,
  };
  const kaineIds = docs.filter((d) => d.custodianId === PEOPLE.rohitKapur).map((d) => d.id);
  const kapur: ReviewBatch = {
    id: REVIEW_SEED_IDS.batches.kaineSecondPass, matterId: VALSARA, name: "Second pass — Kapur privilege review", description: "Partner-level second pass of every Kapur custodial document: confirm privilege basis and log descriptions before the privilege log is served.",
    docIds: kaineIds, source: { kind: "search", q: "custodian:kapur" }, assigneeId: PEOPLE.priyaRaman, priority: "normal", dueAt: "2026-10-10", status: "in_progress",
    qcSamplePercent: 0, qcSampleIds: [], secondPass: true, qcDecisions: {}, createdBy: PEOPLE.arjunMehra, createdAt: T0, updatedAt: T1,
  };
  const hotIds = docs.filter((d) => d.coding.hot).map((d) => d.id);
  const hotSample = sampleIds(hotIds, 50, REVIEW_SEED_IDS.batches.hotQc);
  const qcDecisions: ReviewBatch["qcDecisions"] = {};
  hotSample.slice(0, Math.max(1, hotSample.length - 1)).forEach((id, i) => {
    const d = byId.get(id)!;
    // One deliberate disagreement so the report has something to show: the QC reviewer drops the hot flag on the second sample.
    const qc = i === 1 ? { ...d.coding, hot: false } : d.coding;
    qcDecisions[id] = makeQcDecision(d.coding, qc, PEOPLE.arjunMehra, T1);
  });
  const hotQc: ReviewBatch = {
    id: REVIEW_SEED_IDS.batches.hotQc, matterId: VALSARA, name: "QC — hot documents (50% sample)", description: "Quality-control pass over every document flagged hot: half are re-read by a partner and disagreements feed the reviewer calibration meeting.",
    docIds: hotIds, source: { kind: "search", view: "hot" }, assigneeId: PEOPLE.arjunMehra, priority: "normal", dueAt: "2026-09-30", status: "qc",
    qcSamplePercent: 50, qcSampleIds: hotSample, secondPass: false, qcDecisions, createdBy: PEOPLE.tanmayBhatt, createdAt: T0, updatedAt: T1,
  };
  batches().putMany([firstPass, kapur, hotQc]);

  // Saved searches -----------------------------------------------------------
  const ss: SavedSearchRecord[] = [
    { id: REVIEW_SEED_IDS.savedSearches.eightE, matterId: VALSARA, name: "Clause 9.4 decision", description: "Everything touching the substantial-risk notification question (RFP 9–11).", q: '("Clause 9.4" OR "substantial risk") AND (park OR cpcb OR notif*)'.replace("notif*", "notification"), view: undefined, ownerId: PEOPLE.arjunMehra, shared: true, createdAt: T0, updatedAt: T0 },
    { id: REVIEW_SEED_IDS.savedSearches.groundwater, matterId: VALSARA, name: "Valsara groundwater", description: "Monitoring wells, plume and the Park wellfield.", q: '(groundwater OR "monitoring well" OR plume OR wellfield OR MW-7) NOT marketing', ownerId: PEOPLE.eshaMathur, shared: true, createdAt: T0, updatedAt: T0 },
    { id: REVIEW_SEED_IDS.savedSearches.navy, matterId: VALSARA, name: "Defence / DTS qualification", description: "Specification-compliance defence: DQA-T, DTS-24385 and qualification correspondence.", q: "(defence OR \"DQA-T\" OR \"DTS-24385\" OR qualification) hot:yes OR issue:GOV-01", ownerId: PEOPLE.priyaRaman, shared: true, createdAt: T0, updatedAt: T0 },
    { id: REVIEW_SEED_IDS.savedSearches.privReview, matterId: VALSARA, name: "Privilege calls to confirm", description: "Privileged without a work-product basis, or Kapur on cc only.", q: "priv:yes -priv:wp cc:kapur", ownerId: PEOPLE.priyaRaman, shared: false, createdAt: T0, updatedAt: T0 },
    { id: REVIEW_SEED_IDS.savedSearches.uncodedEmail, matterId: VALSARA, name: "Uncoded email with attachments", description: "Email families still needing a decision — code the family together.", q: "type:email hasattachment:yes responsive:none", ownerId: PEOPLE.eshaMathur, shared: true, createdAt: T0, updatedAt: T0 },
  ];
  savedSearches().putMany(ss);

  // Redactions (only where the phrase exists in the seeded text) -------------
  const reds: Redaction[] = [];
  const candidates: { docId: string; needle: string; reason: Redaction["reason"]; label: string; note: string }[] = [
    { docId: "ed_vls_0057", needle: "Lata Fernandes", reason: "pii", label: "REDACTED — PII", note: "Third-party Park water-works employee named in the email; agreed redaction under the ESI protocol §7." },
    { docId: "ed_vls_0011", needle: "Rohit Kapur", reason: "privilege", label: "REDACTED — PRIVILEGED", note: "Reference to counsel's advice within an otherwise responsive EHS memo." },
    { docId: "ed_vls_0008", needle: "Deepa Krishnan", reason: "pii", label: "REDACTED — PII", note: "Personal contact details of a former employee." },
  ];
  for (const c of candidates) {
    const d = byId.get(c.docId);
    if (!d) continue;
    const r = textRange(d, c.needle);
    if (!r) continue;
    reds.push({ id: `rd_seed_${c.docId}`, matterId: VALSARA, docId: c.docId, kind: "text", start: r.start, end: r.end, reason: c.reason, label: c.label, note: c.note, quote: c.needle, createdBy: PEOPLE.meeraLobo, createdAt: T1 });
  }
  const pageDoc = byId.get("ed_vls_0001");
  if (pageDoc) reds.push({ id: "rd_seed_ed_vls_0001_p2", matterId: VALSARA, docId: "ed_vls_0001", kind: "page", page: Math.min(2, pageDoc.pages ?? 1), rect: { x: 0.08, y: 0.62, w: 0.84, h: 0.09 }, reason: "trade-secret", label: "REDACTED — TRADE SECRET", note: "Formulation ratio table; redacted per protective order ¶ 12.", createdBy: PEOPLE.meeraLobo, createdAt: T1 });
  redactions().putMany(reds);

  // Draft production ---------------------------------------------------------
  const ready = productionOrder(docs.filter(isProductionReady));
  const { bates } = assignBates(ready, { prefix: "MERIDIAN", padding: 7, startNumber: 1 });
  const prod: ProductionSet = {
    id: REVIEW_SEED_IDS.production, matterId: VALSARA, name: "Production 1 — responsive custodial set", volume: "VOL001", status: "draft", prefix: "MERIDIAN", padding: 7, startNumber: 1,
    stampText: "CONFIDENTIAL — SUBJECT TO PROTECTIVE ORDER (Arb. Ref. 14/2024)", docIds: ready.map((d) => d.id), bates, source: { kind: "all" }, createdBy: PEOPLE.tanmayBhatt, createdAt: T1, updatedAt: T1,
    notes: "Rolling production 1 under Procedural Order No. 3. Exact duplicates suppressed; near-duplicates produced with their families.",
  };
  prod.qc = qcProduction({ production: prod, docs, redactions: reds }, T1);
  productions().put(prod);
}

/** Older databases (seeded before the review workflow existed) get the review records on first use. */
export function ensureReviewSeeded(db: Database) {
  if (db.kv.get<number>(SEED_KEY) === REVIEW_SEED_VERSION) return;
  seedReview(db);
  db.kv.set(SEED_KEY, REVIEW_SEED_VERSION);
}
