import { beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.LECLAUDE_DATA_DIR = `${process.env.TMPDIR || "/tmp"}/intel-vitest-core-${process.pid}`;
  process.env.LECLAUDE_BACKGROUND = "off";
  process.env.WORKFLOW_SCHEDULER_DISABLED = "1";
  process.env.INTEL_OFFLINE = "1";
  process.env.OPENAI_API_KEY = "";
});

import { db, resetSqlite } from "@/lib/db";
import { indexStats } from "@/lib/ai/vector-store";
import { chunkIntelText, isHeadingLine, normalizeText } from "@/modules/intel/chunk";
import { canonicalKey, cleanPersonName, courtIdFromName, mentionsFromCaption, mentionsFromCounselString, mentionsFromJudgeField } from "@/modules/intel/mentions";
import { computeNextRunAt, backoffMs, isSourceDue } from "@/modules/intel/schedule";
import { SEED_SOURCE_IDS } from "@/modules/intel/seed";
import { deleteDocument, documentsMissingEmbeddings, flagDocument, getDocumentText, indexIntelDocument, ingestDocument, intelChunks, intelDocuments, intelEntities, intelSources, intelStats, listChunks, listDocuments, searchIntel, unflagDocument, upsertDocument, upsertEntity } from "@/modules/intel/store";
import { INTEL_VECTOR_NAMESPACE } from "@/modules/intel/types";

beforeAll(() => { resetSqlite(); db(); });

const SRC = SEED_SOURCE_IDS.webList;

describe("chunking", () => {
  it("splits on paragraphs and headings with overlap, tracks pages and sections", () => {
    const para = (n: number) => `Paragraph ${n}. ` + "The court considered the motion and the parties' submissions in detail. ".repeat(6);
    const text = ["# Background", para(1), para(2), "[Page 2]", "II. Discussion", para(3), para(4), para(5), "CONCLUSION", "The motion is denied."].join("\n\n");
    const chunks = chunkIntelText(text, { size: 600, overlap: 100 });
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks[0].section).toBe("Background");
    expect(chunks.some((c) => c.section === "II. Discussion")).toBe(true);
    expect(chunks.some((c) => c.page === 2)).toBe(true);
    expect(chunks.every((c) => c.text.length <= 600 + 120)).toBe(true);
    expect(chunks.every((c, i) => c.idx === i)).toBe(true);
    // overlap: the second chunk starts with the tail of the first
    const tail = chunks[0].text.slice(-40).trim().split(" ").slice(-3).join(" ");
    expect(chunks[1].text.includes(tail)).toBe(true);
    // page markers are removed from the text
    expect(chunks.every((c) => !c.text.includes("[Page 2]"))).toBe(true);
    // offsets point into the normalized text
    const norm = normalizeText(text);
    expect(chunks.every((c) => c.startChar >= 0 && c.endChar <= norm.length && c.endChar >= c.startChar)).toBe(true);
  });
  it("handles a single long paragraph by sentences and empty input", () => {
    const long = "This is a sentence about PFAS. ".repeat(200);
    const chunks = chunkIntelText(long, { size: 1200, overlap: 150 });
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.every((c) => c.text.length <= 1400)).toBe(true);
    expect(chunkIntelText("   ")).toEqual([]);
  });
  it("recognizes headings", () => {
    expect(isHeadingLine("§ 705.3 Definitions")).toBe(true);
    expect(isHeadingLine("A. The government contractor defense")).toBe(true);
    expect(isHeadingLine("ORDER AND OPINION")).toBe(true);
    expect(isHeadingLine("The court denied the motion.")).toBe(false);
  });
});

describe("mentions", () => {
  it("cleans names and extracts parties, judges and counsel", () => {
    expect(cleanPersonName("Hon. Richard M. Gergel, USDJ")).toBe("Richard M. Gergel");
    expect(canonicalKey("Richard M. Gergel")).toBe("richard m gergel");
    expect(mentionsFromCaption("City of Stuart v. 3M Company, et al.").map((m) => m.name)).toEqual(["City of Stuart", "3M Company"]);
    expect(mentionsFromJudgeField("Gergel; Richard Mark Gergel")).toHaveLength(2);
    const counsel = mentionsFromCounselString("Baron & Budd, P.C. (Scott Summy)");
    expect(counsel.find((m) => m.type === "firm")?.name).toBe("Baron & Budd, P.C.");
    expect(counsel.find((m) => m.type === "attorney")?.name).toBe("Scott Summy");
    expect(courtIdFromName("U.S. District Court for the District of South Carolina")).toBe("dsc");
  });
});

