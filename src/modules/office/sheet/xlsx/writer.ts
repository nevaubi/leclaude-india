/**
 * Direct OOXML writer: Workbook model → .xlsx bytes, with cell styles,
 * number formats, cached values from the formula engine and every sheet
 * feature the model carries.
 *
 * Two modes:
 * - fresh: a complete, minimal SpreadsheetML package for workbooks created in the app;
 * - package-preserving: when the workbook was imported (wb.xlsxSource) and the
 *   original package bytes are supplied, every part is copied byte-for-byte
 *   (same compressed bytes) except the worksheets whose model changed, the
 *   workbook part when sheets/names changed, and styles.xml when new styles
 *   are needed (appended, so original cellXfs stay valid). Themes, pivot
 *   caches, external links, tables, printer settings, custom XML… survive.
 */
import { colToLetter, letterToCol, normalizeRange, parseA1, parseRange, quoteSheet, rangeToA1, toA1 } from "../a1";
import { computeWorkbook, type Computed } from "../engine";
import { isDateFormat, isoToSerial } from "../format";
import { hashValue, sheetFingerprint, workbookFingerprint } from "../hash";
import { DEFAULT_COL_WIDTH, DEFAULT_ROW_HEIGHT, styleKey, usedRange, type Cell, type CellStyle, type CFRule, type ConditionalFormat, type DataValidation, type PageSetup, type Sheet, type SheetChart, type Workbook } from "../model";
import { anchorXml, buildChartXml, chartFrameXml, DRAWING_OPEN, pxToAnchor } from "./charts";
import { chartFingerprint, headerToExcel, Package, parseRels, pxToPt, pxToWidth, REL, relsPathFor, type Rel } from "./reader";
import { parseStyles, parseTheme, StylesBuilder } from "./styles";
import { makeEntry, writeZip, type ZipEntry } from "./zip";
import { BRAND } from "@/lib/brand";
import { attrStr, el, esc, escText, nsDecls, parseXml, children, child, attrs, splitTopLevel, text, XML_DECL } from "./xml";

const NS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships";

export const CT = {
  workbook: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
  workbookMacro: "application/vnd.ms-excel.sheet.macroEnabled.main+xml",
  worksheet: "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml",
  styles: "application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml",
  sharedStrings: "application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml",
  drawing: "application/vnd.openxmlformats-officedocument.drawing+xml",
  chart: "application/vnd.openxmlformats-officedocument.drawingml.chart+xml",
  comments: "application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml",
  vml: "application/vnd.openxmlformats-officedocument.vmlDrawing",
  core: "application/vnd.openxmlformats-package.core-properties+xml",
  app: "application/vnd.openxmlformats-officedocument.extended-properties+xml",
  rels: "application/vnd.openxmlformats-package.relationships+xml",
};

/** Canonical CT_Worksheet child order. */
const WS_ORDER = ["sheetPr", "dimension", "sheetViews", "sheetFormatPr", "cols", "sheetData", "sheetCalcPr", "sheetProtection", "protectedRanges", "scenarios", "autoFilter", "sortState", "dataConsolidate", "customSheetViews", "mergeCells", "phoneticPr", "conditionalFormatting", "dataValidations", "hyperlinks", "printOptions", "pageMargins", "pageSetup", "headerFooter", "rowBreaks", "colBreaks", "customProperties", "cellWatches", "ignoredErrors", "smartTags", "drawing", "legacyDrawing", "legacyDrawingHF", "drawingHF", "picture", "oleObjects", "controls", "webPublishItems", "tableParts", "extLst"];
const WS_OWNED = new Set(["sheetPr", "dimension", "sheetViews", "sheetFormatPr", "cols", "sheetData", "autoFilter", "mergeCells", "conditionalFormatting", "dataValidations", "hyperlinks", "printOptions", "pageMargins", "pageSetup", "headerFooter", "drawing", "legacyDrawing"]);

// ------------------------------------------------------------------ formulas

/** Functions that Excel stores with a _xlfn. (or _xlfn._xlws.) prefix in the file format. */
const FUTURE_FNS = new Set(["XLOOKUP", "XMATCH", "IFS", "SWITCH", "MAXIFS", "MINIFS", "CONCAT", "TEXTJOIN", "IFNA", "DAYS", "ISOWEEKNUM", "UNIQUE", "SEQUENCE", "RANDARRAY", "LET", "LAMBDA", "STDEV.S", "STDEV.P", "VAR.S", "VAR.P", "PERCENTILE.INC", "PERCENTILE.EXC", "QUARTILE.INC", "QUARTILE.EXC", "CEILING.MATH", "FLOOR.MATH", "AGGREGATE", "NETWORKDAYS.INTL", "WORKDAY.INTL", "FORECAST.LINEAR", "TEXTBEFORE", "TEXTAFTER", "TEXTSPLIT", "VSTACK", "HSTACK", "TOCOL", "TOROW", "CHOOSECOLS", "CHOOSEROWS", "TAKE", "DROP", "EXPAND", "WRAPROWS", "WRAPCOLS", "ARRAYTOTEXT", "VALUETOTEXT", "NORM.DIST", "NORM.INV", "NORM.S.DIST", "T.TEST", "MODE.SNGL", "RANK.EQ", "RANK.AVG", "COVARIANCE.S", "COVARIANCE.P", "BITAND", "BITOR", "BITXOR", "IMAGE", "ARABIC", "BASE", "DECIMAL", "SHEET", "SHEETS", "FORMULATEXT", "ISFORMULA", "NUMBERVALUE", "UNICHAR", "UNICODE", "XOR", "COT", "CSC", "SEC", "ACOT", "DAYS360"]);
const XLWS_FNS = new Set(["FILTER", "SORT", "SORTBY"]);

