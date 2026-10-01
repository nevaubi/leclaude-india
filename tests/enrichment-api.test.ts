import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.LECLAUDE_DATA_DIR = `${process.env.TMPDIR || "/tmp"}/enrichment-api-vitest-${process.pid}`;
  process.env.LECLAUDE_SEED = "reference";
  process.env.LECLAUDE_BACKGROUND = "off";
  process.env.WORKFLOW_SCHEDULER_DISABLED = "1";
  process.env.INTEL_OFFLINE = "1";
  delete process.env.AUTH_MODE;
  delete process.env.LECLAUDE_USER_ID;
});

// The app-mirror sync (withDb) shares the remote store; here the store is a fake for the enrichment tables only.
vi.mock("@/lib/db/request", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/db/request")>()), withDb: <T,>(h: T) => h }));

import { NextRequest } from "next/server";
import { db, resetSqlite } from "@/lib/db";
import { setRemoteStoreForTests, type RemoteStore, type Row, type SqlQuery } from "@/lib/db/remote";
import { AUTH_HEADER_USER } from "@/lib/auth/types";
import * as mediaRoute from "@/app/api/media/[id]/route";
import * as judgesRoute from "@/app/api/judges/route";
import * as judgeRoute from "@/app/api/judges/[id]/route";
import * as coramRoute from "@/app/api/judges/coram/route";
import * as emblemsRoute from "@/app/api/courts/emblems/route";
import * as runRoute from "@/app/api/india/enrichment/run/route";

type Handler = (r: NextRequest, ctx?: unknown) => Promise<Response>;
const nreq = (path: string, init?: RequestInit) => new NextRequest(`http://localhost${path}`, init as ConstructorParameters<typeof NextRequest>[1]);
const call = (h: unknown, req: NextRequest, ctx?: unknown) => (h as Handler)(req, ctx);
const idCtx = (id: string) => ({ params: Promise.resolve({ id }) });

class FakeStore implements RemoteStore {
  calls: SqlQuery[] = [];
  constructor(private readonly reply: (q: SqlQuery) => Row[] = () => []) {}
  async query(q: SqlQuery): Promise<Row[]> { this.calls.push(q); return this.reply(q); }
  async transaction(qs: SqlQuery[]): Promise<Row[][]> { return Promise.all(qs.map((q) => this.query(q))); }
}

const ID = "c".repeat(64);
const ENV = ["AUTH_MODE", "AUTH_TRUST_HEADER"];

beforeAll(() => { resetSqlite(); db(); });
afterEach(() => { setRemoteStoreForTests(undefined); for (const k of ENV) delete process.env[k]; });

describe("/api/media/[id]", () => {
  it("serves stored bytes with the stored type, a strong ETag and immutable caching", async () => {
    setRemoteStoreForTests(new FakeStore((q) => (q.query.startsWith("SELECT id, mime") ? [{ id: ID, mime: "image/jpeg", bytes: "\\xffd8ffe0", size: "4", width: null, height: null, source_url: "https://www.sci.gov.in/x.jpg", page_url: "https://www.sci.gov.in/chief-justice-judges/", publisher: "Supreme Court of India", license_note: null, fetched_at: null, vision: null }] : [])));
    const res = await call(mediaRoute.GET, nreq(`/api/media/${ID}`), idCtx(ID));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("etag")).toBe(`"${ID}"`);
    expect(res.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual([0xff, 0xd8, 0xff, 0xe0]);
  });

  it("answers 304 to a matching If-None-Match, 400 for a bad id, 404 when missing, 503 without a database", async () => {
    const store = new FakeStore();
    setRemoteStoreForTests(store);
    expect((await call(mediaRoute.GET, nreq(`/api/media/${ID}`, { headers: { "if-none-match": `"${ID}"` } }), idCtx(ID))).status).toBe(304);
    expect(store.calls).toHaveLength(0);
    expect((await call(mediaRoute.GET, nreq("/api/media/..%2Fetc"), idCtx("../etc"))).status).toBe(400);
    expect((await call(mediaRoute.GET, nreq(`/api/media/${ID}`), idCtx(ID))).status).toBe(404);
    setRemoteStoreForTests(null);
    const r = await call(mediaRoute.GET, nreq(`/api/media/${ID}`), idCtx(ID));
    expect(r.status).toBe(503);
    expect(((await r.json()) as { code: string }).code).toBe("media_not_configured");
  });
});

describe("judges read routes", () => {
  it("answer 503 judges_not_configured without a database", async () => {
    setRemoteStoreForTests(null);
    for (const [h, url, ctx] of [[judgesRoute.GET, "/api/judges"], [judgeRoute.GET, "/api/judges/sci--surya-kant", idCtx("sci--surya-kant")], [coramRoute.GET, "/api/judges/coram?court=sci&name=X"], [emblemsRoute.GET, "/api/courts/emblems"]] as const) {
      const r = await call(h, nreq(url), ctx);
      expect(r.status, url).toBe(503);
      expect(((await r.json()) as { code: string }).code, url).toBe("judges_not_configured");
    }
  });

  it("returns an empty directory with the roster sources when nothing is loaded yet", async () => {
    setRemoteStoreForTests(new FakeStore());
    const r = await call(judgesRoute.GET, nreq("/api/judges"));
    const body = (await r.json()) as { judges: unknown[]; courts: unknown[]; sources: { courtId: string }[]; lastRun: unknown };
    expect(r.status).toBe(200);
    expect(body.judges).toEqual([]);
    expect(body.sources.map((s) => s.courtId)).toContain("sci");
    expect(body.lastRun).toBeNull();
  });

  it("rejects bad ids and unknown courts before touching the database", async () => {
    const store = new FakeStore();
    setRemoteStoreForTests(store);
    expect((await call(judgeRoute.GET, nreq("/api/judges/x"), idCtx("../../etc"))).status).toBe(400);
    expect((await call(coramRoute.GET, nreq("/api/judges/coram?court=nowhere&name=X"))).status).toBe(400);
    expect((await call(judgeRoute.GET, nreq("/api/judges/sci--nobody"), idCtx("sci--nobody"))).status).toBe(404);
  });
});

describe("authorization", () => {
  const as = (roles: string[]) => ({ [AUTH_HEADER_USER]: JSON.stringify({ id: "u_t", name: "T", roles, matterIds: "*" }) });

  it("requires an authenticated principal for media, judges and the enrichment run", async () => {
    process.env.AUTH_MODE = "header";
    process.env.AUTH_TRUST_HEADER = "true";
    setRemoteStoreForTests(new FakeStore());
    expect((await call(mediaRoute.GET, nreq(`/api/media/${ID}`), idCtx(ID))).status).toBe(401);
    expect((await call(judgesRoute.GET, nreq("/api/judges"))).status).toBe(401);
    expect((await call(runRoute.POST, nreq("/api/india/enrichment/run", { method: "POST", body: "{}" }))).status).toBe(401);
  });

  it("denies the enrichment run to a client guest and validates the body for staff", async () => {
    process.env.AUTH_MODE = "header";
    process.env.AUTH_TRUST_HEADER = "true";
    setRemoteStoreForTests(new FakeStore());
    expect((await call(runRoute.POST, nreq("/api/india/enrichment/run", { method: "POST", body: JSON.stringify({ target: "judges" }), headers: as(["client_guest"]) }))).status).toBe(403);
    const bad = await call(runRoute.POST, nreq("/api/india/enrichment/run", { method: "POST", body: JSON.stringify({ target: "everything" }), headers: as(["associate"]) }));
    expect(bad.status).toBe(400);
    const badCourt = await call(runRoute.POST, nreq("/api/india/enrichment/run", { method: "POST", body: JSON.stringify({ target: "judges", courts: ["hc-nowhere"] }), headers: as(["associate"]) }));
    expect(((await badCourt.json()) as { code: string }).code).toBe("bad_courts");
  });

  it("answers 503 for the run without a database", async () => {
    setRemoteStoreForTests(null);
    const r = await call(runRoute.POST, nreq("/api/india/enrichment/run", { method: "POST", body: JSON.stringify({ target: "courts" }) }));
    expect(r.status).toBe(503);
  });
});
