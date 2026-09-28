/**
 * Transcript import parser (client + server safe, no I/O).
 *
 * Accepts the three shapes court reporters deliver:
 *  - "page-line": every line carries `PPPP:LL` (ASCII/.ptx style, `0024:05  Q.  …`);
 *  - "page-numbered": a page marker (`Page 24`, a bare `24`, a form feed) followed
 *    by lines numbered 1–25 in the left margin;
 *  - "loose": Q./A. blocks with no numbering (page:line is then estimated at 25
 *    lines a page and ~58 characters a line, and confidence is capped).
 *
 * The parser recognises Q./A. labels, `BY MR. X:` examination markers,
 * `MR. X: Objection, form.` colloquy (attached to the pending question with a
 * basis from OBJECTION_BASES), `THE WITNESS:` continuations, parentheticals
 * (exhibits marked, recesses) and exhibit references inside questions. It never
 * throws on malformed input: every anomaly becomes a ParseIssue and lowers the
 * confidence so the reviewer can decide before the deposition is created.
 */
import type { DepositionQA } from "@/lib/types/domain";
import { OBJECTION_BASES, type ParseIssue, type ParsedTranscript, type TranscriptFormat } from "./types";
import { isIndianDeposition, parseIndianDeposition } from "./india-deposition";

export interface ParseOptions {
  /** Page number for the first estimated page in loose format (default 1). */
  firstPage?: number;
  linesPerPage?: number;
  /** Map reporter speaker labels ("MR. WHITFIELD") to full names ("Jordan Whitfield"). */
  speakers?: Record<string, string>;
  /** Cap on recorded issues (counts are still exact). */
  maxIssues?: number;
}

const PAGE_LINE_RE = /^\s*(\d{1,5})\s*:\s*(\d{1,2})(?:\s+|$)(.*)$/;
const NUMBERED_RE = /^\s*(\d{1,2})(?:\s+|$)(.*)$/;
const PAGE_MARKER_RE = /^\s*(?:-+\s*)?(?:Page|PAGE|Pg\.?)\s*(\d{1,5})(?:\s*-+)?\s*$/;
const BARE_NUMBER_RE = /^\s*(\d{1,5})\s*$/;
const Q_RE = /^(?:Q|QUESTION)\s*[.:]\s*(.*)$/i;
const A_RE = /^(?:A|ANSWER)\s*[.:]\s*(.*)$/i;
const BY_RE = /^(?:EXAMINATION\s+)?BY\s+((?:MR|MS|MRS|DR)\.?\s+[A-Z][A-Z'\-]+(?:\s+[A-Z][A-Z'\-]+)?)\s*:?\s*(.*)$/i;
const SPEAKER_RE = /^((?:MR|MS|MRS|DR)\.?\s+[A-Z][A-Z'\-]+(?:\s+[A-Z][A-Z'\-]+)?)\s*:\s*(.*)$/;
const WITNESS_RE = /^THE\s+(?:WITNESS|DEPONENT)\s*:\s*(.*)$/i;
const OTHER_SPEAKER_RE = /^(THE\s+(?:VIDEOGRAPHER|REPORTER|COURT\s+REPORTER|COURT|INTERPRETER))\s*:\s*(.*)$/i;
const UNKNOWN_SPEAKER_RE = /^([A-Z][A-Z .'-]{2,30}):\s+(.*)$/;
const PAREN_RE = /^\((.*)\)\s*$/;
const EXHIBIT_MARKED_RE = /(?:Exhibit|Ex\.)\s+(?:No\.?\s*)?([A-Za-z]+-\d+|\d+[A-Za-z]?)\b[^)]*?(?:marked|identified|introduced)/i;
const EXHIBIT_REF_RE = /(?:(?:Exhibit|Ex\.)\s+(?:No\.?\s*)?|\bmarked\s+as\s+)([A-Za-z]+-\d+|\d+[A-Za-z]?)\b/i;
const BATES_RE = /\b([A-Z]{2,6}-\d{5,})\b/;
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

const BASIS_HINTS: [RegExp, (typeof OBJECTION_BASES)[number]][] = [
  [/asked\s+and\s+answered/i, "asked-and-answered"],
  [/mischaracteriz|misstates/i, "mischaracterizes"],
  [/foundation/i, "foundation"],
  [/speculat/i, "speculation"],
  [/privilege|instruct(?:ed)?\s+(?:the\s+witness\s+)?not\s+to\s+answer|work\s+product/i, "privilege"],
  [/compound/i, "compound"],
  [/relevan/i, "relevance"],
  [/argumentative/i, "argumentative"],
  [/hearsay/i, "hearsay"],
  [/\bform\b|leading|vague|ambiguous/i, "form"],
];

/** Guess the objection basis from the reporter's words; "form" when nothing more specific is said. */
export function basisFromObjection(text: string): (typeof OBJECTION_BASES)[number] {
  for (const [re, basis] of BASIS_HINTS) if (re.test(text)) return basis;
  return "form";
}

/** "MR. WHITFIELD" → "Mr. Whitfield" (or the mapped full name). */
export function speakerName(label: string, map: Record<string, string> = {}): string {
  const key = label.replace(/\s+/g, " ").replace(/\.$/, "").trim().toUpperCase();
  const mapped = map[key] ?? map[key.replace(/\.\s/, " ")] ?? Object.entries(map).find(([k]) => k.toUpperCase() === key)?.[1];
  if (mapped) return mapped;
  return key.toLowerCase().replace(/(^|\s)([a-z])/g, (_, s: string, c: string) => `${s}${c.toUpperCase()}`).replace(/^(Mr|Ms|Mrs|Dr)(\s)/, "$1.$2");
}

function toIsoDate(s: string): string | undefined {
  const m = s.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})\b/i);
  if (m) { const mo = MONTHS.indexOf(m[1].toLowerCase()) + 1; return `${m[3]}-${String(mo).padStart(2, "0")}-${String(Number(m[2])).padStart(2, "0")}`; }
  const n = s.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (n) return `${n[3]}-${n[1].padStart(2, "0")}-${n[2].padStart(2, "0")}`;
  const iso = s.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  return iso?.[1];
}

