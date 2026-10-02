import "server-only";
import { matterFolderId } from "@/modules/library/ids";
import type { Database } from "@/lib/db";
import type { LibraryItem, OfficeComment } from "@/lib/types/domain";
import { MATTERS, PEOPLE } from "@/lib/seed/ids";
import { createOfficeDoc, saveOfficeDoc } from "@/modules/office/shared/docs-service";
import { addDays, buildWorkbook, cells, inputs, section, table, title, widths, LABEL_STYLE, NOTE_STYLE, TOTAL_STYLE, type CellSpec } from "./builders";
import type { Workbook } from "./model";
import { applyOp, type SheetOp } from "./ops";
import { closingChecklistWorkbook, depositionScheduleWorkbook, pagaExposureWorkbook } from "./templates";

const CUR = "$#,##0.00" as const;
const CUR0 = "$#,##0" as const;
const INR0 = "₹#,##0" as const;
const PCT = "0.0%" as const;
const DATE = "mmm d yyyy" as const;

/** Valsara arbitration expert budget: four retained experts × phases × hours × rates, plus expenses and invoiced-to-date. */
function valsaraExpertBudget(): Workbook {
  const experts = [
    { name: "Dr. Leela Sundaram", field: "Toxicology (MC-8 dose-response)", rate: 18000, hours: [40, 120, 60, 48, 30, 40], expenses: 210000, invoiced: 1782000 },
    { name: "Dr. Raj Patel", field: "Hydrogeology (plume transport model)", rate: 15500, hours: [36, 140, 70, 40, 24, 36], expenses: 520000, invoiced: 1643000 },
    { name: "Prof. Sameer Ohri", field: "Supply-contract notice practice (Clause 9.4)", rate: 14000, hours: [20, 80, 40, 32, 20, 24], expenses: 76000, invoiced: 504000 },
    { name: "Rakesh Bansal, CA", field: "Wellfield remediation cost rebuttal", rate: 12500, hours: [24, 96, 48, 32, 16, 32], expenses: 98000, invoiced: 0 },
  ];
  const phases = ["Retention & file review", "Report", "Rebuttal report", "Deposition prep & deposition", "Objections briefing support", "Hearing prep & testimony"];
  const rows = experts.map((e, i) => { const n = 7 + i; return [e.name, e.field, e.rate, ...e.hours, `=SUM(D${n}:I${n})`, `=J${n}*C${n}`, e.expenses, `=K${n}+L${n}`, e.invoiced, `=M${n}-N${n}`]; });
  const last = 6 + experts.length;
  const ops: SheetOp[] = [
    ...title("Valsara v. Meridian — Expert Budget", "Respondent's experts for Meridian Fine Chemicals: hours by phase × hourly rate, expenses, invoiced to date and remaining. Rates per engagement letters (INR).", 1, 15),
    ...inputs("A3", [{ label: "Budget as of", value: "2026-09-22", fmt: DATE }, { label: "Rebuttal report deadline (PO 4)", value: "2026-11-06", fmt: DATE }]).ops,
    ...table({ anchor: "A6", headers: ["Expert", "Field", "Rate", ...phases, "Total hours", "Fees", "Expenses", "Total budget", "Invoiced to date", "Remaining"], rows, formats: { 2: INR0, 3: "0", 4: "0", 5: "0", 6: "0", 7: "0", 8: "0", 9: "0", 10: INR0, 11: INR0, 12: INR0, 13: INR0, 14: "₹#,##0;(₹#,##0)" }, total: { columns: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14] }, freeze: true, widths: [170, 260, 80, 130, 90, 110, 160, 150, 140, 100, 110, 100, 120, 130, 110] }),
    { type: "style_range", range: `C7:I${last}`, style: { fill: "#FFF8E1" } },
    { type: "style_range", range: `N7:N${last}`, style: { fill: "#FFF8E1" } },
    { type: "conditional_format", range: `O7:O${last}`, rule: { kind: "lt", value: 0 }, style: { color: "#9F1239", bold: true } },
    ...section(`A${last + 3}`, "Phase totals (fees)", 4),
    cells(phases.flatMap((p, i): CellSpec[] => { const col = String.fromCharCode(68 + i); const r = last + 4 + i; return [[`A${r}`, p, { border: "thin" }], [`B${r}`, `=SUMPRODUCT(${col}7:${col}${last},$C$7:$C$${last})`, { numFmt: INR0, border: "thin" }], [`C${r}`, `=B${r}/$B$${last + 10}`, { numFmt: PCT, border: "thin" }]]; })),
    cells([[`A${last + 10}`, "Total fees", TOTAL_STYLE], [`B${last + 10}`, `=SUM(B${last + 4}:B${last + 9})`, { ...TOTAL_STYLE, numFmt: INR0 }], [`C${last + 10}`, `=SUM(C${last + 4}:C${last + 9})`, { ...TOTAL_STYLE, numFmt: PCT }]]),
    cells([[`A${last + 12}`, "Rebuttal reports due 2026-11-06 under Procedural Order No. 4 ¶ 3(b); objections to expert evidence by 2026-12-18. Hours for Rakesh Bansal are an estimate pending scope call with the client.", NOTE_STYLE]]),
    { type: "merge_cells", range: `A${last + 12}:I${last + 12}` },
    { type: "add_chart", chart: { type: "bar", title: "Budget vs invoiced by expert", range: `M6:N${last}`, categoryRange: `A7:A${last}`, hasHeader: true, position: { x: 620, y: (last + 3) * 24, w: 560, h: 280 } } },
  ];
  return buildWorkbook([{ name: "Expert Budget", ops }]);
}

