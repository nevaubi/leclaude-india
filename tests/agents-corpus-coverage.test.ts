/**
 * Indian law corpus coverage for prompts: summary shape from a fake Postgres, stable ordering and text, 10-minute
 * caching with a stale fallback, the not-configured fallback, and the token budget of the prompt block.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { RemoteStore, SqlQuery } from "@/lib/db/remote";
import { approx, corpusCoverage, coverageBlock, coveragePromptBlock, COVERAGE_TTL_MS, resetCoverageCacheForTests } from "@/modules/india/corpus/coverage";

function fakeStore(opts: { fail?: boolean; noLaw?: boolean } = {}) {
  const calls: SqlQuery[] = [];
  const store: RemoteStore = {
    async query(q) {
      calls.push(q);
      if (opts.fail) throw new Error("connection refused");
      const sql = q.query;
      if (sql.includes("to_regclass")) return [{ j: "t", t: "t", l: opts.noLaw ? "f" : "t", tc: "t" }];
      if (sql.includes("FROM corpus_judgments GROUP BY court_id")) return [
        { court_id: "hc-telangana", n: "8123", y0: "2025", y1: "2026" },
        { court_id: "sci", n: "52345", y0: "1950", y1: "2026" },
        { court_id: "hc-karnataka", n: "61002", y0: "2025", y1: "2026" },
        { court_id: null, n: "40", y0: "2025", y1: "2025" },
      ];
      if (sql.includes("FROM corpus_texts WHERE chunk_index = 0")) return [
        { court_id: "hc-karnataka", n: "121400", y0: "2008", y1: "2026" },
        { court_id: "sci", n: "35612", y0: "1950", y1: "2026" },
      ];
      if (sql.includes("FROM law_instruments GROUP BY")) return [
        { jurisdiction: "central", kind: "act", n: "1500", p: "60000", states: "0", regulators: "0" },
        { jurisdiction: "state", kind: "act", n: "9100", p: "600000", states: "34", regulators: "0" },
        { jurisdiction: "regulator", kind: "regulation", n: "11000", p: "420000", states: "0", regulators: "12" },
        { jurisdiction: "regulator", kind: "report", n: "280", p: "0", states: "0", regulators: "1" },
      ];
      return [];
    },
    async transaction() { return []; },
  };
  return { store, calls };
}

beforeEach(() => resetCoverageCacheForTests());

describe("corpus coverage summary", () => {
  it("summarises judgments (metadata vs full text) per court with year ranges and the statutes corpus by jurisdiction", async () => {
    const { store } = fakeStore();
    const c = await corpusCoverage({ store });
    expect(c.configured).toBe(true);
    expect(c.stale).toBe(false);
    expect(c.missing).toEqual([]);
    // Supreme Court first, then High Courts by id, unresolved courts last.
    expect(c.judgments.map((x) => x.courtId)).toEqual(["sci", "hc-karnataka", "hc-telangana", ""]);
    expect(c.judgments[0]).toMatchObject({ label: "Supreme Court of India", count: 52345, from: 1950, to: 2026 });
    expect(c.texts.map((x) => [x.courtId, x.count])).toEqual([["sci", 35612], ["hc-karnataka", 121400]]);
    expect(c.statutes).toEqual({ instruments: 21880, provisions: 1080000, central: 1500, state: 9100, states: 34, regulator: 11000, regulators: 12, reports: 280 });
  });

  it("renders a short, deterministic prompt block that names the tools for each kind of material", async () => {
    const { store } = fakeStore();
    const block = coverageBlock(await corpusCoverage({ store }));
    expect(block).toContain("Indian law corpus coverage");
    expect(block).toMatch(/Full text with page numbers \(search_judgment_text, then read_judgment_text; cite the page\): Supreme Court of India 35\.6k judgments \(1950–2026\); High Court of Karnataka 121k judgments \(2008–2026\)/);
    expect(block).toMatch(/Metadata only \(search_judgment_index[^)]*\): Supreme Court of India 52\.3k records/);
    expect(block).toContain("High Court for the State of Telangana 8.12k records (2025–2026)");
    expect(block).toMatch(/Statutes \(search_law \/ list_law_instruments, then read_law_section\): 21\.9k instruments, 1\.08M provisions/);
    expect(block).toContain("34 States/UTs");
    expect(block).toContain("Law Commission reports 280");
    // Well under ~600 tokens (≈ 4 characters per token).
    expect(block.length).toBeLessThan(2400);
    resetCoverageCacheForTests();
    expect(coverageBlock(await corpusCoverage({ store: fakeStore().store }))).toBe(block);
  });

  it("caches for 10 minutes, shares one refresh, and serves the stale summary when a refresh fails", async () => {
    const ok = fakeStore();
    const [a, b] = await Promise.all([corpusCoverage({ store: ok.store }), corpusCoverage({ store: ok.store })]);
    expect(a).toBe(b);
    const n = ok.calls.length;
    expect(n).toBe(4);
    await corpusCoverage({ store: ok.store });
    expect(ok.calls.length).toBe(n); // cached
    const bad = fakeStore({ fail: true });
    const later = await corpusCoverage({ store: bad.store, now: Date.now() + COVERAGE_TTL_MS + 1 });
    expect(bad.calls.length).toBeGreaterThan(0);
    expect(later.stale).toBe(true);
    expect(later.texts).toEqual(a.texts);
    expect(coverageBlock(later)).toContain("from an earlier check");
  });

  it("reports what is missing instead of inventing numbers, and says so when no database is configured", async () => {
    const c = await corpusCoverage({ store: fakeStore({ noLaw: true }).store });
    expect(c.statutes).toBeNull();
    expect(c.missing).toEqual(["statutes"]);
    expect(coverageBlock(c)).toContain("Statutes corpus: not loaded");
    resetCoverageCacheForTests();
    const fresh = await corpusCoverage({ store: fakeStore({ fail: true }).store });
    expect(fresh).toMatchObject({ configured: true, judgments: [], texts: [], statutes: null });
    const none = await corpusCoverage({ store: null });
    expect(none.configured).toBe(false);
    expect(coverageBlock(none)).toMatch(/not configured on this deployment/);
    expect(coverageBlock(none, { includeUnconfigured: false })).toBe("");
    expect(await coveragePromptBlock({ store: null })).toMatch(/not configured/);
  });

  it("rounds counts to three significant figures so the prompt text stays stable while backfills run", () => {
    expect([approx(999), approx(35612), approx(35649), approx(121400), approx(1080000)]).toEqual(["999", "35.6k", "35.6k", "121k", "1.08M"]);
  });
});
