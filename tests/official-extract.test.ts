import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { CHUNK_MAX, chunkMarkdown, normalizedText, splitLong } from "@/modules/official/chunk";
import { detectKind, extractDocument, extractFirecrawlMarkdown, extractPdf, firecrawlPages, pageMarkdown, pageNeedsOcr, splitPageMarkdown, textQuality } from "@/modules/official/extract";
import { htmlToMarkdown } from "@/modules/official/html-markdown";
import { groupPages, ocrDocument, ocrPrompt, parseOcrResponse, type OcrModel } from "@/modules/official/ocr";

const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

async function makePdf(pages: string[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const png = await doc.embedPng(Buffer.from(PNG_1X1, "base64"));
  for (const text of pages) {
    const page = doc.addPage([595, 842]);
    if (text === "IMAGE") { page.drawImage(png, { x: 40, y: 200, width: 500, height: 500 }); continue; }
    text.split("\n").forEach((line, i) => { if (line) page.drawText(line, { x: 50, y: 780 - i * 16, size: 11, font }); });
  }
  return doc.save();
}

describe("text-layer readability gate", () => {
  it("passes real text in any script and fails glyph garbage", () => {
    expect(textQuality("The respondent shall file the counter affidavit within four weeks from today.").readable).toBe(true);
    expect(textQuality("ಉಚ್ಚ ನ್ಯಾಯಾಲಯದ ಆದೇಶದಂತೆ ಅರ್ಜಿದಾರರು ನಾಲ್ಕು ವಾರಗಳಲ್ಲಿ ಉತ್ತರ ಸಲ್ಲಿಸತಕ್ಕದ್ದು ಎಂದು ತೀರ್ಮಾನಿಸಲಾಗಿದೆ").readable).toBe(true);
    expect(textQuality("!#$%&()*+,-./:;<=>?@[]^_{|}~ 12 34 56 78 90 !#$%&()*+,-./:;<=>?@").readable).toBe(false);
  });

  it("sends scans and garbage to OCR, never short readable or blank pages", () => {
    expect(pageNeedsOcr("", true).needsOcr).toBe(true); // image, no text: a scan
    expect(pageNeedsOcr("Page 3", true).needsOcr).toBe(true); // stamped number over a scan
    expect(pageNeedsOcr("", false).needsOcr).toBe(false); // blank page
    expect(pageNeedsOcr("Sd/- Registrar", false)).toMatchObject({ needsOcr: false, readable: true }); // a short signature page
    expect(pageNeedsOcr("¤¥¦§¨©ª«¬®¯°±²³´µ¶·¸¹º»¼½¾¿×÷", false).needsOcr).toBe(true); // glyph garbage without a Unicode map
  });

  it("extracts per-page text, positional items and the OCR page list from a PDF", async () => {
    const bytes = await makePdf(["CAUSE LIST FOR MONDAY THE 5TH OCTOBER 2026\nCOURT NO. 1\n1. SLP(C) No. 1234/2026 Ram Kumar versus State of Karnataka", "IMAGE", ""]);
    const keep = new Uint8Array(bytes);
    const ex = await extractPdf(bytes);
    expect(ex).toMatchObject({ kind: "pdf", method: "text_layer", paged: true, pageCount: 3, ocrPages: [2] });
    expect(ex.pages.map((p) => p.page)).toEqual([1, 2, 3]);
    expect(ex.pages[0].text.split("\n")).toEqual(["CAUSE LIST FOR MONDAY THE 5TH OCTOBER 2026", "COURT NO. 1", "1. SLP(C) No. 1234/2026 Ram Kumar versus State of Karnataka"]);
    expect(ex.pages[1].text).toBe("");
    expect(ex.quality.find((q) => q.page === 2)).toMatchObject({ hasImages: true, needsOcr: true });
    expect(ex.quality.find((q) => q.page === 3)).toMatchObject({ hasImages: false, needsOcr: false });
    const item = ex.items.find((i) => i.str.includes("COURT NO. 1"))!;
    expect(item).toMatchObject({ page: 1, x: 50, y: 764 });
    expect(item.w).toBeGreaterThan(0);
    // The caller's bytes are not detached by pdfjs (they are needed again for OCR).
    expect(Buffer.from(bytes).equals(Buffer.from(keep))).toBe(true);
    const md = pageMarkdown(ex.pages, true);
    expect(md.startsWith("<!-- page 1 -->\n\nCAUSE LIST")).toBe(true);
    expect(splitPageMarkdown(md).map((s) => s.page)).toEqual([1, 2, 3]);
  });

  it("keeps Firecrawl PDF markdown paged only when its page markers are consistent", () => {
    const md = "IN THE HIGH COURT OF DELHI\n\n---\n\n<!-- page 2 -->\n\nORDER dated 01.10.2026\n\n---\n\n<!-- page 3 -->\n\nSd/- Judge";
    expect(firecrawlPages(md)).toEqual([{ page: 1, text: "IN THE HIGH COURT OF DELHI" }, { page: 2, text: "ORDER dated 01.10.2026" }, { page: 3, text: "Sd/- Judge" }]);
    const ex = extractFirecrawlMarkdown(md, 3);
    expect(ex).toMatchObject({ method: "firecrawl_pdf", paged: true, pageCount: 3 });
    expect(firecrawlPages("intro\n<!-- page 5 -->\nx")).toBeNull(); // where would "intro" belong? not guessed
    expect(firecrawlPages("a\n<!-- page 2 -->\nb\n<!-- page 4 -->\nc")).toBeNull(); // a gap
    const flat = extractFirecrawlMarkdown("a\n<!-- page 2 -->\nb\n<!-- page 4 -->\nc", null);
    expect(flat).toMatchObject({ paged: false, method: "firecrawl_pdf" });
    expect(flat.pages[0].text).not.toContain("<!-- page");
  });

  it("detects kinds from bytes before trusting the declared type", async () => {
    const pdf = await makePdf(["Hello world order text that is long enough to pass the gate."]);
    expect(detectKind(pdf, "text/html", "https://x.gov.in/a")).toBe("pdf");
    expect(detectKind(new TextEncoder().encode("<!DOCTYPE html><html><body>x</body></html>"), null, "https://x.gov.in/a")).toBe("html");
    expect(detectKind(new TextEncoder().encode('[{"a":1}]'), null, "https://x.gov.in/a")).toBe("json");
    expect(detectKind(new Uint8Array([0, 1, 2, 3, 0, 0, 0, 255, 254, 0, 1]), null, "https://x.gov.in/a.bin")).toBe("unsupported");
    const json = await extractDocument({ bytes: new TextEncoder().encode('[{"notification":"12/2026-Central Tax","date":"2026-09-30"}]'), mime: "application/json", url: "https://x.gov.in/n.json" });
    expect(json.method).toBe("dataset");
    expect(json.pages[0].text).toContain("| notification | date |");
    expect(json.pages[0].text).toContain("| 12/2026-Central Tax | 2026-09-30 |");
  });
});

describe("htmlToMarkdown", () => {
  const html = `<!doctype html><html><head><title>Orders | NCLAT</title><style>.x{color:red}</style><script>alert("x")</script></head>
    <body><nav><a href="/home">Home</a> | <a href="/about">About</a></nav><header><h1>Site banner</h1></header>
    <main><article><header><h1>Daily Orders &amp; Judgments</h1></header>
      <p>Orders dated 01.10.2026 are listed below.<br>Click a link to open the PDF.</p>
      <ul><li>First item<li>Second <b>bold</b> item</ul>
      <table><thead><tr><th>S.No</th><th>Case No.</th><th>Order</th></tr></thead>
        <tbody><tr><td>1<td>Comp. App. (AT) (Ins) No. 351 of 2026<td><a href="/orders/351.pdf">View</a></tr>
        <tr><td>2</td><td>CP | 12</td><td><a href="javascript:void(0)" onclick="go()">Open</a></td></tr></tbody></table>
      <p>Unicode: न्यायालय &#8377; 1,00,000 &nbsp;done</p>
    </article></main><footer>Copyright footer text</footer></body></html>`;

  it("keeps headings, paragraphs, lists, tables and absolute links; strips scripts, styles, navigation and chrome", () => {
    const r = htmlToMarkdown(html, { baseUrl: "https://nclat.nic.in/display-board/orders" });
    expect(r.title).toBe("Orders | NCLAT");
    expect(r.markdown).toContain("# Daily Orders & Judgments");
    expect(r.markdown).toContain("Orders dated 01.10.2026 are listed below.\nClick a link to open the PDF.");
    expect(r.markdown).toContain("- First item\n- Second **bold** item");
    expect(r.markdown).toContain("| S.No | Case No. | Order |\n| --- | --- | --- |\n| 1 | Comp. App. (AT) (Ins) No. 351 of 2026 | [View](https://nclat.nic.in/orders/351.pdf) |");
    expect(r.markdown).toContain("| 2 | CP \\| 12 | Open |");
    expect(r.markdown).toContain("न्यायालय ₹ 1,00,000 done");
    for (const gone of ["alert", "color:red", "Home", "About", "Site banner", "Copyright footer", "javascript:"]) expect(r.markdown).not.toContain(gone);
    expect(r.links).toEqual(["https://nclat.nic.in/orders/351.pdf"]);
  });

  it("is deterministic and tolerant of unclosed tags", () => {
    const messy = "<p>One<p>Two<div>Three<span>four</div><p>Five &unknown; &#0; </p>";
    const a = htmlToMarkdown(messy).markdown;
    expect(a).toBe(htmlToMarkdown(messy).markdown);
    expect(a.split("\n\n")).toEqual(["One", "Two", "Threefour", "Five &unknown; &#0;"]); // adjacent inline text stays adjacent, as rendered
  });
});

describe("chunkMarkdown", () => {
  const para = (n: number, page: number) => `Paragraph ${n} on page ${page}. ${"The tribunal considered the submissions of both parties in detail. ".repeat(6)}`.trim();
  const pages = Array.from({ length: 6 }, (_, i) => ({ page: i + 1, text: [i === 2 ? "## Findings" : "", para(i * 3 + 1, i + 1), para(i * 3 + 2, i + 1), para(i * 3 + 3, i + 1)].filter(Boolean).join("\n\n") }));
  const md = pageMarkdown(pages, true);

  it("loses nothing, overlaps nothing, stays within the size limit and records page ranges and headings", () => {
    const chunks = chunkMarkdown(md);
    expect(chunks.length).toBeGreaterThan(2);
    expect(normalizedText(chunks.map((c) => c.text).join(" "))).toBe(normalizedText(md));
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(CHUNK_MAX);
      expect(c.text).not.toContain("<!-- page");
      expect(c.pageStart).not.toBeNull();
      expect(c.pageEnd!).toBeGreaterThanOrEqual(c.pageStart!);
    }
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
    // Pages are contiguous and ordered: each chunk starts on or after the previous chunk's end page.
    for (let i = 1; i < chunks.length; i++) expect(chunks[i].pageStart!).toBeGreaterThanOrEqual(chunks[i - 1].pageEnd!);
    const findings = chunks.find((c) => c.text.startsWith("## Findings"));
    expect(findings?.heading).toBe("Findings");
    expect(chunks.find((c) => c.text.includes("Paragraph 18"))?.heading).toBe("Findings");
  });

  it("splits an oversized block at natural boundaries, never above the maximum", () => {
    const long = "Sentence one is here. ".repeat(500);
    const parts = splitLong(long, 1000);
    expect(parts.every((p) => p.length <= 1000)).toBe(true);
    expect(normalizedText(parts.join(" "))).toBe(normalizedText(long));
    const noSpace = "x".repeat(9000);
    expect(splitLong(noSpace, 4000).map((p) => p.length)).toEqual([4000, 4000, 1000]);
    const chunks = chunkMarkdown(`<!-- page 1 -->\n\n${long}`);
    expect(chunks.every((c) => c.text.length <= CHUNK_MAX && c.pageStart === 1)).toBe(true);
  });

  it("page-less documents (HTML, datasets) get null page ranges", () => {
    const chunks = chunkMarkdown("# Notification\n\nG.S.R. 123(E). In exercise of the powers conferred by section 15 of the Act, the Central Government hereby notifies the following.");
    expect(chunks).toEqual([expect.objectContaining({ index: 0, pageStart: null, pageEnd: null, heading: "Notification" })]);
  });
});

