import { beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { Document, Packer, Paragraph, TextRun } from "docx";
import { db, resetSqlite } from "@/lib/db";
import { MATTERS, PEOPLE } from "@/lib/seed/ids";
import type { TimelineEvent } from "@/lib/types/domain";
import { basisFromObjection, detectTranscriptFormat, parseTranscript, speakerName, summarizeIssues, transcriptToPageLine } from "@/modules/ediscovery/analysis/transcript-import";
import { extractTranscriptText, importFor, importTranscript, listImports } from "@/modules/ediscovery/analysis/transcript-import-server";
import { LIU_DEPOSITION, LIU_PARSED, LIU_TRANSCRIPT_TEXT } from "@/modules/ediscovery/analysis/seed-transcript-sample";
import { EXTRA_PEOPLE_IDS } from "@/modules/ediscovery/analysis/seed-people";
import { absoluteLine, designationTotals, mergeRanges, overlapLines, parseRange, playableRanges, rangeLines, rangesOverlap } from "@/modules/ediscovery/analysis/transcript";
import type { Designation, StoryFact } from "@/modules/ediscovery/analysis/types";
import { dateInText, factsFromIntel, factsFromTestimony, factsFromTimeline, mergeFacts, renumberFacts, storyCsv, storyMarkdown, verifyStoryCites } from "@/modules/ediscovery/analysis/stories";
import { addFacts, buildFacts, buildStory, citeEvidenceFor, createStory, deleteStory, getStory, listStories, storyExport, storySources, upsertFact, verifyStory } from "@/modules/ediscovery/analysis/service-stories";
import { findCrossReferences, groupCrossReferences } from "@/modules/ediscovery/analysis/cross-references";
import { graph } from "@/modules/ediscovery/analysis/service";
import { VALSARA_STORY } from "@/modules/ediscovery/analysis/seed-story";
import { VALSARA_TIMELINE } from "@/modules/ediscovery/analysis/seed-timeline";
import { VOSS_DEPOSITION } from "@/modules/ediscovery/analysis/seed-depo-vasudevan";
import { ANALYSIS_SEED_IDS } from "@/modules/ediscovery/analysis/seed";
import { matterIntelPanel } from "@/modules/ediscovery/analysis/intel-panel";
import * as importRoute from "@/app/api/ediscovery/analysis/depositions/import/route";
import * as xrefRoute from "@/app/api/ediscovery/analysis/depositions/[id]/cross-references/route";
import * as designationsRoute from "@/app/api/ediscovery/analysis/depositions/[id]/designations/route";
import * as storiesRoute from "@/app/api/ediscovery/analysis/stories/route";
import * as storyRoute from "@/app/api/ediscovery/analysis/stories/[id]/route";
import * as storyVerifyRoute from "@/app/api/ediscovery/analysis/stories/[id]/verify/route";
import * as storyExportRoute from "@/app/api/ediscovery/analysis/stories/[id]/export/route";
import * as storyDraftRoute from "@/app/api/ediscovery/analysis/stories/[id]/draft/route";
import * as intelRoute from "@/app/api/ediscovery/analysis/intel/route";
import * as peopleRoute from "@/app/api/ediscovery/analysis/people/route";

const VALSARA = MATTERS.valsara;
const BASE = "http://localhost";
const req = (path: string, init?: { method?: string; json?: unknown; body?: BodyInit; headers?: Record<string, string> }) =>
  new NextRequest(`${BASE}${path}`, { method: init?.method ?? "GET", ...(init?.json !== undefined ? { body: JSON.stringify(init.json), headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } } : init?.body ? { body: init.body, headers: init.headers } : {}) } as ConstructorParameters<typeof NextRequest>[1]);
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const json = async (r: Response) => ({ status: r.status, body: await r.json() });

beforeAll(() => { resetSqlite(); delete process.env.OPENAI_API_KEY; db(); });

// ---------------------------------------------------------------------------
// Transcript parser: three reporter formats plus Word
// ---------------------------------------------------------------------------

const PAGE_NUMBERED = `                    DEPOSITION OF MANISH SOOD
                         October 21, 2026
                            VOLUME II

Page 5
 1        THE VIDEOGRAPHER:  We are on the record at 9:02 a.m.
 2   EXAMINATION
 3   BY MS. KALE:
 4   Q.   State your name.
 5   A.   Manish Sood.
 6   Q.   What is your role?
 7        MR. MEHRA:  Objection, form.
 8   A.   Regulatory Affairs Counsel at Meridian.
 9   Q.   Did you review the 8(e) memo, marked as
10   Exhibit 3, MFC-0041936?
11   A.   I did.  In March 2001.
12        (Recess taken.)
Page 6
 1   Q.   Who decided not to file?
 2        MR. MEHRA:  Objection.  Calls for a legal
 3   conclusion; instruct the witness not to answer as to
 4   legal advice.
 5   A.   I can say the decision was made on March 26.
 6        (Exhibit Sood-1 marked for identification;
 7   8(e) decision memo, MFC-0041936.)
 8   Q.   Is Exhibit Sood-1 the memo?
 9   A.   Yes.
10        MS. KALE:  Nothing further.
`;

const LOOSE = `MR. MEHRA: Objection to the caption.
Q. When did you first see the Sundaram report?
A. In March of 2001. Hema Vasudevan brought it to me.
Q. Who else received it?
MR. MEHRA: Objection, asked and answered.
A. Girish Hegde and Anil Prasad.
THE WITNESS: I should add that Nandini Bose was copied.
Q. Did you discuss it with counsel?
MR. MEHRA: Objection. Instruct the witness not to answer on privilege grounds.
A. I decline to answer on the advice of counsel.
THE BAILIFF: This label is not a recognised speaker.
`;

