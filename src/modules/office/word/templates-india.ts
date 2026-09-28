import "server-only";
import { db } from "@/lib/db";
import type { OfficeTemplate } from "@/modules/office/shared/template-registry";
import type { MatterRecord } from "@/modules/matters/types";
import { courtById } from "@/lib/india/courts";
import { formatCaseCitation, formatIndianDate } from "@/lib/india/citation-style";
import { forumById, formatCaseNumber } from "@/modules/matters/india";
import type { PMNode } from "./doc-model";
import { makePageBreak } from "./doc-model";
import { buildDoc, type SpecItem } from "./templates";

/**
 * Drafting templates for Indian courts (focus: Bengaluru and Hyderabad). Headings and cause-title layout follow the
 * practice of the court named: "IN THE HIGH COURT OF KARNATAKA AT BENGALURU", "IN THE HIGH COURT FOR THE STATE OF
 * TELANGANA AT HYDERABAD (SPECIAL ORIGINAL JURISDICTION)", City Civil / Commercial / Sessions / Magistrate courts.
 *
 * Every blank is a bracketed placeholder. Anything whose exact form varies by court, notification or registry practice
 * (court-hall numbers, subject classifications, stamp values, enrolment formats, recent rule changes) is marked
 * [VERIFY] so the advocate checks it before filing. Authorities are cited only as placeholders or with [VERIFY]; the
 * templates never assert a proposition of law as settled.
 */

type M = (MatterRecord & { meta?: Record<string, unknown> }) | null;

const matterOf = (id?: string): M => (id ? (db().collection<MatterRecord>("matters").get(id) as M) : null);

function todayIn(): string {
  return formatIndianDate(new Date().toISOString().slice(0, 10)) ?? "";
}

/**
 * An authority to be checked before citing, formatted by the citation engine (`formatCaseCitation`). The citation is
 * printed only when the engine can parse it; either way it carries [VERIFY] — templates never assert that an
 * authority says anything.
 */
function auth(caseName: string, reporter: string): string {
  const f = formatCaseCitation({ caseName, reporters: [reporter] });
  return `${f.citation ?? `${caseName}, ${reporter}`} [VERIFY]`;
}

/** Court heading for the cause title, from the matter's court when set, else the template's default. */
export function courtHeading(m: M, fallbackCourtId: string): { lines: string[]; place: string; hc: boolean } {
  const courtId = m?.india?.courtId ?? fallbackCourtId;
  const bench = m?.india?.benchId;
  switch (courtId) {
    case "hc-karnataka": {
      const seat = bench === "kar-dharwad" ? "DHARWAD BENCH" : bench === "kar-kalaburagi" ? "KALABURAGI BENCH" : "BENGALURU";
      return { lines: [`IN THE HIGH COURT OF KARNATAKA${bench === "kar-dharwad" || bench === "kar-kalaburagi" ? `, ${seat}` : " AT BENGALURU"}`], place: bench === "kar-dharwad" ? "Dharwad" : bench === "kar-kalaburagi" ? "Kalaburagi" : "Bengaluru", hc: true };
    }
    case "hc-telangana": return { lines: ["IN THE HIGH COURT FOR THE STATE OF TELANGANA AT HYDERABAD"], place: "Hyderabad", hc: true };
    case "hc-andhra": return { lines: ["IN THE HIGH COURT OF ANDHRA PRADESH AT AMARAVATI"], place: "Amaravati", hc: true };
    case "sci": return { lines: ["IN THE SUPREME COURT OF INDIA"], place: "New Delhi", hc: true };
    case "ka-blr-city-civil": return { lines: ["IN THE COURT OF THE [__] ADDITIONAL CITY CIVIL AND SESSIONS JUDGE AT BENGALURU (CCH-[__]) [VERIFY court hall]"], place: "Bengaluru", hc: false };
    case "ka-blr-commercial": return { lines: ["IN THE COURT OF THE [__] ADDITIONAL CITY CIVIL AND SESSIONS JUDGE, COMMERCIAL COURT AT BENGALURU (CCH-[__]) [VERIFY designation and court hall]"], place: "Bengaluru", hc: false };
    case "ka-blr-sessions": return { lines: ["IN THE COURT OF THE [__] ADDITIONAL CITY CIVIL AND SESSIONS JUDGE AT BENGALURU (CCH-[__]) [VERIFY court hall]"], place: "Bengaluru", hc: false };
    case "ka-blr-acmm": return { lines: ["IN THE COURT OF THE [__] ADDITIONAL CHIEF METROPOLITAN MAGISTRATE AT BENGALURU [VERIFY court number]"], place: "Bengaluru", hc: false };
    case "ts-hyd-city-civil": return { lines: ["IN THE COURT OF THE [__] ADDITIONAL CHIEF JUDGE, CITY CIVIL COURT AT HYDERABAD [VERIFY]"], place: "Hyderabad", hc: false };
    case "ts-hyd-commercial": return { lines: ["IN THE COURT OF THE SPECIAL JUDGE FOR TRIAL AND DISPOSAL OF COMMERCIAL DISPUTES AT HYDERABAD [VERIFY designation]"], place: "Hyderabad", hc: false };
    case "ts-hyd-sessions": return { lines: ["IN THE COURT OF THE [__] ADDITIONAL METROPOLITAN SESSIONS JUDGE AT HYDERABAD [VERIFY]"], place: "Hyderabad", hc: false };
    case "ts-hyd-mm": return { lines: ["IN THE COURT OF THE [__] ADDITIONAL CHIEF METROPOLITAN MAGISTRATE AT HYDERABAD [VERIFY]"], place: "Hyderabad", hc: false };
    default: {
      const c = courtById(courtId) ?? null;
      const f = forumById(courtId);
      return { lines: [`IN THE ${(c?.name ?? f?.name ?? "[COURT]").toUpperCase()}`], place: c?.seat ?? f?.city ?? "[PLACE]", hc: c?.level === "high" };
    }
  }
}

/** "O.S. No. 4521 of 2022" from the matter, else a blank of the template's type. */
function caseLine(m: M, type: string, suffix = ""): string {
  const n = formatCaseNumber(m?.india?.caseType ?? undefined, m?.india?.caseNumber, m?.india?.caseYear);
  return n && (!m?.india?.caseType || m.india.caseType === type) ? `${n}${suffix}` : `${type} No. __________ of 20__${suffix}`;
}

interface Party { lines: string; role: string }

/** BETWEEN / AND cause title with the role at the right margin. */
function causeTitle(heading: string[], sub: string | null, number: string, first: Party[], second: Party[], docTitle: string[]): SpecItem[] {
  const out: SpecItem[] = [];
  for (const h of heading) out.push(`@center **${h}**`);
  if (sub) out.push(`@center ${sub}`);
  for (const n of number.split("\n")) out.push(`@center **${n}**`);
  out.push("**BETWEEN:**");
  first.forEach((p, i) => { out.push(`${first.length > 1 ? `${i + 1}. ` : ""}${p.lines}`); });
  out.push(`@right **…${first[0].role}${first.length > 1 ? "S" : ""}**`);
  out.push("**AND:**");
  second.forEach((p, i) => { out.push(`${second.length > 1 ? `${i + 1}. ` : ""}${p.lines}`); });
  out.push(`@right **…${second[0].role}${second.length > 1 ? "S" : ""}**`);
  for (const t of docTitle) out.push(`@center **${t}**`);
  return out;
}

