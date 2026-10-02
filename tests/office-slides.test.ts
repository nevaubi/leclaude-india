import { beforeAll, describe, expect, it } from "vitest";
import JSZip from "jszip";
import { db, resetSqlite } from "@/lib/db";
import type { EditProposal } from "@/modules/office/shared/types";
import type { OfficeAgentContext } from "@/modules/office/shared/route-factory";
import {
  SLIDE_H, SLIDE_LAYOUTS, SLIDE_W, THEMES, bulletLines, cloneSlide, deckStats, emptyDeck, estimateTextFit, fitFontSize, getTheme, hexForExport, normalizeDeck, parseMarkdownLite, plainText, resolveColor, serializeMarkdownLite, slideTitle, withinSlide, wordCount,
  type DeckContent, type DeckElement, type DeckSlide,
} from "@/modules/office/slides/model";
import { applyLayout, buildSlide, deckToOutline, extractContent, parseChartSpec, parseOutline, parseTimelineLine, restyleSlide, splitSlide } from "@/modules/office/slides/layouts";
import { applyOp } from "@/modules/office/slides/proposals";
import { buildSnapshot, parseSnapshot, renderSnapshot } from "@/modules/office/slides/snapshot";
import { slidesAgentTools } from "@/modules/office/slides/agent-tools";
import { exportOutlineText, exportPptx, inch } from "@/modules/office/slides/export";
import { emuToPx, importDocument, szToPt } from "@/modules/office/slides/import";
import { SLIDES_TEMPLATES, deckFromOutline } from "@/modules/office/slides/templates";
import { seedSlides } from "@/modules/office/slides/seed";
import { slidesInstructions, SLIDES_SUGGESTIONS } from "@/modules/office/slides/agent";

beforeAll(() => { resetSqlite(); });

const theme = getTheme("classic-navy");

const OUTLINE = `# Valsara arbitration: case strategy
kicker: Arb. Ref. 14/2024
subtitle: Themes and chronology
date: September 22, 2026

# Agenda
- Where we are
- Themes
- Next steps

# Three themes
- **Knowledge:** Meridian acted on the science it had
- **Causation:** the Claimant cannot isolate the source
  - three other suppliers documented
- **Conduct:** phase-out preceded the mandate
notes: Spine of the deck.

# Chronology
layout: timeline
timeline:
- 1998-03 — Rat study — MFC-0102211
- 2001-06 — Draft §8(e) notice — MFC-0119377
- 2006-01 — Stewardship program

# Key documents
| Bates | Date | Document |
| MFC-0102211 | 1998-03-12 | Rat study |
| MFC-0119377 | 2001-06-04 | Draft notice |

# Exposure
chart: bar | Plaintiffs | Defense | Range
chart-title: Exposure ($M)
Exposure: 184, 42, 65
unit: $
- Plaintiffs assume 100% attribution

# Risks and recommendations
left: Risks
- Adverse verdict
- Privilege ruling
right: Recommendations
- Press product ID
- Open settlement channel

# A word
quote: One idea per slide.
by: Every presenter

# Questions
layout: section
subtitle: Privileged`;

function deckOf(outline = OUTLINE): DeckContent {
  const deck = emptyDeck("classic-navy");
  deck.slides = parseOutline(outline, theme).slides;
  return deck;
}

function makeCtx(deck: DeckContent, overrides: Partial<OfficeAgentContext<ReturnType<typeof buildSnapshot>>> = {}) {
  const proposals: EditProposal[] = [];
  const snapshot = buildSnapshot(deck, { title: "Test deck" });
  const ctx: OfficeAgentContext<typeof snapshot> = {
    mode: "draft", scope: null, research: false, snapshot, matter: null, docTitle: "Test deck", context: {}, proposals, findings: [],
    emit: () => {},
    propose: (p) => { const full: EditProposal = { id: `p${proposals.length + 1}`, status: "pending", ...p }; proposals.push(full); return full; },
    finding: (f) => ({ id: "f", ...f }),
    ...overrides,
  };
  return { ctx, proposals, snapshot };
}

function tool(tools: ReturnType<typeof slidesAgentTools>, name: string) {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return (args: Record<string, unknown>) => (t.execute as (a: unknown, c: unknown) => unknown)(args, { emit: () => {}, state: {} });
}

