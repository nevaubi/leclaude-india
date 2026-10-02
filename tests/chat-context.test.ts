/**
 * Chat context bounds: replayed history fits the budget's turns and characters (newest first, what is left out is
 * counted), and each round's replayed conversation is kept inside the tier's input budget by eliding the oldest tool
 * outputs — never the latest round's, never a message — with a note naming the tool that can fetch it again.
 */
import { describe, expect, it } from "vitest";
import { estimateItemTokens, guardConversation, historyWindow } from "@/modules/chat/server/context";
import { chatBudget } from "@/modules/chat/server/routing";

const msg = (role: "user" | "assistant", n: number, size = 100) => ({ role, text: `${role} ${n} `.padEnd(size, "x") });

describe("historyWindow", () => {
  it("keeps the newest turns within the character budget and counts what it leaves out", () => {
    const history = Array.from({ length: 40 }, (_, i) => msg(i % 2 ? "assistant" : "user", i, 5_000));
    const w = historyWindow(history, { turns: 16, maxChars: 24_000 });
    expect(w.items.length).toBe(4); // 4 × 5,000 ≤ 24,000 < 5 × 5,000
    expect(w.items.at(-1)?.content.startsWith("assistant 39")).toBe(true);
    expect(w.omitted).toBe(36);
    expect(w.items.reduce((a, m) => a + m.content.length, 0)).toBeLessThanOrEqual(24_000);
    // The turn cap alone also counts as omitted.
    expect(historyWindow(history, { turns: 2, maxChars: 1_000_000 })).toMatchObject({ omitted: 36 });
  });

  it("clips a single over-long newest message with a marker instead of dropping everything silently", () => {
    const w = historyWindow([msg("user", 1, 200), msg("assistant", 2, 50_000)], { turns: 16, maxChars: 10_000 });
    expect(w.items).toHaveLength(1);
    expect(w.clipped).toBe(true);
    expect(w.omitted).toBe(1);
    expect(w.items[0].content).toMatch(/…\[earlier message truncated: \d+ of 50000 characters omitted\]$/);
  });

  it("the chat budget carries a history character cap and an input budget", () => {
    const b = chatBudget("standard", "gpt-5.4", {});
    expect(b.historyChars).toBeGreaterThan(0);
    expect(b.inputTokens).toBeGreaterThan(0);
  });
});

describe("guardConversation", () => {
  const out = (id: string, n: number) => ({ type: "function_call_output", call_id: id, output: "r".repeat(n) });
  const call = (id: string, name: string) => ({ type: "function_call", call_id: id, name, arguments: "{}" });

  it("elides the oldest tool outputs first, never the latest round's or any message", () => {
    const items: unknown[] = [
      { role: "user", content: "question ".repeat(500) },
      call("a", "fetch_url"), out("a", 100_000),
      call("b", "search_documents"), out("b", 100_000),
      call("c", "read_document_passage"), out("c", 100_000),
    ];
    const keepFrom = 6; // the latest round's output
    const r = guardConversation(items, { maxTokens: 40_000, keepFrom });
    expect(r.elided).toBe(2);
    expect((items[2] as { output: string }).output).toBe("[elided 100000 chars — call fetch_url again if you need it]");
    expect((items[4] as { output: string }).output).toBe("[elided 100000 chars — call search_documents again if you need it]");
    expect((items[6] as { output: string }).output.length).toBe(100_000);
    expect((items[0] as { content: string }).content).toBe("question ".repeat(500));
  });

  it("does nothing when the conversation fits; images count at their model cost, not their base64 length", () => {
    const items: unknown[] = [{ role: "user", content: [{ type: "input_image", image_url: `data:image/png;base64,${"A".repeat(2_000_000)}` }, { type: "input_text", text: "what is this?" }] }];
    expect(estimateItemTokens(items[0])).toBeLessThan(2_000);
    expect(guardConversation(items, { maxTokens: 10_000, keepFrom: 1 })).toMatchObject({ elided: 0 });
  });
});
