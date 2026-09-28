import "server-only";
import type { Database } from "@/lib/db";
import type { Workflow, WorkflowRunStep } from "@/lib/types/domain";
import { MATTERS, PEOPLE } from "@/lib/seed/ids";
import { buildTemplates, buildUsTemplates, WORKFLOW_TEMPLATE_IDS as T } from "./templates";
import { buildUsSystemTemplates, SYSTEM_WORKFLOW_IDS as S } from "./templates-system";
import type { RunApproval, RunArtifact, RunOutput, RunUsage, WorkflowRunRecord } from "./types";

const P = PEOPLE;
const M = MATTERS;

export const WORKFLOW_SEED_IDS = {
  workflows: {
    afffDocketMonitor: "wf_afff_docket_monitor",
    afffPrivilegeLog: "wf_afff_privilege_log",
    northgateCiteCheck: "wf_northgate_cite_check",
    firmRegulatoryWatch: "wf_firm_regulatory_watch",
    harborNdaReview: "wf_harbor_nda_review",
    afffDepoDigest: "wf_afff_depo_digest",
    sterlingPaga: "wf_sterling_paga_response",
    northgateResearch: "wf_northgate_research_memo",
    afffClientStatus: "wf_afff_client_status",
    afffChronology: "wf_afff_chronology",
    harborClauseWorkbook: "wf_harbor_clause_workbook",
  },
  runs: Array.from({ length: 13 }, (_, i) => `run_seed_${String(i + 1).padStart(2, "0")}`),
  /** Run history of the system (automation) workflows. */
  systemRuns: Array.from({ length: 5 }, (_, i) => `run_sys_${String(i + 1).padStart(2, "0")}`),
} as const;

const W = WORKFLOW_SEED_IDS.workflows;

// ─────────────────────────── User workflows (cloned from templates) ───────────────────────────

interface UserWf { id: string; templateId: string; name: string; description?: string; ownerId: string; status: Workflow["status"]; createdAt: string; updatedAt: string; tags?: string[]; patch?: (w: Workflow) => void }

const USER_WORKFLOWS: UserWf[] = [
  { id: W.afffDocketMonitor, templateId: T.docketMonitor, name: "AFFF docket monitor (D.S.C.)", description: "Daily 07:00 sweep of MDL 2873 and related D.S.C. dockets for Meridian Fluorochem; opens a task per new filing for Maria.", ownerId: P.jordanWhitfield, status: "active", createdAt: "2026-07-14T14:20:00.000Z", updatedAt: "2026-09-02T09:05:00.000Z", tags: ["docket", "MDL 2873", "scheduled"] },
  { id: W.afffPrivilegeLog, templateId: T.privilegeLog, name: "Kaine / Suarez privilege log", description: "Builds CMO 26 Ex. B–format log entries for the Kaine–Suarez § 8(e) legal-advice thread.", ownerId: P.elenaMarsh, status: "active", createdAt: "2026-09-16T15:10:00.000Z", updatedAt: "2026-09-19T10:42:00.000Z", tags: ["privilege", "MDL 2873"], patch: (w) => { const n = w.nodes.find((x) => x.id === "search"); if (n) n.config.custodian = "Kaine"; } },
  { id: W.northgateCiteCheck, templateId: T.citeCheck, name: "Northgate MSJ cite-check", description: "Runs on every saved draft of the MSJ opposition; flags unresolved reporter cites and pin-cite gaps before Elena's final pass.", ownerId: P.danielOkafor, status: "active", createdAt: "2026-09-10T11:00:00.000Z", updatedAt: "2026-09-22T19:00:00.000Z", tags: ["cite-check", "Northgate"] },
  { id: W.firmRegulatoryWatch, templateId: T.regulatoryWatch, name: "PFAS regulatory watch", description: "Weekly Federal Register sweep for PFAS / PFOA / PFOS documents from EPA; digest to the AFFF team and KM.", ownerId: P.aishaKhan, status: "active", createdAt: "2026-06-23T08:00:00.000Z", updatedAt: "2026-08-04T08:30:00.000Z", tags: ["regulatory", "PFAS", "scheduled"] },
  { id: W.harborNdaReview, templateId: T.ndaIntake, name: "Project Harbor NDA intake", description: "Counterparty NDAs arriving through the Harborline deal team; routes high-risk terms to Daniel same day.", ownerId: P.danielOkafor, status: "active", createdAt: "2026-07-20T10:00:00.000Z", updatedAt: "2026-09-11T16:20:00.000Z", tags: ["NDA", "Project Harbor"] },
  { id: W.afffDepoDigest, templateId: T.depoDigest, name: "AFFF deposition digest", description: "Rough-transcript digest for MDL 2873 custodian depositions.", ownerId: P.priyaRaman, status: "active", createdAt: "2026-08-28T13:00:00.000Z", updatedAt: "2026-09-08T09:15:00.000Z", tags: ["deposition", "MDL 2873"] },
  { id: W.sterlingPaga, templateId: T.pagaChecklist, name: "Sterling PAGA notice response", ownerId: P.samuelChen, status: "active", createdAt: "2026-08-20T09:30:00.000Z", updatedAt: "2026-08-25T17:45:00.000Z", tags: ["PAGA", "Sterling"] },
  { id: W.northgateResearch, templateId: T.researchMemo, name: "Northgate research memos", description: "Research memos for the Seventh Circuit / Illinois issues in the MSJ briefing; partner approval before circulation.", ownerId: P.danielOkafor, status: "active", createdAt: "2026-09-12T12:00:00.000Z", updatedAt: "2026-09-15T13:20:00.000Z", tags: ["research", "Northgate"] },
  { id: W.afffClientStatus, templateId: T.clientStatus, name: "AFFF weekly client report", description: "Friday status report to Meridian Fluorochem's legal department.", ownerId: P.jordanWhitfield, status: "active", createdAt: "2026-08-01T15:00:00.000Z", updatedAt: "2026-09-05T10:00:00.000Z", tags: ["client", "MDL 2873"] },
  { id: W.afffChronology, templateId: T.chronology, name: "AFFF chronology builder", ownerId: P.elenaMarsh, status: "active", createdAt: "2026-09-04T09:00:00.000Z", updatedAt: "2026-09-18T11:30:00.000Z", tags: ["chronology", "MDL 2873"] },
  { id: W.harborClauseWorkbook, templateId: T.clauseWorkbook, name: "Harbor customer-contract review", description: "Top-20 customer contracts for the Bluewater diligence: change-of-control, exclusivity, liability caps into the tracker.", ownerId: P.samuelChen, status: "draft", createdAt: "2026-09-15T08:00:00.000Z", updatedAt: "2026-09-17T14:10:00.000Z", tags: ["diligence", "Project Harbor"] },
];

// ─────────────────────────── Runs ───────────────────────────

interface StepSpec { nodeId: string; status: WorkflowRunStep["status"]; secs?: number; output?: unknown; logs?: string[]; tokens?: number; error?: string; iteration?: boolean }
interface RunSpec {
  id: string; workflowId: string; workflowName: string; category: Workflow["category"]; status: WorkflowRunRecord["status"];
  startedAt: string; triggeredBy: WorkflowRunRecord["triggeredBy"]; triggeredById?: string; matterId?: string;
  inputs: Record<string, unknown>; steps: StepSpec[]; artifacts?: (Omit<RunArtifact, "nodeId"> & { nodeId?: string })[];
  approvals?: RunApproval[]; usage?: Partial<RunUsage>; error?: string; errorCode?: string; loopIterations?: WorkflowRunRecord["loopIterations"];
  stewardship?: WorkflowRunRecord["stewardship"]; logs?: string[];
}

function iso(base: string, plusSec: number) { return new Date(new Date(base).getTime() + plusSec * 1000).toISOString(); }

function mkRun(spec: RunSpec, workflow: Workflow): WorkflowRunRecord {
  let t = 0;
  const steps: WorkflowRunStep[] = spec.steps.map((s) => {
    const startedAt = ["pending", "skipped"].includes(s.status) ? undefined : iso(spec.startedAt, t);
    const dur = s.secs ?? 0;
    if (startedAt) t += dur;
    const finishedAt = startedAt && s.status !== "running" && s.status !== "waiting_approval" ? iso(spec.startedAt, t) : undefined;
    return { nodeId: s.nodeId, status: s.status, startedAt, finishedAt, output: s.output, logs: s.logs, tokens: s.tokens, error: s.error };
  });
  // Any workflow node without an explicit step gets a sensible default.
  for (const n of workflow.nodes) if (!steps.some((s) => s.nodeId === n.id)) steps.push({ nodeId: n.id, status: spec.status === "succeeded" ? "skipped" : "pending" });
  const finished = ["succeeded", "failed", "cancelled"].includes(spec.status);
  const finishedAt = finished ? iso(spec.startedAt, t + 1) : undefined;
  const usage: RunUsage = { input: 0, output: 0, total: 0, calls: 0, costUsd: 0, ...(spec.usage ?? {}) };
  const outputs: Record<string, unknown> = {};
  for (const s of steps) if (s.status === "succeeded" && !s.nodeId.startsWith("start") && s.nodeId !== "schedule") outputs[s.nodeId] = s.output;
  return {
    id: spec.id,
    workflowId: spec.workflowId,
    workflowName: spec.workflowName,
    workflowCategory: spec.category,
    status: spec.status,
    inputs: spec.inputs,
    steps,
    outputs: spec.status === "succeeded" ? outputs : undefined,
    startedAt: spec.startedAt,
    finishedAt,
    updatedAt: finishedAt ?? iso(spec.startedAt, t),
    durationMs: finishedAt ? new Date(finishedAt).getTime() - new Date(spec.startedAt).getTime() : undefined,
    triggeredBy: spec.triggeredBy,
    triggeredById: spec.triggeredById ?? (spec.triggeredBy === "schedule" ? undefined : P.jordanWhitfield),
    matterId: spec.matterId,
    usage,
    artifacts: (spec.artifacts ?? []).map((a) => ({ ...a, nodeId: a.nodeId ?? "" })) as RunArtifact[],
    approvals: spec.approvals ?? [],
    error: spec.error,
    errorCode: spec.errorCode,
    loopIterations: spec.loopIterations,
    stewardship: spec.stewardship,
    logs: spec.logs,
    handoffs: [],
    deliverables: deliverablesOf(steps, workflow, spec.startedAt),
    childRunIds: [],
    snapshot: { nodes: workflow.nodes, edges: workflow.edges, inputs: workflow.inputs, frontend: workflow.frontend },
  };
}

/** Deliverables a seeded run produced: every succeeded output.file / save_document / export step with a link becomes a RunOutput. */
function deliverablesOf(steps: WorkflowRunStep[], workflow: Workflow, startedAt: string): RunOutput[] {
  const out: RunOutput[] = [];
  for (const s of steps) {
    if (s.status !== "succeeded" || !s.output || typeof s.output !== "object") continue;
    const node = workflow.nodes.find((n) => n.id === s.nodeId);
    if (!node || !["output.file", "action.save_document", "action.export"].includes(node.type)) continue;
    const o = s.output as Record<string, unknown>;
    const href = typeof o.href === "string" ? o.href : undefined;
    const url = typeof o.url === "string" ? o.url : undefined;
    if (!href && !url) continue;
    const format = typeof o.format === "string" ? o.format : o.kind === "sheet" ? "xlsx" : o.kind === "word" ? "docx" : undefined;
    out.push({ id: `out_seed_${s.nodeId}_${out.length + 1}`, kind: o.docId ? "document" : "file", format, title: String(o.title ?? o.label ?? o.filename ?? node.label), href: href ?? url, downloadHref: url, blobId: typeof o.blobId === "string" ? o.blobId : undefined, docId: typeof o.docId === "string" ? o.docId : undefined, matterId: undefined, nodeId: s.nodeId, at: s.finishedAt ?? startedAt, meta: { source: node.type } });
  }
  return out;
}

const DOCKET_RESULTS_0922 = [
  { case_name: "In re: Aqueous Film-Forming Foams Products Liability Litigation", docket_number: "2:18-mn-02873", court: "District Court, D. South Carolina", court_id: "dsc", date_filed: "2026-09-21", assigned_to: "Richard Mark Gergel", nature_of_suit: "365 Personal Injury: Product Liability", docket_id: 6524213, url: "https://www.courtlistener.com/docket/6524213/in-re-aqueous-film-forming-foams-products-liability-litigation/" },
  { case_name: "City of Stuart v. 3M Company et al.", docket_number: "2:18-cv-03487", court: "District Court, D. South Carolina", court_id: "dsc", date_filed: "2026-09-21", assigned_to: "Richard Mark Gergel", nature_of_suit: "365 Personal Injury: Product Liability", docket_id: 6800112, url: "https://www.courtlistener.com/docket/6800112/city-of-stuart-v-3m-company/" },
];

