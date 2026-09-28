/**
 * Indian citation style (client-safe, deterministic): the India replacement for the Bluebook builder.
 *
 * Case citations are neutral-citation-first, then the preferred reporter, joined SCC-style with " : ":
 *   "Kesavananda Bharati v. State of Kerala, (1973) 4 SCC 225"
 *   "X v. Y, 2024 INSC 735 : (2024) 10 SCC 1, para 45"
 *   "X v. Y, 2024:KHC-D:7336, paras 12–14"
 * Unreported decisions cite the case number, court and date: "X v. Y (W.P. No. 12345 of 2023, High Court of
 * Karnataka, decided on 12 March 2024)".
 *
 * The formatter never invents a citation: every neutral/reporter string is parsed by `citations.ts` and an
 * unparseable or invalid one is reported as an error and left out. Short forms follow Indian practice
 * ("Kesavananda Bharati (supra), para 45"; "Ibid., para 12"), and two different authorities whose short names
 * collide (same party names in Karnataka and Telangana) are always disambiguated by their citation.
 */
import { courtById } from "./courts";
import type { LocaleCode, TranslationOrigin } from "./languages";
import { languageInfo } from "./languages";
import { parseCitation, type ParsedCitation } from "./citations";
import { getAct, intToRoman, type StatuteRef } from "./statutes";

export interface CaseAuthority {
  /** Stable id of the authority in the caller's registry (optional; identity otherwise comes from the citation). */
  id?: string;
  caseName: string;
  neutral?: string;
  /** Reporter citations as printed ("(1973) 4 SCC 225", "AIR 1973 SC 1461"). */
  reporters?: string[];
  /** Registry court id; checked against the court the citations resolve to. */
  courtId?: string;
  /** Unreported decisions: case number and decision date (YYYY-MM-DD). */
  caseNumber?: string;
  decisionDate?: string;
  /** When the cited text is a translation, its origin is shown (machine translations are always labelled). */
  translation?: { language: LocaleCode; origin: TranslationOrigin };
}

/** Pinpoint paragraphs: 45 → "para 45"; [12, 14] range → "paras 12–14"; list → "paras 3, 7 and 9". */
export type Pinpoint = number | { from: number; to: number } | number[] | string;

export interface FormatOptions {
  pinpoint?: Pinpoint;
  /** Include every valid parallel citation (default true). */
  parallel?: boolean;
  /** Case-name emphasis: none (plain), markdown (*name*), html (<i>name</i>). */
  emphasis?: "none" | "markdown" | "html";
}

export interface FormattedCitation {
  citation: string | null;
  /** Short form for later references ("Kesavananda Bharati (supra)"). */
  short: string | null;
  errors: string[];
  /** Parsed citations actually used, in output order. */
  used: ParsedCitation[];
  /** Registry court the citations resolve to (null when not certain). */
  courtId: string | null;
}

/** "vs." / "Vs" / "versus" / "v/s" → "v."; whitespace collapsed. Party names are not abbreviated. */
export function normalizeCaseName(name: string): string {
  return name.replace(/\s+/g, " ").trim().replace(/\s+(?:[Vv][Ss]\.?|[Vv]ersus|VERSUS|[Vv]\/[Ss]\.?|v\.?)\s+/g, " v. ").replace(/[\s,;:]+$/, "");
}

