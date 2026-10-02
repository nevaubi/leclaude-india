/**
 * Official concordance tables between the repealed criminal codes and the 2023 codes (client-safe contracts).
 *
 * The rows are DATA parsed from the Government's own comparison documents (Bureau of Police Research & Development,
 * Ministry of Home Affairs: "Correspondence table and comparison summary"), never written by hand. Each row keeps the
 * cells exactly as the document prints them (`newRaw`, `oldRaw`), the sections parsed from them, the page it came from,
 * and every reason the parser had for doubt (`flags`). A row with any flag is `requires_review`; nothing is guessed.
 */

export type ConcordanceTableId = "ipc-bns" | "crpc-bnss" | "iea-bsa";
export type OldCodeId = "IPC" | "CrPC" | "IEA";
export type NewCodeId = "BNS" | "BNSS" | "BSA";

/**
 * - corresponds: the document names one or more old provisions for this new provision;
 * - new: the document says the provision is new / has no old counterpart ("New", "-", "Newly added");
 * - not_stated: the old-code cell is empty (e.g. an umbrella row whose sub-rows carry the mapping);
 * - unparsed: the row could not be read reliably (malformed cells); kept verbatim, never used for mapping.
 */
export type ConcordanceRelation = "corresponds" | "new" | "not_stated" | "unparsed";

/**
 * Row verification:
 * - official_parsed: read cleanly from the official document (machine-read table; not checked by a person);
 * - official_cross_checked: read cleanly AND an independently hand-coded legacy row agrees with it;
 * - requires_review: a blocking flag (residue in a section cell, malformed row, out-of-sequence number, OCR noise in a
 *   section cell): the row is shown with its flag but never used to map a section. Informational flags (range expanded,
 *   noise in the subject/summary text) leave the row usable.
 */
export type ConcordanceVerification = "official_parsed" | "official_cross_checked" | "requires_review";

export type ConcordanceFlag =
  | "malformed_row" // wrong number of cells in the source table row
  | "new_cell_unparsed" // the new-code cell is not a section reference
  | "old_cell_residue" // the old-code cell has text the parser did not recognise
  | "range_expanded" // "230 to 232" was expanded to 230, 231, 232 (numeric sections only)
  | "out_of_sequence" // the new section number is lower than the previous row's (likely an OCR misread)
  | "ocr_noise" // non-Latin characters inside a section-number cell (extraction artefact; the numbers are not trusted)
  | "text_noise" // non-Latin characters in the subject or summary only (informational; numbers unaffected)
  | "legacy_disagrees"; // the hand-coded legacy table maps this old section differently

export interface ConcordanceSection {
  /** Normalised section ("103(1)", "498A", "2(1)(a)"). */
  section: string;
  /** Qualifier printed with it ("Explanation", "para 1", "proviso", "first proviso"). */
  part?: string;
}

export interface ConcordanceRow {
  /** Stable id: "<table>:<row ordinal>" (ordinal in document order, 1-based). */
  id: string;
  /** New-code cell exactly as printed. */
  newRaw: string;
  newSections: ConcordanceSection[];
  subject: string;
  /** Old-code cell exactly as printed. */
  oldRaw: string;
  oldSections: ConcordanceSection[];
  relation: ConcordanceRelation;
  /** 1-based page of the source PDF the row is printed on. */
  page: number;
  flags: ConcordanceFlag[];
  verification: ConcordanceVerification;
}

export interface ConcordanceSource {
  title: string;
  publisher: string;
  /** The publisher's own URL for the document. */
  url: string;
  /** Page listing the document on the publisher's site. */
  listedAt: string;
  /** Who prepared it, as printed on the document. */
  preparedBy: string | null;
  pages: number;
  retrievedAt: string;
  /** How the table text was obtained from the PDF. */
  extraction: string;
  /** SHA-256 of the extracted markdown the rows were parsed from (the generator's input). */
  inputSha256: string;
}

export interface ConcordanceTable {
  id: ConcordanceTableId;
  oldCode: OldCodeId;
  newCode: NewCodeId;
  source: ConcordanceSource;
  /** Parser version that produced the rows (bump to regenerate). */
  parserVersion: number;
  rows: ConcordanceRow[];
  counts: { rows: number; corresponds: number; new: number; notStated: number; unparsed: number; requiresReview: number };
}

/** Per-row "summary of comparison" text, kept apart from the rows so client bundles do not carry it. */
export type ConcordanceSummaries = Record<string, string>;
