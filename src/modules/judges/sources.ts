/**
 * Source registry for court and judge identity (client-safe data). Every roster URL here is an official court page.
 * `verified` records how the page was checked during development: "content" means its content was read and the
 * parser was written against it (the fixture lives in tests/fixtures/enrichment); "listing" means only the search
 * index listing (title and an excerpt) confirmed the page; "unreachable" means the page could not be fetched when
 * checked, so the job uses guarded structured extraction (every extracted name must appear verbatim in the page).
 */
import { FORUMS } from "@/lib/india/forums";

export type RosterParser = "sci" | "cards" | "table" | "aphc" | "extract";

export interface RosterSource {
  courtId: string;
  url: string;
  title: string;
  parser: RosterParser;
  verified: "content" | "listing" | "unreachable";
  checkedAt: string;
  /** Whether the page's own headings say who is the Chief Justice (otherwise designation stays null). */
  designations: boolean;
  note?: string;
}

export const ROSTER_SOURCES: RosterSource[] = [
  {
    courtId: "sci", url: "https://www.sci.gov.in/chief-justice-judges/", title: "Chief Justice & Judges | Supreme Court of India", parser: "sci",
    verified: "content", checkedAt: "2026-10-01", designations: true,
    note: "Grid of the Chief Justice of India and the Judges, each with a photograph, date of appointment (DoA), date of retirement (DoR) and a profile link.",
  },
  {
    courtId: "hc-telangana", url: "https://tshc.gov.in/processMenuTypes?id=6", title: "Chief Justice and Sitting Judges - High Court for the State of Telangana", parser: "cards",
    verified: "content", checkedAt: "2026-10-01", designations: true,
    note: "Profiles of Sitting Judges: photograph, printed name and a profile link per judge; the Chief Justice heads the page.",
  },
  {
    courtId: "hc-andhra", url: "https://aphc.gov.in/profiles.php", title: "CJ & Sitting Judges - High Court of Andhra Pradesh", parser: "aphc",
    verified: "content", checkedAt: "2026-10-01", designations: true,
    note: "Chief Justice and Judges with photograph, date of appointment and date of retirement (or expiry of present term for additional judges). Profiles open in place; the page itself is the profile link.",
  },
  {
    courtId: "hc-bombay", url: "https://bombayhighcourt.gov.in/bhc/cj-sitting-judges", title: "Hon'ble Chief Justice and Sitting Judges - Bombay High Court", parser: "table",
    verified: "content", checkedAt: "2026-10-01", designations: true,
    note: "List view table: photograph, name, headquarters, date of birth, date of appointment, date of retirement; additional judges in a second table with the expiry of their present term.",
  },
  {
    courtId: "hc-delhi", url: "https://delhihighcourt.nic.in/web/CJ_Sitting_Judges", title: "Hon'ble Chief Justice and Sitting Judges - High Court of Delhi", parser: "cards",
    verified: "listing", checkedAt: "2026-10-01", designations: false,
    note: "Photograph cards linking to each judge's profile. Confirmed from the search index excerpt only; designations are not read from this page.",
  },
  {
    courtId: "hc-karnataka", url: "https://judiciary.karnataka.gov.in/submenujprofile.php?nid=1", title: "Hon`ble The Chief Justice and Sitting Judges of High Court of Karnataka", parser: "extract",
    verified: "unreachable", checkedAt: "2026-10-01", designations: false,
    note: "Page title confirmed in the search index; the page did not load when checked (scrape timed out), so the layout is not known and guarded extraction is used.",
  },
  {
    courtId: "hc-madras", url: "https://hcmadras.tn.gov.in/present_judges.php", title: "Profile - Madras High Court", parser: "extract",
    verified: "unreachable", checkedAt: "2026-10-01", designations: false,
    note: "Listed in the search index as the present judges' profile page; the page could not be fetched when checked (proxy tunnel error), so guarded extraction is used.",
  },
];

export function rosterSourceFor(courtId: string): RosterSource | null {
  return ROSTER_SOURCES.find((s) => s.courtId === courtId) ?? null;
}

export interface CourtSiteSource {
  courtId: string;
  siteUrl: string;
  /** A logo image verified on the official site header, when known; otherwise the job reads the site's branding. */
  logoUrl?: string;
  logoVerified?: string;
}

/** Official websites: the Supreme Court plus every High Court the city forum registry records with a website. */
export function courtSites(): CourtSiteSource[] {
  const out: CourtSiteSource[] = [{
    courtId: "sci", siteUrl: "https://www.sci.gov.in/",
    // Header logo ("SCI logo") on www.sci.gov.in, read 2026-10-01.
    logoUrl: "https://cdnbbsr.s3waas.gov.in/s3ec0490f1f4972d133619a60c30f3559e/uploads/2025/05/2025053038.png", logoVerified: "2026-10-01",
  }];
  const seen = new Set(["sci"]);
  for (const f of FORUMS) {
    if (f.kind !== "high_court" || !f.courtId || !f.website || seen.has(f.courtId)) continue;
    seen.add(f.courtId);
    const site: CourtSiteSource = { courtId: f.courtId, siteUrl: f.website };
    // "High Court Logo" in the header of aphc.gov.in (seen on https://aphc.gov.in/profiles.php, 2026-10-01).
    if (f.courtId === "hc-andhra") { site.logoUrl = "https://aphc.gov.in/images/logo.png"; site.logoVerified = "2026-10-01"; }
    out.push(site);
  }
  return out;
}

export const ATTRIBUTION_NOTE = "Official photograph/emblem as published on the court's website; reproduced with attribution for identification. Copyright remains with the publisher.";