const PRIV_DOCS = [
  { id: "ed_afff_kaine_0001", bates: "MFC-0043877", date: "2016-08-19", custodian: "Robert Kaine", type: "Email", subject: "RE: 8(e) — recommendation for the Tuesday call", from: "Robert Kaine", to: ["Martin Suarez"], passage: "Martin — per our discussion, my recommendation on the substantial-risk question is set out below. Please treat this as privileged and do not forward to the product team…", coding: { privileged: true, privilegeBasis: "attorney-client", responsive: true } },
  { id: "ed_afff_kaine_0002", bates: "MFC-0043881", date: "2016-08-22", custodian: "Robert Kaine", type: "Email", subject: "FW: Voss August summary — legal review", from: "Martin Suarez", to: ["Robert Kaine"], cc: ["Gregory Hale"], passage: "Rob, attaching Helen's summary. I need your read on whether the hepatic findings change the analysis we discussed…", coding: { privileged: true, privilegeBasis: "attorney-client", responsive: true } },
  { id: "ed_afff_kaine_0003", bates: "MFC-0043902", date: "2016-09-06", custodian: "Robert Kaine", type: "Memo", subject: "Privileged & Confidential — TSCA § 8(e) analysis (draft)", from: "Robert Kaine", to: ["Martin Suarez"], passage: "DRAFT — ATTORNEY WORK PRODUCT. This memorandum analyzes whether the information described in the August 2016 EHS memorandum triggers a reporting obligation…", coding: { privileged: true, privilegeBasis: "work-product", responsive: true } },
  { id: "ed_afff_kaine_0004", bates: "MFC-0043918", date: "2016-09-09", custodian: "Robert Kaine", type: "Email", subject: "RE: Privileged — outside counsel engagement", from: "Robert Kaine", to: ["Martin Suarez", "Alan Pryce"], passage: "Alan, we are retaining outside regulatory counsel to advise on the question Martin raised. Until then please route questions through Legal…", coding: { privileged: true, privilegeBasis: "attorney-client", responsive: true } },
  { id: "ed_afff_kaine_0005", bates: "MFC-0043944", date: "2016-09-27", custodian: "Robert Kaine", type: "Email", subject: "Outside counsel advice — 8(e) (privileged)", from: "Robert Kaine", to: ["Martin Suarez"], passage: "Summary of the advice received this morning, for our internal deliberation only…", coding: { privileged: true, privilegeBasis: "attorney-client", responsive: true } },
  { id: "ed_afff_kaine_0006", bates: "MFC-0043951", date: "2016-10-03", custodian: "Robert Kaine", type: "Email", subject: "RE: Decision memo — final", from: "Martin Suarez", to: ["Robert Kaine"], passage: "Rob — final version attached reflecting your edits. I will brief Alan verbally per your guidance…", coding: { privileged: true, privilegeBasis: "attorney-client", responsive: true } },
];

const PRIV_ENTRIES = PRIV_DOCS.map((d, i) => ({
  bates: d.bates, date: d.date, doc_type: d.type, author: d.from, recipients: [...d.to, ...("cc" in d && d.cc ? d.cc : [])].join("; "), attorney: "Robert Kaine, Associate General Counsel",
  privilege_type: d.coding.privilegeBasis === "work-product" ? "Attorney-Client; Work Product" : "Attorney-Client",
  description: [
    "Email requesting and reflecting legal advice of in-house counsel (R. Kaine, AGC) regarding regulatory reporting obligations under TSCA § 8(e).",
    "Email chain forwarding scientific summary to in-house counsel for the purpose of obtaining legal advice regarding regulatory reporting obligations; reflects request for legal advice.",
    "Draft memorandum prepared by in-house counsel (R. Kaine, AGC) analyzing regulatory reporting obligations, prepared in anticipation of litigation and reflecting counsel's mental impressions.",
    "Email from in-house counsel (R. Kaine, AGC) to client representatives regarding the retention of outside regulatory counsel and the handling of related communications.",
    "Email reflecting legal advice of outside regulatory counsel, as summarized by in-house counsel (R. Kaine, AGC), regarding regulatory reporting obligations.",
    "Email transmitting final version of privileged legal memorandum reflecting edits of in-house counsel (R. Kaine, AGC) and legal advice regarding regulatory reporting obligations.",
  ][i],
  basis: d.coding.privilegeBasis === "work-product" ? "Attorney work product (Fed. R. Civ. P. 26(b)(3)); attorney-client privilege" : "Attorney-client privilege (communication between counsel and client representatives for the purpose of obtaining/rendering legal advice)",
  withheld: i === 1 ? "Redacted" : "Withheld in full",
}));

const FR_RESULTS = [
  { title: "Per- and Polyfluoroalkyl Substances (PFAS); Toxic Substances Control Act Section 8(a)(7) Reporting and Recordkeeping Requirements; Amendments to Submission Period", type: "Rule", agencies: ["Environmental Protection Agency"], published: "2026-09-16", citation: "91 FR 45812", document_number: "2026-19822", effective_on: "2026-10-16", url: "https://www.federalregister.gov/documents/2026/09/16/2026-19822/", abstract: "EPA is amending the TSCA section 8(a)(7) PFAS reporting rule to modify the submission period for manufacturers and importers and to add a de minimis article exemption." },
  { title: "Designation of Perfluorooctanoic Acid (PFOA) and Perfluorooctanesulfonic Acid (PFOS) as CERCLA Hazardous Substances; Request for Comment on Enforcement Discretion Policy", type: "Notice", agencies: ["Environmental Protection Agency"], published: "2026-09-18", citation: "91 FR 46110", document_number: "2026-20015", comments_close_on: "2026-11-02", url: "https://www.federalregister.gov/documents/2026/09/18/2026-20015/", abstract: "EPA requests comment on a proposed policy describing how the Agency intends to exercise enforcement discretion for passive receivers, including water utilities and airports, under CERCLA." },
  { title: "National Primary Drinking Water Regulations: PFAS; Compliance Date Extension for Small Systems", type: "Proposed Rule", agencies: ["Environmental Protection Agency"], published: "2026-09-19", citation: "91 FR 46340", document_number: "2026-20188", comments_close_on: "2026-10-19", url: "https://www.federalregister.gov/documents/2026/09/19/2026-20188/", abstract: "EPA proposes to extend the compliance date for systems serving fewer than 3,300 persons to April 2031 and to clarify monitoring flexibilities." },
];

const REG_SUMMARY = `**Bottom line.** Three EPA PFAS actions this week; the CERCLA enforcement-discretion notice (91 FR 46110) is the one that matters for Meridian Fluorochem: it signals that water utilities and airports will be shielded, which keeps cost-recovery pressure on manufacturers and is likely to be cited by the water-provider plaintiffs in MDL 2873.

**What changed**
- **TSCA § 8(a)(7) reporting amendments (91 FR 45812, final, effective Oct 16, 2026).** Submission period modified; de minimis article exemption added. Meridian's 2011–2022 AFFF production data remain reportable; confirm the regulatory affairs team's submission timeline.
- **CERCLA PFOA/PFOS enforcement discretion (91 FR 46110, notice, comments due Nov 2, 2026).** Proposed policy protects "passive receivers." Expect plaintiffs to argue the policy confirms manufacturers are the intended cost bearers. Consider a comment through the industry coalition.
- **Drinking-water rule compliance extension for small systems (91 FR 46340, proposed, comments due Oct 19, 2026).** Extends the small-system compliance date to April 2031. Relevant to damages models for the Group C water-provider bellwethers (several are systems under 3,300 persons).

**Consequences for the matter**
1. Update the regulatory chronology (Elena) with all three entries.
2. Ask Dr. Patel whether the small-system extension changes the remediation-timing assumptions in Section 4.3 of plaintiffs' hydrogeology report.
3. Decide by Oct 9 whether to join a coalition comment on the enforcement-discretion policy.`;

const NDA_EXTRACT_SNOWFIELD = {
  parties: ["Harborline Technologies, Inc.", "Snowfield Reseller LLC"],
  effective_date: "2026-09-15", term_months: 36, confidentiality_period_months: 0, governing_law: "Delaware", venue: "State and federal courts located in Wilmington, Delaware", purpose: "Evaluating a potential commercial relationship relating to the resale of analytics software", mutual: true, non_solicit: true, residuals_clause: true, injunctive_relief: true,
  assignment_restriction: "No assignment without prior written consent, except to an affiliate or a successor in a merger or sale of substantially all assets (§ 9.2)",
  standard_carve_outs: ["public", "already known", "independently developed", "third-party source", "compelled disclosure"],
  unusual_terms: ["Residuals clause (§ 4.3) permits use of information retained in unaided memory", "Perpetual confidentiality for all information, not limited to trade secrets (§ 5.1)", "12-month mutual employee non-solicit (§ 7)"],
  _evidence: [{ field: "residuals_clause", quote: "Recipient shall be free to use for any purpose Residuals resulting from access to the Confidential Information… 'Residuals' means information retained in the unaided memory of Recipient's personnel", confidence: 0.98 }, { field: "confidentiality_period_months", quote: "The obligations under Section 5 shall survive termination of this Agreement indefinitely", confidence: 0.95 }, { field: "non_solicit", quote: "For a period of twelve (12) months following the Effective Date, neither party shall directly solicit for employment any employee of the other party", confidence: 0.97 }],
};

const NDA_MEMO_SNOWFIELD = `# NDA Review — Snowfield Reseller LLC (Project Harbor)

**TO:** Daniel Okafor · **FROM:** Workflow: Project Harbor NDA intake · **DATE:** September 18, 2026 · **RE:** Mutual NDA between Harborline Technologies, Inc. and Snowfield Reseller LLC

## 1. Bottom line

Sign with edits. The agreement is a mutual form with standard carve-outs, but three terms need changes before signature because Harborline will be the primary *disclosing* party in the reseller discussions: the residuals clause (§ 4.3), the perpetual confidentiality term applied to all information (§ 5.1), and the 12-month non-solicit (§ 7). Risk: **MEDIUM**.

## 2. Deal terms

| Term | As drafted | Firm position | Recommended edit |
| --- | --- | --- | --- |
| Term | 36 months (§ 2) | 2–3 years | Accept |
| Confidentiality survival | Indefinite for all information (§ 5.1) | 5 years; trade secrets for so long as they qualify | Replace § 5.1 with the firm's two-tier survival clause |
| Residuals | Permitted (§ 4.3) | Not accepted when client is disclosing party | Delete § 4.3 or limit to general know-how excluding source code, model weights and customer data |
| Non-solicit | 12-month mutual (§ 7) | Not in NDAs | Delete; if Snowfield insists, carve out general solicitations and cap at 6 months |
| Governing law / venue | Delaware / Wilmington (§ 11) | DE acceptable | Accept |
| Injunctive relief | Stipulated irreparable harm (§ 10) | Acceptable, mutual | Accept |
| Assignment | Consent required; M&A exception (§ 9.2) | Acceptable | Accept; confirm the Bluewater transaction falls within the exception |

## 3. Issues

1. **Residuals clause (§ 4.3) — high.** "Recipient shall be free to use for any purpose Residuals resulting from access to the Confidential Information." Harborline will disclose product roadmaps and model-performance data. A residuals clause converts the NDA into a near-license for anything Snowfield's engineers remember. Delete, or narrow to general skills and know-how with an express exclusion for source code, model weights, pricing and customer information.
2. **Perpetual confidentiality (§ 5.1) — medium.** Indefinite obligations for non-trade-secret information are unenforceable in some jurisdictions and invite a later argument that the whole clause fails. Use the two-tier survival language from the clause bank (5 years / trade secrets indefinitely).
3. **Non-solicit (§ 7) — medium.** Twelve months, mutual, no general-solicitation carve-out. Harborline's hiring plan for the Bluewater integration makes this a live constraint. Delete, or narrow.

## 4. Items for client

- Confirm Harborline will not receive Snowfield customer lists (if it will, keep § 4.3 out of the deal regardless).
- Confirm the acquisition of Bluewater Analytics is covered by the § 9.2 successor exception.`;

