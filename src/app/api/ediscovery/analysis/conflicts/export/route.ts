import { withDb } from "@/lib/db/request";
import { edAuth } from "@/modules/ediscovery/route-auth";
import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { audit } from "@/lib/integrity/audit";
import { matterFrom } from "@/modules/ediscovery/api-utils";
import { conflictsCsv, conflictsMarkdown, listConflicts } from "@/modules/ediscovery/analysis/service";

export const runtime = "nodejs";

/** GET ?matter=&format=csv (download) | markdown → { title, markdown, count } */
async function GET__handler(req: NextRequest) {
  const m = matterFrom(req);
  if ("error" in m) return m.error;
  const matter = db().matters.get(m.matterId);
  audit("export", { kind: "conflicts", label: `conflicts register (${matter?.shortName ?? m.matterId})`, matterId: m.matterId }, { format: req.nextUrl.searchParams.get("format") ?? "csv" });
  if (req.nextUrl.searchParams.get("format") === "markdown") return Response.json({ title: `Conflicts register — ${matter?.shortName ?? m.matterId}`, markdown: conflictsMarkdown(m.matterId), count: listConflicts(m.matterId).length });
  return new Response(conflictsCsv(m.matterId), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="conflicts-${matter?.slug ?? m.matterId}.csv"` } });
}

export const GET = withDb(edAuth(GET__handler, { kind: "conflict", action: "export" }));
