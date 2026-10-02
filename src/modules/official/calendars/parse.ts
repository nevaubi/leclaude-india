/**
 * Court calendar parsing (pure, deterministic): official holiday lists → holiday / vacation records.
 *
 * Inputs
 * - Supreme Court holiday data as served to its own /calendar/ page (JSON: start/end dates, type gazetted | vacations
 *   | partial | weekend-working, printed weekdays).
 * - Holiday tables printed on calendar pages and PDFs ("NAME OF HOLIDAY | MONTH & DATE | DAY(S) OF THE WEEK"), in pipe
 *   (markdown / HTML-to-text) or plain-text form. Column order is found per row (the Supreme Court web table's header
 *   labels are swapped: column 1 is the name, column 2 the date).
 * - Calendar footnotes: Supreme Court partial court working days; Delhi High Court vacations, second Saturdays and
 *   local holidays (scanned PDF: OCR text, LaTeX-style artefacts are normalised first).
 *
 * Validation: every row that prints a weekday is checked against the computed weekday of its date; a mismatch (wrong
 * year, OCR error) leaves the row unparsed. When the year is not printed with the table it is chosen only if exactly one
 * of (fetch year - 1, fetch year, fetch year + 1) makes every printed weekday agree; otherwise nothing is parsed.
 */

import { addDaysIso, isoFrom, monthNumber, plain, squash, weekdayNumber, weekdayOf } from "../causelist/text";

export type HolidayKind = "holiday" | "vacation" | "partial_working" | "ad_hoc" | "working_day";

export interface HolidayRecord {
  forum: string;
  dateFrom: string;
  dateTo: string;
  name: string;
  kind: HolidayKind;
  /** Registry open for filing, when the notification says so; null when it does not. */
  registryOpen: boolean | null;
  /** Calendar year the entry belongs to (a 20 Dec – 1 Jan vacation belongs to the December year). */
  year: number;
  note: string | null;
}

export interface CalendarParseResult {
  records: HolidayRecord[];
  unparsed: number;
  notes: string[];
  /** Year the table was read for (given or resolved by weekday agreement); null when unresolved. */
  year: number | null;
}

const MONTH = "(January|February|March|April|May|June|July|August|September|October|November|December)";
const WEEKDAY = "(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)";
const DATE_CELL = new RegExp(`^${MONTH}\\s+(\\d{1,2})(?:\\s+to\\s+(?:${MONTH}\\s+)?(\\d{1,2}))?$`, "i");
const WEEKDAY_CELL = new RegExp(`^${WEEKDAY}(?:\\s+to\\s+${WEEKDAY})?$`, "i");
const LINE_RE = new RegExp(`^(.+?)\\s+(${MONTH}\\s+\\d{1,2}(?:\\s+to\\s+(?:${MONTH}\\s+)?\\d{1,2})?)\\s+(${WEEKDAY}(?:\\s+to\\s+${WEEKDAY})?)(?:\\s+(?:\\d{1,3}|-))?$`, "i");

interface Row {
  name: string;
  date: RegExpExecArray;
  weekdays: RegExpExecArray | null;
  continuation?: boolean;
}

function rowsOf(text: string): { rows: Row[]; candidates: number } {
  const rows: Row[] = [];
  let candidates = 0;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.includes("|")) {
      const cells = line.replace(/^\|/, "").replace(/\|\s*$/, "").split("|").map((c) => squash(plain(c)));
      if (cells.every((c) => !c || /^:?-{3,}:?$/.test(c))) continue;
      const di = cells.findIndex((c) => DATE_CELL.test(c));
      if (di < 0) {
        // "(Birthday of Prophet Mohammad)" printed under the previous holiday's name.
        const only = cells.filter(Boolean);
        if (only.length === 1 && /^\(.+\)$/.test(only[0]) && rows.length) rows.push({ name: only[0], date: null as unknown as RegExpExecArray, weekdays: null, continuation: true });
        continue;
      }
      candidates++;
      const wi = cells.findIndex((c) => WEEKDAY_CELL.test(c));
      const name = cells.find((c, i) => i !== di && i !== wi && c && !/^(?:\d{1,3}|-)$/.test(c));
      if (!name) continue;
      rows.push({ name, date: DATE_CELL.exec(cells[di])!, weekdays: wi >= 0 ? WEEKDAY_CELL.exec(cells[wi]) : null });
      continue;
    }
    const m = LINE_RE.exec(squash(plain(line)));
    if (!m) continue;
    candidates++;
    const date = DATE_CELL.exec(squash(m[2]));
    // Groups: 1 name, 2 date phrase (3, 4 months), 5 weekday phrase (6, 7 weekdays).
    const wd = WEEKDAY_CELL.exec(squash(m[5] ?? ""));
    if (!date) continue;
    rows.push({ name: squash(m[1]), date, weekdays: wd });
  }
  // Fold continuation names into the row above.
  const out: Row[] = [];
  for (const r of rows) {
    if (r.continuation) {
      if (out.length) out[out.length - 1].name = `${out[out.length - 1].name} ${r.name}`;
      continue;
    }
    out.push(r);
  }
  return { rows: out, candidates };
}

