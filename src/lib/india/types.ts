/**
 * Shared domain contracts for Indian legal material (client-safe types only).
 * Every workstream (ingestion, citation engine, research, UI, workspace) builds on these shapes.
 */
import type { LocaleCode, TranslationOrigin } from "./languages";

/** Where an authority record came from. Licensed providers are only used with the firm's own credentials. */
export type LegalSourceId =
  | "sci-open-data"        // Supreme Court judgments, AWS Open Data (indian-supreme-court-judgments)
  | "hc-open-data"         // High Court judgments, AWS Open Data (indian-high-court-judgments)
  | "indian-kanoon"        // Indian Kanoon API (api.indiankanoon.org), firm API token
  | "india-code"           // India Code (indiacode.nic.in): central and state Acts, rules, notifications
  | "scc-online"           // SCC Online: licensed; no public API — firm-supplied export/API access only
  | "manupatra"            // Manupatra: licensed; no public API — firm-supplied export/API access only
  | "ecourts"              // eCourts services / judgments portal (case status, orders)
  | "upload";              // documents the firm uploads

/** A parsed citation. `raw` is always kept; normalized fields are filled only when parsing is certain. */
export interface IndianCitation {
  raw: string;
  kind: "neutral" | "reporter" | "case_number" | "cnr" | "statute" | "unknown";
  /** "2024 INSC 735", "2024:KHC-D:7336". */
  neutral?: string;
  /** Reporter citation parts: (2017) 10 SCC 1 → year 2017, volume 10, reporter "SCC", page 1. */
  reporter?: string;
  year?: number;
  volume?: number;
  page?: number;
  courtId?: string;
  /** Case number as filed: "RSA No. 100004 of 2024", "W.P. No. 1234/2023". */
  caseNumber?: string;
  cnr?: string;
}

/** A judgment or order as stored (one per court + CNR/neutral citation + date). */
export interface Judgment {
  id: string;
  source: LegalSourceId;
  /** Provider's own id (dataset path, Indian Kanoon docid). */
  externalId: string;
  courtId: string | null;
  /** Raw court code from the provider when the court did not resolve (never guessed). */
  unresolvedCourt?: string;
  benchId?: string;
  title: string;
  petitioner?: string;
  respondent?: string;
  caseNumber?: string;
  caseType?: string;
  cnr?: string;
  neutralCitation?: string;
  citations: IndianCitation[];
  judges: string[];
  /** Bench strength (1 single judge, 2 division bench, 3+ larger bench / constitution bench). */
  benchStrength?: number;
  decisionDate?: string;
  registrationDate?: string;
  disposal?: string;
  /** Language of the text of record. */
  language: LocaleCode;
  /** Other language versions available (court-published translations first). */
  translations: { language: LocaleCode; origin: TranslationOrigin; blobId?: string; url?: string }[];
  pdfUrl?: string;
  pdfBlobId?: string;
  sha256?: string;
  textChars?: number;
  /** Acts and sections cited, normalized ("BNSS 2023 s.483", "IPC 1860 s.302"). */
  statutes: string[];
  headnote?: string;
  retrievedAt: string;
  license?: string;
}

/** A central or state enactment from India Code. */
export interface Enactment {
  id: string;
  source: LegalSourceId;
  title: string;
  shortTitle?: string;
  actNumber?: string;
  year: number;
  jurisdiction: "central" | "state";
  /** State code for state Acts (KA, TS, AP…). */
  state?: string;
  enactedOn?: string;
  inForceFrom?: string;
  repealedBy?: string;
  /** Successor enactment when the Act was replaced (IPC → BNS). */
  replacedBy?: string;
  language: LocaleCode;
  url?: string;
  sections: number;
  retrievedAt: string;
}

export interface EnactmentSection {
  id: string;
  enactmentId: string;
  number: string;
  heading?: string;
  text: string;
  /** Section in the successor code this section corresponds to (deterministic mapping table, not a model). */
  correspondsTo?: { enactmentId: string; section: string; note?: string }[];
  amendedOn?: string[];
}
