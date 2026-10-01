import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/remote", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/db/remote")>()), remoteStore: () => ({}) }));
const law = vi.hoisted(() => ({ calls: [] as unknown[] }));
vi.mock("@/modules/india/law/search", () => ({
  searchProvisions: async (q: unknown) => {
    law.calls.push(q);
    const base = { kind: "act", jurisdiction: "central", state: null, state_code: null, regulator: null, chapter_title: null, in_force: true, rank: 0.4, dataset_version: "v2026.08.1" };
    return {
      hits: [
        { ...base, actId: "IND_central_20062", actTitle: "The Bharatiya Nyaya Sanhita, 2023", year: 2023, instrumentStatus: "in_force", section: "303", variant: 0, heading: "Organised crime", snippet: "continuing «unlawful» activity", source_url: "https://www.indiacode.nic.in/handle/123456789/20062" },
        { ...base, actId: "IND_central_20063", actTitle: "The Bharatiya Nagarik Suraksha Sanhita, 2023", year: 2023, instrumentStatus: "in_force", section: "482", variant: 0, heading: "Direction for grant of bail", snippet: "anticipatory «bail»", source_url: null },
        { ...base, actId: "IND_REP_45", actTitle: "The Indian Penal Code", year: 1860, instrumentStatus: "repealed", section: "420", variant: 1, heading: null, snippet: "cheating", source_url: null, in_force: false },
      ],
      hasMore: false, nextOffset: null, tookMs: 1,
    };
  },
}));

import { actTitleKey, lawStatuteHits } from "@/modules/search/engine/deps";
import { evidenceSourceId } from "@/modules/search/engine/evidence";
import { cacheKey } from "@/modules/search/engine/cache";
import { formatBluebook, normalizeLawSection } from "@/modules/search/normalize";
import { parseReadRef } from "@/modules/search/service";
import type { SearchHit } from "@/modules/search/types";

describe("research statutes lane: Postgres statutes corpus", () => {
  it("adds readable corpus sections with law ids, links and status, skipping a section the India Code store already returned", async () => {
    const existing = [{ id: "section:ienact_x:482", source: "statutes", title: "BNSS s. 482", india: { enactment: "Bharatiya Nagarik Suraksha Sanhita, 2023", section: "482", provider: "india-code" } } as SearchHit];
    const hits = await lawStatuteHits("anticipatory bail", { limit: 8, existing });
    expect(law.calls[0]).toMatchObject({ q: "anticipatory bail", limit: 8 });
    expect(hits.map((h) => h.id)).toEqual(["law:IND_central_20062:303:0", "law:IND_REP_45:420:1"]);
    expect(hits[0]).toMatchObject({
      source: "statutes",
      title: "Section 303, Bharatiya Nyaya Sanhita, 2023 — Organised crime",
      cite: "Section 303, Bharatiya Nyaya Sanhita, 2023",
      url: "/law/IND_central_20062?s=303",
      snippet: "continuing unlawful activity",
      readRef: { kind: "law", actId: "IND_central_20062", section: "303", variant: 0 },
      india: { enactment: "Bharatiya Nyaya Sanhita, 2023", section: "303", provider: "open-india-law" },
      status: "In force",
    });
    expect(hits[0].subtitle).toContain("Open India Law parse");
    expect(hits[1]).toMatchObject({ url: "/law/IND_REP_45?s=420&v=1", status: "Repealed" });
    expect(hits[1].subtitle).toContain("provision marked not in force");
  });

  it("returns nothing for an empty query", async () => {
    expect(await lawStatuteHits("  ", { limit: 8, existing: [] })).toEqual([]);
  });

  it("normalizes act titles for dedupe without dropping the year", () => {
    expect(actTitleKey("The Bharatiya Nyaya Sanhita, 2023")).toBe(actTitleKey("Bharatiya Nyaya Sanhita, 2023"));
    expect(actTitleKey("Companies Act, 1956")).not.toBe(actTitleKey("Companies Act, 2013"));
  });

  it("binds evidence, cache keys, citations and read references to the exact section", () => {
    const hit = normalizeLawSection({ actId: "IND_central_20062", actTitle: "The Bharatiya Nyaya Sanhita, 2023", kind: "act", jurisdiction: "central", state: null, state_code: null, regulator: null, year: 2023, instrumentStatus: "in_force", section: "10A", variant: 2, heading: null, chapter_title: null, in_force: null, snippet: "x", rank: 1, source_url: null, dataset_version: "v" });
    expect(evidenceSourceId({ id: hit.id, kind: "statutes", url: hit.url, hit })).toBe("law://IND_central_20062/s/10A~2");
    expect(cacheKey(hit.readRef!)).toBe("law:IND_central_20062:10A:2");
    expect(formatBluebook(hit)).toBe("Section 10A (variant 3 in the dataset), Bharatiya Nyaya Sanhita, 2023");
    expect(parseReadRef({ kind: "law", actId: "IND_central_20062", section: "10A", variant: 2 })).toEqual({ kind: "law", actId: "IND_central_20062", section: "10A", variant: 2 });
    expect(parseReadRef({ kind: "law", actId: "../x", section: "1" })).toBeNull();
    expect(parseReadRef({ kind: "law", actId: "IND_central_20062", section: "1; drop" })).toBeNull();
  });
});
