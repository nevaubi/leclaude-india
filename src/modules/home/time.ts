/** Pure date/time helpers shared by server and client (no side effects, no server-only). */
import { parseDateOnly, toDateOnly } from "./deadline";

export const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Parse an ISO string; date-only values are treated as local midnight (never shifted by UTC). */
export function toDate(iso: string): Date {
  if (DATE_ONLY_RE.test(iso)) return parseDateOnly(iso);
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? parseDateOnly(iso.slice(0, 10)) : d;
}

export function dateKey(iso: string | Date): string {
  return toDateOnly(typeof iso === "string" ? toDate(iso) : iso);
}

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function addDays(d: Date, n: number): Date {
  const x = startOfDay(d);
  x.setDate(x.getDate() + n);
  return x;
}

/** Monday-first start of week. */
export function startOfWeek(d: Date): Date {
  const s = startOfDay(d);
  const dow = (s.getDay() + 6) % 7;
  s.setDate(s.getDate() - dow);
  return s;
}

export function endOfWeek(d: Date): Date {
  return addDays(startOfWeek(d), 6);
}

export function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

export function endOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0);
}

export function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}

export function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** Whole calendar days from `now` to `target` (negative when in the past). */
export function daysBetween(now: Date, target: Date): number {
  const a = startOfDay(now).getTime();
  const b = startOfDay(target).getTime();
  return Math.round((b - a) / 86_400_000);
}

export type Urgency = "overdue" | "today" | "soon" | "upcoming" | "later" | "past";

/**
 * Countdown chip label: "overdue 2d", "today", "tomorrow", "in 3d", "in 3 wk", "in 2 mo".
 * `deadline` chips report the past as "overdue"; plain events report "2d ago".
 */
export function countdown(target: string | Date, now: Date, opts: { deadline?: boolean } = {}): { label: string; urgency: Urgency; days: number } {
  const t = typeof target === "string" ? toDate(target) : target;
  const days = daysBetween(now, t);
  if (days === 0) {
    if (DATE_ONLY_RE.test(typeof target === "string" ? target : "")) return { label: "today", urgency: "today", days };
    const ms = t.getTime() - now.getTime();
    if (ms < 0 && !opts.deadline) return { label: `${humanDuration(-ms)} ago`, urgency: "past", days };
    if (ms < 0) return { label: "due today", urgency: "today", days };
    return { label: `in ${humanDuration(ms)}`, urgency: "today", days };
  }
  if (days < 0) {
    const n = -days;
    if (opts.deadline) return { label: `overdue ${spanLabel(n)}`, urgency: "overdue", days };
    return { label: `${spanLabel(n)} ago`, urgency: "past", days };
  }
  if (days === 1) return { label: "tomorrow", urgency: "soon", days };
  return { label: `in ${spanLabel(days)}`, urgency: days <= 7 ? "soon" : days <= 30 ? "upcoming" : "later", days };
}

function spanLabel(days: number): string {
  if (days < 14) return `${days}d`;
  if (days < 60) return `${Math.round(days / 7)} wk`;
  if (days < 365) return `${Math.round(days / 30)} mo`;
  const y = days / 365;
  return `${y.toFixed(y < 2 ? 1 : 0)} yr`;
}

function humanDuration(ms: number): string {
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${Math.max(1, mins)} min`;
  const hours = Math.round(mins / 60);
  return `${hours} hr`;
}

/**
 * Plain due-date text for lists: "today", "tomorrow", "in 5 days", "in 3 weeks", "9 days overdue".
 * `overdue` tells the caller to use the danger color; nothing else is colored.
 */
export function dueText(target: string, now: Date): { text: string; overdue: boolean; days: number } {
  const days = daysBetween(now, toDate(target));
  if (days < 0) return { text: `${-days} day${days === -1 ? "" : "s"} overdue`, overdue: true, days };
  if (days === 0) return { text: "today", overdue: false, days };
  if (days === 1) return { text: "tomorrow", overdue: false, days };
  if (days < 14) return { text: `in ${days} days`, overdue: false, days };
  if (days < 60) return { text: `in ${Math.round(days / 7)} weeks`, overdue: false, days };
  if (days < 365) return { text: `in ${Math.round(days / 30)} months`, overdue: false, days };
  return { text: `in ${(days / 365).toFixed(1)} years`, overdue: false, days };
}

/** Human "in 3 weeks" / "overdue 2 days" phrases for the brief. */
export function countdownPhrase(target: string, now: Date): string {
  const days = daysBetween(now, toDate(target));
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  if (days < 0) return `${-days} days ago`;
  if (days < 14) return `in ${days} days`;
  if (days < 60) return `in ${Math.round(days / 7)} weeks`;
  return `in ${Math.round(days / 30)} months`;
}

export function relativeLabel(iso: string, now: Date): string {
  const d = toDate(iso);
  const diff = (now.getTime() - d.getTime()) / 1000;
  if (diff < 45) return "just now";
  if (diff < 3600) return `${Math.max(1, Math.round(diff / 60))}m ago`;
  if (diff < 86400 && isSameDay(d, now)) return `${Math.round(diff / 3600)}h ago`;
  const days = daysBetween(d, now);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.round(days / 7)}w ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function fmtTime(iso: string): string {
  if (DATE_ONLY_RE.test(iso)) return "All day";
  return toDate(iso).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });
}

export function fmtDate(iso: string | Date, opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" }): string {
  const d = typeof iso === "string" ? toDate(iso) : iso;
  // Indian convention: day before month ("31 May", "Friday, 31 May 2024").
  return d.toLocaleDateString("en-IN", opts);
}

export function fmtDateLong(iso: string | Date): string {
  return fmtDate(iso, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
}

export function fmtRange(startsAt: string, endsAt?: string, allDay?: boolean): string {
  if (allDay || DATE_ONLY_RE.test(startsAt)) return "All day";
  const s = fmtTime(startsAt);
  if (!endsAt) return s;
  return `${s} – ${fmtTime(endsAt)}`;
}

export function greetingFor(d: Date): string {
  const h = d.getHours();
  if (h < 5) return "Working late";
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

/** Local naive ISO (no offset) for timed events, e.g. 2026-09-24T14:00:00. */
export function localIso(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00`;
}

export function inRange(iso: string, from: Date, to: Date): boolean {
  const t = toDate(iso).getTime();
  return t >= from.getTime() && t <= to.getTime();
}