function clientParty(m: M, fallback: string, person = false): string {
  if (person) return m?.client ? `${m.client.toUpperCase()}, S/o / D/o / W/o [__], aged about __ years, [occupation], R/o [ADDRESS]` : fallback;
  return m?.client ? `${m.client.toUpperCase()}, [description: company incorporated under the Companies Act, 2013 / individual, S/o / D/o / W/o ___, aged about __ years], having its registered office / residing at [ADDRESS], represented by its [AUTHORISED SIGNATORY]` : fallback;
}

const ADV_SIGN = (forParty: string, place: string) => [
  `Place: ${place}\nDate: ${todayIn()}`,
  `@right **${forParty}**`,
  `@right **ADVOCATE FOR ${forParty}**\n[NAME], Advocate\nEnrolment No. [KAR/____/20__ or TS/____/20__] [VERIFY]\n[ADDRESS FOR SERVICE]\n[PHONE] · [EMAIL]`,
];

function verificationPara(deponent: string, place: string, knowledgeParas = "1 to __", beliefParas = "__ to __"): string {
  return `**VERIFICATION**\n\nI, ${deponent}, do hereby verify and declare that the contents of paragraphs ${knowledgeParas} above are true to my personal knowledge, the contents of paragraphs ${beliefParas} are based on information received and believed to be true, and the rest are legal submissions made on the advice of my advocate. Verified at ${place} on this the __ day of ________ 20__.\n\n**${deponent.toUpperCase()}**`;
}

// ---------------------------------------------------------------------------
// 1. Plaint (Order VII CPC) — City Civil Court, Bengaluru
// ---------------------------------------------------------------------------
export function plaintDoc(m: M): PMNode {
  const h = courtHeading(m, "ka-blr-city-civil");
  const commercial = (m?.india?.courtId ?? "").includes("commercial");
  const type = commercial ? "Com.O.S." : "O.S.";
  return buildDoc([
    ...causeTitle(h.lines, null, caseLine(m, type), [{ lines: clientParty(m, "[PLAINTIFF NAME], [S/o / D/o / W/o ___], aged about __ years, residing at [ADDRESS]"), role: "PLAINTIFF" }], [{ lines: "[DEFENDANT NAME], [description], having its office / residing at [ADDRESS]", role: "DEFENDANT" }], [`PLAINT UNDER ORDER VII RULE 1 OF THE CODE OF CIVIL PROCEDURE, 1908${commercial ? " READ WITH THE COMMERCIAL COURTS ACT, 2015" : ""}`]),
    "The Plaintiff above named respectfully submits as follows:",
    "@legal 1. **Parties.** The Plaintiff is [description]. The address of the Plaintiff for service of summons and notices is as shown in the cause title above and that of the Plaintiff's advocate [NAME], [ADDRESS].\n2. The Defendant is [description], and may be served at the address shown in the cause title.\n3. **Facts.** [Set out the material facts in chronological order, one fact per paragraph, with dates and document references: Doc. No. __ in the list of documents.]\n4. [Contract / transaction, its terms and the Plaintiff's performance.]\n5. [Breach / default by the Defendant; demands made; the Defendant's reply, if any.]\n6. **Legal notice.** The Plaintiff issued a legal notice dated [DATE] (Doc. No. __) calling upon the Defendant to [demand]. The Defendant [did not reply / replied on [DATE] denying liability] (Doc. No. __).",
    ...(commercial ? ["@legal 7. **Pre-institution mediation.** The Plaintiff initiated pre-institution mediation under Section 12A of the Commercial Courts Act, 2015 before the [District Legal Services Authority, Bengaluru Urban] and the mediation ended in a non-starter / failure report dated [DATE] (Doc. No. __). [If urgent interim relief is sought, state the urgency that exempts the suit from Section 12A.] [VERIFY]"] : []),
    "@legal 8. **Cause of action.** The cause of action for the suit arose on [DATE] when [event], on [DATE] when the legal notice was served, and continues, within the jurisdiction of this Hon'ble Court.\n9. **Jurisdiction.** This Hon'ble Court has territorial jurisdiction under Section 20 of the Code of Civil Procedure, 1908 as [the Defendant carries on business / the contract was made / was to be performed / the cause of action arose] at [PLACE], Bengaluru, and pecuniary jurisdiction as the suit is valued at ₹[AMOUNT]. [VERIFY pecuniary limits of the court]\n10. **Valuation and court fee.** The suit is valued for the purpose of court fee and jurisdiction under Section [__] of the Karnataka Court-fees and Suits Valuation Act, 1958 at ₹[AMOUNT], and court fee of ₹[AMOUNT] is paid. [VERIFY section and computation]\n11. **Limitation.** The suit is within time under Article [__] of the Schedule to the Limitation Act, 1963, the period running from [DATE].\n12. **No other proceedings.** The Plaintiff has not filed any other suit or proceeding on the same cause of action before any court.",
    "## PRAYER",
    "WHEREFORE, the Plaintiff prays that this Hon'ble Court may be pleased to pass a judgment and decree against the Defendant:",
    "@indent a) Directing the Defendant to pay the Plaintiff a sum of ₹[AMOUNT] with interest at [__]% per annum from [DATE] till the date of realisation;\nb) [Declaration / permanent injunction / other relief];\nc) Awarding costs of the suit; and\nd) Granting such other and further reliefs as this Hon'ble Court deems fit in the facts and circumstances of the case, in the interest of justice and equity.",
    ...ADV_SIGN("PLAINTIFF", h.place),
    verificationPara("[AUTHORISED SIGNATORY], [designation] of the Plaintiff", h.place),
    ...(commercial ? ["**STATEMENT OF TRUTH** (Order VI Rule 15A CPC as applicable to commercial disputes; Appendix I)\n\nI, [NAME], the authorised signatory of the Plaintiff, state that I am acquainted with the facts of the case and competent to depose; that the statements in paragraphs 1 to __ are true to my knowledge and belief; that the documents filed are true copies of the originals; and that I am aware that false statements attract proceedings for contempt. [VERIFY format against Appendix I]"] : []),
    makePageBreak(),
    "@center **LIST OF DOCUMENTS (ORDER VII RULE 14 CPC)**",
    "| Doc. No. | Date | Description | Original / copy |\n| --- | --- | --- | --- |\n| 1 | [DATE] | [Agreement / purchase order] | [Original] |\n| 2 | [DATE] | [Invoice(s)] | [Copy] |\n| 3 | [DATE] | [Correspondence] | [Copy] |\n| 4 | [DATE] | [Legal notice and postal / courier acknowledgement] | [Office copy] |",
    "Electronic records are accompanied by the certificate required under Section 63 of the Bharatiya Sakshya Adhiniyam, 2023 (formerly Section 65B of the Indian Evidence Act, 1872). [VERIFY applicable provision by filing date]",
  ]);
}

