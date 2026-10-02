import { beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { db, resetSqlite } from "@/lib/db";
import type { Matter } from "@/lib/types/domain";
import { addStandardIssueCodes, getCodingRules, listIssueCodes, listPrivilegeLog, matterStats, production, productionCsv, searchDocuments, viewCounts, STANDARD_ISSUE_CODES } from "@/modules/ediscovery/service";
import { listBatches, listLayouts, listProductions, listRedactions, listSavedSearches, listTermReports } from "@/modules/ediscovery/review-service";
import { crossAnalysis, graph, listConflicts, listDepositions, listEvents, listFactMatrices, listKnowledgeMaps, matterPeople, overview, suggestTopics } from "@/modules/ediscovery/analysis/service";
import { listStories } from "@/modules/ediscovery/analysis/service-stories";
import { getEDiscoverySettings } from "@/modules/ediscovery/ingest";
import { GET as statsGET } from "@/app/api/ediscovery/stats/route";
import { POST as searchPOST } from "@/app/api/ediscovery/search/route";
import { GET as overviewGET } from "@/app/api/ediscovery/analysis/overview/route";
import { POST as codesPOST } from "@/app/api/ediscovery/issue-codes/route";

const M = "m_empty_matter_test";

beforeAll(() => {
  resetSqlite();
  const m: Matter = { id: M, slug: M, name: "Fresh Matter LLC v. Nobody", shortName: "Fresh Matter", client: "Fresh Matter LLC", clientSide: "plaintiff", practiceArea: "Commercial", status: "active", openedAt: "2026-09-01", teamIds: [] };
  db().matters.put(m);
});

describe("a new matter with no documents", () => {
  it("returns honest zero stats and empty lists without throwing", async () => {
    const s = matterStats(M);
    expect(s).toMatchObject({ total: 0, reviewed: 0, pctReviewed: 0, hot: 0, privileged: 0, custodians: 0 });
    expect(viewCounts(M).every((v) => v.count === 0)).toBe(true);
    const r = await searchDocuments({ matterId: M });
    expect(r.total).toBe(0);
    expect(r.hits).toEqual([]);
    const q = await searchDocuments({ matterId: M, q: "anything at all", semantic: true });
    expect(q.total).toBe(0);
    expect(listIssueCodes(M)).toEqual([]);
    expect(listPrivilegeLog(M)).toEqual([]);
    expect(production(M)).toBeTruthy();
    expect(typeof productionCsv(M)).toBe("string");
    expect(listBatches(M)).toEqual([]);
    expect(listSavedSearches(M)).toEqual([]);
    expect(listLayouts(undefined, M)).toBeInstanceOf(Array);
    expect(listProductions(M)).toEqual([]);
    expect(listRedactions({ matterId: M })).toEqual([]);
    expect(listTermReports(M)).toEqual([]);
  });

  it("analysis surfaces are empty, not seeded", async () => {
    expect(listDepositions(M)).toEqual([]);
    expect(listEvents(M)).toEqual([]);
    expect(listConflicts(M)).toEqual([]);
    expect(listStories(M)).toEqual([]);
    expect(listFactMatrices(M)).toEqual([]);
    expect(listKnowledgeMaps(M)).toEqual([]);
    expect(matterPeople(M)).toEqual([]);
    expect(graph(M).nodes).toEqual([]);
    expect(suggestTopics(M)).toEqual([]);
    const o = overview(M);
    expect(o).toBeTruthy();
    const cross = await crossAnalysis(M, { topic: "delivery delays" });
    expect(cross.testimony).toEqual([]);
    expect(cross.documents).toEqual([]);
  });

  it("uses a generic coding protocol and a Bates prefix from the matter name", () => {
    expect(getCodingRules(M)).toMatch(/No protocol has been written/);
    expect(getEDiscoverySettings(M)).toMatchObject({ batesPrefix: "FM", nextBates: 1, batesWidth: 7 });
  });

  it("routes answer 200 with empty payloads", async () => {
    const stats = await statsGET(new NextRequest(`http://localhost/api/ediscovery/stats?matter=${M}`));
    expect(stats.status).toBe(200);
    expect((await stats.json()).total).toBe(0);
    const search = await searchPOST(new NextRequest("http://localhost/api/ediscovery/search", { method: "POST", body: JSON.stringify({ matterId: M, q: "" }) }));
    expect(search.status).toBe(200);
    expect((await search.json()).total).toBe(0);
    const ov = await overviewGET(new NextRequest(`http://localhost/api/ediscovery/analysis/overview?matter=${M}`));
    expect(ov.status).toBe(200);
    expect((await ov.json()).topics).toEqual([]);
  });

  it("offers a generic standard issue-code set, added once", async () => {
    const res = await codesPOST(new NextRequest("http://localhost/api/ediscovery/issue-codes", { method: "POST", body: JSON.stringify({ matterId: M, preset: "standard" }) }));
    expect(res.status).toBe(201);
    expect((await res.json()).created).toHaveLength(STANDARD_ISSUE_CODES.length);
    expect(listIssueCodes(M).map((c) => c.code).sort()).toEqual(["CONF", "HOT", "NR", "PRIV-AC", "PRIV-WP", "RESP"]);
    expect(addStandardIssueCodes(M).created).toHaveLength(0);
    // Nothing case-specific leaks into a new matter.
    expect(listIssueCodes(M).some((c) => /TOX|PFOS|VALSARA|MFC/.test(`${c.code} ${c.label}`))).toBe(false);
  });
});
