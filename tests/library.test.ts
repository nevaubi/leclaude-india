import { beforeAll, describe, expect, it } from "vitest";
import { FEATURES } from "@/lib/features";
import { db, resetSqlite } from "@/lib/db";
import type { LibraryItem, OfficeDocument } from "@/lib/types/domain";
import { MATTERS, PEOPLE } from "@/lib/seed/ids";
import { LIBRARY_FOLDERS, matterFolderId } from "@/modules/library/ids";
import { breadcrumbsFor, buildTree, descendantIds, findNode, flattenTree, isDescendant, validateMove } from "@/modules/library/tree";
import { clauseDiffSummary, extractVariables, fillClause, variableSpecs } from "@/modules/library/clauses";
import { orphanedOfficeEntries, planOfficeDocMerge } from "@/modules/library/merge";
import { parseFilters, filtersToParams, activeFilterCount } from "@/modules/library/filters";
import { LIBRARY_SEED_IDS, matterSubfolderId, seedLibrary } from "@/modules/library/seed";
import { clauseMetaCollection } from "@/modules/library/data";
import { autoTagItem, compareClause, createItem, deleteItem, duplicateItem, fillClauseItem, getItemDetail, indexStatus, listActivity, listClauses, listItems, listVersions, moveItems, NoApiKeyError, rebuildIndex, searchLibrary, summarizeItem, syncOfficeDocs, treeResponse, updateItem } from "@/modules/library/service";
import { createOfficeDoc } from "@/modules/office/shared/docs-service";
import { markdownToDoc } from "@/modules/office/shared/markdown-doc";
import { listOfficeDocSummaries, officeHomeData } from "@/modules/office/home/service";

beforeAll(() => { resetSqlite(); db(); });

describe("library seed", () => {
  it("seeds folders, templates, clauses, notes, links and uploads with stable ids", () => {
    const d = db();
    const items = d.library.all();
    const nonFolder = items.filter((i) => i.type !== "folder");
    expect(nonFolder.length).toBeGreaterThanOrEqual(45);
    expect(items.filter((i) => i.type === "clause").length).toBeGreaterThanOrEqual(15);
    expect(items.filter((i) => i.type === "note").length).toBeGreaterThanOrEqual(10);
    expect(items.filter((i) => i.type === "link").length).toBeGreaterThanOrEqual(4);
    expect(items.filter((i) => i.type === "template").length).toBeGreaterThanOrEqual(13);
    for (const id of Object.values(LIBRARY_FOLDERS)) expect(d.library.get(id)?.type).toBe("folder");
    for (const m of Object.values(MATTERS)) expect(d.library.get(matterFolderId(m))?.parentId).toBe(LIBRARY_FOLDERS.matters);
    expect(d.library.get(matterSubfolderId(MATTERS.afff, "Depositions"))?.parentId).toBe(matterFolderId(MATTERS.afff));
    for (const id of LIBRARY_SEED_IDS.clauses) {
      const it = d.library.get(id)!;
      expect(it.type).toBe("clause");
      expect(it.content!.length).toBeGreaterThan(400);
      const meta = clauseMetaCollection().get(id)!;
      expect(meta.category).toBeTruthy();
      expect(extractVariables(it.content!).length).toBeGreaterThan(0);
    }
    for (const id of LIBRARY_SEED_IDS.notes) expect(d.library.get(id)!.content!.length).toBeGreaterThan(800);
    // no lorem ipsum anywhere, and no duplicate tags on any item (React keys)
    expect(items.some((i) => /lorem ipsum|sample text/i.test(`${i.name} ${i.content ?? ""}`))).toBe(false);
    const dupes = items.filter((i) => i.id.startsWith("lib_") && !i.id.startsWith("lib_word_") && i.tags && new Set(i.tags).size !== i.tags.length).map((i) => `${i.id}: ${i.tags!.join(",")}`);
    expect(dupes).toEqual([]);
  });
  it("is idempotent", () => {
    const d = db();
    const before = d.library.count();
    seedLibrary(d);
    expect(d.library.count()).toBe(before);
  });
  it("builds a keyword index for textual items", () => {
    const s = indexStatus();
    expect(s.docs).toBeGreaterThanOrEqual(45);
    expect(s.chunks).toBeGreaterThan(s.docs);
  });
});