// ---------------------------------------------------------------------------
// 2. Written statement (Order VIII CPC)
// ---------------------------------------------------------------------------
export function writtenStatementDoc(m: M): PMNode {
  const h = courtHeading(m, "ka-blr-city-civil");
  const commercial = (m?.india?.courtId ?? "").includes("commercial");
  return buildDoc([
    ...causeTitle(h.lines, null, caseLine(m, commercial ? "Com.O.S." : "O.S."), [{ lines: "[PLAINTIFF NAME], [description and address]", role: "PLAINTIFF" }], [{ lines: clientParty(m, "[DEFENDANT NAME], [description and address]"), role: "DEFENDANT" }], ["WRITTEN STATEMENT FILED BY THE DEFENDANT UNDER ORDER VIII RULE 1 OF THE CODE OF CIVIL PROCEDURE, 1908"]),
    "The Defendant above named respectfully submits as follows:",
    `@legal 1. The suit is false, frivolous and vexatious, and is liable to be dismissed in limine. The Defendant denies each and every allegation in the plaint save those specifically admitted herein; anything not specifically admitted shall be deemed denied.${commercial ? " In compliance with Order VIII Rules 3A and 5 as applicable to commercial disputes, the Defendant states specifically which allegations are denied, which are not admitted, and the Defendant's own version of events. [VERIFY]" : ""}\n2. **Preliminary objections.** (a) [Limitation]; (b) [lack of territorial / pecuniary jurisdiction]; (c) [non-joinder / misjoinder of parties]; (d) [bar under Section __]; (e) [suit not properly valued / insufficient court fee]; (f) [arbitration agreement — see Section 8 of the Arbitration and Conciliation Act, 1996, if applicable].\n3. **Reply to paragraph 1 of the plaint.** [Admitted only to the extent that … ; rest denied.]\n4. **Reply to paragraph 2.** [Para-wise reply.]\n5. **Reply to paragraphs 3 to 6.** The averments are denied. The true facts are: [the Defendant's version, chronologically, with document references].\n6. **Reply to the cause of action (paragraph 8).** No cause of action arose as alleged. [Reasons.]\n7. **Reply to jurisdiction and valuation (paragraphs 9 and 10).** [Admit / deny.]\n8. **Additional pleas.** [Set-off (Order VIII Rule 6) / counter-claim (Order VIII Rule 6A) — if a counter-claim is raised, it is valued and court fee paid separately.]`,
    "## PRAYER",
    "WHEREFORE, the Defendant prays that this Hon'ble Court may be pleased to dismiss the suit with exemplary costs, [allow the counter-claim as prayed,] and grant such other reliefs as it deems fit, in the interest of justice and equity.",
    ...ADV_SIGN("DEFENDANT", h.place),
    verificationPara("[DEFENDANT / AUTHORISED SIGNATORY]", h.place),
    `Note: the written statement is to be filed within 30 days of service of summons; the court may extend time up to 90 days${commercial ? ", and in a commercial suit the right is forfeited after 120 days from service" : ""}. [VERIFY computation against the date of service]`,
  ]);
}

// ---------------------------------------------------------------------------
// 3. I.A. for temporary injunction (Order XXXIX Rules 1 & 2 CPC) with affidavit
// ---------------------------------------------------------------------------
export function injunctionIaDoc(m: M): PMNode {
  const h = courtHeading(m, "ka-blr-city-civil");
  const commercial = (m?.india?.courtId ?? "").includes("commercial");
  const plaintiff = { lines: clientParty(m, "[PLAINTIFF NAME], [description and address]"), role: "PLAINTIFF / APPLICANT" };
  const defendant = { lines: "[DEFENDANT NAME], [description and address]", role: "DEFENDANT / RESPONDENT" };
  return buildDoc([
    ...causeTitle(h.lines, null, `I.A. No. ______ of 20__\nin\n${caseLine(m, commercial ? "Com.O.S." : "O.S.")}`, [plaintiff], [defendant], ["APPLICATION UNDER ORDER XXXIX RULES 1 AND 2 READ WITH SECTION 151 OF THE CODE OF CIVIL PROCEDURE, 1908"]),
    "The Plaintiff / Applicant above named respectfully submits that, for the reasons stated in the accompanying affidavit, this Hon'ble Court may be pleased to grant an ad-interim order of temporary injunction restraining the Defendant, its officers, agents, servants and anyone claiming through or under it, from [SPECIFIC ACT — e.g. alienating, encumbering or creating third-party rights over the schedule property / using the Plaintiff's confidential information / encashing the bank guarantee No. __], pending disposal of the suit, and to pass such other orders as it deems fit, in the interest of justice and equity.",
    ...ADV_SIGN("PLAINTIFF / APPLICANT", h.place),
    makePageBreak(),
    ...causeTitle(h.lines, null, `I.A. No. ______ of 20__\nin\n${caseLine(m, commercial ? "Com.O.S." : "O.S.")}`, [plaintiff], [defendant], ["AFFIDAVIT IN SUPPORT OF THE APPLICATION UNDER ORDER XXXIX RULES 1 AND 2 CPC"]),
    "I, [NAME], [S/o / D/o / W/o ___], aged about __ years, [designation / occupation], residing at [ADDRESS], do hereby solemnly affirm and state on oath as follows:",
    "@legal 1. I am the [Plaintiff / authorised signatory of the Plaintiff] and am well acquainted with the facts of the case. I am competent to swear to this affidavit.\n2. The facts leading to the suit are set out in the plaint, which may be read as part of this affidavit to avoid repetition.\n3. **Prima facie case.** [Why the Plaintiff is likely to succeed: the contract / title / right and documents supporting it.]\n4. **Balance of convenience.** [Why greater harm results from refusing the injunction than from granting it.]\n5. **Irreparable injury.** [Why the injury cannot be adequately compensated in money.]\n6. **Urgency / ex-parte relief.** [If an ex-parte order is sought: why the object of the injunction would be defeated by delay (Order XXXIX Rule 3 CPC); undertaking to comply with the proviso to Rule 3 by sending copies to the Defendant.]\n7. The Plaintiff undertakes to abide by any order this Hon'ble Court may make as to damages if it is later found that the Defendant has suffered loss by reason of the order.",
    "Wherefore, it is prayed that this Hon'ble Court may be pleased to allow the application as prayed, in the interest of justice and equity.",
    `Authorities (to be checked before citing): ${auth("Dalpat Kumar v. Prahlad Singh", "(1992) 1 SCC 719")}; ${auth("Wander Ltd. v. Antox India (P) Ltd.", "1990 Supp SCC 727")}.`,
    `Solemnly affirmed at ${h.place} on this the __ day of ________ 20__.\n\n**DEPONENT**\n\nIdentified by me:\n\n**ADVOCATE**\n\nBefore me:\n\n**[NOTARY / OATH COMMISSIONER]**`,
  ]);
}

