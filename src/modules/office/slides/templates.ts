import "server-only";
import { db } from "@/lib/db";
import type { Matter } from "@/lib/types/domain";
import type { OfficeTemplate } from "@/modules/office/shared/template-registry";
import { parseOutline } from "./layouts";
import { emptyDeck, getTheme, type DeckContent } from "./model";

/** Build a deck from the outline grammar (see layouts.ts). */
export function deckFromOutline(outline: string, themeId = "classic-navy"): DeckContent {
  const theme = getTheme(themeId);
  const { slides, themeId: declared } = parseOutline(outline, theme);
  const deck = emptyDeck(declared ?? themeId);
  deck.slides = slides;
  deck.meta = { createdWith: "template" };
  return deck;
}

function matterOf(matterId?: string): Matter | null {
  if (!matterId) return null;
  try { return db().matters.get(matterId); } catch { return null; }
}

const today = () => new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
const fmt = (d: string) => new Date(d).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });

function captionSlide(m: Matter | null): string {
  if (!m) return `# Case caption and posture
layout: two_column
left: The case
- **Caption:** [CASE CAPTION]
- **Court:** [COURT] · [JUDGE]
- **Docket:** [DOCKET NO.]
- **Client:** [CLIENT] ([SIDE])
right: Where we are
- **Stage:** [STAGE]
- **Next deadline:** [DATE] — [EVENT]
- **Trial setting:** [DATE]
notes: Set the table: who the parties are, what is being claimed, and where in the case we are. Keep this to 45 seconds; the audience knows the matter.`;
  const dates = (m.keyDates ?? []).slice(0, 4).map((k) => `- **${fmt(k.date)}** — ${k.label}`).join("\n");
  return `# Case caption and posture
layout: two_column
left: The case
- **Caption:** ${m.name}
- **Court:** ${m.court ?? "[COURT]"}${m.judge ? ` · ${m.judge}` : ""}
- **Docket:** ${m.caption ?? "[DOCKET NO.]"}
- **Client:** ${m.client} (${m.clientSide})
right: Where we are
- **Stage:** ${m.stage ?? "[STAGE]"}
${dates || "- **Next deadline:** [DATE] — [EVENT]"}
notes: Set the table: who the parties are, what is being claimed, and where in the case we are. Keep this to 45 seconds; the audience knows the matter.`;
}

function caseStrategyOutline(m: Matter | null): string {
  const short = m?.shortName ?? "[MATTER]";
  const client = m?.client ?? "[CLIENT]";
  return `# ${short}: Case strategy
kicker: Case strategy · ${m?.practiceArea ?? "Litigation"}
subtitle: Themes, chronology, key documents, damages exposure and the path to resolution
date: ${today()} · Prepared for ${client}

# Agenda
- Where the case stands
- Our three themes
- Chronology and key documents
- Damages exposure and the plaintiffs' model
- Risks, recommendations and next steps

${captionSlide(m)}

# Three themes the evidence supports
layout: bullets
- **Knowledge:** ${client} acted on the science it had, when it had it
- **Causation:** plaintiffs' model cannot isolate our product from other sources
- **Conduct:** stewardship steps preceded any regulatory mandate
- Every theme maps to a witness, a document set and an expert
notes: This is the spine of the deck. Each theme has a slide later; if the audience only remembers one thing, it is these three lines.

# Chronology
layout: timeline
timeline:
- 1998 — Internal toxicology study — [BATES] — high-dose animal data, no human signal
- 2001 — Draft regulatory notice circulated — [BATES] — legal review, not filed
- 2006 — Voluntary stewardship program joined — phase-out begins
- 2016 — First plaintiff suits filed — MDL consolidation follows
- 2024 — Regulator's final rule — exposure standard set
notes: Walk the timeline left to right. Emphasize that the stewardship decision preceded the regulatory mandate by a decade. Mark any date you cannot source as [VERIFY].

# Key documents
layout: table
| Bates | Date | Document | Why it matters |
| [BATES] | 1998-03-12 | Toxicology study summary | High-dose animal data; no human signal |
| [BATES] | 2001-06-04 | Draft regulatory notice + cover email | Shows deliberation, not concealment |
| [BATES] | 2006-01-15 | Stewardship program letter | Voluntary phase-out before mandate |
| [BATES] | 2019-11-20 | Plaintiffs' expert reliance list | Omits background exposure literature |
caption: Every Bates cite must be verified against the production index before the deck leaves the firm.
notes: Read the Bates numbers aloud so the team can pull them. The second row is the document plaintiffs will lead with; explain our framing before they do.

# Damages exposure
layout: chart
chart: bar | Plaintiffs' model | Defense model | Settlement range
chart-title: Estimated exposure ($M)
Exposure: 184, 42, 65
unit: $
- Plaintiffs' model assumes 100% market share attribution
- Defense model applies documented supplier shares and background exposure
- Settlement range reflects litigation cost and bellwether risk
notes: The numbers are placeholders until the damages expert's report is final; say so. The point is the gap between the models and what drives it.

# Risks and recommendations
layout: comparison
left: Risks
- Adverse bellwether verdict sets an anchor
- Privilege fight over the 2001 draft notice
- Expert exclusion motions cut both ways
right: Recommendations
- Press product-identification defenses now
- Prepare the notice narrative with a clean witness
- Open a settlement channel before Daubert rulings

# Next steps
layout: table
| Action | Owner | Due |
| Finalize damages rebuttal outline | Partner | [DATE] |
| Serve supplemental document requests | Associate | [DATE] |
| Witness preparation sessions (2) | Team | [DATE] |
| Client decision on settlement authority | Client | [DATE] |
notes: Close with the asks. Confirm owners and dates in the room and send the table as the follow-up email.

# Questions
layout: section
subtitle: Privileged & Confidential — Attorney Work Product — Prepared at the direction of counsel`;
}

