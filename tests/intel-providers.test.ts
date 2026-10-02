import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.LECLAUDE_DATA_DIR = `${process.env.TMPDIR || "/tmp"}/intel-vitest-providers-${process.pid}`;
  process.env.LECLAUDE_BACKGROUND = "off";
  process.env.WORKFLOW_SCHEDULER_DISABLED = "1";
  process.env.OPENAI_API_KEY = "";
});

import { fetchCached, httpCacheKey, memoryHttpCache, TokenBucket } from "@/lib/ai/toolkit/http";
const fresh = () => new TokenBucket(50, 50);
import { asProviderError, isProviderError, ProviderClient, ProviderError, toIntelErrorCode } from "@/modules/intel/providers/base";
import { createCourtListener } from "@/modules/intel/providers/courtlistener";
import { createEcfr } from "@/modules/intel/providers/ecfr";
import { createFederalRegister } from "@/modules/intel/providers/federal-register";
import { createFirecrawl } from "@/modules/intel/providers/firecrawl";
import { createJpml, JPML_FALLBACK, parseJpmlTable } from "@/modules/intel/providers/jpml";
import { createOpenFda, fdaDateRange, fdaSearchClause } from "@/modules/intel/providers/openfda";
import { createTavily } from "@/modules/intel/providers/tavily";
import { createWeb } from "@/modules/intel/providers/web";

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

function fakeFetch(handler: Handler) {
  const calls: { url: string; method: string; body?: string }[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, method: (init?.method ?? "GET").toUpperCase(), body: typeof init?.body === "string" ? init.body : undefined });
    return handler(url, init);
  }) as typeof fetch;
  return { impl, calls };
}

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });
const html = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
const noSleep = async () => {};

describe("token bucket", () => {
  it("refills over time and reports wait", async () => {
    let t = 0;
    const b = new TokenBucket(2, 1, () => t);
    expect(b.tryTake()).toBe(true);
    expect(b.tryTake()).toBe(true);
    expect(b.tryTake()).toBe(false);
    expect(b.msUntil()).toBe(1000);
    t = 1000;
    expect(b.tryTake()).toBe(true);
    expect(await b.take(100, noSleep)).toBe(false);
    t = 2500;
    expect(await b.take(100, noSleep)).toBe(true);
  });
});

describe("fetchCached", () => {
  it("caches 2xx responses for the TTL and keys on method+url+body", async () => {
    let n = 0;
    const { impl, calls } = fakeFetch(() => json({ n: ++n }));
    const cache = memoryHttpCache();
    const a = await fetchCached("https://example.test/a", { fetchImpl: impl, cache, ttlMs: 60_000 });
    const b = await fetchCached("https://example.test/a", { fetchImpl: impl, cache, ttlMs: 60_000 });
    expect(a.cached).toBe(false);
    expect(b.cached).toBe(true);
    expect(b.body).toBe(a.body);
    expect(calls).toHaveLength(1);
    await fetchCached("https://example.test/a", { fetchImpl: impl, cache, ttlMs: 60_000, method: "POST", body: "x=1" });
    expect(calls).toHaveLength(2);
    await fetchCached("https://example.test/a", { fetchImpl: impl, cache, ttlMs: 0 });
    expect(calls).toHaveLength(3);
    expect(httpCacheKey("GET", "https://x")).not.toBe(httpCacheKey("POST", "https://x"));
  });
  it("does not cache errors by default and never throws on HTTP status", async () => {
    const { impl, calls } = fakeFetch(() => json({ error: "nope" }, 500));
    const cache = memoryHttpCache();
    const r1 = await fetchCached("https://example.test/err", { fetchImpl: impl, cache });
    const r2 = await fetchCached("https://example.test/err", { fetchImpl: impl, cache });
    expect(r1.status).toBe(500);
    expect(r2.cached).toBe(false);
    expect(calls).toHaveLength(2);
  });
});

