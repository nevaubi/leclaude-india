/**
 * Statute reference parser (client-safe, deterministic).
 *
 * Parses "s. 302 IPC", "Section 483 of BNSS", "Sections 302/34 IPC", "u/s 420 IPC", "Art. 226 of the Constitution",
 * "Order XXXIX Rules 1 and 2 CPC", "S.138 NI Act", "Section 34 of the Arbitration and Conciliation Act, 1996".
 *
 * Act identity comes from the coded table below. Rules:
 *   - an alias shared by two Acts in force or commonly litigated ("Companies Act": 1956/2013; "Consumer Protection
 *     Act": 1986/2019; "IT Act": Information Technology Act 2000 / Income-tax Act) resolves only with a year;
 *     without one the reference keeps `actCandidates` and no `actId`;
 *   - a year that does not match the coded Act (e.g. "Code of Criminal Procedure, 1898") leaves the Act unresolved;
 *   - an Act whose short alias is used without a year and whose predecessor is long repealed resolves to the coded
 *     Act with `yearAssumed: true` so the UI can show that the year was not stated.
 * Act numbers are recorded only where the maintainers are certain of them.
 */
import type { IndianCitation } from "./types";

export interface Act {
  id: string;
  /** Full short title ("Indian Penal Code"). */
  name: string;
  year: number;
  /** Short form used in citations ("IPC"). */
  abbr: string;
  /** "Act 45 of 1860" — only where certain. */
  actNumber?: string;
  jurisdiction: "central" | "state" | "constitution";
  state?: "KA" | "TS" | "AP";
  /** Spellings recognised in text (case-insensitive; dots and spacing flexible). */
  aliases: string[];
  unit: "section" | "article";
  /** Successor code (IPC → BNS). */
  replacedBy?: string;
}