function clientUpdateOutline(m: Matter | null): string {
  const short = m?.shortName ?? "[MATTER]";
  const client = m?.client ?? "[CLIENT]";
  const dates = (m?.keyDates ?? []).slice(0, 4);
  return `# ${short}: Status update
kicker: Client update · ${today()}
subtitle: Developments since our last report, upcoming deadlines and the decisions we need from you
date: Prepared for ${client}

# Executive summary
- **Where things stand:** ${m?.stage ?? "[STAGE]"}
- **What happened this period:** [two or three concrete developments]
- **What we need from you:** [decisions, documents, approvals]
- **Next milestone:** ${dates[0] ? `${fmt(dates[0].date)} — ${dates[0].label}` : "[DATE] — [EVENT]"}
notes: Lead with the answer. If the client reads only this slide they should know the status, the ask and the next date.

# Recent developments
- [Court order / ruling and what it means for us]
- [Discovery milestone — documents produced, depositions taken]
- [Opposing party position change]
- [Expert or regulatory development]

# Upcoming deadlines
layout: table
| Date | Event | Action required |
${dates.length ? dates.map((d) => `| ${fmt(d.date)} | ${d.label} | [ACTION] |`).join("\n") : "| [DATE] | [EVENT] | [ACTION] |\n| [DATE] | [EVENT] | [ACTION] |"}
caption: Dates reflect the current scheduling order; extensions are noted where sought.

# Budget to date
layout: chart
chart: bar | Phase 1 | Phase 2 | Phase 3
chart-title: Fees and costs vs. budget ($K)
Budget: 650, 900, 1200
Actual: 412, 180, 0
unit: $
- Phase 1 tracking under budget
- Phase 2 spend driven by expert retention
- Phase 3 not yet started
notes: Replace the placeholder figures with the billing report before sending. Say plainly whether we are on budget and why.

# Decisions needed
layout: comparison
left: Option A
- [Description]
- Cost: [$]
- Risk: [low / medium / high]
right: Option B
- [Description]
- Cost: [$]
- Risk: [low / medium / high]

# Next steps
- [Action] — owner — [date]
- [Action] — owner — [date]
- [Action] — owner — [date]
- We will report again on [date]`;
}

