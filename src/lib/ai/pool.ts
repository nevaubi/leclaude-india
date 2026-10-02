/**
 * Bounded concurrency for fan-out model work (constitution §36, §51: no serial independent calls, no unbounded swarm).
 * Pure and client-safe.
 */

/** Run `fn` over `items` with at most `limit` in flight; results keep input order. Rejects on the first failure. */
export async function mapPool<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>, signal?: AbortSignal): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(Math.floor(limit) || 1, items.length)) }, async () => {
    for (;;) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

export type Settled<R> = { ok: true; value: R } | { ok: false; error: unknown };

/**
 * Like mapPool, but every item settles: a failed item is reported (`ok: false`) instead of failing the whole batch.
 * Cancellation (AbortError) still rejects.
 */
export async function mapPoolSettled<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>, signal?: AbortSignal): Promise<Settled<R>[]> {
  return mapPool(items, limit, async (item, i): Promise<Settled<R>> => {
    try {
      return { ok: true, value: await fn(item, i) };
    } catch (error) {
      if ((error as { name?: string } | null)?.name === "AbortError" || signal?.aborted) throw error;
      return { ok: false, error };
    }
  }, signal);
}
