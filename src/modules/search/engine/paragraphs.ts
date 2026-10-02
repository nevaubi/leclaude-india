/**
 * Paragraph addressing for pinpoint cites (constitution §23 exact source identity).
 *
 * The evidence handed to the model, the code-side quote check and the reader drawer all
 * split a source's text the same way, so "¶12" in an answer points at the same paragraph
 * the reader scrolls to. Pure and client-safe.
 */

/** Split text into paragraphs exactly as the reader drawer renders them (1-based numbering is `index + 1`). */
export function splitParagraphs(text: string): string[] {
  return (text ?? "").split(/\n+/).map((s) => s.trim()).filter(Boolean);
}

/** Canonical form for literal quote comparison: curly quotes/dashes folded, whitespace collapsed, case-insensitive. */
export function normalizeForQuote(s: string): string {
  return (s ?? "")
    .normalize("NFKC")
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/ /g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Strip ellipses and bracketed alterations so "[t]he court … held" can match its source. Returns the literal fragments. */
export function quoteFragments(quote: string): string[] {
  return normalizeForQuote(quote)
    .replace(/^["']+|["']+$/g, "")
    .split(/\s*(?:\.\s?\.\s?\.|…|\[[^\]]{0,12}\])\s*/)
    .map((f) => f.trim())
    .filter((f) => f.length >= 4);
}

/**
 * Whether `quote` literally appears in `text` (after canonicalisation). Ellipses and bracketed
 * alterations split the quote into fragments that must each appear, in order.
 */
export function quoteExists(text: string, quote: string): boolean {
  const hay = normalizeForQuote(text);
  const frags = quoteFragments(quote);
  if (!frags.length) return false;
  let at = 0;
  for (const f of frags) {
    const i = hay.indexOf(f, at);
    if (i < 0) return false;
    at = i + f.length;
  }
  return true;
}

/** 1-based paragraph number containing the start of `quote`, or null when it is not in the text. */
export function paragraphOfQuote(text: string, quote: string): number | null {
  const first = quoteFragments(quote)[0];
  if (!first) return null;
  const paras = splitParagraphs(text);
  for (let i = 0; i < paras.length; i++) if (normalizeForQuote(paras[i]).includes(first)) return i + 1;
  return null;
}

const STOP = new Set(["the", "a", "an", "of", "to", "in", "on", "for", "under", "that", "this", "is", "are", "was", "were", "be", "by", "with", "and", "or", "at", "from", "it", "its", "as", "has", "have", "had", "not", "does", "do", "did", "can", "may", "what", "which", "when", "how", "whether", "any", "there", "than", "into", "about", "court", "courts"]);

/** Retrieval terms from a question/query set (lower-cased, stop words and boolean operators dropped). */
export function focusTerms(texts: string[]): string[] {
  const out = new Set<string>();
  for (const t of texts) {
    for (const w of t.toLowerCase().replace(/"[^"]*"~\d+/g, (m) => m.replace(/~\d+$/, "")).replace(/[^a-z0-9§.\s-]/g, " ").split(/\s+/)) {
      const word = w.replace(/^[.-]+|[.-]+$/g, "");
      if (word.length < 3 || STOP.has(word) || ["and", "not", "or"].includes(word)) continue;
      out.add(word.replace(/\*$/, ""));
    }
  }
  return Array.from(out).slice(0, 24);
}

export interface FocusedParagraph {
  /** 1-based paragraph number in `splitParagraphs(text)`. */
  n: number;
  text: string;
}

/**
 * Focused excerpt of a long source for a bounded context: the opening paragraphs (caption,
 * posture) plus the paragraphs that best match the research terms, kept in document order
 * with their original numbers, within `maxChars`. Deterministic.
 */
export function focusParagraphs(text: string, terms: string[], opts: { maxChars?: number; lead?: number; maxParagraphChars?: number; fill?: boolean } = {}): FocusedParagraph[] {
  const maxChars = opts.maxChars ?? 6_000;
  const lead = opts.lead ?? 2;
  const maxPara = opts.maxParagraphChars ?? 1_400;
  const paras = splitParagraphs(text).map((p, i) => ({ n: i + 1, text: p.length > maxPara ? p.slice(0, maxPara) + " …" : p }));
  if (!paras.length) return [];
  const total = paras.reduce((a, p) => a + p.text.length, 0);
  if (total <= maxChars) return paras;
  const lower = terms.map((t) => t.toLowerCase()).filter(Boolean);
  const holding = /\b(we hold|we conclude|we affirm|we reverse|held that|holding|the court held|we therefore|accordingly)\b/i;
  const score = (p: { text: string; n: number }) => {
    const t = p.text.toLowerCase();
    let s = 0;
    for (const term of lower) if (t.includes(term)) s += 1;
    if (holding.test(p.text)) s += 1.5;
    return s;
  };
  const chosen = new Set<number>();
  let used = 0;
  const take = (p: FocusedParagraph) => { if (chosen.has(p.n) || used + p.text.length > maxChars) return; chosen.add(p.n); used += p.text.length; };
  for (const p of paras.slice(0, lead)) take(p);
  const ranked = paras.slice(lead).map((p) => ({ p, s: score(p) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s || a.p.n - b.p.n);
  for (const { p } of ranked) take(p);
  // Nothing matched: fall back to the document's opening within budget. With `fill` (a large per-source budget), the
  // remaining budget is filled with the other paragraphs in document order, so the source is given as fully as it fits.
  if (chosen.size <= lead || opts.fill) for (const p of paras) take(p);
  return paras.filter((p) => chosen.has(p.n));
}
