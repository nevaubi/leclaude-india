import "server-only";
import { db } from "@/lib/db";
import type { Person } from "@/lib/types/domain";
import { hashPassword } from "./password";

/**
 * Workspace sign-in accounts. A credential belongs to a firm team member (people collection, role attorney /
 * paralegal / staff, active) and is stored in its own module-private collection, keyed by the person id, so no
 * people listing, export or search can ever carry a password hash. It syncs to Postgres like every other
 * collection (src/lib/db/sync.ts), which makes it durable and shared across serverless instances.
 *
 * `sessionVersion` is embedded in each session token (`sv`); setting a new password bumps it, which revokes every
 * session issued before the change.
 */
export const CREDENTIALS_COLLECTION = "auth_credentials";

export interface CredentialRecord {
  /** The person id. */
  id: string;
  /** scrypt string from password.ts; never returned by any API. */
  hash: string;
  sessionVersion: number;
  createdAt: string;
  updatedAt: string;
  /** Who set it: the person themself, an administrator's id, or "bootstrap". */
  setBy?: string;
}

const TEAM_ROLES: readonly Person["role"][] = ["attorney", "paralegal", "staff"];

export type TeamPerson = Person & { active?: boolean };

function creds() {
  return db().collection<CredentialRecord>(CREDENTIALS_COLLECTION);
}

export function isActiveTeamPerson(p: TeamPerson | null | undefined): p is TeamPerson {
  return !!p && TEAM_ROLES.includes(p.role) && p.active !== false;
}

/** An active firm team member by id, or null (custodians, witnesses, clients and deactivated members never sign in). */
export function activeMember(id: string): TeamPerson | null {
  const p = db().collection<TeamPerson>("people").get(id);
  return isActiveTeamPerson(p) ? p : null;
}

/** The active team member with this email (case-insensitive), or null. */
export function activeMemberByEmail(email: string): TeamPerson | null {
  const e = email.trim().toLowerCase();
  if (!e) return null;
  return db().collection<TeamPerson>("people").findOne((p) => isActiveTeamPerson(p) && p.email?.trim().toLowerCase() === e);
}

export function getCredential(personId: string): CredentialRecord | null {
  return creds().get(personId);
}

export function hasPassword(personId: string): boolean {
  return !!creds().get(personId)?.hash;
}

/** True once any account in the workspace has a password (closes the owner bootstrap). */
export function anyPasswordSet(): boolean {
  return creds().all().some((c) => !!c.hash);
}

/** Store an already-computed hash (synchronous, so a check-then-store cannot interleave within an instance). */
export function storeHash(personId: string, hash: string, setBy: string): CredentialRecord {
  const prev = creds().get(personId);
  const now = new Date().toISOString();
  const rec: CredentialRecord = { id: personId, hash, sessionVersion: (prev?.sessionVersion ?? 0) + 1, createdAt: prev?.createdAt ?? now, updatedAt: now, setBy };
  creds().put(rec);
  return rec;
}

/** Hash and store a password; bumps the session version so older sessions stop working. */
export async function setPassword(personId: string, password: string, setBy: string): Promise<CredentialRecord> {
  return storeHash(personId, await hashPassword(password), setBy);
}
