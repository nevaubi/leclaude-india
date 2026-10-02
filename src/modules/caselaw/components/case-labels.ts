import { courtById } from "@/lib/india/courts";
import { courtShortName, type CaseHit } from "../shared";

/** "Supreme Court" / "Karnataka HC" / "Other court" for a record. */
export function courtLabel(h: Pick<CaseHit, "court" | "court_id" | "court_code">): string {
  if (h.court) return h.court_id === "sci" ? "Supreme Court" : courtShortName(h.court);
  return "Other court";
}

/** "Dharwad · 2-judge" from the registry bench and the bench strength (null when neither is known). */
export function benchLabel(h: Pick<CaseHit, "court_id" | "bench_id" | "bench_code" | "bench_strength">): string | null {
  const bench = courtById(h.court_id)?.benches.find((b) => b.id === h.bench_id);
  const where = h.court_id === "sci" ? null : bench ? bench.city : null;
  const strength = h.bench_strength ? `${h.bench_strength}-judge` : null;
  return [where, strength].filter(Boolean).join(" · ") || null;
}
