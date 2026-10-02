import { withDb } from "@/lib/db/request";
import { edAuth } from "@/modules/ediscovery/route-auth";
import type { NextRequest } from "next/server";
import { jsonError } from "@/lib/ai/sse";
import { storyExport } from "@/modules/ediscovery/analysis/service-stories";

export const runtime = "nodejs";

/** GET ?format=csv (download) | markdown → { title, markdown, filename } */
async function GET__handler(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const format = req.nextUrl.searchParams.get("format") === "markdown" ? "markdown" : "csv";
  const r = storyExport(id, format);
  if (!r) return jsonError(`No story ${id}`, 404);
  if (format === "markdown") return Response.json({ title: r.title, markdown: r.body, filename: r.filename });
  return new Response(r.body, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${r.filename}"` } });
}

export const GET = withDb(edAuth(GET__handler, { lookup: "story", action: "export" }));
