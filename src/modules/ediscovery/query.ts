/**
 * Review search query language (pure, client-safe, unit-tested).
 *
 *   toxicology AND (rat OR bioassay) NOT marketing
 *   "monitoring well" custodian:hegde type:email date:2002-07
 *   MFC-0041877–MFC-0041999            (Bates range, en dash, hyphen or "to")
 *   from:kapur date:2001-03-01..2001-03-31   -draft
 *   liver w/5 study            (proximity: within 5 words, either order)
 *   "rat study" pre/3 results  (ordered proximity: left before right within 3 words)
 *   hot:yes priv:wp responsive:no hasattachment:yes dupes:near family:MFC-0041877 thread:t_whitfield
 *   Ex.P7   exhibit:D3   ex:"Ex.P1 to P25"   M.O.2   (Indian exhibit marks: exact mark, never a prefix)
 *
 * Adjacent terms are implicitly AND-ed. `-term` is NOT. Precedence: NOT > w/N, pre/N > AND > OR.
 * Field prefixes (Everlaw-style fielded lists): bates, family, thread, custodian, from, to, cc,
 * subject, date, type, issue, tag, hot, priv, responsive, hasattachment, dupes, pages, reviewer, hash, id.
 */

import { formatExhibitMark, parseExhibitMark, parseExhibitRange } from "./india";

/** Display form of an `exhibit:` value ("ex.p1..ex.p25" → "Ex.P1 to Ex.P25"). */
export function exhibitValueLabel(value: string): string {
  return value.split("..").map((v) => parseExhibitMark(v)?.canonical ?? v).join(" to ");
}

export type QueryNode =
  | { kind: "term"; value: string; phrase: boolean }
  | { kind: "and"; children: QueryNode[] }
  | { kind: "or"; children: QueryNode[] }
  | { kind: "not"; child: QueryNode }
  | { kind: "field"; field: QueryField; value: string }
  | { kind: "bates"; start: BatesNumber; end: BatesNumber }
  | { kind: "date"; from?: string; to?: string }
  | { kind: "prox"; left: QueryNode; right: QueryNode; distance: number; ordered: boolean }
  | { kind: "empty" };

export type QueryField = "custodian" | "type" | "from" | "to" | "cc" | "subject" | "date" | "bates" | "issue" | "tag" | "hash" | "id" | "family" | "thread" | "hot" | "priv" | "responsive" | "hasattachment" | "dupes" | "pages" | "reviewer" | "exhibit";
const FIELDS: QueryField[] = ["custodian", "type", "from", "to", "cc", "subject", "date", "bates", "issue", "tag", "hash", "id", "family", "thread", "hot", "priv", "responsive", "hasattachment", "dupes", "pages", "reviewer", "exhibit"];
/** Field aliases: `ex:` and `exh:` are `exhibit:`. */
const FIELD_ALIASES: Record<string, QueryField> = { ex: "exhibit", exh: "exhibit" };
/** Field names shown in syntax help, with the values they accept. */
export const QUERY_FIELDS: { field: QueryField; hint: string }[] = [
  { field: "exhibit", hint: "exhibit mark Ex.P7, Ex.D3, Ex.P5(a), M.O.2 or a range Ex.P1 to P25 (exact mark)" },
  { field: "bates", hint: "document / production number MFC-0041877 or a range MFC-0041877–MFC-0041999" },
  { field: "family", hint: "Bates or id of any family member (parent + attachments)" },
  { field: "thread", hint: "thread id, or a Bates/id of a message in the thread" },
  { field: "custodian", hint: "name or id (substring)" },
  { field: "from", hint: "sender (substring)" },
  { field: "to", hint: "recipient (substring)" },
  { field: "cc", hint: "cc recipient (substring)" },
  { field: "subject", hint: "subject (substring, quote phrases)" },
  { field: "date", hint: "2001, 2001-03, 2001-03-14, a..b, >a, <b" },
  { field: "type", hint: "email, memo, report, spreadsheet, presentation…" },
  { field: "issue", hint: "issue code, e.g. TOX-01" },
  { field: "tag", hint: "document tag" },
  { field: "hot", hint: "yes | no" },
  { field: "priv", hint: "yes | no | none | ac | wp | ci | jd (basis)" },
  { field: "responsive", hint: "yes | no | none (uncoded)" },
  { field: "hasattachment", hint: "yes | no" },
  { field: "dupes", hint: "yes | no | exact | near" },
  { field: "pages", hint: "3, >10, <=2, 2..5" },
  { field: "reviewer", hint: "reviewer id or name (substring)" },
];

