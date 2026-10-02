import { beforeAll, describe, expect, it } from "vitest";
import { db, resetSqlite } from "@/lib/db";
import type { EditProposal } from "@/modules/office/shared/types";
import type { OfficeAgentContext } from "@/modules/office/shared/route-factory";
import { adjustFormulaForStructure, colToLetter, formulaReferences, iterateRange, letterToCol, offsetRef, parseA1, parseRange, rangeCells, rangeToA1, shiftFormula, tokenizeFormula } from "@/modules/office/sheet/a1";
import { autofillCell } from "@/modules/office/sheet/autofill";
import { SheetEngine, computeWorkbook, formulaErrors } from "@/modules/office/sheet/engine";
import { formatNumber, formatValue, isoToSerial, serialToISO } from "@/modules/office/sheet/format";
import { emptyWorkbook, normalizeWorkbook, parseInput, detectHeaderRow, currentRegion, usedRange, type Workbook } from "@/modules/office/sheet/model";
import { applyOp, filteredRows, opTarget, type SheetOp } from "@/modules/office/sheet/ops";
import { buildSnapshot, parseSnapshot, renderSnapshot, type SheetSnapshot } from "@/modules/office/sheet/snapshot";
import { sheetAgentTools } from "@/modules/office/sheet/agent-tools";
import { sheetInstructions, SHEET_SUGGESTIONS } from "@/modules/office/sheet/agent";
import { exportCsv, exportXlsx } from "@/modules/office/sheet/export";
import * as XLSX from "xlsx";
import { importDocument, xlsxToWorkbook } from "@/modules/office/sheet/import";
import { SHEET_TEMPLATES } from "@/modules/office/sheet/templates";
import { seedSheet } from "@/modules/office/sheet/seed";
import { conditionalStyles } from "@/modules/office/sheet/cell-render";

beforeAll(() => { resetSqlite(); });

function wbWith(ops: SheetOp[]): Workbook {
  return ops.reduce((wb, op) => applyOp(wb, op), emptyWorkbook());
}

function makeCtx(wb: Workbook, overrides: Partial<OfficeAgentContext<SheetSnapshot>> = {}) {
  const proposals: EditProposal[] = [];
  const snapshot = buildSnapshot(wb, computeWorkbook(wb), { title: "Test workbook" });
  const ctx: OfficeAgentContext<SheetSnapshot> = {
    mode: "draft", scope: null, research: false, snapshot, matter: null, docTitle: "Test workbook", context: {}, proposals, findings: [],
    emit: () => {},
    propose: (p) => { const full: EditProposal = { id: `p${proposals.length + 1}`, status: "pending", ...p }; proposals.push(full); return full; },
    finding: (f) => ({ id: "f", ...f }),
    ...overrides,
  };
  return { ctx, proposals, snapshot };
}

function tool(tools: ReturnType<typeof sheetAgentTools>, name: string) {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return (args: Record<string, unknown>) => (t.execute as (a: unknown, c: unknown) => unknown)(args, { emit: () => {}, state: {} });
}

