import "server-only";
import type { Database } from "@/lib/db";
import type { LibraryItem, OfficeComment } from "@/lib/types/domain";
import { MATTERS, PEOPLE } from "@/lib/seed/ids";
import { matterFolderId } from "@/modules/library/ids";

/** Knowledge › Litigation practice (system subfolder seeded by the library module; the Knowledge root itself holds no items). */
const KNOWLEDGE_LITIGATION_FOLDER = "lib_folder_knowledge_litigation";
import { createOfficeDoc, saveOfficeDoc } from "@/modules/office/shared/docs-service";
import { buildSlide } from "./layouts";
import { type DeckContent } from "./model";
import { applyOp } from "./proposals";
import { deckFromOutline } from "./templates";

const AGENT = "Drafting assistant";

interface SeedDeck {
  id: string;
  title: string;
  matterId?: string;
  templateId?: string;
  themeId: string;
  outline: string;
  createdAt: string;
  tags?: string[];
  /** Later versions: transform + summary/label. */
  versions: { summary: string; label?: string; author?: string; transform: (deck: DeckContent) => DeckContent }[];
  /** Comments anchored to a 1-based slide index. */
  comments: { id: string; slide: number; body: string; author?: string; agent?: boolean; createdAt: string; resolved?: boolean; replies?: { id: string; body: string; authorName: string; createdAt: string }[] }[];
  folderId?: string;
}

