import "server-only";
import type { SourceAdapter } from "../../adapter";
import type { SourceId } from "../../types";

/** Regulator, gazette, tax and Parliament adapters (owned by the regulators stream): ibbi, sebi-orders, sat-orders,
 *  cci-orders, egazette, cbic, gst-council, cbdt, mca-master, sansad. */
export const REGULATOR_ADAPTERS: Partial<Record<SourceId, SourceAdapter>> = {};
