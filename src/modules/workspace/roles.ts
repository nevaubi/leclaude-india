/**
 * Firm roles offered at setup and in team settings. Client-safe: constants and pure helpers only.
 *
 * A firm role maps to the stored `Person.role` plus a default title. Platform authorization roles are derived
 * from the person record by `rolesForPerson()` (src/lib/auth/principal.ts), so the title must stay consistent
 * with the chosen firm role; the server enforces that with `titleForRole()`.
 */
import type { Person } from "@/lib/types/domain";

export const FIRM_ROLES = ["Partner", "Associate", "Paralegal", "Litigation support", "Admin"] as const;
export type FirmRole = (typeof FIRM_ROLES)[number];

export const FIRM_ROLE_PERSON: Record<FirmRole, { role: Person["role"]; title: string }> = {
  Partner: { role: "attorney", title: "Partner" },
  Associate: { role: "attorney", title: "Associate" },
  Paralegal: { role: "paralegal", title: "Paralegal" },
  "Litigation support": { role: "staff", title: "Litigation support" },
  Admin: { role: "staff", title: "Administrator" },
};

export function isFirmRole(v: unknown): v is FirmRole {
  return typeof v === "string" && (FIRM_ROLES as readonly string[]).includes(v);
}

/** Person roles that make someone a firm team member (as opposed to custodians, witnesses, clients). */
export const TEAM_PERSON_ROLES: readonly Person["role"][] = ["attorney", "paralegal", "staff"];

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Team member view returned by /api/people and /api/workspace. */
export interface TeamMember {
  id: string;
  name: string;
  email?: string;
  title?: string;
  firmRole: FirmRole | null;
  firmId?: string;
  firmName?: string;
  matterScope?: "*" | string[];
  platformAdmin?: boolean;
  active: boolean;
  owner: boolean;
  deactivatedAt?: string;
  createdAt?: string;
  updatedAt?: string;
  /** Whether the member has a sign-in password (returned to workspace managers only). */
  hasPassword?: boolean;
}

export interface WorkspaceView {
  configured: boolean;
  firmName: string;
  owner: TeamMember | null;
}
