import { withDb } from "@/lib/db/request";
import { edAuth } from "@/modules/ediscovery/route-auth";
import type { NextRequest } from "next/server";
import { jsonError } from "@/lib/ai/sse";
import { errorResponse, readJson } from "@/modules/ediscovery/api-utils";
import { deleteIssueCode, updateIssueCode } from "@/modules/ediscovery/service";
import type { IssueCodeInput } from "@/modules/ediscovery/types";

export const runtime = "nodejs";

async function PATCH__handler(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await readJson<Partial<IssueCodeInput>>(req);
  if (!body) return jsonError("Invalid JSON body");
  try {
    const code = updateIssueCode(id, body);
    if (!code) return jsonError(`No issue code ${id}`, 404);
    return Response.json({ code });
  } catch (e) {
    return errorResponse({ message: (e as Error).message, status: 409 });
  }
}

async function DELETE__handler(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ok = deleteIssueCode(id);
  if (!ok) return jsonError(`No issue code ${id}`, 404);
  return Response.json({ ok: true });
}

export const PATCH = withDb(edAuth(PATCH__handler, { lookup: "issueCode" }));

export const DELETE = withDb(edAuth(DELETE__handler, { lookup: "issueCode" }));
