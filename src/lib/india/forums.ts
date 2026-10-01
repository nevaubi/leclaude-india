/**
 * Courts and forums by city (client-safe data, no server imports).
 *
 * Location intelligence for practising litigators: which forums sit in each major city, their official websites and
 * e-filing / cause-list / case-status pages, and the State statutes a litigator there commonly needs.
 *
 * Every forum record carries the official pages it was confirmed on (`sources`, checked 2026-10-01). Only facts shown
 * on a source page are recorded: a field that could not be confirmed is omitted, never guessed (no invented
 * addresses, telephone numbers or pecuniary limits). Designations and benches change by notification; the record
 * names the forum and links the official page where the current position can be checked.
 *
 * Local-law pointers are exact statute titles only. They are resolved at runtime against the law corpus
 * (`law_instruments`) by exact, normalised title within the pointer's jurisdiction; an unresolved title is shown as
 * "not found in corpus" and is never mapped to a similar Act (constitution §23).
 */
import { courtById, type StateCode } from "./courts";

export const FORUM_CHECKED_AT = "2026-10-01";

export interface ForumSource { url: string; title: string; checkedAt: string }

export type ForumKind =
  | "high_court" | "bench" | "district" | "city_civil" | "small_causes" | "family" | "commercial" | "sessions" | "magistrate"
  | "nclt" | "nclat" | "drt" | "drat" | "consumer_national" | "consumer_state" | "consumer_district" | "rera" | "rera_appellate" | "labour" | "other";

export interface ForumLinks { efiling?: string; causeList?: string; caseStatus?: string; judgments?: string }

export interface Forum {
  id: string;
  kind: ForumKind;
  name: string;
  cityId: string;
  state: StateCode;
  /** Registry High Court (for a High Court seat or bench) or the High Court whose superintendence covers the forum. */
  courtId?: string;
  benchId?: string;
  address?: string;
  website?: string;
  links?: ForumLinks;
  sources: ForumSource[];
  note?: string;
}

export interface City {
  id: string;
  name: string;
  /** Other names a user may type ("Bangalore", "Ernakulam"). */
  aliases: string[];
  state: StateCode;
  /** The High Court with jurisdiction over the city and the seat or bench that hears its cases. */
  highCourt: { courtId: string; benchId: string };
}

export const STATE_NAMES: Partial<Record<StateCode, string>> = {
  DL: "Delhi", MH: "Maharashtra", KA: "Karnataka", TS: "Telangana", TN: "Tamil Nadu", WB: "West Bengal", GJ: "Gujarat",
  AP: "Andhra Pradesh", KL: "Kerala", CH: "Chandigarh", RJ: "Rajasthan", UP: "Uttar Pradesh", HR: "Haryana", PB: "Punjab", GA: "Goa",
};

export function stateName(code: StateCode | string | undefined): string {
  return (code && STATE_NAMES[code as StateCode]) || code || "";
}

export const CITIES: City[] = [
  { id: "delhi", name: "New Delhi", aliases: ["Delhi", "NCT of Delhi"], state: "DL", highCourt: { courtId: "hc-delhi", benchId: "del-new-delhi" } },
  { id: "mumbai", name: "Mumbai", aliases: ["Bombay"], state: "MH", highCourt: { courtId: "hc-bombay", benchId: "bom-mumbai" } },
  { id: "bengaluru", name: "Bengaluru", aliases: ["Bangalore"], state: "KA", highCourt: { courtId: "hc-karnataka", benchId: "kar-bengaluru" } },
  { id: "hyderabad", name: "Hyderabad", aliases: ["Secunderabad"], state: "TS", highCourt: { courtId: "hc-telangana", benchId: "ts-hyderabad" } },
  { id: "chennai", name: "Chennai", aliases: ["Madras"], state: "TN", highCourt: { courtId: "hc-madras", benchId: "mad-chennai" } },
  { id: "kolkata", name: "Kolkata", aliases: ["Calcutta"], state: "WB", highCourt: { courtId: "hc-calcutta", benchId: "cal-kolkata" } },
  { id: "pune", name: "Pune", aliases: ["Poona"], state: "MH", highCourt: { courtId: "hc-bombay", benchId: "bom-mumbai" } },
  { id: "ahmedabad", name: "Ahmedabad", aliases: [], state: "GJ", highCourt: { courtId: "hc-gujarat", benchId: "guj-ahmedabad" } },
  { id: "amaravati", name: "Amaravati / Vijayawada", aliases: ["Amaravati", "Vijayawada", "Guntur"], state: "AP", highCourt: { courtId: "hc-andhra", benchId: "ap-amaravati" } },
  { id: "kochi", name: "Kochi / Ernakulam", aliases: ["Kochi", "Ernakulam", "Cochin"], state: "KL", highCourt: { courtId: "hc-kerala", benchId: "ker-kochi" } },
  { id: "chandigarh", name: "Chandigarh", aliases: [], state: "CH", highCourt: { courtId: "hc-ph", benchId: "ph-chandigarh" } },
  { id: "jaipur", name: "Jaipur", aliases: [], state: "RJ", highCourt: { courtId: "hc-rajasthan", benchId: "raj-jaipur" } },
  { id: "lucknow", name: "Lucknow", aliases: [], state: "UP", highCourt: { courtId: "hc-allahabad", benchId: "all-lucknow" } },
  { id: "prayagraj", name: "Prayagraj", aliases: ["Allahabad"], state: "UP", highCourt: { courtId: "hc-allahabad", benchId: "all-prayagraj" } },
  { id: "gurugram", name: "Gurugram", aliases: ["Gurgaon"], state: "HR", highCourt: { courtId: "hc-ph", benchId: "ph-chandigarh" } },
  { id: "noida", name: "Noida", aliases: ["Gautam Buddh Nagar", "Greater Noida"], state: "UP", highCourt: { courtId: "hc-allahabad", benchId: "all-prayagraj" } },
];

// ---------------------------------------------------------------------------
// Sources (official pages, checked FORUM_CHECKED_AT)
// ---------------------------------------------------------------------------

const s = (url: string, title: string): ForumSource => ({ url, title, checkedAt: FORUM_CHECKED_AT });

const NCLT_HOME = s("https://nclt.gov.in/", "Home | National Company Law Tribunal");
const NCLT_CAUSE = s("https://nclt.gov.in/all-cause-list", "Cause List | National Company Law Tribunal");
const NCLT_LINKS: ForumLinks = { efiling: "https://efiling.nclt.gov.in/mainPage.drt", causeList: "https://nclt.gov.in/all-cause-list", caseStatus: "https://efiling.nclt.gov.in/casehistorybeforeloginmenutrue.drt" };
const DRT_HOME = s("https://drt.gov.in/", "Debts Recovery Appellate Tribunals (DRATs) and Debts Recovery Tribunals (DRTs)");
const DRT_LIST = s("https://financialservices.gov.in/dfs/sites/default/files/media/2026-01/DRT-DRAT-02-2025-1.pdf", "Department of Financial Services: incumbency position of Presiding Officers at DRTs and Chairpersons at DRATs");
const DRT_LINKS: ForumLinks = { efiling: "https://efiling.drt.gov.in/edrt/", caseStatus: "https://drt.gov.in/" };
const EJAGRITI = s("https://e-jagriti.gov.in/", "e-jagriti Platform: Department of Consumer Affairs");
const CONSUMER_LINKS: ForumLinks = { efiling: "https://e-jagriti.gov.in/", caseStatus: "https://e-jagriti.gov.in/" };

