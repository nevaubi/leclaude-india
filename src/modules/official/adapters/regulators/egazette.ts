import "server-only";
import type { AdapterContext, DiscoverResult, ParseInput, ParseResult, SourceAdapter } from "../../adapter";
import type { DiscoveredDoc, SourceDef } from "../../types";
import { GOV_TERMS, clean, errorStatus, htmlText, isNotFound, isTooLargeError, nearDeadline, parseCursor, printedDate, serializeCursor, type RegCursor } from "./common";

/**
 * e-Gazette of India (egazette.gov.in). Verified 2026-10-02:
 * - The home page (ASP.NET, cookieless session in the path) lists "Recent Extra Ordinary Gazettes" (rpt_Extra) and
 *   "Recent Weekly Gazettes" (rpt_Week): ministry, subject, date, UGID ("CG-DL-E-02102026-276731"), file size. Downloads
 *   are postback buttons.
 * - PDFs follow the documented pattern https://egazette.gov.in/WriteReadData/{YYYY}/{gazetteId}.pdf where gazetteId is the
 *   UGID's trailing number (one global sequence across CG/SG and Extraordinary/Weekly) and YYYY the publication year.
 *
 * Discovery: newest-first descending id enumeration from the highest id on the home page down to the previous pass's
 * marker. Every URL is built from the documented pattern (meta.urlFromPattern = true) and probed with a small ranged
 * read; 404 (or a non-PDF answer) means "not published", never a reason to try a different id. The year folder of an id
 * that is not on the home page is inherited from the nearest newer gazette found; after a run of misses the previous
 * year's folder is tried once for the same ids (a year boundary), and a second run of misses ends the walk.
 * Hindi pages carry a legacy-font text layer that is garbled; the pipeline OCRs such pages (no font repair here).
 */

const BASE = "https://egazette.gov.in";
const MAX_MISSES = 25;
/** Ids probed by the first incremental pass (no marker yet); older gazettes come from a backfill. */
const FIRST_PASS_IDS = 300;

export function egazettePdfUrl(year: number, id: number): string {
  return `${BASE}/WriteReadData/${year}/${id}.pdf`;
}

export interface GazetteRow {
  id: number;
  ugid: string;
  year: number;
  date: string | null;
  ministry: string | null;
  subject: string | null;
  fileSize: string | null;
  gazetteType: "extraordinary" | "weekly";
  series: string;
}

const UGID_RE = /\b((CG|SG)-([A-Z]{2})-([EW])-(\d{2})(\d{2})(\d{4})-(\d{3,9}))\b/;

/** Parse a UGID ("CG-DL-E-02102026-276731") into its parts; null when it is not one. */
export function parseUgid(s: string): { ugid: string; series: string; region: string; type: "extraordinary" | "weekly"; date: string | null; year: number; id: number } | null {
  const m = UGID_RE.exec(s);
  if (!m) return null;
  const date = printedDate(`${m[5]}-${m[6]}-${m[7]}`);
  return { ugid: m[1], series: m[2], region: m[3], type: m[4] === "E" ? "extraordinary" : "weekly", date, year: Number(m[7]), id: Number(m[8]) };
}

/** Recent gazettes listed on the home page (both repeaters). */
export function parseEgazetteHome(html: string): GazetteRow[] {
  const spans = new Map<string, string>();
  for (const m of html.matchAll(/<span\s+id="(rpt_(?:Extra|Week)_lbl_[A-Za-z]+_\d+)"[^>]*>([\s\S]*?)<\/span>/gi)) spans.set(m[1], clean(htmlText(m[2])));
  const rows: GazetteRow[] = [];
  for (const [id, value] of spans) {
    const m = /^rpt_(Extra|Week)_lbl_UGID(?:Extra|Weekly)_(\d+)$/.exec(id);
    if (!m) continue;
    const u = parseUgid(value);
    if (!u) continue;
    const suffix = m[1] === "Extra" ? "E" : "W";
    const get = (field: string) => spans.get(`rpt_${m[1]}_lbl_${field}${suffix}_${m[2]}`) ?? null;
    rows.push({
      id: u.id,
      ugid: u.ugid,
      year: u.year,
      date: printedDate(get("Date")) ?? u.date,
      ministry: get("Ministry"),
      subject: get("Subject"),
      fileSize: get("FileSize"),
      gazetteType: u.type,
      series: u.series,
    });
  }
  return rows.sort((a, b) => b.id - a.id);
}

export type ProbeResult = "exists" | "missing";

/** Small ranged read of a pattern URL: a PDF header means published; 404 / non-PDF means not published. */
export async function probePdf(ctx: AdapterContext, url: string): Promise<ProbeResult> {
  try {
    const f = await ctx.fetchFile(url, { maxBytes: 65_536, accept: "application/pdf", headers: { Range: "bytes=0-1023" } });
    if (f.status === 404 || f.status === 410) return "missing";
    if (f.status >= 400) throw Object.assign(new Error(`HTTP ${f.status} for ${url}`), { status: f.status });
    const head = new TextDecoder("latin1").decode(f.bytes.slice(0, 8));
    return head.startsWith("%PDF-") ? "exists" : "missing";
  } catch (e) {
    if (isNotFound(e)) return "missing";
    // The server ignored Range and the file is larger than the probe limit: it exists. An error status (404, 429, 5xx)
    // is never read as "too large".
    const status = errorStatus(e);
    if (isTooLargeError(e) && (status == null || status < 400)) return "exists";
    throw e;
  }
}

