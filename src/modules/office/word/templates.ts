import "server-only";
import { db } from "@/lib/db";
import type { Matter } from "@/lib/types/domain";
import type { OfficeTemplate } from "@/modules/office/shared/template-registry";
import { ensureBlockIds, makePageBreak, markdownToBlocks, type PMNode } from "./doc-model";
import { captionBlock, captionFromMatter, certificateOfService, discoveryDefinitions, notaryBlock, signatureBlock, tableOfAuthoritiesPlaceholder, verification, FIRM } from "./sections";

/**
 * Template builder DSL: strings are markdown (multiple blocks allowed) with
 * optional leading directives — "@center", "@right", "@justify", "@caption",
 * "@legal" (numbered list becomes legal 1.1 numbering), "@outline",
 * "@pagebreak", "@indent". PMNode arrays are inserted verbatim.
 */
export type SpecItem = string | PMNode | PMNode[];

export function buildDoc(items: SpecItem[]): PMNode {
  const content: PMNode[] = [];
  for (const item of items) {
    if (typeof item !== "string") { content.push(...(Array.isArray(item) ? item : [item])); continue; }
    let md = item;
    const attrs: Record<string, unknown> = {};
    let listStyle: string | null = null;
    let pb = false;
    while (true) {
      const m = md.match(/^@(center|right|justify|caption|legal|outline|pagebreak|indent|small)\s*/);
      if (!m) break;
      md = md.slice(m[0].length);
      if (m[1] === "center" || m[1] === "right" || m[1] === "justify") attrs.textAlign = m[1];
      else if (m[1] === "caption") attrs.pStyle = "caption";
      else if (m[1] === "indent") attrs.indent = 1;
      else if (m[1] === "legal" || m[1] === "outline") listStyle = m[1];
      else if (m[1] === "pagebreak") pb = true;
    }
    if (pb) { content.push(makePageBreak()); if (!md.trim()) continue; }
    const blocks = markdownToBlocks(md);
    for (const b of blocks) {
      if (Object.keys(attrs).length && (b.type === "paragraph" || b.type === "heading")) b.attrs = { ...(b.attrs ?? {}), ...attrs };
      if (listStyle && b.type === "orderedList") b.attrs = { ...(b.attrs ?? {}), listStyle };
      content.push(b);
    }
  }
  return ensureBlockIds({ type: "doc", content });
}

const today = () => new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
const matterOf = (id?: string): Matter | null => (id ? db().matters.get(id) : null);
const clientOf = (m: Matter | null, fallback = "[CLIENT]") => m?.client ?? fallback;
const partyLabel = (m: Matter | null) => (m ? (m.clientSide === "plaintiff" ? "Plaintiff" : m.clientSide === "defendant" ? "Defendant" : m.clientSide === "buyer" ? "Buyer" : m.clientSide === "seller" ? "Seller" : "Client") : "[PARTY]");

// ---------------------------------------------------------------------------
// 1. Motion and supporting brief
// ---------------------------------------------------------------------------
export function motionBriefDoc(m: Matter | null, title = "Motion and supporting brief"): PMNode {
  const client = clientOf(m, "[CLIENT]");
  const docTitle = `DEFENDANT ${client.toUpperCase()}'S MOTION FOR SUMMARY JUDGMENT AND MEMORANDUM IN SUPPORT`;
  return buildDoc([
    captionBlock(captionFromMatter(m, docTitle)),
    `Defendant ${client} (“${shortName(client)}”), by and through undersigned counsel, respectfully moves this Court pursuant to Federal Rule of Civil Procedure 56 for summary judgment on all claims asserted against it in the [Master/Short-Form] Complaint, and submits this memorandum in support.`,
    "# INTRODUCTION",
    `This motion presents a narrow question: whether Plaintiffs can carry their burden of proving that any [PRODUCT] manufactured by ${shortName(client)} reached the [WATER SYSTEM / SITE] at issue. The undisputed record shows that they cannot. ${shortName(client)} sold [PRODUCT LINE] only to [CUSTOMER CLASS] between [YEAR] and [YEAR], never to the [FACILITY] whose discharges Plaintiffs' own experts identify as the source of the contamination. See [Expert Report of PLAINTIFFS' EXPERT] at [__]; [WITNESS] Dep. [__:__–__:__].`,
    `Because product identification is an essential element of every claim Plaintiffs assert, and because no reasonable jury could find it satisfied on this record, summary judgment should be granted. See [Celotex Corp. v. Catrett, 477 U.S. 317, 322–23 (1986)] [VERIFY]; [Anderson v. Liberty Lobby, Inc., 477 U.S. 242, 248 (1986)] [VERIFY].`,
    "# FACTUAL BACKGROUND",
    "## A. The Parties and the Products",
    `${shortName(client)} is a specialty chemical manufacturer headquartered in [CITY, STATE]. Between [YEAR] and [YEAR] it manufactured [COMPONENT] that third parties incorporated into [FINISHED PRODUCT]. [BATES RANGE] [VERIFY]. ${shortName(client)} did not itself formulate, package, or sell the finished product to [END USERS]. [WITNESS] Dep. [__:__–__:__].`,
    "## B. The Site and the Alleged Exposure Pathway",
    `Plaintiffs allege that [SUBSTANCE] detected at [SITE] migrated from [FACILITY], where [PRODUCT] was used from approximately [YEAR] to [YEAR]. [Compl. ¶¶ __–__]. Plaintiffs' expert, [EXPERT], traces the release to [RELEASE POINT] and concedes that no other source contributes measurably. [Expert] Rep. at [__]; [Expert] Dep. [__:__–__:__].`,
    "## C. The Procurement Record",
    `Procurement records produced by [FACILITY OPERATOR] identify [NUMBER] suppliers for the relevant period: [SUPPLIER 1], [SUPPLIER 2], and [SUPPLIER 3]. [BATES RANGE] [VERIFY]. None of those suppliers purchased [COMPONENT] from ${shortName(client)} during the relevant period. See Declaration of [DECLARANT] ¶¶ [__–__] and Exhibit [__] (sales ledger, [YEARS]).`,
    "# LEGAL STANDARD",
    `Summary judgment is appropriate where “there is no genuine dispute as to any material fact and the movant is entitled to judgment as a matter of law.” Fed. R. Civ. P. 56(a). A dispute is genuine only if “the evidence is such that a reasonable jury could return a verdict for the nonmoving party.” [Anderson, 477 U.S. at 248] [VERIFY]. Where the nonmoving party bears the burden of proof at trial, the movant may discharge its initial burden by pointing to the absence of evidence supporting an essential element of the claim. [Celotex, 477 U.S. at 325] [VERIFY]. The nonmovant must then “set forth specific facts showing that there is a genuine issue for trial,” and may not rest on speculation or conclusory allegations. [Circuit authority] [VERIFY].`,
    `Under the substantive law that governs Plaintiffs' claims, product identification is an essential element of negligence, strict liability, and failure-to-warn theories alike: a plaintiff must prove that the defendant's product, not merely a product of the same type, caused the injury. [Governing state authority] [VERIFY]; see also [coordinated-proceeding order on product identification, if any] [VERIFY].`,
    "# ARGUMENT",
    `## I. Plaintiffs Cannot Prove That Any ${shortName(client)} Product Reached the Site`,
    `Plaintiffs' theory of exposure depends entirely on [PRODUCT] released at [RELEASE POINT]. Their own expert so testified. [Expert] Dep. [__:__–__:__]. The documentary record of what foam was used there is complete and unrebutted: the operator's procurement files, the manufacturer batch records, and the supplier declarations all identify products that contain no ${shortName(client)} [COMPONENT]. [BATES RANGES] [VERIFY].`,
    `Plaintiffs' only response is a market-share inference — that because ${shortName(client)} supplied a meaningful fraction of the national market, some of its product “must have” been present. But [the governing jurisdiction] has rejected market-share liability, and [the governing circuit] has declined to relax product identification in toxic-tort cases. [Authority] [VERIFY]. Speculation about what “must have” happened cannot create a genuine dispute of material fact. [Authority] [VERIFY].`,
    "## II. The Alternative Causation Theory Fails for the Same Reason",
    `To the extent Plaintiffs rely on [ALTERNATIVE PATHWAY] (e.g., [ALTERNATIVE SOURCE]), the record contains no evidence that any such disposal involved ${shortName(client)} product. The single document Plaintiffs cite, [BATES], is a 20[__] internal memorandum discussing industry practices generally; it does not reference the site or any shipment to it. A document that “does not speak to” the disputed fact cannot defeat summary judgment. [Authority] [VERIFY].`,
    "## III. At a Minimum, Partial Summary Judgment Is Warranted on the Failure-to-Warn Claims",
    `Even if a fact issue existed on product identification, the failure-to-warn claims fail independently because the [FACILITY OPERATOR] was a sophisticated purchaser that received the manufacturer's safety data sheets and specifications, and because Plaintiffs identify no warning that would have altered its conduct. [Authority] [VERIFY]; [WITNESS] Dep. [__:__–__:__].`,
    "# CONCLUSION",
    `For the foregoing reasons, ${shortName(client)} respectfully requests that the Court grant summary judgment in its favor on all claims, or in the alternative grant partial summary judgment on the failure-to-warn claims, and award such further relief as the Court deems just.`,
    signatureBlock({ date: today(), forParty: `Defendant ${client}` }),
    makePageBreak(),
    certificateOfService({ date: today(), documentTitle: title }),
  ]);
}

