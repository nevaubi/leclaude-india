/**
 * Citation parsing (constitution §23 exact source identity). Pure and client-safe.
 *
 * Recognizes Bates numbers and ranges (ABC-0001234–0001240, DEF_00012, MFC-0041877 – MFC-0041880), deposition
 * page:line cites (Smith Dep. 45:12–46:3, Deposition of Hema Vasudevan, 45:12, Vasudevan Tr. Vol. 2, 12:4), exhibit
 * references (Ex. 12, Exhibit Vasudevan-3, Vasudevan Ex. 3), docket entries (ECF No. 2600, Dkt. 15, D.E. 12) and reporter
 * citations (550 U.S. 544, 860 F.3d 249, 716 F. Supp. 2d 100). Parsing never touches the record; resolution
 * against the record happens in `resolve.ts`, strictly inside a MatterScope.
 *
 * Text is data: instructions embedded in a document ("ignore previous instructions…") are just characters to the
 * parser, so hostile content cannot change the shape or semantics of what comes out.
 */

export type ParsedCitation =
  | { type: "bates"; raw: string; prefix: string; start: number; end?: number; width: number; key: string; excludedReason?: string }
  | { type: "deposition"; raw: string; witness: string; volume?: number; page: number; line: number; pageEnd?: number; lineEnd?: number; key: string }
  | { type: "exhibit"; raw: string; witness?: string; exhibit: string; key: string }
  | { type: "docket"; raw: string; entry: number; key: string }
  | { type: "reporter"; raw: string; volume: number; reporter: string; page: number; pin?: number; key: string }
  | { type: "unknown"; raw: string; key: string };

export type CitationType = ParsedCitation["type"];

/** Uppercase tokens that look like Bates prefixes but are case numbers, standards or rule cites. */
export const NOT_BATES_PREFIXES: ReadonlySet<string> = new Set(["MDL", "ECF", "DKT", "DOC", "NO", "CIV", "CV", "CR", "CASE", "ISO", "RFC", "USC", "CFR", "FR", "PL", "HR", "SB", "HB", "FY", "CY", "Q", "VOL", "ID", "PMID", "DOI", "NCT", "SKU", "PO", "RE"]);

/** Lazy so a separator-less token (ABC000123456) splits as the shortest letter prefix plus the longest digit run. */
const BATES_PREFIX = "[A-Z]{2,}[A-Z0-9]*?(?:[-_][A-Z]{2,}[A-Z0-9]*?)*?";
const BATES_RE = new RegExp(`\\b(${BATES_PREFIX})([-_ ]?)(\\d{4,9})\\b`, "g");
const BATES_RANGE_RE = new RegExp(`^\\s*(?:[–—-]|to|through)\\s*(?:(${BATES_PREFIX})[-_ ]?)?(\\d{4,9})\\b`);

