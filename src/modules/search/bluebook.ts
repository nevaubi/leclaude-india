/**
 * Deterministic US Bluebook citation builder (US fork; not used by LeClaude India research, which uses india-citations.ts).
 * Formats structured fields; never invents a missing volume, page, court or year — missing
 * required fields are returned as errors instead. Pure and client-safe.
 */
import { bluebookDate } from "./normalize";

/**
 * US Bluebook court abbreviations (kept so the US builder compiles; LeClaude India formats citations with
 * src/modules/search/india-citations.ts and the research lanes use build_citation in the Indian style).
 */
const COURT_ABBR: Record<string, string> = {
  scotus: "U.S.", ca1: "1st Cir.", ca2: "2d Cir.", ca3: "3d Cir.", ca4: "4th Cir.", ca5: "5th Cir.", ca6: "6th Cir.", ca7: "7th Cir.", ca8: "8th Cir.", ca9: "9th Cir.", ca10: "10th Cir.", ca11: "11th Cir.", cadc: "D.C. Cir.", cafc: "Fed. Cir.",
  dsc: "D.S.C.", ilnd: "N.D. Ill.", cand: "N.D. Cal.", nysd: "S.D.N.Y.", ded: "D. Del.", cal: "Cal.", ny: "N.Y.", del: "Del.", tex: "Tex.", ill: "Ill.",
};

export type CitationFields =
  | { type: "case"; caseName: string; volume?: number | string; reporter?: string; page?: number | string; pinpoint?: string; court?: string; year?: number | string; date?: string; docketNumber?: string; wl?: string; parenthetical?: string }
  | { type: "statute"; title: number | string; code?: string; sections: string[]; year?: number | string; name?: string }
  | { type: "regulation"; title: number | string; sections: string[]; year?: number | string; part?: boolean }
  | { type: "federal_register"; volume: number | string; page: number | string; pinpoint?: string; date: string; name?: string; codifiedAt?: string }
  | { type: "docket"; caseName: string; docketNumber: string; court: string; filed?: string; ecf?: number | string };

export interface BuiltCitation {
  citation: string | null;
  /** Missing or malformed fields; when non-empty, `citation` is null. */
  errors: string[];
  /** Short form for subsequent references ("Boyle, 487 U.S. at 512"). */
  short?: string;
}

/** Bluebook T6 abbreviations for words in case names (a practical subset). */
const T6: [RegExp, string][] = [
  [/\bAssociation\b/g, "Ass'n"], [/\bAssociates\b/g, "Assocs."], [/\bBrothers\b/g, "Bros."], [/\bCompany\b/g, "Co."], [/\bCorporation\b/g, "Corp."], [/\bDepartment\b/g, "Dep't"],
  [/\bEnvironmental\b/g, "Env't"], [/\bGovernment\b/g, "Gov't"], [/\bIncorporated\b/g, "Inc."], [/\bInternational\b/g, "Int'l"], [/\bLimited\b/g, "Ltd."], [/\bManufacturing\b/g, "Mfg."],
  [/\bNational\b/g, "Nat'l"], [/\bTechnologies\b/g, "Techs."], [/\bTechnology\b/g, "Tech."], [/\bUniversity\b/g, "Univ."], [/\bAmerica\b/g, "Am."], [/\bAmerican\b/g, "Am."],
  [/\bChemical\b/g, "Chem."], [/\bLiability\b/g, "Liab."], [/\bLitigation\b/g, "Litig."], [/\bIndustries\b/g, "Indus."], [/\bInsurance\b/g, "Ins."], [/\bProducts\b/g, "Prods."], [/\bServices\b/g, "Servs."], [/\bSystems\b/g, "Sys."],
];

/** Abbreviate a case name for a citation sentence. "United States" is never abbreviated when it is a party. */
export function abbreviateCaseName(name: string): string {
  let out = name.replace(/\s+/g, " ").trim().replace(/\bUnited States of America\b/g, "United States");
  const parties = out.split(/\s+v\.\s+/);
  out = parties.map((p) => (p === "United States" ? p : T6.reduce((acc, [re, abbr]) => acc.replace(re, abbr), p))).join(" v. ");
  return out;
}

