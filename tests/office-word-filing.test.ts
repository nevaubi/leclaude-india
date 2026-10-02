import { beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.LECLAUDE_DATA_DIR = `${process.env.VITEST_DATA_DIR || process.env.TMPDIR || "/tmp"}/office-word-filing-vitest-${process.pid}`;
  process.env.LECLAUDE_BACKGROUND = "off";
  process.env.WORKFLOW_SCHEDULER_DISABLED = "1";
  delete process.env.DATABASE_URL;
  delete process.env.POSTGRES_URL;
});

import JSZip from "jszip";
import { NextRequest } from "next/server";
import { db, resetSqlite, blobs } from "@/lib/db";
import type { PMNode } from "@/modules/office/word/doc-model";
import { attributeQuotes, citationKey, filingSummary, quoteInText, quotedPassages, runFilingCheck, textBlocks, type CiteCheckLike, type FilingCheckDeps } from "@/modules/office/word/filing-check";
import { customPropsXml, readCustomProps } from "@/modules/office/word/ooxml/custom-props";
import { exportDocx } from "@/modules/office/word/export";
import { readDocx } from "@/modules/office/word/ooxml/reader";
import { appendixBlocks, checkLine, declarationBlocks, exportCustomProps, DECLARATION_HEADING } from "@/modules/office/word/provenance";
import { loadExportImage } from "@/modules/office/word/export-images";
import { docBodyHash, filingCheckFor, resetFilingCacheForTests } from "@/modules/office/word/filing-check-server";
import { settingsForTemplate } from "@/modules/office/word/constants";
import { listAudit } from "@/lib/integrity/audit";
import * as exportRoute from "@/app/api/office/word/export/route";
import * as filingRoute from "@/app/api/office/word/filing-check/route";

beforeAll(() => { resetSqlite(); db(); resetFilingCacheForTests(); });

let n = 0;
const para = (text: string, attrs: Record<string, unknown> = {}): PMNode => ({ type: "paragraph", attrs: { id: `p${++n}xx`, ...attrs }, content: [{ type: "text", text }] });
const docOf = (...blocks: PMNode[]): PMNode => ({ type: "doc", content: blocks });

const JUDGMENT = "The right to privacy is protected as an intrinsic part of the right to life and personal liberty under Article 21. Privacy is not an absolute right.";

/** Scripted citation check: the shape src/modules/search/service.ts checkCitations returns. */
function fakeCitecheck(map: Record<string, { state: "resolved" | "ambiguous" | "unresolved"; title?: string; candidates?: string[] }>): FilingCheckDeps["citecheck"] {
  return async (text) => {
    const extracted: CiteCheckLike["extracted"] = [];
    for (const c of Object.keys(map)) { let i = text.indexOf(c); while (i >= 0) { extracted.push({ citation: c, kind: "case", index: i, context: text.slice(Math.max(0, i - 30), i + c.length + 30) }); i = text.indexOf(c, i + 1); } }
    if (text.includes("Section 138")) extracted.push({ citation: "Section 138 NI Act", kind: "statute", index: text.indexOf("Section 138"), context: "" });
    return {
      extracted: extracted.sort((a, b) => a.index - b.index),
      checks: Object.entries(map).filter(([c]) => text.includes(c)).map(([citation, v]) => v.state === "resolved"
        ? { citation, resolved: true, status: 200, matches: [{ case_name: v.title }] }
        : v.state === "ambiguous" ? { citation, resolved: false, status: 300, error: "2 judgments carry this citation; none was chosen", matches: (v.candidates ?? []).map((x) => ({ case_name: x })) }
          : { citation, resolved: false, status: 404, error: "no judgment in the corpus carries this citation" }),
    };
  };
}

