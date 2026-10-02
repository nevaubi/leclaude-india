import "server-only";
import type { Database } from "@/lib/db";
import { MATTERS, PEOPLE } from "@/lib/seed/ids";
import { makeProvenance } from "@/lib/integrity/provenance";
import type { RunMetrics } from "@/lib/ai/events";
import { jurisdictionByKey } from "./jurisdictions";
import { answerHash } from "./engine/binding";
import { sourceFromHit, toProvenanceSources } from "./engine/sources";
import { messageTrustState } from "./engine/trust";
import { planSubQuestions } from "./engine/planner";
import { currentnessOf } from "./engine/treatment";
import type { ResearchMessage, ResearchSource, ResearchThread } from "./engine/types";
import type { SavedSearch, SearchHit, SearchRun, SearchSettings } from "./types";

const OWNER = PEOPLE.arjunMehra;

const base = (over: Partial<SearchSettings> = {}): SearchSettings => ({
  sources: ["caselaw", "statutes", "regulations", "library"],
  jurisdiction: "all-federal",
  courts: "",
  datePreset: "any",
  limit: 15,
  order: "score",
  matterId: null,
  fast: false,
  ...over,
});

const savedSearches: SavedSearch[] = [
  {
    id: "ss_vls_liquidated_damages",
    name: "Liquidated damages and penalty — Section 74 (India)",
    query: '"liquidated damages" AND ("section 74" OR penalty) AND ("reasonable compensation" OR "genuine pre-estimate")',
    settings: base({ sources: ["caselaw", "statutes", "library", "ediscovery"], jurisdiction: "all-india", matterId: MATTERS.valsara, datePreset: "any" }),
    ownerId: OWNER, createdAt: "2026-06-11T14:02:00.000Z", updatedAt: "2026-09-18T09:41:00.000Z", lastRunAt: "2026-09-18T09:41:00.000Z", runCount: 14, pinned: true,
    tags: ["Valsara", "contract"], matterId: MATTERS.valsara,
    notes: "Clause 9.6 liquidated damages: must the Claimant prove legal injury, and is the Clause 9.6 figure a cap? Track Kailash Nath and the ONGC v. Saw Pipes line.",
  },
  {
    id: "ss_conseq_damages_ca7",
    name: "Consequential damages waiver enforceability — 7th Cir.",
    query: '"consequential damages" AND (waiver OR exclusion OR "limitation of liability") AND (enforceab* OR unconscionab* OR "fails of its essential purpose")',
    settings: base({ sources: ["caselaw", "statutes", "library"], jurisdiction: "7th-circuit", matterId: MATTERS.northgate, datePreset: "any", order: "score" }),
    ownerId: OWNER, createdAt: "2026-02-03T16:20:00.000Z", updatedAt: "2026-09-15T18:05:00.000Z", lastRunAt: "2026-09-15T18:05:00.000Z", runCount: 9, pinned: true,
    tags: ["Northgate", "UCC 2-719"], matterId: MATTERS.northgate,
    notes: "MSJ opposition due Oct 9. Focus on Illinois law (810 ILCS 5/2-719) and whether the indemnity carve-out survives the waiver.",
  },
  {
    id: "ss_vls_notice_clause",
    name: "Contractual notice duty and indemnity (Clause 9.4 / 12)",
    query: '("notice clause" OR "duty to notify" OR "condition precedent") AND indemn* AND (waiver OR estoppel)',
    settings: base({ sources: ["statutes", "caselaw", "library", "ediscovery"], jurisdiction: "all-india", matterId: MATTERS.valsara }),
    ownerId: OWNER, createdAt: "2026-04-22T11:12:00.000Z", updatedAt: "2026-09-12T13:30:00.000Z", lastRunAt: "2026-09-12T13:30:00.000Z", runCount: 7, pinned: true,
    tags: ["Valsara", "contract"], matterId: MATTERS.valsara,
    notes: "Knowledge-timeline work: what did Meridian know and when did the Clause 9.4 notice duty attach? Compare the Schedule 6 Notification Protocol and the indemnity in Clause 12.",
  },
  {
    id: "ss_paga_manageability",
    name: "PAGA manageability",
    query: 'PAGA AND (manageab* OR unmanageab* OR "trial plan") AND (Estrada OR Wesson)',
    settings: base({ sources: ["caselaw", "statutes", "library"], jurisdiction: "california-state", matterId: MATTERS.sterling, datePreset: "5y" }),
    ownerId: OWNER, createdAt: "2026-08-20T15:44:00.000Z", updatedAt: "2026-09-19T20:12:00.000Z", lastRunAt: "2026-09-19T20:12:00.000Z", runCount: 5, pinned: false,
    tags: ["Sterling", "PAGA"], matterId: MATTERS.sterling,
    notes: "Post-Estrada (Cal. 2024) the manageability strike is gone; look for due-process based limits and the 2024 PAGA reform (AB 2288 / SB 92) standing and cure provisions.",
  },
  {
    id: "ss_meningioma_dmpa",
    name: "Meningioma DMPA",
    query: '(meningioma OR "intracranial tumor") AND (medroxyprogesterone OR DMPA OR "Depo-Provera")',
    settings: base({ sources: ["caselaw", "federal_register", "regulations", "web", "library"], jurisdiction: "11th-circuit", matterId: MATTERS.depo, datePreset: "5y" }),
    ownerId: OWNER, createdAt: "2026-03-14T10:05:00.000Z", updatedAt: "2026-09-16T08:22:00.000Z", lastRunAt: "2026-09-16T08:22:00.000Z", runCount: 11, pinned: true,
    tags: ["Depo-Provera", "science"], matterId: MATTERS.depo,
    notes: "Science Day Nov 20. Watch for FDA labeling actions after Roland et al. (BMJ 2024) and any EMA/PRAC signal assessments.",
  },
  {
    id: "ss_preemption_cbe",
    name: "Impossibility preemption — CBE labeling changes (Albrecht)",
    query: '("clear evidence" OR "impossibility preemption") AND (Albrecht OR "Wyeth v. Levine") AND ("changes being effected" OR CBE OR "314.70")',
    settings: base({ sources: ["caselaw", "regulations", "library"], jurisdiction: "11th-circuit", matterId: MATTERS.depo, datePreset: "10y" }),
    ownerId: OWNER, createdAt: "2026-05-02T09:18:00.000Z", updatedAt: "2026-09-10T17:01:00.000Z", lastRunAt: "2026-09-10T17:01:00.000Z", runCount: 6, pinned: false,
    tags: ["Depo-Provera", "preemption"], matterId: MATTERS.depo,
  },
  {
    id: "ss_vls_spec_compliance",
    name: "Specification compliance and fitness for purpose — Sale of Goods Act ss. 15–16",
    query: '("sale by description" OR "fitness for purpose" OR "merchantable quality") AND (specification OR "particular purpose")',
    settings: base({ sources: ["caselaw", "statutes", "library", "ediscovery"], jurisdiction: "all-india", matterId: MATTERS.valsara }),
    ownerId: OWNER, createdAt: "2026-01-27T13:50:00.000Z", updatedAt: "2026-09-08T11:15:00.000Z", lastRunAt: "2026-09-08T11:15:00.000Z", runCount: 12, pinned: false,
    tags: ["Valsara", "defences"], matterId: MATTERS.valsara,
    notes: "The specification-compliance defence for MF-3 supplied under the DTS-24385 defence qualification. Separate defence-qualified lots from Park supplies.",
  },
  {
    id: "ss_vls_polluter_pays",
    name: "Polluter pays and absolute liability — groundwater remediation",
    query: '("polluter pays" OR "absolute liability") AND (groundwater OR effluent OR remediation)',
    settings: base({ sources: ["caselaw", "statutes", "web"], jurisdiction: "all-india", matterId: MATTERS.valsara, datePreset: "any", order: "date" }),
    ownerId: OWNER, createdAt: "2026-04-30T08:40:00.000Z", updatedAt: "2026-09-05T15:27:00.000Z", lastRunAt: "2026-09-05T15:27:00.000Z", runCount: 8, pinned: false,
    tags: ["Valsara", "environment", "remediation"], matterId: MATTERS.valsara,
  },
  {
    id: "ss_coc_consents_harbor",
    name: "Change-of-control consent / anti-assignment clauses (Delaware)",
    query: '("change of control" OR "anti-assignment") AND (consent OR assignment) AND (merger OR "reverse triangular")',
    settings: base({ sources: ["caselaw", "library"], jurisdiction: "delaware", matterId: MATTERS.harbor, datePreset: "any" }),
    ownerId: OWNER, createdAt: "2026-07-15T12:00:00.000Z", updatedAt: "2026-09-02T10:10:00.000Z", lastRunAt: "2026-09-02T10:10:00.000Z", runCount: 4, pinned: false,
    tags: ["Project Harbor", "M&A"], matterId: MATTERS.harbor,
    notes: "Top-20 customer contracts: does a reverse triangular merger trigger anti-assignment clauses? Meso Scale Diagnostics v. Roche (Del. Ch. 2013).",
  },
  {
    id: "ss_meal_period_rounding",
    name: "Meal-period rounding after Donohue (Cal.)",
    query: '("meal period" OR "meal break") AND rounding AND (Donohue OR "Camp v. Home Depot" OR "See\'s Candy")',
    settings: base({ sources: ["caselaw", "statutes", "library"], jurisdiction: "california-state", matterId: MATTERS.sterling, datePreset: "10y" }),
    ownerId: OWNER, createdAt: "2026-08-24T09:30:00.000Z", updatedAt: "2026-09-17T16:48:00.000Z", lastRunAt: "2026-09-17T16:48:00.000Z", runCount: 3, pinned: false,
    tags: ["Sterling", "wage and hour"], matterId: MATTERS.sterling,
  },
];

