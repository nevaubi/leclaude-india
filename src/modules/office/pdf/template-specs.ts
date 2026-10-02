/**
 * Document specs for PDF templates and seeds. Each builder returns a DocSpec
 * that `generatePdf` typesets with pdf-lib. Content is realistic litigation
 * paper for Mehra & Rao Advocates matters (Valsara v. Meridian arbitration, Northgate v. Apex, …).
 */
import type { Block, CaptionSpec, DocSpec } from "./generate";
import { GENERIC_SPEC_BUILDERS, type GenericSpecContext } from "./template-specs-generic";

export interface SpecContext extends GenericSpecContext { /** Regenerate the sample-dataset content (seeded demo documents only). */ demo?: boolean }

const VALSARA_COURT = ["In the Arbitral Tribunal", "Arbitration and Conciliation Act, 1996", "Seat: New Delhi"];
const VALSARA_LEFT = ["VALSARA TEXTILE PARK LTD.,", "                    Claimant,", "        – versus –", "MERIDIAN FINE CHEMICALS LTD.,", "                    Respondent."];
const VALSARA_RIGHT = ["Arb. Ref. 14/2024", "", "Justice (Retd.) Vasudha Rangan", "Presiding Arbitrator"];
const NORTHGATE_COURT = ["Supreme Court of the State of New York", "County of New York: Commercial Division"];
const NORTHGATE_LEFT = ["NORTHGATE LOGISTICS HOLDINGS, LLC,", "                    Plaintiff,", "        – against –", "APEX FREIGHT SYSTEMS, INC.,", "                    Defendant."];
const NORTHGATE_RIGHT = ["Index No. 654412/2025", "", "Hon. Andrea Masley, J.S.C.", "Part 48"];

const FIRM_SIGNATURE = ["**Arjun Mehra**, Advocate (Enrolment No. D/0000/2005)", "Priya Raman", "**MEHRA & RAO ADVOCATES**", "21 Kasturba Gandhi Marg, 7th Floor", "New Delhi 110001", "Tel. +91 11 5550 0140", "amehra@mehrarao.example", "", "*Counsel for the Respondent, Meridian Fine Chemicals Ltd.*"];

function longDate(d = new Date()) { return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }); }
function valsaraCaption(title: string[]): CaptionSpec { return { court: VALSARA_COURT, left: VALSARA_LEFT, right: VALSARA_RIGHT, title }; }
function northgateCaption(title: string[]): CaptionSpec { return { court: NORTHGATE_COURT, left: NORTHGATE_LEFT, right: NORTHGATE_RIGHT, title }; }

// ---------------------------------------------------------------------------
// Deposition notice
// ---------------------------------------------------------------------------
export function depositionNoticeSpec(ctx: SpecContext = {}, o: { witness?: string; witnessTitle?: string; date?: string; time?: string; location?: string; topics?: string[] } = {}): DocSpec {
  const witness = o.witness ?? "Hema Vasudevan";
  const witnessTitle = o.witnessTitle ?? "Senior Toxicologist, Meridian Fine Chemicals Ltd.";
  const date = o.date ?? "Thursday, October 22, 2026";
  const time = o.time ?? "10:00 a.m. IST";
  const location = o.location ?? "Mehra & Rao Advocates, 21 Kasturba Gandhi Marg, 7th Floor, New Delhi 110001 (and by remote videoconference)";
  const topics = o.topics ?? [
    "The witness's role in Meridian's toxicology program from 1996 to 2012, including the design, review and internal circulation of the 1998 rodent study summarized at MFC-0102211.",
    "Receipt, routing and review of third-party MC-7/MC-8 study data, including the November 1999 routing slip at MFC-0077102 and any related correspondence.",
    "The June 2001 draft Clause 9.4 notice to the Park (MFC-0119377), the persons who reviewed it, the reasons it was not sent, and any later drafts.",
    "Meridian's 2006 MF-3 Stewardship Programme (MFC-0140011) and the internal analyses supporting the phase-out decision.",
    "Communications with Girish Hegde, Nandini Bose and Rohit Kapur concerning the health effects of the organohalogen compounds used in MF-3 repellent finish.",
    "The documents identified on Schedule A hereto and the witness's document retention practices.",
  ];
  return {
    title: ctx.title ?? `Notice of Deposition of ${witness}`,
    subject: "Deposition notice",
    keywords: ["deposition", "witness examination", witness],
    caption: valsaraCaption(["Notice of Videotaped Deposition of", witness]),
    blocks: [
      { type: "paragraph", text: `**TO:** Radhika Kale, Kale & Associates, counsel for the Claimant, 14 Barakhamba Road, New Delhi 110001, and the Tribunal Secretary.` },
      { type: "paragraph", text: `PLEASE TAKE NOTICE that, pursuant to Sections 19 and 24 of the Arbitration and Conciliation Act, 1996 and Procedural Orders Nos. 2, 3 and 4, the Respondent Meridian Fine Chemicals Ltd. ("Meridian"), by and through its undersigned counsel, will take the videotaped deposition upon oral examination of **${witness}**, ${witnessTitle}, commencing on **${date}, at ${time}**, at ${location}, and continuing from day to day until completed.`, indent: true },
      { type: "paragraph", text: `The deposition will be taken before the Tribunal Secretary or other person authorised by the Tribunal and will be recorded by stenographic means and by video, with real-time transcription available to all parties. Under Procedural Order No. 3 ¶ 11 the deposition may also be recorded by audio means. Transcription and video will be provided by Nyaya Transcripts.`, indent: true },
      { type: "paragraph", text: `The deposition will be taken for the purposes of disclosure, for use at the evidentiary hearing, and for any other purpose permitted by the Tribunal's procedural orders and the Indian Evidence Act, 1872 as applied by agreement. The deposition is expected to require one day of seven hours of testimony on the record, subject to the enlargement provisions of Procedural Order No. 3 ¶ 7.`, indent: true },
      { type: "heading", text: "Subject Matter of Examination", level: 2 },
      { type: "paragraph", text: "Without limiting the scope of examination permitted by the Tribunal, Meridian anticipates that the examination will address the following subjects:" },
      ...topics.map((t, i) => ({ type: "numbered", number: `${i + 1}.`, text: t }) as Block),
      { type: "heading", text: "Documents to Be Produced at the Deposition", level: 2 },
      { type: "paragraph", text: "Pursuant to Procedural Order No. 2 ¶ 6, the deponent is requested to produce at the deposition the documents and electronically stored information described on **Schedule A**, to the extent not previously produced in this arbitration with Bates numbers in the MFC- prefix series. Documents withheld on the basis of privilege shall be identified on a log conforming to Procedural Order No. 2 ¶ 9." },
      { type: "heading", text: "Confidentiality", level: 2 },
      { type: "paragraph", text: "The deposition transcript and exhibits shall be treated as **CONFIDENTIAL – SUBJECT TO PROTECTIVE ORDER** under Paragraph 14 of the Confidentiality Order (Procedural Order No. 1) for thirty (30) days following receipt of the final transcript, during which time any party may designate portions as Confidential or Highly Confidential – Attorneys' Eyes Only." },
      { type: "signature", lines: FIRM_SIGNATURE, dateLine: `Dated: ${longDate(ctx.date)}` },
      { type: "pagebreak" },
      { type: "heading", text: "Schedule A — Documents Requested", level: 1, align: "center" },
      { type: "paragraph", text: "**Definitions.** \"Document\" has the broadest meaning permitted by Section 3 of the Indian Evidence Act, 1872 and includes electronic records, drafts, and non-identical copies. \"Finish chemistry\" means any organohalogen surface-active compound used in MF-3 or Aqua-Guard finishes, including MC-7 and MC-8 and their precursors, salts and homologues. The relevant period is January 1, 1996 through December 31, 2012 unless otherwise stated." },
      { type: "numbered", number: "1.", text: "All laboratory notebooks, study protocols, raw data and reports for the 1998 rodent hepatotoxicity study summarized at MFC-0102211, including peer review comments and statistical analyses." },
      { type: "numbered", number: "2.", text: "All routing slips, transmittal memoranda and correspondence concerning the receipt of third-party study data on finish chemistry between 1998 and 2002, including the document at MFC-0077102." },
      { type: "numbered", number: "3.", text: "All drafts of any notice to the Park under Clause 9.4 of the 1998 Supply and Technical Services Agreement, and any copy to the GPCB under the Schedule 6 Notification Protocol, including MFC-0119377 and any redlines, comment bubbles or metadata." },
      { type: "numbered", number: "4.", text: "Meeting minutes, agendas and presentations of the Product Stewardship Committee for 2005 and 2006 relating to the decision to adopt the MF-3 Stewardship Programme." },
      { type: "numbered", number: "5.", text: "The witness's calendar entries, travel records and expense reports reflecting meetings with regulators, trade associations or other manufacturers concerning finish-chemistry toxicology." },
      { type: "numbered", number: "6.", text: "The witness's current curriculum vitae, publication list and a list of all prior deposition or trial testimony given in the last ten years." },
      { type: "table", columns: ["Bates range", "Description", "Custodian", "Date"], widths: [1.2, 2.6, 1.2, 1], rows: [
        ["MFC-0102211 – 0102248", "1998 rodent study summary and appendices", "H. Vasudevan", "03/17/1998"],
        ["MFC-0077102 – 0077104", "Routing slip and cover memo re Orbis data", "H. Vasudevan", "11/04/1999"],
        ["MFC-0119377 – 0119391", "Draft Clause 9.4 notice with legal comments", "R. Kapur", "06/22/2001"],
        ["MFC-0140011 – 0140036", "Stewardship Program decision memorandum", "N. Bose", "01/26/2006"],
        ["MFC-0163402 – 0163409", "Toxicology program budget summaries FY2002–2008", "G. Hegde", "various"],
      ] },
      { type: "paragraph", text: "Documents produced pursuant to this Schedule shall be produced in the format specified in the e-disclosure protocol (Procedural Order No. 2) with load files, extracted text and the metadata fields listed in Appendix B thereto.", italic: true, size: 10 },
    ],
    footer: { left: "Notice of Deposition — " + witness, right: "Mehra & Rao Advocates" },
  };
}

