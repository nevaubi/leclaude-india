/**
 * Court registry for LeClaude India (client-safe: no server imports).
 *
 * Codes follow the eCourts convention used by the open judgment datasets: `<stateCode>_<courtNo>` in S3 paths
 * (`court=29_3`) and `<stateCode>~<courtNo>` in metadata (`"court_code": "29~3"`). The dataset code is the join key
 * between ingested judgments and this registry; a code that is not in the registry is ingested as `unknown_court`
 * and never mapped to the nearest court (constitution §23: no evidence substitution).
 *
 * Focus jurisdictions: Karnataka (Bengaluru) and Telangana (Hyderabad), plus Andhra Pradesh, whose High Court sat
 * at Hyderabad until 1 January 2019 and now sits at Amaravati. Andhra Pradesh High Court judgments from before
 * 2019 were delivered at Hyderabad and are persuasive authority in both states.
 */

export type CourtLevel = "supreme" | "high" | "district" | "tribunal";

export type StateCode =
  | "JK" | "HP" | "PB" | "HR" | "CH" | "UK" | "DL" | "RJ" | "UP" | "BR" | "SK" | "MN" | "TR" | "ML" | "AS" | "WB" | "JH" | "OD"
  | "CG" | "MP" | "GJ" | "MH" | "GA" | "AP" | "KA" | "KL" | "TN" | "PY" | "TS" | "AR" | "NL" | "MZ" | "LA" | "IN";

export interface Bench {
  id: string;
  name: string;
  city: string;
  /** Bench folder name in the High Court dataset (`bench=karhcdharwad`). */
  datasetBench?: string;
  principal?: boolean;
}

export interface Court {
  id: string;
  name: string;
  shortName: string;
  level: CourtLevel;
  /** States whose courts are bound by this court's decisions (the Supreme Court binds all courts: Art. 141). */
  territory: StateCode[];
  seat: string;
  benches: Bench[];
  /** Dataset join key, `<state>_<court>` as in the S3 path. */
  datasetCode?: string;
  /** Prefix of neutral citations issued by the court, e.g. "INSC", "KHC", "TSHC", "APHC". */
  neutralCitationPrefix?: string;
  /** Prefix of CNR numbers (eCourts case numbers), e.g. "KAHC". */
  cnrPrefix?: string;
  /** Primary regional language of the state (for judgments, translations and client material). */
  languages: string[];
  focus?: boolean;
  established?: string;
  notes?: string;
}

export const SUPREME_COURT: Court = {
  id: "sci",
  name: "Supreme Court of India",
  shortName: "SC",
  level: "supreme",
  territory: ["IN"],
  seat: "New Delhi",
  benches: [{ id: "sci-delhi", name: "Supreme Court of India", city: "New Delhi", principal: true }],
  neutralCitationPrefix: "INSC",
  languages: ["en", "hi"],
  established: "1950-01-28",
};