// ---- cached example runs (real, verifiable authorities only; anything else carries [VERIFY]) ----

const hit = (h: SearchHit): SearchHit => h;

const wyeth = hit({ id: "caselaw:wyeth-levine", source: "caselaw", title: "Wyeth v. Levine", cite: "555 U.S. 555", citations: ["555 U.S. 555", "129 S. Ct. 1187"], court: "Supreme Court of the United States", courtId: "scotus", date: "2009-03-04", status: "Published", citeCount: 3900, snippet: "Absent clear evidence that the FDA would not have approved a change to Phenergan's label, we will not conclude that it was impossible for Wyeth to comply with both federal and state requirements.", url: "https://www.courtlistener.com/opinion/145906/wyeth-v-levine/", authority: "binding", readRef: { kind: "url", url: "https://www.courtlistener.com/opinion/145906/wyeth-v-levine/" } });
const albrecht = hit({ id: "caselaw:merck-albrecht", source: "caselaw", title: "Merck Sharp & Dohme Corp. v. Albrecht", cite: "587 U.S. 299", citations: ["587 U.S. 299", "139 S. Ct. 1668"], court: "Supreme Court of the United States", courtId: "scotus", date: "2019-05-20", status: "Published", citeCount: 900, snippet: "The question of agency disapproval is primarily one of law for a judge to decide … 'clear evidence' is evidence that shows the court that the drug manufacturer fully informed the FDA of the justifications for the warning required by state law and that the FDA, in turn, informed the drug manufacturer that the FDA would not approve a change.", url: "https://www.courtlistener.com/?q=%22Merck+Sharp+%26+Dohme+Corp.+v.+Albrecht%22", authority: "binding", readRef: { kind: "url", url: "https://www.courtlistener.com/?q=%22Merck+Sharp+%26+Dohme+Corp.+v.+Albrecht%22" } });
const estrada = hit({ id: "caselaw:estrada-royalty", source: "caselaw", title: "Estrada v. Royalty Carpet Mills, Inc.", cite: "15 Cal. 5th 582", citations: ["15 Cal. 5th 582", "541 P.3d 1082"], court: "Supreme Court of California", courtId: "cal", date: "2024-01-18", status: "Published", citeCount: 260, snippet: "Trial courts lack inherent authority to strike PAGA claims on manageability grounds … courts may, where appropriate and within their discretion, use tools such as limiting witness testimony and other evidence, to manage PAGA claims.", url: "https://www.courtlistener.com/?q=%22Estrada+v.+Royalty+Carpet+Mills%22", authority: "binding", readRef: { kind: "url", url: "https://www.courtlistener.com/?q=%22Estrada+v.+Royalty+Carpet+Mills%22" } });
const wesson = hit({ id: "caselaw:wesson-staples", source: "caselaw", title: "Wesson v. Staples the Office Superstore, LLC", cite: "68 Cal. App. 5th 746", citations: ["68 Cal. App. 5th 746"], court: "California Court of Appeal", courtId: "calctapp", date: "2021-09-09", status: "Published", citeCount: 140, snippet: "Trial courts have inherent authority to ensure that PAGA claims can be fairly and efficiently tried and, if necessary, may strike claims that cannot be rendered manageable. [Disapproved by Estrada, 15 Cal. 5th 582 (2024).]", url: "https://www.courtlistener.com/?q=%22Wesson+v.+Staples%22", authority: "binding", readRef: { kind: "url", url: "https://www.courtlistener.com/?q=%22Wesson+v.+Staples%22" } });
const hamilton = hit({ id: "caselaw:hamilton-walmart", source: "caselaw", title: "Hamilton v. Wal-Mart Stores, Inc.", cite: "39 F.4th 575", citations: ["39 F.4th 575"], court: "Court of Appeals for the Ninth Circuit", courtId: "ca9", date: "2022-06-24", status: "Published", citeCount: 60, snippet: "Federal courts may not dismiss PAGA claims for lack of manageability under Rule 23 standards; the district court erred in striking the PAGA claim as unmanageable.", url: "https://www.courtlistener.com/?q=%22Hamilton+v.+Wal-Mart%22+39+F.4th+575", authority: "persuasive", readRef: { kind: "url", url: "https://www.courtlistener.com/?q=%22Hamilton+v.+Wal-Mart%22+39+F.4th+575" } });
const samsHotel = hit({ id: "caselaw:sams-environs", source: "caselaw", title: "SAMS Hotel Group, LLC v. Environs, Inc.", cite: "716 F.3d 432", citations: ["716 F.3d 432"], court: "Court of Appeals for the Seventh Circuit", courtId: "ca7", date: "2013-05-30", status: "Published", citeCount: 45, snippet: "Sophisticated commercial parties may allocate risk through a limitation-of-liability clause capping damages at the contract fee; the clause is enforceable even where the architect's negligence caused the building's demolition.", url: "https://www.courtlistener.com/?q=%22SAMS+Hotel+Group%22+716+F.3d+432", authority: "binding", readRef: { kind: "url", url: "https://www.courtlistener.com/?q=%22SAMS+Hotel+Group%22+716+F.3d+432" } });

