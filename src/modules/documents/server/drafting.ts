import "server-only";
import { createHash } from "node:crypto";
import { nanoid } from "nanoid";
import type { Principal } from "@/lib/auth/types";
import { generateJSON, generateText } from "@/lib/ai/agent";
import {
  buildDateRows, checkSynopsis, detectParagraphs, EMPTY_DATES_STATE, glossaryHints, languageLabel, newReply, rowsHash, ruleCategory, splitDefects, STANCES,
  synopsisInput, TRANSLATION_LABEL, TRANSLATION_LANGUAGES, translationKey,
  type DateOverride, type DateRow, type DatesFormat, type DatesState, type Defect, type DefectCategory, type DefectForum, type DefectNotice, type ManualDateRow,
  type ParaReply, type ParawiseState, type ReplyEvidence, type ReplyStance, type SynopsisDraft, type TranslationRecord,
} from "../drafting";
import type { DatePrecision, DocEvent, DocFile } from "../types";
import { DocsError, loadSet } from "./access";
import { pagesFromChunks, textHash } from "./extract";
import { searchChunks } from "./search";
import { recordAudit } from "./sets";
import { docStore, publicFile } from "./store";
import { normalizeDate, normalizePageText, quoteFound } from "./text";
import { workStore, type WorkItem } from "./work-store";

/**
 * Drafting services for document sets: list of dates & synopsis, para-wise reply, working translations, registry
 * defect notices. Every function authorizes the set (read for reads, write for changes) before touching its data;
 * work items are stored per set (work-store.ts) with compare-and-set versions so two people cannot silently overwrite.
 */

const now = () => new Date().toISOString();
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const str = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\u0000/g, "").trim().slice(0, max) : "");

function conflict(): DocsError { return new DocsError("This changed since you opened it. Reload and try again.", 409, "conflict"); }

async function timelineEvents(setId: string): Promise<{ events: DocEvent[]; extracted: number; total: number }> {
  const store = await docStore();
  const rows = await store.listExtractions(setId);
  const events = rows.flatMap((r) => r.events);
  const set = await store.getSet(setId);
  return { events, extracted: set?.extractedCount ?? 0, total: set?.fileCount ?? 0 };
}

// =====================================================================================================================
// List of dates & synopsis
// =====================================================================================================================

export interface DatesView { state: DatesState; rows: DateRow[]; extracted: number; total: number }

async function loadDatesState(setId: string): Promise<DatesState> {
  const item = await (await workStore()).get<DatesState>(setId, "dates", "list");
  return item?.data ? { ...EMPTY_DATES_STATE, ...item.data } : { ...EMPTY_DATES_STATE };
}

export async function getDates(principal: Principal, setId: string): Promise<DatesView> {
  const set = await loadSet(principal, setId, "read");
  const [state, tl] = await Promise.all([loadDatesState(set.id), timelineEvents(set.id)]);
  return { state, rows: buildDateRows(tl.events, state), extracted: tl.extracted, total: tl.total };
}

const PRECISIONS: DatePrecision[] = ["day", "month", "year"];

function cleanOverride(v: unknown): DateOverride | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const out: DateOverride = {};
  if (typeof o.particulars === "string") out.particulars = str(o.particulars, 2000);
  if (typeof o.date === "string") {
    const d = normalizeDate(o.date);
    if (!d) throw new DocsError(`"${str(o.date, 40)}" is not a date`, 422, "invalid");
    out.date = d.date; out.datePrecision = d.precision;
  }
  if (typeof o.dateText === "string") out.dateText = str(o.dateText, 80);
  if (typeof o.selected === "boolean") out.selected = o.selected;
  if (typeof o.removed === "boolean") out.removed = o.removed;
  return out;
}

function cleanManual(v: unknown): ManualDateRow | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const d = normalizeDate(typeof o.date === "string" ? o.date : "");
  const particulars = str(o.particulars, 2000);
  if (!d || !particulars) throw new DocsError("A hand-added row needs a date and particulars", 422, "invalid");
  const id = typeof o.id === "string" && /^manual_[A-Za-z0-9_-]{4,24}$/.test(o.id) ? o.id : `manual_${nanoid(10)}`;
  return { id, date: d.date, datePrecision: PRECISIONS.includes(d.precision) ? d.precision : "day", particulars, selected: o.selected !== false };
}

