import type { NextRequest } from "next/server";
import { jsonError } from "@/lib/ai/sse";
import { withDb } from "@/lib/db/request";
import { withAuth } from "@/lib/auth/route";
import { DOCS_LIMITS } from "@/modules/documents/types";
import { listFiles } from "@/modules/documents/server/sets";
import { uploadBrowserPdf, uploadServerFile, type BrowserPdfBody } from "@/modules/documents/server/ingest";
import { DOCS_SURFACE, docsErrorResponse, principal, query, readJsonBody } from "@/modules/documents/server/http";

export const runtime = "nodejs";
export const maxDuration = 300;

type Params = { params: Promise<{ id: string }> };

/** GET ?offset&limit&status&q → { files: DocFile[], total } */
async function handleGET(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const q = query(req);
  try {
    return Response.json(await listFiles(principal(), id, { offset: q.get("offset"), limit: q.get("limit"), status: q.get("status"), q: q.get("q") }));
  } catch (e) { return docsErrorResponse(e); }
}

/**
 * POST JSON BrowserPdfUpload (optionally `totalPages` for a batched upload) or multipart `file` (+ `lastModified`)
 * → UploadResult (created | duplicate | rejected). Rejections are a 200 with a reason, so a bulk upload keeps going.
 */
async function handlePOST(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const ct = req.headers.get("content-type") ?? "";
  try {
    if (ct.includes("application/json")) {
      const body = await readJsonBody<BrowserPdfBody>(req);
      if (!body) return jsonError("Send the page texts as JSON");
      return Response.json(await uploadBrowserPdf(principal(), id, body));
    }
    if (ct.includes("multipart/form-data")) {
      const declared = Number(req.headers.get("content-length") ?? 0);
      if (declared > DOCS_LIMITS.maxServerFileBytes + 256 * 1024) return jsonError(`Files sent to the server are limited to ${DOCS_LIMITS.maxServerFileBytes / 1024 / 1024} MB`, 413);
      let form: FormData;
      try { form = await req.formData(); } catch { return jsonError("Could not read the upload"); }
      const files = form.getAll("file").filter((v): v is File => typeof v !== "string");
      if (files.length !== 1) return jsonError("Attach exactly one `file`");
      const f = files[0];
      return Response.json(await uploadServerFile(principal(), id, { name: f.name, mime: f.type, bytes: new Uint8Array(await f.arrayBuffer()) }));
    }
    return jsonError("Send JSON page text (PDF) or multipart/form-data (other files)", 415);
  } catch (e) { return docsErrorResponse(e); }
}

export const GET = withDb(withAuth(handleGET, { action: "read", resource: () => DOCS_SURFACE }));
export const POST = withDb(withAuth(handlePOST, { action: "write", resource: () => DOCS_SURFACE }));
