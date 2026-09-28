/**
 * Indian citation parser (client-safe, deterministic).
 *
 * Parses, normalises and extracts:
 *   - neutral citations: Supreme Court "2024 INSC 735" (dataset form "2024INSC735"); High Courts "2024:KHC:1234",
 *     "2024:KHC-D:7336", "2024:TSHC:…", "2024:APHC:…", "2023:DHC:…", "2023:BHC-AS:…";
 *   - reporters: SCC (and SCC (Cri)/(L&S)/(Civ)/(Tax)), SCC OnLine, AIR, SCR, ILR (Kar), KarLJ, ALT, ALT (Crl), ALD,
 *     ALD (Crl), Cri LJ, SCALE, JT;
 *   - case numbers ("W.P. No. 12345 of 2023 (GM-RES)", "Crl.P. 1234/2024") via the procedure registry;
 *   - CNR numbers (16 characters: state, district, establishment, serial, year).
 *
 * Rules (constitution §23, docs/architecture/india.md):
 *   - `raw` is always kept; normalised fields are filled only when parsing is certain.
 *   - A string that matches no known form is kind "unknown"; nothing is guessed.
 *   - `courtId` is set only when the citation is valid AND the court is certain from the registry. Reporters that
 *     report several courts (KarLJ, ALT, ALD, Cri LJ) carry no court. Unknown prefixes/benches/court tokens are
 *     kept in `unresolvedCourt`, never mapped to the nearest court.
 */
import { bindingEffect, COURTS, courtById, type Court } from "./courts";
import { CASE_NUMBER_SOURCE, formatCaseNumber, resolveCaseType } from "./procedure";
import { extractStatutes, statuteToCitation } from "./statutes";
import type { IndianCitation } from "./types";

export interface ParsedCitation extends IndianCitation {
  /** Offsets into the source text (extractCitations). */
  start?: number;
  end?: number;
  /** Canonical string form ("(2017) 10 SCC 1", "2024:KHC-D:7336"). */
  normalized?: string;
  /** Reporter sub-series: "Supp." (SCR), "Cri"/"L&S"/"Civ"/"Tax" (SCC), "Crl" (ALT/ALD). */
  series?: string;
  /** Court token as printed in the citation ("Kant", "Kar", "SC", "KHC"). */
  courtToken?: string;
  benchId?: string;
  /** Bench / side label from a neutral-citation suffix ("Dharwad", "AS"). */
  benchLabel?: string;
  /** Court or bench token that did not resolve against the registry (never mapped to a nearby court). */
  unresolvedCourt?: string;
  caseTypeId?: string;
  /** Karnataka subject classification on a case number ("GM-RES"). */
  subject?: string;
  cnrState?: string;
  cnrDistrict?: string;
  cnrEstablishment?: string;
  cnrSerial?: number;
  /** False when the form was recognised but a component is impossible or unresolved (future year, unknown bench…). */
  valid: boolean;
  issues: string[];
}

export interface ParseOptions {
  /** Reference date for "year in the future" checks (default: now). */
  now?: Date;
}

const courtByNeutralPrefix = new Map(COURTS.filter((c) => c.neutralCitationPrefix).map((c) => [c.neutralCitationPrefix!, c]));
const courtByCnrPrefix = new Map(COURTS.filter((c) => c.cnrPrefix).map((c) => [c.cnrPrefix!, c]));

/** Neutral-citation bench suffixes that are coded as complete for a court. Other courts' suffixes are kept as labels. */
const NEUTRAL_BENCHES: Record<string, Record<string, { benchId?: string; label: string }>> = {
  KHC: { "": { benchId: "kar-bengaluru", label: "Bengaluru" }, D: { benchId: "kar-dharwad", label: "Dharwad" }, K: { benchId: "kar-kalaburagi", label: "Kalaburagi" } },
};

