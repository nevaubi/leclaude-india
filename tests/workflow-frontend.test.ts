import { describe, expect, it } from "vitest";
import type { WorkflowEdge, WorkflowFrontend, WorkflowNode } from "@/lib/types/domain";
import { emptyFrontend, fieldKeyFor, fileAccepted, frontendFor, frontendFromInputs, groupFields, inputTypeForField, joinFileTexts, mapFrontendValues, OUTPUT_FORMATS, syncInputsFromFrontend, validateFrontendValues } from "@/modules/workflows/frontend";
import { describeAfter, hasOutputStep, initialFieldValues, initialOutputChoice, outputFormats, sections, stepPreviews, withOutputValues } from "@/modules/workflows/components/frontend/frontend-helpers";
import { addField, moveField, removeField, renameFieldKey, updateField } from "@/modules/workflows/components/builder/frontend-editor-ops";
import { nodeSummary } from "@/modules/workflows/components/node-summary";
import { filterWorkflows, startHref } from "@/modules/workflows/components/gallery/gallery-helpers";
import { defaultConfigFor } from "@/modules/workflows/registry";
import { buildTemplates, buildUsTemplates, TEMPLATE_FRONTENDS } from "@/modules/workflows/templates";
import type { WorkflowListItem } from "@/modules/workflows/types";

const FE: WorkflowFrontend = {
  title: "Review an NDA",
  fields: [
    { key: "nda", label: "NDA", type: "file", required: true, accept: [".docx", ".pdf"] },
    { key: "exhibits", label: "Exhibits", type: "files", accept: [".pdf"] },
    { key: "matter", label: "Matter", type: "matter", required: true },
    { key: "side", label: "Our side", type: "select", required: true, options: ["Receiving", "Disclosing"] },
    { key: "checks", label: "Checks", type: "multiselect", options: ["Term", "Venue"] },
    { key: "rush", label: "Rush", type: "toggle" },
    { key: "due", label: "Due", type: "date" },
    { key: "pages", label: "Pages", type: "number" },
    { key: "prefix", label: "Bates prefix", type: "bates-prefix" },
    { key: "reviewer", label: "Reviewer", type: "person", group: "Routing" },
  ],
  output: { formats: ["docx", "pdf"], defaultFormat: "pdf", defaultLabel: "NDA review — {{now | date:short}}", libraryFolderId: "fld_x" },
  after: { createTask: { title: "Read the memo", dueRule: "+2d" }, triggerWorkflowIds: ["wf_next"] },
};

const file = (name: string, text = "hello", mime = "application/pdf") => ({ blobId: `blob_${name}`, name, mime, size: 10, text });

describe("front-end validation", () => {
  it("accepts files by extension or MIME and rejects the rest", () => {
    expect(fileAccepted("a.PDF", "application/pdf", [".pdf"])).toBe(true);
    expect(fileAccepted("a.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", [".pdf"])).toBe(false);
    expect(fileAccepted("a.png", "image/png", ["image/*"])).toBe(true);
    expect(fileAccepted("a.png", "image/png", [])).toBe(true);
    expect(fileAccepted("a.png", "image/png", undefined)).toBe(true);
  });
  it("reports required fields, accept lists, options, dates, numbers and Bates prefixes", () => {
    const errs = validateFrontendValues(FE, { exhibits: [file("x.docx", "t", "application/x")], side: "Neither", checks: ["Nope"], due: "12/01/2026", pages: "many", prefix: "bad prefix!" });
    const keys = Object.fromEntries(errs.map((e) => [e.key, e.message]));
    expect(keys.nda).toMatch(/Upload a file/);
    expect(keys.exhibits).toMatch(/accepted types/);
    expect(keys.matter).toBe("Required");
    expect(keys.side).toMatch(/Choose one of/);
    expect(keys.checks).toMatch(/Choose from/);
    expect(keys.due).toMatch(/YYYY-MM-DD/);
    expect(keys.pages).toMatch(/number/);
    expect(keys.prefix).toMatch(/Letters/);
  });
  it("accepts a valid form, pasted text for a file field and the engine's mapped shape", () => {
    expect(validateFrontendValues(FE, { nda: file("nda.pdf"), matter: "m_afff_2873", side: "Receiving", checks: ["Term"], due: "2026-10-01", pages: 12, prefix: "MFC-" })).toEqual([]);
    expect(validateFrontendValues(FE, { nda: "pasted text", matter: "m", side: "Receiving" })).toEqual([]);
    // Mapped inputs: the text lives under the key and the file sidecar under <key>_file.
    expect(validateFrontendValues(FE, { nda: "", nda_file: { blobId: "b", name: "x.pdf", mime: "application/pdf", size: 1 }, matter: "m", side: "Receiving" })).toEqual([]);
    expect(validateFrontendValues(FE, { nda: "", nda_file: { blobId: "b", name: "x.txt", mime: "text/plain", size: 1 }, matter: "m", side: "Receiving" }).map((e) => e.key)).toEqual(["nda"]);
    expect(validateFrontendValues(FE, { nda: file("nda.pdf"), matter: "m", side: "Receiving", pages: "" })).toEqual([]);
  });
});

