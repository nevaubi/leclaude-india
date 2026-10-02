import { NextRequest } from "next/server";
import { jsonError } from "@/lib/ai/sse";
import { withDb } from "@/lib/db/request";
import { withAuth } from "@/lib/auth/route";
import { requirePrincipal } from "@/lib/auth/context";
import { audit } from "@/lib/integrity/audit";
import { getOfficeDoc } from "@/modules/office/shared/docs-service";
import { officeDocFromBody } from "@/modules/office/shared/route-auth";
import { ensureBlockIds, type PMNode } from "@/modules/office/word/doc-model";
import { docBodyHash, filingCheckFor } from "@/modules/office/word/filing-check-server";

export const runtime = "nodejs";
export const maxDuration = 120;

interface Body {
  docId?: string;
  /** Current editor content (may be unsaved); falls back to the stored document. */
  content?: PMNode;
  /** Re-run instead of reusing a check of the same body from the last few minutes. */
  fresh?: boolean;
  /** Record the user's acknowledgement of the gate (export paths that write no file the server can stamp, e.g. print). */
  acknowledge?: { format?: string; docHash?: string; items?: number; issueKeys?: string[]; declaration?: boolean } | null;
}

/**
 * POST /api/office/word/filing-check { docId?, content?, fresh? } → { report: FilingCheckReport }: citations resolved
 * through the India citation check (resolved / ambiguous / unresolved, never substituted), citator negative text cues
 * for resolved judgments, and quotation checks against judgment text where it is available.
 * POST { …, acknowledge: { format, docHash, items, issueKeys } } → { ok, matchesDocument } and an audit record.
 */
async function handlePOST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as Body | null;
  if (!body) return jsonError("Invalid body");
  let content = body.content;
  let title = "Document";
  let matterId: string | undefined;
  if (body.docId) {
    const doc = getOfficeDoc(body.docId);
    if (!doc) return jsonError("Document not found", 404);
    content = content ?? (doc.content as PMNode);
    title = doc.title;
    matterId = doc.matterId ?? undefined;
  }
  if (!content || content.type !== "doc") return jsonError("`content` (ProseMirror doc) or `docId` is required");
  const doc = ensureBlockIds(content);
  if (body.acknowledge && typeof body.acknowledge === "object") {
    const principal = requirePrincipal();
    const hash = docBodyHash(doc);
    const a = body.acknowledge;
    const matches = a.docHash === hash;
    try {
      audit("export", { kind: "officeDoc", id: body.docId, label: title, matterId }, {
        format: String(a.format ?? "pdf").slice(0, 20), docHash: hash, filingCheckAcknowledged: true, acknowledgedItems: Math.max(0, Math.floor(Number(a.items) || 0)),
        issueKeys: Array.isArray(a.issueKeys) ? a.issueKeys.filter((k) => typeof k === "string").slice(0, 100).map((k) => k.slice(0, 120)) : [], ackMatchesDocument: matches, declaration: a.declaration === true,
      }, { id: principal.id, name: principal.name });
    } catch (e) {
      console.warn("[word filing-check] audit failed", (e as Error).message);
    }
    return Response.json({ ok: true, matchesDocument: matches, docHash: hash });
  }
  const report = await filingCheckFor(doc, { fresh: body.fresh === true, signal: req.signal });
  return Response.json({ report });
}

export const POST = withDb(withAuth(handlePOST, { action: "read", resource: officeDocFromBody }));
