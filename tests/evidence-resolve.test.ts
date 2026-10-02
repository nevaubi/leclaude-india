import { beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.LECLAUDE_DATA_DIR = `${process.env.TMPDIR || "/tmp"}/evidence-resolve-vitest-${process.pid}`;
  process.env.LECLAUDE_BACKGROUND = "off";
  process.env.WORKFLOW_SCHEDULER_DISABLED = "1";
  process.env.INTEL_OFFLINE = "1";
  process.env.OPENAI_API_KEY = "";
});

import { db, resetSqlite } from "@/lib/db";
import { MATTERS, PEOPLE } from "@/lib/seed/ids";
import type { MatterScope } from "@/lib/auth/types";
import type { Deposition } from "@/lib/types/domain";
import { checkCitations, resolveCitation, resolveCitationsIn, retryCitation } from "@/lib/evidence/resolve";
import { assertNoSubstitution, EvidenceSubstitutionError, resolvedRefs } from "@/lib/evidence/guard";

const VALSARA: MatterScope = { tenantId: "default", matterIds: [MATTERS.valsara] };
const NG: MatterScope = { tenantId: "default", matterIds: [MATTERS.northgate] };
const BOTH: MatterScope = { tenantId: "default", matterIds: [MATTERS.valsara, MATTERS.northgate] };
const EMPTY: MatterScope = { tenantId: "default", matterIds: [] };

beforeAll(() => { resetSqlite(); db(); });

describe("Bates resolution", () => {
  it("resolves a Bates number to exactly the document whose range contains it, with the page offset", () => {
    const doc = db().edocs.findOne((d) => d.bates === "MFC-0041877")!;
    const c = resolveCitation("MFC-0041877", VALSARA);
    expect(c.state).toBe("resolved");
    expect(c.locationValid).toBe(true);
    expect(c.ref).toMatchObject({ kind: "document", id: doc.id, matterId: MATTERS.valsara, bates: "MFC-0041877", page: 1, hash: doc.hash });
    const multi = db().edocs.find((d) => d.matterId === MATTERS.valsara && !!d.batesEnd)[0];
    const start = Number(multi.bates.split("-")[1]);
    const pin = `MFC-${String(start + 1).padStart(7, "0")}`;
    const inner = resolveCitation(pin, VALSARA);
    expect(inner.state).toBe("resolved");
    expect(inner.ref).toMatchObject({ id: multi.id, page: 2 });
    const range = resolveCitation(`${multi.bates} – ${multi.batesEnd}`, VALSARA);
    expect(range.state).toBe("resolved");
    expect(range.ref).toMatchObject({ id: multi.id, bates: multi.bates, batesEnd: multi.batesEnd });
  });
  it("leaves a Bates number that is not in the record unresolved and never maps it to another document", () => {
    const wrong = resolveCitation("MFC-9999999", VALSARA);
    expect(wrong.state).toBe("unresolved");
    expect(wrong.ref).toBeUndefined();
    expect(wrong.locationValid).toBe(false);
    expect(wrong.reason).toMatch(/outside every MFC document range/);
    const unknownPrefix = resolveCitation("ZZZ-0000001", VALSARA);
    expect(unknownPrefix.state).toBe("unresolved");
    expect(unknownPrefix.reason).toMatch(/not in the record/);
    const first = db().edocs.find((d) => d.matterId === MATTERS.valsara)[0];
    expect(() => assertNoSubstitution(wrong, { kind: "document", id: first.id, matterId: first.matterId })).toThrow(EvidenceSubstitutionError);
  });
  it("is confined to the scope: a Bates number from another matter is unresolved, and an empty scope resolves nothing", () => {
    expect(resolveCitation("MFC-0041877", NG).state).toBe("unresolved");
    expect(resolveCitation("MFC-0041877", NG).reason).toMatch(/not in the record for matter\(s\) m_northgate/);
    const empty = resolveCitation("MFC-0041877", EMPTY);
    expect(empty.state).toBe("unresolved");
    expect(empty.reason).toMatch(/empty matter scope/);
    expect(resolveCitation("MFC-0041877", BOTH).state).toBe("resolved");
  });
  it("excludes case-number lookalikes", () => {
    expect(resolveCitation("MDL-3140", VALSARA)).toMatchObject({ state: "excluded", reason: expect.stringMatching(/not a Bates prefix/) });
  });
  it("flags two documents sharing a range as requires_review with both candidates listed", () => {
    const doc = db().edocs.findOne((d) => d.bates === "MFC-0041877")!;
    const twin = { ...doc, id: "ed_test_twin", subject: "Twin of Vasudevan-1 (test)" };
    db().edocs.put(twin);
    try {
      const c = resolveCitation("MFC-0041877", VALSARA);
      expect(c.state).toBe("requires_review");
      expect(c.ref).toBeUndefined();
      expect(c.reason).toContain(doc.id);
      expect(c.reason).toContain("ed_test_twin");
    } finally {
      db().edocs.delete("ed_test_twin");
    }
  });
});