function rowDates(r: Row, year: number): { from: string; to: string } | null {
  const m1 = monthNumber(r.date[1]);
  const d1 = Number(r.date[2]);
  if (!m1) return null;
  const from = isoFrom(year, m1, d1);
  if (!from) return null;
  if (!r.date[4]) return { from, to: from };
  const m2 = r.date[3] ? monthNumber(r.date[3]) : m1;
  if (!m2) return null;
  const y2 = m2 < m1 ? year + 1 : year;
  const to = isoFrom(y2, m2, Number(r.date[4]));
  if (!to || to < from) return null;
  return { from, to };
}

function weekdaysAgree(r: Row, dates: { from: string; to: string }): boolean | null {
  if (!r.weekdays) return null;
  const a = weekdayNumber(r.weekdays[1]);
  if (a == null || a !== weekdayOf(dates.from)) return false;
  if (r.weekdays[2]) {
    const b = weekdayNumber(r.weekdays[2]);
    if (b == null || b !== weekdayOf(dates.to)) return false;
  }
  return true;
}

function kindOf(name: string, dates: { from: string; to: string }): HolidayKind {
  if (/partial\s+court\s+working/i.test(name)) return "partial_working";
  if (/vacation/i.test(name) || dates.from !== dates.to) return "vacation";
  return "holiday";
}

/** Holiday table (pipe or plain text) → records for `forum`. `year` when printed with the table; else resolved. */
export function parseHolidayTable(text: string, opts: { forum: string; year?: number | null; fetchedYear: number }): CalendarParseResult {
  const { rows, candidates } = rowsOf(text);
  const notes: string[] = [];
  if (!rows.length) return { records: [], unparsed: candidates, notes: ["no holiday table rows found"], year: null };
  let year = opts.year ?? null;
  if (year == null) {
    const ok: number[] = [];
    for (const y of [opts.fetchedYear - 1, opts.fetchedYear, opts.fetchedYear + 1]) {
      let checked = 0;
      let bad = 0;
      for (const r of rows) {
        const d = rowDates(r, y);
        const agree = d ? weekdaysAgree(r, d) : false;
        if (agree === null) continue;
        checked++;
        if (!agree) bad++;
      }
      if (checked >= 3 && bad === 0) ok.push(y);
    }
    if (ok.length !== 1) return { records: [], unparsed: rows.length, notes: [`table year could not be resolved from the printed weekdays (${ok.length} candidate years)`], year: null };
    year = ok[0];
  }
  const records: HolidayRecord[] = [];
  let unparsed = candidates - rows.length;
  for (const r of rows) {
    const d = rowDates(r, year);
    if (!d) { unparsed++; continue; }
    const agree = weekdaysAgree(r, d);
    if (agree === false) {
      unparsed++;
      notes.push(`weekday mismatch: "${r.name}" ${d.from}`);
      continue;
    }
    const name = squash(r.name);
    records.push({ forum: opts.forum, dateFrom: d.from, dateTo: d.to, name, kind: kindOf(name, d), registryOpen: null, year, note: agree === null ? "weekday not printed; date not cross-checked" : null });
  }
  return { records, unparsed, notes, year };
}

// ---------------------------------------------------------------------------------------------------------------------
// Supreme Court holiday JSON (the data behind https://www.sci.gov.in/calendar/)
// ---------------------------------------------------------------------------------------------------------------------

interface SciHoliday {
  start_date?: string;
  end_date?: string;
  start_year?: string;
  title?: string;
  type?: string;
  days_of_the_week?: { start?: string; end?: string };
}

const SCI_TYPES: Record<string, HolidayKind> = { gazetted: "holiday", vacations: "vacation", partial: "partial_working", "weekend-working": "working_day" };

function dmyIso(s: string | undefined): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(s ?? "").trim());
  return m ? isoFrom(+m[3], +m[2], +m[1]) : null;
}

