/**
 * Node catalog for the workflow builder and engine. Client-safe (no server
 * imports). Every WorkflowNodeType has a category, a description, a default
 * config, typed config fields for the side panel, named output handles and a
 * sketch of the output it produces (used by the variable picker).
 */
import type { WorkflowNodeType } from "@/lib/types/domain";

/**
 * Node types added by the AI-integrity layer (verification, deduplication and
 * trust review). They are registered here and executed by the engine; the
 * shared `WorkflowNodeType` union in lib/types/domain.ts lists the original
 * types, so `AnyNodeType` is the full catalogue until that union is extended.
 */
export type IntegrityNodeType = "ai.verify" | "data.dedupe" | "logic.review";
export type AnyNodeType = WorkflowNodeType | IntegrityNodeType;

export type NodeCategory = "trigger" | "ai" | "data" | "intel" | "logic" | "action";

export const CATEGORY_META: Record<NodeCategory, { label: string; plural: string; description: string; tone: string }> = {
  trigger: { label: "Trigger", plural: "Triggers", description: "How a run starts", tone: "success" },
  ai: { label: "AI", plural: "AI", description: "Model steps: extract, classify, draft, review, research, route, agents", tone: "primary" },
  data: { label: "Data", plural: "Data", description: "Search the library, e-discovery, courts, regulators, the web and the intelligence store", tone: "info" },
  intel: { label: "Intelligence", plural: "Intelligence", description: "Fetch, extract, index, link, analyze, verify and publish authoritative data", tone: "chart-2" },
  logic: { label: "Logic", plural: "Logic", description: "Branch, loop, merge, approvals, delays, the steward and follow-on runs", tone: "warning" },
  action: { label: "Action", plural: "Actions", description: "Create tasks, events, documents, files, notifications and exports", tone: "chart-5" },
};

/** Field editors available to node specs (rendered by components/builder/fields.tsx). */
export type FieldType = "text" | "template" | "textarea" | "number" | "toggle" | "select" | "multiselect" | "person" | "matter" | "tags" | "json" | "fields" | "labels" | "conditions" | "checklist" | "kv" | "schedule" | "folder" | "workflow" | "routes" | "agent";

export interface SelectOption { value: string; label: string; hint?: string }

export interface FieldSpec {
  key: string;
  label: string;
  type: FieldType;
  help?: string;
  placeholder?: string;
  options?: SelectOption[];
  required?: boolean;
  rows?: number;
  min?: number;
  max?: number;
  /** Only show when another config key has one of these values. */
  showWhen?: { key: string; equals?: unknown; in?: unknown[]; truthy?: boolean };
  group?: string;
  /** For `json`: pretty-print / validate as JSON. */
  mono?: boolean;
}

export interface HandleSpec { id: string; label: string; hint?: string }

export interface NodeTypeSpec {
  type: WorkflowNodeType;
  category: NodeCategory;
  label: string;
  short: string;
  description: string;
  icon: string; // lucide icon name (resolved in the UI)
  keywords: string[];
  defaultConfig: Record<string, unknown>;
  fields: FieldSpec[];
  /** Named source handles (multi-output nodes). Single-output nodes omit this. */
  outputs?: HandleSpec[];
  /** Named target handles; default is a single "in". */
  inputs?: HandleSpec[];
  /** Human sketch of the step output, e.g. "{ text }" — used by the variable picker. */
  outputShape: string;
  /** Output paths suggested by the variable picker. */
  outputPaths: string[];
  /** Whether the node calls the model (requires an OpenAI key). */
  usesAI?: boolean;
  /** Whether the node calls external networks (courts, regulators, web). */
  usesNetwork?: boolean;
}

const MODEL_TIER: FieldSpec = { key: "modelTier", label: "Model", type: "select", options: [{ value: "primary", label: "Primary (deep reasoning)" }, { value: "fast", label: "Fast (quick, cheaper)" }], group: "Model" };
const RETRIES: FieldSpec = { key: "retries", label: "Retries on failure", type: "number", min: 0, max: 3, group: "Model", help: "Model and network errors are retried with backoff; missing API key is never retried." };
const TIMEOUT: FieldSpec = { key: "timeoutSec", label: "Timeout (seconds)", type: "number", min: 10, max: 900, group: "Model" };
const RESEARCH_FIELDS: FieldSpec[] = [
  { key: "research.web", label: "Web search", type: "toggle", group: "Research", help: "OpenAI web search plus fetch_url." },
  { key: "research.legal", label: "Legal sources", type: "toggle", group: "Research", help: "CourtListener, eCFR, Federal Register, GovInfo." },
  { key: "research.internal", label: "Firm knowledge", type: "toggle", group: "Research", help: "Library, e-discovery, matter context." },
];
/** Steps that may fail without failing the run; a downstream `review.auto` (steward) step can then fix or escalate them. */
const ON_ERROR: FieldSpec = { key: "onError", label: "On failure", type: "select", options: [{ value: "fail", label: "Fail the run" }, { value: "continue", label: "Continue — let the steward fix or escalate" }], group: "Reliability", help: "With Continue, the step is marked failed, the run goes on and a Steward step can re-run it with an allow-listed fix." };
const DOC_IDS: FieldSpec = { key: "docIds", label: "Document ids", type: "template", rows: 2, help: "An array of intelligence document ids (e.g. {{steps.fetch.output.docIds}}), or a comma-separated list." };

/** Document kinds in the intelligence store (options for scope filters). */
export const INTEL_KIND_OPTIONS: SelectOption[] = ["opinion", "docket", "docket_entry", "court_rule", "regulation", "register_notice", "recall", "adverse_event", "mdl", "judge", "attorney", "firm", "news", "local_file", "web_page", "statute", "expert"].map((k) => ({ value: k, label: k.replace(/_/g, " ") }));
export const INTEL_ADAPTER_OPTIONS: SelectOption[] = [
  { value: "", label: "Use a configured source" },
  { value: "courtlistener-opinions", label: "CourtListener opinions" }, { value: "courtlistener-dockets", label: "CourtListener dockets" }, { value: "courtlistener-judges", label: "CourtListener judges" },
  { value: "ecfr", label: "eCFR" }, { value: "federal-register", label: "Federal Register" }, { value: "govinfo", label: "GovInfo" }, { value: "openfda-recalls", label: "openFDA recalls and labels" },
  { value: "jpml-mdls", label: "JPML MDL list" }, { value: "court-rules", label: "Court rules (URL list)" }, { value: "news", label: "News" }, { value: "local-corpus", label: "Local document folders" }, { value: "web-list", label: "Watched web pages" },
];
export const AGENT_OPTIONS: SelectOption[] = [
  { value: "research", label: "Research", hint: "authority with citations" }, { value: "drafter", label: "Drafter", hint: "documents from a brief" }, { value: "reviewer", label: "Reviewer", hint: "claim / cite QA" },
  { value: "coder", label: "Coder", hint: "coding suggestions" }, { value: "analyst", label: "Analyst", hint: "trends, profiles, chronologies" }, { value: "steward", label: "Steward", hint: "diagnose and fix" }, { value: "coordinator", label: "Coordinator", hint: "routes and hands off" },
];
export const AGENT_TOOL_OPTIONS: SelectOption[] = ["search_case_law", "get_opinion_text", "search_dockets", "get_docket_entries", "verify_citations", "search_cfr", "get_cfr_section", "search_federal_register", "get_federal_register_document", "search_statutes", "search_library", "get_library_item", "search_ediscovery", "get_ediscovery_document", "get_matter_context", "fetch_url", "web_search", "search_intel"].map((t) => ({ value: t, label: t.replace(/_/g, " ") }));
export const DATA_QUERY_SOURCES: SelectOption[] = [
  { value: "intel_documents", label: "Intelligence documents", hint: "opinions, dockets, rules, regulations, recalls, news, files" },
  { value: "intel_entities", label: "Intelligence entities", hint: "judges, counsel, firms, MDLs, products, agencies" },
  { value: "intel_insights", label: "Insights", hint: "trends, chronologies, profiles, alerts" },
  { value: "intel_jobs", label: "Intelligence jobs", hint: "background runs and their status" },
  { value: "ediscovery", label: "E-discovery documents", hint: "Bates, custodian, coding" },
  { value: "library", label: "Library items" },
  { value: "tasks", label: "Tasks" },
  { value: "events", label: "Calendar events" },
  { value: "matters", label: "Matters" },
  { value: "people", label: "People" },
];

