/**
 * Law hub search: route one query to the right corpus by what it looks like (pure, client-safe).
 *
 * - Citations, CNRs and "X v. Y" titles → case law.
 * - "s. 303 BNS", "Section 482 BNSS", "302 IPC" → that section of that Act (resolved by exact title at run time; when
 *   the Act cannot be resolved the statutes search for the Act's title is opened instead, never a similar Act).
 * - Act names and abbreviations ("Companies Act", "IBC") → statutes.
 * - "Justice …" → judges.  A recorded city or alias ("Bombay") → its courts page.
 * - Anything else stays in the area the user is in (an explicit scope always wins).
 */
import { findCity } from "@/lib/india/forums";

export type LawArea = "cases" | "law" | "courts" | "judges";
export type LawScope = "auto" | LawArea | "provisions";

export type LawRoute =
  | { kind: "href"; area: LawArea; href: string; reason: string }
  /** Resolve `actTitle` to an instrument (exact title), then open `section`; on failure open `fallback`. */
  | { kind: "section"; area: "law"; actTitle: string; section: string; fallback: string; reason: string };

/** Common abbreviations → exact citation titles (Central Acts). */
export const ACT_ABBREVIATIONS: Record<string, string> = {
  bns: "Bharatiya Nyaya Sanhita, 2023",
  bnss: "Bharatiya Nagarik Suraksha Sanhita, 2023",
  bsa: "Bharatiya Sakshya Adhiniyam, 2023",
  ipc: "Indian Penal Code, 1860",
  crpc: "Code of Criminal Procedure, 1973",
  cpc: "Code of Civil Procedure, 1908",
  iea: "Indian Evidence Act, 1872",
  "evidence act": "Indian Evidence Act, 1872",
  "ni act": "Negotiable Instruments Act, 1881",
  ibc: "Insolvency and Bankruptcy Code, 2016",
  "contract act": "Indian Contract Act, 1872",
  "a&c act": "Arbitration and Conciliation Act, 1996",
  "arbitration act": "Arbitration and Conciliation Act, 1996",
  "it act": "Information Technology Act, 2000",
  tpa: "Transfer of Property Act, 1882",
  "companies act": "Companies Act, 2013",
  "limitation act": "Limitation Act, 1963",
  "specific relief act": "Specific Relief Act, 1963",
  "consumer protection act": "Consumer Protection Act, 2019",
};

const norm = (s: string) => s.toLowerCase().replace(/[.\s]+/g, " ").replace(/\s*&\s*/g, "&").trim();
const abbrKey = (s: string) => norm(s).replace(/ /g, "");

/** "BNS" / "Cr.P.C." / "NI Act" → the exact title, or null. */
export function expandActAbbreviation(s: string): string | null {
  const n = norm(s);
  if (ACT_ABBREVIATIONS[n]) return ACT_ABBREVIATIONS[n];
  const k = abbrKey(s);
  for (const [a, t] of Object.entries(ACT_ABBREVIATIONS)) if (a.replace(/ /g, "") === k) return t;
  return null;
}

// Citations and identifiers.
const NEUTRAL_SC = /\b(19|20)\d{2}\s+INSC\s+\d{1,5}\b/i;
const NEUTRAL_HC = /\b(19|20)\d{2}\s*:\s*[A-Z]{2,6}(?:-[A-Z]{1,4})?\s*:\s*\d{1,6}\b/i;
const REPORTER = /[([]\s*(19|20)\d{2}\s*[)\]]\s*\d{0,3}\s*(SCC|S\.?\s?C\.?\s?R\.?|SCR|AIR|SCALE|Cri\s*LJ|All\s*ER|KLT|MLJ|Bom\s*LR)\b/i;
const AIR = /\bAIR\s+(19|20)\d{2}\s+[A-Z]{2,4}\s+\d+/i;
const CNR = /^[A-Z]{4}\d{2}\d{6}\d{4}$/i; // 16 characters: 4 letters, 12 digits
const PARTIES = /\s(v\.?|vs\.?|versus)\s/i;

