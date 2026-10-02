import { describe, expect, it } from "vitest";
import type { EditProposal } from "@/modules/office/shared/types";
import type { OfficeAgentContext } from "@/modules/office/shared/route-factory";
import { markdownToDoc } from "@/modules/office/shared/markdown-doc";
import { toStrictSchema } from "@/lib/ai/tools";
import type { Matter } from "@/lib/types/domain";
import type { Principal } from "@/lib/auth/types";
import { blockHash, ensureBlockIds, inlineFromMarkdown, type PMNode } from "@/modules/office/word/doc-model";
import { buildSnapshot, renderSnapshot, type WordSnapshot } from "@/modules/office/word/snapshot";
import { WORD_TOOL_ACCESS, wordAgentTools, wordToolAllowed } from "@/modules/office/word/agent-tools";
import { checkCitations, checkDefinedTerms, computeRedline } from "@/modules/office/word/agent-checks";
import { checkFreshness } from "@/modules/office/word/proposal-freshness";
import { buildTrackedInline } from "@/modules/office/word/tracked-diff";
import { classifyWordRequest, routeWordRequest } from "@/modules/office/word/agent";

const DOC_MD = `# Supply Agreement

This Supply Agreement (the "Agreement") is entered into by Acme Corp. (the "Company") and Beta LLC (the "Supplier").

"Products" means the MF-3 finish concentrates listed in Schedule A.

The Company shall purchase the Products. The Effective Date is the date the Company signs. The Effective Date controls the term.

The agreement terminates after five years. See Celotex Corp. v. Catrett, 477 U.S. 317, 322 (1986); Anderson v. Liberty Lobby, Inc., 477 U.S. 242, 200; Smith vs. Jones, 12 F. 3d 45 (2020).

"Confidential Information" means non-public information.

1. First obligation
2. Second obligation

Governing law is FRCP 56 and 28 U.S.C.§1332. id. at 5.
`;

function makeCtx(mode: "draft" | "review" | "ask" = "draft", md = DOC_MD, matter: Matter | null = null, principal: Principal | null = null) {
  const doc = ensureBlockIds(markdownToDoc(md));
  const proposals: EditProposal[] = [];
  const snapshot = buildSnapshot(doc, { title: "Supply Agreement", trackChangesOn: false });
  const ctx: OfficeAgentContext<WordSnapshot> = {
    mode, scope: null, research: false, snapshot, matter, principal, docTitle: "Supply Agreement", context: {}, proposals, findings: [],
    emit: () => {},
    propose: (p) => { const full: EditProposal = { id: `p${proposals.length + 1}`, status: "pending", ...p }; proposals.push(full); return full; },
    finding: (f) => ({ id: "f", ...f }),
  };
  return { ctx, proposals, snapshot, doc };
}

async function run(tools: ReturnType<typeof wordAgentTools>, name: string, args: Record<string, unknown>) {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return (t.execute as (a: unknown, c: unknown) => unknown)(args, { emit: () => {}, state: {} });
}

const block = (s: WordSnapshot, starts: string) => s.blocks.find((b) => b.text.startsWith(starts))!;