describe("deposition resolution", () => {
  it("resolves witness page:line cites with a valid location and rejects pages beyond the transcript", () => {
    const c = resolveCitation("Vasudevan Dep. 45:12–46:3", VALSARA);
    expect(c.state).toBe("resolved");
    expect(c.ref).toMatchObject({ kind: "deposition", id: "dep_vls_voss_v1", matterId: MATTERS.valsara, witness: "Hema Vasudevan", page: 45, line: 12 });
    const beyond = resolveCitation("Vasudevan Dep. 300:1", VALSARA);
    expect(beyond.state).toBe("unresolved");
    expect(beyond.locationValid).toBe(false);
    expect(beyond.reason).toMatch(/page 300 is not within/);
    expect(resolveCitation("Vasudevan Dep. 45:40", VALSARA).reason).toMatch(/line numbers/);
    expect(resolveCitation("Nobody Dep. 4:1", VALSARA).reason).toMatch(/no deposition of "Nobody"/);
  });
  it("a cite whose page exists in only one of a witness's volumes resolves there; one valid in several is requires_review", () => {
    // Seeded: Hegde vol. 1 (262 pages, reviewed) and vol. 2 (scheduled, no transcript).
    expect(resolveCitation("Hegde Dep. 45:12", VALSARA).ref?.id).toBe("dep_vls_hale_v1");
    expect(resolveCitation("Hegde Dep. Vol. 2, 45:12", VALSARA).state).toBe("unresolved");
    const v3: Deposition = { ...db().depositions.get("dep_vls_hale_v1")!, id: "dep_test_hale_v3", volume: 3, pages: 120, transcript: [], exhibits: [] };
    db().depositions.put(v3);
    try {
      const c = resolveCitation("Hegde Dep. 45:12", VALSARA);
      expect(c.state).toBe("requires_review");
      expect(c.reason).toContain("dep_vls_hale_v1");
      expect(c.reason).toContain("dep_test_hale_v3");
      expect(resolveCitation("Hegde Dep. Vol. 3, 45:12", VALSARA).ref?.id).toBe("dep_test_hale_v3");
      expect(resolveCitation("Hegde Dep. 200:1", VALSARA).ref?.id).toBe("dep_vls_hale_v1");
    } finally {
      db().depositions.delete("dep_test_hale_v3");
    }
  });
  it("needs explicit context for a bare page:line and never guesses the deposition", () => {
    expect(resolveCitation("45:12", VALSARA)).toMatchObject({ state: "unresolved", reason: expect.stringMatching(/names no witness/) });
    expect(resolveCitation("45:12", VALSARA, { defaultDepositionId: "dep_vls_voss_v1" }).ref?.id).toBe("dep_vls_voss_v1");
    expect(resolveCitation("45:12", NG, { defaultDepositionId: "dep_vls_voss_v1" }).state).toBe("unresolved");
  });
  it("cross-matter name collision: the same surname in two matters never binds across the scope", () => {
    const ng: Deposition = { id: "dep_test_ng_hale", matterId: MATTERS.northgate, witnessId: PEOPLE.girishHegde, witnessName: "Marcus Hegde", date: "2026-01-01", takenBy: "x", volume: 1, pages: 80, transcript: [], exhibits: [], status: "transcribed" };
    db().depositions.put(ng);
    try {
      expect(resolveCitation("Hegde Dep. 45:12", VALSARA).ref).toMatchObject({ id: "dep_vls_hale_v1", matterId: MATTERS.valsara });
      expect(resolveCitation("Hegde Dep. 45:12", NG).ref).toMatchObject({ id: "dep_test_ng_hale", matterId: MATTERS.northgate });
      const both = resolveCitation("Hegde Dep. 45:12", BOTH);
      expect(both.state).toBe("requires_review");
      expect(both.ref).toBeUndefined();
      expect(() => assertNoSubstitution(resolveCitation("Hegde Dep. 45:12", NG), { kind: "deposition", id: "dep_vls_hale_v1", matterId: MATTERS.valsara })).toThrow(EvidenceSubstitutionError);
    } finally {
      db().depositions.delete("dep_test_ng_hale");
    }
  });
});