describe("provider client error mapping", () => {
  const make = (handler: Handler, limiter?: TokenBucket) => {
    const f = fakeFetch(handler);
    return { ...f, client: new ProviderClient({ name: "t", rps: 100, burst: 100, fetchImpl: f.impl, cache: memoryHttpCache(), limiter, maxWaitMs: 50, sleep: noSleep }) };
  };
  it("maps 429, 401/403, 404, 5xx, bad JSON and network failures", async () => {
    const c429 = make(() => json({}, 429, { "retry-after": "7" }));
    await expect(c429.client.getJSON("https://p/x")).rejects.toMatchObject({ code: "rate_limited", retryable: true, status: 429, retryAfterMs: 7000 });
    const c403 = make(() => json({}, 403));
    await expect(c403.client.getJSON("https://p/x")).rejects.toMatchObject({ code: "not_configured", retryable: false });
    const c404 = make(() => json({}, 404));
    await expect(c404.client.getJSON("https://p/x")).rejects.toMatchObject({ code: "http", retryable: false, status: 404 });
    const c503 = make(() => json({}, 503));
    await expect(c503.client.getJSON("https://p/x")).rejects.toMatchObject({ code: "http", retryable: true });
    const bad = make(() => html("<html>not json</html>"));
    await expect(bad.client.getJSON("https://p/x")).rejects.toMatchObject({ code: "parse", retryable: false });
    const net = make(() => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } }); });
    const err = await net.client.getJSON("https://p/x").catch((e) => e);
    expect(isProviderError(err)).toBe(true);
    expect(err.code).toBe("network");
    expect(err.retryable).toBe(true);
    expect(toIntelErrorCode(err)).toBe("network");
    expect(toIntelErrorCode(new ProviderError("t", "http", "x", true, 500))).toBe("network");
    expect(asProviderError("t", Object.assign(new Error("aborted"), { name: "AbortError" })).code).toBe("timeout");
    expect(net.client.stats.errors).toBe(1);
  });
  it("serves cached responses without consuming rate-limit tokens and fails fast when the bucket is empty", async () => {
    const limiter = new TokenBucket(1, 0.001);
    const { client, calls } = make(() => json({ ok: true }), limiter);
    const a = await client.getJSON<{ ok: boolean }>("https://p/cached");
    expect(a.ok).toBe(true);
    const b = await client.getJSON<{ ok: boolean; __cached?: boolean }>("https://p/cached");
    expect(b.__cached).toBe(true);
    expect(calls).toHaveLength(1);
    await expect(client.getJSON("https://p/other")).rejects.toMatchObject({ code: "rate_limited", retryable: true });
    expect(client.stats.rateLimited).toBe(1);
  });
  it("blocks all requests in offline mode", async () => {
    const c = new ProviderClient({ name: "t", rps: 1, burst: 1, offline: true });
    await expect(c.getText("https://p/x")).rejects.toMatchObject({ code: "not_configured" });
  });
});

describe("courtlistener provider", () => {
  it("maps search results, docket entries and people, and detects schema drift", async () => {
    const { impl, calls } = fakeFetch((url) => {
      if (url.includes("/search/?") && url.includes("drift")) return json({ hits: [] });
      if (url.includes("/search/?") && url.includes("type=o")) return json({ count: 1, results: [{ caseName: "Boyle v. United Technologies Corp.", citation: ["487 U.S. 500"], court: "Supreme Court", court_id: "scotus", dateFiled: "1988-06-27T00:00:00Z", docketNumber: "86-492", judge: "Scalia", status: "Published", cluster_id: 112, absolute_url: "/opinion/112/boyle/", opinions: [{ id: 999, snippet: "  reasonably   precise " }] }] });
      if (url.includes("/opinions/999/")) return json({ plain_text: "Full text of Boyle.", absolute_url: "/opinion/112/boyle/" });
      if (url.includes("/search/?") && url.includes("type=r")) return json({ count: 1, results: [{ caseName: "In re Depo-Provera", docketNumber: "3:25-md-03140", court_id: "flnd", dateFiled: "2025-02-07", assignedTo: "M. Casey Rodgers", docket_id: 5, party: ["Pfizer Inc."], attorney: ["John R. Sample"], absolute_url: "/docket/5/depo-provera/" }] });
      if (url.includes("/docket-entries/")) return json({ results: [{ id: 77, entry_number: 3, date_filed: "2024-03-29", description: "ORDER granting final approval", recap_documents: [{ id: 1, description: "Order", is_available: true, absolute_url: "/recap/x/", page_count: 12 }] }] });
      if (url.includes("type=p")) return json({ count: 1, results: [{ id: 42, name: "M. Casey Rodgers", positions: [{ position_type: "jud", court_full_name: "N.D. Fla.", court_id: "flnd", appointer: "Bush", date_start: "2003-01-01" }], absolute_url: "/person/42/rodgers/" }] });
      return json({ results: [] });
    });
    const cl = createCourtListener({ fetchImpl: impl, cache: memoryHttpCache(), env: { COURTLISTENER_API_TOKEN: "tok" }, sleep: noSleep });
    expect(cl.keyed).toBe(true);
    const ops = await cl.searchOpinions({ query: "Boyle", courts: "scotus", limit: 5 });
    expect(ops.total).toBe(1);
    expect(ops.results[0]).toMatchObject({ caseName: "Boyle v. United Technologies Corp.", citations: ["487 U.S. 500"], courtId: "scotus", dateFiled: "1988-06-27", opinionId: 999, clusterId: 112, snippet: "reasonably precise", url: "https://www.courtlistener.com/opinion/112/boyle/" });
    const text = await cl.getOpinionText(999);
    expect(text.text).toBe("Full text of Boyle.");
    const dk = await cl.searchDockets({ query: "", docketNumber: "3:25-md-03140", courts: "flnd" });
    expect(dk.results[0]).toMatchObject({ docketId: 5, assignedTo: "M. Casey Rodgers", parties: ["Pfizer Inc."] });
    expect(calls.find((c) => c.url.includes("type=r"))!.url).toContain("docketNumber");
    const entries = await cl.getDocketEntries(5, { since: "2024-01-01" });
    expect(entries[0]).toMatchObject({ id: 77, entryNumber: 3, dateFiled: "2024-03-29" });
    expect(entries[0].documents[0].url).toBe("https://www.courtlistener.com/recap/x/");
    const people = await cl.searchPeople({ name: "Rodgers" });
    expect(people[0]).toMatchObject({ id: 42, name: "M. Casey Rodgers" });
    expect(people[0].positions[0].courtId).toBe("flnd");
    expect(calls.every((c) => (c as { url: string }).url.startsWith("https://www.courtlistener.com/api/rest/v4/"))).toBe(true);
    await expect(cl.searchOpinions({ query: "drift" })).rejects.toMatchObject({ code: "parse" });
  });
});