// ---------------------------------------------------------------------------
// 4–5. Writ petition under Article 226
// ---------------------------------------------------------------------------
export function writKarnatakaDoc(m: M): PMNode {
  const h = courtHeading(m, "hc-karnataka");
  return buildDoc([
    ...causeTitle(h.lines, "(ORIGINAL JURISDICTION)", `${caseLine(m, "W.P.")} ([SUBJECT CLASSIFICATION, e.g. GM-RES / LB-RES]) [VERIFY classification]`,
      [{ lines: clientParty(m, "[PETITIONER NAME], [S/o / D/o / W/o ___], aged about __ years, residing at [ADDRESS]"), role: "PETITIONER" }],
      [{ lines: "STATE OF KARNATAKA, represented by its [Principal Secretary / Additional Chief Secretary], [DEPARTMENT], Vidhana Soudha, Bengaluru – 560 001", role: "RESPONDENT" }, { lines: "[RESPONDENT AUTHORITY], represented by its [Commissioner / Chief Executive Officer], [ADDRESS]", role: "RESPONDENT" }],
      ["MEMORANDUM OF WRIT PETITION UNDER ARTICLES 226 AND 227 OF THE CONSTITUTION OF INDIA"]),
    "The Petitioner above named respectfully submits as follows:",
    "## SYNOPSIS AND LIST OF DATES",
    "| Date | Event |\n| --- | --- |\n| [DATE] | [Event] |\n| [DATE] | [Impugned order / action] |\n| [DATE] | [Representation made; no response] |",
    "## FACTS",
    "@legal 1. The Petitioner is [description]. The address of the Petitioner for service is as shown in the cause title and that of the Petitioner's advocate as below.\n2. Respondent No. 1 is the State of Karnataka; Respondent No. 2 is [authority], a [statutory body / local authority] and 'State' within the meaning of Article 12 of the Constitution.\n3. [Facts, chronologically, with Annexure references: Annexure-A, Annexure-B …]\n4. By the impugned [order / endorsement / notice] dated [DATE] (Annexure-__), Respondent No. 2 [action]. Aggrieved, the Petitioner has no other equally efficacious alternative remedy and approaches this Hon'ble Court.",
    "## GROUNDS",
    "@legal 1. The impugned action is without jurisdiction / authority of law, being contrary to [Section __ of the ______ Act, ____] [VERIFY].\n2. The impugned action violates the principles of natural justice: no notice or hearing was given to the Petitioner before [action].\n3. The impugned action is arbitrary and violates Article 14 [and Article 300-A] of the Constitution of India.\n4. [Further grounds.]\n5. The Petitioner craves leave of this Hon'ble Court to urge additional grounds at the time of hearing.",
    "## PRAYER",
    "WHEREFORE, the Petitioner prays that this Hon'ble Court may be pleased to:",
    "@indent a) Issue a writ of certiorari or any other appropriate writ, order or direction quashing the impugned [order / endorsement] dated [DATE] bearing No. [__] passed by Respondent No. 2 (Annexure-__);\nb) Issue a writ of mandamus directing the Respondents to [consider the Petitioner's representation dated [DATE] (Annexure-__) in accordance with law within a time frame fixed by this Hon'ble Court];\nc) Grant such other reliefs as this Hon'ble Court deems fit in the facts and circumstances of the case, in the interest of justice and equity.",
    "## INTERIM PRAYER",
    "Pending disposal of the writ petition, the Petitioner prays that this Hon'ble Court may be pleased to stay the operation of the impugned [order] dated [DATE] (Annexure-__), in the interest of justice.",
    ...ADV_SIGN("PETITIONER", h.place),
    "Note: accompany with index, synopsis, affidavit verifying the petition, annexures with true-copy attestation, vakalatnama and court fee as per the High Court of Karnataka rules. [VERIFY current filing checklist and e-filing requirements]",
  ]);
}

export function writTelanganaDoc(m: M): PMNode {
  const h = courtHeading(m, "hc-telangana");
  const petitioner = { lines: clientParty(m, "[PETITIONER NAME], [S/o / D/o / W/o ___], aged about __ years, Occ: [__], R/o [ADDRESS]"), role: "PETITIONER" };
  const respondents = [
    { lines: "The State of Telangana, rep. by its Principal Secretary, [Municipal Administration & Urban Development Department], Secretariat, Hyderabad", role: "RESPONDENT" },
    { lines: "[RESPONDENT AUTHORITY], rep. by its Commissioner, [ADDRESS], Hyderabad", role: "RESPONDENT" },
  ];
  const number = caseLine(m, "W.P.");
  return buildDoc([
    ...causeTitle(h.lines, "(SPECIAL ORIGINAL JURISDICTION) [VERIFY heading]", number, [petitioner], respondents, ["AFFIDAVIT FILED ON BEHALF OF THE PETITIONER"]),
    "I, [NAME], S/o [__], aged about __ years, Occ: [__], R/o [ADDRESS], do hereby solemnly and sincerely affirm and state on oath as follows:",
    "@legal 1. I am the Petitioner herein and as such I am well acquainted with the facts of the case. I am filing this affidavit in support of the Writ Petition.\n2. [Facts, chronologically, with Material Paper references.]\n3. By proceedings No. [__] dated [DATE], Respondent No. 2 [impugned action]. The said action is illegal, arbitrary and contrary to [Section __ of the ______ Act] [VERIFY] and violative of Articles 14, 21 and 300-A of the Constitution of India.\n4. **Grounds.** (a) [No notice / hearing]; (b) [without authority of law]; (c) [discriminatory]; (d) [further grounds].\n5. The Petitioner has no other effective alternative remedy except to approach this Hon'ble Court under Article 226 of the Constitution of India. The Petitioner has not filed any other writ petition or proceeding on the same cause of action.\n6. **Interim relief.** The Petitioner has a prima facie case and the balance of convenience is in the Petitioner's favour; if the impugned action is not suspended the Petitioner will suffer irreparable loss.",
    "It is therefore prayed that this Hon'ble Court may be pleased to issue a Writ, Order or Direction, more particularly one in the nature of a Writ of Mandamus, declaring the action of Respondent No. 2 in [impugned action] vide proceedings No. [__] dated [DATE] as illegal, arbitrary and violative of Articles 14, 21 and 300-A of the Constitution of India, and consequently set aside the same and direct the Respondents to [consequential direction], and pass such other order or orders as this Hon'ble Court may deem fit and proper in the circumstances of the case.",
    "It is further prayed that pending disposal of the Writ Petition, this Hon'ble Court may be pleased to suspend the proceedings No. [__] dated [DATE] of Respondent No. 2 and pass such other order or orders as this Hon'ble Court may deem fit and proper.",
    `Solemnly and sincerely affirmed and signed his / her name in my presence on this the __ day of ________ 20__ at ${h.place}.\n\n**DEPONENT**\n\n**BEFORE ME**\n\n**ADVOCATE :: HYDERABAD**`,
    "**VERIFICATION**\n\nI, [NAME], the Petitioner herein, do hereby verify that the contents of paragraphs 1 to __ of the affidavit are true and correct to the best of my knowledge, belief and information, and nothing material has been concealed. Hence verified on this the __ day of ________ 20__ at Hyderabad.\n\n**DEPONENT**",
    makePageBreak(),
    ...causeTitle(h.lines, "(SPECIAL ORIGINAL JURISDICTION) [VERIFY heading]", number, [petitioner], respondents, ["WRIT PETITION UNDER ARTICLE 226 OF THE CONSTITUTION OF INDIA"]),
    "For the reasons stated in the accompanying affidavit, the Petitioner prays that this Hon'ble Court may be pleased to issue a Writ, Order or Direction, more particularly one in the nature of a Writ of Mandamus, as prayed in the affidavit, and pass such other order or orders as this Hon'ble Court may deem fit and proper in the circumstances of the case.",
    `Hyderabad\nDate: ${todayIn()}\n\n**COUNSEL FOR THE PETITIONER**`,
    "Note: accompany with the Material Papers (numbered), memo of citations, vakalat and court fee as per the Writ Proceedings Rules of the High Court for the State of Telangana. [VERIFY current rules and e-filing format]",
  ]);
}

