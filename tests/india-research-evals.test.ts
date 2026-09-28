/** Runs the India research evals (evals/india-research) under vitest: deterministic, offline, fakes only. */
import { beforeAll, describe, expect, it } from "vitest";
import { db, resetSqlite } from "@/lib/db";
import { loadIndiaCases, runIndiaResearchEvals } from "../evals/india-research/harness";

beforeAll(() => { resetSqlite(); db(); });

describe("India research evals", () => {
  it("has the five required cases with code grading", () => {
    const ids = loadIndiaCases().map((c) => c.id);
    expect(ids).toEqual(["india-adverse-controlling-sc", "india-forum-karnataka-vs-telangana", "india-ipc-bns-boundary", "india-kannada-query", "india-no-answer-in-corpus"]);
    expect(loadIndiaCases().every((c) => c.grading === "code" && c.passCriteria.length > 0 && !c.requiresModel)).toBe(true);
  });
  it("every case passes every check", async () => {
    const results = await runIndiaResearchEvals();
    const failures = results.flatMap((r) => r.checks.filter((c) => !c.ok).map((c) => `${r.id}: ${c.name} (${c.actual ?? ""})`));
    expect(failures).toEqual([]);
    expect(results.every((r) => r.status === "pass")).toBe(true);
    const timed = results.filter((r) => r.metrics);
    for (const r of timed) console.log(`[india-evals] ${r.id} firstEvidenceMs=${r.metrics?.firstEvidenceMs} verifiedAnswerMs=${r.metrics?.verifiedAnswerMs} (${r.durationMs} ms)`);
  }, 60_000);
});
