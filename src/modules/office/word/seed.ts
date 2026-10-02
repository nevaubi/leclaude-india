import "server-only";
import { matterFolderId } from "@/modules/library/ids";
import type { Database } from "@/lib/db";
import type { LibraryItem, OfficeComment } from "@/lib/types/domain";
import { MATTERS, PEOPLE } from "@/lib/seed/ids";
import { createOfficeDoc, saveOfficeDoc } from "@/modules/office/shared/docs-service";
import { settingsForTemplate } from "./constants";
import { cloneNode, findNodeById, inlineFromMarkdown, makeTable, type PMNode } from "./doc-model";
import { captionBlock, captionFromMatter, certificateOfService, signatureBlock, type FirmInfo } from "./sections";

/** Letterhead of the sample firm (demo dataset only; templates use placeholders). */
const FIRM: FirmInfo = { name: "Mehra & Rao Advocates", address1: "21 Kasturba Gandhi Marg, 7th Floor", address2: "New Delhi 110001", phone: "+91 11 5550 0140", email: "amehra@mehrarao.example" };
import { buildDoc, motionBriefDoc } from "./templates";
import { buildTrackedInline, markBlocksInserted } from "./tracked-diff";

const AGENT = { name: "Drafting assistant" };
const T = (d: string) => new Date(d).toISOString();

interface SeedDoc {
  id: string;
  title: string;
  matterId: string;
  templateId?: string;
  v1: PMNode;
  /** Later versions: content transform + summary/label. */
  versions: { summary: string; label?: string; author?: string; transform: (doc: PMNode) => PMNode }[];
  comments: { id: string; find: string; body: string; author?: string; agent?: boolean; quote?: string; createdAt: string; resolved?: boolean; replies?: { id: string; body: string; authorName: string; createdAt: string }[] }[];
  tags?: string[];
  createdAt: string;
}

function blockIdWithText(doc: PMNode, needle: string): string {
  let found = "";
  const walk = (n: PMNode) => {
    if (found) return;
    if ((n.type === "paragraph" || n.type === "heading") && (n.content ?? []).map((c) => c.text ?? "").join("").includes(needle)) { found = String(n.attrs?.id ?? ""); return; }
    for (const c of n.content ?? []) walk(c);
  };
  walk(doc);
  return found;
}

/** Replace a paragraph's text (found by substring) with a tracked rewrite. */
function trackedRewrite(doc: PMNode, needle: string, markdown: string, author = AGENT.name, date = "2026-09-21T15:42:00Z"): PMNode {
  const out = cloneNode(doc);
  const id = blockIdWithText(out, needle);
  const loc = id ? findNodeById(out, id) : null;
  if (!loc) return out;
  loc.node.content = buildTrackedInline(loc.node.content, inlineFromMarkdown(markdown), { change: { id: `chg_${id}`, author, date } });
  return out;
}

/** Insert blocks after the paragraph containing `needle`, marked as tracked insertions. */
function trackedInsertAfter(doc: PMNode, needle: string, blocks: PMNode[], author = AGENT.name, date = "2026-09-21T15:44:00Z"): PMNode {
  const out = cloneNode(doc);
  const id = blockIdWithText(out, needle);
  const loc = id ? findNodeById(out, id) : null;
  if (!loc) return out;
  const marked = markBlocksInserted(cloneNode(blocks), { id: `ins_${id}`, author, date });
  loc.parent.content!.splice(loc.indexInParent + 1, 0, ...marked);
  return out;
}

function untrackedReplace(doc: PMNode, needle: string, markdown: string): PMNode {
  const out = cloneNode(doc);
  const id = blockIdWithText(out, needle);
  const loc = id ? findNodeById(out, id) : null;
  if (loc) loc.node.content = inlineFromMarkdown(markdown);
  return out;
}

