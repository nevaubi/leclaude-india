/**
 * Stable identifiers for the India demonstration pack (Bengaluru and Hyderabad practice).
 *
 * Everything in this pack is synthetic. Court names are real (from the court registry); every party, company,
 * witness, advocate, official and document is FICTIONAL, no judge is named, and no statement is attributed to a
 * real person, company or public body. Every record is tagged `meta.demo = "india-blr-hyd"` and `meta.synthetic`
 * so it can be listed and removed. The pack is loaded on demand from Settings → Demo data, never implicitly.
 */
export const DEMO_PACK = "india-blr-hyd" as const;

/** Tag stored on every demo record (`meta.demo`) and prefix used by every demo id. */
export const DEMO_TAG = { key: "demo", value: DEMO_PACK } as const;

export const DEMO_MATTERS = {
  /** Commercial suit before the Commercial Court, Bengaluru (the firm acts for the plaintiff). */
  commercial: "m_demo_in_com_os_1187",
  /** Writ petition before the High Court for the State of Telangana (the firm acts for the petitioner). */
  writ: "m_demo_in_wp_18234",
  /** Related criminal petition for regular bail under s.483 BNSS before the Telangana High Court. */
  bail: "m_demo_in_crlp_7710",
} as const;

/** Two demo team members joining the workspace owner (fictional). */
export const DEMO_TEAM = {
  junior: "p_demo_in_kavya_hegde", // Junior Advocate (Bengaluru)
  clerk: "p_demo_in_sai_kiran_reddy", // Law Clerk (Hyderabad)
} as const;

/** Parties whose documents make up the case record (the "custodian" of each document is the party that produced it). */
export const DEMO_SOURCES = {
  plaintiff: "c_demo_in_nimbus",
  defendant: "c_demo_in_tungabhadra",
  courtCom: "c_demo_in_court_com",
  petitioner: "c_demo_in_sarojini",
  municipality: "c_demo_in_municipality",
  courtHyd: "c_demo_in_court_hyd",
  prosecution: "c_demo_in_prosecution",
} as const;

export const DEMO_DEPOSITIONS = {
  pw1: "dep_demo_in_pw1",
  dw1: "dep_demo_in_dw1",
} as const;

/** Document-reference prefixes by source (2–8 letters: what the reference parser accepts). */
export const DEMO_REF_PREFIX = {
  plaintiff: "NCW",
  defendant: "TRS",
  courtCom: "COS",
  petitioner: "KSD",
  municipality: "CMN",
  courtHyd: "TSHC",
  prosecution: "CRPS",
} as const;

/** Id prefix every demo record uses, so removal can also sweep by prefix. */
export const DEMO_ID_PREFIX = "demo_in_";

export function isDemoRecord(x: { id?: string; meta?: Record<string, unknown> } | null | undefined): boolean {
  if (!x) return false;
  return x.meta?.[DEMO_TAG.key] === DEMO_TAG.value || (typeof x.id === "string" && (x.id.startsWith(DEMO_ID_PREFIX) || x.id.includes("_demo_in_")));
}
