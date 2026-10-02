import "server-only";
import type { Database } from "@/lib/db";
import type { Deposition, EDocument, Person, Relationship } from "@/lib/types/domain";
import { MATTERS, PEOPLE } from "@/lib/seed/ids";
import { VOSS_DEPOSITION } from "./seed-depo-vasudevan";
import { HALE_DEPOSITION } from "./seed-depo-hegde";
import { PRYCE_DEPOSITION } from "./seed-depo-prasad";
import { VALSARA_TIMELINE } from "./seed-timeline";
import { VALSARA_CONFLICTS } from "./seed-conflicts";
import { VALSARA_STORY } from "./seed-story";
import { LIU_DEPOSITION, LIU_IMPORT } from "./seed-transcript-sample";
import type { Story, TranscriptImportRecord } from "./types";
import { EXTRA_PEOPLE, EXTRA_PEOPLE_IDS as X } from "./seed-people";
import { KALE, RAMAN, obj, qa } from "./seed-helpers";
import { resolvePersonName } from "./graph";
import { SUGGESTED_TOPICS_KEY } from "./service";

const M = MATTERS.valsara;
const P = PEOPLE;

// ---------------------------------------------------------------------------
// Additional depositions: Bose (rough transcript) and two scheduled.
// ---------------------------------------------------------------------------

export const BROOKS_DEPOSITION: Deposition = {
  id: "dep_vls_brooks_v1",
  matterId: M,
  witnessId: P.nandiniBose,
  witnessName: "Nandini Bose",
  witnessTitle: "Product Stewardship Manager, Meridian Fine Chemicals Ltd.",
  date: "2026-09-10",
  takenBy: "Radhika Kale (Counsel for the Claimant)",
  defendingBy: "Priya Raman (Mehra & Rao Advocates)",
  location: "Meridian Fine Chemicals Ltd., Valsara, Gujarat",
  volume: 1,
  pages: 188,
  status: "transcribed",
  exhibits: [
    { id: "Bose-1", description: "MSDS revision memo — Sections 11 and 12 (2 Apr 2001)", bates: "MFC-0041938" },
    { id: "Bose-2", description: "Product stewardship review — MC-8 alternatives (11 Feb 2003)", bates: "MFC-0052239" },
    { id: "Bose-3", description: "Letter to Aqua-Guard customers of record (16 Feb 2010)", bates: "MFC-0052254" },
    { id: "Bose-4", description: "Konkan Weaves Ltd. complaint letter (9 Aug 2001)", bates: "MFC-0041981" },
  ],
  transcript: [
    qa(7, 2, "Please state your name.", "Nandini Bose."),
    qa(7, 8, "What was your role in 2001?", "Product Stewardship Manager for the textile chemicals line. I reported to Anil Prasad."),
    qa(14, 11, "Exhibit 1 is your April 2, 2001 MSDS revision memo. What did you propose?", "Revising Section 11 to say the repellent agent may accumulate in the body and is eliminated slowly, and Section 12 to say it is not expected to biodegrade.", { exhibit: "Bose-1" }),
    qa(15, 3, "Where did that language come from?", "Hema Vasudevan drafted Section 11. Section 12 was mine, based on what Hema told me."),
    qa(15, 14, "Was it adopted?", "Partly. 'May accumulate' was struck and Section 12 stayed 'not determined.' Anil made that decision on April 4.", { flags: ["key"] }),
    qa(16, 6, "Did Mr. Hegde have a role in the MSDS decision?", "He was copied. I do not remember him weighing in.", { flags: ["key"], note: "Corroborates Vasudevan 156:20 against Hegde 142:6." }),
    qa(23, 9, "Did you agree with Ms. Vasudevan that Slide 8 of the marketing plan was false?", "Yes. I said so in my reply the same day.", { flags: ["admission"] }),
    qa(31, 1, "Exhibit 4, the Konkan Weaves complaint. What did you do with it?", "I sent it to Girish Hegde for the environmental question and drafted the customer response with rinse water guidance.", { exhibit: "Bose-4" }),
    qa(44, 15, "Exhibit 2, your February 2003 MC-8 alternatives review. Page 3 refers to a human half-life 'on the order of years.' Where did that come from?", "Hema's allometric scaling and the Orbis occupational data that had been published.", { exhibit: "Bose-2" }),
    qa(45, 8, "Was that information shared with customers in 2003?", "No. It went into the product development plan.", { flags: ["admission", "key"] }),
    qa(58, 4, "Exhibit 3, the February 2010 customer letter. Why 2010?", "The 2009 CPCB listing of MC-8 as a persistent organohalogen of concern and the phase-down commitments. Legal advised that customers of record be told the discontinued product contained MC-8.", { exhibit: "Bose-3", objection: obj(RAMAN, "privilege", "Instruct not to disclose the content of legal advice; the witness may describe the business event."), flags: ["privilege"] }),
    qa(72, 12, "Were you removed from the MW-7 email thread in July 2002?", "Yes. Anil took me off. I learned about the 41 microgram result from Girish in the hallway.", { flags: ["key"] }),
    qa(90, 6, "Did you ever recommend that Meridian tell customers the repellent agent was persistent?", "In 2001, in the MSDS memo. Again in 2003. It happened in 2010.", { flags: ["admission", "key"] }),
    qa(151, 3, "Ms. Bose, Priya Raman. Between 2001 and 2010, did Meridian's MSDS and product literature contain rinse water-collection guidance?", "Yes. From August 2001.", { objection: obj(KALE, "form", "Leading.") }),
    qa(163, 9, "Nothing further.", "(Rough transcript — certified copy pending.)"),
  ],
};

