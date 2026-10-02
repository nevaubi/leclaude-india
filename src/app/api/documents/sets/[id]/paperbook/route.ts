import type { NextRequest } from "next/server";
import { withDb } from "@/lib/db/request";
import { withAuth } from "@/lib/auth/route";
import { jsonError } from "@/lib/ai/sse";
import { PAPERBOOK_LIMITS } from "@/modules/documents/drafting";
import { buildPaperbook, type PaperbookUpload } from "@/modules/documents/server/paperbook";
import { DOCS_SURFACE, docsErrorResponse, principal, query } from "@/modules/documents/server/http";

export const runtime = "nodejs";
export const maxDuration = 120;

type Params = { params: Promise<{ id: string }> };

/** Body bytes accepted (attachments + spec); serverless request bodies are capped near 4.5 MB. */
const MAX_BODY = PAPERBOOK_LIMITS.maxUploadBytes + 256 * 1024;

/**
 * POST (JSON PaperbookSpec, or multipart: `spec` = JSON + `upload:<key>` files) → application/pdf.
 * POST ?preview=1 → { index: PaperbookIndexRow[], totalPages, firstPage } without building the PDF.
 * Authorization: read access to the set. Set files are typed from their stored text unless an original whose SHA-256
 * matches the stored hash is attached; attachments outside the set may be PDF, PNG or JPEG.
 */
async function handlePOST(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY) return jsonError(`The request is too large (attachments are limited to ${Math.round(PAPERBOOK_LIMITS.maxUploadBytes / 1024 / 1024)} MB)`, 413, { code: "too_large" });
  let spec: unknown = null;
  const uploads: PaperbookUpload[] = [];
  const type = req.headers.get("content-type") ?? "";
  try {
    if (type.includes("multipart/form-data")) {
      const form = await req.formData();
      const raw = form.get("spec");
      spec = typeof raw === "string" ? JSON.parse(raw) : null;
      for (const [k, v] of form.entries()) {
        if (!k.startsWith("upload:") || typeof v === "string") continue;
        uploads.push({ key: k.slice(7, 87), name: (v as File).name.slice(0, 200), mime: (v as File).type, bytes: new Uint8Array(await (v as File).arrayBuffer()) });
      }
    } else {
      spec = await req.json();
    }
  } catch {
    return jsonError("Send the paperbook as JSON, or as a form with a `spec` field", 400, { code: "bad_request" });
  }
  try {
    const preview = query(req).get("preview") === "1";
    const out = await buildPaperbook(principal(), id, spec, uploads, { preview });
    if (preview) return Response.json({ index: out.index, totalPages: out.totalPages, firstPage: out.firstPage });
    return new Response(out.pdf as unknown as BodyInit, {
      headers: { "Content-Type": "application/pdf", "Content-Length": String(out.pdf.byteLength), "Content-Disposition": `attachment; filename="paperbook.pdf"; filename*=UTF-8''${encodeURIComponent(out.fileName)}`, "Cache-Control": "no-store" },
    });
  } catch (e) { return docsErrorResponse(e); }
}

export const POST = withDb(withAuth(handlePOST, { action: "read", resource: () => DOCS_SURFACE }));