describe("front-end input mapping", () => {
  it("maps files to text plus a sidecar, multi-files to arrays plus joined text, and coerces scalars", () => {
    const { inputs, matterId } = mapFrontendValues(FE, { nda: file("nda.pdf", "NDA TEXT"), exhibits: [file("a.pdf", "A"), file("b.pdf", "B")], matter: "m_afff_2873", side: "Receiving", checks: "Term, Venue", rush: "yes", due: "2026-10-01", pages: "12", prefix: "MFC-", reviewer: "p_emarsh" });
    expect(inputs.nda).toBe("NDA TEXT");
    expect(inputs.nda_file).toEqual({ blobId: "blob_nda.pdf", name: "nda.pdf", mime: "application/pdf", size: 10, pages: undefined, truncated: undefined });
    expect((inputs.exhibits as unknown[]).length).toBe(2);
    expect(inputs.exhibits_text).toBe("## a.pdf\n\nA\n\n## b.pdf\n\nB");
    expect(inputs.checks).toEqual(["Term", "Venue"]);
    expect(inputs.rush).toBe(true);
    expect(inputs.pages).toBe(12);
    expect(inputs.reviewer).toBe("p_emarsh");
    expect(matterId).toBe("m_afff_2873");
  });
  it("passes the output section through under the reserved keys, unless a field already carries it", () => {
    const a = mapFrontendValues(FE, { nda: "t", matter: "m", side: "Receiving", output_format: "pdf", output_label: "Memo", output_folder: "fld_1" }).inputs;
    expect(a).toMatchObject({ output_format: "pdf", output_label: "Memo", output_folder: "fld_1" });
    const fe2: WorkflowFrontend = { title: "x", fields: [{ key: "fmt", label: "Format", type: "output-format" }, { key: "name", label: "Label", type: "label" }, { key: "folder", label: "Folder", type: "library-folder" }] };
    const b = mapFrontendValues(fe2, { fmt: "xlsx", name: "Log", folder: "fld_2" }).inputs;
    expect(b).toMatchObject({ fmt: "xlsx", name: "Log", folder: "fld_2", output_format: "xlsx", output_label: "Log", output_folder: "fld_2" });
    expect(withOutputValues(FE, { nda: "t" }, { format: "pdf", label: " Memo ", folderId: "" })).toEqual({ nda: "t", output_format: "pdf", output_label: "Memo" });
    expect(withOutputValues(fe2, { fmt: "xlsx" }, { format: "pdf", label: "Memo", folderId: "f" })).toEqual({ fmt: "xlsx" });
    expect(withOutputValues(FE, { nda: "t" }, null)).toEqual({ nda: "t" });
  });
  it("caps joined file text", () => {
    const joined = joinFileTexts([file("a.txt", "x".repeat(300)), file("b.txt", "y".repeat(300))], 320);
    expect(joined.length).toBeLessThanOrEqual(320);
    expect(joined.startsWith("## a.txt")).toBe(true);
  });
  it("derives legacy inputs from a front end and a front end from legacy inputs", () => {
    const inputs = syncInputsFromFrontend(FE);
    expect(inputs.map((i) => [i.key, i.type])).toEqual([["nda", "file"], ["exhibits", "file"], ["matter", "matter"], ["side", "select"], ["checks", "select"], ["rush", "select"], ["due", "date"], ["pages", "number"], ["prefix", "text"], ["reviewer", "text"]]);
    expect(inputs.find((i) => i.key === "rush")!.options).toEqual(["true", "false"]);
    expect(inputTypeForField("output-format")).toBe("select");
    const fe = frontendFromInputs({ name: "Legacy", description: "d", inputs: [{ key: "doc", label: "Doc", type: "file", required: true }, { key: "q", label: "Q", type: "text" }] });
    expect(fe.title).toBe("Legacy");
    expect(fe.fields[0]).toMatchObject({ key: "doc", type: "file", required: true });
    expect(fe.fields[0].accept?.length).toBeGreaterThan(3);
    expect(frontendFor({ name: "n", inputs: [], frontend: FE })).toBe(FE);
    expect(frontendFor({ name: "n", inputs: [{ key: "a", label: "A", type: "text" }] }).fields).toHaveLength(1);
    expect(emptyFrontend("Go").output?.formats).toEqual(["docx"]);
    expect(fieldKeyFor("Our client is the", ["our_client_is_the"])).toBe("our_client_is_the_2");
    expect(fieldKeyFor("1st file", [])).toBe("_1st_file");
    expect(groupFields(FE.fields).map((g) => [g.group, g.fields.length])).toEqual([[undefined, 9], ["Routing", 1]]);
  });
});