describe("schedule", () => {
  it("computes next runs and backoff", () => {
    const from = new Date("2026-09-24T10:00:00");
    expect(computeNextRunAt({ every: "10m" }, from)!.getTime() - from.getTime()).toBe(600_000);
    expect(computeNextRunAt({ every: "manual" }, from)).toBeUndefined();
    const daily = computeNextRunAt({ every: "daily", at: "06:00" }, from)!;
    expect(daily.getDate()).toBe(25); expect(daily.getHours()).toBe(6);
    const weekly = computeNextRunAt({ every: "weekly", at: "03:00", weekday: 1 }, from)!;
    expect(weekly.getDay()).toBe(1); expect(weekly > from).toBe(true);
    expect(isSourceDue({ enabled: true, schedule: { every: "1h" }, nextRunAt: undefined, status: "idle" }, from)).toBe(true);
    expect(isSourceDue({ enabled: false, schedule: { every: "1h" }, nextRunAt: undefined, status: "disabled" }, from)).toBe(false);
    expect(backoffMs(1, 30_000, 3600_000, () => 0.5)).toBe(30_000);
    expect(backoffMs(4, 30_000, 3600_000, () => 0.5)).toBe(240_000);
    expect(backoffMs(20, 30_000, 3600_000, () => 0.5)).toBe(3600_000);
  });
});

describe("seeds", () => {
  it("seeds eighteen system sources (twelve sample, six India), a sample corpus with chunks and a keyword index, and entities", () => {
    expect(intelSources().count()).toBe(18);
    const docs = intelDocuments().all();
    expect(docs.length).toBeGreaterThanOrEqual(40);
    expect(docs.every((d) => d.meta?.seeded === true && d.chunkCount > 0 && d.textBlobId)).toBe(true);
    expect(intelChunks().count()).toBeGreaterThan(docs.length);
    expect(indexStats(INTEL_VECTOR_NAMESPACE).chunks).toBe(intelChunks().count());
    expect(intelEntities().count()).toBeGreaterThanOrEqual(20);
    const kinds = new Set(docs.map((d) => d.kind));
    for (const k of ["opinion", "docket", "docket_entry", "court_rule", "regulation", "register_notice", "recall", "mdl", "judge", "attorney", "firm", "news", "local_file", "web_page", "statute"]) expect(kinds.has(k as never)).toBe(true);
    const enabled = intelSources().find((s) => s.enabled).map((s) => s.adapter);
    expect(enabled).toEqual(expect.arrayContaining(["courtlistener-opinions", "ecfr", "federal-register", "govinfo", "openfda-recalls"]));
    expect(intelSources().get(SEED_SOURCE_IDS.news)?.enabled).toBe(false);
    expect(intelSources().get(SEED_SOURCE_IDS.localCorpus)?.enabled).toBe(false);
    expect(getDocumentText("idoc_seed_op_boyle")).toContain("reasonably precise specifications");
  });
});

