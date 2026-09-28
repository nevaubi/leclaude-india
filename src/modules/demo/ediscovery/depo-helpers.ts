import type { Deposition, DepositionQA, EDocument } from "@/lib/types/domain";
import { parseIndianDeposition, type IndiaQA } from "@/modules/ediscovery/analysis/india-deposition";
import { resolveExhibit, type IndiaEDocument } from "@/modules/ediscovery/india";
import type { DemoPerson } from "./people";

/** Resolves documents for testimony and analysis by slug (`demo_in_ed_<slug>`); unknown slugs throw so nothing drifts. */
export interface DocIndex {
  byId: Map<string, IndiaEDocument>;
  doc(slug: string): IndiaEDocument;
  /** Reference shown in citations: the exhibit mark when marked, else the document reference. */
  ref(slug: string): string;
}

export function docIndex(docs: IndiaEDocument[]): DocIndex {
  const byId = new Map(docs.map((d) => [d.id, d]));
  const doc = (slug: string) => {
    const d = byId.get(`demo_in_ed_${slug}`);
    if (!d) throw new Error(`demo India pack cites unknown document ${slug}`);
    return d;
  };
  return { byId, doc, ref: (slug) => { const d = doc(slug); return d.india?.exhibit ?? d.bates; } };
}

/** Stored deposition with the Indian record fields. */
export type IndiaDeposition = Omit<Deposition, "transcript"> & {
  transcript: IndiaQA[];
  india: { designation: string; side: "plaintiff" | "defendant"; chiefByAffidavit: boolean; examinedOn: string[]; sheetDocId: string };
};

export interface DepositionInput {
  id: string;
  matterId: string;
  sheet: string;
  witness: DemoPerson;
  designation: string;
  side: "plaintiff" | "defendant";
  takenBy: string;
  defendingBy: string;
  location: string;
  examinedOn: string[];
  sheetDocId: string;
  docs: IndiaEDocument[];
}

/**
 * Build a deposition from its sheet with the Indian parser. Every exhibit mark in the record must resolve to exactly
 * one document of the same matter (the demo refuses to build otherwise), so the exhibit panel never shows a
 * substituted document.
 */
export function buildDeposition(input: DepositionInput): IndiaDeposition {
  const parsed = parseIndianDeposition(input.sheet);
  if (!parsed.transcript.length) throw new Error(`demo deposition ${input.id}: sheet did not parse`);
  const rows = parsed.transcript as IndiaQA[];
  if (!rows.some((r) => r.segment === "chief") || !rows.some((r) => r.segment === "cross")) throw new Error(`demo deposition ${input.id}: chief and cross segments are required`);
  const exhibits = parsed.exhibits.map((e) => {
    const r = resolveExhibit(e.id, input.docs, input.matterId);
    if (r.status !== "resolved") throw new Error(`demo deposition ${input.id}: ${e.id} ${r.reason}`);
    const d = input.docs.find((x) => x.id === r.docId)!;
    return { id: r.mark, description: d.subject, bates: d.bates };
  });
  return {
    id: input.id,
    matterId: input.matterId,
    witnessId: input.witness.id,
    witnessName: `${input.witness.name} (${input.designation})`,
    witnessTitle: input.witness.title,
    date: input.examinedOn[0],
    takenBy: input.takenBy,
    defendingBy: input.defendingBy,
    location: input.location,
    pages: parsed.pages,
    transcript: parsed.transcript,
    exhibits,
    status: "reviewed",
    india: { designation: input.designation, side: input.side, chiefByAffidavit: true, examinedOn: input.examinedOn, sheetDocId: input.sheetDocId },
  };
}

/** The one row whose text contains `phrase` (throws when none or several match, so cites cannot drift). */
export function row(dep: { id: string; transcript: DepositionQA[] }, phrase: string): { index: number; qa: IndiaQA } {
  const hits = dep.transcript.map((qa, index) => ({ qa: qa as IndiaQA, index })).filter(({ qa }) => `${qa.question} ${qa.answer}`.includes(phrase));
  if (hits.length !== 1) throw new Error(`demo testimony ${dep.id}: "${phrase.slice(0, 50)}" matched ${hits.length} rows`);
  return hits[0];
}

/** Add flags / a note to the row containing `phrase`. */
export function flag(dep: IndiaDeposition, phrase: string, flags: NonNullable<DepositionQA["flags"]>, note?: string) {
  const { qa } = row(dep, phrase);
  qa.flags = Array.from(new Set([...(qa.flags ?? []), ...flags]));
  if (note) qa.note = note;
}

/** "PW-1 5:3" (designation page:line) or "PW-1 chief ¶7". */
export function cite(dep: IndiaDeposition, phrase: string): string {
  const { qa } = row(dep, phrase);
  return `${dep.india.designation} ${qa.page}:${qa.line}${qa.segment === "chief" && qa.para ? ` (chief ¶${qa.para})` : ""}`;
}

export type { EDocument };