// ---------------------------------------------------------------------------
// 6–7. Bail under BNSS
// ---------------------------------------------------------------------------
function crimeLine(): string {
  return "Crime No. [__] of 20__ of [__] Police Station, [CITY], registered for the offences punishable under Sections [__] of the Bharatiya Nyaya Sanhita, 2023 [or, for offences committed before 1 July 2024, Sections [__] of the Indian Penal Code, 1860] [VERIFY: the date of the offence decides the code]";
}

export function regularBailDoc(m: M): PMNode {
  const h = courtHeading(m, "ka-blr-sessions");
  const hcKar = (m?.india?.courtId ?? "ka-blr-sessions") === "hc-karnataka";
  const hcTs = m?.india?.courtId === "hc-telangana";
  const state = h.place === "Hyderabad" || hcTs ? "STATE OF TELANGANA" : "STATE OF KARNATAKA";
  const type = h.hc ? "Crl.P." : "Crl.Misc.";
  return buildDoc([
    ...causeTitle(h.lines, null, caseLine(m, type), [{ lines: `${clientParty(m, "[ACCUSED NAME], S/o [__], aged about __ years, R/o [ADDRESS]", true)} (presently in judicial custody at ${h.place === "Hyderabad" ? "Central Prison, Chanchalguda, Hyderabad" : h.place === "Bengaluru" ? "Central Prison, Parappana Agrahara, Bengaluru" : "[PRISON]"}) [VERIFY]`, role: h.hc ? "PETITIONER" : "PETITIONER / ACCUSED No. __" }], [{ lines: `${state}, by [__] Police Station, represented by the ${h.hc ? (hcKar ? "State Public Prosecutor, High Court Building, Bengaluru – 560 001" : "Public Prosecutor, High Court for the State of Telangana, Hyderabad") : "Public Prosecutor, [COURT COMPLEX]"}`, role: "RESPONDENT" }], [`PETITION UNDER SECTION 483 OF THE BHARATIYA NAGARIK SURAKSHA SANHITA, 2023, PRAYING TO ENLARGE THE PETITIONER ON BAIL IN ${crimeLine().toUpperCase()}`]),
    "The Petitioner above named respectfully submits as follows:",
    `@legal 1. The Petitioner is arrayed as Accused No. [__] in ${crimeLine()}. The Petitioner was arrested on [DATE] and has been in judicial custody since then.\n2. The Petitioner's earlier application for bail in [Crl.Misc. No. __ of 20__] before the [__] Court was rejected by order dated [DATE] [or: this is the first application for bail]. No other bail application is pending before any court.\n3. **Allegations.** The case of the prosecution, in brief, is that [summary of the FIR / charge sheet without admitting it].\n4. **Grounds.** (a) The Petitioner is innocent and has been falsely implicated; (b) the investigation is [complete and the charge sheet has been filed on [DATE]] and the Petitioner's custody is no longer required; (c) the offences are [not punishable with death or imprisonment for life]; (d) the Petitioner has no criminal antecedents; (e) the Petitioner is a permanent resident of [PLACE], has roots in society and is not a flight risk; (f) there is no likelihood of tampering with evidence or influencing witnesses; (g) co-accused [__] has been granted bail by order dated [DATE] and the Petitioner stands on the same footing (parity); (h) the trial is not likely to conclude in the near future; (i) [health / family circumstances].\n5. The Petitioner undertakes to abide by any conditions this Hon'ble Court may impose, including furnishing sureties, appearing before the investigating officer / court as directed, not leaving the jurisdiction without permission and not tampering with the prosecution evidence.`,
    `Authorities (to be checked before citing): ${auth("Satender Kumar Antil v. Central Bureau of Investigation", "(2022) 10 SCC 51")}; [relevant judgment of this Hon'ble High Court] [VERIFY].`,
    "## PRAYER",
    `WHEREFORE, the Petitioner prays that this Hon'ble Court may be pleased to enlarge the Petitioner on bail in ${crimeLine()}, pending on the file of the [__] Court, on such terms and conditions as this Hon'ble Court deems fit, in the interest of justice and equity.`,
    ...ADV_SIGN("PETITIONER", h.place),
    "Enclosures: copy of FIR; copy of remand order(s); [charge sheet]; order on earlier bail application; affidavit / verifying declaration as required by the court. [VERIFY court-specific requirements]",
  ]);
}