const VALSARA_OUTLINE = `# Valsara v. Meridian (Phase 1): case strategy
kicker: Arb. Ref. 14/2024 (seat: New Delhi) · Meridian Fine Chemicals · Privileged
subtitle: Themes, chronology, key documents, quantum exposure and the path to the Phase 1 hearing
date: September 22, 2026 · Arbitration team working session

# Agenda
- Where the arbitration stands
- Three themes the record supports
- Knowledge chronology and the Clause 9.4 narrative
- Key documents and the privilege fight
- The Claimant's quantum model versus ours
- Risks, recommendations and next steps

# Case caption and posture
layout: two_column
left: The case
- **Caption:** Valsara Textile Park Ltd. v. Meridian Fine Chemicals Ltd., Arb. Ref. 14/2024
- **Tribunal:** Justice (Retd.) Vasudha Rangan (Presiding Arbitrator)
- **Client:** Meridian Fine Chemicals Ltd. (Respondent)
- **Claimant's counsel:** Radhika Kale, Kale & Associates
right: Where we are
- **Stage:** Tier 2 document production · expert evidence
- **Oct 14, 2026** — Tier 2 production deadline
- **Nov 6, 2026** — Rebuttal expert reports due
- **Dec 18, 2026** — Objections to expert evidence
- **Mar 8, 2027** — Phase 1 evidentiary hearing
notes: Forty-five seconds. Everyone in the room knows the matter; the point is to anchor the dates that drive the work plan.

# Three themes the record supports
- **Knowledge:** Meridian acted on the science it had, when it had it
- **Causation:** the Claimant cannot isolate Meridian's Lagoon 2 from other sources in the industrial estate
- **Conduct:** the 2006 MF-5 transition preceded any regulatory mandate by years
- Every theme maps to a witness (Vasudevan, Hegde, Bose), a document set and a rebuttal expert
notes: This is the spine of the deck. If the client remembers one slide, it is this one. The causation theme is strongest on the wellfield indemnity; knowledge matters most for the Clause 9.6 liquidated damages.

# Knowledge chronology
layout: timeline
timeline:
- 2001-03 — Sundaram 90-day study final — MFC-0041877 — liver effects and ~100-day serum half-life
- 2001-03 — Draft Clause 9.4 notice prepared — MFC-0041915 — reviewed by Kapur; not served
- 2001-09 — First MC-8 detection at MW-7 — MFC-0041988 — 12 µg/L downgradient of Lagoon 2
- 2002-10 — Clause 9.4 notice served on the Park — after the 12-month bioassay interim
- 2006-12 — MF-3 production ends — MFC-0052251 — MF-5 transition
- 2023-01 — Notice of arbitration — Tribunal constituted later that year
notes: Walk left to right. The 2001 draft notice is the document Kale will lead with; frame it before she does — deliberation, legal review, and a scientific debate, not concealment. Cite the Bates numbers aloud.

# Key documents
layout: table
| Bates | Date | Document | Why it matters |
| MFC-0041877 | 2001-03-14 | Sundaram 90-day study summary | High-dose animal data; persistence finding |
| MFC-0041915 | 2001-03-19 | Draft Clause 9.4 notice (Sood) | Alternative A / B — privilege asserted over the thread |
| MFC-0041930 | 2001-03-22 | Sood Clause 9.4 analysis memo | Legal judgment; corroborative-information paragraph |
| MFC-0052210 | 2002-07-08 | Hegde MW-7 email | "voluntarily, now" — notice timing |
| MFC-0052221 | 2002-10-24 | Letter to the Park water works | First disclosure to the Park |
caption: Bates cites verified against the Tier 1 production index on September 19, 2026; Tier 2 documents pending.
notes: Read the Bates numbers so Meera can pull the binder. Row two is the privilege fight — conflict cf_vls_001 in e-discovery tracks the Vasudevan testimony inconsistency.

# The Clause 9.4 narrative
layout: comparison
left: The Claimant will say
- Meridian's own toxicologist wanted notice given in 2001
- Legal deferred the notice to protect sales
- Meridian kept supplying MF-3 for five more years
right: The record shows
- The draft reflected an open scientific question, not a conclusion
- Kapur's review was a privileged legal judgment; the Schedule 6 threshold was arguable
- Notice was given within 30 days of the 12-month interim

# Quantum: the Claimant's model versus ours
layout: chart
chart: bar | Claimant's model | Respondent's model | Settlement range
chart-title: Estimated exposure, wellfield remediation and liquidated damages (₹ crore)
Exposure: 184, 42, 65
unit: ₹
- The Claimant attributes 100% of the wellfield remediation to Lagoon 2
- Respondent's model applies the documented plume geometry and background AOX levels
- Range reflects cost of the proceedings and adverse-award risk
notes: Dr. Patel's hydrogeology rebuttal drives the Respondent's number; say plainly that it is provisional until his report is final on November 6.

# Risks and recommendations
layout: comparison
left: Risks
- An adverse Phase 1 award anchors quantum
- Privilege ruling on the 2001 thread goes against us
- Expert objections cut both ways: Sundaram's recalculation invites a challenge
right: Recommendations
- Press source attribution now — the plume geometry is documented
- Prepare Vasudevan as the clean Clause 9.4 witness; Vol. III limited by Procedural Order No. 4
- Open a settlement channel with the Claimant before the expert conferencing session

# Next steps
layout: table
| Action | Owner | Due |
| Finalize Tier 2 custodial production (8 custodians) | T. Bhatt | Oct 14, 2026 |
| Rebuttal expert outlines — Sundaram (tox), Patel (hydro) | P. Raman / E. Mathur | Oct 24, 2026 |
| Vasudevan Vol. III preparation sessions (2) | A. Mehra / M. Lobo | Oct 28, 2026 |
| Client decision on settlement authority | R. Kapur | Nov 13, 2026 |
notes: Close with the asks. Confirm owners and dates in the room and send this table as the follow-up email.`;

