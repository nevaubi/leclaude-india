/**
 * Research memo markdown builder. The output feeds markdownToDoc() from the
 * office module, which supports headings, paragraphs, lists and pipe tables.
 * Client-safe.
 */
import { formatBluebook } from "./normalize";
import { courtAbbreviation } from "./jurisdictions";
import { SOURCE_LABEL, type MemoSource, type SearchHit } from "./types";
import type { ResearchMessage, ResearchSource } from "./engine/types";
import { annotateAnswer, citationCounts, isMessageVerificationCurrent, messageTrustState, SOURCE_STATE_LABEL, sourceTrustState } from "./engine/trust";
import { indiaTableOfAuthoritiesMarkdown } from "./engine/authorities";
import { authorityStatusMarkdown } from "./engine/authority-status";
import { indianDate } from "./india-citations";
import { TREATMENT_LABEL } from "./engine/treatment";

export interface MemoInput {
  question: string;
  briefAnswer?: string;
  analysis?: string;
  sources: MemoSource[];
  openIssues?: string[];
  author?: string;
  matterName?: string;
  matterCaption?: string;
  jurisdictionLabel?: string;
  date?: string; // ISO
  synthesis?: string; // full AI synthesis; used to derive brief answer/analysis when not given
  /** Pinned passages (verbatim quotations with an optional note and source cite). */
  passages?: { text: string; note?: string; cite?: string }[];
}

