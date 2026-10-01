"use client";

/** A failed API call, with the status and the server's error code so the UI can show the right state. */
export class CaseApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | null) {
    super(message);
    this.name = "CaseApiError";
  }
  get notConfigured() { return this.status === 503 && this.code === "corpus_not_configured"; }
  get forbidden() { return this.status === 403; }
  get unauthenticated() { return this.status === 401; }
  get notFound() { return this.status === 404; }
}

export async function fetchCaseJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { signal, cache: "no-store", headers: { accept: "application/json" } });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new CaseApiError("The server could not be reached. Check the connection and try again.", 0, "network");
  }
  const body = (await res.json().catch(() => null)) as (T & { error?: string; code?: string }) | null;
  if (!res.ok || !body) {
    throw new CaseApiError(body?.error ?? `Request failed (${res.status})`, res.status, body?.code ?? null);
  }
  return body;
}