const NORTHGATE_OUTLINE = `# Northgate v. Apex: summary judgment hearing
kicker: No. 1:26-cv-02218 (N.D. Ill.) · Hon. Sara L. Ellis
subtitle: The indemnity clause means what it says, and the consequential-damages waiver does not reach cargo loss
date: Hearing preparation · October 2026

# Agenda
- The contract and the loss
- Question 1: does §9.2 indemnify cargo losses at the cross-dock?
- Question 2: does the §12.4 waiver bar recovery?
- The undisputed record
- What we ask the Court to do

# The Master Transportation Services Agreement
layout: two_column
left: The clause
- **§9.2:** Apex "shall indemnify, defend and hold harmless Northgate from any loss of or damage to Cargo while in Carrier's care, custody or control"
- **§12.4:** neither party liable for "indirect, incidental or consequential damages"
- **Ex. B, ¶4:** Joliet cross-dock designated a Carrier facility
right: The loss
- Three trailers unloaded at Joliet on March 3–4, 2026
- Cargo shortage of 1,412 units confirmed on delivery receipts (NGL-000318–000341)
- Replacement cost $2.41M; customer chargebacks $610K

# Question 1: indemnity covers the cross-dock
- Care, custody or control began at tender (§3.1) and did not end until delivery (§3.4)
- Ex. B lists Joliet as a Carrier facility; Apex drafted Ex. B
- Apex's own incident report attributes the shortage to its dock staff (APX-002214)
- Illinois enforces indemnity clauses as written — no ambiguity to construe against us
notes: Lead with the text. Judge Ellis reads the contract first; put §9.2 on the screen and pause. The incident report is the admission; APX-002214, page 3.

# Question 2: the waiver does not reach direct loss
layout: comparison
left: Apex's argument
- Chargebacks are "consequential"
- Replacement cost is "indirect" because Northgate bought from a third party
- §12.4 is a complete bar
right: Our answer
- Loss of the cargo itself is the direct, contemplated consequence of §9.2
- Cover damages are the UCC's measure of direct loss (810 ILCS 5/2-712)
- §12.4 cannot swallow §9.2 — the specific controls the general

# Procedural history
layout: timeline
timeline:
- 2026-01-20 — Complaint filed — breach of MTSA §9.2
- 2026-03-04 — Answer and counterclaim — Apex asserts §12.4 waiver
- 2026-06-15 — Close of fact discovery — 11 depositions; 41,000 pages
- 2026-09-09 — Cross-motions for summary judgment filed
- 2026-10-09 — Northgate opposition due
- 2027-01-12 — Final pretrial conference

# The undisputed record
layout: table
| Fact | Source | Disputed? |
| Joliet is a designated Carrier facility | MTSA Ex. B ¶4 | No |
| Shortage of 1,412 units on delivery | NGL-000318–000341 | No |
| Apex dock staff mis-staged the freight | APX-002214 at 3 | No |
| Replacement cost $2.41M | Ramirez Decl. ¶¶ 6–9 | Amount only |
| Chargebacks $610K | Customer notices, NGL-001102–001140 | Characterization |

# What we ask the Court to do
- Grant partial summary judgment on liability under §9.2
- Hold that §12.4 does not bar replacement cost or chargebacks
- Deny Apex's cross-motion
- Set damages for the January trial setting
notes: End on the relief. If the Court signals it will reserve on the chargebacks, accept the partial ruling and preserve the issue.`;

const HARBOR_OUTLINE = `# Project Harbor: Board briefing
kicker: Confidential · Harborline Technologies Board of Directors · Corporate / M&A
subtitle: Acquisition of Bluewater Analytics, Inc. — status, diligence findings and approvals requested
date: September 24, 2026

# Agenda
- Transaction overview and rationale
- Structure and key terms
- Confirmatory diligence findings
- Principal risks and mitigants
- Timeline and regulatory path
- Approvals requested today

# Transaction overview
layout: two_column
left: The deal
- $184M enterprise value; $150M cash and $34M Harborline stock
- Target: Bluewater Analytics, Inc. — ML analytics platform, 62 employees
- Rationale: product adjacency, 40+ enterprise accounts, core ML engineering team
right: Status
- Confirmatory diligence substantially complete
- SPA in fourth turn; three open points (slide 5)
- R&W insurance binder expected by October 10

# Structure and key terms
layout: table
| Term | Position | Status |
| Consideration | $150M cash + $34M buyer stock | Agreed |
| Escrow | 10% for 18 months | Agreed |
| R&W insurance | $18M limit; 1% retention | Binder pending |
| Key-employee retention | 3-year vesting; $6M pool | Agreed in principle |
| Closing conditions | HSR clearance; 15 of top-20 customer consents | Open |

# Diligence findings
- **IP chain of title:** two early contributors to the core models lack assignment agreements — cure before signing
- **Customer contracts:** 6 of the top 20 require change-of-control consent; joint outreach plan agreed
- **Employment:** contractor classification exposure in two states; reserve $420K
- **Data privacy:** GDPR processor terms outdated for 3 EU customers; remediation within 90 days post-close
- **Litigation:** none pending; one 2025 demand letter resolved for $35K
notes: Lead with IP: it is the one finding that could move price. The contributors have been located and both have agreed in principle to sign for nominal consideration.

# Principal risks and mitigants
layout: comparison
left: Risks
- IP assignment gap for the core models
- Customer consents delay closing past year-end
- Key engineers leave post-close
right: Mitigants
- Signing condition: executed assignments from both contributors
- Walk right if fewer than 15 of 20 consents by December 15
- Retention pool with one-year cliff; 18-month non-solicit

# Timeline to closing
layout: timeline
timeline:
- Oct 30 — Target signing — SPA and ancillary agreements
- Nov 6 — HSR filing — 30-day waiting period
- Dec 8 — Expected HSR clearance — absent second request
- Dec 15 — Customer consents deadline
- Dec 22 — Target closing

# Approvals requested
- Approve the acquisition on the terms summarized, subject to final documentation
- Authorize management to execute the SPA and ancillary agreements
- Approve the issuance of up to 1.2M shares as stock consideration
- Delegate closing-condition waivers to the transaction committee
notes: Read the resolutions verbatim from the board book. Confirm quorum before the vote; two directors are attending remotely.`;

