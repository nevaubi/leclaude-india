import "server-only";
import { generateJSON } from "./agent";
import { aiBudget, aiConfig } from "./config";
import { CHARS_PER_TOKEN, charsForTokens, estimateTokens, type ResolvedBudget } from "./context-budget";
import { mapPool } from "./pool";
import type { TaskType } from "./providers/types";
import type { Provenance } from "@/lib/integrity/types";

/**
 * What the verifier saw (constitution §23: separate "checked" from "verified"). Sizes come from the `verify` budget
 * profile: sources beyond `sourcesChecked`, text beyond each source's limit and answer text beyond `answerChecked`
 * were NOT checked, and a verification that left anything unchecked (answer text, claims past the cap, a source cut
 * short or not shown) is reported as partial.
 */
export interface VerificationCoverage {
  sourcesGiven: number;
  sourcesChecked: number;
  /** Sources whose text was cut to the per-source limit. */
  sourcesClipped: number;
  answerChars: number;
  answerChecked: number;
  maxClaims: number;
  /** The claim cap was reached: later claims in the answer may not have been extracted. */
  claimsCapped: boolean;
}

export interface ClaimVerdict {
  claim: string;
  status: "supported" | "unsupported" | "contradicted";
  sourceIndex: number | null; // index into `sources`
  quote?: string;
  note?: string;
}

export interface VerificationResult {
  verdicts: ClaimVerdict[];
  supported: number;
  unsupported: number;
  contradicted: number;
  status: Provenance["verification"] extends infer V ? (V extends { status: infer S } ? S : never) : never;
  sourceBacked: boolean;
  /** 0..1 share of claims supported by the provided sources. */
  score: number;
  checkedAt: string;
  /** Set when the loop could not run (no key, model error); the output is then marked "unverified", never lost. */
  error?: string;
  /** What was actually checked (absent when verification did not run). */
  coverage?: VerificationCoverage;
  /** True when anything was not checked: answer text beyond the budget, the claim cap reached, a source cut short or not shown. */
  partial?: boolean;
}

export interface VerifySource { title?: string; cite?: string; url?: string; text: string }

const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          claim: { type: "string" },
          status: { type: "string", enum: ["supported", "unsupported", "contradicted"] },
          sourceIndex: { type: ["integer", "null"], description: "0-based index of the supporting/contradicting source, or null" },
          quote: { type: "string", description: "Short verbatim quote from the source that supports or contradicts the claim" },
          note: { type: "string" },
        },
        required: ["claim", "status", "sourceIndex"],
      },
    },
  },
  required: ["verdicts"],
};

function unverified(checkedAt: string, error?: string): VerificationResult {
  return { verdicts: [], supported: 0, unsupported: 0, contradicted: 0, status: "unverified", sourceBacked: false, score: 0, checkedAt, error };
}

/** Tokens kept back in a verifier request for its instructions and framing. */
const VERIFY_OVERHEAD_TOKENS = 3_000;

/**
 * What one verifyClaims call can show the model under budget `b`: characters per source (raised by a caller's
 * `perSourceChars`), and characters and estimated tokens of source text in total (an answer of the full `historyChars`
 * is reserved). Deep research caps its synthesis evidence at this so the verifier sees every passage the synthesis saw
 * (verification is never weaker than synthesis). Pure.
 */
export function verifierCapacity(b: Pick<ResolvedBudget, "inputTokens" | "historyChars" | "totalEvidenceChars" | "perSourceChars" | "maxFullSources">): { perSourceChars: number; totalChars: number; totalTokens: number; maxSources: number } {
  const room = Math.max(2_000, b.inputTokens - Math.ceil(b.historyChars / CHARS_PER_TOKEN) - VERIFY_OVERHEAD_TOKENS);
  return { perSourceChars: b.perSourceChars, totalChars: b.totalEvidenceChars, totalTokens: Math.min(room, Math.floor(b.totalEvidenceChars / CHARS_PER_TOKEN)), maxSources: b.maxFullSources };
}