/** Save edits (compare-and-set on `version`): format, per-event overrides, hand-added rows, an edited synopsis. */
export async function saveDates(principal: Principal, setId: string, patch: { version?: unknown; format?: unknown; overrides?: unknown; manual?: unknown; synopsisText?: unknown; clearSynopsis?: unknown }): Promise<DatesView> {
  const set = await loadSet(principal, setId, "write");
  const ws = await workStore();
  const cur = await loadDatesState(set.id);
  if (Number(patch.version) !== cur.version) throw conflict();
  const next: DatesState = { ...cur, version: cur.version + 1 };
  if (patch.format === "sc" || patch.format === "hc") next.format = patch.format as DatesFormat;
  if (patch.overrides && typeof patch.overrides === "object") {
    const merged = { ...cur.overrides };
    for (const [id, v] of Object.entries(patch.overrides as Record<string, unknown>).slice(0, 5000)) {
      if (!/^devent_[a-f0-9]{8,32}$/.test(id)) continue;
      const o = cleanOverride(v);
      if (o) merged[id] = { ...(merged[id] ?? {}), ...o };
    }
    next.overrides = merged;
  }
  if (Array.isArray(patch.manual)) next.manual = patch.manual.slice(0, 500).map(cleanManual).filter((x): x is ManualDateRow => !!x);
  if (patch.clearSynopsis === true) next.synopsis = null;
  else if (typeof patch.synopsisText === "string" && cur.synopsis) next.synopsis = { ...cur.synopsis, text: str(patch.synopsisText, 20_000), edited: true };
  await ws.put<DatesState>({ setId: set.id, kind: "dates", key: "list", data: next, textHash: null, createdBy: principal.id, updatedAt: now() });
  const tl = await timelineEvents(set.id);
  return { state: next, rows: buildDateRows(tl.events, next), extracted: tl.extracted, total: tl.total };
}

export const SYNOPSIS_INSTRUCTIONS = (format: DatesFormat) => [
  `You write the SYNOPSIS that accompanies the list of dates in a ${format === "sc" ? "Supreme Court of India" : "High Court"} petition.`,
  "Use ONLY the numbered rows supplied. Do not add any fact, name, date, amount, statute or inference that the rows do not state.",
  "Cite the row(s) supporting each sentence as [R1], [R2] … immediately after the sentence. Cite only row numbers you were given.",
  "Write in plain, formal English: one to three short paragraphs, 120–350 words, chronological, no headings, no bullet points, no legal argument and no prayer.",
  "If the rows do not support a coherent narrative, say so in one sentence rather than filling gaps.",
].join("\n");

export const SYNOPSIS_MAX_ROWS = 150;

/** Draft a synopsis grounded only on the selected rows; markers, dates and uncited sentences are checked in code. */
export async function draftSynopsis(principal: Principal, setId: string, input: { rowIds?: unknown; version?: unknown }, signal?: AbortSignal): Promise<DatesView> {
  const set = await loadSet(principal, setId, "write");
  const state = await loadDatesState(set.id);
  if (input.version != null && Number(input.version) !== state.version) throw conflict();
  const tl = await timelineEvents(set.id);
  const all = buildDateRows(tl.events, state);
  const wanted = Array.isArray(input.rowIds) ? new Set(input.rowIds.filter((x): x is string => typeof x === "string")) : null;
  const rows = all.filter((r) => (wanted ? wanted.has(r.id) : r.selected));
  if (!rows.length) throw new DocsError("Select at least one row for the synopsis", 422, "invalid");
  if (rows.length > SYNOPSIS_MAX_ROWS) throw new DocsError(`Select at most ${SYNOPSIS_MAX_ROWS} rows for the synopsis`, 422, "invalid");
  const res = await generateText({
    instructions: SYNOPSIS_INSTRUCTIONS(state.format),
    input: `Rows (the only material you may use):\n${synopsisInput(rows)}`,
    taskType: "draft",
    matterId: set.matterId ?? undefined,
    maxOutputTokens: 1500,
    signal,
    metadata: { surface: "documents.synopsis" },
  });
  const text = (res.text ?? "").trim();
  if (!text) throw new DocsError("The model returned no synopsis", 502, "empty");
  const checks = checkSynopsis(text, rows);
  const synopsis: SynopsisDraft = { text, rowIds: rows.map((r) => r.id), rowsHash: rowsHash(rows), generatedAt: now(), model: null, ...checks, edited: false };
  const fresh = await loadDatesState(set.id);
  if (fresh.version !== state.version) throw conflict();
  const next: DatesState = { ...fresh, synopsis, version: fresh.version + 1 };
  await (await workStore()).put<DatesState>({ setId: set.id, kind: "dates", key: "list", data: next, textHash: synopsis.rowsHash, createdBy: principal.id, updatedAt: now() });
  recordAudit(principal, "ai.generate", { kind: "document_set", id: set.id, matterId: set.matterId ?? undefined }, { surface: "documents.synopsis", rows: rows.length, unresolved: checks.unresolved.length, unknownDates: checks.unknownDates.length });
  return { state: next, rows: all, extracted: tl.extracted, total: tl.total };
}

