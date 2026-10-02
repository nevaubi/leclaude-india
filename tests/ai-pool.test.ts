/**
 * Bounded fan-out (src/lib/ai/pool.ts): mapPool is stop-on-failure — after the first failure no further item starts,
 * items in flight are aborted through the signal they were given, and the promise rejects with that first error only
 * once every started item has settled (nothing keeps running or writing afterwards). mapPoolSettled reports failures
 * per item and keeps going.
 */
import { describe, expect, it } from "vitest";
import { mapPool, mapPoolSettled } from "@/lib/ai/pool";

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

describe("mapPool", () => {
  it("keeps input order and bounds concurrency", async () => {
    let inFlight = 0, peak = 0;
    const out = await mapPool([5, 1, 4, 2, 3], 2, async (n) => { inFlight++; peak = Math.max(peak, inFlight); await tick(n); inFlight--; return n * 10; });
    expect(out).toEqual([50, 10, 40, 20, 30]);
    expect(peak).toBe(2);
  });

  it("stops after the first failure: no new item starts, in-flight items are aborted, the first error is thrown after they settle", async () => {
    const started: number[] = [];
    const aborted: number[] = [];
    const finished: number[] = [];
    let settledAfterReject = false;
    const p = mapPool(Array.from({ length: 10 }, (_, i) => i), 3, async (i, _index, signal) => {
      started.push(i);
      if (i === 0) { await tick(2); throw new Error("batch 0 failed"); }
      // Items 1 and 2 are in flight when item 0 fails: they see the abort and stop.
      await new Promise<void>((resolve) => { const t = setTimeout(resolve, 200); signal.addEventListener("abort", () => { clearTimeout(t); aborted.push(i); resolve(); }, { once: true }); });
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      finished.push(i);
      return i;
    });
    await expect(p).rejects.toThrow("batch 0 failed");
    settledAfterReject = started.every((i) => i === 0 || aborted.includes(i) || finished.includes(i));
    expect(started.sort()).toEqual([0, 1, 2]); // 10 items, limit 3, item 0 throws → only the first wave ever started
    expect(aborted.sort()).toEqual([1, 2]);
    expect(finished).toEqual([]);
    expect(settledAfterReject).toBe(true);
  });

  it("a caller abort stops new work and rejects with an AbortError", async () => {
    const ctrl = new AbortController();
    const started: number[] = [];
    const p = mapPool([1, 2, 3, 4, 5, 6], 2, async (i, _index, signal) => {
      started.push(i);
      if (i === 2) ctrl.abort();
      await tick(2);
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      return i;
    }, ctrl.signal);
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(started.length).toBeLessThanOrEqual(3);
  });
});

describe("mapPoolSettled", () => {
  it("reports each failure and runs every item", async () => {
    const r = await mapPoolSettled([1, 2, 3, 4], 2, async (i) => { if (i % 2 === 0) throw new Error(`no ${i}`); return i; });
    expect(r.map((x) => x.ok)).toEqual([true, false, true, false]);
    expect((r[1] as { error: Error }).error.message).toBe("no 2");
  });
});
