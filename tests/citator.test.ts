import { beforeEach, describe, expect, it } from "vitest";
import type { RemoteStore, Row, SqlQuery } from "@/lib/db/remote";
import { CORPUS_SCHEMA_VERSION } from "@/modules/india/corpus/schema";
import { resetCorpusSchemaCacheForTests } from "@/modules/india/corpus/backfill";
import { resetTextTableCacheForTests } from "@/modules/india/corpus/text";
import { buildCitationsBatch, runCitatorBuild } from "@/modules/india/citator/build";
import { CITATOR_SCHEMA, resetCitatorSchemaCacheForTests } from "@/modules/india/citator/schema";
import { citatorFor, goodLawSummary, parseSectionFilters, resetCitatorReadCachesForTests, sectionStats, sortCitedBy } from "@/modules/india/citator/read";
import type { CitedByEntry } from "@/modules/india/citator/types";
import { citatorCheckTool } from "@/lib/ai/toolkit/india-citator";
import { INDIA_TOOLS } from "@/lib/ai/toolkit/india";

const COLS = ["citing_id", "seq", "kind", "raw", "key", "cited_id", "resolution", "candidates", "act_id", "section", "chunk_index", "page", "context", "signal", "cue", "occurrences", "citing_court", "citing_year", "extractor_version"];

interface J { id: string; court_id: string; year: string; neutral_citation: string | null; reporter_citation: string | null; cnr: string | null; decision_date: string; text_status: string; title: string; bench_strength?: string | null }
const compact = (s: string) => s.replace(/[^A-Za-z0-9]/g, "").toUpperCase();

