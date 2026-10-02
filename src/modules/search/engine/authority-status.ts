/**
 * Authority status table for a research answer (constitution §23, §34; roadmap Evals "no badge says verified unless
 * tied to corpus text read in the run"). Pure and client-safe.
 *
 * One row per authority the answer relies on: every judgment / statute source it cites by number, plus every
 * authority citation string in the text (neutral, INSC, SCR, SCC, AIR, Cri LJ …) that no cited source carries.
 * States are separate facts, never blended:
 *
 *   unresolved          the citation string resolves to no corpus record (neither a source of this run nor the judgment
 *                       index): shown as unresolved, never substituted with a near match;
 *   text_not_available  the record exists but the corpus has no text for it (metadata-only): it can be "found", it can
 *                       never be "supported";
 *   found               the record exists (a source of this run with text, or a citation the judgment index carries)
 *                       but was not read in this run;
 *   read                the text was read in this run, but no claim attributed to it was checked as supported against
 *                       that text for the current answer hash (not checked, unsupported or contradicted — the note says);
 *   supported           read, and at least one claim attributed to it was supported by its text (the verifier, with the
 *                       quotation confirmed in code) for the current answer hash, and none was contradicted.
 */
import { extractAuthorityCitations } from "@/lib/india/citation-strings";
import { formatBluebook } from "../normalize";
import { normCite } from "./citecheck";
import { citedNumbers } from "./markers";
import type { CitationCrossCheck, ResearchSource, VerificationSummary } from "./types";

export type AuthorityStatus = "supported" | "read" | "found" | "unresolved" | "text_not_available";

export const AUTHORITY_STATUS_LABEL: Record<AuthorityStatus, string> = {
  supported: "Supported",
  read: "Read",
  found: "Found",
  unresolved: "Unresolved",
  text_not_available: "Text not available",
};

export interface AuthorityStatusRow {
  /** Display citation (the engine's formatted citation for a source; the string as written for an unresolved one). */
  authority: string;
  kind: "judgment" | "statute" | "other";
  status: AuthorityStatus;
  /** Source number in the answer, when the authority is a numbered source. */
  sourceN?: number;
  /** Corpus record id (judgment id) when the authority resolved to one. */
  recordId?: string;
  /** Citation strings in the answer that resolved to this row. */
  citations: string[];
  supportedClaims: number;
  unsupportedClaims: number;
  contradictedClaims: number;
  /** Later judgments whose text carries this authority's citation (only where text exists; null = not counted). */
  citedBy?: number | null;
  note: string;
}

export interface AuthorityStatusTable {
  artifactHash: string;
  rows: AuthorityStatusRow[];
  counts: Record<AuthorityStatus, number>;
}

function kindOf(s: ResearchSource): AuthorityStatusRow["kind"] {
  return s.kind === "caselaw" ? "judgment" : s.kind === "statutes" || s.kind === "regulations" ? "statute" : "other";
}

function citesOf(s: ResearchSource): string[] {
  return [s.cite, ...(s.hit.citations ?? []), s.hit.india?.neutralCitation, ...(s.hit.india?.reporterCitations ?? [])].filter((x): x is string => Boolean(x));
}

/** True when the corpus holds no text for this source (metadata-only record): nothing can be read or supported. */
export function textUnavailable(s: ResearchSource): boolean {
  return !s.read && !s.hit.readRef;
}

/**
 * Build the table. `verification` counts only when it is bound to `artifactHash` (a revised answer that was not
 * re-verified shows "read", never "supported"). `remotelyKnown` holds normalised citations (normCite) the judgment index
 * carries; `citedBy` maps source ids to "cited by" counts where text exists.
 */
