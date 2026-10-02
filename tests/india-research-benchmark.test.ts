/** India research benchmark (evals/india-research/benchmark): offline grader over fixtures, run in CI. */
import { describe, expect, it } from "vitest";
import { extractAuthorityCitations } from "@/lib/india/citation-strings";
import { loadBenchmarkCases, recallAtK, fuseRanked, runBenchmarkOffline } from "../evals/india-research/benchmark";
import { loadIndiaCases } from "../evals/india-research/harness";

describe("India research benchmark", () => {
  const cases = loadBenchmarkCases();

  it("holds ≥100 questions (with the legacy cases) across categories, with a held-out split", () => {
    expect(cases.length + loadIndiaCases().length).toBeGreaterThanOrEqual(100);
    const cats = new Set(cases.map((c) => c.category));
    for (const k of ["retrieval", "adverse", "no_answer", "transition", "citation_format", "binding_force"]) expect(cats.has(k as never), k).toBe(true);
    expect(cases.filter((c) => c.split === "heldout").length).toBeGreaterThanOrEqual(20);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
  });

  it("every expected authority carries confidence and source; every stated citation parses to one authority citation", () => {
    for (const c of cases) for (const e of c.expected) {
      expect(["high", "medium"], `${c.id}/${e.key}`).toContain(e.confidence);
      expect(e.source.length, `${c.id}/${e.key}`).toBeGreaterThan(5);
      if (e.citation) {
        const parsed = extractAuthorityCitations(e.citation);
        expect(parsed, `${c.id}/${e.key} ${e.citation}`).toHaveLength(1);
        expect(parsed[0].valid, `${c.id}/${e.key}`).toBe(true);
      }
    }
  });

  it("includes the roadmap benchmark: anticipatory bail under s.482 BNSS for a pre-1 July 2024 offence → Chowgule & Co (Bom HC 2024) and Tatheer Jafri (2025:AHC-LKO:18131)", () => {
    const b = cases.find((c) => c.benchmark)!;
    expect(b.question).toBe("anticipatory bail under s.482 BNSS for an offence committed before 1 July 2024");
    expect(b.expected.map((e) => [e.title, e.court, e.citation])).toEqual([["Chowgule & Co. v. State of Goa", "hc-bombay", null], ["Tatheer Jafri v. State of U.P.", "hc-allahabad", "2025:AHC-LKO:18131"]]);
  });

  it("metrics helpers: recall@10 and RRF", () => {
    expect(recallAtK(["a", "b"], ["x", "a", "y"])).toBe(0.5);
    expect(recallAtK([], ["a"])).toBeNull();
    expect(fuseRanked([["a", "b"], ["b", "c"]])).toEqual(["b", "a", "c"]);
  });

  it("offline grader: integrity checks pass on every case; recall@10, resolution, unsupported-claim and binding metrics are reported", () => {
    const { results, summary } = runBenchmarkOffline();
    const failures = results.flatMap((r) => r.checks.filter((c) => !c.ok).map((c) => `${r.id}: ${c.name} (${c.actual ?? ""})`));
    expect(failures).toEqual([]);
    expect(summary.wrongBindingForce).toBe(0);
    expect(summary.fabricatedResolved).toBe(0);
    expect(summary.transitionCorrect).toBe(summary.transitionCases);
    expect(summary.resolutionRate).toBe(1);
    // Fixture recall: expansion must never lose recall against the base query, and the benchmark case must be complete.
    expect(summary.recall10!).toBeGreaterThanOrEqual(summary.recall10Baseline!);
    expect(summary.recall10!).toBeGreaterThanOrEqual(0.95);
    expect(results.find((r) => r.id === "bench-tr-benchmark")?.metrics.recall10).toBe(1);
    // Claims attributed to metadata-only fixture records are demoted by the code checks: the rate is exactly their share.
    const metaClaims = results.reduce((a, r) => a + r.metrics.unsupported, 0);
    expect(summary.unsupportedClaimRate).toBeGreaterThan(0);
    expect(metaClaims).toBeGreaterThan(0);
    console.log(`[india-benchmark] cases=${summary.cases} recall@10=${summary.recall10?.toFixed(3)} (base query ${summary.recall10Baseline?.toFixed(3)}) resolution=${summary.resolutionRate} unsupported-claim-rate=${summary.unsupportedClaimRate?.toFixed(3)} wrong-binding=${summary.wrongBindingForce} fabricated-resolved=${summary.fabricatedResolved} transition=${summary.transitionCorrect}/${summary.transitionCases}`);
  }, 60_000);
});
