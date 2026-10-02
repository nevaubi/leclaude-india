/**
 * Table reading for published cause lists (pure, deterministic; no server imports).
 *
 * Two inputs produce the same records:
 * - Markdown tables (Firecrawl PDF parse, or a text layer rendered as pipe tables): one pipe row per printed row.
 * - Positional text items (PDF text layer with x/y): items are grouped into lines by y, the column bands come from
 *   the header row's own x positions (never hard-coded), and every line is assigned to the band its left edge falls
 *   in. A record starts at a line whose item column holds an item number; following lines belong to it until the next
 *   item number, a court/bench header or a section heading.
 *
 * Binding is never guessed: text that cannot be tied to exactly one record (lines above the first record on a page,
 * an item spanning several columns, rows whose cell count differs from the header) marks the record `ambiguous`, and
 * callers store such records with `parsed: false` (shown as published, never matched to a matter).
 */

import { plain, squash } from "./text";

export type ColumnKey =
  | "item"
  | "case"
  | "caseAlt"
  | "parties"
  | "advocates"
  | "advPet"
  | "advRes"
  | "purpose"
  | "section"
  | "remarks"
  | "irp"
  | "other";

/** Header label → column key ("SNo." → item, "Petitioner/Respondent Advocate" → advocates, ...); null when unknown. */
export function classifyHeader(label: string): ColumnKey | null {
  const l = squash(plain(label)).toLowerCase();
  if (!l) return null;
  if (/^(?:s\.?\s*no\.?|sr\.?(?:\s*no\.?)?|sno\.?|sl\.?\s*no\.?|item(?:\s*(?:number|no\.?))?)(?:\s*case\s*no\.?)?$/.test(l)) return "item";
  if (/\birp\b|liquidator|resolution professional/.test(l)) return "irp";
  if (/advocate|counsel/.test(l)) {
    const pet = /petitioner|appellant|applicant/.test(l);
    const res = /respondent/.test(l);
    if (pet && res) return "advocates";
    if (pet) return "advPet";
    if (res) return "advRes";
    return "advocates";
  }
  if (/\bca\s*\/\s*ia\b/.test(l)) return "caseAlt";
  if (/case\s*(?:no|number)|^cp\.?\s*no\.?$|^case$|^diary/.test(l)) return "case";
  if (/part(?:y|ies)|^petitioner\s*\/\s*respondent$/.test(l)) return "parties";
  if (/purpose|stage/.test(l)) return "purpose";
  if (/section|rule/.test(l)) return "section";
  if (/remark|other information/.test(l)) return "remarks";
  return null;
}

/** True when a header cell is the combined Supreme Court "SNo. Case No." column. */
function isCombinedItemCase(label: string): boolean {
  return /s\.?\s*no\.?\s*case\s*no/i.test(squash(plain(label)));
}

// ---------------------------------------------------------------------------------------------------------------------
// Context: court number, bench, section and printed date, as read from the lines around the tables.
// ---------------------------------------------------------------------------------------------------------------------

export interface ContextSnapshot {
  courtNo: string | null;
  bench: string | null;
  section: string | null;
  printedDate: string | null;
}

const COURT_RE = /\bCOURT\s*(?:ROOM\s*)?NO\.?\s*[:.\-–]?\s*(\d{1,3}|[IVX]{1,6})\b/i;
const COURT_DASH_RE = /^COURT\s*[–—-]\s*([IVX]{1,6}|\d{1,3})\b/i;
const CJ_COURT_RE = /CHIEF JUSTICE'S COURT/i;
// Only list headers carry the list date ("DAILY CAUSE LIST FOR DATED : 05-10-2026", "DATE : 05.10.2026"); dates inside
// notes ("order dated ...") are not context.
const DATE_RE = /CAUSE\s+LIST\s+(?:FOR\s+)?(?:DATED\s*)?[:.]?\s*(\d{1,2}[-./]\d{1,2}[-./]\d{4})|^\s*DATE\s*[:.]\s*(\d{1,2}[-./]\d{1,2}[-./]\d{4})/i;
const SECTION_WORDS = /\b(?:list|matters|cases|pronouncement|supplementary|hearing|applications|petitions|admission|orders)\b/i;