/** Northgate v. Apex: commercial damages model for cargo losses at the Joliet cross-dock. */
function northgateDamages(): Workbook {
  const inp = inputs("A4", [
    { label: "Breach date (first cargo loss)", value: "2025-02-11", fmt: DATE, name: "BreachDate" },
    { label: "Projected judgment date", value: "2027-03-31", fmt: DATE, name: "JudgmentDate" },
    { label: "Illinois prejudgment interest (815 ILCS 205/2)", value: 0.05, fmt: PCT, name: "PJI", note: "Simple interest on liquidated sums; confirm applicability" },
    { label: "Post-judgment rate (735 ILCS 5/2-1303)", value: 0.09, fmt: PCT, name: "PostRate" },
    { label: "Contractual indemnity cap (MTSA §11.3)", value: 2500000, fmt: CUR0, name: "Cap", note: "Disputed: Apex argues cap applies to all claims" },
    { label: "Consequential damages waiver applies?", value: "Disputed", note: "MTSA §11.4 carve-out for gross negligence" },
  ]);
  const incidents = [
    ["2025-02-11", "Joliet cross-dock — trailer 4471 (pharma cold chain)", "Temperature excursion; shipment rejected", 412860.5, 18420, 31250],
    ["2025-03-03", "Joliet cross-dock — trailers 4490/4493", "Mis-routed to Memphis; 9-day delay", 96210, 24800, 48600],
    ["2025-04-22", "Joliet cross-dock — trailer 4512 (electronics)", "Theft from unsecured yard", 738400, 0, 12000],
    ["2025-06-09", "Joliet cross-dock — trailer 4530", "Forklift damage, 62 pallets", 184320.25, 9600, 21750],
    ["2025-08-14", "Joliet cross-dock — trailer 4551 (pharma cold chain)", "Temperature excursion; partial loss", 265900, 14200, 37400],
  ];
  const rows = incidents.map((r, i) => { const n = 13 + i; return [r[0], r[1], r[2], r[3], r[4], r[5], `=D${n}+E${n}+F${n}`, `=G${n}*PJI*YEARFRAC(A${n},JudgmentDate)`, `=G${n}+H${n}`]; });
  const last = 12 + incidents.length;
  const ops: SheetOp[] = [
    ...title("Northgate v. Apex — Damages Model", "Direct damages by incident (cargo value, replacement freight, customer chargebacks), consequential damages (disputed), prejudgment interest and cap analysis.", 1, 9),
    ...inp.ops,
    ...section("A11", "Direct damages by incident", 9),
    ...table({ anchor: "A12", headers: ["Date", "Shipment", "Cause", "Cargo value (invoice)", "Replacement freight", "Customer chargebacks", "Direct damages", "Prejudgment interest", "Total with interest"], rows, formats: { 0: DATE, 3: CUR, 4: CUR, 5: CUR, 6: CUR, 7: CUR, 8: CUR }, total: { columns: [3, 4, 5, 6, 7, 8] }, freeze: true, widths: [110, 330, 260, 150, 140, 150, 140, 150, 150] }),
    ...section(`A${last + 3}`, "Consequential damages (disputed under MTSA §11.4)", 4),
    cells([
      [`A${last + 4}`, "Lost profits — terminated Vantage Pharma account (12 months)", { border: "thin" }], [`B${last + 4}`, 1840000, { numFmt: CUR0, border: "thin", fill: "#FFF8E1" }], [`C${last + 4}`, "Per Northgate CFO declaration ¶¶ 14–19 [VERIFY]", NOTE_STYLE],
      [`A${last + 5}`, "Cost of substitute cross-dock (Bolingbrook), 8 months", { border: "thin" }], [`B${last + 5}`, 296000, { numFmt: CUR0, border: "thin", fill: "#FFF8E1" }],
      [`A${last + 6}`, "Total consequential", TOTAL_STYLE], [`B${last + 6}`, `=SUM(B${last + 4}:B${last + 5})`, { ...TOTAL_STYLE, numFmt: CUR0 }],
    ]),
    ...section(`A${last + 8}`, "Summary and cap analysis", 4),
    cells([
      [`A${last + 9}`, "Direct damages", LABEL_STYLE], [`B${last + 9}`, `=G${last + 1}`, { numFmt: CUR }],
      [`A${last + 10}`, "Prejudgment interest (through judgment)", LABEL_STYLE], [`B${last + 10}`, `=H${last + 1}`, { numFmt: CUR }],
      [`A${last + 11}`, "Consequential damages (if waiver inapplicable)", LABEL_STYLE], [`B${last + 11}`, `=B${last + 6}`, { numFmt: CUR }],
      [`A${last + 12}`, "Total claimed", TOTAL_STYLE], [`B${last + 12}`, `=SUM(B${last + 9}:B${last + 11})`, { ...TOTAL_STYLE, numFmt: CUR }],
      [`A${last + 13}`, "Recoverable if cap applies to all claims", LABEL_STYLE], [`B${last + 13}`, `=MIN(B${last + 12},Cap)`, { numFmt: CUR }],
      [`A${last + 14}`, "Recoverable if cap excludes gross negligence (theft incident)", LABEL_STYLE], [`B${last + 14}`, `=MIN(B${last + 12}-I15,Cap)+I15`, { numFmt: CUR }],
      [`A${last + 15}`, "Post-judgment interest per day", LABEL_STYLE], [`B${last + 15}`, `=B${last + 12}*PostRate/365`, { numFmt: CUR }],
    ]),
    ...widths({ A: 380, B: 150, C: 320 }),
    { type: "add_chart", chart: { type: "bar", title: "Direct damages by incident", range: `G12:G${last}`, categoryRange: `A13:A${last}`, hasHeader: true, position: { x: 880, y: (last + 3) * 24, w: 520, h: 300 } } },
  ];
  return buildWorkbook([{ name: "Damages", ops }], { namedRanges: Object.fromEntries(Object.entries(inp.named).map(([k, v]) => [k, `Damages!${v}`])) });
}