describe("OCR orchestration", () => {
  it("groups pages into contiguous ranges of at most six", () => {
    expect(groupPages([9, 1, 2, 3, 4, 5, 6, 7, 8, 12, 12])).toEqual([[1, 2, 3, 4, 5, 6], [7, 8, 9], [12]]);
  });

  it("maps a transcription to pages only when the markers match exactly", () => {
    expect(parseOcrResponse("<!-- page 4 -->\n\nA\n\n<!-- page 5 -->\n\nB", [4, 5])).toEqual(new Map([[4, "A"], [5, "B"]]));
    expect(parseOcrResponse("```markdown\n<!-- page 4 -->\nA\n```", [4])).toEqual(new Map([[4, "A"]]));
    expect(parseOcrResponse("Just text", [7])).toEqual(new Map([[7, "Just text"]]));
    expect(parseOcrResponse("<!-- page 1 -->\nA\n<!-- page 2 -->\nB", [4, 5])).toBeNull(); // positions, not original numbers
    expect(parseOcrResponse("<!-- page 1 -->\nOnly page", [2])).toEqual(new Map([[2, "Only page"]])); // one page sent: its position label is unambiguous
    expect(parseOcrResponse("<!-- page 1 -->\nA\n<!-- page 2 -->\nB", [2])).toBeNull(); // two pages back for one sent
    expect(parseOcrResponse("", [2])).toBeNull(); // an empty answer is never a blank page
    expect(parseOcrResponse("<!-- page 4 -->\nA", [4, 5])).toBeNull(); // a page missing
    expect(parseOcrResponse("No markers at all", [4, 5])).toBeNull();
    expect(ocrPrompt([4, 5])).toMatch(/VERBATIM[\s\S]*Do not translate[\s\S]*pages 4, 5[\s\S]*<!-- page N -->/);
  });

  it("sends ≤6-page slices with bounded concurrency, retries a mismatched range page by page, and honours the cap", async () => {
    const pdf = await makePdf(Array.from({ length: 8 }, () => "IMAGE"));
    const seen: { pages: number[]; pdfPages: number }[] = [];
    let inFlight = 0, peak = 0;
    const model: OcrModel = {
      id: "fake-ocr",
      async transcribe(req) {
        inFlight++; peak = Math.max(peak, inFlight);
        const slice = await PDFDocument.load(Buffer.from(req.pdfBase64, "base64"));
        seen.push({ pages: req.pages, pdfPages: slice.getPageCount() });
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        // The second range answers with positional numbers the first time (wrong): it must be retried per page.
        if (req.pages[0] === 7 && req.pages.length > 1) return "<!-- page 1 -->\nx\n<!-- page 2 -->\ny";
        return req.pages.map((p) => `<!-- page ${p} -->\nText of page ${p}`).join("\n");
      },
    };
    const r = await ocrDocument(pdf, [1, 2, 3, 4, 5, 6, 7, 8], { model, concurrency: 2, maxPages: 80 });
    expect(r).toMatchObject({ model: "fake-ocr", complete: true, capped: false, failed: [] });
    expect(r.pages.map((p) => p.page)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(r.pages[6].text).toBe("Text of page 7");
    expect(seen.map((s) => s.pages)).toEqual(expect.arrayContaining([[1, 2, 3, 4, 5, 6], [7, 8], [7], [8]]));
    expect(seen.every((s) => s.pdfPages === s.pages.length)).toBe(true);
    expect(peak).toBeLessThanOrEqual(2);
    const capped = await ocrDocument(pdf, [1, 2, 3], { model, maxPages: 2 });
    expect(capped).toMatchObject({ capped: true, complete: false, pages: [] });
  });

  it("stops scheduling at the deadline and resumes from the pages already done", async () => {
    const pdf = await makePdf(Array.from({ length: 7 }, () => "IMAGE"));
    const model: OcrModel = { id: "m", async transcribe(req) { return req.pages.map((p) => `<!-- page ${p} -->\nT${p}`).join("\n"); } };
    let t = 0;
    const late = await ocrDocument(pdf, [1, 2, 3, 4, 5, 6, 7], { model, deadline: 10_000, now: () => (t += 100_000), concurrency: 1 });
    expect(late.complete).toBe(false);
    const resumed = await ocrDocument(pdf, [1, 2, 3, 4, 5, 6, 7], { model, done: { "1": "T1", "2": "T2", "3": "T3", "4": "T4", "5": "T5", "6": "T6" } });
    expect(resumed).toMatchObject({ complete: true, requests: 1 });
    expect(resumed.pages.map((p) => p.text)).toEqual(["T1", "T2", "T3", "T4", "T5", "T6", "T7"]);
  });
});