describe("filing check: text, quotes and attribution", () => {
  it("reads blocks in the accepted view (tracked deletions dropped) and marks quotation blocks", () => {
    const d = docOf(
      { type: "paragraph", attrs: { id: "a1aa" }, content: [{ type: "text", text: "Kept " }, { type: "text", text: "deleted ", marks: [{ type: "deletion", attrs: { id: "x" } }] }, { type: "text", text: "text." }] },
      { type: "blockquote", attrs: { id: "bq11" }, content: [para("A quoted passage of the judgment that runs over six words.")] },
    );
    expect(textBlocks(d)).toEqual([{ id: "a1aa", text: "Kept text.", quote: false }, { id: expect.any(String), text: "A quoted passage of the judgment that runs over six words.", quote: true }]);
  });

  it("finds quotes of six words or more, and matches them whitespace/quote/case-insensitively with ellipses in order", () => {
    expect(quotedPassages("He said “the right to privacy is protected as an intrinsic part” and “short one”.").map((q) => q.quote)).toEqual(["the right to privacy is protected as an intrinsic part"]);
    expect(quoteInText("THE RIGHT to privacy  is protected", JUDGMENT)).toBe(true);
    expect(quoteInText("right to privacy … not an absolute right", JUDGMENT)).toBe(true);
    expect(quoteInText("not an absolute right … right to privacy", JUDGMENT)).toBe(false);
  });

  it("attributes quotes by position only: single citation in the block, nearest citation, or the block before a quotation block", () => {
    const blocks = textBlocks(docOf(
      para("In Puttaswamy, (2017) 10 SCC 1, the Court held “privacy is protected as an intrinsic part of the right to life”."),
      para("Compare “a different passage that is quoted here at length” 2024 INSC 735 with (2017) 10 SCC 1 discussed later on in another sentence far away from the quote itself so that it is not nearby."),
      para("As held in 2019 INSC 1, the position is settled:"),
      { type: "blockquote", attrs: { id: "bq22" }, content: [para("Bail is the rule and jail is the exception in ordinary cases.")] },
      para("A quote with no citation “this passage has no authority attached at all”."),
    ));
    const m = attributeQuotes(blocks, ["(2017) 10 SCC 1", "2024 INSC 735", "2019 INSC 1"]);
    expect(m.get(citationKey("(2017) 10 SCC 1"))?.map((q) => q.quote)).toEqual(["privacy is protected as an intrinsic part of the right to life"]);
    expect(m.get(citationKey("2024 INSC 735"))?.map((q) => q.quote)).toEqual(["a different passage that is quoted here at length"]);
    expect(m.get(citationKey("2019 INSC 1"))?.map((q) => q.quote)).toEqual(["Bail is the rule and jail is the exception in ordinary cases."]);
    expect([...m.values()].flat().some((q) => q.quote.startsWith("this passage has no authority"))).toBe(false);
  });
});

