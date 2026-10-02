/**
 * Deterministic treatment cues for the citator (no model). Client-safe and pure.
 *
 * A signal is a TEXT CUE: the sentence that carries a citation also carries a phrase such as "overruled" or "relied
 * upon" that, by simple grammatical rules, attaches to that citation. It is never a verified treatment: the citing
 * passage must be read before saying how a judgment was treated. Rules are conservative: a negated, conditional,
 * reported ("it was contended that …"), proposed ("ought to be overruled") or ambiguous cue gives no signal.
 */

export type TreatmentSignal = "overruled" | "per_incuriam" | "doubted" | "referred_to_larger_bench" | "distinguished" | "followed";

/** Strongest first; when several cues attach to one citation the strongest is kept. */
export const SIGNAL_PRIORITY: readonly TreatmentSignal[] = ["overruled", "per_incuriam", "doubted", "referred_to_larger_bench", "distinguished", "followed"];

/** Signals that put the cited judgment's authority in question. */
export const NEGATIVE_SIGNALS: readonly TreatmentSignal[] = ["overruled", "doubted", "per_incuriam"];

export const isNegativeSignal = (s: string | null | undefined): s is TreatmentSignal => !!s && (NEGATIVE_SIGNALS as readonly string[]).includes(s);
export const isTreatmentSignal = (s: unknown): s is TreatmentSignal => typeof s === "string" && (SIGNAL_PRIORITY as readonly string[]).includes(s);

/** Reader-facing wording: what the text says, never what the treatment is. */
export const SIGNAL_LABEL: Record<TreatmentSignal, string> = {
  overruled: "overruled",
  per_incuriam: "per incuriam",
  doubted: "doubted",
  referred_to_larger_bench: "referred to a larger bench",
  distinguished: "distinguished",
  followed: "followed / relied upon",
};

export interface Span { start: number; end: number }
export interface TreatmentCue { signal: TreatmentSignal; /** Exact substring of the context. */ cue: string; start: number }

type Dir = "before" | "after" | "either";
interface CueRule {
  signal: TreatmentSignal;
  re: RegExp;
  /** Which citation the cue grammatically refers to. */
  dir(m: RegExpExecArray, ctx: string): Dir;
  /** Extra rule-specific suppression (window = clause text before the cue, after = text after the cue). */
  suppress?(m: RegExpExecArray, window: string, after: string): boolean;
  /** The cue already contains a negation ("not good law"): skip the generic negation check. */
  negationInCue?: boolean;
  /** Proposals are the signal itself ("be placed before a larger Bench"). */
  allowModal?: boolean;
  /** Reported speech still counts (counsel "relied upon" a judgment is the text's own statement). */
  allowReported?: boolean;
}

const AUX = String.raw`(?:(?:has|have|had)\s+been\s+|stands?\s+|stood\s+|was\s+|were\s+|is\s+|are\s+|been\s+|being\s+)`;
const startsWithAux = (s: string) => /^(?:(?:has|have|had)\s+been|stands?|stood|was|were|is|are|been|being)\s/i.test(s);
/** Subjects that make a bare past tense active ("this Court overruled X", "which followed X"). */
const ACTIVE_SUBJECT = /\b(?:court|bench|we|it|majority|they|which|judges?|judgment|decision|tribunal)\s*$/i;

function bareDir(m: RegExpExecArray, ctx: string, opts: { passiveNext?: RegExp; activeNext?: RegExp } = {}): Dir {
  if (startsWithAux(m[0])) return "before";
  const after = ctx.slice(m.index + m[0].length, m.index + m[0].length + 40);
  const before = ctx.slice(Math.max(0, m.index - 40), m.index);
  if (/^\s+(?:by|in)\b/i.test(after) || (opts.passiveNext && opts.passiveNext.test(after))) return "before";
  if (opts.activeNext && opts.activeNext.test(after)) return "after";
  if (ACTIVE_SUBJECT.test(before)) return "after";
  return "either";
}

