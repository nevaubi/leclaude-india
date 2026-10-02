import "server-only";
import { getOpenAI } from "@/lib/ai/openai";
import { OPENAI_DEFAULTS } from "@/lib/ai/providers/env";
import { modelLimits } from "@/lib/ai/providers/model-limits";
import { resolveContextBudget } from "@/lib/ai/context-budget";
import type { ChatToolFlags } from "../types";

/**
 * Model selection and per-message routing for the Chat page. The user never picks a model: the models are discovered
 * from what the OpenAI key can use (GPT-6 Luna family first), overridable with CHAT_MODEL / CHAT_FAST_MODEL, and each
 * message is routed deterministically (no extra model call on the critical path) to the fast or the standard tier.
 */

export interface ChatModels {
  standard: string;
  fast: string;
  source: "env" | "discovered" | "defaults";
  available?: number;
}

const EXCLUDE = /(audio|realtime|transcribe|tts|image|embedding|moderation|search-preview|computer-use|codex|instruct|vision)/i;
const SMALL = /(mini|nano|fast|lite|flash)/i;

/** Pick the chat models from a list of model ids (pure, for tests). Prefer the undated alias (it tracks the latest snapshot). */
export function pickChatModels(ids: string[], env: Readonly<Record<string, string | undefined>> = {}): ChatModels {
  const envStandard = env.CHAT_MODEL?.trim();
  const envFast = env.CHAT_FAST_MODEL?.trim();
  const usable = ids.filter((id) => /^gpt-/i.test(id) && !EXCLUDE.test(id));
  const rank = (a: string, b: string) => a.length - b.length || b.localeCompare(a);
  const first = (re: RegExp, small: boolean) => usable.filter((id) => re.test(id) && SMALL.test(id) === small).sort(rank)[0];
  const discoveredStandard = first(/^gpt-6[\w.-]*luna/i, false) ?? first(/^gpt-6/i, false);
  const discoveredFast = first(/^gpt-6[\w.-]*luna/i, true) ?? first(/^gpt-6/i, true);
  const standard = envStandard || discoveredStandard || env.OPENAI_MODEL?.trim() || OPENAI_DEFAULTS.model;
  const fast = envFast || discoveredFast || (discoveredStandard && !envStandard ? discoveredStandard : undefined) || env.OPENAI_FAST_MODEL?.trim() || standard;
  const source: ChatModels["source"] = envStandard ? "env" : discoveredStandard ? "discovered" : "defaults";
  return { standard, fast, source, available: usable.length };
}

type G = typeof globalThis & { __leclaudeChatModels?: { at: number; models: ChatModels } };
const TTL_MS = 60 * 60 * 1000;

/** Discover once per hour per instance; a failed listing falls back to env/defaults without failing the chat. */
export async function chatModels(signal?: AbortSignal): Promise<ChatModels> {
  const g = globalThis as G;
  if (g.__leclaudeChatModels && Date.now() - g.__leclaudeChatModels.at < TTL_MS) return g.__leclaudeChatModels.models;
  let ids: string[] = [];
  try {
    const client = getOpenAI();
    const page = await client.models.list({ signal, timeout: 5_000 });
    for await (const m of page) ids.push(m.id);
  } catch {
    ids = [];
  }
  const models = pickChatModels(ids, process.env);
  g.__leclaudeChatModels = { at: Date.now(), models };
  return models;
}

export function resetChatModelsCacheForTests() { (globalThis as G).__leclaudeChatModels = undefined; }

export interface ChatRoute {
  tier: "fast" | "standard";
  effort: "low" | "medium";
  verbosity: "low" | "medium";
  tools: ChatToolFlags;
  /** Visible answer size from the chat_fast / chat_standard budget of the chosen model. */
  maxOutputTokens: number;
  /** Conversation turns replayed (budget). */
  historyTurns: number;
  /** Characters of one function-tool result given back to the model (budget). */
  toolResultChars: number;
  /** Characters of replayed conversation history (budget; older turns beyond it are left out and said so). */
  historyChars: number;
  /** Input tokens one round may use before the oldest tool outputs are elided (budget). */
  inputTokens: number;
  /** The chosen model's maximum output (reasoning headroom is clamped to it). */
  modelMaxOutput: number;
}

type LimitEnv = Readonly<Record<string, string | undefined>>;

