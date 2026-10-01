"use client";

/** A failed statutes API call, with the status and the server's error code so the UI can show the right state. */
export class LawApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | null) {
    super(message);
    this.name = "LawApiError";
  }
  /** No DATABASE_URL on this deployment. */
  get notConfigured() { return this.status === 503 && this.code === "law_corpus_not_configured"; }
  /** The database is there but the loader has not created the law tables yet. */
  get notLoaded() { return this.status === 503 && this.code === "law_corpus_not_loaded"; }
  get timedOut() { return this.code === "law_search_timeout"; }
  get forbidden() { return this.status === 403; }
  get unauthenticated() { return this.status === 401; }
  get notFound() { return this.status === 404; }
}

export function asLawApiError(e: unknown): LawApiError {
  return e instanceof LawApiError ? e : new LawApiError(String((e as Error)?.message ?? e), 0, null);
}

export async function fetchLawJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { signal, cache: "no-store", headers: { accept: "application/json" } });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new LawApiError("The server could not be reached. Check the connection and try again.", 0, "network");
  }
  const body = (await res.json().catch(() => null)) as (T & { error?: string; code?: string }) | null;
  if (!res.ok || !body) throw new LawApiError(body?.error ?? `Request failed (${res.status})`, res.status, body?.code ?? null);
  return body;
}
