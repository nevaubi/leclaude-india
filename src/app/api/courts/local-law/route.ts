import { jsonError } from "@/lib/ai/sse";
import { withAuth } from "@/lib/auth/route";
import { refs } from "@/lib/auth/resources";
import type { StateCode } from "@/lib/india/courts";
import { LOCAL_LAW, cityById } from "@/lib/india/forums";
import { resolveLocalLawForState } from "@/modules/courts/local-law";

export const runtime = "nodejs";

/**
 * GET /api/courts/local-law?city=<city id> | ?state=<State code> — the State's local-law pointers resolved against the
 * law corpus by exact title (`resolved` / `ambiguous` / `not_found`, or `unavailable` when the corpus is not configured).
 */
async function handleGET(req: Request) {
  const url = new URL(req.url);
  const cityId = url.searchParams.get("city")?.trim() || null;
  const stateParam = url.searchParams.get("state")?.trim().toUpperCase() || null;
  let state: StateCode | null = null;
  if (cityId) {
    const city = cityById(cityId);
    if (!city) return jsonError(`Unknown city "${cityId.slice(0, 40)}"`, 404, { code: "unknown_city" });
    state = city.state;
  } else if (stateParam) {
    if (!(stateParam in LOCAL_LAW)) return jsonError(`No local-law pointers for "${stateParam.slice(0, 8)}"`, 404, { code: "unknown_state" });
    state = stateParam as StateCode;
  } else {
    return jsonError("city or state is required", 422);
  }
  return Response.json(await resolveLocalLawForState(state));
}

export const GET = withAuth(handleGET, { action: "read", resource: () => refs.intel() });
