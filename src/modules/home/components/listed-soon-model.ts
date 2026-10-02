/** Pure model for Home's "Listed today and tomorrow" section (unit-tested; no React). */
import { addDays } from "@/lib/india/holidays";
import type { DiaryEntry } from "@/modules/matters/desk/types";
import type { MatterLite } from "../types";

/** Entries for today and tomorrow from the matters' recorded next hearings (shown when the diary could not answer). */
export function particularsEntries(matters: MatterLite[], today: string): DiaryEntry[] {
  const tomorrow = addDays(today, 1);
  return matters
    .filter((m) => m.nextHearing && (m.nextHearing.date === today || m.nextHearing.date === tomorrow))
    .map((m): DiaryEntry => ({ kind: "particulars", id: `np_${m.id}`, matterId: m.id, matterName: m.shortName || m.name, date: m.nextHearing!.date, purpose: m.nextHearing!.purpose, courtHall: m.nextHearing!.courtHall, item: m.nextHearing!.item }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.matterName.localeCompare(b.matterName));
}

/**
 * What the section shows: the diary's entries once it answered (scoped to the principal server-side); nothing while it
 * loads or when access was denied; when the diary failed, the recorded next hearings of the principal's own matters
 * (Home's matter list is scoped server-side too), shown with a notice that listings were not checked. Narrowed to
 * the matter filter when one is active.
 */
export function listedSoonEntries(opts: { status: "loading" | "ready" | "denied" | "error"; diary?: DiaryEntry[]; matters: MatterLite[]; today: string; matterFilter?: string | null }): DiaryEntry[] {
  if (opts.status === "denied" || opts.status === "loading") return [];
  const tomorrow = addDays(opts.today, 1);
  const list = (opts.status === "ready" && opts.diary ? opts.diary : particularsEntries(opts.matters, opts.today)).filter((e) => e.date === opts.today || e.date === tomorrow);
  return opts.matterFilter ? list.filter((e) => e.matterId === opts.matterFilter) : list;
}