export class CauseContext {
  courtNo: string | null = null;
  bench: string[] = [];
  section: string | null = null;
  printedDate: string | null = null;
  private benchOpen = false;

  /** Consume one context line; true when it carried context (court, bench, date or section). */
  consume(raw: string): boolean {
    const text = squash(plain(raw));
    if (!text) return false;
    // Notes ("NOTE: matters of Court No. 3 ...") and long paragraphs never change the court or bench.
    if (/^NOTE\b/i.test(text) || text.split(" ").length > 30) return false;
    let hit = false;
    const d = DATE_RE.exec(text);
    if (d) {
      this.printedDate = dmy(d[1] ?? d[2]) ?? this.printedDate;
      hit = true;
    }
    const c = COURT_RE.exec(text) ?? COURT_DASH_RE.exec(text);
    if (c) {
      this.courtNo = /^\d+$/.test(c[1]) ? String(Number(c[1])) : c[1].toUpperCase();
      this.bench = [];
      this.benchOpen = false;
      this.section = null;
      hit = true;
    } else if (CJ_COURT_RE.test(text)) {
      this.courtNo = "CHIEF JUSTICE'S COURT";
      this.bench = [];
      this.benchOpen = false;
      this.section = null;
      hit = true;
    }
    const inCourt = /^In the Court of\s+(.+)$/i.exec(text);
    if (inCourt) {
      this.bench = [inCourt[1].trim()];
      this.benchOpen = !/\)$/.test(inCourt[1].trim());
      return true;
    }
    if (this.benchOpen && !hit && this.bench.length && /^(?:\(?(?:Judicial|Technical)\)?|Member\b|and\b|Hon)/i.test(text)) {
      const last = this.bench.length - 1;
      this.bench[last] = squash(`${this.bench[last]} ${text}`);
      this.benchOpen = !/\)$/.test(text);
      return true;
    }
    this.benchOpen = false;
    const judges = text.match(/HON'?BLE\b[\s\S]*?(?=HON'?BLE\b|$)/gi);
    if (judges && (hit || /^(?:CORAM\s*:\s*)?HON'?BLE\b/i.test(text) || /JUSTICE/i.test(text))) {
      for (const j of judges) {
        const name = squash(j).replace(/^CORAM\s*:\s*/i, "").replace(/[,;\s]+(?:and)?$/i, "").trim();
        if (name.length > 8 && !this.bench.some((b) => normName(b) === normName(name))) this.bench.push(name);
      }
      return true;
    }
    if (hit) return true;
    if (!/\d/.test(text) && text.length <= 90 && (/^\[[^\]]{3,}\]$/.test(text) || /^(?:for|after)\s/i.test(text) || (SECTION_WORDS.test(text) && text === text.toUpperCase()))) {
      this.section = text.replace(/^\[|\]$/g, "");
      return true;
    }
    return false;
  }

  snapshot(): ContextSnapshot {
    const bench = this.bench.map((b) => b.replace(/[,;\s]+$/, "")).filter(Boolean);
    return { courtNo: this.courtNo, bench: bench.length ? bench.join("; ") : null, section: this.section, printedDate: this.printedDate };
  }
}

function normName(s: string): string {
  return s.toUpperCase().replace(/[^A-Z]/g, "");
}

