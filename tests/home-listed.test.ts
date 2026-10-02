import { beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.LECLAUDE_DATA_DIR = `${process.env.VITEST_DATA_DIR || process.env.TMPDIR || "/tmp"}/home-listed-vitest-${process.pid}`;
  process.env.LECLAUDE_SEED = "reference";
  process.env.LECLAUDE_BACKGROUND = "off";
  process.env.WORKFLOW_SCHEDULER_DISABLED = "1";
  process.env.INTEL_OFFLINE = "1";
  delete process.env.AUTH_MODE;
  delete process.env.LECLAUDE_USER_ID;
});

import { db, resetSqlite } from "@/lib/db";
import { setWorkspaceUser } from "@/lib/current-user";
import { setupWorkspace } from "@/modules/workspace/service";
import { createMatter } from "@/modules/matters/service";
import { listMattersLite, loadHomeInitialData, nextHearingOf } from "@/modules/home/service";
import type { Principal } from "@/lib/auth/types";
import { listedSoonEntries, particularsEntries } from "@/modules/home/components/listed-soon-model";
import type { MatterLite } from "@/modules/home/types";
import type { DiaryEntry } from "@/modules/matters/desk/types";

const lite = (over: Partial<MatterLite> & { id: string }): MatterLite => ({ shortName: over.id, name: over.id, client: "", practiceArea: "Litigation", status: "active", teamIds: [], keyDates: [], ...over });

describe("MatterLite.nextHearing", () => {
  beforeAll(() => {
    resetSqlite();
    setWorkspaceUser(null);
    db();
    setupWorkspace({ firmName: "Iyer Chambers", name: "Kavya Iyer", email: "kiyer@iyer.in", role: "Partner" });
  });

  it("comes from matter.india only when recorded, with the item only when it was listed for that date", () => {
    createMatter({ name: "With hearing", practiceArea: "Litigation", india: { courtId: "hc-karnataka", nextHearing: "2026-10-05", hearingPurpose: "Arguments", courtHall: "CH-12", causeList: { status: "listed", item: 14, listDate: "2026-10-05" } } });
    createMatter({ name: "Without hearing", practiceArea: "Litigation" });
    const byName = new Map(listMattersLite().map((m) => [m.name, m]));
    expect(byName.get("With hearing")?.nextHearing).toEqual({ date: "2026-10-05", purpose: "Arguments", courtHall: "CH-12", item: 14 });
    expect(byName.get("Without hearing")).not.toHaveProperty("nextHearing");
    expect(nextHearingOf({ nextHearing: "2026-10-05", causeList: { status: "listed", item: 3, listDate: "2026-10-01" } })).toEqual({ date: "2026-10-05" });
    expect(nextHearingOf({ nextHearing: "05-10-2026" })).toBeUndefined();
    expect(nextHearingOf(undefined)).toBeUndefined();
  });

  it("lists only the matters the principal may read, and none without a principal", () => {
    const mine = createMatter({ name: "Scoped mine", practiceArea: "Litigation", india: { courtId: "hc-karnataka", nextHearing: "2026-10-06" } }).id;
    createMatter({ name: "Scoped theirs", practiceArea: "Litigation", india: { courtId: "hc-karnataka", nextHearing: "2026-10-06" } });
    const associate: Principal = { id: "u_assoc", name: "Associate", tenantId: "t_default", roles: ["associate"], matterIds: [mine], source: "header" };
    expect(listMattersLite(associate).map((m) => m.id)).toEqual([mine]);
    expect(loadHomeInitialData({ aiConfigured: false, principal: associate }).matters.map((m) => m.name)).toEqual(["Scoped mine"]);
    expect(listMattersLite(null)).toEqual([]);
    expect(loadHomeInitialData({ aiConfigured: false, principal: null }).matters).toEqual([]);
    const guest: Principal = { ...associate, id: "u_guest", roles: ["client_guest"], matterIds: "*" };
    expect(listMattersLite(guest)).toEqual([]);
    // Dev mode (no request context): the ambient demo persona with tenant-wide access.
    expect(listMattersLite().map((m) => m.name)).toEqual(expect.arrayContaining(["Scoped mine", "Scoped theirs"]));
  });
});

describe("Listed today and tomorrow", () => {
  const matters = [
    lite({ id: "m_a", shortName: "Alpha", nextHearing: { date: "2026-10-03", purpose: "Mention" } }),
    lite({ id: "m_b", shortName: "Beta", nextHearing: { date: "2026-10-04" } }),
    lite({ id: "m_c", shortName: "Gamma", nextHearing: { date: "2026-10-05" } }),
    lite({ id: "m_d", shortName: "Delta" }),
  ];

  it("shows recorded hearings for today and tomorrow only", () => {
    expect(particularsEntries(matters, "2026-10-03").map((e) => [e.matterId, e.date])).toEqual([["m_a", "2026-10-03"], ["m_b", "2026-10-04"]]);
    expect(particularsEntries([], "2026-10-03")).toEqual([]);
  });

  it("uses the diary once it answered, nothing while loading or when denied, recorded hearings when it failed, and honours the matter filter", () => {
    const diary: DiaryEntry[] = [{ kind: "manual", id: "hr_1", matterId: "m_c", matterName: "Gamma", date: "2026-10-03", hearing: { id: "hr_1", matterId: "m_c", date: "2026-10-03", createdAt: "", createdBy: "" } }];
    expect(listedSoonEntries({ status: "loading", matters, today: "2026-10-03" })).toEqual([]); // nothing until the diary answers
    expect(listedSoonEntries({ status: "ready", diary, matters, today: "2026-10-03" }).map((e) => e.id)).toEqual(["hr_1"]);
    expect(listedSoonEntries({ status: "ready", diary: [], matters, today: "2026-10-03" })).toEqual([]);
    // Only today and tomorrow, even if a wider window came back.
    expect(listedSoonEntries({ status: "ready", diary: [...diary, { ...diary[0], id: "hr_9", date: "2026-10-09" }], matters, today: "2026-10-03" }).map((e) => e.id)).toEqual(["hr_1"]);
    expect(listedSoonEntries({ status: "denied", matters, today: "2026-10-03" })).toEqual([]);
    expect(listedSoonEntries({ status: "error", matters, today: "2026-10-03" }).map((e) => e.matterId)).toEqual(["m_a", "m_b"]);
    expect(listedSoonEntries({ status: "error", matters, today: "2026-10-03", matterFilter: "m_b" }).map((e) => e.matterId)).toEqual(["m_b"]);
  });
});
