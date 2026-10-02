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
 * - Stops scheduling new requests at the deadline and returns what is done (`complete: false`) so the unit can resume.
 * OCR text is model output: callers label it (`extraction: ocr_model`, `ocr_pages`) and quotes must be checked against
 * the PDF before filing.
 */

export const OCR_RANGE_PAGES = 6;
export const DEFAULT_OCR_CONCURRENCY = 4;
export const DEFAULT_OCR_MAX_PAGES = 80;

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

export interface OcrModel {
  /** Model id recorded as ocr_model. */
  id: string;
  transcribe(req: OcrRequest): Promise<string>;
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
        maxOutputTokens: 4_000 * req.pages.length,
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
      return r.text;
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
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
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
  /** Epoch ms; no request starts after `deadline - 30s`. */
  deadline?: number;
  now?: () => number;
  signal?: AbortSignal;
  /** Pages already transcribed (resume): not sent again. */
  done?: Record<string, string>;
}

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
  const late = () => opts.deadline != null && now() > opts.deadline - 30_000;

  const request = async (range: number[]): Promise<Map<number, string> | null> => {
    const pdf = await slicePdf(bytes, range);
    result.requests++;
    const text = await model.transcribe({ pdfBase64: Buffer.from(pdf).toString("base64"), pages: range, signal: opts.signal });
    return parseOcrResponse(text, range);
  };

  await mapPool(todo, Math.max(1, Math.min(opts.concurrency ?? ocrConcurrency(), 16)), async (range) => {
    if (late()) { result.complete = false; return; }
    try {
      const parsed = await request(range);
      if (parsed) { for (const [p, t] of parsed) got.set(p, t); return; }
      if (range.length === 1) { result.failed.push({ page: range[0], error: "transcription had no usable page marker" }); return; }
      // Markers did not match the requested pages: one page per request (never split a response by guesswork).
      for (const p of range) {
        if (late()) { result.complete = false; return; }
        try {
          const one = await request([p]);
          if (one?.has(p)) got.set(p, one.get(p)!);
          else result.failed.push({ page: p, error: "transcription had no usable page marker" });
        } catch (e) {
          result.failed.push({ page: p, error: (e as Error).message.slice(0, 300) });
        }
      }
    } catch (e) {
      for (const p of range) result.failed.push({ page: p, error: (e as Error).message.slice(0, 300) });
    }
  }, opts.signal);

  result.pages = [...got.entries()].sort((a, b) => a[0] - b[0]).map(([page, text]) => ({ page, text }));
  result.failed.sort((a, b) => a.page - b.page);
  if (result.pages.length + result.failed.length < wanted.length) result.complete = false;
  return result;
}