function gazetteDoc(id: number, year: number, row: GazetteRow | undefined): DiscoveredDoc {
  const url = egazettePdfUrl(year, id);
  const title = row
    ? `${[row.ministry, row.subject].filter((x) => x && !/may contains? Multiple/i.test(x)).join(": ") || "Gazette of India"} (${row.ugid})`
    : `Gazette of India (gazette id ${id})`;
  return {
    sourceId: "egazette",
    kind: "gazette",
    url,
    fileUrl: url,
    title,
    docDate: row?.date ?? null,
    mime: "application/pdf",
    meta: {
      gazetteId: id,
      ugid: row?.ugid ?? null,
      gazetteType: row?.gazetteType ?? null,
      series: row?.series ?? null,
      ministry: row && !/Multiple/i.test(row.ministry ?? "") ? row.ministry : null,
      subject: row && !/Multiple/i.test(row.subject ?? "") ? row.subject : null,
      fileSize: row?.fileSize ?? null,
      yearFolder: year,
      yearInferred: !row,
      urlFromPattern: true,
    },
  };
}

function freshCursor(mode: RegCursor["mode"], lastSeen: Record<string, string>): RegCursor {
  return { v: 1, mode, plan: ["ids"], i: 0, page: null, skip: 0, misses: 0, walked: 0, lastSeen, newest: {}, only: null };
}

export async function discoverEgazette(ctx: AdapterContext): Promise<DiscoverResult> {
  const notes: string[] = [];
  let cur = parseCursor(ctx.cursor);
  if (!cur) {
    if (ctx.cursor) notes.push("Stored cursor was not readable; started a new incremental pass.");
    cur = freshCursor("incremental", {});
  }
  const c = cur;
  let rows: GazetteRow[] = [];
  try {
    const home = await ctx.fetchPage(`${BASE}/`);
    rows = parseEgazetteHome(home.html ?? "");
  } catch (e) {
    if (c.page == null) throw e;
    notes.push(`home page unavailable (${e instanceof Error ? e.message : String(e)}); continuing the walk without listing metadata.`);
  }
  const byId = new Map(rows.map((r) => [r.id, r]));
  const marker = c.lastSeen.ids != null ? Number(c.lastSeen.ids) : NaN;
  if (c.page == null) {
    if (c.mode === "incremental") {
      if (!rows.length) return { items: [], nextCursor: serializeCursor(c), done: true, notes: [...notes, "home page listed no gazettes; nothing to walk."] };
      c.page = rows[0].id;
      c.newest = { ids: String(rows[0].id), _year: String(rows[0].year) };
    } else {
      // Backfill continues below the lowest id any earlier pass probed (else below the newest listed id); the
      // incremental marker (lastSeen.ids) is left untouched.
      const floor = Number(c.lastSeen.floor);
      const top = Number.isFinite(floor) ? floor - 1 : rows[0]?.id;
      if (!top) return { items: [], nextCursor: serializeCursor(c), done: true, notes: [...notes, "no starting id for a backfill."] };
      const year = Number(c.lastSeen.floorYear) || byId.get(top)?.year || rows[0]?.year || Number(ctx.today.slice(0, 4));
      c.page = top;
      c.newest = { _year: String(year) };
    }
    c.misses = 0;
    c.walked = 0;
  }
  const items: DiscoveredDoc[] = [];
  const finish = (): DiscoverResult => {
    const lastSeen = { ...c.lastSeen };
    const top = Number(c.newest.ids);
    if (Number.isFinite(top) && !(Number(lastSeen.ids) > top)) lastSeen.ids = String(top);
    const low = Number(c.newest._low);
    if (Number.isFinite(low) && !(Number(lastSeen.floor) < low)) {
      lastSeen.floor = String(low);
      lastSeen.floorYear = c.newest._year ?? lastSeen.floorYear ?? "";
    }
    return { items, nextCursor: serializeCursor(freshCursor("incremental", lastSeen)), done: true, notes: notes.length ? notes : undefined };
  };
  const partial = (why?: string): DiscoverResult => {
    if (why) notes.push(why);
    return { items, nextCursor: serializeCursor(c), done: false, notes: notes.length ? notes : undefined };
  };

  while (true) {
    const id: number = c.page!;
    if (id < 1) return finish();
    if (c.mode === "incremental" && Number.isFinite(marker) && id <= marker) return finish();
    if (c.mode === "incremental" && !Number.isFinite(marker) && c.walked >= FIRST_PASS_IDS) {
      notes.push(`first pass stopped after ${FIRST_PASS_IDS} ids; older gazettes need a backfill.`);
      return finish();
    }
    if (items.length >= ctx.limit) return partial();
    if (nearDeadline(ctx)) return partial("Stopped before the deadline.");
    const row = byId.get(id);
    const year = row?.year ?? Number(c.newest._year);
    let res: ProbeResult;
    try {
      res = await probePdf(ctx, egazettePdfUrl(year, id));
    } catch (e) {
      if (items.length) return partial(`gazette ${id}: ${e instanceof Error ? e.message : String(e)}`);
      throw e;
    }
    c.walked += 1;
    if (!(Number(c.newest._low) <= id)) c.newest._low = String(id);
    if (res === "exists") {
      items.push(gazetteDoc(id, year, row));
      c.misses = 0;
      c.newest._year = String(year);
      delete c.newest._switched;
      c.page = id - 1;
      continue;
    }
    if (c.misses === 0) c.newest._missFrom = String(id);
    c.misses += 1;
    if (c.misses >= MAX_MISSES) {
      if (!c.newest._switched && year > 1990) {
        // Year boundary: retry the same ids in the previous year's folder (documented pattern, same ids).
        c.newest._switched = "1";
        c.newest._year = String(year - 1);
        c.page = Number(c.newest._missFrom);
        c.misses = 0;
        notes.push(`ids ${c.page}..${id} were not in /${year}/; trying /${year - 1}/ for the same ids.`);
        continue;
      }
      notes.push(`${MAX_MISSES} consecutive ids not published below ${c.newest._missFrom}; walk ended.`);
      return finish();
    }
    c.page = id - 1;
  }
}

