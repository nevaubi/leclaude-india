/**
 * Bounded concurrency for fan-out model work (constitution §36, §51: no serial independent calls, no unbounded swarm).
 * Pure and client-safe.
 */

/**
 * Run `fn` over `items` with at most `limit` in flight; results keep input order. Stop-on-failure: after the first
 * failure no further item is started, the items already in flight are aborted through the `signal` passed to `fn`, and
 * the promise rejects with that first error once every started item has settled (nothing keeps running — or writing —
 * after mapPool has rejected). A caller abort (`signal`) rejects with an AbortError the same way.
 */
export async function mapPool<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number, signal: AbortSignal) => Promise<R>, signal?: AbortSignal): Promise<R[]> {
  const out = new Array<R>(items.length);
  if (!items.length) return out;
  const ctrl = new AbortController();
  const onAbort = () => { if (!ctrl.signal.aborted) ctrl.abort(signal?.reason ?? new DOMException("Aborted", "AbortError")); };
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  let next = 0;
  let failed = false;
  let firstError: unknown;
  const fail = (e: unknown) => {
    if (failed) return;
    failed = true;
    firstError = e;
    // In-flight siblings see a plain cancellation (AbortError), never the sibling's error as their own.
    if (!ctrl.signal.aborted) ctrl.abort(new DOMException("Aborted: another item of the batch failed", "AbortError"));
  };
  const workers = Array.from({ length: Math.max(1, Math.min(Math.floor(limit) || 1, items.length)) }, async () => {
    for (;;) {
      if (failed) return;
      if (signal?.aborted) { fail(new DOMException("Aborted", "AbortError")); return; }
      const i = next++;
      if (i >= items.length) return;
      try {
        out[i] = await fn(items[i], i, ctrl.signal);
      } catch (e) {
        fail(e);
        return;
      }
    }
  });
  try {
    await Promise.allSettled(workers);
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
  if (failed) throw firstError;
  return out;
}

export type Settled<R> = { ok: true; value: R } | { ok: false; error: unknown };

/**
 * Like mapPool, but every item settles: a failed item is reported (`ok: false`) instead of failing the whole batch.
 * Cancellation (AbortError) still rejects.
 */
export async function mapPoolSettled<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number, signal: AbortSignal) => Promise<R>, signal?: AbortSignal): Promise<Settled<R>[]> {
  return mapPool(items, limit, async (item, i, poolSignal): Promise<Settled<R>> => {
    try {
      return { ok: true, value: await fn(item, i, poolSignal) };
    } catch (error) {
      if ((error as { name?: string } | null)?.name === "AbortError" || signal?.aborted) throw error;
      return { ok: false, error };
    }
  }, signal);
}