/** Court tokens in SCC OnLine citations. AP/TS resolve only from 2019 (see `resolveStateToken`). */
const SCC_ONLINE_COURTS: Record<string, string> = {
  SC: "sci", Kar: "hc-karnataka", TS: "hc-telangana", AP: "hc-andhra", Del: "hc-delhi", Bom: "hc-bombay", Mad: "hc-madras", Ker: "hc-kerala",
  Cal: "hc-calcutta", All: "hc-allahabad", Guj: "hc-gujarat", "P&H": "hc-ph", Raj: "hc-rajasthan", MP: "hc-mp", Pat: "hc-patna", Ori: "hc-orissa",
  HP: "hc-hp", Gau: "hc-gauhati", Jhar: "hc-jharkhand", Chh: "hc-chhattisgarh", Utt: "hc-uttarakhand", "J&K": "hc-jk",
};

/** Court tokens in AIR citations. "Kant" is AIR's Karnataka abbreviation; "Kar" is accepted as a common variant. */
const AIR_COURTS: Record<string, string> = {
  SC: "sci", Kant: "hc-karnataka", Kar: "hc-karnataka", AP: "hc-andhra", Del: "hc-delhi", Bom: "hc-bombay", Mad: "hc-madras", Ker: "hc-kerala",
  Cal: "hc-calcutta", All: "hc-allahabad", Guj: "hc-gujarat", "P&H": "hc-ph", Raj: "hc-rajasthan", MP: "hc-mp", Pat: "hc-patna", Ori: "hc-orissa",
  HP: "hc-hp", Gau: "hc-gauhati", Jhar: "hc-jharkhand",
};

/**
 * The present High Courts of Telangana and Andhra Pradesh were constituted on 1 January 2019. Earlier "AP"/"TS"
 * reports are decisions of the predecessor court at Hyderabad, which is not a registry court: left unresolved.
 */
function resolveStateToken(courtId: string, year: number): { courtId?: string; issue?: string } {
  if ((courtId === "hc-andhra" || courtId === "hc-telangana") && year < 2019) {
    return { issue: "decision before 1 Jan 2019 is of the predecessor High Court at Hyderabad; court left unresolved" };
  }
  return { courtId };
}

interface Rule {
  kind: IndianCitation["kind"];
  re: RegExp;
  build(m: RegExpExecArray, now: Date): Omit<ParsedCitation, "raw" | "start" | "end">;
}

const Y = "((?:18|19|20)\\d{2})";
const yearIssues = (y: number, now: Date, min = 1800): string[] =>
  y > now.getUTCFullYear() ? [`year ${y} is in the future`] : y < min ? [`year ${y} is before this form existed (${min})`] : [];