const STERLING_OUTLINE = `# Sterling Medical Group: PAGA notice response
kicker: Client update · Wage & hour · Privileged & Confidential
subtitle: Exposure analysis across 14 clinics, cure strategy and the decisions we need before October 21
date: September 23, 2026 · Prepared for Sterling Medical Group, P.C.

# Executive summary
- **Where things stand:** LWDA notice received August 19; cure period ends October 21, 2026
- **What we found:** rounding neutral overall; meal-period exceptions concentrated in 4 clinics
- **What we need from you:** approval of the cure notice and the timekeeping policy change
- **Next milestone:** cure notice to LWDA and the aggrieved employees by October 17
notes: Lead with the answer. The rounding finding is good news; the meal-period exceptions are real but curable under Labor Code §2699.3(c).

# What the payroll data shows
layout: chart
chart: bar | Clinic A | Clinic B | Clinic C | Clinic D | All others
chart-title: Meal-period exceptions per 100 shifts (Jan–Aug 2026)
Exceptions: 14.2, 11.8, 9.6, 8.1, 2.3
- 412,000 shifts analyzed across 14 clinics
- Rounding to the nearest 6 minutes: net neutral (+0.4 minutes per shift in employees' favor)
- Late or short meal periods cluster in the four highest-volume clinics

# Exposure range
layout: table
| Scenario | Assumptions | Exposure |
| Cured | Premiums paid for identified exceptions; policy fixed | $186K |
| Uncured, PAGA penalties stacked | $100 per pay period per employee, 1-year lookback | $2.9M |
| Uncured, penalties reduced (§2699(e)(2)) | Court reduces by 70% for good-faith compliance | $870K |
caption: Premium calculations use each employee's regular rate; penalty scenarios assume the 2024 PAGA reform caps apply.

# Cure strategy
layout: comparison
left: Cure now
- Pay one hour of premium pay for every identified exception
- Adopt attestation-based meal-period timekeeping
- File cure notice by October 17; caps penalties at 15% if complete
right: Contest
- Argue employees waived meal periods voluntarily
- Preserve rounding defense
- Risk: full penalty exposure and a representative action

# Decisions needed
- Approve the cure notice and premium payments ($186K)
- Approve the timekeeping policy change for all 14 clinics effective November 1
- Authorize outreach to the LWDA regarding an early neutral evaluation
- Confirm litigation hold scope (payroll, scheduling, badge data)

# Next steps
layout: timeline
timeline:
- Oct 3 — Client approval of cure plan
- Oct 10 — Premium payments processed
- Oct 17 — Cure notice served on LWDA and employees
- Oct 21 — Cure period ends
- Nov 1 — New timekeeping policy live`;

