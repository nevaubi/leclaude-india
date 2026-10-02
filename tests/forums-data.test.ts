import { describe, expect, it } from "vitest";
import { COURTS, courtById } from "@/lib/india/courts";
import { CITIES, FORUMS, INDIA_CODE_CHECKED_AT, INDIA_CODE_HOME, LOCAL_LAW, cityById, findCity, forumById, forumRecordForCourt, forumsForCity, highCourtForumFor, normaliseActTitle } from "@/lib/india/forums";

describe("city forum data integrity", () => {
  it("has unique forum and city ids", () => {
    expect(new Set(FORUMS.map((f) => f.id)).size).toBe(FORUMS.length);
    expect(new Set(CITIES.map((c) => c.id)).size).toBe(CITIES.length);
    // Forum ids never collide with registry court ids (matters store either in courtId).
    for (const f of FORUMS) expect(courtById(f.id), f.id).toBeNull();
  });

  it("covers the required cities", () => {
    const required = ["delhi", "mumbai", "bengaluru", "hyderabad", "chennai", "kolkata", "pune", "ahmedabad", "amaravati", "kochi", "chandigarh", "jaipur", "lucknow", "prayagraj", "gurugram", "noida"];
    for (const id of required) expect(cityById(id), id).not.toBeNull();
  });

  it("gives every forum at least one https source checked on a date, and https links", () => {
    for (const f of FORUMS) {
      expect(f.sources.length, f.id).toBeGreaterThan(0);
      for (const s of f.sources) {
        expect(s.url, f.id).toMatch(/^https:\/\//);
        expect(s.title.trim().length, f.id).toBeGreaterThan(0);
        expect(s.checkedAt, f.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
      for (const u of [f.website, ...Object.values(f.links ?? {})].filter(Boolean) as string[]) expect(u, f.id).toMatch(/^https:\/\//);
      expect(cityById(f.cityId), f.id).not.toBeNull();
    }
  });

  it("references only registry courts and benches", () => {
    for (const f of FORUMS) {
      if (f.courtId) expect(courtById(f.courtId), `${f.id} court`).not.toBeNull();
      if (f.benchId) expect(courtById(f.courtId)!.benches.some((b) => b.id === f.benchId), `${f.id} bench`).toBe(true);
      if (f.kind === "high_court" || f.kind === "bench") expect(f.benchId, f.id).toBeTruthy();
    }
    for (const c of CITIES) {
      const court = courtById(c.highCourt.courtId);
      expect(court, c.id).not.toBeNull();
      expect(court!.benches.some((b) => b.id === c.highCourt.benchId), c.id).toBe(true);
    }
    // Bench ids are unique across the registry.
    const benchIds = COURTS.flatMap((c) => c.benches.map((b) => b.id));
    expect(new Set(benchIds).size).toBe(benchIds.length);
  });

  it("gives every city a High Court seat or bench entry, first in its forum list", () => {
    for (const c of CITIES) {
      const hc = highCourtForumFor(c.id);
      expect(hc, c.id).not.toBeNull();
      expect(forumsForCity(c.id)[0].id, c.id).toBe(hc!.id);
    }
    // Gurugram's matters go to the Chandigarh seat, which sits in another city.
    expect(highCourtForumFor("gurugram")!.cityId).toBe("chandigarh");
    expect(forumsForCity("gurugram").some((f) => f.id === "gurugram-district")).toBe(true);
  });

  it("resolves cities by id, name or alias only, never the nearest", () => {
    expect(findCity("Bangalore")?.id).toBe("bengaluru");
    expect(findCity("gurgaon")?.id).toBe("gurugram");
    expect(findCity("Ernakulam")?.id).toBe("kochi");
    expect(findCity("Bengalur")).toBeNull();
    expect(findCity("")).toBeNull();
    expect(forumsForCity("atlantis")).toEqual([]);
  });

  it("finds the forum record for a stored court id", () => {
    expect(forumRecordForCourt("hc-karnataka")?.id).toBe("bengaluru-hc");
    expect(forumRecordForCourt("hc-allahabad", "all-lucknow")?.id).toBe("lucknow-hc");
    expect(forumRecordForCourt("ka-blr-commercial")?.id).toBe("ka-blr-commercial");
    expect(forumRecordForCourt("hc-karnatak")).toBeNull();
    expect(forumById("nope")).toBeNull();
  });

  it("keeps local-law pointers as distinct exact titles with a jurisdiction", () => {
    for (const [state, ptrs] of Object.entries(LOCAL_LAW)) {
      const norm = ptrs!.map((p) => normaliseActTitle(p.title));
      expect(new Set(norm).size, state).toBe(norm.length);
      for (const p of ptrs!) {
        if (p.jurisdiction === "state") expect(p.stateCode, p.title).toBeTruthy();
        if (p.source) expect(p.source.url).toMatch(/^https:\/\//);
      }
    }
    for (const c of CITIES) expect(LOCAL_LAW[c.state]?.length ?? 0, c.id).toBeGreaterThan(0);
    expect(normaliseActTitle("The KARNATAKA RENT ACT, 1999")).toBe(normaliseActTitle("Karnataka Rent Act 1999"));
    expect(normaliseActTitle("The Karnataka Rent Act, 1999")).not.toBe(normaliseActTitle("The Karnataka Rent Control Act, 1999"));
  });

  it("points India Code browse sources at indiacode.gov.in and never at a renumbered indiacode.nic.in browse handle", () => {
    expect(INDIA_CODE_HOME).toBe("https://indiacode.gov.in/");
    const sources = Object.values(LOCAL_LAW).flatMap((ptrs) => ptrs!.flatMap((p) => (p.source ? [{ ...p.source, act: p.title }] : [])));
    const indiaCode = sources.filter((s) => /indiacode\.(gov|nic)\.in/.test(s.url));
    expect(indiaCode.length).toBeGreaterThan(0);
    for (const s of indiaCode) expect(s.url, s.act).not.toMatch(/indiacode\.nic\.in\/handle\/\d+\/\d+\/browse/);
    const browse = indiaCode.filter((s) => s.url.startsWith("https://indiacode.gov.in/collections/"));
    // Karnataka (rent, stamp) and Maharashtra (rent) browse pages moved to the new site's State collections.
    expect(browse.map((s) => s.act).sort()).toEqual(["The Karnataka Rent Act, 1999", "The Karnataka Stamp Act, 1957", "The Maharashtra Rent Control Act, 1999"]);
    for (const s of browse) {
      expect(s.url).toMatch(/^https:\/\/indiacode\.gov\.in\/collections\/[0-9a-f-]{36}\?/);
      expect(s.checkedAt).toBe(INDIA_CODE_CHECKED_AT);
      expect(s.title).toMatch(/^India Code: (Karnataka|Maharashtra) State legislation/);
    }
  });
});