export const SCHEDULED_DEPOSITIONS: Deposition[] = [
  { id: "dep_vls_hale_v2", matterId: M, witnessId: P.girishHegde, witnessName: "Girish Hegde", witnessTitle: "Director, Environmental Health & Safety, Meridian Fine Chemicals Ltd.", date: "2026-09-24", takenBy: "Radhika Kale (Counsel for the Claimant)", defendingBy: "Arjun Mehra (Mehra & Rao Advocates)", location: "Mehra & Rao Advocates, New Delhi — Conference Room 4B", volume: 2, pages: 0, transcript: [], exhibits: [], status: "scheduled" },
  { id: "dep_vls_suarez_v1", matterId: M, witnessId: P.manishSood, witnessName: "Manish Sood", witnessTitle: "Regulatory Affairs Counsel, Meridian Fine Chemicals Ltd.", date: "2026-10-21", takenBy: "Radhika Kale (Counsel for the Claimant)", defendingBy: "Arjun Mehra (Mehra & Rao Advocates)", location: "Mehra & Rao Advocates, New Delhi — Conference Room 4B", volume: 1, pages: 0, transcript: [], exhibits: [], status: "scheduled" },
];

export const VALSARA_DEPOSITIONS: Deposition[] = [HALE_DEPOSITION, VOSS_DEPOSITION, PRYCE_DEPOSITION, BROOKS_DEPOSITION, LIU_DEPOSITION, ...SCHEDULED_DEPOSITIONS];

// ---------------------------------------------------------------------------
// Relationships: explicit org chart / engagement edges plus edges derived
// from the seeded email headers (from → to = emailed, from → cc = cc).
// ---------------------------------------------------------------------------

const rel = (id: string, fromId: string, toId: string, kind: Relationship["kind"], weight: number, label?: string, evidence?: Relationship["evidence"]): Relationship => ({ id, matterId: M, fromId, toId, kind, weight, label, evidence });