// =====================================================================================================================
// Shared: one file's pages
// =====================================================================================================================

async function filePages(setId: string, fileId: string): Promise<{ file: DocFile; pages: { page: number | null; text: string }[]; hash: string }> {
  const store = await docStore();
  const file = typeof fileId === "string" && fileId ? await store.getFile(setId, fileId) : null;
  if (!file) throw new DocsError("File not found", 404, "not_found");
  const pages = pagesFromChunks(await store.fileChunks(file.id));
  return { file: publicFile(file), pages, hash: textHash(pages) };
}

// =====================================================================================================================
// Para-wise reply
// =====================================================================================================================

export interface ParawiseView { state: ParawiseState | null; stale: boolean; paragraphs: number; textHash: string; file: DocFile }

export async function getParawise(principal: Principal, setId: string, fileId: string): Promise<ParawiseView> {
  const set = await loadSet(principal, setId, "read");
  const { file, pages, hash } = await filePages(set.id, fileId);
  const item = await (await workStore()).get<ParawiseState>(set.id, "parawise", file.id);
  return { state: item?.data ?? null, stale: !!item && item.data.textHash !== hash, paragraphs: detectParagraphs(pages).length, textHash: hash, file };
}

/** Detect the pleading's numbered paragraphs (deterministic) and start (or restart) the reply. */
export async function startParawise(principal: Principal, setId: string, fileId: string, opts: { restart?: boolean } = {}): Promise<ParawiseView> {
  const set = await loadSet(principal, setId, "write");
  const { file, pages, hash } = await filePages(set.id, fileId);
  const ws = await workStore();
  const existing = await ws.get<ParawiseState>(set.id, "parawise", file.id);
  if (existing && !opts.restart && existing.data.textHash === hash) return { state: existing.data, stale: false, paragraphs: existing.data.paras.length, textHash: hash, file };
  const paras = detectParagraphs(pages);
  if (!paras.length) throw new DocsError("No numbered paragraphs were found in this file (expected lines starting “1.”, “2.” …). Choose the plaint or petition, or check that its text was read.", 422, "no_paragraphs");
  if (paras.length > 400) throw new DocsError("This file has more than 400 numbered paragraphs; split it first.", 422, "too_many");
  const state: ParawiseState = { fileId: file.id, fileName: file.name, textHash: hash, paras: paras.map(newReply), model: null, updatedAt: now(), version: (existing?.data.version ?? 0) + 1 };
  await ws.put<ParawiseState>({ setId: set.id, kind: "parawise", key: file.id, data: state, textHash: hash, createdBy: principal.id, updatedAt: state.updatedAt });
  return { state, stale: false, paragraphs: paras.length, textHash: hash, file };
}

export const PARAWISE_BATCH = 6;
export const PARAWISE_PER_CALL = 18;
export const PARAWISE_BUDGET_MS = 150_000;
const PASSAGES_PER_PARA = 4;

export const PARAWISE_INSTRUCTIONS = [
  "You draft the defendant's para-wise reply to paragraphs of a plaint / petition, for a lawyer to review.",
  "For each paragraph choose a stance: admitted (only when the supplied passages clearly confirm every fact in it), denied (the passages contradict it), not_admitted (facts not within the defendant's knowledge or not shown by the passages), matter_of_record (it only recites documents or proceedings), legal_submission (it states law or argument), no_reply (formal: description of parties, cause title, valuation).",
  "Write `reply` as one to three sentences of the reply text after the opening words (e.g. 'It is specifically denied that …'). Do not invent facts.",
  "`reasoning` explains the stance in one sentence, tied to the passages.",
  "`evidence`: the numbered passages you rely on, each with a verbatim quote (at most 250 characters) copied from that passage. Never paraphrase inside quote. Use an empty list when no passage bears on the paragraph.",
  "When in doubt between admitted and not_admitted, choose not_admitted. Never admit an allegation the passages do not establish.",
].join("\n");

