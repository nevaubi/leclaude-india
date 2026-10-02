/**
 * Pure helpers for the Review (AI discovery) UI: URLs, row-query strings, cell display, column ids, editor validation,
 * citation mapping and the report CSV. No DOM, no React; unit-tested in tests/documents-review-ui.test.ts.
 */
import type { DocCitation } from "../../types";
import {
  CODING_LABEL, PRACTICE_AREA_LABEL, RELEVANCE_RANK, REVIEW_LIMITS, isColumnId,
  type Coding, type ColumnKind, type DocReview, type DocReviewRow, type IssueAssessment, type PracticeAreaId, type Relevance,
  type ReportAnswer, type ReviewCell, type ReviewColumn, type ReviewIssue, type ReviewPlaybook, type RowQuery,
} from "../../review-types";
import { toCsv } from "../format";

export const docsBase = "/api/documents";
export const reviewsUrl = (setId: string) => `${docsBase}/sets/${encodeURIComponent(setId)}/reviews`;
export const reviewUrl = (setId: string, reviewId: string, rest = "") => `${reviewsUrl(setId)}/${encodeURIComponent(reviewId)}${rest}`;

// ---- row queries ----------------------------------------------------------------------------------------------------

/** RowQuery → query string (stable key order, empty values dropped). `minRelevance` only travels with `issue`. */
export function rowQueryString(q: RowQuery): string {
  const sp = new URLSearchParams();
  const put = (k: string, v: string | number | undefined | null) => { if (v !== undefined && v !== null && String(v).trim() !== "") sp.set(k, String(v).trim()); };
  put("q", q.q);
  put("issue", q.issue);
  if (q.issue && q.minRelevance && q.minRelevance !== "low") put("minRelevance", q.minRelevance);
  put("docType", q.docType);
  put("privilege", q.privilege);
  put("coding", q.coding);
  put("status", q.status);
  if (q.sort && q.sort !== "importance") put("sort", q.sort);
  if (q.offset) put("offset", Math.max(0, Math.floor(q.offset)));
  if (q.limit) put("limit", Math.max(1, Math.floor(q.limit)));
  return sp.toString();
}

/** Filter-bar values (strings, possibly undefined) → RowQuery, ignoring unknown values. */
export function rowQueryFromFilters(f: { q?: string; issue?: string | null; minRelevance?: string | null; docType?: string | null; privilege?: string | null; coding?: string | null; status?: string | null; sort?: string | null }): RowQuery {
  const pick = <T extends string>(v: string | null | undefined, allowed: readonly T[]): T | undefined => (v && (allowed as readonly string[]).includes(v) ? (v as T) : undefined);
  const out: RowQuery = {};
  if (f.q?.trim()) out.q = f.q.trim();
  if (f.issue) { out.issue = f.issue; const m = pick(f.minRelevance, ["high", "medium", "low"] as const); if (m) out.minRelevance = m; }
  if (f.docType) out.docType = f.docType;
  const p = pick(f.privilege, ["none", "possible", "likely"] as const); if (p) out.privilege = p;
  const c = pick(f.coding, ["key", "relevant", "not_relevant", "privileged", "needs_review", "uncoded", "stale"] as const); if (c) out.coding = c;
  const s = pick(f.status, ["pending", "done", "partial", "failed"] as const); if (s) out.status = s;
  const so = pick(f.sort, ["importance", "name", "updated"] as const); if (so) out.sort = so;
  return out;
}

// ---- cells ----------------------------------------------------------------------------------------------------------

export type CellView =
  | { kind: "value"; text: string; quoteFound: boolean; conflict: boolean; alternatives: number }
  | { kind: "not_stated" }
  | { kind: "not_read" }
  | { kind: "empty" };

/**
 * How a cell reads in the grid: a value (quote found in the file or not; conflicting values flagged), "not stated"
 * (em dash), "not read" (nothing in the part read, but part of the file was not read) or nothing yet (not reviewed).
 */
export function cellView(cell: ReviewCell | undefined | null): CellView {
  if (!cell) return { kind: "empty" };
  if (cell.status === "not_read") return { kind: "not_read" };
  if (cell.status === "not_stated" || cell.value == null || cell.value.trim() === "") return { kind: "not_stated" };
  const conflict = cell.status === "conflict";
  return { kind: "value", text: cell.value, quoteFound: cell.status !== "unverified" && cell.quoteFound, conflict, alternatives: conflict ? (cell.alternatives?.length ?? 0) : 0 };
}

