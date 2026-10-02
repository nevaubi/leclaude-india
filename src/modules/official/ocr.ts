import "server-only";
import { PDFDocument } from "pdf-lib";
import { generateText } from "@/lib/ai/agent";
import { aiConfig } from "@/lib/ai/config";
import { mapPool } from "@/modules/india/sources/http";
import { splitPageMarkdown, type PageText } from "./extract";

/**
 * OCR of scanned pages with the configured vision-capable model, through the provider-neutral runtime
 * (generateText with a PDF `document` part: OpenAI input_file, Anthropic/Bedrock document block).
 *
 * - Only pages that failed the text-layer readability gate are sent (never a page with a good text layer).
 * - The PDF is split with pdf-lib into contiguous ranges of ≤ 6 pages; each range is one request asking for a VERBATIM
 *   markdown transcription (no translation, no summary) with `<!-- page N -->` markers carrying the ORIGINAL page
 *   numbers. A response whose markers do not match the requested pages exactly is not guessed apart: the range is
 *   retried one page per request.
 * - Bounded concurrency (OFFICIAL_OCR_CONCURRENCY, default 4) and a per-document page cap (OFFICIAL_OCR_MAX_PAGES,
 *   default 80): a document needing more pages is not OCR'd at all here (`capped`), never silently truncated.
 * - A transcription the model did not finish (stop reason other than a normal end, e.g. the output-token limit) is never
 *   accepted: a range is retried one page per request (with a larger budget); a single page still cut off is failed
 *   ("transcription cut off"), never indexed as if complete.
 * - The source PDF is parsed once per call; every range is copied out of it.
 * - Stops starting new requests `OCR_STOP_BEFORE_DEADLINE_MS` before the deadline; in-flight requests end with the abort
 *   signal. Progress is reported after every range (`onProgress`) so a killed or aborted run loses at most the ranges
 *   in flight; the unit resumes from the pages already done (`complete: false`).
 * OCR text is model output: callers label it (`extraction: ocr_model`, `ocr_pages`) and quotes must be checked against
 * the PDF before filing.
 */

export const OCR_RANGE_PAGES = 6;
export const DEFAULT_OCR_CONCURRENCY = 4;
export const DEFAULT_OCR_MAX_PAGES = 80;
/** No OCR request starts with less than this before the deadline (a 6-page range can take a minute or more). */
export const OCR_STOP_BEFORE_DEADLINE_MS = 90_000;
/** Output budget per page in a range, and for a page retried on its own. */
export const OCR_TOKENS_PER_PAGE = 4_000;
export const OCR_TOKENS_SINGLE_PAGE = 8_000;

export function ocrConcurrency(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const n = Number(env.OFFICIAL_OCR_CONCURRENCY);
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), 16) : DEFAULT_OCR_CONCURRENCY;
}

export function ocrMaxPages(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const n = Number(env.OFFICIAL_OCR_MAX_PAGES);
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), 2_000) : DEFAULT_OCR_MAX_PAGES;
}

export function ocrPrompt(pages: number[]): string {
  const list = pages.length === 1 ? `page ${pages[0]}` : `pages ${pages.join(", ")}`;
  return [
    "Transcribe this official Indian court / government document (a public record) VERBATIM as markdown.",
    "Rules:",
    "- Copy the text exactly in reading order. Do not translate: keep Hindi and other Indian-language text in its original script.",
    "- Do not summarise, explain, correct, complete or add anything. Keep numbers, dates, case numbers, names and punctuation exactly as printed.",
    "- Render tables as markdown tables and headings as markdown headings. Write [illegible] for text you cannot read.",
    `- The attached PDF contains ${list} of the original document, in this order. Start each page with the marker <!-- page N --> on its own line, where N is the ORIGINAL page number listed here (not the position in the attachment).`,
    "- Output only the transcription.",
  ].join("\n");
}

export interface OcrRequest {
  /** Base64 PDF containing exactly `pages` (original numbers, in order). */
  pdfBase64: string;
  pages: number[];
  signal?: AbortSignal;
}

/** A transcription and why the model stopped ("end" = finished; "max_tokens" = cut off at the output limit). */
export interface OcrTranscription {
  text: string;
  /** Provider-neutral stop reason; absent when the model does not report one (treated as finished). */
  stopReason?: string | null;
}

export interface OcrModel {
  /** Model id recorded as ocr_model. */
  id: string;
  /** A plain string is a finished transcription (models that do not report a stop reason). */
  transcribe(req: OcrRequest): Promise<string | OcrTranscription>;
}