export const ACTS: Act[] = [
  { id: "constitution", name: "Constitution of India", year: 1950, abbr: "Constitution", jurisdiction: "constitution", aliases: ["Constitution of India", "Constitution"], unit: "article" },
  { id: "ipc", name: "Indian Penal Code", year: 1860, abbr: "IPC", actNumber: "Act 45 of 1860", jurisdiction: "central", aliases: ["Indian Penal Code", "Penal Code", "I.P.C.", "IPC"], unit: "section", replacedBy: "bns" },
  { id: "crpc", name: "Code of Criminal Procedure", year: 1973, abbr: "CrPC", actNumber: "Act 2 of 1974", jurisdiction: "central", aliases: ["Code of Criminal Procedure", "Criminal Procedure Code", "Cr.P.C.", "CrPC"], unit: "section", replacedBy: "bnss" },
  { id: "cpc", name: "Code of Civil Procedure", year: 1908, abbr: "CPC", actNumber: "Act 5 of 1908", jurisdiction: "central", aliases: ["Code of Civil Procedure", "Civil Procedure Code", "C.P.C.", "CPC"], unit: "section" },
  { id: "iea", name: "Indian Evidence Act", year: 1872, abbr: "Evidence Act", actNumber: "Act 1 of 1872", jurisdiction: "central", aliases: ["Indian Evidence Act", "Evidence Act", "I.E.A.", "IEA"], unit: "section", replacedBy: "bsa" },
  { id: "bns", name: "Bharatiya Nyaya Sanhita", year: 2023, abbr: "BNS", actNumber: "Act 45 of 2023", jurisdiction: "central", aliases: ["Bharatiya Nyaya Sanhita", "B.N.S.", "BNS"], unit: "section" },
  { id: "bnss", name: "Bharatiya Nagarik Suraksha Sanhita", year: 2023, abbr: "BNSS", actNumber: "Act 46 of 2023", jurisdiction: "central", aliases: ["Bharatiya Nagarik Suraksha Sanhita", "B.N.S.S.", "BNSS"], unit: "section" },
  { id: "bsa", name: "Bharatiya Sakshya Adhiniyam", year: 2023, abbr: "BSA", actNumber: "Act 47 of 2023", jurisdiction: "central", aliases: ["Bharatiya Sakshya Adhiniyam", "B.S.A.", "BSA"], unit: "section" },
  { id: "ni", name: "Negotiable Instruments Act", year: 1881, abbr: "NI Act", actNumber: "Act 26 of 1881", jurisdiction: "central", aliases: ["Negotiable Instruments Act", "N.I. Act", "NI Act"], unit: "section" },
  { id: "arbitration", name: "Arbitration and Conciliation Act", year: 1996, abbr: "A&C Act", actNumber: "Act 26 of 1996", jurisdiction: "central", aliases: ["Arbitration and Conciliation Act", "Arbitration & Conciliation Act", "A&C Act", "A & C Act"], unit: "section" },
  { id: "specific-relief", name: "Specific Relief Act", year: 1963, abbr: "SR Act", actNumber: "Act 47 of 1963", jurisdiction: "central", aliases: ["Specific Relief Act", "S.R. Act", "SR Act"], unit: "section" },
  { id: "limitation", name: "Limitation Act", year: 1963, abbr: "Limitation Act", actNumber: "Act 36 of 1963", jurisdiction: "central", aliases: ["Limitation Act"], unit: "section" },
  { id: "tpa", name: "Transfer of Property Act", year: 1882, abbr: "TP Act", actNumber: "Act 4 of 1882", jurisdiction: "central", aliases: ["Transfer of Property Act", "T.P. Act", "TP Act"], unit: "section" },
  { id: "contract", name: "Indian Contract Act", year: 1872, abbr: "Contract Act", actNumber: "Act 9 of 1872", jurisdiction: "central", aliases: ["Indian Contract Act", "Contract Act"], unit: "section" },
  { id: "hsa", name: "Hindu Succession Act", year: 1956, abbr: "HS Act", actNumber: "Act 30 of 1956", jurisdiction: "central", aliases: ["Hindu Succession Act", "H.S. Act"], unit: "section" },
  { id: "hma", name: "Hindu Marriage Act", year: 1955, abbr: "HM Act", actNumber: "Act 25 of 1955", jurisdiction: "central", aliases: ["Hindu Marriage Act", "H.M. Act"], unit: "section" },
  { id: "mv", name: "Motor Vehicles Act", year: 1988, abbr: "MV Act", actNumber: "Act 59 of 1988", jurisdiction: "central", aliases: ["Motor Vehicles Act", "M.V. Act", "MV Act"], unit: "section" },
  { id: "pocso", name: "Protection of Children from Sexual Offences Act", year: 2012, abbr: "POCSO Act", actNumber: "Act 32 of 2012", jurisdiction: "central", aliases: ["Protection of Children from Sexual Offences Act", "POCSO Act", "POCSO"], unit: "section" },
  { id: "ndps", name: "Narcotic Drugs and Psychotropic Substances Act", year: 1985, abbr: "NDPS Act", actNumber: "Act 61 of 1985", jurisdiction: "central", aliases: ["Narcotic Drugs and Psychotropic Substances Act", "N.D.P.S. Act", "NDPS Act", "NDPS"], unit: "section" },
  { id: "companies-2013", name: "Companies Act", year: 2013, abbr: "Companies Act", actNumber: "Act 18 of 2013", jurisdiction: "central", aliases: ["Companies Act"], unit: "section" },
  { id: "companies-1956", name: "Companies Act", year: 1956, abbr: "Companies Act", actNumber: "Act 1 of 1956", jurisdiction: "central", aliases: ["Companies Act"], unit: "section" },
  { id: "ibc", name: "Insolvency and Bankruptcy Code", year: 2016, abbr: "IBC", actNumber: "Act 31 of 2016", jurisdiction: "central", aliases: ["Insolvency and Bankruptcy Code", "I.B.C.", "IBC"], unit: "section" },
  { id: "rera", name: "Real Estate (Regulation and Development) Act", year: 2016, abbr: "RERA", actNumber: "Act 16 of 2016", jurisdiction: "central", aliases: ["Real Estate (Regulation and Development) Act", "RERA Act", "RERA", "RERDA"], unit: "section" },
  { id: "cpa-2019", name: "Consumer Protection Act", year: 2019, abbr: "CP Act", actNumber: "Act 35 of 2019", jurisdiction: "central", aliases: ["Consumer Protection Act", "C.P. Act", "CP Act"], unit: "section" },
  { id: "cpa-1986", name: "Consumer Protection Act", year: 1986, abbr: "CP Act", actNumber: "Act 68 of 1986", jurisdiction: "central", aliases: ["Consumer Protection Act", "C.P. Act", "CP Act"], unit: "section" },
  { id: "it-2000", name: "Information Technology Act", year: 2000, abbr: "IT Act", actNumber: "Act 21 of 2000", jurisdiction: "central", aliases: ["Information Technology Act", "I.T. Act", "IT Act"], unit: "section" },
  { id: "income-tax-1961", name: "Income-tax Act", year: 1961, abbr: "IT Act", actNumber: "Act 43 of 1961", jurisdiction: "central", aliases: ["Income-tax Act", "Income Tax Act", "I.T. Act", "IT Act"], unit: "section" },
  { id: "arms", name: "Arms Act", year: 1959, abbr: "Arms Act", actNumber: "Act 54 of 1959", jurisdiction: "central", aliases: ["Arms Act"], unit: "section" },
  { id: "dowry", name: "Dowry Prohibition Act", year: 1961, abbr: "DP Act", actNumber: "Act 28 of 1961", jurisdiction: "central", aliases: ["Dowry Prohibition Act", "D.P. Act", "DP Act"], unit: "section" },
  { id: "pwdva", name: "Protection of Women from Domestic Violence Act", year: 2005, abbr: "DV Act", actNumber: "Act 43 of 2005", jurisdiction: "central", aliases: ["Protection of Women from Domestic Violence Act", "D.V. Act", "DV Act", "PWDV Act"], unit: "section" },
  { id: "sc-st-poa", name: "Scheduled Castes and the Scheduled Tribes (Prevention of Atrocities) Act", year: 1989, abbr: "SC/ST (PoA) Act", actNumber: "Act 33 of 1989", jurisdiction: "central", aliases: ["Scheduled Castes and the Scheduled Tribes (Prevention of Atrocities) Act", "SC/ST (Prevention of Atrocities) Act", "SC/ST (PoA) Act", "SC/ST Act", "SC & ST (POA) Act"], unit: "section" },
  { id: "contempt", name: "Contempt of Courts Act", year: 1971, abbr: "Contempt of Courts Act", actNumber: "Act 70 of 1971", jurisdiction: "central", aliases: ["Contempt of Courts Act"], unit: "section" },
  { id: "general-clauses", name: "General Clauses Act", year: 1897, abbr: "General Clauses Act", actNumber: "Act 10 of 1897", jurisdiction: "central", aliases: ["General Clauses Act"], unit: "section" },
  // State enactments (Karnataka, Telangana, Andhra Pradesh). Act numbers omitted unless certain.
  { id: "ka-land-revenue", name: "Karnataka Land Revenue Act", year: 1964, abbr: "KLR Act", jurisdiction: "state", state: "KA", aliases: ["Karnataka Land Revenue Act", "K.L.R. Act", "KLR Act"], unit: "section" },
  { id: "ka-rent", name: "Karnataka Rent Act", year: 1999, abbr: "Karnataka Rent Act", jurisdiction: "state", state: "KA", aliases: ["Karnataka Rent Act"], unit: "section" },
  { id: "ka-court-fees", name: "Karnataka Court Fees and Suits Valuation Act", year: 1958, abbr: "KCF&SV Act", jurisdiction: "state", state: "KA", aliases: ["Karnataka Court Fees and Suits Valuation Act", "K.C.F. & S.V. Act", "KCF&SV Act", "KCF & SV Act"], unit: "section" },
  { id: "ap-buildings-control", name: "Andhra Pradesh Buildings (Lease, Rent and Eviction) Control Act", year: 1960, abbr: "AP Rent Control Act", jurisdiction: "state", state: "AP", aliases: ["Andhra Pradesh Buildings (Lease, Rent and Eviction) Control Act", "A.P. Buildings (Lease, Rent and Eviction) Control Act"], unit: "section" },
  { id: "ap-rights-in-land", name: "Andhra Pradesh Rights in Land and Pattadar Pass Books Act", year: 1971, abbr: "AP ROR Act", jurisdiction: "state", state: "AP", aliases: ["Andhra Pradesh Rights in Land and Pattadar Pass Books Act", "A.P. Rights in Land and Pattadar Pass Books Act"], unit: "section" },
  { id: "ts-rights-in-land", name: "Telangana Rights in Land and Pattadar Pass Books Act", year: 2020, abbr: "TS ROR Act", jurisdiction: "state", state: "TS", aliases: ["Telangana Rights in Land and Pattadar Pass Books Act"], unit: "section" },
];

