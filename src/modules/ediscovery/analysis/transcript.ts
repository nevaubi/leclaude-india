/**
 * Pure transcript helpers (client + server safe): full-text search across
 * transcripts, page:line arithmetic, designation export, objection summary.
 */
import type { Deposition, DepositionQA } from "@/lib/types/domain";
import type { Designation, ObjectionRuling, ObjectionSummary, QAFlag, TranscriptHit } from "./types";
import { formatPageLine, formatRange } from "./types";

export const LINES_PER_PAGE = 25;

export function comparePageLine(aPage: number, aLine: number, bPage: number, bLine: number) {
  return aPage !== bPage ? aPage - bPage : aLine - bLine;
}

/** Inclusive test: is (page,line) within the range? */
export function inRange(page: number, line: number, r: Pick<Designation, "startPage" | "startLine" | "endPage" | "endLine">) {
  return comparePageLine(page, line, r.startPage, r.startLine) >= 0 && comparePageLine(page, line, r.endPage, r.endLine) <= 0;
}

/** Approximate the last line a Q/A pair occupies (question + answer wrapped at ~58 chars). */
export function qaEndLine(qa: DepositionQA): { page: number; line: number } {
  const lines = Math.max(2, Math.ceil(qa.question.length / 58) + Math.ceil(qa.answer.length / 58) + (qa.objection ? Math.ceil((qa.objection.text ?? "Objection.").length / 58) : 0));
  let page = qa.page;
  let line = qa.line + lines - 1;
  while (line > LINES_PER_PAGE) { line -= LINES_PER_PAGE; page += 1; }
  return { page, line };
}

/** Extract a "page:line" locator from a cite such as "Vasudevan 84:12" or "Hegde 46:07–46:20". */
export function pageLineOf(cite: string | undefined): string | null {
  const m = cite?.match(/(\d{1,4}):(\d{1,2})/);
  return m ? `${Number(m[1])}:${Number(m[2])}` : null;
}

/** Resolve a "page:line" locator to the Q/A pair that contains it: exact start, else the last pair starting at or before it, else the first pair on that page. */
export function resolvePageLine(transcript: DepositionQA[], locator: string): number {
  const m = locator.match(/^(\d+):(\d+)$/);
  if (!m) return -1;
  const page = Number(m[1]), line = Number(m[2]);
  const exact = transcript.findIndex((qa) => qa.page === page && qa.line === line);
  if (exact >= 0) return exact;
  let best = -1;
  transcript.forEach((qa, i) => { if (qa.page < page || (qa.page === page && qa.line <= line)) best = i; });
  if (best >= 0 && (transcript[best].page === page || qaEndLine(transcript[best]).page >= page)) return best;
  return transcript.findIndex((qa) => qa.page === page);
}

export function normalizeRange(r: Pick<Designation, "startPage" | "startLine" | "endPage" | "endLine">) {
  if (comparePageLine(r.startPage, r.startLine, r.endPage, r.endLine) <= 0) return r;
  return { startPage: r.endPage, startLine: r.endLine, endPage: r.startPage, endLine: r.startLine };
}

