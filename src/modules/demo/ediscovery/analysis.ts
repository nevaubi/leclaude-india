import type { Conflict, Relationship, TimelineEvent } from "@/lib/types/domain";
import type { IndiaEDocument } from "@/modules/ediscovery/india";
import { DEMO_TEAM } from "../ids";
import { cite, row, type DocIndex, type IndiaDeposition } from "./depo-helpers";
import { MB, MC, MW, PEOPLE, SOURCES, tagged } from "./people";

/**
 * Chronology, relationships and conflicts for the demo matters. Every source resolves against the built corpus and
 * the parsed depositions: documents by id with their exhibit mark or reference, testimony by the row that contains a
 * quoted phrase (so page:line cites come from the parsed sheet), and excerpts must be verbatim in the document.
 */

export interface AnalysisContext {
  ix: DocIndex;
  pw1: IndiaDeposition;
  dw1: IndiaDeposition;
}

const P = (k: keyof typeof PEOPLE) => PEOPLE[k].id;

/** Exact excerpt from a document (throws when the phrase is not in the text). */
function quote(d: IndiaEDocument, phrase: string): string {
  if (!d.text.includes(phrase)) throw new Error(`demo analysis: "${phrase.slice(0, 40)}…" is not in ${d.id}`);
  return phrase;
}

type Src = TimelineEvent["sources"][number];

