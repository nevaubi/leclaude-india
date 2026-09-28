import { describe, expect, it } from "vitest";
import { ALL_ACTIONS, ALL_ROLES, authorize, firstAccessibleMatter, hasMatterAccess, OBLIGATION_LOG_EXPORT, OBLIGATION_REDACT_PRIVILEGED, partitionByPolicy, resourceMatterId } from "@/lib/auth/policy";
import type { Action, Principal, ResourceRef, Role } from "@/lib/auth/types";

/**
 * The authorization matrix (constitution §22): principal ∩ tenant ∩ role ∩ matter ∩ sensitivity ∩ action.
 * Expectations are literal tables, not a re-implementation of the policy.
 */
const TENANT = "default";
const MATTER = "m_afff_2873";
const OTHER = "m_northgate_v_apex";

function P(roles: Role[], matterIds: Principal["matterIds"] = "*", extra: Partial<Principal> = {}): Principal {
  return { id: `u_${roles.join("_")}`, name: roles.join("+"), tenantId: TENANT, roles, matterIds, source: "header", ...extra };
}

const DOC: ResourceRef = { kind: "document", id: "ed_1", matterId: MATTER };
const SETTINGS: ResourceRef = { kind: "settings" };

/** Roles allowed per action on a normal matter document, for a principal that is a member of the matter. */
const MATTER_MATRIX: Record<Action, Role[]> = {
  read: ["partner", "associate", "paralegal", "litigation_support", "reviewer", "admin", "client_guest", "service"],
  write: ["partner", "associate", "paralegal", "litigation_support", "reviewer", "service"],
  code: ["partner", "associate", "paralegal", "litigation_support", "reviewer", "service"],
  produce: ["partner", "associate", "admin", "litigation_support", "service"],
  export: ["partner", "associate", "admin", "litigation_support", "service"],
  download: ["partner", "associate", "admin", "service"],
  delete: ["partner", "associate", "admin", "service"],
  approve: ["partner", "associate", "reviewer", "admin"],
  run: ["partner", "associate", "paralegal", "litigation_support", "reviewer", "admin", "service"],
  admin: ["partner", "admin", "service"],
};

/** Roles allowed per action on a firm-wide (non-matter) resource. Client guests never reach firm-wide resources. */
const FIRM_MATRIX: Record<Action, Role[]> = {
  read: ["partner", "associate", "paralegal", "litigation_support", "reviewer", "admin", "service"],
  write: ["partner", "associate", "paralegal", "litigation_support", "reviewer", "admin", "service"],
  code: ["partner", "associate", "paralegal", "litigation_support", "reviewer", "admin", "service"],
  produce: ["partner", "associate", "admin", "service"],
  export: ["partner", "associate", "admin", "service"],
  download: ["partner", "associate", "admin", "service"],
  delete: ["partner", "associate", "admin", "service"],
  approve: ["partner", "associate", "reviewer", "admin"],
  run: ["partner", "associate", "paralegal", "litigation_support", "reviewer", "admin", "service"],
  admin: ["partner", "admin", "service"],
};

describe("authorize: role × action matrix", () => {
  const cases: { role: Role; action: Action; matter: boolean; expected: boolean }[] = [];
  for (const role of ALL_ROLES) for (const action of ALL_ACTIONS) {
    cases.push({ role, action, matter: true, expected: MATTER_MATRIX[action].includes(role) });
    cases.push({ role, action, matter: false, expected: FIRM_MATRIX[action].includes(role) });
  }
  it.each(cases)("$role may $action (matter resource: $matter) → $expected", ({ role, action, matter, expected }) => {
    const principal = P([role], [MATTER]);
    const d = authorize({ principal, action, resource: matter ? DOC : SETTINGS });
    expect(d.allow, d.reason).toBe(expected);
    expect(d.reason.length).toBeGreaterThan(0);
  });

  it("every denial carries a reason and every export-like allow carries the log obligation", () => {
    for (const role of ALL_ROLES) for (const action of ALL_ACTIONS) {
      const d = authorize({ principal: P([role], [MATTER]), action, resource: DOC });
      if (!d.allow) expect(d.reason).toMatch(/may not|no access|guest|approve/);
      if (d.allow && ["produce", "export", "download"].includes(action)) expect(d.obligations).toContain(OBLIGATION_LOG_EXPORT);
      if (d.allow && !["produce", "export", "download"].includes(action)) expect(d.obligations ?? []).not.toContain(OBLIGATION_LOG_EXPORT);
    }
  });
});

