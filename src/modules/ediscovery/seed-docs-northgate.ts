import type { DocSpec } from "./seed-helpers";
import { REVIEWERS } from "./seed-helpers";

/**
 * Northgate Logistics v. Apex Freight Systems — plaintiff-side document set.
 * Bates NGL-0000101 …: the master transportation services agreement, change
 * orders, cargo-loss reports from the Joliet cross-dock, and the indemnity
 * demand correspondence.
 */

export const NG_CUSTODIANS = {
  grant: { id: "c_ng_mgrant", name: "Melissa Grant" },
  salazar: { id: "c_ng_vsalazar", name: "Victor Salazar" },
  whitmore: { id: "c_ng_dwhitmore", name: "Dana Whitmore" },
} as const;

const R = REVIEWERS;
const T_CO3 = "thr_ng_co3";
const T_LOSS = "thr_ng_loss_0914";
const T_DEMAND = "thr_ng_demand";

export const NORTHGATE_DOCS: DocSpec[] = [
  {
    id: "ed_ng_0001",
    batesAt: 101,
    pages: 14,
    date: "2024-03-01",
    custodian: NG_CUSTODIANS.whitmore,
    type: "Contract",
    subject: "Master Transportation Services Agreement — Northgate Logistics, Inc. and Apex Freight Systems, LLC (executed)",
    aiScore: 96,
    aiIssues: ["K-01", "IND-01", "DMG-01"],
    aiSummary: "Executed MTSA dated March 1, 2024. Apex provides cross-dock and linehaul services from the Joliet facility. Key provisions: §6 (service levels; 99.2% on-time, loss/damage under 0.15% of shipment value), §9 (carrier liability; full actual value, no Carmack limitation), §11 (indemnification for third-party claims and 'losses arising from Apex's negligence'), §12 (mutual waiver of consequential damages 'except as provided in Section 11'), §14 (change orders in writing signed by both parties), §18 (Illinois law; N.D. Ill. forum).",
    entities: { people: ["Melissa Grant", "Kevin Brandau"], orgs: ["Northgate Logistics, Inc.", "Apex Freight Systems, LLC"], places: ["Joliet, Illinois"] },
    coding: { responsive: true, privileged: false, hot: true, confidentiality: "confidential", issues: ["K-01", "IND-01", "DMG-01"], reviewerId: R.marsh, reviewedAt: "2026-09-02T10:00:00Z", notes: "The contract. §11/§12 interplay is the MSJ issue." },
    tags: ["key-doc", "exhibit-candidate"],
    body: `MASTER TRANSPORTATION SERVICES AGREEMENT

This Master Transportation Services Agreement (the "Agreement") is entered into as of March 1, 2024 (the "Effective Date") by and between NORTHGATE LOGISTICS, INC., a Delaware corporation with its principal place of business at 4400 West 73rd Street, Bedford Park, Illinois 60638 ("Northgate"), and APEX FREIGHT SYSTEMS, LLC, an Illinois limited liability company with its principal place of business at 1901 Mound Road, Joliet, Illinois 60436 ("Apex").

RECITALS
A. Northgate is a third-party logistics provider that arranges the transportation and handling of freight for its customers.
B. Apex operates a cross-dock facility at Joliet, Illinois and provides linehaul motor carrier services.
C. Northgate wishes to engage Apex to provide cross-dock, handling and linehaul services for freight tendered by Northgate, and Apex wishes to provide such services, on the terms set forth herein.

1. DEFINITIONS. "Cargo" means all goods tendered by or on behalf of Northgate to Apex. "Facility" means Apex's cross-dock at 1901 Mound Road, Joliet, Illinois. "Loss" means any loss, damage, shortage, delay or destruction of Cargo. "Services" means the services described in Exhibit A and any Change Order. "Shipment Value" means the invoice value of the Cargo as declared by Northgate on the bill of lading.

\f2. TERM. Initial term of three (3) years from the Effective Date, renewing automatically for successive one-year terms unless either party gives ninety (90) days' written notice of non-renewal.

3. SERVICES. Apex shall provide the Services in accordance with Exhibit A (Statement of Work), Exhibit B (Rate Schedule) and Exhibit C (Operating Procedures), as amended from time to time by Change Order under Section 14.

4. RATES AND PAYMENT. Rates per Exhibit B. Invoices weekly; payment net 30. Disputed amounts to be identified in writing within 15 days of invoice.

5. APEX PERSONNEL. Apex shall staff the Facility with trained personnel sufficient to meet the Service Levels. Apex shall conduct background checks on all personnel with access to Cargo. Apex shall maintain a minimum of two (2) supervisors on each shift during which Northgate Cargo is handled.

\f6. SERVICE LEVELS. 6.1 On-time departure of linehaul: 99.2% measured monthly. 6.2 Loss and damage: aggregate Loss shall not exceed 0.15% of aggregate Shipment Value in any calendar quarter. 6.3 Dock-to-stock scan compliance: 99.8%. 6.4 Remedies: service credits per Exhibit B, Section 4; two consecutive quarters of failure of Section 6.2 constitutes a material breach.

7. SECURITY. Apex shall maintain at the Facility: perimeter fencing; controlled-access gates with 24-hour guard service; CCTV coverage of all dock doors and staging areas with 90-day retention; seal verification on all inbound and outbound trailers; and yard checks at each shift change. Apex shall report any security incident affecting Cargo to Northgate within two (2) hours.

8. INSURANCE. Apex shall maintain: motor truck cargo legal liability insurance of not less than $500,000 per occurrence; warehouse legal liability of not less than $2,000,000; commercial general liability of $1,000,000/$2,000,000; umbrella of $5,000,000; naming Northgate as additional insured and loss payee. Certificates on request.

\f9. LIABILITY FOR CARGO. 9.1 Apex shall be liable to Northgate for the full actual value of any Cargo lost, damaged or destroyed while in Apex's care, custody or control, from the time of receipt at the Facility or from Northgate's customer until delivery, without limitation of liability under 49 U.S.C. § 14706 or otherwise, and Apex hereby waives any limitation of liability under its tariffs, bills of lading or the released-value provisions of the Carmack Amendment. 9.2 "Actual value" means the Shipment Value plus freight charges and any customs duties paid. 9.3 Claims shall be filed within nine (9) months of delivery or of the date delivery should have occurred; Apex shall acknowledge within 30 days and pay, decline or make a firm compromise offer within 120 days. 9.4 Apex shall not be liable for Loss caused solely by an act of God, the public enemy, act of Northgate, or the inherent vice of the Cargo, provided Apex was free from negligence.

\f10. COMPLIANCE. Apex shall comply with all applicable laws, including FMCSA regulations, and shall maintain satisfactory safety ratings. Apex represents that it holds MC-771204 and USDOT 2891133 and that its operating authority is active.

11. INDEMNIFICATION. 11.1 Apex shall defend, indemnify and hold harmless Northgate and its officers, directors, employees, customers and agents from and against any and all claims, demands, suits, losses, liabilities, damages, costs and expenses (including reasonable attorneys' fees) arising out of or relating to (a) any breach of this Agreement by Apex, (b) the negligence or willful misconduct of Apex or its employees, agents or subcontractors, (c) any Loss of Cargo while in Apex's care, custody or control, or (d) any claim by a Northgate customer relating to the Services, including claims for the customer's lost profits, chargebacks, penalties or costs of cover. 11.2 Northgate shall indemnify Apex for third-party claims arising from Northgate's negligence or breach. 11.3 The indemnifying party shall control the defense, subject to the indemnified party's approval of any settlement admitting fault.

\f12. LIMITATION OF LIABILITY. 12.1 EXCEPT AS PROVIDED IN SECTION 11, NEITHER PARTY SHALL BE LIABLE TO THE OTHER FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL OR PUNITIVE DAMAGES, INCLUDING LOST PROFITS, ARISING OUT OF OR RELATING TO THIS AGREEMENT, HOWEVER CAUSED AND UNDER ANY THEORY OF LIABILITY. 12.2 Nothing in this Section 12 limits Apex's liability under Section 9 for the actual value of Cargo.

13. TERMINATION. 13.1 Either party for material breach uncured within 30 days of notice. 13.2 Northgate for convenience on 60 days' notice. 13.3 Immediately by Northgate upon Apex's loss of operating authority, insolvency, or any security incident involving theft of Cargo exceeding $250,000 in Shipment Value.

14. CHANGE ORDERS. Any change to the Services, Service Levels, Operating Procedures or Rates shall be made only by a written Change Order in the form of Exhibit D, signed by an authorized representative of each party. No course of dealing, email or oral agreement shall modify this Agreement. Authorized representatives: for Northgate, the Vice President of Operations or the Director of Contracts; for Apex, the President or the Vice President of Operations.

\f15. CONFIDENTIALITY. [Standard mutual confidentiality; five-year survival.]

16. RECORDS AND AUDIT. Apex shall retain all records of the Services, including scan data, seal logs, CCTV footage (90 days) and yard-check logs, for three (3) years and shall make them available to Northgate on request within five (5) business days.

17. FORCE MAJEURE. [Standard; excludes labor disputes of the party's own workforce and shortages of personnel.]

18. GOVERNING LAW; VENUE. This Agreement is governed by the laws of the State of Illinois without regard to conflict-of-laws principles. The parties consent to the exclusive jurisdiction of the state and federal courts sitting in Cook County, Illinois, and the United States District Court for the Northern District of Illinois.

19. ENTIRE AGREEMENT; AMENDMENT. This Agreement, with its Exhibits and any Change Orders, is the entire agreement. It may be amended only in a writing signed by both parties in accordance with Section 14.

\fIN WITNESS WHEREOF the parties have executed this Agreement as of the Effective Date.

NORTHGATE LOGISTICS, INC.                APEX FREIGHT SYSTEMS, LLC
By: /s/ Melissa Grant                    By: /s/ Kevin Brandau
Name: Melissa Grant                      Name: Kevin Brandau
Title: Vice President, Operations        Title: President
Date: March 1, 2024                      Date: February 27, 2024

\fEXHIBIT A — STATEMENT OF WORK. Cross-dock receipt, sortation and reload of Northgate Cargo at the Facility; linehaul to Northgate's regional distribution centres at Columbus OH, Indianapolis IN and Kansas City MO; nightly departures; scan on receipt, on sort and on load; seal application and logging.

\fEXHIBIT B — RATE SCHEDULE. Cross-dock handling $2.85/cwt; linehaul per lane matrix (Joliet–Columbus $1,940/load; Joliet–Indianapolis $1,120; Joliet–Kansas City $2,310); fuel surcharge per DOE index; service credits: 2% of monthly handling charges per 0.1% shortfall in on-time; 5% per 0.05% excess loss ratio.

\fEXHIBIT C — OPERATING PROCEDURES. [12 pages; incorporated by reference: dock procedures, seal protocol (Section C-4), yard check (Section C-7), incident reporting (Section C-9), high-value cargo handling (Section C-11: consumer electronics and pharmaceuticals to be staged in the caged area and loaded last).]

\fEXHIBIT D — FORM OF CHANGE ORDER.`,
  },
  {
    id: "ed_ng_0002",
    pages: 2,
    date: "2024-06-14",
    custodian: NG_CUSTODIANS.whitmore,
    type: "Contract",
    subject: "Change Order No. 1 — addition of Nashville lane and revised fuel surcharge (executed)",
    aiScore: 62,
    aiIssues: ["K-02"],
    coding: { responsive: true, privileged: false, issues: ["K-02"], reviewerId: R.lopez, reviewedAt: "2026-09-02T10:30:00Z" },
    body: `CHANGE ORDER No. 1
to the Master Transportation Services Agreement dated March 1, 2024 between Northgate Logistics, Inc. and Apex Freight Systems, LLC

Effective Date: June 17, 2024

1. Exhibit A is amended to add linehaul service from the Facility to Northgate's Nashville, Tennessee regional distribution centre (2200 Cockrill Bend Boulevard), five departures weekly.
2. Exhibit B is amended to add: Joliet–Nashville $2,080/load.
3. Exhibit B, Section 2 (Fuel Surcharge) is amended to reference the DOE Midwest (PADD 2) weekly average in place of the national average.
4. All other terms unchanged.

\fNORTHGATE LOGISTICS, INC.            APEX FREIGHT SYSTEMS, LLC
/s/ Dana Whitmore                    /s/ Rhonda Feely
Dana Whitmore, Director of Contracts Rhonda Feely, Vice President, Operations
June 14, 2024                        June 12, 2024`,
  },
  {
    id: "ed_ng_0003",
    pages: 2,
    date: "2024-11-22",
    custodian: NG_CUSTODIANS.whitmore,
    type: "Contract",
    subject: "Change Order No. 2 — high-value cargo handling: caged staging and second seal verification (executed)",
    aiScore: 85,
    aiIssues: ["K-02", "LOSS-01"],
    coding: { responsive: true, privileged: false, hot: true, issues: ["K-02", "LOSS-01"], reviewerId: R.marsh, reviewedAt: "2026-09-02T10:40:00Z", notes: "Apex agreed to enhanced security for consumer electronics in Nov 2024 — nine months before the Sept 2025 losses. Establishes Apex's knowledge of the risk." },
    tags: ["key-doc"],
    body: `CHANGE ORDER No. 2
to the Master Transportation Services Agreement dated March 1, 2024

Effective Date: December 1, 2024

Background: Northgate has added Bright Harbor Electronics, Inc. as a customer whose Cargo (consumer electronics) will move through the Facility in volumes of approximately 40 pallets per night. The parties agree to enhanced handling procedures.

1. Exhibit C, Section C-11 is amended to require that all Cargo identified on the bill of lading as consumer electronics or bearing an "HV" designation shall: (a) be received directly into the caged staging area; (b) not be staged on the open dock at any time; (c) be loaded last, immediately before trailer seal application; (d) have a second seal verification performed by a supervisor, recorded in the seal log with the supervisor's initials.
2. Apex shall provide CCTV coverage of the caged area with 90-day retention and shall furnish footage to Northgate within 48 hours of request.
3. Rate adjustment: handling rate for HV Cargo $3.60/cwt.
4. All other terms unchanged.

\fNORTHGATE LOGISTICS, INC.            APEX FREIGHT SYSTEMS, LLC
/s/ Melissa Grant                    /s/ Kevin Brandau
Vice President, Operations           President
November 22, 2024                    November 20, 2024`,
  },
  {
    id: "ed_ng_0004",
    date: "2025-05-06",
    time: "09:12",
    custodian: NG_CUSTODIANS.grant,
    type: "Email",
    subject: "Change Order 3 — Apex proposal to reduce night-shift supervisors and modify seal protocol",
    from: "Rhonda Feely",
    to: ["Melissa Grant"],
    cc: ["Kevin Brandau", "Dana Whitmore"],
    threadId: T_CO3,
    attachmentIds: ["ed_ng_0005"],
    aiScore: 91,
    aiIssues: ["K-02", "LOSS-01"],
    coding: { responsive: true, privileged: false, hot: true, issues: ["K-02"], reviewerId: R.marsh, reviewedAt: "2026-09-02T11:00:00Z", notes: "Apex proposed CO-3 (one supervisor, single seal check). Never signed by Northgate — see Grant reply. Apex's 'course of dealing' argument rests on this thread." },
    tags: ["key-doc"],
    body: `Melissa —

As discussed on last week's ops call, Apex is proposing Change Order 3 (draft attached) to align the Joliet night shift with our current staffing. In summary:

1. One supervisor on the night shift (currently two) between 10 pm and 4 am, with a lead handler covering the second seal verification for HV cargo.
2. Second seal verification to be performed by the lead handler rather than a supervisor.
3. Handling rate reduction of $0.10/cwt on all cargo in recognition of the change.

We have been running this way on a trial basis since mid-April with no service impact, and the on-time numbers for April are the best we have had. We would like to formalise it effective June 1.

Rhonda

Rhonda Feely
Vice President, Operations
Apex Freight Systems, LLC`,
  },
  {
    id: "ed_ng_0005",
    pages: 2,
    date: "2025-05-06",
    custodian: NG_CUSTODIANS.grant,
    type: "Contract",
    subject: "DRAFT Change Order No. 3 — night-shift supervision and seal verification (unsigned)",
    parentId: "ed_ng_0004",
    aiScore: 84,
    aiIssues: ["K-02"],
    coding: { responsive: true, privileged: false, issues: ["K-02"], reviewerId: R.lopez, reviewedAt: "2026-09-02T11:05:00Z", notes: "Unsigned draft. Signature blocks blank." },
    body: `CHANGE ORDER No. 3 — DRAFT
to the Master Transportation Services Agreement dated March 1, 2024

Proposed Effective Date: June 1, 2025

1. Section 5 of the Agreement is amended to require a minimum of one (1) supervisor and one (1) lead handler on the night shift (22:00–04:00) at the Facility.
2. Exhibit C, Section C-11(d) is amended to permit the second seal verification for HV Cargo to be performed by a lead handler.
3. Exhibit B handling rates are reduced by $0.10/cwt for all Cargo effective on the Proposed Effective Date.
4. All other terms unchanged.

\fNORTHGATE LOGISTICS, INC.            APEX FREIGHT SYSTEMS, LLC
By: ____________________             By: ____________________
Name:                                Name:
Title:                               Title:
Date:                                Date:`,
  },
  {
    id: "ed_ng_0006",
    date: "2025-05-09",
    time: "16:44",
    custodian: NG_CUSTODIANS.grant,
    type: "Email",
    subject: "RE: Change Order 3 — Apex proposal to reduce night-shift supervisors and modify seal protocol",
    to: ["Rhonda Feely"],
    cc: ["Kevin Brandau", "Dana Whitmore", "Victor Salazar"],
    threadId: T_CO3,
    aiScore: 93,
    aiIssues: ["K-02", "LOSS-01"],
    coding: { responsive: true, privileged: false, hot: true, issues: ["K-02"], reviewerId: R.marsh, reviewedAt: "2026-09-02T11:10:00Z", notes: "Northgate's written rejection of CO-3. Also notes the 'trial' was not authorised. Key for the §14 argument." },
    tags: ["key-doc", "exhibit-candidate"],
    body: `Rhonda —

Northgate does not agree to Change Order 3 and will not be signing it. Two supervisors on the night shift and supervisor sign-off on the second seal check were the specific terms we negotiated in Change Order 2 when we brought Bright Harbor's volume to Joliet, and they are the reason Bright Harbor agreed to route through your facility. A $0.10 rate reduction does not change the analysis.

I also want to be clear about the "trial." Northgate did not authorise a trial. Section 14 of the MTSA requires a signed change order for any change to the Operating Procedures, and no one at Northgate agreed to a reduction in supervision, in writing or otherwise. Please restore two supervisors on the night shift and supervisor seal verification immediately and confirm by return email.

Victor will follow up on the ops call Tuesday.

Melissa

Melissa Grant
Vice President, Operations
Northgate Logistics, Inc.`,
  },
  {
    id: "ed_ng_0007",
    date: "2025-05-13",
    time: "08:30",
    custodian: NG_CUSTODIANS.salazar,
    type: "Email",
    subject: "RE: Change Order 3 — ops call follow-up",
    from: "Curtis Lange",
    to: ["Victor Salazar"],
    cc: ["Rhonda Feely"],
    threadId: T_CO3,
    aiScore: 80,
    aiIssues: ["K-02", "LOSS-01"],
    coding: { responsive: true, privileged: false, issues: ["K-02"], reviewerId: R.lopez, reviewedAt: "2026-09-02T11:20:00Z", notes: "Apex's Joliet manager confirms 'back to two supervisors' — but see the Sept incident reports showing one supervisor on shift." },
    body: `Victor —

Confirming from the call: we are back to two supervisors on nights as of last night and Rhonda has pulled the CO-3 proposal. The second seal check is being signed by a supervisor. Sorry for the noise — the staffing change came from our side and should have been run past you first.

We are still short one night supervisor (Dwayne gave notice) so for the next few weeks Ray or I will cover the second slot personally.

Curtis

Curtis Lange
General Manager, Joliet
Apex Freight Systems, LLC`,
  },
  {
    id: "ed_ng_0008",
    pages: 3,
    date: "2025-09-15",
    custodian: NG_CUSTODIANS.salazar,
    type: "Report",
    subject: "Cargo loss report — Bright Harbor Electronics shipment BHE-44712 — trailer 2281 — Joliet cross-dock — September 14, 2025",
    from: "Victor Salazar",
    aiScore: 95,
    aiIssues: ["LOSS-01", "DMG-01"],
    aiSummary: "Northgate's internal report on the September 14, 2025 loss: trailer 2281 loaded with 38 pallets of Bright Harbor consumer electronics (declared value $1,412,600) departed Joliet with seal number recorded but the trailer was found empty at the Columbus RDC; CCTV shows the trailer was moved to the north yard at 01:40 and re-sealed; only one supervisor was on shift; second seal check initialled by a lead handler. Apex's incident notification was 11 hours late.",
    entities: { people: ["Victor Salazar", "Curtis Lange", "Ray Dombrowski"], orgs: ["Bright Harbor Electronics, Inc.", "Apex Freight Systems, LLC", "Joliet Police Department"], places: ["Joliet, IL", "Columbus, OH"] },
    coding: { responsive: true, privileged: false, hot: true, confidentiality: "confidential", issues: ["LOSS-01", "DMG-01"], reviewerId: R.marsh, reviewedAt: "2026-09-02T13:00:00Z", notes: "Primary loss event. Salazar deposed on this report 2026-07-14." },
    tags: ["key-doc", "exhibit-candidate"],
    body: `NORTHGATE LOGISTICS, INC. — CARGO LOSS REPORT
Report No. CLR-2025-0914-01 — Prepared by V. Salazar, Director, Carrier Operations — September 15, 2025

1. SHIPMENT. Customer: Bright Harbor Electronics, Inc. Shipment BHE-44712, 38 pallets (1,216 cartons) of consumer electronics (tablets and wireless earbuds), origin Bright Harbor DC, Elk Grove Village IL; destination Northgate RDC Columbus OH. Declared Shipment Value: $1,412,600. Bill of lading NGL-88213047 marked "HV — CAGED STAGING — CO-2 PROCEDURES."

2. CHRONOLOGY (from Apex scan data, seal log and CCTV obtained September 15).
 Sep 14, 19:42 — Inbound received at Joliet dock door 14; 38 pallets scanned. Cage scan: 38 pallets at 20:10.
 22:05 — Night shift begins. Seal log and shift roster show one supervisor (R. Dombrowski) and one lead handler (T. Okoye) on shift. Second supervisor position: blank.
 23:50 — Cage-out scan: 38 pallets to door 22, trailer 2281. Loaded 23:55–00:30.
 00:34 — Seal 4471928 applied (Okoye). Seal log "second verification" column initialled "TO" — lead handler, not supervisor.
 01:40 — CCTV (yard camera 6): trailer 2281 moved by a yard tractor from door 22 to the north yard row C. Yard tractor not identified on Apex's equipment log for that hour.
 02:15 — CCTV (camera 6): a second tractor couples to trailer 2281 and exits via the north gate. Gate log shows exit at 02:17 under "Apex shuttle — empty" with no seal recorded. Guard on duty did not verify seal.
 \f03:20 — CCTV: a trailer bearing number 2281 returns via the north gate and is parked in row C. Gate log: "return — empty."
 04:05 — Linehaul driver (Apex, D. Prewitt) couples to trailer 2281 at row C per dispatch. Driver's pre-trip notes seal 4471928 intact. Departs 04:20.
 Sep 15, 09:50 — Arrival Columbus RDC. Seal 4471928 intact. Trailer opened: empty except 4 pallets of Bright Harbor product (114 cartons). 34 pallets missing (1,102 cartons; est. value $1,280,900).
 10:05 — Northgate Columbus notifies Salazar. 10:20 — Salazar calls Lange (Apex Joliet). Lange states he is "unaware of any incident."
 13:10 — Apex written incident notification received (Feely). Section 7 of the MTSA requires notification within 2 hours of a security incident; the incident occurred at 01:40–03:20.
 14:30 — Joliet Police Department report 25-0091447 filed by Apex.

3. FINDINGS.
 (a) The seal was defeated: the seal number on the trailer at Columbus matched the log, but CCTV shows the trailer left the yard and returned. Either the seal was removed and a duplicate applied, or the log number was altered. Apex has not produced the physical seal.
 (b) One supervisor on shift, in violation of MTSA §5 and Change Order 2, and contrary to Apex's May 13 confirmation.
 (c) Second seal verification by a lead handler, in violation of Change Order 2.
 (d) Gate control failure: exit and re-entry of a loaded trailer logged as "empty" without seal check, in violation of MTSA §7.
 (e) Notification 11 hours late.
\f4. CUSTOMER IMPACT. Bright Harbor has issued a chargeback of $1,280,900 (product) plus $84,000 (expedited replacement freight) and has invoked the 2% late-delivery penalty under its contract with Northgate ($28,252). Bright Harbor has notified Northgate that it is suspending routing through Joliet pending investigation.

5. INSURANCE. Notice given to Marlow Insurance (Northgate's contingent cargo policy) September 15. Apex's cargo policy limit under MTSA §8 is $500,000 per occurrence.

6. RECOMMENDATIONS. (a) Formal claim to Apex under §9 and demand for indemnity under §11 for the full loss and customer charges. (b) Suspend HV routing through Joliet. (c) Demand preservation of all CCTV, gate logs, seal logs and the physical seal under §16. (d) Refer to Law Department.

V. Salazar`,
  },
  {
    id: "ed_ng_0009",
    date: "2025-09-15",
    time: "13:10",
    custodian: NG_CUSTODIANS.salazar,
    type: "Email",
    subject: "Incident notification — trailer 2281 — Joliet",
    from: "Rhonda Feely",
    to: ["Victor Salazar", "Melissa Grant"],
    cc: ["Curtis Lange", "Kevin Brandau"],
    threadId: T_LOSS,
    aiScore: 86,
    aiIssues: ["LOSS-01"],
    coding: { responsive: true, privileged: false, hot: true, issues: ["LOSS-01"], reviewerId: R.marsh, reviewedAt: "2026-09-02T13:10:00Z", notes: "Apex's late notification; characterises the event as 'apparent theft by unknown third parties' and denies staffing shortfall." },
    body: `Victor, Melissa —

This is Apex's formal notification under Section 7 of the MTSA of a security incident at the Joliet Facility in the early hours of September 15 involving trailer 2281 (Northgate BOL NGL-88213047). Apex became aware of the incident at approximately 10:20 this morning when contacted by Northgate. Apex has reported the matter to the Joliet Police Department (report 25-0091447) and is cooperating fully.

Preliminary review indicates an apparent theft by unknown third parties who gained access to the yard. Apex's procedures were followed: the trailer was sealed at 00:34 with seal 4471928, the seal was verified, and the seal was intact on arrival at Columbus. Apex is reviewing gate and CCTV records.

Apex will preserve all records. Apex reserves all rights under the MTSA, including under Sections 9.4 and 12.

Rhonda Feely
Vice President, Operations`,
  },
  {
    id: "ed_ng_0010",
    date: "2025-09-16",
    time: "07:58",
    custodian: NG_CUSTODIANS.salazar,
    type: "Email",
    subject: "RE: Incident notification — trailer 2281 — Joliet — staffing and CCTV",
    to: ["Rhonda Feely", "Curtis Lange"],
    cc: ["Melissa Grant", "Dana Whitmore"],
    threadId: T_LOSS,
    aiScore: 88,
    aiIssues: ["LOSS-01", "K-02"],
    coding: { responsive: true, privileged: false, hot: true, issues: ["LOSS-01", "K-02"], reviewerId: R.marsh, reviewedAt: "2026-09-02T13:15:00Z" },
    body: `Rhonda, Curtis —

"Apex's procedures were followed" is not consistent with your own records. Your shift roster for the night of September 14 shows one supervisor. Your seal log shows the second verification initialled "TO" — Tunde Okoye is a lead handler. Your gate log shows trailer 2281 leaving at 02:17 as "empty" with no seal check and returning at 03:20. Camera 6 shows all of it. That is not third parties gaining access to the yard; that is a loaded trailer being driven out of your gate by someone your guard waved through.

Curtis — on May 13 you confirmed in writing that you were back to two supervisors on nights. Please explain, in writing, on which nights between May 13 and September 14 the Joliet night shift ran with one supervisor.

Please produce by Friday: full CCTV for cameras 4, 6, 9 and the cage camera from 18:00 Sep 14 to 06:00 Sep 15; gate logs; the physical seal 4471928 or an explanation of where it is; the yard tractor assignment log; and Okoye's and Dombrowski's incident statements.

Victor`,
  },
  {
    id: "ed_ng_0011",
    pages: 2,
    date: "2025-10-02",
    custodian: NG_CUSTODIANS.salazar,
    type: "Report",
    subject: "Cargo loss report — Bright Harbor shipment BHE-45108 — shortage of 6 pallets — Joliet cross-dock — September 28, 2025",
    from: "Victor Salazar",
    aiScore: 87,
    aiIssues: ["LOSS-01", "DMG-01"],
    coding: { responsive: true, privileged: false, hot: false, issues: ["LOSS-01", "DMG-01"], reviewerId: R.lopez, reviewedAt: "2026-09-02T13:30:00Z" },
    body: `NORTHGATE LOGISTICS, INC. — CARGO LOSS REPORT
Report No. CLR-2025-0928-01 — V. Salazar — October 2, 2025

1. SHIPMENT. Bright Harbor Electronics shipment BHE-45108 (final shipment before Bright Harbor's routing suspension took effect), 22 pallets, declared value $610,400, BOL NGL-88219902, HV. Joliet to Indianapolis RDC.

2. EVENT. Received Joliet Sep 28, 20:15, 22 pallets scanned; cage scan 22 pallets 20:40. Cage-out scan 21:55: 22 pallets. Loaded trailer 1877, seal 4472106 applied 22:40. Arrival Indianapolis Sep 29 06:10, seal intact: 16 pallets. Six pallets (192 cartons, est. value $166,500) short. Apex cage CCTV for 20:40–21:55: Apex states the cage camera was "not recording due to a storage fault" from Sep 26 to Sep 30.

3. FINDINGS. (a) Shortage occurred at the Facility between cage-in and load. (b) Cage CCTV unavailable — MTSA §7 and CO-2 ¶2 require 90-day retention. (c) Night-shift roster Sep 28: one supervisor (Dombrowski). This is the fifth night in the period Sep 12–28 for which Apex's rosters (produced Sep 26) show a single supervisor.

\f4. CUSTOMER IMPACT. Bright Harbor chargeback $166,500; late penalty $12,208. Bright Harbor has terminated its Joliet routing and has given Northgate notice of intent to re-bid its Midwest business ($9.4M annual revenue to Northgate).

5. RECOMMENDATION. Add to the claim and demand under §§9 and 11. Notify Marlow. Escalate to Law Department for termination analysis under §13.3 (aggregate theft now $1,447,400 in Shipment Value, exceeding the $250,000 threshold).

V. Salazar`,
  },
  {
    id: "ed_ng_0012",
    pages: 4,
    date: "2025-10-17",
    custodian: NG_CUSTODIANS.grant,
    type: "Letter",
    subject: "Demand for indemnification and payment of cargo claims — MTSA §§ 9 and 11 — Northgate Logistics to Apex Freight Systems",
    from: "Dhruv Oberoi",
    to: ["Kevin Brandau"],
    cc: ["Melissa Grant", "Dana Whitmore"],
    threadId: T_DEMAND,
    aiScore: 94,
    aiIssues: ["IND-01", "DMG-01", "K-01"],
    coding: { responsive: true, privileged: false, hot: true, issues: ["IND-01", "DMG-01"], reviewerId: R.marsh, reviewedAt: "2026-09-02T14:00:00Z", notes: "Demand letter sent to adverse party — not privileged. Ex. 9 to the complaint." },
    tags: ["key-doc", "exhibit-candidate"],
    body: `CALLOWAY & REYES LLP
233 South Wacker Drive, Suite 6100, Chicago, Illinois 60606

October 17, 2025

VIA EMAIL AND FEDERAL EXPRESS

Mr. Kevin Brandau
President
Apex Freight Systems, LLC
1901 Mound Road
Joliet, Illinois 60436

Re: Northgate Logistics, Inc. — Demand for payment of cargo claims and indemnification under the Master Transportation Services Agreement dated March 1, 2024

Dear Mr. Brandau:

This firm represents Northgate Logistics, Inc. ("Northgate") in connection with the losses of Bright Harbor Electronics cargo at Apex's Joliet facility on September 14–15 and September 28–29, 2025 (the "Losses"). Northgate hereby makes formal claim under Section 9 of the Master Transportation Services Agreement (the "MTSA") and demand for defense and indemnification under Section 11.

1. The Losses. On September 14–15, 2025, 34 pallets of consumer electronics tendered under BOL NGL-88213047 (declared Shipment Value $1,280,900) were removed from trailer 2281 while the trailer was in Apex's care, custody and control at the Facility. On September 28–29, 2025, six pallets tendered under BOL NGL-88219902 (declared value $166,500) were lost between cage-in and loading at the Facility. Apex's own records establish that on both nights the Facility was staffed with a single night supervisor in breach of MTSA Section 5 and Change Order No. 2; that the second seal verification required by Change Order No. 2 was not performed by a supervisor; that a loaded trailer exited and re-entered the yard without a seal check in breach of Section 7; that required CCTV footage was not retained; and that notification was made eleven hours after the event in breach of Section 7.

\f2. Cargo claim (Section 9). Apex is liable for the full actual value of the lost Cargo, without limitation. Northgate claims $1,447,400 in Shipment Value plus freight charges of $6,130.

3. Indemnification (Section 11). Section 11.1 obligates Apex to indemnify Northgate for all losses and expenses arising out of Apex's breach, Apex's negligence, any Loss of Cargo in Apex's custody, and any claim by a Northgate customer relating to the Services, "including claims for the customer's lost profits, chargebacks, penalties or costs of cover." Bright Harbor has charged back $1,447,400 in product, $84,000 in expedited replacement freight and $40,460 in late-delivery penalties, and has terminated its routing through Joliet. Northgate demands indemnification of these amounts and of Northgate's attorneys' fees, and notifies Apex that Northgate will seek indemnification for the loss of the Bright Harbor account, which Bright Harbor has attributed in writing to the Losses.

4. Section 12. Apex's reservation of rights under Section 12 (waiver of consequential damages) is misplaced. Section 12.1 applies "except as provided in Section 11," and Section 11.1(d) expressly extends to customer lost profits, chargebacks and penalties. The parties negotiated that carve-out specifically. Section 12.2 further preserves Apex's Section 9 liability for actual value.

\f5. Demand. Northgate demands payment of $1,453,530 (cargo claim) within thirty (30) days under Section 9.3, and written confirmation within ten (10) days that Apex accepts its indemnification obligations under Section 11 with respect to the Bright Harbor charges, penalties and consequential losses. Northgate further demands, under Section 16, production within five business days of: all CCTV footage for September 12–30, 2025; gate, seal, yard-check and shift rosters for May 1–September 30, 2025; the physical seals 4471928 and 4472106; and all communications with the Joliet Police Department.

6. Termination. Northgate reserves its right to terminate the MTSA under Section 13.3, the aggregate theft of Cargo having exceeded $250,000 in Shipment Value, and under Section 13.1.

Nothing in this letter waives any right or remedy of Northgate, all of which are expressly reserved.

Very truly yours,

Dhruv Oberoi
Mehra & Rao Advocates

cc: Melissa Grant; Dana Whitmore; Ana Pereira, Marlow Insurance Group (by email)`,
  },
  {
    id: "ed_ng_0013",
    pages: 3,
    date: "2025-11-10",
    custodian: NG_CUSTODIANS.grant,
    type: "Letter",
    subject: "Response to demand — Apex Freight Systems denial of indemnity and tender of $500,000 policy limits",
    from: "Kevin Brandau",
    to: ["Dhruv Oberoi"],
    cc: ["Melissa Grant"],
    threadId: T_DEMAND,
    aiScore: 92,
    aiIssues: ["IND-01", "DMG-01", "K-02"],
    coding: { responsive: true, privileged: false, hot: true, issues: ["IND-01", "DMG-01", "K-02"], reviewerId: R.marsh, reviewedAt: "2026-09-02T14:10:00Z", notes: "Apex's position: §12 bars consequentials; CO-3 'course of dealing'; theft by third parties = §9.4. Contradicted by Lange 5/13 email and rosters." },
    tags: ["key-doc", "exhibit-candidate"],
    body: `APEX FREIGHT SYSTEMS, LLC
1901 Mound Road, Joliet, Illinois 60436

November 10, 2025

Dhruv Oberoi, Esq.
Mehra & Rao Advocates
233 South Wacker Drive, Suite 6100
Chicago, Illinois 60606

Re: Northgate Logistics, Inc. — Your letter of October 17, 2025

Dear Mr. Oberoi:

Apex Freight Systems, LLC responds to Northgate's demand as follows.

1. Cargo claim. Apex acknowledges the claims under Section 9.3. Apex's investigation, and that of the Joliet Police Department, indicates that the September 14–15 loss resulted from a theft by third parties using a stolen yard tractor and a counterfeit seal, an event Apex could not reasonably have prevented and for which Apex is not liable under Section 9.4. Without admission of liability and in the interest of the commercial relationship, Apex tenders the $500,000 per-occurrence limit of its motor truck cargo policy (Great Plains Mutual, policy MTC-4471180) in full settlement of both claims. The September 28 shortage is under investigation; Apex notes that the shipment was scanned out of the cage at full count.

\f2. Indemnification and consequential damages. Apex rejects Northgate's demand for indemnification of Bright Harbor's chargebacks, penalties, expedited freight and lost business. Section 12.1 of the MTSA is a mutual waiver of consequential damages, including lost profits. The Section 11 exception applies to third-party claims; Northgate's own lost revenue and its customer's chargebacks are direct commercial losses of Northgate, not third-party claims within Section 11. In any event, Bright Harbor's termination of its routing was Bright Harbor's commercial decision and is not a "loss arising out of" any act of Apex.

3. Staffing. Northgate's assertion that Apex "breached" Change Order 2 by staffing the night shift with one supervisor disregards the parties' course of dealing. Apex proposed Change Order 3 in May 2025; Northgate's Director of Carrier Operations participated in weekly operations calls from May through September at which Apex's night-shift staffing was discussed, and Northgate continued to tender HV cargo. Northgate accepted the modified procedures by conduct and is estopped from asserting breach.

\f4. Records. Apex has produced its shift rosters, seal logs and gate logs. CCTV for the cage camera for September 26–30 is unavailable due to an equipment fault, which Apex has documented. The physical seals were retained by the Joliet Police Department.

5. Termination. Apex denies that Section 13.3 has been triggered, the losses having resulted from third-party criminal acts rather than "theft of Cargo" attributable to Apex, and reserves its right to recover damages for wrongful termination.

Apex remains willing to discuss a commercial resolution.

Sincerely,

Kevin Brandau
President

cc: Rhonda Feely; Great Plains Mutual Insurance Co. (claims)`,
  },
  {
    id: "ed_ng_0014",
    date: "2025-11-12",
    time: "10:35",
    custodian: NG_CUSTODIANS.grant,
    type: "Email",
    subject: "Apex response — litigation recommendation (privileged)",
    from: "Dhruv Oberoi",
    to: ["Melissa Grant", "Dana Whitmore"],
    threadId: T_DEMAND,
    aiScore: 82,
    aiIssues: ["LEG-01", "IND-01"],
    coding: { responsive: true, privileged: true, privilegeBasis: "attorney-client", confidentiality: "AEO", issues: ["LEG-01"], reviewerId: R.marsh, reviewedAt: "2026-09-02T14:20:00Z", notes: "Outside counsel advice to client. Withhold; log." },
    body: `PRIVILEGED & CONFIDENTIAL — ATTORNEY-CLIENT COMMUNICATION / WORK PRODUCT

Melissa, Dana —

Apex's letter is what we expected. My recommendation is to reject the $500,000 tender and file in the Northern District of Illinois by year-end. Reasoning:

1. §12/§11. Their reading of §11 as limited to "third-party claims" ignores §11.1(d), which was drafted (by Dana, in the November 2024 negotiation over Change Order 2) precisely to reach Bright Harbor's chargebacks and penalties. The negotiation history will be important; please locate Dana's redlines and the emails with Feely from November 2024.

2. Course of dealing. §14 says no course of dealing modifies the agreement, Melissa rejected CO-3 in writing on May 9, and Lange confirmed restoration on May 13. Their estoppel argument depends on Victor's participation in ops calls; I want to see the ops call notes to confirm Apex never disclosed the single-supervisor nights after May 13.

3. §9.4. Their "third-party theft" story does not survive camera 6. And even if a third party was involved, §9.4 requires Apex to be "free from negligence."

4. Damages. Cargo $1.45M is straightforward. Bright Harbor's chargebacks and penalties ($1.57M total) are recoverable under §11.1(d). Loss of the Bright Harbor account (~$1.9M annual margin) is the contested piece; we should plead it and expect a fight on §12 at summary judgment.

Filing draft to you by December 5. Please implement the litigation hold I circulated yesterday.

Dhruv`,
  },
  {
    id: "ed_ng_0015",
    date: "2025-09-15",
    time: "15:22",
    custodian: NG_CUSTODIANS.grant,
    type: "Email",
    subject: "Notice of loss — contingent cargo policy NCC-2024-0917 — Bright Harbor shipment BHE-44712",
    to: ["Ana Pereira"],
    cc: ["Dana Whitmore"],
    aiScore: 60,
    aiIssues: ["DMG-01"],
    coding: { responsive: true, privileged: false, issues: ["DMG-01"], reviewerId: R.lopez, reviewedAt: "2026-09-02T14:30:00Z" },
    body: `Ana —

Notice of loss under Northgate's contingent cargo policy NCC-2024-0917. Shipment BHE-44712 (Bright Harbor Electronics), 34 pallets short on arrival at Columbus this morning, declared value of missing product $1,280,900. Carrier: Apex Freight Systems (Joliet cross-dock). Apex's primary cargo limit is $500,000. Police report filed. Our loss report will follow tomorrow.

Please confirm the claim number and let us know what you need.

Melissa`,
  },
  {
    id: "ed_ng_0016",
    date: "2025-09-22",
    time: "11:48",
    custodian: NG_CUSTODIANS.grant,
    type: "Email",
    subject: "RE: Notice of loss — NCC-2024-0917 — reservation of rights and subrogation",
    from: "Ana Pereira",
    to: ["Melissa Grant"],
    cc: ["Dana Whitmore"],
    aiScore: 66,
    aiIssues: ["DMG-01"],
    coding: { responsive: true, privileged: false, issues: ["DMG-01"], reviewerId: R.lopez, reviewedAt: "2026-09-02T14:35:00Z" },
    body: `Melissa —

Claim MIG-25-88410 is open. Marlow acknowledges notice and reserves rights pending review of the carrier's liability and the policy's "primary carrier exhaustion" condition (Condition 7). The contingent policy responds only to the extent the primary carrier's coverage is exhausted or its liability is denied; please keep us informed of Apex's position. Marlow will require an assignment of Northgate's rights against Apex to the extent of any payment.

We note the declared value exceeds the policy's $1,000,000 per-conveyance limit; the excess would not be covered.

Ana Pereira
Senior Claims Examiner, Marlow Insurance Group`,
  },
  {
    id: "ed_ng_0017",
    date: "2025-11-11",
    time: "17:40",
    custodian: NG_CUSTODIANS.whitmore,
    type: "Email",
    subject: "LITIGATION HOLD — Northgate / Apex (privileged)",
    from: "Dhruv Oberoi",
    to: ["Melissa Grant", "Dana Whitmore", "Victor Salazar"],
    aiScore: 45,
    aiIssues: ["LEG-01"],
    coding: { responsive: true, privileged: true, privilegeBasis: "attorney-client", confidentiality: "AEO", issues: ["LEG-01"], reviewerId: R.lopez, reviewedAt: "2026-09-02T14:40:00Z" },
    body: `PRIVILEGED & CONFIDENTIAL

Please preserve all documents and ESI relating to the Apex MTSA, Change Orders 1–3, the Joliet facility, Bright Harbor Electronics, the September 2025 losses, weekly operations calls with Apex (including any notes, recordings or Teams chats), and communications with Marlow Insurance. Suspend auto-deletion on your mailboxes and Teams. Do not delete text messages with Apex personnel. Forward this notice to anyone else at Northgate who may have relevant material and let me know who received it.

Dhruv`,
  },
  {
    id: "ed_ng_0018",
    pages: 2,
    date: "2024-11-18",
    custodian: NG_CUSTODIANS.whitmore,
    type: "Email",
    subject: "CO-2 redline — §11.1(d) customer chargebacks language",
    to: ["Rhonda Feely"],
    cc: ["Melissa Grant"],
    aiScore: 90,
    aiIssues: ["K-01", "K-02", "IND-01"],
    coding: { responsive: true, privileged: false, hot: true, issues: ["K-01", "IND-01"], reviewerId: R.marsh, reviewedAt: "2026-09-02T15:00:00Z", notes: "Negotiation history for §11.1(d). Feely accepted the chargeback language on 11/20. Directly rebuts Apex's 'third-party claims only' reading." },
    tags: ["key-doc", "exhibit-candidate"],
    body: `Rhonda —

Redline of Change Order 2 attached. One substantive point beyond the operating procedures: because Bright Harbor's contract with us carries chargebacks for lost product and a 2% late penalty, and because we cannot absorb those on a cross-dock margin, we need Section 11.1(d) of the MTSA to cover customer chargebacks, penalties and costs of cover expressly. The current 11.1(d) says "any claim by a Northgate customer relating to the Services." Proposed: add "including claims for the customer's lost profits, chargebacks, penalties or costs of cover."

I recognise this touches the Section 12 waiver. That is the point: as between us, if Apex loses Bright Harbor's product, Apex bears what Bright Harbor charges us. In exchange we are agreeing to the HV handling rate of $3.60/cwt, which is a 26% premium.

Kevin has seen this. Please confirm Apex's agreement and I will send the execution copy.

Dana

\f-----Reply, November 20, 2024, 09:14, from Rhonda Feely-----
Dana — Kevin has approved the 11.1(d) language as you proposed, with the $3.60 rate. Send the execution copy. — Rhonda`,
  },
];