describe("regulatory providers", () => {
  it("eCFR search and section text", async () => {
    const { impl } = fakeFetch((url) => {
      if (url.includes("/search/v1/results")) return json({ results: [{ hierarchy: { title: "40", part: "141", section: "141.2" }, headings: { section: "Definitions", part: "Drinking water" }, full_text_excerpt: "<b>Contaminant</b> means…", starts_on: "2023-11-13" }], meta: { total_count: 1 } });
      if (url.includes("/versioner/v1/full/")) return new Response("<SECTION><SECTNO>§ 141.2</SECTNO><SUBJECT>Definitions.</SUBJECT><P>Contaminant means any physical, chemical, biological, or radiological substance or matter in water.</P></SECTION>", { headers: { "content-type": "application/xml" } });
      return json({});
    });
    const ecfr = createEcfr({ fetchImpl: impl, cache: memoryHttpCache(), sleep: noSleep });
    const s = await ecfr.search({ query: "contaminant", title: 40 });
    expect(s.results[0]).toMatchObject({ cite: "40 C.F.R. § 141.2", heading: "Definitions", excerpt: "Contaminant means…" });
    const sec = await ecfr.getSection({ title: 40, section: "141.2" });
    expect(sec.text).toContain("Contaminant means any physical, chemical");
    expect(sec.heading).toBe("Definitions.");
    expect(sec.url).toBe("https://www.ecfr.gov/current/title-40/section-141.2");
  });
  it("Federal Register search, document and text", async () => {
    const { impl } = fakeFetch((url) => {
      if (url.includes("/documents.json")) return json({ count: 1, results: [{ document_number: "2024-07773", title: "Benzene NPDWR", type: "Rule", abstract: "Abs", agencies: [{ name: "Environmental Protection Agency" }], publication_date: "2024-04-26", effective_on: "2024-06-25", citation: "89 FR 32532", html_url: "https://www.federalregister.gov/d/2024-07773", raw_text_url: "https://www.federalregister.gov/raw/2024-07773", cfr_references: [{ title: 40, part: 141 }] }] });
      if (url.includes("/raw/")) return new Response("Full rule text.", { headers: { "content-type": "text/plain" } });
      return json({});
    });
    const fr = createFederalRegister({ fetchImpl: impl, cache: memoryHttpCache(), sleep: noSleep });
    const s = await fr.search({ term: "benzene", agencies: ["environmental-protection-agency"], publishedAfter: "2024-01-01" });
    expect(s.results[0]).toMatchObject({ documentNumber: "2024-07773", citation: "89 FR 32532", agencies: ["Environmental Protection Agency"], cfrReferences: [{ title: 40, part: 141 }] });
    const t = await fr.getText(s.results[0]);
    expect(t).toMatchObject({ text: "Full rule text.", source: "raw" });
  });
  it("openFDA enforcement mapping, 404-as-empty and query helpers", async () => {
    const { impl, calls } = fakeFetch((url) => {
      if (url.includes("/drug/enforcement.json") && url.includes("nothing")) return json({ error: { code: "NOT_FOUND" } }, 404);
      if (url.includes("/drug/enforcement.json")) return json({ meta: { results: { total: 1 } }, results: [{ recall_number: "D-0418-2025", classification: "Class II", status: "Ongoing", product_description: "Medroxyprogesterone acetate injectable suspension", reason_for_recall: "Particulate matter", recalling_firm: "Harborview", report_date: "20250402", recall_initiation_date: "20250318", openfda: { generic_name: ["MEDROXYPROGESTERONE ACETATE"], product_ndc: ["1-2"] } }] });
      return json({});
    });
    const fda = createOpenFda({ fetchImpl: impl, cache: memoryHttpCache(), env: { OPENFDA_API_KEY: "k" }, sleep: noSleep });
    const r = await fda.enforcement({ endpoint: "drug", search: 'product_description:"medroxyprogesterone"', limit: 5 });
    expect(r.total).toBe(1);
    expect(r.results[0]).toMatchObject({ recallNumber: "D-0418-2025", classification: "Class II", reportDate: "2025-04-02", initiationDate: "2025-03-18" });
    expect(r.results[0].openfda.genericName).toEqual(["MEDROXYPROGESTERONE ACETATE"]);
    expect(calls[0].url).toContain("api_key=k");
    const empty = await fda.enforcement({ endpoint: "drug", search: "nothing" });
    expect(empty.results).toEqual([]);
    expect(fdaSearchClause(["Depo-Provera", "ranitidine"], "product_description")).toBe('(product_description:"Depo-Provera"+OR+product_description:"ranitidine")');
    expect(fdaDateRange("report_date", new Date("2024-01-01T00:00:00Z"), new Date("2024-12-31T00:00:00Z"))).toBe("report_date:[20240101+TO+20241231]");
  });
});

