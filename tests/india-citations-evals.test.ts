import { describe, expect, it } from "vitest";
import { loadIndiaCases, runIndiaCase } from "../evals/india/harness";

describe("India adversarial evals (deterministic)", () => {
  const cases = loadIndiaCases();
  it("has the required cases", () => {
    expect(cases.map((c) => c.id).sort()).toEqual(["india-ipc-bns-date-boundary", "india-same-party-names-across-states", "india-sc-vs-hc-binding", "india-wrong-neutral-citation"]);
  });
  it.each(cases.map((c) => [c.id, c] as const))("%s", (_id, c) => {
    const r = runIndiaCase(c);
    const failed = r.checks.filter((x) => !x.ok);
    expect(failed).toEqual([]);
    expect(r.checks.length).toBeGreaterThan(0);
    expect(r.status).toBe("pass");
  });
});
