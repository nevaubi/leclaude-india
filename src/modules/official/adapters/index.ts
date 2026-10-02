import "server-only";
import type { SourceAdapter } from "../adapter";
import type { SourceId } from "../types";
import { COURT_ADAPTERS } from "./courts";
import { REGULATOR_ADAPTERS } from "./regulators";

/** All registered adapters by source id (courts stream + regulators stream). */
export const ADAPTERS: Partial<Record<SourceId, SourceAdapter>> = { ...COURT_ADAPTERS, ...REGULATOR_ADAPTERS };

export function adapterFor(id: SourceId): SourceAdapter | null {
  return ADAPTERS[id] ?? null;
}