describe("transcript parser", () => {
  it("parses page:line (.ptx) transcripts with speakers, objections, exhibits and header metadata", () => {
    expect(detectTranscriptFormat(LIU_TRANSCRIPT_TEXT)).toBe("page-line");
    const p = parseTranscript(LIU_TRANSCRIPT_TEXT, { speakers: { "MS. KALE": "Radhika Kale", "MR. MEHRA": "Arjun Mehra" } });
    expect(p.format).toBe("page-line");
    expect(p.transcript.length).toBeGreaterThanOrEqual(35);
    expect(p.transcript[0]).toMatchObject({ page: 6, line: 6, question: "Please state your full name for the record.", answer: "Kavita Meena Lal." });
    // wrapped lines are joined; page:line stays that of the Q. line
    expect(p.transcript.find((q) => q.page === 6 && q.line === 9)?.answer).toBe("Director of Marketing for the textile chemicals line. I reported to Anil Prasad.");
    // objections attach to the pending question with a basis and the reporter's words
    const obj = p.transcript.find((q) => q.page === 10 && q.line === 3);
    expect(obj?.objection).toMatchObject({ by: "Arjun Mehra", basis: "foundation" });
    const spec = p.transcript.find((q) => q.page === 12 && q.line === 6);
    expect(spec?.objection?.basis).toBe("speculation");
    expect(spec?.answer).toContain("Anil told me Legal had reviewed the wording.");
    const aa = p.transcript.find((q) => q.page === 88 && q.line === 17);
    expect(aa?.objection?.basis).toBe("asked-and-answered");
    // exhibits: marked in parentheticals and referenced in questions
    expect(p.exhibits.map((e) => e.id)).toEqual(expect.arrayContaining(["Lal-1", "Lal-2", "Vasudevan-5"])); // "previously marked as Vasudevan-5"
    expect(p.exhibits.find((e) => e.id === "Vasudevan-5")?.bates).toBe("MFC-0041964");
    expect(p.exhibits.find((e) => e.id === "Lal-1")?.bates).toBe("MFC-0041955");
    expect(p.transcript.find((q) => q.page === 9 && q.line === 14)?.exhibit).toBe("Lal-1");
    // header metadata and speakers
    expect(p.meta).toMatchObject({ witnessName: "Kavita Lal", date: "2026-09-17", volume: 1, takenBy: "Radhika Kale", defendingBy: "Arjun Mehra" });
    expect(p.meta.caseCaption).toContain("VALSARA TEXTILE PARK LTD. v. MERIDIAN FINE CHEMICALS LTD.");
    expect(p.speakers.find((s) => s.label === "Radhika Kale")?.role).toBe("examiner");
    expect(p.speakers.find((s) => s.label === "Arjun Mehra")?.role).toBe("defender");
    expect(p.stats.objections).toBeGreaterThanOrEqual(8);
    expect(p.stats.colloquy).toBeGreaterThan(3);
    expect(p.pages).toBe(97);
    expect(p.firstPage).toBe(6);
    expect(p.confidence).toBeGreaterThanOrEqual(0.9);
    // the seeded deposition came through the same parser
    expect(LIU_PARSED.transcript.length).toBe(p.transcript.length);
    expect(LIU_DEPOSITION.transcript.length).toBe(p.transcript.length);
  });

  it("parses page-marker + margin-number transcripts, joining wrapped lines and multi-line objections", () => {
    expect(detectTranscriptFormat(PAGE_NUMBERED)).toBe("page-numbered");
    const p = parseTranscript(PAGE_NUMBERED);
    expect(p.format).toBe("page-numbered");
    expect(p.transcript.map((q) => `${q.page}:${q.line}`)).toEqual(["5:4", "5:6", "5:9", "6:1", "6:8"]);
    expect(p.transcript[1].objection).toMatchObject({ by: "Mr. Mehra", basis: "form" });
    expect(p.transcript[1].answer).toBe("Regulatory Affairs Counsel at Meridian.");
    expect(p.transcript[2].question).toBe("Did you review the 8(e) memo, marked as Exhibit 3, MFC-0041936?");
    expect(p.transcript[2].exhibit).toBe("3");
    expect(p.transcript[3].objection?.basis).toBe("privilege");
    expect(p.transcript[3].objection?.text).toContain("instruct the witness not to answer");
    expect(p.transcript[3].answer).toBe("I can say the decision was made on March 26.");
    expect(p.exhibits.find((e) => e.id === "Sood-1")).toMatchObject({ bates: "MFC-0041936" });
    expect(p.exhibits.find((e) => e.id === "3")?.bates).toBe("MFC-0041936");
    expect(p.meta).toMatchObject({ witnessName: "Manish Sood", date: "2026-10-21", volume: 2, takenBy: "Ms. Kale", defendingBy: "Mr. Mehra" });
    expect(p.pages).toBe(6);
    expect(p.stats.numberedLines).toBeGreaterThan(15);
    expect(p.issues.filter((i) => i.kind === "unnumbered").length).toBe(3); // the three header lines
    expect(p.confidence).toBeGreaterThan(0.6);
  });

  it("parses unnumbered Q./A. text with estimated page:line, lower confidence and explicit issues", () => {
    expect(detectTranscriptFormat(LOOSE)).toBe("loose");
    const p = parseTranscript(LOOSE, { firstPage: 12 });
    expect(p.format).toBe("loose");
    expect(p.transcript).toHaveLength(3);
    // the orphan objection on the first line occupies an estimated line, so the first question starts at 12:2
    expect(p.transcript[0]).toMatchObject({ page: 12, line: 2, question: "When did you first see the Sundaram report?" });
    expect(p.transcript[1].objection?.basis).toBe("asked-and-answered");
    expect(p.transcript[1].answer).toBe("Girish Hegde and Anil Prasad. I should add that Nandini Bose was copied.");
    expect(p.transcript[2].objection?.basis).toBe("privilege");
    const kinds = summarizeIssues(p.issues).map((i) => i.kind);
    expect(kinds).toEqual(expect.arrayContaining(["no-page-markers", "orphan-objection", "unknown-speaker"]));
    expect(p.confidence).toBeLessThan(0.5);
    // ordering of confidence across formats
    const numbered = parseTranscript(PAGE_NUMBERED);
    const pageLine = parseTranscript(LIU_TRANSCRIPT_TEXT);
    expect(pageLine.confidence).toBeGreaterThanOrEqual(numbered.confidence);
    expect(numbered.confidence).toBeGreaterThan(p.confidence);
  });

  it("never throws on empty or malformed input and round-trips through transcriptToPageLine", () => {
    expect(parseTranscript("").transcript).toHaveLength(0);
    expect(parseTranscript("").confidence).toBe(0);
    expect(() => parseTranscript("\u0000\u0001 garbage \f 99:99 nothing")).not.toThrow();
    const noAnswers = parseTranscript("0001:01 Q. One?\n0001:02 Q. Two?");
    expect(noAnswers.transcript).toHaveLength(2);
    expect(noAnswers.transcript[0].answer).toBe("(no answer recorded)");
    expect(noAnswers.confidence).toBeLessThanOrEqual(0.2);
    const text = transcriptToPageLine(VOSS_DEPOSITION.transcript.slice(0, 5));
    const back = parseTranscript(text);
    expect(back.format).toBe("page-line");
    expect(back.transcript.map((q) => q.question)).toEqual(VOSS_DEPOSITION.transcript.slice(0, 5).map((q) => q.question));
    expect(back.transcript.map((q) => `${q.page}:${q.line}`)).toEqual(VOSS_DEPOSITION.transcript.slice(0, 5).map((q) => `${q.page}:${q.line}`));
    expect(basisFromObjection("Objection, mischaracterizes the testimony")).toBe("mischaracterizes");
    expect(basisFromObjection("Objection.")).toBe("form");
    expect(speakerName("MR. MEHRA")).toBe("Mr. Mehra");
    expect(speakerName("MS. KALE", { "MS. KALE": "Radhika Kale" })).toBe("Radhika Kale");
  });

  it("extracts .docx transcripts through mammoth and keeps page:line detection", async () => {
    const lines = LIU_TRANSCRIPT_TEXT.split("\n").slice(0, 60);
    const doc = new Document({ sections: [{ children: lines.map((l) => new Paragraph({ children: [new TextRun(l)] })) }] });
    const buf = await Packer.toBuffer(doc);
    const r = await extractTranscriptText(new Uint8Array(buf), "Liu_Vol1.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(r.sourceKind).toBe("docx");
    expect(r.text).toContain("Please state your full name for the record.");
    const p = parseTranscript(r.text);
    expect(p.format).toBe("page-line");
    expect(p.transcript[0]).toMatchObject({ page: 6, line: 6 });
    await expect(extractTranscriptText(new Uint8Array([1, 2, 3]), "scan.pdf", "application/pdf")).rejects.toMatchObject({ status: 415 });
    const txt = await extractTranscriptText(new TextEncoder().encode("﻿0001:01 Q. Hi?\n0001:02 A. Hello."), "t.ptx", "text/plain");
    expect(txt.sourceKind).toBe("ptx");
    expect(txt.text.startsWith("0001:01")).toBe(true);
  });

  it("imports a transcript into the matter, binding the witness only within the matter's people", () => {
    const before = db().people.count();
    const r = importTranscript({ matterId: VALSARA, text: PAGE_NUMBERED, sourceName: "Suarez_Vol2.txt", sourceKind: "txt" });
    expect(r.created).toBe(true);
    expect(r.deposition.witnessId).toBe(PEOPLE.manishSood); // Manish Sood is on this matter (scheduled deposition)
    expect(r.deposition.status).toBe("transcribed");
    expect(r.deposition.volume).toBe(2);
    expect(r.deposition.date).toBe("2026-10-21");
    expect(r.deposition.exhibits?.some((e) => e.id === "Sood-1" && e.bates === "MFC-0041936")).toBe(true);
    expect(db().people.count()).toBe(before);
    expect(importFor(r.deposition.id)?.format).toBe("page-numbered");
    expect(listImports(VALSARA).some((x) => x.id === r.record.id)).toBe(true);
    expect(listImports(VALSARA).some((x) => x.id === ANALYSIS_SEED_IDS.transcriptImport)).toBe(true);
    // replace a scheduled deposition's (empty) transcript instead of adding a twin
    const scheduled = db().depositions.get(ANALYSIS_SEED_IDS.depositions.sood)!;
    const rep = importTranscript({ matterId: VALSARA, text: PAGE_NUMBERED, depositionId: ANALYSIS_SEED_IDS.depositions.sood, witnessName: "Manish Sood" });
    expect(rep.created).toBe(false);
    expect(rep.deposition.id).toBe(ANALYSIS_SEED_IDS.depositions.sood);
    expect(rep.deposition.transcript.length).toBe(5);
    expect(rep.deposition.status).toBe("transcribed");
    db().depositions.put(scheduled); // restore the seeded (scheduled) record
    // cross-matter name collision: "Kavita Lal" exists on the Valsara matter; importing her name into another matter must create a new person
    const other = importTranscript({ matterId: MATTERS.northgate, text: LOOSE, witnessName: "Kavita Lal" });
    expect(other.deposition.witnessId).not.toBe(EXTRA_PEOPLE_IDS.liu);
    expect(db().people.get(other.deposition.witnessId)?.name).toBe("Kavita Lal");
    expect(() => importTranscript({ matterId: "m_nope", text: LOOSE, witnessName: "X" })).toThrow(/Unknown matter/);
    expect(() => importTranscript({ matterId: VALSARA, text: LOOSE })).toThrow(/witnessName/);
    expect(() => importTranscript({ matterId: VALSARA, text: "nothing here", witnessName: "X" })).toThrow(/No Q\/A/);
    // clean up so the deposition counts in the sibling suite stay meaningful
    db().depositions.delete(r.deposition.id);
    db().depositions.delete(other.deposition.id);
    db().people.delete(other.deposition.witnessId);
  });
});

// ---------------------------------------------------------------------------
// Designation math
// ---------------------------------------------------------------------------

const dsg = (id: string, range: string, purpose: Designation["purpose"], extra: Partial<Designation> = {}): Designation => {
  const r = parseRange(range)!;
  return { id, matterId: VALSARA, depositionId: "dep_x", ...r, purpose, createdAt: "2026-09-01T00:00:00.000Z", createdBy: "p_jwhitfield", ...extra };
};

describe("designation math", () => {
  it("measures ranges in absolute lines, merges touching ranges and computes overlaps", () => {
    expect(absoluteLine(1, 1)).toBe(1);
    expect(absoluteLine(2, 1)).toBe(26);
    expect(rangeLines(parseRange("24:05-24:10")!)).toBe(6);
    expect(rangeLines(parseRange("24:20-25:05")!)).toBe(11);
    expect(rangeLines(parseRange("24:05")!)).toBe(1);
    expect(rangesOverlap(parseRange("24:05-24:10")!, parseRange("24:10-24:12")!)).toBe(true);
    expect(rangesOverlap(parseRange("24:05-24:10")!, parseRange("24:11-24:12")!)).toBe(false);
    expect(overlapLines(parseRange("24:05-24:10")!, parseRange("24:08-25:02")!)).toBe(3);
    expect(overlapLines(parseRange("24:05-24:10")!, parseRange("26:01")!)).toBe(0);
    const merged = mergeRanges([parseRange("24:11-24:15")!, parseRange("24:05-24:10")!, parseRange("30:01-30:03")!]);
    expect(merged).toEqual([{ startPage: 24, startLine: 5, endPage: 24, endLine: 15 }, { startPage: 30, startLine: 1, endPage: 30, endLine: 3 }]);
    expect(parseRange("24:5 – 26:12")).toEqual({ startPage: 24, startLine: 5, endPage: 26, endLine: 12 });
    expect(parseRange("26:12 to 24:05")).toEqual({ startPage: 24, startLine: 5, endPage: 26, endLine: 12 });
    expect(parseRange("24:99")).toBeNull();
    expect(parseRange("abc")).toBeNull();
  });

  it("totals designations by purpose without double counting, checks counter integrity and rulings", () => {
    const list = [
      dsg("a1", "24:05-26:12", "affirmative"),
      dsg("a2", "26:01-26:20", "affirmative"), // overlaps a1: distinct lines counted once
      dsg("c1", "26:21-27:02", "counter", { counterTo: "a1" }),
      dsg("c2", "90:01-90:10", "counter", { counterTo: "a1" }), // far from a1
      dsg("c3", "27:03-27:10", "counter", { counterTo: "missing" }),
      dsg("i1", "40:01-40:05", "impeachment", { objection: { basis: "relevance", ruling: "sustained" } }),
      dsg("o1", "41:01", "objection", { objection: { basis: "form" } }),
    ];
    const t = designationTotals(list);
    expect(t.count).toBe(7);
    expect(t.byPurpose).toEqual({ affirmative: 2, counter: 3, impeachment: 1, objection: 1 });
    expect(t.lines.affirmative).toBe(rangeLines(parseRange("24:05-26:20")!));
    expect(t.lines.counter).toBe(7 + 10 + 8);
    expect(t.lines.all).toBe(rangeLines(parseRange("24:05-27:10")!) + 10 + 5 + 1);
    expect(t.danglingCounters).toBe(1);
    expect(t.detachedCounters).toBe(1);
    expect(t.objections).toEqual({ total: 2, sustained: 1, overruled: 0, pending: 1 });
    expect(t.estimatedMinutes).toBeCloseTo((t.lines.all / 25) * 1.5, 1);
  });

  it("plays affirmative and counter ranges minus testimony struck by a sustained objection", () => {
    const list = [
      dsg("a1", "24:05-26:12", "affirmative"),
      dsg("c1", "26:13-27:02", "counter", { counterTo: "a1" }),
      dsg("i1", "50:01-50:05", "impeachment"), // impeachment never plays
      dsg("x1", "25:01-25:10", "objection", { objection: { basis: "hearsay", ruling: "sustained" } }),
      dsg("x2", "26:20-26:22", "objection", { objection: { basis: "form", ruling: "overruled" } }),
    ];
    expect(playableRanges(list)).toEqual([
      { startPage: 24, startLine: 5, endPage: 24, endLine: 25 },
      { startPage: 25, startLine: 11, endPage: 27, endLine: 2 },
    ]);
    // a designation that is itself sustained does not play at all
    expect(playableRanges([dsg("a1", "24:05-24:10", "affirmative", { objection: { basis: "relevance", ruling: "sustained" } })])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Story builder: build, merge, verify, export
// ---------------------------------------------------------------------------

describe("story builder", () => {
  it("builds facts from chronology events, flagged testimony and intelligence entries", () => {
    const names = new Map([[VOSS_DEPOSITION.id, VOSS_DEPOSITION.witnessName]]);
    const fromTl = factsFromTimeline(VALSARA_TIMELINE.slice(0, 12), { witnessNames: names });
    expect(fromTl.length).toBe(12);
    expect(fromTl.map((f) => f.order)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    expect(fromTl.every((f, i) => i === 0 || f.date >= fromTl[i - 1].date)).toBe(true);
    const withDoc = fromTl.find((f) => f.evidence.some((e) => e.kind === "document"))!;
    expect(withDoc.evidence.find((e) => e.kind === "document")).toMatchObject({ bates: expect.stringMatching(/^MFC-/) });
    const withDepo = fromTl.find((f) => f.evidence.some((e) => e.kind === "testimony"))!;
    const t = withDepo.evidence.find((e) => e.kind === "testimony")!;
    expect(t.kind === "testimony" && t.page > 0 && t.line > 0 && t.depositionId.startsWith("dep_")).toBe(true);
    expect(fromTl.every((f) => f.evidence.some((e) => e.kind === "event"))).toBe(true);
    expect(fromTl.every((f) => f.origin === "timeline")).toBe(true);

    const fromDep = factsFromTestimony(VOSS_DEPOSITION);
    const flagged = VOSS_DEPOSITION.transcript.filter((q) => q.flags?.some((f) => ["admission", "key", "contradiction"].includes(f)));
    expect(fromDep.length).toBe(flagged.length);
    expect(fromDep.every((f) => f.evidence[0].kind === "testimony")).toBe(true);
    expect(fromDep.some((f) => f.disputed)).toBe(true);
    expect(fromDep.every((f) => /^\d{4}-\d{2}-\d{2}$/.test(f.date))).toBe(true);
    expect(dateInText("She wrote to me on March 14, 2001 about it")).toBe("2001-03-14");
    expect(dateInText("in April 2001")).toBe("2001-04-01");
    expect(dateInText("nothing dated")).toBeUndefined();

    const fromIntel = factsFromIntel([
      { at: "2018-12-07", title: "Transfer order", confidence: 0.9, evidence: [{ docId: "idoc_seed_vls_entry_transfer" }] },
      { at: "2019-01-01", title: "Already on the timeline", confidence: 0.9, evidence: [{ docId: "tl_vls_001" }] },
      { at: "2020-01-01", title: "Too weak", confidence: 0.2, evidence: [{ docId: "idoc_x" }] },
    ], { minConfidence: 0.5 });
    expect(fromIntel.map((f) => f.text)).toEqual(["Transfer order"]);
    expect(fromIntel[0].evidence[0]).toMatchObject({ kind: "intel", docId: "idoc_seed_vls_entry_transfer" });
  });

  it("merges near-duplicate facts by unioning evidence and never twins them", () => {
    const a: StoryFact = { id: "f1", order: 1, date: "2001-03-14", text: "Sundaram final report received", evidence: [{ kind: "document", bates: "MFC-0041877" }], confidence: 0.8, origin: "user" };
    const incoming: StoryFact[] = [
      { id: "f2", order: 1, date: "2001-03-14", text: "Sundaram final report received: liver effects", evidence: [{ kind: "document", bates: "MFC-0041880" }, { kind: "document", bates: "MFC-0041877" }], confidence: 0.95, disputed: true, origin: "timeline" },
      { id: "f3", order: 2, date: "2002-07-08", text: "MW-7 at 41 µg/L reported", evidence: [{ kind: "document", bates: "MFC-0052210" }], confidence: 0.9, origin: "timeline" },
    ];
    const r = mergeFacts([a], incoming);
    expect(r.added.map((f) => f.id)).toEqual(["f3"]);
    expect(r.merged).toHaveLength(1);
    expect(r.facts).toHaveLength(2);
    const merged = r.facts.find((f) => f.id === "f1")!;
    expect(merged.evidence.map((e) => (e.kind === "document" ? e.bates : ""))).toEqual(["MFC-0041877", "MFC-0041880"]);
    expect(merged.confidence).toBe(0.95);
    expect(merged.disputed).toBe(true);
    expect(merged.text).toBe("Sundaram final report received"); // a user's wording is kept
    expect(r.facts.map((f) => f.order)).toEqual([1, 2]);
    expect(renumberFacts([incoming[1], incoming[0]]).map((f) => f.id)).toEqual(["f2", "f3"]);
  });

  it("verifies cites against the record: wrong Bates and out-of-range pages stay unresolved, never remapped", () => {
    const evidence = { bates: new Set(["MFC-0041877"]), pagesByDeposition: new Map([["dep_a", new Set([24, 25])]]), intelDocIds: new Set(["idoc_1"]), eventIds: new Set(["tl_1"]) };
    const report = verifyStoryCites({ id: "s", facts: [
      { id: "f1", order: 1, date: "2001-03-14", text: "ok", evidence: [{ kind: "document", bates: "mfc-0041877" }, { kind: "testimony", depositionId: "dep_a", page: 24, line: 5 }, { kind: "intel", docId: "idoc_1" }, { kind: "event", eventId: "tl_1" }], confidence: 1 },
      { id: "f2", order: 2, date: "2001-03-15", text: "bad", evidence: [{ kind: "document", bates: "MFC-9999999" }, { kind: "testimony", depositionId: "dep_a", page: 99, line: 1 }, { kind: "testimony", depositionId: "dep_missing", page: 1, line: 1 }, { kind: "intel", docId: "idoc_nope" }, { kind: "event", eventId: "tl_nope" }], confidence: 1 },
    ] }, evidence);
    expect(report.checked).toBe(9);
    expect(report.resolved).toBe(4);
    expect(report.unresolved.map((u) => u.reason)).toEqual(["Bates number not in the review set", "page not in the excerpted transcript", "deposition not found", "intelligence record not found", "timeline event not found"]);
    expect(report.unresolved.every((u) => u.factId === "f2")).toBe(true);
  });

  it("creates, builds, merges, verifies and exports stories through the service", () => {
    const seeded = getStory(ANALYSIS_SEED_IDS.story)!;
    expect(seeded.facts.length).toBeGreaterThanOrEqual(8);
    expect(seeded.facts.length).toBeLessThanOrEqual(12);
    expect(seeded.facts.every((f) => f.evidence.length > 0)).toBe(true);
    expect(listStories(VALSARA).find((s) => s.id === seeded.id)).toMatchObject({ factCount: seeded.facts.length, from: seeded.facts[0].date });
    // every seeded cite resolves against the record
    const ev = citeEvidenceFor(VALSARA);
    expect(ev.bates.size).toBeGreaterThan(50);
    const seededReport = verifyStoryCites(seeded, ev);
    expect(seededReport.unresolved).toEqual([]);
    expect(seededReport.resolved).toBe(seededReport.checked);
    const src = storySources(seeded);
    expect(src.docs.length).toBeGreaterThan(8);
    expect(src.depositions.map((d) => d.id)).toEqual(expect.arrayContaining([VOSS_DEPOSITION.id, LIU_DEPOSITION.id]));

    // build from the chronology, then merge a second build into the same story without twins
    const built = buildStory(VALSARA, { from: "timeline", minSignificance: 4, title: "Key events" });
    expect(built.story.title).toBe("Key events");
    expect(built.built).toBe(buildFacts(VALSARA, { from: "timeline", minSignificance: 4 }).length);
    expect(built.story.facts.length).toBe(built.built);
    const again = buildStory(VALSARA, { from: "timeline", minSignificance: 4, storyId: built.story.id });
    expect(again.added).toBe(0);
    expect(again.merged).toBe(built.built);
    expect(getStory(built.story.id)!.facts.length).toBe(built.built);
    const fromTestimony = buildStory(VALSARA, { from: "testimony", depositionIds: [VOSS_DEPOSITION.id], flags: ["admission"], storyId: built.story.id });
    expect(fromTestimony.built).toBe(VOSS_DEPOSITION.transcript.filter((q) => q.flags?.includes("admission")).length);
    expect(getStory(built.story.id)!.facts.some((f) => f.origin === "testimony")).toBe(true);
    const intelFacts = buildFacts(VALSARA, { from: "intel" });
    expect(intelFacts.every((f) => f.origin === "intel" && f.evidence.every((e) => e.kind === "intel"))).toBe(true);

    // a hand-typed fact with a Bates that is not in the record is verified as unresolved and not mapped elsewhere
    const s = createStory(VALSARA, { title: "Verify me" });
    upsertFact(s.id, { date: "2001-03-14", text: "Real fact", evidence: [{ kind: "document", bates: "MFC-0041877" }, { kind: "testimony", depositionId: VOSS_DEPOSITION.id, page: 24, line: 5 }] });
    upsertFact(s.id, { date: "2001-03-15", text: "Wrong Bates", evidence: [{ kind: "document", bates: "MFC-0099999" }] });
    expect(() => upsertFact(s.id, { text: "no date" })).toThrow(/ISO/);
    const v = verifyStory(s.id)!;
    expect(v.report.checked).toBe(3);
    expect(v.report.unresolved).toEqual([{ factId: expect.any(String), cite: "MFC-0099999", reason: "Bates number not in the review set" }]);
    expect(v.story.facts.map((f) => f.verified)).toEqual([true, false]);
    expect(storySources(v.story).docs.map((d) => d.bates)).toEqual(["MFC-0041877"]);
    const r2 = addFacts(s.id, [{ id: "x", order: 0, date: "2001-03-14", text: "Real fact", evidence: [{ kind: "document", bates: "MFC-0041880" }], confidence: 0.5 }]);
    expect(r2).toMatchObject({ added: 0, merged: 1 });
    expect(getStory(s.id)!.facts[0].evidence).toHaveLength(3);

    const csv = storyExport(s.id, "csv")!;
    expect(csv.filename).toBe("story-verify-me.csv");
    expect(csv.body.split("\r\n")[0]).toBe("#,Date,End date,Precision,Fact,Evidence,Confidence,Disputed,Verified,Origin");
    expect(csv.body).toContain("MFC-0099999");
    const md = storyExport(s.id, "markdown")!;
    expect(md.body).toContain("# Verify me");
    expect(md.body).toContain("| # | Cite | Kind | Excerpt |");
    expect(md.body).toContain("**Mar 14, 2001** — Real fact [MFC-0041877; Vasudevan 24:05; MFC-0041880]");
    expect(storyCsv(seeded).split("\r\n").length).toBe(seeded.facts.length + 2);
    expect(storyMarkdown(seeded)).toContain("*(disputed)*");
    expect(deleteStory(s.id)).toBe(true);
    expect(deleteStory(built.story.id)).toBe(true);
    expect(getStory(s.id)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Cross references, enriched graph, intelligence panel
// ---------------------------------------------------------------------------

describe("cross references and people graph", () => {
  it("finds documents cited in testimony by Bates, exhibit, subject and date with calibrated confidence", () => {
    const docs = db().edocs.find((x) => x.matterId === VALSARA).map((x) => ({ id: x.id, bates: x.bates, batesEnd: x.batesEnd, subject: x.subject, date: x.date, type: x.type }));
    const refs = findCrossReferences(LIU_DEPOSITION, docs);
    const bates = refs.filter((r) => r.kind === "bates");
    expect(bates.some((r) => r.bates === "MFC-0041964" && r.docId && r.confidence === 1)).toBe(true);
    const exhibit = refs.filter((r) => r.kind === "exhibit");
    expect(exhibit.some((r) => r.bates === "MFC-0041955" && r.docId)).toBe(true);
    expect(refs.every((r) => r.confidence > 0 && r.confidence <= 1 && r.page > 0)).toBe(true);
    const groups = groupCrossReferences(refs);
    expect(groups[0].best).toBeGreaterThanOrEqual(groups[groups.length - 1].best);
    expect(groups.every((g) => g.hits.length > 0)).toBe(true);
    // a Bates number that is not in the review set is reported as unresolved (0.5), never mapped to another document
    const foreign = findCrossReferences({ transcript: [{ page: 1, line: 1, question: "Look at MFC-0999999.", answer: "Yes." }], exhibits: [] }, docs);
    expect(foreign).toEqual([expect.objectContaining({ kind: "bates", bates: "MFC-0999999", docId: undefined, confidence: 0.5 })]);
  });

  it("enriches the matter graph with testimony counts, dated evidence and organizations", () => {
    const g = graph(VALSARA);
    const vasudevan = g.nodes.find((n) => n.id === PEOPLE.hemaVasudevan)!;
    expect(vasudevan.testimony).toBeGreaterThan(VOSS_DEPOSITION.transcript.length);
    const org02 = g.edges.find((e) => e.id === "rel_vls_org_02")!;
    expect(org02.evidence[0]).toMatchObject({ kind: "deposition", depositionId: VOSS_DEPOSITION.id, date: VOSS_DEPOSITION.date, cite: "Vasudevan 11:14" });
    const org01 = g.edges.find((e) => e.id === "rel_vls_org_01")!;
    expect(org01.evidence[0]).toMatchObject({ kind: "document", docId: "ed_vls_0011", date: db().edocs.get("ed_vls_0011")!.date });
    expect(org01.firstDate).toBe(org01.lastDate);
    const dated = g.edges.filter((e) => e.firstDate);
    expect(dated.length).toBeGreaterThan(30);
    expect(dated.every((e) => e.firstDate! <= e.lastDate!)).toBe(true);
    expect(g.orgs?.[0]).toMatchObject({ label: "Meridian Fine Chemicals Ltd." });
    expect(g.orgs!.find((o) => o.label === "Meridian Fine Chemicals Ltd.")!.memberIds).toEqual(expect.arrayContaining([PEOPLE.hemaVasudevan, PEOPLE.girishHegde]));
    expect(g.orgs!.reduce((n, o) => n + o.memberIds.length, 0)).toBe(g.nodes.length);
  });

  it("aggregates matter intelligence with graceful empties and merges the intel chronology into the timeline once", async () => {
    const panel = await matterIntelPanel(MATTERS.depo); // the arbitration has no public intel records; the MDL matter does
    expect(panel.matterId).toBe(MATTERS.depo);
    expect(panel.available).toBe(true);
    expect(panel.sources.total).toBeGreaterThan(0);
    expect(Array.isArray(panel.docket)).toBe(true);
    expect(Array.isArray(panel.regulatory)).toBe(true);
    expect(panel.chronology.entries).toBeGreaterThan(0);
    expect(panel.regulatory.every((r) => r.docIds.length > 0 && r.confidence >= 0 && r.confidence <= 1)).toBe(true);
    if (panel.judge) expect(panel.judge.href).toMatch(/^\/intel\//);
    if (panel.mdl) expect(panel.mdl.href).toMatch(/^\/intel/);
    const quiet = await matterIntelPanel(MATTERS.sterling);
    expect(quiet.docket).toEqual([]);
    expect(quiet.judge).toBeNull();
    await expect(matterIntelPanel("m_nope")).rejects.toMatchObject({ status: 404 });
  }, 20_000);
});

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

describe("route handlers", () => {
  it("POST /depositions/import previews and imports JSON and multipart transcripts", async () => {
    const preview = await json(await importRoute.POST(req("/api/ediscovery/analysis/depositions/import", { method: "POST", json: { matterId: VALSARA, text: PAGE_NUMBERED, preview: true } })));
    expect(preview.status).toBe(200);
    expect(preview.body.parsed.format).toBe("page-numbered");
    expect(preview.body.parsed.transcript).toHaveLength(5);
    const before = db().depositions.count((d) => d.matterId === VALSARA);
    const fd = new FormData();
    fd.append("file", new File([PAGE_NUMBERED], "Suarez_Vol2.txt", { type: "text/plain" }));
    fd.append("matterId", VALSARA);
    fd.append("witnessTitle", "Regulatory Affairs Counsel");
    const created = await json(await importRoute.POST(new NextRequest(`${BASE}/api/ediscovery/analysis/depositions/import`, { method: "POST", body: fd })));
    expect(created.status).toBe(201);
    expect(db().depositions.count((d) => d.matterId === VALSARA)).toBe(before + 1);
    expect(created.body.deposition.witnessId).toBe(PEOPLE.manishSood);
    expect(created.body.summary.qaCount).toBe(5);
    expect(created.body.record.sourceKind).toBe("txt");
    expect(created.body.record.sourceName).toBe("Suarez_Vol2.txt");
    const list = await json(await importRoute.GET(req(`/api/ediscovery/analysis/depositions/import?matter=${VALSARA}`)));
    expect(list.body.imports.some((x: { id: string }) => x.id === created.body.record.id)).toBe(true);
    expect((await importRoute.POST(req("/api/ediscovery/analysis/depositions/import", { method: "POST", json: { matterId: VALSARA } }))).status).toBe(400);
    expect((await importRoute.POST(req("/api/ediscovery/analysis/depositions/import", { method: "POST", json: { matterId: "m_nope", text: LOOSE } }))).status).toBe(404);
    db().depositions.delete(created.body.deposition.id);
  });

  it("GET /depositions/[id]/cross-references and designations CSV / markdown", async () => {
    const x = await json(await xrefRoute.GET(req(`/api/ediscovery/analysis/depositions/${LIU_DEPOSITION.id}/cross-references?min=0.9`), params(LIU_DEPOSITION.id)));
    expect(x.status).toBe(200);
    expect(x.body.references.every((r: { confidence: number }) => r.confidence >= 0.9)).toBe(true);
    expect(x.body.groups.length).toBeGreaterThan(0);
    expect((await xrefRoute.GET(req("/api/x"), params("dep_nope"))).status).toBe(404);
    const created = await json(await designationsRoute.POST(req(`/api/ediscovery/analysis/depositions/${VOSS_DEPOSITION.id}/designations`, { method: "POST", json: { startPage: 24, startLine: 5, endPage: 24, endLine: 20, purpose: "affirmative", note: "Half-life" } }), params(VOSS_DEPOSITION.id)));
    expect(created.status).toBe(201);
    const counter = await json(await designationsRoute.POST(req(`/api/x`, { method: "POST", json: { startPage: 24, startLine: 21, endPage: 25, endLine: 2, purpose: "counter", counterTo: created.body.designation.id } }), params(VOSS_DEPOSITION.id)));
    expect(counter.status).toBe(201);
    const patched = await json(await designationsRoute.PATCH(req(`/api/x`, { method: "PATCH", json: { id: created.body.designation.id, objection: { basis: "relevance", ruling: "overruled" } } })));
    expect(patched.body.designation.objection).toEqual({ basis: "relevance", ruling: "overruled" });
    const csv = await designationsRoute.GET(req(`/api/x?format=csv`), params(VOSS_DEPOSITION.id));
    expect(csv.headers.get("content-disposition")).toContain("designations-hema-vasudevan-vol1.csv");
    expect((await csv.text()).split("\r\n")).toHaveLength(4);
    const md = await json(await designationsRoute.GET(req(`/api/x?format=markdown`), params(VOSS_DEPOSITION.id)));
    expect(md.body.count).toBe(2);
    expect(md.body.markdown).toContain("| 1 | 24:05–24:20 | affirmative |");
    for (const id of [created.body.designation.id, counter.body.designation.id]) expect((await json(await designationsRoute.DELETE(req(`/api/x?id=${id}`, { method: "DELETE" })))).body.ok).toBe(true);
  });

  it("stories: list, build, patch facts, verify, export and gate the narrative draft on the key", async () => {
    const list = await json(await storiesRoute.GET(req(`/api/ediscovery/analysis/stories?matter=${VALSARA}`)));
    expect(list.status).toBe(200);
    expect(list.body.stories.some((s: { id: string }) => s.id === VALSARA_STORY.id)).toBe(true);
    const built = await json(await storiesRoute.POST(req("/api/ediscovery/analysis/stories", { method: "POST", json: { matterId: VALSARA, title: "Route story", build: { from: "testimony", depositionIds: [VOSS_DEPOSITION.id], flags: ["admission"] } } })));
    expect(built.status).toBe(201);
    expect(built.body.built).toBeGreaterThan(3);
    const id = built.body.story.id as string;
    expect((await storiesRoute.POST(req("/api/x", { method: "POST", json: { matterId: VALSARA, build: { from: "nope" } } }))).status).toBe(400);
    expect((await storiesRoute.POST(req("/api/x", { method: "POST", json: { matterId: VALSARA } }))).status).toBe(400);
    const got = await json(await storyRoute.GET(req("/api/x"), params(id)));
    expect(got.body.story.facts.length).toBe(built.body.built);
    expect(got.body.sources.depositions[0].id).toBe(VOSS_DEPOSITION.id);
    const withFact = await json(await storyRoute.PATCH(req("/api/x", { method: "PATCH", json: { fact: { date: "2001-03-26", text: "Meridian decided not to file an 8(e) notice", evidence: [{ kind: "document", bates: "MFC-0041936" }, { kind: "document", bates: "MFC-0000000" }] } } }), params(id)));
    expect(withFact.body.story.facts.length).toBe(built.body.built + 1);
    const factId = withFact.body.story.facts.find((f: { text: string }) => f.text.startsWith("Meridian decided")).id;
    const verified = await json(await storyVerifyRoute.POST(req("/api/x", { method: "POST" }), params(id)));
    expect(verified.status).toBe(200);
    expect(verified.body.report.unresolved).toEqual([{ factId, cite: "MFC-0000000", reason: "Bates number not in the review set" }]);
    expect(verified.body.story.facts.find((f: { id: string }) => f.id === factId).verified).toBe(false);
    const renamed = await json(await storyRoute.PATCH(req("/api/x", { method: "PATCH", json: { title: "Route story 2", theme: "Reporting" } }), params(id)));
    expect(renamed.body.story).toMatchObject({ title: "Route story 2", theme: "Reporting" });
    const removed = await json(await storyRoute.PATCH(req("/api/x", { method: "PATCH", json: { removeFactId: factId } }), params(id)));
    expect(removed.body.story.facts.some((f: { id: string }) => f.id === factId)).toBe(false);
    const csv = await storyExportRoute.GET(req("/api/x?format=csv"), params(id));
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect(csv.headers.get("content-disposition")).toContain("story-route-story-2.csv");
    const md = await json(await storyExportRoute.GET(req("/api/x?format=markdown"), params(id)));
    expect(md.body.markdown).toContain("# Route story 2");
    expect(md.body.filename).toBe("story-route-story-2.md");
    const draft = await json(await storyDraftRoute.POST(req("/api/x", { method: "POST", json: { audience: "brief" } }), params(id)));
    expect(draft.status).toBe(503);
    expect(draft.body.code).toBe("no_api_key");
    expect((await storyRoute.DELETE(req("/api/x", { method: "DELETE" }), params(id))).status).toBe(200);
    expect((await storyRoute.GET(req("/api/x"), params(id))).status).toBe(404);
    expect((await storyExportRoute.GET(req("/api/x"), params("story_nope"))).status).toBe(404);
  });

  it("intel: GET returns the matter panel and POST merges the chronology into the timeline with dedupe", async () => {
    const g = await json(await intelRoute.GET(req(`/api/ediscovery/analysis/intel?matter=${MATTERS.depo}`)));
    expect(g.status).toBe(200);
    expect(g.body).toMatchObject({ matterId: MATTERS.depo, available: true });
    expect(g.body.chronology.entries).toBeGreaterThan(0);
    const before = db().timeline.count((e) => e.matterId === MATTERS.depo);
    const merged = await json(await intelRoute.POST(req("/api/ediscovery/analysis/intel", { method: "POST", json: { matterId: MATTERS.depo, minConfidence: 0.6 } })));
    expect(merged.status).toBe(200);
    expect(merged.body.matterId).toBe(MATTERS.depo);
    expect(merged.body.created + merged.body.skippedDuplicates + merged.body.belowGate).toBeGreaterThan(0);
    const after = db().timeline.count((e) => e.matterId === MATTERS.depo);
    expect(after).toBe(before + merged.body.created);
    const added = (merged.body.eventIds as string[]).map((id) => db().timeline.get(id)!);
    expect(added.every((e) => e.createdBy === "ai" && e.verified === false && e.sources.every((s) => s.kind === "external") && !!e.provenance)).toBe(true);
    // a second merge finds only duplicates
    const twice = await json(await intelRoute.POST(req("/api/x", { method: "POST", json: { matterId: MATTERS.depo, minConfidence: 0.6 } })));
    expect(twice.body.created).toBe(0);
    expect(db().timeline.count((e) => e.matterId === MATTERS.depo)).toBe(after);
    for (const e of added) db().timeline.delete(e.id);
    expect((await intelRoute.GET(req("/api/x?matter=m_nope"))).status).toBe(404);
  });

  it("people: GET returns the enriched graph", async () => {
    const r = await json(await peopleRoute.GET(req(`/api/ediscovery/analysis/people?matter=${VALSARA}`)));
    expect(r.status).toBe(200);
    expect(r.body.nodes.length).toBeGreaterThan(15);
    expect(r.body.orgs.length).toBeGreaterThan(3);
    expect(r.body.edges.some((e: { firstDate?: string }) => e.firstDate)).toBe(true);
    expect(r.body.nodes.every((n: { testimony?: number }) => typeof n.testimony === "number")).toBe(true);
  });
});

// keep the imported type in use for the timeline shape assertions above
const _shape: TimelineEvent["sources"][number]["kind"] = "external";
void _shape;
