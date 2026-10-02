import type { DepositionQA } from "@/lib/types/domain";

export const KALE = "Radhika Kale";
export const MEHRA = "Arjun Mehra";
export const RAMAN = "Priya Raman";

type Extra = Partial<Pick<DepositionQA, "objection" | "exhibit" | "flags" | "note">>;

/** Compact Q/A constructor for seeded transcripts. */
export function qa(page: number, line: number, question: string, answer: string, extra: Extra = {}): DepositionQA {
  const out: DepositionQA = { page, line, question, answer };
  if (extra.objection) out.objection = extra.objection;
  if (extra.exhibit) out.exhibit = extra.exhibit;
  if (extra.flags?.length) out.flags = extra.flags;
  if (extra.note) out.note = extra.note;
  return out;
}

export function obj(by: string, basis: string, text?: string) {
  return text ? { by, basis, text } : { by, basis };
}
