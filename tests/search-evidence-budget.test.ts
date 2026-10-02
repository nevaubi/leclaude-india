/**
 * Deep-research evidence under the synthesis budget: the top read sources go in full (focused, ≤2,000-character
 * citable blocks, bounded per source and in total), later read sources carry only their snippet labelled as such, a
 * script-aware token cap holds for Indic text, and a run with real-shaped budgets hands the synthesis those bounds.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { db, resetSqlite } from "@/lib/db";
import { buildEvidenceBlocks } from "@/modules/search/engine/evidence";
import { sourceFromHit } from "@/modules/search/engine/sources";
import { runResearch } from "@/modules/search/engine/run";
import { planLanes } from "@/modules/search/engine/planner";
import { sanitizeSettings } from "@/modules/search/service";
import { estimateTokens, resolveContextBudget } from "@/lib/ai/context-budget";
import { modelLimits } from "@/lib/ai/providers/model-limits";
import type { ResearchSource } from "@/modules/search/engine/types";
import type { SearchHit } from "@/modules/search/types";
import { indiaFakeDeps } from "../evals/india-research/fixtures";

beforeAll(() => { resetSqlite(); db(); });

const BIG = modelLimits("openai", "gpt-5.4");

function libSource(i: number): ResearchSource {
  const hit: SearchHit = { id: `library:memo${i}`, source: "library", title: `Firm memo ${i}`, snippet: `snippet of memo ${i} on anticipatory bail`, readRef: { kind: "library", id: `memo${i}` } };
  return { ...sourceFromHit(hit, "lane"), n: i, read: true };
}

/** ~60k characters of paragraphs, every fourth one on point. */
const longText = (i: number) => Array.from({ length: 120 }, (_, p) => (p % 4 === 0 ? `Paragraph ${p + 1} of memo ${i}: anticipatory bail parity and the triple test apply here; the court weighed the role of the co-accused.` : `Paragraph ${p + 1} of memo ${i}: background facts about the transaction, the parties and the procedural history before the trial court.`).repeat(3)).join("\n\n");

describe("buildEvidenceBlocks under the deep_research_synthesis budget", () => {
  it("gives the top 12 read sources in full (≤ perSourceChars, ≤2k blocks) and later read sources as labelled snippets", () => {
    const b = resolveContextBudget("deep_research_synthesis", BIG, {});
    const sources = Array.from({ length: 15 }, (_, i) => libSource(i + 1));
    const blocks = buildEvidenceBlocks(sources, (s) => longText(s.n!), { terms: ["anticipatory", "bail", "parity"], maxCharsPerSource: b.perSourceChars, maxTotalChars: b.totalEvidenceChars, maxBlockChars: b.blockChars, maxFullSources: b.maxFullSources, maxTotalTokens: Math.floor(b.inputTokens * 0.8) });
    expect(blocks).toHaveLength(15);
    let total = 0;
    blocks.forEach((blk, i) => {
      const chars = blk.content.reduce((a, c) => a + c.length, 0);
      for (const c of blk.content) expect(c.length, `block of source ${i + 1}`).toBeLessThanOrEqual(2_000);
      if (i < 12) {
        expect(blk.content.length, `source ${i + 1}`).toBeGreaterThan(5);
        expect(chars).toBeLessThanOrEqual(b.perSourceChars + 2_000);
        expect(blk.content[0]).toMatch(/^¶\d+ /);
        total += chars;
      } else {
        expect(blk.content).toHaveLength(1);
        expect(blk.content[0]).toMatch(/^\(read in full; text omitted for length — snippet only, do not characterize beyond it\) snippet of memo/);
      }
      expect(blk.citationsEnabled).toBe(true);
    });
    expect(total).toBeGreaterThan(12 * 20_000); // far more than the old 80k total
    expect(total).toBeLessThanOrEqual(b.totalEvidenceChars);
  });

  it("keeps the old bounds when no budget is passed, and holds a script-aware token cap for Indic text", () => {
    const old = buildEvidenceBlocks([libSource(1)], () => longText(1), { terms: ["parity"] });
    expect(old[0].content.reduce((a, c) => a + c.length, 0)).toBeLessThanOrEqual(6_000 + 1_400);
    const kannada = Array.from({ length: 700 }, (_, p) => `ಪ್ಯಾರಾ ${p + 1}: ನಿರೀಕ್ಷಣಾ ಜಾಮೀನು ಮತ್ತು ಸಮಾನತೆಯ ತತ್ವವನ್ನು ನ್ಯಾಯಾಲಯ ಪರಿಗಣಿಸಿತು.`).join("\n\n");
    const capped = buildEvidenceBlocks([libSource(1), libSource(2)], () => kannada, { terms: ["ಜಾಮೀನು"], maxCharsPerSource: 40_000, maxTotalChars: 500_000, maxBlockChars: 2_000, maxTotalTokens: 3_000 });
    const tokens = capped.flatMap((b) => b.content).filter((c) => c.startsWith("¶")).reduce((a, c) => a + estimateTokens(c), 0);
    expect(tokens).toBeLessThanOrEqual(3_000 + 2_000); // at most one block over (a source always keeps its first block)
    const uncapped = buildEvidenceBlocks([libSource(1)], () => kannada, { terms: ["ಜಾಮೀನು"], maxCharsPerSource: 40_000, maxTotalChars: 500_000, maxBlockChars: 2_000 });
    expect(uncapped[0].content.length).toBeGreaterThan(10);
    expect(capped[0].content.length).toBeLessThan(3);
  });
});

describe("the research run uses the engine's budgets", () => {
  it("synthesis evidence follows deps.budget (full-source cap) and deep lanes get the lane read boost", async () => {
    const deps = indiaFakeDeps();
    deps.budget = (p) => ({ ...resolveContextBudget(p, BIG, {}), ...(p === "deep_research_synthesis" ? { maxFullSources: 1 } : {}) });
    const settings = sanitizeSettings({ sources: ["caselaw", "statutes", "library"], jurisdiction: "hc-karnataka" });
    await runResearch({ question: "Can anticipatory bail be refused only because the offence is economic?", settings, runId: "run_budget_1" }, () => {}, undefined, deps);
    const evidence = deps.synth[0].evidence;
    const full = evidence.filter((e) => e.content.some((c) => c.startsWith("¶")));
    const omitted = evidence.filter((e) => /text omitted for length/.test(e.content[0]));
    expect(full).toHaveLength(1);
    expect(omitted.length).toBeGreaterThanOrEqual(1);
    const base = planLanes({ question: "q", settings, mode: "deep", hasMatter: false });
    const boosted = planLanes({ question: "q", settings, mode: "deep", hasMatter: false, readBoost: 2 });
    expect(boosted[0].maxReads).toBe(base[0].maxReads + 2);
    expect(planLanes({ question: "q", settings, mode: "deep", hasMatter: false, readBoost: 99 })[0].maxReads).toBe(base[0].maxReads + 3);
    expect(planLanes({ question: "q", settings, mode: "fast", hasMatter: false, readBoost: 2 })[0].maxReads).toBe(2);
    expect(base.find((l) => l.kind === "statute")?.tools).toContain("search_official_sources");
  });
});