describe("tool contracts", () => {
  it("every tool has a unique name, an access class, a described object schema that converts to strict mode, and valid examples", () => {
    const { ctx } = makeCtx("draft");
    const tools = wordAgentTools(ctx);
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.sort()).toEqual(Object.keys(WORD_TOOL_ACCESS).sort());
    for (const t of tools) {
      expect(t.description.length, t.name).toBeGreaterThan(20);
      const params = t.parameters as { type: string; properties: Record<string, unknown>; required: string[] };
      expect(params.type).toBe("object");
      for (const r of params.required) expect(Object.keys(params.properties), `${t.name}.${r}`).toContain(r);
      const strict = toStrictSchema(t.parameters) as { additionalProperties: boolean; required: string[] };
      expect(strict.additionalProperties).toBe(false);
      expect(strict.required.sort()).toEqual(Object.keys(params.properties).sort());
      for (const ex of t.examples ?? []) for (const k of Object.keys(ex)) expect(Object.keys(params.properties), `${t.name} example key ${k}`).toContain(k);
    }
    // Tool definitions do not depend on the document or matter (stable, cacheable tool prefix).
    const other = wordAgentTools(makeCtx("draft", "# Other\n\nText.").ctx);
    expect(JSON.stringify(other.map((t) => [t.name, t.description, t.parameters]))).toBe(JSON.stringify(tools.map((t) => [t.name, t.description, t.parameters])));
  });

  it("Ask mode exposes no edit tools at all; Review exposes reads plus suggestion tools only", () => {
    const ask = wordAgentTools(makeCtx("ask").ctx).map((t) => t.name);
    expect(ask.length).toBeGreaterThan(8);
    expect(ask.every((n) => WORD_TOOL_ACCESS[n] === "read")).toBe(true);
    for (const n of ["rewrite_paragraph", "find_replace", "insert_comment", "apply_style", "delete_paragraph", "accept_reject_changes", "set_page_setup"]) expect(ask).not.toContain(n);
    const review = wordAgentTools(makeCtx("review").ctx).map((t) => t.name);
    expect(review).toContain("insert_comment");
    expect(review).toContain("rewrite_paragraph");
    expect(review).not.toContain("apply_style");
    expect(review).not.toContain("set_page_setup");
    expect(review).not.toContain("accept_reject_changes");
    expect(wordToolAllowed("merge_cells", "review")).toBe(false);
  });

  it("Review-mode suggestions are forced to tracked changes", async () => {
    const { ctx, proposals, snapshot } = makeCtx("review");
    await run(wordAgentTools(ctx), "replace_text_in_paragraph", { id: block(snapshot, "The agreement terminates").id, find: "five", replace: "seven" });
    expect(proposals[0].payload.forceTrack).toBe(true);
  });
});

describe("stale proposal detection", () => {
  it("proposals carry the base version and the target block hash as read", async () => {
    const { ctx, proposals, snapshot } = makeCtx();
    const target = block(snapshot, "The agreement terminates");
    const before = blockHash({ type: target.type, text: target.text });
    await run(wordAgentTools(ctx), "rewrite_paragraph", { id: target.id, markdown: "The Agreement terminates after seven years." });
    const base = proposals[0].payload.base as { version: string; blocks: Record<string, string> };
    expect(base.version).toBe(snapshot.version);
    expect(base.blocks[target.id]).toBe(before);
  });

  it("rejects a rewrite whose paragraph the user changed, rebases phrase edits whose phrase survived", async () => {
    const { ctx, proposals, snapshot } = makeCtx();
    const tools = wordAgentTools(ctx);
    const target = block(snapshot, "The agreement terminates");
    const original = target.text;
    await run(tools, "rewrite_paragraph", { id: target.id, markdown: "The Agreement terminates after seven years." });
    const rewrite = proposals[0];
    // Unchanged live document → fresh.
    expect(checkFreshness(rewrite.kind, rewrite.payload, () => ({ type: "paragraph", text: original })).status).toBe("fresh");
    // The user edited the paragraph after the agent read it → stale.
    const edited = { type: "paragraph", text: `${original} Added by the user.` };
    expect(checkFreshness(rewrite.kind, rewrite.payload, () => edited)).toMatchObject({ status: "stale" });
    // Deleted paragraph → stale.
    expect(checkFreshness(rewrite.kind, rewrite.payload, () => null)).toMatchObject({ status: "stale" });
    // Phrase replacement: phrase still present in the changed paragraph → rebased; phrase gone → stale.
    const fresh = makeCtx();
    const t2 = block(fresh.snapshot, "The agreement terminates");
    const t2Original = t2.text;
    await run(wordAgentTools(fresh.ctx), "replace_text_in_paragraph", { id: t2.id, find: "five years", replace: "seven years" });
    const rep = fresh.proposals[0];
    expect(checkFreshness(rep.kind, rep.payload, () => ({ type: "paragraph", text: `Preface. ${t2Original}` }))).toMatchObject({ status: "rebased" });
    expect(checkFreshness(rep.kind, rep.payload, () => ({ type: "paragraph", text: "The agreement terminates after ten years." }))).toMatchObject({ status: "stale" });
    // Deleting a paragraph that changed is never rebased.
    const del = makeCtx();
    const t3 = block(del.snapshot, "The agreement terminates");
    await run(wordAgentTools(del.ctx), "delete_paragraph", { id: t3.id });
    expect(checkFreshness("delete_paragraph", del.proposals[0].payload, () => ({ type: "paragraph", text: "changed" }))).toMatchObject({ status: "stale" });
  });

  it("chained proposals in one turn stay fresh when applied in order", async () => {
    const { ctx, proposals, snapshot } = makeCtx();
    const tools = wordAgentTools(ctx);
    const t = block(snapshot, "The agreement terminates");
    await run(tools, "replace_text_in_paragraph", { id: t.id, find: "five", replace: "seven" });
    await run(tools, "replace_text_in_paragraph", { id: t.id, find: "agreement", replace: "Agreement", case_sensitive: true });
    const afterFirst = t.text.replace("Agreement", "agreement");
    expect(checkFreshness(proposals[1].kind, proposals[1].payload, () => ({ type: "paragraph", text: afterFirst })).status).toBe("fresh");
  });
});