/** In-memory corpus: answers the statements the citator issues (schema, state, judgments, texts, resolution, writes). */
class CorpusFake implements RemoteStore {
  calls: SqlQuery[] = [];
  transactions: SqlQuery[][] = [];
  state = new Map<string, string>([["schema_version", String(CORPUS_SCHEMA_VERSION)]]);
  citations: Record<string, unknown>[] = [];
  scans = new Map<string, Record<string, unknown>>();
  constructor(public judgments: J[], public texts: Record<string, string[]>) {}
  async query(q: SqlQuery): Promise<Row[]> {
    this.calls.push(q);
    const s = q.query;
    const p = q.params ?? [];
    if (s.includes("to_regclass('public.corpus_state')")) return [{ t: "corpus_state" }];
    if (s.includes("FROM corpus_state WHERE key = 'schema_version'")) return [{ value: this.state.get("schema_version")! }];
    if (s.startsWith("SELECT value FROM corpus_state WHERE key = $1")) { const v = this.state.get(String(p[0])); return v ? [{ value: v }] : []; }
    if (s.startsWith("INSERT INTO corpus_state")) { this.state.set(String(p[0]), String(p[1])); return []; }
    if (/^\s*CREATE|^\s*ALTER|^\s*UPDATE corpus_judgments SET year/.test(s)) return [];
    if (s.includes("to_regclass('public.corpus_texts')")) return [{ ok: "t", hc: "t" }];
    if (s.includes("WHERE text_status = 'full'")) {
      const limit = Number(/LIMIT (\d+)/.exec(s)![1]);
      return this.judgments.filter((j) => j.text_status === "full" && (!p.length || j.id > String(p[0]))).sort((a, b) => a.id.localeCompare(b.id)).slice(0, limit) as unknown as Row[];
    }
    if (s.includes("FROM corpus_texts WHERE neutral_citation = $1")) {
      return (this.texts[String(p[0])] ?? []).map((text, i) => ({ chunk_index: String(i), page_start: String(i + 1), text }));
    }
    if (s.includes("regexp_replace")) {
      const keys = new Set(String(p[0]).replace(/[{}"]/g, "").split(","));
      return this.judgments.filter((j) => (j.neutral_citation && keys.has(compact(j.neutral_citation))) || (j.reporter_citation && keys.has(compact(j.reporter_citation))))
        .map((j) => ({ id: j.id, neutral_citation: j.neutral_citation, reporter_citation: j.reporter_citation }));
    }
    if (s.startsWith("DELETE FROM corpus_citations")) { this.citations = this.citations.filter((c) => c.citing_id !== p[0]); return []; }
    if (s.startsWith("INSERT INTO corpus_citations")) {
      for (let i = 0; i < p.length; i += COLS.length) this.citations.push(Object.fromEntries(COLS.map((c, k) => [c, p[i + k]])));
      return [];
    }
    if (s.startsWith("INSERT INTO corpus_citator_scans")) { this.scans.set(String(p[0]), { citations: p[2], text_chars: p[3] }); return []; }
    return [];
  }
  async transaction(qs: SqlQuery[]): Promise<Row[][]> {
    this.transactions.push(qs);
    const out: Row[][] = [];
    for (const q of qs) out.push(await this.query(q));
    return out;
  }
}

const J1: J = { id: "sc:a1", court_id: "sci", year: "2024", neutral_citation: "2024 INSC 1", reporter_citation: "[2024] 1 S.C.R. 5", cnr: null, decision_date: "2024-01-10", text_status: "full", title: "Ram v. State" };
const J2: J = { id: "sc:a2", court_id: "sci", year: "2010", neutral_citation: null, reporter_citation: "(2010) 1 S.C.C. 1", cnr: null, decision_date: "2010-01-05", text_status: "none", title: "Shyam v. Union" };
const J3: J = { id: "sc:a3", court_id: "sci", year: "1973", neutral_citation: null, reporter_citation: "AIR 1973 SC 1461", cnr: null, decision_date: "1973-04-24", text_status: "none", title: "First record" };
const J4: J = { id: "sc:a4", court_id: "sci", year: "1973", neutral_citation: null, reporter_citation: "A.I.R. 1973 SC 1461", cnr: null, decision_date: "1973-04-24", text_status: "none", title: "Second record" };
const J5: J = { id: "sc:a5", court_id: "sci", year: "2025", neutral_citation: "2025 INSC 9", reporter_citation: null, cnr: null, decision_date: "2025-03-01", text_status: "full", title: "Later v. Case" };
const J6: J = { id: "sc:a6", court_id: "sci", year: "2025", neutral_citation: "2025 INSC 10", reporter_citation: null, cnr: null, decision_date: "2025-04-01", text_status: "full", title: "Ram v. State of Kerala" };

const TEXTS: Record<string, string[]> = {
  "2024 INSC 1": [
    "2024 INSC 1\nREPORTABLE\n\nThe appellant was convicted under Section 302 of the Indian Penal Code. Reliance was placed on (2010) 1 SCC 1. See also AIR 1973 SC 1461.",
    "The decision in (1999) 9 SCC 9 is not available. This judgment is reported as [2024] 1 SCR 5.",
  ],
  "2025 INSC 9": ["In our view the decision in Ram v. State, 2024 INSC 1, was overruled by the Constitution Bench. Article 21 of the Constitution applies."],
  // Mentions a party name similar to J1 but no citation: never bound by name.
  "2025 INSC 10": ["The facts in Ram v. State are different. Nothing more."],
};

function fake() { return new CorpusFake([J1, J2, J3, J4, J5, J6].map((j) => ({ ...j })), TEXTS); }

beforeEach(() => { resetCorpusSchemaCacheForTests(); resetCitatorSchemaCacheForTests(); resetCitatorReadCachesForTests(); resetTextTableCacheForTests(); });

describe("buildCitationsBatch", () => {
  it("resolves only by exact citation (one: resolved, several: ambiguous, none: unresolved), never to itself or by name", async () => {
    const store = fake();
    const r = await buildCitationsBatch({ store, limit: 10 });
    expect(r).toMatchObject({ processed: 3, citations: 4, resolved: 2, unresolved: 1, ambiguous: 1, done: true, nextCursor: "sc:a6", stop: "pass_complete" });
    const of = (citing: string) => store.citations.filter((c) => c.citing_id === citing && c.kind === "case");
    const j1 = of("sc:a1");
    expect(j1.find((c) => c.key === "(2010) 1 SCC 1")).toMatchObject({ cited_id: "sc:a2", resolution: "resolved", candidates: 1, signal: "followed", page: 1 });
    expect(j1.find((c) => c.key === "AIR 1973 SC 1461")).toMatchObject({ cited_id: null, resolution: "ambiguous", candidates: 2 });
    expect(j1.find((c) => c.key === "(1999) 9 SCC 9")).toMatchObject({ cited_id: null, resolution: "unresolved", candidates: 0 });
    // Its own neutral and reporter citations are not citations.
    expect(j1.some((c) => c.cited_id === "sc:a1" || String(c.key).includes("INSC") || String(c.key).includes("SCR"))).toBe(false);
    const j5 = of("sc:a5");
    expect(j5).toHaveLength(1);
    expect(j5[0]).toMatchObject({ cited_id: "sc:a1", resolution: "resolved", signal: "overruled", citing_court: "sci", citing_year: 2025 });
    expect(String(j5[0].context).toLowerCase()).toContain(String(j5[0].cue).toLowerCase());
    expect(of("sc:a6")).toHaveLength(0);
    expect(store.scans.get("sc:a6")).toMatchObject({ citations: 0 });
    // Statutes are stored per section with the Act.
    expect(store.citations.filter((c) => c.kind === "statute").map((c) => [c.citing_id, c.key, c.act_id, c.section])).toEqual([["sc:a1", "IPC 1860 s.302", "ipc", "302"], ["sc:a5", "Constitution art.21", "constitution", "21"]]);
    // The resolution query carries values only as a bound array parameter.
    const rq = store.calls.find((c) => c.query.includes("regexp_replace") && c.query.startsWith("SELECT id, neutral_citation"))!;
    expect(rq.query).not.toMatch(/SCC|AIR|INSC/);
    expect(rq.params).toHaveLength(1);
  });

  it("is idempotent: rerunning replaces a judgment's rows in one transaction (delete first)", async () => {
    const store = fake();
    await buildCitationsBatch({ store, limit: 10 });
    const before = store.citations.length;
    await buildCitationsBatch({ store, limit: 10 });
    expect(store.citations.length).toBe(before);
    for (const t of store.transactions) {
      expect(t[0].query).toBe("DELETE FROM corpus_citations WHERE citing_id = $1");
      expect(t[t.length - 1].query).toMatch(/^INSERT INTO corpus_citator_scans/);
    }
  });

  it("pages by id after the cursor and stops at the deadline between judgments", async () => {
    const store = fake();
    const first = await buildCitationsBatch({ store, limit: 1 });
    expect(first).toMatchObject({ processed: 1, nextCursor: "sc:a1", done: false, stop: "batch_complete" });
    const next = await buildCitationsBatch({ store, limit: 1, afterId: first.nextCursor });
    expect(next.nextCursor).toBe("sc:a5");
    let t = 0;
    const late = await buildCitationsBatch({ store: fake(), limit: 10, deadlineMs: 1000, now: () => (t += 600) });
    expect(late.stop).toBe("deadline");
    expect(late.processed).toBeLessThan(3);
  });

  it("creates its schema idempotently", () => {
    for (const q of CITATOR_SCHEMA) expect(q.query).toMatch(/IF NOT EXISTS/);
    expect(CITATOR_SCHEMA.map((q) => q.query).join("\n")).toMatch(/PRIMARY KEY \(citing_id, seq\)/);
  });
});

describe("runCitatorBuild", () => {
  it("resumes from the stored cursor, reports a finished pass, and restarts on request", async () => {
    const store = fake();
    const a = await runCitatorBuild({ store, limit: 2, deadlineMs: 60_000 });
    expect(a).toMatchObject({ processed: 3, done: true, batches: 2 });
    expect(JSON.parse(store.state.get("citator_cursor")!)).toMatchObject({ afterId: "sc:a6", done: true, scannedThisPass: 3 });
    const b = await runCitatorBuild({ store, limit: 2, deadlineMs: 60_000 });
    expect(b).toMatchObject({ processed: 0, done: true, stop: "pass_complete" });
    const c = await runCitatorBuild({ store, limit: 5, deadlineMs: 60_000, restart: true });
    expect(c.processed).toBe(3);
  });

  it("fails closed without a store", async () => {
    await expect(runCitatorBuild({ store: null })).rejects.toThrow(/not configured/);
  });
});

// ---------------------------------------------------------------------------
// Read side
// ---------------------------------------------------------------------------

const target = { id: "sc:t", title: "Target", court_id: "sci", bench_strength: "3", neutral_citation: "2015 INSC 5", reporter_citation: "(2015) 3 SCC 200", cnr: null, decision_date: "2015-02-02" };

class ReadFake implements RemoteStore {
  calls: SqlQuery[] = [];
  constructor(private o: { tables?: boolean; cites?: Row[]; citedBy?: Row[]; scanned?: boolean; mentions?: Row[]; sections?: Row[]; years?: Row[] }) {}
  async query(q: SqlQuery): Promise<Row[]> {
    this.calls.push(q);
    const s = q.query;
    if (s.includes("FROM corpus_judgments WHERE id = $1")) return q.params?.[0] === "sc:t" ? [target] : [];
    if (s.includes("to_regclass('public.corpus_citations')")) return [{ ok: this.o.tables === false ? "f" : "t" }];
    if (s.includes("WHERE c.citing_id = $1")) return this.o.cites ?? [];
    if (s.includes("WHERE c.cited_id = $1")) return this.o.citedBy ?? [];
    if (s.includes("FROM corpus_citator_scans WHERE citing_id")) return this.o.scanned ? [{ citing_id: "sc:t" }] : [];
    if (s.includes("count(*) AS n FROM corpus_citator_scans")) return [{ n: "1200" }];
    if (s.startsWith("SELECT value FROM corpus_state")) return [{ value: JSON.stringify({ done: false }) }];
    if (s.includes("to_regclass('public.corpus_texts')")) return [{ ok: "t", hc: "t" }];
    if (s.includes("phraseto_tsquery")) return this.o.mentions ?? [];
    if (s.includes("GROUP BY act_id, section, citing_year")) return this.o.years ?? [];
    if (s.includes("GROUP BY act_id, section")) return this.o.sections ?? [];
    return [];
  }
  async transaction(qs: SqlQuery[]) { return Promise.all(qs.map((q) => this.query(q))); }
}

const citing = (o: Partial<Row>): Row => ({ citing_id: "sc:x", raw: "(2015) 3 SCC 200", page: "4", context: "ctx", signal: null, cue: null, title: "X", court_id: "sci", bench_strength: "2", decision_date: "2020-01-01", neutral_citation: "2020 INSC 1", reporter_citation: null, cnr: null, ...o });

describe("citatorFor", () => {
  it("lists citing judgments by court rank then date, keeps the strongest cue per citing judgment, and flags Supreme Court negative cues", async () => {
    const store = new ReadFake({
      scanned: true,
      cites: [
        { seq: "1", kind: "case", raw: "(2010) 1 SCC 1", key: "(2010) 1 SCC 1", cited_id: "sc:a2", resolution: "resolved", candidates: "1", act_id: null, section: null, page: "3", context: "c", signal: null, cue: null, occurrences: "2", title: "Shyam", court_id: "sci", decision_date: "2010-01-05" },
        { seq: "2", kind: "case", raw: "(1999) 9 SCC 9", key: "(1999) 9 SCC 9", cited_id: null, resolution: "unresolved", candidates: "0", act_id: null, section: null, page: "4", context: "c2", signal: null, cue: null, occurrences: "1", title: null, court_id: null, decision_date: null },
        { seq: "3", kind: "statute", raw: "Section 302 IPC", key: "IPC 1860 s.302", cited_id: null, resolution: "resolved", candidates: "1", act_id: "ipc", section: "302", page: "1", context: null, signal: null, cue: null, occurrences: "3", title: null, court_id: null, decision_date: null },
      ],
      citedBy: [
        citing({ citing_id: "hc:k1", court_id: "hc-karnataka", decision_date: "2024-05-01", signal: "distinguished", cue: "distinguished", neutral_citation: "2024:KHC:1" }),
        citing({ citing_id: "sc:s1", decision_date: "2019-01-01", signal: "followed", cue: "relied upon" }),
        citing({ citing_id: "sc:s1", decision_date: "2019-01-01", raw: "2015 INSC 5", signal: "overruled", cue: "was overruled" }),
        citing({ citing_id: "sc:s2", decision_date: "2022-01-01" }),
      ],
    });
    const r = (await citatorFor("sc:t", store))!;
    expect(r.status).toBe("built");
    expect(r.citedBy.map((c) => c.citingId)).toEqual(["sc:s2", "sc:s1", "hc:k1"]);
    expect(r.citedBy.find((c) => c.citingId === "sc:s1")).toMatchObject({ signal: "overruled", cue: "was overruled", signalBasis: "text_cue", kind: "citation" });
    expect(r.negative.map((c) => c.citingId)).toEqual(["sc:s1"]);
    expect(r.goodLaw.status).toBe("negative_signal");
    expect(r.goodLaw.summary).toContain('"was overruled"');
    expect(r.goodLaw.coverage).toMatchObject({ scannedJudgments: 1200, passComplete: false });
    expect(r.counts).toMatchObject({ cites: 2, resolved: 1, unresolved: 1, ambiguous: 0, statutes: 1, citedBy: 3, negative: 1 });
    expect(r.cites[1]).toMatchObject({ resolution: "unresolved", citedId: null, title: null });
    expect(r.statutes[0]).toMatchObject({ actId: "ipc", section: "302", occurrences: 3 });
    expect(JSON.stringify(r)).not.toMatch(/\b(?:remains|is still|continues to be) good law/i);
    expect(r.goodLaw.summary).not.toMatch(/good law/i);
  });

  it("not built: falls back to text mentions labelled as mentions without signals", async () => {
    const store = new ReadFake({
      mentions: [{ neutral_citation: "2022 INSC 7", cnr: null, t_date: null, court_id: "sci", t_title: null, chunk_index: "2", page_start: "6", text: "As held in (2015) 3 SCC 200, the appeal fails and the decision was overruled.", id: "sc:m1", title: "Mentioner", decision_date: "2022-06-01" }],
    });
    const r = (await citatorFor("sc:t", store))!;
    expect(r.status).toBe("not_built");
    expect(r.citedBy).toHaveLength(1);
    expect(r.citedBy[0]).toMatchObject({ kind: "mention", citingId: "sc:m1", signal: null, cue: null, signalBasis: null, page: 6 });
    expect(r.negative).toEqual([]);
    expect(r.goodLaw.status).toBe("not_assessed");
  });

  it("not built when the citator tables do not exist yet (never creates them on read)", async () => {
    const store = new ReadFake({ tables: false });
    const r = (await citatorFor("sc:t", store))!;
    expect(r.status).toBe("not_built");
    expect(store.calls.some((c) => /CREATE/.test(c.query))).toBe(false);
  });

  it("returns null for an unknown id and refuses without a store", async () => {
    expect(await citatorFor("sc:missing", new ReadFake({}))).toBeNull();
    await expect(citatorFor("sc:t", null)).rejects.toThrow(/not configured/);
  });
});

describe("goodLawSummary", () => {
  const neg = (o: Partial<CitedByEntry>): CitedByEntry => ({ kind: "citation", citingId: "x", title: null, citation: null, courtId: "hc-karnataka", court: "High Court of Karnataka", benchStrength: 1, decisionDate: "2024-01-01", page: 1, context: "c", signal: "doubted", cue: "doubted", signalBasis: "text_cue", raw: null, ...o });
  it("grades negative cues by court and bench strength and always carries coverage", () => {
    const base = { built: true, scanned: 10, passComplete: true };
    expect(goodLawSummary({ ...base, negative: [neg({})], targetBench: 2 }).status).toBe("caution");
    expect(goodLawSummary({ ...base, negative: [neg({ benchStrength: 2 })], targetBench: 2 }).status).toBe("negative_signal");
    expect(goodLawSummary({ ...base, negative: [neg({ courtId: "sci", benchStrength: null })], targetBench: 5 }).status).toBe("negative_signal");
    expect(goodLawSummary({ ...base, negative: [neg({ benchStrength: 3 })], targetBench: null }).status).toBe("caution");
    const none = goodLawSummary({ ...base, negative: [], targetBench: 2 });
    expect(none.status).toBe("no_negative_signal_found");
    expect(none.summary).toMatch(/not confirmation/);
    expect(none.coverage.note).toMatch(/only the courts and years loaded/);
    expect(none.coverage.note).toMatch(/does not establish that a judgment is good law/);
  });
  it("sorts the Supreme Court first, then High Courts, then by date", () => {
    const list = [neg({ citingId: "a", courtId: "hc-delhi", decisionDate: "2025-01-01" }), neg({ citingId: "b", courtId: "sci", decisionDate: "2001-01-01" }), neg({ citingId: "c", courtId: null, decisionDate: "2026-01-01" }), neg({ citingId: "d", courtId: "hc-karnataka", decisionDate: "2025-06-01" })];
    expect(list.sort(sortCitedBy).map((x) => x.citingId)).toEqual(["b", "d", "a", "c"]);
  });
});

describe("sectionStats", () => {
  it("validates filters and never widens an unknown one", () => {
    expect(() => parseSectionFilters({ act: "nonsense" })).toThrow(RangeError);
    expect(() => parseSectionFilters({ court: "hc-nowhere" })).toThrow(RangeError);
    expect(() => parseSectionFilters({ from: 1200 })).toThrow(RangeError);
    expect(() => parseSectionFilters({ from: Number.NaN })).toThrow(RangeError);
    expect(parseSectionFilters({ from: 2024, to: 2010, limit: 999 })).toMatchObject({ from: 2010, to: 2024, limit: 50 });
    expect(parseSectionFilters({ limit: Number.NaN }).limit).toBe(20);
  });

  it("aggregates by citing-judgment count with bound parameters and a per-year breakdown", async () => {
    const store = new ReadFake({
      sections: [{ act_id: "ipc", section: "302", n: "40" }, { act_id: "constitution", section: "21", n: "12" }],
      years: [{ act_id: "ipc", section: "302", year: "2023", n: "15" }, { act_id: "ipc", section: "302", year: "2024", n: "25" }, { act_id: "constitution", section: "21", year: "2024", n: "12" }],
    });
    const r = await sectionStats({ act: "ipc", court: "sci", from: 2020, to: 2024, limit: 5 }, store);
    expect(r.sections.map((s) => [s.label, s.judgments])).toEqual([["IPC s.302", 40], ["Constitution art.21", 12]]);
    expect(r.sections[0].byYear).toEqual([{ year: 2023, judgments: 15 }, { year: 2024, judgments: 25 }]);
    const top = store.calls.find((c) => c.query.includes("GROUP BY act_id, section ORDER BY"))!;
    expect(top.params).toEqual(["ipc", "sci", 2020, 2024]);
    expect(top.query).toMatch(/LIMIT 5$/);
    expect(top.query).not.toMatch(/'ipc'|'sci'|2020/);
    expect(r.scannedJudgments).toBe(1200);
  });
});

describe("citator_check tool", () => {
  it("is registered with a strict schema and honest labels", async () => {
    expect(INDIA_TOOLS.map((t) => t.name)).toContain("citator_check");
    expect(citatorCheckTool.parameters.required).toEqual(["id"]);
    expect(citatorCheckTool.description).toMatch(/NOT a verified treatment/);
    expect(citatorCheckTool.description).toMatch(/no result establishes good law/);
  });
});
