/**
 * Indian-convention formatting (pure, client-safe, deterministic across server and browser).
 *
 * - Dates: numeric `DD-MM-YYYY` (cause lists, orders) and `31 May 2024` (day, month name, year) with the month name
 *   in the UI language. Day-month-year order is kept in every locale, as Indian courts write it.
 *   Times use the 12-hour clock: "10:30 am" in English and the locale's form elsewhere.
 * - Numbers: Latin digits with lakh/crore grouping (1,00,000 / 1,00,00,000) in every UI language. CLDR groups some
 *   Indian locales (kn-IN, mr-IN, ur-IN) the Western way, so grouping always comes from en-IN.
 * - Currency: ₹ with Indian grouping; `inrWords` gives "₹12.5 lakh" / "₹3 crore".
 * - Time zone: Asia/Kolkata unless the caller passes another. Date-only values (YYYY-MM-DD) are never shifted.
 */
import { DEFAULT_TIME_ZONE, intlTag } from "./locale";

export { inrWords } from "@/lib/india/languages";

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

type DateInput = string | number | Date | null | undefined;

function toDate(v: DateInput): { date: Date; dateOnly: boolean } | null {
  if (v == null || v === "") return null;
  if (typeof v === "string" && DATE_ONLY_RE.test(v)) {
    const d = new Date(`${v}T00:00:00Z`);
    return Number.isNaN(d.getTime()) ? null : { date: d, dateOnly: true };
  }
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : { date: d, dateOnly: false };
}

const dtfCache = new Map<string, Intl.DateTimeFormat>();
function dtf(locale: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(opts)}`;
  let f = dtfCache.get(key);
  if (!f) {
    try { f = new Intl.DateTimeFormat(`${intlTag(locale)}-u-nu-latn`, opts); } catch { f = new Intl.DateTimeFormat("en-IN", opts); }
    dtfCache.set(key, f);
  }
  return f;
}

function part(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find((p) => p.type === type)?.value ?? "";
}

export type DateStyle = "numeric" | "medium" | "long" | "full" | "dayMonth";

export interface DateOptions { timeZone?: string }

/**
 * `numeric` 31-05-2024 · `medium` 31 May 2024 · `long` 31 May 2024 (full month name) · `full` Friday, 31 May 2024 ·
 * `dayMonth` 31 May. Month and weekday names are in the UI language; digits are Latin.
 */
export function formatDate(value: DateInput, locale = "en", style: DateStyle = "medium", opts: DateOptions = {}): string {
  const parsed = toDate(value);
  if (!parsed) return "";
  const timeZone = parsed.dateOnly ? "UTC" : opts.timeZone ?? DEFAULT_TIME_ZONE;
  const num = dtf("en", { day: "2-digit", month: "2-digit", year: "numeric", timeZone }).formatToParts(parsed.date);
  const dd = part(num, "day");
  const mm = part(num, "month");
  const yyyy = part(num, "year");
  if (style === "numeric") return `${dd}-${mm}-${yyyy}`;
  const monthName = part(dtf(locale, { month: style === "medium" || style === "dayMonth" ? "short" : "long", timeZone }).formatToParts(parsed.date), "month")
    || dtf(locale, { month: "short", timeZone }).format(parsed.date);
  const day = String(Number(dd));
  if (style === "dayMonth") return `${day} ${monthName}`;
  const core = `${day} ${monthName} ${yyyy}`;
  if (style !== "full") return core;
  const weekday = dtf(locale, { weekday: "long", timeZone }).format(parsed.date);
  // Urdu takes the Arabic comma.
  return `${weekday}${locale === "ur" ? "، " : ", "}${core}`;
}

/** "10:30 am" (en) or the locale's 12-hour form. */
export function formatTime(value: DateInput, locale = "en", opts: DateOptions = {}): string {
  const parsed = toDate(value);
  if (!parsed || parsed.dateOnly) return "";
  return dtf(locale, { hour: "numeric", minute: "2-digit", hour12: true, timeZone: opts.timeZone ?? DEFAULT_TIME_ZONE }).format(parsed.date);
}

/** "31 May 2024, 10:30 am". */
export function formatDateTime(value: DateInput, locale = "en", opts: DateOptions = {}): string {
  const d = formatDate(value, locale, "medium", opts);
  const t = formatTime(value, locale, opts);
  return t ? `${d}, ${t}` : d;
}

const numberFormats = new Map<number, Intl.NumberFormat>();

/** Latin digits, Indian grouping: 12345678 → "1,23,45,678". */
export function formatNumber(n: number | null | undefined, maximumFractionDigits = 2): string {
  if (n == null || !Number.isFinite(n)) return "";
  let f = numberFormats.get(maximumFractionDigits);
  if (!f) { f = new Intl.NumberFormat("en-IN-u-nu-latn", { maximumFractionDigits }); numberFormats.set(maximumFractionDigits, f); }
  return f.format(n);
}

const inr = new Intl.NumberFormat("en-IN-u-nu-latn", { style: "currency", currency: "INR", maximumFractionDigits: 2 });

/** "₹12,50,000" (paise shown only when present). Same output in every UI language. */
export function formatCurrency(amount: number | null | undefined): string {
  if (amount == null || !Number.isFinite(amount)) return "";
  return inr.format(amount).replace(/\.00$/, "");
}
