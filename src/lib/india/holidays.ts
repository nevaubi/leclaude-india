/**
 * Court calendar mechanism (client-safe, deterministic).
 *
 * Calendar-date arithmetic on ISO dates (YYYY-MM-DD, interpreted as calendar days with no time zone) and a
 * data-driven court calendar: weekly off days, notified holidays and vacations. No holiday dates are invented here.
 * `SAMPLE_CALENDAR` is clearly marked `sample: true`; a real deployment loads each court's notified calendar
 * (the High Court's annual holiday notification) into a `CourtCalendar` with `sample: false` and its source.
 */

export type IsoDate = string;

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parse a strict YYYY-MM-DD calendar date. Returns null for malformed or impossible dates (2023-02-29). */
export function parseIsoDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const m = ISO_RE.exec(s.trim());
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return dt;
}

export function isValidIsoDate(s: string | null | undefined): s is IsoDate {
  return parseIsoDate(s) !== null;
}

export function toIso(d: Date): IsoDate {
  return d.toISOString().slice(0, 10);
}

function must(s: IsoDate): Date {
  const d = parseIsoDate(s);
  if (!d) throw new RangeError(`invalid ISO date: ${s}`);
  return d;
}

export function addDays(s: IsoDate, n: number): IsoDate {
  const d = must(s);
  d.setUTCDate(d.getUTCDate() + n);
  return toIso(d);
}

/**
 * Add calendar months ("month" = British calendar month, General Clauses Act, 1897, s.3(35)). When the target month
 * is shorter, the result is clamped to its last day (31 Jan + 1 month = 28/29 Feb).
 */
export function addMonths(s: IsoDate, n: number): IsoDate {
  const d = must(s);
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + n, day = d.getUTCDate();
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return toIso(new Date(Date.UTC(y, m, Math.min(day, last))));
}

export function addYears(s: IsoDate, n: number): IsoDate {
  return addMonths(s, n * 12);
}

/** Whole days from a to b (b − a). */
export function daysBetween(a: IsoDate, b: IsoDate): number {
  return Math.round((must(b).getTime() - must(a).getTime()) / 86_400_000);
}

export function compareIso(a: IsoDate, b: IsoDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 0 = Sunday … 6 = Saturday. */
export function weekday(s: IsoDate): number {
  return must(s).getUTCDay();
}

export interface CourtHoliday { date: IsoDate; name: string }
export interface CourtVacation { from: IsoDate; to: IsoDate; name: string; /** Registry open for filing during the vacation (per notification). */ registryOpen?: boolean }

export interface CourtCalendar {
  id: string;
  /** Registry court id (`hc-karnataka`) or a free label for a subordinate court. */
  courtId: string;
  /** Years the calendar covers; outside them `isCourtOpen` answers "unknown". */
  years: number[];
  /** Weekly days the court does not sit (0 = Sunday). Saturday practice varies by court and must come from the notification. */
  weeklyOff: number[];
  holidays: CourtHoliday[];
  vacations: CourtVacation[];
  /** True for illustrative data that must not be relied on for a deadline. */
  sample: boolean;
  source: string;
}

/**
 * Illustrative calendar: Sundays plus the three fixed-date national holidays (Republic Day 26 January, Independence
 * Day 15 August, Gandhi Jayanti 2 October). It deliberately omits every state, religious and vacation closure, so it
 * is NOT a court's calendar; deadline computations that use it are marked as requiring verification.
 */
export const SAMPLE_CALENDAR: CourtCalendar = {
  id: "sample-national",
  courtId: "sample",
  years: [2023, 2024, 2025, 2026, 2027],
  weeklyOff: [0],
  holidays: [2023, 2024, 2025, 2026, 2027].flatMap((y) => [
    { date: `${y}-01-26`, name: "Republic Day" },
    { date: `${y}-08-15`, name: "Independence Day" },
    { date: `${y}-10-02`, name: "Gandhi Jayanti" },
  ]),
  vacations: [],
  sample: true,
  source: "Sample data only: national fixed-date holidays and Sundays. Load the court's notified holiday list before relying on s.4 adjustments.",
};

export type OpenState = { open: true } | { open: false; reason: string } | { open: "unknown"; reason: string };

/** Whether the court sits on `date` according to `cal`. Dates outside the calendar's years are "unknown", never assumed open. */
export function isCourtOpen(date: IsoDate, cal: CourtCalendar): OpenState {
  const d = parseIsoDate(date);
  if (!d) return { open: "unknown", reason: `invalid date ${date}` };
  if (!cal.years.includes(d.getUTCFullYear())) return { open: "unknown", reason: `calendar ${cal.id} does not cover ${d.getUTCFullYear()}` };
  if (cal.weeklyOff.includes(d.getUTCDay())) return { open: false, reason: `weekly off (${["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][d.getUTCDay()]})` };
  const h = cal.holidays.find((x) => x.date === date);
  if (h) return { open: false, reason: `holiday: ${h.name}` };
  const v = cal.vacations.find((x) => date >= x.from && date <= x.to);
  if (v) return { open: false, reason: `vacation: ${v.name}${v.registryOpen ? " (registry open for filing per notification)" : ""}` };
  return { open: true };
}

export interface NextOpenDay { date: IsoDate | null; skipped: { date: IsoDate; reason: string }[]; unknown?: string }

/** First day on or after `date` on which the court is open. Stops (date null) when the calendar cannot answer. */
export function nextOpenDay(date: IsoDate, cal: CourtCalendar, maxDays = 120): NextOpenDay {
  const skipped: { date: IsoDate; reason: string }[] = [];
  let cur = date;
  for (let i = 0; i <= maxDays; i++) {
    const st = isCourtOpen(cur, cal);
    if (st.open === true) return { date: cur, skipped };
    if (st.open === "unknown") return { date: null, skipped, unknown: st.reason };
    skipped.push({ date: cur, reason: st.reason });
    cur = addDays(cur, 1);
  }
  return { date: null, skipped, unknown: `no open day within ${maxDays} days` };
}

/** Add `n` court working days after `date` (the start day is not counted). Null when the calendar cannot answer. */
export function addCourtDays(date: IsoDate, n: number, cal: CourtCalendar): IsoDate | null {
  let cur = date, left = n;
  for (let guard = 0; left > 0 && guard < n * 10 + 400; guard++) {
    cur = addDays(cur, 1);
    const st = isCourtOpen(cur, cal);
    if (st.open === "unknown") return null;
    if (st.open) left--;
  }
  return left === 0 ? cur : null;
}
