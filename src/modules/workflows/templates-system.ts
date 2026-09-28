/**
 * System (automation) workflows: the platform's own background work expressed
 * as real workflow graphs — scheduled, stewarded, verified and published — so
 * the same engine, run history, review queue and audit trail cover them.
 * Seeded as active workflows with stable ids (`system: true`); they appear in
 * the gallery's System filter and never in the template list.
 */
import type { Workflow, WorkflowEdge, WorkflowNode, WorkflowNodeType } from "@/lib/types/domain";
import { autoLayout } from "./graph";
import { defaultConfigFor, type AnyNodeType } from "./registry";

const T0 = "2026-06-01T09:00:00.000Z";

/**
 * Stable ids of the India intelligence sources (mirrors src/modules/intel/seed.ts INDIA_SOURCE_IDS): Supreme Court and
 * focus High Court judgments (AWS Open Data), Indian Kanoon searches and India Code. A fetch of a source that is not
 * set up in the workspace returns an explicit `not_configured` state (see executors-intel), never a crash.
 */
export const INDIA_INTEL_SOURCE_IDS = {
  sciOpenData: "isrc_sys_in_sci",
  hcOpenData: "isrc_sys_in_hc",
  indianKanoon: "isrc_sys_in_kanoon",
  indiaCode: "isrc_sys_in_india_code",
} as const;

/** Stable ids of the seeded intelligence sources (mirrors src/modules/intel/seed.ts SEED_SOURCE_IDS; the US sample sources). */
export const INTEL_SOURCE_IDS = {
  clOpinions: "isrc_sys_cl_opinions",
  clDockets: "isrc_sys_cl_dockets",
  clJudges: "isrc_sys_cl_judges",
  ecfr: "isrc_sys_ecfr",
  federalRegister: "isrc_sys_federal_register",
  govinfo: "isrc_sys_govinfo",
  openfda: "isrc_sys_openfda",
  jpml: "isrc_sys_jpml",
  courtRules: "isrc_sys_court_rules",
  news: "isrc_sys_news",
  localCorpus: "isrc_sys_local_corpus",
  webList: "isrc_sys_web_list",
} as const;

export const SYSTEM_WORKFLOW_IDS = {
  authorityRefresh: "wf_sys_authority_refresh",
  docketWatch: "wf_sys_docket_watch",
  mdlTracker: "wf_sys_mdl_tracker",
  regulatoryWatch: "wf_sys_regulatory_watch",
  newsWatch: "wf_sys_news_watch",
  localCorpus: "wf_sys_local_corpus_backfill",
  profiles: "wf_sys_judge_counsel_profiles",
  chronologies: "wf_sys_matter_chronologies",
  insightSweep: "wf_sys_insight_verification",
  integritySweep: "wf_sys_data_integrity",
  teamDigest: "wf_sys_team_digest",
} as const;

function N(id: string, type: AnyNodeType, label: string, config: Record<string, unknown> = {}): WorkflowNode {
  return { id, type: type as WorkflowNodeType, label, position: { x: 0, y: 0 }, config: { ...defaultConfigFor(type), ...config } };
}
function E(source: string, target: string, sourceHandle?: string, targetHandle?: string, label?: string): WorkflowEdge {
  return { id: `e_${source}__${target}${sourceHandle ? `__${sourceHandle}` : ""}`, source, target, sourceHandle, targetHandle, label };
}

type SystemDef = Omit<Workflow, "createdAt" | "updatedAt" | "status" | "isTemplate" | "ownerId" | "system">;

const fetch = (id: string, label: string, sourceId: string, extra: Record<string, unknown> = {}) => N(id, "intel.fetch", label, { sourceId, adapter: "", mode: "run", maxDocs: 150, onError: "continue", ...extra });
const steward = (id: string, steps: string, label = "Steward") => N(id, "review.auto", label, { steps, fixes: ["retry", "narrow", "fast_model", "skip_verify"], maxFixes: 3, escalate: true, reviewerId: "{{user.id}}", stopOnEscalate: false });
const anyNew = (id: string, ref: string, label = "Anything new?") => N(id, "logic.branch", label, { rules: [{ id: "yes", label: "New records", logic: "all", conditions: [{ left: `{{steps.${ref}.output.count}}`, op: "gt", right: "0" }] }], elseLabel: "Quiet" });

