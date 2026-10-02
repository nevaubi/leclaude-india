import { withDb } from "@/lib/db/request";
import { edAuth } from "@/modules/ediscovery/route-auth";
import type { NextRequest } from "next/server";
import { jsonError } from "@/lib/ai/sse";
import { db } from "@/lib/db";
import { attachProvenance } from "@/lib/integrity/record";
import { errorResponse, readJson } from "@/modules/ediscovery/api-utils";
import { draftPrivilegeDescription } from "@/modules/ediscovery/ai";
import { upsertPrivilegeEntry } from "@/modules/ediscovery/service";

export const runtime = "nodejs";

/** POST { save?, verify? } → { description, ai, provenance?, entry } — drafts a privilege-safe description; `save: true` upserts the log entry. */
async function POST__handler(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await readJson<{ save?: boolean; verify?: boolean }>(req);
  const doc = db().edocs.get(id);
  if (!doc) return jsonError(`No document ${id}`, 404);
  try {
    const res = await draftPrivilegeDescription(id, { signal: req.signal, verify: body?.verify });
    const entry = body?.save ? upsertPrivilegeEntry(doc, res.description) : null;
    if (entry && res.provenance) attachProvenance({ kind: "privilege.entry", recordId: entry.id, matterId: doc.matterId, title: `${doc.bates} privilege log entry`, href: `/ediscovery?matter=${doc.matterId}&tab=codes`, provenance: res.provenance });
    return Response.json({ ...res, entry });
  } catch (e) {
    return errorResponse(e);
  }
}

export const POST = withDb(edAuth(POST__handler, { lookup: "edoc" }));
