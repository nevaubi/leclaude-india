import { describe, expect, it } from "vitest";
import type { DocReview, ReportAnswer, ReviewCell, ReviewPlaybook } from "@/modules/documents/review-types";
import {
  buildReviewDefinition, cellView, codingView, definitionChanges, groupPlaybooks, makeId, mapCitations, rankedIssues, reportCsv,
  reviewUrl, rowQueryFromFilters, rowQueryString,
} from "@/modules/documents/components/review/review-helpers";
import { dispositionName, markersIn, WORKSPACE_TABS } from "@/modules/documents/components/format";

const cell = (p: Partial<ReviewCell>): ReviewCell => ({ value: "Delhi", status: "found", quote: "seat shall be Delhi", page: 4, quoteFound: true, ...p });

describe("row queries", () => {
  it("serialises filters, dropping empties and defaults", () => {
    expect(rowQueryString({})).toBe("");
    expect(rowQueryString({ q: "  notice ", sort: "importance", minRelevance: "high" })).toBe("q=notice");
    expect(rowQueryString({ issue: "breach", minRelevance: "high", coding: "stale", sort: "name", offset: 150, limit: 150 }))
      .toBe("issue=breach&minRelevance=high&coding=stale&sort=name&offset=150&limit=150");
    expect(rowQueryString({ issue: "breach", minRelevance: "low" })).toBe("issue=breach");
    expect(rowQueryString({ docType: "Board resolution & minutes", privilege: "likely", status: "failed" })).toBe("docType=Board+resolution+%26+minutes&privilege=likely&status=failed");
  });
  it("builds a RowQuery from filter values and ignores unknown values", () => {
    expect(rowQueryFromFilters({ q: "x", issue: "i1", minRelevance: "medium", coding: "uncoded", privilege: "bogus", status: "done", sort: "updated" }))
      .toEqual({ q: "x", issue: "i1", minRelevance: "medium", coding: "uncoded", status: "done", sort: "updated" });
    expect(rowQueryFromFilters({ minRelevance: "high" })).toEqual({});
  });
  it("encodes ids in URLs", () => {
    expect(reviewUrl("set 1", "r/2", "/rows")).toBe("/api/documents/sets/set%201/reviews/r%2F2/rows");
  });
});

describe("cells and rows", () => {
  it("distinguishes found, unverified, conflicting, not read and not stated", () => {
    expect(cellView(cell({}))).toEqual({ kind: "value", text: "Delhi", quoteFound: true, conflict: false, alternatives: 0 });
    expect(cellView(cell({ status: "unverified", quoteFound: false }))).toMatchObject({ kind: "value", quoteFound: false, conflict: false });
    expect(cellView(cell({ status: "unverified", quoteFound: true }))).toMatchObject({ quoteFound: false }); // quote too short / lacks the value
    expect(cellView(cell({ status: "found", quoteFound: false }))).toMatchObject({ quoteFound: false });
    expect(cellView(cell({ status: "conflict", alternatives: [{ value: "Mumbai", quote: "seat at Mumbai", page: 9, quoteFound: true }] }))).toMatchObject({ kind: "value", text: "Delhi", conflict: true, alternatives: 1 });
    expect(cellView(cell({ status: "not_read", value: null }))).toEqual({ kind: "not_read" });
    expect(cellView(cell({ status: "not_stated", value: null }))).toEqual({ kind: "not_stated" });
    expect(cellView(undefined)).toEqual({ kind: "empty" });
  });
  it("ranks issues strongest first and hides not-relevant ones", () => {
    const ev = { quote: "", page: null, quoteFound: false, reason: "" };
    const row = { issues: [{ issueId: "a", relevance: "low" as const, ...ev }, { issueId: "b", relevance: "none" as const, ...ev }, { issueId: "c", relevance: "high" as const, ...ev }, { issueId: "d", relevance: "low" as const, ...ev }] };
    expect(rankedIssues(row, ["d", "a", "b", "c"]).map((i) => i.issueId)).toEqual(["c", "d", "a"]);
  });
  it("reports stale coding", () => {
    expect(codingView({ decision: null, decisionStale: false })).toBeNull();
    expect(codingView({ decision: { coding: "key", issues: [], note: null, reviewer: "u", reviewerName: null, at: "2026-01-01", rowHash: "h" }, decisionStale: true })).toEqual({ label: "Key document", stale: true });
  });
});

