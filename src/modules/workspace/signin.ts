import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { audit } from "@/lib/integrity/audit";
import { activeMember, activeMemberByEmail, anyPasswordSet, getCredential, hasPassword, setPassword, storeHash } from "@/lib/auth/accounts";
import { burnPasswordCheck, hashPassword, passwordProblem, verifyPassword } from "@/lib/auth/password";
import { authMode, rolesForPerson } from "@/lib/auth/principal";
import { recordFailure, resetKey, retryAfter, SIGNIN_RULES } from "@/lib/auth/rate-limit";
import { issueSessionToken, sessionsConfigured } from "@/lib/auth/session";
import type { Principal } from "@/lib/auth/types";
import { getWorkspace } from "@/lib/workspace";
import { ServiceError } from "./errors";
import { canManageWorkspace, getMember, isPlatformAdmin, principalFirmId, setupWorkspace, type SetupInput } from "./service";

/**
 * Workspace sign-in (email + password), the one-time owner bootstrap and administrator password resets.
 *
 * Every failure a stranger can trigger answers with the same generic message (no "unknown email" vs "wrong
 * password"), and a missing account spends the same scrypt work as a real check, so the endpoint does not reveal
 * who has an account. Attempts are rate-limited per email+IP and per IP (src/lib/auth/rate-limit.ts).
 */

export const GENERIC_SIGNIN_ERROR = "Email or password is incorrect.";

export interface IssuedSession {
  token: string;
  expiresAt: string;
  member: { id: string; name: string; email?: string };
}

export type SignInResult = ({ ok: true } & IssuedSession) | { ok: false; status: 401 | 422 | 429 | 503; code: string; message: string; retryAfter?: number };

function log(event: string, data: Record<string, unknown>): void {
  console.warn(JSON.stringify({ level: "warn", event, ...data }));
}

function emailHash(email: string): string {
  // Correlates repeated failures in logs without writing the address itself.
  return createHash("sha256").update(email).digest("hex").slice(0, 12);
}

function minutes(seconds: number): string {
  const m = Math.ceil(seconds / 60);
  return m <= 1 ? "a minute" : `${m} minutes`;
}

export function issueMemberSession(personId: string): IssuedSession {
  const person = activeMember(personId);
  const cred = getCredential(personId);
  if (!person || !cred) throw new ServiceError(409, "This account cannot sign in.", undefined, "no_account");
  const { token, expiresAt } = issueSessionToken({ id: person.id, name: person.name, email: person.email, roles: rolesForPerson(person), sessionVersion: cred.sessionVersion });
  return { token, expiresAt, member: { id: person.id, name: person.name, email: person.email } };
}

export async function signIn(input: { email?: unknown; password?: unknown; ip?: string }): Promise<SignInResult> {
  if (!sessionsConfigured()) return { ok: false, status: 503, code: "not_configured", message: "Sign-in is not configured on this deployment. An administrator must set AUTH_JWT_SECRET (at least 32 characters)." };
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase().slice(0, 200) : "";
  const password = typeof input.password === "string" ? input.password : "";
  if (!email || !password) return { ok: false, status: 422, code: "invalid", message: "Enter your email and password." };
  const ip = input.ip || "unknown";
  const accountKey = `signin:${email}|${ip}`;
  const ipKey = `signin-ip:${ip}`;
  const wait = Math.max(retryAfter(accountKey, SIGNIN_RULES.account), retryAfter(ipKey, SIGNIN_RULES.ip));
  if (wait > 0) {
    log("auth.signin_rate_limited", { email: emailHash(email), ip });
    return { ok: false, status: 429, code: "rate_limited", message: `Too many sign-in attempts. Try again in ${minutes(wait)}.`, retryAfter: wait };
  }
  const person = activeMemberByEmail(email);
  const cred = person ? getCredential(person.id) : null;
  let ok = false;
  if (person && cred?.hash) ok = await verifyPassword(password, cred.hash);
  else await burnPasswordCheck(password);
  if (!ok || !person) {
    recordFailure(accountKey);
    recordFailure(ipKey);
    log("auth.signin_failed", { email: emailHash(email), ip });
    return { ok: false, status: 401, code: "invalid_credentials", message: GENERIC_SIGNIN_ERROR };
  }
  resetKey(accountKey);
  const session = issueMemberSession(person.id);
  try {
    audit("login", { kind: "person", id: person.id, label: person.name }, { method: "password" }, { id: person.id, name: person.name });
  } catch (e) {
    log("auth.audit_failed", { error: (e as Error).message });
  }
  return { ok: true, ...session };
}

// ---------------------------------------------------------------------------
// Owner bootstrap
// ---------------------------------------------------------------------------

export interface BootstrapStatus {
  /** The workspace has an owner. */
  configured: boolean;
  /** No account has a password yet: the owner (or, for a fresh workspace, the first owner) must be set up with the setup token. */
  needsOwnerPassword: boolean;
  setupTokenConfigured: boolean;
  signInConfigured: boolean;
  /** Sign-in is enforced on every page and API route. */
  enforced: boolean;
}

function enforced(): boolean {
  try {
    return authMode() !== "dev";
  } catch {
    return true;
  }
}

export function bootstrapStatus(env: Readonly<Record<string, string | undefined>> = process.env): BootstrapStatus {
  return {
    configured: getWorkspace().configured,
    needsOwnerPassword: !anyPasswordSet(),
    setupTokenConfigured: Boolean(env.AUTH_SETUP_TOKEN?.trim()),
    signInConfigured: sessionsConfigured(),
    enforced: enforced(),
  };
}

