import "server-only";
import type { AdapterContext, DiscoverResult, ParseInput, ParseResult, SourceAdapter } from "../../adapter";
import type { DiscoveredDoc, SourceDef } from "../../types";
import {
  FAIL_RUN, GOV_TERMS, addRetry, clean, emptyCursor, errorStatus, htmlText, isNotFound, isStopError, isTooLargeError, nearDeadline, parseCursor, printedDate,
  readRetry, retryKey, serializeCursor, settleRetry, type RegCursor,
} from "./common";

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
 * year's folder is tried once for the same ids (a year boundary). A second run of misses ends a first pass, a backfill,
 * or an incremental walk that has found nothing yet; once an incremental pass has found a gazette, every id below it
 * down to the previous pass's marker is probed (ids are issued in sequence), so the marker never moves past unprobed
 * ids. The marker is the highest id found published.
 * A probe that fails (not 404) on one id while lower ids answer is skipped for now and kept on a retry list in the
 * cursor ("#retry:ids"), re-probed at the end of later passes, and after RETRY_ATTEMPTS failures recorded as unverified
 * ("#unverified:ids"); it is never counted as published. FAIL_RUN consecutive failures stop the walk when the id just
 * above them fails too (the host is failing); when that id answers, they are recorded the same way and stepped over.
 * Hindi pages carry a legacy-font text layer that is garbled; the pipeline OCRs such pages (no font repair here).
 */

const BASE = "https://egazette.gov.in";
const MAX_MISSES = 25;
/** Ids probed by the first incremental pass (no marker yet); older gazettes come from a backfill. */
const FIRST_PASS_IDS = 300;
/** Ids above the previous pass's newest gazette that one incremental pass walks (about three months of gazettes). */
const MAX_SPAN = 5000;

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
  return { ...emptyCursor(mode, lastSeen), plan: ["ids"] };
}

