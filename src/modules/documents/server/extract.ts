import "server-only";
import { createHash } from "node:crypto";
import type { Principal } from "@/lib/auth/types";
import { generateJSON } from "@/lib/ai/agent";
import type { DocEvent, DocFact, ExtractProgress } from "../types";
import { loadSet } from "./access";
import { docStore, EXTRACTOR_VERSION, type ChunkRow, type DocStore, type ExtractionRow, type StoredFile } from "./store";
import { joinChunks, normalizeDate, normalizeForMatch, QUOTE_MIN_WORDS, quoteFound } from "./text";

/**
 * Facts and timeline extraction: one pass per file with the fast model over windows of ~14,000 characters carrying
 * page markers. Results are stored per file with the text hash and EXTRACTOR_VERSION, so re-runs only process new or
 * changed files. Quotes are checked against the stored text in code; dates are normalised in code and events without
 * a resolvable date are dropped. The client calls `runExtraction` repeatedly until `remaining` is 0.
 */

export const WINDOW_CHARS = 14_000;
export const EXTRACT_CONCURRENCY = 4;
/** Stop starting model calls after this long; a call in flight may run until the hard deadline. */
export const EXTRACT_BUDGET_MS = 200_000;
const HARD_EXTRA_MS = 70_000;

const CATEGORIES: DocFact["category"][] = ["party", "date", "amount", "obligation", "event", "admission", "claim", "other"];

export interface Window { index: number; text: string; pages: (number | null)[] }

export interface PageText { page: number | null; text: string }

/** Page texts of a file, rebuilt exactly from its chunks. */
export function pagesFromChunks(chunks: ChunkRow[]): PageText[] {
  const by = new Map<string, { page: number | null; cs: ChunkRow[] }>();
  for (const c of chunks) { const k = String(c.page); if (!by.has(k)) by.set(k, { page: c.page, cs: [] }); by.get(k)!.cs.push(c); }
  return Array.from(by.values()).map((v) => ({ page: v.page, text: joinChunks(v.cs.sort((a, b) => a.idx - b.idx)) })).sort((a, b) => (a.page ?? 0) - (b.page ?? 0));
}

export function textHash(pages: PageText[]): string {
  return createHash("sha256").update(pages.map((p) => `[${p.page ?? "-"}]\n${p.text}`).join("\n\n")).digest("hex");
}

/** Windows of ~`size` characters, each page introduced by "[Page N]"; a long page is split across windows. */
export function buildWindows(pages: PageText[], size = WINDOW_CHARS): Window[] {
  const out: Window[] = [];
  let cur = "";
  let curPages: (number | null)[] = [];
  const flush = () => { if (cur.trim()) out.push({ index: out.length, text: cur, pages: curPages }); cur = ""; curPages = []; };
  for (const p of pages) {
    let rest = p.text;
    let first = true;
    while (rest.length) {
      const marker = p.page != null ? `[Page ${p.page}${first ? "" : " continued"}]\n` : "";
      const room = size - cur.length - marker.length;
      if (room < 1000 && cur) { flush(); continue; }
      const piece = rest.slice(0, Math.max(room, 1000));
      rest = rest.slice(piece.length);
      cur += `${cur ? "\n\n" : ""}${marker}${piece}`;
      if (!curPages.includes(p.page)) curPages.push(p.page);
      first = false;
      if (cur.length >= size) flush();
    }
  }
  flush();
  return out;
}

export const EXTRACT_SCHEMA = {
  type: "object",
  properties: {
    facts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          statement: { type: "string" },
          parties: { type: "array", items: { type: "string" } },
          category: { type: "string", enum: CATEGORIES },
          quote: { type: "string" },
          page: { type: ["integer", "null"] },
          date: { type: ["string", "null"] },
        },
        required: ["statement", "parties", "category", "quote", "page", "date"],
        additionalProperties: false,
      },
    },
    events: {
      type: "array",
      items: {
        type: "object",
        properties: {
          dateText: { type: "string" },
          description: { type: "string" },
          parties: { type: "array", items: { type: "string" } },
          quote: { type: "string" },
          page: { type: ["integer", "null"] },
        },
        required: ["dateText", "description", "parties", "quote", "page"],
        additionalProperties: false,
      },
    },
  },
  required: ["facts", "events"],
  additionalProperties: false,
} as const;

