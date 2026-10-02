import { courtOrder } from "./config";

/**
 * Work order for the PDF text worker (pure). A slice is one court × one decision year. Order:
 *   1. recent window (recentFrom → current year): priority courts first (Delhi, Bombay, Madras, Allahabad, Punjab &
 *      Haryana, Karnataka, Calcutta, Gujarat, Kerala), then every other High Court; newest year first within a court;
 *   2. older years (recentFrom - 1 → oldestYear), courts in the same order, newest first.
 * A slice's index is the queue priority of its judgments (lower first); within a slice, newest decision date first.
 */
export interface Slice { index: number; courtId: string; year: number; phase: "recent" | "older" }

export function buildSchedule(o: { recentFrom: number; oldestYear: number; currentYear: number; courts?: string[] }): Slice[] {
  const courts = o.courts ?? courtOrder();
  const out: Slice[] = [];
  const top = Math.max(o.currentYear, o.recentFrom);
  for (const courtId of courts) for (let y = top; y >= o.recentFrom; y--) out.push({ index: out.length, courtId, year: y, phase: "recent" });
  for (const courtId of courts) for (let y = o.recentFrom - 1; y >= o.oldestYear; y--) out.push({ index: out.length, courtId, year: y, phase: "older" });
  return out;
}
