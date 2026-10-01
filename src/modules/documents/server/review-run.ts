import "server-only";
import type { Principal } from "@/lib/auth/types";
import { generateJSON } from "@/lib/ai/agent";
import {
  PRACTICE_AREA_LABEL, RELEVANCE_RANK, REVIEW_LIMITS, type IssueAssessment, type PrivilegeFlag, type PrivilegeScreen, type Relevance, type ReviewCell,
  type ReviewColumn, type ReviewProgress,
} from "../review-types";
import { loadSet } from "./access";
import { buildWindows, pagesFromChunks, textHash, type PageText, type Window } from "./extract";
import { getPlaybook } from "./playbooks";
import { computeRowHash, fileReviewable, fileStamp, loadReview, MAX_REVIEW_ATTEMPTS, needsWork } from "./review";
import { docStore, type DocStore, type ReviewResult, type ReviewRowRecord, type StoredFile, type StoredReview } from "./store";
import { quoteFound } from "./text";

/**
 * The review run: per file, page-marked windows (up to REVIEW_LIMITS.maxCharsPerFile) each get one structured call to
 * the fast model; window results are checked in code (quotes located on the window's pages only, never re-bound to
 * another page or file; values whose quote is not found stay "unverified"; docType outside the review's list becomes
 * "Other"; importance clamped 1-5) and merged. Rows are stored with the text hash, review version and a row hash. Like
 * runExtraction, a call works for ≈200 s and is resumable: long files keep their finished windows and continue.
 */

export const REVIEW_WINDOW_CHARS = 20_000;
export const REVIEW_CONCURRENCY = 4;
export const REVIEW_BUDGET_MS = 200_000;
const HARD_EXTRA_MS = 70_000;

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
    "privilege: a confidentiality / privilege screen under the Bharatiya Sakshya Adhiniyam, 2023 ss.132-134 (formerly Indian Evidence Act ss.126-129) and litigation privilege. flag \"likely\" only for a communication seeking or giving legal advice between a client and its advocate or legal adviser, or a document prepared for pending or contemplated litigation; \"possible\" when there are some indications; otherwise \"none\". An advocate or in-house lawyer merely copied on a business communication is NOT privilege by itself; a document is not privileged because it is marked confidential. basis: one sentence naming the facts (who, to whom, for what purpose); quote the words relied on. This is a suggestion for a human reviewer, never a decision.",
  ].filter((l, i, a) => l !== "" || (i > 0 && a[i - 1] !== "")).join("\n");
}

// ---- checking one window ----------------------------------------------------------------------------------------

