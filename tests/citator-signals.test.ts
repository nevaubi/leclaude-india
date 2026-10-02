import { describe, expect, it } from "vitest";
import { extractCitations } from "@/lib/india/citations";
import { collapseWhitespace, contextAround, detectTreatment, sentenceStarts, type Span } from "@/modules/india/citator/signals";
import { extractCitationDrafts } from "@/modules/india/citator/extract";

const NOW = new Date("2026-10-01T00:00:00Z");

/** Case-citation spans in a sentence (as the extractor computes them). */
function spansOf(s: string): Span[] {
  return extractCitations(s, { now: NOW }).filter((c) => c.kind === "neutral" || c.kind === "reporter").map((c) => ({ start: c.start!, end: c.end! }));
}

/** Signal (and cue) for the citation whose text is `cite` in `s`. */
function signalFor(s: string, cite: string) {
  const spans = spansOf(s);
  const at = s.indexOf(cite);
  const target = spans.findIndex((sp) => sp.start === at);
  if (target < 0) throw new Error(`citation ${cite} not parsed in: ${s}`);
  const r = detectTreatment(s, spans, target);
  if (r) expect(s.toLowerCase()).toContain(r.cue.toLowerCase());
  return r ? r.signal : null;
}

const A = "(2010) 1 SCC 1";
const B = "(2015) 3 SCC 200";

describe("treatment cues: positive cases", () => {
  it.each([
    [`The decision in Ram v. State ${A} was overruled by a larger Bench.`, "overruled"],
    [`Ram v. State ${A} has been expressly overruled.`, "overruled"],
    [`We overrule Ram v. State ${A}.`, "overruled"],
    [`This Court overruled ${A}.`, "overruled"],
    [`Accordingly, Ram v. State ${A} is no longer good law.`, "overruled"],
    [`Ram v. State ${A} does not lay down the correct law.`, "overruled"],
    [`The judgment in ${A} was rendered per incuriam.`, "per_incuriam"],
    [`The view taken in ${A} is per incuriam.`, "per_incuriam"],
    [`The correctness of ${A} was doubted in a later case.`, "doubted"],
    [`A coordinate Bench, doubting ${A}, referred the question.`, "doubted"],
    [`The correctness of ${A} is referred to a larger Bench.`, "referred_to_larger_bench"],
    [`The papers in ${A} be placed before the Constitution Bench.`, "referred_to_larger_bench"],
    [`The decision in ${A} is clearly distinguishable on facts.`, "distinguished"],
    [`Ram v. State ${A} was distinguished on facts.`, "distinguished"],
    [`The ratio of ${A} has been consistently followed.`, "followed"],
    [`Reliance was placed on ${A}.`, "followed"],
    [`Learned counsel relied upon ${A}.`, "followed"],
    [`The High Court applied the ratio in ${A}.`, "followed"],
  ])("%s → %s", (s, expected) => {
    expect(signalFor(s, A)).toBe(expected);
  });

  it("keeps the verbatim cue (case-insensitive) in the context", () => {
    const s = `Ram v. State ${A} STANDS OVERRULED.`;
    const r = detectTreatment(s, spansOf(s), 0)!;
    expect(r.signal).toBe("overruled");
    expect(s).toContain(r.cue);
  });

  it("prefers the strongest signal when several cues attach", () => {
    const s = `Ram v. State ${A}, which was followed for years, was overruled.`;
    expect(signalFor(s, A)).toBe("overruled");
  });
});

describe("treatment cues: negations and traps give no signal", () => {
  it.each([
    `Ram v. State ${A} has not been overruled.`,
    `Ram v. State ${A} was never overruled.`,
    `It cannot be said that ${A} is not good law.`,
    `The decision in ${A} cannot be said to be per incuriam.`,
    `${A} is not per incuriam.`,
    `The decision in ${A} need not be distinguished.`,
    `The decision in ${A} cannot be distinguished.`,
    `The correctness of ${A} has never been doubted.`,
    `The question is whether ${A} was overruled.`,
    `If ${A} were overruled, the result would differ.`,
    `Counsel contended that ${A} stands overruled.`,
    `Learned counsel sought to distinguish ${A}.`,
    `In our view ${A} ought to be overruled.`,
    `The preliminary objection, raised on the strength of ${A}, is overruled.`,
    `We decline to refer ${A} to a larger Bench.`,
    `Learned and distinguished counsel cited ${A}.`,
    `The procedure followed in ${A} was different.`,
    `The hearing in ${A} was followed by an appeal.`,
    `The appellant applied for bail citing ${A}.`,
    `${A} was not followed.`,
  ])("%s", (s) => {
    expect(signalFor(s, A)).toBeNull();
  });
});

