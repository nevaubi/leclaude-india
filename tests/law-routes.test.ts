import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.LECLAUDE_DATA_DIR = `${process.env.TMPDIR || "/tmp"}/law-routes-vitest-${process.pid}`;
  process.env.LECLAUDE_SEED = "reference";
  process.env.LECLAUDE_BACKGROUND = "off";
  process.env.WORKFLOW_SCHEDULER_DISABLED = "1";
  process.env.INTEL_OFFLINE = "1";
  delete process.env.AUTH_MODE;
  delete process.env.LECLAUDE_USER_ID;
});

// The app-mirror sync (withDb) shares the remote store; here the store is a fake for the law tables only.
vi.mock("@/lib/db/request", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/db/request")>()), withDb: <T,>(h: T) => h }));

import { NextRequest } from "next/server";
import { db, resetSqlite } from "@/lib/db";
import { setRemoteStoreForTests, type RemoteStore } from "@/lib/db/remote";
import { resetLawReadyCacheForTests } from "@/modules/india/law/common";
import { resetLawFacetsCacheForTests } from "@/modules/india/law/directory";
import * as listRoute from "@/app/api/law/route";
import * as facetsRoute from "@/app/api/law/facets/route";
import * as searchRoute from "@/app/api/law/search/route";
import * as itemRoute from "@/app/api/law/[...id]/route";

type Handler = (r: NextRequest, ctx?: unknown) => Promise<Response>;
const call = async (h: unknown, url: string, ctx?: unknown) => {
  const res = await (h as Handler)(new NextRequest(`http://localhost${url}`), ctx);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};
const idCtx = (id: string[]) => ({ params: Promise.resolve({ id }) });

beforeAll(() => { resetSqlite(); db(); });
afterEach(() => { setRemoteStoreForTests(undefined); resetLawReadyCacheForTests(); resetLawFacetsCacheForTests(); });

describe("/api/law routes", () => {
  it("answer 503 law_corpus_not_configured without a database", async () => {
    setRemoteStoreForTests(null);
    for (const [h, url, ctx] of [[listRoute.GET, "/api/law?q=rent"], [facetsRoute.GET, "/api/law/facets"], [searchRoute.GET, "/api/law/search?q=bail"], [itemRoute.GET, "/api/law/IND_central_1", idCtx(["IND_central_1"])]] as const) {
      const r = await call(h, url, ctx);
      expect(r.status, url).toBe(503);
      expect(r.body.code, url).toBe("law_corpus_not_configured");
    }
  });

  it("answer 503 law_corpus_not_loaded when the loader's tables are missing", async () => {
    const store: RemoteStore = { query: async () => [{ law_datasets: null, law_instruments: null, law_provisions: null }], transaction: async () => [] };
    setRemoteStoreForTests(store);
    const r = await call(listRoute.GET, "/api/law");
    expect(r.status).toBe(503);
    expect(r.body.code).toBe("law_corpus_not_loaded");
  });

  it("reject bad input before touching the database", async () => {
    setRemoteStoreForTests(null);
    expect((await call(searchRoute.GET, "/api/law/search")).body.code).toBe("query_required");
    expect((await call(searchRoute.GET, "/api/law/search?q=x&act=../etc")).status).toBe(400);
    expect((await call(itemRoute.GET, "/api/law/x", idCtx(["a", "b"]))).body.code).toBe("bad_id");
    expect((await call(itemRoute.GET, "/api/law/IND_1?section=1;drop", idCtx(["IND_1"]))).body.code).toBe("bad_section");
  });

  it("answer 404 section_not_found for an unknown section (no nearest-section fallback)", async () => {
    const store: RemoteStore = {
      query: async (q) => (q.query.includes("to_regclass") ? [{ law_datasets: "x", law_instruments: "x", law_provisions: "x" }] : q.query.includes("FROM law_instruments") ? [{ id: "IND_1", title: "An Act", kind: "act", jurisdiction: "central", dataset_file: "f", dataset_version: "v" }] : []),
      transaction: async () => [],
    };
    setRemoteStoreForTests(store);
    const r = await call(itemRoute.GET, "/api/law/IND_1?section=999", idCtx(["IND_1"]));
    expect(r.status).toBe(404);
    expect(r.body.code).toBe("section_not_found");
  });
});
