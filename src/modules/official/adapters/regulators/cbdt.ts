import "server-only";
import type { AdapterContext, SourceAdapter } from "../../adapter";
import type { DiscoveredDoc, SourceDef } from "../../types";
import { GOV_TERMS, attr, clean, decodeHtml, htmlText, printedDate, safeUrl, walkStreams, type ListingPage, type ListingStream } from "./common";

/**
 * Income-tax circulars and notifications (incometaxindia.gov.in, Liferay DXP). Verified 2026-10-02:
 * - /circulars and /notifications render their list client-side (<etds-circular-notification>); the data endpoints
 *   (headless delivery / search) answer 403 without a browser session, so only the first 10 rendered cards are
 *   readable: fetched through Firecrawl with a 4 s wait. No backfill is possible without a session (not attempted).
 * - Cards are <button role="link" title="Circular No. 7/2026 : …"> with "Published On: September 28th, 2026"; they carry
 *   no href to the circular PDF. A PDF link is used only when a card actually carries one (/documents/d/guest/…);
 *   slugs are never guessed. Without a link the document is a metadata record: the card's title and date as `text`,
 *   identified by the listing URL plus a fragment (meta.pdfLinkFound = false).
 * - One combined list covers the Income-tax Act, 1961 and the Income-tax Act, 2025; the Act is recorded from the title
 *   only when the title names it.
 */

const BASE = "https://www.incometaxindia.gov.in";
const HOSTS = ["incometaxindia.gov.in"];
export const CBDT_LISTINGS = [
  { id: "circulars", url: `${BASE}/circulars`, kind: "circular" as const, label: "Circular" },
  { id: "notifications", url: `${BASE}/notifications`, kind: "notification" as const, label: "Notification" },
];

export interface CbdtCard {
  title: string;
  published: string | null;
  tags: string[];
  href: string | null;
}

