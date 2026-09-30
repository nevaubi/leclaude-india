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

/** Document-set facade (implemented by another workstream): scripted per test. */
const docs = vi.hoisted(() => ({
  sets: [{ id: "ds_a", name: "Lease dispute" }, { id: "ds_b", name: "Loan papers" }] as { id: string; name: string }[],
  listFails: false,
  searchCalls: [] as { setIds: string[]; query: string }[],
  readCalls: [] as string[],
}));

vi.mock("@/modules/documents/server", () => ({
  listDocSets: async () => {
    if (docs.listFails) throw new Error("documents store offline");
    return docs.sets.map((s) => ({ ...s, ownerId: "u_a", tenantId: "t", fileCount: 1, pageCount: 1, extractedCount: 0, createdAt: "", updatedAt: "" }));
  },
  searchDocSets: async (_p: unknown, setIds: string[], query: string) => {
    docs.searchCalls.push({ setIds, query });
    return [
      { source: "docs://ds_a/f1/p/3#0", setId: "ds_a", fileId: "f1", fileName: "Lease.pdf", page: 3, idx: 0, text: "Monthly rent of Rs. 45,000 payable by the 5th.", score: 2.1 },
      // A hit outside the validated sets must never reach the model or the sources.
      { source: "docs://ds_z/f9/p/1#0", setId: "ds_z", fileId: "f9", fileName: "Other.pdf", page: 1, idx: 0, text: "other matter", score: 1 },
    ];
  },
  readDocPassage: async (_p: unknown, source: string) => {
    docs.readCalls.push(source);
    return { hit: { source, setId: "ds_a", fileId: "f1", fileName: "Lease.pdf", page: 3, idx: 0, text: "Monthly rent…", score: 1 }, context: "…" };
  },
}));

/** Indian law tools: stand-ins with the real names (the corpus is not part of these tests). */
vi.mock("@/lib/ai/toolkit/india", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/toolkit/india")>();
  const stub = (name: string) => ({ name, description: name, parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }, execute: async (_a: unknown, ctx: { emit: (e: unknown) => void }) => { ctx.emit({ type: "evidence", evidence: [{ source: "judgment://sci/j1", kind: "opinion", provider: "corpus", tool: name, rank: 1, url: "https://www.sci.gov.in/j1", retrievedAt: "" }] }); return { count: 1, results: [{ type: "search_result", source: "judgment://sci/j1", title: "A v. B, 2024 INSC 1 (SC, 3-judge bench)", url: "https://www.sci.gov.in/j1", content: ["held"] }] }; } });
  return { ...actual, indiaResearchTools: () => [stub("search_judgments"), stub("read_judgment"), stub("search_statutes"), stub("read_section")] };
});

import { db, resetSqlite } from "@/lib/db";
import { pickChatModels, resetChatModelsCacheForTests, routeMessage } from "@/modules/chat/server/routing";
import { runChat } from "@/modules/chat/server/engine";
import { authorizeKnowledge, documentTools, parseKnowledge } from "@/modules/chat/server/knowledge";
import { runTool } from "@/lib/ai/tools";
import type { Principal } from "@/lib/auth/types";
import { createThread, getThread, listThreads, saveThread, setFeedback, deleteThread, titleFrom } from "@/modules/chat/server/store";
import { DEFAULT_KNOWLEDGE, DEFAULT_TOOL_FLAGS, type ChatEvent } from "@/modules/chat/types";

beforeAll(() => { resetSqlite(); db(); });
beforeEach(() => { fake.rounds = []; fake.calls = []; resetChatModelsCacheForTests(); docs.listFails = false; docs.searchCalls = []; docs.readCalls = []; });

const principal: Principal = { id: "u_a", name: "A", tenantId: "t", roles: ["associate"], matterIds: [], source: "dev" };
const toolNames = (i = 0) => (fake.calls[i].tools as { type: string; name?: string }[]).map((t) => t.name ?? t.type);

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

