import "server-only";
import { after } from "next/server";
import { cache } from "react";
import { flushDb, remoteEnabled, syncDb } from "./sync";

/**
 * Request boundaries for the shared store (see sync.ts). Every API route handler is wrapped with
 * `withDb` and every server page/layout calls `await pageDb()`. Without a remote store both are
 * pass-through.
 */

function unavailable(message: string, code: string): Response {
  return Response.json({ error: message, code }, { status: 503 });
}

/** True on hosts whose instances do not share a disk (Vercel, AWS Lambda). */
export function serverlessHost(): boolean {
  return Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
}

function isWrite(req: unknown): boolean {
  const method = (req as { method?: string } | undefined)?.method?.toUpperCase();
  return !!method && method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

function isStreaming(res: Response): boolean {
  const type = res.headers.get("content-type") ?? "";
  return /event-stream|ndjson|x-sse/i.test(type);
}

function scheduleFlush(): void {
  try {
    after(async () => {
      try { await flushDb(); } catch { /* logged by flushDb; retried on the next request */ }
    });
  } catch {
    /* outside a request scope (tests, scripts) */
  }
}

/** Wrap a route handler: sync before, make writes durable before the response is sent. */
export function withDb<A extends unknown[]>(handler: (...args: A) => Response | Promise<Response>): (...args: A) => Promise<Response> {
  return async (...args: A): Promise<Response> => {
    if (!remoteEnabled()) {
      // On a serverless host every request may run on a different instance with its own empty disk, so a write
      // without a shared database would be lost on the next request. Refuse writes with a clear message instead.
      if (serverlessHost() && isWrite(args[0])) {
        return unavailable("This deployment has no database, so changes cannot be saved. Add a Postgres database (Vercel → Storage → Neon, which sets DATABASE_URL) and redeploy.", "db_not_configured");
      }
      return handler(...args);
    }
    try {
      await syncDb();
    } catch (e) {
      console.error(JSON.stringify({ level: "error", event: "db.sync_failed", error: (e as Error).message }));
      return unavailable("The database is unavailable. Try again in a moment.", "db_unavailable");
    }
    let res: Response;
    try {
      res = await handler(...args);
    } catch (e) {
      try { await flushDb(); } catch { /* the handler error is the one to report */ }
      throw e;
    }
    if (isStreaming(res) && res.body) {
      // Writes happen while the stream runs: flush when it ends, and again after the response as a safety net.
      const flushing = new TransformStream<Uint8Array, Uint8Array>({
        async flush() {
          try { await flushDb(); } catch { /* retried by the after() hook and the next request */ }
        },
      });
      scheduleFlush();
      return new Response(res.body.pipeThrough(flushing), { status: res.status, statusText: res.statusText, headers: res.headers });
    }
    try {
      await flushDb();
    } catch {
      return unavailable("Your change could not be saved. Try again in a moment.", "db_write_failed");
    }
    return res;
  };
}

/** Call at the top of every server page and layout: brings the mirror up to date and persists any writes made while rendering. */
// Request-local memoization: layout, metadata and page share one sync; never caches across users.
export const pageDb = cache(async (): Promise<void> => {
  if (!remoteEnabled()) return;
  await syncDb();
  scheduleFlush();
});
