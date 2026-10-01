import "server-only";
import { createHash } from "node:crypto";
import { nanoid } from "nanoid";
import type { Principal } from "@/lib/auth/types";
import {
  CODING_LABEL, isColumnId, PRACTICE_AREA_LABEL, RELEVANCE_RANK, REVIEW_LIMITS, type Coding, type CodingDecision, type CodingInput, type ColumnKind,
  type CreateReviewInput, type DocReview, type DocReviewRow, type IssueAssessment, type PracticeAreaId, type PrivilegeFlag, type Relevance,
  type ReviewCell, type ReviewColumn, type ReviewCounts, type ReviewFacets, type ReviewIssue, type RowQuery, type RowStatus,
} from "../review-types";
import type { DocSet } from "../types";
import { DocsError, loadSet, readableSetIds } from "./access";
import { getPlaybook } from "./playbooks";
import { recordAudit } from "./sets";
import { docStore, type DocStore, type ReviewResult, type ReviewRowRecord, type StoredFile, type StoredReview } from "./store";
import { normalizeForMatch } from "./text";

/**
 * Document review (discovery) service: review definitions, the per-file rows (built in code from the set's files and
 * the stored row records), filters/facets, and coding decisions. The run itself lives in review-run.ts, the report in
 * review-report.ts and the exports in review-export.ts.
 *
 * Authorization follows the set exactly (loadSet): unknown and unreadable sets are 404, a readable set the caller may not
 * change is 403. A review id that does not belong to the set is 404.
 */

/** Bumped whenever the reviewer prompt or schema changes; rows produced by an older reviewer are pending again. */
export const REVIEWER_VERSION = 1;
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

/** Cheap fingerprint of a file's text state; it changes when pages are appended or OCR'd. */
export function fileStamp(f: StoredFile): string {
  return `r${REVIEWER_VERSION}|${f.chars}|${f.pagesReceived ?? f.pages}|${f.pages}|${f.status}|${(f.ocrDonePages ?? []).join(",")}`;
}

/** True when the record was produced under the current review version and file text. */
export function rowCurrent(review: Pick<StoredReview, "version">, file: StoredFile, rec: ReviewRowRecord | undefined | null): rec is ReviewRowRecord {
  return !!rec && rec.state !== "pending" && rec.reviewVersion === review.version && rec.fileStamp === fileStamp(file);
}

/** Whether a run should (re)process this file. Files still uploading never count. */
export function needsWork(review: Pick<StoredReview, "version">, file: StoredFile, rec: ReviewRowRecord | undefined | null): boolean {
  if (fileReviewable(file) === "uploading") return false;
  if (!rowCurrent(review, file, rec)) return true;
  if (rec.state === "progress") return true;
  if (rec.state === "failed") return rec.attempts < MAX_REVIEW_ATTEMPTS;
  return false;
}

function emptyCell(): ReviewCell {
  return { value: null, status: "not_stated", quote: "", page: null, quoteFound: false };
}

function emptyIssue(issueId: string): IssueAssessment {
  return { issueId, relevance: "none", reason: "", quote: "", page: null, quoteFound: false };
}

/** The public row for one file (record may be missing: pending). Stale results are shown filtered to the current definition. */
export function toRow(review: StoredReview, file: StoredFile, rec: ReviewRowRecord | undefined | null): DocReviewRow {
  const current = rowCurrent(review, file, rec);
  const result = rec?.result ?? null;
  let status: RowStatus = "pending";
  if (current && rec.state === "failed") status = "failed";
  else if (current && rec.state === "done" && result) status = result.coverage.read < result.coverage.total ? "partial" : "done";
  const cells: Record<string, ReviewCell> = {};
  for (const c of review.columns) cells[c.id] = result?.cells?.[c.id] ?? emptyCell();
  const issues = result ? review.issues.map((i) => result.issues.find((x) => x.issueId === i.id) ?? emptyIssue(i.id)) : [];
  const rowHash = rec?.rowHash ?? null;
  const decision = rec?.decision ?? null;
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
    decisionStale: !!decision && decision.rowHash !== (rowHash ?? ""),
    coverage: result?.coverage ?? { read: 0, total: file.chars },
    error: rec?.state === "failed" ? rec.error : null,
    updatedAt: rec && rec.state !== "pending" ? rec.updatedAt : null,
  };
}

