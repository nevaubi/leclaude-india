import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.LECLAUDE_DATA_DIR = `${process.env.VITEST_DATA_DIR || process.env.TMPDIR || "/tmp"}/chat-vitest-${process.pid}`;
  process.env.LECLAUDE_BACKGROUND = "off";
  process.env.WORKFLOW_SCHEDULER_DISABLED = "1";
  process.env.OPENAI_API_KEY = "sk-test";
});

/** A scripted OpenAI client: each responses.create call yields the next scripted event list. */
const fake = vi.hoisted(() => ({
  rounds: [] as Array<Array<Record<string, unknown>>>,
  calls: [] as Array<Record<string, unknown>>,
  models: ["gpt-6-luna", "gpt-6-luna-mini", "gpt-6-luna-2026-08-01", "gpt-6-luna-realtime", "gpt-5.4", "text-embedding-3-large"],
  containerFile: new TextEncoder().encode("a,b\n1,2\n"),
}));

vi.mock("@/lib/ai/openai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/openai")>();
  return {
    ...actual,
    getOpenAI: () => ({
      models: { list: async () => ({ async *[Symbol.asyncIterator]() { for (const id of fake.models) yield { id }; } }) },
      responses: {
        create: async (params: Record<string, unknown>) => {
          fake.calls.push(params);
          const events = fake.rounds.shift() ?? [];
          return { async *[Symbol.asyncIterator]() { for (const e of events) yield e; } };
        },
      },
      containers: { files: { content: { retrieve: async () => ({ arrayBuffer: async () => fake.containerFile.buffer }) } } },
    }),
  };
});

vi.mock("@/lib/ai/toolkit/web", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/toolkit/web")>();
  return {
    ...actual,
    fetchUrlTool: { ...actual.fetchUrlTool, execute: async ({ url }: { url: string }, ctx: { emit: (e: unknown) => void }) => { ctx.emit({ type: "citation", citation: { url, title: "Fetched page" } }); return { url, title: "Fetched page", text: "page text" }; } },
  };
});

import { db, resetSqlite } from "@/lib/db";
import { pickChatModels, resetChatModelsCacheForTests, routeMessage } from "@/modules/chat/server/routing";
import { runChat } from "@/modules/chat/server/engine";
import { createThread, getThread, listThreads, saveThread, setFeedback, deleteThread, titleFrom } from "@/modules/chat/server/store";
import { DEFAULT_TOOL_FLAGS, type ChatEvent } from "@/modules/chat/types";

beforeAll(() => { resetSqlite(); db(); });
beforeEach(() => { fake.rounds = []; fake.calls = []; resetChatModelsCacheForTests(); });

describe("model discovery", () => {
  it("prefers the GPT-6 Luna aliases, with a small variant for the fast tier", () => {
    expect(pickChatModels(fake.models, {})).toMatchObject({ standard: "gpt-6-luna", fast: "gpt-6-luna-mini", source: "discovered" });
  });
  it("honours CHAT_MODEL / CHAT_FAST_MODEL and falls back to the configured OpenAI models", () => {
    expect(pickChatModels(fake.models, { CHAT_MODEL: "gpt-x", CHAT_FAST_MODEL: "gpt-x-mini" })).toMatchObject({ standard: "gpt-x", fast: "gpt-x-mini", source: "env" });
    expect(pickChatModels([], { OPENAI_MODEL: "gpt-5.4", OPENAI_FAST_MODEL: "gpt-5.4-mini" })).toMatchObject({ standard: "gpt-5.4", fast: "gpt-5.4-mini", source: "defaults" });
    expect(pickChatModels(["gpt-6", "gpt-6-mini"], {})).toMatchObject({ standard: "gpt-6", fast: "gpt-6-mini" });
  });
});

describe("routing", () => {
  it("sends short lookups to the fast tier and analytic or tool-heavy work to the standard tier", () => {
    expect(routeMessage("What is the capital of Karnataka?", DEFAULT_TOOL_FLAGS)).toMatchObject({ tier: "fast", effort: "low" });
    expect(routeMessage("Compare the two arbitration clauses and explain why one is unenforceable", DEFAULT_TOOL_FLAGS).tier).toBe("standard");
    const calc = routeMessage("Calculate prejudgment interest on $2.4M at 9%", DEFAULT_TOOL_FLAGS);
    expect(calc.tools.code).toBe(true);
    expect(calc.tier).toBe("standard");
    expect(routeMessage("Summarize https://example.com/order.html", DEFAULT_TOOL_FLAGS).tools.browse).toBe(true);
    expect(routeMessage("Draw a logo for the firm", DEFAULT_TOOL_FLAGS).tools.image).toBe(true);
    expect(routeMessage("hi", { ...DEFAULT_TOOL_FLAGS, search: false }).tools.search).toBe(false);
  });
});

