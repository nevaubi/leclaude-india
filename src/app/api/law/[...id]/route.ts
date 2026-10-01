import type { NextRequest } from "next/server";
import { jsonError } from "@/lib/ai/sse";
import { withAuth } from "@/lib/auth/route";
import { refs } from "@/lib/auth/resources";
import { withDb } from "@/lib/db/request";
import { lawIdFromSegments, normSectionKey, normVariant } from "@/modules/law/shared";
import { getInstrument, getSection } from "@/modules/india/law/directory";
import { lawErrorResponse } from "@/modules/india/law/http";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string[] }> };

/**
 * GET /api/law/<actId>[?tocOffset=] → LawInstrumentResponse (instrument + one page of its table of contents).
 * GET /api/law/<actId>?section=303[&variant=1] → LawSectionResponse: that exact section, or 404 (never the nearest one).
 */
async function handleGET(req: NextRequest, ctx: Ctx) {
  const id = lawIdFromSegments((await ctx.params).id);
  if (!id) return jsonError("Not an instrument id", 400, { code: "bad_id" });
  const sp = new URL(req.url).searchParams;
  const sectionRaw = sp.get("section");
  try {
    if (sectionRaw != null) {
      const section = normSectionKey(sectionRaw);
      if (!section) return jsonError("Not a section number", 400, { code: "bad_section" });
      const res = await getSection(id, section, normVariant(sp.get("variant")));
      return res ? Response.json(res) : jsonError(`No section ${section} in this instrument in the corpus`, 404, { code: "section_not_found" });
    }
    const res = await getInstrument(id, { tocOffset: Number(sp.get("tocOffset")) || 0 });
    return res ? Response.json(res) : jsonError("No instrument with this id in the statutes corpus", 404, { code: "not_found" });
  } catch (e) {
    return lawErrorResponse(e, "law.instrument_failed", "The instrument could not be loaded. Try again in a moment.");
  }
}

export const GET = withDb(withAuth(handleGET, { action: "read", resource: () => refs.intel() }));
