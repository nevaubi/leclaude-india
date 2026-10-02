/**
 * High Court pages where an advocate can search that court's own cause list by name or roll number (client-safe).
 * LeClaude only links to them; it does not fetch, scrape or fill these forms (several use their own CAPTCHA).
 * Checked against the courts' websites on 2026-10-02.
 */
export interface AdvocateListLink {
  courtId: string;
  court: string;
  label: string;
  url: string;
  /** What the court's page asks for, in its own terms. */
  note: string;
}

export const ADVOCATE_LIST_LINKS_CHECKED_ON = "2026-10-02";

export const ADVOCATE_LIST_LINKS: readonly AdvocateListLink[] = [
  { courtId: "hc-madras", court: "Madras High Court", label: "Cause list: advocate name search", url: "https://hcmadras.tn.gov.in/cause_list_mhc.php", note: "Principal seat; cause-list date and advocate name." },
  { courtId: "hc-karnataka", court: "High Court of Karnataka", label: "Short cause list search for advocate", url: "https://judiciary.karnataka.gov.in/causelistSearch.php", note: "All benches; advocate name or registration number, up to 7 days." },
  { courtId: "hc-bombay", court: "Bombay High Court", label: "Cause list: advocate name search", url: "https://bombayhighcourt.gov.in/bhc/causelistFinal", note: "Advocate or party name on the court's cause-list page." },
  { courtId: "hc-allahabad", court: "Allahabad High Court", label: "Advocate's cases listed today", url: "https://www.allahabadhighcourt.in/causelist/rollnoA1.jsp", note: "Allahabad; advocate roll number (the court's own CAPTCHA)." },
  { courtId: "hc-allahabad", court: "Allahabad High Court, Lucknow Bench", label: "Advocate's cases listed, date-wise", url: "https://hclko.allahabadhighcourt.in/status/index.php/advocate-cases-date-wise", note: "Lucknow Bench; date of listing and advocate roll number." },
];