/** Q/A pairs whose start falls inside a range. */
export function qaInRange(transcript: DepositionQA[], r: Pick<Designation, "startPage" | "startLine" | "endPage" | "endLine">) {
  return transcript.map((qa, index) => ({ qa, index })).filter(({ qa }) => inRange(qa.page, qa.line, r));
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

function tokens(q: string): string[] {
  return q.toLowerCase().split(/[^a-z0-9µ'-]+/i).map((t) => t.replace(/^['-]+|['-]+$/g, "")).filter((t) => t.length > 1);
}

function snippetAround(text: string, terms: string[], radius = 110) {
  const lower = text.toLowerCase();
  let pos = -1;
  for (const t of terms) { const i = lower.indexOf(t); if (i >= 0 && (pos < 0 || i < pos)) pos = i; }
  if (pos < 0) return text.length > radius * 2 ? text.slice(0, radius * 2) + "…" : text;
  const start = Math.max(0, pos - radius);
  const end = Math.min(text.length, pos + radius);
  return (start > 0 ? "…" : "") + text.slice(start, end).trim() + (end < text.length ? "…" : "");
}

/**
 * Full-text search across transcripts. Phrase queries ("...") require the
 * exact phrase; otherwise every token must appear in the field (AND) unless
 * mode is "any", and results are scored by matched terms and term frequency,
 * with answers ranked above questions.
 */
export function searchTranscripts(depositions: Pick<Deposition, "id" | "witnessName" | "transcript">[], query: string, opts: { limit?: number; flags?: QAFlag[]; mode?: "all" | "any" } = {}): TranscriptHit[] {
  const q = query.trim();
  if (!q) return [];
  const phrase = q.match(/^"(.+)"$/)?.[1]?.toLowerCase();
  const terms = phrase ? [phrase] : tokens(q);
  if (!terms.length) return [];
  const any = opts.mode === "any";
  const hits: TranscriptHit[] = [];
  for (const dep of depositions) {
    dep.transcript.forEach((qa, index) => {
      if (opts.flags?.length && !opts.flags.some((f) => qa.flags?.includes(f))) return;
      const fields: [TranscriptHit["field"], string | undefined][] = [["answer", qa.answer], ["question", qa.question], ["objection", qa.objection?.text], ["note", qa.note]];
      for (const [field, text] of fields) {
        if (!text) continue;
        const lower = text.toLowerCase();
        const matched = terms.filter((t) => lower.includes(t)).length;
        if (any ? matched === 0 : matched < terms.length) continue;
        let score = 0;
        for (const t of terms) { let i = -1; while ((i = lower.indexOf(t, i + 1)) >= 0) score += 1; }
        score = score / Math.sqrt(1 + text.length / 400) + matched * 2 + (field === "answer" ? 0.5 : 0) + (qa.flags?.length ? 0.25 : 0);
        hits.push({ depositionId: dep.id, witnessName: dep.witnessName, index, page: qa.page, line: qa.line, field, snippet: snippetAround(text, terms), score: Math.round(score * 100) / 100 });
      }
    });
  }
  hits.sort((a, b) => b.score - a.score || a.page - b.page || a.line - b.line);
  return opts.limit ? hits.slice(0, opts.limit) : hits;
}

export function highlightTerms(query: string): RegExp | null {
  const phrase = query.trim().match(/^"(.+)"$/)?.[1];
  const terms = phrase ? [phrase] : tokens(query);
  if (!terms.length) return null;
  return new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
}

// ---------------------------------------------------------------------------
// Objections
// ---------------------------------------------------------------------------

/** `rulings` maps a Q/A index to the court's ruling on the objection recorded there (entered from the Objections panel). */
export function summarizeObjections(transcript: DepositionQA[], rulings: Record<number, ObjectionRuling> = {}): ObjectionSummary {
  const byBasis = new Map<string, number>();
  const byAttorney = new Map<string, number>();
  let total = 0;
  let sustained = 0;
  let overruled = 0;
  transcript.forEach((qa, i) => {
    if (!qa.objection) return;
    total++;
    const basis = qa.objection.basis.toLowerCase();
    byBasis.set(basis, (byBasis.get(basis) ?? 0) + 1);
    byAttorney.set(qa.objection.by, (byAttorney.get(qa.objection.by) ?? 0) + 1);
    if (rulings[i] === "sustained") sustained++;
    else if (rulings[i] === "overruled") overruled++;
  });
  const sort = (m: Map<string, number>) => Array.from(m.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return {
    total,
    byBasis: sort(byBasis).map(([basis, count]) => ({ basis, count })),
    byAttorney: sort(byAttorney).map(([attorney, count]) => ({ attorney, count })),
    rulings: { sustained, overruled, pending: total - sustained - overruled },
  };
}

// ---------------------------------------------------------------------------
// Designations export
// ---------------------------------------------------------------------------

function csvCell(v: unknown) {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export interface DesignationExportRow {
  witness: string;
  date: string;
  range: string;
  purpose: string;
  startPage: number;
  startLine: number;
  endPage: number;
  endLine: number;
  note: string;
  excerpt: string;
}

export function designationRows(dep: Pick<Deposition, "witnessName" | "date" | "transcript">, designations: Designation[]): DesignationExportRow[] {
  const sorted = [...designations].sort((a, b) => comparePageLine(a.startPage, a.startLine, b.startPage, b.startLine));
  return sorted.map((d) => {
    const qas = qaInRange(dep.transcript, d);
    const excerpt = qas.map(({ qa }) => `Q. ${qa.question} A. ${qa.answer}`).join(" ");
    return { witness: dep.witnessName, date: dep.date, range: formatRange(d), purpose: d.purpose, startPage: d.startPage, startLine: d.startLine, endPage: d.endPage, endLine: d.endLine, note: d.note ?? "", excerpt: excerpt.length > 600 ? excerpt.slice(0, 600) + "…" : excerpt };
  });
}

/** CSV in the column order trial-presentation vendors expect (witness, begin page/line, end page/line, purpose, note). */
export function designationsCsv(dep: Pick<Deposition, "witnessName" | "date" | "transcript">, designations: Designation[]): string {
  const rows = designationRows(dep, designations);
  const header = ["Witness", "Deposition date", "Begin page", "Begin line", "End page", "End line", "Range", "Purpose", "Note", "Excerpt"];
  const lines = [header.join(",")];
  for (const r of rows) lines.push([r.witness, r.date, r.startPage, r.startLine, r.endPage, r.endLine, r.range, r.purpose, r.note, r.excerpt].map(csvCell).join(","));
  return lines.join("\r\n") + "\r\n";
}

export function designationsMarkdown(dep: Pick<Deposition, "witnessName" | "date" | "transcript" | "witnessTitle">, designations: Designation[], opts: { matterName?: string } = {}): string {
  const sorted = [...designations].sort((a, b) => comparePageLine(a.startPage, a.startLine, b.startPage, b.startLine));
  const rows = designationRows(dep, sorted);
  const out: string[] = [];
  out.push(`# Deposition designations — ${dep.witnessName}`);
  out.push("");
  out.push(`${opts.matterName ? `**Matter:** ${opts.matterName}  ` : ""}**Deposition of:** ${dep.witnessName}${dep.witnessTitle ? ` (${dep.witnessTitle})` : ""}  **Taken:** ${dep.date}  **Designations:** ${rows.length}`);
  out.push("");
  out.push("| # | Page:line | Purpose | Note |");
  out.push("|---|---|---|---|");
  rows.forEach((r, i) => out.push(`| ${i + 1} | ${r.range} | ${r.purpose} | ${r.note.replace(/\|/g, "/")} |`));
  out.push("");
  rows.forEach((r, i) => {
    out.push(`## ${i + 1}. ${r.range} (${r.purpose})`);
    if (r.note) out.push(`> ${r.note}`);
    const qas = qaInRange(dep.transcript, sorted[i]);
    for (const { qa } of qas) {
      out.push(`**${formatPageLine(qa.page, qa.line)}** Q. ${qa.question}`);
      out.push("");
      out.push(`A. ${qa.answer}`);
      out.push("");
    }
  });
  return out.join("\n");
}

/** One page:line window of a transcript for segmented analysis (whole-transcript coverage, constitution §28). */
export interface TranscriptSegment {
  index: number;
  /** Indexes into `dep.transcript` (contiguous, in order). */
  indexes: number[];
  from: { page: number; line: number };
  to: { page: number; line: number };
  /** "20:01–58:24" */
  range: string;
  chars: number;
}

/**
 * Split a transcript into contiguous page:line windows of at most `maxChars` rendered characters (a single Q/A longer
 * than that is its own window, never cut). Every Q/A belongs to exactly one window, so the union covers the whole
 * transcript — no prefix truncation.
 */
export function segmentTranscript(dep: Pick<Deposition, "witnessName" | "transcript">, maxChars: number): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
  let cur: number[] = [];
  let chars = 0;
  const size = (i: number) => transcriptText(dep, { indexes: [i], maxChars: Number.MAX_SAFE_INTEGER }).length + 2;
  const flush = () => {
    if (!cur.length) return;
    const a = dep.transcript[cur[0]], b = dep.transcript[cur[cur.length - 1]];
    out.push({ index: out.length, indexes: cur, from: { page: a.page, line: a.line }, to: { page: b.page, line: b.line }, range: `${formatPageLine(a.page, a.line)}–${formatPageLine(b.page, b.line)}`, chars });
    cur = [];
    chars = 0;
  };
  for (let i = 0; i < dep.transcript.length; i++) {
    const n = size(i);
    if (cur.length && chars + n > maxChars) flush();
    cur.push(i);
    chars += n;
  }
  flush();
  return out;
}

/** Plain-text transcript excerpt for prompts. */
export function transcriptText(dep: Pick<Deposition, "witnessName" | "transcript">, opts: { maxChars?: number; indexes?: number[] } = {}) {
  const idx = opts.indexes ? new Set(opts.indexes) : null;
  const parts: string[] = [];
  dep.transcript.forEach((qa, i) => {
    if (idx && !idx.has(i)) return;
    const flags = qa.flags?.length ? ` [${qa.flags.join(", ")}]` : "";
    // Indian deposition rows: chief-examination paragraphs and narrative cross-examination carry no question.
    const iq = qa as DepositionQA & { segment?: string; para?: number; narrative?: boolean };
    if (iq.segment && !qa.question) {
      const label = iq.segment === "chief" ? `Chief${iq.para ? ` ¶${iq.para}` : ""}` : iq.segment === "cross" ? "Cross" : iq.segment === "re_examination" ? "Re-exam" : "Court";
      parts.push(`${formatPageLine(qa.page, qa.line)} [${label}]${flags}\n${qa.answer}${qa.exhibit ? `\n   (${qa.exhibit})` : ""}`);
      return;
    }
    parts.push(`${formatPageLine(qa.page, qa.line)}${iq.segment ? ` [${iq.segment === "cross" ? "Cross" : iq.segment === "re_examination" ? "Re-exam" : iq.segment === "court" ? "Court" : "Chief"}]` : ""}${flags}\nQ. ${qa.question}${qa.objection ? `\n   ${qa.objection.by}: Objection, ${qa.objection.basis}.${qa.objection.text ? ` ${qa.objection.text}` : ""}` : ""}\nA. ${qa.answer}${qa.exhibit ? `\n   (Exhibit ${qa.exhibit})` : ""}`);
  });
  let text = parts.join("\n\n");
  const max = opts.maxChars ?? 40_000;
  if (text.length > max) text = text.slice(0, max) + "\n…[truncated]";
  return text;
}

// ---------------------------------------------------------------------------
// Designation math (page:line arithmetic for designations, counters, objections)
// ---------------------------------------------------------------------------

export type PageLineRange = Pick<Designation, "startPage" | "startLine" | "endPage" | "endLine">;

/** Absolute line index (page 1 line 1 = 1) so ranges can be compared and measured. */
export function absoluteLine(page: number, line: number, linesPerPage = LINES_PER_PAGE) {
  return (page - 1) * linesPerPage + line;
}

/** Inclusive length of a range in transcript lines. */
export function rangeLines(r: PageLineRange, linesPerPage = LINES_PER_PAGE) {
  const n = normalizeRange(r);
  return Math.max(0, absoluteLine(n.endPage, n.endLine, linesPerPage) - absoluteLine(n.startPage, n.startLine, linesPerPage) + 1);
}

export function rangesOverlap(a: PageLineRange, b: PageLineRange) {
  const x = normalizeRange(a), y = normalizeRange(b);
  return comparePageLine(x.startPage, x.startLine, y.endPage, y.endLine) <= 0 && comparePageLine(y.startPage, y.startLine, x.endPage, x.endLine) <= 0;
}

/** Lines shared by two ranges (0 when disjoint). */
export function overlapLines(a: PageLineRange, b: PageLineRange, linesPerPage = LINES_PER_PAGE) {
  if (!rangesOverlap(a, b)) return 0;
  const x = normalizeRange(a), y = normalizeRange(b);
  const start = Math.max(absoluteLine(x.startPage, x.startLine, linesPerPage), absoluteLine(y.startPage, y.startLine, linesPerPage));
  const end = Math.min(absoluteLine(x.endPage, x.endLine, linesPerPage), absoluteLine(y.endPage, y.endLine, linesPerPage));
  return Math.max(0, end - start + 1);
}

/** Merge overlapping or touching ranges into the minimal disjoint set, sorted. */
export function mergeRanges<T extends PageLineRange>(ranges: T[], linesPerPage = LINES_PER_PAGE): PageLineRange[] {
  const sorted = ranges.map(normalizeRange).sort((a, b) => comparePageLine(a.startPage, a.startLine, b.startPage, b.startLine));
  const out: PageLineRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && absoluteLine(r.startPage, r.startLine, linesPerPage) <= absoluteLine(last.endPage, last.endLine, linesPerPage) + 1) {
      if (comparePageLine(r.endPage, r.endLine, last.endPage, last.endLine) > 0) { last.endPage = r.endPage; last.endLine = r.endLine; }
    } else out.push({ ...r });
  }
  return out;
}

export interface DesignationTotals {
  count: number;
  /** Distinct lines covered (overlaps counted once) per purpose and overall. */
  lines: Record<Designation["purpose"] | "all", number>;
  byPurpose: Record<Designation["purpose"], number>;
  /** Counter-designations that cite a designation not in the list. */
  danglingCounters: number;
  /** Counters whose range does not touch the designation they answer. */
  detachedCounters: number;
  objections: { total: number; sustained: number; overruled: number; pending: number };
  /** Estimated playback: a 25-line page of video runs about 90 seconds. */
  estimatedMinutes: number;
}

/** Totals for a designation list: distinct lines by purpose, counter integrity and objection rulings. */
export function designationTotals(list: Designation[], linesPerPage = LINES_PER_PAGE): DesignationTotals {
  const purposes: Designation["purpose"][] = ["affirmative", "counter", "impeachment", "objection"];
  const byPurpose = Object.fromEntries(purposes.map((p) => [p, 0])) as Record<Designation["purpose"], number>;
  const lines = { all: 0, affirmative: 0, counter: 0, impeachment: 0, objection: 0 } as DesignationTotals["lines"];
  for (const p of purposes) {
    const rs = list.filter((d) => d.purpose === p);
    byPurpose[p] = rs.length;
    lines[p] = mergeRanges(rs, linesPerPage).reduce((a, r) => a + rangeLines(r, linesPerPage), 0);
  }
  lines.all = mergeRanges(list, linesPerPage).reduce((a, r) => a + rangeLines(r, linesPerPage), 0);
  const ids = new Set(list.map((d) => d.id));
  let danglingCounters = 0, detachedCounters = 0;
  for (const d of list) {
    if (d.purpose !== "counter" || !d.counterTo) continue;
    const target = list.find((x) => x.id === d.counterTo);
    if (!target || !ids.has(d.counterTo)) { danglingCounters++; continue; }
    // A counter must sit within ±2 pages of the designation it completes.
    const near = Math.abs(absoluteLine(d.startPage, d.startLine, linesPerPage) - absoluteLine(target.endPage, target.endLine, linesPerPage)) <= linesPerPage * 2 || rangesOverlap(d, target) || Math.abs(absoluteLine(target.startPage, target.startLine, linesPerPage) - absoluteLine(d.endPage, d.endLine, linesPerPage)) <= linesPerPage * 2;
    if (!near) detachedCounters++;
  }
  const objections = { total: 0, sustained: 0, overruled: 0, pending: 0 };
  for (const d of list) {
    if (!d.objection) continue;
    objections.total++;
    if (d.objection.ruling === "sustained") objections.sustained++;
    else if (d.objection.ruling === "overruled") objections.overruled++;
    else objections.pending++;
  }
  return { count: list.length, lines, byPurpose, danglingCounters, detachedCounters, objections, estimatedMinutes: Math.round((lines.all / linesPerPage) * 1.5 * 10) / 10 };
}

/** Designations that would play at trial: affirmative + counter, minus ranges struck by a sustained objection. */
export function playableRanges(list: Designation[], linesPerPage = LINES_PER_PAGE): PageLineRange[] {
  const struck = list.filter((d) => d.objection?.ruling === "sustained");
  const keep = list.filter((d) => (d.purpose === "affirmative" || d.purpose === "counter") && d.objection?.ruling !== "sustained");
  const out: PageLineRange[] = [];
  for (const r of mergeRanges(keep, linesPerPage)) {
    // subtract struck ranges
    let pieces: PageLineRange[] = [r];
    for (const s of struck) {
      pieces = pieces.flatMap((p) => {
        if (!rangesOverlap(p, s)) return [p];
        const n = normalizeRange(s);
        const res: PageLineRange[] = [];
        if (comparePageLine(p.startPage, p.startLine, n.startPage, n.startLine) < 0) {
          const end = stepBack(n.startPage, n.startLine, linesPerPage);
          res.push({ startPage: p.startPage, startLine: p.startLine, endPage: end.page, endLine: end.line });
        }
        if (comparePageLine(p.endPage, p.endLine, n.endPage, n.endLine) > 0) {
          const start = stepForward(n.endPage, n.endLine, linesPerPage);
          res.push({ startPage: start.page, startLine: start.line, endPage: p.endPage, endLine: p.endLine });
        }
        return res;
      });
    }
    out.push(...pieces);
  }
  return out;
}

function stepBack(page: number, line: number, linesPerPage: number) {
  return line > 1 ? { page, line: line - 1 } : { page: page - 1, line: linesPerPage };
}
function stepForward(page: number, line: number, linesPerPage: number) {
  return line < linesPerPage ? { page, line: line + 1 } : { page: page + 1, line: 1 };
}

/** Parse "24:05-26:12", "24:5 – 26:12" or "24:05" into a range. */
export function parseRange(s: string): PageLineRange | null {
  const m = s.trim().match(/^(\d{1,4})\s*:\s*(\d{1,2})(?:\s*[-–—to]+\s*(\d{1,4})\s*:\s*(\d{1,2}))?$/i);
  if (!m) return null;
  const startPage = Number(m[1]), startLine = Number(m[2]);
  const endPage = m[3] ? Number(m[3]) : startPage, endLine = m[4] ? Number(m[4]) : startLine;
  if (startLine < 1 || startLine > LINES_PER_PAGE || endLine < 1 || endLine > LINES_PER_PAGE) return null;
  return normalizeRange({ startPage, startLine, endPage, endLine });
}
