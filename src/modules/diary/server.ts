import "server-only";
import { db } from "@/lib/db";
import { audit } from "@/lib/integrity/audit";
import { hasMatterAccess } from "@/lib/auth/policy";
import type { Principal } from "@/lib/auth/types";
import { causeListEntries, listingsForMatters, readOfficialDocument } from "@/modules/official/service";
import type { MatterRecord } from "@/modules/matters/types";
import { listingSources, officialFailure, TRACKING, HEARINGS } from "@/modules/matters/desk/server";
import { advocateMatches, forumHasParsedLists, identifierCheckable, listingMatchHolds, MAX_ADVOCATE_NAMES, normalizeAdvocateNames } from "@/modules/matters/desk/tracking";
import type { AdvocateListsResponse, AdvocateMatches, DiaryEntry, DiaryResponse, ManualHearing, MatterTracking } from "@/modules/matters/desk/types";
import { ServiceError } from "@/modules/workspace/errors";

/**
 * The diary (server-only): listings, manual hearings and recorded next-hearing dates across the matters the principal
 * may read, plus advocate-wise matches in parsed cause lists. Authorization is the principal's own matter access:
 * matters are filtered with hasMatterAccess before any identifier reaches the official-sources facade, so a listing of
 * a matter the principal cannot see is never fetched, matched or returned.
 */

export const ADVOCATES = "diary_advocates";
interface AdvocatePrefs { id: string; names: string[]; updatedAt: string }

export interface DiaryDeps {
  listings?: typeof listingsForMatters;
  entries?: typeof causeListEntries;
  read?: typeof readOfficialDocument;
}

/** Open matters the principal may read. */
export function visibleMatters(principal: Principal): MatterRecord[] {
  return db().collection<MatterRecord>("matters").all().filter((m) => !m.archivedAt && m.status !== "closed" && hasMatterAccess(principal, m.id));
}

