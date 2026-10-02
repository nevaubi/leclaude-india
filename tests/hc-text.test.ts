import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { TokenBucket } from "@/lib/ai/toolkit/http";
import type { Principal } from "@/lib/auth/types";
import type { OcrModel } from "@/modules/official/ocr";
import type { ExtractedDocument } from "@/modules/official/extract";
import { chunkJudgmentPages } from "@/modules/india/corpus/hc-text/chunk";
import { allowedPdfUrl, hcTextConfig, PRIORITY_COURTS, type HcTextConfig } from "@/modules/india/corpus/hc-text/config";
import { createPdfFetcher, type PdfFetcher } from "@/modules/india/corpus/hc-text/fetch";
import { buildSchedule } from "@/modules/india/corpus/hc-text/schedule";
import { runHcTextIngest, seedQueue, type HcRunOptions } from "@/modules/india/corpus/hc-text/run";
import { shapeCoverage } from "@/modules/india/corpus/hc-text/coverage";
import { sumYears, textShare, yearsInRange } from "@/modules/india/corpus/hc-text/shared";
import { hasJudgmentText, textStatusLabel } from "@/modules/india/corpus/text-status";
import { handleHcCronRun, handleHcRunRequest, parseHcRunBody } from "@/app/api/india/hc-text/run/handler";
import { FakeHcRepo } from "./hc-text-fakes";

const BUCKET = "https://indian-high-court-judgments.s3.ap-south-1.amazonaws.com";
const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64"));
const PARA = "The petitioner challenges the order of the Tribunal dated 3 March 2023 on the ground that the respondent was not heard before the penalty was imposed.";

