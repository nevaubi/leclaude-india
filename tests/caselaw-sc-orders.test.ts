import { describe, expect, it } from "vitest";
import { exactDiaryOrders, scDiaryNumberOf } from "@/modules/caselaw/shared";

const doc = (id: string, o: { sourceId?: string; docDate?: string | null; diaryNo?: unknown } = {}) => ({
  id, sourceId: o.sourceId ?? "sci-orders", docDate: o.docDate ?? "2026-09-01", meta: o.diaryNo === undefined ? {} : { diaryNo: o.diaryNo },
});

describe("Supreme Court orders feed on the case record", () => {
  it("reads a diary number only when the metadata prints one, and only for Supreme Court records", () => {
    expect(scDiaryNumberOf({ court_id: "sci", case_number: "Diary No. 54583-2026" })).toBe("54583/2026");
    expect(scDiaryNumberOf({ court_id: "sci", case_number: "DIARY NUMBER 0123 / 2019" })).toBe("123/2019");
    expect(scDiaryNumberOf({ court_id: "sci", case_number: null, diary_no: "54583/2026" })).toBe("54583/2026");
    // An ordinary case number is never read as a diary number.
    expect(scDiaryNumberOf({ court_id: "sci", case_number: "CRIMINAL APPEAL No. 1031/2015" })).toBeNull();
    expect(scDiaryNumberOf({ court_id: "sci", case_number: null })).toBeNull();
    // Another court's record never gets the Supreme Court feed.
    expect(scDiaryNumberOf({ court_id: "hc-delhi", case_number: "Diary No. 54583-2026" })).toBeNull();
    expect(scDiaryNumberOf({ court_id: null, case_number: "Diary No. 54583-2026" })).toBeNull();
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
      doc("h", { diaryNo: "Diary No. 54583-2026", docDate: null }),
    ];
    expect(exactDiaryOrders(docs, "54583/2026").map((d) => d.id)).toEqual(["d", "a", "h"]);
    expect(exactDiaryOrders(docs, "1/2026")).toEqual([]);
    expect(exactDiaryOrders([], "54583/2026")).toEqual([]);
  });
});