function romanOrInt(s: string): number | undefined {
  const r: Record<string, number> = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6 };
  if (/^\d+$/.test(s)) return Number(s);
  return r[s.toUpperCase()];
}

interface Token { page?: number; line?: number; text: string; raw: string; idx: number; numbered: boolean; pageMarker?: number }

/** Detect the numbering style from a sample of the text. */
export function detectTranscriptFormat(text: string): TranscriptFormat {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let nonEmpty = 0, pageLine = 0, numbered = 0, markers = 0;
  for (const raw of lines) {
    const l = raw.replace(/\t/g, "    ");
    if (!l.trim()) continue;
    nonEmpty++;
    if (PAGE_LINE_RE.test(l)) { pageLine++; continue; }
    if (PAGE_MARKER_RE.test(l) || /\f/.test(raw)) { markers++; continue; }
    const m = l.match(NUMBERED_RE);
    if (m && Number(m[1]) >= 1 && Number(m[1]) <= 25) numbered++;
  }
  if (!nonEmpty) return "loose";
  if (pageLine / nonEmpty >= 0.3) return "page-line";
  if (numbered / nonEmpty >= 0.3 && (markers > 0 || numbered > 25)) return "page-numbered";
  return "loose";
}

function tokenize(text: string, format: TranscriptFormat, issues: ParseIssue[], push: (i: ParseIssue) => void): { tokens: Token[]; rawLines: number; numberedLines: number; markers: number } {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const tokens: Token[] = [];
  let rawLines = 0, numberedLines = 0, markers = 0;
  let page: number | undefined;
  let lastLine = 0;
  let sawFormFeed = false;
  lines.forEach((rawIn, idx) => {
    let raw = rawIn.replace(/\t/g, "    ");
    if (raw.includes("\f")) { sawFormFeed = true; raw = raw.replace(/\f/g, ""); }
    if (!raw.trim()) return;
    rawLines++;
    if (format === "page-line") {
      const m = raw.match(PAGE_LINE_RE);
      if (m) {
        numberedLines++;
        const p = Number(m[1]), l = Number(m[2]);
        tokens.push({ page: p, line: l, text: m[3].trim(), raw, idx, numbered: true });
        return;
      }
      // A bare page marker between blocks is fine; anything else is an unnumbered line.
      if (PAGE_MARKER_RE.test(raw) || BARE_NUMBER_RE.test(raw)) { markers++; return; }
      push({ at: `raw ${idx + 1}`, kind: "unnumbered", message: "Line without page:line numbering; joined to the previous entry", sample: raw.trim().slice(0, 90) });
      tokens.push({ text: raw.trim(), raw, idx, numbered: false });
      return;
    }
    if (format === "page-numbered") {
      const pm = raw.match(PAGE_MARKER_RE);
      const bare = raw.match(BARE_NUMBER_RE);
      const n = pm ? Number(pm[1]) : bare ? Number(bare[1]) : undefined;
      const isMarker = n != null && (!!pm || sawFormFeed || n > 25 || page == null || (n === page + 1 && lastLine >= 18) || (n > page && bare != null && lastLine >= 18));
      if (isMarker && n != null) { markers++; page = n; lastLine = 0; sawFormFeed = false; tokens.push({ text: "", raw, idx, numbered: false, pageMarker: n }); return; }
      const m = raw.match(NUMBERED_RE);
      if (m && Number(m[1]) >= 1 && Number(m[1]) <= 60) {
        numberedLines++;
        const l = Number(m[1]);
        lastLine = l;
        tokens.push({ page, line: l, text: m[2].trim(), raw, idx, numbered: true });
        return;
      }
      push({ at: page != null ? `${page}:${lastLine || 1}` : `raw ${idx + 1}`, kind: "unnumbered", message: "Line without a margin number; joined to the previous entry", sample: raw.trim().slice(0, 90) });
      tokens.push({ page, text: raw.trim(), raw, idx, numbered: false });
      return;
    }
    tokens.push({ text: raw.trim(), raw, idx, numbered: false });
  });
  void issues;
  return { tokens, rawLines, numberedLines, markers };
}