const RULES: CueRule[] = [
  {
    signal: "overruled",
    re: new RegExp(String.raw`\b(?:impliedly\s+|expressly\s+)?${AUX}?(?:impliedly\s+|expressly\s+)?over-?rul(?:ed|ing|es|e)\b`, "gi"),
    dir(m, ctx) {
      const word = /over-?rul(?:ed|ing|es|e)$/i.exec(m[0])![0].toLowerCase().replace("-", "");
      if (word !== "overruled") return "after";
      return bareDir(m, ctx, { activeNext: /^\s+(?:the|that|this|its|an?|earlier|decision|judgment|view|ratio)\b/i });
    },
  },
  {
    signal: "overruled",
    re: /\b(?:(?:is|was|are|were)\s+)?(?:no\s+longer|not)\s+(?:a\s+)?good\s+law\b|\b(?:is|was)\s+bad\s+law\b|\bdo(?:es)?\s+not\s+lay\s+down\s+(?:the\s+)?(?:correct|good|right)\s+law\b|\bdid\s+not\s+lay\s+down\s+(?:the\s+)?(?:correct|good|right)\s+law\b/gi,
    dir: () => "before",
    negationInCue: true,
  },
  {
    signal: "per_incuriam",
    re: new RegExp(String.raw`\b(?:${AUX}|(?:rendered|treated|regarded|held)\s+(?:as\s+|to\s+be\s+)?)?per\s+incuriam\b`, "gi"),
    dir(m) { return /^(?:(?:has|have|had)\s+been|stands?|stood|was|were|is|are|been|being|rendered|treated|regarded|held)\s/i.test(m[0]) ? "before" : "either"; },
  },
  {
    signal: "doubted",
    re: new RegExp(String.raw`\b${AUX}?doubted\b|\bdoubting\b|\bcast(?:s|ing)?\s+(?:a\s+)?doubts?\s+(?:on|upon)\b|\bdoubts?\s+(?:about|regarding|as\s+to)\s+the\s+correctness\s+of\b`, "gi"),
    dir(m, ctx) {
      if (/^doubting|^cast|^doubts?\s/i.test(m[0])) return "after";
      return bareDir(m, ctx, { activeNext: /^\s+the\s+correctness\b/i });
    },
  },
  {
    signal: "referred_to_larger_bench",
    re: /\b(?:referred|refer|referring|reference|placed|place|placing)\s+(?:(?:the|this)\s+(?:matter|question|issue|case|questions|issues|papers|reference)\s+)?(?:to|before)\s+(?:a\s+|the\s+|an\s+)?(?:appropriate\s+)?(?:larger|constitution|full|three[- ]judge|five[- ]judge|seven[- ]judge|nine[- ]judge)\s+bench\b|\breconsideration\s+by\s+(?:a\s+)?larger\s+bench\b/gi,
    dir: () => "before",
    allowModal: true,
  },
  {
    signal: "distinguished",
    re: new RegExp(String.raw`\b(?:(?:clearly|easily|readily)\s+)?${AUX}?(?:clearly\s+|easily\s+)?distinguish(?:ed|able|ing)?\b`, "gi"),
    dir(m, ctx) {
      const w = /distinguish\w*$/i.exec(m[0])![0].toLowerCase();
      if (w === "distinguishable") return "before";
      if (w === "distinguishing" || w === "distinguish") return "after";
      return bareDir(m, ctx, { passiveNext: /^\s+on\s+(?:the\s+)?facts\b/i, activeNext: /^\s+(?:the|that|this|its)\b/i });
    },
    suppress(m, window, after) {
      if (/^\s+(?:counsel|senior|jurists?|judges?|career|members?|lawyers?|advocates?|services?|features?|factors?|marks?|characteristics?|between|from\s+(?:one\s+)?another|itself|himself|herself|themselves)\b/i.test(after)) return true;
      return /\blearned\s+and\s*$/i.test(window);
    },
  },
  {
    signal: "followed",
    re: new RegExp(String.raw`\b${AUX}?(?:consistently\s+|duly\s+)?followed\b|\bfollows?\s+(?:the\s+)?(?:decision|judgment|ratio|view|law\s+laid\s+down|dictum|principles?)\b|\b${AUX}?rel(?:ied|ying)\s+(?:up)?on\b|\b(?:placed|placing)\s+(?:strong\s+|heavy\s+|much\s+)?reliance\s+(?:up)?on\b|\breliance\s+(?:is\s+|was\s+|has\s+been\s+|had\s+been\s+)?placed\s+(?:up)?on\b|\b${AUX}?applied\s+(?:in|by)\b|\bappl(?:ied|ying)\s+the\s+(?:ratio|principles?|law\s+laid\s+down|dictum|test)\b`, "gi"),
    dir(m, ctx) {
      const s = m[0].toLowerCase();
      if (/^follows?\s|^appl(?:ied|ying)\s+the|^(?:placed|placing)|^reliance/.test(s)) return "after";
      if (/applied\s+(?:in|by)$/.test(s)) return "before";
      if (/rel(?:ied|ying)\s+(?:up)?on$/.test(s)) {
        if (startsWithAux(m[0])) return "before";
        return /^\s+by\b/i.test(ctx.slice(m.index + m[0].length, m.index + m[0].length + 10)) ? "before" : "after";
      }
      return bareDir(m, ctx);
    },
    suppress(m, window, after) {
      if (/followed$/i.test(m[0])) {
        // "followed by" is a sequence unless a court is the agent ("followed by this Court in …").
        if (/^\s+by\b/i.test(after) && !/^\s+by\s+(?:this|the|a|another|several|various|other)\s+(?:[A-Za-z-]+\s+)?(?:court|bench|courts|benches)\b/i.test(after)) return true;
        if (/\b(?:procedure|practice|course|method|steps?|process|formalities)\s*$/i.test(window)) return true;
      }
      return false;
    },
    allowReported: true,
  },
];

