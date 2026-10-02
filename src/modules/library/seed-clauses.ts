import type { PracticeArea } from "@/lib/types/domain";
import type { ClauseCategory, ClauseStance, ClauseVariable } from "./types";

export interface SeedClause {
  id: string;
  name: string;
  category: ClauseCategory;
  stance: ClauseStance;
  governingLaw?: string;
  practiceArea?: PracticeArea;
  tags: string[];
  description: string;
  variables: ClauseVariable[];
  notes?: string;
  standardId?: string;
  text: string;
  lastReviewedAt: string;
  reviewedBy: string;
  status: "approved" | "draft";
  useCount: number;
  createdAt: string;
  updatedAt: string;
}

const AK = "Aisha Khan";
const DO = "Dhruv Oberoi";
const JW = "Arjun Mehra";
const PR = "Priya Raman";

export const SEED_CLAUSES: SeedClause[] = [
  // -------------------------------------------------------------------------
  // Indemnity
  // -------------------------------------------------------------------------
  {
    id: "lib_clause_indemnity_mutual",
    name: "Mutual indemnification (services agreement)",
    category: "indemnity",
    stance: "neutral",
    practiceArea: "Commercial",
    tags: ["indemnity", "services", "IP infringement", "firm standard"],
    description: "Firm-standard mutual indemnity for services agreements: third-party claims, IP infringement with exclusions, defense procedure and infringement remedies.",
    variables: [
      { name: "Section Number", example: "12" },
      { name: "Party A", description: "The service provider", example: "Bluewater Analytics, Inc." },
      { name: "Party B", description: "The customer", example: "Harborline Technologies, Inc." },
      { name: "Confidentiality Section", example: "9" },
      { name: "Data Security Section", example: "10" },
      { name: "Acceptable Use Section", example: "4.3" },
    ],
    notes: "Standard for services agreements where the client is the customer. Vendor-side redlines usually (1) delete the gross-negligence prong in (a)(ii) and (2) add a 'sole and exclusive remedy' sentence to (e). Resist deleting (a)(i): it is the only route to indemnified data-breach losses under the cap carve-out. Pair with the fees-paid cap (limitation of liability) so 'Excluded Claims' cross-references line up.",
    lastReviewedAt: "2026-08-12",
    reviewedBy: DO,
    status: "approved",
    useCount: 41,
    createdAt: "2024-03-04T14:00:00Z",
    updatedAt: "2026-08-12T16:20:00Z",
    text: `**{{Section Number}}. Indemnification.**

(a) *By {{Party A}}.* {{Party A}} shall defend, indemnify and hold harmless {{Party B}} and its affiliates, and their respective officers, directors, employees and agents (the "{{Party B}} Indemnitees"), from and against any and all losses, damages, liabilities, judgments, settlements, costs and expenses (including reasonable attorneys' fees and costs of investigation) ("Losses") arising out of or relating to any third-party claim, suit or proceeding (a "Claim") to the extent caused by (i) {{Party A}}'s breach of Section {{Confidentiality Section}} (Confidentiality) or Section {{Data Security Section}} (Data Security); (ii) the gross negligence or willful misconduct of {{Party A}} or its personnel in performing the Services; or (iii) any allegation that the Services or Deliverables, as delivered by {{Party A}} and used in accordance with this Agreement, infringe or misappropriate any patent, copyright, trademark or trade secret of a third party (an "Infringement Claim").

(b) *By {{Party B}}.* {{Party B}} shall defend, indemnify and hold harmless {{Party A}} and its affiliates, and their respective officers, directors, employees and agents, from and against any and all Losses arising out of or relating to any Claim to the extent caused by (i) {{Party B}}'s breach of Section {{Confidentiality Section}}; (ii) the gross negligence or willful misconduct of {{Party B}} or its personnel; or (iii) {{Party B}}'s use of the Services in violation of applicable law or of Section {{Acceptable Use Section}} (Acceptable Use).

(c) *Exclusions.* {{Party A}} shall have no obligation under Section (a)(iii) to the extent an Infringement Claim arises from (i) modifications to the Services or Deliverables made by or for {{Party B}} other than by {{Party A}}; (ii) the combination of the Services or Deliverables with products, data or processes not supplied by {{Party A}}, where the Claim would not have arisen but for the combination; (iii) {{Party B}}'s continued use of an allegedly infringing version after {{Party A}} has made available a non-infringing alternative at no additional cost; or (iv) {{Party B}} Materials or written specifications furnished by {{Party B}}.

(d) *Procedure.* The indemnified party shall (i) give the indemnifying party prompt written notice of the Claim, provided that failure to do so shall relieve the indemnifying party of its obligations only to the extent it is materially prejudiced by the delay; (ii) tender to the indemnifying party sole control of the defense and settlement of the Claim, except that the indemnifying party shall not settle any Claim in a manner that admits fault on behalf of, or imposes non-monetary obligations on, the indemnified party without its prior written consent, which shall not be unreasonably withheld, conditioned or delayed; and (iii) provide reasonable cooperation, at the indemnifying party's expense, in the defense of the Claim. The indemnified party may participate in the defense with counsel of its own choosing at its own expense.

(e) *Remedies for Infringement.* If the Services or Deliverables become, or in {{Party A}}'s reasonable opinion are likely to become, the subject of an Infringement Claim, {{Party A}} may, at its option and expense, (i) procure for {{Party B}} the right to continue using the affected Services or Deliverables; (ii) modify or replace them so that they are non-infringing without material loss of functionality; or, if neither (i) nor (ii) is commercially reasonable, (iii) terminate the affected Services and refund any prepaid fees for the unexpired portion of the then-current term. This Section (e), together with Section (a)(iii), states {{Party A}}'s entire liability, and {{Party B}}'s exclusive remedy, for Infringement Claims.`,
  },
  {
    id: "lib_clause_indemnity_ip_vendor",
    name: "IP infringement indemnity (vendor paper)",
    category: "indemnity",
    stance: "pro-counterparty",
    practiceArea: "Commercial",
    tags: ["indemnity", "IP infringement", "vendor form", "SaaS"],
    description: "Typical vendor-paper IP indemnity with broad exclusions and a 'sole and exclusive remedy' sentence. Kept for comparison against the firm standard.",
    standardId: "lib_clause_indemnity_mutual",
    variables: [
      { name: "Section Number", example: "11" },
      { name: "Vendor", example: "Snowfield Systems, Inc." },
      { name: "Customer", example: "Bluewater Analytics, Inc." },
      { name: "Cap Section", example: "12" },
    ],
    notes: "Seen in the Snowfield reseller agreement (Project Harbor data room 4.2). When our client is the customer, push for: (1) deletion of the 'sole and exclusive remedy' sentence or at least a carve-out for damages; (2) exclusions limited to modifications 'not authorized in writing by Vendor'; (3) no cap on the IP indemnity. Compare to standard before accepting.",
    lastReviewedAt: "2026-09-02",
    reviewedBy: DO,
    status: "approved",
    useCount: 7,
    createdAt: "2025-11-18T10:00:00Z",
    updatedAt: "2026-09-02T09:15:00Z",
    text: `**{{Section Number}}. Infringement Indemnity.** {{Vendor}} will defend {{Customer}} against any claim by an unaffiliated third party alleging that the Service, as provided by {{Vendor}} and used by {{Customer}} in accordance with the Documentation, infringes a United States patent issued as of the Effective Date or a copyright or trademark, and will pay any damages finally awarded by a court of competent jurisdiction or agreed in a settlement approved in writing by {{Vendor}}. {{Vendor}} shall have no obligation with respect to any claim arising from (a) use of the Service in combination with any hardware, software, data or process not provided by {{Vendor}}; (b) any modification of the Service not made by {{Vendor}}; (c) use of a superseded release after {{Vendor}} has made a current release available; (d) Customer Data or Customer's specifications; or (e) use of the Service other than in accordance with this Agreement and the Documentation. If the Service is, or {{Vendor}} believes it may be, held to infringe, {{Vendor}} may at its sole option (i) obtain the right for {{Customer}} to continue use, (ii) modify or replace the Service, or (iii) terminate the subscription and refund unused prepaid fees. THIS SECTION STATES {{VENDOR}}'S SOLE LIABILITY AND {{CUSTOMER}}'S SOLE AND EXCLUSIVE REMEDY FOR ANY ACTUAL OR ALLEGED INFRINGEMENT, AND IS SUBJECT TO SECTION {{Cap Section}}.`,
  },

  // -------------------------------------------------------------------------
  // Limitation of liability
  // -------------------------------------------------------------------------
  {
    id: "lib_clause_lol_cap",
    name: "Limitation of liability — fees-paid cap with carve-outs and super-cap",
    category: "limitation of liability",
    stance: "neutral",
    practiceArea: "Commercial",
    tags: ["limitation of liability", "cap", "super-cap", "data security", "firm standard"],
    description: "Firm-standard limitation of liability: mutual consequential-damages exclusion, fees-paid cap with a floor, data-security super-cap, defined Excluded Claims and a basis-of-the-bargain sentence.",
    variables: [
      { name: "Section Number", example: "13" },
      { name: "Customer", example: "Harborline Technologies, Inc." },
      { name: "Provider", example: "Bluewater Analytics, Inc." },
      { name: "Look-back Period", example: "twelve (12) months" },
      { name: "Minimum Cap Amount", example: "$1,000,000" },
      { name: "Data Security Section", example: "10" },
      { name: "Super-Cap Multiple", example: "three (3)" },
      { name: "Indemnification Section", example: "12" },
      { name: "Confidentiality Section", example: "9" },
    ],
    notes: "Keep the exclusion (a) and the cap (b) in separate subsections so a court can sever one without the other. Sentence (e) ('notwithstanding the failure of essential purpose') matters in Illinois and the Seventh Circuit — see Knowledge → Seventh Circuit consequential damages waiver notes. If the counterparty resists the super-cap, fall back to a flat dollar super-cap rather than deleting (c).",
    lastReviewedAt: "2026-08-12",
    reviewedBy: DO,
    status: "approved",
    useCount: 38,
    createdAt: "2024-03-04T14:10:00Z",
    updatedAt: "2026-08-12T16:25:00Z",
    text: `**{{Section Number}}. Limitation of Liability.**

(a) *Exclusion of Consequential Damages.* EXCEPT FOR EXCLUDED CLAIMS, IN NO EVENT SHALL EITHER PARTY BE LIABLE TO THE OTHER FOR ANY INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, PUNITIVE OR CONSEQUENTIAL DAMAGES, OR FOR ANY LOSS OF PROFITS, REVENUE, BUSINESS, GOODWILL OR DATA, ARISING OUT OF OR RELATING TO THIS AGREEMENT, HOWEVER CAUSED AND UNDER ANY THEORY OF LIABILITY (INCLUDING CONTRACT, TORT, NEGLIGENCE AND STRICT LIABILITY), EVEN IF THE PARTY HAS BEEN ADVISED OF THE POSSIBILITY OF SUCH DAMAGES.

(b) *Cap.* EXCEPT FOR EXCLUDED CLAIMS, EACH PARTY'S TOTAL CUMULATIVE LIABILITY ARISING OUT OF OR RELATING TO THIS AGREEMENT SHALL NOT EXCEED THE GREATER OF (i) THE FEES PAID OR PAYABLE BY {{Customer}} TO {{Provider}} UNDER THIS AGREEMENT IN THE {{Look-back Period}} IMMEDIATELY PRECEDING THE EVENT GIVING RISE TO THE CLAIM AND (ii) {{Minimum Cap Amount}}.

(c) *Super-Cap.* NOTWITHSTANDING SECTION (b), {{Provider}}'S TOTAL CUMULATIVE LIABILITY FOR LOSSES ARISING FROM A BREACH OF SECTION {{Data Security Section}} (DATA SECURITY) OR FROM A SECURITY INCIDENT AFFECTING {{Customer}} DATA SHALL NOT EXCEED {{Super-Cap Multiple}} TIMES THE AMOUNT DETERMINED UNDER SECTION (b).

(d) *Excluded Claims.* "Excluded Claims" means (i) a party's indemnification obligations under Section {{Indemnification Section}}; (ii) a party's breach of Section {{Confidentiality Section}} (Confidentiality), other than Losses arising from a Security Incident, which are subject to Section (c); (iii) Losses arising from a party's gross negligence, willful misconduct or fraud; (iv) {{Customer}}'s obligation to pay fees due under this Agreement; and (v) a party's infringement or misappropriation of the other party's intellectual property rights.

(e) *Basis of the Bargain.* The parties agree that the limitations in this Section {{Section Number}} are an essential basis of the bargain between them, that the fees reflect this allocation of risk, and that these limitations shall apply notwithstanding the failure of essential purpose of any limited remedy provided in this Agreement.`,
  },
  {
    id: "lib_clause_lol_consequential_transport",
    name: "Consequential damages waiver (transportation services, cargo carve-out)",
    category: "limitation of liability",
    stance: "pro-client",
    governingLaw: "Illinois",
    practiceArea: "Commercial",
    tags: ["consequential damages", "transportation", "cargo", "Northgate", "UCC 2-719"],
    description: "Mutual consequential-damages waiver for a master transportation services agreement, with express carve-outs so cargo loss and indemnified third-party claims remain recoverable as direct damages.",
    variables: [
      { name: "Section Number", example: "14.2" },
      { name: "Carrier", example: "Apex Freight Systems, LLC" },
      { name: "Shipper", example: "Northgate Logistics, Inc." },
      { name: "Cargo Liability Section", example: "8.4" },
      { name: "Indemnification Section", example: "13" },
      { name: "Rate Schedule", example: "Schedule B" },
    ],
    notes: "Drafted after the Northgate v. Apex dispute. Apex argues the MTSA waiver bars Northgate's lost-customer damages; our position is that the Joliet cross-dock losses are direct damages under the cargo-liability carve-out. When drafting for a shipper client, define cargo loss as direct damages expressly (carve-out (a)) and add the reliance sentence so the waiver reads as negotiated between sophisticated parties.",
    lastReviewedAt: "2026-09-10",
    reviewedBy: DO,
    status: "approved",
    useCount: 5,
    createdAt: "2026-03-02T11:00:00Z",
    updatedAt: "2026-09-10T17:40:00Z",
    text: `**{{Section Number}}. Waiver of Consequential Damages.** NEITHER PARTY SHALL BE LIABLE TO THE OTHER, WHETHER IN CONTRACT, TORT (INCLUDING NEGLIGENCE), STRICT LIABILITY OR OTHERWISE, FOR ANY CONSEQUENTIAL, INCIDENTAL, INDIRECT, SPECIAL OR PUNITIVE DAMAGES, INCLUDING LOSS OF PROFITS, LOSS OF USE, LOSS OF BUSINESS OPPORTUNITY OR COST OF SUBSTITUTE SERVICES, ARISING OUT OF OR RELATING TO THIS AGREEMENT OR THE SERVICES, EVEN IF THE PARTY HAS BEEN ADVISED OF THE POSSIBILITY OF SUCH DAMAGES; PROVIDED, HOWEVER, THAT THIS SECTION SHALL NOT LIMIT (a) {{Carrier}}'S LIABILITY FOR LOSS OF, DAMAGE TO, OR DELAY IN DELIVERY OF CARGO, WHICH THE PARTIES AGREE CONSTITUTES DIRECT DAMAGES AND SHALL BE DETERMINED IN ACCORDANCE WITH SECTION {{Cargo Liability Section}}; (b) EITHER PARTY'S OBLIGATIONS TO INDEMNIFY THE OTHER AGAINST THIRD-PARTY CLAIMS UNDER SECTION {{Indemnification Section}}; (c) DAMAGES ARISING FROM A PARTY'S GROSS NEGLIGENCE, WILLFUL MISCONDUCT OR FRAUD; OR (d) {{Shipper}}'S OBLIGATION TO PAY UNDISPUTED CHARGES. THE PARTIES ACKNOWLEDGE THAT THEY ARE SOPHISTICATED COMMERCIAL ENTITIES REPRESENTED BY COUNSEL, THAT THE RATES SET FORTH IN {{Rate Schedule}} WERE NEGOTIATED IN RELIANCE ON THIS ALLOCATION OF RISK, AND THAT THIS SECTION SHALL BE ENFORCED NOTWITHSTANDING THE FAILURE OF ESSENTIAL PURPOSE OF ANY EXCLUSIVE REMEDY.`,
  },

  // -------------------------------------------------------------------------
  // Confidentiality
  // -------------------------------------------------------------------------
  {
    id: "lib_clause_confidentiality_mutual",
    name: "Mutual confidentiality with standard exclusions",
    category: "confidentiality",
    stance: "neutral",
    practiceArea: "Corporate / M&A",
    tags: ["confidentiality", "NDA", "trade secrets", "firm standard"],
    description: "Two-way confidentiality covenant: definition, exclusions, permitted disclosures to representatives, standard of care, term and return/destruction, with a DTSA whistleblower notice.",
    variables: [
      { name: "Section Number", example: "9" },
      { name: "Disclosing Party", example: "either party" },
      { name: "Receiving Party", example: "the other party" },
      { name: "Confidentiality Term", example: "five (5) years after the termination or expiration of this Agreement" },
      { name: "Purpose", example: "evaluating and performing the transactions contemplated by this Agreement" },
    ],
    notes: "Trade-secret carve-out in (e) keeps protection alive for as long as the information remains a trade secret; some counterparties want a fixed term for everything — accept only for non-technical commercial terms. The DTSA notice in (g) is required to preserve exemplary damages and fees against employees and contractors (18 U.S.C. § 1833(b)).",
    lastReviewedAt: "2026-07-01",
    reviewedBy: AK,
    status: "approved",
    useCount: 63,
    createdAt: "2024-01-10T09:00:00Z",
    updatedAt: "2026-07-01T13:00:00Z",
    text: `**{{Section Number}}. Confidentiality.**

(a) *Definition.* "Confidential Information" means all non-public information disclosed by {{Disclosing Party}} to {{Receiving Party}}, whether before or after the Effective Date and in any form, that is designated as confidential or that a reasonable person would understand to be confidential given the nature of the information and the circumstances of disclosure, including business plans, financial information, customer and supplier lists, pricing, product roadmaps, source code, models, data, and the terms of this Agreement.

(b) *Exclusions.* Confidential Information does not include information that {{Receiving Party}} can demonstrate by contemporaneous written records (i) was publicly available at the time of disclosure or thereafter became publicly available through no fault of {{Receiving Party}}; (ii) was rightfully known to {{Receiving Party}} without restriction before receipt from {{Disclosing Party}}; (iii) was rightfully received from a third party without a duty of confidentiality; or (iv) was independently developed by {{Receiving Party}} without use of or reference to the Confidential Information.

(c) *Obligations.* {{Receiving Party}} shall (i) use Confidential Information solely for the purpose of {{Purpose}}; (ii) not disclose Confidential Information to any person other than its and its affiliates' employees, officers, directors, financing sources, and professional advisors who need to know it for that purpose and are bound by confidentiality obligations no less protective than these ("Representatives"); and (iii) protect Confidential Information using at least the degree of care it uses to protect its own confidential information of like importance, and no less than reasonable care. {{Receiving Party}} is responsible for any breach of this Section by its Representatives.

(d) *Compelled Disclosure.* {{Receiving Party}} may disclose Confidential Information to the extent required by law, regulation, subpoena or court order, provided that it gives {{Disclosing Party}} prompt written notice (where legally permitted), cooperates with any effort to obtain a protective order at {{Disclosing Party}}'s expense, and discloses only the portion legally required.

(e) *Term.* The obligations in this Section survive for {{Confidentiality Term}}; provided that obligations with respect to any Confidential Information that constitutes a trade secret under applicable law survive for so long as that information remains a trade secret.

(f) *Return or Destruction.* Upon {{Disclosing Party}}'s written request, {{Receiving Party}} shall promptly return or destroy all Confidential Information in its possession and certify destruction in writing, except that {{Receiving Party}} may retain one archival copy solely for compliance purposes and copies in automatic backup systems, in each case subject to this Section for so long as retained.

(g) *Whistleblower Notice.* Pursuant to 18 U.S.C. § 1833(b), an individual shall not be held criminally or civilly liable under any federal or state trade secret law for the disclosure of a trade secret that is made (i) in confidence to a federal, state or local government official, or to an attorney, solely for the purpose of reporting or investigating a suspected violation of law, or (ii) in a complaint or other document filed in a lawsuit or other proceeding, if such filing is made under seal.

(h) *Equitable Relief.* Each party acknowledges that a breach of this Section may cause irreparable harm for which monetary damages would be an inadequate remedy, and agrees that the other party is entitled to seek injunctive relief without the posting of a bond, in addition to any other remedy available at law or in equity.`,
  },
  {
    id: "lib_clause_confidentiality_compelled",
    name: "Compelled disclosure and litigation-hold interface",
    category: "confidentiality",
    stance: "pro-client",
    practiceArea: "Litigation",
    tags: ["confidentiality", "subpoena", "litigation hold", "protective order"],
    description: "Stand-alone compelled-disclosure procedure used when the standard NDA language is too thin for a client that is a frequent litigation target: notice, protective-order cooperation, cost allocation, and preservation-order coexistence.",
    standardId: "lib_clause_confidentiality_mutual",
    variables: [
      { name: "Section Number", example: "9.4" },
      { name: "Receiving Party", example: "Recipient" },
      { name: "Disclosing Party", example: "Meridian Fine Chemicals Ltd." },
      { name: "Notice Period", example: "ten (10) business days" },
    ],
    notes: "Use for Meridian and other clients under active preservation orders. Subsection (c) prevents a counterparty from arguing that destruction obligations under the NDA conflict with a court-ordered litigation hold.",
    lastReviewedAt: "2026-05-20",
    reviewedBy: JW,
    status: "approved",
    useCount: 9,
    createdAt: "2025-02-11T15:00:00Z",
    updatedAt: "2026-05-20T10:10:00Z",
    text: `**{{Section Number}}. Compelled Disclosure.**

(a) If {{Receiving Party}} or any of its Representatives is requested or required by law, regulation, deposition, interrogatory, request for documents, subpoena, civil investigative demand or similar process to disclose any Confidential Information, {{Receiving Party}} shall, to the extent legally permitted, provide {{Disclosing Party}} with prompt written notice, and in any event no later than {{Notice Period}} before the disclosure is due, so that {{Disclosing Party}} may seek a protective order or other appropriate remedy.

(b) {{Receiving Party}} shall reasonably cooperate, at {{Disclosing Party}}'s expense, with {{Disclosing Party}}'s efforts to obtain such an order, and shall not oppose any such effort. If no protective order is obtained, {{Receiving Party}} shall disclose only that portion of the Confidential Information that its counsel advises is legally required, shall use reasonable efforts to obtain confidential treatment for any Confidential Information so disclosed, and shall furnish {{Disclosing Party}} with a copy of the disclosure.

(c) Nothing in this Agreement requires {{Receiving Party}} to destroy or return Confidential Information that it is required to preserve under a litigation hold, preservation order, or court order, provided that such information remains subject to this Section for so long as it is retained and is used for no purpose other than compliance with the applicable obligation.

(d) Disclosure made in compliance with this Section shall not constitute a breach of this Agreement.`,
  },

  // -------------------------------------------------------------------------
  // Choice of law / forum
  // -------------------------------------------------------------------------
  {
    id: "lib_clause_law_forum_delaware",
    name: "Governing law, exclusive forum and jury waiver (Delaware)",
    category: "choice of law / forum",
    stance: "neutral",
    governingLaw: "Delaware",
    practiceArea: "Corporate / M&A",
    tags: ["governing law", "forum selection", "jury waiver", "Delaware", "M&A"],
    description: "Delaware governing law without renvoi, exclusive Court of Chancery / District of Delaware forum, consent to service, and a conspicuous jury-trial waiver.",
    variables: [
      { name: "Section Number", example: "11.7" },
      { name: "Agreement Name", example: "this Agreement" },
    ],
    notes: "Chancery-first structure with a federal fallback for subject-matter jurisdiction. Jury waiver must be conspicuous (bold caps) — keep the formatting when pasting into a document.",
    lastReviewedAt: "2026-06-15",
    reviewedBy: DO,
    status: "approved",
    useCount: 27,
    createdAt: "2024-05-22T09:30:00Z",
    updatedAt: "2026-06-15T12:00:00Z",
    text: `**{{Section Number}}. Governing Law; Forum; Waiver of Jury Trial.**

(a) *Governing Law.* {{Agreement Name}}, and all claims or causes of action (whether in contract, tort or otherwise) that may be based upon, arise out of or relate to {{Agreement Name}} or the negotiation, execution or performance hereof, shall be governed by and construed in accordance with the laws of the State of Delaware, without giving effect to any choice-of-law or conflict-of-laws rules or provisions (whether of the State of Delaware or any other jurisdiction) that would cause the application of the laws of any jurisdiction other than the State of Delaware.

(b) *Exclusive Forum.* Each party irrevocably and unconditionally (i) submits, for itself and its property, to the exclusive jurisdiction of the Court of Chancery of the State of Delaware or, if that court lacks subject-matter jurisdiction, the United States District Court for the District of Delaware or, if that court also lacks subject-matter jurisdiction, the Superior Court of the State of Delaware, in any action arising out of or relating to {{Agreement Name}}; (ii) agrees that all claims in any such action shall be heard and determined exclusively in such courts; (iii) waives any objection to the laying of venue in, and any claim of inconvenient forum with respect to, such courts; and (iv) agrees that a final judgment in any such action shall be conclusive and may be enforced in other jurisdictions by suit on the judgment or in any other manner provided by law.

(c) *Service of Process.* Each party consents to service of process in any such action by registered or certified mail, return receipt requested, or by nationally recognized overnight courier, to its address for notices under {{Agreement Name}}, and agrees that such service shall constitute good and sufficient service of process and notice thereof. Nothing in this Section shall affect the right of any party to serve process in any other manner permitted by law.

(d) *WAIVER OF JURY TRIAL.* **EACH PARTY HEREBY IRREVOCABLY AND UNCONDITIONALLY WAIVES, TO THE FULLEST EXTENT PERMITTED BY APPLICABLE LAW, ANY RIGHT IT MAY HAVE TO A TRIAL BY JURY IN ANY ACTION, PROCEEDING OR COUNTERCLAIM DIRECTLY OR INDIRECTLY ARISING OUT OF OR RELATING TO {{Agreement Name}} OR THE TRANSACTIONS CONTEMPLATED HEREBY. EACH PARTY CERTIFIES THAT NO REPRESENTATIVE OF THE OTHER PARTY HAS REPRESENTED THAT SUCH OTHER PARTY WOULD NOT SEEK TO ENFORCE THIS WAIVER, AND ACKNOWLEDGES THAT IT HAS BEEN INDUCED TO ENTER INTO {{Agreement Name}} BY, AMONG OTHER THINGS, THE MUTUAL WAIVERS AND CERTIFICATIONS IN THIS SECTION.**`,
  },
  {
    id: "lib_clause_law_forum_illinois",
    name: "Governing law and forum (Illinois / N.D. Ill.)",
    category: "choice of law / forum",
    stance: "pro-client",
    governingLaw: "Illinois",
    practiceArea: "Commercial",
    tags: ["governing law", "forum selection", "Illinois", "N.D. Ill.", "commercial"],
    description: "Illinois governing law with an exclusive Northern District of Illinois / Cook County forum and a carve-out allowing injunctive relief anywhere.",
    variables: [
      { name: "Section Number", example: "15.3" },
      { name: "Agreement Name", example: "this Master Transportation Services Agreement" },
    ],
    notes: "Used in the Northgate master transportation services agreement. The injunctive-relief carve-out in (c) lets a shipper client enforce a preservation or return-of-goods obligation where the goods sit.",
    lastReviewedAt: "2026-04-08",
    reviewedBy: DO,
    status: "approved",
    useCount: 14,
    createdAt: "2025-01-30T10:00:00Z",
    updatedAt: "2026-04-08T15:30:00Z",
    text: `**{{Section Number}}. Governing Law; Venue.**

(a) {{Agreement Name}} and any dispute arising out of or relating to it shall be governed by the laws of the State of Illinois, including the Uniform Commercial Code as adopted in Illinois where applicable, without regard to its conflict-of-laws principles.

(b) Each party irrevocably submits to the exclusive jurisdiction of the United States District Court for the Northern District of Illinois, Eastern Division, or, if that court lacks subject-matter jurisdiction, the Circuit Court of Cook County, Illinois, for any action arising out of or relating to {{Agreement Name}}, and waives any objection based on venue or inconvenient forum.

(c) Notwithstanding Section (b), either party may seek temporary, preliminary or permanent injunctive relief, or relief in aid of the preservation or recovery of goods, in any court of competent jurisdiction.

(d) The prevailing party in any action to enforce {{Agreement Name}} shall be entitled to recover its reasonable attorneys' fees and costs from the non-prevailing party.`,
  },

  // -------------------------------------------------------------------------
  // Force majeure
  // -------------------------------------------------------------------------
  {
    id: "lib_clause_force_majeure",
    name: "Force majeure (with epidemic, notice and termination right)",
    category: "force majeure",
    stance: "neutral",
    practiceArea: "Commercial",
    tags: ["force majeure", "pandemic", "supply chain", "termination"],
    description: "Post-2020 force majeure: enumerated events including epidemic and government orders, exclusion of economic hardship and payment obligations, mitigation, notice, and a termination right after an extended event.",
    variables: [
      { name: "Section Number", example: "16" },
      { name: "Notice Period", example: "five (5) business days" },
      { name: "Extended Event Period", example: "sixty (60) consecutive days" },
    ],
    notes: "Explicitly excludes 'changes in market conditions or increases in cost' so a counterparty cannot invoke the clause for ordinary supply-chain inflation. Payment obligations are never excused.",
    lastReviewedAt: "2026-03-14",
    reviewedBy: AK,
    status: "approved",
    useCount: 33,
    createdAt: "2024-02-06T12:00:00Z",
    updatedAt: "2026-03-14T09:00:00Z",
    text: `**{{Section Number}}. Force Majeure.**

(a) Neither party shall be liable for any failure or delay in performing its obligations under this Agreement (other than obligations to make payments when due) to the extent the failure or delay is caused by events beyond its reasonable control and without its fault or negligence, including acts of God, flood, fire, earthquake, hurricane or other natural disaster; epidemic, pandemic or quarantine; war, invasion, hostilities, terrorist threats or acts, riot or other civil unrest; embargoes or blockades; national or regional emergency; strikes, labor stoppages or slowdowns (other than those involving the affected party's own workforce); governmental orders, laws or actions; and failure of public utilities or telecommunications networks (each, a "Force Majeure Event"). A Force Majeure Event does not include changes in market conditions, increases in the cost of labor, materials or transportation, or a party's financial inability to perform.

(b) The affected party shall give the other party written notice within {{Notice Period}} after becoming aware of the Force Majeure Event, describing the event, its expected duration and the obligations affected, and shall use commercially reasonable efforts to mitigate the effects of the event and resume performance as soon as practicable, including by implementing its business continuity and disaster recovery plans.

(c) During a Force Majeure Event, the time for performance of the affected obligations shall be extended for a period equal to the duration of the event, and the other party may suspend its corresponding obligations (including payment for services not rendered) to the same extent.

(d) If a Force Majeure Event prevents the affected party from performing a material obligation for more than {{Extended Event Period}}, the other party may terminate this Agreement, or the affected Statement of Work, on written notice without liability, and the affected party shall refund any fees prepaid for services not rendered.`,
  },

  // -------------------------------------------------------------------------
  // Assignment
  // -------------------------------------------------------------------------
  {
    id: "lib_clause_assignment",
    name: "Assignment and change of control",
    category: "assignment",
    stance: "pro-client",
    practiceArea: "Corporate / M&A",
    tags: ["assignment", "change of control", "M&A", "consent"],
    description: "Anti-assignment covenant with a change-of-control trigger, a carve-out for assignment to an affiliate or successor in a sale of the business, and a void-ab-initio remedy.",
    variables: [
      { name: "Section Number", example: "17.2" },
      { name: "Party A", example: "Customer" },
      { name: "Party B", example: "Provider" },
      { name: "Consent Standard", example: "not to be unreasonably withheld, conditioned or delayed" },
    ],
    notes: "For a buyer client (Project Harbor), the target's contracts should have the successor carve-out in (b) so that the acquisition does not require consent. The diligence tracker flags top-20 customer contracts lacking it. When our client is the counterparty, delete (b)(ii) and add a notice-plus-termination right on change of control.",
    lastReviewedAt: "2026-09-05",
    reviewedBy: DO,
    status: "approved",
    useCount: 22,
    createdAt: "2024-08-19T16:00:00Z",
    updatedAt: "2026-09-05T11:45:00Z",
    text: `**{{Section Number}}. Assignment; Change of Control.**

(a) Neither party may assign, delegate or otherwise transfer this Agreement or any of its rights or obligations hereunder, whether voluntarily, by operation of law, merger (whether or not the party is the surviving entity), change of control or otherwise, without the prior written consent of the other party, {{Consent Standard}}.

(b) Notwithstanding Section (a), either party may, without consent but with prior written notice, assign this Agreement in its entirety (i) to an affiliate that assumes all of the assigning party's obligations in writing, provided the assigning party remains liable for the affiliate's performance, or (ii) to a successor in connection with a merger, consolidation, reorganization or sale of all or substantially all of the assets or equity of the business to which this Agreement relates, provided that the successor is not a direct competitor of the non-assigning party and assumes all obligations under this Agreement in writing.

(c) For purposes of this Section, "change of control" means any transaction or series of related transactions resulting in a person or group acquiring beneficial ownership of more than fifty percent (50%) of the voting power of a party, or the power to direct its management and policies.

(d) Any purported assignment, delegation or transfer in violation of this Section shall be null and void ab initio. Subject to the foregoing, this Agreement binds and benefits the parties and their respective permitted successors and assigns.`,
  },

  // -------------------------------------------------------------------------
  // Termination
  // -------------------------------------------------------------------------
  {
    id: "lib_clause_termination",
    name: "Termination for cause, insolvency and convenience",
    category: "termination",
    stance: "neutral",
    practiceArea: "Commercial",
    tags: ["termination", "cure period", "insolvency", "convenience"],
    description: "Termination rights: material breach with a cure period (shortened for payment and confidentiality breaches), insolvency events, and an optional convenience right with a notice period and wind-down fee.",
    variables: [
      { name: "Section Number", example: "14" },
      { name: "Cure Period", example: "thirty (30) days" },
      { name: "Payment Cure Period", example: "ten (10) days" },
      { name: "Convenience Notice Period", example: "ninety (90) days" },
      { name: "Terminating Party", example: "Customer" },
    ],
    notes: "The convenience right in (c) is one-way by default. Delete (c) or make it mutual depending on which side we represent; if kept, confirm the wind-down fee is consistent with the fee schedule.",
    lastReviewedAt: "2026-02-27",
    reviewedBy: AK,
    status: "approved",
    useCount: 29,
    createdAt: "2024-02-06T12:30:00Z",
    updatedAt: "2026-02-27T14:00:00Z",
    text: `**{{Section Number}}. Termination.**

(a) *For Cause.* Either party may terminate this Agreement, or any affected Statement of Work, on written notice if the other party materially breaches this Agreement and fails to cure the breach within {{Cure Period}} after receiving written notice describing the breach in reasonable detail; provided that the cure period for a failure to pay undisputed amounts when due shall be {{Payment Cure Period}}, and no cure period shall apply to a breach of Section 9 (Confidentiality) that is incapable of cure.

(b) *Insolvency.* Either party may terminate this Agreement immediately on written notice if the other party (i) becomes insolvent or generally unable to pay its debts as they become due; (ii) makes a general assignment for the benefit of creditors; (iii) has a receiver, trustee or similar officer appointed for all or substantially all of its assets; or (iv) files, or has filed against it, a petition in bankruptcy that is not dismissed within sixty (60) days.

(c) *For Convenience.* {{Terminating Party}} may terminate this Agreement, or any Statement of Work, for any reason or no reason on {{Convenience Notice Period}} prior written notice, subject to payment of (i) all fees for services performed through the effective date of termination and (ii) any wind-down fee expressly set forth in the applicable Statement of Work.

(d) *Suspension.* Provider may suspend performance of the affected services on ten (10) days' written notice if Customer fails to pay undisputed fees when due and does not cure within that period; suspension shall not relieve Customer of its payment obligations.`,
  },
  {
    id: "lib_clause_termination_effect",
    name: "Effect of termination; transition assistance; survival",
    category: "termination",
    stance: "pro-client",
    practiceArea: "Commercial",
    tags: ["termination", "transition", "data return", "survival"],
    description: "Customer-favorable effect-of-termination clause: transition assistance at then-current rates, data export window, return of materials, and an explicit survival list.",
    variables: [
      { name: "Section Number", example: "14.5" },
      { name: "Transition Period", example: "one hundred eighty (180) days" },
      { name: "Data Export Window", example: "sixty (60) days" },
      { name: "Provider", example: "Provider" },
      { name: "Customer", example: "Customer" },
    ],
    notes: "Ensure the survival list in (d) references the section numbers of the executed agreement; the drafting agent's cross-reference check will flag mismatches.",
    lastReviewedAt: "2026-02-27",
    reviewedBy: AK,
    status: "approved",
    useCount: 18,
    createdAt: "2024-02-06T12:45:00Z",
    updatedAt: "2026-02-27T14:05:00Z",
    text: `**{{Section Number}}. Effect of Termination.**

(a) *Transition Assistance.* Upon any expiration or termination of this Agreement other than for {{Customer}}'s uncured material breach, {{Provider}} shall, at {{Customer}}'s request, continue to provide the services and such additional transition assistance as {{Customer}} reasonably requests for up to {{Transition Period}} after the effective date of termination (the "Transition Period"), at the rates in effect immediately before termination, so that {{Customer}} may transition to a successor provider or in-house operation without interruption.

(b) *Data.* For {{Data Export Window}} after the later of the effective date of termination and the end of the Transition Period, {{Provider}} shall make {{Customer}} Data available for export in a commercially standard, machine-readable format at no additional charge. After that period, {{Provider}} shall delete {{Customer}} Data from its systems within thirty (30) days, except as required to be retained by law, and shall certify deletion in writing on request.

(c) *Return of Materials; Fees.* Each party shall return or destroy the other party's Confidential Information in accordance with Section 9. {{Customer}} shall pay undisputed fees accrued through the effective date of termination and during the Transition Period. {{Provider}} shall refund any prepaid fees for services not rendered, except in the case of termination for {{Customer}}'s uncured material breach.

(d) *Survival.* The following provisions survive expiration or termination: Sections 5 (Fees, as to accrued amounts), 7 (Intellectual Property), 9 (Confidentiality), 10 (Data Security, for so long as {{Provider}} retains {{Customer}} Data), 12 (Indemnification), 13 (Limitation of Liability), this Section {{Section Number}}, and Section 17 (General), together with any other provision that by its nature is intended to survive.`,
  },

  // -------------------------------------------------------------------------
  // Arbitration document-request definitions (fictional Valsara matter)
  // -------------------------------------------------------------------------
  {
    id: "lib_clause_vls_definitions",
    name: "MC-8 / Aqua-Guard definitions for document requests (Redfern schedule)",
    category: "discovery definitions",
    stance: "pro-client",
    practiceArea: "Commercial",
    tags: ["MC-8", "Aqua-Guard", "definitions", "Redfern", "arbitration", "discovery"],
    description: "Definitions section for the Respondent's document requests in the fictional Valsara arbitration: MC-8, Aqua-Guard Product, Site, Wellfield, Relevant Period, with precise compound codes to avoid overbreadth objections.",
    variables: [
      { name: "Site", description: "The facility or processing unit at issue", example: "the Valsara Textile Park common effluent treatment area" },
      { name: "Wellfield", example: "the Valsara Textile Park wellfield (Wells 9–12)" },
      { name: "Relevant Period", example: "January 1, 1990 through the date of your response" },
      { name: "Client", example: "Meridian Fine Chemicals Ltd." },
    ],
    notes: "Fictional demo clause. Compound codes keep the MC-8 definition objectively bounded (the Claimant's omnibus definition covers 'any organohalogen', which invites an overbreadth fight). Definition 5 ('Repellent Agent') tracks Meridian's product line so that requests can be aimed at what Meridian actually made. Coordinate with the ESI protocol before serving.",
    lastReviewedAt: "2026-09-18",
    reviewedBy: PR,
    status: "approved",
    useCount: 11,
    createdAt: "2025-06-30T15:00:00Z",
    updatedAt: "2026-09-18T18:00:00Z",
    text: `**DEFINITIONS**

1. "MC-8" means the organohalogen ester identified in Meridian's records by internal code MC-8 and its sodium salt, together with (a) its degradation product MC-7 and (b) any other organohalogen that You contend was released at the Site or detected in the Wellfield.

2. "Aqua-Guard Product" means the Aqua-Guard 3% and 6% Finish Concentrates and any premix or finishing bath prepared from them, whether or not supplied to Defence Textile Specification DTS-24385 (any revision).

3. "Site" means {{Site}}, including all structures, processing areas, drainage features, storage areas and adjacent property on which any Aqua-Guard Product was stored, used, tested, discharged or disposed.

4. "Wellfield" means {{Wellfield}}, including its source wells, treatment facilities and distribution system.

5. "Repellent Agent" means MF-3 Repellent Finish Concentrate and any other finishing agent sold for incorporation into an Aqua-Guard Product, including the products manufactured or sold by {{Client}} under the trade names identified in Your statement of claim.

6. "Relevant Period" means {{Relevant Period}}, unless a specific Request states otherwise.

7. "Document" includes electronically stored information of every kind, including email and attachments, chat and instant messages, text messages, voicemail, calendar entries, databases, laboratory notebooks, analytical data files (including chromatograms and instrument output), and drafts.

8. "Testing" means any sampling, analysis, monitoring or measurement of soil, sediment, surface water, groundwater, drinking water or biological tissue for the presence or concentration of MC-8, including field notes, chain-of-custody records, laboratory reports, quality-assurance documents and data validation.

9. "You" and "Your" mean the responding party and its present and former officers, employees, agents, consultants, contractors, advocates and any other person acting on its behalf.

10. The singular includes the plural and vice versa; "and" and "or" shall be construed conjunctively or disjunctively as necessary to bring within the scope of a Request all responses that might otherwise be construed to be outside its scope; "including" means "including without limitation."`,
  },
  {
    id: "lib_clause_esi_tar_disclosure",
    name: "ESI protocol — technology-assisted review disclosure and validation",
    category: "discovery definitions",
    stance: "neutral",
    practiceArea: "Litigation",
    tags: ["ESI protocol", "TAR", "validation", "recall", "arbitration", "e-discovery"],
    description: "Negotiated ESI-protocol paragraph on the use of technology-assisted review: disclosure obligations, validation with an elusion sample, recall target and dispute process.",
    variables: [
      { name: "Paragraph Number", example: "14" },
      { name: "Producing Party", example: "Meridian Fine Chemicals Ltd." },
      { name: "Recall Target", example: "seventy-five percent (75%)" },
      { name: "Elusion Sample Size", example: "a statistically valid random sample sufficient for a 95% confidence level with a ±2.5% margin of error" },
    ],
    notes: "Reflects the Tier 2 custodial review protocol in the Valsara arbitration (Arb. Ref. 14/2024). Do not agree to disclose the seed set or coding decisions on individual training documents; disclosure of the method, validation statistics and the elusion sample results is the accepted middle ground.",
    lastReviewedAt: "2026-08-28",
    reviewedBy: JW,
    status: "approved",
    useCount: 6,
    createdAt: "2025-09-09T10:00:00Z",
    updatedAt: "2026-08-28T16:30:00Z",
    text: `**{{Paragraph Number}}. Technology-Assisted Review.**

(a) A Producing Party may use technology-assisted review, continuous active learning, or other analytical tools ("TAR") to identify responsive documents, in addition to or in lieu of search terms, provided that it discloses to the Requesting Party, before or at the time it begins the TAR process, (i) the name and vendor of the TAR tool; (ii) a general description of the workflow, including how the review population was defined, whether search terms were applied before TAR, and how the process will be validated; and (iii) the categories of documents excluded from the TAR population (for example, non-text files, spreadsheets, and images), together with the alternative method used to review them.

(b) The Producing Party shall not be required to disclose the identity of documents used to train the TAR tool, coding decisions on individual training documents, or the ranking scores of individual documents, all of which the parties agree are protected work product.

(c) Before certifying its production as substantially complete, {{Producing Party}} shall validate the TAR process by reviewing {{Elusion Sample Size}} drawn from the documents the TAR process identified as non-responsive (the "elusion sample"), and shall disclose to the Requesting Party the size of the elusion sample, the number of responsive documents found in it, the estimated recall of the process (with its confidence interval), and the number of responsive documents identified in the elusion sample that were produced. The Producing Party shall use reasonable efforts to achieve an estimated recall of at least {{Recall Target}}.

(d) If the Requesting Party contends that the TAR process was not reasonable, the parties shall meet and confer within fourteen (14) days after the disclosure under Section (c). Any unresolved dispute shall be presented to the Court in a joint submission not exceeding ten (10) pages, with the Producing Party bearing the burden of demonstrating that the process was reasonable and the Requesting Party bearing the burden of demonstrating that additional review would be proportional under Rule 26(b)(1).`,
  },

  // -------------------------------------------------------------------------
  // Deposition stipulations
  // -------------------------------------------------------------------------
  {
    id: "lib_clause_depo_stipulations",
    name: "Standard deposition stipulations (on the record)",
    category: "deposition stipulations",
    stance: "pro-client",
    practiceArea: "Litigation",
    tags: ["deposition", "stipulations", "objections", "Rule 30", "Rule 32"],
    description: "Firm-standard stipulations read onto the record at the start of a deposition: no 'usual stipulations', objections reserved except form and foundation, read-and-sign with 30 days, exhibit handling and confidentiality designation window.",
    variables: [
      { name: "Witness", example: "Hema Vasudevan" },
      { name: "Signature Period", example: "thirty (30) days" },
      { name: "Designation Period", example: "twenty-one (21) days" },
      { name: "Protective Order Citation", example: "Case Management Order No. 4 (ECF No. 456)" },
    ],
    notes: "Never accept 'the usual stipulations' — they vary by jurisdiction and often waive read-and-sign. Stipulation 2 preserves all objections except form and foundation, consistent with Fed. R. Civ. P. 32(d)(3)(B). Stipulation 5 sets a default designation for the transcript until the designation period runs.",
    lastReviewedAt: "2026-09-19",
    reviewedBy: JW,
    status: "approved",
    useCount: 54,
    createdAt: "2023-11-07T13:00:00Z",
    updatedAt: "2026-09-19T08:10:00Z",
    text: `**STIPULATIONS**

Counsel for the parties stipulate on the record as follows:

1. The deposition of {{Witness}} is taken pursuant to notice and the Federal Rules of Civil Procedure. The parties do not adopt any "usual stipulations."

2. All objections, except as to the form of the question and the foundation for the answer, are reserved until the time of trial or other use of the testimony. Objections as to form shall be stated concisely and in a non-argumentative and non-suggestive manner, consistent with Rule 30(c)(2); the basis for a form objection shall be stated only if requested by examining counsel.

3. Counsel may instruct the witness not to answer only when necessary to preserve a privilege, to enforce a limitation ordered by the Court, or to present a motion under Rule 30(d)(3).

4. The witness reserves the right to read and sign the transcript. The court reporter shall provide the transcript to defending counsel, and the witness shall have {{Signature Period}} from receipt to review the transcript and sign an errata sheet listing any changes in form or substance and the reasons for them. If the errata sheet is not returned within that period, the transcript may be used as though signed.

5. The transcript and all exhibits shall be treated as "Confidential" under {{Protective Order Citation}} until {{Designation Period}} after the final transcript is delivered, during which time any party may designate portions of the transcript under the protective order.

6. Exhibits shall be marked sequentially with the witness's surname and a number (for example, "Vasudevan 1"), and previously marked exhibits may be used with their original designations. Counsel shall exchange native files of any spreadsheet or database exhibit within three (3) business days.

7. The deposition may be recorded stenographically and by videotape. If the video recording is used at trial or in any motion, the party offering it shall provide the corresponding transcript pages.

8. Nothing in these stipulations waives any objection to the admissibility of testimony or exhibits at trial.`,
  },
  {
    id: "lib_clause_depo_remote",
    name: "Remote deposition protocol stipulation",
    category: "deposition stipulations",
    stance: "neutral",
    practiceArea: "Litigation",
    tags: ["deposition", "remote", "videoconference", "Rule 30(b)(4)", "exhibits"],
    description: "Stipulation under Rule 30(b)(4) for depositions by videoconference: platform, oath, exhibit sharing, off-camera communications, technical failures, and recording.",
    variables: [
      { name: "Platform", example: "Zoom (via the court reporter's licensed account)" },
      { name: "Witness", example: "Dr. Raj Patel" },
      { name: "Exhibit Delivery Deadline", example: "6:00 p.m. Eastern the business day before the deposition" },
    ],
    notes: "Paragraph 4 (no private communications with the witness while a question is pending, including by chat or text) is the point most often contested. Keep the technical-failure clause so a dropped connection does not count against the seven-hour limit.",
    lastReviewedAt: "2026-06-03",
    reviewedBy: PR,
    status: "approved",
    useCount: 19,
    createdAt: "2024-04-02T09:00:00Z",
    updatedAt: "2026-06-03T11:20:00Z",
    text: `**STIPULATION REGARDING REMOTE DEPOSITION**

Pursuant to Fed. R. Civ. P. 30(b)(4), the parties stipulate that the deposition of {{Witness}} may be taken by remote means as follows:

1. *Platform and Officer.* The deposition shall be conducted by videoconference using {{Platform}}. The court reporter shall attend remotely, may administer the oath remotely, and the witness's testimony shall have the same force and effect as if the oath had been administered in person. The parties waive any objection to the deposition based on the location of the reporter or the manner of administering the oath.

2. *Attendance.* The witness shall be alone in the room, or accompanied only by defending counsel, and shall confirm this on the record at the outset and after each break. The witness shall keep the camera on and remain visible throughout the deposition.

3. *Exhibits.* Examining counsel shall deliver exhibits to the court reporter through the platform's exhibit-sharing tool or a secure file link by {{Exhibit Delivery Deadline}}, except that counsel may introduce additional exhibits during the deposition by screen share or upload without prior delivery; the witness shall be given a reasonable opportunity to review any document before answering questions about it. Hard-copy exhibit sets provided to the witness in advance shall be delivered sealed and opened only on the record.

4. *Communications.* No person may communicate with the witness by any means (including chat, text message, email or notes) while a question is pending, other than to determine whether a privilege should be asserted. Counsel and the witness may confer during breaks to the same extent permitted at an in-person deposition.

5. *Technical Failures.* If a participant loses connection, the deposition shall pause until the connection is restored. Time lost to technical failures shall not count against the seven-hour limit of Rule 30(d)(1). If the failure cannot be resolved within thirty minutes, the parties shall reschedule the remaining time at a mutually convenient date without prejudice.

6. *Recording.* The deposition may be recorded by video by the court reporter's videographer through the platform. No party or witness may make any other recording. The video record shall show only the witness unless counsel agree otherwise.

7. *Objections.* The parties' stipulations regarding objections, read-and-sign and confidentiality designations apply to the remote deposition.`,
  },

  // -------------------------------------------------------------------------
  // Protective order tiers
  // -------------------------------------------------------------------------
  {
    id: "lib_clause_po_tiers",
    name: "Protective order — Confidential / Highly Confidential – AEO tiers",
    category: "protective order tiers",
    stance: "pro-client",
    practiceArea: "Litigation",
    tags: ["protective order", "confidentiality", "AEO", "trade secrets", "MDL"],
    description: "Two-tier protective-order structure: definitions of Confidential and Highly Confidential – Attorneys' Eyes Only, who may access each tier, expert disclosure procedure, and inadvertent-designation cure.",
    variables: [
      { name: "Paragraph Number", example: "5" },
      { name: "Designating Party", example: "Producing Party" },
      { name: "Expert Objection Period", example: "seven (7) days" },
      { name: "Cure Period", example: "fourteen (14) days" },
    ],
    notes: "For a manufacturer defendant, insist that formulations, batch records, supplier lists and pricing qualify for the AEO tier. Paragraph (d) (expert disclosure with an objection window) prevents a plaintiff's consulting expert who works for competitors from seeing formulations without notice.",
    lastReviewedAt: "2026-07-22",
    reviewedBy: JW,
    status: "approved",
    useCount: 16,
    createdAt: "2023-12-01T10:00:00Z",
    updatedAt: "2026-07-22T15:00:00Z",
    text: `**{{Paragraph Number}}. Designation of Protected Material.**

(a) *"Confidential."* A {{Designating Party}} may designate as "CONFIDENTIAL" any document, testimony or other material that it reasonably and in good faith believes contains non-public information that is proprietary, commercially sensitive, or private personal information protected from disclosure by law, including personnel records, medical information, and financial information.

(b) *"Highly Confidential – Attorneys' Eyes Only."* A {{Designating Party}} may designate as "HIGHLY CONFIDENTIAL – ATTORNEYS' EYES ONLY" ("AEO") any Confidential material that it reasonably and in good faith believes contains trade secrets or other information whose disclosure to a competitor or to the public would create a substantial risk of serious competitive or business harm, including product formulations and specifications, manufacturing processes and batch records, supplier and customer identities and pricing, research and development records, and non-public financial projections.

(c) *Access.* Material designated Confidential may be disclosed only to (i) the parties and their officers and employees who are assisting in the litigation; (ii) counsel of record and their staff; (iii) experts and consultants disclosed under Section (d); (iv) the Court, court personnel and court reporters; (v) mediators; (vi) witnesses at deposition or trial who authored or received the material or are otherwise shown to have knowledge of it; and (vii) any person with the written consent of the {{Designating Party}}. Material designated AEO may be disclosed only to the persons in categories (ii) through (v) and (vii), and to in-house counsel identified in writing to the {{Designating Party}} who are not involved in competitive decision-making.

(d) *Experts.* Before Protected Material is disclosed to an expert or consultant, the receiving party shall serve on the {{Designating Party}} the person's name, current employer, curriculum vitae, a list of all engagements as an expert witness in the past four years, and any relationship with a competitor of the {{Designating Party}}, together with a signed Acknowledgment in the form of Exhibit A. The {{Designating Party}} may object in writing within {{Expert Objection Period}}; if the parties cannot resolve the objection, the {{Designating Party}} may move for relief within seven (7) days thereafter, and no disclosure shall be made until the motion is resolved.

(e) *Inadvertent Failure to Designate.* An inadvertent failure to designate material does not waive protection. Within {{Cure Period}} after discovering the omission, the {{Designating Party}} may designate the material by written notice, and the receiving party shall thereafter treat it accordingly and make reasonable efforts to retrieve any copies disclosed to persons not authorized to receive it.

(f) *Challenges.* A party may challenge a designation at any time by written notice stating the basis for the challenge. The parties shall meet and confer within fourteen (14) days. If the dispute is not resolved, the {{Designating Party}} bears the burden of moving to retain the designation within twenty-one (21) days after the meet-and-confer, failing which the challenged designation is withdrawn.`,
  },
  {
    id: "lib_clause_po_502d",
    name: "FRE 502(d) order and clawback procedure",
    category: "protective order tiers",
    stance: "pro-client",
    practiceArea: "Litigation",
    tags: ["FRE 502(d)", "clawback", "privilege", "protective order", "inadvertent production"],
    description: "Non-waiver order under Federal Rule of Evidence 502(d) with a clawback procedure that does not depend on the reasonableness of the producing party's precautions, plus sequestration and privilege-log requirements.",
    variables: [
      { name: "Paragraph Number", example: "12" },
      { name: "Return Period", example: "ten (10) business days" },
      { name: "Log Period", example: "fourteen (14) days" },
    ],
    notes: "The 502(d) order displaces the 502(b) reasonableness analysis in this and any other federal or state proceeding; do not let the counterparty reintroduce 'reasonable steps' language in (a). Paragraph (b) mirrors Rule 26(b)(5)(B) sequestration.",
    lastReviewedAt: "2026-07-22",
    reviewedBy: JW,
    status: "approved",
    useCount: 24,
    createdAt: "2023-12-01T10:15:00Z",
    updatedAt: "2026-07-22T15:05:00Z",
    text: `**{{Paragraph Number}}. Non-Waiver of Privilege (Fed. R. Evid. 502(d)).**

(a) Pursuant to Federal Rule of Evidence 502(d), the production or disclosure of any document or information protected by the attorney-client privilege, the work-product doctrine, or any other applicable privilege or protection, whether inadvertent or otherwise, shall not constitute a waiver of the privilege or protection in this proceeding or in any other federal or state proceeding. This Order shall be interpreted to provide the maximum protection allowed by Rule 502(d), and the provisions of Rule 502(b) shall not apply.

(b) A producing party may assert privilege or protection over produced material by written notice identifying the material by Bates number and the basis for the assertion. Upon receipt, the receiving party shall within {{Return Period}} return, sequester or destroy all copies of the identified material, including any notes or summaries that reflect its contents, shall not use or disclose the material until the claim is resolved, and shall take reasonable steps to retrieve the material from any person to whom it was disclosed.

(c) Within {{Log Period}} after giving notice, the producing party shall serve a privilege log entry for the clawed-back material and, where the material contains both privileged and non-privileged content, a redacted version.

(d) The receiving party may challenge the assertion by motion within twenty-one (21) days after the log entry is served, and may submit the material to the Court under seal for in camera review, but may not otherwise use the material or its contents in the motion. The producing party bears the burden of establishing the privilege or protection.

(e) Nothing in this Order limits a party's right to conduct a review of documents for privilege, responsiveness or confidentiality before production, or requires a party to produce documents without such review.`,
  },

  // -------------------------------------------------------------------------
  // M&A definitions
  // -------------------------------------------------------------------------
  {
    id: "lib_clause_mae_definition",
    name: "Material Adverse Effect definition (buyer-favorable)",
    category: "M&A definitions",
    stance: "pro-client",
    governingLaw: "Delaware",
    practiceArea: "Corporate / M&A",
    tags: ["MAE", "M&A", "SPA", "definitions", "Project Harbor"],
    description: "Buyer-side MAE definition with a prospects prong, the customary carve-outs limited by a disproportionate-effect exception, and a specific carve-back for loss of key customers and IP assignment defects.",
    variables: [
      { name: "Company", example: "Bluewater Analytics, Inc." },
      { name: "Key Customer Threshold", example: "any of the twenty (20) largest customers of the Company by revenue for the twelve months ended June 30, 2026" },
    ],
    notes: "Drafted for the Project Harbor SPA. The seller will push to delete the prospects prong and clause (y)(ii). Our fallback: keep (y)(ii) as a stand-alone closing condition rather than in the MAE definition. Delaware courts read MAE clauses narrowly (Akorn is the only post-trial finding of an MAE) — the disproportionate-effect exception is what makes the carve-outs bite.",
    lastReviewedAt: "2026-09-15",
    reviewedBy: DO,
    status: "draft",
    useCount: 3,
    createdAt: "2026-08-04T14:00:00Z",
    updatedAt: "2026-09-15T19:20:00Z",
    text: `"Material Adverse Effect" means any event, change, circumstance, development, occurrence or effect (each, an "Effect") that, individually or in the aggregate with all other Effects, (x) has had or would reasonably be expected to have a material adverse effect on the business, assets, liabilities, condition (financial or otherwise), results of operations or prospects of {{Company}} and its Subsidiaries, taken as a whole, or (y) would reasonably be expected to prevent, materially impair or materially delay the ability of the Sellers or {{Company}} to consummate the Transactions; provided, however, that, solely for purposes of clause (x), none of the following shall be deemed, either alone or in combination, to constitute, or be taken into account in determining whether there has been or would reasonably be expected to be, a Material Adverse Effect: (a) changes in general economic, financial market, credit market or political conditions in the United States; (b) changes generally affecting the industries in which {{Company}} operates; (c) changes in applicable Law or GAAP, or the interpretation thereof, after the date of this Agreement; (d) acts of war, sabotage, terrorism, cyberattack (other than a cyberattack directed at {{Company}}), natural disaster, epidemic or pandemic; (e) the announcement or pendency of the Transactions, including the identity of Buyer (provided that this clause (e) shall not apply to any representation or warranty that by its terms addresses the consequences of the execution of this Agreement or the consummation of the Transactions); (f) any failure by {{Company}} to meet internal or published projections, forecasts or revenue or earnings predictions (provided that the underlying causes of such failure shall not be excluded by this clause (f)); or (g) any action taken by {{Company}} at the express written request of Buyer; except, in the case of clauses (a) through (d), to the extent such Effect has a disproportionate effect on {{Company}} and its Subsidiaries, taken as a whole, relative to other participants in the industries in which {{Company}} operates. Notwithstanding the foregoing, each of the following shall be deemed to constitute a Material Adverse Effect: (i) the termination, non-renewal, or written notice of intent to terminate or materially reduce purchases by {{Key Customer Threshold}}; and (ii) any determination that {{Company}} does not own, or holds subject to a third-party claim, the Core ML Models identified on Schedule 1.1(c) by reason of any defect in the chain of assignment from their developers.`,
  },
];
