/**
 * Parser for the BPR&D "Correspondence table and comparison summary" documents (pure, deterministic, client-safe).
 *
 * Input: the markdown of the publisher's PDF as extracted page by page (pages separated by a line "---"; each page a
 * markdown table). Output: one ConcordanceRow per table row, with the cells kept verbatim and every doubt flagged.
 * The parser never fills a cell it cannot read: an unreadable row is kept as `unparsed`, a cell with leftover text is
 * flagged `old_cell_residue`, a section number lower than the previous row's is flagged `out_of_sequence`.
 */
import type { ConcordanceFlag, ConcordanceRelation, ConcordanceRow, ConcordanceSection, ConcordanceSummaries, ConcordanceTableId } from "./types";

export const CONCORDANCE_PARSER_VERSION = 1;

/** Column order of each document's table. */
export const TABLE_COLUMNS: Record<ConcordanceTableId, { newCol: number; subjectCol: number; oldCol: number; summaryCol: number }> = {
  "ipc-bns": { newCol: 0, subjectCol: 1, oldCol: 2, summaryCol: 3 },
  "crpc-bnss": { newCol: 0, subjectCol: 1, oldCol: 2, summaryCol: 3 },
  "iea-bsa": { newCol: 0, oldCol: 1, subjectCol: 2, summaryCol: 3 },
};

const ENTITIES: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " };

export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n: string) => ENTITIES[n.toLowerCase()] ?? m);
}

const NOISE = /[　-鿿가-힯]/;
const NEW_TOKEN = /^(?:new(?:ly added)?(?:\s+sub-?\s*section)?|-|–|—|nil)\.?$/i;

/** Normalise a cell for section parsing: "2(c )" → "2(c)", "171-I" → "171I", "197(1)d" → "197(1)(d)", stray "]" removed. */
export function normalizeCell(raw: string): string {
  return decodeEntities(raw)
    .replace(/\s+/g, " ")
    .replace(/\]/g, "")
    .replace(/\(\s*([0-9A-Za-z]{1,4})\s*\)/g, "($1)")
    .replace(/\b(\d{1,3})-([A-Z]{1,2})\b/g, "$1$2")
    .replace(/(\d\))([a-z])\b/g, "$1($2)")
    .trim();
}

const SEC = String.raw`(\d{1,3}[A-Z]{0,3})((?:\s?\(\d{1,3}[A-Za-z]?\))*)((?:\s?\([a-z]{1,4}\))*)`;
const PART = String.raw`(?:\s*,?\s*([Pp]ara\s*\d+|[Cc]lause\s*-?\s*\d+|[Ee]xplanation(?:\s+\d+)?|(?:[Ff]irst|[Ss]econd|[Tt]hird)?\s*[Pp]roviso))?`;

interface Parsed { sections: ConcordanceSection[]; residue: string; rangeExpanded: boolean }

/** Every section reference in a cell, in order, with the text the parser did not use (`residue`). */
export function parseSectionCell(cell: string, opts: { stripPrefix?: RegExp } = {}): Parsed {
  let s = normalizeCell(cell);
  if (opts.stripPrefix) s = s.replace(opts.stripPrefix, "");
  const out: ConcordanceSection[] = [];
  let rangeExpanded = false;
  // "First proviso to section 22" / "Proviso to section 23".
  const prov = /^((?:first|second|third)\s+)?proviso to section\s+/i.exec(s);
  let provPart: string | undefined;
  if (prov) { provPart = `${(prov[1] ?? "").trim().toLowerCase()} proviso`.trim(); s = s.slice(prov[0].length); }
  const re = new RegExp(SEC + PART, "g");
  const used: [number, number][] = [];
  let m: RegExpExecArray | null;
  let prevEnd = -1;
  let prevNum: number | null = null;
  while ((m = re.exec(s))) {
    if (!m[0].trim()) { re.lastIndex++; continue; }
    const base = m[1].toUpperCase();
    const section = `${base}${(m[2] ?? "").replace(/\s/g, "")}${(m[3] ?? "").replace(/\s/g, "")}`;
    const part = m[4] ? m[4].replace(/\s+/g, " ").replace(/^clause\s*-?\s*/i, "clause ").toLowerCase() : provPart;
    // "230 to 232": expand numeric ranges only (the document's own words; lettered sections are never inferred).
    const between = prevEnd >= 0 ? s.slice(prevEnd, m.index) : "";
    if (/^\s*to\s*$/i.test(between) && prevNum != null && /^\d+$/.test(section) && Number(section) > prevNum && Number(section) - prevNum <= 50) {
      for (let k = prevNum + 1; k < Number(section); k++) out.push({ section: String(k) });
      rangeExpanded = true;
    }
    out.push(part ? { section, part } : { section });
    used.push([m.index, m.index + m[0].length]);
    prevEnd = m.index + m[0].length;
    prevNum = /^\d+$/.test(section) ? Number(section) : null;
    // Sibling sub-sections printed after the first: "351(2)/(3)", "132(1) &(2)", "228A (1)/(2)".
    const sib = /^\s*(?:&|\/|,|and)\s*\((\d{1,3}[A-Za-z]?)\)/i;
    let rest = s.slice(prevEnd);
    let sm: RegExpExecArray | null;
    while ((sm = sib.exec(rest))) {
      out.push({ section: `${base}(${sm[1]})` });
      used.push([prevEnd, prevEnd + sm[0].length]);
      prevEnd += sm[0].length;
      rest = s.slice(prevEnd);
    }
    re.lastIndex = prevEnd;
  }
  let residue = "";
  let pos = 0;
  for (const [a, b] of used) { residue += s.slice(pos, a) + " "; pos = b; }
  residue += s.slice(pos);
  residue = residue.replace(/\b(?:and|to|ipc|crpc|iea|bns|bnss|bsa|sections?|ss?\.)\b/gi, " ").replace(/[\s,&/.;:–—-]+/g, " ").trim();
  return { sections: out, residue, rangeExpanded };
}