describe("authorize: tenant, matter and principal validity", () => {
  it("denies a tenant mismatch before anything else", () => {
    const d = authorize({ principal: P(["partner"]), action: "read", resource: { ...DOC, tenantId: "other-firm" } });
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/tenant mismatch/);
  });
  it("denies non-members of a matter for every role and action, including partners with an explicit list", () => {
    for (const role of ALL_ROLES) for (const action of ALL_ACTIONS) {
      const d = authorize({ principal: P([role], [OTHER]), action, resource: DOC });
      expect(d.allow, `${role} ${action}`).toBe(false);
      expect(d.reason).toMatch(/no access to matter|guest/);
    }
  });
  it("treats a matter resource by its own id", () => {
    expect(resourceMatterId({ kind: "matter", id: MATTER })).toBe(MATTER);
    expect(authorize({ principal: P(["associate"], [OTHER]), action: "read", resource: { kind: "matter", id: MATTER } }).allow).toBe(false);
    expect(authorize({ principal: P(["associate"], [MATTER]), action: "read", resource: { kind: "matter", id: MATTER } }).allow).toBe(true);
  });
  it("denies a principal with no roles, no id or an expired session", () => {
    expect(authorize({ principal: P([]), action: "read", resource: DOC }).reason).toMatch(/no roles/);
    expect(authorize({ principal: { ...P(["partner"]), id: "" }, action: "read", resource: DOC }).reason).toMatch(/no authenticated principal/);
    const expired = P(["partner"], "*", { expiresAt: "2020-01-01T00:00:00.000Z" });
    expect(authorize({ principal: expired, action: "read", resource: DOC, environment: { at: "2021-01-01T00:00:00.000Z" } }).reason).toMatch(/expired/);
    expect(authorize({ principal: expired, action: "read", resource: DOC, environment: { at: "2019-01-01T00:00:00.000Z" } }).allow).toBe(true);
  });
  it("rejects unknown actions and missing resources", () => {
    expect(authorize({ principal: P(["partner"]), action: "fly" as Action, resource: DOC }).allow).toBe(false);
    expect(authorize({ principal: P(["partner"]), action: "read", resource: undefined as unknown as ResourceRef }).allow).toBe(false);
  });
});

describe("authorize: client guests", () => {
  it("read explicitly shared matters only", () => {
    expect(authorize({ principal: P(["client_guest"], [MATTER]), action: "read", resource: DOC }).allow).toBe(true);
    expect(authorize({ principal: P(["client_guest"], [OTHER]), action: "read", resource: DOC }).allow).toBe(false);
    const wildcard = authorize({ principal: P(["client_guest"], "*"), action: "read", resource: DOC });
    expect(wildcard.allow).toBe(false);
    expect(wildcard.reason).toMatch(/explicitly shared/);
    expect(hasMatterAccess(P(["client_guest"], "*"), MATTER)).toBe(false);
  });
  it("never reach firm-wide resources, privileged material or any non-read action", () => {
    expect(authorize({ principal: P(["client_guest"], [MATTER]), action: "read", resource: SETTINGS }).allow).toBe(false);
    expect(authorize({ principal: P(["client_guest"], [MATTER]), action: "read", resource: { ...DOC, sensitivity: "privileged" } }).allow).toBe(false);
    for (const action of ALL_ACTIONS.filter((a) => a !== "read")) expect(authorize({ principal: P(["client_guest"], [MATTER]), action, resource: DOC }).allow).toBe(false);
  });
  it("a guest who also holds a firm role gets the firm role's rights", () => {
    expect(authorize({ principal: P(["client_guest", "associate"], [MATTER]), action: "write", resource: DOC }).allow).toBe(true);
  });
});

