import { afterEach, describe, expect, it } from "vitest";
import type { AdapterContext, FetchedFile, FetchedPage } from "@/modules/official/adapter";
import type { DiscoveredDoc } from "@/modules/official/types";
import { SOURCE_IDS } from "@/modules/official/types";
import {
  FAIL_RUN, RETRY_ATTEMPTS, backfillCursor, caseNumbersFromTitle, isStopError, parseCursor, printedDate, safeUrl, walkStreams,
  type ListingStream, type SequenceStream, type StreamSpec,
} from "@/modules/official/adapters/regulators/common";
import { REGULATOR_ADAPTERS } from "@/modules/official/adapters/regulators";
import { adapterFor } from "@/modules/official/adapters";
import { adapter as sat } from "@/modules/official/adapters/regulators/sat";
import { adapter as mca, def as mcaDef, mcaApiUrl, mcaConfig, mcaRecordDoc } from "@/modules/official/adapters/regulators/mca";

/** Minimal AdapterContext over in-memory routes; unknown URLs answer 404. */
function makeCtx(o: { json?: (url: string) => unknown; cursor?: string | null; limit?: number; deadline?: number } = {}) {
  const calls: string[] = [];
  const nf = (url: string) => Object.assign(new Error(`HTTP 404 for ${url}`), { status: 404 });
  const ctx: AdapterContext = {
    limit: o.limit ?? 100,
    deadline: o.deadline ?? Date.now() + 60_000,
    cursor: o.cursor ?? null,
    today: "2026-10-02",
    async fetchPage(url): Promise<FetchedPage> { calls.push(url); throw nf(url); },
    async fetchFile(url): Promise<FetchedFile> { calls.push(url); throw nf(url); },
    async fetchJson<T>(url: string): Promise<T> {
      calls.push(url);
      const v = o.json?.(url);
      if (v === undefined) throw nf(url);
      return v as T;
    },
    async postForm(url) { calls.push(url); throw nf(url); },
    log() {},
  };
  return { ctx, calls };
}

const doc = (n: number, stream = "s"): DiscoveredDoc => ({ sourceId: "ibbi", kind: "order", url: `https://ibbi.gov.in/${stream}/${n}.pdf`, title: `Doc ${n}`, docDate: null });

/** A listing stream over fixed pages of item numbers (newest first). */
function listing(id: string, pages: number[][], extra: Partial<ListingStream> = {}): ListingStream & { fetched: number[] } {
  const fetched: number[] = [];
  return {
    kind: "listing", id, backfill: true, firstPage: 1, incrementalPages: 10, fetched,
    async fetch(page) {
      fetched.push(page);
      const rows = pages[page - 1] ?? [];
      return { items: rows.map((n) => doc(n, id)), last: page >= pages.length };
    },
    ...extra,
  };
}

function cfgFor(streams: StreamSpec[]) {
  const by = new Map(streams.map((s) => [s.id, s]));
  return { plan: async (_c: AdapterContext, _m: string, only: string[] | null) => streams.map((s) => s.id).filter((id) => !only || only.includes(id)), stream: (id: string) => by.get(id) ?? null };
}

describe("printed dates", () => {
  it("reads every date form the regulators print and refuses anything else", () => {
    expect(printedDate("25 Sep, 2026")).toBe("2026-09-25");
    expect(printedDate("Oct 01, 2026")).toBe("2026-10-01");
    expect(printedDate("02-Oct-2026")).toBe("2026-10-02");
    expect(printedDate("12.08.2026")).toBe("2026-08-12");
    expect(printedDate("13/12/2024")).toBe("2024-12-13");
    expect(printedDate("29-09-2026")).toBe("2026-09-29");
    expect(printedDate("September 28th, 2026")).toBe("2026-09-28");
    expect(printedDate("SEPTEMBER 24, 2026")).toBe("2026-09-24");
    expect(printedDate("the 24th September, 2026")).toBe("2026-09-24");
    expect(printedDate("01 Oct, 2026 +0530")).toBe("2026-10-01");
    expect(printedDate("2026-05-07T05:30:00+05:30")).toBe("2026-05-07");
    expect(printedDate("31-Feb-2026")).toBeNull();
    expect(printedDate("XX-2009")).toBeNull();
    expect(printedDate("Smarch 3, 2026")).toBeNull();
    expect(printedDate("")).toBeNull();
    expect(printedDate(null)).toBeNull();
  });
});