describe("start page helpers", () => {
  const N = (id: string, type: WorkflowNode["type"], config: Record<string, unknown> = {}): WorkflowNode => ({ id, type, label: id, position: { x: 0, y: 0 }, config: { ...defaultConfigFor(type), ...config } });
  const E = (source: string, target: string, sourceHandle?: string, targetHandle?: string): WorkflowEdge => ({ id: `${source}-${target}-${sourceHandle ?? ""}`, source, target, sourceHandle, targetHandle });
  it("computes initial values, output choices and section groups", () => {
    const v = initialFieldValues(FE, { side: "Disclosing" });
    expect(v).toMatchObject({ nda: "", exhibits: [], checks: [], rush: false, side: "Disclosing", pages: "" });
    expect(initialOutputChoice(FE)).toEqual({ format: "pdf", label: "NDA review — {{now | date:short}}", folderId: "fld_x" });
    expect(initialOutputChoice({ title: "x", fields: [], output: { formats: ["md"], defaultFormat: "docx" } }).format).toBe("md");
    expect(initialOutputChoice(undefined).format).toBe(OUTPUT_FORMATS[0]);
    expect(outputFormats({ title: "x", fields: [] })).toEqual(OUTPUT_FORMATS);
    expect(sections(FE).map((s) => s.group)).toEqual([undefined, "Routing"]);
    expect(hasOutputStep([{ type: "ai.draft" }, { type: "output.file" }])).toBe(true);
    expect(hasOutputStep([{ type: "ai.draft" }])).toBe(false);
    expect(describeAfter(FE, { wf_next: "Cite-check" })).toEqual(['Creates the task "Read the memo" (due +2d).', 'Then starts "Cite-check".']);
    expect(describeAfter(undefined)).toEqual([]);
  });
  it("lists the steps in execution order with loop bodies indented and triggers excluded", () => {
    const nodes = [N("start", "trigger.manual"), N("q", "data.query", { source: "ediscovery" }), N("loop", "logic.loop", { over: "{{steps.q.output.rows}}" }), N("body", "ai.summarize"), N("out", "output.file", { format: "docx", label: "Memo" })];
    const edges = [E("start", "q"), E("q", "loop"), E("loop", "body", "each"), E("body", "loop", undefined, "loop-back"), E("loop", "out", "done")];
    const rows = stepPreviews(nodes, edges);
    expect(rows.map((r) => [r.id, r.depth])).toEqual([["q", 0], ["loop", 0], ["body", 1], ["out", 0]]);
    expect(rows.find((r) => r.id === "body")!.usesAI).toBe(true);
    expect(rows.find((r) => r.id === "out")!.summary).toBe("docx · Memo");
  });
  it("summarizes every phase-3 node type for the canvas", () => {
    expect(nodeSummary("intel.fetch", { sourceId: "isrc_sys_cl_dockets" })).toBe("Source isrc_sys_cl_dockets");
    expect(nodeSummary("intel.fetch", { adapter: "ecfr" })).toBe("Adapter ecfr");
    expect(nodeSummary("intel.fetch", {})).toBe("No source");
    expect(nodeSummary("intel.extract", { docIds: "", summarize: true, entities: false })).toBe("upstream documents · summaries");
    expect(nodeSummary("intel.index", { embed: false })).toContain("keyword only");
    expect(nodeSummary("intel.entities", { relations: true })).toContain("relations");
    expect(nodeSummary("intel.analyze", { analysis: "trends", scope: { kinds: ["opinion", "docket"] } })).toBe("trends · opinion, docket");
    expect(nodeSummary("intel.verify", { target: "sweep" })).toBe("Integrity sweep");
    expect(nodeSummary("intel.verify", { target: "steps", steps: "a, b" })).toBe("Steps a, b");
    expect(nodeSummary("intel.verify", { target: "insights" })).toContain("Insights");
    expect(nodeSummary("intel.publish", { to: "home", title: "Alert" })).toBe("to home · Alert");
    expect(nodeSummary("review.auto", { fixes: ["retry", "narrow"], escalate: true })).toBe("2 fix(es) allowed · escalates");
    expect(nodeSummary("data.query", { source: "ediscovery", q: "PFAS", limit: 50 })).toBe("ediscovery · PFAS · max 50");
    expect(nodeSummary("output.file", { format: "xlsx", label: "" })).toBe("xlsx · (label from front end)");
    expect(nodeSummary("logic.schedule_after", { workflowId: "wf_x", wait: true })).toBe("Start wf_x · wait");
    expect(nodeSummary("logic.schedule_after", {})).toBe("No workflow chosen");
    expect(nodeSummary("ai.route", { branches: [{ id: "a" }, { id: "b" }] })).toBe("2 branch(es) + else");
    expect(nodeSummary("ai.agent", { agent: "research", brief: "Find authority" })).toBe("research · Find authority");
  });
  it("filters the gallery and picks the start link", () => {
    const item = (id: string, extra: Partial<WorkflowListItem>): WorkflowListItem => ({ id, name: id, category: "intake", status: "active", createdAt: "", updatedAt: "", nodeCount: 1, nodeTypes: [], usesAI: false, usesNetwork: false, hasApproval: false, hasFrontend: false, ...extra });
    const list = [item("a", { name: "NDA review", tags: ["nda"] }), item("b", { name: "Docket", category: "discovery", description: "watch dockets" })];
    expect(filterWorkflows(list, "nda", "").map((w) => w.id)).toEqual(["a"]);
    expect(filterWorkflows(list, "", "discovery").map((w) => w.id)).toEqual(["b"]);
    expect(filterWorkflows(list, "DOCK", "discovery").map((w) => w.id)).toEqual(["b"]);
    expect(startHref({ id: "a", hasFrontend: true })).toBe("/workflows/a/start");
    expect(startHref({ id: "a", hasFrontend: false })).toBe("/workflows/a?run=1");
  });
});