const SYSTEM: SystemDef[] = [
  // 1 ── Authority refresh (daily 05:00): opinions + court rules → extract → index → link → trends → verify → publish
  {
    id: SYSTEM_WORKFLOW_IDS.authorityRefresh,
    name: "Authority refresh",
    description: "Every morning: pull new opinions and court rules for the matters' research themes, extract and index them, link judges, counsel and courts, and, when there are authorities in the last 90 days, refresh the authority trend and publish it to Home once verified.",
    category: "automation",
    tags: ["system", "case law", "court rules", "daily"],
    inputs: [],
    nodes: [
      N("schedule", "trigger.schedule", "Daily 05:00", { schedule: { frequency: "daily", time: "05:00" }, enabled: true, presetInputs: {} }),
      fetch("opinions", "Fetch opinions", INTEL_SOURCE_IDS.clOpinions),
      fetch("rules", "Fetch court rules", INTEL_SOURCE_IDS.courtRules, { maxDocs: 50 }),
      steward("steward", "opinions, rules"),
      N("extract", "intel.extract", "Extract and summarize", { docIds: "{{steps.opinions.output.docIds}}", blobIds: "", summarize: true, entities: true, maxDocs: 40, modelTier: "fast", onError: "continue" }),
      N("index", "intel.index", "Index for search", { docIds: "{{steps.extract.output.docIds}}", embed: true, chunkSize: 1200, onError: "continue" }),
      N("entities", "intel.entities", "Link judges, counsel and courts", { docIds: "{{steps.extract.output.docIds}}", relations: true, onError: "continue" }),
      N("recent", "data.query", "Authorities in the last 90 days", { source: "intel_documents", q: "", filters: { kinds: "opinion, court_rule" }, matterId: "", since: "-90d", limit: 1, sort: "date", direction: "desc" }),
      anyNew("any", "recent", "Any authorities?"),
      N("trends", "intel.analyze", "Authority trend (90 days)", { analysis: "trends", scope: { matterId: "", kinds: ["opinion", "court_rule"], entityIds: "", court: "", jurisdiction: "", dateFrom: "-90d", dateTo: "", q: "" }, title: "Case law and court rules — last 90 days", maxDocs: 800, onError: "continue" }),
      N("verify", "intel.verify", "Verify the insight", { target: "insights", insightIds: "{{steps.trends.output.insightIds}}", steps: "", limit: 5, onError: "continue" }),
      N("publish", "intel.publish", "Publish to Home", { to: "home", insightIds: "{{steps.trends.output.insightIds}}", items: "", title: "", summary: "", matterId: "", userId: "", recipientIds: [], libraryFolderId: "", requireVerified: false, onError: "continue" }),
    ],
    edges: [E("schedule", "opinions"), E("schedule", "rules"), E("opinions", "steward"), E("rules", "steward"), E("steward", "extract"), E("extract", "index"), E("extract", "entities"), E("index", "recent"), E("entities", "recent"), E("recent", "any"), E("any", "trends", "yes"), E("trends", "verify"), E("verify", "publish")],
  },

  // 2 ── Docket watch (hourly): fetch matter dockets → steward → new entries today → alert watchers
  {
    id: SYSTEM_WORKFLOW_IDS.docketWatch,
    name: "Docket watch",
    description: "Every hour: refresh the RECAP dockets the firm watches, index new entries and, when there are any, publish an alert to the people watching those dockets and the matter teams.",
    category: "automation",
    tags: ["system", "docket", "PACER", "hourly"],
    inputs: [],
    nodes: [
      N("schedule", "trigger.schedule", "Hourly", { schedule: { frequency: "hourly", time: "00:05" }, enabled: true, presetInputs: {} }),
      fetch("dockets", "Fetch matter dockets", INTEL_SOURCE_IDS.clDockets, { maxDocs: 200 }),
      steward("steward", "dockets"),
      N("index", "intel.index", "Index new entries", { docIds: "{{steps.dockets.output.docIds}}", embed: true, chunkSize: 1200, onError: "continue" }),
      N("new_entries", "data.query", "Docket entries since yesterday", { source: "intel_documents", q: "", filters: { kinds: "docket_entry" }, matterId: "", since: "-1d", limit: 50, sort: "date", direction: "desc" }),
      anyNew("any", "new_entries", "New entries?"),
      N("alert", "intel.publish", "Alert watchers", { to: "watch", insightIds: "", items: "{{steps.new_entries.output.rows}}", title: "{{steps.new_entries.output.count}} new docket entries on watched dockets", summary: "{{steps.new_entries.output.text}}", matterId: "", userId: "", recipientIds: [], libraryFolderId: "", requireVerified: false, onError: "continue" }),
    ],
    edges: [E("schedule", "dockets"), E("dockets", "steward"), E("steward", "index"), E("index", "new_entries"), E("new_entries", "any"), E("any", "alert", "yes")],
  },

  // 3 ── MDL tracker (daily): JPML list → steward → MDL profiles → publish to the matters
  {
    id: SYSTEM_WORKFLOW_IDS.mdlTracker,
    name: "MDL tracker",
    description: "Daily: refresh the JPML pending-MDL list, link the MDL records to the matters, rebuild the MDL profiles (transferee courts, judges, activity), verify them and publish them to Home.",
    category: "automation",
    tags: ["system", "MDL", "JPML", "daily"],
    inputs: [],
    nodes: [
      N("schedule", "trigger.schedule", "Daily 04:30", { schedule: { frequency: "daily", time: "04:30" }, enabled: true, presetInputs: {} }),
      fetch("jpml", "Fetch JPML MDL list", INTEL_SOURCE_IDS.jpml, { maxDocs: 300 }),
      steward("steward", "jpml"),
      N("entities", "intel.entities", "Link MDLs and courts", { docIds: "{{steps.jpml.output.docIds}}", relations: true, onError: "continue" }),
      N("mdls", "data.query", "Watched MDL records", { source: "intel_documents", q: "", filters: { kinds: "mdl" }, matterId: "", since: "", limit: 50, sort: "updated", direction: "desc" }),
      N("profiles", "intel.analyze", "MDL profiles", { analysis: "profiles", scope: { matterId: "", kinds: ["mdl", "docket", "docket_entry"], entityIds: "{{steps.entities.output.entityIds}}", court: "", jurisdiction: "", dateFrom: "", dateTo: "", q: "" }, title: "", maxDocs: 500, onError: "continue" }),
      N("verify", "intel.verify", "Verify profiles", { target: "insights", insightIds: "{{steps.profiles.output.insightIds}}", steps: "", limit: 10, onError: "continue" }),
      N("publish", "intel.publish", "Publish to Home", { to: "home", insightIds: "{{steps.profiles.output.insightIds}}", items: "", title: "", summary: "", matterId: "", userId: "", recipientIds: [], libraryFolderId: "", requireVerified: false, onError: "continue" }),
    ],
    edges: [E("schedule", "jpml"), E("jpml", "steward"), E("steward", "entities"), E("entities", "mdls"), E("mdls", "profiles"), E("profiles", "verify"), E("verify", "publish")],
  },

  // 4 ── Regulatory watch (daily): FDA + Federal Register + eCFR → steward → extract → index → new records → trends → verify → publish
  {
    id: SYSTEM_WORKFLOW_IDS.regulatoryWatch,
    name: "Regulatory watch",
    description: "Daily: pull openFDA enforcement and labeling, Federal Register documents and tracked CFR sections; extract and index what changed; when there is anything new, refresh the 30-day regulatory trend, verify it and publish it to Home.",
    category: "automation",
    tags: ["system", "FDA", "Federal Register", "eCFR", "daily"],
    inputs: [],
    nodes: [
      N("schedule", "trigger.schedule", "Daily 06:00", { schedule: { frequency: "daily", time: "06:00" }, enabled: true, presetInputs: {} }),
      fetch("fda", "Fetch openFDA", INTEL_SOURCE_IDS.openfda, { maxDocs: 100 }),
      fetch("fr", "Fetch Federal Register", INTEL_SOURCE_IDS.federalRegister, { maxDocs: 60 }),
      fetch("ecfr", "Fetch eCFR sections", INTEL_SOURCE_IDS.ecfr, { maxDocs: 40 }),
      steward("steward", "fda, fr, ecfr"),
      N("extract", "intel.extract", "Extract and summarize", { docIds: "{{steps.fr.output.docIds}}", blobIds: "", summarize: true, entities: true, maxDocs: 30, modelTier: "fast", onError: "continue" }),
      N("index", "intel.index", "Index", { docIds: "{{steps.extract.output.docIds}}", embed: true, chunkSize: 1200, onError: "continue" }),
      N("fresh", "data.query", "Regulatory records since yesterday", { source: "intel_documents", q: "", filters: { kinds: "regulation, register_notice, recall, adverse_event" }, matterId: "", since: "-1d", limit: 100, sort: "date", direction: "desc" }),
      anyNew("any", "fresh"),
      N("trends", "intel.analyze", "Regulatory trend (30 days)", { analysis: "trends", scope: { matterId: "", kinds: ["regulation", "register_notice", "recall", "adverse_event"], entityIds: "", court: "", jurisdiction: "", dateFrom: "-30d", dateTo: "", q: "" }, title: "Regulatory activity — last 30 days", maxDocs: 800, onError: "continue" }),
      N("verify", "intel.verify", "Verify", { target: "insights", insightIds: "{{steps.trends.output.insightIds}}", steps: "", limit: 5, onError: "continue" }),
      N("publish", "intel.publish", "Publish to Home", { to: "home", insightIds: "{{steps.trends.output.insightIds}}", items: "", title: "", summary: "", matterId: "", userId: "", recipientIds: [], libraryFolderId: "", requireVerified: false, onError: "continue" }),
    ],
    edges: [E("schedule", "fda"), E("schedule", "fr"), E("schedule", "ecfr"), E("fda", "steward"), E("fr", "steward"), E("ecfr", "steward"), E("steward", "extract"), E("extract", "index"), E("index", "fresh"), E("fresh", "any"), E("any", "trends", "yes"), E("trends", "verify"), E("verify", "publish")],
  },

  // 5 ── News watch (daily): news → steward → extract → index → clusters → publish to Home
  {
    id: SYSTEM_WORKFLOW_IDS.newsWatch,
    name: "News watch",
    description: "Daily: collect news on the matters, products and regulators (needs a Tavily or Firecrawl key), summarize and index it, cluster the day's coverage and publish the clusters to Home.",
    category: "automation",
    tags: ["system", "news", "daily"],
    inputs: [],
    nodes: [
      N("schedule", "trigger.schedule", "Daily 07:00", { schedule: { frequency: "daily", time: "07:00" }, enabled: true, presetInputs: {} }),
      fetch("news", "Fetch news", INTEL_SOURCE_IDS.news, { maxDocs: 60 }),
      steward("steward", "news"),
      N("extract", "intel.extract", "Summarize", { docIds: "{{steps.news.output.docIds}}", blobIds: "", summarize: true, entities: true, maxDocs: 40, modelTier: "fast", onError: "continue" }),
      N("index", "intel.index", "Index", { docIds: "{{steps.extract.output.docIds}}", embed: true, chunkSize: 1200, onError: "continue" }),
      N("fresh", "data.query", "News since yesterday", { source: "intel_documents", q: "", filters: { kinds: "news" }, matterId: "", since: "-1d", limit: 100, sort: "date", direction: "desc" }),
      anyNew("any", "fresh"),
      N("clusters", "intel.analyze", "Cluster the coverage (7 days)", { analysis: "clusters", scope: { matterId: "", kinds: ["news"], entityIds: "", court: "", jurisdiction: "", dateFrom: "-7d", dateTo: "", q: "" }, title: "News this week", maxDocs: 400, onError: "continue" }),
      N("publish", "intel.publish", "Publish to Home", { to: "home", insightIds: "{{steps.clusters.output.insightIds}}", items: "", title: "", summary: "", matterId: "", userId: "", recipientIds: [], libraryFolderId: "", requireVerified: false, onError: "continue" }),
    ],
    edges: [E("schedule", "news"), E("news", "steward"), E("steward", "extract"), E("extract", "index"), E("index", "fresh"), E("fresh", "any"), E("any", "clusters", "yes"), E("clusters", "publish")],
  },

  // 6 ── Local corpus backfill (nightly incremental)
  {
    id: SYSTEM_WORKFLOW_IDS.localCorpus,
    name: "Local corpus backfill",
    description: "Nightly: walk the firm's document folders (LECLAUDE_CORPUS_DIRS) incrementally, extract text from new and changed files, index them and link the people, courts and products they mention. Run it manually for a first backfill.",
    category: "automation",
    tags: ["system", "documents", "corpus", "nightly"],
    inputs: [],
    nodes: [
      N("schedule", "trigger.schedule", "Nightly 01:00", { schedule: { frequency: "daily", time: "01:00" }, enabled: true, presetInputs: {} }),
      fetch("files", "Walk document folders", INTEL_SOURCE_IDS.localCorpus, { maxDocs: 500, timeoutSec: 900 }),
      steward("steward", "files"),
      N("extract", "intel.extract", "Summarize new files", { docIds: "{{steps.files.output.docIds}}", blobIds: "", summarize: true, entities: true, maxDocs: 60, modelTier: "fast", onError: "continue" }),
      N("index", "intel.index", "Index", { docIds: "{{steps.extract.output.docIds}}", embed: true, chunkSize: 1200, onError: "continue" }),
      N("entities", "intel.entities", "Link entities", { docIds: "{{steps.extract.output.docIds}}", relations: true, onError: "continue" }),
    ],
    edges: [E("schedule", "files"), E("files", "steward"), E("steward", "extract"), E("extract", "index"), E("extract", "entities")],
  },

  // 7 ── Judge and counsel profiles (weekly)
  {
    id: SYSTEM_WORKFLOW_IDS.profiles,
    name: "Judge and counsel profiles",
    description: "Weekly: refresh the judge records from CourtListener, re-link judges, counsel and firms across opinions and dockets, rebuild their profiles (activity, courts, tendencies, related people), verify and publish them to Home.",
    category: "automation",
    tags: ["system", "judges", "counsel", "profiles", "weekly"],
    inputs: [],
    nodes: [
      N("schedule", "trigger.schedule", "Weekly, Sunday 03:00", { schedule: { frequency: "weekly", time: "03:00", weekday: 0 }, enabled: true, presetInputs: {} }),
      fetch("judges", "Fetch judge records", INTEL_SOURCE_IDS.clJudges, { maxDocs: 50 }),
      steward("steward", "judges"),
      N("recent", "data.query", "Opinions and dockets (90 days)", { source: "intel_documents", q: "", filters: { kinds: "opinion, docket, docket_entry, judge" }, matterId: "", since: "-90d", limit: 300, sort: "date", direction: "desc" }),
      N("entities", "intel.entities", "Link judges, counsel and firms", { docIds: "{{steps.recent.output.ids}}", relations: true, onError: "continue" }),
      N("profiles", "intel.analyze", "Profiles", { analysis: "profiles", scope: { matterId: "", kinds: ["opinion", "docket", "docket_entry", "judge", "attorney", "firm"], entityIds: "", court: "", jurisdiction: "", dateFrom: "-365d", dateTo: "", q: "" }, title: "", maxDocs: 1000, onError: "continue" }),
      N("verify", "intel.verify", "Verify profiles", { target: "insights", insightIds: "{{steps.profiles.output.insightIds}}", steps: "", limit: 10, onError: "continue" }),
      N("publish", "intel.publish", "Publish to Home", { to: "home", insightIds: "{{steps.profiles.output.insightIds}}", items: "", title: "", summary: "", matterId: "", userId: "", recipientIds: [], libraryFolderId: "", requireVerified: false, onError: "continue" }),
    ],
    edges: [E("schedule", "judges"), E("judges", "steward"), E("steward", "recent"), E("recent", "entities"), E("entities", "profiles"), E("profiles", "verify"), E("verify", "publish")],
  },

  // 8 ── Matter chronologies (nightly): for each active matter → chronology → verify → publish to the matter
  {
    id: SYSTEM_WORKFLOW_IDS.chronologies,
    name: "Matter chronologies",
    description: "Nightly: for every active matter, merge docket entries, regulatory events, recalls, opinions and the e-discovery timeline into one sourced chronology, verify it and publish it to the matter.",
    category: "automation",
    tags: ["system", "chronology", "matters", "nightly"],
    inputs: [],
    nodes: [
      N("schedule", "trigger.schedule", "Nightly 02:00", { schedule: { frequency: "daily", time: "02:00" }, enabled: true, presetInputs: {} }),
      N("matters", "data.query", "Active matters", { source: "matters", q: "", filters: { status: "active" }, matterId: "", since: "", limit: 25, sort: "title", direction: "asc" }),
      N("each", "logic.loop", "For each matter", { over: "{{steps.matters.output.rows}}", maxIterations: 25, itemLabel: "matter", stopOnError: false }),
      N("chronology", "intel.analyze", "Build chronology", { analysis: "chronology", scope: { matterId: "{{loop.item.id}}", kinds: [], entityIds: "", court: "", jurisdiction: "", dateFrom: "", dateTo: "", q: "" }, title: "Chronology — {{loop.item.shortName}}", maxDocs: 800, onError: "continue" }),
      N("verify", "intel.verify", "Verify", { target: "insights", insightIds: "{{steps.chronology.output.insightIds}}", steps: "", limit: 3, onError: "continue" }),
      N("publish", "intel.publish", "Publish to the matter", { to: "matter", insightIds: "{{steps.chronology.output.insightIds}}", items: "", title: "", summary: "", matterId: "{{loop.item.id}}", userId: "", recipientIds: [], libraryFolderId: "", requireVerified: false, onError: "continue" }),
      N("done", "data.query", "Published chronologies", { source: "intel_insights", q: "", filters: { kind: "chronology", status: "published" }, matterId: "", since: "-1d", limit: 50, sort: "updated", direction: "desc" }),
    ],
    edges: [E("schedule", "matters"), E("matters", "each"), E("each", "chronology", "each"), E("chronology", "verify"), E("verify", "publish"), E("publish", "each", undefined, "loop-back"), E("each", "done", "done")],
  },

  // 9 ── Insight verification sweep (every 6 hours)
  {
    id: SYSTEM_WORKFLOW_IDS.insightSweep,
    name: "Insight verification sweep",
    description: "Every six hours: re-verify the least recently checked insights against their evidence, flag contradicted or unsupported ones and open a review task for knowledge management when anything was flagged.",
    category: "automation",
    tags: ["system", "verification", "insights", "6h"],
    inputs: [],
    nodes: [
      N("schedule", "trigger.schedule", "Every 6 hours", { schedule: { frequency: "hourly", time: "00:20", interval: 6 }, enabled: true, presetInputs: {} }),
      N("verify", "intel.verify", "Re-verify insights", { target: "insights", insightIds: "", steps: "", limit: 25, onError: "continue" }),
      N("flagged", "data.query", "Flagged insights", { source: "intel_insights", q: "", filters: { status: "flagged" }, matterId: "", since: "-1d", limit: 50, sort: "updated", direction: "desc" }),
      N("any", "logic.branch", "Anything flagged?", { rules: [{ id: "yes", label: "Flagged", logic: "all", conditions: [{ left: "{{steps.flagged.output.count}}", op: "gt", right: "0" }] }], elseLabel: "All clear" }),
      N("task", "action.create_task", "Review flagged insights", { title: "Review {{steps.flagged.output.count}} flagged insight(s)", description: "The verification sweep flagged insights whose claims the evidence does not support.\n\n{{steps.flagged.output.text | truncate:1500}}", assigneeId: "{{user.id}}", priority: "medium", dueRule: "+2bd", matterId: "", tags: ["intel", "verification"], requireTrusted: false }),
    ],
    edges: [E("schedule", "verify"), E("verify", "flagged"), E("flagged", "any"), E("any", "task", "yes")],
  },

  // 10 ── Data integrity sweep (every 6 hours)
  {
    id: SYSTEM_WORKFLOW_IDS.integritySweep,
    name: "Data integrity sweep",
    description: "Every six hours: run the steward's sweep — stale records, contradictions between sources on the same docket or citation, broken links, orphaned entities — and the escalated-job check; open a task when something needs a person.",
    category: "automation",
    tags: ["system", "integrity", "sweep", "6h"],
    inputs: [],
    nodes: [
      N("schedule", "trigger.schedule", "Every 6 hours", { schedule: { frequency: "hourly", time: "00:40", interval: 6 }, enabled: true, presetInputs: {} }),
      N("sweep", "intel.verify", "Integrity sweep", { target: "sweep", insightIds: "", steps: "", limit: 10, network: false, onError: "continue" }),
      N("escalated", "data.query", "Escalated jobs", { source: "intel_jobs", q: "", filters: { status: "escalated" }, matterId: "", since: "-7d", limit: 50, sort: "updated", direction: "desc" }),
      N("any", "logic.branch", "Needs a person?", { rules: [{ id: "yes", label: "Findings", logic: "any", conditions: [{ left: "{{steps.sweep.output.flagged}}", op: "gt", right: "0" }, { left: "{{steps.escalated.output.count}}", op: "gt", right: "0" }] }], elseLabel: "Clean" }),
      N("task", "action.create_task", "Resolve integrity findings", { title: "Integrity sweep: {{steps.sweep.output.flagged}} finding(s), {{steps.escalated.output.count}} escalated job(s)", description: "Sweep notes:\n{{steps.sweep.output.notes | bullets}}\n\nEscalated jobs:\n{{steps.escalated.output.text | truncate:1200}}", assigneeId: "{{user.id}}", priority: "medium", dueRule: "+1bd", matterId: "", tags: ["intel", "integrity"], requireTrusted: false }),
    ],
    edges: [E("schedule", "sweep"), E("sweep", "escalated"), E("escalated", "any"), E("any", "task", "yes")],
  },

  // 11 ── Team digest (weekdays 07:00, personalized per person)
  {
    id: SYSTEM_WORKFLOW_IDS.teamDigest,
    name: "Team digest",
    description: "Weekdays at 07:00: build a personal brief for every attorney, paralegal and staff member — their calendar for the next two weeks, overdue and due tasks, new intelligence on their matters, insights and team updates — and publish it to their Home feed.",
    category: "automation",
    tags: ["system", "digest", "personal", "weekdays"],
    inputs: [],
    nodes: [
      N("schedule", "trigger.schedule", "Weekdays 07:00", { schedule: { frequency: "daily", time: "07:00", weekdaysOnly: true }, enabled: true, presetInputs: {} }),
      N("people", "data.query", "Firm people", { source: "people", q: "", filters: { role: "attorney, paralegal, staff" }, matterId: "", since: "", limit: 50, sort: "title", direction: "asc" }),
      N("each", "logic.loop", "For each person", { over: "{{steps.people.output.rows}}", maxIterations: 50, itemLabel: "person", stopOnError: false }),
      N("digest", "intel.publish", "Personal digest", { to: "digest", insightIds: "", items: "", title: "", summary: "", matterId: "", userId: "{{loop.item.id}}", recipientIds: [], libraryFolderId: "", requireVerified: false, onError: "continue" }),
      N("done", "data.query", "Digests published today", { source: "intel_insights", q: "", filters: { kind: "digest", status: "published" }, matterId: "", since: "-1d", limit: 50, sort: "updated", direction: "desc" }),
    ],
    edges: [E("schedule", "people"), E("people", "each"), E("each", "digest", "each"), E("digest", "each", undefined, "loop-back"), E("each", "done", "done")],
  },
];

