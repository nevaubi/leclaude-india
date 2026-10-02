import { describe, expect, it } from "vitest";
import type { MatterOverview } from "@/modules/home/types";
import { hotCell, keyDateTone, matterMeta, matterRows, taskCell } from "@/modules/home/components/matters-table-model";
import { parseInsights } from "@/modules/home/components/for-you-model";
import { filterValuesFrom, filtersPatchFrom } from "@/modules/library/components/toolbar-model";

function matter(over: Partial<MatterOverview> & { id: string }): MatterOverview {
  return { shortName: over.id, name: over.id, client: "Client", clientSide: "plaintiff", practiceArea: "Litigation", status: "active", teamIds: [], keyDates: [], openTasks: 0, overdueTasks: 0, myOpenTasks: 0, hotDocs: 0, docCount: 0, upcomingEvents: 0, ...over };
}

describe("Home matters table model", () => {
  const rows = [
    matter({ id: "b", nextKeyDate: { label: "Trial", date: "2026-12-07", daysUntil: 74 } }),
    matter({ id: "a", nextKeyDate: { label: "Opposition due", date: "2026-10-02", daysUntil: 8 } }),
    matter({ id: "c" }),
  ];
  it("orders by the nearest key date, matters without one last, and honours the filter", () => {
    expect(matterRows(rows, null).map((m) => m.id)).toEqual(["a", "b", "c"]);
    expect(matterRows(rows, "b").map((m) => m.id)).toEqual(["b"]);
    expect(matterRows(rows, "zzz")).toEqual([]);
  });
  it("tones key dates and formats the task and hot-doc cells", () => {
    expect(keyDateTone(undefined)).toBeUndefined();
    expect(keyDateTone(0)).toBe("destructive");
    expect(keyDateTone(7)).toBe("destructive");
    expect(keyDateTone(30)).toBe("warning");
    expect(keyDateTone(31)).toBeUndefined();
    expect(taskCell({ openTasks: 5, overdueTasks: 2, myOpenTasks: 1 })).toEqual({ text: "5 (2 late)", late: true, title: "5 open tasks · 2 overdue · 1 yours" });
    expect(taskCell({ openTasks: 1, overdueTasks: 0, myOpenTasks: 0 })).toEqual({ text: "1", late: false, title: "1 open task" });
    expect(hotCell({ hotDocs: 3, docCount: 89 })).toEqual({ text: "3 / 89", hot: true });
    expect(hotCell({ hotDocs: 0, docCount: 0 })).toEqual({ text: "0 / 0", hot: false });
  });
  it("writes one quiet meta line", () => {
    expect(matterMeta({ caption: "Arb. Ref. 14/2024 (seat: New Delhi)", name: "Valsara v. Meridian", clientSide: "plaintiff", client: "Water District", status: "active" })).toBe("Arb. Ref. 14/2024 (seat: New Delhi) · Plaintiff · Water District");
    expect(matterMeta({ name: "Project Harbor", clientSide: "buyer", client: "Harbor Co.", status: "pre-suit" })).toBe("Project Harbor · Buyer · Harbor Co. · Pre-suit");
  });
});

describe("For you slot", () => {
  it("accepts the insights payload shapes and rejects junk", () => {
    const item = { id: "i1", title: "Arbitration filings up 40% in New Delhi" };
    expect(parseInsights({ insights: [item] })).toEqual([item]);
    expect(parseInsights({ items: [item, { id: 1 }, null] })).toEqual([item]);
    expect(parseInsights([item])).toEqual([item]);
    expect(parseInsights({ error: "no" })).toEqual([]);
    expect(parseInsights(null)).toEqual([]);
    expect(parseInsights("x")).toEqual([]);
  });
});

describe("Library filterbar mapping", () => {
  it("round-trips library filters through Filterbar values", () => {
    const values = filterValuesFrom({ type: "pdf", matterId: "m1", status: "draft", from: "2026-01-01", q: "ignored", sort: "name" });
    expect(values).toEqual({ type: "pdf", matterId: "m1", status: "draft", from: "2026-01-01" });
    const patch = filtersPatchFrom({ ...values, type: undefined, tag: ["contract"] });
    expect(patch).toEqual({ type: undefined, matterId: "m1", status: "draft", practiceArea: undefined, ownerId: undefined, tag: "contract", from: "2026-01-01", to: undefined });
  });
});
