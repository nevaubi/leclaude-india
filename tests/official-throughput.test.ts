import { afterEach, describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { ProviderError } from "@/modules/intel/providers/base";
import type { DiscoverResult, SourceAdapter } from "@/modules/official/adapter";
import { fallbackWorthy, isLocalRateLimit, type OfficialHttp } from "@/modules/official/http";
import { documentIdFor } from "@/modules/official/pipeline";
import { allowHostsFor, setOfficialAdaptersForTests } from "@/modules/official/registry";
import { runOfficialIngest, sourceInflight, DEFAULT_SOURCE_INFLIGHT } from "@/modules/official/run";
import { claimUnit } from "@/modules/official/units";
import type { DiscoveredDoc, SourceDef } from "@/modules/official/types";
import { OfficialFakeStore } from "./official-fakes";

const DEF: SourceDef = {
  id: "sci-orders", name: "Supreme Court orders (test)", publisher: "Supreme Court of India", kinds: ["judgment", "order"], forum: "sci",
  homepage: "https://www.sci.gov.in/", fetch: "direct", cadenceMinutes: 60, attribution: "Source: Supreme Court of India (sci.gov.in)", terms: "Government publication; verify against the official copy", enabled: true,
};

async function makePdf(text: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  text.split("\n").forEach((line, i) => page.drawText(line, { x: 50, y: 780 - i * 16, size: 11, font }));
  return doc.save();
}

const localLimit = (url: string) => new ProviderError("official:sci-orders", "rate_limited", "official:sci-orders: local rate limit reached", true, undefined, url);

function http(fetchFile: OfficialHttp["fetchFile"]): OfficialHttp {
  return {
    def: DEF,
    allowHosts: allowHostsFor(DEF),
    firecrawlAllowed: false,
    async fetchPage() { throw new Error("not used"); },
    fetchFile,
    async fetchJson() { throw new Error("not used"); },
    async postForm() { throw new Error("not used"); },
    async firecrawlPage() { return null; },
    async firecrawlDocument() { return null; },
  };
}

function adapter(items: DiscoveredDoc[]): SourceAdapter {
  return {
    def: DEF,
    async discover(): Promise<DiscoverResult> { return { items, nextCursor: null, done: true }; },
    parse(doc) { return { records: [{ id: doc.id }], unparsed: 0 }; },
    async persist() { return { stored: 1 }; },
  };
}

const prov = (url: string) => ({ via: "direct" as const, proxy: null, timezone: null, status: 200, finalUrl: url });
const tick = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 1)));
const TEXT = "IN THE SUPREME COURT OF INDIA\nCivil Appeal No. 77 of 2026\nThe appeal is allowed and the written statement is taken on record.";

afterEach(() => {
  setOfficialAdaptersForTests(null);
  delete process.env.OFFICIAL_SOURCE_INFLIGHT;
});

describe("local host rate limit", () => {
  it("is told apart from a publisher's 429 and never sends the request to another route", () => {
    expect(isLocalRateLimit(localLimit("https://www.sci.gov.in/x.pdf"))).toBe(true);
    const remote = new ProviderError("official:sci-orders", "rate_limited", "official:sci-orders: HTTP 429 (rate limited)", true, 429, "https://www.sci.gov.in/x.pdf");
    expect(isLocalRateLimit(remote)).toBe(false);
    expect(isLocalRateLimit(new Error("local rate limit reached"))).toBe(false);
    expect(fallbackWorthy(localLimit("https://www.sci.gov.in/x.pdf"))).toBe(false);
    expect(fallbackWorthy(remote)).toBe(true);
  });

  it("defers the unit briefly without using an attempt or failing the document, then completes it", async () => {
    const url = "https://www.sci.gov.in/orders/77.pdf";
    const pdf = await makePdf(TEXT);
    let refusals = 3;
    setOfficialAdaptersForTests({ "sci-orders": adapter([{ sourceId: "sci-orders", kind: "order", url, title: "Civil Appeal No. 77 of 2026", docDate: "2026-10-01" }]) });
    const store = new OfficialFakeStore();
    const h = http(async (u) => {
      if (refusals > 0) { refusals--; throw localLimit(u); }
      return { url: u, finalUrl: u, status: 200, mime: "application/pdf", bytes: pdf, provenance: prov(u) };
    });
    const id = documentIdFor("sci-orders", url);
    // Each refusal: the unit waits (run_after in the future), keeps 0 attempts, the document is not failed.
    for (let i = 0; i < 3; i++) {
      await runOfficialIngest({ store, deadlineMs: 120_000, concurrency: 1, sleep: tick, http: () => h, log: () => undefined });
      const unit = store.units.get(`fetch:${id}`)!;
      expect(unit).toMatchObject({ status: "pending", attempts: 0, error: null });
      expect(unit.run_after).toBeGreaterThan(store.clock);
      expect(unit.run_after! - store.clock).toBeLessThanOrEqual(40_000);
      expect(store.docs.get(id)?.status).toBe("discovered");
      expect(store.rejects.some((r) => r.url === url)).toBe(false);
      store.clock += 60_000;
    }
    const r = await runOfficialIngest({ store, deadlineMs: 120_000, concurrency: 1, sleep: tick, http: () => h, log: () => undefined });
    expect(r.total).toMatchObject({ fetched: 1, indexed: 1, failed: 0 });
    expect(store.docs.get(id)?.status).toBe("indexed");
  });
});