const cfr31470 = hit({ id: "regulations:21-314.70", source: "regulations", title: "21 C.F.R. § 314.70 — Supplements and other changes to an approved NDA", subtitle: "Part 314 · Applications for FDA Approval to Market a New Drug", cite: "21 C.F.R. § 314.70", date: "2024-04-01", snippet: "(c)(6)(iii)(A) Changes in the labeling to reflect newly acquired information … to add or strengthen a contraindication, warning, precaution, or adverse reaction for which the evidence of a causal association satisfies the standard for inclusion in the labeling under § 201.57(c).", url: "https://www.ecfr.gov/current/title-40/section-314.70".replace("title-40", "title-21"), cfr: { title: "21", part: "314", section: "314.70", heading: "Supplements and other changes to an approved NDA", effective: "2024-04-01" }, authority: "n/a", readRef: { kind: "cfr", title: 21, section: "314.70" } });
const cfr20157 = hit({ id: "regulations:21-201.57", source: "regulations", title: "21 C.F.R. § 201.57 — Specific requirements on content and format of labeling for human prescription drug and biological products", subtitle: "Part 201 · Labeling", cite: "21 C.F.R. § 201.57", date: "2024-04-01", snippet: "(c)(6)(i) Warnings and precautions … must describe clinically significant adverse reactions … and other potential safety hazards … the labeling must be revised to include a warning about a clinically significant hazard as soon as there is reasonable evidence of a causal association with a drug; a causal relationship need not have been definitely established.", url: "https://www.ecfr.gov/current/title-21/section-201.57", cfr: { title: "21", part: "201", section: "201.57", heading: "Specific requirements on content and format of labeling", effective: "2024-04-01" }, authority: "n/a", readRef: { kind: "cfr", title: 21, section: "201.57" } });