export function countsFor(review: StoredReview, files: StoredFile[], recs: Map<string, ReviewRowRecord>): ReviewCounts {
  const c: ReviewCounts = { files: files.length, done: 0, pending: 0, failed: 0, coded: 0, stale: 0, privilegeFlags: 0 };
  for (const f of files) {
    const row = toRow(review, f, recs.get(f.id));
    if (row.status === "done" || row.status === "partial") c.done++;
    else if (row.status === "failed") c.failed++;
    else c.pending++;
    if (row.decision) { if (row.decisionStale) c.stale++; else c.coded++; }
    if (row.status !== "pending" && row.privilege && row.privilege.flag !== "none") c.privilegeFlags++;
  }
  return c;
}

async function loadParts(store: DocStore, review: StoredReview) {
  const [files, recs] = await Promise.all([store.allFiles(review.setId), store.listReviewRows(review.id)]);
  return { files, recs: new Map(recs.map((r) => [r.fileId, r])) };
}

export async function withCounts(store: DocStore, review: StoredReview): Promise<DocReview> {
  const { files, recs } = await loadParts(store, review);
  return { ...review, counts: countsFor(review, files, recs) };
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
  const files = await store.allFiles(set.id);
  return Promise.all(reviews.map(async (r) => {
    const recs = await store.listReviewRows(r.id);
    return { ...r, counts: countsFor(r, files, new Map(recs.map((x) => [x.fileId, x]))) };
  }));
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

export interface ReviewPatch { name?: unknown; columns?: unknown; issues?: unknown; questions?: unknown; docTypes?: unknown }

export async function updateReview(principal: Principal, setId: string, reviewId: string, patch: ReviewPatch): Promise<DocReview> {
  const set = await loadSet(principal, setId, "write");
  const store = await docStore();
  const review = await loadReview(store, set, reviewId);
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
  await store.updateReview(next);
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

function rowText(r: DocReviewRow): string {
  return normalizeForMatch([r.fileName, r.docType ?? "", r.summary, r.decision?.note ?? "", ...Object.values(r.cells).map((c) => c.value ?? ""), ...r.issues.map((i) => i.reason), r.privilege?.basis ?? ""].join(" \u0001 "));
}

export function filterRows(rows: DocReviewRow[], q: RowQuery): DocReviewRow[] {
  const words = q.q ? normalizeForMatch(q.q).split(" ").filter(Boolean) : [];
  const min = RELEVANCE_RANK[q.minRelevance ?? "low"];
  const docType = q.docType?.toLowerCase();
  return rows.filter((r) => {
    if (q.status && r.status !== q.status) return false;
    if (docType && (r.docType ?? "").toLowerCase() !== docType) return false;
    if (q.privilege && (r.privilege?.flag ?? "none") !== q.privilege) return false;
    if (q.issue) {
      const a = r.issues.find((i) => i.issueId === q.issue);
      if (!a || RELEVANCE_RANK[a.relevance] < Math.max(1, min)) return false;
    }
    if (q.coding) {
      if (q.coding === "uncoded") { if (r.decision) return false; }
      else if (q.coding === "stale") { if (!r.decisionStale) return false; }
      else if (r.decision?.coding !== q.coding) return false;
    }
    if (words.length) { const hay = rowText(r); if (!words.every((w) => hay.includes(w))) return false; }
    return true;
  });
}

export function sortRows(rows: DocReviewRow[], sort: RowQuery["sort"]): DocReviewRow[] {
  const byName = (a: DocReviewRow, b: DocReviewRow) => a.fileName.localeCompare(b.fileName) || a.fileId.localeCompare(b.fileId);
  const out = [...rows];
  if (sort === "name") out.sort(byName);
  else if (sort === "updated") out.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") || byName(a, b));
  else out.sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0) || byName(a, b));
  return out;
}

