import { afterEach, describe, expect, it } from "vitest";
import type { RemoteStore, SqlQuery } from "@/lib/db/remote";
import type { DiscoverResult, SourceAdapter } from "@/modules/official/adapter";
import { orderBindingKeys } from "@/modules/official/causelist/query";
import type { OfficialHttp } from "@/modules/official/http";
import { STUCK_PASSES_MAX } from "@/modules/official/pipeline";
import { allowHostsFor, setOfficialAdaptersForTests } from "@/modules/official/registry";
import { requeueCaptionReparse, runOfficialIngest } from "@/modules/official/run";
import type { SourceDef } from "@/modules/official/types";
import { OfficialFakeStore } from "./official-fakes";

afterEach(() => setOfficialAdaptersForTests(null));

describe("orders parsed before caption scoping", () => {
  const keys = ["SATA/12/2024", "SATA/99/2019", "CA/5/2020"];

  it("a SAT order mirrored by SEBI binds only its first (caption) number; other SEBI orders bind none; scoped orders bind their caption keys", () => {
    expect(orderBindingKeys({ sourceId: "sebi-orders", meta: { forum: "sat", caseKeys: keys } })).toEqual(["SATA/12/2024"]);
    expect(orderBindingKeys({ sourceId: "sebi-orders", meta: { forum: "sebi", caseKeys: keys } })).toEqual([]);
    expect(orderBindingKeys({ sourceId: "sebi-orders", meta: { forum: "sat", caseKeys: keys, caseKeysScope: "caption" } })).toEqual(keys);
    expect(orderBindingKeys({ sourceId: "nclat", meta: { caseKeys: keys } })).toEqual(["SATA/12/2024"]);
    expect(orderBindingKeys({ sourceId: "sci-orders", meta: { caseKeys: keys } })).toEqual(keys);
  });

  it("re-queues their parse once (bounded, caption-scoped sources and orders only)", async () => {
    const calls: SqlQuery[] = [];
    const store = {
      async query(q: SqlQuery) {
        calls.push(q);
        if (q.query.startsWith("SELECT d.id, d.source, d.url FROM official_documents d")) return [{ id: "od_1", source: "sebi-orders", url: "https://www.sebi.gov.in/x.html" }];
        if (q.query.includes("INSERT INTO official_units")) return [{ n: "1" }];
        return [];
      },
    } as unknown as RemoteStore;
    expect(await requeueCaptionReparse(store, ["cbic", "sci-orders"], 200)).toBe(0);
    expect(calls).toHaveLength(0);
    expect(await requeueCaptionReparse(store, ["sebi-orders", "nclat", "cbic"], 200)).toBe(1);
    const select = calls[0];
    expect(select.params).toEqual(['{"sebi-orders","nclat"}']);
    expect(select.query).toContain("(d.meta->>'caseKeysScope') IS NULL");
    expect(select.query).toContain("d.kind IN ('order', 'judgment')");
    expect(select.query).toContain("u.payload->>'reparse' = 'caption-scope'"); // never selected again once queued
    expect(select.query).toContain("LIMIT 200");
    const insert = JSON.parse(String(calls[1].params?.[0])) as { id: string; stage: string; payload: { reparse: string } }[];
    expect(insert).toEqual([expect.objectContaining({ id: "parse:od_1", stage: "parse", payload: { reparse: "caption-scope" } })]);
  });
});

describe("a discovery cursor that does not advance", () => {
  const DEF: SourceDef = {
    id: "sci-orders", name: "test", publisher: "Supreme Court of India", kinds: ["order"], forum: "sci",
    homepage: "https://www.sci.gov.in/", fetch: "direct", cadenceMinutes: 60, attribution: "x", terms: "x", enabled: true,
  };
  const http: OfficialHttp = {
    def: DEF, allowHosts: allowHostsFor(DEF), firecrawlAllowed: false,
    async fetchPage() { throw new Error("not used"); }, async fetchFile() { throw new Error("not used"); },
    async fetchJson() { throw new Error("not used"); }, async postForm() { throw new Error("not used"); },
    async firecrawlPage() { return null; }, async firecrawlDocument() { return null; },
  };
  const CURSOR = JSON.stringify({ v: 1, mode: "backfill", page: 7, lastSeen: { orders: "https://www.sci.gov.in/o/1" } });

  it("is kept (markers intact) for the next pass, and cleared only after repeated passes", async () => {
    const adapter: SourceAdapter = {
      def: DEF,
      async discover(): Promise<DiscoverResult> { return { items: [], nextCursor: CURSOR, done: false }; },
      parse() { return { records: [], unparsed: 0 }; },
      async persist() { return { stored: 0 }; },
    };
    setOfficialAdaptersForTests({ "sci-orders": adapter });
    const store = new OfficialFakeStore();
    store.state.set("official_cursor:sci-orders", JSON.stringify(CURSOR));
    const tick = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 1)));
    for (let pass = 1; pass <= STUCK_PASSES_MAX; pass++) {
      await runOfficialIngest({ store, deadlineMs: 60_000, concurrency: 1, sleep: tick, forceDiscover: true, http: () => http, log: () => undefined });
      const kept = JSON.parse(store.state.get("official_cursor:sci-orders") ?? "null");
      if (pass < STUCK_PASSES_MAX) expect(kept).toBe(CURSOR);
      else expect(kept).toBeNull();
      store.clock += 2 * 3600_000;
    }
  });
});
