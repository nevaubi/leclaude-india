import { describe, expect, it } from "vitest";
import type { RemoteStore, Row, SqlQuery } from "@/lib/db/remote";
import type { LocalLawPointer } from "@/lib/india/forums";
import { resolveLocalLaw, resolveLocalLawForCity } from "@/modules/courts/local-law";

/** A fake corpus: returns every row whatever the SQL says, so the resolver's own exactness check is what is tested. */
function fakeStore(rows: Row[], seen: SqlQuery[] = []): RemoteStore {
  return {
    async query(q) { seen.push(q); return rows; },
    async transaction() { throw new Error("not used"); },
  };
}

const row = (o: Partial<Record<string, string | null>>): Row => ({ id: "x", title: "", jurisdiction: "state", state: null, state_code: null, year: null, status: null, source_url: null, ...o });

const KA_RENT: LocalLawPointer = { title: "The Karnataka Rent Act, 1999", topic: "rent", jurisdiction: "state", stateCode: "KA" };
const KA_STAMP: LocalLawPointer = { title: "The Karnataka Stamp Act, 1957", topic: "stamp", jurisdiction: "state", stateCode: "KA" };
const DL_RENT: LocalLawPointer = { title: "The Delhi Rent Control Act, 1958", topic: "rent", jurisdiction: "central" };

describe("local-law resolver", () => {
  it("resolves by exact normalised title within the pointer's State", async () => {
    const seen: SqlQuery[] = [];
    const store = fakeStore([
      row({ id: "IND_KA_1", title: "The KARNATAKA RENT ACT, 1999", state: "Karnataka", state_code: "KA", year: "2001", status: "in_force", source_url: "https://www.indiacode.nic.in/handle/123456789/1" }),
      row({ id: "IND_KA_2", title: "The Karnataka Rent Control Act, 1961", state: "Karnataka", state_code: "KA" }),
    ], seen);
    const r = await resolveLocalLaw([KA_RENT], store);
    expect(r.configured).toBe(true);
    expect(r.items[0]).toMatchObject({ status: "resolved", acts: [{ id: "IND_KA_1", year: 2001, status: "in_force" }] });
    expect(seen[0].query).toContain("law_instruments");
    expect(seen[0].params).toEqual(expect.arrayContaining(["karnataka rent act 1999", "KA"]));
  });

  it("reports not found and never maps a similar Act or another State's Act", async () => {
    const store = fakeStore([
      row({ id: "IND_KA_2", title: "The Karnataka Stamp (Amendment) Act, 1957", state_code: "KA" }),
      row({ id: "IND_TS_9", title: "The Karnataka Rent Act, 1999", state: "Telangana", state_code: "TS" }),
      row({ id: "IND_C_1", title: "The Karnataka Rent Act, 1999", jurisdiction: "central" }),
    ]);
    const r = await resolveLocalLaw([KA_RENT, KA_STAMP], store);
    expect(r.items.map((i) => i.status)).toEqual(["not_found", "not_found"]);
    expect(r.items.every((i) => i.acts.length === 0)).toBe(true);
  });

  it("matches central pointers only against central legislation and flags duplicates as ambiguous", async () => {
    const store = fakeStore([
      row({ id: "IND_central_1", title: "The Delhi Rent Control Act, 1958", jurisdiction: "central" }),
      row({ id: "IND_DL_1", title: "The Delhi Rent Control Act, 1958", jurisdiction: "state", state_code: "DL" }),
      row({ id: "IND_KA_1", title: "Karnataka Rent Act 1999", state_code: "KA" }),
      row({ id: "IND_KA_1b", title: "THE KARNATAKA RENT ACT, 1999", state: "Karnataka", state_code: null }),
    ]);
    const r = await resolveLocalLaw([DL_RENT, KA_RENT], store);
    expect(r.items[0]).toMatchObject({ status: "resolved", acts: [{ id: "IND_central_1" }] });
    expect(r.items[1].status).toBe("ambiguous");
    expect(r.items[1].acts.map((a) => a.id)).toEqual(["IND_KA_1", "IND_KA_1b"]);
  });

  it("returns unavailable (not 'not found') when no corpus is configured or the query fails", async () => {
    const off = await resolveLocalLaw([KA_RENT], null);
    expect(off).toMatchObject({ configured: false, items: [{ status: "unavailable", acts: [] }] });
    const failing: RemoteStore = { async query() { throw new Error('Database error: relation "law_instruments" does not exist'); }, async transaction() { return []; } };
    const err = await resolveLocalLaw([KA_RENT], failing);
    expect(err).toMatchObject({ configured: true, error: "The law corpus has not been loaded.", items: [{ status: "unavailable" }] });
  });

  it("resolves a city's State pointers (Chandigarh uses Punjab Acts) and handles unknown cities", async () => {
    const seen: SqlQuery[] = [];
    const r = await resolveLocalLawForCity("chandigarh", fakeStore([], seen));
    expect(r.state).toBe("CH");
    expect(r.items.length).toBeGreaterThan(0);
    expect(seen[0].params).toContain("PB");
    const none = await resolveLocalLawForCity("atlantis", fakeStore([]));
    expect(none).toMatchObject({ state: null, items: [] });
  });
});