describe("A1 utilities", () => {
  it("converts columns and parses references", () => {
    expect(colToLetter(0)).toBe("A"); expect(colToLetter(25)).toBe("Z"); expect(colToLetter(26)).toBe("AA"); expect(colToLetter(701)).toBe("ZZ"); expect(colToLetter(702)).toBe("AAA");
    expect(letterToCol("A")).toBe(0); expect(letterToCol("AA")).toBe(26); expect(letterToCol("aaa")).toBe(702);
    expect(parseA1("B4")).toMatchObject({ row: 3, col: 1, absRow: false, absCol: false });
    expect(parseA1("$C$10")).toMatchObject({ row: 9, col: 2, absRow: true, absCol: true });
    expect(parseA1("'Depo Schedule'!D2")).toMatchObject({ sheet: "Depo Schedule", row: 1, col: 3 });
    expect(() => parseA1("4B")).toThrow();
  });
  it("parses, normalizes and iterates ranges", () => {
    const r = parseRange("C3:A1");
    expect(rangeToA1(r)).toBe("A1:C3");
    expect(rangeCells(r)).toEqual(["A1", "B1", "C1", "A2", "B2", "C2", "A3", "B3", "C3"]);
    expect(Array.from(iterateRange(parseRange("B2"))).length).toBe(1);
    expect(parseRange("A:B", { maxRow: 10 }).end.row).toBe(9);
    expect(parseRange("2:3", { maxCol: 5 })).toMatchObject({ start: { row: 1, col: 0 }, end: { row: 2, col: 4 } });
    expect(parseRange("Sheet2!A1:B2").sheet).toBe("Sheet2");
  });
  it("offsets refs respecting anchors", () => {
    expect(offsetRef("B2", 1, 1)).toBe("C3");
    expect(offsetRef("$B2", 1, 1)).toBe("$B3");
    expect(offsetRef("B$2", 1, 1)).toBe("C$2");
    expect(offsetRef("A1", -1, 0)).toBeNull();
  });
  it("tokenizes and shifts formulas with relative refs, ranges, sheets and strings", () => {
    expect(tokenizeFormula('=SUM(A1:A3)+"A9"&Sheet2!B$1').filter((t) => t.kind === "ref").map((t) => t.text)).toEqual(["A1:A3", "Sheet2!B$1"]);
    expect(shiftFormula("=SUM(A1:A3)*$B$1+C2", 2, 1)).toBe("=SUM(B3:B5)*$B$1+D4");
    expect(shiftFormula("='Depo Schedule'!D2+LOG10(5)", 1, 0)).toBe("='Depo Schedule'!D3+LOG10(5)");
    expect(shiftFormula("=A1", -1, 0)).toBe("=#REF!");
    expect(shiftFormula("=SUM(A:A)", 0, 1)).toBe("=SUM(B:B)");
    expect(formulaReferences("=IF(A1>0,SUM(B1:B9),0)").map((r) => rangeToA1(r))).toEqual(["A1", "B1:B9"]);
  });
  it("adjusts formulas for row/column insertion and deletion", () => {
    const opts = { sheetName: "Sheet1", formulaSheet: "Sheet1" };
    expect(adjustFormulaForStructure("=SUM(A2:A10)+A12", { axis: "row", index: 4, count: 2, ...opts })).toBe("=SUM(A2:A12)+A14");
    expect(adjustFormulaForStructure("=SUM(A2:A10)", { axis: "row", index: 4, count: -2, ...opts })).toBe("=SUM(A2:A8)");
    expect(adjustFormulaForStructure("=A5*2", { axis: "row", index: 4, count: -1, ...opts })).toBe("=#REF!*2");
    expect(adjustFormulaForStructure("=Other!A5*2", { axis: "row", index: 4, count: -1, ...opts })).toBe("=Other!A5*2");
    expect(adjustFormulaForStructure("=B1+C1", { axis: "col", index: 1, count: 1, ...opts })).toBe("=C1+D1");
  });
});

describe("formatting", () => {
  it("formats numbers, currency, percent, accounting and dates", () => {
    expect(formatNumber(1234.5, "#,##0.00")).toBe("1,234.50");
    expect(formatNumber(1234.5, "$#,##0")).toBe("$1,235");
    expect(formatNumber(-1234.5, "$#,##0.00;($#,##0.00)")).toBe("($1,234.50)");
    expect(formatNumber(0.1234, "0.0%")).toBe("12.3%");
    expect(formatNumber(46115, "yyyy-mm-dd")).toBe("2026-04-03");
    expect(formatNumber(46115, "mmm d yyyy")).toBe("Apr 3 2026");
    expect(formatValue("2026-03-04", { numFmt: "m/d/yyyy" }, "d").text).toBe("3/4/2026");
    expect(formatValue("#DIV/0!", undefined).isError).toBe(true);
    expect(formatValue(1234.5678, undefined).text).toBe("1234.5678");
    expect(serialToISO(isoToSerial("2026-09-24")!)).toBe("2026-09-24");
  });
  it("parses typed input", () => {
    expect(parseInput("1,250.50")).toEqual({ v: 1250.5, t: "n" });
    expect(parseInput("$1,250")).toEqual({ v: 1250, t: "n" });
    expect(parseInput("12.5%")).toEqual({ v: 0.125, t: "n" });
    expect(parseInput("3/4/2026")).toEqual({ v: "2026-03-04", t: "d" });
    expect(parseInput("TRUE")).toEqual({ v: true, t: "b" });
    expect(parseInput("=A1+1")).toEqual({ f: "=A1+1" });
    expect(parseInput("Smith v. Jones")).toEqual({ v: "Smith v. Jones", t: "s" });
  });
});

