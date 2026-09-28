/**
 * Built-in workflow templates: fully configured, runnable playbooks. Pure data
 * (positions are computed by autoLayout at seed time) so the seed, the service
 * and the tests can all import it.
 */
import type { Workflow, WorkflowEdge, WorkflowFrontend, WorkflowNode, WorkflowNodeType } from "@/lib/types/domain";
import { autoLayout } from "./graph";
import { defaultConfigFor, type AnyNodeType } from "./registry";
import { INDIA_TEMPLATES, INDIA_TEMPLATE_FRONTENDS, INDIA_WORKFLOW_TEMPLATE_IDS } from "./templates-india";

export { INDIA_WORKFLOW_TEMPLATE_IDS } from "./templates-india";

/**
 * Deliverable step configuration: format, label and folder come from the front
 * end (inputs.output_format / output_label / output_folder) with the template's
 * own defaults; an empty label falls back to the front end's defaultLabel.
 */
const OUT = (format: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ format: `{{inputs.output_format | default:"${format}"}}`, label: "{{inputs.output_label | default:\"\"}}", content: "", rows: "", libraryFolderId: "{{inputs.output_folder | default:\"\"}}", matterId: "{{inputs.matter}}", addToLibrary: true, tags: ["workflow"], ...extra });
const DOC_ACCEPT = [".docx", ".pdf", ".txt", ".md"];
const TRANSCRIPT_ACCEPT = [".txt", ".pdf", ".docx", ".md"];

function N(id: string, type: AnyNodeType, label: string, config: Record<string, unknown> = {}): WorkflowNode {
  return { id, type: type as WorkflowNodeType, label, position: { x: 0, y: 0 }, config: { ...defaultConfigFor(type), ...config } };
}
function E(source: string, target: string, sourceHandle?: string, targetHandle?: string, label?: string): WorkflowEdge {
  return { id: `e_${source}__${target}${sourceHandle ? `__${sourceHandle}` : ""}`, source, target, sourceHandle, targetHandle, label };
}

export type TemplateDef = Omit<Workflow, "createdAt" | "updatedAt" | "status" | "isTemplate" | "ownerId">;

const T0 = "2026-06-01T09:00:00.000Z";

export const WORKFLOW_TEMPLATE_IDS = {
  ndaIntake: "wf_tpl_nda_intake",
  depoDigest: "wf_tpl_depo_digest",
  docketMonitor: "wf_tpl_docket_monitor",
  clauseWorkbook: "wf_tpl_clause_workbook",
  privilegeLog: "wf_tpl_privilege_log",
  chronology: "wf_tpl_chronology",
  researchMemo: "wf_tpl_research_memo",
  clientStatus: "wf_tpl_client_status",
  matterIntake: "wf_tpl_matter_intake",
  citeCheck: "wf_tpl_cite_check",
  meetConfer: "wf_tpl_meet_confer",
  pagaChecklist: "wf_tpl_paga_checklist",
  regulatoryWatch: "wf_tpl_regulatory_watch",
  depoDesignations: "wf_tpl_depo_designations",
  productionQc: "wf_tpl_production_qc",
  judgeProfile: "wf_tpl_judge_profile",
} as const;

const NO_RESEARCH = { web: false, legal: false, internal: false };
const INTERNAL_ONLY = { web: false, legal: false, internal: true };