export const EXPLICIT_RELATIONSHIPS: Relationship[] = [
  // Meridian org chart (2001)
  rel("rel_vls_org_01", P.girishHegde, X.merrick, "reports_to", 3, "Director EHS → SVP Operations", [{ bates: "MFC-0041912", docId: "ed_vls_0011", excerpt: "TO: … Pankaj Malhotra, SVP Operations" }]),
  rel("rel_vls_org_02", P.hemaVasudevan, P.girishHegde, "reports_to", 3, "Administrative reporting line", [{ excerpt: "Vasudevan 11:14: Administratively I reported to Girish Hegde" }]),
  rel("rel_vls_org_03", P.nandiniBose, P.anilPrasad, "reports_to", 3, "Product Stewardship → VP Textile Chemicals", [{ excerpt: "Bose 7:8: I reported to Anil Prasad" }]),
  rel("rel_vls_org_04", P.anilPrasad, X.ferris, "reports_to", 3, "VP → CEO", [{ excerpt: "Prasad 6:5: The CEO, Dinesh Pherwani." }]),
  rel("rel_vls_org_05", P.manishSood, P.rohitKapur, "reports_to", 3, "Regulatory Affairs Counsel → Associate General Counsel", [{ bates: "MFC-0041914", docId: "ed_vls_0012" }]),
  rel("rel_vls_org_06", X.liu, P.anilPrasad, "reports_to", 2, "Marketing → VP Textile Chemicals", [{ excerpt: "Prasad 6:12: marketing under Kavita Lal" }]),
  rel("rel_vls_org_07", X.merrick, P.girishHegde, "supervises", 3, undefined, [{ bates: "MFC-0041912", docId: "ed_vls_0011" }]),
  rel("rel_vls_org_08", P.girishHegde, P.hemaVasudevan, "supervises", 3, "Product Safety group", [{ excerpt: "Hegde 10:7" }]),
  rel("rel_vls_org_09", P.anilPrasad, P.nandiniBose, "supervises", 3, undefined, [{ excerpt: "Prasad 6:12" }]),
  rel("rel_vls_org_10", P.rohitKapur, P.manishSood, "supervises", 3, undefined),
  rel("rel_vls_org_11", P.anilPrasad, X.liu, "supervises", 2, undefined),
  rel("rel_vls_org_12", X.ferris, P.anilPrasad, "supervises", 2, undefined),
  // Engagements
  rel("rel_vls_ret_01", P.hemaVasudevan, P.drLeelaSundaramTox, "retained", 4, "Sundaram Laboratories — SL-2000-0417 and SL-2001-0512", [{ bates: "MFC-0041898", docId: "ed_vls_0008" }, { excerpt: "Vasudevan 16:21: I recommended them." }]),
  rel("rel_vls_ret_02", P.girishHegde, X.nunez, "retained", 3, "Beacon Enviro Services — Valsara groundwater monitoring", [{ bates: "MFC-0052212", docId: "ed_vls_0058" }, { bates: "MFC-0041988", docId: "ed_vls_0049" }]),
  rel("rel_vls_ret_03", P.drLeelaSundaramTox, X.bello, "supervises", 2, "Study director → study pathologist", [{ bates: "MFC-0052248", docId: "ed_vls_0074" }]),
  // Counsel
  rel("rel_vls_rep_01", P.arjunMehra, P.girishHegde, "represents", 3, "Defending deposition (Vol. I, Vol. II)", [{ excerpt: "Hegde Vol. I, 13 May 2026" }]),
  rel("rel_vls_rep_02", P.arjunMehra, P.hemaVasudevan, "represents", 3, "Defending deposition", [{ excerpt: "Vasudevan Vol. I, 17 Jun 2026" }]),
  rel("rel_vls_rep_03", P.arjunMehra, P.anilPrasad, "represents", 3, "Defending deposition", [{ excerpt: "Prasad Vol. I, 22 Jul 2026" }]),
  rel("rel_vls_rep_04", P.priyaRaman, P.nandiniBose, "represents", 2, "Defending deposition", [{ excerpt: "Bose Vol. I, 10 Sep 2026" }]),
  rel("rel_vls_rep_05", P.arjunMehra, P.manishSood, "represents", 2, "Defending deposition (scheduled 21 Oct 2026)"),
  rel("rel_vls_rep_06", P.rohitKapur, P.anilPrasad, "represents", 3, "In-house counsel advice on Clause 9.4 and marketing claims", [{ bates: "MFC-0041921", docId: "ed_vls_0016" }, { bates: "MFC-0041968", docId: "ed_vls_0036" }]),
  rel("rel_vls_rep_07", P.manishSood, P.girishHegde, "represents", 2, "Regulatory advice on MW-7 notification", [{ bates: "MFC-0052218", docId: "ed_vls_0060" }]),
  // Meetings
  rel("rel_vls_mtg_01", P.anilPrasad, P.girishHegde, "meeting", 2, "9 Jul 2002, 2 p.m. — MW-7 notification", [{ bates: "MFC-0052217", docId: "ed_vls_0059", excerpt: "I want a meeting with you, Manish, Pankaj and Rohit in my office at 2 today." }]),
  rel("rel_vls_mtg_02", P.anilPrasad, P.manishSood, "meeting", 2, "9 Jul 2002, 2 p.m.", [{ bates: "MFC-0052217", docId: "ed_vls_0059" }]),
  rel("rel_vls_mtg_03", P.anilPrasad, X.merrick, "meeting", 2, "9 Jul 2002, 2 p.m.", [{ bates: "MFC-0052217", docId: "ed_vls_0059" }]),
  rel("rel_vls_mtg_04", P.anilPrasad, P.rohitKapur, "meeting", 2, "9 Jul 2002, 2 p.m.", [{ bates: "MFC-0052217", docId: "ed_vls_0059" }]),
  rel("rel_vls_mtg_05", P.hemaVasudevan, P.anilPrasad, "meeting", 2, "16 Mar 2001 Friday working group", [{ excerpt: "Vasudevan 43:2" }]),
  rel("rel_vls_mtg_06", P.hemaVasudevan, P.nandiniBose, "meeting", 2, "16 Mar 2001 Friday working group", [{ excerpt: "Vasudevan 43:2" }]),
  rel("rel_vls_mtg_07", P.hemaVasudevan, P.manishSood, "meeting", 1, "16 Mar 2001 (joined late)", [{ excerpt: "Vasudevan 43:2" }]),
  // Testimony about
  rel("rel_vls_test_01", P.hemaVasudevan, P.anilPrasad, "testified_about", 4, "Bioassay budget decision, distribution restriction, MSDS", [{ excerpt: "Vasudevan 44:13, 49:8, 156:9" }]),
  rel("rel_vls_test_02", P.hemaVasudevan, P.girishHegde, "testified_about", 3, "'No adverse findings' memo", [{ excerpt: "Vasudevan 39:15" }]),
  rel("rel_vls_test_03", P.girishHegde, P.anilPrasad, "testified_about", 4, "'Do not put this in email'; hold on notification", [{ excerpt: "Hegde 51:4, 52:1" }]),
  rel("rel_vls_test_04", P.girishHegde, P.hemaVasudevan, "testified_about", 2, "Memo review", [{ excerpt: "Hegde 22:19" }]),
  rel("rel_vls_test_05", P.anilPrasad, P.hemaVasudevan, "testified_about", 3, "'Preliminary' characterisation", [{ excerpt: "Prasad 47:2" }]),
  rel("rel_vls_test_06", P.anilPrasad, P.manishSood, "testified_about", 2, "Reporting decision; CPCB summary", [{ excerpt: "Prasad 48:12, 88:12" }]),
  rel("rel_vls_test_07", P.nandiniBose, P.anilPrasad, "testified_about", 2, "MSDS decision; removal from thread", [{ excerpt: "Bose 15:14, 72:12" }]),
  rel("rel_vls_test_08", P.girishHegde, X.rourke, "testified_about", 2, "15 Jul 2002 call", [{ excerpt: "Hegde 49:17" }]),
  rel("rel_vls_test_09", P.anilPrasad, X.whitcomb, "testified_about", 2, "DQA-T response", [{ excerpt: "Prasad 88:12" }]),
  // Opposing counsel
  rel("rel_vls_opp_01", P.opposingCounselKale, P.girishHegde, "other", 2, "Examined at deposition"),
  rel("rel_vls_opp_02", P.opposingCounselKale, P.hemaVasudevan, "other", 2, "Examined at deposition"),
  rel("rel_vls_opp_03", P.opposingCounselKale, P.anilPrasad, "other", 2, "Examined at deposition"),
  rel("rel_vls_opp_04", P.opposingCounselKale, P.nandiniBose, "other", 2, "Examined at deposition"),
  rel("rel_vls_exp_01", P.drRajPatelHydro, X.nunez, "other", 1, "Relies on Beacon monitoring data", [{ bates: "MFC-0052212", docId: "ed_vls_0058" }]),
];

