import { withDb } from "@/lib/db/request";
import { edAuth } from "@/modules/ediscovery/route-auth";
import type { NextRequest } from "next/server";
import { errorResponse, readJson } from "@/modules/ediscovery/api-utils";
import { analyzeDocument } from "@/modules/ediscovery/ai";

export const runtime = "nodejs";

async function POST__handler(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await readJson<{ force?: boolean }>(req);
  try {
    const analysis = await analyzeDocument(id, { force: !!body?.force, signal: req.signal });
    return Response.json({ analysis });
  } catch (e) {
    return errorResponse(e);
  }
}

export const POST = withDb(edAuth(POST__handler, { lookup: "edoc" }));