describe("filing check: resolution, citator and quotes (fake dependencies)", () => {
  const doc = docOf(
    para("The Court in (2017) 10 SCC 1 held that “privacy is protected as an intrinsic part of the right to life”."),
    para("See also AIR 1978 SC 597 and 2023 INSC 999."),
    para("In 2024 INSC 735 the Court observed “this sentence does not appear anywhere in that judgment text”."),
    para("Liability under Section 138 is strict."),
    para("The respondent relies on (2010) 5 SCC 1 which is said to be relevant."),
  );
  const deps = (over: Partial<FilingCheckDeps> = {}): FilingCheckDeps => ({
    citecheck: fakeCitecheck({
      "(2017) 10 SCC 1": { state: "resolved", title: "K.S. Puttaswamy v. Union of India" },
      "AIR 1978 SC 597": { state: "ambiguous", candidates: ["Maneka Gandhi v. Union of India", "Another v. State"] },
      "2023 INSC 999": { state: "unresolved" },
      "2024 INSC 735": { state: "unresolved" },
      "(2010) 5 SCC 1": { state: "resolved", title: "Old Case v. State" },
    }),
    corpusJudgment: async (c) => (c === "2024 INSC 735" ? { id: "sc:2024_735", title: "Corpus Judgment v. State", text: JUDGMENT, complete: true } : null),
    citator: async (id) => (id === "sc:2024_735" ? { status: "built", negative: [{ title: "Later Bench v. State", court: "Supreme Court", decided: "2025-01-01", cue: "overruled", context: "…is overruled…" }] } : null),
    now: () => new Date("2026-10-01T10:00:00Z"),
    ...over,
  });

  it("keeps resolved / ambiguous / unresolved apart, never substitutes, and resolves an SC neutral citation only by exact corpus match", async () => {
    const r = await runFilingCheck(doc, "h1", deps());
    const by = Object.fromEntries(r.citations.map((c) => [c.citation, c]));
    expect(by["(2017) 10 SCC 1"]).toMatchObject({ state: "resolved", resolvedBy: "judgment_store", title: "K.S. Puttaswamy v. Union of India", corpusId: null, citator: "unavailable" });
    expect(by["AIR 1978 SC 597"]).toMatchObject({ state: "ambiguous", title: null, candidates: ["Maneka Gandhi v. Union of India", "Another v. State"] });
    expect(by["2023 INSC 999"]).toMatchObject({ state: "unresolved", title: null, corpusId: null });
    expect(by["2024 INSC 735"]).toMatchObject({ state: "resolved", resolvedBy: "official_corpus", corpusId: "sc:2024_735", citator: "negative_signal" });
    expect(by["2024 INSC 735"].negative[0].cue).toBe("overruled");
    // Quote attributed to a store-resolved judgment without corpus text: not checked (never "found").
    expect(by["(2017) 10 SCC 1"].quotes).toEqual([expect.objectContaining({ state: "text_unavailable" })]);
    expect(by["2024 INSC 735"].quotes).toEqual([expect.objectContaining({ state: "not_found" })]);
    expect(r.counts).toMatchObject({ citations: 5, resolved: 3, ambiguous: 1, unresolved: 1, negative: 1, quotesNotFound: 1, quotesUnchecked: 1, statutes: 1 });
    expect(r.issues.map((i) => i.kind).sort()).toEqual(["ambiguous", "negative", "quote_not_found", "quote_unchecked", "unresolved"]);
    expect(r.docHash).toBe("h1");
    expect(r.checkedAt).toBe("2026-10-01T10:00:00.000Z");
    expect(filingSummary(r.counts)).toContain("5 citations: 3 resolved, 1 ambiguous, 1 unresolved");
  });

  it("finds a quote in the judgment text, and says 'text incomplete' rather than 'not found' when only part was read", async () => {
    const d = docOf(para("In 2024 INSC 735 the Court said “the right to privacy is protected as an intrinsic part of the right to life”."));
    const found = await runFilingCheck(d, "h", deps());
    expect(found.citations[0].quotes[0].state).toBe("found");
    const partial = await runFilingCheck(docOf(para("In 2024 INSC 735 the Court said “words that are not in the part of the text that was read”.")), "h", deps({ corpusJudgment: async () => ({ id: "sc:2024_735", title: "T", text: JUDGMENT, complete: false }) }));
    expect(partial.citations[0].quotes[0].state).toBe("text_incomplete");
    expect(partial.issues.some((i) => i.kind === "quote_not_found")).toBe(false);
  });

  it("reports an unavailable resolver as such (nothing silently passes)", async () => {
    const r = await runFilingCheck(doc, "h", deps({ citecheck: async () => { throw new Error("store offline"); }, corpusJudgment: async () => "unavailable" }));
    expect(r.citations).toEqual([]);
    expect(r.unavailable[0]).toContain("store offline");
    expect(r.issues.some((i) => i.kind === "check_unavailable")).toBe(true);
  });

  it("never consults the corpus for an ambiguous citation", async () => {
    const seen: string[] = [];
    await runFilingCheck(docOf(para("Cited: 2020 INSC 5.")), "h", deps({ citecheck: fakeCitecheck({ "2020 INSC 5": { state: "ambiguous", candidates: ["A", "B"] } }), corpusJudgment: async (c) => { seen.push(c); return null; } }));
    expect(seen).toEqual([]);
  });
});

