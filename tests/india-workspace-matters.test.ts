import { beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.LECLAUDE_DATA_DIR = `${process.env.VITEST_DATA_DIR || process.env.TMPDIR || "/tmp"}/india-matters-vitest-${process.pid}`;
  process.env.LECLAUDE_SEED = "reference";
  process.env.LECLAUDE_BACKGROUND = "off";
  process.env.WORKFLOW_SCHEDULER_DISABLED = "1";
  process.env.INTEL_OFFLINE = "1";
  delete process.env.AUTH_MODE;
});

import { db, resetSqlite } from "@/lib/db";
import { setWorkspaceUser } from "@/lib/current-user";
import { runWithPrincipal } from "@/lib/auth/context";
import { devPrincipal } from "@/lib/auth/principal";
import { setupWorkspace } from "@/modules/workspace/service";
import { createMatter, listMatters, updateMatter } from "@/modules/matters/service";

beforeAll(() => {
  resetSqlite();
  setWorkspaceUser(null);
  db();
  setupWorkspace({ firmName: "Demo Chambers", name: "Owner Advocate", email: "owner@chambers.example", role: "Partner" });
});

const asOwner = <T,>(fn: () => T) => runWithPrincipal(devPrincipal(), fn);

describe("matters with Indian case particulars", () => {
  it("stores court, bench, case number, CNR, hearing and cause-list status; derives the court and caption", () => {
    const m = asOwner(() => createMatter({ name: "Asha Rao v. State of Karnataka", practiceArea: "Litigation", clientSide: "petitioner", india: { courtId: "hc-karnataka", benchId: "kar-dharwad", caseType: "wp", caseNumber: "018234", caseYear: 2024, cnr: "kahc-0101-8234-2024", nextHearing: "2026-10-12", causeList: { status: "listed", item: 14 } } }));
    expect(m.india).toMatchObject({ courtId: "hc-karnataka", benchId: "kar-dharwad", caseNumber: "18234", caseYear: 2024, cnr: "KAHC010182342024", nextHearing: "2026-10-12", causeList: { status: "listed", item: 14, source: "manual" } });
    expect(m.india!.caseType).toBe("W.P."); // registry alias table, not a guess
    const unknown = asOwner(() => createMatter({ name: "Unknown type", practiceArea: "Litigation", india: { courtId: "hc-karnataka", caseType: "XYZ.P.", caseNumber: "5", caseYear: 2025 } }));
    expect(unknown.india!.caseType).toBe("XYZ.P."); // unknown labels are kept as typed
    expect(m.court).toBe("High Court of Karnataka");
    expect(m.caption).toBe("W.P. No. 18234 of 2024");
    const typed = asOwner(() => createMatter({ name: "Nimbus v. Tungabhadra", practiceArea: "Commercial", india: { courtId: "ka-blr-commercial", caseType: "com.o.s.", caseNumber: "1187", caseYear: 2023 } }));
    expect(typed.india!.caseType).toBe("Com.O.S.");
    expect(typed.caption).toBe("Com.O.S. No. 1187 of 2023");
    // Search finds a matter by CNR and by case number.
    expect(asOwner(() => listMatters({ q: "KAHC01018234" })).map((x) => x.id)).toEqual([m.id]);
    expect(asOwner(() => listMatters({ q: "Com.O.S. No. 1187" })).map((x) => x.id)).toEqual([typed.id]);
  });

  it("rejects an unknown court, a bench of another court, a malformed CNR and bad dates — never substituting", () => {
    const bad = (india: Record<string, unknown>) => { try { asOwner(() => createMatter({ name: `Bad ${JSON.stringify(india)}`, practiceArea: "Litigation", india } as never)); return null; } catch (e) { return (e as { status?: number; fields?: Record<string, string> }); } };
    expect(bad({ courtId: "hc-karnatak" })).toMatchObject({ status: 422, fields: { "india.courtId": expect.stringContaining("Unknown court") } });
    expect(bad({ courtId: "hc-telangana", benchId: "kar-dharwad" })).toMatchObject({ status: 422, fields: { "india.benchId": expect.any(String) } });
    expect(bad({ courtId: "hc-telangana", cnr: "HBHC0101" })).toMatchObject({ status: 422, fields: { "india.cnr": expect.any(String) } });
    expect(bad({ nextHearing: "12.10.2026" })).toMatchObject({ status: 422, fields: { "india.nextHearing": expect.any(String) } });
    expect(bad({ caseNumber: "W.P. 12" })).toMatchObject({ status: 422 });
    expect(bad({ causeList: { status: "maybe" } })).toMatchObject({ status: 422 });
  });

  it("updates and clears the particulars", () => {
    const m = asOwner(() => createMatter({ name: "Ravi Teja bail", practiceArea: "Litigation", india: { courtId: "hc-telangana", caseType: "Crl.P.", caseNumber: "7710", caseYear: 2026, offenceDate: "2026-08-12" } }));
    const u = asOwner(() => updateMatter(m.id, { india: { ...m.india, causeList: { status: "adjourned" }, nextHearing: "2026-10-20" } }));
    expect(u.india).toMatchObject({ offenceDate: "2026-08-12", nextHearing: "2026-10-20", causeList: { status: "adjourned" } });
    const cleared = asOwner(() => updateMatter(m.id, { india: null }));
    expect(cleared.india).toBeUndefined();
  });
});
