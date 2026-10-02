/**
 * Deposition digests cover the WHOLE transcript (constitution §28, §44 "late qualification"): a long transcript is
 * segmented into page:line windows analysed in parallel, a coverage map records every window, qualifications found in
 * any window survive synthesis (an admission at p.20 and its correction at p.220 are both preserved), and a digest with
 * an unanalysed window is never labelled comprehensive or verified. Fake model runtime; no network.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.WORKFLOW_SCHEDULER_DISABLED = "1";
process.env.OPENAI_API_KEY = "test-key";

type Call = { name?: string; instructions?: string; input?: unknown };
const calls: Call[] = [];
const script: Record<string, (c: Call) => unknown> = {};

// The fake key enables AI paths; embeddings are stubbed so seeding and indexing never call a real endpoint (no network,
// no unhandled rejection from a failed embedding request).
vi.mock("@/lib/ai/embeddings", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/ai/embeddings")>();
  const vec = () => Float32Array.from({ length: 8 }, (_, i) => (i === 0 ? 1 : 0));
  return { ...real, embedTexts: async (texts: string[]) => texts.map(vec), embedText: async () => vec() };
});

vi.mock("@/lib/ai/agent", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/ai/agent")>();
  return {
    ...real,
    generateJSON: async (opts: Call) => { calls.push(opts); const fn = script[opts.name ?? ""]; if (!fn) throw new Error(`no fake for ${opts.name}`); return fn(opts); },
  };
});

import { db, resetSqlite } from "@/lib/db";
import { MATTERS } from "@/lib/seed/ids";
import type { Deposition, DepositionQA } from "@/lib/types/domain";
import { digestDeposition, preserveQualifications } from "@/modules/ediscovery/analysis/ai";
import { segmentTranscript } from "@/modules/ediscovery/analysis/transcript";
import { getProvenance } from "@/lib/integrity/store";

const ADMISSION = "Yes. I knew in March that the Sundaram report was final.";
const QUALIFICATION = "I need to correct my answer at page 20: in March the Sundaram report was only a draft; it became final in June.";

function longDeposition(id: string): Deposition {
  const transcript: DepositionQA[] = [];
  for (let page = 1; page <= 230; page++) {
    for (const line of [1, 13]) {
      let answer = `On page ${page} the witness described the plant's sampling schedule, the laboratory turnaround and the reporting chain in general terms without committing to dates or to the content of any report. He explained that the laboratory batches arrived weekly, that a technician logged each one, and that summaries went first to the plant manager and later to the regional environmental group for review.`;
      let question = `Directing your attention to the sampling records discussed at page ${page}, what did the laboratory send you and when?`;
      if (page === 20 && line === 1) { question = "Did you know in March that the Sundaram report was final?"; answer = ADMISSION; }
      if (page === 220 && line === 1) { question = "Is there anything you want to change about your earlier testimony?"; answer = QUALIFICATION; }
      transcript.push({ page, line, question, answer });
    }
  }
  return { id, matterId: MATTERS.valsara, witnessId: "w_test", witnessName: "Helen Testwitness", date: "2026-06-01", takenBy: "Plaintiffs", pages: 230, transcript, status: "transcribed" };
}

beforeAll(() => {
  resetSqlite();
  db();
  db().depositions.put(longDeposition("dep_test_long"));
  db().depositions.put(longDeposition("dep_test_long_fail"));
  // Self-correction keeps everything; claim verification supports everything.
  script.self_correction = (c) => ({ corrected: JSON.parse(String(c.input).split("\nEVIDENCE:")[0].replace(/^OUTPUT:\n/, "")), changes: [] });
  script.claim_verification = () => ({ verdicts: [{ claim: "a", status: "supported", sourceIndex: 0, quote: "q" }] });
});

/** Window analysis: reports what its own window contains (the fake reads the transcript text it was given). */
function segmentFake(fail?: (input: string) => boolean) {
  return (c: Call) => {
    const input = String(c.input);
    if (fail?.(input)) throw new Error("provider_unavailable: window failed");
    const admissions = input.includes(ADMISSION) ? [{ cite: "20:01", text: "Knew in March the Sundaram report was final." }] : [];
    const qualifications = input.includes(QUALIFICATION) ? [{ cite: "220:01", text: "Corrected p.20: in March the report was only a draft; final in June.", qualifies: "the admission at 20:01" }] : [];
    return { summary: "Window summary.", admissions, qualifications, themes: ["Sundaram report status"], credibilityNotes: [], followUps: [] };
  };
}

