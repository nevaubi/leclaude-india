import { beforeEach, describe, expect, it } from "vitest";
import type { RemoteStore, Row, SqlQuery } from "@/lib/db/remote";
import { TokenBucket } from "@/lib/ai/toolkit/http";
import type { Principal } from "@/lib/auth/types";
import { createFirecrawl, type FirecrawlRichOptions, type FirecrawlRichPage } from "@/modules/intel/providers/firecrawl";
import { createOfficialHttp, extractLinks, fallbackWorthy, indiaToday, isNotPublished, isTooLarge, makeAdapterContext, type FirecrawlLike } from "@/modules/official/http";
import { allowHostsFor, registerAllowHosts } from "@/modules/official/registry";
import type { SourceDef } from "@/modules/official/types";
import { handleRunRequest, ingestGate, parseRunBody } from "@/app/api/official/run/handler";
import type { OfficialRunOptions, OfficialRunResult } from "@/modules/official/run";
import { runCitatorBuild } from "@/modules/india/citator/build";
import { resetCitatorSchemaCacheForTests } from "@/modules/india/citator/schema";
import { resetCorpusSchemaCacheForTests } from "@/modules/india/corpus/backfill";
import { CORPUS_SCHEMA_VERSION } from "@/modules/india/corpus/schema";

const def = (o: Partial<SourceDef> = {}): SourceDef => ({
  id: "nclat", name: "NCLAT (test)", publisher: "National Company Law Appellate Tribunal", kinds: ["order", "cause_list"], forum: "nclat", homepage: "https://nclat.nic.in/",
  fetch: "direct", cadenceMinutes: 120, attribution: "Source: NCLAT", terms: "Government publication", enabled: true, ...o,
});

const permissive = () => new TokenBucket(1000, 1000);

function fetchStub(handler: (url: string, init: RequestInit) => Response): { fetchImpl: typeof fetch; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init: init ?? {} });
    return handler(url, init ?? {});
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function firecrawlStub(page: Partial<FirecrawlRichPage> = {}): FirecrawlLike & { calls: { url: string; o?: FirecrawlRichOptions }[] } {
  const calls: { url: string; o?: FirecrawlRichOptions }[] = [];
  return {
    configured: true,
    calls,
    async scrapeRich(url, o) {
      calls.push({ url, o });
      return { url, markdown: "# Daily orders", links: ["https://nclat.nic.in/orders/1.pdf"], json: null, logo: null, rawHtml: "<h1>Daily orders</h1>", proxyUsed: "stealth", timezone: "America/New_York", numPages: null, contentType: "text/html", statusCode: 200, ...page };
    },
  };
}

