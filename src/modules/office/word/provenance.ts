/**
 * Export provenance for Word documents (isomorphic, pure): the visible "Declaration on use of AI tools" block, the
 * optional provenance appendix (sources the drafting assistant consulted), and the machine-readable custom document
 * properties written to docProps/custom.xml.
 *
 * Rule: nothing here claims a check that did not run. The citation-check line and properties are generated from the
 * actual check result (or say plainly that no check ran / that the document changed after the check).
 */
import { newId, type PMNode } from "./doc-model";
import type { FilingCheckCounts } from "./filing-check";
import type { CustomProp } from "./ooxml/custom-props";

export const DECLARATION_HEADING = "Declaration on use of AI tools";

/** Neutral default wording; the user edits it before export. */
export const DEFAULT_DECLARATION =
  "AI tools (LeClaude) were used in preparing this document, for drafting assistance and to check citations. The contents, citations and quotations are the responsibility of the undersigned, who has reviewed them.";

export const DECLARATION_MAX_CHARS = 2000;

/** Where the citation-check figures come from when the export is written. */
export type CheckState =
  | { state: "checked"; checkedAt: string; counts: FilingCheckCounts; summary: string }
  | { state: "stale"; checkedAt: string; counts: FilingCheckCounts; summary: string }
  | { state: "not_run"; reason: string };

export interface ProvenanceSourceItem { kind: string; title?: string; cite?: string; url?: string }

const p = (text: string, attrs: Record<string, unknown> = {}): PMNode => ({ type: "paragraph", attrs: { id: newId(), ...attrs }, content: text ? [{ type: "text", text }] : [] });
const italic = (text: string): PMNode => ({ type: "paragraph", attrs: { id: newId() }, content: [{ type: "text", text, marks: [{ type: "italic" }] }] });

function day(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata" });
}

/** The factual line about the automated citation check (generated, not editable). */
export function checkLine(check: CheckState): string {
  if (check.state === "not_run") return `No automated citation check was recorded for this version of the document (${check.reason}).`;
  const c = check.counts;
  const base = `An automated citation check on ${day(check.checkedAt)} found ${c.citations} case citation${c.citations === 1 ? "" : "s"}: ${c.resolved} resolved, ${c.ambiguous} ambiguous and ${c.unresolved} not resolved${c.negative ? `; ${c.negative} with negative citator text cues` : ""}.`;
  const quotes = c.quotesChecked || c.quotesUnchecked ? ` Quotations: ${c.quotesFound} matched the judgment text, ${c.quotesNotFound} did not, ${c.quotesUnchecked} could not be checked.` : "";
  const stale = check.state === "stale" ? " The document was changed after that check." : "";
  return `${base}${quotes}${stale} An automated check is not a substitute for reading the authorities.`;
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
  acknowledgement: { acknowledged: boolean; by: string; at: string; items: number; matchesExport: boolean } | null;
  assistantTurns: number;
  providerRole: string;
  models: string[];
  declaration: boolean;
  appendix: { included: boolean; sources: number };
}

/** Machine-readable provenance properties (LeClaude.* names, replaced on every export). */
export function exportCustomProps(i: ExportProvenanceInput): CustomProp[] {
  const props: CustomProp[] = [
    { name: "LeClaude.Export.Tool", value: "LeClaude Word" },
    { name: "LeClaude.Export.At", value: new Date(i.exportedAt) },
    { name: "LeClaude.Document.Hash", value: `sha256:${i.docHash}` },
    { name: "LeClaude.Document.HashScope", value: "Body text (tracked deletions excluded), before any appended declaration or appendix" },
    { name: "LeClaude.AI.Assisted", value: i.assistantTurns > 0 },
    { name: "LeClaude.AI.AssistantTurns", value: i.assistantTurns },
    { name: "LeClaude.AI.ProviderRole", value: i.providerRole },
    { name: "LeClaude.AI.Models", value: i.models.length ? i.models.join(", ") : "none recorded" },
    { name: "LeClaude.CitationCheck.State", value: i.check.state },
  ];
  if (i.check.state === "not_run") props.push({ name: "LeClaude.CitationCheck.Reason", value: i.check.reason });
  else {
    const c = i.check.counts;
    props.push(
      { name: "LeClaude.CitationCheck.At", value: new Date(i.check.checkedAt) },
      { name: "LeClaude.CitationCheck.Citations", value: c.citations },
      { name: "LeClaude.CitationCheck.Resolved", value: c.resolved },
      { name: "LeClaude.CitationCheck.Ambiguous", value: c.ambiguous },
      { name: "LeClaude.CitationCheck.Unresolved", value: c.unresolved },
      { name: "LeClaude.CitationCheck.NegativeSignals", value: c.negative },
      { name: "LeClaude.CitationCheck.QuotesFound", value: c.quotesFound },
      { name: "LeClaude.CitationCheck.QuotesNotFound", value: c.quotesNotFound },
      { name: "LeClaude.CitationCheck.QuotesUnchecked", value: c.quotesUnchecked },
      { name: "LeClaude.CitationCheck.Summary", value: i.check.summary },
    );
  }
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