/** Apply every proposal to a fresh copy of the deck (as the client store does). */
function applyAll(deck: DeckContent, proposals: EditProposal[]) {
  return proposals.reduce((d, p) => applyOp(d, p.payload), deck);
}

describe("markdown-lite", () => {
  it("parses bullets, numbers, indents and inline marks", () => {
    const lines = parseMarkdownLite("Title line\n- **Bold** point\n  - nested *italic*\n1. numbered __under__");
    expect(lines.map((l) => l.kind)).toEqual(["para", "bullet", "bullet", "number"]);
    expect(lines[2].indent).toBe(1);
    expect(lines[1].runs[0]).toMatchObject({ text: "Bold", bold: true });
    expect(lines[2].runs.some((r) => r.italic)).toBe(true);
    expect(lines[3].runs.some((r) => r.underline)).toBe(true);
  });
  it("round-trips through serialize", () => {
    const src = "- **Bold** point\n  - nested *italic*\n1. third\nplain";
    expect(serializeMarkdownLite(parseMarkdownLite(src))).toBe(src);
  });
  it("plain text strips markers and counts words", () => {
    expect(plainText("- **Bold** point\n  - nested")).toBe("Bold point\nnested");
    expect(wordCount("- one two\n- three")).toBe(3);
    expect(bulletLines("- a\n\n- b")).toEqual(["a", "b"]);
  });
});

describe("themes and colors", () => {
  it("ships at least five firm themes and resolves tokens", () => {
    expect(THEMES.length).toBeGreaterThanOrEqual(5);
    expect(THEMES.map((t) => t.name)).toEqual(expect.arrayContaining(["Navy", "Counsel Slate", "Courtroom Serif", "Modern Mono", "Client Light"]));
    expect(resolveColor("accent", theme)).toBe(theme.colors.accent);
    expect(resolveColor("#123456", theme)).toBe("#123456");
    expect(hexForExport("accent2", theme)).toBe(theme.colors.accent2.slice(1).toUpperCase());
    expect(hexForExport("#abc", theme)).toBe("AABBCC");
  });
});