// ---------------------------------------------------------------------------
// Protective order (two-tier)
// ---------------------------------------------------------------------------
export function protectiveOrderSpec(ctx: SpecContext = {}): DocSpec {
  return {
    title: ctx.title ?? "Confidentiality Order (Two-Tier Confidentiality)",
    subject: "Protective order",
    keywords: ["protective order", "confidentiality", "AEO", "Procedural Order No. 1"],
    caption: valsaraCaption(["Procedural Order No. 1 — Confidentiality Order Governing", "Confidential and Highly Confidential Material"]),
    blocks: [
      { type: "paragraph", text: "WHEREAS, document disclosure in this arbitration will involve the production of trade secrets, proprietary formulations, non-public regulatory submissions, personnel records and health information; and WHEREAS, the parties have agreed to the entry of this Order under Sections 19 and 42A of the Arbitration and Conciliation Act, 1996; it is hereby ORDERED as follows:", indent: true },
      { type: "heading", text: "1. Scope and Definitions", level: 2 },
      { type: "numbered", number: "1.1", text: "**\"Material\"** means all documents, electronically stored information, testimony, interrogatory answers, responses to requests for admission, and other information produced, served or otherwise disclosed in this Arbitration, including all copies, excerpts, summaries and compilations thereof." },
      { type: "numbered", number: "1.2", text: "**\"Confidential Material\"** means Material that the Producing Party reasonably and in good faith believes contains non-public commercial, financial, personal or medical information the disclosure of which would be harmful to the Producing Party or a third party, including personnel files, health information, and information a party is obligated by contract or statute to keep confidential." },
      { type: "numbered", number: "1.3", text: "**\"Highly Confidential – Attorneys' Eyes Only Material\"** (\"AEO Material\") means Confidential Material that constitutes or reveals trade secrets or confidential know-how, including chemical formulations, manufacturing process parameters, supplier and customer pricing, unpublished research protocols and raw toxicological data, the disclosure of which to a competitor would cause serious competitive injury." },
      { type: "numbered", number: "1.4", text: "**\"Producing Party\"** means any party or non-party that produces Material; **\"Receiving Party\"** means any party that receives Material; **\"Outside Counsel\"** means attorneys of record and their firms who are not employees of a party." },
      { type: "heading", text: "2. Designation of Material", level: 2 },
      { type: "numbered", number: "2.1", text: "Documents shall be designated by affixing the legend **\"CONFIDENTIAL – SUBJECT TO PROTECTIVE ORDER\"** or **\"HIGHLY CONFIDENTIAL – ATTORNEYS' EYES ONLY\"** to each page containing protected Material, in a manner that does not obscure the text and adjacent to the Bates number. Native files shall be designated by including the legend in the file name and on the accompanying slip sheet." },
      { type: "numbered", number: "2.2", text: "Deposition testimony may be designated on the record or by written notice served within thirty (30) days after receipt of the final transcript. All transcripts shall be treated as AEO Material during that period." },
      { type: "numbered", number: "2.3", text: "Designations shall be made in good faith and shall not be used to cover Material that is publicly available or that was independently obtained by the Receiving Party without breach of any obligation. Mass, indiscriminate or routinized designations are prohibited; the Tribunal may impose sanctions on a party that designates Material without a good-faith basis." },
      { type: "heading", text: "3. Access to Confidential Material (Tier 1)", level: 2 },
      { type: "paragraph", text: "Confidential Material may be disclosed only to:" },
      { type: "bullets", items: [
        "the Receiving Party, its officers, directors and employees to whom disclosure is reasonably necessary for the Arbitration;",
        "Outside Counsel and their paralegal, clerical, litigation support and e-discovery vendor personnel;",
        "experts and consultants retained for the Arbitration who have executed **Exhibit A** (Acknowledgment and Agreement to Be Bound);",
        "the Tribunal, the Tribunal Secretary, transcribers and videographers;",
        "mediators and their staff who have executed Exhibit A;",
        "the author, addressee or any recipient of the Material, or any person who is shown on the face of the Material to have had prior access to it; and",
        "any deponent or hearing witness, provided the witness may not retain a copy.",
      ] },
      { type: "heading", text: "4. Access to Highly Confidential – Attorneys' Eyes Only Material (Tier 2)", level: 2 },
      { type: "numbered", number: "4.1", text: "AEO Material may be disclosed only to the persons identified in Paragraphs 3(b) through 3(f). AEO Material **may not** be disclosed to a party, its officers, directors or employees, or to in-house counsel, except that each party may designate up to two (2) in-house attorneys who have no responsibility for competitive decision-making and who have executed Exhibit A; such designations shall be served in writing and are subject to objection within ten (10) days." },
      { type: "numbered", number: "4.2", text: "Before disclosing AEO Material to an expert or consultant, the Receiving Party shall serve on the Producing Party the expert's curriculum vitae, a list of engagements in the preceding five years, and the executed Exhibit A. The Producing Party may object within seven (7) days; disclosure shall not occur until the objection is resolved by agreement or by the Tribunal." },
      { type: "numbered", number: "4.3", text: "AEO Material shall be maintained in a secure workspace with access limited to persons authorized under Paragraph 4.1, shall not be uploaded to any generative AI service that retains or trains on inputs, and shall be produced in the review platform with the AEO tier flag set so that platform permissions enforce the restriction." },
      { type: "heading", text: "5. Challenges to Designations", level: 2 },
      { type: "numbered", number: "5.1", text: "A Receiving Party may challenge a designation at any time by written notice identifying the Material by Bates number and stating the basis for the challenge. The parties shall meet and confer within fourteen (14) days. If the dispute is not resolved, the Producing Party shall apply to the Tribunal for an order upholding the designation within twenty-one (21) days after the conference; the Producing Party bears the burden of persuasion. Frivolous challenges and unjustified designations may both be sanctioned." },
      { type: "heading", text: "6. Use in Tribunal Submissions and at the Hearing", level: 2 },
      { type: "numbered", number: "6.1", text: "A party seeking to file Confidential or AEO Material with the Tribunal or in any court proceeding under Section 34 or 37 of the Act shall seek sealed filing under the applicable court rules. Redacted public versions shall be filed within seven (7) days of the sealed filing." },
      { type: "numbered", number: "6.2", text: "The use of protected Material at the evidentiary hearing shall be governed by a separate order to be made at the pre-hearing conference. Nothing in this Order restricts a party's use of its own Material." },
      { type: "heading", text: "7. Inadvertent Production; Clawback", level: 2 },
      { type: "numbered", number: "7.1", text: "The production of any Material subject to legal professional privilege under Sections 126 to 129 of the Indian Evidence Act, 1872 shall not constitute a waiver in this or any other proceeding. Upon written notice of a clawback, the Receiving Party shall within five (5) business days return or destroy the Material and all copies, and shall not use the Material for any purpose pending resolution of any challenge by the Tribunal." },
      { type: "numbered", number: "7.2", text: "Inadvertent failure to designate Material may be corrected by written notice; the Receiving Party shall thereafter treat the Material in accordance with the corrected designation and make reasonable efforts to retrieve any copies disclosed to persons not authorized to receive it." },
      { type: "heading", text: "8. Health and Personal Information", level: 2 },
      { type: "paragraph", text: "Personal data shall be processed consistently with the Digital Personal Data Protection Act, 2023. The parties are prohibited from using or disclosing health or personal information for any purpose other than this Arbitration and shall return or destroy such information at the conclusion of the Arbitration." },
      { type: "heading", text: "9. Duration and Final Disposition", level: 2 },
      { type: "numbered", number: "9.1", text: "The obligations of this Order survive the termination of the Arbitration. Within ninety (90) days after final disposition, each Receiving Party shall return or destroy all protected Material and certify in writing that it has done so, except that Outside Counsel may retain one archival copy of pleadings, expert reports, deposition transcripts and work product, which shall remain subject to this Order." },
      { type: "numbered", number: "9.2", text: "The parties agree that this Order may be enforced under Section 27 of the Act and survives the Award." },
      { type: "paragraph", text: "**IT IS SO ORDERED.**", before: 10 },
      { type: "signature", lines: ["**Justice (Retd.) Vasudha Rangan**", "Presiding Arbitrator"], dateLine: `New Delhi — ${longDate(ctx.date)}` },
      { type: "pagebreak" },
      { type: "heading", text: "Exhibit A — Acknowledgment and Agreement to Be Bound", level: 1, align: "center" },
      { type: "paragraph", text: "I, ______________________________ [print full name], of ______________________________ [address and employer], solemnly affirm that I have read in its entirety and understand the Confidentiality Order made in *Valsara Textile Park Ltd. v. Meridian Fine Chemicals Ltd.*, Arb. Ref. 14/2024 (seat: New Delhi). I agree to comply with and be bound by all of its terms and I understand and acknowledge that failure to comply could expose me to sanctions and punishment in the nature of contempt. I will not disclose in any manner any information or item subject to this Order to any person or entity except in strict compliance with its provisions." },
      { type: "paragraph", text: "I further agree to submit to the jurisdiction of the Arbitral Tribunal and of the courts at New Delhi for the purpose of enforcing the terms of this Order, even if such enforcement proceedings occur after termination of this arbitration. I designate ______________________________ [name and address] as my agent in New Delhi for service of process in connection with this arbitration or any proceedings related to enforcement of this Order." },
      { type: "spacer", height: 8 },
      { type: "field", name: "ack_name", label: "Printed name:", kind: "text", width: 280 },
      { type: "field", name: "ack_employer", label: "Employer / affiliation:", kind: "text", width: 240 },
      { type: "field", name: "ack_role", label: "Role in arbitration:", kind: "dropdown", options: ["Expert witness", "Consultant", "Litigation support vendor", "In-house counsel (¶ 4.1)", "Other"], width: 220 },
      { type: "field", name: "ack_date", label: "Date:", kind: "text", width: 160 },
      { type: "field", name: "ack_aeo", label: "I have been granted access to Highly Confidential – Attorneys' Eyes Only Material and understand the Tier 2 restrictions in Paragraph 4.", kind: "checkbox" },
      { type: "field", name: "ack_ai", label: "I will not upload protected Material to any generative AI service that retains or trains on inputs (¶ 4.3).", kind: "checkbox" },
      { type: "spacer", height: 18 },
      { type: "paragraph", text: "Signature: ____________________________________________" },
    ],
    footer: { left: "Confidentiality Order", right: "Arb. Ref. 14/2024" },
  };
}