export function anticipatoryBailDoc(m: M): PMNode {
  const h = courtHeading(m, "ka-blr-sessions");
  const hcTs = m?.india?.courtId === "hc-telangana";
  const state = h.place === "Hyderabad" || hcTs ? "STATE OF TELANGANA" : "STATE OF KARNATAKA";
  const type = h.hc ? "Crl.P." : "Crl.Misc.";
  return buildDoc([
    ...causeTitle(h.lines, null, caseLine(m, type), [{ lines: clientParty(m, "[PETITIONER NAME], S/o [__], aged about __ years, R/o [ADDRESS]", true), role: "PETITIONER" }], [{ lines: `${state}, by [__] Police Station, represented by the Public Prosecutor`, role: "RESPONDENT" }], [`PETITION UNDER SECTION 482 OF THE BHARATIYA NAGARIK SURAKSHA SANHITA, 2023, PRAYING TO DIRECT THE RELEASE OF THE PETITIONER ON BAIL IN THE EVENT OF ARREST IN ${crimeLine().toUpperCase()}`]),
    "The Petitioner above named respectfully submits as follows:",
    `@legal 1. The Petitioner apprehends arrest in ${crimeLine()}, registered on the complaint of [COMPLAINANT] dated [DATE].\n2. **Allegations.** [Summary of the FIR allegations, without admitting them.]\n3. **Grounds.** (a) The dispute is essentially [civil / commercial] in nature and has been given a criminal colour; (b) the allegations, even if taken at face value, do not disclose [the ingredients of the offence]; (c) the offences alleged are punishable with imprisonment of [__] years; the directions on arrest in ${auth("Arnesh Kumar v. State of Bihar", "(2014) 8 SCC 273")} and Section 35 of the BNSS apply; (d) the Petitioner has no criminal antecedents and has cooperated with the investigation, having [replied to notice dated __]; (e) the Petitioner is a permanent resident of [PLACE] and will not abscond; (f) custodial interrogation is not required as the evidence is documentary.\n4. The Petitioner has not filed any other petition for the same relief before any court [or: the petition before the Sessions Court was rejected on [DATE]].\n5. The Petitioner undertakes to abide by the conditions under Section 482(2) of the BNSS and any other conditions this Hon'ble Court may impose.`,
    `Authorities (to be checked before citing): ${auth("Sushila Aggarwal v. State (NCT of Delhi)", "(2020) 5 SCC 1")}; ${auth("Gurbaksh Singh Sibbia v. State of Punjab", "(1980) 2 SCC 565")}.`,
    "## PRAYER",
    `WHEREFORE, the Petitioner prays that this Hon'ble Court may be pleased to direct that in the event of arrest the Petitioner be released on bail in ${crimeLine()}, on such conditions as this Hon'ble Court deems fit [and grant interim protection pending disposal of this petition], in the interest of justice and equity.`,
    ...ADV_SIGN("PETITIONER", h.place),
  ]);
}

// ---------------------------------------------------------------------------
// 8. Section 138 NI Act: statutory notice and complaint
// ---------------------------------------------------------------------------
export function chequeBounceDoc(m: M): PMNode {
  const h = courtHeading(m, "ka-blr-acmm");
  const payee = m?.client ?? "[COMPLAINANT / PAYEE]";
  return buildDoc([
    "@center **PART A — STATUTORY DEMAND NOTICE UNDER SECTION 138(b) OF THE NEGOTIABLE INSTRUMENTS ACT, 1881**",
    `@right [ADVOCATE NAME]\nAdvocate\n[ADDRESS]\nDate: ${todayIn()}`,
    "**BY REGISTERED POST WITH ACKNOWLEDGEMENT DUE / SPEED POST / COURIER [and email / WhatsApp where agreed]**",
    "To,\n[DRAWER NAME]\n[DESIGNATION, for a company: the company and its Directors in charge of its affairs]\n[ADDRESS]",
    "Sir / Madam,",
    `**Sub:** Dishonour of Cheque No. [__] dated [DATE] for ₹[AMOUNT] drawn on [BANK, BRANCH] — demand for payment under Section 138(b) of the Negotiable Instruments Act, 1881.`,
    `Under instructions from and on behalf of my client, ${payee}, [address] ("my client"), I hereby serve you with the following notice:`,
    "@legal 1. You are liable to pay my client a sum of ₹[AMOUNT] towards [legally enforceable debt / liability: invoices, loan, services]. In discharge of that liability you issued Cheque No. [__] dated [DATE] for ₹[AMOUNT] drawn on [BANK, BRANCH] in favour of my client.\n2. My client presented the cheque for collection through its banker, [BANK, BRANCH], on [DATE]. The cheque was returned unpaid with the memo dated [DATE] with the endorsement \"[Funds Insufficient / Exceeds Arrangement / Payment Stopped by Drawer / Account Closed]\". My client received information of the dishonour on [DATE].\n3. I therefore call upon you to pay my client the said sum of ₹[AMOUNT] (the cheque amount) within fifteen (15) days of receipt of this notice, failing which my client will initiate proceedings against you under Sections 138 and 142 of the Negotiable Instruments Act, 1881, and such other proceedings as are available in law, at your risk as to costs.\n4. A copy of this notice is retained in my office for further action.",
    "Yours faithfully,\n\n**[ADVOCATE NAME]**\nAdvocate for [PAYEE]",
    "Note: the notice must be issued within 30 days of receipt of information of dishonour (Section 138(b)); cause of action arises on expiry of 15 days from receipt of notice without payment; the complaint must be filed within one month of the cause of action (Section 142(1)(b)). [VERIFY dates against postal tracking]",
    makePageBreak(),
    "@center **PART B — COMPLAINT**",
    ...causeTitle(h.lines, null, "P.C.R. / C.C. No. __________ of 20__ [VERIFY registry numbering]", [{ lines: `${payee.toUpperCase()}, [description and address], represented by its [authorised signatory / Power of Attorney holder]`, role: "COMPLAINANT" }], [{ lines: "[DRAWER NAME], [description and address] [for a company, also the Directors in charge and responsible under Section 141]", role: "ACCUSED" }], ["COMPLAINT UNDER SECTION 223 OF THE BHARATIYA NAGARIK SURAKSHA SANHITA, 2023, READ WITH SECTIONS 138 AND 142 OF THE NEGOTIABLE INSTRUMENTS ACT, 1881"]),
    "The Complainant above named respectfully submits as follows:",
    "@legal 1. The Complainant is [description]. The Accused is [description].\n2. **Debt / liability.** [The transaction, the amount due and how it became legally enforceable, with document references.]\n3. **Issue of cheque.** Towards discharge of that liability, the Accused issued Cheque No. [__] dated [DATE] for ₹[AMOUNT] drawn on [BANK, BRANCH] (Document No. 1).\n4. **Dishonour.** The cheque was presented through the Complainant's bank, [BANK, BRANCH, BENGALURU], within its validity and returned unpaid on [DATE] for \"[REASON]\" (return memo, Document No. 2).\n5. **Notice.** The Complainant issued a statutory notice dated [DATE] within 30 days of receipt of information of dishonour (Document No. 3), served on the Accused on [DATE] (postal acknowledgement / tracking report, Documents No. 4 and 5). The Accused has neither paid the amount nor replied [or: replied on [DATE] with untenable contentions].\n6. **Cause of action.** The cause of action arose on [DATE], on expiry of fifteen days from service of the notice. The complaint is filed within one month from that date and is within time under Section 142(1)(b).\n7. **Jurisdiction.** This Hon'ble Court has jurisdiction under Section 142(2)(a) of the Act as the cheque was delivered for collection through the Complainant's account at [BANK, BRANCH], which is within the local limits of this Court.\n8. The Accused has thereby committed an offence punishable under Section 138 of the Negotiable Instruments Act, 1881.",
    "## PRAYER",
    "WHEREFORE, the Complainant prays that this Hon'ble Court may be pleased to take cognizance of the offence punishable under Section 138 of the Negotiable Instruments Act, 1881, issue process to the Accused, try and punish the Accused in accordance with law, and direct payment of compensation under Section 357 of the Code of Criminal Procedure, 1973 / Section 395 of the BNSS [VERIFY] to the Complainant, in the interest of justice.",
    ...ADV_SIGN("COMPLAINANT", h.place),
    "**LIST OF DOCUMENTS**\n\n| No. | Document |\n| --- | --- |\n| 1 | Original cheque |\n| 2 | Bank return memo |\n| 3 | Office copy of the statutory notice |\n| 4 | Postal receipt(s) |\n| 5 | Acknowledgement / tracking report |\n| 6 | [Board resolution / Power of Attorney authorising the signatory] |",
    "Note: the complainant's sworn statement may be filed on affidavit under Section 145 of the Negotiable Instruments Act, 1881. [VERIFY local practice on affidavit evidence at the pre-summoning stage]",
  ]);
}

