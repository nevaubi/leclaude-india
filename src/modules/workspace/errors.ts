import { jsonError } from "@/lib/ai/sse";

/**
 * Deterministic service failure with an HTTP status: 404 unknown record, 409 conflict (already configured,
 * duplicate matter number or email), 422 validation (with per-field messages).
 */
export class ServiceError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409 | 422 | 429 | 503, message: string, readonly fields?: Record<string, string>, readonly code?: string) {
    super(message);
    this.name = "ServiceError";
  }
}

export function isServiceError(e: unknown): e is ServiceError {
  return e instanceof ServiceError;
}

/** Map a ServiceError to the shared error shape; anything else is rethrown so withAuth / Next handle it. */
export function serviceErrorResponse(e: unknown): Response {
  if (isServiceError(e)) return jsonError(e.message, e.status, { ...(e.code ? { code: e.code } : {}), ...(e.fields ? { fields: e.fields } : {}) });
  throw e;
}

/** Parse a JSON object body; a malformed body is a 400, never an empty object silently. */
export async function readJsonObject(req: Request): Promise<Record<string, unknown>> {
  let v: unknown;
  try {
    v = await req.json();
  } catch {
    throw new ServiceError(400, "Request body must be JSON", undefined, "bad_json");
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new ServiceError(400, "Request body must be a JSON object", undefined, "bad_json");
  return v as Record<string, unknown>;
}
