"use client";

/**
 * A failed /api/official/** call, classified so every surface can show the right state:
 *   notConfigured  503 (no Postgres for the official-sources corpus on this deployment)
 *   notAvailable   404 with no JSON error code: the route is not deployed yet
 *   notFound       404 with a JSON error (an unknown document id)
 *   forbidden / unauthenticated  403 / 401
 *   badRequest     400 (the server's message says what was wrong)
 */
export class OfficialApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | null) {
    super(message);
    this.name = "OfficialApiError";
  }
  get notConfigured() { return this.status === 503; }
  get notAvailable() { return this.status === 404 && !this.code; }
  get notFound() { return this.status === 404 && Boolean(this.code); }
  get forbidden() { return this.status === 403; }
  get unauthenticated() { return this.status === 401; }
  get badRequest() { return this.status === 400; }
  get timedOut() { return this.status === 504; }
}

export function asOfficialApiError(e: unknown): OfficialApiError {
  return e instanceof OfficialApiError ? e : new OfficialApiError(String((e as Error)?.message ?? e), 0, null);
}

export async function fetchOfficialJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { signal, cache: "no-store", headers: { accept: "application/json" } });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new OfficialApiError("The server could not be reached. Check the connection and try again.", 0, "network");
  }
  const body = (await res.json().catch(() => null)) as (T & { error?: string; code?: string }) | null;
  if (!res.ok || !body) {
    const msg = body?.error ?? (res.status === 404 ? "Official sources are not available on this workspace yet." : `Request failed (${res.status})`);
    throw new OfficialApiError(msg, res.status, body?.code ?? null);
  }
  return body;
}