function shortName(client: string) { return client.replace(/,?\s+(Corp\.?|Inc\.?|LLC|L\.L\.C\.|P\.C\.|Ltd\.?|Co\.)$/i, ""); }

// ---------------------------------------------------------------------------
// 2. Research memorandum
// ---------------------------------------------------------------------------
export function researchMemoDoc(m: Matter | null, question = "[QUESTION PRESENTED]"): PMNode {
  return buildDoc([
    `@center **${FIRM.name.toUpperCase()}**`,
    "@center **PRIVILEGED & CONFIDENTIAL — ATTORNEY WORK PRODUCT**",
    "@center # MEMORANDUM",
    `**TO:** [PARTNER]\n**FROM:** [ASSOCIATE]\n**DATE:** ${today()}\n**RE:** ${m ? `${m.shortName} — ` : ""}${question}`,
    "---",
    "# I. QUESTION PRESENTED",
    `Under [GOVERNING LAW], does [LEGAL ISSUE] when [KEY FACTS]?`,
    "# II. BRIEF ANSWER",
    `Probably [yes/no]. [One-paragraph answer stating the rule, applying it to the key facts, and noting the principal uncertainty.]`,
    "# III. FACTS",
    `[Statement of the relevant facts as reflected in the record, with Bates or transcript cites. Identify assumptions and open factual questions.]`,
    "# IV. DISCUSSION",
    "## A. Governing Standard",
    `[Rule statement with authority. Distinguish binding from persuasive authority; note circuit splits.] [VERIFY]`,
    "## B. Application",
    `[Apply the standard to the facts. Address the strongest counter-arguments.] [VERIFY]`,
    "## C. Open Questions and Risks",
    "- [Unresolved factual issue]\n- [Adverse authority to distinguish]\n- [Procedural timing considerations]",
    "# V. RECOMMENDATION",
    `[Recommended course of action and next steps, with owners and dates.]`,
    "# VI. AUTHORITIES CONSULTED",
    "- [Case, reporter cite (court year)] [VERIFY]\n- [Statute / regulation] [VERIFY]\n- [Secondary source]",
  ]);
}

// ---------------------------------------------------------------------------
// 3. Client update letter
// ---------------------------------------------------------------------------
export function clientUpdateLetterDoc(m: Matter | null): PMNode {
  return buildDoc([
    `@right **${FIRM.name}**\n${FIRM.address1}\n${FIRM.address2}\n${FIRM.phone}`,
    today(),
    "**VIA EMAIL — PRIVILEGED & CONFIDENTIAL**",
    `[CLIENT CONTACT]\n[TITLE]\n${clientOf(m)}\n[ADDRESS]`,
    `**Re:** ${m?.name ?? "[MATTER]"}${m?.caption ? `, ${m.caption}` : ""} — Status Update`,
    "Dear [CLIENT CONTACT]:",
    `We write to update you on developments in the above matter since our last report of [DATE], and to identify decisions we will need from you in the coming weeks.`,
    "## Summary",
    "- **Where things stand:** [one sentence]\n- **What happened this period:** [two or three bullets]\n- **What we need from you:** [decision, document, or approval]\n- **Next milestone:** [event and date]",
    "## Recent Developments",
    `[Narrative of the period's key events — rulings, filings, discovery, negotiations — with dates and their practical significance.]`,
    "## Upcoming Deadlines",
    "| Date | Event | Action required |\n| --- | --- | --- |\n| [DATE] | [Event] | [Client / firm action] |\n| [DATE] | [Event] | [Client / firm action] |",
    "## Strategy and Recommendations",
    `[Assessment of risk and options, with our recommendation. Note any change from prior advice and why.]`,
    "## Budget",
    `Fees and costs through [DATE] total $[__], against the [phase] budget of $[__]. We anticipate [__] for the next phase.`,
    `Please contact me with any questions. We appreciate the opportunity to assist ${clientOf(m)} in this matter.`,
    "Sincerely,",
    `\n\n**[ATTORNEY NAME]**\n[TITLE], ${FIRM.name}\n${FIRM.email}`,
    "cc: [Team]",
  ]);
}