interface RawEvidence { quote?: unknown; page?: unknown }
interface RawWindow {
  docType?: unknown; summary?: unknown; importance?: unknown;
  issues?: (RawEvidence & { issueId?: unknown; relevance?: unknown; reason?: unknown })[];
  privilege?: RawEvidence & { flag?: unknown; basis?: unknown };
  cells?: (RawEvidence & { column?: unknown; value?: unknown })[];
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

/**
 * Place a quote on the window's pages only: the stated page when the quote is on it, else the window page where it
 * occurs. A quote not found keeps the model's page only when that page belongs to the window; it is never re-bound.
 */
export function locateQuote(quote: string, statedPage: unknown, win: Window, pageText: Map<number | null, string>): { page: number | null; found: boolean } {
  const stated = typeof statedPage === "number" && win.pages.includes(statedPage) ? statedPage : null;
  const paged = win.pages.some((p) => p != null);
  if (!quote) return { page: paged ? stated : null, found: false };
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

export function checkDocType(review: Pick<StoredReview, "docTypes">, raw: unknown): string {
  const v = str(raw, 200).toLowerCase();
  return review.docTypes.find((d) => d.toLowerCase() === v) ?? "Other";
}

/** Turn one window's model output into a checked result for that window. */
export function processReviewWindow(review: StoredReview, win: Window, raw: RawWindow, pageText: Map<number | null, string>, coverage: { read: number; total: number }): ReviewResult {
  const cells: Record<string, ReviewCell> = {};
  const rawCells = Array.isArray(raw?.cells) ? raw.cells : [];
  for (const c of review.columns) {
    const r = rawCells.find((x) => x?.column === c.id);
    const value = r ? normalizeValue(c, r.value) : null;
    if (value == null) { cells[c.id] = { value: null, status: "not_stated", quote: "", page: null, quoteFound: false }; continue; }
    const quote = str(r!.quote, 400);
    const loc = locateQuote(quote, r!.page, win, pageText);
    cells[c.id] = { value, status: loc.found ? "found" : "unverified", quote, page: loc.page, quoteFound: loc.found };
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
  const pquote = flag === "none" ? "" : str(p.quote, 400);
  const ploc = flag === "none" ? { page: null, found: false } : locateQuote(pquote, p.page, win, pageText);
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

/** Merge window results: cells take the first found value (else the first unverified), issues the highest relevance, privilege the highest flag. */
export function mergeResults(review: StoredReview, parts: ReviewResult[], coverage: { read: number; total: number }): ReviewResult {
  const cells: Record<string, ReviewCell> = {};
  for (const c of review.columns) {
    const all = parts.map((p) => p.cells[c.id]).filter(Boolean);
    cells[c.id] = all.find((x) => x.status === "found") ?? all.find((x) => x.status === "unverified") ?? { value: null, status: "not_stated", quote: "", page: null, quoteFound: false };
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
    summary: parts.map((p) => p.summary).find(Boolean) ?? "",
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

interface Outcome { status: "done" | "failed" | "partial"; error?: string }

/** A new record for this run; the previous result and its hash stay visible (as pending/failed) until replaced. */
const blankRecord = (review: StoredReview, file: StoredFile, prev: ReviewRowRecord | null): ReviewRowRecord => ({
  reviewId: review.id, setId: review.setId, fileId: file.id, state: "progress", reviewVersion: review.version, textHash: null, fileStamp: fileStamp(file),
  windowsDone: 0, result: prev?.result ?? null, partials: [], rowHash: prev?.rowHash ?? null, decision: prev?.decision ?? null, error: null, attempts: prev?.attempts ?? 0,
  updatedAt: new Date().toISOString(),
});

async function reviewFile(store: DocStore, review: StoredReview, file: StoredFile, prev: ReviewRowRecord | null, limit: ReturnType<typeof semaphore>, clock: { stopAt: number; hardAt: number }, signal?: AbortSignal): Promise<Outcome> {
  const now = () => new Date().toISOString();
  // A changed review version or file text restarts the failure count; a retry of the same text keeps it.
  const sameBasis = !!prev && prev.reviewVersion === review.version && prev.fileStamp === fileStamp(file);
  const base = blankRecord(review, file, sameBasis ? prev : prev ? { ...prev, attempts: 0 } : null);
  if (fileReviewable(file) === "no_text") {
    const why = file.status === "needs_ocr" ? "The file has no text layer; run OCR on its pages first" : file.status === "failed" ? `The file could not be read${file.note ? `: ${file.note}` : ""}` : "The file contains no text";
    await store.putReviewRow({ ...base, state: "failed", error: why, attempts: MAX_REVIEW_ATTEMPTS, updatedAt: now() });
    return { status: "failed", error: why };
  }
  const allPages = pagesFromChunks(await store.fileChunks(file.id));
  const hash = textHash(allPages);
  const limited = limitPages(allPages);
  const coverage = { read: limited.read, total: limited.total };
  const windows = buildWindows(limited.pages, REVIEW_WINDOW_CHARS);
  const resume = prev && prev.state === "progress" && prev.textHash === hash && prev.reviewVersion === review.version && prev.partials.length === prev.windowsDone ? prev : null;
  const startAt = resume ? Math.min(resume.windowsDone, windows.length) : 0;
  const pageText = new Map<number | null, string>(limited.pages.map((p) => [p.page, p.text]));
  const results: (ReviewResult | null)[] = windows.map((_, i) => (resume && i < startAt ? resume.partials[i] : null));
  const instructions = reviewInstructions(review);
  const schema = reviewSchema(review);
  let error: string | null = null;
  let stoppedByClock = false;

  await Promise.all(windows.slice(startAt).map((win) => limit(async () => {
    if (error || signal?.aborted) return;
    if (Date.now() >= clock.stopAt) { stoppedByClock = true; return; }
    const budget = Math.max(5_000, Math.min(REVIEW_BUDGET_MS, clock.hardAt - Date.now()));
    const timeout = AbortSignal.timeout(budget);
    try {
      const raw = await generateJSON<RawWindow>({
        fast: true,
        taskType: "extract",
        name: "document_review",
        schema,
        instructions,
        input: `Document: ${file.name}\nExcerpt ${win.index + 1} of ${windows.length}${coverage.read < coverage.total ? ` (the review reads the first ${coverage.read.toLocaleString("en-IN")} of ${coverage.total.toLocaleString("en-IN")} characters)` : ""}:\n\n${win.text}`,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        metadata: { surface: "documents.review" },
      });
      results[win.index] = processReviewWindow(review, win, raw ?? {}, pageText, coverage);
    } catch (e) {
      if (timeout.aborted && !signal?.aborted) { stoppedByClock = true; return; }
      if (signal?.aborted) return;
      error = (e as Error).message || String(e);
    }
  })));

  let done = 0;
  while (done < windows.length && results[done]) done++;

  // The text or the review may have changed while the model ran: results bound to the old basis are discarded.
  const currentFile = await store.getFile(file.setId, file.id);
  if (!currentFile || fileStamp(currentFile) !== fileStamp(file)) return { status: "partial" };
  if (textHash(pagesFromChunks(await store.fileChunks(file.id))) !== hash) return { status: "partial" };
  const currentReview = await store.getReview(review.setId, review.id);
  if (!currentReview || currentReview.version !== review.version) return { status: "partial" };

  const record: ReviewRowRecord = { ...base, textHash: hash, windowsDone: done, partials: results.slice(0, done) as ReviewResult[], updatedAt: now() };
  if (done >= windows.length) {
    const result = mergeResults(review, results as ReviewResult[], coverage);
    await store.putReviewRow({ ...record, state: "done", result, partials: [], rowHash: computeRowHash(review.version, hash, result), error: null, attempts: 0 });
    return { status: "done" };
  }
  if (error && !stoppedByClock) {
    // A failed row keeps its previous result (if any) under status "failed"; nothing partial is shown as done.
    await store.putReviewRow({ ...record, state: "failed", error: String(error).slice(0, 500), attempts: base.attempts + 1 });
    return { status: "failed", error: String(error) };
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
  const [files, recs] = await Promise.all([store.allFiles(set.id), store.listReviewRows(review.id)]);
  const byFile = new Map(recs.map((r) => [r.fileId, r]));
  const pending = files.filter((f) => needsWork(review, f, byFile.get(f.id)));
  // Files with no text are settled without a model call (all of them); text files up to `max` per call.
  const noText = pending.filter((f) => fileReviewable(f) === "no_text");
  const work = [...noText, ...pending.filter((f) => fileReviewable(f) === "yes").slice(0, max)];
  const limit = semaphore(REVIEW_CONCURRENCY);
  const progress: ReviewProgress = { processed: 0, failed: 0, remaining: 0, errors: [] };
  const outcomes = await Promise.all(work.map((f) => reviewFile(store, review, f, byFile.get(f.id) ?? null, limit, clock, opts.signal).catch((e): Outcome => ({ status: "failed", error: (e as Error).message }))));
  outcomes.forEach((o, i) => {
    if (o.status === "done") progress.processed++;
    else if (o.status === "failed") { progress.failed++; progress.errors.push({ fileId: work[i].id, name: work[i].name, error: (o.error ?? "failed").slice(0, 300) }); }
  });
  const [filesAfter, recsAfter] = await Promise.all([store.allFiles(set.id), store.listReviewRows(review.id)]);
  const after = new Map(recsAfter.map((r) => [r.fileId, r]));
  const fresh = (await store.getReview(set.id, review.id)) ?? review;
  progress.remaining = filesAfter.filter((f) => needsWork(fresh, f, after.get(f.id))).length;
  return progress;
}