describe("find_replace preview-first contract", () => {
  it("preview counts without proposing; apply requires the matching expected_count", async () => {
    const { ctx, proposals } = makeCtx();
    const tools = wordAgentTools(ctx);
    const pre = (await run(tools, "find_replace", { find: "Company", replace: "Buyer", whole_word: true, case_sensitive: true, preview: true })) as { count: number; samples: { after: string }[] };
    expect(pre.count).toBe(3);
    expect(pre.samples[0].after).toContain("Buyer");
    expect(proposals.length).toBe(0);
    await expect(run(tools, "find_replace", { find: "Company", replace: "Buyer", whole_word: true, case_sensitive: true })).rejects.toThrow(/Preview first/);
    await expect(run(tools, "find_replace", { find: "Company", replace: "Buyer", whole_word: true, case_sensitive: true, expected_count: 2 })).rejects.toThrow(/does not match/);
    const res = (await run(tools, "find_replace", { find: "Company", replace: "Buyer", whole_word: true, case_sensitive: true, expected_count: 3 })) as { count: number };
    expect(res.count).toBe(3);
    expect(proposals[0].kind).toBe("find_replace_all");
    const regex = (await run(tools, "find_replace", { find: "\\d+ U\\.S\\. \\d+", replace: "X", regex: true, preview: true })) as { count: number };
    expect(regex.count).toBe(2);
  });
});