/** Issues worth showing on a row: relevance above none, strongest first, then playbook order. */
export function rankedIssues(row: Pick<DocReviewRow, "issues">, order: string[]): IssueAssessment[] {
  const pos = new Map(order.map((id, i) => [id, i]));
  return row.issues.filter((i) => i.relevance !== "none").sort((a, b) => RELEVANCE_RANK[b.relevance] - RELEVANCE_RANK[a.relevance] || (pos.get(a.issueId) ?? 99) - (pos.get(b.issueId) ?? 99));
}

export const RELEVANCE_LABEL: Record<Relevance, string> = { high: "High", medium: "Medium", low: "Low", none: "Not relevant" };
export const KIND_LABEL: Record<ColumnKind, string> = { text: "Text", date: "Date", amount: "Amount", yes_no: "Yes / No", choice: "Choice", list: "List", party: "Party" };
export const CODING_KEYS: Coding[] = ["key", "relevant", "not_relevant", "privileged", "needs_review"];
export { CODING_LABEL };

/** "Coding" display for a row: the decision, flagged when it refers to an earlier version of the row. */
export function codingView(row: Pick<DocReviewRow, "decision" | "decisionStale">): { label: string; stale: boolean } | null {
  if (!row.decision) return null;
  return { label: CODING_LABEL[row.decision.coding] ?? row.decision.coding, stale: row.decisionStale };
}

// ---- column / issue editing -----------------------------------------------------------------------------------------

