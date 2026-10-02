/**
 * Cause-list parsing (pure, deterministic): published list → CauseListEntry records.
 *
 * Layouts
 * - "sci-daily": Supreme Court daily lists (misc / regular / chamber / single judge / registrar, main and
 *   supplementary). Three printed columns (SNo + Case No | Petitioner / Respondent | Petitioner/Respondent Advocate)
 *   whose text layers interleave in reading order, so ONLY positional text items are used; without them nothing is
 *   parsed (the document stays searchable as text).
 * - "sci-table": Supreme Court advance and weekly lists (four-column tables; continuation rows repeat SNo + Case No;
 *   "Connected ..." rows are bound to the serial number they are printed under).
 * - "dhc": Delhi High Court lists (COURT NO. / bench headers, ITEM NUMBER | CASE NUMBER | PARTY NAME | ADVOCATE NAME);
 *   "OTHER DETAILS OF ADVOCATES" rows (e-mails, phone numbers) are dropped.
 * - "tribunal": NCLT / NCLAT lists: a generic table keyed on header names (Sr. / S. No., CP. No. / Case No., CA/IA No.,
 *   parties, counsel columns); bench-specific column orders are tolerated because columns are found by name.
 *
 * Every entry keeps its verbatim row text (`raw`, contact data removed), page, court number and bench as printed.
 * Contact data (phone numbers, e-mails, links) is removed from every stored text field here, whichever input the
 * record was read from: markdown pages arrive scrubbed, positional PDF items do not.
 * An entry whose identifiers cannot be read, or whose text could not be bound to one row unambiguously, is stored
 * with `parsed: false` and is never matched to a matter.
 */

import { createHash } from "node:crypto";
import type { CauseListEntry, CauseListType } from "../types";
import { findDiaryNos, parseCaseNumbers, type ParsedCaseNumber } from "../case-numbers";
import { pagesOf, walkMarkdown, walkPositional, type RawRecord, type TableProfile, type TextItem, type WalkResult } from "./table";
import { commaAdvocates, normalizeParties, scAdvocates, scParties, scrubContact, squash, tribunalAdvocates } from "./text";

export type CauseListLayout = "sci-daily" | "sci-table" | "dhc" | "tribunal";

export interface CauseListDoc {
  id: string;
  markdown: string;
  pages: { page: number; text: string }[];
  items?: TextItem[];
  fetchedAt: string;
}

export interface CauseListParseOptions {
  layout: CauseListLayout;
  forum: string;
  listType: CauseListType;
  /** ISO date the list is for (hearing date). */
  listDate: string;
  publishedAt?: string | null;
  /** Item count printed by the publisher's index (NCLT "No. of Entries"), for a completeness note. */
  expectedEntries?: number | null;
}

export interface CauseListParseResult {
  records: CauseListEntry[];
  unparsed: number;
  notes: string[];
}

const PROFILES: Record<CauseListLayout, TableProfile> = {
  "sci-daily": { required: ["item", "parties"], itemless: "continuation", combinedItemCase: true },
  "sci-table": { required: ["item", "case", "parties"], itemless: "continuation", scGrouping: true },
  dhc: { required: ["item", "case", "parties"], itemless: "continuation" },
  tribunal: { required: ["item", "case", "parties"], itemless: "entry" },
};

/** Stable entry id: same document + same position → same id (re-parsing a new version replaces in place). */
export function causeListEntryId(documentId: string, seq: number): string {
  return `cle_${createHash("sha256").update(`${documentId}\u0000${seq}`).digest("hex").slice(0, 24)}`;
}

function hasPipeTable(markdown: string): boolean {
  return /^\s*\|.*\|\s*$/m.test(markdown);
}