// ---------------------------------------------------------------------------
// Procedural order excerpt (Procedural Order No. 5 — Tier 2 custodial production)
// ---------------------------------------------------------------------------
export function cmoSpec(ctx: SpecContext = {}): DocSpec {
  return {
    title: ctx.title ?? "Procedural Order No. 5 — Tier 2 Custodial Production Protocol",
    subject: "Procedural order",
    keywords: ["procedural order", "custodial production", "ESI", "Tier 2"],
    caption: valsaraCaption(["Procedural Order No. 5", "(Tier 2 Custodial Production Protocol)"]),
    blocks: [
      { type: "paragraph", text: "This Order supplements Procedural Orders Nos. 2 (E-Disclosure Protocol), 3 (Privilege Logs) and 4 (Deposition Protocol) and governs the second tier of custodial document production by the Respondent Meridian Fine Chemicals Ltd. (\"Meridian\") on the Clause 9.4 and indemnity issues. The Tribunal has considered the parties' joint status report of September 8, 2026 (Tr. Doc. 112), the Claimant's application for disclosure (Tr. Doc. 108) and Meridian's reply (Tr. Doc. 110).", indent: true },
      { type: "heading", text: "I. Tier 2 Custodians", level: 1 },
      { type: "numbered", number: "1.", text: "Meridian shall collect and review documents from the following six (6) custodians (the \"Tier 2 Custodians\"): **Girish Hegde** (Director, Environmental Health & Safety), **Hema Vasudevan** (Senior Toxicologist), **Nandini Bose** (Product Stewardship Manager), **Anil Prasad** (VP, Textile Finishes), **Rohit Kapur** (Associate General Counsel) and **Manish Sood** (Regulatory Affairs Counsel)." },
      { type: "numbered", number: "2.", text: "The relevant period for Tier 2 collection is **January 1, 1996 through December 31, 2016**, except that for Mr. Kapur and Mr. Sood the period shall begin January 1, 2000. The Claimant's request to extend the period for Ms. Vasudevan to 1990 is DENIED without prejudice to renewal upon a showing, from the Tier 1 production, that responsive toxicology work predates 1996." },
      { type: "numbered", number: "3.", text: "Data sources shall include the custodians' Exchange mailboxes (including archived .pst files identified in Meridian's data map at Tr. Doc. 112-2), OneDrive and departmental SharePoint sites, the LIMS toxicology database export, and hard-copy files inventoried by Meridian's records vendor." },
      { type: "heading", text: "II. Search Methodology", level: 1 },
      { type: "numbered", number: "4.", text: "The parties shall meet and confer regarding search terms no later than **October 14, 2026**. Meridian shall apply the agreed terms set out in **Appendix A** and shall report hit counts, unique hit counts and family-inclusive counts per custodian within seven (7) days of the conference. Any term returning more than 25,000 family-inclusive documents for a single custodian shall be renegotiated in good faith." },
      { type: "numbered", number: "5.", text: "Meridian may use technology-assisted review (\"TAR 2.0 / continuous active learning\") to prioritize review, subject to the validation protocol in Procedural Order No. 2 ¶ 12. Meridian shall disclose the elusion rate and recall estimate, with the 95% confidence interval, at the conclusion of review. A recall estimate below 75% shall require further review." },
      { type: "numbered", number: "6.", text: "Documents identified as privileged shall be logged in accordance with Procedural Order No. 3. Email threads may be logged at the thread level; the log shall identify every attorney on the communication with an asterisk. Redactions shall bear the legend \"REDACTED – PRIVILEGE\" or \"REDACTED – PII\" as applicable." },
      { type: "heading", text: "III. Production Schedule and Format", level: 1 },
      { type: "numbered", number: "7.", text: "Meridian shall make rolling productions as follows: (a) a first production of no fewer than 40,000 documents by **October 14, 2026**; (b) subsequent productions every three (3) weeks thereafter; and (c) substantial completion by **December 18, 2026**. Meridian shall certify substantial completion by declaration of its e-discovery project manager." },
      { type: "numbered", number: "8.", text: "Productions shall be Bates-numbered consecutively in the **MFC-** prefix series beginning at **MFC-0060000** and shall bear the confidentiality legend required by the Protective Order in the lower-left corner of each page, with the Bates number in the lower-right corner. Native productions of spreadsheets and presentations shall be accompanied by a slip sheet bearing the Bates number and legend." },
      { type: "table", columns: ["Milestone", "Date", "Responsible", "Reference"], widths: [2.2, 1.2, 1.3, 1], rows: [
        ["Search-term meet and confer", "Oct. 14, 2026", "Both parties", "¶ 4"],
        ["Hit reports served", "Oct. 21, 2026", "Meridian", "¶ 4"],
        ["First rolling production (≥ 40,000 docs)", "Oct. 14, 2026", "Meridian", "¶ 7(a)"],
        ["Privilege log for first production", "Nov. 4, 2026", "Meridian", "PO 3 ¶ 3"],
        ["Rebuttal expert reports", "Nov. 6, 2026", "Both parties", "PO 4"],
        ["Substantial completion certification", "Dec. 18, 2026", "Meridian", "¶ 7(c)"],
        ["TAR validation report", "Jan. 8, 2027", "Meridian", "¶ 5"],
        ["Expert admissibility objections", "Dec. 18, 2026", "Both parties", "PO 4"],
      ] },
      { type: "numbered", number: "9.", text: "The metadata fields listed in Appendix B to Procedural Order No. 2 shall be produced for every document. In addition, Meridian shall populate the **Custodian**, **AllCustodians**, **DateSent**, **DateLastModified**, **ThreadID** and **ConfidentialityTier** fields, and shall produce the hash value used for de-duplication (MD5)." },
      { type: "heading", text: "IV. Disputes", level: 1 },
      { type: "numbered", number: "10.", text: "Any dispute arising under this Order shall first be raised with the Tribunal Secretary (Ms. Anjali Deshpande) by joint letter not exceeding five (5) pages. The Secretary's recommendations shall be reviewed by the Tribunal under the standard set out in Procedural Order No. 2 ¶ 6. The parties are reminded that the Tribunal expects proportionality, cooperation and candor in all discovery matters, and that the deadlines in this Order will not be extended absent a showing of good cause made before the deadline passes." },
      { type: "paragraph", text: "**AND IT IS SO ORDERED.**", before: 10 },
      { type: "signature", lines: ["**Justice (Retd.) Vasudha Rangan**", "Presiding Arbitrator"], dateLine: `New Delhi — September 22, 2026` },
      { type: "pagebreak" },
      { type: "heading", text: "Appendix A — Agreed Search Terms (Tier 2)", level: 1, align: "center" },
      { type: "paragraph", text: "Terms are applied to extracted text and metadata, case-insensitive, with the proximity operator w/N meaning within N words. Terms marked † are limited to the Vasudevan, Hegde and Bose custodial files.", size: 10 },
      { type: "table", columns: ["No.", "Search string", "Notes"], widths: [0.4, 2.8, 1.6], size: 9.5, rows: [
        ["A-1", "(\"MC-8\" OR \"MC-7\" OR MC8 OR organohalogen* OR \"repellent finish\") w/25 (toxic* OR hepat* OR liver OR carcino* OR \"bio-persist*\" OR bioaccum*)", "Core toxicology"],
        ["A-2", "(\"9.4\" OR \"clause 9\" OR \"Schedule 6\" OR GPCB) w/15 (notice OR notif* OR submi* OR report* OR draft)", "Regulatory knowledge"],
        ["A-3", "(\"stewardship programme\" OR \"phase-out\" OR phaseout OR \"phase out\") w/20 (\"MC-8\" OR \"MF-3\" OR \"Aqua-Guard\")", "2006 program †"],
        ["A-4", "(\"MF-3\" OR \"Aqua-Guard\" OR \"repellent finish\" OR \"DTS-24385\") w/30 (formulat* OR specification OR \"defence spec\")", "Product formulation"],
        ["A-5", "(groundwater OR aquifer OR \"drinking water\" OR \"well water\") w/20 (contaminat* OR migrat* OR plume OR detect*)", "Environmental release"],
        ["A-6", "(Orbis OR AquaShield OR \"Rhein Textilchemie\") w/15 (study OR data OR letter OR meeting)", "Industry communications"],
        ["A-7", "(\"MW-7\" OR \"monitoring well 7\" OR \"MW7\") ", "Site monitoring well †"],
        ["A-8", "(Vasudevan OR Hegde OR Bose OR Prasad) w/10 (memo* OR \"routing slip\" OR transmittal)", "Internal routing"],
      ] },
    ],
    footer: { left: "Procedural Order No. 5 — Tier 2 Custodial Production Protocol", right: "Arb. Ref. 14/2024" },
  };
}

