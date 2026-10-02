import { beforeAll, describe, expect, it } from "vitest";
import JSZip from "jszip";
import { db, resetSqlite } from "@/lib/db";
import type { EditProposal } from "@/modules/office/shared/types";
import type { OfficeAgentContext } from "@/modules/office/shared/route-factory";
import { markdownToDoc } from "@/modules/office/shared/markdown-doc";
import { collectTrackedChanges, docStats, docToMarkdown, docToPlainText, ensureBlockIds, findCitations, findPlaceholders, flattenBlocks, inlineFromMarkdown, markdownToBlocks, replaceInInline, markInInline, type PMNode } from "@/modules/office/word/doc-model";
import { buildSnapshot, parseSnapshot, renderSnapshot, sectionBlocks } from "@/modules/office/word/snapshot";
import { wordAgentTools } from "@/modules/office/word/agent-tools";
import { acceptAllChanges, buildTrackedInline, rejectAllChanges } from "@/modules/office/word/tracked-diff";
import { exportDocx, imageDimensions } from "@/modules/office/word/export";
import { htmlToDoc } from "@/modules/office/word/html-import";
import { importDocument } from "@/modules/office/word/import";
import { WORD_TEMPLATES, buildDoc } from "@/modules/office/word/templates";
import { seedWord } from "@/modules/office/word/seed";
import { captionBlock, signatureBlock, tableOfContents } from "@/modules/office/word/sections";
import { wordInstructions } from "@/modules/office/word/agent";

beforeAll(() => { resetSqlite(); });

const SAMPLE_MD = `# Motion for Summary Judgment

Defendant moves for summary judgment under Rule 56.

## Legal standard

Summary judgment is appropriate where there is no genuine dispute. See Celotex Corp. v. Catrett, 477 U.S. 317, 322 (1986). [VERIFY]

## Argument

- Product identification is an element.
- Plaintiffs have no evidence.

| Supplier | Years |
| --- | --- |
| Acme | 1990–1994 |
`;

function sampleDoc(): PMNode { return ensureBlockIds(markdownToDoc(SAMPLE_MD)); }

function makeCtx(doc: PMNode, overrides: Partial<OfficeAgentContext<ReturnType<typeof buildSnapshot>>> = {}) {
  const proposals: EditProposal[] = [];
  const snapshot = buildSnapshot(doc, { title: "Test doc", trackChangesOn: true });
  const ctx: OfficeAgentContext<typeof snapshot> = {
    mode: "draft", scope: null, research: false, snapshot, matter: null, docTitle: "Test doc", context: {}, proposals, findings: [],
    emit: () => {},
    propose: (p) => { const full: EditProposal = { id: `p${proposals.length + 1}`, status: "pending", ...p }; proposals.push(full); return full; },
    finding: (f) => ({ id: "f", ...f }),
    ...overrides,
  };
  return { ctx, proposals, snapshot };
}

function tool(tools: ReturnType<typeof wordAgentTools>, name: string) {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return (args: Record<string, unknown>) => (t.execute as (a: unknown, c: unknown) => unknown)(args, { emit: () => {}, state: {} });
}

describe("block ids", () => {
  it("assigns missing and duplicate ids to every block node", () => {
    const doc: PMNode = { type: "doc", content: [
      { type: "paragraph", content: [{ type: "text", text: "a" }] },
      { type: "paragraph", attrs: { id: "dup00001" }, content: [{ type: "text", text: "b" }] },
      { type: "paragraph", attrs: { id: "dup00001" }, content: [{ type: "text", text: "c" }] },
      { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "d" }] }] }] },
      { type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", content: [{ type: "paragraph" }] }] }] },
    ] };
    const out = ensureBlockIds(doc);
    const ids: string[] = [];
    const walk = (n: PMNode) => { if (n.attrs?.id) ids.push(String(n.attrs.id)); for (const c of n.content ?? []) walk(c); };
    walk(out);
    expect(ids.length).toBe(10);
    expect(new Set(ids).size).toBe(10);
    expect(ids).toContain("dup00001");
    expect(ids.every((id) => /^[A-Za-z0-9_-]{8}$/.test(id))).toBe(true);
    // original untouched
    expect(doc.content![0].attrs).toBeUndefined();
  });
  it("markdown-doc output opens with ids on every block", () => {
    const doc = sampleDoc();
    const { blocks } = flattenBlocks(doc);
    expect(blocks.every((b) => b.id.length === 8)).toBe(true);
  });
});