describe("store", () => {
  it("keeps threads per owner", () => {
    const t = createThread("u_a", "Quick question about limitation periods in Karnataka");
    expect(t.title).toBe(titleFrom("Quick question about limitation periods in Karnataka"));
    saveThread({ ...t, messages: [{ id: "m1", role: "assistant", text: "x", createdAt: new Date().toISOString() }] });
    expect(getThread(t.id, "u_b")).toBeNull();
    expect(listThreads("u_b")).toEqual([]);
    expect(listThreads("u_a").map((x) => x.id)).toContain(t.id);
    expect(setFeedback(t.id, "m1", "u_b", "up")).toBeNull();
    expect(setFeedback(t.id, "m1", "u_a", "up")?.messages[0].feedback).toBe("up");
    expect(deleteThread(t.id, "u_b")).toBe(false);
    expect(deleteThread(t.id, "u_a")).toBe(true);
  });
});

describe("engine", () => {
  const base = { history: [], attachments: [], principal: null, userId: "u_a" };

  it("streams a fast answer with web sources and reports the route", async () => {
    fake.rounds = [[
      { type: "response.output_item.added", item: { type: "web_search_call", id: "ws1" } },
      { type: "response.output_item.done", item: { type: "web_search_call", id: "ws1", status: "completed", action: { type: "search", query: "fda recalls" } } },
      { type: "response.output_text.delta", delta: "Two recalls " },
      { type: "response.output_text.annotation.added", annotation: { type: "url_citation", url: "https://www.fda.gov/recalls", title: "FDA recalls" } },
      { type: "response.output_text.delta", delta: "this week." },
      { type: "response.completed", response: {} },
    ]];
    const events: ChatEvent[] = [];
    const msg = await runChat({ ...base, message: "latest fda recalls?", flags: DEFAULT_TOOL_FLAGS, signal: new AbortController().signal, send: (e) => events.push(e) });
    expect(msg).toMatchObject({ text: "Two recalls this week.", status: "complete", tier: "fast", model: "gpt-6-luna-mini" });
    expect(msg.sources).toEqual([{ url: "https://www.fda.gov/recalls", title: "FDA recalls" }]);
    expect(msg.steps).toEqual(["Searched: fda recalls"]);
    expect(events[0]).toMatchObject({ type: "route", tier: "fast" });
    const tools = (fake.calls[0].tools as { type: string }[]).map((t) => t.type);
    expect(tools).toEqual(expect.arrayContaining(["web_search", "function"]));
    expect(fake.calls[0]).toMatchObject({ store: false, parallel_tool_calls: true, reasoning: { effort: "low" } });
  });

  it("runs function calls in parallel, feeds the results back, and stores created and code-interpreter files", async () => {
    fake.rounds = [
      [
        { type: "response.output_item.done", item: { type: "function_call", id: "fc1", call_id: "c1", name: "fetch_url", arguments: JSON.stringify({ url: "https://example.com/a" }) } },
        { type: "response.output_item.done", item: { type: "function_call", id: "fc2", call_id: "c2", name: "create_file", arguments: JSON.stringify({ filename: "notes.md", content: "# Notes" }) } },
        { type: "response.completed", response: {} },
      ],
      [
        { type: "response.output_text.delta", delta: "Done; see the files." },
        { type: "response.output_text.annotation.added", annotation: { type: "container_file_citation", container_id: "cntr_1", file_id: "cfile_1", filename: "table.csv" } },
        { type: "response.completed", response: {} },
      ],
    ];
    const msg = await runChat({ ...base, message: "Read https://example.com/a and make a notes file", flags: DEFAULT_TOOL_FLAGS, signal: new AbortController().signal, send: () => {} });
    expect(fake.calls).toHaveLength(2);
    const second = fake.calls[1].input as { type?: string; call_id?: string }[];
    expect(second.filter((i) => i.type === "function_call_output").map((i) => i.call_id).sort()).toEqual(["c1", "c2"]);
    expect(msg.sources?.map((s) => s.url)).toContain("https://example.com/a");
    expect(msg.files?.map((f) => f.name).sort()).toEqual(["notes.md", "table.csv"]);
    const csv = msg.files!.find((f) => f.name === "table.csv")!;
    expect(db().blobs.get(csv.id)?.size).toBe(fake.containerFile.byteLength);
    expect(msg.status).toBe("complete");
  });

  it("reports a model failure as an error message instead of throwing", async () => {
    fake.rounds = [[{ type: "response.failed", response: { error: { message: "model overloaded" } } }]];
    const msg = await runChat({ ...base, message: "hello", flags: DEFAULT_TOOL_FLAGS, signal: new AbortController().signal, send: () => {} });
    expect(msg).toMatchObject({ status: "error", error: "model overloaded" });
  });

  it("marks a cancelled turn as stopped and keeps the partial text", async () => {
    const ctrl = new AbortController();
    fake.rounds = [[{ type: "response.output_text.delta", delta: "Partial" }, { type: "error", message: "aborted" }]];
    const p = runChat({ ...base, message: "hello", flags: DEFAULT_TOOL_FLAGS, signal: ctrl.signal, send: (e) => { if (e.type === "delta") ctrl.abort(); } });
    const msg = await p;
    expect(msg).toMatchObject({ text: "Partial", status: "stopped" });
  });
});