export const HIGH_COURTS: Court[] = [
  {
    id: "hc-karnataka", name: "High Court of Karnataka", shortName: "Kar HC", level: "high", territory: ["KA"], seat: "Bengaluru",
    datasetCode: "29_3", neutralCitationPrefix: "KHC", cnrPrefix: "KAHC", languages: ["kn", "en"], focus: true,
    benches: [
      { id: "kar-bengaluru", name: "Principal Bench", city: "Bengaluru", datasetBench: "karnataka_bng_old", principal: true },
      { id: "kar-dharwad", name: "Dharwad Bench", city: "Dharwad", datasetBench: "karhcdharwad" },
      { id: "kar-kalaburagi", name: "Kalaburagi Bench", city: "Kalaburagi", datasetBench: "karhckalaburagi" },
    ],
    notes: "Neutral citations: 2024:KHC:NNNN (Bengaluru), 2024:KHC-D:NNNN (Dharwad), 2024:KHC-K:NNNN (Kalaburagi). Dataset bench names other than Dharwad are verified at ingest.",
  },
  {
    id: "hc-telangana", name: "High Court for the State of Telangana", shortName: "TS HC", level: "high", territory: ["TS"], seat: "Hyderabad",
    datasetCode: "36_29", neutralCitationPrefix: "TSHC", cnrPrefix: "HBHC", languages: ["te", "ur", "en"], focus: true, established: "2019-01-01",
    benches: [{ id: "ts-hyderabad", name: "Principal Seat", city: "Hyderabad", datasetBench: "taphc", principal: true }],
    notes: "Successor at Hyderabad to the High Court of Judicature at Hyderabad for Telangana and Andhra Pradesh (2014-2018) and the High Court of Andhra Pradesh at Hyderabad (1956-2014). The dataset bench name 'taphc' reflects that history.",
  },
  {
    id: "hc-andhra", name: "High Court of Andhra Pradesh", shortName: "AP HC", level: "high", territory: ["AP"], seat: "Amaravati",
    datasetCode: "28_2", neutralCitationPrefix: "APHC", cnrPrefix: "APHC", languages: ["te", "en"], focus: true, established: "2019-01-01",
    benches: [{ id: "ap-amaravati", name: "Principal Seat", city: "Amaravati", datasetBench: "aphc", principal: true }],
  },
  { id: "hc-jk", name: "High Court of Jammu & Kashmir and Ladakh", shortName: "J&K HC", level: "high", territory: ["JK", "LA"], seat: "Srinagar/Jammu", datasetCode: "1_12", languages: ["ur", "en"], benches: [] },
  { id: "hc-hp", name: "High Court of Himachal Pradesh", shortName: "HP HC", level: "high", territory: ["HP"], seat: "Shimla", datasetCode: "2_5", languages: ["hi", "en"], benches: [] },
  { id: "hc-ph", name: "High Court of Punjab and Haryana", shortName: "P&H HC", level: "high", territory: ["PB", "HR", "CH"], seat: "Chandigarh", datasetCode: "3_22", languages: ["pa", "hi", "en"], benches: [{ id: "ph-chandigarh", name: "Principal Seat", city: "Chandigarh", principal: true }] },
  { id: "hc-uttarakhand", name: "High Court of Uttarakhand", shortName: "Utk HC", level: "high", territory: ["UK"], seat: "Nainital", datasetCode: "5_15", languages: ["hi", "en"], benches: [] },
  { id: "hc-delhi", name: "High Court of Delhi", shortName: "Del HC", level: "high", territory: ["DL"], seat: "New Delhi", datasetCode: "7_26", neutralCitationPrefix: "DHC", languages: ["hi", "en"], benches: [{ id: "del-new-delhi", name: "Principal Seat", city: "New Delhi", principal: true }] },
  { id: "hc-rajasthan", name: "High Court of Rajasthan", shortName: "Raj HC", level: "high", territory: ["RJ"], seat: "Jodhpur", datasetCode: "8_9", languages: ["hi", "en"],
    // Jaipur Bench: confirmed on eCourts High Court services ("High Court Bench at Jaipur"), checked 2026-10-01.
    benches: [{ id: "raj-jodhpur", name: "Principal Seat", city: "Jodhpur", principal: true }, { id: "raj-jaipur", name: "Jaipur Bench", city: "Jaipur" }] },
  { id: "hc-allahabad", name: "High Court of Judicature at Allahabad", shortName: "All HC", level: "high", territory: ["UP"], seat: "Prayagraj", datasetCode: "9_13", neutralCitationPrefix: "AHC", languages: ["hi", "en"],
    // Lucknow Bench: allahabadhighcourt.in (cause list / case status "Lucknow Bench"), checked 2026-10-01.
    benches: [{ id: "all-prayagraj", name: "Principal Seat", city: "Prayagraj", principal: true }, { id: "all-lucknow", name: "Lucknow Bench", city: "Lucknow" }] },
  { id: "hc-patna", name: "High Court of Patna", shortName: "Pat HC", level: "high", territory: ["BR"], seat: "Patna", datasetCode: "10_8", languages: ["hi", "en"], benches: [] },
  { id: "hc-sikkim", name: "High Court of Sikkim", shortName: "Sik HC", level: "high", territory: ["SK"], seat: "Gangtok", datasetCode: "11_24", languages: ["en"], benches: [] },
  { id: "hc-manipur", name: "High Court of Manipur", shortName: "Man HC", level: "high", territory: ["MN"], seat: "Imphal", datasetCode: "14_25", languages: ["en"], benches: [] },
  { id: "hc-tripura", name: "High Court of Tripura", shortName: "Tri HC", level: "high", territory: ["TR"], seat: "Agartala", datasetCode: "16_20", languages: ["bn", "en"], benches: [] },
  { id: "hc-meghalaya", name: "High Court of Meghalaya", shortName: "Meg HC", level: "high", territory: ["ML"], seat: "Shillong", datasetCode: "17_21", languages: ["en"], benches: [] },
  { id: "hc-gauhati", name: "Gauhati High Court", shortName: "Gau HC", level: "high", territory: ["AS", "AR", "NL", "MZ"], seat: "Guwahati", datasetCode: "18_6", languages: ["as", "en"], benches: [] },
  { id: "hc-calcutta", name: "High Court at Calcutta", shortName: "Cal HC", level: "high", territory: ["WB"], seat: "Kolkata", datasetCode: "19_16", languages: ["bn", "en"],
    // Circuit Benches: calcuttahighcourt.gov.in "Principal seat and benches", checked 2026-10-01.
    benches: [{ id: "cal-kolkata", name: "Principal Bench", city: "Kolkata", principal: true }, { id: "cal-jalpaiguri", name: "Jalpaiguri Circuit Bench", city: "Jalpaiguri" }, { id: "cal-port-blair", name: "Port Blair Circuit Bench", city: "Port Blair" }] },
  { id: "hc-jharkhand", name: "High Court of Jharkhand", shortName: "Jhar HC", level: "high", territory: ["JH"], seat: "Ranchi", datasetCode: "20_7", languages: ["hi", "en"], benches: [] },
  { id: "hc-orissa", name: "High Court of Orissa", shortName: "Ori HC", level: "high", territory: ["OD"], seat: "Cuttack", datasetCode: "21_11", languages: ["or", "en"], benches: [] },
  { id: "hc-chhattisgarh", name: "High Court of Chhattisgarh", shortName: "CG HC", level: "high", territory: ["CG"], seat: "Bilaspur", datasetCode: "22_18", languages: ["hi", "en"], benches: [] },
  { id: "hc-mp", name: "High Court of Madhya Pradesh", shortName: "MP HC", level: "high", territory: ["MP"], seat: "Jabalpur", datasetCode: "23_23", languages: ["hi", "en"], benches: [] },
  { id: "hc-gujarat", name: "High Court of Gujarat", shortName: "Guj HC", level: "high", territory: ["GJ"], seat: "Ahmedabad", datasetCode: "24_17", languages: ["gu", "en"], benches: [{ id: "guj-ahmedabad", name: "Principal Seat", city: "Ahmedabad", principal: true }] },
  { id: "hc-bombay", name: "High Court of Bombay", shortName: "Bom HC", level: "high", territory: ["MH", "GA"], seat: "Mumbai", datasetCode: "27_1", neutralCitationPrefix: "BHC", languages: ["mr", "en"],
    // Benches: bombayhighcourt.gov.in (history, display board: Aurangabad, Nagpur, Goa, Kolhapur), checked 2026-10-01.
    benches: [
      { id: "bom-mumbai", name: "Principal Seat", city: "Mumbai", principal: true },
      { id: "bom-nagpur", name: "Nagpur Bench", city: "Nagpur" },
      { id: "bom-aurangabad", name: "Aurangabad Bench", city: "Aurangabad" },
      { id: "bom-goa", name: "High Court of Bombay at Goa", city: "Panaji" },
      { id: "bom-kolhapur", name: "Circuit Bench at Kolhapur", city: "Kolhapur" },
    ] },
  { id: "hc-kerala", name: "High Court of Kerala", shortName: "Ker HC", level: "high", territory: ["KL"], seat: "Kochi", datasetCode: "32_4", neutralCitationPrefix: "KER", languages: ["ml", "en"], benches: [{ id: "ker-kochi", name: "Principal Seat", city: "Kochi", principal: true }] },
  { id: "hc-madras", name: "High Court of Madras", shortName: "Mad HC", level: "high", territory: ["TN", "PY"], seat: "Chennai", datasetCode: "33_10", neutralCitationPrefix: "MHC", languages: ["ta", "en"],
    // Madurai Bench: hcmadras.tn.gov.in (Madurai Bench case status, display board), checked 2026-10-01.
    benches: [{ id: "mad-chennai", name: "Principal Seat", city: "Chennai", principal: true }, { id: "mad-madurai", name: "Madurai Bench", city: "Madurai" }] },
];