export function formatPinpoint(p: Pinpoint | undefined): string {
  if (p === undefined || p === null) return "";
  if (typeof p === "string") return p.trim() ? `, ${p.trim()}` : "";
  if (typeof p === "number") return `, para ${p}`;
  if (Array.isArray(p)) {
    const xs = [...new Set(p)].sort((a, b) => a - b);
    if (!xs.length) return "";
    if (xs.length === 1) return `, para ${xs[0]}`;
    return `, paras ${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
  }
  return p.from === p.to ? `, para ${p.from}` : `, paras ${p.from}–${p.to}`;
}

const REPORTER_RANK: Record<string, number> = { SCC: 0, SCR: 1, "SCC OnLine": 2, AIR: 3, "ILR (Kar)": 4, KarLJ: 5, ALT: 6, ALD: 7, "ALT (Crl)": 8, "ALD (Crl)": 9, "Cri LJ": 10, SCALE: 11, JT: 12 };
const rank = (c: ParsedCitation) => (c.kind === "neutral" ? -1 : REPORTER_RANK[c.reporter ?? ""] ?? 20);

function emphasize(name: string, mode: FormatOptions["emphasis"]): string {
  if (mode === "markdown") return `*${name}*`;
  if (mode === "html") return `<i>${name.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</i>`;
  return name;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** "2024-03-12" → "12 March 2024". */
export function formatIndianDate(iso: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return null;
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

function translationLabel(t: CaseAuthority["translation"]): string {
  if (!t || t.origin === "original") return "";
  const lang = languageInfo(t.language)?.name ?? t.language;
  const kind = t.origin === "machine" ? "machine translation" : t.origin === "court_published" ? "court-published translation" : "provider translation";
  return ` [${kind}, ${lang}]`;
}

/** First party of the case name, used for short forms ("Kesavananda Bharati v. State of Kerala" → "Kesavananda Bharati"). */
export function shortCaseName(name: string): string {
  return normalizeCaseName(name).split(/\s+v\.\s+/)[0].trim();
}

/** Format a case citation. Returns `citation: null` with errors when nothing citable remains. */
export function formatCaseCitation(a: CaseAuthority, opts: FormatOptions = {}): FormattedCitation {
  const errors: string[] = [];
  const name = normalizeCaseName(a.caseName ?? "");
  if (!name) errors.push("caseName is required");
  const parsed: ParsedCitation[] = [];
  for (const raw of [a.neutral, ...(a.reporters ?? [])].filter((x): x is string => !!x && !!x.trim())) {
    const p = parseCitation(raw);
    if (p.kind !== "neutral" && p.kind !== "reporter") errors.push(`"${raw}" is not a recognised neutral or reporter citation`);
    else if (!p.valid) errors.push(`"${raw}": ${p.issues.join("; ")}`);
    else if (!parsed.some((q) => q.normalized === p.normalized)) parsed.push(p);
  }
  if (a.neutral && !parsed.some((p) => p.kind === "neutral")) errors.push("neutral citation could not be used");
  parsed.sort((x, y) => rank(x) - rank(y));

  const courts = new Set(parsed.map((p) => p.courtId).filter(Boolean));
  if (courts.size > 1) errors.push(`citations resolve to different courts (${[...courts].join(", ")})`);
  const resolvedCourt = courts.size === 1 ? [...courts][0]! : null;
  if (a.courtId && resolvedCourt && a.courtId !== resolvedCourt) errors.push(`courtId ${a.courtId} does not match the citation's court ${resolvedCourt}`);
  const courtId = resolvedCourt ?? a.courtId ?? null;

  const pin = formatPinpoint(opts.pinpoint);
  const label = translationLabel(a.translation);
  const shortName = name ? shortCaseName(name) : "";
  if (errors.length) return { citation: null, short: null, errors, used: parsed, courtId };

  if (parsed.length) {
    const used = opts.parallel === false ? parsed.slice(0, 1) : parsed;
    return { citation: `${emphasize(name, opts.emphasis)}, ${used.map((p) => p.normalized).join(" : ")}${pin}${label}`, short: `${emphasize(shortName, opts.emphasis)} (supra)`, errors, used, courtId };
  }
  // Unreported: case number + court + date.
  if (!a.caseNumber?.trim()) errors.push("a neutral citation, a reporter citation or a case number is required");
  const court = courtById(a.courtId);
  if (!court) errors.push("courtId (registry) is required for an unreported decision");
  const date = a.decisionDate ? formatIndianDate(a.decisionDate) : null;
  if (!date) errors.push("decisionDate (YYYY-MM-DD) is required for an unreported decision");
  if (errors.length) return { citation: null, short: null, errors, used: [], courtId };
  return { citation: `${emphasize(name, opts.emphasis)} (${a.caseNumber!.trim()}, ${court!.name}, decided on ${date})${pin}${label}`, short: `${emphasize(shortName, opts.emphasis)} (supra)`, errors, used: [], courtId };
}

/** Identity of an authority for supra/ibid and de-duplication: never the case name alone. */
export function authorityKey(a: CaseAuthority): string {
  if (a.id) return `id:${a.id}`;
  const f = formatCaseCitation(a);
  if (f.used.length) return `cite:${f.courtId ?? "?"}:${f.used[0].normalized}`;
  return `unrep:${a.courtId ?? "?"}:${(a.caseNumber ?? "").replace(/\s+/g, " ").trim()}:${a.decisionDate ?? ""}:${normalizeCaseName(a.caseName)}`;
}

/**
 * Sequential citing in a document: full citation on first reference, "Ibid." when the same authority was cited
 * immediately before, otherwise "Short (supra)". When two different authorities share a short name, the full case
 * name is used; when the full names are identical too, the primary citation is added ("Ramesh v. State (supra,
 * 2024:KHC:100)").
 */
export class CitationTracker {
  private seen = new Map<string, CaseAuthority>();
  private last: string | null = null;
  private known: CaseAuthority[] = [];

  /** Register every authority the document cites up front so collisions are detected before the first short form. */
  constructor(allAuthorities: CaseAuthority[] = []) {
    this.known = [...allAuthorities];
  }

  cite(a: CaseAuthority, pinpoint?: Pinpoint, opts: Omit<FormatOptions, "pinpoint"> = {}): { text: string | null; form: "full" | "supra" | "ibid"; errors: string[] } {
    const key = authorityKey(a);
    if (!this.known.some((k) => authorityKey(k) === key)) this.known.push(a);
    const full = formatCaseCitation(a, { ...opts, pinpoint });
    if (!full.citation) return { text: null, form: "full", errors: full.errors };
    const pin = formatPinpoint(pinpoint);
    if (this.last === key) { this.last = key; return { text: `Ibid.${pin}`, form: "ibid", errors: [] }; }
    if (!this.seen.has(key)) { this.seen.set(key, a); this.last = key; return { text: full.citation, form: "full", errors: [] }; }
    this.last = key;
    const others = this.known.filter((k) => authorityKey(k) !== key);
    const name = normalizeCaseName(a.caseName), short = shortCaseName(name);
    let label = short;
    if (others.some((o) => shortCaseName(o.caseName) === short)) label = name;
    let suffix = "";
    if (others.some((o) => normalizeCaseName(o.caseName) === name)) suffix = `, ${full.used[0]?.normalized ?? a.caseNumber ?? ""}`;
    return { text: `${emphasize(label, opts.emphasis)} (supra${suffix})${pin}`, form: "supra", errors: [] };
  }
}

/* ───────────────────────────── Table of authorities ───────────────────────────── */

export interface ToaCase { key: string; citation: string; caseName: string; courtId: string | null }
export interface ToaStatute { actId: string; title: string; provisions: string[] }
export interface ToaGroup { heading: "Supreme Court of India" | "High Courts" | "Other courts and tribunals" | "Court not identified" | "Constitution and statutes"; cases?: ToaCase[]; statutes?: ToaStatute[] }
export interface TableOfAuthorities { groups: ToaGroup[]; errors: { caseName: string; errors: string[] }[] }

const sortName = (s: string) => s.replace(/^(?:the|in re:?|in the matter of)\s+/i, "").toLowerCase();

/**
 * Group authorities for a Table of Authorities: Supreme Court, High Courts (sorted by court then name), other courts,
 * authorities whose court is not identified (never folded into a court), then the Constitution and statutes.
 * Duplicates (same authority key) appear once. Statutes are merged per Act.
 */
export function buildTableOfAuthorities(cases: CaseAuthority[], statutes: Pick<StatuteRef, "kind" | "actId" | "sections" | "order" | "rules">[] = []): TableOfAuthorities {
  const errors: TableOfAuthorities["errors"] = [];
  const byKey = new Map<string, ToaCase>();
  for (const a of cases) {
    const f = formatCaseCitation(a);
    if (!f.citation) { errors.push({ caseName: a.caseName, errors: f.errors }); continue; }
    const key = authorityKey(a);
    if (!byKey.has(key)) byKey.set(key, { key, citation: f.citation, caseName: normalizeCaseName(a.caseName), courtId: f.courtId });
  }
  const all = [...byKey.values()];
  const level = (c: ToaCase) => courtById(c.courtId)?.level ?? null;
  const byName = (x: ToaCase, y: ToaCase) => sortName(x.caseName).localeCompare(sortName(y.caseName)) || x.citation.localeCompare(y.citation);
  const groups: ToaGroup[] = [];
  const sc = all.filter((c) => level(c) === "supreme").sort(byName);
  const hc = all.filter((c) => level(c) === "high").sort((x, y) => (courtById(x.courtId)!.name.localeCompare(courtById(y.courtId)!.name)) || byName(x, y));
  const other = all.filter((c) => level(c) === "district" || level(c) === "tribunal").sort(byName);
  const unknown = all.filter((c) => level(c) === null).sort(byName);
  if (sc.length) groups.push({ heading: "Supreme Court of India", cases: sc });
  if (hc.length) groups.push({ heading: "High Courts", cases: hc });
  if (other.length) groups.push({ heading: "Other courts and tribunals", cases: other });
  if (unknown.length) groups.push({ heading: "Court not identified", cases: unknown });

  const acts = new Map<string, Set<string>>();
  for (const s of statutes) {
    const act = getAct(s.actId);
    if (!act) continue;
    const set = acts.get(act.id) ?? new Set<string>();
    if (s.kind === "order_rule") { if (s.order != null) for (const r of s.rules ?? []) set.add(`O. ${intToRoman(s.order)} R. ${r}`); }
    else for (const sec of s.sections) set.add(s.kind === "article" ? `Art. ${sec}` : `s. ${sec}`);
    acts.set(act.id, set);
  }
  if (acts.size) {
    const list: ToaStatute[] = [...acts.entries()].map(([id, set]) => {
      const act = getAct(id)!;
      const provisions = [...set].sort((x, y) => x.localeCompare(y, undefined, { numeric: true }));
      return { actId: id, title: act.id === "constitution" ? act.name : `${act.name}, ${act.year}`, provisions };
    }).sort((x, y) => (x.actId === "constitution" ? -1 : y.actId === "constitution" ? 1 : x.title.localeCompare(y.title)));
    groups.push({ heading: "Constitution and statutes", statutes: list });
  }
  return { groups, errors };
}

export function tableOfAuthoritiesMarkdown(toa: TableOfAuthorities, title = "Table of Authorities"): string {
  const lines = [`## ${title}`, ""];
  for (const g of toa.groups) {
    lines.push(`### ${g.heading}`, "");
    if (g.cases) {
      let lastCourt: string | null = null;
      for (const c of g.cases) {
        if (g.heading === "High Courts" && c.courtId !== lastCourt) { lines.push(`**${courtById(c.courtId)?.name ?? ""}**`, ""); lastCourt = c.courtId; }
        lines.push(`- ${c.citation}`);
      }
    }
    if (g.statutes) for (const s of g.statutes) lines.push(`- ${s.title} — ${s.provisions.join(", ")}`);
    lines.push("");
  }
  if (toa.errors.length) {
    lines.push("### Not included (citation could not be verified)", "");
    for (const e of toa.errors) lines.push(`- ${e.caseName}: ${e.errors.join("; ")}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}