/**
 * Characters of each text the verifier is shown: max-min fair shares of the total (characters and script-aware
 * tokens), each at most `perSourceCap`. Short texts are shown whole and leave the rest of their share to the long ones,
 * so a source is cut only when the total cannot hold it. Pure.
 */
export function allocateVerifierText(texts: string[], o: { perSourceCap: number; totalChars: number; totalTokens: number }): number[] {
  const n = texts.length;
  const out = new Array<number>(n).fill(0);
  const cap = Math.max(0, Math.floor(o.perSourceCap));
  const demand = texts.map((t) => Math.min(t.length, cap));
  const order = demand.map((d, i) => [d, i] as const).sort((a, z) => a[0] - z[0]).map(([, i]) => i);
  let chars = Math.max(0, Math.floor(o.totalChars));
  let tokens = Math.max(0, Math.floor(o.totalTokens));
  order.forEach((i, k) => {
    const left = n - k;
    const shareTokens = Math.floor(tokens / left);
    let give = Math.min(demand[i], Math.floor(chars / left));
    let used = estimateTokens(texts[i].slice(0, give));
    if (used > shareTokens) { give = charsForTokens(texts[i].slice(0, give), shareTokens); used = estimateTokens(texts[i].slice(0, give)); }
    out[i] = give;
    chars -= give;
    tokens -= used;
  });
  return out;
}

const sourceTitle = (s: VerifySource) => `${s.title ?? s.cite ?? s.url ?? "source"}${s.cite ? ` (${s.cite})` : ""}`;

/**
 * Self-correcting verification loop: extract the factual claims in `answer`
 * and check each one strictly against the supplied sources. Nothing outside
 * the sources counts as support. Used by research, e-discovery analysis and
 * the office agents before an AI output is marked source-backed.
 *
 * Reach: up to `maxFullSources` sources, each shown up to max(budget per-source, `perSourceChars`) characters within
 * the verifier's total (fair shares, script-aware tokens). A source cut short, a source not shown, answer text beyond
 * the budget or a reached claim cap make the result `partial` (never "verified"). `sourceIndex` in the verdicts refers
 * to the caller's `sources` array.
 */
