/**
 * Verification is never weaker than synthesis, and never truncates silently (constitution §23):
 * - deep research caps its synthesis evidence at what one verifier call can show, and the verifier's per-source reach is
 *   at least the synthesis per-source size, so no cited passage is cut (sourcesClipped 0, not partial);
 * - a source cut short or not shown makes the verification partial (never "verified");
 * - sourceIndex in the verdicts refers to the caller's sources;
 * - selfCorrect never truncates the output: a large output is corrected in parts and merged (every row kept or
 *   explicitly changed), an output that cannot be split is not corrected at all (the caller keeps it, unverified).
 * Fake model; no network.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Call = { name?: string; input?: unknown; instructions?: string; maxOutputTokens?: number };
const calls: Call[] = [];
let respond: (c: Call) => unknown = () => ({ verdicts: [] });

vi.mock("@/lib/ai/agent", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/ai/agent")>();
  return { ...real, generateJSON: async (opts: Call) => { calls.push(opts); return respond(opts); } };
});

import { allocateVerifierText, safeSelfCorrect, selfCorrect, splitForCorrection, verifierCapacity, verifyClaims } from "@/lib/ai/verify";
import { estimateTokens, resolveContextBudget } from "@/lib/ai/context-budget";
import { modelLimits } from "@/lib/ai/providers/model-limits";
import { buildEvidenceBlocks, evidenceText } from "@/modules/search/engine/evidence";
import { sourceFromHit } from "@/modules/search/engine/sources";
import { synthesisEvidenceLimits } from "@/modules/search/engine/run";
import type { ResearchSource } from "@/modules/search/engine/types";
import type { SearchHit } from "@/modules/search/types";

const BIG = modelLimits("openai", "gpt-5.4");
const MINI = modelLimits("openai", "gpt-5.4-mini");

beforeEach(() => { calls.length = 0; respond = () => ({ verdicts: [] }); process.env.OPENAI_API_KEY = "test"; });

function libSource(i: number): ResearchSource {
  const hit: SearchHit = { id: `library:memo${i}`, source: "library", title: `Firm memo ${i}`, snippet: `snippet of memo ${i}`, readRef: { kind: "library", id: `memo${i}` } };
  return { ...sourceFromHit(hit, "lane"), n: i, read: true };
}
const longText = (i: number) => Array.from({ length: 160 }, (_, p) => `Paragraph ${p + 1} of memo ${i}: anticipatory bail parity and the triple test; the court weighed the role of the co-accused and the custody period before the trial court.`.repeat(2)).join("\n\n");

/** The text each source was shown with in the verifier prompt. */
function shownTexts(input: string): string[] {
  const block = input.split("\n\nSOURCES:\n")[1] ?? "";
  return block.split(/\n\n(?=\[\d+\] )/).map((s) => s.replace(/^\[\d+\] [^\n]*\n/, ""));
}

