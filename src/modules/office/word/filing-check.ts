/**
 * Word filing check (isomorphic core; the server wires the dependencies in filing-check-server.ts).
 *
 * Before a draft leaves the app it is checked for:
 *  - citations: every case citation is resolved through the India citation check (one match → resolved, several →
 *    ambiguous, none → unresolved). Nothing is substituted: an ambiguous citation lists its candidates and names none;
 *    an unresolved one stays unresolved. A Supreme Court neutral citation may also resolve by exact match in the
 *    official judgment corpus (the source is recorded);
 *  - citator signals for resolved judgments: negative text cues ("overruled", "per incuriam"…) from the citator,
 *    labelled as text cues, never as verified treatment. A judgment the citator was not consulted for (no official
 *    corpus record, citator not built or unreachable) is counted and listed as such, never as "no negative signal";
 *  - quotations: a quoted passage attributed (deterministically, by position) to a resolved judgment whose text is
 *    available is checked word for word against that text. A quote is "not found" only when the whole text was read.
 *
 * The result binds to a hash of the document body; a changed document makes the check stale. `coverage` says whether
 * the check ran fully ("complete"), only in part ("partial": resolver or corpus down, more citations than the limit) or
 * not at all ("not_run": the citations could not even be read), with citations found vs checked in `counts`.
 */
import { inlineText, type PMNode } from "./doc-model";

/** "unchecked": found in the document but the resolver did not run for it (resolver unavailable). */
export type FilingCitationState = "resolved" | "ambiguous" | "unresolved" | "unchecked";
export type FilingQuoteState = "found" | "not_found" | "text_incomplete" | "text_unavailable";
export type FilingIssueKind = "unresolved" | "ambiguous" | "negative" | "quote_not_found" | "quote_unchecked" | "citator_unchecked" | "check_unavailable";

export interface FilingQuote { quote: string; state: FilingQuoteState; blockId: string | null }

export interface FilingNegative { title: string; court: string | null; decided: string | null; cue: string | null; context: string | null }

export interface FilingCitation {
  /** Stable key (normalised citation text) used for acknowledgements. */
  key: string;
  citation: string;
  state: FilingCitationState;
  resolvedBy: "judgment_store" | "official_corpus" | null;
  title: string | null;
  /** Ambiguous: candidate titles (none chosen). */
  candidates: string[];
  reason: string | null;
  /** Official corpus record id (sc:… / hc:…) when known: the citator and the text are read by this id. */
  corpusId: string | null;
  /**
   * negative_signal / no_negative_signal_found: the citator ran. not_checked: resolved without an official-corpus record,
   * so the citator was not consulted; not_built / unavailable: consulted but no answer. not_applicable: not resolved.
   */
  citator: "negative_signal" | "no_negative_signal_found" | "not_checked" | "not_built" | "unavailable" | "not_applicable";
  negative: FilingNegative[];
  quotes: FilingQuote[];
  /** Text around the first occurrence. */
  context: string;
  occurrences: number;
  /** Block ids where the citation appears (for "show in document"). */
  blockIds: string[];
}

export interface FilingIssue { key: string; kind: FilingIssueKind; citation: string; message: string }

export interface FilingCheckCounts {
  /** Distinct case citations listed in the report (at most FILING_LIMITS.maxCitations). */
  citations: number;
  /** Distinct case citations found in the document (may exceed `citations`). */
  found: number;
  /** Citations the check actually decided (resolved, ambiguous or unresolved). */
  checked: number;
  resolved: number;
  ambiguous: number;
  unresolved: number;
  /** Found but not checked (resolver unavailable). */
  unchecked: number;
  negative: number;
  /** Resolved citations the citator was consulted for (with or without negative cues). */
  citatorChecked: number;
  /** Resolved citations the citator was not consulted for, or gave no answer for. */
  citatorUnchecked: number;
  quotesChecked: number;
  quotesFound: number;
  quotesNotFound: number;
  quotesUnchecked: number;
  statutes: number;
}

export type FilingCoverage = "complete" | "partial" | "not_run";

export interface FilingCheckReport {
  version: 1;
  checkedAt: string;
  coverage: FilingCoverage;
  /** SHA-256 of the document body text the check ran on. */
  docHash: string;
  citations: FilingCitation[];
  counts: FilingCheckCounts;
  issues: FilingIssue[];
  /** Parts of the check that could not run (resolver down, corpus not configured…). */
  unavailable: string[];
  /** Statute / regulation references found (not resolved by this check). */
  statutes: string[];
}