const CLE_OUTLINE = `# Rule 702 after the 2023 amendment
kicker: CLE · Evidence · 1.0 general credit
subtitle: What changed, what courts are doing with it, and how to brief it
date: Mehra & Rao Advocates · October 2026

# Agenda
- The text: what the amendment changed
- Why the Advisory Committee acted
- How circuits are applying the amended rule
- Briefing and hearing strategy
- Hypothetical

# The amended rule
layout: quote
quote: A witness who is qualified as an expert … may testify … if the proponent demonstrates to the court that it is more likely than not that … the expert's opinion reflects a reliable application of the principles and methods to the facts of the case.
by: Fed. R. Evid. 702 (as amended Dec. 1, 2023)

# What changed
layout: comparison
left: Before
- Courts often treated reliability as a jury question ("weight, not admissibility")
- Proponent's burden rarely stated
- Application of method received little scrutiny
right: After
- Preponderance standard written into the rule
- Court must find each element met before the jury hears the opinion
- "Reliable application" is a gatekeeping element, not a weight question
notes: The Committee Note is explicit: many courts had "incorrectly" treated 702's requirements as going to weight. Quote it.

# Circuit trends
layout: table
| Circuit | Decision | Takeaway |
| 4th Cir. | Sardis v. Overhead Door Corp., 10 F.4th 268 (2021) | Pre-amendment; anticipates the burden framing |
| 3d Cir. | [VERIFY] | Amended rule applied to exclude extrapolated dose opinion |
| 9th Cir. | [VERIFY] | Weight-vs-admissibility language persists |
caption: Verify every citation before presenting; entries marked [VERIFY] are placeholders.

# Briefing strategy
- Lead with the amended text and the Committee Note, not the Daubert factors
- Attack application: show the gap between method and conclusion with the expert's own data
- Ask for findings on each element; propose an order that recites them
- Preserve the objection at trial — the ruling is reviewed for abuse of discretion

# Hypothetical
layout: two_column
left: Facts
- Epidemiologist pools five studies with different exposure metrics
- Reports a pooled relative risk of 1.4
- Opines that exposure "can cause" the disease at any dose
right: Questions
- Is the pooling a reliable method as applied?
- Does the "any dose" conclusion exceed what the data support?
- What findings would you ask the court to make?

# Questions
layout: section
subtitle: Materials and citations available on the firm library under Knowledge / CLE`;

const T = (d: string) => new Date(d).toISOString();