describe("review definition editor", () => {
  it("makes unique, valid column ids from labels", () => {
    expect(makeId("Seat of arbitration", [])).toBe("seat_of_arbitration");
    expect(makeId("Seat of arbitration", ["seat_of_arbitration"])).toBe("seat_of_arbitration_2");
    expect(makeId("1st notice date", [])).toBe("col_1st_notice_date");
    expect(makeId("—", [])).toBe("col");
    expect(makeId("Ünïcode Ćlause", [])).toBe("unicode_clause");
    expect(makeId("x".repeat(80), []).length).toBeLessThanOrEqual(40);
  });
  it("validates and keeps existing ids", () => {
    const ok = buildReviewDefinition({ name: " Review ", columns: [{ id: "seat", label: "Seat", prompt: "Seat of arbitration", kind: "choice", choices: "Delhi, Mumbai, Delhi" }, { label: "", prompt: "", kind: "text", choices: "" }, { label: "Notice date", prompt: "Date of the notice", kind: "date", choices: "" }], issues: [{ label: "Termination", description: "Notice of termination" }] }, { requireName: true });
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.name).toBe("Review");
    expect(ok.columns.map((c) => c.id)).toEqual(["seat", "notice_date"]);
    expect(ok.columns[0].choices).toEqual(["Delhi", "Mumbai"]);
    expect(ok.columns[1].choices).toBeUndefined();
    expect(ok.issues[0].id).toBe("termination");
  });
  it("reports missing pieces", () => {
    const bad = buildReviewDefinition({ name: "", columns: [{ label: "Seat", prompt: "", kind: "choice", choices: "Delhi" }], issues: [] }, { requireName: true });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.errors.join(" ")).toMatch(/name/);
    expect(bad.errors.join(" ")).toMatch(/what to extract/);
    expect(bad.errors.join(" ")).toMatch(/at least two/);
    const empty = buildReviewDefinition({ name: "x", columns: [], issues: [] });
    expect(empty.ok).toBe(false);
  });
  it("counts changed and removed columns/issues", () => {
    const before = { columns: [{ id: "a", label: "A", prompt: "p", kind: "text" as const }, { id: "b", label: "B", prompt: "p", kind: "text" as const }], issues: [{ id: "i", label: "I", description: "d" }] } as Pick<DocReview, "columns" | "issues">;
    expect(definitionChanges(before, { columns: before.columns, issues: before.issues })).toEqual({ columns: 0, issues: 0 });
    expect(definitionChanges(before, { columns: [{ ...before.columns[0], prompt: "q" }], issues: [...before.issues, { id: "j", label: "J", description: "d" }] })).toEqual({ columns: 2, issues: 1 });
  });
});

describe("playbooks", () => {
  it("groups by practice area in the fixed area order", () => {
    const pb = (id: string, area: ReviewPlaybook["area"]) => ({ id, area, name: id, description: "", statutes: [], docTypes: [], issues: [], columns: [], questions: [] }) as ReviewPlaybook;
    const g = groupPlaybooks([pb("x", "ip"), pb("y", "general"), pb("z", "ip")]);
    expect(g.map((x) => x.area)).toEqual(["general", "ip"]);
    expect(g[1].items.map((x) => x.id)).toEqual(["x", "z"]);
    expect(g[1].label).toBe("Intellectual property");
  });
});

describe("report citations", () => {
  const answer: ReportAnswer = {
    question: "When was notice given?",
    answer: "Notice was given on 3 March 2021 [1] and again later [2, 3].",
    citations: [
      { n: 1, source: "docs://s/f1/p/2#0", fileId: "f1", fileName: "notice.pdf", page: 2, snippet: "3rd March, 2021" },
      { n: 3, source: "docs://s/f2/p/5#1", fileId: "f2", fileName: "reply.pdf", page: 5, snippet: "reply" },
    ],
    unresolved: [2, 3],
    noEvidence: false,
  };
  it("binds markers to citations by number and never re-binds unresolved ones", () => {
    const { states, byN } = mapCitations(answer, markersIn(answer.answer));
    expect(states.map((s) => [s.n, s.state])).toEqual([[1, "resolved"], [2, "unresolved"], [3, "unresolved"]]);
    expect(byN.has(3)).toBe(false); // listed as unresolved by the server, so not shown as a source chip
  });
  it("exports the report as CSV with formula neutralisation", () => {
    const csv = reportCsv([answer, { question: "=HYPERLINK()", answer: "None.", citations: [], unresolved: [], noEvidence: true }]);
    const lines = csv.trim().split("\r\n");
    expect(lines[0]).toBe("Question,Answer,Status,Marker,File,Page,Passage");
    expect(lines).toHaveLength(4);
    expect(lines[3]).toContain("'=HYPERLINK()");
    expect(lines[3]).toContain("The documents do not establish this");
  });
});

describe("misc", () => {
  it("parses Content-Disposition file names", () => {
    expect(dispositionName('attachment; filename="review.xlsx"')).toBe("review.xlsx");
    expect(dispositionName("attachment; filename*=UTF-8''R%C3%A9view%20one.csv")).toBe("R\u00e9view one.csv");
    expect(dispositionName(null)).toBeNull();
  });
  it("accepts the review tab", () => {
    expect(WORKSPACE_TABS).toContain("review");
  });
});