describe("custom document properties", () => {
  it("writes typed properties and replaces only LeClaude-owned ones on merge", () => {
    const first = customPropsXml([{ name: "Client.Ref", value: "AB&C <1>" }, { name: "LeClaude.Old", value: "stale" }, { name: "LeClaude.Count", value: 3 }]);
    expect(readCustomProps(first)).toEqual({ "Client.Ref": "AB&C <1>", "LeClaude.Old": "stale", "LeClaude.Count": "3" });
    const merged = customPropsXml([{ name: "LeClaude.Count", value: 7 }, { name: "LeClaude.Flag", value: true }, { name: "LeClaude.At", value: new Date("2026-10-01T00:00:00Z") }], first);
    expect(readCustomProps(merged)).toEqual({ "Client.Ref": "AB&C <1>", "LeClaude.Count": "7", "LeClaude.Flag": "true", "LeClaude.At": "2026-10-01T00:00:00Z" });
    const pids = [...merged.matchAll(/pid="(\d+)"/g)].map((m) => Number(m[1]));
    expect(new Set(pids).size).toBe(pids.length);
    expect(Math.min(...pids)).toBe(2);
    expect(merged).toContain("<vt:i4>7</vt:i4>");
    expect(merged).toContain("<vt:bool>true</vt:bool>");
  });

  it("adds docProps/custom.xml to fresh exports and merges it in package-preserving exports", async () => {
    const d = docOf(para("Body text."));
    const fresh = await exportDocx(d, { title: "T", customProps: [{ name: "Client.Ref", value: "M-1" }, { name: "LeClaude.Export.Tool", value: "old" }] });
    const z1 = await JSZip.loadAsync(fresh);
    expect(await z1.file("_rels/.rels")!.async("string")).toContain("custom-properties");
    expect(await z1.file("[Content_Types].xml")!.async("string")).toContain('PartName="/docProps/custom.xml"');
    expect(readCustomProps(await z1.file("docProps/custom.xml")!.async("string"))).toEqual({ "Client.Ref": "M-1", "LeClaude.Export.Tool": "old" });
    const plain = await JSZip.loadAsync(await exportDocx(d, { title: "T" }));
    expect(plain.file("docProps/custom.xml")).toBeNull();

    const base = new Uint8Array(fresh);
    const read = await readDocx(base);
    let mode = "";
    const again = await exportDocx(read.doc, { title: "T", basePackage: base, customProps: [{ name: "LeClaude.Export.Tool", value: "LeClaude Word" }], onReport: (r) => { mode = r.mode; } });
    expect(mode).toBe("preserve");
    const z2 = await JSZip.loadAsync(again);
    expect(readCustomProps(await z2.file("docProps/custom.xml")!.async("string"))).toEqual({ "Client.Ref": "M-1", "LeClaude.Export.Tool": "LeClaude Word" });
    expect((await z2.file("_rels/.rels")!.async("string")).match(/custom-properties/g)).toHaveLength(1);
  });
});

describe("provenance blocks and properties", () => {
  const counts = { citations: 4, resolved: 2, ambiguous: 1, unresolved: 1, negative: 0, quotesChecked: 1, quotesFound: 1, quotesNotFound: 0, quotesUnchecked: 1, statutes: 0 };
  it("states what the check found, or that no check ran — never more", () => {
    expect(checkLine({ state: "not_run", reason: "the check could not complete" })).toMatch(/^No automated citation check was recorded/);
    const line = checkLine({ state: "checked", checkedAt: "2026-10-01T10:00:00Z", counts, summary: "" });
    expect(line).toContain("4 case citations: 2 resolved, 1 ambiguous and 1 not resolved");
    expect(line).not.toMatch(/verified/i);
    expect(checkLine({ state: "stale", checkedAt: "2026-10-01T10:00:00Z", counts, summary: "" })).toContain("changed after that check");
    const blocks = declarationBlocks("  ", { state: "not_run", reason: "x" });
    expect(blocks[1].content?.[0].text).toBe(DECLARATION_HEADING);
    expect(blocks[2].content?.[0].text).toMatch(/^AI tools \(LeClaude\) were used/);
  });

  it("lists consulted sources without claiming support, and records properties per state", () => {
    const a = appendixBlocks([{ kind: "case-law", title: "Puttaswamy", cite: "(2017) 10 SCC 1" }, { kind: "case-law", title: "Puttaswamy", cite: "(2017) 10 SCC 1" }, { kind: "web", url: "https://example.org/x", title: "Note" }], 3);
    const list = a.find((b) => b.type === "orderedList");
    expect(list?.content).toHaveLength(2);
    expect(JSON.stringify(a)).toContain("does not show that any particular statement was checked");
    expect(JSON.stringify(appendixBlocks([], 0))).toContain("No drafting-assistant activity is recorded");
    const props = Object.fromEntries(exportCustomProps({ exportedAt: "2026-10-01T10:00:00Z", docHash: "abc", check: { state: "not_run", reason: "timeout" }, acknowledgement: null, assistantTurns: 0, providerRole: "not configured", models: [], declaration: false, appendix: { included: false, sources: 0 } }).map((p) => [p.name, p.value]));
    expect(props["LeClaude.CitationCheck.State"]).toBe("not_run");
    expect(props["LeClaude.CitationCheck.Resolved"]).toBeUndefined();
    expect(props["LeClaude.AI.Assisted"]).toBe(false);
    expect(props["LeClaude.Document.Hash"]).toBe("sha256:abc");
  });
});