export function seedSlides(db: Database) {
  const decks: SeedDeck[] = [
    {
      id: "sd_vls_case_strategy",
      title: "Valsara v. Meridian — case strategy (Phase 1)",
      matterId: MATTERS.valsara,
      templateId: "slides-case-strategy",
      themeId: "classic-navy",
      outline: VALSARA_OUTLINE,
      createdAt: "2026-09-17T15:10:00Z",
      tags: ["strategy", "arbitration", "Valsara"],
      versions: [
        {
          summary: "Agent edit: Added the Clause 9.4 comparison slide and speaker notes on the chronology",
          author: AGENT,
          transform: (deck) => {
            const chrono = deck.slides[4];
            return applyOp(deck, { op: "set_slide", slideId: chrono.id, patch: { notes: `${chrono.notes}\nTransition: "So what do the documents actually say?" — go to the key documents table.` } });
          },
        },
        {
          summary: "Agent edit: Inserted a source-attribution chart from the Beacon plume data",
          author: AGENT,
          transform: (deck) => {
            const after = deck.slides[7];
            const slide = buildSlide("chart", { title: "Source attribution at the Park wellfield", chart: { type: "pie", categories: ["Lagoon 2 (Meridian)", "Estate drain B", "Unit 14 effluent pit", "Background"], series: [{ name: "Share of AOX load", values: [23, 41, 24, 12] }], title: "Estimated AOX load by source, 2003–2009 (Beacon data)", showLegend: true, showValues: true, unit: "%" }, body: "- Lagoon 2 accounts for an estimated 23% of the AOX load at the wellfield boundary\n- Shares derived from the Beacon plume data and the Park effluent register, MFC-0041877\n- The Claimant's model attributes 100% to Meridian [VERIFY against the Park's discharge consents]", notes: "This is the source-attribution slide. Emphasise that the effluent register is the Park's own business record and that the Claimant has not produced unit-level discharge data to rebut it." }, deck.theme, { slideNumber: 9 });
            return applyOp(deck, { op: "add_slide", afterId: after.id, slide });
          },
        },
        { summary: "Checkpoint", label: "Before partner review", transform: (d) => d },
      ],
      comments: [
        { id: "sc_vls_1", slide: 6, body: "Row two: confirm with Rohit Kapur's office that Meridian is asserting privilege over the full thread (MFC-0041914–0041921), not only the draft. Kale will apply for production.", author: PEOPLE.arjunMehra, createdAt: "2026-09-19T09:40:00Z", replies: [{ id: "sc_vls_1a", body: "Confirmed with Kapur on 9/19 — full thread. Privilege log entry PL-0142 updated.", authorName: "Meera Lobo", createdAt: "2026-09-19T14:05:00Z" }] },
        { id: "sc_vls_2", slide: 8, body: "Respondent's model figure (₹42 crore) is provisional until Dr. Patel's hydrogeology report; I added [VERIFY] language to the notes. Consider a range rather than a point estimate for the client version.", agent: true, createdAt: "2026-09-20T11:22:00Z" },
        { id: "sc_vls_3", slide: 5, body: "Timeline: the March 2001 draft-notice entry should cite Vasudevan Vol. I 147:16 in the caption — that is the testimony conflict cf_vls_001 tracks.", author: PEOPLE.tanmayBhatt, createdAt: "2026-09-20T16:48:00Z", resolved: true },
      ],
    },
    {
      id: "sd_northgate_msj_hearing",
      title: "Northgate v. Apex — MSJ hearing deck",
      matterId: MATTERS.northgate,
      themeId: "counsel-slate",
      outline: NORTHGATE_OUTLINE,
      createdAt: "2026-09-21T13:30:00Z",
      tags: ["MSJ", "hearing", "indemnity"],
      versions: [
        { summary: "Agent edit: Tightened Question 1 to four bullets and added the APX-002214 pin cite", author: AGENT, transform: (d) => d },
        { summary: "Saved changes", transform: (deck) => applyOp(deck, { op: "set_slide", slideId: deck.slides[3].id, patch: { notes: "Lead with the text. Judge Ellis reads the contract first; put §9.2 on the screen and pause. The incident report is the admission: APX-002214 at 3. If asked about Ex. B drafting history, cite the Ramirez deposition at 44:8–46:2." } }) },
      ],
      comments: [
        { id: "sc_ng_1", slide: 5, body: "Add the UCC cover-damages cite to the slide itself, not just the notes — Ellis likes to see the statute.", author: PEOPLE.dhruvOberoi, createdAt: "2026-09-22T08:15:00Z" },
        { id: "sc_ng_2", slide: 7, body: "Chargebacks row: Apex will call the customer notices hearsay. Have the business-records foundation (Ramirez Decl. ¶ 11) ready.", author: PEOPLE.eshaMathur, createdAt: "2026-09-22T10:02:00Z" },
      ],
    },
    {
      id: "sd_harbor_board_briefing",
      title: "Project Harbor — Board briefing (September 2026)",
      matterId: MATTERS.harbor,
      templateId: "slides-board-briefing",
      themeId: "counsel-slate",
      outline: HARBOR_OUTLINE,
      createdAt: "2026-09-19T17:45:00Z",
      tags: ["M&A", "board", "Project Harbor"],
      versions: [
        { summary: "Agent edit: Rebuilt the timeline slide from the SPA signing calendar", author: AGENT, transform: (d) => d },
        { summary: "Checkpoint", label: "Sent to Harborline GC", transform: (d) => d },
      ],
      comments: [
        { id: "sc_hb_1", slide: 5, body: "Contractor classification reserve: Sameer's memo puts the range at $380–460K; $420K is the midpoint. OK to present as a point estimate?", author: PEOPLE.dhruvOberoi, createdAt: "2026-09-20T09:00:00Z", replies: [{ id: "sc_hb_1a", body: "Yes — footnote the range in the board book.", authorName: "Sameer Chawla", createdAt: "2026-09-20T09:35:00Z" }] },
        { id: "sc_hb_2", slide: 8, body: "Share issuance number (1.2M) depends on the 20-day VWAP at signing; recommend \"up to 1.3M\" to leave headroom.", agent: true, createdAt: "2026-09-20T12:10:00Z" },
      ],
    },
    {
      id: "sd_sterling_paga_update",
      title: "Sterling Medical — PAGA notice response (client update)",
      matterId: MATTERS.sterling,
      templateId: "slides-client-update",
      themeId: "client-light",
      outline: STERLING_OUTLINE,
      createdAt: "2026-09-22T19:05:00Z",
      tags: ["client update", "PAGA", "wage and hour"],
      versions: [
        { summary: "Agent edit: Added the exposure-range table and cure/contest comparison", author: AGENT, transform: (d) => d },
      ],
      comments: [
        { id: "sc_st_1", slide: 3, body: "Re-run the exceptions chart after the Clinic C badge data arrives (due 9/26); the 9.6 figure includes 300 shifts with missing punches.", author: PEOPLE.sameerChawla, createdAt: "2026-09-23T07:50:00Z" },
      ],
    },
    {
      id: "sd_cle_rule_702",
      title: "CLE — Rule 702 after the 2023 amendment",
      themeId: "courtroom-serif",
      templateId: "slides-cle-rule-702",
      outline: CLE_OUTLINE,
      createdAt: "2026-09-15T12:00:00Z",
      tags: ["CLE", "evidence", "training"],
      folderId: KNOWLEDGE_LITIGATION_FOLDER,
      versions: [
        { summary: "Agent edit: Added the circuit-trends table with [VERIFY] placeholders", author: AGENT, transform: (d) => d },
      ],
      comments: [
        { id: "sc_cle_1", slide: 5, body: "Aisha — can KM pull the Third and Ninth Circuit decisions applying the amended rule so we can replace the placeholders before the session?", author: PEOPLE.priyaRaman, createdAt: "2026-09-16T10:30:00Z" },
      ],
    },
  ];

  for (const sd of decks) {
    if (db.officeDocs.has(sd.id)) continue;
    const v1 = deckFromOutline(sd.outline, sd.themeId);
    const doc = createOfficeDoc({ id: sd.id, kind: "slides", title: sd.title, content: v1, matterId: sd.matterId, templateId: sd.templateId, tags: sd.tags, meta: { themeId: sd.themeId } });
    db.officeDocs.update(sd.id, { createdAt: sd.createdAt, updatedAt: sd.createdAt });
    for (const v of db.officeVersions.find((x) => x.docId === sd.id)) db.officeVersions.update(v.id, { createdAt: sd.createdAt });
    let content = v1;
    sd.versions.forEach((v, i) => {
      content = v.transform(content);
      const at = T(new Date(new Date(sd.createdAt).getTime() + (i + 1) * 22 * 3600 * 1000).toISOString());
      saveOfficeDoc(sd.id, { content, version: { force: true, summary: v.summary, label: v.label, authorName: v.author } });
      const latest = db.officeVersions.find((x) => x.docId === sd.id).sort((a, b) => b.version - a.version)[0];
      if (latest && latest.summary === v.summary && latest.label === v.label) db.officeVersions.update(latest.id, { createdAt: at });
      else db.officeVersions.put({ id: `${sd.id}_v${i + 2}`, docId: sd.id, version: (latest?.version ?? 1) + 1, label: v.label, summary: v.summary, authorId: v.author ? undefined : PEOPLE.arjunMehra, authorName: v.author ?? "Arjun Mehra", createdAt: at, content, changedFields: 0 });
    });
    const finalDoc = db.officeDocs.get(sd.id)!;
    const deck = finalDoc.content as DeckContent;
    const comments: OfficeComment[] = sd.comments.map((c) => {
      const slide = deck.slides[Math.min(c.slide, deck.slides.length) - 1];
      const author = c.agent ? undefined : db.people.get(c.author ?? PEOPLE.arjunMehra);
      return { id: c.id, docId: sd.id, anchor: `slide:${slide.id}`, body: c.body, authorId: author?.id, authorName: c.agent ? AGENT : author?.name ?? "Arjun Mehra", createdAt: c.createdAt, resolved: c.resolved, replies: c.replies ?? [], source: c.agent ? "agent" : "user" };
    });
    db.officeComments.putMany(comments);
    const lib: LibraryItem = { id: `lib_slides_${sd.id}`, parentId: sd.folderId ?? (sd.matterId ? matterFolderId(sd.matterId) : null), name: sd.title, type: "pptx", matterId: sd.matterId, officeDocId: sd.id, size: doc.size, tags: sd.tags, ownerId: PEOPLE.arjunMehra, sharedWith: [sd.matterId ? "matter-team" : "firm"], createdAt: sd.createdAt, updatedAt: finalDoc.updatedAt, version: finalDoc.contentVersion, status: "draft" };
    db.library.put(lib);
  }
}