// ---------------------------------------------------------------------------
// Subpoena duces tecum
// ---------------------------------------------------------------------------
export function subpoenaSpec(ctx: SpecContext = {}, o: { recipient?: string; recipientAddress?: string; returnDate?: string } = {}): DocSpec {
  const recipient = o.recipient ?? "Records Officer, Konkan Environmental Testing Pvt. Ltd.";
  const address = o.recipientAddress ?? "Plot 22, GIDC Estate, Ankleshwar, Gujarat 393002";
  const returnDate = o.returnDate ?? "November 12, 2026 at 11:00 a.m.";
  return {
    title: ctx.title ?? "Subpoena to Produce Documents, Information, or Objects (Duces Tecum)",
    subject: "Subpoena duces tecum",
    keywords: ["subpoena", "Section 27", "duces tecum"],
    caption: valsaraCaption(["Subpoena to Produce Documents, Information, or Objects", "(Tribunal-approved request; Section 27, Arbitration and Conciliation Act, 1996)"]),
    blocks: [
      { type: "paragraph", text: `**TO:** ${recipient}, ${address}` },
      { type: "paragraph", text: `☒ **Production:** YOU ARE COMMANDED to produce at the time, date, and place set forth below the following documents, electronically stored information, or objects, and to permit inspection, copying, testing, or sampling of the material: **See Attachment A.**` },
      { type: "keyvalue", rows: [["Place:", "Mehra & Rao Advocates, 21 Kasturba Gandhi Marg, 7th Floor, New Delhi 110001 (or by secure electronic transfer arranged with counsel)"], ["Date and time:", returnDate]], keyWidth: 110 },
      { type: "paragraph", text: "☐ **Inspection of Premises:** Not applicable." },
      { type: "paragraph", text: "Section 27 of the Arbitration and Conciliation Act, 1996 and Order XVI of the Code of Civil Procedure, 1908 are attached, relating to the place of compliance, your protection as a person summoned to produce documents, your duty to respond, and the potential consequences of not doing so." },
      { type: "keyvalue", rows: [["Date:", longDate(ctx.date)], ["Issued by:", "TRIBUNAL SECRETARY — or — Advocate's signature: /s/ Arjun Mehra"]], keyWidth: 110 },
      { type: "paragraph", text: "The name, address, e-mail address, and telephone number of the advocate representing the Respondent Meridian Fine Chemicals Ltd., who requests this subpoena, are: Arjun Mehra, Mehra & Rao Advocates, 21 Kasturba Gandhi Marg, 7th Floor, New Delhi 110001; amehra@mehrarao.example; +91 11 5550 0140.", size: 10.5 },
      { type: "heading", text: "Notice to the Person Who Issues or Requests This Subpoena", level: 3 },
      { type: "paragraph", text: "If this subpoena commands the production of documents, electronically stored information, or tangible things or the inspection of premises before trial, a notice and a copy of the subpoena must be served on each party to this arbitration before it is served on the person to whom it is directed. Procedural Order No. 2 ¶ 15.", size: 10.5 },
      { type: "pagebreak" },
      { type: "heading", text: "Proof of Service", level: 1, align: "center" },
      { type: "paragraph", text: "(This section should not be filed with the Tribunal unless the Tribunal so directs.)", align: "center", italic: true, size: 10 },
      { type: "field", name: "svc_received", label: "I received this subpoena for (name of individual and title, if any):", kind: "text", width: 200 },
      { type: "field", name: "svc_date", label: "on (date):", kind: "text", width: 160 },
      { type: "field", name: "svc_served", label: "I served the subpoena by delivering a copy to the named person as follows:", kind: "text", width: 200 },
      { type: "field", name: "svc_method", label: "Method of service:", kind: "dropdown", options: ["Personal delivery", "Delivery to registered agent", "Certified mail, return receipt", "Electronic delivery by agreement"], width: 220 },
      { type: "field", name: "svc_fees", label: "Fees tendered (₹):", kind: "text", width: 120 },
      { type: "field", name: "svc_unexecuted", label: "I returned the subpoena unexecuted because:", kind: "text", width: 240 },
      { type: "paragraph", text: "I solemnly affirm that this information is true." },
      { type: "keyvalue", rows: [["Date:", "______________________"], ["Server's signature:", "______________________________"], ["Printed name and title:", "______________________________"], ["Server's address:", "______________________________"]], keyWidth: 150 },
      { type: "pagebreak" },
      { type: "heading", text: "Attachment A — Documents to Be Produced", level: 1, align: "center" },
      { type: "heading", text: "Definitions and Instructions", level: 2 },
      { type: "numbered", number: "1.", text: "\"You\" and \"Your\" mean Konkan Environmental Testing Pvt. Ltd. and its predecessors, officers, employees, agents and contractors. \"Meridian\" means Meridian Fine Chemicals Ltd. \"The Site\" means the Meridian Valsara works in the Valsara Textile Park, Gujarat 394120, and the land within 1.5 km of its boundary." },
      { type: "numbered", number: "2.", text: "\"Document\" has the meaning given in Section 3 of the Indian Evidence Act, 1872 and includes electronic records, laboratory data files, chain-of-custody forms and QA/QC records. The relevant period is January 1, 2010 through the date of Your response." },
      { type: "numbered", number: "3.", text: "Produce ESI in the format described in Procedural Order No. 2 (E-Disclosure Protocol) in this arbitration, a copy of which accompanies this subpoena. Documents withheld on a claim of privilege shall be identified on a log." },
      { type: "heading", text: "Requests", level: 2 },
      { type: "numbered", number: "1.", text: "All analytical reports, raw instrument data (LC-MS/MS), calibration records and QA/QC documentation for groundwater samples collected from monitoring wells **MW-1 through MW-12** at the Site, including all samples from **MW-7**." },
      { type: "numbered", number: "2.", text: "All chain-of-custody forms, sampling logs, field notes and photographs for any sampling event at the Site." },
      { type: "numbered", number: "3.", text: "All communications with Meridian, the Gujarat Pollution Control Board (GPCB), or the Central Pollution Control Board (CPCB) concerning organohalogen results at the Site, including any notices of exceedance of the Park's 0.1 µg/L combined MC-7/MC-8 guidance value." },
      { type: "numbered", number: "4.", text: "Your standard operating procedures for LC-MS/MS determination of MC-7, MC-8 and AOX in effect during the relevant period, and any deviations documented for Site samples." },
      { type: "numbered", number: "5.", text: "Invoices, engagement letters and statements of work with Meridian or its consultants (including Patel Groundwater Sciences) relating to the Site." },
      { type: "numbered", number: "6.", text: "Documents sufficient to identify each analyst and project manager who worked on Site samples, and their qualifications." },
    ],
    footer: { left: "Subpoena Duces Tecum — " + recipient.split(",")[0], right: "Section 27, A&C Act 1996" },
  };
}

