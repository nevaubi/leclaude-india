import { describe, expect, it } from "vitest";
import { SUBORDINATE_FORUMS, caseTypesFor, cityForCourtId, courtName, courtOptions, forumById, resolveCourt, validateCnr } from "@/modules/matters/india";
import { forumContextFor, forumContextLine } from "@/modules/courts/context";

const LEGACY_IDS = ["ka-blr-city-civil", "ka-blr-commercial", "ka-blr-sessions", "ka-blr-acmm", "ts-hyd-city-civil", "ts-hyd-commercial", "ts-hyd-sessions", "ts-hyd-mm"];

describe("backward compatibility of earlier forum ids", () => {
  it("still resolves every id earlier matters stored", () => {
    for (const id of LEGACY_IDS) {
      const r = resolveCourt(id);
      expect(r?.kind, id).toBe("forum");
      expect(forumById(id)?.highCourtId, id).toBe(id.startsWith("ka-") ? "hc-karnataka" : "hc-telangana");
      expect(courtName(id), id).toBeTruthy();
    }
    expect(courtName("ka-blr-commercial")).toBe("Commercial Court, Bengaluru");
    expect(courtName("ts-hyd-sessions")).toBe("Metropolitan Sessions Court, Hyderabad");
    expect(caseTypesFor("ka-blr-commercial")[0].code).toBe("Com.O.S.");
    expect(caseTypesFor("ts-hyd-mm").map((t) => t.code)).toContain("C.C.");
    expect(SUBORDINATE_FORUMS.every((f) => f.level === "district")).toBe(true);
  });

  it("warns on a CNR from another State only for district-judiciary courts", () => {
    expect(validateCnr("MHCC010012342023", "ka-blr-city-civil")).toMatchObject({ ok: true, warning: expect.stringContaining("Karnataka") });
    expect(validateCnr("MHCC010012342023", "mumbai-city-civil")).toMatchObject({ ok: true });
    expect(validateCnr("MHCC010012342023", "mumbai-city-civil")).not.toHaveProperty("warning");
    expect(validateCnr("KAHC010123452024", "mumbai-nclt")).not.toHaveProperty("warning");
  });
});

describe("matter form city filtering", () => {
  const ids = (groups: ReturnType<typeof courtOptions>) => groups.flatMap((g) => g.options.map((o) => o.id));

  it("offers only the city's High Court and forums plus the Supreme Court", () => {
    const g = courtOptions("mumbai");
    expect(g.map((x) => x.group)).toEqual(["Mumbai", "Supreme Court"]);
    expect(ids(g)).toEqual(expect.arrayContaining(["hc-bombay", "mumbai-city-civil", "mumbai-nclt", "sci"]));
    expect(ids(g)).not.toContain("ka-blr-commercial");
    // Gurugram: the jurisdictional High Court sits at Chandigarh.
    expect(ids(courtOptions("gurugram"))).toEqual(expect.arrayContaining(["hc-ph", "gurugram-district", "sci"]));
  });

  it("keeps an existing value valid when the city does not contain it", () => {
    const g = courtOptions("mumbai", "ka-blr-commercial");
    expect(g[0]).toMatchObject({ group: "Current", options: [{ id: "ka-blr-commercial" }] });
    expect(courtOptions("mumbai", "mumbai-nclt")[0].group).toBe("Mumbai");
    expect(courtOptions("mumbai", "no-such-court").map((x) => x.group)).toEqual(["Mumbai", "Supreme Court"]);
  });

  it("keeps the unfiltered grouping (focus States first) without a city", () => {
    const g = courtOptions();
    expect(g[0].group).toBe("Karnataka");
    expect(g[0].options[0].id).toBe("hc-karnataka");
    expect(ids(g)).toEqual(expect.arrayContaining([...LEGACY_IDS, "sci", "delhi-nclt"]));
    expect(courtOptions("atlantis")[0].group).toBe("Karnataka");
  });

  it("infers the city from a court only when it is unique", () => {
    expect(cityForCourtId("mumbai-nclt")).toBe("mumbai");
    expect(cityForCourtId("hc-karnataka")).toBe("bengaluru");
    expect(cityForCourtId("hc-bombay")).toBeNull(); // Mumbai and Pune both go to the Principal Seat
    expect(cityForCourtId("hc-allahabad", "all-lucknow")).toBe("lucknow");
    expect(cityForCourtId("sci")).toBeNull();
  });
});

describe("agent forum context", () => {
  it("names the forum, city, State and local-law pointers (as pointers)", () => {
    const c = forumContextFor({ cityId: "bengaluru", courtId: "ka-blr-commercial" })!;
    expect(c).toMatchObject({ city: { id: "bengaluru" }, state: { code: "KA", name: "Karnataka" }, forum: { id: "ka-blr-commercial" } });
    expect(c.local_law_pointers.map((p) => p.title)).toContain("The Karnataka Rent Act, 1999");
    expect(c.local_law_pointers.every((p) => p.act_ids === undefined)).toBe(true);
    const line = forumContextLine({ courtId: "ka-blr-commercial" });
    expect(line).toContain("Commercial Court, Bengaluru");
    expect(line).toContain("not authority");
    expect(forumContextLine(undefined)).toBe("");
    const resolved = forumContextFor({ cityId: "bengaluru" }, null, new Map([["The Karnataka Rent Act, 1999", { status: "resolved", actIds: ["IND_KA_1"] }]]))!;
    expect(resolved.local_law_pointers.find((p) => p.title === "The Karnataka Rent Act, 1999")).toMatchObject({ status: "resolved", act_ids: ["IND_KA_1"] });
  });
});