/** Parse a published cause list into entries. */
export function parseCauseList(doc: CauseListDoc, opts: CauseListParseOptions): CauseListParseResult {
  const profile = PROFILES[opts.layout];
  const notes: string[] = [];
  let walk: WalkResult | null = null;
  if (opts.layout === "sci-daily") {
    if (!doc.items?.length) {
      return { records: [], unparsed: doc.pages.length || 1, notes: ["Supreme Court daily list: positional text is required to bind columns to items; not parsed (text kept for search)"] };
    }
    walk = walkPositional(doc.items, profile);
  } else {
    const pages = pagesOf(doc.markdown, doc.pages);
    if (pages.some((p) => hasPipeTable(p.text))) walk = walkMarkdown(pages, profile);
    if ((!walk || !walk.headerFound) && doc.items?.length) walk = walkPositional(doc.items, profile);
    walk ??= walkMarkdown(pages, profile);
  }
  notes.push(...walk.notes);

  const records: CauseListEntry[] = [];
  let seq = 0;
  let unparsed = walk.unparsed;
  const printedDates = new Set<string>();
  for (const rec of walk.records) {
    if (rec.dropped) continue;
    const entry = buildEntry(rec, doc, opts, seq++);
    if (!entry) continue;
    if (!entry.parsed) unparsed++;
    if (rec.ctx.printedDate) printedDates.add(rec.ctx.printedDate);
    records.push(entry);
  }
  for (const d of printedDates) if (d !== opts.listDate) notes.push(`list header prints ${d}; entries are dated ${opts.listDate} from the publisher's listing`);
  if (opts.expectedEntries != null) {
    const numbered = records.filter((r) => r.itemNo).length;
    if (numbered !== opts.expectedEntries) notes.push(`publisher index shows ${opts.expectedEntries} entries; ${numbered} numbered items parsed`);
  }
  return { records, unparsed, notes };
}

function caseColumns(rec: RawRecord): ParsedCaseNumber[] {
  const main = parseCaseNumbers((rec.cells.case ?? []).join(" "));
  const alt = parseCaseNumbers((rec.cells.caseAlt ?? []).join(" "));
  const seen = new Set<string>();
  return [...main, ...alt].filter((c) => (seen.has(c.printed) ? false : (seen.add(c.printed), true)));
}

function buildEntry(rec: RawRecord, doc: CauseListDoc, opts: CauseListParseOptions, seq: number): CauseListEntry | null {
  const caseText = squash((rec.cells.case ?? []).join(" "));
  const cases = caseColumns(rec);
  const sc = opts.layout === "sci-daily" || opts.layout === "sci-table";
  const diaryNo = sc ? findDiaryNos(caseText)[0] ?? null : null;
  let parties: string | null;
  let advocates: string[];
  if (sc) {
    parties = scParties(rec.cells.parties ?? []);
    advocates = scAdvocates((rec.cells.advocates ?? []).join(" "));
  } else if (opts.layout === "dhc") {
    parties = rec.cells.parties?.length ? normalizeParties(rec.cells.parties.join(" ")) : null;
    // Wrapped lines of one cell continue a name ("SHANTANU" / "SAGAR"); names are separated by printed commas.
    advocates = commaAdvocates((rec.cells.advocates ?? []).join(" "));
  } else {
    parties = rec.cells.parties?.length ? normalizeParties(rec.cells.parties.join(" ")) : null;
    advocates = tribunalAdvocates([...(rec.cells.advPet ?? []), ...(rec.cells.advRes ?? []), ...(rec.cells.advocates ?? [])].join("\n"));
  }
  // Positional PDF items reach the parser unscrubbed (only page text is scrubbed upstream): every stored text field is
  // scrubbed here (advocates by the splitters above, which also drop contact residue).
  const raw = scrubContact(rec.raw.join("\n"));
  if (!raw) return null;
  const identified = cases.some((c) => c.keys.length > 0) || !!diaryNo;
  return {
    id: causeListEntryId(doc.id, seq),
    documentId: doc.id,
    forum: opts.forum,
    listDate: opts.listDate,
    listType: opts.listType,
    courtNo: rec.ctx.courtNo,
    bench: rec.ctx.bench ? scrubContact(rec.ctx.bench) || null : null,
    itemNo: rec.item,
    caseNumbers: cases.map((c) => ({ printed: c.printed, normalized: c.normalized })),
    diaryNo,
    parties: parties ? scrubContact(parties) : null,
    advocates,
    raw: rec.connected && !/^\s*\|?\s*Connected/i.test(raw) ? `Connected: ${raw}` : raw,
    page: rec.page,
    publishedAt: opts.publishedAt ?? null,
    fetchedAt: doc.fetchedAt,
    parsed: !rec.ambiguous && identified,
  };
}
