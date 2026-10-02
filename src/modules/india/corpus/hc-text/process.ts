import "server-only";
import { AIConfigError } from "@/lib/ai/config";
import { scrubPersonalData, sha256Hex } from "@/modules/official/chunk";
import { EXTRACTOR_VERSION, type ExtractedDocument, type PageText } from "@/modules/official/extract";
import { type OcrDocumentResult, type OcrModel, type OcrOptions } from "@/modules/official/ocr";
import type { BlobStore } from "./blob-store";
import { chunkJudgmentPages } from "./chunk";
import { allowedPdfUrl, HC_TEXT_PIPELINE_VERSION, pdfTextVersion, type HcTextConfig } from "./config";
import type { PdfFetcher } from "./fetch";
import type { HcTextRepo, HcUnit, PdfTextResult, Provenance, UnitPayload } from "./repo";

/**
 * One judgment: PDF → text layer → OCR of pages without a usable text layer → scrub → chunks with page numbers →
 * corpus_texts + text_status, with provenance on the unit. Deterministic except for OCR (labelled as such).
 *
 * Outcomes (unit status / record text_status):
 *   done      full_text | ocr | partial   text stored (partial: some pages missing — OCR capped, off, unavailable or failed)
 *   skipped   Open India Law text exists, the record already has text, another record with the same CNR + date has
 *             PDF text, the URL is not on the bucket host, or the record lacks a CNR / date (never substituted)
 *   failed    PDF missing (404/403), larger than the cap, not a PDF, unreadable or without any text → text_status failed
 *   released  the run's deadline came first (attempt given back; OCR progress kept on the unit)
 *   retry     a transient fetch failure (backoff)
 */

export const MAX_ATTEMPTS = 5;
export const LEASE_MINUTES = 10;
/** An OCR phase is not started with less than this left before the deadline. */
export const OCR_MIN_MS = 120_000;
/** A record whose scanned pages cannot be OCR'd now (no model configured) and has no text layer waits this long. */
export const OCR_UNAVAILABLE_DEFER_S = 6 * 3600;

const CNR_RE = /^[A-Z]{4}\d{12}$/;

export type ProcessResult = PdfTextResult | "skipped" | "released" | "retry" | "deferred";

export interface ProcessOutcome {
  result: ProcessResult;
  note?: string;
  error?: string;
  ocrPages?: number;
}

export interface ProcessDeps {
  repo: HcTextRepo;
  config: HcTextConfig;
  fetchPdf: PdfFetcher;
  extract: (bytes: Uint8Array) => Promise<ExtractedDocument>;
  ocr: (bytes: Uint8Array, pages: number[], opts: OcrOptions) => Promise<OcrDocumentResult>;
  /** Throws AIConfigError when no model is configured. */
  ocrModel: () => OcrModel;
  blobStore: BlobStore;
  deadline: number;
  now: () => number;
  signal?: AbortSignal;
  ocrMinMs?: number;
  log?: (event: string, data: Record<string, unknown>) => void;
}

/** Seconds until just after this run's deadline (a unit handed back for lack of time is not claimed again by this run). */
function afterDeadlineS(deps: ProcessDeps): number {
  return Math.max(1, Math.ceil((deps.deadline - deps.now()) / 1000) + 5);
}

function scrubText(s: string): string {
  return scrubPersonalData(s.replace(/\u0000/g, "")).text;
}

async function failPermanently(deps: ProcessDeps, unit: HcUnit, error: string, prov: Partial<Provenance> = {}): Promise<ProcessOutcome> {
  await deps.repo.finish(unit.judgmentId, "failed", { ...prov, result: "failed", error });
  await deps.repo.markJudgmentFailed(unit.judgmentId);
  return { result: "failed", error };
}

async function skip(deps: ProcessDeps, unit: HcUnit, note: string, prov: Partial<Provenance> = {}): Promise<ProcessOutcome> {
  await deps.repo.finish(unit.judgmentId, "skipped", { ...prov, result: "skipped", note });
  return { result: "skipped", note };
}