function cell(s: string | undefined) {
  return (s ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim() || "—";
}

/** Split a synthesis into a brief answer (first paragraph(s)) and the rest. */
export function splitSynthesis(text: string | undefined): { briefAnswer: string; analysis: string } {
  const t = (text ?? "").trim();
  if (!t) return { briefAnswer: "", analysis: "" };
  const lines = t.split("\n");
  // Prefer an explicit "Answer"/"Brief answer" section if the agent produced one.
  const idx = lines.findIndex((l, i) => i > 0 && /^#{1,3}\s*(analysis|discussion)/i.test(l));
  if (idx > 0) {
    const head = lines.slice(0, idx).filter((l) => !/^#{1,3}\s*(answer|brief answer|short answer)/i.test(l)).join("\n").trim();
    return { briefAnswer: head, analysis: lines.slice(idx + 1).join("\n").trim() };
  }
  const paras = t.split(/\n\s*\n/);
  return { briefAnswer: paras[0].replace(/^#{1,3}\s*(answer|brief answer|short answer)[:\s]*/i, "").trim(), analysis: paras.slice(1).join("\n\n").trim() };
}

export function sourceHolding(s: MemoSource): string {
  if (s.note?.trim()) return s.note.trim();
  const snip = (s.hit.snippet ?? "").replace(/\s+/g, " ").trim();
  return snip.length > 220 ? snip.slice(0, 217).trimEnd() + "…" : snip;
}

export function authoritiesTable(sources: MemoSource[]): string {
  const header = "| # | Source | Citation | Court / Agency | Date | Holding / relevance |\n|---|---|---|---|---|---|";
  const rows = sources.map((s, i) => {
    const h = s.hit;
    const court = h.source === "caselaw" || h.source === "dockets" ? courtAbbreviation(h.courtId, h.court) : h.source === "federal_register" ? (h.fr?.agencies ?? []).join(", ") : h.source === "ediscovery" ? h.edoc?.custodian ?? "" : h.subtitle ?? "";
    return `| ${i + 1} | ${cell(SOURCE_LABEL[h.source])} | ${cell(formatBluebook(h))} | ${cell(court)} | ${cell(h.date ? indianDate(h.date) : "")} | ${cell(sourceHolding(s))} |`;
  });
  return [header, ...rows].join("\n");
}

export function memoTitle(question: string) {
  const q = question.replace(/\s+/g, " ").trim();
  return `Research memo — ${q.length > 70 ? q.slice(0, 67).trimEnd() + "…" : q}`;
}

/** Produce the memo markdown. Sections follow the firm's memo template. */
export function buildMemoMarkdown(input: MemoInput): string {
  const derived = splitSynthesis(input.synthesis);
  const briefAnswer = (input.briefAnswer ?? "").trim() || derived.briefAnswer || "[Brief answer to be completed after review of the authorities below.]";
  const analysis = (input.analysis ?? "").trim() || derived.analysis || "[Analysis to be completed.]";
  const date = indianDate(input.date ?? new Date().toISOString());
  const lines: string[] = [];
  lines.push("# " + memoTitle(input.question));
  lines.push("");
  lines.push("**PRIVILEGED & CONFIDENTIAL — ATTORNEY WORK PRODUCT**");
  lines.push("");
  lines.push(`**To:** File${input.matterName ? ` — ${input.matterName}${input.matterCaption ? ` (${input.matterCaption})` : ""}` : ""}`);
  lines.push(`**From:** ${input.author ?? "Research agent"}`);
  lines.push(`**Date:** ${date}`);
  if (input.jurisdictionLabel) lines.push(`**Forum:** ${input.jurisdictionLabel}`);
  lines.push("");
  lines.push("## Question presented");
  lines.push("");
  lines.push(input.question.trim());
  lines.push("");
  lines.push("## Brief answer");
  lines.push("");
  lines.push(briefAnswer);
  lines.push("");
  lines.push("## Analysis");
  lines.push("");
  lines.push(analysis);
  lines.push("");
  lines.push("## Authorities");
  lines.push("");
  if (input.sources.length) lines.push(authoritiesTable(input.sources));
  else lines.push("_No authorities were pinned._");
  lines.push("");
  const passages = (input.passages ?? []).filter((p) => p.text.trim());
  if (passages.length) {
    lines.push("## Key passages");
    lines.push("");
    for (const p of passages) {
      lines.push(`> ${p.text.trim().replace(/\n+/g, " ")}${p.cite ? ` — ${p.cite}` : ""}`);
      if (p.note?.trim()) lines.push(`> ${p.note.trim()}`);
      lines.push("");
    }
  }
  lines.push("## Open issues and next steps");
  lines.push("");
  const issues = (input.openIssues ?? []).map((s) => s.trim()).filter(Boolean);
  if (issues.length) for (const i of issues) lines.push(`- ${i}`);
  else {
    lines.push("- Verify every citation above against the full judgment text before filing (use the citation checker).");
    lines.push("- Confirm whether any authority relied on has been overruled, doubted or referred to a larger bench.");
    lines.push("- Identify contrary authority binding on the forum and address it in the analysis.");
  }
  lines.push("");
  return lines.join("\n");
}

/** Plain-text list of numbered citations matching the synthesis' [n] markers. */
export function numberedSourceList(hits: SearchHit[]): string {
  return hits.map((h, i) => `[${i + 1}] ${formatBluebook(h)}${h.url ? ` — ${h.url}` : ""}`).join("\n");
}

// ---------------------------------------------------------------------------
// Research-thread memo (answer + source states + verification + table of authorities)
// ---------------------------------------------------------------------------


/** The thread's sources with the citation numbers of one answer (the persisted pool carries no numbers). */
export function sourcesForMessage(message: Pick<ResearchMessage, "citeMap">, sources: ResearchSource[]): ResearchSource[] {
  const nOf = new Map(Object.entries(message.citeMap ?? {}).map(([n, id]) => [id, Number(n)] as const));
  return sources.map((s) => ({ ...s, n: nOf.get(s.id) }));
}

const TRUST_WORDS: Record<string, string> = { generated: "Generated, not source-checked", source_linked: "Source-linked", citation_checked: "Citations checked", claim_checked: "Claims checked", partially_supported: "Partially supported", verified: "Verified against the sources read", human_approved: "Human approved", rejected: "Rejected", stale: "Stale", unresolved: "Unresolved" };

/** Split an answer into its "## Heading" sections (heading → body), preserving order. */
export function answerSections(text: string): { heading: string; body: string }[] {
  const out: { heading: string; body: string }[] = [];
  let cur: { heading: string; body: string[] } | null = null;
  for (const line of (text ?? "").split("\n")) {
    const m = line.match(/^#{1,3}\s+(.+?)\s*$/);
    if (m) { if (cur) out.push({ heading: cur.heading, body: cur.body.join("\n").trim() }); cur = { heading: m[1].trim(), body: [] }; continue; }
    if (!cur) cur = { heading: "", body: [] };
    cur.body.push(line);
  }
  if (cur) out.push({ heading: cur.heading, body: cur.body.join("\n").trim() });
  return out;
}

export interface ResearchMemoInput {
  question: string;
  message: ResearchMessage;
  /** Thread sources (numbers are derived from the message's cite map). */
  sources: ResearchSource[];
  matterName?: string;
  matterCaption?: string;
  jurisdictionLabel?: string;
  author?: string;
  date?: string;
}

/**
 * The research memo: Question Presented, Short Answer, Analysis (pinpoint cites), Contrary Authority, Open Issues
 * (plus the flags verification raised), Sources with their read / snippet / verified states, and a table of
 * authorities. Built from the persisted answer, so unresolved citations and unsupported claims stay visible.
 */
export function buildResearchMemo(input: ResearchMemoInput): string {
  const m = input.message;
  const sources = sourcesForMessage(m, input.sources);
  const cited = sources.filter((s) => s.n != null).sort((a, b) => a.n! - b.n!);
  const shown = annotateAnswer(m, sources);
  const sections = answerSections(shown).filter((s) => !/^sources?( read)?$/i.test(s.heading));
  const get = (re: RegExp) => sections.find((s) => re.test(s.heading));
  const trust = m.content ? messageTrustState(m, sources) : "generated";
  const current = isMessageVerificationCurrent(m);
  const v = m.verification;
  const lines: string[] = [];
  lines.push(`# ${memoTitle(input.question)}`, "", "**PRIVILEGED & CONFIDENTIAL — ATTORNEY WORK PRODUCT**", "");
  lines.push(`**To:** File${input.matterName ? ` — ${input.matterName}${input.matterCaption ? ` (${input.matterCaption})` : ""}` : ""}`);
  lines.push(`**From:** ${input.author ?? "Research agent (AI-generated draft; attorney review required)"}`);
  lines.push(`**Date:** ${indianDate(input.date ?? m.createdAt ?? new Date().toISOString())}`);
  if (input.jurisdictionLabel) lines.push(`**Forum:** ${input.jurisdictionLabel}`);
  if (m.answerLanguage && m.answerLanguage !== "en") lines.push(`**Answer language:** ${m.answerLanguage} (quotations in the language of the source; renderings marked "(translation)")`);
  lines.push(`**Research mode:** ${m.mode === "fast" ? "Fast orientation (one pass, at most two sources read; not a source-reviewed memo)" : "Deep research (parallel lanes, sources read in full, claims checked)"}`);
  lines.push(`**Status:** ${TRUST_WORDS[trust] ?? trust}${v && current ? ` — ${v.supported} of ${v.supported + v.unsupported + v.contradicted} checked claims supported` : v ? " — verdicts are for an earlier draft; this text was not re-verified" : " — no claim was checked against a source read in full"}`);
  lines.push("");
  const qp = get(/question presented/i);
  lines.push("## Question Presented", "", qp?.body || input.question.trim(), "");
  const sa = get(/short answer|^answer$|brief answer/i);
  lines.push("## Short Answer", "", sa?.body || "[Short answer not produced.]", "");
  const analysis = get(/^analysis|discussion/i);
  lines.push("## Analysis", "", analysis?.body || "[No analysis was produced.]", "");
  for (const extra of sections.filter((s) => s.heading && !/question presented|short answer|^answer$|brief answer|^analysis|discussion|contrary authority|open issues|next steps|jurisdictional caveats/i.test(s.heading))) lines.push(`## ${extra.heading}`, "", extra.body, "");
  const caveats = get(/jurisdictional caveats/i);
  if (caveats) lines.push("## Jurisdictional Caveats", "", caveats.body, "");
  const contrary = get(/contrary authority/i);
  lines.push("## Contrary Authority", "", contrary?.body || "No contrary authority section was produced; confirm adverse authority before relying on this memo.", "");
  const open = get(/open issues|next steps/i);
  const flags: string[] = [];
  const cc = citationCounts(m.citations);
  if (cc.unresolved) flags.push(`${cc.unresolved} citation${cc.unresolved === 1 ? "" : "s"} could not be resolved to a source read in this run (marked [VERIFY]).`);
  if (cc.requiresReview) flags.push(`${cc.requiresReview} citation${cc.requiresReview === 1 ? "" : "s"} need review (found but not read, or resolved only remotely).`);
  if (v && current) for (const x of v.verdicts ?? []) if (x.status !== "supported") flags.push(`${x.status === "contradicted" ? "Contradicted" : "Unsupported"}: ${x.claim}${x.sourceN != null ? ` [${x.sourceN}]` : ""}${x.note ? ` — ${x.note}` : ""}`);
  for (const s of cited) if (s.treatment?.signal === "possibly_negative") flags.push(`[${s.n}] ${formatBluebook(s.hit)} — ${TREATMENT_LABEL.possibly_negative}.`);
  for (const s of cited) if (s.currentness && (s.currentness.flag === "dated" || s.currentness.flag === "proposed")) flags.push(`[${s.n}] ${formatBluebook(s.hit)} — ${s.currentness.label}.`);
  for (const g of m.coverage && !m.coverage.complete ? m.coverage.gaps : []) flags.push(`Coverage gap: ${g}`);
  lines.push("## Open Issues", "");
  if (m.transition) lines.push("**Transition law (from the coded savings provisions, not the model):**", "", ...m.transition.lines.map((l) => `- ${l}`), "");
  if (open?.body) lines.push(open.body, "");
  if (flags.length) { lines.push("**Flags from verification (generated by the engine, not the model):**", "", ...flags.map((f) => `- ${f}`), ""); }
  if (!open?.body && !flags.length) lines.push("- Confirm whether each authority has been overruled, doubted or referred to a larger bench before filing.", "");
  lines.push("## Sources", "");
  if (cited.length) {
    lines.push("| # | Citation | Weight | State | Treatment | Currentness |", "|---|---|---|---|---|---|");
    for (const s of cited) {
      const state = SOURCE_STATE_LABEL[sourceTrustState(s, { artifactHash: m.artifactHash, verification: m.verification })];
      lines.push(`| ${s.n} | ${cell(formatBluebook(s.hit))}${s.url && /^https?:/.test(s.url) ? ` ${s.url}` : ""} | ${cell(s.authority && s.authority !== "n/a" ? s.authority : s.scope === "record" ? "record" : "—")} | ${cell(state)} | ${cell(s.treatment ? TREATMENT_LABEL[s.treatment.signal] : "not checked")} | ${cell(s.currentness?.label)} |`);
    }
  } else lines.push("_The answer cites no numbered source._");
  lines.push("");
  // Authority status is bound to the answer hash it was computed for; a revised, unchecked text does not carry it.
  if (m.authorities?.rows.length && m.authorities.artifactHash === m.artifactHash) lines.push(authorityStatusMarkdown(m.authorities), "");
  lines.push(indiaTableOfAuthoritiesMarkdown(m.content, cited));
  if (m.provenance) lines.push("---", "", `_Generated ${new Date(m.provenance.generatedAt).toISOString().slice(0, 16).replace("T", " ")} UTC · ${m.provenance.model} · answer hash ${m.artifactHash?.slice(0, 12) ?? "—"}_`, "");
  return lines.join("\n");
}

/** Table-of-authorities export for one answer. */
export function buildTableOfAuthorities(question: string, message: ResearchMessage, sources: ResearchSource[]): string {
  const numbered = sourcesForMessage(message, sources).filter((s) => s.n != null);
  return `# Table of Authorities\n\n**Question.** ${question.trim()}\n\n${indiaTableOfAuthoritiesMarkdown(message.content, numbered, "Authorities cited")}`;
}