function mediationOutline(m: Matter | null): string {
  const short = m?.shortName ?? "[MATTER]";
  return `# ${short}: Mediation statement
kicker: Confidential mediation submission · FRE 408
subtitle: Why the case should resolve now, and on what terms
date: ${today()}

# Why we are here
- Both sides face real risk at trial
- Discovery costs from here exceed $[X]
- A structured resolution is available today
- Our proposal is principled, not a split-the-difference number
notes: Set a cooperative tone. The mediator has read the briefs; this deck is for the decision-makers in the room.

# Liability: the competing narratives
layout: comparison
left: Their story
- [Plaintiff's theory in one line]
- Relies on [document / witness]
- Weakest where [gap]
right: Our story
- [Defense theory in one line]
- Supported by [document / witness]
- Strongest where [record cite]

# What a jury will actually see
layout: timeline
timeline:
- [DATE] — [Event] — [Bates]
- [DATE] — [Event] — [Bates]
- [DATE] — [Event] — [Bates]
- [DATE] — [Event] — [Bates]

# Damages: the range of outcomes
layout: chart
chart: bar | Defense verdict | Plaintiff low | Plaintiff mid | Plaintiff high
chart-title: Probability-weighted outcomes ($M)
Exposure: 0, 3.2, 8.5, 21
unit: $
- Weighted expected value: $[X]M
- Excludes fees and appeal risk
notes: Explain the weighting method in one sentence. Do not defend the individual numbers; the point is the spread.

# Cost of continuing
layout: table
| Phase | Fees | Costs | Time |
| Expert discovery | $[X] | $[X] | 4 months |
| Summary judgment | $[X] | $[X] | 3 months |
| Trial preparation and trial | $[X] | $[X] | 6 months |
| Appeal | $[X] | $[X] | 12–18 months |

# Settlement framework
- Lump-sum payment within [30] days of execution
- Mutual releases; no admission of liability
- Confidentiality with carve-outs for regulators and insurers
- Dismissal with prejudice; each side bears its own fees

# Our proposal
layout: quote
quote: A resolution today at $[X] reflects the realistic range of outcomes, avoids two years of litigation, and lets both parties move on.
by: [FIRM NAME], on behalf of [CLIENT]

# Next steps
- Mediator's proposal by [DATE]
- Term sheet within [7] days of agreement in principle
- Board / carrier approvals: [timing]`;
}

function depoPrepOutline(m: Matter | null): string {
  const short = m?.shortName ?? "[MATTER]";
  return `# Deposition preparation: [WITNESS NAME]
kicker: ${short} · Witness preparation · Privileged
subtitle: Goals, rules, themes, documents and the hard questions
date: Session 1 of 2 · ${today()}

# What this deposition is for
- Opposing counsel wants admissions on [three topics]
- Our goal: accurate, short answers; no volunteering
- The transcript will be read at trial — every word counts
- You are the witness, not the advocate

# Ground rules
- Listen to the whole question; pause; answer only that question
- "I don't know" and "I don't recall" are complete answers when true
- Do not guess at dates, numbers or what others thought
- Ask for the document before answering about it
- Breaks are yours whenever you need one
notes: Practice the pause. Most bad answers come from filling silence.

# Themes to keep in mind
layout: comparison
left: What they will suggest
- You knew about [issue] earlier than you said
- Documents were withheld or delayed
- Decisions were driven by cost
right: What is true
- You acted on the information available at the time
- Reviews followed the standard process
- Safety decisions preceded any mandate

# Documents you will see
layout: table
| Bates | Date | Document | What to remember |
| [BATES] | [DATE] | [Email / memo] | You were copied, not the author |
| [BATES] | [DATE] | [Report] | Draft; final version changed the conclusion |
| [BATES] | [DATE] | [Presentation] | Prepared for a different audience |
| [BATES] | [DATE] | [Meeting minutes] | You were not present |
caption: Review each document with counsel before the session; do not bring notes into the deposition.

# The hard questions
layout: two_column
left: Likely questions
- "Isn't it true that you knew in [YEAR]?"
- "Why didn't you report this to [AGENCY]?"
- "Who told you not to put that in writing?"
right: How to think about them
- Anchor to what you actually knew and when
- Reporting decisions were made by [FUNCTION]; you can say what you observed
- Reject the premise calmly; do not speculate about motives

# Objections and instructions
- Counsel will object to form; you still answer unless instructed not to
- Privilege: if asked about legal advice, wait for counsel
- Scope: this deposition is limited to [topics] under the protective order
- If you realize an earlier answer was wrong, correct it on the record

# Logistics
- Date, time and location: [DATE] · [LOCATION] · videotaped
- Arrive at [TIME]; prep room reserved from [TIME]
- Dress: business; bring identification only
- Contact: [ATTORNEY] · [PHONE]`;
}