function dmy(s: string): string | null {
  const m = /^(\d{1,2})[-./](\d{1,2})[-./](\d{4})$/.exec(s);
  if (!m) return null;
  const dt = new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
  if (dt.getUTCMonth() !== +m[2] - 1 || dt.getUTCDate() !== +m[1]) return null;
  return dt.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------------------------------------------------

export interface RawRecord {
  page: number;
  item: string | null;
  /** Cell text per column; one string per printed line (positional) or per row (markdown). */
  cells: Partial<Record<ColumnKey, string[]>>;
  /** Printed lines / rows, cells joined with " | " (contact data is scrubbed by the callers). */
  raw: string[];
  ctx: ContextSnapshot;
  ambiguous: boolean;
  /** "Connected" row of a Supreme Court advance / weekly list (bound to the preceding serial number as printed). */
  connected: boolean;
  /** Personal-data row (Delhi HC "OTHER DETAILS OF ADVOCATES"): never stored. */
  dropped: boolean;
  itemless: boolean;
}

export interface TableProfile {
  /** Column keys the header must contain to be recognised. */
  required: ColumnKey[];
  /** Rows without an item number: continuation of the current record, or (NCLT) an entry of their own when the row
   *  prints its own case number. */
  itemless: "continuation" | "entry";
  /** Supreme Court advance / weekly tables: rows repeating SNo + Case No continue one record; "Connected ..." rows
   *  start a connected record. */
  scGrouping?: boolean;
  /** Supreme Court daily lists: the SNo and Case No share the first column band. */
  combinedItemCase?: boolean;
}

export interface WalkResult {
  records: RawRecord[];
  /** Lines / rows that could not be tied to a record. */
  unparsed: number;
  /** True when a header row was found at all. */
  headerFound: boolean;
  notes: string[];
}

const ITEM_RE = /^(\d{1,5}(?:\.\d{1,3})?)\.?$/;
const ITEM_LEAD_RE = /^(\d{1,5}(?:\.\d{1,3})?)\.?\s+(.+)$/;
const DROP_RE = /OTHER DETAILS OF ADVOCATES/i;

function newRecord(page: number, item: string | null, ctx: CauseContext): RawRecord {
  return { page, item, cells: {}, raw: [], ctx: ctx.snapshot(), ambiguous: false, connected: false, dropped: false, itemless: item == null };
}

function addCell(rec: RawRecord, key: ColumnKey, text: string) {
  const t = text.trim();
  if (!t) return;
  (rec.cells[key] ??= []).push(t);
}

// ---------------------------------------------------------------------------------------------------------------------
// Markdown tables
// ---------------------------------------------------------------------------------------------------------------------

export interface PageText {
  page: number;
  text: string;
}

/** Split page-marked markdown into pages when the per-page text is not given. Markers: "[Page N]", "<!-- page N -->". */
export function pagesOf(markdown: string, pages?: PageText[]): PageText[] {
  if (pages && pages.length) return pages;
  const out: PageText[] = [];
  let cur: PageText = { page: 1, text: "" };
  for (const line of markdown.split("\n")) {
    const m = /^\s*(?:\[Page\s+(\d+)\]|<!--\s*page[:\s]+(\d+)\s*-->)\s*$/i.exec(line);
    if (m) {
      if (cur.text.trim()) out.push(cur);
      cur = { page: Number(m[1] ?? m[2]), text: "" };
      continue;
    }
    cur.text += line + "\n";
  }
  if (cur.text.trim()) out.push(cur);
  return out;
}

function pipeCells(line: string): string[] | null {
  const t = line.trim();
  if (!t.startsWith("|")) return null;
  const inner = t.replace(/^\|/, "").replace(/\|\s*$/, "");
  return inner.split("|").map((c) => squash(plain(c)));
}

const SEPARATOR_RE = /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

/**
 * Walk markdown pipe tables of a cause list into records.
 *
 * Records never continue across a page break (as in `walkPositional`): every page starts with no open record, rows
 * above the first numbered item of a page are counted as unparsed and make the previous page's last record ambiguous
 * (they may continue it; that cannot be known). The one exception is printed, not inferred: a Supreme Court advance /
 * weekly row that repeats the previous page's last SNo and Case No continues that record.
 */
export function walkMarkdown(pages: PageText[], profile: TableProfile): WalkResult {
  const ctx = new CauseContext();
  const records: RawRecord[] = [];
  const notes: string[] = [];
  let columns: (ColumnKey | null)[] | null = null;
  let current: RawRecord | null = null;
  let unparsed = 0;
  let headerFound = false;

  const close = () => {
    if (current) records.push(current);
    current = null;
  };

  for (const { page, text } of pages) {
    close();
    /** The previous page's last record (closed above). */
    const carry: RawRecord | null = records.length ? records[records.length - 1] : null;
    let seenRecordOnPage = false;
    /** A row that cannot be bound while no record is open: before the first record of a page it may continue the
     *  previous page's last record, after a heading a multi-cell row may continue the record before it. */
    const orphanRow = (cellCount: number) => {
      unparsed++;
      const last = records[records.length - 1];
      if (last && !last.dropped && (last.page < page ? !seenRecordOnPage : cellCount > 1)) last.ambiguous = true;
    };
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      if (SEPARATOR_RE.test(line.trim())) continue;
      const cells = pipeCells(line);
      if (!cells) {
        // A court / bench / section header ends the open record: rows after it never continue the previous court's items.
        if (ctx.consume(line)) close();
        // A printed note is not record text: it ends the record above it.
        else if (/^NOTE\b/i.test(squash(plain(line)))) close();
        else if (current && !isPageFurniture(line) && /[A-Za-z]{2}/.test(line)) {
          // Stray text while a record is open (a wrapped cell spilled out of the table, page-break debris): it may belong
          // to the open record, so that record can no longer be read unambiguously. Counted, never bound.
          (current as RawRecord).ambiguous = true;
          unparsed++;
        }
        continue;
      }
      const keys = cells.map(classifyHeader);
      if (profile.required.every((k) => keys.includes(k))) {
        columns = keys.map((k, i) => (k === "item" && isCombinedItemCase(cells[i]) ? "item" : k));
        headerFound = true;
        continue;
      }
      if (!columns) {
        // Rows before any recognised header (calendar grids, notes): context only.
        ctx.consume(cells.filter(Boolean).join(" "));
        continue;
      }
      const nonEmpty = cells.filter(Boolean);
      if (!nonEmpty.length) continue;
      // Section rows: first cell text, every other cell empty ("| AFTER NOTICE MISC. MATTERS |  |  |").
      if (cells[0] && !ITEM_RE.test(cells[0]) && nonEmpty.length === 1 && columns[0] === "item") {
        ctx.consume(cells[0]);
        close();
        continue;
      }
      const row: Partial<Record<ColumnKey, string>> = {};
      const mismatch = cells.length !== columns.length;
      cells.forEach((c, i) => {
        const k = columns![i] ?? "other";
        if (!c) return;
        row[k] = row[k] ? `${row[k]} ${c}` : c;
      });
      let item = row.item ?? "";
      if (profile.combinedItemCase || !ITEM_RE.test(item)) {
        const lead = ITEM_LEAD_RE.exec(item);
        if (lead) {
          item = lead[1];
          row.case = row.case ? `${lead[2]} ${row.case}` : lead[2];
        }
      }
      const itemNo = ITEM_RE.exec(item)?.[1] ?? null;
      const rawLine = cells.join(" | ").replace(/(?:\s*\|\s*)+$/, "");
      if (DROP_RE.test(rawLine)) {
        // Contact-data rows are dropped, as is anything that continues them.
        close();
        current = newRecord(page, itemNo, ctx);
        current.dropped = true;
        seenRecordOnPage = true;
        continue;
      }
      if (itemNo) {
        if (profile.scGrouping && current && !current.dropped && current.item === itemNo && sameCase(current, row.case)) {
          appendRow(current, row, rawLine);
          continue;
        }
        if (
          profile.scGrouping && !current && !seenRecordOnPage && carry && !carry.dropped && carry.item === itemNo && row.case &&
          sameCase(carry, row.case) && records[records.length - 1] === carry
        ) {
          // The row prints the previous page's last SNo and Case No again: the same record, as printed.
          records.pop();
          current = carry;
          seenRecordOnPage = true;
          if (mismatch) current.ambiguous = true;
          appendRow(current, row, rawLine);
          continue;
        }
        close();
        current = newRecord(page, itemNo, ctx);
        seenRecordOnPage = true;
        if (mismatch) current.ambiguous = true;
        appendRow(current, row, rawLine);
        continue;
      }
      if (item && !itemNo) {
        // A non-numeric value in the item column that is not a section row: cannot be bound.
        unparsed++;
        continue;
      }
      if (profile.scGrouping && row.case && /^connected\b/i.test(row.case)) {
        const parent: RawRecord | null = current;
        close();
        current = newRecord(page, parent?.item ?? null, ctx);
        current.connected = true;
        current.itemless = false;
        if (!parent) current.ambiguous = true;
        seenRecordOnPage = true;
        appendRow(current, { ...row, case: row.case.replace(/^connected\s*/i, "") }, rawLine);
        continue;
      }
      if (profile.itemless === "entry" && (row.case || row.caseAlt) && /\d/.test(`${row.case ?? ""} ${row.caseAlt ?? ""}`)) {
        // A printed row without a serial number (NCLT "main matter" rows: a disposed main matter, or one listed on another
        // day): it cannot be told apart from a wrapped cell or a reference row with certainty, so it becomes its own
        // unparsed record (shown as published, never matched), exactly as in walkPositional. Before the first record
        // of a page it may also continue the previous page's last record.
        if (!current && !seenRecordOnPage && carry && !carry.dropped && carry.page < page) carry.ambiguous = true;
        close();
        current = newRecord(page, null, ctx);
        current.itemless = true;
        current.ambiguous = true;
        seenRecordOnPage = true;
        appendRow(current, row, rawLine);
        continue;
      }
      const cur = current as RawRecord | null;
      if (cur) {
        if (!cur.dropped) {
          if (mismatch) cur.ambiguous = true;
          appendRow(cur, row, rawLine);
        }
        continue;
      }
      orphanRow(nonEmpty.length);
    }
  }
  close();
  if (!headerFound) notes.push("no table header recognised");
  return { records, unparsed, headerFound, notes };
}