describe("authorize: sensitivity", () => {
  const PRIV: ResourceRef = { ...DOC, sensitivity: "privileged" };
  const RESTRICTED: ResourceRef = { ...DOC, sensitivity: "restricted" };
  it.each<[Role, boolean]>([["partner", true], ["associate", true], ["admin", true], ["reviewer", true], ["service", true], ["litigation_support", false], ["client_guest", false]])("privileged read by %s → %s", (role, expected) => {
    const d = authorize({ principal: P([role], [MATTER]), action: "read", resource: PRIV });
    expect(d.allow).toBe(expected);
    if (expected) expect(d.obligations ?? []).not.toContain(OBLIGATION_REDACT_PRIVILEGED);
  });
  it("lets a paralegal read privileged material only under the redaction obligation, and never export or edit it", () => {
    const read = authorize({ principal: P(["paralegal"], [MATTER]), action: "read", resource: PRIV });
    expect(read.allow).toBe(true);
    expect(read.obligations).toContain(OBLIGATION_REDACT_PRIVILEGED);
    for (const action of ["write", "export", "download", "produce", "delete"] as Action[]) {
      const d = authorize({ principal: P(["paralegal"], [MATTER]), action, resource: PRIV });
      expect(d.allow, action).toBe(false);
      expect(d.reason).toMatch(/privileged/);
    }
  });
  it("litigation support may produce a normal document but never a privileged one", () => {
    expect(authorize({ principal: P(["litigation_support"], [MATTER]), action: "export", resource: DOC }).allow).toBe(true);
    const d = authorize({ principal: P(["litigation_support"], [MATTER]), action: "export", resource: PRIV });
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/privileged/);
    expect(authorize({ principal: P(["litigation_support"], [MATTER]), action: "export", resource: { kind: "research", matterId: MATTER } }).allow).toBe(false);
  });
  it.each<[Role, boolean]>([["partner", true], ["admin", true], ["service", true], ["associate", false], ["reviewer", false], ["paralegal", false], ["litigation_support", false]])("restricted read by %s → %s", (role, expected) => {
    expect(authorize({ principal: P([role], [MATTER]), action: "read", resource: RESTRICTED }).allow).toBe(expected);
  });
});

describe("authorize: service principals", () => {
  it("may do everything within the tenant except approve", () => {
    for (const action of ALL_ACTIONS) {
      const d = authorize({ principal: P(["service"]), action, resource: DOC });
      expect(d.allow, action).toBe(action !== "approve");
    }
    expect(authorize({ principal: P(["service"]), action: "read", resource: { ...DOC, tenantId: "other" } }).allow).toBe(false);
    expect(authorize({ principal: P(["service"]), action: "approve", resource: DOC }).reason).toMatch(/human control boundary/);
  });
});

describe("helpers", () => {
  it("firstAccessibleMatter prefers an accessible matter and otherwise returns the first (so the policy denies)", () => {
    const p = P(["associate"], [OTHER]);
    expect(firstAccessibleMatter(p, [MATTER, OTHER])).toBe(OTHER);
    expect(firstAccessibleMatter(p, [MATTER])).toBe(MATTER);
    expect(firstAccessibleMatter(p, [])).toBeUndefined();
    expect(firstAccessibleMatter(p, undefined)).toBeUndefined();
  });
  it("partitionByPolicy keeps denied records with their reasons instead of silently dropping them", () => {
    const docs = [
      { id: "a", matterId: MATTER, privileged: false },
      { id: "b", matterId: MATTER, privileged: true },
      { id: "c", matterId: OTHER, privileged: false },
    ];
    const part = partitionByPolicy(P(["litigation_support"], [MATTER]), "export", docs, (d) => ({ kind: "document", id: d.id, matterId: d.matterId, sensitivity: d.privileged ? "privileged" : "normal" }));
    expect(part.allowed.map((x) => x.item.id)).toEqual(["a"]);
    expect(part.denied.map((x) => x.item.id)).toEqual(["b", "c"]);
    expect(part.denied[0].decision.reason).toMatch(/privileged/);
    expect(part.denied[1].decision.reason).toMatch(/no access to matter/);
  });
});