export async function verifyClaims(input: { answer: string; sources: VerifySource[]; maxClaims?: number; signal?: AbortSignal; fast?: boolean; budget?: ResolvedBudget; taskType?: TaskType; cacheStablePrefix?: boolean; perSourceChars?: number }): Promise<VerificationResult> {
  const checkedAt = new Date().toISOString();
  const fast = input.fast ?? true;
  const b = input.budget ?? aiBudget("verify", { fast });
  const given = input.sources.map((s, index) => ({ s, index })).filter(({ s }) => s.text?.trim());
  if (!given.length) return unverified(checkedAt);
  const maxClaims = input.maxClaims ?? 25;
  const answerChecked = Math.min(input.answer.length, b.historyChars);
  const answerText = input.answer.length > answerChecked ? `${input.answer.slice(0, answerChecked)}\n…[answer continues; not shown]` : input.answer;
  // Which sources fit, and how much of each: the model's input budget wins (never a floor that overflows it).
  const candidates = given.slice(0, b.maxFullSources);
  const capacity = verifierCapacity(b);
  const titleTokens = candidates.reduce((a, c) => a + estimateTokens(sourceTitle(c.s)) + 6, 0);
  const room = Math.max(0, b.inputTokens - estimateTokens(answerText) - VERIFY_OVERHEAD_TOKENS - titleTokens);
  const perSourceCap = Math.max(b.perSourceChars, Math.floor(input.perSourceChars ?? 0));
  // With a caller's reach (deep research: the synthesis per-source size) the character total is no ceiling of its own
  // (the synthesis was already capped at this verifier's capacity); the token room — the model's real limit — still is.
  const reachTotal = input.perSourceChars ? candidates.reduce((a, c) => a + Math.min(c.s.text.length, perSourceCap), 0) : 0;
  const alloc = allocateVerifierText(candidates.map((c) => c.s.text), { perSourceCap, totalChars: Math.max(capacity.totalChars, reachTotal), totalTokens: input.perSourceChars ? room : Math.min(room, capacity.totalTokens) });
  const shown = candidates.map((c, k) => ({ ...c, chars: alloc[k] })).filter((c) => c.chars > 0);
  if (!shown.length) return unverified(checkedAt, "no source text fits the verifier's input budget");
  let clipped = 0;
  const sourceBlock = shown.map((c, i) => {
    const t = c.s.text;
    const text = t.length > c.chars ? (clipped++, `${t.slice(0, c.chars)}\n…[source text beyond ${c.chars} characters not shown]`) : t;
    return `[${i}] ${sourceTitle(c.s)}\n${text}`;
  }).join("\n\n");
  const res = await generateJSON<{ verdicts: ClaimVerdict[] }>({
    fast,
    reasoningEffort: "low",
    taskType: input.taskType,
    cacheStablePrefix: input.cacheStablePrefix,
    instructions: `You are a meticulous verification clerk at a law firm. Extract every factual or legal claim in the ANSWER (dates, holdings, quotes, numbers, who-said-what, citations) — at most ${maxClaims} — and decide for each whether the SOURCES support it verbatim or in substance, contradict it, or say nothing about it. Only the sources count; general knowledge is "unsupported". Quote the exact supporting or contradicting passage. Be strict about pin cites, dates and numbers. Sources and answers may be in Indian languages (Hindi, Kannada, Telugu, Urdu and others): judge meaning across languages, but a QUOTE must appear verbatim in the source's own language — a translated passage presented in quotation marks as the source's words is \"unsupported\". A rendering labelled \"(translation)\" is judged as a paraphrase.`,
    input: `ANSWER:\n${answerText}\n\nSOURCES:\n${sourceBlock}`,
    schema: VERDICT_SCHEMA,
    name: "claim_verification",
    maxOutputTokens: Math.max(6_000, b.maxOutputTokens),
    signal: input.signal,
  });
  // The model indexes the sources it was shown; map back to the caller's array (never to a neighbouring source).
  const verdicts = (res.verdicts ?? []).map((v) => ({ ...v, sourceIndex: v.sourceIndex != null && Number.isInteger(v.sourceIndex) && v.sourceIndex >= 0 && v.sourceIndex < shown.length ? shown[v.sourceIndex].index : null }));
  const supported = verdicts.filter((v) => v.status === "supported").length;
  const unsupported = verdicts.filter((v) => v.status === "unsupported").length;
  const contradicted = verdicts.filter((v) => v.status === "contradicted").length;
  const total = verdicts.length || 1;
  const score = supported / total;
  const coverage: VerificationCoverage = { sourcesGiven: given.length, sourcesChecked: shown.length, sourcesClipped: clipped, answerChars: input.answer.length, answerChecked, maxClaims, claimsCapped: verdicts.length >= maxClaims };
  // Honest status: anything not checked end to end (answer, claims, a source cut short or not shown) is at most partial.
  const partial = isPartialCoverage(coverage);
  let status: VerificationResult["status"] = contradicted > 0 ? "contradicted" : verdicts.length === 0 ? "unverified" : score >= 0.9 ? "verified" : score >= 0.5 ? "partially-verified" : "unverified";
  if (partial && status === "verified") status = "partially-verified";
  return { verdicts, supported, unsupported, contradicted, status, sourceBacked: supported > 0 && contradicted === 0, score, checkedAt, coverage, partial };
}