const actById = new Map(ACTS.map((a) => [a.id, a]));
export function getAct(id: string | null | undefined): Act | null { return id ? actById.get(id) ?? null : null; }

function aliasKey(s: string): string { return s.toLowerCase().replace(/[.\s]/g, "").replace(/&/g, "and"); }

const actsByAlias = new Map<string, Act[]>();
for (const a of ACTS) for (const al of a.aliases) {
  const k = aliasKey(al);
  const list = actsByAlias.get(k) ?? [];
  if (!list.includes(a)) actsByAlias.set(k, [...list, a]);
}

function aliasPattern(alias: string): string {
  let out = "";
  for (const ch of alias) {
    if (/[A-Za-z0-9]/.test(ch)) out += ch.replace(/[A-Za-z]/, (c) => `[${c.toLowerCase()}${c.toUpperCase()}]`);
    else if (ch === ".") out += "\\.?\\s*";
    else if (ch === " ") out += "\\s*";
    else if (ch === "&") out += "\\s*(?:&|and)\\s*";
    else if (ch === "(" || ch === ")" || ch === "/" || ch === "-" || ch === ",") out += `\\s*\\${ch}?\\s*`;
  }
  return out.replace(/(\\s\*)+$/, "");
}

const ACT_SOURCE = [...new Set(ACTS.flatMap((a) => a.aliases))].sort((a, b) => b.length - a.length).map(aliasPattern).join("|");
const SEC_NUM = "\\d{1,4}(?:-?[A-Z]{1,2}(?![A-Za-z]))?(?:\\s*\\(\\s*\\d{1,3}[A-Za-z]?\\s*\\))*(?:\\s*\\(\\s*[a-z]{1,4}\\s*\\))*";
const SEC_HEAD = "(?:[Ss]ections?|SECTIONS?|[Ss]ecs?\\.?|[Ss]s\\.|[Ss]\\.|[Uu]\\s*/\\s*[Ss]{1,2}\\.?|§§?)";
const SEP = "\\s*(?:,|\\band\\b|&|/|\\bor\\b|\\bread\\s+with\\b|\\br\\s*/\\s*w\\b\\.?|\\br\\.\\s*w\\.)\\s*";
const LIST = `${SEC_NUM}(?:${SEP}(?:${SEC_HEAD}\\s*)?${SEC_NUM})*`;
const ACT_TAIL = `\\s*,?\\s*(?:(?:of|under)\\s+(?:the\\s+)?)?(${ACT_SOURCE})(?:\\s*,?\\s*((?:18|19|20)\\d{2})(?!\\d))?`;
const ART_HEAD = "(?:[Aa]rticles?|ARTICLES?|[Aa]rts?\\.)";
const ROMAN = "[IVXLC]{1,7}";
const RULE_NUM = "\\d{1,3}[A-Z]?(?:\\s*\\(\\s*[a-z0-9]{1,3}\\s*\\))*";
const RULE_SEP = "\\s*(?:,|\\band\\b|&|\\bto\\b|-|–)\\s*";