/** A real PDF: `text` pages carry a text layer; `scan` pages are one full-page image (no text layer). */
async function pdf(layout: ("text" | "scan")[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const img = await doc.embedPng(PNG);
  layout.forEach((kind, i) => {
    const p = doc.addPage([612, 792]);
    if (kind === "scan") { p.drawImage(img, { x: 0, y: 0, width: 612, height: 792 }); return; }
    for (let l = 0; l < 6; l++) p.drawText(`Page ${i + 1} line ${l + 1}. ${PARA.slice(0, 80)}`, { x: 40, y: 740 - l * 18, size: 10, font });
  });
  return doc.save();
}

function cfg(over: Partial<HcTextConfig> = {}): HcTextConfig {
  return { ...hcTextConfig({}), enabled: true, concurrency: 1, limitPerRun: 50, enqueuePerRun: 50, ...over };
}

const fetchOk = (bytes: Uint8Array): PdfFetcher & { calls: string[] } => {
  const calls: string[] = [];
  const f: PdfFetcher = async (url) => { calls.push(url); return { ok: true as const, bytes, finalUrl: url }; };
  return Object.assign(f, { calls });
};

/** OCR model that transcribes each requested page as "OCR text of page N" (with the page markers ocrDocument expects). */
function fakeModel(o: { failPages?: number[] } = {}): OcrModel & { requests: number[][] } {
  const requests: number[][] = [];
  return {
    id: "fake-vision",
    requests,
    async transcribe(req) {
      requests.push(req.pages);
      if (req.pages.length === 1 && o.failPages?.includes(req.pages[0])) throw new Error("model refused the page");
      // A range with a failing page comes back without that page's marker (ocrDocument then retries page by page).
      return { text: req.pages.filter((p) => !o.failPages?.includes(p)).map((p) => `<!-- page ${p} -->\nOCR text of page ${p}. ${PARA} Call 9876543210 for the registry.`).join("\n\n"), stopReason: "end" };
    },
  };
}

function base(repo: FakeHcRepo, over: Partial<HcRunOptions> = {}): HcRunOptions {
  return { deadlineMs: 200_000, repo, config: cfg(), currentYear: 2026, log: () => {}, sleep: async () => {}, ocrMinMs: 0, minUnitMs: 0, blobStore: { kind: "none", configured: false, put: async () => null }, ...over };
}

describe("HC text: schedule and configuration", () => {
  it("orders slices: priority courts first, newest year first within 2016–present, then older years", () => {
    const s = buildSchedule({ recentFrom: 2016, oldestYear: 2014, currentYear: 2026 });
    expect(s[0]).toMatchObject({ index: 0, courtId: "hc-delhi", year: 2026, phase: "recent" });
    expect(s[10]).toMatchObject({ courtId: "hc-delhi", year: 2016 });
    expect(s[11]).toMatchObject({ courtId: "hc-bombay", year: 2026 });
    const courtsRecent = [...new Set(s.filter((x) => x.phase === "recent").map((x) => x.courtId))];
    expect(courtsRecent.slice(0, PRIORITY_COURTS.length)).toEqual([...PRIORITY_COURTS]);
    expect(courtsRecent).toHaveLength(25);
    const firstOlder = s.findIndex((x) => x.phase === "older");
    expect(s[firstOlder]).toMatchObject({ courtId: "hc-delhi", year: 2015 });
    expect(s.slice(0, firstOlder).every((x) => x.year >= 2016)).toBe(true);
    expect(s.at(-1)!.year).toBe(2014);
  });

  it("allows exactly the bucket host over https", () => {
    expect(allowedPdfUrl(`${BUCKET}/data/pdf/a.pdf`)).toBe(true);
    for (const u of ["http://indian-high-court-judgments.s3.ap-south-1.amazonaws.com/a.pdf", "https://indian-high-court-judgments.s3.amazonaws.com/a.pdf", "https://evil.example.com/a.pdf",
      "https://indian-high-court-judgments.s3.ap-south-1.amazonaws.com.evil.com/a.pdf", "https://user:p@indian-high-court-judgments.s3.ap-south-1.amazonaws.com/a.pdf", "https://indian-high-court-judgments.s3.ap-south-1.amazonaws.com:8443/a.pdf", null, "not a url"]) {
      expect(allowedPdfUrl(u), String(u)).toBe(false);
    }
  });

  it("reads env with defaults and the DB budget fallback chain", () => {
    expect(hcTextConfig({})).toMatchObject({ enabled: false, recentFrom: 2016, concurrency: 4, ocr: true, ocrMaxPages: 40, maxPdfBytes: 25 * 1024 * 1024, maxDbBytes: 60_000 * 1024 * 1024 });
    expect(hcTextConfig({ HC_TEXT_INGEST: "1", OFFICIAL_MAX_DB_MB: "500", HC_TEXT_OCR: "0" })).toMatchObject({ enabled: true, ocr: false, maxDbBytes: 500 * 1024 * 1024 });
    expect(hcTextConfig({ HC_TEXT_MAX_DB_MB: "100", OFFICIAL_MAX_DB_MB: "500" }).maxDbBytes).toBe(100 * 1024 * 1024);
  });

  it("text status helpers treat every text-bearing status as readable", () => {
    for (const s of ["full", "full_text", "ocr", "partial"]) expect(hasJudgmentText(s)).toBe(true);
    for (const s of ["none", "metadata", "failed", null]) expect(hasJudgmentText(s)).toBe(false);
    expect(textStatusLabel("ocr")).toBe("Full text (OCR)");
    expect(textStatusLabel("failed")).toBe("PDF only");
  });
});

describe("HC text: chunking", () => {
  it("chunks with page numbers, labels OCR pages and scrubs contact data", () => {
    const long = (n: number) => Array.from({ length: 14 }, (_, i) => `Paragraph ${i} on page ${n}. ${PARA}`).join("\n\n");
    const r = chunkJudgmentPages([{ page: 2, text: long(2) }, { page: 1, text: `${long(1)}\n\nContact 9876543210 or clerk@example.com` }, { page: 3, text: "" }], [2]);
    expect(r.chunks.length).toBeGreaterThan(1);
    expect(r.chunks[0].pageStart).toBe(1);
    expect(r.chunks.at(-1)!.pageEnd).toBe(2);
    expect(r.chunks.every((c, i) => c.index === i)).toBe(true);
    expect(r.chunks.filter((c) => c.pageStart === 2).every((c) => c.sectionType === "ocr")).toBe(true);
    expect(r.chunks.filter((c) => c.pageEnd === 1).every((c) => c.sectionType === null)).toBe(true);
    const all = r.chunks.map((c) => c.text).join("\n");
    expect(all).not.toMatch(/9876543210|clerk@example\.com/);
    expect(all).toContain("[phone removed]");
    expect(r.redactions).toMatchObject({ phones: 1, emails: 1 });
    expect(chunkJudgmentPages([{ page: 1, text: "  " }]).chunks).toEqual([]);
  });
});

describe("HC text: processing one judgment", () => {
  it("text layer path: a real PDF with a text layer → full_text, chunks with page numbers, provenance", async () => {
    const repo = new FakeHcRepo();
    repo.addJudgment({ id: "hc:1" });
    const bytes = await pdf(["text", "text"]);
    const fetchPdf = fetchOk(bytes);
    const r = await runHcTextIngest(base(repo, { fetchPdf, ocrModel: () => { throw new Error("must not OCR"); } }));
    expect(r.stop).toBe("done");
    expect(r.results).toEqual({ full_text: 1 });
    expect(repo.judgments.get("hc:1")!.text_status).toBe("full_text");
    const rows = repo.texts.filter((t) => t.case_key === "hc:1");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toMatchObject({ id: "hcpdf:hc:1:0", cnr: "DLHC010000012024", decision_date: "2024-05-01", page_start: 1, section_type: null });
    expect(rows[0].dataset_version).toMatch(/^aws-hc-pdf:x\d+\.p\d+$/);
    expect(rows.map((t) => t.text).join(" ")).toContain("Page 2 line 1");
    const u = repo.units.get("hc:1")!;
    expect(u).toMatchObject({ status: "done", result: "full_text" });
    expect(u.prov).toMatchObject({ pages: 2, textPages: 2, bytes: bytes.byteLength, sourceUrl: fetchPdf.calls[0] });
    expect(u.prov.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("OCR path: scanned pages go to the model with page markers → ocr, OCR chunks labelled and scrubbed", async () => {
    const repo = new FakeHcRepo();
    repo.addJudgment({ id: "hc:2" });
    const model = fakeModel();
    const r = await runHcTextIngest(base(repo, { fetchPdf: fetchOk(await pdf(["text", "scan", "scan"])), ocrModel: model }));
    expect(r.results).toEqual({ ocr: 1 });
    expect(model.requests).toEqual([[2, 3]]);
    expect(repo.judgments.get("hc:2")!.text_status).toBe("ocr");
    const rows = repo.texts.filter((t) => t.case_key === "hc:2");
    const ocrRows = rows.filter((t) => t.section_type === "ocr");
    expect(ocrRows.length).toBeGreaterThan(0);
    expect(ocrRows.every((t) => (t.page_start ?? 0) >= 2 || (t.page_end ?? 0) >= 2)).toBe(true);
    expect(rows.map((t) => t.text).join(" ")).toContain("OCR text of page 3");
    expect(rows.map((t) => t.text).join(" ")).not.toContain("9876543210");
    expect(repo.units.get("hc:2")!.prov).toMatchObject({ ocrPages: [2, 3], ocrModel: "fake-vision", textPages: 1 });
  });

  it("partial OCR: a page the model fails stays missing → partial, recorded", async () => {
    const repo = new FakeHcRepo();
    repo.addJudgment({ id: "hc:3" });
    const r = await runHcTextIngest(base(repo, { fetchPdf: fetchOk(await pdf(["text", "scan", "scan"])), ocrModel: fakeModel({ failPages: [3] }) }));
    expect(r.results).toEqual({ partial: 1 });
    expect(repo.judgments.get("hc:3")!.text_status).toBe("partial");
    const u = repo.units.get("hc:3")!;
    expect(u.prov).toMatchObject({ ocrPages: [2], ocrFailedPages: [3] });
    expect(u.note).toMatch(/OCR failed on 1 page/);
  });

  it("OCR over the per-document cap is not attempted: text layer kept as partial", async () => {
    const repo = new FakeHcRepo();
    repo.addJudgment({ id: "hc:cap" });
    const model = fakeModel();
    const r = await runHcTextIngest(base(repo, { config: cfg({ ocrMaxPages: 1 }), fetchPdf: fetchOk(await pdf(["text", "scan", "scan"])), ocrModel: model }));
    expect(r.results).toEqual({ partial: 1 });
    expect(model.requests).toEqual([]);
    expect(repo.units.get("hc:cap")!.note).toMatch(/above the cap of 1/);
  });

  it("a fully scanned PDF with no OCR model configured waits (deferred), nothing stored", async () => {
    const { AIConfigError } = await import("@/lib/ai/config");
    const repo = new FakeHcRepo();
    repo.addJudgment({ id: "hc:wait" });
    const r = await runHcTextIngest(base(repo, { fetchPdf: fetchOk(await pdf(["scan"])), ocrModel: () => { throw new AIConfigError(); } }));
    expect(r.results).toEqual({ deferred: 1 });
    expect(repo.units.get("hc:wait")).toMatchObject({ status: "pending", attempts: 0 });
    expect(repo.units.get("hc:wait")!.runAfter).toBeGreaterThan(repo.clock);
    expect(repo.texts).toEqual([]);
    expect(repo.judgments.get("hc:wait")!.text_status).toBe("none");
  });

  it("too large: refused by the fetcher (never truncated) → failed, record marked failed", async () => {
    const big = new Uint8Array(3 * 1024 * 1024).fill(0x41);
    big.set(new TextEncoder().encode("%PDF-1.7\n"));
    const fetcher = createPdfFetcher({ maxBytes: 1024 * 1024, timeoutMs: 10_000, rps: 100, burst: 100, limiter: new TokenBucket(100, 100), sleep: async () => {}, retries: 0, fetchImpl: (async () => new Response(big, { status: 200, headers: { "content-type": "application/pdf" } })) as typeof fetch });
    const direct = await fetcher(`${BUCKET}/x.pdf`, {});
    expect(direct).toMatchObject({ ok: false, failure: { kind: "too_large" } });
    const repo = new FakeHcRepo();
    repo.addJudgment({ id: "hc:big" });
    const r = await runHcTextIngest(base(repo, { fetchPdf: fetcher }));
    expect(r.results).toEqual({ failed: 1 });
    expect(repo.judgments.get("hc:big")!.text_status).toBe("failed");
    expect(repo.units.get("hc:big")).toMatchObject({ status: "failed", result: "failed" });
    expect(repo.units.get("hc:big")!.error).toMatch(/larger than 1 MB/);
  });

  it("host allowlist: a record whose pdf_url is elsewhere is skipped without any request; the fetcher refuses other hosts and redirects", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      return url.includes("redirect") ? new Response(null, { status: 302, headers: { location: "https://evil.example.com/x.pdf" } }) : new Response("%PDF-1.7 x", { status: 200 });
    }) as typeof fetch;
    const fetcher = createPdfFetcher({ maxBytes: 1024 * 1024, timeoutMs: 10_000, rps: 100, burst: 100, limiter: new TokenBucket(100, 100), sleep: async () => {}, retries: 0, fetchImpl });
    expect(await fetcher("https://evil.example.com/x.pdf", {})).toMatchObject({ ok: false, failure: { kind: "host_not_allowed" } });
    expect(await fetcher(`http://indian-high-court-judgments.s3.ap-south-1.amazonaws.com/x.pdf`, {})).toMatchObject({ ok: false, failure: { kind: "host_not_allowed" } });
    expect(calls).toEqual([]);
    const redirected = await fetcher(`${BUCKET}/redirect.pdf`, {});
    expect(redirected.ok).toBe(false);
    expect(calls.some((c) => c.includes("evil"))).toBe(false);

    const repo = new FakeHcRepo();
    repo.addJudgment({ id: "hc:evil", pdf_url: `${BUCKET}/ok.pdf` });
    // The unit was queued for the bucket URL; the record's URL has since changed to another host.
    await seedQueue(repo, cfg(), 10, { now: () => repo.clock, currentYear: 2026, deadline: Date.now() + 600_000 });
    repo.judgments.get("hc:evil")!.pdf_url = "https://evil.example.com/a.pdf";
    const f = fetchOk(new Uint8Array());
    const r = await runHcTextIngest(base(repo, { fetchPdf: f, seed: false }));
    expect(r.results).toEqual({ skipped: 1 });
    expect(f.calls).toEqual([]);
    expect(repo.units.get("hc:evil")!.note).toMatch(/not on the indian-high-court-judgments bucket host/);
    expect(repo.judgments.get("hc:evil")!.text_status).toBe("none");
  });

  it("never overwrites Open India Law text: skipped before fetching, and the store guard holds if it appears mid-run", async () => {
    const repo = new FakeHcRepo();
    repo.addJudgment({ id: "hc:oil", cnr: "DLHC010000022024" });
    repo.addJudgment({ id: "hc:race", cnr: "DLHC010000032024", decision_date: "2024-04-01" });
    repo.addJudgment({ id: "hc:full", cnr: "DLHC010000042024", decision_date: "2024-03-01" });
    const oilRow = { id: "oil-1", case_key: "x", cnr: "DLHC010000022024", decision_date: "2024-05-01", chunk_index: 0, total_chunks: 1, page_start: 1, page_end: 1, section_type: null, text: "OIL TEXT", dataset_version: "v2026.08.1" };
    repo.texts.push({ ...oilRow });
    await seedQueue(repo, cfg(), 10, { now: () => repo.clock, currentYear: 2026, deadline: Date.now() + 600_000 });
    repo.judgments.get("hc:full")!.text_status = "full"; // loaded by Open India Law after queueing
    repo.beforeStore = (x) => { if (x.judgmentId === "hc:race") repo.texts.push({ ...oilRow, id: "oil-2", cnr: "DLHC010000032024", decision_date: "2024-04-01", text: "OIL RACE" }); };
    const f = fetchOk(await pdf(["text"]));
    const r = await runHcTextIngest(base(repo, { fetchPdf: f, seed: false }));
    expect(r.results).toEqual({ skipped: 3 });
    expect(f.calls).toHaveLength(1); // only hc:race was fetched
    expect(repo.texts.filter((t) => t.dataset_version.startsWith("aws-hc-pdf"))).toEqual([]);
    expect(repo.texts.map((t) => t.text).sort()).toEqual(["OIL RACE", "OIL TEXT"]);
    expect(repo.judgments.get("hc:full")!.text_status).toBe("full");
    for (const id of ["hc:oil", "hc:race", "hc:full"]) expect(repo.units.get(id)!.prov.oilText, id).toBe(true);
  });

  it("does not store a second PDF text for another record with the same CNR and date", async () => {
    const repo = new FakeHcRepo();
    repo.addJudgment({ id: "hc:a" });
    repo.addJudgment({ id: "hc:b" });
    const r = await runHcTextIngest(base(repo, { fetchPdf: fetchOk(await pdf(["text"])) }));
    expect(r.results).toEqual({ full_text: 1, skipped: 1 });
    expect(new Set(repo.texts.map((t) => t.case_key)).size).toBe(1);
    expect([...repo.units.values()].find((u) => u.status === "skipped")!.note).toMatch(/same CNR and decision date/);
  });

  it("transient download failures back off and retry; a 404 is a permanent failure", async () => {
    const repo = new FakeHcRepo();
    repo.addJudgment({ id: "hc:t" });
    repo.addJudgment({ id: "hc:404", cnr: "DLHC010000092024" });
    const fetchPdf: PdfFetcher = async (url) => (url.includes("missing") ? { ok: false, failure: { kind: "not_found", message: "HTTP 404" } } : { ok: false, failure: { kind: "transient", message: "socket hang up" } });
    repo.judgments.get("hc:404")!.pdf_url = `${BUCKET}/missing.pdf`;
    const r = await runHcTextIngest(base(repo, { fetchPdf }));
    expect(r.results).toEqual({ retry: 1, failed: 1 });
    expect(repo.units.get("hc:t")).toMatchObject({ status: "pending", attempts: 1 });
    expect(repo.units.get("hc:t")!.runAfter).toBeGreaterThan(repo.clock);
    expect(repo.judgments.get("hc:t")!.text_status).toBe("none");
    expect(repo.judgments.get("hc:404")!.text_status).toBe("failed");
  });
});

describe("HC text: runs", () => {
  it("queues and claims in priority order (Delhi newest first, then Bombay), only records needing text", async () => {
    const repo = new FakeHcRepo();
    repo.addJudgment({ id: "bom-2026", court_id: "hc-bombay", cnr: "HCBM010000012026", decision_date: "2026-01-05" });
    repo.addJudgment({ id: "del-2025", court_id: "hc-delhi", cnr: "DLHC010000012025", decision_date: "2025-06-01" });
    repo.addJudgment({ id: "del-2026", court_id: "hc-delhi", cnr: "DLHC010000012026", decision_date: "2026-02-01" });
    repo.addJudgment({ id: "del-2026b", court_id: "hc-delhi", cnr: "DLHC010000022026", decision_date: "2026-03-01" });
    repo.addJudgment({ id: "del-2010", court_id: "hc-delhi", cnr: "DLHC010000012010", decision_date: "2010-03-01" });
    repo.addJudgment({ id: "kar-2026", court_id: "hc-karnataka", cnr: "KAHC010000012026", decision_date: "2026-03-01" });
    repo.addJudgment({ id: "del-full", court_id: "hc-delhi", cnr: "DLHC010000032026", decision_date: "2026-03-02", text_status: "full" });
    repo.addJudgment({ id: "del-nocnr", court_id: "hc-delhi", cnr: null, decision_date: "2026-03-03" });
    repo.addJudgment({ id: "del-elsewhere", court_id: "hc-delhi", cnr: "DLHC010000042026", decision_date: "2026-03-04", pdf_url: "https://example.com/a.pdf" });
    let n = 0;
    const r = await runHcTextIngest(base(repo, { fetchPdf: async (url) => ({ ok: true, bytes: await pdf(["text"]), finalUrl: url + `?${n++}` }) }));
    // One run probes at most MAX_SEED_SLICES slices: the recent window (2016–present) of every court comes first.
    expect(r.queued).toBe(5);
    expect(repo.log).toEqual(["claim del-2026b", "claim del-2026", "claim del-2025", "claim bom-2026", "claim kar-2026"]);
    for (let i = 0; i < 4 && !repo.units.has("del-2010"); i++) await runHcTextIngest(base(repo, { fetchPdf: async (url) => ({ ok: true, bytes: await pdf(["text"]), finalUrl: url + `?${n++}` }) }));
    expect(repo.log.at(-1)).toBe("claim del-2010");
    for (const id of ["del-full", "del-nocnr", "del-elsewhere"]) expect(repo.units.has(id), id).toBe(false);
    expect(r.notes.join(" ")).toMatch(/coverage recounted: hc-delhi, hc-bombay, hc-madras/);
    const st = repo.state.get("hc_text_seed") as { cursor: number };
    expect(st.cursor).toBeGreaterThan(0);
  });

  it("stops with budget before any work when the database is over HC_TEXT_MAX_DB_MB", async () => {
    const repo = new FakeHcRepo();
    repo.addJudgment({ id: "hc:1" });
    repo.bytes = 2 * 1024 * 1024;
    const f = fetchOk(new Uint8Array());
    const r = await runHcTextIngest(base(repo, { config: cfg({ maxDbBytes: 1024 * 1024 }), fetchPdf: f }));
    expect(r.stop).toBe("budget");
    expect(r.processed).toBe(0);
    expect(f.calls).toEqual([]);
    expect(r.notes.join(" ")).toMatch(/budget/);
  });

  it("stops mid-run when the budget is reached", async () => {
    const repo = new FakeHcRepo();
    repo.addJudgment({ id: "hc:1", cnr: "DLHC010000012024" });
    repo.addJudgment({ id: "hc:2", cnr: "DLHC010000022024" });
    const bytes = await pdf(["text"]);
    const r = await runHcTextIngest(base(repo, { deadlineMs: 100_000_000, config: cfg({ maxDbBytes: 2_000_000 }), fetchPdf: async (url) => { repo.bytes = 3_000_000; return { ok: true, bytes, finalUrl: url }; }, now: (() => { let t = Date.now(); return () => (t += 6_000); })() }));
    expect(r.stop).toBe("budget");
    expect(r.processed).toBe(1);
  });

  it("watchdog: a unit still running after the deadline + grace is handed back (attempt returned) and the run returns", async () => {
    const repo = new FakeHcRepo();
    repo.addJudgment({ id: "hc:slow" });
    await seedQueue(repo, cfg(), 10, { now: () => repo.clock, currentYear: 2026, deadline: Date.now() + 600_000 });
    const t0 = Date.now();
    const r = await runHcTextIngest(base(repo, { seed: false, deadlineMs: 1_000, watchdogGraceMs: 50, fetchPdf: fetchOk(await pdf(["text"])), extract: () => new Promise<ExtractedDocument>(() => {}), sleep: (ms) => new Promise((res) => setTimeout(res, ms)), now: Date.now }));
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(r.stop).toBe("deadline");
    expect(r.notes.join(" ")).toMatch(/handed back/);
    expect(repo.units.get("hc:slow")).toMatchObject({ status: "pending", attempts: 0 });
    expect(repo.units.get("hc:slow")!.note).toMatch(/resumes in a later run/);
  });

  it("OCR stopped by the deadline releases the unit with its OCR progress; the next run resumes without re-OCR of done pages", async () => {
    const repo = new FakeHcRepo();
    repo.addJudgment({ id: "hc:resume" });
    const bytes = await pdf(["scan", "scan"]);
    // First run: the OCR call for the range reports only page 1 then the deadline passes (ocrDocument marks incomplete).
    const r1 = await runHcTextIngest(base(repo, {
      fetchPdf: fetchOk(bytes), ocrModel: fakeModel(),
      ocr: async (_b, pages, opts) => { await opts.onProgress?.([{ page: 1, text: "OCR text of page 1 [done]" }]); return { model: "fake-vision", pages: [{ page: 1, text: "OCR text of page 1 [done]" }], failed: [], complete: false, capped: false, requests: 1 }; },
    }));
    expect(r1.results).toEqual({ released: 1 }); // deferred past the run's deadline, never re-claimed by the same run
    const u = repo.units.get("hc:resume")!;
    expect(u).toMatchObject({ status: "pending", attempts: 0 });
    expect(u.runAfter).toBeGreaterThan(repo.clock);
    repo.clock = u.runAfter! + 1;
    expect(u.payload?.ocrDone).toEqual({ 1: "OCR text of page 1 [done]" });
    expect(repo.progressSaves).toBe(1);
    // Second run: real ocrDocument with the saved progress → only page 2 is sent.
    const model = fakeModel();
    const r2 = await runHcTextIngest(base(repo, { fetchPdf: fetchOk(bytes), ocrModel: model, seed: false }));
    expect(r2.results).toEqual({ ocr: 1 });
    expect(model.requests).toEqual([[2]]);
    expect(repo.texts.map((t) => t.text).join(" ")).toContain("page 1 [done]");
  });

  it("retryFailed re-queues failed and partial units and resets failed records", async () => {
    const repo = new FakeHcRepo();
    repo.addJudgment({ id: "hc:f" });
    await runHcTextIngest(base(repo, { fetchPdf: async () => ({ ok: false, failure: { kind: "not_found", message: "404" } }) }));
    expect(repo.judgments.get("hc:f")!.text_status).toBe("failed");
    const r = await runHcTextIngest(base(repo, { retryFailed: true, seed: false, fetchPdf: fetchOk(await pdf(["text"])) }));
    expect(r.notes.join(" ")).toMatch(/1 failed or partial unit/);
    expect(repo.judgments.get("hc:f")!.text_status).toBe("full_text");
  });

  it("no corpus table: stops without work", async () => {
    const repo = new FakeHcRepo();
    repo.hasJudgmentsTable = false;
    expect((await runHcTextIngest(base(repo))).stop).toBe("no_corpus");
  });
});

describe("HC text: coverage", () => {
  it("shapes per court × year with priority order and totals", async () => {
    const repo = new FakeHcRepo();
    repo.addJudgment({ id: "1", court_id: "hc-kerala", decision_date: "2024-01-01", text_status: "ocr" });
    repo.addJudgment({ id: "2", court_id: "hc-delhi", decision_date: "2024-01-01", text_status: "full" });
    repo.addJudgment({ id: "3", court_id: "hc-delhi", decision_date: "2015-01-01", text_status: "none" });
    repo.addJudgment({ id: "4", court_id: "hc-delhi", decision_date: "2024-02-01", text_status: "failed" });
    const c = shapeCoverage(await repo.coverage(), await repo.queueCounts(), { dbBytes: 1, limitBytes: 2, ingestEnabled: true });
    expect(c.courts.map((x) => x.courtId)).toEqual(["hc-delhi", "hc-kerala"]);
    expect(c.courts[0].years.map((y) => y.year)).toEqual([2024, 2015]);
    expect(c.courts[0].totals).toMatchObject({ judgments: 3, withText: 1, openIndiaLaw: 1, failed: 1, metadataOnly: 1 });
    expect(c.totals).toMatchObject({ judgments: 4, withText: 2, ocr: 1 });
    expect(textShare(c.totals)).toBe(50);
    const recent = yearsInRange(c.courts[0].years, 2016, null);
    expect(sumYears(recent).judgments).toBe(2);
  });
});

describe("HC text: run route gating", () => {
  const service: Principal = { userId: "service", tenantId: "t", roles: ["service"], matterIds: "*", source: "service" } as unknown as Principal;
  const member: Principal = { userId: "u1", tenantId: "t", roles: ["associate"], matterIds: "*", source: "session" } as unknown as Principal;
  const ok = async () => ({ stop: "done" as const, processed: 0, results: {}, queued: 0, queue: null, dbBytes: null, limitBytes: 0, notes: [], errors: [], durationMs: 0 });

  it("cron: service only when CRON_SECRET is set; disabled unless HC_TEXT_INGEST; throttled kick only in dev mode", async () => {
    let runs = 0;
    const run = async () => { runs++; return ok(); };
    expect((await handleHcCronRun({ principal: () => member, run, env: { CRON_SECRET: "s", HC_TEXT_INGEST: "1" } })).status).toBe(403);
    expect((await handleHcCronRun({ principal: () => null, run, env: { AUTH_MODE: "jwt", HC_TEXT_INGEST: "1" } })).status).toBe(403);
    const off = await handleHcCronRun({ principal: () => service, run, env: { CRON_SECRET: "s" } });
    expect(await off.json()).toMatchObject({ stop: "disabled" });
    expect((await handleHcCronRun({ principal: () => service, run, env: { CRON_SECRET: "s", HC_TEXT_INGEST: "1" } })).status).toBe(200);
    let slot = true;
    const kick = () => handleHcCronRun({ principal: () => null, run, env: { HC_TEXT_INGEST: "1" }, claimSlot: async () => { const s = slot; slot = false; return s; } });
    expect((await kick()).status).toBe(200);
    expect((await kick()).status).toBe(429);
    expect(runs).toBe(3 - 1);
  });

  it("POST needs the service principal or the ingest token, and validates the body", async () => {
    const req = (headers: Record<string, string> = {}, body: unknown = {}) => new Request("http://localhost/api/india/hc-text/run", { method: "POST", headers, body: JSON.stringify(body) });
    expect((await handleHcRunRequest(req(), { principal: () => member, run: ok, env: {} })).status).toBe(503);
    expect((await handleHcRunRequest(req({ "x-official-token": "bad" }), { principal: () => member, run: ok, env: { OFFICIAL_INGEST_TOKEN: "good" } })).status).toBe(403);
    expect((await handleHcRunRequest(req({ "x-official-token": "good" }), { principal: () => member, run: ok, env: { OFFICIAL_INGEST_TOKEN: "good" } })).status).toBe(200);
    expect((await handleHcRunRequest(req({}, { limit: 0 }), { principal: () => service, run: ok, env: {} })).status).toBe(400);
    expect(parseHcRunBody({ deadlineMs: 999_999, retryFailed: true })).toEqual({ deadlineMs: 280_000, retryFailed: true });
  });
});
