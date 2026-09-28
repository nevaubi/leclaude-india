import "server-only";
import { aiConfig } from "@/lib/ai/config";
import type { IntelHealth, IntelProviderStatus } from "./types";

/**
 * Environment-only configuration for the intelligence layer (keys never live in
 * the database). Non-secret settings — source schedules, folder lists, watches —
 * are records in `intel_sources` / `intel_watches`.
 */
export interface IntelEnvConfig {
  background: IntelHealth["background"];
  corpusDirs: string[];
  courtListenerToken?: string;
  govInfoKey: string;
  firecrawlKey?: string;
  tavilyKey?: string;
  openFdaKey?: string;
  cronSecret?: string;
  /** Job runner settings. */
  concurrency: number;
  tickMs: number;
  orphanAfterMs: number;
  /** Disable outbound network entirely (tests, air-gapped demos). */
  offline: boolean;
}

/**
 * True only when the workspace runs on the demo dataset (LECLAUDE_SEED=demo). The bundled sample
 * corpus, its analysis and the sample-configured sources exist only in that mode; a production
 * workspace (the default) starts with an empty intelligence layer and unconfigured sources.
 */
export function intelSampleMode(): boolean {
  return (process.env.LECLAUDE_SEED ?? "").trim().toLowerCase() === "demo";
}

function env(name: string): string | undefined {
  const v = process.env[name];
  return v == null || !v.trim() ? undefined : v.trim();
}

export function intelConfig(): IntelEnvConfig {
  const bg = (env("LECLAUDE_BACKGROUND") ?? (process.env.VERCEL ? "cron" : "inline")).toLowerCase();
  const background: IntelHealth["background"] = bg === "off" ? "off" : bg === "cron" ? "cron" : "inline";
  const corpusDirs = (env("LECLAUDE_CORPUS_DIRS") ?? "").split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  const concurrency = Math.max(1, Math.min(4, Number(env("INTEL_CONCURRENCY") ?? 2) || 2));
  return {
    background,
    corpusDirs,
    courtListenerToken: env("COURTLISTENER_API_TOKEN"),
    govInfoKey: env("GOVINFO_API_KEY") ?? "DEMO_KEY",
    firecrawlKey: env("FIRECRAWL_API_KEY"),
    tavilyKey: env("TAVILY_API_KEY"),
    openFdaKey: env("OPENFDA_API_KEY"),
    cronSecret: env("CRON_SECRET"),
    concurrency,
    tickMs: 30_000,
    orphanAfterMs: 5 * 60_000,
    offline: env("INTEL_OFFLINE") === "1" || env("INTEL_OFFLINE") === "true",
  };
}

/** Provider availability without exposing secrets. */
export function providerStatuses(cfg: IntelEnvConfig = intelConfig()): IntelProviderStatus[] {
  const ai = aiConfig();
  return [
    { id: "openai", name: "OpenAI (embeddings, steward diagnosis, verification)", configured: ai.hasKey, keyed: ai.hasKey, envVar: "OPENAI_API_KEY", note: ai.hasKey ? undefined : "Keyword-only indexing; the steward uses deterministic fixes only." },
    { id: "courtlistener", name: "CourtListener (opinions, dockets, judges)", configured: true, keyed: Boolean(cfg.courtListenerToken), envVar: "COURTLISTENER_API_TOKEN", note: cfg.courtListenerToken ? undefined : "Anonymous access: lower rate limits." },
    { id: "ecfr", name: "eCFR (Code of Federal Regulations)", configured: true, keyed: false },
    { id: "federal-register", name: "Federal Register", configured: true, keyed: false },
    { id: "govinfo", name: "GovInfo (U.S. Code, Public Laws)", configured: true, keyed: cfg.govInfoKey !== "DEMO_KEY", envVar: "GOVINFO_API_KEY", note: cfg.govInfoKey === "DEMO_KEY" ? "Using DEMO_KEY (low daily quota)." : undefined },
    { id: "openfda", name: "openFDA (recalls, labels, device events)", configured: true, keyed: Boolean(cfg.openFdaKey), envVar: "OPENFDA_API_KEY", note: cfg.openFdaKey ? undefined : "Anonymous access: 240 requests/minute." },
    { id: "jpml", name: "JPML pending MDL list", configured: true, keyed: false, note: "Live page only; the offline fallback list is used only when a source allows it (flagged unverified)." },
    { id: "firecrawl", name: "Firecrawl (scrape, search, crawl)", configured: Boolean(cfg.firecrawlKey), keyed: Boolean(cfg.firecrawlKey), envVar: "FIRECRAWL_API_KEY", note: cfg.firecrawlKey ? undefined : "Plain fetch is used for web pages; news search needs Firecrawl or Tavily." },
    { id: "tavily", name: "Tavily (news search, extract)", configured: Boolean(cfg.tavilyKey), keyed: Boolean(cfg.tavilyKey), envVar: "TAVILY_API_KEY" },
    { id: "web", name: "Plain web fetch", configured: !cfg.offline, keyed: false, note: cfg.offline ? "INTEL_OFFLINE is set." : undefined },
    // LeClaude India sources (src/modules/india/sources). Public datasets need no key; subscription sources need the
    // firm's licence plus an export folder or a licensed API credential, and are never scraped.
    { id: "sci-open-data", name: "Supreme Court of India judgments (AWS Open Data)", configured: !cfg.offline, keyed: false, note: cfg.offline ? "INTEL_OFFLINE is set." : "Public dataset; no key." },
    { id: "hc-open-data", name: "High Court judgments (AWS Open Data)", configured: !cfg.offline, keyed: false, note: cfg.offline ? "INTEL_OFFLINE is set." : "Public dataset; no key." },
    { id: "indian-kanoon", name: "Indian Kanoon API (search, full text, citations)", configured: Boolean(env("INDIAN_KANOON_API_TOKEN")) && !cfg.offline, keyed: Boolean(env("INDIAN_KANOON_API_TOKEN")), envVar: "INDIAN_KANOON_API_TOKEN", note: env("INDIAN_KANOON_API_TOKEN") ? undefined : "Paid API: set the firm's token; nothing is called without it." },
    { id: "india-code", name: "India Code (central and state Acts)", configured: !cfg.offline, keyed: false, note: cfg.offline ? "INTEL_OFFLINE is set." : "Public data (DSpace REST API)." },
    { id: "scc-online", name: "SCC Online (licensed; firm exports or licensed API only)", configured: Boolean(env("SCC_ONLINE_EXPORT_DIR") || env("SCC_ONLINE_API_TOKEN")), keyed: Boolean(env("SCC_ONLINE_API_TOKEN")), envVar: "SCC_ONLINE_EXPORT_DIR", note: "Subscription service, never scraped. Needs the firm's licence and an export folder or a licensed API." },
    { id: "manupatra", name: "Manupatra (licensed; firm exports or licensed API only)", configured: Boolean(env("MANUPATRA_EXPORT_DIR") || env("MANUPATRA_API_TOKEN")), keyed: Boolean(env("MANUPATRA_API_TOKEN")), envVar: "MANUPATRA_EXPORT_DIR", note: "Subscription service, never scraped. Needs the firm's licence and an export folder or a licensed API." },
  ];
}