export const COURTS: Court[] = [SUPREME_COURT, ...HIGH_COURTS];

export const FOCUS_COURT_IDS = COURTS.filter((c) => c.focus).map((c) => c.id);

const byId = new Map(COURTS.map((c) => [c.id, c]));
const byDataset = new Map(HIGH_COURTS.filter((c) => c.datasetCode).map((c) => [c.datasetCode!, c]));

export function courtById(id: string | null | undefined): Court | null {
  return id ? byId.get(id) ?? null : null;
}

/** Resolve a dataset court code (`29_3` or `29~3`). Unknown codes return null; callers record them as unresolved. */
export function courtByDatasetCode(code: string | null | undefined): Court | null {
  if (!code) return null;
  return byDataset.get(code.replace("~", "_")) ?? null;
}

export function courtsForState(state: StateCode): Court[] {
  return HIGH_COURTS.filter((c) => c.territory.includes(state));
}

/**
 * Precedential weight of a decision of `decidedBy` for a matter pending before `forum` (deterministic; the model never
 * decides this). Supreme Court decisions bind every court (Art. 141). A High Court's decisions bind courts and
 * tribunals within its territory; other High Courts' decisions are persuasive. Bench strength (a larger bench binds a
 * smaller one of the same court) is handled by the citation engine where the coram is known.
 */
export function bindingEffect(decidedBy: Court, forum: Court): "binding" | "persuasive" {
  if (decidedBy.level === "supreme") return "binding";
  if (forum.level === "supreme") return "persuasive";
  if (decidedBy.id === forum.id) return "binding";
  if (forum.level !== "high" && decidedBy.territory.some((s) => forum.territory.includes(s))) return "binding";
  return "persuasive";
}
