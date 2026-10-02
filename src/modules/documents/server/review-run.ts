import "server-only";
import type { Principal } from "@/lib/auth/types";
import { generateJSON } from "@/lib/ai/agent";
import {
  PRACTICE_AREA_LABEL, RELEVANCE_RANK, REVIEW_LIMITS, type ColumnKind, type IssueAssessment, type PrivilegeFlag, type PrivilegeScreen, type Relevance,
  type ReviewCell, type ReviewColumn, type ReviewEvidence, type ReviewProgress,
} from "../review-types";
import { loadSet } from "./access";
import { buildWindows, pagesFromChunks, textHash, type PageText, type Window } from "./extract";
import { getPlaybook } from "./playbooks";
import { computeRowHash, fileReviewable, fileStamp, loadReview, MAX_REVIEW_ATTEMPTS, needsWork, unreadPagesOf } from "./review";
import { coveragePartial, docStore, type DocStore, type ReviewCoverage, type ReviewResult, type ReviewRowMeta, type ReviewRowRecord, type StoredFile, type StoredReview } from "./store";
import { normalizeForMatch, quoteFound } from "./text";

/**
 * The review run: per file, page-marked windows (up to REVIEW_LIMITS.maxCharsPerFile) each get one structured call to
 * the fast model; window results are checked in code and merged:
 *  - a quote must be substantive (not a word or two) and is located on the window's own pages only, never re-bound to
 *    another page or file; for date, amount and party columns the quote must also contain the value (digits, Indian
 *    amount forms such as "Rs. 50,00,000" / "₹50 lakh", significant name words); anything else stays "unverified";
 *  - different supported values in different windows make the cell a "conflict" with the others as `alternatives`;
 *  - when part of the file was not read (pages awaiting OCR, or the length cap) a value not found is "not_read", never
 *    "not_stated", and the row is "partial";
 *  - docType outside the review's list becomes "Other"; importance is clamped 1-5.
 * Rows are stored with the text hash, review version and a row hash. Like runExtraction, a call works for ≈200 s and
 * is resumable: long files keep their finished windows and continue; failures and repeated timeouts count as attempts.
 */

export const REVIEW_WINDOW_CHARS = 20_000;
export const REVIEW_CONCURRENCY = 4;
export const REVIEW_BUDGET_MS = 200_000;
const HARD_EXTRA_MS = 70_000;
/** A window call that times out with at least this much budget counts as an attempt (shorter: the clock ran out). */
const FAIR_TIMEOUT_MS = 60_000;
/** At most this many per-file errors are listed in a progress response (all are counted). */
const MAX_LISTED_ERRORS = 100;

const RELEVANCES: Relevance[] = ["high", "medium", "low", "none"];
const FLAGS: PrivilegeFlag[] = ["none", "possible", "likely"];
const FLAG_RANK: Record<PrivilegeFlag, number> = { none: 0, possible: 1, likely: 2 };

// ---- prompt and schema ------------------------------------------------------------------------------------------

const evidenceProps = { quote: { type: "string" }, page: { type: ["integer", "null"] } } as const;

export function reviewSchema(review: Pick<StoredReview, "columns" | "issues">): Record<string, unknown> {
  const issueId = review.issues.length ? { type: "string", enum: review.issues.map((i) => i.id) } : { type: "string" };
  const columnId = review.columns.length ? { type: "string", enum: review.columns.map((c) => c.id) } : { type: "string" };
  return {
    type: "object",
    properties: {
      docType: { type: "string" },
      summary: { type: "string" },
      importance: { type: "integer" },
      issues: {
        type: "array",
        items: { type: "object", properties: { issueId, relevance: { type: "string", enum: RELEVANCES }, reason: { type: "string" }, ...evidenceProps }, required: ["issueId", "relevance", "reason", "quote", "page"], additionalProperties: false },
      },
      privilege: {
        type: "object",
        properties: { flag: { type: "string", enum: FLAGS }, basis: { type: "string" }, ...evidenceProps },
        required: ["flag", "basis", "quote", "page"],
        additionalProperties: false,
      },
      cells: {
        type: "array",
        items: { type: "object", properties: { column: columnId, value: { type: ["string", "null"] }, ...evidenceProps }, required: ["column", "value", "quote", "page"], additionalProperties: false },
      },
    },
    required: ["docType", "summary", "importance", "issues", "privilege", "cells"],
    additionalProperties: false,
  };
}

