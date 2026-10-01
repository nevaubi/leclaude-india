/**
 * Statute reader: pure, client-safe presentation helpers. Nothing here changes a word of the dataset's text; it only
 * classifies paragraphs (sub-section, clause, proviso, explanation, illustration) so the reader can lay them out, and
 * groups the table of contents by chapter. Every block's `label + text` is exactly the paragraph as stored.
 */
import { citationTitle, NO_SECTION, type LawInstrument, type LawTocEntry } from "./shared";

export type LawBlockKind =
  | "headnote" // chapter / part captions the dataset repeats before the section's own text
  | "lead" // "303. Theft.— (1) Whoever …"
  | "subsection" // "(2) Whoever commits theft …"
  | "clause" // "(a) …" outside illustrations
  | "explanation"
  | "illustrations"
  | "illustration"
  | "proviso"
  | "para";

export interface LawBlock {
  kind: LawBlockKind;
  /** The leading marker as printed ("303. Theft.—", "(2)", "Explanation 1. —", "Provided"); may be empty. */
  label: string;
  /** The rest of the paragraph, exactly as stored. */
  text: string;
  /** Stable in-page anchor ("ss-2", "expl-1", "proviso-1", "ill-a"); null for headnotes and plain paragraphs. */
  anchor: string | null;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Split a section's text into typed blocks for layout. Words are never altered, merged or dropped. */
export function lawBlocks(text: string, section: string): LawBlock[] {
  const paras = text.replace(/\r\n?/g, "\n").split(/\n{2,}/).map((p) => p.replace(/^\n+|\n+$/g, "")).filter((p) => p.trim().length);
  const leadRe = section && section !== NO_SECTION ? new RegExp(`^\\s*${esc(section)}\\s*\\.(?!\\d)`) : null;
  const leadIdx = leadRe ? paras.findIndex((p) => leadRe.test(p)) : -1;
  const used = new Map<string, number>();
  const anchor = (base: string) => {
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    return n === 1 ? base : `${base}-${n}`;
  };
  let inIllustrations = false;
  let provisos = 0;
  let explanations = 0;
  const out: LawBlock[] = [];
  paras.forEach((p, i) => {
    if (leadIdx > 0 && i < leadIdx && p.length <= 160) { out.push({ kind: "headnote", label: "", text: p, anchor: null }); return; }
    if (i === leadIdx) {
      // "303. Theft.— (1) Whoever …": the number and the marginal heading (up to the first dash) form the label.
      const m = /^(\s*\S+?\s*\.\s*(?:[^—–\n]{0,160}?(?:\.\s*)?[—–]+\s*)?)/.exec(p);
      const label = m?.[1] ?? "";
      const rest = p.slice(label.length);
      const ss = /^\s*\((\d+[A-Za-z]{0,2})\)/.exec(rest);
      out.push({ kind: "lead", label, text: rest, anchor: ss ? anchor(`ss-${ss[1].toLowerCase()}`) : null });
      return;
    }
    let m: RegExpExecArray | null;
    if ((m = /^(\s*\((\d+[A-Za-z]{0,2})\)\s*)/.exec(p))) {
      inIllustrations = false;
      out.push({ kind: "subsection", label: m[1], text: p.slice(m[1].length), anchor: anchor(`ss-${m[2].toLowerCase()}`) });
      return;
    }
    if ((m = /^(\s*\(([a-z]{1,4})\)\s*)/.exec(p))) {
      out.push({ kind: inIllustrations ? "illustration" : "clause", label: m[1], text: p.slice(m[1].length), anchor: anchor(`${inIllustrations ? "ill" : "cl"}-${m[2]}`) });
      return;
    }
    if ((m = /^(\s*Explanations?(?:\s+(?:\d+|[IVX]+))?\s*\.?\s*(?:[—–-]+\s*)?)/.exec(p))) {
      inIllustrations = false;
      explanations += 1;
      out.push({ kind: "explanation", label: m[1], text: p.slice(m[1].length), anchor: anchor(`expl-${explanations}`) });
      return;
    }
    if (/^\s*Illustrations?\s*\.?\s*$/i.test(p)) {
      inIllustrations = true;
      out.push({ kind: "illustrations", label: p, text: "", anchor: anchor("illustrations") });
      return;
    }
    if ((m = /^(\s*Provided(?:\s+further|\s+also)?\b)/.exec(p))) {
      inIllustrations = false;
      provisos += 1;
      out.push({ kind: "proviso", label: m[1], text: p.slice(m[1].length), anchor: anchor(`proviso-${provisos}`) });
      return;
    }
    out.push({ kind: "para", label: "", text: p, anchor: null });
  });
  return out;
}

// ---------------------------------------------------------------------------
// Table of contents
// ---------------------------------------------------------------------------

export interface TocGroup {
  key: string;
  chapter: string | null;
  title: string | null;
  entries: LawTocEntry[];
  /** The same chapter also appears elsewhere in the dataset's order (a parse quirk worth flagging, never reordered). */
  outOfSequence: boolean;
}

/** Chapter titles as stored sometimes carry stray leading punctuation (". - OFFENCES …"); display only. */
export function displayChapterTitle(t: string | null | undefined): string | null {
  const s = (t ?? "").replace(/^[\s.\-–—:|]+/, "").replace(/\s+/g, " ").trim();
  return s || null;
}

/** Headings as stored sometimes keep markdown emphasis markers ("etc**"); display only. */
export function displayHeading(h: string | null | undefined): string | null {
  const s = (h ?? "").replace(/\*+/g, "").replace(/\s+([:;,.])\s*$/, "$1").replace(/\s+/g, " ").trim();
  return s || null;
}

/** Contiguous runs of the TOC (dataset order) by chapter. A chapter split across runs is flagged, not reordered. */
export function groupToc(entries: LawTocEntry[]): TocGroup[] {
  const groups: TocGroup[] = [];
  for (const e of entries) {
    const title = displayChapterTitle(e.chapter_title);
    const key = `${e.chapter ?? ""}|${title ?? ""}`;
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.entries.push(e);
    else groups.push({ key, chapter: e.chapter, title, entries: [e], outOfSequence: false });
  }
  // A run whose chapter number jumps ahead of both neighbours (I → XX → II) is a dataset ordering quirk, typically
  // the Statement of Objects and Reasons parsed as sections. Flag it; never reorder or hide it.
  let prev: number | null = null;
  groups.forEach((g, k) => {
    const n = chapterNumber(g.chapter);
    const next = k + 1 < groups.length ? chapterNumber(groups[k + 1].chapter) : null;
    if (n != null && next != null && prev != null && n > next && prev <= next) g.outOfSequence = true;
    else if (n != null) prev = n;
  });
  return groups;
}

const ROMAN: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100 };