const REPLY_SCHEMA = {
  type: "object",
  properties: {
    replies: {
      type: "array",
      items: {
        type: "object",
        properties: {
          n: { type: "string" },
          stance: { type: "string", enum: STANCES },
          reply: { type: "string" },
          reasoning: { type: "string" },
          evidence: { type: "array", items: { type: "object", properties: { passage: { type: "integer" }, quote: { type: "string" } }, required: ["passage", "quote"], additionalProperties: false } },
        },
        required: ["n", "stance", "reply", "reasoning", "evidence"],
        additionalProperties: false,
      },
    },
  },
  required: ["replies"],
  additionalProperties: false,
} as const;

interface RawReply { n?: unknown; stance?: unknown; reply?: unknown; reasoning?: unknown; evidence?: { passage?: unknown; quote?: unknown }[] }

/**
 * Propose replies for pending paragraphs (or the paragraphs named in `ns`), a bounded number per call. Each paragraph
 * gets passages retrieved from the set's OTHER files; the model may only cite those passages, and every quote is checked
 * against the passage text in code (unknown passage numbers are dropped and counted, never re-bound).
 */
export async function proposeReplies(principal: Principal, setId: string, fileId: string, opts: { ns?: unknown; version?: unknown; signal?: AbortSignal; budgetMs?: number } = {}): Promise<ParawiseView & { remaining: number; failed: number }> {
  const set = await loadSet(principal, setId, "write");
  const { file, hash } = await filePages(set.id, fileId);
  const ws = await workStore();
  const item = await ws.get<ParawiseState>(set.id, "parawise", file.id);
  if (!item) throw new DocsError("Start the para-wise reply first", 409, "not_started");
  if (opts.version != null && Number(opts.version) !== item.data.version) throw conflict();
  if (item.data.textHash !== hash) throw new DocsError("The pleading's text changed since its paragraphs were detected. Restart the reply.", 409, "stale");
  const state = item.data;
  const wanted = Array.isArray(opts.ns) ? new Set(opts.ns.map(String)) : null;
  const todo = state.paras.filter((p) => (wanted ? wanted.has(p.n) : p.status !== "proposed")).slice(0, PARAWISE_PER_CALL);
  const store = await docStore();
  const others = (await store.allFiles(set.id)).filter((f) => f.id !== file.id).map((f) => f.id);
  const started = Date.now();
  const budget = opts.budgetMs ?? PARAWISE_BUDGET_MS;
  const results = new Map<string, ParaReply>();
  let failed = 0;
  for (let i = 0; i < todo.length; i += PARAWISE_BATCH) {
    if (opts.signal?.aborted || Date.now() - started > budget) break;
    const batch = todo.slice(i, i + PARAWISE_BATCH);
    // Passages per paragraph (numbered globally within the batch).
    const passages: { fileId: string; fileName: string; page: number | null; text: string }[] = [];
    const perPara = new Map<string, number[]>();
    for (const p of batch) {
      const hits = others.length ? await searchChunks(store, [set.id], p.paraText.slice(0, 600), { limit: PASSAGES_PER_PARA, fileIds: others }) : [];
      perPara.set(p.n, hits.map((h) => { passages.push({ fileId: h.fileId, fileName: h.fileName, page: h.page, text: h.text }); return passages.length; }));
    }
    const input = [
      `Pleading: ${file.name}`,
      "",
      ...batch.map((p) => `PARAGRAPH ${p.n}${p.page != null ? ` (page ${p.page})` : ""}:\n${p.paraText.slice(0, 3000)}\nPassages for this paragraph: ${(perPara.get(p.n) ?? []).map((x) => `[${x}]`).join(" ") || "none"}`),
      "",
      "PASSAGES (from the defendant's documents in the set):",
      ...passages.map((x, k) => `[${k + 1}] ${x.fileName}${x.page != null ? `, page ${x.page}` : ""}:\n${x.text.slice(0, 1600)}`),
    ].join("\n");
    try {
      const raw = await generateJSON<{ replies?: RawReply[] }>({
        instructions: PARAWISE_INSTRUCTIONS, input, schema: REPLY_SCHEMA as unknown as Record<string, unknown>, name: "parawise_replies",
        taskType: "draft", matterId: set.matterId ?? undefined, maxOutputTokens: 4000, signal: opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(90_000)]) : AbortSignal.timeout(90_000),
        metadata: { surface: "documents.parawise" },
      });
      const byN = new Map((raw?.replies ?? []).map((r) => [String(r.n ?? "").trim(), r]));
      for (const p of batch) {
        const r = byN.get(p.n);
        if (!r) { failed++; results.set(p.n, { ...p, status: "failed", error: "The model gave no reply for this paragraph." }); continue; }
        const stance: ReplyStance = STANCES.includes(r.stance as ReplyStance) ? (r.stance as ReplyStance) : "not_admitted";
        const allowed = new Set(perPara.get(p.n) ?? []);
        let dropped = 0;
        const evidence: ReplyEvidence[] = [];
        for (const e of (Array.isArray(r.evidence) ? r.evidence : []).slice(0, 6)) {
          const k = Number(e?.passage);
          const src = Number.isInteger(k) ? passages[k - 1] : undefined;
          // Only passages supplied for THIS paragraph count; anything else is dropped, never re-bound.
          if (!src || !allowed.has(k)) { dropped++; continue; }
          const quote = str(e?.quote, 300);
          evidence.push({ fileId: src.fileId, fileName: src.fileName, page: src.page, quote, quoteFound: !!quote && quoteFound(quote, src.text) });
        }
        const reply = str(r.reply, 2000);
        results.set(p.n, {
          ...p, status: "proposed", error: null,
          proposed: { stance, reply, reasoning: str(r.reasoning, 600), evidence, droppedRefs: dropped },
          // The user's version starts as the proposal unless they already edited it.
          ...(p.edited ? {} : { stance, reply, approved: false, approvedBy: null, approvedAt: null }),
        });
      }
    } catch (e) {
      if (opts.signal?.aborted) break;
      for (const p of batch) { failed++; results.set(p.n, { ...p, status: "failed", error: str((e as Error)?.message ?? "failed", 300) }); }
    }
  }
  // Merge into the latest stored state (compare-and-set: concurrent edits win over a stale proposal run).
  const latest = await ws.get<ParawiseState>(set.id, "parawise", file.id);
  if (!latest || latest.data.version !== state.version) throw conflict();
  const next: ParawiseState = { ...latest.data, paras: latest.data.paras.map((p) => results.get(p.n) ?? p), updatedAt: now(), version: latest.data.version + 1 };
  await ws.put<ParawiseState>({ setId: set.id, kind: "parawise", key: file.id, data: next, textHash: hash, createdBy: principal.id, updatedAt: next.updatedAt });
  recordAudit(principal, "ai.generate", { kind: "document_file", id: file.id, label: file.name, matterId: set.matterId ?? undefined }, { surface: "documents.parawise", proposed: results.size - failed, failed });
  return { state: next, stale: false, paragraphs: next.paras.length, textHash: hash, file, remaining: next.paras.filter((p) => p.status !== "proposed").length, failed };
}