function expertTimelineOutline(m: Matter | null): string {
  const short = m?.shortName ?? "[MATTER]";
  return `# Expert chronology: [EXPERT NAME]
kicker: ${short} · Expert discovery · Work product
subtitle: State of the science, regulatory milestones and the reliance record
date: ${today()}

# Expert overview
- **Discipline:** [toxicology / epidemiology / hydrogeology]
- **Opinions offered:** general causation; exposure reconstruction; standard of care
- **Reports served:** opening [DATE]; rebuttal due [DATE]
- **Deposition:** [DATE]

# State of the science over time
layout: timeline
timeline:
- 1990s — Early occupational studies — small cohorts, high-dose exposure
- 2005 — First population biomonitoring — background levels documented
- 2012 — Science panel probable-link findings — [VERIFY] scope and endpoints
- 2018 — Meta-analyses published — heterogeneous exposure metrics
- 2024 — Regulatory risk assessment finalized — MCL derived from feasibility
notes: The theme is that the science moved, and so did the industry. Each node should map to an item on the reliance list.

# Regulatory milestones
layout: timeline
timeline:
- 2000 — Voluntary phase-out announced by the market leader
- 2006 — Stewardship program launched
- 2016 — Lifetime health advisory issued
- 2024 — Final drinking-water rule

# Key studies on the reliance list
layout: table
| Study | Year | Design | Finding | Our critique |
| [Author et al.] | 2012 | Cohort | RR 1.4 (1.1–1.8) | Exposure misclassification |
| [Author et al.] | 2018 | Meta-analysis | Pooled RR 1.42 | I² > 70%; two cohorts drive the result |
| [Author et al.] | 2021 | Case-control | OR 1.2 (0.9–1.6) | Not significant; recall bias |
caption: Confirm each citation against the report's reliance list; mark unverified entries [VERIFY].

# Rule 702 factors applied
- **Sufficient facts or data:** reliance list omits background-exposure literature
- **Reliable methods:** pooled analysis mixes serum and water metrics
- **Reliable application:** back-calculation assumes a fixed half-life
- **Fit:** general causation opinion does not reach plaintiff-specific dose
notes: Map each bullet to a section of the Daubert brief. The 2023 amendment puts the burden squarely on the proponent by a preponderance.

# Cross-examination vulnerabilities
layout: comparison
left: Ours
- Industry funding disclosure
- Prior testimony on a related endpoint
right: Theirs
- Unpublished data reliance
- Selective inclusion of studies
- Dose extrapolation

# Next steps
- Working session with the expert: [DATE]
- Rebuttal report draft: [DATE]
- Daubert motion outline: [DATE]`;
}