export const NODE_TYPES: NodeTypeSpec[] = [
  // ───────────────────────── Triggers ─────────────────────────
  {
    type: "trigger.manual", category: "trigger", label: "Manual trigger", short: "Manual", icon: "Play",
    description: "Start the workflow from the Run button with a form generated from the workflow inputs.",
    keywords: ["start", "form", "inputs", "button"],
    defaultConfig: { note: "" },
    fields: [{ key: "note", label: "Instructions for the person running it", type: "textarea", rows: 3, placeholder: "Paste the NDA text or upload the .docx, then pick the matter." }],
    outputShape: "{ inputs, startedAt, triggeredBy }", outputPaths: ["output.startedAt", "output.triggeredBy"],
  },
  {
    type: "trigger.schedule", category: "trigger", label: "Schedule", short: "Schedule", icon: "CalendarClock",
    description: "Run automatically on a schedule (hourly, daily, weekly or monthly at a set time). The in-process scheduler checks every minute.",
    keywords: ["cron", "daily", "weekly", "monthly", "timer", "recurring"],
    defaultConfig: { schedule: { frequency: "weekly", time: "06:00", weekday: 1, dayOfMonth: 1 }, enabled: true, presetInputs: {} },
    fields: [
      { key: "schedule", label: "Schedule", type: "schedule", required: true },
      { key: "enabled", label: "Enabled", type: "toggle", help: "Only active workflows with an enabled schedule are fired by the scheduler." },
      { key: "presetInputs", label: "Preset inputs", type: "kv", help: "Values used for the workflow inputs on scheduled runs." },
    ],
    outputShape: "{ scheduledFor, frequency }", outputPaths: ["output.scheduledFor", "output.frequency"],
  },
  {
    type: "trigger.document_added", category: "trigger", label: "Document added", short: "Doc added", icon: "FilePlus2",
    description: "Fires when a document is added to a matter folder in the library or office (delivered through POST /api/workflows/events).",
    keywords: ["upload", "library", "office", "event", "file"],
    defaultConfig: { matterId: "", kinds: ["docx", "pdf"], folderName: "" },
    fields: [
      { key: "matterId", label: "Matter filter", type: "matter", help: "Leave empty to match any matter." },
      { key: "kinds", label: "Document kinds", type: "multiselect", options: [{ value: "docx", label: "Word" }, { value: "pdf", label: "PDF" }, { value: "xlsx", label: "Workbook" }, { value: "pptx", label: "Deck" }, { value: "note", label: "Note" }] },
      { key: "folderName", label: "Folder name contains", type: "text", placeholder: "Incoming" },
    ],
    outputShape: "{ documentId, title, kind, matterId, text }", outputPaths: ["output.documentId", "output.title", "output.kind", "output.text"],
  },
  {
    type: "trigger.docket_update", category: "trigger", label: "Docket update", short: "Docket", icon: "Gavel",
    description: "Fires when a monitored docket receives a new entry (from the docket monitor or an inbound event).",
    keywords: ["pacer", "court", "filing", "ecf", "alert"],
    defaultConfig: { matterId: "", docketQuery: "", courts: "" },
    fields: [
      { key: "matterId", label: "Matter", type: "matter" },
      { key: "docketQuery", label: "Docket search", type: "text", placeholder: "Party name or case caption" },
      { key: "courts", label: "Courts (CourtListener ids)", type: "text", placeholder: "dsc ilnd" },
    ],
    outputShape: "{ entries[], docket, caseName }", outputPaths: ["output.entries", "output.caseName", "output.docket"],
  },
  {
    type: "trigger.email", category: "trigger", label: "Inbound email", short: "Email", icon: "Mail",
    description: "Fires when a message arrives at the workflow inbox address (delivered through POST /api/workflows/events).",
    keywords: ["inbox", "message", "mail", "intake"],
    defaultConfig: { address: "", subjectContains: "" },
    fields: [
      { key: "address", label: "Inbox address", type: "text" },
      { key: "subjectContains", label: "Subject contains", type: "text", placeholder: "NDA" },
    ],
    outputShape: "{ from, subject, body, attachments[] }", outputPaths: ["output.from", "output.subject", "output.body", "output.attachments"],
  },

  // ───────────────────────── AI ─────────────────────────
  {
    type: "ai.prompt", category: "ai", label: "AI prompt", short: "Prompt", icon: "MessageSquareText", usesAI: true,
    description: "General-purpose model step with your own instructions and a prompt template. Returns text or JSON that matches a schema; can research with web, legal and firm sources.",
    keywords: ["gpt", "llm", "generate", "ask", "completion", "json"],
    defaultConfig: { instructions: "You are a careful senior litigator.", prompt: "{{inputs.text}}", modelTier: "primary", output: "text", jsonSchema: "", research: { web: false, legal: false, internal: false }, retries: 1, timeoutSec: 180 },
    fields: [
      { key: "instructions", label: "Instructions (system)", type: "textarea", rows: 4, required: true },
      { key: "prompt", label: "Prompt", type: "template", rows: 6, required: true, help: "Use {{inputs.key}}, {{steps.nodeId.output.path}}, {{matter.name}}, {{loop.item}}." },
      { key: "output", label: "Output", type: "select", options: [{ value: "text", label: "Text" }, { value: "json", label: "JSON (schema)" }] },
      { key: "jsonSchema", label: "JSON schema", type: "json", rows: 8, showWhen: { key: "output", equals: "json" }, help: "A JSON Schema object. Optional properties become nullable in strict mode." },
      MODEL_TIER, ...RESEARCH_FIELDS, RETRIES, TIMEOUT,
    ],
    outputShape: "{ text } or the JSON object", outputPaths: ["output.text", "output"],
  },
  {
    type: "ai.extract", category: "ai", label: "Extract fields", short: "Extract", icon: "ScanSearch", usesAI: true,
    description: "Pull structured fields (parties, dates, amounts, clauses) out of a document into a typed object. Every field gets a name, type and description.",
    keywords: ["parse", "entities", "structured", "fields", "metadata", "parties", "dates"],
    defaultConfig: { source: "{{inputs.text}}", fields: [{ name: "parties", type: "string[]", description: "Full legal names of every party" }, { name: "effective_date", type: "date", description: "Effective date, ISO format" }], instructions: "", modelTier: "fast", retries: 1, timeoutSec: 120 },
    fields: [
      { key: "source", label: "Source text", type: "template", rows: 3, required: true },
      { key: "fields", label: "Fields to extract", type: "fields", required: true },
      { key: "instructions", label: "Extra guidance", type: "textarea", rows: 3, placeholder: "Quote the clause you relied on for each value." },
      MODEL_TIER, RETRIES, TIMEOUT,
    ],
    outputShape: "{ <field>: value, ..., _evidence }", outputPaths: ["output"],
  },
  {
    type: "ai.classify", category: "ai", label: "Classify", short: "Classify", icon: "Tags", usesAI: true,
    description: "Assign one (or several) labels with a confidence score and rationale. Pairs with Branch for routing.",
    keywords: ["label", "categorize", "triage", "risk", "route", "score"],
    defaultConfig: { source: "{{inputs.text}}", labels: [{ label: "low", description: "Standard terms, no concerns" }, { label: "medium", description: "Negotiable issues" }, { label: "high", description: "Unacceptable or unusual terms" }], multi: false, instructions: "", modelTier: "fast", retries: 1, timeoutSec: 90 },
    fields: [
      { key: "source", label: "Source text", type: "template", rows: 3, required: true },
      { key: "labels", label: "Labels", type: "labels", required: true },
      { key: "multi", label: "Allow multiple labels", type: "toggle" },
      { key: "instructions", label: "Extra guidance", type: "textarea", rows: 3 },
      MODEL_TIER, RETRIES, TIMEOUT,
    ],
    outputShape: "{ label, confidence, rationale, labels[] }", outputPaths: ["output.label", "output.confidence", "output.rationale", "output.labels"],
  },
  {
    type: "ai.summarize", category: "ai", label: "Summarize", short: "Summarize", icon: "AlignLeft", usesAI: true,
    description: "Condense long text (transcripts, productions, opinions) into a digest in the style you choose.",
    keywords: ["digest", "tl;dr", "condense", "abstract", "brief"],
    defaultConfig: { source: "{{inputs.text}}", style: "bullets", length: "medium", focus: "", modelTier: "primary", retries: 1, timeoutSec: 180 },
    fields: [
      { key: "source", label: "Source text", type: "template", rows: 3, required: true },
      { key: "style", label: "Style", type: "select", options: [{ value: "bullets", label: "Bullet points" }, { value: "paragraphs", label: "Narrative paragraphs" }, { value: "executive", label: "Executive summary" }, { value: "issues", label: "Issues list" }, { value: "qa", label: "Q&A digest (page:line)" }] },
      { key: "length", label: "Length", type: "select", options: [{ value: "short", label: "Short (≈150 words)" }, { value: "medium", label: "Medium (≈400 words)" }, { value: "long", label: "Long (≈900 words)" }] },
      { key: "focus", label: "Focus on", type: "text", placeholder: "admissions about the 2016 EHS memo" },
      MODEL_TIER, RETRIES, TIMEOUT,
    ],
    outputShape: "{ text }", outputPaths: ["output.text"],
  },
  {
    type: "ai.draft", category: "ai", label: "Draft document", short: "Draft", icon: "PenLine", usesAI: true,
    description: "Write a memo, letter, email, checklist, clause or report from a brief and context. Output is Markdown ready for Save document.",
    keywords: ["write", "memo", "letter", "email", "compose", "template", "clause"],
    defaultConfig: { kind: "memo", brief: "Draft an issues memo on the NDA summarized below.\n\nExtraction:\n{{steps.extract.output | json}}", context: "", tone: "formal", audience: "partner", research: { web: false, legal: false, internal: true }, modelTier: "primary", retries: 1, timeoutSec: 240 },
    fields: [
      { key: "kind", label: "Document kind", type: "select", options: [{ value: "memo", label: "Internal memo" }, { value: "letter", label: "Letter" }, { value: "email", label: "Email" }, { value: "checklist", label: "Checklist" }, { value: "clause", label: "Contract clause" }, { value: "brief_section", label: "Brief section" }, { value: "report", label: "Client report" }, { value: "chronology", label: "Chronology" }] },
      { key: "brief", label: "Drafting brief", type: "template", rows: 8, required: true },
      { key: "context", label: "Additional context", type: "template", rows: 4 },
      { key: "tone", label: "Tone", type: "select", options: [{ value: "formal", label: "Formal" }, { value: "plain", label: "Plain English" }, { value: "persuasive", label: "Persuasive" }, { value: "neutral", label: "Neutral / analytical" }] },
      { key: "audience", label: "Audience", type: "select", options: [{ value: "partner", label: "Supervising partner" }, { value: "client", label: "Client" }, { value: "opposing", label: "Opposing counsel" }, { value: "court", label: "Court" }, { value: "team", label: "Case team" }] },
      MODEL_TIER, ...RESEARCH_FIELDS, RETRIES, TIMEOUT,
    ],
    outputShape: "{ title, text (markdown), wordCount }", outputPaths: ["output.title", "output.text", "output.wordCount"],
  },
  {
    type: "ai.review", category: "ai", label: "Review against checklist", short: "Review", icon: "ClipboardCheck", usesAI: true,
    description: "Check a document against a checklist and return pass/fail findings with quotes, severity and a score.",
    keywords: ["qa", "audit", "checklist", "compliance", "findings", "issues"],
    defaultConfig: { source: "{{inputs.text}}", checklist: ["Governing law is Delaware or New York", "Term does not exceed 3 years", "No non-solicit"], instructions: "", modelTier: "primary", retries: 1, timeoutSec: 180 },
    fields: [
      { key: "source", label: "Document text", type: "template", rows: 3, required: true },
      { key: "checklist", label: "Checklist", type: "checklist", required: true },
      { key: "instructions", label: "Extra guidance", type: "textarea", rows: 3 },
      MODEL_TIER, RETRIES, TIMEOUT,
    ],
    outputShape: "{ findings[{item,status,severity,note,quote}], summary, score, failed }", outputPaths: ["output.findings", "output.summary", "output.score", "output.failed"],
  },
  {
    type: "ai.research", category: "ai", label: "Legal research", short: "Research", icon: "BookOpenCheck", usesAI: true, usesNetwork: true,
    description: "Agentic research with case law, statutes, regulations, dockets, web and firm knowledge. Returns a memo with citations.",
    keywords: ["case law", "authority", "courtlistener", "statute", "regulation", "memo", "question"],
    defaultConfig: { question: "{{inputs.question}}", jurisdiction: "", depth: "standard", sources: { web: true, legal: true, internal: true }, instructions: "", modelTier: "primary", retries: 1, timeoutSec: 480 },
    fields: [
      { key: "question", label: "Research question", type: "template", rows: 4, required: true },
      { key: "jurisdiction", label: "Jurisdiction", type: "select", options: [{ value: "", label: "Any" }, { value: "scotus", label: "Supreme Court" }, { value: "federal-appellate", label: "Federal appellate" }, { value: "4th-circuit", label: "Fourth Circuit + D.S.C." }, { value: "7th-circuit", label: "Seventh Circuit + N.D. Ill." }, { value: "9th-circuit", label: "Ninth Circuit + Cal. districts" }, { value: "11th-circuit", label: "Eleventh Circuit + N.D. Fla." }, { value: "california-state", label: "California state" }, { value: "new-york-state", label: "New York state" }, { value: "delaware", label: "Delaware" }, { value: "illinois-state", label: "Illinois state" }, { value: "texas-state", label: "Texas state" }] },
      { key: "depth", label: "Depth", type: "select", options: [{ value: "quick", label: "Quick (≤4 tool calls)" }, { value: "standard", label: "Standard" }, { value: "deep", label: "Deep (read primary sources)" }] },
      { key: "sources.web", label: "Web search", type: "toggle", group: "Sources" },
      { key: "sources.legal", label: "Courts & regulators", type: "toggle", group: "Sources" },
      { key: "sources.internal", label: "Firm knowledge", type: "toggle", group: "Sources" },
      { key: "instructions", label: "Extra guidance", type: "textarea", rows: 3 },
      MODEL_TIER, RETRIES, TIMEOUT,
    ],
    outputShape: "{ text (memo), citations[], toolCalls }", outputPaths: ["output.text", "output.citations", "output.toolCalls"],
  },

  {
    type: "ai.verify" as WorkflowNodeType, category: "ai", label: "Verify against sources", short: "Verify", icon: "ShieldCheck", usesAI: true,
    description: "Checks a prior step's output against its sources: every factual claim is graded supported / unsupported / contradicted, record cites (Bates, page:line) are cross-checked, and the result is written into the step's provenance. Downstream actions only act on trusted output.",
    keywords: ["verification", "hallucination", "citations", "provenance", "trust", "fact-check", "self-correct"],
    defaultConfig: { output: "{{steps.draft.output.text}}", sources: "{{steps.search.output.text}}", stepId: "draft", mode: "claims", maxClaims: 25, modelTier: "fast", retries: 1, timeoutSec: 180 },
    fields: [
      { key: "output", label: "Output to verify", type: "template", rows: 3, required: true, help: "Text or JSON produced by an earlier AI step." },
      { key: "sources", label: "Sources", type: "template", rows: 3, required: true, help: "Evidence text, or an array of search results / documents ({ bates, passage, text… })." },
      { key: "stepId", label: "Step being verified", type: "text", help: "Node id of the AI step; its provenance is updated with the verdict so later actions can trust it." },
      { key: "mode", label: "Mode", type: "select", options: [{ value: "claims", label: "Claims (narrative text)" }, { value: "structured", label: "Structured (self-correct JSON rows)" }] },
      { key: "maxClaims", label: "Max claims", type: "number", min: 5, max: 60 },
      MODEL_TIER, RETRIES, TIMEOUT,
    ],
    outputShape: "{ status, trusted, supported, unsupported, contradicted, score, unresolvedCites[], verdicts[], corrected, changes[], provenance }",
    outputPaths: ["output.status", "output.trusted", "output.score", "output.contradicted", "output.unresolvedCites", "output.corrected", "output.changes"],
  },

  // ───────────────────────── Data ─────────────────────────
  {
    type: "data.search_library", category: "data", label: "Search library", short: "Library", icon: "Library",
    description: "Hybrid (semantic + keyword) search over the firm library: templates, precedents, clause bank, notes and matter folders.",
    keywords: ["precedent", "clause", "template", "knowledge", "folder"],
    defaultConfig: { query: "{{inputs.query}}", matterId: "", type: "", limit: 8, includeContent: false },
    fields: [
      { key: "query", label: "Query", type: "template", rows: 2, required: true },
      { key: "matterId", label: "Matter", type: "matter" },
      { key: "type", label: "Item type", type: "select", options: [{ value: "", label: "Any" }, { value: "clause", label: "Clause" }, { value: "template", label: "Template" }, { value: "note", label: "Note" }, { value: "docx", label: "Word document" }, { value: "xlsx", label: "Workbook" }, { value: "pdf", label: "PDF" }] },
      { key: "limit", label: "Max results", type: "number", min: 1, max: 25 },
      { key: "includeContent", label: "Include full content", type: "toggle", help: "Reads each hit in full (slower, larger outputs)." },
    ],
    outputShape: "{ count, results[{id,name,type,passage,score}], text }", outputPaths: ["output.count", "output.results", "output.text"],
  },
  {
    type: "data.search_ediscovery", category: "data", label: "Search e-discovery", short: "E-discovery", icon: "FileSearch",
    description: "Search the matter's document set with custodian, type, date, privilege and hot filters. Returns Bates numbers and passages.",
    keywords: ["documents", "bates", "custodian", "privilege", "hot", "production", "review"],
    defaultConfig: { query: "{{inputs.query}}", matterId: "{{matter.id}}", custodian: "", docType: "", dateAfter: "", dateBefore: "", privilegedOnly: false, hotOnly: false, responsiveOnly: false, limit: 10 },
    fields: [
      { key: "query", label: "Query", type: "template", rows: 2, required: true },
      { key: "matterId", label: "Matter", type: "matter" },
      { key: "custodian", label: "Custodian contains", type: "text" },
      { key: "docType", label: "Document type", type: "select", options: [{ value: "", label: "Any" }, ...["Email", "Memo", "Report", "Presentation", "Spreadsheet", "Letter", "Contract", "Chat", "Transcript"].map((t) => ({ value: t, label: t }))] },
      { key: "dateAfter", label: "Date after", type: "text", placeholder: "2016-01-01" },
      { key: "dateBefore", label: "Date before", type: "text", placeholder: "2017-12-31" },
      { key: "privilegedOnly", label: "Privileged only", type: "toggle" },
      { key: "hotOnly", label: "Hot documents only", type: "toggle" },
      { key: "responsiveOnly", label: "Responsive only", type: "toggle" },
      { key: "limit", label: "Max results", type: "number", min: 1, max: 50 },
    ],
    outputShape: "{ count, results[{id,bates,date,custodian,type,subject,passage,coding}], text }", outputPaths: ["output.count", "output.results", "output.text"],
  },
  {
    type: "data.legal_search", category: "data", label: "Legal search", short: "Legal", icon: "Scale", usesNetwork: true,
    description: "Query public legal sources: case law and dockets (CourtListener), eCFR, Federal Register, GovInfo statutes, or verify citations in a text.",
    keywords: ["courtlistener", "case law", "docket", "cfr", "federal register", "statute", "citations", "ecfr"],
    defaultConfig: { source: "case_law", query: "{{inputs.query}}", jurisdiction: "", courts: "", after: "", agency: "", documentType: "", limit: 10, text: "" },
    fields: [
      { key: "source", label: "Source", type: "select", required: true, options: [{ value: "case_law", label: "Case law (opinions)" }, { value: "dockets", label: "Dockets (PACER/RECAP)" }, { value: "docket_entries", label: "Docket entries (by docket id)" }, { value: "cfr", label: "Regulations (eCFR)" }, { value: "federal_register", label: "Federal Register" }, { value: "statutes", label: "Statutes (GovInfo)" }, { value: "verify_citations", label: "Verify citations in text" }] },
      { key: "query", label: "Query", type: "template", rows: 2, showWhen: { key: "source", in: ["case_law", "dockets", "cfr", "federal_register", "statutes"] } },
      { key: "docketId", label: "Docket id", type: "template", showWhen: { key: "source", equals: "docket_entries" } },
      { key: "text", label: "Text to check", type: "template", rows: 4, showWhen: { key: "source", equals: "verify_citations" } },
      { key: "jurisdiction", label: "Jurisdiction", type: "select", showWhen: { key: "source", equals: "case_law" }, options: [{ value: "", label: "All courts" }, { value: "scotus", label: "Supreme Court" }, { value: "federal-appellate", label: "Federal appellate" }, { value: "4th-circuit", label: "Fourth Circuit + D.S.C." }, { value: "7th-circuit", label: "Seventh Circuit + N.D. Ill." }, { value: "9th-circuit", label: "Ninth Circuit" }, { value: "11th-circuit", label: "Eleventh Circuit" }, { value: "california-state", label: "California state" }, { value: "new-york-state", label: "New York state" }, { value: "delaware", label: "Delaware" }, { value: "illinois-state", label: "Illinois state" }] },
      { key: "courts", label: "Court ids", type: "text", placeholder: "dsc ilnd", showWhen: { key: "source", in: ["case_law", "dockets"] } },
      { key: "after", label: "Filed / published after", type: "text", placeholder: "-7d or 2026-09-01", showWhen: { key: "source", in: ["case_law", "dockets", "federal_register"] }, help: "Relative values like -7d, -2w, -1m are resolved at run time." },
      { key: "agency", label: "Agency slug", type: "text", placeholder: "environmental-protection-agency", showWhen: { key: "source", equals: "federal_register" } },
      { key: "documentType", label: "Document type", type: "select", showWhen: { key: "source", equals: "federal_register" }, options: [{ value: "", label: "Any" }, { value: "RULE", label: "Final rule" }, { value: "PRORULE", label: "Proposed rule" }, { value: "NOTICE", label: "Notice" }, { value: "PRESDOCU", label: "Presidential document" }] },
      { key: "limit", label: "Max results", type: "number", min: 1, max: 20 },
    ],
    outputShape: "{ total, results[], text }", outputPaths: ["output.total", "output.results", "output.text", "output.citations"],
  },
  {
    type: "data.fetch_url", category: "data", label: "Fetch URL", short: "Fetch", icon: "Globe", usesNetwork: true,
    description: "Download a public web page or JSON endpoint and return readable text.",
    keywords: ["http", "web", "page", "scrape", "download"],
    defaultConfig: { url: "{{inputs.url}}", maxChars: 30000 },
    fields: [
      { key: "url", label: "URL", type: "template", required: true, placeholder: "https://www.regulations.gov/…" },
      { key: "maxChars", label: "Max characters", type: "number", min: 1000, max: 200000 },
    ],
    outputShape: "{ url, title, text }", outputPaths: ["output.title", "output.text", "output.url"],
  },

  {
    type: "data.dedupe" as WorkflowNodeType, category: "data", label: "Deduplicate", short: "Dedupe", icon: "CopyMinus",
    description: "Drops items that already exist in a target collection (same content hash of the key fields, or a near-duplicate title on the same date) so a workflow never creates twins of timeline events, conflicts, tasks or documents.",
    keywords: ["duplicate", "unique", "hash", "merge", "twins", "idempotent"],
    defaultConfig: { items: "{{steps.events.output.events}}", collection: "timeline", keyFields: "date,event", matterId: "{{matter.id}}" },
    fields: [
      { key: "items", label: "Items", type: "template", rows: 2, required: true, help: "An array (objects or strings)." },
      { key: "collection", label: "Check against", type: "select", required: true, options: [{ value: "timeline", label: "Matter timeline events" }, { value: "conflicts", label: "Conflicts register" }, { value: "tasks", label: "Open tasks" }, { value: "edocs", label: "E-discovery documents" }, { value: "library", label: "Library items" }, { value: "self", label: "Only within the list" }] },
      { key: "keyFields", label: "Key fields", type: "text", placeholder: "date,event", help: "Comma-separated fields that identify an item; all fields when empty." },
      { key: "matterId", label: "Matter", type: "matter" },
    ],
    outputShape: "{ items[], kept, dropped, droppedItems[{ item, duplicateOf }], hashes[] }", outputPaths: ["output.items", "output.kept", "output.dropped", "output.droppedItems"],
  },

  // ───────────────────────── Logic ─────────────────────────
  {
    type: "logic.branch", category: "logic", label: "Branch", short: "Branch", icon: "GitBranch",
    description: "Route the run down different paths based on conditions over inputs and step outputs. Rules are evaluated in order; the first match wins, otherwise 'else'.",
    keywords: ["if", "condition", "switch", "route", "decision"],
    defaultConfig: { rules: [{ id: "yes", label: "High risk", logic: "all", conditions: [{ left: "{{steps.classify.output.label}}", op: "equals", right: "high" }] }], elseLabel: "Otherwise" },
    fields: [
      { key: "rules", label: "Rules", type: "conditions", required: true },
      { key: "elseLabel", label: "Else label", type: "text" },
    ],
    outputs: [{ id: "__dynamic__", label: "Rules + else" }],
    outputShape: "{ matched, label, evaluations[] }", outputPaths: ["output.matched", "output.label"],
  },
  {
    type: "logic.loop", category: "logic", label: "Loop", short: "Loop", icon: "Repeat",
    description: "Run the body once per item of an array (bounded to 50). Connect the body to the 'each' handle and the continuation to 'done'. Inside the body use {{loop.item}} and {{loop.index}}.",
    keywords: ["for each", "iterate", "map", "items", "repeat"],
    defaultConfig: { over: "{{steps.search.output.results}}", maxIterations: 50, itemLabel: "item", stopOnError: false },
    fields: [
      { key: "over", label: "Array to iterate", type: "template", required: true, help: "An expression that resolves to an array." },
      { key: "maxIterations", label: "Max iterations", type: "number", min: 1, max: 50 },
      { key: "itemLabel", label: "Item label", type: "text", help: "Used in logs: 'entry 3 of 12'." },
      { key: "stopOnError", label: "Stop on first error", type: "toggle" },
    ],
    outputs: [{ id: "each", label: "Each item", hint: "Body executed per item" }, { id: "done", label: "Done", hint: "Runs after all items" }],
    inputs: [{ id: "in", label: "In" }, { id: "loop-back", label: "Loop back", hint: "Optional: connect the last body node here" }],
    outputShape: "{ count, results[{index,item,steps}], errors }", outputPaths: ["output.count", "output.results", "output.errors"],
  },
  {
    type: "logic.merge", category: "logic", label: "Merge", short: "Merge", icon: "GitMerge",
    description: "Wait for parallel branches to finish and continue with their combined outputs. Runs if at least one incoming branch succeeded.",
    keywords: ["join", "wait", "combine", "parallel", "gather"],
    defaultConfig: { mode: "all" },
    fields: [{ key: "mode", label: "Continue when", type: "select", options: [{ value: "all", label: "All incoming branches finished" }, { value: "any", label: "Any branch succeeded" }] }],
    outputShape: "{ branches: { nodeId: output }, succeeded[], skipped[] }", outputPaths: ["output.branches", "output.succeeded"],
  },
  {
    type: "logic.approval", category: "logic", label: "Approval", short: "Approval", icon: "UserCheck",
    description: "Pause the run until a person approves or rejects in the run panel. The approver sees your message with resolved variables.",
    keywords: ["review", "sign-off", "human", "gate", "pause", "partner"],
    defaultConfig: { approverId: "{{user.id}}", title: "Partner review", message: "Please review the draft memo before it is saved to the matter folder.\n\n{{steps.draft.output.text | truncate:1500}}", timeoutHours: 72 },
    fields: [
      { key: "approverId", label: "Approver", type: "person", required: true },
      { key: "title", label: "Title", type: "text", required: true },
      { key: "message", label: "Message to approver", type: "template", rows: 6, required: true },
      { key: "timeoutHours", label: "Escalate after (hours)", type: "number", min: 1, max: 720 },
    ],
    outputs: [{ id: "approved", label: "Approved" }, { id: "rejected", label: "Rejected" }],
    outputShape: "{ approved, comment, decidedBy, decidedAt }", outputPaths: ["output.approved", "output.comment", "output.decidedBy"],
  },
  {
    type: "logic.delay", category: "logic", label: "Delay", short: "Delay", icon: "Timer",
    description: "Wait before continuing. Long delays are capped by WORKFLOW_MAX_DELAY_MS (default 2 minutes) in this in-process engine.",
    keywords: ["wait", "sleep", "pause", "minutes"],
    defaultConfig: { minutes: 5 },
    fields: [{ key: "minutes", label: "Minutes", type: "number", min: 0, max: 10080, required: true }],
    outputShape: "{ waitedMs, requestedMs, capped }", outputPaths: ["output.waitedMs"],
  },

  {
    type: "logic.review" as WorkflowNodeType, category: "logic", label: "Trust review", short: "Review", icon: "ShieldAlert",
    description: "Gate on AI provenance: continues when every referenced AI step is trusted (source-backed, verified, above the confidence gate); otherwise pauses the run for a person with the reason (e.g. '3 extracted events failed verification'). Approving lets the run proceed; rejecting skips the gated path.",
    keywords: ["gate", "trust", "provenance", "human", "review", "confidence", "pause"],
    defaultConfig: { steps: "events, memo", approverId: "{{user.id}}", title: "Review AI output", message: "AI output needs a look before the workflow acts on it.", minConfidence: 0.6 },
    fields: [
      { key: "steps", label: "Steps to review", type: "text", required: true, help: "Comma-separated node ids of AI steps; the gate reads their provenance." },
      { key: "approverId", label: "Reviewer", type: "person" },
      { key: "title", label: "Title", type: "text" },
      { key: "message", label: "Message to reviewer", type: "template", rows: 4 },
      { key: "minConfidence", label: "Minimum confidence", type: "number", min: 0, max: 1, help: "0..1; defaults to the platform gate (0.6)." },
    ],
    outputs: [{ id: "approved", label: "Trusted / approved" }, { id: "rejected", label: "Rejected" }],
    outputShape: "{ trusted, approved, reasons[], steps[{ id, trusted, reason, confidence }], decidedBy, comment }", outputPaths: ["output.trusted", "output.approved", "output.reasons", "output.steps", "output.comment"],
  },

  // ───────────────────────── Actions ─────────────────────────
  {
    type: "action.create_task", category: "action", label: "Create task", short: "Task", icon: "ListTodo",
    description: "Create a task on the matter with assignee, priority, tags and a due-date rule (e.g. +3d, +2w, next-friday, a date, or a template).",
    keywords: ["todo", "assign", "deadline", "follow-up"],
    defaultConfig: { title: "Review: {{inputs.title}}", description: "{{steps.draft.output.text | truncate:800}}", assigneeId: "{{user.id}}", priority: "medium", dueRule: "+3d", tags: ["workflow"], matterId: "{{matter.id}}" },
    fields: [
      { key: "title", label: "Title", type: "template", required: true },
      { key: "description", label: "Description", type: "template", rows: 4 },
      { key: "assigneeId", label: "Assignee", type: "person" },
      { key: "priority", label: "Priority", type: "select", options: [{ value: "low", label: "Low" }, { value: "medium", label: "Medium" }, { value: "high", label: "High" }, { value: "urgent", label: "Urgent" }] },
      { key: "dueRule", label: "Due", type: "text", placeholder: "+3d · +2w · 2026-10-14 · {{steps.x.output.deadline}}", help: "Relative rules count calendar days (d), weeks (w) or business days (bd)." },
      { key: "matterId", label: "Matter", type: "matter" },
      { key: "tags", label: "Tags", type: "tags" },
    ],
    outputShape: "{ taskId, title, dueAt, href }", outputPaths: ["output.taskId", "output.title", "output.dueAt", "output.href"],
  },
  {
    type: "action.create_event", category: "action", label: "Create calendar event", short: "Event", icon: "CalendarPlus",
    description: "Add a deadline, hearing, deposition or meeting to the firm calendar.",
    keywords: ["calendar", "deadline", "hearing", "meeting", "deposition"],
    defaultConfig: { title: "{{inputs.title}}", kind: "deadline", startsAt: "+14d 09:00", durationMinutes: 60, location: "", notes: "", attendeeIds: ["{{user.id}}"], ruleSource: "", matterId: "{{matter.id}}" },
    fields: [
      { key: "title", label: "Title", type: "template", required: true },
      { key: "kind", label: "Kind", type: "select", options: ["deadline", "hearing", "deposition", "meeting", "filing", "internal", "cle", "other"].map((k) => ({ value: k, label: k[0].toUpperCase() + k.slice(1) })) },
      { key: "startsAt", label: "Starts", type: "text", placeholder: "+14d 09:00 · 2026-10-09T10:00 · {{steps.x.output.date}}", required: true },
      { key: "durationMinutes", label: "Duration (minutes)", type: "number", min: 0, max: 1440 },
      { key: "location", label: "Location", type: "template" },
      { key: "notes", label: "Notes", type: "template", rows: 3 },
      { key: "ruleSource", label: "Rule source", type: "text", placeholder: "FRCP 26(a)(2)(D)" },
      { key: "matterId", label: "Matter", type: "matter" },
    ],
    outputShape: "{ eventId, title, startsAt, href }", outputPaths: ["output.eventId", "output.startsAt", "output.href"],
  },
  {
    type: "action.save_document", category: "action", label: "Save document", short: "Save doc", icon: "FileOutput",
    description: "Create a Word document (from Markdown) or a workbook (from rows) in the office suite and file it in the library.",
    keywords: ["word", "docx", "workbook", "sheet", "xlsx", "memo", "file", "library"],
    defaultConfig: { kind: "word", title: "{{steps.draft.output.title}}", content: "{{steps.draft.output.text}}", rows: "", matterId: "{{matter.id}}", addToLibrary: true, tags: ["workflow"] },
    fields: [
      { key: "kind", label: "Kind", type: "select", options: [{ value: "word", label: "Word document" }, { value: "sheet", label: "Workbook" }] },
      { key: "title", label: "Title", type: "template", required: true },
      { key: "content", label: "Content (Markdown)", type: "template", rows: 6, showWhen: { key: "kind", equals: "word" } },
      { key: "rows", label: "Rows", type: "template", rows: 4, showWhen: { key: "kind", equals: "sheet" }, help: "An expression resolving to an array of objects (one row each), or CSV/Markdown-table text. The first sheet is built from it." },
      { key: "matterId", label: "Matter", type: "matter" },
      { key: "addToLibrary", label: "File in library", type: "toggle" },
      { key: "tags", label: "Tags", type: "tags" },
    ],
    outputShape: "{ docId, kind, title, href, libraryItemId }", outputPaths: ["output.docId", "output.title", "output.href"],
  },
  {
    type: "action.notify", category: "action", label: "Notify", short: "Notify", icon: "BellRing",
    description: "Post an in-app notification (team update on the home page) to people on the matter.",
    keywords: ["message", "alert", "team", "update", "slack"],
    defaultConfig: { channel: "in-app", recipientIds: ["{{user.id}}"], kind: "update", message: "Workflow finished: {{run.workflowName}}\n\n{{steps.summary.output.text | truncate:600}}", matterId: "{{matter.id}}" },
    fields: [
      { key: "channel", label: "Channel", type: "select", options: [{ value: "in-app", label: "In-app (team updates)" }] },
      { key: "recipientIds", label: "Recipients", type: "multiselect", options: [] },
      { key: "kind", label: "Kind", type: "select", options: [{ value: "update", label: "Update" }, { value: "announcement", label: "Announcement" }, { value: "win", label: "Win" }, { value: "question", label: "Question" }] },
      { key: "message", label: "Message", type: "template", rows: 5, required: true },
      { key: "matterId", label: "Matter", type: "matter" },
    ],
    outputShape: "{ notificationId, updateId, recipients }", outputPaths: ["output.notificationId", "output.updateId"],
  },
  {
    type: "action.export", category: "action", label: "Export file", short: "Export", icon: "Download",
    description: "Write step output to a downloadable file (Markdown, JSON, CSV, text) and link it from the library.",
    keywords: ["download", "csv", "json", "markdown", "file", "blob"],
    defaultConfig: { format: "markdown", filename: "{{run.workflowName}} — {{now | date:short}}", source: "{{steps.draft.output.text}}", addToLibrary: true, matterId: "{{matter.id}}" },
    fields: [
      { key: "format", label: "Format", type: "select", options: [{ value: "markdown", label: "Markdown (.md)" }, { value: "json", label: "JSON (.json)" }, { value: "csv", label: "CSV (.csv)" }, { value: "text", label: "Plain text (.txt)" }] },
      { key: "filename", label: "File name", type: "template", required: true },
      { key: "source", label: "Content", type: "template", rows: 4, required: true, help: "For CSV, resolve to an array of objects." },
      { key: "matterId", label: "Matter", type: "matter" },
      { key: "addToLibrary", label: "Link in library", type: "toggle" },
    ],
    outputShape: "{ blobId, url, size, filename, libraryItemId }", outputPaths: ["output.url", "output.filename", "output.size"],
  },
  {
    type: "action.update_coding", category: "action", label: "Update coding", short: "Coding", icon: "Stamp",
    description: "Apply a coding decision (responsive, privileged, hot, confidentiality, issue codes, notes) to e-discovery documents by id or Bates number.",
    keywords: ["review", "tag", "privilege", "responsive", "hot", "bates", "issue codes"],
    defaultConfig: { documents: "{{steps.search.output.results | pluck:id}}", field: "hot", value: "true", note: "Coded by workflow {{run.workflowName}}" },
    fields: [
      { key: "documents", label: "Documents", type: "template", rows: 2, required: true, help: "An array of ids/Bates numbers, or a comma-separated list." },
      { key: "field", label: "Field", type: "select", required: true, options: [{ value: "responsive", label: "Responsive" }, { value: "privileged", label: "Privileged" }, { value: "hot", label: "Hot" }, { value: "confidentiality", label: "Confidentiality" }, { value: "issues", label: "Issue codes (add)" }, { value: "notes", label: "Reviewer notes" }] },
      { key: "value", label: "Value", type: "template", required: true, help: "true/false, a confidentiality level, comma-separated issue codes, or note text." },
      { key: "note", label: "Audit note", type: "template" },
    ],
    outputShape: "{ updated, documentIds[], skipped[] }", outputPaths: ["output.updated", "output.documentIds"],
  },
  {
    type: "output.file", category: "action", label: "Output file", short: "Output", icon: "FileDown",
    description: "Turn Markdown or rows into a deliverable — Word, workbook, PDF, CSV, Markdown or slides — using the office generators, file it in the library (matter folder by default) and record it on the run with its provenance. The front end's format, label and folder choices arrive as inputs.output_format / output_label / output_folder.",
    keywords: ["docx", "xlsx", "pdf", "csv", "markdown", "pptx", "deliverable", "download", "library", "file"],
    defaultConfig: { format: "{{inputs.output_format | default:\"docx\"}}", label: "{{inputs.output_label | default:\"\"}}", content: "{{steps.draft.output.text}}", rows: "", libraryFolderId: "{{inputs.output_folder | default:\"\"}}", matterId: "{{matter.id}}", addToLibrary: true, tags: ["workflow"], onError: "fail" },
    fields: [
      { key: "format", label: "Format", type: "select", required: true, options: [{ value: "{{inputs.output_format | default:\"docx\"}}", label: "From the front end (inputs.output_format)" }, { value: "docx", label: "Word (.docx)" }, { value: "xlsx", label: "Workbook (.xlsx)" }, { value: "pdf", label: "PDF" }, { value: "csv", label: "CSV" }, { value: "md", label: "Markdown" }, { value: "pptx", label: "Slides (.pptx)" }] },
      { key: "label", label: "Label", type: "template", required: true, help: "File and library name. May itself contain {{ }} (front-end label templates are resolved at run time)." },
      { key: "content", label: "Content (Markdown)", type: "template", rows: 5, help: "Used for Word, PDF, Markdown and slides. A Markdown table is also accepted for workbooks." },
      { key: "rows", label: "Rows", type: "template", rows: 3, help: "For workbooks and CSV: an expression resolving to an array of objects, or CSV / Markdown-table text." },
      { key: "libraryFolderId", label: "Library folder", type: "folder", help: "Leave empty to file under the matter folder." },
      { key: "matterId", label: "Matter", type: "matter" },
      { key: "addToLibrary", label: "File in library", type: "toggle" },
      { key: "tags", label: "Tags", type: "tags" },
      ON_ERROR,
    ],
    outputShape: "{ format, label, docId, href, blobId, url, libraryItemId, size, mime, kind, title }", outputPaths: ["output.href", "output.url", "output.docId", "output.label", "output.libraryItemId"],
  },

  // ───────────────────────── Intelligence ─────────────────────────
  {
    type: "intel.fetch", category: "intel", label: "Fetch source", short: "Fetch", icon: "Radar", usesNetwork: true,
    description: "Run an intelligence source (or an adapter with an ad-hoc configuration) through the durable job queue: CourtListener, eCFR, Federal Register, GovInfo, openFDA, JPML, court rules, news, local folders or watched pages. Returns counts and the ids of the documents touched.",
    keywords: ["ingest", "source", "adapter", "courtlistener", "docket", "opinion", "fda", "jpml", "news", "corpus", "crawl"],
    defaultConfig: { sourceId: "", adapter: "", config: "", mode: "run", maxDocs: 100, since: "", onError: "continue", timeoutSec: 600 },
    fields: [
      { key: "sourceId", label: "Source id", type: "text", placeholder: "isrc_sys_in_hc", help: "A configured source (Settings › Data & automation). India sources: isrc_sys_in_sci (Supreme Court judgments), isrc_sys_in_hc (High Court judgments), isrc_sys_in_kanoon (Indian Kanoon), isrc_sys_in_india_code (India Code), isrc_sys_in_scc_online, isrc_sys_in_manupatra (firm licence only); also isrc_sys_local_corpus and isrc_sys_web_list. A source that is not set up reports 'not configured'." },
      { key: "adapter", label: "Adapter (ad-hoc)", type: "select", options: INTEL_ADAPTER_OPTIONS, help: "Instead of a source id: run an adapter with the configuration below. A manual source named after this step is created on first use." },
      { key: "config", label: "Adapter configuration", type: "json", rows: 5, showWhen: { key: "adapter", truthy: true } },
      { key: "mode", label: "Mode", type: "select", options: [{ value: "run", label: "Run now and wait" }, { value: "enqueue", label: "Enqueue (background runner picks it up)" }] },
      { key: "maxDocs", label: "Max documents", type: "number", min: 1, max: 2000 },
      { key: "since", label: "Since", type: "text", placeholder: "-7d or 2026-09-01", help: "Incremental window start; relative values are resolved at run time." },
      ON_ERROR, TIMEOUT,
    ],
    outputShape: "{ jobId, status, added, updated, skipped, docIds[], errors[], notes[], sourceId }", outputPaths: ["output.docIds", "output.added", "output.updated", "output.status", "output.errors", "output.sourceId"],
  },
  {
    type: "intel.extract", category: "intel", label: "Extract", short: "Extract", icon: "ScanText",
    description: "Summarize documents and extract dated facts and entity mentions (judges, counsel, firms, parties, products, agencies) onto their records. Works deterministically without a key; with a key the model writes summaries and finds entities the adapters missed. Uploaded files (blob ids) are extracted and filed as local documents.",
    keywords: ["summary", "entities", "metadata", "dates", "blob", "upload", "text"],
    defaultConfig: { docIds: "{{steps.fetch.output.docIds}}", blobIds: "", summarize: true, entities: true, maxDocs: 25, modelTier: "fast", onError: "continue", timeoutSec: 600 },
    fields: [
      DOC_IDS,
      { key: "blobIds", label: "Uploaded files (blob ids)", type: "template", rows: 2, help: "Blob ids from a file input ({{inputs.files | pluck:blobId}}); their text is extracted and filed as local_file documents." },
      { key: "summarize", label: "Write summaries", type: "toggle" },
      { key: "entities", label: "Find entities", type: "toggle" },
      { key: "maxDocs", label: "Max documents", type: "number", min: 1, max: 500 },
      MODEL_TIER, ON_ERROR, TIMEOUT,
    ],
    outputShape: "{ docs, summarized, entitiesFound, docIds[], texts[{ id, title, text }], flagged }", outputPaths: ["output.docIds", "output.docs", "output.texts", "output.entitiesFound"],
  },
  {
    type: "intel.index", category: "intel", label: "Index", short: "Index", icon: "Layers",
    description: "Chunk and index documents for hybrid search (keyword always; embeddings when a key is configured). Without document ids it re-embeds records that are still keyword-only.",
    keywords: ["chunk", "embed", "vector", "search", "reindex"],
    defaultConfig: { docIds: "{{steps.extract.output.docIds}}", embed: true, chunkSize: 1200, limit: 25, onError: "continue", timeoutSec: 600 },
    fields: [
      DOC_IDS,
      { key: "embed", label: "Compute embeddings", type: "toggle", help: "Needs OPENAI_API_KEY; keyword indexing always happens." },
      { key: "chunkSize", label: "Chunk size (chars)", type: "number", min: 400, max: 4000 },
      { key: "limit", label: "Re-embed limit", type: "number", min: 1, max: 200, help: "Used when no document ids are given." },
      ON_ERROR, TIMEOUT,
    ],
    outputShape: "{ docs, chunks, embedded, docIds[] }", outputPaths: ["output.docs", "output.chunks", "output.embedded", "output.docIds"],
  },
  {
    type: "intel.entities", category: "intel", label: "Link entities", short: "Entities", icon: "Network",
    description: "Resolve the entity mentions on documents into the entity registry (aliases merged), link the entity ids back onto each document and record co-occurrence and role relations (presides, appears in, member of, represents).",
    keywords: ["judge", "attorney", "firm", "party", "product", "agency", "graph", "relations", "resolve"],
    defaultConfig: { docIds: "{{steps.extract.output.docIds}}", relations: true, onError: "continue", timeoutSec: 300 },
    fields: [
      DOC_IDS,
      { key: "relations", label: "Record relations", type: "toggle" },
      ON_ERROR, TIMEOUT,
    ],
    outputShape: "{ docs, entities, relations, entityIds[], byType }", outputPaths: ["output.entityIds", "output.entities", "output.relations", "output.byType"],
  },
  {
    type: "intel.analyze", category: "intel", label: "Analyze", short: "Analyze", icon: "ChartLine",
    description: "Run an analysis over the intelligence store for a scope — trends (monthly series with anomalies), clusters, a sourced chronology, judge / counsel / firm / MDL profiles or the entity graph — and record the result as a draft insight with evidence links and provenance.",
    keywords: ["trends", "clusters", "chronology", "profile", "graph", "insight", "series", "timeline"],
    defaultConfig: { analysis: "trends", scope: { matterId: "{{matter.id}}", kinds: [], entityIds: "", court: "", jurisdiction: "", dateFrom: "-90d", dateTo: "", q: "" }, title: "", maxDocs: 400, onError: "continue", timeoutSec: 300 },
    fields: [
      { key: "analysis", label: "Analysis", type: "select", required: true, options: [{ value: "trends", label: "Trends (monthly series, anomalies)" }, { value: "clusters", label: "Clusters (topics by kind, court and terms)" }, { value: "chronology", label: "Chronology (sourced timeline)" }, { value: "profiles", label: "Profiles (judges, counsel, firms, MDLs)" }, { value: "graph", label: "Knowledge graph (entities and relations)" }] },
      { key: "scope.matterId", label: "Matter", type: "matter", group: "Scope" },
      { key: "scope.kinds", label: "Document kinds", type: "multiselect", options: INTEL_KIND_OPTIONS, group: "Scope" },
      { key: "scope.entityIds", label: "Entity ids", type: "template", group: "Scope", help: "Array or comma-separated list; profiles and graph centre on them." },
      { key: "scope.court", label: "Court", type: "text", group: "Scope", placeholder: "dsc" },
      { key: "scope.jurisdiction", label: "Jurisdiction", type: "text", group: "Scope" },
      { key: "scope.dateFrom", label: "From", type: "text", group: "Scope", placeholder: "-90d" },
      { key: "scope.dateTo", label: "To", type: "text", group: "Scope" },
      { key: "scope.q", label: "Title contains", type: "template", group: "Scope" },
      { key: "title", label: "Insight title", type: "template", help: "Defaults to a title built from the analysis and scope." },
      { key: "maxDocs", label: "Max documents", type: "number", min: 10, max: 5000 },
      ON_ERROR, TIMEOUT,
    ],
    outputShape: "{ analysis, insightIds[], insights[{ id, kind, title, summary, confidence }], data, docCount, text }", outputPaths: ["output.insightIds", "output.insights", "output.data", "output.docCount", "output.text"],
  },
  {
    type: "intel.verify", category: "intel", label: "Verify", short: "Verify", icon: "ShieldCheck",
    description: "Steward verification: re-check insights against their evidence (claims verified with the model; flags contradicted or unsupported ones), grade earlier AI steps' trust, or run the full data-integrity sweep (staleness, contradictions between sources, broken links, orphaned entities).",
    keywords: ["verification", "sweep", "stale", "contradiction", "broken link", "trust", "steward"],
    defaultConfig: { target: "insights", insightIds: "{{steps.analyze.output.insightIds}}", steps: "", limit: 25, network: false, onError: "continue", timeoutSec: 600 },
    fields: [
      { key: "target", label: "Verify", type: "select", required: true, options: [{ value: "insights", label: "Insights against their evidence" }, { value: "steps", label: "Earlier AI steps (trust and claims)" }, { value: "sweep", label: "Data integrity sweep" }] },
      { key: "insightIds", label: "Insight ids", type: "template", showWhen: { key: "target", equals: "insights" }, help: "Empty: the least recently verified insights, up to the limit." },
      { key: "steps", label: "Steps to check", type: "text", showWhen: { key: "target", equals: "steps" }, help: "Comma-separated node ids of AI steps." },
      { key: "limit", label: "Limit", type: "number", min: 1, max: 200 },
      { key: "network", label: "Probe URLs", type: "toggle", showWhen: { key: "target", equals: "sweep" } },
      ON_ERROR, TIMEOUT,
    ],
    outputShape: "{ target, checked, verified, flagged, skipped, reason, trusted, insightIds[], report }", outputPaths: ["output.checked", "output.verified", "output.flagged", "output.trusted", "output.insightIds", "output.report", "output.skipped"],
  },
  {
    type: "intel.publish", category: "intel", label: "Publish", short: "Publish", icon: "Send",
    description: "Publish insights where people will see them: the Home 'For you' feed, a matter's insight list, a library note, the people watching the entities involved, or a personalized daily digest. Rows from a query can be published as an alert.",
    keywords: ["home", "matter", "library", "watch", "digest", "alert", "notify", "for you"],
    defaultConfig: { to: "home", insightIds: "{{steps.verify.output.insightIds}}", items: "", title: "", summary: "", matterId: "{{matter.id}}", userId: "", recipientIds: [], libraryFolderId: "", requireVerified: false, onError: "continue" },
    fields: [
      { key: "to", label: "Publish to", type: "select", required: true, options: [{ value: "home", label: "Home (For you)" }, { value: "matter", label: "Matter" }, { value: "library", label: "Library (note)" }, { value: "watch", label: "Watchers of the entities" }, { value: "digest", label: "Personal digest" }] },
      { key: "insightIds", label: "Insight ids", type: "template" },
      { key: "items", label: "Rows to publish as an alert", type: "template", rows: 2, help: "Optional: an array (e.g. {{steps.query.output.rows}}) becomes one alert insight with the rows as evidence." },
      { key: "title", label: "Title", type: "template", help: "For alerts and digests." },
      { key: "summary", label: "Summary", type: "template", rows: 3 },
      { key: "matterId", label: "Matter", type: "matter" },
      { key: "userId", label: "Person (digest)", type: "person", showWhen: { key: "to", equals: "digest" } },
      { key: "recipientIds", label: "Recipients", type: "multiselect", options: [], showWhen: { key: "to", in: ["digest", "library"] } },
      { key: "libraryFolderId", label: "Library folder", type: "folder", showWhen: { key: "to", equals: "library" } },
      { key: "requireVerified", label: "Only publish verified insights", type: "toggle" },
      ON_ERROR,
    ],
    outputShape: "{ to, published, skipped, notified, insightIds[], itemIds[], updateIds[], href }", outputPaths: ["output.published", "output.notified", "output.insightIds", "output.itemIds", "output.href"],
  },

  {
    type: "review.auto", category: "logic", label: "Steward", short: "Steward", icon: "ListChecks",
    description: "Automated reviewer over the run so far: classifies each failed step (rate limit, network, timeout, parse, empty, verification…), applies one allow-listed fix by re-running the step with adjusted configuration, and escalates to the review queue when the re-run fails too. Connect it after steps whose 'On failure' is set to Continue.",
    keywords: ["steward", "fix", "retry", "escalate", "review queue", "self-healing", "failures"],
    defaultConfig: { steps: "", fixes: ["retry", "narrow", "fast_model", "skip_verify"], maxFixes: 3, escalate: true, reviewerId: "{{user.id}}", stopOnEscalate: false },
    fields: [
      { key: "steps", label: "Steps to watch", type: "text", help: "Comma-separated node ids; empty watches every earlier step." },
      { key: "fixes", label: "Allowed fixes", type: "multiselect", options: [{ value: "retry", label: "Retry", hint: "network, rate limit, unknown" }, { value: "narrow", label: "Narrow the request", hint: "smaller limits and windows" }, { value: "fast_model", label: "Use the fast model", hint: "timeouts on AI steps" }, { value: "skip_verify", label: "Skip verification", hint: "verification-only failures" }] },
      { key: "maxFixes", label: "Max fixes per run", type: "number", min: 0, max: 10 },
      { key: "escalate", label: "Escalate unfixable failures", type: "toggle", help: "Adds the step to the review queue (provenance sidecar) with the diagnosis." },
      { key: "reviewerId", label: "Reviewer", type: "person" },
      { key: "stopOnEscalate", label: "Fail the run on escalation", type: "toggle" },
    ],
    outputShape: "{ fixed, escalated, notes[], failures[{ nodeId, code, action, ok }] }", outputPaths: ["output.fixed", "output.escalated", "output.notes", "output.failures"],
  },
  {
    type: "data.query", category: "data", label: "Query records", short: "Query", icon: "Table",
    description: "Query the intelligence store (documents, entities, insights, jobs), e-discovery documents, library items, tasks, calendar events, matters or people with filters. Returns rows, ids, a count and a Markdown digest.",
    keywords: ["rows", "filter", "list", "documents", "entities", "insights", "tasks", "events", "matters", "people", "select"],
    defaultConfig: { source: "intel_documents", q: "", filters: {}, matterId: "{{matter.id}}", since: "", limit: 50, sort: "date", direction: "desc" },
    fields: [
      { key: "source", label: "Source", type: "select", required: true, options: DATA_QUERY_SOURCES },
      { key: "q", label: "Text contains", type: "template" },
      { key: "filters", label: "Filters", type: "kv", help: "Per source: kinds, court, jurisdiction, flagged, entityId, sourceId, adapter, minConfidence (documents); type, name (entities); kind, status (insights); status, kind (jobs); custodian, docType, batesPrefix, privileged, hot, responsive, dateAfter, dateBefore (e-discovery); type, tag, folderId (library); status, assigneeId, overdue (tasks); kind, from, to (events); status, practiceArea (matters); role (people). Values may be templates." },
      { key: "matterId", label: "Matter", type: "matter" },
      { key: "since", label: "Since", type: "text", placeholder: "-1d", help: "Relative (-1d, -2w) or a date; filters by the record's primary date." },
      { key: "limit", label: "Max rows", type: "number", min: 1, max: 500 },
      { key: "sort", label: "Sort", type: "select", options: [{ value: "date", label: "Date" }, { value: "updated", label: "Updated" }, { value: "title", label: "Title" }, { value: "confidence", label: "Confidence" }] },
      { key: "direction", label: "Direction", type: "select", options: [{ value: "desc", label: "Newest first" }, { value: "asc", label: "Oldest first" }] },
    ],
    outputShape: "{ source, count, total, rows[], ids[], text }", outputPaths: ["output.rows", "output.count", "output.ids", "output.text", "output.total"],
  },
  {
    type: "logic.schedule_after", category: "logic", label: "Start workflow", short: "Start next", icon: "Workflow",
    description: "Start another workflow when this step runs, with mapped inputs (this run's inputs and deliverables are available). The child run id is recorded on this run.",
    keywords: ["chain", "trigger", "follow-on", "child run", "handoff", "next"],
    defaultConfig: { workflowId: "", inputs: {}, includeInputs: true, matterId: "{{matter.id}}", wait: false },
    fields: [
      { key: "workflowId", label: "Workflow", type: "workflow", required: true },
      { key: "inputs", label: "Inputs for the child run", type: "kv", help: "Values may be templates; {{run.deliverables}} carries this run's files." },
      { key: "includeInputs", label: "Pass this run's inputs through", type: "toggle" },
      { key: "matterId", label: "Matter", type: "matter" },
      { key: "wait", label: "Wait for it to finish", type: "toggle", help: "Otherwise the child runs in the background and this step returns at once." },
    ],
    outputShape: "{ runId, workflowId, name, status, href }", outputPaths: ["output.runId", "output.workflowId", "output.status", "output.href"],
  },

  {
    type: "ai.route", category: "ai", label: "Route (coordinator)", short: "Route", icon: "GitFork", usesAI: true,
    description: "The coordinator classifies the input against the configured branches and picks one; the handoff (to the branch's agent, with the brief) is recorded on the run. Connect each branch handle to the steps that handle it.",
    keywords: ["coordinator", "classify", "handoff", "dispatch", "triage", "branch"],
    defaultConfig: { input: "{{inputs.text}}", branches: [{ id: "research", label: "Research question", description: "Needs authority or an answer to an open legal question", agent: "research" }, { id: "draft", label: "Drafting", description: "Asks for a document, letter, memo or clause to be written", agent: "drafter" }, { id: "review", label: "Review", description: "Asks to check, verify or QA an existing document", agent: "reviewer" }], instructions: "", modelTier: "fast", retries: 1, timeoutSec: 90 },
    fields: [
      { key: "input", label: "Input to route", type: "template", rows: 3, required: true },
      { key: "branches", label: "Branches", type: "routes", required: true },
      { key: "instructions", label: "Extra guidance", type: "textarea", rows: 3 },
      MODEL_TIER, RETRIES, TIMEOUT,
    ],
    outputs: [{ id: "__dynamic__", label: "Branches" }],
    outputShape: "{ matched, label, agent, confidence, rationale, brief, handoff }", outputPaths: ["output.matched", "output.label", "output.agent", "output.confidence", "output.brief"],
  },
  {
    type: "ai.agent", category: "ai", label: "Agent", short: "Agent", icon: "Briefcase", usesAI: true, usesNetwork: true,
    description: "Hand a brief to a platform agent — research, drafter, reviewer, coder, analyst or steward — with its persona and toolset. The result carries provenance like every AI step; any handoff the agent makes is recorded on the run.",
    keywords: ["persona", "research", "drafter", "reviewer", "coder", "analyst", "steward", "handoff", "tools"],
    defaultConfig: { agent: "research", brief: "{{inputs.question}}", context: "", tools: [], output: "text", jsonSchema: "", maxSteps: 8, modelTier: "primary", retries: 1, timeoutSec: 300 },
    fields: [
      { key: "agent", label: "Agent", type: "agent", required: true },
      { key: "brief", label: "Brief", type: "template", rows: 6, required: true },
      { key: "context", label: "Context", type: "template", rows: 4, help: "Evidence, prior step outputs, matter details." },
      { key: "tools", label: "Extra tools", type: "multiselect", options: AGENT_TOOL_OPTIONS, help: "Added to the persona's own toolset." },
      { key: "output", label: "Output", type: "select", options: [{ value: "text", label: "Text (Markdown)" }, { value: "json", label: "JSON (schema)" }] },
      { key: "jsonSchema", label: "JSON schema", type: "json", rows: 6, showWhen: { key: "output", equals: "json" } },
      { key: "maxSteps", label: "Max tool steps", type: "number", min: 1, max: 20 },
      MODEL_TIER, RETRIES, TIMEOUT,
    ],
    outputShape: "{ agent, text, json, citations[], toolCalls, handoffs[{ to, brief }], sourceBacked }", outputPaths: ["output.text", "output.json", "output.citations", "output.handoffs", "output.agent"],
  },
];

