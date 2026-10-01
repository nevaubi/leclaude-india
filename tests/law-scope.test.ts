import { describe, expect, it } from "vitest";
import type { SqlValue } from "@/lib/db/remote";
import { instrumentFilters } from "@/modules/india/law/common";
import { statuteStates } from "@/modules/search/engine/deps";

describe("statute research scope", () => {
  it("maps courts in scope to the States whose legislation applies", () => {
    expect(statuteStates(["hc-karnataka"])).toEqual(["KA"]);
    expect(statuteStates(["sci", "hc-telangana"]).sort()).toEqual(["IN", "TS"]);
    expect(statuteStates([])).toEqual([]);
  });

  it("keeps central and regulator instruments and only the scoped States' Acts", () => {
    const params: SqlValue[] = [];
    expect(instrumentFilters({ scopeStates: ["KA", "bad state"] }, params)).toBe(" AND (i.jurisdiction <> 'state' OR i.state_code = ANY($1::text[]))");
    expect(params).toEqual(["{KA}"]);
    expect(instrumentFilters({ scopeStates: [] }, [])).toBe(" AND i.jurisdiction <> 'state'");
    expect(instrumentFilters({}, [])).toBe("");
  });

  it("leaves reports out only when asked and no kind is requested", () => {
    expect(instrumentFilters({ excludeReports: true }, [])).toBe(" AND i.kind <> 'report'");
    const p: SqlValue[] = [];
    expect(instrumentFilters({ excludeReports: true, kind: "report" }, p)).toBe(" AND i.kind = $1");
    expect(p).toEqual(["report"]);
  });
});

describe("plain-language statute queries", () => {
  it("broadens to significant words only for plain queries", async () => {
    const { anyWordsQuery } = await import("@/modules/india/law/search");
    expect(anyWordsQuery("eviction of tenant for bona fide personal use under the Karnataka Rent Act")).toBe("eviction or tenant or bona or fide or personal or use or karnataka or rent");
    expect(anyWordsQuery("\"anticipatory bail\"")).toBeNull();
    expect(anyWordsQuery("bail or bond")).toBeNull();
    expect(anyWordsQuery("theft")).toBeNull();
    expect(anyWordsQuery("किराया अधिनियम बेदखली")).toBe("किराया or अधिनियम or बेदखली");
  });
});
