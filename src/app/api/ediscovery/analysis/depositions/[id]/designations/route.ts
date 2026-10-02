import { withDb } from "@/lib/db/request";
import { edAuth } from "@/modules/ediscovery/route-auth";
import type { NextRequest } from "next/server";
import { jsonError } from "@/lib/ai/sse";
import { db } from "@/lib/db";
import { errorResponse, readJson } from "@/modules/ediscovery/api-utils";
import { createDesignation, deleteDesignation, getDeposition, listDesignations, updateDesignation } from "@/modules/ediscovery/analysis/service";
import { designationsCsv, designationsMarkdown } from "@/modules/ediscovery/analysis/transcript";
import type { Designation } from "@/modules/ediscovery/analysis/types";

export const runtime = "nodejs";

/** GET → { designations }; ?format=csv downloads; ?format=markdown → { title, markdown, count } */
async function GET__handler(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const dep = getDeposition(id);
  if (!dep) return jsonError(`No deposition ${id}`, 404);
  const list = listDesignations(id);
  const format = req.nextUrl.searchParams.get("format");
  const slug = dep.witnessName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  if (format === "csv") return new Response(designationsCsv(dep, list), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="designations-${slug}-vol${dep.volume ?? 1}.csv"` } });
  if (format === "markdown") return Response.json({ title: `Designations — ${dep.witnessName} (Vol. ${dep.volume ?? 1})`, markdown: designationsMarkdown(dep, list, { matterName: db().matters.get(dep.matterId)?.name }), count: list.length });
  return Response.json({ designations: list });
}

/** POST { startPage, startLine, endPage, endLine, purpose, note? } → 201 { designation } */
async function POST__handler(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const dep = getDeposition(id);
  if (!dep) return jsonError(`No deposition ${id}`, 404);
  const body = await readJson<Partial<Designation>>(req);
  if (!body || [body.startPage, body.startLine, body.endPage, body.endLine].some((n) => typeof n !== "number")) return jsonError("startPage/startLine/endPage/endLine are required numbers");
  try {
    const d = createDesignation({ matterId: dep.matterId, depositionId: id, startPage: body.startPage!, startLine: body.startLine!, endPage: body.endPage!, endLine: body.endLine!, purpose: body.purpose ?? "affirmative", note: body.note });
    return Response.json({ designation: d }, { status: 201 });
  } catch (e) { return errorResponse(e); }
}

/** PATCH { id, purpose?, note?, range? } → { designation } */
async function PATCH__handler(req: NextRequest) {
  const body = await readJson<{ id?: string } & Partial<Designation>>(req);
  if (!body?.id) return jsonError("`id` is required");
  const { id, ...patch } = body;
  const d = updateDesignation(id, patch);
  if (!d) return jsonError(`No designation ${id}`, 404);
  return Response.json({ designation: d });
}

/** DELETE ?id= → { ok } */
async function DELETE__handler(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return jsonError("`id` is required");
  return Response.json({ ok: deleteDesignation(id) });
}

export const GET = withDb(edAuth(GET__handler, { lookup: "deposition" }));

export const POST = withDb(edAuth(POST__handler, { lookup: "deposition" }));

export const PATCH = withDb(edAuth(PATCH__handler, { lookup: "deposition" }));

export const DELETE = withDb(edAuth(DELETE__handler, { lookup: "deposition" }));
