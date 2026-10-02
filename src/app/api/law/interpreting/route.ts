import type { NextRequest } from "next/server";
import { jsonError } from "@/lib/ai/sse";
import { withAuth } from "@/lib/auth/route";
import { refs } from "@/lib/auth/resources";
import { withDb } from "@/lib/db/request";
import { isLawActId } from "@/modules/law/shared";
import { lawStore } from "@/modules/india/law/common";
import { lawErrorResponse } from "@/modules/india/law/http";
import { interpretingJudgments } from "@/modules/india/statute-links/read";

export const runtime = "nodejs";

/**
 * GET /api/law/interpreting?act=<actId>&section=302[&offset=0] → InterpretingResponse: judgments in the case-law
 * collection linked to that section, from their full text (citator) and/or their official headnote (metadata), with
 * counts and the "text available" state. `not_applicable` for instruments the citation parser does not know by title.
 */
async function handleGET(req: NextRequest) {
  const sp = new URL(req.url).searchParams;
  const act = sp.get("act");
  const section = sp.get("section") ?? "";
  if (!isLawActId(act)) return jsonError("Not an instrument id", 400, { code: "bad_id" });
  if (!section || section.length > 20) return jsonError("Not a section number", 400, { code: "bad_section" });
  try {
    const store = await lawStore();
    const [i] = await store.query({ query: `SELECT title, year, jurisdiction FROM law_instruments WHERE id = $1`, params: [act] });
    if (!i) return jsonError("No instrument with this id in the statutes corpus", 404, { code: "not_found" });
    return Response.json(await interpretingJudgments(store, { title: String(i.title), year: i.year == null ? null : Number(i.year), jurisdiction: String(i.jurisdiction) }, section, Number(sp.get("offset")) || 0));
  } catch (e) {
    return lawErrorResponse(e, "law.interpreting_failed", "Judgments for this section could not be loaded. Try again in a moment.");
  }
}

export const GET = withDb(withAuth(handleGET, { action: "read", resource: () => refs.intel() }));