function mapFunctions(formula: string, fn: (name: string) => string): string {
  let out = "", i = 0;
  while (i < formula.length) {
    const ch = formula[i];
    if (ch === '"') { let j = i + 1; while (j < formula.length) { if (formula[j] === '"') { if (formula[j + 1] === '"') { j += 2; continue; } break; } j++; } out += formula.slice(i, j + 1); i = j + 1; continue; }
    if (ch === "'") { let j = i + 1; while (j < formula.length) { if (formula[j] === "'") { if (formula[j + 1] === "'") { j += 2; continue; } break; } j++; } out += formula.slice(i, j + 1); i = j + 1; continue; }
    const m = /^[A-Za-z_][A-Za-z0-9_.]*(?=\()/.exec(formula.slice(i));
    if (m && !/[A-Za-z0-9_.!$]/.test(formula[i - 1] ?? "")) { out += fn(m[0]); i += m[0].length; continue; }
    out += ch; i++;
  }
  return out;
}

/** Model formula ("=XLOOKUP(...)") → file formula ("_xlfn.XLOOKUP(...)"). */
export function toFileFormula(f: string): string {
  const body = f.startsWith("=") ? f.slice(1) : f;
  return mapFunctions(body, (n) => { const u = n.toUpperCase(); return XLWS_FNS.has(u) ? `_xlfn._xlws.${n}` : FUTURE_FNS.has(u) ? `_xlfn.${n}` : n; });
}

function absolutize(ref: string): string {
  const bang = ref.lastIndexOf("!");
  const prefix = bang >= 0 ? ref.slice(0, bang + 1) : "";
  const body = bang >= 0 ? ref.slice(bang + 1) : ref;
  return prefix + body.replace(/\$?([A-Za-z]{1,3})\$?(\d+)/g, "$$$1$$$2");
}

const EXCEL_ERRORS = new Set(["#NULL!", "#DIV/0!", "#VALUE!", "#REF!", "#NAME?", "#NUM!", "#N/A", "#SPILL!", "#CALC!"]);

// ------------------------------------------------------------------ string table

interface Strings { ref(s: string): { t: "s"; v: number } | { t: "inlineStr"; xml: string } }

class FreshStrings implements Strings {
  list: string[] = [];
  map = new Map<string, number>();
  count = 0;
  ref(s: string) {
    this.count++;
    let i = this.map.get(s);
    if (i === undefined) { i = this.list.length; this.list.push(s); this.map.set(s, i); }
    return { t: "s" as const, v: i };
  }
  toXml(): string {
    return `${XML_DECL}<sst xmlns="${NS_MAIN}" count="${this.count}" uniqueCount="${this.list.length}">${this.list.map((s) => `<si><t xml:space="preserve">${escText(s)}</t></si>`).join("")}</sst>`;
  }
}

/** Preserve mode: reuse the original sst entry when the text matches (keeps rich text), else write an inline string. */
class PreservedStrings implements Strings {
  constructor(private map: Map<string, number>) {}
  ref(s: string) {
    const i = this.map.get(s);
    if (i !== undefined) return { t: "s" as const, v: i };
    return { t: "inlineStr" as const, xml: `<is><t xml:space="preserve">${escText(s)}</t></is>` };
  }
}

// ------------------------------------------------------------------ helpers

interface RelOut { id: string; type: string; target: string; external?: boolean }
interface Part { name: string; data: string; ct?: string }

function relsXml(rels: RelOut[]): string {
  return `${XML_DECL}<Relationships xmlns="${NS_PKG_REL}">${rels.map((r) => `<Relationship${attrStr({ Id: r.id, Type: r.type, Target: r.target, TargetMode: r.external ? "External" : undefined })}/>`).join("")}</Relationships>`;
}

/** Relative target from a part's directory to another part (both package paths without a leading slash). */
function relTarget(fromPart: string, toPart: string): string {
  const from = fromPart.split("/").slice(0, -1);
  const to = toPart.split("/");
  let i = 0;
  while (i < from.length && i < to.length - 1 && from[i] === to[i]) i++;
  return [...Array(from.length - i).fill(".."), ...to.slice(i)].join("/");
}

function nextRelId(rels: RelOut[]): string {
  let n = rels.length + 1;
  const used = new Set(rels.map((r) => r.id));
  while (used.has(`rId${n}`)) n++;
  return `rId${n}`;
}

function uniquePart(existing: Set<string>, pattern: (n: number) => string): string {
  let n = 1;
  while (existing.has(pattern(n))) n++;
  const name = pattern(n);
  existing.add(name);
  return name;
}

function effectivePage(wb: Workbook, sheet: Sheet): PageSetup {
  const base = (wb.pageSetup ?? {}) as PageSetup;
  const merged: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(sheet.pageSetup ?? {})) { if (v === null) delete merged[k]; else merged[k] = v; }
  merged.margins = { ...{ top: 0.75, right: 0.7, bottom: 0.75, left: 0.7 }, ...(base.margins ?? {}), ...(sheet.pageSetup?.margins ?? {}) };
  return merged as unknown as PageSetup;
}

const PAPER_ID: Record<string, number> = { letter: 1, legal: 5, a4: 9, tabloid: 3 };

function cfvoXml(s: { type: string; value?: string }): string { return el("cfvo", { type: s.type, val: s.value }); }
function rgb(hex: string): string { return `FF${hex.replace("#", "").toUpperCase().padStart(6, "0").slice(-6)}`; }

function cfRuleXml(cf: ConditionalFormat, priority: number, dxf: () => number, topLeft: string, fresh: boolean): string {
  const r: CFRule = cf.rule;
  const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const base = { priority, stopIfTrue: cf.stopIfTrue || undefined };
  const F = (fs: string[]) => fs.map((f) => `<formula>${esc(toFileFormula(f))}</formula>`).join("");
  switch (r.kind) {
    case "gt": return el("cfRule", { type: "cellIs", dxfId: dxf(), ...base, operator: "greaterThan" }, F([String(r.value)]));
    case "lt": return el("cfRule", { type: "cellIs", dxfId: dxf(), ...base, operator: "lessThan" }, F([String(r.value)]));
    case "between": return el("cfRule", { type: "cellIs", dxfId: dxf(), ...base, operator: "between" }, F([String(r.min), String(r.max)]));
    case "eq": return el("cfRule", { type: "cellIs", dxfId: dxf(), ...base, operator: "equal" }, F([typeof r.value === "number" ? String(r.value) : typeof r.value === "boolean" ? (r.value ? "TRUE" : "FALSE") : q(String(r.value ?? ""))]));
    case "contains": return el("cfRule", { type: "containsText", dxfId: dxf(), ...base, operator: "containsText", text: r.text }, F([`NOT(ISERROR(SEARCH(${q(r.text)},${topLeft})))`]));
    case "blank": return el("cfRule", { type: "containsBlanks", dxfId: dxf(), ...base }, F([`LEN(TRIM(${topLeft}))=0`]));
    case "duplicate": return el("cfRule", { type: "duplicateValues", dxfId: dxf(), ...base });
    case "top": return el("cfRule", { type: "top10", dxfId: dxf(), ...base, rank: r.count, bottom: r.bottom || undefined });
    case "dueBefore": {
      const d = r.date === "today" || !r.date ? "TODAY()" : (() => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(r.date); return m ? `DATE(${Number(m[1])},${Number(m[2])},${Number(m[3])})` : "TODAY()"; })();
      const days = r.days ? (r.days > 0 ? `+${r.days}` : String(r.days)) : "";
      return el("cfRule", { type: "expression", dxfId: dxf(), ...base }, F([`AND(ISNUMBER(${topLeft}),${topLeft}<${d}${days})`]));
    }
    case "cellIs": return el("cfRule", { type: "cellIs", dxfId: dxf(), ...base, operator: r.operator }, F(r.formulas));
    case "expression": return el("cfRule", { type: "expression", dxfId: dxf(), ...base }, F([r.formula]));
    case "colorScale": return el("cfRule", { type: "colorScale", ...base }, `<colorScale>${r.stops.map(cfvoXml).join("")}${r.stops.map((s) => el("color", { rgb: rgb(s.color) })).join("")}</colorScale>`);
    case "dataBar": return el("cfRule", { type: "dataBar", ...base }, `<dataBar>${cfvoXml(r.min ?? { type: "min" })}${cfvoXml(r.max ?? { type: "max" })}${el("color", { rgb: rgb(r.color) })}</dataBar>`);
    case "raw": {
      let xml = r.xml.replace(/\spriority="\d+"/, ` priority="${priority}"`);
      if (fresh && /\sdxfId="\d+"/.test(xml)) xml = xml.replace(/\sdxfId="\d+"/, ` dxfId="${dxf()}"`);
      return xml;
    }
  }
}

function validationXml(v: DataValidation): string {
  const a: Record<string, string | number | boolean | undefined> = {};
  let f1: string | undefined, f2: string | undefined;
  switch (v.kind) {
    case "list": a.type = "list"; f1 = v.listSource ?? `"${(v.list ?? []).join(",")}"`; break;
    case "number": case "date": {
      a.type = v.kind === "number" ? "decimal" : "date";
      if (v.min !== undefined && v.max !== undefined) { a.operator = "between"; f1 = String(v.min); f2 = String(v.max); }
      else if (v.min !== undefined) { a.operator = "greaterThanOrEqual"; f1 = String(v.min); }
      else if (v.max !== undefined) { a.operator = "lessThanOrEqual"; f1 = String(v.max); }
      else { a.operator = v.operator; f1 = v.formula1; f2 = v.formula2; }
      if (v.kind === "date" && v.operator && v.min === undefined && v.max === undefined) { a.operator = v.operator; f1 = v.formula1; f2 = v.formula2; }
      break;
    }
    default: a.type = v.kind; if (v.kind !== "custom") a.operator = v.operator; f1 = v.formula1; f2 = v.formula2;
  }
  if (a.operator === "between") delete a.operator;
  Object.assign(a, {
    errorStyle: v.errorStyle, allowBlank: v.allowBlank || undefined, showDropDown: v.hideDropDown || undefined,
    showInputMessage: v.message || v.promptTitle ? true : undefined, showErrorMessage: true,
    errorTitle: v.errorTitle, error: v.error, promptTitle: v.promptTitle, prompt: v.message, sqref: v.range,
  });
  const inner = `${f1 !== undefined ? `<formula1>${esc(f1)}</formula1>` : ""}${f2 !== undefined ? `<formula2>${esc(f2)}</formula2>` : ""}`;
  return el("dataValidation", a, inner);
}