export const EXTRACT_INSTRUCTIONS = [
  "You extract key facts and dated events from an excerpt of a legal document. Work only from the excerpt.",
  "Page markers such as [Page 12] precede the text of each page; give the page number on which each quote appears (null when the excerpt has no page markers).",
  "facts: the material facts a lawyer would note — parties and their roles, amounts, obligations, admissions, claims, key dates and events. Each statement is one self-contained sentence saying what the document states (not a conclusion or opinion of yours). category is one of party, date, amount, obligation, event, admission, claim, other. date is the date the fact refers to, copied as written, or null.",
  "events: things that happened or are due on a date written in the excerpt. dateText is the date exactly as written (e.g. \"3rd March, 2021\" or \"03.03.2021\"); skip events with no written date.",
  "quote: the sentence or clause copied verbatim from the excerpt (at least six words, at most 300 characters) that supports the item. Never paraphrase inside quote.",
  "parties: the people and organisations the item is about, as named in the excerpt.",
  "At most 25 facts and 25 events per excerpt; prefer the most material. Return empty lists when there is nothing material.",
].join("\n");

interface RawFact { statement?: unknown; parties?: unknown; category?: unknown; quote?: unknown; page?: unknown; date?: unknown }
interface RawEvent { dateText?: unknown; description?: unknown; parties?: unknown; quote?: unknown; page?: unknown }

const str = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const strs = (v: unknown) => (Array.isArray(v) ? v.map((x) => str(x, 200)).filter(Boolean).slice(0, 12) : []);
const shortHash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

/** Place a quote: the stated page when the quote is on it, else the window page where it occurs, else null. */
function locate(quote: string, statedPage: unknown, win: Window, pageText: Map<number | null, string>): { page: number | null; found: boolean } {
  const stated = typeof statedPage === "number" && win.pages.includes(statedPage) ? statedPage : null;
  const paged = win.pages.some((p) => p != null);
  // A quote of fewer than QUOTE_MIN_WORDS words is never "found": it would mark a timeline row as backed by the record.
  const opts = { minWords: QUOTE_MIN_WORDS };
  if (stated != null && quoteFound(quote, pageText.get(stated) ?? "", opts)) return { page: stated, found: true };
  for (const p of win.pages) if (quoteFound(quote, pageText.get(p) ?? "", opts)) return { page: p, found: true };
  // Not found verbatim: keep the model's page only when it is a page of this window; never guess another one.
  return { page: paged ? stated : null, found: false };
}

/** Turn one window's model output into checked facts and events. */
export function processWindow(file: Pick<StoredFile, "id" | "setId" | "name">, win: Window, raw: { facts?: RawFact[]; events?: RawEvent[] }, pageText: Map<number | null, string>): { facts: DocFact[]; events: DocEvent[] } {
  const facts: DocFact[] = [];
  const events: DocEvent[] = [];
  for (const f of (Array.isArray(raw?.facts) ? raw.facts : []).slice(0, 40)) {
    const statement = str(f.statement, 600);
    const quote = str(f.quote, 400);
    if (!statement) continue;
    const loc = locate(quote, f.page, win, pageText);
    const d = normalizeDate(str(f.date, 80) || null);
    const category = CATEGORIES.includes(f.category as DocFact["category"]) ? (f.category as DocFact["category"]) : "other";
    facts.push({
      id: `dfact_${shortHash(`${file.id}|${statement}|${quote}|${loc.page}`)}`, setId: file.setId, fileId: file.id, fileName: file.name, page: loc.page,
      statement, parties: strs(f.parties), category, quote, quoteFound: loc.found, date: d?.date ?? null, datePrecision: d?.precision ?? null,
    });
  }
  for (const e of (Array.isArray(raw?.events) ? raw.events : []).slice(0, 40)) {
    const dateText = str(e.dateText, 80);
    const description = str(e.description, 600);
    const d = normalizeDate(dateText);
    if (!d || !description) continue; // an event without a resolvable date is dropped
    const quote = str(e.quote, 400);
    const loc = locate(quote, e.page, win, pageText);
    events.push({
      id: `devent_${shortHash(`${file.id}|${d.date}|${description}|${loc.page}`)}`, setId: file.setId, fileId: file.id, fileName: file.name, page: loc.page,
      date: d.date, datePrecision: d.precision, dateText, description, parties: strs(e.parties), quote, quoteFound: loc.found,
    });
  }
  return { facts, events };
}