describe("network stages per source", () => {
  it("reads OFFICIAL_SOURCE_INFLIGHT (1–16)", () => {
    expect(sourceInflight({})).toBe(DEFAULT_SOURCE_INFLIGHT);
    expect(sourceInflight({ OFFICIAL_SOURCE_INFLIGHT: "5" })).toBe(5);
    expect(sourceInflight({ OFFICIAL_SOURCE_INFLIGHT: "99" })).toBe(16);
    expect(sourceInflight({ OFFICIAL_SOURCE_INFLIGHT: "0" })).toBe(DEFAULT_SOURCE_INFLIGHT);
    expect(sourceInflight({ OFFICIAL_SOURCE_INFLIGHT: "x" })).toBe(DEFAULT_SOURCE_INFLIGHT);
  });

  it("a held source's network stages are not claimed; its other stages and other sources are", async () => {
    const store = new OfficialFakeStore();
    store.units.set("fetch:a", { id: "fetch:a", source: "sansad", stage: "fetch", key: "a", document_id: "a", payload: null, priority: 10, status: "pending", attempts: 0, error: null, note: null, lease_until: null, run_after: null, finished_at: null } as never);
    store.units.set("index:b", { id: "index:b", source: "sansad", stage: "index", key: "b", document_id: "b", payload: null, priority: 20, status: "pending", attempts: 0, error: null, note: null, lease_until: null, run_after: null, finished_at: null } as never);
    store.units.set("fetch:c", { id: "fetch:c", source: "cbic", stage: "fetch", key: "c", document_id: "c", payload: null, priority: 30, status: "pending", attempts: 0, error: null, note: null, lease_until: null, run_after: null, finished_at: null } as never);
    const hold = { sources: ["sansad"], stages: ["discover", "fetch"] as ("discover" | "fetch")[] };
    const first = await claimUnit(store, { sources: ["sansad", "cbic"], stages: ["fetch", "index"], hold });
    expect(first?.id).toBe("index:b");
    const second = await claimUnit(store, { sources: ["sansad", "cbic"], stages: ["fetch", "index"], hold });
    expect(second?.id).toBe("fetch:c");
    expect(await claimUnit(store, { sources: ["sansad", "cbic"], stages: ["fetch", "index"], hold })).toBeNull();
    expect((await claimUnit(store, { sources: ["sansad", "cbic"], stages: ["fetch", "index"] }))?.id).toBe("fetch:a");
  });

  it("never runs more than OFFICIAL_SOURCE_INFLIGHT fetches of one source at once, and still fetches everything", async () => {
    process.env.OFFICIAL_SOURCE_INFLIGHT = "2";
    const pdf = await makePdf(TEXT);
    const items: DiscoveredDoc[] = Array.from({ length: 8 }, (_, i) => ({ sourceId: "sci-orders", kind: "order", url: `https://www.sci.gov.in/orders/${i}.pdf`, title: `Order ${i}`, docDate: "2026-10-01" }));
    setOfficialAdaptersForTests({ "sci-orders": adapter(items) });
    const store = new OfficialFakeStore();
    let inFlight = 0;
    let peak = 0;
    const h = http(async (u) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { url: u, finalUrl: u, status: 200, mime: "application/pdf", bytes: pdf, provenance: prov(u) };
    });
    const r = await runOfficialIngest({ store, deadlineMs: 120_000, concurrency: 6, sleep: (ms) => new Promise((res) => setTimeout(res, Math.min(ms, 2))), http: () => h, log: () => undefined });
    expect(r.total).toMatchObject({ fetched: 8, indexed: 8, failed: 0 });
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThanOrEqual(1);
  });
});

describe("run watchdog", () => {
  it("returns shortly after the deadline even when a unit ignores the abort, handing the unit back with its attempt", async () => {
    const url = "https://www.sci.gov.in/orders/hang.pdf";
    setOfficialAdaptersForTests({ "sci-orders": adapter([{ sourceId: "sci-orders", kind: "order", url, title: "Hanging order", docDate: "2026-10-01" }]) });
    const store = new OfficialFakeStore();
    const h = http(() => new Promise(() => undefined)); // never settles, ignores the signal (stands in for CPU-bound work)
    const t0 = Date.now();
    const r = await runOfficialIngest({ store, deadlineMs: 400, minUnitMs: 0, watchdogGraceMs: 100, concurrency: 1, sleep: tick, http: () => h, log: () => undefined });
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(r.stop).toBe("deadline");
    expect(r.notes.join(" ")).toMatch(/handed back \(fetch\)/);
    const unit = store.units.get(`fetch:${documentIdFor("sci-orders", url)}`)!;
    expect(unit).toMatchObject({ status: "pending", attempts: 0 });
  });
});