// ---------------------------------------------------------------------------
// 4. Engagement letter
// ---------------------------------------------------------------------------
export function engagementLetterDoc(m: Matter | null): PMNode {
  const client = clientOf(m);
  return buildDoc([
    `@right **${FIRM.name}**\n${FIRM.address1}\n${FIRM.address2}`,
    today(),
    "**PRIVILEGED & CONFIDENTIAL**",
    `[CLIENT CONTACT]\n[TITLE]\n${client}\n[ADDRESS]`,
    `**Re:** Engagement of ${FIRM.name} — ${m?.name ?? "[MATTER DESCRIPTION]"}`,
    "Dear [CLIENT CONTACT]:",
    `Thank you for selecting ${FIRM.name} (the “Firm”) to represent ${client} (“you” or the “Client”). This letter confirms the terms of our engagement. Please review it carefully; if it accurately reflects our agreement, sign and return a copy.`,
    "@legal 1. **Scope of Engagement.** The Firm will represent the Client in connection with [DESCRIPTION OF MATTER] (the “Matter”). Our representation is limited to the Matter; we will not advise on other matters, including tax, insurance coverage, or securities issues, unless we agree in writing to expand the scope.\n2. **Staffing.** [RESPONSIBLE ATTORNEY] will have primary responsibility for the Matter, assisted by [ASSOCIATE] and other attorneys, paralegals and professionals as needed. We will staff the Matter efficiently and consult you before adding senior timekeepers.\n3. **Fees.** Our fees are based on time devoted to the Matter at hourly rates, currently $[__] for partners, $[__] for associates, and $[__] for paralegals. Rates are reviewed annually. [Alternative: fixed-fee / phased budget of $[__] as set out in Schedule A.]\n4. **Costs and Expenses.** The Client will reimburse expenses incurred on its behalf, including filing fees, court reporters, expert witnesses, e-discovery processing and hosting, travel, and outside vendors. Expenses over $[__] will be approved in advance.\n5. **Billing and Payment.** We bill monthly with detailed time entries. Invoices are due within 30 days. [Retainer of $[__] to be held in trust and applied to the final invoice.]\n6. **Client Responsibilities.** The Client agrees to cooperate, to provide complete and accurate information, to preserve documents and electronically stored information relevant to the Matter, and to inform us promptly of developments.\n7. **Conflicts of Interest.** We have searched our records and identified no conflict. [Disclose and obtain consent to any waivable conflict.] You agree that the Firm may represent other clients in unrelated matters, including matters adverse to you, provided we do not use your confidential information.\n8. **Confidentiality and Privilege.** Communications between us are privileged. To preserve privilege, limit distribution of our advice to those within the Client who need it, and do not forward it to third parties without consulting us.\n9. **Document Retention.** We will retain the file for [seven] years after the Matter closes, after which it may be destroyed without further notice unless you request its return.\n10. **Termination.** Either party may terminate the engagement on written notice, subject to court approval where required. Termination does not affect the obligation to pay fees and costs incurred through the termination date.\n11. **Conclusion of Representation.** Unless earlier terminated, our representation ends when we send our final invoice for the Matter. Any later advice will be a new engagement.\n12. **Governing Law; Disputes.** This agreement is governed by the law of [STATE]. [Arbitration / mediation clause.]",
    `We look forward to working with you. Please sign below to confirm your agreement.`,
    "Very truly yours,",
    `\n**${FIRM.name}**\n\nBy: ______________________________\n[ATTORNEY NAME], [TITLE]`,
    "**AGREED AND ACCEPTED:**",
    `${client}\n\nBy: ______________________________\nName: [__]\nTitle: [__]\nDate: [__]`,
  ]);
}

// ---------------------------------------------------------------------------
// 5. Mutual NDA
// ---------------------------------------------------------------------------
export function mutualNdaDoc(m: Matter | null): PMNode {
  const a = clientOf(m, "[PARTY A]");
  return buildDoc([
    "@center # MUTUAL NONDISCLOSURE AGREEMENT",
    `This Mutual Nondisclosure Agreement (the “**Agreement**”) is entered into as of [EFFECTIVE DATE] (the “**Effective Date**”) between ${a}, a [STATE] [ENTITY TYPE] with offices at [ADDRESS] (“**${shortName(a)}**”), and [PARTY B], a [STATE] [ENTITY TYPE] with offices at [ADDRESS] (“**Counterparty**”). Each is a “**Party**” and together the “**Parties**.”`,
    "@legal 1. **Purpose.** The Parties wish to exchange certain confidential information in connection with [evaluating a potential business relationship / Project [NAME]] (the “**Purpose**”).\n2. **Definition of Confidential Information.** “**Confidential Information**” means all non-public information disclosed by a Party (“**Discloser**”) to the other (“**Recipient**”), in any form, that is designated confidential or that a reasonable person would understand to be confidential, including business plans, financial information, customer lists, product roadmaps, source code, models, data, and the existence and terms of the Parties' discussions.\n3. **Exclusions.** Confidential Information does not include information that (a) is or becomes publicly available through no fault of Recipient; (b) was rightfully known to Recipient without restriction before disclosure; (c) is rightfully received from a third party without restriction; or (d) is independently developed by Recipient without use of Discloser's Confidential Information, as shown by contemporaneous records.\n4. **Obligations.** Recipient shall (a) use Confidential Information solely for the Purpose; (b) protect it with at least the degree of care it uses for its own confidential information, and no less than reasonable care; (c) restrict access to its employees, officers, directors, advisors and contractors who need to know and are bound by written obligations at least as protective (“**Representatives**”); and (d) be responsible for any breach by its Representatives.\n5. **Compelled Disclosure.** Recipient may disclose Confidential Information to the extent required by law, regulation or court order, provided it gives Discloser prompt notice (where legally permitted), cooperates in seeking protective treatment, and discloses only the portion legally required.\n6. **Term.** This Agreement governs disclosures made during the [two (2)]-year period after the Effective Date. Recipient's obligations survive for [three (3)] years after the last disclosure, except that obligations regarding trade secrets survive for as long as the information remains a trade secret.\n7. **Return or Destruction.** On Discloser's written request or termination of discussions, Recipient shall promptly return or destroy all Confidential Information and certify destruction in writing, except for copies retained in routine backups or as required by law, which remain subject to this Agreement.\n8. **No License; No Obligation.** No license or other right is granted except as expressly stated. Nothing obligates either Party to enter into any further agreement. All Confidential Information is provided “AS IS.”\n9. **Remedies.** Recipient acknowledges that unauthorized disclosure may cause irreparable harm for which damages would be inadequate; Discloser is entitled to seek injunctive relief without posting bond, in addition to other remedies.\n10. **Non-Solicitation.** [Optional: For [12] months, neither Party will solicit for employment any employee of the other with whom it had contact in connection with the Purpose; general advertisements are not solicitation.]\n11. **Governing Law; Venue.** This Agreement is governed by the laws of the State of [STATE] without regard to conflict-of-laws rules. The state and federal courts located in [COUNTY, STATE] have exclusive jurisdiction.\n12. **Miscellaneous.** This Agreement is the entire agreement regarding its subject matter and supersedes prior discussions; it may be amended only in a writing signed by both Parties; neither Party may assign it without consent except to a successor in a merger or sale of substantially all assets; if any provision is unenforceable the remainder continues in effect; it may be executed in counterparts, including by electronic signature.",
    "IN WITNESS WHEREOF, the Parties have executed this Agreement as of the Effective Date.",
    `**${a.toUpperCase()}**\n\nBy: ______________________________\nName: [__]\nTitle: [__]`,
    "**[PARTY B]**\n\nBy: ______________________________\nName: [__]\nTitle: [__]",
  ]);
}