/** Supreme Court holiday JSON → records (forum "sci"). Unknown types and weekday mismatches stay unparsed. */
export function parseSciHolidayJson(text: string, opts: { forum?: string } = {}): CalendarParseResult {
  const forum = opts.forum ?? "sci";
  let data: { data?: { holidays?: SciHoliday[] } };
  try {
    data = JSON.parse(text);
  } catch {
    return { records: [], unparsed: 1, notes: ["holiday data is not valid JSON"], year: null };
  }
  const list = Array.isArray(data?.data?.holidays) ? data.data!.holidays! : [];
  const records: HolidayRecord[] = [];
  const notes: string[] = [];
  let unparsed = 0;
  for (const h of list) {
    const from = dmyIso(h.start_date);
    const to = dmyIso(h.end_date);
    const kind = SCI_TYPES[String(h.type ?? "")];
    const year = Number(h.start_year);
    const name = squash(plain(String(h.title ?? "")));
    if (!from || !to || to < from || !kind || !name || !(year >= 1900 && year <= 2200)) {
      unparsed++;
      if (h.type && !kind) notes.push(`unknown holiday type "${h.type}"`);
      continue;
    }
    const ws = h.days_of_the_week?.start ? weekdayNumber(h.days_of_the_week.start) : null;
    const we = h.days_of_the_week?.end ? weekdayNumber(h.days_of_the_week.end) : null;
    if ((ws != null && ws !== weekdayOf(from)) || (we != null && we !== weekdayOf(to))) {
      unparsed++;
      notes.push(`weekday mismatch: "${name}" ${from}`);
      continue;
    }
    records.push({
      forum, dateFrom: from, dateTo: to, name, kind, registryOpen: null, year,
      note: kind === "partial_working" ? "Partial court working days (not a closure)" : kind === "working_day" ? "Notified working day" : null,
    });
  }
  return { records, unparsed, notes, year: null };
}

// ---------------------------------------------------------------------------------------------------------------------
// Footnotes
// ---------------------------------------------------------------------------------------------------------------------

/** OCR / LaTeX artefacts in scanned calendars: "$ 2 2^{\mathrm{nd}} $" → "22nd", "$ \ast $" → "*". */
export function normalizeOcrMath(s: string): string {
  return s
    .replace(/<sup>\s*([^<]*?)\s*<\/sup>/gi, "$1")
    .replace(/\$\s*([^$]*?)\s*\$/g, (_, inner: string) => {
      let t = inner.replace(/\\ast\b/g, "*").replace(/\\mathrm\{([^}]*)\}/g, "$1");
      t = t.replace(/\^\{([^}]*)\}/g, (_m, sup: string) => sup.replace(/\s+/g, "")).replace(/\^/g, "");
      t = t.replace(/(\d)\s+(?=\d)/g, "$1").replace(/[{}]/g, "");
      return t.trim();
    })
    .replace(/(\d)\s+(st|nd|rd|th)\b/g, "$1$2");
}

const MONTH_WORD = "(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\\.?";

function dayMonthList(text: string, year: number): string[] {
  const out: string[] = [];
  const re = new RegExp(`((?:\\d{1,2}(?:st|nd|rd|th)?\\s*(?:,|&|and)?\\s*)+)\\s*${MONTH_WORD}`, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const mo = monthNumber(m[2]);
    if (!mo) continue;
    for (const d of m[1].match(/\d{1,2}/g) ?? []) {
      const iso = isoFrom(year, mo, Number(d));
      if (iso && !out.includes(iso)) out.push(iso);
    }
  }
  return out;
}

function datePhrase(weekday: string | undefined, day: string, month: string, year: number): string | null {
  const mo = monthNumber(month);
  if (!mo) return null;
  const iso = isoFrom(year, mo, Number(day));
  if (!iso) return null;
  if (weekday) {
    const w = weekdayNumber(weekday);
    if (w == null || w !== weekdayOf(iso)) return null;
  }
  return iso;
}

