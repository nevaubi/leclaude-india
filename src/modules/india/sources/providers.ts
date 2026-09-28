import "server-only";
import type { TokenBucket } from "@/lib/ai/toolkit/http";
import type { AdapterContext } from "@/modules/intel/adapters/types";
import { intelConfig } from "@/modules/intel/config";
import { createIndiaCode, type IndiaCodeClient } from "./india-code";
import { createIndianKanoon, INDIAN_KANOON_ENV, type IndianKanoonClient } from "./indian-kanoon";
import { createOpenDataBucket, HC_BUCKET_URL, SCI_BUCKET_URL, type OpenDataBucket } from "./s3";

/** Network clients for the India sources. Adapters read them from `ctx.providers.india` when a test injects one. */
export interface IndiaProviders {
  sci: OpenDataBucket;
  hc: OpenDataBucket;
  kanoon: IndianKanoonClient;
  indiaCode: IndiaCodeClient;
}

export interface IndiaProviderOptions {
  fetchImpl?: typeof fetch;
  offline?: boolean;
  sleep?: (ms: number) => Promise<void>;
  /** One rate limiter shared by every client (tests); by default each connector has its own process-wide bucket. */
  limiter?: TokenBucket;
  env?: Partial<Record<typeof INDIAN_KANOON_ENV, string | undefined>>;
}

export function createIndiaProviders(o: IndiaProviderOptions = {}): IndiaProviders {
  const offline = o.offline ?? intelConfig().offline;
  const common = { fetchImpl: o.fetchImpl, offline, sleep: o.sleep, limiter: o.limiter };
  const token = o.env && INDIAN_KANOON_ENV in o.env ? o.env[INDIAN_KANOON_ENV] : process.env[INDIAN_KANOON_ENV];
  return {
    sci: createOpenDataBucket("sci-open-data", SCI_BUCKET_URL, common),
    hc: createOpenDataBucket("hc-open-data", HC_BUCKET_URL, common),
    kanoon: createIndianKanoon({ ...common, token }),
    indiaCode: createIndiaCode(common),
  };
}

type G = typeof globalThis & { __leclaudeIndiaProviders?: IndiaProviders };

export function defaultIndiaProviders(): IndiaProviders {
  const g = globalThis as G;
  if (!g.__leclaudeIndiaProviders) g.__leclaudeIndiaProviders = createIndiaProviders();
  return g.__leclaudeIndiaProviders;
}

export function resetIndiaProviders() {
  (globalThis as G).__leclaudeIndiaProviders = undefined;
}

/** The India clients for a run: injected on `ctx.providers.india` (tests), else the process-wide bundle. */
export function indiaProvidersFor(ctx: Pick<AdapterContext<unknown>, "providers">): IndiaProviders {
  return (ctx.providers as unknown as { india?: IndiaProviders }).india ?? defaultIndiaProviders();
}
