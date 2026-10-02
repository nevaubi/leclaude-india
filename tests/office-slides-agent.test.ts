/**
 * Slides agent: modes (Ask read-only, Review comments only), stale proposals, the verify (text-fit) step, every new
 * tool, matter-bound data access (no cross-matter reads, no Bates substitution) and outline layout choices.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { resetSqlite } from "@/lib/db";
import type { EditProposal, ReviewFinding } from "@/modules/office/shared/types";
import type { OfficeAgentContext } from "@/modules/office/shared/route-factory";
import { SLIDES_READ_TOOLS, isSlidesEditingTool, slidesAgentTools, type SlidesDataAccess, type SlidesToolDeps } from "@/modules/office/slides/agent-tools";
import { buildSnapshot } from "@/modules/office/slides/snapshot";
import { applyOp, StaleProposalError } from "@/modules/office/slides/proposals";
import { buildSlide, parseOutline } from "@/modules/office/slides/layouts";
import { bulletLines, cloneDeck, emptyDeck, estimateTextFit, getTheme, normalizeDeck, plainText, slideTitle, type DeckContent } from "@/modules/office/slides/model";
import { checkConsistency, documentOutline, fitTextPlan, outlineToSlides, planSlide, quoteInDocument } from "@/modules/office/slides/deck-builders";
import { useSlidesStore } from "@/modules/office/slides/store";
import { importDocument } from "@/modules/office/slides/import";
import { exportPptx } from "@/modules/office/slides/export";
import { handFixture } from "./office-slides-fixtures";

beforeAll(() => { resetSqlite(); });

const theme = getTheme("classic-navy");
const OUTLINE = `# Case strategy
subtitle: Meridian v. Halvorsen

# Three themes
- **Knowledge:** Meridian acted on the science
- **Causation:** plaintiffs cannot isolate the product
notes: Spine.

# Next steps
- Serve expert reports
- Open settlement channel`;

function deckOf(outline = OUTLINE): DeckContent {
  const d = emptyDeck("classic-navy");
  d.slides = parseOutline(outline, theme).slides;
  return d;
}

function setup(deck: DeckContent, opts: { mode?: "draft" | "review" | "ask"; deps?: SlidesToolDeps } = {}) {
  const proposals: EditProposal[] = [];
  const findings: ReviewFinding[] = [];
  const snapshot = buildSnapshot(deck, { title: "Test deck" });
  const ctx: OfficeAgentContext<typeof snapshot> = {
    mode: opts.mode ?? "draft", scope: null, research: false, snapshot, matter: null, docTitle: "Test deck", context: {}, proposals, findings,
    emit: () => {},
    propose: (p) => { const full: EditProposal = { id: `p${proposals.length + 1}`, status: "pending", ...p }; proposals.push(full); return full; },
    finding: (f) => { const full = { id: `f${findings.length + 1}`, ...f }; findings.push(full); return full; },
  };
  const tools = slidesAgentTools(ctx, opts.deps ?? {});
  const call = async (name: string, args: Record<string, unknown>) => {
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(`missing tool ${name}`);
    return (t.execute as (a: unknown, c: unknown) => unknown)(args, { emit: () => {}, state: {} }) as Promise<Record<string, unknown>> | Record<string, unknown>;
  };
  return { ctx, tools, proposals, findings, call, snapshot };
}
const applyAll = (deck: DeckContent, proposals: EditProposal[]) => proposals.reduce((d, p) => applyOp(d, p.payload), deck);

/** Fake authorized data for matter m1 (and an intruder matter m2). */
function fakeData(matter: string | null = "m1"): SlidesDataAccess {
  return {
    matterId: () => matter,
    timeline: (m) => (m === "m1" ? [
      { id: "t1", date: "1998-03-12", title: "Rat study circulated", significance: 5, verified: true, sources: [{ kind: "document", bates: "MFC-0102211" }] },
      { id: "t2", date: "2001-06-04", title: "Draft §8(e) notice", significance: 4, verified: false, sources: [{ kind: "document", bates: "MFC-0119377" }] },
      { id: "t3", date: "2006-01-01", title: "Stewardship program", significance: 3, verified: true, sources: [] },
      { id: "t4", date: "2010-05-05", title: "Minor memo", significance: 1, verified: true, sources: [{ kind: "document", bates: "MFC-0200000" }] },
    ] : []),
    exhibitByBates: (m, bates) => (m === "m1" && bates.toUpperCase() === "MFC-0102211" ? { id: "d1", bates: "MFC-0102211", batesEnd: "MFC-0102219", date: "1998-03-12", custodianName: "Dr. Vasudevan", type: "report", subject: "Rat study summary", text: "The study found liver effects at the highest dose. Further work is recommended.", aiSummary: "Summary of 1998 rat study" } : null),
    officeDoc: (id) => (id === "doc_memo" ? { id, title: "Strategy memo", kind: "word", matterId: "m1", content: { type: "doc", content: [
      { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Liability themes" }] },
      { type: "paragraph", content: [{ type: "text", text: "Meridian had no notice before 1998. The record shows otherwise only for 2001." }] },
      { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Four suppliers served the base." }] }] }] },
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Chronology" }] },
      { type: "bulletList", content: ["1998-03 — Rat study", "2001-06 — Draft notice", "2006-01 — Stewardship"].map((t) => ({ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: t }] }] })) },
    ] } } : id === "doc_other" ? { id, title: "Other matter memo", kind: "word", matterId: "m2", content: { type: "doc", content: [] } } : null),
    libraryItem: (id) => (id === "lib_img" ? { id, name: "Plume map", type: "image", matterId: "m1", url: "/api/blobs/blob_ok" } : id === "lib_other" ? { id, name: "Other", type: "image", matterId: "m2", url: "/api/blobs/blob_other" } : id === "lib_note" ? { id, name: "Research memo", type: "note", sharedWith: ["firm"], content: "# Standard\n- Daubert requires reliable methods\n# Contrary authority\n- In re X rejected the approach" } : null),
    blob: (id) => (id === "blob_ok" ? { id, mime: "image/png", matterId: "m1" } : id === "blob_other" ? { id, mime: "image/png", matterId: "m2" } : id === "blob_pdf" ? { id, mime: "application/pdf", matterId: "m1" } : null),
    libraryLinksBlob: () => false,
  };
}