export interface BatesNumber { prefix: string; number: number; width: number; raw: string }

export interface ParsedQuery {
  ast: QueryNode;
  terms: string[]; // positive terms/phrases for highlighting
  fields: { field: QueryField; value: string }[];
  bates: { start: BatesNumber; end: BatesNumber }[];
  warnings: string[];
  raw: string;
}

// ---------------------------------------------------------------------------
// Bates numbers
// ---------------------------------------------------------------------------

const BATES_RE = /^([A-Za-z]{2,8})[-_ ]?(\d{4,10})$/;

export function parseBates(raw: string): BatesNumber | null {
  const m = raw.trim().match(BATES_RE);
  if (!m) return null;
  return { prefix: m[1].toUpperCase(), number: Number(m[2]), width: m[2].length, raw: raw.trim() };
}

export function formatBates(prefix: string, number: number, width = 7) {
  return `${prefix}-${String(number).padStart(width, "0")}`;
}

/** Compare two Bates numbers of the same prefix; different prefixes sort by prefix. */
export function compareBates(a: string, b: string): number {
  const pa = parseBates(a);
  const pb = parseBates(b);
  if (!pa || !pb) return a.localeCompare(b);
  if (pa.prefix !== pb.prefix) return pa.prefix.localeCompare(pb.prefix);
  return pa.number - pb.number;
}

/**
 * Parse "MFC-0041877–MFC-0041999", "MFC-0041877 - MFC-0041999", "MFC-0041877 to 0041999",
 * "MFC-0041877-0041999" or a single Bates number (start == end).
 */
export function parseBatesRange(raw: string): { start: BatesNumber; end: BatesNumber } | null {
  const s = raw.trim().replace(/\s+/g, " ");
  const single = parseBates(s);
  if (single) return { start: single, end: single };
  const m = s.match(/^([A-Za-z]{2,8}[-_ ]?\d{4,10})\s*(?:–|—|-|to|\.\.)\s*((?:[A-Za-z]{2,8}[-_ ]?)?\d{4,10})$/i);
  if (!m) return null;
  const start = parseBates(m[1]);
  if (!start) return null;
  // An abbreviated end ("…-0041999") inherits the prefix; its raw form is canonicalised so chips and cites read "MFC-0041999".
  const end = parseBates(m[2]) ?? { prefix: start.prefix, number: Number(m[2]), width: m[2].length, raw: formatBates(start.prefix, Number(m[2]), Math.max(start.width, m[2].length)) };
  if (end.prefix !== start.prefix) return null;
  if (end.number < start.number) return { start: end, end: start };
  return { start, end };
}