const TEMPLATES: TemplateDef[] = [
  // 1 ───────────────────────── NDA intake review ─────────────────────────
  {
    id: WORKFLOW_TEMPLATE_IDS.ndaIntake,
    name: "NDA intake review",
    description: "Extract parties, term, governing law and key protections from an incoming NDA, score its risk against firm positions, draft an issues memo, file it and route the review to the right person.",
    category: "intake",
    tags: ["NDA", "contracts", "intake", "risk"],
    inputs: [
      { key: "nda_text", label: "NDA (upload or paste)", type: "file", required: true, placeholder: "Drop the .docx / .pdf or paste the agreement text" },
      { key: "matter", label: "Matter", type: "matter", required: true },
      { key: "our_side", label: "Our client is the", type: "select", required: true, options: ["Receiving Party", "Disclosing Party", "Mutual"] },
      { key: "counterparty", label: "Counterparty", type: "text", placeholder: "Counterparty name" },
    ],
    nodes: [
      N("start", "trigger.manual", "Run with NDA", { note: "Upload the NDA (or paste the text), pick the matter and tell the workflow which side the client is on." }),
      N("extract", "ai.extract", "Extract NDA terms", {
        source: "{{inputs.nda_text}}",
        modelTier: "primary",
        instructions: "Read the entire agreement. If a term is mutual, say so in the value. Convert periods to months. Quote the operative clause in _evidence.",
        fields: [
          { name: "parties", type: "string[]", description: "Full legal names of the parties as written in the preamble" },
          { name: "effective_date", type: "date", description: "Effective date of the agreement" },
          { name: "term_months", type: "number", description: "Term of the agreement in months (0 if indefinite)" },
          { name: "confidentiality_period_months", type: "number", description: "How long confidentiality obligations survive after termination, in months (0 if perpetual)" },
          { name: "governing_law", type: "string", description: "Governing law state or country" },
          { name: "venue", type: "string", description: "Exclusive forum / venue, if any" },
          { name: "purpose", type: "string", description: "Permitted purpose for use of confidential information" },
          { name: "mutual", type: "boolean", description: "True when obligations run both ways" },
          { name: "non_solicit", type: "boolean", description: "True when the NDA contains an employee non-solicitation covenant" },
          { name: "residuals_clause", type: "boolean", description: "True when a residuals clause lets the recipient use retained information" },
          { name: "injunctive_relief", type: "boolean", description: "True when the agreement stipulates to irreparable harm / injunctive relief" },
          { name: "assignment_restriction", type: "string", description: "Assignment / change-of-control restriction, summarized" },
          { name: "standard_carve_outs", type: "string[]", description: "Which standard exclusions are present: public, already known, independently developed, third-party source, compelled disclosure" },
          { name: "unusual_terms", type: "string[]", description: "Any term a senior lawyer would flag as unusual for an NDA (indemnity, liquidated damages, exclusivity, IP assignment, audit rights…)" },
        ],
      }),
      N("classify", "ai.classify", "Score risk", {
        source: "Our client is the {{inputs.our_side}}.\n\nExtracted terms:\n{{steps.extract.output | json}}\n\nAgreement text (excerpt):\n{{inputs.nda_text | truncate:20000}}",
        modelTier: "primary",
        labels: [
          { label: "low", description: "Standard mutual NDA: 2–5 year term, ordinary carve-outs, no non-solicit, no residuals, familiar governing law (DE/NY/CA/IL/SC)" },
          { label: "medium", description: "Negotiable issues: one-way obligations against our client, perpetual confidentiality for non-trade-secret information, non-solicit, unusual venue, broad definition of Confidential Information" },
          { label: "high", description: "Unacceptable as drafted: residuals clause against a disclosing client, IP assignment or license grant, indemnity or liquidated damages, exclusivity or standstill, compelled-disclosure carve-out missing, unlimited term with no return/destroy obligation" },
        ],
        instructions: "Apply the firm's standard NDA positions. Weight issues by which side the client is on: a residuals clause is high risk for a disclosing client but low risk for a receiving client.",
      }),
      N("draft", "ai.draft", "Draft issues memo", {
        kind: "memo",
        tone: "formal",
        audience: "partner",
        modelTier: "primary",
        research: INTERNAL_ONLY,
        brief: "Draft an NDA review memo for {{matter.name}} ({{matter.client}}). Our client is the {{inputs.our_side}}{{inputs.counterparty | default:\"\"}}.\n\nRisk classification: {{steps.classify.output.label | upper}} ({{steps.classify.output.confidence}}) — {{steps.classify.output.rationale}}\n\nExtracted terms:\n{{steps.extract.output | json}}\n\nStructure: (1) Bottom line with the recommendation (sign / sign with edits / do not sign); (2) Deal terms table (Term | As drafted | Firm position | Recommended edit); (3) Issues, worst first, each with the clause quote, why it matters for a {{inputs.our_side}}, and proposed replacement language; (4) Items needing client input. Cite the clause numbers from the agreement.",
        context: "Agreement text:\n{{inputs.nda_text | truncate:60000}}",
      }),
      N("save", "output.file", "Save the memo", OUT("docx", { content: "{{steps.draft.output.text}}", tags: ["NDA", "review", "workflow"] })),
      N("route", "logic.branch", "Route by risk", { rules: [{ id: "high", label: "High risk", logic: "all", conditions: [{ left: "{{steps.classify.output.label}}", op: "equals", right: "high" }] }, { id: "medium", label: "Medium risk", logic: "all", conditions: [{ left: "{{steps.classify.output.label}}", op: "equals", right: "medium" }] }], elseLabel: "Low risk" }),
      N("task_partner", "action.create_task", "Partner review (urgent)", { title: "NDA review: {{inputs.counterparty | default:\"counterparty\"}} — HIGH risk, partner sign-off needed", description: "{{steps.classify.output.rationale}}\n\nMemo: {{steps.save.output.href}}", assigneeId: "{{user.id}}", priority: "urgent", dueRule: "+1bd", matterId: "{{inputs.matter}}", tags: ["NDA", "review"] }),
      N("task_associate", "action.create_task", "Associate markup", { title: "NDA markup: {{inputs.counterparty | default:\"counterparty\"}} ({{steps.classify.output.label}} risk)", description: "Turn the issues memo into a redline. {{steps.classify.output.rationale}}\n\nMemo: {{steps.save.output.href}}", assigneeId: "{{user.id}}", priority: "high", dueRule: "+3bd", matterId: "{{inputs.matter}}", tags: ["NDA", "markup"] }),
      N("task_clear", "action.create_task", "Clear for signature", { title: "NDA cleared: {{inputs.counterparty | default:\"counterparty\"}} — confirm and send for signature", description: "Low risk per intake review. Memo: {{steps.save.output.href}}", assigneeId: "{{user.id}}", priority: "medium", dueRule: "+5bd", matterId: "{{inputs.matter}}", tags: ["NDA"] }),
      N("notify", "action.notify", "Post to team", { recipientIds: ["{{user.id}}"], kind: "update", message: "NDA intake review finished for {{inputs.counterparty | default:\"counterparty\"}} on {{matter.shortName}}: **{{steps.classify.output.label | upper}} risk**. {{steps.classify.output.rationale | truncate:300}}\n\nMemo: {{steps.save.output.href}}", matterId: "{{inputs.matter}}" }),
    ],
    edges: [E("start", "extract"), E("extract", "classify"), E("classify", "draft"), E("draft", "save"), E("save", "route"), E("route", "task_partner", "high"), E("route", "task_associate", "medium"), E("route", "task_clear", "else"), E("task_partner", "notify"), E("task_associate", "notify"), E("task_clear", "notify")],
  },

  // 2 ───────────────────────── Deposition digest ─────────────────────────
  {
    id: WORKFLOW_TEMPLATE_IDS.depoDigest,
    name: "Deposition digest",
    description: "Turn a rough transcript into a page:line digest of key admissions, contradictions and exhibits, save the memo to the matter and tell the team.",
    category: "discovery",
    tags: ["deposition", "transcript", "digest", "PW / DW"],
    inputs: [
      { key: "transcript_text", label: "Transcript (upload or paste)", type: "file", required: true },
      { key: "witness", label: "Witness", type: "text", required: true, placeholder: "Witness name, title" },
      { key: "matter", label: "Matter", type: "matter", required: true },
      { key: "focus", label: "Themes to focus on", type: "textarea", placeholder: "Key documents; decisions; communications the witness was part of" },
    ],
    nodes: [
      N("start", "trigger.manual", "Run with transcript"),
      N("digest", "ai.summarize", "Page:line digest", { source: "{{inputs.transcript_text}}", style: "qa", length: "long", focus: "{{inputs.focus | default:\"admissions, contradictions with documents, evasive answers, exhibits\"}}", modelTier: "primary" }),
      N("extract", "ai.extract", "Pull admissions & exhibits", {
        source: "Witness: {{inputs.witness}}\n\nDigest:\n{{steps.digest.output.text}}\n\nTranscript:\n{{inputs.transcript_text | truncate:90000}}",
        modelTier: "primary",
        instructions: "Every item must carry a page:line cite in the form 14:8–15:2 (for a chief-examination affidavit, the paragraph number as well). Keep examination-in-chief, cross-examination and re-examination apart. Contradictions should name the document (exhibit mark such as Ex.P7, or document reference) or prior testimony they conflict with. If the witness qualifies an earlier answer later, report both.",
        fields: [
          { name: "key_admissions", type: "string[]", description: "Admissions helpful to our client, each with page:line" },
          { name: "harmful_testimony", type: "string[]", description: "Testimony that hurts our client, each with page:line" },
          { name: "contradictions", type: "string[]", description: "Statements that conflict with documents or earlier testimony, with cites on both sides" },
          { name: "exhibits", type: "string[]", description: "Exhibits marked or confronted (Ex.P / Ex.D / Ex.C marks), with document references where stated" },
          { name: "objections_instructions", type: "string[]", description: "Objections and instructions not to answer with page:line and basis" },
          { name: "follow_up", type: "string[]", description: "Follow-up questions or documents to chase before the next session" },
          { name: "credibility_notes", type: "string[]", description: "Demeanor / credibility observations supported by the record" },
        ],
      }),
      N("verify", "ai.verify", "Verify cites against transcript", { output: "{{steps.extract.output}}", sources: "{{inputs.transcript_text | truncate:90000}}", stepId: "extract", mode: "structured", modelTier: "fast" }),
      N("memo", "ai.draft", "Draft digest memo", {
        kind: "memo", tone: "neutral", audience: "team", modelTier: "primary", research: NO_RESEARCH,
        brief: "Draft the deposition digest memo for the deposition of {{inputs.witness}} in {{matter.name}}.\n\nSections: Summary (5 bullets); Key admissions; Harmful testimony and how to contain it; Contradictions (table: Testimony | Conflicts with | Significance); Exhibits; Objections and instructions; Follow-up. Keep every page:line cite exactly as given; keep any [VERIFY] marks.\n\nStructured findings (verified: {{steps.verify.output.status}}):\n{{steps.verify.output.corrected | json}}",
        context: "Page:line digest:\n{{steps.digest.output.text}}",
      }),
      N("review", "logic.review", "Trust review", { steps: "extract, verify, memo", approverId: "{{user.id}}", title: "Deposition digest needs a look", message: "Some of the AI digest for {{inputs.witness}} did not verify against the transcript. Approve to save and circulate anyway, or reject to stop." }),
      N("save", "output.file", "Save digest", OUT("docx", { content: "{{steps.memo.output.text}}", tags: ["deposition", "digest"] })),
      N("notify", "action.notify", "Notify case team", { recipientIds: ["{{user.id}}"], kind: "update", message: "Deposition digest for **{{inputs.witness}}** is ready on {{matter.shortName}} (verification: {{steps.verify.output.status}}).\n\nTop admissions:\n{{steps.extract.output.key_admissions | slice:0,3 | bullets}}\n\n{{steps.save.output.href}}", matterId: "{{inputs.matter}}" }),
      N("task", "action.create_task", "Attorney review", { title: "Review deposition digest: {{inputs.witness}}", description: "Check page:line cites against the certified transcript and confirm the contradictions list before it goes into the outline. Unresolved cites: {{steps.verify.output.unresolvedCites | join:\", \" | default:\"none\"}}\n\n{{steps.save.output.href}}", assigneeId: "{{user.id}}", priority: "high", dueRule: "+3bd", matterId: "{{inputs.matter}}", tags: ["deposition"] }),
    ],
    edges: [E("start", "digest"), E("digest", "extract"), E("extract", "verify"), E("verify", "memo"), E("memo", "review"), E("review", "save", "approved"), E("save", "notify"), E("save", "task")],
  },

  // 3 ───────────────────────── Docket monitor ─────────────────────────
  {
    id: WORKFLOW_TEMPLATE_IDS.docketMonitor,
    name: "Docket monitor",
    description: "Every morning, search PACER/RECAP for new docket activity matching the matter, open a task for each new entry and post a digest to the team.",
    category: "operations",
    tags: ["docket", "PACER", "monitor", "scheduled"],
    inputs: [
      { key: "docket_query", label: "Docket search", type: "text", required: true, placeholder: "Party name or case caption" },
      { key: "courts", label: "Courts (CourtListener ids)", type: "text", placeholder: "dsc" },
      { key: "matter", label: "Matter", type: "matter", required: true },
    ],
    nodes: [
      N("schedule", "trigger.schedule", "Every morning 07:00", { schedule: { frequency: "daily", time: "07:00" }, enabled: true, presetInputs: {} }),
      N("search", "data.legal_search", "New docket activity", { source: "dockets", query: "{{inputs.docket_query}}", courts: "{{inputs.courts}}", after: "-1d", limit: 20 }),
      N("any_new", "logic.branch", "Anything new?", { rules: [{ id: "yes", label: "New entries", logic: "all", conditions: [{ left: "{{steps.search.output.results | length}}", op: "gt", right: "0" }] }], elseLabel: "Nothing new" }),
      N("each", "logic.loop", "For each entry", { over: "{{steps.search.output.results}}", maxIterations: 20, itemLabel: "docket entry", stopOnError: false }),
      N("task", "action.create_task", "Task: review filing", { title: "Docket: {{loop.item.case_name}} — {{loop.item.docket_number}} ({{loop.item.date_filed}})", description: "{{loop.item.court}} · filed {{loop.item.date_filed}}{{loop.item.assigned_to | default:\"\"}}\n{{loop.item.url}}\n\nPull the filing, calendar any response deadline, and note it in the matter chronology.", assigneeId: "{{user.id}}", priority: "high", dueRule: "+1bd", matterId: "{{inputs.matter}}", tags: ["docket"] }),
      N("digest", "action.notify", "Post digest", { recipientIds: ["{{user.id}}"], kind: "update", message: "Docket monitor: **{{steps.search.output.results | length}}** new item(s) for \"{{inputs.docket_query}}\" since yesterday.\n\n{{steps.search.output.text | truncate:1500}}", matterId: "{{inputs.matter}}" }),
    ],
    edges: [E("schedule", "search"), E("search", "any_new"), E("any_new", "each", "yes"), E("each", "task", "each"), E("task", "each", undefined, "loop-back"), E("each", "digest", "done")],
  },

  // 4 ───────────────────────── Contract clause extraction → workbook ─────────────────────────
  {
    id: WORKFLOW_TEMPLATE_IDS.clauseWorkbook,
    name: "Contract clause extraction to workbook",
    description: "Extract the commercial and risk terms from a contract into typed fields, turn them into a clause-by-clause review table and save it as a workbook for the diligence tracker.",
    category: "transactional",
    tags: ["diligence", "contracts", "workbook", "M&A"],
    inputs: [
      { key: "contract_text", label: "Contract (upload or paste)", type: "file", required: true },
      { key: "contract_name", label: "Contract name", type: "text", required: true, placeholder: "Master services agreement (2023)" },
      { key: "matter", label: "Matter", type: "matter", required: true },
    ],
    nodes: [
      N("start", "trigger.manual", "Run with contract"),
      N("extract", "ai.extract", "Extract key terms", {
        source: "{{inputs.contract_text}}", modelTier: "primary",
        instructions: "This is buy-side diligence. Read every section including schedules. Quote the section number in _evidence.",
        fields: [
          { name: "parties", type: "string[]", description: "Legal names of the parties" },
          { name: "effective_date", type: "date", description: "Effective date" },
          { name: "initial_term", type: "string", description: "Initial term as written" },
          { name: "auto_renewal", type: "boolean", description: "Whether the agreement auto-renews" },
          { name: "renewal_notice_days", type: "number", description: "Days of notice required to prevent renewal (0 if none)" },
          { name: "termination_for_convenience", type: "string", description: "Who may terminate for convenience and on what notice" },
          { name: "change_of_control", type: "string", description: "Change-of-control / assignment consent requirement, quoted or summarized" },
          { name: "exclusivity", type: "string", description: "Exclusivity, non-compete or most-favored-nation obligations" },
          { name: "limitation_of_liability", type: "string", description: "Cap and exclusions (consequential damages, carve-outs)" },
          { name: "indemnities", type: "string", description: "Indemnity scope, direction and caps" },
          { name: "ip_ownership", type: "string", description: "IP ownership, licenses back, work-product terms" },
          { name: "data_privacy", type: "string", description: "Data protection / security obligations and breach notice periods" },
          { name: "payment_terms", type: "string", description: "Fees, payment timing, price escalators" },
          { name: "governing_law", type: "string", description: "Governing law and forum" },
          { name: "insurance", type: "string", description: "Insurance requirements" },
          { name: "other_flags", type: "string[]", description: "Anything else a buyer must know (minimum commitments, audit rights, set-off, source-code escrow)" },
        ],
      }),
      N("rows", "ai.prompt", "Build review rows", {
        instructions: "You convert extracted contract terms into a diligence review table. Return only JSON matching the schema. One row per clause topic, in the order given. Risk is from the buyer's perspective: Low / Medium / High. 'Location' is the section number(s) quoted in the evidence.",
        prompt: "Contract: {{inputs.contract_name}}\nMatter: {{matter.name}} ({{matter.client}}, {{matter.clientSide}})\n\nExtracted terms with evidence:\n{{steps.extract.output | json}}",
        output: "json", modelTier: "fast", research: NO_RESEARCH,
        jsonSchema: JSON.stringify({ type: "object", properties: { rows: { type: "array", items: { type: "object", properties: { clause: { type: "string" }, as_drafted: { type: "string" }, location: { type: "string" }, risk: { type: "string", enum: ["Low", "Medium", "High"] }, issue: { type: "string" }, recommended_action: { type: "string" } }, required: ["clause", "as_drafted", "location", "risk", "issue", "recommended_action"] } } }, required: ["rows"] }),
      }),
      N("workbook", "output.file", "Save review workbook", OUT("xlsx", { rows: "{{steps.rows.output.rows}}", tags: ["diligence", "clause-review"] })),
      N("export", "output.file", "Export CSV", { format: "csv", label: "clause-review-{{inputs.contract_name}}", content: "", rows: "{{steps.rows.output.rows}}", libraryFolderId: "{{inputs.output_folder | default:\"\"}}", matterId: "{{inputs.matter}}", addToLibrary: true, tags: ["diligence", "csv"] }),
      N("task", "action.create_task", "Add to diligence tracker", { title: "Diligence: fold {{inputs.contract_name}} review into the tracker ({{steps.rows.output.rows | where:risk,High | length}} high-risk items)", description: "Workbook: {{steps.workbook.output.href}}\nCSV: {{steps.export.output.url}}", assigneeId: "{{user.id}}", priority: "medium", dueRule: "+2bd", matterId: "{{inputs.matter}}", tags: ["diligence"] }),
    ],
    edges: [E("start", "extract"), E("extract", "rows"), E("rows", "workbook"), E("rows", "export"), E("workbook", "task"), E("export", "task")],
  },

  // 5 ───────────────────────── Privilege log builder ─────────────────────────
  {
    id: WORKFLOW_TEMPLATE_IDS.privilegeLog,
    name: "Privilege log builder",
    description: "Collect the documents coded privileged for a custodian, draft a privilege-safe description and basis for each, and save the log as a workbook ready for paralegal QC.",
    category: "discovery",
    tags: ["privilege", "log", "case records", "BSA s.132"],
    inputs: [
      { key: "matter", label: "Matter", type: "matter", required: true },
      { key: "custodian", label: "Custodian (optional)", type: "text", placeholder: "Custodian surname" },
      { key: "limit", label: "Max documents", type: "number", placeholder: "25" },
    ],
    nodes: [
      N("start", "trigger.manual", "Run for custodian"),
      N("search", "data.search_ediscovery", "Privileged documents", { query: "*", matterId: "{{inputs.matter}}", custodian: "{{inputs.custodian}}", privilegedOnly: true, limit: 25 }),
      N("entries", "logic.loop", "For each document", { over: "{{steps.search.output.results}}", maxIterations: 50, itemLabel: "document", stopOnError: false }),
      N("describe", "ai.prompt", "Draft log entry", {
        instructions: "You draft privilege log entries for documents withheld on the ground of privilege under Indian law: advocate–client communications (Bharatiya Sakshya Adhiniyam, 2023, s.132; Indian Evidence Act, 1872, s.126) and confidential communications with a legal adviser (BSA s.134; IEA s.129). Describe the nature of the document without revealing privileged content, identify the advocate involved and state the basis. Never quote legal advice. An advocate merely copied on a business communication does not make it privileged: say so in the description instead of claiming privilege. Use the pattern 'E-mail from/to [advocate name, designation] seeking/giving legal advice regarding [subject matter]'.",
        prompt: "Document:\nBates {{loop.item.bates}} · {{loop.item.date}} · {{loop.item.type}}\nFrom: {{loop.item.from}}\nTo: {{loop.item.to | join:\"; \"}}\nSubject: {{loop.item.subject}}\nCustodian: {{loop.item.custodian}}\nCurrent coding: {{loop.item.coding | json:compact}}\n\nPassage:\n{{loop.item.passage}}",
        output: "json", modelTier: "fast", research: NO_RESEARCH,
        jsonSchema: JSON.stringify({ type: "object", properties: { bates: { type: "string" }, date: { type: "string" }, doc_type: { type: "string" }, author: { type: "string" }, recipients: { type: "string" }, attorney: { type: "string" }, privilege_type: { type: "string", enum: ["Advocate-client (BSA s.132)", "Legal adviser (BSA s.134)", "Advocate-client; Legal adviser", "Common interest", "Not privileged (advocate only copied)"] }, description: { type: "string" }, basis: { type: "string" }, withheld: { type: "string", enum: ["Withheld in full", "Redacted"] } }, required: ["bates", "date", "doc_type", "author", "recipients", "attorney", "privilege_type", "description", "basis", "withheld"] }),
      }),
      N("check", "ai.verify", "Verify entry against document", { output: "{{steps.describe.output}}", sources: "Bates {{loop.item.bates}} · {{loop.item.date}} · {{loop.item.type}}\nFrom: {{loop.item.from}}\nTo: {{loop.item.to | join:\"; \"}}\nSubject: {{loop.item.subject}}\nCustodian: {{loop.item.custodian}}\n\n{{loop.item.passage}}", stepId: "describe", mode: "structured", modelTier: "fast" }),
      N("dedupe", "data.dedupe", "Drop repeated entries", { items: "{{steps.entries.output.results | pluck:steps.describe}}", collection: "self", keyFields: "bates", matterId: "{{inputs.matter}}" }),
      N("review", "logic.review", "Trust review", { steps: "describe, check", approverId: "{{user.id}}", title: "Privilege log entries need a look", message: "Some AI-drafted privilege log entries for {{inputs.custodian | default:\"all custodians\"}} did not verify against the documents. Approve to save the log for paralegal QC, or reject to stop." }),
      N("log", "output.file", "Save privilege log", OUT("xlsx", { rows: "{{steps.dedupe.output.items}}", tags: ["privilege-log"] })),
      N("qc", "action.create_task", "Paralegal QC", { title: "QC privilege log ({{steps.dedupe.output.kept}} entries) — {{inputs.custodian | default:\"all custodians\"}}", description: "Check every description is privilege-safe and consistent with the privilege log format required by the case management order; confirm attorney names and dates. Entries dropped as duplicates: {{steps.dedupe.output.dropped}}.\n\n{{steps.log.output.href}}", assigneeId: "{{user.id}}", priority: "high", dueRule: "+2bd", matterId: "{{inputs.matter}}", tags: ["privilege"] }),
    ],
    edges: [E("start", "search"), E("search", "entries"), E("entries", "describe", "each"), E("describe", "check"), E("check", "entries", undefined, "loop-back"), E("entries", "dedupe", "done"), E("dedupe", "review"), E("review", "log", "approved"), E("log", "qc")],
  },

  // 6 ───────────────────────── Chronology from documents ─────────────────────────
  {
    id: WORKFLOW_TEMPLATE_IDS.chronology,
    name: "Chronology from documents",
    description: "Search the review set on a topic, extract dated events with exhibit marks or document references, and draft a chronology memo with gaps and open questions.",
    category: "discovery",
    tags: ["chronology", "timeline", "e-discovery"],
    inputs: [
      { key: "matter", label: "Matter", type: "matter", required: true },
      { key: "topic", label: "Topic", type: "text", required: true, placeholder: "Event, decision or issue" },
      { key: "date_after", label: "Documents after", type: "date" },
      { key: "date_before", label: "Documents before", type: "date" },
    ],
    nodes: [
      N("start", "trigger.manual", "Run on topic"),
      N("search", "data.search_ediscovery", "Find documents", { query: "{{inputs.topic}}", matterId: "{{inputs.matter}}", dateAfter: "{{inputs.date_after}}", dateBefore: "{{inputs.date_before}}", limit: 25 }),
      N("events", "ai.prompt", "Extract dated events", {
        instructions: "You build litigation chronologies. From the document excerpts, list every dated event (meetings, decisions, reports, communications). One event per row; date in YYYY-MM-DD (use YYYY-MM or YYYY when that is all the source gives); cite the exhibit mark (Ex.P7) or the document reference; significance 1–5 (5 = case-dispositive). Never infer a date that is not in the text. Return JSON only.",
        prompt: "Topic: {{inputs.topic}}\nMatter: {{matter.name}}\n\nDocuments:\n{{steps.search.output.text}}",
        output: "json", modelTier: "primary", research: NO_RESEARCH,
        jsonSchema: JSON.stringify({ type: "object", properties: { events: { type: "array", items: { type: "object", properties: { date: { type: "string" }, event: { type: "string" }, actors: { type: "string" }, source: { type: "string" }, significance: { type: "integer" }, category: { type: "string", enum: ["corporate", "scientific", "regulatory", "communication", "litigation", "product", "other"] } }, required: ["date", "event", "actors", "source", "significance", "category"] } }, gaps: { type: "array", items: { type: "string" } } }, required: ["events", "gaps"] }),
      }),
      N("verify", "ai.verify", "Verify events against documents", { output: "{{steps.events.output.events}}", sources: "{{steps.search.output.results}}", stepId: "events", mode: "structured", modelTier: "fast" }),
      N("dedupe", "data.dedupe", "Drop events already on the timeline", { items: "{{steps.verify.output.corrected}}", collection: "timeline", keyFields: "date,event", matterId: "{{inputs.matter}}" }),
      N("memo", "ai.draft", "Draft chronology memo", {
        kind: "chronology", tone: "neutral", audience: "team", modelTier: "primary", research: NO_RESEARCH,
        brief: "Prepare the chronology memo for \"{{inputs.topic}}\" in {{matter.name}}. Sort by date. After the table add: Key inflection points (3–5 bullets), Gaps in the record, Documents to collect next. Keep any [VERIFY] marks.\n\nEvents (verified: {{steps.verify.output.status}}; {{steps.dedupe.output.dropped}} already on the timeline):\n{{steps.dedupe.output.items | table:date,event,actors,source,significance}}\n\nGaps noted during extraction:\n{{steps.events.output.gaps | bullets}}",
      }),
      N("review", "logic.review", "Trust review", { steps: "events, verify, memo", approverId: "{{user.id}}", title: "Chronology needs a look", message: "Some extracted events for \"{{inputs.topic}}\" did not verify against the documents. Approve to save the memo and open the merge task, or reject to stop." }),
      N("save", "output.file", "Save chronology", OUT("docx", { content: "{{steps.memo.output.text}}", tags: ["chronology"] })),
      N("task", "action.create_task", "Verify and merge into timeline", { title: "Chronology: verify {{steps.dedupe.output.kept}} events for \"{{inputs.topic}}\" and merge into the matter timeline", description: "Verification: {{steps.verify.output.status}} ({{steps.verify.output.unsupported}} unsupported). Unresolved cites: {{steps.verify.output.unresolvedCites | join:\", \" | default:\"none\"}}\n\nGaps flagged:\n{{steps.events.output.gaps | bullets}}\n\n{{steps.save.output.href}}", assigneeId: "{{user.id}}", priority: "medium", dueRule: "+5bd", matterId: "{{inputs.matter}}", tags: ["chronology"] }),
    ],
    edges: [E("start", "search"), E("search", "events"), E("events", "verify"), E("verify", "dedupe"), E("dedupe", "memo"), E("memo", "review"), E("review", "save", "approved"), E("save", "task")],
  },

  // 7 ───────────────────────── Research memo ─────────────────────────
  {
    id: WORKFLOW_TEMPLATE_IDS.researchMemo,
    name: "Research memo with partner approval",
    description: "Run agentic legal research on a question, save the memo, pause for partner approval, then open the follow-up task (or a revision task with the partner's comments).",
    category: "research",
    tags: ["research", "memo", "approval", "case law"],
    inputs: [
      { key: "question", label: "Research question", type: "textarea", required: true, placeholder: "Does a written acknowledgement by a company's CFO by e-mail extend limitation under s.18 of the Limitation Act, 1963?" },
      { key: "jurisdiction", label: "Jurisdiction", type: "select", options: ["Any", "matter-forum", "all-india", "sci", "hc-karnataka", "hc-telangana", "hc-andhra"] },
      { key: "matter", label: "Matter", type: "matter", required: true },
    ],
    nodes: [
      N("start", "trigger.manual", "Run with question"),
      N("research", "ai.research", "Research the question", { question: "{{inputs.question}}\n\nContext: {{matter.name}} — {{matter.description | truncate:600}}", jurisdiction: "{{inputs.jurisdiction | replace:Any,}}", depth: "deep", sources: { web: true, legal: true, internal: true }, instructions: "Verify every citation you rely on by reading the opinion. Distinguish binding from persuasive authority for this forum." }),
      N("cites", "data.legal_search", "Resolve every citation", { source: "verify_citations", text: "{{steps.research.output.text}}" }),
      N("verify", "ai.verify", "Verify memo against authorities", { output: "{{steps.research.output.text}}", sources: "Citation check:\n{{steps.cites.output.text}}\n\nAuthorities the agent read:\n{{steps.research.output.citations | json}}", stepId: "research", mode: "claims", maxClaims: 30, modelTier: "fast" }),
      N("review", "logic.review", "Trust review", { steps: "research, verify", approverId: "{{user.id}}", title: "Research memo needs a look before saving", message: "The memo has unresolved citations or claims the sources do not support ({{steps.cites.output.unresolvedCount}} unresolved cite(s)). Approve to save it for partner review anyway, or reject to stop." }),
      N("save", "output.file", "Save memo", OUT("docx", { content: "{{steps.verify.output.corrected}}", tags: ["research", "memo"] })),
      N("approval", "logic.approval", "Partner review", { approverId: "{{user.id}}", title: "Approve research memo", message: "A research memo is ready for {{matter.shortName}}.\n\n**Question:** {{inputs.question}}\n\n**Verification:** {{steps.verify.output.status}} — {{steps.verify.output.supported}} supported, {{steps.verify.output.unsupported}} unsupported, {{steps.verify.output.contradicted}} contradicted; {{steps.cites.output.unresolvedCount}} unresolved citation(s).\n\n**Bottom line (excerpt):**\n{{steps.research.output.text | truncate:1800}}\n\nFull memo: {{steps.save.output.href}}\n\nApprove to circulate, or reject with comments to send it back for revision.", timeoutHours: 48 }),
      N("task_circulate", "action.create_task", "Circulate memo", { title: "Circulate approved research memo: {{inputs.question | truncate:70}}", description: "Approved by {{steps.approval.output.decidedByName}}{{steps.approval.output.comment | default:\"\"}}.\n{{steps.save.output.href}}", assigneeId: "{{user.id}}", priority: "medium", dueRule: "+2bd", matterId: "{{inputs.matter}}", tags: ["research"] }),
      N("task_revise", "action.create_task", "Revise memo", { title: "Revise research memo per partner comments: {{inputs.question | truncate:60}}", description: "Comments from {{steps.approval.output.decidedByName}}:\n{{steps.approval.output.comment}}\n\n{{steps.save.output.href}}", assigneeId: "{{user.id}}", priority: "high", dueRule: "+2bd", matterId: "{{inputs.matter}}", tags: ["research", "revision"] }),
    ],
    edges: [E("start", "research"), E("research", "cites"), E("cites", "verify"), E("verify", "review"), E("review", "save", "approved"), E("save", "approval"), E("approval", "task_circulate", "approved"), E("approval", "task_revise", "rejected")],
  },

  // 8 ───────────────────────── Client status report ─────────────────────────
  {
    id: WORKFLOW_TEMPLATE_IDS.clientStatus,
    name: "Client status report",
    description: "Assemble the matter's open tasks, upcoming deadlines, recent team updates and key dates into a client-ready status report, route it for approval and queue the send.",
    category: "operations",
    tags: ["client", "reporting", "status", "approval"],
    inputs: [
      { key: "matter", label: "Matter", type: "matter", required: true },
      { key: "period", label: "Reporting period", type: "select", required: true, options: ["Weekly", "Biweekly", "Monthly"] },
      { key: "highlights", label: "Highlights to include", type: "textarea", placeholder: "Production on track; key deposition completed; expert reports due next month" },
    ],
    nodes: [
      N("start", "trigger.manual", "Run for matter"),
      N("draft", "ai.draft", "Draft status report", {
        kind: "report", tone: "plain", audience: "client", modelTier: "primary", research: INTERNAL_ONLY,
        brief: "Draft the {{inputs.period | lower}} status report for {{matter.client}} on {{matter.name}} ({{matter.caption | default:matter.shortName}}). Stage: {{matter.stage}}.\n\nHighlights from the team: {{inputs.highlights | default:\"none provided\"}}\n\nKey dates:\n{{matter.keyDates | table:label,date}}\n\nUpcoming events:\n{{matter.upcomingEvents | table:startsAt,title,kind,ruleSource}}\n\nOpen tasks (internal — summarize, do not list verbatim):\n{{matter.openTasks | table:title,status,priority,dueAt}}\n\nRecent internal updates:\n{{matter.recentUpdates | table:createdAt,author,body}}\n\nWrite for a general counsel: no internal task names, no privileged strategy detail, clear 'Decisions needed from you' section, and a 30-day look-ahead.",
      }),
      N("save", "output.file", "Save report", OUT("docx", { content: "{{steps.draft.output.text}}", tags: ["client-report"] })),
      N("approval", "logic.approval", "Lead attorney approval", { approverId: "{{user.id}}", title: "Approve client status report", message: "{{inputs.period}} status report for {{matter.client}} ({{matter.shortName}}) is ready.\n\n{{steps.draft.output.text | truncate:2000}}\n\nFull report: {{steps.save.output.href}}", timeoutHours: 24 }),
      N("send", "action.create_task", "Send to client", { title: "Send {{inputs.period | lower}} status report to {{matter.client}}", description: "Approved by {{steps.approval.output.decidedByName}}. {{steps.save.output.href}}", assigneeId: "{{user.id}}", priority: "medium", dueRule: "+1bd", matterId: "{{inputs.matter}}", tags: ["client"] }),
      N("post", "action.notify", "Post to team", { recipientIds: ["{{user.id}}"], kind: "update", message: "{{inputs.period}} client status report for {{matter.shortName}} approved and queued for sending. {{steps.save.output.href}}", matterId: "{{inputs.matter}}" }),
      N("revise", "action.create_task", "Revise report", { title: "Revise {{inputs.period | lower}} status report for {{matter.client}}", description: "Comments: {{steps.approval.output.comment}}\n{{steps.save.output.href}}", assigneeId: "{{user.id}}", priority: "high", dueRule: "+1bd", matterId: "{{inputs.matter}}", tags: ["client"] }),
    ],
    edges: [E("start", "draft"), E("draft", "save"), E("save", "approval"), E("approval", "send", "approved"), E("approval", "post", "approved"), E("approval", "revise", "rejected")],
  },

  // 9 ───────────────────────── New matter intake ─────────────────────────
  {
    id: WORKFLOW_TEMPLATE_IDS.matterIntake,
    name: "New matter intake",
    description: "Run a conflicts search across the firm library and knowledge base, classify the result, and either open the file (engagement letter, intake meeting, opening tasks) or escalate a potential conflict.",
    category: "intake",
    tags: ["intake", "conflicts", "engagement", "onboarding"],
    inputs: [
      { key: "client_name", label: "Client", type: "text", required: true, placeholder: "Client name" },
      { key: "adverse_parties", label: "Adverse / related parties", type: "textarea", required: true, placeholder: "Adverse party; related entities; co-defendants" },
      { key: "matter_name", label: "Matter name", type: "text", required: true },
      { key: "practice_area", label: "Practice area", type: "select", required: true, options: ["Litigation", "Products Liability", "Commercial", "Corporate / M&A", "Employment", "Regulatory", "IP", "Real Estate"] },
      { key: "summary", label: "Matter summary", type: "textarea", required: true },
    ],
    nodes: [
      N("start", "trigger.manual", "Run intake"),
      N("conflicts", "data.search_library", "Conflicts search", { query: "{{inputs.client_name}} {{inputs.adverse_parties}}", limit: 15, includeContent: false }),
      N("assess", "ai.classify", "Assess conflicts", {
        source: "Prospective client: {{inputs.client_name}}\nAdverse / related parties: {{inputs.adverse_parties}}\nMatter: {{inputs.matter_name}} ({{inputs.practice_area}})\nSummary: {{inputs.summary}}\n\nFirm records matching those names ({{steps.conflicts.output.count}} hits):\n{{steps.conflicts.output.text | truncate:12000}}",
        modelTier: "primary",
        labels: [
          { label: "clear", description: "No firm record involves the client or adverse parties in a related capacity" },
          { label: "potential", description: "A record mentions one of the parties (e.g., as a counterparty, witness or former client) and needs partner review under the Bar Council of India Rules (conflict of interest; Part VI, Chapter II) [VERIFY]" },
          { label: "conflict", description: "The firm currently represents an adverse party or holds confidential information from a former client on a substantially related matter" },
        ],
        instructions: "Apply ABA Model Rules 1.7, 1.9 and 1.10. Treat any hit that is not clearly the same entity as 'potential', not 'clear'.",
      }),
      N("route", "logic.branch", "Conflict?", { rules: [{ id: "escalate", label: "Potential or actual conflict", logic: "any", conditions: [{ left: "{{steps.assess.output.label}}", op: "equals", right: "conflict" }, { left: "{{steps.assess.output.label}}", op: "equals", right: "potential" }] }], elseLabel: "Clear" }),
      N("escalate", "action.create_task", "Escalate to GC", { title: "Conflicts: {{steps.assess.output.label | upper}} for {{inputs.client_name}} — {{inputs.matter_name}}", description: "{{steps.assess.output.rationale}}\n\nMatching records:\n{{steps.conflicts.output.results | pluck:name | bullets}}", assigneeId: "{{user.id}}", priority: "urgent", dueRule: "+1bd", tags: ["conflicts", "intake"] }),
      N("engagement", "action.create_task", "Engagement letter", { title: "Engagement letter: {{inputs.client_name}} — {{inputs.matter_name}}", description: "Conflicts clear ({{steps.assess.output.confidence}}). Use the {{inputs.practice_area}} engagement template; confirm billing arrangement and scope: {{inputs.summary | truncate:400}}", assigneeId: "{{user.id}}", priority: "high", dueRule: "+2bd", tags: ["intake", "engagement"] }),
      N("open_file", "action.create_task", "Open matter file", { title: "Open file and folders: {{inputs.matter_name}}", description: "Create the matter in the system, library folder structure, and billing number. Practice area: {{inputs.practice_area}}.", assigneeId: "{{user.id}}", priority: "medium", dueRule: "+2bd", tags: ["intake"] }),
      N("kickoff", "action.create_event", "Intake meeting", { title: "Intake meeting — {{inputs.client_name}} ({{inputs.matter_name}})", kind: "meeting", startsAt: "+3bd 10:00", durationMinutes: 60, location: "Conference Room 2A / Teams", notes: "{{inputs.summary}}", attendeeIds: ["{{user.id}}"] }),
      N("notify", "action.notify", "Announce new matter", { recipientIds: ["{{user.id}}"], kind: "announcement", message: "New matter cleared conflicts: **{{inputs.matter_name}}** for {{inputs.client_name}} ({{inputs.practice_area}}). Intake meeting {{steps.kickoff.output.startsAt | date:datetime}}." }),
    ],
    edges: [E("start", "conflicts"), E("conflicts", "assess"), E("assess", "route"), E("route", "escalate", "escalate"), E("route", "engagement", "else"), E("route", "open_file", "else"), E("route", "kickoff", "else"), E("engagement", "notify"), E("open_file", "notify"), E("kickoff", "notify")],
  },

  // 10 ───────────────────────── Cite-check a brief ─────────────────────────
  {
    id: WORKFLOW_TEMPLATE_IDS.citeCheck,
    name: "Cite-check a brief",
    description: "Resolve every citation in a brief against CourtListener, write a cite-check report with the unresolved and suspicious cites, and open a fix-it task when anything fails.",
    category: "drafting",
    tags: ["cite-check", "brief", "citations", "quality"],
    inputs: [
      { key: "brief_text", label: "Brief (upload or paste)", type: "file", required: true },
      { key: "brief_name", label: "Brief", type: "text", required: true, placeholder: "MSJ opposition v3" },
      { key: "matter", label: "Matter", type: "matter", required: true },
    ],
    nodes: [
      N("start", "trigger.manual", "Run with brief"),
      N("verify", "data.legal_search", "Verify citations", { source: "verify_citations", text: "{{inputs.brief_text}}" }),
      N("report", "ai.prompt", "Write cite-check report", {
        instructions: "You are a cite-checker. Using the verification results, produce a Markdown report: (1) Summary counts; (2) Table: Citation | Status | Resolved case name | Issue | Suggested fix; (3) Citations that resolved but whose case name does not match how the brief describes the case (possible wrong cite or wrong proposition); (4) Citation form issues you can see in the brief under Indian practice (neutral citation missing where the court issues one, wrong reporter abbreviation such as SCC / AIR / SCR / KarLJ / ALT, missing paragraph pinpoints, missing court for an unreported decision). Do not invent corrections; propose where to look.",
        prompt: "Brief: {{inputs.brief_name}} ({{matter.name}})\n\nVerification results:\n{{steps.verify.output.text}}\n\nRaw results:\n{{steps.verify.output.results | json}}\n\nBrief text:\n{{inputs.brief_text | truncate:80000}}",
        output: "text", modelTier: "primary", research: NO_RESEARCH,
      }),
      N("save", "output.file", "Save report", OUT("docx", { content: "{{steps.report.output.text}}", tags: ["cite-check"] })),
      N("any_bad", "logic.branch", "Unresolved cites?", { rules: [{ id: "bad", label: "Unresolved", logic: "all", conditions: [{ left: "{{steps.verify.output.unresolvedCount}}", op: "gt", right: "0" }] }], elseLabel: "All resolved" }),
      N("fix", "action.create_task", "Fix citations", { title: "Fix {{steps.verify.output.unresolvedCount}} unresolved citation(s) in {{inputs.brief_name}}", description: "{{steps.verify.output.unresolved | pluck:citation | bullets}}\n\nReport: {{steps.save.output.href}}", assigneeId: "{{user.id}}", priority: "urgent", dueRule: "+1bd", matterId: "{{inputs.matter}}", tags: ["cite-check"] }),
      N("clean", "action.notify", "All clear", { recipientIds: ["{{user.id}}"], kind: "update", message: "Cite-check of **{{inputs.brief_name}}**: all {{steps.verify.output.total}} citations resolved. Report: {{steps.save.output.href}}", matterId: "{{inputs.matter}}" }),
    ],
    edges: [E("start", "verify"), E("verify", "report"), E("report", "save"), E("save", "any_bad"), E("any_bad", "fix", "bad"), E("any_bad", "clean", "else")],
  },

  // 11 ───────────────────────── Meet-and-confer letter ─────────────────────────
  {
    id: WORKFLOW_TEMPLATE_IDS.meetConfer,
    name: "Meet-and-confer letter",
    description: "Pull the firm's meet-and-confer precedents and clause bank, draft the letter with the dispute facts and requested relief, file it and calendar the response deadline.",
    category: "drafting",
    tags: ["discovery", "letter", "meet-and-confer", "Rule 37"],
    inputs: [
      { key: "matter", label: "Matter", type: "matter", required: true },
      { key: "opposing_counsel", label: "Addressee", type: "text", required: true, placeholder: "Opposing counsel, firm" },
      { key: "dispute", label: "Dispute summary", type: "textarea", required: true, placeholder: "What the other side demanded, what the order provides and where the parties disagree" },
      { key: "relief", label: "What we are asking for", type: "textarea", required: true },
      { key: "response_deadline", label: "Response deadline", type: "date", required: true },
    ],
    nodes: [
      N("start", "trigger.manual", "Run with dispute"),
      N("precedents", "data.search_library", "Find precedents", { query: "meet and confer letter discovery deficiency {{inputs.dispute | truncate:120}}", limit: 6, includeContent: true }),
      N("draft", "ai.draft", "Draft letter", {
        kind: "letter", tone: "persuasive", audience: "opposing", modelTier: "primary", research: INTERNAL_ONLY,
        brief: "Draft a meet-and-confer letter in {{matter.name}} ({{matter.caption}}) to {{inputs.opposing_counsel}} from {{user.name}}.\n\nDispute: {{inputs.dispute}}\n\nRequested relief: {{inputs.relief}}\n\nRequest a written response by {{inputs.response_deadline | date:long}} and reserve the right to seek relief under FRCP 37(a)(1) and the court's local rules on conferral. Keep the tone firm and courteous; recite the prior conferrals with dates; cite the case management orders by number.",
        context: "Firm precedents and clauses:\n{{steps.precedents.output.text | truncate:20000}}",
      }),
      N("save", "output.file", "Save letter", OUT("docx", { content: "{{steps.draft.output.text}}", tags: ["meet-and-confer", "letter"] })),
      N("deadline", "action.create_event", "Calendar response deadline", { title: "Meet-and-confer response due — {{inputs.opposing_counsel | truncate:40}}", kind: "deadline", startsAt: "{{inputs.response_deadline}} 17:00", durationMinutes: 0, notes: "{{inputs.dispute | truncate:500}}", ruleSource: "FRCP 37(a)(1); Local Civ. Rule 7.02", attendeeIds: ["{{user.id}}"], matterId: "{{inputs.matter}}" }),
      N("send", "action.create_task", "Finalize and send", { title: "Finalize and send meet-and-confer letter to {{inputs.opposing_counsel | truncate:40}}", description: "Response requested by {{inputs.response_deadline | date:long}}.\n{{steps.save.output.href}}", assigneeId: "{{user.id}}", priority: "high", dueRule: "+1bd", matterId: "{{inputs.matter}}", tags: ["meet-and-confer"] }),
    ],
    edges: [E("start", "precedents"), E("precedents", "draft"), E("draft", "save"), E("save", "deadline"), E("save", "send")],
  },

  // 12 ───────────────────────── PAGA notice response checklist ─────────────────────────
  {
    id: WORKFLOW_TEMPLATE_IDS.pagaChecklist,
    name: "PAGA notice response checklist",
    description: "Parse an LWDA / PAGA notice, break the allegations into cure-eligible work items with deadlines, open the tasks, calendar the cure window and draft the response checklist.",
    category: "compliance",
    tags: ["PAGA", "employment", "California", "cure", "checklist"],
    inputs: [
      { key: "notice_text", label: "PAGA notice (upload or paste)", type: "file", required: true },
      { key: "matter", label: "Matter", type: "matter", required: true },
      { key: "employer", label: "Employer", type: "text", required: true, placeholder: "Employer name" },
    ],
    nodes: [
      N("start", "trigger.manual", "Run with notice"),
      N("extract", "ai.extract", "Parse the notice", {
        source: "{{inputs.notice_text}}", modelTier: "primary",
        instructions: "This is a PAGA notice under Cal. Lab. Code § 2699.3. Capture every Labor Code section alleged and the factual theory for each.",
        fields: [
          { name: "notice_date", type: "date", description: "Date the notice was submitted to the LWDA / served" },
          { name: "lwda_case_number", type: "string", description: "LWDA case number if stated" },
          { name: "claimant", type: "string", description: "Named aggrieved employee(s) and counsel" },
          { name: "employer_named", type: "string", description: "Employer entity as named" },
          { name: "alleged_violations", type: "string[]", description: "Each alleged Labor Code / Wage Order violation with section number and one-line theory" },
          { name: "period", type: "string", description: "Time period covered" },
          { name: "employee_group", type: "string", description: "Description of the aggrieved employees / positions / locations" },
          { name: "cure_eligible_sections", type: "string[]", description: "Sections that appear curable under § 2699.3(c) or the 2024 amendments (e.g., wage statement, meal/rest premium payment)" },
        ],
      }),
      N("plan", "ai.prompt", "Build work items", {
        instructions: "You are a California wage-and-hour defense specialist. Convert the alleged violations into a response plan under the post-AB 2288 / SB 92 framework. For each allegation give: the section; the defense/cure action; whether it is curable and the statutory window; a due rule relative to today like '+10bd' (cure decision before the 33-day LWDA window closes; early evaluation conference request within the timeline; payroll data pull first); the owner role (partner / associate / paralegal / client HR). Return JSON only.",
        prompt: "Employer: {{inputs.employer}} · Matter: {{matter.name}}\nNotice date: {{steps.extract.output.notice_date}} · LWDA no. {{steps.extract.output.lwda_case_number}}\n\nParsed notice:\n{{steps.extract.output | json}}",
        output: "json", modelTier: "primary", research: NO_RESEARCH,
        jsonSchema: JSON.stringify({ type: "object", properties: { items: { type: "array", items: { type: "object", properties: { section: { type: "string" }, allegation: { type: "string" }, action: { type: "string" }, curable: { type: "boolean" }, cure_window: { type: "string" }, due_rule: { type: "string" }, owner_role: { type: "string", enum: ["partner", "associate", "paralegal", "client HR"] }, priority: { type: "string", enum: ["low", "medium", "high", "urgent"] } }, required: ["section", "allegation", "action", "curable", "cure_window", "due_rule", "owner_role", "priority"] } }, strategy_note: { type: "string" } }, required: ["items", "strategy_note"] }),
      }),
      N("each", "logic.loop", "For each allegation", { over: "{{steps.plan.output.items}}", maxIterations: 25, itemLabel: "allegation" }),
      N("task", "action.create_task", "Open work item", { title: "PAGA {{loop.item.section}}: {{loop.item.action | truncate:90}}", description: "Allegation: {{loop.item.allegation}}\nCurable: {{loop.item.curable}} ({{loop.item.cure_window}})\nOwner: {{loop.item.owner_role}}", assigneeId: "{{user.id}}", priority: "{{loop.item.priority}}", dueRule: "{{loop.item.due_rule}}", matterId: "{{inputs.matter}}", tags: ["PAGA", "cure"] }),
      N("cure_deadline", "action.create_event", "Calendar LWDA window", { title: "PAGA: LWDA 33-day cure / response window closes — {{inputs.employer}}", kind: "deadline", startsAt: "{{steps.extract.output.notice_date | add_days:33}} 17:00", durationMinutes: 0, ruleSource: "Cal. Lab. Code § 2699.3(c)", notes: "Notice date {{steps.extract.output.notice_date}}; LWDA no. {{steps.extract.output.lwda_case_number}}", attendeeIds: ["{{user.id}}"], matterId: "{{inputs.matter}}" }),
      N("checklist", "ai.draft", "Draft response checklist", {
        kind: "checklist", tone: "plain", audience: "team", modelTier: "fast", research: NO_RESEARCH,
        brief: "Write the PAGA notice response checklist for {{inputs.employer}} ({{matter.name}}). Group by phase: (1) Immediate (litigation hold, payroll and timekeeping data pull, insurance notice); (2) Evaluation (exposure model, cure eligibility per section, early evaluation conference decision); (3) Cure and response (cure notice content, LWDA submission, employee communications); (4) Calendar. Include the strategy note.\n\nWork items:\n{{steps.plan.output.items | table:section,action,curable,cure_window,due_rule,owner_role}}\n\nStrategy note: {{steps.plan.output.strategy_note}}",
      }),
      N("save", "output.file", "Save checklist", OUT("docx", { content: "{{steps.checklist.output.text}}", tags: ["PAGA", "checklist"] })),
      N("notify", "action.notify", "Notify team", { recipientIds: ["{{user.id}}"], kind: "update", message: "PAGA notice parsed for **{{inputs.employer}}**: {{steps.plan.output.items | length}} work items opened; LWDA window calendared for {{steps.cure_deadline.output.startsAt | date:long}}.\n\nChecklist: {{steps.save.output.href}}", matterId: "{{inputs.matter}}" }),
    ],
    edges: [E("start", "extract"), E("extract", "plan"), E("plan", "each"), E("each", "task", "each"), E("task", "each", undefined, "loop-back"), E("each", "cure_deadline", "done"), E("each", "checklist", "done"), E("checklist", "save"), E("cure_deadline", "notify"), E("save", "notify")],
  },

  // 13 ───────────────────────── Regulatory watch ─────────────────────────
  {
    id: WORKFLOW_TEMPLATE_IDS.regulatoryWatch,
    name: "Regulatory watch (Federal Register)",
    description: "Every Monday, search the Federal Register for the past week on a topic and agency, summarize what changed and why it matters for the matter, and post a team update.",
    category: "compliance",
    tags: ["regulatory", "Federal Register", "scheduled"],
    inputs: [
      { key: "topic", label: "Topic", type: "text", required: true, placeholder: "Substance, product or rule topic" },
      { key: "agency", label: "Agency slug", type: "text", placeholder: "environmental-protection-agency" },
      { key: "matter", label: "Matter", type: "matter", required: true },
    ],
    nodes: [
      N("schedule", "trigger.schedule", "Weekly, Monday 06:30", { schedule: { frequency: "weekly", time: "06:30", weekday: 1 }, enabled: true, presetInputs: {} }),
      N("fr", "data.legal_search", "Federal Register, last 7 days", { source: "federal_register", query: "{{inputs.topic}}", agency: "{{inputs.agency}}", after: "-7d", limit: 20 }),
      N("any", "logic.branch", "Anything published?", { rules: [{ id: "yes", label: "New documents", logic: "all", conditions: [{ left: "{{steps.fr.output.results | length}}", op: "gt", right: "0" }] }], elseLabel: "Quiet week" }),
      N("summary", "ai.summarize", "Summarize for the matter", { source: "Matter: {{matter.name}} — {{matter.description}}\n\nFederal Register documents this week:\n{{steps.fr.output.text}}", style: "executive", length: "medium", focus: "what changed, comment deadlines, effective dates, and consequences for {{matter.client}}", modelTier: "primary" }),
      N("post", "action.notify", "Post regulatory update", { recipientIds: ["{{user.id}}"], kind: "announcement", message: "**Regulatory watch — {{inputs.topic}} ({{now | date:short}})**\n\n{{steps.summary.output.text | truncate:2500}}", matterId: "{{inputs.matter}}" }),
      N("file", "output.file", "File the digest", OUT("md", { content: "# Regulatory watch — {{inputs.topic}} — {{now | date:long}}\n\n{{steps.summary.output.text}}\n\n## Documents\n\n{{steps.fr.output.text}}", tags: ["regulatory", "watch"] })),
      N("quiet", "action.notify", "Quiet week", { recipientIds: ["{{user.id}}"], kind: "update", message: "Regulatory watch — {{inputs.topic}}: no Federal Register documents in the last 7 days.", matterId: "{{inputs.matter}}" }),
    ],
    edges: [E("schedule", "fr"), E("fr", "any"), E("any", "summary", "yes"), E("summary", "post"), E("summary", "file"), E("any", "quiet", "else")],
  },

  // 14 ───────────────────────── Deposition designations ─────────────────────────
  {
    id: WORKFLOW_TEMPLATE_IDS.depoDesignations,
    name: "Deposition designations",
    description: "From a transcript, propose page:line designations for trial or a motion — affirmative, impeachment and completeness — with the objection risk for each, verify every cite against the transcript and save the designation table for the team to finalize.",
    category: "discovery",
    tags: ["deposition", "designations", "trial", "FRCP 32"],
    inputs: [
      { key: "transcript_text", label: "Transcript (upload or paste)", type: "file", required: true },
      { key: "witness", label: "Witness", type: "text", required: true, placeholder: "Witness name, title" },
      { key: "matter", label: "Matter", type: "matter", required: true },
      { key: "side", label: "Designating for", type: "select", required: true, options: ["Plaintiff", "Defendant"] },
      { key: "themes", label: "Themes to cover", type: "textarea", placeholder: "Knowledge of key documents; decisions made; communications with others" },
    ],
    nodes: [
      N("start", "trigger.manual", "Run with transcript"),
      N("rows", "ai.prompt", "Propose designations", {
        instructions: "You prepare deposition designations for trial and motion practice. From the transcript, propose designations as page:line ranges (page and line numbers exactly as they appear in the transcript; never invent them). Each designation covers one complete question-and-answer exchange or a tight run of them; add the questions needed for the answers to make sense (FRE 106 completeness). Classify the purpose (affirmative, impeachment, completeness), summarize the testimony in one sentence, tie it to a theme, and rate the objection risk (low / medium / high) with the likely basis (hearsay, foundation, speculation, form, relevance, privilege, FRCP 32(a)(1) use limits). Note where the other side will likely counter-designate. Return JSON only.",
        prompt: "Witness: {{inputs.witness}} · Designating for the {{inputs.side}} in {{matter.name}}\nThemes: {{inputs.themes | default:\"the witness's knowledge, decisions and communications relevant to liability\"}}\n\nTranscript:\n{{inputs.transcript_text | truncate:90000}}",
        output: "json", modelTier: "primary", research: NO_RESEARCH,
        jsonSchema: JSON.stringify({ type: "object", properties: { designations: { type: "array", items: { type: "object", properties: { page_from: { type: "integer" }, line_from: { type: "integer" }, page_to: { type: "integer" }, line_to: { type: "integer" }, cite: { type: "string" }, summary: { type: "string" }, theme: { type: "string" }, purpose: { type: "string", enum: ["affirmative", "impeachment", "completeness"] }, objection_risk: { type: "string", enum: ["low", "medium", "high"] }, objection_basis: { type: "string" }, counter_designation_risk: { type: "string" } }, required: ["page_from", "line_from", "page_to", "line_to", "cite", "summary", "theme", "purpose", "objection_risk", "objection_basis", "counter_designation_risk"] } }, coverage_gaps: { type: "array", items: { type: "string" } } }, required: ["designations", "coverage_gaps"] }),
      }),
      N("verify", "ai.verify", "Verify cites against the transcript", { output: "{{steps.rows.output.designations}}", sources: "{{inputs.transcript_text | truncate:90000}}", stepId: "rows", mode: "structured", modelTier: "fast" }),
      N("review", "logic.review", "Trust review", { steps: "rows, verify", approverId: "{{user.id}}", title: "Designations need a look", message: "Some proposed designations for {{inputs.witness}} did not verify against the transcript. Approve to save the table anyway, or reject to stop." }),
      N("sheet", "output.file", "Save designation table", OUT("xlsx", { rows: "{{steps.verify.output.corrected}}", tags: ["deposition", "designations"] })),
      N("task", "action.create_task", "Finalize designations", { title: "Finalize {{inputs.witness}} designations ({{steps.rows.output.designations | length}} proposed, {{steps.rows.output.designations | where:objection_risk,high | length}} high objection risk)", description: "Check every page:line against the certified transcript, decide the counter-designation strategy and prepare the exchange under the pretrial order.\n\nCoverage gaps noted:\n{{steps.rows.output.coverage_gaps | bullets}}\n\nTable: {{steps.sheet.output.href}}", assigneeId: "{{user.id}}", priority: "high", dueRule: "+3bd", matterId: "{{inputs.matter}}", tags: ["deposition", "designations"] }),
      N("notify", "action.notify", "Notify case team", { recipientIds: ["{{user.id}}"], kind: "update", message: "Proposed designations for **{{inputs.witness}}** ({{inputs.side}}) are ready on {{matter.shortName}}: {{steps.rows.output.designations | length}} ranges, verification {{steps.verify.output.status}}. {{steps.sheet.output.href}}", matterId: "{{inputs.matter}}" }),
    ],
    edges: [E("start", "rows"), E("rows", "verify"), E("verify", "review"), E("review", "sheet", "approved"), E("sheet", "task"), E("sheet", "notify")],
  },

  // 15 ───────────────────────── Production QC ─────────────────────────
  {
    id: WORKFLOW_TEMPLATE_IDS.productionQc,
    name: "Production QC",
    description: "Before a production goes out: pull the documents under a Bates prefix, check for Bates gaps, privilege inconsistencies, hot documents coded non-responsive, custodian coverage and date-range problems, verify the findings and save a QC report with a fix-it task.",
    category: "discovery",
    tags: ["production", "QC", "Bates", "privilege", "e-discovery"],
    inputs: [
      { key: "matter", label: "Matter", type: "matter", required: true },
      { key: "bates_prefix", label: "Bates prefix", type: "text", required: true, placeholder: "ABC-" },
      { key: "volume", label: "Production volume", type: "text", required: true, placeholder: "VOL003" },
      { key: "load_file", label: "Load file / index (optional)", type: "file" },
      { key: "checks", label: "Checks", type: "select", options: ["Bates gaps", "Privilege consistency", "Hot documents coded non-responsive", "Custodian coverage", "Date range sanity"] },
    ],
    nodes: [
      N("start", "trigger.manual", "Run before the production"),
      N("docs", "data.query", "Documents under the prefix", { source: "ediscovery", q: "", filters: { batesPrefix: "{{inputs.bates_prefix}}" }, matterId: "{{inputs.matter}}", since: "", limit: 500, sort: "date", direction: "asc" }),
      N("priv", "data.query", "Documents coded privileged", { source: "ediscovery", q: "", filters: { batesPrefix: "{{inputs.bates_prefix}}", privileged: "true" }, matterId: "{{inputs.matter}}", since: "", limit: 200, sort: "date", direction: "asc" }),
      N("qc", "ai.prompt", "Run the QC checks", {
        instructions: "You are a litigation support QC reviewer. Using the document rows (Bates, date, custodian, type, subject, coding), the privileged set and the load file if given, run the requested checks and list every finding: Bates gaps or duplicates in the numbering; documents coded privileged that appear in the production set (or privileged families split); documents coded hot but not responsive; custodians with no documents in the volume although they appear in the matter; dates outside the collection window or missing. Each finding names the Bates number(s), the check, a severity (low / medium / high), the issue and the fix. Do not invent documents. Return JSON only.",
        prompt: "Matter: {{matter.name}} · Prefix {{inputs.bates_prefix}} · Volume {{inputs.volume}}\nChecks requested: {{inputs.checks | default:\"all\"}}\n\nProduction set ({{steps.docs.output.count}} of {{steps.docs.output.total}} documents):\n{{steps.docs.output.rows | table:bates,date,custodian,type,subject,coding}}\n\nCoded privileged ({{steps.priv.output.count}}):\n{{steps.priv.output.rows | table:bates,date,custodian,subject}}\n\nLoad file / index:\n{{inputs.load_file | default:\"(none)\" | truncate:20000}}",
        output: "json", modelTier: "fast", research: NO_RESEARCH,
        jsonSchema: JSON.stringify({ type: "object", properties: { findings: { type: "array", items: { type: "object", properties: { bates: { type: "string" }, check: { type: "string" }, severity: { type: "string", enum: ["low", "medium", "high"] }, issue: { type: "string" }, action: { type: "string" } }, required: ["bates", "check", "severity", "issue", "action"] } }, summary: { type: "string" }, documents_checked: { type: "integer" } }, required: ["findings", "summary", "documents_checked"] }),
      }),
      N("verify", "ai.verify", "Verify findings against the rows", { output: "{{steps.qc.output.findings}}", sources: "{{steps.docs.output.text}}\n\n{{steps.priv.output.text}}", stepId: "qc", mode: "structured", modelTier: "fast" }),
      N("any", "logic.branch", "Any findings?", { rules: [{ id: "issues", label: "Findings", logic: "all", conditions: [{ left: "{{steps.qc.output.findings | length}}", op: "gt", right: "0" }] }], elseLabel: "Clean" }),
      N("report", "output.file", "Save QC report", OUT("xlsx", { rows: "{{steps.verify.output.corrected}}", tags: ["production", "qc"] })),
      N("fix", "action.create_task", "Fix QC findings", { title: "Production {{inputs.volume}}: fix {{steps.qc.output.findings | length}} QC finding(s) before release ({{steps.qc.output.findings | where:severity,high | length}} high)", description: "{{steps.qc.output.summary}}\n\nReport: {{steps.report.output.href}}", assigneeId: "{{user.id}}", priority: "urgent", dueRule: "+1bd", matterId: "{{inputs.matter}}", tags: ["production", "qc"] }),
      N("clean", "action.notify", "Clean", { recipientIds: ["{{user.id}}"], kind: "update", message: "Production **{{inputs.volume}}** ({{inputs.bates_prefix}}) passed QC: {{steps.docs.output.count}} documents checked, no findings.", matterId: "{{inputs.matter}}" }),
    ],
    edges: [E("start", "docs"), E("start", "priv"), E("docs", "qc"), E("priv", "qc"), E("qc", "verify"), E("verify", "any"), E("any", "report", "issues"), E("report", "fix"), E("any", "clean", "else")],
  },

  // 16 ───────────────────────── Judge profile memo ─────────────────────────
  {
    id: WORKFLOW_TEMPLATE_IDS.judgeProfile,
    name: "Judge profile memo",
    description: "Build a partner-ready profile of a judge from the intelligence store (opinions, dockets, the judge record), agentic research on notable rulings and tendencies, verify the claims and save the memo to the matter.",
    category: "research",
    tags: ["judge", "profile", "research", "memo"],
    inputs: [
      { key: "judge", label: "Judge", type: "text", required: true, placeholder: "Judge name" },
      { key: "court", label: "Court", type: "text", placeholder: "Court" },
      { key: "matter", label: "Matter", type: "matter", required: true },
      { key: "focus", label: "Focus", type: "textarea", placeholder: "Daubert practice, summary judgment, discovery disputes" },
    ],
    nodes: [
      N("start", "trigger.manual", "Run with judge"),
      N("entity", "data.query", "Judge record", { source: "intel_entities", q: "{{inputs.judge}}", filters: { type: "judge" }, matterId: "", since: "", limit: 3, sort: "updated", direction: "desc" }),
      N("docs", "data.query", "Opinions and dockets", { source: "intel_documents", q: "{{inputs.judge}}", filters: { kinds: "opinion, docket, docket_entry, judge" }, matterId: "", since: "-730d", limit: 80, sort: "date", direction: "desc" }),
      N("profile", "intel.analyze", "Profile from the store", { analysis: "profiles", scope: { matterId: "", kinds: ["opinion", "docket", "docket_entry", "judge"], entityIds: "{{steps.entity.output.ids}}", court: "", jurisdiction: "", dateFrom: "-730d", dateTo: "", q: "{{inputs.judge}}" }, title: "Judge profile — {{inputs.judge}}", maxDocs: 400, onError: "continue" }),
      N("research", "ai.research", "Research rulings and tendencies", { question: "Profile Judge {{inputs.judge}} ({{inputs.court | default:\"court not specified\"}}): background and appointment, notable rulings on {{inputs.focus | default:\"dispositive motions, Daubert and class certification\"}}, case-management tendencies, treatment of MDL leadership and bellwethers, and reversal history. Cite every ruling.", jurisdiction: "", depth: "standard", sources: { web: true, legal: true, internal: true }, instructions: "Read the opinions you rely on. Separate what the record shows from reputation. Never characterize a ruling you have not read." }),
      N("memo", "ai.draft", "Draft the profile memo", {
        kind: "memo", tone: "neutral", audience: "partner", modelTier: "primary", research: NO_RESEARCH,
        brief: "Draft a judge profile memo on Judge {{inputs.judge}} for {{matter.name}}. Sections: Snapshot (court, appointment, prior practice); How the court runs (scheduling, page limits, oral argument, discovery disputes); Rulings that matter for us ({{inputs.focus | default:\"dispositive motions, Daubert, class certification\"}}) as a table: Ruling | Date | Holding | Why it matters; Tendencies with the evidence for each; Practical guidance for briefing and argument; Open questions. Cite opinions and docket entries; keep any [VERIFY] marks.\n\nProfile from the intelligence store:\n{{steps.profile.output.text | default:\"(no store profile yet)\" | truncate:6000}}\n\nResearch findings:\n{{steps.research.output.text}}",
        context: "Recent opinions and dockets in the store:\n{{steps.docs.output.text | truncate:8000}}",
      }),
      N("verify", "ai.verify", "Verify memo against authorities", { output: "{{steps.memo.output.text}}", sources: "Research citations:\n{{steps.research.output.citations | json}}\n\nStore documents:\n{{steps.docs.output.text | truncate:20000}}", stepId: "memo", mode: "claims", maxClaims: 30, modelTier: "fast" }),
      N("review", "logic.review", "Trust review", { steps: "memo, verify", approverId: "{{user.id}}", title: "Judge profile needs a look", message: "Some claims in the profile of Judge {{inputs.judge}} did not verify against the authorities. Approve to save it anyway, or reject to stop." }),
      N("save", "output.file", "Save memo", OUT("docx", { content: "{{steps.verify.output.corrected}}", tags: ["judge", "profile"] })),
      N("task", "action.create_task", "Read the profile", { title: "Judge profile memo ready — {{inputs.judge}}", description: "Verification: {{steps.verify.output.status}} ({{steps.verify.output.unsupported}} unsupported claim(s)).\n\n{{steps.save.output.href}}", assigneeId: "{{user.id}}", priority: "medium", dueRule: "+2bd", matterId: "{{inputs.matter}}", tags: ["judge", "research"] }),
    ],
    edges: [E("start", "entity"), E("entity", "docs"), E("docs", "profile"), E("profile", "research"), E("research", "memo"), E("memo", "verify"), E("verify", "review"), E("review", "save", "approved"), E("save", "task")],
  },
];