/** A column/issue id from a label: lowercase words joined by "_", starting with a letter, unique among `taken`. */
export function makeId(label: string, taken: Iterable<string>, fallback = "col"): string {
  const used = new Set(taken);
  let base = label.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!/^[a-z]/.test(base)) base = `${fallback}_${base}`.replace(/_+$/, "");
  base = base.slice(0, 36).replace(/_+$/, "") || fallback;
  if (!isColumnId(base)) base = fallback;
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base}_${n}`;
  return id;
}

export interface DraftColumn { id?: string; label: string; prompt: string; kind: ColumnKind; choices: string }
export interface DraftIssue { id?: string; label: string; description: string }

export const toDraftColumn = (c: ReviewColumn): DraftColumn => ({ id: c.id, label: c.label, prompt: c.prompt, kind: c.kind, choices: (c.choices ?? []).join(", ") });
export const toDraftIssue = (i: ReviewIssue): DraftIssue => ({ id: i.id, label: i.label, description: i.description });

export const parseChoices = (s: string) => Array.from(new Set(s.split(/[,;\n]/).map((x) => x.trim()).filter(Boolean)));

export type ReviewDefinition = { ok: true; name: string; columns: ReviewColumn[]; issues: ReviewIssue[]; questions: string[] } | { ok: false; errors: string[] };

/** Validate the editor and build the columns/issues to send. Existing ids are kept; new ones are made from labels. */
export function buildReviewDefinition(draft: { name: string; columns: DraftColumn[]; issues: DraftIssue[]; questions?: string[] }, opts: { requireName?: boolean } = {}): ReviewDefinition {
  const errors: string[] = [];
  const name = draft.name.trim();
  if (opts.requireName && !name) errors.push("Give the review a name.");
  const columns: ReviewColumn[] = [];
  const colIds = new Set<string>(draft.columns.map((c) => c.id).filter((x): x is string => !!x && isColumnId(x)));
  draft.columns.forEach((c, i) => {
    const label = c.label.trim();
    const prompt = c.prompt.trim();
    if (!label && !prompt) return; // blank row: ignored
    if (!label) errors.push(`Column ${i + 1}: add a label.`);
    if (!prompt) errors.push(`Column “${label || i + 1}”: say what to extract.`);
    const choices = c.kind === "choice" ? parseChoices(c.choices) : undefined;
    if (c.kind === "choice" && (choices?.length ?? 0) < 2) errors.push(`Column “${label || i + 1}”: a choice column needs at least two answers.`);
    let id = c.id && isColumnId(c.id) ? c.id : "";
    if (!id) { id = makeId(label || `column ${i + 1}`, colIds, "col"); colIds.add(id); }
    columns.push({ id, label, prompt, kind: c.kind, ...(choices ? { choices } : {}) });
  });
  const issues: ReviewIssue[] = [];
  const issueIds = new Set<string>(draft.issues.map((x) => x.id).filter((x): x is string => !!x));
  draft.issues.forEach((x, i) => {
    const label = x.label.trim();
    const description = x.description.trim();
    if (!label && !description) return;
    if (!label) errors.push(`Issue ${i + 1}: add a label.`);
    if (!description) errors.push(`Issue “${label || i + 1}”: say what makes a document relevant.`);
    let id = x.id ?? "";
    if (!id) { id = makeId(label || `issue ${i + 1}`, issueIds, "issue"); issueIds.add(id); }
    issues.push({ id, label, description });
  });
  if (!columns.length && !issues.length) errors.push("Add at least one column or issue.");
  if (columns.length > REVIEW_LIMITS.maxColumns) errors.push(`A review has at most ${REVIEW_LIMITS.maxColumns} columns.`);
  if (issues.length > REVIEW_LIMITS.maxIssues) errors.push(`A review has at most ${REVIEW_LIMITS.maxIssues} issues.`);
  const questions = (draft.questions ?? []).map((q) => q.trim()).filter(Boolean);
  if (questions.length > REVIEW_LIMITS.maxQuestions) errors.push(`A report has at most ${REVIEW_LIMITS.maxQuestions} questions.`);
  return errors.length ? { ok: false, errors } : { ok: true, name, columns, issues, questions };
}

/** How many columns/issues an edit changes or removes (those files are re-run). */
export function definitionChanges(before: Pick<DocReview, "columns" | "issues">, after: { columns: ReviewColumn[]; issues: ReviewIssue[] }): { columns: number; issues: number } {
  const key = (c: ReviewColumn) => JSON.stringify([c.label, c.prompt, c.kind, c.choices ?? []]);
  const ikey = (i: ReviewIssue) => JSON.stringify([i.label, i.description]);
  const bc = new Map(before.columns.map((c) => [c.id, key(c)]));
  const bi = new Map(before.issues.map((i) => [i.id, ikey(i)]));
  const ac = new Set(after.columns.map((c) => c.id));
  const ai = new Set(after.issues.map((i) => i.id));
  const columns = after.columns.filter((c) => bc.get(c.id) !== key(c)).length + before.columns.filter((c) => !ac.has(c.id)).length;
  const issues = after.issues.filter((i) => bi.get(i.id) !== ikey(i)).length + before.issues.filter((i) => !ai.has(i.id)).length;
  return { columns, issues };
}

// ---- playbooks ------------------------------------------------------------------------------------------------------

export function groupPlaybooks(list: ReviewPlaybook[]): { area: PracticeAreaId; label: string; items: ReviewPlaybook[] }[] {
  const order = Object.keys(PRACTICE_AREA_LABEL) as PracticeAreaId[];
  const rank = (a: PracticeAreaId) => { const i = order.indexOf(a); return i === -1 ? 99 : i; };
  const by = new Map<PracticeAreaId, ReviewPlaybook[]>();
  for (const p of list) { const a = by.get(p.area) ?? []; a.push(p); by.set(p.area, a); }
  return [...by.entries()].sort((a, b) => rank(a[0]) - rank(b[0])).map(([area, items]) => ({ area, label: PRACTICE_AREA_LABEL[area] ?? area, items }));
}

// ---- citations in report answers ------------------------------------------------------------------------------------

export type MarkerState = { n: number; state: "resolved"; citation: DocCitation } | { n: number; state: "unresolved" };

/**
 * Map the [n] markers of an answer to citations. A marker without a citation, or listed in `unresolved`, stays
 * unresolved (never re-bound to another passage); citations are matched by number only.
 */
export function mapCitations(answer: Pick<ReportAnswer, "citations" | "unresolved">, markers: number[]): { byN: Map<number, DocCitation>; states: MarkerState[] } {
  const unresolved = new Set(answer.unresolved);
  const byN = new Map<number, DocCitation>();
  for (const c of answer.citations) if (!unresolved.has(c.n) && !byN.has(c.n)) byN.set(c.n, c);
  return { byN, states: markers.map((n): MarkerState => { const c = byN.get(n); return c ? { n, state: "resolved", citation: c } : { n, state: "unresolved" }; }) };
}

export const NO_EVIDENCE_TEXT = "The documents do not establish this";

/** The report as CSV: one row per citation (or one row for an answer without citations). */
export function reportCsv(answers: ReportAnswer[]): string {
  const rows: unknown[][] = [];
  for (const a of answers) {
    const status = a.noEvidence ? NO_EVIDENCE_TEXT : a.unresolved.length ? `Unresolved markers: ${a.unresolved.map((n) => `[${n}]`).join(" ")}` : "";
    if (!a.citations.length) rows.push([a.question, a.answer, status, "", "", "", ""]);
    for (const c of a.citations) rows.push([a.question, a.answer, status, c.n, c.fileName, c.page ?? "", c.snippet]);
  }
  return toCsv(["Question", "Answer", "Status", "Marker", "File", "Page", "Passage"], rows);
}

export const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : 0);
