import "server-only";
import * as XLSX from "xlsx";
import { can } from "@/lib/auth/policy";
import { refs } from "@/lib/auth/resources";
import type { Principal } from "@/lib/auth/types";
import { CODING_LABEL, type DocReviewRow, type ReviewCell } from "../review-types";
import { DocsError, loadSet } from "./access";
import { allRows, loadReview, sortRows } from "./review";
import { recordAudit } from "./sets";
import { docStore, type StoredReview } from "./store";

/**
 * Review exports (CSV and XLSX): one row per file with document type, importance, summary, each issue's relevance,
 * the privilege screen, every column's value with its page, verification state and quote, and the coding decision.
 * A matter set needs the matter's export permission; a personal set is exported by its owner.
 */

export type ExportFormat = "csv" | "xlsx";

const verified = (c: ReviewCell) => (c.status === "found" ? "verified" : c.status === "unverified" ? "unverified" : "");

export function exportTable(review: StoredReview, rows: DocReviewRow[]): string[][] {
  const header = ["File", "Pages", "Status", "Coverage", "Document type", "Importance", "Summary"];
  for (const i of review.issues) header.push(`Issue: ${i.label}`, `Issue: ${i.label} — page`);
  header.push("Privilege flag", "Privilege basis", "Privilege page");
  for (const c of review.columns) header.push(c.label, `${c.label} — page`, `${c.label} — verified`, `${c.label} — quote`);
  header.push("Coding", "Coding stale", "Coded issues", "Reviewer", "Coded at", "Note");
  const out: string[][] = [header];
  for (const r of rows) {
    const line = [r.fileName, String(r.pages), r.status, r.coverage.total ? `${Math.round((r.coverage.read / r.coverage.total) * 100)}%` : "", r.docType ?? "", r.importance == null ? "" : String(r.importance), r.summary];
    for (const i of review.issues) {
      const a = r.issues.find((x) => x.issueId === i.id);
      line.push(a ? a.relevance : "", a?.page != null ? String(a.page) : "");
    }
    line.push(r.privilege?.flag ?? "", r.privilege?.basis ?? "", r.privilege?.page != null ? String(r.privilege.page) : "");
    for (const c of review.columns) {
      const cell = r.cells[c.id];
      line.push(cell?.value ?? "", cell?.page != null ? String(cell.page) : "", cell ? verified(cell) : "", cell?.quote ?? "");
    }
    const d = r.decision;
    line.push(d ? CODING_LABEL[d.coding] : "", d ? (r.decisionStale ? "yes" : "no") : "", d ? d.issues.join("; ") : "", d ? d.reviewerName || d.reviewer : "", d?.at ?? "", d?.note ?? "");
    out.push(line);
  }
  return out;
}

/** Spreadsheet formula injection guard: a cell starting with = + - @ (or tab/CR) is prefixed with an apostrophe. */
export function safeCell(v: string): string {
  return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}

export function toCsv(table: string[][]): string {
  const esc = (v: string) => { const s = safeCell(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return `﻿${table.map((r) => r.map(esc).join(",")).join("\r\n")}\r\n`;
}

export function toXlsx(table: string[][], review: StoredReview): Uint8Array {
  const ws = XLSX.utils.aoa_to_sheet(table.map((r) => r.map(safeCell)));
  ws["!cols"] = table[0].map((h) => ({ wch: Math.min(60, Math.max(10, h.length + 2)) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Review");
  const about = XLSX.utils.aoa_to_sheet([
    ["Review", review.name],
    ["Version", String(review.version)],
    ["Exported", new Date().toISOString()],
    ["Verified", "The quote was found verbatim in the file text on that page (checked in code)."],
    ["Unverified", "The model gave a value whose quote was not found in the file text: check it against the document."],
    ["Privilege", "A suggestion for the reviewer only; an advocate merely copied on a business communication is not privilege by itself."],
    ["Coding stale", "The row was re-run after the reviewer coded it; the decision refers to an earlier version of the row."],
  ].map((r) => r.map(safeCell)));
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
  const table = exportTable(review, sortRows(await allRows(store, review), "name"));
  recordAudit(principal, "export", { kind: "document_review", id: review.id, label: review.name, matterId: set.matterId ?? undefined }, { setId: set.id, format, rows: table.length - 1 });
  const filename = exportFilename(review, format);
  if (format === "xlsx") return { body: toXlsx(table, review), contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", filename };
  return { body: toCsv(table), contentType: "text/csv; charset=utf-8", filename };
}