describe("builder front-end editor operations", () => {
  it("adds, updates, moves, renames and removes fields without key collisions", () => {
    let fe = emptyFrontend("Start");
    fe = addField(fe, "file", "Transcript");
    fe = addField(fe, "select", "Side");
    fe = addField(fe, "text", "Side");
    expect(fe.fields.map((f) => f.key)).toEqual(["transcript", "side", "side_2"]);
    expect(fe.fields[0]).toMatchObject({ type: "file", required: true, accept: [".docx", ".pdf", ".txt", ".md"] });
    expect(fe.fields[1].options).toEqual(["Option A", "Option B"]);
    fe = moveField(fe, 2, 0);
    expect(fe.fields.map((f) => f.key)).toEqual(["side_2", "transcript", "side"]);
    expect(moveField(fe, 0, 9)).toBe(fe);
    fe = updateField(fe, "side", { required: true, help: "Which party" });
    expect(fe.fields.find((f) => f.key === "side")).toMatchObject({ required: true, help: "Which party" });
    fe = renameFieldKey(fe, "side_2", "our side!");
    expect(fe.fields[0].key).toBe("our_side_");
    expect(renameFieldKey(fe, "our_side_", "side")).toBe(fe); // collision keeps the old key
    expect(renameFieldKey(fe, "our_side_", "")).toBe(fe);
    fe = removeField(fe, "transcript");
    expect(fe.fields.map((f) => f.key)).toEqual(["our_side_", "side"]);
  });
});