describe("engine", () => {
  it("evaluates formulas, cross-sheet refs, named ranges and errors", () => {
    let wb = wbWith([
      { type: "set_cells", cells: [{ ref: "A1", value: 10 }, { ref: "A2", value: 20 }, { ref: "A3", formula: "=SUM(A1:A2)" }, { ref: "B1", formula: "=A1/0" }, { ref: "B2", formula: "=NOPE(1)" }, { ref: "C1", value: "2026-03-04", type: "d" }, { ref: "C2", formula: "=C1+30" }, { ref: "D1", formula: "=Total*2" }] },
      { type: "add_sheet", name: "Fees" },
      { type: "set_cells", sheet: "Fees", cells: [{ ref: "A1", formula: "=Sheet1!A3*0.3333" }] },
      { type: "add_named_range", name: "Total", ref: "Sheet1!A3" },
    ]);
    const engine = new SheetEngine();
    let c = engine.sync(wb);
    expect(c["sh_1"].A3.v).toBe(30);
    expect(c["sh_1"].B1.v).toBe("#DIV/0!");
    expect(c["sh_1"].B2.v).toBe("#NAME?");
    expect(c["sh_1"].C2).toEqual({ v: 46115, t: "d" });
    expect(c["sh_1"].D1.v).toBe(60);
    expect(c[wb.sheets[1].id].A1.v).toBeCloseTo(9.999, 3);
    // incremental sync after edit
    wb = applyOp(wb, { type: "set_cells", sheet: "Sheet1", cells: [{ ref: "A1", value: 5 }] });
    c = engine.sync(wb);
    expect(c["sh_1"].A3.v).toBe(25);
    expect(c["sh_1"].D1.v).toBe(50);
    // insert a row above row 2: refs, named range and cross-sheet formulas follow
    wb = applyOp(wb, { type: "insert_rows", sheet: "Sheet1", index: 1, count: 1 });
    expect(wb.sheets[0].cells.A4.f).toBe("=SUM(A1:A3)");
    expect(wb.namedRanges.Total).toBe("Sheet1!A4");
    expect(wb.sheets[1].cells.A1.f).toBe("=Sheet1!A4*0.3333");
    c = engine.sync(wb);
    expect(c["sh_1"].A4.v).toBe(25);
    expect(engine.evaluate("Sheet1", "=A1*10").v).toBe(50);
    expect(engine.evaluate("Sheet1", "=SUM(").t).toBe("e");
    expect(formulaErrors(wb, c).map((e) => e.ref).sort()).toEqual(["B1", "B3"]); // B2 moved to B3 after the row insert
    engine.destroy();
  });
  it("rebuilds after renaming a sheet and keeps formulas pointing at it", () => {
    let wb = wbWith([{ type: "add_sheet", name: "Data" }, { type: "set_cells", sheet: "Data", cells: [{ ref: "A1", value: 7 }] }, { type: "set_cells", sheet: "Sheet1", cells: [{ ref: "A1", formula: "=Data!A1*2" }] }, { type: "rename_sheet", sheet: "Data", name: "Inputs 2026" }]);
    expect(wb.sheets[0].cells.A1.f).toBe("='Inputs 2026'!A1*2");
    expect(computeWorkbook(wb)["sh_1"].A1.v).toBe(14);
    wb = applyOp(wb, { type: "delete_sheet", sheet: "Inputs 2026" });
    expect(computeWorkbook(wb)["sh_1"].A1.t).toBe("e");
  });
});