/** The only environment values the chat budget reads (limit overrides and the context scale). */
function budgetEnv(): LimitEnv {
  const e = typeof process !== "undefined" ? process.env : undefined;
  return { OPENAI_CONTEXT_WINDOW: e?.OPENAI_CONTEXT_WINDOW, OPENAI_MAX_OUTPUT_TOKENS: e?.OPENAI_MAX_OUTPUT_TOKENS, AI_CONTEXT_SCALE: e?.AI_CONTEXT_SCALE };
}

/** Budget numbers for a chat tier on the model that serves it (coded OpenAI limits + overrides; pure for a given env). */
export function chatBudget(tier: "fast" | "standard", model: string | undefined, env: LimitEnv = budgetEnv()) {
  const limits = modelLimits("openai", model ?? "", env);
  const b = resolveContextBudget(tier === "fast" ? "chat_fast" : "chat_standard", limits, env);
  return { maxOutputTokens: b.maxOutputTokens, historyTurns: b.historyTurns, toolResultChars: b.toolResultChars, historyChars: b.historyChars, inputTokens: b.inputTokens, modelMaxOutput: limits.maxOutput };
}

const URL_RE = /https?:\/\/[^\s)]+/i;
const CODE_HINT = /\b(calculat|compute|interest|amortiz|spreadsheet|excel|xlsx|csv|chart|plot|graph|table of|regression|statistic|average|median|sum of|percent|python|parse this|convert (this|to)|word count|docx|pdf file|make a file|create a file|download)/i;
const IMAGE_HINT = /\b(draw|generate an? (image|picture|illustration|logo|diagram)|make an? (image|picture|illustration|logo)|illustrat)/i;
const DEPTH_HINT = /\b(analy[sz]e|compare|contrast|explain why|step by step|draft|memo|brief|argument|strategy|evaluate|pros and cons|thorough|detailed|in depth|summari[sz]e (this|the attached))/i;
/** A legal question that needs reasoning over authority (not a one-line lookup such as "what is section 138"). */
const LEGAL_ANALYTIC = /\b(whether|can (a|an|the|my|our|i|we)\b|should|liab(le|ility)|remed(y|ies)|defen[cs]es?|maintainab|applicab|limitation period|quash|bail|acquit|convict|injunction|stay of|appeal against|cause of action|burden of proof|admissib|precedent|overrul|binding|ratio|held that|interpret)/i;
/** A question about the user's documents that needs reading across them (not a single fact lookup). */
const DOCS_ANALYTIC = /\b(timeline|chronolog|contradict|inconsisten|all (the )?(references|mentions)|across|each (document|file)|key (facts|terms|issues)|obligations|breach|summar)/i;

/**
 * Route a message (pure, deterministic). Short conversational or lookup messages go to the fast tier; longer, analytic,
 * attachment-bearing or tool-heavy ones — and legal/analytic questions when Indian law or document sets are selected —
 * to the standard tier. Tools the user switched on stay on; code, image and
 * browsing are also turned on when the message plainly asks for them.
 */
export function routeMessage(message: string, flags: ChatToolFlags, o: { attachments?: number; historyTurns?: number; law?: boolean; docs?: boolean; models?: Pick<ChatModels, "standard" | "fast"> } = {}): ChatRoute {
  const text = message.trim();
  const tools: ChatToolFlags = {
    search: flags.search,
    code: flags.code || CODE_HINT.test(text) || ((o.attachments ?? 0) > 0 && /\b(csv|xlsx|spreadsheet|table|chart)\b/i.test(text)),
    image: flags.image || IMAGE_HINT.test(text),
    browse: flags.browse || URL_RE.test(text),
  };
  // With Indian law or document sets selected, a legal/analytic question goes to the standard tier; lookups stay fast.
  const knowledgeHeavy = (o.law === true && LEGAL_ANALYTIC.test(text)) || (o.docs === true && (DOCS_ANALYTIC.test(text) || LEGAL_ANALYTIC.test(text)));
  const heavy = knowledgeHeavy || text.length > 600 || DEPTH_HINT.test(text) || (o.attachments ?? 0) > 0 || tools.code || tools.image || (o.historyTurns ?? 0) > 12;
  // Sizes come from the chat budget of the model that serves the tier (never below 8,000 / 3,000 output tokens).
  return heavy
    ? { tier: "standard", effort: text.length > 1500 || /\b(draft|memo|brief|strategy)\b/i.test(text) ? "medium" : "low", verbosity: "medium", tools, ...chatBudget("standard", o.models?.standard) }
    : { tier: "fast", effort: "low", verbosity: "low", tools, ...chatBudget("fast", o.models?.fast) };
}