describe("modes", () => {
  it("Ask mode exposes only read tools; Review adds comments only; Draft has every edit tool", () => {
    const ask = setup(deckOf(), { mode: "ask" }).tools.map((t) => t.name);
    expect(ask.length).toBeGreaterThan(5);
    expect(ask.every((n) => SLIDES_READ_TOOLS.has(n))).toBe(true);
    expect(ask.some((n) => isSlidesEditingTool(n))).toBe(false);
    const review = setup(deckOf(), { mode: "review" }).tools.map((t) => t.name);
    expect(review).toContain("add_review_comment");
    expect(review.filter((n) => isSlidesEditingTool(n))).toEqual([]);
    const draft = setup(deckOf()).tools.map((t) => t.name);
    for (const n of ["add_slide_from_layout", "set_placeholder_text", "rewrite_for_brevity", "restyle_deck", "reorder_slides", "duplicate_slide", "delete_slide", "insert_table", "insert_image", "insert_chart", "add_speaker_notes", "outline_to_deck", "deck_from_document", "timeline_slide", "exhibit_slide", "check_consistency", "fit_text", "get_slides", "get_layouts", "check_text_fit"]) expect(draft, n).toContain(n);
    expect(draft).not.toContain("add_review_comment");
  });

  it("review comments record findings and never change the deck", async () => {
    const deck = deckOf();
    const { call, findings, proposals, ctx } = setup(deck, { mode: "review" });
    await call("add_review_comment", { slide_id: "2", comment: "Title should state the takeaway", severity: "medium" });
    expect(findings[0]).toMatchObject({ severity: "medium", target: `slide:${deck.slides[1].id}`, targetLabel: "Slide 2" });
    expect(proposals).toEqual([]);
    expect(ctx.snapshot.deck).toEqual(deck);
  });
});

