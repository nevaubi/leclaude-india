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
import { EXPORT_IMAGE_LIMITS, exportDocx, loadExportImages } from "@/modules/office/word/export";
import { readDocx } from "@/modules/office/word/ooxml/reader";
import { aiSurfacesFromMeta, appendixBlocks, checkLine, checkStateOf, declarationBlocks, exportCustomProps, DECLARATION_HEADING, type CheckState } from "@/modules/office/word/provenance";
import { loadExportImage } from "@/modules/office/word/export-images";
import { docBodyHash, exportCheckState, filingCheckFor, judgmentTextForQuotes, resetFilingCacheForTests, serverFilingDeps } from "@/modules/office/word/filing-check-server";
import { resetTextTableCacheForTests, type JudgmentTextChunk } from "@/modules/india/corpus/text";
import type { RemoteStore, Row, SqlQuery } from "@/lib/db/remote";
import { createOfficeDoc } from "@/modules/office/shared/docs-service";
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
    // Resolved through the judgment store with no official-corpus record: the citator was never consulted, and says so.
    expect(by["(2017) 10 SCC 1"]).toMatchObject({ state: "resolved", resolvedBy: "judgment_store", title: "K.S. Puttaswamy v. Union of India", corpusId: null, citator: "not_checked" });
    expect(by["AIR 1978 SC 597"]).toMatchObject({ state: "ambiguous", title: null, candidates: ["Maneka Gandhi v. Union of India", "Another v. State"] });
    expect(by["2023 INSC 999"]).toMatchObject({ state: "unresolved", title: null, corpusId: null });
    expect(by["2024 INSC 735"]).toMatchObject({ state: "resolved", resolvedBy: "official_corpus", corpusId: "sc:2024_735", citator: "negative_signal" });
    expect(by["2024 INSC 735"].negative[0].cue).toBe("overruled");
    // Quote attributed to a store-resolved judgment without corpus text: not checked (never "found").
    expect(by["(2017) 10 SCC 1"].quotes).toEqual([expect.objectContaining({ state: "text_unavailable" })]);
    expect(by["2024 INSC 735"].quotes).toEqual([expect.objectContaining({ state: "not_found" })]);
    expect(r.counts).toMatchObject({ citations: 5, found: 5, checked: 5, unchecked: 0, resolved: 3, ambiguous: 1, unresolved: 1, negative: 1, citatorChecked: 1, citatorUnchecked: 2, quotesNotFound: 1, quotesUnchecked: 1, statutes: 1 });
    expect(r.coverage).toBe("complete");
    expect(r.issues.map((i) => i.kind).sort()).toEqual(["ambiguous", "citator_unchecked", "negative", "quote_not_found", "quote_unchecked", "unresolved"]);
    const citatorIssue = r.issues.find((i) => i.kind === "citator_unchecked")!;
    expect(citatorIssue.message).toMatch(/^Citator not consulted for 2 of 3 resolved citations \(\(2017\) 10 SCC 1; \(2010\) 5 SCC 1\)/);
    expect(r.docHash).toBe("h1");
    expect(r.checkedAt).toBe("2026-10-01T10:00:00.000Z");
    expect(filingSummary(r.counts)).toContain("5 citations found, 5 checked: 3 resolved, 1 ambiguous, 1 unresolved; citator consulted for 1 of 3 resolved");
  });

  it("finds a quote in the judgment text, and says 'text incomplete' rather than 'not found' when only part was read", async () => {
    const d = docOf(para("In 2024 INSC 735 the Court said “the right to privacy is protected as an intrinsic part of the right to life”."));
    const found = await runFilingCheck(d, "h", deps());
    expect(found.citations[0].quotes[0].state).toBe("found");
    const partial = await runFilingCheck(docOf(para("In 2024 INSC 735 the Court said “words that are not in the part of the text that was read”.")), "h", deps({ corpusJudgment: async () => ({ id: "sc:2024_735", title: "T", text: JUDGMENT, complete: false }) }));
    expect(partial.citations[0].quotes[0].state).toBe("text_incomplete");
    expect(partial.issues.some((i) => i.kind === "quote_not_found")).toBe(false);
  });

  it("reports an unavailable resolver as such (nothing silently passes): not_run when nothing was read, partial when found but not checked", async () => {
    const r = await runFilingCheck(doc, "h", deps({ citecheck: async () => { throw new Error("store offline"); }, corpusJudgment: async () => "unavailable" }));
    expect(r.citations).toEqual([]);
    expect(r.coverage).toBe("not_run");
    expect(r.unavailable[0]).toContain("store offline");
    expect(r.issues.some((i) => i.kind === "check_unavailable")).toBe(true);
    // The citations were read but the resolver failed: each is "unchecked" (never "unresolved"), except an SC neutral
    // citation found by exact match in the official corpus.
    const read = fakeCitecheck({ "(2017) 10 SCC 1": { state: "resolved" }, "2024 INSC 735": { state: "unresolved" } });
    const p = await runFilingCheck(doc, "h", deps({ citecheck: async (t) => ({ ...(await read(t)), checks: [], providerError: "judgment store offline" }) }));
    expect(p.coverage).toBe("partial");
    expect(Object.fromEntries(p.citations.map((c) => [c.citation, c.state]))).toEqual({ "(2017) 10 SCC 1": "unchecked", "2024 INSC 735": "resolved" });
    expect(p.counts).toMatchObject({ found: 2, checked: 1, unchecked: 1, unresolved: 0, resolved: 1 });
    expect(p.issues.some((i) => i.kind === "unresolved")).toBe(false);
    expect(p.unavailable[0]).toMatch(/judgment store offline\. Citations found were not checked/);
  });

  it("says how many citations were found when more than the limit were (partial, found vs checked)", async () => {
    const map = Object.fromEntries(Array.from({ length: 61 }, (_, i) => [`(2001) ${i + 1} SCC 1`, { state: "resolved" as const, title: `Case ${i + 1}` }]));
    const many = docOf(...Object.keys(map).map((c) => para(`See ${c} for this.`)));
    const r = await runFilingCheck(many, "h", deps({ citecheck: fakeCitecheck(map) }));
    expect(r.coverage).toBe("partial");
    expect(r.counts).toMatchObject({ found: 61, citations: 60, checked: 60 });
    expect(r.unavailable).toContain("61 distinct citations were found; only the first 60 were checked.");
    expect(checkLine(checkStateOf(r))).toMatch(/ran only in part \(61 distinct citations were found; only the first 60 were checked\)\. It found 61 case citations and checked 60: 60 resolved/);
  });

  it("never consults the corpus for an ambiguous citation", async () => {
    const seen: string[] = [];
    await runFilingCheck(docOf(para("Cited: 2020 INSC 5.")), "h", deps({ citecheck: fakeCitecheck({ "2020 INSC 5": { state: "ambiguous", candidates: ["A", "B"] } }), corpusJudgment: async (c) => { seen.push(c); return null; } }));
    expect(seen).toEqual([]);
  });
});