function boardBriefingOutline(m: Matter | null): string {
  const name = m?.name ?? "[TRANSACTION NAME]";
  return `# ${m?.shortName ?? "[PROJECT NAME]"}: Board briefing
kicker: Confidential · Board of Directors · Corporate / M&A
subtitle: ${name} — transaction status, diligence findings and approvals requested
date: ${today()}

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
- $[__] enterprise value; [cash / stock]
- Target: [TARGET] ([business description])
- Rationale: [strategic rationale]
right: Status
- Confirmatory diligence substantially complete
- SPA in fourth turn; open points below
- R&W insurance binder in negotiation

# Structure and key terms
layout: table
| Term | Position | Status |
| Consideration | $[__] cash + $[__] stock | [Status] |
| Escrow | [__]% for [__] months | [Status] |
| R&W insurance | $[__] limit; [__]% retention | [Status] |
| Key-employee retention | [Vesting]; $[__] pool | [Status] |
| Closing conditions | [Regulatory clearance]; [consents] | [Status] |

# Diligence findings
- **IP chain of title:** [finding and cure]
- **Customer contracts:** [consents required]
- **Employment:** [exposure; reserve $[X]]
- **Data privacy:** [finding and remediation]
- **Litigation:** [pending / threatened matters]
notes: Lead with IP: it is the one finding that could move price. The rest are manageable in the SPA.

# Principal risks and mitigants
layout: comparison
left: Risks
- IP assignment gap for core models
- Customer consents delay closing
- Key engineers leave post-close
right: Mitigants
- Signing condition: executed assignments from both contributors
- Consent plan with joint outreach; walk right if fewer than 15 obtained
- Retention pool with cliff vesting; non-solicit covenants

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
- Approve the issuance of up to [X] shares as stock consideration
- Delegate closing-condition waivers to the transaction committee
notes: Read the resolutions verbatim from the board book. Confirm quorum before the vote.`;
}

function cleOutline(): string {
  return `# Rule 702 after the 2023 amendment
kicker: CLE · Evidence · 1.0 general credit
subtitle: What changed, what courts are doing with it, and how to brief it
date: [FIRM NAME] · ${today()}

# Agenda
- The text: what the amendment changed
- Why the Advisory Committee acted
- How circuits are applying the amended rule
- Briefing and hearing strategy
- Hypotheticals

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

# Why the Committee acted
- Committee Note identifies "incorrect" case law treating sufficiency of basis as a weight issue
- Concern about overstated conclusions — the expert's opinion must stay within what the method supports
- No change to Daubert factors; the change is who must prove what, and to what standard

# Circuit trends
layout: table
| Circuit | Representative decision | Takeaway |
| 3d Cir. | [VERIFY] | Amended rule applied to exclude extrapolated dose opinion |
| 4th Cir. | Sardis v. Overhead Door Corp., 10 F.4th 268 (2021) | Pre-amendment; anticipates the burden framing |
| 9th Cir. | [VERIFY] | Weight-vs-admissibility language still appears |
| 11th Cir. | [VERIFY] | Emphasis on "overstated" conclusions |
caption: Verify every citation before presenting; case names marked [VERIFY] are placeholders.

# Briefing strategy
- Lead with the amended text and the Committee Note, not with Daubert factors
- Attack application: show the gap between method and conclusion with the expert's own data
- Ask for findings on each element; propose an order that recites them
- Preserve the objection at trial — the ruling is reviewed for abuse of discretion

# Hypothetical
layout: two_column
left: Facts
- Epidemiologist pools five studies with different exposure metrics
- Reports a pooled relative risk of 1.4
- Opines that the exposure "can cause" the disease at any dose
right: Questions
- Is the pooling a reliable method as applied?
- Does the "any dose" conclusion exceed what the data support?
- What findings would you ask the court to make?

# Questions
layout: section
subtitle: Materials and citations available on the firm library under Knowledge / CLE`;
}

function allHandsOutline(): string {
  return `# Firm all-hands
kicker: [FIRM NAME] · Quarterly all-hands
subtitle: Wins, pipeline, people and what is next
date: ${today()}

# Agenda
- Wins this quarter
- Matter pipeline and utilization
- New colleagues and promotions
- Platform and knowledge initiatives
- Calendar and next steps

# Wins this quarter
- [Win 1: result, matter, team]
- [Win 2]
- [Win 3]
- [Win 4]
notes: Name the teams. People remember who was thanked.

# Matter pipeline by practice
layout: chart
chart: pie | Products Liability | Commercial | Corporate / M&A | Employment | Regulatory
chart-title: Active matters by practice area
Matters: 1, 1, 1, 1, 1
- [__] active matters; [__] opened this quarter
- Utilization [__]% firm-wide

# New colleagues and promotions
- Welcome [NAME], Associate (litigation)
- Welcome [NAME], E-discovery analyst
- Promotion: [NAME] to Senior Associate
- Bar admissions: [NAME] (D.C.)

# Platform and knowledge initiatives
layout: two_column
left: Shipped
- Office agents: Word, Excel, PowerPoint and PDF drafting assistants
- E-discovery timelines and conflict detection
- Workflow templates for intake and privilege logging
right: Coming next
- Docket monitoring alerts
- Firm-wide citation verification
- Template library refresh (transactional)

# Calendar
layout: timeline
timeline:
- [Date] — [Deadline or event]
- [Date] — [Deadline or event]
- [Date] — [Deadline or event]
- [Date] — [Firm event]

# Thank you
layout: section
subtitle: Questions, ideas and feedback: [CONTACT]`;
}