// ---------------------------------------------------------------------------
// 6. Master services agreement
// ---------------------------------------------------------------------------
export function msaDoc(m: Matter | null): PMNode {
  const customer = clientOf(m, "[CUSTOMER]");
  return buildDoc([
    "@center # MASTER SERVICES AGREEMENT",
    `This Master Services Agreement (this “**Agreement**”) is made as of [EFFECTIVE DATE] between ${customer} (“**Customer**”) and [PROVIDER] (“**Provider**”). Customer and Provider are each a “**Party**.”`,
    "## 1. DEFINITIONS",
    "@legal 1. “**Affiliate**” means any entity that controls, is controlled by, or is under common control with a Party.\n2. “**Deliverables**” means all work product Provider delivers under a Statement of Work.\n3. “**Services**” means the services described in a Statement of Work.\n4. “**Statement of Work**” or “**SOW**” means a document executed by both Parties that references this Agreement and describes Services, Deliverables, fees, and schedule.\n5. “**Customer Data**” means all data provided by or on behalf of Customer, and all data derived from it.",
    "## 2. SERVICES AND STATEMENTS OF WORK",
    "@legal 1. Provider shall perform the Services and deliver the Deliverables in accordance with each SOW and this Agreement. Each SOW is incorporated by reference; in a conflict, the SOW controls only as to the specific Services it describes.\n2. Changes to an SOW require a written change order signed by both Parties.\n3. Provider shall perform the Services in a professional and workmanlike manner consistent with industry standards, using qualified personnel.",
    "## 3. FEES AND PAYMENT",
    "@legal 1. Customer shall pay the fees stated in each SOW. Unless the SOW states otherwise, Provider invoices monthly in arrears and Customer pays undisputed amounts within forty-five (45) days of receipt.\n2. Customer may withhold disputed amounts in good faith upon written notice specifying the basis; the Parties shall resolve disputes promptly.\n3. Fees exclude taxes. Customer is responsible for sales, use and similar taxes, excluding taxes on Provider's income.\n4. Expenses are reimbursable only if pre-approved in writing and documented.",
    "## 4. INTELLECTUAL PROPERTY",
    "@legal 1. Deliverables are “works made for hire”; to the extent they are not, Provider assigns to Customer all right, title and interest in the Deliverables upon payment.\n2. Provider retains ownership of its pre-existing tools, methodologies and know-how (“**Provider Materials**”) and grants Customer a perpetual, irrevocable, royalty-free license to use Provider Materials as incorporated in the Deliverables.\n3. Customer Data is Customer's Confidential Information and property; Provider acquires no rights in it except the limited right to process it to perform the Services.",
    "## 5. CONFIDENTIALITY",
    "@legal 1. Each Party shall protect the other's Confidential Information using no less than reasonable care and use it only to perform or receive the Services.\n2. Obligations survive for five (5) years after termination, and indefinitely for trade secrets and Customer Data.",
    "## 6. DATA PROTECTION AND SECURITY",
    "@legal 1. Provider shall maintain an information security program with administrative, technical and physical safeguards appropriate to the sensitivity of Customer Data and no less protective than [SOC 2 Type II / ISO 27001].\n2. Provider shall notify Customer within [48] hours of discovering a security incident affecting Customer Data and cooperate in investigation and remediation.\n3. The Data Processing Addendum attached as Exhibit B applies to personal data.",
    "## 7. WARRANTIES",
    "@legal 1. Each Party warrants it has authority to enter this Agreement.\n2. Provider warrants that (a) the Services will conform to the SOW for [90] days after acceptance; (b) the Deliverables will not infringe any third party's intellectual property; and (c) the Deliverables will not contain malicious code.\n3. EXCEPT AS EXPRESSLY STATED, EACH PARTY DISCLAIMS ALL OTHER WARRANTIES, EXPRESS OR IMPLIED, INCLUDING MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE.",
    "## 8. INDEMNIFICATION",
    "@legal 1. Provider shall defend, indemnify and hold harmless Customer and its Affiliates from third-party claims arising from (a) infringement by the Deliverables; (b) Provider's breach of Sections 5 or 6; or (c) Provider's gross negligence or willful misconduct.\n2. Customer shall defend and indemnify Provider from third-party claims arising from Customer Data as provided to Provider, to the extent not caused by Provider's breach.\n3. The indemnified Party shall give prompt notice, tender control of the defense, and cooperate; the indemnifying Party may not settle without consent if the settlement admits fault or imposes non-monetary obligations.",
    "## 9. LIMITATION OF LIABILITY",
    "@legal 1. EXCEPT FOR EXCLUDED CLAIMS, NEITHER PARTY IS LIABLE FOR INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL OR PUNITIVE DAMAGES, OR LOST PROFITS, EVEN IF ADVISED OF THEIR POSSIBILITY.\n2. EXCEPT FOR EXCLUDED CLAIMS, EACH PARTY'S AGGREGATE LIABILITY IS LIMITED TO THE FEES PAID OR PAYABLE UNDER THE APPLICABLE SOW IN THE TWELVE (12) MONTHS PRECEDING THE CLAIM.\n3. “**Excluded Claims**” means indemnification obligations, breach of Sections 5 or 6, and a Party's gross negligence, fraud or willful misconduct. Liability for breach of Section 6 is capped at [three (3)] times the general cap.",
    "## 10. TERM AND TERMINATION",
    "@legal 1. This Agreement begins on the Effective Date and continues for [three (3)] years, renewing for successive one-year terms unless either Party gives ninety (90) days' notice of non-renewal.\n2. Either Party may terminate this Agreement or any SOW for material breach uncured within thirty (30) days after written notice.\n3. Customer may terminate any SOW for convenience on sixty (60) days' notice, paying for Services performed through the termination date.\n4. On termination, Provider shall deliver all work in progress, return or destroy Customer Data as directed, and provide up to [90] days of transition assistance at the SOW rates.",
    "## 11. GENERAL",
    "@legal 1. **Independent Contractors.** The Parties are independent contractors.\n2. **Subcontractors.** Provider may not subcontract without Customer's written consent and remains responsible for subcontractors.\n3. **Insurance.** Provider shall maintain commercial general liability, professional liability/E&O, and cyber liability insurance of at least $[__] per occurrence.\n4. **Assignment.** Neither Party may assign this Agreement without consent, except to a successor by merger or acquisition of substantially all assets, on notice.\n5. **Notices.** Notices must be in writing to the addresses on the signature page, effective on receipt.\n6. **Governing Law; Venue.** [STATE] law governs; exclusive venue lies in the state and federal courts in [COUNTY, STATE]. The Parties waive jury trial.\n7. **Force Majeure.** Neither Party is liable for delay caused by events beyond its reasonable control, excluding payment obligations.\n8. **Entire Agreement; Amendment; Waiver; Severability; Counterparts.** This Agreement with its SOWs and Exhibits is the entire agreement; amendments must be signed by both Parties; no waiver is implied; unenforceable provisions are severed; counterparts and electronic signatures are effective.",
    "IN WITNESS WHEREOF, the Parties have executed this Agreement as of the Effective Date.",
    `**${customer.toUpperCase()}**\n\nBy: ______________________________\nName: [__]\nTitle: [__]`,
    "**[PROVIDER]**\n\nBy: ______________________________\nName: [__]\nTitle: [__]",
    "@pagebreak",
    "## EXHIBIT A — FORM OF STATEMENT OF WORK",
    "| Item | Description |\n| --- | --- |\n| Services | [__] |\n| Deliverables | [__] |\n| Milestones | [__] |\n| Fees | [__] |\n| Term | [__] |\n| Acceptance criteria | [__] |",
  ]);
}