/** True when a verification left something unchecked: answer text, claims past the cap, a source cut short or not shown. */
export function isPartialCoverage(c: VerificationCoverage | undefined): boolean {
  if (!c) return false;
  return c.answerChecked < c.answerChars || c.claimsCapped || c.sourcesClipped > 0 || c.sourcesChecked < c.sourcesGiven;
}

/** One-line description of what a verification left unchecked ("" when it checked everything it was given). */
export function coverageNote(v: Pick<VerificationResult, "coverage">): string {
  const c = v.coverage;
  if (!c) return "";
  const parts: string[] = [];
  if (c.answerChecked < c.answerChars) parts.push(`only the first ${c.answerChecked.toLocaleString("en-US")} of ${c.answerChars.toLocaleString("en-US")} answer characters were checked`);
  if (c.claimsCapped) parts.push(`the claim cap (${c.maxClaims}) was reached`);
  if (c.sourcesChecked < c.sourcesGiven) parts.push(`${c.sourcesGiven - c.sourcesChecked} of ${c.sourcesGiven} sources were not shown to the verifier`);
  if (c.sourcesClipped) parts.push(`${c.sourcesClipped} source(s) were shown in part`);
  return parts.length ? `Partial verification: ${parts.join("; ")}.` : "";
}

/**
 * Fail-soft variant used by every module wrapper: never throws, returns an
 * "unverified" result (with `error`) when no key is configured, the caller
 * opted out (`verify: false`) or the model call fails.
 */
export async function safeVerifyClaims(input: Parameters<typeof verifyClaims>[0] & { verify?: boolean }): Promise<VerificationResult> {
  const checkedAt = new Date().toISOString();
  if (input.verify === false) return unverified(checkedAt, "skipped");
  if (!aiConfig().hasKey) return unverified(checkedAt, "no_api_key");
  try {
    return await verifyClaims(input);
  } catch (e) {
    if ((e as Error)?.name === "AbortError") throw e;
    return unverified(checkedAt, (e as Error).message);
  }
}

/** Fold a verification result into a provenance record. */
export function applyVerification(p: Provenance, v: VerificationResult, method: NonNullable<Provenance["verification"]>["method"] = "claims"): Provenance {
  const notes: string[] = [];
  if (v.contradicted) notes.push(`${v.contradicted} claim(s) contradicted by sources`);
  if (v.error && v.error !== "skipped") notes.push(`verification did not run (${v.error})`);
  if (v.error === "skipped") notes.push("verification skipped by caller");
  const cov = coverageNote(v);
  if (cov) notes.push(cov);
  return { ...p, verification: { ...(p.verification ?? {}), status: v.status, checkedAt: v.checkedAt, method, supported: v.supported, unsupported: v.unsupported, contradicted: v.contradicted, notes: notes.length ? notes.join("; ") : p.verification?.notes } };
}

/**
 * Split a structured output into parts whose JSON fits `maxTokens` each, so self-correction never sees (or replaces) a
 * truncated output. An array is split by items; an object by the items of its array-valued fields (every part keeps
 * the object's other fields and every key, with empty arrays where a part holds none). Returns null when the output
 * cannot be split to fit (a single item, or the non-array fields alone, larger than `maxTokens`). Pure.
 */
