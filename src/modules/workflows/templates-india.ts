/**
 * Indian practice workflow templates (the default gallery of LeClaude India): limitation check, hearing-date
 * preparation, cause-list watch, bail matter pack, cheque-dishonour (s.138 NI Act) pack, judgment digest in
 * Kannada / Telugu, and the official-sources templates (daily cause-list check, new order → action items, hearing
 * brief) that read published cause lists and orders through the official-sources agent tools. Pure data like ./templates; positions come from autoLayout at build time.
 *
 * Dates that follow from a statute by simple counting (30 days for the s.138(b) notice, 15 days to pay) are computed
 * by the template expression filters (`add_days`), never by the model. Anything that needs judgment (which Article
 * of the Limitation Act applies, whether an exclusion is available) goes through extraction, verification and a
 * human review step, and every computed date in a draft is marked [VERIFY] for the advocate.
 */
import type { WorkflowEdge, WorkflowFrontend, WorkflowNode, WorkflowNodeType } from "@/lib/types/domain";
import { defaultConfigFor, type AnyNodeType } from "./registry";
import type { TemplateDef } from "./templates";

const OUT = (format: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ format: `{{inputs.output_format | default:"${format}"}}`, label: "{{inputs.output_label | default:\"\"}}", content: "", rows: "", libraryFolderId: "{{inputs.output_folder | default:\"\"}}", matterId: "{{inputs.matter}}", addToLibrary: true, tags: ["workflow"], ...extra });
const DOC_ACCEPT = [".docx", ".pdf", ".txt", ".md"];
const NO_RESEARCH = { web: false, legal: false, internal: false };
const INTERNAL_ONLY = { web: false, legal: false, internal: true };

function N(id: string, type: AnyNodeType, label: string, config: Record<string, unknown> = {}): WorkflowNode {
  return { id, type: type as WorkflowNodeType, label, position: { x: 0, y: 0 }, config: { ...defaultConfigFor(type), ...config } };
}
function E(source: string, target: string, sourceHandle?: string, targetHandle?: string, label?: string): WorkflowEdge {
  return { id: `e_${source}__${target}${sourceHandle ? `__${sourceHandle}` : ""}`, source, target, sourceHandle, targetHandle, label };
}

export const INDIA_WORKFLOW_TEMPLATE_IDS = {
  limitation: "wf_tpl_in_limitation",
  hearingPrep: "wf_tpl_in_hearing_prep",
  causeList: "wf_tpl_in_cause_list",
  bailPack: "wf_tpl_in_bail_pack",
  chequePack: "wf_tpl_in_cheque_pack",
  judgmentDigest: "wf_tpl_in_judgment_digest",
  dailyCauseList: "wf_tpl_in_daily_causelist",
  orderActions: "wf_tpl_in_order_actions",
  hearingBrief: "wf_tpl_in_hearing_brief",
} as const;

const I = INDIA_WORKFLOW_TEMPLATE_IDS;
const MATTER = { key: "matter", label: "Matter", type: "matter" as const, required: true };
const FORUM = { key: "forum", label: "Court / tribunal", type: "text" as const, required: true, placeholder: "sci · hc-delhi · nclt-mumbai · nclat" };
const CASE_NO = { key: "case_number", label: "Case number (as printed)", type: "text" as const, required: true, placeholder: "SLP(C) No. 1234/2026 · W.P.(C) 5812/2016 · CP(IB)/29(MP)2022" };
const PURPOSES = ["Admission", "Arguments on interlocutory application", "Cross-examination of witness", "Framing of issues", "Final arguments", "Bail hearing", "Orders / pronouncement"];

/** Structured result of the cause-list check (copied from causelist_lookup; never inferred). */
const LISTING_SCHEMA = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["listed", "not_found_in_loaded_lists", "not_available"], description: "listed only when causelist_lookup returned entries" },
    listings: { type: "array", items: { type: "object", properties: { list_date: { type: "string" }, court_no: { type: "string" }, bench: { type: "string" }, item_no: { type: "string" }, list_type: { type: "string" }, page: { type: "string" }, source: { type: "string", description: "src:// reference returned by the tool" } }, required: ["list_date", "court_no", "bench", "item_no", "list_type", "page", "source"] } },
    summary: { type: "string", description: "One paragraph for the team, including the tool's caveat" },
    hearing_note: { type: "string", description: "Per listing: date, court, item and what to carry; empty when not listed" },
  },
  required: ["status", "listings", "summary", "hearing_note"],
};

/** Structured result of reading an order (every item quoted with its page; dates only as printed). */
const ORDER_SCHEMA = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["found", "not_found", "not_available"] },
    order: { type: "object", properties: { title: { type: "string" }, date: { type: "string" }, source: { type: "string", description: "src:// reference of the order read" }, url: { type: "string" }, ocr: { type: "boolean" } }, required: ["title", "date", "source", "url", "ocr"] },
    directions: { type: "array", items: { type: "object", properties: { direction: { type: "string" }, quote: { type: "string", description: "Verbatim words of the order" }, page: { type: "string" } }, required: ["direction", "quote", "page"] } },
    next_date: { type: "string", description: "YYYY-MM-DD exactly as fixed by the order, or empty" },
    next_date_quote: { type: "string" },
    compliance: { type: "array", items: { type: "object", properties: { task: { type: "string" }, by_whom: { type: "string" }, due_as_stated: { type: "string", description: "As the order states it (\"within four weeks\"); never computed" }, quote: { type: "string" }, page: { type: "string" } }, required: ["task", "by_whom", "due_as_stated", "quote", "page"] } },
    summary: { type: "string" },
  },
  required: ["status", "order", "directions", "next_date", "next_date_quote", "compliance", "summary"],
};