/** Edit one paragraph's stance / reply, or approve it. Approval binds to the current stance and text; editing clears it. */
export async function updateReply(principal: Principal, setId: string, fileId: string, patch: { version?: unknown; n?: unknown; stance?: unknown; reply?: unknown; approve?: unknown }): Promise<ParawiseView> {
  const set = await loadSet(principal, setId, "write");
  const { file, hash } = await filePages(set.id, fileId);
  const ws = await workStore();
  const item = await ws.get<ParawiseState>(set.id, "parawise", file.id);
  if (!item) throw new DocsError("Start the para-wise reply first", 409, "not_started");
  if (Number(patch.version) !== item.data.version) throw conflict();
  const n = String(patch.n ?? "");
  const idx = item.data.paras.findIndex((p) => p.n === n);
  if (idx < 0) throw new DocsError(`No paragraph ${str(n, 10)}`, 404, "not_found");
  const p = { ...item.data.paras[idx] };
  let changed = false;
  if (typeof patch.stance === "string") {
    if (!STANCES.includes(patch.stance as ReplyStance)) throw new DocsError("Unknown stance", 422, "invalid");
    if (patch.stance !== p.stance) { p.stance = patch.stance as ReplyStance; changed = true; }
  }
  if (typeof patch.reply === "string") { const r = str(patch.reply, 4000); if (r !== p.reply) { p.reply = r; changed = true; } }
  if (changed) { p.edited = true; p.approved = false; p.approvedBy = null; p.approvedAt = null; }
  if (patch.approve === true) { p.approved = true; p.approvedBy = principal.name || principal.id; p.approvedAt = now(); }
  if (patch.approve === false) { p.approved = false; p.approvedBy = null; p.approvedAt = null; }
  const paras = item.data.paras.slice();
  paras[idx] = p;
  const next: ParawiseState = { ...item.data, paras, updatedAt: now(), version: item.data.version + 1 };
  await ws.put<ParawiseState>({ setId: set.id, kind: "parawise", key: file.id, data: next, textHash: hash, createdBy: principal.id, updatedAt: next.updatedAt });
  if (patch.approve === true && p.stance === "admitted") recordAudit(principal, "update", { kind: "document_file", id: file.id, label: file.name, matterId: set.matterId ?? undefined }, { surface: "documents.parawise", approvedAdmission: p.n });
  return { state: next, stale: next.textHash !== hash, paragraphs: paras.length, textHash: hash, file };
}