export function splitForCorrection<T>(output: T, maxTokens: number): T[] | null {
  const size = (v: unknown) => estimateTokens(JSON.stringify(v));
  if (size(output) <= maxTokens) return [output];
  const pack = <I>(items: I[], room: number): I[][] | null => {
    const parts: I[][] = [];
    let cur: I[] = [];
    let used = 0;
    for (const it of items) {
      const t = size(it) + 1;
      if (t > room) return null;
      if (cur.length && used + t > room) { parts.push(cur); cur = []; used = 0; }
      cur.push(it);
      used += t;
    }
    if (cur.length || !parts.length) parts.push(cur);
    return parts;
  };
  if (Array.isArray(output)) {
    const parts = pack(output as unknown[], maxTokens - 2);
    return parts ? (parts as unknown as T[]) : null;
  }
  if (output && typeof output === "object") {
    const obj = output as Record<string, unknown>;
    const arrayKeys = Object.keys(obj).filter((k) => Array.isArray(obj[k]) && (obj[k] as unknown[]).length);
    if (!arrayKeys.length) return null;
    const skeleton: Record<string, unknown> = { ...obj };
    for (const k of arrayKeys) skeleton[k] = [];
    const room = maxTokens - size(skeleton) - 8;
    if (room <= 0) return null;
    const items = arrayKeys.flatMap((k) => (obj[k] as unknown[]).map((value) => ({ k, value })));
    const parts = pack(items, room);
    if (!parts) return null;
    return parts.map((part) => {
      const o: Record<string, unknown> = { ...skeleton };
      for (const k of arrayKeys) o[k] = part.filter((x) => x.k === k).map((x) => x.value);
      return o as T;
    });
  }
  return null;
}

