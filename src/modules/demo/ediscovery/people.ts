import type { Person } from "@/lib/types/domain";
import { DEMO_MATTERS, DEMO_PACK, DEMO_SOURCES, DEMO_TEAM } from "../ids";

/**
 * People of the India demonstration matters. Every name here is FICTIONAL: company officers, witnesses, advocates on
 * the other side, the store manager, the municipal officials (named only by office) and the accused are invented for
 * the demo and never stand for real people. No judge is named anywhere in the pack.
 */

export const MC = DEMO_MATTERS.commercial;
export const MW = DEMO_MATTERS.writ;
export const MB = DEMO_MATTERS.bail;

/** Tag stored on every demo record. */
export const DEMO_META = { demo: DEMO_PACK, synthetic: true } as const;
export type DemoMeta = { demo: typeof DEMO_PACK; synthetic: true; [k: string]: unknown };

/** Adds the demo tag to a record (the shared domain types that lack `meta` still round-trip it through the db). */
export function tagged<T extends object>(x: T, extra: Record<string, unknown> = {}): T & { meta: DemoMeta } {
  const prev = (x as { meta?: Record<string, unknown> }).meta ?? {};
  return { ...x, meta: { ...prev, ...extra, ...DEMO_META } };
}

export const PLAINTIFF = "Nimbus Cloudworks Private Limited";
export const DEFENDANT = "Tungabhadra Retail Solutions Private Limited";
export const PETITIONER = "Smt. Kondapalli Sarojini Devi";
export const MUNICIPALITY = "Chandrayanagiri Municipality (fictional)";

export interface DemoPerson { key: string; id: string; name: string; title: string; org: string; email?: string; role: Person["role"]; matter: string; tags?: string[] }

const NCW = "Nimbus Cloudworks Pvt. Ltd. (fictional)";
const TRS = "Tungabhadra Retail Solutions Pvt. Ltd. (fictional)";

/** People by key (ids are stable; emails use reserved example domains). */
export const PEOPLE = {
  // Commercial suit — plaintiff side
  bhat: { key: "bhat", id: "demo_in_p_raghavendra_bhat", name: "Raghavendra S. Bhat", title: "Vice President (Delivery)", org: NCW, email: "raghavendra.bhat@nimbuscloud.example", role: "witness", matter: MC, tags: ["PW-1"] },
  menon: { key: "menon", id: "demo_in_p_nisha_menon", name: "Nisha Menon", title: "Chief Financial Officer", org: NCW, email: "nisha.menon@nimbuscloud.example", role: "client", matter: MC },
  shetty: { key: "shetty", id: "demo_in_p_arjun_shetty", name: "Arjun Shetty", title: "Project Manager, Project Sankalp", org: NCW, email: "arjun.shetty@nimbuscloud.example", role: "custodian", matter: MC },
  deepa: { key: "deepa", id: "demo_in_p_deepa_nagaraj", name: "Deepa Nagaraj", title: "Field Support Engineer", org: NCW, email: "deepa.nagaraj@nimbuscloud.example", role: "custodian", matter: MC },
  // Commercial suit — defendant side
  patil: { key: "patil", id: "demo_in_p_harish_patil", name: "Harish Kumar Patil", title: "Head of IT", org: TRS, email: "harish.patil@tungabhadraretail.example", role: "witness", matter: MC, tags: ["DW-1"] },
  shenoy: { key: "shenoy", id: "demo_in_p_pradeep_shenoy", name: "Pradeep Shenoy", title: "Chief Financial Officer", org: TRS, email: "pradeep.shenoy@tungabhadraretail.example", role: "witness", matter: MC },
  gowda: { key: "gowda", id: "demo_in_p_lalitha_gowda", name: "Lalitha Gowda", title: "Chief Operating Officer", org: TRS, email: "lalitha.gowda@tungabhadraretail.example", role: "witness", matter: MC },
  kulkarni: { key: "kulkarni", id: "demo_in_p_mahesh_kulkarni", name: "Mahesh Kulkarni", title: "Store Manager, Hubballi", org: TRS, role: "witness", matter: MC },
  joshi: { key: "joshi", id: "demo_in_p_rohit_joshi", name: "Rohit Joshi", title: "Lead Auditor, Kaveri QA Labs LLP (fictional)", org: "Kaveri QA Labs LLP (fictional)", role: "expert", matter: MC },
  murthy: { key: "murthy", id: "demo_in_p_venkatesh_murthy", name: "S. Venkatesh Murthy", title: "Advocate for the defendant", org: "Murthy & Associates, Advocates (fictional)", email: "svm@murthyassociates.example", role: "opposing", matter: MC, tags: ["advocate"] },
  // Writ and bail — Hyderabad
  sarojini: { key: "sarojini", id: "demo_in_p_sarojini_devi", name: "Kondapalli Sarojini Devi", title: "Petitioner (owner, Plot No. 27)", org: "—", role: "client", matter: MW },
  raviteja: { key: "raviteja", id: "demo_in_p_ravi_teja", name: "Kondapalli Ravi Teja", title: "Petitioner / Accused No. 1 (son of the writ petitioner)", org: "—", role: "client", matter: MB },
  commissioner: { key: "commissioner", id: "demo_in_p_commissioner", name: "Commissioner, Chandrayanagiri Municipality", title: "Respondent No. 2 (office, fictional body)", org: MUNICIPALITY, role: "opposing", matter: MW },
  supervisor: { key: "supervisor", id: "demo_in_p_survey_supervisor", name: "B. Narsimha", title: "Town Planning Supervisor (de facto complainant)", org: MUNICIPALITY, role: "witness", matter: MB },
  gp: { key: "gp", id: "demo_in_p_gp_municipal", name: "Standing Counsel for the Municipality", title: "Standing counsel (office)", org: MUNICIPALITY, role: "opposing", matter: MW },
  pp: { key: "pp", id: "demo_in_p_public_prosecutor", name: "Public Prosecutor, High Court for the State of Telangana", title: "Public Prosecutor (office)", org: "State of Telangana", role: "opposing", matter: MB },
} as const satisfies Record<string, DemoPerson>;
export type PersonKey = keyof typeof PEOPLE;

