import "server-only";
import type { SourceAdapter } from "../../adapter";
import type { SourceId } from "../../types";

/** Court and tribunal adapters (owned by the courts stream): sci-causelist, sci-orders, sci-calendar, hc-calendars,
 *  dhc-causelist, nclt, nclat, ngt-orders. */
export const COURT_ADAPTERS: Partial<Record<SourceId, SourceAdapter>> = {};