/** Stream name of the id walk in the cursor's retry / unverified lists ("#retry:ids", "#unverified:ids"). */
const STREAM = "ids";

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
  const items: DiscoveredDoc[] = [];
  let probed = 0;
  /** Ids put on the retry list by this call (probed again from the next pass on). */
  const recordedNow = new Set<number>();

  /** Ids that failed in earlier passes (see FAIL_RUN): probed again at the end of a pass, within the call's budget. */
  const retryFailed = async () => {
    for (const r of readRetry(c.lastSeen, retryKey(STREAM))) {
      if (recordedNow.has(r.n)) continue;
      if (items.length >= ctx.limit || nearDeadline(ctx)) return;
      const year = Number(r.tag) || Number(c.lastSeen.floorYear) || Number(ctx.today.slice(0, 4));
      let res: ProbeResult;
      try {
        res = await probePdf(ctx, egazettePdfUrl(year, r.n));
      } catch (e) {
        if (isStopError(e, ctx)) return;
        settleRetry(c.lastSeen, STREAM, r.n, "failed", notes);
        continue;
      }
      settleRetry(c.lastSeen, STREAM, r.n, "answered", notes);
      if (res === "exists") items.push(gazetteDoc(r.n, year, byId.get(r.n)));
      notes.push(`gazette ${r.n}: ${res === "exists" ? "published" : `not published under /${year}/`} (answered on retry).`);
    }
  };
  const finish = async (): Promise<DiscoverResult> => {
    await retryFailed();
    const lastSeen = { ...c.lastSeen };
    // The next pass stops at the highest id found published (never at a listed id that was not found).
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
  /** Put the `count` failed ids from `low` upward on the retry list (never counted as published). */
  const recordFailed = (low: number, count: number, what: string) => {
    for (let fid = low + count - 1; fid >= low; fid--) {
      addRetry(c.lastSeen, STREAM, fid, String(byId.get(fid)?.year ?? Number(c.newest._year)), notes);
      recordedNow.add(fid);
    }
    notes.push(`${what}; skipped for now and recorded for retry (not counted as published).`);
    c.fails = 0;
  };
  /** Whether the host gives a definitive answer (a PDF, or not published) for `id`; throws only on a stop. */
  const hostHealthy = async (id: number): Promise<boolean> => {
    try {
      await probePdf(ctx, egazettePdfUrl(byId.get(id)?.year ?? Number(c.newest._year), id));
      return true;
    } catch (e) {
      if (isStopError(e, ctx)) throw e;
      return false;
    }
  };

  if (c.page == null) {
    if (c.mode === "incremental") {
      if (!rows.length) {
        notes.push("home page listed no gazettes; nothing to walk.");
        return finish();
      }
      let start = rows[0].id;
      if (Number.isFinite(marker) && start - marker > MAX_SPAN) {
        // A listed id far above the previous pass's newest gazette (a long pause, or a misprinted UGID): walk the
        // MAX_SPAN ids above the marker now; the next pass continues above the newest gazette found.
        start = marker + MAX_SPAN;
        notes.push(`the home page lists gazette ${rows[0].id}, more than ${MAX_SPAN} ids above the previous pass's newest (${marker}); this pass walks down from ${start}.`);
      }
      c.page = start;
      c.newest = { _year: String(byId.get(start)?.year ?? rows[0].year) };
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
    c.fails = 0;
    c.walked = 0;
  }

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
      probed += 1;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (isStopError(e, ctx)) {
        if (items.length || probed) return partial("Stopped before the deadline.");
        throw e;
      }
      // One id failing (403 from a WAF, 500, a TLS error on one file) must not stop discovery for good: the id is
      // stepped over — unverified, never counted as published — and recorded for retry once a lower id answers.
      // After FAIL_RUN consecutive failures one probe of the id just above them tells failing files (the host answers:
      // they are recorded and stepped over) from a failing host (stop; the walk resumes at the first of them).
      c.fails += 1;
      c.walked += 1;
      if (c.fails < FAIL_RUN) { c.page = id - 1; continue; }
      const first = id + c.fails - 1;
      let hostAnswers: boolean;
      try {
        hostAnswers = await hostHealthy(first + 1);
      } catch (e2) {
        if (items.length || probed) return partial("Stopped before the deadline.");
        throw e2;
      }
      if (hostAnswers) {
        recordFailed(id, c.fails, `gazette ${first}..${id}: probes failed while the host answered for gazette ${first + 1}`);
        c.page = id - 1;
        continue;
      }
      c.page = first;
      c.fails = 0;
      if (items.length) return partial(`gazette ${id}: ${msg}; ${FAIL_RUN} consecutive ids failed and so did gazette ${first + 1} (the host is failing); the walk resumes at ${c.page}.`);
      throw e;
    }
    c.walked += 1;
    if (c.fails) recordFailed(id + 1, c.fails, `gazette ${id + c.fails}${c.fails > 1 ? `..${id + 1}` : ""}: probe failed while lower ids answered`);
    if (!(Number(c.newest._low) <= id)) c.newest._low = String(id);
    if (res === "exists") {
      items.push(gazetteDoc(id, year, row));
      c.misses = 0;
      c.newest._year = String(year);
      delete c.newest._switched;
      delete c.newest._base;
      if (c.mode === "incremental" && !(Number(c.newest.ids) >= id)) c.newest.ids = String(id);
      c.page = id - 1;
      continue;
    }
    if (c.misses === 0) c.newest._missFrom = String(id);
    c.misses += 1;
    if (c.misses >= MAX_MISSES) {
      if (!c.newest._switched && year > 1990) {
        // Year boundary: retry the same ids in the previous year's folder (documented pattern, same ids).
        c.newest._switched = "1";
        c.newest._base = String(year);
        c.newest._year = String(year - 1);
        c.page = Number(c.newest._missFrom);
        c.misses = 0;
        notes.push(`ids ${c.page}..${id} were not in /${year}/; trying /${year - 1}/ for the same ids.`);
        continue;
      }
      // Incremental, below a gazette found in this pass and above the previous pass's newest one: ids are issued in one
      // sequence, so every id in between was issued and the walk goes on down to the marker (the marker never moves
      // past ids that were not probed). A first pass or a backfill has no such bound and ends here.
      if (c.mode === "incremental" && Number.isFinite(marker) && Number.isFinite(Number(c.newest.ids))) {
        const base = Number(c.newest._base) || year;
        notes.push(`ids ${c.newest._missFrom}..${id} were not published in /${base}/ or /${base - 1}/; the walk continues down to ${marker + 1}.`);
        c.newest._year = String(base);
        delete c.newest._switched;
        delete c.newest._base;
        c.misses = 0;
        c.page = id - 1;
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
