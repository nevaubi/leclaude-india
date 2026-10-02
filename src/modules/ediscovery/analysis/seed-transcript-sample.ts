import type { Deposition } from "@/lib/types/domain";
import { MATTERS } from "@/lib/seed/ids";
import { EXTRA_PEOPLE_IDS as X } from "./seed-people";
import { KALE, MEHRA } from "./seed-helpers";
import { parseTranscript } from "./transcript-import";
import type { TranscriptImportRecord } from "./types";

/**
 * A raw ASCII/.ptx-style transcript (page:line on every line) for the
 * deposition of Kavita Lal, Director of Marketing. It is parsed with the import
 * parser at seed time so the deposition center ships with a transcript that
 * demonstrably came through the importer (see LIU_IMPORT for the parse report).
 */
export const LIU_TRANSCRIPT_TEXT = `0001:01                 BEFORE THE ARBITRAL TRIBUNAL
0001:02            ARBITRATION AND CONCILIATION ACT, 1996
0001:03                   SEAT OF ARBITRATION: NEW DELHI
0001:04
0001:05   VALSARA TEXTILE PARK LTD. v. MERIDIAN FINE CHEMICALS LTD.
0001:06   ARB. REF. 14/2024
0001:07
0001:08              VIDEOTAPED DEPOSITION OF KAVITA LAL
0001:09                          VOLUME I
0001:10                    September 17, 2026
0001:11                        9:04 a.m.
0001:12
0001:13   Mehra & Rao Advocates, 21 Kasturba Gandhi Marg, New Delhi 110001
0002:01   APPEARANCES:
0002:02   For the Claimant:
0002:03        RADHIKA KALE, ADVOCATE
0002:04   For the Respondent Meridian Fine Chemicals Ltd. and the Witness:
0002:05        ARJUN MEHRA, ADVOCATE, Mehra & Rao Advocates
0002:06   Also present: Videographer; Court Reporter
0006:01        THE VIDEOGRAPHER:  We are on the record at 9:04 a.m.
0006:02   This is the videotaped deposition of Kavita Lal.
0006:03        (Witness sworn.)
0006:04   EXAMINATION
0006:05   BY MS. KALE:
0006:06   Q.   Please state your full name for the record.
0006:07   A.   Kavita Meena Lal.
0006:09   Q.   What was your position at Meridian Fine Chemicals in 2001?
0006:10   A.   Director of Marketing for the textile chemicals line.  I
0006:11   reported to Anil Prasad.
0007:02   Q.   How long did you hold that position?
0007:03   A.   From August 1999 until the reorganization in 2007.
0007:06   Q.   Did your group prepare the annual marketing plan for
0007:07   Aqua-Guard?
0007:08   A.   Yes.  My group drafted it and Anil approved it.
0009:12        (Exhibit Lal-1 marked for identification; Aqua-Guard
0009:13   2001-2002 marketing plan, MFC-0041955.)
0009:14   Q.   I am handing you Exhibit Lal-1.  Do you recognize it?
0009:15   A.   I do.  It is the 2001-2002 Aqua-Guard marketing plan.
0009:17   Q.   Who wrote slide 8?
0009:18   A.   I wrote the deck.  The language on slide 8 came from a
0009:19   product data sheet that predated me.
0010:03   Q.   Slide 8 says the MF-3 repellent agent is "readily
0010:04   biodegradable."  Did you know that to be true when you wrote it?
0010:05        MR. MEHRA:  Objection, form.  Foundation.
0010:06   A.   I believed it.  It was on the data sheet.
0010:09   Q.   Did anyone tell you before May 4, 2001, that the claim was
0010:10   not true?
0010:11   A.   Not before May 4.  Hema Vasudevan wrote to me on May 4.
0011:02   Q.   What did Ms. Vasudevan tell you?
0011:03   A.   She said slide 8 was false and that MF-3 was the same
0011:04   MC-8 chemistry that Orbis was withdrawing.
0011:07   Q.   What did you do with that email?
0011:08   A.   I forwarded it to Anil and asked what he wanted done with
0011:09   the deck.
0012:01   Q.   Was slide 8 changed?
0012:02   A.   The word "readily" was removed.  "Biodegradable" stayed
0012:03   in the customer brochure through 2003.
0012:06   Q.   Who decided that "biodegradable" would stay?
0012:07        MR. MEHRA:  Objection.  Calls for speculation as to
0012:08   decisions the witness did not make.
0012:09        MS. KALE:  She can answer if she knows.
0012:10   A.   Anil told me Legal had reviewed the wording.  I did not
0012:11   see the legal advice.
0014:04   Q.   Did you understand in May 2001 that the repellent agent
0014:05   persisted in the environment?
0014:06   A.   I understood from Hema's email that it did not break
0014:07   down.  I am not a scientist.
0014:10   Q.   Did the brochure that went to the defence qualification cell in
0014:11   2002 use the word "biodegradable"?
0014:12   A.   Yes.  The DQA-T qualification brochure used the 2001
0014:13   language.
0015:01   Q.   Was the defence qualification authority told about the Vasudevan email?
0015:02        MR. MEHRA:  Objection, form.
0015:03   A.   Not by me.
0018:03   Q.   Let me show you what was previously marked as Vasudevan-5,
0018:04   MFC-0041964.  Is that the May 4, 2001 email you described?
0018:05   A.   Yes.  That is Hema's email to me and Nandini, with Anil
0018:06   copied.
0018:09   Q.   Ms. Bose replied the same day agreeing.  Did you agree?
0018:10   A.   I did not have a basis to disagree with the toxicologist.
0021:14   Q.   Did marketing receive the Sundaram 90-day study in
0021:15   March 2001?
0021:16   A.   No.  We were told there was a study and that the results
0021:17   were preliminary.
0021:19   Q.   Who told you the results were preliminary?
0021:20   A.   Anil Prasad, at the Friday working group on March 16.
0022:03   Q.   Were you told about liver findings?
0022:04   A.   Not in March.  I learned about the liver findings from
0022:05   Hema's May email and, in more detail, in 2002.
0027:08   Q.   Turning to 2002.  Did you prepare the response to the
0027:09   DQA-T qualification questionnaire?
0027:10   A.   I prepared the marketing sections.  Regulatory prepared
0027:11   the compliance answers.  Anil signed it.
0027:14   Q.   Did the questionnaire ask whether any substantial-risk
0027:15   notice had been given?
0027:16        MR. MEHRA:  Objection.  The document speaks for
0027:17   itself.
0027:18   A.   I believe so.  I did not draft that answer.
0031:02   Q.   Did you ever ask Mr. Prasad why the biodegradable claim
0031:03   remained in the brochure after May 2001?
0031:04   A.   Once, in the fall of 2001.  He said the wording was
0031:05   accurate enough for a brochure and that the MSDS controlled.
0031:08   Q.   Did you agree?
0031:09   A.   I did not push back.  I should have.
0035:11        (Exhibit Lal-2 marked for identification; Aqua-Guard
0035:12   product brochure, revision C, MFC-0041957.)
0035:13   Q.   Exhibit Lal-2 is revision C of the brochure.  What
0035:14   changed between revision B and revision C?
0035:15   A.   "Readily biodegradable" became "biodegradable."  The
0035:16   environmental fate sentence was shortened.
0036:02   Q.   Who approved revision C?
0036:03   A.   Anil Prasad.  The approval sheet is on the last page.
0041:06   Q.   When did the word "biodegradable" leave the product
0041:07   literature?
0041:08   A.   With the 2006 MF-5 transition materials.  The 2003 revision
0041:09   D already softened it to "environmentally managed."
0041:12   Q.   Who chose "environmentally managed"?
0041:13   A.   I did, with Nandini Bose.  Legal signed off.
0048:01   Q.   Did you attend the June 2001 board pre-read meeting?
0048:02   A.   No.  Directors did not attend board pre-reads.
0048:05   Q.   Did you see the pre-read deck?
0048:06   A.   I saw the marketing slides.  I did not see the toxicology
0048:07   summary.
0055:09   Q.   Did customers ask about biodegradability?
0055:10   A.   Occasionally.  Textile processors asked about rinse water.  We
0055:11   referred them to the MSDS.
0055:14   Q.   Did the MSDS in 2001 say the repellent agent persisted?
0055:15        MR. MEHRA:  Objection, form.  The MSDS is a document;
0055:16   the witness can be asked what she recalls.
0055:17   A.   My recollection is that Section 12 said fate had not been
0055:18   determined.
0062:03   Q.   In 2010 Meridian wrote to customers of record about MC-8
0062:04   content.  Did marketing have a role?
0062:05   A.   Nandini drafted it.  My successor reviewed the customer
0062:06   list.  I had moved to the specialty chemicals group.
0062:09   Q.   Why was the letter not sent in 2001 or 2003?
0062:10        MR. MEHRA:  Objection.  Calls for speculation.
0062:11   Instruct the witness not to disclose the content of any legal
0062:12   advice.
0062:13   A.   I can only say that in 2001 the decision was Anil's and
0062:14   Legal's.  I was not part of it.
0071:01   Q.   Did you keep your marketing files when you left the textile
0071:02   chemicals group?
0071:03   A.   They stayed on the shared drive.  I kept nothing personally.
0071:06   Q.   Did you ever delete emails relating to the Vasudevan email?
0071:07   A.   No.
0088:12   Q.   Ms. Lal, did anyone at Meridian ever tell you that
0088:13   biodegradability claims for MF-3 were false before May 4, 2001?
0088:14   A.   No.  The first time was Hema's email.
0088:17   Q.   And after May 4, 2001, did Meridian continue to describe
0088:18   the product as biodegradable to customers?
0088:19        MR. MEHRA:  Objection.  Asked and answered.
0088:20   A.   Yes, until the 2003 revision.
0096:02        MS. KALE:  I have nothing further at this time.
0096:03   EXAMINATION
0096:04   BY MR. MEHRA:
0096:05   Q.   Ms. Lal, in 2001 did the customer brochure direct users to
0096:06   the MSDS for environmental information?
0096:07   A.   Yes.  Every revision did.
0096:10   Q.   And the MSDS from August 2001 forward included rinse water
0096:11   collection guidance?
0096:12        MS. KALE:  Objection, leading.
0096:13   A.   Yes, it did.
0097:01        MR. MEHRA:  Nothing further.
0097:02        THE VIDEOGRAPHER:  We are off the record at 3:41 p.m.
0097:03        (Whereupon the deposition concluded.)
`;

