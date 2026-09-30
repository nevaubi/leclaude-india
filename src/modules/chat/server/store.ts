import "server-only";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import type { ChatMessage, ChatThread, ChatThreadSummary } from "../types";

/** Chat threads, one owner each. Only the owner reads, lists or deletes a thread. */
const threads = () => db().collection<ChatThread>("chat_threads");

const MAX_MESSAGES = 200;

export const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 20)}`;

export function titleFrom(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return "New chat";
  return t.length > 60 ? `${t.slice(0, 57).trimEnd()}…` : t;
}

export function getThread(id: string, ownerId: string): ChatThread | null {
  const t = threads().get(id);
  return t && t.ownerId === ownerId ? t : null;
}

export function listThreads(ownerId: string, limit = 30): ChatThreadSummary[] {
  return threads().find((t) => t.ownerId === ownerId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit)
    .map((t) => ({ id: t.id, title: t.title, updatedAt: t.updatedAt, messages: t.messages.length }));
}

export function createThread(ownerId: string, firstMessage: string): ChatThread {
  const now = new Date().toISOString();
  return threads().put({ id: newId("chat"), ownerId, title: titleFrom(firstMessage), messages: [], createdAt: now, updatedAt: now });
}

export function saveThread(t: ChatThread): ChatThread {
  return threads().put({ ...t, messages: t.messages.slice(-MAX_MESSAGES), updatedAt: new Date().toISOString() });
}

export function deleteThread(id: string, ownerId: string): boolean {
  const t = getThread(id, ownerId);
  return t ? threads().delete(id) : false;
}

export function setFeedback(threadId: string, messageId: string, ownerId: string, feedback: ChatMessage["feedback"] | null): ChatThread | null {
  const t = getThread(threadId, ownerId);
  if (!t) return null;
  const messages = t.messages.map((m) => (m.id === messageId && m.role === "assistant" ? { ...m, feedback: feedback ?? undefined } : m));
  return saveThread({ ...t, messages });
}