describe("snapshot builder", () => {
  it("flattens blocks with ¶ indices, sections, list and table context", () => {
    const s = buildSnapshot(sampleDoc(), { title: "Motion", trackChangesOn: false });
    expect(s.blocks[0]).toMatchObject({ index: 1, type: "heading", level: 1, text: "Motion for Summary Judgment" });
    expect(s.sections.map((x) => x.title)).toEqual(["Motion for Summary Judgment", "Legal standard", "Argument"]);
    const bullets = s.blocks.filter((b) => b.listInfo);
    expect(bullets.length).toBe(2);
    expect(bullets[0].listInfo).toMatchObject({ kind: "bullet", depth: 1, position: 1 });
    const cells = s.blocks.filter((b) => b.table);
    expect(cells.length).toBe(4);
    expect(cells[0].table).toMatchObject({ row: 1, col: 1, header: true });
    expect(s.stats.words).toBeGreaterThan(20);
    expect(s.stats.tables).toBe(1);
    const legal = s.sections[1];
    expect(sectionBlocks(s, legal.id).map((b) => b.text)[1]).toContain("Summary judgment is appropriate");
  });
  it("renders a compact numbered listing with ids and respects the budget", () => {
    const s = buildSnapshot(sampleDoc(), { title: "Motion", trackChangesOn: true });
    const text = renderSnapshot(s, null);
    expect(text).toMatch(/¶1 \[id:[A-Za-z0-9_-]{8}\] \(Heading 1\) Motion for Summary Judgment/);
    expect(text).toContain("Track changes: ON");
    const long = ensureBlockIds(markdownToDoc(Array.from({ length: 400 }, (_, i) => `## Section ${i}\n\n${"Lorem word ".repeat(60)}`).join("\n\n")));
    const ls = buildSnapshot(long, { title: "Long" });
    const rendered = renderSnapshot(ls, { id: `section:${ls.sections[5].id}`, label: "This section", kind: "section", ref: ls.sections[5].id });
    expect(rendered.length).toBeLessThan(40_000);
    expect(rendered).toContain("truncated outside scope");
  });
  it("round-trips through parseSnapshot", () => {
    const s = buildSnapshot(sampleDoc(), { title: "Motion" });
    const parsed = parseSnapshot(JSON.parse(JSON.stringify(s)));
    expect(parsed.blocks.length).toBe(s.blocks.length);
    expect(() => parseSnapshot({ blocks: [{ text: "x" }] })).toThrow();
  });
});