const SECTION_RE = new RegExp(`(?<![A-Za-z])${SEC_HEAD}\\s*(${LIST})${ACT_TAIL}`, "g");
const ARTICLE_RE = new RegExp(`(?<![A-Za-z])${ART_HEAD}\\s*(${LIST})\\s*,?\\s*(?:of\\s+(?:the\\s+)?)?(Constitution(?:\\s+of\\s+India)?)`, "g");
const ORDER_RE = new RegExp(`(?<![A-Za-z])(?:Order|ORDER|O\\.)\\s*(${ROMAN}|\\d{1,2})\\s*,?\\s*(?:Rules?|RULES?|Rr?\\.)\\s*(${RULE_NUM}(?:${RULE_SEP}${RULE_NUM})*)${ACT_TAIL}`, "g");

export interface StatuteRef {
  raw: string;
  start: number;
  end: number;
  kind: "section" | "article" | "order_rule";
  /** Act text as written. */
  actText: string;
  actId?: string;
  /** Acts the text could refer to when it could not be resolved to one. */
  actCandidates?: string[];
  /** Year written in the text. */
  year?: number;
  /** The Act resolved from an alias without a stated year. */
  yearAssumed?: boolean;
  /** Normalised section / article numbers ("302", "498A", "3(5)", "19(1)(g)"). */
  sections: string[];
  /** CPC Order number (arabic). */
  order?: number;
  rules?: string[];
  issues: string[];
}

