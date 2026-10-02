import { beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.LECLAUDE_DATA_DIR = `${process.env.TMPDIR || "/tmp"}/intel-vitest-adapters-${process.pid}`;
  process.env.LECLAUDE_BACKGROUND = "off";
  process.env.WORKFLOW_SCHEDULER_DISABLED = "1";
  process.env.INTEL_OFFLINE = "1";
  process.env.OPENAI_API_KEY = "";
  process.env.LECLAUDE_CORPUS_DIRS = "";
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Document, Packer, Paragraph } from "docx";
import * as XLSX from "xlsx";
import { memoryHttpCache } from "@/lib/ai/toolkit/http";
import { db, resetSqlite } from "@/lib/db";
import { MATTERS } from "@/lib/seed/ids";
import { adapterInfos, getAdapter, listAdapters } from "@/modules/intel/adapters";
import { providerStatuses } from "@/modules/intel/config";
import { createProviders, ProviderError, type IntelProviders } from "@/modules/intel/providers";
import { runFailed, runSource } from "@/modules/intel/run";
import { createSource } from "@/modules/intel/service";
import { getDocumentText, intelDocuments, intelWatches, listChunks } from "@/modules/intel/store";
import type { IntelEntityMention } from "@/modules/intel/types";

beforeAll(() => { resetSqlite(); db(); });

function providers(): IntelProviders {
  return createProviders({ cache: memoryHttpCache(), offline: true, sleep: async () => {}, env: { FIRECRAWL_API_KEY: undefined, TAVILY_API_KEY: undefined } });
}

describe("adapter registry", () => {
  it("registers eighteen adapters (twelve upstream, six India) with defaults that validate and reports configuration", () => {
    const all = listAdapters();
    expect(all).toHaveLength(18);
    for (const a of all) { expect(a.configSchema.safeParse(a.defaults).success).toBe(true); expect(a.kinds.length).toBeGreaterThan(0); }
    const infos = adapterInfos(providerStatuses());
    expect(infos.find((i) => i.id === "ecfr")?.configured).toBe(true);
    expect(infos.find((i) => i.id === "news")?.requires).toEqual([]);
    expect(getAdapter("nope")).toBeNull();
  });
  it("rejects invalid configuration without running", async () => {
    const source = createSource({ adapter: "federal-register", name: "bad", config: {} });
    const r = await runSource({ ...source, config: { maxResults: "ten" } }, { providers: providers(), embed: false });
    expect(r.errors[0]).toMatchObject({ code: "parse", fatal: true });
    expect(runFailed(r).failed).toBe(true);
  });
});