// ---------------------------------------------------------------------------
// 7. Demand letter
// ---------------------------------------------------------------------------
export function demandLetterDoc(m: Matter | null): PMNode {
  const client = clientOf(m, "[CLIENT]");
  return buildDoc([
    `@right **${FIRM.name}**\n${FIRM.address1}\n${FIRM.address2}\n${FIRM.phone}`,
    today(),
    "**VIA CERTIFIED MAIL AND EMAIL**\n**FOR SETTLEMENT PURPOSES ONLY — FED. R. EVID. 408**",
    "[RECIPIENT]\n[TITLE]\n[COMPANY]\n[ADDRESS]",
    `**Re:** ${client} — Demand for [Payment / Cure / Preservation] under the [AGREEMENT] dated [DATE]`,
    "Dear [RECIPIENT]:",
    `This firm represents ${client} in connection with the [Agreement]. We write to demand that [COMPANY] [cure its breach / pay the amounts owed / cease the conduct described below] no later than **[DATE — 14 days]**.`,
    "## Background",
    `[Concise chronology: the agreement, the obligations at issue with section references, what [COMPANY] did or failed to do, with dates and documents.]`,
    "## Breach",
    `[COMPANY]'s conduct breaches Section [__] of the Agreement, which requires [quote or paraphrase]. [Explain the breach and, if applicable, why notice-and-cure or conditions precedent have been satisfied.]`,
    "## Damages and Demand",
    `As a direct result, ${client} has incurred damages of not less than $[__], consisting of [categories]. Interest continues to accrue at [__]% under Section [__] [or applicable statute]. ${client} demands that [COMPANY], within fourteen (14) days of the date of this letter:`,
    "1. Pay $[__] to ${client} by wire to the account identified in the enclosure;\n2. [Cure / cease conduct];\n3. Confirm in writing that it will comply with Section [__] going forward.",
    "## Preservation of Evidence",
    `[COMPANY] is on notice of a potential claim and must preserve all documents and electronically stored information relating to the Agreement, including email, messaging, and system data of [CUSTODIANS]. Failure to preserve may result in sanctions.`,
    "## Reservation of Rights",
    `Nothing in this letter waives any right or remedy of ${client}, all of which are expressly reserved, including the right to seek consequential damages, attorneys' fees under Section [__], and injunctive relief. If we do not receive a satisfactory response by [DATE], ${client} will pursue all available remedies without further notice.`,
    "Please direct all communications regarding this matter to the undersigned.",
    "Sincerely,",
    `\n\n**[ATTORNEY NAME]**\n${FIRM.name}`,
    `cc: ${client} (via email)`,
  ]);
}

// ---------------------------------------------------------------------------
// 8. Deposition notice
// ---------------------------------------------------------------------------
export function depositionNoticeDoc(m: Matter | null): PMNode {
  const docTitle = "NOTICE OF DEPOSITION OF [DEPONENT]";
  return buildDoc([
    captionBlock(captionFromMatter(m, docTitle)),
    "TO: All counsel of record",
    `PLEASE TAKE NOTICE that, pursuant to Federal Rules of Civil Procedure 26 and 30, ${partyLabel(m)} ${clientOf(m)} will take the deposition upon oral examination of **[DEPONENT]** before a notary public or other officer authorized to administer oaths, at the date, time and place set forth below:`,
    "| | |\n| --- | --- |\n| **Deponent** | [DEPONENT], [TITLE] |\n| **Date and time** | [DATE] at 9:30 a.m. ET |\n| **Location** | [Address or remote platform] |\n| **Method** | Stenographic and videographic recording; realtime feed |\n| **Duration** | One day of seven (7) hours, Fed. R. Civ. P. 30(d)(1) |",
    `The deposition will be recorded by stenographic and audiovisual means and may be used for all purposes permitted by the Federal Rules of Civil Procedure and the Federal Rules of Evidence, including at trial. The deposition will continue from day to day until completed.`,
    `[Optional Rule 30(b)(6): Pursuant to Rule 30(b)(6), [ORGANIZATION] shall designate one or more officers, directors, managing agents or other persons to testify on its behalf regarding the topics set forth in Schedule A. The parties shall confer in good faith about the matters for examination before the deposition, as required by Rule 30(b)(6).]`,
    `The deponent is requested to produce at the deposition the documents described in Schedule B, pursuant to Fed. R. Civ. P. 30(b)(2) and 34.`,
    signatureBlock({ date: today(), forParty: `${partyLabel(m)} ${clientOf(m)}` }),
    "@pagebreak",
    "# SCHEDULE A — TOPICS FOR EXAMINATION",
    "1. [Topic — described with reasonable particularity]\n2. [Topic]\n3. [Topic]",
    "# SCHEDULE B — DOCUMENTS TO BE PRODUCED",
    "1. [Category of documents]\n2. [Category]",
    makePageBreak(),
    certificateOfService({ date: today(), documentTitle: docTitle }),
  ]);
}

