/**
 * Citation integrity: every case citation in an answer must correspond to a
 * source a lane actually read. Mismatches get a [VERIFY] marker and a note.
 * Pure and client-safe; the network resolution step lives in the server run.
 */
import type { Citation, CitationCheck as EvidenceCitationCheck, CitationState } from "@/lib/evidence/types";
import { normalizeCitation } from "@/lib/india/citations";
import { extractCitations, type ExtractedCitation } from "../citations";
import { citedNumbers } from "./markers";
import type { CitationCrossCheck, ResearchSource } from "./types";

/** Normalise "550 U.S. 544, 555" → "550u.s.544" (pin cite dropped, whitespace removed) so cites compare reliably. */
export function normCite(c: string): string {
  const bare = c.replace(/,\s*(?:(?:p|pp|para|paras|page)\.?\s*)?\d{1,5}(?:[-–]\d{1,5})?\s*$/i, "").trim();
  // Indian citations through the shared parser, so "(2024) 10 SCR 108" and "[2024] 10 S.C.R. 108" compare equal.
  let indian: string | null = null;
  try { indian = normalizeCitation(bare); } catch { indian = null; }
  return (indian ?? bare).replace(/\s+/g, "").trim().toLowerCase();
}

function citesOf(s: ResearchSource): string[] {
  const list = [s.cite, ...(s.hit.citations ?? []), s.hit.india?.neutralCitation, ...(s.hit.india?.reporterCitations ?? [])].filter((x): x is string => Boolean(x));
  return list.map(normCite);
}

export interface CrossCheckResult {
  checks: CitationCrossCheck[];
  /** Case citations that no read source carries. */
  unmatched: ExtractedCitation[];
  /** Sources cited by number in the answer that were never read (snippet only). */
  unreadCitedNs: number[];
}

/** Cross-check case citations in `answer` against the sources; `[n]` markers are validated against the numbered list. */
export function crossCheckCitations(answer: string, sources: ResearchSource[]): CrossCheckResult {
  const extracted = extractCitations(answer).filter((c) => c.kind === "case");
  const byCite = new Map<string, ResearchSource>();
  for (const s of sources) for (const c of citesOf(s)) if (!byCite.has(c)) byCite.set(c, s);
  const checks: CitationCrossCheck[] = [];
  const unmatched: ExtractedCitation[] = [];
  for (const c of extracted) {
    const src = byCite.get(normCite(c.citation));
    if (src && src.read) checks.push({ citation: c.citation, matched: true, sourceN: src.n });
    else if (src) checks.push({ citation: c.citation, matched: false, sourceN: src.n });
    else { checks.push({ citation: c.citation, matched: false }); unmatched.push(c); }
  }
  const nums = citedNumbers(answer);
  const byN = new Map(sources.map((s) => [s.n, s] as const));
  const unreadCitedNs = Array.from(nums).filter((n) => { const s = byN.get(n); return s && !s.read; }).sort((a, b) => a - b);
  return { checks, unmatched, unreadCitedNs };
}

/**
 * Insert "[VERIFY]" after each unmatched citation (once per occurrence, never
 * doubling an existing marker) and append a short citation-check note.
 *
 * This is a rendering/export layer: the engine stores the answer text exactly as it
 * was verified (its hash binds the verdicts) plus the structured checks, and the UI and
 * exports annotate on the way out (constitution §23 answer-version binding).
 */
export function markUnverifiedCitations(answer: string, result: CrossCheckResult, opts: { remotelyResolved?: Set<string> } = {}): string {
  const checks = opts.remotelyResolved ? result.checks.map((c) => ({ ...c, resolvedRemotely: c.resolvedRemotely ?? (!c.matched && opts.remotelyResolved!.has(normCite(c.citation)) ? true : undefined) })) : result.checks;
  return annotateCitations(answer, checks, { unreadCitedNs: result.unreadCitedNs });
}

/** Annotate an answer from stored checks: "[VERIFY]" after every citation that no read source backs, plus the note. Idempotent. */
export function annotateCitations(answer: string, checks: CitationCrossCheck[], opts: { unreadCitedNs?: number[] } = {}): string {
  let out = answer;
  const unmatched = checks.filter((c) => !c.matched);
  for (const c of unmatched) {
    const esc = c.citation.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    out = out.replace(new RegExp(`(${esc})(?!\\s*\\[VERIFY\\])`, "g"), "$1 [VERIFY]");
  }
  const unread = opts.unreadCitedNs ?? [];
  if (!unmatched.length && !unread.length) return out;
  if (/^> \*\*Citation check\.\*\*/m.test(out)) return out;
  const notes: string[] = [];
  if (unmatched.length) {
    const items = unmatched.map((c) => `${c.citation}${c.sourceN ? ` (source [${c.sourceN}] was found but not read)` : c.resolvedRemotely ? " (found in the judgment corpus; not read in this run)" : " (not among the sources read in this run)"}`);
    notes.push(`${unmatched.length} case citation${unmatched.length === 1 ? "" : "s"} could not be matched to a source read in this run and ${unmatched.length === 1 ? "is" : "are"} marked [VERIFY]: ${items.join("; ")}.`);
  }
  if (unread.length) notes.push(`Sources ${unread.map((n) => `[${n}]`).join(", ")} were cited from search snippets only; open them before relying on a characterization.`);
  return `${out.trimEnd()}\n\n> **Citation check.** ${notes.join(" ")}`;
}

/**
 * Evidence-contract state of one citation check (constitution §23): resolved only when a
 * read source carries the cite; found-but-not-read or resolved only remotely requires
 * review; anything else is unresolved. There is no fallback to a "closest" source.
 */
export function citationStateOf(c: Pick<CitationCrossCheck, "matched" | "sourceN" | "resolvedRemotely">): CitationState {
  if (c.matched) return "resolved";
  if (c.sourceN != null || c.resolvedRemotely) return "requires_review";
  return "unresolved";
}

/** Attach remote-resolution flags and evidence states to a cross-check result. */
export function withCitationStates(checks: CitationCrossCheck[], remotelyResolved: Set<string> = new Set()): CitationCrossCheck[] {
  return checks.map((c) => {
    const resolvedRemotely = !c.matched && remotelyResolved.has(normCite(c.citation)) ? true : c.resolvedRemotely;
    const next: CitationCrossCheck = { ...c, resolvedRemotely };
    if (resolvedRemotely === undefined) delete next.resolvedRemotely;
    next.state = citationStateOf(next);
    return next;
  });
}

/** The evidence-contract citation check record bound to the answer hash it was computed for. */
export function buildCitationCheck(artifactHash: string, checks: CitationCrossCheck[], checkedAt = new Date().toISOString()): EvidenceCitationCheck {
  const citations: Citation[] = checks.map((c) => {
    const state = c.state ?? citationStateOf(c);
    const reason = state === "resolved" ? undefined : c.sourceN != null ? `source [${c.sourceN}] was found but not read` : c.resolvedRemotely ? "found in the judgment corpus; not read in this run" : "not among the sources read in this run";
    return { raw: c.citation, state, reason };
  });
  return {
    artifactHash,
    checkedAt,
    citations,
    resolved: citations.filter((x) => x.state === "resolved").length,
    unresolved: citations.filter((x) => x.state === "unresolved").length,
    excluded: citations.filter((x) => x.state === "excluded").length,
    requiresReview: citations.filter((x) => x.state === "requires_review").length,
  };
}