export function facetsFor(review: StoredReview, rows: DocReviewRow[]): ReviewFacets {
  const docTypes = new Map<string, number>();
  const issues = review.issues.map((i) => ({ issueId: i.id, high: 0, medium: 0, low: 0 }));
  const privilege = { possible: 0, likely: 0 };
  const coding: ReviewFacets["coding"] = {};
  for (const r of rows) {
    if (r.docType) docTypes.set(r.docType, (docTypes.get(r.docType) ?? 0) + 1);
    for (const a of r.issues) {
      const f = issues.find((x) => x.issueId === a.issueId);
      if (f && a.relevance !== "none") f[a.relevance]++;
    }
    if (r.privilege?.flag === "possible") privilege.possible++;
    else if (r.privilege?.flag === "likely") privilege.likely++;
    const k = !r.decision ? "uncoded" : r.decision.coding;
    coding[k] = (coding[k] ?? 0) + 1;
    if (r.decisionStale) coding.stale = (coding.stale ?? 0) + 1;
  }
  return {
    docTypes: Array.from(docTypes.entries()).map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)),
    issues,
    privilege,
    coding,
  };
}

/** Every row of a review (one per file in the set), unfiltered. */
export async function allRows(store: DocStore, review: StoredReview): Promise<DocReviewRow[]> {
  const { files, recs } = await loadParts(store, review);
  return files.map((f) => toRow(review, f, recs.get(f.id)));
}

/** Rows page + total (after filters) + facets (over every row of the review, unfiltered). */
export async function listRows(principal: Principal, setId: string, reviewId: string, query: RowQuery): Promise<{ rows: DocReviewRow[]; total: number; facets: ReviewFacets }> {
  const set = await loadSet(principal, setId, "read");
  const store = await docStore();
  const review = await loadReview(store, set, reviewId);
  const rows = await allRows(store, review);
  const filtered = sortRows(filterRows(rows, query), query.sort);
  const offset = query.offset ?? 0;
  const limit = query.limit ?? 100;
  return { rows: filtered.slice(offset, offset + limit), total: filtered.length, facets: facetsFor(review, rows) };
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
  const current = rec?.rowHash ?? "";
  const conflict = () => new DocsError("This row changed since it was shown (it was re-run). Reload it and code it again.", 409, "row_changed");
  if (body.rowHash !== current) throw conflict();
  let decision: CodingDecision | null = null;
  if (body.coding) {
    const known = new Set(review.issues.map((i) => i.id));
    const issues = Array.isArray(body.issues) ? Array.from(new Set(body.issues.filter((x): x is string => typeof x === "string" && known.has(x)))) : [];
    const note = body.note == null ? null : cleanText(body.note, 2000);
    decision = { coding: body.coding as Coding, issues, note, reviewer: principal.id, reviewerName: principal.name ?? null, at: new Date().toISOString(), rowHash: current };
  }
  if (!(await store.setReviewDecision(review.id, set.id, file.id, decision, current))) throw conflict();
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
  const rows = sortRows(filterRows(await allRows(store, review), parseRowQuery({ issue: query.issue, docType: query.docType, privilege: query.privilege, coding: query.coding, q: query.q })), "importance");
  const limit = Math.max(1, Math.min(Math.floor(query.limit ?? 15), 40));
  const labelOf = new Map(review.columns.map((c) => [c.id, c.label]));
  return {
    reviews: listed,
    review: { id: review.id, name: review.name, setId: review.setId, issues: review.issues.map((i) => ({ id: i.id, label: i.label })), docTypes: review.docTypes },
    total: rows.length,
    rows: rows.slice(0, limit).map((r) => ({
      file: r.fileName,
      fileId: r.fileId,
      status: r.status,
      docType: r.docType,
      importance: r.importance,
      summary: r.summary.slice(0, 400),
      issues: r.issues.filter((i) => i.relevance !== "none").map((i) => ({ issue: i.issueId, relevance: i.relevance, reason: i.reason.slice(0, 200), page: i.page, quoteFound: i.quoteFound })),
      privilege: r.privilege && r.privilege.flag !== "none" ? { flag: r.privilege.flag, basis: r.privilege.basis.slice(0, 200), page: r.privilege.page, quoteFound: r.privilege.quoteFound } : null,
      values: Object.entries(r.cells).filter(([, c]) => c.status !== "not_stated").map(([id, c]) => ({ column: labelOf.get(id) ?? id, value: (c.value ?? "").slice(0, 300), page: c.page, quoteFound: c.quoteFound, quote: c.quote.slice(0, 200) })),
      coding: r.decision ? { coding: r.decision.coding, stale: r.decisionStale } : null,
    })),
  };
}