/** Page numbers ("Page 3 of 40", "- 3 -") and lines left with nothing but contact-removal markers: never record text. */
function isPageFurniture(line: string): boolean {
  const t = squash(plain(line).replace(/\[(?:e-?mail|phone|link) removed\]/gi, " ").replace(/[<>()[\]*_:|-]/g, " "));
  return !/[A-Za-z]{2}/.test(t) || /^page\s*(?:no\.?\s*)?\d+(?:\s*(?:of|\/)\s*\d+)?$/i.test(t);
}

function sameCase(rec: RawRecord, caseCell: string | undefined): boolean {
  const first = rec.cells.case?.[0] ?? "";
  return !caseCell || squash(first) === squash(caseCell);
}

function appendRow(rec: RawRecord, row: Partial<Record<ColumnKey, string>>, rawLine: string) {
  for (const [k, v] of Object.entries(row) as [ColumnKey, string][]) {
    if (k === "item") continue;
    if (k === "case" && rec.cells.case?.length && squash(rec.cells.case[0]) === squash(v)) continue;
    addCell(rec, k, v);
  }
  rec.raw.push(rawLine);
}

// ---------------------------------------------------------------------------------------------------------------------
// Positional text items
// ---------------------------------------------------------------------------------------------------------------------

export interface TextItem {
  page: number;
  str: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Line {
  y: number;
  items: TextItem[];
  text: string;
}

interface Band {
  key: ColumnKey;
  label: string;
  x0: number;
  x1: number;
  lo: number;
  hi: number;
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/** Group a page's items into lines by y (tolerance from the item heights), items in x order. */
export function groupLines(items: TextItem[]): Line[] {
  const its = items.filter((i) => i.str && i.str.trim());
  if (!its.length) return [];
  const tol = Math.max(1.5, median(its.map((i) => i.h || 0)) * 0.45);
  const sorted = [...its].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: Line[] = [];
  for (const it of sorted) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(it.y - last.y) <= tol) last.items.push(it);
    else lines.push({ y: it.y, items: [it], text: "" });
  }
  for (const l of lines) {
    l.items.sort((a, b) => a.x - b.x);
    l.text = squash(l.items.map((i) => i.str).join(" "));
  }
  return lines;
}