describe("layout builders", () => {
  const content = { title: "A long title that states the takeaway in a full sentence", subtitle: "Subtitle", body: "- one\n- two\n- three\n  - nested", left: "- l1\n- l2", right: "- r1", leftTitle: "Theirs", rightTitle: "Ours", quote: "Quote text", attribution: "Someone", caption: "Caption", imageUrl: "/api/blobs/x", table: { header: ["A", "B"], rows: [["1", "2"], ["3", "4"]] }, chart: { type: "bar" as const, categories: ["x", "y"], series: [{ name: "s", values: [1, 2] }] }, timeline: [{ date: "2020", label: "one" }, { date: "2021", label: "two" }, { date: "2022", label: "three" }], agenda: ["a", "b", "c"], number: "01" };
  it("produces elements within the slide bounds for every layout", () => {
    for (const layout of SLIDE_LAYOUTS) {
      const slide = buildSlide(layout, content, theme, { slideNumber: 3 });
      expect(slide.layout).toBe(layout);
      for (const e of slide.elements) {
        expect(withinSlide(e, 1), `${layout}/${e.role ?? e.type} out of bounds: ${JSON.stringify([e.x, e.y, e.w, e.h])}`).toBe(true);
        expect(e.w).toBeGreaterThan(0);
        expect(e.type === "line" || e.h > 0).toBe(true);
      }
      const ids = slide.elements.map((e) => e.id);
      expect(new Set(ids).size).toBe(ids.length);
      if (layout !== "blank") expect(slide.elements.some((e) => e.role === "title" || e.role === "quote")).toBe(true);
    }
  });
  it("assigns roles and auto-fits text", () => {
    const s = buildSlide("bullets", { title: "T", body: Array.from({ length: 14 }, (_, i) => `- bullet number ${i} with a fairly long tail of words`).join("\n") }, theme);
    const body = s.elements.find((e) => e.role === "body")!;
    expect(body.style.fontSize).toBeLessThan(24);
    expect(body.style.fontSize).toBeGreaterThanOrEqual(14);
    expect(fitFontSize({ ...body, text: "- one" }, theme, 24, 14)).toBe(24);
    expect(estimateTextFit({ ...body, style: { ...body.style, fontSize: 40 } }, theme).overflow).toBe(true);
  });
  it("timeline lines parse dates, labels and detail", () => {
    expect(parseTimelineLine("2001-06 — Draft notice — MFC-0119377")).toEqual({ date: "2001-06", label: "Draft notice", detail: "MFC-0119377" });
    expect(parseTimelineLine("**1998** - Rat study")).toEqual({ date: "1998", label: "Rat study", detail: undefined });
  });
  it("re-flows content when applying another layout and keeps user images", () => {
    const s = buildSlide("bullets", { title: "Themes", body: "- a\n- b\n- c\n- d" }, theme);
    s.elements.push({ id: "el_userimg", type: "image", src: "/api/blobs/1", x: 900, y: 500, w: 200, h: 150, z: 99, style: {} });
    const two = applyLayout(s, "two_column", theme);
    expect(two.id).toBe(s.id);
    expect(plainText(two.elements.find((e) => e.role === "title")!.text)).toBe("Themes");
    expect(bulletLines(two.elements.find((e) => e.role === "left")!.text)).toEqual(["a", "b"]);
    expect(bulletLines(two.elements.find((e) => e.role === "right")!.text)).toEqual(["c", "d"]);
    expect(two.elements.some((e) => e.id === "el_userimg")).toBe(true);
    const back = applyLayout(two, "bullets", theme);
    expect(bulletLines(back.elements.find((e) => e.role === "body")!.text)).toEqual(["a", "b", "c", "d"]);
    const tl = applyLayout(buildSlide("bullets", { title: "Chronology", body: "- 2001 — Draft notice\n- 2006 — Phase-out" }, theme), "timeline", theme);
    expect(tl.elements.filter((e) => e.role === "item").length).toBe(2);
  });
  it("splits and restyles", () => {
    const s = buildSlide("bullets", { title: "Big", body: Array.from({ length: 8 }, (_, i) => `- point ${i}`).join("\n") }, theme);
    const [a, b] = splitSlide(s, theme);
    expect(a.id).toBe(s.id);
    expect(bulletLines(a.elements.find((e) => e.role === "body")!.text).length).toBe(4);
    expect(slideTitle(b)).toBe("Big (cont.)");
    const messy: DeckSlide = { ...s, elements: s.elements.map((e) => (e.role === "body" ? { ...e, style: { ...e.style, fontSize: 60 } } : e)) };
    const fixed = restyleSlide(messy, theme, ["shrink to fit"]);
    expect(fixed.elements.find((e) => e.role === "body")!.style.fontSize).toBeLessThanOrEqual(24);
  });
});

describe("outline DSL", () => {
  it("parses a multi-layout outline and infers layouts", () => {
    const deck = deckOf();
    expect(deck.slides.map((s) => s.layout)).toEqual(["title", "agenda", "bullets", "timeline", "table", "chart", "comparison", "quote", "section"]);
    expect(deck.slides[2].notes).toBe("Spine of the deck.");
    expect(deck.slides[4].elements.find((e) => e.type === "table")!.table).toMatchObject({ header: ["Bates", "Date", "Document"], rows: [["MFC-0102211", "1998-03-12", "Rat study"], ["MFC-0119377", "2001-06-04", "Draft notice"]] });
    const chart = deck.slides[5].elements.find((e) => e.type === "chart")!.chart!;
    expect(chart).toMatchObject({ type: "bar", categories: ["Plaintiffs", "Defense", "Range"], title: "Exposure ($M)", unit: "$" });
    expect(chart.series).toEqual([{ name: "Exposure", values: [184, 42, 65] }]);
    expect(bulletLines(deck.slides[5].elements.find((e) => e.role === "body")!.text)).toEqual(["Plaintiffs assume 100% attribution"]);
    expect(parseChartSpec("bar | Q1, Q2 | Revenue: 1, 2 | Cost: 3, 4").series).toEqual([{ name: "Revenue", values: [1, 2] }, { name: "Cost", values: [3, 4] }]);
    expect(deck.slides[3].elements.filter((e) => e.role === "item").length).toBe(3);
    expect(extractContent(deck.slides[6])).toMatchObject({ leftTitle: "Risks", rightTitle: "Recommendations" });
    expect(parseChartSpec("pie | A, B | Share: 60, 40")).toMatchObject({ type: "pie", categories: ["A", "B"], series: [{ name: "Share", values: [60, 40] }], showLegend: true });
  });
  it("serializes a deck back to an outline that re-parses", () => {
    const deck = deckOf();
    const outline = deckToOutline(deck.slides);
    expect(outline).toContain("# Three themes");
    expect(outline).toContain("timeline:");
    const again = parseOutline(outline, theme).slides;
    expect(again.length).toBe(deck.slides.length);
    expect(again.map((s) => s.layout)).toEqual(deck.slides.map((s) => s.layout));
  });
});

