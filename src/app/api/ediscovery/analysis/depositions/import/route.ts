import { withDb } from "@/lib/db/request";
import { edAuth } from "@/modules/ediscovery/route-auth";
import type { NextRequest } from "next/server";
import { jsonError } from "@/lib/ai/sse";
import { errorResponse, matterFrom } from "@/modules/ediscovery/api-utils";
import { extractTranscriptText, importTranscript, listImports, previewTranscript, type ImportTranscriptInput } from "@/modules/ediscovery/analysis/transcript-import-server";
import { summarizeDeposition } from "@/modules/ediscovery/analysis/service";

export const runtime = "nodejs";

const MAX_BYTES = 25 * 1024 * 1024;

type Body = Omit<ImportTranscriptInput, "matterId" | "text"> & { matterId?: string; text?: string; preview?: boolean };

/** GET ?matter= → { imports: TranscriptImportRecord[] } */
async function GET__handler(req: NextRequest) {
  const m = matterFrom(req);
  if ("error" in m) return m.error;
  return Response.json({ imports: listImports(m.matterId) });
}

/**
 * POST — JSON { matterId, text, preview?, witnessName?, witnessId?, date?, takenBy?, defendingBy?, volume?, speakers?, depositionId? }
 *      — or multipart/form-data with `file` (.txt/.ptx/.asc/.docx) plus the same fields.
 * preview → 200 { parsed } (nothing written); otherwise 201 { deposition, summary, parsed, record }.
 */
async function POST__handler(req: NextRequest) {
  try {
    let body: Body = {};
    let text = "";
    let sourceName: string | undefined;
    let sourceKind: ImportTranscriptInput["sourceKind"] = "paste";
    const ct = req.headers.get("content-type") ?? "";
    if (ct.includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file");
      for (const [k, v] of form.entries()) if (typeof v === "string" && k !== "file") (body as Record<string, unknown>)[k] = k === "preview" ? v === "1" || v === "true" : k === "volume" || k === "firstPage" ? Number(v) : k === "speakers" || k === "exhibits" ? safeJson(v) : v;
      if (file instanceof File) {
        if (file.size > MAX_BYTES) return jsonError("Transcript exceeds 25 MB", 413);
        const r = await extractTranscriptText(new Uint8Array(await file.arrayBuffer()), file.name, file.type);
        text = r.text; sourceKind = r.sourceKind; sourceName = file.name;
      } else if (typeof body.text === "string") text = body.text;
    } else {
      body = ((await req.json().catch(() => null)) as Body | null) ?? {};
      text = body.text ?? "";
      sourceName = body.sourceName;
      sourceKind = body.sourceKind ?? "paste";
    }
    if (!text.trim()) return jsonError("`text` or a transcript `file` is required");
    const m = matterFrom(req, body);
    if ("error" in m) return m.error;
    if (body.preview) return Response.json({ parsed: previewTranscript(text, { firstPage: body.firstPage, speakers: body.speakers }) });
    const r = importTranscript({ ...body, matterId: m.matterId, text, sourceName, sourceKind });
    return Response.json({ deposition: r.deposition, summary: summarizeDeposition(r.deposition), parsed: r.parsed, record: r.record, created: r.created }, { status: 201 });
  } catch (e) { return errorResponse(e); }
}

function safeJson(v: string) { try { return JSON.parse(v); } catch { return undefined; } }

export const GET = withDb(edAuth(GET__handler, { kind: "deposition" }));

export const POST = withDb(edAuth(POST__handler, { kind: "deposition" }));
