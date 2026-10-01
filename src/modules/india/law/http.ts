import "server-only";
import { jsonError } from "@/lib/ai/sse";
import { isLawCorpusError, lawErrorStatus } from "./common";

/** Route error mapping: corpus absent → 503 with its code; search timeout → 504; anything else → 502 (logged, no detail). */
export function lawErrorResponse(e: unknown, event: string, fallback: string): Response {
  if (isLawCorpusError(e)) return jsonError(e.message, lawErrorStatus(e), { code: e.code });
  console.error(JSON.stringify({ level: "error", event, error: (e as Error)?.message ?? String(e) }));
  return jsonError(fallback, 502, { code: "law_corpus_unavailable" });
}
