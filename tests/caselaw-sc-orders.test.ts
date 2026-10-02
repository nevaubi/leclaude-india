import { describe, expect, it } from "vitest";
import { exactDiaryOrders, labelledDiaryNumbers, scDiaryNumberOf, strictDiaryNumber } from "@/modules/caselaw/shared";

const doc = (id: string, o: { sourceId?: string; docDate?: string | null; diaryNo?: unknown } = {}) => ({
  id, sourceId: o.sourceId ?? "sci-orders", docDate: o.docDate ?? "2026-09-01", meta: o.diaryNo === undefined ? {} : { diaryNo: o.diaryNo },
});

describe("Supreme Court orders feed on the case record", () => {
  it("reads a diary number only when the case number labels one, and only for Supreme Court records", () => {
    expect(scDiaryNumberOf({ court_id: "sci", case_number: "Diary No. 54583-2026" })).toBe("54583/2026");
    expect(scDiaryNumberOf({ court_id: "sci", case_number: "DIARY NUMBER 0123 / 2019" })).toBe("123/2019");
    // An ordinary case number is never read as a diary number.
    expect(scDiaryNumberOf({ court_id: "sci", case_number: "CRIMINAL APPEAL No. 1031/2015" })).toBeNull();
    expect(scDiaryNumberOf({ court_id: "sci", case_number: "54583/2026" })).toBeNull();
    expect(scDiaryNumberOf({ court_id: "sci", case_number: null })).toBeNull();
    // Another court's record never gets the Supreme Court feed.
    expect(scDiaryNumberOf({ court_id: "hc-delhi", case_number: "Diary No. 54583-2026" })).toBeNull();
    expect(scDiaryNumberOf({ court_id: null, case_number: "Diary No. 54583-2026" })).toBeNull();
  });

  it("takes the labelled diary number, never the case number printed beside it", () => {
    // Regression: the unanchored normalizer read this as diary 1234/2026 (the SLP number) and showed another case's orders.
    expect(scDiaryNumberOf({ court_id: "sci", case_number: "SLP(C) No. 1234/2026 (Diary No. 54583/2026)" })).toBe("54583/2026");
    expect(scDiaryNumberOf({ court_id: "sci", case_number: "C.A. No. 166/2019 @ Diary Number: 4240-2015" })).toBe("4240/2015");
    // The same diary number printed twice is still one.
    expect(scDiaryNumberOf({ court_id: "sci", case_number: "Diary No. 54583/2026; Diary No. 54583-2026" })).toBe("54583/2026");
  });

  it("gives no diary number when two different ones are printed", () => {
    expect(scDiaryNumberOf({ court_id: "sci", case_number: "Diary No. 54583/2026 with Diary No. 54584/2026" })).toBeNull();
    expect(labelledDiaryNumbers("Diary No. 54583/2026 with Diary No. 54584/2026")).toEqual(["54583/2026", "54584/2026"]);
  });

  it("reads a diary field strictly: the whole value, or exactly one labelled number", () => {
    expect(strictDiaryNumber("54583/2026")).toBe("54583/2026");
    expect(strictDiaryNumber(" 54583 - 2026 ")).toBe("54583/2026");
    expect(strictDiaryNumber("Diary No. 054583-2026")).toBe("54583/2026");
    expect(strictDiaryNumber("SLP(C) No. 1234/2026 (Diary No. 54583/2026)")).toBe("54583/2026");
    // A case number is not a diary number.
    expect(strictDiaryNumber("W.P.(C) 12/2026")).toBeNull();
    expect(strictDiaryNumber("SLP(C) No. 1234/2026")).toBeNull();
    // Ambiguous, malformed or empty.
    expect(strictDiaryNumber("Diary No. 1/2026 and Diary No. 2/2026")).toBeNull();
    expect(strictDiaryNumber("0/2026")).toBeNull();
    expect(strictDiaryNumber("54583/20261")).toBeNull();
    expect(strictDiaryNumber("54583/1826")).toBeNull();
    expect(strictDiaryNumber("")).toBeNull();
    expect(strictDiaryNumber(null)).toBeNull();
  });

  it("keeps only documents whose published diary number is exactly the record's, newest first", () => {
    const docs = [
      doc("a", { diaryNo: "54583/2026", docDate: "2026-09-01" }),
      doc("b", { diaryNo: "54583/2025" }),
      doc("c", { diaryNo: "5458/2026" }),
      doc("d", { diaryNo: "54583/2026", docDate: "2026-09-20" }),
      doc("e", { diaryNo: "54583/2026", sourceId: "sci-causelist" }),
      doc("f", {}),
      doc("g", { diaryNo: 545832026 }),
      doc("h", { diaryNo: "Diary No. 54583-2026", docDate: "2026-07-01" }),
      // A diary field carrying a case number first is read by its label, never by the first N/YYYY.
      doc("i", { diaryNo: "SLP(C) 54583/2026 Diary No. 999/2026" }),
      doc("j", { diaryNo: "SLP(C) 1/2026 Diary No. 54583/2026", docDate: "2026-08-01" }),
    ];
    expect(exactDiaryOrders(docs, "54583/2026").map((d) => d.id)).toEqual(["d", "a", "j", "h"]);
    expect(exactDiaryOrders(docs, "1/2026")).toEqual([]);
    expect(exactDiaryOrders([], "54583/2026")).toEqual([]);
  });
});
