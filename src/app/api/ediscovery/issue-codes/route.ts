import { withDb } from "@/lib/db/request";
import { edAuth } from "@/modules/ediscovery/route-auth";
import type { NextRequest } from "next/server";
import { jsonError } from "@/lib/ai/sse";
import { errorResponse, matterFrom, readJson } from "@/modules/ediscovery/api-utils";
import { addStandardIssueCodes, createIssueCode, listIssueCodes } from "@/modules/ediscovery/service";
import type { IssueCodeInput } from "@/modules/ediscovery/types";

export const runtime = "nodejs";

async function GET__handler(req: NextRequest) {
  const m = matterFrom(req);
  if ("error" in m) return m.error;
  return Response.json({ codes: listIssueCodes(m.matterId) });
}

/** POST { matterId, code, label, … } → 201 { code }; POST { matterId, preset: "standard" } → 201 { created, skipped }. */
async function POST__handler(req: NextRequest) {
  const body = await readJson<IssueCodeInput & { matterId?: string; preset?: string }>(req);
  if (body?.preset === "standard") {
    const m = matterFrom(req, body);
    if ("error" in m) return m.error;
    return Response.json(addStandardIssueCodes(m.matterId), { status: 201 });
  }
  if (!body?.code) return jsonError("`code` is required");
  const m = matterFrom(req, body);
  if ("error" in m) return m.error;
  try {
    return Response.json({ code: createIssueCode(m.matterId, body) }, { status: 201 });
  } catch (e) {
    return errorResponse({ ...(e as Error), message: (e as Error).message, status: 409 });
  }
}

export const GET = withDb(edAuth(GET__handler));

export const POST = withDb(edAuth(POST__handler));
