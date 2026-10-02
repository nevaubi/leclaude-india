import "server-only";
import type { AdapterContext, SourceAdapter } from "../../adapter";
import type { DiscoveredDoc, SourceDef } from "../../types";
import { GOV_TERMS, clean, printedDate, walkStreams, type ListingPage, type ListingStream, type StreamSpec } from "./common";

/**
 * CBIC tax information portal (taxinformation.cbic.gov.in), JHipster JSON API, anonymous GET. Verified 2026-10-02:
 *   GET /api/cbic-tax-msts                                               → taxes (GST 1000001, Customs 1000002, ...)
 *   GET /api/cbic-notification-msts/fetchUpdatesByTaxId/{taxId}          → a handful of latest updates (both kinds)
 *   GET /api/cbic-notification-msts/fetchNotificationByCategory/{taxId}/{category}   → full category list (unpaged)
 *   GET /api/cbic-circular-msts/fetchCategoryRelatedCirculars/{taxId}/{category}     → GST circulars by category
 *   GET /api/cbic-circular-msts/fetchAllCircularsByTaxId/{taxId}         → circulars of taxes without categories
 *   GET /content/pdf/{docFilePath with "/"}                              → JSON {data: <base64 PDF>, fileName}
 * The category-list endpoints (fetchCategory, fetchCircularCategory) answer HTTP 500, so categories are the verified
 * seed below plus every category named in the update feeds.
 *
 * File bytes: `fileUrl` is the /content/pdf URL and `meta.base64Json = true`. The fetch stage must decode the JSON with
 * `decodeCbicPdf` and hash / extract the DECODED PDF bytes (never the JSON).
 */

const BASE = "https://taxinformation.cbic.gov.in";

export interface CbicTax { id: number; name: string }
/** Taxes as returned by /api/cbic-tax-msts on 2026-10-02 (used when the endpoint is unavailable). */
export const CBIC_TAXES: CbicTax[] = [
  { id: 1000001, name: "GST" },
  { id: 1000002, name: "Customs" },
  { id: 1000003, name: "Central Excise" },
  { id: 1000004, name: "Service Tax" },
  { id: 100005, name: "HSNS Cess" },
];

/** Categories confirmed to return records (2026-10-02). Circulars of taxes not listed under `circulars` use fetchAll. */
export const CBIC_SEED: Record<number, { notifications: string[]; circulars: string[] | "all" }> = {
  1000001: { notifications: ["Central Tax", "Central Tax (Rate)", "Integrated Tax"], circulars: ["Circulars CGST"] },
  1000002: { notifications: ["Tariff", "Non Tariff", "Anti Dumping Duty"], circulars: "all" },
  1000003: { notifications: [], circulars: "all" },
  1000004: { notifications: [], circulars: "all" },
  100005: { notifications: [], circulars: "all" },
};

interface CbicUpdate {
  id?: number;
  updateType?: string | null;
  updateCategory?: string | null;
}

export interface CbicRecord {
  id?: number;
  notificationNo?: string | null;
  notificationName?: string | null;
  notificationCategory?: string | null;
  notificationDt?: string | null;
  circularNo?: string | null;
  circularName?: string | null;
  circularCategory?: string | null;
  circularDt?: string | null;
  issueDt?: string | null;
  docFilePath?: string | null;
  docFilePathHi?: string | null;
  isAmended?: string | null;
  isOmitted?: string | null;
  ntRemarks?: string | null;
  cirRemarks?: string | null;
  isActive?: string | null;
}

