import { withDb } from "@/lib/db/request";
import type { NextRequest } from "next/server";
import { withAuth } from "@/lib/auth/route";
import { refs } from "@/lib/auth/resources";
import { matterOrders } from "@/modules/matters/desk/server";
import { serviceErrorResponse } from "@/modules/workspace/errors";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/** GET — orders / judgments published for this matter's tracked identifiers (exact matches), each with its latest action extraction. */
async function handleGET(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  try {
    return Response.json(await matterOrders(id));
  } catch (e) {
    return serviceErrorResponse(e);
  }
}

export const GET = withDb(withAuth(handleGET, { action: "read", resource: (_req, { id }) => refs.matter(id) }));
