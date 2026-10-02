import type { NextRequest } from "next/server";
import { jsonError } from "@/lib/ai/sse";
import { withAuth } from "@/lib/auth/route";
import { refs } from "@/lib/auth/resources";
import { withDb } from "@/lib/db/request";
import { isLawActId, normSectionKey } from "@/modules/law/shared";
import { lawStore } from "@/modules/india/law/common";
import { lawErrorResponse } from "@/modules/india/law/http";
import { officialSection } from "@/modules/india/law/official-sections";

export const runtime = "nodejs";

/**
 * GET /api/law/official?act=<actId>&section=<n> → OfficialSectionLookup: the India Code (official) record of that
 * section with its amendment history from India Code's footnotes, or an explicit state (not loaded, Act not linked,
 * no such section in India Code).
 */
async function handleGET(req: NextRequest) {
  const sp = new URL(req.url).searchParams;
  const act = sp.get("act");
  const section = normSectionKey(sp.get("section"));
  if (!isLawActId(act)) return jsonError("Not an instrument id", 400, { code: "bad_id" });
  if (!section) return jsonError("Not a section number", 400, { code: "bad_section" });
  try {
    return Response.json(await officialSection(await lawStore(), act, section));
  } catch (e) {
    return lawErrorResponse(e, "law.official_failed", "The official India Code record could not be loaded. Try again in a moment.");
  }
}

export const GET = withDb(withAuth(handleGET, { action: "read", resource: () => refs.intel() }));