/** Page-1 metadata of a gazette (English half): UGID, part/section, gazette number, dates, ministry, S.O./G.S.R. numbers. */
export function parseGazetteText(doc: ParseInput): ParseResult<{ meta: Record<string, unknown> }> {
  const raw = doc.pages.length ? doc.pages.slice(0, 3).map((p) => p.text).join("\n") : doc.markdown.slice(0, 40_000);
  const text = raw.replace(/\*\*/g, "").replace(/\r/g, "");
  const u = parseUgid(text);
  if (!u) return { records: [], unparsed: 1, notes: ["no UGID on the first pages"] };
  const part = /PART\s+([IVX]+)\s*[—–-]+\s*Section\s+(\d+)(?:\s*[—–-]+\s*Sub-section\s*\(([ivx]+)\))?/i.exec(text);
  const gazetteNo = /\bNo\.\s*(\d{1,6})\]/.exec(text)?.[1] ?? null;
  const pub = /NEW DELHI,\s*[A-Z]+DAY,\s*([A-Z]+\s+\d{1,2},\s*\d{4})/i.exec(text)?.[1] ?? null;
  const ministries = [...new Set([...text.matchAll(/^[#\s]*((?:MINISTRY|DEPARTMENT) OF [A-Z][A-Z ,&()'-]{3,120})\s*$/gm)].map((m) => clean(m[1])))];
  const numbers = [...new Set([...text.matchAll(/(?:^|\n)[#\s]*(S\.\s?O\.|G\.\s?S\.\s?R\.)\s*(\d{1,6})\s*(\([EA]\))?\s*\.?\s*[—–-]/g)].map((m) => `${m[1].replace(/\s/g, "")} ${m[2]}${m[3] ?? ""}`))];
  const notifDate = /New Delhi,\s*the\s+(\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]+,?\s*\d{4})/.exec(text)?.[1] ?? null;
  const fileNos = [...new Set([...text.matchAll(/\[F\.\s*No\.\s*([^\]\n]{3,120})\]/g)].map((m) => clean(m[1])))];
  return {
    records: [{
      meta: {
        ugid: u.ugid,
        gazetteId: u.id,
        gazetteType: u.type,
        series: u.series,
        part: part ? `Part ${part[1]}, Section ${part[2]}${part[3] ? `, Sub-section (${part[3]})` : ""}` : null,
        gazetteNo,
        publicationDate: printedDate(pub) ?? u.date,
        ministries,
        notificationNumbers: numbers,
        notificationDate: printedDate(notifDate),
        fileNumbers: fileNos,
      },
    }],
    unparsed: 0,
  };
}

export const def: SourceDef = {
  id: "egazette",
  name: "e-Gazette of India",
  publisher: "Government of India, e-Gazette (Department of Publication)",
  kinds: ["gazette"],
  forum: null,
  homepage: "https://egazette.gov.in/",
  fetch: "direct",
  cadenceMinutes: 360,
  attribution: "The Gazette of India as published on egazette.gov.in.",
  terms: GOV_TERMS,
  enabled: true,
  notes: [
    "File URLs follow the documented pattern /WriteReadData/{year}/{gazetteId}.pdf (urlFromPattern); a 404 means not published.",
    "The year folder of ids not on the home page is inferred from the nearest newer gazette (yearInferred).",
    "Hindi pages carry a garbled legacy-font text layer and are OCR'd by the pipeline; check quotes against the PDF.",
  ],
};

export const adapter: SourceAdapter = {
  def,
  discover: discoverEgazette,
  parse: parseGazetteText,
};