describe("agent tools", () => {
  it("rewrite_paragraph proposes with old → new and mutates the snapshot", async () => {
    const { ctx, proposals, snapshot } = makeCtx(sampleDoc());
    const tools = wordAgentTools(ctx);
    const target = snapshot.blocks.find((b) => b.text.startsWith("Defendant moves"))!;
    const res = (await tool(tools, "rewrite_paragraph")({ id: target.id, markdown: "Defendant **respectfully** moves for summary judgment under Fed. R. Civ. P. 56(a)." })) as { new_text: string };
    expect(res.new_text).toBe("Defendant respectfully moves for summary judgment under Fed. R. Civ. P. 56(a).");
    expect(proposals[0]).toMatchObject({ kind: "rewrite_paragraph", target: target.id, targetLabel: `¶${target.index}` });
    expect(proposals[0].summary).toContain("− Defendant moves");
    expect(proposals[0].summary).toContain("+ Defendant respectfully");
    const after = (await tool(tools, "get_paragraphs")({ ids: [target.id] })) as { blocks: { text: string }[] };
    expect(after.blocks[0].text).toContain("respectfully");
  });
  it("insert_after adds multiple blocks with new ids and reindexes", async () => {
    const { ctx, proposals, snapshot } = makeCtx(sampleDoc());
    const tools = wordAgentTools(ctx);
    const heading = snapshot.blocks[0];
    const before = snapshot.blocks.length;
    const res = (await tool(tools, "insert_after")({ id: heading.id, markdown: "## Introduction\n\nThis motion presents a narrow question.\n\n- one\n- two" })) as { inserted: { id: string; index: number }[] };
    expect(res.inserted.length).toBe(4);
    expect(snapshot.blocks.length).toBe(before + 4);
    expect(snapshot.blocks[1].type).toBe("heading");
    expect(snapshot.blocks[1].index).toBe(2);
    expect(snapshot.sections[1].title).toBe("Introduction");
    const payload = proposals[0].payload as { blocks: PMNode[]; blockIds: string[] };
    expect(payload.blocks[0].type).toBe("heading");
    expect(payload.blockIds).toEqual(res.inserted.map((b) => b.id));
  });
  it("find_replace previews, then applies with the confirmed count and updates snapshot text", async () => {
    const { ctx, proposals } = makeCtx(sampleDoc());
    const tools = wordAgentTools(ctx);
    const pre = (await tool(tools, "find_replace")({ find: "summary judgment", replace: "SUMMARY JUDGMENT", preview: true })) as { count: number };
    expect(pre.count).toBe(3);
    expect(proposals.length).toBe(0);
    const res = (await tool(tools, "find_replace")({ find: "summary judgment", replace: "SUMMARY JUDGMENT", expected_count: pre.count })) as { count: number };
    expect(res.count).toBe(3);
    expect(proposals[0].kind).toBe("find_replace_all");
    const found = (await tool(tools, "find_text")({ query: "SUMMARY JUDGMENT", case_sensitive: true })) as { count: number };
    expect(found.count).toBe(3);
  });
  it("set_style updates block type in snapshot; delete removes; move reorders", async () => {
    const { ctx, snapshot } = makeCtx(sampleDoc());
    const tools = wordAgentTools(ctx);
    const p = snapshot.blocks.find((b) => b.text.startsWith("Defendant moves"))!;
    await tool(tools, "apply_style")({ id: p.id, style: "heading2" });
    expect(snapshot.blocks.find((b) => b.id === p.id)).toMatchObject({ type: "heading", level: 2 });
    expect(snapshot.sections.some((s) => s.id === p.id)).toBe(true);
    const n = snapshot.blocks.length;
    await tool(tools, "delete_paragraph")({ id: p.id });
    expect(snapshot.blocks.length).toBe(n - 1);
    const last = snapshot.blocks[snapshot.blocks.length - 1];
    await tool(tools, "move_block")({ id: last.id, after_id: "start" });
    expect(snapshot.blocks[0].id).toBe(last.id);
    expect(snapshot.blocks[0].index).toBe(1);
  });
  it("structural inserts (table, toc, template section, page break, footnote, comment)", async () => {
    const { ctx, proposals, snapshot } = makeCtx(sampleDoc());
    const tools = wordAgentTools(ctx);
    const p = snapshot.blocks.find((b) => b.text.startsWith("Defendant moves"))!;
    await tool(tools, "insert_table")({ id: p.id, header: ["Date", "Event"], rows: [["2026-01-01", "Filed"]], caption: "Table 1" });
    expect(snapshot.blocks.filter((b) => b.table).length).toBe(4 + 4);
    await tool(tools, "insert_toc")({ id: snapshot.blocks[0].id });
    expect(snapshot.blocks[1].text).toBe("TABLE OF CONTENTS");
    await tool(tools, "apply_template_section")({ id: snapshot.blocks[snapshot.blocks.length - 1].id, template_section: "signature_block" });
    expect(snapshot.blocks.some((b) => b.text.includes("Respectfully submitted"))).toBe(true);
    await tool(tools, "insert_page_break_after")({ id: snapshot.blocks[0].id });
    expect(snapshot.blocks[1].type).toBe("pageBreak");
    await tool(tools, "insert_footnote")({ id: p.id, anchor_text: "Rule 56", footnote_text: "Fed. R. Civ. P. 56(a)." });
    await tool(tools, "insert_comment")({ id: p.id, text: "Check this", quote: "Rule 56" });
    expect(snapshot.comments?.length).toBe(1);
    const kinds = proposals.map((x) => x.kind);
    expect(kinds).toEqual(["insert_table_after", "insert_toc_after", "apply_template_section", "insert_page_break_after", "insert_footnote", "add_comment"]);
  });
  it("fix_citations flags placeholders and unverified citations", async () => {
    const { ctx, proposals } = makeCtx(sampleDoc());
    const tools = wordAgentTools(ctx);
    const res = (await tool(tools, "fix_citations")({})) as { citations_found: string[]; placeholders: string[]; flagged: number };
    expect(res.citations_found[0]).toContain("477 U.S. 317");
    expect(res.placeholders).toContain("[VERIFY]");
    expect(res.flagged).toBeGreaterThanOrEqual(2);
    expect(proposals.every((p) => p.kind === "add_comment")).toBe(true);
  });
  it("ask mode exposes only read tools", () => {
    const { ctx } = makeCtx(sampleDoc(), { mode: "ask" });
    const names = wordAgentTools(ctx).map((t) => t.name);
    expect(names).toContain("get_outline");
    expect(names).not.toContain("rewrite_paragraph");
    expect(names).not.toContain("polish_section");
  });
  it("polish_section uses the injected model and proposes rewrites per changed paragraph", async () => {
    const { ctx, proposals, snapshot } = makeCtx(sampleDoc());
    const tools = wordAgentTools(ctx, { polishParagraphs: async (ps) => ps.map((p) => ({ id: p.id, markdown: p.text.replace("appropriate", "warranted"), note: "tightened" })) });
    const res = (await tool(tools, "polish_section")({ heading_id: snapshot.sections[1].id, goals: ["tighten"] })) as { proposals: number };
    expect(res.proposals).toBe(1);
    expect(proposals[0].title).toMatch(/^Polish ¶/);
  });
  it("instructions mention key conventions and stay stable across turns (cacheable prefix)", () => {
    const { ctx, snapshot } = makeCtx(sampleDoc());
    const text = wordInstructions(ctx);
    expect(text).toContain("[VERIFY]");
    expect(text).toContain("replace_text_in_paragraph");
    expect(wordInstructions(makeCtx(ensureBlockIds(markdownToDoc("# Other\n\nDifferent document."))).ctx)).toBe(text);
    // volatile state lives in the snapshot, not in the instructions
    expect(renderSnapshot(snapshot, null)).toContain("Track changes: ON");
  });
});