function charWidth(items: TextItem[]): number {
  const ws = items.filter((i) => i.w > 0 && i.str.trim().length > 0).map((i) => i.w / i.str.length);
  return median(ws) || 5;
}

interface Cluster {
  x0: number;
  x1: number;
  parts: { y: number; x: number; str: string }[];
}

/** Cluster header items into cells by x extent (words of one label merge; columns stay apart). */
function clusterHeader(items: TextItem[]): Cluster[] {
  const gap = Math.max(4, charWidth(items) * 1.3);
  const sorted = [...items].sort((a, b) => a.x - b.x);
  const out: Cluster[] = [];
  for (const it of sorted) {
    const x1 = it.x + Math.max(it.w, 0);
    const last = out[out.length - 1];
    if (last && it.x - last.x1 <= gap) {
      last.x1 = Math.max(last.x1, x1);
      last.parts.push({ y: it.y, x: it.x, str: it.str });
    } else out.push({ x0: it.x, x1, parts: [{ y: it.y, x: it.x, str: it.str }] });
  }
  return out;
}

function clusterLabel(c: Cluster, descending: boolean): string {
  const parts = [...c.parts].sort((a, b) => (descending ? b.y - a.y : a.y - b.y) || a.x - b.x);
  return squash(parts.map((p) => p.str).join(" "));
}

