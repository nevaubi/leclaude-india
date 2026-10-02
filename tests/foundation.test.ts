import { beforeAll, describe, expect, it } from "vitest";
import { db, resetSqlite } from "@/lib/db";
import { toStrictSchema, normalizeArgs } from "@/lib/ai/tools";
import { chunkText, cosine } from "@/lib/ai/embeddings";
import { hybridSearch, indexDocument, indexStats } from "@/lib/ai/vector-store";
import { htmlToText, decodeEntities } from "@/lib/ai/toolkit/http";
import { createOfficeDoc, saveOfficeDoc, listVersions, restoreVersion, checkpoint, addComment, listComments } from "@/modules/office/shared/docs-service";
import { encodeSSE } from "@/lib/ai/sse";

beforeAll(() => { resetSqlite(); });

describe("database", () => {
  it("seeds core data on first open", () => {
    const d = db();
    expect(d.matters.count()).toBeGreaterThanOrEqual(5);
    expect(d.people.count()).toBeGreaterThan(10);
    expect(d.matters.get("m_valsara_arb")?.client).toBe("Meridian Fine Chemicals Ltd.");
  });
  it("collections round-trip with cache", () => {
    const d = db();
    const c = d.collection<{ id: string; n: number }>("test_items");
    c.putMany([{ id: "a", n: 1 }, { id: "b", n: 2 }, { id: "c", n: 3 }]);
    expect(c.count()).toBe(3);
    expect(c.list({ sortBy: "n", direction: "desc", limit: 2 }).map((x) => x.id)).toEqual(["c", "b"]);
    c.update("a", { n: 10 });
    expect(c.get("a")?.n).toBe(10);
    expect(c.delete("b")).toBe(true);
    expect(c.find((x) => x.n > 2).length).toBe(2);
  });
  it("kv and blobs work", () => {
    const d = db();
    d.kv.set("x", { y: 1 });
    expect(d.kv.get<{ y: number }>("x")?.y).toBe(1);
    const rec = d.blobs.put(new TextEncoder().encode("hello"), "text/plain", { name: "h.txt" });
    expect(d.blobs.get(rec.id)?.size).toBe(5);
  });
});

describe("tool schemas", () => {
  it("converts optional properties to nullable strict schema", () => {
    const s = toStrictSchema({ type: "object", properties: { a: { type: "string" }, b: { type: "integer", minimum: 1 }, c: { type: "object", properties: { d: { type: "boolean" } } } }, required: ["a"] });
    expect(s.additionalProperties).toBe(false);
    expect(s.required).toEqual(["a", "b", "c"]);
    const props = s.properties as Record<string, Record<string, unknown>>;
    expect(props.b.type).toEqual(["integer", "null"]);
    expect(props.b.minimum).toBeUndefined();
    expect(props.c.type).toEqual(["object", "null"]);
    expect(props.c.additionalProperties).toBe(false);
    expect(normalizeArgs({ a: "x", b: null })).toEqual({ a: "x" });
  });
});

describe("text utilities", () => {
  it("chunks text with overlap and computes cosine", () => {
    const text = Array.from({ length: 200 }, (_, i) => `Sentence number ${i} about solvent exposure and drinking water.`).join(" ");
    const chunks = chunkText(text, { size: 800, overlap: 100 });
    expect(chunks.length).toBeGreaterThan(5);
    expect(chunks.every((c) => c.length <= 1000)).toBe(true);
    expect(cosine(Float32Array.from([1, 0]), Float32Array.from([1, 0]))).toBeCloseTo(1);
  });
  it("extracts readable text from html", () => {
    const { title, text } = htmlToText("<html><head><title>Rule 56</title><style>x{}</style></head><body><nav>skip</nav><main><h1>Summary Judgment</h1><p>The court shall grant &sect; 56(a) &amp; more.</p></main></body></html>");
    expect(title).toBe("Rule 56");
    expect(text).toContain("Summary Judgment");
    expect(text).toContain("§ 56(a) & more");
    expect(text).not.toContain("skip");
    expect(decodeEntities("&#8212;&para;")).toBe("—¶");
  });
});

describe("vector store (keyword fallback without API key)", () => {
  it("indexes and searches by keyword when embeddings are unavailable", async () => {
    await indexDocument("test_vec", "doc1", "The Sundaram toxicology study reported hepatic effects in rats at 30 mg/kg.", { title: "tox" }, { embed: false });
    await indexDocument("test_vec", "doc2", "Monitoring well MW-7 at the Valsara site showed MC-8 at 1,200 ng/L.", { title: "well" }, { embed: false });
    expect(indexStats("test_vec").docs).toBe(2);
    const hits = await hybridSearch("test_vec", "Valsara monitoring well", { k: 5 });
    expect(hits[0]?.docId).toBe("doc2");
    expect(hits[0]?.meta?.title).toBe("well");
  });
});

describe("office documents", () => {
  it("creates, saves, versions, restores and comments", () => {
    const doc = createOfficeDoc({ kind: "word", title: "Test memo", content: { type: "doc", content: [] } });
    expect(listVersions(doc.id).length).toBe(1);
    const saved = saveOfficeDoc(doc.id, { content: { type: "doc", content: [{ type: "paragraph" }] }, version: { force: true, summary: "Agent edit: added paragraph" } })!;
    expect(saved.contentVersion).toBe(2);
    expect(listVersions(doc.id).length).toBe(2);
    checkpoint(doc.id, "Before partner review");
    const versions = listVersions(doc.id);
    expect(versions[0].label).toBe("Before partner review");
    const restored = restoreVersion(doc.id, versions[versions.length - 1].id)!;
    expect(JSON.stringify(restored.content)).toBe(JSON.stringify({ type: "doc", content: [] }));
    expect(listVersions(doc.id).length).toBeGreaterThanOrEqual(5);
    addComment(doc.id, { anchor: "p1", body: "Check this cite", source: "agent" });
    expect(listComments(doc.id)[0].authorName).toBe("Drafting assistant");
  });
});

describe("sse", () => {
  it("encodes events", () => {
    expect(encodeSSE({ type: "text.delta", delta: "hi" })).toBe('data: {"type":"text.delta","delta":"hi"}\n\n');
  });
});
