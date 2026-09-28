/**
 * Client-safe forum catalogue for LeClaude India research.
 *
 * The "jurisdiction" of a research run is the FORUM: the court the matter is (or will be) before. Precedential effect is
 * computed deterministically from the court registry (`bindingEffect`, src/lib/india/courts.ts): the Supreme Court binds
 * every court (Art. 141); a High Court binds courts in its territory; other High Courts are persuasive. The model never
 * decides binding vs persuasive.
 *
 * Special rule (docs/architecture/india.md): judgments of the erstwhile common High Court at Hyderabad (before
 * 1 January 2019, now indexed under the Telangana or Andhra Pradesh High Court) are treated as persuasive in both states.
 */
import { bindingEffect, courtById, FOCUS_COURT_IDS, HIGH_COURTS, SUPREME_COURT, type Court, type StateCode } from "@/lib/india/courts";
import type { Authority } from "./types";

export interface Jurisdiction {
  key: string;
  label: string;
  group: "India" | "Focus courts" | "Other High Courts";
  /** Registry court ids (space separated) that narrow retrieval. Empty = all courts in the corpus. */
  courts: string;
  /** Registry court ids whose decisions bind the forum (Supreme Court first). */
  binding: string[];
  /** Registry id of the forum court, or null for "All India" (no forum: only the Supreme Court binds). */
  forumCourtId: string | null;
  hint?: string;
}

/** The date the High Court of Andhra Pradesh moved to Amaravati and the Telangana High Court began (bifurcation). */
export const HC_BIFURCATION_DATE = "2019-01-01";

/** Subordinate-court forums in the focus states (district and sessions courts, tribunals within the state). */
const SUBORDINATE: { key: string; label: string; state: StateCode; hc: string }[] = [
  { key: "ka-subordinate", label: "Courts in Karnataka (district, sessions, civil courts)", state: "KA", hc: "hc-karnataka" },
  { key: "ts-subordinate", label: "Courts in Telangana (district, sessions, civil courts)", state: "TS", hc: "hc-telangana" },
  { key: "ap-subordinate", label: "Courts in Andhra Pradesh (district, sessions, civil courts)", state: "AP", hc: "hc-andhra" },
];

function hcJurisdiction(c: Court, group: Jurisdiction["group"]): Jurisdiction {
  return { key: c.id, label: c.name, group, courts: "", binding: [SUPREME_COURT.id, c.id], forumCourtId: c.id };
}

/** Default forum key: the selected matter's court (resolved at run time), else All India. */
export const MATTER_FORUM = "matter-forum";

export const JURISDICTIONS: Jurisdiction[] = [
  { key: MATTER_FORUM, label: "Matter's court", group: "India", courts: "", binding: [SUPREME_COURT.id], forumCourtId: null, hint: "The forum of the selected matter; without a matter, only the Supreme Court is treated as binding" },
  { key: "all-india", label: "All India (no forum)", group: "India", courts: "", binding: [SUPREME_COURT.id], forumCourtId: null, hint: "Supreme Court decisions bind; every High Court is persuasive" },
  { key: SUPREME_COURT.id, label: "Supreme Court of India", group: "India", courts: "", binding: [SUPREME_COURT.id], forumCourtId: SUPREME_COURT.id, hint: "Earlier Supreme Court decisions of larger or coordinate benches bind; High Courts persuade" },
  ...HIGH_COURTS.filter((c) => c.focus).map((c) => hcJurisdiction(c, "Focus courts")),
  ...SUBORDINATE.map((s): Jurisdiction => ({ key: s.key, label: s.label, group: "Focus courts", courts: "", binding: [SUPREME_COURT.id, s.hc], forumCourtId: null })),
  ...HIGH_COURTS.filter((c) => !c.focus).map((c) => hcJurisdiction(c, "Other High Courts")),
];

export const DEFAULT_JURISDICTION = MATTER_FORUM;

/** The forum a run uses: an explicit forum as chosen; "Matter's court" resolves from the matter's court text, else All India. */
export function effectiveJurisdiction(key: string | undefined | null, matterCourt?: string | null): string {
  const j = jurisdictionByKey(key);
  if (j.key !== MATTER_FORUM) return j.key;
  return forumFromMatterCourt(matterCourt) ?? "all-india";
}

export function jurisdictionByKey(key: string | undefined | null): Jurisdiction {
  return JURISDICTIONS.find((j) => j.key === key) ?? JURISDICTIONS.find((j) => j.key === DEFAULT_JURISDICTION)!;
}

/** The forum as a Court (subordinate forums are synthetic district-level courts in the state). Null for "All India". */
export function forumCourt(key: string | undefined | null): Court | null {
  const j = jurisdictionByKey(key);
  if (j.forumCourtId) return courtById(j.forumCourtId);
  const sub = SUBORDINATE.find((s) => s.key === j.key);
  if (sub) return { id: sub.key, name: sub.label, shortName: sub.label.split(" (")[0], level: "district", territory: [sub.state], seat: "", benches: [], languages: [] };
  return null;
}

