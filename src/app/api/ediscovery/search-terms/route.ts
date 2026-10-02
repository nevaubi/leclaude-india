import { withDb } from "@/lib/db/request";
import { edAuth } from "@/modules/ediscovery/route-auth";
import type { NextRequest } from "next/server";
import { jsonError } from "@/lib/ai/sse";
import { audit } from "@/lib/integrity/audit";
import { errorResponse, matterFrom, readJson } from "@/modules/ediscovery/api-utils";
import { listTermReports, searchTermReport, searchTermReportCsv } from "@/modules/ediscovery/review-service";
import type { SearchTermReportRequest } from "@/modules/ediscovery/types";

export const runtime = "nodejs";

/** GET ?matter= → { reports } (recent saved reports). */
async function GET__handler(req: NextRequest) {
  const m = matterFrom(req);
  if ("error" in m) return m.error;
  return Response.json({ reports: listTermReports(m.matterId) });
}

/** POST { matterId, terms[], view?, filters?, save? } (+ ?format=csv) → SearchTermReport | CSV */
async function POST__handler(req: NextRequest) {
  const body = await readJson<SearchTermReportRequest & { save?: boolean }>(req);
  if (!body?.terms?.length) return jsonError("`terms` is required");
  const m = matterFrom(req, body);
  if ("error" in m) return m.error;
  try {
    const report = searchTermReport({ ...body, matterId: m.matterId }, { save: !!body.save });
    if (req.nextUrl.searchParams.get("format") === "csv") {
      audit("export", { kind: "searchTermReport", label: `${report.rows.length} terms`, matterId: m.matterId }, { format: "csv" });
      return new Response(searchTermReportCsv(report), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="search-term-report-${new Date().toISOString().slice(0, 10)}.csv"` } });
    }
    return Response.json(report);
  } catch (e) { return errorResponse(e); }
}

export const GET = withDb(edAuth(GET__handler));

export const POST = withDb(edAuth(POST__handler));