interface Block { kind: "question" | "answer" | "objection" | "colloquy"; page?: number; line?: number; text: string; by?: string }

/**
 * Parse a transcript into DepositionQA pairs plus a parse report. Pure; the
 * server wraps it for txt/ptx/docx uploads and the client uses it for previews.
 */
export function parseTranscript(text: string, opts: ParseOptions = {}): ParsedTranscript {
  // Indian deposition sheets (chief by affidavit + cross/re-examination segments) have their own parser.
  if (isIndianDeposition(text)) return parseIndianDeposition(text, { maxIssues: opts.maxIssues });
  const linesPerPage = opts.linesPerPage ?? 25;
  const maxIssues = opts.maxIssues ?? 60;
  const issues: ParseIssue[] = [];
  const counts = new Map<ParseIssue["kind"], number>();
  const push = (i: ParseIssue) => { counts.set(i.kind, (counts.get(i.kind) ?? 0) + 1); if (issues.length < maxIssues) issues.push(i); };
  const format = detectTranscriptFormat(text);
  const { tokens, rawLines, numberedLines, markers } = tokenize(text, format, issues, push);
  if (format === "loose") push({ at: "document", kind: "no-page-markers", message: "No page:line numbering found; page and line numbers are estimated at 25 lines a page" });
  if (format === "page-numbered" && markers === 0) push({ at: "document", kind: "no-page-markers", message: "Margin line numbers found but no page markers; pages are estimated" });

  const speakers = new Map<string, { count: number; questions: number; objections: number; role: ParsedTranscript["speakers"][number]["role"] }>();
  const bump = (label: string, role: ParsedTranscript["speakers"][number]["role"], f: "questions" | "objections" | null = null) => {
    const s = speakers.get(label) ?? { count: 0, questions: 0, objections: 0, role };
    s.count++;
    if (f) s[f]++;
    speakers.set(label, s);
  };
  const exhibits = new Map<string, { id: string; description: string; bates?: string }>();
  const meta: ParsedTranscript["meta"] = {};
  const stats = { questions: 0, answers: 0, objections: 0, colloquy: 0, rawLines, numberedLines };

  // Header metadata from the first ~120 raw lines.
  const head = tokens.slice(0, 120).map((t) => t.text).join("\n");
  // The witness name stays on the caption line: spaces and tabs only, never a newline, or the next header line would join it.
  const w = head.match(/DEPOSITION\s+OF\s*:?[ \t]*([A-Z][A-Za-z.'\-]+(?:[ \t]+[A-Z][A-Za-z.'\-]+){0,3})/);
  if (w && !/^(?:THE|A|AN)$/i.test(w[1])) meta.witnessName = w[1].replace(/\s+(?:TAKEN|VOLUME|ON)$/i, "").replace(/,$/, "").trim().toLowerCase().replace(/(^|[\s'-])([a-z])/g, (_, s: string, c: string) => s + c.toUpperCase());
  // A "WITNESS: Name" header field on its own line; never the "THE WITNESS:" speaker label.
  const wn = head.match(/^[ \t]*WITNESS\s*:[ \t]*([A-Z][A-Za-z.'\-]+(?:[ \t]+[A-Z][A-Za-z.'\-]+){0,3})[ \t]*$/m);
  if (!meta.witnessName && wn) meta.witnessName = wn[1].trim();
  meta.date = toIsoDate(head);
  const vol = head.match(/VOLUME\s+(I{1,3}|IV|V|VI|\d+)\b/i);
  if (vol) meta.volume = romanOrInt(vol[1]);
  const cap = head.match(/^(IN\s+RE:?\s+.+|.+\s+v\.\s+.+)$/im);
  if (cap) meta.caseCaption = cap[1].trim().slice(0, 120);

  // Walk tokens into blocks.
  const blocks: Block[] = [];
  const st: { cur: Block | null } = { cur: null };
  let examiner: string | undefined;
  let lastPage = 0, lastLine = 0;
  const ensureOrder = (t: Token) => {
    if (t.page == null || t.line == null) return;
    if (t.line > linesPerPage) push({ at: `${t.page}:${t.line}`, kind: "line-overflow", message: `Line ${t.line} exceeds ${linesPerPage} lines a page`, sample: t.text.slice(0, 90) });
    if (t.page < lastPage || (t.page === lastPage && t.line < lastLine)) push({ at: `${t.page}:${t.line}`, kind: "out-of-order", message: `Page:line goes backwards after ${lastPage}:${lastLine}`, sample: t.text.slice(0, 90) });
    lastPage = t.page; lastLine = t.line;
  };
  const start = (b: Block) => { if (st.cur) blocks.push(st.cur); st.cur = b; };
  const append = (t: string) => { if (!st.cur) return false; st.cur.text = st.cur.text ? `${st.cur.text} ${t}` : t; return true; };
  const markExhibit = (inner: string) => {
    const ex = inner.match(EXHIBIT_MARKED_RE);
    if (ex) { const id = ex[1]; if (!exhibits.has(id)) exhibits.set(id, { id, description: inner.replace(/\s+/g, " ").slice(0, 160), bates: inner.match(BATES_RE)?.[1] }); }
  };
  // A parenthetical that wraps ("(Exhibit 3 marked for identification;" / "memo, MFC-0041936.)") stays one colloquy block.
  let parenOpen = false;

  for (const t of tokens) {
    if (t.pageMarker != null) continue;
    ensureOrder(t);
    const text = t.text;
    if (!text) continue;
    let m: RegExpMatchArray | null;
    if (parenOpen) {
      append(text);
      if (text.includes(")")) { parenOpen = false; if (st.cur) markExhibit(st.cur.text.replace(/^\(|\)\s*$/g, "")); }
      continue;
    }
    if (text.startsWith("(") && !text.includes(")")) { start({ kind: "colloquy", page: t.page, line: t.line, text }); stats.colloquy++; parenOpen = true; continue; }
    if ((m = text.match(BY_RE))) { examiner = speakerName(m[1], opts.speakers); bump(examiner, "examiner"); if (!meta.takenBy) meta.takenBy = examiner; if (m[2]) { start({ kind: "question", page: t.page, line: t.line, text: m[2].replace(/^Q\s*[.:]\s*/i, "") }); } continue; }
    if ((m = text.match(Q_RE))) { start({ kind: "question", page: t.page, line: t.line, text: m[1] }); stats.questions++; if (examiner) bump(examiner, "examiner", "questions"); continue; }
    if ((m = text.match(A_RE))) { start({ kind: "answer", page: t.page, line: t.line, text: m[1] }); stats.answers++; continue; }
    if ((m = text.match(WITNESS_RE))) { if (st.cur?.kind === "answer") append(m[1]); else { start({ kind: "answer", page: t.page, line: t.line, text: m[1] }); stats.answers++; } bump("The Witness", "witness"); continue; }
    if ((m = text.match(OTHER_SPEAKER_RE))) { start({ kind: "colloquy", page: t.page, line: t.line, text: m[2], by: speakerName(m[1], opts.speakers) }); stats.colloquy++; bump(speakerName(m[1]), "reporter"); continue; }
    if ((m = text.match(SPEAKER_RE))) {
      const by = speakerName(m[1], opts.speakers);
      const body = m[2];
      if (/objection|object\b|instruct/i.test(body)) { start({ kind: "objection", page: t.page, line: t.line, text: body, by }); stats.objections++; bump(by, by === examiner ? "examiner" : "defender", "objections"); }
      else { start({ kind: "colloquy", page: t.page, line: t.line, text: body, by }); stats.colloquy++; bump(by, by === examiner ? "examiner" : "other"); }
      continue;
    }
    if ((m = text.match(PAREN_RE))) {
      const inner = m[1];
      markExhibit(inner);
      start({ kind: "colloquy", page: t.page, line: t.line, text: inner });
      stats.colloquy++;
      continue;
    }
    if ((m = text.match(UNKNOWN_SPEAKER_RE)) && !/^(?:Q|A|NO|YES)$/i.test(m[1])) {
      push({ at: t.page != null && t.line != null ? `${t.page}:${t.line}` : `raw ${t.idx + 1}`, kind: "unknown-speaker", message: `Unrecognised speaker label "${m[1].trim()}"; treated as colloquy`, sample: text.slice(0, 90) });
      start({ kind: "colloquy", page: t.page, line: t.line, text: m[2], by: speakerName(m[1], opts.speakers) });
      stats.colloquy++;
      continue;
    }
    if (!append(text)) { push({ at: t.page != null && t.line != null ? `${t.page}:${t.line}` : `raw ${t.idx + 1}`, kind: "empty", message: "Text before the first Q./A. label was skipped", sample: text.slice(0, 90) }); }
  }
  if (st.cur) blocks.push(st.cur);

  // Assemble Q/A pairs.
  const transcript: DepositionQA[] = [];
  let pending: DepositionQA | null = null;
  let estPage = opts.firstPage ?? 1, estLine = 1;
  const estimate = (len: number) => { const pos = { page: estPage, line: estLine }; let n = Math.max(1, Math.ceil(len / 58)); while (n-- > 0) { estLine++; if (estLine > linesPerPage) { estLine = 1; estPage++; } } return pos; };
  const at = (b: Block, len: number) => (b.page != null && b.line != null ? { page: b.page, line: b.line } : estimate(len));
  const flush = () => { if (pending) { transcript.push(pending); pending = null; } };
  /** Reporter lines carry double spaces after periods and wrapped-line joins; the record keeps single spaces. */
  const norm = (t: string) => t.replace(/\s+/g, " ").trim();
  for (const b of blocks) {
    if (b.kind === "question") {
      flush();
      const pos = at(b, b.text.length);
      const q: DepositionQA = { page: pos.page, line: pos.line, question: norm(b.text), answer: "" };
      const ex = b.text.match(EXHIBIT_REF_RE);
      if (ex) { q.exhibit = ex[1]; if (!exhibits.has(ex[1])) exhibits.set(ex[1], { id: ex[1], description: b.text.slice(0, 160), bates: b.text.match(BATES_RE)?.[1] }); }
      pending = q;
      continue;
    }
    if (b.kind === "objection") {
      if (b.page == null) estimate(b.text.length);
      if (!pending) { push({ at: b.page != null ? `${b.page}:${b.line}` : "estimated", kind: "orphan-objection", message: "Objection without a pending question", sample: b.text.slice(0, 90) }); continue; }
      // The basis is read from the whole objection, including continuation lines joined after the block started.
      const basis = basisFromObjection(b.text);
      const text = norm(b.text.replace(/^objection[.,:]?\s*/i, ""));
      pending.objection = text ? { by: b.by ?? "Counsel", basis, text } : { by: b.by ?? "Counsel", basis };
      continue;
    }
    if (b.kind === "answer") {
      if (b.page == null) estimate(b.text.length);
      if (!pending) {
        const prev = transcript[transcript.length - 1];
        if (prev) { prev.answer = norm(`${prev.answer} ${b.text}`); continue; }
        push({ at: b.page != null ? `${b.page}:${b.line}` : "estimated", kind: "answer-without-question", message: "Answer recorded before any question", sample: b.text.slice(0, 90) });
        const pos = at(b, b.text.length);
        transcript.push({ page: pos.page, line: pos.line, question: "(no question recorded)", answer: norm(b.text) });
        continue;
      }
      if (pending.answer) { flush(); const prev = transcript[transcript.length - 1]; prev.answer = norm(`${prev.answer} ${b.text}`); continue; }
      pending.answer = norm(b.text);
      continue;
    }
    // colloquy: never becomes testimony; exhibits were captured already
    if (b.page == null) estimate(b.text.length);
  }
  flush();
  for (const qa of transcript) if (!qa.answer) { qa.answer = "(no answer recorded)"; push({ at: `${qa.page}:${qa.line}`, kind: "empty", message: "Question without an answer", sample: qa.question.slice(0, 90) }); }

  // Speakers → roles; defender = the most frequent objector who is not the examiner.
  const speakerRows: ParsedTranscript["speakers"] = Array.from(speakers.entries()).map(([label, s]) => ({ label, count: s.count, role: s.role })).sort((a, b) => b.count - a.count);
  // The defender is the most frequent objector who is not the examining attorney of record (the first examiner, not the last).
  const defender = Array.from(speakers.entries()).filter(([label, s]) => label !== meta.takenBy && s.objections > 0).sort((a, b) => b[1].objections - a[1].objections)[0]?.[0];
  if (defender) { meta.defendingBy = defender; const row = speakerRows.find((r) => r.label === defender); if (row) row.role = "defender"; }

  // Page count comes from every numbered line (a transcript usually ends with colloquy), not only from the testimony.
  let maxPage = 0;
  for (const t of tokens) { if (t.page != null && t.page > maxPage) maxPage = t.page; if (t.pageMarker != null && t.pageMarker > maxPage) maxPage = t.pageMarker; }
  const pages = transcript.length ? Math.max(maxPage, ...transcript.map((q) => q.page)) : 0;
  const firstPage = transcript.length ? Math.min(...transcript.map((q) => q.page)) : 0;
  const issueCount = Array.from(counts.values()).reduce((a, b) => a + b, 0);
  let confidence = format === "page-line" ? 1 : format === "page-numbered" ? Math.min(1, numberedLines / Math.max(1, rawLines)) : 0.45;
  confidence -= Math.min(0.5, issueCount * 0.015);
  if (!transcript.length) confidence = 0;
  else if (stats.answers === 0) confidence = Math.min(confidence, 0.2);
  confidence = Math.round(Math.max(0, Math.min(1, confidence)) * 100) / 100;
  return { format, transcript, pages, firstPage, confidence, issues, speakers: speakerRows, exhibits: Array.from(exhibits.values()), meta, stats };
}

/** Issue counts by kind for the preview strip. */
export function summarizeIssues(issues: ParseIssue[]): { kind: ParseIssue["kind"]; count: number }[] {
  const m = new Map<ParseIssue["kind"], number>();
  for (const i of issues) m.set(i.kind, (m.get(i.kind) ?? 0) + 1);
  return Array.from(m.entries()).map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count);
}