describe("ops", () => {
  it("fills, sorts, styles, merges, filters and builds tables", () => {
    let wb = wbWith([{ type: "build_table", anchor: "A1", headers: ["Claimant", "Amount", "Due"], rows: [["Oberoi", 125000, "2026-07-02"], ["Alvarez", 350000, "2026-08-14"], ["Bennett", 210000, "2026-09-03"]], total_row: true, number_format: "$#,##0.00" }]);
    const s = wb.sheets[0];
    expect(s.cells.A1.v).toBe("Claimant");
    expect(wb.styles[s.cells.A1.s!]).toMatchObject({ bold: true, fill: "#1F3A5F", color: "#FFFFFF" });
    expect(s.cells.B5.f).toBe("=SUM(B2:B4)");
    expect(s.freeze.rows).toBe(1);
    expect(computeWorkbook(wb)[s.id].B5.v).toBe(685000);
    wb = applyOp(wb, { type: "sort_range", sheet: "Sheet1", range: "A1:C4", by: "B", order: "desc", has_header: true });
    expect([wb.sheets[0].cells.A2.v, wb.sheets[0].cells.A3.v, wb.sheets[0].cells.A4.v]).toEqual(["Alvarez", "Bennett", "Oberoi"]);
    wb = applyOp(wb, { type: "fill_range", sheet: "Sheet1", range: "D2:D4", pattern: "=B2*0.3333" });
    expect(wb.sheets[0].cells.D4.f).toBe("=B4*0.3333");
    wb = applyOp(wb, { type: "set_formula_column", sheet: "Sheet1", column: "E", from_row: 2, to_row: 4, template: "=B{row}-D{row}" });
    expect(wb.sheets[0].cells.E3.f).toBe("=B3-D3");
    wb = applyOp(wb, { type: "merge_cells", sheet: "Sheet1", range: "A7:C7" });
    expect(wb.sheets[0].merges).toEqual(["A7:C7"]);
    wb = applyOp(wb, { type: "add_filter", sheet: "Sheet1", range: "A1:E4" });
    wb = applyOp(wb, { type: "set_filter_criteria", sheet: "Sheet1", column: "B", criteria: { condition: { op: "gt", value: 200000 } } });
    const hidden = filteredRows(wb.sheets[0], () => undefined);
    expect(Array.from(hidden)).toEqual([3]);
    wb = applyOp(wb, { type: "conditional_format", sheet: "Sheet1", range: "C2:C4", rule: { kind: "dueBefore", date: "2026-08-20" }, style: { fill: "#FDE2E1" } });
    const cf = conditionalStyles(wb.sheets[0], computeWorkbook(wb));
    expect(cf.get("C2")).toBeDefined();
    expect(cf.get("C3")).toBeUndefined(); // Bennett sorted second → 2026-09-03? sorted desc by amount: Alvarez(8/14), Bennett(9/3), Oberoi(7/2)
    expect(cf.get("C4")).toBeDefined();
    wb = applyOp(wb, { type: "delete_cols", sheet: "Sheet1", index: 3, count: 1 });
    expect(wb.sheets[0].cells.D3.f).toBe("=B3-#REF!");
    expect(opTarget(wb, { type: "set_cells", cells: [{ ref: "B2" }, { ref: "C5" }] })).toEqual({ sheet: "Sheet1", range: "B2:C5" });
  });
  it("autofills numbers, dates, text series and formulas via the fill handle op", () => {
    let wb = wbWith([{ type: "set_cells", cells: [{ ref: "A1", value: 1 }, { ref: "A2", value: 3 }, { ref: "B1", value: "2026-01-31", type: "d" }, { ref: "C1", value: "Volume 1" }, { ref: "D1", value: "Jan" }, { ref: "E1", formula: "=A1*2" }, { ref: "F1", value: 7 }] }]);
    wb = applyOp(wb, { type: "autofill", sheet: "Sheet1", source: "A1:A2", target: "A3:A5" });
    expect([wb.sheets[0].cells.A3.v, wb.sheets[0].cells.A4.v, wb.sheets[0].cells.A5.v]).toEqual([5, 7, 9]);
    wb = applyOp(wb, { type: "autofill", sheet: "Sheet1", source: "B1", target: "B2:B3" });
    expect([wb.sheets[0].cells.B2.v, wb.sheets[0].cells.B3.v]).toEqual(["2026-02-01", "2026-02-02"]);
    wb = applyOp(wb, { type: "autofill", sheet: "Sheet1", source: "C1", target: "C2:C3" });
    expect(wb.sheets[0].cells.C3.v).toBe("Volume 3");
    wb = applyOp(wb, { type: "autofill", sheet: "Sheet1", source: "D1", target: "D2:D3" });
    expect([wb.sheets[0].cells.D2.v, wb.sheets[0].cells.D3.v]).toEqual(["Feb", "Mar"]);
    wb = applyOp(wb, { type: "autofill", sheet: "Sheet1", source: "E1", target: "E2:E3" });
    expect(wb.sheets[0].cells.E3.f).toBe("=A3*2");
    wb = applyOp(wb, { type: "autofill", sheet: "Sheet1", source: "F1", target: "F2:F3" });
    expect(wb.sheets[0].cells.F3.v).toBe(7);
    wb = applyOp(wb, { type: "autofill", sheet: "Sheet1", source: "A4:A5", target: "A1:A3" }); // fill upwards
    expect(wb.sheets[0].cells.A1.v).toBe(1);
    expect(autofillCell([{ v: 10 }, { v: 20 }], 0, "col", 1)).toMatchObject({ v: 30 });
  });
  it("copies blocks with relative formula shifting and handles clear/undo-able replace", () => {
    let wb = wbWith([{ type: "set_cells", cells: [{ ref: "A1", value: 2 }, { ref: "B1", formula: "=A1*3" }] }]);
    wb = applyOp(wb, { type: "paste_block", sheet: "Sheet1", anchor: "A3", block: [[{ v: 2 }, { f: "=A1*3" }]], origin: { row: 0, col: 0 } });
    expect(wb.sheets[0].cells.B3.f).toBe("=A3*3");
    wb = applyOp(wb, { type: "clear_range", sheet: "Sheet1", range: "A1:B1", what: "contents" });
    expect(wb.sheets[0].cells.A1).toBeUndefined();
    expect(detectHeaderRow(wbWith([{ type: "set_cells", cells: [{ ref: "A1", value: "Name" }, { ref: "B1", value: "Amount" }, { ref: "A2", value: "X" }, { ref: "B2", value: 5 }] }]).sheets[0], parseRange("A1:B2"))).toBe(0);
    expect(rangeToA1(currentRegion(wbWith([{ type: "set_cells", cells: [{ ref: "B2", value: 1 }, { ref: "C2", value: 1 }, { ref: "B3", value: 1 }, { ref: "E5", value: 1 }] }]).sheets[0], 1, 1))).toBe("B2:C3");
    expect(usedRange(emptyWorkbook().sheets[0])).toBeNull();
  });
});

