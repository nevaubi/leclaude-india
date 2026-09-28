/**
 * Parser for Indian deposition records (client + server safe, pure, no I/O).
 *
 * A civil trial witness's evidence in India is recorded as:
 *  - EXAMINATION-IN-CHIEF, usually an affidavit in lieu of chief-examination (Order XVIII Rule 4 CPC) in numbered
 *    paragraphs, with the marking of exhibits recorded after it ("Ex.P1 to Ex.P25 are marked");
 *  - CROSS-EXAMINATION by the opposite side's advocate, recorded by the court either as Q/A or in narrative form
 *    ("It is true that…", "It is false to suggest that…", "I do not know whether…");
 *  - RE-EXAMINATION, and questions put by the court (s.168 BSA / s.165 IEA).
 * Criminal depositions follow the same segments (chief is oral, recorded in narrative).
 *
 * Anchors stay exact: every row carries the page it is on and its line on that page (the margin number when the
 * record has one, otherwise its position on the page), and chief-examination rows also carry the affidavit
 * paragraph number. Nothing is estimated silently: a record with no page markers is parsed with pages taken as 1 and
 * the report says so, lowering confidence.
 */
import type { DepositionQA } from "@/lib/types/domain";
import type { ParseIssue, ParsedTranscript } from "./types";
import { canonicalExhibit, compareExhibitMarks, findExhibitMarks, formatExhibitMark, parseExhibitRange, parseWitnessDesignation, type ExamSegment } from "../india";

/** A deposition row with the Indian record fields (segment, affidavit paragraph, narrative form). */
export type IndiaQA = DepositionQA & {
  segment?: ExamSegment;
  /** Affidavit paragraph number (chief-examination by affidavit). */
  para?: number;
  /** Cross-examination recorded as a narrative statement rather than Q/A. */
  narrative?: boolean;
  /** Advocate conducting this segment ("Sri K. Raghavendra, Advocate for the defendant"). */
  by?: string;
};