// Statute provisions: "s. 303 BNS", "section 482 of BNSS", "302 IPC", "Art. 21"? (articles are not handled: no Constitution id).
const SECTION_FIRST = /^(?:s(?:ec(?:tion)?)?\.?|§)\s*(\d{1,4}[A-Z]{0,3})(?:\s*\(\s*\w{1,4}\s*\))*\s*(?:,|of|of the|under)?\s+(?:the\s+)?(.+)$/i;
const NUMBER_FIRST = /^(\d{1,4}[A-Z]{0,3})\s+(.+)$/i;
const ACT_WORDS = /\b(act|code|sanhita|adhiniyam|rules|regulations?|ordinance|bill)\b/i;
const JUDGE = /^(?:hon'?ble\s+)?(?:(?:mr|mrs|ms|dr)\.?\s+)?(?:justice|jus\.?|j\.)\s+(.+)$|^(.+?),?\s+(?:j|cj|cji)\.?$/i;
const CITY_PHRASE = /^(?:courts?|forums?|tribunals?)\s+(?:in|at|of)\s+(.+)$|^(.+?)\s+(?:courts?|forums?|tribunals?)$/i;

const enc = encodeURIComponent;

export function areaOfPath(pathname: string | null | undefined): LawArea {
  const p = pathname ?? "";
  if (p.startsWith("/law")) return "law";
  if (p.startsWith("/courts")) return "courts";
  if (p.startsWith("/judges")) return "judges";
  return "cases";
}

function casesHref(q: string) { return `/cases?q=${enc(q)}`; }
function actsHref(q: string) { return `/law?q=${enc(q)}`; }
function provisionsHref(q: string) { return `/law?mode=sections&q=${enc(q)}`; }
function judgesHref(q: string) { return `/judges?q=${enc(q)}`; }

/** A "section N of Act" query, or null. */
export function parseSectionQuery(q: string): { section: string; actTitle: string } | null {
  const m = SECTION_FIRST.exec(q) ?? NUMBER_FIRST.exec(q);
  if (!m) return null;
  const rest = m[2].trim().replace(/[.,;]+$/, "");
  const title = expandActAbbreviation(rest) ?? (ACT_WORDS.test(rest) ? rest : null);
  return title ? { section: m[1].toUpperCase(), actTitle: title } : null;
}

function judgeName(q: string): string | null {
  const m = JUDGE.exec(q.trim());
  const name = (m?.[1] ?? m?.[2] ?? "").trim();
  return name.length >= 2 ? name : null;
}

function cityOf(q: string): string | null {
  const direct = findCity(q);
  if (direct) return direct.id;
  const m = CITY_PHRASE.exec(q.trim());
  const c = m ? findCity((m[1] ?? m[2] ?? "").trim()) : null;
  return c?.id ?? null;
}

/** Decide where a query goes. `area` is where the user is now (the default for queries that look like nothing). */
export function routeLawQuery(raw: string, scope: LawScope = "auto", area: LawArea = "cases"): LawRoute | null {
  const q = raw.replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
  if (!q) return null;

  const section = parseSectionQuery(q);
  const sectionRoute = (s: { section: string; actTitle: string }): LawRoute => ({ kind: "section", area: "law", actTitle: s.actTitle, section: s.section, fallback: actsHref(s.actTitle), reason: "provision" });

  switch (scope) {
    case "cases": return { kind: "href", area: "cases", href: casesHref(q), reason: "scope" };
    case "provisions": return section ? sectionRoute(section) : { kind: "href", area: "law", href: provisionsHref(q), reason: "scope" };
    case "law": {
      if (section) return sectionRoute(section);
      const t = expandActAbbreviation(q);
      return { kind: "href", area: "law", href: actsHref(t ?? q), reason: "scope" };
    }
    case "judges": return { kind: "href", area: "judges", href: judgesHref(judgeName(q) ?? q), reason: "scope" };
    case "courts": {
      const c = cityOf(q);
      return { kind: "href", area: "courts", href: `/courts?city=${enc(c ?? q)}`, reason: "scope" };
    }
    default: break;
  }

  // Auto: identifiers first (they are unambiguous), then provisions, Acts, judges and cities.
  if (NEUTRAL_SC.test(q) || NEUTRAL_HC.test(q) || REPORTER.test(q) || AIR.test(q) || CNR.test(q.replace(/[\s-]/g, ""))) {
    return { kind: "href", area: "cases", href: casesHref(q), reason: "citation" };
  }
  if (section) return sectionRoute(section);
  if (PARTIES.test(` ${q} `) && !ACT_WORDS.test(q)) return { kind: "href", area: "cases", href: casesHref(q), reason: "parties" };
  const abbr = expandActAbbreviation(q);
  if (abbr) return { kind: "href", area: "law", href: actsHref(abbr), reason: "act" };
  if (ACT_WORDS.test(q) && /^[\p{L}\d ,.&()'-]+$/u.test(q) && /\b(act|code|sanhita|adhiniyam)\b(,?\s*(1[6-9]|20)\d{2})?$/i.test(q)) {
    return { kind: "href", area: "law", href: actsHref(q), reason: "act" };
  }
  const judge = judgeName(q);
  if (judge) return { kind: "href", area: "judges", href: judgesHref(judge), reason: "judge" };
  const city = cityOf(q);
  if (city) return { kind: "href", area: "courts", href: `/courts?city=${enc(city)}`, reason: "city" };

  switch (area) {
    case "law": return { kind: "href", area: "law", href: actsHref(q), reason: "area" };
    case "judges": return { kind: "href", area: "judges", href: judgesHref(q), reason: "area" };
    case "courts": return { kind: "href", area: "courts", href: `/courts?city=${enc(q)}`, reason: "area" };
    default: return { kind: "href", area: "cases", href: casesHref(q), reason: "area" };
  }
}
