import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.LECLAUDE_DATA_DIR = `${process.env.TMPDIR || "/tmp"}/enrichment-visuals-vitest-${process.pid}`;
  process.env.LECLAUDE_SEED = "reference";
  process.env.LECLAUDE_BACKGROUND = "off";
  process.env.WORKFLOW_SCHEDULER_DISABLED = "1";
  process.env.INTEL_OFFLINE = "1";
  delete process.env.AUTH_MODE;
  delete process.env.LECLAUDE_USER_ID;
});

vi.mock("@/lib/db/request", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/db/request")>()), withDb: <T,>(h: T) => h }));

import { NextRequest } from "next/server";
import { db, resetSqlite } from "@/lib/db";
import { setRemoteStoreForTests, type RemoteStore, type Row, type SqlQuery } from "@/lib/db/remote";
import { AUTH_HEADER_USER } from "@/lib/auth/types";
import * as visualsRoute from "@/app/api/india/visuals/route";
import * as emblemsRoute from "@/app/api/courts/emblems/route";
import * as runRoute from "@/app/api/india/enrichment/run/route";
import { runEnrichment, type EnrichDeps } from "@/modules/judges/enrich";
import { rosterSourceFor } from "@/modules/judges/sources";
import { rasteriseSvg } from "@/modules/media/logos";
import { dominantColour } from "@/modules/media/visuals";
import { sniffImage } from "@/modules/media/validate";
import type { StoredMedia } from "@/modules/media/store";

type Handler = (r: NextRequest, ctx?: unknown) => Promise<Response>;
const nreq = (path: string, init?: RequestInit) => new NextRequest(`http://localhost${path}`, init as ConstructorParameters<typeof NextRequest>[1]);
const call = (h: unknown, req: NextRequest) => (h as Handler)(req);

class FakeStore implements RemoteStore {
  calls: SqlQuery[] = [];
  constructor(private readonly reply: (q: SqlQuery) => Row[] = () => []) {}
  async query(q: SqlQuery): Promise<Row[]> { this.calls.push(q); return this.reply(q); }
  async transaction(qs: SqlQuery[]): Promise<Row[][]> { return Promise.all(qs.map((q) => this.query(q))); }
  find(re: RegExp) { return this.calls.filter((c) => re.test(c.query)); }
}

beforeAll(() => { resetSqlite(); db(); });
afterEach(() => { setRemoteStoreForTests(undefined); delete process.env.AUTH_MODE; delete process.env.AUTH_TRUST_HEADER; });

describe("GET /api/india/visuals", () => {
  it("answers empty maps and updatedAt null without a database", async () => {
    setRemoteStoreForTests(null);
    const r = await call(visualsRoute.GET, nreq("/api/india/visuals"));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ courts: {}, cities: {}, regulators: {}, updatedAt: null });
    expect(r.headers.get("cache-control")).toBe("private, max-age=300");
  });

  it("serves shown visuals in the contract shape", async () => {
    const credit = JSON.stringify({ author: null, license: "Logo of Reserve Bank of India", licenseUrl: null, sourceUrl: "https://www.rbi.org.in/", sourceName: "Reserve Bank of India" });
    setRemoteStoreForTests(new FakeStore((q) => (/to_regclass\('public\.visuals'\)/.test(q.query) ? [{ v: "visuals" }] : /FROM visuals v/.test(q.query) ? [{ kind: "regulator_logo", key: "rbi", media_id: "a".repeat(64), credit, alt: "Logo of the Reserve Bank of India", dominant: "#123456", checked_at: "2026-10-02T09:00:00Z", width: "256", height: "256" }] : [])));
    const body = await (await call(visualsRoute.GET, nreq("/api/india/visuals"))).json();
    expect(body).toEqual({ courts: {}, cities: {}, regulators: { rbi: { kind: "regulator_logo", key: "rbi", url: `/api/media/${"a".repeat(64)}`, width: 256, height: 256, alt: "Logo of the Reserve Bank of India", credit: JSON.parse(credit), dominant: "#123456" } }, updatedAt: "2026-10-02T09:00:00Z" });
  });

  it("requires an authenticated principal", async () => {
    process.env.AUTH_MODE = "header";
    process.env.AUTH_TRUST_HEADER = "true";
    setRemoteStoreForTests(new FakeStore());
    expect((await call(visualsRoute.GET, nreq("/api/india/visuals"))).status).toBe(401);
  });
});

describe("GET /api/courts/emblems after the re-audit", () => {
  it("filters hidden and State-Emblem rows in the query", async () => {
    const store = new FakeStore((q) => (/FROM court_assets/.test(q.query) && /hidden IS NOT TRUE/.test(q.query) ? [{ court_id: "hc-telangana", kind: "emblem", media_id: "e".repeat(64), source_url: "https://tshc.gov.in/logo.png", page_url: null }] : []));
    setRemoteStoreForTests(store);
    const body = (await (await call(emblemsRoute.GET, nreq("/api/courts/emblems"))).json()) as { emblems: Record<string, unknown> };
    expect(Object.keys(body.emblems)).toEqual(["hc-telangana"]);
    const sel = store.find(/SELECT court_id, kind, media_id, source_url, page_url FROM court_assets/)[0];
    expect(sel.query).toMatch(/containsStateEmblem/);
    // The schema probe checks the hidden column so existing databases get the ALTER.
    expect(store.find(/ALTER TABLE court_assets ADD COLUMN IF NOT EXISTS hidden/)).toHaveLength(1);
  });
});