const NAME = "[A-Z][\\w'’.-]*";
const DEPO_RE = new RegExp(`\\b((?:${NAME}\\s+){0,2}${NAME})\\s+(?:Dep(?:o(?:sition)?)?\\.?|Tr\\.?|Test(?:imony)?\\.?)(?:\\s*(?:Vol(?:ume)?\\.?|v\\.)\\s*(\\d{1,2}|[IVX]{1,4})\\b[,.]?)?\\s*(?:at\\s+|pp?\\.\\s*)?(\\d{1,4}):(\\d{1,2})\\b(?:\\s*[–—-]\\s*(?:(\\d{1,4}):)?(\\d{1,2})\\b)?`, "g");
const DEPO_OF_RE = new RegExp(`\\bDeposition of ((?:${NAME}\\s+){0,3}${NAME}),?\\s*(?:\\(?Vol(?:ume)?\\.?\\s*(\\d{1,2}|[IVX]{1,4})\\)?[,.]?\\s*)?(?:at\\s+|pp?\\.\\s*)?(\\d{1,4}):(\\d{1,2})\\b(?:\\s*[–—-]\\s*(?:(\\d{1,4}):)?(\\d{1,2})\\b)?`, "g");
/** Bare page:line (24:05, 142:8–143:2); clock times (10:30 a.m.) are skipped. */
const PAGE_LINE_RE = /\b(\d{1,4}):(\d{1,2})\b(?:\s*[–—-]\s*(?:(\d{1,4}):)?(\d{1,2})\b)?(?!\s*(?:[ap]\.?m\b|[ap]\.m\.|(?:AM|PM)\b))/g;
const EXHIBIT_RE = new RegExp(`\\b(?:(${NAME})\\s+)?(?:Dep(?:o(?:sition)?)?\\.?\\s+)?Ex(?:h\\.?|hibit)?\\.?\\s*(?:No\\.?\\s*)?([A-Z][\\w]*-\\d{1,4}|\\d{1,4}[A-Z]?|[A-Z]{1,2})(?![\\w-])`, "g");
const DOCKET_RE = /\b(?:ECF|Dkt\.?|Docket(?:\s+Entry)?|D\.E\.|Doc\.)\s*(?:No\.?\s*)?#?\s*(\d{1,6})\b/g;
const REPORTER_RE = /\b(\d{1,4})\s+(U\.\s?S\.|S\.\s?Ct\.|L\.\s?Ed\.(?:\s?2d)?|F\.\s?(?:2d|3d|4th)|F\.\s?Supp\.(?:\s?(?:2d|3d))?|F\.\s?R\.\s?D\.|Fed\.\s?App'?x\.?|B\.R\.|[A-Z]\.[A-Z]\.(?:[A-Z]\.)?(?:\s?(?:2d|3d))?|[A-Z][a-z]{1,4}\.(?:\s?(?:App\.|Supp\.)\s?)?(?:\s?(?:2d|3d|4th|5th))?)\s+(\d{1,5})\b(?:,\s*(\d{1,5})\b)?/g;
const NOT_REPORTERS: ReadonlySet<string> = new Set(["Jan.", "Feb.", "Mar.", "Apr.", "Jun.", "Jul.", "Aug.", "Sep.", "Sept.", "Oct.", "Nov.", "Dec.", "No.", "Nos.", "Vol.", "Ch.", "Sec.", "Art.", "Fig.", "Tab.", "Ex.", "Exh.", "Pt.", "Para.", "Id.", "Dep.", "Tr.", "Ed.", "Rev."]);

const ROMAN: Record<string, number> = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10 };

/** Words that precede a cite but are not part of a witness name ("See Vasudevan Dep.", "Compare Hegde Tr."). */
const LEAD_IN_RE = /^(?:(?:See|Cf\.?|Compare|Also|And|But|Per|At|In|On|The|Id\.?|Accord|Citing|Quoting|Contra|E\.g\.?|Generally|Trial|Hearing|Plaintiffs?|Defendants?|Joint|Pl\.?|Def\.?)\s+)+/i;

/** Strip lead-in words from a captured name; returns the name and how many characters were dropped. */
function stripLeadIn(name: string): { name: string; dropped: number } {
  const m = LEAD_IN_RE.exec(name);
  if (!m || m[0].length >= name.length) return { name, dropped: 0 };
  return { name: name.slice(m[0].length), dropped: m[0].length };
}

function volumeNumber(v: string | undefined): number | undefined {
  if (!v) return undefined;
  if (/^\d+$/.test(v)) return Number(v);
  return ROMAN[v.toUpperCase()];
}

