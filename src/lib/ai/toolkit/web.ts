import "server-only";
import type { Tool } from "openai/resources/responses/responses";
import { keyFor, sharedRateLimiter } from "@/lib/net/rate-limit";
import { isSafeFetchError, validateEgressUrl } from "@/lib/net/safe-fetch";
import { defineTool } from "../tools";
import { fetchText, HttpError, htmlToText } from "./http";

/** OpenAI built-in web search tool configuration. */
export function webSearchTool(opts: { contextSize?: "low" | "medium" | "high"; allowedDomains?: string[] } = {}): Tool {
  return {
    type: "web_search",
    search_context_size: opts.contextSize ?? "medium",
    ...(opts.allowedDomains?.length ? { filters: { allowed_domains: opts.allowedDomains } } : {}),
    // LeClaude India: results localised to India (approximate location only).
    user_location: { type: "approximate", country: "IN" },
  };
}

/** Egress policy for model-directed fetches: open web, private targets blocked, 3 MB, 15 s; NET_* env rules apply on top. */
const FETCH_URL_POLICY = { name: "tool:fetch_url", maxBytes: 3_000_000, timeoutMs: 15_000 } as const;

export const fetchUrlTool = defineTool<{ url: string; max_chars?: number }>({
  name: "fetch_url",
  description: "Fetch a public web page, PDF-less HTML document, JSON or plain-text URL and return its readable text. Use it to read a source you found via search, a statute or regulation page, a court website, or a client-provided link. Only public http(s) hosts are reachable; internal and private addresses are refused.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "Absolute http(s) URL" },
      max_chars: { type: "integer", description: "Maximum characters of text to return (default 30000)" },
    },
    required: ["url"],
  },
  label: (a) => `Reading ${safeHost(a.url)}`,
  async execute({ url, max_chars }, ctx) {
    // Validate before spending a rate-limit token so a blocked URL fails fast with a deterministic error.
    try { validateEgressUrl(url, FETCH_URL_POLICY); } catch (e) { if (isSafeFetchError(e)) throw new Error(`Cannot fetch ${safeHost(url)}: ${e.message}`); throw e; }
    const principal = typeof ctx.state.principalId === "string" ? ctx.state.principalId : typeof ctx.state.userId === "string" ? ctx.state.userId : undefined;
    const limit = await sharedRateLimiter().acquire(keyFor("tool", "fetch_url", principal), { maxWaitMs: 5_000, signal: ctx.signal });
    if (!limit.ok) throw new Error(`fetch_url is rate limited; retry in ${Math.ceil(limit.retryAfterMs / 1000)}s`);
    let page: Awaited<ReturnType<typeof fetchText>>;
    try {
      page = await fetchText(url, { signal: ctx.signal, egress: FETCH_URL_POLICY, maxBytes: FETCH_URL_POLICY.maxBytes, timeoutMs: FETCH_URL_POLICY.timeoutMs });
    } catch (e) {
      if (isSafeFetchError(e)) throw new Error(`Cannot fetch ${safeHost(url)}: ${e.message}`);
      if (e instanceof HttpError) throw new Error(`Fetch of ${safeHost(url)} failed with HTTP ${e.status}`);
      throw e;
    }
    const { text, contentType, finalUrl, truncated } = page;
    const max = max_chars ?? 30_000;
    if (/json/i.test(contentType)) return { url: finalUrl, contentType, text: text.slice(0, max), truncated };
    if (/text\/plain/i.test(contentType)) return { url: finalUrl, contentType, text: text.slice(0, max), truncated };
    const { title, text: body } = htmlToText(text, { maxChars: max });
    ctx.emit({ type: "citation", citation: { title: title || finalUrl, url: finalUrl, source: "web" } });
    return { url: finalUrl, title, contentType, text: body, truncated };
  },
});

function safeHost(url: string) { try { return new URL(url).host; } catch { return "page"; } }