function dedupe<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true)));
}

/** A tiny counting semaphore shared by every window of one extraction call. */
function semaphore(n: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= n) await new Promise<void>((r) => queue.push(r));
    active++;
    try { return await fn(); } finally { active--; queue.shift()?.(); }
  };
}

interface FileOutcome { status: "done" | "failed" | "partial"; error?: string }

async function extractFile(store: DocStore, file: StoredFile, limit: ReturnType<typeof semaphore>, clock: { stopAt: number; hardAt: number }, signal?: AbortSignal): Promise<FileOutcome> {
  const pages = pagesFromChunks(await store.fileChunks(file.id));
  const hash = textHash(pages);
  const existing = await store.getExtraction(file.id);
  const now = () => new Date().toISOString();
  const markFile = async (patch: Partial<StoredFile>) => {
    const current = (await store.getFile(file.setId, file.id)) ?? file;
    await store.updateFile({ ...current, ...patch });
  };
  if (existing && existing.textHash === hash && existing.version === EXTRACTOR_VERSION && existing.status === "done") {
    await markFile({ extraction: "done", extractionVersion: EXTRACTOR_VERSION });
    return { status: "done" };
  }
  const windows = buildWindows(pages);
  const resume = existing && existing.textHash === hash && existing.version === EXTRACTOR_VERSION && existing.status === "partial" ? existing : null;
  const startAt = resume?.windowsDone ?? 0;
  const pageText = new Map<number | null, string>(pages.map((p) => [p.page, p.text]));
  const results: ({ facts: DocFact[]; events: DocEvent[] } | null)[] = windows.map(() => null);
  let error: string | null = null;
  let stoppedByClock = false;

  await Promise.all(windows.slice(startAt).map((win) => limit(async () => {
    if (error || signal?.aborted) return;
    if (Date.now() >= clock.stopAt) { stoppedByClock = true; return; }
    const budget = Math.max(5_000, Math.min(EXTRACT_BUDGET_MS, clock.hardAt - Date.now()));
    const timeout = AbortSignal.timeout(budget);
    try {
      const raw = await generateJSON<{ facts?: RawFact[]; events?: RawEvent[] }>({
        fast: true,
        taskType: "extract",
        name: "document_facts",
        schema: EXTRACT_SCHEMA as unknown as Record<string, unknown>,
        instructions: EXTRACT_INSTRUCTIONS,
        input: `Document: ${file.name}\nExcerpt ${win.index + 1} of ${windows.length}:\n\n${win.text}`,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        metadata: { surface: "documents.extract" },
      });
      results[win.index] = processWindow(file, win, raw ?? {}, pageText);
    } catch (e) {
      if (timeout.aborted && !signal?.aborted) { stoppedByClock = true; return; }
      if (signal?.aborted) return; // cancelled by the caller: progress is kept, never counted as a failed attempt
      error = (e as Error).message || String(e);
    }
  })));

  // Contiguous windows completed from the start (resumed progress included).
  let done = startAt;
  while (done < windows.length && results[done]) done++;
  const facts = dedupe([...(resume?.facts ?? []), ...results.slice(startAt, done).flatMap((r) => r!.facts)]);
  const events = dedupe([...(resume?.events ?? []), ...results.slice(startAt, done).flatMap((r) => r!.events)]);
  const row: ExtractionRow = { fileId: file.id, setId: file.setId, textHash: hash, version: EXTRACTOR_VERSION, status: "done", facts, events, error: null, windowsDone: done, updatedAt: now() };

  // The text may have changed while the model ran (OCR of a page, appended pages) or the file may be gone: results
  // bound to the old text are discarded and the file stays pending (OCR/append already reset it).
  const current = await store.getFile(file.setId, file.id);
  if (!current) return { status: "partial" };
  if (textHash(pagesFromChunks(await store.fileChunks(file.id))) !== hash) return { status: "partial" };

  if (done >= windows.length) {
    await store.putExtraction(row);
    await markFile({ extraction: "done", extractionVersion: EXTRACTOR_VERSION });
    return { status: "done" };
  }
  if (error && !stoppedByClock) {
    await store.putExtraction({ ...row, status: "failed", error: String(error).slice(0, 500) });
    await markFile({ extraction: "failed", extractionVersion: EXTRACTOR_VERSION, extractionAttempts: file.extractionAttempts + 1 });
    return { status: "failed", error: String(error) };
  }
  // Out of time (or cancelled): keep the progress; the file stays pending and resumes on the next call.
  await store.putExtraction({ ...row, status: "partial" });
  return { status: "partial" };
}

