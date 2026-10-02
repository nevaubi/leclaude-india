/** One-line summaries of node configurations (canvas cards, the Start page step list). Pure and client-safe. */
import { describeSchedule, normalizeSchedule } from "../schedule";

function s(v: unknown, n = 60): string {
  const t = typeof v === "string" ? v : v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
  const one = t.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
}

/** One-line summary of a node's configuration shown on the canvas card. */
export function nodeSummary(type: string, c: Record<string, unknown>): string {
  switch (type) {
    case "trigger.manual": return "Run from the toolbar with a form";
    case "trigger.schedule": return describeSchedule(normalizeSchedule(c.schedule));
    case "trigger.document_added": return `Docs${Array.isArray(c.kinds) && c.kinds.length ? ` (${(c.kinds as string[]).join(", ")})` : ""}${c.folderName ? ` in "${s(c.folderName, 20)}"` : ""}`;
    case "trigger.docket_update": return c.docketQuery ? `"${s(c.docketQuery, 40)}"` : "Any monitored docket";
    case "trigger.email": return s(c.address, 40);
    case "ai.prompt": return s(c.prompt, 70) || "No prompt";
    case "ai.extract": return `${Array.isArray(c.fields) ? c.fields.length : 0} fields from ${s(c.source, 30)}`;
    case "ai.classify": return (Array.isArray(c.labels) ? (c.labels as { label: string }[]).map((l) => l.label) : []).join(" · ") || "No labels";
    case "ai.summarize": return `${s(c.style, 12)} · ${s(c.length, 8)}${c.focus ? ` · ${s(c.focus, 30)}` : ""}`;
    case "ai.draft": return `${s(c.kind, 14)} · ${s(c.tone, 12)} · for ${s(c.audience, 10)}`;
    case "ai.review": return `${Array.isArray(c.checklist) ? c.checklist.length : 0} checklist items`;
    case "ai.research": return s(c.question, 70) || "No question";
    case "data.search_library": return s(c.query, 60) || "No query";
    case "data.search_ediscovery": return `${s(c.query, 40) || "*"}${c.privilegedOnly ? " · privileged" : ""}${c.hotOnly ? " · hot" : ""}`;
    case "data.legal_search": return `${s(c.source, 18)} · ${s(c.source === "verify_citations" ? c.text : c.query, 40)}`;
    case "data.fetch_url": return s(c.url, 60);
    case "data.official_order": return c.orderRef ? `Order ${s(c.orderRef, 44)}` : c.caseNumber ? `Latest order · ${s(c.caseNumber, 40)}` : "Latest order · tracked identifiers";
    case "logic.branch": return `${Array.isArray(c.rules) ? c.rules.length : 0} rule(s) + else`;
    case "logic.loop": return `over ${s(c.over, 50)} (max ${c.maxIterations ?? 50})`;
    case "logic.merge": return c.mode === "any" ? "Continue when any branch succeeds" : "Wait for all branches";
    case "logic.approval": return s(c.title, 50) || "Approval";
    case "logic.delay": return `Wait ${c.minutes ?? 0} min`;
    case "action.create_task": return s(c.title, 60);
    case "action.create_event": return `${s(c.kind, 12)} · ${s(c.title, 45)}`;
    case "action.save_document": return `${c.kind === "sheet" ? "Workbook" : "Word"} · ${s(c.title, 45)}`;
    case "action.notify": return `${Array.isArray(c.recipientIds) ? c.recipientIds.length : 0} recipient(s) · ${s(c.message, 40)}`;
    case "action.export": return `${s(c.format, 10)} · ${s(c.filename, 40)}`;
    case "action.update_coding": return `${s(c.field, 16)} = ${s(c.value, 20)}`;
    case "intel.fetch": return c.sourceId ? `Source ${s(c.sourceId, 32)}` : c.adapter ? `Adapter ${s(c.adapter, 24)}` : "No source";
    case "intel.extract": return `${s(c.docIds, 40) || "upstream documents"}${c.summarize === false ? "" : " · summaries"}${c.entities === false ? "" : " · entities"}`;
    case "intel.index": return `${s(c.docIds, 40) || "documents missing embeddings"}${c.embed === false ? " · keyword only" : " · embed"}`;
    case "intel.entities": return `${s(c.docIds, 44) || "upstream documents"}${c.relations === false ? "" : " · relations"}`;
    case "intel.analyze": { const scope = (c.scope && typeof c.scope === "object" ? c.scope : {}) as Record<string, unknown>; return `${s(c.analysis, 12) || "analysis"}${scope.matterId ? ` · ${s(scope.matterId, 20)}` : ""}${Array.isArray(scope.kinds) && scope.kinds.length ? ` · ${(scope.kinds as string[]).slice(0, 3).join(", ")}` : ""}`; }
    case "intel.verify": return c.target === "sweep" ? "Integrity sweep" : c.target === "steps" ? `Steps ${s(c.steps, 40) || "(all AI steps)"}` : `Insights${c.insightIds ? ` ${s(c.insightIds, 30)}` : " (least recently verified)"}`;
    case "intel.publish": return `to ${s(c.to, 10) || "?"}${c.title ? ` · ${s(c.title, 40)}` : ""}`;
    case "review.auto": return `${Array.isArray(c.fixes) ? c.fixes.length : 0} fix(es) allowed${c.escalate === false ? "" : " · escalates"}${c.steps ? ` · ${s(c.steps, 30)}` : ""}`;
    case "data.query": return `${s(c.source, 18) || "?"}${c.q ? ` · ${s(c.q, 36)}` : ""}${c.limit ? ` · max ${c.limit}` : ""}`;
    case "output.file": return `${s(c.format, 30) || "docx"} · ${s(c.label, 40) || "(label from front end)"}`;
    case "logic.schedule_after": return c.workflowId ? `Start ${s(c.workflowId, 30)}${c.wait ? " · wait" : ""}` : "No workflow chosen";
    case "ai.route": return `${Array.isArray(c.branches) ? c.branches.length : 0} branch(es) + else`;
    case "ai.agent": return `${s(c.agent, 12) || "agent"} · ${s(c.brief, 50) || "No brief"}`;
    default: return "";
  }
}
