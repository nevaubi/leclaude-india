import { describe, expect, it } from "vitest";
import {
  applyRowClick, clampWidth, columnWidth, compareValues, defaultHiddenColumns, keyboardNav, resizeColumn, selectRange, selectionSummary, sortRows, toggleColumn, toggleSelected, toggleSort, totalWidth, visibleColumns, ROW_HEIGHT,
} from "@/components/ui/data-table-helpers";
import {
  activeFilterCount, activeFilters, chipLabel, clearFilters, deleteView, findMatchingView, loadViews, matchesQuickSearch, normalizeValues, saveView, storeViews, toggleFilterValue, viewId, viewMatches,
} from "@/components/ui/filterbar-helpers";
import { acceptsFile, addFiles, describeFiles, flattenFolders, formatAccept, formatFileSize, normalizeAccept } from "@/components/ui/form-helpers";
import { GLOBAL_SHORTCUTS, detectPlatform, formatKeys, isTypingTarget, mergeShortcutGroups } from "@/components/ui/shortcut-help-helpers";
import { currentUser, resolveUserId, DEFAULT_USER , setWorkspaceUser} from "@/lib/current-user";
import { corpusDirs, providerStatuses, providersPayload } from "@/modules/settings/providers";
import { SETTINGS_GROUPS, sectionForHash } from "@/modules/settings/settings-groups";
import { GO_CHORD, NAV } from "@/components/shell/nav";
import { paletteSections } from "@/components/shell/palette-groups";
import { FEATURES } from "@/lib/features";

// ---------------------------------------------------------------------------
// DataTable helpers
// ---------------------------------------------------------------------------

type Row = { id: string; name: string; n: number | null; when?: Date };
const rows: Row[] = [
  { id: "a", name: "Brief 10", n: 3 },
  { id: "b", name: "brief 2", n: null },
  { id: "c", name: "Answer", n: 1, when: new Date("2026-01-02") },
  { id: "d", name: "Motion", n: 2, when: new Date("2025-12-31") },
];
const acc = (r: Row, col: string) => (col === "name" ? r.name : col === "n" ? r.n : r.when);
const ids = rows.map((r) => r.id);

describe("DataTable sorting", () => {
  it("compares numbers, strings (natural, case-insensitive), dates and empties last", () => {
    expect(compareValues(2, 10)).toBeLessThan(0);
    expect(compareValues("brief 2", "Brief 10")).toBeLessThan(0);
    expect(compareValues(new Date("2025-12-31"), new Date("2026-01-02"))).toBeLessThan(0);
    expect(compareValues(null, 1)).toBeGreaterThan(0);
    expect(compareValues("", "x")).toBeGreaterThan(0);
    expect(compareValues(null, undefined)).toBe(0);
    expect(compareValues(true, false)).toBeGreaterThan(0);
  });
  it("sorts stably in both directions and keeps empty values last", () => {
    expect(sortRows(rows, { columnId: "n", dir: "asc" }, acc).map((r) => r.id)).toEqual(["c", "d", "a", "b"]);
    expect(sortRows(rows, { columnId: "n", dir: "desc" }, acc).map((r) => r.id)).toEqual(["a", "d", "c", "b"]);
    expect(sortRows(rows, { columnId: "name", dir: "asc" }, acc).map((r) => r.id)).toEqual(["c", "b", "a", "d"]);
    expect(sortRows(rows, { columnId: "when", dir: "asc" }, acc).map((r) => r.id)).toEqual(["d", "c", "a", "b"]);
    expect(sortRows(rows, null, acc)).toBe(rows);
  });
  it("toggles the sort direction on the same column and starts fresh on another", () => {
    expect(toggleSort(null, "name")).toEqual({ columnId: "name", dir: "asc" });
    expect(toggleSort({ columnId: "name", dir: "asc" }, "name")).toEqual({ columnId: "name", dir: "desc" });
    expect(toggleSort({ columnId: "name", dir: "desc" }, "name")).toEqual({ columnId: "name", dir: "asc" });
    expect(toggleSort({ columnId: "name", dir: "desc" }, "n", "desc")).toEqual({ columnId: "n", dir: "desc" });
  });
});