describe("POST /api/india/enrichment/run targets visuals and emblems_audit", () => {
  const as = { [AUTH_HEADER_USER]: JSON.stringify({ id: "u_t", name: "T", roles: ["associate"], matterIds: "*" }) };
  const post = (body: unknown) => call(runRoute.POST, nreq("/api/india/enrichment/run", { method: "POST", body: JSON.stringify(body), headers: as }));

  it("validates kinds, keys and refresh", async () => {
    process.env.AUTH_MODE = "header";
    process.env.AUTH_TRUST_HEADER = "true";
    setRemoteStoreForTests(new FakeStore());
    expect(((await (await post({ target: "visuals", kinds: ["portraits"] })).json()) as { code: string }).code).toBe("bad_kinds");
    expect(((await (await post({ target: "visuals", keys: ["../x"] })).json()) as { code: string }).code).toBe("bad_keys");
    expect(((await (await post({ target: "visuals", refresh: "yes" })).json()) as { code: string }).code).toBe("bad_refresh");
    expect(((await (await post({ target: "photos" })).json()) as { code: string }).code).toBe("bad_target");
  });

  it("answers 503 without a database", async () => {
    setRemoteStoreForTests(null);
    const v = await call(runRoute.POST, nreq("/api/india/enrichment/run", { method: "POST", body: JSON.stringify({ target: "visuals" }) }));
    expect(v.status).toBe(503);
    expect(((await v.json()) as { code: string }).code).toBe("visuals_not_configured");
    const a = await call(runRoute.POST, nreq("/api/india/enrichment/run", { method: "POST", body: JSON.stringify({ target: "emblems_audit" }) }));
    expect(a.status).toBe(503);
  });

  it("returns a per-key report (unknown keys skipped without network)", async () => {
    setRemoteStoreForTests(new FakeStore());
    const r = await call(runRoute.POST, nreq("/api/india/enrichment/run", { method: "POST", body: JSON.stringify({ target: "visuals", keys: ["state-gst", "nowhere"] }) }));
    expect(r.status).toBe(200);
    const body = (await r.json()) as { target: string; items: { key: string; status: string }[]; counts: Record<string, number>; stop: string };
    expect(body.target).toBe("visuals");
    expect(body.items.map((i) => [i.key, i.status])).toEqual([["state-gst", "skipped"], ["nowhere", "skipped"]]);
    expect(body).toMatchObject({ stop: "done", counts: { stored: 0, rejected: 0, skipped: 2, failed: 0 } });
  });
});

