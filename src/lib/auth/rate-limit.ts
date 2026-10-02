/**
 * Sign-in attempt limiter. In-memory, per server instance: on a serverless host each instance keeps its own window,
 * so the effective limit is (limit × warm instances); scrypt's cost bounds the rate further. Move to a shared store
 * (Postgres/Redis) if the deployment scales out widely. Documented in docs/architecture/auth.md.
 *
 * Failures are counted per key in a sliding window; a success resets the key.
 */
export interface LimitRule {
  max: number;
  windowMs: number;
}

/** Five failures per email+IP and thirty per IP in fifteen minutes. */
export const SIGNIN_RULES = {
  account: { max: 5, windowMs: 15 * 60_000 },
  ip: { max: 30, windowMs: 15 * 60_000 },
} as const satisfies Record<string, LimitRule>;

type G = typeof globalThis & { __leclaudeSigninLimiter?: Map<string, number[]> };

function store(): Map<string, number[]> {
  const g = globalThis as G;
  g.__leclaudeSigninLimiter ??= new Map();
  return g.__leclaudeSigninLimiter;
}

function recent(key: string, rule: LimitRule, now: number): number[] {
  const list = (store().get(key) ?? []).filter((t) => now - t < rule.windowMs);
  if (list.length) store().set(key, list);
  else store().delete(key);
  return list;
}

/** Seconds until the key may try again, or 0 when it is under the limit. */
export function retryAfter(key: string, rule: LimitRule, now = Date.now()): number {
  const list = recent(key, rule, now);
  if (list.length < rule.max) return 0;
  return Math.max(1, Math.ceil((list[list.length - rule.max]! + rule.windowMs - now) / 1000));
}

export function recordFailure(key: string, now = Date.now()): void {
  const list = store().get(key) ?? [];
  list.push(now);
  // Bound memory per key.
  store().set(key, list.slice(-100));
  if (store().size > 50_000) {
    const first = store().keys().next().value;
    if (first !== undefined) store().delete(first);
  }
}

export function resetKey(key: string): void {
  store().delete(key);
}

export function resetAllLimits(): void {
  store().clear();
}
