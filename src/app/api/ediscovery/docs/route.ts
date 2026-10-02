import { withDb } from "@/lib/db/request";
import { edAuth } from "@/modules/ediscovery/route-auth";
import type { NextRequest } from "next/server";
import { jsonError } from "@/lib/ai/sse";
import { errorResponse, matterFrom, readJson } from "@/modules/ediscovery/api-utils";
import { createDocument, type CreateDocumentInput } from "@/modules/ediscovery/service";

export const runtime = "nodejs";

/**
 * POST { matterId, bates, date, custodianId, type, subject, text, from?, to?, cc?, family?, coding?, source? }
 * → 201 { doc, duplicateOf: EDocument | null, created } — the content hash is computed and an identical document in the
 * matter is linked through `isDuplicateOf`. A Bates number already in the matter → 409 { error, existingId }.
 */
async function POST__handler(req: NextRequest) {
  const body = await readJson<Partial<CreateDocumentInput> & { matterId?: string }>(req);
  const m = matterFrom(req, body);
  if ("error" in m) return m.error;
  if (!body?.bates?.trim() || !body.subject?.trim() || typeof body.text !== "string") return jsonError("`bates`, `subject` and `text` are required");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(body.date ?? "")) return jsonError("`date` must be YYYY-MM-DD");
  try {
    const res = createDocument({ ...body, matterId: m.matterId, bates: body.bates.trim(), date: body.date!, custodianId: body.custodianId ?? "unknown", type: body.type ?? "Other", subject: body.subject.trim(), text: body.text } as CreateDocumentInput, { source: body.source ?? "api" });
    return Response.json({ doc: res.doc, duplicateOf: res.duplicateOf, created: res.created }, { status: res.created ? 201 : 200 });
  } catch (e) {
    const err = e as { status?: number; message: string; existingId?: string };
    if (err.status === 409) return jsonError(err.message, 409, { existingId: err.existingId });
    return errorResponse(e);
  }
}

export const POST = withDb(edAuth(POST__handler));