const RESEARCH_MEMO_NG = `# Research memo — Consequential-damages waivers and willful breach under Illinois law

**Question presented.** In *Northgate Logistics, Inc. v. Apex Freight Systems, LLC* (N.D. Ill.), does the consequential-damages waiver in § 12.3 of the Master Transportation Services Agreement bar Northgate's lost-profit claims where the trier of fact finds Apex's breach was willful?

**Bottom line.** Probably not as to *willful* or *bad-faith* breaches, but the argument is narrower than it sounds. Illinois enforces consequential-damages waivers between sophisticated commercial parties as written, and the Seventh Circuit has rejected a free-floating "willfulness" exception. The viable path is (1) the UCC Article 2 analogy is unavailable (this is a services contract), so the "failure of essential purpose" doctrine does not apply directly; (2) Illinois public policy will not enforce an exculpatory clause against *intentional* or *fraudulent* misconduct; and (3) the cross-dock temperature-log evidence (Dempsey 30(b)(6) Tr. 142:8–143:2) supports a finding that Apex knowingly disregarded its handling obligations, which frames the claim as intentional misconduct rather than ordinary breach. [VERIFY pin cites before filing.]

**Analysis.**

1. *Waivers are enforced as written.* Illinois courts give effect to limitation-of-liability clauses negotiated between commercial parties. See *Rayner Covering Sys., Inc. v. Danvers Farmers Elevator Co.*, 226 Ill. App. 3d 507, 512 (2d Dist. 1992); *Sun-Times Media Group v. Royal & SunAlliance*, No. 06 C 4413, 2007 WL 1811265 (N.D. Ill. June 21, 2007) [VERIFY]. The Seventh Circuit follows the same rule. *Bentley v. Great Lakes Collection Bureau* is not on point; the controlling decisions are *Dana Corp. v. IPC Ltd. P'ship* and *Bunge Corp. v. Northern Trust Co.* [VERIFY].

2. *No general willfulness exception.* Courts applying Illinois law decline to read an implied "willful breach" exception into a bargained-for damages limitation. See *Trans-Tec Corp. v. LaSalle Nat'l Bank*, 1993 WL 32676 (N.D. Ill.) [VERIFY].

3. *Intentional misconduct and fraud.* Illinois will not enforce exculpatory language to excuse intentional torts, fraud or willful and wanton misconduct. *Harris v. Walker*, 119 Ill. 2d 542, 548 (1988) (exculpatory agreements); *Zimmerman v. Northfield Real Estate*, 156 Ill. App. 3d 154, 163 (1st Dist. 1986). Whether the waiver is "exculpatory" or a mere limitation is the fight; the record on the Joliet cross-dock logs matters more than the label.

**Authorities relied on.**
- *Harris v. Walker*, 119 Ill. 2d 542 (1988) — exculpatory clauses not enforced against willful and wanton conduct.
- *Rayner Covering Sys. v. Danvers Farmers Elevator*, 226 Ill. App. 3d 507 (1992) — consequential-damages waiver enforced between merchants.
- *Zimmerman v. Northfield Real Estate*, 156 Ill. App. 3d 154 (1986) — fraud not shielded by contractual limitation.

**Open questions / next steps.**
1. Confirm whether § 12.3 is drafted as a cap or an exclusion; the intentional-misconduct argument is stronger against an exclusion.
2. Pull the Dempsey exhibits on the temperature logs to establish knowledge.
3. Shepardize every case above (two were located through search results only).`;

const CLIENT_REPORT_AFFF = `# Weekly status report — In re: AFFF Products Liability Litigation (MDL No. 2873)

**Prepared for:** Meridian Fluorochem Corp., Legal Department · **Week ending:** September 18, 2026 · **From:** Seeger Weiss LLP

## Summary

Custodial document review for the Tier 2 production is 71% complete and on schedule for the October 14 deadline. The Hale Volume II deposition is set for September 24; preparation sessions were completed this week. Expert rebuttal work continues with Dr. Whitfield (toxicology) and Dr. Patel (hydrogeology); drafts remain on track for the November 6 deadline.

## Recent developments

- **Tier 2 production.** Second-level review of the Hale custodial set is underway; privilege log entries for the Kaine–Suarez legal-advice thread are being finalized in the CMO 26 format.
- **Meet and confer.** We conferred with plaintiffs' counsel on September 17 regarding custodial date ranges. Plaintiffs asked to extend the Hale and Voss collections back to January 2012; we have proposed keeping the CMO 26 start date (2014) in exchange for adding Martin Suarez for 2018–2020. A follow-up call is scheduled for September 25.
- **Docket.** CMO 31 (ECF 6120) entered, setting the Group C bellwether schedule: Daubert motions December 18, 2026; trial March 8, 2027.

## Upcoming deadlines (next 30 days)

| Date | Event |
| --- | --- |
| Sept 24 | Deposition of Gregory Hale (Vol. II) |
| Sept 25 | Meet and confer with PEC: custodians and date ranges |
| Oct 1 | Deposition of Helen Voss (defending) |
| Oct 7 | Deposition of Alan Pryce (defending) |
| Oct 9 | MDL status conference (Judge Gergel) |
| Oct 14 | Tier 2 production deadline |

## Decisions needed from you

1. **Suarez custodial add (2018–2020).** We recommend agreeing to it as the trade for holding the 2014 start date. Please confirm by September 24.
2. **Coalition comment on EPA's CERCLA enforcement-discretion policy.** Comments are due November 2; a decision on whether to participate is needed by October 9.

## 30-day look-ahead

Voss and Pryce depositions (defending), Tier 2 production QC and delivery, rebuttal expert report drafting, Science Day logistics for the October 9 status conference.`;

