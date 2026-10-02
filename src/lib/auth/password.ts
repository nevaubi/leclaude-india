import "server-only";
import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";

/**
 * Password hashing for workspace accounts (constitution §41 security). scrypt (node:crypto) with a per-password
 * random salt; the stored string carries its own parameters so they can be raised later without a migration:
 *
 *   scrypt$<N>$<r>$<p>$<salt base64url>$<hash base64url>
 *
 * Verification recomputes with the stored parameters and compares in constant time. Plaintext is never stored or
 * logged, and the stored string never leaves the server (no API returns it).
 */

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;

const KEY_LENGTH = 64;
const SALT_BYTES = 16;
/** N=2^15, r=8, p=1: ~32 MiB and tens of milliseconds per hash on a server core. */
export const DEFAULT_SCRYPT = { N: 32768, r: 8, p: 1 } as const;
const MAX_N = 1 << 20;

function scrypt(password: string, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password.normalize("NFKC"), salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

function memFor(N: number, r: number): number {
  // scrypt needs 128 * N * r bytes; give it headroom over Node's 32 MiB default.
  return 128 * N * r * 2;
}

/** Returns a message when the password is unacceptable, or null. Deliberately simple: length is what matters. */
export function passwordProblem(password: unknown): string | null {
  if (typeof password !== "string" || !password) return "Enter a password.";
  if (password.length < PASSWORD_MIN_LENGTH) return `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
  if (password.length > PASSWORD_MAX_LENGTH) return `Use at most ${PASSWORD_MAX_LENGTH} characters.`;
  if (!password.trim()) return "The password cannot be only spaces.";
  return null;
}

export async function hashPassword(password: string, params: { N: number; r: number; p: number } = DEFAULT_SCRYPT): Promise<string> {
  const problem = passwordProblem(password);
  if (problem) throw new RangeError(problem);
  const salt = randomBytes(SALT_BYTES);
  const key = await scrypt(password, salt, KEY_LENGTH, { N: params.N, r: params.r, p: params.p, maxmem: memFor(params.N, params.r) });
  return ["scrypt", params.N, params.r, params.p, salt.toString("base64url"), key.toString("base64url")].join("$");
}

interface Parsed { N: number; r: number; p: number; salt: Buffer; key: Buffer }

function parse(stored: string): Parsed | null {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return null;
  const [N, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  if (![N, r, p].every((n) => Number.isInteger(n) && n > 0) || N > MAX_N || (N & (N - 1)) !== 0 || r > 32 || p > 16) return null;
  const salt = Buffer.from(parts[4]!, "base64url");
  const key = Buffer.from(parts[5]!, "base64url");
  if (salt.length < 8 || key.length < 32) return null;
  return { N, r, p, salt, key };
}

/** Constant-time verification. A malformed stored value never verifies. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (typeof password !== "string" || !password || password.length > PASSWORD_MAX_LENGTH) return false;
  const parsed = parse(stored);
  if (!parsed) return false;
  const key = await scrypt(password, parsed.salt, parsed.key.length, { N: parsed.N, r: parsed.r, p: parsed.p, maxmem: memFor(parsed.N, parsed.r) });
  return key.length === parsed.key.length && timingSafeEqual(key, parsed.key);
}

let dummy: Promise<string> | null = null;
/**
 * Spend the same work as a real verification when there is no account to check, so response time does not reveal
 * whether an email has an account.
 */
export async function burnPasswordCheck(password: string): Promise<void> {
  dummy ??= hashPassword("placeholder-password-never-valid");
  await verifyPassword(typeof password === "string" && password ? password.slice(0, PASSWORD_MAX_LENGTH) : "x", await dummy);
}