// =====================================================================================================================
// Working translations
// =====================================================================================================================

export const TRANSLATE_MAX_PAGES = 12;
export const TRANSLATE_PAGE_CHARS = 12_000;
const LANG_CODES = new Set(TRANSLATION_LANGUAGES.map((l) => l.code));

export const TRANSLATE_INSTRUCTIONS = (from: string, to: string, glossary: string[]) => [
  `Translate the page of a legal document from ${from === "auto" ? "its language" : languageLabel(from)} into ${languageLabel(to)}.`,
  "Translate faithfully and completely: do not summarise, omit, add or explain. Keep paragraph breaks and numbering.",
  "Keep exactly as written: names of persons and companies, case citations, statute and section numbers, dates, amounts, exhibit and annexure marks.",
  "Use the accepted legal term in the target language; on its first use keep the source term in brackets.",
  "Where the source is illegible or ambiguous, write [illegible] or [ambiguous: …] instead of guessing.",
  "Output only the translation.",
  ...(glossary.length ? ["Glossary (use these equivalents):", ...glossary] : []),
].join("\n");

export interface TranslationView { file: DocFile; to: string; records: (TranslationRecord & { stale: boolean })[] }

export async function listTranslations(principal: Principal, setId: string, fileId: string, to?: string | null): Promise<TranslationView> {
  const set = await loadSet(principal, setId, "read");
  const { file, pages } = await filePages(set.id, fileId);
  const items = await (await workStore()).list<TranslationRecord>(set.id, "translation", { prefix: `${file.id}:`, limit: 3000 });
  const current = new Map(pages.map((p) => [p.page ?? 0, sha(p.text)]));
  const records = items.map((i) => i.data).filter((r) => r && (!to || r.to === to)).map((r) => ({ ...r, stale: current.get(r.page ?? 0) !== r.sourceHash }))
    .sort((a, b) => (a.page ?? 0) - (b.page ?? 0));
  return { file, to: to ?? "", records };
}