function nclt(cityId: string, state: StateCode, benchName: string, slug: string, courtId: string): Forum {
  return {
    id: `${cityId}-nclt`, kind: "nclt", name: `National Company Law Tribunal, ${benchName} Bench`, cityId, state, courtId,
    website: `https://nclt.gov.in/${slug}`, links: NCLT_LINKS, sources: [NCLT_HOME, NCLT_CAUSE],
  };
}

function drt(cityId: string, state: StateCode, name: string, courtId: string): Forum {
  return { id: `${cityId}-drt`, kind: "drt", name, cityId, state, courtId, website: "https://drt.gov.in/", links: DRT_LINKS, sources: [DRT_LIST, DRT_HOME] };
}

function drat(cityId: string, state: StateCode, place: string, courtId: string): Forum {
  return { id: `${cityId}-drat`, kind: "drat", name: `Debts Recovery Appellate Tribunal, ${place}`, cityId, state, courtId, website: "https://drt.gov.in/", links: DRT_LINKS, sources: [DRT_LIST, DRT_HOME] };
}

/** An eCourts district-court website ("<sub>.dcourts.gov.in"); the case-status page is recorded only where it was seen. */
function dc(o: Omit<Forum, "website" | "sources" | "links"> & { site: string; title: string; caseStatus?: boolean; extra?: ForumSource[] }): Forum {
  const { site, title, caseStatus, extra, ...rest } = o;
  const website = `https://${site}/`;
  return {
    ...rest, website,
    ...(caseStatus ? { links: { caseStatus: `${website}case-status-search-by-case-number/` } } : {}),
    sources: [s(website, title), ...(extra ?? [])],
  };
}

// ---------------------------------------------------------------------------
// Forums
// ---------------------------------------------------------------------------