// ---- dependencies ---------------------------------------------------------------------------------------------------

/** The India citation check (`checkCitations` in src/modules/search/service.ts) result, as used here. */
export interface CiteCheckLike {
  extracted: { citation: string; kind: string; index: number; context: string }[];
  checks: { citation: string; resolved: boolean; status?: number; error?: string; matches?: { case_name?: string }[] }[];
  providerError?: string;
}

export interface CorpusJudgmentLike { id: string; title: string; text: string | null; complete: boolean }
export interface CitatorLike { status: "built" | "not_built"; negative: FilingNegative[] }

export interface FilingCheckDeps {
  citecheck(text: string, signal?: AbortSignal): Promise<CiteCheckLike>;
  /** Exact lookup of a citation in the official corpus (null: not there; "unavailable": corpus down / not configured). */
  corpusJudgment?(citation: string, signal?: AbortSignal): Promise<CorpusJudgmentLike | null | "unavailable">;
  citator?(corpusId: string, signal?: AbortSignal): Promise<CitatorLike | null | "unavailable">;
  now?(): Date;
}

export const FILING_LIMITS = { maxCitations: 60, maxQuotesPerCitation: 6, minQuoteWords: 6, concurrency: 4 } as const;

// ---- document text --------------------------------------------------------------------------------------------------

export interface TextBlock { id: string | null; text: string; /** The whole block is a quotation (blockquote or quote style). */ quote: boolean }

/** Text blocks of the document in order (accepted view: tracked deletions dropped); table cells and list items included. */
export function textBlocks(doc: PMNode): TextBlock[] {
  const out: TextBlock[] = [];
  const walk = (n: PMNode, inQuote: boolean) => {
    if (n.type === "paragraph" || n.type === "heading" || n.type === "codeBlock") {
      const text = inlineText(n.content).replace(/\s+/g, " ").trim();
      if (text) out.push({ id: typeof n.attrs?.id === "string" ? n.attrs.id : null, text, quote: inQuote || n.attrs?.pStyle === "quote" || n.attrs?.styleId === "Quote" });
      return;
    }
    for (const c of n.content ?? []) walk(c, inQuote || n.type === "blockquote");
  };
  for (const c of doc.content ?? []) walk(c, false);
  return out;
}

/** The body text the check (and its hash) covers: one block per line. */
export function filingText(doc: PMNode): string {
  return textBlocks(doc).map((b) => b.text).join("\n");
}