function sameSecret(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export interface BootstrapInput extends SetupInput {
  token?: unknown;
  password?: unknown;
}

/**
 * One-time owner password. Allowed only with AUTH_SETUP_TOKEN (constant-time compare) and only while no account in
 * the workspace has a password; a fresh workspace is set up in the same call (firm, owner, password). The check
 * and the write happen synchronously after hashing, so two concurrent calls on one instance cannot both pass.
 */
export async function bootstrapOwner(input: BootstrapInput, opts: { ip?: string; env?: Readonly<Record<string, string | undefined>> } = {}): Promise<{ workspaceCreated: boolean; session: IssuedSession | null; ownerId: string }> {
  const env = opts.env ?? process.env;
  const expected = env.AUTH_SETUP_TOKEN?.trim();
  if (!expected) throw new ServiceError(503, "Owner setup is not enabled on this deployment. An administrator must set AUTH_SETUP_TOKEN.", undefined, "setup_not_configured");
  const key = `bootstrap:${opts.ip || "unknown"}`;
  const wait = retryAfter(key, SIGNIN_RULES.account);
  if (wait > 0) throw Object.assign(new ServiceError(429, `Too many attempts. Try again in ${minutes(wait)}.`, undefined, "rate_limited"), { retryAfter: wait });
  const given = typeof input.token === "string" ? input.token.trim() : "";
  if (!given || !sameSecret(given, expected)) {
    recordFailure(key);
    log("auth.bootstrap_bad_token", { ip: opts.ip ?? "unknown" });
    throw new ServiceError(403, "The setup token is not valid.", { token: "The setup token is not valid." }, "bad_setup_token");
  }
  if (anyPasswordSet()) throw new ServiceError(409, "The owner account is already set up. Sign in instead.", undefined, "already_bootstrapped");
  const problem = passwordProblem(input.password);
  if (problem) throw new ServiceError(422, problem, { password: problem }, "invalid");
  const hash = await hashPassword(input.password as string);

  // Synchronous from here: re-check, create the workspace if needed, store the hash.
  if (anyPasswordSet()) throw new ServiceError(409, "The owner account is already set up. Sign in instead.", undefined, "already_bootstrapped");
  let workspaceCreated = false;
  if (!getWorkspace().configured) {
    setupWorkspace(input);
    workspaceCreated = true;
  }
  const ownerId = getWorkspace().owner?.id;
  const owner = ownerId ? activeMember(ownerId) : null;
  if (!owner) throw new ServiceError(409, "The workspace owner record is missing or inactive; restore it before setting a password.", undefined, "owner_missing");
  storeHash(owner.id, hash, "bootstrap");
  resetKey(key);
  try {
    audit("settings.change", { kind: "person", id: owner.id, label: owner.name }, { passwordSet: true, via: "bootstrap", workspaceCreated }, { id: owner.id, name: owner.name });
  } catch (e) {
    log("auth.audit_failed", { error: (e as Error).message });
  }
  return { workspaceCreated, ownerId: owner.id, session: sessionsConfigured() ? issueMemberSession(owner.id) : null };
}

/** Fresh-workspace setup without a token (AUTH_MODE=dev only, via POST /api/workspace): store the owner's password when one was given. */
export async function setInitialOwnerPassword(ownerId: string, password: unknown): Promise<void> {
  if (password === undefined || password === null || password === "") return;
  const problem = passwordProblem(password);
  if (problem) throw new ServiceError(422, problem, { password: problem }, "invalid");
  if (hasPassword(ownerId)) return;
  await setPassword(ownerId, password as string, "setup");
}

// ---------------------------------------------------------------------------
// Administrator password set / reset
// ---------------------------------------------------------------------------

/**
 * Set or reset a team member's password. The actor must be signed in with a session (never the dev persona or a
 * service principal) and manage the workspace; only the owner may set the owner's password. Bumps the target's
 * session version, which signs out their existing sessions.
 */
export async function adminSetPassword(actor: Principal | null, targetId: string, password: unknown): Promise<{ self: boolean; session: IssuedSession | null }> {
  if (!actor || actor.source !== "jwt" || !actor.sessionId) throw new ServiceError(403, "Sign in with your own account to set passwords.", undefined, "session_required");
  if (!canManageWorkspace(actor) || actor.roles.includes("service")) throw new ServiceError(403, "Only the workspace owner, a partner or an admin may set passwords.", undefined, "forbidden");
  const targetMember = getMember(targetId);
  if (!isPlatformAdmin(actor) && targetMember?.firmId !== principalFirmId(actor)) throw new ServiceError(403, "You can only manage accounts in your firm.", undefined, "forbidden");
  const target = activeMember(targetId);
  if (!target) throw new ServiceError(404, "Team member not found", undefined, "not_found");
  const ownerId = getWorkspace().owner?.id;
  if (target.id === ownerId && actor.id !== ownerId) throw new ServiceError(403, "Only the owner can set the owner's password.", undefined, "owner_only");
  const problem = passwordProblem(password);
  if (problem) throw new ServiceError(422, problem, { password: problem }, "invalid");
  await setPassword(target.id, password as string, actor.id);
  try {
    audit("settings.change", { kind: "person", id: target.id, label: target.name }, { passwordSet: true, via: "admin" }, { id: actor.id, name: actor.name });
  } catch (e) {
    log("auth.audit_failed", { error: (e as Error).message });
  }
  const self = target.id === actor.id;
  // Changing your own password revokes your current session too; hand back a fresh one.
  return { self, session: self && sessionsConfigured() ? issueMemberSession(target.id) : null };
}