/** Registry court ids that bind the forum (deterministic), Supreme Court first. */
export function bindingCourtIds(key: string | undefined | null): string[] {
  return jurisdictionByKey(key).binding;
}

/** Registry court ids for the persuasive lane: every High Court whose decisions do not bind the forum. */
export function persuasiveCourtIds(key: string | undefined | null): string[] {
  const bind = new Set(bindingCourtIds(key));
  return HIGH_COURTS.map((c) => c.id).filter((id) => !bind.has(id));
}

/** Court ids from a free-text override (space/comma separated registry ids), or the forum's retrieval narrowing. */
export function resolveCourts(jurisdictionKey: string, courtsOverride?: string): string {
  const override = (courtsOverride ?? "").trim().toLowerCase().replace(/[,\s]+/g, " ");
  if (override) return override.split(" ").filter((id) => courtById(id)).join(" ");
  return jurisdictionByKey(jurisdictionKey).courts;
}

/** True for a Telangana/AP High Court judgment delivered before bifurcation (the erstwhile common High Court at Hyderabad). */
export function isCombinedHyderabadHc(courtId: string | undefined | null, date: string | undefined | null): boolean {
  return (courtId === "hc-telangana" || courtId === "hc-andhra") && Boolean(date && date.slice(0, 10) < HC_BIFURCATION_DATE);
}

/**
 * Binding vs persuasive for the forum (deterministic). Unknown or unresolved courts are "n/a" (never guessed).
 * `courtsOverride` narrows retrieval only; it never changes precedential effect.
 */
export function classifyAuthority(courtId: string | undefined | null, jurisdictionKey: string, _courtsOverride?: string, date?: string | null): Authority {
  void _courtsOverride;
  const decidedBy = courtById(courtId ?? undefined);
  if (!decidedBy) return "n/a";
  if (isCombinedHyderabadHc(decidedBy.id, date)) return decidedBy.level === "supreme" ? "binding" : "persuasive";
  const forum = forumCourt(jurisdictionKey);
  if (!forum) return decidedBy.level === "supreme" ? "binding" : "persuasive";
  return bindingEffect(decidedBy, forum);
}

/** One-line reason for the classification, shown next to each authority. */
export function bindingReason(courtId: string | undefined | null, jurisdictionKey: string, date?: string | null): string {
  const decidedBy = courtById(courtId ?? undefined);
  const forum = forumCourt(jurisdictionKey);
  const forumName = forum?.name ?? "any court (no forum selected)";
  if (!decidedBy) return "court not resolved; precedential effect not assessed";
  if (decidedBy.level === "supreme") return `binding on ${forumName} (Art. 141)`;
  if (isCombinedHyderabadHc(decidedBy.id, date)) return `erstwhile common High Court at Hyderabad (before 1 Jan 2019); persuasive for ${forumName}`;
  const effect = classifyAuthority(decidedBy.id, jurisdictionKey, undefined, date);
  return effect === "binding" ? `binding on ${forumName} (${decidedBy.shortName} within its territory)` : `persuasive for ${forumName}`;
}

/** Short court label for citations and tables. */
export function courtAbbreviation(courtId?: string | null, courtName?: string): string {
  const c = courtById(courtId ?? undefined);
  if (c) return c.shortName;
  return courtName ?? courtId ?? "";
}

/** Forum inferred from a matter's court text (registry names, seats and bench cities). Null when nothing matches — never the closest court. */
export function forumFromMatterCourt(court: string | undefined | null): string | null {
  const t = (court ?? "").toLowerCase();
  if (!t.trim()) return null;
  if (/supreme court/.test(t)) return SUPREME_COURT.id;
  const isHc = /high court/.test(t);
  const state = /karnataka|bengaluru|bangalore|dharwad|kalaburagi|gulbarga|mysuru|mysore|mangaluru|hubballi/.test(t) ? "KA"
    : /telangana|hyderabad|secunderabad|warangal|ranga reddy|rangareddy/.test(t) ? "TS"
    : /andhra|amaravati|visakhapatnam|vijayawada|guntur|tirupati|nellore|kurnool/.test(t) ? "AP" : null;
  if (!state) {
    const hc = HIGH_COURTS.find((c) => t.includes(c.name.toLowerCase()) || (c.seat && t.includes(c.seat.toLowerCase())));
    return isHc && hc ? hc.id : null;
  }
  if (isHc) return state === "KA" ? "hc-karnataka" : state === "TS" ? "hc-telangana" : "hc-andhra";
  return state === "KA" ? "ka-subordinate" : state === "TS" ? "ts-subordinate" : "ap-subordinate";
}

/** Focus forums shown first in pickers. */
export const FOCUS_FORUMS = [SUPREME_COURT.id, ...FOCUS_COURT_IDS];