export const SLIDES_TEMPLATES: OfficeTemplate[] = [
  { id: "slides-case-strategy", kind: "slides", name: "Case strategy deck", description: "Themes, chronology, key documents with Bates cites, damages exposure, risks and next steps for an internal or client strategy session.", category: "Litigation", practiceArea: "Litigation", tags: ["strategy", "litigation", "internal"], build: ({ matterId }) => deckFromOutline(caseStrategyOutline(matterOf(matterId)), "classic-navy") },
  { id: "slides-client-update", kind: "slides", name: "Client status update", description: "Executive summary, developments, deadline table, budget chart and decisions needed — client-ready in the Client Light theme.", category: "Client", practiceArea: "Litigation", tags: ["client", "status", "budget"], build: ({ matterId }) => deckFromOutline(clientUpdateOutline(matterOf(matterId)), "client-light") },
  { id: "slides-mediation", kind: "slides", name: "Mediation presentation", description: "FRE 408 mediation statement: competing narratives, what a jury will see, outcome ranges, cost of continuing and a settlement framework.", category: "Litigation", practiceArea: "Litigation", tags: ["mediation", "settlement"], build: ({ matterId }) => deckFromOutline(mediationOutline(matterOf(matterId)), "counsel-slate") },
  { id: "slides-depo-prep", kind: "slides", name: "Deposition prep for witness", description: "Witness-facing preparation deck: goals, ground rules, themes, documents to know, the hard questions, objections and logistics.", category: "Litigation", practiceArea: "Litigation", tags: ["deposition", "witness", "prep"], build: ({ matterId }) => deckFromOutline(depoPrepOutline(matterOf(matterId)), "courtroom-serif") },
  { id: "slides-expert-timeline", kind: "slides", name: "Expert timeline", description: "State-of-the-science and regulatory timelines, reliance-list table, Rule 702 factors and cross-examination vulnerabilities.", category: "Litigation", practiceArea: "Products Liability", tags: ["expert", "Daubert", "timeline"], build: ({ matterId }) => deckFromOutline(expertTimelineOutline(matterOf(matterId)), "classic-navy") },
  { id: "slides-board-briefing", kind: "slides", name: "Board M&A briefing", description: "Deal overview, key terms table, diligence findings, risks and mitigants, timeline to closing and the resolutions requested.", category: "Transactional", practiceArea: "Corporate / M&A", tags: ["M&A", "board", "diligence"], build: ({ matterId }) => deckFromOutline(boardBriefingOutline(matterOf(matterId)), "counsel-slate") },
  { id: "slides-cle-rule-702", kind: "slides", name: "CLE training deck (Rule 702)", description: "The 2023 amendment to Rule 702: text, before/after comparison, circuit trends table, briefing strategy and a hypothetical.", category: "Internal", tags: ["CLE", "evidence", "training"], build: () => deckFromOutline(cleOutline(), "courtroom-serif") },
  { id: "slides-all-hands", kind: "slides", name: "Firm all-hands", description: "Quarterly all-hands: wins, pipeline chart, people, initiatives and the calendar.", category: "Internal", tags: ["firm", "all-hands"], build: () => deckFromOutline(allHandsOutline(), "modern-mono") },
  { id: "slides-blank", kind: "slides", name: "Blank deck", description: "A single title slide in the firm theme.", category: "Internal", tags: ["blank"], build: ({ title }) => deckFromOutline(`# ${title ?? "Untitled deck"}\nsubtitle: \ndate: ${today()}`, "classic-navy") },
];