const SPEAKERS = { "MS. KALE": KALE, "MR. MEHRA": MEHRA };

export const LIU_PARSED = parseTranscript(LIU_TRANSCRIPT_TEXT, { speakers: SPEAKERS });

export const LIU_DEPOSITION: Deposition = {
  id: "dep_vls_liu_v1",
  matterId: MATTERS.valsara,
  witnessId: X.liu,
  witnessName: "Kavita Lal",
  witnessTitle: "Director of Marketing, Textile Chemicals, Meridian Fine Chemicals Ltd.",
  date: "2026-09-17",
  takenBy: `${KALE} (Counsel for the Claimant)`,
  defendingBy: `${MEHRA} (Mehra & Rao Advocates)`,
  location: "Mehra & Rao Advocates, 21 Kasturba Gandhi Marg, New Delhi 110001 — Conference Room 4B",
  volume: 1,
  pages: 97,
  status: "transcribed",
  exhibits: [
    { id: "Lal-1", description: "Aqua-Guard 2001–2002 marketing plan (1 May 2001)", bates: "MFC-0041955" },
    { id: "Lal-2", description: "Aqua-Guard product brochure, revision C (2001)", bates: "MFC-0041957" },
    { id: "Vasudevan-5", description: "Vasudevan email, 'RE: Marketing plan — biodegradable claim' (4 May 2001)", bates: "MFC-0041964" },
  ],
  transcript: LIU_PARSED.transcript.map((qa) => {
    // Reviewer flags on the imported record (the importer itself never flags).
    const key = `${qa.page}:${qa.line}`;
    if (key === "12:1") return { ...qa, flags: ["admission", "key"] };
    if (key === "31:8") return { ...qa, flags: ["admission"] };
    if (key === "88:17") return { ...qa, flags: ["admission", "key"] };
    if (key === "21:19") return { ...qa, flags: ["key"], note: "Corroborates Prasad 47:2 ('preliminary')." };
    if (key === "10:9") return { ...qa, flags: ["key"] };
    return qa;
  }),
};

export const LIU_IMPORT: TranscriptImportRecord = {
  id: "timp_seed_vls_liu",
  matterId: MATTERS.valsara,
  depositionId: LIU_DEPOSITION.id,
  sourceName: "Lal_Kavita_2026-09-17_Vol1.ptx",
  sourceKind: "ptx",
  format: LIU_PARSED.format,
  confidence: LIU_PARSED.confidence,
  issues: LIU_PARSED.issues,
  qaCount: LIU_PARSED.transcript.length,
  pages: LIU_PARSED.pages,
  importedAt: "2026-09-18T14:05:00.000Z",
  importedBy: "p_jwhitfield",
};