describe("federal-register adapter", () => {
  it("ingests search results with full text, agencies, dates and entity stubs, then skips unchanged documents", async () => {
    const p = providers();
    let textFetches = 0;
    p.federalRegister.search = async () => ({ total: 2, results: [
      { documentNumber: "2024-99901", title: "Benzene National Primary Drinking Water Regulation (test fixture)", type: "Rule", abstract: "EPA sets MCLs.", agencies: ["Environmental Protection Agency"], publicationDate: "2024-04-26", effectiveOn: "2024-06-25", citation: "89 FR 99901", docketIds: ["EPA-HQ-OW-2099-0001"], cfrReferences: [{ title: 40, part: 141 }], url: "https://www.federalregister.gov/d/2024-99901", rawTextUrl: "https://raw/1" },
      { documentNumber: "2024-99902", title: "Designation of a solvent as a CERCLA Hazardous Substance (test fixture)", type: "Rule", abstract: "EPA designates.", agencies: ["Environmental Protection Agency"], publicationDate: "2024-05-08", citation: "89 FR 99902", docketIds: [], cfrReferences: [{ title: 40, part: 302 }], url: "https://www.federalregister.gov/d/2024-99902" },
    ] });
    p.federalRegister.getText = async (doc) => { textFetches++; return { text: `Full text of ${doc.documentNumber}. ` + "Regulatory text paragraph. ".repeat(60), length: 2000, source: "raw" }; };
    const source = createSource({ adapter: "federal-register", name: "FR test", config: { queries: ["benzene"], sinceDays: 30 }, schedule: { every: "manual" } });
    const r = await runSource(source, { providers: p, embed: false });
    expect(runFailed(r).failed).toBe(false);
    expect(r).toMatchObject({ added: 2, updated: 0, skipped: 0 });
    expect(r.errors).toEqual([]);
    expect(textFetches).toBe(2);
    const doc = intelDocuments().findOne((d) => d.externalId === "fr:2024-99901")!;
    expect(doc).toMatchObject({ kind: "register_notice", citation: "89 FR 99901", agencies: ["Environmental Protection Agency"], sourceId: source.id, adapter: "federal-register", confidence: 0.92 });
    expect(doc.dates).toEqual({ published: "2024-04-26", effective: "2024-06-25" });
    expect(doc.title.startsWith("Final rule:")).toBe(true);
    expect((doc.meta?.entities as IntelEntityMention[]).map((e) => e.name)).toEqual(expect.arrayContaining(["Environmental Protection Agency", "40 C.F.R. Part 141"]));
    expect(listChunks(doc.id).length).toBeGreaterThan(1);
    expect(getDocumentText(doc.id)).toContain("Full text of 2024-99901");
    // Second run: already held with text → skipped, no text fetch.
    const again = await runSource(source, { providers: p, embed: false });
    expect(again).toMatchObject({ added: 0, skipped: 2 });
    expect(textFetches).toBe(2);
  });
  it("records provider failures per query without failing the whole run when other queries succeed", async () => {
    const p = providers();
    p.federalRegister.search = async (q) => { if (q.term === "bad") throw new ProviderError("federal-register", "rate_limited", "429", true, 429); return { total: 1, results: [{ documentNumber: "2023-99903", title: "TSCA reporting (test fixture)", type: "Rule", abstract: "x", agencies: ["Environmental Protection Agency"], publicationDate: "2023-10-11", citation: "88 FR 70516", docketIds: [], cfrReferences: [], url: "https://www.federalregister.gov/d/2023-99903" }] }; };
    p.federalRegister.getText = async () => ({ text: "Text " + "words ".repeat(300), length: 1800, source: "raw" });
    const source = createSource({ adapter: "federal-register", name: "FR partial", config: { queries: ["bad", "benzene"], fetchText: true }, schedule: { every: "manual" } });
    const r = await runSource(source, { providers: p, embed: false });
    expect(r.added).toBe(1);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ code: "rate_limited", retryable: true, fatal: false, provider: "federal-register" });
    expect(runFailed(r).failed).toBe(false);
    const allBad = await runSource({ ...source, config: { ...source.config, queries: ["bad"] } }, { providers: p, embed: false });
    expect(runFailed(allBad)).toMatchObject({ failed: true, error: { code: "rate_limited" } });
  });
});

