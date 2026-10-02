import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.LECLAUDE_DATA_DIR = `${process.env.VITEST_DATA_DIR || process.env.TMPDIR || "/tmp"}/diary-vitest-${process.pid}`;
  process.env.LECLAUDE_SEED = "reference";
  process.env.LECLAUDE_BACKGROUND = "off";
  process.env.WORKFLOW_SCHEDULER_DISABLED = "1";
  process.env.INTEL_OFFLINE = "1";
  delete process.env.AUTH_MODE;
  delete process.env.AUTH_TRUST_HEADER;
  delete process.env.LECLAUDE_USER_ID;
  delete process.env.DATABASE_URL;
  delete process.env.POSTGRES_URL;
});

import { NextRequest } from "next/server";
import { db, resetSqlite } from "@/lib/db";
import { setWorkspaceUser } from "@/lib/current-user";
import { AUTH_HEADER_USER } from "@/lib/auth/types";
import { setupWorkspace } from "@/modules/workspace/service";
import { createMatter } from "@/modules/matters/service";
import { addManualHearing, putTracking } from "@/modules/matters/desk/server";
import { OfficialNotConfiguredError, registerOfficialImpl, type CauseListQuery } from "@/modules/official/service";
import type { CauseListEntry, MatterCaseIdentifier } from "@/modules/official/types";
import { ADVOCATE_LIST_LINKS } from "@/modules/diary/advocate-links";
import * as diaryRoute from "@/app/api/diary/route";
import * as advocatesRoute from "@/app/api/diary/advocates/route";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = Record<string, any>;
const nreq = (path: string, init?: RequestInit) => new NextRequest(`http://localhost${path}`, init as ConstructorParameters<typeof NextRequest>[1]);
const send = (path: string, body: unknown, method = "PUT", headers: Record<string, string> = {}) => nreq(path, { method, body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });
const json = async (r: Response) => ({ status: r.status, body: (await r.json()) as Body });
const call = (h: unknown, ...args: unknown[]) => (h as (...a: unknown[]) => Promise<Response>)(...args);
const asHeader = (principal: Body) => {
  process.env.AUTH_MODE = "header";
  process.env.AUTH_TRUST_HEADER = "true";
  return { [AUTH_HEADER_USER]: JSON.stringify(principal) };
};

function entry(over: Partial<CauseListEntry> = {}): CauseListEntry {
  return {
    id: "cle_1", documentId: "doc_list_1", forum: "hc-delhi", listDate: "2026-10-05", listType: "main", courtNo: "33", bench: "HON'BLE MS.JUSTICE PRATHIBA M. SINGH", itemNo: "1",
    caseNumbers: [{ printed: "W.P.(C)-5812/2016", normalized: "WPC/5812/2016" }], diaryNo: null, parties: "DEVINDER & ORS V/s GOVT. OF NCT OF DELHI & ORS",
    advocates: ["L.K. RAWAL", "SHANTANU SAGAR", "SIDDHARTH PANDA"], raw: "1 W.P.(C)-5812/2016 DEVINDER & ORS V/s GOVT. OF NCT OF DELHI & ORS L.K. RAWAL, SHANTANU SAGAR, SIDDHARTH PANDA", page: 1,
    publishedAt: null, fetchedAt: "2026-10-03T09:00:00Z", parsed: true, ...over,
  };
}

let mine = "";
let theirs = "";
const seen: { matterId: string; identifiers: MatterCaseIdentifier[] }[][] = [];

beforeAll(() => {
  resetSqlite();
  setWorkspaceUser(null);
  db();
  setupWorkspace({ firmName: "Sen & Bose", name: "Arijit Sen", email: "asen@senbose.in", role: "Partner" });
  mine = createMatter({ name: "Devinder v. GNCTD", practiceArea: "Litigation", india: { courtId: "hc-delhi", nextHearing: "2026-10-05", hearingPurpose: "Final hearing" } }).id;
  theirs = createMatter({ name: "Sharma v. Union of India", practiceArea: "Litigation", india: { courtId: "hc-delhi", nextHearing: "2026-10-06" } }).id;
  putTracking(mine, { identifiers: [{ forum: "hc-delhi", kind: "case_number", printed: "W.P.(C)-5812/2016" }, { forum: "hc-karnataka", kind: "case_number", printed: "W.P. No. 77/2026" }] });
  putTracking(theirs, { identifiers: [{ forum: "hc-delhi", kind: "case_number", printed: "W.P.(C)-100/2026" }] });
  addManualHearing(mine, { date: "2026-10-07", time: "10:30", courtNo: "12", purpose: "Mention" });
  addManualHearing(theirs, { date: "2026-10-07", purpose: "Their hearing" });
});
afterEach(() => {
  delete process.env.AUTH_MODE;
  delete process.env.AUTH_TRUST_HEADER;
  registerOfficialImpl({ listingsForMatters: undefined, causeListEntries: undefined, readOfficialDocument: undefined });
});

