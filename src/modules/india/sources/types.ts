/**
 * Source-layer contracts for LeClaude India ingestion (client-safe types only).
 *
 * The shared legal-material shapes (`Judgment`, `Enactment`, `EnactmentSection`) live in `src/lib/india/types.ts`
 * and are not changed here; this file only adds the storage envelope the ingestion layer keeps around them
 * (dataset key, ETag, content hash, intel document link) and the connector state vocabulary.
 */
import type { Enactment, EnactmentSection, Judgment, LegalSourceId } from "@/lib/india/types";

/**
 * Connector state, reported before any network call is made.
 * - `ready`: the connector may run.
 * - `not_configured`: a credential, token, folder or endpoint is missing; nothing is called.
 * - `license_required`: a subscription provider without the firm's explicit licence acknowledgement; nothing is called.
 * - `disabled`: switched off by configuration.
 * - `offline`: outbound network disabled (INTEL_OFFLINE).
 */
export type IndiaConnectorState = "ready" | "not_configured" | "license_required" | "disabled" | "offline";

export interface IndiaConnectorStatus {
  source: LegalSourceId;
  state: IndiaConnectorState;
  /** Human-readable reason (never contains a secret). */
  reason?: string;
  /** Environment variable that would configure the connector. */
  envVar?: string;
  /** True when the connector runs without a network call (firm export files). */
  local?: boolean;
}

/** A judgment as stored by the ingestion layer: the shared contract plus provenance of the stored copy. */
export interface StoredJudgment extends Judgment {
  /** Dataset object key or provider path the record was read from (`metadata/json/year=2024/...json`). */
  datasetKey?: string;
  /** ETag / version of the metadata object when it was read (S3 ETag). */
  sourceEtag?: string;
  /** LastModified of the metadata object (S3). */
  sourceModified?: string;
  /** Intel document holding the extracted text, chunks and search index entries. */
  intelDocId?: string;
  /** How the text of record was obtained. */
  textMethod?: "pdfjs" | "html" | "text" | "provider" | "none";
  /** Pages in the PDF (when read). */
  pages?: number;
  /** Bench folder name from the dataset when it did not resolve to a registry bench (never guessed). */
  unresolvedBench?: string;
  /** Coram entries that are roles, not names ("CHIEF JUSTICE", "LOK ADALATH"); kept verbatim, never resolved to a person. */
  coramRoles?: string[];
  /** Judge marked as author in the source (SC coram asterisk). */
  author?: string;
  /** Reasons the record needs review (missing PDF, scanned PDF, unresolved court…). */
  issues?: string[];
  updatedAt: string;
}

export interface StoredEnactment extends Enactment {
  /** India Code act id (`AC_CEN_5_23_00048_2023-45_1719292564123`). */
  actId?: string;
  /** DSpace handle (`123456789/496548`) and item uuid. */
  handle?: string;
  uuid?: string;
  longTitle?: string;
  regionalTitle?: string;
  ministry?: string;
  department?: string;
  repealed?: boolean;
  lastModified?: string;
  intelDocId?: string;
  updatedAt: string;
}

export interface StoredEnactmentSection extends EnactmentSection {
  /** India Code section id and order. */
  sectionId?: string;
  order?: number;
  handle?: string;
  url?: string;
  updatedAt: string;
}

/** One object from an S3 ListObjectsV2 page. */
export interface S3ObjectInfo {
  key: string;
  lastModified: string;
  etag: string;
  size: number;
}

export interface S3ListPage {
  objects: S3ObjectInfo[];
  prefixes: string[];
  nextToken?: string;
  truncated: boolean;
  keyCount: number;
}

/** Per-prefix ingestion checkpoint stored in the intel source cursor. */
export interface PrefixCheckpoint {
  /** Last key fully processed in the backfill pass (ListObjectsV2 `start-after`). */
  after?: string;
  /** The backfill pass reached the end of the prefix. */
  complete?: boolean;
  /** Highest LastModified seen; later passes only process objects modified after it. */
  watermark?: string;
  /** Keys that failed transiently; tried first on the next run (capped). */
  retry?: string[];
}

export interface OpenDataCursor {
  v: 1;
  prefixes: Record<string, PrefixCheckpoint>;
}
