/**
 * Chat context bounds (constitution §36; no silent server-side truncation). Pure.
 *
 * - The replayed history is bounded by the chat budget's turns AND characters, newest first; what is left out is
 *   counted so the engine can say so (to the model and in the steps the user sees).
 * - Each round's conversation (store:false, replayed in full) is kept inside the tier's input budget by eliding the
 *   OLDEST tool outputs (never the latest round's, never a user or assistant message); an elided output names the tool
 *   that can fetch it again.
 */
import { clipWithMarker, estimateTokens } from "@/lib/ai/context-budget";

export interface ChatHistoryMessage { role: "user" | "assistant"; text: string }

/** The most recent history that fits `turns` and `maxChars` (newest message clipped, with a marker, only if it alone is too long). */
export function historyWindow(history: ChatHistoryMessage[], o: { turns: number; maxChars: number }): { items: { role: "user" | "assistant"; content: string }[]; omitted: number; clipped: boolean } {
  const all = history.filter((m) => m.text.trim());
  const recent = all.slice(-Math.max(0, o.turns) * 2);
  let omitted = all.length - recent.length;
  const items: { role: "user" | "assistant"; content: string }[] = [];
  let used = 0;
  let clipped = false;
  for (let i = recent.length - 1; i >= 0; i--) {
    const m = recent[i];
    const left = o.maxChars - used;
    if (m.text.length <= left) { items.unshift({ role: m.role, content: m.text }); used += m.text.length; continue; }
    if (!items.length && left > 500) { items.unshift({ role: m.role, content: clipWithMarker(m.text, left, "earlier message") }); clipped = true; omitted += i; break; }
    omitted += i + 1;
    break;
  }
  return { items, omitted, clipped };
}

type Item = Record<string, unknown>;

/** Estimated tokens of one Responses input item (images and files at their model cost, not their base64 length). */
export function estimateItemTokens(item: unknown): number {
  let extra = 0;
  let json = "";
  try {
    json = JSON.stringify(item, (key, value) => {
      if (typeof value !== "string") return value;
      if (key === "image_url" && value.startsWith("data:")) { extra += 1_600; return ""; }
      if (key === "file_data") { extra += Math.ceil(value.length / 40) + 500; return ""; }
      if (key === "encrypted_content") { extra += Math.ceil(value.length / 4); return ""; }
      return value;
    });
  } catch { json = ""; }
  return estimateTokens(json) + extra + 4;
}

const ELIDED = "[elided ";

/**
 * Elide the oldest function-call outputs (before `keepFrom`, i.e. not the latest round's) until the estimated input
 * fits `maxTokens`. Mutates `items` (replaces the elided output items). Returns what was elided and the new estimate.
 */
export function guardConversation(items: unknown[], o: { maxTokens: number; fixedTokens?: number; keepFrom: number; minChars?: number }): { elided: number; chars: number; tokens: number } {
  let tokens = (o.fixedTokens ?? 0) + items.reduce<number>((a, it) => a + estimateItemTokens(it), 0);
  if (tokens <= o.maxTokens) return { elided: 0, chars: 0, tokens };
  const minChars = o.minChars ?? 1_200;
  const nameOf = (callId: unknown): string => {
    for (const it of items as Item[]) if (it?.type === "function_call" && it.call_id === callId && typeof it.name === "string") return it.name;
    return "the tool that produced it";
  };
  let elided = 0;
  let chars = 0;
  for (let i = 0; i < Math.min(o.keepFrom, items.length) && tokens > o.maxTokens; i++) {
    const it = items[i] as Item;
    if (it?.type !== "function_call_output" || typeof it.output !== "string") continue;
    const output = it.output;
    if (output.length < minChars || output.startsWith(ELIDED)) continue;
    const next = { ...it, output: `${ELIDED}${output.length} chars — call ${nameOf(it.call_id)} again if you need it]` };
    tokens -= Math.max(0, estimateItemTokens(it) - estimateItemTokens(next));
    items[i] = next;
    elided++;
    chars += output.length;
  }
  return { elided, chars, tokens };
}
