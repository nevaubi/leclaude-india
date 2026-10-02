import "server-only";
import { defineTool } from "@/lib/ai/tools";
import { db } from "@/lib/db";
import { CITIES, findCity, forumsForCity } from "@/lib/india/forums";
import type { Matter } from "@/lib/types/domain";
import { forumContextFor, type PointerResolutions } from "@/modules/courts/context";
import { resolveLocalLawForState } from "@/modules/courts/local-law";
import type { IndianCaseInfo } from "@/modules/matters/india";
import { resolveMatterScope } from "./internal";

/**
 * get_forum_info: where a matter (or a city) is litigated — the forum, the city's courts and tribunals with their
 * official e-filing / cause-list / case-status pages (each with its source), and the State's local-law pointers
 * resolved against the law corpus by exact title. A matter is read only inside the run's matter scope; an unknown
 * city is reported with the known city ids, never mapped to the nearest one.
 */
export const getForumInfoTool = defineTool<{ city?: string; matter_id?: string }>({
  name: "get_forum_info",
  description: "Forum and local-law context for an Indian matter or city: the matter's forum, the city's courts and tribunals (High Court seat/bench, civil, sessions, commercial, NCLT, DRT, consumer, RERA) with official website, e-filing, cause-list and case-status links and their sources, and the State's local statutes (rent, court fees, stamp, municipal, land revenue) resolved by exact title in the law corpus. Unresolved titles are reported as not found; never substitute a similar Act.",
  parameters: { type: "object", properties: { city: { type: "string", description: "City id or name, e.g. 'bengaluru', 'Mumbai', 'Gurgaon'" }, matter_id: { type: "string", description: "Matter id; its recorded city and court are used" } }, required: [] },
  examples: [{ city: "bengaluru" }, { matter_id: "m_valsara_arb" }],
  timeoutMs: 12_000,
  maxResultChars: 16_000,
  access: "read",
  label: (a) => (a.city ? `Courts and local law: ${a.city}` : "Loading forum and local law"),
  async execute({ city, matter_id }, ctx) {
    let india: IndianCaseInfo | undefined;
    let matterId: string | undefined;
    if (matter_id || !city) {
      const r = resolveMatterScope(ctx, matter_id);
      if (!r.ok) {
        if (!city) return { ...r.error, cities: CITIES.map((c) => c.id) };
      } else if (matter_id || r.scope.matterIds.length === 1) {
        matterId = matter_id ?? r.scope.matterIds[0];
        const m = db().matters.get(matterId) as (Matter & { india?: IndianCaseInfo }) | undefined;
        if (!m) return { error: `Matter ${matterId} not found in scope`, code: "not_found" };
        india = m.india;
      } else if (!city) {
        return { error: "Several matters are in scope; pass matter_id or city.", code: "ambiguous", matter_ids: r.scope.matterIds.slice(0, 20), cities: CITIES.map((c) => c.id) };
      }
    }
    const cityRec = city ? findCity(city) : null;
    if (city && !cityRec) return { error: `Unknown city "${city.slice(0, 60)}"; no city is guessed.`, code: "unknown_city", cities: CITIES.map((c) => ({ id: c.id, name: c.name })) };
    const base = forumContextFor(india, cityRec?.id ?? null);
    if (!base || !base.state) return { matter_id: matterId ?? null, forum_context: base, note: "The matter has no city or forum recorded; pass a city to see its forums." };
    const law = await resolveLocalLawForState(base.state.code as Parameters<typeof resolveLocalLawForState>[0]);
    const resolved: PointerResolutions = new Map(law.items.map((it) => [it.pointer.title, { status: it.status, actIds: it.acts.map((a) => a.id) }]));
    const ctxWithLaw = forumContextFor(india, cityRec?.id ?? null, resolved);
    const forums = base.city ? forumsForCity(base.city.id).map((f) => ({ id: f.id, kind: f.kind, name: f.name, ...(f.address ? { address: f.address } : {}), ...(f.website ? { website: f.website } : {}), ...(f.links ? { links: f.links } : {}), sources: f.sources.map((s) => s.url) })) : [];
    return {
      matter_id: matterId ?? null,
      forum_context: ctxWithLaw,
      forums,
      local_law: { corpus_configured: law.configured, ...(law.error ? { corpus_error: law.error } : {}), items: law.items.map((it) => ({ title: it.pointer.title, topic: it.pointer.topic, status: it.status, acts: it.acts.map((a) => ({ id: a.id, title: a.title, year: a.year, source_url: a.sourceUrl })) })) },
      checked_at: "Forum records were checked against their official sources on 2026-10-01; confirm current designations on the linked pages.",
    };
  },
});
