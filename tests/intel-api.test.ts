import { beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.LECLAUDE_DATA_DIR = `${process.env.TMPDIR || "/tmp"}/intel-vitest-api-${process.pid}`;
  process.env.LECLAUDE_BACKGROUND = "off";
  process.env.WORKFLOW_SCHEDULER_DISABLED = "1";
  process.env.INTEL_OFFLINE = "1";
  process.env.OPENAI_API_KEY = "";
  process.env.CRON_SECRET = "";
});

import { z } from "zod";
import { NextRequest } from "next/server";
import { db, resetSqlite } from "@/lib/db";
import { defineAdapter, registerAdapter } from "@/modules/intel/adapters";
import { updateSource } from "@/modules/intel/service";
import { intelSources } from "@/modules/intel/store";
import * as sources from "@/app/api/intel/sources/route";
import * as sourceById from "@/app/api/intel/sources/[id]/route";
import * as sourceRun from "@/app/api/intel/sources/[id]/run/route";
import * as jobs from "@/app/api/intel/jobs/route";
import * as jobById from "@/app/api/intel/jobs/[id]/route";
import * as tick from "@/app/api/intel/jobs/tick/route";
import * as documents from "@/app/api/intel/documents/route";
import * as documentById from "@/app/api/intel/documents/[id]/route";
import * as search from "@/app/api/intel/search/route";
import * as health from "@/app/api/intel/health/route";
import * as config from "@/app/api/intel/config/route";

beforeAll(() => {
  resetSqlite(); db();
  for (const s of intelSources().all()) updateSource(s.id, { enabled: false });
});

registerAdapter(defineAdapter({
  id: "web-list", name: "fake web-list", description: "t", kinds: ["web_page"], family: "web", requires: [],
  configSchema: z.object({ pages: z.number().int().default(1) }), defaults: { pages: 1 },
  async run(ctx) { for (let i = 0; i < ctx.config.pages; i++) await ctx.ingest({ kind: "web_page", title: `API page ${i}`, dates: {}, externalId: `api:${ctx.source.id}:${i}`, text: `API page ${i}. ` + "API page text about local rules. ".repeat(30) }); },
}));

