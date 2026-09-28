/**
 * Demo team: two fictional members who join the workspace owner — a junior advocate (Bengaluru) and a law clerk
 * (Hyderabad). The e-discovery half writes the matters' witnesses, officers and record sources.
 */
import type { PersonRecord } from "@/modules/workspace/service";
import { DEMO_TEAM } from "../ids";
import { demoMeta, type DemoBuildContext } from "./context";

/** Stored person plus the demo tag (Person itself has no meta; the extra field is ignored by other modules). */
export type DemoPerson = PersonRecord & { meta?: Record<string, unknown> };

export const DEMO_TEAM_PROFILES = {
  junior: { id: DEMO_TEAM.junior, name: "Kavya Hegde", local: "kavya.hegde", title: "Junior Advocate", role: "attorney" as const, firmRole: "Associate" as const, tags: ["commercial suits", "Bengaluru", "Kannada"] },
  clerk: { id: DEMO_TEAM.clerk, name: "Sai Kiran Reddy", local: "saikiran.reddy", title: "Law Clerk", role: "paralegal" as const, firmRole: "Paralegal" as const, tags: ["High Court filings", "Hyderabad", "Telugu"] },
};

/** The two demo team members. `takenEmails` avoids colliding with real members. */
export function buildDemoTeam(ctx: DemoBuildContext, takenEmails: ReadonlySet<string> = new Set()): DemoPerson[] {
  const created = ctx.now.toISOString();
  return Object.values(DEMO_TEAM_PROFILES).map((p) => {
    let email = `${p.local}@${ctx.emailDomain}`;
    if (takenEmails.has(email)) email = `${p.local}.demo@${ctx.emailDomain}`;
    return { id: p.id, name: p.name, email, title: p.title, organization: ctx.firmName, role: p.role, firmRole: p.firmRole, active: true, tags: p.tags, createdAt: created, updatedAt: created, meta: demoMeta() };
  });
}