describe("snapshot", () => {
  it("normalizes, recomputes and renders compactly", () => {
    const wb = wbWith([{ type: "build_table", anchor: "A1", headers: ["Phase", "Fees"], rows: [["Pleadings", 12000], ["Discovery", 48000]], total_row: true }]);
    const snap = parseSnapshot({ title: "Budget", workbook: wb, activeSheet: "Sheet1", selection: { sheet: "Sheet1", range: "B2:B3" } });
    expect(snap.computed["sh_1"].B4.v).toBe(60000);
    const text = renderSnapshot(snap, null);
    expect(text).toContain('WORKBOOK "Budget"');
    expect(text).toContain("headers (row 1)");
    expect(text).toContain("{=SUM(B2:B3)}");
    expect(text).toContain("SELECTION: Sheet1!B2:B3");
    expect(() => parseSnapshot({})).toThrow();
    expect(normalizeWorkbook({ sheets: [{ name: "X", cells: { a1: { v: 1 }, B2: { f: "A1*2" } } }] }).sheets[0].cells).toEqual({ A1: { v: 1 }, B2: { f: "=A1*2" } });
  });
});

describe("agent tools", () => {
  it("reads overview, headers, ranges and profiles data", () => {
    const wb = wbWith([{ type: "build_table", anchor: "A1", headers: ["Witness", "Date", "Hours"], rows: [["Hegde", "2026-10-06", 7], ["Vasudevan", "2026-10-09", 6.5], ["Prasad", "2026-09-18", 7]], total_row: true }]);
    const { ctx } = makeCtx(wb);
    const tools = sheetAgentTools(ctx);
    const overview = tool(tools, "get_sheet_overview")({}) as { headers: { col: string; name: string }[]; usedRange: string; columns: { col: string; numbers: number }[] };
    expect(overview.headers.map((h) => h.name)).toEqual(["Witness", "Date", "Hours"]);
    expect(overview.usedRange).toBe("A1:C5");
    const range = tool(tools, "get_range")({ range: "C2:C5" }) as { rows: { C?: { v: unknown; f?: string } }[] };
    expect(range.rows[3].C?.f).toBe("=SUM(C2:C4)");
    expect(range.rows[3].C?.v).toBe(20.5);
    const found = tool(tools, "find_cells")({ query: "vasudevan" }) as { count: number; hits: { ref: string }[] };
    expect(found.hits[0].ref).toBe("A3");
    const desc = tool(tools, "describe_data")({ range: "A1:C4", has_header: true }) as { columns: { col: string; numbers: number; dates: number }[] };
    expect(desc.columns[2].numbers).toBe(3);
    expect(desc.columns[1].dates).toBe(3);
    const sel = tool(tools, "get_selection")({}) as { selection: null };
    expect(sel.selection).toBeNull();
  });
  it("edit tools mutate the snapshot and produce proposals carrying ops", () => {
    const wb = wbWith([{ type: "set_cells", cells: [{ ref: "A1", value: "Item" }, { ref: "B1", value: "Amount" }, { ref: "A2", value: "Filing" }, { ref: "B2", value: 1245 }, { ref: "A3", value: "Experts" }, { ref: "B3", value: 18500 }] }]);
    const { ctx, proposals, snapshot } = makeCtx(wb);
    const tools = sheetAgentTools(ctx);
    const r1 = tool(tools, "set_cells")({ cells: [{ ref: "A4", value: "Total", style: { bold: true } }, { ref: "B4", formula: "=SUM(B2:B3)" }] }) as { ok: boolean; proposal: string; target: string };
    expect(r1.ok).toBe(true);
    expect(r1.target).toBe("Sheet1!A4:B4");
    expect(snapshot.workbook.sheets[0].cells.B4.f).toBe("=SUM(B2:B3)");
    expect(snapshot.computed["sh_1"].B4.v).toBe(19745);
    const p1 = proposals[0];
    expect(p1.kind).toBe("set_cells");
    expect((p1.payload as { op: SheetOp }).op.type).toBe("set_cells");
    tool(tools, "fill_range")({ range: "C2:C3", pattern: "=B2/$B$4" });
    expect(snapshot.workbook.sheets[0].cells.C3.f).toBe("=B3/$B$4");
    tool(tools, "sort_range")({ range: "A1:C3", by: "B", order: "desc", has_header: true });
    expect(snapshot.workbook.sheets[0].cells.A2.v).toBe("Experts");
    expect(snapshot.workbook.sheets[0].cells.C2.f).toBe("=B2/$B$4");
    tool(tools, "create_chart")({ type: "bar", title: "Costs", range: "B1:B3", category_range: "A2:A3" });
    expect(snapshot.workbook.sheets[0].charts).toHaveLength(1);
    tool(tools, "set_style")({ range: "A1:C1", style: { bold: true, fill: "#1F3A5F", color: "#FFFFFF" } });
    tool(tools, "set_number_format")({ range: "B2:B4", numFmt: "$#,##0.00" });
    tool(tools, "set_freeze_panes")({ rows: 1 });
    tool(tools, "add_conditional_format")({ range: "B2:B3", rule: { kind: "gt", value: 10000 }, style: { fill: "#FDE2E1" } });
    tool(tools, "create_named_range")({ name: "CostTotal", ref: "Sheet1!B4" });
    tool(tools, "add_sheet")({ name: "Notes" });
    expect(snapshot.activeSheet).toBe("Notes");
    tool(tools, "set_sheet_name")({ name: "Assumptions" });
    expect(snapshot.workbook.sheets[1].name).toBe("Assumptions");
    const c = tool(tools, "add_comment")({ cell: "B4", sheet: "Sheet1", text: "Confirm expert invoice total" }) as { anchor: string };
    expect(c.anchor).toBe("Sheet1!B4");
    const bt = tool(tools, "build_table")({ sheet: "Sheet1", anchor: "E1", headers: ["Phase", "Hours", "Rate", "Fees"], rows: [["Depos", 40, 895, "=F2*G2"], ["Trial", 80, 895, "=F3*G3"]], total_row: true, number_format: "$#,##0" }) as { ok: boolean };
    expect(bt.ok).toBe(true);
    expect(snapshot.computed["sh_1"].H4.v).toBe(107400);
    const v = tool(tools, "validate_formulas")({}) as { errors: unknown[]; warnings: { ref: string; issue: string }[] };
    expect(v.errors).toEqual([]);
    expect(proposals.length).toBeGreaterThanOrEqual(13);
    expect(proposals.every((p) => p.kind === "add_comment" || (p.payload as { op?: SheetOp }).op)).toBe(true);
    expect(() => tool(tools, "delete_sheet" as never)).toThrow();
    // applying the same ops on the client reproduces the server state
    const clientWb = proposals.filter((p) => p.kind !== "add_comment").reduce((acc, p) => applyOp(acc, (p.payload as { op: SheetOp }).op), wb);
    expect(clientWb.sheets[0].cells.H4.f).toBe(snapshot.workbook.sheets[0].cells.H4.f);
    expect(clientWb.sheets[1].name).toBe("Assumptions");
  });
  it("transcribes image tables and validates formulas with warnings", () => {
    const wb = wbWith([{ type: "set_cells", cells: [{ ref: "A1", value: 100 }, { ref: "B1", formula: "=A1*1.0825" }, { ref: "B2", formula: "=A2*1.0825" }, { ref: "B3", formula: "=A3*1.0825" }, { ref: "B4", formula: "=A4+50" }, { ref: "B5", formula: "=A5*1.0825" }, { ref: "B6", formula: "=A6*1.0825" }] }]);
    const { ctx, snapshot } = makeCtx(wb);
    const tools = sheetAgentTools(ctx);
    tool(tools, "transcribe_image_to_cells")({ anchor: "D1", headers: ["Bates", "Pages"], rows: [["MFC-0000001", 12], ["MFC-0000013", 4]] });
    expect(snapshot.workbook.sheets[0].cells.E3.v).toBe(4);
    const v = tool(tools, "validate_formulas")({}) as { warnings: { ref: string; issue: string }[] };
    expect(v.warnings.some((w) => w.ref === "B4" && w.issue.includes("inconsistent"))).toBe(true);
    expect(v.warnings.some((w) => w.issue.includes("hardcoded"))).toBe(true);
    expect(sheetInstructions(ctx)).toContain("Settlement allocation");
    expect(sheetInstructions(ctx)).toBe(sheetInstructions(makeCtx(wbWith([])).ctx)); // static, cacheable prefix
    expect(SHEET_SUGGESTIONS.draft.length).toBeGreaterThanOrEqual(6);
  });
});

