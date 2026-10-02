import "server-only";
import type { AdapterContext, SourceAdapter } from "../../adapter";
import type { DiscoveredDoc, SourceDef } from "../../types";
import { backfillCursor, clean, disabledResult, overrideCtx, parseCursor, printedDate, walkStreams, type ListingPage, type ListingStream } from "./common";

/**
 * MCA company master data on the Open Government Data Platform (api.data.gov.in), GODL-India.
 *
 * DISABLED unless DATA_GOV_IN_API_KEY and DATA_GOV_IN_MCA_RESOURCE (the resource's index name / UUID) are set: the
 * resource UUID could not be obtained and api.data.gov.in refused connections from the research environment
 * (2026-10-02), so the request shape follows data.gov.in's documented API and is unverified against this resource:
 *   GET https://api.data.gov.in/resource/{resource}?api-key=…&format=json&offset=N&limit=M[&filters[CompanyStateCode]=X]
 * Optional DATA_GOV_IN_MCA_STATES = comma-separated CompanyStateCode values (one stream each; none = unfiltered).
 * Optional DATA_GOV_IN_MCA_MAX_PAGES = pages (of 100 records) per discover call (default 20) so millions of rows are
 * never bulk-loaded in one run; the dataset has no recency order, so every pass is a full walk that resumes from its
 * cursor across runs (monthly cadence) and the pipeline's URL + text-hash identity skips unchanged records.
 *
 * Each company becomes a dataset_push document whose `text` is a compact markdown record (no fetch). E-mail addresses
 * are dropped. The API key is never put in a document URL or in metadata.
 */

const API = "https://api.data.gov.in/resource";
const PAGE = 100;

export function mcaConfig(env: Record<string, string | undefined> = process.env): { key: string; resource: string; states: string[]; maxPages: number } | null {
  const key = clean(env.DATA_GOV_IN_API_KEY);
  const resource = clean(env.DATA_GOV_IN_MCA_RESOURCE);
  if (!key || !resource || !/^[A-Za-z0-9_-]{4,80}$/.test(resource)) return null;
  const states = clean(env.DATA_GOV_IN_MCA_STATES).split(",").map((s) => s.trim()).filter((s) => /^[A-Za-z0-9 &.-]{1,40}$/.test(s));
  const maxPages = Math.min(Math.max(Number(env.DATA_GOV_IN_MCA_MAX_PAGES) || 20, 1), 500);
  return { key, resource, states, maxPages };
}

export function mcaApiUrl(cfg: { key: string; resource: string }, offset: number, state: string | null): string {
  const p = new URLSearchParams({ "api-key": cfg.key, format: "json", offset: String(offset), limit: String(PAGE) });
  if (state) p.set("filters[CompanyStateCode]", state);
  return `${API}/${encodeURIComponent(cfg.resource)}?${p.toString()}`;
}

/** Case-insensitive field read (data.gov.in returns lower-case keys; MCA's own files use upper case). */
function field(r: Record<string, unknown>, ...names: string[]): string | null {
  for (const n of names) {
    for (const k of Object.keys(r)) {
      if (k.toLowerCase() === n.toLowerCase()) {
        const v = clean(String(r[k] ?? ""));
        if (v && !/^(NA|N\/A|null|-)$/i.test(v)) return v;
      }
    }
  }
  return null;
}

const CIN_RE = /^[LU]\d{5}[A-Z]{2}\d{4}[A-Z]{3}\d{6}$|^[A-Z]{3}-\d{4}$|^F\d{5}$/;