export async function loadDiary(principal: Principal, from: string, to: string, deps: DiaryDeps = {}): Promise<DiaryResponse> {
  const matters = visibleMatters(principal);
  const byId = new Map(matters.map((m) => [m.id, m]));
  const name = (id: string) => byId.get(id)?.shortName || byId.get(id)?.name || id;
  const all = db().collection<MatterTracking>(TRACKING).all().filter((t) => byId.has(t.matterId));
  // Only identifiers the official sources can match are looked up (CNRs are kept on the matter for reference only).
  const tracked = all.map((t) => ({ ...t, identifiers: t.identifiers.filter(identifierCheckable) })).filter((t) => t.identifiers.length > 0);
  const own = new Map(tracked.map((t) => [t.matterId, t.identifiers]));
  const entries: DiaryEntry[] = [];
  const official: DiaryResponse["official"] = { state: "ok", uncoveredForums: [] };
  official.uncoveredForums = Array.from(new Set(all.flatMap((t) => t.identifiers.map((i) => i.forum)).filter((f) => !forumHasParsedLists(f))));

  if (tracked.length) {
    try {
      const matches = await (deps.listings ?? listingsForMatters)(tracked.map((t) => ({ matterId: t.matterId, identifiers: t.identifiers.map(({ forum, kind, value }) => ({ forum, kind, value })) })), { from, to });
      const kept = matches.filter((m) => byId.has(m.matterId) && m.entry.parsed && m.entry.listDate >= from && m.entry.listDate <= to && listingMatchHolds(m, own.get(m.matterId) ?? []));
      const sources = await listingSources(kept.map((m) => m.entry.documentId), deps.read);
      const printed = new Map(tracked.flatMap((t) => t.identifiers.map((i) => [`${t.matterId}|${i.kind}|${i.value}`, i.printed] as const)));
      const seen = new Set<string>();
      for (const m of kept) {
        const id = `${m.matterId}|${m.entry.id}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const shown = printed.get(`${m.matterId}|${m.matchedOn.kind}|${m.matchedOn.value}`);
        entries.push({ kind: "listing", id, matterId: m.matterId, matterName: name(m.matterId), date: m.entry.listDate, entry: m.entry, matchedOn: m.matchedOn, source: sources.get(m.entry.documentId) ?? null, ...(shown ? { printed: shown } : {}) });
      }
    } catch (e) {
      const f = officialFailure(e);
      official.state = f.state;
      official.message = f.message;
    }
  }

  for (const h of db().collection<ManualHearing>(HEARINGS).find((h) => byId.has(h.matterId) && h.date >= from && h.date <= to)) {
    entries.push({ kind: "manual", id: h.id, matterId: h.matterId, matterName: name(h.matterId), date: h.date, hearing: h });
  }
  const covered = new Set(entries.map((e) => `${e.matterId}|${e.date}`));
  for (const m of matters) {
    const d = m.india?.nextHearing;
    if (!d || d < from || d > to || covered.has(`${m.id}|${d}`)) continue;
    entries.push({ kind: "particulars", id: `np_${m.id}`, matterId: m.id, matterName: name(m.id), date: d, purpose: m.india?.hearingPurpose, courtHall: m.india?.courtHall, item: m.india?.causeList?.listDate === d ? m.india?.causeList?.item : undefined });
  }
  const rank = { listing: 0, manual: 1, particulars: 2 } as const;
  entries.sort((a, b) => a.date.localeCompare(b.date) || rank[a.kind] - rank[b.kind] || courtKey(a).localeCompare(courtKey(b), undefined, { numeric: true }) || a.matterName.localeCompare(b.matterName));
  return { from, to, matters: matters.length, tracked: tracked.length, entries, official };
}

/** Within a day and kind: court then item for listings, time then court for manual hearings; unknowns last. */
function courtKey(e: DiaryEntry): string {
  const last = "\uffff";
  if (e.kind === "listing") return `${e.entry.courtNo ?? last}|${(e.entry.itemNo ?? last).padStart(6, "0")}`;
  if (e.kind === "manual") return `${e.hearing.time ?? last}|${e.hearing.courtNo ?? last}`;
  return e.courtHall ?? last;
}

// ---- advocate lists -------------------------------------------------------------------------------------------------

export function getAdvocateNames(userId: string): string[] {
  return db().collection<AdvocatePrefs>(ADVOCATES).get(userId)?.names ?? [];
}

export function putAdvocateNames(principal: Principal, raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new ServiceError(400, "names must be a list of advocate names.", undefined, "invalid");
  const r = normalizeAdvocateNames(raw);
  if (!r.ok) throw new ServiceError(400, r.error, { names: r.error }, "invalid");
  db().collection<AdvocatePrefs>(ADVOCATES).put({ id: principal.id, names: r.names, updatedAt: new Date().toISOString() });
  audit("settings.change", { kind: "diary_advocates", id: principal.id, label: "Advocate names watched in cause lists" }, { count: r.names.length }, { id: principal.id, name: principal.name });
  return r.names;
}

/**
 * Whole-name matches of each saved name in parsed cause lists over [from, to] (bounded: MAX_ADVOCATE_NAMES names,
 * 60 entries each, run in parallel). The facade's match is re-checked here; an entry whose advocate fields do not
 * carry exactly the saved name (titles and bracketed notes aside) is dropped, never shown as a near match.
 */
export async function advocateLists(principal: Principal, from: string, to: string, deps: DiaryDeps = {}): Promise<AdvocateListsResponse> {
  const names = getAdvocateNames(principal.id).slice(0, MAX_ADVOCATE_NAMES);
  const results: AdvocateMatches[] = await Promise.all(names.map(async (name): Promise<AdvocateMatches> => {
    try {
      const rows = await (deps.entries ?? causeListEntries)({ advocate: name, from, to, limit: 60 });
      const entries = rows
        .filter((e) => e.parsed && e.listDate >= from && e.listDate <= to && e.advocates.some((a) => advocateMatches(name, a)))
        .sort((a, b) => a.listDate.localeCompare(b.listDate) || a.forum.localeCompare(b.forum) || (a.courtNo ?? "").localeCompare(b.courtNo ?? "", undefined, { numeric: true }) || (a.itemNo ?? "").localeCompare(b.itemNo ?? "", undefined, { numeric: true }));
      return { name, state: "ok", entries };
    } catch (e) {
      const f = officialFailure(e);
      return { name, state: f.state, message: f.message, entries: [] };
    }
  }));
  return { names, from, to, results };
}