export function batesInRange(bates: string, range: { start: BatesNumber; end: BatesNumber }, batesEnd?: string) {
  const b = parseBates(bates);
  if (!b || b.prefix !== range.start.prefix) return false;
  const lo = b.number;
  const hi = batesEnd ? (parseBates(batesEnd)?.number ?? lo) : lo;
  return hi >= range.start.number && lo <= range.end.number;
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type Token =
  | { t: "lparen" }
  | { t: "rparen" }
  | { t: "and" }
  | { t: "or" }
  | { t: "not" }
  | { t: "phrase"; v: string }
  | { t: "word"; v: string }
  | { t: "field"; f: QueryField; v: string }
  | { t: "prox"; n: number; ordered: boolean }
  | { t: "bates"; start: BatesNumber; end: BatesNumber };

const PROX_RE = /^(w|pre|near)\/(\d{1,3})$/i;

/** An exhibit mark, optionally followed by a same-side range end: "Ex.P1", "Ex. P-1", "Ex.P5(a)", "Ex.P1 to P25", "M.O.2". */
const EXHIBIT_TOKEN_RE = /^(?:Exh?(?:ibit)?\.?\s?(?:No\.?\s?)?[PDCABRX]\s?[-.]?\s?\d{1,4}(?:\([a-z]{1,2}\))?(?:\s*(?:–|—|to|-)\s*(?:Exh?\.?\s?)?[PDCABRX]\s?[-.]?\s?\d{1,4})?|(?:M\.\s?O\.\s?|MO-)\d{1,4})(?=$|[\s()])/i;

/**
 * Normalised value of an `exhibit:` token: a canonical mark ("ex.p7", "ex.p5(a)", "m.o.2") or a range
 * ("ex.p1..ex.p25"). Null when the text is not an exhibit mark.
 */
export function exhibitFieldValue(raw: string): string | null {
  const single = parseExhibitMark(raw);
  if (single) return single.canonical.toLowerCase();
  const r = parseExhibitRange(raw);
  if (!r) return null;
  const fmt = (n: number) => formatExhibitMark(r.side, n).toLowerCase();
  return r.from === r.to ? fmt(r.from) : `${fmt(r.from)}..${fmt(r.to)}`;
}

/** Match a document's canonical (lowercased) exhibit mark against an `exhibit:` value: exact mark or same-side range. */
export function exhibitMatches(docMark: string | undefined, value: string): boolean {
  if (!docMark) return false;
  const range = value.split("..");
  if (range.length === 1) return docMark === value;
  const lo = parseExhibitMark(range[0]);
  const hi = parseExhibitMark(range[1]);
  const d = parseExhibitMark(docMark);
  return !!lo && !!hi && !!d && !d.sub && d.side === lo.side && d.side === hi.side && d.number >= lo.number && d.number <= hi.number;
}

const RANGE_RE = /^([A-Za-z]{2,8}[-_]?\d{4,10})\s*(?:–|—|-|to)\s*((?:[A-Za-z]{2,8}[-_]?)?\d{4,10})/i;

function tokenize(input: string, warnings: string[]): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const s = input;
  const isSpace = (c: string) => /\s/.test(c);
  while (i < s.length) {
    const c = s[i];
    if (isSpace(c)) { i++; continue; }
    if (c === "(") { tokens.push({ t: "lparen" }); i++; continue; }
    if (c === ")") { tokens.push({ t: "rparen" }); i++; continue; }
    if (c === '"' || c === "“") {
      const close = c === '"' ? '"' : "”";
      let j = i + 1;
      while (j < s.length && s[j] !== close && s[j] !== '"') j++;
      if (j >= s.length) warnings.push("Unclosed quote");
      const v = s.slice(i + 1, j).trim();
      if (v) tokens.push({ t: "phrase", v });
      i = j + 1;
      continue;
    }
    const rest = s.slice(i);
    // Exhibit mark or range starting here ("Ex.P7", "Ex. P-7", "Ex.P1 to P25", "M.O.2"): an exact-mark field token.
    const em = rest.match(EXHIBIT_TOKEN_RE);
    if (em) {
      const v = exhibitFieldValue(em[0]);
      if (v) { tokens.push({ t: "field", f: "exhibit", v }); i += em[0].length; continue; }
    }
    // Bates range starting here? (bare, or after a `bates:` prefix — the range may contain spaces: "bates:MFC-0041877 to 0041880")
    const prefixed = rest.match(/^bates:\s*/i);
    const rm = rest.slice(prefixed?.[0].length ?? 0).match(RANGE_RE);
    // "MFC-0041877 -2001" is a Bates number followed by a negated term, not a range: a bare hyphen that
    // follows whitespace only joins a range when the end carries its own prefix (or a bates: prefix was given).
    const negatedTail = !!rm && !prefixed && /\s-\s*\d/.test(rm[0].slice(rm[1].length)) && !/[A-Za-z]/.test(rm[2]);
    if (rm && !negatedTail && parseBates(rm[1])) {
      const range = parseBatesRange(rm[0]);
      if (range) { tokens.push({ t: "bates", ...range }); i += (prefixed?.[0].length ?? 0) + rm[0].length; continue; }
    }
    // word / field
    let j = i;
    while (j < s.length && !isSpace(s[j]) && s[j] !== "(" && s[j] !== ")") {
      if (s[j] === ":" && j + 1 < s.length && (s[j + 1] === '"' || s[j + 1] === "“")) {
        // field:"quoted value"
        const close = s[j + 1] === '"' ? '"' : "”";
        let k = j + 2;
        while (k < s.length && s[k] !== close && s[k] !== '"') k++;
        j = Math.min(k + 1, s.length);
        break;
      }
      j++;
    }
    const word = s.slice(i, j);
    i = j;
    if (!word) continue;
    const up = word.toUpperCase();
    if (up === "AND" || up === "&&") { tokens.push({ t: "and" }); continue; }
    if (up === "OR" || up === "||") { tokens.push({ t: "or" }); continue; }
    if (up === "NOT" || up === "!") { tokens.push({ t: "not" }); continue; }
    if (word.startsWith("-") && word.length > 1) { tokens.push({ t: "not" }); tokens.push(...tokenize(word.slice(1), warnings)); continue; }
    const pm = word.match(PROX_RE);
    if (pm) { tokens.push({ t: "prox", n: Math.max(1, Number(pm[2])), ordered: pm[1].toLowerCase() === "pre" }); continue; }
    const colon = word.indexOf(":");
    if (colon > 0) {
      const fRaw = word.slice(0, colon).toLowerCase();
      const f = (FIELD_ALIASES[fRaw] ?? fRaw) as QueryField;
      let v = word.slice(colon + 1).replace(/^["“]|["”]$/g, "").trim();
      if (FIELDS.includes(f)) {
        if (v && f === "exhibit") {
          const ev = exhibitFieldValue(v) ?? exhibitFieldValue(`Ex.${v}`);
          if (ev) tokens.push({ t: "field", f, v: ev });
          else warnings.push(`Unrecognised exhibit mark "${v}"`);
          continue;
        }
        if (v) {
          if (f === "bates") {
            const range = parseBatesRange(v);
            if (range) { tokens.push({ t: "bates", ...range }); continue; }
            warnings.push(`Unrecognised Bates value "${v}"`);
            continue;
          }
          v = v.toLowerCase();
          tokens.push({ t: "field", f, v });
        } else warnings.push(`Empty value for ${f}:`);
        continue;
      }
    }
    const single = parseBates(word);
    if (single && /^[A-Za-z]{2,8}[-_]\d{4,10}$/.test(word)) { tokens.push({ t: "bates", start: single, end: single }); continue; }
    tokens.push({ t: "word", v: word.toLowerCase() });
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser (precedence: NOT > AND (implicit) > OR)
// ---------------------------------------------------------------------------

class Parser {
  pos = 0;
  constructor(private tokens: Token[], private warnings: string[]) {}
  peek() { return this.tokens[this.pos]; }
  next() { return this.tokens[this.pos++]; }

  parseOr(): QueryNode {
    const children = [this.parseAnd()];
    while (this.peek()?.t === "or") { this.next(); children.push(this.parseAnd()); }
    const real = children.filter((c) => c.kind !== "empty");
    if (!real.length) return { kind: "empty" };
    return real.length === 1 ? real[0] : { kind: "or", children: real };
  }

  parseAnd(): QueryNode {
    const children: QueryNode[] = [];
    while (true) {
      const tk = this.peek();
      if (!tk || tk.t === "or" || tk.t === "rparen") break;
      if (tk.t === "and") { this.next(); continue; }
      children.push(this.parseNot());
    }
    const real = children.filter((c) => c.kind !== "empty");
    if (!real.length) return { kind: "empty" };
    return real.length === 1 ? real[0] : { kind: "and", children: real };
  }

  parseNot(): QueryNode {
    if (this.peek()?.t === "not") {
      this.next();
      const child = this.parseNot();
      return child.kind === "empty" ? child : { kind: "not", child };
    }
    return this.parseProx();
  }

  /** `a w/5 b`, `"x y" pre/3 z`: proximity binds tighter than the implicit AND. */
  parseProx(): QueryNode {
    let left = this.parseAtom();
    while (this.peek()?.t === "prox") {
      const op = this.next() as { t: "prox"; n: number; ordered: boolean };
      const right = this.parseAtom();
      if (left.kind === "empty") { left = right; continue; }
      if (right.kind === "empty") { this.warnings.push(`Missing right operand for ${op.ordered ? "pre" : "w"}/${op.n}`); continue; }
      left = { kind: "prox", left, right, distance: op.n, ordered: op.ordered };
    }
    return left;
  }

  parseAtom(): QueryNode {
    const tk = this.next();
    if (!tk) return { kind: "empty" };
    switch (tk.t) {
      case "lparen": {
        const inner = this.parseOr();
        if (this.peek()?.t === "rparen") this.next();
        else this.warnings.push("Missing closing parenthesis");
        return inner;
      }
      case "rparen":
        this.warnings.push("Unexpected closing parenthesis");
        return { kind: "empty" };
      case "phrase":
        return { kind: "term", value: tk.v.toLowerCase(), phrase: true };
      case "word":
        return { kind: "term", value: tk.v, phrase: false };
      case "field":
        if (tk.f === "date") return parseDateExpr(tk.v, this.warnings);
        return { kind: "field", field: tk.f, value: tk.v };
      case "bates":
        return { kind: "bates", start: tk.start, end: tk.end };
      case "and":
      case "or":
      case "not":
        return { kind: "empty" };
      case "prox":
        this.warnings.push(`Missing left operand for ${tk.ordered ? "pre" : "w"}/${tk.n}`);
        return { kind: "empty" };
    }
  }
}

function parseDateExpr(v: string, warnings: string[]): QueryNode {
  // 2001 | 2001-03 | 2001-03-14 | 2001-03-01..2001-03-31 | >2001-03-01 | <2002 | >=… | <=…
  const norm = v.replace(/\//g, "-");
  const range = norm.match(/^(\d{4}(?:-\d{2}(?:-\d{2})?)?)\.\.(\d{4}(?:-\d{2}(?:-\d{2})?)?)$/);
  if (range) return { kind: "date", from: expandDate(range[1], "start"), to: expandDate(range[2], "end") };
  const cmp = norm.match(/^(>=|<=|>|<)(\d{4}(?:-\d{2}(?:-\d{2})?)?)$/);
  if (cmp) {
    const d = cmp[2];
    if (cmp[1] === ">=") return { kind: "date", from: expandDate(d, "start") };
    if (cmp[1] === ">") return { kind: "date", from: nextDay(expandDate(d, "end")) };
    if (cmp[1] === "<=") return { kind: "date", to: expandDate(d, "end") };
    return { kind: "date", to: prevDay(expandDate(d, "start")) };
  }
  if (/^\d{4}(-\d{2}(-\d{2})?)?$/.test(norm)) return { kind: "date", from: expandDate(norm, "start"), to: expandDate(norm, "end") };
  warnings.push(`Unrecognised date "${v}" (use YYYY, YYYY-MM, YYYY-MM-DD, a..b, >a, <b)`);
  return { kind: "empty" };
}

function expandDate(d: string, edge: "start" | "end") {
  if (d.length === 4) return edge === "start" ? `${d}-01-01` : `${d}-12-31`;
  if (d.length === 7) {
    if (edge === "start") return `${d}-01`;
    const [y, m] = d.split("-").map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return `${d}-${String(last).padStart(2, "0")}`;
  }
  return d;
}
function shiftDay(d: string, delta: number) {
  const t = new Date(d + "T00:00:00Z");
  t.setUTCDate(t.getUTCDate() + delta);
  return t.toISOString().slice(0, 10);
}
const nextDay = (d: string) => shiftDay(d, 1);
const prevDay = (d: string) => shiftDay(d, -1);

export function parseQuery(input: string): ParsedQuery {
  const warnings: string[] = [];
  const raw = input ?? "";
  const tokens = tokenize(raw, warnings);
  const parser = new Parser(tokens, warnings);
  let ast = parser.parseOr();
  if (parser.pos < tokens.length) {
    // stray tokens (e.g. unmatched ")") — parse remainder and AND it in
    const rest = parser.parseOr();
    if (rest.kind !== "empty") ast = ast.kind === "empty" ? rest : { kind: "and", children: [ast, rest] };
  }
  const terms: string[] = [];
  const fields: ParsedQuery["fields"] = [];
  const bates: ParsedQuery["bates"] = [];
  collect(ast, false, terms, fields, bates);
  return { ast, terms: Array.from(new Set(terms)), fields, bates, warnings, raw };
}

function collect(node: QueryNode, negated: boolean, terms: string[], fields: ParsedQuery["fields"], bates: ParsedQuery["bates"]) {
  switch (node.kind) {
    case "term": if (!negated) terms.push(node.value); break;
    case "and": case "or": node.children.forEach((c) => collect(c, negated, terms, fields, bates)); break;
    case "not": collect(node.child, !negated, terms, fields, bates); break;
    case "prox": collect(node.left, negated, terms, fields, bates); collect(node.right, negated, terms, fields, bates); break;
    case "field": fields.push({ field: node.field, value: node.value }); break;
    case "bates": bates.push({ start: node.start, end: node.end }); break;
    case "date": fields.push({ field: "date", value: `${node.from ?? ""}..${node.to ?? ""}` }); break;
    default: break;
  }
}

export function isEmptyQuery(q: ParsedQuery) { return q.ast.kind === "empty"; }

// ---------------------------------------------------------------------------
// Evaluation against a searchable document projection
// ---------------------------------------------------------------------------

export interface Searchable {
  id: string;
  bates: string;
  batesEnd?: string;
  date: string;
  custodian: string; // lowercased name + id
  type: string; // lowercased
  from: string; // lowercased
  to: string; // lowercased, joined
  cc: string;
  subject: string; // lowercased
  haystack: string; // lowercased: subject + text + from/to + custodian + bates
  issues: string; // lowercased codes joined
  tags: string;
  hash: string;
  // Fielded-list values (all optional so hand-built projections in tests keep working).
  hot?: boolean;
  privileged?: boolean | null;
  privilegeBasis?: string;
  responsive?: boolean | null;
  attachments?: number;
  isAttachment?: boolean;
  /** Family key: the parent's id (or own id for a parent), plus every member's Bates, lowercased and space-joined. */
  family?: string;
  /** Thread id plus the Bates/ids of the messages in the thread, lowercased and space-joined. */
  thread?: string;
  isDuplicate?: boolean;
  nearDuplicates?: number;
  pages?: number;
  reviewer?: string;
  /** Canonical exhibit mark, lowercased ("ex.p7"); absent when the document is not marked. */
  exhibit?: string;
  /** Lazily tokenised haystack for proximity searches. */
  words?: string[];
}

const WORD_RE = /[a-z0-9][a-z0-9'’\-]*/g;

/** Word tokens of a lowercased haystack (cached on the projection). */
export function wordsOf(doc: Searchable): string[] {
  if (!doc.words) doc.words = doc.haystack.match(WORD_RE) ?? [];
  return doc.words;
}

/** Start positions where a term (a word or a phrase of words) occurs in the word list. */
export function termPositions(words: string[], term: string): number[] {
  const parts = term.toLowerCase().match(WORD_RE) ?? [];
  if (!parts.length) return [];
  const out: number[] = [];
  for (let i = 0; i + parts.length <= words.length; i++) {
    let ok = true;
    for (let j = 0; j < parts.length; j++) { if (words[i + j] !== parts[j]) { ok = false; break; } }
    if (ok) out.push(i);
  }
  return out;
}

/** True when some occurrence of `left` sits within `distance` words of some occurrence of `right` (ordered: left first). */
export function withinDistance(left: number[], right: number[], distance: number, ordered: boolean): boolean {
  if (!left.length || !right.length) return false;
  for (const a of left) for (const b of right) {
    const d = ordered ? b - a : Math.abs(b - a);
    if (d >= (ordered ? 1 : 0) && d <= distance && !(a === b)) return true;
  }
  return false;
}

const YES = new Set(["yes", "y", "true", "1"]);
const NO = new Set(["no", "n", "false", "0"]);
function yesNo(v: string): boolean | null { return YES.has(v) ? true : NO.has(v) ? false : null; }

function numberMatch(n: number | undefined, v: string): boolean {
  if (n == null) return false;
  const range = v.match(/^(\d+)\.\.(\d+)$/);
  if (range) return n >= Number(range[1]) && n <= Number(range[2]);
  const cmp = v.match(/^(>=|<=|>|<)(\d+)$/);
  if (cmp) { const x = Number(cmp[2]); return cmp[1] === ">" ? n > x : cmp[1] === ">=" ? n >= x : cmp[1] === "<" ? n < x : n <= x; }
  return /^\d+$/.test(v) && n === Number(v);
}

export function matchesQuery(doc: Searchable, node: QueryNode): boolean {
  switch (node.kind) {
    case "empty": return true;
    case "term": return doc.haystack.includes(node.value);
    case "and": return node.children.every((c) => matchesQuery(doc, c));
    case "or": return node.children.some((c) => matchesQuery(doc, c));
    case "not": return !matchesQuery(doc, node.child);
    case "bates": return batesInRange(doc.bates, node, doc.batesEnd);
    case "date": return (!node.from || doc.date >= node.from) && (!node.to || doc.date <= node.to);
    case "prox": {
      // Proximity only makes sense between terms; anything else degrades to AND.
      if (node.left.kind !== "term" || node.right.kind !== "term") return matchesQuery(doc, node.left) && matchesQuery(doc, node.right);
      const words = wordsOf(doc);
      return withinDistance(termPositions(words, node.left.value), termPositions(words, node.right.value), node.distance, node.ordered);
    }
    case "field": {
      const v = node.value;
      switch (node.field) {
        case "custodian": return doc.custodian.includes(v);
        case "type": return doc.type.startsWith(v) || (v === "email" && doc.type === "email") || (v === "deck" && doc.type === "presentation");
        case "from": return doc.from.includes(v);
        case "to": return doc.to.includes(v);
        case "cc": return doc.cc.includes(v);
        case "subject": return doc.subject.includes(v);
        case "issue": return doc.issues.includes(v);
        case "tag": return doc.tags.includes(v);
        case "hash": return doc.hash.startsWith(v);
        case "id": return doc.id.toLowerCase() === v;
        case "family": return (doc.family ?? "").split(" ").includes(v) || (doc.family ?? "").includes(v);
        case "thread": return (doc.thread ?? "").split(" ").includes(v) || (doc.thread ?? "").includes(v);
        case "hot": { const b = yesNo(v); return b == null ? true : !!doc.hot === b; }
        case "priv": {
          if (v === "none" || v === "uncoded") return doc.privileged == null;
          const b = yesNo(v);
          if (b != null) return b ? doc.privileged === true : doc.privileged !== true;
          const basis: Record<string, string> = { ac: "attorney-client", "attorney-client": "attorney-client", wp: "work-product", "work-product": "work-product", ci: "common-interest", "common-interest": "common-interest", jd: "joint-defense", "joint-defense": "joint-defense" };
          return doc.privileged === true && (doc.privilegeBasis ?? "attorney-client") === (basis[v] ?? v);
        }
        case "responsive": {
          if (v === "none" || v === "uncoded" || v === "null") return doc.responsive == null;
          const b = yesNo(v);
          return b == null ? true : doc.responsive === b;
        }
        case "hasattachment": { const b = yesNo(v); return b == null ? true : ((doc.attachments ?? 0) > 0) === b; }
        case "dupes": {
          if (v === "exact") return !!doc.isDuplicate;
          if (v === "near") return (doc.nearDuplicates ?? 0) > 0;
          const b = yesNo(v);
          return b == null ? true : (!!doc.isDuplicate || (doc.nearDuplicates ?? 0) > 0) === b;
        }
        case "pages": return numberMatch(doc.pages, v);
        case "reviewer": return (doc.reviewer ?? "").includes(v);
        case "exhibit": return exhibitMatches(doc.exhibit, v);
        default: return true;
      }
    }
  }
}

/** Build a regex that highlights the query's positive terms (phrases first). */
export function highlightRegex(terms: string[]): RegExp | null {
  const parts = terms.filter((t) => t.length > 1).sort((a, b) => b.length - a.length).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"));
  if (!parts.length) return null;
  return new RegExp(`(${parts.join("|")})`, "gi");
}

/** Short excerpt around the first matching term. */
export function makeSnippet(text: string, terms: string[], radius = 110): string {
  const lower = text.toLowerCase();
  let idx = -1;
  for (const t of terms) { const i = lower.indexOf(t); if (i >= 0 && (idx < 0 || i < idx)) idx = i; }
  const clean = (s: string) => s.replace(/\s+/g, " ").trim();
  if (idx < 0) return clean(text.slice(0, radius * 2)) + (text.length > radius * 2 ? "…" : "");
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + radius);
  return (start > 0 ? "…" : "") + clean(text.slice(start, end)) + (end < text.length ? "…" : "");
}