export const FORUMS: Forum[] = [
  // ---- New Delhi ----------------------------------------------------------------------------------------------
  {
    id: "delhi-hc", kind: "high_court", name: "High Court of Delhi", cityId: "delhi", state: "DL", courtId: "hc-delhi", benchId: "del-new-delhi",
    website: "https://delhihighcourt.nic.in/web/",
    links: { efiling: "https://dhcefiling.nic.in/eFiling/", causeList: "https://delhihighcourt.nic.in/web/cause-lists", caseStatus: "https://delhihighcourt.nic.in/app/get-case-type-status", judgments: "https://delhihighcourt.nic.in/app/case-number" },
    sources: [s("https://delhihighcourt.nic.in/web/", "Home page | Welcome to High Court of Delhi")],
  },
  {
    id: "delhi-district-courts", kind: "district", name: "District Courts, Delhi (Tis Hazari, Patiala House, Karkardooma, Saket, Rohini, Dwarka, Rouse Avenue)", cityId: "delhi", state: "DL", courtId: "hc-delhi",
    website: "https://delhidistrictcourts.nic.in/", links: { caseStatus: "https://delhidistrictcourts.nic.in/casestatus" },
    sources: [s("https://delhidistrictcourts.nic.in/", "Delhi District Courts: Official Website")],
    note: "Eleven judicial districts sit in seven court complexes; the official site links each district's own website.",
  },
  {
    id: "delhi-nclt", kind: "nclt", name: "National Company Law Tribunal, Principal Bench and New Delhi Bench", cityId: "delhi", state: "DL", courtId: "hc-delhi",
    website: "https://nclt.gov.in/new-delhi-bench", links: NCLT_LINKS, sources: [NCLT_HOME, NCLT_CAUSE],
  },
  {
    id: "delhi-nclat", kind: "nclat", name: "National Company Law Appellate Tribunal (New Delhi)", cityId: "delhi", state: "DL",
    website: "https://nclat.nic.in/", links: { efiling: "https://efiling.nclat.gov.in/" },
    sources: [s("https://nclat.nic.in/", "Home | National Company Law Appellate Tribunal (NCLAT)"), s("https://efiling.nclat.gov.in/", "National Company Law Appellate Tribunal - Delhi")],
  },
  drt("delhi", "DL", "Debts Recovery Tribunals I, II and III, Delhi", "hc-delhi"),
  drat("delhi", "DL", "Delhi", "hc-delhi"),
  {
    id: "delhi-ncdrc", kind: "consumer_national", name: "National Consumer Disputes Redressal Commission", cityId: "delhi", state: "DL",
    website: "https://ncdrc.nic.in/", links: CONSUMER_LINKS, sources: [s("https://ncdrc.nic.in/", "National Consumer Disputes Redressal Commission"), EJAGRITI],
  },
  {
    id: "delhi-rera", kind: "rera", name: "Real Estate Regulatory Authority, NCT of Delhi", cityId: "delhi", state: "DL",
    website: "https://erera.co.in/ereradelhi/",
    sources: [s("https://erera.co.in/reradelhiindex/PublicView/ProjectInfo", "Registered Project - Real Estate Regulatory Authority, NCT of Delhi")],
    note: "The Authority's portal is served from erera.co.in; its contact e-mail addresses use the rera.delhi.gov.in domain.",
  },

  // ---- Mumbai -------------------------------------------------------------------------------------------------
  {
    id: "mumbai-hc", kind: "high_court", name: "High Court of Bombay (Principal Seat)", cityId: "mumbai", state: "MH", courtId: "hc-bombay", benchId: "bom-mumbai",
    website: "https://bombayhighcourt.gov.in/bhc/",
    links: { efiling: "https://filing.ecourts.gov.in/pdedev/", judgments: "https://bombayhighcourt.gov.in/bhc/front/recentjudgment" },
    sources: [s("https://bombayhighcourt.gov.in/bhc/", "Bombay High Court - Home Page"), s("https://bombayhighcourt.gov.in/bhc/history", "High Court of Bombay: history (benches at Aurangabad, Nagpur, Panaji (Goa))")],
  },
  {
    id: "mumbai-city-civil", kind: "city_civil", name: "City Civil and Sessions Court, Mumbai", cityId: "mumbai", state: "MH", courtId: "hc-bombay",
    website: "https://cccmumbai.dcourts.gov.in/", sources: [s("https://cccmumbai.dcourts.gov.in/", "City Civil and Sessions Court, Mumbai")],
  },
  dc({ id: "mumbai-small-causes", kind: "small_causes", name: "Court of Small Causes, Mumbai", cityId: "mumbai", state: "MH", courtId: "hc-bombay", site: "sccmumbai.dcourts.gov.in", title: "Court of Small Causes, Mumbai", caseStatus: true }),
  dc({ id: "mumbai-family", kind: "family", name: "Family Court, Mumbai (Bandra)", cityId: "mumbai", state: "MH", courtId: "hc-bombay", site: "mahafc.dcourts.gov.in", title: "Maharashtra Family Courts (content owned by Family Court, Mumbai at Bandra)" }),
  dc({ id: "mumbai-cmm", kind: "magistrate", name: "Chief Metropolitan Magistrate's Courts, Mumbai (Esplanade)", cityId: "mumbai", state: "MH", courtId: "hc-bombay", site: "cmmmumbai.dcourts.gov.in", title: "CMM Courts Mumbai", caseStatus: true }),
  nclt("mumbai", "MH", "Mumbai", "mumbai-benchs", "hc-bombay"),
  drt("mumbai", "MH", "Debts Recovery Tribunals 1, 2 and 3, Mumbai", "hc-bombay"),
  drat("mumbai", "MH", "Mumbai", "hc-bombay"),
  {
    id: "mumbai-scdrc", kind: "consumer_state", name: "State Consumer Disputes Redressal Commission, Maharashtra", cityId: "mumbai", state: "MH",
    website: "https://grahak.maharashtra.gov.in/en/", links: CONSUMER_LINKS, sources: [s("https://grahak.maharashtra.gov.in/en/", "State Consumer Disputes Redressal Commission Maharashtra"), EJAGRITI],
  },
  {
    id: "mumbai-rera", kind: "rera", name: "Maharashtra Real Estate Regulatory Authority (MahaRERA)", cityId: "mumbai", state: "MH",
    website: "https://www.maharera.maharashtra.gov.in/", links: { efiling: "https://maharerait.maharashtra.gov.in/login/", judgments: "https://www.maharera.maharashtra.gov.in/orders-judgements" },
    sources: [s("https://www.maharera.maharashtra.gov.in/", "MahaRERA")],
  },
  {
    id: "mumbai-rera-appellate", kind: "rera_appellate", name: "Maharashtra Real Estate Appellate Tribunal (MahaREAT)", cityId: "mumbai", state: "MH",
    website: "https://mahareat.maharashtra.gov.in/", sources: [s("https://mahareat.maharashtra.gov.in/", "MahaReat")],
  },

  // ---- Bengaluru ----------------------------------------------------------------------------------------------
  {
    id: "bengaluru-hc", kind: "high_court", name: "High Court of Karnataka (Principal Bench)", cityId: "bengaluru", state: "KA", courtId: "hc-karnataka", benchId: "kar-bengaluru",
    website: "https://judiciary.karnataka.gov.in/",
    links: { causeList: "https://judiciary.karnataka.gov.in/causelistSearch.php", caseStatus: "https://judiciary.karnataka.gov.in/casemenu.php" },
    sources: [s("https://judiciary.karnataka.gov.in/", "High Court of Karnataka"), s("https://judiciary.karnataka.gov.in/display_board_bench.php", "High Court of Karnataka: Principal Bench at Bengaluru, Dharwad Bench, Kalaburagi Bench")],
  },
  dc({ id: "ka-blr-city-civil", kind: "city_civil", name: "City Civil Court, Bengaluru", cityId: "bengaluru", state: "KA", courtId: "hc-karnataka", site: "bengaluru.dcourts.gov.in", title: "DISTRICT COURT BENGALURU | Courts of Bengaluru Urban District", caseStatus: true }),
  dc({ id: "ka-blr-commercial", kind: "commercial", name: "Commercial Court, Bengaluru", cityId: "bengaluru", state: "KA", courtId: "hc-karnataka", site: "bengaluru.dcourts.gov.in", title: "DISTRICT COURT BENGALURU (Commercial Courts listed under Contact Us)", caseStatus: true, extra: [s("https://bengaluru.dcourts.gov.in/contact-us/", "Contact Us | DISTRICT COURT BENGALURU")] }),
  dc({ id: "ka-blr-sessions", kind: "sessions", name: "City Civil and Sessions Court, Bengaluru (Sessions)", cityId: "bengaluru", state: "KA", courtId: "hc-karnataka", site: "bengaluru.dcourts.gov.in", title: "DISTRICT COURT BENGALURU | Courts of Bengaluru Urban District", caseStatus: true }),
  dc({ id: "ka-blr-small-causes", kind: "small_causes", name: "Court of Small Causes, Bengaluru", cityId: "bengaluru", state: "KA", courtId: "hc-karnataka", site: "bengaluru.dcourts.gov.in", title: "DISTRICT COURT BENGALURU (Court of Small Causes listed under Contact Us)", caseStatus: true, extra: [s("https://bengaluru.dcourts.gov.in/contact-us/", "Contact Us | DISTRICT COURT BENGALURU")] }),
  dc({ id: "ka-blr-acmm", kind: "magistrate", name: "Court of the Additional Chief Metropolitan Magistrate, Bengaluru", cityId: "bengaluru", state: "KA", courtId: "hc-karnataka", site: "bengaluru.dcourts.gov.in", title: "DISTRICT COURT BENGALURU (Chief Metropolitan Magistrate Unit listed under Contact Us)", caseStatus: true, extra: [s("https://bengaluru.dcourts.gov.in/contact-us/", "Contact Us | DISTRICT COURT BENGALURU")] }),
  nclt("bengaluru", "KA", "Bengaluru", "bengaluru-bench", "hc-karnataka"),
  drt("bengaluru", "KA", "Debts Recovery Tribunals 1 and 2, Bengaluru", "hc-karnataka"),
  {
    id: "bengaluru-scdrc", kind: "consumer_state", name: "Karnataka State Consumer Disputes Redressal Commission", cityId: "bengaluru", state: "KA",
    website: "https://kscdrc.karnataka.gov.in/english", links: CONSUMER_LINKS, sources: [s("https://kscdrc.karnataka.gov.in/english", "Karnataka State Consumer Disputes Redressal Commission"), EJAGRITI],
  },
  {
    id: "bengaluru-rera", kind: "rera", name: "Karnataka Real Estate Regulatory Authority", cityId: "bengaluru", state: "KA",
    website: "https://rera.karnataka.gov.in/", sources: [s("https://rera.karnataka.gov.in/home?language=en", "Karnataka RERA")],
  },
  {
    id: "bengaluru-rera-appellate", kind: "rera_appellate", name: "Karnataka Appellate Tribunal (interim Real Estate Appellate Tribunal), Bengaluru", cityId: "bengaluru", state: "KA",
    website: "https://rera.karnataka.gov.in/aboutKREAT", sources: [s("https://rera.karnataka.gov.in/aboutKREAT", "RERA Karnataka, Appellate Tribunal")],
  },

  // ---- Hyderabad ----------------------------------------------------------------------------------------------
  {
    id: "hyderabad-hc", kind: "high_court", name: "High Court for the State of Telangana", cityId: "hyderabad", state: "TS", courtId: "hc-telangana", benchId: "ts-hyderabad",
    website: "https://tshc.gov.in/", links: { causeList: "https://causelist.tshc.gov.in/", caseStatus: "https://hcservices.ecourts.gov.in/ecourtindiaHC/index_highcourt.php?state_cd=29&dist_cd=1&stateNm=Telangana" },
    sources: [s("https://tshc.gov.in/", "High Court for the State of Telangana"), s("https://causelist.tshc.gov.in/", "Cause List - High Court for the State of Telangana")],
  },
  dc({ id: "ts-hyd-city-civil", kind: "city_civil", name: "City Civil Court, Hyderabad", cityId: "hyderabad", state: "TS", courtId: "hc-telangana", site: "hccc.dcourts.gov.in", title: "CITY CIVIL COURTS HYDERABAD AND SECUNDERABAD", caseStatus: true }),
  dc({
    id: "ts-hyd-commercial", kind: "commercial", name: "Commercial Court, Hyderabad (Special Court for Trial and Disposal of Commercial Disputes)", cityId: "hyderabad", state: "TS", courtId: "hc-telangana",
    site: "hccc.dcourts.gov.in", title: "City Civil Courts Hyderabad: list of judges (Special Court for Trial and Disposal of Commercial Disputes, Hyderabad)",
    extra: [s("https://hccc.dcourts.gov.in/list-of-judges/", "List of Judges | City Civil Courts Hyderabad and Secunderabad")],
  }),
  dc({ id: "ts-hyd-sessions", kind: "sessions", name: "Metropolitan Sessions Court, Hyderabad", cityId: "hyderabad", state: "TS", courtId: "hc-telangana", site: "hmsj.dcourts.gov.in", title: "Sessions Judge Unit, Hyderabad", caseStatus: true, address: "Sessions Judge Court, City Criminal Courts Complex, Red Hills, Hyderabad – 500 004", extra: [s("https://hmsj.dcourts.gov.in/contact-us/", "Contact Us | Sessions Judge Unit, Hyderabad")] }),
  dc({ id: "ts-hyd-mm", kind: "magistrate", name: "Court of the Metropolitan Magistrate, Hyderabad", cityId: "hyderabad", state: "TS", courtId: "hc-telangana", site: "hmsj.dcourts.gov.in", title: "Sessions Judge Unit, Hyderabad (Additional Chief Metropolitan Magistrates listed)", caseStatus: true, extra: [s("https://hmsj.dcourts.gov.in/list-of-judges/", "List of Judges | Sessions Judge Unit, Hyderabad")] }),
  nclt("hyderabad", "TS", "Hyderabad", "hyderabad-bench", "hc-telangana"),
  drt("hyderabad", "TS", "Debts Recovery Tribunals 1 and 2, Hyderabad", "hc-telangana"),
  {
    id: "hyderabad-scdrc", kind: "consumer_state", name: "Telangana State Consumer Disputes Redressal Commission", cityId: "hyderabad", state: "TS",
    website: "https://scdrc.tg.nic.in/", links: CONSUMER_LINKS, sources: [s("https://scdrc.tg.nic.in/", "TSCDRC"), EJAGRITI],
  },
  {
    id: "hyderabad-rera", kind: "rera", name: "Telangana Real Estate Regulatory Authority", cityId: "hyderabad", state: "TS",
    website: "https://rera.telangana.gov.in/", links: { efiling: "https://rerait.telangana.gov.in/" }, sources: [s("https://rera.telangana.gov.in/", "RERA Telangana")],
  },

  // ---- Chennai ------------------------------------------------------------------------------------------------
  {
    id: "chennai-hc", kind: "high_court", name: "High Court of Madras (Principal Seat)", cityId: "chennai", state: "TN", courtId: "hc-madras", benchId: "mad-chennai",
    website: "https://hcmadras.tn.gov.in/",
    sources: [s("https://hcmadras.tn.gov.in/", "Madras High Court"), s("https://hcmadras.tn.gov.in/case_status_mdu.php", "Madurai Bench case status - Madras High Court")],
    note: "The High Court also sits at its Madurai Bench.",
  },
  dc({ id: "chennai-city-civil", kind: "city_civil", name: "City Civil and Sessions Court, Chennai", cityId: "chennai", state: "TN", courtId: "hc-madras", site: "chennai.dcourts.gov.in", title: "Chennai City Courts", caseStatus: true }),
  nclt("chennai", "TN", "Chennai", "chennai-bench", "hc-madras"),
  {
    id: "chennai-nclat", kind: "nclat", name: "National Company Law Appellate Tribunal, Chennai Bench", cityId: "chennai", state: "TN",
    website: "https://nclat.nic.in/", sources: [s("https://nclat.nic.in/", "Home | National Company Law Appellate Tribunal (NCLAT): Contact Us, Chennai Bench")],
  },
  drt("chennai", "TN", "Debts Recovery Tribunals 1, 2 and 3, Chennai", "hc-madras"),
  drat("chennai", "TN", "Chennai", "hc-madras"),
  {
    id: "chennai-rera", kind: "rera", name: "Tamil Nadu Real Estate Regulatory Authority (TNRERA)", cityId: "chennai", state: "TN",
    website: "https://rera.tn.gov.in/", sources: [s("https://rera.tn.gov.in/registered-building/tn", "Registered Projects (Building) - Tamil Nadu - TNRERA")],
  },

  // ---- Kolkata ------------------------------------------------------------------------------------------------
  {
    id: "kolkata-hc", kind: "high_court", name: "High Court at Calcutta (Principal Bench)", cityId: "kolkata", state: "WB", courtId: "hc-calcutta", benchId: "cal-kolkata",
    website: "https://www.calcuttahighcourt.gov.in/", sources: [s("https://www.calcuttahighcourt.gov.in/", "Calcutta High Court")],
    note: "Permanent Circuit Benches sit at Jalpaiguri and Port Blair.",
  },
  dc({ id: "kolkata-city-civil", kind: "city_civil", name: "City Civil Court, Calcutta", cityId: "kolkata", state: "WB", courtId: "hc-calcutta", site: "citycivilcourtcalcutta.dcourts.gov.in", title: "City Civil Court Calcutta" }),
  dc({ id: "kolkata-small-causes", kind: "small_causes", name: "Presidency Small Cause Court, Kolkata", cityId: "kolkata", state: "WB", courtId: "hc-calcutta", site: "psccourt.dcourts.gov.in", title: "Presidency Small Cause Court", caseStatus: true }),
  nclt("kolkata", "WB", "Kolkata", "kolkata-bench", "hc-calcutta"),
  drt("kolkata", "WB", "Debts Recovery Tribunals 1, 2 and 3, Kolkata", "hc-calcutta"),
  drat("kolkata", "WB", "Kolkata", "hc-calcutta"),
  {
    id: "kolkata-scdrc", kind: "consumer_state", name: "West Bengal State Consumer Disputes Redressal Commission", cityId: "kolkata", state: "WB",
    links: CONSUMER_LINKS, sources: [s("https://wbconsumers.gov.in/HtmlPages/con_KeyContact.aspx?w=state_official", "West Bengal Consumer Affairs: State Commission key contacts"), EJAGRITI],
  },
  {
    id: "kolkata-rera", kind: "rera", name: "West Bengal Real Estate Regulatory Authority (WBRERA)", cityId: "kolkata", state: "WB",
    website: "https://rera.wb.gov.in/", sources: [s("https://rera.wb.gov.in/", "West Bengal Real Estate Regulatory Authority")],
  },

  // ---- Pune ---------------------------------------------------------------------------------------------------
  dc({
    id: "pune-district", kind: "district", name: "District and Sessions Court, Pune", cityId: "pune", state: "MH", courtId: "hc-bombay", site: "pune.dcourts.gov.in", title: "District & Session Court, Pune",
    address: "District and Sessions Court, CTS No. 9 and 9A, FP No. 805 and 891, Shivajinagar, Pune-411 005", extra: [s("https://pune.dcourts.gov.in/contact-us/", "Contact Us | District & Session Court, Pune")],
  }),
  drt("pune", "MH", "Debts Recovery Tribunal, Pune", "hc-bombay"),
  {
    id: "pune-rera", kind: "rera", name: "Maharashtra Real Estate Regulatory Authority (MahaRERA)", cityId: "pune", state: "MH",
    website: "https://www.maharera.maharashtra.gov.in/", links: { efiling: "https://maharerait.maharashtra.gov.in/login/" }, sources: [s("https://www.maharera.maharashtra.gov.in/", "MahaRERA")],
  },

  // ---- Ahmedabad ----------------------------------------------------------------------------------------------
  {
    id: "ahmedabad-hc", kind: "high_court", name: "High Court of Gujarat", cityId: "ahmedabad", state: "GJ", courtId: "hc-gujarat", benchId: "guj-ahmedabad",
    website: "https://gujarathighcourt.nic.in/", links: { causeList: "https://gujarathighcourt.nic.in/causelist", caseStatus: "https://gujarathc-casestatus.nic.in/gujarathc/" },
    sources: [s("https://gujarathighcourt.nic.in/", "High Court of Gujarat")],
  },
  dc({ id: "ahmedabad-city-civil", kind: "city_civil", name: "City Civil and Sessions Court, Ahmedabad (Bhadra)", cityId: "ahmedabad", state: "GJ", courtId: "hc-gujarat", site: "ahmedabad-ccc.dcourts.gov.in", title: "City Civil & Sessions Court, Ahmedabad", caseStatus: true }),
  nclt("ahmedabad", "GJ", "Ahmedabad", "ahmedabad-bench", "hc-gujarat"),
  drt("ahmedabad", "GJ", "Debts Recovery Tribunals 1 and 2, Ahmedabad", "hc-gujarat"),
  {
    id: "ahmedabad-scdrc", kind: "consumer_state", name: "State Consumer Disputes Redressal Commission, Gujarat", cityId: "ahmedabad", state: "GJ",
    address: "State Consumer Disputes Redressal Commission, Gota Cross Road, S.G. Highway, Ahmedabad -380 060",
    links: { ...CONSUMER_LINKS, caseStatus: "https://cdrc.gujarat.gov.in/en/case-status" },
    sources: [s("https://cdrc.gujarat.gov.in/en/case-status", "Case Status - Consumer Disputes Redressal Commission, Gujarat"), EJAGRITI],
  },
  {
    id: "ahmedabad-rera", kind: "rera", name: "Gujarat Real Estate Regulatory Authority (GujRERA)", cityId: "ahmedabad", state: "GJ",
    website: "https://gujrera.gujarat.gov.in/", sources: [s("https://gujrera.gujarat.gov.in/", "RERA Gujarat")],
  },

  // ---- Amaravati / Vijayawada ---------------------------------------------------------------------------------
  {
    id: "amaravati-hc", kind: "high_court", name: "High Court of Andhra Pradesh", cityId: "amaravati", state: "AP", courtId: "hc-andhra", benchId: "ap-amaravati",
    address: "Amaravati, Guntur District, Andhra Pradesh 522237",
    website: "https://aphc.gov.in/", sources: [s("https://aphc.gov.in/", "High Court of Andhra Pradesh"), s("https://digi-courts.aphc.ap.gov.in/csis_ap/", "High Court of Andhra Pradesh (case information system)")],
  },
  dc({ id: "amaravati-guntur-district", kind: "district", name: "District Court, Guntur", cityId: "amaravati", state: "AP", courtId: "hc-andhra", site: "guntur.dcourts.gov.in", title: "Guntur District Court", caseStatus: true }),
  nclt("amaravati", "AP", "Amaravati", "amravati-bench", "hc-andhra"),
  {
    id: "amaravati-scdrc", kind: "consumer_state", name: "Andhra Pradesh State Consumer Disputes Redressal Commission", cityId: "amaravati", state: "AP",
    website: "https://scdrc.ap.nic.in/", links: CONSUMER_LINKS, sources: [s("https://scdrc.ap.nic.in/", "Andhra Pradesh State Consumer Disputes Redressal Commission"), EJAGRITI],
    note: "Seat of the Commission not confirmed on the source; listed for Andhra Pradesh matters.",
  },
  {
    id: "amaravati-rera", kind: "rera", name: "Andhra Pradesh Real Estate Regulatory Authority", cityId: "amaravati", state: "AP",
    website: "https://rera.ap.gov.in/", sources: [s("https://rera.ap.gov.in/rera/Views/Project.aspx?%3Fenc=mUX5JvffTObOCE+6xFBEFb1Q9dF4sUJ5oTL43SeK6ntMCvMJDNihB4hEG1Trt5feoZUrlkzh+UpIsj6fc3jrkEus2O0mOcdrYarKlR46Rx4PUTgRdVb%2FFi4PmBWU0EbB", "AP RERA (project page)")],
  },

  // ---- Kochi / Ernakulam --------------------------------------------------------------------------------------
  {
    id: "kochi-hc", kind: "high_court", name: "High Court of Kerala", cityId: "kochi", state: "KL", courtId: "hc-kerala", benchId: "ker-kochi",
    website: "https://highcourt.kerala.gov.in/", sources: [s("https://highcourt.kerala.gov.in/", "HIGH COURT OF KERALA - kerala gov")],
  },
  dc({ id: "kochi-district", kind: "district", name: "District Court, Ernakulam", cityId: "kochi", state: "KL", courtId: "hc-kerala", site: "ernakulam.dcourts.gov.in", title: "District Court, Ernakulam", caseStatus: true }),
  nclt("kochi", "KL", "Kochi", "kochi-bench", "hc-kerala"),
  drt("kochi", "KL", "Debts Recovery Tribunals 1 and 2, Ernakulam", "hc-kerala"),
  {
    id: "kochi-rera", kind: "rera", name: "Kerala Real Estate Regulatory Authority", cityId: "kochi", state: "KL",
    website: "https://reraonline.kerala.gov.in/", sources: [s("https://reraonline.kerala.gov.in/", "Kerala Real Estate Regulatory Authority: Login Page")],
    note: "Seat of the Authority not confirmed on the source; listed for Kerala matters.",
  },

  // ---- Chandigarh ---------------------------------------------------------------------------------------------
  {
    id: "chandigarh-hc", kind: "high_court", name: "High Court of Punjab and Haryana", cityId: "chandigarh", state: "CH", courtId: "hc-ph", benchId: "ph-chandigarh",
    website: "https://www.phhc.gov.in/", sources: [s("https://www.phhc.gov.in/", "Punjab and Haryana High Court, Chandigarh")],
  },
  dc({ id: "chandigarh-district", kind: "district", name: "District Courts, Chandigarh (Sector 43)", cityId: "chandigarh", state: "CH", courtId: "hc-ph", site: "chandigarh.dcourts.gov.in", title: "District Court Chandigarh", caseStatus: true }),
  nclt("chandigarh", "CH", "Chandigarh", "chandigarh-bench", "hc-ph"),
  drt("chandigarh", "CH", "Debts Recovery Tribunals 1, 2 and 3, Chandigarh", "hc-ph"),

  // ---- Jaipur -------------------------------------------------------------------------------------------------
  {
    id: "jaipur-hc", kind: "bench", name: "Rajasthan High Court, Jaipur Bench", cityId: "jaipur", state: "RJ", courtId: "hc-rajasthan", benchId: "raj-jaipur",
    website: "https://hcraj.nic.in/", links: { caseStatus: "https://hcservices.ecourts.gov.in/ecourtindiaHC/index_highcourt.php?state_cd=9&dist_cd=1&stateNm=Rajasthan" },
    sources: [s("https://hcraj.nic.in/", "Rajasthan High Court"), s("https://hcservices.ecourts.gov.in/ecourtindiaHC/index_highcourt.php?state_cd=9&dist_cd=1&stateNm=Rajasthan", "High Court of Rajasthan - High Court Bench at Jaipur (eCourts case status)")],
    note: "The Principal Seat is at Jodhpur.",
  },
  dc({ id: "jaipur-metro-1", kind: "district", name: "District and Sessions Court, Jaipur Metropolitan I", cityId: "jaipur", state: "RJ", courtId: "hc-rajasthan", site: "jaipurmetro1.dcourts.gov.in", title: "District and Sessions Court Jaipur Metropolitan I" }),
  dc({ id: "jaipur-metro-2", kind: "district", name: "District Court, Jaipur Metropolitan II", cityId: "jaipur", state: "RJ", courtId: "hc-rajasthan", site: "jaipurmetro2.dcourts.gov.in", title: "District Court Jaipur Metropolitan II" }),
  nclt("jaipur", "RJ", "Jaipur", "jaipur-bench", "hc-rajasthan"),
  drt("jaipur", "RJ", "Debts Recovery Tribunal, Jaipur", "hc-rajasthan"),
  {
    id: "jaipur-scdrc", kind: "consumer_state", name: "Rajasthan State Consumer Disputes Redressal Commission", cityId: "jaipur", state: "RJ",
    website: "https://www.rscdrc.food.rajasthan.gov.in/", links: CONSUMER_LINKS, sources: [s("https://www.rscdrc.food.rajasthan.gov.in/", "Rajasthan State Consumer Disputes Redressal Commission"), EJAGRITI],
  },
  {
    id: "jaipur-rera", kind: "rera", name: "Rajasthan Real Estate Regulatory Authority", cityId: "jaipur", state: "RJ",
    website: "https://rera.rajasthan.gov.in/", sources: [s("https://rera.rajasthan.gov.in/", "RERA Rajasthan")],
  },
  {
    id: "jaipur-rera-appellate", kind: "rera_appellate", name: "Rajasthan Real Estate Appellate Tribunal", cityId: "jaipur", state: "RJ",
    website: "https://reat.rajasthan.gov.in/", sources: [s("https://reat.rajasthan.gov.in/", "Rajasthan Real Estate Appellate Tribunal")],
  },

  // ---- Lucknow ------------------------------------------------------------------------------------------------
  {
    id: "lucknow-hc", kind: "bench", name: "High Court of Judicature at Allahabad, Lucknow Bench", cityId: "lucknow", state: "UP", courtId: "hc-allahabad", benchId: "all-lucknow",
    website: "https://www.allahabadhighcourt.in/", links: { causeList: "https://www.allahabadhighcourt.in/causelist", caseStatus: "https://hclko.allahabadhighcourt.in/status/", judgments: "https://elegalix.allahabadhighcourt.in/elegalix/StartWebSearch.do" },
    sources: [s("https://www.allahabadhighcourt.in/causelist", "Causelist - High Court of Judicature at Allahabad & Lucknow Bench"), s("https://hclko.allahabadhighcourt.in/status/", "Case Status - Allahabad High Court - Lucknow Bench")],
  },
  dc({ id: "lucknow-district", kind: "district", name: "District and Sessions Court, Lucknow", cityId: "lucknow", state: "UP", courtId: "hc-allahabad", site: "lucknow.dcourts.gov.in", title: "DISTRICT AND SESSION COURT LUCKNOW", caseStatus: true }),
  drt("lucknow", "UP", "Debts Recovery Tribunal, Lucknow", "hc-allahabad"),
  {
    id: "lucknow-scdrc", kind: "consumer_state", name: "Uttar Pradesh State Consumer Disputes Redressal Commission", cityId: "lucknow", state: "UP",
    website: "https://scdrc.up.nic.in/", links: CONSUMER_LINKS, sources: [s("https://scdrc.up.nic.in/", "scdrc - NIC Uttar Pradesh"), EJAGRITI],
  },
  {
    id: "lucknow-rera", kind: "rera", name: "Real Estate Regulatory Authority, Uttar Pradesh (UP RERA), Lucknow Headquarters", cityId: "lucknow", state: "UP",
    website: "https://up-rera.in/", sources: [s("https://up-rera.in/", "UP RERA")],
  },

  // ---- Prayagraj ----------------------------------------------------------------------------------------------
  {
    id: "prayagraj-hc", kind: "high_court", name: "High Court of Judicature at Allahabad (Principal Seat)", cityId: "prayagraj", state: "UP", courtId: "hc-allahabad", benchId: "all-prayagraj",
    website: "https://www.allahabadhighcourt.in/", links: { causeList: "https://www.allahabadhighcourt.in/causelist", caseStatus: "https://www.allahabadhighcourt.in/case_status.html", judgments: "https://elegalix.allahabadhighcourt.in/elegalix/StartWebSearch.do" },
    sources: [s("https://www.allahabadhighcourt.in/", "Official Website of the High Court of Judicature at Allahabad"), s("https://www.allahabadhighcourt.in/case_status.html", "Case Status - High Court of Judicature at Allahabad & Lucknow Bench")],
  },
  dc({ id: "prayagraj-district", kind: "district", name: "District Court, Prayagraj", cityId: "prayagraj", state: "UP", courtId: "hc-allahabad", site: "prayagraj.dcourts.gov.in", title: "District Court Prayagraj", caseStatus: true }),
  nclt("prayagraj", "UP", "Allahabad", "allahabad-bench", "hc-allahabad"),
  drt("prayagraj", "UP", "Debts Recovery Tribunal, Allahabad", "hc-allahabad"),
  drat("prayagraj", "UP", "Allahabad", "hc-allahabad"),

  // ---- Gurugram -----------------------------------------------------------------------------------------------
  dc({ id: "gurugram-district", kind: "district", name: "District Court, Gurugram", cityId: "gurugram", state: "HR", courtId: "hc-ph", site: "gurugram.dcourts.gov.in", title: "District Court Gurugram", caseStatus: true }),
  {
    id: "gurugram-rera", kind: "rera", name: "Haryana Real Estate Regulatory Authority, Gurugram", cityId: "gurugram", state: "HR",
    address: "Haryana Real Estate Regulatory Authority, New PWD Rest House Civil Lines, Gurugram, Haryana",
    website: "https://www.hareraggm.gov.in/", sources: [s("https://www.hareraggm.gov.in/", "HARERAGGM - Haryana Real Estate Regulatory Authority Gurgaon"), s("https://haryanarera.gov.in/", "Haryana Real Estate Regulatory Authority")],
  },

  // ---- Noida --------------------------------------------------------------------------------------------------
  {
    id: "noida-rera", kind: "rera", name: "Real Estate Regulatory Authority, Uttar Pradesh (UP RERA)", cityId: "noida", state: "UP",
    website: "https://up-rera.in/", sources: [s("https://up-rera.in/", "UP RERA")],
    note: "State-wide authority (headquarters at Lucknow). A regional office for Noida was not confirmed on an official page.",
  },
];