function harborClosingChecklist(): Workbook {
  return closingChecklistWorkbook({ title: "Project Harbor — Closing Checklist (Bluewater Analytics acquisition)", signing: "2026-10-15" });
}

function sterlingPaga(): Workbook {
  return pagaExposureWorkbook({
    title: "Sterling Medical Group — PAGA Exposure (14 clinics)",
    employees: 638,
    payPeriods: 26,
    aggrieved: 0.68,
    violations: [
      { code: "§226.7 / §512", label: "Meal periods — late/short (timeclock rounding)", rate: 0.27, initial: 100, subsequent: 200 },
      { code: "§226.7", label: "Rest breaks — clinic staffing gaps", rate: 0.14, initial: 100, subsequent: 200 },
      { code: "§510 / §1194", label: "Unpaid overtime from 7-minute rounding", rate: 0.09, initial: 100, subsequent: 200 },
      { code: "§226(a)", label: "Wage statements — missing pay-period dates", rate: 0.58, initial: 250, subsequent: 1000 },
      { code: "§203", label: "Waiting-time (142 separated employees)", rate: 0.07, initial: 100, subsequent: 200 },
    ],
  });
}

function valsaraDepoSchedule(): Workbook {
  return depositionScheduleWorkbook({
    title: "Valsara v. Meridian — Deposition Schedule (Meridian custodians and Respondent's experts)",
    rows: [
      ["Anil Prasad", "VP, Textile Chemicals (Meridian)", "Claimant", "2026-09-18", "9:30 AM IST", "New Delhi — firm office", "Nyaya Transcripts / D. Wadhwa", "A. Mehra", "CX-180–CX-199", "Transcript pending"],
      ["Girish Hegde", "Director, EHS (Meridian)", "Claimant", "2026-10-06", "9:30 AM IST", "New Delhi — firm office", "Nyaya Transcripts / D. Wadhwa", "A. Mehra", "CX-201–CX-238", "Noticed"],
      ["Hema Vasudevan", "Senior Toxicologist (Meridian)", "Claimant", "2026-10-09", "9:00 AM IST", "Remote (video)", "Nyaya Transcripts / M. Bell", "P. Raman", "CX-240–CX-262", "Noticed"],
      ["Nandini Bose", "Product Stewardship Manager (Meridian)", "Claimant", "2026-10-14", "9:30 AM IST", "New Delhi — firm office", "Nyaya Transcripts / TBD", "E. Mathur", "CX-263–CX-281", "Noticed"],
      ["Rohit Kapur", "Associate General Counsel (Meridian)", "Claimant", "2026-10-21", "10:00 AM IST", "New Delhi — firm office", "Nyaya Transcripts / TBD", "A. Mehra", "Privilege log entries 1–14", "Confirmed"],
      ["Dr. Leela Sundaram", "Toxicology expert (Respondent)", "Claimant", "2026-11-12", "10:00 AM IST", "Mumbai — firm office", "Nyaya Transcripts / TBD", "P. Raman", "Report, reliance list", "Tentative"],
      ["Dr. Raj Patel", "Hydrogeology expert (Respondent)", "Claimant", "2026-11-19", "9:00 AM IST", "Remote (video)", "Nyaya Transcripts / TBD", "D. Oberoi", "Report, model files", "Tentative"],
    ],
  });
}

