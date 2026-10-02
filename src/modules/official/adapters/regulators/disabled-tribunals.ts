import "server-only";
import type { SourceAdapter } from "../../adapter";
import type { SourceDef } from "../../types";
import { GOV_TERMS, disabledResult } from "./common";

/**
 * Tribunals checked on 2026-10-02 (Firecrawl, location IN) whose orders cannot be listed lawfully and automatically.
 * They are registered DISABLED with the reason, so status pages and agents can say why they are absent. Nothing is ever
 * fetched; CAPTCHAs, logins and session-bound search forms are never automated.
 */

function disabled(def: Omit<SourceDef, "enabled" | "terms"> & { reason: string }): SourceAdapter {
  const { reason, ...rest } = def;
  const full: SourceDef = { ...rest, terms: GOV_TERMS, enabled: false };
  return {
    def: full,
    async discover() {
      return disabledResult(`${def.id} is disabled: ${reason}`);
    },
  };
}

/**
 * CESTAT (cestat.gov.in/final-order-status): the final-order search is a POST to /order-status-web carrying a
 * session-bound CSRF token (page meta csrf_token, renewed on every answer) and a captcha_code field that the page's own
 * script pre-fills and hides. Answers are DataTables JSON. No open listing of final orders exists; the session-bound
 * form cannot be sent by the stateless official fetchers and the answer shape could not be verified.
 */
export const cestat = disabled({
  id: "cestat-orders",
  name: "CESTAT final orders",
  publisher: "Customs, Excise and Service Tax Appellate Tribunal",
  kinds: ["order"],
  forum: "cestat",
  homepage: "https://cestat.gov.in/final-order-status",
  fetch: "firecrawl_in",
  cadenceMinutes: 1440,
  attribution: "Customs, Excise and Service Tax Appellate Tribunal (cestat.gov.in).",
  reason: "final orders are only reachable through a session-bound search form (CSRF token per session, captcha field); no open listing.",
  notes: [
    "Disabled: CESTAT final orders are only reachable through a session-bound search form (POST /order-status-web with a per-session CSRF token and a captcha field), checked 2026-10-02. No open listing exists.",
    "Enabling it needs a reviewed session-aware fetcher and a verified answer shape; CAPTCHA fields are never filled by automation.",
  ],
});

/**
 * NCDRC: judgments moved to e-Jagriti (e-jagriti.gov.in), a single-page app; every automated fetch of it failed on
 * 2026-10-02 (Firecrawl: "All scraping engines failed", both the home page and /judgement-search) and ncdrc.nic.in is
 * a client-rendered shell without judgment links.
 */
export const ncdrc = disabled({
  id: "ncdrc",
  name: "NCDRC judgments",
  publisher: "National Consumer Disputes Redressal Commission",
  kinds: ["judgment", "order"],
  forum: "ncdrc",
  homepage: "https://e-jagriti.gov.in/",
  fetch: "firecrawl_in",
  cadenceMinutes: 1440,
  attribution: "National Consumer Disputes Redressal Commission (e-jagriti.gov.in).",
  reason: "e-Jagriti refused every automated request (2026-10-02) and no open judgment listing was found.",
  notes: [
    "Disabled: NCDRC judgments are published through e-Jagriti, which refused every automated request on 2026-10-02; ncdrc.nic.in links no judgments.",
    "No open listing or documented API was found; nothing is fetched until one is verified.",
  ],
});

/**
 * CIC (cic.gov.in/decision → dsscic.nic.in/cause-list-report-web/view-decision/1): the decision search (by commissioner,
 * file number, applicant, public authority, decision type or date range) requires a CAPTCHA ("Please type below text in
 * textbox", image /users/image).
 */
export const cic = disabled({
  id: "cic-decisions",
  name: "CIC decisions",
  publisher: "Central Information Commission",
  kinds: ["order"],
  forum: "cic",
  homepage: "https://cic.gov.in/decision",
  fetch: "firecrawl_in",
  cadenceMinutes: 1440,
  attribution: "Central Information Commission (cic.gov.in).",
  reason: "the decision search requires a CAPTCHA.",
  notes: [
    "Disabled: the CIC decision search (dsscic.nic.in view-decision, including the 2016–2026 archive) requires a CAPTCHA (checked 2026-10-02); CAPTCHAs are never bypassed.",
    "Decisions also carry applicants' names; any future source must keep the personal-data scrub.",
  ],
});