describe("tracked-change diff builder", () => {
  const change = { id: "c1", author: "Drafting assistant", date: "2026-09-23T00:00:00Z" };
  it("marks removed words as deletions and added words as insertions, keeping marks on unchanged text", () => {
    const old = [{ type: "text", text: "The " }, { type: "text", text: "quick", marks: [{ type: "bold" }] }, { type: "text", text: " brown fox jumps." }];
    const next = inlineFromMarkdown("The quick red fox leaps.");
    const out = buildTrackedInline(old, next, { change });
    const text = out.map((n) => n.text).join("");
    expect(text).toBe("The quick brownred fox jumpsleaps.");
    const bold = out.find((n) => n.text === "quick");
    expect(bold?.marks?.some((m) => m.type === "bold")).toBe(true);
    const del = out.filter((n) => n.marks?.some((m) => m.type === "deletion")).map((n) => n.text).join("");
    const ins = out.filter((n) => n.marks?.some((m) => m.type === "insertion")).map((n) => n.text).join("");
    expect(del).toBe("brownjumps");
    expect(ins).toBe("redleaps");
    // accept/reject
    const doc: PMNode = { type: "doc", content: [{ type: "paragraph", attrs: { id: "p1" }, content: out }] };
    expect(docToPlainText(acceptAllChanges(doc))).toBe("The quick red fox leaps.");
    expect(docToPlainText(rejectAllChanges(doc))).toBe("The quick brown fox jumps.");
    const changes = collectTrackedChanges(doc);
    expect(changes.length).toBe(1);
    expect(changes[0]).toMatchObject({ kind: "replacement", deletedText: "brownjumps", insertedText: "redleaps" });
  });
  it("returns new content untouched when tracking is off", () => {
    const out = buildTrackedInline([{ type: "text", text: "a b" }], [{ type: "text", text: "a c" }], { change, track: false });
    expect(out).toEqual([{ type: "text", text: "a c" }]);
  });
});

