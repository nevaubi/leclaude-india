import { withDb } from "@/lib/db/request";
import { edAuth } from "@/modules/ediscovery/route-auth";
import type { NextRequest } from "next/server";
import { jsonError } from "@/lib/ai/sse";
import { db } from "@/lib/db";
import { errorResponse, matterFrom, readJson } from "@/modules/ediscovery/api-utils";
import { createEvent, deleteEvent, listEvents, updateEvent } from "@/modules/ediscovery/analysis/service";
import type { TimelineCategory, TimelineEventInput, TimelineFilters } from "@/modules/ediscovery/analysis/types";
import type { TimelineEvent } from "@/lib/types/domain";

export const runtime = "nodejs";

/** GET ?matter=&categories=a,b&person=&min=&from=&to=&source=&q=&disputed=1&unverified=1 → { events, people: {id,name}[] } */
async function GET__handler(req: NextRequest) {
  const m = matterFrom(req);
  if ("error" in m) return m.error;
  const sp = req.nextUrl.searchParams;
  const filters: TimelineFilters = {
    categories: (sp.get("categories") ?? "").split(",").filter(Boolean) as TimelineCategory[],
    personId: sp.get("person") ?? undefined,
    minSignificance: sp.get("min") ? Number(sp.get("min")) : undefined,
    from: sp.get("from") ?? undefined,
    to: sp.get("to") ?? undefined,
    sourceKind: (sp.get("source") as TimelineFilters["sourceKind"]) ?? undefined,
    q: sp.get("q") ?? undefined,
    disputedOnly: sp.get("disputed") === "1",
    unverifiedOnly: sp.get("unverified") === "1",
  };
  const events = listEvents(m.matterId, filters);
  const ids = new Set(events.flatMap((e) => e.personIds ?? []));
  const people = db().people.all().filter((p) => ids.has(p.id)).map((p) => ({ id: p.id, name: p.name, organization: p.organization }));
  return Response.json({ events, people, total: db().timeline.count((e) => e.matterId === m.matterId) });
}

/** POST { matterId, ...TimelineEventInput } → 201 { event } */
async function POST__handler(req: NextRequest) {
  const body = await readJson<TimelineEventInput & { matterId?: string }>(req);
  const m = matterFrom(req, body);
  if ("error" in m) return m.error;
  if (!body?.title?.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(body.date ?? "")) return jsonError("`title` and ISO `date` are required");
  try {
    const { matterId: _m, ...input } = body; void _m;
    return Response.json({ event: createEvent(m.matterId, { ...input, category: input.category ?? "other", significance: input.significance ?? 3, sources: input.sources ?? [] }) }, { status: 201 });
  } catch (e) { return errorResponse(e); }
}

/** PATCH { id, patch } → { event } */
async function PATCH__handler(req: NextRequest) {
  const body = await readJson<{ id?: string; patch?: Partial<TimelineEvent> }>(req);
  if (!body?.id || !body.patch) return jsonError("`id` and `patch` are required");
  const e = updateEvent(body.id, body.patch);
  if (!e) return jsonError(`No event ${body.id}`, 404);
  return Response.json({ event: e });
}

/** DELETE ?id= */
async function DELETE__handler(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return jsonError("`id` is required");
  return Response.json({ ok: deleteEvent(id) });
}

export const GET = withDb(edAuth(GET__handler, { kind: "timeline", records: "timeline_events" }));

export const POST = withDb(edAuth(POST__handler, { kind: "timeline", records: "timeline_events" }));

export const PATCH = withDb(edAuth(PATCH__handler, { kind: "timeline", records: "timeline_events" }));

export const DELETE = withDb(edAuth(DELETE__handler, { kind: "timeline", records: "timeline_events" }));