function runs(workflows: Map<string, Workflow>): WorkflowRunRecord[] {
  const R = WORKFLOW_SEED_IDS.runs;
  const specs: RunSpec[] = [
    // 1 — docket monitor, scheduled, 2 new entries
    {
      id: R[0], workflowId: W.afffDocketMonitor, workflowName: "AFFF docket monitor (D.S.C.)", category: "operations", status: "succeeded", startedAt: "2026-09-22T11:00:04.000Z", triggeredBy: "schedule", matterId: M.afff,
      inputs: { docket_query: "Meridian Fluorochem AFFF", courts: "dsc", matter: M.afff, __event: { scheduledFor: "2026-09-22T11:00:00.000Z", frequency: "daily" } },
      steps: [
        { nodeId: "schedule", status: "succeeded", secs: 0, output: { inputs: { docket_query: "Meridian Fluorochem AFFF", courts: "dsc" }, startedAt: "2026-09-22T11:00:04.000Z", triggeredBy: "schedule", scheduledFor: "2026-09-22T11:00:00.000Z", frequency: "daily" } },
        { nodeId: "search", status: "succeeded", secs: 3, output: { source: "dockets", query: "Meridian Fluorochem AFFF", total: 2, results: DOCKET_RESULTS_0922, text: DOCKET_RESULTS_0922.map((d) => `- **${d.case_name}** · ${d.docket_number} · ${d.court} · filed ${d.date_filed} · ${d.assigned_to} — ${d.url}`).join("\n"), citations: [] }, logs: ["2 result(s) from dockets"] },
        { nodeId: "any_new", status: "succeeded", secs: 0, output: { matched: "yes", label: "New entries", evaluations: [{ ruleId: "yes", label: "New entries", matched: true, conditions: [{ left: 2, op: "gt", right: "0", result: true }] }] }, logs: ['Matched "New entries"'] },
        { nodeId: "each", status: "succeeded", secs: 1, output: { count: 2, total: 2, results: DOCKET_RESULTS_0922.map((d, i) => ({ index: i, item: d, steps: { task: { taskId: `t_wf_dk_${i + 1}`, title: `Docket: ${d.case_name} — ${d.docket_number} (${d.date_filed})`, dueAt: "2026-09-23", assignee: "Maria Lopez", href: `/?task=t_wf_dk_${i + 1}` } } })), errors: [], errorCount: 0 }, logs: ["2 docket entry(s) to process"] },
        { nodeId: "task", status: "succeeded", secs: 0, output: { taskId: "t_wf_dk_2", title: "Docket: City of Stuart v. 3M Company et al. — 2:18-cv-03487 (2026-09-21)", dueAt: "2026-09-23", assignee: "Maria Lopez", href: "/?task=t_wf_dk_2" }, logs: ['Task "Docket: City of Stuart v. 3M Company et al. — 2:18-cv-03487 (2026-09-21)" → Maria Lopez, due 2026-09-23'] },
        { nodeId: "digest", status: "succeeded", secs: 0, output: { notificationId: "wn_seed_01", updateId: "tu_wf_seed_01", recipients: [P.jordanWhitfield, P.mariaLopez], channel: "in-app" }, logs: ["Notified Jordan Whitfield, Maria Lopez"] },
      ],
      artifacts: [
        { kind: "task", id: "t_wf_dk_1", title: "Docket: In re: Aqueous Film-Forming Foams Products Liability Litigation — 2:18-mn-02873 (2026-09-21)", href: "/?task=t_wf_dk_1", nodeId: "task", meta: { dueAt: "2026-09-23", assignee: "Maria Lopez" } },
        { kind: "task", id: "t_wf_dk_2", title: "Docket: City of Stuart v. 3M Company et al. — 2:18-cv-03487 (2026-09-21)", href: "/?task=t_wf_dk_2", nodeId: "task", meta: { dueAt: "2026-09-23", assignee: "Maria Lopez" } },
        { kind: "notification", id: "wn_seed_01", title: "Docket monitor: 2 new item(s) for \"Meridian Fluorochem AFFF\" since yesterday.", href: "/", nodeId: "digest" },
      ],
      loopIterations: { each: DOCKET_RESULTS_0922.map((d, i) => ({ index: i, item: d, steps: { task: { nodeId: "task", status: "succeeded", startedAt: iso("2026-09-22T11:00:07.000Z", i), finishedAt: iso("2026-09-22T11:00:07.000Z", i + 0.2), output: { taskId: `t_wf_dk_${i + 1}`, title: `Docket: ${d.case_name} — ${d.docket_number} (${d.date_filed})`, dueAt: "2026-09-23", assignee: "Maria Lopez", href: `/?task=t_wf_dk_${i + 1}` }, logs: [`Task → Maria Lopez, due 2026-09-23`] } } })) },
    },
    // 2 — docket monitor, scheduled, nothing new
    {
      id: R[1], workflowId: W.afffDocketMonitor, workflowName: "AFFF docket monitor (D.S.C.)", category: "operations", status: "succeeded", startedAt: "2026-09-21T11:00:03.000Z", triggeredBy: "schedule", matterId: M.afff,
      inputs: { docket_query: "Meridian Fluorochem AFFF", courts: "dsc", matter: M.afff, __event: { scheduledFor: "2026-09-21T11:00:00.000Z", frequency: "daily" } },
      steps: [
        { nodeId: "schedule", status: "succeeded", secs: 0, output: { triggeredBy: "schedule", scheduledFor: "2026-09-21T11:00:00.000Z", frequency: "daily" } },
        { nodeId: "search", status: "succeeded", secs: 2, output: { source: "dockets", query: "Meridian Fluorochem AFFF", total: 0, results: [], text: "", citations: [] }, logs: ["0 result(s) from dockets"] },
        { nodeId: "any_new", status: "succeeded", secs: 0, output: { matched: "else", label: "else", evaluations: [{ ruleId: "yes", label: "New entries", matched: false, conditions: [{ left: 0, op: "gt", right: "0", result: false }] }] }, logs: ['Matched "else"'] },
        { nodeId: "each", status: "skipped", logs: ["Skipped: no active incoming path"] },
        { nodeId: "task", status: "skipped" },
        { nodeId: "digest", status: "skipped", logs: ["Skipped: no active incoming path"] },
      ],
    },
    // 3 — privilege log, manual by Elena, 6 documents
    {
      id: R[2], workflowId: W.afffPrivilegeLog, workflowName: "Kaine / Suarez privilege log", category: "discovery", status: "succeeded", startedAt: "2026-09-19T14:31:10.000Z", triggeredBy: "manual", triggeredById: P.elenaMarsh, matterId: M.afff,
      inputs: { matter: M.afff, custodian: "Kaine", limit: 25 },
      usage: { input: 9840, output: 2210, total: 12050, calls: 6, costUsd: 0.0069 },
      steps: [
        { nodeId: "start", status: "succeeded", secs: 0, output: { inputs: { matter: M.afff, custodian: "Kaine" }, triggeredBy: "manual" } },
        { nodeId: "search", status: "succeeded", secs: 1, output: { count: 6, query: "*", results: PRIV_DOCS, batesNumbers: PRIV_DOCS.map((d) => d.bates), text: PRIV_DOCS.map((d) => `**${d.bates}** · ${d.date} · ${d.custodian} · ${d.type} — ${d.subject} · PRIVILEGED\n> ${d.passage}`).join("\n\n") }, logs: ["6 document(s)"] },
        { nodeId: "entries", status: "succeeded", secs: 41, output: { count: 6, total: 6, results: PRIV_ENTRIES.map((e, i) => ({ index: i, item: PRIV_DOCS[i], steps: { describe: e } })), errors: [], errorCount: 0 }, logs: ["6 document(s) to process"] },
        { nodeId: "describe", status: "succeeded", secs: 0, output: PRIV_ENTRIES[5], tokens: 2008, logs: ["tool: none", "Extracted entry for MFC-0043951"] },
        { nodeId: "log", status: "succeeded", secs: 1, output: { docId: "od_wf_privlog_kaine", kind: "sheet", title: "Privilege log — Kaine — Sep 19, 2026", href: "/office/sheet/od_wf_privlog_kaine", libraryItemId: "lib_wf_privlog_kaine", size: 6120 }, logs: ["6 row(s), 10 column(s)", 'Saved workbook "Privilege log — Kaine — Sep 19, 2026"'] },
        { nodeId: "qc", status: "succeeded", secs: 0, output: { taskId: "t_wf_privlog_qc", title: "QC privilege log (6 entries) — Kaine", dueAt: "2026-09-23", assignee: "Maria Lopez", href: "/?task=t_wf_privlog_qc" }, logs: ['Task "QC privilege log (6 entries) — Kaine" → Maria Lopez, due 2026-09-23'] },
      ],
      artifacts: [
        { kind: "document", id: "od_wf_privlog_kaine", title: "Privilege log — Kaine — Sep 19, 2026", href: "/office/sheet/od_wf_privlog_kaine", nodeId: "log", meta: { kind: "sheet" } },
        { kind: "library", id: "lib_wf_privlog_kaine", title: "Privilege log — Kaine — Sep 19, 2026", href: "/library?item=lib_wf_privlog_kaine", nodeId: "log" },
        { kind: "task", id: "t_wf_privlog_qc", title: "QC privilege log (6 entries) — Kaine", href: "/?task=t_wf_privlog_qc", nodeId: "qc", meta: { dueAt: "2026-09-23", assignee: "Maria Lopez" } },
      ],
      loopIterations: { entries: PRIV_ENTRIES.map((e, i) => ({ index: i, item: PRIV_DOCS[i], steps: { describe: { nodeId: "describe", status: "succeeded", startedAt: iso("2026-09-19T14:31:12.000Z", i * 6.8), finishedAt: iso("2026-09-19T14:31:12.000Z", i * 6.8 + 6.5), output: e, tokens: 1900 + i * 40, logs: [`Extracted entry for ${e.bates}`] } } })) },
    },
    // 4 — Northgate cite-check, 2 unresolved
    {
      id: R[3], workflowId: W.northgateCiteCheck, workflowName: "Northgate MSJ cite-check", category: "drafting", status: "succeeded", startedAt: "2026-09-22T23:10:41.000Z", triggeredBy: "manual", triggeredById: P.danielOkafor, matterId: M.northgate,
      inputs: { brief_name: "MSJ opposition v3", matter: M.northgate, brief_text: { blobId: "blob_wf_msj_v3", name: "Northgate_MSJ_Opposition_v3.docx", text: "[MSJ opposition v3 — 38 pages; text extracted from Northgate_MSJ_Opposition_v3.docx]" } },
      usage: { input: 21400, output: 1860, total: 23260, calls: 1, costUsd: 0.0721 },
      steps: [
        { nodeId: "start", status: "succeeded", secs: 0, output: { inputs: { brief_name: "MSJ opposition v3" }, triggeredBy: "manual" } },
        { nodeId: "verify", status: "succeeded", secs: 9, output: { source: "verify_citations", total: 14, unresolvedCount: 2, unresolved: [{ citation: "2007 WL 1811265", resolved: false, status: 404, error: "Citation not found" }, { citation: "226 Ill. App. 3d 507, 514", resolved: true, status: 200, matches: [{ case_name: "Rayner Covering Systems, Inc. v. Danvers Farmers Elevator Co." }] }].slice(0, 1).concat([{ citation: "156 Ill. App. 3d 154, 163", resolved: false, status: 300, error: "Ambiguous: multiple clusters" }]), results: [
          { citation: "119 Ill. 2d 542", resolved: true, status: 200, matches: [{ case_name: "Harris v. Walker", date_filed: "1988-03-23", url: "https://www.courtlistener.com/opinion/2216873/harris-v-walker/" }] },
          { citation: "226 Ill. App. 3d 507", resolved: true, status: 200, matches: [{ case_name: "Rayner Covering Systems, Inc. v. Danvers Farmers Elevator Co.", date_filed: "1992-03-05" }] },
          { citation: "2007 WL 1811265", resolved: false, status: 404, error: "Citation not found" },
          { citation: "156 Ill. App. 3d 154, 163", resolved: false, status: 300, error: "Ambiguous: multiple clusters" },
          { citation: "810 ILCS 5/2-719", resolved: true, status: 200, matches: [{ case_name: "Statute (UCC § 2-719)" }] },
        ], text: "14 citation(s) checked, 2 unresolved.\n\n- ✓ 119 Ill. 2d 542 — Harris v. Walker\n- ✓ 226 Ill. App. 3d 507 — Rayner Covering Systems, Inc. v. Danvers Farmers Elevator Co.\n- ✗ 2007 WL 1811265 (Citation not found)\n- ✗ 156 Ill. App. 3d 154, 163 (Ambiguous: multiple clusters)\n- ✓ 810 ILCS 5/2-719 — Statute (UCC § 2-719)\n- ✓ … 9 further citations resolved" }, logs: ["14 citation(s) checked, 2 unresolved."] },
        { nodeId: "report", status: "succeeded", secs: 38, tokens: 23260, output: { text: "# Cite-check report — MSJ opposition v3\n\n**Summary.** 14 citations checked; 12 resolved; 2 need attention.\n\n| Citation | Status | Resolved case | Issue | Suggested fix |\n| --- | --- | --- | --- | --- |\n| 2007 WL 1811265 | ✗ Unresolved | — | Westlaw cite not in CourtListener; the brief cites it for the proposition that Illinois enforces waivers between merchants | Replace with the reported decision or the N.D. Ill. docket cite; confirm on Westlaw |\n| 156 Ill. App. 3d 154, 163 | ✗ Ambiguous | Zimmerman v. Northfield Real Estate (1st Dist. 1986) likely | Two clusters share the volume/page; pin cite 163 is beyond the opinion length in one cluster | Verify the pin cite against the official reporter |\n| 119 Ill. 2d 542 | ✓ | Harris v. Walker | Brief describes it as a \"limitation of liability\" case; it concerns an exculpatory release | Re-characterize or add a parenthetical |\n\n**Bluebook form.** Three citations in Part II.B lack pin cites (pp. 14, 17, 21). *Dana Corp.* is cited with the wrong reporter abbreviation (\"F. 3d\" with a space).", citations: [], toolCalls: 0 }, logs: ["Reasoning (step 1)"] },
        { nodeId: "save", status: "succeeded", secs: 1, output: { docId: "od_wf_citecheck_v3", kind: "word", title: "Cite-check — MSJ opposition v3 — Sep 22, 2026", href: "/office/word/od_wf_citecheck_v3", libraryItemId: "lib_wf_citecheck_v3", size: 4810 }, logs: ['Saved document "Cite-check — MSJ opposition v3 — Sep 22, 2026"'] },
        { nodeId: "any_bad", status: "succeeded", secs: 0, output: { matched: "bad", label: "Unresolved", evaluations: [{ ruleId: "bad", label: "Unresolved", matched: true, conditions: [{ left: 2, op: "gt", right: "0", result: true }] }] }, logs: ['Matched "Unresolved"'] },
        { nodeId: "fix", status: "succeeded", secs: 0, output: { taskId: "t_ng_04", title: "Fix 2 unresolved citation(s) in MSJ opposition v3", dueAt: "2026-09-23", assignee: "Elena Marsh", href: "/?task=t_ng_04" }, logs: ['Task "Fix 2 unresolved citation(s) in MSJ opposition v3" → Elena Marsh, due 2026-09-23'] },
        { nodeId: "clean", status: "skipped", logs: ["Skipped: no active incoming path"] },
      ],
      artifacts: [
        { kind: "document", id: "od_wf_citecheck_v3", title: "Cite-check — MSJ opposition v3 — Sep 22, 2026", href: "/office/word/od_wf_citecheck_v3", nodeId: "save", meta: { kind: "word" } },
        { kind: "task", id: "t_ng_04", title: "Fix 2 unresolved citation(s) in MSJ opposition v3", href: "/?task=t_ng_04", nodeId: "fix", meta: { dueAt: "2026-09-23", assignee: "Elena Marsh" } },
      ],
    },
    // 5 — PFAS regulatory watch, scheduled
    {
      id: R[4], workflowId: W.firmRegulatoryWatch, workflowName: "PFAS regulatory watch", category: "compliance", status: "succeeded", startedAt: "2026-09-21T10:30:02.000Z", triggeredBy: "schedule", matterId: M.afff,
      inputs: { topic: "PFAS OR PFOA OR PFOS", agency: "environmental-protection-agency", matter: M.afff, __event: { scheduledFor: "2026-09-21T10:30:00.000Z", frequency: "weekly" } },
      usage: { input: 6120, output: 780, total: 6900, calls: 1, costUsd: 0.0231 },
      steps: [
        { nodeId: "schedule", status: "succeeded", secs: 0, output: { triggeredBy: "schedule", scheduledFor: "2026-09-21T10:30:00.000Z", frequency: "weekly" } },
        { nodeId: "fr", status: "succeeded", secs: 4, output: { source: "federal_register", query: "PFAS OR PFOA OR PFOS", total: 3, results: FR_RESULTS, text: FR_RESULTS.map((r) => `- **${r.title}** (${r.type}; ${r.agencies.join(", ")}; ${r.published}; ${r.citation}) — ${r.url}\n  ${r.abstract}`).join("\n"), citations: FR_RESULTS.map((r) => ({ title: r.title, url: r.url, cite: r.citation, source: "federal register" })) }, logs: ["3 result(s) from federal_register"] },
        { nodeId: "any", status: "succeeded", secs: 0, output: { matched: "yes", label: "New documents", evaluations: [{ ruleId: "yes", label: "New documents", matched: true, conditions: [{ left: 3, op: "gt", right: "0", result: true }] }] }, logs: ['Matched "New documents"'] },
        { nodeId: "summary", status: "succeeded", secs: 27, tokens: 6900, output: { text: REG_SUMMARY, wordCount: 318 } },
        { nodeId: "post", status: "succeeded", secs: 0, output: { notificationId: "wn_seed_05", updateId: "tu_wf_seed_05", recipients: [P.jordanWhitfield, P.priyaRaman, P.aishaKhan], channel: "in-app" }, logs: ["Notified Jordan Whitfield, Priya Raman, Aisha Khan"] },
        { nodeId: "file", status: "succeeded", secs: 0, output: { blobId: "blob_wf_regwatch_0921", url: "/api/blobs/blob_wf_regwatch_0921", size: 5314, filename: "regulatory-watch-PFAS OR PFOA OR PFOS-2026-09-21.md", format: "markdown", libraryItemId: "lib_wf_regwatch_0921" }, logs: ["Exported regulatory-watch-PFAS OR PFOA OR PFOS-2026-09-21.md (5,314 bytes)"] },
        { nodeId: "quiet", status: "skipped", logs: ["Skipped: no active incoming path"] },
      ],
      artifacts: [
        { kind: "notification", id: "wn_seed_05", title: "Regulatory watch — PFAS OR PFOA OR PFOS (Sep 21, 2026)", href: "/", nodeId: "post" },
        { kind: "file", id: "blob_wf_regwatch_0921", title: "regulatory-watch-PFAS OR PFOA OR PFOS-2026-09-21.md", href: "/api/blobs/blob_wf_regwatch_0921", nodeId: "file", meta: { size: 5314, format: "markdown" } },
      ],
    },
    // 6 — Harbor NDA intake (Snowfield), medium risk
    {
      id: R[5], workflowId: W.harborNdaReview, workflowName: "Project Harbor NDA intake", category: "intake", status: "succeeded", startedAt: "2026-09-18T15:42:18.000Z", triggeredBy: "manual", triggeredById: P.danielOkafor, matterId: M.harbor,
      inputs: { matter: M.harbor, our_side: "Disclosing Party", counterparty: "Snowfield Reseller LLC", nda_text: { blobId: "blob_wf_nda_snowfield", name: "Snowfield_Mutual_NDA_2026-09-15.docx", text: "[Mutual Non-Disclosure Agreement — 7 pages; text extracted from Snowfield_Mutual_NDA_2026-09-15.docx]" } },
      usage: { input: 31200, output: 4420, total: 35620, calls: 3, costUsd: 0.1222 },
      steps: [
        { nodeId: "start", status: "succeeded", secs: 0, output: { inputs: { our_side: "Disclosing Party", counterparty: "Snowfield Reseller LLC" }, triggeredBy: "manual" } },
        { nodeId: "extract", status: "succeeded", secs: 22, tokens: 9800, output: NDA_EXTRACT_SNOWFIELD, logs: ["Extracted 14 field(s)"] },
        { nodeId: "classify", status: "succeeded", secs: 9, tokens: 5100, output: { label: "medium", confidence: 0.86, rationale: "Mutual form with standard carve-outs, but the residuals clause (§ 4.3) and indefinite confidentiality for all information (§ 5.1) run against a disclosing client; the 12-month non-solicit (§ 7) is outside firm positions. None is unacceptable as drafted, so medium rather than high.", labels: [{ label: "medium", confidence: 0.86, rationale: "Residuals and perpetual term against a disclosing client; non-solicit present." }] }, logs: ["Label: medium (86%)"] },
        { nodeId: "draft", status: "succeeded", secs: 44, tokens: 20720, output: { title: "NDA Review — Snowfield Reseller LLC (Project Harbor)", text: NDA_MEMO_SNOWFIELD, wordCount: 612, citations: [] }, logs: ["tool: Searching library: NDA residuals clause disclosing party", "cite: Clause bank — Confidentiality survival (two-tier)"] },
        { nodeId: "save", status: "succeeded", secs: 1, output: { docId: "od_wf_nda_snowfield", kind: "word", title: "NDA review — Snowfield Reseller LLC — Sep 18, 2026", href: "/office/word/od_wf_nda_snowfield", libraryItemId: "lib_wf_nda_snowfield", size: 7420 }, logs: ['Saved document "NDA review — Snowfield Reseller LLC — Sep 18, 2026"'] },
        { nodeId: "route", status: "succeeded", secs: 0, output: { matched: "medium", label: "Medium risk", evaluations: [{ ruleId: "high", label: "High risk", matched: false, conditions: [{ left: "medium", op: "equals", right: "high", result: false }] }, { ruleId: "medium", label: "Medium risk", matched: true, conditions: [{ left: "medium", op: "equals", right: "medium", result: true }] }] }, logs: ['Matched "Medium risk"'] },
        { nodeId: "task_partner", status: "skipped", logs: ["Skipped: no active incoming path"] },
        { nodeId: "task_associate", status: "succeeded", secs: 0, output: { taskId: "t_wf_nda_snowfield", title: "NDA markup: Snowfield Reseller LLC (medium risk)", dueAt: "2026-09-23", assignee: "Samuel Chen", href: "/?task=t_wf_nda_snowfield" }, logs: ['Task "NDA markup: Snowfield Reseller LLC (medium risk)" → Samuel Chen, due 2026-09-23'] },
        { nodeId: "task_clear", status: "skipped", logs: ["Skipped: no active incoming path"] },
        { nodeId: "notify", status: "succeeded", secs: 0, output: { notificationId: "wn_seed_06", updateId: "tu_wf_seed_06", recipients: [P.danielOkafor, P.samuelChen], channel: "in-app" }, logs: ["Notified Daniel Okafor, Samuel Chen"] },
      ],
      artifacts: [
        { kind: "document", id: "od_wf_nda_snowfield", title: "NDA review — Snowfield Reseller LLC — Sep 18, 2026", href: "/office/word/od_wf_nda_snowfield", nodeId: "save", meta: { kind: "word" } },
        { kind: "task", id: "t_wf_nda_snowfield", title: "NDA markup: Snowfield Reseller LLC (medium risk)", href: "/?task=t_wf_nda_snowfield", nodeId: "task_associate", meta: { dueAt: "2026-09-23", assignee: "Samuel Chen" } },
        { kind: "notification", id: "wn_seed_06", title: "NDA intake review finished for Snowfield Reseller LLC on Project Harbor: MEDIUM risk.", href: "/", nodeId: "notify" },
      ],
    },
    // 7 — Harbor NDA intake (Aurora Health), failed on rate limit after retries
    {
      id: R[6], workflowId: W.harborNdaReview, workflowName: "Project Harbor NDA intake", category: "intake", status: "failed", startedAt: "2026-09-23T12:40:07.000Z", triggeredBy: "manual", triggeredById: P.samuelChen, matterId: M.harbor,
      inputs: { matter: M.harbor, our_side: "Mutual", counterparty: "Aurora Health Partners", nda_text: { blobId: "blob_wf_nda_aurora", name: "Aurora_NDA_redline_v2.pdf", text: "[Mutual NDA redline v2 — 11 pages; text extracted from Aurora_NDA_redline_v2.pdf]" } },
      error: "Rate limited by the model provider (429).", errorCode: "rate_limited",
      usage: { input: 0, output: 0, total: 0, calls: 0, costUsd: 0 },
      steps: [
        { nodeId: "start", status: "succeeded", secs: 0, output: { inputs: { our_side: "Mutual", counterparty: "Aurora Health Partners" }, triggeredBy: "manual" } },
        { nodeId: "extract", status: "failed", secs: 34, error: "Rate limited by the model provider (429).", logs: ["Attempt 1 failed (Rate limited by the model provider (429).); retrying in 1s", "Attempt 2 failed (Rate limited by the model provider (429).); retrying in 2s"] },
        { nodeId: "classify", status: "skipped", logs: ["Skipped: run failed"] }, { nodeId: "draft", status: "skipped", logs: ["Skipped: run failed"] }, { nodeId: "save", status: "skipped", logs: ["Skipped: run failed"] }, { nodeId: "route", status: "skipped", logs: ["Skipped: run failed"] }, { nodeId: "task_partner", status: "skipped" }, { nodeId: "task_associate", status: "skipped" }, { nodeId: "task_clear", status: "skipped" }, { nodeId: "notify", status: "skipped" },
      ],
    },
    // 8 — Northgate research memo, waiting for partner approval
    {
      id: R[7], workflowId: W.northgateResearch, workflowName: "Northgate research memos", category: "research", status: "waiting_approval", startedAt: "2026-09-23T11:58:20.000Z", triggeredBy: "manual", triggeredById: P.danielOkafor, matterId: M.northgate,
      inputs: { question: "Under Illinois law, does a consequential-damages waiver in a services agreement bar lost-profit claims where the breach was willful?", jurisdiction: "7th-circuit", matter: M.northgate },
      usage: { input: 88400, output: 6900, total: 95300, calls: 9, costUsd: 0.2900 },
      steps: [
        { nodeId: "start", status: "succeeded", secs: 0, output: { inputs: { jurisdiction: "7th-circuit" }, triggeredBy: "manual" } },
        { nodeId: "research", status: "succeeded", secs: 214, tokens: 95300, output: { text: RESEARCH_MEMO_NG, citations: [{ title: "Harris v. Walker, 119 Ill. 2d 542", url: "https://www.courtlistener.com/opinion/2216873/harris-v-walker/", cite: "119 Ill. 2d 542", source: "case law" }, { title: "Rayner Covering Systems, Inc. v. Danvers Farmers Elevator Co., 226 Ill. App. 3d 507", cite: "226 Ill. App. 3d 507", source: "case law" }, { title: "Zimmerman v. Northfield Real Estate, Inc., 156 Ill. App. 3d 154", cite: "156 Ill. App. 3d 154", source: "case law" }], toolCalls: 8 }, logs: ["tool: Searching case law: consequential damages waiver willful breach Illinois", "cite: Harris v. Walker, 119 Ill. 2d 542", "tool: Reading opinion #2216873", "tool: Searching case law: exculpatory clause intentional misconduct Illinois", "cite: Zimmerman v. Northfield Real Estate", "tool: Searching library: consequential damages waiver", "tool: Loading matter context", "Reasoning (step 4)"] },
        { nodeId: "save", status: "succeeded", secs: 1, output: { docId: "od_wf_research_ng_waiver", kind: "word", title: "Research memo — Under Illinois law, does a consequential-damages waiver in a…", href: "/office/word/od_wf_research_ng_waiver", libraryItemId: "lib_wf_research_ng_waiver", size: 9860 }, logs: ['Saved document "Research memo — Under Illinois law, does a consequential-damages waiver in a…"'] },
        { nodeId: "approval", status: "waiting_approval", secs: 0, output: { approved: null, title: "Approve research memo", message: `A research memo is ready for Northgate v. Apex.\n\n**Question:** Under Illinois law, does a consequential-damages waiver in a services agreement bar lost-profit claims where the breach was willful?\n\n**Bottom line (excerpt):**\n${RESEARCH_MEMO_NG.slice(0, 1800)}…\n\nFull memo: /office/word/od_wf_research_ng_waiver\n\nApprove to circulate, or reject with comments to send it back for revision.` }, logs: ["Waiting for Jordan Whitfield"] },
        { nodeId: "task_circulate", status: "pending" }, { nodeId: "task_revise", status: "pending" },
      ],
      approvals: [{ nodeId: "approval", title: "Approve research memo", message: `A research memo is ready for Northgate v. Apex.\n\n**Question:** Under Illinois law, does a consequential-damages waiver in a services agreement bar lost-profit claims where the breach was willful?\n\n**Bottom line (excerpt):**\n${RESEARCH_MEMO_NG.slice(0, 1800)}…\n\nFull memo: /office/word/od_wf_research_ng_waiver\n\nApprove to circulate, or reject with comments to send it back for revision.`, approverId: P.jordanWhitfield, requestedAt: "2026-09-23T12:01:55.000Z" }],
      artifacts: [{ kind: "document", id: "od_wf_research_ng_waiver", title: "Research memo — consequential-damages waiver / willful breach", href: "/office/word/od_wf_research_ng_waiver", nodeId: "save", meta: { kind: "word" } }],
    },
    // 9 — AFFF client report, waiting for approval
    {
      id: R[8], workflowId: W.afffClientStatus, workflowName: "AFFF weekly client report", category: "operations", status: "waiting_approval", startedAt: "2026-09-18T21:30:00.000Z", triggeredBy: "manual", triggeredById: P.mariaLopez, matterId: M.afff,
      inputs: { matter: M.afff, period: "Weekly", highlights: "Tier 2 review 71% complete; Hale Vol. II prep done; CMO 31 entered with Group C schedule; Sept 17 meet-and-confer on custodial ranges." },
      usage: { input: 14200, output: 2300, total: 16500, calls: 2, costUsd: 0.0585 },
      steps: [
        { nodeId: "start", status: "succeeded", secs: 0, output: { inputs: { period: "Weekly" }, triggeredBy: "manual" } },
        { nodeId: "draft", status: "succeeded", secs: 51, tokens: 16500, output: { title: "Weekly status report — In re: AFFF Products Liability Litigation (MDL No. 2873)", text: CLIENT_REPORT_AFFF, wordCount: 470, citations: [] }, logs: ["tool: Loading matter context"] },
        { nodeId: "save", status: "succeeded", secs: 1, output: { docId: "od_wf_client_afff_0918", kind: "word", title: "Weekly status report — AFFF / PFAS — Sep 18, 2026", href: "/office/word/od_wf_client_afff_0918", libraryItemId: "lib_wf_client_afff_0918", size: 6210 }, logs: ['Saved document "Weekly status report — AFFF / PFAS — Sep 18, 2026"'] },
        { nodeId: "approval", status: "waiting_approval", secs: 0, output: { approved: null, title: "Approve client status report", message: `Weekly status report for Meridian Fluorochem Corp. (AFFF / PFAS) is ready.\n\n${CLIENT_REPORT_AFFF.slice(0, 2000)}…\n\nFull report: /office/word/od_wf_client_afff_0918` }, logs: ["Waiting for Jordan Whitfield"] },
        { nodeId: "send", status: "pending" }, { nodeId: "post", status: "pending" }, { nodeId: "revise", status: "pending" },
      ],
      approvals: [{ nodeId: "approval", title: "Approve client status report", message: `Weekly status report for Meridian Fluorochem Corp. (AFFF / PFAS) is ready.\n\n${CLIENT_REPORT_AFFF.slice(0, 2000)}…\n\nFull report: /office/word/od_wf_client_afff_0918`, approverId: P.jordanWhitfield, requestedAt: "2026-09-18T21:30:52.000Z" }],
      artifacts: [{ kind: "document", id: "od_wf_client_afff_0918", title: "Weekly status report — AFFF / PFAS — Sep 18, 2026", href: "/office/word/od_wf_client_afff_0918", nodeId: "save", meta: { kind: "word" } }],
    },
    // 10 — Brooks deposition digest
    {
      id: R[9], workflowId: W.afffDepoDigest, workflowName: "AFFF deposition digest", category: "discovery", status: "succeeded", startedAt: "2026-09-12T13:05:00.000Z", triggeredBy: "manual", triggeredById: P.mariaLopez, matterId: M.afff,
      inputs: { witness: "Nadia Brooks, Product Stewardship Manager", matter: M.afff, focus: "customer notifications 2017–2019; the 2018 phase-out memo; what Brooks told Pryce about the C8 replacement chemistry", transcript_text: { blobId: "blob_wf_brooks_rough", name: "Brooks_N_2026-09-10_ROUGH.txt", text: "[Rough transcript — 212 pages]" } },
      usage: { input: 142800, output: 9900, total: 152700, calls: 3, costUsd: 0.4560 },
      steps: [
        { nodeId: "start", status: "succeeded", secs: 0, output: { inputs: { witness: "Nadia Brooks, Product Stewardship Manager" }, triggeredBy: "manual" } },
        { nodeId: "digest", status: "succeeded", secs: 96, tokens: 71000, output: { text: "**Customer notifications (2017–2019)**\n- 44:12–46:3 — Q: Did Meridian notify AFFF customers of the PFOA content before 2018? A: \"We updated the safety data sheets in 2017. I don't recall a separate letter.\" — *key*\n- 58:9–59:20 — Q: Who decided the SDS update was sufficient? A: \"That came from Alan's group with Legal's input.\" — *key; privilege objection at 59:2*\n\n**2018 phase-out memo**\n- 101:4–104:18 — Q: Exhibit 14 (MFC-0052210) — is that your memo? A: \"It's the stewardship team's memo. I drafted the first version.\" — *admission*\n- 106:1–107:15 — Q: The memo says the C6 replacement was 'commercially available by Q3 2016.' Was it? A: \"Available, yes. Qualified for military spec, no.\" — *contradiction with Pryce email MFC-0051877*\n\n**C8 replacement chemistry**\n- 133:7–135:2 — Q: What did you tell Mr. Pryce about the C6 transition timeline? A: \"That it would be 18 to 24 months.\" — *key*\n- 140:20–141:9 — Evasive: \"I don't recall\" ×4 on the November 2016 meeting; Ex. 17 calendar entry shows attendance.", wordCount: 880 } },
        { nodeId: "extract", status: "succeeded", secs: 31, tokens: 38900, output: { key_admissions: ["Brooks drafted the first version of the 2018 phase-out memo (Ex. 14, MFC-0052210) — 101:4–104:18", "Customer notification consisted of the 2017 SDS update only — 44:12–46:3", "C6 replacement was commercially available by Q3 2016 — 106:1–107:15"], harmful_testimony: ["Brooks told Pryce the C6 transition would take 18–24 months, implying feasibility from 2016 — 133:7–135:2"], contradictions: ["Testimony that C6 was 'not qualified for military spec' (106:1–107:15) conflicts with Pryce email MFC-0051877 stating MIL-SPEC qualification completed June 2016"], exhibits: ["Ex. 14 — 2018 phase-out memo (MFC-0052210)", "Ex. 17 — Outlook calendar, Nov 14 2016 meeting (MFC-0052488)", "Ex. 19 — 2017 SDS revision log (MFC-0049120–0049134)"], objections_instructions: ["59:2 — privilege objection (Kaine); instruction not to answer re: Legal's input on SDS decision", "118:14 — form objection; asked and answered"], follow_up: ["Pull the MIL-SPEC qualification file referenced in MFC-0051877", "Confirm whether any customer letter went out in 2018 (Brooks 'doesn't recall')", "Prepare Pryce on the 18–24 month transition statement"], credibility_notes: ["'I don't recall' on the November 2016 meeting despite calendar entry (Ex. 17) — 140:20–141:9"], _evidence: [] }, logs: ["Extracted 7 field(s)"] },
        { nodeId: "memo", status: "succeeded", secs: 58, tokens: 42800, output: { title: "Deposition digest — Nadia Brooks (Sept 10, 2026)", text: "# Deposition digest — Nadia Brooks (Sept 10, 2026)\n\n## Summary\n- Brooks authored the first draft of the 2018 phase-out memo (Ex. 14).\n- Only customer notification before 2018 was the 2017 SDS update.\n- C6 replacement chemistry was commercially available by Q3 2016; the military-spec qualification date is disputed.\n- Brooks told Pryce the transition would take 18–24 months.\n- Privilege instruction at 59:2 on Legal's role in the SDS decision.\n\n## Key admissions\n…", wordCount: 1420, citations: [] } },
        { nodeId: "save", status: "succeeded", secs: 1, output: { docId: "od_wf_depo_brooks", kind: "word", title: "Deposition digest — Nadia Brooks, Product Stewardship Manager — Sep 12, 2026", href: "/office/word/od_wf_depo_brooks", libraryItemId: "lib_wf_depo_brooks", size: 12840 } },
        { nodeId: "notify", status: "succeeded", secs: 0, output: { notificationId: "wn_seed_10", updateId: "tu_wf_seed_10", recipients: [P.jordanWhitfield, P.priyaRaman, P.elenaMarsh], channel: "in-app" } },
        { nodeId: "task", status: "succeeded", secs: 0, output: { taskId: "t_wf_depo_brooks_review", title: "Review deposition digest: Nadia Brooks, Product Stewardship Manager", dueAt: "2026-09-17", assignee: "Elena Marsh", href: "/?task=t_wf_depo_brooks_review" } },
      ],
      artifacts: [
        { kind: "document", id: "od_wf_depo_brooks", title: "Deposition digest — Nadia Brooks — Sep 12, 2026", href: "/office/word/od_wf_depo_brooks", nodeId: "save", meta: { kind: "word" } },
        { kind: "task", id: "t_wf_depo_brooks_review", title: "Review deposition digest: Nadia Brooks", href: "/?task=t_wf_depo_brooks_review", nodeId: "task", meta: { dueAt: "2026-09-17", assignee: "Elena Marsh" } },
      ],
    },
    // 11 — Sterling PAGA response
    {
      id: R[10], workflowId: W.sterlingPaga, workflowName: "Sterling PAGA notice response", category: "compliance", status: "succeeded", startedAt: "2026-08-26T16:12:00.000Z", triggeredBy: "manual", triggeredById: P.samuelChen, matterId: M.sterling,
      inputs: { matter: M.sterling, employer: "Sterling Medical Group, P.C.", notice_text: { blobId: "blob_wf_paga_notice", name: "LWDA-CM-1104532-26_Notice.pdf", text: "[PAGA notice — 9 pages]" } },
      usage: { input: 24600, output: 5100, total: 29700, calls: 3, costUsd: 0.1125 },
      steps: [
        { nodeId: "start", status: "succeeded", secs: 0, output: { triggeredBy: "manual" } },
        { nodeId: "extract", status: "succeeded", secs: 19, tokens: 8100, output: { notice_date: "2026-08-19", lwda_case_number: "LWDA-CM-1104532-26", claimant: "Deanna Ruiz (medical assistant, Glendale clinic), by Marlin & Osei LLP", employer_named: "Sterling Medical Group, P.C.", alleged_violations: ["Lab. Code §§ 226.7, 512 — meal periods not provided / auto-deducted 30 minutes regardless of whether taken", "Lab. Code § 226.7 — rest periods not authorized", "Lab. Code §§ 510, 1194, 1198 — unpaid overtime from 7-minute rounding", "Lab. Code § 226(a) — inaccurate wage statements", "Lab. Code §§ 201–203 — waiting time penalties", "Lab. Code § 2802 — unreimbursed business expenses (personal cell phones)"], period: "August 19, 2025 to present", employee_group: "All non-exempt hourly employees at the 14 Southern California clinics (medical assistants, front-desk, phlebotomists)", cure_eligible_sections: ["§ 226(a) wage statements", "§ 226.7 meal/rest premiums (payment cure under § 2699.3(c)(2))", "§ 2802 expense reimbursement"], _evidence: [] }, logs: ["Extracted 8 field(s)"] },
        { nodeId: "plan", status: "succeeded", secs: 26, tokens: 12300, output: { items: [
          { section: "§§ 226.7, 512", allegation: "Meal periods auto-deducted", action: "Pull timekeeping and auto-deduct configuration for all 14 clinics; identify shifts > 5 hours with no recorded meal punch; quantify premium exposure", curable: true, cure_window: "Payment of premiums + 7% interest within cure period (§ 2699.3(c)(2)(B))", due_rule: "+7bd", owner_role: "associate", priority: "urgent" },
          { section: "§ 226.7 (rest)", allegation: "Rest periods not authorized", action: "Collect written rest-period policy and clinic schedules; interview Burbank, Glendale, Pasadena managers", curable: true, cure_window: "Policy correction + premium payment", due_rule: "+10bd", owner_role: "partner", priority: "high" },
          { section: "§§ 510, 1194, 1198", allegation: "7-minute rounding", action: "Run rounding-neutrality analysis on the Jan 2023–Aug 2026 payroll export (Camp v. Home Depot)", curable: false, cure_window: "Not curable; defense only", due_rule: "+10bd", owner_role: "associate", priority: "high" },
          { section: "§ 226(a)", allegation: "Inaccurate wage statements", action: "Issue corrected wage statements for the one-year period and confirm cure notice content", curable: true, cure_window: "33 days from notice (§ 2699.3(c)(2)(A))", due_rule: "+15bd", owner_role: "client HR", priority: "urgent" },
          { section: "§§ 201–203", allegation: "Waiting time penalties", action: "Identify separations in the period; evaluate good-faith dispute defense (Naranjo)", curable: false, cure_window: "Not curable", due_rule: "+15bd", owner_role: "associate", priority: "medium" },
          { section: "§ 2802", allegation: "Cell-phone reimbursement", action: "Confirm stipend policy; reimburse affected employees as part of cure", curable: true, cure_window: "Cure by reimbursement", due_rule: "+12bd", owner_role: "client HR", priority: "medium" },
        ], strategy_note: "Cure the wage-statement, premium and reimbursement claims within the 33-day window to cap penalties at 15% / 30% under § 2699(g); request an early evaluation conference on the rounding and waiting-time claims, which turn on the neutrality analysis." }, logs: ["Reasoning (step 1)"] },
        { nodeId: "each", status: "succeeded", secs: 2, output: { count: 6, total: 6, results: Array.from({ length: 6 }, (_, i) => ({ index: i, item: {}, steps: { task: { taskId: `t_wf_paga_${i + 1}` } } })), errors: [], errorCount: 0 }, logs: ["6 allegation(s) to process"] },
        { nodeId: "task", status: "succeeded", secs: 0, output: { taskId: "t_wf_paga_6", title: "PAGA § 2802: Confirm stipend policy; reimburse affected employees as part of cure", dueAt: "2026-09-14", assignee: "Samuel Chen", href: "/?task=t_wf_paga_6" } },
        { nodeId: "cure_deadline", status: "succeeded", secs: 0, output: { eventId: "ev_wf_paga_cure", title: "PAGA: LWDA 33-day cure / response window closes — Sterling Medical Group, P.C.", startsAt: "2026-09-21T17:00:00.000Z", kind: "deadline", href: "/?event=ev_wf_paga_cure" }, logs: ['Event "PAGA: LWDA 33-day cure / response window closes — Sterling Medical Group, P.C." on 2026-09-21 17:00'] },
        { nodeId: "checklist", status: "succeeded", secs: 24, tokens: 9300, output: { title: "PAGA notice response checklist — Sterling Medical Group, P.C.", text: "# PAGA notice response checklist — Sterling Medical Group, P.C.\n\n## Phase 1 — Immediate (by Aug 28)\n- [ ] Litigation hold to all 14 clinics (timekeeping, schedules, payroll, manager email)\n- [ ] Payroll and timekeeping export Jan 2023 – Aug 2026 (Samuel)\n- [ ] Notice to EPLI carrier\n\n## Phase 2 — Evaluation (by Sept 9)\n- [ ] Auto-deduct population vs. rounding population\n- [ ] Rounding-neutrality analysis\n- [ ] Cure eligibility memo per section\n\n## Phase 3 — Cure and response (by Sept 21)\n- [ ] Corrected wage statements\n- [ ] Premium and reimbursement payments with 7% interest\n- [ ] Cure notice to LWDA and claimant's counsel\n\n## Calendar\n- Sept 21, 2026 — LWDA 33-day window closes\n\n**Strategy note.** Cure the curable claims to cap penalties; request early evaluation on rounding and waiting-time claims.", wordCount: 210 } },
        { nodeId: "save", status: "succeeded", secs: 1, output: { docId: "od_wf_paga_checklist", kind: "word", title: "PAGA response checklist — Sterling Medical Group, P.C. — Aug 26, 2026", href: "/office/word/od_wf_paga_checklist", libraryItemId: "lib_wf_paga_checklist", size: 3980 } },
        { nodeId: "notify", status: "succeeded", secs: 0, output: { notificationId: "wn_seed_11", updateId: "tu_wf_seed_11", recipients: [P.samuelChen, P.jordanWhitfield], channel: "in-app" } },
      ],
      artifacts: [
        { kind: "event", id: "ev_wf_paga_cure", title: "PAGA: LWDA 33-day cure / response window closes", href: "/?event=ev_wf_paga_cure", nodeId: "cure_deadline", meta: { startsAt: "2026-09-21T17:00:00.000Z", kind: "deadline" } },
        { kind: "document", id: "od_wf_paga_checklist", title: "PAGA response checklist — Sterling Medical Group, P.C.", href: "/office/word/od_wf_paga_checklist", nodeId: "save", meta: { kind: "word" } },
        ...Array.from({ length: 6 }, (_, i) => ({ kind: "task" as const, id: `t_wf_paga_${i + 1}`, title: `PAGA work item ${i + 1} of 6`, href: `/?task=t_wf_paga_${i + 1}`, nodeId: "task" })),
      ],
    },
    // 12 — AFFF chronology (Q3 2017 EHS reports)
    {
      id: R[11], workflowId: W.afffChronology, workflowName: "AFFF chronology builder", category: "discovery", status: "succeeded", startedAt: "2026-09-20T18:44:00.000Z", triggeredBy: "manual", triggeredById: P.elenaMarsh, matterId: M.afff,
      inputs: { matter: M.afff, topic: "2017 EHS quarterly reports and Voss benchmark-dose memo", date_after: "2017-01-01", date_before: "2017-12-31" },
      usage: { input: 33100, output: 4700, total: 37800, calls: 2, costUsd: 0.1298 },
      steps: [
        { nodeId: "start", status: "succeeded", secs: 0, output: { triggeredBy: "manual" } },
        { nodeId: "search", status: "succeeded", secs: 2, output: { count: 9, query: "2017 EHS quarterly reports and Voss benchmark-dose memo", results: [{ id: "ed_afff_43105", bates: "MFC-0043105", date: "2017-10-11", custodian: "Gregory Hale", type: "Email", subject: "Q3 EHS report — distribution", passage: "Attaching the Q3 report. Note the groundwater monitoring section references the July and August interim reports…" }, { id: "ed_afff_43211", bates: "MFC-0043211", date: "2017-11-02", custodian: "Helen Voss", type: "Memo", subject: "Benchmark-dose analysis — hepatic endpoints (draft 2)", passage: "This draft updates the BMD analysis using the 2016 rat hepatic study and the interim Q3 data…" }], batesNumbers: ["MFC-0043105", "MFC-0043211"], text: "**MFC-0043105** · 2017-10-11 · Gregory Hale · Email — Q3 EHS report — distribution\n> Attaching the Q3 report…\n\n**MFC-0043211** · 2017-11-02 · Helen Voss · Memo — Benchmark-dose analysis — hepatic endpoints (draft 2)\n> This draft updates the BMD analysis…" }, logs: ['9 document(s) for "2017 EHS quarterly reports and Voss benchmark-dose memo"'] },
        { nodeId: "events", status: "succeeded", secs: 33, tokens: 21500, output: { events: [{ date: "2017-04-06", event: "Q1 2017 EHS quarterly report circulated to Hale, Pryce, Brooks", actors: "G. Hale", source: "MFC-0042990", significance: 2, category: "corporate" }, { date: "2017-07", event: "July interim EHS report referenced (not located in review set)", actors: "EHS team", source: "MFC-0043105 (reference only)", significance: 3, category: "scientific" }, { date: "2017-08", event: "August interim EHS report referenced (not located in review set)", actors: "EHS team", source: "MFC-0043105 (reference only)", significance: 3, category: "scientific" }, { date: "2017-10-11", event: "Q3 2017 EHS report distributed; groundwater monitoring section flags MW-7 exceedance", actors: "G. Hale → A. Pryce, N. Brooks", source: "MFC-0043105", significance: 4, category: "regulatory" }, { date: "2017-11-02", event: "Voss benchmark-dose memo draft 2 incorporates Q3 interim data", actors: "H. Voss", source: "MFC-0043211", significance: 5, category: "scientific" }], gaps: ["July–September 2017 interim EHS reports referenced in MFC-0043105 and MFC-0043211 are not in the review set", "No Q2 2017 quarterly report located"] }, logs: ["Reasoning (step 1)"] },
        { nodeId: "memo", status: "succeeded", secs: 40, tokens: 16300, output: { title: "Chronology — 2017 EHS quarterly reports and Voss benchmark-dose memo", text: "# Chronology — 2017 EHS quarterly reports and Voss benchmark-dose memo\n\n| Date | Event | Source | Significance |\n| --- | --- | --- | --- |\n| 2017-04-06 | Q1 2017 EHS quarterly report circulated | MFC-0042990 | 2 |\n| 2017-07 | July interim EHS report (referenced, not located) | MFC-0043105 | 3 |\n| 2017-08 | August interim EHS report (referenced, not located) | MFC-0043105 | 3 |\n| 2017-10-11 | Q3 2017 EHS report; MW-7 exceedance flagged | MFC-0043105 | 4 |\n| 2017-11-02 | Voss BMD memo draft 2 incorporates Q3 data | MFC-0043211 | 5 |\n\n## Gaps in the record\n- July–September 2017 interim EHS reports referenced in MFC-0043105 and MFC-0043211 are not in the review set.\n- No Q2 2017 quarterly report located.\n\n## Documents to collect next\n- Interim EHS reports July–September 2017 (EHS shared drive; confirm collection scope with Tom Bradley).", wordCount: 260, citations: [] } },
        { nodeId: "save", status: "succeeded", secs: 1, output: { docId: "od_wf_chron_2017", kind: "word", title: "Chronology — 2017 EHS quarterly reports and Voss benchmark-dose memo — Sep 20, 2026", href: "/office/word/od_wf_chron_2017", libraryItemId: "lib_wf_chron_2017", size: 5210 } },
        { nodeId: "task", status: "succeeded", secs: 0, output: { taskId: "t_afff_07", title: "Chronology gaps flagged: Q3 2017 EHS reports missing from the timeline", dueAt: "2026-10-02", assignee: "Elena Marsh", href: "/?task=t_afff_07" }, logs: ['Task "Chronology gaps flagged: Q3 2017 EHS reports missing from the timeline" → Elena Marsh, due 2026-10-02'] },
      ],
      artifacts: [
        { kind: "document", id: "od_wf_chron_2017", title: "Chronology — 2017 EHS quarterly reports and Voss benchmark-dose memo", href: "/office/word/od_wf_chron_2017", nodeId: "save", meta: { kind: "word" } },
        { kind: "task", id: "t_afff_07", title: "Chronology gaps flagged: Q3 2017 EHS reports missing from the timeline", href: "/?task=t_afff_07", nodeId: "task", meta: { dueAt: "2026-10-02", assignee: "Elena Marsh" } },
      ],
    },
    // 13 — Harbor clause workbook, cancelled by user
    {
      id: R[12], workflowId: W.harborClauseWorkbook, workflowName: "Harbor customer-contract review", category: "transactional", status: "cancelled", startedAt: "2026-09-17T17:55:10.000Z", triggeredBy: "manual", triggeredById: P.samuelChen, matterId: M.harbor,
      inputs: { matter: M.harbor, contract_name: "Aurora Health MSA (2023)", contract_text: { blobId: "blob_wf_aurora_msa", name: "Aurora_Health_MSA_2023_executed.pdf", text: "[MSA — 46 pages; Exhibit B missing from the data room copy]" } },
      error: "Cancelled by user", errorCode: "cancelled",
      usage: { input: 18900, output: 2100, total: 21000, calls: 1, costUsd: 0.0683 },
      steps: [
        { nodeId: "start", status: "succeeded", secs: 0, output: { triggeredBy: "manual" } },
        { nodeId: "extract", status: "succeeded", secs: 41, tokens: 21000, output: { parties: ["Bluewater Analytics, Inc.", "Aurora Health Partners, LLC"], effective_date: "2023-03-01", initial_term: "Three (3) years", auto_renewal: true, renewal_notice_days: 90, termination_for_convenience: "Customer only, 60 days' notice (§ 12.2)", change_of_control: "Consent required for assignment 'including by operation of law or change of control' (§ 18.3)", exclusivity: "None", limitation_of_liability: "12 months' fees; consequential damages excluded; carve-outs for confidentiality and indemnity (§ 14)", indemnities: "Mutual IP and data-breach indemnity, uncapped for data breach (§ 13)", ip_ownership: "Customer data owned by Aurora; derived analytics owned by Bluewater (§ 9)", data_privacy: "HIPAA BAA attached as Exhibit B (missing from data room copy)", payment_terms: "Net 45; 3% annual escalator", governing_law: "Delaware; Wilmington courts", insurance: "$5M cyber; $2M E&O", other_flags: ["Exhibit B (BAA) missing", "Uncapped data-breach indemnity", "Change-of-control consent required"], _evidence: [] }, logs: ["Extracted 16 field(s)"] },
        { nodeId: "rows", status: "skipped", secs: 0, logs: ["Cancelled"] },
        { nodeId: "workbook", status: "skipped" }, { nodeId: "export", status: "skipped" }, { nodeId: "task", status: "skipped" },
      ],
    },
  ];
  return specs.map((s) => mkRun(s, workflows.get(s.workflowId)!));
}

