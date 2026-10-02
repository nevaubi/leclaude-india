import "server-only";
import * as XLSX from "xlsx";
import { can } from "@/lib/auth/policy";
import { refs } from "@/lib/auth/resources";
import type { Principal } from "@/lib/auth/types";
import { CODING_LABEL, type CellStatus, type DocReviewRow, type ReviewCell } from "../review-types";
import { DocsError, loadSet } from "./access";
import { allRowPages, loadReview } from "./review";
import { recordAudit } from "./sets";
import { docStore, type StoredReview } from "./store";

/**
 * Review exports (CSV and XLSX): one row per file with document type, importance, summary, each issue's relevance,
 * the privilege screen, every column's value with its page, status, whether its quote was found and the quote itself,
 * and the coding decision. Rows not reviewed under the current definition and text are exported blank (status
 * pending). A matter set needs the matter's export permission; a personal set is exported by its owner.
 */

export type ExportFormat = "csv" | "xlsx";

const STATUS_LABEL: Record<CellStatus, string> = { found: "found", unverified: "unverified", conflict: "conflict", not_read: "not read", not_stated: "not stated" };

/** Value cell text: a conflict lists the other supported values after the first. */
const valueText = (c: ReviewCell) => {
  const alts = (c.alternatives ?? []).map((a) => `${a.value} (p. ${a.page ?? "?"})`);
  return alts.length ? `${c.value ?? ""} | conflicts with: ${alts.join("; ")}` : c.value ?? "";
};

export function exportTable(review: StoredReview, rows: DocReviewRow[]): string[][] {
  const header = ["File", "Pages", "Status", "Coverage", "Unread pages", "Document type", "Importance", "Summary"];
  for (const i of review.issues) header.push(`Issue: ${i.label}`, `Issue: ${i.label} — page`);
  header.push("Privilege flag", "Privilege basis", "Privilege page");
  for (const c of review.columns) header.push(c.label, `${c.label} — page`, `${c.label} — status`, `${c.label} — quote found`, `${c.label} — quote`);
  header.push("Coding", "Coding stale", "Coded issues", "Reviewer", "Coded at", "Note");
  const out: string[][] = [header];
  for (const r of rows) {
    const reviewed = r.status === "done" || r.status === "partial";
    const line = [
      r.fileName, String(r.pages), r.status, reviewed && r.coverage.total ? `${Math.round((r.coverage.read / r.coverage.total) * 100)}%` : "", r.coverage.unreadPages.join(", "),
      r.docType ?? "", r.importance == null ? "" : String(r.importance), r.summary,
    ];
    for (const i of review.issues) {
      const a = r.issues.find((x) => x.issueId === i.id);
      line.push(a ? a.relevance : "", a?.page != null ? String(a.page) : "");
    }
    line.push(r.privilege?.flag ?? "", r.privilege?.basis ?? "", r.privilege?.page != null ? String(r.privilege.page) : "");
    for (const c of review.columns) {
      const cell = r.cells[c.id];
      line.push(cell ? valueText(cell) : "", cell?.page != null ? String(cell.page) : "", cell ? STATUS_LABEL[cell.status] ?? "" : "", cell && cell.value != null ? (cell.quoteFound ? "yes" : "no") : "", cell?.quote ?? "");
    }
    const d = r.decision;
    line.push(d ? CODING_LABEL[d.coding] : "", d ? (r.decisionStale ? "yes" : "no") : "", d ? d.issues.join("; ") : "", d ? d.reviewerName || d.reviewer : "", d?.at ?? "", d?.note ?? "");
    out.push(line);
  }
  return out;
}

/** CSV formula injection guard: a cell starting with = + - @ (or tab/CR) is prefixed with an apostrophe (CSV only). */
export function safeCell(v: string): string {
  return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}

export function toCsv(table: string[][]): string {
  const esc = (v: string) => { const s = safeCell(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return `﻿${table.map((r) => r.map(esc).join(",")).join("\r\n")}\r\n`;
}

/** A sheet whose every cell is a plain string cell (t "s", never a formula), so nothing needs an apostrophe. */
function stringSheet(table: string[][]): XLSX.WorkSheet {
  const ws: XLSX.WorkSheet = {};
  table.forEach((row, r) => row.forEach((v, c) => { ws[XLSX.utils.encode_cell({ r, c })] = { t: "s", v: String(v ?? "") }; }));
  ws["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(0, table.length - 1), c: Math.max(0, ...table.map((r) => r.length - 1)) } });
  return ws;
}

export function toXlsx(table: string[][], review: StoredReview): Uint8Array {
  const ws = stringSheet(table);
  ws["!cols"] = table[0].map((h) => ({ wch: Math.min(60, Math.max(10, h.length + 2)) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Review");
  const about = stringSheet([
    ["Review", review.name],
    ["Version", String(review.version)],
    ["Exported", new Date().toISOString()],
    ["Quote found", "yes: the quote was found verbatim in the file text on that page (checked in code) and is long enough to support something."],
    ["found", "The quote was found and (for dates, amounts and parties) contains the value."],
    ["unverified", "The quote was not found, is too short, or does not contain the value: check it against the document."],
    ["conflict", "Different parts of the file give different supported values; all are listed. Requires review."],
    ["not read", "Nothing found in the part that was read, but part of the file was not read (scanned pages awaiting OCR, or the length cap)."],
    ["not stated", "Every page was read and the document does not state it."],
    ["pending", "Not reviewed under the current review definition and file text; nothing from an earlier run is shown."],
    ["Privilege", "A suggestion for the reviewer only; an advocate merely copied on a business communication is not privilege by itself."],
    ["Coding stale", "The row changed after the reviewer coded it; the decision refers to an earlier version of the row."],
  ]);
  XLSX.utils.book_append_sheet(wb, about, "About");
  return new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
}

export function exportFilename(review: StoredReview, format: ExportFormat): string {
  const slug = review.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "review";
  return `${slug}-${new Date().toISOString().slice(0, 10)}.${format}`;
}

export async function exportReview(principal: Principal, setId: string, reviewId: string, format: ExportFormat): Promise<{ body: Uint8Array | string; contentType: string; filename: string }> {
  const set = await loadSet(principal, setId, "read");
  if (set.matterId && !can(principal, "export", { ...refs.matter(set.matterId), tenantId: set.tenantId })) throw new DocsError("You may not export from this matter", 403, "forbidden");
  const store = await docStore();
  const review = await loadReview(store, set, reviewId);
  const rows: DocReviewRow[] = [];
  for await (const page of allRowPages(store, review, "name")) rows.push(...page);
  const table = exportTable(review, rows);
  recordAudit(principal, "export", { kind: "document_review", id: review.id, label: review.name, matterId: set.matterId ?? undefined }, { setId: set.id, format, rows: table.length - 1 });
  const filename = exportFilename(review, format);
  if (format === "xlsx") return { body: toXlsx(table, review), contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", filename };
  return { body: toCsv(table), contentType: "text/csv; charset=utf-8", filename };
}