const IN = INDIA_INTEL_SOURCE_IDS;

/**
 * LeClaude India versions of the source-bound system workflows (same stable ids): judgment watch for the Supreme Court
 * and the focus High Courts, statute watch on India Code, and judge / counsel profiles built from ingested judgments.
 * The US-bound workflows (RECAP docket watch, JPML MDL tracker, US news and regulatory sources) are not in the India
 * default set; they stay buildable through `buildUsSystemTemplates()` for the bundled US sample dataset.
 */
const INDIA_OVERRIDES: SystemDef[] = [
  {
    id: SYSTEM_WORKFLOW_IDS.authorityRefresh,
    name: "Judgment watch — Supreme Court and focus High Courts",
    description: "Every morning: pull new judgments of the Supreme Court and of the High Courts of Karnataka, Telangana and Andhra Pradesh (open data), run the firm's saved Indian Kanoon searches, extract and index them, link judges, advocates and courts, and, when there are judgments in the last 90 days, refresh the authority trend and publish it to Home once verified. Sources that are not set up report 'not configured'.",
    category: "automation",
    tags: ["system", "judgments", "Supreme Court", "High Courts", "India", "daily"],
    inputs: [],
    nodes: [
      N("schedule", "trigger.schedule", "Daily 05:00", { schedule: { frequency: "daily", time: "05:00" }, enabled: true, presetInputs: {} }),
      fetch("sci", "Fetch Supreme Court judgments", IN.sciOpenData, { maxDocs: 150 }),
      fetch("hc", "Fetch High Court judgments (KA, TS, AP)", IN.hcOpenData, { maxDocs: 300 }),
      fetch("kanoon", "Run saved Indian Kanoon searches", IN.indianKanoon, { maxDocs: 100 }),
      steward("steward", "sci, hc, kanoon"),
      N("new", "data.query", "Judgments added since yesterday", { source: "intel_documents", q: "", filters: { kinds: "opinion" }, matterId: "", since: "-1d", limit: 200, sort: "date", direction: "desc" }),
      N("extract", "intel.extract", "Extract and summarize", { docIds: "{{steps.new.output.ids}}", blobIds: "", summarize: true, entities: true, maxDocs: 60, modelTier: "fast", onError: "continue" }),
      N("index", "intel.index", "Index for search", { docIds: "{{steps.extract.output.docIds}}", embed: true, chunkSize: 1200, onError: "continue" }),
      N("entities", "intel.entities", "Link judges, advocates and courts", { docIds: "{{steps.extract.output.docIds}}", relations: true, onError: "continue" }),
      N("recent", "data.query", "Judgments in the last 90 days", { source: "intel_documents", q: "", filters: { kinds: "opinion" }, matterId: "", since: "-90d", limit: 1, sort: "date", direction: "desc" }),
      anyNew("any", "recent", "Any judgments?"),
      N("trends", "intel.analyze", "Authority trend (90 days)", { analysis: "trends", scope: { matterId: "", kinds: ["opinion"], entityIds: "", court: "", jurisdiction: "", dateFrom: "-90d", dateTo: "", q: "" }, title: "Judgments — Supreme Court and focus High Courts, last 90 days", maxDocs: 800, onError: "continue" }),
      N("verify", "intel.verify", "Verify the insight", { target: "insights", insightIds: "{{steps.trends.output.insightIds}}", steps: "", limit: 5, onError: "continue" }),
      N("publish", "intel.publish", "Publish to Home", { to: "home", insightIds: "{{steps.trends.output.insightIds}}", items: "", title: "", summary: "", matterId: "", userId: "", recipientIds: [], libraryFolderId: "", requireVerified: false, onError: "continue" }),
    ],
    edges: [E("schedule", "sci"), E("schedule", "hc"), E("schedule", "kanoon"), E("sci", "steward"), E("hc", "steward"), E("kanoon", "steward"), E("steward", "new"), E("new", "extract"), E("extract", "index"), E("extract", "entities"), E("index", "recent"), E("entities", "recent"), E("recent", "any"), E("any", "trends", "yes"), E("trends", "verify"), E("verify", "publish")],
  },
  {
    id: SYSTEM_WORKFLOW_IDS.regulatoryWatch,
    name: "Statute watch — India Code",
    description: "Weekly: refresh the central codes (BNS, BNSS, BSA, CPC, Limitation Act, Contract Act…) and the Acts of Karnataka, Telangana and Andhra Pradesh from India Code; extract and index what changed; when anything changed, refresh the 30-day statute trend, verify it and publish it to Home.",
    category: "automation",
    tags: ["system", "statutes", "India Code", "India", "weekly"],
    inputs: [],
    nodes: [
      N("schedule", "trigger.schedule", "Weekly, Sunday 04:00", { schedule: { frequency: "weekly", time: "04:00", weekday: 0 }, enabled: true, presetInputs: {} }),
      fetch("code", "Fetch Acts and sections (India Code)", IN.indiaCode, { maxDocs: 200 }),
      steward("steward", "code"),
      N("extract", "intel.extract", "Extract and summarize", { docIds: "{{steps.code.output.docIds}}", blobIds: "", summarize: true, entities: true, maxDocs: 60, modelTier: "fast", onError: "continue" }),
      N("index", "intel.index", "Index", { docIds: "{{steps.extract.output.docIds}}", embed: true, chunkSize: 1200, onError: "continue" }),
      N("fresh", "data.query", "Statutes changed this week", { source: "intel_documents", q: "", filters: { kinds: "statute" }, matterId: "", since: "-7d", limit: 100, sort: "date", direction: "desc" }),
      anyNew("any", "fresh"),
      N("trends", "intel.analyze", "Statute trend (30 days)", { analysis: "trends", scope: { matterId: "", kinds: ["statute"], entityIds: "", court: "", jurisdiction: "", dateFrom: "-30d", dateTo: "", q: "" }, title: "Statutes — last 30 days", maxDocs: 400, onError: "continue" }),
      N("verify", "intel.verify", "Verify the insight", { target: "insights", insightIds: "{{steps.trends.output.insightIds}}", steps: "", limit: 5, onError: "continue" }),
      N("publish", "intel.publish", "Publish to Home", { to: "home", insightIds: "{{steps.trends.output.insightIds}}", items: "", title: "", summary: "", matterId: "", userId: "", recipientIds: [], libraryFolderId: "", requireVerified: false, onError: "continue" }),
    ],
    edges: [E("schedule", "code"), E("code", "steward"), E("steward", "extract"), E("extract", "index"), E("index", "fresh"), E("fresh", "any"), E("any", "trends", "yes"), E("trends", "verify"), E("verify", "publish")],
  },
  {
    id: SYSTEM_WORKFLOW_IDS.profiles,
    name: "Judge and advocate profiles",
    description: "Weekly: re-link judges, advocates and firms across the judgments ingested in the last 90 days, rebuild their profiles (courts, benches, activity, related people), verify them and publish them to Home.",
    category: "automation",
    tags: ["system", "judges", "advocates", "profiles", "weekly"],
    inputs: [],
    nodes: [
      N("schedule", "trigger.schedule", "Weekly, Sunday 03:00", { schedule: { frequency: "weekly", time: "03:00", weekday: 0 }, enabled: true, presetInputs: {} }),
      N("recent", "data.query", "Judgments (90 days)", { source: "intel_documents", q: "", filters: { kinds: "opinion" }, matterId: "", since: "-90d", limit: 300, sort: "date", direction: "desc" }),
      N("entities", "intel.entities", "Link judges, advocates and firms", { docIds: "{{steps.recent.output.ids}}", relations: true, onError: "continue" }),
      N("profiles", "intel.analyze", "Profiles", { analysis: "profiles", scope: { matterId: "", kinds: ["opinion", "judge", "attorney", "firm"], entityIds: "", court: "", jurisdiction: "", dateFrom: "-365d", dateTo: "", q: "" }, title: "", maxDocs: 1000, onError: "continue" }),
      N("verify", "intel.verify", "Verify profiles", { target: "insights", insightIds: "{{steps.profiles.output.insightIds}}", steps: "", limit: 10, onError: "continue" }),
      N("publish", "intel.publish", "Publish to Home", { to: "home", insightIds: "{{steps.profiles.output.insightIds}}", items: "", title: "", summary: "", matterId: "", userId: "", recipientIds: [], libraryFolderId: "", requireVerified: false, onError: "continue" }),
    ],
    edges: [E("schedule", "recent"), E("recent", "entities"), E("entities", "profiles"), E("profiles", "verify"), E("verify", "publish")],
  },
];