describe("template front ends", () => {
  it("gives every user template a tailored front end whose fields cover the required inputs", () => {
    const templates = buildTemplates();
    expect(templates).toHaveLength(16);
    for (const t of templates) {
      const fe = TEMPLATE_FRONTENDS[t.id];
      expect(fe, `${t.id} has no front end`).toBeTruthy();
      expect(fe.fields.length, t.id).toBeGreaterThan(0);
      expect(t.frontend).toBe(fe);
      const keys = new Set(fe.fields.map((f) => f.key));
      for (const i of t.inputs ?? []) if (i.required) expect(keys.has(i.key), `${t.id}: required input ${i.key} missing from the front end`).toBe(true);
      expect(new Set(fe.fields.map((f) => f.key)).size).toBe(fe.fields.length);
      for (const f of fe.fields) {
        if (f.type === "select" || f.type === "multiselect") expect(f.options?.length, `${t.id}.${f.key} needs options`).toBeGreaterThan(0);
        if (f.type === "file" || f.type === "files") expect(f.accept?.length, `${t.id}.${f.key} needs an accept list`).toBeGreaterThan(0);
      }
      if (fe.output?.formats) for (const fmt of fe.output.formats) expect(OUTPUT_FORMATS).toContain(fmt);
      if (fe.output?.defaultFormat) expect(fe.output.formats ?? OUTPUT_FORMATS).toContain(fe.output.defaultFormat);
      // Templates that render a file offer a format and a default label.
      if (t.nodes.some((n) => n.type === "output.file")) { expect(fe.output?.formats?.length, `${t.id} output formats`).toBeGreaterThan(0); expect(fe.output?.defaultLabel, `${t.id} default label`).toBeTruthy(); }
      expect(validateFrontendValues(fe, {}).every((e) => keys.has(e.key))).toBe(true);
    }
    const bail = templates.find((t) => t.name === "Bail matter pack")!;
    expect(bail.frontend!.fields.find((f) => f.type === "file")).toBeTruthy();
    expect(templates.map((t) => t.name)).toEqual(expect.arrayContaining(["Limitation check", "Hearing-date preparation", "Cause-list watch", "Bail matter pack", "Cheque-dishonour (s.138) pack", "Judgment digest (Kannada / Telugu)", "Production QC"]));
    // US-practice templates keep their front ends but are not in the default gallery.
    const us = buildUsTemplates();
    expect(us.map((t) => t.name)).toEqual(expect.arrayContaining(["Deposition designations", "Judge profile memo"]));
    for (const t of us) expect(t.frontend, t.id).toBe(TEMPLATE_FRONTENDS[t.id]);
    expect(templates.some((t) => us.some((u) => u.id === t.id))).toBe(false);
  });
});