describe("DataTable selection", () => {
  it("selects ranges from the anchor in either direction", () => {
    expect(selectRange(ids, "b", "d")).toEqual(["b", "c", "d"]);
    expect(selectRange(ids, "d", "a")).toEqual(["a", "b", "c", "d"]);
    expect(selectRange(ids, null, "c")).toEqual(["c"]);
    expect(selectRange(ids, "zzz", "c")).toEqual(["c"]);
    expect(selectRange(ids, "a", "zzz")).toEqual([]);
  });
  it("models click, ⌘-click and shift-click", () => {
    const s0 = { selected: [] as string[], anchorId: null };
    const s1 = applyRowClick(s0, ids, "b");
    expect(s1).toEqual({ selected: ["b"], anchorId: "b" });
    const s2 = applyRowClick(s1, ids, "d", { shift: true });
    expect(s2.selected).toEqual(["b", "c", "d"]);
    expect(s2.anchorId).toBe("b");
    const s3 = applyRowClick(s2, ids, "c", { meta: true });
    expect(s3.selected).toEqual(["b", "d"]);
    const s4 = applyRowClick(s3, ids, "a", { shift: true, meta: true });
    expect(s4.selected).toEqual(["b", "d", "a", "c"]);
    expect(applyRowClick(s4, ids, "a")).toEqual({ selected: ["a"], anchorId: "a" });
    expect(applyRowClick(s4, ids, "b", { shift: true }, "single")).toEqual({ selected: ["b"], anchorId: "b" });
    expect(applyRowClick(s4, ids, "b", {}, "none")).toBe(s4);
    expect(toggleSelected(["a"], "a")).toEqual([]);
    expect(toggleSelected(["a"], "b")).toEqual(["a", "b"]);
  });
  it("summarises the selection as plain text", () => {
    expect(selectionSummary(0, 120, "document")).toBe("120 documents");
    expect(selectionSummary(3, 120, "document")).toBe("3 of 120 documents selected");
    expect(selectionSummary(1, 1)).toBe("1 of 1 row selected");
  });
});

describe("DataTable keyboard reducer", () => {
  const base = { activeIndex: -1, selected: [] as string[], anchorId: null as string | null };
  it("moves with j/k and the arrows, selecting the active row", () => {
    const r1 = keyboardNav(base, "j", { ids });
    expect(r1.next).toEqual({ activeIndex: 0, selected: ["a"], anchorId: "a" });
    const r2 = keyboardNav(r1.next, "ArrowDown", { ids });
    expect(r2.next.activeIndex).toBe(1);
    const r3 = keyboardNav(r2.next, "k", { ids });
    expect(r3.next).toEqual({ activeIndex: 0, selected: ["a"], anchorId: "a" });
    expect(keyboardNav(r3.next, "ArrowUp", { ids }).next.activeIndex).toBe(0);
    expect(keyboardNav(base, "End", { ids }).next.activeIndex).toBe(3);
    expect(keyboardNav({ ...base, activeIndex: 3 }, "Home", { ids }).next.activeIndex).toBe(0);
    expect(keyboardNav({ ...base, activeIndex: 0 }, "PageDown", { ids, pageSize: 2 }).next.activeIndex).toBe(2);
    expect(keyboardNav({ ...base, activeIndex: 3 }, "PageUp", { ids, pageSize: 10 }).next.activeIndex).toBe(0);
  });
  it("extends the selection with shift and toggles with space", () => {
    const start = keyboardNav(base, "j", { ids }).next;
    const ext = keyboardNav(start, "ArrowDown", { ids, shift: true }).next;
    expect(ext.selected).toEqual(["a", "b"]);
    expect(ext.anchorId).toBe("a");
    const ext2 = keyboardNav(ext, "j", { ids, shift: true }).next;
    expect(ext2.selected).toEqual(["a", "b", "c"]);
    const sp = keyboardNav(ext2, " ", { ids }).next;
    expect(sp.selected).toEqual(["a", "b"]);
    expect(keyboardNav(sp, " ", { ids, mode: "single" }).next.selected).toEqual(["c"]);
  });
  it("activates, clears and selects all", () => {
    expect(keyboardNav({ ...base, activeIndex: 1 }, "Enter", { ids }).action).toBe("activate");
    expect(keyboardNav(base, "Enter", { ids }).action).toBe("none");
    const cleared = keyboardNav({ activeIndex: 1, selected: ["a"], anchorId: "a" }, "Escape", { ids });
    expect(cleared.action).toBe("clear");
    expect(cleared.next.selected).toEqual([]);
    const all = keyboardNav(base, "a", { ids, meta: true });
    expect(all.action).toBe("select-all");
    expect(all.next.selected).toEqual(ids);
    expect(keyboardNav(base, "a", { ids }).action).toBe("none");
    expect(keyboardNav(base, "x", { ids }).next).toBe(base);
    expect(keyboardNav(base, "j", { ids: [] }).next).toBe(base);
    expect(keyboardNav(base, "j", { ids, mode: "none" }).next.selected).toEqual([]);
  });
});