describe("export image loading (SSRF guard)", () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 2, 0, 0, 0, 3, 8, 2, 0, 0, 0]);
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL) => {
    calls.push(String(url));
    const u = String(url);
    if (u.includes("redirect.example")) return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } });
    if (u.includes("big.example")) return new Response(new Uint8Array(11 * 1024 * 1024), { status: 200 });
    if (u.includes("html.example")) return new Response("<html>", { status: 200 });
    return new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
  }) as typeof fetch;
  const resolver = async (host: string) => (host === "internal.example" ? ["10.0.0.5"] : host === "localhost.example" ? ["127.0.0.1"] : ["93.184.216.34"]);

  it("fetches a public image, sniffing the bytes", async () => {
    const r = await loadExportImage("https://img.example/a.png", { fetchImpl, resolver });
    expect(r).toMatchObject({ image: { type: "png", width: 2, height: 3 } });
  });

  it("blocks private, loopback, metadata and redirect-to-metadata targets before any byte is read", async () => {
    calls.length = 0;
    expect(await loadExportImage("http://internal.example/x.png", { fetchImpl, resolver })).toMatchObject({ skip: "blocked" });
    expect(await loadExportImage("http://localhost.example/x.png", { fetchImpl, resolver })).toMatchObject({ skip: "blocked" });
    expect(await loadExportImage("http://169.254.169.254/latest/meta-data/", { fetchImpl, resolver })).toMatchObject({ skip: "blocked" });
    expect(await loadExportImage("http://127.0.0.1:3000/api/blobs/x", { fetchImpl, resolver })).toMatchObject({ skip: "blocked" });
    expect(calls).toEqual([]);
    expect(await loadExportImage("http://redirect.example/x.png", { fetchImpl, resolver })).toMatchObject({ skip: "blocked" });
    expect(calls).toEqual(["http://redirect.example/x.png"]);
  });

  it("refuses other schemes, oversize bodies and non-images", async () => {
    for (const src of ["file:///etc/passwd", "ftp://x.example/a.png", "javascript:alert(1)", "//x.example/a.png"]) expect(await loadExportImage(src, { fetchImpl, resolver })).toMatchObject({ skip: "unsupported_src" });
    expect(await loadExportImage("https://big.example/a.png", { fetchImpl, resolver })).toMatchObject({ skip: "too_large" });
    expect(await loadExportImage("https://html.example/a.png", { fetchImpl, resolver })).toMatchObject({ skip: "not_an_image" });
    expect(await loadExportImage(`data:image/png;base64,${Buffer.from(PNG).toString("base64")}`)).toMatchObject({ image: { type: "png" } });
  });

  it("reads blobs only when the caller may read them", async () => {
    const { id } = blobs.put(PNG, "image/png", { name: "x.png" });
    expect(await loadExportImage(`/api/blobs/${id}`)).toMatchObject({ skip: "blob_denied" });
    expect(await loadExportImage(`/api/blobs/${id}`, { canReadBlob: () => true })).toMatchObject({ image: { type: "png" } });
    expect(await loadExportImage(`/api/blobs/nope_missing`, { canReadBlob: () => true })).toMatchObject({ skip: "blob_missing" });
  });
});