// Valsara v. Meridian (Indian law). Snippets paraphrase the holdings; pinpoints are not asserted (readers open the judgment).
const kailashNath = hit({ id: "caselaw:kailash-nath-dda", source: "caselaw", title: "Kailash Nath Associates v. Delhi Development Authority", cite: "(2015) 4 SCC 136", citations: ["(2015) 4 SCC 136"], court: "Supreme Court of India", courtId: "sci", date: "2015-01-09", status: "Reported", citeCount: 900, snippet: "Section 74 awards reasonable compensation not exceeding the stipulated amount; where the stipulated sum is a genuine pre-estimate, proof of actual loss may be dispensed with, but legal injury remains a sine qua non.", url: "https://indiankanoon.org/search/?formInput=Kailash+Nath+Associates+Delhi+Development+Authority", authority: "binding", readRef: { kind: "url", url: "https://indiankanoon.org/search/?formInput=Kailash+Nath+Associates+Delhi+Development+Authority" } });
const sawPipes = hit({ id: "caselaw:ongc-saw-pipes", source: "caselaw", title: "Oil & Natural Gas Corporation Ltd. v. Saw Pipes Ltd.", cite: "(2003) 5 SCC 705", citations: ["(2003) 5 SCC 705"], court: "Supreme Court of India", courtId: "sci", date: "2003-04-17", status: "Reported", citeCount: 2400, snippet: "Where parties pre-estimate damages for delay, the stipulated sum may be awarded without proof of actual loss where loss is difficult to prove; an award contrary to the substantive law or the contract may be set aside as patently illegal.", url: "https://indiankanoon.org/search/?formInput=ONGC+Saw+Pipes", authority: "binding", readRef: { kind: "url", url: "https://indiankanoon.org/search/?formInput=ONGC+Saw+Pipes" } });
const fatehChand = hit({ id: "caselaw:fateh-chand-balkishan", source: "caselaw", title: "Fateh Chand v. Balkishan Dass", cite: "AIR 1963 SC 1405", citations: ["AIR 1963 SC 1405"], court: "Supreme Court of India", courtId: "sci", date: "1963-01-15", status: "Reported", citeCount: 1100, snippet: "Section 74 dispenses with the distinction between penalties and liquidated damages; the court awards reasonable compensation up to the stipulated sum.", url: "https://indiankanoon.org/search/?formInput=Fateh+Chand+Balkishan+Dass", authority: "binding", readRef: { kind: "url", url: "https://indiankanoon.org/search/?formInput=Fateh+Chand+Balkishan+Dass" } });
const maulaBux = hit({ id: "caselaw:maula-bux-uoi", source: "caselaw", title: "Maula Bux v. Union of India", cite: "(1969) 2 SCC 554", citations: ["(1969) 2 SCC 554"], court: "Supreme Court of India", courtId: "sci", date: "1969-04-25", status: "Reported", citeCount: 700, snippet: "Forfeiture of a deposit is reasonable compensation only where it is a genuine pre-estimate; where loss is capable of proof, the party claiming must prove it.", url: "https://indiankanoon.org/search/?formInput=Maula+Bux+Union+of+India", authority: "binding", readRef: { kind: "url", url: "https://indiankanoon.org/search/?formInput=Maula+Bux+Union+of+India" } });
const cdsDda = hit({ id: "caselaw:construction-design-dda", source: "caselaw", title: "Construction & Design Services v. Delhi Development Authority", cite: "(2015) 14 SCC 263", citations: ["(2015) 14 SCC 263"], court: "Supreme Court of India", courtId: "sci", date: "2015-03-04", status: "Reported", citeCount: 250, snippet: "Where a contract stipulates liquidated damages and loss to a public body is difficult to prove, the court may award reasonable compensation without strict proof of loss.", url: "https://indiankanoon.org/search/?formInput=Construction+Design+Services+Delhi+Development+Authority", authority: "binding", readRef: { kind: "url", url: "https://indiankanoon.org/search/?formInput=Construction+Design+Services+Delhi+Development+Authority" } });
const velloreCitizens = hit({ id: "caselaw:vellore-citizens-uoi", source: "caselaw", title: "Vellore Citizens Welfare Forum v. Union of India", cite: "(1996) 5 SCC 647", citations: ["(1996) 5 SCC 647"], court: "Supreme Court of India", courtId: "sci", date: "1996-08-28", status: "Reported", citeCount: 3100, snippet: "The precautionary principle and the polluter pays principle are part of the environmental law of India; tanneries discharging untreated effluent into groundwater were liable to compensate and to bear remediation costs.", url: "https://indiankanoon.org/search/?formInput=Vellore+Citizens+Welfare+Forum", authority: "binding", readRef: { kind: "url", url: "https://indiankanoon.org/search/?formInput=Vellore+Citizens+Welfare+Forum" } });
const enviroLegal = hit({ id: "caselaw:icela-uoi", source: "caselaw", title: "Indian Council for Enviro-Legal Action v. Union of India", cite: "(1996) 3 SCC 212", citations: ["(1996) 3 SCC 212"], court: "Supreme Court of India", courtId: "sci", date: "1996-02-13", status: "Reported", citeCount: 2200, snippet: "Industries that released toxic sludge contaminating soil and groundwater were liable under the polluter pays principle for the cost of remedial measures, irrespective of fault.", url: "https://indiankanoon.org/search/?formInput=Indian+Council+for+Enviro-Legal+Action", authority: "binding", readRef: { kind: "url", url: "https://indiankanoon.org/search/?formInput=Indian+Council+for+Enviro-Legal+Action" } });
const ica73 = hit({ id: "statutes:ica-1872-s73", source: "statutes", title: "Indian Contract Act, 1872 — Section 73", subtitle: "India Code", cite: "Indian Contract Act, 1872, s. 73", date: "2023-01-01", snippet: "Compensation for loss or damage caused by breach of contract, which naturally arose in the usual course of things or which the parties knew when they contracted to be likely to result from the breach; not for remote and indirect loss.", url: "https://www.indiacode.nic.in/", authority: "binding", readRef: { kind: "url", url: "https://www.indiacode.nic.in/" } });
const ica74 = hit({ id: "statutes:ica-1872-s74", source: "statutes", title: "Indian Contract Act, 1872 — Section 74", subtitle: "India Code", cite: "Indian Contract Act, 1872, s. 74", date: "2023-01-01", snippet: "Where a sum is named in the contract as the amount to be paid in case of breach, the party complaining is entitled, whether or not actual damage is proved, to reasonable compensation not exceeding the amount so named.", url: "https://www.indiacode.nic.in/", authority: "binding", readRef: { kind: "url", url: "https://www.indiacode.nic.in/" } });
const ica124 = hit({ id: "statutes:ica-1872-s124", source: "statutes", title: "Indian Contract Act, 1872 — Section 124", subtitle: "India Code", cite: "Indian Contract Act, 1872, s. 124", date: "2023-01-01", snippet: "A contract by which one party promises to save the other from loss caused to him by the conduct of the promisor himself, or by the conduct of any other person, is a contract of indemnity.", url: "https://www.indiacode.nic.in/", authority: "binding", readRef: { kind: "url", url: "https://www.indiacode.nic.in/" } });
const ica125 = hit({ id: "statutes:ica-1872-s125", source: "statutes", title: "Indian Contract Act, 1872 — Section 125", subtitle: "India Code", cite: "Indian Contract Act, 1872, s. 125", date: "2023-01-01", snippet: "Rights of the indemnity-holder when sued: to recover damages and costs he is compelled to pay, and sums paid under a compromise not contrary to the promisor's orders and otherwise prudent.", url: "https://www.indiacode.nic.in/", authority: "binding", readRef: { kind: "url", url: "https://www.indiacode.nic.in/" } });
const soga15 = hit({ id: "statutes:soga-1930-s15", source: "statutes", title: "Sale of Goods Act, 1930 — Section 15", subtitle: "India Code", cite: "Sale of Goods Act, 1930, s. 15", date: "2023-01-01", snippet: "Where there is a contract for the sale of goods by description, there is an implied condition that the goods shall correspond with the description.", url: "https://www.indiacode.nic.in/", authority: "binding", readRef: { kind: "url", url: "https://www.indiacode.nic.in/" } });
const soga16 = hit({ id: "statutes:soga-1930-s16", source: "statutes", title: "Sale of Goods Act, 1930 — Section 16", subtitle: "India Code", cite: "Sale of Goods Act, 1930, s. 16", date: "2023-01-01", snippet: "Implied conditions as to quality or fitness: where the buyer makes known the particular purpose and relies on the seller's skill or judgment, there is an implied condition that the goods are reasonably fit for that purpose.", url: "https://www.indiacode.nic.in/", authority: "binding", readRef: { kind: "url", url: "https://www.indiacode.nic.in/" } });
const aca26 = hit({ id: "statutes:aca-1996-s26", source: "statutes", title: "Arbitration and Conciliation Act, 1996 — Section 26", subtitle: "India Code", cite: "Arbitration and Conciliation Act, 1996, s. 26", date: "2023-01-01", snippet: "Unless otherwise agreed, the arbitral tribunal may appoint experts to report on specific issues and, if a party requests or the tribunal considers it necessary, the expert shall participate in an oral hearing where the parties may put questions.", url: "https://www.indiacode.nic.in/", authority: "binding", readRef: { kind: "url", url: "https://www.indiacode.nic.in/" } });
const iea45 = hit({ id: "statutes:iea-1872-s45", source: "statutes", title: "Indian Evidence Act, 1872 — Section 45", subtitle: "India Code", cite: "Indian Evidence Act, 1872, s. 45", date: "2023-01-01", snippet: "When the court has to form an opinion upon a point of science or art, the opinions of persons specially skilled in such science or art are relevant facts.", url: "https://www.indiacode.nic.in/", authority: "binding", readRef: { kind: "url", url: "https://www.indiacode.nic.in/" } });
const docketDepo = hit({ id: "dockets:depo-mdl-3140", source: "dockets", title: "In re: Depo-Provera (Depot Medroxyprogesterone Acetate) Products Liability Litigation", subtitle: "District Court, N.D. Florida · No. 3:25-md-03140-MCR-HTC", court: "District Court, N.D. Florida", courtId: "flnd", date: "2025-02-07", status: "Open", snippet: "NOS: 365 Personal Injury: Product Liability · Cause: 28:1332 Diversity-Product Liability", url: "https://www.courtlistener.com/?type=r&q=%223%3A25-md-03140%22", docketNumber: "3:25-md-03140-MCR-HTC", assignedTo: "M. Casey Rodgers", natureOfSuit: "365 Personal Injury: Product Liability", cause: "28:1332 Diversity-Product Liability", parties: ["Pfizer Inc.", "Pharmacia & Upjohn Company LLC", "Greenstone LLC", "Prasco Laboratories"], authority: "persuasive", readRef: { kind: "url", url: "https://www.courtlistener.com/?type=r&q=%223%3A25-md-03140%22" } });

