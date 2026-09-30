import type { NextRequest } from "next/server";
import { withDb } from "@/lib/db/request";
import { jsonError, sseResponse } from "@/lib/ai/sse";
import { AIConfigError } from "@/lib/ai/openai";
import { withAuth } from "@/lib/auth/route";
import { refs } from "@/lib/auth/resources";
import { currentPrincipal } from "@/lib/auth/context";
import { runChat } from "@/modules/chat/server/engine";
import { createThread, getThread, newId, saveThread } from "@/modules/chat/server/store";
import { DEFAULT_TOOL_FLAGS, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, MAX_TOTAL_ATTACHMENT_BYTES, type ChatAttachmentInput, type ChatEvent, type ChatMessage, type ChatRequest } from "@/modules/chat/types";

export const runtime = "nodejs";
/** A chat turn is bounded at 240s by the engine; the function allows up to 300s. */
export const maxDuration = 300;

const ALLOWED_MIME = /^(image\/(png|jpeg|gif|webp)|application\/pdf|text\/(plain|csv|markdown|html)|application\/json)$/;

function validAttachments(list: unknown): ChatAttachmentInput[] | string {
  if (list == null) return [];
  if (!Array.isArray(list)) return "attachments must be a list";
  if (list.length > MAX_ATTACHMENTS) return `At most ${MAX_ATTACHMENTS} attachments`;
  let total = 0;
  const out: ChatAttachmentInput[] = [];
  for (const a of list as Partial<ChatAttachmentInput>[]) {
    if (!a || typeof a.data !== "string" || typeof a.name !== "string" || typeof a.mime !== "string") return "Malformed attachment";
    if (!ALLOWED_MIME.test(a.mime)) return `${a.name}: this file type is not supported in chat`;
    const bytes = Math.floor((a.data.length * 3) / 4);
    if (bytes > MAX_ATTACHMENT_BYTES) return `${a.name} is larger than ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB`;
    total += bytes;
    out.push({ name: a.name.slice(0, 200), mime: a.mime, size: bytes, data: a.data });
  }
  if (total > MAX_TOTAL_ATTACHMENT_BYTES) return "Attachments are too large together";
  return out;
}

/** POST ChatRequest → SSE stream of ChatEvent; the turn is saved to the caller's thread. */
async function handlePOST(req: NextRequest) {
  const principal = currentPrincipal();
  if (!principal) return jsonError("Sign in to use chat", 401);
  const body = (await req.json().catch(() => null)) as ChatRequest | null;
  const message = typeof body?.message === "string" ? body.message.trim() : "";
  if (!message && !body?.regenerate) return jsonError("message is required", 422);
  if (message.length > 32_000) return jsonError("The message is too long", 422);
  const attachments = validAttachments(body?.attachments);
  if (typeof attachments === "string") return jsonError(attachments, 422);
  if (!process.env.OPENAI_API_KEY?.trim()) return jsonError(new AIConfigError().message, 503, { code: "ai_not_configured" });

  let thread = body?.threadId ? getThread(body.threadId, principal.id) : null;
  if (body?.threadId && !thread) return jsonError("Chat not found", 404);
  let prompt = message;
  let history: ChatMessage[];
  let userMessageId: string | undefined;
  if (body?.regenerate) {
    if (!thread) return jsonError("Nothing to regenerate", 422);
    const lastUser = [...thread.messages].reverse().find((m) => m.role === "user");
    if (!lastUser) return jsonError("Nothing to regenerate", 422);
    prompt = lastUser.text;
    const cut = thread.messages.lastIndexOf(lastUser);
    thread = saveThread({ ...thread, messages: thread.messages.slice(0, cut + 1) });
    history = thread.messages.slice(0, cut);
  } else {
    thread = thread ?? createThread(principal.id, message);
    history = thread.messages;
    const userMsg: ChatMessage = { id: newId("msg"), role: "user", text: message, createdAt: new Date().toISOString(), attachments: attachments.length ? attachments.map(({ name, mime, size }) => ({ name, mime, size })) : undefined };
    userMessageId = userMsg.id;
    thread = saveThread({ ...thread, messages: [...thread.messages, userMsg] });
  }
  const threadId = thread.id;
  const flags = { ...DEFAULT_TOOL_FLAGS, ...(body?.tools ?? {}) };

  return sseResponse(async (send, signal) => {
    const emit = (e: ChatEvent) => send(e);
    emit({ type: "thread", threadId, title: thread!.title, userMessageId });
    const answer = await runChat({ message: prompt, history, flags, attachments: body?.regenerate ? [] : attachments, principal, userId: principal.id, signal, send: emit });
    const current = getThread(threadId, principal.id);
    if (current) saveThread({ ...current, messages: [...current.messages, answer] });
    emit({ type: "done", message: answer });
  });
}

export const POST = withDb(withAuth(handlePOST, { action: "run", resource: () => refs.research() }));
