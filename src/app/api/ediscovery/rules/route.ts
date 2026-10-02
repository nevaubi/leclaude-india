import { withDb } from "@/lib/db/request";
import { edAuth } from "@/modules/ediscovery/route-auth";
import type { NextRequest } from "next/server";
import { jsonError } from "@/lib/ai/sse";
import { matterFrom, readJson } from "@/modules/ediscovery/api-utils";
import { getCodingRules, setCodingRules } from "@/modules/ediscovery/service";

export const runtime = "nodejs";

async function GET__handler(req: NextRequest) {
  const m = matterFrom(req);
  if ("error" in m) return m.error;
  return Response.json({ matterId: m.matterId, rules: getCodingRules(m.matterId) });
}

async function PUT__handler(req: NextRequest) {
  const body = await readJson<{ matterId?: string; rules?: string }>(req);
  if (typeof body?.rules !== "string") return jsonError("`rules` is required");
  const m = matterFrom(req, body);
  if ("error" in m) return m.error;
  return Response.json({ matterId: m.matterId, rules: setCodingRules(m.matterId, body.rules) });
}

export const GET = withDb(edAuth(GET__handler));

export const PUT = withDb(edAuth(PUT__handler));