describe("deterministic checks", () => {
  it("check_defined_terms finds definitions, undefined and unused terms, case variants", async () => {
    const { ctx } = makeCtx();
    const r = (await run(wordAgentTools(ctx), "check_defined_terms", {})) as ReturnType<typeof checkDefinedTerms>;
    expect(r.defined.map((d) => d.term).sort()).toEqual(["Agreement", "Company", "Confidential Information", "Products", "Supplier"]);
    expect(r.defined.find((d) => d.term === "Company")?.uses).toBe(2);
    expect(r.used_not_defined.map((u) => u.term)).toContain("Effective Date");
    expect(r.defined_not_used.map((u) => u.term).sort()).toEqual(["Confidential Information", "Supplier"]);
    expect(r.inconsistent_case.find((x) => x.term === "Agreement")?.variant).toBe("agreement");
  });

  it("check_citations flags Bluebook form problems without network calls", async () => {
    const { ctx } = makeCtx();
    const r = (await run(wordAgentTools(ctx), "check_citations", {})) as { by_rule: Record<string, number>; items: { rule: string; citation: string; message: string }[] };
    const rules = r.items.map((i) => i.rule);
    expect(rules).toContain("pin-cite"); // Anderson pin 200 < first page 242
    expect(rules).toContain("parenthetical"); // Anderson has no (year)
    expect(rules).toContain("case-name"); // "vs."
    expect(rules).toContain("reporter-spacing"); // F. 3d
    expect(rules).toContain("court"); // F.3d parenthetical without court
    expect(rules).toContain("rule-form"); // FRCP
    expect(rules).toContain("section-symbol"); // U.S.C.§1332
    expect(rules).toContain("id"); // lower-case id. at sentence start
    expect(r.items.some((i) => i.rule === "pin-cite" && i.citation.includes("Anderson"))).toBe(true);
    // Celotex is well formed: no flags on it except none.
    expect(r.items.filter((i) => i.citation.startsWith("Celotex"))).toEqual([]);
    expect(checkCitations([{ id: "x", index: 1, type: "paragraph", text: "See 2021 WL 123456." }]).map((f) => f.rule)).toEqual(["westlaw"]);
  });

  it("verify_edits re-reads touched blocks and reports defects introduced by the edits", async () => {
    const { ctx, snapshot } = makeCtx();
    const tools = wordAgentTools(ctx);
    const t = block(snapshot, "The agreement terminates");
    await run(tools, "rewrite_paragraph", { id: t.id, markdown: "The agreement terminates on [DATE] (subject to renewal" });
    const v = (await run(tools, "verify_edits", {})) as { checked: number; ok: boolean; issues: { issue: string }[] };
    expect(v.checked).toBe(1);
    expect(v.ok).toBe(false);
    const issues = v.issues.map((i) => i.issue).join(" | ");
    expect(issues).toMatch(/placeholder/);
    expect(issues).toMatch(/unbalanced parentheses/);
    expect(issues).toMatch(/end punctuation|no longer ends/);
  });
});

describe("redline_compare", () => {
  it("aligns blocks and produces modify / insert / delete ops", () => {
    const base = [{ type: "paragraph", text: "Alpha clause stays." }, { type: "paragraph", text: "The term is five years from signing." }, { type: "paragraph", text: "Removed clause." }, { type: "paragraph", text: "Omega clause stays." }];
    const current = [
      { id: "a", index: 1, type: "paragraph", text: "Alpha clause stays." },
      { id: "b", index: 2, type: "paragraph", text: "The term is seven years from signing." },
      { id: "c", index: 3, type: "paragraph", text: "Omega clause stays." },
      { id: "d", index: 4, type: "paragraph", text: "Brand new clause." },
    ];
    const ops = computeRedline(base, current);
    expect(ops).toEqual([
      { op: "modify", id: "b", base: "The term is five years from signing.", current: "The term is seven years from signing." },
      { op: "delete", after_id: "b", base: "Removed clause.", base_type: "paragraph" },
      { op: "insert", id: "d", current: "Brand new clause." },
    ]);
    // A "modify" op becomes word-level tracked changes (base text deleted, new text inserted).
    const tracked = buildTrackedInline([{ type: "text", text: "The term is five years from signing." }], inlineFromMarkdown("The term is seven years from signing."), { change: { id: "r1", author: "Redline", date: "2026-09-28T00:00:00Z" } });
    const del = tracked.filter((n) => n.marks?.some((m) => m.type === "deletion")).map((n) => n.text).join("");
    const ins = tracked.filter((n) => n.marks?.some((m) => m.type === "insertion")).map((n) => n.text).join("");
    expect(del).toBe("five");
    expect(ins).toBe("seven");
    expect(tracked.map((n) => n.text).join("")).toBe("The term is fiveseven years from signing.");
  });

  it("the tool proposes a redline against pasted base text", async () => {
    const { ctx, proposals } = makeCtx("review", "# T\n\nThe term is seven years.\n\nNew clause.");
    const r = (await run(wordAgentTools(ctx), "redline_compare", { base_markdown: "# T\n\nThe term is five years.\n\nOld clause that was cut." })) as { modified: number; added: number; removed: number };
    expect(r).toMatchObject({ modified: 1 });
    expect(r.added + r.removed).toBe(2);
    expect(proposals[0].kind).toBe("redline_compare");
    expect(proposals[0].payload.forceTrack).toBe(true);
  });
});