const BASE = "http://localhost/api/intel";
const req = (path: string, init: RequestInit = {}) => new NextRequest(`${BASE}${path}`, init as ConstructorParameters<typeof NextRequest>[1]);
const post = (path: string, body: unknown, method = "POST") => req(path, { method, body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const json = async (r: Response) => ({ status: r.status, body: await r.json() });

describe("sources API", () => {
  let created: string;
  it("lists sources and adapters, creates, reads, patches and refuses to delete system sources", async () => {
    const list = await json(await sources.GET(req("/sources")));
    expect(list.status).toBe(200);
    expect(list.body.sources).toHaveLength(18); // 12 demo sample sources + 6 India sources
    expect(list.body.adapters).toHaveLength(18);
    expect(list.body.sources[0]).toMatchObject({ documents: expect.any(Number), adapterName: expect.any(String) });
    const bad = await json(await sources.POST(post("/sources", { adapter: "web-list", name: "x", config: { pages: "many" } })));
    expect(bad.status).toBe(422);
    const create = await json(await sources.POST(post("/sources", { adapter: "web-list", name: "API source", config: { pages: 2 }, schedule: { every: "manual" } })));
    expect(create.status).toBe(201);
    created = create.body.source.id;
    expect(create.body.source).toMatchObject({ adapter: "web-list", enabled: true, status: "idle", config: { pages: 2 } });
    const get = await json(await sourceById.GET(req(`/sources/${created}`), params(created)));
    expect(get.status).toBe(200);
    expect(get.body).toMatchObject({ source: { id: created }, jobs: [], documents: { total: 0 } });
    const patch = await json(await sourceById.PATCH(post(`/sources/${created}`, { name: "Renamed", schedule: { every: "6h" }, enabled: false }, "PATCH"), params(created)));
    expect(patch.status).toBe(200);
    expect(patch.body.source).toMatchObject({ name: "Renamed", schedule: { every: "6h" }, enabled: false, status: "disabled" });
    const badPatch = await json(await sourceById.PATCH(post(`/sources/${created}`, { schedule: { every: "yearly" } }, "PATCH"), params(created)));
    expect(badPatch.status).toBe(422);
    const sys = intelSources().find((s) => Boolean(s.system))[0];
    const del = await json(await sourceById.DELETE(req(`/sources/${sys.id}`, { method: "DELETE" }), params(sys.id)));
    expect(del.status).toBe(409);
    expect((await sourceById.GET(req("/sources/nope"), params("nope"))).status).toBe(404);
  });
  it("runs a source inline with wait and reports it in jobs, documents, search and health", async () => {
    updateSource(created, { enabled: true });
    const run = await json(await sourceRun.POST(post(`/sources/${created}/run`, { wait: true }), params(created)));
    expect(run.status).toBe(200);
    expect(run.body.job).toMatchObject({ status: "succeeded", result: { added: 2 } });
    const list = await json(await jobs.GET(req(`/jobs?sourceId=${created}&status=succeeded`)));
    expect(list.body.total).toBe(1);
    expect(list.body.items[0]).toMatchObject({ sourceName: "Renamed", kind: "source.run" });
    expect(list.body.counts).toMatchObject({ queued: expect.any(Number), escalated: expect.any(Number) });
    const one = await json(await jobById.GET(req(`/jobs/${run.body.job.id}`), params(run.body.job.id)));
    expect(one.body.source).toMatchObject({ id: created });
    const conflict = await json(await jobById.POST(post(`/jobs/${run.body.job.id}`, { action: "cancel" }), params(run.body.job.id)));
    expect(conflict.status).toBe(409);
    const retry = await json(await jobById.POST(post(`/jobs/${run.body.job.id}`, { action: "retry", note: "again" }), params(run.body.job.id)));
    expect(retry.body.job.status).toBe("queued");
    const cancel = await json(await jobById.POST(post(`/jobs/${run.body.job.id}`, { action: "cancel" }), params(run.body.job.id)));
    expect(cancel.body.job.status).toBe("cancelled");
    const docs = await json(await documents.GET(req(`/documents?sourceId=${created}&sort=title&direction=asc&limit=1`)));
    expect(docs.body.total).toBe(2);
    expect(docs.body.items[0].title).toBe("API page 0");
    expect(docs.body.items[0].textBlobId).toBeTruthy();
    const id = docs.body.items[0].id;
    const doc = await json(await documentById.GET(req(`/documents/${id}?chunks=1&maxChars=200`), params(id)));
    expect(doc.body).toMatchObject({ document: { id }, truncated: true });
    expect(doc.body.text).toHaveLength(200);
    expect(doc.body.chunks.length).toBeGreaterThan(0);
    const flagged = await json(await documentById.POST(post(`/documents/${id}`, { flag: { kind: "needs_review", note: "check" } }), params(id)));
    expect(flagged.body.document.flags[0]).toMatchObject({ kind: "needs_review", by: "human" });
    const badFlag = await json(await documentById.POST(post(`/documents/${id}`, { flag: { kind: "bogus" } }), params(id)));
    expect(badFlag.status).toBe(422);
    const unflagged = await json(await documentById.POST(post(`/documents/${id}`, { unflag: "needs_review" }), params(id)));
    expect(unflagged.body.document.flags).toEqual([]);
    const s = await json(await search.GET(req(`/search?q=local+rules&sourceIds=${created}`)));
    expect(s.body.hits.length).toBeGreaterThan(0);
    expect(s.body.hits.every((h: { doc: { title: string } }) => h.doc.title.startsWith("API page"))).toBe(true);
    const sp = await json(await search.POST(post("/search", { q: "government contractor", kinds: ["opinion"], limit: 3 })));
    expect(sp.body.hits[0].doc.kind).toBe("opinion");
    const h = await json(await health.GET());
    expect(h.body.health).toMatchObject({ background: "off", documents: expect.any(Number), sources: { total: 19 } }); // 18 system sources (12 sample + 6 India) + the one created above
    const c = await json(await config.GET());
    expect(c.body).toMatchObject({ background: "off", corpusDirs: [], jobs: { concurrency: expect.any(Number) } });
    expect(c.body.providers.find((p: { id: string }) => p.id === "openai").configured).toBe(false);
    expect(c.body.adapters).toHaveLength(18);
  });
  it("tick runs due work and enforces CRON_SECRET when set", async () => {
    const r = await json(await tick.POST(req("/jobs/tick?limit=2&deadlineMs=3000&housekeeping=0", { method: "POST" })));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ran: expect.any(Number), health: { documents: expect.any(Number) } });
    process.env.CRON_SECRET = "s3cret";
    expect((await tick.GET(req("/jobs/tick"))).status).toBe(401);
    expect((await tick.GET(req("/jobs/tick", { headers: { authorization: "Bearer s3cret" } }))).status).toBe(200);
    process.env.CRON_SECRET = "";
  });
});
