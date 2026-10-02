/**
 * Export provenance for Word documents (isomorphic, pure): the visible "Declaration on use of AI tools" block, the
 * optional provenance appendix (sources the drafting assistant consulted), and the machine-readable custom document
 * properties written to docProps/custom.xml.
 *
 * Rule: nothing here claims a check that did not run. The citation-check line and properties are generated from the
 * actual check result: "checked" only when the whole check ran, "partial" (with what could not run and citations found
 * vs checked) when part of it did not, "not_run" when nothing ran, "stale" when the document changed after the check.
 * AI use is "true" only when LeClaude recorded it (assistant turns, or a LeClaude AI feature that created the document),
 * otherwise "unknown" — never "false", since use outside LeClaude cannot be known.
 */
import { newId, type PMNode } from "./doc-model";
import { filingSummary, type FilingCheckCounts, type FilingCheckReport } from "./filing-check";
import type { CustomProp } from "./ooxml/custom-props";

export const DECLARATION_HEADING = "Declaration on use of AI tools";

/** Neutral default wording; the user edits it before export. */
export const DEFAULT_DECLARATION =
  "AI tools (LeClaude) were used in preparing this document, for drafting assistance and to check citations. The contents, citations and quotations are the responsibility of the undersigned, who has reviewed them.";

export const DECLARATION_MAX_CHARS = 2000;

/** Where the citation-check figures come from when the export is written. */
export type CheckState =
  | { state: "checked"; checkedAt: string; counts: FilingCheckCounts; summary: string }
  | { state: "partial"; checkedAt: string; counts: FilingCheckCounts; summary: string; reasons: string[] }
  | { state: "stale"; checkedAt: string; counts: FilingCheckCounts; summary: string }
  | { state: "not_run"; reason: string };

/** The state an export records for a check report (or for no report: `reason` says why). */
export function checkStateOf(report: FilingCheckReport | null | undefined, reason = "the check could not run"): CheckState {
  if (!report) return { state: "not_run", reason };
  if (report.coverage === "not_run") return { state: "not_run", reason: report.unavailable.join(" ") || reason };
  const base = { checkedAt: report.checkedAt, counts: report.counts, summary: filingSummary(report.counts) };
  return report.coverage === "partial" ? { state: "partial", ...base, reasons: report.unavailable } : { state: "checked", ...base };
}

export interface ProvenanceSourceItem { kind: string; title?: string; cite?: string; url?: string }

const p = (text: string, attrs: Record<string, unknown> = {}): PMNode => ({ type: "paragraph", attrs: { id: newId(), ...attrs }, content: text ? [{ type: "text", text }] : [] });
const italic = (text: string): PMNode => ({ type: "paragraph", attrs: { id: newId() }, content: [{ type: "text", text, marks: [{ type: "italic" }] }] });

function day(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata" });
}

/** The factual line about the automated citation check (generated, not editable). */
export function checkLine(check: CheckState): string {
  if (check.state === "not_run") return `No automated citation check ran for this version of the document (${check.reason.replace(/\.$/, "")}).`;
  const c = check.counts;
  const found = c.found ?? c.citations;
  const checked = c.checked ?? c.citations;
  const s = (n: number) => (n === 1 ? "" : "s");
  const head = check.state === "partial"
    ? `An automated citation check on ${day(check.checkedAt)} ran only in part (${check.reasons.map((r) => r.replace(/\.$/, "")).join("; ")}). It found ${found} case citation${s(found)} and checked ${checked}`
    : `An automated citation check on ${day(check.checkedAt)} found ${found} case citation${s(found)} and checked ${checked === found ? (found === 1 ? "it" : "all of them") : checked}`;
  const result = checked ? `: ${c.resolved} resolved, ${c.ambiguous} ambiguous and ${c.unresolved} not resolved` : "";
  const citator = c.resolved ? ` The citator was consulted for ${c.citatorChecked ?? 0} of the ${c.resolved} resolved citation${s(c.resolved)}${c.negative ? `, ${c.negative} with negative citator text cues` : ""}.` : "";
  const quotes = c.quotesChecked || c.quotesUnchecked ? ` Quotations: ${c.quotesFound} matched the judgment text, ${c.quotesNotFound} did not, ${c.quotesUnchecked} could not be checked.` : "";
  const stale = check.state === "stale" ? " The document was changed after that check." : "";
  return `${head}${result}.${citator}${quotes}${stale} An automated check is not a substitute for reading the authorities.`;
}

/** Visible declaration block appended at the end of the document (page break, heading, text, check line). */
export function declarationBlocks(text: string, check: CheckState): PMNode[] {
  const body = (text ?? "").replace(/\r\n?/g, "\n").slice(0, DECLARATION_MAX_CHARS).trim() || DEFAULT_DECLARATION;
  return [
    { type: "pageBreak", attrs: { id: newId() } },
    { type: "heading", attrs: { id: newId(), level: 2 }, content: [{ type: "text", text: DECLARATION_HEADING }] },
    ...body.split(/\n{2,}/).map((para) => p(para.replace(/\n/g, " ").trim())),
    italic(checkLine(check)),
  ];
}