function splitRow(line: string): string[] {
  const t = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return t.split("|").map((c) => c.trim());
}

const isSeparator = (cells: string[]) => cells.every((c) => /^:?-{3,}:?$/.test(c) || c === "");

/** Flags that make a row unusable for mapping (its section numbers cannot be trusted). */
export const BLOCKING_FLAGS: readonly ConcordanceFlag[] = ["malformed_row", "new_cell_unparsed", "old_cell_residue", "out_of_sequence", "ocr_noise"];

/**
 * A table row whose cell contains a line break is printed over two lines ("| 2(36) | Wrongful gain. | 23" then
 * "Clause-1 | Word …|"): join a row line that does not end with "|" to the following non-row lines until it does.
 */
export function joinBrokenRows(lines: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    let l = lines[i];
    if (l.trim().startsWith("|")) {
      while (!l.trim().endsWith("|") && i + 1 < lines.length && !lines[i + 1].trim().startsWith("|") && !/^\s*---\s*$/.test(lines[i + 1]) && lines[i + 1].trim()) l = `${l} ${lines[++i].trim()}`;
    }
    out.push(l);
  }
  return out;
}

export interface ParseOutput { rows: ConcordanceRow[]; summaries: ConcordanceSummaries }

/**
 * Parse the whole document. `oldPrefix` strips a code name the document sometimes prints inside the old cell
 * ("IEA 3 Interpretation clause").
 */
export function parseConcordanceMarkdown(table: ConcordanceTableId, markdown: string): ParseOutput {
  const cols = TABLE_COLUMNS[table];
  const rows: ConcordanceRow[] = [];
  const summaries: ConcordanceSummaries = {};
  let page = 1;
  let prevBase: number | null = null;
  const stripPrefix = /^(?:IPC|CrPC|Cr\.P\.C\.|IEA)\s+/i;
  for (const line of joinBrokenRows(markdown.split(/\r?\n/))) {
    if (/^\s*---\s*$/.test(line)) { page++; continue; }
    if (!line.trim().startsWith("|")) continue;
    const cells = splitRow(line).map(decodeEntities);
    if (isSeparator(cells)) continue;
    // Header rows ("BNS Sections | Subject | IPC Sections | Summary of comparison").
    if (/sections?\b/i.test(cells[cols.newCol] ?? "") && /sections?\b/i.test(cells[cols.oldCol] ?? "")) continue;
    // Continuation of the previous row's summary across a page break: leading cells empty.
    const filled = cells.filter((c) => c.trim()).length;
    if (!cells[cols.newCol]?.trim() && !cells[cols.oldCol]?.trim() && !cells[cols.subjectCol]?.trim()) {
      const prev = rows[rows.length - 1];
      if (prev && filled) summaries[prev.id] = `${summaries[prev.id] ?? ""} ${cells.filter((c) => c.trim()).join(" ")}`.replace(/\s+/g, " ").trim();
      continue;
    }
    const id = `${table}:${rows.length + 1}`;
    const flags: ConcordanceFlag[] = [];
    if (NOISE.test(cells[cols.newCol] ?? "") || NOISE.test(cells[cols.oldCol] ?? "")) flags.push("ocr_noise");
    else if (cells.some((c) => NOISE.test(c))) flags.push("text_noise");
    if (cells.length !== 4) {
      flags.push("malformed_row");
      rows.push({ id, newRaw: cells[0] ?? "", newSections: [], subject: "", oldRaw: cells.slice(1).join(" | "), oldSections: [], relation: "unparsed", page, flags, verification: "requires_review" });
      continue;
    }
    const newRaw = cells[cols.newCol];
    const oldRaw = cells[cols.oldCol];
    const subject = cells[cols.subjectCol].replace(/\s+/g, " ").trim();
    const np = parseSectionCell(newRaw);
    if (!np.sections.length || np.residue) flags.push("new_cell_unparsed");
    let relation: ConcordanceRelation;
    let oldSections: ConcordanceSection[] = [];
    const oldNorm = normalizeCell(oldRaw);
    if (!oldNorm) relation = "not_stated";
    else if (NEW_TOKEN.test(oldNorm)) relation = "new";
    else {
      const op = parseSectionCell(oldRaw, { stripPrefix });
      oldSections = op.sections;
      if (op.rangeExpanded) flags.push("range_expanded");
      if (op.residue) flags.push("old_cell_residue");
      relation = oldSections.length ? "corresponds" : "unparsed";
    }
    const base = np.sections.length ? Number(/^\d+/.exec(np.sections[0].section)?.[0]) : null;
    if (base != null && prevBase != null && base < prevBase) flags.push("out_of_sequence");
    if (base != null && !flags.includes("out_of_sequence")) prevBase = base;
    if (flags.includes("new_cell_unparsed") && relation === "corresponds") relation = "unparsed";
    const summary = cells[cols.summaryCol].replace(/\s+/g, " ").trim();
    if (summary) summaries[id] = summary;
    rows.push({ id, newRaw, newSections: np.sections, subject, oldRaw, oldSections, relation, page, flags, verification: flags.some((f) => BLOCKING_FLAGS.includes(f)) ? "requires_review" : "official_parsed" });
  }
  return { rows, summaries };
}