// ─────────────────────────── Front ends ───────────────────────────

const F = {
  matter: (): WorkflowFrontend["fields"][number] => ({ key: "matter", label: "Matter", type: "matter", required: true, help: "Sets the run's matter; documents are filed under it." }),
};

/**
 * The one-page start form each template ships with. Field keys match the
 * template's inputs; the output section (format, label, folder) feeds the
 * template's output.file step. See src/modules/workflows/frontend.ts.
 */
export const TEMPLATE_FRONTENDS: Record<string, WorkflowFrontend> = {
  [WORKFLOW_TEMPLATE_IDS.ndaIntake]: {
    title: "Review an NDA",
    intro: "Upload the agreement and say which side the client is on. The review extracts the terms, scores the risk against firm positions, drafts the issues memo and routes it to the right person.",
    fields: [
      { key: "nda_text", label: "NDA", type: "file", required: true, accept: DOC_ACCEPT, help: "Word, PDF or text; the agreement text is extracted for the review." },
      F.matter(),
      { key: "our_side", label: "Our client is the", type: "select", required: true, options: ["Receiving Party", "Disclosing Party", "Mutual"] },
      { key: "counterparty", label: "Counterparty", type: "text", placeholder: "Counterparty name" },
    ],
    submitLabel: "Review the NDA",
    output: { formats: ["docx", "pdf", "md"], defaultFormat: "docx", defaultLabel: "NDA review — {{inputs.counterparty | default:\"counterparty\"}} — {{now | date:short}}" },
  },
  [WORKFLOW_TEMPLATE_IDS.depoDigest]: {
    title: "Digest a deposition",
    intro: "Upload the rough transcript. The digest pulls admissions, harmful testimony, contradictions and exhibits with page:line cites, verifies them against the transcript and files the memo.",
    fields: [
      { key: "transcript_text", label: "Transcript", type: "file", required: true, accept: TRANSCRIPT_ACCEPT, help: "Rough or certified transcript as text, PDF or Word." },
      { key: "witness", label: "Witness", type: "text", required: true, placeholder: "Witness name, title" },
      F.matter(),
      { key: "focus", label: "Themes to focus on", type: "textarea", placeholder: "Key documents; decisions; communications the witness was part of" },
    ],
    submitLabel: "Build the digest",
    output: { formats: ["docx", "pdf", "md"], defaultFormat: "docx", defaultLabel: "Deposition digest — {{inputs.witness}} — {{now | date:short}}" },
  },
  [WORKFLOW_TEMPLATE_IDS.docketMonitor]: {
    title: "Check the dockets",
    intro: "Runs every morning on its schedule; start it now to sweep the last day of docket activity for a matter.",
    fields: [
      { key: "docket_query", label: "Docket search", type: "text", required: true, placeholder: "Party name or case caption" },
      { key: "courts", label: "Courts", type: "text", placeholder: "dsc", help: "CourtListener court ids, space separated." },
      F.matter(),
    ],
    submitLabel: "Check dockets now",
  },
  [WORKFLOW_TEMPLATE_IDS.clauseWorkbook]: {
    title: "Extract contract clauses",
    intro: "Upload one contract. The commercial and risk terms are extracted into typed fields and turned into a clause-by-clause review table for the diligence tracker.",
    fields: [
      { key: "contract_text", label: "Contract", type: "file", required: true, accept: DOC_ACCEPT },
      { key: "contract_name", label: "Contract name", type: "text", required: true, placeholder: "Master services agreement (2023)" },
      F.matter(),
    ],
    submitLabel: "Extract clauses",
    output: { formats: ["xlsx", "csv"], defaultFormat: "xlsx", defaultLabel: "Clause review — {{inputs.contract_name}}" },
  },
  [WORKFLOW_TEMPLATE_IDS.privilegeLog]: {
    title: "Build a privilege log",
    intro: "Drafts a privilege-safe description and basis for every document coded privileged (optionally one custodian), verifies each entry and saves the log for paralegal QC.",
    fields: [
      F.matter(),
      { key: "custodian", label: "Custodian", type: "text", placeholder: "Custodian surname", help: "Leave empty for all custodians." },
      { key: "limit", label: "Max documents", type: "number", placeholder: "25" },
    ],
    submitLabel: "Build the log",
    output: { formats: ["xlsx", "csv"], defaultFormat: "xlsx", defaultLabel: "Privilege log — {{inputs.custodian | default:\"all custodians\"}} — {{now | date:short}}" },
  },
  [WORKFLOW_TEMPLATE_IDS.chronology]: {
    title: "Build a chronology",
    intro: "Searches the review set on a topic, extracts dated events with exhibit marks or document references, drops what is already on the matter timeline and drafts the chronology memo.",
    fields: [
      F.matter(),
      { key: "topic", label: "Topic", type: "text", required: true, placeholder: "Event, decision or issue" },
      { key: "date_after", label: "Documents after", type: "date" },
      { key: "date_before", label: "Documents before", type: "date" },
    ],
    submitLabel: "Build the chronology",
    output: { formats: ["docx", "pdf", "md"], defaultFormat: "docx", defaultLabel: "Chronology — {{inputs.topic}} — {{now | date:short}}" },
  },
  [WORKFLOW_TEMPLATE_IDS.researchMemo]: {
    title: "Research a question",
    intro: "Agentic research with verified citations, saved as a memo and held for partner approval before it circulates.",
    fields: [
      { key: "question", label: "Research question", type: "textarea", required: true, placeholder: "Does a written acknowledgement by a company's CFO by e-mail extend limitation under s.18 of the Limitation Act, 1963?" },
      { key: "jurisdiction", label: "Jurisdiction", type: "select", options: ["Any", "matter-forum", "all-india", "sci", "hc-karnataka", "hc-telangana", "hc-andhra"], default: "Any" },
      F.matter(),
    ],
    submitLabel: "Start the research",
    output: { formats: ["docx", "pdf", "md"], defaultFormat: "docx", defaultLabel: "Research memo — {{inputs.question | truncate:60}}" },
  },
  [WORKFLOW_TEMPLATE_IDS.clientStatus]: {
    title: "Draft a client status report",
    intro: "Assembles open tasks, deadlines, team updates and key dates into a client-ready report and routes it to the lead attorney.",
    fields: [
      F.matter(),
      { key: "period", label: "Reporting period", type: "select", required: true, options: ["Weekly", "Biweekly", "Monthly"], default: "Weekly" },
      { key: "highlights", label: "Highlights to include", type: "textarea", placeholder: "Production on track; key deposition completed; expert reports due next month" },
    ],
    submitLabel: "Draft the report",
    output: { formats: ["docx", "pdf"], defaultFormat: "docx", defaultLabel: "{{inputs.period}} status report — {{matter.shortName}} — {{now | date:short}}" },
  },
  [WORKFLOW_TEMPLATE_IDS.matterIntake]: {
    title: "Open a new matter",
    intro: "Runs the conflicts search, assesses the result and either opens the file (engagement letter, intake meeting, opening tasks) or escalates a potential conflict.",
    fields: [
      { key: "client_name", label: "Client", type: "text", required: true, placeholder: "Client name" },
      { key: "adverse_parties", label: "Adverse and related parties", type: "textarea", required: true, placeholder: "Adverse party; related entities; co-defendants" },
      { key: "matter_name", label: "Matter name", type: "text", required: true },
      { key: "practice_area", label: "Practice area", type: "select", required: true, options: ["Litigation", "Products Liability", "Commercial", "Corporate / M&A", "Employment", "Regulatory", "IP", "Real Estate"] },
      { key: "summary", label: "Matter summary", type: "textarea", required: true },
    ],
    submitLabel: "Run intake",
  },
  [WORKFLOW_TEMPLATE_IDS.citeCheck]: {
    title: "Cite-check a brief",
    intro: "Every citation is resolved against CourtListener; the report lists unresolved and suspicious cites and opens a fix-it task when anything fails.",
    fields: [
      { key: "brief_text", label: "Brief", type: "file", required: true, accept: DOC_ACCEPT },
      { key: "brief_name", label: "Brief", type: "text", required: true, placeholder: "MSJ opposition v3" },
      F.matter(),
    ],
    submitLabel: "Check the citations",
    output: { formats: ["docx", "pdf", "md"], defaultFormat: "docx", defaultLabel: "Cite-check — {{inputs.brief_name}} — {{now | date:short}}" },
  },
  [WORKFLOW_TEMPLATE_IDS.meetConfer]: {
    title: "Draft a meet-and-confer letter",
    intro: "Pulls the firm's precedents, drafts the letter with the dispute facts and requested relief, files it and calendars the response deadline.",
    fields: [
      F.matter(),
      { key: "opposing_counsel", label: "Addressee", type: "text", required: true, placeholder: "Opposing counsel, firm" },
      { key: "dispute", label: "Dispute summary", type: "textarea", required: true },
      { key: "relief", label: "What we are asking for", type: "textarea", required: true },
      { key: "response_deadline", label: "Response deadline", type: "date", required: true },
    ],
    submitLabel: "Draft the letter",
    output: { formats: ["docx", "pdf"], defaultFormat: "docx", defaultLabel: "Meet-and-confer letter — {{inputs.opposing_counsel | truncate:40}} — {{now | date:short}}" },
  },
  [WORKFLOW_TEMPLATE_IDS.pagaChecklist]: {
    title: "Respond to a PAGA notice",
    intro: "Parses the LWDA notice, opens a work item per allegation with cure deadlines, calendars the 33-day window and drafts the response checklist.",
    fields: [
      { key: "notice_text", label: "PAGA notice", type: "file", required: true, accept: DOC_ACCEPT },
      F.matter(),
      { key: "employer", label: "Employer", type: "text", required: true, placeholder: "Employer name" },
    ],
    submitLabel: "Parse the notice",
    output: { formats: ["docx", "pdf", "md"], defaultFormat: "docx", defaultLabel: "PAGA response checklist — {{inputs.employer}} — {{now | date:short}}" },
  },
  [WORKFLOW_TEMPLATE_IDS.regulatoryWatch]: {
    title: "Sweep the Federal Register",
    intro: "Runs every Monday on its schedule; start it now for the last seven days on a topic and agency.",
    fields: [
      { key: "topic", label: "Topic", type: "text", required: true, placeholder: "Substance, product or rule topic" },
      { key: "agency", label: "Agency slug", type: "text", placeholder: "environmental-protection-agency" },
      F.matter(),
    ],
    submitLabel: "Sweep now",
    output: { formats: ["md", "docx", "pdf"], defaultFormat: "md", defaultLabel: "Regulatory watch — {{inputs.topic | truncate:20}} — {{now | date:date}}" },
  },
  [WORKFLOW_TEMPLATE_IDS.depoDesignations]: {
    title: "Designate a deposition",
    intro: "Upload the transcript and say which side you designate for. Proposed page:line ranges are verified against the transcript and saved as a designation table for the team to finalize.",
    fields: [
      { key: "transcript_text", label: "Transcript", type: "file", required: true, accept: TRANSCRIPT_ACCEPT, help: "Page and line numbers are read from the transcript as uploaded." },
      { key: "witness", label: "Witness", type: "text", required: true, placeholder: "Witness name, title" },
      F.matter(),
      { key: "side", label: "Designating for", type: "select", required: true, options: ["Plaintiff", "Defendant"], default: "Defendant" },
      { key: "themes", label: "Themes to cover", type: "textarea", placeholder: "Knowledge of key documents; decisions made; communications with others" },
    ],
    submitLabel: "Propose designations",
    output: { formats: ["xlsx", "csv"], defaultFormat: "xlsx", defaultLabel: "Designations — {{inputs.witness}} — {{now | date:short}}" },
  },
  [WORKFLOW_TEMPLATE_IDS.productionQc]: {
    title: "QC a production",
    intro: "Checks the documents under a Bates prefix for gaps, privilege inconsistencies, hot documents coded non-responsive, custodian coverage and date problems, then saves the report and opens the fix-it task.",
    fields: [
      F.matter(),
      { key: "bates_prefix", label: "Bates prefix", type: "bates-prefix", required: true, placeholder: "ABC-" },
      { key: "volume", label: "Production volume", type: "text", required: true, placeholder: "VOL003" },
      { key: "load_file", label: "Load file or index", type: "file", accept: [".dat", ".csv", ".txt", ".opt", ".xlsx"], help: "Optional; the vendor's DAT/OPT or a CSV index is checked against the review set." },
      { key: "checks", label: "Checks", type: "multiselect", options: ["Bates gaps", "Privilege consistency", "Hot documents coded non-responsive", "Custodian coverage", "Date range sanity"], default: ["Bates gaps", "Privilege consistency", "Hot documents coded non-responsive"] },
    ],
    submitLabel: "Run QC",
    output: { formats: ["xlsx", "csv"], defaultFormat: "xlsx", defaultLabel: "Production QC — {{inputs.volume | default:\"volume\"}} — {{now | date:short}}" },
  },
  [WORKFLOW_TEMPLATE_IDS.judgeProfile]: {
    title: "Profile a judge",
    intro: "Builds a partner-ready profile from the intelligence store and agentic research on notable rulings and tendencies, verifies the claims and saves the memo to the matter.",
    fields: [
      { key: "judge", label: "Judge", type: "text", required: true, placeholder: "Judge name" },
      { key: "court", label: "Court", type: "text", placeholder: "Court" },
      F.matter(),
      { key: "focus", label: "Focus", type: "textarea", placeholder: "Daubert practice, summary judgment, discovery disputes" },
    ],
    submitLabel: "Build the profile",
    output: { formats: ["docx", "pdf", "md"], defaultFormat: "docx", defaultLabel: "Judge profile — {{inputs.judge}} — {{now | date:short}}" },
  },
  // LeClaude India practice templates (default gallery).
  ...INDIA_TEMPLATE_FRONTENDS,
};

