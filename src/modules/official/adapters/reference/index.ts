import "server-only";
import type { SourceAdapter } from "../../adapter";
import type { SourceId } from "../../types";
import { adapter as lawcommission } from "./lawcommission";

/** Reference sources (owned by the law / statutes stream): lawcommission. Reports are context, not law. */
export const REFERENCE_ADAPTERS: Partial<Record<SourceId, SourceAdapter>> = { lawcommission };