describe("custom document properties", () => {
  it("writes typed properties and replaces only app-owned ones on merge", () => {
    const first = customPropsXml([{ name: "Client.Ref", value: "AB&C <1>" }, { name: "Pramana.Old", value: "stale" }, { name: "Pramana.Count", value: 3 }]);
    expect(readCustomProps(first)).toEqual({ "Client.Ref": "AB&C <1>", "Pramana.Old": "stale", "Pramana.Count": "3" });
    const merged = customPropsXml([{ name: "Pramana.Count", value: 7 }, { name: "Pramana.Flag", value: true }, { name: "Pramana.At", value: new Date("2026-10-01T00:00:00Z") }], first);
    expect(readCustomProps(merged)).toEqual({ "Client.Ref": "AB&C <1>", "Pramana.Count": "7", "Pramana.Flag": "true", "Pramana.At": "2026-10-01T00:00:00Z" });
    const pids = [...merged.matchAll(/pid="(\d+)"/g)].map((m) => Number(m[1]));
    expect(new Set(pids).size).toBe(pids.length);
    expect(Math.min(...pids)).toBe(2);
    expect(merged).toContain("<vt:i4>7</vt:i4>");
    expect(merged).toContain("<vt:bool>true</vt:bool>");
  });

  it("treats the pre-rename LeClaude.* properties as app-owned: a re-export replaces them, foreign ones are kept", () => {
    const old = customPropsXml([{ name: "Client.Ref", value: "M-7" }, { name: "LeClaude.Export.Tool", value: "LeClaude Word" }, { name: "LeClaude.AI.Assisted", value: true }]);
    const merged = customPropsXml([{ name: "Pramana.Export.Tool", value: "Pramana Word" }], old);
    expect(readCustomProps(merged)).toEqual({ "Client.Ref": "M-7", "Pramana.Export.Tool": "Pramana Word" });
    expect(readCustomProps(old, { ownOnly: true })).toEqual({ "LeClaude.Export.Tool": "LeClaude Word", "LeClaude.AI.Assisted": "true" });
  });

  it("adds docProps/custom.xml to fresh exports and merges it in package-preserving exports", async () => {
    const d = docOf(para("Body text."));
    const fresh = await exportDocx(d, { title: "T", customProps: [{ name: "Client.Ref", value: "M-1" }, { name: "Pramana.Export.Tool", value: "old" }] });
    const z1 = await JSZip.loadAsync(fresh);
    expect(await z1.file("_rels/.rels")!.async("string")).toContain("custom-properties");
    expect(await z1.file("[Content_Types].xml")!.async("string")).toContain('PartName="/docProps/custom.xml"');
    expect(readCustomProps(await z1.file("docProps/custom.xml")!.async("string"))).toEqual({ "Client.Ref": "M-1", "Pramana.Export.Tool": "old" });
    const plain = await JSZip.loadAsync(await exportDocx(d, { title: "T" }));
    expect(plain.file("docProps/custom.xml")).toBeNull();

    const base = new Uint8Array(fresh);
    const read = await readDocx(base);
    let mode = "";
    const again = await exportDocx(read.doc, { title: "T", basePackage: base, customProps: [{ name: "Pramana.Export.Tool", value: "Pramana Word" }], onReport: (r) => { mode = r.mode; } });
    expect(mode).toBe("preserve");
    const z2 = await JSZip.loadAsync(again);
    expect(readCustomProps(await z2.file("docProps/custom.xml")!.async("string"))).toEqual({ "Client.Ref": "M-1", "Pramana.Export.Tool": "Pramana Word" });
    expect((await z2.file("_rels/.rels")!.async("string")).match(/custom-properties/g)).toHaveLength(1);
  });
});