describe("official HTTP (AdapterContext fetchers)", () => {
  it("fetches pages directly with a browser-like UA, resolves links and records provenance", async () => {
    const { fetchImpl, calls } = fetchStub(() => new Response('<a href="/orders/2026/1.pdf">1</a><a href="javascript:x()">x</a><a href="https://nclat.nic.in/a?b=1&amp;c=2">a</a>', { status: 200, headers: { "content-type": "text/html" } }));
    const http = createOfficialHttp(def(), { fetchImpl, firecrawl: null, limiterFor: permissive, sleep: async () => undefined });
    const p = await http.fetchPage("https://nclat.nic.in/display-board/orders");
    expect(p.provenance).toEqual({ via: "direct", proxy: null, timezone: null, status: 200, finalUrl: "https://nclat.nic.in/display-board/orders" });
    expect(p.links).toEqual(["https://nclat.nic.in/orders/2026/1.pdf", "https://nclat.nic.in/a?b=1&c=2"]);
    expect(new Headers(calls[0].init.headers).get("user-agent")).toMatch(/^Mozilla\/5\.0/);
  });

  it("never fetches a host outside the source's allowlist", async () => {
    const { fetchImpl, calls } = fetchStub(() => new Response("x"));
    const http = createOfficialHttp(def(), { fetchImpl, firecrawl: firecrawlStub(), limiterFor: permissive });
    await expect(http.fetchPage("https://evil.example.com/")).rejects.toThrow(/not allowed/);
    await expect(http.fetchFile("http://169.254.169.254/latest")).rejects.toThrow();
    expect(calls).toHaveLength(0);
    expect(allowHostsFor(def())).toEqual(expect.arrayContaining(["nclat.nic.in", "nclat.gov.in"]));
    registerAllowHosts("nclat", ["cdn.nclat-files.gov.in", "10.0.0.1", "*.bad"]);
    expect(allowHostsFor(def())).toContain("cdn.nclat-files.gov.in");
    expect(allowHostsFor(def())).not.toContain("10.0.0.1");
  });

  it("falls back to Firecrawl (location IN) for firecrawl_in sources and records the proxy it actually used", async () => {
    const { fetchImpl } = fetchStub(() => new Response("blocked", { status: 503 }));
    const fc = firecrawlStub();
    const http = createOfficialHttp(def({ fetch: "firecrawl_in" }), { fetchImpl, firecrawl: fc, limiterFor: permissive, retries: 0, sleep: async () => undefined });
    const p = await http.fetchPage("https://nclat.nic.in/display-board/orders");
    expect(fc.calls[0].o).toMatchObject({ country: "IN", rawHtml: true, links: true, markdown: true, onlyMainContent: false, api: "v2" });
    expect(p).toMatchObject({ html: "<h1>Daily orders</h1>", markdown: "# Daily orders", links: ["https://nclat.nic.in/orders/1.pdf"] });
    expect(p.provenance).toEqual({ via: "firecrawl", proxy: "stealth", timezone: "America/New_York", status: 200, finalUrl: "https://nclat.nic.in/display-board/orders" });
  });

  it("does not fall back on a 404 (not published) or for direct-only sources", async () => {
    const fc = firecrawlStub();
    const notFound = createOfficialHttp(def({ fetch: "firecrawl_in" }), { fetchImpl: fetchStub(() => new Response("", { status: 404 })).fetchImpl, firecrawl: fc, limiterFor: permissive, retries: 0 });
    const e404 = await notFound.fetchPage("https://nclat.nic.in/x").catch((e: unknown) => e);
    expect(isNotPublished(e404)).toBe(true);
    const directOnly = createOfficialHttp(def(), { fetchImpl: fetchStub(() => new Response("", { status: 503 })).fetchImpl, firecrawl: fc, limiterFor: permissive, retries: 0, sleep: async () => undefined });
    await expect(directOnly.fetchPage("https://nclat.nic.in/x")).rejects.toThrow();
    expect(fc.calls).toHaveLength(0);
    // Unless the adapter asks for it explicitly.
    await directOnly.fetchPage("https://nclat.nic.in/x", { firecrawl: true });
    expect(fc.calls).toHaveLength(1);
    expect(fallbackWorthy(e404)).toBe(false);
  });

  it("limits file size and posts urlencoded forms with the exact fields given", async () => {
    const big = new Uint8Array(2048);
    const { fetchImpl, calls } = fetchStub((url) => (url.endsWith(".pdf") ? new Response(big, { status: 200, headers: { "content-type": "application/pdf" } }) : new Response("<ok/>", { status: 200 })));
    const http = createOfficialHttp(def(), { fetchImpl, firecrawl: null, limiterFor: permissive, maxFileBytes: 1024 });
    const err = await http.fetchFile("https://nclat.nic.in/a.pdf").catch((e: unknown) => e);
    expect(isTooLarge(err)).toBe(true);
    const ok = createOfficialHttp(def(), { fetchImpl, firecrawl: null, limiterFor: permissive });
    const f = await ok.fetchFile("https://nclat.nic.in/a.pdf");
    expect(f).toMatchObject({ mime: "application/pdf", status: 200 });
    expect(f.bytes.byteLength).toBe(2048);
    const r = await ok.postForm("https://nclat.nic.in/search", { doDirect: "2", sid: "1" });
    expect(r.text).toBe("<ok/>");
    const post = calls[calls.length - 1];
    expect(post.init.method).toBe("POST");
    expect(String(post.init.body)).toBe("doDirect=2&sid=1");
    expect(new Headers(post.init.headers).get("content-type")).toMatch(/application\/x-www-form-urlencoded/);
  });

  it("builds a bounded AdapterContext with today's date in India", () => {
    const ctx = makeAdapterContext(def(), { limit: 0, deadline: 123, cursor: "p2", firecrawl: null, now: () => Date.parse("2026-10-01T20:00:00Z") });
    expect(ctx).toMatchObject({ limit: 1, deadline: 123, cursor: "p2", today: "2026-10-02" });
    expect(indiaToday(Date.parse("2026-10-01T18:00:00Z"))).toBe("2026-10-01");
    expect(extractLinks('<img src="/a.png"><a href=b.pdf>', "https://x.gov.in/dir/")).toEqual(["https://x.gov.in/a.png", "https://x.gov.in/dir/b.pdf"]);
  });
});

