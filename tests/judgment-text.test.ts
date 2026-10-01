import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteStore, SqlQuery } from "@/lib/db/remote";

vi.mock("@/lib/db/remote", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/db/remote")>()), remoteStore: () => fake }));

const calls: SqlQuery[] = [];
const CHUNKS = [
  { chunk_index: "0", total_chunks: "3", page_start: "2", page_end: "2", section_type: "paragraph", text: "A".repeat(3000) },
  { chunk_index: "1", total_chunks: "3", page_start: "2", page_end: "3", section_type: "paragraph", text: "B".repeat(3000) },
  { chunk_index: "2", total_chunks: "3", page_start: "4", page_end: "4", section_type: "conclusion", text: "C".repeat(3000) },
];
const fake: RemoteStore = {
  async query(q) {
    calls.push(q);
    const sql = q.query;
    if (sql.includes("to_regclass")) return [{ ok: "t" }];
    if (sql.includes("FROM corpus_judgments WHERE upper(neutral_citation)")) return q.params?.[0] === "2024 INSC 735" ? [{ id: "sc:2024_10_108_125", title: "Vijay Singh v. State of Bihar" }] : [];
    if (sql.includes("FROM corpus_judgments WHERE id = $1")) return q.params?.[0] === "sc:2024_10_108_125" ? [{ id: "sc:2024_10_108_125", title: "Vijay Singh v. State of Bihar", neutral_citation: "2024 INSC 735", court_id: "sci", cnr: null, decision_date: "2024-09-25" }] : q.params?.[0] === "hc:x" ? [{ id: "hc:x", title: "HC", neutral_citation: "2024:KHC:1", court_id: "hc-karnataka", cnr: "KAHC010219082014", decision_date: "2014-09-09" }] : [];
    if (sql.includes("min(chunk_index)")) return [{ i: q.params?.[1] === 4 ? "2" : null }];
    if (sql.includes("FROM corpus_texts") && sql.includes("chunk_index >=")) return q.params?.[0] !== "2024 INSC 735" ? [] : CHUNKS.filter((c) => Number(c.chunk_index) >= Number(q.params?.[1]));
    if (sql.includes("websearch_to_tsquery")) return [
      { neutral_citation: "2024 INSC 735", chunk_index: "1", page_start: "2", page_end: "3", rank: "0.5", passage: "anticipatory  bail passage", id: "sc:2024_10_108_125", title: "Vijay Singh v. State of Bihar", decision_date: "2024-09-25", reporter_citation: "[2024] 10 S.C.R. 108", judges: "{\"Bela M. Trivedi\",\"Satish Chandra Sharma\"}", pdf_url: null },
      { neutral_citation: "2023 INSC 1", chunk_index: "0", page_start: "1", page_end: "1", rank: "0.4", passage: "dup", id: "sc:dup", title: "Dup", decision_date: null, reporter_citation: null, judges: null, pdf_url: null },
    ];
    return [];
  },
  async transaction() { return []; },
};

import { canonicalNeutral, chunksToText, readJudgmentText, resetTextTableCacheForTests, searchJudgmentText } from "@/modules/india/corpus/text";
import { corpusTextHits } from "@/modules/search/engine/deps";
import type { SearchHit } from "@/modules/search/types";

beforeEach(() => { calls.length = 0; resetTextTableCacheForTests(); });

describe("Supreme Court judgment text", () => {
  it("canonicalises neutral citations and rejects anything else", () => {
    expect(canonicalNeutral("2024  insc 0735")).toBe("2024 INSC 735");
    expect(canonicalNeutral("2024:KHC:1")).toBeNull();
  });

  it("reads by citation or id, stops at the character budget and reports the next chunk", async () => {
    const r = await readJudgmentText("2024 INSC 735", { maxChars: 4000 });
    expect(r?.judgmentId).toBe("sc:2024_10_108_125");
    expect(r?.chunks.map((c) => c.index)).toEqual([0]);
    expect(r?.nextChunk).toBe(1);
    const byId = await readJudgmentText("sc:2024_10_108_125", { fromChunk: 1, maxChars: 10_000 });
    expect(byId?.chunks.map((c) => c.index)).toEqual([1, 2]);
    expect(byId?.nextChunk).toBeNull();
    expect(chunksToText(byId!.chunks)).toMatch(/^\[p\. 2\]\n\nB+\n\n\[p\. 4\]\n\nC+$/);
  });

  it("starts at a page, and never substitutes a judgment for an unknown or non-SC citation", async () => {
    expect((await readJudgmentText("2024 INSC 735", { page: 4 }))?.chunks[0].index).toBe(2);
    expect(await readJudgmentText("2099 INSC 1")).toBeNull();
    expect(await readJudgmentText("hc:x")).toBeNull();
    expect(await readJudgmentText("sc:missing")).toBeNull();
  });

  it("search requires a query and maps passages with pages", async () => {
    expect((await searchJudgmentText("  ")).hits).toEqual([]);
    const { available, hits } = await searchJudgmentText("anticipatory bail", { yearFrom: 2015, limit: 5 });
    expect(available).toBe(true);
    expect(hits[0]).toMatchObject({ neutralCitation: "2024 INSC 735", pageStart: 2, passage: "anticipatory bail passage", judges: ["Bela M. Trivedi", "Satish Chandra Sharma"] });
    const sql = calls.find((c) => c.query.includes("websearch_to_tsquery"))!;
    expect(sql.query).toMatch(/LIMIT 5$/);
    expect(sql.params).toEqual(["anticipatory bail", 2015]);
  });

  it("research hits are readable, skip judgments already returned and stay out of non-SC scopes", async () => {
    const existing = [{ id: "x", source: "caselaw", title: "Dup", cite: "2023 INSC 1", citations: ["2023 INSC 1"] } as SearchHit];
    const nctx = { jurisdiction: "sci" as never, courts: [] as never };
    const hits = await corpusTextHits("anticipatory bail", { courts: ["sci"], limit: 8, existing, nctx });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ id: "corpus:sc:2024_10_108_125", cite: "2024 INSC 735", url: "/cases/sc%3A2024_10_108_125#p2", readRef: { kind: "url", url: "corpus-text://sc:2024_10_108_125" } });
    expect(await corpusTextHits("anticipatory bail", { courts: ["hc-karnataka"], limit: 8, existing: [], nctx })).toEqual([]);
  });
});
