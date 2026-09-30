import type { NextRequest } from "next/server";
import { withDb } from "@/lib/db/request";
import { jsonError } from "@/lib/ai/sse";
import { withAuth } from "@/lib/auth/route";
import { refs } from "@/lib/auth/resources";
import { currentPrincipal } from "@/lib/auth/context";
import { deleteThread, getThread, setFeedback } from "@/modules/chat/server/store";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** GET → the caller's chat. Another user's chat is reported as not found. */
async function handleGET(_req: NextRequest, { params }: Ctx) {
  const principal = currentPrincipal();
  if (!principal) return jsonError("Sign in to use chat", 401);
  const thread = getThread((await params).id, principal.id);
  return thread ? Response.json({ thread }) : jsonError("Chat not found", 404);
}

/** PATCH { messageId, feedback: "up" | "down" | null } → records feedback on an answer. */
async function handlePATCH(req: NextRequest, { params }: Ctx) {
  const principal = currentPrincipal();
  if (!principal) return jsonError("Sign in to use chat", 401);
  const body = (await req.json().catch(() => ({}))) as { messageId?: string; feedback?: "up" | "down" | null };
  if (!body.messageId || !(body.feedback === "up" || body.feedback === "down" || body.feedback === null)) return jsonError("messageId and feedback are required", 422);
  const thread = setFeedback((await params).id, body.messageId, principal.id, body.feedback);
  return thread ? Response.json({ ok: true }) : jsonError("Chat not found", 404);
}

async function handleDELETE(_req: NextRequest, { params }: Ctx) {
  const principal = currentPrincipal();
  if (!principal) return jsonError("Sign in to use chat", 401);
  return deleteThread((await params).id, principal.id) ? Response.json({ ok: true }) : jsonError("Chat not found", 404);
}

export const GET = withDb(withAuth(handleGET, { action: "read", resource: () => refs.research() }));
export const PATCH = withDb(withAuth(handlePATCH, { action: "run", resource: () => refs.research() }));
export const DELETE = withDb(withAuth(handleDELETE, { action: "run", resource: () => refs.research() }));
