import type { CodingDecision, DocType } from "@/lib/types/domain";
import { DEMO_ID as D, type DocSpec } from "./doc-spec";
import type { SourceKey } from "./people";

/**
 * Routine case-record documents for Com.O.S. No. 1187 of 2023, generated deterministically: weekly status reports,
 * support-desk tickets, meeting notices and routine commercial mails. Most are unmarked and part of the first-pass
 * review; some are uncoded so the review queue has work in it.
 */

const R = "p_demo_in_sai_kiran_reddy";
const T = "2026-09-14T12:00:00Z";

interface Gen { source: SourceKey; date: string; type: DocType; subject: string; from?: string; to?: string[]; body: string; issues?: string[]; coded?: boolean; responsive?: boolean; score: number }

const WEEKS: [string, string, string][] = [
  ["2022-10-07", "Green", "Build 1.8 delivered; store master data received for 11 stores (dependency D-3 due 15.10.2022)."],
  ["2022-10-14", "Amber", "Master data for 19 stores only; e-invoicing integration (CR-07) in development."],
  ["2022-10-21", "Amber", "D-3 overdue by 6 days; UAT of pilot stores started with partial data."],
  ["2022-10-28", "Amber", "D-3 overdue by 13 days; 27 stores' price and tax masters awaited."],
  ["2022-11-04", "Red", "UAT cannot close without complete master data; pilot date at risk."],
  ["2022-11-11", "Red", "Notice under clause 11.4 sent (09.11.2022); M3 and M4 dates move day for day."],
  ["2022-11-18", "Red", "Master data for 4 more stores received; 23 awaited."],
  ["2022-11-25", "Amber", "UAT cycles 1 and 2 complete for 23 stores; 31 defects open (0 Sev-1)."],
  ["2022-12-02", "Amber", "Pilot expected to slip by about six weeks; revised plan to follow."],
  ["2022-12-09", "Amber", "UAT cycle 3; 17 Sev-3 defects open."],
  ["2022-12-16", "Amber", "14 Sev-3 open; customer to sign off UAT to unblock pilot."],
  ["2023-01-13", "Green", "Complete master data received on 12.01.2023; pilot proposed for 06.02.2023."],
  ["2023-02-10", "Green", "Pilot live in 6 stores since 06.02.2023; 3 Sev-3 open."],
  ["2023-03-10", "Green", "Rollout waves 1–3 complete (28 stores)."],
  ["2023-03-24", "Amber", "Ugadi week incidents: Hubballi ISP outage (22.03), Mysuru sync-agent restart (24.03)."],
  ["2023-04-07", "Green", "Release 2.4.1 deployed 04.04.2023 (sync-agent memory leak fixed); 46 stores stable."],
];

const TICKETS: [string, string, string, boolean][] = [
  ["2023-02-09", "Mysuru", "Slow SKU search at counter 3 (SAN-219)", false],
  ["2023-02-15", "Udupi", "Receipt printer paper-size setting", false],
  ["2023-02-21", "Davanagere", "Loyalty points rounding on returns (SAN-211)", false],
  ["2023-03-03", "Jayanagar", "Credit note printed twice (SAN-224)", false],
  ["2023-03-14", "Tumakuru", "New store onboarding — cashier logins", false],
  ["2023-03-22", "Hubballi", "Billing down — store internet line failure, ISP ticket 88213", true],
  ["2023-03-24", "Mysuru", "Billing paused 45 minutes — sync agent restart", true],
  ["2023-03-28", "Davanagere", "Billing paused 30 minutes — sync agent restart", true],
  ["2023-04-02", "Udupi", "Billing paused 20 minutes — sync agent restart", true],
];