describe("stale proposals", () => {
  it("proposals carry base versions and target ids and apply cleanly in order", async () => {
    const deck = deckOf();
    const { call, proposals, ctx } = setup(deck);
    await call("set_placeholder_text", { slide_id: "2", placeholder: "title", markdown: "Meridian acted on the science it had" });
    await call("reorder_slides", { ids_in_order: ["3", "1", "2"] });
    await call("restyle_deck", { colors: { accent: "#0F766E" }, fonts: { heading: "Cambria" } });
    for (const p of proposals) expect(p.payload.base).toMatchObject({ deck: expect.any(String) });
    expect(proposals[0].payload.base).toMatchObject({ slideId: deck.slides[1].id, elementId: expect.any(String), element: expect.any(String) });
    expect(proposals[1].payload.base).toMatchObject({ order: expect.any(String) });
    expect(proposals[2].payload.base).toMatchObject({ theme: expect.any(String) });
    const applied = applyAll(deck, proposals);
    expect(applied.slides.map((s) => s.id)).toEqual(ctx.snapshot.deck.slides.map((s) => s.id));
    expect(applied.theme.fonts.heading).toBe("Cambria");
  });

  it("rejects a proposal whose element, slide, order or theme changed after it was made", async () => {
    const deck = deckOf();
    const { call, proposals } = setup(deck);
    await call("set_slide_text", { slide_id: "2", placeholder: "body", markdown: "- one\n- two" });
    await call("set_notes", { slide_id: "3", text: "Close strong." });
    await call("move_slide", { slide_id: "3", after_id: "start" });
    await call("apply_theme", { theme_id: "client-light" });
    // the user edits the same body box before applying
    const userEdited = cloneDeck(deck);
    const body = userEdited.slides[1].elements.find((e) => e.role === "body")!;
    body.text = "- the user's own wording";
    expect(() => applyOp(userEdited, proposals[0].payload)).toThrow(StaleProposalError);
    expect(() => applyOp(userEdited, proposals[0].payload)).toThrow(/Slide 2 changed since this proposal was made/);
    // a different slide changed → element-scoped proposal still applies
    const other = cloneDeck(deck);
    other.slides[2].notes = "changed elsewhere";
    expect(() => applyOp(other, proposals[0].payload)).not.toThrow();
    expect(() => applyOp(other, proposals[1].payload)).toThrow(/Slide 3 changed/);
    // order changed by the user
    const reordered = { ...cloneDeck(deck), slides: [...deck.slides].reverse() };
    let d = applyOp(applyOp(deck, proposals[0].payload), proposals[1].payload);
    expect(() => applyOp(reordered, proposals[2].payload)).toThrow(/reordered/);
    d = applyOp(d, proposals[2].payload);
    const themed = { ...d, theme: getTheme("modern-mono") };
    expect(() => applyOp(themed, proposals[3].payload)).toThrow(/theme changed/);
    // deleted target slide
    const deleted = { ...cloneDeck(deck), slides: deck.slides.filter((_, i) => i !== 1) };
    expect(() => applyOp(deleted, proposals[0].payload)).toThrow(/no longer exists/);
  });

  it("the editor store reports stale proposals as failed and keeps the user's edit", async () => {
    const deck = deckOf();
    const { call, proposals } = setup(deck);
    await call("set_slide_text", { slide_id: "2", placeholder: "body", markdown: "- agent wording" });
    const store = useSlidesStore.getState();
    store.load(cloneDeck(deck));
    const s2 = useSlidesStore.getState().deck.slides[1];
    const bodyId = s2.elements.find((e) => e.role === "body")!.id;
    useSlidesStore.getState().setCurrent(s2.id);
    useSlidesStore.getState().updateElement(bodyId, { text: "- user wording" });
    const r = useSlidesStore.getState().applyProposals(proposals.slice(0, 1));
    expect(r.applied).toEqual([]);
    expect(r.failed[0].error).toMatch(/changed since this proposal was made/);
    expect(useSlidesStore.getState().deck.slides[1].elements.find((e) => e.id === bodyId)!.text).toBe("- user wording");
  });
});

