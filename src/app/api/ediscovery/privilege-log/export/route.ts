import { withDb } from "@/lib/db/request";
import { edAuth } from "@/modules/ediscovery/route-auth";
import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { audit } from "@/lib/integrity/audit";
import { matterFrom } from "@/modules/ediscovery/api-utils";
import { listPrivilegeLog } from "@/modules/ediscovery/service";
import { counselRoster, privilegeLogCsv, privilegeLogMarkdown } from "@/modules/ediscovery/privilege";
import { privilegeLogXlsx } from "@/modules/ediscovery/privilege-xlsx";

export const runtime = "nodejs";

/** ?matter=&format=csv|xlsx|markdown — CSV/XLSX download; markdown is returned as JSON for the client to convert with markdownToDoc → POST /api/office/docs. */
async function GET__handler(req: NextRequest) {
  const m = matterFrom(req);
  if ("error" in m) return m.error;
  const matter = db().matters.get(m.matterId)!;
  const rows = listPrivilegeLog(m.matterId);
  const format = req.nextUrl.searchParams.get("format") ?? "csv";
  const stamp = new Date().toISOString().slice(0, 10);
  audit("export", { kind: "privilegeLog", label: `privilege log (${rows.length} entries)`, matterId: m.matterId }, { format, count: rows.length });
  if (format === "xlsx") {
    const bytes = privilegeLogXlsx(rows, { matterName: matter.name, caption: matter.caption, generatedAt: stamp });
    return new Response(new Uint8Array(bytes), { headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": `attachment; filename="privilege-log-${matter.slug}-${stamp}.xlsx"`, "Content-Length": String(bytes.byteLength) } });
  }
  if (format === "markdown") {
    return Response.json({ title: `Privilege Log — ${matter.shortName} — ${stamp}`, markdown: privilegeLogMarkdown(rows, matter.name, matter.caption, counselRoster(matter.id)), count: rows.length });
  }
  return new Response(privilegeLogCsv(rows), {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="privilege-log-${matter.slug}-${stamp}.csv"` },
  });
}

export const GET = withDb(edAuth(GET__handler, { action: "export" }));
