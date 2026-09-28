import "server-only";
import type { StateCode } from "@/lib/india/courts";
import { ProviderError } from "@/modules/intel/providers/base";
import { SourceHttp, type SourceHttpOptions } from "./http";
import { clean, htmlParagraphs, isoDate } from "./parse-util";
import type { StoredEnactment, StoredEnactmentSection } from "./types";

/**
 * India Code (https://indiacode.gov.in, formerly indiacode.nic.in) — central and state Acts.
 *
 * India Code runs DSpace 9 and exposes the standard DSpace REST API (verified September 2026):
 *   GET /server/api/pid/find?id=123456789/<n>                     → the Act item (metadata below)
 *   GET /server/api/discover/search/objects?query=…&f.identifier_collection=ACT,equals&sort=dc.date.issued,DESC&page=&size=
 *   GET /server/api/discover/search/objects?query="<act_id>"&f.identifier_collection=SECTION,equals&page=&size=
 *       (sections are re-sorted client-side by dc.identifier.order_number)
 * Act metadata: dc.title, dc.title.long_title, dc.title.regional, dc.identifier.act_id, dc.identifier.act_number,
 * dc.date.act_year, dc.date.enact_date (YYYY-MM-DD), dc.date.enforcement_date (D-M-YYYY), dc.identifier.state_name
 * ("CENTRAL", "Karnataka", …), dc.identifier.ministry_name, dc.identifier.department_name, dc.identifier.repealed.
 * Section items share the act_id and carry dc.identifier.section_number, dc.identifier.order_number, dc.title (the
 * marginal heading) and dc.identifier.section_page_note (the section text as HTML).
 * The JSON API is read-only public data; no HTML scraping, no login, no captcha.
 */
export const INDIA_CODE_BASE = "https://indiacode.gov.in";

type Md = Record<string, { value: string | null }[] | undefined>;

export interface DspaceItem {
  id: string;
  uuid?: string;
  name?: string;
  handle?: string;
  metadata: Md;
  lastModified?: string;
  withdrawn?: boolean;
}

export interface DspaceSearchPage {
  items: DspaceItem[];
  page: { number: number; size: number; totalPages: number; totalElements: number };
}

/** India Code state names → registry state codes. Only the names listed resolve; others stay unresolved. */
export const INDIA_CODE_STATES: Record<string, StateCode> = { karnataka: "KA", telangana: "TS", "andhra pradesh": "AP", "tamil nadu": "TN", maharashtra: "MH", kerala: "KL", delhi: "DL" };
export const INDIA_CODE_STATE_NAMES: Partial<Record<StateCode, string>> = { KA: "Karnataka", TS: "Telangana", AP: "Andhra Pradesh", TN: "Tamil Nadu", MH: "Maharashtra", KL: "Kerala", DL: "Delhi" };

export function mdValue(md: Md, field: string): string | undefined {
  return clean(md[field]?.[0]?.value ?? undefined);
}

export function parseSearchPage(json: unknown): DspaceSearchPage {
  const root = json as { _embedded?: { searchResult?: { _embedded?: { objects?: { _embedded?: { indexableObject?: DspaceItem } }[] }; page?: DspaceSearchPage["page"] } } };
  const sr = root?._embedded?.searchResult;
  if (!sr) throw new ProviderError("india-code", "parse", "india-code: search response has no searchResult (schema drift?)", false);
  const items = (sr._embedded?.objects ?? []).map((o) => o._embedded?.indexableObject).filter((x): x is DspaceItem => Boolean(x && x.metadata));
  return { items, page: sr.page ?? { number: 0, size: items.length, totalPages: 1, totalElements: items.length } };
}

export type EnactmentDraft = Omit<StoredEnactment, "id" | "updatedAt" | "sections" | "retrievedAt"> & { externalId: string };

/** DSpace Act item → enactment contract. Fails (throws) when the item is not an ACT. */
export function parseActItem(item: DspaceItem, base = INDIA_CODE_BASE): EnactmentDraft {
  const md = item.metadata;
  const collection = mdValue(md, "dc.identifier.collection");
  if (collection && collection !== "ACT") throw new ProviderError("india-code", "parse", `india-code: item ${item.handle ?? item.id} is a ${collection}, not an ACT`, false);
  const title = mdValue(md, "dc.title") ?? item.name ?? "Untitled Act";
  const stateName = mdValue(md, "dc.identifier.state_name") ?? "";
  const central = /^central$/i.test(stateName);
  const state = central ? undefined : INDIA_CODE_STATES[stateName.toLowerCase()];
  const yearRaw = mdValue(md, "dc.date.act_year") ?? /(\d{4})\s*$/.exec(title)?.[1];
  const actId = mdValue(md, "dc.identifier.act_id");
  return {
    externalId: actId ?? item.handle ?? item.id,
    source: "india-code",
    title,
    shortTitle: title.replace(/^the\s+/i, ""),
    actNumber: mdValue(md, "dc.identifier.act_number"),
    year: yearRaw ? Number(yearRaw) : 0,
    jurisdiction: central ? "central" : "state",
    state: state ?? (central ? undefined : stateName ? `unresolved:${stateName}` : undefined),
    enactedOn: isoDate(mdValue(md, "dc.date.enact_date")),
    inForceFrom: isoDate(mdValue(md, "dc.date.enforcement_date")),
    language: "en",
    url: item.handle ? `${base}/handle/${item.handle}` : undefined,
    actId,
    handle: item.handle,
    uuid: item.uuid ?? item.id,
    longTitle: mdValue(md, "dc.title.long_title"),
    regionalTitle: mdValue(md, "dc.title.regional"),
    ministry: mdValue(md, "dc.identifier.ministry_name"),
    department: mdValue(md, "dc.identifier.department_name"),
    repealed: mdValue(md, "dc.identifier.repealed") === "true",
    lastModified: item.lastModified,
  };
}