describe("verify step and overflow", () => {
  it("detects overflow deterministically and auto-proposes grow/shrink fixes", async () => {
    const deck = deckOf();
    const long = Array.from({ length: 12 }, (_, i) => `- Bullet ${i + 1} explains a fairly long factual point about the record in detail`).join("\n");
    const body = deck.slides[1].elements.find((e) => e.role === "body")!;
    expect(estimateTextFit({ ...body, text: long }, theme).overflow).toBe(true);
    expect(estimateTextFit({ ...body, text: "- short" }, theme).overflow).toBe(false);
    const { call, proposals, ctx } = setup(deck);
    const r = await call("set_slide_text", { slide_id: "2", placeholder: "body", markdown: long }) as { verify: { status: string }[] };
    expect(r.verify[0].status).toMatch(/fixed|overflow/);
    const fixed = ctx.snapshot.deck.slides[1].elements.find((e) => e.role === "body")!;
    expect(fixed.style.fontSize).toBeLessThan(body.style.fontSize!);
    expect(proposals.some((p) => p.title.startsWith("Fit text"))).toBe(true);
    const check = await call("check_text_fit", {}) as { overflowing: number };
    expect(check.overflowing).toBe(estimateTextFit(fixed, theme).overflow ? 1 : 0);
  });

  it("fit_text grows into free space, shrinks to a floor, then condenses with the fast model", async () => {
    const deck = deckOf();
    const slide = deck.slides[1];
    const body = slide.elements.find((e) => e.role === "body")!;
    body.h = 120; body.text = "- one point\n- two points\n- three points\n- four points\n- five points";
    const plan = fitTextPlan(slide, body, theme);
    expect(plan.action).toMatch(/grow/);
    expect(plan.patch.h).toBeGreaterThan(120);
    const huge = Array.from({ length: 40 }, (_, i) => `- point ${i} with enough words to wrap across the column twice at least`).join("\n");
    body.text = huge;
    const deps: SlidesToolDeps = { rewriteText: async () => "- Condensed point one\n- Condensed point two" };
    const { call, ctx } = setup(deck, { deps });
    const r = await call("fit_text", { slide_id: "2", element_id: body.id }) as { results: { status: string; action: string }[] };
    expect(r.results[0].action).toBe("condense");
    const after = ctx.snapshot.deck.slides[1].elements.find((e) => e.id === body.id)!;
    expect(bulletLines(after.text)).toEqual(["Condensed point one", "Condensed point two"]);
    expect(estimateTextFit(after, theme).overflow).toBe(false);
  });
});