export function seedWord(db: Database) {
  const depo = db.matters.get(MATTERS.depo);
  const northgate = db.matters.get(MATTERS.northgate);
  const sterling = db.matters.get(MATTERS.sterling);

  const docs: SeedDoc[] = [
    // 1. Motion and supporting brief (the screenshot document)
    {
      id: "wd_depo_motion_brief",
      title: "Motion and supporting brief",
      matterId: MATTERS.depo,
      templateId: "word-motion-brief",
      createdAt: "2026-09-18T14:05:00Z",
      v1: motionBriefDoc(depo, "Motion and supporting brief"),
      versions: [
        {
          summary: "Agent edit: Tightened the Legal standard section and added FRCP 56(a)",
          author: AGENT.name,
          transform: (d) => trackedRewrite(d, "Summary judgment is appropriate where", "Summary judgment must be granted where “there is no genuine dispute as to any material fact and the movant is entitled to judgment as a matter of law.” Fed. R. Civ. P. 56(a). A dispute is genuine only if a reasonable jury could return a verdict for the nonmoving party, and material only if it could affect the outcome under the governing law. [Anderson, 477 U.S. at 248] [VERIFY]. Where the nonmovant bears the burden of proof at trial, the movant discharges its initial burden by pointing to the absence of evidence on an essential element; the nonmovant must then come forward with specific, admissible facts — not speculation or conclusory allegations — showing a genuine issue for trial. [Celotex, 477 U.S. at 322–25] [VERIFY]; Fed. R. Civ. P. 56(c)(1)."),
        },
        {
          summary: "Agent edit: Converted Argument I to a numbered outline and flagged placeholder citations",
          author: AGENT.name,
          transform: (d) => trackedInsertAfter(d, "Plaintiffs' only response is a market-share inference", buildDoc(["@outline 1. Product identification is an element of every claim. [VERIFY]\n2. The record identifies three distributors, none of which purchased from the client during the relevant period.\n3. Market-share inference is unavailable under the governing law. [VERIFY]"]).content ?? []),
        },
        { summary: "Checkpoint", label: "Before partner review", transform: (d) => d },
      ],
      comments: [
        { id: "wc_vls_motion_1", find: "Because product identification is an essential element", body: "Placeholder case citations inserted for testing only; replace with actual Bluebook citations before filing.", agent: true, quote: "[Celotex Corp. v. Catrett, 477 U.S. 317, 322–23 (1986)]", createdAt: "2026-09-21T15:45:00Z" },
        { id: "wc_vls_motion_2", find: "Plaintiffs' only response is a market-share inference", body: "Need the circuit cite rejecting market-share liability for distributors — Esha, can you check whether the MDL court has issued any product-identification order?", author: PEOPLE.arjunMehra, createdAt: "2026-09-22T09:12:00Z", replies: [{ id: "wcr_vls_motion_2a", body: "On it. Nothing on the MDL docket yet; I will pull the circuit authority instead. [VERIFY]", authorName: "Esha Mathur", createdAt: "2026-09-22T10:40:00Z" }] },
        { id: "wc_vls_motion_3", find: "Procurement records produced by", body: "Confirm the declarant's exhibit numbering matches the distributor sales ledger.", author: PEOPLE.meeraLobo, createdAt: "2026-09-22T11:02:00Z", resolved: true },
      ],
      tags: ["motion", "MSJ", "draft"],
    },

    // 2. Valsara rebuttal expert outline
    {
      id: "wd_vls_rebuttal_expert_outline",
      title: "Rebuttal expert outline — Dr. Sundaram (toxicology)",
      matterId: MATTERS.valsara,
      createdAt: "2026-09-10T16:20:00Z",
      v1: buildDoc([
        "@center **PRIVILEGED & CONFIDENTIAL — ATTORNEY WORK PRODUCT — DRAFT**",
        "# Rebuttal Expert Report Outline: Dr. Leela Sundaram, Ph.D., DABT",
        `**Matter:** Valsara Textile Park Ltd. v. Meridian Fine Chemicals Ltd., Arb. Ref. 14/2024 (seat: New Delhi)\n**Responding to:** Claimant's toxicology report of [CLAIMANT'S EXPERT], served October 2, 2026\n**Rebuttal reports due:** November 6, 2026 (Procedural Order No. 4 ¶ 3(b))\n**Drafting team:** P. Raman, E. Mathur; expert liaison M. Lobo`,
        "## I. Scope of Rebuttal",
        "- Limit to opinions actually offered in the opening report (Procedural Order No. 4 ¶ 13); no new affirmative opinions.\n- Three targets: (1) the dose-response analysis linking MC-8 in the Park wellfield to the health-risk premium in the Claimant's quantum; (2) the reliance on back-calculated historical concentrations from 2016–2019 sampling; (3) the “no safe level” framing and its inconsistency with CPCB's guidance-value derivation.",
        "## II. Qualifications and Reliance Materials",
        "- CV (Ex. A); prior engagements, four years (Ex. B); declaration of independence; fees ₹[__]/hr.\n- Reliance list must include: CPCB technical basis document for MC-8 (2016); Meridian internal studies SL-2000-0417 and SL-2001-0512 (MFC-0041877, MFC-0052226, MFC-0052248); Beacon groundwater reports; deposition transcripts of H. Vasudevan (Vol. I) and G. Hegde (Vols. I–II).",
        "## III. Summary of Rebuttal Opinions",
        "@legal 1. The opening report pools rodent and occupational data with heterogeneous exposure metrics (serum MC-8 vs. groundwater concentration) without a heterogeneity test; its pooled risk estimate is driven by two high-dose rat groups.\n2. Back-calculating historical wellfield concentrations from 2016–2019 sampling ignores the documented source removal at Lagoon 2 in 2003 and produces implausibly high historical estimates.\n3. The “no safe level” statement conflates a precautionary guidance value with a toxicological threshold; the report's own Table 4 shows no effect below the two-year study NOAEL of 0.03 mg/kg-day.\n4. The report does not address background AOX in the industrial estate, which explains a substantial share of the measured load at the wellfield boundary.",
        "## IV. Methodology Section",
        "- Bradford Hill framework applied criterion by criterion.\n- Reproduce the dose-response analysis with a benchmark-dose model and leave-one-out sensitivity; attach code and data as Ex. C.\n- Address the Tribunal's directions on expert evidence (Procedural Order No. 4 ¶¶ 12–14) and the technical conferencing format.",
        "## V. Anticipated Cross-Examination Themes",
        "| Theme | Claimant's likely question | Prepared answer |\n| --- | --- | --- |\n| Prior engagement | Did Dr. Sundaram's laboratory run Meridian's own studies? | Yes — disclosed in the declaration of independence; opinions rely on the full study data and are reproducible (Ex. C). |\n| Internal studies | Did the 2001 90-day study (MFC-0041877) show hepatic effects? | Yes at doses far above any realistic exposure; the report addresses relevance of high-dose animal data. |\n| Regulatory reliance | Doesn't CPCB treat MC-8 as a persistent organohalogen of concern? | Hazard classification ≠ risk at a given dose; the guidance value reflects precaution, not a causation threshold. |",
        "## VI. Open Items",
        "- [ ] Obtain the Park's raw wellfield sampling data (production request served Sept. 3).\n- [ ] Confirm whether the opening expert relied on unpublished cohort data; if so, request the underlying data under Procedural Order No. 3.\n- [ ] Schedule working session with Dr. Sundaram week of October 6.",
      ]),
      versions: [
        { summary: "Agent edit: Added methodology section and anticipated cross-examination table", author: AGENT.name, transform: (d) => d },
        { summary: "Saved changes", transform: (d) => untrackedReplace(d, "Schedule working session", "- [ ] Schedule working session with Dr. Sundaram week of October 6 (confirmed Oct. 8, 10:00 a.m., New Delhi office).") },
      ],
      comments: [
        { id: "wc_vls_rebuttal_1", find: "The opening report pools rodent and occupational data", body: "Ask Dr. Sundaram which benchmark-dose model family she used for the recalculation — the Claimant will probe this.", author: PEOPLE.priyaRaman, createdAt: "2026-09-12T13:20:00Z" },
        { id: "wc_vls_rebuttal_2", find: "Address the Tribunal's directions on expert evidence", body: "[VERIFY] Confirm the paragraph numbers in Procedural Order No. 4 before we lift them into the report.", agent: true, createdAt: "2026-09-12T13:22:00Z" },
      ],
      tags: ["expert", "rebuttal", "outline"],
    },

    // 3. Northgate MSJ opposition draft
    {
      id: "wd_northgate_msj_opposition",
      title: "Northgate — Opposition to Apex's motion for summary judgment (draft)",
      matterId: MATTERS.northgate,
      createdAt: "2026-09-15T18:40:00Z",
      v1: buildDoc([
        captionBlock(captionFromMatter(northgate, "PLAINTIFF NORTHGATE LOGISTICS, INC.'S MEMORANDUM IN OPPOSITION TO DEFENDANT'S MOTION FOR SUMMARY JUDGMENT")),
        "# INTRODUCTION",
        "Apex Freight Systems, LLC (“Apex”) asks the Court to hold, as a matter of law, that a consequential-damages waiver buried in Section 14.2 of the parties' Master Transportation Services Agreement (the “MTSA”) bars every dollar of the $3.86 million in cargo losses Northgate Logistics, Inc. (“Northgate”) suffered when Apex's Joliet cross-dock released 212 pallets of temperature-controlled pharmaceuticals to an unverified carrier. It cannot. The waiver by its terms does not apply to losses “arising from Carrier's gross negligence, willful misconduct, or breach of Section 7 (Cargo Security),” MTSA § 14.2(b) (Ex. 1), and the record — including Apex's own incident report — presents at minimum a genuine dispute on each of those exceptions.",
        "# STATEMENT OF FACTS",
        "## A. The MTSA and the Cargo Security Protocol",
        "Northgate and Apex executed the MTSA effective March 1, 2023. Ex. 1. Section 7 requires Apex to “verify the identity and authorization of any carrier tendering for pickup by reference to the Shipper's daily dispatch manifest” and to “refuse tender to any carrier not appearing on the manifest.” MTSA § 7.3. Section 11 requires Apex to maintain $5 million in cargo liability coverage. MTSA § 11.1.",
        "## B. The February 9, 2026 Release",
        "On February 9, 2026, a driver presenting a forged bill of lading for “Midwest Reefer Express” arrived at Apex's Joliet cross-dock. NG-000412. The dock supervisor, Marcus Bell, did not check the dispatch manifest — which listed a different carrier for the load — because, in his words, the terminal was “slammed” and the paperwork “looked fine.” Bell Dep. 74:12–76:3. Apex's internal incident report concluded that “[t]he release was a preventable failure to follow SOP 7-B.” APX-002917 at 2.",
        "## C. Northgate's Losses",
        "The 212 pallets, valued at $3,862,400 at invoice, were never recovered. NG-001188 (loss schedule); Declaration of Priya Anand ¶¶ 4–9. Northgate's customer, [PHARMA CUSTOMER], terminated its distribution agreement on April 30, 2026, citing the loss. NG-001301.",
        "# LEGAL STANDARD",
        "Summary judgment is appropriate only where “there is no genuine dispute as to any material fact.” Fed. R. Civ. P. 56(a). The Court views the evidence in the light most favorable to the nonmovant and draws all reasonable inferences in its favor. [Anderson v. Liberty Lobby, Inc., 477 U.S. 242, 255 (1986)] [VERIFY]. Under Illinois law, which governs the MTSA (§ 18.1), contractual limitations on liability are strictly construed against the party seeking their protection and do not extend to gross negligence or willful misconduct absent clear language. [Illinois authority] [VERIFY].",
        "# ARGUMENT",
        "## I. The Consequential-Damages Waiver Does Not Apply Because the Losses Arise from a Breach of Section 7",
        "Section 14.2(b) carves out from the waiver any loss “arising from … breach of Section 7.” Apex's own report admits the release violated SOP 7-B, the procedure implementing Section 7.3. APX-002917 at 2. That admission alone creates a triable issue. Apex's contrary argument — that Section 7 governs only “physical security of the facility” — reads the words “identity and authorization of any carrier” out of § 7.3 and violates the rule that contracts are construed to give effect to every provision. [Illinois authority] [VERIFY].",
        "## II. A Reasonable Jury Could Find Gross Negligence",
        "Gross negligence under Illinois law is “a failure to exercise even slight care.” [Authority] [VERIFY]. Releasing $3.8 million of pharmaceuticals to a carrier absent from the manifest, without a single verification step, after two prior near-miss incidents documented at the same terminal (APX-001402; APX-001577), is evidence from which a jury could find far more than ordinary negligence.",
        "## III. The Cargo Losses Are Direct, Not Consequential, Damages",
        "Even if the waiver applied, the invoice value of cargo lost in the carrier's custody is the direct and natural result of the breach — the very thing Apex was paid to protect — not consequential loss. [Authority distinguishing direct from consequential damages for lost goods] [VERIFY]. At most, only the lost-customer damages in Count III implicate the waiver, and those are properly reserved for trial.",
        "# CONCLUSION",
        "Apex's motion should be denied in its entirety. In the alternative, the Court should deny the motion as to Counts I and II and defer ruling on Count III pending trial.",
        signatureBlock({ date: "October 9, 2026", attorney: "Dhruv Oberoi", barNo: "ARDC No. 6312847", forParty: "Plaintiff Northgate Logistics, Inc.", firm: FIRM }),
        certificateOfService({ date: "October 9, 2026", documentTitle: "Memorandum in Opposition", attorney: "Dhruv Oberoi" }),
      ]),
      versions: [
        { summary: "Agent edit: Added Argument III on direct vs. consequential damages", author: AGENT.name, transform: (d) => d },
        { summary: "Agent edit: Cite-check flagged 5 placeholder citations", author: AGENT.name, transform: (d) => trackedRewrite(d, "Gross negligence under Illinois law", "Gross negligence under Illinois law is “a failure to exercise even slight care” or “very great negligence.” [Authority] [VERIFY]. Releasing $3.8 million of pharmaceuticals to a carrier absent from the manifest, without a single verification step, after two prior near-miss incidents documented at the same terminal (APX-001402; APX-001577), is evidence from which a jury could find far more than ordinary negligence.") },
      ],
      comments: [
        { id: "wc_northgate_1", find: "Gross negligence under Illinois law", body: "[VERIFY] Placeholder authority for the gross negligence standard — candidates: the Illinois Supreme Court's formulation in the common-carrier context. Confirm before filing.", agent: true, quote: "[Authority] [VERIFY]", createdAt: "2026-09-19T17:05:00Z" },
        { id: "wc_northgate_2", find: "Northgate's customer,", body: "Client asked us not to name the pharma customer in a public filing — file this paragraph under seal or refer to “Customer A.”", author: PEOPLE.dhruvOberoi, createdAt: "2026-09-20T08:30:00Z" },
      ],
      tags: ["MSJ", "opposition", "N.D. Ill."],
    },

    // 4. Project Harbor SPA issues list
    {
      id: "wd_harbor_spa_issues_list",
      title: "Project Harbor — SPA issues list (Buyer draft 4)",
      matterId: MATTERS.harbor,
      createdAt: "2026-09-19T21:10:00Z",
      v1: buildDoc([
        "@center **PRIVILEGED & CONFIDENTIAL — ATTORNEY-CLIENT COMMUNICATION**",
        "# Project Harbor — Stock Purchase Agreement Issues List",
        "**Buyer:** Harborline Technologies, Inc.\n**Target:** Bluewater Analytics, Inc.\n**Draft:** Seller's draft 3 (Sept. 17, 2026) vs. Buyer's proposed draft 4\n**Prepared by:** D. Oberoi / S. Chawla\n**Status as of:** September 22, 2026",
        "## Executive Summary",
        "Four issues remain open that affect deal certainty or value: (1) the IP assignment chain for the core ML models (§ 3.12); (2) change-of-control consents for the top-20 customer contracts as a closing condition (§ 6.2(d)); (3) the R&W insurance retention and the survival of fundamental reps (§ 8); and (4) the earn-out revenue definition (§ 2.5). Everything else is at or near agreed language.",
        "## Open Issues",
        makeTable(
          ["#", "Section", "Issue", "Seller position (draft 3)", "Buyer position (draft 4)", "Risk", "Owner"],
          [
            ["1", "§ 3.12 / Sched. 3.12(b)", "IP assignment chain for the core ML models", "Rep limited to “Knowledge of Seller”; three contractor agreements lack present-tense assignment language", "Flat rep; pre-closing covenant to obtain confirmatory assignments from the three contractors (Nguyen, Phadke, Okoro Labs); special indemnity uncapped for IP title", "High", "S. Chawla"],
            ["2", "§ 6.2(d)", "Change-of-control consents", "Consents from top-10 customers only; others “commercially reasonable efforts”", "Consents from customers representing ≥ 85% of TTM revenue (top-20) as a condition; Seller bears cost of consent fees", "High", "D. Oberoi"],
            ["3", "§ 8.1 / § 8.4", "Survival and R&W insurance retention", "General reps survive 12 months; retention 1% of EV; fundamental reps 3 years", "General reps 18 months; retention 0.75% dropping to 0.5% at 12 months; fundamental reps survive to statute of limitations; fraud carve-out", "Medium", "D. Oberoi"],
            ["4", "§ 2.5 / Ex. B", "Earn-out revenue definition", "GAAP revenue incl. one-time services and pass-through cloud costs", "Recurring subscription revenue only, net of credits and pass-through costs; Buyer operational covenants limited to “good faith”", "Medium", "S. Chawla"],
            ["5", "§ 5.9", "Employee retention pool", "$4.0M pool allocated by Seller pre-closing", "$4.0M pool; allocation by Buyer with Seller consultation; forfeiture on voluntary departure within 12 months", "Low", "S. Chawla"],
            ["6", "§ 3.18", "Privacy / data compliance rep", "Compliance with “applicable privacy laws” in all material respects", "Add specific reps on CCPA/CPRA, GDPR Art. 28 processor terms, and model-training data provenance", "Medium", "A. Khan"],
            ["7", "§ 10.2", "Governing law / forum", "Delaware law; Delaware Chancery", "Agreed", "Closed", "—"],
          ],
        ),
        "## Issue Detail",
        "### 1. IP assignment chain (§ 3.12)",
        "Diligence identified three contractor agreements (2021–2023) under which portions of the feature-engineering pipeline were developed. Two use “agrees to assign” language, which under [Stanford v. Roche, 563 U.S. 776 (2011)] [VERIFY] does not effect a present assignment; the third (Okoro Labs) has no assignment clause at all. Buyer requires confirmatory assignments as a closing deliverable (§ 6.2(h)) and a special indemnity. Seller has indicated the contractors are cooperative; we have drafted the confirmatory assignment (Ex. F).",
        "### 2. Change-of-control consents (§ 6.2(d))",
        "Of the top-20 customer agreements, 14 contain change-of-control or anti-assignment provisions. The largest (Meridian Health, 11% of TTM revenue) requires written consent not to be unreasonably withheld. Recommendation: condition closing on consents representing 85% of TTM revenue, with a Buyer walk right if Meridian Health does not consent by the outside date.",
        "### 3. Survival and R&W insurance (§ 8)",
        "The RWI binder (Euclid, $18.4M limit) contemplates a 0.75% retention dropping to 0.5% after 12 months. Seller's proposed 1% retention is inconsistent with the binder and shifts $460k of risk to Buyer. Fundamental reps (organization, capitalization, authority, title to shares, taxes) should survive to the statute of limitations plus 60 days.",
        "### 4. Earn-out definition (§ 2.5)",
        "Seller's definition captures $2.1M of one-time implementation services in the TTM base, inflating the target. Buyer's definition limits the metric to recurring subscription revenue recognized under ASC 606, net of credits. Agree to a post-closing dispute mechanism with an independent accountant (§ 2.5(f)).",
        "## Next Steps",
        "- [ ] Turn draft 4 to Seller's counsel (Whitlock & Barrera) by Sept. 24.\n- [ ] Call with Euclid re: retention step-down — Sept. 25.\n- [ ] Contractor confirmatory assignments circulated — Sept. 26.\n- [ ] HSR filing preparation kick-off (target Nov. 6) — S. Chawla.",
      ]),
      versions: [
        { summary: "Agent edit: Reorganized issues by risk and added executive summary", author: AGENT.name, transform: (d) => d },
        { summary: "Saved changes", transform: (d) => untrackedReplace(d, "Turn draft 4 to Seller's counsel", "- [x] Turn draft 4 to Seller's counsel (Whitlock & Barrera) by Sept. 24 — sent Sept. 23.") },
      ],
      comments: [
        { id: "wc_harbor_1", find: "Diligence identified three contractor agreements", body: "Seller's counsel says Okoro Labs was an employee, not a contractor, for the relevant period — need the payroll records before we push the special indemnity.", author: PEOPLE.dhruvOberoi, createdAt: "2026-09-22T14:15:00Z" },
        { id: "wc_harbor_2", find: "Two use “agrees to assign” language", body: "[VERIFY] Stanford v. Roche pin cite — the present-assignment holding is at 563 U.S. 776, 785–86 (2011).", agent: true, createdAt: "2026-09-22T14:16:00Z" },
      ],
      tags: ["M&A", "SPA", "issues list"],
    },

    // 5. Sterling PAGA response letter
    {
      id: "wd_sterling_paga_response",
      title: "Sterling Medical — Response to LWDA PAGA notice (draft)",
      matterId: MATTERS.sterling,
      createdAt: "2026-09-17T15:00:00Z",
      v1: buildDoc([
        `@right **${FIRM.name}**\n${FIRM.address1}\n${FIRM.address2}`,
        "September 26, 2026",
        "**VIA ONLINE SUBMISSION AND CERTIFIED MAIL**",
        "Labor and Workforce Development Agency\nPAGA Administrator\n1515 Clay Street, Suite 801\nOakland, California 94612",
        "[AGGRIEVED EMPLOYEE'S COUNSEL]\n[FIRM]\n[ADDRESS]",
        "**Re:** LWDA Case No. LWDA-CM-[______]-26 — PAGA Notice submitted August 21, 2026 on behalf of [EMPLOYEE] — Response of Sterling Medical Group, P.C.",
        "Dear PAGA Administrator and Counsel:",
        "This firm represents Sterling Medical Group, P.C. (“Sterling”) in connection with the Private Attorneys General Act notice submitted on behalf of [EMPLOYEE] (the “Notice”). Sterling submits this response pursuant to Labor Code section 2699.3 and, as to the alleged wage-statement and rounding violations, provides notice of cure under Labor Code sections 2699.3(c) and 2699.5 as amended by the 2024 reforms (AB 2288 / SB 92).",
        "## I. The Notice Does Not Satisfy Section 2699.3(a)(1)(A)",
        "The Notice alleges, in conclusory terms, that Sterling “failed to provide compliant meal periods” and “rounded time entries to the employer's benefit” at fourteen clinics. It identifies no clinic, no time period, no policy, and no facts specific to [EMPLOYEE]. A notice must state “the specific provisions of this code alleged to have been violated, including the facts and theories to support the alleged violation.” Cal. Lab. Code § 2699.3(a)(1)(A); see [Williams v. Superior Court, 3 Cal. 5th 531, 545–46 (2017)] [VERIFY]; [Brown v. Ralphs Grocery Co., 28 Cal. App. 5th 824, 835–37 (2018)] [VERIFY]. Sterling reserves all objections to the sufficiency of the Notice and to the standing of [EMPLOYEE] to pursue claims for periods or locations in which [he/she] did not work.",
        "## II. Sterling's Meal-Period Practices Comply with Brinker",
        "Sterling's written policy (Ex. A, Employee Handbook § 6.2, rev. Jan. 2025) provides a duty-free, uninterrupted 30-minute meal period beginning no later than the end of the fifth hour of work, with a second meal period for shifts over ten hours, and a one-hour premium at the regular rate for any non-compliant period. The policy tracks [Brinker Restaurant Corp. v. Superior Court, 53 Cal. 4th 1004, 1040–41 (2012)] [VERIFY] and the premium-rate rule of [Ferra v. Loews Hollywood Hotel, LLC, 11 Cal. 5th 858 (2021)] [VERIFY]. Timekeeping records for the 12-month look-back period show a meal-period compliance rate of 96.8% across the 14 clinics, with premiums paid automatically through the Kronos exception report for 3,211 of the 3,244 late or short periods identified. Ex. B (summary analysis).",
        "## III. Rounding",
        "Sterling discontinued quarter-hour rounding at all clinics effective March 1, 2025, in light of [Camp v. Home Depot U.S.A., Inc., 84 Cal. App. 5th 638 (2022)] [VERIFY] and the Supreme Court's grant of review. For the period before March 1, 2025, Sterling's rounding was neutral in practice: a Kronos audit of 412,000 punches shows employees were paid for 218 more hours in the aggregate than actual punch time. Ex. C. Neutral rounding remains lawful under [See's Candy Shops, Inc. v. Superior Court, 210 Cal. App. 4th 889 (2012)] [VERIFY].",
        "## IV. Notice of Cure",
        "Without conceding any violation, and to eliminate any dispute, Sterling has taken the following steps within the 33-day cure period:",
        "1. Issued corrected wage statements for the pay periods identified in Exhibit D, adding the inclusive dates of the pay period and the employer's full legal name and address (Lab. Code § 226(a)(6), (8)), and provided written notice of the correction to each affected employee (Ex. E).\n2. Paid, with interest, meal-period premiums for the 33 exception-report periods not previously captured, totaling $1,873.50 (Ex. F).\n3. Confirmed in writing to all clinic managers that rounding is disabled and that the meal-period attestation prompt is mandatory at clock-out (Ex. G).",
        "Sterling accordingly gives notice under Labor Code section 2699.3(c)(2)(A) that the alleged violations of sections 226(a)(6) and 226(a)(8) have been cured, and requests that the Agency so determine.",
        "## V. Reservation of Rights",
        "Sterling denies each allegation in the Notice, reserves all defenses including manageability and the limits on penalty stacking under section 2699(f) and (g) as amended, and reserves the right to seek early evaluation and a stay under section 2699.3(g). This letter is not a waiver of any privilege; the exhibits are provided for the Agency's evaluation and are designated confidential.",
        "Please direct all correspondence to the undersigned.",
        "Respectfully submitted,",
        `\n\n**Sameer Chawla**\n${FIRM.name}\nschawla@mehrarao.example`,
        "cc: Arjun Mehra; Sterling Medical Group, P.C. (via email)",
      ]),
      versions: [
        { summary: "Agent edit: Added Section IV notice of cure under the 2024 PAGA reforms", author: AGENT.name, transform: (d) => d },
        { summary: "Agent edit: Review — flagged 6 citations for verification", author: AGENT.name, transform: (d) => d },
      ],
      comments: [
        { id: "wc_sterling_1", find: "Timekeeping records for the 12-month look-back", body: "Payroll analysis is still running for clinics 11–14; the 96.8% figure covers clinics 1–10 only. Update before sending.", author: PEOPLE.sameerChawla, createdAt: "2026-09-20T16:48:00Z" },
        { id: "wc_sterling_2", find: "Sterling discontinued quarter-hour rounding", body: "[VERIFY] Camp v. Home Depot — confirm current status of the Supreme Court review and whether the opinion remains citable.", agent: true, createdAt: "2026-09-20T16:50:00Z" },
      ],
      tags: ["PAGA", "letter", "LWDA"],
    },

    // 6. Research memo on Clause 9.4
    {
      id: "wd_vls_clause94_memo",
      title: "Research memo — Clause 9.4 substantial-risk notice and the knowledge timeline",
      matterId: MATTERS.valsara,
      templateId: "word-research-memo",
      createdAt: "2026-09-08T12:30:00Z",
      v1: buildDoc([
        `@center **${FIRM.name.toUpperCase()}**`,
        "@center **PRIVILEGED & CONFIDENTIAL — ATTORNEY WORK PRODUCT**",
        "@center # MEMORANDUM",
        "**TO:** Arjun Mehra, Priya Raman\n**FROM:** Esha Mathur\n**DATE:** September 8, 2026\n**RE:** Valsara v. Meridian (Arb. Ref. 14/2024) — Clause 9.4 substantial-risk notice obligations and the Meridian knowledge timeline (2001–2002)",
        "---",
        "# I. QUESTIONS PRESENTED",
        "1. When did Clause 9.4 of the 1998 Supply and Technical Services Agreement require Meridian to give Valsara Textile Park notice of information about MC-8 toxicity or persistence, and what standard governs whether information “reasonably supports the conclusion” of substantial risk?\n2. If notice was late, what is the measure of the Park's recovery: liquidated damages under Clause 9.6, general damages, or both?",
        "# II. BRIEF ANSWERS",
        "1. Clause 9.4 requires notice within 30 days of information that reasonably supports the conclusion that the Product presents a substantial risk of injury to health or the environment. Schedule 6 makes the test objective and lists pronounced bioaccumulation combined with toxicity as notifiable. The March 2001 90-day study (MFC-0041877) and the September 2001 MW-7 detection (MFC-0041988) are the Claimant's strongest trigger dates; notice was given in October 2002. [VERIFY against the executed Agreement]\n2. Clause 9.6 names a per-day sum. Under section 74 of the Indian Contract Act, 1872 the Park can recover reasonable compensation not exceeding the named sum; whether it must prove actual loss turns on whether loss was capable of proof. [Kailash Nath Associates v. DDA, (2015) 4 SCC 136] [VERIFY]. General damages for remediation sit under section 73 and Clause 12 (indemnity).",
        "# III. FACTS",
        "The relevant internal documents, in date order, are summarized in the chronology at Exhibit A (from the e-discovery timeline, tl_vls_006 through tl_vls_043). In summary: (a) 14 March 2001 — Sundaram Laboratories delivers the 90-day study (MFC-0041877); (b) 19–22 March 2001 — Sood drafts a Clause 9.4 notice and an analysis memo; Kapur advises that the hepatic findings are corroborative and the kinetic finding preliminary (MFC-0041915, MFC-0041921, MFC-0041930); (c) 26 March 2001 — decision not to give notice, conditioned on further studies (MFC-0041936); (d) September 2001 — first MC-8 detection at MW-7 (MFC-0041988); (e) October 2002 — notice given after the 12-month bioassay interim.",
        "# IV. DISCUSSION",
        "## A. The Clause 9.4 Standard",
        "Clause 9.4 obliges the Supplier, on obtaining information which “reasonably supports the conclusion” of substantial risk, to give written notice within 30 days, copied to the State Pollution Control Board. Schedule 6 defines substantial risk by reference to the seriousness of the effect and the likelihood of exposure and lists “pronounced bioaccumulation” as notifiable when combined with toxicity data (paragraph 5(c)).",
        "## B. The “Corroborative Information” Defence",
        "Paragraph 4 of Schedule 6 excuses notice of information that merely confirms an effect already known to the Buyer. Kapur's 2001 rationale (MFC-0041921) will therefore be tested against what the Park actually knew in 2001. It knew nothing about MC-8 persistence; the published literature concerned other manufacturers' compounds. [VERIFY against the Park's correspondence file]",
        "## C. Measure of Recovery",
        "Liquidated damages under Clause 9.6 are recoverable only as reasonable compensation up to the named sum (Indian Contract Act, 1872, s. 74). [Authority] [VERIFY]. The remediation claim is an indemnity claim under Clause 12 and requires proof of the costs and of causation from Lagoon 2. The notice history is also relevant to the Claimant's case on the MSDS and product-literature warranties (Clause 8.2).",
        "# V. RECOMMENDATIONS",
        "- Prepare the Respondent's case that the March 2001 decision was a good-faith reading of paragraph 4, conditioned on an active investigation.\n- Address the Clause 9.6 quantum separately; insist on proof of loss.\n- Retain an expert on industry practice for supply-contract notices in the textile-chemicals sector (2000–2002).\n- Align timeline entries tl_vls_006 through tl_vls_043 with the deposition testimony of Vasudevan and Hegde.",
        "# VI. AUTHORITIES",
        "- 1998 Supply and Technical Services Agreement, Clauses 8.2, 9.4, 9.6, 12 and Schedule 6 (fictional demo contract)\n- Indian Contract Act, 1872, ss. 73–74\n- [Kailash Nath Associates v. DDA, (2015) 4 SCC 136] [VERIFY]\n- Arbitration and Conciliation Act, 1996 (procedure only)",
      ]),
      versions: [
        { summary: "Agent edit: Expanded Discussion B on the corroborative-information defence with the Schedule 6 cite", author: AGENT.name, transform: (d) => d },
        { summary: "Checkpoint", label: "Sent to AM/PR", transform: (d) => d },
      ],
      comments: [
        { id: "wc_clause94_1", find: "Kapur's 2001 rationale", body: "This is the single most important document in the knowledge timeline. Make sure the chronology cross-references MFC-0041921 to Vasudevan Vol. I 147:16.", author: PEOPLE.arjunMehra, createdAt: "2026-09-09T07:55:00Z", replies: [{ id: "wcr_clause94_1a", body: "Added to tl_vls_015 with the transcript cite.", authorName: "Esha Mathur", createdAt: "2026-09-09T11:20:00Z" }] },
      ],
      tags: ["memo", "Clause 9.4", "research"],
    },

    // 7. Deposition outline — Hema Vasudevan
    {
      id: "wd_vls_voss_depo_outline",
      title: "Deposition outline — Hema Vasudevan (defending), Vol. III",
      matterId: MATTERS.valsara,
      createdAt: "2026-09-12T19:45:00Z",
      v1: buildDoc([
        "@center **PRIVILEGED & CONFIDENTIAL — ATTORNEY WORK PRODUCT**",
        "# Deposition Preparation Outline — Hema Vasudevan, Senior Toxicologist",
        "**Deposition:** Volume III, October 2, 2026, 9:30 a.m., Mumbai (Kale & Associates offices)\n**Examining:** Radhika Kale (Claimant's counsel)\n**Defending:** Arjun Mehra; second chair Esha Mathur\n**Prior volumes:** Vol. I (June 17, 2026, 248 pp.), Vol. II (scheduled Oct. 1, 2026)\n**Prep sessions:** Sept. 25 (full day), Sept. 30 (half day)",
        "## I. Objectives",
        "- Protect the privilege over the March 2001 draft Clause 9.4 notice exchange with Rohit Kapur (MFC-0041914–0041921) — instruct not to answer as to legal advice; permit testimony on the underlying scientific facts.\n- Keep testimony consistent with Vol. I on the 90-day study and the serum half-life (98–103 days in the rat).\n- Avoid speculative testimony about what “the industry knew”; witness speaks only to her own knowledge and documents she authored or received.",
        "## II. Anticipated Topics and Key Documents",
        makeTable(
          ["Topic", "Likely exhibits", "Vulnerability", "Prep note"],
          [
            ["2001 90-day study", "MFC-0041877 – MFC-0041879", "Her own email called it “the Sundaram final” (MFC-0041880)", "Explain the deliverable vs. interpretation distinction once; do not argue"],
            ["Serum persistence", "MFC-0041922; MFC-0041986", "Every recovery animal retained >70% (Vol. I 63:9)", "Consistent with Vol. I; do not volunteer human half-life estimates"],
            ["2001 draft Clause 9.4 notice", "MFC-0041914; MFC-0041915 (draft)", "Vasudevan told Sood she thought the notice should go (Vol. I 147:16)", "Privilege instruction on legal advice; fact testimony on what she believed scientifically is fair game"],
            ["Marketing claims", "MFC-0041964; MFC-0041955", "“Slide 8 is false” — Kale will use to show internal knowledge", "Own the email; she raised it in writing, which is the point"],
            ["MF-5 transition after 2006", "MFC-0052251 series", "Timing of phase-out vs. CPCB programme", "Emphasize voluntary participation and the 2006 reformulation"],
          ],
        ),
        "## III. Objections and Instructions",
        "@legal 1. **Privilege.** Any question calling for the substance of communications with Kapur or outside counsel after the 2001 draft notice: “Objection; instruct the witness not to answer on the basis of legal professional privilege. Ms. Vasudevan, you may answer as to facts within your knowledge but not the content of legal advice.”\n2. **Form.** Compound, assumes facts, calls for speculation, mischaracterizes prior testimony (cite volume:page).\n3. **Scope.** Vol. III is limited by Procedural Order No. 4 ¶ 9 to documents produced after June 17, 2026 (Tier 2 custodial production) — object and instruct on questions re-covering Vol. I topics unless tied to new documents.\n4. **Time.** Seven-hour limit per witness under Procedural Order No. 4; Vol. III capped at 4 hours by the Tribunal's direction of Aug. 20, 2026.",
        "## IV. Cross-Analysis: Prior Testimony to Reconcile",
        "- Vol. I 19:15 (“preliminary result”) vs. MFC-0041880 (“the Sundaram final”) — conflict cf_vls_001; prepare the witness to explain the distinction once and move on.\n- Vol. I 39:15–40:6 (objected verbally to “no adverse findings”) vs. Hegde Vol. I 22:19 — conflict cf_vls_008.\n- Vol. I 147:16 (told Sood the notice should go) — confirm the witness's account is limited to the conversation, not legal advice.",
        "## V. Redirect Themes (if needed)",
        "1. Meridian commissioned the two-year bioassay and the groundwater programme promptly.\n2. Notice was given within 30 days of the 12-month interim.\n3. The 2001 exchange reflects an internal scientific debate, not concealment.",
        "## VI. Logistics",
        "- Transcription: Nyaya Transcripts (realtime ordered); videographer confirmed.\n- Exhibits: Kale has designated 42 exhibits (list received Sept. 19); Meera to prepare binder with Bates cross-reference and prior-volume cites.\n- Witness arrival 8:30 a.m.; prep room reserved.",
      ]),
      versions: [
        { summary: "Agent edit: Built the cross-analysis section from Vol. I transcript conflicts", author: AGENT.name, transform: (d) => d },
        { summary: "Agent edit: Added the Procedural Order No. 4 scope objection and the 4-hour cap", author: AGENT.name, transform: (d) => trackedRewrite(d, "Witness arrival 8:30 a.m.", "- Witness arrival 8:15 a.m.; prep room reserved; breakfast ordered.") },
      ],
      comments: [
        { id: "wc_voss_1", find: "Vasudevan told Sood she thought the notice should go", body: "Kale will lead with this. Confirm with Rohit Kapur's counsel that Meridian is asserting privilege over the full thread, not just Kapur's reply.", author: PEOPLE.arjunMehra, createdAt: "2026-09-14T08:05:00Z" },
        { id: "wc_voss_2", find: "Vol. I 19:15", body: "Conflict cf_vls_001 in the e-discovery module tracks this inconsistency; severity high.", author: PEOPLE.tanmayBhatt, createdAt: "2026-09-14T09:30:00Z" },
      ],
      tags: ["deposition", "outline", "Vasudevan"],
    },

    // 8. Depo-Provera client update letter
    {
      id: "wd_depo_client_update",
      title: "Depo-Provera MDL — Client status update (September 2026)",
      matterId: MATTERS.depo,
      templateId: "word-client-update",
      createdAt: "2026-09-20T13:15:00Z",
      v1: buildDoc([
        `@right **${FIRM.name}**\n${FIRM.address1}\n${FIRM.address2}\n${FIRM.phone}`,
        "September 22, 2026",
        "**VIA EMAIL — PRIVILEGED & CONFIDENTIAL**",
        "[GENERAL COUNSEL]\n[CLIENT]\n[ADDRESS]",
        "**Re:** In re: Depo-Provera (Depot Medroxyprogesterone Acetate) Products Liability Litigation, MDL No. 3140 (N.D. Fla.) — Status Update",
        "Dear [GENERAL COUNSEL]:",
        "We write to update you on developments in the MDL since our August 25 report and to identify decisions we need from you before the master answer deadline.",
        "## Summary",
        "- **Where things stand:** Pleadings phase; Judge Rodgers has set Science Day for November 20, 2026 and the master answer is due October 2, 2026.\n- **What happened this period:** Plaintiffs filed the Second Amended Master Complaint (ECF 412) adding a design-defect count; the Court entered CMO 8 on the census registry; the defense group circulated a joint preemption brief outline.\n- **What we need from you:** approval of the distributor-specific affirmative defenses (Section III below) and a decision on joining the joint preemption motion.\n- **Next milestone:** master answer, October 2; Science Day, November 20.",
        "## Recent Developments",
        "The Second Amended Master Complaint adds a design-defect theory premised on the availability of the subcutaneous 104 mg formulation as a safer alternative. For a distributor defendant, this theory raises the innocent-seller defense under the laws of most plaintiff home states, which we address in the answer. The Court's CMO 8 requires each plaintiff to complete a census form with prescription and imaging history within 60 days of filing; early census data (n=1,140) show that approximately 31% of plaintiffs identify a distributor other than [CLIENT] or none at all.",
        "The epidemiology remains centered on Roland et al., Use of Progestogens and the Risk of Intracranial Meningioma, 384 BMJ e071523 (2024), which reports an adjusted odds ratio of 5.55 for prolonged medroxyprogesterone acetate use. Defense epidemiologists have identified confounding by indication and the absence of dose-response data as principal critiques for Science Day.",
        "## Upcoming Deadlines",
        "| Date | Event | Action required |\n| --- | --- | --- |\n| October 2, 2026 | Master answer due | Client approval of affirmative defenses by September 26 |\n| October 16, 2026 | Defense fact sheet template due | Provide distribution records template (Regulatory Affairs) |\n| November 20, 2026 | Science Day | Attend (optional); approve expert presentation |\n| December 4, 2026 | Preemption motion (joint) | Decision on joining by October 9 |",
        "## Strategy and Recommendations",
        "We recommend (1) asserting the innocent-seller and sealed-container defenses in every state where available, (2) joining the joint preemption motion as to the failure-to-warn claims while reserving distributor-specific arguments, and (3) declining to participate in the plaintiffs' proposed early mediation until census data mature. We estimate that the census data will allow a motion to dismiss approximately 350 plaintiffs for lack of product identification in the first quarter of 2027.",
        "## Budget",
        "Fees and costs through August 31 total $412,600 against the Phase 1 (pleadings and Science Day) budget of $650,000. We anticipate remaining within budget through Science Day.",
        "Please let us know if you would like to discuss any of these items. We appreciate the opportunity to assist you in this matter.",
        "Sincerely,",
        `\n\n**Priya Raman**\nPartner, ${FIRM.name}\npraman@mehrarao.example`,
        "cc: Sameer Chawla; Meera Lobo",
      ]),
      versions: [
        { summary: "Agent edit: Added the deadline table and budget section", author: AGENT.name, transform: (d) => d },
      ],
      comments: [
        { id: "wc_depo_1", find: "approximately 31% of plaintiffs identify a distributor", body: "Double-check this figure against the September 19 census export — Meera's tally was 29.6%.", author: PEOPLE.priyaRaman, createdAt: "2026-09-21T10:12:00Z" },
      ],
      tags: ["client update", "MDL 3140"],
    },
  ];

  for (const sd of docs) {
    if (db.officeDocs.has(sd.id)) continue;
    const settings = settingsForTemplate(sd.templateId ?? (/(memo|update|issues|outline)/i.test(sd.id) ? "word-research-memo" : "word-motion-brief"));
    const doc = createOfficeDoc({ id: sd.id, kind: "word", title: sd.title, content: sd.v1, matterId: sd.matterId, templateId: sd.templateId, tags: sd.tags, meta: { settings, trackChanges: true } });
    // Backdate creation
    db.officeDocs.update(sd.id, { createdAt: sd.createdAt, updatedAt: sd.createdAt });
    for (const v of db.officeVersions.find((x) => x.docId === sd.id)) db.officeVersions.update(v.id, { createdAt: sd.createdAt });
    let content = sd.v1;
    sd.versions.forEach((v, i) => {
      content = v.transform(content);
      const at = T(new Date(new Date(sd.createdAt).getTime() + (i + 1) * 26 * 3600 * 1000).toISOString());
      saveOfficeDoc(sd.id, { content, version: { force: true, summary: v.summary, label: v.label, authorName: v.author } });
      const latest = db.officeVersions.find((x) => x.docId === sd.id).sort((a, b) => b.version - a.version)[0];
      if (latest && latest.summary === v.summary && latest.label === v.label) db.officeVersions.update(latest.id, { createdAt: at });
      else db.officeVersions.put({ id: `${sd.id}_v${i + 2}`, docId: sd.id, version: (latest?.version ?? 1) + 1, label: v.label, summary: v.summary, authorId: v.author ? undefined : PEOPLE.arjunMehra, authorName: v.author ?? "Arjun Mehra", createdAt: at, content, changedFields: 0 });
    });
    const finalDoc = db.officeDocs.get(sd.id)!;
    const comments: OfficeComment[] = sd.comments.map((c) => {
      const anchor = blockIdWithText(finalDoc.content as PMNode, c.find) || String(((finalDoc.content as PMNode).content ?? [])[0]?.attrs?.id ?? "");
      const author = c.agent ? undefined : db.people.get(c.author ?? PEOPLE.arjunMehra);
      return { id: c.id, docId: sd.id, anchor, quote: c.quote, body: c.body, authorId: author?.id, authorName: c.agent ? AGENT.name : author?.name ?? "Arjun Mehra", createdAt: c.createdAt, resolved: c.resolved, replies: c.replies ?? [], source: c.agent ? "agent" : "user" };
    });
    db.officeComments.putMany(comments);
    const lib: LibraryItem = { id: `lib_word_${sd.id}`, parentId: sd.matterId ? matterFolderId(sd.matterId) : null, name: sd.title, type: "docx", matterId: sd.matterId, officeDocId: sd.id, size: doc.size, tags: sd.tags, ownerId: PEOPLE.arjunMehra, sharedWith: ["matter-team"], createdAt: sd.createdAt, updatedAt: finalDoc.updatedAt, version: finalDoc.contentVersion, status: "draft" };
    db.library.put(lib);
    void sterling;
  }
}
