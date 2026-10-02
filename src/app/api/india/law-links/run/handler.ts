import "server-only";
import { jsonError } from "@/lib/ai/sse";
import type { Principal } from "@/lib/auth/types";
import { remoteStore, type RemoteStore } from "@/lib/db/remote";
import { ingestGate } from "@/app/api/official/run/handler";
import { lawStore } from "@/modules/india/law/common";
import { runOfficialSectionsLoad } from "@/modules/india/law/official-sections";
import { runScrLoad } from "@/modules/india/scr/load";
import { runStatuteMetaBuild } from "@/modules/india/statute-links/build";

/**
 * POST /api/india/law-links/run — the statute / Supreme Court layer loaders, gated exactly like /api/official/run:
 * `run` on intel (route wrapper) AND the ingest token (x-official-token = OFFICIAL_INGEST_TOKEN), or the cron service
 * principal. Tasks run in the order given, sharing the deadline:
 *   - "scr": Supreme Court Reports register (official cards → scr_reports, exact links to corpus_judgments);
 *   - "statute-meta": statute ↔ judgment links from judgment metadata (official headnotes);
 *   - "indiacode-sections": India Code section text + amendment footnotes for statutes-collection Central Acts.
 * Each task resumes from its stored position; call again to continue. GET (cron) runs all three when LAW_LINKS_INGEST=1.
 */

export const TASKS = ["scr", "statute-meta", "indiacode-sections"] as const;
export type LawLinksTask = (typeof TASKS)[number];

export interface LawLinksBody { tasks: LawLinksTask[]; deadlineMs: number; restart: boolean; limit?: number }

export function parseLawLinksBody(raw: unknown): LawLinksBody {
  const b = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const out: LawLinksBody = { tasks: [...TASKS], deadlineMs: 240_000, restart: false };
  if (b.tasks !== undefined) {
    if (!Array.isArray(b.tasks) || !b.tasks.length || !b.tasks.every((t) => (TASKS as readonly unknown[]).includes(t))) throw new RangeError(`tasks must be a non-empty subset of ${TASKS.join(", ")}`);
    out.tasks = [...new Set(b.tasks as LawLinksTask[])];
  }
  if (b.deadlineMs !== undefined) {
    if (typeof b.deadlineMs !== "number" || !Number.isFinite(b.deadlineMs)) throw new RangeError("deadlineMs must be a number");
    out.deadlineMs = Math.max(15_000, Math.min(Math.floor(b.deadlineMs), 280_000));
  }
  if (b.restart !== undefined) {
    if (typeof b.restart !== "boolean") throw new RangeError("restart must be a boolean");
    out.restart = b.restart;
  }
  if (b.limit !== undefined) {
    if (typeof b.limit !== "number" || !Number.isInteger(b.limit) || b.limit < 1 || b.limit > 500) throw new RangeError("limit must be an integer between 1 and 500");
    out.limit = b.limit;
  }
  return out;
}

type Runner = (o: { store: RemoteStore; deadlineMs: number; restart: boolean; limit?: number }) => Promise<unknown>;

export interface LawLinksDeps {
  principal: () => Principal | null;
  vars?: Readonly<Record<string, string | undefined>>;
  store?: RemoteStore | null;
  now?: () => number;
  runners?: Partial<Record<LawLinksTask, Runner>>;
}

const DEFAULT_RUNNERS: Record<LawLinksTask, Runner> = {
  scr: (o) => runScrLoad({ store: o.store, deadlineMs: o.deadlineMs, restart: o.restart }),
  "statute-meta": (o) => runStatuteMetaBuild({ store: o.store, deadlineMs: o.deadlineMs, restart: o.restart }),
  "indiacode-sections": async (o) => runOfficialSectionsLoad({ store: await lawStore(o.store), deadlineMs: o.deadlineMs, limit: o.limit }),
};

export async function runLawLinks(body: LawLinksBody, deps: LawLinksDeps): Promise<Response> {
  const store = deps.store === undefined ? remoteStore() : deps.store;
  if (!store) return jsonError("The corpus database is not configured on this deployment (DATABASE_URL).", 503, { code: "corpus_not_configured" });
  const now = deps.now ?? Date.now;
  const end = now() + body.deadlineMs;
  const results: Record<string, unknown> = {};
  for (let k = 0; k < body.tasks.length; k++) {
    const task = body.tasks[k];
    const share = Math.floor((end - now()) / (body.tasks.length - k));
    if (share < 15_000) { results[task] = { stop: "no_time" }; continue; }
    try {
      results[task] = await (deps.runners?.[task] ?? DEFAULT_RUNNERS[task])({ store, deadlineMs: share, restart: body.restart, limit: body.limit });
    } catch (e) {
      const msg = (e as Error).message;
      console.error(JSON.stringify({ level: "error", event: "law_links.task_failed", task, error: msg.slice(0, 300) }));
      results[task] = { stop: "error", error: msg.slice(0, 300) };
    }
  }
  console.info(JSON.stringify({ level: "info", event: "law_links.run", tasks: body.tasks }));
  return Response.json({ tasks: body.tasks, results });
}

export async function handleLawLinksPost(req: Request, deps: LawLinksDeps): Promise<Response> {
  const gate = ingestGate(req, deps.principal(), deps.vars ?? process.env);
  if (!gate.ok) return jsonError(gate.message, gate.status, { code: gate.code });
  let body: LawLinksBody;
  try { body = parseLawLinksBody(await req.json().catch(() => ({}))); } catch (e) { return jsonError((e as Error).message, 400, { code: "bad_request" }); }
  return runLawLinks(body, deps);
}

export async function handleLawLinksCron(deps: LawLinksDeps): Promise<Response> {
  const vars = deps.vars ?? process.env;
  const p = deps.principal();
  if (!(p && p.source === "service" && p.roles.includes("service"))) return jsonError("Scheduled law-link runs are only started by the cron service principal; use POST with the ingest token.", 403, { code: "service_only" });
  if (vars.LAW_LINKS_INGEST !== "1") return Response.json({ stop: "disabled", notes: ["LAW_LINKS_INGEST is not 1"] });
  return runLawLinks({ tasks: [...TASKS], deadlineMs: 240_000, restart: false }, deps);
}