describe("case numbers in listing titles", () => {
  it("normalizes single numbers and strict lists, keeps everything else printed only", () => {
    expect(caseNumbersFromTitle("In the matter of X LLP [CP(IB) 188 of 2026]")).toEqual({ printed: ["CP(IB) 188 of 2026"], keys: ["CPIB/188/2026"] });
    expect(caseNumbersFromTitle("X [IA/1037(AHM) 2026 in IA (Plan)/9(AHM) 2026 in CP (IB)/271(AHM)2025]").keys).toEqual(["IA/1037/2026", "IA/1037/2026@AHM", "IAPLAN/9/2026", "IAPLAN/9/2026@AHM", "CPIB/271/2025", "CPIB/271/2025@AHM"]);
    expect(caseNumbersFromTitle("X [C.P. (IB)/507/MB/2021]").keys).toEqual(["CPIB/507/2021", "CPIB/507/2021@MB"]);
    expect(caseNumbersFromTitle("A vs. B [CA (AT) (Ins) No. 1699, 1700, 1701 & 1702 of 2025]").keys).toEqual(["CAATINS/1699/2025", "CAATINS/1700/2025", "CAATINS/1701/2025", "CAATINS/1702/2025"]);
    // Two years in one part and unknown prefixes are never turned into a key; NCLT numbers also get the bench-qualified key.
    const messy = caseNumbersFromTitle("A vs. B [IA No. 5562 of 2023 & 4475, 5530 of 2025 in CA (AT) (Ins) No. 1557 & 1684 of 2023 and 626-628 of 2025]");
    expect(messy.printed).toHaveLength(2);
    expect(messy.keys).toEqual([]);
    expect(caseNumbersFromTitle("X [?? (IB)86(AHM)2026]")).toEqual({ printed: ["?? (IB)86(AHM)2026"], keys: [] });
    expect(caseNumbersFromTitle("X [IA(IBC)(Plan)/32/MB/2026]").keys).toEqual(["IAIBCPLAN/32/2026", "IAIBCPLAN/32/2026@MB"]);
    expect(caseNumbersFromTitle("No brackets here")).toEqual({ printed: [], keys: [] });
  });
});

describe("safe URLs", () => {
  it("accepts only http(s) on the publisher's hosts", () => {
    expect(safeUrl("/uploads/a.pdf", "https://ibbi.gov.in/orders/nclt", ["ibbi.gov.in"])).toBe("https://ibbi.gov.in/uploads/a.pdf");
    expect(safeUrl("https://evil.example/a.pdf", "https://ibbi.gov.in/", ["ibbi.gov.in"])).toBeNull();
    expect(safeUrl("javascript:void(0)", "https://ibbi.gov.in/", ["ibbi.gov.in"])).toBeNull();
    expect(safeUrl("https://ibbi.gov.in.evil.example/x", "https://ibbi.gov.in/", ["ibbi.gov.in"])).toBeNull();
    expect(safeUrl("https://www.sebi.gov.in/x.pdf", "https://www.sebi.gov.in/", ["sebi.gov.in"])).toBe("https://www.sebi.gov.in/x.pdf");
  });
});

describe("cursor", () => {
  it("round-trips, rejects foreign shapes and builds backfill cursors", () => {
    expect(parseCursor(null)).toBeNull();
    expect(parseCursor("not json")).toBeNull();
    expect(parseCursor(JSON.stringify({ mode: "sideways" }))).toBeNull();
    const b = parseCursor(backfillCursor({ only: ["orders:nclat"] }))!;
    expect(b.mode).toBe("backfill");
    expect(b.only).toEqual(["orders:nclat"]);
    expect(b.page).toBeNull();
    const weird = parseCursor(JSON.stringify({ mode: "incremental", page: -5, lastSeen: { a: 3 }, plan: "x" }))!;
    expect(weird.page).toBeNull();
    expect(weird.lastSeen).toEqual({});
    expect(weird.plan).toEqual([]);
  });
});

