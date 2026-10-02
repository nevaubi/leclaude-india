"use client";
/** Client calls to /api/documents/** with errors classified for the UI (denied / not configured / storage / conflict / other). */
import { dispositionName } from "./format";

export type ApiErrorKind = "denied" | "unconfigured" | "storage" | "auth" | "conflict" | "other";

export class DocsApiError extends Error {
  constructor(message: string, readonly status: number, readonly kind: ApiErrorKind) { super(message); this.name = "DocsApiError"; }
}

export const DENIED_MESSAGE = "This document set was not found, or you do not have access to it.";
export const UNCONFIGURED_MESSAGE = "AI is not configured for this workspace, so this step is unavailable. An administrator must add a model API key.";

export function classify(status: number, body: { error?: string; code?: string }): DocsApiError {
  const msg = body.error ?? "";
  if (status === 404 || status === 403) return new DocsApiError(DENIED_MESSAGE, status, "denied");
  if (status === 401) return new DocsApiError("Sign in to continue.", status, "auth");
  if (status === 507 || /storage|database (is )?full|upgrade/i.test(msg) || body.code === "storage_full") return new DocsApiError(msg || "Document storage is full.", status, "storage");
  if (status === 503) return new DocsApiError(msg || UNCONFIGURED_MESSAGE, status, "unconfigured");
  if (status === 409) return new DocsApiError(msg || "This changed since you opened it. Reload and try again.", status, "conflict");
  return new DocsApiError(msg || `Request failed (${status})`, status, "other");
}

export async function docsApi<T>(url: string, init: { method?: string; json?: unknown; body?: BodyInit; signal?: AbortSignal } = {}): Promise<T> {
  const res = await fetch(url, {
    method: init.method ?? (init.json !== undefined || init.body ? "POST" : "GET"),
    headers: init.json !== undefined ? { "content-type": "application/json" } : undefined,
    body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
    signal: init.signal,
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string; code?: string };
  if (!res.ok) throw classify(res.status, body);
  return body;
}

export const errorKind = (e: unknown): ApiErrorKind => (e instanceof DocsApiError ? e.kind : "other");
export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
export const isAbort = (e: unknown): boolean => (e as { name?: string })?.name === "AbortError";

export const setUrl = (setId: string, rest = "") => `/api/documents/sets/${encodeURIComponent(setId)}${rest}`;

export interface DocsStatus { ai: boolean; storage: { backend: string; usedMb: number; limitMb: number; full: boolean } }

export function downloadText(name: string, text: string, mime = "text/csv;charset=utf-8") {
  const blob = new Blob(["﻿" + text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Download a file the server builds (exports): errors are classified like any other call instead of navigating away. */
export async function downloadFrom(url: string, fallbackName: string, signal?: AbortSignal): Promise<void> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw classify(res.status, (await res.json().catch(() => ({}))) as { error?: string; code?: string });
  const name = dispositionName(res.headers.get("content-disposition")) || fallbackName;
  const blob = await res.blob();
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}