/** US-bound system workflows left out of the India default set (their sources are not in the India catalog). */
export const US_ONLY_SYSTEM_WORKFLOW_IDS: readonly string[] = [SYSTEM_WORKFLOW_IDS.docketWatch, SYSTEM_WORKFLOW_IDS.mdlTracker, SYSTEM_WORKFLOW_IDS.newsWatch];

function materialize(t: SystemDef): Workflow {
  return { ...t, nodes: autoLayout(t.nodes, t.edges), status: "active", isTemplate: false, system: true, ownerId: undefined, createdAt: T0, updatedAt: T0, runsCount: 0 };
}

/**
 * The default (India) system workflows with positions computed by the layered layout. Active, not templates,
 * `system: true`. Source-bound workflows point at the India sources; jurisdiction-neutral ones are unchanged.
 */
export function buildSystemTemplates(): Workflow[] {
  const override = new Map(INDIA_OVERRIDES.map((w) => [w.id, w]));
  const usOnly = new Set(US_ONLY_SYSTEM_WORKFLOW_IDS);
  return SYSTEM.filter((t) => !usOnly.has(t.id)).map((t) => materialize(override.get(t.id) ?? t));
}

/** The upstream US system workflows (CourtListener, JPML, Federal Register, eCFR, openFDA, news), for the US sample dataset. */
export function buildUsSystemTemplates(): Workflow[] {
  return SYSTEM.map(materialize);
}

export function systemWorkflowById(id: string): Workflow | undefined {
  return buildSystemTemplates().find((w) => w.id === id);
}