/** Translate pages [from, to] of a file (bounded per call); each page stored with its source hash. */
export async function translatePages(principal: Principal, setId: string, input: { fileId?: unknown; from?: unknown; to?: unknown; pageFrom?: unknown; pageTo?: unknown; force?: unknown }, signal?: AbortSignal): Promise<TranslationView & { translated: number; skipped: number; remaining: number }> {
  const set = await loadSet(principal, setId, "write");
  const target = typeof input.to === "string" && LANG_CODES.has(input.to) ? input.to : null;
  const source = input.from === "auto" || input.from == null ? "auto" : typeof input.from === "string" && LANG_CODES.has(input.from) ? input.from : null;
  if (!target || !source) throw new DocsError("Choose a supported language", 422, "invalid");
  if (source === target) throw new DocsError("Source and target languages are the same", 422, "invalid");
  if (source !== "en" && target !== "en" && source !== "auto") throw new DocsError("Translate to or from English", 422, "invalid");
  const { file, pages } = await filePages(set.id, String(input.fileId ?? ""));
  const paged = pages.filter((p) => p.text.trim());
  if (!paged.length) throw new DocsError("This file has no text to translate (scanned pages need OCR first)", 422, "no_text");
  const lo = Number.isInteger(Number(input.pageFrom)) ? Number(input.pageFrom) : null;
  const hi = Number.isInteger(Number(input.pageTo)) ? Number(input.pageTo) : lo;
  const inRange = paged.filter((p) => p.page == null || lo == null || ((p.page ?? 0) >= lo && (p.page ?? 0) <= (hi ?? lo)));
  if (!inRange.length) throw new DocsError("No text on those pages", 422, "invalid");
  const ws = await workStore();
  const glossary = glossaryHints(source === "auto" ? "en" : source, target);
  let translated = 0, skipped = 0;
  const started = Date.now();
  const todo: typeof inRange = [];
  for (const p of inRange) {
    const key = translationKey(file.id, p.page, target);
    const existing = await ws.get<TranslationRecord>(set.id, "translation", key);
    if (existing && existing.data.sourceHash === sha(p.text) && input.force !== true) { skipped++; continue; }
    todo.push(p);
  }
  let done = 0;
  for (const p of todo.slice(0, TRANSLATE_MAX_PAGES)) {
    if (signal?.aborted || Date.now() - started > 200_000) break;
    const text = normalizePageText(p.text).slice(0, TRANSLATE_PAGE_CHARS);
    const res = await generateText({
      instructions: TRANSLATE_INSTRUCTIONS(source, target, glossary),
      input: `${p.page != null ? `[Page ${p.page}]\n` : ""}${text}`,
      // TaskType has no "translate" yet: "draft" routes to the primary model (quality over speed for legal text).
      taskType: "draft", matterId: set.matterId ?? undefined, maxOutputTokens: 8000, signal,
      metadata: { surface: "documents.translate", task: "translate", to: target },
    });
    const out = (res.text ?? "").trim();
    if (!out) continue;
    const rec: TranslationRecord = { fileId: file.id, page: p.page, from: source, to: target, text: out + (p.text.length > TRANSLATE_PAGE_CHARS ? "\n\n[Translation covers the first part of this page only.]" : ""), sourceHash: sha(p.text), model: null, createdAt: now(), createdBy: principal.name || principal.id, label: TRANSLATION_LABEL };
    await ws.put<TranslationRecord>({ setId: set.id, kind: "translation", key: translationKey(file.id, p.page, target), data: rec, textHash: rec.sourceHash, createdBy: principal.id, updatedAt: rec.createdAt });
    translated++; done++;
  }
  if (translated) recordAudit(principal, "ai.generate", { kind: "document_file", id: file.id, label: file.name, matterId: set.matterId ?? undefined }, { surface: "documents.translate", to: target, pages: translated });
  const view = await listTranslations(principal, setId, file.id, target);
  return { ...view, translated, skipped, remaining: Math.max(0, todo.length - done) };
}

// =====================================================================================================================
// Registry defect notices
// =====================================================================================================================

const FORUMS: DefectForum[] = ["sc", "hc", "nclt", "other"];
const CATEGORIES: DefectCategory[] = ["formatting", "missing_documents", "fees", "signatures", "translation", "other"];

export const DEFECT_INSTRUCTIONS = [
  "You classify defects raised by a court registry (Supreme Court, High Court or NCLT) in a filing, for the advocate's office to cure them.",
  "For each numbered defect give: category (formatting, missing_documents, fees, signatures, translation, other); task: a short imperative task (max 12 words); fix: one or two sentences on how to cure it in practice.",
  "Use only what the defect text says; do not assume facts about the filing. Never say a defect is cured.",
].join("\n");

const DEFECT_SCHEMA = {
  type: "object",
  properties: { defects: { type: "array", items: { type: "object", properties: { n: { type: "string" }, category: { type: "string", enum: CATEGORIES }, task: { type: "string" }, fix: { type: "string" } }, required: ["n", "category", "task", "fix"], additionalProperties: false } } },
  required: ["defects"], additionalProperties: false,
} as const;

export async function listDefectNotices(principal: Principal, setId: string): Promise<DefectNotice[]> {
  const set = await loadSet(principal, setId, "read");
  return (await (await workStore()).list<DefectNotice>(set.id, "defects", { limit: 200 })).map((i) => i.data).filter(Boolean);
}