describe("exhibit, docket and authority resolution", () => {
  it("resolves exhibits to the deposition that marked them and flags bare numbers shared across witnesses", () => {
    expect(resolveCitation("Exhibit Vasudevan-3", VALSARA).ref).toMatchObject({ kind: "deposition", id: "dep_vls_voss_v1", exhibit: "Vasudevan-3", bates: "MFC-0041884" });
    expect(resolveCitation("Vasudevan Ex. 3", VALSARA).ref?.exhibit).toBe("Vasudevan-3");
    const bare = resolveCitation("Ex. 3", VALSARA);
    expect(bare.state).toBe("requires_review");
    expect(bare.reason).toMatch(/exhibits match/);
    expect(resolveCitation("Ex. 3", VALSARA, { defaultDepositionId: "dep_vls_voss_v1" }).ref?.exhibit).toBe("Vasudevan-3");
    expect(resolveCitation("Exhibit Vasudevan-99", VALSARA).state).toBe("unresolved");
    expect(resolveCitation("Exhibit Vasudevan-3", NG).state).toBe("unresolved");
  });
  it("resolves docket entries within the matter and not outside it", () => {
    const entry = db().collection<{ id: string; kind: string; meta?: { entryNumber?: number }; matterIds?: string[] }>("intel_documents").findOne((d) => d.kind === "docket_entry" && typeof d.meta?.entryNumber === "number")!;
    const n = entry.meta!.entryNumber!;
    const scope: MatterScope = { tenantId: "default", matterIds: entry.matterIds ?? [] };
    expect(resolveCitation(`ECF No. ${n}`, scope).ref).toMatchObject({ kind: "docket_entry", id: entry.id });
    expect(resolveCitation(`ECF No. ${n}`, NG).state).toBe("unresolved");
    expect(resolveCitation("ECF No. 999999", scope).state).toBe("unresolved");
  });
  it("resolves reporter citations from the local authority record and leaves unknown authorities unresolved", () => {
    const DEPO: MatterScope = { tenantId: "default", matterIds: [MATTERS.depo] };
    const c = resolveCitation("555 U.S. 555", DEPO);
    expect(c.state).toBe("resolved");
    expect(c.ref).toMatchObject({ kind: expect.stringMatching(/opinion|library/), citation: "555 U.S. 555" });
    expect(resolveCitation("555 U. S. 555, 568", DEPO)).toMatchObject({ state: "resolved", ref: expect.objectContaining({ page: 568 }) });
    const unknown = resolveCitation("999 F.3d 1", VALSARA);
    expect(unknown.state).toBe("unresolved");
    expect(unknown.reason).toMatch(/not in the local record/);
  });
});

describe("checkCitations and retries", () => {
  it("counts every state separately and binds the check to the artifact hash", () => {
    const text = "Vasudevan conceded the point (Vasudevan Dep. 45:12) and the memo (MFC-0041877) confirms it; but MFC-9999999 and Ex. 3 are cited too, and MDL-3140 is the docket.";
    const check = checkCitations(text, VALSARA, "hash-1");
    expect(check.artifactHash).toBe("hash-1");
    expect(check.citations.map((c) => c.state)).toEqual(["resolved", "resolved", "unresolved", "requires_review", "excluded"]);
    expect(check).toMatchObject({ resolved: 2, unresolved: 1, requiresReview: 1, excluded: 1 });
    expect(resolvedRefs(check.citations).map((r) => r.id)).toEqual(["dep_vls_voss_v1", db().edocs.findOne((d) => d.bates === "MFC-0041877")!.id]);
    expect(resolveCitationsIn("nothing to cite here", VALSARA)).toEqual([]);
  });
  it("a retry that still finds nothing becomes retried, never resolved", () => {
    const first = resolveCitation("MFC-9999999", VALSARA);
    const again = retryCitation(first, VALSARA);
    expect(again.state).toBe("retried");
    expect(again.reason).toMatch(/^retried:/);
    expect(retryCitation(resolveCitation("MFC-0041877", VALSARA), VALSARA).state).toBe("resolved");
  });
});