describe("folder tree", () => {
  it("builds roots in canonical order with direct and recursive counts", () => {
    const d = db();
    const roots = buildTree(d.library.all());
    const ids = roots.map((r) => r.id);
    expect(ids.slice(0, 6)).toEqual([LIBRARY_FOLDERS.firm, LIBRARY_FOLDERS.matters, LIBRARY_FOLDERS.templates, LIBRARY_FOLDERS.clauses, LIBRARY_FOLDERS.knowledge, LIBRARY_FOLDERS.myFiles]);
    const clauses = findNode(roots, LIBRARY_FOLDERS.clauses)!;
    expect(clauses.count).toBe(d.library.count((i) => i.type === "clause" && i.parentId === LIBRARY_FOLDERS.clauses));
    const knowledge = findNode(roots, LIBRARY_FOLDERS.knowledge)!;
    expect(knowledge.count).toBe(0);
    expect(knowledge.children.length).toBe(4);
    expect(knowledge.totalCount).toBe(knowledge.children.reduce((n, c) => n + c.totalCount, 0));
    expect(knowledge.totalCount).toBeGreaterThanOrEqual(10);
    const matters = findNode(roots, LIBRARY_FOLDERS.matters)!;
    expect(matters.children.length).toBe(5);
    expect(matters.children.every((c) => c.system && c.matterId)).toBe(true);
    expect(flattenTree(roots).length).toBeGreaterThan(20);
    expect(flattenTree(roots, new Set()).length).toBe(roots.length);
  });
  it("computes breadcrumbs and descendants", () => {
    const items = db().library.all();
    const depo = matterSubfolderId(MATTERS.afff, "Depositions");
    expect(breadcrumbsFor(items, depo).map((b) => b.name)).toEqual(["Matters", "AFFF / PFAS", "Depositions"]);
    expect(isDescendant(items, depo, LIBRARY_FOLDERS.matters)).toBe(true);
    expect(isDescendant(items, LIBRARY_FOLDERS.matters, depo)).toBe(false);
    expect(descendantIds(items, LIBRARY_FOLDERS.knowledge)).toContain("lib_note_bluebook_quick_guide");
  });
  it("validates moves: no cycles, no non-folder targets, no system folders, no no-ops", () => {
    const items = db().library.all();
    const lit = "lib_folder_knowledge_litigation";
    expect(validateMove(items, [LIBRARY_FOLDERS.knowledge], lit).ok).toBe(false); // system folder anyway
    // create a user folder chain to test the cycle rule without system folders
    const a: LibraryItem = { id: "t_a", parentId: null, name: "A", type: "folder", createdAt: "2026-01-01", updatedAt: "2026-01-01" };
    const b: LibraryItem = { id: "t_b", parentId: "t_a", name: "B", type: "folder", createdAt: "2026-01-01", updatedAt: "2026-01-01" };
    const c: LibraryItem = { id: "t_c", parentId: "t_b", name: "C", type: "folder", createdAt: "2026-01-01", updatedAt: "2026-01-01" };
    const n: LibraryItem = { id: "t_n", parentId: "t_a", name: "N", type: "note", createdAt: "2026-01-01", updatedAt: "2026-01-01" };
    const all = [...items, a, b, c, n];
    expect(validateMove(all, ["t_a"], "t_c")).toMatchObject({ ok: false });
    expect(validateMove(all, ["t_a"], "t_c").reason).toMatch(/own subfolders/);
    expect(validateMove(all, ["t_a"], "t_a").reason).toMatch(/into itself/);
    expect(validateMove(all, ["t_n"], "t_n").reason).toMatch(/not a folder/);
    expect(validateMove(all, ["t_n"], "t_a").reason).toMatch(/Nothing to move/);
    expect(validateMove(all, ["t_n"], "nope").reason).toMatch(/does not exist/);
    expect(validateMove(all, ["t_c", "t_n"], null)).toEqual({ ok: true, ids: ["t_c", "t_n"] });
    expect(validateMove(all, ["t_n"], "t_c")).toEqual({ ok: true, ids: ["t_n"] });
  });
});