const runs: SearchRun[] = [
  {
    id: "run_seed_vls_ld_01",
    query: '"liquidated damages" AND ("section 74" OR penalty) AND ("reasonable compensation" OR "genuine pre-estimate")',
    settings: base({ sources: ["caselaw", "statutes", "library", "ediscovery"], jurisdiction: "all-india", matterId: MATTERS.valsara, datePreset: "any" }),
    createdAt: "2026-09-18T09:41:12.000Z", durationMs: 7412,
    counts: { caselaw: 15, statutes: 4, library: 4, ediscovery: 8 }, totals: { caselaw: 412, statutes: 4, library: 4, ediscovery: 8 },
    synthesis: `## Answer
Under Section 74 of the Indian Contract Act, 1872 the Claimant can recover no more than reasonable compensation up to the sum named in Clause 9.6; it need not prove the exact quantum where the clause is a genuine pre-estimate and loss is hard to prove, but it must still show legal injury [1][2]. *Kailash Nath* confirms that the named sum is a ceiling, not an automatic entitlement [2].

## Analysis
*Fateh Chand* removed the English distinction between penalties and liquidated damages: the tribunal awards reasonable compensation not exceeding the stated amount [3]. *Saw Pipes* allowed the stipulated sum without proof of actual loss where loss was difficult to prove [4]; *Maula Bux* requires proof where loss is capable of proof [5]. Groundwater remediation costs are capable of proof, which favours the Respondent's position that the Claimant must prove them under Section 73 rather than rely on Clause 9.6 alone [6].

## Jurisdictional caveats
The seat is New Delhi, so challenges to the award lie under Section 34 of the Arbitration and Conciliation Act, 1996; "patent illegality" review of a damages finding is narrow after the 2015 amendment [VERIFY — confirm the current Supreme Court formulation].

## Contrary authority
*Construction & Design Services* awarded compensation without strict proof where the loss was to a public body and hard to quantify [7]. The Claimant will cast the Park's wellfield losses the same way.

## Next steps
- Chart each Clause 9.6 head of loss against the Beacon remediation estimates.
- Build the knowledge timeline from the Hegde and Vasudevan custodial files against the Clause 9.4 notice dates.
- Confirm whether Clause 9.6 is expressed as exclusive of Clause 12 indemnity.

## Sources
[1] Indian Contract Act, 1872, s. 74.
[2] Kailash Nath Associates v. Delhi Development Authority, (2015) 4 SCC 136.
[3] Fateh Chand v. Balkishan Dass, AIR 1963 SC 1405.
[4] Oil & Natural Gas Corporation Ltd. v. Saw Pipes Ltd., (2003) 5 SCC 705.
[5] Maula Bux v. Union of India, (1969) 2 SCC 554.
[6] Indian Contract Act, 1872, s. 73.
[7] Construction & Design Services v. Delhi Development Authority, (2015) 14 SCC 263.`,
    topHits: [ica74, kailashNath, fatehChand, sawPipes, maulaBux, ica73, cdsDda],
    ownerId: OWNER, matterId: MATTERS.valsara, savedSearchId: "ss_vls_liquidated_damages", aiStatus: "ok",
  },
  {
    id: "run_seed_conseq_02",
    query: '"consequential damages" AND (waiver OR exclusion OR "limitation of liability") AND (enforceab* OR unconscionab* OR "fails of its essential purpose")',
    settings: base({ sources: ["caselaw", "statutes", "library"], jurisdiction: "7th-circuit", matterId: MATTERS.northgate }),
    createdAt: "2026-09-15T18:05:40.000Z", durationMs: 5980,
    counts: { caselaw: 15, statutes: 3, library: 2 }, totals: { caselaw: 1287, statutes: 3, library: 2 },
    synthesis: `## Answer
Under Illinois law as applied by the Seventh Circuit, a negotiated consequential-damages waiver between sophisticated commercial parties is presumptively enforceable; it fails only if unconscionable or if a related exclusive remedy "fails of its essential purpose" and the waiver is not independent of that remedy (810 ILCS 5/2-719(2)-(3)) [1][2]. Northgate's best path is not to attack the waiver head-on but to show that the cargo-loss indemnity carve-out in § 9.3 of the MTSA sits outside the waiver.

## Analysis
*SAMS Hotel Group* enforced a limitation-of-liability clause capping damages at the contract fee even though the architect's negligence required demolition of the building; the court emphasized the parties' sophistication and the clause's clarity [1]. Section 2-719(3) makes exclusions of consequential damages enforceable unless unconscionable, and commercial-loss exclusions are prima facie conscionable [2]. Illinois intermediate courts treat the "essential purpose" and "consequential damages" provisions as independent, so a failed repair remedy does not automatically revive consequential damages [VERIFY — Intrastate Piping & Controls, 315 Ill. App. 3d 248 (2000)].

## Jurisdictional caveats
The MTSA's choice-of-law clause selects Illinois; if Apex argues Indiana law (Joliet cross-dock but Indiana-based carrier), the *SAMS* analysis under Indiana law is directly on point and equally unfavorable to a frontal attack.

## Contrary authority
Courts refuse enforcement where the waiver would leave the non-breaching party with no meaningful remedy for willful misconduct or fraud; develop the record on Apex's knowledge of the cross-dock security lapses.

## Next steps
- Chart every damages category in the MSJ against the § 9.3 indemnity language.
- Pull Illinois appellate decisions on the independence of 2-719(2) and (3).
- Confirm whether the cargo-loss claim sounds in bailment, which some courts treat outside UCC Article 2.

## Sources
[1] SAMS Hotel Group, LLC v. Environs, Inc., 716 F.3d 432 (7th Cir. 2013).
[2] 810 ILCS 5/2-719; U.C.C. § 2-719 (statutes).
[3] Intrastate Piping & Controls, Inc. v. Robert-James Sales, Inc., 315 Ill. App. 3d 248 (2000) [VERIFY].`,
    topHits: [samsHotel],
    ownerId: OWNER, matterId: MATTERS.northgate, savedSearchId: "ss_conseq_damages_ca7", aiStatus: "ok",
  },
  {
    id: "run_seed_vls_notice_03",
    query: '("notice clause" OR "duty to notify" OR "condition precedent") AND indemn* AND (waiver OR estoppel)',
    settings: base({ sources: ["statutes", "caselaw", "library", "ediscovery"], jurisdiction: "all-india", matterId: MATTERS.valsara }),
    createdAt: "2026-09-12T13:30:05.000Z", durationMs: 6230,
    counts: { statutes: 4, caselaw: 6, library: 2, ediscovery: 5 }, totals: { statutes: 4, caselaw: 84, library: 2, ediscovery: 5 },
    synthesis: `## Answer
Clause 9.4 is a contractual notice duty, not a statutory one: whether a late or missing notice defeats the Clause 12 indemnity depends on whether the parties made notice a condition precedent. Sections 124 and 125 of the Indian Contract Act, 1872 define the indemnity and the indemnity-holder's rights when sued [1][2].

## Analysis
Section 124 covers loss caused by the promisor's own conduct or that of a third person [1]; Section 125 lets the indemnity-holder recover damages and costs it is compelled to pay [2]. Indian courts have also allowed an indemnity-holder to call on the indemnifier before paying where the liability is absolute [VERIFY — confirm the leading High Court authority before citing].

## Jurisdictional caveats
None: the Indian Contract Act applies uniformly, but the 1998 Agreement's choice of law and the Schedule 6 Notification Protocol control the content of the duty.

## Contrary authority
The Claimant argues that a failure to give the Clause 9.4 notice is itself a breach sounding in damages under Section 73, whether or not it is a condition precedent [3].

## Next steps
- Date-stamp every toxicology study in the custodial set against the Clause 9.4 window.
- Pull the GPCB correspondence files for any copy notice under Schedule 6.
- Consider whether the 2001 draft notice (MFC-0119377) is privileged.

## Sources
[1] Indian Contract Act, 1872, s. 124.
[2] Indian Contract Act, 1872, s. 125.
[3] Indian Contract Act, 1872, s. 73.`,
    topHits: [ica124, ica125, ica73],
    ownerId: OWNER, matterId: MATTERS.valsara, savedSearchId: "ss_vls_notice_clause", aiStatus: "ok",
  },
  {
    id: "run_seed_paga_04",
    query: 'PAGA AND (manageab* OR unmanageab* OR "trial plan") AND (Estrada OR Wesson)',
    settings: base({ sources: ["caselaw", "statutes", "library"], jurisdiction: "california-state", matterId: MATTERS.sterling, datePreset: "5y" }),
    createdAt: "2026-09-19T20:12:33.000Z", durationMs: 4870,
    counts: { caselaw: 12, statutes: 2, library: 3 }, totals: { caselaw: 233, statutes: 2, library: 3 },
    synthesis: `## Answer
California trial courts cannot strike or dismiss a PAGA claim as unmanageable; *Estrada* (Cal. 2024) rejected the inherent-authority rule of *Wesson* [1][2]. Sterling's leverage instead comes from (a) due-process limits on representative proof that *Estrada* expressly preserved, (b) the 2024 PAGA amendments' cure and standing provisions, and (c) the court's power to limit the scope of evidence and witnesses under a trial plan.

## Analysis
*Estrada* holds that manageability is not a ground for striking PAGA claims, but confirms that courts may use case-management tools and that a defendant's due-process rights limit the use of representative testimony [1]. *Wesson* is disapproved to the extent inconsistent [2]. In federal court, *Hamilton* reached the same result under Rule 23 principles, so removal does not change the answer [3]. For the LWDA notice, the 2024 amendments (Labor Code §§ 2699, 2699.3 as amended) create a cure mechanism and cap penalties for employers who take "all reasonable steps" — the immediate priority before the October 21 cure deadline.

## Jurisdictional caveats
Superior Court of California, County of Los Angeles applies *Estrada* directly; complex-court judges commonly require an early trial plan.

## Contrary authority
Pre-*Estrada* decisions striking PAGA claims for unmanageability (*Wesson*) remain citable only for the proposition that trial courts may manage proof.

## Next steps
- Draft the cure notice and "reasonable steps" record (rounding audit, meal-period policy attestations).
- Prepare a trial-plan proposal limiting representative testimony by clinic.
- Model penalty exposure under the amended §§ 2699(f), (g).

## Sources
[1] Estrada v. Royalty Carpet Mills, Inc., 15 Cal. 5th 582 (2024).
[2] Wesson v. Staples the Office Superstore, LLC, 68 Cal. App. 5th 746 (2021), disapproved in part.
[3] Hamilton v. Wal-Mart Stores, Inc., 39 F.4th 575 (9th Cir. 2022).`,
    topHits: [estrada, wesson, hamilton],
    ownerId: OWNER, matterId: MATTERS.sterling, savedSearchId: "ss_paga_manageability", aiStatus: "ok",
  },
  {
    id: "run_seed_dmpa_05",
    query: '(meningioma OR "intracranial tumor") AND (medroxyprogesterone OR DMPA OR "Depo-Provera")',
    settings: base({ sources: ["caselaw", "federal_register", "regulations", "web", "library"], jurisdiction: "11th-circuit", matterId: MATTERS.depo, datePreset: "5y" }),
    createdAt: "2026-09-16T08:22:19.000Z", durationMs: 8110,
    counts: { caselaw: 4, federal_register: 3, regulations: 4, web: 6, library: 2 }, totals: { caselaw: 4, federal_register: 3, regulations: 18, web: 6, library: 2 },
    errors: [{ source: "federal_register", message: "Provider rate limit reached. Retry in a minute or add an API token in Settings.", durationMs: 1204 }],
    synthesis: `## Answer
The MDL's failure-to-warn theory rests on the Roland et al. (BMJ 2024) case-control study reporting a roughly 5.6-fold increased meningioma risk with prolonged medroxyprogesterone acetate use, and on the absence of a U.S. label warning while European labels were updated [4]. Preemption is the leading defense: under *Wyeth* and *Albrecht* the manufacturer must show "clear evidence" that FDA would have rejected a CBE warning, a question of law for the court [1][2].

## Analysis
The CBE regulation lets a sponsor add or strengthen a warning without prior approval when there is "reasonable evidence of a causal association" [3]. Plaintiffs will argue the pre-2024 literature (progestogen receptor expression in meningiomas; French ANSM data on cyproterone and nomegestrol) already met that threshold; defendants will emphasize that DMPA-specific data did not exist before Roland. Whether FDA communicated a labeling position after 2024 is the key document request.

## Jurisdictional caveats
N.D. Fla. sits in the Eleventh Circuit, which applies *Albrecht* strictly and treats the preemption question as one for the judge. Bellwether plaintiffs' home-state law will govern the warning standard and learned-intermediary rules.

## Contrary authority
Plaintiffs rely on *Wyeth*'s statement that FDA approval of a label is not conclusive evidence that a stronger warning could not have been added [1].

## Next steps
- Request FDA correspondence on any post-Roland labeling supplement.
- Retain a neuro-oncology epidemiologist to address confounding in the BMJ study before Science Day.
- Track the master complaint's learned-intermediary allegations by plaintiff state.

## Sources
[1] Wyeth v. Levine, 555 U.S. 555 (2009).
[2] Merck Sharp & Dohme Corp. v. Albrecht, 587 U.S. 299 (2019).
[3] 21 C.F.R. § 314.70(c)(6)(iii)(A); 21 C.F.R. § 201.57(c)(6).
[4] Roland N. et al., Use of progestogens and the risk of intracranial meningioma: national case-control study, BMJ 2024;384:e078078 — https://www.bmj.com/content/384/bmj-2023-078078`,
    topHits: [wyeth, albrecht, cfr31470, cfr20157, docketDepo],
    ownerId: OWNER, matterId: MATTERS.depo, savedSearchId: "ss_meningioma_dmpa", aiStatus: "ok",
  },
  {
    id: "run_seed_vls_spec_06",
    query: '("sale by description" OR "fitness for purpose" OR "merchantable quality") AND (specification OR "particular purpose")',
    settings: base({ sources: ["caselaw", "statutes", "library", "ediscovery"], jurisdiction: "all-india", matterId: MATTERS.valsara }),
    createdAt: "2026-09-08T11:15:48.000Z", durationMs: 6640,
    counts: { caselaw: 9, statutes: 5, library: 3, ediscovery: 6 }, totals: { caselaw: 141, statutes: 5, library: 3, ediscovery: 6 },
    synthesis: `## Question Presented
Whether Meridian can rely on compliance with the DTS-24385 defence qualification as a defence to the Claimant's quality and fitness claims for MF-3 supplied to the Park.

## Short Answer
Only in part. Section 15 of the Sale of Goods Act, 1930 implies that goods sold by description correspond with it [1]; supplies made to the defence specification satisfy that condition. Section 16 implies fitness for a particular purpose only where the buyer made the purpose known and relied on the seller's skill [2], and the Park's purchases were not made to the defence specification.

## Analysis
The defence-qualified lots and the Park supplies must be separated: for defence lots, specification compliance answers the description claim [1]; for Park supplies, the Claimant will argue reliance on Meridian's technical services under the 1998 Agreement [2].

### The record in this matter
Internal documents from the Hegde and Prasad custodial files discussing "known bioaccumulation" (MFC-0038102) will be central to what Meridian knew when it supplied the Park.

## Contrary Authority
The Claimant argues that the Agreement's technical-services obligations displace any reliance on the defence specification. No decision adopting that argument was found among the sources reviewed.

## Open Issues
- Separate defence-qualified and Park lots in the production database.
- Depose the former DQA-T specification officer on what the qualification tested.

## Sources
[1] Sale of Goods Act, 1930, s. 15.
[2] Sale of Goods Act, 1930, s. 16.`,
    topHits: [soga15, soga16],
    ownerId: OWNER, matterId: MATTERS.valsara, savedSearchId: "ss_vls_spec_compliance", aiStatus: "ok",
  },
  {
    id: "run_seed_vls_expert_07",
    query: '"tribunal-appointed expert" AND ("section 26" OR "expert evidence") AND (groundwater OR toxicology)',
    settings: base({ sources: ["caselaw", "statutes", "library"], jurisdiction: "all-india", matterId: MATTERS.valsara, datePreset: "10y", fast: true }),
    createdAt: "2026-09-03T15:02:11.000Z", durationMs: 2210,
    counts: { caselaw: 10, statutes: 2, library: 1 }, totals: { caselaw: 96, statutes: 2, library: 1 },
    synthesis: `## Answer
The tribunal may appoint its own expert under Section 26 of the Arbitration and Conciliation Act, 1996, and either party may require the expert to attend an oral hearing for questioning [1]. Expert opinion on toxicology and hydrogeology is relevant as the opinion of persons specially skilled in a science [2].

## Analysis
Procedural Order No. 4 governs party-appointed experts; the rebuttal reports due November 6 should address dose, study quality and source attribution rather than general hazard.

## Jurisdictional caveats
The tribunal is not bound by the Indian Evidence Act (Section 19 of the 1996 Act), but the parties agreed to apply its principles where convenient [VERIFY — confirm the wording of Procedural Order No. 2].

## Next steps
- Map each Claimant expert opinion to the issues listed in Procedural Order No. 4.
- Commission a dose-response critique from Dr. Sundaram.

## Sources
[1] Arbitration and Conciliation Act, 1996, s. 26.
[2] Indian Evidence Act, 1872, s. 45.`,
    topHits: [aca26, iea45],
    ownerId: OWNER, matterId: MATTERS.valsara, aiStatus: "ok",
  },
  {
    id: "run_seed_vls_polluter_08",
    query: '("polluter pays" OR "absolute liability") AND (groundwater OR effluent OR remediation)',
    settings: base({ sources: ["caselaw", "statutes", "web"], jurisdiction: "all-india", matterId: MATTERS.valsara, datePreset: "any", order: "date" }),
    createdAt: "2026-09-05T15:27:52.000Z", durationMs: 5320,
    counts: { caselaw: 8, statutes: 2, web: 0 }, totals: { caselaw: 140, statutes: 2, web: 0 },
    errors: [{ source: "web", message: "OpenAI web search requires OPENAI_API_KEY.", durationMs: 12 }],
    synthesis: undefined,
    topHits: [velloreCitizens, enviroLegal],
    ownerId: OWNER, matterId: MATTERS.valsara, savedSearchId: "ss_vls_polluter_pays", aiStatus: "no_api_key",
  },
];

