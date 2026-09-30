import "server-only";
import { db } from "@/lib/db";
import { getOpenAI } from "@/lib/ai/openai";
import { isReasoningModel } from "@/lib/ai/providers/openai-models";
import { fetchUrlTool } from "@/lib/ai/toolkit/web";
import type { AgentEmit, ToolContext } from "@/lib/ai/tools";
import type { Principal } from "@/lib/auth/types";
import type { ChatAttachmentInput, ChatEvent, ChatFile, ChatMessage, ChatSource, ChatToolFlags } from "../types";
import { chatModels, routeMessage, type ChatRoute } from "./routing";
import { newId } from "./store";

/**
 * The Chat engine: one streaming OpenAI Responses call per round, OpenAI's native tools (web search, code interpreter,
 * image generation) plus two local function tools (fetch_url for reading a page, create_file for text documents),
 * function calls executed in parallel, at most MAX_ROUNDS rounds, and a hard deadline under the function limit.
 * Nothing here is legal research of record: answers are labelled as chat, and deep work goes to Research.
 */

const MAX_ROUNDS = 6;
const HISTORY_TURNS = 16;
const DEADLINE_MS = 240_000;

const INSTRUCTIONS = [
  "You are the quick assistant inside LeClaude India, a litigation platform for Indian practice. Be fast, direct and friendly. Use Indian legal usage and formats (neutral citations, INR in lakh/crore, DD Month YYYY) unless the user asks otherwise; reply in the language the user writes in. Answer in clear, well-structured Markdown: lead with the answer, then short supporting points. Use headings or tables only when they help.",
  "Use web search for anything current, factual or checkable, and cite what you rely on with the links from your search results. Say plainly when something could not be verified. Never invent citations, quotes, case names or numbers.",
  "Use the code interpreter for calculations, data files, charts, and to produce files the user asks for (spreadsheets, Word documents, PDFs, CSVs); mention the file you produced. Use create_file for simple text, Markdown, CSV, HTML or JSON documents.",
  "Use fetch_url to read a specific page the user links to or that you need to read in full.",
  "This chat is for quick tasks. For exhaustive legal research with verified citations, suggest the Research page.",
].join("\n");

export interface RunChatInput {
  message: string;
  history: ChatMessage[];
  flags: ChatToolFlags;
  attachments: ChatAttachmentInput[];
  principal: Principal | null;
  userId: string;
  signal: AbortSignal;
  send: (e: ChatEvent) => void;
}

interface Step { id: string; label: string }

function storeFile(bytes: Uint8Array, name: string, mime: string, kind: ChatFile["kind"], ownerId: string): ChatFile {
  const safe = name.replace(/[^\w.\- ()]+/g, "_").slice(0, 120) || "file";
  const rec = db().blobs.put(bytes, mime, { name: safe, meta: { kind: "chat.output", ownerId } });
  return { id: rec.id, name: safe, mime, size: bytes.byteLength, url: `/api/blobs/${rec.id}`, kind };
}

const MIME_BY_EXT: Record<string, string> = {
  csv: "text/csv", md: "text/markdown", txt: "text/plain", html: "text/html", json: "application/json",
  pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", svg: "image/svg+xml",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation", zip: "application/zip",
};
export const mimeFor = (name: string) => MIME_BY_EXT[name.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";

const CREATE_FILE_TOOL = {
  type: "function" as const,
  name: "create_file",
  description: "Create a downloadable text document for the user (Markdown, plain text, CSV, HTML or JSON). For spreadsheets, Word documents, PDFs or charts use the code interpreter instead.",
  strict: true,
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      filename: { type: "string", description: "File name with extension, e.g. timeline.md or damages.csv" },
      content: { type: "string", description: "Full file content" },
    },
    required: ["filename", "content"],
  },
};

const FETCH_URL_TOOL = {
  type: "function" as const,
  name: "fetch_url",
  description: "Fetch a public web page, JSON or plain-text URL and return its readable text (public http(s) hosts only).",
  strict: true,
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: { url: { type: "string", description: "Absolute http(s) URL" } },
    required: ["url"],
  },
};