/** Merge corrected parts back into one output (inverse of splitForCorrection; non-array fields from the first part). */
function mergeCorrected<T>(original: T, parts: T[]): T {
  if (parts.length === 1) return parts[0];
  if (Array.isArray(original)) return parts.flatMap((p) => (Array.isArray(p) ? p : [])) as unknown as T;
  const first = (parts[0] ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = { ...(original as Record<string, unknown>), ...first };
  for (const k of Object.keys(original as Record<string, unknown>)) {
    if (!Array.isArray((original as Record<string, unknown>)[k])) continue;
    out[k] = parts.flatMap((p) => { const v = (p as Record<string, unknown>)?.[k]; return Array.isArray(v) ? v : []; });
  }
  return out as T;
}

/**
 * Second-pass self-critique for structured extractions (timeline events,
 * fact matrices, digests): the model re-reads its own output against the
 * evidence and returns corrected rows plus a list of dropped hallucinations.
 *
 * The output is never truncated: when its JSON is larger than one request can carry (and the model can return), it is
 * split into parts (array items) corrected separately and merged; an output that cannot be split throws, so the caller
 * keeps the original and records that self-correction did not run. Evidence is cut to what the model's input holds, with
 * the cut stated in the instructions (rows whose support may lie in the omitted part are kept).
 */
export async function selfCorrect<T>(input: { label: string; output: T; evidence: string; schema: Record<string, unknown>; instructions?: string; signal?: AbortSignal; budget?: ResolvedBudget }): Promise<{ corrected: T; changes: string[]; parts?: number }> {
  if (!aiConfig().hasKey) return { corrected: input.output, changes: [] };
  const b = input.budget ?? aiBudget("verify", { fast: true });
  const maxOutputTokens = Math.max(12_000, b.maxOutputTokens);
  // A part's JSON must fit the input share for it and its corrected copy (plus the change list) the visible output.
  const partTokens = Math.max(1_000, Math.min(Math.floor(maxOutputTokens * 0.6), Math.ceil(Math.max(30_000, b.historyChars) / CHARS_PER_TOKEN)));
  const parts = splitForCorrection(input.output, partTokens);
  if (!parts) throw new Error(`the ${input.label} is too large to self-correct in one pass and cannot be split (one item exceeds ${partTokens.toLocaleString("en-US")} tokens); it was not corrected`);
  // Evidence: the model limit wins (instructions, the part and the overhead come first), never above the budget's total.
  const evidenceTokens = Math.max(2_000, b.inputTokens - partTokens - VERIFY_OVERHEAD_TOKENS);
  const evidenceChars = Math.min(Math.max(40_000, b.totalEvidenceChars), charsForTokens(input.evidence, evidenceTokens));
  const evidenceCut = input.evidence.length > evidenceChars;
  const evidence = evidenceCut ? input.evidence.slice(0, evidenceChars) : input.evidence;
  // A row whose support lies in evidence that was not shown is kept, never "corrected" away (no false removals).
  const cutNote = evidenceCut ? ` The EVIDENCE was cut to its first ${evidenceChars.toLocaleString("en-US")} characters: keep unchanged any item whose support may lie in the omitted part; do not remove it for lack of support.` : "";
  const partNote = parts.length > 1 ? " The OUTPUT is one part of a longer list checked in parts: judge only the items shown and return all of them (corrected or unchanged) unless one is unsupported." : "";
  const schema = { type: "object", properties: { corrected: input.schema, changes: { type: "array", items: { type: "string" } } }, required: ["corrected", "changes"] };
  const correctPart = (part: T, signal?: AbortSignal) => generateJSON<{ corrected: T; changes: string[] }>({
    fast: true,
    reasoningEffort: "low",
    instructions: `You are auditing an AI-produced ${input.label} against the underlying evidence. Remove or fix any item not supported by the evidence (wrong dates, invented cites, misattributed statements), keep everything supported, and list each change you made in one line. Do not add new items.${cutNote}${partNote} ${input.instructions ?? ""}`,
    input: `OUTPUT:\n${JSON.stringify(part)}\n\nEVIDENCE:\n${evidence}`,
    schema,
    name: "self_correction",
    maxOutputTokens,
    signal,
  });
  if (parts.length === 1) {
    const res = await correctPart(parts[0], input.signal);
    return { corrected: res.corrected ?? input.output, changes: res.changes ?? [] };
  }
  // Parts run in parallel (bounded); one failed part fails the pass (no half-corrected output is ever returned).
  const results = await mapPool(parts, Math.max(1, Math.min(b.concurrency, 4)), (part, _i, signal) => correctPart(part, signal), input.signal);
  const corrected = mergeCorrected(input.output, results.map((r, i) => r.corrected ?? parts[i]));
  return { corrected, changes: results.flatMap((r) => r.changes ?? []), parts: parts.length };
}

/** Fail-soft self-correction: on any error the original output is kept and the error is reported. */
export async function safeSelfCorrect<T>(input: Parameters<typeof selfCorrect<T>>[0] & { verify?: boolean }): Promise<{ corrected: T; changes: string[]; ran: boolean; error?: string }> {
  if (input.verify === false) return { corrected: input.output, changes: [], ran: false, error: "skipped" };
  if (!aiConfig().hasKey) return { corrected: input.output, changes: [], ran: false, error: "no_api_key" };
  try {
    const r = await selfCorrect<T>(input);
    return { ...r, ran: true };
  } catch (e) {
    if ((e as Error)?.name === "AbortError") throw e;
    return { corrected: input.output, changes: [], ran: false, error: (e as Error).message };
  }
}

// ---------------------------------------------------------------------------
// Citation cross-check (pure)
// ---------------------------------------------------------------------------

/** Bates numbers such as MFC-0041877, NG_000123, ABC-DEF-000001 (prefix of letters, separator, ≥4 digits). */
const BATES_RE = /\b([A-Z]{2,}(?:[-_][A-Z]{2,})*[-_]\d{4,})\b/g;
/** page:line cites such as 24:05, 142:8–143:2 and "Voss 19:15" (clock times like "10:30 a.m." are skipped). */
const PAGE_LINE_RE = /\b(\d{1,4}):(\d{1,2})\b(?:\s*[–-]\s*(\d{1,4}):(\d{1,2}))?(?!\s*(?:[ap]\.?m\b|[ap]\.m\.|(?:AM|PM)\b))/g;

export interface CiteCheck {
  /** Distinct record cites found in the text. */
  cites: string[];
  resolved: string[];
  unresolved: string[];
  /** Text with " [VERIFY]" appended after every unresolved cite (idempotent). */
  text: string;
}

/** Extract Bates and page:line cites from generated text. */
export function extractRecordCites(text: string): { bates: string[]; pageLines: string[] } {
  const bates = new Set<string>();
  const pageLines = new Set<string>();
  for (const m of text.matchAll(BATES_RE)) bates.add(m[1].toUpperCase());
  for (const m of text.matchAll(PAGE_LINE_RE)) { pageLines.add(`${Number(m[1])}:${Number(m[2])}`); if (m[3]) pageLines.add(`${Number(m[3])}:${Number(m[4])}`); }
  return { bates: Array.from(bates), pageLines: Array.from(pageLines) };
}

/**
 * Cross-check the record cites in `text` against the evidence set. Bates
 * numbers must belong to `evidence.bates`; page:line cites must fall inside
 * one of the evidence transcript ranges (pages are checked, lines within a
 * cited page are allowed to differ by ≤ 25 so line-level rounding does not
 * false-flag). Unresolved cites are marked [VERIFY] in the returned text.
 */
export function crossCheckCitations(text: string, evidence: { bates?: Iterable<string>; pageLines?: Iterable<string>; pages?: Iterable<number> }): CiteCheck {
  const bates = new Set(Array.from(evidence.bates ?? []).map((b) => b.toUpperCase()));
  const pages = new Set<number>(Array.from(evidence.pages ?? []));
  for (const pl of evidence.pageLines ?? []) { const p = Number(String(pl).split(":")[0]); if (Number.isFinite(p)) pages.add(p); }
  const cites = new Set<string>();
  const resolved = new Set<string>();
  const unresolved = new Set<string>();
  let out = text;
  if (bates.size || !pages.size) {
    out = out.replace(BATES_RE, (m, b: string) => {
      const key = b.toUpperCase();
      cites.add(key);
      if (bates.has(key)) { resolved.add(key); return m; }
      unresolved.add(key);
      return `${m} [VERIFY]`;
    });
  }
  if (pages.size) {
    out = out.replace(PAGE_LINE_RE, (m, p1: string, l1: string, p2?: string, l2?: string) => {
      const a = `${Number(p1)}:${Number(l1)}`;
      cites.add(a);
      const okA = pages.has(Number(p1));
      if (okA) resolved.add(a); else unresolved.add(a);
      let okB = true;
      if (p2) { const b = `${Number(p2)}:${Number(l2)}`; cites.add(b); okB = pages.has(Number(p2)); if (okB) resolved.add(b); else unresolved.add(b); }
      return okA && okB ? m : `${m} [VERIFY]`;
    });
  }
  out = out.replace(/(\[VERIFY\])(?:\s*\[VERIFY\])+/g, "$1");
  return { cites: Array.from(cites), resolved: Array.from(resolved), unresolved: Array.from(unresolved), text: out };
}

/** Fold a citation cross-check into provenance (method "citations"); keeps a claims verification if one already ran. */
export function applyCiteCheck(p: Provenance, check: CiteCheck): Provenance {
  if (!check.cites.length) return p;
  const v = p.verification;
  const status: NonNullable<Provenance["verification"]>["status"] = v?.status === "contradicted" ? "contradicted" : check.unresolved.length === 0 ? (v?.status ?? "verified") : check.unresolved.length < check.cites.length ? (v?.status === "verified" ? "partially-verified" : (v?.status ?? "partially-verified")) : (v?.status ?? "unverified");
  const notes = [v?.notes, check.unresolved.length ? `${check.unresolved.length} record cite(s) not found in the evidence: ${check.unresolved.slice(0, 6).join(", ")}` : undefined].filter(Boolean).join("; ");
  return { ...p, verification: { status, checkedAt: v?.checkedAt ?? new Date().toISOString(), method: v?.method ?? "citations", supported: v?.supported ?? check.resolved.length, unsupported: v?.unsupported ?? check.unresolved.length, contradicted: v?.contradicted ?? 0, notes: notes || undefined, changes: v?.changes, unresolvedCites: check.unresolved } };
}