describe("proposal operations", () => {
  it("add / set / reorder / delete / duplicate / theme", () => {
    const deck = deckOf();
    const s0 = deck.slides[0].id;
    const added = applyOp(deck, { op: "add_slide", afterId: s0, slide: buildSlide("bullets", { title: "New", body: "- x" }, theme) });
    expect(added.slides.length).toBe(deck.slides.length + 1);
    expect(slideTitle(added.slides[1])).toBe("New");
    expect(deck.slides.length).toBe(9); // input untouched
    const titleEl = added.slides[1].elements.find((e) => e.role === "title")!;
    const edited = applyOp(added, { op: "set_element", slideId: added.slides[1].id, elementId: titleEl.id, patch: { text: "Renamed", style: { bold: false } } });
    expect(slideTitle(edited.slides[1])).toBe("Renamed");
    expect(edited.slides[1].elements.find((e) => e.id === titleEl.id)!.style.fontFamily).toBe("heading");
    const ids = edited.slides.map((s) => s.id);
    const reordered = applyOp(edited, { op: "reorder_slides", ids: [ids[1], ids[0]] });
    expect(reordered.slides.map((s) => s.id)).toEqual([ids[1], ids[0], ...ids.slice(2)]);
    const deleted = applyOp(reordered, { op: "delete_slide", slideId: ids[1] });
    expect(deleted.slides.some((s) => s.id === ids[1])).toBe(false);
    const dup = applyOp(deleted, { op: "duplicate_slide", slideId: ids[0], slide: cloneSlide(deleted.slides[0]) });
    expect(dup.slides.length).toBe(deleted.slides.length + 1);
    expect(dup.slides[1].id).not.toBe(dup.slides[0].id);
    const themed = applyOp(dup, { op: "apply_theme", theme: getTheme("client-light") });
    expect(themed.theme.id).toBe("client-light");
    expect(() => applyOp(themed, { op: "delete_slide", slideId: "nope" })).toThrow(/No slide/);
  });
});