function kindHint(c: ReviewColumn): string {
  switch (c.kind) {
    case "date": return "a date exactly as written";
    case "amount": return "an amount with currency exactly as written (e.g. \"Rs. 5,00,000\")";
    case "yes_no": return "Yes or No";
    case "choice": return `one of: ${(c.choices ?? []).join(" | ")}`;
    case "list": return "items separated by \"; \"";
    case "party": return "a person or organisation as named";
    default: return "short text";
  }
}

export function reviewInstructions(review: StoredReview): string {
  const playbook = review.playbookId ? getPlaybook(review.playbookId) : null;
  return [
    `You review documents for an Indian litigation team (${PRACTICE_AREA_LABEL[review.area] ?? "general litigation"}). You receive one excerpt of one document. Work ONLY from the excerpt: no outside knowledge, no assumptions.`,
    playbook?.statutes.length ? `Relevant law (for orientation only; never cite law as if the document says it): ${playbook.statutes.join("; ")}.` : "",
    "Page markers such as [Page 12] precede each page's text. For every quote give the page number on which the quote appears (null when the excerpt has no page markers).",
    "quote: words copied verbatim from the excerpt (at most 300 characters). Never paraphrase, correct or translate inside a quote. If nothing in the excerpt supports a point, leave quote empty.",
    "",
    `docType: choose exactly one of: ${[...review.docTypes, "Other"].join(" | ")}.`,
    "summary: two or three sentences on what this document is and why it matters to the dispute, from the excerpt only.",
    "importance: 1-5, how important the document is likely to be for the matter (5 = likely key document, 1 = routine or irrelevant).",
    "",
    review.issues.length ? "issues: assess EVERY issue below. relevance is high, medium, low or none; reason is one sentence; quote the passage that makes it relevant (empty when none)." : "issues: return an empty list.",
    ...review.issues.map((i) => `- ${i.id} (${i.label}): ${i.description}`),
    "",
    review.columns.length ? "cells: one entry for EVERY column below. value is the answer in the form shown; value null when the excerpt does not state it (never guess, never infer from outside the excerpt). quote supports the value." : "cells: return an empty list.",
    ...review.columns.map((c) => `- ${c.id} (${c.label}; ${kindHint(c)}): ${c.prompt}`),
    "",
    "privilege: a confidentiality / privilege screen under the Bharatiya Sakshya Adhiniyam, 2023 ss.132-134 (formerly Indian Evidence Act ss.126-129) and litigation privilege. flag \"likely\" only for a communication seeking or giving legal advice between a client and its advocate or legal adviser, or a document prepared for pending or contemplated litigation; \"possible\" when there are some indications; otherwise \"none\". An advocate or in-house lawyer merely copied on a business communication is NOT privilege by itself; a document is not privileged because it is marked confidential. A communication sent to or exchanged with the opposite party (a legal notice, a reply to notice, a pleading or application served, correspondence between the parties' advocates) is not privileged, even though an advocate wrote it. basis: one sentence naming the facts (who, to whom, for what purpose); quote the words relied on. This is a suggestion for a human reviewer, never a decision.",
  ].filter((l, i, a) => l !== "" || (i > 0 && a[i - 1] !== "")).join("\n");
}

// ---- checks -----------------------------------------------------------------------------------------------------