const RULES: Rule[] = [
  // Supreme Court neutral citation: "2024 INSC 735", dataset "2024INSC735".
  {
    kind: "neutral",
    re: new RegExp(`(?<![\\d:])${Y}\\s*INSC\\s*(\\d{1,5})(?![\\d:])`, "g"),
    build(m, now) {
      const year = Number(m[1]), n = Number(m[2]);
      const issues = [...yearIssues(year, now, 1950), ...(n === 0 ? ["number 0 is not a valid neutral citation number"] : [])];
      const neutral = `${year} INSC ${n}`;
      return { kind: "neutral", neutral, normalized: neutral, year, page: undefined, courtToken: "INSC", courtId: issues.length ? undefined : "sci", unresolvedCourt: issues.length ? "INSC" : undefined, valid: !issues.length, issues };
    },
  },
  // High Court neutral citation: "2024:KHC-D:7336", "2023:BHC-AS:1234", "2023:DHC:1234-DB".
  {
    kind: "neutral",
    re: new RegExp(`(?<![\\d:])${Y}\\s*:\\s*([A-Z]{2,8})(?:\\s*-\\s*([A-Z]{1,5}))?\\s*:\\s*(\\d{1,7})(?:-([A-Z]{2,3})\\b)?(?![\\d:])`, "g"),
    build(m, now) {
      const year = Number(m[1]), prefix = m[2], suffix = m[3] ?? "", n = Number(m[4]), qualifier = m[5];
      const issues = [...yearIssues(year, now, 1950), ...(n === 0 ? ["number 0 is not a valid neutral citation number"] : [])];
      const neutral = `${year}:${prefix}${suffix ? `-${suffix}` : ""}:${n}${qualifier ? `-${qualifier}` : ""}`;
      const court = courtByNeutralPrefix.get(prefix);
      let benchId: string | undefined, benchLabel: string | undefined = suffix || undefined;
      if (!court) issues.push(`unknown neutral citation prefix "${prefix}"`);
      else if (court.level === "supreme") issues.push(`Supreme Court neutral citations take the form "YYYY INSC N", not "${neutral}"`);
      else if (NEUTRAL_BENCHES[prefix]) {
        const b = NEUTRAL_BENCHES[prefix][suffix];
        if (!b) issues.push(`unknown bench suffix "${suffix}" for ${prefix}`);
        else { benchId = b.benchId; benchLabel = b.label; }
      }
      const valid = !issues.length;
      return { kind: "neutral", neutral, normalized: neutral, year, courtToken: prefix, courtId: valid ? court?.id : undefined, unresolvedCourt: valid ? undefined : `${prefix}${suffix ? `-${suffix}` : ""}`, benchId: valid ? benchId : undefined, benchLabel, valid, issues };
    },
  },
  // SCC and its sub-series: "(2017) 10 SCC 1", "(2017) 3 SCC (Cri) 123".
  {
    kind: "reporter",
    re: new RegExp(`\\(${Y}\\)\\s*(\\d{1,2})\\s*S\\.?\\s?C\\.?\\s?C\\.?\\s*(?:\\(\\s*(Cri|Crl|L\\s*&\\s*S|Civ|Tax)\\.?\\s*\\)\\s*)?(\\d{1,5})(?!\\d)`, "g"),
    build(m, now) {
      const year = Number(m[1]), volume = Number(m[2]), page = Number(m[4]);
      const series = m[3] ? ({ cri: "Cri", crl: "Cri", civ: "Civ", tax: "Tax" } as Record<string, string>)[m[3].toLowerCase()] ?? "L&S" : undefined;
      const issues = [...yearIssues(year, now, 1969), ...(volume === 0 || page === 0 ? ["volume and page must be positive"] : [])];
      const reporter = series ? `SCC (${series})` : "SCC";
      const valid = !issues.length;
      return { kind: "reporter", reporter, series, year, volume, page, normalized: `(${year}) ${volume} ${reporter} ${page}`, courtToken: "SCC", courtId: valid ? "sci" : undefined, valid, issues };
    },
  },
  // SCC OnLine: "2023 SCC OnLine SC 123", "2022 SCC OnLine Kar 456".
  {
    kind: "reporter",
    re: new RegExp(`(?<!\\d)${Y}\\s+SCC\\s*On\\s*Line\\s+([A-Z][A-Za-z&]{1,4})\\s+(\\d{1,6})(?!\\d)`, "g"),
    build(m, now) {
      const year = Number(m[1]), token = m[2], page = Number(m[3]);
      const issues = [...yearIssues(year, now), ...(page === 0 ? ["page must be positive"] : [])];
      let courtId = SCC_ONLINE_COURTS[token];
      if (!courtId) issues.push(`court token "${token}" is not in the coded SCC OnLine table`);
      else { const r = resolveStateToken(courtId, year); if (r.issue) issues.push(r.issue); courtId = r.courtId!; }
      const valid = !issues.length;
      return { kind: "reporter", reporter: "SCC OnLine", year, page, normalized: `${year} SCC OnLine ${token} ${page}`, courtToken: token, courtId: valid ? courtId : undefined, unresolvedCourt: valid ? undefined : token, valid, issues };
    },
  },
  // AIR: "AIR 1973 SC 1461", "AIR 2005 Kant 12".
  {
    kind: "reporter",
    re: new RegExp(`\\bA\\.?\\s?I\\.?\\s?R\\.?\\s+${Y}\\s+([A-Z][A-Za-z&]{1,4})\\.?\\s+(\\d{1,5})(?!\\d)`, "g"),
    build(m, now) {
      const year = Number(m[1]), token = m[2], page = Number(m[3]);
      const issues = [...yearIssues(year, now, 1914), ...(page === 0 ? ["page must be positive"] : [])];
      let courtId = AIR_COURTS[token];
      if (!courtId) issues.push(`court token "${token}" is not in the coded AIR table`);
      else { const r = resolveStateToken(courtId, year); if (r.issue) issues.push(r.issue); courtId = r.courtId!; }
      const valid = !issues.length;
      return { kind: "reporter", reporter: "AIR", year, page, normalized: `AIR ${year} ${token} ${page}`, courtToken: token, courtId: valid ? courtId : undefined, unresolvedCourt: valid ? undefined : token, valid, issues };
    },
  },
  // SCR: "[1973] Supp. S.C.R. 1", "(1950) SCR 88", "[1973] 1 SCR 12", "[1962] Supp. (3) SCR 1".
  {
    kind: "reporter",
    re: new RegExp(`[\\[(]${Y}[\\])]\\s*(?:(Supp)\\.?\\s*(?:\\(\\s*(\\d{1,2})\\s*\\)\\s*)?|(\\d{1,2})\\s+)?S\\.?\\s?C\\.?\\s?R\\.?\\s*(\\d{1,5})(?!\\d)`, "g"),
    build(m, now) {
      const year = Number(m[1]), supp = !!m[2], suppVol = m[3] ? Number(m[3]) : undefined, volume = m[4] ? Number(m[4]) : suppVol, page = Number(m[5]);
      const issues = [...yearIssues(year, now, 1950), ...(page === 0 ? ["page must be positive"] : [])];
      const vol = supp ? `Supp.${suppVol ? ` (${suppVol})` : ""} ` : volume ? `${volume} ` : "";
      const valid = !issues.length;
      return { kind: "reporter", reporter: "SCR", series: supp ? "Supp." : undefined, year, volume, page, normalized: `[${year}] ${vol}SCR ${page}`, courtToken: "SCR", courtId: valid ? "sci" : undefined, valid, issues };
    },
  },
  // ILR Karnataka series: "ILR 2005 Kar 1234", "ILR 2005 KAR 1234".
  {
    kind: "reporter",
    re: new RegExp(`\\bI\\.?\\s?L\\.?\\s?R\\.?\\s+${Y}\\s+(Kar|KAR|Kant)\\.?\\s+(\\d{1,5})(?!\\d)`, "g"),
    build(m, now) {
      const year = Number(m[1]), page = Number(m[3]);
      const issues = [...yearIssues(year, now), ...(page === 0 ? ["page must be positive"] : [])];
      const valid = !issues.length;
      return { kind: "reporter", reporter: "ILR (Kar)", year, page, normalized: `ILR ${year} Kar ${page}`, courtToken: "Kar", courtId: valid ? "hc-karnataka" : undefined, valid, issues };
    },
  },
  // Regional / subject journals with a volume: "2019 (2) KarLJ 45", "(2019) 2 ALT 123", "2019 (1) ALT (Crl) 45", "(2023) 5 SCALE 123".
  {
    kind: "reporter",
    re: new RegExp(`(?:(?<![\\d(])${Y}\\s*\\(\\s*(\\d{1,2})\\s*\\)|\\(${Y}\\)\\s*(\\d{1,2}))\\s*(Kar\\.?\\s?L\\.?\\s?J\\.?|KarLJ|A\\.?L\\.?T\\.?|A\\.?L\\.?D\\.?|SCALE|Scale)\\s*(?:\\(\\s*(Crl|Cri)\\.?\\s*\\)\\s*)?(\\d{1,5})(?!\\d)`, "g"),
    build(m, now) {
      const year = Number(m[1] ?? m[3]), volume = Number(m[2] ?? m[4]), page = Number(m[7]);
      const j = m[5].replace(/[.\s]/g, "").toUpperCase();
      const base = j === "KARLJ" ? "KarLJ" : j === "ALT" ? "ALT" : j === "ALD" ? "ALD" : "SCALE";
      const crl = !!m[6];
      const issues = [...yearIssues(year, now), ...(volume === 0 || page === 0 ? ["volume and page must be positive"] : [])];
      if (crl && (base === "KarLJ" || base === "SCALE")) issues.push(`${base} has no (Crl) series in the coded table`);
      const reporter = crl ? `${base} (Crl)` : base;
      const valid = !issues.length;
      const normalized = base === "SCALE" ? `(${year}) ${volume} SCALE ${page}` : `${year} (${volume}) ${reporter} ${page}`;
      // SCALE reports the Supreme Court only; KarLJ/ALT/ALD report several courts, so no court is inferred.
      return { kind: "reporter", reporter, series: crl ? "Crl" : undefined, year, volume, page, normalized, courtToken: base, courtId: valid && base === "SCALE" ? "sci" : undefined, valid, issues };
    },
  },
  // Criminal Law Journal: "2006 Cri LJ 1234" (continuous pagination, no volume).
  {
    kind: "reporter",
    re: new RegExp(`(?<!\\d)${Y}\\s+(?:Cri|Crl|Cr)\\.?\\s?L\\.?\\s?J\\.?\\s+(\\d{1,5})(?!\\d)`, "g"),
    build(m, now) {
      const year = Number(m[1]), page = Number(m[2]);
      const issues = [...yearIssues(year, now), ...(page === 0 ? ["page must be positive"] : [])];
      return { kind: "reporter", reporter: "Cri LJ", year, page, normalized: `${year} Cri LJ ${page}`, valid: !issues.length, issues };
    },
  },
  // Judgments Today: "JT 2023 (5) SC 123".
  {
    kind: "reporter",
    re: new RegExp(`\\bJ\\.?\\s?T\\.?\\s+${Y}\\s*\\(\\s*(\\d{1,2})\\s*\\)\\s*SC\\s+(\\d{1,5})(?!\\d)`, "g"),
    build(m, now) {
      const year = Number(m[1]), volume = Number(m[2]), page = Number(m[3]);
      const issues = [...yearIssues(year, now), ...(volume === 0 || page === 0 ? ["volume and page must be positive"] : [])];
      const valid = !issues.length;
      return { kind: "reporter", reporter: "JT", year, volume, page, normalized: `JT ${year} (${volume}) SC ${page}`, courtToken: "SC", courtId: valid ? "sci" : undefined, valid, issues };
    },
  },
  // CNR: KAHC020000022024 = state KA + district/court HC + establishment 02 + serial 000002 + year 2024.
  {
    kind: "cnr",
    re: /\b([A-Z]{2})([A-Z]{2})(\d{2})(\d{6})(\d{4})\b/g,
    build(m, now) {
      const cnr = m[0], year = Number(m[5]), serial = Number(m[4]);
      const issues = [...yearIssues(year, now, 1950), ...(serial === 0 ? ["serial number 0 is not valid"] : [])];
      const court = courtByCnrPrefix.get(`${m[1]}${m[2]}`);
      const valid = !issues.length;
      return { kind: "cnr", cnr, normalized: cnr, year, cnrState: m[1], cnrDistrict: m[2], cnrEstablishment: m[3], cnrSerial: serial, courtId: valid ? court?.id : undefined, valid, issues };
    },
  },
  // Case numbers from the procedure registry: "W.P. No. 12345 of 2023 (GM-RES)", "Crl.P. 1234/2024".
  {
    kind: "case_number",
    re: new RegExp(CASE_NUMBER_SOURCE, "g"),
    build(m, now) {
      const t = resolveCaseType(m[1]);
      const number = Number(m[2]), year = Number(m[3]), subject = m[4]?.replace(/\s+/g, "");
      if (!t) return { kind: "unknown", valid: false, issues: [`unknown case type "${m[1]}"`] };
      const issues = [...yearIssues(year, now, 1950), ...(number === 0 ? ["case number 0 is not valid"] : [])];
      const caseNumber = formatCaseNumber(t, number, year, subject);
      // A case number alone does not identify the court (the same series exists in many courts).
      return { kind: "case_number", caseNumber, normalized: caseNumber, year, caseTypeId: t.id, subject, valid: !issues.length, issues };
    },
  },
];