export function buildTimeline(ctx: AnalysisContext): TimelineEvent[] {
  const { ix, pw1, dw1 } = ctx;
  const doc = (slug: string, phrase?: string): Src => { const d = ix.doc(slug); return { kind: "document", id: d.id, bates: d.india?.exhibit ?? d.bates, ...(phrase ? { excerpt: quote(d, phrase) } : {}) }; };
  const depo = (dep: IndiaDeposition, phrase: string): Src => { const r = row(dep, phrase); return { kind: "deposition", id: dep.id, cite: cite(dep, phrase), excerpt: r.qa.answer.slice(0, 220) }; };
  let n = 0;
  const ev = (matterId: string, date: string, title: string, category: TimelineEvent["category"], significance: TimelineEvent["significance"], sources: Src[], extra: Partial<TimelineEvent> = {}): TimelineEvent => {
    n += 1;
    return tagged<TimelineEvent>({ id: `demo_in_tl_${String(n).padStart(3, "0")}`, matterId, date, title, category, significance, sources, createdBy: "user", verified: true, ...extra });
  };
  return [
    ev(MC, "2022-02-14", "MSA and SOW-1 signed: ₹4.2 crore fixed price in five milestones", "corporate", 3, [doc("p02", "Amounts not paid when due carry interest at eighteen per cent (18%) per annum"), doc("p03")], { personIds: [P("bhat"), P("patil")] }),
    ev(MC, "2022-09-26", "CR-07: pilot date 15.12.2022 made subject to store master data by 15.10.2022", "corporate", 4, [doc("p05", "subject to receipt of complete store master data by 15.10.2022")], { personIds: [P("shetty"), P("patil")] }),
    ev(MC, "2022-11-09", "Plaintiff gives clause 11.4 notice: master data for only 19 of 46 stores", "communication", 4, [doc("p08", "Please treat this as notice under clause 11.4 of the MSA"), depo(dw1, "As per Ex.D8, on 12.01.2023.")], { personIds: [P("shetty"), P("patil")] }),
    ev(MC, "2022-11-30", "M3 invoice INV/2022-23/131 raised (₹1,23,90,000)", "corporate", 2, [doc("p07")]),
    ev(MC, "2022-12-02", "PW-1 warns the pilot will slip about six weeks", "communication", 4, [doc("d01", "the pilot go-live will slip by about six weeks"), depo(pw1, "It is true that in Ex.D1 I informed the Defendant")], { personIds: [P("bhat"), P("patil")], disputed: true, description: "Relied on by the defendant for LD; PW-1 attributes the slip to the missing master data (Ex.D1 itself says so)." }),
    ev(MC, "2022-12-21", "UAT sign-off by DW-1, subject to closure of 14 Sev-3 defects", "communication", 5, [doc("p09", "subject to closure of the 14 open Sev-3 defects listed in the defect log before rollout"), depo(dw1, "It is true that Ex.P9 UAT sign-off e-mail was sent by me."), depo(dw1, "was not a final acceptance")], { personIds: [P("patil"), P("shetty")], disputed: true, description: `Admitted at ${cite(dw1, "It is true that Ex.P9 UAT sign-off e-mail was sent by me.")}; qualified on further cross at ${cite(dw1, "was not a final acceptance")} as 'not a final acceptance'. Both passages are preserved.` }),
    ev(MC, "2022-12-22", "DW-1's internal mail: sign-off 'only to unblock the pilot' (not sent to the plaintiff)", "communication", 4, [doc("d06", "only to unblock the pilot"), depo(dw1, "Ex.D6 was an internal e-mail")], { personIds: [P("patil"), P("gowda")] }),
    ev(MC, "2023-01-12", "Complete store master data received — 89 days after the CR-07 date", "corporate", 4, [doc("n03", "89 days after the CR-07 date"), doc("d08", "complete set received on 12.01.2023")], { personIds: [P("shetty")] }),
    ev(MC, "2023-02-06", "Pilot live in six stores", "product", 3, [doc("p10", "The platform went live in the six pilot stores on 06.02.2023")]),
    ev(MC, "2023-02-14", "Defendant invokes LD of ₹2,94,000 for the 53-day pilot delay", "corporate", 3, [doc("d03", "We hereby invoke clause 11.2 of the MSA")], { personIds: [P("gowda")] }),
    ev(MC, "2023-03-22", "Ugadi: Hubballi billing interrupted — 75 minutes (plaintiff) v. 3½ hours (defendant)", "product", 5, [doc("p12", "Outage window: 10:05 to 11:20 (75 minutes)"), doc("d11"), doc("p16"), depo(pw1, "It is false to suggest that billing at Hubballi was down till 1.30 p.m.")], { personIds: [P("deepa"), P("kulkarni")], disputed: true }),
    ev(MC, "2023-03-31", "COO confirms all 46 stores billing on Sankalp; M5 invoice raised", "communication", 5, [doc("p13", "all 46 stores are now billing on Sankalp as of today"), doc("p15")], { personIds: [P("gowda"), P("bhat")] }),
    ev(MC, "2023-04-04", "Release 2.4.1 fixes the sync-agent defect behind three short pauses", "product", 3, [doc("d05", "fixed in release 2.4.1 on 04.04.2023")], { personIds: [P("joshi")] }),
    ev(MC, "2023-04-05", "Defendant's CFO acknowledges the M3 and M4 invoices are due", "communication", 5, [doc("p14", "We acknowledge that the M3 and M4 invoices are due."), depo(dw1, "It is true that in Ex.P14 our CFO has stated that the M3 and M4 invoices are due.")], { personIds: [P("shenoy"), P("menon")], description: "Written acknowledgement relevant to limitation (Limitation Act s.18); DW-1 calls it a courtesy (chief ¶9)." }),
    ev(MC, "2023-04-11", "COO withholds M5 acceptance pending 30 days without a Sev-1 incident", "communication", 4, [doc("d12", "acceptance of M5 is withheld")], { personIds: [P("gowda")], disputed: true }),
    ev(MC, "2023-04-12", "Part payment of ₹60,00,000 received", "corporate", 3, [doc("p20", "₹60,00,000.00")], { personIds: [P("menon")] }),
    ev(MC, "2023-05-18", "Legal notice for ₹2,86,92,000 with 18% interest", "litigation", 3, [doc("p17"), doc("p18")]),
    ev(MC, "2023-08-14", "Section 12A mediation closed as a non-starter", "litigation", 2, [doc("p21", "The mediation is closed as a non-starter on 14.08.2023.")]),
    ev(MC, "2023-08-29", "Com.O.S. No. 1187 of 2023 instituted", "litigation", 3, [doc("rec_plaint")]),
    ev(MC, "2023-12-18", "Written statement and counter-claim of ₹1,16,44,000", "litigation", 3, [doc("rec_ws")]),
    ev(MC, "2024-04-22", "Issues framed", "litigation", 3, [doc("rec_issues")]),
    ev(MC, "2024-07-15", "PW-1 examined; Ex.P1–P25 marked; cross-examination begins", "testimony", 4, [doc("rec_os_2024_07_15"), depo(pw1, "It is true that the pilot went live only on 06.02.2023.")], { personIds: [P("bhat")] }),
    ev(MC, "2025-01-20", "DW-1 examined; Ex.D3, D5–D18 marked; admits sending the UAT sign-off", "testimony", 4, [doc("rec_os_2025_01_20"), depo(dw1, "It is true that after Ex.P9 the pilot went live in six stores.")], { personIds: [P("patil")] }),
    ev(MC, "2025-02-17", "DW-1 further cross: sign-off 'not a final acceptance'; all 14 defects closed before rollout", "testimony", 4, [depo(dw1, "was not a final acceptance"), depo(dw1, "It is true that all 14 defects listed in Ex.D2 were closed before the rollout.")], { personIds: [P("patil")], disputed: true }),
    // Hyderabad
    ev(MW, "2019-07-03", "Building permission BP/2019/0412 with Irrigation NOC (outside FTL and buffer)", "regulatory", 4, [doc("w_permit", "the plot lies outside the FTL and buffer of Peddacheruvu")], { personIds: [P("sarojini")] }),
    ev(MW, "2026-07-21", "Municipality's notice: remove the building within seven days (Telugu)", "regulatory", 5, [doc("w_notice_te"), doc("w_notice_en", "You shall remove the structure yourself within seven days")], { personIds: [P("sarojini"), P("commissioner")] }),
    ev(MW, "2026-07-24", "Representation seeking survey records and a hearing — unanswered", "communication", 3, [doc("w_representation", "I request copies of the survey records and a personal hearing")], { personIds: [P("sarojini")] }),
    ev(MW, "2026-07-31", "High Court orders status quo; joint survey only with notice to the petitioner", "litigation", 5, [doc("w_interim", "the parties shall maintain status quo")]),
    ev(MW, "2026-08-12", "Survey visit: building ~38 m from the FTL; son objects; survey incomplete", "regulatory", 5, [doc("w_survey_te"), doc("w_survey_en", "The building is about 38 metres from the FTL boundary.")], { personIds: [P("raviteja"), P("supervisor")] }),
    ev(MB, "2026-08-12", "FIR Crime No. 612 of 2026 under BNS ss.132, 121(1), 351(2) (offence after 1 July 2024)", "litigation", 4, [doc("b_fir", "Sections: 132, 121(1) and 351(2) of the Bharatiya Nyaya Sanhita, 2023.")], { personIds: [P("raviteja"), P("supervisor")], disputed: true }),
    ev(MB, "2026-08-13", "Ravi Teja arrested and remanded to judicial custody", "litigation", 3, [doc("b_remand", "was arrested on 13.08.2026")], { personIds: [P("raviteja")] }),
    ev(MB, "2026-09-04", "Sessions Court rejects bail with liberty to renew after charge sheet", "litigation", 3, [doc("b_sessions_order")]),
    ev(MB, "2026-09-10", "Crl.P. No. 7710 of 2026 filed under s.483 BNSS", "litigation", 3, [doc("b_petition")]),
  ];
}