/** Rendered cards of the list view. */
export function parseCbdtCards(html: string, pageUrl: string): CbdtCard[] {
  const start = html.search(/id="listViewContent"/i);
  if (start < 0) return [];
  const body = html.slice(start);
  const cards: CbdtCard[] = [];
  const parts = body.split(/<div class="card border-0[^"]*"[^>]*>/i).slice(1);
  for (const part of parts) {
    const btn = /<button[^>]*class="[^"]*card-title[^"]*"[^>]*>/i.exec(part)?.[0];
    const title = clean(btn ? attr(btn, "title") : htmlText(/<span[^>]*fw-bold[^>]*>([\s\S]*?)<\/span>/i.exec(part)?.[1] ?? ""));
    if (!title) continue;
    const published = printedDate(htmlText(/Published On:\s*<\/span>\s*<span>([\s\S]*?)<\/span>/i.exec(part)?.[1] ?? ""));
    const tagsHtml = /<div class="tags">([\s\S]*?)<\/div>\s*<div class="card-last-section">/i.exec(part)?.[1] ?? "";
    const tags = [...tagsHtml.matchAll(/<span[^>]*>([\s\S]*?)<\/span>/gi)].map((m) => clean(htmlText(m[1]))).filter((t) => t && !/^new!?$/i.test(t));
    const link = [...part.matchAll(/<a\b[^>]*>/gi)].map((m) => safeUrl(attr(m[0], "href"), pageUrl, HOSTS)).find((u) => !!u && /\/documents\/d\//.test(u)) ?? null;
    cards.push({ title: decodeHtml(title), published, tags, href: link });
  }
  return cards;
}

/** "Circular No. 7/2026", "Circular No.15/2025", "Notification No.  130/2026-CBDT" → "7/2026" etc. */
export function cbdtNumber(title: string): string | null {
  const m = /^(?:Circular|Notification)\s*No\.?\s*(\d{1,4})\s*\/\s*((?:19|20)\d{2})/i.exec(clean(title));
  return m ? `${Number(m[1])}/${m[2]}` : null;
}

/** "SO 5368(E)" / "S.O. 5368(E)" printed in a notification title. */
export function cbdtSoNumber(title: string): string | null {
  const m = /\bS\.?\s?O\.?\s*(\d{1,6})\s*\(E\)/i.exec(title);
  return m ? `S.O. ${m[1]}(E)` : null;
}

/** Which Income-tax Act the title names (1961 or 2025); null when it names neither or both. */
export function cbdtAct(title: string): "1961" | "2025" | null {
  const acts = new Set([...title.matchAll(/Income[\s-]?tax Act,?\s*((?:1961|2025))/gi)].map((m) => m[1] as "1961" | "2025"));
  return acts.size === 1 ? [...acts][0] : null;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
}

export function cbdtDocs(cards: CbdtCard[], listing: (typeof CBDT_LISTINGS)[number]): DiscoveredDoc[] {
  return cards.map((c) => {
    const number = cbdtNumber(c.title);
    const fragment = slug(number ? `${listing.label} ${number}` : c.title);
    const url = c.href ?? `${listing.url}#${fragment}`;
    return {
      sourceId: "cbdt",
      kind: listing.kind,
      url,
      fileUrl: c.href,
      title: c.title,
      docDate: c.published,
      mime: c.href ? "application/pdf" : "text/plain",
      text: c.href ? null : `${c.title}\nPublished On: ${c.published ?? "not printed"}\nListed at ${listing.url} (the circular / notification file is not linked from the listing).`,
      meta: {
        forum: "cbdt",
        number,
        soNumber: listing.kind === "notification" ? cbdtSoNumber(c.title) : null,
        act: cbdtAct(c.title),
        published: c.published,
        status: c.tags.length ? c.tags : null,
        listingUrl: listing.url,
        pdfLinkFound: !!c.href,
        urlIsListing: !c.href,
      },
    };
  });
}

function listingStream(listing: (typeof CBDT_LISTINGS)[number]): ListingStream {
  return {
    kind: "listing",
    id: listing.id,
    backfill: false,
    firstPage: 1,
    incrementalPages: 1,
    async fetch(_page: number, ctx: AdapterContext): Promise<ListingPage> {
      const res = await ctx.fetchPage(listing.url, { firecrawl: true, waitForMs: 4000 });
      const cards = parseCbdtCards(res.html ?? "", res.finalUrl || listing.url);
      if (!cards.length) return { items: [], last: true, notes: ["no rendered cards (the list renders client-side; it needs the Firecrawl path with a wait)."] };
      return { items: cbdtDocs(cards, listing), last: true };
    },
  };
}

const STREAMS = new Map(CBDT_LISTINGS.map((l) => [l.id, listingStream(l)] as const));

export const def: SourceDef = {
  id: "cbdt",
  name: "Income-tax circulars and notifications (CBDT)",
  publisher: "Central Board of Direct Taxes, Income Tax Department",
  kinds: ["circular", "notification"],
  forum: "cbdt",
  homepage: `${BASE}/circulars`,
  fetch: "firecrawl_in",
  cadenceMinutes: 1440,
  attribution: "Circulars and notifications as listed by the Income Tax Department (incometaxindia.gov.in).",
  terms: GOV_TERMS,
  enabled: true,
  notes: [
    "Only the 10 newest cards of each list are readable (client-rendered; the data API needs a browser session). Backfill is not possible.",
    "Cards do not link the circular/notification file; such entries are metadata records (title and date) and must be read on the official site.",
    "The Act (1961 or 2025) is recorded only when the title names it.",
  ],
};

export const adapter: SourceAdapter = {
  def,
  discover(ctx) {
    return walkStreams(ctx, {
      async plan(_ctx, mode) {
        return mode === "incremental" ? [...STREAMS.keys()] : [];
      },
      stream: (id) => STREAMS.get(id) ?? null,
      key: (d) => d.url,
    });
  },
};