/** "XVII" → 17, "12" → 12, "IVA" → 4; null when the chapter has no recognisable number. */
export function chapterNumber(c: string | null | undefined): number | null {
  const s = (c ?? "").trim().toUpperCase();
  const arabic = /^(\d{1,3})/.exec(s);
  if (arabic) return Number(arabic[1]);
  const roman = /^([IVXLC]+)/.exec(s)?.[1];
  if (!roman) return null;
  let total = 0;
  for (let i = 0; i < roman.length; i++) {
    const v = ROMAN[roman[i]], w = ROMAN[roman[i + 1]] ?? 0;
    total += v < w ? -v : v;
  }
  return total > 0 ? total : null;
}

/** "Section 303" / "Rule 4" / "Preamble" for compact labels. */
export function sectionShort(section: string): string {
  return section === NO_SECTION ? "Unnumbered text" : `§ ${section}`;
}

// ---------------------------------------------------------------------------
// Landing: key Central Acts, resolved by exact title (never guessed)
// ---------------------------------------------------------------------------

export const KEY_CENTRAL_ACTS = [
  "Bharatiya Nyaya Sanhita, 2023",
  "Bharatiya Nagarik Suraksha Sanhita, 2023",
  "Bharatiya Sakshya Adhiniyam, 2023",
  "Code of Civil Procedure, 1908",
  "Indian Contract Act, 1872",
  "Specific Relief Act, 1963",
  "Limitation Act, 1963",
  "Arbitration and Conciliation Act, 1996",
  "Negotiable Instruments Act, 1881",
  "Companies Act, 2013",
  "Insolvency and Bankruptcy Code, 2016",
  "Transfer of Property Act, 1882",
  "Consumer Protection Act, 2019",
  "Information Technology Act, 2000",
] as const;

/** "The Code of Civil Procedure, 1908" → "code of civil procedure 1908". */
export function normActTitle(t: string): string {
  return t.toLowerCase().replace(/^\s*the\s+/, "").replace(/[^a-z0-9]+/g, " ").trim();
}

/** The Central instrument whose citation title is exactly `wanted`, or null. No fuzzy or closest match. */
export function exactCentralAct<T extends Pick<LawInstrument, "title" | "year" | "jurisdiction">>(wanted: string, hits: T[]): T | null {
  const target = normActTitle(wanted);
  return hits.find((h) => h.jurisdiction === "central" && normActTitle(citationTitle(h)) === target) ?? null;
}
