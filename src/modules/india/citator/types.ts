/**
 * Citator response shapes (client-safe). Every treatment field is a TEXT CUE found by deterministic rules in a citing
 * judgment's sentence, never a verified treatment; "good law" is never asserted.
 */
import type { TreatmentSignal } from "./signals";

export type CitationResolution = "resolved" | "unresolved" | "ambiguous";

export interface CiteEntry {
  seq: number;
  raw: string;
  key: string;
  resolution: CitationResolution;
  /** Corpus judgment id when exactly one judgment carries the citation. */
  citedId: string | null;
  /** How many judgments carry the citation (ambiguous: >1, none chosen). */
  candidates: number;
  title: string | null;
  courtId: string | null;
  court: string | null;
  decisionDate: string | null;
  page: number | null;
  context: string | null;
  signal: TreatmentSignal | null;
  cue: string | null;
  occurrences: number;
}

export interface StatuteEntry { key: string; raw: string; actId: string | null; section: string | null; occurrences: number }

export interface CitedByEntry {
  /** "citation": a row of the built citator (exact citation match). "mention": a text match (not built yet). */
  kind: "citation" | "mention";
  citingId: string | null;
  title: string | null;
  citation: string | null;
  courtId: string | null;
  court: string | null;
  benchStrength: number | null;
  decisionDate: string | null;
  page: number | null;
  context: string | null;
  signal: TreatmentSignal | null;
  cue: string | null;
  /** Always "text_cue" when a signal is present: what the text says, not a verified treatment. */
  signalBasis: "text_cue" | null;
  /** The raw citation as printed in the citing judgment. */
  raw: string | null;
}

export type GoodLawStatus = "negative_signal" | "caution" | "no_negative_signal_found" | "not_assessed";

export interface GoodLawSummary {
  status: GoodLawStatus;
  /** Plain statement of what was found; never "good law". */
  summary: string;
  coverage: {
    /** Judgments whose text the citator has scanned. */
    scannedJudgments: number;
    /** Whether the current scan pass has reached the end of the corpus. */
    passComplete: boolean;
    note: string;
  };
}

export interface CitatorResponse {
  id: string;
  status: "built" | "not_built";
  cites: CiteEntry[];
  statutes: StatuteEntry[];
  citedBy: CitedByEntry[];
  negative: CitedByEntry[];
  counts: { cites: number; resolved: number; unresolved: number; ambiguous: number; statutes: number; citedBy: number; negative: number };
  goodLaw: GoodLawSummary;
  /** Fixed honesty label for every signal in the response. */
  signalNote: string;
}

export interface SectionStat { actId: string; act: string | null; section: string; label: string; judgments: number; byYear: { year: number; judgments: number }[] }
export interface SectionStatsResponse { sections: SectionStat[]; filters: { act: string | null; court: string | null; from: number | null; to: number | null }; scannedJudgments: number; note: string }

export const SIGNAL_NOTE = "Signals are words found in the citing judgment's sentence (for example 'overruled'), matched by fixed rules. They are not verified treatments: read the citing passage before relying on them.";