export const ISSUE_LABEL: Record<ParseIssue["kind"], string> = {
  unnumbered: "Unnumbered lines",
  "out-of-order": "Page:line out of order",
  "line-overflow": "Line over 25",
  "answer-without-question": "Answer without question",
  "unknown-speaker": "Unknown speaker",
  "no-page-markers": "No page markers",
  "orphan-objection": "Objection without question",
  empty: "Empty or skipped",
};

/** Render Q/A pairs back to page:line text (round-trips a parsed transcript; used by exports and tests). */
export function transcriptToPageLine(transcript: DepositionQA[]): string {
  const out: string[] = [];
  const pl = (p: number, l: number) => `${String(p).padStart(4, "0")}:${String(l).padStart(2, "0")}`;
  for (const qa of transcript) {
    let line = qa.line, page = qa.page;
    const next = () => { line++; if (line > 25) { line = 1; page++; } return pl(page, line); };
    out.push(`${pl(page, line)}  Q.  ${qa.question}`);
    if (qa.objection) out.push(`${next()}       ${qa.objection.by.toUpperCase()}:  Objection, ${qa.objection.basis}.${qa.objection.text ? ` ${qa.objection.text}` : ""}`);
    out.push(`${next()}  A.  ${qa.answer}`);
  }
  return out.join("\n") + "\n";
}