/** Surname used for matching: the last token of the cited name, without possessives or trailing punctuation. */
export function surnameOf(name: string): string {
  const tokens = name.trim().split(/\s+/).filter(Boolean);
  const last = tokens[tokens.length - 1] ?? "";
  return last.replace(/['’]s$/i, "").replace(/[.,;:]+$/, "").toLowerCase();
}

export interface BatesToken { prefix: string; number: number; width: number }

/** Parse one Bates token such as MFC-0041877 or DEF_00012; null when it is not one. */
export function parseBatesToken(s: string): BatesToken | null {
  const m = new RegExp(`^\\s*(${BATES_PREFIX})[-_ ]?(\\d{4,9})\\s*$`).exec(s ?? "");
  if (!m) return null;
  return { prefix: m[1].toUpperCase(), number: Number(m[2]), width: m[2].length };
}

export function formatBates(prefix: string, n: number, width: number, separator = "-"): string {
  return `${prefix}${separator}${String(n).padStart(width, "0")}`;
}

function batesKey(prefix: string, start: number, end?: number): string {
  return `bates:${prefix}:${start}${end != null ? `:${end}` : ""}`;
}

function reporterKey(volume: number, reporter: string, page: number): string {
  return `${volume} ${reporter.replace(/\s+/g, "")} ${page}`;
}

/** Canonical comparison key for a reporter citation string ("550 U. S. 544" and "550 U.S. 544" agree); null when unparseable. */
export function reporterCiteKey(cite: string): string | null {
  const re = new RegExp(REPORTER_RE.source);
  const m = re.exec(cite ?? "");
  if (!m || NOT_REPORTERS.has(m[2].trim())) return null;
  return reporterKey(Number(m[1]), m[2], Number(m[3]));
}

interface Span { start: number; end: number; cite: ParsedCitation }

function overlaps(spans: Span[], start: number, end: number): boolean {
  return spans.some((s) => start < s.end && end > s.start);
}

function bates(text: string, spans: Span[]) {
  const re = new RegExp(BATES_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const [, rawPrefix, sep, digits] = m;
    const prefix = rawPrefix.toUpperCase();
    if (sep !== "-" && sep !== "_" && digits.length < 6) continue; // "FY 2024", "COVID 2019"
    const start = m.index;
    let end = start + m[0].length;
    let rangeEnd: number | undefined;
    const tail = BATES_RANGE_RE.exec(text.slice(end, end + 40));
    if (tail && (!tail[1] || tail[1].toUpperCase() === prefix)) {
      const n = Number(tail[2]);
      if (n >= Number(digits)) {
        rangeEnd = n;
        end += tail[0].length;
        re.lastIndex = end;
      }
    }
    if (overlaps(spans, start, end)) continue;
    const startN = Number(digits);
    const cite: ParsedCitation = { type: "bates", raw: text.slice(start, end), prefix, start: startN, end: rangeEnd, width: digits.length, key: batesKey(prefix, startN, rangeEnd) };
    if (NOT_BATES_PREFIXES.has(prefix.split(/[-_]/)[0])) cite.excludedReason = `${prefix} is a case-number or rule prefix, not a Bates prefix`;
    spans.push({ start, end, cite });
  }
}

function depositions(text: string, spans: Span[]) {
  for (const src of [DEPO_RE, DEPO_OF_RE]) {
    const re = new RegExp(src.source, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const stripped = src === DEPO_RE ? stripLeadIn(m[1]) : { name: m[1], dropped: 0 };
      const start = m.index + stripped.dropped;
      const end = m.index + m[0].length;
      if (overlaps(spans, start, end)) continue;
      const witness = stripped.name.trim();
      const volume = volumeNumber(m[2]);
      const page = Number(m[3]);
      const line = Number(m[4]);
      const pageEnd = m[5] ? Number(m[5]) : undefined;
      const lineEnd = m[6] ? Number(m[6]) : undefined;
      const key = `depo:${surnameOf(witness)}:${volume ?? ""}:${page}:${line}:${pageEnd ?? ""}:${lineEnd ?? ""}`;
      spans.push({ start, end, cite: { type: "deposition", raw: text.slice(start, end).trim(), witness, volume, page, line, pageEnd, lineEnd, key } });
    }
  }
}

function barePageLines(text: string, spans: Span[]) {
  const re = new RegExp(PAGE_LINE_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const start = m.index;
    const end = start + m[0].length;
    if (overlaps(spans, start, end)) continue;
    const page = Number(m[1]);
    const line = Number(m[2]);
    if (line > 60) continue; // 12:75 is not a transcript line
    const pageEnd = m[3] ? Number(m[3]) : undefined;
    const lineEnd = m[4] ? Number(m[4]) : undefined;
    spans.push({ start, end, cite: { type: "deposition", raw: m[0].trim(), witness: "", page, line, pageEnd, lineEnd, key: `depo::${page}:${line}:${pageEnd ?? ""}:${lineEnd ?? ""}` } });
  }
}

function exhibits(text: string, spans: Span[]) {
  const re = new RegExp(EXHIBIT_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const end = m.index + m[0].length;
    const captured = m[1]?.trim();
    // "See Ex. 3": a leading capitalized word is only a witness when it is not a citation lead-in.
    const isLeadIn = !!captured && (LEAD_IN_RE.test(`${captured} `) || /^Deposition$/i.test(captured));
    let start = m.index;
    if (isLeadIn) {
      // group 1 opens the match, so the raw cite begins after the lead-in word and the whitespace that follows it
      const rest = m[0].slice(captured!.length);
      start += captured!.length + (rest.length - rest.trimStart().length);
    }
    if (overlaps(spans, start, end)) continue;
    const witness = isLeadIn ? undefined : captured;
    const exhibit = m[2];
    spans.push({ start, end, cite: { type: "exhibit", raw: text.slice(start, end).trim(), witness, exhibit, key: `ex:${witness ? surnameOf(witness) : ""}:${exhibit.toLowerCase()}` } });
  }
}

function dockets(text: string, spans: Span[]) {
  const re = new RegExp(DOCKET_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const start = m.index;
    const end = start + m[0].length;
    if (overlaps(spans, start, end)) continue;
    const entry = Number(m[1]);
    spans.push({ start, end, cite: { type: "docket", raw: m[0].trim(), entry, key: `dkt:${entry}` } });
  }
}

function reporters(text: string, spans: Span[]) {
  const re = new RegExp(REPORTER_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const reporter = m[2].trim();
    if (NOT_REPORTERS.has(reporter)) continue;
    const start = m.index;
    const end = start + m[0].length;
    if (overlaps(spans, start, end)) continue;
    const volume = Number(m[1]);
    const page = Number(m[3]);
    const pin = m[4] ? Number(m[4]) : undefined;
    spans.push({ start, end, cite: { type: "reporter", raw: m[0].trim(), volume, reporter, page, pin, key: `rep:${reporterKey(volume, reporter, page)}${pin != null ? `:${pin}` : ""}` } });
  }
}

/**
 * Every citation in `text`, in document order, de-duplicated by canonical key, non-overlapping. Specific forms
 * win over general ones (a witnessed page:line beats a bare page:line; a docket number beats a Bates lookalike).
 */
export function extractCitations(text: string): ParsedCitation[] {
  const spans: Span[] = [];
  const t = text ?? "";
  dockets(t, spans);
  depositions(t, spans);
  exhibits(t, spans);
  bates(t, spans);
  reporters(t, spans);
  barePageLines(t, spans);
  spans.sort((a, b) => a.start - b.start);
  const seen = new Set<string>();
  const out: ParsedCitation[] = [];
  for (const s of spans) {
    if (seen.has(s.cite.key)) continue;
    seen.add(s.cite.key);
    out.push(s.cite);
  }
  return out;
}

/** Parse one citation string. A string with no recognizable form parses as `unknown`. */
export function parseCitation(raw: string): ParsedCitation {
  const found = extractCitations(raw ?? "");
  if (found.length === 1) return found[0];
  if (found.length > 1) {
    // Prefer the most specific single cite that spans the whole string; otherwise the first.
    const whole = found.find((c) => c.raw.trim() === (raw ?? "").trim());
    return whole ?? found[0];
  }
  return { type: "unknown", raw: (raw ?? "").trim(), key: `unknown:${(raw ?? "").trim().toLowerCase()}` };
}