function toolsFor(route: ChatRoute): unknown[] {
  const t: unknown[] = [CREATE_FILE_TOOL];
  if (route.tools.search) t.push({ type: "web_search", search_context_size: route.tier === "fast" ? "low" : "medium", user_location: { type: "approximate", country: "US" } });
  if (route.tools.browse || route.tools.search) t.push(FETCH_URL_TOOL);
  if (route.tools.code) t.push({ type: "code_interpreter", container: { type: "auto" } });
  if (route.tools.image) t.push({ type: "image_generation", size: "1024x1024", quality: "medium" });
  return t;
}

function historyInput(history: ChatMessage[]): unknown[] {
  return history.slice(-HISTORY_TURNS * 2).filter((m) => m.text.trim()).map((m) => ({ role: m.role, content: m.text }));
}

function userInput(message: string, attachments: ChatAttachmentInput[]): unknown {
  if (!attachments.length) return { role: "user", content: message };
  const parts: unknown[] = [];
  for (const a of attachments) {
    if (a.mime.startsWith("image/")) parts.push({ type: "input_image", image_url: `data:${a.mime};base64,${a.data}`, detail: "auto" });
    else if (a.mime === "application/pdf") parts.push({ type: "input_file", filename: a.name, file_data: `data:${a.mime};base64,${a.data}` });
    else {
      const text = Buffer.from(a.data, "base64").toString("utf8").slice(0, 200_000);
      parts.push({ type: "input_text", text: `Attached file ${a.name}:\n${text}` });
    }
  }
  parts.push({ type: "input_text", text: message });
  return { role: "user", content: parts };
}

function stepLabelForSearch(action: { type?: string; query?: string; url?: string } | undefined): string {
  if (action?.type === "open_page" && action.url) { try { return `Opened ${new URL(action.url).host}`; } catch { return "Opened a page"; } }
  if (action?.type === "find_in_page") return "Looked within a page";
  return action?.query ? `Searched: ${action.query}` : "Searched the web";
}

type AnyEvent = { type: string; [k: string]: unknown };
type OutputItem = { type: string; id?: string; call_id?: string; name?: string; arguments?: string; action?: { type?: string; query?: string; url?: string }; result?: string; status?: string };