describe("inline find/replace/mark helpers", () => {
  it("replaceInInline preserves marks and counts", () => {
    const content = [{ type: "text", text: "Meridian " }, { type: "text", text: "Fine Chemicals", marks: [{ type: "bold" }] }, { type: "text", text: " and Meridian Corp." }];
    const r = replaceInInline(content, "Meridian", "MFC", { wholeWord: true, caseSensitive: true });
    expect(r.count).toBe(2);
    expect(r.content.map((n) => n.text).join("")).toBe("MFC Fine Chemicals and MFC Corp.");
    expect(r.content.find((n) => n.text === "Fine Chemicals")?.marks?.[0].type).toBe("bold");
    const m = markInInline(content, "Fine Chemicals", [{ type: "italic" }]);
    expect(m.count).toBe(1);
    expect(m.content.find((n) => n.text === "Fine Chemicals")?.marks?.map((x) => x.type).sort()).toEqual(["bold", "italic"]);
  });
  it("citation and placeholder detection", () => {
    const text = "See Celotex Corp. v. Catrett, 477 U.S. 317, 322 (1986); 15 U.S.C. § 2607(e); 40 C.F.R. § 720.3; Fed. R. Civ. P. 56(a). [VERIFY] [CLIENT NAME]";
    const cites = findCitations(text);
    expect(cites.some((c) => c.startsWith("477 U.S. 317"))).toBe(true);
    expect(cites.some((c) => c.includes("2607"))).toBe(true);
    expect(cites.some((c) => c.startsWith("Fed. R. Civ. P. 56"))).toBe(true);
    expect(findPlaceholders(text)).toEqual(["[VERIFY]", "[CLIENT NAME]"]);
  });
});

describe("markdown → blocks and serializers", () => {
  it("converts headings, lists, tables, quotes and inline marks with ids", () => {
    const blocks = markdownToBlocks("## Heading\n\nPara with **bold** and *italic* and [link](https://x.y).\n\n1. first\n2. second\n\n> quoted\n\n| a | b |\n| --- | --- |\n| 1 | 2 |");
    expect(blocks.map((b) => b.type)).toEqual(["heading", "paragraph", "orderedList", "blockquote", "table"]);
    expect(blocks.every((b) => typeof b.attrs?.id === "string")).toBe(true);
    const para = blocks[1];
    expect(para.content?.find((n) => n.text === "bold")?.marks?.[0].type).toBe("bold");
    expect(para.content?.find((n) => n.text === "link")?.marks?.[0].attrs?.href).toBe("https://x.y");
    const md = docToMarkdown({ type: "doc", content: blocks });
    expect(md).toContain("## Heading");
    expect(md).toContain("**bold**");
    expect(md).toContain("| a | b |");
    expect(md).toContain("1. first");
  });
  it("docStats counts words and structures", () => {
    const s = docStats(sampleDoc());
    expect(s.headings).toBe(3);
    expect(s.tables).toBe(1);
    expect(s.lists).toBe(1);
    expect(s.words).toBeGreaterThan(20);
  });
});