describe("web, firecrawl, tavily and JPML providers", () => {
  it("plain web fetch converts HTML to text and probes URLs; Firecrawl/Tavily report not_configured without keys", async () => {
    const { impl } = fakeFetch((url, init) => {
      if (init?.method === "HEAD") return new Response(null, { status: url.endsWith("/gone") ? 404 : 200 });
      return html("<html><head><title>Rules</title></head><body><main><h1>Local Rules</h1><p>" + "Rule text. ".repeat(80) + "</p></main></body></html>");
    });
    const firecrawl = createFirecrawl({ fetchImpl: impl, cache: memoryHttpCache(), env: { FIRECRAWL_API_KEY: undefined }, sleep: noSleep });
    expect(firecrawl.configured).toBe(false);
    await expect(firecrawl.scrape("https://x.test")).rejects.toMatchObject({ code: "not_configured", retryable: false });
    const tavily = createTavily({ fetchImpl: impl, cache: memoryHttpCache(), env: { TAVILY_API_KEY: undefined }, sleep: noSleep });
    await expect(tavily.search({ query: "x" })).rejects.toMatchObject({ code: "not_configured" });
    const web = createWeb({ fetchImpl: impl, cache: memoryHttpCache(), firecrawl, sleep: noSleep });
    const page = await web.fetchPage("https://court.test/rules");
    expect(page.via).toBe("plain");
    expect(page.title).toBe("Rules");
    expect(page.text).toContain("Local Rules");
    expect((await web.probe("https://court.test/gone")).status).toBe(404);
    expect((await web.probe("https://court.test/ok")).ok).toBe(true);
  });
  it("uses Firecrawl when configured and falls back to plain fetch when it fails", async () => {
    let firecrawlCalls = 0;
    const { impl } = fakeFetch((url) => {
      if (url.includes("api.firecrawl.dev")) { firecrawlCalls++; return json({ success: false, error: "boom" }); }
      return html("<html><body><article>" + "Plain body text. ".repeat(50) + "</article></body></html>");
    });
    const firecrawl = createFirecrawl({ fetchImpl: impl, cache: memoryHttpCache(), env: { FIRECRAWL_API_KEY: "fc" }, sleep: noSleep });
    const web = createWeb({ fetchImpl: impl, cache: memoryHttpCache(), firecrawl, sleep: noSleep });
    const page = await web.fetchPage("https://agency.test/page");
    expect(firecrawlCalls).toBe(1);
    expect(page.via).toBe("plain");
    expect(page.text).toContain("Plain body text");
  });
  it("Firecrawl search and Tavily search map results", async () => {
    const { impl, calls } = fakeFetch((url) => {
      if (url.includes("firecrawl.dev/v1/search")) return json({ success: true, data: [{ url: "https://news.test/a", title: "A", description: "desc", metadata: { publishedTime: "2026-09-20" } }] });
      if (url.includes("api.tavily.com/search")) return json({ results: [{ url: "https://news.test/b", title: "B", content: "body", score: 0.9, published_date: "Sat, 20 Sep 2026 10:00:00 GMT" }] });
      return json({});
    });
    const fc = createFirecrawl({ fetchImpl: impl, cache: memoryHttpCache(), env: { FIRECRAWL_API_KEY: "fc" }, sleep: noSleep });
    const s = await fc.search("meningioma", { limit: 3 });
    expect(s[0]).toMatchObject({ url: "https://news.test/a", title: "A", publishedAt: "2026-09-20" });
    expect(calls[0].body).toContain('"query":"meningioma"');
    const tv = createTavily({ fetchImpl: impl, cache: memoryHttpCache(), env: { TAVILY_API_KEY: "tv" }, sleep: noSleep });
    const t = await tv.search({ query: "Depo-Provera", topic: "news", days: 7 });
    expect(t.results[0]).toMatchObject({ url: "https://news.test/b", score: 0.9 });
  });
  it("parses the JPML table and falls back to the seeded list when the page cannot be read", async () => {
    const table = `<table><tr><th>MDL No.</th><th>Litigation Title</th><th>District</th><th>Judge</th><th>Pending Actions</th></tr>
      <tr><td>2804</td><td>In re: National Prescription Opiate Litigation</td><td>N.D. Ohio</td><td>Hon. Dan Aaron Polster</td><td>10,254</td></tr>
      <tr><td>3140</td><td>Depo-Provera (Depot Medroxyprogesterone Acetate) Products Liability Litigation</td><td>N.D. Florida</td><td>M. Casey Rodgers</td><td>1,102</td></tr>
      <tr><td>3047</td><td>In re: Social Media Adolescent Addiction/Personal Injury Products Liability Litigation</td><td>N.D. California</td><td>Yvonne Gonzalez Rogers</td><td>1,500</td></tr>
      <tr><td>3004</td><td>In re: Paraquat Products Liability Litigation</td><td>S.D. Illinois</td><td>Nancy J. Rosenstengel</td><td>5,000</td></tr>
      <tr><td>3081</td><td>In re: Bard Implanted Port Catheter Products Liability Litigation</td><td>D. Arizona</td><td>David G. Campbell</td><td>800</td></tr></table>`;
    const parsed = parseJpmlTable(`<html><body>${table}</body></html>`);
    expect(parsed).toHaveLength(5);
    expect(parsed[0]).toMatchObject({ mdlNumber: "2804", courtId: "ohnd", judge: "Dan Aaron Polster", pendingActions: 10254 });
    expect(parsed[1].title.startsWith("In re:")).toBe(true);
    const live = createJpml({ fetchImpl: fakeFetch(() => html(table)).impl, cache: memoryHttpCache(), sleep: noSleep, limiter: fresh() });
    expect((await live.pendingMDLs()).source).toBe("live");
    const broken = createJpml({ fetchImpl: fakeFetch(() => html("<html><body>Maintenance</body></html>")).impl, cache: memoryHttpCache(), sleep: noSleep, limiter: fresh() });
    const fb = await broken.pendingMDLs();
    expect(fb.source).toBe("fallback");
    expect(fb.mdls.length).toBe(JPML_FALLBACK.length);
    expect(fb.mdls.every((m) => m.fallback)).toBe(true);
    const down = createJpml({ fetchImpl: fakeFetch(() => json({}, 503)).impl, cache: memoryHttpCache(), sleep: noSleep, limiter: fresh() });
    expect((await down.pendingMDLs()).source).toBe("fallback");
    await expect(down.pendingMDLs({ allowFallback: false })).rejects.toMatchObject({ code: "http" });
  });
});