describe("structural tools", () => {
  it("heading level, Word styles, tables, merges, notes, TOC field, cross-references, numbering, page setup", async () => {
    const md = "# Brief\n\n## Facts\n\nBody text here.\n\n1. One\n2. Two\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |";
    const { ctx, proposals, snapshot } = makeCtx("draft", md);
    snapshot.styles = [{ id: "BlockText", name: "Block Text", type: "paragraph" }, { id: "Heading4", name: "heading 4", type: "paragraph", outline: 3 }];
    const tools = wordAgentTools(ctx);
    const body = block(snapshot, "Body text");
    await run(tools, "set_heading_level", { id: body.id, level: 4 });
    expect(snapshot.blocks.find((b) => b.id === body.id)).toMatchObject({ type: "heading", level: 4 });
    await run(tools, "apply_style", { id: body.id, style: "BlockText" });
    expect(proposals[1].payload).toMatchObject({ styleId: "BlockText", style: "body" });
    await expect(run(tools, "apply_style", { id: body.id, style: "NoSuchStyle" })).rejects.toThrow(/Unknown style/);
    const cell = snapshot.blocks.find((b) => b.table?.row === 2 && b.table.col === 1)!;
    await run(tools, "edit_table_cell", { table_id: cell.table!.tableId, row: 2, col: 1, markdown: "one" });
    expect(snapshot.blocks.find((b) => b.id === cell.id)?.text).toBe("one");
    await run(tools, "merge_cells", { table_id: cell.table!.tableId, from_row: 2, from_col: 1, to_row: 3, to_col: 1 });
    expect(proposals.at(-1)).toMatchObject({ kind: "merge_cells", payload: { fromRow: 2, toRow: 3, fromCol: 1, toCol: 1 } });
    await run(tools, "insert_footnote", { id: body.id, anchor_text: "Body", footnote_text: "Endnote text.", kind: "endnote" });
    expect(proposals.at(-1)?.payload).toMatchObject({ noteKind: "endnote" });
    await run(tools, "insert_toc", { id: snapshot.blocks[0].id });
    const toc = (proposals.at(-1)?.payload.blocks as PMNode[]);
    expect(JSON.stringify(toc)).toContain("\"kind\":\"fieldBegin\"");
    expect(JSON.stringify(toc)).toContain("TOC \\\\o");
    const facts = snapshot.blocks.find((b) => b.type === "heading" && b.text === "Facts")!;
    await run(tools, "insert_cross_reference", { id: body.id, target_heading_id: facts.id, anchor_text: "Body" });
    expect(proposals.at(-1)?.payload).toMatchObject({ targetId: facts.id, display: "Facts" });
    expect(String(proposals.at(-1)?.payload.instr)).toMatch(/REF _Ref\w+ \\h/);
    const item = block(snapshot, "Two");
    await run(tools, "numbering_fix", { block_id: item.id, action: "restart", start: 5 });
    expect(proposals.at(-1)?.payload).toMatchObject({ action: "restart", start: 5, listId: item.listInfo!.listId });
    await expect(run(tools, "numbering_fix", { block_id: facts.id, action: "restart" })).rejects.toThrow(/not in a numbered list/);
    await run(tools, "set_page_setup", { orientation: "landscape", section_break_after_id: item.id });
    expect(proposals.at(-1)?.payload).toMatchObject({ orientation: "landscape", sectionBreakAfterId: item.id });
  });

  it("legal_caption uses the matter record and never invents missing fields", async () => {
    const none = makeCtx();
    const r1 = (await run(wordAgentTools(none.ctx), "legal_caption", { id: none.snapshot.blocks[0].id })) as { placeholders: string[]; from_matter: boolean };
    expect(r1.from_matter).toBe(false);
    expect(r1.placeholders).toEqual(expect.arrayContaining(["[PLAINTIFF]", "[DEFENDANT]"]));
    const matter = { id: "m1", name: "Rivera v. Acme Corp.", client: "Acme Corp.", clientSide: "defendant", court: "U.S. District Court for the District of South Carolina", caption: "Case No. 2:24-cv-01234", judge: "Eleanor K. Whitlock", stage: "discovery" } as unknown as Matter;
    const member: Principal = { id: "u1", name: "Associate", tenantId: "t1", roles: ["associate"] as Principal["roles"], matterIds: ["m1"], source: "dev" as Principal["source"] };
    const outsider: Principal = { ...member, id: "u2", matterIds: ["m_other"] };
    // Fail closed: no principal, or a principal without access to the matter, gets placeholders, not matter data.
    for (const p of [null, outsider]) {
      const denied = makeCtx("draft", DOC_MD, matter, p);
      const r = (await run(wordAgentTools(denied.ctx), "legal_caption", { id: denied.snapshot.blocks[0].id })) as { from_matter: boolean };
      expect(r.from_matter).toBe(false);
      expect(JSON.stringify(denied.proposals[0].payload.blocks)).not.toContain("Rivera");
    }
    const withM = makeCtx("draft", DOC_MD, matter, member);
    const r2 = (await run(wordAgentTools(withM.ctx), "legal_caption", { id: withM.snapshot.blocks[0].id })) as { from_matter: boolean };
    expect(r2.from_matter).toBe(true);
    const text = JSON.stringify(withM.proposals[0].payload.blocks);
    expect(text).toContain("Rivera");
    expect(text).toContain("Case No. 2:24-cv-01234");
    expect(text).toContain("Whitlock");
    const sig = (await run(wordAgentTools(withM.ctx), "signature_block", { id: withM.snapshot.blocks[0].id })) as { placeholders: string[] };
    expect(sig.placeholders).toContain("[ATTORNEY NAME]");
  });
});