const norm = (s: string) => s.normalize("NFKC").replace(/[‘’‚‛′`´]/g, "'").replace(/[“”„‟″«»]/g, '"').replace(/[‐-―−]/g, "-").replace(/\s+/g, " ").trim().toLowerCase();

export const citationKey = (c: string) => norm(c).replace(/[.,;:]+$/, "");

/** True when `quote` occurs in `text` (whitespace / quote style / case insensitive; "…" parts in order). */
export function quoteInText(quote: string, text: string): boolean {
  const parts = quote.split(/\s*(?:\.{3}|…)\s*/).map(norm).filter(Boolean);
  if (!parts.length) return false;
  const hay = norm(text);
  let from = 0;
  for (const p of parts) {
    const i = hay.indexOf(p, from);
    if (i < 0) return false;
    from = i + p.length;
  }
  return true;
}

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

/** Quoted passages inside a block ("…" or “…”), at least `minWords` words. */
export function quotedPassages(text: string, minWords: number = FILING_LIMITS.minQuoteWords): { quote: string; start: number; end: number }[] {
  const out: { quote: string; start: number; end: number }[] = [];
  for (const m of text.matchAll(/“([^”]{8,2000})”|"([^"]{8,2000})"/g)) {
    const q = (m[1] ?? m[2] ?? "").trim();
    if (words(q) >= minWords) out.push({ quote: q, start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
  }
  return out;
}

/**
 * Attribute quotations to citations by position (deterministic; never by meaning):
 * - a quoted passage inside a block that contains exactly one case citation belongs to it; with several, to the
 *   nearest citation within 240 characters after the quote, else before it; otherwise it is not attributed;
 * - a quotation block (blockquote / quote style) belongs to the single case citation of the block just before it,
 *   else of the block just after it.
 */
export function attributeQuotes(blocks: TextBlock[], citations: string[]): Map<string, { quote: string; blockId: string | null }[]> {
  const out = new Map<string, { quote: string; blockId: string | null }[]>();
  const add = (cite: string, quote: string, blockId: string | null) => {
    const k = citationKey(cite);
    const list = out.get(k) ?? [];
    if (!list.some((x) => norm(x.quote) === norm(quote))) list.push({ quote, blockId });
    out.set(k, list);
  };
  const positions = (text: string) => {
    const hits: { cite: string; at: number }[] = [];
    const t = norm(text);
    for (const c of citations) {
      const k = norm(c);
      let i = t.indexOf(k);
      while (i >= 0) { hits.push({ cite: c, at: i }); i = t.indexOf(k, i + k.length); }
    }
    return hits.sort((a, b) => a.at - b.at);
  };
  const cited = blocks.map((b) => positions(b.text));
  const single = (i: number) => { const d = Array.from(new Set((cited[i] ?? []).map((h) => citationKey(h.cite)))); return d.length === 1 ? cited[i][0].cite : null; };
  blocks.forEach((b, i) => {
    if (b.quote) {
      const text = b.text.replace(/^["“]|["”]$/g, "").trim();
      const own = single(i);
      const target = own ?? (i > 0 && !blocks[i - 1].quote ? single(i - 1) : null) ?? (i + 1 < blocks.length ? single(i + 1) : null);
      if (target && words(text) >= FILING_LIMITS.minQuoteWords) add(target, text, b.id);
      return;
    }
    const hits = cited[i];
    if (!hits.length) return;
    const t = norm(b.text);
    for (const q of quotedPassages(b.text)) {
      const distinct = new Set(hits.map((h) => citationKey(h.cite)));
      if (distinct.size === 1) { add(hits[0].cite, q.quote, b.id); continue; }
      // Positions are in normalised text; locate the quote there too.
      const qs = t.indexOf(norm(q.quote));
      if (qs < 0) continue;
      const qe = qs + norm(q.quote).length;
      const after = hits.find((h) => h.at >= qe && h.at - qe <= 240);
      const before = [...hits].reverse().find((h) => h.at < qs && qs - h.at <= 240);
      const target = after ?? before;
      if (target) add(target.cite, q.quote, b.id);
    }
  });
  return out;
}

// ---- run ------------------------------------------------------------------------------------------------------------

/** Run `fn` over items with at most `n` in flight. */
async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

const SC_NEUTRAL = /^\s*(\d{4})\s+INSC\s+(\d{1,6})\s*$/i;

export async function runFilingCheck(doc: PMNode, docHash: string, deps: FilingCheckDeps, signal?: AbortSignal): Promise<FilingCheckReport> {
  const blocks = textBlocks(doc);
  const text = blocks.map((b) => b.text).join("\n");
  const unavailable: string[] = [];
  let cc: CiteCheckLike;
  // Thrown: the citations could not even be read, so nothing about them is known ("not_run").
  let notRun = false;
  try {
    cc = await deps.citecheck(text, signal);
  } catch (e) {
    notRun = true;
    cc = { extracted: [], checks: [], providerError: (e as Error)?.message || "citation check failed" };
  }
  const cases = cc.extracted.filter((c) => c.kind === "case");
  if (notRun) unavailable.push(`Citation check: ${cc.providerError}. No citation was read or checked.`);
  else if (cc.providerError) unavailable.push(`Citation resolver: ${cc.providerError}. Citations found were not checked against the judgment store.`);
  const statutes = Array.from(new Set(cc.extracted.filter((c) => c.kind !== "case").map((c) => c.citation)));
  // One entry per distinct citation (first occurrence keeps the context).
  const byKey = new Map<string, { citation: string; context: string; occurrences: number }>();
  for (const c of cases) {
    const k = citationKey(c.citation);
    const cur = byKey.get(k);
    if (cur) cur.occurrences++; else byKey.set(k, { citation: c.citation, context: c.context, occurrences: 1 });
  }
  const distinct = Array.from(byKey.entries()).slice(0, FILING_LIMITS.maxCitations);
  if (byKey.size > distinct.length) unavailable.push(`${byKey.size} distinct citations were found; only the first ${FILING_LIMITS.maxCitations} were checked.`);
  const checkOf = new Map(cc.checks.map((c) => [citationKey(c.citation), c]));
  const quotesByCite = attributeQuotes(blocks, distinct.map(([, v]) => v.citation));
  const blockIdsOf = (cite: string) => blocks.filter((b) => norm(b.text).includes(norm(cite)) && b.id).map((b) => b.id as string).slice(0, 20);
  let corpusDown = false;
  let citatorDown = false;

  const citations = await pool(distinct, FILING_LIMITS.concurrency, async ([key, v]): Promise<FilingCitation> => {
    const chk = checkOf.get(key);
    const entry: FilingCitation = {
      key, citation: v.citation, state: "unresolved", resolvedBy: null, title: null, candidates: [], reason: null, corpusId: null,
      citator: "not_applicable", negative: [], quotes: [], context: v.context, occurrences: v.occurrences, blockIds: blockIdsOf(v.citation),
    };
    if (chk?.resolved) { entry.state = "resolved"; entry.resolvedBy = "judgment_store"; entry.title = chk.matches?.[0]?.case_name ?? null; }
    else if (chk && chk.status === 300) { entry.state = "ambiguous"; entry.candidates = (chk.matches ?? []).map((m) => m.case_name ?? "").filter(Boolean).slice(0, 5); entry.reason = chk.error ?? "several judgments carry this citation; none was chosen"; }
    else if (chk) entry.reason = chk.error ?? "no judgment carries this citation";
    else { entry.state = "unchecked"; entry.reason = cc.providerError ? "the citation resolver was unavailable" : "the resolver returned no result for it"; }

    // Exact Supreme Court neutral citation in the official corpus (text + citator id). Never for an ambiguous citation.
    let judgment: CorpusJudgmentLike | null = null;
    if (entry.state !== "ambiguous" && deps.corpusJudgment && SC_NEUTRAL.test(v.citation)) {
      try {
        const r = await deps.corpusJudgment(v.citation.replace(/\s+/g, " ").trim(), signal);
        if (r === "unavailable") corpusDown = true;
        else if (r) judgment = r;
      } catch { corpusDown = true; }
      if (judgment) {
        entry.corpusId = judgment.id;
        if (entry.state === "unresolved" || entry.state === "unchecked") { entry.state = "resolved"; entry.resolvedBy = "official_corpus"; entry.title = judgment.title || null; entry.reason = null; }
      }
    }

    if (entry.state === "resolved" && entry.corpusId && deps.citator) {
      try {
        const c = await deps.citator(entry.corpusId, signal);
        if (c === "unavailable" || !c) { entry.citator = "unavailable"; if (c === "unavailable") citatorDown = true; }
        else if (c.status === "not_built") entry.citator = "not_built";
        else { entry.negative = c.negative.slice(0, 5); entry.citator = c.negative.length ? "negative_signal" : "no_negative_signal_found"; }
      } catch { entry.citator = "unavailable"; citatorDown = true; }
    } else if (entry.state === "resolved") entry.citator = "not_checked";

    const qs = (quotesByCite.get(key) ?? []).slice(0, FILING_LIMITS.maxQuotesPerCitation);
    entry.quotes = qs.map((q) => {
      if (entry.state !== "resolved" || !judgment?.text) return { ...q, state: "text_unavailable" as const };
      if (quoteInText(q.quote, judgment.text)) return { ...q, state: "found" as const };
      return { ...q, state: judgment.complete ? ("not_found" as const) : ("text_incomplete" as const) };
    });
    return entry;
  });

  if (corpusDown) unavailable.push("Official judgment corpus: not reachable or not configured; neutral citations were checked against the judgment store only.");
  if (citatorDown) unavailable.push("Citator: not reachable; negative signals could not be checked.");

  const issues: FilingIssue[] = [];
  const citatorGaps = citations.filter((c) => c.state === "resolved" && (c.citator === "not_checked" || c.citator === "not_built" || c.citator === "unavailable"));
  for (const c of citations) {
    if (c.state === "unresolved") issues.push({ key: c.key, kind: "unresolved", citation: c.citation, message: `Not resolved: ${c.reason ?? "no judgment carries this citation"}.` });
    if (c.state === "ambiguous") issues.push({ key: c.key, kind: "ambiguous", citation: c.citation, message: `Ambiguous: ${c.candidates.length ? `could be ${c.candidates.join("; ")}` : c.reason ?? "several judgments match"}. None was chosen.` });
    if (c.negative.length) issues.push({ key: c.key, kind: "negative", citation: c.citation, message: `Negative text cue in ${c.negative.length} citing judgment${c.negative.length === 1 ? "" : "s"} (${c.negative.map((n) => n.cue).filter(Boolean).slice(0, 3).join(", ") || "see citator"}). Not a verified treatment: read the citing passage.` });
    for (const q of c.quotes) {
      if (q.state === "not_found") issues.push({ key: `${c.key}#q:${norm(q.quote).slice(0, 60)}`, kind: "quote_not_found", citation: c.citation, message: `Quoted words not found in the judgment text: “${q.quote.slice(0, 160)}${q.quote.length > 160 ? "…" : ""}”` });
      else if (q.state === "text_incomplete" || (q.state === "text_unavailable" && c.state === "resolved")) issues.push({ key: `${c.key}#q:${norm(q.quote).slice(0, 60)}`, kind: "quote_unchecked", citation: c.citation, message: `Quotation not checked (${q.state === "text_incomplete" ? "only part of the judgment text was read" : "judgment text not available"}): “${q.quote.slice(0, 120)}${q.quote.length > 120 ? "…" : ""}”` });
    }
  }
  if (citatorGaps.length) {
    const resolved = citations.filter((c) => c.state === "resolved").length;
    const names = citatorGaps.slice(0, 6).map((c) => c.citation).join("; ");
    issues.push({ key: "citator_unchecked", kind: "citator_unchecked", citation: "", message: `Citator not consulted for ${citatorGaps.length} of ${resolved} resolved citation${resolved === 1 ? "" : "s"} (${names}${citatorGaps.length > 6 ? "; …" : ""}): no official-corpus record, citator not built, or citator unreachable. Later negative treatment was not checked for them.` });
  }
  for (const u of unavailable) issues.push({ key: `unavailable:${norm(u).slice(0, 40)}`, kind: "check_unavailable", citation: "", message: u });

  const quotes = citations.flatMap((c) => c.quotes);
  const counts: FilingCheckCounts = {
    citations: citations.length,
    found: byKey.size,
    checked: citations.filter((c) => c.state !== "unchecked").length,
    resolved: citations.filter((c) => c.state === "resolved").length,
    ambiguous: citations.filter((c) => c.state === "ambiguous").length,
    unresolved: citations.filter((c) => c.state === "unresolved").length,
    unchecked: citations.filter((c) => c.state === "unchecked").length,
    negative: citations.filter((c) => c.negative.length > 0).length,
    citatorChecked: citations.filter((c) => c.citator === "negative_signal" || c.citator === "no_negative_signal_found").length,
    citatorUnchecked: citatorGaps.length,
    quotesChecked: quotes.filter((q) => q.state === "found" || q.state === "not_found").length,
    quotesFound: quotes.filter((q) => q.state === "found").length,
    quotesNotFound: quotes.filter((q) => q.state === "not_found").length,
    quotesUnchecked: quotes.filter((q) => q.state === "text_incomplete" || q.state === "text_unavailable").length,
    statutes: statutes.length,
  };
  const coverage: FilingCoverage = notRun ? "not_run" : unavailable.length ? "partial" : "complete";
  return { version: 1, checkedAt: (deps.now?.() ?? new Date()).toISOString(), coverage, docHash, citations, counts, issues, unavailable, statutes };
}

/** Issues the export gate asks the user to acknowledge (everything except informational ones). */
export function gateIssues(report: FilingCheckReport): FilingIssue[] {
  return report.issues;
}

/**
 * One-line summary for properties / audit: "12 citations found, 12 checked: 9 resolved, 1 ambiguous, 2 unresolved;
 * citator consulted for 4 of 9 resolved (1 with negative cues); quotes 3 found, 1 not found, 2 unchecked".
 */
export function filingSummary(c: FilingCheckCounts): string {
  const found = c.found ?? c.citations;
  const checked = c.checked ?? c.citations;
  return `${found} citation${found === 1 ? "" : "s"} found, ${checked} checked: ${c.resolved} resolved, ${c.ambiguous} ambiguous, ${c.unresolved} unresolved${c.unchecked ? `, ${c.unchecked} not checked` : ""}; citator consulted for ${c.citatorChecked ?? 0} of ${c.resolved} resolved (${c.negative} with negative cues); quotes ${c.quotesFound} found, ${c.quotesNotFound} not found, ${c.quotesUnchecked} unchecked`;
}