/** Run one chat turn, streaming events; resolves with the final assistant message (never throws for model failures). */
export async function runChat(input: RunChatInput): Promise<ChatMessage> {
  const started = Date.now();
  const client = getOpenAI();
  const models = await chatModels(input.signal);
  const route = routeMessage(input.message, input.flags, { attachments: input.attachments.length, historyTurns: input.history.length / 2 });
  const model = route.tier === "fast" ? models.fast : models.standard;
  const tools = toolsFor(route);
  input.send({ type: "route", tier: route.tier, model, tools: Object.entries(route.tools).filter(([, v]) => v).map(([k]) => k) });

  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), DEADLINE_MS);
  const onAbort = () => deadline.abort();
  input.signal.addEventListener("abort", onAbort, { once: true });

  let text = "";
  const sources: ChatSource[] = [];
  const files: ChatFile[] = [];
  const steps: Step[] = [];
  const seenSources = new Set<string>();
  const containerFiles: { containerId: string; fileId: string; filename: string }[] = [];
  let status: ChatMessage["status"] = "complete";
  let error: string | undefined;
  let conversation: unknown[] = [...historyInput(input.history), userInput(input.message, input.attachments)];

  const step = (label: string, state: "running" | "done" | "failed", id = newId("st")) => {
    input.send({ type: "step", id, label, state });
    if (state !== "running") { const at = steps.findIndex((s) => s.id === id); if (at >= 0) steps[at] = { id, label }; else steps.push({ id, label }); }
    else if (!steps.some((s) => s.id === id)) steps.push({ id, label });
    return id;
  };
  const addSource = (url: string, title?: string) => {
    if (!url || seenSources.has(url)) return;
    seenSources.add(url);
    const s = { url, title: title || url };
    sources.push(s);
    input.send({ type: "source", source: s });
  };

  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const params: Record<string, unknown> = {
        model,
        instructions: INSTRUCTIONS,
        input: conversation,
        tools,
        stream: true,
        store: false,
        parallel_tool_calls: true,
        max_output_tokens: isReasoningModel(model) ? route.maxOutputTokens + 12_000 : route.maxOutputTokens,
        include: isReasoningModel(model) ? ["reasoning.encrypted_content"] : [],
      };
      if (isReasoningModel(model)) { params.reasoning = { effort: route.effort }; params.text = { verbosity: route.verbosity }; }

      const stream = (await client.responses.create(params as never, { signal: deadline.signal })) as unknown as AsyncIterable<AnyEvent>;
      const outputItems: OutputItem[] = [];
      const running = new Map<string, string>();
      let incomplete: string | undefined;

      for await (const ev of stream) {
        if (ev.type === "response.output_text.delta") {
          const d = String(ev.delta ?? "");
          text += d;
          input.send({ type: "delta", text: d });
        } else if (ev.type === "response.output_item.added") {
          const item = ev.item as OutputItem;
          const key = item.id ?? item.call_id ?? newId("it");
          if (item.type === "web_search_call") running.set(key, step("Searching the web", "running"));
          else if (item.type === "code_interpreter_call") running.set(key, step("Running code", "running"));
          else if (item.type === "image_generation_call") running.set(key, step("Creating an image", "running"));
        } else if (ev.type === "response.output_item.done") {
          const item = ev.item as OutputItem;
          outputItems.push(item);
          const key = item.id ?? item.call_id ?? "";
          const sid = running.get(key);
          if (item.type === "web_search_call") step(stepLabelForSearch(item.action), item.status === "failed" ? "failed" : "done", sid);
          else if (item.type === "code_interpreter_call") step("Ran code", item.status === "failed" ? "failed" : "done", sid);
          else if (item.type === "image_generation_call") {
            if (item.result) {
              const f = storeFile(Uint8Array.from(Buffer.from(item.result, "base64")), `image-${files.length + 1}.png`, "image/png", "image", input.userId);
              files.push(f);
              input.send({ type: "file", file: f });
              step("Created an image", "done", sid);
            } else step("Image could not be created", "failed", sid);
          }
        } else if (ev.type === "response.output_text.annotation.added") {
          const a = ev.annotation as { type?: string; url?: string; title?: string; container_id?: string; file_id?: string; filename?: string };
          if (a?.type === "url_citation" && a.url) addSource(a.url, a.title);
          if (a?.type === "container_file_citation" && a.container_id && a.file_id && !containerFiles.some((c) => c.fileId === a.file_id)) containerFiles.push({ containerId: a.container_id, fileId: a.file_id, filename: a.filename ?? "output" });
        } else if (ev.type === "response.incomplete") {
          incomplete = (ev.response as { incomplete_details?: { reason?: string } })?.incomplete_details?.reason ?? "unknown";
        } else if (ev.type === "response.failed" || ev.type === "error") {
          const msg = (ev.response as { error?: { message?: string } } | undefined)?.error?.message ?? String((ev as { message?: string }).message ?? "The model failed to respond");
          throw new Error(msg);
        }
      }

      const calls = outputItems.filter((i) => i.type === "function_call");
      if (!calls.length) {
        if (incomplete) { status = "incomplete"; error = incomplete === "max_output_tokens" ? "The answer reached the length limit." : `The answer stopped early (${incomplete}).`; }
        break;
      }
      // Function calls run in parallel; each result goes back to the model in the next round.
      const results = await Promise.all(calls.map(async (c) => {
        let args: Record<string, unknown> = {};
        try { args = c.arguments ? JSON.parse(c.arguments) : {}; } catch { args = {}; }
        const sid = step(c.name === "fetch_url" ? `Reading ${hostOf(String(args.url ?? ""))}` : c.name === "create_file" ? `Creating ${String(args.filename ?? "a file")}` : c.name ?? "Working", "running");
        try {
          const out = await runFunction(c.name ?? "", args, input, deadline.signal, addSource, (f) => { files.push(f); input.send({ type: "file", file: f }); });
          step(c.name === "fetch_url" ? `Read ${hostOf(String(args.url ?? ""))}` : c.name === "create_file" ? `Created ${String(args.filename ?? "a file")}` : "Done", "done", sid);
          return { type: "function_call_output", call_id: c.call_id, output: JSON.stringify(out).slice(0, 60_000) };
        } catch (e) {
          step(`${c.name === "fetch_url" ? `Could not read ${hostOf(String(args.url ?? ""))}` : `${c.name} failed`}`, "failed", sid);
          return { type: "function_call_output", call_id: c.call_id, output: JSON.stringify({ error: (e as Error).message.slice(0, 300) }) };
        }
      }));
      conversation = [...conversation, ...outputItems, ...results];
      if (round === MAX_ROUNDS - 1) { status = "incomplete"; error = "Stopped after the maximum number of tool rounds."; }
    }
  } catch (e) {
    if (input.signal.aborted) { status = "stopped"; }
    else if (deadline.signal.aborted) { status = "incomplete"; error = "The answer took too long and was stopped; try a narrower question or use Research."; }
    else { status = "error"; error = friendlyError(e); }
  } finally {
    clearTimeout(timer);
    input.signal.removeEventListener("abort", onAbort);
  }

  // Files the code interpreter produced: copied into the workspace so the links keep working after the container expires.
  for (const c of containerFiles) {
    try {
      const res = await client.containers.files.content.retrieve(c.fileId, { container_id: c.containerId });
      const bytes = new Uint8Array(await res.arrayBuffer());
      const f = storeFile(bytes, c.filename, mimeFor(c.filename), mimeFor(c.filename).startsWith("image/") ? "image" : "file", input.userId);
      files.push(f);
      input.send({ type: "file", file: f });
    } catch {
      steps.push({ id: newId("st"), label: `Could not retrieve ${c.filename}` });
    }
  }

  return {
    id: newId("msg"),
    role: "assistant",
    text,
    createdAt: new Date().toISOString(),
    sources: sources.length ? sources : undefined,
    files: files.length ? files : undefined,
    steps: steps.length ? steps.map((s) => s.label) : undefined,
    model,
    tier: route.tier,
    durationMs: Date.now() - started,
    status,
    error,
  };
}

