/**
 * Cross references from testimony to documents (client + server safe).
 * A Q/A pair references a document when it quotes a Bates number, refers to a
 * marked exhibit that resolves to a document, or names a document by its
 * subject (a distinctive phrase such as "the March 14 memo" matched against
 * subjects and dates of the review set). Each hit carries a confidence so the
 * viewer can show Bates hits as certain and subject hits as suggestions.
 */
import type { Deposition, DepositionQA } from "@/lib/types/domain";
import type { CrossReference } from "./types";
import { canonicalExhibit, findExhibitMarks } from "../india";

/** `exhibit` is the document's canonical Indian exhibit mark ("Ex.P7") when it has been marked. */
export interface DocLike { id: string; bates: string; batesEnd?: string; subject: string; date: string; type?: string; exhibit?: string }

const BATES_RE = /\b([A-Z]{2,6}-\d{5,})\b/g;
const EXHIBIT_RE = /(?:Exhibit|Ex\.)\s+(?:No\.?\s*)?([A-Za-z]+-\d+|\d+[A-Za-z]?)\b/gi;
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const STOP = new Set(["the", "a", "an", "of", "to", "in", "on", "for", "and", "at", "by", "with", "re", "fw", "fwd", "from", "is", "that", "this", "your", "you", "did", "was", "were", "it", "as", "or", "about", "memo", "email", "letter", "report", "document", "exhibit"]);

function dateMentions(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+((?:19|20)\d{2})\b/gi)) out.push(`${m[3]}-${String(MONTHS.indexOf(m[1].toLowerCase()) + 1).padStart(2, "0")}-${m[2].padStart(2, "0")}`);
  for (const m of text.matchAll(/\b(\d{1,2})\/(\d{1,2})\/((?:19|20)\d{2})\b/g)) {
    // Indian records write dd/mm/yyyy; a first number above 12 can only be a day. Otherwise keep month/day.
    if (Number(m[1]) > 12) out.push(`${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`);
    else out.push(`${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`);
  }
  // dd.mm.yyyy and dd-mm-yyyy (the usual form in Indian orders and depositions).
  for (const m of text.matchAll(/\b(\d{1,2})[.-](\d{1,2})[.-]((?:19|20)\d{2})\b/g)) if (Number(m[2]) <= 12) out.push(`${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`);
  return out;
}

function words(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9µ\- ]+/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));
}

/**
 * Find documents referenced by each Q/A pair. `docs` is the matter's review
 * set; `exhibits` maps exhibit ids to Bates (from the deposition's exhibit list).
 */