export async function processHcUnit(unit: HcUnit, deps: ProcessDeps): Promise<ProcessOutcome> {
  const { repo, config } = deps;
  const aborted = () => deps.signal?.aborted === true;

  const j = await repo.judgment(unit.judgmentId);
  if (!j) return skip(deps, unit, "the judgment record no longer exists");
  if (j.textStatus === "full") return skip(deps, unit, "Open India Law text present (text_status full); PDF text not extracted", { oilText: true });
  const cnr = (j.cnr ?? "").toUpperCase();
  const date = j.decisionDate;
  if (!CNR_RE.test(cnr) || !date) return skip(deps, unit, "record has no CNR or decision date: text could not be linked by identity");
  if (await repo.openIndiaLawText(cnr, date)) return skip(deps, unit, "Open India Law text exists for this CNR and date; PDF text not extracted", { oilText: true });
  const url = j.pdfUrl ?? unit.pdfUrl;
  if (!allowedPdfUrl(url)) return skip(deps, unit, "PDF URL is not on the indian-high-court-judgments bucket host; not fetched");

  // ---- fetch ----
  let fetched;
  try {
    fetched = await deps.fetchPdf(url!, { signal: deps.signal });
  } catch (e) {
    if (aborted()) { await repo.release(unit.judgmentId, "run ended during the PDF download"); return { result: "released" }; }
    throw e;
  }
  if (!fetched.ok) {
    const f = fetched.failure;
    if (f.kind === "host_not_allowed") return skip(deps, unit, f.message, { sourceUrl: url });
    if (f.kind === "transient") {
      if (aborted()) { await repo.release(unit.judgmentId, "run ended during the PDF download"); return { result: "released" }; }
      if (unit.attempts >= MAX_ATTEMPTS) return failPermanently(deps, unit, `PDF download failed ${unit.attempts} times: ${f.message}`, { sourceUrl: url });
      await repo.retry(unit.judgmentId, f.message, Math.min(60, 2 ** Math.max(0, unit.attempts)));
      return { result: "retry", error: f.message };
    }
    return failPermanently(deps, unit, f.kind === "not_found" ? `PDF not in the bucket (${f.message})` : f.message, { sourceUrl: url });
  }
  const bytes = fetched.bytes;
  const sha256 = sha256Hex(bytes);
  const base: Partial<Provenance> = { sourceUrl: fetched.finalUrl, sha256, bytes: bytes.byteLength, extractorVersion: EXTRACTOR_VERSION, pipelineVersion: HC_TEXT_PIPELINE_VERSION };
  if (deps.blobStore.configured) {
    try { await deps.blobStore.put(`hc-pdf/${sha256}.pdf`, bytes, "application/pdf"); } catch (e) { deps.log?.("hc_text.blob_failed", { judgmentId: unit.judgmentId, error: (e as Error).message.slice(0, 200) }); }
  }

  // ---- text layer ----
  let ex: ExtractedDocument;
  try {
    ex = await deps.extract(bytes);
  } catch (e) {
    return failPermanently(deps, unit, `PDF could not be read: ${(e as Error).message.slice(0, 200)}`, base);
  }
  if (aborted()) { await repo.release(unit.judgmentId, "run ended during text extraction"); return { result: "released" }; }
  const pageCount = ex.pageCount ?? ex.pages.length;
  const textPages: PageText[] = ex.pages.filter((p) => p.text.trim()).map((p) => ({ page: p.page, text: p.text }));
  const wanted = [...new Set(ex.ocrPages)].sort((a, b) => a - b);
  if (!textPages.length && !wanted.length) return failPermanently(deps, unit, ex.warning ?? "the PDF has no text layer and no scanned pages", { ...base, pages: pageCount, textPages: 0 });
  const prov: Partial<Provenance> = { ...base, pages: pageCount, textPages: textPages.length };

  // ---- OCR ----
  let ocrText: PageText[] = [];
  let missing: number[] = [];
  let ocrModelId: string | null = null;
  const notes: string[] = [];
  if (ex.truncated) notes.push(ex.warning ?? "text cut at the extraction limit");
  if (wanted.length) {
    if (!config.ocr) { missing = wanted; notes.push(`${wanted.length} scanned page(s) not OCR'd (HC_TEXT_OCR=0)`); }
    else if (wanted.length > config.ocrMaxPages) { missing = wanted; notes.push(`${wanted.length} page(s) need OCR, above the cap of ${config.ocrMaxPages} (HC_TEXT_OCR_MAX_PAGES)`); }
    else {
      let model: OcrModel | null = null;
      try { model = deps.ocrModel(); } catch (e) {
        if (!(e instanceof AIConfigError)) throw e;
        if (!textPages.length) {
          await repo.defer(unit.judgmentId, OCR_UNAVAILABLE_DEFER_S, "scanned PDF waits for an OCR model (no model provider configured)");
          return { result: "deferred", note: "OCR model not configured" };
        }
        missing = wanted;
        notes.push(`${wanted.length} scanned page(s) not OCR'd: no OCR model configured`);
      }
      if (model) {
        const prior = unit.payload?.sha256 === sha256 ? unit.payload.ocrDone ?? {} : {};
        if (deps.deadline - deps.now() < (deps.ocrMinMs ?? OCR_MIN_MS)) {
          // Deferred past this run's deadline (not merely released): otherwise this run would claim it again at once.
          await repo.defer(unit.judgmentId, afterDeadlineS(deps), "too little run time left to OCR; resumes in a later run", { sha256, ocrDone: prior, ocrModel: model.id });
          return { result: "released" };
        }
        const progress: UnitPayload = { sha256, ocrDone: { ...prior }, ocrModel: model.id };
        const res = await deps.ocr(bytes, wanted, {
          model, maxPages: config.ocrMaxPages, concurrency: config.ocrConcurrency, deadline: deps.deadline, now: deps.now, signal: deps.signal, done: prior,
          onProgress: async (pages) => {
            for (const p of pages) progress.ocrDone![String(p.page)] = scrubText(p.text);
            await repo.saveProgress(unit.judgmentId, progress);
          },
        });
        ocrModelId = res.model || model.id;
        if (res.capped) { missing = wanted; notes.push(`${wanted.length} page(s) need OCR, above the cap`); }
        else if (!res.complete) {
          // ocrDocument stops starting requests near the deadline (or on abort): not a page failure, the rest resumes.
          for (const p of res.pages) progress.ocrDone![String(p.page)] = scrubText(p.text);
          await repo.defer(unit.judgmentId, afterDeadlineS(deps), `OCR stopped at the run deadline (${res.pages.length}/${wanted.length} page(s) done); resumes in a later run`, progress);
          return { result: "released", ocrPages: res.pages.length };
        } else {
          ocrText = res.pages.filter((p) => p.text.trim());
          const done = new Set(ocrText.map((p) => p.page));
          missing = wanted.filter((p) => !done.has(p));
          if (res.failed.length) notes.push(`OCR failed on ${res.failed.length} page(s): ${res.failed.slice(0, 3).map((f) => `p. ${f.page} ${f.error.slice(0, 60)}`).join("; ")}`);
          else if (missing.length) notes.push(`${missing.length} page(s) came back empty from OCR`);
        }
      }
    }
  }

  const all = [...textPages, ...ocrText];
  if (!all.length) return failPermanently(deps, unit, notes.join("; ") || "no text could be read from the PDF", { ...prov, ocrModel: ocrModelId, ocrFailedPages: missing });
  const status: Exclude<PdfTextResult, "failed"> = missing.length || ex.truncated ? "partial" : ocrText.length ? "ocr" : "full_text";
  const chunked = chunkJudgmentPages(all, ocrText.map((p) => p.page));
  const datasetVersion = pdfTextVersion(EXTRACTOR_VERSION);
  const stored = await repo.storeText({ judgmentId: j.id, courtId: j.courtId ?? unit.courtId, cnr, decisionDate: date, title: j.title, caseNumber: j.caseNumber, status, datasetVersion, chunks: chunked.chunks });
  const full: Partial<Provenance> = {
    ...prov, ocrPages: ocrText.map((p) => p.page), ocrFailedPages: missing, ocrModel: ocrModelId, datasetVersion, chunks: chunked.chunks.length, chars: chunked.chars,
  };
  if (!stored.stored) {
    const why = {
      open_india_law: "Open India Law text appeared for this CNR and date; it is kept and the PDF text was not stored",
      record_has_text: "the record already has Open India Law text (text_status full); the PDF text was not stored",
      duplicate: "another record with the same CNR and decision date already has PDF text; not stored twice",
      record_missing: "the judgment record no longer exists",
    }[stored.reason];
    return skip(deps, unit, why, { ...full, chunks: 0, oilText: stored.reason === "open_india_law" || stored.reason === "record_has_text" });
  }
  if (chunked.redactions.phones || chunked.redactions.emails || chunked.redactions.links) notes.push(`contact data removed: ${chunked.redactions.phones} phone(s), ${chunked.redactions.emails} e-mail(s), ${chunked.redactions.links} link(s)`);
  await repo.finish(unit.judgmentId, "done", { ...full, result: status, note: notes.join("; ") || null });
  deps.log?.("hc_text.stored", { judgmentId: j.id, courtId: j.courtId, status, pages: pageCount, ocrPages: ocrText.length, missing: missing.length, chunks: chunked.chunks.length });
  return { result: status, ocrPages: ocrText.length, note: notes.join("; ") || undefined };
}