export type SectionDraft = Omit<StoredEnactmentSection, "id" | "enactmentId" | "updatedAt">;

export function parseSectionItem(item: DspaceItem, base = INDIA_CODE_BASE): SectionDraft | null {
  const md = item.metadata;
  if (mdValue(md, "dc.identifier.collection") !== "SECTION") return null;
  const number = mdValue(md, "dc.identifier.section_number");
  if (!number) return null;
  const order = Number(mdValue(md, "dc.identifier.order_number"));
  return {
    number,
    heading: mdValue(md, "dc.title") ?? item.name,
    text: htmlParagraphs(md["dc.identifier.section_page_note"]?.[0]?.value ?? ""),
    sectionId: mdValue(md, "dc.identifier.section_id"),
    order: Number.isFinite(order) ? order : undefined,
    handle: item.handle,
    url: item.handle ? `${base}/handle/${item.handle}` : undefined,
  };
}

/** Full text of an Act assembled from its sections, one "Section N. Heading" block per section (statutory order). */
export function actText(e: Pick<StoredEnactment, "title" | "longTitle" | "actNumber" | "year">, sections: SectionDraft[]): string {
  const head = [e.title, e.actNumber ? `Act No. ${e.actNumber} of ${e.year}` : undefined, e.longTitle].filter(Boolean).join("\n");
  const body = [...sections].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map((s) => `Section ${s.number}. ${s.heading ?? ""}\n${s.text}`.trim());
  return [head, ...body].join("\n\n");
}

export interface IndiaCodeClient {
  http: SourceHttp;
  searchActs(q: { query: string; page?: number; size?: number; signal?: AbortSignal }): Promise<DspaceSearchPage>;
  getByHandle(handle: string, signal?: AbortSignal): Promise<DspaceItem>;
  sections(actId: string, o?: { page?: number; size?: number; signal?: AbortSignal }): Promise<DspaceSearchPage>;
  /** Query string for Acts of a jurisdiction ("central" or a state code). */
  jurisdictionQuery(j: "central" | StateCode): string;
}

export function createIndiaCode(o: Omit<SourceHttpOptions, "name" | "egress"> & { baseUrl?: string } = {}): IndiaCodeClient {
  const base = o.baseUrl ?? INDIA_CODE_BASE;
  const http = new SourceHttp({ name: "india-code", egress: { name: "india-code", allowHosts: ["indiacode.gov.in", "indiacode.nic.in"], allowedSchemes: ["https:"] }, rps: o.rps ?? 2, burst: o.burst ?? 4, retries: o.retries ?? 2, ...o });
  const search = async (params: URLSearchParams, signal?: AbortSignal) => parseSearchPage(await http.json(`${base}/server/api/discover/search/objects?${params.toString()}`, { signal, maxBytes: 16 * 1024 * 1024 }));
  return {
    http,
    jurisdictionQuery: (j) => (j === "central" ? "dc.identifier.state_name:CENTRAL" : `dc.identifier.state_name:"${INDIA_CODE_STATE_NAMES[j] ?? j}"`),
    searchActs(q) {
      const p = new URLSearchParams({ query: q.query, "f.identifier_collection": "ACT,equals", sort: "dc.date.issued,DESC", page: String(q.page ?? 0), size: String(Math.min(100, q.size ?? 20)) });
      return search(p, q.signal);
    },
    async getByHandle(handle, signal) {
      if (!/^\d+\/\d+$/.test(handle)) throw new ProviderError("india-code", "parse", `india-code: "${handle}" is not a DSpace handle`, false);
      return http.json<DspaceItem>(`${base}/server/api/pid/find?${new URLSearchParams({ id: handle }).toString()}`, { signal });
    },
    sections(actId, so = {}) {
      const p = new URLSearchParams({ query: `"${actId}"`, "f.identifier_collection": "SECTION,equals", page: String(so.page ?? 0), size: String(Math.min(100, so.size ?? 100)) });
      return search(p, so.signal);
    },
  };
}