export async function runExtraction(principal: Principal, setId: string, opts: { max?: unknown; signal?: AbortSignal; budgetMs?: number } = {}): Promise<ExtractProgress> {
  const set = await loadSet(principal, setId, "write");
  const store = await docStore();
  const max = Math.max(1, Math.min(Number.isFinite(Number(opts.max)) && Number(opts.max) > 0 ? Math.floor(Number(opts.max)) : 8, 50));
  const started = Date.now();
  const budget = opts.budgetMs ?? EXTRACT_BUDGET_MS;
  const clock = { stopAt: started + budget, hardAt: started + budget + HARD_EXTRA_MS };
  const files = await store.pendingExtraction(set.id, max);
  const limit = semaphore(EXTRACT_CONCURRENCY);
  const progress: ExtractProgress = { processed: 0, failed: 0, remaining: 0, errors: [] };
  // Files start in order; their windows share the EXTRACT_CONCURRENCY model-call slots.
  const outcomes = await Promise.all(files.map((f) => extractFile(store, f, limit, clock, opts.signal).catch((e): FileOutcome => ({ status: "failed", error: (e as Error).message }))));
  outcomes.forEach((o, i) => {
    if (o.status === "done") progress.processed++;
    else if (o.status === "failed") { progress.failed++; progress.errors.push({ fileId: files[i].id, name: files[i].name, error: (o.error ?? "failed").slice(0, 300) }); }
  });
  await store.refreshSetCounts(set.id);
  progress.remaining = await store.countPendingExtraction(set.id);
  return progress;
}

// ---- queries --------------------------------------------------------------------------------------------------------

export const MAX_ITEMS = 5000;

function matches(q: string | undefined, fields: (string | undefined | null)[]): boolean {
  if (!q) return true;
  const hay = normalizeForMatch(fields.filter(Boolean).join(" \u0001 "));
  return normalizeForMatch(q).split(" ").filter(Boolean).every((w) => hay.includes(w));
}

export async function listFacts(principal: Principal, setId: string, q: { file?: unknown; q?: unknown; category?: unknown }): Promise<{ facts: DocFact[]; extracted: number; total: number }> {
  const set = await loadSet(principal, setId, "read");
  const store = await docStore();
  const file = typeof q.file === "string" && q.file ? q.file : undefined;
  const text = typeof q.q === "string" ? q.q.trim().slice(0, 200) : undefined;
  const category = typeof q.category === "string" && CATEGORIES.includes(q.category as DocFact["category"]) ? (q.category as DocFact["category"]) : undefined;
  const rows = await store.listExtractions(set.id, file);
  const facts = rows.flatMap((r) => r.facts)
    .filter((f) => (!category || f.category === category) && matches(text, [f.statement, f.quote, f.fileName, ...f.parties]))
    .sort((a, b) => a.fileName.localeCompare(b.fileName) || (a.page ?? 0) - (b.page ?? 0));
  const fresh = await store.getSet(set.id);
  return { facts: facts.slice(0, MAX_ITEMS), extracted: fresh?.extractedCount ?? set.extractedCount, total: fresh?.fileCount ?? set.fileCount };
}

export async function listTimeline(principal: Principal, setId: string, q: { file?: unknown; q?: unknown }): Promise<{ events: DocEvent[]; extracted: number; total: number }> {
  const set = await loadSet(principal, setId, "read");
  const store = await docStore();
  const file = typeof q.file === "string" && q.file ? q.file : undefined;
  const text = typeof q.q === "string" ? q.q.trim().slice(0, 200) : undefined;
  const rows = await store.listExtractions(set.id, file);
  const events = rows.flatMap((r) => r.events)
    .filter((e) => matches(text, [e.description, e.quote, e.dateText, e.fileName, ...e.parties]))
    .sort((a, b) => a.date.localeCompare(b.date) || a.fileName.localeCompare(b.fileName) || (a.page ?? 0) - (b.page ?? 0));
  const fresh = await store.getSet(set.id);
  return { events: events.slice(0, MAX_ITEMS), extracted: fresh?.extractedCount ?? set.extractedCount, total: fresh?.fileCount ?? set.fileCount };
}