export function findCrossReferences(dep: Pick<Deposition, "transcript" | "exhibits">, docs: DocLike[], opts: { subjectMinWords?: number; maxPerQa?: number } = {}): CrossReference[] {
  const byBates = new Map<string, DocLike>();
  for (const d of docs) { byBates.set(d.bates.toUpperCase(), d); if (d.batesEnd) byBates.set(d.batesEnd.toUpperCase(), d); }
  const exhibitBates = new Map<string, string>();
  for (const e of dep.exhibits ?? []) if (e.bates) exhibitBates.set(e.id.toLowerCase(), e.bates.toUpperCase());
  const byMark = new Map<string, DocLike[]>();
  for (const d of docs) { const c = canonicalExhibit(d.exhibit); if (c) byMark.set(c, [...(byMark.get(c) ?? []), d]); }
  const byDate = new Map<string, DocLike[]>();
  for (const d of docs) { const k = d.date.slice(0, 10); byDate.set(k, [...(byDate.get(k) ?? []), d]); }
  const subjectWords = docs.map((d) => ({ d, w: new Set(words(d.subject)) })).filter((x) => x.w.size >= 2);
  const minWords = opts.subjectMinWords ?? 3;
  const maxPerQa = opts.maxPerQa ?? 4;
  const out: CrossReference[] = [];
  dep.transcript.forEach((qa: DepositionQA, index) => {
    const text = `${qa.question} ${qa.answer}`;
    const seen = new Set<string>();
    const add = (r: Omit<CrossReference, "index" | "page" | "line">) => {
      const key = `${r.kind}|${r.docId ?? r.bates ?? r.label}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ index, page: qa.page, line: qa.line, ...r });
    };
    for (const m of text.matchAll(BATES_RE)) {
      const doc = byBates.get(m[1].toUpperCase());
      add({ kind: "bates", docId: doc?.id, bates: m[1].toUpperCase(), label: doc?.subject ?? m[1].toUpperCase(), match: m[1], confidence: doc ? 1 : 0.5 });
    }
    // Indian exhibit marks: exact mark in this matter only; an unmarked or doubly-marked exhibit stays unresolved (§23).
    const marks = new Set<string>(findExhibitMarks(text));
    const own = canonicalExhibit(qa.exhibit);
    if (own) marks.add(own);
    for (const mark of marks) {
      const hits = byMark.get(mark) ?? [];
      const doc = hits.length === 1 ? hits[0] : undefined;
      add({ kind: "exhibit", docId: doc?.id, bates: doc?.bates, label: doc?.subject ?? `${mark} (${hits.length > 1 ? "marked on more than one document" : "not marked in this matter"})`, match: mark, confidence: doc ? 1 : 0.5 });
    }
    const exRefs = new Set<string>();
    if (qa.exhibit && !own) exRefs.add(qa.exhibit.toLowerCase());
    for (const m of text.matchAll(EXHIBIT_RE)) if (!canonicalExhibit(m[0])) exRefs.add(m[1].toLowerCase());
    for (const ex of exRefs) {
      const bates = exhibitBates.get(ex) ?? Array.from(exhibitBates.entries()).find(([k]) => k.endsWith(`-${ex}`) || k === ex)?.[1];
      const doc = bates ? byBates.get(bates) : undefined;
      if (bates) add({ kind: "exhibit", docId: doc?.id, bates, label: doc?.subject ?? `Exhibit ${ex}`, match: `Exhibit ${ex}`, confidence: doc ? 0.95 : 0.6 });
    }
    // Subject matches: ≥3 distinctive words of a document subject appear in the testimony.
    const tw = new Set(words(text));
    if (tw.size) {
      const hits = subjectWords.map(({ d, w }) => { let n = 0; for (const x of w) if (tw.has(x)) n++; return { d, n, share: n / w.size }; }).filter((h) => h.n >= Math.min(minWords, 2) && h.share >= 0.6).sort((a, b) => b.share - a.share || b.n - a.n).slice(0, maxPerQa);
      for (const h of hits) add({ kind: "subject", docId: h.d.id, bates: h.d.bates, label: h.d.subject, match: `${h.n} of ${subjectWords.find((x) => x.d.id === h.d.id)!.w.size} subject words`, confidence: Math.round(Math.min(0.85, 0.4 + h.share * 0.45) * 100) / 100 });
    }
    // Date matches: the testimony names a date on which exactly one or two documents were sent.
    for (const dt of dateMentions(text)) {
      const ds = byDate.get(dt) ?? [];
      if (ds.length >= 1 && ds.length <= 2) for (const d of ds) add({ kind: "date", docId: d.id, bates: d.bates, label: d.subject, match: dt, confidence: ds.length === 1 ? 0.55 : 0.4 });
    }
  });
  return out;
}

/** Group references per document for the side panel (best confidence first). */
export function groupCrossReferences(refs: CrossReference[]): { key: string; docId?: string; bates?: string; label: string; best: number; hits: CrossReference[] }[] {
  const m = new Map<string, { key: string; docId?: string; bates?: string; label: string; best: number; hits: CrossReference[] }>();
  for (const r of refs) {
    const key = r.docId ?? r.bates ?? r.label;
    const g = m.get(key) ?? { key, docId: r.docId, bates: r.bates, label: r.label, best: 0, hits: [] };
    g.hits.push(r);
    g.best = Math.max(g.best, r.confidence);
    m.set(key, g);
  }
  return Array.from(m.values()).sort((a, b) => b.best - a.best || b.hits.length - a.hits.length || a.label.localeCompare(b.label));
}