interface RawEvidence { quote?: unknown; page?: unknown }
interface RawWindow {
  docType?: unknown; summary?: unknown; importance?: unknown;
  issues?: (RawEvidence & { issueId?: unknown; relevance?: unknown; reason?: unknown })[];
  privilege?: RawEvidence & { flag?: unknown; basis?: unknown };
  cells?: (RawEvidence & { column?: unknown; value?: unknown })[];
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

/**
 * A quote that can support something: at least 3 words or 12 characters (unless it is exactly the value), and every
 * part of an ellipsis quote at least 4 characters. A word or two found somewhere in the file proves nothing.
 */
export function substantiveQuote(quote: string, value?: string | null): boolean {
  const q = (quote ?? "").trim().replace(/^["'“‘]+|["'”’]+$/g, "").trim();
  if (!q) return false;
  const parts = q.split(/\s*(?:\.{3}|…)\s*/).map((x) => x.trim()).filter(Boolean);
  if (!parts.length || parts.some((x) => x.length < 4)) return false;
  if (value && normalizeForMatch(q) === normalizeForMatch(value)) return true;
  const joined = parts.join(" ");
  const words = joined.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  return words >= 3 || joined.length >= 12;
}

const UNIT: Record<string, number> = { lakh: 1e5, lakhs: 1e5, lac: 1e5, lacs: 1e5, crore: 1e7, crores: 1e7, cr: 1e7, crs: 1e7, thousand: 1e3, k: 1e3, million: 1e6, mn: 1e6, billion: 1e9, bn: 1e9 };

/** Amounts in a text, Indian forms included: "Rs. 50,00,000", "₹50 lakh", "1.5 crore", "INR 5,000/-". */
export function amountNumbers(text: string): number[] {
  const out: number[] = [];
  for (const m of (text ?? "").matchAll(/(\d[\d,]*(?:\.\d+)?)(?:\s*(lakhs?|lacs?|crores?|crs?|thousand|million|mn|billion|bn|k)\b)?/gi)) {
    const n = Number(m[1].replace(/,/g, ""));
    if (!Number.isFinite(n)) continue;
    out.push(Math.round(n * (m[2] ? UNIT[m[2].toLowerCase()] ?? 1 : 1) * 100) / 100);
  }
  return out;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Date tokens: numbers without leading zeros, month names as month numbers ("3rd April 2022" → 3, 4, 2022). */
export function dateTokens(text: string): string[] {
  const out: string[] = [];
  for (const m of normalizeForMatch(text).matchAll(/\d+|[a-z]+/g)) {
    const t = m[0];
    if (/^\d+$/.test(t)) out.push(String(Number(t)));
    else if (t.length >= 3) { const i = MONTHS.indexOf(t.slice(0, 3)); if (i >= 0 && (t.length === 3 || t.startsWith(MONTHS[i]))) out.push(String(i + 1)); }
  }
  return out;
}

const NAME_STOP = new Set("m s mr mrs ms miss shri smt sri kumari dr adv advocate the and of a an pvt private ltd limited llp inc co company corp corporation plc llc".split(" "));

/** Significant words of a name (titles and company suffixes dropped). */
export function nameTokens(text: string): string[] {
  return Array.from(normalizeForMatch(text).matchAll(/[\p{L}\p{M}\p{N}]+/gu), (m) => m[0]).filter((t) => t.length >= 2 && !NAME_STOP.has(t));
}

/** For date, amount and party columns: does the quote actually contain the value? Other kinds: true. */
export function valueInQuote(kind: ColumnKind, value: string, quote: string): boolean {
  if (kind === "amount") {
    const v = amountNumbers(value);
    if (!v.length) return nameTokens(value).every((t) => nameTokens(quote).includes(t)) && nameTokens(value).length > 0;
    const q = amountNumbers(quote);
    const digits = (s: string) => s.replace(/\D/g, "");
    return v.every((n) => q.includes(n)) || (digits(value).length > 0 && digits(quote).includes(digits(value)));
  }
  if (kind === "date") {
    const v = dateTokens(value);
    if (!v.length) return normalizeForMatch(quote).includes(normalizeForMatch(value));
    const q = dateTokens(quote);
    return v.every((t) => q.includes(t) || (t.length === 2 && q.some((x) => x.length === 4 && x.endsWith(t))));
  }
  if (kind === "party") {
    const v = nameTokens(value);
    const q = new Set(nameTokens(quote));
    return v.length > 0 && v.every((t) => q.has(t));
  }
  return true;
}

/**
 * Place a quote on the window's pages only: the stated page when the quote is on it, else the window page where it
 * occurs. A quote not found (or not substantive) keeps the model's page only when that page belongs to the window; it
 * is never re-bound.
 */
export function locateQuote(quote: string, statedPage: unknown, win: Window, pageText: Map<number | null, string>, value?: string | null): { page: number | null; found: boolean } {
  const stated = typeof statedPage === "number" && win.pages.includes(statedPage) ? statedPage : null;
  const paged = win.pages.some((p) => p != null);
  if (!quote || !substantiveQuote(quote, value)) return { page: paged ? stated : null, found: false };
  if (stated != null && quoteFound(quote, pageText.get(stated) ?? "")) return { page: stated, found: true };
  for (const p of win.pages) if (quoteFound(quote, pageText.get(p) ?? "")) return { page: p, found: true };
  return { page: paged ? stated : null, found: false };
}

function normalizeValue(c: ReviewColumn, raw: unknown): string | null {
  const v = str(raw, 1000);
  if (!v || /^(not stated|not mentioned|n\/?a|none stated|unknown|null)$/i.test(v)) return null;
  if (c.kind === "yes_no") {
    if (/^(yes|y|true)\b/i.test(v)) return "Yes";
    if (/^(no|n|false)\b/i.test(v)) return "No";
    return v;
  }
  if (c.kind === "choice") {
    const hit = (c.choices ?? []).find((x) => x.toLowerCase() === v.toLowerCase());
    if (hit && /^not stated$/i.test(hit)) return null;
    return hit ?? v;
  }
  return v;
}

/** True when every line of a quote is an email/letter header line (From, To, Cc, Bcc, Date, Subject, Sent). */
export function headerOnlyQuote(quote: string): boolean {
  const lines = quote.split(/\n|(?=\b(?:From|To|Cc|Bcc|Date|Sent|Subject)\s*:)/i).map((l) => l.trim()).filter(Boolean);
  return lines.length > 0 && lines.every((l) => /^(from|to|cc|bcc|date|sent|subject)\s*:/i.test(l));
}

export function checkDocType(review: Pick<StoredReview, "docTypes">, raw: unknown): string {
  const v = str(raw, 200).toLowerCase();
  return review.docTypes.find((d) => d.toLowerCase() === v) ?? "Other";
}

const noValue = (status: "not_stated" | "not_read"): ReviewCell => ({ value: null, status, quote: "", page: null, quoteFound: false });

/** Turn one window's model output into a checked result for that window. */
export function processReviewWindow(review: StoredReview, win: Window, raw: RawWindow, pageText: Map<number | null, string>, coverage: ReviewCoverage): ReviewResult {
  const cells: Record<string, ReviewCell> = {};
  const rawCells = Array.isArray(raw?.cells) ? raw.cells : [];
  for (const c of review.columns) {
    const r = rawCells.find((x) => x?.column === c.id);
    const value = r ? normalizeValue(c, r.value) : null;
    if (value == null) { cells[c.id] = noValue("not_stated"); continue; }
    const quote = str(r!.quote, 400);
    // "No" with nothing quoted means the document is silent on the point, which is "not stated", not an unsupported answer.
    if (c.kind === "yes_no" && value === "No" && !quote) { cells[c.id] = noValue("not_stated"); continue; }
    const loc = locateQuote(quote, r!.page, win, pageText, value);
    const supported = loc.found && valueInQuote(c.kind, value, quote);
    cells[c.id] = { value, status: supported ? "found" : "unverified", quote, page: loc.page, quoteFound: loc.found };
  }
  const rawIssues = Array.isArray(raw?.issues) ? raw.issues : [];
  const issues: IssueAssessment[] = review.issues.map((i) => {
    const r = rawIssues.find((x) => x?.issueId === i.id);
    const relevance = r && RELEVANCES.includes(r.relevance as Relevance) ? (r.relevance as Relevance) : "none";
    const quote = relevance === "none" ? "" : str(r?.quote, 400);
    const loc = relevance === "none" ? { page: null, found: false } : locateQuote(quote, r?.page, win, pageText);
    return { issueId: i.id, relevance, reason: str(r?.reason, 500), quote, page: loc.page, quoteFound: loc.found };
  });
  const p = raw?.privilege ?? {};
  let flag: PrivilegeFlag = FLAGS.includes(p.flag as PrivilegeFlag) ? (p.flag as PrivilegeFlag) : "none";
  const basis = str(p.basis, 500);
  if (flag !== "none" && !basis) flag = "none"; // a flag needs a stated basis
  let pquote = flag === "none" ? "" : str(p.quote, 400);
  let ploc = flag === "none" ? { page: null as number | null, found: false } : locateQuote(pquote, p.page, win, pageText);
  // An advocate in the To/Cc line of a business communication is not privilege by itself (BSA 2023 ss.132-134): a flag
  // resting only on header lines is dropped. A flag whose quote is not in the text is kept for the reviewer (missing a
  // privileged document is the costlier error) but never above "possible", and shows that its quote was not found.
  if (flag !== "none" && headerOnlyQuote(pquote)) { flag = "none"; pquote = ""; ploc = { page: null, found: false }; }
  else if (flag === "likely" && !ploc.found) flag = "possible";
  const privilege: PrivilegeScreen = { flag, basis: flag === "none" ? "" : basis, quote: pquote, page: ploc.page, quoteFound: ploc.found };
  const imp = Math.round(Number(raw?.importance));
  return {
    docType: checkDocType(review, raw?.docType),
    summary: str(raw?.summary, 800),
    importance: Number.isFinite(imp) ? Math.max(1, Math.min(5, imp)) : null,
    issues,
    privilege,
    cells,
    coverage,
  };
}

/** Key for "the same value" across windows (amounts and dates compared by their numbers). */
function valueKey(kind: ColumnKind, v: string): string {
  if (kind === "amount") { const n = amountNumbers(v); if (n.length) return `#${n.join(",")}`; }
  if (kind === "date") { const t = dateTokens(v); if (t.length) return `@${t.join(".")}`; }
  return normalizeForMatch(v).replace(/[^\p{L}\p{M}\p{N}]+/gu, "");
}

/** One summary from every window: the first sentence of each distinct window summary, in order. */
export function mergeSummaries(summaries: string[]): string {
  const parts = summaries.map((x) => x.trim()).filter(Boolean);
  if (parts.length <= 1) return parts[0] ?? "";
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of parts) {
    const first = (s.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? s).trim();
    const k = normalizeForMatch(first);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(/[.!?]$/.test(first) ? first : `${first}.`);
  }
  return out.join(" ").slice(0, 800);
}

/**
 * Merge window results. Cells: the first supported ("found") value; other different supported values make the cell a
 * "conflict" with them as alternatives; else the first unverified value; else not_stated (not_read when part of the
 * file was not read). Issues: the highest relevance. Privilege: the highest flag. Summary: from every window.
 */
export function mergeResults(review: StoredReview, parts: ReviewResult[], coverage: ReviewCoverage): ReviewResult {
  const partial = coveragePartial(coverage);
  const cells: Record<string, ReviewCell> = {};
  for (const c of review.columns) {
    const all = parts.map((p) => p.cells[c.id]).filter(Boolean);
    const found = all.filter((x) => x.status === "found" && x.value != null);
    if (found.length) {
      const first = found[0];
      const seen = new Set([valueKey(c.kind, first.value!)]);
      const alternatives: (ReviewEvidence & { value: string })[] = [];
      for (const x of found.slice(1)) {
        const k = valueKey(c.kind, x.value!);
        if (seen.has(k)) continue;
        seen.add(k);
        alternatives.push({ value: x.value!, quote: x.quote, page: x.page, quoteFound: x.quoteFound });
      }
      cells[c.id] = alternatives.length ? { ...first, status: "conflict", alternatives } : first;
      continue;
    }
    cells[c.id] = all.find((x) => x.status === "unverified") ?? noValue(partial ? "not_read" : "not_stated");
  }
  const issues = review.issues.map((i) => {
    let best: IssueAssessment = { issueId: i.id, relevance: "none", reason: "", quote: "", page: null, quoteFound: false };
    for (const p of parts) {
      const a = p.issues.find((x) => x.issueId === i.id);
      if (!a) continue;
      const better = RELEVANCE_RANK[a.relevance] > RELEVANCE_RANK[best.relevance] || (RELEVANCE_RANK[a.relevance] === RELEVANCE_RANK[best.relevance] && a.relevance !== "none" && a.quoteFound && !best.quoteFound);
      if (better) best = a;
    }
    return best;
  });
  let privilege: PrivilegeScreen = { flag: "none", basis: "", quote: "", page: null, quoteFound: false };
  for (const p of parts) {
    const s = p.privilege;
    if (!s) continue;
    if (FLAG_RANK[s.flag] > FLAG_RANK[privilege.flag] || (FLAG_RANK[s.flag] === FLAG_RANK[privilege.flag] && s.flag !== "none" && s.quoteFound && !privilege.quoteFound)) privilege = s;
  }
  const docType = parts.map((p) => p.docType).find((d) => d && d !== "Other") ?? (parts.length ? "Other" : null);
  const imps = parts.map((p) => p.importance).filter((x): x is number => typeof x === "number");
  return {
    docType,
    summary: mergeSummaries(parts.map((p) => p.summary)),
    importance: imps.length ? Math.max(...imps) : null,
    issues,
    privilege,
    cells,
    coverage,
  };
}

/** Pages limited to `max` characters in order (the last one cut); `read` is what the review covers. */
export function limitPages(pages: PageText[], max = REVIEW_LIMITS.maxCharsPerFile): { pages: PageText[]; read: number; total: number } {
  const total = pages.reduce((n, p) => n + p.text.length, 0);
  const out: PageText[] = [];
  let read = 0;
  for (const p of pages) {
    if (read >= max) break;
    const text = p.text.slice(0, max - read);
    out.push({ page: p.page, text });
    read += text.length;
  }
  return { pages: out, read, total };
}

/**
 * Coverage of a file: characters read vs total, where pages awaiting OCR count into the total (at the average length
 * of the file's text pages, at least 1 character each) so a file with unread pages never looks fully read.
 */
export function fileCoverage(file: StoredFile, pages: PageText[], limited: { read: number; total: number }): ReviewCoverage {
  const unreadPages = unreadPagesOf(file);
  const textPages = pages.filter((p) => p.text.trim()).length;
  const avg = textPages ? Math.round(limited.total / textPages) : 2000;
  return { read: limited.read, total: limited.total + unreadPages.length * Math.max(1, avg), unreadPages };
}

// ---- running ----------------------------------------------------------------------------------------------------

function semaphore(n: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= n) await new Promise<void>((r) => queue.push(r));
    active++;
    try { return await fn(); } finally { active--; queue.shift()?.(); }
  };
}

interface Outcome { status: "done" | "failed" | "partial" | "skipped"; error?: string }

/**
 * A new record for this run. The previous result, row hash and attempt count are carried only when the previous record
 * was produced under the same review version and file text; otherwise nothing of it survives (the decision is kept by
 * the store, which never writes it from the run).
 */
export function blankRecord(review: StoredReview, file: StoredFile, prev: ReviewRowRecord | null, sameBasis: boolean): ReviewRowRecord {
  return {
    reviewId: review.id, setId: review.setId, fileId: file.id, state: "progress", reviewVersion: review.version, textHash: null, fileStamp: fileStamp(file),
    windowsDone: 0, result: sameBasis ? prev?.result ?? null : null, partials: [], rowHash: sameBasis ? prev?.rowHash ?? null : null, decision: prev?.decision ?? null,
    error: null, attempts: sameBasis ? prev?.attempts ?? 0 : 0, updatedAt: new Date().toISOString(),
  };
}

const sameBasisOf = (review: StoredReview, file: StoredFile, prev: Pick<ReviewRowMeta, "reviewVersion" | "fileStamp"> | null | undefined) =>
  !!prev && prev.reviewVersion === review.version && prev.fileStamp === fileStamp(file);

function noTextReason(file: StoredFile): string {
  if (file.status === "needs_ocr") return "The file has no text layer; run OCR on its pages first";
  if (file.status === "failed") return `The file could not be read${file.note ? `: ${file.note}` : ""}`;
  return "The file contains no text";
}

/** Settled failed record for a file with no text (no model call). */
function noTextRecord(review: StoredReview, file: StoredFile, prev: ReviewRowMeta | null): ReviewRowRecord {
  const base = blankRecord(review, file, null, false);
  return { ...base, decision: prev?.decision ?? null, state: "failed", error: noTextReason(file), attempts: MAX_REVIEW_ATTEMPTS };
}

async function reviewFile(store: DocStore, review: StoredReview, file: StoredFile, windowSlots: ReturnType<typeof semaphore>, clock: { stopAt: number; hardAt: number }, signal?: AbortSignal): Promise<Outcome> {
  if (signal?.aborted || Date.now() >= clock.stopAt) return { status: "skipped" };
  const now = () => new Date().toISOString();
  const prev = await store.getReviewRow(review.id, file.id, { partials: true });
  const sameBasis = sameBasisOf(review, file, prev);
  const base = blankRecord(review, file, prev, sameBasis);
  const allPages = pagesFromChunks(await store.fileChunks(file.id));
  const hash = textHash(allPages);
  const limited = limitPages(allPages);
  const coverage = fileCoverage(file, allPages, limited);
  const windows = buildWindows(limited.pages, REVIEW_WINDOW_CHARS);
  const resume = sameBasis && prev && (prev.state === "progress" || prev.state === "failed") && prev.textHash === hash && prev.windowsDone > 0 && prev.partials.length === prev.windowsDone ? prev : null;
  const startAt = resume ? Math.min(resume.windowsDone, windows.length) : 0;
  const pageText = new Map<number | null, string>(limited.pages.map((p) => [p.page, p.text]));
  const results: (ReviewResult | null)[] = windows.map((_, i) => (resume && i < startAt ? resume.partials[i] : null));
  const instructions = reviewInstructions(review);
  const schema = reviewSchema(review);
  let error: string | null = null;
  let timedOut = false;
  const partNote = coveragePartial(coverage)
    ? ` (the review reads ${coverage.read.toLocaleString("en-IN")} characters${limited.read < limited.total ? ` of ${limited.total.toLocaleString("en-IN")}` : ""}${coverage.unreadPages.length ? `; ${coverage.unreadPages.length} scanned page(s) have no text yet` : ""})`
    : "";

  await Promise.all(windows.slice(startAt).map((win) => windowSlots(async () => {
    if (error || timedOut || signal?.aborted) return;
    if (Date.now() >= clock.stopAt) return;
    const budget = Math.max(5_000, Math.min(REVIEW_BUDGET_MS, clock.hardAt - Date.now()));
    const timeout = AbortSignal.timeout(budget);
    try {
      const raw = await generateJSON<RawWindow>({
        fast: true,
        taskType: "extract",
        name: "document_review",
        schema,
        instructions,
        input: `Document: ${file.name}\nExcerpt ${win.index + 1} of ${windows.length}${partNote}:\n\n${win.text}`,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        metadata: { surface: "documents.review" },
      });
      results[win.index] = processReviewWindow(review, win, raw ?? {}, pageText, coverage);
    } catch (e) {
      if (signal?.aborted) return;
      // A timeout with a fair budget is an attempt (so a window that always times out ends as failed); a short one is the clock.
      if (timeout.aborted) { if (budget >= FAIR_TIMEOUT_MS) timedOut = true; return; }
      error = (e as Error).message || String(e);
    }
  })));
  if (signal?.aborted) return { status: "skipped" };

  let done = 0;
  while (done < windows.length && results[done]) done++;

  // The text or the review may have changed while the model ran: results bound to the old basis are discarded.
  const [currentFile, currentReview] = await Promise.all([store.getFile(file.setId, file.id), store.getReview(review.setId, review.id)]);
  if (!currentFile || fileStamp(currentFile) !== fileStamp(file)) return { status: "skipped" };
  if (!currentReview || currentReview.version !== review.version) return { status: "skipped" };

  const record: ReviewRowRecord = { ...base, textHash: hash, windowsDone: done, partials: results.slice(0, done) as ReviewResult[], updatedAt: now() };
  if (done >= windows.length) {
    const result = mergeResults(review, results as ReviewResult[], coverage);
    await store.putReviewRow({ ...record, state: "done", result, partials: [], rowHash: computeRowHash(review.version, hash, result), error: null, attempts: 0 });
    return { status: "done" };
  }
  if (error || timedOut) {
    // Finished windows are kept for the retry; the row shows "failed" (no result) until a retry completes it.
    const why = error ?? `Excerpt ${done + 1} of ${windows.length} timed out`;
    await store.putReviewRow({ ...record, state: "failed", error: why.slice(0, 500), attempts: base.attempts + 1 });
    return { status: "failed", error: why };
  }
  await store.putReviewRow({ ...record, state: "progress" });
  return { status: "partial" };
}

/** Review pending files of a set for ≈200 s. Call again until `remaining` is 0. */
export async function runReview(principal: Principal, setId: string, reviewId: string, opts: { max?: unknown; signal?: AbortSignal; budgetMs?: number } = {}): Promise<ReviewProgress> {
  const set = await loadSet(principal, setId, "write");
  const store = await docStore();
  const review = await loadReview(store, set, reviewId);
  const max = Math.max(1, Math.min(Number.isFinite(Number(opts.max)) && Number(opts.max) > 0 ? Math.floor(Number(opts.max)) : 8, 50));
  const started = Date.now();
  const budget = opts.budgetMs ?? REVIEW_BUDGET_MS;
  const clock = { stopAt: started + budget, hardAt: started + budget + HARD_EXTRA_MS };
  const [files, metas] = await Promise.all([store.allFiles(set.id), store.listReviewRows(review.id)]);
  const byFile = new Map(metas.map((r) => [r.fileId, r]));
  const pending = files.filter((f) => needsWork(review, f, byFile.get(f.id)));
  const progress: ReviewProgress = { processed: 0, failed: 0, remaining: 0, errors: [] };
  const fail = (f: StoredFile, error: string) => {
    progress.failed++;
    if (progress.errors.length < MAX_LISTED_ERRORS) progress.errors.push({ fileId: f.id, name: f.name, error: error.slice(0, 300) });
  };

  // Files with no text are settled without a model call, all of them, in one bulk write.
  const noText = pending.filter((f) => fileReviewable(f) === "no_text");
  if (noText.length) {
    await store.putReviewRows(noText.map((f) => noTextRecord(review, f, byFile.get(f.id) ?? null)));
    for (const f of noText) fail(f, noTextReason(f));
  }

  // Text files, up to `max` per call: at most REVIEW_CONCURRENCY files load their text at a time, and at most
  // REVIEW_CONCURRENCY model calls run at a time across them.
  const work = pending.filter((f) => fileReviewable(f) === "yes").slice(0, max);
  const fileSlots = semaphore(REVIEW_CONCURRENCY);
  const windowSlots = semaphore(REVIEW_CONCURRENCY);
  const outcomes = await Promise.all(work.map((f) => fileSlots(() => reviewFile(store, review, f, windowSlots, clock, opts.signal)).catch((e): Outcome => ({ status: "failed", error: (e as Error).message }))));
  outcomes.forEach((o, i) => {
    if (o.status === "done") progress.processed++;
    else if (o.status === "failed") fail(work[i], o.error ?? "failed");
  });

  const [filesAfter, after] = await Promise.all([store.allFiles(set.id), store.listReviewRows(review.id)]);
  const afterBy = new Map(after.map((r) => [r.fileId, r]));
  const fresh = (await store.getReview(set.id, review.id)) ?? review;
  progress.remaining = filesAfter.filter((f) => needsWork(fresh, f, afterBy.get(f.id))).length;
  return progress;
}
