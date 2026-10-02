import "server-only";
import { createHash } from "node:crypto";
import { nanoid } from "nanoid";
import type { Principal } from "@/lib/auth/types";
import {
  CODING_LABEL, isColumnId, PRACTICE_AREA_LABEL, REVIEW_LIMITS, type Coding, type CodingDecision, type CodingInput, type ColumnKind,
  type CreateReviewInput, type DocReview, type DocReviewRow, type IssueAssessment, type PracticeAreaId, type PrivilegeFlag, type Relevance,
  type ReviewCell, type ReviewColumn, type ReviewFacets, type ReviewIssue, type RowQuery, type RowStatus,
} from "../review-types";
import type { DocSet } from "../types";
import { DocsError, loadSet, readableSetIds } from "./access";
import { getPlaybook } from "./playbooks";
import { recordAudit } from "./sets";
import { zeroCounts } from "./review-sql";
import {
  coveragePartial, docStore, fileStamp, REVIEWER_VERSION, type DocStore, type ReviewResult, type ReviewRowMeta, type ReviewRowRecord, type StoredFile,
  type StoredReview,
} from "./store";

export { fileStamp, REVIEWER_VERSION };

/**
 * Document review (discovery) service: review definitions, the per-file rows (built in code from the set's files and
 * the stored row records), filters/facets, and coding decisions. The run itself lives in review-run.ts, the report in
 * review-report.ts and the exports in review-export.ts.
 *
 * Authorization follows the set exactly (loadSet): unknown and unreadable sets are 404, a readable set the caller may not
 * change is 403. A review id that does not belong to the set is 404.
 */

/** Failed rows are retried this many times in total before they stop counting as remaining. */
export const MAX_REVIEW_ATTEMPTS = 2;

const COLUMN_KINDS: ColumnKind[] = ["text", "date", "amount", "yes_no", "choice", "list", "party"];
export const CODINGS: Coding[] = ["key", "relevant", "not_relevant", "privileged", "needs_review"];
const RELEVANCES: Relevance[] = ["high", "medium", "low", "none"];
const FLAGS: PrivilegeFlag[] = ["none", "possible", "likely"];
const STATUSES: RowStatus[] = ["pending", "done", "partial", "failed"];

export const reviewNotFound = () => new DocsError("Review not found", 404, "not_found");

// ---- validation -------------------------------------------------------------------------------------------------

const invalid = (m: string) => new DocsError(m, 422, "invalid");

function cleanText(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").replace(/[ \t]+/g, " ").trim();
  return s ? s.slice(0, max) : null;
}

function validColumns(v: unknown): ReviewColumn[] {
  if (!Array.isArray(v)) throw invalid("columns must be a list");
  const out: ReviewColumn[] = [];
  for (const raw of v) {
    const c = (raw ?? {}) as Partial<ReviewColumn>;
    if (!isColumnId(c.id)) throw invalid(`Column id ${JSON.stringify(c.id)} must be lowercase letters, digits and underscores (≤ 40 characters), starting with a letter`);
    const label = cleanText(c.label, 120);
    const prompt = cleanText(c.prompt, 1000);
    if (!label) throw invalid(`Column ${c.id} needs a label`);
    if (!prompt) throw invalid(`Column ${c.id} needs a prompt`);
    if (!COLUMN_KINDS.includes(c.kind as ColumnKind)) throw invalid(`Column ${c.id} has an unknown kind`);
    const col: ReviewColumn = { id: c.id, label, prompt, kind: c.kind as ColumnKind };
    if (c.kind === "choice") {
      const choices = Array.isArray(c.choices) ? Array.from(new Set(c.choices.map((x) => cleanText(x, 80)).filter((x): x is string => !!x))) : [];
      if (!choices.length || choices.length > 30) throw invalid(`Column ${c.id} needs between 1 and 30 choices`);
      col.choices = choices;
    }
    out.push(col);
  }
  return out;
}