// ---------------------------------------------------------------------------
// Certificate of service
// ---------------------------------------------------------------------------
export function certificateOfServiceSpec(ctx: SpecContext = {}, o: { document?: string; date?: string; recipients?: string[][] } = {}): DocSpec {
  const document = o.document ?? "Respondent Meridian Fine Chemicals Ltd.'s Objections and Responses to the Claimant's Fourth Redfern Schedule";
  const recipients = o.recipients ?? [
    ["Radhika Kale", "Kale & Associates", "Counsel for the Claimant", "rkale@kaleassociates.example", "Tribunal portal and e-mail"],
    ["Nikhil Fernandes", "Fernandes Wagle & Co.", "Co-counsel for the Claimant", "nfernandes@fernandeswagle.example", "Tribunal portal and e-mail"],
    ["Anjali Deshpande", "Tribunal Secretariat", "Tribunal Secretary", "secretary@tribunal-vls.example", "Tribunal portal"],
    ["Devika Lal", "Lal Shah & Partners", "Counsel for Rhein Textilchemie (third party)", "dlal@lalshah.example", "E-mail (service list)"],
    ["Priya Raman", "Mehra & Rao Advocates", "Counsel for Meridian (internal)", "praman@mehrarao.example", "E-mail"],
  ];
  return {
    title: ctx.title ?? "Certificate of Service",
    subject: "Certificate of service",
    keywords: ["certificate of service", "Procedural Order No. 2"],
    caption: valsaraCaption(["Certificate of Service"]),
    blocks: [
      { type: "paragraph", text: `I, Arjun Mehra, Advocate, hereby certify that on **${o.date ?? longDate(ctx.date)}**, I caused a true and correct copy of the foregoing **${document}** to be served on the persons listed below by the means indicated, in accordance with Procedural Order No. 2 ¶ 9 (electronic service through the Tribunal portal and agreed service list).`, indent: true },
      { type: "table", columns: ["Name", "Firm / office", "Role", "E-mail", "Method"], widths: [1.2, 1.4, 1.6, 1.6, 1.1], size: 9.5, rows: recipients },
      { type: "paragraph", text: "Documents designated **CONFIDENTIAL** or **HIGHLY CONFIDENTIAL – ATTORNEYS' EYES ONLY** under the Confidentiality Order (Procedural Order No. 1) were transmitted through the secure file-transfer portal maintained by Mehra & Rao Advocates and not by unencrypted e-mail. Access credentials were sent under separate cover to the designated Tier 2 recipients only." },
      { type: "paragraph", text: "I solemnly affirm that the foregoing is true and correct. Executed at New Delhi." },
      { type: "signature", lines: FIRM_SIGNATURE, dateLine: `Dated: ${o.date ?? longDate(ctx.date)}` },
    ],
    footer: { left: "Certificate of Service", right: "Arb. Ref. 14/2024" },
  };
}

