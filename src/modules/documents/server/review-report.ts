import "server-only";
import type { Principal } from "@/lib/auth/types";
import { REVIEW_LIMITS, type ReportAnswer, type ReportEvent, type ReviewReport } from "../review-types";
import { DocsError, loadSet } from "./access";
import { askDocSet } from "./ask";
import { loadReview } from "./review";
import { recordAudit } from "./sets";
import { docStore } from "./store";

/**
 * The review report: each question is answered across the whole set with the same retrieval and citation mapping as
 * Ask (askDocSet), so answers carry [n] citations to file + page and unresolved markers are kept, never re-bound.
 * Questions run with small concurrency; the latest report (answered questions only, in order) is stored on the review.
 */

export const REPORT_CONCURRENCY = 2;

export async function getReport(principal: Principal, setId: string, reviewId: string): Promise<ReviewReport | null> {
  const set = await loadSet(principal, setId, "read");
  const store = await docStore();
  const review = await loadReview(store, set, reviewId);
  return store.getReviewReport(review.id);
}

/** Validate the questions for a report run (the review's own when none are sent). Throws 404/403/422 before streaming. */
export async function prepareReport(principal: Principal, setId: string, reviewId: string, input: { questions?: unknown }): Promise<string[]> {
  const set = await loadSet(principal, setId, "write");
  const store = await docStore();
  const review = await loadReview(store, set, reviewId);
  let questions = review.questions;
  if (input?.questions != null) {
    if (!Array.isArray(input.questions)) throw new DocsError("questions must be a list of strings", 422, "invalid");
    questions = Array.from(new Set(input.questions.filter((q): q is string => typeof q === "string").map((q) => q.replace(/\s+/g, " ").trim()).filter(Boolean)));
    if (questions.some((q) => q.length > 1000)) throw new DocsError("A question is too long (1000 characters at most)", 422, "invalid");
  }
  if (!questions.length) throw new DocsError("The review has no questions; add at least one", 422, "invalid");
  if (questions.length > REVIEW_LIMITS.maxQuestions) throw new DocsError(`At most ${REVIEW_LIMITS.maxQuestions} questions`, 422, "invalid");
  return questions;
}

export async function runReport(principal: Principal, setId: string, reviewId: string, questions: string[], emit: (e: ReportEvent) => void, signal?: AbortSignal): Promise<ReviewReport | null> {
  const set = await loadSet(principal, setId, "write");
  const store = await docStore();
  const review = await loadReview(store, set, reviewId);
  emit({ type: "report.started", total: questions.length });
  const answers: (ReportAnswer | null)[] = questions.map(() => null);
  let next = 0;
  const worker = async () => {
    while (next < questions.length && !signal?.aborted) {
      const index = next++;
      const question = questions[index];
      emit({ type: "question.started", index, question });
      try {
        const a = await askDocSet(principal, set.id, { question }, () => {}, signal);
        const answer: ReportAnswer = { question, answer: a.answer, citations: a.citations, unresolved: a.unresolved, noEvidence: a.noEvidence };
        answers[index] = answer;
        emit({ type: "question.completed", index, answer });
      } catch (e) {
        if (signal?.aborted) return;
        emit({ type: "question.failed", index, question, error: ((e as Error).message || String(e)).slice(0, 300) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(REPORT_CONCURRENCY, questions.length) }, worker));
  if (signal?.aborted) return null; // cancelled: the previous report stays
  const done = answers.filter((a): a is ReportAnswer => !!a);
  if (!done.length) {
    emit({ type: "report.failed", error: "No question could be answered; the previous report (if any) is kept." });
    return null;
  }
  const fresh = await store.getSet(set.id);
  const report: ReviewReport = { reviewId: review.id, answers: done, generatedAt: new Date().toISOString(), generatedBy: principal.name || principal.id, fileCount: fresh?.fileCount ?? set.fileCount };
  await store.putReviewReport(review.id, report);
  recordAudit(principal, "ai.generate", { kind: "document_review_report", id: review.id, label: review.name, matterId: set.matterId ?? undefined }, { setId: set.id, questions: questions.length, answered: done.length });
  emit({ type: "report.completed", report });
  return report;
}