interface Header {
  lineIdx: number[];
  bands: Band[];
}

/** Find the header among the first lines of a page: one line, or two / three adjacent lines (wrapped labels). */
function findHeader(lines: Line[], required: ColumnKey[]): Header | null {
  for (let i = 0; i < lines.length; i++) {
    for (const span of [1, 2, 3]) {
      const group = lines.slice(i, i + span);
      if (group.length < span) break;
      if (span > 1) {
        const h = median(group[0].items.map((x) => x.h || 0)) || 10;
        if (Math.abs(group[span - 1].y - group[0].y) > h * 2.6 * (span - 1)) break;
      }
      const items = group.flatMap((l) => l.items);
      const clusters = clusterHeader(items);
      if (clusters.length < required.length) continue;
      // Label order inside a wrapped cell follows reading order; direction is resolved later, so try top-down first.
      const labels = clusters.map((c) => clusterLabel(c, false));
      let keys = labels.map(classifyHeader);
      if (!required.every((k) => keys.includes(k))) {
        const alt = clusters.map((c) => clusterLabel(c, true)).map(classifyHeader);
        if (!required.every((k) => alt.includes(k))) continue;
        keys = alt;
      }
      const bands: Band[] = clusters.map((c, j) => ({ key: keys[j] ?? "other", label: labels[j], x0: c.x0, x1: c.x1, lo: 0, hi: 0 }));
      for (let j = 0; j < bands.length; j++) {
        bands[j].lo = j === 0 ? -Infinity : (bands[j - 1].x1 + bands[j].x0) / 2;
        bands[j].hi = j === bands.length - 1 ? Infinity : (bands[j].x1 + bands[j + 1].x0) / 2;
      }
      return { lineIdx: group.map((_, k) => i + k), bands };
    }
  }
  return null;
}

/**
 * Column left edges learned from the page's own rows. Labels are often centred over wide columns while cell text is
 * left-aligned at the column edge, so label positions alone misplace short cells. First pass: every item of a
 * multi-column line goes to the label whose centre band holds the item's centre; the leftmost edge seen per column
 * (or its label start, whichever is further left) becomes the column start. Edges that do not increase from column to
 * column are not trusted: the label-midpoint bands are kept.
 */
function refineBands(labels: Band[], lines: Line[]): Band[] {
  const centers = labels.map((b) => (b.x0 + b.x1) / 2);
  const bounds = centers.slice(1).map((c, i) => (centers[i] + c) / 2);
  const edges: number[][] = labels.map(() => []);
  for (const l of lines) {
    if (l.items.length < 2) continue;
    for (const it of l.items) {
      const c = it.x + Math.max(it.w, 0) / 2;
      let j = 0;
      while (j < bounds.length && c >= bounds[j]) j++;
      edges[j].push(it.x);
    }
  }
  const lefts = labels.map((b, j) => Math.min(b.x0, edges[j].length ? Math.min(...edges[j]) : b.x0));
  for (let j = 1; j < lefts.length; j++) if (!(lefts[j] > lefts[j - 1] + 2)) return labels;
  return labels.map((b, j) => ({ ...b, x0: lefts[j], lo: j === 0 ? -Infinity : lefts[j] - 1.5, hi: j === labels.length - 1 ? Infinity : lefts[j + 1] - 1.5 }));
}