describe("HTML import", () => {
  it("converts mammoth-style HTML into blocks with ids", () => {
    const html = `<h1>Title</h1><p>Hello <strong>bold</strong> and <em>it</em> <a href="https://a.b">link</a>.<br/>next line</p><ul><li>one<ul><li>nested</li></ul></li><li><p>two</p></li></ul><ol start="3"><li>three</li></ol><blockquote><p>quote</p></blockquote><table><tr><th>H</th><th>I</th></tr><tr><td>1</td><td>2 &amp; 3</td></tr></table><img src="/api/blobs/x" alt="Fig"/><hr><pre>code &lt;x&gt;</pre>`;
    const doc = htmlToDoc(html);
    const types = (doc.content ?? []).map((b) => b.type);
    expect(types).toEqual(["heading", "paragraph", "bulletList", "orderedList", "blockquote", "table", "image", "horizontalRule", "codeBlock"]);
    const p = doc.content![1];
    expect(p.content?.find((n) => n.text === "bold")?.marks?.[0].type).toBe("bold");
    expect(p.content?.some((n) => n.type === "hardBreak")).toBe(true);
    const ul = doc.content![2];
    expect(ul.content![0].content![1].type).toBe("bulletList");
    expect(doc.content![3].attrs?.start).toBe(3);
    const table = doc.content![5];
    expect(table.content![0].content![0].type).toBe("tableHeader");
    expect(docToPlainText({ type: "doc", content: [table] })).toContain("2 & 3");
    expect(doc.content![8].content?.[0].text).toBe("code <x>");
    const { blocks } = flattenBlocks(doc);
    expect(blocks.every((b) => b.id.length === 8)).toBe(true);
  });
  it("importDocument handles markdown and html files", async () => {
    const md = await importDocument(new TextEncoder().encode("# Memo\n\nBody text."), "research-memo.md");
    expect(md.title).toBe("research memo");
    expect((md.content as PMNode).content?.[0].type).toBe("heading");
    const html = await importDocument(new TextEncoder().encode("<p>Hi</p>"), "note.html");
    expect((html.content as PMNode).content?.[0].type).toBe("paragraph");
  });
});

describe("templates", () => {
  it("has at least 10 templates producing docs with ids", () => {
    expect(WORD_TEMPLATES.length).toBeGreaterThanOrEqual(10);
    for (const t of WORD_TEMPLATES) {
      const doc = t.build({ matterId: "m_valsara_arb" }) as PMNode;
      expect(doc.type).toBe("doc");
      const { blocks } = flattenBlocks(doc);
      expect(blocks.every((b) => b.id.length === 8)).toBe(true);
    }
    const motion = WORD_TEMPLATES.find((t) => t.id === "word-motion-brief")!.build({ matterId: "m_depo_provera_3140" }) as PMNode;
    const text = docToPlainText(motion);
    for (const h of ["INTRODUCTION", "FACTUAL BACKGROUND", "LEGAL STANDARD", "ARGUMENT", "CONCLUSION", "CERTIFICATE OF SERVICE", "Respectfully submitted"]) expect(text).toContain(h);
    expect(text).toContain("NORTHERN DISTRICT OF FLORIDA");
    expect(motion.content?.some((b) => b.type === "pageBreak")).toBe(true);
  });
  it("buildDoc directives set attrs", () => {
    const doc = buildDoc(["@center **X**", "@legal 1. a\n2. b", "@pagebreak"]);
    expect(doc.content![0].attrs?.textAlign).toBe("center");
    expect(doc.content![1].attrs?.listStyle).toBe("legal");
    expect(doc.content![2].type).toBe("pageBreak");
    expect(captionBlock({ court: "COURT", plaintiff: "A", defendant: "B", caseNo: "1", documentTitle: "T" }).some((b) => b.type === "table")).toBe(true);
    expect(signatureBlock().length).toBeGreaterThan(5);
    expect(tableOfContents([{ id: "h1", title: "Intro", level: 1, index: 1, wordCount: 0, blockCount: 0, start: 1, end: 1 }])[1].attrs?.tocRef).toBe("h1");
  });
});