// ---------------------------------------------------------------------------
// Local-law pointers (titles only; resolved at runtime against the law corpus)
// ---------------------------------------------------------------------------

export type LocalLawTopic = "rent" | "court_fees" | "stamp" | "registration" | "municipal" | "land_revenue" | "courts" | "property" | "cooperative";

export interface LocalLawPointer {
  /** Exact statute title as published (India Code style). Matched by normalised exact title only. */
  title: string;
  topic: LocalLawTopic;
  /** Where the title is looked up: State legislation of `stateCode`, or central legislation (Delhi's rent and municipal laws are Acts of Parliament). */
  jurisdiction: "state" | "central";
  stateCode?: StateCode;
  /** Official page on which the title was confirmed, when one was checked. */
  source?: ForumSource;
}

const IC = (url: string, title: string) => s(url, title);

/** Pointers per State / UT, keyed by the city's State code. */
export const LOCAL_LAW: Partial<Record<StateCode, LocalLawPointer[]>> = {
  KA: [
    { title: "The Karnataka Rent Act, 1999", topic: "rent", jurisdiction: "state", stateCode: "KA", source: IC("https://www.indiacode.nic.in/handle/123456789/2485/browse?type=actno&sort_by=3&order=ASC&rpp=5&etal=-1&value=34&starts_with=K", "India Code: Browsing \"Karnataka\" by Act Number 34") },
    { title: "The Karnataka Court-fees and Suits Valuation Act, 1958", topic: "court_fees", jurisdiction: "state", stateCode: "KA" },
    { title: "The Karnataka Stamp Act, 1957", topic: "stamp", jurisdiction: "state", stateCode: "KA", source: IC("https://www.indiacode.nic.in/handle/123456789/2485/browse?type=actno&sort_by=3&order=ASC&rpp=5&etal=-1&value=34&starts_with=K", "India Code: Browsing \"Karnataka\" by Act Number 34") },
    { title: "The Karnataka Civil Courts Act, 1964", topic: "courts", jurisdiction: "state", stateCode: "KA" },
    { title: "The Karnataka Municipal Corporations Act, 1976", topic: "municipal", jurisdiction: "state", stateCode: "KA" },
    { title: "The Karnataka Land Revenue Act, 1964", topic: "land_revenue", jurisdiction: "state", stateCode: "KA" },
  ],
  TS: [
    { title: "The Telangana Buildings (Lease, Rent and Eviction) Control Act, 1960", topic: "rent", jurisdiction: "state", stateCode: "TS" },
    { title: "The Telangana Court-fees and Suits Valuation Act, 1956", topic: "court_fees", jurisdiction: "state", stateCode: "TS" },
    { title: "The Telangana Civil Courts Act, 1972", topic: "courts", jurisdiction: "state", stateCode: "TS" },
    { title: "The Greater Hyderabad Municipal Corporation Act, 1955", topic: "municipal", jurisdiction: "state", stateCode: "TS", source: IC("https://www.indiacode.nic.in/bitstream/123456789/8634/1/act_2_of_1956.pdf", "India Code: The Greater Hyderabad Municipal Corporation Act, 1955 (Act No. II of 1956)") },
  ],
  AP: [
    { title: "The Andhra Pradesh Buildings (Lease, Rent and Eviction) Control Act, 1960", topic: "rent", jurisdiction: "state", stateCode: "AP" },
    { title: "The Andhra Pradesh Court-fees and Suits Valuation Act, 1956", topic: "court_fees", jurisdiction: "state", stateCode: "AP" },
    { title: "The Andhra Pradesh Civil Courts Act, 1972", topic: "courts", jurisdiction: "state", stateCode: "AP" },
    { title: "The Andhra Pradesh Municipal Corporations Act, 1994", topic: "municipal", jurisdiction: "state", stateCode: "AP" },
  ],
  MH: [
    { title: "The Maharashtra Rent Control Act, 1999", topic: "rent", jurisdiction: "state", stateCode: "MH", source: IC("https://www.indiacode.nic.in/handle/123456789/2517/browse?type=actno&order=ASC&rpp=20&value=18", "India Code: Browsing \"Maharashtra\" by Act Number 18") },
    { title: "The Maharashtra Court-fees Act, 1959", topic: "court_fees", jurisdiction: "state", stateCode: "MH" },
    { title: "The Maharashtra Stamp Act", topic: "stamp", jurisdiction: "state", stateCode: "MH" },
    { title: "The Maharashtra Land Revenue Code, 1966", topic: "land_revenue", jurisdiction: "state", stateCode: "MH" },
    { title: "The Maharashtra Ownership Flats (Regulation of the Promotion of Construction, Sale, Management and Transfer) Act, 1963", topic: "property", jurisdiction: "state", stateCode: "MH" },
    { title: "The Maharashtra Co-operative Societies Act, 1960", topic: "cooperative", jurisdiction: "state", stateCode: "MH" },
  ],
  DL: [
    { title: "The Delhi Rent Control Act, 1958", topic: "rent", jurisdiction: "central" },
    { title: "The Delhi Municipal Corporation Act, 1957", topic: "municipal", jurisdiction: "central" },
    { title: "The Delhi High Court Act, 1966", topic: "courts", jurisdiction: "central" },
    { title: "The Delhi Land Reforms Act, 1954", topic: "land_revenue", jurisdiction: "state", stateCode: "DL" },
  ],
  TN: [
    { title: "The Tamil Nadu Regulation of Rights and Responsibilities of Landlords and Tenants Act, 2017", topic: "rent", jurisdiction: "state", stateCode: "TN" },
    { title: "The Tamil Nadu Court-fees and Suits Valuation Act, 1955", topic: "court_fees", jurisdiction: "state", stateCode: "TN" },
    { title: "The Chennai City Civil Court Act, 1892", topic: "courts", jurisdiction: "state", stateCode: "TN" },
  ],
  WB: [
    { title: "The West Bengal Premises Tenancy Act, 1997", topic: "rent", jurisdiction: "state", stateCode: "WB" },
    { title: "The West Bengal Court-fees Act, 1970", topic: "court_fees", jurisdiction: "state", stateCode: "WB" },
    { title: "The City Civil Court Act, 1953", topic: "courts", jurisdiction: "state", stateCode: "WB" },
    { title: "The Kolkata Municipal Corporation Act, 1980", topic: "municipal", jurisdiction: "state", stateCode: "WB" },
  ],
  GJ: [
    { title: "The Gujarat Rents, Hotel and Lodging House Rates Control Act, 1947", topic: "rent", jurisdiction: "state", stateCode: "GJ" },
    { title: "The Gujarat Court Fees Act, 2004", topic: "court_fees", jurisdiction: "state", stateCode: "GJ" },
    { title: "The Gujarat Stamp Act, 1958", topic: "stamp", jurisdiction: "state", stateCode: "GJ" },
    { title: "The Gujarat Provincial Municipal Corporations Act, 1949", topic: "municipal", jurisdiction: "state", stateCode: "GJ" },
    { title: "The Gujarat Land Revenue Code, 1879", topic: "land_revenue", jurisdiction: "state", stateCode: "GJ" },
  ],
  KL: [
    { title: "The Kerala Buildings (Lease and Rent Control) Act, 1965", topic: "rent", jurisdiction: "state", stateCode: "KL" },
    { title: "The Kerala Court Fees and Suits Valuation Act, 1959", topic: "court_fees", jurisdiction: "state", stateCode: "KL" },
    { title: "The Kerala Stamp Act, 1959", topic: "stamp", jurisdiction: "state", stateCode: "KL" },
    { title: "The Kerala Municipality Act, 1994", topic: "municipal", jurisdiction: "state", stateCode: "KL" },
  ],
  CH: [
    { title: "The East Punjab Urban Rent Restriction Act, 1949", topic: "rent", jurisdiction: "state", stateCode: "PB" },
    { title: "The Punjab Courts Act, 1918", topic: "courts", jurisdiction: "state", stateCode: "PB" },
  ],
  RJ: [
    { title: "The Rajasthan Rent Control Act, 2001", topic: "rent", jurisdiction: "state", stateCode: "RJ" },
    { title: "The Rajasthan Court Fees and Suits Valuation Act, 1961", topic: "court_fees", jurisdiction: "state", stateCode: "RJ" },
    { title: "The Rajasthan Land Revenue Act, 1956", topic: "land_revenue", jurisdiction: "state", stateCode: "RJ" },
    { title: "The Rajasthan Tenancy Act, 1955", topic: "land_revenue", jurisdiction: "state", stateCode: "RJ" },
    { title: "The Rajasthan Municipalities Act, 2009", topic: "municipal", jurisdiction: "state", stateCode: "RJ" },
  ],
  UP: [
    { title: "The Uttar Pradesh Regulation of Urban Premises Tenancy Act, 2021", topic: "rent", jurisdiction: "state", stateCode: "UP" },
    { title: "The Uttar Pradesh Revenue Code, 2006", topic: "land_revenue", jurisdiction: "state", stateCode: "UP" },
    { title: "The Uttar Pradesh Municipal Corporation Act, 1959", topic: "municipal", jurisdiction: "state", stateCode: "UP" },
  ],
  HR: [
    { title: "The Haryana Urban (Control of Rent and Eviction) Act, 1973", topic: "rent", jurisdiction: "state", stateCode: "HR" },
    { title: "The Haryana Municipal Corporation Act, 1994", topic: "municipal", jurisdiction: "state", stateCode: "HR" },
    { title: "The Punjab Land Revenue Act, 1887", topic: "land_revenue", jurisdiction: "state", stateCode: "HR" },
  ],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const cityMap = new Map(CITIES.map((c) => [c.id, c]));
const forumMap = new Map(FORUMS.map((f) => [f.id, f]));

export function cityById(id: string | null | undefined): City | null {
  return id ? cityMap.get(id) ?? null : null;
}

export function forumById(id: string | null | undefined): Forum | null {
  return id ? forumMap.get(id) ?? null : null;
}

/** Find a city by id, name or alias (case-insensitive, exact). Unknown names return null. */
export function findCity(q: string | null | undefined): City | null {
  const k = (q ?? "").trim().toLowerCase();
  if (!k) return null;
  return CITIES.find((c) => c.id === k || c.name.toLowerCase() === k || c.aliases.some((a) => a.toLowerCase() === k)) ?? null;
}

/**
 * The jurisdictional High Court record for a city: the forum record at that seat/bench (which may sit in another
 * city, e.g. Gurugram's matters go to Chandigarh), or null when none is recorded.
 */
export function highCourtForumFor(cityId: string): Forum | null {
  const c = cityById(cityId);
  if (!c) return null;
  return FORUMS.find((f) => (f.kind === "high_court" || f.kind === "bench") && f.courtId === c.highCourt.courtId && f.benchId === c.highCourt.benchId) ?? null;
}

/** Forums for a city: the jurisdictional High Court seat/bench first (even if it sits elsewhere), then the city's own forums. */
export function forumsForCity(cityId: string | null | undefined): Forum[] {
  const c = cityById(cityId);
  if (!c) return [];
  const own = FORUMS.filter((f) => f.cityId === c.id);
  const hc = highCourtForumFor(c.id);
  return hc && !own.includes(hc) ? [hc, ...own] : own;
}

/** The city a forum sits in, or the city whose forum list a registry court/bench heads. */
export function cityForCourt(courtId: string | null | undefined, benchId?: string | null): City | null {
  if (!courtId) return null;
  const f = forumById(courtId);
  if (f) return cityById(f.cityId);
  const c = courtById(courtId);
  if (!c) return null;
  return CITIES.find((x) => x.highCourt.courtId === courtId && (!benchId || x.highCourt.benchId === benchId)) ?? null;
}

/**
 * The forum record for a stored court id: a city forum by id, or the High Court seat/bench record for a registry court
 * (the given bench, else the principal seat). Null when nothing is recorded; never the nearest forum.
 */
export function forumRecordForCourt(courtId: string | null | undefined, benchId?: string | null): Forum | null {
  if (!courtId) return null;
  const direct = forumById(courtId);
  if (direct) return direct;
  const court = courtById(courtId);
  if (!court) return null;
  const bench = benchId ?? court.benches.find((b) => b.principal)?.id;
  if (!bench) return null;
  return FORUMS.find((f) => (f.kind === "high_court" || f.kind === "bench") && f.courtId === courtId && f.benchId === bench) ?? null;
}

export function localLawFor(state: StateCode | null | undefined): LocalLawPointer[] {
  return state ? LOCAL_LAW[state] ?? [] : [];
}

/** Section order and labels on the /courts page (i18n keys are `courts.kind.<kind>`). */
export const FORUM_KIND_ORDER: ForumKind[] = [
  "high_court", "bench", "district", "city_civil", "sessions", "commercial", "small_causes", "family", "magistrate",
  "nclt", "nclat", "drt", "drat", "consumer_national", "consumer_state", "consumer_district", "rera", "rera_appellate", "labour", "other",
];

/** Kinds that are courts of the eCourts district judiciary (CNR numbers apply). */
export const DISTRICT_JUDICIARY_KINDS: ForumKind[] = ["district", "city_civil", "small_causes", "family", "commercial", "sessions", "magistrate"];

/** Normalise a statute title for exact matching: case, punctuation, spacing and a leading "The" are ignored. */
export function normaliseActTitle(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/^the\s+/, "");
}