// ─────────────────────────── System workflow runs ───────────────────────────

const SYS_OPINIONS = ["idoc_seed_op_afff_0921", "idoc_seed_op_afff_0919", "idoc_seed_op_depo_0920", "idoc_seed_op_ca4_0918", "idoc_seed_op_ilnd_0917", "idoc_seed_op_scotus_0916"];
const SYS_DOCKETS = ["idoc_seed_de_2873_1204", "idoc_seed_de_3140_0331"];
const SYS_DOCKET_ROWS = [
  { id: SYS_DOCKETS[0], kind: "docket_entry", title: "MDL 2873 — Dkt. 1204: Order granting in part motion to compel Tier 2 custodial productions", date: "2026-09-23", court: "D.S.C.", docketNumber: "2:18-mn-02873", url: "https://www.courtlistener.com/docket/6524213/in-re-aqueous-film-forming-foams-products-liability-litigation/", confidence: 0.96, matterIds: [M.afff] },
  { id: SYS_DOCKETS[1], kind: "docket_entry", title: "MDL 3140 — Dkt. 331: Case Management Order No. 12 (bellwether pool selection)", date: "2026-09-23", court: "N.D. Fla.", docketNumber: "3:25-md-03140", url: "https://www.courtlistener.com/docket/70120993/in-re-depo-provera-products-liability-litigation/", confidence: 0.95, matterIds: [M.depo] },
];

