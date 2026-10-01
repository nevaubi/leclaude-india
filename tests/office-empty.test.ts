import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Office on an empty workspace (reference seed only): blank documents of every kind are created, open,
 * export to their format and import back; gallery templates carry no sample-dataset names.
 */
vi.hoisted(() => {
  process.env.LECLAUDE_DATA_DIR = `${process.env.TMPDIR || "/tmp"}/office-empty-vitest-${process.pid}`;
  process.env.LECLAUDE_SEED = "reference";
  process.env.LECLAUDE_BACKGROUND = "off";
  process.env.WORKFLOW_SCHEDULER_DISABLED = "1";
  process.env.OPENAI_API_KEY = "";
  process.env.ANTHROPIC_API_KEY = "";
});

import { FEATURES } from "@/lib/features";
import { rmSync } from "node:fs";
import { NextRequest } from "next/server";
import { db, resetSqlite } from "@/lib/db";
import type { OfficeKind } from "@/lib/types/domain";
import { emptyDoc } from "@/modules/office/word/doc-model";
import { emptyWorkbook } from "@/modules/office/sheet/model";
import { emptyDeck } from "@/modules/office/slides/model";
import { buildSlide } from "@/modules/office/slides/layouts";
import { emptyModel } from "@/modules/office/pdf/model";
import { allTemplates } from "@/modules/office/shared/template-registry";
import { officeHomeData } from "@/modules/office/home/service";
import * as docsRoute from "@/app/api/office/docs/route";
import * as docRoute from "@/app/api/office/docs/[id]/route";
import * as extractRoute from "@/app/api/office/pdf/[id]/extract/route";
import * as wordExport from "@/app/api/office/word/export/route";
import * as sheetExport from "@/app/api/office/sheet/export/route";
import * as slidesExport from "@/app/api/office/slides/export/route";
import * as pdfExport from "@/app/api/office/pdf/export/route";
import * as importRoute from "@/app/api/office/import/route";

const DEMO = /\b(AFFF|Meridian|Fluorochem|Whitfield|Hale|Pryce|Kaine|Voss|Raman|Okafor|Northgate|Apex Freight|Project Harbor|Bluewater|Sterling Medical|Gergel|MDL No\. 2873|Depo-Provera|Seeger|seegerweiss|Lowcountry|MFC-\d)/;

