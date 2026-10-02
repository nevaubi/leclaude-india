"use client";
/** Client calls for the Drafting tab (dates, paperbook, para-wise reply, defects, translations) and the Word hand-off. */
import { toast } from "sonner";
import { markdownToDoc } from "@/modules/office/shared/markdown-doc";
import type { DateRow, DatesState, DefectNotice, PaperbookIndexRow, ParawiseState, TranslationRecord } from "../../drafting";
import type { DocFile } from "../../types";
import { classify, docsApi, setUrl } from "../api";

export interface DatesView { state: DatesState; rows: DateRow[]; extracted: number; total: number }
export interface ParawiseView { state: ParawiseState | null; stale: boolean; paragraphs: number; textHash: string; file: DocFile }
export interface TranslationView { file: DocFile; to: string; records: (TranslationRecord & { stale: boolean })[] }

export const datesApi = {
  get: (setId: string, signal?: AbortSignal) => docsApi<DatesView>(setUrl(setId, "/dates"), { signal }),
  save: (setId: string, patch: Record<string, unknown>) => docsApi<DatesView>(setUrl(setId, "/dates"), { method: "PATCH", json: patch }),
  synopsis: (setId: string, body: { rowIds: string[]; version: number }, signal?: AbortSignal) => docsApi<DatesView>(setUrl(setId, "/dates"), { method: "POST", json: body, signal }),
};

export const parawiseApi = {
  get: (setId: string, fileId: string, signal?: AbortSignal) => docsApi<ParawiseView>(setUrl(setId, `/parawise?file=${encodeURIComponent(fileId)}`), { signal }),
  start: (setId: string, fileId: string, restart = false) => docsApi<ParawiseView>(setUrl(setId, "/parawise"), { json: { fileId, action: restart ? "restart" : "start" } }),
  propose: (setId: string, fileId: string, version: number, signal?: AbortSignal, ns?: string[]) => docsApi<ParawiseView & { remaining: number; failed: number }>(setUrl(setId, "/parawise"), { json: { fileId, action: "propose", version, ns }, signal }),
  update: (setId: string, body: { fileId: string; version: number; n: string; stance?: string; reply?: string; approve?: boolean }) => docsApi<ParawiseView>(setUrl(setId, "/parawise"), { method: "PATCH", json: body }),
};

export const defectsApi = {
  list: (setId: string, signal?: AbortSignal) => docsApi<{ notices: DefectNotice[]; ai: boolean }>(setUrl(setId, "/defects"), { signal }),
  create: (setId: string, body: { title?: string; forum: string; text?: string; fileId?: string }, signal?: AbortSignal) => docsApi<{ notice: DefectNotice }>(setUrl(setId, "/defects"), { json: body, signal }),
  update: (setId: string, body: { noticeId: string; version: number; defectId: string; done?: boolean; category?: string; task?: string; fix?: string }) => docsApi<{ notice: DefectNotice }>(setUrl(setId, "/defects"), { method: "PATCH", json: body }),
  remove: (setId: string, noticeId: string) => docsApi<{ ok: true }>(setUrl(setId, `/defects?notice=${encodeURIComponent(noticeId)}`), { method: "DELETE" }),
};

export const translationsApi = {
  list: (setId: string, fileId: string, to: string, signal?: AbortSignal) => docsApi<TranslationView>(setUrl(setId, `/translations?file=${encodeURIComponent(fileId)}&to=${encodeURIComponent(to)}`), { signal }),
  translate: (setId: string, body: { fileId: string; from: string; to: string; pageFrom?: number; pageTo?: number; force?: boolean }, signal?: AbortSignal) =>
    docsApi<TranslationView & { translated: number; skipped: number; remaining: number }>(setUrl(setId, "/translations"), { json: body, signal }),
};

/** POST the paperbook (JSON, or multipart when files are attached). `preview` returns the index only. */
export async function postPaperbook(setId: string, spec: unknown, attachments: { key: string; file: File }[], opts: { preview?: boolean; signal?: AbortSignal } = {}): Promise<{ index: PaperbookIndexRow[]; totalPages: number; firstPage: number } | Blob> {
  const url = setUrl(setId, `/paperbook${opts.preview ? "?preview=1" : ""}`);
  let res: Response;
  if (attachments.length) {
    const fd = new FormData();
    fd.set("spec", JSON.stringify(spec));
    for (const a of attachments) fd.append(`upload:${a.key}`, a.file, a.file.name);
    res = await fetch(url, { method: "POST", body: fd, signal: opts.signal });
  } else {
    res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(spec), signal: opts.signal });
  }
  if (!res.ok) throw classify(res.status, (await res.json().catch(() => ({}))) as { error?: string; code?: string });
  return opts.preview ? ((await res.json()) as { index: PaperbookIndexRow[]; totalPages: number; firstPage: number }) : res.blob();
}

/** Indian filings: A4 paper and Indian English in the Word editor. */
const INDIA_WORD_SETTINGS = { pageSize: "a4", language: "en-IN", margins: "court", lineSpacing: 1.5, font: "serif", fontSize: 12 } as const;

/**
 * How AI was used for a document handed to Word (stored as meta.ai; the Word export writes it into the AI-use
 * provenance properties, so a drafted written statement is not exported as "no AI recorded").
 */
export interface WordAiUse { assisted: boolean; detail: string }

/** markdown → a new Word document (POST /api/office/docs), with a toast that opens it. */
export async function saveToWord(opts: { title: string; markdown: string; matterId?: string | null; source: string; tags?: string[]; ai?: WordAiUse }): Promise<string | null> {
  try {
    const content = markdownToDoc(opts.markdown);
    const ai = opts.ai ? { assisted: opts.ai.assisted, surface: opts.source, detail: opts.ai.detail.slice(0, 400), at: new Date().toISOString() } : undefined;
    const r = await docsApi<{ doc: { id: string; title: string } }>("/api/office/docs", { json: { kind: "word", title: opts.title, content, matterId: opts.matterId ?? undefined, tags: opts.tags ?? ["drafting"], meta: { source: opts.source, settings: INDIA_WORD_SETTINGS, ...(ai ? { ai } : {}) } } });
    toast.success(`${opts.title} saved to Word`, { action: { label: "Open", onClick: () => window.open(`/office/word/${r.doc.id}`, "_blank") } });
    return r.doc.id;
  } catch (e) {
    toast.error("Could not create the Word document", { description: (e as Error).message });
    return null;
  }
}

/** Download a blob under a name. */
export function saveBlob(blob: Blob, name: string) {
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1500);
}
