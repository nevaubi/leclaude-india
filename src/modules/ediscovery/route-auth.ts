import "server-only";
import { db } from "@/lib/db";
import { jsonBody, queryParam, refs } from "@/lib/auth/resources";
import { hasMatterAccess } from "@/lib/auth/policy";
import { withAuth } from "@/lib/auth/route";
import type { Action, Principal, ResourceKind, ResourceRef } from "@/lib/auth/types";

/**
 * Route-boundary authorization for the e-discovery API (constitution §22). Every route resolves the principal and
 * authorizes against the record's real matter:
 *
 *   - routes with an `[id]` look the record up (document, deposition, conflict, story, batch, production, saved
 *     search, issue code) and authorize against its matter (documents also carry their privilege sensitivity);
 *   - collection routes authorize against `?matter=` / `?matterId=` or the JSON body's `matterId`;
 *   - routes that act on records named by `?id=`, `?doc=`, body `id` / `ids` / `docId` (`records`) authorize against
 *     every referenced record's matter: one inaccessible record denies the whole request.
 *
 * `matterFrom()` (api-utils.ts) re-checks the resolved matter against the principal, so a body that names a matter
 * the principal cannot access is refused even when the route-level ref had no matter.
 */
export type EdLookup = "edoc" | "deposition" | "conflict" | "story" | "batch" | "production" | "savedSearch" | "issueCode";

const COLLECTIONS: Record<Exclude<EdLookup, "edoc" | "deposition">, string> = {
  conflict: "conflicts",
  story: "ediscovery_stories",
  batch: "ediscovery_batches",
  production: "ediscovery_productions",
  savedSearch: "ediscovery_saved_searches",
  issueCode: "issue_codes",
};

const KIND: Partial<Record<EdLookup, ResourceKind>> = { deposition: "deposition", conflict: "conflict" };

export interface EdAuthOptions {
  /** Defaults by method: GET/HEAD → read, anything else → write. */
  action?: Action;
  /** Look the `[id]` param up in this record type. */
  lookup?: EdLookup;
  /** Resource kind when there is no lookup (default "document"). */
  kind?: ResourceKind;
  /** Collection holding records referenced by `?id=` / body `id` / `ids` (each must carry `matterId`). */
  records?: string;
  /** Also resolve `?doc=` / body `docId` as e-discovery documents. */
  docRefs?: boolean;
}

function defaultAction(req: Request): Action {
  const m = req.method.toUpperCase();
  return m === "GET" || m === "HEAD" ? "read" : "write";
}

async function resourceFor(req: Request, params: Record<string, string | string[] | undefined>, principal: Principal, opts: EdAuthOptions): Promise<ResourceRef> {
  const id = typeof params.id === "string" ? params.id : undefined;
  if (opts.lookup && id) {
    if (opts.lookup === "edoc") return refs.edoc(id);
    if (opts.lookup === "deposition") return refs.deposition(id);
    const rec = db().collection<{ id: string; matterId?: string }>(COLLECTIONS[opts.lookup]).get(id);
    return { kind: KIND[opts.lookup] ?? "document", id, matterId: rec?.matterId };
  }
  const read = defaultAction(req) === "read";
  const body = read ? {} : await jsonBody(req);
  const bodyMatter = typeof body.matterId === "string" ? body.matterId : typeof body.matter === "string" ? body.matter : undefined;
  const matters: string[] = [];
  const explicit = queryParam(req, "matter", "matterId") ?? bodyMatter;
  if (explicit) matters.push(explicit);
  const strings = (v: unknown): string[] => (typeof v === "string" && v ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x) : []);
  if (opts.records) {
    const ids = [...strings(queryParam(req, "id")), ...strings(body.id), ...strings(body.ids)].slice(0, 5000);
    const col = db().collection<{ id: string; matterId?: string }>(opts.records);
    for (const rid of ids) {
      const m = col.get(rid)?.matterId;
      if (m) matters.push(m);
    }
  }
  if (opts.docRefs) {
    for (const did of [...strings(queryParam(req, "doc")), ...strings(body.docId)]) {
      const m = db().edocs.get(did)?.matterId;
      if (m) matters.push(m);
    }
  }
  return { kind: opts.kind ?? "document", matterId: pickMatter(principal, matters) };
}

/** The first referenced matter the principal cannot access (so the policy denies), else the first one. */
function pickMatter(principal: Principal, matters: string[]): string | undefined {
  return matters.find((m) => !hasMatterAccess(principal, m)) ?? matters[0];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRouteHandler = (...args: any[]) => Response | Promise<Response>;

export function edAuth<H extends AnyRouteHandler>(handler: H, opts: EdAuthOptions = {}): H {
  return withAuth<H, Record<string, string | string[] | undefined>>(handler, {
    action: (req) => opts.action ?? defaultAction(req),
    resource: (req, params, principal) => resourceFor(req, params, principal, opts),
  });
}