describe("speed: compact context and request tiers", () => {
  it("renders an outline with previews instead of the whole document for long documents", () => {
    const long = ensureBlockIds(markdownToDoc(Array.from({ length: 300 }, (_, i) => `## Section ${i}\n\n${`Paragraph ${i} text `.repeat(40)}`).join("\n\n")));
    const s = buildSnapshot(long, { title: "Long" });
    const r = renderSnapshot(s, null);
    expect(r.length).toBeLessThan(17_000);
    expect(r).toContain("get_paragraphs");
    expect(r).not.toContain("Paragraph 150 text Paragraph 150 text Paragraph 150 text");
    const small = renderSnapshot(buildSnapshot(ensureBlockIds(markdownToDoc("# A\n\nShort body.")), { title: "S" }), null);
    expect(small).toContain("Short body.");
  });

  it("classifies requests into quick / standard / deep budgets deterministically", () => {
    expect(classifyWordRequest("Fix the typo in ¶3", "draft").tier).toBe("quick");
    expect(classifyWordRequest("What is the governing law?", "ask").tier).toBe("quick");
    expect(classifyWordRequest("Draft a comprehensive 8-page memo on the state of the case", "draft")).toMatchObject({ tier: "deep", reasoningEffort: "high" });
    expect(classifyWordRequest("Tighten the argument section and strengthen the transitions between the points", "draft").tier).toBe("standard");
    // quick turns go to the fast model role through the shared route hook
    expect(routeWordRequest({ mode: "draft", scope: null }, "Bold the date in ¶4")).toMatchObject({ fast: true, reasoningEffort: "low", maxSteps: 10, reason: "word:quick" });
    expect(routeWordRequest({ mode: "draft", scope: null }, "Draft a motion to compel with a full argument section")).toMatchObject({ fast: false, reasoningEffort: "high" });
  });
});