describe("courtlistener-dockets adapter", () => {
  it("resolves matter dockets by name, ingests the docket header and entries linked to the matter, and honors watches", async () => {
    const p = providers();
    const searches: string[] = [];
    p.courtlistener.searchDockets = async (q) => {
      searches.push(q.docketNumber ?? q.query);
      if (q.docketNumber === "1:24-cv-00001") return { total: 1, results: [{ docketId: 900, caseName: "Watched v. Party", docketNumber: "1:24-cv-00001", courtId: "cand", dateFiled: "2024-01-05", parties: [], attorneys: [], url: "https://www.courtlistener.com/docket/900/" }] };
      if (/Depo-Provera/.test(q.query)) return { total: 2, results: [
        { docketId: 5, caseName: "In re: Depo-Provera (Depot Medroxyprogesterone Acetate) Products Liability Litigation", docketNumber: "3:25-md-03140", courtId: "flnd", dateFiled: "2025-02-07", assignedTo: "M. Casey Rodgers", parties: ["Pfizer Inc.", "Jane Roe"], attorneys: ["John R. Sample, Sample Law Group, P.C."], url: "https://www.courtlistener.com/docket/5/" },
        { docketId: 6, caseName: "Unrelated Pharma Co. v. Someone", docketNumber: "3:19-cv-00001", courtId: "flnd", dateFiled: "2019-01-01", parties: [], attorneys: [] },
      ] };
      return { total: 0, results: [] };
    };
    p.courtlistener.getDocket = async (id) => ({ docketId: id, caseName: id === 5 ? "In re: Depo-Provera (Depot Medroxyprogesterone Acetate) Products Liability Litigation" : "Watched v. Party", docketNumber: id === 5 ? "3:25-md-03140" : "1:24-cv-00001", courtId: id === 5 ? "flnd" : "cand", dateFiled: id === 5 ? "2025-02-07" : "2024-01-05", dateTerminated: null, assignedTo: id === 5 ? "M. Casey Rodgers" : "Yvonne Gonzalez Rogers", natureOfSuit: "367", parties: id === 5 ? ["Pfizer Inc."] : [], attorneys: [], url: `https://www.courtlistener.com/docket/${id}/`, raw: {} });
    p.courtlistener.getDocketEntries = async (id) => id === 5 ? [
      { id: 71, entryNumber: 1, dateFiled: "2025-02-07", description: "TRANSFER ORDER from the JPML", documents: [{ id: 1, description: "Transfer order", available: true, url: "https://www.courtlistener.com/recap/1/", pageCount: 4 }] },
      { id: 72, entryNumber: 2, dateFiled: "2025-03-29", description: "ORDER setting the Science Day schedule (test fixture)", documents: [] },
    ] : [];
    intelWatches().put({ id: "iw_test", userId: "p_jwhitfield", kind: "docket", target: "1:24-cv-00001", label: "Watched docket", channels: ["home"], createdAt: new Date().toISOString() });
    const source = createSource({ adapter: "courtlistener-dockets", name: "Dockets test", config: { includeMatters: true, includeWatches: true }, scope: { matterIds: [MATTERS.depo] }, schedule: { every: "manual" } });
    const r = await runSource(source, { providers: p, embed: false });
    expect(runFailed(r).failed).toBe(false);
    expect(r.errors).toEqual([]);
    expect(r.added).toBe(4); // matter docket + 2 entries + watched docket
    const header = intelDocuments().findOne((d) => d.externalId === "cl:docket:5")!;
    expect(header).toMatchObject({ kind: "docket", docketNumber: "3:25-md-03140", courtId: "flnd", court: "U.S. District Court for the Northern District of Florida", jurisdiction: "Federal · 11th Cir.", matterIds: [MATTERS.depo] });
    const ents = header.meta?.entities as IntelEntityMention[];
    expect(ents.find((e) => e.type === "judge")?.name).toBe("M. Casey Rodgers");
    expect(ents.find((e) => e.type === "firm")?.name).toBe("Sample Law Group, P.C.");
    expect(ents.find((e) => e.type === "attorney")?.name).toBe("John R. Sample");
    const entry = intelDocuments().findOne((d) => d.externalId === "cl:entry:72")!;
    expect(entry).toMatchObject({ kind: "docket_entry", matterIds: [MATTERS.depo], dates: { filed: "2025-03-29", event: "2025-03-29" }, docketNumber: "3:25-md-03140" });
    expect(entry.meta?.docketDocId).toBe(header.id);
    expect(entry.title).toBe("Dkt. 2: ORDER setting the Science Day schedule (test fixture)");
    const watched = intelDocuments().findOne((d) => d.externalId === "cl:docket:900")!;
    expect(watched.kind).toBe("docket");
    expect(searches.some((s) => /Depo-Provera/.test(s))).toBe(true);
  });
});

describe("news adapter without keys", () => {
  it("returns not_configured as a non-fatal error and the run succeeds", async () => {
    const source = createSource({ adapter: "news", name: "News test", config: { queries: ["meningioma"], includeMatters: false }, schedule: { every: "manual" } });
    const r = await runSource(source, { providers: providers(), embed: false });
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ code: "not_configured", fatal: false, retryable: false });
    expect(r.notes?.some((n) => /TAVILY_API_KEY/.test(n))).toBe(true);
    expect(runFailed(r).failed).toBe(false);
  });
});