const FINISHED = new Set(["end", "stop", "end_turn", "stop_sequence"]);

/** Normalise a model answer; `complete` is false when the model reported any stop other than a normal end. */
export function transcriptionOf(r: string | OcrTranscription): { text: string; complete: boolean; stopReason: string | null } {
  if (typeof r === "string") return { text: r, complete: true, stopReason: null };
  const stop = r.stopReason ?? null;
  return { text: String(r.text ?? ""), complete: stop == null || FINISHED.has(stop), stopReason: stop };
}

/** The runtime's fast vision-capable model (or OFFICIAL_OCR_MODEL). Throws AIConfigError when no model is configured. */
export function defaultOcrModel(env: Readonly<Record<string, string | undefined>> = process.env): OcrModel {
  const explicit = env.OFFICIAL_OCR_MODEL?.trim() || undefined;
  const cfg = aiConfig();
  const id = explicit ?? cfg.fastModel;
  return {
    id,
    async transcribe(req) {
      const first = req.pages[0];
      const last = req.pages[req.pages.length - 1];
      const r = await generateText({
        model: explicit,
        fast: !explicit,
        taskType: "vision",
        privacy: "internal",
        reasoningEffort: "low",
        maxOutputTokens: req.pages.length === 1 ? OCR_TOKENS_SINGLE_PAGE : OCR_TOKENS_PER_PAGE * req.pages.length,
        signal: req.signal,
        metadata: { purpose: "official_ocr" },
        input: [{
          role: "user",
          content: [
            { type: "input_text", text: ocrPrompt(req.pages) },
            { type: "input_file", filename: `pages-${first}-${last}.pdf`, file_data: `data:application/pdf;base64,${req.pdfBase64}` },
          ],
        }],
      });
      return { text: r.text, stopReason: r.stopReason ?? null };
    },
  };
}

/** Group sorted page numbers into contiguous runs of at most `size` pages. */
export function groupPages(pages: number[], size = OCR_RANGE_PAGES): number[][] {
  const sorted = [...new Set(pages)].filter((p) => Number.isInteger(p) && p > 0).sort((a, b) => a - b);
  const out: number[][] = [];
  let cur: number[] = [];
  for (const p of sorted) {
    if (cur.length && (p !== cur[cur.length - 1] + 1 || cur.length >= size)) { out.push(cur); cur = []; }
    cur.push(p);
  }
  if (cur.length) out.push(cur);
  return out;
}

/** A PDF containing only the given (1-based) pages of `bytes`, in order. */
export async function slicePdf(bytes: Uint8Array, pages: number[]): Promise<Uint8Array> {
  return sliceLoaded(await loadPdf(bytes), pages);
}

function loadPdf(bytes: Uint8Array): Promise<PDFDocument> {
  return PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
}

async function sliceLoaded(src: PDFDocument, pages: number[]): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  const copied = await out.copyPages(src, pages.map((p) => p - 1));
  for (const p of copied) out.addPage(p);
  return out.save({ useObjectStreams: true });
}