interface SeedWorkbook {
  id: string;
  title: string;
  matterId: string;
  templateId?: string;
  build: () => Workbook;
  createdAt: string;
  versions: { at: string; summary: string; label?: string; author?: string; transform: (wb: Workbook) => Workbook }[];
  comments: { id: string; anchor: string; body: string; author?: string; agent?: boolean; quote?: string; createdAt: string; resolved?: boolean; replies?: { id: string; body: string; authorName: string; createdAt: string }[] }[];
  tags?: string[];
}

/** Seed sample sheet documents (stable ids, idempotent). */
export function seedSheet(db: Database) {
  const docs: SeedWorkbook[] = [
    {
      id: "ws_vls_expert_budget", title: "Valsara — Expert budget", matterId: MATTERS.valsara, build: valsaraExpertBudget, createdAt: "2026-09-08T13:20:00Z", tags: ["budget", "experts"],
      versions: [
        { at: "2026-09-15T16:05:00Z", summary: "Updated invoiced-to-date from September expert invoices", author: "Meera Lobo", transform: (wb) => applyOp(wb, { type: "set_cells", sheet: "Expert Budget", cells: [{ ref: "N7", value: 1782000 }, { ref: "N8", value: 1643000 }] }) },
        { at: "2026-09-22T09:41:00Z", summary: "Agent edit: added phase totals block and budget-vs-invoiced chart", label: "Before partner review", author: "Spreadsheet assistant", transform: (wb) => applyOp(wb, { type: "conditional_format", sheet: "Expert Budget", range: "O7:O10", rule: { kind: "lt", value: 500000 }, style: { fill: "#FEF3C7", color: "#92400E" } }) },
      ],
      comments: [
        { id: "wsc_vls_budget_1", anchor: "Expert Budget!C10", body: "Rakesh Bansal's rate is the proposal rate; engagement letter not yet countersigned. Confirm before we send the budget to Meridian.", quote: "₹12,500", author: "Priya Raman", createdAt: "2026-09-22T10:12:00Z", replies: [{ id: "wsc_vls_budget_1_r1", body: "Countersigned letter expected Friday; I will update the rate and re-run totals.", authorName: "Meera Lobo", createdAt: "2026-09-22T14:30:00Z" }] },
        { id: "wsc_vls_budget_2", anchor: "Expert Budget!H8", body: "Deposition hours for Dr. Patel assume a single 7-hour session; the Claimant has asked for two days. Consider 56 hours.", quote: "40", author: "Spreadsheet assistant", agent: true, createdAt: "2026-09-22T09:42:00Z" },
      ],
    },
    {
      id: "ws_northgate_damages", title: "Northgate v. Apex — Damages model", matterId: MATTERS.northgate, build: northgateDamages, createdAt: "2026-08-19T18:02:00Z", tags: ["damages", "summary judgment"],
      versions: [
        { at: "2026-09-04T11:15:00Z", summary: "Added August 14 cold-chain incident and updated chargebacks per Vantage credit memo", author: "Esha Mathur", transform: (wb) => applyOp(wb, { type: "set_cells", sheet: "Damages", cells: [{ ref: "F17", value: 37400 }] }) },
        { at: "2026-09-19T15:48:00Z", summary: "Agent edit: cap analysis rows and prejudgment interest per incident", author: "Spreadsheet assistant", transform: (wb) => applyOp(wb, { type: "style_range", sheet: "Damages", range: "B30:B32", style: { bold: true } }) },
      ],
      comments: [
        { id: "wsc_northgate_1", anchor: "Damages!B22", body: "Lost-profits figure comes from the CFO declaration; Apex will argue §11.4 waives consequential damages entirely. Keep the direct-damages-only scenario in the MSJ brief.", quote: "$1,840,000", author: "Arjun Mehra", createdAt: "2026-09-19T16:20:00Z" },
        { id: "wsc_northgate_2", anchor: "Damages!B6", body: "815 ILCS 205/2 prejudgment interest applies only to liquidated sums; chargebacks may not qualify. Flagging for the brief.", quote: "5.0%", author: "Spreadsheet assistant", agent: true, createdAt: "2026-09-19T15:49:00Z", resolved: true },
      ],
    },
    {
      id: "ws_harbor_closing_checklist", title: "Project Harbor — Closing checklist", matterId: MATTERS.harbor, templateId: "sheet-closing-checklist", build: harborClosingChecklist, createdAt: "2026-09-01T09:00:00Z", tags: ["M&A", "closing"],
      versions: [
        { at: "2026-09-16T17:30:00Z", summary: "Status updates after weekly all-hands: consents 12 of 20, binder received", author: "Dhruv Oberoi", transform: (wb) => applyOp(wb, { type: "set_cells", sheet: "Checklist", cells: [{ ref: "F10", value: "Binder received" }, { ref: "F12", value: "12 of 20 received" }] }) },
        { at: "2026-09-23T08:55:00Z", summary: "Agent edit: flagged IP assignment chain gap as overdue and added summary block", author: "Spreadsheet assistant", transform: (wb) => applyOp(wb, { type: "set_cells", sheet: "Checklist", cells: [{ ref: "I13", value: "Two contractor assignments missing (Oberoi chasing former CTO)" }] }) },
      ],
      comments: [
        { id: "wsc_harbor_1", anchor: "Checklist!B13", body: "The two missing contractor IP assignments cover the feature-extraction module. If we cannot get them signed by signing, we need a specific indemnity in the SPA.", quote: "IP assignment agreements — founders and contractors (ML models)", author: "Dhruv Oberoi", createdAt: "2026-09-23T09:10:00Z", replies: [{ id: "wsc_harbor_1_r1", body: "Agreed — draft the specific indemnity as a fallback and send to Bluewater counsel Thursday.", authorName: "Arjun Mehra", createdAt: "2026-09-23T11:02:00Z" }] },
      ],
    },
    {
      id: "ws_sterling_paga", title: "Sterling Medical — PAGA exposure model", matterId: MATTERS.sterling, templateId: "sheet-paga-exposure", build: sterlingPaga, createdAt: "2026-09-10T14:45:00Z", tags: ["PAGA", "exposure"],
      versions: [
        { at: "2026-09-17T12:20:00Z", summary: "Violation rates updated from the 4-clinic timeclock sample (n=1,184 shifts)", author: "Sameer Chawla", transform: (wb) => applyOp(wb, { type: "set_cells", sheet: "Exposure", cells: [{ ref: "C13", value: 0.27 }, { ref: "C14", value: 0.14 }] }) },
        { at: "2026-09-21T10:05:00Z", summary: "Agent edit: added discretionary-reduction scenarios and exposure chart", author: "Spreadsheet assistant", transform: (wb) => applyOp(wb, { type: "conditional_format", sheet: "Exposure", range: "J13:J17", rule: { kind: "top", count: 1 }, style: { fill: "#FDE2E1", color: "#9F1239", bold: true } }) },
      ],
      comments: [
        { id: "wsc_sterling_1", anchor: "Exposure!B7", body: "Aggrieved share of 68% is from the timeclock sample; the LWDA notice alleges all non-exempt staff. Model a 100% scenario for the client call.", quote: "68.0%", author: "Sameer Chawla", createdAt: "2026-09-21T10:30:00Z" },
        { id: "wsc_sterling_2", anchor: "Exposure!E16", body: "Wage-statement subsequent penalty of $1,000 applies only after notice or citation (Lab. Code §226.3); consider $250 across the board for the base case.", quote: "$1,000", author: "Spreadsheet assistant", agent: true, createdAt: "2026-09-21T10:06:00Z" },
      ],
    },
    {
      id: "ws_vls_depo_schedule", title: "Valsara — Deposition schedule", matterId: MATTERS.valsara, templateId: "sheet-deposition-schedule", build: valsaraDepoSchedule, createdAt: "2026-08-28T16:10:00Z", tags: ["depositions"],
      versions: [
        { at: "2026-09-19T09:30:00Z", summary: "Prasad deposition taken 9/18; transcript pending", author: "Meera Lobo", transform: (wb) => applyOp(wb, { type: "set_cells", sheet: "Schedule", cells: [{ ref: "J5", value: "Transcript pending" }] }) },
        { at: "2026-09-23T13:12:00Z", summary: "Agent edit: sorted by date and added upcoming/outstanding counters", author: "Spreadsheet assistant", transform: (wb) => applyOp(wb, { type: "sort_range", sheet: "Schedule", range: "A4:K11", by: "D", order: "asc", has_header: true }) },
      ],
      comments: [
        { id: "wsc_depo_1", anchor: "Schedule!D9", body: "Kapur deposition: the Claimant agreed to limit questioning to the privilege log entries; confirm the stipulation is on the record before 10/21.", quote: "Oct 21 2026", author: "Arjun Mehra", createdAt: "2026-09-23T13:40:00Z" },
      ],
    },
  ];

  const libraryItems: LibraryItem[] = [];
  for (const sd of docs) {
    if (db.officeDocs.has(sd.id)) continue;
    const v1 = sd.build();
    const doc = createOfficeDoc({ id: sd.id, kind: "sheet", title: sd.title, content: v1, matterId: sd.matterId, templateId: sd.templateId, tags: sd.tags, meta: { sheets: v1.sheets.length } });
    db.officeDocs.update(doc.id, { createdAt: sd.createdAt, updatedAt: sd.createdAt });
    for (const v of db.officeVersions.find((x) => x.docId === sd.id)) db.officeVersions.update(v.id, { createdAt: sd.createdAt });
    let content = v1;
    sd.versions.forEach((v, i) => {
      content = v.transform(content);
      saveOfficeDoc(sd.id, { content, version: { force: true, summary: v.summary, label: v.label, authorName: v.author } });
      const latest = db.officeVersions.find((x) => x.docId === sd.id).sort((a, b) => b.version - a.version)[0];
      if (latest && latest.summary === v.summary) db.officeVersions.update(latest.id, { createdAt: v.at, authorId: v.author === "Spreadsheet assistant" ? undefined : PEOPLE.arjunMehra });
      else db.officeVersions.put({ id: `${sd.id}_v${i + 2}`, docId: sd.id, version: (latest?.version ?? 1) + 1, label: v.label, summary: v.summary, authorName: v.author ?? "Arjun Mehra", createdAt: v.at, content, changedFields: 0 });
      db.officeDocs.update(sd.id, { updatedAt: v.at });
    });
    const comments: OfficeComment[] = sd.comments.map((c) => ({ id: c.id, docId: sd.id, anchor: c.anchor, quote: c.quote, body: c.body, authorId: c.agent ? undefined : PEOPLE.arjunMehra, authorName: c.author ?? "Arjun Mehra", createdAt: c.createdAt, resolved: c.resolved, replies: c.replies ?? [], source: c.agent ? "agent" : "user" }));
    db.officeComments.putMany(comments);
    const lastAt = sd.versions.at(-1)?.at ?? sd.createdAt;
    libraryItems.push({ id: `lib_${sd.id}`, parentId: sd.matterId ? matterFolderId(sd.matterId) : null, name: sd.title, type: "xlsx", matterId: sd.matterId, officeDocId: sd.id, size: JSON.stringify(content).length, tags: sd.tags, ownerId: PEOPLE.arjunMehra, sharedWith: ["matter-team"], createdAt: sd.createdAt, updatedAt: lastAt, description: `Workbook · ${content.sheets.length} sheet${content.sheets.length === 1 ? "" : "s"}`, version: sd.versions.length + 1, status: "draft" });
  }
  if (libraryItems.length) db.library.putMany(libraryItems);
}

export { addDays, valsaraExpertBudget, northgateDamages, harborClosingChecklist, sterlingPaga, valsaraDepoSchedule };
