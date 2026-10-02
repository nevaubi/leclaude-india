import type { PracticeArea } from "@/lib/types/domain";

export interface SeedNote {
  id: string;
  parentId: string;
  name: string;
  description: string;
  tags: string[];
  practiceArea?: PracticeArea;
  matterId?: string;
  ownerId: string;
  content: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  status?: "draft" | "approved" | "archived";
  starred?: boolean;
}

const K = {
  litigation: "lib_folder_knowledge_litigation",
  transactional: "lib_folder_knowledge_transactional",
  research: "lib_folder_knowledge_research",
  style: "lib_folder_knowledge_style",
};

export const KNOWLEDGE_SUBFOLDERS = K;

export const SEED_NOTES: SeedNote[] = [
  {
    id: "lib_note_vls_po3",
    parentId: K.litigation,
    name: "Arb. Ref. 14/2024 — Procedural Order No. 3 summary (document production and Tier 2 custodians)",
    description: "Working summary of Procedural Order No. 3 in the fictional Valsara v. Meridian arbitration: custodial scope, production deadlines, expert sequencing and the meet-and-confer protocol.",
    tags: ["Valsara", "arbitration", "procedural order", "document production", "discovery"],
    practiceArea: "Commercial",
    matterId: "m_valsara_arb",
    ownerId: "p_jwhitfield",
    version: 4,
    status: "approved",
    starred: true,
    createdAt: "2026-06-30T14:00:00Z",
    updatedAt: "2026-09-16T18:45:00Z",
    content: `# Procedural Order No. 3 — document production (Tier 2)

> Internal working summary of a fictional demo order. The operative text controls; cite the order itself (Valsara Textile Park Ltd. v. Meridian Fine Chemicals Ltd., Arb. Ref. 14/2024, Procedural Order No. 3) before relying on any deadline below.

## What the order does

Procedural Order No. 3 sets the document-production schedule and protocol for the **Tier 2** requests (Redfern schedule, Claimant's Requests 3–31) after the Tier 1 exchange of contract and correspondence files. Procedural Order No. 4 later fixed the expert and hearing timetable.

## Key deadlines (as we track them)

| Event | Date | Owner |
| --- | --- | --- |
| Claimant's damages particulars | 2026-08-15 | Claimant |
| Respondent's custodial production (Tier 2 custodians) substantially complete | **2026-10-14** | Meridian / M&R (T. Bhatt) |
| Claimant's toxicology and hydrogeology expert reports | 2026-10-02 | Claimant |
| Respondent's rebuttal expert reports | **2026-11-06** | M&R (P. Raman) |
| Expert technical conferencing session | 2026-11-13 | Tribunal |
| Objections to expert evidence | **2026-12-18** | All |
| Phase 1 evidentiary hearing | 2027-03-08 | Tribunal |

## Custodial scope for Meridian

Paragraph 7 limits Tier 2 custodial production to **eight custodians**, selected by the Claimant from the Respondent's list of persons with relevant knowledge. Our eight (agreed 2026-07-21): Hegde, Vasudevan, Bose, Prasad, Kapur, Sood, plus two legacy product-stewardship custodians. Date range: **1985-01-01 to 2016-12-31**, with a rolling supplement for regulatory correspondence after 2016.

Search terms and TAR are governed by the agreed ESI protocol as modified by ¶ 9: TAR is permitted with disclosure of the workflow and a validation elusion sample (see Clause bank → ESI protocol TAR disclosure). Target recall: 75%.

## Expert sequencing

- Liability experts first (¶ 12): toxicology and hydrogeology. Quantum experts follow 45 days after the liability rebuttal deadline.
- ¶ 13 limits each side to **two liability experts per discipline**. Rebuttal reports are limited to the subject matter of the report they rebut.
- Draft reports and counsel-expert communications are not to be disclosed; each expert files a declaration of independence.

## Meet-and-confer and dispute protocol

Production disputes go to the Presiding Arbitrator by joint letter of no more than five pages, filed within seven days after the meet-and-confer. **No production application may be made without the joint-letter process first.**

## Open issues we are tracking

1. Whether the post-2016 rolling supplement covers Clause 9.4 correspondence after CPCB's 2016 revised guidance value (the Claimant says yes; we read ¶ 8(c) as limited to "regulatory submissions", not internal analysis).
2. The Claimant's request to add a ninth custodian. Position: outside ¶ 7; offer a targeted search of the shared EHS drive instead.
3. Timing of the Vasudevan deposition (Vol. II) relative to rebuttal reports — we want it before 2026-11-06 so Dr. Sundaram can address it.

## Related items

- Clause bank: MC-8 / Aqua-Guard definitions for document requests; ESI protocol — TAR disclosure; Confidentiality order tiers.
- Knowledge: Clause 9.4 substantial-risk notice — elements and defences.`,
  },
  {
    id: "lib_note_rule702_cheatsheet",
    parentId: K.litigation,
    name: "Daubert / Rule 702 (2023 amendment) cheat sheet",
    description: "The December 2023 amendment to Federal Rule of Evidence 702, what changed, how to brief it, and how courts in the Fourth, Seventh and Eleventh Circuits have applied it.",
    tags: ["Rule 702", "Daubert", "expert", "evidence", "2023 amendment"],
    practiceArea: "Litigation",
    ownerId: "p_praman",
    version: 3,
    status: "approved",
    starred: true,
    createdAt: "2024-01-15T10:00:00Z",
    updatedAt: "2026-08-29T16:00:00Z",
    content: `# Daubert / Rule 702 cheat sheet (post-December 1, 2023)

## The amended rule

Federal Rule of Evidence 702, as amended effective December 1, 2023, provides that a qualified expert may testify if **the proponent demonstrates to the court that it is more likely than not** that:

(a) the expert's scientific, technical, or other specialized knowledge will help the trier of fact;
(b) the testimony is based on sufficient facts or data;
(c) the testimony is the product of reliable principles and methods; and
(d) **the expert's opinion reflects a reliable application** of the principles and methods to the facts of the case.

## What actually changed

1. **Burden made explicit.** The preponderance standard for each admissibility requirement is now in the rule text. The Advisory Committee Note states that "many courts have held that the critical questions of the sufficiency of an expert's basis, and the application of the expert's methodology, are questions of weight and not admissibility" and that "these rulings are an incorrect application of Rules 702 and 104(a)."
2. **Subsection (d) rewritten.** The old text ("the expert has reliably applied") became "the expert's opinion reflects a reliable application." The Note explains the change is meant to emphasize that each opinion must stay within the bounds of what can be concluded from a reliable application of the method — an expert may not overstate conclusions.
3. **No change to Daubert factors.** Testability, peer review, error rate, standards, general acceptance (Daubert, 509 U.S. 579, 593–94 (1993)) remain a flexible, non-exclusive list; Kumho Tire (526 U.S. 137 (1999)) still extends the gatekeeping to non-scientific expertise.

## Briefing checklist (motion to exclude)

- Lead with the amended text and the Committee Note's "incorrect application" language; quote the Note in the standard section.
- Frame each attack as a **702(b)** (insufficient facts/data), **702(c)** (unreliable method) or **702(d)** (unreliable application / overstated conclusion) problem. Courts respond best to (d) arguments after the amendment.
- For epidemiology: relative risk, confidence intervals, confounding, dose-response, and whether the expert applied the Bradford Hill considerations or simply recited them.
- For exposure/hydrogeology: model inputs actually tied to site data; sensitivity analysis; whether the expert ran the model or adopted a consultant's output.
- Attach the report, the deposition excerpts and the literature the expert relied on; the court cannot find a 702(b) failure without the data in front of it.
- Ask for exclusion of **specific opinions**, not the witness wholesale, and offer a fallback limiting instruction.

## Circuit notes (verify before citing)

- **Fourth Circuit:** Sardis v. Overhead Door Corp., 10 F.4th 268 (4th Cir. 2021), reversed for failure to perform the gatekeeping function and is routinely cited with the 2023 Note. Post-amendment district decisions in D.S.C. treat Sardis as controlling on the "weight vs. admissibility" point. [VERIFY pin cites]
- **Seventh Circuit:** Continues to require the district court to make explicit reliability findings (see Timm v. Goodyear Dunlop Tires N. Am., Ltd., 932 F.3d 986 (7th Cir. 2019)); the amendment aligns with existing circuit practice. [VERIFY]
- **Eleventh Circuit:** United States v. Frazier, 387 F.3d 1244 (11th Cir. 2004) (en banc) already placed the burden on the proponent; the Depo-Provera MDL court has cited the amended rule in scheduling Science Day. [VERIFY]

## Pitfalls

- Do not argue that the amendment "raised the bar" — the Committee says it clarified existing law. Argue that the court must actually decide the preponderance questions.
- A challenge to "sufficient facts or data" fails if it is really a dispute about which of two adequate data sets is better; that is weight.
- Preserve the objection at trial (Rule 103(b) makes a definitive pretrial ruling sufficient, but renew if the testimony strays from the ruling).`,
  },
  {
    id: "lib_note_dsc_lr704",
    parentId: K.litigation,
    name: "D.S.C. Local Civ. Rule 7.04 — motion and briefing practice",
    description: "How to brief a motion in the District of South Carolina: supporting memorandum requirement, response and reply timing, page limits, proposed orders, and MDL practice notes.",
    tags: ["D.S.C.", "local rules", "briefing", "motion practice"],
    practiceArea: "Litigation",
    ownerId: "p_emarsh",
    version: 2,
    status: "approved",
    createdAt: "2025-04-10T09:00:00Z",
    updatedAt: "2026-07-08T13:30:00Z",
    content: `# D.S.C. Local Civil Rule 7.04 and related briefing rules

> Verify against the current Local Civil Rules (D.S.C.) before filing; the court revises them periodically and the MDL case management orders modify several of these defaults.

## Rule 7.04 — Memoranda in support

Every motion must be accompanied by a supporting memorandum unless the motion is one the court has designated as not requiring one (for example, routine extensions, pro hac vice admissions, substitutions of counsel). The memorandum states the grounds and the authorities relied on. Under the rule, a motion filed without a memorandum may be summarily denied — treat the memorandum as mandatory for anything contested.

## Rule 7.05 — Documentary support and length

- Supporting affidavits, declarations and exhibits are filed with the motion; cite them by exhibit and page/paragraph.
- Length limits: **35 pages** for a memorandum in support or in opposition, **15 pages** for a reply, exclusive of caption, tables and signature block, unless the court grants leave. [VERIFY — confirm current limits]
- Double-spaced, 12-point font, one-inch margins. Footnotes count toward the limit.

## Rule 7.06 — Responses

A response is due **14 days** after service of the motion (plus three days if served by mail, though CM/ECF service is now the norm and does not add time). Failure to respond may be treated as consent to the relief requested.

## Rule 7.07 — Replies

A reply is due **7 days** after service of the response and must be limited to matters raised in the response. Sur-replies require leave.

## Rule 7.08 — Hearings

Motions are decided on the papers unless the court orders a hearing. Requests for oral argument go in the caption or the memorandum's conclusion.

## Rule 7.02 — Consultation

Before filing a motion in a civil case, counsel must confer (or attempt to confer) with opposing counsel in a good-faith effort to resolve the matter, and the motion must contain a statement to that effect. This applies to discovery and non-dispositive motions; dispositive motions recite that consultation is not required.

## Rule 7.09 / 7.10 — Proposed orders and page-limit motions

Proposed orders are not required for contested motions in D.S.C. but should be emailed to chambers when the motion is consented to. A motion to exceed page limits must be filed before the brief is due and must explain why the limit is inadequate.

## MDL practice (general)

- MDL case management orders commonly route discovery disputes through a special master's joint-letter process before any motion is filed; check the operative CMO.
- Expect short orders on the papers; the introduction should state precisely what relief is sought and why.
- Omnibus briefs (multiple defendants) usually require a coordination stipulation and leave to exceed page limits.
- Hearings may be set with little notice; keep the "argument in five minutes" outline current for every pending motion.

## Internal checklist

1. Rule 7.02 consultation statement (non-dispositive motions).
2. Memorandum with a one-paragraph introduction stating the relief requested.
3. Table of contents and authorities for anything over 10 pages (firm practice, not required by rule).
4. Exhibits labelled by letter, with a cover index.
5. Word count certification in the signature block (firm practice).
6. Calendar the 14/7-day response and reply dates in the matter calendar with the FRCP 6(a) calculator.`,
  },
  {
    id: "lib_note_7th_cir_consequential",
    parentId: K.transactional,
    name: "Seventh Circuit consequential-damages waiver notes (Illinois law)",
    description: "How Illinois and the Seventh Circuit treat consequential-damages waivers and limitation-of-liability clauses: enforceability between sophisticated parties, UCC § 2-719, failure of essential purpose, and the direct-vs-consequential line for lost profits.",
    tags: ["consequential damages", "Illinois", "Seventh Circuit", "UCC 2-719", "Northgate"],
    practiceArea: "Commercial",
    matterId: "m_northgate_v_apex",
    ownerId: "p_dokafor",
    version: 5,
    status: "approved",
    starred: true,
    createdAt: "2026-02-18T15:00:00Z",
    updatedAt: "2026-09-12T20:10:00Z",
    content: `# Consequential-damages waivers under Illinois law and in the Seventh Circuit

> Research notes for Northgate v. Apex (N.D. Ill.). Pin cites marked [VERIFY] have not been re-checked against the reporters this quarter; run the citation checker before quoting.

## 1. Baseline: enforceable between sophisticated parties

Illinois enforces contractual limitations on consequential damages as written when negotiated between commercial parties, absent unconscionability or a public-policy bar. The Seventh Circuit applies the same rule and has enforced limitation clauses even where the result eliminates most of the plaintiff's recovery:

- Rexnord Corp. v. DeWolff Boberg & Assocs., Inc., 286 F.3d 1001 (7th Cir. 2002) — consequential-damages exclusion enforced in a consulting agreement; lost profits from the consultant's poor performance were consequential. [VERIFY]
- SAMS Hotel Group, LLC v. Environs, Inc., 716 F.3d 432 (7th Cir. 2013) — limitation-of-liability clause enforced even against negligence claims where the parties were sophisticated (Indiana law, but relied on by N.D. Ill. courts for the general principle). [VERIFY]

## 2. UCC § 2-719 for sales of goods

Where the contract is for goods, 810 ILCS 5/2-719(3) allows limitation or exclusion of consequential damages "unless the limitation or exclusion is unconscionable." Commercial-loss limitations are presumptively conscionable; consumer personal-injury limitations are prima facie unconscionable.

**Failure of essential purpose.** Under § 2-719(2), if an exclusive limited remedy (e.g., repair-or-replace) fails of its essential purpose, the buyer may pursue general Code remedies. The Illinois Supreme Court has held that the consequential-damages exclusion in § 2-719(3) is **independent** of the limited remedy, so the failure of the repair remedy does not automatically revive consequential damages: Razor v. Hyundai Motor America, 222 Ill. 2d 75 (2006). [VERIFY] The Seventh Circuit reads Illinois law the same way.

Drafting point: the firm's cap clause includes "shall apply notwithstanding the failure of essential purpose of any limited remedy" for exactly this reason (Clause bank → Limitation of liability — fees-paid cap).

## 3. The MTSA in Northgate is a services contract

The master transportation services agreement is predominantly for services (carriage, cross-docking, warehousing), so the UCC does not apply directly; Illinois common law governs, and courts borrow § 2-719 by analogy. The enforceability analysis is the same, but § 2-719(2) "failure of essential purpose" arguments are weaker for Apex.

## 4. Direct vs. consequential: where the fight is

Illinois follows the Hadley v. Baxendale structure: direct damages flow naturally from the breach; consequential damages arise from the non-breaching party's particular circumstances and must have been contemplated at contracting. Lost profits can be either:

- **Direct** when they are the profit the plaintiff would have earned on the very contract breached (or, for a carrier, the value of the goods lost in transit).
- **Consequential** when they are profits on collateral transactions with third parties.

Key Illinois authorities: Midland Hotel Corp. v. Reuben H. Donnelley Corp., 118 Ill. 2d 306 (1987) (lost profits recoverable where proven with reasonable certainty) [VERIFY]; Westlake Financial Group, Inc. v. CDH-Delnor Health System, 2015 IL App (2d) 140589 (distinguishing direct and consequential lost profits) [VERIFY].

**Northgate position:** the $2.1M in cargo losses at the Joliet cross-dock are direct damages under MTSA § 8.4 (carrier liability for cargo) and are expressly carved out of the § 14.2 waiver. The lost Aurora Foods account is the harder claim: we plead it as direct because MTSA Schedule B priced the Aurora lane specifically, but expect the court to treat it as consequential unless we tie it to the carve-out.

## 5. Gross negligence / willful misconduct carve-out

Illinois will not enforce an exculpatory clause for willful and wanton conduct. Apex's dispatch records (the 2026-01-08 "run it anyway" email chain, NG-000341–NG-000347) support a willful-misconduct theory that would take the loss outside the waiver entirely. Plead in the alternative.

## 6. Summary judgment framing

Apex's MSJ argues the waiver is unambiguous and bars all lost-profit damages. Our opposition (due 2026-10-09) should (i) concede enforceability of the waiver as a general matter — do not fight the settled rule — and (ii) argue that (a) the cargo carve-out is unambiguous, (b) whether the Aurora losses are direct is a fact question under Westlake, and (c) willful misconduct is a jury question on the dispatch records.`,
  },
  {
    id: "lib_note_paga_2024_reform",
    parentId: K.litigation,
    name: "PAGA (2024 reform) — standing, penalties, cure and manageability",
    description: "The July 2024 PAGA amendments (AB 2288 / SB 92): who they apply to, the new standing rule, reduced penalties for early compliance, the cure process for small and large employers, and how manageability works after Estrada.",
    tags: ["PAGA", "California", "wage and hour", "employment", "Sterling"],
    practiceArea: "Employment",
    matterId: "m_sterling_employment",
    ownerId: "p_schen",
    version: 3,
    status: "approved",
    createdAt: "2024-08-01T09:00:00Z",
    updatedAt: "2026-09-08T17:15:00Z",
    content: `# PAGA after the 2024 reform (AB 2288 / SB 92)

> Applies to PAGA notices filed with the LWDA **on or after June 19, 2024**. The Sterling Medical notice (filed 2026-08-11) is under the reformed statute. Cite Cal. Lab. Code §§ 2698–2699.8 as amended; confirm section numbers, which were renumbered in the reform. [VERIFY]

## 1. Standing (Lab. Code § 2699(c))

The plaintiff must be an "aggrieved employee" who **personally suffered each Labor Code violation** alleged, within the one-year limitations period (plus the 65-day notice tolling). This overrules the Kim v. Reins / Huff line permitting a plaintiff to pursue violations they did not suffer. Practical effect for Sterling: the notice alleges meal-period, rounding and wage-statement violations across 14 clinics; the noticing employee (a medical assistant at the Glendale clinic) must show she personally experienced each theory. Rounding may fall out if her clinic used the Kronos punch system without rounding after 2023.

Union-represented employees and the "headless PAGA" question remain contested; monitor appellate decisions.

## 2. Penalties (§ 2699(f))

- Default penalty stays at $100 per employee per pay period, but:
  - **$50** where the violation resulted from an isolated, non-recurring event lasting no more than 30 days or four pay periods.
  - **$25** for wage-statement violations where the employee could promptly and easily determine the required information, or where the only defect is the employer's name/address.
  - **$200** for subsequent violations only after a court or agency finding, or where the employer acted maliciously, fraudulently or oppressively.
- Derivative penalties (§§ 201–203 waiting-time, § 226 wage statements) cannot be stacked on the same underlying violation.
- Weekly-pay employers: penalties are reduced by half.
- **15% cap** on penalties if the employer took "all reasonable steps" to comply *before* receiving the notice or a request for records (compliance audits, remedial policies, training, corrective action against supervisors).
- **30% cap** if the employer takes all reasonable steps within 60 days after receiving the notice.
- Allocation changed to **65% to LWDA / 35% to aggrieved employees** (was 75/25).

## 3. Cure

- **Small employers (< 100 employees)**: may submit a confidential cure proposal to the LWDA within 33 days of the notice; the agency holds a settlement conference. Sterling Medical (approx. 640 employees) does **not** qualify.
- **Large employers (≥ 100 employees)**: may file a request for an early evaluation conference and a stay with the court after the complaint is filed. The employer submits a confidential statement of which violations it will cure and how, and the court may approve the cure and reduce penalties accordingly.
- Wage-statement violations can be cured by providing corrected statements for the past three years.
- Meal/rest-period violations are cured only by paying the premium plus 7% interest to every affected employee.

## 4. Manageability

Estrada v. Royalty Carpet Mills, Inc., 15 Cal. 5th 582 (2024), held that trial courts lack inherent authority to strike a PAGA claim as unmanageable. The reform partially responds: § 2699(e)(1)(A) [VERIFY] now authorizes courts to **limit the scope of the claim or the evidence** presented at trial to ensure it can be effectively tried. In practice: move early to limit the representative period, the clinics, and the theories to what the plaintiff personally experienced; propose a sampling plan for the remaining group; and use the 60-day "reasonable steps" window to build the record for the 30% cap.

## 5. Sterling Medical action items

1. Complete the payroll analysis (Kronos exports for all 14 clinics) before the LWDA cure period ends on **2026-10-21**.
2. Adopt written meal-period attestation and a no-rounding policy before day 60 (2026-10-10) to preserve the 30% cap.
3. Prepare the early-evaluation-conference statement now so it can be filed within days of any complaint.
4. Arbitration: check each clinic's onboarding packet for an arbitration agreement with a PAGA individual-claim carve-out (Viking River / Adolph analysis).`,
  },
  {
    id: "lib_note_depo_objections",
    parentId: K.litigation,
    name: "Deposition objection quick reference",
    description: "One-page reference for defending and taking depositions under Rule 30: which objections are waived if not made, what 'form' covers, when to instruct not to answer, and how to handle speaking objections and Rule 30(d)(3) motions.",
    tags: ["deposition", "objections", "Rule 30", "Rule 32", "quick reference"],
    practiceArea: "Litigation",
    ownerId: "p_jwhitfield",
    version: 6,
    status: "approved",
    starred: true,
    createdAt: "2023-09-12T11:00:00Z",
    updatedAt: "2026-09-19T08:00:00Z",
    content: `# Deposition objections — quick reference

## The rule

Fed. R. Civ. P. 30(c)(2): objections "must be stated concisely in a nonargumentative and nonsuggestive manner." The testimony is taken subject to the objection. A person may instruct a deponent not to answer **only** (1) to preserve a privilege, (2) to enforce a limitation ordered by the court, or (3) to present a motion under Rule 30(d)(3).

Fed. R. Civ. P. 32(d)(3)(B): objections to the **form** of a question or answer, or to errors that might be cured if promptly presented, are waived if not made at the deposition. Objections to competency, relevance or materiality are **not** waived unless the ground could have been corrected at the time.

## Objections you must make (or lose)

| Objection | What it covers | Say |
| --- | --- | --- |
| Form — leading | Suggests the answer (on direct of a friendly witness) | "Objection, leading." |
| Form — compound | Two questions in one | "Objection, compound." |
| Form — vague / ambiguous | Undefined term or time frame | "Objection, vague as to time." |
| Form — calls for speculation | Asks what someone else thought or would do | "Objection, calls for speculation." |
| Form — assumes facts not in evidence | Embedded factual premise | "Objection, assumes facts." |
| Form — mischaracterizes testimony / document | Misquotes prior answer or exhibit | "Objection, mischaracterizes the document." |
| Form — argumentative | Counsel is arguing, not asking | "Objection, argumentative." |
| Form — asked and answered | Repetition to wear the witness down | "Objection, asked and answered." |
| Foundation | Witness has not shown personal knowledge | "Objection, foundation." |
| Non-responsive (taking counsel) | Witness volunteers beyond the question | "Move to strike as non-responsive." |

Firm practice under our stipulations (Clause bank → Standard deposition stipulations): state "Objection, form" and give the basis only if examining counsel asks. Do not coach.

## Objections you can save for trial

Relevance, hearsay, best evidence, Rule 403 — all preserved without objection at the deposition. Making them anyway only educates opposing counsel.

## Instructing not to answer

Only for privilege, a court-ordered limitation, or to stop a deposition to seek a Rule 30(d)(3) order (bad faith, or annoyance/embarrassment/oppression). Say: "I instruct the witness not to answer on the ground of attorney-client privilege." Then let examining counsel make a record; do not argue.

If opposing counsel instructs improperly: "Counsel, that instruction is not permitted by Rule 30(c)(2). Are you instructing the witness not to answer?" Get a yes on the record; mark the question; move on. Certify the question if the local practice allows.

## Speaking objections and coaching

If defending counsel makes speaking objections: "Counsel, please state your objection concisely. Your commentary is suggesting an answer to the witness." Repeat once; then state on the record that you will seek relief and costs under Rule 30(d)(2).

## The seven-hour limit

Rule 30(d)(1): one day of seven hours on the record. Breaks and technical failures (see remote-deposition stipulation) do not count. Keep your own running clock; the reporter's is often generous.

## Errata

Rule 30(e) permits changes "in form or substance" with reasons within 30 days after notice of availability, but the Fourth Circuit and many district courts refuse to allow errata that contradict testimony ("sham" corrections); the original answer stays in the record either way.

## Exhibits

Mark sequentially by witness (Vasudevan 1, Vasudevan 2). Read the Bates range into the record when introducing an exhibit. Give the witness time to read it; do not let the witness be examined on a document they have not seen in full.`,
  },
  {
    id: "lib_note_bluebook_quick_guide",
    parentId: K.research,
    name: "Bluebook quick guide (21st ed.)",
    description: "Compact Bluebook reference: case citation forms, short forms, signals, pincites, statutes and regulations, and the most common mistakes in firm drafts.",
    tags: ["Bluebook", "citation", "research", "style"],
    ownerId: "p_akhan",
    version: 2,
    status: "approved",
    createdAt: "2024-05-03T09:00:00Z",
    updatedAt: "2026-05-14T10:30:00Z",
    content: `# Bluebook quick guide

## Cases (Rule 10)

**Full citation:** *Case Name*, Volume Reporter Page, Pincite (Court Year).

- Celotex Corp. v. Catrett, 477 U.S. 317, 322–23 (1986).
- Sardis v. Overhead Door Corp., 10 F.4th 268, 281 (4th Cir. 2021).
- Razor v. Hyundai Motor Am., 222 Ill. 2d 75, 90 (2006).

Case names: abbreviate per Table T6 in citations (Corp., Inc., Ass'n, Litig., Prods.); do not abbreviate the first word of a party name; omit "Inc." after "Co." Italicize (or underline) case names in briefs; use ordinary roman in law-review footnote style only.

**Short forms:**
- *Id.* — immediately preceding authority, same page: *Id.* Different page: *Id.* at 325.
- Named short form: Celotex, 477 U.S. at 324. Use when the full cite appeared in the same general discussion.
- Never use *supra* for cases in court documents.

**Parentheticals:** (holding that…), (en banc), (per curiam), (Smith, J.), (quoting …), (citing …), (emphasis added), (internal quotation marks omitted).

## Signals (Rule 1.2)

| Signal | Meaning |
| --- | --- |
| [no signal] | Directly states the proposition or is quoted |
| *See* | Clearly supports, but inference required |
| *See also* | Additional support; use with a parenthetical |
| *Cf.* | Supports by analogy; parenthetical required |
| *But see* | Contradicts |
| *See generally* | Background |
| *E.g.,* | One of many examples (can combine: *See, e.g.,*) |

Order within a string cite: signal groups in the order above; within a signal, by court hierarchy then reverse chronological.

## Statutes and regulations (Rules 12, 14)

- 15 U.S.C. § 1332(a) (diversity jurisdiction).
- Cal. Lab. Code § 2699(f) (West 2025).
- 810 ILCS 5/2-719(3).
- 49 C.F.R. § 387.307 (2025).
- Fed. R. Civ. P. 26(b)(4)(B); Fed. R. Evid. 702(d).
- Section symbol with a non-breaking space; "§§" for multiple sections.

## Record and discovery cites (Bluepages B17)

- (Compl. ¶ 42.) (Hegde Dep. 112:4–15.) (Vasudevan Rep. at 14.) (Ex. 7, MFC-0041877 at -879.)
- In federal briefs, cite ECF numbers: (ECF No. 456 at 3.)

## Common mistakes in firm drafts

1. Using "at" before a pincite in a full citation (wrong: 477 U.S. 317, at 322).
2. Italicizing "v." inconsistently — italicize the whole case name including "v."
3. "Id." after a string cite with more than one authority (ambiguous — use a named short form).
4. Missing the "F.4th" reporter for Fourth Circuit decisions after early 2021.
5. Parenthetical starting with a capital letter when it is a participial phrase ("holding that", not "Holding that").
6. Citing Westlaw for a case that has a reporter citation.`,
  },
  {
    id: "lib_note_firm_citation_style",
    parentId: K.style,
    name: "Firm citation and drafting style",
    description: "Mehra & Rao house style for briefs, memos and transactional documents: citation formatting, record cites, defined terms, numbering, [VERIFY] convention and the drafting-agent review categories.",
    tags: ["style", "citation", "drafting", "firm policy"],
    ownerId: "p_akhan",
    version: 7,
    status: "approved",
    starred: true,
    createdAt: "2023-06-01T09:00:00Z",
    updatedAt: "2026-09-01T12:00:00Z",
    content: `# Firm citation and drafting style

This note governs every document produced at Mehra & Rao, including drafts generated by the Office agents. Where it departs from the Bluebook, this note controls.

## 1. Citations in briefs

- Italicize case names, including "v." and procedural phrases (*In re*, *ex rel.*). Do not underline.
- Full citation on first reference in each major section (I, II, III); named short form thereafter; *Id.* only when the immediately preceding citation is the same authority and no other citation intervenes.
- Pincite everything. A citation without a pincite is a review finding.
- Parentheticals: participial phrase, lower-case first letter, no terminal period inside the parenthesis.
- Signals italicized; "See" is capitalized only at the start of a citation sentence.
- Avoid string cites longer than three authorities in the argument section; move the rest to a footnote.

## 2. Record cites

- Depositions: (Hegde Dep. 112:4–15.) Volume when more than one: (Vasudevan Dep. Vol. II 44:2–9.)
- Documents: Bates prefix and number, with the ending number abbreviated: (MFC-0041877 at -879.) Attach as exhibits by letter: (Ex. C, MFC-0041877.)
- Expert reports: (Sundaram Rebuttal Rep. ¶ 41.) (Patel Rep. at 12 & fig. 3.)
- Docket: (ECF No. 1204 at 6.) Use "Dkt." only in state court.
- Transcript of hearing: (Hr'g Tr. 14:6–12, Sept. 9, 2026.)

## 3. The [VERIFY] convention

Any authority, quotation, pincite, docket number or record cite that has not been checked against the source in the current drafting cycle carries the marker **[VERIFY]** immediately after it. The drafting agents insert it automatically for citations they did not read through a tool; the citation checker (Search → Citation checker) clears it. A brief may not be filed with any [VERIFY] remaining.

## 4. Defined terms

- Define on first use with quotation marks and bold: the "**Agreement**". Thereafter capitalized, no quotation marks.
- Do not define a term that is used only once.
- Defined terms in a contract go in Section 1 in alphabetical order, or inline if used only within one section; never both.
- Use "including" to mean "including without limitation" and say so once in the definitions.

## 5. Numbering and cross-references

- Briefs: I., A., 1., a. Headings are full sentences in the argument section.
- Contracts: Article 1 / Section 1.1 / (a) / (i). Use the editor's legal numbering, not manual numbers, so cross-references update.
- Cross-reference by section number and short title: "Section 9 (Confidentiality)". The Office review agent flags cross-references whose title does not match the target heading.

## 6. Tone

- Short sentences. Active voice. No "clearly", "obviously", "it is respectfully submitted".
- State the holding before the facts of a cited case.
- Do not begin an argument heading with "Whether".
- Numbers: spell out one through nine; numerals for 10 and above; always numerals for money, percentages, page cites.

## 7. Dates and names

- Dates in prose: September 23, 2026. In tables and calendars: 2026-09-23.
- Judges: "Judge [Surname]" in prose; the full name and title in captions; "the Court" (capitalized) for the court deciding the matter, "the Tribunal" for an arbitral tribunal.
- The firm: "Mehra & Rao Advocates" on first use; "the Firm" thereafter in engagement letters; "M&R" only in internal notes.

## 8. Review categories used by the Office agents

Citation · defined term · cross-reference · numbering · formatting · missing provision · risk · logic · style · formula · data · consistency · privilege. Findings at "high" or "critical" block a partner sign-off checkpoint.`,
  },
  {
    id: "lib_note_vls_clause94",
    parentId: K.litigation,
    name: "Clause 9.4 substantial-risk notice — elements and defence themes (Valsara)",
    description: "What Clause 9.4 of the 1998 Supply and Technical Services Agreement requires, the Schedule 6 Notification Protocol on 'substantial risk' and 'corroborative' information, the 30-day clock, and how the Claimant uses the notice history in the fictional Valsara arbitration.",
    tags: ["Clause 9.4", "contract", "notice", "Valsara", "knowledge timeline"],
    practiceArea: "Commercial",
    matterId: "m_valsara_arb",
    ownerId: "p_praman",
    version: 3,
    status: "approved",
    createdAt: "2025-10-06T14:00:00Z",
    updatedAt: "2026-09-14T15:45:00Z",
    content: `# Clause 9.4 — substantial-risk notice (fictional demo contract)

## The clause

Clause 9.4 of the 1998 Supply and Technical Services Agreement between Meridian Fine Chemicals Ltd. and Valsara Textile Park Ltd.: the Supplier, on obtaining "information which reasonably supports the conclusion that the Product presents a substantial risk of injury to health or the environment", shall give the Buyer written notice within 30 days, copied to the State Pollution Control Board as Schedule 6 requires.

## Schedule 6 Notification Protocol

- **"Within 30 days"** runs from the date any officer or employee capable of appreciating the significance of the information obtains it.
- **"Substantial risk"** is judged on the seriousness of the effect and the fact or probability of its occurrence; commercial considerations are irrelevant.
- **Corroborative information** (paragraph 4): information that merely confirms a well-established effect already known to the Buyer need not be notified; a new effect, a lower-dose effect, or contamination at a new location must be.
- **Pronounced bioaccumulation** (paragraph 5(c)) combined with toxicity is notifiable even where the toxicity alone is not.
- Liquidated damages under Clause 9.6 accrue per day of delay.

## Why it matters in the arbitration

The Claimant uses the notice history to build its "knowledge timeline": each study Meridian had, when it had it, and whether the Park was told. The Vasudevan and Hegde depositions focused on:

1. The March 2001 decision not to give notice after the 90-day study (MFC-0041930, MFC-0041936).
2. Whether the hepatic findings were "corroborative" (our position) or the serum persistence was pronounced bioaccumulation (the Claimant's position).
3. The 108 days between the July 2002 MW-7 results and the October 2002 letter to the Park.

## Defence themes

- The March 2001 decision was made by regulatory counsel (Sood) in good faith on the corroborative-information paragraph and was conditioned on an active investigation; document the decision trail rather than the outcome.
- Notice was given within 30 days of the 12-month interim (October 2002).
- Do not let witnesses characterize a voluntary submission to CPCB as notice under Clause 9.4 — the obligation runs to the Park.

## Related record

Timeline: notice events are tagged "regulatory" in the E-Discovery chronology. Deposition digests: Vasudevan Vol. I (2026-06-17), Hegde Vol. I (2026-05-13). Conflict cf_vls_003 (Hegde EHS memo final vs. draft) is open.`,
  },
  {
    id: "lib_note_fre502d_practice",
    parentId: K.litigation,
    name: "FRE 502(d) orders and clawback practice",
    description: "Why every case should have a Rule 502(d) order, what to put in it, how the clawback procedure interacts with Rule 26(b)(5)(B), and common negotiation points.",
    tags: ["FRE 502", "privilege", "clawback", "ESI", "protective order"],
    practiceArea: "Litigation",
    ownerId: "p_tbradley",
    version: 2,
    status: "approved",
    createdAt: "2024-11-19T10:00:00Z",
    updatedAt: "2026-07-22T15:30:00Z",
    content: `# FRE 502(d) orders and clawback practice

## The difference between 502(b) and 502(d)

- **502(b)** (default rule): an inadvertent disclosure does not waive privilege if the holder took reasonable steps to prevent it and promptly took reasonable steps to rectify it. Litigating "reasonable steps" is expensive and outcome-uncertain — it invites discovery into the review workflow.
- **502(d)**: a federal court may order that the privilege is not waived by disclosure connected with the litigation, and the order binds all other federal and state proceedings. A well-drafted 502(d) order **removes the reasonableness inquiry altogether**.

Rule: get a 502(d) order entered in every federal case with a document production, before the first production. In state court, use the analogous rule where one exists (e.g., Cal. Evid. Code § 912 does not provide the same protection; rely on the protective order and a stipulation).

## What the order should say

1. Production "whether inadvertent or otherwise" does not waive — do not accept "inadvertent" alone, which reintroduces a 502(b)-style fight over what inadvertent means.
2. "The provisions of Rule 502(b) shall not apply."
3. Binding in any other federal or state proceeding (this is the 502(d)/(e) effect; the order should say so expressly).
4. Clawback mechanics: notice by Bates number, return/sequester/destroy within a fixed period, no use pending resolution, log entry within a fixed period, motion practice with in camera submission.
5. Nothing requires a party to forgo pre-production privilege review.

The firm form is Clause bank → FRE 502(d) order and clawback procedure.

## Interaction with Rule 26(b)(5)(B)

Rule 26(b)(5)(B) already requires a receiving party to return, sequester or destroy specified information after notice, and bars use until the claim is resolved. The 502(d) order layers the non-waiver rule on top; the procedures should mirror each other so there is no argument that the order changed the Rule's default.

## Negotiation points

- **Time to return:** 5–10 business days is standard; plaintiffs' committees in large MDLs sometimes ask for 30 to allow their vendor to purge. Agree to 10 with an obligation to confirm purge from the review platform.
- **Notes and summaries:** insist that work product reflecting the contents of the clawed-back document is also sequestered.
- **Challenge window:** 21 days after the log entry. Without a deadline, challenges accumulate at the end of discovery.
- **Attorney's own recollection:** some orders bar a receiving attorney from using their recollection of the clawed-back document; courts split. Ask for it, expect to lose it.

## Operational checklist (e-discovery)

- Privilege screen terms and the attorney-name list refreshed before each production wave.
- Clawback notices logged in the review platform with the reason code; the privilege log is regenerated from the platform.
- Track the 14-day log-entry deadline in the matter calendar.
- After a clawback, run a near-duplicate and email-thread check to catch copies produced elsewhere in the volume.`,
  },
  {
    id: "lib_note_expert_disclosure_timing",
    parentId: K.litigation,
    name: "Rule 26(a)(2) expert disclosures — timing, rebuttal scope and draft protection",
    description: "Default and court-ordered timing for expert disclosures, what a rebuttal report may and may not contain, the 26(b)(4) protections for drafts and communications, and supplementation duties.",
    tags: ["Rule 26", "experts", "rebuttal", "disclosure", "scheduling"],
    practiceArea: "Litigation",
    ownerId: "p_emarsh",
    version: 2,
    status: "approved",
    createdAt: "2025-05-27T13:00:00Z",
    updatedAt: "2026-08-20T09:40:00Z",
    content: `# Rule 26(a)(2) expert disclosures

## Who must provide a written report — 26(a)(2)(B)

Witnesses "retained or specially employed to provide expert testimony," or whose duties as a party's employee regularly involve giving expert testimony. The report must contain: a complete statement of all opinions and the basis and reasons; the facts or data considered; exhibits; qualifications and publications (10 years); other testimony (4 years); and compensation.

Non-retained experts (treating physicians, in-house engineers) require only the 26(a)(2)(C) summary disclosure — subject matter and a summary of facts and opinions.

## Timing — 26(a)(2)(D)

Absent a stipulation or court order: at least **90 days** before trial; **rebuttal** disclosures within **30 days** after the other party's disclosure, and only for evidence "intended solely to contradict or rebut evidence on the same subject matter" identified by the other party.

A case management order may set a different schedule; it does not enlarge the rebuttal scope unless it says so. (In the Valsara arbitration the Tribunal's Procedural Order No. 4 governs instead; see the Procedural Order No. 3 summary.)

## What a rebuttal report may contain

- Responses to the opinions, methods and data of the opposing report.
- New analyses that respond to those opinions (e.g., re-running the opposing expert's model with corrected inputs).
- Not: affirmative opinions on subjects the opposing expert did not address; those are untimely initial opinions and are excluded under Rule 37(c)(1) unless substantially justified or harmless.

For a rebuttal to an opposing toxicology expert, the report should be organized opinion-by-opinion against the report it rebuts, with a short "scope" paragraph up front stating that each section responds to an identified opinion.

## Draft reports and attorney communications — 26(b)(4)(B)–(C)

Drafts of any report or disclosure are protected as work product regardless of form. Communications between counsel and a 26(a)(2)(B) expert are protected except to the extent they (i) relate to compensation, (ii) identify facts or data counsel provided and the expert considered, or (iii) identify assumptions counsel provided and the expert relied on. Practice: label every transmittal of facts or assumptions so the exception is administrable; never send counsel's own analysis to a testifying expert.

Consulting experts (non-testifying) are protected under 26(b)(4)(D) except on a showing of exceptional circumstances.

## Supplementation — 26(e)(2)

The duty to supplement extends to the report and to deposition testimony, and must be made by the time pretrial disclosures under 26(a)(3) are due. Supplementation is not a vehicle for new opinions.

## Daubert interaction

Build the record for any Rule 702 motion at the expert's deposition: methodology, data considered, whether the opinion is stated with the certainty the method supports (702(d)). See Knowledge → Daubert / Rule 702 cheat sheet.`,
  },
  {
    id: "lib_note_hsr_basics",
    parentId: K.transactional,
    name: "HSR filing basics for Project Harbor",
    description: "Hart-Scott-Rodino filing checklist for the Bluewater Analytics acquisition: thresholds, the 2025 form, timing, what to collect from the client, and gun-jumping cautions.",
    tags: ["HSR", "antitrust", "M&A", "Project Harbor", "closing"],
    practiceArea: "Corporate / M&A",
    matterId: "m_project_harbor",
    ownerId: "p_dokafor",
    version: 2,
    status: "draft",
    createdAt: "2026-08-25T16:00:00Z",
    updatedAt: "2026-09-20T11:00:00Z",
    content: `# HSR filing — Project Harbor

> Thresholds adjust every year in February; the figures below are the 2026 thresholds as we recorded them and must be confirmed against the FTC's Federal Register notice before filing. [VERIFY]

## Is a filing required?

- **Size-of-transaction test:** $184M purchase price (cash and stock) exceeds the 2026 minimum threshold (approx. $133.9M) [VERIFY]. Because the deal is below the larger threshold (approx. $535.5M) [VERIFY], the size-of-person test also applies.
- **Size-of-person test:** Harborline (approx. $2.1B in sales) and Bluewater (approx. $41M in sales, $28M in assets) — one party at or above the higher threshold and the other at or above the lower; satisfied. [VERIFY Bluewater's last regularly prepared balance sheet]
- **Exemptions:** none apply (not an intraperson transaction; not an acquisition of goods in the ordinary course).

## The 2025 HSR form

The revised form (effective February 10, 2025) requires substantially more than the legacy form:
- Transaction rationale narrative and overlap/supply-relationship descriptions.
- Officer and director information for the acquiring and acquired entities.
- **Item 4(c)/(d) documents** now include drafts shared with the board and documents prepared by or for the "supervisory deal team lead." Identify the deal team lead now and instruct on document discipline.
- Prior acquisitions in overlapping lines of business (five years).
- Minority-holder information for certain investors.

## Timing

- Target: file within 10 business days after SPA signing (SPA § 6.4 requires filing within 10 business days) — signing target 2026-10-30, filing 2026-11-06 (already on the matter calendar).
- Waiting period: **30 days** from both parties' filings (15 for cash tender offers, not applicable). Early termination requests are being granted again but should not be assumed.
- A Second Request would extend closing well past the outside date (2027-02-28); the SPA should include a reverse termination fee only if the client accepts that risk.

## What to collect from Harborline

1. Last regularly prepared annual financial statements and balance sheet.
2. Revenue by NAICS code (6-digit) for both parties.
3. Organization chart to the ultimate parent entity.
4. All board decks, banker books and CIMs discussing the transaction, competition, markets or synergies (Item 4(c)).
5. Deal team roster with the supervisory lead identified.
6. List of prior acquisitions since 2021 in analytics/ML services.

## Gun-jumping cautions (Sherman Act § 1 and HSR § 7A)

- No coordination on pricing, customer allocation or bids before closing.
- Integration planning through clean teams with counsel-approved protocols; competitively sensitive information (customer-level pricing, pipeline) only to a clean team.
- Ordinary-course covenants in the SPA should not give the buyer consent rights over pricing or customer terms.

## Filing fee

Based on the transaction value tier (approx. $30,000 for the $184M tier) [VERIFY]; payable by the acquiring person; SPA allocates 50/50.`,
  },
  {
    id: "lib_note_esi_protocol_checklist",
    parentId: K.litigation,
    name: "ESI protocol negotiation checklist",
    description: "Every term to cover in an ESI protocol, with the firm's default position and the usual counterparty asks: custodians, date ranges, search methodology, TAR, production format, metadata fields, privilege logging and cost shifting.",
    tags: ["ESI", "e-discovery", "protocol", "production format", "metadata"],
    practiceArea: "Litigation",
    ownerId: "p_tbradley",
    version: 4,
    status: "approved",
    createdAt: "2024-03-20T10:00:00Z",
    updatedAt: "2026-08-28T17:00:00Z",
    content: `# ESI protocol negotiation checklist

| Term | Firm default | Typical ask from the other side | Notes |
| --- | --- | --- | --- |
| Custodians | Named list per party, capped (8–12) | "All employees with relevant knowledge" | Tie to Rule 26(a)(1); require good-cause showing to add |
| Date range | Matter-specific; no open-ended "to present" | "From the beginning of the relationship to present" | Rolling supplement for specified categories only |
| Sources | Email, network shares, chat (Teams/Slack), mobile for named custodians | Backup tapes, legacy systems | Backup tapes presumptively not reasonably accessible (Rule 26(b)(2)(B)) |
| Search methodology | Search terms **or** TAR at producing party's election, with disclosure | Joint search-term negotiation with hit reports | Agree to hit reports for proposed terms; refuse "hit count = must review" |
| TAR | Permitted; workflow disclosed; elusion sample validation; recall target 75% | Seed-set transparency; 85% recall | See Clause bank → ESI protocol TAR disclosure |
| De-duplication | Global (across custodians) by MD5/SHA-1; all-custodian field | Per-custodian only | Global with the DupeCustodian field is the standard |
| Email threading | Inclusive-only production permitted | Full thread production | Agree to produce lesser-included on request |
| Production format | Single-page TIFF + text + load file; natives for spreadsheets, presentations, audio/video, and on request | All native | TIFF with extracted text; color where color matters |
| Metadata fields | BegBates, EndBates, BegAttach, EndAttach, Custodian, AllCustodians, From, To, CC, BCC, Subject, DateSent, DateReceived, FileName, FileExt, Hash, NativeLink, TextLink, Confidentiality, RedactionFlag | Additional fields (e.g., DateLastModified for all) | Provide the standard 25-field list from the firm form |
| Redactions | Privilege and PII only; log the basis | Relevance redactions | Relevance redactions only by agreement or order |
| Privilege log | Metadata-based log; categorical logging for post-complaint communications with counsel | Document-by-document log with descriptions | Attach the 502(d) order |
| Hard copy | Scanned with logical unitization | OCR only | Unitize at the document level; family with attachments |
| Chat | Produced in conversational slices (24-hour) with participants | Full channel exports | Slice by day; produce native export on request |
| Mobile | Named custodians only; text messages for date range | Full forensic images | Collect through MDM or vendor tool; produce in slices |
| Cost shifting | None for standard; requester pays for not-reasonably-accessible sources | Producing party bears all | Reserve Rule 26(c)(1)(B) argument |
| Deadlines | Rolling productions; substantial completion date | Fixed single date | Report status at each production wave |

## Sequence

1. Send the firm form protocol with the first Rule 26(f) proposal; do not wait for the other side's draft.
2. Exchange custodian lists and data maps before negotiating terms.
3. Resolve production format and metadata first — they are rarely contested and set a cooperative tone.
4. Search methodology and TAR last, with hit reports in hand.
5. Have the 502(d) order and protective order entered together with the ESI protocol.

## Vendor coordination

Tanmay Bhatt owns the vendor relationship. Before agreeing to any production spec, confirm with the vendor that the platform exports the field list exactly as named in the protocol; renaming fields after the fact costs more than the negotiation.`,
  },
];