export function buildRelationships(ctx: AnalysisContext): Relationship[] {
  const { ix, pw1, dw1 } = ctx;
  const ev = (slug: string, excerpt?: string) => { const d = ix.doc(slug); return { bates: d.india?.exhibit ?? d.bates, docId: d.id, excerpt: excerpt ? quote(d, excerpt) : d.subject }; };
  const tv = (dep: IndiaDeposition, phrase: string) => ({ excerpt: `${cite(dep, phrase)}: ${row(dep, phrase).qa.answer.slice(0, 140)}` });
  const rel = (slug: string, matterId: string, fromId: string, toId: string, kind: Relationship["kind"], weight: number, label?: string, evidence?: Relationship["evidence"]): Relationship =>
    tagged<Relationship>({ id: `demo_in_rel_${slug}`, matterId, fromId, toId, kind, weight, ...(label ? { label } : {}), ...(evidence ? { evidence } : {}) });
  return [
    rel("c01", MC, P("shetty"), P("bhat"), "reports_to", 3, "Project Manager → VP (Delivery), Nimbus", [ev("n03")]),
    rel("c02", MC, P("deepa"), P("shetty"), "reports_to", 2, "Field support → Project Manager", [ev("p16")]),
    rel("c03", MC, P("patil"), P("gowda"), "reports_to", 3, "Head of IT → COO, Tungabhadra", [ev("d06")]),
    rel("c04", MC, P("kulkarni"), P("gowda"), "reports_to", 2, "Store Manager, Hubballi → COO", [ev("d11")]),
    rel("c05", MC, P("patil"), P("shetty"), "emailed", 4, "UAT sign-off (Ex.P9); master data notices (Ex.P8)", [ev("p09"), ev("p08")]),
    rel("c06", MC, P("shenoy"), P("menon"), "emailed", 3, "Acknowledgement of dues (Ex.P14)", [ev("p14", "We acknowledge that the M3 and M4 invoices are due.")]),
    rel("c07", MC, P("gowda"), P("bhat"), "emailed", 3, "Rollout confirmation (Ex.P13) and M5 acceptance withheld (Ex.D12)", [ev("p13"), ev("d12")]),
    rel("c08", MC, P("murthy"), P("patil"), "represents", 2, "Advocate for the defendant"),
    rel("c09", MC, DEMO_TEAM.junior, P("bhat"), "represents", 3, "Advocate for the plaintiff (conducted cross of DW-1)"),
    rel("c10", MC, P("joshi"), P("gowda"), "retained", 2, "Independent audit for the defendant (Ex.D5)", [ev("d05")]),
    rel("c11", MC, P("bhat"), P("patil"), "testified_about", 3, "Slip attributed to master data", [tv(pw1, "Witness volunteers that the slip was due to the Defendant's delay")]),
    rel("c12", MC, P("patil"), P("shenoy"), "testified_about", 3, "Admits CFO's statement that invoices are due", [tv(dw1, "It is true that in Ex.P14 our CFO has stated that the M3 and M4 invoices are due.")]),
    rel("h01", MW, P("commissioner"), P("sarojini"), "other", 3, "Demolition notice (Telugu) and survey", [ev("w_notice_te"), ev("w_survey_te")]),
    rel("h02", MB, P("supervisor"), P("raviteja"), "other", 3, "De facto complainant v. accused", [ev("b_fir")]),
    rel("h03", MB, P("raviteja"), P("sarojini"), "other", 2, "Son of the writ petitioner; resides at Plot No. 27", [ev("b_sureties")]),
  ];
}

