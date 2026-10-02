import "server-only";
import { findLatestMatterOrder } from "@/modules/matters/desk/latest-order";
import { isServiceError } from "@/modules/workspace/errors";
import type { AnyNodeType } from "./registry";
import { StepError, num, resolveConfig, str, type Executor } from "./executors";

/**
 * Official-sources steps. `data.official_order` chooses the run matter's latest published order in code (exact
 * identifier matches only, see src/modules/matters/desk/latest-order.ts) and reads its text. It never searches by free
 * text and never returns another case's order: every outcome other than "found" is an explicit status with a message,
 * which a branch can route on. Only the run's own matter is used (authorized when the run started); a node config
 * cannot point it at another matter.
 */

const dataOfficialOrder: Executor = async (x) => {
  const matterId = x.run.matterId;
  if (!matterId) throw new StepError("This step needs the run's matter: start the workflow with a matter.", "no_matter");
  const c = resolveConfig(x);
  try {
    const r = await findLatestMatterOrder(matterId, { forum: str(c.forum), caseNumber: str(c.caseNumber), orderRef: str(c.orderRef), maxChars: num(c.maxChars, 60_000) });
    x.log(`${r.status}: ${r.message}`);
    return { output: r };
  } catch (e) {
    if (isServiceError(e)) throw new StepError(e.message, e.code ?? "not_found");
    throw e;
  }
};

export const OFFICIAL_EXECUTORS: Partial<Record<AnyNodeType, Executor>> = {
  "data.official_order": dataOfficialOrder,
};
