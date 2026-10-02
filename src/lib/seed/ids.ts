/** Stable identifiers shared across module seeds so cross-references line up. */
export const PEOPLE = {
  arjunMehra: "p_jwhitfield", // Partner (current user)
  priyaRaman: "p_praman", // Partner, products liability
  dhruvOberoi: "p_dokafor", // Senior associate
  eshaMathur: "p_emarsh", // Associate
  sameerChawla: "p_schen", // Associate
  meeraLobo: "p_mlopez", // Litigation paralegal
  tanmayBhatt: "p_tbradley", // E-discovery project manager
  aishaKhan: "p_akhan", // Knowledge management / library
  // Client-side custodians (Meridian Fine Chemicals)
  girishHegde: "c_ghale",
  hemaVasudevan: "c_hvoss",
  nandiniBose: "c_nbrooks",
  anilPrasad: "c_apryce",
  rohitKapur: "c_rkaine",
  manishSood: "c_msuarez",
  // Experts / opposing
  drLeelaSundaramTox: "x_lwhitfield",
  drRajPatelHydro: "x_rpatel",
  opposingCounselKale: "o_klein",
  arbitratorRangan: "j_rangan",
} as const;

export const MATTERS = {
  valsara: "m_valsara_arb",
  depo: "m_depo_provera_3140",
  northgate: "m_northgate_v_apex",
  harbor: "m_project_harbor",
  sterling: "m_sterling_employment",
} as const;
