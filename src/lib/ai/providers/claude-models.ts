/**
 * Coded knowledge about Claude model families (constitution §53.5: capabilities are coded, not remembered).
 *
 * The Anthropic Messages API changed shape across generations (adaptive thinking replaced `budget_tokens`,
 * server tool versions moved, forced tool use was removed on the newest models). Model ids come only from
 * configuration, so the wire builder classifies the configured id into a family and renders accordingly.
 * Everything here is pure and client-safe.
 */

export type ClaudeFamily =
  /** Fable / Mythos / Opus 5: thinking is always on; `{type:"disabled"}` and `budget_tokens` are rejected. */
  | "adaptive-always"
  /** Opus 4.6–4.8, Sonnet 4.6, Sonnet 5: `thinking: {type:"adaptive"}` + `output_config.effort`. */
  | "adaptive"
  /** Haiku 4.5, Sonnet/Opus 4.5 and older: `thinking: {type:"enabled", budget_tokens}`; no `effort`. */
  | "budget"
  /** Unrecognised id: treated conservatively (no thinking parameters are sent). */
  | "unknown";

/**
 * Strip Bedrock / inference-profile decoration so the family heuristics see the first-party id:
 * `us.anthropic.claude-sonnet-4-5-20250929-v1:0` → `claude-sonnet-4-5`, `global.anthropic.claude-opus-4-6-v1` → `claude-opus-4-6`,
 * `arn:aws:bedrock:…:inference-profile/us.anthropic.claude-opus-4-6-v1` → `claude-opus-4-6`.
 */
export function normalizeClaudeModelId(id: string): string {
  let s = id.trim().toLowerCase();
  const idx = s.lastIndexOf("anthropic.");
  if (idx >= 0) s = s.slice(idx + "anthropic.".length);
  s = s.replace(/-v\d+(?::\d+)?$/, "");
  s = s.replace(/-\d{8}$/, "");
  s = s.replace(/-latest$/, "");
  return s;
}

export function claudeFamily(modelId: string): ClaudeFamily {
  const m = normalizeClaudeModelId(modelId);
  if (!m.startsWith("claude")) return "unknown";
  if (/^claude-(fable|mythos)-/.test(m)) return "adaptive-always";
  if (/^claude-opus-5(-\d+)?$/.test(m)) return "adaptive-always";
  if (/^claude-(opus|sonnet)-4-[678]$/.test(m)) return "adaptive";
  if (/^claude-sonnet-5(-\d+)?$/.test(m)) return "adaptive";
  if (/^claude-(opus|sonnet|haiku)-4-[0-5]$/.test(m)) return "budget";
  if (/^claude-(opus|sonnet|haiku)-4$/.test(m)) return "budget";
  if (/^claude-3-/.test(m)) return "budget";
  if (/^claude-(opus|sonnet|haiku)-3/.test(m)) return "budget";
  return "unknown";
}

/** Extended thinking is available in every family; the wire shape differs (see `thinkingConfig`). */
export function supportsAdaptiveThinking(modelId: string): boolean {
  const f = claudeFamily(modelId);
  return f === "adaptive" || f === "adaptive-always";
}

/**
 * Models that run adaptive thinking when the request omits `thinking` (Fable / Mythos / Opus 5 / Opus 5.5, and Sonnet 5
 * / Sonnet 5.5 in the "adaptive" family), so their history carries thinking blocks even when no thinking was asked
 * for. Opus 4.6–4.8 and Sonnet 4.6 run without thinking when it is omitted.
 */
export function thinksWhenOmitted(modelId: string): boolean {
  if (claudeFamily(modelId) === "adaptive-always") return true;
  return /^claude-sonnet-5(-\d+)?$/.test(normalizeClaudeModelId(modelId));
}

/** `output_config.effort` levels the family accepts. Opus/Sonnet 4.6 lack `xhigh` (arrived with Opus 4.7). */
export function effortLevelsFor(modelId: string): ("low" | "medium" | "high" | "xhigh" | "max")[] | null {
  const f = claudeFamily(modelId);
  if (f === "budget" || f === "unknown") return null;
  const m = normalizeClaudeModelId(modelId);
  if (/^claude-(opus|sonnet)-4-6$/.test(m)) return ["low", "medium", "high", "max"];
  return ["low", "medium", "high", "xhigh", "max"];
}

/** `output_config.format` (native structured outputs) is GA on 4.5+ models; older ones need the forced-tool fallback. */
export function supportsNativeStructuredOutput(modelId: string): boolean {
  const f = claudeFamily(modelId);
  if (f === "adaptive" || f === "adaptive-always") return true;
  const m = normalizeClaudeModelId(modelId);
  return /^claude-(opus|sonnet|haiku)-4-5$/.test(m);
}

/** Forced `tool_choice` (`any` / `tool`) returns 400 on Fable / Mythos / Opus 5.5 / Sonnet 5.5. */
export function supportsForcedToolChoice(modelId: string): boolean {
  const m = normalizeClaudeModelId(modelId);
  if (/^claude-(fable|mythos)-/.test(m)) return false;
  if (/^claude-(opus|sonnet)-5-5$/.test(m)) return false;
  return true;
}

/** Server web search / web fetch tool versions per family (dynamic filtering variants need 4.6+). */
export function webToolVersions(modelId: string): { search: string; fetch: string; betas: string[] } {
  const f = claudeFamily(modelId);
  if (f === "adaptive" || f === "adaptive-always") return { search: "web_search_20260209", fetch: "web_fetch_20260209", betas: [] };
  return { search: "web_search_20250305", fetch: "web_fetch_20250910", betas: ["web-fetch-2025-09-10"] };
}

/** Code execution tool version used for programmatic tool calling (`allowed_callers` uses the same string). */
export const CODE_EXECUTION_TOOL_VERSION = "code_execution_20260120";

/** Beta flag that enables `input_examples` on tool definitions. */
export const TOOL_EXAMPLES_BETA = "advanced-tool-use-2025-11-20";
