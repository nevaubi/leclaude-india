/**
 * Forum and local-law context for agents (pure, client-safe): what a research or chat agent should know about where a
 * matter is pending. Pointer titles are labelled as pointers (not authority); resolved corpus ids are added only when a
 * resolution was actually run (`resolveLocalLaw`), never guessed.
 */
import { cityById, forumRecordForCourt, localLawFor, stateName, type Forum, type LocalLawPointer } from "@/lib/india/forums";
import { cityForCourtId, courtName, type IndianCaseInfo } from "@/modules/matters/india";

export interface ForumContext {
  city: { id: string; name: string } | null;
  state: { code: string; name: string } | null;
  forum: { id: string; name: string; kind: string; website?: string; links?: Forum["links"]; sources: string[] } | null;
  /** Court name as stored on the matter when it is not in the city forum list. */
  court_name: string | null;
  local_law_pointers: { title: string; topic: string; jurisdiction: string; status?: string; act_ids?: string[] }[];
  note: string;
}

const POINTER_NOTE = "Local-law pointers are statute titles a litigator in this State commonly needs; they are pointers to check, not authority. Resolved act ids come from an exact title match in the law corpus; an unresolved title was not found and must not be replaced by a similar Act.";

/** Resolution results keyed by pointer title (from `resolveLocalLaw`). */
export type PointerResolutions = Map<string, { status: string; actIds: string[] }>;

export function forumContextFor(india: IndianCaseInfo | null | undefined, cityIdOverride?: string | null, resolved?: PointerResolutions): ForumContext | null {
  const cityId = cityIdOverride ?? india?.cityId ?? cityForCourtId(india?.courtId, india?.benchId);
  const city = cityById(cityId);
  const forum = forumRecordForCourt(india?.courtId, india?.benchId);
  if (!city && !forum && !india?.courtId) return null;
  const state = city?.state ?? forum?.state ?? null;
  const pointers: LocalLawPointer[] = localLawFor(state);
  return {
    city: city ? { id: city.id, name: city.name } : null,
    state: state ? { code: state, name: stateName(state) } : null,
    forum: forum ? { id: forum.id, name: forum.name, kind: forum.kind, ...(forum.website ? { website: forum.website } : {}), ...(forum.links ? { links: forum.links } : {}), sources: forum.sources.map((s) => s.url) } : null,
    court_name: forum ? null : courtName(india?.courtId) ?? null,
    local_law_pointers: pointers.map((p) => {
      const r = resolved?.get(p.title);
      return { title: p.title, topic: p.topic, jurisdiction: p.jurisdiction === "central" ? "central" : `state:${p.stateCode}`, ...(r ? { status: r.status, act_ids: r.actIds } : {}) };
    }),
    note: POINTER_NOTE,
  };
}

/** One compact line for system prompts ("Forum: …; local-law pointers: …"). Empty when nothing is known. */
export function forumContextLine(india: IndianCaseInfo | null | undefined): string {
  const c = forumContextFor(india);
  if (!c) return "";
  const where = [c.forum?.name ?? c.court_name, c.city?.name, c.state?.name].filter(Boolean).join(", ");
  const titles = c.local_law_pointers.map((p) => p.title);
  return `Forum: ${where || "not recorded"}.${titles.length ? ` Local-law pointers for ${c.state?.name} (titles to check, not authority; resolve with get_forum_info before relying on them): ${titles.join("; ")}.` : ""}`;
}
