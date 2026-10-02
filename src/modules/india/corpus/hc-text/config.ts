import { HIGH_COURTS } from "@/lib/india/courts";

/**
 * Configuration of the High Court PDF text worker (pure; every value comes from the environment with a coded default).
 */

/** The only host PDFs are fetched from: the AWS Open Data bucket `indian-high-court-judgments` (ap-south-1). */
export const HC_PDF_HOST = "indian-high-court-judgments.s3.ap-south-1.amazonaws.com";
export const HC_PDF_PREFIX = `https://${HC_PDF_HOST}/`;

/** Recorded in corpus_texts.dataset_version for every chunk this worker writes (never used by Open India Law rows). */
export const PDF_TEXT_VERSION_PREFIX = "aws-hc-pdf";
/** Bump when the chunking / scrubbing of PDF text changes (recorded per judgment). */
export const HC_TEXT_PIPELINE_VERSION = 1;
export const pdfTextVersion = (extractorVersion: number) => `${PDF_TEXT_VERSION_PREFIX}:x${extractorVersion}.p${HC_TEXT_PIPELINE_VERSION}`;

/** Priority High Courts (registry ids), in order; every other High Court follows in registry order. */
export const PRIORITY_COURTS = ["hc-delhi", "hc-bombay", "hc-madras", "hc-allahabad", "hc-ph", "hc-karnataka", "hc-calcutta", "hc-gujarat", "hc-kerala"] as const;

export function courtOrder(): string[] {
  const rest = HIGH_COURTS.map((c) => c.id).filter((id) => !(PRIORITY_COURTS as readonly string[]).includes(id));
  return [...PRIORITY_COURTS, ...rest];
}

type Env = Readonly<Record<string, string | undefined>>;

function int(v: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(v);
  return v != null && v.trim() !== "" && Number.isFinite(n) && n >= min ? Math.min(Math.floor(n), max) : fallback;
}

const on = (v: string | undefined) => ["1", "true", "yes", "on"].includes((v ?? "").trim().toLowerCase());
const off = (v: string | undefined) => ["0", "false", "no", "off"].includes((v ?? "").trim().toLowerCase());

export interface HcTextConfig {
  /** HC_TEXT_INGEST=1: the scheduled run works; otherwise the cron answers "disabled". */
  enabled: boolean;
  /** HC_TEXT_RECENT_FROM (default 2016): years from here to now are done first, then older years. */
  recentFrom: number;
  /** HC_TEXT_OLDEST_YEAR (default 1950): the oldest year scheduled. */
  oldestYear: number;
  /** HC_TEXT_CONCURRENCY (1–16, default 4): workers per run. */
  concurrency: number;
  /** HC_TEXT_LIMIT_PER_RUN (default 300): judgments processed per run at most. */
  limitPerRun: number;
  /** HC_TEXT_ENQUEUE_PER_RUN (default 500): judgments queued per run when the queue runs low. */
  enqueuePerRun: number;
  /** HC_TEXT_HOST_RPS (default 4) / burst: requests per second to the bucket. */
  hostRps: number;
  hostBurst: number;
  /** HC_TEXT_MAX_PDF_MB (default 25): larger PDFs are refused (recorded as failed, never truncated). */
  maxPdfBytes: number;
  /** HC_TEXT_FETCH_TIMEOUT_MS (default 60 s). */
  fetchTimeoutMs: number;
  /** HC_TEXT_OCR (default on; 0 disables): OCR of pages without a usable text layer. */
  ocr: boolean;
  /** HC_TEXT_OCR_MAX_PAGES (default 40): documents needing more OCR pages are not OCR'd (text layer kept as partial). */
  ocrMaxPages: number;
  /** HC_TEXT_OCR_CONCURRENCY (default 3): OCR requests in flight per document. */
  ocrConcurrency: number;
  /** HC_TEXT_OCR_MODEL, else OFFICIAL_OCR_MODEL, else the runtime's fast vision model. */
  ocrModel: string | null;
  /** HC_TEXT_MAX_DB_MB, else OFFICIAL_MAX_DB_MB, else 60,000: the run stops ("budget") at this database size. */
  maxDbBytes: number;
}

export function hcTextConfig(env: Env = process.env): HcTextConfig {
  const year = new Date().getUTCFullYear();
  const dbMb = int(env.HC_TEXT_MAX_DB_MB, int(env.OFFICIAL_MAX_DB_MB, 60_000, 1, 10_000_000), 1, 10_000_000);
  return {
    enabled: on(env.HC_TEXT_INGEST),
    recentFrom: int(env.HC_TEXT_RECENT_FROM, 2016, 1900, year),
    oldestYear: int(env.HC_TEXT_OLDEST_YEAR, 1950, 1860, year),
    concurrency: int(env.HC_TEXT_CONCURRENCY, 4, 1, 16),
    limitPerRun: int(env.HC_TEXT_LIMIT_PER_RUN, 300, 1, 10_000),
    enqueuePerRun: int(env.HC_TEXT_ENQUEUE_PER_RUN, 500, 1, 20_000),
    hostRps: int(env.HC_TEXT_HOST_RPS, 4, 1, 50),
    hostBurst: int(env.HC_TEXT_HOST_BURST, 8, 1, 100),
    maxPdfBytes: int(env.HC_TEXT_MAX_PDF_MB, 25, 1, 200) * 1024 * 1024,
    fetchTimeoutMs: int(env.HC_TEXT_FETCH_TIMEOUT_MS, 60_000, 5_000, 240_000),
    ocr: !off(env.HC_TEXT_OCR),
    ocrMaxPages: int(env.HC_TEXT_OCR_MAX_PAGES, 40, 1, 2_000),
    ocrConcurrency: int(env.HC_TEXT_OCR_CONCURRENCY, 3, 1, 16),
    ocrModel: env.HC_TEXT_OCR_MODEL?.trim() || env.OFFICIAL_OCR_MODEL?.trim() || null,
    maxDbBytes: dbMb * 1024 * 1024,
  };
}

/** True only for an https URL on exactly HC_PDF_HOST (no port, no credentials). */
export function allowedPdfUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname.toLowerCase() === HC_PDF_HOST && u.port === "" && !u.username && !u.password;
  } catch {
    return false;
  }
}
