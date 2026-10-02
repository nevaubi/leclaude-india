import { MATTERS, PEOPLE } from "@/lib/seed/ids";
import type { Story, StoryFact } from "./types";

const M = MATTERS.valsara;
const P = PEOPLE;
let n = 0;
function fact(date: string, text: string, evidence: StoryFact["evidence"], extra: Partial<StoryFact> = {}): StoryFact {
  n += 1;
  return { id: `sf_vls_${String(n).padStart(2, "0")}`, order: n, date, precision: "day", text, evidence, confidence: 0.9, verified: true, origin: "timeline", ...extra };
}

/**
 * Seeded story for the Valsara arbitration: the defence chronology of what Meridian
 * knew about MF-3 persistence and when it told regulators, customers and the
 * defence. Every fact cites documents by Bates, testimony by page:line, chronology
 * events by id, and the intelligence corpus by record id.
 */
export const VALSARA_STORY: Story = {
  id: "story_vls_knowledge",
  matterId: M,
  title: "What Meridian knew about MF-3 persistence, and when it disclosed it",
  theme: "Knowledge, notice decisions and disclosure — 2001 to the arbitration",
  createdAt: "2026-09-12T15:20:00.000Z",
  updatedAt: "2026-09-18T09:40:00.000Z",
  createdBy: P.arjunMehra,
  meta: { seeded: true },
  facts: [
    fact("2001-03-14", "Sundaram Laboratories delivered the final 90-day rat study: dose-related liver effects, a NOAEL of 0.1 mg/kg-day and a serum half-life of about 100 days.", [
      { kind: "document", docId: "ed_vls_0001", bates: "MFC-0041877", excerpt: "FINAL REPORT SUMMARY" },
      { kind: "document", docId: "ed_vls_0002", bates: "MFC-0041880", excerpt: "the liver effects are real, they are dose-related, and they did not fully reverse" },
      { kind: "testimony", depositionId: "dep_vls_voss_v1", witness: "Hema Vasudevan", page: 24, line: 5 },
      { kind: "event", eventId: "tl_vls_006", title: "Sundaram final report" },
    ], { personIds: [P.hemaVasudevan, P.girishHegde, P.drLeelaSundaramTox], confidence: 0.98 }),
    fact("2001-03-19", "Hegde's EHS memo went out stating 'no adverse findings at exposures relevant to occupational use'; his own draft two days earlier said end-user margins could not be established.", [
      { kind: "document", docId: "ed_vls_0011", bates: "MFC-0041912", excerpt: "no adverse findings at exposures relevant to occupational use of the product" },
      { kind: "document", docId: "ed_vls_0034", bates: "MFC-0041965", excerpt: "margins for end-users cannot be established" },
      { kind: "testimony", depositionId: "dep_vls_hale_v1", witness: "Girish Hegde", page: 22, line: 10 },
      { kind: "testimony", depositionId: "dep_vls_voss_v1", witness: "Hema Vasudevan", page: 39, line: 15 },
      { kind: "event", eventId: "tl_vls_011" },
    ], { disputed: true, personIds: [P.girishHegde, P.anilPrasad], confidence: 0.85 }),
    fact("2001-03-26", "Meridian decided not to give the Park a Clause 9.4 notice on the 90-day study and to run a two-year bioassay first.", [
      { kind: "document", docId: "ed_vls_0020", bates: "MFC-0041936" },
      { kind: "document", docId: "ed_vls_0015", bates: "MFC-0041920", excerpt: "If there is a defensible path that involves doing the bioassay first and reporting when we actually know something, that is the path I want." },
      { kind: "testimony", depositionId: "dep_vls_pryce_v1", witness: "Anil Prasad", page: 48, line: 12 },
      { kind: "testimony", depositionId: "dep_vls_voss_v1", witness: "Hema Vasudevan", page: 102, line: 15 },
      { kind: "event", eventId: "tl_vls_015" },
    ], { personIds: [P.manishSood, P.rohitKapur, P.anilPrasad], confidence: 0.95 }),
    fact("2001-04-04", "Prasad struck 'may accumulate' from the MSDS revision and kept Section 12 at 'has not been determined'.", [
      { kind: "document", docId: "ed_vls_0023", bates: "MFC-0041942", excerpt: "'may accumulate' comes out" },
      { kind: "testimony", depositionId: "dep_vls_voss_v1", witness: "Hema Vasudevan", page: 155, line: 18 },
      { kind: "testimony", depositionId: "dep_vls_brooks_v1", witness: "Nandini Bose", page: 15, line: 14 },
      { kind: "event", eventId: "tl_vls_016" },
    ], { personIds: [P.anilPrasad, P.nandiniBose, P.hemaVasudevan] }),
    fact("2001-05-04", "Vasudevan told marketing that Slide 8 of the Aqua-Guard plan was false: MF-3 was the same MC-8 chemistry Orbis was withdrawing. The brochure kept 'biodegradable' until 2003.", [
      { kind: "document", docId: "ed_vls_0033", bates: "MFC-0041964", excerpt: "Slide 8 is false." },
      { kind: "testimony", depositionId: "dep_vls_voss_v1", witness: "Hema Vasudevan", page: 56, line: 3 },
      { kind: "testimony", depositionId: "dep_vls_liu_v1", witness: "Kavita Lal", page: 12, line: 1, excerpt: "The word \"readily\" was removed. \"Biodegradable\" stayed in the customer brochure through 2003." },
      { kind: "event", eventId: "tl_vls_022" },
    ], { personIds: [P.hemaVasudevan, P.anilPrasad], confidence: 0.95 }),
    fact("2001-09-18", "First MC-8 detection in Valsara groundwater: MW-7, downgradient of Lagoon 2, at 12.0 µg/L.", [
      { kind: "document", docId: "ed_vls_0049", bates: "MFC-0041988", excerpt: "MW-7 (downgradient of Lagoon 2, 5.5–8.5 m screen): MC-8 12.0 µg/L" },
      { kind: "testimony", depositionId: "dep_vls_hale_v1", witness: "Girish Hegde", page: 38, line: 9 },
      { kind: "event", eventId: "tl_vls_030" },
    ], { personIds: [P.girishHegde] }),
    fact("2002-07-08", "After Beacon reported MW-7 at 41 µg/L and 6.8 µg/L at the property line, Hegde recommended notifying GPCB 'voluntarily, now' and sampling the Park's wells.", [
      { kind: "document", docId: "ed_vls_0058", bates: "MFC-0052212" },
      { kind: "document", docId: "ed_vls_0057", bates: "MFC-0052210", excerpt: "we have an off-site migration of a compound we know is persistent and bioaccumulative, toward the Park's drinking-water supply" },
      { kind: "testimony", depositionId: "dep_vls_hale_v1", witness: "Girish Hegde", page: 47, line: 6 },
      { kind: "event", eventId: "tl_vls_035" },
    ], { disputed: true, personIds: [P.girishHegde, P.anilPrasad], confidence: 0.88 }),
    fact("2002-07-09", "Prasad replied 'Do not put this in email' and held notification pending Legal; the 2 p.m. meeting closed Lagoon 2 and deferred notice to another data round.", [
      { kind: "document", docId: "ed_vls_0059", bates: "MFC-0052217", excerpt: "Nothing goes to the Board or to the Park until Legal has looked at it" },
      { kind: "testimony", depositionId: "dep_vls_pryce_v1", witness: "Anil Prasad", page: 72, line: 14 },
      { kind: "testimony", depositionId: "dep_vls_hale_v1", witness: "Girish Hegde", page: 52, line: 1 },
      { kind: "event", eventId: "tl_vls_036" },
    ], { personIds: [P.anilPrasad, P.girishHegde, P.manishSood] }),
    fact("2002-10-24", "Hegde's letter notified Valsara Textile Park Ltd. and offered wellfield sampling, 108 days after his 'now' recommendation.", [
      { kind: "document", docId: "ed_vls_0063", bates: "MFC-0052221" },
      { kind: "testimony", depositionId: "dep_vls_hale_v1", witness: "Girish Hegde", page: 61, line: 4 },
      { kind: "event", eventId: "tl_vls_042" },
    ], { personIds: [P.girishHegde, P.manishSood] }),
    fact("2002-10-28", "Meridian gave the Park a Clause 9.4 notice on the two-year bioassay interim results (hepatocellular adenomas at 12 months).", [
      { kind: "document", docId: "ed_vls_0066", bates: "MFC-0052226" },
      { kind: "testimony", depositionId: "dep_vls_voss_v1", witness: "Hema Vasudevan", page: 102, line: 7 },
      { kind: "testimony", depositionId: "dep_vls_pryce_v1", witness: "Anil Prasad", page: 210, line: 16 },
      { kind: "event", eventId: "tl_vls_043" },
    ], { confidence: 0.7, verified: false, personIds: [P.manishSood, P.rohitKapur] }),
    fact("2010-02-16", "Meridian wrote to customers of record disclosing that the discontinued product contained MC-8 and that the repellent agent persists.", [
      { kind: "document", docId: "ed_vls_0078", bates: "MFC-0052254" },
      { kind: "testimony", depositionId: "dep_vls_pryce_v1", witness: "Anil Prasad", page: 114, line: 9 },
      { kind: "testimony", depositionId: "dep_vls_brooks_v1", witness: "Nandini Bose", page: 58, line: 4 },
      { kind: "event", eventId: "tl_vls_051" },
    ], { personIds: [P.nandiniBose] }),
    fact("2023-01-20", "Valsara Textile Park Ltd. served a notice of arbitration under Clause 21 of the 1998 Supply and Technical Services Agreement; the Tribunal was later constituted with Justice (Retd.) Vasudha Rangan presiding.", [
      { kind: "event", eventId: "tl_vls_060", title: "Notice of arbitration (Arb. Ref. 14/2024)" },
    ], { origin: "timeline", confidence: 0.92, verified: false }),
  ],
};