/** Split a pasted / uploaded notice into defects (deterministic), classify (AI when available, keyword rules otherwise). */
export async function createDefectNotice(principal: Principal, setId: string, input: { title?: unknown; forum?: unknown; text?: unknown; fileId?: unknown; useAi?: unknown }, signal?: AbortSignal): Promise<DefectNotice> {
  const set = await loadSet(principal, setId, "write");
  let text = typeof input.text === "string" ? input.text.replace(/\u0000/g, "").slice(0, 60_000) : "";
  let title = str(input.title, 200);
  if (!text.trim() && typeof input.fileId === "string" && input.fileId) {
    const { file, pages } = await filePages(set.id, input.fileId);
    text = pages.map((p) => p.text).join("\n").slice(0, 60_000);
    title = title || file.name;
  }
  if (!text.trim()) throw new DocsError("Paste the defect notice or choose a file", 422, "invalid");
  const items = splitDefects(text).slice(0, 150);
  if (!items.length) throw new DocsError("No defects were found in this text", 422, "invalid");
  const forum = FORUMS.includes(input.forum as DefectForum) ? (input.forum as DefectForum) : "other";
  const defects: Defect[] = items.map((d, i) => ({ id: `def_${i + 1}_${nanoid(6)}`, n: d.n, text: d.text.slice(0, 2000), category: ruleCategory(d.text), classifiedBy: "rule", task: "", fix: "", done: false, doneBy: null, doneAt: null }));
  let aiClassified = false;
  if (input.useAi !== false) {
    try {
      const raw = await generateJSON<{ defects?: { n?: unknown; category?: unknown; task?: unknown; fix?: unknown }[] }>({
        fast: true, taskType: "classify", instructions: DEFECT_INSTRUCTIONS, schema: DEFECT_SCHEMA as unknown as Record<string, unknown>, name: "registry_defects",
        input: `Forum: ${forum.toUpperCase()}\nDefects:\n${defects.map((d) => `${d.n}. ${d.text}`).join("\n")}`,
        matterId: set.matterId ?? undefined, maxOutputTokens: 4000, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(90_000)]) : AbortSignal.timeout(90_000), metadata: { surface: "documents.defects" },
      });
      const byN = new Map((raw?.defects ?? []).map((d) => [String(d.n ?? "").trim().toLowerCase(), d]));
      for (const d of defects) {
        const r = byN.get(d.n.toLowerCase());
        if (!r) continue;
        if (CATEGORIES.includes(r.category as DefectCategory)) { d.category = r.category as DefectCategory; d.classifiedBy = "ai"; }
        d.task = str(r.task, 200);
        d.fix = str(r.fix, 600);
      }
      aiClassified = true;
    } catch (e) {
      if (signal?.aborted) throw e;
      // Keyword rules stand; the notice says AI classification did not run.
    }
  }
  const t = now();
  const notice: DefectNotice = { id: `dn_${nanoid(10)}`, title: title || `Defect notice ${t.slice(0, 10)}`, forum, text, textHash: sha(text), defects, createdAt: t, createdBy: principal.name || principal.id, updatedAt: t, version: 1, aiClassified };
  await (await workStore()).put<DefectNotice>({ setId: set.id, kind: "defects", key: notice.id, data: notice, textHash: notice.textHash, createdBy: principal.id, updatedAt: t });
  return notice;
}

/** Tick a defect done / not done, or correct its category, task or fix (compare-and-set on the notice version). */
export async function updateDefect(principal: Principal, setId: string, noticeId: string, patch: { version?: unknown; defectId?: unknown; done?: unknown; category?: unknown; task?: unknown; fix?: unknown }): Promise<DefectNotice> {
  const set = await loadSet(principal, setId, "write");
  const ws = await workStore();
  const item: WorkItem<DefectNotice> | null = await ws.get<DefectNotice>(set.id, "defects", noticeId);
  if (!item) throw new DocsError("Defect notice not found", 404, "not_found");
  if (Number(patch.version) !== item.data.version) throw conflict();
  const defects = item.data.defects.map((d) => {
    if (d.id !== patch.defectId) return d;
    const x = { ...d };
    if (typeof patch.done === "boolean") { x.done = patch.done; x.doneBy = patch.done ? principal.name || principal.id : null; x.doneAt = patch.done ? now() : null; }
    if (typeof patch.category === "string" && CATEGORIES.includes(patch.category as DefectCategory)) { x.category = patch.category as DefectCategory; x.classifiedBy = "user"; }
    if (typeof patch.task === "string") x.task = str(patch.task, 200);
    if (typeof patch.fix === "string") x.fix = str(patch.fix, 600);
    return x;
  });
  if (!defects.some((d) => d.id === patch.defectId)) throw new DocsError("Defect not found", 404, "not_found");
  const next: DefectNotice = { ...item.data, defects, updatedAt: now(), version: item.data.version + 1 };
  await ws.put<DefectNotice>({ ...item, data: next, updatedAt: next.updatedAt });
  return next;
}

export async function deleteDefectNotice(principal: Principal, setId: string, noticeId: string): Promise<void> {
  const set = await loadSet(principal, setId, "write");
  await (await workStore()).delete(set.id, "defects", noticeId);
}