// ---------------------------------------------------------------------------
// Exhibit cover sheet
// ---------------------------------------------------------------------------
export function exhibitCoverSpec(ctx: SpecContext = {}, o: { exhibit?: string; description?: string; bates?: string; deponent?: string; date?: string; confidentiality?: string } = {}): DocSpec {
  const exhibit = o.exhibit ?? "A";
  return {
    title: ctx.title ?? `Exhibit ${exhibit}`,
    subject: "Exhibit cover sheet",
    keywords: ["exhibit", "cover sheet"],
    pageSize: [612, 792],
    margins: { top: 150, right: 72, bottom: 72, left: 72 },
    blocks: [
      { type: "paragraph", text: `**EXHIBIT ${exhibit}**`, align: "center", size: 40, after: 30 },
      { type: "rule" },
      { type: "spacer", height: 12 },
      { type: "keyvalue", keyWidth: 150, rows: [
        ["Case:", "Valsara Textile Park Ltd. v. Meridian Fine Chemicals Ltd., Arb. Ref. 14/2024 (seat: New Delhi)"],
        ["Description:", o.description ?? "Meridian Fine Chemicals Ltd. Product Stewardship Committee — Decision Memorandum re MF-3 Stewardship Programme"],
        ["Bates range:", o.bates ?? "MFC-0140011 – MFC-0140036"],
        ["Deponent:", o.deponent ?? "Nandini Bose"],
        ["Date marked:", o.date ?? longDate(ctx.date)],
        ["Confidentiality:", o.confidentiality ?? "CONFIDENTIAL – SUBJECT TO PROTECTIVE ORDER"],
        ["Offered by:", "Respondent Meridian Fine Chemicals Ltd."],
      ] },
      { type: "spacer", height: 30 },
      { type: "paragraph", text: "Reporter's exhibit sticker to be affixed below. Do not write on the underlying document.", align: "center", italic: true, size: 10 },
    ],
    footer: { center: `Exhibit ${exhibit}`, right: "Mehra & Rao Advocates" },
    outline: false,
  };
}