function filterXml(sheet: Sheet): string {
  const f = sheet.filters!;
  let start = 0;
  try { start = normalizeRange(parseRange(f.range)).start.col; } catch { /* keep 0 */ }
  const cols = Object.entries(f.criteria).map(([letter, c]) => {
    const colId = letterToCol(letter) - start;
    if (colId < 0) return "";
    if (c.values) {
      const blank = c.values.includes("");
      return `<filterColumn colId="${colId}"><filters${blank ? ' blank="1"' : ""}>${c.values.filter((v) => v !== "").map((v) => el("filter", { val: v })).join("")}</filters></filterColumn>`;
    }
    if (c.condition) {
      const { op, value } = c.condition;
      const OPS: Record<string, [string, (v: string) => string]> = {
        eq: ["equal", (v) => v], neq: ["notEqual", (v) => v], gt: ["greaterThan", (v) => v], lt: ["lessThan", (v) => v], gte: ["greaterThanOrEqual", (v) => v], lte: ["lessThanOrEqual", (v) => v],
        contains: ["equal", (v) => `*${v}*`], notContains: ["notEqual", (v) => `*${v}*`], startsWith: ["equal", (v) => `${v}*`], blank: ["equal", () => ""], notBlank: ["notEqual", () => " "],
      };
      const [operator, fmt] = OPS[op] ?? OPS.eq;
      return `<filterColumn colId="${colId}"><customFilters>${el("customFilter", { operator: operator === "equal" ? undefined : operator, val: fmt(String(value ?? "")) })}</customFilters></filterColumn>`;
    }
    return "";
  }).join("");
  return el("autoFilter", { ref: f.range }, cols);
}

// ------------------------------------------------------------------ sheet writer

interface SheetEnv {
  wb: Workbook;
  computed: Computed;
  styles: StylesBuilder;
  strings: Strings;
  /** Style id → cellXfs index. */
  xfFor: (styleId: string | undefined, extra?: Partial<CellStyle>) => number;
  date1904: boolean;
  fresh: boolean;
  active: boolean;
  sheetIndex: number;
  part: string;
  partNames: Set<string>;
  /** Preserve mode: original worksheet XML and rels, and the fingerprint of its original notes. */
  original?: { xml: string; rels: Rel[]; pkg: Package; notesFp?: string };
}

interface SheetOut { xml: string; rels: RelOut[]; parts: Part[]; removed: string[] }

function cellXml(env: SheetEnv, sheet: Sheet, ref: string, cell: Cell): string {
  const { wb, computed } = env;
  const style = cell.s ? wb.styles[cell.s] ?? {} : {};
  let extraStyle: Partial<CellStyle> | undefined;
  let t: string | undefined;
  let inner = "";
  if (cell.f) {
    const f = toFileFormula(cell.f);
    inner += cell.ar ? `<f t="array" ref="${esc(cell.ar)}">${esc(f)}</f>` : `<f>${esc(f)}</f>`;
    const cc = computed[sheet.id]?.[ref];
    let v = cc?.v;
    let isErr = cc?.t === "e";
    if (isErr && (v === "#NAME?" || v === "#ERROR!") && cell.v !== undefined && cell.v !== null) { v = cell.v; isErr = typeof v === "string" && EXCEL_ERRORS.has(v); }
    if (isErr) {
      const e = String(v);
      if (e === "#CYCLE!") inner += "<v>0</v>";
      else { t = "e"; inner += `<v>${esc(EXCEL_ERRORS.has(e) ? e : "#VALUE!")}</v>`; }
    } else if (typeof v === "number") inner += `<v>${cc?.t === "d" && env.date1904 ? v - 1462 : v}</v>`;
    else if (typeof v === "boolean") { t = "b"; inner += `<v>${v ? 1 : 0}</v>`; }
    else if (typeof v === "string") { t = "str"; inner += `<v>${escText(v)}</v>`; }
  } else if (cell.v !== undefined && cell.v !== null && cell.v !== "") {
    const v = cell.v;
    if (typeof v === "number") inner = `<v>${v}</v>`;
    else if (typeof v === "boolean") { t = "b"; inner = `<v>${v ? 1 : 0}</v>`; }
    else if (cell.t === "e") { t = "e"; inner = `<v>${esc(v)}</v>`; }
    else if ((cell.t === "d" || isDateFormat(style.numFmt)) && /^\d{4}-\d{2}-\d{2}$/.test(v) && isoToSerial(v) !== null) {
      const serial = isoToSerial(v)! - (env.date1904 ? 1462 : 0);
      inner = `<v>${serial}</v>`;
      if (!style.numFmt || !isDateFormat(style.numFmt)) extraStyle = { numFmt: "yyyy-mm-dd" };
    } else {
      const r = env.strings.ref(v);
      if (r.t === "s") { t = "s"; inner = `<v>${r.v}</v>`; } else { t = "inlineStr"; inner = r.xml; }
    }
  }
  const s = env.xfFor(cell.s, extraStyle);
  return `<c r="${ref}"${s ? ` s="${s}"` : ""}${t ? ` t="${t}"` : ""}${inner ? `>${inner}</c>` : "/>"}`;
}

function sheetDataXml(env: SheetEnv, sheet: Sheet): { xml: string; dim: string } {
  const rows = new Map<number, { col: number; ref: string; cell: Cell }[]>();
  for (const [ref, cell] of Object.entries(sheet.cells)) {
    const p = parseA1(ref);
    const list = rows.get(p.row) ?? [];
    list.push({ col: p.col, ref, cell });
    rows.set(p.row, list);
  }
  const rowNums = new Set<number>(rows.keys());
  for (const k of Object.keys(sheet.rowHeights)) rowNums.add(Number(k) - 1);
  for (const r of sheet.hiddenRows ?? []) rowNums.add(r - 1);
  for (const k of Object.keys(sheet.rowStyles ?? {})) rowNums.add(Number(k) - 1);
  const sorted = [...rowNums].filter((r) => r >= 0).sort((a, b) => a - b);
  const hidden = new Set(sheet.hiddenRows ?? []);
  let xml = "";
  for (const r of sorted) {
    const n = r + 1;
    const cells = (rows.get(r) ?? []).sort((a, b) => a.col - b.col);
    const h = sheet.rowHeights[String(n)];
    const rs = sheet.rowStyles?.[String(n)];
    const a = { r: n, s: rs ? env.xfFor(rs) || undefined : undefined, customFormat: rs ? true : undefined, ht: h !== undefined ? pxToPt(h) : undefined, hidden: hidden.has(n) || undefined, customHeight: h !== undefined ? true : undefined };
    const inner = cells.map((c) => cellXml(env, sheet, c.ref, c.cell)).join("");
    xml += inner ? `<row${attrStr(a)}>${inner}</row>` : `<row${attrStr(a)}/>`;
  }
  const ur = usedRange(sheet);
  return { xml: `<sheetData>${xml}</sheetData>`, dim: ur ? rangeToA1({ start: { row: 0, col: 0 }, end: ur.end }).replace(/^A1:A1$/, "A1") : "A1" };
}

