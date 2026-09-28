/**
 * Privilege-log spreadsheet export (xlsx package). Server/test-side only; the
 * description templates and status workflow live in privilege-templates.ts so
 * the client can use them without pulling the spreadsheet library.
 */
import * as XLSX from "xlsx";
import type { PrivilegeLogRow } from "./types";
import { statusExportLabel } from "./privilege-templates";

export { DESCRIPTION_TEMPLATES, PRIVILEGE_STATUSES, fillTemplate, statusExportLabel, templatesForBasis, nextPrivilegeStatuses, type DescriptionTemplate } from "./privilege-templates";

/** Rows as an .xlsx workbook (Privilege log sheet + Legend sheet). */
export function privilegeLogWorkbook(rows: PrivilegeLogRow[], meta: { matterName: string; caption?: string; generatedAt?: string }): XLSX.WorkBook {
  const header = ["Log No.", "Beg Bates", "End Bates", "Date", "Document Type", "Author", "Recipients", "Custodian", "Privilege Basis", "Description", "Status"];
  const data = rows.map((r, i) => {
    const [beg, end] = r.bates.split(/\s*–\s*/);
    return [i + 1, beg, end ?? beg, r.date, r.docType, r.author, r.recipients.join("; "), r.custodianName, r.basis, r.description, statusExportLabel(r.status)];
  });
  const ws = XLSX.utils.aoa_to_sheet([header, ...data]);
  ws["!cols"] = [{ wch: 7 }, { wch: 14 }, { wch: 14 }, { wch: 11 }, { wch: 14 }, { wch: 28 }, { wch: 40 }, { wch: 18 }, { wch: 18 }, { wch: 80 }, { wch: 10 }];
  ws["!autofilter"] = { ref: `A1:K${Math.max(1, data.length + 1)}` };
  const legend = XLSX.utils.aoa_to_sheet([
    ["Privilege log", meta.matterName],
    ["Caption", meta.caption ?? ""],
    ["Generated", meta.generatedAt ?? new Date().toISOString().slice(0, 10)],
    ["Entries", rows.length],
    [],
    ["Basis", "Meaning"],
    ["Attorney-client", "Advocate–client communication made in confidence in the course of and for the purpose of the advocate's employment (Bharatiya Sakshya Adhiniyam, 2023, s.132; Indian Evidence Act, 1872, s.126)."],
    ["Work product", "Confidential communication with the client's legal adviser, including material prepared for pending or contemplated litigation (BSA s.134; IEA s.129)."],
    ["Common interest", "Exchange between parties sharing a common legal interest under a common-interest agreement."],
    ["Joint defense", "Communication among co-defendants and their advocates sharing a common defence."],
    [],
    ["Status", "Meaning"],
    ["Withheld", "Final entry; the document is withheld in full."],
    ["In review", "Second-level review pending."],
    ["Draft", "Generated description; not yet reviewed."],
  ]);
  legend["!cols"] = [{ wch: 18 }, { wch: 100 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Privilege log");
  XLSX.utils.book_append_sheet(wb, legend, "Legend");
  return wb;
}

export function privilegeLogXlsx(rows: PrivilegeLogRow[], meta: { matterName: string; caption?: string; generatedAt?: string }): Uint8Array {
  const wb = privilegeLogWorkbook(rows, meta);
  return new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
}