/**
 * US-practice templates (PACER docket monitor, meet-and-confer, PAGA, Federal Register watch, FRCP designations, US
 * judge profiles). They still compile and can be built with `buildUsTemplates()`, but LeClaude India does not seed
 * them into the default gallery.
 */
export const US_ONLY_TEMPLATE_IDS: readonly string[] = [
  WORKFLOW_TEMPLATE_IDS.docketMonitor,
  WORKFLOW_TEMPLATE_IDS.meetConfer,
  WORKFLOW_TEMPLATE_IDS.pagaChecklist,
  WORKFLOW_TEMPLATE_IDS.regulatoryWatch,
  WORKFLOW_TEMPLATE_IDS.depoDesignations,
  WORKFLOW_TEMPLATE_IDS.judgeProfile,
];

function materialize(t: TemplateDef, frontend: WorkflowFrontend | undefined): Workflow {
  return {
    ...t,
    frontend,
    nodes: autoLayout(t.nodes, t.edges),
    status: "active",
    isTemplate: true,
    ownerId: undefined,
    createdAt: T0,
    updatedAt: T0,
    runsCount: 0,
  };
}

/** Default gallery: the Indian practice templates, then the jurisdiction-neutral ones (NDA intake, digests, logs…). */
export function buildTemplates(): Workflow[] {
  const us = new Set(US_ONLY_TEMPLATE_IDS);
  return [
    ...INDIA_TEMPLATES.map((t) => materialize(t, INDIA_TEMPLATE_FRONTENDS[t.id])),
    ...TEMPLATES.filter((t) => !us.has(t.id)).map((t) => materialize(t, TEMPLATE_FRONTENDS[t.id])),
  ];
}

/** US-practice templates (kept compiling; not in the default gallery). */
export function buildUsTemplates(): Workflow[] {
  const us = new Set(US_ONLY_TEMPLATE_IDS);
  return TEMPLATES.filter((t) => us.has(t.id)).map((t) => materialize(t, TEMPLATE_FRONTENDS[t.id]));
}

export function templateById(id: string): Workflow | undefined {
  return buildTemplates().find((t) => t.id === id) ?? buildUsTemplates().find((t) => t.id === id);
}

/** Every Indian template id is in the default gallery. */
export const DEFAULT_GALLERY_INDIA_IDS: readonly string[] = Object.values(INDIA_WORKFLOW_TEMPLATE_IDS);