// ---------------------------------------------------------------------------
// 9. Interrogatories and requests for production (first set)
// ---------------------------------------------------------------------------
export function interrogatoriesDoc(m: Matter | null): PMNode {
  const docTitle = `${partyLabel(m).toUpperCase()}'S FIRST SET OF INTERROGATORIES AND REQUESTS FOR PRODUCTION OF DOCUMENTS TO [RESPONDING PARTY]`;
  return buildDoc([
    captionBlock(captionFromMatter(m, docTitle)),
    `Pursuant to Federal Rules of Civil Procedure 26, 33 and 34, ${partyLabel(m)} ${clientOf(m)} serves the following interrogatories and requests for production on [RESPONDING PARTY], to be answered separately and fully in writing under oath, and produced, within thirty (30) days of service.`,
    discoveryDefinitions({ requesting: clientOf(m), responding: "[RESPONDING PARTY]" }),
    "# INTERROGATORIES",
    "**INTERROGATORY NO. 1:** Identify each person who participated in preparing Your responses to these interrogatories and, for each, describe the subject matter on which he or she provided information.\n\n**ANSWER:**",
    "**INTERROGATORY NO. 2:** Identify every person with knowledge of [THE SUBJECT MATTER], and for each state the substance of that knowledge.\n\n**ANSWER:**",
    "**INTERROGATORY NO. 3:** Describe in detail the factual basis for Your contention that [CONTENTION], and Identify all Documents that support or refute it.\n\n**ANSWER:**",
    "**INTERROGATORY NO. 4:** Identify every Communication between You and [THIRD PARTY] Concerning [SUBJECT] during the Relevant Period.\n\n**ANSWER:**",
    "**INTERROGATORY NO. 5:** State the total amount of [damages / revenue / units] You claim or received Concerning [SUBJECT], and describe how the figure was calculated.\n\n**ANSWER:**",
    "# REQUESTS FOR PRODUCTION",
    "**REQUEST NO. 1:** All Documents identified in, relied on, or consulted in answering the foregoing interrogatories.\n\n**RESPONSE:**",
    "**REQUEST NO. 2:** All Communications Concerning [SUBJECT] during the Relevant Period, including internal Communications.\n\n**RESPONSE:**",
    "**REQUEST NO. 3:** All contracts, amendments, statements of work and purchase orders between You and [PARTY] Concerning [SUBJECT].\n\n**RESPONSE:**",
    "**REQUEST NO. 4:** Documents sufficient to show Your organizational structure, including reporting lines for [DEPARTMENT], for the Relevant Period.\n\n**RESPONSE:**",
    "**REQUEST NO. 5:** All Documents Concerning Your document retention policies and any litigation hold issued Concerning this action.\n\n**RESPONSE:**",
    "**REQUEST NO. 6:** All insurance policies that may provide coverage for the claims in this action, and all reservation-of-rights or coverage-position letters.\n\n**RESPONSE:**",
    signatureBlock({ date: today(), forParty: `${partyLabel(m)} ${clientOf(m)}` }),
    makePageBreak(),
    "# SCHEDULE A — ESI METADATA FIELDS",
    "| Field | Description |\n| --- | --- |\n| BegBates / EndBates | Production numbers |\n| BegAttach / EndAttach | Family range |\n| Custodian | Custodian(s) from whom collected |\n| From / To / CC / BCC | Email participants |\n| DateSent / DateReceived | Email dates (UTC) |\n| FileName / FileExt | Native file name and extension |\n| MD5Hash | Hash value |\n| NativeLink / TextLink | Paths to native and extracted text |",
    makePageBreak(),
    certificateOfService({ date: today(), documentTitle: docTitle }),
  ]);
}

// ---------------------------------------------------------------------------
// 10. Privilege log cover letter
// ---------------------------------------------------------------------------
export function privilegeLogCoverLetterDoc(m: Matter | null): PMNode {
  return buildDoc([
    `@right **${FIRM.name}**\n${FIRM.address1}\n${FIRM.address2}`,
    today(),
    "**VIA EMAIL**",
    "[OPPOSING COUNSEL]\n[FIRM]\n[ADDRESS]",
    `**Re:** ${m?.name ?? "[MATTER]"}${m?.caption ? `, ${m.caption}` : ""} — ${partyLabel(m)}'s Privilege Log (Volume [__])`,
    "Dear Counsel:",
    `Enclosed please find ${partyLabel(m)} ${clientOf(m)}'s privilege log for documents withheld or redacted from Production Volume(s) [__] (Bates range [PREFIX-0000001] – [PREFIX-0000000]). The log is served pursuant to Fed. R. Civ. P. 26(b)(5)(A) and Paragraph [__] of the [ESI Protocol / Case Management Order No. __].`,
    "## Format and Conventions",
    "- The log is provided in Excel format with the fields agreed in the ESI Protocol: control number, Bates (if redacted), date, document type, author, recipients, CC, privilege basis, and a description sufficient to assess the claim.\n- Attorneys and legal staff are marked with an asterisk (*); a key of names, titles and affiliations is attached as Exhibit A.\n- Email families are logged at the parent level where the entire family is withheld; attachments are logged separately where withheld independently.\n- Entries marked “AC” assert attorney-client privilege; “WP” assert work-product protection under Fed. R. Civ. P. 26(b)(3); “CI” assert the common-interest doctrine. Multiple bases are noted where applicable.",
    "## Categorical Logging",
    `Consistent with Paragraph [__] of the Protocol, communications with outside litigation counsel after [DATE] are logged categorically. ${partyLabel(m)} will provide a document-by-document log for any category on reasonable request.`,
    "## Reservation of Rights",
    `${partyLabel(m)} reserves the right to supplement or amend the log, to claw back inadvertently produced privileged material under Fed. R. Evid. 502(d) and Paragraph [__] of the Protocol, and to assert additional bases for withholding. The production of any document is not a waiver of any privilege or protection as to that or any other document.`,
    "We are available to meet and confer regarding any entry. Please contact me with questions.",
    "Sincerely,",
    `\n\n**[ATTORNEY NAME]**\n${FIRM.name}`,
    "Enclosures: Privilege Log Vol. [__] (xlsx); Exhibit A (Names Key)",
  ]);
}

