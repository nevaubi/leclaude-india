import { withDb } from "@/lib/db/request";
import { edAuth } from "@/modules/ediscovery/route-auth";
import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { audit } from "@/lib/integrity/audit";
import { matterFrom } from "@/modules/ediscovery/api-utils";
import { production, productionCsv } from "@/modules/ediscovery/service";

export const runtime = "nodejs";

/** ?matter= → production summary JSON; ?format=csv → load file (DAT-style CSV) for producible documents. */
async function GET__handler(req: NextRequest) {
  const m = matterFrom(req);
  if ("error" in m) return m.error;
  if (req.nextUrl.searchParams.get("format") === "csv") {
    const matter = db().matters.get(m.matterId)!;
    audit("export", { kind: "production", label: `production load file (${matter.shortName})`, matterId: m.matterId }, { format: "csv" });
    return new Response(productionCsv(m.matterId), {
      headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="production-${matter.slug}-${new Date().toISOString().slice(0, 10)}.csv"` },
    });
  }
  return Response.json(production(m.matterId));
}

export const GET = withDb(edAuth(GET__handler));