describe("whole-transcript deposition digest", () => {
  it("segments a long transcript into page:line windows that cover every Q/A exactly once", () => {
    const dep = longDeposition("x");
    const segs = segmentTranscript(dep, 60_000);
    expect(segs.length).toBeGreaterThan(1);
    expect(segs.flatMap((s) => s.indexes)).toEqual(dep.transcript.map((_, i) => i));
    expect(segs[0].range).toMatch(/^1:01–/);
    expect(segs.at(-1)!.range).toMatch(/–230:13$/);
    for (const s of segs) expect(s.chars).toBeLessThanOrEqual(60_000);
  });

  it("late qualification: the admission at p.20 and its correction at p.220 are both preserved", async () => {
    calls.length = 0;
    script.deposition_segment = segmentFake();
    // The synthesis keeps only the early admission — the counterevidence scan must restore the qualification.
    script.deposition_digest = () => ({ summary: "The witness admitted knowing the report was final in March (20:01).", keyAdmissions: [{ cite: "20:01", text: "Knew in March the Sundaram report was final." }], themes: ["report status"], credibilityNotes: [], followUps: ["Ask about the June finalisation (220:01)"], confidence: 0.8 });
    const d = await digestDeposition("dep_test_long", { force: true });
    const segmentCalls = calls.filter((c) => c.name === "deposition_segment");
    expect(segmentCalls.length).toBeGreaterThan(1);
    // Every window was sent; the later window carried page 220 (no prefix truncation).
    expect(segmentCalls.some((c) => String(c.input).includes(QUALIFICATION))).toBe(true);
    expect(segmentCalls.some((c) => String(c.input).includes(ADMISSION))).toBe(true);
    expect(d.coverage).toMatchObject({ complete: true, failed: 0, qaTotal: 460, qaAnalyzed: 460 });
    expect(d.keyAdmissions.some((k) => k.startsWith("20:01"))).toBe(true);
    const q = d.keyAdmissions.find((k) => k.startsWith("220:01"));
    expect(q).toBeTruthy();
    expect(q).toContain("QUALIFICATION");
    expect(q).not.toContain("[VERIFY]"); // page 220 exists in the transcript
    // The synthesis saw the findings of every window, in transcript order.
    const synth = calls.find((c) => c.name === "deposition_digest")!;
    expect(String(synth.input)).toMatch(/Coverage: \d+ of \d+ transcript windows analysed \(the whole transcript\)/);
    expect(String(synth.input).indexOf("20:01")).toBeLessThan(String(synth.input).indexOf("220:01"));
    // Self-correction saw the cited pages of BOTH ends of the transcript.
    const sc = calls.find((c) => c.name === "self_correction")!;
    expect(String(sc.input)).toContain(ADMISSION);
    expect(String(sc.input)).toContain(QUALIFICATION);
    expect(db().depositions.get("dep_test_long")?.aiDigest?.keyAdmissions.some((k) => k.includes("QUALIFICATION"))).toBe(true);
  });

  it("an unanalysed window makes the digest partial: it says so and is never labelled verified", async () => {
    script.deposition_segment = segmentFake((input) => input.includes(QUALIFICATION));
    script.deposition_digest = () => ({ summary: "The witness admitted knowing the report was final in March (20:01).", keyAdmissions: [{ cite: "20:01", text: "Knew in March the Sundaram report was final." }], themes: [], credibilityNotes: [], followUps: [], confidence: 0.9 });
    const d = await digestDeposition("dep_test_long_fail", { force: true });
    expect(d.coverage?.complete).toBe(false);
    expect(d.coverage?.failed).toBe(1);
    expect(d.coverage?.segments.find((s) => s.status === "failed")?.error).toMatch(/window failed/);
    expect(d.summary).toMatch(/This digest is not comprehensive/);
    const v = getProvenance("deposition.digest", "dep_test_long_fail")?.verification ?? d.provenance?.verification;
    expect(v?.status).not.toBe("verified");
    expect(v?.notes).toMatch(/coverage incomplete/);
  });

  it("fails when no window could be analysed (never a digest of nothing)", async () => {
    script.deposition_segment = () => { throw new Error("provider down"); };
    await expect(digestDeposition("dep_test_long_fail", { force: true })).rejects.toThrow(/none of the \d+ transcript windows could be analysed/);
  });

  it("preserveQualifications keeps every qualification once and leaves cited ones alone", () => {
    const out = preserveQualifications([{ cite: "20:01", text: "admission" }], ["Evasive at 140:13"], [{ cite: "220:1", text: "correction", qualifies: "20:01" }, { cite: "140:13", text: "already noted", qualifies: "" }, { cite: "220:01", text: "dup", qualifies: "" }]);
    expect(out).toEqual([{ cite: "20:01", text: "admission" }, { cite: "220:1", text: "QUALIFICATION (of 20:01): correction" }]);
  });
});