describe("DataTable columns", () => {
  const cols = [{ id: "name", width: 200, locked: true }, { id: "n", minWidth: 80 }, { id: "hidden", defaultHidden: true }];
  it("hides, shows and locks columns", () => {
    expect(defaultHiddenColumns(cols)).toEqual(["hidden"]);
    expect(visibleColumns(cols, ["hidden", "name"]).map((c) => c.id)).toEqual(["name", "n"]);
    expect(toggleColumn(cols, [], "name")).toEqual([]);
    expect(toggleColumn(cols, [], "n")).toEqual(["n"]);
    expect(toggleColumn(cols, ["n"], "n")).toEqual([]);
  });
  it("clamps widths and resizes from a drag delta", () => {
    expect(clampWidth(10)).toBe(48);
    expect(clampWidth(5000)).toBe(1200);
    expect(clampWidth(NaN)).toBe(48);
    expect(columnWidth(cols[0], undefined)).toBe(200);
    expect(columnWidth(cols[1], undefined)).toBe(160);
    expect(columnWidth(cols[1], { n: 20 })).toBe(80);
    expect(resizeColumn({}, cols[1], 160, -200)).toEqual({ n: 80 });
    expect(resizeColumn({ name: 300 }, cols[0], 300, 25)).toEqual({ name: 325 });
    expect(totalWidth(cols, {}, 32)).toBe(200 + 160 + 160 + 32);
    expect(ROW_HEIGHT.compact).toBeLessThanOrEqual(28);
    expect(ROW_HEIGHT.compact).toBeGreaterThanOrEqual(24);
  });
});

// ---------------------------------------------------------------------------
// Filterbar helpers
// ---------------------------------------------------------------------------

