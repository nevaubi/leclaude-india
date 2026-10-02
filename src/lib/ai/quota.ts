/**
 * The model provider refused for lack of credit or quota (e.g. OpenAI 429 "You have no credits remaining",
 * insufficient_quota). Not a failure of the document: work waits and resumes once credit is added, without using
 * attempts or marking anything failed.
 */
export const PROVIDER_QUOTA_RE = /no credits remaining|insufficient[_ ]quota|exceeded your current quota|credit balance is too low/i;

/** Seconds a unit waits after a quota refusal before it is tried again. */
export const QUOTA_DEFER_SECONDS = 30 * 60;

export function isProviderQuotaError(e: unknown): boolean {
  const msg = typeof e === "string" ? e : `${(e as { code?: unknown })?.code ?? ""} ${(e as Error)?.message ?? ""}`;
  return PROVIDER_QUOTA_RE.test(msg);
}