// ---------------------------------------------------------------------------
// 11. Settlement agreement
// ---------------------------------------------------------------------------
export function settlementAgreementDoc(m: Matter | null): PMNode {
  const client = clientOf(m, "[PARTY A]");
  return buildDoc([
    "@center # CONFIDENTIAL SETTLEMENT AGREEMENT AND MUTUAL RELEASE",
    `This Confidential Settlement Agreement and Mutual Release (the “**Agreement**”) is entered into as of [EFFECTIVE DATE] by and between ${client} (“**${shortName(client)}**”) and [COUNTERPARTY] (“**Counterparty**”) (each a “**Party**,” collectively the “**Parties**”).`,
    "## RECITALS",
    `A. On [DATE], [PLAINTIFF] filed an action captioned ${m?.name ?? "[CAPTION]"}, ${m?.caption ?? "[CASE NO.]"} (the “**Action**”), asserting claims for [CLAIMS].\n\nB. [DEFENDANT] denies the allegations and any liability.\n\nC. The Parties wish to resolve all claims between them without further litigation, without any admission of liability, on the terms set forth below.`,
    "NOW, THEREFORE, in consideration of the mutual promises herein and other good and valuable consideration, the receipt and sufficiency of which are acknowledged, the Parties agree as follows:",
    "@legal 1. **Settlement Payment.** Within [thirty (30)] days after the Effective Date and receipt of a completed IRS Form W-9, [PAYOR] shall pay [PAYEE] the total sum of $[AMOUNT] (the “**Settlement Payment**”) by wire transfer to the trust account of [PAYEE'S COUNSEL]. [Allocation among claim categories, if applicable.]\n2. **Dismissal.** Within [five (5)] business days after receipt of the Settlement Payment, the Parties shall file a stipulation of dismissal of the Action with prejudice under Fed. R. Civ. P. 41(a)(1)(A)(ii), each Party to bear its own fees and costs except as provided herein.\n3. **Mutual Release.** Effective on receipt of the Settlement Payment, each Party, on behalf of itself and its Affiliates, predecessors, successors, assigns, officers, directors, employees, agents and insurers, releases and forever discharges the other Party and its Affiliates, officers, directors, employees, agents, attorneys and insurers from any and all claims, demands, causes of action, damages and liabilities, known or unknown, arising from or relating to the Action or the facts alleged in it, from the beginning of time through the Effective Date (the “**Released Claims**”). Released Claims do not include claims to enforce this Agreement.\n4. **Unknown Claims.** Each Party acknowledges it may discover facts different from those now known and agrees the release extends to unknown claims. [California only: Each Party waives Cal. Civ. Code § 1542, which provides: “A general release does not extend to claims that the creditor or releasing party does not know or suspect to exist in his or her favor at the time of executing the release and that, if known by him or her, would have materially affected his or her settlement with the debtor or released party.”]\n5. **No Admission.** This Agreement is a compromise of disputed claims and is not an admission of liability or wrongdoing by any Party.\n6. **Confidentiality.** The terms of this Agreement, including the amount of the Settlement Payment, are confidential. A Party may disclose them (a) to its attorneys, accountants, insurers and auditors bound by confidentiality; (b) as required by law, regulation or court order; (c) to enforce this Agreement; or (d) in tax filings. In response to inquiries, a Party may state only that “the matter has been resolved.”\n7. **Non-Disparagement.** [Optional: Neither Party shall make statements that disparage the other regarding the subject matter of the Action; truthful testimony compelled by legal process is not a breach.]\n8. **Representations and Warranties.** Each Party represents that it has authority to enter this Agreement; it has not assigned any Released Claim; it has read this Agreement and consulted counsel; and it enters it voluntarily.\n9. **Attorneys' Fees.** Each Party bears its own attorneys' fees and costs. In an action to enforce this Agreement, the prevailing Party is entitled to reasonable attorneys' fees and costs.\n10. **Governing Law; Jurisdiction.** This Agreement is governed by the laws of [STATE]. The Court in the Action retains jurisdiction to enforce it; otherwise exclusive venue lies in [COUNTY, STATE].\n11. **Entire Agreement; Amendment; Severability; Counterparts.** This Agreement is the Parties' entire agreement on its subject matter; it may be amended only in a signed writing; if any provision is unenforceable the remainder continues in effect; it may be executed in counterparts and by electronic signature, each of which is an original.",
    "IN WITNESS WHEREOF, the Parties have executed this Agreement as of the Effective Date.",
    `**${client.toUpperCase()}**\n\nBy: ______________________________\nName: [__]\nTitle: [__]\nDate: [__]`,
    "**[COUNTERPARTY]**\n\nBy: ______________________________\nName: [__]\nTitle: [__]\nDate: [__]",
    "**APPROVED AS TO FORM:**",
    `${FIRM.name}, counsel for ${client}\n\nBy: ______________________________`,
    "[COUNSEL], counsel for [COUNTERPARTY]\n\nBy: ______________________________",
  ]);
}

// ---------------------------------------------------------------------------
// 12. Board minutes
// ---------------------------------------------------------------------------
export function boardMinutesDoc(m: Matter | null): PMNode {
  const company = clientOf(m, "[COMPANY]");
  return buildDoc([
    `@center # MINUTES OF A [REGULAR/SPECIAL] MEETING OF THE BOARD OF DIRECTORS OF ${company.toUpperCase()}`,
    `@center Held on [DATE] at [TIME] [ET] at [LOCATION / by videoconference]`,
    "## Attendance",
    "**Directors present:** [NAMES] (constituting a quorum).\n**Directors absent:** [NAMES].\n**Also present:** [OFFICERS, COUNSEL, ADVISORS] (by invitation).",
    "## Call to Order",
    `[CHAIR] called the meeting to order at [TIME] and acted as chair. [SECRETARY] acted as secretary and recorded the minutes. The chair confirmed that notice had been duly given [or waived] and that a quorum was present.`,
    "## Approval of Prior Minutes",
    "Upon motion duly made and seconded, the minutes of the meeting held on [DATE] were approved as [presented / corrected].",
    "## [Matter Under Consideration — e.g., Proposed Acquisition]",
    `[PRESENTER] presented [SUBJECT], including [summary of materials circulated in advance, key terms, financial analysis, risks and alternatives]. Counsel from ${FIRM.name} reviewed the directors' fiduciary duties in connection with the proposed transaction and the process followed. Discussion ensued, during which the directors asked questions regarding [TOPICS], which were answered by [PRESENTER].`,
    `[Note any director interest disclosed under [STATUTE / BYLAWS] and recusal.]`,
    "Upon motion duly made and seconded, the following resolutions were unanimously adopted [with [NAME] abstaining]:",
    "**RESOLVED**, that the [Agreement and Plan of Merger / Stock Purchase Agreement] substantially in the form presented to the Board (the “**Agreement**”) and the transactions contemplated thereby are hereby approved, adopted and authorized in all respects;",
    "**RESOLVED FURTHER**, that the officers of the Company are authorized and directed, in the name and on behalf of the Company, to execute and deliver the Agreement and all other documents, and to take all other actions, as they deem necessary or advisable to consummate the transactions, such determination to be conclusively evidenced by the taking of such action; and",
    "**RESOLVED FURTHER**, that all actions previously taken by any officer or director of the Company in connection with the foregoing are ratified, confirmed and approved in all respects.",
    "## Other Business",
    "[Report / discussion items with no action taken.]",
    "## Adjournment",
    "There being no further business, upon motion duly made and seconded, the meeting was adjourned at [TIME].",
    "Respectfully submitted,",
    "\n\n______________________________\n[SECRETARY], Secretary",
    "Approved:\n\n______________________________\n[CHAIR], Chair",
  ]);
}