const SEGMENT_RES: [RegExp, ExamSegment][] = [
  [/^\s*(?:CHIEF[-\s]*EXAMINATION|EXAMINATION[-\s]*IN[-\s]*CHIEF|EXAMINATION\s+IN\s+CHIEF|CHIEF\s+EXAMINATION)\b(.*)$/i, "chief"],
  [/^\s*(?:FURTHER\s+)?(?:CROSS[-\s]*EXAMINATION|CROSS[-\s]*EXAMINED)\b(.*)$/i, "cross"],
  [/^\s*(?:FURTHER\s+)?(?:RE[-\s]*EXAMINATION|RE[-\s]*EXAMINED)\b(.*)$/i, "re_examination"],
  [/^\s*(?:(?:QUESTIONS?|EXAMINATION)\s+BY\s+(?:THE\s+)?COURT|COURT\s+QUESTIONS?)\b(.*)$/i, "court"],
];
const PAGE_MARKER_RE = /^\s*(?:-+\s*)?(?:Page|PAGE|Pg\.?|P\.)\s*(?:No\.?\s*)?(\d{1,4})(?:\s*(?:of|\/)\s*\d{1,4})?(?:\s*-+)?\s*$/;
const MARGIN_RE = /^\s*(\d{1,2})\s{2,}(\S.*)$/;
const PARA_RE = /^\s*(\d{1,3})[.)]\s+(\S.*)$/;
const Q_RE = /^\s*(?:Q|QUESTION|Ques)\s*[.:)-]\s*(.*)$/i;
const A_RE = /^\s*(?:A|ANSWER|Ans)\s*[.:)-]\s*(.*)$/i;
/** Narrative cross-examination sentences as courts record them. */
const NARRATIVE_RE = /^\s*(?:It\s+is\s+(?:true|false|not\s+true|correct|incorrect)|I\s+(?:do\s+not|don't|cannot|can't|did\s+not|have\s+not|am\s+not|was\s+not|admit|deny|know|agree|say|have|had|was|am|did|signed|received|sent|cannot\s+say)|Witness\s+(?:volunteers|adds|says|denies|admits)|(?:The\s+)?(?:suggestion|witness)\b|Ex\.)/i;
const NIL_RE = /^\s*[:.-]?\s*(?:Nil|None|No\s+re-?examination)\.?\s*$/i;
const BY_ADVOCATE_RE = /\bBY\s+(.+?(?:ADVOCATE|COUNSEL|PROSECUTOR|PLEADER)[^.(:]*)/i;
const EXHIBIT_MARKED_RE = /\b((?:Ex(?:h|hibit)?\.?\s*[PDCABRX]\s*[-.]?\s*\d{1,4}(?:\([a-z]{1,2}\))?)(?:\s*(?:to|–|-)\s*(?:Ex(?:h|hibit)?\.?\s*)?[PDCABRX]?\s*[-.]?\s*\d{1,4})?)[^.]{0,80}?\b(?:is|are)\s+marked\b/i;

/** True when the text looks like an Indian deposition record (segment headings or PW/DW designations). */
export function isIndianDeposition(text: string): boolean {
  const head = text.slice(0, 20_000);
  const segments = SEGMENT_RES.filter(([re]) => head.split(/\r?\n/).some((l) => re.test(l))).length;
  const designation = /\b(?:P\.?W\.?|D\.?W\.?|C\.?W\.?|R\.?W\.?)\s*[-.]?\s*\d{1,3}\b/.test(head);
  const affidavit = /Order\s+XVIII\s+Rule\s+4|in\s+lieu\s+of\s+(?:examination-in-chief|chief)/i.test(head);
  return (segments >= 1 && (designation || affidavit)) || segments >= 2;
}

interface Line { page: number; line: number; text: string; raw: number; margin: boolean }

/** Split into lines with a page (from page markers / form feeds) and a line on that page (margin number or position). */
function lines(text: string, push: (i: ParseIssue) => void): { rows: Line[]; markers: number; margins: number; rawLines: number } {
  const out: Line[] = [];
  let page = 1, pos = 0, markers = 0, margins = 0, rawLines = 0;
  text.replace(/\r\n?/g, "\n").split("\n").forEach((rawIn, idx) => {
    let raw = rawIn.replace(/\t/g, "    ");
    if (raw.includes("\f")) {
      const before = raw.slice(0, raw.indexOf("\f"));
      if (before.trim()) { pos++; out.push({ page, line: pos, text: before.trim(), raw: idx, margin: false }); }
      page++; pos = 0; markers++;
      raw = raw.slice(raw.lastIndexOf("\f") + 1);
    }
    if (!raw.trim()) return;
    rawLines++;
    const pm = raw.match(PAGE_MARKER_RE);
    if (pm) {
      const n = Number(pm[1]);
      if (n < page && out.length) push({ at: `raw ${idx + 1}`, kind: "out-of-order", message: `Page ${n} follows page ${page}`, sample: raw.trim() });
      page = n; pos = 0; markers++;
      return;
    }
    const mm = raw.match(MARGIN_RE);
    if (mm && Number(mm[1]) >= 1 && Number(mm[1]) <= 40) {
      margins++;
      pos = Number(mm[1]);
      out.push({ page, line: pos, text: mm[2].trim(), raw: idx, margin: true });
      return;
    }
    pos++;
    out.push({ page, line: pos, text: raw.trim(), raw: idx, margin: false });
  });
  return { rows: out, markers, margins, rawLines };
}

const SMALL_WORDS = new Set(["for", "the", "of", "and", "on", "by", "in", "to"]);

function title(s: string): string {
  return s.toLowerCase().replace(/(^|[\s.'-])([a-z])([a-z]*)/g, (m, a: string, c: string, rest: string) => (a && a.trim() === "" && SMALL_WORDS.has(c + rest) ? m : a + c.toUpperCase() + rest)).trim();
}

function isoFromIndianDate(s: string): string | undefined {
  const m = s.match(/\b(\d{1,2})[./-](\d{1,2})[./-](\d{4})\b/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  const n = s.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:day\s+of\s+)?(January|February|March|April|May|June|July|August|September|October|November|December),?\s+(\d{4})\b/i);
  if (n) {
    const mo = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"].indexOf(n[2].toLowerCase()) + 1;
    return `${n[3]}-${String(mo).padStart(2, "0")}-${n[1].padStart(2, "0")}`;
  }
  return undefined;
}

/**
 * Parse an Indian deposition into rows. Chief paragraphs become rows with an empty question and the paragraph in
 * `answer`; narrative cross-examination sentences become rows with `narrative: true`; Q/A pairs stay Q/A. The
 * `ParsedTranscript` report has the same shape as the reporter-transcript parser so the import dialog works unchanged.
 */
export function parseIndianDeposition(text: string, opts: { maxIssues?: number } = {}): Omit<ParsedTranscript, "transcript"> & { transcript: IndiaQA[] } {
  const maxIssues = opts.maxIssues ?? 60;
  const issues: ParseIssue[] = [];
  let issueCount = 0;
  const push = (i: ParseIssue) => { issueCount++; if (issues.length < maxIssues) issues.push(i); };
  const { rows, markers, margins, rawLines } = lines(text, push);
  if (!markers) push({ at: "document", kind: "no-page-markers", message: "No page markers found; every row is anchored to page 1 by its position" });

  const meta: ParsedTranscript["meta"] = {};
  const head = rows.slice(0, 40).map((r) => r.text).join("\n");
  const des = head.match(/\b((?:P|D|C|R|A)\.?\s*W\.?\s*[-.]?\s*\d{1,3})\b/);
  const designation = des ? parseWitnessDesignation(des[1])?.canonical : undefined;
  const name = head.match(/^\s*(?:Name(?:\s+of\s+(?:the\s+)?witness)?|Witness)\s*[:-]\s*(.+?)\s*(?:,|$)/im);
  if (name) meta.witnessName = title(name[1].replace(/^(?:Sri|Smt|Shri|Kum|Dr)\.?\s+/i, (x) => x)).trim();
  meta.date = isoFromIndianDate(head.match(/^\s*(?:Date|Recorded\s+on|Deposed\s+on)[^:\n]*[:-]\s*(.+)$/im)?.[1] ?? "") ?? isoFromIndianDate(head);
  const cap = head.match(/^\s*((?:Com\.?\s*)?O\.S\.|Com\.?\s*O\.S\.|W\.P\.|Crl\.?\s*P\.|C\.C\.|S\.C\.|M\.A\.|R\.F\.A\.|O\.S\.)[^\n]*\bNo\.?[^\n]*$/im);
  if (cap) meta.caseCaption = cap[0].trim().slice(0, 120);

  const out: IndiaQA[] = [];
  const exhibits = new Map<string, { id: string; description: string }>();
  const stats = { questions: 0, answers: 0, objections: 0, colloquy: 0, rawLines, numberedLines: margins };
  let segment: ExamSegment | null = null;
  let by: string | undefined;
  let pending: IndiaQA | null = null;
  let cur: IndiaQA | null = null;
  const speakers = new Map<string, number>();

  const emit = (r: IndiaQA) => { out.push(r); cur = r; };
  const noteExhibits = (s: string, row?: IndiaQA) => {
    const marked = s.match(EXHIBIT_MARKED_RE);
    // "Ex.P1 to Ex.P25 are marked": every mark in the range is recorded as marked (same side only).
    const range = marked ? parseExhibitRange(marked[1]) : null;
    if (range && range.to > range.from && range.to - range.from <= 500) {
      for (let n = range.from; n <= range.to; n++) {
        const mark = formatExhibitMark(range.side, n);
        if (!exhibits.has(mark)) exhibits.set(mark, { id: mark, description: s.replace(/\s+/g, " ").slice(0, 160) });
      }
    }
    for (const mark of findExhibitMarks(s)) {
      if (!exhibits.has(mark)) exhibits.set(mark, { id: mark, description: marked ? s.replace(/\s+/g, " ").slice(0, 160) : `Referred to at ${row ? `${row.page}:${row.line}` : "the record"}` });
      if (row && !row.exhibit) row.exhibit = mark;
    }
  };

  for (const l of rows) {
    const t = l.text;
    // Segment headings.
    const seg = SEGMENT_RES.find(([re]) => re.test(t));
    if (seg) {
      if (pending) { pending.answer ||= "(no answer recorded)"; emit(pending); pending = null; }
      segment = seg[1];
      const rest = t.match(seg[0])?.[1] ?? "";
      const adv = t.match(BY_ADVOCATE_RE);
      by = adv ? title(adv[1].replace(/[:.\s]+$/, "")) : segment === "chief" ? undefined : by;
      if (by) speakers.set(by, (speakers.get(by) ?? 0) + 1);
      cur = null;
      if (NIL_RE.test(rest.replace(/^[^:]*:/, ":"))) segment = null;
      continue;
    }
    if (!segment) { noteExhibits(t); continue; }
    if (NIL_RE.test(t)) continue;
    // "Ex.P1 to Ex.P25 are marked." is a record of marking, not testimony.
    if (EXHIBIT_MARKED_RE.test(t) && !Q_RE.test(t) && !A_RE.test(t) && !PARA_RE.test(t)) { noteExhibits(t); stats.colloquy++; continue; }

    let m: RegExpMatchArray | null;
    if ((m = t.match(Q_RE))) {
      if (pending) { pending.answer ||= "(no answer recorded)"; emit(pending); }
      pending = { page: l.page, line: l.line, question: m[1].trim(), answer: "", segment, ...(by ? { by } : {}) };
      stats.questions++;
      noteExhibits(m[1], pending);
      continue;
    }
    if ((m = t.match(A_RE))) {
      if (!pending) {
        push({ at: `${l.page}:${l.line}`, kind: "answer-without-question", message: "Answer recorded before any question", sample: t.slice(0, 90) });
        emit({ page: l.page, line: l.line, question: "(no question recorded)", answer: m[1].trim(), segment, ...(by ? { by } : {}) });
      } else {
        pending.answer = m[1].trim();
        emit(pending);
        pending = null;
      }
      stats.answers++;
      if (cur) noteExhibits(m[1], cur);
      continue;
    }
    if (segment === "chief") {
      const pm = t.match(PARA_RE);
      if (pm) {
        emit({ page: l.page, line: l.line, question: "", answer: pm[2].trim(), segment, para: Number(pm[1]) });
        stats.answers++;
        noteExhibits(pm[2], cur!);
        continue;
      }
      if (cur && (cur as IndiaQA).segment === "chief") { (cur as IndiaQA).answer = `${(cur as IndiaQA).answer} ${t}`.trim(); noteExhibits(t, cur); continue; }
      // Oral chief (criminal cases) is recorded in narrative sentences.
      emit({ page: l.page, line: l.line, question: "", answer: t, segment, narrative: true });
      stats.answers++;
      noteExhibits(t, cur!);
      continue;
    }
    // Cross / re-examination / court: narrative sentences start a new row; other lines continue the current one.
    if (NARRATIVE_RE.test(t) || !cur || pending) {
      if (pending) { pending.answer = pending.answer ? `${pending.answer} ${t}` : t; continue; }
      emit({ page: l.page, line: l.line, question: "", answer: t, segment, narrative: true, ...(by ? { by } : {}) });
      stats.answers++;
      noteExhibits(t, cur!);
      continue;
    }
    (cur as IndiaQA).answer = `${(cur as IndiaQA).answer} ${t}`.trim();
    noteExhibits(t, cur!);
  }
  if (pending) { pending.answer ||= "(no answer recorded)"; out.push(pending); }
  // Exhibit ids on rows are canonical marks.
  for (const r of out) if (r.exhibit) r.exhibit = canonicalExhibit(r.exhibit) ?? r.exhibit;

  if (designation && meta.witnessName) meta.witnessName = `${meta.witnessName} (${designation})`;
  else if (designation) meta.witnessName = designation;
  const firstBy = out.find((r) => r.segment === "cross" && r.by)?.by;
  if (firstBy) meta.takenBy = firstBy;

  const pages = out.length ? Math.max(...rows.map((r) => r.page)) : 0;
  const firstPage = out.length ? Math.min(...out.map((r) => r.page)) : 0;
  let confidence = markers ? 0.95 : 0.6;
  if (!out.some((r) => r.segment === "cross")) { confidence -= 0.15; push({ at: "document", kind: "empty", message: "No cross-examination segment found" }); }
  confidence -= Math.min(0.4, issueCount * 0.02);
  if (!out.length) confidence = 0;
  confidence = Math.round(Math.max(0, Math.min(1, confidence)) * 100) / 100;
  return {
    format: "indian",
    transcript: out,
    pages,
    firstPage,
    confidence,
    issues,
    speakers: [...(meta.witnessName ? [{ label: meta.witnessName, count: out.length, role: "witness" as const }] : []), ...Array.from(speakers.entries()).map(([label, count]) => ({ label, count, role: "examiner" as const }))],
    exhibits: Array.from(exhibits.values()).sort((a, b) => compareExhibitMarks(a.id, b.id)),
    meta,
    stats,
  };
}