function hostOf(url: string): string { try { return new URL(url).host; } catch { return "the page"; } }

async function runFunction(name: string, args: Record<string, unknown>, input: RunChatInput, signal: AbortSignal, addSource: (url: string, title?: string) => void, addFile: (f: ChatFile) => void): Promise<unknown> {
  if (name === "fetch_url") {
    const emit = (e: AgentEmit) => { const c = (e as { type?: string; citation?: { url?: string; title?: string } }).citation; if (c?.url) addSource(c.url, c.title); };
    const ctx: ToolContext = { emit, signal, state: { userId: input.userId }, principal: input.principal ?? undefined };
    return fetchUrlTool.execute({ url: String(args.url ?? ""), max_chars: 20_000 }, ctx);
  }
  if (name === "create_file") {
    const filename = String(args.filename ?? "document.txt").slice(0, 120);
    const content = String(args.content ?? "");
    if (content.length > 2_000_000) throw new Error("File content is too large");
    const f = storeFile(new TextEncoder().encode(content), filename, mimeFor(filename), "file", input.userId);
    addFile(f);
    return { created: f.name, url: f.url, bytes: f.size };
  }
  throw new Error(`Unknown tool ${name}`);
}

function friendlyError(e: unknown): string {
  const err = e as { status?: number; message?: string };
  if (err.status === 401 || err.status === 403) return "The OpenAI key was rejected. Check OPENAI_API_KEY.";
  if (err.status === 429) return "OpenAI is rate limiting requests right now. Try again in a moment.";
  if (err.status === 404) return "The chat model is not available to this OpenAI key. Set CHAT_MODEL to a model the key can use.";
  if (err.status && err.status >= 500) return "OpenAI had a server error. Try again.";
  return (err.message ?? "Something went wrong").slice(0, 300);
}