describe("Firecrawl provider extensions", () => {
  it("uses v2 scrape with a PDF page limit, location IN, raw HTML and a live fetch; returns proxy and timezone", async () => {
    const bodies: { url: string; body: Record<string, unknown> }[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      bodies.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response(JSON.stringify({ success: true, data: { markdown: "# p1", rawHtml: "<p>p1</p>", links: ["https://x.gov.in/1"], metadata: { statusCode: 200, proxyUsed: "basic", timezone: "Asia/Kolkata", numPages: 3, sourceURL: "https://x.gov.in/a.pdf", contentType: "application/pdf" } } }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const fc = createFirecrawl({ env: { FIRECRAWL_API_KEY: "k" }, fetchImpl, limiter: permissive() });
    const p = await fc.scrapeRich("https://x.gov.in/a.pdf", { pdf: { maxPages: 3 }, country: "IN", rawHtml: true, links: true, onlyMainContent: false });
    expect(bodies[0].url).toBe("https://api.firecrawl.dev/v2/scrape");
    expect(bodies[0].body).toMatchObject({ url: "https://x.gov.in/a.pdf", parsers: [{ type: "pdf", maxPages: 3 }], location: { country: "IN" }, maxAge: 0, onlyMainContent: false });
    expect(bodies[0].body.formats).toEqual(["markdown", "links", "rawHtml"]);
    expect(p).toMatchObject({ markdown: "# p1", rawHtml: "<p>p1</p>", proxyUsed: "basic", timezone: "Asia/Kolkata", numPages: 3, contentType: "application/pdf" });
    await fc.scrapeRich("https://x.gov.in/c.pdf", { pdf: { pageMarkers: true } });
    expect(bodies[1].body.parsers).toEqual([{ type: "pdf", pageMarkers: true }]);
    await fc.scrapeRich("https://x.gov.in/d.pdf", { pdf: {} });
    expect(bodies[2].body.parsers).toEqual(["pdf"]);
    bodies.splice(1, 2);
    // Existing callers keep the v1 endpoint and body.
    await fc.scrapeRich("https://x.gov.in/b", { markdown: true });
    expect(bodies[1].url).toBe("https://api.firecrawl.dev/v1/scrape");
    expect(bodies[1].body).not.toHaveProperty("parsers");
    expect(bodies[1].body).not.toHaveProperty("maxAge");
  });
});

// ---------------------------------------------------------------------------
// POST /api/official/run gate (pure handler)
// ---------------------------------------------------------------------------

const person: Principal = { id: "u1", name: "Associate", tenantId: "default", roles: ["associate"], matterIds: "*", source: "dev" };
const cron: Principal = { id: "svc_cron", name: "Scheduled service", tenantId: "default", roles: ["service"], matterIds: "*", source: "service" };
const fakeResult = { stop: "done", reports: [], total: {}, units: 0, dbBytes: null, limitBytes: 1, notes: [] } as unknown as OfficialRunResult;

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/official/run", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}

describe("official run route gate", () => {
  it("refuses with 503 when OFFICIAL_INGEST_TOKEN is not set, unless the caller is the cron service principal", async () => {
    let ran: OfficialRunOptions | null = null;
    const run = async (o: OfficialRunOptions) => { ran = o; return fakeResult; };
    const r = await handleRunRequest(post({}), { principal: () => person, run, env: {} });
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ code: "not_configured" });
    expect(ran).toBeNull();
    const svc = await handleRunRequest(post({ deadlineMs: 5 }), { principal: () => cron, run, env: {} });
    expect(svc.status).toBe(200);
    expect(ran).toMatchObject({ deadlineMs: 10_000 });
  });

  it("requires the matching x-official-token (constant-time compare) for people", async () => {
    let calls = 0;
    const run = async () => { calls++; return fakeResult; };
    const env = { OFFICIAL_INGEST_TOKEN: "s3cret-token" };
    expect((await handleRunRequest(post({}), { principal: () => person, run, env })).status).toBe(403);
    expect((await handleRunRequest(post({}, { "x-official-token": "s3cret-tokeN" }), { principal: () => person, run, env })).status).toBe(403);
    expect((await handleRunRequest(post({}, { "x-official-token": "s3cret" }), { principal: () => person, run, env })).status).toBe(403);
    expect(calls).toBe(0);
    const ok = await handleRunRequest(post({ sources: ["nclt"], stages: ["discover", "fetch"], concurrency: 3, deadlineMs: 999_999, limitPerSource: 20 }, { "x-official-token": "s3cret-token" }), { principal: () => person, run, env });
    expect(ok.status).toBe(200);
    expect(calls).toBe(1);
    expect(ingestGate(post({}), cron, {})).toEqual({ ok: true, via: "service" });
    expect(ingestGate(post({}), { ...person, source: "service" }, {})).toMatchObject({ ok: false }); // a role, not just a label
  });

  it("validates the body: unknown sources or stages, bad numbers → 400; the deadline is clamped to 10s–280s", async () => {
    const env = { OFFICIAL_INGEST_TOKEN: "t" };
    const h = { "x-official-token": "t" };
    for (const bad of [{ sources: ["nope"] }, { stages: ["publish"] }, { concurrency: 0 }, { concurrency: 17 }, { limitPerSource: 1.5 }, { deadlineMs: "fast" }, { forceDiscover: "yes" }]) {
      const r = await handleRunRequest(post(bad, h), { principal: () => person, run: async () => fakeResult, env });
      expect(r.status).toBe(400);
    }
    expect(parseRunBody({ deadlineMs: 999_999 }).deadlineMs).toBe(280_000);
    expect(parseRunBody({}).deadlineMs).toBe(240_000);
    expect(parseRunBody(null)).toEqual({ deadlineMs: 240_000 });
  });

  it("maps a missing database to 503 and runner bugs to 502", async () => {
    const env = { OFFICIAL_INGEST_TOKEN: "t" };
    const h = { "x-official-token": "t" };
    const { OfficialNotConfiguredError } = await import("@/modules/official/service");
    const nc = await handleRunRequest(post({}, h), { principal: () => person, run: async () => { throw new OfficialNotConfiguredError(); }, env });
    expect(nc.status).toBe(503);
    expect(await nc.json()).toMatchObject({ code: "official_not_configured" });
    const boom = await handleRunRequest(post({}, h), { principal: () => person, run: async () => { throw new Error("db exploded with secret text"); }, env });
    expect(boom.status).toBe(502);
    expect(JSON.stringify(await boom.json())).not.toContain("secret text");
  });
});

// ---------------------------------------------------------------------------
// Citator storage guard
// ---------------------------------------------------------------------------

class CitatorBudgetFake implements RemoteStore {
  calls: SqlQuery[] = [];
  constructor(private bytes: number) {}
  async query(q: SqlQuery): Promise<Row[]> {
    this.calls.push(q);
    const s = q.query;
    if (s.includes("to_regclass('public.corpus_state')")) return [{ t: "corpus_state" }];
    if (s.includes("FROM corpus_state WHERE key = 'schema_version'")) return [{ value: String(CORPUS_SCHEMA_VERSION) }];
    if (s.startsWith("SELECT value FROM corpus_state WHERE key = $1")) return q.params?.[0] === "citator_schema_version" ? [{ value: "99" }] : [];
    if (s.includes("pg_database_size")) return [{ b: String(this.bytes) }];
    if (s.includes("to_regclass('public.corpus_texts')")) return [{ ok: "t", hc: "t" }];
    return [];
  }
  async transaction(qs: SqlQuery[]) { const out: Row[][] = []; for (const q of qs) out.push(await this.query(q)); return out; }
}

describe("citator storage budget", () => {
  beforeEach(() => { resetCorpusSchemaCacheForTests(); resetCitatorSchemaCacheForTests(); });

  it("stops with storage_budget before scanning when the database exceeds CITATOR_MAX_DB_MB (default 60,000 MB)", async () => {
    const over = new CitatorBudgetFake(61_000 * 1024 * 1024);
    const r = await runCitatorBuild({ store: over, deadlineMs: 30_000 });
    expect(r).toMatchObject({ stop: "storage_budget", processed: 0, batches: 0, limitBytes: 60_000 * 1024 * 1024 });
    expect(over.calls.some((c) => c.query.includes("WHERE text_status = 'full'"))).toBe(false);
    const under = new CitatorBudgetFake(1024);
    const ok = await runCitatorBuild({ store: under, deadlineMs: 30_000 });
    expect(ok.stop).toBe("pass_complete");
    expect(ok.batches).toBe(1);
  });
});
