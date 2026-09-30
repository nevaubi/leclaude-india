import { beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.LECLAUDE_DATA_DIR = `${process.env.VITEST_DATA_DIR || process.env.TMPDIR || "/tmp"}/documents-review-vitest-${process.pid}`;
  process.env.LECLAUDE_BACKGROUND = "off";
  process.env.WORKFLOW_SCHEDULER_DISABLED = "1";
  delete process.env.DATABASE_URL;
  delete process.env.POSTGRES_URL;
});

/** Model calls can be held open (gate) so a test can change the file while extraction is running. */
const ctl = vi.hoisted(() => ({ gate: null as null | Promise<void>, ocr: "" }));
vi.mock("@/lib/ai/agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/agent")>();
  return {
    ...actual,
    generateJSON: async (o: { input: string; signal?: AbortSignal }) => {
      if (ctl.gate) await Promise.race([ctl.gate, new Promise((_, reject) => o.signal?.addEventListener("abort", () => reject(new Error("This operation was aborted"))))]);
      return { facts: [{ statement: "Old fact", parties: [], category: "other", quote: "Alpha clause", page: 1, date: null }], events: [] };
    },
    describeImage: async () => ({ text: ctl.ocr, responseId: "r" }),
  };
});

import { db, resetSqlite } from "@/lib/db";
import type { Principal } from "@/lib/auth/types";
import { setDocStoreForTests, docStore } from "@/modules/documents/server/store";
import { createSet, deleteFile, getFilePages, resetStorageCacheForTests } from "@/modules/documents/server/sets";
import { appendPages, ocrPage, uploadBrowserPdf } from "@/modules/documents/server/ingest";
import { listFacts, runExtraction } from "@/modules/documents/server/extract";
import { searchDocSets } from "@/modules/documents/server";

/** Regression tests for the adversarial review of document sets. */
const P: Principal = { id: "u1", name: "u1", tenantId: "default", roles: ["associate"], matterIds: [], source: "dev" };
const PNG = `data:image/png;base64,${Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]).toString("base64")}`;
const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));

beforeAll(() => { resetSqlite(); db(); setDocStoreForTests("sqlite"); resetStorageCacheForTests(); });

describe("document sets: review regressions", () => {
  it("discards an extraction whose text changed mid-run (OCR) and leaves the file pending", async () => {
    const set = await createSet(P, { name: "s1" });
    const up = await uploadBrowserPdf(P, set.id, { kind: "pdf-text", name: "a.pdf", size: 10, sha256: "1".repeat(64), pages: ["Alpha clause text.", ""] });
    if (up.status !== "created") throw new Error("upload failed");
    let release!: () => void;
    ctl.gate = new Promise((r) => (release = r));
    const run = runExtraction(P, set.id, {});
    await tick();
    ctl.ocr = "Beta clause: the tenant admitted default on 03.04.2022.";
    await ocrPage(P, set.id, up.file.id, { page: 2, image: PNG });
    release(); ctl.gate = null;
    await run;
    const store = await docStore();
    expect((await store.getFile(set.id, up.file.id))?.extraction).toBe("pending");
    expect(await store.countPendingExtraction(set.id)).toBe(1);
    expect(await store.getExtraction(up.file.id)).toBeNull();
  });

  it("does not keep facts for a file deleted while extraction ran", async () => {
    const set = await createSet(P, { name: "s2" });
    const up = await uploadBrowserPdf(P, set.id, { kind: "pdf-text", name: "b.pdf", size: 10, sha256: "2".repeat(64), pages: ["Alpha clause text."] });
    if (up.status !== "created") throw new Error("upload failed");
    let release!: () => void;
    ctl.gate = new Promise((r) => (release = r));
    const run = runExtraction(P, set.id, {});
    await tick();
    await deleteFile(P, set.id, up.file.id);
    release(); ctl.gate = null;
    await run;
    expect((await listFacts(P, set.id, {})).facts).toEqual([]);
  });

  it("an incomplete batched PDF uploaded again comes back resumable (duplicate with pagesReceived < pages)", async () => {
    const set = await createSet(P, { name: "s3" });
    const body = { kind: "pdf-text" as const, name: "c.pdf", size: 10, sha256: "3".repeat(64), pages: ["p1 text"], totalPages: 3 };
    const first = await uploadBrowserPdf(P, set.id, body as never);
    const again = await uploadBrowserPdf(P, set.id, body as never);
    expect(first.status).toBe("created");
    expect(again.status).toBe("duplicate");
    if (again.status === "rejected") throw new Error("rejected");
    expect([again.file.pagesReceived, again.file.pages]).toEqual([1, 3]);
    // The client continues from pagesReceived + 1.
    const done = await appendPages(P, set.id, again.file.id, { appendPages: ["p2 text", "p3 text"], fromPage: 2 });
    expect(done.file.pagesReceived).toBe(3);
    expect(done.file.status).toBe("ready");
  });

  it("re-sending an append after a partial write replaces the pages instead of duplicating their text", async () => {
    const set = await createSet(P, { name: "s6" });
    const up = await uploadBrowserPdf(P, set.id, { kind: "pdf-text", name: "f.pdf", size: 10, sha256: "6".repeat(64), pages: ["Page one."], totalPages: 2 } as never);
    if (up.status !== "created") throw new Error("upload failed");
    const store = await docStore();
    // Simulate chunks written but the file row not updated (e.g. a transient error after addChunks).
    await store.addChunks([{ fileId: up.file.id, setId: set.id, idx: 50, page: 2, text: "Page two.", lead: 0 } as never]);
    await appendPages(P, set.id, up.file.id, { appendPages: ["Page two."], fromPage: 2 });
    const pages = await getFilePages(P, set.id, up.file.id, 2);
    expect(pages.pages.map((p) => p.text)).toEqual(["Page two."]);
  });

  it("cancelling extraction is not a failed attempt", async () => {
    const set = await createSet(P, { name: "s5" });
    const up = await uploadBrowserPdf(P, set.id, { kind: "pdf-text", name: "e.pdf", size: 10, sha256: "5".repeat(64), pages: ["Alpha clause text."] });
    if (up.status !== "created") throw new Error("upload failed");
    for (let i = 0; i < 3; i++) {
      ctl.gate = new Promise(() => {});
      const ac = new AbortController();
      const run = runExtraction(P, set.id, { signal: ac.signal });
      await tick(30);
      ac.abort();
      await run;
    }
    ctl.gate = null;
    const store = await docStore();
    const f = await store.getFile(set.id, up.file.id);
    expect(f?.extractionAttempts).toBe(0);
    expect(await store.countPendingExtraction(set.id)).toBe(1);
  });

  it("finds words in Indian scripts (combining vowel signs stay inside the word)", async () => {
    const set = await createSet(P, { name: "s4" });
    await uploadBrowserPdf(P, set.id, { kind: "pdf-text", name: "h.pdf", size: 10, sha256: "4".repeat(64), pages: ["यह किराया समझौता है। किरायेदार ने किराया नहीं दिया।"] });
    await uploadBrowserPdf(P, set.id, { kind: "pdf-text", name: "t.pdf", size: 10, sha256: "7".repeat(64), pages: ["வாடகை ஒப்பந்தம் கையெழுத்தானது."] });
    expect((await searchDocSets(P, [set.id], "किराया")).map((h) => h.fileName)).toEqual(["h.pdf"]);
    expect((await searchDocSets(P, [set.id], "வாடகை")).map((h) => h.fileName)).toEqual(["t.pdf"]);
  });
});
