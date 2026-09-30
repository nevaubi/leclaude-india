import { withDb } from "@/lib/db/request";
import { jsonError } from "@/lib/ai/sse";
import { withAuth } from "@/lib/auth/route";
import { refs } from "@/lib/auth/resources";
import { currentPrincipal } from "@/lib/auth/context";
import { listThreads } from "@/modules/chat/server/store";

export const runtime = "nodejs";

/** GET → the caller's recent chats (summaries). */
async function handleGET() {
  const principal = currentPrincipal();
  if (!principal) return jsonError("Sign in to use chat", 401);
  return Response.json({ threads: listThreads(principal.id) });
}

export const GET = withDb(withAuth(handleGET, { action: "read", resource: () => refs.research() }));