export const INDIA_TEMPLATES: TemplateDef[] = [
  // 1 ───────────────────────── Limitation check ─────────────────────────
  {
    id: I.limitation,
    name: "Limitation check",
    description: "Identify the Article of the Limitation Act, 1963 that governs a claim, when time started, exclusions and acknowledgements (ss.4, 12, 14, 18, 19), verify against the Act and file a limitation note for advocate sign-off.",
    category: "research",
    tags: ["limitation", "Limitation Act 1963", "pre-suit", "India"],
    inputs: [
      MATTER,
      { key: "facts", label: "Facts and dates", type: "textarea", required: true, placeholder: "Invoices raised 12.01.2023 payable in 30 days; part payment 05.06.2023; acknowledgement email 14.11.2024…" },
      { key: "relief", label: "Proceeding", type: "select", required: true, options: ["Suit for money (recovery)", "Suit on a contract", "Specific performance", "Declaration / injunction", "Possession of immovable property", "Appeal / revision", "Application in a pending proceeding"] },
      { key: "accrual_date", label: "Date the right to sue first accrued (if known)", type: "date" },
    ],
    nodes: [
      N("start", "trigger.manual", "Run with facts"),
      N("extract", "ai.extract", "Identify Article and start of time", {
        source: "Proceeding: {{inputs.relief}}\nAccrual date given: {{inputs.accrual_date | default:\"not given\"}}\n\nFacts:\n{{inputs.facts}}",
        modelTier: "primary",
        instructions: "Indian law. Name the Article of the Schedule to the Limitation Act, 1963 that most likely governs, the prescribed period, and the event from which time begins to run under that Article. List every acknowledgement in writing (s.18) and part payment (s.19) with its date, any period to be excluded (ss.12–15) and whether s.5 condonation is available (appeals and applications only; never for suits). Quote the fact each item rests on in _evidence. Do not compute the last date; dates are computed and verified by the advocate.",
        fields: [
          { name: "article", type: "string", description: "Article number and short description, e.g. 'Article 113 — any suit for which no period is provided elsewhere'" },
          { name: "period", type: "string", description: "Prescribed period as stated in the Schedule (e.g. 'Three years')" },
          { name: "time_runs_from", type: "string", description: "Event from which time begins to run under the Article" },
          { name: "start_date", type: "date", description: "Date of that event, if the facts give it" },
          { name: "acknowledgements", type: "string[]", description: "Written acknowledgements (s.18) with dates" },
          { name: "part_payments", type: "string[]", description: "Part payments (s.19) with dates" },
          { name: "exclusions", type: "string[]", description: "Periods to exclude (ss.4, 12, 13, 14, 15) with reasons" },
          { name: "condonation", type: "string", description: "Whether s.5 condonation is available and why" },
          { name: "open_questions", type: "string[]", description: "Facts needed from the client to fix the date" },
        ],
      }),
      N("research", "ai.research", "Check the Article and exclusions", { question: "Under the Limitation Act, 1963, confirm the limitation period and starting point for: {{inputs.relief}}. Proposed Article: {{steps.extract.output.article}} ({{steps.extract.output.period}}, running from {{steps.extract.output.time_runs_from}}). Address the effect of acknowledgements under s.18 and part payments under s.19 on these facts, and any contrary view of the Supreme Court or the High Court of Karnataka / Telangana.", jurisdiction: "", depth: "standard", sources: { web: true, legal: true, internal: true }, instructions: "Read the Schedule entry and the leading judgments before relying on them. Cite the Act and each judgment; mark anything unread [VERIFY]." }),
      N("verify", "ai.verify", "Verify against the Act and facts", { output: "{{steps.extract.output}}", sources: "Facts:\n{{inputs.facts}}\n\nResearch:\n{{steps.research.output.text}}", stepId: "extract", mode: "structured", modelTier: "fast" }),
      N("memo", "ai.draft", "Draft limitation note", {
        kind: "memo", tone: "neutral", audience: "team", modelTier: "primary", research: NO_RESEARCH,
        brief: "Draft a limitation note for {{matter.name}}. Sections: Bottom line (in time / out of time / depends on — with the single fact it turns on); Governing Article and period; When time started; Acknowledgements and part payments (table: Date | Document | Effect); Exclusions; Computation — show each step and mark the resulting last date [VERIFY]; Condonation (if available); Facts needed from the client. Cite the Act and judgments exactly as in the research; keep [VERIFY] marks.\n\nFindings (verified: {{steps.verify.output.status}}):\n{{steps.verify.output.corrected | json}}\n\nResearch:\n{{steps.research.output.text | truncate:8000}}",
      }),
      N("review", "logic.review", "Trust review", { steps: "extract, verify, memo", approverId: "{{user.id}}", title: "Limitation note needs a look", message: "Part of the limitation analysis did not verify against the facts or the research. Approve to file the note for advocate sign-off, or reject to stop." }),
      N("save", "output.file", "Save limitation note", OUT("docx", { content: "{{steps.memo.output.text}}", tags: ["limitation"] })),
      N("task", "action.create_task", "Advocate to confirm last date", { title: "Confirm limitation: {{steps.extract.output.article | default:\"Article to be fixed\"}} — {{matter.shortName}}", description: "Check the computation in the note against the documents and the Act before advising the client. Open questions:\n{{steps.extract.output.open_questions | bullets}}\n\n{{steps.save.output.href}}", assigneeId: "{{user.id}}", priority: "urgent", dueRule: "+1bd", matterId: "{{inputs.matter}}", tags: ["limitation"] }),
    ],
    edges: [E("start", "extract"), E("extract", "research"), E("research", "verify"), E("verify", "memo"), E("memo", "review"), E("review", "save", "approved"), E("save", "task")],
  },

  // 2 ───────────────────────── Hearing-date preparation ─────────────────────────
  {
    id: I.hearingPrep,
    name: "Hearing-date preparation",
    description: "Before a listed hearing, pull the matter's record (pleadings, exhibits Ex.P/Ex.D, depositions, last order sheet), draft a hearing note with list of dates and points, calendar the hearing and open the preparation task.",
    category: "drafting",
    tags: ["hearing", "cause list", "preparation", "India"],
    inputs: [
      MATTER,
      { key: "hearing_date", label: "Hearing date", type: "date", required: true },
      { key: "purpose", label: "Stage / purpose", type: "select", required: true, options: ["Admission", "Arguments on interlocutory application", "Cross-examination of witness", "Framing of issues", "Final arguments", "Bail hearing", "Orders / pronouncement"] },
      { key: "focus", label: "Points to cover", type: "textarea", placeholder: "Cross of DW-1 on Ex.D4 (delivery challans); limitation objection…" },
    ],
    nodes: [
      N("start", "trigger.manual", "Run before the hearing"),
      N("search", "data.search_ediscovery", "Pull the record", { query: "{{inputs.purpose}} {{inputs.focus | default:\"\"}}", matterId: "{{inputs.matter}}", limit: 25 }),
      N("note", "ai.draft", "Draft hearing note", {
        kind: "memo", tone: "neutral", audience: "team", modelTier: "primary", research: INTERNAL_ONLY,
        brief: "Draft a hearing note for {{matter.name}} ({{matter.caption | default:matter.shortName}}), listed on {{inputs.hearing_date | date:long}} for {{inputs.purpose}}.\n\nSections: Where the matter stands (stage, last order); List of dates; Points to urge (numbered, each tied to a document by its exhibit mark or document number, or to testimony by witness and page:line); Anticipated objections and answers; Documents and authorities to carry (mark every authority [VERIFY]); Orders to seek. Use only the record excerpts below; if the record does not establish a point, say so.\n\nFocus: {{inputs.focus | default:\"(none given)\"}}\n\nRecord excerpts:\n{{steps.search.output.text | truncate:24000}}",
      }),
      N("verify", "ai.verify", "Verify against the record", { output: "{{steps.note.output.text}}", sources: "{{steps.search.output.results}}", stepId: "note", mode: "claims", modelTier: "fast" }),
      N("review", "logic.review", "Trust review", { steps: "note, verify", approverId: "{{user.id}}", title: "Hearing note needs a look", message: "Some statements in the hearing note did not verify against the record. Approve to file it, or reject to stop." }),
      N("save", "output.file", "Save hearing note", OUT("docx", { content: "{{steps.note.output.text}}", tags: ["hearing"] })),
      N("event", "action.create_event", "Calendar the hearing", { title: "Hearing: {{matter.shortName}} — {{inputs.purpose}}", kind: "hearing", startsAt: "{{inputs.hearing_date}}T10:30", durationMinutes: 60, location: "{{matter.court}}", notes: "Hearing note: {{steps.save.output.href}}", attendeeIds: ["{{user.id}}"], ruleSource: "", matterId: "{{inputs.matter}}" }),
      N("task", "action.create_task", "Prepare for hearing", { title: "Prepare: {{matter.shortName}} — {{inputs.purpose}} on {{inputs.hearing_date | date:short}}", description: "Read the hearing note, collect the originals / certified copies to carry, confirm the item number in the cause list the evening before.\n\n{{steps.save.output.href}}", assigneeId: "{{user.id}}", priority: "high", dueRule: "+1bd", matterId: "{{inputs.matter}}", tags: ["hearing"] }),
    ],
    edges: [E("start", "search"), E("search", "note"), E("note", "verify"), E("verify", "review"), E("review", "save", "approved"), E("save", "event"), E("save", "task")],
  },

  // 3 ───────────────────────── Cause-list watch ─────────────────────────
  {
    id: I.causeList,
    name: "Cause-list watch",
    description: "Every evening, read the published cause list for the next working day from the court's public page, find the firm's cases by number, and post the item numbers and courts to the team. Pages behind a captcha are never automated.",
    category: "operations",
    tags: ["cause list", "hearing", "scheduled", "India"],
    inputs: [
      MATTER,
      { key: "cause_list_url", label: "Cause list page (public URL)", type: "text", required: true, placeholder: "Public cause-list page or PDF of the High Court / district court" },
      { key: "case_numbers", label: "Case numbers to look for", type: "textarea", required: true, placeholder: "W.P. No. 18234 of 2024\nCom.O.S. No. 1187 of 2023" },
    ],
    nodes: [
      N("schedule", "trigger.schedule", "Every evening 19:30", { schedule: { frequency: "daily", time: "19:30" }, enabled: true, presetInputs: {} }),
      N("fetch", "data.fetch_url", "Read the cause list", { url: "{{inputs.cause_list_url}}" }),
      N("find", "ai.extract", "Find our cases", {
        source: "Case numbers to find:\n{{inputs.case_numbers}}\n\nCause list text:\n{{steps.fetch.output.text | truncate:120000}}",
        modelTier: "fast",
        instructions: "Report a case only if its type, number and year all match exactly as listed; never report a near match. Copy the court hall, item number, list type (daily / supplementary / advance) and the stage exactly as printed.",
        fields: [
          { name: "listed", type: "string[]", description: "One line per case found: case number | court hall | item no. | list | stage" },
          { name: "not_found", type: "string[]", description: "Case numbers not found in the list" },
          { name: "list_date", type: "date", description: "Date the list is for" },
        ],
      }),
      N("any", "logic.branch", "Listed tomorrow?", { rules: [{ id: "yes", label: "Listed", logic: "all", conditions: [{ left: "{{steps.find.output.listed | length}}", op: "gt", right: "0" }] }], elseLabel: "Not listed" }),
      N("notify", "action.notify", "Post item numbers", { recipientIds: ["{{user.id}}"], kind: "update", message: "Cause list for {{steps.find.output.list_date | default:\"the next working day\"}} — {{matter.shortName}}:\n{{steps.find.output.listed | bullets}}\n\nNot found: {{steps.find.output.not_found | join:\", \" | default:\"none\"}}", matterId: "{{inputs.matter}}" }),
      N("task", "action.create_task", "Attend listed matter", { title: "Listed: {{steps.find.output.listed | first}}", description: "Confirm the item number on the court website in the morning and brief counsel.\n\n{{steps.find.output.listed | bullets}}", assigneeId: "{{user.id}}", priority: "urgent", dueRule: "+1bd", matterId: "{{inputs.matter}}", tags: ["cause list"] }),
    ],
    edges: [E("schedule", "fetch"), E("fetch", "find"), E("find", "any"), E("any", "notify", "yes"), E("any", "task", "yes")],
  },

  // 4 ───────────────────────── Bail matter pack ─────────────────────────
  {
    id: I.bailPack,
    name: "Bail matter pack",
    description: "From the FIR and remand papers, extract the crime particulars, decide from the offence date whether BNS/BNSS or IPC/CrPC applies, research the bail position and draft the bail application with a list of dates, for advocate review.",
    category: "drafting",
    tags: ["bail", "BNSS", "criminal", "India"],
    inputs: [
      MATTER,
      { key: "fir_text", label: "FIR / remand papers", type: "file", required: true },
      { key: "offence_date", label: "Date of offence (as alleged)", type: "date", required: true },
      { key: "kind", label: "Application", type: "select", required: true, options: ["Regular bail", "Anticipatory bail"] },
      { key: "forum", label: "Before", type: "select", required: true, options: ["Sessions Court", "High Court"] },
      { key: "accused", label: "Accused (name, age, occupation)", type: "text", required: true },
    ],
    nodes: [
      N("start", "trigger.manual", "Run with FIR"),
      N("extract", "ai.extract", "Crime particulars", {
        source: "{{inputs.fir_text}}",
        modelTier: "primary",
        instructions: "Copy the crime number, police station, sections and dates exactly as written in the FIR. If a section number is ambiguous between the old and new codes, report it as written and flag it; never convert sections yourself.",
        fields: [
          { name: "crime_no", type: "string", description: "Crime / FIR number and year" },
          { name: "police_station", type: "string", description: "Police station" },
          { name: "sections", type: "string[]", description: "Sections as written, with the Act (BNS / IPC / other)" },
          { name: "offence_date", type: "date", description: "Date of offence as alleged" },
          { name: "fir_date", type: "date", description: "Date of registration" },
          { name: "arrest_date", type: "date", description: "Date of arrest, if any" },
          { name: "allegations", type: "string", description: "Neutral summary of the allegations" },
          { name: "role_of_accused", type: "string", description: "Role attributed to the applicant" },
        ],
      }),
      N("research", "ai.research", "Bail position for these offences", { question: "Bail for an accused charged under {{steps.extract.output.sections | join:\", \"}} (offence date as alleged: {{inputs.offence_date}}; {{inputs.kind}} before the {{inputs.forum}}). The substantive code is decided by the offence date: IPC for offences before 1 July 2024, BNS on or after. State the governing bail provision (BNSS ss.480, 482, 483, or the corresponding CrPC provisions for proceedings saved by BNSS s.531), the leading Supreme Court principles and relevant decisions of the High Court of Karnataka / Telangana.", jurisdiction: "", depth: "standard", sources: { web: true, legal: true, internal: false }, instructions: "Use the coded IPC→BNS correspondence; never guess a section mapping. Read judgments before citing them; mark unread ones [VERIFY]." }),
      N("draft", "ai.draft", "Draft bail application", {
        kind: "motion", tone: "formal", audience: "court", modelTier: "primary", research: NO_RESEARCH,
        brief: "Draft a {{inputs.kind | lower}} application before the {{inputs.forum}} for {{inputs.accused}} in {{steps.extract.output.crime_no}} of {{steps.extract.output.police_station}} Police Station, offences under {{steps.extract.output.sections | join:\", \"}}. Use the cause-title format of the court; for regular bail use s.483 BNSS (anticipatory: s.482 BNSS) unless the research shows the proceeding is governed by the CrPC. Include: particulars of custody (arrest date {{steps.extract.output.arrest_date | default:\"not stated\"}}), allegations (neutral, not admitted), grounds (antecedents, parity, triple test, nature of evidence, period of custody), undertaking, prayer and a list of dates. Keep every authority exactly as in the research and mark it [VERIFY].\n\nAllegations: {{steps.extract.output.allegations}}\nRole: {{steps.extract.output.role_of_accused}}\n\nResearch:\n{{steps.research.output.text | truncate:10000}}",
      }),
      N("verify", "ai.verify", "Verify against FIR and research", { output: "{{steps.draft.output.text}}", sources: "FIR:\n{{inputs.fir_text | truncate:40000}}\n\nResearch:\n{{steps.research.output.text | truncate:12000}}", stepId: "draft", mode: "claims", modelTier: "fast" }),
      N("review", "logic.review", "Advocate review", { steps: "extract, draft, verify", approverId: "{{user.id}}", title: "Bail application needs review", message: "Review the particulars and grounds before filing. Approve to save the draft to the matter." }),
      N("save", "output.file", "Save bail pack", OUT("docx", { content: "{{steps.draft.output.text}}", tags: ["bail"] })),
      N("task", "action.create_task", "File bail application", { title: "File {{inputs.kind | lower}} application: {{inputs.accused}} ({{steps.extract.output.crime_no}})", description: "Collect certified copies of the FIR and remand orders, vakalat signed by the accused (jail visit if in custody), and check the sections against the charge sheet if filed.\n\n{{steps.save.output.href}}", assigneeId: "{{user.id}}", priority: "urgent", dueRule: "+1bd", matterId: "{{inputs.matter}}", tags: ["bail"] }),
    ],
    edges: [E("start", "extract"), E("extract", "research"), E("research", "draft"), E("draft", "verify"), E("verify", "review"), E("review", "save", "approved"), E("save", "task")],
  },

  // 5 ───────────────────────── Cheque-dishonour (s.138 NI Act) pack ─────────────────────────
  {
    id: I.chequePack,
    name: "Cheque-dishonour (s.138) pack",
    description: "From the cheque and return memo details, compute the statutory dates (30-day notice, 15-day payment window), draft the demand notice and the complaint under s.223 BNSS read with ss.138 and 142 NI Act, and calendar the deadlines.",
    category: "drafting",
    tags: ["cheque bounce", "NI Act", "s.138", "India"],
    inputs: [
      MATTER,
      { key: "drawer", label: "Drawer (name and address)", type: "text", required: true },
      { key: "cheque", label: "Cheque details", type: "text", required: true, placeholder: "No. 004512 dated 10.03.2026 for ₹8,40,000 on [bank, branch]" },
      { key: "debt", label: "Underlying debt / liability", type: "textarea", required: true },
      { key: "return_memo_date", label: "Return memo date", type: "date", required: true },
      { key: "info_date", label: "Date information of dishonour was received", type: "date", required: true },
      { key: "notice_served_date", label: "Date notice was served (if already sent)", type: "date" },
      { key: "collecting_branch", label: "Payee's bank branch (for s.142(2) jurisdiction)", type: "text", required: true },
    ],
    nodes: [
      N("start", "trigger.manual", "Run with cheque details"),
      N("draft", "ai.draft", "Draft notice and complaint", {
        kind: "letter", tone: "formal", audience: "court", modelTier: "primary", research: NO_RESEARCH,
        brief: "Draft, for {{matter.client | default:\"the payee\"}}: (A) the statutory demand notice under s.138(b) of the Negotiable Instruments Act, 1881 to {{inputs.drawer}}, and (B) the complaint under s.223 BNSS read with ss.138 and 142 NI Act before the Magistrate having jurisdiction over {{inputs.collecting_branch}} (s.142(2)(a)).\n\nCheque: {{inputs.cheque}}\nDebt: {{inputs.debt}}\nReturn memo: {{inputs.return_memo_date | date:long}}\nInformation of dishonour received: {{inputs.info_date | date:long}}\n\nStatutory dates (computed by counting days; state them exactly and mark each [VERIFY]):\n- Last date to issue notice (30 days from information): {{inputs.info_date | add_days:30}}\n- Notice served: {{inputs.notice_served_date | default:\"not yet served\"}}\n- Payment window: 15 days from the date of service of the notice (compute from the service date above)\n- Cause of action arises the next day; the complaint must be filed within one month of the cause of action (s.142(1)(b)).\n\nInclude the list of documents and the verification. Do not invent any fact not given.",
      }),
      N("verify", "ai.verify", "Verify facts and dates", { output: "{{steps.draft.output.text}}", sources: "Cheque: {{inputs.cheque}}\nDebt: {{inputs.debt}}\nReturn memo {{inputs.return_memo_date}}; information {{inputs.info_date}}; notice deadline {{inputs.info_date | add_days:30}}; served {{inputs.notice_served_date | default:\"not served\"}}; payment window 15 days from service", stepId: "draft", mode: "claims", modelTier: "fast" }),
      N("review", "logic.review", "Trust review", { steps: "draft, verify", approverId: "{{user.id}}", title: "s.138 pack needs a look", message: "Some statements in the notice or complaint did not verify against the details given. Approve to save the pack, or reject to stop." }),
      N("save", "output.file", "Save s.138 pack", OUT("docx", { content: "{{steps.draft.output.text}}", tags: ["NI Act", "s.138"] })),
      N("deadline", "action.create_event", "Notice deadline", { title: "s.138(b) notice deadline — {{matter.shortName}}", kind: "deadline", startsAt: "{{inputs.info_date | add_days:30}}T10:00", durationMinutes: 0, location: "", notes: "30 days from receipt of information of dishonour ({{inputs.info_date}}). [VERIFY]", attendeeIds: ["{{user.id}}"], ruleSource: "NI Act s.138(b)", matterId: "{{inputs.matter}}" }),
      N("task", "action.create_task", "Send notice / file complaint", { title: "s.138: send notice (by {{inputs.info_date | add_days:30}}) and diary the complaint — {{matter.shortName}}", description: "Send the notice by RPAD / speed post and keep tracking proof. Once served, the complaint lies from the day after the 15-day payment window and must be filed within one month (s.142(1)(b)).\n\n{{steps.save.output.href}}", assigneeId: "{{user.id}}", priority: "urgent", dueRule: "+1bd", matterId: "{{inputs.matter}}", tags: ["NI Act"] }),
    ],
    edges: [E("start", "draft"), E("draft", "verify"), E("verify", "review"), E("review", "save", "approved"), E("save", "deadline"), E("save", "task")],
  },

  // 6 ───────────────────────── Judgment digest in Kannada / Telugu ─────────────────────────
  {
    id: I.judgmentDigest,
    name: "Judgment digest (Kannada / Telugu)",
    description: "Digest a judgment (court, coram, citation, statutes, holdings with paragraph numbers), verify it against the text, and add a Kannada or Telugu version for the client, labelled as a machine translation; the original judgment remains the text of record.",
    category: "research",
    tags: ["judgment", "digest", "Kannada", "Telugu", "translation", "India"],
    inputs: [
      MATTER,
      { key: "judgment_text", label: "Judgment (upload or paste)", type: "file", required: true },
      { key: "language", label: "Client language", type: "select", required: true, options: ["Kannada", "Telugu"] },
    ],
    nodes: [
      N("start", "trigger.manual", "Run with judgment"),
      N("extract", "ai.extract", "Digest the judgment", {
        source: "{{inputs.judgment_text | truncate:120000}}",
        modelTier: "primary",
        instructions: "Copy the court, case number, neutral citation and date exactly as printed. Every holding must carry the paragraph number it comes from. Do not characterise the judgment beyond what the paragraphs say.",
        fields: [
          { name: "court", type: "string", description: "Court and bench" },
          { name: "case_number", type: "string", description: "Case number as printed" },
          { name: "neutral_citation", type: "string", description: "Neutral citation if printed (e.g. 2024:KHC:12345)" },
          { name: "decided_on", type: "date", description: "Date of judgment" },
          { name: "coram", type: "string[]", description: "Judges" },
          { name: "statutes", type: "string[]", description: "Acts and sections considered" },
          { name: "holdings", type: "string[]", description: "Holdings, each ending with (para N)" },
          { name: "result", type: "string", description: "Disposal (allowed / dismissed / disposed with directions)" },
        ],
      }),
      N("verify", "ai.verify", "Verify against the judgment", { output: "{{steps.extract.output}}", sources: "{{inputs.judgment_text | truncate:120000}}", stepId: "extract", mode: "structured", modelTier: "fast" }),
      N("translate", "ai.prompt", "Client version", {
        instructions: "Write a short plain-language digest for a client in {{inputs.language}}, from the verified English digest only. Start with the line 'Machine translation — the original judgment is the text of record' written in {{inputs.language}} followed by the same line in English. Keep case numbers, citations, section numbers and paragraph numbers in Latin script exactly as given.",
        prompt: "Verified digest:\n{{steps.verify.output.corrected | json}}",
        output: "text", modelTier: "primary", research: NO_RESEARCH,
      }),
      N("save", "output.file", "Save digest", OUT("docx", { content: "# Judgment digest\n\n{{steps.verify.output.corrected | json}}\n\n## Client version ({{inputs.language}}) — machine translation\n\n{{steps.translate.output.text}}", tags: ["judgment", "digest"] })),
      N("notify", "action.notify", "Share with team", { recipientIds: ["{{user.id}}"], kind: "update", message: "Judgment digest ready for {{matter.shortName}} ({{steps.extract.output.case_number}}, verification: {{steps.verify.output.status}}), with a {{inputs.language}} client version (machine translation).\n\n{{steps.save.output.href}}", matterId: "{{inputs.matter}}" }),
    ],
    edges: [E("start", "extract"), E("extract", "verify"), E("verify", "translate"), E("translate", "save"), E("save", "notify")],
  },

  // 7 ───────────────────────── Daily cause-list check (official sources) ─────────────────────────
  {
    id: I.dailyCauseList,
    name: "Daily cause-list check",
    description: "Every evening, look the matter up in the published cause lists loaded from the courts (exact case-number or diary-number match only), post the listing — court, bench, item number, list and page — with a short hearing note, and open an attendance task when it is listed. No match is reported as not found in the loaded lists, never as 'not listed'.",
    category: "operations",
    tags: ["cause list", "hearing", "scheduled", "official sources", "India"],
    inputs: [
      MATTER,
      FORUM,
      CASE_NO,
      { key: "diary_no", label: "Diary number (Supreme Court)", type: "text", placeholder: "54583/2026" },
    ],
    nodes: [
      N("schedule", "trigger.schedule", "Every evening 19:45", { schedule: { frequency: "daily", time: "19:45" }, enabled: true, presetInputs: {} }),
      N("lookup", "ai.agent", "Check the cause lists", {
        agent: "analyst", tools: ["causelist_lookup"], output: "json", jsonSchema: LISTING_SCHEMA, modelTier: "fast", maxSteps: 4,
        brief: "Check whether {{matter.shortName | default:matter.name}} is listed from {{now | add_days:0}} to {{now | add_days:3}}. Call causelist_lookup with forum \"{{inputs.forum}}\", case_number \"{{inputs.case_number}}\", from {{now | add_days:0}} and to {{now | add_days:3}}. Supreme Court diary number: {{inputs.diary_no | default:\"none\"}} (pass it as diary_no only when one is given).\n\nCopy every returned entry exactly (list date, court number, bench, item number, list type, page, source). status: listed only when the tool returned entries; not_found_in_loaded_lists when it returned none — say, as the tool does, that this does not prove the matter is not listed; not_available when the tool is missing or reports the official corpus is not available. Never infer, complete or correct a listing the tool did not return.",
        context: "Matter: {{matter.name}} ({{matter.caption | default:matter.shortName}}); court on file: {{matter.court | default:\"not recorded\"}}.",
      }),
      N("notify", "action.notify", "Post the result", { recipientIds: ["{{user.id}}"], kind: "update", message: "Cause list check — {{matter.shortName}} ({{inputs.case_number}}), {{now | add_days:0}} to {{now | add_days:3}}: {{steps.lookup.output.status}}\n\n{{steps.lookup.output.summary}}\n\n{{steps.lookup.output.hearing_note}}", matterId: "{{inputs.matter}}" }),
      N("any", "logic.branch", "Listed?", { rules: [{ id: "yes", label: "Listed", logic: "all", conditions: [{ left: "{{steps.lookup.output.status}}", op: "equals", right: "listed" }] }], elseLabel: "Not found" }),
      N("task", "action.create_task", "Attend listed matter", { title: "Listed: {{matter.shortName}} — {{inputs.case_number}}", description: "Confirm the item number on the court's website the evening before and brief counsel.\n\n{{steps.lookup.output.hearing_note}}\n\nListings (as published): {{steps.lookup.output.listings | json}}", assigneeId: "{{user.id}}", priority: "urgent", dueRule: "+1bd", matterId: "{{inputs.matter}}", tags: ["cause list"] }),
    ],
    edges: [E("schedule", "lookup"), E("lookup", "notify"), E("lookup", "any"), E("any", "task", "yes")],
  },

  // 8 ───────────────────────── New order → action items ─────────────────────────
  {
    id: I.orderActions,
    name: "New order → action items",
    description: "Read the latest published order in the matter from the official sources (court, tribunal or regulator), extract its directions, the next date and the compliance it requires — each with a page-cited verbatim quote — and, after a trust review, file the note, calendar the next date as printed and open the compliance task. Dates are taken only as the order prints them; limitation is computed by the advocate.",
    category: "operations",
    tags: ["orders", "compliance", "next date", "official sources", "India"],
    inputs: [
      MATTER,
      FORUM,
      CASE_NO,
      { key: "order_ref", label: "Specific order (src:// reference, optional)", type: "text", placeholder: "src://sci-orders_4d2e9a01bc" },
    ],
    nodes: [
      N("start", "trigger.manual", "Run when a new order is out"),
      N("read", "ai.agent", "Read the latest order", {
        agent: "analyst", tools: ["search_official_sources", "read_official_document"], output: "json", jsonSchema: ORDER_SCHEMA, modelTier: "primary", maxSteps: 8,
        brief: "Find the most recent order in {{inputs.case_number}} before {{inputs.forum}}. Specific order requested: {{inputs.order_ref | default:\"none\"}} — when it is a src:// reference, read exactly that document; otherwise search with search_official_sources (kinds order and judgment; the case number as printed as the query) and pick the latest dated order for this case number only. Read it in full with read_official_document.\n\nFrom the order's own words only, return: order (title, date, the src:// source you read, the official url, ocr true when the text is flagged OCR); directions (each with its verbatim quote and page); next_date exactly as fixed by the order (YYYY-MM-DD) with next_date_quote, or empty when none is fixed; compliance (task, by whom, due as the order states it — never computed — with quote and page); summary. status not_found when no order for this case number is found (never another case's order); not_available when the official corpus is not available.",
        context: "Matter: {{matter.name}} ({{matter.caption | default:matter.shortName}}).",
      }),
      N("review", "logic.review", "Trust review", { steps: "read", approverId: "{{user.id}}", title: "Order extraction needs a look", message: "Check the directions, next date and compliance against the order (pages are cited; OCR text must be checked against the PDF). Approve to file the note, calendar the next date and open the compliance task." }),
      N("save", "output.file", "Save action note", OUT("docx", { content: "# Order — action items\n\n**Matter:** {{matter.name}}  \n**Order:** {{steps.read.output.order.title}}, dated {{steps.read.output.order.date}} ({{steps.read.output.order.source}}) {{steps.read.output.order.url}}\n\n## Summary\n\n{{steps.read.output.summary}}\n\n## Directions (verbatim, with page)\n\n{{steps.read.output.directions | json}}\n\n## Compliance\n\n{{steps.read.output.compliance | json}}\n\n## Next date\n\n{{steps.read.output.next_date | default:\"Not fixed in the order\"}} — \"{{steps.read.output.next_date_quote}}\" [VERIFY]", tags: ["order", "compliance"] })),
      N("dated", "logic.branch", "Next date fixed?", { rules: [{ id: "yes", label: "Date fixed", logic: "all", conditions: [{ left: "{{steps.read.output.next_date}}", op: "not_empty" }] }], elseLabel: "No date" }),
      N("event", "action.create_event", "Calendar the next date", { title: "Next date: {{matter.shortName}} ({{inputs.case_number}})", kind: "hearing", startsAt: "{{steps.read.output.next_date}}T10:30", durationMinutes: 60, location: "{{matter.court}}", notes: "As fixed in the order dated {{steps.read.output.order.date}}: \"{{steps.read.output.next_date_quote}}\" ({{steps.read.output.order.source}}). [VERIFY] against the order and the cause list.", attendeeIds: ["{{user.id}}"], ruleSource: "Order dated {{steps.read.output.order.date}}", matterId: "{{inputs.matter}}" }),
      N("task", "action.create_task", "Comply with the order", { title: "Comply with order dated {{steps.read.output.order.date | default:\"(see note)\"}} — {{matter.shortName}}", description: "Directions requiring compliance (as stated in the order; compute any period yourself and confirm limitation):\n{{steps.read.output.compliance | json}}\n\n{{steps.save.output.href}}", assigneeId: "{{user.id}}", priority: "high", dueRule: "+1bd", matterId: "{{inputs.matter}}", tags: ["order", "compliance"] }),
    ],
    edges: [E("start", "read"), E("read", "review"), E("review", "save", "approved"), E("save", "dated"), E("dated", "event", "yes"), E("save", "task")],
  },

  // 9 ───────────────────────── Hearing brief (orders + authority + verification) ─────────────────────────
  {
    id: I.hearingBrief,
    name: "Hearing brief",
    description: "Before a hearing, read the matter's latest published orders and the listing, research the points of law with a citator check, draft a hearing brief for counsel and verify every statement against the orders and authorities read; filed after a trust review.",
    category: "drafting",
    tags: ["hearing", "brief", "orders", "citator", "official sources", "India"],
    inputs: [
      MATTER,
      FORUM,
      CASE_NO,
      { key: "hearing_date", label: "Hearing date", type: "date", required: true },
      { key: "purpose", label: "Stage / purpose", type: "select", required: true, options: PURPOSES },
      { key: "issues", label: "Points to cover", type: "textarea", placeholder: "Maintainability of the appeal; limitation; interim stay" },
    ],
    nodes: [
      N("start", "trigger.manual", "Run before the hearing"),
      N("orders", "ai.agent", "Orders and listing", {
        agent: "analyst", tools: ["search_official_sources", "read_official_document", "causelist_lookup"], output: "text", modelTier: "primary", maxSteps: 10,
        brief: "For {{matter.name}} ({{inputs.case_number}} before {{inputs.forum}}): (1) confirm the listing for {{inputs.hearing_date}} with causelist_lookup (date {{inputs.hearing_date}}, the case number as printed) and report it exactly as returned, or that no entry was found in the loaded lists; (2) find the latest orders in this case number with search_official_sources and read them with read_official_document. Write: Listing; Procedural history (date — what the order directed — verbatim quote with page and src:// source); Directions pending compliance. Use only orders of this case number; flag OCR text for checking against the PDF.",
        context: "Matter: {{matter.name}} ({{matter.caption | default:matter.shortName}}); stage: {{inputs.purpose}}.",
      }),
      N("law", "ai.agent", "Points of law", {
        agent: "research", tools: [], output: "text", modelTier: "primary", maxSteps: 14,
        brief: "Points of law for the hearing of {{matter.name}} on {{inputs.hearing_date}} ({{inputs.purpose}}): {{inputs.issues | default:\"the issues arising from the orders below\"}}. Find the controlling authority for the forum and read it; run citator_check on each judgment you rely on and report any negative signal as a cue to review (never as settled treatment); find the strongest adverse authority. Deliver: points to urge (each with neutral citation and page), adverse authority and the answer to it, open questions.",
        context: "Orders and listing:\n{{steps.orders.output.text | truncate:24000}}",
      }),
      N("brief", "ai.draft", "Draft hearing brief", {
        kind: "memo", tone: "neutral", audience: "partner", modelTier: "primary", research: NO_RESEARCH,
        brief: "Draft a hearing brief for counsel in {{matter.name}} ({{inputs.case_number}}), listed on {{inputs.hearing_date | date:long}} for {{inputs.purpose}}. Sections: Listing and posture; Procedural history (from the orders, with page cites); Points to urge (each tied to an order or an authority, with page); Adverse authority and answers; Directions pending compliance; Orders to seek. Use only the material below; keep every citation, src:// source and page exactly; mark anything not established by it [VERIFY].",
        context: "ORDERS AND LISTING:\n{{steps.orders.output.text}}\n\nPOINTS OF LAW:\n{{steps.law.output.text}}",
      }),
      N("verify", "ai.verify", "Verify against orders and authority", { output: "{{steps.brief.output.text}}", sources: "Orders and listing:\n{{steps.orders.output.text}}\n\nPoints of law:\n{{steps.law.output.text}}", stepId: "brief", mode: "claims", modelTier: "fast" }),
      N("review", "logic.review", "Trust review", { steps: "orders, law, brief, verify", approverId: "{{user.id}}", title: "Hearing brief needs a look", message: "Some statements in the hearing brief did not verify against the orders or the authority read. Approve to file it, or reject to stop." }),
      N("save", "output.file", "Save hearing brief", OUT("docx", { content: "{{steps.brief.output.text}}", tags: ["hearing", "brief"] })),
      N("task", "action.create_task", "Prepare for hearing", { title: "Hearing brief ready: {{matter.shortName}} — {{inputs.hearing_date | date:short}}", description: "Read the brief, check every [VERIFY] mark against the order or authority, and carry certified copies of the orders relied on.\n\n{{steps.save.output.href}}", assigneeId: "{{user.id}}", priority: "high", dueRule: "+1bd", matterId: "{{inputs.matter}}", tags: ["hearing"] }),
    ],
    edges: [E("start", "orders"), E("orders", "law"), E("law", "brief"), E("brief", "verify"), E("verify", "review"), E("review", "save", "approved"), E("save", "task")],
  },
];