export function normalizeSection(s: string): string {
  return s.replace(/\s+/g, "").replace(/^(\d+)-([A-Z])/, "$1$2");
}

function splitList(list: string): string[] {
  const secRe = new RegExp(SEC_NUM, "g");
  const stripped = list.replace(new RegExp(SEC_HEAD, "g"), " ");
  return [...stripped.matchAll(secRe)].map((m) => normalizeSection(m[0]));
}

const ROMAN_VALUES: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100 };
export function romanToInt(r: string): number | null {
  if (!/^[IVXLC]+$/.test(r)) return null;
  let total = 0;
  for (let i = 0; i < r.length; i++) {
    const v = ROMAN_VALUES[r[i]], next = ROMAN_VALUES[r[i + 1]] ?? 0;
    total += v < next ? -v : v;
  }
  return intToRoman(total) === r ? total : null;
}
export function intToRoman(n: number): string {
  const table: [number, string][] = [[100, "C"], [90, "XC"], [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]];
  let out = "";
  for (const [v, s] of table) while (n >= v) { out += s; n -= v; }
  return out;
}

/** Resolve an Act from its written alias and optional year (never guesses between same-named Acts). */
export function resolveAct(actText: string, year?: number): { actId?: string; actCandidates?: string[]; yearAssumed?: boolean; issue?: string } {
  const cands = actsByAlias.get(aliasKey(actText)) ?? [];
  if (!cands.length) return { issue: `Act "${actText}" is not in the coded table` };
  if (year) {
    const hit = cands.find((a) => a.year === year);
    if (hit) return { actId: hit.id };
    return { actCandidates: cands.map((a) => a.id), issue: `no coded "${actText}" of ${year} (coded: ${cands.map((a) => a.year).join(", ")})` };
  }
  if (cands.length > 1) {
    return { actCandidates: cands.map((a) => a.id), issue: `"${actText}" without a year is ambiguous (${cands.map((a) => `${a.name}, ${a.year}`).join(" / ")})` };
  }
  const a = cands[0];
  return { actId: a.id, yearAssumed: a.id === "constitution" ? undefined : true };
}

/** Every statute reference in `text` whose Act is named, left to right, non-overlapping. */
export function extractStatutes(text: string): StatuteRef[] {
  const out: StatuteRef[] = [];
  const push = (ref: StatuteRef) => {
    // A sentence-ending full stop after an undotted abbreviation ("… u/s 420 IPC.") is not part of the reference.
    if (ref.actText.endsWith(".") && !ref.actText.slice(0, -1).includes(".") && !ref.year) {
      ref = { ...ref, actText: ref.actText.slice(0, -1), raw: ref.raw.slice(0, -1), end: ref.end - 1 };
    }
    out.push(ref);
  };
  for (const m of text.matchAll(SECTION_RE)) {
    const year = m[3] ? Number(m[3]) : undefined;
    const r = resolveAct(m[2], year);
    const act = r.actId ? actById.get(r.actId) : undefined;
    const issues = r.issue ? [r.issue] : [];
    if (act?.unit === "article") issues.push("the Constitution is cited by Article, not Section");
    push({ raw: m[0], start: m.index!, end: m.index! + m[0].length, kind: "section", actText: m[2], actId: r.actId, actCandidates: r.actCandidates, year, yearAssumed: r.yearAssumed, sections: splitList(m[1]), issues });
  }
  for (const m of text.matchAll(ARTICLE_RE)) {
    push({ raw: m[0], start: m.index!, end: m.index! + m[0].length, kind: "article", actText: m[2], actId: "constitution", sections: splitList(m[1]), issues: [] });
  }
  for (const m of text.matchAll(ORDER_RE)) {
    const order = /^\d+$/.test(m[1]) ? Number(m[1]) : romanToInt(m[1]);
    const year = m[4] ? Number(m[4]) : undefined;
    const r = resolveAct(m[3], year);
    const issues = r.issue ? [r.issue] : [];
    if (order == null) issues.push(`"${m[1]}" is not a valid Order number`);
    if (r.actId && r.actId !== "cpc") issues.push("Orders and Rules are coded for the Code of Civil Procedure only");
    const rules = [...m[2].matchAll(new RegExp(RULE_NUM, "g"))].map((x) => normalizeSection(x[0]));
    push({ raw: m[0], start: m.index!, end: m.index! + m[0].length, kind: "order_rule", actText: m[3], actId: issues.length ? undefined : r.actId, actCandidates: r.actCandidates, year, yearAssumed: r.yearAssumed, sections: [], order: order ?? undefined, rules, issues });
  }
  out.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: StatuteRef[] = [];
  let lastEnd = -1;
  for (const r of out) { if (r.start >= lastEnd) { kept.push(r); lastEnd = r.end; } }
  return kept;
}