describe("stream walker", () => {
  it("walks listings newest first, stops at the previous pass's marker and carries markers in a done cursor", async () => {
    const a = listing("a", [[10, 9, 8], [7, 6]]);
    const b = listing("b", [[3, 2, 1]]);
    const { ctx } = makeCtx();
    const r1 = await walkStreams(ctx, cfgFor([a, b]));
    expect(r1.done).toBe(true);
    expect(r1.items.map((d) => d.title)).toEqual(["Doc 10", "Doc 9", "Doc 8", "Doc 7", "Doc 6", "Doc 3", "Doc 2", "Doc 1"]);
    const c1 = parseCursor(r1.nextCursor)!;
    expect(c1.mode).toBe("incremental");
    expect(c1.lastSeen).toEqual({ a: "https://ibbi.gov.in/a/10.pdf", b: "https://ibbi.gov.in/b/3.pdf" });

    // New items on top: only they are returned; the marker stops the walk on page 1.
    const a2 = listing("a", [[12, 11, 10, 9], [8, 7, 6]]);
    const r2 = await walkStreams(makeCtx({ cursor: r1.nextCursor }).ctx, cfgFor([a2, b]));
    expect(r2.items.map((d) => d.title)).toEqual(["Doc 12", "Doc 11"]);
    expect(a2.fetched).toEqual([1]);
    expect(parseCursor(r2.nextCursor)!.lastSeen.a).toBe("https://ibbi.gov.in/a/12.pdf");
  });

  it("returns at most ctx.limit items and resumes inside a page", async () => {
    const a = listing("a", [[5, 4, 3, 2, 1]]);
    const r1 = await walkStreams(makeCtx({ limit: 2 }).ctx, cfgFor([a]));
    expect(r1.items.map((d) => d.title)).toEqual(["Doc 5", "Doc 4"]);
    expect(r1.done).toBe(false);
    const r2 = await walkStreams(makeCtx({ limit: 2, cursor: r1.nextCursor }).ctx, cfgFor([a]));
    expect(r2.items.map((d) => d.title)).toEqual(["Doc 3", "Doc 2"]);
    const r3 = await walkStreams(makeCtx({ limit: 2, cursor: r2.nextCursor }).ctx, cfgFor([a]));
    expect(r3.items.map((d) => d.title)).toEqual(["Doc 1"]);
    expect(r3.done).toBe(true);
    // The marker is the newest item of the pass, captured on the first call.
    expect(parseCursor(r3.nextCursor)!.lastSeen.a).toBe("https://ibbi.gov.in/a/5.pdf");
  });

  it("bounds an incremental pass that never meets its marker and says so", async () => {
    const a = listing("a", [[9], [8], [7], [6]], { incrementalPages: 2 });
    const cursor = JSON.stringify({ v: 1, mode: "incremental", plan: [], i: 0, page: null, skip: 0, misses: 0, walked: 0, lastSeen: { a: "https://ibbi.gov.in/a/1.pdf" }, newest: {}, only: null });
    const r = await walkStreams(makeCtx({ cursor }).ctx, cfgFor([a]));
    expect(r.items.map((d) => d.title)).toEqual(["Doc 9", "Doc 8"]);
    expect(r.done).toBe(true);
    expect(r.notes?.join(" ")).toMatch(/not met within 2 page/);
  });

  it("backfills only the requested streams to their oldest page, then switches to incremental", async () => {
    const a = listing("a", [[9, 8], [7, 6], [5]], { incrementalPages: 1 });
    const b = listing("b", [[3]]);
    const r = await walkStreams(makeCtx({ cursor: backfillCursor({ only: ["a"] }) }).ctx, cfgFor([a, b]));
    expect(r.items.map((d) => d.title)).toEqual(["Doc 9", "Doc 8", "Doc 7", "Doc 6", "Doc 5"]);
    expect(b.fetched).toEqual([]);
    const c = parseCursor(r.nextCursor)!;
    expect(c.mode).toBe("incremental");
    expect(c.lastSeen.a).toBe("https://ibbi.gov.in/a/9.pdf");
  });

  it("skips streams without backfill support during a backfill", async () => {
    const a = listing("a", [[1]], { backfill: false });
    const r = await walkStreams(makeCtx({ cursor: backfillCursor({ only: ["a"] }) }).ctx, cfgFor([a]));
    expect(r.items).toEqual([]);
    expect(r.notes?.join(" ")).toMatch(/no way to page older items/);
  });

  it("starts over (with a note) when the stored cursor is unreadable", async () => {
    const a = listing("a", [[1]]);
    const r = await walkStreams(makeCtx({ cursor: "{garbage" }).ctx, cfgFor([a]));
    expect(r.items).toHaveLength(1);
    expect(r.notes?.[0]).toMatch(/not readable/);
  });

  it("stops before the deadline with a resumable cursor", async () => {
    const a = listing("a", [[1]]);
    const r = await walkStreams(makeCtx({ deadline: Date.now() - 1 }).ctx, cfgFor([a]));
    expect(r.done).toBe(false);
    expect(r.items).toEqual([]);
    expect(parseCursor(r.nextCursor)!.plan).toEqual(["a"]);
  });

  it("throws when every fetch of a call failed; otherwise skips the failing stream and keeps its marker", async () => {
    const bad: ListingStream = { kind: "listing", id: "bad", backfill: true, firstPage: 1, incrementalPages: 1, async fetch() { throw Object.assign(new Error("HTTP 503"), { status: 503 }); } };
    await expect(walkStreams(makeCtx().ctx, cfgFor([bad]))).rejects.toThrow("HTTP 503");
    // Incremental: a broken listing never blocks the others; its old marker survives so the next pass retries it.
    const ok = listing("ok", [[1, 2]]);
    const cursor = JSON.stringify({ v: 1, mode: "incremental", plan: [], i: 0, page: null, skip: 0, misses: 0, walked: 0, lastSeen: { bad: "https://ibbi.gov.in/bad/9.pdf" }, newest: {}, only: null });
    const r = await walkStreams(makeCtx({ cursor }).ctx, cfgFor([bad, ok]));
    expect(r.items).toHaveLength(2);
    expect(r.done).toBe(true);
    expect(r.notes?.join(" ")).toMatch(/bad: HTTP 503; skipped for this pass/);
    expect(parseCursor(r.nextCursor)!.lastSeen).toEqual({ bad: "https://ibbi.gov.in/bad/9.pdf", ok: "https://ibbi.gov.in/ok/1.pdf" });
    // Backfill: stop and resume at the same place instead of skipping.
    const rb = await walkStreams(makeCtx({ cursor: backfillCursor() }).ctx, cfgFor([ok, bad]));
    expect(rb.done).toBe(false);
    expect(rb.items).toHaveLength(2);
    expect(parseCursor(rb.nextCursor)!.plan[parseCursor(rb.nextCursor)!.i]).toBe("bad");
    // A listing that is gone (404) just ends.
    const gone: ListingStream = { ...bad, id: "gone", async fetch() { throw Object.assign(new Error("HTTP 404"), { status: 404 }); } };
    const rg = await walkStreams(makeCtx().ctx, cfgFor([gone, ok]));
    expect(rg.done).toBe(true);
    expect(rg.notes?.join(" ")).toMatch(/gone page 1: not found; stream ended/);
  });

  it("does not advance a stream's marker past an item whose detail page failed (incremental)", async () => {
    const a = listing("a", [[3, 2, 1]]);
    const resolve = async (d: DiscoveredDoc) => {
      if (d.title === "Doc 2") throw Object.assign(new Error("HTTP 502"), { status: 502 });
      return d;
    };
    const by = cfgFor([a]);
    const r = await walkStreams(makeCtx().ctx, { ...by, resolve });
    expect(r.items.map((d) => d.title)).toEqual(["Doc 3"]);
    expect(r.done).toBe(true);
    expect(parseCursor(r.nextCursor)!.lastSeen.a).toBeUndefined();
    const r2 = await walkStreams(makeCtx({ cursor: r.nextCursor }).ctx, { ...by, resolve: async (d: DiscoveredDoc) => d });
    expect(r2.items.map((d) => d.title)).toEqual(["Doc 3", "Doc 2", "Doc 1"]);
  });

  it("probes ascending sequences, tolerates gaps, ends after maxMisses and resumes above the marker", async () => {
    const published = new Set([5, 6, 8, 9]);
    const probed: number[] = [];
    const seq: SequenceStream = {
      kind: "sequence", id: "ids", backfill: true, start: 1, incrementalStart: 5, maxMisses: 3,
      async fetch(n) { probed.push(n); return published.has(n) ? doc(n, "ids") : null; },
    };
    const r1 = await walkStreams(makeCtx().ctx, cfgFor([seq]));
    expect(r1.items.map((d) => d.title)).toEqual(["Doc 5", "Doc 6", "Doc 8", "Doc 9"]);
    expect(probed).toEqual([5, 6, 7, 8, 9, 10, 11, 12]);
    expect(parseCursor(r1.nextCursor)!.lastSeen.ids).toBe("9");
    probed.length = 0;
    published.add(10);
    const r2 = await walkStreams(makeCtx({ cursor: r1.nextCursor }).ctx, cfgFor([seq]));
    expect(r2.items.map((d) => d.title)).toEqual(["Doc 10"]);
    expect(probed[0]).toBe(10);
    // Backfill from 1: misses below the known ceiling (10) never end the walk.
    probed.length = 0;
    const r3 = await walkStreams(makeCtx({ cursor: backfillCursor({ lastSeen: parseCursor(r2.nextCursor)!.lastSeen }) }).ctx, cfgFor([seq]));
    expect(probed.slice(0, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(r3.items.map((d) => d.title)).toEqual(["Doc 5", "Doc 6", "Doc 8", "Doc 9", "Doc 10"]);
    expect(parseCursor(r3.nextCursor)!.lastSeen.ids).toBe("10");
  });

  it("keeps a sequence's marker at the highest number found when the per-pass cap is reached during misses", async () => {
    // Review finding: the cap set the marker to the last number probed, so trailing misses were never probed again.
    const published = new Set([1, 2, 3]);
    const probed: number[] = [];
    const seq: SequenceStream = {
      kind: "sequence", id: "ids", backfill: true, start: 1, maxMisses: 3, incrementalMax: 5,
      async fetch(n) { probed.push(n); return published.has(n) ? doc(n, "ids") : null; },
    };
    const r1 = await walkStreams(makeCtx().ctx, cfgFor([seq]));
    expect(probed).toEqual([1, 2, 3, 4, 5]);
    expect(r1.notes?.join(" ")).toMatch(/probed 5 numbers this pass/);
    expect(parseCursor(r1.nextCursor)!.lastSeen.ids).toBe("3");
    published.add(4).add(5);
    probed.length = 0;
    const r2 = await walkStreams(makeCtx({ cursor: r1.nextCursor }).ctx, cfgFor([seq]));
    expect(probed[0]).toBe(4);
    expect(r2.items.map((d) => d.title)).toEqual(["Doc 4", "Doc 5"]);
    expect(parseCursor(r2.nextCursor)!.lastSeen.ids).toBe("5");
  });

  it("steps over one number that keeps failing, records it for retry and never treats it as published", async () => {
    // Review finding: a persistent non-404 error on one number blocked the stream at that number on every pass.
    const published = new Set([1, 2, 4, 5]);
    let broken = true;
    const probed: number[] = [];
    const seq: SequenceStream = {
      kind: "sequence", id: "ids", backfill: true, start: 1, maxMisses: 3,
      async fetch(n) {
        probed.push(n);
        if (n === 3 && broken) throw Object.assign(new Error("HTTP 500 for #3"), { status: 500 });
        return published.has(n) || n === 3 ? doc(n, "ids") : null;
      },
    };
    const r1 = await walkStreams(makeCtx().ctx, cfgFor([seq]));
    expect(r1.done).toBe(true);
    expect(r1.items.map((d) => d.title)).toEqual(["Doc 1", "Doc 2", "Doc 4", "Doc 5"]);
    expect(r1.notes?.join(" ")).toMatch(/ids #3: fetch failed while later numbers answered; skipped for now and recorded for retry/);
    const c1 = parseCursor(r1.nextCursor)!;
    expect(c1.lastSeen.ids).toBe("5");
    expect(c1.lastSeen["#retry:ids"]).toBe("3:0");
    // Next passes probe it first; each failure counts, and after RETRY_ATTEMPTS it is recorded as unverified.
    let cursor = r1.nextCursor;
    for (let i = 1; i <= RETRY_ATTEMPTS; i++) {
      probed.length = 0;
      const r = await walkStreams(makeCtx({ cursor }).ctx, cfgFor([seq]));
      expect(probed[0]).toBe(3);
      expect(r.items).toEqual([]);
      cursor = r.nextCursor;
      const ls = parseCursor(cursor)!.lastSeen;
      if (i < RETRY_ATTEMPTS) expect(ls["#retry:ids"]).toBe(`3:${i}`);
      else {
        expect(ls["#retry:ids"]).toBeUndefined();
        expect(ls["#unverified:ids"]).toBe("3");
        expect(r.notes?.join(" ")).toMatch(/ids #3: still failing after 8 retries; recorded as unverified/);
      }
    }
    // A number that answers on retry is ingested and leaves the list.
    const again = await walkStreams(makeCtx({ cursor: r1.nextCursor }).ctx, cfgFor([{ ...seq, async fetch(n) { broken = false; return seq.fetch(n, makeCtx().ctx); } }]));
    expect(again.items.map((d) => d.title)).toEqual(["Doc 3"]);
    expect(again.notes?.join(" ")).toMatch(/ids #3: found on retry/);
    expect(parseCursor(again.nextCursor)!.lastSeen["#retry:ids"]).toBeUndefined();
  });

  it("stops at the first of FAIL_RUN consecutive failures when the publisher fails for the number before them too", async () => {
    // An outage: from the first failure on, every request fails (also the check of the number before the run).
    let outage = false;
    const seq: SequenceStream = {
      kind: "sequence", id: "ids", backfill: true, start: 1, maxMisses: 3,
      async fetch(n) {
        if (n >= 3) outage = true;
        if (outage) throw Object.assign(new Error(`HTTP 503 for #${n}`), { status: 503 });
        return n < 8 ? doc(n, "ids") : null;
      },
    };
    expect(FAIL_RUN).toBe(3);
    // Incremental: the stream is skipped for this pass; its marker stays below the failing numbers (retried next pass).
    const r = await walkStreams(makeCtx().ctx, cfgFor([seq]));
    expect(r.items.map((d) => d.title)).toEqual(["Doc 1", "Doc 2"]);
    expect(r.notes?.join(" ")).toMatch(/ids: HTTP 503 for #5; skipped for this pass/);
    const c = parseCursor(r.nextCursor)!;
    expect(c.lastSeen.ids).toBe("2");
    expect(c.lastSeen["#retry:ids"]).toBeUndefined();
    // Backfill: stops and resumes at the first failing number.
    outage = false;
    const rb = await walkStreams(makeCtx({ cursor: backfillCursor() }).ctx, cfgFor([seq]));
    expect(rb.done).toBe(false);
    expect(parseCursor(rb.nextCursor)!.page).toBe(3);
  });

  it("records and steps over failing numbers while the publisher keeps answering (one, or a run of FAIL_RUN or more)", async () => {
    let bad = new Set([4]);
    const seq: SequenceStream = {
      kind: "sequence", id: "ids", backfill: true, start: 1, maxMisses: 3,
      async fetch(n) { if (bad.has(n)) throw Object.assign(new Error(`HTTP 500 for #${n}`), { status: 500 }); return n < 12 ? doc(n, "ids") : null; },
    };
    // A single failing number does not block a backfill.
    const rb = await walkStreams(makeCtx({ cursor: backfillCursor() }).ctx, cfgFor([seq]));
    expect(rb.done).toBe(true);
    expect(rb.items.map((d) => d.title)).not.toContain("Doc 4");
    expect(rb.items).toHaveLength(10);
    expect(parseCursor(rb.nextCursor)!.lastSeen["#retry:ids"]).toBe("4:0");
    // Four broken documents in a row: #3 still answers, so they are recorded and the walk goes on (no permanent stop).
    bad = new Set([4, 5, 6, 7]);
    const ri = await walkStreams(makeCtx().ctx, cfgFor([seq]));
    expect(ri.done).toBe(true);
    expect(ri.items.map((d) => d.title)).toEqual(["Doc 1", "Doc 2", "Doc 3", "Doc 8", "Doc 9", "Doc 10", "Doc 11"]);
    expect(ri.notes?.join(" ")).toMatch(/ids #4\.\.6: fetch failed while #3 answered; skipped for now and recorded for retry/);
    expect(parseCursor(ri.nextCursor)!.lastSeen).toMatchObject({ ids: "11", "#retry:ids": "4:0,5:0,6:0,7:0" });
  });

  it("keeps its place when the run's deadline cuts a request (nothing skipped, nothing recorded)", async () => {
    const deadline = () => Object.assign(new Error("the run's deadline was reached before the request finished"), { name: "OfficialDeadlineError", code: "official_deadline" });
    expect(isStopError(deadline())).toBe(true);
    const seq: SequenceStream = {
      kind: "sequence", id: "ids", backfill: true, start: 1, maxMisses: 3,
      async fetch(n) { if (n === 3) throw deadline(); return doc(n, "ids"); },
    };
    const r = await walkStreams(makeCtx().ctx, cfgFor([seq]));
    expect(r.done).toBe(false);
    expect(r.items).toHaveLength(2);
    const c = parseCursor(r.nextCursor)!;
    expect(c.page).toBe(3);
    expect(c.fails).toBe(0);
    expect(c.lastSeen["#retry:ids"]).toBeUndefined();
  });

  it("walks a markerless list in full on every pass", async () => {
    const a = listing("a", [[3, 1]], { markerless: true });
    const r1 = await walkStreams(makeCtx().ctx, cfgFor([a]));
    expect(r1.items.map((d) => d.title)).toEqual(["Doc 3", "Doc 1"]);
    // A document added below the newest one (e.g. minutes for an older meeting) is still listed.
    const a2 = listing("a", [[3, 2, 1]], { markerless: true });
    const r2 = await walkStreams(makeCtx({ cursor: r1.nextCursor }).ctx, cfgFor([a2]));
    expect(r2.items.map((d) => d.title)).toEqual(["Doc 3", "Doc 2", "Doc 1"]);
  });

  it("stops a list ordered by id at the first item at or below the marker, even when the marker item is gone", async () => {
    const byId: Partial<ListingStream> = { atMarker: (d, _k, marker) => Number(d.title.slice(4)) <= Number(marker) };
    const cfg = (pages: number[][]) => ({ ...cfgFor([listing("a", pages, byId)]), key: (d: DiscoveredDoc) => d.title.slice(4) });
    const r1 = await walkStreams(makeCtx().ctx, cfg([[10, 8, 7]]));
    expect(parseCursor(r1.nextCursor)!.lastSeen.a).toBe("10");
    const r2 = await walkStreams(makeCtx({ cursor: r1.nextCursor }).ctx, cfg([[12, 11, 8, 7]])); // 10 was withdrawn
    expect(r2.items.map((d) => d.title)).toEqual(["Doc 12", "Doc 11"]);
  });

  it("does not end a list on a page whose rows were all filtered out while the publisher still returned rows", async () => {
    const fetched: number[] = [];
    const s: ListingStream = {
      kind: "listing", id: "a", backfill: true, firstPage: 1, incrementalPages: 10,
      async fetch(page) {
        fetched.push(page);
        if (page === 1) return { items: [], rawCount: 50, last: false };
        if (page === 2) return { items: [doc(5, "a"), doc(4, "a")], rawCount: 50, last: true };
        return { items: [], rawCount: 0, last: true };
      },
    };
    const r = await walkStreams(makeCtx().ctx, cfgFor([s]));
    expect(fetched).toEqual([1, 2]);
    expect(r.items.map((d) => d.title)).toEqual(["Doc 5", "Doc 4"]);
    expect(parseCursor(r.nextCursor)!.lastSeen.a).toBe("https://ibbi.gov.in/a/5.pdf");
  });

  it("records a stream whose marker was not met within its page bound until a backfill completes it", async () => {
    const a = listing("a", [[9], [8], [7]], { incrementalPages: 2 });
    const cursor = JSON.stringify({ v: 1, mode: "incremental", plan: [], i: 0, page: null, skip: 0, misses: 0, walked: 0, lastSeen: { a: "https://ibbi.gov.in/a/1.pdf" }, newest: {}, only: null });
    const r = await walkStreams(makeCtx({ cursor }).ctx, cfgFor([a]));
    expect(parseCursor(r.nextCursor)!.lastSeen["#unmet:a"]).toBe("2026-10-02");
    const rb = await walkStreams(makeCtx({ cursor: backfillCursor({ lastSeen: parseCursor(r.nextCursor)!.lastSeen }) }).ctx, cfgFor([a]));
    expect(rb.done).toBe(true);
    expect(parseCursor(rb.nextCursor)!.lastSeen["#unmet:a"]).toBeUndefined();
  });

  it("reads cursors stored before these fields existed (production compatibility)", async () => {
    // Shape written by the previous walker: no `fails`, markers only.
    const old = JSON.stringify({ v: 1, mode: "incremental", plan: ["ids"], i: 0, page: 6, skip: 0, misses: 1, walked: 4, lastSeen: { ids: "3" }, newest: { ids: "4" }, only: null });
    const c = parseCursor(old)!;
    expect(c).toMatchObject({ mode: "incremental", page: 6, misses: 1, fails: 0, lastSeen: { ids: "3" }, newest: { ids: "4" } });
    expect(parseCursor(JSON.stringify({ ...JSON.parse(old), fails: 99 }))!.fails).toBe(0);
    const seq: SequenceStream = { kind: "sequence", id: "ids", backfill: true, start: 1, maxMisses: 3, async fetch(n) { return n === 7 ? doc(7, "ids") : null; } };
    const r = await walkStreams(makeCtx({ cursor: old }).ctx, cfgFor([seq]));
    expect(r.items.map((d) => d.title)).toEqual(["Doc 7"]);
    expect(parseCursor(r.nextCursor)!.lastSeen.ids).toBe("7");
  });
});

describe("regulator registry", () => {
  const IDS = ["ibbi", "sebi-orders", "sat-orders", "cci-orders", "egazette", "cbic", "gst-council", "cbdt", "mca-master", "sansad"];

  it("registers every regulator source with a complete definition", () => {
    expect(Object.keys(REGULATOR_ADAPTERS).sort()).toEqual([...IDS].sort());
    for (const id of IDS) {
      const a = REGULATOR_ADAPTERS[id as keyof typeof REGULATOR_ADAPTERS]!;
      expect(SOURCE_IDS).toContain(id);
      expect(a.def.id).toBe(id);
      expect(adapterFor(a.def.id)).toBe(a);
      expect(a.def.name.length).toBeGreaterThan(3);
      expect(a.def.publisher.length).toBeGreaterThan(3);
      expect(a.def.kinds.length).toBeGreaterThan(0);
      expect(a.def.homepage).toMatch(/^https:\/\//);
      expect(["direct", "firecrawl_in", "dataset_push"]).toContain(a.def.fetch);
      expect(a.def.cadenceMinutes).toBeGreaterThan(0);
      expect(a.def.attribution.length).toBeGreaterThan(10);
      expect(a.def.terms.length).toBeGreaterThan(10);
      expect(typeof a.def.enabled).toBe("boolean");
      expect(a.def.notes?.length).toBeGreaterThan(0);
    }
  });

  it("registers SAT disabled and points to SEBI's mirror", async () => {
    expect(sat.def.enabled).toBe(false);
    expect(sat.def.notes).toContain("SAT orders are ingested through SEBI Orders of SAT (sebi-orders smid=1)");
    const r = await sat.discover(makeCtx().ctx);
    expect(r).toMatchObject({ items: [], done: true, nextCursor: null });
    expect(r.notes?.[0]).toMatch(/sebi-orders smid=1/);
  });
});

describe("MCA master data (data.gov.in)", () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of ["DATA_GOV_IN_API_KEY", "DATA_GOV_IN_MCA_RESOURCE", "DATA_GOV_IN_MCA_STATES", "DATA_GOV_IN_MCA_MAX_PAGES"]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  // SYNTHETIC record in data.gov.in's documented API shape (lower-case keys); the live resource could not be reached.
  const record = {
    corporate_identification_number: "U72200KA2009PTC049889",
    company_name: "EXAMPLE SOFTWARE PRIVATE LIMITED",
    company_status: "Active",
    company_class: "Private",
    date_of_registration: "15-06-2009",
    registered_state: "Karnataka",
    authorized_cap: "1000000",
    paidup_capital: "100000",
    email_addr: "someone@example.com",
    registered_office_address: "1 Example Road, Bengaluru",
  };

  it("is disabled without credentials and does not call the API", async () => {
    delete process.env.DATA_GOV_IN_API_KEY;
    delete process.env.DATA_GOV_IN_MCA_RESOURCE;
    expect(mcaDef.enabled).toBe(false);
    const { ctx, calls } = makeCtx();
    const r = await mca.discover(ctx);
    expect(r.items).toEqual([]);
    expect(r.notes?.[0]).toMatch(/DATA_GOV_IN_API_KEY/);
    expect(calls).toEqual([]);
  });

  it("turns a record into a compact markdown document without e-mail or the API key", () => {
    const d = mcaRecordDoc(record, "abc-123")!;
    expect(d.kind).toBe("company_record");
    expect(d.text).toContain("# EXAMPLE SOFTWARE PRIVATE LIMITED");
    expect(d.text).toContain("- CIN: U72200KA2009PTC049889");
    expect(d.text).not.toContain("someone@example.com");
    expect(d.docDate).toBe("2009-06-15");
    expect(d.url).toBe("https://www.data.gov.in/resource/abc-123#cin=U72200KA2009PTC049889");
    expect(mcaRecordDoc({ ...record, corporate_identification_number: "not-a-cin" }, "abc-123")).toBeNull();
  });

  it("pages the API with a budget when enabled and never leaks the key into documents", async () => {
    process.env.DATA_GOV_IN_API_KEY = "secret-key-123";
    process.env.DATA_GOV_IN_MCA_RESOURCE = "abc-123";
    process.env.DATA_GOV_IN_MCA_STATES = "Karnataka";
    process.env.DATA_GOV_IN_MCA_MAX_PAGES = "1";
    expect(mcaDef.enabled).toBe(true);
    const cfg = mcaConfig()!;
    expect(mcaApiUrl(cfg, 0, "Karnataka")).toBe("https://api.data.gov.in/resource/abc-123?api-key=secret-key-123&format=json&offset=0&limit=100&filters%5BCompanyStateCode%5D=Karnataka");
    const page = Array.from({ length: 100 }, (_, i) => ({ ...record, corporate_identification_number: `U72200KA2009PTC${String(49800 + i).padStart(6, "0")}` }));
    const { ctx, calls } = makeCtx({ json: (u) => (u.includes("offset=0") ? { total: 250, count: 100, records: page } : u.includes("offset=100") ? { total: 250, count: 100, records: page } : undefined), limit: 1000 });
    const r = await mca.discover(ctx);
    expect(r.items).toHaveLength(100); // one page per call (DATA_GOV_IN_MCA_MAX_PAGES=1)
    expect(r.done).toBe(false);
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(r.items)).not.toContain("secret-key-123");
    const r2 = await mca.discover(makeCtx({ cursor: r.nextCursor, json: (u) => (u.includes("offset=100") ? { total: 250, records: page.slice(0, 3) } : undefined) }).ctx);
    expect(r2.items).toHaveLength(3);
    expect(r2.done).toBe(true);
  });
});
