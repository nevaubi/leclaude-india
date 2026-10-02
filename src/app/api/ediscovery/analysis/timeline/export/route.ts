import { withDb } from "@/lib/db/request";
import { edAuth } from "@/modules/ediscovery/route-auth";
import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { audit } from "@/lib/integrity/audit";
import { matterFrom } from "@/modules/ediscovery/api-utils";
import { listEvents } from "@/modules/ediscovery/analysis/service";
import { chronologyCsv, chronologyMarkdown } from "@/modules/ediscovery/analysis/chronology";

export const runtime = "nodejs";

/** GET ?matter=&format=csv (download) | markdown → { title, markdown, count } */
async function GET__handler(req: NextRequest) {
  const m = matterFrom(req);
  if ("error" in m) return m.error;
  const matter = db().matters.get(m.matterId);
  const events = listEvents(m.matterId);
  const people = new Map(db().people.all().map((p) => [p.id, p.name]));
  const format = req.nextUrl.searchParams.get("format") ?? "csv";
  audit("export", { kind: "timeline", label: `chronology (${events.length} events)`, matterId: m.matterId }, { format, count: events.length });
  if (format === "markdown") {
    const title = `Chronology — ${matter?.shortName ?? m.matterId}`;
    return Response.json({ title, markdown: chronologyMarkdown(events, { title, matterName: matter?.name, people }), count: events.length });
  }
  return new Response(chronologyCsv(events, people), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="chronology-${matter?.slug ?? m.matterId}.csv"` } });
}

export const GET = withDb(edAuth(GET__handler, { kind: "timeline", action: "export" }));