/** Parse one statute reference; null when the string is not exactly one recognised reference. */
export function parseStatuteRef(raw: string): StatuteRef | null {
  const t = raw.trim().replace(/[,;]+$/, "");
  const all = extractStatutes(t);
  return all.length === 1 && all[0].start === 0 && all[0].end === t.length ? all[0] : null;
}

/** Keys for `Judgment.statutes`: "IPC 1860 s.302", "Constitution art.226", "CPC 1908 O.39 R.1". Unresolved Acts yield none. */
export function statuteKeys(ref: StatuteRef): string[] {
  const act = ref.actId ? actById.get(ref.actId) : undefined;
  if (!act) return [];
  if (ref.kind === "article") return ref.sections.map((s) => `Constitution art.${s}`);
  if (ref.kind === "order_rule") return (ref.rules ?? []).map((r) => `${act.abbr} ${act.year} O.${ref.order} R.${r}`);
  return ref.sections.map((s) => `${act.abbr} ${act.year} s.${s}`);
}

function joinList(items: string[]): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * Format a reference: "full" → "Sections 302 and 34 of the Indian Penal Code, 1860"; "short" → "ss. 302 and 34 IPC".
 * Returns null when the Act is unresolved (a formatter never invents an Act).
 */
export function formatStatuteRef(ref: Pick<StatuteRef, "kind" | "actId" | "sections" | "order" | "rules">, style: "full" | "short" = "full"): string | null {
  const act = ref.actId ? actById.get(ref.actId) : undefined;
  if (!act) return null;
  if (ref.kind === "article") {
    const head = ref.sections.length > 1 ? (style === "full" ? "Articles" : "Arts.") : style === "full" ? "Article" : "Art.";
    return style === "full" ? `${head} ${joinList(ref.sections)} of the Constitution of India` : `${head} ${joinList(ref.sections)} of the Constitution`;
  }
  if (ref.kind === "order_rule") {
    if (ref.order == null || !ref.rules?.length) return null;
    const rules = `${ref.rules.length > 1 ? "Rules" : "Rule"} ${joinList(ref.rules)}`;
    return style === "full" ? `Order ${intToRoman(ref.order)} ${rules} of the ${act.name}, ${act.year}` : `Order ${intToRoman(ref.order)} ${rules} ${act.abbr}`;
  }
  if (!ref.sections.length) return null;
  if (style === "full") return `${ref.sections.length > 1 ? "Sections" : "Section"} ${joinList(ref.sections)} of the ${act.name}, ${act.year}`;
  return `${ref.sections.length > 1 ? "ss." : "s."} ${joinList(ref.sections)} ${act.abbr}`;
}

/** Statute reference as a shared `IndianCitation` (kind "statute"). */
export function statuteToCitation(ref: StatuteRef): IndianCitation & { normalized?: string } {
  return { raw: ref.raw, kind: "statute", normalized: formatStatuteRef(ref, "short") ?? undefined };
}
