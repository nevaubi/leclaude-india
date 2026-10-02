/** Date helpers for the litigation desk (client-safe). Court days are Indian calendar days (Asia/Kolkata). */
import { addDays, daysBetween, isValidIsoDate } from "@/lib/india/holidays";

/** Today's date in India (YYYY-MM-DD), whatever the server's time zone. */
export function indiaToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export const MAX_RANGE_DAYS = 62;

/**
 * Resolve a from/to query: defaults are today .. today + (defaultDays - 1). Malformed dates, a reversed range or one
 * longer than MAX_RANGE_DAYS are errors (never silently widened or clipped).
 */
export function resolveRange(fromRaw: string | null, toRaw: string | null, defaultDays: number, now: Date = new Date()): { ok: true; from: string; to: string } | { ok: false; error: string } {
  const today = indiaToday(now);
  const from = fromRaw?.trim() || today;
  if (!isValidIsoDate(from)) return { ok: false, error: "from must be a date (YYYY-MM-DD)." };
  const to = toRaw?.trim() || addDays(from, Math.max(1, defaultDays) - 1);
  if (!isValidIsoDate(to)) return { ok: false, error: "to must be a date (YYYY-MM-DD)." };
  const span = daysBetween(from, to);
  if (span < 0) return { ok: false, error: "to must not be before from." };
  if (span >= MAX_RANGE_DAYS) return { ok: false, error: `A range can cover at most ${MAX_RANGE_DAYS} days.` };
  return { ok: true, from, to };
}

export { addDays };