describe("Filterbar helpers", () => {
  it("normalises values, counts active filters and toggles single/multi values", () => {
    expect(normalizeValues({ a: "", b: null, c: undefined, d: ["y", "x", "x"], e: "v", f: [] })).toEqual({ d: ["x", "y"], e: "v" });
    expect(activeFilterCount({ a: "", d: ["x"], e: "v" })).toBe(2);
    expect(activeFilters({ e: "v" })).toEqual([{ id: "e", value: "v" }]);
    expect(toggleFilterValue({}, "type", "pdf")).toEqual({ type: "pdf" });
    expect(toggleFilterValue({ type: "pdf" }, "type", "pdf")).toEqual({ type: undefined });
    expect(toggleFilterValue({ type: "pdf" }, "type", "")).toEqual({ type: undefined });
    expect(toggleFilterValue({}, "tags", "a", { multi: true })).toEqual({ tags: ["a"] });
    expect(toggleFilterValue({ tags: ["a"] }, "tags", "b", { multi: true })).toEqual({ tags: ["a", "b"] });
    expect(toggleFilterValue({ tags: ["a", "b"] }, "tags", "a", { multi: true })).toEqual({ tags: ["b"] });
    expect(toggleFilterValue({ tags: ["a"] }, "tags", "a", { multi: true })).toEqual({ tags: undefined });
    expect(clearFilters({ a: "1", b: ["x"] })).toEqual({ a: undefined, b: undefined });
    expect(clearFilters({ a: "1", b: ["x"] }, ["b"])).toEqual({ a: "1", b: undefined });
  });
  it("labels chips and matches quick search tokens", () => {
    const opt = (v: string) => ({ pdf: "PDF", docx: "Word" } as Record<string, string>)[v];
    expect(chipLabel("Type", undefined)).toBe("Type");
    expect(chipLabel("Type", "pdf", opt)).toBe("Type: PDF");
    expect(chipLabel("Type", ["pdf"], opt)).toBe("Type: PDF");
    expect(chipLabel("Type", ["pdf", "docx"], opt)).toBe("Type: 2 selected");
    expect(chipLabel("Owner", "p_x")).toBe("Owner: p_x");
    expect(matchesQuickSearch("Protective Order Tier 2", "tier order")).toBe(true);
    expect(matchesQuickSearch("Protective Order", "tier")).toBe(false);
    expect(matchesQuickSearch("anything", "   ")).toBe(true);
  });
  it("saves, matches, applies and deletes views", () => {
    const { views, view } = saveView([], "Draft PDFs", { values: { type: "pdf", status: "draft", q: "" }, query: " indemn ", extra: { sort: "updated" } }, "2026-09-24T09:00:00Z");
    expect(view.id).toBe("view_draft-pdfs");
    expect(view.values).toEqual({ status: "draft", type: "pdf" });
    expect(view.query).toBe("indemn");
    expect(views).toHaveLength(1);
    expect(viewMatches(view, { values: { status: "draft", type: "pdf" }, query: "indemn" })).toBe(true);
    expect(viewMatches(view, { values: { type: "pdf" }, query: "indemn" })).toBe(false);
    expect(findMatchingView(views, { values: { type: "pdf", status: "draft" }, query: "indemn" })?.id).toBe(view.id);
    const replaced = saveView(views, "draft pdfs", { values: { type: "docx" } }).views;
    expect(replaced).toHaveLength(1);
    expect(replaced[0].values).toEqual({ type: "docx" });
    const two = saveView(replaced, "Zed", { values: {} }).views;
    expect(two.map((v) => v.name)).toEqual(["draft pdfs", "Zed"]);
    expect(deleteView(two, "view_zed")).toHaveLength(1);
    expect(viewId("  ")).toBe("view_untitled");
  });
  it("persists views to storage defensively", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
    storeViews(storage, "k", [{ id: "view_a", name: "A", values: {}, createdAt: "x" }]);
    expect(loadViews(storage, "k")).toHaveLength(1);
    store.set("k", "not json");
    expect(loadViews(storage, "k")).toEqual([]);
    store.set("k", JSON.stringify([{ nope: true }]));
    expect(loadViews(storage, "k")).toEqual([]);
    expect(loadViews(undefined, "k")).toEqual([]);
    expect(() => storeViews(undefined, "k", [])).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Form helpers
// ---------------------------------------------------------------------------

describe("FileDrop helpers", () => {
  it("normalises accept lists and matches by extension or MIME", () => {
    expect(normalizeAccept("pdf, .docx ,image/*")).toEqual([".pdf", ".docx", "image/*"]);
    expect(formatAccept([".pdf", "docx"])).toBe("PDF, DOCX");
    expect(acceptsFile("Brief.PDF", "application/pdf", [".pdf"])).toBe(true);
    expect(acceptsFile("photo.png", "image/png", ["image/*"])).toBe(true);
    expect(acceptsFile("photo.png", "image/png", ["application/pdf"])).toBe(false);
    expect(acceptsFile("x.bin", "", [])).toBe(true);
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(2048)).toBe("2.0 KB");
    expect(formatFileSize(15 * 1024 * 1024)).toBe("15 MB");
    expect(formatFileSize(-1)).toBe("");
  });
  it("merges files with dedupe, type, size and count limits", () => {
    const f = (name: string, size: number, type = "application/pdf") => ({ id: name, name, size, type });
    const r = addFiles([f("a.pdf", 10)], [f("a.pdf", 10), f("b.pdf", 10), f("c.txt", 10, "text/plain"), f("d.pdf", 999), f("e.pdf", 10)], { accept: [".pdf"], maxSize: 100, maxFiles: 2 });
    expect(r.files.map((x) => x.name)).toEqual(["a.pdf", "b.pdf"]);
    expect(r.rejected).toEqual([{ name: "a.pdf", reason: "duplicate" }, { name: "c.txt", reason: "type" }, { name: "d.pdf", reason: "size" }, { name: "e.pdf", reason: "count" }]);
    expect(addFiles([f("a.pdf", 10)], [f("b.pdf", 10)], { multiple: false }).files.map((x) => x.name)).toEqual(["b.pdf"]);
    expect(describeFiles([])).toBe("No files");
    expect(describeFiles([f("a", 1024), f("b", 1024)])).toBe("2 files · 2.0 KB");
  });
  it("flattens folder trees with depth and path", () => {
    const flat = flattenFolders([{ id: "r", name: "Matters", children: [{ id: "c", name: "Valsara", children: [] }] }, { id: "k", name: "Knowledge" }]);
    expect(flat.map((f) => [f.id, f.depth, f.path])).toEqual([["r", 0, "Matters"], ["c", 1, "Matters / Valsara"], ["k", 0, "Knowledge"]]);
  });
});

// ---------------------------------------------------------------------------
// Shortcut help
// ---------------------------------------------------------------------------

describe("Shortcut help", () => {
  it("merges page groups over global groups and formats keys per platform", () => {
    const merged = mergeShortcutGroups(GLOBAL_SHORTCUTS, [{ id: "grid", title: "Grid", items: [{ keys: ["x"], label: "Next uncoded" }] }, { id: "page", title: "Page", items: [{ keys: ["a"], label: "Assistant" }] }, { id: "empty", title: "Empty", items: [] }]);
    expect(merged.find((g) => g.id === "grid")?.items).toEqual([{ keys: ["x"], label: "Next uncoded" }]);
    expect(merged.map((g) => g.id)).toEqual(["global", "go", "grid", "page"]);
    // The help dialog's "Go to" chords come from the nav: hidden surfaces (G I, G W, G E) are not advertised.
    const chords = GLOBAL_SHORTCUTS.flatMap((g) => g.items).map((i) => i.keys.join(" "));
    expect(chords).toEqual(expect.arrayContaining(["g h", "g s", "g j", "g a", "g k", "g u", "g o", "g ,"]));
    expect(chords.includes("g i")).toBe(FEATURES.intel);
    expect(chords.includes("g w")).toBe(FEATURES.workflows);
    expect(chords.includes("g e")).toBe(FEATURES.ediscovery);
    expect(formatKeys(["mod+k"], "mac")).toEqual(["⌘K"]);
    expect(formatKeys(["mod+k"], "other")).toEqual(["Ctrl K"]);
    expect(formatKeys(["g", "h"])).toEqual(["G", "H"]);
    expect(formatKeys(["shift+enter", "esc", "?"], "mac")).toEqual(["⇧↵", "Esc", "?"]);
    expect(detectPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X)")).toBe("mac");
    expect(detectPlatform("Mozilla/5.0 (X11; Linux x86_64)")).toBe("other");
    expect(detectPlatform(undefined)).toBe("other");
  });
  it("recognises typing targets", () => {
    expect(isTypingTarget({ tagName: "INPUT" })).toBe(true);
    expect(isTypingTarget({ tagName: "textarea" })).toBe(true);
    expect(isTypingTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(isTypingTarget({ tagName: "DIV" })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Current user, providers, shell
// ---------------------------------------------------------------------------

describe("current user", () => {
  it("falls back to the workspace owner or a neutral placeholder and honours a valid env override", () => {
    expect(resolveUserId(undefined)).toBe(DEFAULT_USER.id);
    expect(resolveUserId({ LECLAUDE_USER_ID: "  " })).toBe(DEFAULT_USER.id);
    expect(resolveUserId({ LECLAUDE_USER_ID: "p_praman" })).toBe("p_praman");
    expect(resolveUserId({ LECLAUDE_USER_ID: "bad id!" })).toBe(DEFAULT_USER.id);
    const prev = process.env.LECLAUDE_USER_ID;
    delete process.env.LECLAUDE_USER_ID;
    setWorkspaceUser(null);
    expect(currentUser()).toEqual({ id: DEFAULT_USER.id, name: DEFAULT_USER.name });
    setWorkspaceUser({ id: "p_jwhitfield", name: "Arjun Mehra" });
    expect(currentUser()).toEqual({ id: "p_jwhitfield", name: "Arjun Mehra" });
    expect(currentUser((id) => (id === "p_jwhitfield" ? "Jordan W." : undefined)).name).toBe("Jordan W.");
    process.env.LECLAUDE_USER_ID = "p_praman";
    expect(currentUser()).toEqual({ id: "p_praman", name: "p_praman" });
    expect(currentUser((id) => (id === "p_praman" ? "Priya Raman" : undefined))).toEqual({ id: "p_praman", name: "Priya Raman" });
    if (prev === undefined) delete process.env.LECLAUDE_USER_ID; else process.env.LECLAUDE_USER_ID = prev;
  });
});

describe("providers route logic", () => {
  it("reports configuration from env presence only", () => {
    const empty = providerStatuses({});
    const byId = Object.fromEntries(empty.map((p) => [p.id, p]));
    expect(byId.openai.state).toBe("missing");
    expect(byId.courtlistener.state).toBe("public");
    expect(byId.govinfo.state).toBe("public");
    expect(byId.firecrawl.state).toBe("missing");
    expect(byId.tavily.state).toBe("missing");
    expect(byId.openfda.state).toBe("public");
    expect(byId["local-corpus"].state).toBe("missing");
    expect(byId.ecfr.state).toBe("public");
    const full = providerStatuses({ OPENAI_API_KEY: "sk-secret", COURTLISTENER_API_TOKEN: "t", GOVINFO_API_KEY: "real", FIRECRAWL_API_KEY: "f", TAVILY_API_KEY: "tv", OPENFDA_API_KEY: "o", LECLAUDE_CORPUS_DIRS: "/a, /b,, /c" });
    expect(full.filter((p) => p.id !== "ecfr" && p.id !== "federal-register").every((p) => p.state === "configured")).toBe(true);
    expect(full.find((p) => p.id === "ecfr")?.state).toBe("public");
    expect(full.find((p) => p.id === "local-corpus")?.detail).toBe("3 folders");
    expect(JSON.stringify(full)).not.toContain("sk-secret");
    expect(providerStatuses({ GOVINFO_API_KEY: "DEMO_KEY" }).find((p) => p.id === "govinfo")?.state).toBe("public");
    expect(corpusDirs({ LECLAUDE_CORPUS_DIRS: " /x , /y " })).toEqual(["/x", "/y"]);
  });
  it("builds the payload with a summary, background mode and data dir", () => {
    const p = providersPayload({ LECLAUDE_BACKGROUND: "cron", LECLAUDE_DATA_DIR: "/tmp/x" });
    expect(p.background).toBe("cron");
    expect(p.dataDir).toBe("/tmp/x");
    expect(p.summary.configured + p.summary.public + p.summary.missing).toBe(p.providers.length);
    expect(providersPayload({ LECLAUDE_BACKGROUND: "weird" }).background).toBe("inline");
    expect(providersPayload({}).dataDir).toBe("./data");
  });
});

describe("shell", () => {
  it("hides Intelligence (and its G I chord) unless the switch is on; Research keeps G S", () => {
    const labels = NAV.map((n) => n.label);
    expect(labels.includes("Intelligence")).toBe(FEATURES.intel);
    expect(GO_CHORD.i).toBe(FEATURES.intel ? "/intel" : undefined);
    expect(NAV.find((n) => n.label === "Research")?.href).toBe("/search");
    expect(GO_CHORD.s).toBe("/search");
  });
  it("groups palette commands and carries the query into the research command", () => {
    const sections = paletteSections({ query: "  Boyle defense ", nav: [{ label: "Home", href: "/", shortcut: "G H" }] });
    expect(sections.map((s) => s.id)).toEqual(["create", "go", "actions", "integrity", "preferences"]);
    const research = sections.find((s) => s.id === "actions")!.commands[0];
    expect(research.label).toBe("Research: “Boyle defense”");
    expect(research.href).toBe("/search?q=Boyle%20defense");
    expect(sections.find((s) => s.id === "go")!.commands[0]).toMatchObject({ href: "/", shortcut: "G H" });
    expect(paletteSections({ query: "", nav: [] }).find((s) => s.id === "actions")!.commands[0].label).toBe("Start research");
    expect(sections.find((s) => s.id === "preferences")!.commands.some((c) => c.action === "shortcuts")).toBe(true);
  });
  it("lists the five settings sections in order and maps hashes to sections", () => {
    expect(SETTINGS_GROUPS.map((g) => g.id)).toEqual(["ai", "research", "data", "integrity", "about"]);
    expect(sectionForHash("#review")).toBe("integrity");
    expect(sectionForHash("data")).toBe("data");
    expect(sectionForHash("#nope")).toBeUndefined();
  });
});