// ---------------------------------------------------------------------------
// 9. Notice under Section 80 CPC
// ---------------------------------------------------------------------------
export function section80NoticeDoc(m: M): PMNode {
  const client = m?.client ?? "[CLIENT]";
  return buildDoc([
    "@center **NOTICE UNDER SECTION 80 OF THE CODE OF CIVIL PROCEDURE, 1908**",
    `@right [ADVOCATE NAME]\nAdvocate\n[ADDRESS]\nDate: ${todayIn()}`,
    "**BY REGISTERED POST WITH ACKNOWLEDGEMENT DUE**",
    "To,\n1. The [Principal Secretary / Secretary] to the Government of [Karnataka / Telangana], [DEPARTMENT], [Vidhana Soudha, Bengaluru – 560 001 / Telangana Secretariat, Hyderabad]\n2. [PUBLIC OFFICER, designation and office address — where the suit concerns an act done by the officer in official capacity]\n[In a suit against the State Government, notice is delivered to the Secretary to that Government or the Collector of the district (Section 80(1)(c)). [VERIFY addressee]]",
    "Sir,",
    `Under instructions from and on behalf of my client, ${client}, [description and address] ("my client"), I hereby give you notice under Section 80 of the Code of Civil Procedure, 1908 as follows:`,
    "@legal 1. **Name, description and place of residence of the plaintiff:** [__].\n2. **Facts and cause of action:** [set out the facts, the act or omission complained of, dates and the officer / department responsible].\n3. **Relief claimed:** [payment of ₹[AMOUNT] with interest at __% / declaration / injunction / restoration].\n4. My client calls upon you to [grant the relief] within two months of the delivery of this notice, failing which my client will institute a suit against the State of [__] and [the officer] in the competent court for the relief claimed, with costs, without further notice.\n5. [If urgent or immediate relief is required, my client reserves the right to seek leave of the court under Section 80(2) to institute the suit without serving notice or before expiry of the notice period.]",
    "Yours faithfully,\n\n**[ADVOCATE NAME]**\nAdvocate for " + client,
  ]);
}

// ---------------------------------------------------------------------------
// 10. Vakalatnama
// ---------------------------------------------------------------------------
export function vakalatnamaDoc(m: M): PMNode {
  const h = courtHeading(m, "ka-blr-city-civil");
  const n = formatCaseNumber(m?.india?.caseType, m?.india?.caseNumber, m?.india?.caseYear) || "[CASE TYPE] No. __________ of 20__";
  return buildDoc([
    ...h.lines.map((l) => `@center **${l}**`),
    `@center **${n}**`,
    `${m?.client ?? "[CLIENT]"}`,
    "@right **…[PLAINTIFF / PETITIONER / DEFENDANT / RESPONDENT / ACCUSED]**",
    "@center **Versus**",
    "[OPPOSITE PARTY]",
    "@right **…[OPPOSITE PARTY ROLE]**",
    "@center **VAKALATNAMA**",
    `I / We, ${m?.client ?? "[NAME OF CLIENT]"}, [description and address], the [role] in the above case, do hereby appoint and retain:`,
    "@indent [ADVOCATE NAME], Advocate, Enrolment No. [__] [VERIFY enrolment format of the State Bar Council]\n[ADVOCATE NAME], Advocate, Enrolment No. [__]",
    "to appear for me / us in the above case and to conduct and prosecute (or defend) the same and all proceedings that may be taken in respect of any application connected with the same, or any decree or order passed therein, including proceedings in execution, review and taxation; to file and obtain return of documents; to deposit and receive money on my / our behalf; to compromise, withdraw or refer the matter to arbitration or mediation with my / our express instructions; and to engage any other advocate to act with them. I / We agree to ratify all acts done by the aforesaid advocate(s) in pursuance of this authority.",
    `Executed by me / us at ${h.place} on this the __ day of ________ 20__.`,
    "**[SIGNATURE OF CLIENT / AUTHORISED SIGNATORY WITH SEAL]**",
    "Identified by: ______________________",
    "**Accepted:**\n\n[ADVOCATE NAME], Advocate\nEnrolment No. [__]\nAddress for service: [ADDRESS]\n[PHONE] · [EMAIL]",
    "Affix the Advocates' Welfare Fund stamp and any court-fee stamp payable on the vakalatnama as prescribed in the State. [VERIFY stamp values for Karnataka / Telangana]",
  ]);
}

// ---------------------------------------------------------------------------
// 11. Affidavit (with verification)
// ---------------------------------------------------------------------------
export function affidavitDoc(m: M): PMNode {
  const h = courtHeading(m, m?.india?.courtId ?? "ka-blr-city-civil");
  const n = formatCaseNumber(m?.india?.caseType, m?.india?.caseNumber, m?.india?.caseYear) || "[CASE TYPE] No. __________ of 20__";
  return buildDoc([
    ...h.lines.map((l) => `@center **${l}**`),
    `@center **${n}**`,
    `${m?.client ?? "[PARTY]"} … [ROLE]\n**Versus**\n[OPPOSITE PARTY] … [ROLE]`,
    "@center **AFFIDAVIT**",
    "I, [NAME], [S/o / D/o / W/o ___], aged about __ years, [occupation / designation], residing at [ADDRESS], [Aadhaar / ID — only the last four digits, if at all], do hereby solemnly affirm and state on oath as follows:",
    "@legal 1. I am the [party / authorised signatory of the party] in the above case and am well acquainted with the facts. I am competent to swear to this affidavit. [Authority: board resolution dated [DATE] / power of attorney dated [DATE].]\n2. [Fact.]\n3. [Fact, with document reference.]\n4. [Fact.]",
    "**VERIFICATION**\n\nI, the deponent above named, do hereby verify and declare that the contents of paragraphs 1 to __ of this affidavit are true and correct to the best of my knowledge, information and belief, that no part of it is false and that nothing material has been concealed.",
    `Verified at ${h.place} on this the __ day of ________ 20__.\n\n**DEPONENT**\n\nIdentified by me:\n\n**ADVOCATE**\n\nSworn before me:\n\n**[NOTARY / OATH COMMISSIONER]**`,
    "Execute on non-judicial / e-stamp paper where required. [VERIFY stamp duty under the Karnataka Stamp Act, 1957 / Indian Stamp Act, 1899 as applicable in Telangana]",
  ]);
}

