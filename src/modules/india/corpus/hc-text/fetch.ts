import "server-only";
import { rateLimiter, type TokenBucket } from "@/lib/ai/toolkit/http";
import { SourceHttp } from "@/modules/india/sources/http";
import { isNotPublished, isTooLarge } from "@/modules/official/http";
import { sniffBytes } from "@/modules/official/extract";
import { isProviderError } from "@/modules/intel/providers/base";
import { allowedPdfUrl, HC_PDF_HOST } from "./config";

/**
 * Fetch of one judgment PDF from the public bucket. Egress is limited to exactly HC_PDF_HOST over HTTPS (the URL is
 * checked before any connection; safeFetch re-checks every redirect hop and refuses private addresses), the body is
 * capped (a larger PDF is refused, never truncated), and the request has a timeout and the run's abort signal.
 */

export type PdfFetchFailure =
  | { kind: "host_not_allowed"; message: string }
  | { kind: "not_found"; message: string }
  | { kind: "too_large"; message: string }
  | { kind: "not_pdf"; message: string }
  | { kind: "transient"; message: string };

export type PdfFetchResult = { ok: true; bytes: Uint8Array; finalUrl: string } | { ok: false; failure: PdfFetchFailure };

export type PdfFetcher = (url: string, o: { signal?: AbortSignal }) => Promise<PdfFetchResult>;

export interface PdfFetcherOptions {
  maxBytes: number;
  timeoutMs: number;
  rps: number;
  burst: number;
  fetchImpl?: typeof fetch;
  limiter?: TokenBucket;
  sleep?: (ms: number) => Promise<void>;
  retries?: number;
}

export function createPdfFetcher(o: PdfFetcherOptions): PdfFetcher {
  const http = new SourceHttp({
    name: "hc-pdf-text",
    egress: { name: "hc-pdf-text", allowHosts: [`=${HC_PDF_HOST}`], allowedSchemes: ["https:"], maxBytes: o.maxBytes, timeoutMs: o.timeoutMs, trustProxyResolution: true },
    limiter: o.limiter ?? rateLimiter(`hc-text:${HC_PDF_HOST}`, { capacity: o.burst, refillPerSecond: o.rps }),
    timeoutMs: o.timeoutMs,
    retries: o.retries ?? 2,
    backoffMs: 800,
    fetchImpl: o.fetchImpl,
    sleep: o.sleep,
  });
  return async (url, { signal }) => {
    if (!allowedPdfUrl(url)) return { ok: false, failure: { kind: "host_not_allowed", message: `PDF URL is not on ${HC_PDF_HOST} over HTTPS` } };
    try {
      const r = await http.request(url, { maxBytes: o.maxBytes, signal, headers: { Accept: "application/pdf" } });
      if (r.truncated) return { ok: false, failure: { kind: "too_large", message: `PDF larger than ${Math.round(o.maxBytes / 1024 / 1024)} MB (HC_TEXT_MAX_PDF_MB)` } };
      if (!allowedPdfUrl(r.finalUrl)) return { ok: false, failure: { kind: "host_not_allowed", message: "redirected off the bucket host" } };
      if (sniffBytes(r.body) !== "pdf") return { ok: false, failure: { kind: "not_pdf", message: `the bucket returned ${r.contentType || "a non-PDF body"}, not a PDF` } };
      return { ok: true, bytes: r.body, finalUrl: r.finalUrl };
    } catch (e) {
      if ((e as Error)?.name === "AbortError" || signal?.aborted) throw e;
      const message = (e as Error).message.slice(0, 300);
      if (isNotPublished(e) || (isProviderError(e) && e.status === 403)) return { ok: false, failure: { kind: "not_found", message } }; // S3 answers 403 for a missing key without list rights
      if (isTooLarge(e)) return { ok: false, failure: { kind: "too_large", message: `PDF larger than ${Math.round(o.maxBytes / 1024 / 1024)} MB (HC_TEXT_MAX_PDF_MB)` } };
      if (isProviderError(e) && e.code === "not_configured" && e.status == null) return { ok: false, failure: { kind: "host_not_allowed", message } };
      return { ok: false, failure: { kind: "transient", message } };
    }
  };
}