describe("XLSX export/import", () => {
  it("round-trips values, formulas, formats, widths, merges, freeze and names", async () => {
    let wb = wbWith([
      { type: "build_table", anchor: "A1", headers: ["Claimant", "Amount", "Settled"], rows: [["Oberoi", 125000, "2026-07-02"], ["Alvarez", 350000, "2026-08-14"]], total_row: true, number_format: "$#,##0.00" },
      { type: "merge_cells", range: "A7:C7" },
      { type: "set_cells", cells: [{ ref: "A7", value: "Notes", style: { bold: true } }, { ref: "C2", style: { numFmt: "yyyy-mm-dd" } }, { ref: "C3", style: { numFmt: "yyyy-mm-dd" } }] },
      { type: "set_column_width", columns: ["A"], width: 180 },
      { type: "add_named_range", name: "GrandTotal", ref: "Sheet1!B4" },
      { type: "add_sheet", name: "Fees" },
      { type: "set_cells", sheet: "Fees", cells: [{ ref: "A1", formula: "=Sheet1!B4*0.3333" }] },
    ]);
    wb = applyOp(wb, { type: "add_chart", sheet: "Sheet1", chart: { type: "bar", title: "Amounts", range: "B1:B3", categoryRange: "A2:A3" } });
    const bytes = exportXlsx(wb);
    // independent reader (SheetJS) sees the same structure the direct writer produced
    const book = XLSX.read(bytes, { type: "array", cellFormula: true, cellNF: true });
    expect(book.SheetNames).toEqual(["Sheet1", "Fees"]);
    expect(book.Sheets.Sheet1.B4.f).toBe("SUM(B2:B3)");
    expect(book.Sheets.Sheet1.B4.v).toBe(475000);
    expect(book.Sheets.Sheet1.B2.z).toBe("$#,##0.00");
    expect(book.Sheets.Sheet1["!merges"]?.length).toBe(1);
    expect(bytes.byteLength).toBeGreaterThan(1000);
    const imported = await importDocument(bytes, "tracker.xlsx");
    const back = imported.content as Workbook;
    expect(imported.title).toBe("tracker");
    expect(back.sheets.map((s) => s.name)).toEqual(["Sheet1", "Fees"]);
    const s1 = back.sheets[0];
    expect(s1.cells.A1.v).toBe("Claimant");
    expect(s1.cells.B2.v).toBe(125000);
    expect(s1.cells.B4.f).toBe("=SUM(B2:B3)");
    expect(back.styles[s1.cells.B2.s!].numFmt).toBe("$#,##0.00");
    expect(s1.cells.C2).toMatchObject({ v: "2026-07-02", t: "d" });
    expect(s1.merges).toEqual(["A7:C7"]);
    expect(s1.freeze).toEqual({ rows: 1, cols: 0 });
    expect(s1.colWidths.A).toBe(180);
    expect(back.namedRanges.GrandTotal).toBe("Sheet1!B4");
    expect(back.sheets[1].cells.A1.f).toBe("=Sheet1!B4*0.3333");
    expect(computeWorkbook(back)[back.sheets[1].id].A1.v).toBeCloseTo(158317.5, 1);
    expect(s1.charts.map((c) => ({ type: c.type, title: c.title, range: c.range, categoryRange: c.categoryRange }))).toEqual([{ type: "bar", title: "Amounts", range: "B1:B3", categoryRange: "A2:A3" }]);
    const csv = exportCsv(wb, "Sheet1");
    expect(csv.split("\n")[3]).toBe("Total,475000,");
    const fromCsv = await importDocument(new TextEncoder().encode("name,amount\nA,1\nB,2\n"), "x.csv");
    expect((fromCsv.content as Workbook).sheets[0].cells.B3.v).toBe(2);
    expect(xlsxToWorkbook(book).sheets[0].cells.A1.v).toBe("Claimant");
    expect(imported.meta?.reader).toBe("ooxml");
  });
});