function stripFence(s: string): string {
  const t = s.trim();
  const m = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n?```$/i.exec(t);
  return (m ? m[1] : t).trim();
}

/**
 * Map a transcription to its pages. Each requested page must appear exactly once (by its original number) and no other
 * page may appear; otherwise null (never guess where one page ends). A single-page request without markers is accepted.
 */
export function parseOcrResponse(text: string, pages: number[]): Map<number, string> | null {
  const body = stripFence(text);
  const segs = splitPageMarkdown(body);
  const marked = segs.filter((s) => s.page != null);
  if (!marked.length) {
    if (pages.length === 1 && body.trim()) return new Map([[pages[0], body.trim()]]);
    return null;
  }
  const lead = segs.find((s) => s.page == null);
  if (lead && lead.text.trim().length > 40) return null; // substantial text outside any page marker
  const want = new Set(pages);
  const out = new Map<number, string>();
  for (const s of marked) {
    if (!want.has(s.page!) || out.has(s.page!)) return null;
    out.set(s.page!, s.text.trim());
  }
  if (out.size !== want.size) return null;
  return out;
}

export interface OcrDocumentResult {
  model: string;
  /** Pages transcribed (1-based, sorted). */
  pages: PageText[];
  failed: { page: number; error: string }[];
  /** False when the deadline stopped the work before every page was attempted. */
  complete: boolean;
  /** True when the document needs more pages than the cap allows (nothing was sent). */
  capped: boolean;
  requests: number;
}

export interface OcrOptions {
  model?: OcrModel;
  concurrency?: number;
  maxPages?: number;
  /** Epoch ms; no request starts after `deadline - OCR_STOP_BEFORE_DEADLINE_MS`. */
  deadline?: number;
  now?: () => number;
  signal?: AbortSignal;
  /** Pages already transcribed (resume): not sent again. */
  done?: Record<string, string>;
  /** Called after each request with the pages it transcribed (callers persist progress). */
  onProgress?: (pages: PageText[]) => void | Promise<void>;
}

const CUT_OFF = "transcription cut off (output token limit reached)";

/** OCR the given pages of a PDF (see module notes). */
export async function ocrDocument(bytes: Uint8Array, pages: number[], opts: OcrOptions = {}): Promise<OcrDocumentResult> {
  const cap = opts.maxPages ?? ocrMaxPages();
  const wanted = [...new Set(pages)].sort((a, b) => a - b);
  if (wanted.length > cap) return { model: opts.model?.id ?? "", pages: [], failed: [], complete: false, capped: true, requests: 0 };
  const model = opts.model ?? defaultOcrModel();
  const result: OcrDocumentResult = { model: model.id, pages: [], failed: [], complete: true, capped: false, requests: 0 };
  const now = opts.now ?? Date.now;
  const got = new Map<number, string>();
  for (const [k, v] of Object.entries(opts.done ?? {})) if (wanted.includes(Number(k))) got.set(Number(k), v);
  const todo = groupPages(wanted.filter((p) => !got.has(p)));
  const late = () => (opts.deadline != null && now() > opts.deadline - OCR_STOP_BEFORE_DEADLINE_MS) || opts.signal?.aborted === true;
  let src: PDFDocument | null = null;
  const source = async () => (src ??= await loadPdf(bytes));

  /** Pages of a finished transcription; null when markers do not match; "cut" when the model did not finish. */
  const request = async (range: number[]): Promise<Map<number, string> | null | "cut"> => {
    const pdf = await sliceLoaded(await source(), range);
    result.requests++;
    const t = transcriptionOf(await model.transcribe({ pdfBase64: Buffer.from(pdf).toString("base64"), pages: range, signal: opts.signal }));
    if (!t.complete) return "cut";
    return parseOcrResponse(t.text, range);
  };
  const progress = async (map: Map<number, string>) => {
    for (const [p, t] of map) got.set(p, t);
    if (opts.onProgress) await opts.onProgress([...map.entries()].map(([page, text]) => ({ page, text })));
  };

  await mapPool(todo, Math.max(1, Math.min(opts.concurrency ?? ocrConcurrency(), 16)), async (range) => {
    if (late()) { result.complete = false; return; }
    try {
      const parsed = await request(range);
      if (parsed && parsed !== "cut") { await progress(parsed); return; }
      if (range.length === 1) { result.failed.push({ page: range[0], error: parsed === "cut" ? CUT_OFF : "transcription had no usable page marker" }); return; }
      // Markers did not match the requested pages, or the answer was cut off: one page per request (never split a
      // response by guesswork, never keep a page from an unfinished answer).
      for (const p of range) {
        if (late()) { result.complete = false; return; }
        try {
          const one = await request([p]);
          if (one === "cut") result.failed.push({ page: p, error: CUT_OFF });
          else if (one?.has(p)) await progress(new Map([[p, one.get(p)!]]));
          else result.failed.push({ page: p, error: "transcription had no usable page marker" });
        } catch (e) {
          if (opts.signal?.aborted) { result.complete = false; return; }
          result.failed.push({ page: p, error: (e as Error).message.slice(0, 300) });
        }
      }
    } catch (e) {
      // An aborted run (deadline) is not a page failure: the pages are simply not done yet.
      if (opts.signal?.aborted) { result.complete = false; return; }
      for (const p of range) result.failed.push({ page: p, error: (e as Error).message.slice(0, 300) });
    }
  }).catch((e: unknown) => {
    if (!opts.signal?.aborted) throw e;
    result.complete = false;
  });

  result.pages = [...got.entries()].sort((a, b) => a[0] - b[0]).map(([page, text]) => ({ page, text }));
  result.failed.sort((a, b) => a.page - b.page);
  if (result.pages.length + result.failed.length < wanted.length) result.complete = false;
  return result;
}