describe("knowledge switch", () => {
  it("parses the switch and stays compatible with requests that only send tools.search", () => {
    expect(parseKnowledge({})).toEqual(DEFAULT_KNOWLEDGE);
    expect(parseKnowledge({ tools: { search: false } })).toEqual({ web: false, law: true, library: false, docSetIds: [] });
    expect(parseKnowledge({ tools: { search: false }, knowledge: { library: true, docSetIds: ["ds_a", "ds_a", " "] } })).toEqual({ web: false, law: true, library: true, docSetIds: ["ds_a"] });
    expect(parseKnowledge({ knowledge: { web: true, law: false } })).toMatchObject({ web: true, law: false });
    expect(typeof parseKnowledge({ knowledge: { docSetIds: "ds_a" as unknown as string[] } })).toBe("string");
    expect(typeof parseKnowledge({ knowledge: [] as unknown as object })).toBe("string");
  });

  it("drops document sets the caller cannot read and fails closed when the facade is down", async () => {
    const ok = await authorizeKnowledge(principal, { ...DEFAULT_KNOWLEDGE, docSetIds: ["ds_a", "ds_unknown"] });
    expect(ok.knowledge.docSetIds).toEqual(["ds_a"]);
    expect(ok.sets).toEqual([{ id: "ds_a", name: "Lease dispute" }]);
    expect(ok.notes).toHaveLength(1);
    docs.listFails = true;
    const down = await authorizeKnowledge(principal, { ...DEFAULT_KNOWLEDGE, docSetIds: ["ds_a"] });
    expect(down).toEqual({ knowledge: { ...DEFAULT_KNOWLEDGE, docSetIds: [] }, sets: [], notes: ["Document sets unavailable"] });
    expect((await authorizeKnowledge(principal, DEFAULT_KNOWLEDGE)).sets).toEqual([]);
  });

  it("offers tools per switch: law, library (never e-discovery), documents only for validated sets", async () => {
    const base = { history: [], attachments: [], principal, userId: "u_a", flags: DEFAULT_TOOL_FLAGS, signal: new AbortController().signal, send: () => {} };
    fake.rounds = [[{ type: "response.completed", response: {} }], [{ type: "response.completed", response: {} }], [{ type: "response.completed", response: {} }]];
    await runChat({ ...base, message: "hi", knowledge: { web: false, law: true, library: false, docSetIds: [] } });
    expect(toolNames(0)).toContain("search_judgments");
    expect(toolNames(0)).not.toContain("search_library");
    expect(toolNames(0)).not.toContain("web_search");
    expect(toolNames(0)).not.toContain("search_documents");

    await runChat({ ...base, message: "hi", knowledge: { web: true, law: false, library: true, docSetIds: [] } });
    expect(toolNames(1)).toEqual(expect.arrayContaining(["web_search", "search_library", "get_library_item"]));
    expect(toolNames(1)).not.toContain("search_judgments");
    expect(toolNames(1)).not.toContain("search_ediscovery");

    // A set id with no validated set behind it adds no document tools.
    await runChat({ ...base, message: "hi", knowledge: { web: false, law: false, library: false, docSetIds: ["ds_a"] }, docSets: [] });
    expect(toolNames(2)).not.toContain("search_documents");
  });

  it("searches only the validated sets and turns docs:// hits into in-app message sources", async () => {
    fake.rounds = [
      [
        { type: "response.output_item.done", item: { type: "function_call", id: "fc1", call_id: "c1", name: "search_documents", arguments: JSON.stringify({ query: "monthly rent", limit: null }) } },
        { type: "response.completed", response: {} },
      ],
      [{ type: "response.output_text.delta", delta: "Rent is Rs. 45,000 (Lease.pdf, p. 3)." }, { type: "response.completed", response: {} }],
    ];
    const events: ChatEvent[] = [];
    const msg = await runChat({
      history: [], attachments: [], principal, userId: "u_a", flags: DEFAULT_TOOL_FLAGS, signal: new AbortController().signal, send: (e) => events.push(e),
      message: "What is the monthly rent under the lease?",
      knowledge: { web: false, law: false, library: false, docSetIds: ["ds_a"] }, docSets: [{ id: "ds_a", name: "Lease dispute" }], notes: ["1 document set is not available and was skipped"],
    });
    expect(toolNames(0)).toEqual(expect.arrayContaining(["search_documents", "read_document_passage"]));
    expect(docs.searchCalls).toEqual([{ setIds: ["ds_a"], query: "monthly rent" }]);
    expect(msg.sources).toEqual([{ url: "/documents/ds_a?tab=files&file=f1&page=3", title: "Lease.pdf, p. 3" }]);
    expect(msg.steps).toEqual(["1 document set is not available and was skipped", "Searched your documents: monthly rent (1 found)"]);
    const out = (fake.calls[1].input as { type?: string; output?: string }[]).find((i) => i.type === "function_call_output")!;
    expect(out.output).toContain("docs://ds_a/f1/p/3#0");
    expect(out.output).not.toContain("ds_z");
    expect(events.find((e) => e.type === "route")).toMatchObject({ tools: expect.arrayContaining(["documents"]) });
    expect(msg.status).toBe("complete");
  });

  it("refuses to read a passage outside the selected sets and requires a principal", async () => {
    const [, read] = documentTools([{ id: "ds_a", name: "Lease dispute" }]);
    const denied = await runTool(read, { source: "docs://ds_b/f2/p/1#0" } as never, { emit: () => {}, state: {}, principal });
    expect(denied.error?.code).toBe("unauthorized");
    expect(docs.readCalls).toEqual([]);
    const anon = await runTool(read, { source: "docs://ds_a/f1/p/3#0" } as never, { emit: () => {}, state: {} });
    expect(anon.error?.code).toBe("unauthorized");
    const ok = await runTool(read, { source: "docs://ds_a/f1/p/3#0" } as never, { emit: () => {}, state: {}, principal });
    expect(ok.ok).toBe(true);
  });

  it("adds judgment sources with a URL from a law tool round, and keeps old requests working", async () => {
    fake.rounds = [
      [{ type: "response.output_item.done", item: { type: "function_call", id: "fc1", call_id: "c1", name: "search_judgments", arguments: JSON.stringify({ query: "cheque dishonour" }) } }, { type: "response.completed", response: {} }],
      [{ type: "response.output_text.delta", delta: "See A v. B." }, { type: "response.completed", response: {} }],
    ];
    // No knowledge field (older callers): web follows flags.search, law on by default.
    const msg = await runChat({ history: [], attachments: [], principal, userId: "u_a", flags: { ...DEFAULT_TOOL_FLAGS, search: false }, signal: new AbortController().signal, send: () => {}, message: "cheque dishonour" });
    expect(toolNames(0)).toContain("search_judgments");
    expect(toolNames(0)).not.toContain("web_search");
    expect(msg.steps).toEqual(["Searched judgments: cheque dishonour (1 found)"]);
    expect(msg.sources).toEqual([{ url: "https://www.sci.gov.in/j1", title: "A v. B, 2024 INSC 1 (SC, 3-judge bench)" }]);
  });

  it("routes legal/analytic questions to the standard tier when law or documents are selected", () => {
    expect(routeMessage("What is section 138 of the NI Act?", DEFAULT_TOOL_FLAGS, { law: true }).tier).toBe("fast");
    expect(routeMessage("Whether a complaint under section 138 is maintainable after the limitation period?", DEFAULT_TOOL_FLAGS, { law: true }).tier).toBe("standard");
    expect(routeMessage("Whether a complaint under section 138 is maintainable after the limitation period?", DEFAULT_TOOL_FLAGS, { law: false }).tier).toBe("fast");
    expect(routeMessage("Build a timeline of the notices", DEFAULT_TOOL_FLAGS, { docs: true }).tier).toBe("standard");
    expect(routeMessage("Who signed the lease?", DEFAULT_TOOL_FLAGS, { docs: true }).tier).toBe("fast");
  });
});