const NEGATION = /\b(?:not|never|no|nor|neither|cannot|can't|couldn't|wouldn't|shouldn't|isn't|wasn't|aren't|weren't|hasn't|haven't|hadn't|doesn't|didn't|without|declined?|declines|declining|refused?|refuses|refusing|unable|whether|if|hardly|nothing)\b/i;
const MODAL = /\b(?:should|ought\s+to|must|may|might|would|could|shall|needs?\s+to|requires?\s+to|deserves?\s+to|liable\s+to|has\s+to|have\s+to)\s+be\s+(?:\w+\s+)?$/i;
const ATTEMPT = /\b(?:sought|seeks?|seeking|attempt(?:ed|s|ing)?|tried|tries|trying|endeavou?r(?:ed|s|ing)?|invited\s+us|asked\s+us|wants?|wanted)\s+(?:to\s+)?(?:be\s+)?$/i;
const REPORTED = /\b(?:contend(?:ed|s|ing)?|contentions?|submi(?:tted|ts|ssions?)|argu(?:ed|es|ing|ments?)|urged|canvass(?:ed)?|objections?|pleas?|plead(?:ed)?|prayer|alleged(?:ly)?)\b/i;

/** Maximum distance (characters) between a cue and the citation it attaches to. */
const MAX_GAP = 200;

const inside = (pos: number, spans: Span[]) => spans.some((s) => pos >= s.start && pos < s.end);

/** Start of the clause holding `pos`: after the last ";" or ":" (outside citations) or the context start. */
function clauseStart(ctx: string, pos: number, spans: Span[]): number {
  for (let i = pos - 1; i >= 0; i--) {
    const ch = ctx[i];
    if ((ch === ";" || ch === ":") && !inside(i, spans)) return i + 1;
  }
  return 0;
}

function attach(dir: Dir, cueStart: number, cueEnd: number, ctx: string, spans: Span[]): number | null {
  if (dir === "either") return spans.length === 1 ? 0 : null;
  if (dir === "before") {
    let best = -1;
    spans.forEach((s, i) => { if (s.end <= cueStart && (best < 0 || s.end > spans[best].end)) best = i; });
    if (best < 0) return null;
    const s = spans[best];
    const between = ctx.slice(s.end, cueStart);
    if (cueStart - s.end > MAX_GAP || /[;]/.test(between)) return null;
    // "Y, which followed X (cite), was overruled": the cue belongs to Y, not to X inside the relative clause.
    if (/^\s*[,)]/.test(between)) {
      const prevEnd = best > 0 ? spans[best - 1].end : 0;
      if (/\b(?:which|that|who|whom|wherein|where)\b[^,]*$/i.test(ctx.slice(prevEnd, s.start))) return null;
    }
    return best;
  }
  let best = -1;
  spans.forEach((s, i) => { if (s.start >= cueEnd && (best < 0 || s.start < spans[best].start)) best = i; });
  if (best < 0) return null;
  const between = ctx.slice(cueEnd, spans[best].start);
  if (spans[best].start - cueEnd > MAX_GAP || /[;]/.test(between)) return null;
  return best;
}

/**
 * The treatment cue in `ctx` that attaches to the case citation `spans[target]`, or null. `spans` are the case
 * citations in `ctx` (sorted, non-overlapping); `otherSpans` are other citation-like spans (statutes) that a cue may
 * not overlap. The returned cue is an exact substring of `ctx`.
 */
export function detectTreatment(ctx: string, spans: Span[], target: number, otherSpans: Span[] = []): TreatmentCue | null {
  if (target < 0 || target >= spans.length) return null;
  const all = [...spans, ...otherSpans];
  const found: TreatmentCue[] = [];
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.re.exec(ctx))) {
      if (!m[0]) { rule.re.lastIndex++; continue; }
      const start = m.index, end = start + m[0].length;
      if (all.some((s) => start < s.end && end > s.start)) continue;
      const cs = clauseStart(ctx, start, all);
      const window = ctx.slice(Math.max(cs, start - 60), start).replace(/\bNos?\.\s*\d+/gi, " ");
      const after = ctx.slice(end, end + 60);
      if (!rule.negationInCue && NEGATION.test(window)) continue;
      if (rule.negationInCue && /\b(?:cannot|can't|could\s+not|whether|if)\b/i.test(window)) continue;
      if (!rule.allowModal && MODAL.test(window)) continue;
      if (ATTEMPT.test(window)) continue;
      if (!rule.allowReported && REPORTED.test(ctx.slice(cs, start))) continue;
      if (rule.suppress?.(m, window, after)) continue;
      const who = attach(rule.dir(m, ctx), start, end, ctx, spans);
      if (who === target) found.push({ signal: rule.signal, cue: m[0], start });
    }
  }
  if (!found.length) return null;
  const t = spans[target];
  const dist = (c: TreatmentCue) => Math.min(Math.abs(c.start - t.end), Math.abs(c.start - t.start));
  found.sort((a, b) => SIGNAL_PRIORITY.indexOf(a.signal) - SIGNAL_PRIORITY.indexOf(b.signal) || dist(a) - dist(b));
  return found[0];
}

