/**
 * Court-fee computation interface (client-safe, deterministic).
 *
 * The Karnataka Court Fees and Suits Valuation Act, 1958 prescribes ad valorem fees by slab (Schedule I) and
 * valuation rules per kind of suit. The slab amounts have been amended several times and are NOT coded here from
 * memory: this module ships the mechanism only. A firm (or the maintainers, from the current Gazette text) supplies a
 * `CourtFeeTable`; results computed from a table that is not marked `verified` are "requires_verification", and
 * without a table the result is "requires_verification" with no amount.
 */

export interface FeeSlab {
  /** Upper bound of the slab (inclusive), in rupees; null for the last, open-ended slab. */
  upTo: number | null;
  /** Fixed fee for the slab, in rupees (added once when the amount reaches this slab). */
  fixed?: number;
  /** Rate applied to the part of the amount within this slab, e.g. 0.05 for 5%. */
  rate?: number;
}

export interface CourtFeeTable {
  id: string;
  act: string;
  /** e.g. "Schedule I, Article 1 (plaints and memoranda of appeal)". */
  article: string;
  slabs: FeeSlab[];
  /** Minimum fee, in rupees. */
  minimum?: number;
  /** Maximum fee, in rupees. */
  maximum?: number;
  effectiveFrom?: string;
  /** True only when checked against the current Gazette text by a person; recorded with the source. */
  verified: boolean;
  source: string;
}

export interface CourtFeeResult {
  status: "computed" | "requires_verification" | "invalid_input";
  /** Fee in rupees (rounded up to the rupee). */
  fee?: number;
  steps: string[];
  notes: string[];
}

/** Valuation heads under the Karnataka Act. Section numbers are deliberately not coded here (see Open risks). */
export type SuitKind = "money" | "declaration" | "injunction" | "possession" | "partition" | "specific_performance" | "other";

export const KARNATAKA_COURT_FEES_ACT = "Karnataka Court Fees and Suits Valuation Act, 1958";

/** Compute an ad valorem fee from a supplied slab table (cumulative slabs). */
export function computeAdValoremFee(amount: number, table: CourtFeeTable | null | undefined): CourtFeeResult {
  const notes: string[] = [];
  if (!Number.isFinite(amount) || amount < 0) return { status: "invalid_input", steps: [], notes: ["Amount must be a non-negative number of rupees."] };
  if (!table) {
    return { status: "requires_verification", steps: [], notes: [`No fee table loaded. Court fee under the ${KARNATAKA_COURT_FEES_ACT} must be computed from the current Schedule; slabs are not coded from memory.`] };
  }
  const steps: string[] = [];
  let fee = 0, lower = 0;
  for (const s of table.slabs) {
    const top = s.upTo ?? Infinity;
    const portion = Math.max(0, Math.min(amount, top) - lower);
    if (s.fixed) { fee += s.fixed; steps.push(`Slab up to ${s.upTo ?? "∞"}: fixed ₹${s.fixed}`); }
    if (s.rate && portion > 0) { fee += portion * s.rate; steps.push(`Slab up to ${s.upTo ?? "∞"}: ₹${portion} × ${s.rate * 100}% = ₹${(portion * s.rate).toFixed(2)}`); }
    lower = top;
    if (amount <= top) break;
  }
  if (table.minimum != null && fee < table.minimum) { steps.push(`Minimum fee ₹${table.minimum} applies.`); fee = table.minimum; }
  if (table.maximum != null && fee > table.maximum) { steps.push(`Maximum fee ₹${table.maximum} applies.`); fee = table.maximum; }
  fee = Math.ceil(fee);
  if (!table.verified) notes.push(`Fee table "${table.id}" is not marked verified (${table.source}).`);
  return { status: table.verified ? "computed" : "requires_verification", fee, steps, notes };
}