describe("snapshot", () => {
  it("renders a compact outline with ids, layouts, placeholders and word counts; details only for the focused slide", () => {
    const deck = deckOf();
    const snap = parseSnapshot(buildSnapshot(deck, { title: "Deck" }));
    const text = renderSnapshot(snap, null);
    expect(text).toMatch(/S1 \[sl_[A-Za-z0-9_-]+\] title — "Valsara arbitration: case strategy"/);
    expect(text).toMatch(/S3 \[sl_[A-Za-z0-9_-]+\] bullets — "Three themes" title#el_[A-Za-z0-9_-]+ · body#el_[A-Za-z0-9_-]+ \d+w 4b · notes 4w/);
    expect(text).not.toContain("role=body"); // no element dump without focus
    expect(() => parseSnapshot({})).toThrow();
    const scoped = renderSnapshot(snap, { id: `slide:${deck.slides[2].id}`, label: "Slide 3", kind: "slide", ref: deck.slides[2].id });
    expect(scoped).toContain("FOCUSED SLIDE DETAIL");
    expect(scoped.split("\n").filter((l) => l.includes("role=body")).length).toBe(1);
    expect(scoped).toContain("Notes: Spine of the deck.");
    // prompt size: outline stays far smaller than a full element dump
    expect(text.length).toBeLessThan(4000);
  });
});

describe("agent tools", () => {
  it("reads the outline and slides", () => {
    const deck = deckOf();
    const { ctx } = makeCtx(deck);
    const tools = slidesAgentTools(ctx);
    const outline = tool(tools, "get_deck_outline")({}) as { slides: { id: string; title: string; layout: string }[] };
    expect(outline.slides.length).toBe(9);
    expect(outline.slides[2]).toMatchObject({ title: "Three themes", layout: "bullets" });
    const slide = tool(tools, "get_slide")({ slide_id: "3" }) as { elements: { role?: string }[]; notes: string };
    expect(slide.elements.some((e) => e.role === "body")).toBe(true);
    expect(slide.notes).toBe("Spine of the deck.");
    const found = tool(tools, "find_text")({ query: "mfc-0119377" }) as { count: number; matches: { slide: number }[] };
    expect(found.count).toBeGreaterThanOrEqual(2);
    expect(found.matches.map((m) => m.slide)).toEqual(expect.arrayContaining([4, 5]));
  });
  it("edit tools mutate the snapshot and produce applicable proposals", async () => {
    const deck = deckOf();
    const { ctx, proposals } = makeCtx(deck);
    const tools = slidesAgentTools(ctx, { generateImage: async () => ({ url: "/api/blobs/generated" }) });
    const third = deck.slides[2].id;
    tool(tools, "add_slide")({ after_id: third, layout: "table", title: "Key custodians", table: { header: ["Custodian", "Role"], rows: [["Vasudevan", "Toxicologist"]] }, notes: "Read the names." });
    tool(tools, "set_slide_text")({ slide_id: "3", placeholder: "body", markdown: "- one\n- two" });
    tool(tools, "set_notes")({ slide_id: third, text: "New notes" });
    await tool(tools, "insert_image")({ slide_id: third, prompt: "a groundwater plume diagram" });
    tool(tools, "insert_chart")({ slide_id: "9", type: "pie", categories: ["A", "B"], series: [{ name: "Share", values: [60, 40] }] });
    tool(tools, "split_slide")({ slide_id: deck.slides[3].id });
    tool(tools, "set_layout")({ slide_id: "2", layout: "bullets" });
    tool(tools, "apply_theme")({ theme_id: "client-light" });
    const snap = ctx.snapshot.deck;
    expect(snap.slides.length).toBe(deck.slides.length + 2); // added + split
    expect(slideTitle(snap.slides[3])).toBe("Key custodians");
    expect(bulletLines(snap.slides[2].elements.find((e) => e.role === "body")!.text)).toEqual(["one", "two"]);
    expect(snap.slides[2].notes).toBe("New notes");
    expect(snap.slides[2].elements.some((e) => e.type === "image" && e.src === "/api/blobs/generated")).toBe(true);
    expect(snap.theme.id).toBe("client-light");
    expect(snap.slides[1].layout).toBe("bullets");
    // client-side application yields the same deck
    const applied = applyAll(deck, proposals);
    expect(applied.slides.map((s) => s.id)).toEqual(snap.slides.map((s) => s.id));
    expect(applied.theme.id).toBe("client-light");
    expect(proposals.every((p) => p.status === "pending" && p.payload.op)).toBe(true);
    expect(proposals.find((p) => p.kind === "add_slide")!.targetLabel).toBe("Slide 4");
  });
  it("generate_deck builds a whole deck and condense reports when no model is available", async () => {
    const deck = emptyDeck();
    const { ctx, proposals } = makeCtx(deck);
    const tools = slidesAgentTools(ctx);
    const r = tool(tools, "generate_deck")({ outline_markdown: OUTLINE }) as { slides: { id: string }[] };
    expect(r.slides.length).toBe(9);
    expect(ctx.snapshot.deck.slides.length).toBe(9);
    expect(proposals[0].kind).toBe("replace_deck");
    const long = Array.from({ length: 9 }, (_, i) => `- bullet ${i} with many words in it to exceed the limit for sure`).join("\n");
    tool(tools, "set_slide_text")({ slide_id: "3", placeholder: "body", markdown: long });
    const c = (await tool(tools, "condense_deck")({ max_bullets: 5, max_words_per_bullet: 8 })) as { changed: number; needs_rewrite?: { slide: number }[] };
    expect(c.changed).toBe(0);
    expect(c.needs_rewrite?.some((x) => x.slide === 3)).toBe(true);
    const n = (await tool(tools, "add_speaker_notes_all")({ style: "brief" })) as { changed: number; generated_by: string };
    expect(n.generated_by).toBe("template");
    expect(n.changed).toBeGreaterThan(0);
    expect(ctx.snapshot.deck.slides.every((s) => s.notes.trim().length > 0)).toBe(true);
  });
  it("uses injected model deps for condensing and notes", async () => {
    const deck = deckOf();
    const { ctx } = makeCtx(deck);
    const tools = slidesAgentTools(ctx, {
      condenseSlides: async (slides) => slides.map((s) => ({ id: s.id, body: "- short\n- tight" })),
      generateNotes: async (slides) => slides.map((s) => ({ id: s.id, notes: `Notes for ${s.title}` })),
    });
    tool(tools, "set_slide_text")({ slide_id: "3", placeholder: "body", markdown: Array.from({ length: 8 }, (_, i) => `- b${i}`).join("\n") });
    const c = (await tool(tools, "condense_deck")({})) as { changed: number };
    expect(c.changed).toBe(1);
    expect(bulletLines(ctx.snapshot.deck.slides[2].elements.find((e) => e.role === "body")!.text)).toEqual(["short", "tight"]);
    const n = (await tool(tools, "add_speaker_notes_all")({ overwrite: true })) as { generated_by: string };
    expect(n.generated_by).toBe("model");
    expect(ctx.snapshot.deck.slides[0].notes).toContain("Notes for");
  });
  it("instructions and suggestions are populated", () => {
    const { ctx } = makeCtx(deckOf());
    const text = slidesInstructions(ctx);
    expect(text).toContain("≤ 6 bullets");
    expect(text).toContain("generate_deck");
    expect(SLIDES_SUGGESTIONS.draft.length).toBeGreaterThanOrEqual(5);
  });
});

describe("pptx export", () => {
  it("writes a valid zip with slides, notes, a chart and the expected text", async () => {
    const deck = deckOf();
    deck.slides[2].elements.push({ id: "el_img", type: "image", src: "/api/blobs/none", alt: "missing", x: 900, y: 500, w: 200, h: 120, z: 50, style: { fit: "contain" } });
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    const buf = await exportPptx(deck, { title: "Test deck", fetchImage: async (src) => (src === "/api/blobs/none" ? null : png) });
    expect(buf.byteLength).toBeGreaterThan(20_000);
    const zip = await JSZip.loadAsync(buf);
    const slide1 = await zip.file("ppt/slides/slide1.xml")!.async("string");
    expect(slide1).toContain("Valsara arbitration: case strategy");
    const slide3 = await zip.file("ppt/slides/slide3.xml")!.async("string");
    expect(slide3).toContain("Knowledge:");
    expect(slide3).toContain("buChar"); // bullets
    expect(slide3).toContain("<a:rPr"); // runs
    expect(slide3).toMatch(/b="1"/); // bold run
    const slide5 = await zip.file("ppt/slides/slide5.xml")!.async("string");
    expect(slide5).toContain("<a:tbl>");
    expect(slide5).toContain("MFC-0102211");
    expect(Object.keys(zip.files).some((f) => /ppt\/charts\/chart\d+\.xml/.test(f))).toBe(true);
    const notes = await Promise.all(Object.keys(zip.files).filter((f) => /ppt\/notesSlides\/notesSlide\d+\.xml$/.test(f)).map((f) => zip.file(f)!.async("string")));
    expect(notes.some((n) => n.includes("Spine of the deck."))).toBe(true);
    const pres = await zip.file("ppt/presentation.xml")!.async("string");
    expect(pres).toMatch(/<p:sldSz cx="1219\d{4}" cy="6858000"/);
    expect(inch(1280)).toBeCloseTo(13.333, 2);
    expect(exportOutlineText(deck, "Deck")).toContain("Slide 3");
  });
});

describe("pptx import", () => {
  it("converts EMU and font sizes", () => {
    expect(emuToPx(12192000)).toBe(1280);
    expect(emuToPx(914400)).toBe(96);
    expect(emuToPx(9144000, 9144000)).toBe(1280); // 10in-wide source scales up
    expect(szToPt(2400)).toBe(24);
    expect(szToPt(1800, 9144000)).toBeCloseTo(24, 0);
  });
  it("round-trips a deck exported by our own exporter", async () => {
    const deck = deckOf();
    const buf = await exportPptx(deck, { title: "Round trip", fetchImage: async () => null });
    const imported = await importDocument(new Uint8Array(buf), "round-trip.pptx");
    const content = normalizeDeck(imported.content);
    expect(imported.title).toBe("Round trip");
    expect(content.slides.length).toBe(deck.slides.length);
    expect(slideTitle(content.slides[0])).toBe("Valsara arbitration: case strategy");
    const third = content.slides[2];
    const body = third.elements.filter((e) => e.type === "text").map((e) => plainText(e.text)).join("\n");
    expect(body).toContain("Knowledge:");
    expect(third.notes).toContain("Spine of the deck.");
    const table = content.slides[4].elements.find((e) => e.type === "table")!;
    expect(table.table!.header).toEqual(["Bates", "Date", "Document"]);
    expect(table.table!.rows[0][0]).toBe("MFC-0102211");
    const chart = content.slides[5].elements.find((e) => e.type === "chart")!;
    expect(chart.chart).toMatchObject({ type: "bar", categories: ["Plaintiffs", "Defense", "Range"] });
    expect(chart.chart!.series[0].values).toEqual([184, 42, 65]);
    for (const s of content.slides) for (const e of s.elements) { expect(e.x).toBeGreaterThanOrEqual(-8); expect(e.x + e.w).toBeLessThanOrEqual(SLIDE_W + 8); expect(e.y + e.h).toBeLessThanOrEqual(SLIDE_H + 8); }
    // title element keeps a heading-ish size
    const titleEl = content.slides[2].elements.find((e) => e.role === "title" || (e.style.fontSize ?? 0) >= 28) as DeckElement;
    expect(titleEl).toBeTruthy();
  });
  it("rejects non-pptx input", async () => {
    const zip = new JSZip();
    zip.file("hello.txt", "x");
    await expect(importDocument(new Uint8Array(await zip.generateAsync({ type: "uint8array" })), "x.pptx")).rejects.toThrow(/Not a PowerPoint/);
  });
});

describe("templates and seeds", () => {
  it("every template builds a complete, in-bounds deck", () => {
    expect(SLIDES_TEMPLATES.length).toBeGreaterThanOrEqual(8);
    for (const t of SLIDES_TEMPLATES) {
      const deck = normalizeDeck(t.build({ matterId: "m_valsara_arb", title: t.name }));
      expect(deck.slides.length, t.id).toBeGreaterThanOrEqual(t.id === "slides-blank" ? 1 : 7);
      for (const s of deck.slides) for (const e of s.elements) expect(withinSlide(e, 1), `${t.id}: ${e.role ?? e.type}`).toBe(true);
      const layouts = new Set(deck.slides.map((s) => s.layout));
      if (t.id !== "slides-blank") expect(layouts.size, t.id).toBeGreaterThanOrEqual(3);
      expect(JSON.stringify(deck)).not.toMatch(/lorem ipsum/i);
    }
    const strategy = normalizeDeck(SLIDES_TEMPLATES[0].build({ matterId: "m_valsara_arb" }));
    expect(JSON.stringify(strategy)).toContain("Valsara Textile Park Ltd. v. Meridian Fine Chemicals Ltd.");
    expect(deckFromOutline("# Only\n- a", "modern-mono").theme.id).toBe("modern-mono");
  });
  it("seeds decks with versions, comments and library items idempotently", () => {
    const d = db();
    seedSlides(d);
    const decks = d.officeDocs.find((x) => x.kind === "slides" && x.id.startsWith("sd_"));
    expect(decks.length).toBeGreaterThanOrEqual(4);
    const valsara = d.officeDocs.get("sd_vls_case_strategy")!;
    expect(valsara.matterId).toBe("m_valsara_arb");
    const deck = normalizeDeck(valsara.content);
    expect(deck.slides.length).toBeGreaterThanOrEqual(10);
    expect(deck.slides.some((s) => s.layout === "chart" && JSON.stringify(s).includes("MFC-0041877"))).toBe(true);
    expect(d.officeVersions.find((v) => v.docId === valsara.id).length).toBeGreaterThanOrEqual(4);
    const comments = d.officeComments.find((c) => c.docId === valsara.id);
    expect(comments.length).toBe(3);
    expect(comments.every((c) => /^slide:sl_/.test(c.anchor) && deck.slides.some((s) => `slide:${s.id}` === c.anchor))).toBe(true);
    const lib = d.library.find((l) => l.officeDocId === valsara.id);
    expect(lib.length).toBe(1);
    expect(lib[0].type).toBe("pptx");
    const before = { docs: d.officeDocs.count(), versions: d.officeVersions.count(), comments: d.officeComments.count(), lib: d.library.count() };
    seedSlides(d);
    expect({ docs: d.officeDocs.count(), versions: d.officeVersions.count(), comments: d.officeComments.count(), lib: d.library.count() }).toEqual(before);
    expect(deckStats(deck).slides).toBe(deck.slides.length);
  });
});