export function buildConflicts(ctx: AnalysisContext): Conflict[] {
  const { ix, pw1, dw1 } = ctx;
  type Side = Conflict["sides"][number];
  const depo = (label: string, dep: IndiaDeposition, phrase: string): Side => ({ label, sourceKind: "deposition", sourceId: dep.id, cite: cite(dep, phrase), excerpt: row(dep, phrase).qa.answer });
  const doc = (label: string, slug: string, phrase: string): Side => { const d = ix.doc(slug); return { label, sourceKind: "document", sourceId: d.id, cite: d.india?.exhibit ?? d.bates, excerpt: quote(d, phrase) }; };
  const cf = (n: number, matterId: string, c: Omit<Conflict, "id" | "matterId" | "createdBy">): Conflict => tagged<Conflict>({ id: `demo_in_cf_${String(n).padStart(2, "0")}`, matterId, createdBy: "user", ...c });
  return [
    cf(1, MC, {
      kind: "position_inconsistency", severity: "high", status: "open",
      title: "DW-1 admits sending the UAT sign-off Ex.P9 and that the pilot proceeded on it, then qualifies it as 'not a final acceptance'",
      sides: [depo("DW-1, cross 20.01.2025", dw1, "It is true that Ex.P9 UAT sign-off e-mail was sent by me."), depo("DW-1, cross 20.01.2025", dw1, "It is true that after Ex.P9 the pilot went live in six stores."), depo("DW-1, further cross 17.02.2025", dw1, "was not a final acceptance")],
      analysis: `Late qualification by the same witness. Neither passage supersedes the other; any digest must cite both. The qualification rests on Ex.D6, an internal mail never sent to the plaintiff (${cite(dw1, "Ex.D6 was an internal e-mail")}), and DW-1 concedes all 14 defects were closed before rollout (${cite(dw1, "It is true that all 14 defects listed in Ex.D2 were closed before the rollout.")}) — the condition in Ex.P9 was met. Clause 9.3 also deems acceptance on production use.`,
    }),
    cf(2, MC, {
      kind: "testimony_vs_document", severity: "high", status: "open",
      title: "PW-1 chief ¶7: all milestones within the agreed timelines v. his own e-mail Ex.D1 (pilot to slip about six weeks)",
      sides: [depo("PW-1, chief affidavit", pw1, "All milestones were delivered within the timelines agreed in Ex.P3"), doc("Ex.D1, 02.12.2022", "d01", "the pilot go-live will slip by about six weeks"), depo("PW-1, cross", pw1, "The timelines were as revised under clause 11.4 of the MSA")],
      analysis: "The chief affidavit overstates. PW-1's explanation (clause 11.4 revision) is supported by Ex.P5, Ex.P8 and the minutes Ex.D8, and Ex.D1 itself cites the missing master data. Argue the revised-timeline construction; do not defend the unqualified statement in ¶7.",
    }),
    cf(3, MC, {
      kind: "document_vs_document", severity: "high", status: "open",
      title: "Hubballi outage on 22.03.2023: 10:05–11:20 (Ex.P12, Ex.P16) v. 10:00–13:30 (Ex.D11, Ex.D7)",
      sides: [doc("Incident report Ex.P12", "p12", "Outage window: 10:05 to 11:20 (75 minutes)"), doc("Store manager's letter Ex.D11 (Kannada original)", "d11", "ಬೆಳಿಗ್ಗೆ 10 ಗಂಟೆಯಿಂದ ಮಧ್ಯಾಹ್ನ 1.30 ರವರೆಗೆ"), doc("Downtime report Ex.D7", "d07", "Hubballi, 22.03.2023: 10:00 to 13:30 (210 minutes)")],
      analysis: `Ex.D7 takes its Hubballi entry from Ex.D11 and DW-1 did not verify it (${cite(dw1, "I did not personally verify the timings at Hubballi.")}). The plaintiff's timeline is contemporaneous (WhatsApp Ex.P16, in Kannada — the original is the text of record, the translation is filed separately) and the auditor Ex.D5 ties 8 of 11 interruptions to store network outages. The defendant's own COO noted the Hubballi line was down (unmarked mail of 25.03.2023).`,
    }),
    cf(4, MC, {
      kind: "testimony_vs_document", severity: "high", status: "open",
      title: "DW-1 chief ¶9: CFO's e-mail was a 'commercial courtesy' v. Ex.P14 ('We acknowledge that the M3 and M4 invoices are due') and part payment",
      sides: [depo("DW-1, chief affidavit", dw1, "was a commercial courtesy to maintain the relationship"), doc("Ex.P14, 05.04.2023", "p14", "We acknowledge that the M3 and M4 invoices are due."), depo("DW-1, cross", dw1, "It is true that the Defendant paid Rs. 60 lakh on 12.04.2023 after Ex.P14.")],
      analysis: "The words of Ex.P14 are an unqualified written acknowledgement, followed by payment of the promised ₹60 lakh a week later (Ex.P20). Relevant to Issue 1 and to limitation (s.18 and s.19 of the Limitation Act) — verify the computation with the limitation engine before arguing it.",
    }),
    cf(5, MC, {
      kind: "document_vs_document", severity: "medium", status: "open",
      title: "COO confirms 46 stores live (Ex.P13, 31.03.2023) v. M5 acceptance withheld (Ex.D12, 11.04.2023)",
      sides: [doc("Ex.P13", "p13", "all 46 stores are now billing on Sankalp as of today"), doc("Ex.D12", "d12", "acceptance of M5 is withheld until the platform runs for 30 days without a Sev-1 incident")],
      analysis: `The 30-day condition appears for the first time in Ex.D12, after production use began; clause 9.3 of the MSA treats production use as acceptance. DW-1 admits Ex.P13 (${cite(dw1, "our Chief Operating Officer confirmed that all 46 stores were billing")}).`,
    }),
    cf(6, MC, {
      kind: "testimony_vs_testimony", severity: "medium", status: "open",
      title: "PW-1: pilot slip caused by master data v. DW-1: the pilot was not delayed only by master data",
      sides: [depo("PW-1, cross", pw1, "Witness volunteers that the slip was due to the Defendant's delay in providing store master data"), depo("DW-1, cross", dw1, "It is false to suggest that the pilot was delayed only because of the Defendant's late master data.")],
      analysis: `DW-1 could not remember when master data was provided (${cite(dw1, "I do not remember the exact date.")}) and accepted 12.01.2023 from Ex.D8. The go-live followed within 25 days of complete data. Clause 11.4 extends milestones day for day for customer delay.`,
    }),
    cf(7, MB, {
      kind: "document_vs_document", severity: "high", status: "open",
      title: "FIR: accused hit the supervisor with a stick v. survey report of the same supervisor: 'objected … there was an argument'",
      sides: [doc("FIR, Crime No. 612 of 2026", "b_fir", "hit him on the left forearm with a wooden stick"), doc("Survey report, 12.08.2026 (Telugu original, Annexure-7)", "b_survey_te", "కొలతలకు అభ్యంతరం చెప్పారు; వాగ్వాదం జరిగింది"), doc("Survey report — translation (Annexure-7A)", "b_survey_en", "The house owner's son objected to the measurements saying that no prior notice had been given; there was an argument.")],
      analysis: "The survey report, authored by the complainant the same morning, records an objection and an argument but no assault. The wound certificate records a simple contusion examined at 14:10. The survey itself was conducted without the notice the High Court required on 31.07.2026. Strong ground for bail; also relevant to the writ (contempt / violation of status quo).",
    }),
    cf(8, MW, {
      kind: "document_vs_document", severity: "high", status: "open",
      title: "Notice: building within the FTL buffer v. survey report: building about 38 m from the FTL boundary",
      sides: [doc("Notice (translation)", "w_notice_en", "your building has been constructed within the Full Tank Level (FTL) buffer zone of Peddacheruvu"), doc("Survey report (translation)", "w_survey_en", "The building is about 38 metres from the FTL boundary."), doc("Building permission", "w_permit", "the plot lies outside the FTL and buffer of Peddacheruvu")],
      analysis: "The municipality's own survey places the building about 38 m from the FTL line; whether that is inside the buffer depends on the applicable buffer width and the revised FTL map relied on in the counter-affidavit — both to be verified from the notified map before the hearing. The notice itself annexes no survey.",
    }),
  ];
}

export { SOURCES };