/** Normalise reporter spacing: "F. 3d" → "F.3d", "F.Supp.2d" → "F. Supp. 2d", "S.Ct." → "S. Ct.". */
export function normalizeReporter(r: string): string {
  let s = r.replace(/\s+/g, " ").trim();
  s = s.replace(/^F\.\s?(2d|3d|4th)$/i, "F.$1");
  s = s.replace(/^F\.\s?Supp\.\s?(2d|3d)?$/i, (_m, ed: string | undefined) => `F. Supp.${ed ? ` ${ed}` : ""}`);
  s = s.replace(/^S\.\s?Ct\.$/i, "S. Ct.");
  s = s.replace(/^L\.\s?Ed\.\s?(2d)?$/i, (_m, ed: string | undefined) => `L. Ed.${ed ? ` ${ed}` : ""}`);
  s = s.replace(/^F\.\s?App'x$/i, "F. App'x");
  return s;
}

const year = (y?: number | string, date?: string) => (y != null && String(y).trim() ? String(y).trim() : date?.match(/^\d{4}/)?.[0] ?? "");
const courtAbbr = (c?: string) => (c ? COURT_ABBR[c.toLowerCase()] ?? c : "");
const sectionSign = (sections: string[]) => (sections.length > 1 ? "§§" : "§");

export function buildCitation(f: CitationFields): BuiltCitation {
  const errors: string[] = [];
  switch (f.type) {
    case "case": {
      if (!f.caseName?.trim()) errors.push("caseName is required");
      const name = abbreviateCaseName(f.caseName ?? "");
      const y = year(f.year, f.date);
      const reporter = f.reporter ? normalizeReporter(f.reporter) : "";
      const isUS = reporter === "U.S." || f.court?.toLowerCase() === "scotus";
      const court = isUS ? "" : courtAbbr(f.court);
      if (f.volume != null && reporter && f.page != null) {
        if (!y) errors.push("year (or date) is required");
        if (!isUS && !court) errors.push("court is required for reporters other than U.S.");
        if (errors.length) return { citation: null, errors };
        const pin = f.pinpoint ? `, ${f.pinpoint}` : "";
        const citation = `${name}, ${f.volume} ${reporter} ${f.page}${pin} (${[court, y].filter(Boolean).join(" ")})${f.parenthetical ? ` (${f.parenthetical})` : ""}`;
        const shortName = name.split(/\s+v\.\s+/)[0].split(",")[0];
        return { citation, errors, short: `${shortName}, ${f.volume} ${reporter} at ${f.pinpoint ?? f.page}` };
      }
      // Unreported: WL cite or slip opinion with docket number and exact date.
      if (!f.docketNumber) errors.push("volume/reporter/page or docketNumber is required");
      if (!f.date) errors.push("date is required for an unreported decision");
      if (!court) errors.push("court is required for an unreported decision");
      if (errors.length) return { citation: null, errors };
      const at = f.pinpoint ? (f.wl ? `, at *${f.pinpoint.replace(/^\*/, "")}` : `, slip op. at ${f.pinpoint}`) : f.wl ? "" : ", slip op.";
      const citation = `${name}, No. ${f.docketNumber}${f.wl ? `, ${f.wl}` : ""}${at} (${court} ${bluebookDate(f.date)})${f.parenthetical ? ` (${f.parenthetical})` : ""}`;
      return { citation, errors };
    }
    case "statute": {
      if (!String(f.title ?? "").trim()) errors.push("title is required");
      if (!f.sections?.length) errors.push("at least one section is required");
      if (errors.length) return { citation: null, errors };
      const code = f.code?.trim() || "U.S.C.";
      const y = year(f.year);
      return { citation: `${f.name ? `${f.name}, ` : ""}${f.title} ${code} ${sectionSign(f.sections)} ${f.sections.join(", ")}${y ? ` (${y})` : ""}`, errors, short: `${code === "U.S.C." ? `${f.title} U.S.C.` : code} § ${f.sections[0]}` };
    }
    case "regulation": {
      if (!String(f.title ?? "").trim()) errors.push("title is required");
      if (!f.sections?.length) errors.push("at least one section is required");
      const y = year(f.year);
      if (!y) errors.push("year is required (the CFR edition cited)");
      if (errors.length) return { citation: null, errors };
      const mark = f.part ? (f.sections.length > 1 ? "pts." : "pt.") : sectionSign(f.sections);
      return { citation: `${f.title} C.F.R. ${mark} ${f.sections.join(", ")} (${y})`, errors, short: `${f.title} C.F.R. ${mark} ${f.sections[0]}` };
    }
    case "federal_register": {
      if (f.volume == null || f.page == null) errors.push("volume and page are required");
      if (!/^\d{4}-\d{2}-\d{2}/.test(f.date ?? "")) errors.push("date (YYYY-MM-DD) is required");
      if (errors.length) return { citation: null, errors };
      const pin = f.pinpoint ? `, ${f.pinpoint}` : "";
      return { citation: `${f.name ? `${f.name}, ` : ""}${f.volume} Fed. Reg. ${f.page}${pin} (${bluebookDate(f.date)})${f.codifiedAt ? ` (to be codified at ${f.codifiedAt})` : ""}`, errors, short: `${f.volume} Fed. Reg. at ${f.pinpoint ?? f.page}` };
    }
    case "docket": {
      if (!f.caseName?.trim()) errors.push("caseName is required");
      if (!f.docketNumber?.trim()) errors.push("docketNumber is required");
      const court = courtAbbr(f.court);
      if (!court) errors.push("court is required");
      if (errors.length) return { citation: null, errors };
      const filed = f.filed ? ` filed ${bluebookDate(f.filed)}` : "";
      return { citation: `${abbreviateCaseName(f.caseName)}, No. ${f.docketNumber} (${court}${filed})${f.ecf != null ? `, ECF No. ${f.ecf}` : ""}`, errors };
    }
  }
}

/** Parse a reporter cite ("487 U.S. 500, 512") into volume/reporter/page/pinpoint, or null. */
export function parseReporterCite(cite: string): { volume: string; reporter: string; page: string; pinpoint?: string } | null {
  const m = cite.trim().match(/^(\d{1,4})\s+([A-Za-z][A-Za-z0-9.' ]*?)\s+(\d{1,5})(?:,\s*(\d{1,5}(?:[-–]\d{1,5})?))?$/);
  if (!m) return null;
  return { volume: m[1], reporter: normalizeReporter(m[2]), page: m[3], pinpoint: m[4] };
}