describe("templates", () => {
  it("has 10 templates that build and compute without formula errors", () => {
    expect(SHEET_TEMPLATES.length).toBe(10);
    for (const t of SHEET_TEMPLATES) {
      const wb = t.build({}) as Workbook;
      const errs = formulaErrors(wb, computeWorkbook(wb));
      expect(errs, t.id).toEqual([]);
      expect(Object.values(wb.sheets[0].cells).filter((c) => c.f).length, t.id).toBeGreaterThan(2);
    }
    const alloc = SHEET_TEMPLATES.find((t) => t.id === "sheet-settlement-allocation")!.build({}) as Workbook;
    const c = computeWorkbook(alloc);
    const okCell = Object.entries(alloc.sheets[0].cells).find(([, cell]) => cell.f?.includes("MISMATCH"))![0];
    expect(c[alloc.sheets[0].id][okCell].v).toBe("OK");
  });
});

describe("seed", () => {
  it("seeds 5 workbooks with versions, comments and library items, idempotently", () => {
    const d = db();
    seedSheet(d);
    const docs = d.officeDocs.find((x) => x.kind === "sheet" && x.id.startsWith("ws_"));
    expect(docs.length).toBe(5);
    for (const doc of docs) {
      const wb = doc.content as Workbook;
      expect(formulaErrors(wb, computeWorkbook(wb))).toEqual([]);
      expect(d.officeVersions.count((v) => v.docId === doc.id)).toBeGreaterThanOrEqual(3);
      expect(d.officeComments.count((c) => c.docId === doc.id)).toBeGreaterThanOrEqual(1);
      expect(d.library.count((l) => l.officeDocId === doc.id)).toBe(1);
      expect(doc.matterId).toBeTruthy();
    }
    seedSheet(d);
    expect(d.officeDocs.count((x) => x.kind === "sheet" && x.id.startsWith("ws_"))).toBe(5);
    expect(d.library.count((l) => l.type === "xlsx" && l.id.startsWith("lib_ws_"))).toBe(5);
  });
});
