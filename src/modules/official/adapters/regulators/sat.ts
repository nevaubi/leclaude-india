import "server-only";
import type { SourceAdapter } from "../../adapter";
import type { SourceDef } from "../../types";
import { GOV_TERMS, disabledResult } from "./common";

/**
 * Securities Appellate Tribunal portal (satweb.sat.gov.in). Every order-search tab requires a CAPTCHA, so the portal is
 * registered DISABLED and never automated. SAT orders are ingested through SEBI's mirror ("Orders of SAT", sebi-orders
 * smid=1, forum "sat").
 */
export const def: SourceDef = {
  id: "sat-orders",
  name: "Securities Appellate Tribunal orders (portal)",
  publisher: "Securities Appellate Tribunal",
  kinds: ["order", "judgment"],
  forum: "sat",
  homepage: "https://satweb.sat.gov.in/orders",
  fetch: "direct",
  cadenceMinutes: 1440,
  attribution: "Securities Appellate Tribunal (satweb.sat.gov.in).",
  terms: GOV_TERMS,
  enabled: false,
  notes: [
    "SAT orders are ingested through SEBI Orders of SAT (sebi-orders smid=1)",
    "The SAT portal's order search is CAPTCHA-gated; CAPTCHAs are never bypassed.",
  ],
};

export const adapter: SourceAdapter = {
  def,
  async discover() {
    return disabledResult("sat-orders is disabled: SAT orders are ingested through SEBI Orders of SAT (sebi-orders smid=1).");
  },
};