function colsXml(env: SheetEnv, sheet: Sheet): string {
  const cols = new Set<number>();
  for (const L of Object.keys(sheet.colWidths)) cols.add(letterToCol(L));
  for (const L of sheet.hiddenCols ?? []) cols.add(letterToCol(L));
  for (const L of Object.keys(sheet.colStyles ?? {})) cols.add(letterToCol(L));
  if (!cols.size) return "";
  const hidden = new Set(sheet.hiddenCols ?? []);
  const defPx = sheet.defaultColWidth ?? DEFAULT_COL_WIDTH;
  const spec = (c: number) => {
    const L = colToLetter(c);
    const w = sheet.colWidths[L];
    return { width: pxToWidth(w ?? defPx), custom: w !== undefined, hidden: hidden.has(L), style: sheet.colStyles?.[L] ? env.xfFor(sheet.colStyles[L]) : 0 };
  };
  const list = [...cols].sort((a, b) => a - b);
  const groups: { min: number; max: number; s: ReturnType<typeof spec> }[] = [];
  for (const c of list) {
    const s = spec(c);
    const last = groups[groups.length - 1];
    if (last && last.max === c - 1 && JSON.stringify(last.s) === JSON.stringify(s)) last.max = c;
    else groups.push({ min: c, max: c, s });
  }
  return `<cols>${groups.map((g) => el("col", { min: g.min + 1, max: g.max + 1, width: g.s.width, style: g.s.style || undefined, hidden: g.s.hidden || undefined, customWidth: g.s.custom || undefined })).join("")}</cols>`;
}

function sheetViewsXml(env: SheetEnv, sheet: Sheet): string {
  const v = sheet.view ?? {};
  const fr = sheet.freeze;
  let inner = "";
  let pane: string | undefined;
  if (fr.rows || fr.cols) {
    pane = fr.rows && fr.cols ? "bottomRight" : fr.rows ? "bottomLeft" : "topRight";
    inner += el("pane", { xSplit: fr.cols || undefined, ySplit: fr.rows || undefined, topLeftCell: toA1(fr.rows, fr.cols), activePane: pane, state: "frozen" });
  }
  const sel = sheet.selection;
  if (sel) inner += el("selection", { pane, activeCell: sel.activeCell, sqref: sel.sqref });
  else if (pane) inner += el("selection", { pane });
  return `<sheetViews>${el("sheetView", { tabSelected: env.active || undefined, showGridLines: v.showGridLines === false ? "0" : undefined, rightToLeft: v.rightToLeft || undefined, zoomScale: v.zoom && v.zoom !== 100 ? v.zoom : undefined, zoomScaleNormal: v.zoom && v.zoom !== 100 ? v.zoom : undefined, workbookViewId: 0 }, inner)}</sheetViews>`;
}

function sheetPrXml(sheet: Sheet, page: PageSetup, original?: string): string {
  const tab = sheet.color ? el("tabColor", { rgb: rgb(sheet.color) }) : "";
  const fit = page.fitToPage ? el("pageSetUpPr", { fitToPage: true }) : "";
  if (original) {
    const top = splitTopLevel(original);
    const keep = top.children.filter((c) => c.local !== "tabColor" && c.local !== "pageSetUpPr").map((c) => c.xml).join("");
    const start = top.rootStart.endsWith("/>") ? `${top.rootStart.slice(0, -2)}>` : top.rootStart;
    const inner = `${tab}${keep}${fit}`;
    if (!inner && top.rootStart.endsWith("/>")) return top.rootStart;
    return `${start}${inner}</${top.rootName}>`;
  }
  return tab || fit ? `<sheetPr>${tab}${fit}</sheetPr>` : "";
}

function pageXml(sheet: Sheet, page: PageSetup, printerRid?: string): { printOptions: string; margins: string; setup: string; hf: string } {
  const po = el("printOptions", { horizontalCentered: page.centerHorizontally || undefined, verticalCentered: page.centerVertically || undefined, gridLines: page.gridlines || undefined });
  const m = page.margins;
  const margins = el("pageMargins", { left: m.left, right: m.right, top: m.top, bottom: m.bottom, header: page.headerMargin ?? 0.3, footer: page.footerMargin ?? 0.3 });
  const paperSize = page.paperSize ?? (page.paper ? PAPER_ID[page.paper] : undefined);
  const setup = el("pageSetup", { paperSize, scale: page.scale && page.scale !== 100 ? page.scale : undefined, fitToWidth: page.fitToPage ? page.fitToWidth ?? 1 : undefined, fitToHeight: page.fitToPage ? page.fitToHeight ?? 0 : undefined, orientation: page.orientation, "r:id": printerRid });
  const oh = headerToExcel(page.header), of = headerToExcel(page.footer);
  const hf = oh || of ? `<headerFooter>${oh ? `<oddHeader>${escText(oh)}</oddHeader>` : ""}${of ? `<oddFooter>${escText(of)}</oddFooter>` : ""}</headerFooter>` : "";
  void sheet;
  return { printOptions: po === "<printOptions/>" ? "" : po, margins, setup, hf };
}

function vmlXml(sheet: Sheet, idmap: number): string {
  let n = 0;
  const shapes = Object.keys(sheet.notes ?? {}).map((ref) => {
    const p = parseA1(ref);
    n++;
    return `<v:shape id="_x0000_s${idmap * 1024 + n}" type="#_x0000_t202" style="position:absolute;margin-left:59.25pt;margin-top:1.5pt;width:108pt;height:59.25pt;z-index:${n};visibility:hidden" fillcolor="#ffffe1" o:insetmode="auto"><v:fill color2="#ffffe1"/><v:shadow on="t" color="black" obscured="t"/><v:path o:connecttype="none"/><v:textbox style="mso-direction-alt:auto"><div style="text-align:left"></div></v:textbox><x:ClientData ObjectType="Note"><x:MoveWithCells/><x:SizeWithCells/><x:Anchor>${p.col + 1}, 15, ${p.row}, 10, ${p.col + 3}, 15, ${p.row + 3}, 4</x:Anchor><x:AutoFill>False</x:AutoFill><x:Row>${p.row}</x:Row><x:Column>${p.col}</x:Column></x:ClientData></v:shape>`;
  }).join("");
  return `<xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel"><o:shapelayout v:ext="edit"><o:idmap v:ext="edit" data="${idmap}"/></o:shapelayout><v:shapetype id="_x0000_t202" coordsize="21600,21600" o:spt="202" path="m,l,21600r21600,l21600,xe"><v:stroke joinstyle="miter"/><v:path gradientshapeok="t" o:connecttype="rect"/></v:shapetype>${shapes}</xml>`;
}

function commentsXml(sheet: Sheet): string {
  const notes = Object.entries(sheet.notes ?? {});
  const authors: string[] = [];
  for (const [, n] of notes) { const a = n.author ?? ""; if (!authors.includes(a)) authors.push(a); }
  return `${XML_DECL}<comments xmlns="${NS_MAIN}"><authors>${authors.map((a) => `<author>${escText(a)}</author>`).join("")}</authors><commentList>${notes.map(([ref, n]) => `<comment ref="${ref}" authorId="${authors.indexOf(n.author ?? "")}"><text><t xml:space="preserve">${escText(n.text)}</t></text></comment>`).join("")}</commentList></comments>`;
}

function notesFingerprint(sheet: Sheet): string { return hashValue(sheet.notes ?? {}); }