/** "tax_repository\gst\circulars\X.pdf" → https://taxinformation.cbic.gov.in/content/pdf/tax_repository/gst/circulars/X.pdf. */
export function cbicContentUrl(docFilePath: string | null | undefined): string | null {
  if (!docFilePath) return null;
  const parts = docFilePath.trim().split(/[\\/]+/).filter(Boolean);
  if (!parts.length || parts.some((p) => p === ".." || p === "." || /[\0<>"]/.test(p))) return null;
  if (!/\.pdf$/i.test(parts[parts.length - 1])) return null;
  return `${BASE}/content/pdf/${parts.map(encodeURIComponent).join("/")}`;
}

export function cbicViewerUrl(id: number, kind: "Notifications" | "Circulars"): string {
  return `${BASE}/view-pdf/${id}/ENG/${kind}`;
}

/**
 * Decode a /content/pdf answer ({data: base64, fileName}) into the PDF bytes. Accepts the parsed JSON, its text, or the
 * raw response bytes. Throws when the answer is not a base64 PDF (never returns the JSON bytes as the document).
 */
export function decodeCbicPdf(answer: unknown): { bytes: Uint8Array; fileName: string | null } {
  let obj: unknown = answer;
  if (answer instanceof Uint8Array) obj = new TextDecoder().decode(answer);
  if (typeof obj === "string") {
    try {
      obj = JSON.parse(obj);
    } catch {
      throw new Error("CBIC content answer is not JSON");
    }
  }
  const o = obj as { data?: unknown; fileName?: unknown } | null;
  if (!o || typeof o.data !== "string" || !o.data) throw new Error("CBIC content answer has no base64 data");
  const b64 = o.data.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) throw new Error("CBIC content data is not base64");
  const bytes = new Uint8Array(Buffer.from(b64, "base64"));
  if (bytes.length < 5 || new TextDecoder("latin1").decode(bytes.slice(0, 5)) !== "%PDF-") throw new Error("CBIC content data is not a PDF");
  return { bytes, fileName: typeof o.fileName === "string" ? o.fileName : null };
}

const yes = (v: string | null | undefined) => (v ?? "").trim().toUpperCase() === "Y";

/** Category list records → items, newest first (records without an English PDF path are skipped). */
export function cbicItems(records: CbicRecord[], tax: CbicTax, kind: "notification" | "circular"): DiscoveredDoc[] {
  const out: DiscoveredDoc[] = [];
  for (const r of records) {
    if (typeof r.id !== "number" || (r.isActive != null && r.isActive !== "Y")) continue;
    const fileUrl = cbicContentUrl(r.docFilePath);
    if (!fileUrl) continue;
    const isN = kind === "notification";
    const number = clean(isN ? r.notificationNo : r.circularNo) || null;
    const name = clean(isN ? r.notificationName : r.circularName) || null;
    const date = printedDate(isN ? r.notificationDt : r.circularDt) ?? printedDate(r.issueDt);
    const category = clean(isN ? r.notificationCategory : r.circularCategory) || null;
    const label = isN ? "Notification" : "Circular";
    out.push({
      sourceId: "cbic",
      kind,
      url: cbicViewerUrl(r.id, isN ? "Notifications" : "Circulars"),
      fileUrl,
      title: [number ? `${tax.name} ${label} No. ${number}` : `${tax.name} ${label}`, name].filter(Boolean).join(": "),
      docDate: date,
      mime: "application/pdf",
      meta: {
        forum: "cbic",
        cbicId: r.id,
        tax: tax.name,
        taxId: tax.id,
        category,
        number,
        date,
        amended: yes(r.isAmended),
        omitted: yes(r.isOmitted),
        remarks: clean(isN ? r.ntRemarks : r.cirRemarks) || null,
        fileUrlHindi: cbicContentUrl(r.docFilePathHi),
        base64Json: true,
        contentEncoding: "cbic-base64-json",
      },
    });
  }
  return out.sort((a, b) => (b.docDate ?? "").localeCompare(a.docDate ?? "") || Number(b.meta?.cbicId) - Number(a.meta?.cbicId));
}

/** Stream id → (kind, tax, category|"*"). */
export function cbicStreamId(kind: "n" | "c", taxId: number, category: string): string {
  return `${kind}|${taxId}|${category}`;
}

function parseStreamId(id: string): { kind: "notification" | "circular"; tax: CbicTax; category: string } | null {
  const m = /^([nc])\|(\d+)\|(.{1,120})$/.exec(id);
  if (!m) return null;
  const taxId = Number(m[2]);
  const tax = CBIC_TAXES.find((t) => t.id === taxId) ?? { id: taxId, name: `Tax ${taxId}` };
  return { kind: m[1] === "n" ? "notification" : "circular", tax, category: m[3] };
}

function streamFor(id: string): StreamSpec | null {
  const p = parseStreamId(id);
  if (!p) return null;
  const s: ListingStream = {
    kind: "listing",
    id,
    backfill: true,
    firstPage: 1,
    incrementalPages: 1,
    async fetch(_page: number, ctx: AdapterContext): Promise<ListingPage> {
      const cat = encodeURIComponent(p.category);
      const url = p.kind === "notification"
        ? `${BASE}/api/cbic-notification-msts/fetchNotificationByCategory/${p.tax.id}/${cat}`
        : p.category === "*"
          ? `${BASE}/api/cbic-circular-msts/fetchAllCircularsByTaxId/${p.tax.id}`
          : `${BASE}/api/cbic-circular-msts/fetchCategoryRelatedCirculars/${p.tax.id}/${cat}`;
      const records = await ctx.fetchJson<CbicRecord[]>(url);
      if (!Array.isArray(records)) return { items: [], last: true, notes: ["answer was not a list"] };
      return { items: cbicItems(records, p.tax, p.kind), last: true };
    },
  };
  return s;
}

/** Streams of a pass: seed categories plus categories named in the update feeds of every tax. */
export async function cbicPlan(ctx: AdapterContext): Promise<{ ids: string[]; notes: string[] }> {
  const notes: string[] = [];
  let taxes = CBIC_TAXES;
  try {
    const t = await ctx.fetchJson<{ id?: number; taxName?: string; isActive?: string }[]>(`${BASE}/api/cbic-tax-msts`);
    const live = Array.isArray(t) ? t.filter((x) => typeof x.id === "number" && x.isActive !== "N").map((x) => ({ id: x.id as number, name: clean(x.taxName) || `Tax ${x.id}` })) : [];
    if (live.length) taxes = live;
  } catch (e) {
    notes.push(`tax list unavailable (${e instanceof Error ? e.message : String(e)}); using the known taxes.`);
  }
  const ids = new Set<string>();
  for (const tax of taxes) {
    const seed = CBIC_SEED[tax.id] ?? { notifications: [], circulars: "all" as const };
    for (const c of seed.notifications) ids.add(cbicStreamId("n", tax.id, c));
    if (seed.circulars === "all") ids.add(cbicStreamId("c", tax.id, "*"));
    else for (const c of seed.circulars) ids.add(cbicStreamId("c", tax.id, c));
    try {
      const ups = await ctx.fetchJson<CbicUpdate[]>(`${BASE}/api/cbic-notification-msts/fetchUpdatesByTaxId/${tax.id}`);
      for (const u of Array.isArray(ups) ? ups : []) {
        const cat = clean(u.updateCategory);
        if (!cat || cat.length > 120) continue;
        if (/^notification$/i.test(clean(u.updateType))) ids.add(cbicStreamId("n", tax.id, cat));
        else if (/^circular$/i.test(clean(u.updateType)) && seed.circulars !== "all") ids.add(cbicStreamId("c", tax.id, cat));
      }
    } catch (e) {
      notes.push(`updates for ${tax.name} unavailable (${e instanceof Error ? e.message : String(e)}).`);
    }
  }
  return { ids: [...ids], notes };
}

export const def: SourceDef = {
  id: "cbic",
  name: "CBIC notifications and circulars",
  publisher: "Central Board of Indirect Taxes and Customs",
  kinds: ["notification", "circular"],
  forum: "cbic",
  homepage: "https://taxinformation.cbic.gov.in/",
  fetch: "direct",
  cadenceMinutes: 720,
  attribution: "Notifications and circulars as published by the Central Board of Indirect Taxes and Customs (taxinformation.cbic.gov.in).",
  terms: GOV_TERMS,
  enabled: true,
  notes: [
    "PDFs come from the portal's /content/pdf endpoint as base64 JSON; the stored hash is of the decoded PDF bytes.",
    "Categories: a verified seed plus every category named in the portal's update feeds (the category-list endpoints answer HTTP 500).",
  ],
};

export const adapter: SourceAdapter = {
  def,
  discover(ctx) {
    const planNotes: string[] = [];
    return walkStreams(ctx, {
      async plan(c, _mode, only) {
        const p = await cbicPlan(c);
        planNotes.push(...p.notes);
        return only ? p.ids.filter((id) => only.includes(id)) : p.ids;
      },
      stream: streamFor,
    }).then((r) => (planNotes.length ? { ...r, notes: [...planNotes, ...(r.notes ?? [])] } : r));
  },
};
