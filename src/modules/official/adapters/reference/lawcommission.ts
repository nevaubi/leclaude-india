import "server-only";
import type { AdapterContext, SourceAdapter } from "../../adapter";
import { registerAllowHosts } from "../../registry";
import type { DiscoveredDoc, SourceDef } from "../../types";
import { attr, clean, disabledResult, htmlText, printedDate, rowCells, safeUrl, tableRows, walkStreams, type ListingPage, type ListingStream } from "../regulators/common";

/**
 * Law Commission of India reports (lawcommissionofindia.nic.in): one WordPress page per Commission
 * (/report_first/ … /report_twentysecond/, linked from /law-commission-reports/), each a table
 * "Report No. | Subject | Year of submission | Download pdf" whose PDFs are served from cdnbbsr.s3waas.gov.in
 * (verified 2026-10-02). A report printed in several parts links each part; every part is one document.
 *
 * Terms (verified 2026-10-02): robots.txt disallows only /wp-admin/. The site's Copyright Policy says material "may be
 * reproduced free of charge after taking proper permission by sending a mail", with the source prominently
 * acknowledged. Storing and serving report text is reproduction, so the adapter is registered DISABLED until that
 * permission is on record; enable it (def.enabled) only then. Reports are reference material (context), not law.
 */

const BASE = "https://lawcommissionofindia.nic.in";
const HOSTS = ["lawcommissionofindia.nic.in", "cdnbbsr.s3waas.gov.in", "s3waas.gov.in"];
registerAllowHosts("lawcommission", HOSTS);

/** Commission pages, newest first (slugs as linked from /law-commission-reports/; never synthesised beyond these). */
export const COMMISSION_PAGES: { commission: number; slug: string }[] = [
  "twentysecond", "twentyfirst", "twentieth", "nineteenth", "eighteenth", "seventeenth", "sixteenth", "fifteenth", "fourteenth", "thirteenth", "twelfth",
  "eleventh", "tenth", "ninth", "eighth", "seventh", "sixth", "fifth", "fourth", "third", "second", "first",
].map((s, i) => ({ commission: 22 - i, slug: `report_${s}` }));

export const pageUrl = (slug: string) => `${BASE}/${slug}/`;

/** Report rows of one Commission page: one document per linked PDF (parts numbered when there are several). */
export function parseLawCommissionReports(html: string, commission: number, url: string): { items: DiscoveredDoc[]; unparsed: number } {
  const items: DiscoveredDoc[] = [];
  let unparsed = 0;
  for (const row of tableRows(html)) {
    const cells = rowCells(row);
    if (!cells.length) continue; // header row (<th>)
    if (cells.length < 4) { unparsed++; continue; }
    const numberText = clean(htmlText(cells[0]));
    const reportNo = /^\d{1,4}$/.test(numberText) ? Number(numberText) : null;
    const subject = clean(htmlText(cells[1]));
    const printed = clean(htmlText(cells[2]).replace(/(\d)\s+(st|nd|rd|th)\b/gi, "$1$2"));
    const date = printedDate(printed);
    const links = (cells[3].match(/<a\b[^>]*>[\s\S]*?<\/a>/gi) ?? [])
      .map((a) => ({ href: safeUrl(attr(a, "href"), url, HOSTS), label: clean(htmlText(a)) }))
      .filter((l): l is { href: string; label: string } => Boolean(l.href && /\.pdf(?:$|\?)/i.test(l.href)));
    if (!subject || !links.length) { unparsed++; continue; }
    links.forEach((l, k) => {
      const part = links.length > 1 ? k + 1 : null;
      items.push({
        sourceId: "lawcommission",
        kind: "reference_report",
        url: l.href,
        fileUrl: l.href,
        title: `Law Commission of India, Report No. ${reportNo ?? numberText}: ${subject}${part ? ` (Part ${part})` : ""}`,
        docDate: date,
        mime: "application/pdf",
        meta: { forum: "lawcommission", commission, reportNo, reportNoPrinted: numberText || null, subject, datePrinted: printed || null, part, partLabel: part ? l.label || null : null, listedOn: url },
      });
    });
  }
  return { items, unparsed };
}

const reports: ListingStream = {
  kind: "listing",
  id: "reports",
  backfill: true,
  firstPage: 1,
  // An incremental pass reads the current Commission's page only; a backfill walks all 22 pages, newest first.
  incrementalPages: 1,
  markerless: true,
  async fetch(page: number, ctx: AdapterContext): Promise<ListingPage> {
    const p = COMMISSION_PAGES[page - 1];
    if (!p) return { items: [], last: true };
    const res = await ctx.fetchPage(pageUrl(p.slug));
    const { items, unparsed } = parseLawCommissionReports(res.html ?? "", p.commission, res.finalUrl || pageUrl(p.slug));
    const notes = [...(items.length ? [] : [`no report rows could be read from ${p.slug}`]), ...(unparsed ? [`${unparsed} row(s) on ${p.slug} could not be read`] : [])];
    return { items, last: page >= COMMISSION_PAGES.length, notes: notes.length ? notes : undefined };
  },
};

export const def: SourceDef = {
  id: "lawcommission",
  name: "Law Commission of India reports",
  publisher: "Law Commission of India (Department of Legal Affairs)",
  kinds: ["reference_report"],
  forum: "lawcommission",
  homepage: `${BASE}/law-commission-reports/`,
  fetch: "firecrawl_in",
  cadenceMinutes: 10080,
  attribution: "Source: Law Commission of India (lawcommissionofindia.nic.in). Reports are recommendations, not law.",
  terms: "Website copyright policy: reproduction free of charge after permission by e-mail, with the source acknowledged (verified 2026-10-02). robots.txt disallows /wp-admin/ only.",
  enabled: false,
  notes: [
    "Disabled until the Commission's permission to reproduce report text is on record (its copyright policy requires a request by e-mail).",
    "Reports are context for interpreting the law, not law; they are kept out of statute results.",
  ],
};

export const adapter: SourceAdapter = {
  def,
  discover(ctx) {
    if (!def.enabled) return Promise.resolve(disabledResult(def.notes![0]));
    return walkStreams(ctx, { plan: async () => ["reports"], stream: (id) => (id === "reports" ? reports : null) });
  },
};