export const NODE_TYPE_MAP: Record<string, NodeTypeSpec> = Object.fromEntries(NODE_TYPES.map((n) => [n.type, n]));
export const KNOWN_NODE_TYPES = NODE_TYPES.map((n) => n.type);

export function nodeSpec(type: string): NodeTypeSpec | undefined {
  return NODE_TYPE_MAP[type];
}

/** Category of a node type: the registry entry wins, then the type prefix (intel.*, review.* → logic, output.* → action). */
export function categoryOf(type: string): NodeCategory {
  const spec = NODE_TYPE_MAP[type];
  if (spec) return spec.category;
  const prefix = type.split(".")[0];
  if (prefix === "review") return "logic";
  if (prefix === "output") return "action";
  return (["trigger", "ai", "data", "intel", "logic", "action"].includes(prefix) ? prefix : "action") as NodeCategory;
}

export function isTriggerType(type: string) {
  return type.startsWith("trigger.");
}

/** Deep-clone a node type's default config. */
export function defaultConfigFor(type: AnyNodeType): Record<string, unknown> {
  return JSON.parse(JSON.stringify(NODE_TYPE_MAP[type]?.defaultConfig ?? {}));
}

/** Source handles a node exposes, including dynamic branch rule handles. */
export function sourceHandles(type: string, config: Record<string, unknown>): HandleSpec[] {
  const spec = NODE_TYPE_MAP[type];
  if (!spec) return [{ id: "out", label: "Out" }];
  if (type === "logic.branch") {
    const rules = Array.isArray(config.rules) ? (config.rules as { id: string; label?: string }[]) : [];
    return [...rules.map((r) => ({ id: r.id, label: r.label || r.id })), { id: "else", label: (config.elseLabel as string) || "Else" }];
  }
  if (type === "ai.route") {
    const branches = Array.isArray(config.branches) ? (config.branches as { id: string; label?: string; agent?: string }[]) : [];
    return [...branches.filter((b) => b && b.id).map((b) => ({ id: b.id, label: b.label || b.id, hint: b.agent ? `→ ${b.agent}` : undefined })), { id: "else", label: "Unmatched" }];
  }
  return spec.outputs ?? [{ id: "out", label: "Out" }];
}

export const CATEGORY_ORDER: NodeCategory[] = ["trigger", "ai", "data", "intel", "logic", "action"];

export const WORKFLOW_CATEGORIES: { value: string; label: string }[] = [
  { value: "intake", label: "Intake" },
  { value: "discovery", label: "Discovery" },
  { value: "drafting", label: "Drafting" },
  { value: "research", label: "Research" },
  { value: "compliance", label: "Compliance" },
  { value: "transactional", label: "Transactional" },
  { value: "operations", label: "Operations" },
  { value: "automation", label: "Automation" },
];