function systemRuns(workflows: Map<string, Workflow>): WorkflowRunRecord[] {
  const R = WORKFLOW_SEED_IDS.systemRuns;
  const trend = "iins_seed_trend_authority";
  const specs: RunSpec[] = [
    // 1 — authority refresh: quiet, complete
    {
      id: R[0], workflowId: S.authorityRefresh, workflowName: "Authority refresh", category: "automation", status: "succeeded", startedAt: "2026-09-23T09:00:02.000Z", triggeredBy: "schedule",
      inputs: { __event: { scheduledFor: "2026-09-23T09:00:00.000Z", frequency: "daily" } },
      steps: [
        { nodeId: "schedule", status: "succeeded", secs: 0, output: { inputs: {}, startedAt: "2026-09-23T09:00:02.000Z", triggeredBy: "schedule", scheduledFor: "2026-09-23T09:00:00.000Z", frequency: "daily" } },
        { nodeId: "opinions", status: "succeeded", secs: 41, output: { jobId: "ijob_seed_op_0923", status: "succeeded", sourceId: "isrc_sys_cl_opinions", sourceName: "CourtListener opinions", added: 6, updated: 2, skipped: 14, docIds: SYS_OPINIONS, errors: [], notes: ["3 queries · 22 results · 6 new"], kinds: ["opinion"] }, logs: ["CourtListener opinions: 6 added, 2 updated, 14 unchanged"] },
        { nodeId: "rules", status: "succeeded", secs: 12, output: { jobId: "ijob_seed_rules_0923", status: "succeeded", sourceId: "isrc_sys_court_rules", sourceName: "Court rules", added: 0, updated: 1, skipped: 9, docIds: ["idoc_seed_rule_dsc_local"], errors: [], notes: ["D.S.C. Local Civil Rules: amended 2026-09-15"], kinds: ["court_rule"] }, logs: ["Court rules: 0 added, 1 updated"] },
        { nodeId: "steward", status: "succeeded", secs: 0, output: { checked: 0, fixed: 0, escalated: 0, notes: ["No failed steps to review."], failures: [] }, logs: ["Steward: 0 failure(s) reviewed, 0 fixed, 0 escalated"] },
        { nodeId: "extract", status: "succeeded", secs: 58, tokens: 14200, output: { docs: 6, summarized: 6, entitiesFound: 19, flagged: 0, docIds: SYS_OPINIONS, texts: [], uploaded: [] }, logs: ["Extracted 6 document(s): 6 summarized, 19 entity mention(s)"] },
        { nodeId: "index", status: "succeeded", secs: 9, output: { docs: 6, chunks: 71, embedded: 71, docIds: SYS_OPINIONS }, logs: ["71 chunk(s) indexed, 71 embedded"] },
        { nodeId: "entities", status: "succeeded", secs: 1, output: { docs: 6, entities: 11, relations: 17, entityIds: ["ient_judge_gergel", "ient_judge_rodgers", "ient_court_dsc", "ient_firm_dechert"], byType: { judge: 2, court: 3, attorney: 4, firm: 2 } }, logs: ["11 entit(ies) linked, 17 relation(s)"] },
        { nodeId: "trends", status: "succeeded", secs: 3, output: { analysis: "trends", insightIds: [trend], insights: [{ id: trend, kind: "trend", title: "Case law and court rules — last 90 days", summary: "Opinions touching the matters' themes rose to 22 in September (Daubert rulings in the AFFF MDL drove the increase).", confidence: 0.82 }], docCount: 214, text: "22 opinions in September vs. a 14/month average; anomaly: +2.1σ." }, logs: ["trends: 1 insight(s) over 214 document(s)"] },
        { nodeId: "verify", status: "succeeded", secs: 6, tokens: 3100, output: { target: "insights", checked: 1, verified: 1, flagged: 0, skipped: 0, trusted: true, insightIds: [trend] }, logs: ["1 insight(s) verified, 0 flagged"] },
        { nodeId: "publish", status: "succeeded", secs: 0, output: { to: "home", published: 1, skipped: 0, notified: [], insightIds: [trend], itemIds: [], updateIds: [], href: `/?insight=${trend}` }, logs: ["Published 1 to home"] },
      ],
      usage: { input: 15100, output: 2200, total: 17300, calls: 8, costUsd: 0.06 },
    },
    // 2 — docket watch: two new entries, watchers alerted
    {
      id: R[1], workflowId: S.docketWatch, workflowName: "Docket watch", category: "automation", status: "succeeded", startedAt: "2026-09-23T14:05:01.000Z", triggeredBy: "schedule",
      inputs: { __event: { scheduledFor: "2026-09-23T14:05:00.000Z", frequency: "hourly" } },
      steps: [
        { nodeId: "schedule", status: "succeeded", secs: 0, output: { inputs: {}, startedAt: "2026-09-23T14:05:01.000Z", triggeredBy: "schedule", scheduledFor: "2026-09-23T14:05:00.000Z", frequency: "hourly" } },
        { nodeId: "dockets", status: "succeeded", secs: 18, output: { jobId: "ijob_seed_dk_0923", status: "succeeded", sourceId: "isrc_sys_cl_dockets", sourceName: "CourtListener dockets (RECAP)", added: 2, updated: 0, skipped: 41, docIds: SYS_DOCKETS, errors: [], notes: ["2 dockets · 43 entries · 2 new"], kinds: ["docket_entry"] }, logs: ["RECAP dockets: 2 added, 41 unchanged"] },
        { nodeId: "steward", status: "succeeded", secs: 0, output: { checked: 0, fixed: 0, escalated: 0, notes: ["No failed steps to review."], failures: [] } },
        { nodeId: "index", status: "succeeded", secs: 2, output: { docs: 2, chunks: 4, embedded: 4, docIds: SYS_DOCKETS } },
        { nodeId: "new_entries", status: "succeeded", secs: 0, output: { source: "intel_documents", count: 2, total: 2, rows: SYS_DOCKET_ROWS, ids: SYS_DOCKETS, text: SYS_DOCKET_ROWS.map((r) => `- **${r.title}** · docket_entry · ${r.date} · ${r.court} — ${r.url}`).join("\n") }, logs: ["2 of 2 intel documents row(s)"] },
        { nodeId: "any", status: "succeeded", secs: 0, output: { matched: "yes", label: "New entries", evaluations: [{ ruleId: "yes", label: "New entries", matched: true, conditions: [{ left: 2, op: "gt", right: "0", result: true }] }] }, logs: ['Matched "New entries"'] },
        { nodeId: "alert", status: "succeeded", secs: 0, output: { to: "watch", published: 1, skipped: 0, notified: [P.jordanWhitfield, P.mariaLopez, P.priyaRaman], insightIds: ["iins_seed_alert_dockets_0923"], itemIds: [], updateIds: ["tu_wf_sys_dk_0923"], taskIds: [], href: "/?insight=iins_seed_alert_dockets_0923" }, logs: ["Published 1 to watch; notified 3"] },
      ],
      artifacts: [{ kind: "notification", id: "wn_sys_dk_0923", title: "2 new docket entries on watched dockets", href: "/?insight=iins_seed_alert_dockets_0923", nodeId: "alert", meta: { recipients: ["Jordan Whitfield", "Maria Lopez", "Priya Raman"] } }],
      usage: { input: 0, output: 0, total: 0, calls: 0, costUsd: 0 },
    },
    // 3 — regulatory watch: openFDA hiccup fixed by the steward
    {
      id: R[2], workflowId: S.regulatoryWatch, workflowName: "Regulatory watch", category: "automation", status: "succeeded", startedAt: "2026-09-22T10:00:03.000Z", triggeredBy: "schedule",
      inputs: { __event: { scheduledFor: "2026-09-22T10:00:00.000Z", frequency: "daily" } },
      steps: [
        { nodeId: "schedule", status: "succeeded", secs: 0, output: { inputs: {}, startedAt: "2026-09-22T10:00:03.000Z", triggeredBy: "schedule", scheduledFor: "2026-09-22T10:00:00.000Z", frequency: "daily" } },
        { nodeId: "fda", status: "succeeded", secs: 33, output: { jobId: "ijob_seed_fda_0922", status: "succeeded", sourceId: "isrc_sys_openfda", sourceName: "openFDA", added: 3, updated: 0, skipped: 12, docIds: ["idoc_seed_fda_recall_0922", "idoc_seed_fda_label_dmpa_0921", "idoc_seed_fda_faers_0920"], errors: [], notes: ["enforcement + label endpoints"], kinds: ["recall", "regulation", "adverse_event"] }, logs: ["Failed (network); the run continues (on failure: continue)", "Steward re-run with {}", "openFDA: 3 added, 12 unchanged"] },
        { nodeId: "fr", status: "succeeded", secs: 9, output: { jobId: "ijob_seed_fr_0922", status: "succeeded", sourceId: "isrc_sys_federal_register", sourceName: "Federal Register", added: 2, updated: 0, skipped: 6, docIds: ["idoc_seed_fr_2026_21044", "idoc_seed_fr_2026_21102"], errors: [], notes: [], kinds: ["register_notice"] } },
        { nodeId: "ecfr", status: "succeeded", secs: 7, output: { jobId: "ijob_seed_ecfr_0922", status: "succeeded", sourceId: "isrc_sys_ecfr", sourceName: "eCFR", added: 0, updated: 0, skipped: 4, docIds: [], errors: [], notes: ["40 CFR 141 / 21 CFR 201: unchanged"], kinds: [] } },
        { nodeId: "steward", status: "succeeded", secs: 34, output: { checked: 1, fixed: 1, escalated: 0, notes: ['"Fetch openFDA" recovered after retry.'], failures: [{ nodeId: "fda", label: "Fetch openFDA", code: "network", action: "retry", ok: true, error: "openFDA: 503 Service Unavailable", note: "Fixed by retry" }] }, logs: ['Steward: "Fetch openFDA" failed (network) → retry', "Steward: 1 failure(s) reviewed, 1 fixed, 0 escalated"] },
        { nodeId: "extract", status: "succeeded", secs: 21, tokens: 5200, output: { docs: 2, summarized: 2, entitiesFound: 5, flagged: 0, docIds: ["idoc_seed_fr_2026_21044", "idoc_seed_fr_2026_21102"], texts: [], uploaded: [] } },
        { nodeId: "index", status: "succeeded", secs: 3, output: { docs: 2, chunks: 9, embedded: 9, docIds: ["idoc_seed_fr_2026_21044", "idoc_seed_fr_2026_21102"] } },
        { nodeId: "fresh", status: "succeeded", secs: 0, output: { source: "intel_documents", count: 5, total: 5, rows: [], ids: ["idoc_seed_fda_recall_0922", "idoc_seed_fda_label_dmpa_0921", "idoc_seed_fda_faers_0920", "idoc_seed_fr_2026_21044", "idoc_seed_fr_2026_21102"], text: "- **EPA — PFAS NPDWR compliance guidance** · register_notice · 2026-09-22\n- **Depo-Provera labeling supplement (meningioma)** · regulation · 2026-09-21" } },
        { nodeId: "any", status: "succeeded", secs: 0, output: { matched: "yes", label: "New records", evaluations: [] } },
        { nodeId: "trends", status: "succeeded", secs: 2, output: { analysis: "trends", insightIds: ["iins_seed_trend_regulatory"], insights: [{ id: "iins_seed_trend_regulatory", kind: "trend", title: "Regulatory activity — last 30 days", summary: "Regulatory records on the matters' products: 19 in the last 30 days, led by FDA labeling and EPA PFAS guidance.", confidence: 0.79 }], docCount: 63, text: "19 records / 30 days" } },
        { nodeId: "verify", status: "succeeded", secs: 5, tokens: 2400, output: { target: "insights", checked: 1, verified: 1, flagged: 0, skipped: 0, trusted: true, insightIds: ["iins_seed_trend_regulatory"] } },
        { nodeId: "publish", status: "succeeded", secs: 0, output: { to: "home", published: 1, skipped: 0, notified: [], insightIds: ["iins_seed_trend_regulatory"], itemIds: [], updateIds: [], href: "/?insight=iins_seed_trend_regulatory" } },
      ],
      stewardship: [{ nodeId: "fda", code: "network", action: "retry", fixed: true, escalated: false, note: "Fixed by retry" }],
      logs: ['"Fetch openFDA" failed and the run continued: openFDA: 503 Service Unavailable'],
      usage: { input: 6800, output: 900, total: 7700, calls: 4, costUsd: 0.03 },
    },
    // 4 — insight verification sweep: two flagged, task opened
    {
      id: R[3], workflowId: S.insightSweep, workflowName: "Insight verification sweep", category: "automation", status: "succeeded", startedAt: "2026-09-23T12:20:01.000Z", triggeredBy: "schedule",
      inputs: { __event: { scheduledFor: "2026-09-23T12:20:00.000Z", frequency: "hourly" } },
      steps: [
        { nodeId: "schedule", status: "succeeded", secs: 0, output: { inputs: {}, startedAt: "2026-09-23T12:20:01.000Z", triggeredBy: "schedule", scheduledFor: "2026-09-23T12:20:00.000Z", frequency: "hourly", interval: 6 } },
        { nodeId: "verify", status: "succeeded", secs: 84, tokens: 21900, output: { target: "insights", checked: 25, verified: 23, flagged: 2, skipped: 0, trusted: false, insightIds: ["iins_seed_profile_gergel", "iins_seed_chron_afff"], flaggedIds: ["iins_seed_profile_gergel", "iins_seed_chron_afff"] }, logs: ["25 insight(s) re-verified: 23 supported, 2 flagged (contradicted evidence)"] },
        { nodeId: "flagged", status: "succeeded", secs: 0, output: { source: "intel_insights", count: 2, total: 2, rows: [{ id: "iins_seed_profile_gergel", kind: "profile", title: "Judge Gergel — profile", status: "flagged", confidence: 0.61 }, { id: "iins_seed_chron_afff", kind: "chronology", title: "Chronology — AFFF", status: "flagged", confidence: 0.58 }], ids: ["iins_seed_profile_gergel", "iins_seed_chron_afff"], text: "- **Judge Gergel — profile** · profile · flagged · 61%\n- **Chronology — AFFF** · chronology · flagged · 58%" } },
        { nodeId: "any", status: "succeeded", secs: 0, output: { matched: "yes", label: "Flagged", evaluations: [] } },
        { nodeId: "task", status: "succeeded", secs: 0, output: { taskId: "t_wf_sys_flagged_0923", title: "Review 2 flagged insight(s)", dueAt: "2026-09-25", assignee: "Aisha Khan", href: "/?task=t_wf_sys_flagged_0923" }, logs: ['Task "Review 2 flagged insight(s)" → Aisha Khan, due 2026-09-25'] },
      ],
      artifacts: [{ kind: "task", id: "t_wf_sys_flagged_0923", title: "Review 2 flagged insight(s)", href: "/?task=t_wf_sys_flagged_0923", nodeId: "task", meta: { dueAt: "2026-09-25", assignee: "Aisha Khan" } }],
      usage: { input: 19800, output: 2100, total: 21900, calls: 25, costUsd: 0.07 },
    },
    // 5 — team digest: one brief per person
    {
      id: R[4], workflowId: S.teamDigest, workflowName: "Team digest", category: "automation", status: "succeeded", startedAt: "2026-09-23T11:00:02.000Z", triggeredBy: "schedule",
      inputs: { __event: { scheduledFor: "2026-09-23T11:00:00.000Z", frequency: "daily" } },
      steps: [
        { nodeId: "schedule", status: "succeeded", secs: 0, output: { inputs: {}, startedAt: "2026-09-23T11:00:02.000Z", triggeredBy: "schedule", scheduledFor: "2026-09-23T11:00:00.000Z", frequency: "daily", weekdaysOnly: true } },
        { nodeId: "people", status: "succeeded", secs: 0, output: { source: "people", count: 8, total: 8, rows: [], ids: [P.jordanWhitfield, P.priyaRaman, P.danielOkafor, P.elenaMarsh, P.samuelChen, P.mariaLopez, P.aishaKhan], text: "- **Jordan Whitfield** · Partner · attorney" } },
        { nodeId: "each", status: "succeeded", secs: 4, output: { count: 8, total: 8, results: [], errors: [], errorCount: 0 }, logs: ["8 person(s) to process"] },
        { nodeId: "digest", status: "succeeded", secs: 0, output: { to: "digest", published: 1, skipped: 0, notified: [P.aishaKhan], insightIds: ["iins_seed_digest_akhan_0923"], itemIds: [], updateIds: [], taskIds: [], href: "/?insight=iins_seed_digest_akhan_0923" } },
        { nodeId: "done", status: "succeeded", secs: 0, output: { source: "intel_insights", count: 8, total: 8, rows: [], ids: [], text: "- **Your brief — Wednesday, September 23** · digest · published · 90%" } },
      ],
      usage: { input: 0, output: 0, total: 0, calls: 0, costUsd: 0 },
    },
  ];
  return specs.map((s) => mkRun(s, workflows.get(s.workflowId)!));
}

