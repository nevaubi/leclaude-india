import "server-only";
import { jsonError } from "@/lib/ai/sse";
import { OfficialSearchTimeoutError } from "@/modules/official/search";
import { OfficialNotConfiguredError } from "@/modules/official/service";

/** One error mapping for the official-sources routes: 503 not configured, 400 bad input, 504 timeout, 502 otherwise. */
export function officialErrorResponse(e: unknown, event: string): Response {
  if (e instanceof OfficialNotConfiguredError) return jsonError(e.message, 503, { code: e.code });
  if (e instanceof RangeError) return jsonError(e.message, 400, { code: "bad_request" });
  if (e instanceof OfficialSearchTimeoutError) return jsonError(e.message, 504, { code: e.code });
  console.error(JSON.stringify({ level: "error", event, error: (e as Error)?.message?.slice(0, 300) ?? String(e) }));
  return jsonError("Official sources could not be read just now. Try again in a moment.", 502, { code: "official_unavailable" });
}

/** Repeated or comma-separated query values ("source=a&source=b,c"). */
export function listParam(sp: URLSearchParams, name: string): string[] | undefined {
  const all = sp.getAll(name).flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean);
  return all.length ? all.slice(0, 40) : undefined;
}

/** A non-negative integer query value, or undefined; RangeError when present but malformed. */
export function intParam(sp: URLSearchParams, name: string, max = 1_000_000): number | undefined {
  const v = sp.get(name);
  if (v == null || v === "") return undefined;
  if (!/^\d{1,9}$/.test(v) || Number(v) > max) throw new RangeError(`${name} must be an integer between 0 and ${max}`);
  return Number(v);
}