// ---------------------------------------------------------------------------
// Northgate MSA excerpt (seed)
// ---------------------------------------------------------------------------
export function northgateMsaSpec(ctx: SpecContext = {}): DocSpec {
  return {
    title: ctx.title ?? "Northgate / Apex Master Services Agreement — Excerpt (Arts. 7, 9, 12)",
    subject: "Contract excerpt",
    keywords: ["MSA", "limitation of liability", "termination", "Northgate", "Apex"],
    caption: northgateCaption(["Exhibit 4 to the Affirmation of Dhruv Oberoi", "Master Services Agreement dated March 3, 2023 (Excerpt)"]),
    blocks: [
      { type: "paragraph", text: "The following are true and correct excerpts of the Master Services Agreement between Northgate Logistics Holdings, LLC (\"Northgate\") and Apex Freight Systems, Inc. (\"Apex\") dated March 3, 2023 (the \"MSA\"), produced by Apex at **APEX-0000412 – APEX-0000471**. Internal page references are to the executed MSA. Portions not relevant to the pending motion are omitted; the complete MSA is filed under seal as Exhibit 4-A.", italic: true, size: 10.5 },
      { type: "heading", text: "Article 7 — Service Levels and Credits", level: 1 },
      { type: "numbered", number: "7.1", text: "**On-Time Performance.** Apex shall achieve an on-time delivery rate of not less than ninety-seven percent (97%) for all Shipments in each calendar month, measured in accordance with Schedule 7-A. \"On-time\" means delivery within the delivery window specified in the applicable Shipment Order, excluding delays caused by Force Majeure or by Northgate's failure to tender the Shipment on schedule." },
      { type: "numbered", number: "7.2", text: "**Service Credits.** If Apex fails to meet the On-Time Performance standard in any month, Apex shall credit Northgate two percent (2%) of the Monthly Fees for that month for each full percentage point below 97%, up to a maximum credit of fifteen percent (15%) of Monthly Fees. Service Credits are Northgate's sole and exclusive monetary remedy for a failure to meet the service levels in this Article 7, **except** as provided in Section 7.4 and Article 12." },
      { type: "numbered", number: "7.3", text: "**Reporting.** Apex shall deliver a monthly performance report within ten (10) Business Days after month-end in the format of Schedule 7-B, including root-cause analysis for every Shipment delivered more than twenty-four (24) hours late. Northgate may audit the underlying telematics data on thirty (30) days' notice, not more than twice per Contract Year." },
      { type: "numbered", number: "7.4", text: "**Chronic Failure.** If Apex fails to meet the On-Time Performance standard in any three (3) months in a rolling six-month period, or falls below ninety percent (90%) in any single month, such failure shall constitute a \"Chronic Failure\" entitling Northgate to terminate this Agreement for cause under Section 9.2 without the cure period set forth therein." },
      { type: "heading", text: "Article 9 — Term and Termination", level: 1 },
      { type: "numbered", number: "9.1", text: "**Term.** This Agreement shall commence on the Effective Date and continue for an initial term of three (3) years (the \"Initial Term\"), and shall thereafter renew automatically for successive one-year terms unless either party gives written notice of non-renewal at least one hundred eighty (180) days before the end of the then-current term." },
      { type: "numbered", number: "9.2", text: "**Termination for Cause.** Either party may terminate this Agreement upon written notice if the other party materially breaches this Agreement and fails to cure such breach within thirty (30) days after receipt of written notice describing the breach in reasonable detail. Notice of breach shall be delivered in accordance with Section 15.3 to the addresses set forth therein, with a copy to the receiving party's General Counsel." },
      { type: "numbered", number: "9.3", text: "**Termination for Convenience.** Northgate may terminate this Agreement for convenience upon ninety (90) days' written notice, subject to payment of the Early Termination Fee set forth in Schedule 9-A, which the parties agree is a reasonable estimate of Apex's unrecovered investment in dedicated equipment and is not a penalty." },
      { type: "numbered", number: "9.4", text: "**Transition Assistance.** Upon any termination or expiration, Apex shall provide up to one hundred twenty (120) days of transition assistance at the rates set forth in Schedule 4, including the orderly transfer of in-transit Shipments, return of Northgate-owned trailers and pallets, and delivery of all shipment data in a commercially reasonable electronic format." },
      { type: "heading", text: "Article 12 — Limitation of Liability", level: 1 },
      { type: "numbered", number: "12.1", text: "**Exclusion of Consequential Damages.** EXCEPT FOR (a) A PARTY'S INDEMNIFICATION OBLIGATIONS UNDER ARTICLE 11, (b) BREACH OF ARTICLE 10 (CONFIDENTIALITY), (c) A PARTY'S GROSS NEGLIGENCE, WILLFUL MISCONDUCT OR FRAUD, AND (d) LIABILITY FOR CARGO LOSS OR DAMAGE UNDER SECTION 6.5, NEITHER PARTY SHALL BE LIABLE TO THE OTHER FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL OR PUNITIVE DAMAGES, INCLUDING LOST PROFITS OR LOSS OF BUSINESS, ARISING OUT OF OR RELATING TO THIS AGREEMENT, HOWEVER CAUSED AND UNDER ANY THEORY OF LIABILITY, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGES." },
      { type: "numbered", number: "12.2", text: "**Cap.** EXCEPT FOR THE MATTERS EXCLUDED IN SECTION 12.1(a) THROUGH (d), EACH PARTY'S AGGREGATE LIABILITY ARISING OUT OF OR RELATING TO THIS AGREEMENT SHALL NOT EXCEED THE FEES PAID OR PAYABLE BY NORTHGATE TO APEX UNDER THIS AGREEMENT IN THE TWELVE (12) MONTHS IMMEDIATELY PRECEDING THE EVENT GIVING RISE TO THE CLAIM. The parties acknowledge that the limitations in this Article 12 are an essential basis of the bargain and that the Fees reflect such limitations." },
      { type: "numbered", number: "12.3", text: "**Cargo Claims.** Apex's liability for loss of or damage to cargo shall be governed by 49 U.S.C. § 14706 and Section 6.5, provided that Apex's liability for any single Shipment shall not exceed the declared value stated on the bill of lading or, if none is stated, $250,000 per Shipment." },
      { type: "heading", text: "Article 15 — General (excerpt)", level: 1 },
      { type: "numbered", number: "15.3", text: "**Notices.** All notices shall be in writing and delivered by hand, by nationally recognized overnight courier, or by e-mail with confirmation of receipt, to: if to Northgate, 500 Seventh Avenue, 18th Floor, New York, NY 10018, Attn: Chief Operating Officer, with a copy to legal@northgatelogistics.com; if to Apex, 7100 Commerce Way, Suite 300, Memphis, TN 38118, Attn: President, with a copy to General Counsel, notices@apexfreight.com." },
      { type: "numbered", number: "15.7", text: "**Governing Law; Forum.** This Agreement shall be governed by the laws of the State of New York without regard to its conflict-of-laws principles. The parties consent to the exclusive jurisdiction of the state and federal courts located in New York County, New York, and waive trial by jury in any action arising out of this Agreement." },
      { type: "paragraph", text: "[Remainder of page intentionally left blank; signature page follows in the complete MSA at APEX-0000471.]", align: "center", italic: true, size: 10, before: 12 },
    ],
    footer: { left: "Exhibit 4 — MSA Excerpt", right: "Index No. 654412/2025" },
    bates: { prefix: "APEX-", start: 412, digits: 7, position: "bottom-right", legend: "CONFIDENTIAL — PRODUCED PURSUANT TO STIPULATED CONFIDENTIALITY ORDER" },
  };
}