function validIssues(v: unknown): ReviewIssue[] {
  if (!Array.isArray(v)) throw invalid("issues must be a list");
  return v.map((raw) => {
    const i = (raw ?? {}) as Partial<ReviewIssue>;
    if (!isColumnId(i.id)) throw invalid(`Issue id ${JSON.stringify(i.id)} must be lowercase letters, digits and underscores (≤ 40 characters), starting with a letter`);
    const label = cleanText(i.label, 120);
    const description = cleanText(i.description, 1000);
    if (!label) throw invalid(`Issue ${i.id} needs a label`);
    return { id: i.id, label, description: description ?? label };
  });
}

function validStrings(v: unknown, what: string, maxLen: number): string[] {
  if (!Array.isArray(v)) throw invalid(`${what} must be a list of strings`);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of v) {
    const s = cleanText(x, maxLen);
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

/** Merge by id: an override replaces the item with the same id; new ids are appended in order. */
function mergeById<T extends { id: string }>(base: T[], over: T[]): T[] {
  const out = base.map((b) => over.find((o) => o.id === b.id) ?? b);
  for (const o of over) if (!base.some((b) => b.id === o.id)) out.push(o);
  return out;
}

function assertLimits(r: Pick<StoredReview, "columns" | "issues" | "questions" | "docTypes">) {
  const dupe = (ids: string[]) => ids.find((id, i) => ids.indexOf(id) !== i);
  const dc = dupe(r.columns.map((c) => c.id));
  if (dc) throw invalid(`Duplicate column id ${dc}`);
  const di = dupe(r.issues.map((c) => c.id));
  if (di) throw invalid(`Duplicate issue id ${di}`);
  if (r.columns.length > REVIEW_LIMITS.maxColumns) throw invalid(`At most ${REVIEW_LIMITS.maxColumns} columns`);
  if (r.issues.length > REVIEW_LIMITS.maxIssues) throw invalid(`At most ${REVIEW_LIMITS.maxIssues} issues`);
  if (r.questions.length > REVIEW_LIMITS.maxQuestions) throw invalid(`At most ${REVIEW_LIMITS.maxQuestions} questions`);
  if (r.docTypes.length > REVIEW_LIMITS.maxDocTypes) throw invalid(`At most ${REVIEW_LIMITS.maxDocTypes} document types`);
  if (!r.columns.length && !r.issues.length) throw invalid("A review needs at least one column or issue");
}

// ---- rows -------------------------------------------------------------------------------------------------------

/** Whether a file has text the reviewer can read (upload complete, some text). */
export function fileReviewable(f: StoredFile): "yes" | "uploading" | "no_text" {
  if ((f.pagesReceived ?? f.pages) < f.pages) return "uploading";
  if (!(f.chars > 0) || !["ready", "partial"].includes(f.status)) return "no_text";
  return "yes";
}

/** True when the record was produced under the current review version and file text. */
export function rowCurrent<R extends ReviewRowMeta>(review: Pick<StoredReview, "version">, file: StoredFile, rec: R | undefined | null): rec is R {
  return !!rec && rec.state !== "pending" && rec.reviewVersion === review.version && rec.fileStamp === fileStamp(file);
}

/** Whether a run should (re)process this file. Files still uploading never count. */
export function needsWork(review: Pick<StoredReview, "version">, file: StoredFile, rec: ReviewRowMeta | undefined | null): boolean {
  if (fileReviewable(file) === "uploading") return false;
  if (!rowCurrent(review, file, rec)) return true;
  if (rec.state === "progress" || rec.state === "failed") return rec.attempts < MAX_REVIEW_ATTEMPTS;
  return false;
}

/** Pages with no text that the review could not read: scanned pages still awaiting OCR. */
export function unreadPagesOf(file: Pick<StoredFile, "ocrPages" | "ocrDonePages">): number[] {
  const done = new Set(file.ocrDonePages ?? []);
  return Array.from(new Set((file.ocrPages ?? []).filter((p) => !done.has(p)))).sort((a, b) => a - b);
}

function emptyIssue(issueId: string): IssueAssessment {
  return { issueId, relevance: "none", reason: "", quote: "", page: null, quoteFound: false };
}

/** Whether a row's result may be shown: produced under the current review version and file text, and done. */
export function rowShown(review: Pick<StoredReview, "version">, file: StoredFile, rec: ReviewRowRecord | undefined | null): boolean {
  return rowCurrent(review, file, rec) && rec.state === "done" && !!rec.result;
}

/**
 * The public row for one file. Only a current, done row exposes its result and hash; a pending row (never reviewed, or
 * reviewed under an older version or text) and a failed row show empty cells, issues and privilege and no row hash.
 */
export function toRow(review: StoredReview, file: StoredFile, rec: ReviewRowRecord | undefined | null): DocReviewRow {
  const current = rowCurrent(review, file, rec);
  const shown = rowShown(review, file, rec);
  const result = shown ? rec!.result : null;
  let status: RowStatus = "pending";
  if (current && rec.state === "failed") status = "failed";
  else if (result) status = coveragePartial(result.coverage) ? "partial" : "done";
  const cells: Record<string, ReviewCell> = {};
  if (result) for (const c of review.columns) { const cell = result.cells?.[c.id]; if (cell) cells[c.id] = cell; }
  const issues = result ? review.issues.map((i) => result.issues.find((x) => x.issueId === i.id) ?? emptyIssue(i.id)) : [];
  const rowHash = result ? rec!.rowHash ?? null : null;
  const decision = rec?.decision ?? null;
  const cov = result?.coverage;
  return {
    reviewId: review.id,
    setId: review.setId,
    fileId: file.id,
    fileName: file.name,
    pages: file.pages,
    status,
    docType: result?.docType ?? null,
    summary: result?.summary ?? "",
    importance: result?.importance ?? null,
    issues,
    privilege: result?.privilege ?? null,
    cells,
    rowHash,
    decision,
    decisionStale: !!decision && (decision.rowHash ?? "") !== (rowHash ?? ""),
    coverage: cov ? { read: cov.read, total: cov.total, unreadPages: cov.unreadPages ?? [] } : { read: 0, total: file.chars, unreadPages: unreadPagesOf(file) },
    error: current && rec.state === "failed" ? rec.error : null,
    updatedAt: rec && rec.state !== "pending" ? rec.updatedAt : null,
  };
}

export async function withCounts(store: DocStore, review: StoredReview): Promise<DocReview> {
  const counts = await store.reviewCounts(review.setId, review.id);
  return { ...review, counts: counts.get(review.id) ?? zeroCounts() };
}

/** Resolve a review of an authorized set (404 when it is not in that set). */
export async function loadReview(store: DocStore, set: DocSet, reviewId: string): Promise<StoredReview> {
  const review = typeof reviewId === "string" && reviewId ? await store.getReview(set.id, reviewId) : null;
  if (!review) throw reviewNotFound();
  return review;
}

// ---- CRUD -------------------------------------------------------------------------------------------------------

export async function listReviews(principal: Principal, setId: string): Promise<DocReview[]> {
  const set = await loadSet(principal, setId, "read");
  const store = await docStore();
  const reviews = await store.listReviews(set.id);
  if (!reviews.length) return [];
  const counts = await store.reviewCounts(set.id); // one grouped query for every review of the set
  return reviews.map((r) => ({ ...r, counts: counts.get(r.id) ?? zeroCounts() }));
}

export async function getReview(principal: Principal, setId: string, reviewId: string): Promise<DocReview> {
  const set = await loadSet(principal, setId, "read");
  const store = await docStore();
  return withCounts(store, await loadReview(store, set, reviewId));
}

export async function createReview(principal: Principal, setId: string, input: CreateReviewInput): Promise<DocReview> {
  const set = await loadSet(principal, setId, "write");
  const body = (input ?? {}) as CreateReviewInput;
  let playbook = null;
  if (body.playbookId != null && body.playbookId !== "") {
    playbook = getPlaybook(body.playbookId);
    if (!playbook) throw invalid("Unknown playbook");
  }
  const columns = mergeById(playbook?.columns ?? [], body.columns != null ? validColumns(body.columns) : []);
  const issues = mergeById(playbook?.issues ?? [], body.issues != null ? validIssues(body.issues) : []);
  const docTypes = body.docTypes != null ? validStrings(body.docTypes, "docTypes", 120).filter((d) => d.toLowerCase() !== "other") : [...(playbook?.docTypes ?? [])];
  const questions = body.questions != null ? validStrings(body.questions, "questions", 500) : [...(playbook?.questions ?? [])];
  const area: PracticeAreaId = playbook?.area ?? "general";
  const name = cleanText(body.name, 200) ?? (playbook ? playbook.name : "Custom review");
  const now = new Date().toISOString();
  const review: StoredReview = {
    id: `drev_${nanoid(12)}`, setId: set.id, name, playbookId: playbook?.id ?? null, area, docTypes, issues, columns, questions, version: 1,
    createdBy: principal.id, createdAt: now, updatedAt: now,
  };
  assertLimits(review);
  const store = await docStore();
  await store.insertReview(review);
  recordAudit(principal, "create", { kind: "document_review", id: review.id, label: review.name, matterId: set.matterId ?? undefined }, { setId: set.id, playbookId: review.playbookId });
  return withCounts(store, review);
}

export interface ReviewPatch { name?: unknown; columns?: unknown; issues?: unknown; questions?: unknown; docTypes?: unknown; /** Expected current version (optional). */ version?: unknown }

const reviewChanged = () => new DocsError("This review was changed by someone else. Reload it and apply your change again.", 409, "review_changed");

export async function updateReview(principal: Principal, setId: string, reviewId: string, patch: ReviewPatch): Promise<DocReview> {
  const set = await loadSet(principal, setId, "write");
  const store = await docStore();
  const review = await loadReview(store, set, reviewId);
  if (patch.version !== undefined && patch.version !== null) {
    if (typeof patch.version !== "number" || !Number.isInteger(patch.version)) throw invalid("version must be an integer");
    if (patch.version !== review.version) throw reviewChanged();
  }
  const next: StoredReview = { ...review };
  if (patch.name !== undefined) {
    const n = cleanText(patch.name, 200);
    if (!n) throw invalid("A name is required");
    next.name = n;
  }
  if (patch.columns !== undefined) next.columns = validColumns(patch.columns);
  if (patch.issues !== undefined) next.issues = validIssues(patch.issues);
  if (patch.docTypes !== undefined) next.docTypes = validStrings(patch.docTypes, "docTypes", 120).filter((d) => d.toLowerCase() !== "other");
  if (patch.questions !== undefined) next.questions = validStrings(patch.questions, "questions", 500);
  assertLimits(next);
  const changed = JSON.stringify([next.columns, next.issues, next.docTypes]) !== JSON.stringify([review.columns, review.issues, review.docTypes]);
  if (changed) next.version = review.version + 1;
  next.updatedAt = new Date().toISOString();
  // Compare-and-set on the version read above: a concurrent definition change makes this a 409, never a silent overwrite.
  if (!(await store.updateReview(next, review.version))) throw reviewChanged();
  recordAudit(principal, "update", { kind: "document_review", id: next.id, label: next.name, matterId: set.matterId ?? undefined }, { setId: set.id, version: next.version, definitionChanged: changed });
  return withCounts(store, next);
}

export async function deleteReview(principal: Principal, setId: string, reviewId: string): Promise<void> {
  const set = await loadSet(principal, setId, "delete");
  const store = await docStore();
  const review = await loadReview(store, set, reviewId);
  await store.deleteReview(set.id, review.id);
  recordAudit(principal, "delete", { kind: "document_review", id: review.id, label: review.name, matterId: set.matterId ?? undefined }, { setId: set.id });
}

// ---- row query --------------------------------------------------------------------------------------------------

const int = (v: unknown, d: number, min: number, max: number) => { const n = Number(v); return v == null || v === "" || !Number.isFinite(n) ? d : Math.max(min, Math.min(max, Math.floor(n))); };
const pick = <T extends string>(v: unknown, allowed: readonly T[]): T | undefined => (typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : undefined);

/** Parse RowQuery from untyped input (URL params); unknown values are ignored, never widened into errors. */
export function parseRowQuery(q: Record<string, unknown>): RowQuery {
  return {
    q: typeof q.q === "string" && q.q.trim() ? q.q.trim().slice(0, 200) : undefined,
    issue: typeof q.issue === "string" && q.issue ? q.issue : undefined,
    minRelevance: pick(q.minRelevance, RELEVANCES),
    docType: typeof q.docType === "string" && q.docType ? q.docType.slice(0, 120) : undefined,
    privilege: pick(q.privilege, FLAGS),
    coding: pick(q.coding, [...CODINGS, "uncoded", "stale"] as const),
    status: pick(q.status, STATUSES),
    sort: pick(q.sort, ["importance", "name", "updated"] as const),
    offset: int(q.offset, 0, 0, 1_000_000),
    limit: int(q.limit, 100, 1, 500),
  };
}

/** Rows page + total (after filters) + facets (over every row of the review, unfiltered), all computed in SQL. */
export async function listRows(principal: Principal, setId: string, reviewId: string, query: RowQuery): Promise<{ rows: DocReviewRow[]; total: number; facets: ReviewFacets }> {
  const set = await loadSet(principal, setId, "read");
  const store = await docStore();
  const review = await loadReview(store, set, reviewId);
  const [page, facets] = await Promise.all([
    store.queryReviewRows(set.id, review.id, query, { offset: query.offset ?? 0, limit: query.limit ?? 100 }),
    store.reviewFacets(set.id, review.id, review.issues.map((i) => i.id)),
  ]);
  return { rows: page.items.map((x) => toRow(review, x.file, x.rec)), total: page.total, facets };
}

/** Every row of a review in `sort` order, read page by page (exports). */
export async function* allRowPages(store: DocStore, review: StoredReview, sort: RowQuery["sort"], pageSize = 500): AsyncGenerator<DocReviewRow[]> {
  for (let offset = 0; ; offset += pageSize) {
    const page = await store.queryReviewRows(review.setId, review.id, { sort }, { offset, limit: pageSize });
    if (page.items.length) yield page.items.map((x) => toRow(review, x.file, x.rec));
    if (page.items.length < pageSize) return;
  }
}

// ---- coding -----------------------------------------------------------------------------------------------------

export async function codeRow(principal: Principal, setId: string, reviewId: string, fileId: string, input: CodingInput): Promise<DocReviewRow> {
  const set = await loadSet(principal, setId, "write");
  const store = await docStore();
  const review = await loadReview(store, set, reviewId);
  const body = (input ?? {}) as Partial<CodingInput>;
  if (typeof body.rowHash !== "string") throw invalid("rowHash is required (send \"\" for a row that has not been reviewed)");
  if (body.coding !== null && !CODINGS.includes(body.coding as Coding)) throw invalid(`coding must be one of ${CODINGS.join(", ")} or null`);
  const [file] = typeof fileId === "string" && fileId ? await store.getFiles(set.id, [fileId]) : [];
  if (!file) throw new DocsError("File not found", 404, "not_found");
  const rec = await store.getReviewRow(review.id, file.id);
  // The hash the reviewer can have seen ("" for a row that is pending or failed); the store compares against what is stored.
  const current = toRow(review, file, rec).rowHash ?? "";
  const stored = rec?.rowHash ?? "";
  const conflict = () => new DocsError("This row changed since it was shown (it was re-run). Reload it and code it again.", 409, "row_changed");
  if (body.rowHash !== current) throw conflict();
  let decision: CodingDecision | null = null;
  if (body.coding) {
    const known = new Set(review.issues.map((i) => i.id));
    const issues = Array.isArray(body.issues) ? Array.from(new Set(body.issues.filter((x): x is string => typeof x === "string" && known.has(x)))) : [];
    const note = body.note == null ? null : cleanText(body.note, 2000);
    decision = { coding: body.coding as Coding, issues, note, reviewer: principal.id, reviewerName: principal.name ?? null, at: new Date().toISOString(), rowHash: current };
  }
  if (!(await store.setReviewDecision(review.id, set.id, file.id, decision, stored))) throw conflict();
  recordAudit(principal, "coding.change", { kind: "document_review_row", id: `${review.id}/${file.id}`, label: file.name, matterId: set.matterId ?? undefined }, {
    setId: set.id, reviewId: review.id, fileId: file.id, coding: decision?.coding ?? null, label: decision ? CODING_LABEL[decision.coding] : "cleared", rowHash: current,
  });
  return toRow(review, file, await store.getReviewRow(review.id, file.id));
}

// ---- row hash ---------------------------------------------------------------------------------------------------

/** Canonical JSON (object keys sorted) so the hash does not depend on key order. */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])]));
  return v;
}

