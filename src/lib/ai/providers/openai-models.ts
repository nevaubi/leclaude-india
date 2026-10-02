/** Coded knowledge about OpenAI model families (pure, client-safe). */
import { modelLimits } from "./model-limits";

/** Reasoning-native models reject `temperature` and accept `reasoning.effort`. */
export function isReasoningModel(model: string): boolean {
  return /^(gpt-5|gpt-6|o[1-9])/i.test(model) && !/chat-latest/i.test(model);
}

/**
 * Reasoning models spend hidden reasoning tokens against max_output_tokens. Callers size caps for the visible
 * answer, so give reasoning models generous headroom; otherwise responses come back `incomplete` with empty JSON.
 * The result never exceeds the model's maximum output (`maxOutput`, else the coded family limit): asking for more is
 * a 400 from the API, not a bigger answer.
 */
export function outputTokenBudget(model: string, requested: number | undefined, maxOutput?: number): number | undefined {
  if (requested == null) return undefined;
  const limit = maxOutput && maxOutput > 0 ? maxOutput : modelLimits("openai", model).maxOutput;
  const wanted = isReasoningModel(model) ? Math.max(requested * 3, requested + 16_000) : requested;
  return Math.max(1, Math.min(Math.floor(wanted), limit));
}
