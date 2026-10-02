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
 * Read the body, counting bytes as they arrive: a missing or false Content-Length cannot get more than MAX_BODY into
 * memory (null when the body is larger).
 */
async function readLimited(req: NextRequest, max: number): Promise<Uint8Array | null> {
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel().catch(() => undefined); return null; }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}

/**
 * POST (JSON PaperbookSpec, or multipart: `spec` = JSON + `upload:<key>` files) → application/pdf.
 * POST ?preview=1 → { index: PaperbookIndexRow[] (with each entry's source), totalPages, firstPage } without building.
 * Authorization: the preview needs read access to the set; building the PDF is an export, so it also needs the matter's
 * `export` permission (a personal set: its owner). The set-level check runs in buildPaperbook, after the set is
 * resolved (unknown and unreadable sets stay 404), and the decision is written to the authorization audit. Set files
 * are typed from their stored text unless an original whose SHA-256 matches the stored hash is attached; attachments
 * outside the set may be PDF, PNG or JPEG.
 */
async function handlePOST(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const tooLarge = () => jsonError(`The request is too large (attachments are limited to ${Math.round(PAPERBOOK_LIMITS.maxUploadBytes / 1024 / 1024)} MB)`, 413, { code: "too_large" });
  const declared = Number(req.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > MAX_BODY) return tooLarge();
  const body = await readLimited(req, MAX_BODY).catch(() => undefined);
  if (body === null) return tooLarge();
  if (body === undefined) return jsonError("The request body could not be read", 400, { code: "bad_request" });
  let spec: unknown = null;
  const uploads: PaperbookUpload[] = [];
  const type = req.headers.get("content-type") ?? "";
  try {
    if (type.includes("multipart/form-data")) {
      const form = await new Response(body as unknown as BodyInit, { headers: { "content-type": type } }).formData();
      const raw = form.get("spec");
      spec = typeof raw === "string" ? JSON.parse(raw) : null;
      for (const [k, v] of form.entries()) {
        if (!k.startsWith("upload:") || typeof v === "string") continue;
        if (uploads.length >= PAPERBOOK_LIMITS.maxEntries) break;
        uploads.push({ key: k.slice(7, 87), name: (v as File).name.slice(0, 200), mime: (v as File).type, bytes: new Uint8Array(await (v as File).arrayBuffer()) });
      }
    } else {
      spec = JSON.parse(new TextDecoder().decode(body));
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