/** Derive emailed / cc edges from the seeded email headers, aggregated per pair. */
export function deriveEmailRelationships(docs: EDocument[], people: Person[]): Relationship[] {
  const agg = new Map<string, Relationship>();
  for (const d of docs) {
    if (d.matterId !== M || !d.from) continue;
    const from = resolvePersonName(d.from, people);
    if (!from) continue;
    const add = (name: string, kind: "emailed" | "cc") => {
      const to = resolvePersonName(name, people);
      if (!to || to.id === from.id) return;
      const key = `${from.id}|${to.id}|${kind}`;
      let r = agg.get(key);
      if (!r) { r = { id: `rel_vls_mail_${kind}_${from.id}_${to.id}`, matterId: M, fromId: from.id, toId: to.id, kind, weight: 0, evidence: [] }; agg.set(key, r); }
      r.weight += 1;
      if ((r.evidence?.length ?? 0) < 6) r.evidence!.push({ bates: d.bates, docId: d.id, excerpt: d.subject });
    };
    for (const t of d.to ?? []) add(t, "emailed");
    for (const c of d.cc ?? []) add(c, "cc");
  }
  return Array.from(agg.values());
}

// ---------------------------------------------------------------------------

/** Analysis seed: depositions, chronology, relationships, conflicts, external people. Idempotent. */
export function seedAnalysis(db: Database) {
  db.people.putMany(EXTRA_PEOPLE);
  db.depositions.putMany(VALSARA_DEPOSITIONS);
  db.timeline.putMany(VALSARA_TIMELINE);
  const people = db.people.all();
  const docs = db.edocs.find((d) => d.matterId === M);
  db.relationships.putMany([...EXPLICIT_RELATIONSHIPS, ...deriveEmailRelationships(docs, people)]);
  db.conflicts.putMany(VALSARA_CONFLICTS);
  db.collection<TranscriptImportRecord>("ediscovery_transcript_imports").putMany([LIU_IMPORT]);
  // Keep a reviewer's edits: the seeded story is only written when absent.
  const stories = db.collection<Story>("ediscovery_stories");
  if (!stories.has(VALSARA_STORY.id)) stories.put(VALSARA_STORY);
  if (db.kv.get<string[]>(SUGGESTED_TOPICS_KEY(M)) == null) db.kv.set(SUGGESTED_TOPICS_KEY(M), VALSARA_TOPICS);
}

/** Curated cross-analysis topics for the sample Valsara matter (demo data only). */
const VALSARA_TOPICS = ["90-day study final report", "Clause 9.4 notice Park", "MW-7 groundwater 41 µg/L", "bioassay budget dose groups", "MSDS accumulate biodegrade", "Slide 8 biodegradable", "defence DQA-T qualification", "notification GPCB Park", "half-life serum recovery", "board minutes regulatory action"];

export const ANALYSIS_SEED_IDS = {
  depositions: { vasudevan: VOSS_DEPOSITION.id, hegde: HALE_DEPOSITION.id, prasad: PRYCE_DEPOSITION.id, bose: BROOKS_DEPOSITION.id, liu: LIU_DEPOSITION.id, haleVol2: "dep_vls_hale_v2", sood: "dep_vls_suarez_v1" },
  story: VALSARA_STORY.id,
  transcriptImport: LIU_IMPORT.id,
  conflicts: VALSARA_CONFLICTS.map((c) => c.id),
  timelineCount: VALSARA_TIMELINE.length,
  extraPeople: EXTRA_PEOPLE.map((p) => p.id),
} as const;