describe("treatment cues: attribution between several citations", () => {
  it("passive cue attaches to the preceding citation only", () => {
    const s = `${A} was overruled in ${B}.`;
    expect(signalFor(s, A)).toBe("overruled");
    expect(signalFor(s, B)).toBeNull();
  });

  it("active cue attaches to the following citation only", () => {
    const s = `In ${B}, this Court overruled ${A}.`;
    expect(signalFor(s, A)).toBe("overruled");
    expect(signalFor(s, B)).toBeNull();
  });

  it("an ambiguous bare cue between two citations attaches to neither", () => {
    const s = `See ${A} and ${B}, distinguished.`;
    expect(signalFor(s, A)).toBeNull();
    expect(signalFor(s, B)).toBeNull();
  });

  it("a cue after a relative clause does not attach to the citation inside it", () => {
    const s = `The decision in Y, which followed ${A}, was overruled in ${B}.`;
    expect(signalFor(s, A)).not.toBe("overruled");
    expect(signalFor(s, B)).toBeNull();
  });

  it("a cue in another clause after a semicolon does not cross it", () => {
    const s = `${A} was relied upon; ${B} was overruled.`;
    expect(signalFor(s, A)).toBe("followed");
    expect(signalFor(s, B)).toBe("overruled");
  });
});

describe("sentences and contexts", () => {
  it("does not split at abbreviations or inside citations", () => {
    const text = "Mr. Rao relied on State of U.P. v. Ram (2010) 1 S.C.C. 1. The appeal is dismissed. Sec. 5 applies.";
    const spans = spansOf(text);
    const starts = sentenceStarts(text, spans);
    expect(starts).toEqual([0, text.indexOf("The appeal"), text.indexOf("Sec. 5")]);
  });

  it("bounds long sentences to 400 characters around the citation, whitespace collapsed", () => {
    const pre = "word ".repeat(200);
    const text = `${pre}the decision in ${A}\n\n   was\noverruled ${"tail ".repeat(200)}.`;
    const spans = spansOf(text);
    const starts = sentenceStarts(text, spans);
    const at = text.indexOf(A);
    const r = contextAround(text, starts, at, at + A.length, spans);
    expect(r.context.length).toBeLessThanOrEqual(400);
    expect(r.context.slice(r.target.start, r.target.end)).toBe(A);
    expect(r.context).not.toMatch(/\s{2,}/);
  });

  it("maps offsets through whitespace collapsing", () => {
    const { text, map } = collapseWhitespace("  a  b\n\nc ");
    expect(text).toBe("a b c");
    expect(map(2)).toBe(0);
    expect(map(5)).toBe(2);
    expect(map(8)).toBe(4);
  });
});

describe("extractCitationDrafts", () => {
  it("collapses repeats by key, keeps the strongest signal, skips the judgment's own citation, and extracts statutes per section", () => {
    const chunks = [
      { index: 0, pageStart: 1, text: `2024 INSC 735\nIN THE SUPREME COURT OF INDIA\n\nThe appellant was convicted under Sections 302 and 34 of the Indian Penal Code. Reliance was placed on ${A}.` },
      { index: 1, pageStart: 4, text: `We are of the view that ${A} was overruled by a larger Bench. See also AIR 1973 SC 1461.` },
    ];
    const { drafts, selfSkipped } = extractCitationDrafts(chunks, { ownKeys: ["2024 INSC 735"], now: NOW });
    expect(selfSkipped).toBe(1);
    const a = drafts.find((d) => d.key === A)!;
    expect(a).toMatchObject({ kind: "case", signal: "overruled", occurrences: 2, page: 4, chunkIndex: 1 });
    expect(a.context).toContain(a.cue!);
    expect(drafts.find((d) => d.key === "AIR 1973 SC 1461")).toMatchObject({ signal: null, page: 4 });
    const st = drafts.filter((d) => d.kind === "statute").map((d) => [d.key, d.actId, d.section]);
    expect(st).toEqual([["IPC 1860 s.302", "ipc", "302"], ["IPC 1860 s.34", "ipc", "34"]]);
    expect(drafts.some((d) => d.key.includes("INSC"))).toBe(false);
  });

  it("caps the number of distinct citations and reports truncation", () => {
    const text = Array.from({ length: 12 }, (_, i) => `See (2010) 1 SCC ${i + 1}.`).join(" ");
    const r = extractCitationDrafts([{ index: 0, pageStart: 1, text }], { now: NOW, max: 5 });
    expect(r.drafts).toHaveLength(5);
    expect(r.truncated).toBe(true);
  });
});