describe("DOCX export", () => {
  it("exports a seeded document to a valid zip with document.xml containing the text", async () => {
    const d = db();
    seedWord(d);
    const doc = d.officeDocs.get("wd_depo_motion_brief");
    expect(doc).toBeTruthy();
    const comments = d.officeComments.find((c) => c.docId === "wd_depo_motion_brief");
    expect(comments.length).toBeGreaterThanOrEqual(2);
    const buf = await exportDocx(doc!.content as PMNode, { title: doc!.title, comments, settings: { pageSize: "letter", margins: "court", lineSpacing: 2 } });
    expect(buf.byteLength).toBeGreaterThan(5000);
    const zip = await JSZip.loadAsync(buf);
    const xml = await zip.file("word/document.xml")!.async("string");
    expect(xml).toContain("INTRODUCTION");
    expect(xml).toContain("LEGAL STANDARD");
    expect(xml).toContain("<w:ins ");
    expect(xml).toContain("<w:del ");
    expect(xml).toContain("w:commentRangeStart");
    expect(xml).toContain("<w:br w:type=\"page\"/>");
    expect(zip.file("word/comments.xml")).toBeTruthy();
    expect(zip.file("word/numbering.xml")).toBeTruthy();
    const numbering = await zip.file("word/numbering.xml")!.async("string");
    expect(numbering).toContain("%1.%2");
  });
  it("exports footnotes, images and tables", async () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 2, 0, 0, 0, 3, 8, 6, 0, 0, 0, 0, 0, 0, 0]);
    expect(imageDimensions(png)).toEqual({ type: "png", width: 2, height: 3 });
    const doc: PMNode = ensureBlockIds({ type: "doc", content: [
      { type: "paragraph", content: [{ type: "text", text: "Anchor", marks: [{ type: "footnote", attrs: { id: "f1", text: "Footnote body here." } }] }, { type: "text", text: " tail" }] },
      { type: "image", attrs: { src: "/api/blobs/abc", alt: "Pic", width: 200 } },
      markdownToBlocks("| a | b |\n| --- | --- |\n| 1 | 2 |")[0],
      { type: "orderedList", attrs: { listStyle: "legal" }, content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "item" }] }] }] },
    ] });
    const buf = await exportDocx(doc, { title: "T", fetchImage: async () => ({ bytes: png, type: "png", width: 2, height: 3 }) });
    const zip = await JSZip.loadAsync(buf);
    const xml = await zip.file("word/document.xml")!.async("string");
    expect(xml).toContain("w:footnoteReference");
    expect(xml).toContain("<w:tbl>");
    expect(xml).toContain("<w:drawing>");
    expect(await zip.file("word/footnotes.xml")!.async("string")).toContain("Footnote body here.");
  });
});

describe("seed", () => {
  it("creates ≥ 8 documents with versions, comments and library items, idempotently", () => {
    const d = db();
    seedWord(d);
    seedWord(d);
    const docs = d.officeDocs.find((x) => x.kind === "word" && x.id.startsWith("wd_"));
    expect(docs.length).toBeGreaterThanOrEqual(8);
    for (const doc of docs) {
      const versions = d.officeVersions.find((v) => v.docId === doc.id);
      expect(versions.length).toBeGreaterThanOrEqual(2);
      expect(d.library.find((l) => l.officeDocId === doc.id).length).toBe(1);
      expect(flattenBlocks(doc.content as PMNode).blocks.length).toBeGreaterThan(10);
    }
    const motion = d.officeDocs.get("wd_depo_motion_brief")!;
    expect(d.officeVersions.find((v) => v.docId === motion.id).some((v) => v.summary?.startsWith("Agent edit:"))).toBe(true);
    expect(d.officeComments.find((c) => c.docId === motion.id).some((c) => c.body.startsWith("Placeholder case citations"))).toBe(true);
    expect(collectTrackedChanges(motion.content as PMNode).length).toBeGreaterThan(0);
  });
});