export const ALL_PEOPLE: DemoPerson[] = Object.values(PEOPLE);

/** Display name → person (exact names used in headers and testimony). */
export const BY_NAME = new Map<string, DemoPerson>(ALL_PEOPLE.map((p) => [p.name, p]));

/** Email address for a header name (unknown names are printed as given). */
export function addr(name: string): string {
  const p = BY_NAME.get(name);
  return p?.email ? `${name} <${p.email}>` : name;
}

/** Sources (the party whose record a document comes from), stored as custodians of the case record. */
export const SOURCES = {
  plaintiff: { id: DEMO_SOURCES.plaintiff, name: "Nimbus Cloudworks (plaintiff's documents)", matter: MC },
  defendant: { id: DEMO_SOURCES.defendant, name: "Tungabhadra Retail (defendant's documents)", matter: MC },
  courtCom: { id: DEMO_SOURCES.courtCom, name: "Court record — Com.O.S. 1187/2023", matter: MC },
  petitioner: { id: DEMO_SOURCES.petitioner, name: "Petitioner's documents", matter: MW },
  municipality: { id: DEMO_SOURCES.municipality, name: "Municipality's documents (served on the petitioner)", matter: MW },
  courtHyd: { id: DEMO_SOURCES.courtHyd, name: "Court record — High Court for the State of Telangana", matter: MW },
  prosecution: { id: DEMO_SOURCES.prosecution, name: "Prosecution papers (FIR, remand, orders)", matter: MB },
} as const;
export type SourceKey = keyof typeof SOURCES;

/** Our advocates in the demo (the firm's two demo members; the owner leads). */
export const OUR_JUNIOR = "Kavya Hegde";
export const OUR_CLERK = "Sai Kiran Reddy";
export const REVIEWER = { junior: DEMO_TEAM.junior, clerk: DEMO_TEAM.clerk } as const;

/** Person records for the matters: witnesses, officers, advocates, offices and the case-record sources. */
export function buildPeople(): Person[] {
  const people = ALL_PEOPLE.map((p) => tagged<Person>({ id: p.id, name: p.name, email: p.email, title: p.title, organization: p.org, role: p.role, tags: [...(p.tags ?? []), "demo"] }));
  const sources = Object.values(SOURCES).map((s) => tagged<Person>({ id: s.id, name: s.name, title: "Case-record source", organization: "Case record", role: "custodian", tags: ["demo", "record source"] }));
  return [...people, ...sources];
}