describe("/api/diary", () => {
  it("returns only the principal's matters: no identifier of another matter reaches the facade", async () => {
    seen.length = 0;
    registerOfficialImpl({
      listingsForMatters: async (ms) => {
        seen.push(ms);
        // A misbehaving implementation that also returns another matter's listing: it must still not reach the user.
        return [
          { matterId: mine, entry: entry(), matchedOn: { forum: "hc-delhi", kind: "case_number", value: "WPC/5812/2016" } },
          { matterId: theirs, entry: entry({ id: "cle_9", parties: "SHARMA v. UOI" }), matchedOn: { forum: "hc-delhi", kind: "case_number", value: "WPC/100/2026" } },
        ];
      },
    });
    const scoped = asHeader({ id: "u_assoc", name: "Associate", roles: ["associate"], matterIds: [mine] });
    const r = await json(await call(diaryRoute.GET, nreq("/api/diary?from=2026-10-01&to=2026-10-14", { headers: scoped })));
    expect(r.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0].map((m) => m.matterId)).toEqual([mine]);
    expect(r.body).toMatchObject({ matters: 1, tracked: 1, official: { state: "ok", uncoveredForums: ["hc-karnataka"] } });
    expect(new Set(r.body.entries.map((e: Body) => e.matterId))).toEqual(new Set([mine]));
    // The listing supersedes the recorded next hearing on the same day; the manual hearing stays.
    expect(r.body.entries.map((e: Body) => [e.kind, e.date])).toEqual([["listing", "2026-10-05"], ["manual", "2026-10-07"]]);
    expect(r.body.entries[0].source).toBeNull(); // the list record could not be read: no link
    expect(r.body.entries[0].printed).toBe("W.P.(C)-5812/2016");
  });

  it("keeps hand-entered hearings and recorded dates when the official corpus is not configured", async () => {
    registerOfficialImpl({ listingsForMatters: async () => { throw new OfficialNotConfiguredError(); } });
    const r = await json(await call(diaryRoute.GET, nreq("/api/diary?from=2026-10-01&to=2026-10-14")));
    expect(r.body.official.state).toBe("not_configured");
    expect(r.body.entries.map((e: Body) => [e.kind, e.matterId, e.date])).toEqual([
      ["particulars", mine, "2026-10-05"],
      ["particulars", theirs, "2026-10-06"],
      ["manual", mine, "2026-10-07"],
      ["manual", theirs, "2026-10-07"],
    ]);
  });

  it("says not available when the facade is not wired, rejects bad ranges and denies guests", async () => {
    const r = await json(await call(diaryRoute.GET, nreq("/api/diary")));
    expect(r.body.official.state).toBe("not_available");
    expect((await call(diaryRoute.GET, nreq("/api/diary?from=2026-10-10&to=2026-10-01"))).status).toBe(400);
    const guest = asHeader({ id: "u_guest", name: "Client", roles: ["client_guest"], matterIds: [mine] });
    expect((await call(diaryRoute.GET, nreq("/api/diary", { headers: guest }))).status).toBe(403);
  });
});

describe("/api/diary/advocates", () => {
  it("validates and saves the caller's own names", async () => {
    expect((await call(advocatesRoute.PUT, send("/api/diary/advocates", { names: "Panda" }))).status).toBe(400);
    expect((await call(advocatesRoute.PUT, send("/api/diary/advocates", { names: Array.from({ length: 9 }, (_, i) => `Advocate Number${i}`) }))).status).toBe(400);
    const ok = await json(await call(advocatesRoute.PUT, send("/api/diary/advocates", { names: ["Siddharth Panda", "siddharth panda", "Meera Iyer"] })));
    expect(ok.body.names).toEqual(["Siddharth Panda", "Meera Iyer"]);
    const other = asHeader({ id: "u_other", name: "Other", roles: ["associate"], matterIds: "*" });
    const theirs = await json(await call(advocatesRoute.GET, nreq("/api/diary/advocates", { headers: other })));
    expect(theirs.body.names).toEqual([]);
  });

  it("returns exact-token matches only, per name, with the court pages linked", async () => {
    const queries: CauseListQuery[] = [];
    registerOfficialImpl({
      causeListEntries: async (q) => {
        queries.push(q);
        if (q.advocate === "Meera Iyer") throw new OfficialNotConfiguredError();
        return [entry(), entry({ id: "cle_2", advocates: ["SIDDHARTH PANDAY"] }), entry({ id: "cle_3", parsed: false })];
      },
    });
    const r = await json(await call(advocatesRoute.GET, nreq("/api/diary/advocates?from=2026-10-01&to=2026-10-07")));
    expect(queries.map((q) => [q.advocate, q.from, q.to])).toEqual([["Siddharth Panda", "2026-10-01", "2026-10-07"], ["Meera Iyer", "2026-10-01", "2026-10-07"]]);
    expect(r.body.results[0]).toMatchObject({ name: "Siddharth Panda", state: "ok" });
    expect(r.body.results[0].entries.map((e: Body) => e.id)).toEqual(["cle_1"]);
    expect(r.body.results[1]).toMatchObject({ name: "Meera Iyer", state: "not_configured", entries: [] });
    expect(r.body.links.map((l: Body) => l.courtId)).toEqual(["hc-madras", "hc-karnataka", "hc-bombay", "hc-allahabad", "hc-allahabad"]);
    for (const l of ADVOCATE_LIST_LINKS) expect(l.url).toMatch(/^https:\/\//);
  });
});