/** Generate one worksheet part (and its drawing/charts/comments). */
function writeSheet(env: SheetEnv, sheet: Sheet): SheetOut {
  const { wb } = env;
  const page = effectivePage(wb, sheet);
  const orig = env.original;
  const origTop = orig ? splitTopLevel(orig.xml) : null;
  const origChild = (name: string) => origTop?.children.find((c) => c.local === name)?.xml;
  const rels: RelOut[] = orig ? orig.rels.map((r) => ({ id: r.id, type: r.type, target: r.external ? r.target : relTarget(env.part, r.target), external: r.external })) : [];
  const usedLinkRels = new Set<string>();
  const parts: Part[] = [];
  const removed: string[] = [];
  const out: { name: string; xml: string }[] = [];
  const push = (name: string, xml: string) => { if (xml) out.push({ name, xml }); };

  push("sheetPr", sheetPrXml(sheet, page, origChild("sheetPr")));
  const data = sheetDataXml(env, sheet);
  push("dimension", el("dimension", { ref: data.dim }));
  push("sheetViews", sheetViewsXml(env, sheet));
  const defRowPx = sheet.defaultRowHeight ?? DEFAULT_ROW_HEIGHT;
  push("sheetFormatPr", el("sheetFormatPr", { defaultColWidth: pxToWidth(sheet.defaultColWidth ?? DEFAULT_COL_WIDTH), defaultRowHeight: pxToPt(defRowPx), customHeight: defRowPx !== 20 || undefined }));
  push("cols", colsXml(env, sheet));
  push("sheetData", data.xml);
  if (sheet.filters) push("autoFilter", filterXml(sheet));
  if (sheet.merges.length) push("mergeCells", `<mergeCells count="${sheet.merges.length}">${sheet.merges.map((m) => el("mergeCell", { ref: m })).join("")}</mergeCells>`);
  // conditional formatting
  sheet.conditionalFormats.forEach((cf, i) => {
    let tl = "A1";
    try { const r = normalizeRange(parseRange(cf.range)); tl = toA1(r.start.row, r.start.col); } catch { /* keep A1 */ }
    const rule = cfRuleXml(cf, cf.priority ?? i + 1, () => env.styles.dxf(cf.style), tl, env.fresh);
    push("conditionalFormatting", el("conditionalFormatting", { sqref: cf.range }, rule));
  });
  const dvs = sheet.validations ?? [];
  if (dvs.length) push("dataValidations", `<dataValidations count="${dvs.length}">${dvs.map(validationXml).join("")}</dataValidations>`);
  // hyperlinks
  const links = sheet.hyperlinks ?? [];
  if (links.length) {
    const xml = links.map((l) => {
      let id: string | undefined;
      if (l.target) {
        const reuse = rels.find((r) => r.type === REL.hyperlink && r.target === l.target && !usedLinkRels.has(r.id));
        if (reuse) id = reuse.id;
        else { id = nextRelId(rels); rels.push({ id, type: REL.hyperlink, target: l.target, external: true }); }
        usedLinkRels.add(id);
      }
      return `<hyperlink${attrStr({ ref: l.ref, "r:id": id, location: l.location, tooltip: l.tooltip, display: l.display })}/>`;
    }).join("");
    push("hyperlinks", `<hyperlinks>${xml}</hyperlinks>`);
  }
  const origSetup = origChild("pageSetup");
  const printerRid = origSetup ? /\br:id="([^"]+)"/.exec(origSetup)?.[1] : undefined;
  for (let i = rels.length - 1; i >= 0; i--) if (rels[i].type === REL.hyperlink && !usedLinkRels.has(rels[i].id)) rels.splice(i, 1);
  const pg = pageXml(sheet, page, printerRid && rels.some((r) => r.id === printerRid) ? printerRid : undefined);
  push("printOptions", pg.printOptions);
  push("pageMargins", pg.margins);
  push("pageSetup", pg.setup);
  push("headerFooter", pg.hf);

  // ---- drawing / charts
  const origDrawingXml = origChild("drawing");
  const origDrawingRid = origDrawingXml ? /\bid="([^"]+)"/.exec(origDrawingXml.replace(/^<[^\s>]+/, ""))?.[1] : undefined;
  const origDrawingRel = origDrawingRid ? orig?.rels.find((r) => r.id === origDrawingRid) : undefined;
  const drawing = writeDrawing(env, sheet, origDrawingRel && orig ? { part: origDrawingRel.target, pkg: orig.pkg } : undefined);
  if (drawing.kind === "keep" && origDrawingXml) push("drawing", origDrawingXml);
  else if (drawing.kind === "write") {
    let rid = origDrawingRel?.id;
    const part = drawing.part;
    if (!rid) { rid = nextRelId(rels); rels.push({ id: rid, type: REL.drawing, target: relTarget(env.part, part) }); }
    parts.push(...drawing.parts);
    push("drawing", `<drawing r:id="${rid}"/>`);
  } else if (drawing.kind === "none" && origDrawingRel) {
    const i = rels.findIndex((r) => r.id === origDrawingRel.id);
    if (i >= 0) rels.splice(i, 1);
  }

  // ---- notes (legacy comments)
  const origLegacy = origChild("legacyDrawing");
  const commentsRel = orig?.rels.find((r) => r.type === REL.comments);
  const origNotesFp = orig?.notesFp;
  const hasNotes = Object.keys(sheet.notes ?? {}).length > 0;
  if (orig && origLegacy && commentsRel && origNotesFp === notesFingerprint(sheet)) {
    push("legacyDrawing", origLegacy);
  } else {
    // drop original comments/vml rels, regenerate when notes exist
    const vmlRid = origLegacy ? /\bid="([^"]+)"/.exec(origLegacy.replace(/^<[^\s>]+/, ""))?.[1] : undefined;
    for (let i = rels.length - 1; i >= 0; i--) if (rels[i].type === REL.comments || (vmlRid && rels[i].id === vmlRid)) rels.splice(i, 1);
    if (hasNotes) {
      const commentsPart = commentsRel?.target ?? uniquePart(env.partNames, (n) => `xl/comments${n}.xml`);
      const vmlPart = uniquePart(env.partNames, (n) => `xl/drawings/vmlDrawingLc${n}.vml`);
      parts.push({ name: commentsPart, data: commentsXml(sheet), ct: CT.comments }, { name: vmlPart, data: vmlXml(sheet, env.sheetIndex + 1), ct: "vml" });
      const cr = nextRelId(rels); rels.push({ id: cr, type: REL.comments, target: relTarget(env.part, commentsPart) });
      const vr = nextRelId(rels); rels.push({ id: vr, type: REL.vmlDrawing, target: relTarget(env.part, vmlPart) });
      push("legacyDrawing", `<legacyDrawing r:id="${vr}"/>`);
    } else if (commentsRel) removed.push(commentsRel.target);
  }

  // ---- preserved (unmodeled) elements
  if (origTop) for (const c of origTop.children) if (!WS_OWNED.has(c.local)) out.push({ name: c.local, xml: c.xml });
  const order = (n: string) => { const i = WS_ORDER.indexOf(n); return i < 0 ? WS_ORDER.length - 1 : i; };
  out.sort((a, b) => order(a.name) - order(b.name));

  if (origTop && origTop.rootName.includes(":")) throw new Error("Prefixed SpreadsheetML worksheets are not supported for in-place rewrite");
  let rootStart = origTop ? origTop.rootStart : `<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_R}">`;
  const rNs = nsDecls(rootStart)["xmlns:r"];
  if (rNs && rNs !== NS_R) throw new Error("Unsupported worksheet namespace layout");
  if (!rNs) rootStart = rootStart.replace(/^<([^\s>/]+)/, `<$1 xmlns:r="${NS_R}"`);
  const xml = `${XML_DECL}${rootStart}${out.map((o) => o.xml).join("")}</worksheet>`;
  return { xml, rels, parts, removed };
}

type DrawingResult = { kind: "none" } | { kind: "keep" } | { kind: "write"; part: string; parts: Part[] };