/** Calendar footnotes → records (partial working days, vacations, second Saturdays, local holidays). */
export function parseCalendarNotes(rawText: string, opts: { forum: string; year: number; ocr?: boolean }): { records: HolidayRecord[]; notes: string[] } {
  const text = squash(normalizeOcrMath(rawText).replace(/\*\*/g, ""));
  const { forum, year } = opts;
  const records: HolidayRecord[] = [];
  const notes: string[] = [];
  const ocrNote = opts.ocr ? "read from the OCR text of the official calendar; verify against the PDF" : null;

  // Supreme Court: "The partial Court working days will commence on Monday, the 31st May, 2027 and the Full Court
  // working days will resume from Monday, the 12th July, 2027."
  const pcwd = new RegExp(
    `partial Court working days will commence on (?:${WEEKDAY},?\\s+)?(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH},?\\s+(\\d{4}).*?resume from (?:${WEEKDAY},?\\s+)?(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH},?\\s+(\\d{4})`,
    "i",
  ).exec(text);
  if (pcwd) {
    const from = datePhrase(pcwd[1], pcwd[2], pcwd[3], Number(pcwd[4]));
    const resume = datePhrase(pcwd[5], pcwd[6], pcwd[7], Number(pcwd[8]));
    if (from && resume && resume > from) {
      const registry = /Registry of the Court will be functioning throughout the partial Court working days except on Saturdays, Sundays and Holidays/i.test(text);
      records.push({ forum, dateFrom: from, dateTo: addDaysIso(resume, -1), name: "Partial Court Working Days", kind: "partial_working", registryOpen: registry ? true : null, year: Number(pcwd[4]), note: registry ? "Registry functions except on Saturdays, Sundays and holidays (per the calendar note)" : null });
    } else notes.push("partial court working days note could not be read");
  }

  // Delhi High Court: "The High Court will remain closed for Summer Vacation from Monday, 1st June to Tuesday, 30th June
  // (both days inclusive) and for Winter Vacation from Saturday, 26th December to Thursday, 31st December".
  const closed = /The High Court will remain closed for (.+?)(?=\s\d+\.\s|The Subordinate Courts|$)/i.exec(text);
  if (closed) {
    const vre = new RegExp(`(Summer|Winter|Autumn|Dussehra|Diwali|Christmas)\\s+Vacation from (?:${WEEKDAY},?\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH}\\s+to\\s+(?:${WEEKDAY},?\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH}`, "gi");
    let v: RegExpExecArray | null;
    while ((v = vre.exec(closed[1]))) {
      const from = datePhrase(v[2], v[3], v[4], year);
      const toMonth = monthNumber(v[7]);
      const fromMonth = monthNumber(v[4]);
      const to = toMonth && fromMonth ? datePhrase(v[5], v[6], v[7], toMonth < fromMonth ? year + 1 : year) : null;
      if (from && to && to >= from) records.push({ forum, dateFrom: from, dateTo: to, name: `${v[1]} Vacation`, kind: "vacation", registryOpen: null, year, note: ocrNote });
      else notes.push(`vacation note could not be validated: "${squash(v[0])}"`);
    }
  }

  // Delhi High Court: "All Sundays and second Saturdays have been shown in red colour" (red = holiday).
  if (/All Sundays and second Saturdays have been shown in red/i.test(text)) {
    for (let mo = 1; mo <= 12; mo++) {
      let count = 0;
      for (let d = 1; d <= 14; d++) {
        const iso = isoFrom(year, mo, d)!;
        if (weekdayOf(iso) === 6 && ++count === 2) {
          records.push({ forum, dateFrom: iso, dateTo: iso, name: "Second Saturday", kind: "holiday", registryOpen: null, year, note: "Second Saturdays are shown as holidays in the official calendar" });
          break;
        }
      }
    }
  }

  // Delhi High Court local holidays: "Local holidays i.e. falling on 6th Mar, 22nd & 23rd Oct & 13th Nov ... will be
  // observed exclusively by the High Court. 2nd Jan, 5th Mar, ... will be observed as Local Holidays by the High Court".
  const local = /Local holidays i\.e\. falling on (.+?) will be observed as Local Holidays by the High Court/i.exec(text);
  if (local) {
    const parts = local[1].split(/will be observed exclusively by the High Court\.?/i);
    for (const part of parts) {
      for (const iso of dayMonthList(part.replace(/as shown in red squares,?/i, ""), year)) {
        records.push({ forum, dateFrom: iso, dateTo: iso, name: "Local Holiday", kind: "holiday", registryOpen: null, year, note: ocrNote ?? "Local holiday (calendar note)" });
      }
    }
  }
  return { records, notes };
}

/** Distinct records (same kind, dates and name collapse; names compared without spacing / case). */
export function dedupeHolidays(records: HolidayRecord[]): HolidayRecord[] {
  const seen = new Set<string>();
  const out: HolidayRecord[] = [];
  for (const r of records) {
    const k = `${r.kind}|${r.dateFrom}|${r.dateTo}|${r.name.toLowerCase().replace(/[^a-z0-9]/g, "")}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

/**
 * Years a parsed calendar document covers completely: the table's own year when at least five closures were read for
 * it (a stray date list is not a calendar). For the Supreme Court JSON only the requested year counts, because the feed
 * also carries the tail of the previous year and early entries of the next one.
 */
export function calendarCoverage(records: HolidayRecord[], opts: { year?: number | null; format?: string | null }): number[] {
  const counts = new Map<number, number>();
  for (const r of records) if (r.kind === "holiday" || r.kind === "vacation") counts.set(r.year, (counts.get(r.year) ?? 0) + 1);
  if (opts.year != null) return (counts.get(opts.year) ?? 0) >= 5 ? [opts.year] : [];
  if (opts.format === "json") return [];
  let best: number | null = null;
  for (const [y, n] of counts) if (n >= 5 && (best == null || n > (counts.get(best) ?? 0))) best = y;
  return best == null ? [] : [best];
}