// ---------------------------------------------------------------------------
// Sentences and contexts
// ---------------------------------------------------------------------------

/** Words that end with a full stop without ending a sentence (lower case, without the dot). */
const ABBREVIATIONS = new Set([
  "v", "vs", "viz", "ors", "anr", "no", "nos", "mr", "mrs", "ms", "dr", "sri", "smt", "shri", "kum", "hon", "ld", "sec", "secs", "s", "ss", "art", "arts",
  "cl", "para", "paras", "p", "pp", "vol", "co", "ltd", "pvt", "inc", "govt", "dept", "st", "etc", "e", "i", "eg", "ie", "cf", "ibid", "id", "supra", "al",
  "cr", "crl", "cri", "sc", "scc", "scr", "air", "ilr", "j", "jj", "cj", "acj", "u", "r", "o", "rr", "w", "a", "m", "d", "sl", "spl", "misc", "appl",
  "corpn", "bros", "assn", "regd", "addl", "asst", "jt", "dist", "tq", "vill", "approx", "ex", "cent", "gen", "prof", "ch", "fig", "op", "cit", "mah", "kar",
  "del", "bom", "mad", "cal", "all", "guj", "raj", "ker", "ori", "pat", "gau", "hp", "mp", "ap", "ts", "wp", "rsa", "rfa", "mfa", "crlp", "pw", "dw", "exh",
]);

/** Sentence boundaries (offsets where a sentence starts) in `text`, ignoring full stops inside citation spans. */
export function sentenceStarts(text: string, spans: Span[]): number[] {
  const out = [0];
  const re = /[.?!]["'”’)\]]*\s+|\n[ \t]*\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const end = m.index + m[0].length;
    if (m[0][0] === "\n") { out.push(end); continue; }
    if (inside(m.index, spans)) continue;
    if (m[0][0] === ".") {
      const word = /([A-Za-z]+)$/.exec(text.slice(Math.max(0, m.index - 14), m.index))?.[1];
      if (word && (word.length === 1 || ABBREVIATIONS.has(word.toLowerCase()))) continue;
    }
    if (/^[a-z]/.test(text.slice(end, end + 1))) continue;
    out.push(end);
  }
  return out;
}

/** Collapse whitespace runs to one space and trim, with a map from old offsets to new ones. */
export function collapseWhitespace(s: string): { text: string; map: (i: number) => number } {
  const idx: number[] = new Array(s.length + 1);
  let out = "";
  let pendingSpace = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (/\s/.test(ch)) { idx[i] = out.length; if (out.length) pendingSpace = true; continue; }
    if (pendingSpace) { out += " "; pendingSpace = false; }
    idx[i] = out.length;
    out += ch;
  }
  idx[s.length] = out.length;
  return { text: out, map: (i: number) => Math.min(idx[Math.max(0, Math.min(i, s.length))], out.length) };
}

/** Maximum stored context length. */
export const CONTEXT_MAX = 400;

/**
 * The sentence around `[start, end)` (bounded to CONTEXT_MAX characters around the citation, whitespace collapsed),
 * with the given spans mapped into it (spans not wholly inside are dropped).
 */
export function contextAround(text: string, starts: number[], start: number, end: number, spans: Span[]): { context: string; spans: Span[]; target: Span } {
  let s = 0;
  for (const b of starts) { if (b <= start) s = b; else break; }
  const next = starts.find((b) => b > start && b >= end);
  let e = next ?? text.length;
  if (e - s > CONTEXT_MAX) {
    const half = Math.max(0, Math.floor((CONTEXT_MAX - (end - start)) / 2));
    let ws = Math.max(s, start - half);
    const we = Math.min(e, ws + Math.max(CONTEXT_MAX, end - start));
    ws = Math.max(s, Math.min(ws, we - CONTEXT_MAX));
    s = ws; e = we;
  }
  const raw = text.slice(s, e);
  const { text: ctx, map } = collapseWhitespace(raw);
  const mapSpan = (sp: Span): Span => ({ start: map(sp.start - s), end: map(sp.end - s) });
  const within = spans.filter((sp) => sp.start >= s && sp.end <= e).map(mapSpan);
  return { context: ctx, spans: within, target: mapSpan({ start, end }) };
}