describe("new tools", () => {
  it("rewrite_for_brevity uses the fast-model dep and reports when unavailable", async () => {
    const deck = deckOf();
    const bodyId = deck.slides[1].elements.find((e) => e.role === "body")!.id;
    const seen: { maxWords: number }[] = [];
    const { call, ctx } = setup(deck, { deps: { rewriteText: async (i) => { seen.push(i); return "- Knowledge\n- Causation"; } } });
    const r = await call("rewrite_for_brevity", { slide_id: "2", element_id: bodyId, max_words: 6 }) as { changed: boolean; words_after: number };
    expect(r.changed).toBe(true);
    expect(seen[0].maxWords).toBe(6);
    expect(plainText(ctx.snapshot.deck.slides[1].elements.find((e) => e.id === bodyId)!.text)).toBe("Knowledge\nCausation");
    const none = setup(deckOf());
    const r2 = await none.call("rewrite_for_brevity", { slide_id: "2", element_id: none.snapshot.deck.slides[1].elements.find((e) => e.role === "body")!.id }) as { changed: boolean; needs_rewrite: unknown };
    expect(r2.changed).toBe(false);
    expect(r2.needs_rewrite).toBeTruthy();
  });

  it("set_placeholder_text fills by role or creates the placeholder; restyle_deck changes colors and fonts", async () => {
    const { call, ctx } = setup(deckOf());
    await call("set_placeholder_text", { slide_id: "3", placeholder: "subtitle", markdown: "Owners and dates" });
    expect(ctx.snapshot.deck.slides[2].elements.find((e) => e.role === "subtitle")!.text).toBe("Owners and dates");
    await expect(Promise.resolve().then(() => call("restyle_deck", { colors: { accent: "teal" } }))).rejects.toThrow(/#RRGGBB/);
    await call("restyle_deck", { theme_id: "courtroom-serif", colors: { accent2: "#112233" } });
    expect(ctx.snapshot.deck.theme).toMatchObject({ fonts: { heading: "Times New Roman" }, colors: { accent: "#7A1F1F", accent2: "#112233" } });
  });

  it("duplicate / delete / reorder slides", async () => {
    const { call, ctx } = setup(deckOf());
    const dup = await call("duplicate_slide", { slide_id: "2" }) as { new_slide_id: string };
    expect(ctx.snapshot.deck.slides[2].id).toBe(dup.new_slide_id);
    await call("delete_slide", { slide_id: "1" });
    await expect(Promise.resolve().then(() => call("reorder_slides", { ids_in_order: ["1", "1"] }))).rejects.toThrow(/twice/);
    await call("reorder_slides", { ids_in_order: ["3", "2", "1"] });
    expect(ctx.snapshot.deck.slides.map((s) => slideTitle(s))).toEqual(["Next steps", "Three themes", "Three themes"]);
  });

  it("insert_table with merges, insert_chart validation, add_speaker_notes", async () => {
    const { call, ctx } = setup(deckOf(), { deps: { generateNotes: async (slides) => slides.map((s) => ({ id: s.id, notes: `Emphasize ${s.title}.` })) } });
    const t = await call("insert_table", { slide_id: "3", header: ["Bates", "Summary", ""], rows: [["MFC-1", "a", "b"], ["", "c", "d"]], merges: [{ row: 0, col: 1, col_span: 2 }, { row: 1, col: 0, row_span: 2 }] }) as { element_id: string };
    const tbl = ctx.snapshot.deck.slides[2].elements.find((e) => e.id === t.element_id)!.table!;
    expect(tbl.cells![0][1]).toMatchObject({ gridSpan: 2 });
    expect(tbl.cells![0][2]).toMatchObject({ hMerge: true });
    expect(tbl.cells![2][0]).toMatchObject({ vMerge: true });
    await expect(Promise.resolve().then(() => call("insert_table", { slide_id: "3", header: ["A"], rows: [["1"]], merges: [{ row: 0, col: 0, col_span: 3 }] }))).rejects.toThrow(/outside/);
    await expect(Promise.resolve().then(() => call("insert_chart", { slide_id: "3", type: "bar", categories: ["a", "b"], series: [{ name: "s", values: [1] }] }))).rejects.toThrow(/1 values for 2 categories/);
    await call("insert_chart", { slide_id: "3", type: "line", categories: ["2024", "2025"], series: [{ name: "Exposure", values: [10, 20] }], title: "Exposure ($M)" });
    const n = await call("add_speaker_notes", { slide_id: "3" }) as { generated_by: string };
    expect(n.generated_by).toBe("model");
    expect(ctx.snapshot.deck.slides[2].notes).toBe("Emphasize Next steps.");
    const again = await call("add_speaker_notes", { slide_id: "3" }) as { changed: boolean };
    expect(again.changed).toBe(false);
  });

  it("insert_image only accepts files of the deck's matter or the firm library", async () => {
    const { call, ctx } = setup(deckOf(), { deps: { data: fakeData("m1") } });
    const ok = await call("insert_image", { slide_id: "2", library_item_id: "lib_img" }) as { src: string };
    expect(ok.src).toBe("/api/blobs/blob_ok");
    expect(ctx.snapshot.deck.slides[1].elements.some((e) => e.type === "image" && e.src === "/api/blobs/blob_ok")).toBe(true);
    for (const args of [{ library_item_id: "lib_other" }, { blob_id: "blob_other" }, { url: "/api/blobs/blob_other" }]) await expect(Promise.resolve().then(() => call("insert_image", { slide_id: "2", ...args }))).rejects.toThrow(/Not authorized/);
    await expect(Promise.resolve().then(() => call("insert_image", { slide_id: "2", blob_id: "blob_pdf" }))).rejects.toThrow(/not an image/);
    await expect(Promise.resolve().then(() => call("insert_image", { slide_id: "2", url: "http://169.254.169.254/x.png" }))).rejects.toThrow(/https/);
  });

  it("timeline_slide builds from the matter chronology with cites and [VERIFY] flags", async () => {
    const { call, ctx } = setup(deckOf(), { deps: { data: fakeData("m1") } });
    const r = await call("timeline_slide", { after_id: "2", max_events: 3 }) as { events: { id: string; cite: string | null }[]; unverified: string[] };
    expect(r.events.map((e) => e.id)).toEqual(["t1", "t2", "t3"]); // top significance, chronological
    expect(r.events[0].cite).toBe("MFC-0102211");
    expect(r.unverified).toEqual(["t2", "t3"]);
    const slide = ctx.snapshot.deck.slides[2];
    expect(slide.layout).toBe("timeline");
    const items = slide.elements.filter((e) => e.role === "item").map((e) => plainText(e.text));
    expect(items[0]).toContain("MFC-0102211");
    expect(items[1]).toContain("[VERIFY]");
    expect(slide.notes).toContain("MFC-0119377");
    const noMatter = setup(deckOf(), { deps: { data: fakeData(null) } });
    await expect(Promise.resolve().then(() => noMatter.call("timeline_slide", {}))).rejects.toThrow(/not linked to a matter/);
  });

  it("exhibit_slide resolves exact Bates, verifies quotes and never substitutes an unresolved number", async () => {
    const { call, ctx, proposals } = setup(deckOf(), { deps: { data: fakeData("m1") } });
    const r = await call("exhibit_slide", { bates: "MFC-0102211", quote: "found liver effects at the highest dose", exhibit_label: "PX-12" }) as { quote: string; document: { bates: string } };
    expect(r.quote).toBe("verified");
    const slide = ctx.snapshot.deck.slides.at(-1)!;
    expect(slideTitle(slide)).toBe("PX-12: Rat study summary");
    expect(slide.elements.some((e) => plainText(e.text).includes("MFC-0102211–MFC-0102219"))).toBe(true);
    expect(slide.elements.find((e) => e.role === "caption")!.text).toMatch(/^Source: MFC-0102211/);
    const bad = await call("exhibit_slide", { bates: "MFC-0102211", quote: "no liver effects" }) as { quote: string };
    expect(bad.quote).toBe("not_found_in_document");
    expect(plainText(ctx.snapshot.deck.slides.at(-1)!.elements.find((e) => e.role === "quote")!.text)).toContain("[VERIFY");
    const before = proposals.length;
    await expect(Promise.resolve().then(() => call("exhibit_slide", { bates: "MFC-9999999" }))).rejects.toThrow(/not in this matter's record \(unresolved — no document was substituted\)/);
    expect(proposals.length).toBe(before);
    expect(quoteInDocument("“Further  work is recommended.”", "The study… Further work is recommended.")).toBe(true);
  });

  it("deck_from_document builds from a Word doc or firm memo and refuses other matters", async () => {
    const { call, ctx } = setup(emptyDeck(), { deps: { data: fakeData("m1") } });
    const r = await call("deck_from_document", { doc_id: "doc_memo" }) as { slides: { title: string; layout: string; reason: string }[] };
    expect(r.slides.map((s) => s.title)).toEqual(["Strategy memo", "Liability themes", "Chronology"]);
    expect(r.slides[2].layout).toBe("timeline");
    const bodyText = plainText(ctx.snapshot.deck.slides[1].elements.find((e) => e.role === "body")!.text);
    expect(bodyText).toContain("Meridian had no notice before 1998."); // quoted first sentence, not paraphrased
    expect(bodyText).toContain("Four suppliers served the base.");
    await expect(Promise.resolve().then(() => call("deck_from_document", { doc_id: "doc_other" }))).rejects.toThrow(/another matter/);
    const lib = await call("deck_from_document", { library_item_id: "lib_note", replace: false }) as { slides: { title: string }[] };
    expect(lib.slides.map((s) => s.title)).toContain("Contrary authority");
    expect(documentOutline({ markdown: "## A\ntext. more\n- item" })).toContain("# A\n- text.\n- item");
  });

  it("outline_to_deck chooses layouts deterministically with reasons", async () => {
    const outline = `# Meridian v. Halvorsen
- Case strategy briefing
# Agenda
- Posture
- Themes
# Chronology
- 1998-03 — Rat study — MFC-0102211
- 2001-06 — Draft notice
- 2006-01 — Stewardship program
# Exposure
- Plaintiffs: $184
- Defense: $42
# Their theory vs our theory
- Sole source
- Single exposure
- Four suppliers
- Multiple exposures
# Risks and recommendations
- Risks:
- Adverse verdict
- Recommendations:
- Open settlement channel
# Key documents
| Bates | Document |
| MFC-1 | Rat study |
# A word from the witness
- "We knew the science was incomplete and said so at the time."
- Dr. Vasudevan
# Questions
# Everything else
${Array.from({ length: 9 }, (_, i) => `- item ${i + 1}`).join("\n")}`;
    const { slides, plans } = outlineToSlides(outline, theme);
    expect(plans.map((p) => p.layout)).toEqual(["title", "agenda", "timeline", "chart", "comparison", "comparison", "table", "quote", "section", "two_column"]);
    expect(plans.map((p) => p.reason)).toContain("dated events");
    expect(plans[3].content.chart).toMatchObject({ categories: ["Plaintiffs", "Defense"], unit: "$", series: [{ values: [184, 42] }] });
    expect(plans[2].content.timeline![0]).toEqual({ date: "1998-03", label: "Rat study", detail: "MFC-0102211" });
    expect(plans[5].content).toMatchObject({ leftTitle: "Risks", rightTitle: "Recommendations" });
    expect(slides.length).toBe(10);
    expect(planSlide("Overview", ["- a", "- b"], 3).layout).toBe("agenda");
    const { call, ctx } = setup(emptyDeck());
    const r = await call("outline_to_deck", { outline }) as { slides: { layout: string; reason: string }[] };
    expect(r.slides[0]).toMatchObject({ layout: "title", reason: "opening slide" });
    expect(ctx.snapshot.deck.slides.length).toBe(10);
  });

  it("check_consistency flags size/font/position outliers, density and overflow", async () => {
    const deck = deckOf(`# One\n- a\n# Two\n- b\n# Three\n- c\n# Four\n${Array.from({ length: 9 }, (_, i) => `- bullet ${i} has many words so it goes over the twelve word limit for sure today`).join("\n")}`);
    const t2 = deck.slides[2].elements.find((e) => e.role === "title")!;
    t2.style = { ...t2.style, fontSize: 20, fontFamily: "Comic Sans MS" };
    t2.y += 60;
    const { issues } = checkConsistency(deck);
    const kinds = issues.filter((i) => i.slide === 3).map((i) => i.kind);
    expect(kinds).toEqual(expect.arrayContaining(["font_size", "font_family", "position"]));
    expect(issues.some((i) => i.slide === 4 && i.kind === "density")).toBe(true);
    const { call } = setup(deck, { mode: "ask" });
    const r = await call("check_consistency", {}) as { issue_count: number };
    expect(r.issue_count).toBe(issues.length);
  });

  it("add_slide_from_layout links imported decks to the template layout and exports it natively", async () => {
    resetSqlite();
    const bytes = await handFixture();
    const imported = await importDocument(bytes, "fixture.pptx");
    const deck = normalizeDeck(imported.content);
    const { call, ctx, proposals } = setup(deck);
    const layouts = await call("get_layouts", {}) as { pptx_layouts: { name: string }[] };
    expect(layouts.pptx_layouts.map((l) => l.name)).toContain("Two Content");
    const r = await call("add_slide_from_layout", { layout: "Two Content", title: "Their theory vs ours", left_markdown: "- sole source", right_markdown: "- four suppliers", after_id: "3" }) as { added: { pptx_layout: string; element_ids: { role: string }[] } };
    expect(r.added.pptx_layout).toBe("Two Content");
    expect(r.added.element_ids.map((e) => e.role)).toEqual(["title", "left", "right"]);
    const s4 = ctx.snapshot.deck.slides[3];
    const left = s4.elements.find((e) => e.role === "left")!;
    expect([left.x, left.y]).toEqual([88, 192]); // 838200 / 1825625 EMU on the canvas
    await call("set_placeholder_text", { slide_id: "2", placeholder: "idx:1", markdown: "- Meridian knew in 1998" });
    const applied = applyAll(deck, proposals);
    const out = await exportPptx(applied, { title: "x", sourcePackage: bytes });
    const re = normalizeDeck((await importDocument(new Uint8Array(out), "re.pptx")).content);
    expect(re.slides[3].ooxml!.layoutName).toBe("Two Content");
    expect(re.slides[3].elements.filter((e) => e.ooxml?.ph).map((e) => [e.role, e.ooxml!.ph!.idx ?? e.ooxml!.ph!.type])).toEqual([["title", "title"], ["left", "1"], ["right", "2"]]);
    expect(plainText(re.slides[1].elements.find((e) => e.role === "body")!.text)).toBe("Meridian knew in 1998");
  });

  it("get_slides reads several slides at once and outlines carry placeholder word counts", async () => {
    const { call } = setup(deckOf());
    const r = await call("get_slides", { slide_ids: ["1", "3", "99"] }) as { slides: ({ id?: string; error?: string })[] };
    expect(r.slides[0].id).toBeTruthy();
    expect(r.slides[2].error).toMatch(/No slide number 99/);
    const o = await call("get_deck_outline", {}) as { slides: { elements: { role: string; words: number }[] }[] };
    expect(o.slides[1].elements.find((e) => e.role === "body")!.words).toBeGreaterThan(5);
  });

  it("commit refuses edits outside draft mode even if a tool were exposed", async () => {
    const { ctx, tools, proposals } = setup(deckOf());
    const setNotes = tools.find((t) => t.name === "set_notes")!;
    (ctx as { mode: string }).mode = "ask";
    expect(() => (setNotes.execute as (a: unknown, c: unknown) => unknown)({ slide_id: "1", text: "x" }, { emit: () => {}, state: {} })).toThrow(/disabled in ask mode/);
    expect(proposals).toEqual([]);
    void buildSlide;
  });
});