// ---------------------------------------------------------------------------
// 13. Affidavit / declaration (bonus)
// ---------------------------------------------------------------------------
export function declarationDoc(m: Matter | null): PMNode {
  const docTitle = "DECLARATION OF [DECLARANT] IN SUPPORT OF [MOTION]";
  return buildDoc([
    captionBlock(captionFromMatter(m, docTitle)),
    "I, [DECLARANT], declare as follows:",
    "@legal 1. I am [TITLE] of [ORGANIZATION]. I have personal knowledge of the facts stated in this declaration and, if called as a witness, could and would testify competently to them.\n2. I submit this declaration in support of [MOTION]. [State the basis for personal knowledge: role, responsibilities, records reviewed.]\n3. [Fact paragraph with exhibit reference: Attached as Exhibit A is a true and correct copy of [DOCUMENT], Bates-numbered [__].]\n4. [Fact paragraph.]\n5. [Fact paragraph.]",
    verification("[DECLARANT]"),
    notaryBlock(),
  ]);
}

export const WORD_TEMPLATES: OfficeTemplate[] = [
  { id: "word-motion-brief", kind: "word", name: "Motion and supporting brief", description: "Court caption, introduction, factual background, legal standard, argument, conclusion, signature block and certificate of service.", category: "US litigation", practiceArea: "Litigation", tags: ["motion", "brief", "summary judgment"], build: ({ matterId, title }) => motionBriefDoc(matterOf(matterId), title) },
  { id: "word-research-memo", kind: "word", name: "Research memorandum", description: "Question presented, brief answer, facts, discussion, recommendation, authorities.", category: "Internal", tags: ["memo", "research"], build: ({ matterId }) => researchMemoDoc(matterOf(matterId)) },
  { id: "word-client-update", kind: "word", name: "Client update letter", description: "Status letter with summary, developments, deadline table, strategy and budget.", category: "Client", tags: ["letter", "client"], build: ({ matterId }) => clientUpdateLetterDoc(matterOf(matterId)) },
  { id: "word-engagement-letter", kind: "word", name: "Engagement letter", description: "Scope, staffing, fees, costs, conflicts, confidentiality, retention and termination terms.", category: "Client", tags: ["engagement", "letter"], build: ({ matterId }) => engagementLetterDoc(matterOf(matterId)) },
  { id: "word-mutual-nda", kind: "word", name: "Mutual NDA", description: "Two-way confidentiality agreement with standard exclusions, compelled disclosure, term and remedies.", category: "Transactional", practiceArea: "Corporate / M&A", tags: ["NDA", "confidentiality"], build: ({ matterId }) => mutualNdaDoc(matterOf(matterId)) },
  { id: "word-msa", kind: "word", name: "Master services agreement", description: "Numbered clauses: SOWs, fees, IP, confidentiality, data security, warranties, indemnities, limitation of liability, term.", category: "Transactional", practiceArea: "Commercial", tags: ["MSA", "services", "contract"], build: ({ matterId }) => msaDoc(matterOf(matterId)) },
  { id: "word-demand-letter", kind: "word", name: "Demand letter", description: "Rule 408 demand with background, breach, damages, preservation notice and reservation of rights.", category: "US litigation", practiceArea: "Commercial", tags: ["demand", "letter", "pre-suit"], build: ({ matterId }) => demandLetterDoc(matterOf(matterId)) },
  { id: "word-deposition-notice", kind: "word", name: "Deposition notice", description: "Rule 30 notice with logistics table, optional 30(b)(6) topics and document schedule.", category: "US litigation", practiceArea: "Litigation", tags: ["deposition", "discovery", "notice"], build: ({ matterId }) => depositionNoticeDoc(matterOf(matterId)) },
  { id: "word-interrogatories-rfp", kind: "word", name: "First set of interrogatories and RFPs", description: "Definitions, instructions, interrogatories, requests for production, ESI schedule and certificate of service.", category: "US litigation", practiceArea: "Litigation", tags: ["interrogatories", "RFP", "discovery"], build: ({ matterId }) => interrogatoriesDoc(matterOf(matterId)) },
  { id: "word-privilege-log-letter", kind: "word", name: "Privilege log cover letter", description: "Transmittal letter for a Rule 26(b)(5) log with format conventions, categorical logging and 502(d) reservation.", category: "US litigation", practiceArea: "Litigation", tags: ["privilege", "discovery", "letter"], build: ({ matterId }) => privilegeLogCoverLetterDoc(matterOf(matterId)) },
  { id: "word-settlement-agreement", kind: "word", name: "Settlement agreement", description: "Confidential settlement and mutual release with payment, dismissal, unknown-claims waiver and confidentiality.", category: "Litigation", tags: ["settlement", "release"], build: ({ matterId }) => settlementAgreementDoc(matterOf(matterId)) },
  { id: "word-board-minutes", kind: "word", name: "Board minutes", description: "Minutes with attendance, approvals, resolutions and adjournment.", category: "Transactional", practiceArea: "Corporate / M&A", tags: ["minutes", "board", "corporate"], build: ({ matterId }) => boardMinutesDoc(matterOf(matterId)) },
  { id: "word-declaration", kind: "word", name: "Declaration", description: "Captioned declaration with numbered facts, § 1746 verification and notary block.", category: "US litigation", practiceArea: "Litigation", tags: ["declaration", "affidavit"], build: ({ matterId }) => declarationDoc(matterOf(matterId)) },
  { id: "word-blank", kind: "word", name: "Blank document", description: "Empty page with the firm's default styles.", category: "Internal", tags: ["blank"], build: () => buildDoc([""]) },
];

export { tableOfAuthoritiesPlaceholder };