function bandOf(bands: Band[], x: number): number {
  for (let j = 0; j < bands.length; j++) if (x + 0.5 >= bands[j].lo && x + 0.5 < bands[j].hi) return j;
  return bands.length - 1;
}

/**
 * Walk positional text items of a cause list into records. Pages without their own header reuse the previous page's
 * bands and reading direction; a document whose first page has no header yields no records.
 */
export function walkPositional(items: TextItem[], profile: TableProfile): WalkResult {
  const ctx = new CauseContext();
  const records: RawRecord[] = [];
  const notes: string[] = [];
  let unparsed = 0;
  let headerFound = false;
  let labels: Band[] | null = null;
  let bands: Band[] | null = null;
  let descending: boolean | null = null;
  let current: RawRecord | null = null;
  const close = () => {
    if (current) records.push(current);
    current = null;
  };

  const byPage = new Map<number, TextItem[]>();
  for (const it of items) {
    if (!byPage.has(it.page)) byPage.set(it.page, []);
    byPage.get(it.page)!.push(it);
  }
  const pageNos = [...byPage.keys()].sort((a, b) => a - b);

  for (const page of pageNos) {
    const ascLines = groupLines(byPage.get(page)!);
    const header = findHeader(ascLines, profile.required);
    let headerIdx = new Set<number>();
    if (header) {
      headerFound = true;
      labels = header.bands;
      headerIdx = new Set(header.lineIdx);
      const hy = ascLines[header.lineIdx[0]].y;
      const above = ascLines.filter((l, i) => !headerIdx.has(i) && l.y > hy).length;
      const below = ascLines.filter((l, i) => !headerIdx.has(i) && l.y < hy).length;
      descending = below > above; // PDF user space: y grows upwards, so data below the header has smaller y.
    }
    if (!labels || descending == null) {
      unparsed += ascLines.length;
      if (!headerFound) notes.push(`page ${page}: no table header recognised`);
      continue;
    }
    // Records never continue across a page break: text before the first item of a page is not bound to the previous
    // page's last record (which is then marked ambiguous below).
    close();
    const order = ascLines.map((l, i) => ({ l, i }));
    if (descending) order.reverse();
    const headerPos = header ? order.findIndex((o) => o.i === header.lineIdx[0]) : -1;
    bands = refineBands(labels, order.filter((o, p) => p > headerPos && !headerIdx.has(o.i)).map((o) => o.l));
    let seenRecordOnPage = false;
    const itemBand = bands.findIndex((b) => b.key === "item");

    for (let p = 0; p < order.length; p++) {
      const { l, i } = order[p];
      if (headerIdx.has(i)) continue;
      if (header && p < headerPos) {
        ctx.consume(l.text);
        continue;
      }
      // Repeated header lines on pages that also carry a recognised header elsewhere.
      const asKeys = clusterHeader(l.items).map((c) => classifyHeader(clusterLabel(c, false)));
      if (profile.required.every((k) => asKeys.includes(k))) continue;

      const cells = new Map<number, string[]>();
      let spanning = false;
      for (const it of l.items) {
        const j = bandOf(bands, it.x);
        // Text running past the start of the next column's header label belongs to no single column.
        if (j < bands.length - 1 && it.x + Math.max(it.w, 0) > bands[j + 1].x0 + 2) spanning = true;
        if (!cells.has(j)) cells.set(j, []);
        cells.get(j)!.push(it.str);
      }
      const cellText = (j: number) => squash((cells.get(j) ?? []).join(" "));
      let itemText = itemBand >= 0 ? cellText(itemBand) : "";
      let caseOverflow = "";
      const lead = ITEM_LEAD_RE.exec(itemText);
      if (lead && !ITEM_RE.test(itemText)) {
        itemText = lead[1];
        caseOverflow = lead[2];
      }
      const itemNo = ITEM_RE.exec(itemText)?.[1] ?? null;
      const onlyOneCell = cells.size === 1;

      // Court / bench / date headers and section headings.
      if (!itemNo && (spanning && onlyOneCell || isStrongContext(l.text) || (itemText && !profile.combinedItemCase && onlyOneCell))) {
        if (ctx.consume(l.text)) {
          close();
          continue;
        }
      }
      if (!itemNo && profile.combinedItemCase && onlyOneCell && /^\[[^\]]{3,}\]$/.test(l.text) && ctx.consume(l.text)) {
        close();
        continue;
      }
      const lineRaw = [...cells.keys()].sort((a, b) => a - b).map((j) => cellText(j)).join(" | ");

      if (itemNo) {
        if (/OTHER DETAILS OF ADVOCATES/i.test(l.text)) {
          close();
          current = newRecord(page, itemNo, ctx);
          current.dropped = true;
          seenRecordOnPage = true;
          continue;
        }
        close();
        current = newRecord(page, itemNo, ctx);
        seenRecordOnPage = true;
        if (spanning) current.ambiguous = true;
        if (caseOverflow) addCell(current, "case", caseOverflow);
        for (const [j, parts] of cells) {
          if (j === itemBand) continue;
          addCell(current, bands[j].key, squash(parts.join(" ")));
        }
        current.raw.push(lineRaw);
        continue;
      }
      if (itemText && !profile.combinedItemCase) {
        // Non-numeric text in the item column that is not a recognised heading: never bound to a neighbour.
        unparsed++;
        continue;
      }
      if (!current) {
        unparsed++;
        // Text above the first record of a page may continue the previous page's last record, and record-like text
        // after a heading may continue the record before it: that record can no longer be read unambiguously.
        const last = records[records.length - 1];
        if (last && !last.dropped && (last.page < page ? !seenRecordOnPage : cells.size > 1)) last.ambiguous = true;
        continue;
      }
      const cur = current as RawRecord;
      if (cur.dropped) continue;
      if (/OTHER DETAILS OF ADVOCATES/i.test(l.text)) {
        // The contact-data block starts inside a record without its own item number: stop the record here.
        close();
        continue;
      }
      if (profile.itemless === "entry") {
        const caseBand = bands.findIndex((b) => b.key === "case");
        const partiesBand = bands.findIndex((b) => b.key === "parties");
        if (caseBand >= 0 && partiesBand >= 0 && /\d\s*\(?[A-Z]{1,6}\)?\s*\/?\s*(?:19|20)\d{2}/.test(cellText(caseBand)) && cellText(partiesBand)) {
          // A new printed row without a serial number (NCLT "main matter" rows): it cannot be told apart from a
          // wrapped cell with certainty, so it becomes its own unparsed record.
          close();
          current = newRecord(page, null, ctx);
          current.ambiguous = true;
          seenRecordOnPage = true;
        }
      }
      const target = current as RawRecord;
      if (spanning) target.ambiguous = true;
      if (caseOverflow) addCell(target, "case", caseOverflow);
      for (const [j, parts] of cells) {
        const key = j === itemBand ? (profile.combinedItemCase ? "case" : "other") : bands[j].key;
        addCell(target, key, squash(parts.join(" ")));
      }
      target.raw.push(lineRaw);
    }
  }
  close();
  if (!headerFound) notes.push("no table header recognised in the positional text");
  return { records, unparsed, headerFound, notes };
}

function isStrongContext(text: string): boolean {
  const t = squash(plain(text));
  if (/^NOTE\b/i.test(t) || t.split(" ").length > 30) return false;
  return COURT_RE.test(t) || COURT_DASH_RE.test(t) || CJ_COURT_RE.test(t) || DATE_RE.test(t) || /^(?:CORAM\s*:\s*)?HON'?BLE\b.*(?:JUSTICE|MEMBER)/i.test(t) || /^In the Court of\b/i.test(t);
}