/** Every citation-like span in `text`, left to right, non-overlapping (earliest start, then longest match wins). */
export function extractCitations(text: string, opts: ParseOptions & { statutes?: boolean } = {}): ParsedCitation[] {
  const now = opts.now ?? new Date();
  const found: ParsedCitation[] = [];
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.re.exec(text))) {
      const built = rule.build(m, now);
      found.push({ ...built, raw: m[0], start: m.index, end: m.index + m[0].length });
      if (m[0].length === 0) rule.re.lastIndex++;
    }
  }
  if (opts.statutes) {
    for (const s of extractStatutes(text)) found.push({ ...statuteToCitation(s), start: s.start, end: s.end, valid: !!s.actId && !s.issues.length, issues: s.issues });
  }
  found.sort((a, b) => a.start! - b.start! || b.end! - a.end!);
  const out: ParsedCitation[] = [];
  let lastEnd = -1;
  for (const c of found) {
    if (c.start! < lastEnd) continue;
    out.push(c);
    lastEnd = c.end!;
  }
  return out;
}

/**
 * Parse one citation string. The whole string (ignoring surrounding whitespace and trailing punctuation) must be a
 * single recognised form; anything else is kind "unknown" with the raw text preserved.
 */
export function parseCitation(raw: string, opts: ParseOptions = {}): ParsedCitation {
  const trimmed = raw.trim().replace(/[,;:]+$/, "").replace(/(\d)\.$/, "$1");
  const all = extractCitations(trimmed, opts);
  if (all.length === 1 && all[0].start === 0 && all[0].end === trimmed.length) {
    const { start: _s, end: _e, ...rest } = all[0];
    void _s; void _e;
    return { ...rest, raw };
  }
  return { raw, kind: "unknown", valid: false, issues: [all.length ? "text contains more than a single citation" : "not a recognised Indian citation form"] };
}