describe("clause variables", () => {
  it("extracts and fills variables, bracketing missing ones", () => {
    const text = "{{Party A}} shall indemnify {{Party B}} under {{ Governing Law }}. {{Party A}} again.";
    expect(extractVariables(text)).toEqual(["Party A", "Party B", "Governing Law"]);
    const r = fillClause(text, { "Party A": "Meridian", "Governing Law": "Delaware law" });
    expect(r.text).toBe("Meridian shall indemnify [Party B] under Delaware law. Meridian again.");
    expect(r.filled).toEqual(["Party A", "Governing Law"]);
    expect(r.missing).toEqual(["Party B"]);
    const specs = variableSpecs(text, [{ name: "Party B", description: "Customer" }, { name: "Unused", example: "x" }]);
    expect(specs.map((s) => s.name)).toEqual(["Party A", "Party B", "Governing Law", "Unused"]);
    expect(specs[1].description).toBe("Customer");
  });
  it("summarizes structural differences heuristically", () => {
    const d = clauseDiffSummary("A. B. C.", "A. C. D.");
    expect(d.onlyInStandard).toEqual(["B."]);
    expect(d.onlyInCandidate).toEqual(["D."]);
    expect(d.sameSentenceCount).toBe(2);
  });
  it("fills a seeded clause and creates a Word document in the matter folder", () => {
    const meta = clauseMetaCollection().get("lib_clause_lol_cap")!;
    const values: Record<string, string> = {};
    for (const v of meta.variables) values[v.name] = v.example ?? "X";
    const r = fillClauseItem("lib_clause_lol_cap", { values, createDoc: true, matterId: MATTERS.harbor, title: "LoL clause for Harbor SPA" });
    expect(r.missing).toEqual([]);
    expect(r.markdown).toContain("Harborline Technologies, Inc.");
    expect(r.markdown).not.toContain("{{");
    expect(r.doc?.kind).toBe("word");
    expect(r.url).toBe(`/office/word/${r.doc!.id}`);
    const row = db().library.get(r.libraryItemId!)!;
    expect(row.parentId).toBe(matterFolderId(MATTERS.harbor));
    expect(row.officeDocId).toBe(r.doc!.id);
    expect(clauseMetaCollection().get("lib_clause_lol_cap")!.useCount).toBe((meta.useCount ?? 0) + 1);
    expect(listActivity({ itemId: "lib_clause_lol_cap", limit: 1 })[0].action).toBe("inserted");
  });
  it("lists the clause bank grouped by category", () => {
    const r = listClauses();
    expect(r.clauses.length).toBeGreaterThanOrEqual(15);
    expect(r.categories.find((c) => c.category === "indemnity")?.count).toBeGreaterThanOrEqual(2);
    expect(listClauses({ category: "deposition stipulations" }).clauses.every((c) => c.clause?.category === "deposition stipulations")).toBe(true);
  });
});

