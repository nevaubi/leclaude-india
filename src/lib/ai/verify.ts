import "server-only";
import { generateJSON } from "./agent";
import { aiConfig } from "./config";
import type { Provenance } from "@/lib/integrity/types";

/** Characters of each source shown to the verifier: room for focused, ¶-numbered passages without cutting them off. */
const SOURCE_CHARS = 9000;

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
export async function verifyClaims(input: { answer: string; sources: VerifySource[]; maxClaims?: number; signal?: AbortSignal; fast?: boolean }): Promise<VerificationResult> {
  const checkedAt = new Date().toISOString();
  const sources = input.sources.filter((s) => s.text?.trim()).slice(0, 24);
  if (!sources.length) return unverified(checkedAt);
  const sourceBlock = sources.map((s, i) => `[${i}] ${s.title ?? s.cite ?? s.url ?? "source"}${s.cite ? ` (${s.cite})` : ""}\n${s.text.slice(0, SOURCE_CHARS)}`).join("\n\n");
  const res = await generateJSON<{ verdicts: ClaimVerdict[] }>({
    fast: input.fast ?? true,
    reasoningEffort: "low",
    instructions: `You are a meticulous verification clerk at a law firm. Extract every factual or legal claim in the ANSWER (dates, holdings, quotes, numbers, who-said-what, citations) — at most ${input.maxClaims ?? 25} — and decide for each whether the SOURCES support it verbatim or in substance, contradict it, or say nothing about it. Only the sources count; general knowledge is "unsupported". Quote the exact supporting or contradicting passage. Be strict about pin cites, dates and numbers. Sources and answers may be in Indian languages (Hindi, Kannada, Telugu, Urdu and others): judge meaning across languages, but a QUOTE must appear verbatim in the source's own language — a translated passage presented in quotation marks as the source's words is \"unsupported\". A rendering labelled \"(translation)\" is judged as a paraphrase.`,
    input: `ANSWER:\n${input.answer.slice(0, 20_000)}\n\nSOURCES:\n${sourceBlock}`,
    schema: VERDICT_SCHEMA,
    name: "claim_verification",
    maxOutputTokens: 6000,
    signal: input.signal,
  });
  const verdicts = (res.verdicts ?? []).map((v) => ({ ...v, sourceIndex: v.sourceIndex != null && v.sourceIndex >= 0 && v.sourceIndex < sources.length ? v.sourceIndex : null }));
  const supported = verdicts.filter((v) => v.status === "supported").length;
  const unsupported = verdicts.filter((v) => v.status === "unsupported").length;
  const contradicted = verdicts.filter((v) => v.status === "contradicted").length;
  const total = verdicts.length || 1;
  const score = supported / total;
  const status: VerificationResult["status"] = contradicted > 0 ? "contradicted" : verdicts.length === 0 ? "unverified" : score >= 0.9 ? "verified" : score >= 0.5 ? "partially-verified" : "unverified";
  return { verdicts, supported, unsupported, contradicted, status, sourceBacked: supported > 0 && contradicted === 0, score, checkedAt };
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
  return { ...p, verification: { ...(p.verification ?? {}), status: v.status, checkedAt: v.checkedAt, method, supported: v.supported, unsupported: v.unsupported, contradicted: v.contradicted, notes: notes.length ? notes.join("; ") : p.verification?.notes } };
}

/**
 * Second-pass self-critique for structured extractions (timeline events,
 * fact matrices, digests): the model re-reads its own output against the
 * evidence and returns corrected rows plus a list of dropped hallucinations.
 */
export async function selfCorrect<T>(input: { label: string; output: T; evidence: string; schema: Record<string, unknown>; instructions?: string; signal?: AbortSignal }): Promise<{ corrected: T; changes: string[] }> {
  if (!aiConfig().hasKey) return { corrected: input.output, changes: [] };
  const res = await generateJSON<{ corrected: T; changes: string[] }>({
    fast: true,
    reasoningEffort: "low",
    instructions: `You are auditing an AI-produced ${input.label} against the underlying evidence. Remove or fix any item not supported by the evidence (wrong dates, invented cites, misattributed statements), keep everything supported, and list each change you made in one line. Do not add new items. ${input.instructions ?? ""}`,
    input: `OUTPUT:\n${JSON.stringify(input.output).slice(0, 30_000)}\n\nEVIDENCE:\n${input.evidence.slice(0, 40_000)}`,
    schema: { type: "object", properties: { corrected: input.schema, changes: { type: "array", items: { type: "string" } } }, required: ["corrected", "changes"] },
    name: "self_correction",
    maxOutputTokens: 12_000,
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
