/**
 * The three demo matters. Courts are real (from the court registry / focus-city forum list); the parties, case
 * facts, officials and every document are FICTIONAL, and no judge is named. Hearing dates are relative to the load
 * time so the matters always look current; historical case facts are fixed.
 */
import type { MatterRecord } from "@/modules/matters/types";
import { DEMO_MATTERS, DEMO_TEAM } from "../ids";
import { businessDay, type DemoBuildContext } from "./context";

export type DemoMatter = MatterRecord & { meta?: Record<string, unknown> };

export const DEMO_COMMERCIAL_NUMBER = "IN-BLR-2023-014";
export const DEMO_WRIT_NUMBER = "IN-HYD-2026-031";
export const DEMO_BAIL_NUMBER = "IN-HYD-2026-032";

export function buildDemoMatters(ctx: DemoBuildContext): DemoMatter[] {
  const at = ctx.now.toISOString();
  const day = (n: number) => businessDay(ctx.now, n);
  const meta = { demo: "india-blr-hyd", synthetic: true };
  const checked = ctx.now.toISOString();
  return [
    {
      id: DEMO_MATTERS.commercial,
      slug: "demo-nimbus-v-tungabhadra",
      number: DEMO_COMMERCIAL_NUMBER,
      name: "Nimbus Cloudworks Pvt. Ltd. v. Tungabhadra Retail Solutions Pvt. Ltd. — DEMO",
      shortName: "Nimbus v. Tungabhadra",
      caption: "Com.O.S. No. 1187 of 2023 · Commercial Court, Bengaluru · demonstration data",
      client: "Nimbus Cloudworks Private Limited (fictional)",
      clientSide: "plaintiff",
      practiceArea: "Commercial",
      court: "Commercial Court, Bengaluru",
      jurisdiction: "Karnataka · High Court of Karnataka",
      judge: "Presiding Officer (not named in demo data)",
      status: "active",
      stage: "Arguments",
      openedAt: "2023-05-08",
      teamIds: [ctx.ownerId, DEMO_TEAM.junior, DEMO_TEAM.clerk],
      leadAttorneyId: ctx.ownerId,
      description:
        "Commercial suit for ₹3,09,33,690 (balance price of Project Sankalp, a cloud billing and inventory platform for the defendant's 46 stores, with interest at 18% p.a. under the MSA). Defence: conditional UAT sign-off, pilot delay (liquidated damages) and Ugadi-week billing outages; counter-claim ₹1,16,44,000. Evidence closed: PW-1 and DW-1 examined; Ex.P1–P25, Ex.D1–D18. Parties, documents and testimony are synthetic demonstration data.",
      keyDates: [
        { label: "Suit instituted", date: "2023-08-29" },
        { label: "Issues framed", date: "2024-04-22" },
        { label: "PW-1 cross-examination", date: "2024-07-15" },
        { label: "DW-1 cross-examination", date: "2025-01-20" },
        { label: "Written arguments to be filed", date: day(6) },
        { label: "Further arguments", date: day(9) },
      ],
      tags: ["demo", "commercial suit", "Commercial Courts Act", "Bengaluru"],
      india: { courtId: "ka-blr-commercial", caseType: "Com.O.S.", caseNumber: "1187", caseYear: 2023, cnr: "KABC020118712023", courtHall: "Court Hall 4 (demo)", nextHearing: day(9), lastHearing: "2026-08-24", hearingPurpose: "Arguments", causeList: { status: "unknown", checkedAt: checked, source: "manual" } },
      createdAt: at,
      updatedAt: at,
      createdById: ctx.ownerId,
      meta,
    },
    {
      id: DEMO_MATTERS.writ,
      slug: "demo-sarojini-devi-v-state-of-telangana",
      number: DEMO_WRIT_NUMBER,
      name: "Kondapalli Sarojini Devi v. State of Telangana and another — DEMO",
      shortName: "Sarojini Devi (W.P. 18234/2026)",
      caption: "W.P. No. 18234 of 2026 · High Court for the State of Telangana · demonstration data",
      client: "Smt. Kondapalli Sarojini Devi (fictional)",
      clientSide: "petitioner",
      practiceArea: "Real Estate",
      court: "High Court for the State of Telangana",
      jurisdiction: "Telangana",
      judge: "Not named in demo data",
      status: "active",
      stage: "Notice / counter filed",
      openedAt: "2026-07-25",
      teamIds: [ctx.ownerId, DEMO_TEAM.clerk],
      leadAttorneyId: ctx.ownerId,
      description:
        "Writ petition under Article 226 against a seven-day demolition notice (in Telugu) issued by a fictional municipality alleging construction within the FTL buffer of a tank, without survey records or a hearing; the house was built under a 2019 building permission with an Irrigation NOC. Interim status-quo order of 31.07.2026. The municipality's own survey report (12.08.2026) places the building about 38 m from the FTL. Synthetic demonstration data; the municipality and all persons are fictional.",
      keyDates: [
        { label: "Impugned notice", date: "2026-07-21" },
        { label: "Status quo ordered", date: "2026-07-31" },
        { label: "Counter-affidavit filed", date: "2026-09-02" },
        { label: "Reply affidavit due", date: day(4) },
        { label: "Next hearing", date: day(12) },
      ],
      tags: ["demo", "writ", "Article 226", "municipal", "Hyderabad", "Telugu"],
      india: { courtId: "hc-telangana", benchId: "ts-hyderabad", caseType: "W.P.", caseNumber: "18234", caseYear: 2026, cnr: "HBHC010182342026", nextHearing: day(12), lastHearing: "2026-09-02", hearingPurpose: "Reply and hearing on interim relief", causeList: { status: "not_listed", checkedAt: checked, source: "manual" } },
      createdAt: at,
      updatedAt: at,
      createdById: ctx.ownerId,
      meta,
    },
    {
      id: DEMO_MATTERS.bail,
      slug: "demo-ravi-teja-v-state-of-telangana",
      number: DEMO_BAIL_NUMBER,
      name: "Kondapalli Ravi Teja v. State of Telangana (regular bail) — DEMO",
      shortName: "Ravi Teja bail (Crl.P. 7710/2026)",
      caption: "Crl.P. No. 7710 of 2026 · High Court for the State of Telangana · demonstration data",
      client: "Kondapalli Ravi Teja (fictional)",
      clientSide: "petitioner",
      practiceArea: "Litigation",
      court: "High Court for the State of Telangana",
      jurisdiction: "Telangana",
      judge: "Not named in demo data",
      status: "active",
      stage: "Bail",
      openedAt: "2026-09-05",
      teamIds: [ctx.ownerId, DEMO_TEAM.clerk],
      leadAttorneyId: ctx.ownerId,
      description:
        "Petition under s.483 BNSS for regular bail in Crime No. 612 of 2026 (BNS ss.132, 121(1), 351(2)), arising from the municipal survey of 12.08.2026 at the writ petitioner's house. Offence date 12.08.2026 — after 1 July 2024, so the BNS and BNSS govern. In custody since 13.08.2026; Sessions Court rejected bail on 04.09.2026. The survey report records an objection and an argument, not an assault. Synthetic demonstration data.",
      keyDates: [
        { label: "Offence (as alleged)", date: "2026-08-12" },
        { label: "Arrest", date: "2026-08-13" },
        { label: "Sessions Court rejected bail", date: "2026-09-04" },
        { label: "Hearing", date: day(3) },
      ],
      tags: ["demo", "bail", "BNSS", "criminal", "Hyderabad"],
      india: { courtId: "hc-telangana", benchId: "ts-hyderabad", caseType: "Crl.P.", caseNumber: "7710", caseYear: 2026, cnr: "HBHC010077102026", nextHearing: day(3), lastHearing: "2026-09-15", hearingPurpose: "Hearing on bail (counter of the State awaited)", offenceDate: "2026-08-12", causeList: { status: "listed", item: 37, listDate: day(3), checkedAt: checked, source: "manual" } },
      createdAt: at,
      updatedAt: at,
      createdById: ctx.ownerId,
      meta,
    },
  ];
}