function gens(): Gen[] {
  const out: Gen[] = [];
  for (const [date, rag, note] of WEEKS) out.push({ source: "plaintiff", date, type: "Report", subject: `Weekly status report — Project Sankalp — week ending ${date.split("-").reverse().join(".")}`, from: "Arjun Shetty", to: ["Harish Kumar Patil", "Raghavendra S. Bhat"], body: `WEEKLY STATUS REPORT — Project Sankalp\nOverall status: ${rag}\n${note}\nNext week: continue UAT / rollout as per plan.`, issues: /D-3|master data|11\.4|slip/i.test(note) ? ["DLY-01"] : /Ugadi|sync|outage/i.test(note) ? ["DEF-01"] : [], coded: date < "2023-01-01", responsive: true, score: /D-3|master data|slip|Ugadi/i.test(note) ? 74 : 48 });
  for (const [date, store, what, outage] of TICKETS) out.push({ source: "plaintiff", date, type: "Note", subject: `Support ticket — ${store} — ${what}`, from: "Deepa Nagaraj", body: `SUPPORT DESK TICKET\nStore: ${store}\nOpened: ${date.split("-").reverse().join(".")}\nSummary: ${what}\nStatus: resolved${outage ? "\nImpact: billing interruption (see incident log)" : ""}`, issues: outage ? ["DEF-01"] : [], coded: !outage, responsive: outage, score: outage ? 79 : 22 });
  const misc: Gen[] = [
    { source: "plaintiff", date: "2022-04-30", type: "Other", subject: "Tax invoice INV/2022-23/102 — Milestone M1 (Design)", body: "TAX INVOICE INV/2022-23/102 dated 30.04.2022. Milestone M1 (Design): ₹42,00,000; IGST 18%: ₹7,56,000; total ₹49,56,000. Paid on 30.05.2022.", issues: ["DUE-01"], coded: true, responsive: true, score: 52 },
    { source: "plaintiff", date: "2022-06-15", type: "Email", subject: "Design sign-off — M1", from: "Harish Kumar Patil", to: ["Arjun Shetty"], body: "Arjun, design documents for Sankalp are approved. Please proceed to build.", issues: ["ACC-01"], coded: true, responsive: true, score: 55 },
    { source: "plaintiff", date: "2022-10-18", type: "Email", subject: "Meeting notice — Sankalp steering committee, 20.10.2022", from: "Arjun Shetty", to: ["Harish Kumar Patil", "Lalitha Gowda", "Raghavendra S. Bhat"], body: "Agenda: 1. D-3 store master data status; 2. CR-07 e-invoicing; 3. UAT plan.", issues: ["DLY-01"], coded: false, responsive: true, score: 61 },
    { source: "plaintiff", date: "2023-01-09", type: "Email", subject: "Diwali and Sankranti freeze windows for store deployments", from: "Harish Kumar Patil", to: ["Arjun Shetty"], body: "No deployments to stores between 12.01 and 16.01 (Sankranti sale). Please plan the pilot after that.", coded: false, score: 34 },
    { source: "plaintiff", date: "2023-02-20", type: "Email", subject: "Rollout wave plan — 40 remaining stores in 4 waves", from: "Arjun Shetty", to: ["Harish Kumar Patil", "Lalitha Gowda"], body: "Wave 1: 10 stores (Bengaluru), 06.03; Wave 2: 12 stores (Mysuru region), 13.03; Wave 3: 10 stores (north Karnataka), 20.03; Wave 4: 8 stores, 27.03. Freeze on 22.03 (Ugadi) respected.", issues: [], coded: true, responsive: true, score: 45 },
    { source: "plaintiff", date: "2023-03-17", type: "Email", subject: "Ugadi readiness — store network checklist", from: "Deepa Nagaraj", to: ["Harish Kumar Patil"], body: "Harish, please ask stores to confirm backup 4G dongles are available for billing counters during Ugadi, as the leased lines at Hubballi and Davanagere dropped twice last month. Offline billing mode is available on all counters.", issues: ["DEF-01"], coded: false, responsive: true, score: 81 },
    { source: "plaintiff", date: "2023-04-04", type: "Email", subject: "Release 2.4.1 deployed — sync agent fix", from: "Arjun Shetty", to: ["Harish Kumar Patil"], body: "2.4.1 is live in all 46 stores. It fixes the sync-agent memory leak behind the 24.03, 28.03 and 02.04 pauses.", issues: ["DEF-01"], coded: false, responsive: true, score: 77 },
    { source: "plaintiff", date: "2023-04-25", type: "Email", subject: "Stabilisation items — status", from: "Arjun Shetty", to: ["Lalitha Gowda"], body: "All 9 stabilisation items shared on 03.04 are closed. No Sev-1 incidents since 04.04.2023.", issues: ["ACC-01"], coded: false, responsive: true, score: 72 },
    { source: "defendant", date: "2023-03-25", type: "Email", subject: "Ugadi week — store feedback summary", from: "Lalitha Gowda", to: ["Harish Kumar Patil", "Pradeep Shenoy"], body: "Summary for the board: Hubballi and Mysuru billing issues during Ugadi. Hubballi also had its internet line down that morning per the store team. Need a clear root cause before we write to Nimbus.", issues: ["DEF-01"], coded: false, responsive: true, score: 83 },
    { source: "defendant", date: "2023-04-06", type: "Email", subject: "Payment to Nimbus this week", from: "Pradeep Shenoy", to: ["Lalitha Gowda"], body: "Releasing ₹60 lakh to Nimbus on Wednesday as committed. Balance to be discussed after stabilisation.", issues: ["ACK-01", "DUE-01"], coded: false, responsive: true, score: 86 },
  ];
  return [...out, ...misc];
}

export function buildGeneratedSpecs(): DocSpec[] {
  return gens().map((g, i) => {
    const coding: Partial<CodingDecision> = g.coded ? { responsive: g.responsive ?? false, issues: g.issues ?? [], reviewerId: R, reviewedAt: T } : { issues: [] };
    return {
      id: D(`g${String(i + 1).padStart(3, "0")}`),
      source: g.source,
      date: g.date,
      type: g.type,
      subject: g.subject,
      ...(g.from ? { from: g.from } : {}),
      ...(g.to ? { to: g.to } : {}),
      body: g.body,
      aiScore: g.score,
      coding,
      india: { docClass: g.type === "Email" ? "correspondence" : "document", filedBy: g.source === "defendant" ? "defendant" : "plaintiff" },
    };
  });
}