/** One company record → a dataset document (null when the record carries no valid CIN / LLPIN). */
export function mcaRecordDoc(r: Record<string, unknown>, resource: string): DiscoveredDoc | null {
  const cin = field(r, "corporate_identification_number", "cin", "llpin");
  if (!cin || !CIN_RE.test(cin.toUpperCase())) return null;
  const name = field(r, "company_name", "llp_name") ?? cin;
  const rows: [string, string | null][] = [
    ["CIN", cin.toUpperCase()],
    ["Status", field(r, "company_status")],
    ["Class", field(r, "company_class")],
    ["Category", field(r, "company_category")],
    ["Sub-category", field(r, "company_sub_category", "company_subcategory")],
    ["Date of registration", field(r, "date_of_registration")],
    ["Registered state", field(r, "registered_state", "companystatecode", "company_state_code")],
    ["Registrar of Companies", field(r, "registrar_of_companies")],
    ["Authorised capital (Rs)", field(r, "authorized_cap", "authorised_capital")],
    ["Paid-up capital (Rs)", field(r, "paidup_capital", "paid_up_capital")],
    ["Industrial class", field(r, "industrial_class")],
    ["Principal business activity", field(r, "principal_business_activity_as_per_cin", "principal_business_activity")],
    ["Registered office address", field(r, "registered_office_address")],
    ["Latest annual return", field(r, "latest_year_annual_return")],
    ["Latest financial statement", field(r, "latest_year_financial_statement")],
  ];
  const present = rows.filter(([, v]) => v != null) as [string, string][];
  const text = [`# ${name}`, "", ...present.map(([k, v]) => `- ${k}: ${v}`), "", "Source: MCA company master data on data.gov.in (GODL-India)."].join("\n");
  return {
    sourceId: "mca-master",
    kind: "company_record",
    url: `https://www.data.gov.in/resource/${encodeURIComponent(resource)}#cin=${encodeURIComponent(cin.toUpperCase())}`,
    fileUrl: null,
    title: `${name} (${cin.toUpperCase()})`,
    docDate: printedDate(field(r, "date_of_registration")),
    mime: "text/markdown",
    text,
    meta: Object.fromEntries([["forum", "mca"], ["cin", cin.toUpperCase()], ["companyName", name], ...present.filter(([k]) => k !== "CIN").map(([k, v]) => [k.replace(/[^A-Za-z]+(.)?/g, (_, ch: string | undefined) => (ch ? ch.toUpperCase() : "")).replace(/^./, (x) => x.toLowerCase()), v])]),
  };
}

interface DataGovAnswer {
  records?: Record<string, unknown>[];
  total?: number | string;
  count?: number | string;
  status?: string;
  message?: string;
}

function stateStream(state: string | null, cfg: NonNullable<ReturnType<typeof mcaConfig>>): ListingStream {
  return {
    kind: "listing",
    id: state ? `state:${state}` : "all",
    backfill: true,
    firstPage: 0,
    incrementalPages: 1,
    async fetch(page: number, ctx: AdapterContext): Promise<ListingPage> {
      const ans = await ctx.fetchJson<DataGovAnswer>(mcaApiUrl(cfg, page * PAGE, state));
      if (!ans || !Array.isArray(ans.records)) return { items: [], last: true, notes: [`answer had no records (${clean(ans?.message) || "unexpected shape"})`] };
      const items = ans.records.map((r) => mcaRecordDoc(r, cfg.resource)).filter((d): d is DiscoveredDoc => !!d);
      const total = Number(ans.total);
      const last = ans.records.length < PAGE || (Number.isFinite(total) && (page + 1) * PAGE >= total);
      return { items, last };
    },
  };
}

export const def: SourceDef = {
  id: "mca-master",
  name: "MCA company master data (data.gov.in)",
  publisher: "Ministry of Corporate Affairs (Open Government Data Platform India)",
  kinds: ["company_record"],
  forum: "mca",
  homepage: "https://www.data.gov.in/catalog/company-master-data",
  fetch: "dataset_push",
  cadenceMinutes: 43_200,
  attribution: "Company master data of the Ministry of Corporate Affairs, published on data.gov.in.",
  terms: "Government Open Data License – India (GODL-India)",
  get enabled() {
    return mcaConfig() !== null;
  },
  notes: [
    "Disabled unless DATA_GOV_IN_API_KEY and DATA_GOV_IN_MCA_RESOURCE are set (the resource id and API reachability are unverified).",
    "Pages per run are capped (DATA_GOV_IN_MCA_MAX_PAGES, default 20 × 100 records); a full walk spans many runs.",
    "Records are the registry's master data, not filings; e-mail addresses are dropped.",
  ],
};

export const adapter: SourceAdapter = {
  def,
  discover(ctx) {
    const cfg = mcaConfig();
    if (!cfg) return Promise.resolve(disabledResult("mca-master is disabled: set DATA_GOV_IN_API_KEY and DATA_GOV_IN_MCA_RESOURCE."));
    const streams = new Map((cfg.states.length ? cfg.states : [null]).map((s) => {
      const st = stateStream(s, cfg);
      return [st.id, st] as const;
    }));
    // Always a full walk (mode "backfill"), at most maxPages pages per call; a completed pass restarts next time.
    const parsed = parseCursor(ctx.cursor);
    const cursor = parsed?.mode === "backfill" ? ctx.cursor : backfillCursor();
    return walkStreams(overrideCtx(ctx, { cursor, limit: Math.min(ctx.limit, cfg.maxPages * PAGE) }), {
      async plan(_ctx, _mode, only) {
        const ids = [...streams.keys()];
        return only ? ids.filter((id) => only.includes(id)) : ids;
      },
      stream: (id) => streams.get(id) ?? null,
      key: (d) => d.url,
    });
  },
};