describe("image helpers backed by sharp", () => {
  it("rasterises sanitised SVG to PNG and computes a dominant colour", async () => {
    const png = await rasteriseSvg(`<svg xmlns="http://www.w3.org/2000/svg" width="300" height="100"><rect width="300" height="100" fill="#d01010"/></svg>`);
    const s = sniffImage(png);
    expect(s?.mime).toBe("image/png");
    expect(Math.max(s!.width!, s!.height!)).toBeLessThanOrEqual(512);
    const dom = await dominantColour(png);
    expect(dom).toMatch(/^#[0-9a-f]{6}$/);
    expect(parseInt(dom!.slice(1, 3), 16)).toBeGreaterThan(150);
    expect(await dominantColour(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});

describe("judge roster fallbacks", () => {
  function media(url: string): StoredMedia {
    const id = Buffer.from(url).toString("hex").padEnd(64, "0").slice(0, 64);
    return { id, url: `/api/media/${id}`, mime: "image/jpeg", size: 100, width: 300, height: 375, existed: false, dataUrl: "data:image/jpeg;base64,AA==" };
  }
  const base = (store: FakeStore, over: Partial<EnrichDeps>): EnrichDeps => ({
    fetchPage: null,
    store,
    storeImage: async (url) => media(url),
    classify: async () => ({ raw: { kind: "portrait", single_person: true, placeholder: false, reason: "portrait" }, model: null }),
    now: () => new Date("2026-10-02T10:00:00Z"),
    deadlineMs: 60_000,
    extractText: async () => [],
    ...over,
  });

  it("reads Karnataka from its official fallback page when the primary page times out, citing the page read", async () => {
    const fallback = rosterSourceFor("hc-karnataka")!.fallbackUrls![0];
    const store = new FakeStore((q) => (/SELECT count/.test(q.query) ? [{ n: "0" }] : []));
    const r = await runEnrichment({ target: "judges", courts: ["hc-karnataka"] }, base(store, {
      scrape: async (url) => {
        if (url !== fallback) throw new Error("firecrawl: HTTP 408");
        return { markdown: "Sitting Judges\n\nHon'ble Mr. Justice Vibhu Bakhru, Chief Justice\n\nHon'ble Smt. Justice Anu Sivaraman", links: [], json: { judges: [{ name: "Hon'ble Mr. Justice Vibhu Bakhru" }, { name: "Hon'ble Smt. Justice Anu Sivaraman" }, { name: "Hon'ble Mr. Justice Invented Person" }] }, logo: null };
      },
    }));
    expect(r.judges[0]).toMatchObject({ courtId: "hc-karnataka", status: "ok", found: 2, upserted: 2, sourceUrl: fallback });
    expect(r.judges[0].notes.join(" ")).toMatch(/Invented Person.*not printed/);
    for (const u of store.find(/INSERT INTO judges/)) expect(u.params?.[13]).toBe(fallback);
  });

  it("reads Madras through the second reader (page text) with guarded extraction when scraping fails", async () => {
    const url = rosterSourceFor("hc-madras")!.url;
    const store = new FakeStore((q) => (/SELECT count/.test(q.query) ? [{ n: "0" }] : []));
    const text = "Present Hon'ble Judges\n1. Hon'ble Mr.Justice Manindra Mohan Shrivastava, Chief Justice\n19. Hon'ble Mr.Justice B. Pugalendhi";
    const r = await runEnrichment({ target: "judges", courts: ["hc-madras"] }, base(store, {
      scrape: async () => { throw new Error("firecrawl: HTTP 500"); },
      extractText: async (urls) => urls.map((u) => ({ url: u, text })),
      extractJudges: async () => [{ name: "Hon'ble Mr.Justice Manindra Mohan Shrivastava" }, { name: "Hon'ble Mr.Justice B. Pugalendhi", photo_url: "https://hcmadras.tn.gov.in/x.jpg" }, { name: "Justice Nobody" }],
    }));
    expect(r.judges[0]).toMatchObject({ courtId: "hc-madras", status: "ok", found: 2, sourceUrl: url });
    expect(r.judges[0].notes[0]).toMatch(/second reader/);
    // The photo URL is not printed in the text, so it is not linked (photos.missing counts entries without a photo).
    expect(r.judges[0].photos.missing).toBe(2);
  });

  it("reports every failed read when neither reader works, without touching stored judges", async () => {
    const store = new FakeStore();
    const r = await runEnrichment({ target: "judges", courts: ["hc-karnataka"] }, base(store, { scrape: async () => { throw new Error("HTTP 408"); }, extractText: async () => { throw new Error("tavily down"); } }));
    expect(r.judges[0].status).toBe("failed");
    expect(r.judges[0].error).toMatch(/judiciary\.karnataka\.gov\.in.*HTTP 408.*karnatakajudiciary\.kar\.nic\.in.*HTTP 408.*second reader: tavily down/);
    expect(store.find(/INSERT INTO judges|UPDATE judges/)).toHaveLength(0);
  });
});

describe("direct roster reader", () => {
  it("keeps images as absolute markdown URLs and drops data URIs", async () => {
    const { rosterHtmlToText } = await import("@/modules/judges/enrich");
    const html = `<main><h1>Sitting Judges</h1><div><img src="/images/judges/cj.jpg" alt="Hon'ble Chief Justice"><p>Hon'ble Mr. Justice A. B. Rao</p><img src="data:image/png;base64,AAAA"></div>${"<p>filler text for the main region</p>".repeat(20)}</main>`;
    const text = rosterHtmlToText(html, "https://judiciary.karnataka.gov.in/submenujprofile.php?nid=1");
    expect(text).toContain("![Hon'ble Chief Justice](https://judiciary.karnataka.gov.in/images/judges/cj.jpg)");
    expect(text).toContain("Justice A. B. Rao");
    expect(text).not.toContain("data:image");
  });

  it("reads a roster directly when the scraper fails, with the same name guard", async () => {
    const { runEnrichment } = await import("@/modules/judges/enrich");
    const store = new FakeStore();
    const page = "Sitting Judges\n![Justice A. B. Rao](https://judiciary.karnataka.gov.in/images/abr.jpg)\nHon'ble Mr. Justice A. B. Rao, Judge";
    const r = await runEnrichment({ target: "judges", courts: ["hc-karnataka"] }, {
      store: store as never,
      storeImage: async (url: string) => ({ id: "a".repeat(64), url: `/api/media/${"a".repeat(64)}`, mime: "image/jpeg", size: 1000, width: 300, height: 400, existed: false, dataUrl: `data:image/jpeg;base64,${url.length}` }),
      classify: async () => ({ raw: { kind: "portrait", single_person: true, placeholder: false, reason: "portrait" }, model: null }) as never,
      scrape: async () => { throw new Error("HTTP 408"); },
      extractText: async () => [],
      fetchPage: async (url: string) => ({ url, text: page }),
      extractJudges: async () => [{ name: "A. B. Rao", photo_url: "https://judiciary.karnataka.gov.in/images/abr.jpg" }, { name: "Not On Page" }] as never,
    });
    const k = r.judges[0];
    expect(k.found).toBe(1);
    expect(k.notes.join(" ")).toMatch(/Read directly from the official page/);
  });
});
