import { extractCitations, normalizeCitation, type ParsedCitation } from "@/lib/india/citations";
import { extractStatutes, statuteKeys, type StatuteRef } from "@/lib/india/statutes";
import { contextAround, detectTreatment, SIGNAL_PRIORITY, sentenceStarts, type Span, type TreatmentSignal } from "./signals";

/**
 * Citation extraction for the citator (pure, deterministic): judgment text chunks → one draft per distinct cited
 * authority (case citations by normalised form, statute references per section). Bumping EXTRACTOR_VERSION marks rows
 * written by an older extractor for rebuilding.
 */
export const EXTRACTOR_VERSION = 1;

/** Upper bound on distinct citations stored per judgment (a judgment with more is truncated and says so). */
export const MAX_CITATIONS_PER_JUDGMENT = 1500;

export interface TextChunkIn { index: number; pageStart: number | null; text: string }

export interface CitationDraft {
  kind: "case" | "statute";
  /** First occurrence as printed. */
  raw: string;
  /** Case: normalised citation ("(2017) 10 SCC 1", "2024 INSC 735"). Statute: "IPC 1860 s.302"; unresolved Act: "?:<raw>". */
  key: string;
  actId: string | null;
  section: string | null;
  chunkIndex: number;
  page: number | null;
  /** Case citations only: the sentence around the citation (≤ 400 characters). */
  context: string | null;
  signal: TreatmentSignal | null;
  /** Exact substring of `context` that gave the signal. */
  cue: string | null;
  occurrences: number;
  /** Case: whether the parser judged the citation well formed (an invalid one is never resolved). */
  valid: boolean;
}

/** Compact match key: upper-case letters and digits only (the SQL side computes the same expression). */
export const compactKey = (s: string) => s.replace(/[^A-Za-z0-9]/g, "").toUpperCase();

/** Canonical form of a stored citation value (corpus_judgments.neutral_citation / reporter_citation), or null. */
export function canonicalCitation(v: string | null | undefined): string | null {
  if (!v || !v.trim()) return null;
  return normalizeCitation(v);
}

const isCase = (c: ParsedCitation) => c.kind === "neutral" || c.kind === "reporter";
const clean = (text: string) => text.replace(/\[(SECTION|TITLE|SUBSECTION|HEADER)\]\s*#*\s*/g, "").replace(/^#{1,6}\s+/gm, "");

/**
 * Extract citation drafts from a judgment's chunks. `ownKeys` are the judgment's own normalised citations (neutral,
 * reporter): those occurrences are its own header, not citations, and are skipped. Case citations collapse by
 * normalised key (the occurrence with the strongest signal is kept, else the first); statutes by section key.
 */
export function extractCitationDrafts(chunks: TextChunkIn[], opts: { ownKeys?: string[]; now?: Date; max?: number } = {}): { drafts: CitationDraft[]; truncated: boolean; selfSkipped: number } {
  const own = new Set((opts.ownKeys ?? []).map(compactKey));
  const max = opts.max ?? MAX_CITATIONS_PER_JUDGMENT;
  const byKey = new Map<string, CitationDraft>();
  let truncated = false, selfSkipped = 0;
  const put = (d: CitationDraft) => {
    const k = `${d.kind}|${d.key}`;
    const prev = byKey.get(k);
    if (!prev) {
      if (byKey.size >= max) { truncated = true; return; }
      byKey.set(k, d);
      return;
    }
    prev.occurrences++;
    const rank = (s: TreatmentSignal | null) => (s ? SIGNAL_PRIORITY.indexOf(s) : SIGNAL_PRIORITY.length);
    if (rank(d.signal) < rank(prev.signal)) Object.assign(prev, { ...d, occurrences: prev.occurrences, raw: prev.raw });
  };
  for (const chunk of chunks) {
    const text = clean(chunk.text ?? "");
    if (!text.trim()) continue;
    const found = extractCitations(text, { statutes: true, now: opts.now });
    const caseSpans: Span[] = found.filter(isCase).map((c) => ({ start: c.start!, end: c.end! }));
    const otherSpans: Span[] = found.filter((c) => !isCase(c)).map((c) => ({ start: c.start!, end: c.end! }));
    const starts = sentenceStarts(text, [...caseSpans, ...otherSpans]);
    const statutes = new Map<number, StatuteRef>(extractStatutes(text).map((s) => [s.start, s]));
    for (const c of found) {
      if (isCase(c)) {
        const key = c.normalized ?? c.raw.replace(/\s+/g, " ").trim();
        if (own.has(compactKey(key))) { selfSkipped++; continue; }
        const { context, spans, target } = contextAround(text, starts, c.start!, c.end!, caseSpans);
        const ti = spans.findIndex((s) => s.start === target.start && s.end === target.end);
        const cue = ti >= 0 ? detectTreatment(context, spans, ti, statuteSpansIn(text, starts, c.start!, c.end!, otherSpans)) : null;
        put({ kind: "case", raw: c.raw.replace(/\s+/g, " ").trim(), key, actId: null, section: null, chunkIndex: chunk.index, page: chunk.pageStart, context, signal: cue?.signal ?? null, cue: cue?.cue ?? null, occurrences: 1, valid: c.valid });
      } else if (c.kind === "statute") {
        const ref = statutes.get(c.start!);
        const raw = c.raw.replace(/\s+/g, " ").trim();
        const keys = ref ? statuteKeys(ref) : [];
        if (!ref || !keys.length) {
          put({ kind: "statute", raw, key: `?:${raw.toLowerCase()}`.slice(0, 200), actId: null, section: null, chunkIndex: chunk.index, page: chunk.pageStart, context: null, signal: null, cue: null, occurrences: 1, valid: false });
          continue;
        }
        const parts = ref.kind === "order_rule" ? (ref.rules ?? []).map((r) => `O.${ref.order} R.${r}`) : ref.sections;
        keys.forEach((key, i) => put({ kind: "statute", raw, key, actId: ref.actId ?? null, section: parts[i] ?? null, chunkIndex: chunk.index, page: chunk.pageStart, context: null, signal: null, cue: null, occurrences: 1, valid: true }));
      }
    }
  }
  return { drafts: [...byKey.values()], truncated, selfSkipped };
}

/** Statute spans mapped into the context window of a case citation (so a cue never overlaps a statute reference). */
function statuteSpansIn(text: string, starts: number[], start: number, end: number, otherSpans: Span[]): Span[] {
  const { spans } = contextAround(text, starts, start, end, otherSpans);
  return spans;
}
