import { withDb } from "@/lib/db/request";
import { edAuth } from "@/modules/ediscovery/route-auth";
import type { NextRequest } from "next/server";
import { errorResponse } from "@/modules/ediscovery/api-utils";
import { getProduction, runProductionQc } from "@/modules/ediscovery/review-service";

export const runtime = "nodejs";

/** POST → runs the QC checks and stores the report: { production } */
async function POST__handler(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try { runProductionQc(id); return Response.json({ production: getProduction(id) }); } catch (e) { return errorResponse(e); }
}

export const POST = withDb(edAuth(POST__handler, { lookup: "production" }));