const post = (url: string, body: unknown) => new NextRequest(`http://localhost${url}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

function blankDeck() {
  const deck = emptyDeck();
  deck.slides = [buildSlide("title", { title: "Untitled deck", subtitle: "", date: "" }, deck.theme)];
  return deck;
}
const BLANK: Record<OfficeKind, () => unknown> = { word: emptyDoc, sheet: emptyWorkbook, slides: blankDeck, pdf: emptyModel };

beforeAll(() => {
  try { rmSync(process.env.LECLAUDE_DATA_DIR!, { recursive: true, force: true }); } catch { /* fresh */ }
  resetSqlite();
  db();
});

describe("office on an empty workspace", () => {
  it("home data is empty but lists the template gallery", async () => {
    const home = officeHomeData();
    expect(home.docs).toEqual([]);
    expect(home.matters).toEqual([]);
    expect(home.counts).toEqual({ word: 0, sheet: 0, slides: 0, pdf: 0 });
    expect(home.templates.length).toBeGreaterThan(10);
    expect(await awaitList(docsRoute)).toBe(true);
  });

  const created: Partial<Record<OfficeKind, string>> = {};
  const exported: Partial<Record<OfficeKind, Uint8Array>> = {};

  it("creates a blank document of each kind and opens it", async () => {
    for (const kind of ["word", "sheet", "slides", "pdf"] as OfficeKind[]) {
      const res = await docsRoute.POST(post("/api/office/docs", { kind, content: BLANK[kind]() }));
      expect(res.status, kind).toBe(200);
      const { doc } = (await res.json()) as { doc: { id: string; kind: string } };
      expect(doc.kind).toBe(kind);
      created[kind] = doc.id;
      const got = await docRoute.GET(new NextRequest(`http://localhost/api/office/docs/${doc.id}`), ctx(doc.id));
      expect(got.status).toBe(200);
    }
    // A blank PDF gets one blank page when it is first opened.
    const ex = await extractRoute.POST(new NextRequest(`http://localhost/api/office/pdf/${created.pdf}/extract`, { method: "POST" }), ctx(created.pdf!));
    expect(ex.status).toBe(200);
    const body = (await ex.json()) as { model: { pageCount: number; sourceBlobId: string } };
    expect(body.model.pageCount).toBe(1);
    expect(body.model.sourceBlobId).toBeTruthy();
    // The India product offers Word only (src/lib/features.ts); the other editors still work through the API but are not listed.
    const shown = FEATURES.officeAll ? 1 : 0;
    expect(officeHomeData().counts).toEqual({ word: 1, sheet: shown, slides: shown, pdf: shown });
  }, 60_000);

  it("exports each blank document to its format", async () => {
    const cases: [OfficeKind, (r: NextRequest) => Promise<Response>, Record<string, unknown>, RegExp, number[]][] = [
      ["word", wordExport.POST as never, { format: "docx" }, /officedocument\.wordprocessingml/, [0x50, 0x4b]],
      ["sheet", sheetExport.POST as never, { format: "xlsx" }, /officedocument\.spreadsheetml/, [0x50, 0x4b]],
      ["slides", slidesExport.POST as never, { format: "pptx" }, /officedocument\.presentationml/, [0x50, 0x4b]],
      ["pdf", pdfExport.POST as never, {}, /application\/pdf/, [0x25, 0x50, 0x44, 0x46]],
    ];
    for (const [kind, handler, extra, mime, magic] of cases) {
      const res = await handler(post(`/api/office/${kind}/export`, { docId: created[kind], ...extra }));
      expect(res.status, `${kind}: ${res.status === 200 ? "" : await res.clone().text()}`).toBe(200);
      expect(res.headers.get("Content-Type") ?? "", kind).toMatch(mime);
      const bytes = new Uint8Array(await res.arrayBuffer());
      expect(bytes.byteLength, kind).toBeGreaterThan(200);
      expect(Array.from(bytes.subarray(0, magic.length)), kind).toEqual(magic);
      exported[kind] = bytes;
    }
  }, 60_000);

  it("imports the exported .docx, .xlsx, .pptx and .pdf back into the matching editors", async () => {
    const ext: Record<OfficeKind, string> = { word: "docx", sheet: "xlsx", slides: "pptx", pdf: "pdf" };
    for (const kind of ["word", "sheet", "slides", "pdf"] as OfficeKind[]) {
      const form = new FormData();
      form.append("file", new File([exported[kind]! as BlobPart], `Imported ${kind}.${ext[kind]}`));
      form.append("allowDuplicate", "1");
      const res = await importRoute.POST(new NextRequest("http://localhost/api/office/import", { method: "POST", body: form }));
      expect(res.status, `${kind}: ${await res.clone().text()}`).toBeLessThan(300);
      const body = (await res.json()) as { doc?: { kind: string }; kind?: string };
      expect(body.doc?.kind ?? body.kind, kind).toBe(kind);
    }
  }, 60_000);

  it("creates every gallery template without sample-dataset names", async () => {
    for (const t of allTemplates()) {
      const res = await docsRoute.POST(post("/api/office/docs", { kind: t.kind, templateId: t.id, addToLibrary: false }));
      expect(res.status, t.id).toBe(200);
      const { doc } = (await res.json()) as { doc: { id: string; content: unknown } };
      const json = JSON.stringify(doc.content);
      const hit = json.match(DEMO);
      expect(hit?.[0], `${t.id} names "${hit?.[0]}"`).toBeUndefined();
      if (t.kind === "pdf") {
        // Gallery PDFs are generated from the generic specs: check the generated text too.
        const ex = await extractRoute.POST(new NextRequest(`http://localhost/api/office/pdf/${doc.id}/extract`, { method: "POST" }), ctx(doc.id));
        expect(ex.status, t.id).toBe(200);
        const m = (await ex.json()) as { model: { textIndex?: { text: string }[] } };
        const text = (m.model.textIndex ?? []).map((p) => p.text).join("\n");
        expect(text.length, t.id).toBeGreaterThan(50);
        expect(text.match(DEMO)?.[0], `${t.id} PDF text`).toBeUndefined();
      }
    }
  }, 120_000);
});

/** The collection route answers on an empty workspace (authorized, empty list). */
async function awaitList(route: typeof docsRoute) {
  const res = await route.GET(new NextRequest("http://localhost/api/office/docs"));
  expect(res.status).toBe(200);
  expect(((await res.json()) as { docs: unknown[] }).docs).toEqual([]);
  return true;
}
