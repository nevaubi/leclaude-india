import "server-only";
import type { DiscoverResult, SourceAdapter } from "../../adapter";
import type { SourceDef } from "../../types";
import { GOV_TERMS } from "./shared";

/**
 * National Green Tribunal judgments and orders — registered, disabled.
 *
 * Checked 2026-10-02 (Firecrawl, location IN): every judgment / order listing on greentribunal.gov.in
 * (/judgementOrder/zonalbenchwise, /casenumber, /partyname, /judgesmember, /case-advance-search) is a search form behind
 * a CAPTCHA (sites/all/modules/custom/case_status/captcha.php), and the homepage links no judgment or order PDFs. No
 * open listing exists, so nothing is discovered; CAPTCHAs are never bypassed.
 */

const def: SourceDef = {
  id: "ngt-orders",
  name: "National Green Tribunal judgments and orders",
  publisher: "National Green Tribunal",
  kinds: ["judgment", "order"],
  forum: "ngt",
  homepage: "https://www.greentribunal.gov.in/judgementOrder/zonalbenchwise",
  fetch: "firecrawl_in",
  cadenceMinutes: 1440,
  attribution: "Published by the National Green Tribunal (greentribunal.gov.in).",
  terms: GOV_TERMS,
  enabled: false,
  notes: [
    "Disabled: NGT judgment / order search (date-wise, case number, party, judge, free text) requires a CAPTCHA (checked 2026-10-02); no open listing of judgments or orders was found.",
    "NGT publishes per-court cause-list pages (e.g. /principal-court-II-cause-list) and office orders on holidays (/important-orders); they are not ingested by this source.",
  ],
};

export const adapter: SourceAdapter = {
  def,
  async discover(): Promise<DiscoverResult> {
    return { items: [], nextCursor: null, done: true, notes: ["ngt-orders is disabled: listings are CAPTCHA-protected"] };
  },
};
