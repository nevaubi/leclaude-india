import { addCounts, chunkMarkdown, scrubPersonalData, type ScrubCounts } from "@/modules/official/chunk";
import { pageMarkdown, type PageText } from "@/modules/official/extract";

/**
 * Chunking of one judgment's page text for corpus_texts (deterministic; the same chunker as official documents:
 * ~2,500-character chunks, never over 4,000, closed at page boundaries so most chunks sit on one page).
 *
 * - Contact data (phone numbers, e-mail addresses, video-conference links) is replaced by visible markers before
 *   chunking, exactly as official documents are scrubbed (src/modules/official/chunk.ts `scrubPersonalData`).
 * - Every chunk carries pageStart / pageEnd (1-based PDF page numbers).
 * - sectionType is "ocr" when any page the chunk spans was transcribed by OCR, otherwise null, so OCR text stays
 *   labelled in storage, in readers and in tool results.
 */

export interface JudgmentChunk { index: number; pageStart: number | null; pageEnd: number | null; sectionType: "ocr" | null; text: string }

export interface ChunkedJudgment {
  chunks: JudgmentChunk[];
  chars: number;
  redactions: ScrubCounts;
}

const NONE: ScrubCounts = { phones: 0, emails: 0, links: 0 };

export function chunkJudgmentPages(pages: PageText[], ocrPages: Iterable<number> = []): ChunkedJudgment {
  const ocr = new Set(ocrPages);
  let redactions = NONE;
  const clean = pages
    .filter((p) => p.text.trim())
    .sort((a, b) => a.page - b.page)
    .map((p) => {
      const r = scrubPersonalData(p.text.replace(/\u0000/g, ""));
      redactions = addCounts(redactions, r.counts);
      return { page: p.page, text: r.text };
    });
  if (!clean.length) return { chunks: [], chars: 0, redactions };
  const drafts = chunkMarkdown(pageMarkdown(clean, true));
  const chunks = drafts.map((d, i) => {
    let fromOcr = false;
    if (d.pageStart != null) for (let p = d.pageStart; p <= (d.pageEnd ?? d.pageStart); p++) if (ocr.has(p)) { fromOcr = true; break; }
    return { index: i, pageStart: d.pageStart, pageEnd: d.pageEnd, sectionType: fromOcr ? ("ocr" as const) : null, text: d.text };
  });
  return { chunks, chars: chunks.reduce((n, c) => n + c.text.length, 0), redactions };
}