describe("deep research: the verifier sees what the synthesis saw", () => {
  it("synthesis evidence is capped at the verifier's capacity and the verifier's reach covers every source whole", async () => {
    const synth = resolveContextBudget("deep_research_synthesis", BIG, {});
    const verify = resolveContextBudget("verify", MINI, {});
    const cap = verifierCapacity(verify);
    const sources = Array.from({ length: 15 }, (_, i) => libSource(i + 1));
    const limits = synthesisEvidenceLimits(synth, cap, sources.length);
    expect(limits.maxTotalChars).toBeLessThanOrEqual(cap.totalChars);
    expect(limits.maxTotalTokens).toBeLessThanOrEqual(cap.totalTokens);
    const blocks = buildEvidenceBlocks(sources, (s) => longText(s.n!), { terms: ["anticipatory", "bail", "parity"], ...limits });
    const texts = blocks.map(evidenceText);
    const synthPerSource = Math.max(...texts.map((t) => t.length));
    expect(synthPerSource).toBeGreaterThan(verify.perSourceChars); // the old verifier reach (13–20k) would have cut these
    // run.ts passes the longest evidence text as the verifier's per-source reach.
    respond = () => ({ verdicts: [{ claim: "parity applies", status: "supported", sourceIndex: 0, quote: "anticipatory bail parity" }] });
    const v = await verifyClaims({ answer: "Parity applies [1].", sources: texts.map((text, i) => ({ title: `Memo ${i + 1}`, text })), budget: verify, perSourceChars: synthPerSource });
    expect(v.coverage).toMatchObject({ sourcesGiven: 15, sourcesChecked: 15, sourcesClipped: 0 });
    expect(v.partial).toBe(false);
    expect(v.status).toBe("verified");
    const shown = shownTexts(String(calls[0].input));
    shown.forEach((t, i) => expect(t, `source ${i + 1}`).toBe(texts[i]));
    // The whole prompt fits the verifier's input budget.
    expect(estimateTokens(String(calls[0].input))).toBeLessThanOrEqual(verify.inputTokens);
  });

  it("a source cut short (or one not shown) makes the verification partial, never verified", async () => {
    const verify = resolveContextBudget("verify", MINI, {});
    respond = () => ({ verdicts: [{ claim: "a", status: "supported", sourceIndex: 0, quote: "q" }] });
    const huge = "x ".repeat(verify.totalEvidenceChars); // longer than the verifier's whole budget
    const v = await verifyClaims({ answer: "A.", sources: [{ title: "Huge", text: huge }], budget: verify });
    expect(v.coverage?.sourcesClipped).toBe(1);
    expect(v.partial).toBe(true);
    expect(v.status).toBe("partially-verified");
    const many = Array.from({ length: verify.maxFullSources + 3 }, (_, i) => ({ title: `S${i}`, text: `source ${i} text` }));
    const w = await verifyClaims({ answer: "A.", sources: many, budget: verify });
    expect(w.coverage).toMatchObject({ sourcesGiven: verify.maxFullSources + 3, sourcesChecked: verify.maxFullSources });
    expect(w.partial).toBe(true);
    expect(w.status).not.toBe("verified");
  });

  it("maps sourceIndex back to the caller's array when an empty source is skipped", async () => {
    respond = () => ({ verdicts: [{ claim: "b", status: "supported", sourceIndex: 1, quote: "beta" }, { claim: "c", status: "supported", sourceIndex: 7, quote: "?" }] });
    const v = await verifyClaims({ answer: "B.", sources: [{ title: "A", text: "alpha" }, { title: "Empty", text: "  " }, { title: "B", text: "beta" }], budget: resolveContextBudget("verify", MINI, {}) });
    expect(v.verdicts[0].sourceIndex).toBe(2);
    expect(v.verdicts[1].sourceIndex).toBeNull(); // out of range: no source, never a neighbour
  });

  it("allocation is fair: short sources whole, long ones share the rest, totals respected (tokens and characters)", () => {
    const texts = ["short", "y".repeat(50_000), "z ".repeat(40_000)];
    const alloc = allocateVerifierText(texts, { perSourceCap: 100_000, totalChars: 60_000, totalTokens: 1_000_000 });
    expect(alloc[0]).toBe(5);
    expect(alloc.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(60_000);
    expect(Math.abs(alloc[1] - alloc[2])).toBeLessThanOrEqual(1);
    const kn = "ಜಾಮೀನು ".repeat(20_000);
    const t = allocateVerifierText([kn], { perSourceCap: 1_000_000, totalChars: 1_000_000, totalTokens: 5_000 });
    expect(estimateTokens(kn.slice(0, t[0]))).toBeLessThanOrEqual(5_000);
  });
});

describe("selfCorrect never truncates the output", () => {
  const rowSchema = { type: "array", items: { type: "object", properties: { cite: { type: "string" }, text: { type: "string" } }, required: ["cite", "text"] } };
  const parseOutput = (c: Call) => JSON.parse(String(c.input).split("\nEVIDENCE:")[0].replace(/^OUTPUT:\n/, ""));

  it("corrects a large array in parts (each part valid JSON) and merges every row back in order", async () => {
    const rows = Array.from({ length: 400 }, (_, i) => ({ cite: `${i + 1}:5`, text: `Row ${i + 1}: the witness said the report was a draft until June, not final in March.` }));
    respond = (c) => ({ corrected: parseOutput(c), changes: [] });
    const r = await selfCorrect({ label: "rows", output: rows, evidence: "transcript", schema: rowSchema, budget: resolveContextBudget("verify", MINI, {}) });
    expect(calls.length).toBeGreaterThan(1);
    for (const c of calls) expect(() => parseOutput(c)).not.toThrow();
    expect(r.corrected).toEqual(rows);
    expect(r.parts).toBe(calls.length);
  });

  it("keeps late QUALIFICATION lines of a digest (object with array fields) and records each part's changes", async () => {
    // Large enough to need parts under the verify budget's output (20K tokens on a 400K model since 2026-10).
    const keyAdmissions = [...Array.from({ length: 900 }, (_, i) => ({ cite: `${i + 1}:1`, text: `Admission ${i + 1} about the sampling schedule and the reporting chain.` })), { cite: "220:1", text: "QUALIFICATION (of 20:1): the report was only a draft in March." }];
    const output = { keyAdmissions, credibilityNotes: ["Consistent at 20:1"], followUps: ["Ask about 220:1"] };
    respond = (c) => { const o = parseOutput(c); return { corrected: o, changes: o.keyAdmissions.length ? [`checked ${o.keyAdmissions.length}`] : [] }; };
    const r = await selfCorrect({ label: "digest", output, evidence: "transcript", schema: { type: "object" }, budget: resolveContextBudget("verify", MINI, {}) });
    expect(calls.length).toBeGreaterThan(1);
    expect(r.corrected.keyAdmissions).toHaveLength(901);
    expect(r.corrected.keyAdmissions.at(-1)?.text).toMatch(/^QUALIFICATION/);
    expect(r.corrected.credibilityNotes).toEqual(["Consistent at 20:1"]);
    expect(r.corrected.followUps).toEqual(["Ask about 220:1"]);
    expect(r.changes.length).toBeGreaterThan(1);
  });

  it("an output that cannot be split is not corrected (the caller keeps it and reports that self-correction did not run)", async () => {
    expect(splitForCorrection({ summary: "x".repeat(200_000) }, 5_000)).toBeNull();
    expect(splitForCorrection([{ a: "y".repeat(100_000) }], 5_000)).toBeNull();
    const output = { summary: "word ".repeat(80_000) };
    const r = await safeSelfCorrect({ label: "summary", output, evidence: "e", schema: { type: "object" }, budget: resolveContextBudget("verify", MINI, {}) });
    expect(r.ran).toBe(false);
    expect(r.error).toMatch(/cannot be split/);
    expect(r.corrected).toBe(output);
    expect(calls).toHaveLength(0);
  });
});
