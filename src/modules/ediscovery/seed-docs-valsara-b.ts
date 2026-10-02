import type { DocSpec } from "./seed-helpers";
import { REVIEWERS } from "./seed-helpers";

/**
 * Valsara Textile Park v. Meridian Fine Chemicals (fictional arbitration) — Meridian custodial documents, block B.
 * MFC-0052210 …: the Valsara MW-7 groundwater series (2002), the two-year
 * bioassay interim, defence correspondence, and later-dated documents through
 * 2012. MFC-0043105 … 0043951: the 2016–2017 documents relied on by the
 * chronology and privilege-log workflows.
 */

const R = REVIEWERS;
const T_MW7 = "thr_vls_mw7";
const T_MIL = "thr_vls_milspec";
const T_8E_2016 = "thr_vls_8e_2016";

export const VALSARA_DOCS_B: DocSpec[] = [
  // ------------------------------------------------------------------
  // MFC-0052210 — Valsara MW-7 results (July 2002)
  // ------------------------------------------------------------------
  {
    id: "ed_vls_0057",
    batesAt: 52210,
    pages: 2,
    date: "2002-07-08",
    time: "15:22",
    custodian: "hegde",
    type: "Email",
    subject: "Valsara site — monitoring well MW-7 results",
    to: ["Anil Prasad", "Manish Sood"],
    cc: ["Nandini Bose", "Pankaj Malhotra"],
    threadId: T_MW7,
    attachmentIds: ["ed_vls_0058"],
    aiScore: 95,
    aiIssues: ["ENV-01", "REG-02"],
    aiSummary: "Hegde reports Beacon Enviro Services's Q2 2002 results: MC-8 at MW-7 has risen to 41 µg/L, the new property-line well MW-8 shows 6.8 µg/L, and Lagoon 2's unlined section is the likely source. He recommends notifying GPCB, sampling the Valsara Textile Park wellfield, and closing Lagoon 2, and warns that the migration will reach the property line within two to three years.",
    entities: { people: ["Girish Hegde", "Anil Prasad", "Manish Sood", "Charu Nair", "Lata Fernandes"], orgs: ["Beacon Enviro Services", "GPCB", "Valsara Textile Park Water Works"], places: ["Valsara, Gujarat", "Lagoon 2", "MW-7", "MW-8", "Sarvani River"], chemicals: ["MC-8", "MF-3"] },
    coding: { responsive: true, privileged: false, hot: true, confidentiality: "highly confidential", issues: ["ENV-01", "REG-02"], reviewerId: R.mehra, reviewedAt: "2026-09-12T08:10:00Z", notes: "Central groundwater document. Hegde recommends notifying the Board; Prasad reply (MFC-0052217) says 'not in email'. Bose Dep. Ex. 14." },
    tags: ["key-doc", "exhibit-candidate"],
    body: `Anil, Manish —

Beacon's Q2 results for the Valsara wells are attached. I need decisions this week.

MW-7 (downgradient of Lagoon 2): MC-8 41 µg/L. That is up from 12 in September and 19 in December. MW-8, the new well at the south property line: 6.8 µg/L. MW-5: 2.1. MW-3 (upgradient): 0.3, unchanged. The liner survey in December found the 1989 liner intact but confirmed the south third of Lagoon 2 was never lined. Beacon's interpretation is that repellent agent from the Building 7 drains has been infiltrating from the unlined section for a decade and the plume is moving south-southeast at roughly 45 metres a year. At that rate it is at the property line now (it is — MW-8) and under the Kesar farm within two years.

The Valsara Textile Park wellfield (Wells 9–12) is 2.3 km in that direction. Beacon thinks the clay unit protects the deep aquifer but says "uncertain continuity" and will not put a number on it.

My recommendations:
1. Notify GPCB (Jyoti Rathore, Regional Office) voluntarily, now. There is no MC-8 standard, so this is not a reportable exceedance, but we have an off-site migration of a compound we know is persistent and bioaccumulative, toward the Park's drinking-water supply.
2. Ask the Park water works (Lata Fernandes) to let us sample Wells 9–12. Offer to pay.
\f3. Close Lagoon 2 and complete the Building 7 drain re-route (construction started in March, 60% done).
4. Install two more wells between MW-8 and the wellfield.

I know Anil will want Legal to look at (1) and (2) first. Fine, but I want it on the record that EHS recommended both today.

Girish

Girish Hegde
Director, Environmental Health & Safety
Meridian Fine Chemicals Ltd.`,
  },
  {
    id: "ed_vls_0058",
    pages: 5,
    date: "2002-07-03",
    custodian: "hegde",
    type: "Report",
    subject: "Beacon Enviro Services — Q2 2002 groundwater monitoring results — Meridian Fine Chemicals Valsara facility",
    from: "Charu Nair",
    to: ["Girish Hegde"],
    parentId: "ed_vls_0057",
    aiScore: 89,
    aiIssues: ["ENV-01"],
    coding: { responsive: true, privileged: false, hot: false, issues: ["ENV-01"], reviewerId: R.marsh, reviewedAt: "2026-09-12T08:20:00Z" },
    body: `BEACON ENVIRO SERVICES PVT. LTD.
14 Ring Road, Surat, Gujarat 395002

LETTER REPORT — Second Quarter 2002 Groundwater Monitoring
Meridian Fine Chemicals Ltd., Valsara Facility — Beacon Project 99-1187
3 July 2002

Prepared for: Girish Hegde, Director EHS
Prepared by: Charu Nair, Senior Hydrogeologist

1. SCOPE. Beacon sampled monitoring wells MW-3, MW-5, MW-7 and the newly installed MW-8 on 17–18 June 2002 for MC-8 (MC-8, as anion) and adsorbable organic halogens (AOX), per the scope approved 14 Jan 2002. Samples were collected by low-flow purging and analysed by Beacon's NABL-accredited subcontract laboratory (Vadodara) by LC/MS/MS, reporting limit 0.05 µg/L MC-8.

2. RESULTS (MC-8, µg/L):
   Well  | Location                          | Sep 2001 | Dec 2001 | Jun 2002
   MW-3  | Upgradient, NW of Lagoon 2        |  0.31    |  0.28    |  0.30
   MW-5  | Cross-gradient, E of Bldg 7       |   —      |  1.4     |  2.1
   MW-7  | 27 m S of Lagoon 2 (unlined sec.) |  12.0    |  19.3    |  41.2
   MW-8  | South property line (new, 5/02)   |   —      |   —      |  6.8
   Field duplicate MW-7: 39.7. Trip blank: <0.05. AOX results tabulated in Attachment A and are consistent.

\f3. LINER INTEGRITY. Beacon's electrical leak-location survey of Lagoon 2 (3–5 Dec 2001) found the 1989 HDPE liner intact over the northern two-thirds of the impoundment. The southern approximately 0.3 hectare, added in 1991 when the lagoon was enlarged, has no synthetic liner; construction records indicate compacted clay only. Lagoon 2 receives Building 7 floor-drain and tote-wash flows (until the drain re-route is complete) and stormwater.

4. HYDROGEOLOGY. Shallow aquifer: silty sand, water table 4.3–5.2 m bgl, flow S-SE, gradient 0.004, estimated velocity 35–55 m/yr. A stiff clay unit at 10–12 m bgl separates the shallow aquifer from the deeper sand-and-gravel aquifer from which the Valsara Textile Park Ltd. draws Wells 9–12 (approx. 2.3 km SSE). Boring logs from the 1989 and 1997 well installations show the clay unit present at all locations on the property, but its continuity between the property line and the wellfield has not been investigated.

\f5. INTERPRETATION. The rising MC-8 concentrations at MW-7 and the detection at MW-8 indicate a plume of MC-8 in the shallow aquifer originating at the unlined southern section of Lagoon 2 and extending beyond the southern property boundary. Given the persistence of MC-8 and the absence of attenuation mechanisms other than dilution and sorption, the plume will continue to migrate. Concentrations at the property line will likely increase. Off-site receptors in the shallow aquifer (domestic wells on the Kesar property, approx. 550 m SSE, if any are screened in the shallow zone) should be identified.

6. REGULATORY. There is no numeric groundwater standard for MC-8. GPCB may nonetheless take the view, on a case-specific basis, that the release calls for notification and action under the facility's consent conditions. Beacon recommends that Meridian obtain legal advice on notification.

\f7. RECOMMENDATIONS.
 (a) Confirmation sampling of MW-8 in Q3 2002.
 (b) Install MW-9 and MW-10 between MW-8 and the Kesar property line; survey for shallow domestic wells within 800 m.
 (c) Cease discharge of process flows to Lagoon 2 immediately (drain re-route) and evaluate closure of the unlined section.
 (d) Request access to sample Valsara Textile Park Ltd. Wells 9–12 for MC-8 as a precaution.
 (e) Prepare a conceptual site model and evaluate remedial options (source removal; hydraulic containment).

Attachments: A — Laboratory reports and QA/QC. B — Potentiometric surface map, June 2002. C — Liner survey summary.

C. Nair, M.Sc. (Hydrogeology)`,
  },
  {
    id: "ed_vls_0059",
    date: "2002-07-09",
    time: "07:52",
    custodian: "prasad",
    type: "Email",
    subject: "RE: Valsara site — monitoring well MW-7 results",
    to: ["Girish Hegde"],
    cc: ["Manish Sood", "Pankaj Malhotra"],
    threadId: T_MW7,
    aiScore: 93,
    aiIssues: ["ENV-01", "REG-02"],
    coding: { responsive: true, privileged: false, hot: true, confidentiality: "highly confidential", issues: ["ENV-01", "REG-02"], reviewerId: R.mehra, reviewedAt: "2026-09-12T08:25:00Z", notes: "'Do not put this in email.' Not privileged: no request for legal advice; Sood cc'd as a recipient of a business instruction. Hot." },
    tags: ["key-doc"],
    body: `Girish —

Do not put this in email. Not the recommendations, not the numbers, not the farm. I want a meeting with you, Manish, Pankaj and Rohit in my office at 2 today.

Nothing goes to the Board or to the Park until Legal has looked at it. That is not a "no," it is a "not yet."

Nandini — you are off this thread.

Anil`,
  },
  {
    id: "ed_vls_0060",
    date: "2002-07-09",
    time: "11:38",
    custodian: "sood",
    type: "Email",
    subject: "RE: Valsara site — monitoring well MW-7 results — notification obligations",
    to: ["Anil Prasad", "Girish Hegde", "Rohit Kapur"],
    cc: ["Pankaj Malhotra"],
    threadId: T_MW7,
    aiScore: 90,
    aiIssues: ["ENV-01", "REG-02", "LEG-01"],
    coding: { responsive: true, privileged: true, privilegeBasis: "attorney-client", confidentiality: "AEO", issues: ["ENV-01", "REG-02", "LEG-01"], reviewerId: R.marsh, reviewedAt: "2026-09-12T08:40:00Z", notes: "Preliminary legal analysis by regulatory counsel to client executives. Withhold; log." },
    body: `PRIVILEGED & CONFIDENTIAL — ATTORNEY-CLIENT COMMUNICATION

For the 2 pm meeting — my preliminary legal view on notification, so we are not starting cold.

1. State. No numeric groundwater standard for MC-8, so no automatic reporting trigger. Our consent conditions and the general prohibition on discharging polluting matter are the exposure; GPCB can act without a numeric standard if it can show the release is polluting. We would argue no standard, no harm shown. That argument gets weaker every quarter the numbers go up and gets very weak if the Park's wells ever show a detection.

2. Hazardous-waste listing. MC-8 is not a listed hazardous constituent, so there is no listing-based trigger.

3. Clause 9.4. This is the one I want Rohit's view on. We have now, in one company, (a) a 90-day rat study showing toxicity and slow elimination, (b) a two-year study in progress with serum still rising at 6 months, (c) lower cholesterol in our own blending crew, and (d) an off-site groundwater plume of the same compound heading toward the Park's wellfield. The March 2001 memo said revisit. Each piece may be defensible alone. I am not comfortable that the set is.

4. Voluntary notification (Girish's recommendation). Legally it is the safer course with the Board and it makes the Clause 9.4 question easier, because we would be acting rather than waiting. The cost is that it starts a public process. My advice will be to do it, in a controlled way, with a remediation plan in hand.

Manish`,
  },
  {
    id: "ed_vls_0061",
    date: "2002-07-10",
    time: "16:20",
    custodian: "hegde",
    type: "Email",
    subject: "RE: Valsara site — monitoring well MW-7 results — actions from 7/9 meeting",
    to: ["Anil Prasad", "Manish Sood", "Pankaj Malhotra", "Rohit Kapur"],
    threadId: T_MW7,
    aiScore: 88,
    aiIssues: ["ENV-01", "REG-02"],
    coding: { responsive: null, privileged: null, issues: [], notes: "Meeting notes summarising decisions including counsel's advice. Mixed. Redact ¶3 (Kapur advice) and produce remainder? Second-level review." },
    body: `Actions from yesterday's meeting, as I understood them:

1. Drain re-route: accelerate; complete by 15 August. Hooda to add a second crew. (Malhotra)
2. Lagoon 2: stop all process flows now; pump down the unlined section and haul; closure plan from Beacon by 30 Sept. (Hegde)
3. Rohit's view was that a voluntary notification to GPCB is appropriate but should be made after we have a closure plan and the additional wells in hand, so that we go in with a plan and not a problem. Target: October. (Sood/Kapur)
4. Park wells: do not approach the Park until (3). (Prasad)
5. Kesar property: Beacon to do a well survey from public records only; no site visit. (Hegde)
6. Communications: no written communication about MW-7 outside this group. Beacon reports go to Hegde only. (Prasad)

I want to note for the record that I disagree with the sequencing on items 3 and 4 and said so in the meeting. If the Park's wells are clean, sampling them costs us nothing. If they are not, every month matters.

Girish`,
  },
  {
    id: "ed_vls_0062",
    date: "2002-07-15",
    time: "13:05",
    custodian: "hegde",
    type: "Email",
    subject: "GPCB — call from Jyoti Rathore re: The Sarangpur Co-operative and Valsara",
    to: ["Manish Sood"],
    cc: ["Anil Prasad"],
    aiScore: 84,
    aiIssues: ["REG-02", "ENV-01"],
    coding: { responsive: null, privileged: null, issues: [] },
    body: `Manish —

Jyoti Rathore (GPCB Regional Office, Bharuch) called me this morning. Ostensibly about the Sarangpur Co-operative — she wanted to know whether Meridian had provided the Co-operative with disposal guidance (yes, and the sump). Then she asked, in passing, whether Meridian "does any groundwater monitoring at the Valsara plant for the finish chemicals." I said we have a monitoring well network and that we sample it. She asked whether we would share the data. I said I would need to check with our regulatory group and would get back to her.

She did not say why she was asking. My guess is Mr. Dutta's letter (which was cc'd to her in April 2001) plus Orbis's publicity.

I did not lie to her and I am not going to. Please advise what I can tell her, by when.

Girish`,
  },
  {
    id: "ed_vls_0063",
    pages: 2,
    date: "2002-10-24",
    custodian: "hegde",
    type: "Letter",
    subject: "Letter to Valsara Textile Park Water Works — notification of shallow groundwater monitoring results and offer of wellfield sampling",
    from: "Girish Hegde",
    to: ["Lata Fernandes"],
    cc: ["Jyoti Rathore", "Manish Sood"],
    aiScore: 86,
    aiIssues: ["ENV-01", "REG-02", "CUS-01"],
    coding: { responsive: true, privileged: false, hot: true, issues: ["ENV-01", "REG-02"], reviewerId: R.marsh, reviewedAt: "2026-09-12T09:15:00Z", notes: "First disclosure to the Park, 3.5 months after MW-7 results. The letter does not state the MW-7 concentration." },
    body: `MERIDIAN FINE CHEMICALS LTD.
Plot 18, Industrial Estate Road, Valsara, Gujarat 394120

October 24, 2002

Ms. Lata Fernandes
Director, Water Management Services
Valsara Textile Park Ltd.
Park Administration Building
Valsara, Gujarat 394120

Re: Groundwater monitoring at the Meridian Fine Chemicals Valsara facility

Dear Ms. Fernandes:

Meridian Fine Chemicals Ltd. operates a network of groundwater monitoring wells at its Valsara facility as part of its environmental management program. Recent monitoring has detected an organohalogen compound used in the manufacture of water-repellent finish concentrates in the shallow aquifer beneath the facility and at the facility's southern boundary. The compound is not regulated in groundwater under any state or national standard. Meridian has ceased the process discharge that is believed to be the source, has begun closure of the affected surface impoundment, and has installed additional wells to define the extent of the affected groundwater. Meridian has informed the Gujarat Pollution Control Board of these results and its response actions.

\fThe Park's Wells 9 through 12 draw from the deep sand-and-gravel aquifer, which is separated from the shallow aquifer by a clay layer. Meridian's consultant, Beacon Enviro Services, considers it unlikely that the shallow groundwater affects the Park's wells. As a precaution, however, Meridian offers to sample the Park's Wells 9 through 12, at Meridian's expense, using a laboratory method capable of detecting the compound at very low concentrations, and to share the results with the Park and the GPCB. Meridian would also be glad to meet with the Park's staff to review the monitoring data.

Please contact me at +91 2646 50 0141 to arrange sampling at the Park's convenience.

Sincerely,

Girish Hegde
Director, Environmental Health & Safety

cc: Jyoti Rathore, GPCB Regional Office (Water); Manish Sood, Meridian Fine Chemicals`,
  },
  {
    id: "ed_vls_0064",
    date: "2002-07-08",
    time: "15:22",
    custodian: "prasad",
    type: "Email",
    subject: "Valsara site — monitoring well MW-7 results",
    from: "Girish Hegde",
    to: ["Anil Prasad", "Manish Sood"],
    cc: ["Nandini Bose", "Pankaj Malhotra"],
    threadId: T_MW7,
    duplicateOf: "ed_vls_0057",
    pages: 2,
    aiScore: 95,
    aiIssues: ["ENV-01", "REG-02"],
    coding: { responsive: true, privileged: false, hot: true, confidentiality: "highly confidential", issues: ["ENV-01", "REG-02"], reviewerId: R.lopez, reviewedAt: "2026-09-12T08:12:00Z", notes: "Exact duplicate of MFC-0052210 from Prasad mailbox." },
    body: `Anil, Manish —

Beacon's Q2 results for the Valsara wells are attached. I need decisions this week.

MW-7 (downgradient of Lagoon 2): MC-8 41 µg/L. That is up from 12 in September and 19 in December. MW-8, the new well at the south property line: 6.8 µg/L. MW-5: 2.1. MW-3 (upgradient): 0.3, unchanged. The liner survey in December found the 1989 liner intact but confirmed the south third of Lagoon 2 was never lined. Beacon's interpretation is that repellent agent from the Building 7 drains has been infiltrating from the unlined section for a decade and the plume is moving south-southeast at roughly 45 metres a year. At that rate it is at the property line now (it is — MW-8) and under the Kesar farm within two years.

The Valsara Textile Park wellfield (Wells 9–12) is 2.3 km in that direction. Beacon thinks the clay unit protects the deep aquifer but says "uncertain continuity" and will not put a number on it.

My recommendations:
1. Notify GPCB (Jyoti Rathore, Regional Office) voluntarily, now. There is no MC-8 standard, so this is not a reportable exceedance, but we have an off-site migration of a compound we know is persistent and bioaccumulative, toward the Park's drinking-water supply.
2. Ask the Park water works (Lata Fernandes) to let us sample Wells 9–12. Offer to pay.
\f3. Close Lagoon 2 and complete the Building 7 drain re-route (construction started in March, 60% done).
4. Install two more wells between MW-8 and the wellfield.

I know Anil will want Legal to look at (1) and (2) first. Fine, but I want it on the record that EHS recommended both today.

Girish

Girish Hegde
Director, Environmental Health & Safety
Meridian Fine Chemicals Ltd.`,
  },

  // ------------------------------------------------------------------
  // Two-year bioassay interim (Sept 2002)
  // ------------------------------------------------------------------
  {
    id: "ed_vls_0065",
    date: "2002-09-12",
    time: "10:05",
    custodian: "vasudevan",
    type: "Email",
    subject: "Two-year bioassay — 12-month interim report received",
    to: ["Manish Sood", "Girish Hegde", "Rohit Kapur"],
    cc: ["Anil Prasad"],
    attachmentIds: ["ed_vls_0066"],
    aiScore: 91,
    aiIssues: ["TOX-02", "REG-01"],
    coding: { responsive: true, privileged: false, hot: true, issues: ["TOX-02", "REG-01"], reviewerId: R.marsh, reviewedAt: "2026-09-12T10:00:00Z", notes: "Transmittal of the interim. Vasudevan expressly invokes the 'revisit' condition of the March 2001 memo." },
    tags: ["key-doc"],
    body: `All —

Sundaram's 12-month interim report on the two-year study (SL-2001-0512) came in this morning. Summary attached; full report to follow by courier.

The short version: at 12 months the 1.5 mg/kg-day group has serum MC-8 of 96 µg/mL (still rising), hepatocellular hypertrophy in 9/10 males and 8/10 females, and — this is new — hepatocellular adenomas in 2/10 males. Two adenomas in ten animals at an interim is not a statistical finding and Sundaram says so. But the pathologist notes it, and the 0.3 group has hypertrophy in 4/10 males, so the NOAEL for the chronic study is going to be 0.03 mg/kg-day, three times lower than the 90-day NOAEL.

Manish — this is the "revisit" the March 2001 memo called for. I am sending it to you and Rohit at the same time as Girish and Anil, on purpose.

Hema`,
  },
  {
    id: "ed_vls_0066",
    pages: 10,
    date: "2002-09-11",
    custodian: "vasudevan",
    type: "Report",
    subject: "Sundaram SL-2001-0512 — two-year chronic bioassay of MF-3 in rats — 12-month interim report (summary)",
    from: "Dr. Leela Sundaram",
    parentId: "ed_vls_0065",
    aiScore: 96,
    aiIssues: ["TOX-02", "TOX-01"],
    aiSummary: "Twelve-month interim of the chronic dietary study of MF-3 in rats. Serum MC-8 continues to rise at all doses (96 µg/mL at 1.5 mg/kg-day). Hepatocellular hypertrophy at 0.3 and 1.5 mg/kg-day; two hepatocellular adenomas in high-dose males at the interim sacrifice; thyroid follicular hypertrophy at the high dose. Interim NOAEL 0.03 mg/kg-day. Sundaram recommends the sponsor consider the regulatory significance of the adenoma finding.",
    entities: { people: ["Leela Sundaram", "Yusuf Bilgrami", "Hema Vasudevan"], orgs: ["Sundaram Laboratories", "Meridian Fine Chemicals Ltd."], places: ["Genome Valley, Hyderabad"], chemicals: ["MC-8", "MF-3"] },
    coding: { responsive: true, privileged: false, hot: true, confidentiality: "highly confidential", issues: ["TOX-02", "TOX-01"], reviewerId: R.mehra, reviewedAt: "2026-09-12T10:20:00Z" },
    tags: ["key-doc", "exhibit-candidate"],
    body: `SUNDARAM LABORATORIES PVT. LTD.
INTERIM REPORT — 12 MONTHS — SUMMARY
Study No. SL-2001-0512
A Two-Year Dietary Chronic Toxicity and Carcinogenicity Study of MF-3 Repellent Finish Concentrate in Sprague-Dawley Rats
Sponsor: Meridian Fine Chemicals Ltd. — Sponsor Representative: H. Vasudevan
Study Director: L. Sundaram, Ph.D., DABT — Pathologist: Y. Bilgrami, DVM, Ph.D., DACVP
In-life start: 27 August 2001 — Interim sacrifice: 26–28 August 2002 — Report: 11 September 2002

1. DESIGN. Dietary administration at 0, 0.5, 5 and 25 ppm (target 0, 0.03, 0.3 and 1.5 mg/kg-day) to 50 rats/sex/group (main) and 10/sex/group (interim). Interim animals were necropsied at 52 weeks with full histopathology of liver, thyroid, kidney, pancreas, testes and gross lesions.

2. ACHIEVED DOSE (weeks 1–52, mean): males 0.031, 0.31, 1.49; females 0.033, 0.33, 1.56 mg/kg-day.

\f3. SURVIVAL AND CLINICAL SIGNS. Survival at 52 weeks: 96–100% in all groups. No treatment-related clinical signs. Body weight of high-dose males 7% below control at week 52 (p<0.05).

4. SERUM MC-8 (µg/mL, mean, n=10/sex):
   Group      3 mo    6 mo    9 mo    12 mo
   0.03       0.9     1.6     2.2     2.7
   0.3        8.7    16.1    22.4    28.9
   1.5       38.1    64.8    83.5    96.2
   Steady state has not been reached at any dose after 52 weeks.

\f5. CLINICAL CHEMISTRY (12 months). Total cholesterol reduced at 0.3 (-19%) and 1.5 (-37%) mg/kg-day in males; -15% and -31% in females. ALT elevated at 1.5 (1.7x males). T4 reduced 22% (males) and 29% (females) at 1.5 mg/kg-day; TSH increased.

6. ORGAN WEIGHTS. Relative liver weight: +9% (0.3, males, n.s.), +31% (1.5, males, p<0.01), +24% (1.5, females, p<0.01). Thyroid: +17% at 1.5 (both sexes, p<0.05).

\f7. HISTOPATHOLOGY — INTERIM SACRIFICE (10/sex/group)
LIVER
  Hepatocellular hypertrophy, centrilobular: M 0/10, 0/10, 4/10, 9/10; F 0/10, 0/10, 2/10, 8/10.
  Hepatocellular vacuolation: M 1/10, 0/10, 2/10, 6/10; F 0/10, 1/10, 1/10, 5/10.
  Focus of cellular alteration (eosinophilic): M 0/10, 0/10, 1/10, 3/10; F 0/10, 0/10, 0/10, 2/10.
  HEPATOCELLULAR ADENOMA: M 0/10, 0/10, 0/10, 2/10; F 0/10, 0/10, 0/10, 0/10.
  Hepatocellular carcinoma: 0 in all groups.
THYROID
  Follicular cell hypertrophy: M 0/10, 0/10, 1/10, 5/10; F 0/10, 0/10, 0/10, 6/10.
  Follicular cell adenoma: 0 in all groups.
PANCREAS
  Acinar cell hyperplasia: M 0/10, 0/10, 0/10, 2/10.
TESTES
  Leydig cell hyperplasia: 0/10, 0/10, 1/10, 1/10.

\f8. PATHOLOGIST'S COMMENT (Y. Bilgrami). The two hepatocellular adenomas in high-dose males at 12 months are noted. Spontaneous hepatocellular adenomas in male Sprague-Dawley rats at 12 months are rare (Sundaram historical control range 0–1% at 12 months; 2–6% at 24 months). Two in ten animals is not statistically significant against a concurrent control of zero (Fisher exact p = 0.24), but the finding, together with the eosinophilic foci at 0.3 and 1.5 mg/kg-day, is consistent with a hepatocellular proliferative response and is of a kind that frequently precedes a positive carcinogenicity outcome at 24 months for peroxisome-proliferating compounds. The sponsor should be prepared for a positive liver tumour finding at the end of the study.

9. INTERIM NOAEL. 0.03 mg/kg-day (males), based on hepatocellular hypertrophy and eosinophilic foci at 0.3 mg/kg-day.

\f10. STUDY DIRECTOR'S RECOMMENDATIONS. (a) Continue the study to 104 weeks as planned. (b) Add serum sampling at 18 months (in protocol). (c) The sponsor should consider the regulatory significance of the adenoma finding and of the continued rise in serum concentration in consultation with its regulatory advisers. Sundaram Laboratories does not offer regulatory advice, but notes that the CPCB has recently requested interim data on MC-8 studies from other sponsors. (d) The sponsor may wish to commission a mechanistic study (peroxisome proliferation markers, cell proliferation) to inform human relevance.

L. Sundaram, Ph.D., DABT — 11 September 2002
QA statement: Interim data audited 3–9 September 2002 — M. Ostwal`,
  },
  {
    id: "ed_vls_0067",
    date: "2002-09-16",
    time: "17:35",
    custodian: "kapur",
    type: "Email",
    subject: "RE: Two-year bioassay — 12-month interim report — privileged",
    to: ["Manish Sood"],
    aiScore: 92,
    aiIssues: ["REG-01", "LEG-01", "TOX-02"],
    coding: { responsive: true, privileged: true, privilegeBasis: "attorney-client", hot: true, confidentiality: "AEO", issues: ["REG-01", "LEG-01"], reviewerId: R.mehra, reviewedAt: "2026-09-12T10:40:00Z", notes: "AGC directing Clause 9.4 notice after interim. Withhold; log. The fact of the October 2002 notice is not privileged and the notice itself is in the Park's records." },
    tags: ["privilege-review"],
    body: `PRIVILEGED & CONFIDENTIAL — ATTORNEY-CLIENT COMMUNICATION

Manish —

I have read the interim. My advice is that we give notice. The adenoma finding, the rising serum at every dose, and the MW-7 plume are, taken together, information that reasonably supports a substantial-risk conclusion, and the "corroborative" argument is no longer available to us. The fact that CPCB already has the 90-day summary from our June 2001 voluntary submission may help on liquidated damages; it does not help on the obligation, which runs to the Park.

Please prepare a Clause 9.4 notice covering (a) the 12-month interim, (b) the serum data from both studies, and (c) the groundwater results at MW-7 and MW-8, for service on the Park by 11 October (30 days from receipt of the interim), copied to GPCB as Schedule 6 requires. Use the "does not constitute an admission" language. Attach the interim summary, not the full report.

Anil will need to be told today. I will do it. Do not send him the interim by email; give him the paper copy.

Separately, and for your file: I want a memorandum from you, privileged, reviewing whether the March 2001 analysis should have come out differently in light of what we knew by December 2001 (the MW-7 detection and the cholesterol finding). I would rather know the answer now than learn it from a production order.

Rohit`,
  },

  // ------------------------------------------------------------------
  // defence / DTS correspondence
  // ------------------------------------------------------------------
  {
    id: "ed_vls_0068",
    date: "2002-10-03",
    time: "09:20",
    custodian: "prasad",
    type: "Email",
    subject: "DTS-24385F qualification — questions on environmental and toxicological profile of Aqua-Guard 3",
    from: "Col. Devendra Wadhwa",
    to: ["Anil Prasad"],
    cc: ["Nandini Bose"],
    threadId: T_MIL,
    aiScore: 85,
    aiIssues: ["GOV-01", "MKT-01"],
    coding: { responsive: true, privileged: false, issues: ["GOV-01", "MKT-01"], reviewerId: R.lopez, reviewedAt: "2026-09-12T11:00:00Z" },
    body: `Mr. Prasad,

DQA-T has received CPCB's request for information regarding MC-8-based finishes on the approved list, and the Textile Auxiliaries Manufacturers' Forum's letter of 20 September. In connection with the approved-list review, I am directed to ask each qualified supplier the following:

1. Does the repellent agent in your qualified product contain MC-8 or substances that degrade to it?
2. What toxicological studies has your company conducted or sponsored on the repellent agent since 1998, and will you provide them to DQA-T?
3. Has your company given any substantial-risk notice, to a customer or a regulator, with respect to the repellent agent?
4. What is your company's plan for continued supply of a DTS-24385F-qualified product if MC-8-based surfactants become unavailable?

Your qualification package of 15 June 2001 described the repellent agent as "low toxicity" and stated that the product "presents no unusual environmental hazard when used as directed." Please confirm that these statements remain accurate.

Responses are requested within 30 days.

Respectfully,
Col. D. R. Wadhwa
DQA-T — Technical Textiles Cell`,
  },
  {
    id: "ed_vls_0069",
    date: "2002-10-07",
    time: "14:50",
    custodian: "prasad",
    type: "Email",
    subject: "RE: DTS-24385F qualification — questions on environmental and toxicological profile of Aqua-Guard 3",
    to: ["Col. Devendra Wadhwa"],
    cc: ["Nandini Bose", "Manish Sood"],
    threadId: T_MIL,
    aiScore: 93,
    aiIssues: ["GOV-01", "MKT-01", "REG-01"],
    coding: { responsive: true, privileged: false, hot: true, confidentiality: "confidential", issues: ["GOV-01", "MKT-01", "REG-01"], reviewerId: R.mehra, reviewedAt: "2026-09-12T11:15:00Z", notes: "Specification-compliance defence — knowledge prong. Prasad's answer to Q2 omits the 12-month interim received 9/12/2002 and describes the Clause 9.4 notice as 'may make.' Key document for both sides." },
    tags: ["key-doc", "exhibit-candidate"],
    body: `Col. Wadhwa,

Thank you for your message. Meridian's responses:

1. Yes. The repellent agent in Aqua-Guard 3% and 6% is a MC-8 salt (MF-3).

2. Meridian sponsored a 90-day oral toxicity study in rats (2000–2001), which identified the liver as the target organ with a no-observed-adverse-effect level of 0.1 mg/kg/day, and has a two-year study in progress. Meridian provided a summary of the 90-day study to CPCB in June 2001 and will provide a copy to DQA-T under our standard confidentiality terms.

3. Meridian has not given a substantial-risk notice to date. Meridian keeps its reporting obligations under continuous review and may make a submission in connection with data from the two-year study.

4. Meridian has an active development program for a shorter-chain repellent agent and expects to have a candidate formulation available for DTS qualification testing in 2004. Meridian will maintain supply of Aqua-Guard 3% and 6% for the term of the current defence rate contract.

With respect to the qualification package: the statements referred to were accurate when made on the basis of the data then available. Meridian's product literature and MSDS were revised in August 2001 to reflect the 90-day study; the current MSDS (rev. G) is attached. Meridian recommends that finishing bath not be discharged to the environment and that rinse-water discharge be contained.

We would welcome the opportunity to brief DQA-T in person.

Respectfully,
Anil Prasad
Vice President, Textile Chemicals`,
  },

  // ------------------------------------------------------------------
  // 2003–2012: stewardship, CPCB request, later results, litigation hold
  // ------------------------------------------------------------------
  {
    id: "ed_vls_0070",
    pages: 3,
    date: "2003-02-11",
    custodian: "bose",
    type: "Memo",
    subject: "Product stewardship review — MC-8 chemistry alternatives and Aqua-Guard reformulation options",
    from: "Nandini Bose",
    to: ["Anil Prasad", "Pankaj Malhotra"],
    cc: ["Hema Vasudevan"],
    aiScore: 76,
    aiIssues: ["PRD-01"],
    coding: { responsive: true, privileged: false, issues: ["PRD-01"], reviewerId: R.lopez, reviewedAt: "2026-09-12T11:30:00Z" },
    body: `MERIDIAN FINE CHEMICALS — PRODUCT STEWARDSHIP
MEMORANDUM
To: A. Prasad; P. Malhotra — Cc: H. Vasudevan
From: N. Bose
Date: 11 February 2003
Re: MC-8 chemistry alternatives — status of the MF-5 program and reformulation options

1. Context. CPCB notified the organohalogen inventory in December 2002 with separate treatment for defence finishing. Meridian gave the Park a Clause 9.4 notice on 10 October 2002 (ref. MFC/CL94/2002-01). DQA-T has asked all approved suppliers for transition plans. Three of our top-ten industrial accounts have asked for a "MC-8-free" timeline. The MF-5 program approved by the Board in June 2001 is 20 months in.

2. MF-5 program status. Two short-chain candidates (MF-6A, MF-6B) have passed the bench repellency screen. MF-6A meets the DTS-24385F spray-rating and hydrostatic-head requirements at 3%; MF-6B fails the wash-durability test. Neither has been tested for toxicity or kinetics beyond an acute oral screen. Following Hema's insistence, the first repeated-dose study of MF-6A will include serum kinetics (protocol in preparation, Sundaram, Q2 2003).

\f3. Reformulation options.
 (a) Full transition to MF-6A: 24–30 months to approved-list entry, assuming no toxicology surprises. Cost to complete: ₹34 crore (over the ₹21 crore approved).
 (b) Interim "reduced-MC-8" blend (MF-3 at 60% of current loading plus hydrocarbon surfactant boost): passes 3% DTS at bench; would allow marketing of "reduced repellent agent content" in 2003. Does not solve the persistence problem; Product Safety objects to marketing it as an environmental improvement.
 (c) Continue MF-3 and communicate transition timeline only.

4. Stewardship recommendation. (a), with a clear customer communication now that Meridian is transitioning and a target date. Do not pursue (b) as a marketing claim. Note: the MF-6 candidates can degrade to a short-chain acid (MC-6A); CPCB has begun asking questions about short-chain chemistry as well. We should not describe MF-6A as "non-persistent" without data.

\f5. Customer communication. Draft letter to customers of record attached for review, stating: MC-8 content; transition program; recommended handling and disposal. Law Department review requested.

N. Bose`,
  },
  {
    id: "ed_vls_0071",
    pages: 4,
    date: "2003-05-20",
    custodian: "sood",
    type: "Memo",
    subject: "Regulatory affairs memo — CPCB information request (voluntary) on MC-8/MC-7 — response plan",
    from: "Manish Sood",
    to: ["Anil Prasad", "Pankaj Malhotra", "Girish Hegde", "Hema Vasudevan"],
    cc: ["Rohit Kapur"],
    aiScore: 84,
    aiIssues: ["REG-02", "REG-01"],
    coding: { responsive: true, privileged: false, issues: ["REG-02", "REG-01"], reviewerId: R.marsh, reviewedAt: "2026-09-12T11:45:00Z", notes: "Regulatory status memo; produce. Kapur cc only." },
    body: `MERIDIAN FINE CHEMICALS — REGULATORY AFFAIRS
MEMORANDUM
To: A. Prasad; P. Malhotra; G. Hegde; H. Vasudevan — Cc: R. Kapur
From: M. Sood
Date: 20 May 2003
Re: CPCB information requests on persistent organohalogens — status and response plan

1. Requests received.
 (a) CPCB letter of 28 April 2003 (M. Phadke) requesting, on a voluntary basis, copies of all unpublished health and safety studies on MC-8, MC-7 and related compounds in Meridian's possession, and any environmental monitoring data.
 (b) CPCB follow-up of 12 May asking for the 18-month serum data from SL-2001-0512 "when available."
 (c) GPCB letter of 30 April requesting the complete Valsara groundwater monitoring record since 1997 and Beacon's closure plan for Lagoon 2.

\f2. What CPCB already has. June 2001 voluntary submission (1993 study; acute package; Sundaram 90-day summary). October 2002 Clause 9.4 notice to the Park, copied to GPCB under Schedule 6 (ref. MFC/CL94/2002-01): 12-month interim summary, serum data from both studies, MW-7/MW-8 results through June 2002. CPCB obtained the notice through GPCB, acknowledged it on 4 November 2002 and requested the full 90-day report, which was provided 22 November.

3. Response plan.
 (a) CPCB request: provide the full 90-day report (already provided), the 12-month interim (full report, not only summary), the 18-month serum data when received (August 2003), the Krishnan medical surveillance analysis (de-identified), and all Beacon groundwater reports. Withhold: internal legal memoranda; drafts; the March 2001 Law Department analysis. Log any withheld items.
 (b) GPCB: provide the monitoring record and the closure plan (Beacon, 30 Sept 2002, closure under way). Note the Park wellfield sampling (Nov 2002, Jan 2003, Apr 2003: all non-detect at 0.05 µg/L).
 (c) Coordinate the response through the Textile Auxiliaries Manufacturers' Forum where the request overlaps industry-wide issues; Meridian's data are Meridian's to produce.

\f4. Risks. The Park's technical committee has already asked, in correspondence, about the timing of the Clause 9.4 notice relative to receipt of the underlying studies. The interval between Meridian's receipt of the 90-day report (March 2001) and its Clause 9.4 notice (October 2002) will be visible from the documents produced. The Law Department's position is that the March 2001 analysis was made in good faith on advice of counsel and that the June 2001 voluntary submission put the study before CPCB in any event. Management should be aware that a claim for liquidated damages under Clause 9.6 is possible.

5. Actions. Sood: CPCB response by 30 May; GPCB by 6 June. Vasudevan: assemble study reports. Hegde: assemble monitoring record. Kapur: privilege review of the production.

\fAttachment: index of documents to be produced (draft).

M. Sood`,
  },
  {
    id: "ed_vls_0072",
    date: "2004-01-14",
    time: "11:12",
    custodian: "hegde",
    type: "Email",
    subject: "Valsara groundwater — 2003 annual results (MW-7, MW-8, MW-9, MW-10) and Lagoon 2 closure status",
    to: ["Pankaj Malhotra", "Manish Sood"],
    cc: ["Anil Prasad"],
    aiScore: 78,
    aiIssues: ["ENV-01"],
    coding: { responsive: null, privileged: null, issues: [] },
    body: `Pankaj, Manish —

2003 annual summary from Beacon:

- MW-7: 33 µg/L (Dec 2003), down from a peak of 44 in Sept 2002. Source removal (Lagoon 2 unlined section excavated and closed Aug 2003, 6,200 tonnes to a GPCB-authorised secured landfill) appears to be working.
- MW-8 (property line): 9.4 µg/L, still rising slowly.
- MW-9 and MW-10 (off-site, Kesar easement, installed Feb 2003): 3.1 and 0.8 µg/L.
- Kesar domestic well (deep, 34 m): non-detect.
- Park Wells 9–12: non-detect at 0.05 µg/L in all five rounds.

GPCB accepted the closure report in December. They have asked for quarterly monitoring to continue for five years and for a contingency plan if MW-10 exceeds 5 µg/L. I have told Beacon to draft one.

The plume is what it is; it will be in the shallow aquifer for decades. But it is not reaching the Park's wells, and we can say that with data.

Girish`,
  },
  {
    id: "ed_vls_0073",
    date: "2005-03-02",
    time: "09:40",
    custodian: "vasudevan",
    type: "Email",
    subject: "Two-year bioassay — final report received — summary of findings",
    to: ["Manish Sood", "Girish Hegde", "Nandini Bose", "Rohit Kapur"],
    cc: ["Anil Prasad"],
    attachmentIds: ["ed_vls_0074"],
    aiScore: 90,
    aiIssues: ["TOX-02", "REG-01"],
    coding: { responsive: true, privileged: false, hot: true, issues: ["TOX-02", "REG-01"], reviewerId: R.marsh, reviewedAt: "2026-09-12T12:10:00Z" },
    body: `All —

Final report on SL-2001-0512 received. Summary attached. Headlines:

- Hepatocellular adenomas: males 2/50, 3/50, 6/50, 14/50 (p<0.01 at 1.5 mg/kg-day; positive trend). Females 1/50, 1/50, 4/50, 9/50 (p<0.05 at high dose).
- Hepatocellular carcinomas: males 0, 0, 1, 3. Not significant individually; combined adenoma/carcinoma significant.
- Thyroid follicular adenomas: males 1/50, 0/50, 2/50, 5/50 (marginal).
- NOAEL: 0.03 mg/kg-day. Serum at that dose after 24 months: 4.1 µg/mL.

This is a positive rodent carcinogenicity study. Sundaram's report says so plainly. Manish — the Clause 9.4 supplement is due 30 days from today; I assume you will want to file the summary. Nandini — the customer letter needs to be updated; "no chronic data" is no longer true and we should not wait for a customer to ask.

Hema`,
  },
  {
    id: "ed_vls_0074",
    pages: 3,
    date: "2005-02-28",
    custodian: "vasudevan",
    type: "Report",
    subject: "Sundaram SL-2001-0512 — two-year chronic bioassay of MF-3 in rats — final report summary",
    from: "Dr. Leela Sundaram",
    parentId: "ed_vls_0073",
    aiScore: 94,
    aiIssues: ["TOX-02", "TOX-01"],
    coding: { responsive: true, privileged: false, hot: true, confidentiality: "highly confidential", issues: ["TOX-02"], reviewerId: R.mehra, reviewedAt: "2026-09-12T12:20:00Z" },
    tags: ["exhibit-candidate"],
    body: `SUNDARAM LABORATORIES PVT. LTD. — FINAL REPORT SUMMARY — Study SL-2001-0512
A Two-Year Dietary Chronic Toxicity and Carcinogenicity Study of MF-3 Repellent Finish Concentrate in Sprague-Dawley Rats
Report date: 28 February 2005 — Study Director: L. Sundaram — Pathologist: Y. Bilgrami — Peer review pathologist: R. Ramaswamy (independent)

1. SURVIVAL (104 weeks). Males: 52%, 54%, 50%, 44%. Females: 58%, 60%, 56%, 50%. No treatment-related effect on survival.

2. SERUM MC-8 (µg/mL, 24 months): 0.03 group 4.1; 0.3 group 39.6; 1.5 group 131.8. Steady state was approached between 18 and 24 months at the low and mid dose.

\f3. NEOPLASTIC FINDINGS (incidence in 50/sex/group)
LIVER
  Hepatocellular adenoma: M 2, 3, 6, 14**; F 1, 1, 4, 9*
  Hepatocellular carcinoma: M 0, 0, 1, 3; F 0, 0, 0, 1
  Adenoma or carcinoma combined: M 2, 3, 7, 16**; F 1, 1, 4, 10*
THYROID
  Follicular cell adenoma: M 1, 0, 2, 5; F 0, 1, 1, 3
  Follicular cell carcinoma: M 0, 0, 0, 1
PANCREAS
  Acinar cell adenoma: M 0, 1, 1, 4
* p<0.05 ** p<0.01 (Fisher exact vs. concurrent control); trend tests (Cochran-Armitage) significant (p<0.01) for liver adenoma and combined liver tumours in both sexes.
Historical control (Sundaram, 24-month SD males, 1995–2004, 12 studies): hepatocellular adenoma 0–8%, mean 3.2%.

4. NON-NEOPLASTIC FINDINGS. Hepatocellular hypertrophy, eosinophilic and basophilic foci, and vacuolation at 0.3 and 1.5 mg/kg-day; thyroid follicular hypertrophy at 1.5; pancreatic acinar hyperplasia at 1.5.

\f5. CONCLUSIONS. Under the conditions of this study, MF-3 was carcinogenic to the liver of male and female Sprague-Dawley rats at 1.5 mg/kg-day and produced an increased incidence of hepatocellular adenomas in males at 0.3 mg/kg-day. Thyroid and pancreatic tumour findings are equivocal. The NOAEL for non-neoplastic effects is 0.03 mg/kg-day. Serum concentrations indicate substantial bioaccumulation with an elimination half-life in the rat of approximately 100 days. The mode of action for the liver tumours is likely to involve PPARα activation, but the sponsor has not commissioned mechanistic studies and the relevance of the findings to humans cannot be dismissed on the present data.

L. Sundaram, Ph.D., DABT`,
  },
  {
    id: "ed_vls_0075",
    date: "2006-06-19",
    time: "16:00",
    custodian: "prasad",
    type: "Email",
    subject: "Product line — Aqua-Guard MF-5 transition timeline and MC-8 inventory run-out",
    to: ["Pankaj Malhotra", "Nandini Bose", "Kavita Lal"],
    cc: ["Manish Sood"],
    aiScore: 74,
    aiIssues: ["PRD-01", "MKT-01"],
    coding: { responsive: null, privileged: null, issues: [] },
    body: `All —

Decisions from the product review:

1. Aqua-Guard MF-5 (MF-6A) passed DTS qualification testing at the DQA-T laboratory in April. Approved-list entry expected Q4 2006. We will launch to cluster and industrial accounts in Q1 2007.
2. MF-3 production at Valsara ends 31 December 2006. Remaining inventory (approx. 1.4 million litres concentrate equivalent) will be sold through 2008 to existing contract customers only. No new MF-3 accounts from today.
3. Customer letter (Nandini's draft of 2 June) approved with Manish's edits. It goes to all customers of record by 15 July. It will say what MF-3 is, that we are replacing it, and what to do with existing stock. It will not say "safe."
4. Kavita — the MF-5 launch literature says "MC-8-free." It does not say "organohalogen-free," "non-persistent," or "environmentally friendly." Nandini signs off on every page.

The MF-5 transition cost us five years and about ₹60 crore. It was the right call in 2001 and it is the right call now.

Anil`,
  },
  {
    id: "ed_vls_0076",
    date: "2008-09-30",
    time: "10:25",
    custodian: "sood",
    type: "Email",
    subject: "CPCB voluntary MC-7 phase-down programme (2010/2015 targets) — Meridian participation and MF-5 data",
    to: ["Anil Prasad", "Nandini Bose", "Hema Vasudevan"],
    cc: ["Rohit Kapur"],
    aiScore: 66,
    aiIssues: ["REG-02", "PRD-01"],
    coding: { responsive: null, privileged: null, issues: [] },
    body: `All —

CPCB has invited Meridian to join its voluntary MC-7 phase-down programme (2010/2015 targets) as a short-chain finish producer, following our MF-6A launch. Participation means annual reporting of MC-7 and long-chain precursor content in our products and a commitment to a 95% reduction by 2010 and elimination by 2015. MF-6A is an MF-5 chemistry and our analytical work (Hema, May 2008) shows MC-7 and MC-8 precursor content below 50 ppm, so we are effectively already compliant.

I recommend we join. It is the clearest signal we can send to customers and to CPCB that the company has moved on from MC-8 chemistry. Rohit agrees.

One caution from Hema that I want on the record: the 90-day study of MF-6A (Sundaram, 2004) showed serum MC-6A at steady state within 30 days and rapid elimination — very different from MF-3 — but the short-chain alcohols in the raw material do degrade to MC-6A in the environment. "MC-8-free" is true. "Non-persistent" is not something we can say about the degradation products.

Manish`,
  },
  {
    id: "ed_vls_0077",
    date: "2010-02-16",
    time: "09:10",
    custodian: "bose",
    type: "Email",
    subject: "Customer letter — MC-8 content disclosure and disposal of legacy Aqua-Guard 3/6 stock",
    to: ["Kavita Lal", "Anil Prasad"],
    cc: ["Manish Sood", "Girish Hegde"],
    attachmentIds: ["ed_vls_0078"],
    aiScore: 72,
    aiIssues: ["CUS-01", "PRD-01"],
    coding: { responsive: true, privileged: false, issues: ["CUS-01", "PRD-01"], reviewerId: R.lopez, reviewedAt: "2026-09-12T12:40:00Z" },
    body: `Kavita, Anil —

Final version of the legacy-stock customer letter attached (Manish has reviewed). It goes to every account that purchased Aqua-Guard 3 or 6 between 1994 and 2008 — 812 addresses — plus the State Pollution Control Boards in the 14 states where we have cluster accounts.

Three customers (Sarangpur, Saurashtra Fabrics, Konkan Weaves) have already asked us to take back stock. I have approved take-back at our cost for cluster accounts under 500 litres; incineration at a GPCB-authorised common hazardous-waste incinerator. Industrial accounts pay their own disposal.

Nandini`,
  },
  {
    id: "ed_vls_0078",
    pages: 2,
    date: "2010-02-16",
    custodian: "bose",
    type: "Letter",
    subject: "Letter to Aqua-Guard customers of record — product composition, MC-8 content and disposal of legacy finish stock",
    from: "Nandini Bose",
    parentId: "ed_vls_0077",
    aiScore: 75,
    aiIssues: ["CUS-01", "PRD-01"],
    coding: { responsive: true, privileged: false, issues: ["CUS-01"], reviewerId: R.lopez, reviewedAt: "2026-09-12T12:42:00Z" },
    body: `MERIDIAN FINE CHEMICALS LTD.
Plot 18, Industrial Estate Road, Valsara, Gujarat 394120

February 16, 2010

To: Customers of record for Aqua-Guard 3% and Aqua-Guard 6% Finish concentrates (1994–2008)

Re: Product composition, MC-8 content and recommended handling of legacy stock

Dear Customer:

Meridian Fine Chemicals manufactured Aqua-Guard 3% and 6% water-repellent textile finish concentrates from 1989 through December 2006 using a repellent agent based on MC-8 (MC-8). Meridian ceased production of MC-8-based concentrates at the end of 2006 and sold remaining inventory through 2008. Since 2007 Meridian's repellent finishes (Aqua-Guard MF-5 series) have been manufactured with a short-chain repellent agent and do not contain MC-8.

MC-8 is persistent in the environment, accumulates in humans and animals, and has been shown to cause liver effects and liver tumours in laboratory rats in studies sponsored by Meridian and others. In 2009 the Central Pollution Control Board added MC-8 to its list of persistent organohalogens of concern and issued provisional guidance values for MC-8 and MC-7 in drinking water (0.3 and 0.5 micrograms per litre respectively).

\fMeridian recommends the following with respect to any Aqua-Guard 3% or 6% concentrate still in your inventory:
1. Do not use MC-8-based concentrate for new production, trials or demonstration. Return or replace it.
2. Do not discharge finishing bath to the environment. Contain and collect all discharges for disposal by high-temperature incineration through a licensed hazardous waste contractor.
3. Cluster textile processors holding fewer than 500 litres may return concentrate to Meridian for disposal at Meridian's expense. Contact Product Stewardship at +91 2646 50 0160.
4. Facilities where MC-8-based finish has been used repeatedly (processing units, effluent pits) may wish to evaluate soil and groundwater. Meridian can provide a list of laboratories capable of MC-8 analysis.

Meridian regrets any inconvenience and remains committed to supporting its customers through this transition.

Sincerely,

Nandini Bose
Director, Product Stewardship`,
  },
  {
    id: "ed_vls_0079",
    date: "2011-08-23",
    time: "14:15",
    custodian: "hegde",
    type: "Email",
    subject: "Valsara — MW-7, MW-8, MW-10 2011 sampling; GPCB five-year monitoring term ends; Kesar easement renewal",
    to: ["Manish Sood", "Pankaj Malhotra"],
    aiScore: 62,
    aiIssues: ["ENV-01"],
    coding: { responsive: null, privileged: null, issues: [] },
    body: `Manish, Pankaj —

2011 mid-year: MW-7 at 18 µg/L (down from 44 peak); MW-8 at 7.2; MW-10 (off-site) at 2.6 and roughly flat since 2008. Park wells still non-detect (now at 0.01 µg/L reporting limit with the new method). Beacon's model has the plume stable — source removed, slow dilution, no further off-site advance.

GPCB's five-year term ends December 2011. I propose we ask to continue semi-annual monitoring voluntarily rather than have them impose it, and renew the Kesar easement for another five years. With CPCB's MC-8 guidance value now at 0.3 µg/L and the Sarvani River discussion starting up, I would rather have current data than not.

Girish`,
  },
  {
    id: "ed_vls_0080",
    date: "2012-04-11",
    time: "17:05",
    custodian: "kapur",
    type: "Email",
    subject: "LITIGATION HOLD — Valsara / MC-8 claims (privileged)",
    to: ["Anil Prasad", "Girish Hegde", "Hema Vasudevan", "Nandini Bose", "Manish Sood", "Pankaj Malhotra", "Farhan Qureshi"],
    aiScore: 58,
    aiIssues: ["LEG-01"],
    coding: { responsive: true, privileged: true, privilegeBasis: "attorney-client", confidentiality: "AEO", issues: ["LEG-01"], reviewerId: R.marsh, reviewedAt: "2026-09-12T13:00:00Z", notes: "Litigation hold notice. Privileged; log. Existence of hold not privileged." },
    body: `PRIVILEGED & CONFIDENTIAL — ATTORNEY-CLIENT COMMUNICATION

To all recipients:

Meridian Fine Chemicals has received notice of claims, and reasonably anticipates litigation, relating to the manufacture, sale and environmental release of MC-8-based water-repellent textile finish products and the MF-3 repellent agent. This notice requires you to preserve all documents and electronically stored information in your possession, custody or control that relate in any way to:

- MF-3 repellent agent and Aqua-Guard 3%, 6% and AR concentrates (1989–2008): formulation, manufacture, testing, marketing, sales, regulatory submissions and customer communications;
- Toxicology, epidemiology and medical surveillance relating to MC-8, MC-7 or other persistent organohalogens, including all Sundaram Laboratories studies;
- Environmental monitoring, releases and remediation at the Valsara facility, including Lagoon 2 and the monitoring well network;
- Communications with CPCB, GPCB, DQA-T, customers and trade associations regarding the foregoing.

"Documents" includes email, instant messages, calendar entries, voicemail, drafts, notebooks, spreadsheets and data on any device or account, including personal accounts used for company business. Do not delete, alter or discard any such material. Routine deletion under the email retention schedule is suspended for your mailboxes effective today. IT has been instructed to preserve backup media and to export instant-message logs.

Direct any questions to me. Do not discuss the substance of the anticipated claims with anyone outside the Law Department. Please acknowledge receipt by reply.

Rohit Kapur
Associate General Counsel`,
  },
  {
    id: "ed_vls_0081",
    pages: 3,
    date: "2012-11-29",
    custodian: "sood",
    type: "Memo",
    subject: "Privileged & Confidential — Retrospective review of the March 2001 Clause 9.4 decision (prepared at the request of counsel)",
    from: "Manish Sood",
    to: ["Rohit Kapur"],
    aiScore: 93,
    aiIssues: ["REG-01", "LEG-01"],
    coding: { responsive: true, privileged: true, privilegeBasis: "work-product", hot: true, confidentiality: "AEO", issues: ["REG-01", "LEG-01"], reviewerId: R.mehra, reviewedAt: "2026-09-12T13:20:00Z", notes: "Work product prepared in anticipation of litigation (post-hold). Withhold in full. Partner review: crime-fraud exposure is on the 2001 memo, not this one, but this memo characterises it." },
    tags: ["privilege-review"],
    body: `PRIVILEGED AND CONFIDENTIAL — ATTORNEY WORK PRODUCT — PREPARED IN ANTICIPATION OF LITIGATION AT THE REQUEST OF R. KAPUR

MEMORANDUM
To: R. Kapur — From: M. Sood — Date: 29 November 2012
Re: Retrospective review of the March 2001 decision not to give a Clause 9.4 notice on Sundaram Study SL-2000-0417

1. Purpose. You asked (September 2002, renewed April 2012) for an assessment of whether the March 2001 analysis was sound on the information available at the time and whether it should have been revisited earlier than October 2002. This memorandum is for use by counsel in evaluating the company's position in the anticipated Valsara claims.

2. Information available in March 2001. The 90-day study (liver NOAEL 0.1 mg/kg-day; serum half-life ~100 days in rat); the 1993 Kaveri Bio-Research study; the 1997 AOX groundwater screen; published literature on MC-8/MC-7 persistence in human serum (Orbis workers); Dr. Sundaram's transmittal letter recommending consideration of reporting; the Schedule 6 Notification Protocol; and the fact of Orbis's May 2000 announcement and its public disclosures.

\f3. Assessment of the March 2001 analysis. The analysis correctly identified the hepatic findings as corroborative. The treatment of the bioaccumulation finding as "preliminary" was a defensible reading of Schedule 6 but was, in my view, at the aggressive end of the range, for two reasons I did not give sufficient weight: (a) the publicly available Orbis data on MC-8 in human serum made it unreasonable to treat rat persistence as an isolated observation; and (b) Schedule 6's "pronounced bioaccumulation" language was directed at exactly this combination — a persistent substance with target-organ toxicity — and did not require that the toxicity be severe.

4. Events between March 2001 and October 2002 that should have prompted an earlier revisit. (a) June 2001: Krishnan's finding of 9% lower cholesterol in the blending crew — a human finding on the endpoint identified in the rat. (b) September 2001: the MW-7 detection at 12 µg/L — evidence of environmental release and persistence. (c) February 2002: the 3-month serum data confirming continued accumulation. In my judgment the combination of (a) and (b), available by November 2001, met the standard. The revisit occurred eleven months later.

\f5. Mitigating considerations. The June 2001 voluntary submission of the 90-day summary to CPCB placed the core study before a regulator fifteen months before the Clause 9.4 notice, although not before the Park. The company commissioned and conducted the chronic study and the groundwater investigation without delay. The Clause 9.4 notice was given within 30 days of the interim report. The Park has not yet made a claim under Clause 9.6, and the 2003 response to CPCB was complete.

6. Documents of concern. The Prasad email of 19 March 2001 (commercial consequences); the Prasad email of 11 April 2001 (reducing the bioassay design); the Hegde memorandum of 19 March 2001 ("no adverse findings") as compared with its draft; the Prasad email of 9 July 2002 ("do not put this in email"); the Prasad response to DQA-T of 7 October 2002 (omitting the interim report received 12 September). None of these is privileged. Counsel should assume each will be produced.

7. Recommendation. The company's position should be that the 2001 decision was made in good faith on advice of counsel, was accompanied by an active investigation, and was corrected when the investigation produced results. I would not recommend asserting that the 2001 decision was correct.

M. Sood`,
  },

  // ------------------------------------------------------------------
  // MFC-0043105 / 0043211 — 2017 documents relied on by the chronology workflow
  // ------------------------------------------------------------------
  {
    id: "ed_vls_43105",
    batesAt: 43105,
    date: "2017-10-11",
    time: "08:55",
    custodian: "hegde",
    type: "Email",
    subject: "Q3 EHS report — distribution",
    to: ["Anil Prasad", "Nandini Bose"],
    cc: ["Hema Vasudevan"],
    aiScore: 71,
    aiIssues: ["ENV-01"],
    coding: { responsive: null, privileged: null, issues: [] },
    body: `Anil, Nandini —

Attaching the Q3 2017 EHS report. Note the groundwater monitoring section references the July and August interim reports on the MW-7 resampling; those went to Pankaj and Manish separately in August. MW-7 came back at 9.8 µg/L in the July round and 11.2 in August — the first increase since 2004. Beacon attributes it to the wet spring raising the water table into the residual source zone under the old Lagoon 2 footprint. They are recommending a fourth quarterly round and a review of the 2003 closure cap.

With CPCB's 2016 revised guidance value now at 0.1 µg/L for MC-8 and MC-7 combined, "no standard" is no longer an answer we can give the Park. I have asked Beacon to resample Wells 9–12 with the low-level method.

Girish`,
  },
  {
    id: "ed_vls_43211",
    batesAt: 43211,
    pages: 5,
    date: "2017-11-02",
    custodian: "vasudevan",
    type: "Memo",
    subject: "Benchmark-dose analysis — hepatic endpoints (draft 2)",
    from: "Hema Vasudevan",
    to: ["Manish Sood", "Rohit Kapur"],
    aiScore: 82,
    aiIssues: ["TOX-01", "TOX-02"],
    coding: { responsive: true, privileged: null, issues: ["TOX-01", "TOX-02"], notes: "Prepared at counsel's request (see header) — but is it a scientific analysis or legal work product? Draft 2. Hold for privilege review; likely produce with the header redacted if not at direction of counsel." },
    body: `MERIDIAN FINE CHEMICALS — PRODUCT SAFETY
DRAFT 2 — 2 November 2017 — Prepared at the request of the Law Department in connection with CPCB's 2016 revised guidance value and anticipated litigation
Benchmark-dose analysis of hepatic endpoints in Sundaram Studies SL-2000-0417 (90-day) and SL-2001-0512 (two-year)
H. Vasudevan

1. Purpose. To derive benchmark doses (BMD) and lower confidence limits (BMDL) for hepatic endpoints from Meridian's rat studies of MF-3, using BMDS 2.7 software, and to compare with the points of departure used by CPCB in its 2016 technical basis document for MC-8.

2. Data. This draft updates the BMD analysis using the 2001 90-day hepatic data and the two-year study interim (12-month) and terminal (24-month) data, and incorporates the Q3 2017 serum-to-dose relationships for internal-dose modelling.

\f3. Endpoints and models. Dichotomous: hepatocellular hypertrophy (incidence); hepatocellular adenoma (incidence, 24 months). Continuous: relative liver weight; serum total cholesterol. Models: log-logistic, Weibull, multistage (dichotomous); Hill, exponential (continuous). BMR: 10% extra risk (dichotomous); 1 SD (continuous).

4. Results (external dose, mg/kg-day)
   Endpoint                             Study      BMD10/1SD   BMDL10/1SD   Best model
   Hepatocellular hypertrophy (M)      90-day       0.68        0.39        Weibull
   Hepatocellular hypertrophy (M)      2-yr 12 mo   0.21        0.11        log-logistic
   Relative liver weight (M)           2-yr 24 mo   0.24        0.14        Hill
   Serum cholesterol (M)               2-yr 24 mo   0.12        0.07        exponential
   Hepatocellular adenoma (M)          2-yr 24 mo   0.46        0.27        multistage

\f5. Internal dose. Using the serum/dose ratio at steady state (approx. 30 µg/mL per mg/kg-day in the two-year study), the cholesterol BMDL of 0.07 mg/kg-day corresponds to a serum MC-8 concentration of approximately 2.1 µg/mL (2,100 ng/mL). CPCB's 2016 point of departure for MC-8 (from a rat developmental study by another sponsor) corresponds to a serum concentration of approximately 6.3 µg/mL; Meridian's own cholesterol endpoint is therefore roughly three-fold more sensitive than the endpoint CPCB used.

6. Comment. The 2001 NOAEL of 0.1 mg/kg-day was not unreasonable as a NOAEL. The two-year data, and BMD modelling that was available in 2001 in cruder form (see my March 2001 QA review, which reported a BMDL10 of 0.39 for hypertrophy), lower the point of departure by a factor of 3–5. The cholesterol endpoint, which was observed in the 90-day study and in the Valsara blending crew in 2001, is the most sensitive endpoint in either study.

\f7. Limitations. Draft. Model averaging not yet performed. Female data not yet modelled. Cholesterol endpoint modelled as continuous with 1 SD BMR; CPCB may prefer a different BMR.

Appendix A: BMDS output files (attached electronically). Appendix B: Q3 2017 serum data summary.`,
  },

  // ------------------------------------------------------------------
  // MFC-0043877 … 0043951 — Kapur 2016 privileged series (privilege-log workflow)
  // ------------------------------------------------------------------
  {
    id: "ed_vls_kaine_0001",
    batesAt: 43877,
    date: "2016-08-19",
    time: "11:20",
    custodian: "kapur",
    type: "Email",
    subject: "RE: Clause 9.4 — recommendation for the Tuesday call",
    to: ["Manish Sood"],
    threadId: T_8E_2016,
    aiScore: 88,
    aiIssues: ["REG-01", "LEG-01"],
    coding: { responsive: true, privileged: true, privilegeBasis: "attorney-client", confidentiality: "AEO", issues: ["REG-01", "LEG-01"], reviewerId: R.marsh, reviewedAt: "2026-09-13T10:00:00Z" },
    body: `PRIVILEGED & CONFIDENTIAL — ATTORNEY-CLIENT COMMUNICATION

Manish — per our discussion, my recommendation on the substantial-risk question is set out below. Please treat this as privileged and do not forward to the product team.

The question is whether the MW-7 increase reported in July and August, read with CPCB's May 2016 revised guidance value of 0.1 µg/L, is new information reasonably supporting a substantial-risk conclusion that requires a supplemental Clause 9.4 notice. My view is no: the plume, its source and its persistence were all reported to the Park in 2002 and to CPCB in 2003; the guidance value is CPCB's own information, not ours; and the concentrations are within the range already reported. What has changed is the standard, not the facts.

That said, I want the Park wells resampled before Tuesday and I want a voluntary update letter to the Park and GPCB ready to go if anything is detected. Being right on the legal question is not much use if the Park finds it first.

Rohit`,
  },
  {
    id: "ed_vls_kaine_0002",
    batesAt: 43881,
    date: "2016-08-22",
    time: "09:47",
    custodian: "kapur",
    type: "Email",
    subject: "FW: Vasudevan August summary — legal review",
    from: "Manish Sood",
    to: ["Rohit Kapur"],
    cc: ["Girish Hegde"],
    threadId: T_8E_2016,
    aiScore: 84,
    aiIssues: ["REG-01", "LEG-01", "TOX-01"],
    coding: { responsive: true, privileged: true, privilegeBasis: "attorney-client", confidentiality: "AEO", issues: ["REG-01", "LEG-01"], reviewerId: R.marsh, reviewedAt: "2026-09-13T10:05:00Z" },
    body: `PRIVILEGED & CONFIDENTIAL — ATTORNEY-CLIENT COMMUNICATION

Rohit, attaching Hema's summary. I need your read on whether the hepatic findings change the analysis we discussed. Her August summary re-analyses the 2005 two-year data against CPCB's 2016 technical basis document and concludes that our cholesterol endpoint is more sensitive than the endpoint CPCB used. That is an analysis of data CPCB has had since 2003, so I do not think it is "new information" for Clause 9.4 purposes, but it is the kind of analysis that the Claimant will say we should have done in 2001.

Girish is copied because he has the MW-7 data and because I want one thread, not three.

Manish

-----Original Message-----
From: Hema Vasudevan
Sent: Friday, August 19, 2016 4:12 PM
To: Manish Sood
Subject: August summary — hepatic endpoints vs CPCB 2016 basis document

Manish — summary attached as requested. Short version: using CPCB's own methods on our own studies, the point of departure is about three times lower than CPCB's. I have not modelled the female data. Draft; not for distribution.
Hema`,
  },
  {
    id: "ed_vls_kaine_0003",
    batesAt: 43902,
    pages: 6,
    date: "2016-09-06",
    custodian: "kapur",
    type: "Memo",
    subject: "Privileged & Confidential — Clause 9.4 analysis (draft) — 2016 MW-7 results and Vasudevan hepatic re-analysis",
    from: "Rohit Kapur",
    to: ["Manish Sood"],
    aiScore: 90,
    aiIssues: ["REG-01", "LEG-01"],
    coding: { responsive: true, privileged: true, privilegeBasis: "work-product", confidentiality: "AEO", issues: ["REG-01", "LEG-01"], reviewerId: R.marsh, reviewedAt: "2026-09-13T10:15:00Z" },
    body: `DRAFT — ATTORNEY WORK PRODUCT — PRIVILEGED AND CONFIDENTIAL
MEMORANDUM — To: M. Sood — From: R. Kapur — Date: 6 September 2016
Re: Whether the information described in the August 2016 EHS memorandum triggers a supplemental Clause 9.4 notice obligation

This memorandum analyzes whether the information described in the August 2016 EHS memorandum (MW-7 resampling results of July and August 2016; Beacon's attribution to water-table rise into the residual source zone) and in Product Safety's August 2016 hepatic re-analysis triggers a notice obligation under Clause 9.4, as supplemented by Schedule 6 and the parties' 2006 Joint Technical Committee note on Clause 9.4.

I. SHORT ANSWER. No supplemental notice is required. [Analysis of the "previously reported" and "corroborative" exclusions; the 2002 Clause 9.4 notice (ref. MFC/CL94/2002-01) and the 2003 CPCB response placed the plume, the source, the serum kinetics and the two-year interim before the Park and the regulators; the 2005 supplement placed the final bioassay before the Park.]

\fII. THE MW-7 RESULTS. [Concentrations of 9.8 and 11.2 µg/L are below the 2002 peak of 44 µg/L reported to the Park. Beacon's attribution is a hydrogeological interpretation, not new toxicity or exposure information. The Park wellfield remains non-detect (August 2016 low-level round: <0.002 µg/L).]

III. THE HEPATIC RE-ANALYSIS. [Re-analysis of previously reported data using CPCB's own methods is not "information" within Clause 9.4; see 2006 Joint Technical Committee note, para. 4. However, the analysis should be retained and, if the company communicates with CPCB on the guidance value, should be provided voluntarily.]

\fIV. RISK ASSESSMENT. [The Claimant in the anticipated arbitration will characterise the 2001–2002 interval as the core "knowledge" period; a 2016 decision not to supplement is unlikely to add materially to that exposure but a 2016 decision to supplement would be characterised as an admission that the 2002 notice was incomplete. Recommend voluntary update letter (not a Clause 9.4 notice) to the Park and GPCB with the 2016 monitoring data.]

V. RECOMMENDATIONS. 1. No supplemental Clause 9.4. 2. Voluntary monitoring update to the Park and GPCB by 30 September. 3. Retain outside regulatory counsel to review this analysis (see separate memorandum). 4. Product team to be told the conclusion, not the analysis.

\f[Pages 5–6: authorities; chronology of prior submissions 2001–2005; draft voluntary update letter.]`,
  },
  {
    id: "ed_vls_kaine_0004",
    batesAt: 43918,
    date: "2016-09-09",
    time: "15:30",
    custodian: "kapur",
    type: "Email",
    subject: "RE: Privileged — outside counsel engagement",
    to: ["Manish Sood", "Anil Prasad"],
    aiScore: 70,
    aiIssues: ["LEG-01"],
    coding: { responsive: true, privileged: true, privilegeBasis: "attorney-client", confidentiality: "AEO", issues: ["LEG-01"], reviewerId: R.marsh, reviewedAt: "2026-09-13T10:20:00Z" },
    body: `PRIVILEGED & CONFIDENTIAL

Anil, we are retaining outside regulatory counsel (Ahuja & Bakshi — Tarun Ahuja's environmental group) to advise on the question Manish raised. Until then please route questions through Legal; I do not want the product or EHS teams generating their own analyses in email. Engagement letter is signed; first call is Wednesday.

Manish — please send Tarun the 2002 Clause 9.4 notice, the 2003 CPCB response, the 2005 supplement, Beacon's 2016 reports, and my draft memo, under a privileged transmittal.

Rohit`,
  },
  {
    id: "ed_vls_kaine_0005",
    batesAt: 43944,
    date: "2016-09-27",
    time: "12:05",
    custodian: "kapur",
    type: "Email",
    subject: "Outside counsel advice — Clause 9.4 (privileged)",
    to: ["Manish Sood"],
    aiScore: 86,
    aiIssues: ["REG-01", "LEG-01"],
    coding: { responsive: true, privileged: true, privilegeBasis: "attorney-client", confidentiality: "AEO", issues: ["REG-01", "LEG-01"], reviewerId: R.marsh, reviewedAt: "2026-09-13T10:25:00Z" },
    body: `PRIVILEGED & CONFIDENTIAL — ATTORNEY-CLIENT COMMUNICATION

Summary of the advice received this morning, for our internal deliberation only.

Tarun Ahuja concurs: no supplemental Clause 9.4 is required on the 2016 MW-7 results or the hepatic re-analysis. He recommends (1) the voluntary update letter, sent by the end of the month; (2) that the update letter attach Beacon's 2016 reports in full and Hema's re-analysis, so that there is no later argument that we selected what to send; (3) that the company begin a document collection now, since the arbitration is coming regardless.

He also said, and I want it recorded: "The 2001 decision is what the case will be about. Nothing you do in 2016 changes that; the only thing you can do is not add to it."

Decision memo to follow.

Rohit`,
  },
  {
    id: "ed_vls_kaine_0006",
    batesAt: 43951,
    date: "2016-10-03",
    time: "10:12",
    custodian: "kapur",
    type: "Email",
    subject: "RE: Decision memo — final",
    from: "Manish Sood",
    to: ["Rohit Kapur"],
    aiScore: 68,
    aiIssues: ["REG-01", "LEG-01"],
    coding: { responsive: true, privileged: true, privilegeBasis: "attorney-client", confidentiality: "AEO", issues: ["REG-01", "LEG-01"], reviewerId: R.marsh, reviewedAt: "2026-09-13T10:30:00Z" },
    body: `PRIVILEGED & CONFIDENTIAL

Rohit — final version attached reflecting your edits. I will brief Anil verbally per your guidance. The voluntary update letter went to the Park (Lata Fernandes's successor, Devika Rao) and to GPCB on 29 September with Beacon's reports and Hema's re-analysis attached. Acknowledgement from GPCB received this morning; nothing yet from the Park.

Document collection: Tanmay Bhatt's group at Mehra & Rao has sent the collection protocol. Custodians in the first tier are Hegde, Vasudevan, Bose, Prasad, you and me. IT starts imaging on the 10th.

Manish`,
  },
];