// ---- threads derived from the cached runs (one turn each) --------------------

const norm = (s: string) => s.replace(/\s+/g, " ").replace(/\s*\.\s*/g, ".").trim().toLowerCase();

/** Map "[n]" numbers in a seeded synthesis' Sources section onto the run's hits (by cite, then by title prefix). */
export function citeMapFromSynthesis(synthesis: string | undefined, hits: SearchHit[]): Record<number, string> {
  const out: Record<number, string> = {};
  if (!synthesis) return out;
  const tail = synthesis.split(/^## Sources\s*$/m)[1] ?? "";
  for (const m of tail.matchAll(/^\[(\d{1,2})\]\s+(.+)$/gm)) {
    const n = Number(m[1]);
    const line = norm(m[2]);
    const hit = hits.find((h) => (h.cite && line.includes(norm(h.cite))) || (h.edoc?.bates && line.includes(norm(h.edoc.bates)))) ?? hits.find((h) => line.includes(norm(h.title).slice(0, 24)));
    if (hit && !Object.values(out).includes(hit.id)) out[n] = hit.id;
  }
  return out;
}

const SEED_LANE = "lane_seed";

/** Planner sub-questions for seeded boolean queries (the deterministic planner phrases natural-language questions). */
const SEED_SUBQUESTIONS: Record<string, string[]> = {
  run_seed_vls_spec_06: [
    "What implied conditions does the Sale of Goods Act, 1930 attach to a sale by description and to fitness for purpose?",
    "Does compliance with a buyer's or a third party's specification answer a fitness-for-purpose claim?",
    "Which supplies in this matter were made to the defence specification, and which to the Park?",
    "What does the record in the Valsara matter show on what Meridian knew at the time of supply?",
  ],
};

function threadFromRun(r: SearchRun, index: number): { thread: ResearchThread; run: SearchRun } {
  const hits = r.topHits ?? [];
  const citeMap = citeMapFromSynthesis(r.synthesis, hits);
  const nOf = new Map(Object.entries(citeMap).map(([n, id]) => [id, Number(n)] as const));
  const sources: ResearchSource[] = hits.map((h, i): ResearchSource => { const s = { ...sourceFromHit(h, SEED_LANE, new Date(r.createdAt).getTime() + i * 400), read: true, chars: 18_000 + i * 2_300, readMs: 900 + i * 210, cached: i % 2 === 0, excerpt: h.snippet, n: nOf.get(h.id) }; return { ...s, currentness: currentnessOf(s, new Date(r.createdAt).getTime()) }; });
  const verifyMarks = (r.synthesis?.match(/\[VERIFY/g) ?? []).length;
  const cited = Object.keys(citeMap).length;
  const hasAnswer = Boolean(r.synthesis);
  const artifactHash = hasAnswer ? answerHash(r.synthesis ?? "") : undefined;
  // Seeded verdicts bind to the seeded answer text, exactly as a live run's would (constitution §23).
  const verification = hasAnswer ? { status: (verifyMarks ? "partially-verified" : "verified") as "verified" | "partially-verified", supported: cited + 2, unsupported: verifyMarks, contradicted: 0, score: Number(((cited + 2) / (cited + 2 + verifyMarks)).toFixed(2)), checkedAt: r.createdAt, artifactHash, pass: 1 } : undefined;
  const stats = { sources: sources.length, read: sources.length, rounds: 1, agents: hasAnswer ? 4 : 2, durationMs: r.durationMs };
  const provenance = hasAnswer ? { ...makeProvenance({ surface: "research", sources: toProvenanceSources(sources.filter((s) => s.n != null)), confidence: verification?.score }), generatedAt: r.createdAt, verification: verification ? { status: verification.status, checkedAt: verification.checkedAt, supported: verification.supported, unsupported: verification.unsupported, contradicted: verification.contradicted, method: "claims" as const } : undefined } : undefined;
  const j = jurisdictionByKey(r.settings.jurisdiction).label.split(" (")[0];
  const followUps = hasAnswer ? [`What is the strongest contrary authority in the ${j} on this question?`, r.matterId ? "How does the record in this matter (documents and depositions) bear on the analysis?" : "Which statutes or regulations change the analysis?", "What standard applies at the motion-to-dismiss versus summary-judgment stage?"] : [];
  const requestedAt = new Date(r.createdAt).getTime();
  const metrics: RunMetrics = { requestedAt, acknowledgedMs: 12, firstEvidenceMs: Math.round(r.durationMs * 0.18), firstReadMs: Math.round(r.durationMs * 0.31), firstModelTokenMs: hasAnswer ? Math.round(r.durationMs * 0.52) : null, firstSourceBackedMs: hasAnswer ? Math.round(r.durationMs * 0.58) : null, finalAnswerMs: hasAnswer ? Math.round(r.durationMs * 0.93) : null, verifiedAnswerMs: hasAnswer ? Math.round(r.durationMs * 0.9) : null, totalMs: r.durationMs, toolTimeMs: Math.round(r.durationMs * 0.6), modelTimeMs: hasAnswer ? Math.round(r.durationMs * 0.7) : 0, toolCalls: sources.length + 2, modelCalls: hasAnswer ? 4 : 0, queueWaitMs: 0, tokens: { input: hasAnswer ? 18_400 + sources.length * 900 : 0, output: hasAnswer ? 2_100 : 0, total: hasAnswer ? 20_500 + sources.length * 900 : 0, reportedCalls: hasAnswer ? 4 : 0 } };
  const answer: ResearchMessage = {
    id: `msg_seed_${index}_a`, role: "assistant", content: r.synthesis ?? "", createdAt: r.createdAt, runId: r.id, stats, verification: verification ? { ...verification, verdicts: [] } : undefined, provenance, banner: r.aiStatus === "no_api_key" ? "no-api-key" : null, followUps, citeMap,
    lanes: [{ id: SEED_LANE, name: "Controlling authority", kind: "controlling", status: "done", sources: sources.length, read: sources.length, durationMs: r.durationMs, round: 1 }],
    artifactHash, artifactVersion: hasAnswer ? 1 : undefined, metrics, mode: r.settings.fast ? "fast" : "deep",
    subQuestions: hasAnswer ? SEED_SUBQUESTIONS[r.id] ?? (/\b(AND|OR|NOT)\b|"/.test(r.query) ? undefined : planSubQuestions({ question: r.query, settings: r.settings, mode: r.settings.fast ? "fast" : "deep", hasMatter: Boolean(r.matterId) })) : undefined,
    terminal: hasAnswer ? (verifyMarks ? "partial" : "succeeded") : "partial",
    stop: hasAnswer ? "coverage_sufficient" : "hard_limit",
    failure: hasAnswer ? undefined : "not_configured",
    failureMessage: hasAnswer ? (verifyMarks ? `${verifyMarks} statement${verifyMarks === 1 ? "" : "s"} could not be matched to a source read in this run and ${verifyMarks === 1 ? "is" : "are"} marked [VERIFY]` : undefined) : "No model provider was configured when this run happened; the lanes retrieved and read sources but no answer was written",
    coverage: hasAnswer ? { complete: !verifyMarks, reason: verifyMarks ? `${verifyMarks} claim${verifyMarks === 1 ? "" : "s"} marked [VERIFY] by the synthesis` : `coverage adequate: ${sources.length} sources, ${sources.length} read`, gaps: [] } : undefined,
  };
  answer.trust = hasAnswer ? messageTrustState(answer, sources) : "generated";
  const threadId = `thr_seed_${r.id.replace(/^run_seed_/, "")}`;
  const thread: ResearchThread = {
    id: threadId,
    title: r.query.length > 72 ? r.query.slice(0, 71).trimEnd() + "…" : r.query,
    matterId: r.matterId ?? null,
    settings: r.settings,
    ownerId: r.ownerId,
    createdAt: r.createdAt,
    updatedAt: r.createdAt,
    messages: [{ id: `msg_seed_${index}_u`, role: "user", content: r.query, createdAt: r.createdAt }, answer],
    sources,
    pins: [],
    runIds: [r.id],
  };
  const run: SearchRun = { ...r, threadId, mode: answer.mode, stats, verification: verification ? { status: verification.status, supported: verification.supported, unsupported: verification.unsupported, contradicted: verification.contradicted, score: verification.score, checkedAt: verification.checkedAt } : undefined, provenance, banner: r.aiStatus === "no_api_key" ? undefined : undefined, followUps, sources, terminal: answer.terminal, stop: answer.stop, failure: answer.failure, metrics, artifactHash, trust: answer.trust };
  return { thread, run };
}

/** search module seed: saved searches, cached example runs and their threads (idempotent, stable ids). */
export function seedSearch(db: Database) {
  const derived = runs.map((r, i) => threadFromRun(r, i));
  db.collection<SavedSearch>("search_saved").putMany(savedSearches);
  db.collection<SearchRun>("search_runs").putMany(derived.map((d) => d.run));
  db.collection<ResearchThread>("search_threads").putMany(derived.map((d) => d.thread));
}

export const SEARCH_SEED_IDS = { savedSearches: savedSearches.map((s) => s.id), runs: runs.map((r) => r.id), threads: runs.map((r) => `thr_seed_${r.id.replace(/^run_seed_/, "")}`) };