describe("store", () => {
  it("upserts with hash dedupe, then externalId dedupe, keeps text in blobs and indexes idempotently", async () => {
    const base = { sourceId: SRC, adapter: "web-list" as const, kind: "web_page" as const, title: "Test page", dates: {}, externalId: "test:1", text: "Alpha paragraph about fluorosurfactants.\n\nBeta paragraph about groundwater sampling at the facility." };
    const a = await ingestDocument(base, { embed: false });
    expect(a.status).toBe("added");
    expect(a.doc.textBlobId).toBeTruthy();
    expect(a.doc.chunkCount).toBeGreaterThan(0);
    expect(getDocumentText(a.doc.id)).toContain("Alpha paragraph");
    const before = intelDocuments().count();
    // same text, same externalId → unchanged
    const b = await ingestDocument(base, { embed: false });
    expect(b.status).toBe("unchanged");
    expect(b.doc.id).toBe(a.doc.id);
    expect(intelDocuments().count()).toBe(before);
    // same text under a different external identity → a separate record, flagged duplicate
    const c = upsertDocument({ ...base, externalId: "test:other", title: "Test page (mirror)" });
    expect(c.doc.id).not.toBe(a.doc.id);
    expect(c.status).toBe("added");
    expect(c.doc.flags[0]).toMatchObject({ kind: "duplicate", by: "store" });
    expect(c.doc.meta?.duplicateOf).toBe(a.doc.id);
    expect(deleteDocument(c.doc.id)).toBe(true);
    // same text, no external identity → merges into the existing row
    const m = upsertDocument({ ...base, externalId: undefined, title: "Anonymous mirror" });
    expect(m.doc.id).toBe(a.doc.id);
    expect(m.doc.externalId).toBe("test:1");
    // changed text for the same externalId → updated, re-indexed, stale chunk ids removed
    const chunksBefore = listChunks(a.doc.id).length;
    const d = await ingestDocument({ ...base, text: "Completely different text about a docket entry." }, { embed: false });
    expect(d.status).toBe("updated");
    expect(d.textChanged).toBe(true);
    expect(d.doc.id).toBe(a.doc.id);
    expect(listChunks(a.doc.id).length).toBeLessThanOrEqual(chunksBefore);
    expect(getDocumentText(a.doc.id)).toContain("Completely different");
    const stats = indexStats(INTEL_VECTOR_NAMESPACE);
    const r = await indexIntelDocument(a.doc.id, undefined, { embed: false });
    expect(r.chunks).toBe(listChunks(a.doc.id).length);
    expect(indexStats(INTEL_VECTOR_NAMESPACE).chunks).toBe(stats.chunks);
    expect(deleteDocument(a.doc.id)).toBe(true);
    expect(listChunks(a.doc.id)).toEqual([]);
    expect(intelDocuments().get(a.doc.id)).toBeNull();
  });
  it("searches keyword-only with metadata filters and groups hits per document", async () => {
    const hits = await searchIntel({ q: "government contractor defense reasonably precise specifications", limit: 10 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.slice(0, 3).map((h) => h.doc.id)).toContain("idoc_seed_op_boyle");
    expect(hits[0].chunk.text.length).toBeGreaterThan(20);
    const opinionsOnly = await searchIntel({ q: "PFAS", kinds: ["opinion"], limit: 20 });
    expect(opinionsOnly.every((h) => h.doc.kind === "opinion")).toBe(true);
    const dsc = await searchIntel({ q: "AFFF", court: "dsc", limit: 20 });
    expect(dsc.length).toBeGreaterThan(0);
    expect(dsc.every((h) => intelDocuments().get(h.doc.id)?.courtId === "dsc")).toBe(true);
    const dated = await searchIntel({ q: "settlement", dateFrom: "2024-01-01", dateTo: "2024-12-31", limit: 20 });
    expect(dated.every((h) => { const d = h.doc.dates; const p = d.decided ?? d.filed ?? d.published ?? d.effective ?? d.event ?? d.modified; return p! >= "2024-01-01" && p! <= "2024-12-31"; })).toBe(true);
    const matter = await searchIntel({ q: "meningioma", matterId: "m_depo_provera_3140", limit: 20 });
    expect(matter.length).toBeGreaterThan(0);
    expect(matter.every((h) => intelDocuments().get(h.doc.id)?.matterIds.includes("m_depo_provera_3140"))).toBe(true);
    const perDoc = new Map<string, number>();
    for (const h of await searchIntel({ q: "PFAS drinking water", limit: 30 })) perDoc.set(h.doc.id, (perDoc.get(h.doc.id) ?? 0) + 1);
    expect(Math.max(...perDoc.values())).toBeLessThanOrEqual(2);
    const noQuery = await searchIntel({ q: "", kinds: ["news"], limit: 3 });
    expect(noQuery.length).toBe(3);
  });
  it("flags, lists with filters and paging, and reports stats", () => {
    const id = "idoc_seed_news_3m_settlement";
    flagDocument(id, { kind: "needs_review", note: "check figure", by: "test" });
    expect(intelDocuments().get(id)!.flags.some((f) => f.kind === "needs_review")).toBe(true);
    flagDocument(id, { kind: "needs_review", note: "replaced", by: "test" });
    expect(intelDocuments().get(id)!.flags.filter((f) => f.kind === "needs_review")).toHaveLength(1);
    expect(listDocuments({ flagKinds: ["needs_review"] }).items.map((d) => d.id)).toContain(id);
    unflagDocument(id, "needs_review");
    expect(intelDocuments().get(id)!.flags.some((f) => f.kind === "needs_review")).toBe(false);
    const page1 = listDocuments({ kinds: ["opinion"], sort: "date", limit: 5, offset: 0 });
    const page2 = listDocuments({ kinds: ["opinion"], sort: "date", limit: 5, offset: 5 });
    expect(page1.total).toBeGreaterThanOrEqual(10);
    expect(page1.items).toHaveLength(5);
    expect(page1.items.map((d) => d.id)).not.toEqual(page2.items.map((d) => d.id));
    expect(listDocuments({ q: "boyle" }).items.map((d) => d.id)).toContain("idoc_seed_op_boyle");
    expect(listDocuments({ matterId: "m_afff_2873", kinds: ["docket_entry"] }).total).toBeGreaterThan(3);
    expect(listDocuments({ entityId: "ient_seed_judge_gergel" }).total).toBeGreaterThan(3);
    expect(listDocuments({ flagged: true }).items.every((d) => d.flags.length > 0)).toBe(true);
    const stats = intelStats();
    expect(stats.documents).toBe(intelDocuments().count());
    expect(stats.byKind.opinion).toBeGreaterThan(5);
    expect(stats.vectors.chunks).toBe(stats.chunks);
    expect(documentsMissingEmbeddings(5).length).toBe(5);
  });
  it("upserts entities by canonical name and alias", () => {
    const e = upsertEntity({ type: "judge", name: "Judge Richard M. Gergel", docId: "idoc_seed_afff_docket" });
    expect(e.id).toBe("ient_seed_judge_gergel");
    const alias = upsertEntity({ type: "judge", name: "Richard Mark Gergel", docId: "idoc_seed_op_lipitor" });
    expect(alias.id).toBe(e.id);
    expect(alias.docIds).toContain("idoc_seed_op_lipitor");
    const fresh = upsertEntity({ type: "party", name: "Tyco Fire Products LP", attributes: { role: "defendant" } });
    expect(fresh.id.startsWith("ient_party_")).toBe(true);
    expect(intelEntities().get(fresh.id)?.canonical).toBe("tyco fire products lp");
  });
});