export function buildAuthorityStatus(input: {
  answer: string;
  artifactHash: string;
  sources: ResearchSource[];
  verification?: Pick<VerificationSummary, "artifactHash" | "verdicts"> | null;
  checks?: CitationCrossCheck[];
  remotelyKnown?: Set<string>;
  citedBy?: Map<string, number>;
}): AuthorityStatusTable {
  const { answer, artifactHash } = input;
  const numbered = input.sources.filter((s) => s.n != null);
  const byN = new Map(numbered.map((s) => [s.n!, s] as const));
  const current = input.verification && input.verification.artifactHash === artifactHash ? input.verification : null;
  const verdicts = current?.verdicts ?? [];
  const rows: AuthorityStatusRow[] = [];
  const rowBySource = new Map<string, AuthorityStatusRow>();

  const sourceRow = (s: ResearchSource): AuthorityStatusRow => {
    const existing = rowBySource.get(s.id);
    if (existing) return existing;
    const mine = verdicts.filter((v) => v.sourceN === s.n);
    const supported = mine.filter((v) => v.status === "supported" && v.quoteVerified !== false).length;
    const unsupported = mine.filter((v) => v.status === "unsupported" || (v.status === "supported" && v.quoteVerified === false)).length;
    const contradicted = mine.filter((v) => v.status === "contradicted").length;
    let status: AuthorityStatus;
    let note: string;
    if (textUnavailable(s)) { status = "text_not_available"; note = "Metadata record only: the corpus holds no text for it, so nothing attributed to it could be checked."; }
    else if (!s.read) { status = "found"; note = "Text exists but was not read in this run; any characterization rests on the search excerpt."; }
    else if (contradicted) { status = "read"; note = `Read; ${contradicted} claim${contradicted === 1 ? " is" : "s are"} contradicted by its text.`; }
    else if (supported) { status = "supported"; note = `Read; ${supported} claim${supported === 1 ? "" : "s"} checked against its text${unsupported ? ` (${unsupported} not supported)` : ""}.`; }
    else if (!current) { status = "read"; note = input.verification ? "Read; the answer changed after verification and was not re-checked." : "Read; claims were not checked against its text."; }
    else { status = "read"; note = mine.length ? `Read; no claim attributed to it was supported by its text (${unsupported} unsupported).` : "Read; no claim was attributed to it by the verifier."; }
    const row: AuthorityStatusRow = {
      authority: formatBluebook(s.hit) || s.cite || s.title,
      kind: kindOf(s), status, sourceN: s.n, recordId: s.hit.india?.judgmentId, citations: [],
      supportedClaims: status === "supported" ? supported : 0, unsupportedClaims: unsupported, contradictedClaims: contradicted,
      citedBy: input.citedBy?.has(s.id) ? input.citedBy.get(s.id)! : s.kind === "caselaw" ? null : undefined,
      note,
    };
    rowBySource.set(s.id, row);
    rows.push(row);
    return row;
  };

  // 1. Every numbered source the answer cites.
  for (const n of Array.from(citedNumbers(answer)).sort((a, b) => a - b)) {
    const s = byN.get(n);
    if (s && (s.kind === "caselaw" || s.kind === "statutes" || s.kind === "regulations")) sourceRow(s);
  }

  // 2. Every authority citation string in the text, resolved exactly (normalised comparison) — never to a near match.
  const bySourceCite = new Map<string, ResearchSource>();
  for (const s of numbered) for (const c of citesOf(s)) { const k = normCite(c); if (!bySourceCite.has(k)) bySourceCite.set(k, s); }
  const checkByCite = new Map((input.checks ?? []).map((c) => [normCite(c.citation), c] as const));
  const unresolvedSeen = new Set<string>();
  for (const c of extractAuthorityCitations(answer)) {
    const k = normCite(c.raw);
    const s = bySourceCite.get(k);
    if (s) { const row = sourceRow(s); if (!row.citations.includes(c.raw)) row.citations.push(c.raw); continue; }
    if (unresolvedSeen.has(c.key)) continue;
    unresolvedSeen.add(c.key);
    const known = input.remotelyKnown?.has(k) || checkByCite.get(k)?.resolvedRemotely === true;
    rows.push({
      authority: c.raw, kind: "judgment", status: known && c.valid ? "found" : "unresolved", citations: [c.raw],
      supportedClaims: 0, unsupportedClaims: 0, contradictedClaims: 0, citedBy: null,
      note: !c.valid ? `Not a valid citation (${c.issues.join("; ")}); not resolved to any record.` : known ? "The judgment index carries this citation, but it was not among the sources read in this run." : "No record in the corpus or among this run's sources carries this citation; it is not substituted with another judgment.",
    });
  }

  const counts: Record<AuthorityStatus, number> = { supported: 0, read: 0, found: 0, unresolved: 0, text_not_available: 0 };
  for (const r of rows) counts[r.status]++;
  return { artifactHash, rows, counts };
}

/** Markdown rendering for exports and the persisted note (the answer text itself is never rewritten). */
export function authorityStatusMarkdown(t: AuthorityStatusTable, title = "Authority status"): string {
  if (!t.rows.length) return "";
  const cell = (s: string | number | undefined | null) => String(s ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim() || "—";
  const head = `### ${title}\n\n| # | Authority | Status | Claims supported | Cited by | Note |\n|---|---|---|---|---|---|`;
  const body = t.rows.map((r) => `| ${r.sourceN ?? "—"} | ${cell(r.authority)} | ${AUTHORITY_STATUS_LABEL[r.status]} | ${r.supportedClaims} | ${r.citedBy == null ? "—" : r.citedBy} | ${cell(r.note)} |`);
  return [head, ...body].join("\n");
}

/** Share of authority strings in the answer that resolved to a corpus record (found, read or supported). */
export function citationResolutionRate(t: AuthorityStatusTable): number | null {
  const strings = t.rows.filter((r) => r.citations.length);
  if (!strings.length) return null;
  return strings.filter((r) => r.status !== "unresolved").length / strings.length;
}