describe("office document merge", () => {
  const folders = new Set([LIBRARY_FOLDERS.myFiles, matterFolderId(MATTERS.afff)]);
  const doc = (id: string, extra: Partial<OfficeDocument> = {}): OfficeDocument => ({ id, kind: "word", title: `Doc ${id}`, content: {}, contentVersion: 2, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-02T00:00:00Z", createdById: PEOPLE.elenaMarsh, size: 10, ...extra });
  it("creates entries in the matter folder for docs without one, and re-homes root-level entries", () => {
    const docs = [doc("d1", { matterId: MATTERS.afff }), doc("d2"), doc("d3", { matterId: MATTERS.afff })];
    const existing: LibraryItem = { id: "lib_x", parentId: null, name: "Old title", type: "docx", officeDocId: "d3", matterId: MATTERS.afff, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" };
    const plan = planOfficeDocMerge(docs, [existing], { existingFolderIds: folders });
    expect(plan.create.map((c) => [c.officeDocId, c.parentId, c.type])).toEqual([["d1", matterFolderId(MATTERS.afff), "docx"], ["d2", LIBRARY_FOLDERS.myFiles, "docx"]]);
    expect(plan.update).toEqual([{ id: "lib_x", patch: { parentId: matterFolderId(MATTERS.afff), name: "Doc d3", updatedAt: "2026-09-02T00:00:00Z", size: 10, version: 2 } }]);
    // idempotent: applying the plan yields an empty plan
    const after = [ ...plan.create, { ...existing, ...plan.update[0].patch } ];
    const plan2 = planOfficeDocMerge(docs, after, { existingFolderIds: folders });
    expect(plan2.create).toEqual([]);
    expect(plan2.update).toEqual([]);
    expect(orphanedOfficeEntries(new Set(["d1"]), after).map((o) => o.officeDocId)).toEqual(["d2", "d3"]);
  });
  it("syncs real office documents into the library at read time", () => {
    const created = createOfficeDoc({ kind: "sheet", title: "Exposure model — Sterling", content: { sheets: [] }, matterId: MATTERS.sterling });
    expect(db().library.findOne((l) => l.officeDocId === created.id)).toBeNull();
    const r = syncOfficeDocs(true);
    expect(r.created).toBeGreaterThanOrEqual(1);
    const row = db().library.findOne((l) => l.officeDocId === created.id)!;
    expect(row.parentId).toBe(matterFolderId(MATTERS.sterling));
    expect(row.type).toBe("xlsx");
    const list = listItems({ folder: matterFolderId(MATTERS.sterling) });
    expect(list.items.some((i) => i.officeDocId === created.id && i.officeKind === "sheet")).toBe(true);
    const summaries = listOfficeDocSummaries({ kind: "sheet" });
    const home = officeHomeData("sheet");
    if (!FEATURES.officeAll) {
      // LeClaude India offers Word only: workbooks stay in the library but are not listed on the Office home.
      expect(summaries.find((x) => x.id === created.id)).toBeUndefined();
      expect(home.counts.sheet).toBe(0);
      expect(home.templates.every((t) => t.kind === "word")).toBe(true);
      return;
    }
    const s = summaries.find((x) => x.id === created.id)!;
    expect(s.versionCount).toBe(1);
    expect(s.matterShortName).toBe("Sterling Medical");
    expect(s.libraryItemId).toBe(row.id);
    expect(home.docs.every((x) => x.kind === "sheet")).toBe(true);
    expect(home.counts.sheet).toBeGreaterThanOrEqual(1);
    expect(home.templates.length).toBeGreaterThan(0);
  });
});

describe("library service", () => {
  it("lists folders, virtual views and filtered subtrees", () => {
    const root = listItems({});
    expect(root.items.every((i) => i.type === "folder")).toBe(true);
    expect(root.items[0].id).toBe(LIBRARY_FOLDERS.firm);
    const clauses = listItems({ folder: LIBRARY_FOLDERS.clauses, sort: "updated" });
    expect(clauses.folder?.name).toBe("Clause bank");
    expect(clauses.items.every((i) => i.type === "clause" && i.clause)).toBe(true);
    expect(clauses.items[0].updatedAt >= clauses.items[1].updatedAt).toBe(true);
    const starred = listItems({ view: "starred" });
    expect(starred.items.length).toBeGreaterThanOrEqual(5);
    const shared = listItems({ view: "shared" });
    expect(shared.items.every((i) => i.ownerId !== PEOPLE.jordanWhitfield)).toBe(true);
    const filtered = listItems({ folder: LIBRARY_FOLDERS.knowledge, type: "link" });
    expect(filtered.items.length).toBeGreaterThanOrEqual(4);
    expect(filtered.items.every((i) => i.type === "link")).toBe(true);
    const byMatter = listItems({ view: "all", matterId: MATTERS.northgate });
    expect(byMatter.items.every((i) => i.matterId === MATTERS.northgate)).toBe(true);
    expect(byMatter.items.length).toBeGreaterThanOrEqual(2);
    const byTag = listItems({ view: "all", tag: "PAGA" });
    expect(byTag.items.some((i) => i.id === "lib_note_paga_2024_reform")).toBe(true);
    expect(listItems({ folder: "does-not-exist" }).items).toEqual([]);
  });
  it("creates, versions, moves, duplicates and deletes items", () => {
    const note = createItem({ type: "note", name: "Hearing prep — Sept 30", parentId: matterSubfolderId(MATTERS.northgate, "Briefing"), content: "# Prep\n\n- Confirm page limit motion" });
    expect(note.matterId).toBe(MATTERS.northgate);
    expect(note.path.map((p) => p.name)).toEqual(["Matters", "Northgate v. Apex", "Briefing"]);
    expect(note.version).toBe(1);
    const v2 = updateItem(note.id, { content: "# Prep\n\n- Confirm page limit motion\n- Pull Judge Ellis standing order", versionSummary: "Added standing order" })!;
    expect(v2.version).toBe(2);
    const versions = listVersions(note.id);
    expect(versions.map((v) => v.version)).toEqual([2, 1]);
    const restored = updateItem(note.id, { restoreVersion: 1 })!;
    expect(restored.version).toBe(3);
    expect(restored.content).toBe("# Prep\n\n- Confirm page limit motion");
    expect(updateItem(note.id, { starred: true })!.starred).toBe(true);
    expect(updateItem(note.id, { tags: ["prep", "Prep", "hearing"] })!.tags).toEqual(["prep", "hearing"]);
    const renamed = updateItem(note.id, { name: "Hearing prep — Oct 1" })!;
    expect(renamed.name).toBe("Hearing prep — Oct 1");
    const folder = createItem({ type: "folder", name: "Hearing binders", parentId: LIBRARY_FOLDERS.myFiles });
    expect(folder.sharedWith).toEqual(["private"]);
    expect(moveItems([note.id], folder.id).moved).toEqual([note.id]);
    expect(getItemDetail(note.id)!.item.parentId).toBe(folder.id);
    expect(() => moveItems([folder.id], folder.id)).toThrow(/into itself/);
    expect(() => moveItems([LIBRARY_FOLDERS.knowledge], folder.id)).toThrow(/system folder/);
    const dup = duplicateItem(note.id)!;
    expect(dup.name).toBe("Copy of Hearing prep — Oct 1");
    expect(dup.parentId).toBe(folder.id);
    const detail = getItemDetail(folder.id)!;
    expect(detail.children!.length).toBe(2);
    expect(detail.activity.length).toBeGreaterThan(0);
    const del = deleteItem(folder.id);
    expect(del.deleted.sort()).toEqual([dup.id, folder.id, note.id].sort());
    expect(db().library.get(note.id)).toBeNull();
    expect(() => deleteItem(LIBRARY_FOLDERS.clauses)).toThrow(/system folder/);
    expect(() => createItem({ type: "link", name: "No url" })).toThrow(/URL/);
  });
  it("creates clauses with metadata and duplicates office-backed items", () => {
    const clause = createItem({ type: "clause", name: "Test non-solicit", parentId: LIBRARY_FOLDERS.clauses, content: "{{Party A}} shall not solicit employees of {{Party B}} for {{Term}}.", clause: { category: "termination", stance: "pro-client", variables: [{ name: "Term", example: "12 months" }] } });
    expect(clause.clause?.category).toBe("termination");
    expect(clause.clause?.variables.map((v) => v.name)).toEqual(["Party A", "Party B", "Term"]);
    expect(clause.clause?.variables[2].example).toBe("12 months");
    const doc = createOfficeDoc({ kind: "word", title: "Dup me", content: markdownToDoc("# Hello\n\nWorld"), matterId: MATTERS.afff });
    syncOfficeDocs(true);
    const row = db().library.findOne((l) => l.officeDocId === doc.id)!;
    const dup = duplicateItem(row.id)!;
    expect(dup.officeDocId).not.toBe(doc.id);
    expect(db().officeDocs.get(dup.officeDocId!)?.title).toBe("Copy of Dup me");
    const renamed = updateItem(dup.id, { name: "Dup renamed" })!;
    expect(db().officeDocs.get(dup.officeDocId!)?.title).toBe("Dup renamed");
    expect(renamed.name).toBe("Dup renamed");
    deleteItem(dup.id);
    expect(db().officeDocs.get(dup.officeDocId!)).toBeNull();
    deleteItem(clause.id);
  });
  it("searches with keyword ranking and passages across notes and office docs", async () => {
    const r = await searchLibrary("PAGA manageability cure");
    expect(r.mode).toBe("keyword");
    expect(r.hits[0].item.id).toBe("lib_note_paga_2024_reform");
    expect(r.hits[0].passage.toLowerCase()).toContain("paga");
    const clauses = await searchLibrary("consequential damages", { type: "clause" });
    expect(clauses.hits.every((h) => h.item.type === "clause")).toBe(true);
    expect(clauses.hits.some((h) => h.item.id === "lib_clause_lol_consequential_transport")).toBe(true);
    const scoped = await searchLibrary("Bluebook", { folder: LIBRARY_FOLDERS.clauses });
    expect(scoped.hits.length).toBe(0);
    const office = await searchLibrary("Dup me Hello World");
    expect(office.hits.some((h) => h.source === "office")).toBe(true);
    expect((await searchLibrary("   ")).hits).toEqual([]);
  });
  it("rebuilds the index keyword-only without a key", async () => {
    const r = await rebuildIndex();
    expect(r.embed).toBe(false);
    expect(r.library.docs).toBeGreaterThanOrEqual(45);
    expect(r.office.docs).toBeGreaterThanOrEqual(1);
    expect(r.status.embedded).toBe(0);
  });
  it("returns the tree response with counts, matters and tags", () => {
    const t = treeResponse();
    expect(t.roots.length).toBeGreaterThanOrEqual(6);
    expect(t.views.all).toBeGreaterThanOrEqual(45);
    expect(t.matters.length).toBe(5);
    expect(t.tags[0].count).toBeGreaterThan(1);
    expect(t.aiConfigured).toBe(false);
  });
  it("fails gracefully without an OpenAI key", async () => {
    await expect(summarizeItem("lib_note_bluebook_quick_guide")).rejects.toBeInstanceOf(NoApiKeyError);
    expect(await autoTagItem("lib_note_bluebook_quick_guide")).toEqual({ skipped: true, reason: "no_api_key" });
    const cmp = await compareClause("lib_clause_indemnity_ip_vendor", {});
    expect(cmp.mode).toBe("heuristic");
    expect(cmp.standardName).toBe("Mutual indemnification (services agreement)");
    expect(cmp.analysis).toContain("Heuristic comparison");
    await expect(compareClause("lib_clause_force_majeure", {})).rejects.toThrow(/no firm standard/);
    const pasted = await compareClause("lib_clause_force_majeure", { text: "Neither party is liable for delays caused by acts of God." });
    expect(pasted.mode).toBe("heuristic");
  });
});

describe("filters", () => {
  it("round-trips query params", () => {
    const f = parseFilters(new URLSearchParams("view=starred&type=clause&matter=m_afff_2873&sort=updated&dir=desc&tag=PFAS&from=2026-01-01"));
    expect(f).toMatchObject({ view: "starred", type: "clause", matterId: "m_afff_2873", sort: "updated", dir: "desc", tag: "PFAS", from: "2026-01-01", folder: null });
    expect(activeFilterCount(f)).toBe(4);
    expect(filtersToParams(f).toString()).toBe("view=starred&matter=m_afff_2873&type=clause&tag=PFAS&from=2026-01-01&sort=updated&dir=desc");
    expect(parseFilters(new URLSearchParams("view=bogus&sort=bogus")).view).toBe("folder");
  });
});