const F = {
  matter: (): WorkflowFrontend["fields"][number] => ({ key: "matter", label: "Matter", type: "matter", required: true, help: "Sets the run's matter; documents are filed under it." }),
};

export const INDIA_TEMPLATE_FRONTENDS: Record<string, WorkflowFrontend> = {
  [I.limitation]: {
    title: "Check limitation",
    intro: "Describe the claim and its dates. The Article, starting point, acknowledgements and exclusions are identified, checked against the Act and filed as a note; the last date is confirmed by an advocate.",
    fields: [F.matter(), { key: "relief", label: "Proceeding", type: "select", required: true, options: ["Suit for money (recovery)", "Suit on a contract", "Specific performance", "Declaration / injunction", "Possession of immovable property", "Appeal / revision", "Application in a pending proceeding"] }, { key: "facts", label: "Facts and dates", type: "textarea", required: true, placeholder: "Invoices, due dates, payments, acknowledgements, notices" }, { key: "accrual_date", label: "Right to sue accrued on", type: "date" }],
    submitLabel: "Check limitation",
    output: { formats: ["docx", "pdf", "md"], defaultFormat: "docx", defaultLabel: "Limitation note — {{now | date:short}}" },
  },
  [I.hearingPrep]: {
    title: "Prepare for a hearing",
    intro: "Pulls the record for the stage, drafts a hearing note tied to exhibits and testimony, calendars the hearing and opens the preparation task.",
    fields: [F.matter(), { key: "hearing_date", label: "Hearing date", type: "date", required: true }, { key: "purpose", label: "Stage / purpose", type: "select", required: true, options: ["Admission", "Arguments on interlocutory application", "Cross-examination of witness", "Framing of issues", "Final arguments", "Bail hearing", "Orders / pronouncement"] }, { key: "focus", label: "Points to cover", type: "textarea" }],
    submitLabel: "Build the hearing note",
    output: { formats: ["docx", "pdf", "md"], defaultFormat: "docx", defaultLabel: "Hearing note — {{inputs.hearing_date}}" },
  },
  [I.causeList]: {
    title: "Watch the cause list",
    intro: "Runs every evening on its schedule. Reads the public cause list page you give it and posts the item numbers of your cases; pages that need a captcha are not automated.",
    fields: [F.matter(), { key: "cause_list_url", label: "Cause list page", type: "text", required: true, help: "Public page or PDF published by the court." }, { key: "case_numbers", label: "Case numbers", type: "textarea", required: true, placeholder: "One per line, e.g. W.P. No. 18234 of 2024" }],
    submitLabel: "Check now",
  },
  [I.bailPack]: {
    title: "Build a bail pack",
    intro: "Upload the FIR and remand papers. The crime particulars are extracted as written, the governing code is decided by the offence date, and the bail application is drafted for advocate review.",
    fields: [F.matter(), { key: "fir_text", label: "FIR / remand papers", type: "file", required: true, accept: DOC_ACCEPT }, { key: "offence_date", label: "Date of offence", type: "date", required: true, help: "Offences before 1 July 2024 are under the IPC; on or after, the BNS." }, { key: "kind", label: "Application", type: "select", required: true, options: ["Regular bail", "Anticipatory bail"], default: "Regular bail" }, { key: "forum", label: "Before", type: "select", required: true, options: ["Sessions Court", "High Court"], default: "Sessions Court" }, { key: "accused", label: "Accused", type: "text", required: true }],
    submitLabel: "Build the bail pack",
    output: { formats: ["docx", "pdf"], defaultFormat: "docx", defaultLabel: "Bail application — {{inputs.accused}}" },
  },
  [I.chequePack]: {
    title: "Cheque dishonour (s.138)",
    intro: "Enter the cheque and dishonour dates. The statutory dates are counted, the demand notice and complaint are drafted, and the notice deadline goes on the calendar.",
    fields: [F.matter(), { key: "drawer", label: "Drawer", type: "text", required: true }, { key: "cheque", label: "Cheque details", type: "text", required: true }, { key: "debt", label: "Underlying debt", type: "textarea", required: true }, { key: "return_memo_date", label: "Return memo date", type: "date", required: true }, { key: "info_date", label: "Information of dishonour received on", type: "date", required: true }, { key: "notice_served_date", label: "Notice served on", type: "date" }, { key: "collecting_branch", label: "Payee's bank branch", type: "text", required: true }],
    submitLabel: "Build the s.138 pack",
    output: { formats: ["docx", "pdf"], defaultFormat: "docx", defaultLabel: "s.138 notice and complaint — {{now | date:short}}" },
  },
  [I.dailyCauseList]: {
    title: "Check the cause lists daily",
    intro: "Runs every evening on its schedule. Looks the matter up in the cause lists published by the court and loaded into the official sources (exact case-number match), posts the result and opens an attendance task when it is listed.",
    fields: [F.matter(), { key: "forum", label: "Court / tribunal", type: "text", required: true, help: "sci, hc-delhi, nclt-mumbai, nclat" }, { key: "case_number", label: "Case number", type: "text", required: true, placeholder: "SLP(C) No. 1234/2026" }, { key: "diary_no", label: "Diary number (Supreme Court)", type: "text" }],
    submitLabel: "Check now",
  },
  [I.orderActions]: {
    title: "Turn a new order into action items",
    intro: "Reads the latest published order in the case, extracts the directions, the next date and the compliance it requires with page-cited quotes, and — after your review — files the note, calendars the next date and opens the compliance task.",
    fields: [F.matter(), { key: "forum", label: "Court / tribunal", type: "text", required: true }, { key: "case_number", label: "Case number", type: "text", required: true }, { key: "order_ref", label: "Specific order (optional)", type: "text", help: "A src:// reference from the official sources; leave empty for the latest order." }],
    submitLabel: "Read the order",
    output: { formats: ["docx", "pdf", "md"], defaultFormat: "docx", defaultLabel: "Order action items — {{now | date:short}}" },
  },
  [I.hearingBrief]: {
    title: "Build a hearing brief",
    intro: "Reads the latest orders and the listing, researches the points of law with a citator check, drafts the brief for counsel and verifies it against what was read.",
    fields: [F.matter(), { key: "forum", label: "Court / tribunal", type: "text", required: true }, { key: "case_number", label: "Case number", type: "text", required: true }, { key: "hearing_date", label: "Hearing date", type: "date", required: true }, { key: "purpose", label: "Stage / purpose", type: "select", required: true, options: PURPOSES }, { key: "issues", label: "Points to cover", type: "textarea" }],
    submitLabel: "Build the hearing brief",
    output: { formats: ["docx", "pdf", "md"], defaultFormat: "docx", defaultLabel: "Hearing brief — {{inputs.hearing_date}}" },
  },
  [I.judgmentDigest]: {
    title: "Digest a judgment",
    intro: "Upload a judgment. The digest cites paragraph numbers and is verified against the text; the client version in Kannada or Telugu is labelled as a machine translation.",
    fields: [F.matter(), { key: "judgment_text", label: "Judgment", type: "file", required: true, accept: DOC_ACCEPT }, { key: "language", label: "Client language", type: "select", required: true, options: ["Kannada", "Telugu"], default: "Kannada" }],
    submitLabel: "Digest the judgment",
    output: { formats: ["docx", "pdf", "md"], defaultFormat: "docx", defaultLabel: "Judgment digest — {{now | date:short}}" },
  },
};