/** Decide whether the sheet's drawing can be kept verbatim, must be regenerated, or dropped. */
function writeDrawing(env: SheetEnv, sheet: Sheet, original?: { part: string; pkg: Package }): DrawingResult {
  const charts = sheet.charts;
  // original chart anchors
  let origAnchors: { xml: string; chartPart?: string; rid?: string }[] = [];
  let origRels: Rel[] = [];
  let origStart = "";
  if (original) {
    const dx = original.pkg.text(original.part);
    if (dx) {
      const top = splitTopLevel(dx);
      origStart = top.rootStart;
      origRels = original.pkg.rels(original.part);
      origAnchors = top.children.map((c) => {
        const rid = /<(?:\w+:)?chart\b[^>]*?\b(?:\w+:)?id="([^"]+)"/.exec(c.xml)?.[1];
        const rel = rid ? origRels.find((r) => r.id === rid) : undefined;
        return { xml: c.xml, chartPart: rel?.target, rid };
      });
    }
  }
  const unchanged = (c: SheetChart) => Boolean(c.xlsx && c.xlsx.fp === chartFingerprint(c, sheet.name));
  const origChartParts = origAnchors.filter((a) => a.chartPart).map((a) => a.chartPart!);
  const modelParts = charts.filter(unchanged).map((c) => c.xlsx!.part);
  const allKept = charts.every(unchanged) && origChartParts.length === modelParts.length && origChartParts.every((p) => modelParts.includes(p));
  if (original && allKept) return origAnchors.length ? { kind: "keep" } : { kind: "none" };
  if (!charts.length && !origAnchors.some((a) => !a.chartPart)) return { kind: "none" };

  const part = original?.part ?? uniquePart(env.partNames, (n) => `xl/drawings/drawing${n}.xml`);
  const rels: RelOut[] = origRels.filter((r) => r.type !== REL.chart).map((r) => ({ id: r.id, type: r.type, target: r.external ? r.target : relTarget(part, r.target), external: r.external }));
  const parts: Part[] = [];
  const anchors: string[] = [];
  let maxId = 1;
  for (const a of origAnchors) for (const m of a.xml.matchAll(/cNvPr\b[^>]*\bid="(\d+)"/g)) maxId = Math.max(maxId, Number(m[1]));
  // keep non-chart anchors, and chart anchors whose chart is unchanged
  const keptParts = new Set<string>();
  for (const a of origAnchors) {
    if (!a.chartPart) { anchors.push(a.xml); continue; }
    const c = charts.find((x) => unchanged(x) && x.xlsx!.part === a.chartPart);
    if (!c) continue;
    const id = nextRelId(rels);
    rels.push({ id, type: REL.chart, target: relTarget(part, a.chartPart) });
    anchors.push(a.xml.replace(/(<(?:\w+:)?chart\b[^>]*?\b(?:\w+:)?id=")([^"]+)(")/, `$1${id}$3`));
    keptParts.add(a.chartPart);
  }
  for (const c of charts) {
    if (c.xlsx && keptParts.has(c.xlsx.part) && unchanged(c)) continue;
    const chartPart = c.xlsx?.part && !keptParts.has(c.xlsx.part) ? c.xlsx.part : uniquePart(env.partNames, (n) => `xl/charts/chart${n}.xml`);
    env.partNames.add(chartPart);
    parts.push({ name: chartPart, data: buildChartXml(c, sheet, env.computed), ct: CT.chart });
    const id = nextRelId(rels);
    rels.push({ id, type: REL.chart, target: relTarget(part, chartPart) });
    maxId++;
    anchors.push(anchorXml(pxToAnchor(sheet, c.position), chartFrameXml(maxId, c.title || `Chart ${maxId}`, id)));
  }
  const start = origStart && /xmlns:xdr=/.test(origStart) && /xmlns:a=/.test(origStart) ? origStart : DRAWING_OPEN;
  const xml = `${XML_DECL}${start}${anchors.join("")}</xdr:wsDr>`;
  parts.push({ name: part, data: xml, ct: CT.drawing }, { name: relsPathFor(part), data: relsXml(rels) });
  return { kind: "write", part, parts };
}

// ------------------------------------------------------------------ workbook part

function definedNamesXml(wb: Workbook): string {
  const names: { name: string; local?: number; hidden?: boolean; comment?: string; value: string }[] = [];
  for (const [name, ref] of Object.entries(wb.namedRanges)) names.push({ name, value: absolutize(ref) });
  wb.sheets.forEach((s, i) => {
    for (const [name, ref] of Object.entries(s.localNames ?? {})) names.push({ name, local: i, value: absolutize(ref.includes("!") ? ref : `${quoteSheet(s.name)}!${ref}`) });
    const page = effectivePage(wb, s);
    const q = quoteSheet(s.name);
    if (page.printArea) names.push({ name: "_xlnm.Print_Area", local: i, value: `${q}!${absolutize(page.printArea.includes("!") ? page.printArea.slice(page.printArea.lastIndexOf("!") + 1) : page.printArea)}` });
    const titles: string[] = [];
    if (page.repeatCols) { const [a, b] = page.repeatCols.split(":"); titles.push(`${q}!$${a}:$${b ?? a}`); }
    if (page.repeatHeaderRows) titles.push(`${q}!$1:$${page.repeatHeaderRows}`);
    if (titles.length) names.push({ name: "_xlnm.Print_Titles", local: i, value: titles.join(",") });
    if (s.filters) names.push({ name: "_xlnm._FilterDatabase", local: i, hidden: true, value: `${q}!${absolutize(s.filters.range)}` });
  });
  for (const x of wb.extraNames ?? []) {
    const local = x.sheet !== undefined ? wb.sheets.findIndex((s) => s.name === x.sheet) : undefined;
    if (local !== undefined && local < 0) continue;
    names.push({ name: x.name, local, hidden: x.hidden, comment: x.comment, value: x.value });
  }
  if (!names.length) return "";
  names.sort((a, b) => a.name.localeCompare(b.name) || (a.local ?? -1) - (b.local ?? -1));
  return `<definedNames>${names.map((n) => el("definedName", { name: n.name, comment: n.comment, localSheetId: n.local, hidden: n.hidden }, esc(n.value))).join("")}</definedNames>`;
}

function sheetsXml(wb: Workbook, ids: { sheetId: number; rid: string }[]): string {
  return `<sheets>${wb.sheets.map((s, i) => `<sheet${attrStr({ name: s.name, sheetId: ids[i].sheetId, state: s.veryHidden ? "veryHidden" : s.hidden ? "hidden" : undefined, "r:id": ids[i].rid })}/>`).join("")}</sheets>`;
}

// ------------------------------------------------------------------ content types

class ContentTypes {
  defaults = new Map<string, string>();
  overrides = new Map<string, string>();
  constructor(xml?: string) {
    if (!xml) { this.defaults.set("rels", CT.rels); this.defaults.set("xml", "application/xml"); return; }
    const doc = child(parseXml(xml), "Types");
    for (const d of children(doc, "Default")) this.defaults.set(attrs(d).Extension.toLowerCase(), attrs(d).ContentType);
    for (const o of children(doc, "Override")) this.overrides.set(attrs(o).PartName.replace(/^\//, ""), attrs(o).ContentType);
  }
  add(part: string, ct: string) {
    if (ct === "vml") { if (!this.defaults.has("vml")) this.defaults.set("vml", CT.vml); return; }
    this.overrides.set(part, ct);
  }
  remove(part: string) { this.overrides.delete(part); }
  toXml(): string {
    return `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${[...this.defaults].map(([e, c]) => el("Default", { Extension: e, ContentType: c })).join("")}${[...this.overrides].map(([p, c]) => el("Override", { PartName: `/${p}`, ContentType: c })).join("")}</Types>`;
  }
}

// ------------------------------------------------------------------ entry points

export interface WriteOptions {
  computed?: Computed;
  /** Original package bytes of an imported workbook (enables package-preserving export). */
  original?: Uint8Array | null;
}

export interface WriteReport { mode: "fresh" | "preserve"; rewritten: string[]; kept: number; reason?: string }

export function writeXlsx(wb: Workbook, opts: WriteOptions = {}): Uint8Array {
  return writeXlsxWithReport(wb, opts).bytes;
}

export function writeXlsxWithReport(wb: Workbook, opts: WriteOptions = {}): { bytes: Uint8Array; report: WriteReport } {
  const computed = opts.computed ?? computeWorkbook(wb);
  if (opts.original && wb.xlsxSource) {
    let pkg: Package | null = null;
    try { pkg = new Package(opts.original); } catch { pkg = null; }
    if (pkg) {
      try { return writePreserving(wb, computed, pkg); }
      catch (e) { const r = writeFresh(wb, computed); return { bytes: r, report: { mode: "fresh", rewritten: [], kept: 0, reason: `preserve failed: ${(e as Error).message}` } }; }
    }
  }
  return { bytes: writeFresh(wb, computed), report: { mode: "fresh", rewritten: [], kept: 0 } };
}

function writeFresh(wb: Workbook, computed: Computed): Uint8Array {
  const styles = new StylesBuilder();
  const strings = new FreshStrings();
  const xfFor = (id: string | undefined, extra?: Partial<CellStyle>) => { const st = id ? wb.styles[id] ?? {} : {}; return styles.xf(extra ? { ...st, ...extra } : st); };
  const partNames = new Set<string>();
  const parts: Part[] = [];
  const ct = new ContentTypes();
  const wbRels: RelOut[] = [];
  const ids: { sheetId: number; rid: string }[] = [];
  wb.sheets.forEach((sheet, i) => {
    const part = `xl/worksheets/sheet${i + 1}.xml`;
    partNames.add(part);
    const out = writeSheet({ wb, computed, styles, strings, xfFor, date1904: false, fresh: true, active: i === wb.activeSheet, sheetIndex: i, part, partNames }, sheet);
    parts.push({ name: part, data: out.xml, ct: CT.worksheet });
    if (out.rels.length) parts.push({ name: relsPathFor(part), data: relsXml(out.rels) });
    parts.push(...out.parts);
    const rid = `rId${i + 1}`;
    wbRels.push({ id: rid, type: REL.worksheet, target: `worksheets/sheet${i + 1}.xml` });
    ids.push({ sheetId: i + 1, rid });
  });
  wbRels.push({ id: `rId${wb.sheets.length + 1}`, type: REL.styles, target: "styles.xml" });
  wbRels.push({ id: `rId${wb.sheets.length + 2}`, type: REL.sharedStrings, target: "sharedStrings.xml" });
  const workbookXml = `${XML_DECL}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_R}"><workbookPr defaultThemeVersion="164011"/><bookViews><workbookView xWindow="0" yWindow="0" windowWidth="28800" windowHeight="16000" activeTab="${wb.activeSheet}"/></bookViews>${sheetsXml(wb, ids)}${definedNamesXml(wb)}<calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`;
  const all: Part[] = [
    { name: "_rels/.rels", data: relsXml([{ id: "rId1", type: REL.officeDocument, target: "xl/workbook.xml" }, { id: "rId2", type: REL.coreProps, target: "docProps/core.xml" }, { id: "rId3", type: REL.extendedProps, target: "docProps/app.xml" }]) },
    { name: "docProps/core.xml", data: `${XML_DECL}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>${BRAND.name}</dc:creator></cp:coreProperties>`, ct: CT.core },
    { name: "docProps/app.xml", data: `${XML_DECL}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>${BRAND.name}</Application></Properties>`, ct: CT.app },
    { name: "xl/workbook.xml", data: workbookXml, ct: CT.workbook },
    { name: "xl/_rels/workbook.xml.rels", data: relsXml(wbRels) },
    ...parts,
    { name: "xl/styles.xml", data: styles.toXml(), ct: CT.styles },
    { name: "xl/sharedStrings.xml", data: strings.toXml(), ct: CT.sharedStrings },
  ];
  for (const p of all) if (p.ct) ct.add(p.name, p.ct);
  return writeZip([makeEntry("[Content_Types].xml", ct.toXml()), ...all.map((p) => makeEntry(p.name, p.data))]);
}

function writePreserving(wb: Workbook, computed: Computed, pkg: Package): { bytes: Uint8Array; report: WriteReport } {
  const src = wb.xlsxSource!;
  const rootRels = pkg.rels("");
  const wbPart = rootRels.find((r) => r.type === REL.officeDocument)?.target ?? "xl/workbook.xml";
  const wbXml = pkg.text(wbPart);
  if (!wbXml) throw new Error("original package has no workbook part");
  const wbRelsOrig = pkg.rels(wbPart);
  const stylesPart = wbRelsOrig.find((r) => r.type === REL.styles)?.target;
  const sstPart = wbRelsOrig.find((r) => r.type === REL.sharedStrings)?.target;
  const stylesXml = stylesPart ? pkg.text(stylesPart) : undefined;
  const themeXml = pkg.text(wbRelsOrig.find((r) => r.type === REL.theme)?.target ?? "");
  const styles = new StylesBuilder(stylesXml, stylesXml ? parseStyles(stylesXml, parseTheme(themeXml)).dxfs : undefined);
  const sstMap = new Map<string, number>();
  if (sstPart) {
    const sis = children(child(parseXml(pkg.text(sstPart) ?? "<sst/>"), "sst"), "si");
    sis.forEach((si, i) => {
      const runs = children(si, "r");
      const t = runs.length ? runs.map((r) => text(child(r, "t"))).join("") : text(child(si, "t"));
      const plain = t.replace(/_x([0-9A-Fa-f]{4})_/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));
      if (!sstMap.has(plain)) sstMap.set(plain, i);
    });
  }
  const strings = new PreservedStrings(sstMap);
  const xfFor = (id: string | undefined, extra?: Partial<CellStyle>) => {
    const st = id ? wb.styles[id] ?? {} : {};
    const m = id ? src.styleXf[id] : undefined;
    if (!extra && m && m.key === styleKey(st)) return m.xf;
    if (!extra && !id) return 0;
    return styles.xf(extra ? { ...st, ...extra } : st);
  };
  const date1904 = Boolean(src.date1904);
  const partNames = new Set<string>(pkg.entries.keys());
  const replaced = new Map<string, string>(); // part → new content
  const removed = new Set<string>();
  const ct = new ContentTypes(pkg.text("[Content_Types].xml"));
  const rewritten: string[] = [];

  // original sheet elements by part
  const wbDoc = child(parseXml(wbXml), "workbook");
  const origSheetEls = children(child(wbDoc, "sheets"), "sheet").map((s) => ({ a: attrs(s), part: wbRelsOrig.find((r) => r.id === attrs(s).id)?.target }));
  let maxSheetId = Math.max(0, ...origSheetEls.map((s) => Number(s.a.sheetId) || 0));
  const wbRels: RelOut[] = wbRelsOrig.map((r) => ({ id: r.id, type: r.type, target: r.external ? r.target : relTarget(wbPart, r.target), external: r.external }));
  const ids: { sheetId: number; rid: string }[] = [];
  const keptParts = new Set<string>();

  wb.sheets.forEach((sheet, i) => {
    const info = src.sheets[sheet.id];
    const origEl = info ? origSheetEls.find((s) => s.part === info.part) : undefined;
    const exists = Boolean(info && origEl && pkg.has(info.part));
    const part = exists ? info!.part : uniquePart(partNames, (n) => `xl/worksheets/sheet${n}.xml`);
    let rid = origEl?.a.id;
    let sheetId = origEl ? Number(origEl.a.sheetId) : 0;
    if (!exists) {
      rid = nextRelId(wbRels);
      wbRels.push({ id: rid, type: REL.worksheet, target: relTarget(wbPart, part) });
      sheetId = ++maxSheetId;
      ct.add(part, CT.worksheet);
    }
    ids.push({ sheetId, rid: rid! });
    keptParts.add(part);
    const isWorksheet = !exists || wbRelsOrig.find((r) => r.id === rid)?.type === REL.worksheet;
    if (exists && (!isWorksheet || sheetFingerprint(wb, sheet) === info!.fp)) return; // untouched: byte-identical
    const originalXml = exists ? pkg.text(part) : undefined;
    const origRels = exists ? pkg.rels(part) : [];
    const env: SheetEnv = { wb, computed, styles, strings, xfFor, date1904, fresh: false, active: i === wb.activeSheet, sheetIndex: i, part, partNames };
    if (originalXml) {
      const notesFp = notesFingerprintFromPackage(pkg, origRels);
      env.original = { xml: originalXml, rels: origRels, pkg, notesFp };
    }
    const out = writeSheet(env, sheet);
    replaced.set(part, out.xml);
    rewritten.push(part);
    const relsPath = relsPathFor(part);
    const sameRels = out.rels.length === origRels.length && out.rels.every((r, k) => { const o = origRels[k]; return o.id === r.id && o.type === r.type && Boolean(o.external) === Boolean(r.external) && (o.external ? o.target === r.target : relTarget(part, o.target) === r.target); });
    if (!sameRels) { if (out.rels.length) replaced.set(relsPath, relsXml(out.rels)); else if (pkg.has(relsPath)) removed.add(relsPath); }
    for (const p of out.parts) { replaced.set(p.name, p.data); if (p.ct) ct.add(p.name, p.ct); }
    for (const r of out.removed) { removed.add(r); ct.remove(r); }
  });

  // deleted sheets
  for (const s of origSheetEls) {
    if (!s.part || keptParts.has(s.part)) continue;
    removed.add(s.part); removed.add(relsPathFor(s.part)); ct.remove(s.part);
    const i = wbRels.findIndex((r) => r.id === s.a.id);
    if (i >= 0) wbRels.splice(i, 1);
  }

  let wbRelsChanged = wbRels.length !== wbRelsOrig.length || wbRels.some((r, i) => r.id !== wbRelsOrig[i]?.id);
  // calc chain is stale once any sheet changed
  if (rewritten.length || removed.size) {
    const cc = wbRels.findIndex((r) => r.type === REL.calcChain);
    if (cc >= 0) { const target = wbRelsOrig.find((r) => r.id === wbRels[cc].id)?.target; if (target) { removed.add(target); ct.remove(target); } wbRels.splice(cc, 1); wbRelsChanged = true; }
  }
  // macros are not carried into an .xlsx
  const vba = wbRels.findIndex((r) => r.type === REL.vbaProject);
  if (vba >= 0) { const target = wbRelsOrig.find((r) => r.id === wbRels[vba].id)?.target; if (target) { removed.add(target); ct.remove(target); removed.add(relsPathFor(target)); } wbRels.splice(vba, 1); wbRelsChanged = true; }
  if (ct.overrides.get(wbPart) === CT.workbookMacro) ct.overrides.set(wbPart, CT.workbook);

  // workbook part
  const wbChanged = workbookFingerprint(wb) !== src.workbookFp || wb.sheets.length !== origSheetEls.length || ids.some((x, i) => x.rid !== origSheetEls[i]?.a.id);
  if (wbChanged) {
    const top = splitTopLevel(wbXml);
    if (top.rootName.includes(":")) throw new Error("Prefixed SpreadsheetML workbook parts are not supported for in-place rewrite");
    const kids = top.children.filter((c) => c.local !== "sheets" && c.local !== "definedNames").map((c) => {
      if (c.local === "bookViews") return c.xml.replace(/(<workbookView\b[^>]*?)\sactiveTab="\d+"/, "$1").replace(/<workbookView\b/, `<workbookView activeTab="${wb.activeSheet}"`);
      if (c.local === "workbookPr" && /\bcodeName=/.test(c.xml) && vba >= 0) return c.xml;
      return c.xml;
    });
    const ORDER = ["fileVersion", "fileSharing", "workbookPr", "workbookProtection", "bookViews", "sheets", "functionGroups", "externalReferences", "definedNames", "calcPr", "oleSize", "customWorkbookViews", "pivotCaches", "smartTagPr", "smartTagTypes", "webPublishing", "fileRecoveryPr", "webPublishObjects", "extLst"];
    const list = top.children.filter((c) => c.local !== "sheets" && c.local !== "definedNames").map((c, i) => ({ local: c.local, xml: kids[i] }));
    list.push({ local: "sheets", xml: sheetsXml(wb, ids) });
    const dn = definedNamesXml(wb);
    if (dn) list.push({ local: "definedNames", xml: dn });
    const ord = (n: string) => { const i = ORDER.indexOf(n); return i < 0 ? ORDER.length : i; };
    list.sort((a, b) => ord(a.local) - ord(b.local));
    let start = top.rootStart;
    if (!/xmlns:r="/.test(start)) start = start.replace(/^<([^\s>/]+)/, `<$1 xmlns:r="${NS_R}"`);
    replaced.set(wbPart, `${top.prolog}${start}${list.map((c) => c.xml).join("")}${top.rootEnd}`);
  }
  if (wbRelsChanged || wbChanged) replaced.set(relsPathFor(wbPart), relsXml(wbRels));
  if (styles.changed && stylesPart) replaced.set(stylesPart, styles.toXml());
  const ctXml = ct.toXml();
  const ctOrig = pkg.text("[Content_Types].xml") ?? "";
  const ctChanged = normalizedCt(ctOrig) !== normalizedCt(ctXml);

  // assemble: original order, then new parts
  const entries: ZipEntry[] = [];
  const seen = new Set<string>();
  for (const [name, entry] of pkg.entries) {
    if (removed.has(name) && !replaced.has(name)) continue;
    seen.add(name);
    if (name === "[Content_Types].xml" && ctChanged) { entries.push(makeEntry(name, ctXml)); continue; }
    const r = replaced.get(name);
    entries.push(r !== undefined ? makeEntry(name, r) : entry);
  }
  if (!seen.has("[Content_Types].xml")) entries.unshift(makeEntry("[Content_Types].xml", ctXml));
  for (const [name, data] of replaced) if (!seen.has(name)) entries.push(makeEntry(name, data));
  const kept = entries.filter((e) => pkg.entries.get(e.name) === e).length;
  return { bytes: writeZip(entries), report: { mode: "preserve", rewritten, kept } };
}

function normalizedCt(xml: string): string {
  const c = new ContentTypes(xml || undefined);
  return JSON.stringify([[...c.defaults].sort(), [...c.overrides].sort()]);
}

/** Notes fingerprint of the original package's comments part for a sheet (to keep legacyDrawing verbatim when unchanged). */
function notesFingerprintFromPackage(pkg: Package, rels: Rel[]): string | undefined {
  const cr = rels.find((r) => r.type === REL.comments);
  if (!cr) return undefined;
  const xml = pkg.text(cr.target);
  if (!xml) return undefined;
  const cdoc = child(parseXml(xml), "comments");
  const authors = children(child(cdoc, "authors"), "author").map((a) => text(a));
  const notes: Record<string, { author?: string; text: string }> = {};
  for (const cm of children(child(cdoc, "commentList"), "comment")) {
    const ca = attrs(cm);
    if (!ca.ref) continue;
    const tnode = child(cm, "text");
    const runs = children(tnode, "r");
    const t = (runs.length ? runs.map((r) => text(child(r, "t"))).join("") : text(child(tnode, "t"))).replace(/_x([0-9A-Fa-f]{4})_/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));
    const note: { author?: string; text: string } = { text: t };
    const author = authors[Number(ca.authorId ?? 0)];
    if (author) note.author = author;
    notes[ca.ref.replace(/\$/g, "")] = note;
  }
  return hashValue(notes);
}

export { parseRels };