/** Distinct sources (by url, cite or title), in first-seen order. */
export function dedupeSourceItems(items: ProvenanceSourceItem[]): ProvenanceSourceItem[] {
  const seen = new Set<string>();
  const out: ProvenanceSourceItem[] = [];
  for (const s of items) {
    const k = (s.url || s.cite || s.title || "").trim().toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

const KIND_LABEL: Record<string, string> = { "case-law": "Case law", regulation: "Statute / regulation", web: "Web", library: "Firm library", document: "Matter document", deposition: "Deposition", docket: "Docket", internal: "Internal" };

/** Provenance appendix: the sources the drafting assistant consulted (from its recorded turns). Empty when none. */
export function appendixBlocks(sources: ProvenanceSourceItem[], turns: number): PMNode[] {
  const list = dedupeSourceItems(sources).slice(0, 200);
  const head: PMNode[] = [
    { type: "pageBreak", attrs: { id: newId() } },
    { type: "heading", attrs: { id: newId(), level: 2 }, content: [{ type: "text", text: "Provenance appendix" }] },
  ];
  if (!list.length) return [...head, p(turns ? `The drafting assistant was used in ${turns} recorded turn${turns === 1 ? "" : "s"} and recorded no sources.` : "No drafting-assistant activity is recorded for this document.")];
  return [
    ...head,
    p(`Sources the drafting assistant consulted while working on this document (${turns} recorded turn${turns === 1 ? "" : "s"}). A source listed here was consulted; this list does not show that any particular statement was checked against it.`),
    {
      type: "orderedList", attrs: { id: newId(), start: 1 },
      content: list.map((s) => ({
        type: "listItem", attrs: { id: newId() },
        content: [p([s.title || s.cite || s.url || "Untitled source", s.cite && s.title ? ` — ${s.cite}` : "", ` (${KIND_LABEL[s.kind] ?? s.kind})`, s.url && /^https?:\/\//.test(s.url) ? ` ${s.url}` : ""].join(""))],
      })),
    },
  ];
}

export interface ExportProvenanceInput {
  exportedAt: string;
  docHash: string;
  check: CheckState;
  /** "editor": exported through the Word editor's filing-check gate; "none": any other path (no gate was shown). */
  gate?: "editor" | "none";
  /** Items the gate listed for this export (unresolved, ambiguous, unchecked…), when a check ran. */
  openIssues?: number;
  acknowledgement: { acknowledged: boolean; by: string; at: string; items: number; matchesExport: boolean } | null;
  assistantTurns: number;
  /** LeClaude AI features recorded as having produced this document's content (e.g. "documents.parawise: …"). */
  aiSurfaces?: string[];
  providerRole: string;
  models: string[];
  declaration: boolean;
  appendix: { included: boolean; sources: number };
}

/** Word documents a LeClaude AI feature creates (meta.source), when the creator did not record meta.ai itself. */
const AI_SOURCES: Record<string, string> = {
  "documents.dates": "list of dates from AI-extracted timeline events (synopsis drafted by AI when present)",
  "documents.parawise": "para-wise reply with AI-proposed responses",
  "documents.translate": "AI working translation",
  "search-research": "AI research answer",
};

/** AI use recorded on a document's metadata: meta.ai (written by the feature that created it), else a known AI source. */
export function aiSurfacesFromMeta(meta: Record<string, unknown> | null | undefined): string[] {
  if (!meta) return [];
  const source = typeof meta.source === "string" ? meta.source.slice(0, 80) : "";
  const ai = meta.ai && typeof meta.ai === "object" ? (meta.ai as { assisted?: unknown; surface?: unknown; detail?: unknown }) : null;
  if (ai) {
    if (ai.assisted !== true) return [];
    const surface = typeof ai.surface === "string" && ai.surface ? ai.surface.slice(0, 80) : source || "LeClaude";
    return [`${surface}${typeof ai.detail === "string" && ai.detail.trim() ? `: ${ai.detail.trim().slice(0, 300)}` : ""}`];
  }
  return AI_SOURCES[source] ? [`${source}: ${AI_SOURCES[source]}`] : [];
}

/** Machine-readable provenance properties (LeClaude.* names, replaced on every export). */
export function exportCustomProps(i: ExportProvenanceInput): CustomProp[] {
  const props: CustomProp[] = [
    { name: "LeClaude.Export.Tool", value: "LeClaude Word" },
    { name: "LeClaude.Export.At", value: new Date(i.exportedAt) },
    { name: "LeClaude.Document.Hash", value: `sha256:${i.docHash}` },
    { name: "LeClaude.Document.HashScope", value: "Body text (tracked deletions excluded), before any appended declaration or appendix" },
    // true only when recorded; otherwise "unknown" (AI use outside LeClaude cannot be known), never false.
    { name: "LeClaude.AI.Assisted", value: i.assistantTurns > 0 || (i.aiSurfaces?.length ?? 0) > 0 ? true : "unknown" },
    { name: "LeClaude.AI.AssistantTurns", value: i.assistantTurns },
    { name: "LeClaude.AI.Basis", value: [i.assistantTurns ? `drafting assistant (${i.assistantTurns} recorded turn${i.assistantTurns === 1 ? "" : "s"})` : "", ...(i.aiSurfaces ?? [])].filter(Boolean).join("; ").slice(0, 1000) || "no AI use recorded by LeClaude for this document" },
    { name: "LeClaude.AI.ProviderRole", value: i.providerRole },
    { name: "LeClaude.AI.Models", value: i.models.length ? i.models.join(", ") : "none recorded" },
    { name: "LeClaude.CitationCheck.State", value: i.check.state },
  ];
  if (i.gate) props.push({ name: "LeClaude.FilingCheck.Gate", value: i.gate });
  if (i.check.state === "not_run") props.push({ name: "LeClaude.CitationCheck.Reason", value: i.check.reason.slice(0, 1000) });
  else {
    const c = i.check.counts;
    if (i.check.state === "partial") props.push({ name: "LeClaude.CitationCheck.Unavailable", value: i.check.reasons.join(" ").slice(0, 1000) });
    props.push(
      { name: "LeClaude.CitationCheck.At", value: new Date(i.check.checkedAt) },
      { name: "LeClaude.CitationCheck.Citations", value: c.citations },
      { name: "LeClaude.CitationCheck.CitationsFound", value: c.found ?? c.citations },
      { name: "LeClaude.CitationCheck.CitationsChecked", value: c.checked ?? c.citations },
      { name: "LeClaude.CitationCheck.Resolved", value: c.resolved },
      { name: "LeClaude.CitationCheck.Ambiguous", value: c.ambiguous },
      { name: "LeClaude.CitationCheck.Unresolved", value: c.unresolved },
      { name: "LeClaude.CitationCheck.Unchecked", value: c.unchecked ?? 0 },
      { name: "LeClaude.CitationCheck.CitatorChecked", value: c.citatorChecked ?? 0 },
      { name: "LeClaude.CitationCheck.CitatorUnchecked", value: c.citatorUnchecked ?? 0 },
      { name: "LeClaude.CitationCheck.NegativeSignals", value: c.negative },
      { name: "LeClaude.CitationCheck.QuotesFound", value: c.quotesFound },
      { name: "LeClaude.CitationCheck.QuotesNotFound", value: c.quotesNotFound },
      { name: "LeClaude.CitationCheck.QuotesUnchecked", value: c.quotesUnchecked },
      { name: "LeClaude.CitationCheck.Summary", value: i.check.summary },
    );
  }
  if (i.openIssues != null) props.push({ name: "LeClaude.FilingCheck.OpenIssues", value: i.openIssues });
  // Items were listed (or no check ran) and nobody acknowledged them: say so rather than leave it blank.
  if (!i.acknowledgement && ((i.openIssues ?? 0) > 0 || i.check.state === "not_run")) props.push({ name: "LeClaude.FilingCheck.Acknowledged", value: false });
  if (i.acknowledgement) {
    props.push(
      { name: "LeClaude.FilingCheck.Acknowledged", value: i.acknowledgement.acknowledged },
      { name: "LeClaude.FilingCheck.AcknowledgedBy", value: i.acknowledgement.by },
      { name: "LeClaude.FilingCheck.AcknowledgedAt", value: new Date(i.acknowledgement.at) },
      { name: "LeClaude.FilingCheck.AcknowledgedItems", value: i.acknowledgement.items },
      { name: "LeClaude.FilingCheck.AckMatchesExport", value: i.acknowledgement.matchesExport },
    );
  }
  props.push(
    { name: "LeClaude.Declaration.Included", value: i.declaration },
    { name: "LeClaude.ProvenanceAppendix.Included", value: i.appendix.included },
    { name: "LeClaude.ProvenanceAppendix.Sources", value: i.appendix.sources },
  );
  return props;
}

/** Minimal HTML for the declaration block (print / PDF path), escaped. */
export function declarationHtml(text: string, check: CheckState): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
  const body = (text ?? "").replace(/\r\n?/g, "\n").slice(0, DECLARATION_MAX_CHARS).trim() || DEFAULT_DECLARATION;
  return `<div class="page-break"></div><h2>${esc(DECLARATION_HEADING)}</h2>${body.split(/\n{2,}/).map((x) => `<p>${esc(x.replace(/\n/g, " ").trim())}</p>`).join("")}<p><em>${esc(checkLine(check))}</em></p>`;
}
