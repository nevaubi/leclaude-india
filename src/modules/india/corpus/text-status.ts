/**
 * `corpus_judgments.text_status` values and what they mean (client-safe: no server imports).
 *
 *   none / metadata  metadata record only (no text to read or quote)
 *   full             text from Open India Law (CNR + date or neutral citation match; scripts/law-corpus/)
 *   full_text        text extracted from the court's own PDF text layer (src/modules/india/corpus/hc-text)
 *   ocr              text from the court's PDF where some or all pages were transcribed by a model (OCR)
 *   partial          some pages have text, others could not be read (OCR capped, unavailable or failed)
 *   failed           the PDF could not be fetched or yielded no text (recorded reason in hc_text_units)
 *
 * Readers, tools and the citator treat every value in TEXT_STATUSES_WITH_TEXT as "has text in corpus_texts".
 */
export const TEXT_STATUSES_WITH_TEXT = ["full", "full_text", "ocr", "partial"] as const;
export type JudgmentTextStatus = "none" | "metadata" | "failed" | (typeof TEXT_STATUSES_WITH_TEXT)[number];

export function hasJudgmentText(status: string | null | undefined): boolean {
  return (TEXT_STATUSES_WITH_TEXT as readonly string[]).includes(String(status ?? ""));
}

/** SQL list for `text_status IN (...)` (constants only, never user input). */
export const TEXT_STATUSES_SQL = TEXT_STATUSES_WITH_TEXT.map((s) => `'${s}'`).join(", ");

/** Short label for chips and tables. */
export function textStatusLabel(status: string | null | undefined): string {
  switch (status) {
    case "full": return "Parsed text";
    case "full_text": return "PDF text";
    case "ocr": return "OCR text";
    case "partial": return "Partial text";
    case "failed": return "Text unavailable";
    default: return "Text not confirmed";
  }
}

/** What a model may do with the text (tool results). */
export function textStatusForTools(status: string | null | undefined): string | null {
  switch (status) {
    case "ocr": return "OCR text of scanned pages (model transcription): check every quotation against the PDF";
    case "partial": return "partial text: some pages could not be read; say which pages were not read";
    default: return null;
  }
}
