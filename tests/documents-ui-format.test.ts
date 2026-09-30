import { describe, expect, it } from "vitest";
import {
  batchPages, csvCell, formatPreciseDate, groupByYear, isScannedText, linkCitationMarkers, markersIn, methodLabel, pageTextFromItems, pdfDateToIso, sortEvents, toCsv,
} from "@/modules/documents/components/format";

describe("documents UI helpers", () => {
  it("formats dates at their precision without shifting by time zone", () => {
    expect(formatPreciseDate("2021-03-03", "day")).toBe("3 Mar 2021");
    expect(formatPreciseDate("2021-03", "month")).toBe("Mar 2021");
    expect(formatPreciseDate("2021", "year")).toBe("2021");
    expect(formatPreciseDate("2021-03-03", "month")).toBe("Mar 2021");
    expect(formatPreciseDate("2021-12-31T23:30:00.000Z")).toBe("31 Dec 2021");
  });

  it("sorts events by date then file and groups them by year", () => {
    const ev = [
      { date: "2022-01-05", fileName: "b", page: 1 },
      { date: "2021", fileName: "a", page: 2 },
      { date: "2021-03", fileName: "a", page: 1 },
      { date: "2021-03-02", fileName: "a", page: 1 },
    ];
    const sorted = sortEvents(ev);
    expect(sorted.map((e) => e.date)).toEqual(["2021", "2021-03", "2021-03-02", "2022-01-05"]);
    expect(groupByYear(sorted).map((g) => [g.year, g.items.length])).toEqual([["2021", 3], ["2022", 1]]);
  });

  it("escapes CSV cells and neutralises formulas", () => {
    expect(csvCell('He said "no", twice')).toBe('"He said ""no"", twice"');
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell("-5")).toBe("-5");
    expect(csvCell(["A", "B"])).toBe("A; B");
    expect(csvCell(null)).toBe("");
    expect(toCsv(["a", "b"], [[1, "x,y"]])).toBe('a,b\r\n1,"x,y"\r\n');
  });

  it("links [n] markers without touching markdown links or code", () => {
    expect(linkCitationMarkers("Rent was due [1] and paid [2, 3].")).toBe("Rent was due [1](#doc-cite-1) and paid [2](#doc-cite-2) [3](#doc-cite-3).");
    expect(linkCitationMarkers("see [the lease](https://x.test) and `a[1]`")).toBe("see [the lease](https://x.test) and `a[1]`");
    expect(markersIn("a [1] b [2,4] c [1]")).toEqual([1, 2, 4]);
  });

  it("assembles page text and detects scanned pages", () => {
    const text = pageTextFromItems([
      { str: "AGREEMENT", hasEOL: true, transform: [1, 0, 0, 1, 0, 700] },
      { str: "This lease is made", transform: [1, 0, 0, 1, 0, 680] },
      { str: " on 3 March 2021.", transform: [1, 0, 0, 1, 90, 680] },
      { str: "Second line", transform: [1, 0, 0, 1, 0, 660] },
    ]);
    expect(text).toBe("AGREEMENT\nThis lease is made on 3 March 2021.\nSecond line");
    expect(isScannedText("  12 \n ")).toBe(true);
    expect(isScannedText(text)).toBe(false);
  });

  it("parses PDF metadata dates", () => {
    expect(pdfDateToIso("D:20210303120000+05'30'")).toBe("2021-03-03T06:30:00.000Z");
    expect(pdfDateToIso("D:2019")).toBe("2019-01-01T00:00:00.000Z");
    expect(pdfDateToIso("garbage")).toBeNull();
    expect(pdfDateToIso(undefined)).toBeNull();
  });

  it("batches page texts under the byte limit, in order, with page offsets", () => {
    const pages = Array.from({ length: 10 }, (_, i) => "x".repeat(100) + i);
    const batches = batchPages(pages, 350);
    expect(batches.flatMap((b) => b.pages)).toEqual(pages);
    expect(batches[0].fromPage).toBe(1);
    for (const b of batches) expect(b.pages.length).toBeGreaterThan(0);
    expect(batches[1].fromPage).toBe(1 + batches[0].pages.length);
    expect(batchPages([], 100)).toEqual([{ fromPage: 1, pages: [] }]);
  });

  it("labels methods and scanned files", () => {
    expect(methodLabel({ method: "browser-pdfjs", status: "needs_ocr", ocrPages: [1, 2] })).toBe("Scanned — no text layer");
    expect(methodLabel({ method: "browser-pdfjs", status: "partial", ocrPages: [3] })).toBe("PDF text + 1 scanned");
    expect(methodLabel({ method: "ocr-ai", status: "ready", ocrPages: [] })).toBe("Scanned — AI OCR");
  });
});