// ---------------------------------------------------------------------------
// 12. Memo of appearance
// ---------------------------------------------------------------------------
export function memoOfAppearanceDoc(m: M): PMNode {
  const h = courtHeading(m, m?.india?.courtId ?? "hc-karnataka");
  const n = formatCaseNumber(m?.india?.caseType, m?.india?.caseNumber, m?.india?.caseYear) || "[CASE TYPE] No. __________ of 20__";
  return buildDoc([
    ...h.lines.map((l) => `@center **${l}**`),
    `@center **${n}**`,
    "[PETITIONER / APPELLANT] … [ROLE]\n**Versus**\n[RESPONDENT] … [ROLE]",
    "@center **MEMO OF APPEARANCE**",
    `Please take notice that I / we, the undersigned advocate(s), appear on behalf of ${m?.client ?? "[PARTY]"}, [Respondent No. __ / Caveator], in the above matter. Kindly print my / our name(s) in the cause list and serve all notices and papers on the address given below.`,
    `Place: ${h.place}\nDate: ${todayIn()}`,
    "**[ADVOCATE NAME]**\nAdvocate for [PARTY]\nEnrolment No. [__]\nAddress for service: [ADDRESS]\n[PHONE] · [EMAIL]",
    "To,\nThe Registrar (Judicial), [COURT] [VERIFY addressee and whether vakalat must accompany]",
  ]);
}

export const INDIA_WORD_TEMPLATES: OfficeTemplate[] = [
  { id: "word-in-plaint", kind: "word", name: "Plaint (Order VII CPC) — City Civil Court, Bengaluru", description: "Cause title, parties, facts, cause of action, jurisdiction, valuation and court fee, limitation, prayer, verification and list of documents; Section 12A statement for commercial suits.", category: "Indian courts", practiceArea: "Litigation", tags: ["plaint", "CPC", "Order VII", "Bengaluru", "suit"], build: ({ matterId }) => plaintDoc(matterOf(matterId)) },
  { id: "word-in-written-statement", kind: "word", name: "Written statement (Order VIII CPC)", description: "Preliminary objections, para-wise reply, additional pleas, set-off / counter-claim, prayer and verification.", category: "Indian courts", practiceArea: "Litigation", tags: ["written statement", "CPC", "Order VIII", "defence"], build: ({ matterId }) => writtenStatementDoc(matterOf(matterId)) },
  { id: "word-in-ia-injunction", kind: "word", name: "I.A. for temporary injunction (Order XXXIX Rules 1 & 2)", description: "Interlocutory application with supporting affidavit: prima facie case, balance of convenience, irreparable injury, Rule 3 urgency.", category: "Indian courts", practiceArea: "Litigation", tags: ["injunction", "interlocutory application", "Order XXXIX"], build: ({ matterId }) => injunctionIaDoc(matterOf(matterId)) },
  { id: "word-in-writ-karnataka", kind: "word", name: "Writ petition (Art. 226) — High Court of Karnataka", description: "Memorandum of writ petition with synopsis and list of dates, facts, grounds, prayer and interim prayer.", category: "Indian courts", practiceArea: "Regulatory", tags: ["writ", "Article 226", "Karnataka", "High Court"], build: ({ matterId }) => writKarnatakaDoc(matterOf(matterId)) },
  { id: "word-in-writ-telangana", kind: "word", name: "Writ petition (Art. 226) — High Court for the State of Telangana", description: "Affidavit of the petitioner, verification and the writ petition prayer memo in the Hyderabad format (Writ of Mandamus).", category: "Indian courts", practiceArea: "Regulatory", tags: ["writ", "Article 226", "Telangana", "High Court", "mandamus"], build: ({ matterId }) => writTelanganaDoc(matterOf(matterId)) },
  { id: "word-in-regular-bail", kind: "word", name: "Regular bail application (s.483 BNSS)", description: "Petition to enlarge the accused on bail: custody, allegations, grounds (antecedents, parity, triple test), undertaking and prayer.", category: "Indian courts", practiceArea: "Litigation", tags: ["bail", "BNSS", "s.483", "criminal"], build: ({ matterId }) => regularBailDoc(matterOf(matterId)) },
  { id: "word-in-anticipatory-bail", kind: "word", name: "Anticipatory bail application (s.482 BNSS)", description: "Petition for a direction to release on bail in the event of arrest, with grounds, undertaking and interim protection prayer.", category: "Indian courts", practiceArea: "Litigation", tags: ["anticipatory bail", "BNSS", "s.482", "criminal"], build: ({ matterId }) => anticipatoryBailDoc(matterOf(matterId)) },
  { id: "word-in-ni138", kind: "word", name: "Cheque dishonour: s.138 NI Act notice and complaint", description: "Statutory demand notice under s.138(b) and the complaint under s.223 BNSS read with ss.138 and 142, with the limitation timeline and list of documents.", category: "Indian courts", practiceArea: "Commercial", tags: ["cheque bounce", "NI Act", "s.138", "complaint", "notice"], build: ({ matterId }) => chequeBounceDoc(matterOf(matterId)) },
  { id: "word-in-notice-s80", kind: "word", name: "Legal notice under s.80 CPC", description: "Two-month notice to the Government / public officer before suit: plaintiff's particulars, cause of action and relief claimed.", category: "Indian courts", practiceArea: "Litigation", tags: ["notice", "s.80 CPC", "Government", "pre-suit"], build: ({ matterId }) => section80NoticeDoc(matterOf(matterId)) },
  { id: "word-in-vakalatnama", kind: "word", name: "Vakalatnama", description: "Authority appointing advocates to appear and act, with acceptance and address for service.", category: "Indian courts", practiceArea: "Litigation", tags: ["vakalatnama", "appearance"], build: ({ matterId }) => vakalatnamaDoc(matterOf(matterId)) },
  { id: "word-in-affidavit", kind: "word", name: "Affidavit with verification", description: "Sworn affidavit in numbered paragraphs with verification clause, identification and attestation block.", category: "Indian courts", practiceArea: "Litigation", tags: ["affidavit", "verification"], build: ({ matterId }) => affidavitDoc(matterOf(matterId)) },
  { id: "word-in-memo-appearance", kind: "word", name: "Memo of appearance", description: "Notice of appearance for a respondent or caveator with the address for service.", category: "Indian courts", practiceArea: "Litigation", tags: ["memo", "appearance", "caveat"], build: ({ matterId }) => memoOfAppearanceDoc(matterOf(matterId)) },
];
