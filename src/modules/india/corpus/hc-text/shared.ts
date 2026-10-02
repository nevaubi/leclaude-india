/**
 * Client-safe types and helpers for the High Court text coverage dashboard (no server imports).
 */

export interface HcCoverageYear {
  courtId: string;
  year: number | null;
  judgments: number;
  withText: number;
  openIndiaLaw: number;
  pdfText: number;
  ocr: number;
  partial: number;
  failed: number;
  metadataOnly: number;
  lastUpdate: string | null;
  /** When the counts were computed (coverage summary); null for a live count. */
  refreshedAt?: string | null;
}

export interface HcCoverageTotals {
  judgments: number;
  withText: number;
  openIndiaLaw: number;
  pdfText: number;
  ocr: number;
  partial: number;
  failed: number;
  metadataOnly: number;
  lastUpdate: string | null;
}

export interface HcCoverageCourt {
  courtId: string;
  name: string;
  shortName: string;
  /** Position in the worker's court order (priority courts first). */
  priority: number;
  /** Oldest summary time among the court's rows (null for live counts). */
  countedAt: string | null;
  totals: HcCoverageTotals;
  /** Newest year first. */
  years: HcCoverageYear[];
}

export interface HcCoverage {
  configured: boolean;
  courts: HcCoverageCourt[];
  totals: HcCoverageTotals;
  queue: { pending: number; running: number; done: number; skipped: number; failed: number } | null;
  checkedAt: string | null;
  /** The latest refresh failed; an earlier summary is shown. */
  stale: boolean;
  dbBytes: number | null;
  limitBytes: number | null;
  /** HC_TEXT_INGEST is on for this deployment. */
  ingestEnabled: boolean;
}

/** Share with text, 0–100 (one decimal), or null when there are no records. */
export function textShare(t: Pick<HcCoverageTotals, "judgments" | "withText">): number | null {
  if (!t.judgments) return null;
  return Math.round((t.withText / t.judgments) * 1000) / 10;
}

/** Years to show for a court: `from`..`to` inclusive (newest first); records without a year are listed last. */
export function yearsInRange(years: HcCoverageYear[], from: number | null, to: number | null): HcCoverageYear[] {
  return years.filter((y) => (y.year == null ? from == null : (from == null || y.year >= from) && (to == null || y.year <= to)));
}

export function sumYears(years: HcCoverageYear[]): HcCoverageTotals {
  const t: HcCoverageTotals = { judgments: 0, withText: 0, openIndiaLaw: 0, pdfText: 0, ocr: 0, partial: 0, failed: 0, metadataOnly: 0, lastUpdate: null };
  for (const y of years) {
    t.judgments += y.judgments; t.withText += y.withText; t.openIndiaLaw += y.openIndiaLaw; t.pdfText += y.pdfText; t.ocr += y.ocr;
    t.partial += y.partial; t.failed += y.failed; t.metadataOnly += y.metadataOnly;
    if (y.lastUpdate && (!t.lastUpdate || y.lastUpdate > t.lastUpdate)) t.lastUpdate = y.lastUpdate;
  }
  return t;
}