describe("local-corpus adapter", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "intel-corpus-"));
  it("indexes txt/md/csv/json/docx/xlsx incrementally and maps folders to matters", async () => {
    const matterDir = path.join(dir, "Valsara-v-Meridian", "memos");
    fs.mkdirSync(matterDir, { recursive: true });
    fs.writeFileSync(path.join(matterDir, "timeline.md"), "# Clause 9.4 timeline\n\n" + "The 2001 toxicology summary was circulated internally. ".repeat(30));
    fs.writeFileSync(path.join(dir, "notes.txt"), "Plain notes about the Depo-Provera science day. ".repeat(20));
    fs.writeFileSync(path.join(dir, "custodians.csv"), "name,role\nGirish Hegde,VP Regulatory\nHema Vasudevan,Environmental Engineer\n");
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ matter: "m_valsara_arb", tier: 2, custodians: ["c_ghale", "c_hvoss"] }));
    fs.writeFileSync(path.join(dir, "ignored.bin"), Buffer.from([0, 1, 2]));
    fs.writeFileSync(path.join(dir, ".hidden.txt"), "hidden");
    const docx = new Document({ sections: [{ children: [new Paragraph("Memorandum regarding the government contractor defense."), new Paragraph("Second paragraph with the Boyle elements.")] }] });
    fs.writeFileSync(path.join(matterDir, "memo.docx"), await Packer.toBuffer(docx));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Bates", "Custodian"], ["MFC-0041877", "Girish Hegde"]]), "Production");
    fs.writeFileSync(path.join(dir, "production-log.xlsx"), XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
    const source = createSource({ adapter: "local-corpus", name: "Corpus test", config: { dirs: [dir] }, schedule: { every: "manual" } });
    const r = await runSource(source, { providers: providers(), embed: false });
    expect(r.errors).toEqual([]);
    expect(r.added).toBe(6);
    const docs = intelDocuments().find((d) => d.sourceId === source.id);
    expect(docs.every((d) => d.kind === "local_file" && d.chunkCount > 0)).toBe(true);
    const md = docs.find((d) => d.title === "timeline.md")!;
    expect(md.matterIds).toEqual([MATTERS.valsara]);
    expect(md.meta?.method).toBe("text");
    const memo = docs.find((d) => d.title === "memo.docx")!;
    expect(memo.matterIds).toEqual([MATTERS.valsara]);
    expect(getDocumentText(memo.id)).toContain("Boyle elements");
    expect(memo.meta?.method).toBe("mammoth");
    const xlsx = docs.find((d) => d.title === "production-log.xlsx")!;
    expect(getDocumentText(xlsx.id)).toContain("MFC-0041877");
    expect(xlsx.meta?.method).toBe("sheetjs");
    expect(docs.find((d) => d.title === "notes.txt")!.matterIds).toEqual([]);
    expect(docs.some((d) => d.title === "ignored.bin" || d.title === ".hidden.txt")).toBe(false);
    // Incremental: unchanged files are skipped; a modified file is updated; a new file is added.
    const again = await runSource(source, { providers: providers(), embed: false });
    expect(again).toMatchObject({ added: 0, updated: 0, skipped: 6 });
    fs.writeFileSync(path.join(dir, "notes.txt"), "Revised notes about the Depo-Provera science day and preemption. ".repeat(20));
    fs.writeFileSync(path.join(dir, "new.txt"), "A newly added note about the Northgate matter. ".repeat(10));
    const third = await runSource(source, { providers: providers(), embed: false });
    expect(third).toMatchObject({ added: 1, updated: 1, skipped: 5 });
    expect(getDocumentText(docs.find((d) => d.title === "notes.txt")!.id)).toContain("Revised notes");
    // Touched but identical content: refreshed, not re-indexed.
    const t = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(dir, "custodians.csv"), t, t);
    const fourth = await runSource(source, { providers: providers(), embed: false });
    expect(fourth).toMatchObject({ added: 0, updated: 0, skipped: 7 });
  });
  it("reports not_configured when no folders are configured and a non-fatal error for a missing folder", async () => {
    const none = createSource({ adapter: "local-corpus", name: "No dirs", config: { dirs: [] }, schedule: { every: "manual" } });
    const r = await runSource(none, { providers: providers(), embed: false });
    expect(r.errors[0]).toMatchObject({ code: "not_configured", fatal: false });
    expect(runFailed(r).failed).toBe(false);
    const missing = createSource({ adapter: "local-corpus", name: "Missing dir", config: { dirs: [path.join(dir, "does-not-exist")] }, schedule: { every: "manual" } });
    const m = await runSource(missing, { providers: providers(), embed: false });
    expect(m.errors[0].message).toMatch(/Folder not found/);
    expect(m.errors[0].fatal).toBe(false);
  });
});

describe("jpml-mdls adapter", () => {
  it("uses the fallback list, flags records unverified and links MDLs to matters by caption", async () => {
    const p = providers();
    const source = createSource({ adapter: "jpml-mdls", name: "JPML test", config: { maxResults: 50, watch: ["3140"] }, schedule: { every: "manual" } });
    const r = await runSource(source, { providers: p, embed: false });
    expect(runFailed(r).failed).toBe(false);
    expect(r.added).toBeGreaterThanOrEqual(10);
    expect(r.notes?.some((n) => /fallback/.test(n))).toBe(true);
    const depo = intelDocuments().findOne((d) => d.externalId === "jpml:3140" && d.sourceId === source.id)!;
    expect(depo).toMatchObject({ kind: "mdl", courtId: "flnd", matterIds: [MATTERS.depo], confidence: 0.55 });
    expect(depo.flags.some((f) => f.kind === "unverified")).toBe(true);
    expect(depo.tags).toContain("watched");
    expect(depo.matterIds).toEqual([MATTERS.depo]);
  });
});