// ---------------------------------------------------------------------------
// Meridian custodial production excerpt (seed — for redaction / PII demos)
// ---------------------------------------------------------------------------
export function custodialExcerptSpec(ctx: SpecContext = {}): DocSpec {
  return {
    title: ctx.title ?? "MFC-0060000 — Tier 2 Production Excerpt (Hegde custodial file)",
    subject: "Production excerpt",
    keywords: ["production", "Bates", "custodial", "PII"],
    fontSize: 10.5,
    blocks: [
      { type: "paragraph", text: "**From:** Girish Hegde <g.hegde@meridianfinechem.example>\n**Sent:** Tuesday, April 11, 2006 4:47 PM\n**To:** Nandini Bose <n.bose@meridianfinechem.example>; Hema Vasudevan <h.vasudevan@meridianfinechem.example>\n**Cc:** Rohit Kapur <r.kapur@meridianfinechem.example>\n**Subject:** RE: MW-7 quarterly results — draft response to GPCB", font: "sans", size: 10 },
      { type: "rule" },
      { type: "paragraph", text: "Nandini, Hema —" },
      { type: "paragraph", text: "I have gone through the Q1 monitoring package from Konkan. The MW-7 result (MC-7 1,140 ng/L; MC-8 2,360 ng/L) is the third consecutive quarter above the internal action level we set in the 2005 stewardship plan. MW-3 and MW-9 remain non-detect. Before we send anything to GPCB I want Hema's read on whether the MW-7 trend is consistent with the historical finishing-line drain or whether we are looking at a new source on the north lot." },
      { type: "paragraph", text: "Rohit has asked that the response go out under his review given the pending CPCB information request. Please treat this thread as **privileged and confidential — prepared at the direction of counsel** and do not forward outside the distribution." },
      { type: "paragraph", text: "Also — HR needs the updated emergency contact for the sampling contractor's site lead. His details are: Marcus Delgado, DOB 03/14/1971, SSN 412-55-8367, cell (843) 555-0192, marcus.delgado@konkanenv.example. Please pass to Dana in HR and delete from your copy." },
      { type: "paragraph", text: "The reimbursement for the Q1 lab invoice should go to Konkan's operating account: Saurashtra Co-operative Bank, IFSC SCOB0000412, account no. 4471029835. Invoice 26-0412 total ₹18,64,000." },
      { type: "paragraph", text: "Girish" },
      { type: "paragraph", text: "Girish Hegde | Director, Environmental Health & Safety | Meridian Fine Chemicals Ltd. | Valsara Textile Park, Gujarat 394120 | +91 261 555 0110", size: 9, font: "sans" },
      { type: "spacer", height: 10 },
      { type: "rule" },
      { type: "paragraph", text: "**From:** Nandini Bose\n**Sent:** Monday, April 10, 2006 9:12 AM\n**To:** Girish Hegde; Hema Vasudevan\n**Subject:** MW-7 quarterly results — draft response to GPCB", font: "sans", size: 10 },
      { type: "paragraph", text: "Girish — attached is the draft cover letter to GPCB for the Q1 groundwater results. I kept the narrative factual and did not characterize the MW-7 exceedance beyond what the lab reported. Two items for you: (1) whether we reference the 2005 stewardship action level at all, since it is an internal number; and (2) whether Hema's 1998 rodent study summary should be referenced as background on the toxicology program. My instinct is no on both, but Rohit may want the second point handled differently in light of the Clause 9.4 history." },
      { type: "paragraph", text: "The stewardship program memo (MFC-0140011) commits us to a 95% reduction in MC-8 discharges by 2010. If the MW-7 plume is migrating toward the Park wellfield, we should model it now rather than wait for GPCB to ask. Raj Patel's group quoted ₹42,00,000 for the transport model; PO attached." },
      { type: "paragraph", text: "Nandini" },
      { type: "pagebreak" },
      { type: "paragraph", text: "**ATTACHMENT — DRAFT** cover letter to GPCB (not sent)", font: "sans", size: 10 },
      { type: "rule" },
      { type: "paragraph", text: "April 12, 2006", align: "right" },
      { type: "paragraph", text: "Gujarat Pollution Control Board\nRegional Office — Surat\nParyavaran Bhavan, Udhna\nSurat, Gujarat 395002\nAttn: Ms. Charu Joshi, Hydrogeologist" },
      { type: "paragraph", text: "**Re: Meridian Fine Chemicals Ltd., Valsara Works — Consent No. AWH-43215 — First Quarter 2006 Groundwater Monitoring Results**" },
      { type: "paragraph", text: "Dear Ms. Joshi:" },
      { type: "paragraph", text: "Enclosed please find the First Quarter 2006 groundwater monitoring report for the above-referenced facility, prepared by Konkan Environmental Testing Pvt. Ltd. in accordance with Condition 14 of the facility's consent to operate and the Groundwater Monitoring Plan approved on June 3, 2004. Samples were collected from monitoring wells MW-1 through MW-12 on February 27–28, 2006 and analyzed for organohalogen compounds by liquid chromatography/tandem mass spectrometry.", indent: true },
      { type: "paragraph", text: "Results for eleven of the twelve wells were consistent with prior sampling events. Monitoring well **MW-7**, located downgradient of the former finishing-line drain, reported MC-7 at 1,140 ng/L and MC-8 at 2,360 ng/L. Meridian is evaluating the MW-7 results and will submit a supplemental assessment, including a proposed scope for additional delineation wells, within sixty (60) days. Please direct any questions to the undersigned at +91 261 555 0110.", indent: true },
      { type: "paragraph", text: "Sincerely," },
      { type: "spacer", height: 24 },
      { type: "paragraph", text: "Girish Hegde\nDirector, Environmental Health & Safety" },
      { type: "paragraph", text: "cc: Rohit Kapur, Esq. (Associate General Counsel)\n     Nandini Bose (Product Stewardship)", size: 10 },
      { type: "pagebreak" },
      { type: "paragraph", text: "**ATTACHMENT — Konkan Environmental Testing Pvt. Ltd.**\nAnalytical Summary — Project 2006-0117 — Meridian Valsara Works\nSampling event: February 27–28, 2006 · Method: LC-MS/MS (in-house SOP KET-17) · Units: ng/L", font: "sans", size: 10 },
      { type: "table", columns: ["Well", "Sample ID", "MC-7", "MC-8", "MC-6", "Qualifier", "Analyst"], widths: [0.7, 1.3, 0.8, 0.8, 0.8, 0.9, 1.2], size: 9, rows: [
        ["MW-1", "KET-060227-01", "< 10", "< 10", "< 10", "U", "T. Nair"],
        ["MW-2", "KET-060227-02", "14", "22", "< 10", "J", "T. Nair"],
        ["MW-3", "KET-060227-03", "< 10", "< 10", "< 10", "U", "T. Nair"],
        ["MW-4", "KET-060227-04", "38", "61", "12", "", "T. Nair"],
        ["MW-5", "KET-060227-05", "27", "40", "< 10", "", "K. Oza"],
        ["MW-6", "KET-060227-06", "96", "188", "31", "", "K. Oza"],
        ["MW-7", "KET-060228-07", "1,140", "2,360", "412", "", "K. Oza"],
        ["MW-7 (dup)", "KET-060228-07D", "1,102", "2,290", "398", "", "K. Oza"],
        ["MW-8", "KET-060228-08", "210", "455", "77", "", "K. Oza"],
        ["MW-9", "KET-060228-09", "< 10", "< 10", "< 10", "U", "T. Nair"],
        ["MW-10", "KET-060228-10", "18", "33", "< 10", "J", "T. Nair"],
        ["MW-11", "KET-060228-11", "12", "19", "< 10", "J", "T. Nair"],
        ["MW-12", "KET-060228-12", "< 10", "15", "< 10", "J", "T. Nair"],
        ["Trip blank", "KET-060227-TB", "< 10", "< 10", "< 10", "U", "—"],
      ] },
      { type: "paragraph", text: "U = not detected above the reporting limit. J = estimated value between the method detection limit and the reporting limit. Duplicate RPD for MW-7: MC-7 3.4%, MC-8 3.0% (acceptance ≤ 30%). Matrix spike recoveries within 70–130%. Reviewed by: L. Kamath, QA Manager, March 9, 2006.", size: 9 },
    ],
    footer: { left: "Hegde custodial file — Q1 2006 MW-7 thread", center: "" },
    bates: { prefix: "MFC-", start: 60000, digits: 7, position: "bottom-right", legend: "CONFIDENTIAL — SUBJECT TO PROTECTIVE ORDER" },
    outline: false,
  };
}

/** The sample-dataset versions (demo seed and tests). Gallery documents use the generic specs. */
const DEMO_SPEC_BUILDERS: Record<string, (ctx: SpecContext) => DocSpec> = {
  "deposition-notice": (ctx) => depositionNoticeSpec(ctx),
  "protective-order": (ctx) => protectiveOrderSpec(ctx),
  "cmo-excerpt": (ctx) => cmoSpec(ctx),
  "subpoena-duces-tecum": (ctx) => subpoenaSpec(ctx),
  "certificate-of-service": (ctx) => certificateOfServiceSpec(ctx),
  "exhibit-cover": (ctx) => exhibitCoverSpec(ctx),
  "northgate-msa-excerpt": (ctx) => northgateMsaSpec(ctx),
  "custodial-excerpt": (ctx) => custodialExcerptSpec(ctx),
};

/**
 * Registry used by service.ts to generate a document from its spec id. Seeded sample documents
 * (`ctx.demo`) regenerate their sample content; everything else gets the generic, placeholder version
 * (filled from the matter record when there is one), so a gallery template never carries sample facts.
 */
export const SPEC_BUILDERS: Record<string, (ctx: SpecContext) => DocSpec> = Object.fromEntries(
  Object.keys(DEMO_SPEC_BUILDERS).map((id) => [id, (ctx: SpecContext) => (!ctx.demo && GENERIC_SPEC_BUILDERS[id] ? GENERIC_SPEC_BUILDERS[id](ctx) : DEMO_SPEC_BUILDERS[id](ctx))]),
);
