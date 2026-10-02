import "server-only";
import type { AdapterContext, DiscoverResult, ParseInput, SourceAdapter } from "../../adapter";
import type { CauseListType, DiscoveredDoc, SourceDef } from "../../types";
import { causeListParse, causeListPersist } from "./common";
import { GOV_TERMS, addDays, markRefetch, pageOf } from "./shared";

/**
 * Supreme Court cause lists (https://www.sci.gov.in/cause-list/, "Cause Lists at a Glance").
 *
 * Files: https://api.sci.gov.in/jonew/cl/{date}/{M_J_1|M_J_2|M_C_1|...|F_J_1|M_CC_1}.pdf (daily main = _1,
 * supplementary = _2), advance/{date}/M_J.pdf, wk/{from}_{to}/weekly.pdf. webapi.sci.gov.in serves the same paths and is
 * kept as `meta.mirrorUrl`. The listing page is the source of truth for which files exist; only when it cannot be read
 * are the documented daily file names for the next working days tried (`meta.urlFromPattern`; a 404 there means
 * "not published"). Lists dated today or later are re-read on every pass (`meta.refetch`): the Court replaces a list
 * file in place when it revises it.
 */

export const SCI_CAUSELIST_PAGE = "https://www.sci.gov.in/cause-list/";

const LINK_RE = /https:\/\/(?:api|webapi)\.sci\.gov\.in\/jonew\/cl\/(?:(advance)\/(\d{4}-\d{2}-\d{2})\/M_J|wk\/(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})\/weekly|(\d{4}-\d{2}-\d{2})\/([MF]_(?:J|C|S|R|CC)_\d))\.pdf/g;

const CATEGORY: Record<string, string> = {
  M_J: "Miscellaneous",
  F_J: "Regular",
  M_C: "Chamber",
  M_S: "Single Judge",
  M_CC: "Review & Curative",
  M_R: "Registrar",
};

function ddmmyyyy(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}-${m}-${y}`;
}

function item(path: string, o: { listType: CauseListType; listDate: string; category: string; weekTo?: string; urlFromPattern?: boolean }): DiscoveredDoc {
  const url = `https://api.sci.gov.in/jonew/cl/${path}`;
  const cat = o.category === "weekly" ? "Weekly" : o.category === "advance" ? "Advance (miscellaneous)" : `${CATEGORY[o.category.replace(/_\d$/, "")] ?? o.category} ${o.listType === "supplementary" ? "supplementary" : "main"}`;
  const title = o.listType === "weekly" ? `Supreme Court weekly list ${ddmmyyyy(o.listDate)} to ${ddmmyyyy(o.weekTo!)}` : `Supreme Court cause list — ${cat}, ${ddmmyyyy(o.listDate)}`;
  return {
    sourceId: "sci-causelist",
    kind: "cause_list",
    url,
    fileUrl: url,
    title,
    docDate: o.listDate,
    mime: "application/pdf",
    meta: {
      forum: "sci",
      docKind: "cause_list",
      listType: o.listType,
      listDate: o.listDate,
      category: o.category,
      mirrorUrl: `https://webapi.sci.gov.in/jonew/cl/${path}`,
      ...(o.weekTo ? { weekFrom: o.listDate, weekTo: o.weekTo, large: true } : {}),
      ...(o.urlFromPattern ? { urlFromPattern: true } : {}),
    },
  };
}

/** Cause-list files linked from the listing page, inside [today - 2, today + 14] (weekly lists by overlap). */
export function sciCauseListLinks(html: string, today: string): DiscoveredDoc[] {
  const lo = addDays(today, -2);
  const hi = addDays(today, 14);
  const byPath = new Map<string, DiscoveredDoc>();
  LINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LINK_RE.exec(html))) {
    let path: string;
    let doc: DiscoveredDoc | null = null;
    if (m[1]) {
      path = `advance/${m[2]}/M_J.pdf`;
      if (m[2] >= lo && m[2] <= hi) doc = item(path, { listType: "advance", listDate: m[2], category: "advance" });
    } else if (m[3]) {
      path = `wk/${m[3]}_${m[4]}/weekly.pdf`;
      if (m[4] >= lo && m[3] <= hi && m[4] >= m[3]) doc = item(path, { listType: "weekly", listDate: m[3], category: "weekly", weekTo: m[4] });
    } else {
      path = `${m[5]}/${m[6]}.pdf`;
      if (m[5] >= lo && m[5] <= hi) doc = item(path, { listType: m[6].endsWith("_1") ? "main" : "supplementary", listDate: m[5], category: m[6] });
    }
    if (doc && !byPath.has(path)) byPath.set(path, doc);
  }
  return [...byPath.values()].sort((a, b) => (a.docDate! < b.docDate! ? -1 : a.docDate! > b.docDate! ? 1 : a.url.localeCompare(b.url)));
}

/** Documented daily file names for today and the next three weekdays (used only when the listing page fails). */
export function sciPatternFallback(today: string): DiscoveredDoc[] {
  const out: DiscoveredDoc[] = [];
  let d = today;
  for (let n = 0; out.length < 12 && n < 7; n++, d = addDays(d, 1)) {
    const wd = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (wd === 0 || wd === 6) continue;
    for (const cat of ["M_J_1", "M_J_2", "F_J_1"]) out.push(item(`${d}/${cat}.pdf`, { listType: cat.endsWith("_1") ? "main" : "supplementary", listDate: d, category: cat, urlFromPattern: true }));
  }
  return out.slice(0, 12);
}

const def: SourceDef = {
  id: "sci-causelist",
  name: "Supreme Court cause lists",
  publisher: "Supreme Court of India",
  kinds: ["cause_list"],
  forum: "sci",
  homepage: SCI_CAUSELIST_PAGE,
  fetch: "firecrawl_in",
  cadenceMinutes: 60,
  attribution: "Cause list published by the Supreme Court of India (sci.gov.in). Lists are not authoritative; check the latest supplementary list.",
  terms: GOV_TERMS,
  enabled: true,
  notes: [
    "Daily lists bind items to columns only from positional PDF text; without it the list is kept as text and no entries are parsed.",
    "Weekly lists can exceed 700 pages (meta.large); the pipeline's page cap applies.",
    "The cause-list search form (court, judge, AOR, party) is CAPTCHA-protected and is not used.",
  ],
};

export const adapter: SourceAdapter = {
  def,
  async discover(ctx: AdapterContext): Promise<DiscoverResult> {
    const notes: string[] = [];
    let items: DiscoveredDoc[] = [];
    try {
      const page = await ctx.fetchPage(SCI_CAUSELIST_PAGE);
      items = sciCauseListLinks(`${page.html ?? ""}\n${page.links.join("\n")}`, ctx.today);
      if (!items.length) notes.push("listing page read but no cause-list links in the window");
    } catch (e) {
      notes.push(`listing page unavailable (${(e as Error).message.slice(0, 160)}); trying the documented daily file names`);
      items = sciPatternFallback(ctx.today);
    }
    return pageOf(markRefetch(items, ctx.today), ctx, notes);
  },
  parse(doc: ParseInput) {
    const lt = doc.meta.listType;
    return causeListParse(doc, { layout: lt === "advance" || lt === "weekly" ? "sci-table" : "sci-daily", forum: "sci" });
  },
  persist: causeListPersist,
};