/** SHA-256 over (review version, text hash, normalized model output): what a coding decision binds to. */
export function computeRowHash(version: number, textHash: string, result: ReviewResult): string {
  const output = { docType: result.docType, summary: result.summary, importance: result.importance, issues: result.issues, privilege: result.privilege, cells: result.cells, coverage: result.coverage };
  return createHash("sha256").update(JSON.stringify(canonical({ version, textHash, output }))).digest("hex");
}

// ---- chat facade ------------------------------------------------------------------------------------------------

export interface ChatReviewQuery { reviewId?: string; issue?: string; docType?: string; privilege?: string; coding?: string; q?: string; limit?: number }

/**
 * Read-only review rows for Chat, limited to `setIds` the principal may read (unknown ids dropped, never widened).
 * Without `reviewId` the most recently updated review of those sets is used. Returns compact rows with page-cited values.
 */
export async function reviewRowsForChat(principal: Principal, setIds: string[], query: ChatReviewQuery) {
  if (!Array.isArray(setIds) || !setIds.length) return { reviews: [], review: null, total: 0, rows: [] };
  const store = await docStore();
  const sets = await readableSetIds(principal, setIds, store);
  const reviews = (await Promise.all(sets.map(async (s) => (await store.listReviews(s.id)).map((r) => ({ r, set: s }))))).flat()
    .sort((a, b) => b.r.updatedAt.localeCompare(a.r.updatedAt));
  const listed = reviews.slice(0, 20).map(({ r, set }) => ({ id: r.id, name: r.name, setId: set.id, setName: set.name, area: PRACTICE_AREA_LABEL[r.area] ?? r.area }));
  const chosen = query.reviewId ? reviews.find((x) => x.r.id === query.reviewId) : reviews[0];
  if (!chosen) return { reviews: listed, review: null, total: 0, rows: [] };
  const review = chosen.r;
  const limit = Number.isFinite(Number(query.limit)) && Number(query.limit) > 0 ? Math.max(1, Math.min(Math.floor(Number(query.limit)), 40)) : 15;
  const rq = parseRowQuery({ issue: query.issue, docType: query.docType, privilege: query.privilege, coding: query.coding, q: query.q, sort: "importance" });
  const page = await store.queryReviewRows(review.setId, review.id, rq, { offset: 0, limit });
  const rows = page.items.map((x) => toRow(review, x.file, x.rec));
  const labelOf = new Map(review.columns.map((c) => [c.id, c.label]));
  return {
    reviews: listed,
    review: { id: review.id, name: review.name, setId: review.setId, issues: review.issues.map((i) => ({ id: i.id, label: i.label })), docTypes: review.docTypes },
    total: page.total,
    rows: rows.map((r) => ({
      file: r.fileName,
      fileId: r.fileId,
      status: r.status,
      docType: r.docType,
      importance: r.importance,
      summary: r.summary.slice(0, 400),
      issues: r.issues.filter((i) => i.relevance !== "none").map((i) => ({ issue: i.issueId, relevance: i.relevance, reason: i.reason.slice(0, 200), page: i.page, quoteFound: i.quoteFound })),
      privilege: r.privilege && r.privilege.flag !== "none" ? { flag: r.privilege.flag, basis: r.privilege.basis.slice(0, 200), page: r.privilege.page, quoteFound: r.privilege.quoteFound } : null,
      coverage: r.status === "partial" ? { read: r.coverage.read, total: r.coverage.total, unreadPages: r.coverage.unreadPages.slice(0, 50) } : undefined,
      values: Object.entries(r.cells).filter(([, c]) => c.value != null).map(([id, c]) => ({
        column: labelOf.get(id) ?? id, value: (c.value ?? "").slice(0, 300), status: c.status, page: c.page, quoteFound: c.quoteFound, quote: c.quote.slice(0, 200),
        alternatives: c.alternatives?.length ? c.alternatives.map((a) => ({ value: a.value.slice(0, 200), page: a.page })) : undefined,
      })),
      coding: r.decision ? { coding: r.decision.coding, stale: r.decisionStale } : null,
    })),
  };
}