/** Normalised string form (the `normalized` field), or null for unknown citations. */
export function normalizeCitation(raw: string, opts: ParseOptions = {}): string | null {
  const p = parseCitation(raw, opts);
  return p.kind === "unknown" ? null : p.normalized ?? null;
}

/** Strip parser extras down to the shared `IndianCitation` contract. */
export function toIndianCitation(p: ParsedCitation): IndianCitation {
  const out: IndianCitation = { raw: p.raw, kind: p.kind };
  for (const k of ["neutral", "reporter", "year", "volume", "page", "courtId", "caseNumber", "cnr"] as const) {
    if (p[k] !== undefined) (out as unknown as Record<string, unknown>)[k] = p[k];
  }
  return out;
}

/** Court of a parsed citation from the registry (null when not certain). */
export function citationCourt(c: Pick<IndianCitation, "courtId">): Court | null {
  return courtById(c.courtId);
}

/**
 * Binding effect of a cited decision in `forum`. "unknown" whenever the citation's court is not certain — the
 * caller must not treat an unresolved authority as binding or as persuasive.
 */
export function citationBindingEffect(c: Pick<IndianCitation, "courtId">, forum: Court): "binding" | "persuasive" | "unknown" {
  const court = citationCourt(c);
  return court ? bindingEffect(court, forum) : "unknown";
}

/** Deduplication key: court + normalised form. Two courts never share a key even when numbers coincide. */
export function citationKey(c: ParsedCitation): string {
  return `${c.kind}|${c.courtId ?? c.unresolvedCourt ?? "?"}|${c.normalized ?? c.raw.trim()}`;
}
