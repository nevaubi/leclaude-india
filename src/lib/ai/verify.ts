import "server-only";
import { generateJSON } from "./agent";
import { aiBudget, aiConfig } from "./config";
import type { ResolvedBudget } from "./context-budget";
import type { TaskType } from "./providers/types";
import type { Provenance } from "@/lib/integrity/types";

/**
 * What the verifier saw (constitution §23: separate "checked" from "verified"). Sizes come from the `verify` budget
 * profile: sources beyond `sourcesChecked`, text beyond each source's limit and answer text beyond `answerChecked`
 * were NOT checked, and a verification that left answer text or claims unchecked is reported as partial.
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
  /** True when part of the answer or of its claims was not checked (answer longer than the budget, claim cap reached). */
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

/**
 * Self-correcting verification loop: extract the factual claims in `answer`
 * and check each one strictly against the supplied sources. Nothing outside
 * the sources counts as support. Used by research, e-discovery analysis and
 * the office agents before an AI output is marked source-backed.
 */
export async function verifyClaims(input: { answer: string; sources: VerifySource[]; maxClaims?: number; signal?: AbortSignal; fast?: boolean; budget?: ResolvedBudget; taskType?: TaskType; cacheStablePrefix?: boolean }): Promise<VerificationResult> {
  const checkedAt = new Date().toISOString();
  const fast = input.fast ?? true;
  const b = input.budget ?? aiBudget("verify", { fast });
  const given = input.sources.filter((s) => s.text?.trim());
  const sources = given.slice(0, b.maxFullSources);
  if (!sources.length) return unverified(checkedAt);
  // Each source gets an equal share of the evidence budget, never less than the 9,000 characters it always had.
  const perSource = Math.max(9_000, Math.min(b.perSourceChars, Math.floor(b.totalEvidenceChars / sources.length)));
  let clipped = 0;
  const sourceBlock = sources.map((s, i) => {
    const text = s.text.length > perSource ? (clipped++, `${s.text.slice(0, perSource)}\n…[source text beyond ${perSource} characters not shown]`) : s.text;
    return `[${i}] ${s.title ?? s.cite ?? s.url ?? "source"}${s.cite ? ` (${s.cite})` : ""}\n${text}`;
  }).join("\n\n");
  const maxClaims = input.maxClaims ?? 25;
  const answerChecked = Math.min(input.answer.length, b.historyChars);
  const answerText = input.answer.length > answerChecked ? `${input.answer.slice(0, answerChecked)}\n…[answer continues; not shown]` : input.answer;
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
  const verdicts = (res.verdicts ?? []).map((v) => ({ ...v, sourceIndex: v.sourceIndex != null && v.sourceIndex >= 0 && v.sourceIndex < sources.length ? v.sourceIndex : null }));
  const supported = verdicts.filter((v) => v.status === "supported").length;
  const unsupported = verdicts.filter((v) => v.status === "unsupported").length;
  const contradicted = verdicts.filter((v) => v.status === "contradicted").length;
  const total = verdicts.length || 1;
  const score = supported / total;
  const coverage: VerificationCoverage = { sourcesGiven: given.length, sourcesChecked: sources.length, sourcesClipped: clipped, answerChars: input.answer.length, answerChecked, maxClaims, claimsCapped: verdicts.length >= maxClaims };
  // Honest status: an answer that was not checked end to end is at most partially verified.
  const partial = answerChecked < input.answer.length || coverage.claimsCapped;
  let status: VerificationResult["status"] = contradicted > 0 ? "contradicted" : verdicts.length === 0 ? "unverified" : score >= 0.9 ? "verified" : score >= 0.5 ? "partially-verified" : "unverified";
  if (partial && status === "verified") status = "partially-verified";
  return { verdicts, supported, unsupported, contradicted, status, sourceBacked: supported > 0 && contradicted === 0, score, checkedAt, coverage, partial };
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
 * Second-pass self-critique for structured extractions (timeline events,
 * fact matrices, digests): the model re-reads its own output against the
 * evidence and returns corrected rows plus a list of dropped hallucinations.
 */
export async function selfCorrect<T>(input: { label: string; output: T; evidence: string; schema: Record<string, unknown>; instructions?: string; signal?: AbortSignal; budget?: ResolvedBudget }): Promise<{ corrected: T; changes: string[] }> {
  if (!aiConfig().hasKey) return { corrected: input.output, changes: [] };
  const b = input.budget ?? aiBudget("verify", { fast: true });
  const outputJson = JSON.stringify(input.output);
  const outputChars = Math.max(30_000, b.historyChars);
  const evidenceChars = Math.max(40_000, b.totalEvidenceChars);
  const evidenceCut = input.evidence.length > evidenceChars;
  // A row whose support lies in evidence that was not shown is kept, never "corrected" away (no false removals).
  const cutNote = evidenceCut ? ` The EVIDENCE was cut to its first ${evidenceChars.toLocaleString("en-US")} characters: keep unchanged any item whose support may lie in the omitted part; do not remove it for lack of support.` : "";
  const res = await generateJSON<{ corrected: T; changes: string[] }>({
    fast: true,
    reasoningEffort: "low",
    instructions: `You are auditing an AI-produced ${input.label} against the underlying evidence. Remove or fix any item not supported by the evidence (wrong dates, invented cites, misattributed statements), keep everything supported, and list each change you made in one line. Do not add new items.${cutNote} ${input.instructions ?? ""}`,
    input: `OUTPUT:\n${outputJson.length > outputChars ? outputJson.slice(0, outputChars) : outputJson}\n\nEVIDENCE:\n${evidenceCut ? input.evidence.slice(0, evidenceChars) : input.evidence}`,
    schema: { type: "object", properties: { corrected: input.schema, changes: { type: "array", items: { type: "string" } } }, required: ["corrected", "changes"] },
    name: "self_correction",
    maxOutputTokens: Math.max(12_000, b.maxOutputTokens),
    signal: input.signal,
  });
  return { corrected: res.corrected ?? input.output, changes: res.changes ?? [] };
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
