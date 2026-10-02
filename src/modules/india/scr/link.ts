/**
 * Supreme Court Reports (SCR) register: parsing and EXACT linking (pure, deterministic; no I/O).
 *
 * An SCR record is the official law reporter's card for one reported judgment: the SCR citation ("[2024] 10 S.C.R.
 * 108"), the neutral citation ("2024 INSC 735"), the case number, the decision date and the official headnote. It is
 * linked to a corpus judgment only by exact identifiers, in this order:
 *   1. neutral citation (canonical "YYYY INSC N") equal to exactly one corpus Supreme Court judgment;
 *   2. otherwise case number (normalised: case, spacing, punctuation) AND decision date equal to exactly one judgment.
 * Two or more candidates → "ambiguous" (none chosen); none → "unlinked", each with the reason. No title, party-name or
 * nearest-date matching, ever.
 */
import { parseSciMetadata, type SciMetadataJson } from "@/modules/india/sources/sci";

export interface ScrCitation {
  raw: string;
  year: number;
  volume: number | null;
  /** "Supp." volumes are numbered separately. */
  supplement: boolean;
  page: number;
  /** Canonical form "[2024] 10 SCR 108" / "[1995] Supp. 1 SCR 10". */
  canonical: string;
}

/** "[2024] 10 S.C.R. 108", "[1995] Supp. (1) SCR 10", "[1950] SCR 1" → structured; null when not an SCR citation. */
export function parseScrCitation(raw: string | null | undefined): ScrCitation | null {
  const s = (raw ?? "").replace(/\s+/g, " ").trim();
  const m = /^\[(\d{4})\]\s*(Supp(?:l)?\.?\s*)?\(?(\d{1,3})?\)?\s*S\.?\s?C\.?\s?R\.?\s*(\d{1,5})$/i.exec(s);
  if (!m) return null;
  const year = Number(m[1]);
  const supplement = Boolean(m[2]);
  const volume = m[3] ? Number(m[3]) : null;
  const page = Number(m[4]);
  if (year < 1950 || year > 2100 || page < 1) return null;
  const canonical = `[${year}] ${supplement ? "Supp. " : ""}${volume != null ? `${volume} ` : ""}SCR ${page}`;
  return { raw: s, year, volume, supplement, page, canonical };
}

/** "2024 INSC 735" (any spacing / leading zeros) → canonical, else null. */
export function canonicalInsc(v: string | null | undefined): string | null {
  const m = /^\s*(\d{4})\s*INSC\s*0*(\d{1,5})\s*$/i.exec(v ?? "");
  return m ? `${m[1]} INSC ${Number(m[2])}` : null;
}

/** Case-number key: upper-case letters and digits only ("Civil Appeal No. 1234 of 2019" → "CIVILAPPEALNO1234OF2019"). */
export const caseNumberKey = (v: string | null | undefined): string | null => {
  const k = (v ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return k.length >= 4 ? k : null;
};

export interface ScrRecord {
  /** Stable id: the canonical SCR citation. */
  id: string;
  scr: ScrCitation;
  neutral: string | null;
  caseNumber: string | null;
  decisionDate: string | null;
  title: string;
  headnote: string | null;
  /** Where the card came from (dataset key or publisher URL) and its SHA-256. */
  sourceKey: string;
  sourceSha256: string;
  origin: "sci-open-data" | "operator-import";
}

export type ScrFromCard = { ok: true; record: ScrRecord } | { ok: false; reason: string };

/**
 * One SCR card from the Supreme Court's result-card HTML as preserved by the open dataset (the card is the SCR portal's
 * own markup). A card without an SCR citation is not an SCR record (reason given).
 */
export function scrFromSciCard(json: SciMetadataJson, opts: { key: string; sha256: string }): ScrFromCard {
  let parsed;
  try { parsed = parseSciMetadata(json, { key: opts.key }); } catch (e) { return { ok: false, reason: `card could not be parsed: ${(e as Error).message}` }; }
  const d = parsed.draft;
  const rep = d.citations.find((c) => c.kind === "reporter");
  const scr = parseScrCitation(rep?.raw ?? null);
  if (!scr) return { ok: false, reason: rep?.raw ? `"${rep.raw}" is not an SCR citation` : "no SCR citation on the card" };
  return {
    ok: true,
    record: {
      id: scr.canonical,
      scr,
      neutral: canonicalInsc(d.neutralCitation),
      caseNumber: d.caseNumber ?? null,
      decisionDate: d.decisionDate ?? null,
      title: d.title,
      headnote: d.headnote ?? null,
      sourceKey: opts.key,
      sourceSha256: opts.sha256,
      origin: "sci-open-data",
    },
  };
}

export interface LinkCandidates {
  /** Corpus SC judgment ids whose neutral citation equals the record's. */
  byNeutral: string[];
  /** Corpus SC judgment ids with the same case-number key and decision date. */
  byCaseAndDate: string[];
}

export type ScrLink =
  | { status: "linked"; judgmentId: string; method: "neutral_citation" | "case_number_date" }
  | { status: "ambiguous"; candidates: string[]; method: "neutral_citation" | "case_number_date"; reason: string }
  | { status: "unlinked"; reason: string };

/** The exact-link decision for one record given its candidates (see the module comment). */
export function decideScrLink(r: Pick<ScrRecord, "neutral" | "caseNumber" | "decisionDate">, c: LinkCandidates): ScrLink {
  const uniq = (xs: string[]) => [...new Set(xs)].sort();
  const byN = uniq(c.byNeutral);
  if (r.neutral && byN.length === 1) return { status: "linked", judgmentId: byN[0], method: "neutral_citation" };
  if (r.neutral && byN.length > 1) return { status: "ambiguous", candidates: byN, method: "neutral_citation", reason: `${byN.length} corpus judgments carry ${r.neutral}` };
  const byC = uniq(c.byCaseAndDate);
  const key = caseNumberKey(r.caseNumber);
  if (key && r.decisionDate && byC.length === 1) return { status: "linked", judgmentId: byC[0], method: "case_number_date" };
  if (key && r.decisionDate && byC.length > 1) return { status: "ambiguous", candidates: byC, method: "case_number_date", reason: `${byC.length} corpus judgments have case number "${r.caseNumber}" decided on ${r.decisionDate}` };
  const tried = [r.neutral ? `neutral citation ${r.neutral}` : "no neutral citation", key && r.decisionDate ? `case number "${r.caseNumber}" decided on ${r.decisionDate}` : "no usable case number and decision date"];
  return { status: "unlinked", reason: `No corpus Supreme Court judgment matches (${tried.join("; ")}).` };
}

/** Archive processing order: the last ten years first (newest first), then older years newest first. */
export function scrYearOrder(years: number[], currentYear: number): number[] {
  const uniq = [...new Set(years)].sort((a, b) => b - a);
  const recent = uniq.filter((y) => y > currentYear - 10 && y <= currentYear);
  return [...recent, ...uniq.filter((y) => !recent.includes(y))];
}