describe("provenance blocks and properties", () => {
  const counts = { citations: 4, found: 4, checked: 4, unchecked: 0, resolved: 2, ambiguous: 1, unresolved: 1, negative: 0, citatorChecked: 1, citatorUnchecked: 1, quotesChecked: 1, quotesFound: 1, quotesNotFound: 0, quotesUnchecked: 1, statutes: 0 };
  it("states what the check found, or that no check ran — never more", () => {
    expect(checkLine({ state: "not_run", reason: "the check could not complete" })).toMatch(/^No automated citation check ran for this version/);
    const line = checkLine({ state: "checked", checkedAt: "2026-10-01T10:00:00Z", counts, summary: "" });
    expect(line).toContain("found 4 case citations and checked all of them: 2 resolved, 1 ambiguous and 1 not resolved.");
    expect(line).toContain("The citator was consulted for 1 of the 2 resolved citations.");
    expect(line).not.toMatch(/verified/i);
    const partial = checkLine({ state: "partial", checkedAt: "2026-10-01T10:00:00Z", counts: { ...counts, checked: 0, unchecked: 4, resolved: 0, ambiguous: 0, unresolved: 0, citatorChecked: 0, citatorUnchecked: 0 }, summary: "", reasons: ["Citation resolver: down. Citations found were not checked against the judgment store."] });
    expect(partial).toMatch(/ran only in part \(Citation resolver: down\. Citations found were not checked against the judgment store\)\. It found 4 case citations and checked 0\./);
    expect(partial).not.toMatch(/resolved/);
    expect(checkLine({ state: "stale", checkedAt: "2026-10-01T10:00:00Z", counts, summary: "" })).toContain("changed after that check");
    const blocks = declarationBlocks("  ", { state: "not_run", reason: "x" });
    expect(blocks[1].content?.[0].text).toBe(DECLARATION_HEADING);
    expect(blocks[2].content?.[0].text).toMatch(/^AI tools \(Pramana\) were used/);
  });

  it("lists consulted sources without claiming support, and records properties per state", () => {
    const a = appendixBlocks([{ kind: "case-law", title: "Puttaswamy", cite: "(2017) 10 SCC 1" }, { kind: "case-law", title: "Puttaswamy", cite: "(2017) 10 SCC 1" }, { kind: "web", url: "https://example.org/x", title: "Note" }], 3);
    const list = a.find((b) => b.type === "orderedList");
    expect(list?.content).toHaveLength(2);
    expect(JSON.stringify(a)).toContain("does not show that any particular statement was checked");
    expect(JSON.stringify(appendixBlocks([], 0))).toContain("No drafting-assistant activity is recorded");
    const props = Object.fromEntries(exportCustomProps({ exportedAt: "2026-10-01T10:00:00Z", docHash: "abc", check: { state: "not_run", reason: "timeout" }, acknowledgement: null, assistantTurns: 0, providerRole: "not configured", models: [], declaration: false, appendix: { included: false, sources: 0 } }).map((p) => [p.name, p.value]));
    expect(props["Pramana.CitationCheck.State"]).toBe("not_run");
    expect(props["Pramana.CitationCheck.Resolved"]).toBeUndefined();
    // Nothing recorded: "unknown", never false (AI use outside the app cannot be known).
    expect(props["Pramana.AI.Assisted"]).toBe("unknown");
    expect(props["Pramana.FilingCheck.Acknowledged"]).toBe(false);
    expect(props["Pramana.Document.Hash"]).toBe("sha256:abc");
    const ai = Object.fromEntries(exportCustomProps({ exportedAt: "2026-10-01T10:00:00Z", docHash: "abc", check: { state: "checked", checkedAt: "2026-10-01T10:00:00Z", counts, summary: "s" }, gate: "editor", openIssues: 3, acknowledgement: null, assistantTurns: 0, aiSurfaces: aiSurfacesFromMeta({ source: "documents.parawise" }), providerRole: "x", models: [], declaration: false, appendix: { included: false, sources: 0 } }).map((p) => [p.name, p.value]));
    expect(ai["Pramana.AI.Assisted"]).toBe(true);
    expect(ai["Pramana.AI.Basis"]).toMatch(/^documents\.parawise: para-wise reply with AI-proposed responses/);
    expect(ai).toMatchObject({ "Pramana.FilingCheck.Gate": "editor", "Pramana.FilingCheck.OpenIssues": 3, "Pramana.FilingCheck.Acknowledged": false, "Pramana.CitationCheck.CitationsFound": 4, "Pramana.CitationCheck.CitationsChecked": 4, "Pramana.CitationCheck.CitatorChecked": 1, "Pramana.CitationCheck.CitatorUnchecked": 1 });
    expect(aiSurfacesFromMeta({ source: "documents.dates", ai: { assisted: false, detail: "typed by hand" } })).toEqual([]);
    expect(aiSurfacesFromMeta({ source: "matters.brief" })).toEqual([]);
  });

  it("records a resolver failure as not_run or partial in the declaration and the properties (never 'checked'), and does not cache it", async () => {
    resetFilingCacheForTests();
    const d = docOf(para("The Court in (2017) 10 SCC 1 held so, and 2024 INSC 735 followed it."));
    let calls = 0;
    const down: FilingCheckDeps = { citecheck: async () => { calls++; throw new Error("resolver offline"); } };
    const none = await exportCheckState(d, { deps: down });
    expect(none.state).toMatchObject({ state: "not_run", reason: expect.stringContaining("resolver offline") });
    await exportCheckState(d, { deps: down });
    expect(calls).toBe(2); // a failed check is not served from the cache
    const declText = JSON.stringify(declarationBlocks("AI tools were used.", none.state));
    expect(declText).toContain("No automated citation check ran for this version of the document");
    const p1 = Object.fromEntries(exportCustomProps({ exportedAt: "2026-10-01T10:00:00Z", docHash: "h", check: none.state, acknowledgement: null, assistantTurns: 0, providerRole: "x", models: [], declaration: true, appendix: { included: false, sources: 0 } }).map((p) => [p.name, p.value]));
    expect(p1["Pramana.CitationCheck.State"]).toBe("not_run");
    expect(p1["Pramana.CitationCheck.Reason"]).toContain("resolver offline");

    const read = fakeCitecheck({ "(2017) 10 SCC 1": { state: "resolved" }, "2024 INSC 735": { state: "resolved" } });
    const partial = await exportCheckState(d, { deps: { citecheck: async (t) => ({ ...(await read(t)), checks: [], providerError: "judgment store offline" }), corpusJudgment: async () => "unavailable" } });
    const st = partial.state as Extract<CheckState, { state: "partial" }>;
    expect(st.state).toBe("partial");
    const line = checkLine(st);
    expect(line).toMatch(/ran only in part/);
    expect(line).toContain("It found 2 case citations and checked 0.");
    const p2 = Object.fromEntries(exportCustomProps({ exportedAt: "2026-10-01T10:00:00Z", docHash: "h", check: st, acknowledgement: null, assistantTurns: 0, providerRole: "x", models: [], declaration: true, appendix: { included: false, sources: 0 } }).map((p) => [p.name, p.value]));
    expect(p2).toMatchObject({ "Pramana.CitationCheck.State": "partial", "Pramana.CitationCheck.CitationsFound": 2, "Pramana.CitationCheck.CitationsChecked": 0, "Pramana.CitationCheck.Unchecked": 2, "Pramana.CitationCheck.Resolved": 0 });
    expect(String(p2["Pramana.CitationCheck.Unavailable"])).toContain("judgment store offline");
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

  it("exports a .docx with the declaration, the check line and Pramana custom properties", async () => {
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
    expect(props).toMatchObject({ "Pramana.CitationCheck.State": "checked", "Pramana.CitationCheck.Unresolved": "1", "Pramana.FilingCheck.Acknowledged": "true", "Pramana.FilingCheck.AckMatchesExport": "true", "Pramana.Document.Hash": `sha256:${hash}`, "Pramana.Declaration.Included": "true" });
  });

  it("marks a .docx exported without the gate (document list, library, API) as check not_run, gate none, not acknowledged", async () => {
    const res = await exportRoute.POST(post("/api/office/word/export", { content, title: "Plain", format: "docx" }) as never);
    expect(res.status).toBe(200);
    const zip = await JSZip.loadAsync(new Uint8Array(await res.arrayBuffer()));
    expect(await zip.file("word/document.xml")!.async("string")).not.toContain(DECLARATION_HEADING); // nothing appended to the body
    const props = readCustomProps(await zip.file("docProps/custom.xml")!.async("string"));
    expect(props).toMatchObject({ "Pramana.CitationCheck.State": "not_run", "Pramana.FilingCheck.Gate": "none", "Pramana.FilingCheck.Acknowledged": "false", "Pramana.AI.Assisted": "unknown" });
    expect(props["Pramana.CitationCheck.Reason"]).toMatch(/without the Word editor's filing check/);
    expect(props["Pramana.CitationCheck.Resolved"]).toBeUndefined();
    const ev = listAudit({ limit: 5 }).find((e) => e.action === "export" && (e.meta as Record<string, unknown>)?.gate === "none");
    expect(ev?.meta).toMatchObject({ format: "docx", citationCheck: { state: "not_run" } });
  });

  it("records AI use from the document's own record (a drafting feature that created it), not only assistant turns", async () => {
    const doc = createOfficeDoc({ kind: "word", title: "Written statement", content: content, meta: { source: "documents.parawise", ai: { assisted: true, surface: "documents.parawise", detail: "Responses to 3 of 3 paragraphs proposed by AI." } } });
    const res = await exportRoute.POST(post("/api/office/word/export", { docId: doc.id, format: "docx" }) as never);
    expect(res.status).toBe(200);
    const props = readCustomProps(await (await JSZip.loadAsync(new Uint8Array(await res.arrayBuffer()))).file("docProps/custom.xml")!.async("string"));
    expect(props["Pramana.AI.Assisted"]).toBe("true");
    expect(props["Pramana.AI.Basis"]).toBe("documents.parawise: Responses to 3 of 3 paragraphs proposed by AI.");
  });
});

describe("export image limits", () => {
  it("caps the number of images, their total bytes and the fetches in flight", async () => {
    const big = { bytes: new Uint8Array(25 * 1024 * 1024), type: "png" as const };
    let inFlight = 0;
    let peak = 0;
    const fetchImage = async () => { inFlight++; peak = Math.max(peak, inFlight); await new Promise((r) => setTimeout(r, 2)); inFlight--; return big; };
    const three = await loadExportImages(["a", "b", "c"], fetchImage);
    expect([...three.images.values()].filter(Boolean)).toHaveLength(2); // 2 × 25 MB fit in 64 MB; the third does not
    expect(three.warnings.join(" ")).toMatch(/1 image left out: images are limited to 64 MB per export/);
    const small = { bytes: new Uint8Array(10), type: "png" as const };
    const srcs = Array.from({ length: EXPORT_IMAGE_LIMITS.maxImages + 5 }, (_, i) => `s${i}`);
    peak = 0;
    const many = await loadExportImages(srcs, async () => { inFlight++; peak = Math.max(peak, inFlight); await new Promise((r) => setTimeout(r, 1)); inFlight--; return small; });
    expect(many.images.size).toBe(srcs.length);
    expect([...many.images.values()].filter(Boolean)).toHaveLength(EXPORT_IMAGE_LIMITS.maxImages);
    expect(many.warnings[0]).toMatch(/5 images beyond the first 200 left out/);
    expect(peak).toBeLessThanOrEqual(EXPORT_IMAGE_LIMITS.concurrency);
  });
});

describe("India templates page setup", () => {
  it("uses A4 and Indian English for word-in-* templates only", () => {
    expect(settingsForTemplate("word-in-plaint")).toMatchObject({ pageSize: "a4", language: "en-IN" });
    expect(settingsForTemplate("word-motion-brief")).toMatchObject({ pageSize: "letter", language: "en-US" });
  });
});

describe("filing check: a quote is 'not found' only against the whole judgment text", () => {
  const chunk = (index: number, text: string, page: number | null = index + 1): JudgmentTextChunk => ({ index, pageStart: page, pageEnd: page, section: null, text });
  const crossing = "a contract without consideration is void ab initio";

  it("compares against chunk text without page markers, and calls text complete only from chunk 0 to the last, with no gap", () => {
    const two = [chunk(0, "The court held that a contract without consideration", 4), chunk(1, "is void ab initio and cannot be enforced.", 5)];
    const whole = judgmentTextForQuotes({ chunks: two, nextChunk: null, totalChunks: 2 });
    expect(whole.complete).toBe(true);
    expect(whole.text).not.toMatch(/\[p\./);
    expect(quoteInText(crossing, whole.text!)).toBe(true); // runs across the page break
    expect(judgmentTextForQuotes({ chunks: two, nextChunk: 2, totalChunks: 3 }).complete).toBe(false); // more to read
    expect(judgmentTextForQuotes({ chunks: two, nextChunk: null, totalChunks: 5 }).complete).toBe(false); // corpus records 5 chunks
    expect(judgmentTextForQuotes({ chunks: [chunk(0, "a"), chunk(2, "c")], nextChunk: null, totalChunks: 0 }).complete).toBe(false); // gap
    expect(judgmentTextForQuotes({ chunks: [chunk(1, "b"), chunk(2, "c")], nextChunk: null, totalChunks: 3 }).complete).toBe(false); // not from the start
    expect(judgmentTextForQuotes({ chunks: [], nextChunk: null, totalChunks: 0 })).toEqual({ text: null, complete: false });
  });

  /** A corpus store holding one Supreme Court judgment's chunks (answers only the statements readJudgmentText runs). */
  function fakeCorpus(chunks: { index: number; text: string; page: number }[], totalChunks: number | null): RemoteStore {
    const query = async (q: SqlQuery): Promise<Row[]> => {
      if (q.query.includes("to_regclass")) return [{ ok: "true", hc: "false" }];
      if (q.query.includes("FROM corpus_judgments")) return [{ id: "sc:2024_735", title: "Corpus Judgment v. State" }];
      if (q.query.includes("FROM corpus_texts")) {
        const from = Number(q.params?.[1] ?? 0);
        return chunks.filter((c) => c.index >= from).slice(0, 400).map((c) => ({ chunk_index: String(c.index), total_chunks: totalChunks == null ? null : String(totalChunks), page_start: String(c.page), page_end: String(c.page), section_type: null, text: c.text }));
      }
      throw new Error(`unexpected query: ${q.query.slice(0, 60)}`);
    };
    return { query, transaction: async (qs) => Promise.all(qs.map(query)) };
  }
  const citecheck = fakeCitecheck({ "2024 INSC 735": { state: "unresolved" } });

  it("reports a quote beyond the 400 chunks read as unchecked (text_incomplete), never as not found", async () => {
    resetTextTableCacheForTests();
    // 401 short chunks and no total recorded: the reader's 400-row limit is reached with nothing saying more exists.
    const chunks = Array.from({ length: 401 }, (_, i) => ({ index: i, text: i === 400 ? "the quoted words appear only in the very last chunk of the judgment" : `Paragraph ${i} of the judgment.`, page: Math.floor(i / 10) + 1 }));
    const deps = { ...serverFilingDeps({ store: fakeCorpus(chunks, null) }), citecheck, citator: undefined };
    const j = await deps.corpusJudgment!("2024 INSC 735");
    expect(j).toMatchObject({ id: "sc:2024_735", complete: false });
    const r = await runFilingCheck(docOf(para("In 2024 INSC 735 the Court said “the quoted words appear only in the very last chunk of the judgment”.")), "h", deps);
    expect(r.citations[0].quotes[0].state).toBe("text_incomplete");
    expect(r.counts).toMatchObject({ quotesNotFound: 0, quotesUnchecked: 1 });
    expect(r.issues.some((i) => i.kind === "quote_not_found")).toBe(false);
    expect(r.issues.find((i) => i.kind === "quote_unchecked")?.message).toMatch(/only part of the judgment text was read/);
  });

  it("does not call a quote across a page break 'not found', and reports a missing chunk as partial text", async () => {
    resetTextTableCacheForTests();
    const doc = docOf(para(`In 2024 INSC 735 the Court said “${crossing}”.`));
    const pages = [{ index: 0, text: "The court held that a contract without consideration", page: 4 }, { index: 1, text: "is void ab initio and cannot be enforced.", page: 5 }];
    const whole = await runFilingCheck(doc, "h", { ...serverFilingDeps({ store: fakeCorpus(pages, 2) }), citecheck, citator: undefined });
    expect(whole.citations[0]).toMatchObject({ state: "resolved", resolvedBy: "official_corpus" });
    expect(whole.citations[0].quotes[0].state).toBe("found");
    // The corpus records 3 chunks but only 2 are stored: a quote missing from them is unchecked, not "not found".
    const missing = await runFilingCheck(docOf(para("In 2024 INSC 735 the Court said “words that may be in the chunk that is missing from the store”.")), "h", { ...serverFilingDeps({ store: fakeCorpus(pages, 3) }), citecheck, citator: undefined });
    expect(missing.citations[0].quotes[0].state).toBe("text_incomplete");
    // Against the whole text, a quote that is not there is "not found".
    const absent = await runFilingCheck(docOf(para("In 2024 INSC 735 the Court said “words that appear nowhere in this short judgment text”.")), "h", { ...serverFilingDeps({ store: fakeCorpus(pages, 2) }), citecheck, citator: undefined });
    expect(absent.citations[0].quotes[0].state).toBe("not_found");
    expect(absent.issues.find((i) => i.kind === "quote_not_found")?.message).toMatch(/^Quoted words not found in the full judgment text/);
  });
});
