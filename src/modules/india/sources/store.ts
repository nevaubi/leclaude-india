import "server-only";
import { db } from "@/lib/db";
import { sha256 } from "@/lib/integrity/hash";
import type { LegalSourceId } from "@/lib/india/types";
import type { StoredEnactment, StoredEnactmentSection, StoredJudgment } from "./types";

/**
 * Storage for Indian legal material (`db().collection`, SQLite in development; the repository abstraction lets
 * production move to durable shared storage). Judgments, enactments and sections are small rows; full text lives in
 * the intel document blob (searchable, chunked) and original PDFs in content-addressed blobs (`ipdf_<sha256>`).
 */
export const INDIA_COLLECTIONS = {
  judgments: "india_judgments",
  enactments: "india_enactments",
  sections: "india_enactment_sections",
} as const;

export const indiaJudgments = () => db().collection<StoredJudgment>(INDIA_COLLECTIONS.judgments);
export const indiaEnactments = () => db().collection<StoredEnactment>(INDIA_COLLECTIONS.enactments);
export const indiaSections = () => db().collection<StoredEnactmentSection>(INDIA_COLLECTIONS.sections);

export function judgmentIdFor(source: LegalSourceId, externalId: string): string {
  return `ijdg_${sha256(`${source}|${externalId}`).slice(0, 20)}`;
}

export function enactmentIdFor(source: LegalSourceId, externalId: string): string {
  return `ienact_${sha256(`${source}|${externalId}`).slice(0, 20)}`;
}

export function sectionIdFor(enactmentId: string, number: string, order?: number): string {
  return `isec_${sha256(`${enactmentId}|${number}|${order ?? ""}`).slice(0, 20)}`;
}

/** Content-addressed blob id for an original file: identical bytes share one blob, changed bytes get a new one. */
export function pdfBlobIdFor(sha: string): string {
  return `ipdf_${sha}`;
}

export function putOriginalFile(bytes: Uint8Array, mime: string, meta: Record<string, unknown> & { name?: string }): { blobId: string; sha256: string; size: number; reused: boolean } {
  const sha = sha256(bytes);
  const blobId = pdfBlobIdFor(sha);
  const blobs = db().blobs;
  const existing = blobs.meta(blobId);
  if (!existing) blobs.put(bytes, mime, { id: blobId, name: meta.name, meta: { ...meta, sha256: sha } });
  return { blobId, sha256: sha, size: bytes.byteLength, reused: Boolean(existing) };
}

export function getOriginalFile(blobId: string): { bytes: Uint8Array; mime: string; name?: string } | null {
  const b = db().blobs.get(blobId);
  return b ? { bytes: b.bytes, mime: b.mime, name: b.name } : null;
}

export function upsertJudgment(j: Omit<StoredJudgment, "id" | "updatedAt"> & { id?: string }, now = new Date()): StoredJudgment {
  const id = j.id ?? judgmentIdFor(j.source, j.externalId);
  const existing = indiaJudgments().get(id);
  const row: StoredJudgment = { ...(existing ?? {}), ...j, id, retrievedAt: j.retrievedAt ?? now.toISOString(), updatedAt: now.toISOString() } as StoredJudgment;
  indiaJudgments().put(row);
  return row;
}

export function getJudgment(id: string): StoredJudgment | null {
  return indiaJudgments().get(id);
}

export function findJudgment(source: LegalSourceId, externalId: string): StoredJudgment | null {
  return indiaJudgments().get(judgmentIdFor(source, externalId));
}

export interface ListJudgmentsOptions {
  courtIds?: string[];
  sources?: LegalSourceId[];
  from?: string;
  to?: string;
  /** Case-insensitive substring over title, case number, neutral citation, CNR, judges. */
  q?: string;
  neutralCitation?: string;
  cnr?: string;
  includeUnresolved?: boolean;
  limit?: number;
  offset?: number;
}

export function listJudgments(o: ListJudgmentsOptions = {}): { items: StoredJudgment[]; total: number } {
  const q = o.q?.trim().toLowerCase();
  const all = indiaJudgments().find((j) => {
    if (o.courtIds?.length && !(j.courtId && o.courtIds.includes(j.courtId))) return false;
    if (o.includeUnresolved === false && !j.courtId) return false;
    if (o.sources?.length && !o.sources.includes(j.source)) return false;
    if (o.from && (!j.decisionDate || j.decisionDate < o.from)) return false;
    if (o.to && (!j.decisionDate || j.decisionDate > o.to)) return false;
    if (o.neutralCitation && j.neutralCitation !== o.neutralCitation) return false;
    if (o.cnr && j.cnr !== o.cnr) return false;
    if (q && ![j.title, j.caseNumber, j.neutralCitation, j.cnr, ...j.judges].some((s) => s?.toLowerCase().includes(q))) return false;
    return true;
  }).sort((a, b) => (b.decisionDate ?? "").localeCompare(a.decisionDate ?? ""));
  const offset = Math.max(0, o.offset ?? 0);
  const limit = Math.max(1, Math.min(o.limit ?? 50, 500));
  return { items: all.slice(offset, offset + limit), total: all.length };
}

export function upsertEnactment(e: Omit<StoredEnactment, "id" | "updatedAt"> & { id?: string; externalId: string }, now = new Date()): StoredEnactment {
  const { externalId, ...rest } = e;
  const id = e.id ?? enactmentIdFor(e.source, externalId);
  const existing = indiaEnactments().get(id);
  const row: StoredEnactment = { ...(existing ?? {}), ...rest, id, updatedAt: now.toISOString() } as StoredEnactment;
  indiaEnactments().put(row);
  return row;
}

export function replaceSections(enactmentId: string, sections: Omit<StoredEnactmentSection, "id" | "enactmentId" | "updatedAt">[], now = new Date()): StoredEnactmentSection[] {
  const col = indiaSections();
  const rows = sections.map((s): StoredEnactmentSection => ({ ...s, id: sectionIdFor(enactmentId, s.number, s.order), enactmentId, updatedAt: now.toISOString() }));
  const keep = new Set(rows.map((r) => r.id));
  for (const old of col.find((x) => x.enactmentId === enactmentId)) if (!keep.has(old.id)) col.delete(old.id);
  col.putMany(rows);
  return rows;
}

export function listEnactments(o: { jurisdiction?: "central" | "state"; state?: string; q?: string; limit?: number } = {}): StoredEnactment[] {
  const q = o.q?.trim().toLowerCase();
  return indiaEnactments().find((e) => (!o.jurisdiction || e.jurisdiction === o.jurisdiction) && (!o.state || e.state === o.state) && (!q || [e.title, e.shortTitle, e.actNumber].some((s) => s?.toLowerCase().includes(q))))
    .sort((a, b) => b.year - a.year || a.title.localeCompare(b.title))
    .slice(0, Math.max(1, Math.min(o.limit ?? 100, 1000)));
}

export function getEnactment(id: string): StoredEnactment | null {
  return indiaEnactments().get(id);
}

/** Sections of an enactment in statutory order. */
export function getSections(enactmentId: string): StoredEnactmentSection[] {
  return indiaSections().find((s) => s.enactmentId === enactmentId).sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.number.localeCompare(b.number, "en", { numeric: true }));
}

/** One section by its number as printed ("33", "53A"); returns null when absent (never the nearest section). */
export function getSection(enactmentId: string, number: string): StoredEnactmentSection | null {
  const n = number.trim().toUpperCase();
  return indiaSections().findOne((s) => s.enactmentId === enactmentId && s.number.toUpperCase() === n);
}