/** workflows module seed: templates, user workflows, system workflows and run history (idempotent, stable ids). */
export function seedWorkflows(db: Database) {
  const templates = buildTemplates();
  // The sample dataset's intelligence corpus and run history are bound to the US sample sources, so the sample seed
  // keeps the US system workflows; production (reference) workspaces get the India set (buildSystemTemplates).
  const systemWorkflows = buildUsSystemTemplates();
  // Sample user workflows may be copies of US-practice templates that are no longer in the default gallery.
  const byId = new Map([...templates, ...buildUsTemplates()].map((t) => [t.id, t]));
  const userWorkflows: Workflow[] = USER_WORKFLOWS.map((u) => {
    const t = byId.get(u.templateId)!;
    const w: Workflow & { sourceTemplateId?: string; version?: number } = {
      ...JSON.parse(JSON.stringify(t)),
      id: u.id,
      name: u.name,
      description: u.description ?? t.description,
      ownerId: u.ownerId,
      status: u.status,
      isTemplate: false,
      createdAt: u.createdAt,
      updatedAt: u.updatedAt,
      tags: u.tags ?? t.tags,
      sourceTemplateId: u.templateId,
      version: 3,
      runsCount: 0,
    };
    u.patch?.(w);
    return w;
  });
  const all = new Map<string, Workflow>([...templates, ...userWorkflows, ...systemWorkflows].map((w) => [w.id, w]));
  const runRecords = [...runs(all), ...systemRuns(all)];
  for (const w of [...userWorkflows, ...systemWorkflows]) {
    const mine = runRecords.filter((r) => r.workflowId === w.id);
    w.runsCount = mine.length;
    w.lastRunAt = mine.map((r) => r.startedAt).sort().at(-1);
  }
  db.workflows.putMany([...templates, ...userWorkflows, ...systemWorkflows]);
  db.workflowRuns.putMany(runRecords);
  // Scheduled workflows: treat "now" as the last fire so the scheduler waits for the next natural slot.
  const now = new Date().toISOString();
  for (const w of [...userWorkflows, ...systemWorkflows]) if (w.nodes.some((n) => n.type === "trigger.schedule") && !db.kv.get(`wf:schedule:last:${w.id}`)) db.kv.set(`wf:schedule:last:${w.id}`, now);
}