describe("routes: filing check and export provenance", () => {
  const post = (url: string, body: unknown) => new NextRequest(`http://localhost${url}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const content = docOf(para("Draft. See (2099) 99 SCC 999 for the proposition."), para("Section 138 applies."));

  it("POST /api/office/word/filing-check returns a report bound to the body hash; unknown citations stay unresolved", async () => {
    const res = await filingRoute.POST(post("/api/office/word/filing-check", { content }) as never);
    expect(res.status).toBe(200);
    const { report } = await res.json();
    expect(report.docHash).toBe(docBodyHash(content));
    expect(report.citations.map((c: { citation: string; state: string }) => [c.citation, c.state])).toEqual([["(2099) 99 SCC 999", "unresolved"]]);
    const cached = await filingCheckFor(content);
    expect(cached.checkedAt).toBe(report.checkedAt);
  });

  it("records an acknowledgement in the audit log", async () => {
    const hash = docBodyHash(content);
    const res = await filingRoute.POST(post("/api/office/word/filing-check", { content, acknowledge: { format: "pdf", docHash: hash, items: 1, issueKeys: ["k"] } }) as never);
    expect(await res.json()).toMatchObject({ ok: true, matchesDocument: true });
    const ev = listAudit({ limit: 5 }).find((e) => e.action === "export" && (e.meta as Record<string, unknown>)?.filingCheckAcknowledged === true);
    expect(ev?.meta).toMatchObject({ format: "pdf", acknowledgedItems: 1, ackMatchesDocument: true });
  });

  it("exports a .docx with the declaration, the check line and LeClaude custom properties", async () => {
    const hash = docBodyHash(content);
    const res = await exportRoute.POST(post("/api/office/word/export", { content, title: "Draft", format: "docx", provenance: { declaration: { text: "AI tools were used in drafting." }, appendix: true, acknowledgement: { acknowledged: true, docHash: hash, items: 1 } } }) as never);
    expect(res.status).toBe(200);
    const zip = await JSZip.loadAsync(new Uint8Array(await res.arrayBuffer()));
    const xml = await zip.file("word/document.xml")!.async("string");
    expect(xml).toContain(DECLARATION_HEADING);
    expect(xml).toContain("AI tools were used in drafting.");
    expect(xml).toContain("1 not resolved");
    expect(xml).toContain("Provenance appendix");
    const props = readCustomProps(await zip.file("docProps/custom.xml")!.async("string"));
    expect(props).toMatchObject({ "LeClaude.CitationCheck.State": "checked", "LeClaude.CitationCheck.Unresolved": "1", "LeClaude.FilingCheck.Acknowledged": "true", "LeClaude.FilingCheck.AckMatchesExport": "true", "LeClaude.Document.Hash": `sha256:${hash}`, "LeClaude.Declaration.Included": "true" });
  });

  it("leaves exports without provenance options unchanged (no custom part)", async () => {
    const res = await exportRoute.POST(post("/api/office/word/export", { content, title: "Plain", format: "docx" }) as never);
    const zip = await JSZip.loadAsync(new Uint8Array(await res.arrayBuffer()));
    expect(zip.file("docProps/custom.xml")).toBeNull();
    expect(await zip.file("word/document.xml")!.async("string")).not.toContain(DECLARATION_HEADING);
  });
});

describe("India templates page setup", () => {
  it("uses A4 and Indian English for word-in-* templates only", () => {
    expect(settingsForTemplate("word-in-plaint")).toMatchObject({ pageSize: "a4", language: "en-IN" });
    expect(settingsForTemplate("word-motion-brief")).toMatchObject({ pageSize: "letter", language: "en-US" });
  });
});
