import "server-only";
import { generateJSON } from "@/lib/ai/agent";
import { AIConfigError } from "@/lib/ai/config";
import { COURTS, courtById } from "@/lib/india/courts";
import { remoteStore, type RemoteStore } from "@/lib/db/remote";
import { fetchText, htmlToText } from "@/lib/ai/toolkit/http";
import { isLegacyTlsError, legacyTlsAllowed, legacyTlsFetch } from "@/modules/media/legacy-tls";
import { createFirecrawl } from "@/modules/intel/providers/firecrawl";
import { createTavily } from "@/modules/intel/providers/tavily";
import { setMediaVision, storeImageFromUrl, type MediaMeta, type StoredMedia, type VisionVerdict } from "@/modules/media/store";
import { judgeId } from "./names";
import { EXTRACT_SCHEMA, guardExtracted, parseRoster, type ExtractedJudge, type RosterEntry, type RosterParseResult } from "./parse";
import { ensureJudgesSchema, JudgesNotConfiguredError } from "./schema";
import { ATTRIBUTION_NOTE, courtSites, ROSTER_SOURCES, type RosterSource } from "./sources";
import { acceptVerdict, uncheckedVerdict, VISION_SCHEMA, visionPrompt, type RawVision, type VisionExpect } from "./vision";

/**
 * Enrichment job: court identity images and judge rosters from official court websites.
 *
 * judges: for each court with a registered roster page, read the page (Firecrawl), parse it deterministically (or, for
 *   pages whose layout is not verified, guarded extraction where every name must be printed on the page), download each
 *   photograph into the media store (SSRF-safe, validated), vision-check it and keep it only when it is a single-person
 *   portrait. Upserts are idempotent by judge id. A complete roster read marks judges it no longer lists "off_roster".
 * courts: for each court website, take the header logo (a verified URL, else the site's branding logo), store it and
 *   keep it only when the vision check says it is an emblem or logo.
 */

export type EnrichmentTarget = "judges" | "courts" | "all";

export interface ScrapedPage {
  markdown: string;
  links: string[];
  json: unknown;
  logo: string | null;
  title?: string;
}

export interface EnrichDeps {
  store?: RemoteStore | null;
  scrape?: (url: string, o: { links?: boolean; branding?: boolean; markdown?: boolean; json?: { schema: Record<string, unknown>; prompt?: string } }) => Promise<ScrapedPage>;
  storeImage?: (url: string, meta: MediaMeta) => Promise<StoredMedia>;
  /** Describe an image (data URL); return null when no vision model is available. */
  classify?: (dataUrl: string, expect: VisionExpect) => Promise<{ raw: RawVision; model: string | null } | null>;
  now?: () => Date;
  /** Wall-clock budget for the whole run (ms). */
  deadlineMs?: number;
  /** Second reader for roster pages the scraper could not load (Tavily extract); returns page text per URL read. */
  extractText?: (urls: string[]) => Promise<{ url: string; text: string }[]>;
  /** Structured extraction of judges from page text (model); every result is still guarded against the text. */
  extractJudges?: (text: string, url: string) => Promise<ExtractedJudge[] | null>;
  /**
   * Direct reader: fetch the official page from this server (SSRF-safe) and return it as text with image URLs kept as
   * ![alt](url). Used when the scraper cannot reach a site (several Indian court sites only answer requests from India,
   * so the enrichment route runs in the Mumbai region). Null when the page could not be read.
   */
  fetchPage?: ((url: string) => Promise<{ url: string; text: string } | null>) | null;
}

export interface PhotoStats { stored: number; accepted: number; rejected: number; unchecked: number; failed: number; missing: number; reused: number }

export interface CourtJudgesReport {
  courtId: string;
  sourceUrl: string;
  parser: string;
  status: "ok" | "failed" | "skipped" | "partial";
  found: number;
  upserted: number;
  offRoster: number;
  photos: PhotoStats;
  notes: string[];
  error?: string;
}

export interface CourtAssetReport {
  courtId: string;
  siteUrl: string;
  imageUrl: string | null;
  status: "stored" | "rejected" | "failed" | "skipped" | "unchecked";
  kind?: string;
  mediaId?: string;
  reason?: string;
}

export interface EnrichmentReport {
  target: EnrichmentTarget;
  startedAt: string;
  finishedAt: string;
  stop: "done" | "deadline";
  judges: CourtJudgesReport[];
  courts: CourtAssetReport[];
  skippedCourts: { courtId: string; reason: string }[];
}

/** Official Indian government hosts (gov.in / nic.in). */
export function isIndianGovHost(url: string): boolean {
  try { return /(^|\.)(gov\.in|nic\.in)$/i.test(new URL(url).hostname); } catch { return false; }
}

/** Expands client-side paged tables (jQuery DataTables) to show every row before the page is read; a no-op elsewhere. */
export const SHOW_ALL_TABLE_ROWS = `(() => { try { const $ = window.jQuery; if (!$ || !$.fn || !$.fn.dataTable) return; $.fn.dataTable.tables().forEach((t) => { try { $(t).DataTable().page.len(-1).draw(false); } catch (e) {} }); } catch (e) {} })();`;

function defaultScrape(): NonNullable<EnrichDeps["scrape"]> {
  const fc = createFirecrawl();
  return async (url, o) => {
    if (!fc.configured) throw new Error("FIRECRAWL_API_KEY is not configured; official pages cannot be read");
    const indian = isIndianGovHost(url);
    const p = await fc.scrapeRich(url, {
      markdown: o.markdown !== false, links: o.links, branding: o.branding, json: o.json, onlyMainContent: !o.branding,
      // Indian court sites often refuse foreign requests; and rosters in paged tables show only the first page unless expanded.
      ...(indian ? { country: "IN" } : {}),
      ...(o.json ? { actions: [{ type: "executeJavascript", script: SHOW_ALL_TABLE_ROWS }, { type: "wait", milliseconds: 1500 }] } : {}),
    });
    return { markdown: p.markdown, links: p.links, json: p.json, logo: p.logo, title: p.title };
  };
}

async function defaultClassify(dataUrl: string, expect: VisionExpect): Promise<{ raw: RawVision; model: string | null } | null> {
  try {
    const raw = await generateJSON<RawVision>({
      fast: true,
      taskType: "vision",
      schema: VISION_SCHEMA as unknown as Record<string, unknown>,
      name: "image_check",
      input: [{ role: "user", content: [{ type: "input_text", text: visionPrompt(expect) }, { type: "input_image", image_url: dataUrl, detail: "low" }] }],
    });
    return { raw, model: null };
  } catch (e) {
    if (e instanceof AIConfigError) return null;
    throw e;
  }
}

/** HTML → text for roster extraction, keeping each image as ![alt](absolute url) so photographs stay traceable. */
export function rosterHtmlToText(html: string, pageUrl: string): string {
  const withImages = html.replace(/<img\b[^>]*>/gi, (tag) => {
    const src = /\ssrc\s*=\s*(["'])(.*?)\1/i.exec(tag)?.[2];
    if (!src || src.startsWith("data:")) return " ";
    let abs: string;
    try { abs = new URL(src, pageUrl).toString(); } catch { return " "; }
    if (!/^https?:\/\//.test(abs)) return " ";
    const alt = (/\salt\s*=\s*(["'])(.*?)\1/i.exec(tag)?.[2] ?? "").replace(/[\[\]]/g, "").slice(0, 120);
    return ` ![${alt}](${abs.replace(/\)/g, "%29").replace(/\s/g, "%20")}) `;
  });
  return htmlToText(withImages, { maxChars: 150_000 }).text;
}

async function defaultFetchPage(url: string): Promise<{ url: string; text: string } | null> {
  let res: Awaited<ReturnType<typeof fetchText>>;
  try {
    res = await fetchText(url, { timeoutMs: 25_000 });
  } catch (e) {
    // Older government servers need TLS legacy renegotiation (see media/legacy-tls.ts); https gov.in / nic.in only.
    if (!isLegacyTlsError(e) || !legacyTlsAllowed(url)) throw e;
    res = await fetchText(url, { timeoutMs: 25_000, fetchImpl: legacyTlsFetch });
  }
  if (!/html|text\/plain/i.test(res.contentType || "text/html")) return null;
  return { url: res.finalUrl || url, text: rosterHtmlToText(res.text, res.finalUrl || url) };
}

function defaultExtractText(): NonNullable<EnrichDeps["extractText"]> {
  const tv = createTavily();
  return async (urls) => {
    if (!tv.configured) return [];
    const r = await tv.extract(urls, { maxChars: 200_000, ttlMs: 0 });
    return r.results.filter((x) => x.text.trim());
  };
}

async function defaultExtractJudges(text: string, url: string): Promise<ExtractedJudge[] | null> {
  try {
    const out = await generateJSON<{ judges?: ExtractedJudge[] }>({
      fast: true,
      schema: EXTRACT_SCHEMA as unknown as Record<string, unknown>,
      name: "roster_extract",
      instructions: "Extract the sitting judges listed on an official court roster page. Copy names, designations, URLs and dates exactly as printed; leave a field empty when the page does not print it. Never add a judge who is not on the page.",
      input: `Page: ${url}\n\n${text.slice(0, 120_000)}`,
    });
    return Array.isArray(out?.judges) ? out.judges : [];
  } catch (e) {
    if (e instanceof AIConfigError) return null;
    throw e;
  }
}

async function mediaVision(store: RemoteStore, id: string): Promise<VisionVerdict | null> {
  const r = await store.query({ query: `SELECT vision FROM media_assets WHERE id = $1`, params: [id] });
  try { return r[0]?.vision ? (JSON.parse(r[0].vision) as VisionVerdict) : null; } catch { return null; }
}

interface Ctx {
  store: RemoteStore;
  scrape: NonNullable<EnrichDeps["scrape"]>;
  extractText?: EnrichDeps["extractText"];
  extractJudges?: EnrichDeps["extractJudges"];
  fetchPage?: EnrichDeps["fetchPage"];
  storeImage: NonNullable<EnrichDeps["storeImage"]>;
  classify: NonNullable<EnrichDeps["classify"]>;
  now: () => Date;
  deadline: number;
}

type PhotoOutcome = { mode: "set"; mediaId: string | null; vision: VisionVerdict | null } | { mode: "keep" };

/** Store + check one image. Re-uses a stored verdict for bytes already checked (same hash) instead of asking again. */
async function checkedImage(ctx: Ctx, url: string, meta: MediaMeta, expect: VisionExpect, stats?: PhotoStats): Promise<{ media: StoredMedia; vision: VisionVerdict; checked: boolean }> {
  const media = await ctx.storeImage(url, meta);
  if (stats) stats.stored++;
  if (media.existed) {
    const prior = await mediaVision(ctx.store, media.id);
    if (prior && prior.kind !== "unchecked") { if (stats) stats.reused++; return { media, vision: prior, checked: true }; }
  }
  const res = await ctx.classify(media.dataUrl, expect);
  if (!res) {
    const v = uncheckedVerdict("No vision model is configured; the image was stored but not checked, so it is not shown.", ctx.now());
    await setMediaVision(media.id, v, { store: ctx.store });
    return { media, vision: v, checked: false };
  }
  const v = acceptVerdict(expect, res.raw, res.model, ctx.now());
  await setMediaVision(media.id, v, { store: ctx.store });
  return { media, vision: v, checked: true };
}

async function photoFor(ctx: Ctx, e: RosterEntry, src: RosterSource, stats: PhotoStats): Promise<PhotoOutcome> {
  if (!e.photoUrl) { stats.missing++; return { mode: "set", mediaId: null, vision: null }; }
  try {
    const { media, vision, checked } = await checkedImage(ctx, e.photoUrl, { pageUrl: src.url, publisher: courtById(src.courtId)?.name ?? null, licenseNote: ATTRIBUTION_NOTE }, "portrait", stats);
    if (!checked) { stats.unchecked++; return { mode: "keep" }; }
    if (vision.ok) { stats.accepted++; return { mode: "set", mediaId: media.id, vision }; }
    stats.rejected++;
    return { mode: "set", mediaId: null, vision };
  } catch {
    // Network, validation or provider error: keep whatever photo the judge already had; the next run retries.
    stats.failed++;
    return { mode: "keep" };
  }
}

async function readRosterAt(ctx: Ctx, src: RosterSource, url: string): Promise<RosterParseResult> {
  if (src.parser === "extract") {
    const page = await ctx.scrape(url, { links: true, json: { schema: EXTRACT_SCHEMA as unknown as Record<string, unknown>, prompt: "List every sitting judge on this page, with names exactly as printed. Leave a field empty when the page does not print it." } });
    const items = (page.json as { judges?: ExtractedJudge[] } | null)?.judges;
    return guardExtracted(Array.isArray(items) ? items : [], page.markdown, url, page.links);
  }
  const page = await ctx.scrape(url, { links: false });
  return parseRoster(src.parser, page.markdown, url, { designations: src.designations });
}

interface RosterRead { parsed: RosterParseResult; url: string; via: "scrape" | "direct" | "extract_text" }

/**
 * Read a roster: the registered page, then its official fallback pages, then the same pages through the second reader
 * (page text; deterministic parser, or guarded extraction where every name must be printed in the text). The first read
 * that recognises judges wins; a read that recognised none is returned only when nothing better was found.
 */
async function readRoster(ctx: Ctx, src: RosterSource): Promise<RosterRead> {
  const urls = [src.url, ...(src.fallbackUrls ?? [])];
  const errors: string[] = [];
  let empty: RosterRead | null = null;
  for (const url of urls) {
    try {
      const parsed = await readRosterAt(ctx, src, url);
      if (parsed.entries.length) return { parsed, url, via: "scrape" };
      empty ??= { parsed, url, via: "scrape" };
    } catch (e) {
      errors.push(urls.length > 1 ? `${url}: ${(e as Error).message}` : (e as Error).message);
    }
  }
  if (ctx.fetchPage) {
    for (const url of urls) {
      if (Date.now() >= ctx.deadline) break;
      try {
        const page = await ctx.fetchPage(url);
        if (!page) continue;
        let parsed: RosterParseResult;
        if (src.parser === "extract") {
          const items = ctx.extractJudges ? await ctx.extractJudges(page.text, page.url) : null;
          if (items === null) { errors.push(`${page.url}: read directly, but no extraction model is configured`); continue; }
          parsed = guardExtracted(items, page.text, page.url, []);
        } else {
          parsed = parseRoster(src.parser, page.text, page.url, { designations: src.designations });
        }
        if (parsed.entries.length) return { parsed: { ...parsed, notes: [`Read directly from the official page at ${page.url}.`, ...parsed.notes] }, url: page.url, via: "direct" };
        empty ??= { parsed, url: page.url, via: "direct" };
      } catch (e) {
        errors.push(`direct read ${url}: ${(e as Error).message.slice(0, 200)}`);
      }
    }
  }
  if (ctx.extractText && Date.now() < ctx.deadline) {
    try {
      for (const page of await ctx.extractText(urls)) {
        if (!urls.includes(page.url)) continue;
        let parsed: RosterParseResult;
        if (src.parser === "extract") {
          const items = ctx.extractJudges ? await ctx.extractJudges(page.text, page.url) : null;
          if (items === null) { errors.push(`${page.url}: read as text, but no extraction model is configured`); continue; }
          parsed = guardExtracted(items, page.text, page.url, []);
        } else {
          parsed = parseRoster(src.parser, page.text, page.url, { designations: src.designations });
        }
        if (parsed.entries.length) return { parsed: { ...parsed, notes: [`Read through the second reader (page text) at ${page.url}; photographs are linked only where the text carries their URLs.`, ...parsed.notes] }, url: page.url, via: "extract_text" };
        empty ??= { parsed, url: page.url, via: "extract_text" };
      }
    } catch (e) {
      errors.push(`second reader: ${(e as Error).message}`);
    }
  }
  if (empty) return empty;
  throw new Error(errors.join("; ") || "The roster page could not be read");
}

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>, deadline: number): Promise<boolean> {
  let i = 0;
  let cut = false;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      if (Date.now() > deadline) { cut = true; return; }
      const t = items[i++];
      await fn(t);
    }
  }));
  return !cut;
}

async function enrichCourtJudges(ctx: Ctx, src: RosterSource): Promise<CourtJudgesReport> {
  const report: CourtJudgesReport = { courtId: src.courtId, sourceUrl: src.url, parser: src.parser, status: "ok", found: 0, upserted: 0, offRoster: 0, photos: { stored: 0, accepted: 0, rejected: 0, unchecked: 0, failed: 0, missing: 0, reused: 0 }, notes: [] };
  const runAt = ctx.now().toISOString();
  let parsed: RosterParseResult;
  try {
    const read = await readRoster(ctx, src);
    parsed = read.parsed;
    // Provenance: judges read from a fallback page cite the page actually read.
    if (read.url !== src.url) { src = { ...src, url: read.url }; report.sourceUrl = read.url; }
  } catch (e) {
    return { ...report, status: "failed", error: (e as Error).message.slice(0, 600) };
  }
  report.found = parsed.entries.length;
  report.notes.push(...parsed.notes.slice(0, 20));
  if (!parsed.entries.length) return { ...report, status: "failed", error: "The roster page was read but no judges were recognised on it; nothing was changed." };

  const complete = await pool(parsed.entries, 4, async (e) => {
    const photo = await photoFor(ctx, e, src, report.photos);
    const keep = photo.mode === "keep";
    await ctx.store.query({
      query: `INSERT INTO judges (id, court_id, bench_id, name, printed_name, name_normalized, designation, date_of_appointment, retirement_date, term_expires, parent_high_court,
                profile_url, photo_media_id, photo_source_url, photo_vision, source_url, source_title, status, checked_at, first_seen_at, updated_at)
              VALUES ($1, $2, NULL, $3, $4, $5, $6, $7::date, $8::date, $9::date, NULL, $10, $11, $12, $13::jsonb, $14, $15, 'sitting', $16::timestamptz, $16::timestamptz, $16::timestamptz)
              ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, printed_name = EXCLUDED.printed_name, designation = EXCLUDED.designation,
                date_of_appointment = EXCLUDED.date_of_appointment, retirement_date = EXCLUDED.retirement_date, term_expires = EXCLUDED.term_expires,
                profile_url = EXCLUDED.profile_url,
                photo_media_id = CASE WHEN $17::boolean THEN judges.photo_media_id ELSE EXCLUDED.photo_media_id END,
                photo_source_url = CASE WHEN $17::boolean THEN judges.photo_source_url ELSE EXCLUDED.photo_source_url END,
                photo_vision = CASE WHEN $17::boolean THEN judges.photo_vision ELSE EXCLUDED.photo_vision END,
                source_url = EXCLUDED.source_url, source_title = EXCLUDED.source_title, status = 'sitting', checked_at = EXCLUDED.checked_at, updated_at = EXCLUDED.updated_at`,
      params: [
        judgeId(src.courtId, e.nameNormalized), src.courtId, e.name, e.printedName, e.nameNormalized, e.designation, e.dateOfAppointment, e.retirementDate, e.termExpires,
        e.profileUrl, keep ? null : photo.mediaId, keep ? null : e.photoUrl, keep || !photo.vision ? null : JSON.stringify(photo.vision), src.url, src.title, runAt, keep,
      ],
    });
    report.upserted++;
  }, ctx.deadline);

  if (!complete) {
    report.status = "partial";
    report.notes.push("Stopped at the time budget; the remaining judges are updated on the next run.");
    return report;
  }
  // A complete read of a roster that lists at least half as many judges as were sitting marks the rest off-roster.
  const prev = await ctx.store.query({ query: `SELECT count(*)::int AS n FROM judges WHERE court_id = $1 AND status = 'sitting' AND checked_at < $2::timestamptz`, params: [src.courtId, runAt] });
  const stale = Number(prev[0]?.n ?? 0);
  if (stale > 0) {
    if (report.upserted >= Math.max(1, Math.floor((report.upserted + stale) / 2))) {
      const r = await ctx.store.query({ query: `UPDATE judges SET status = 'off_roster', updated_at = now() WHERE court_id = $1 AND status = 'sitting' AND checked_at < $2::timestamptz RETURNING id`, params: [src.courtId, runAt] });
      report.offRoster = r.length;
    } else {
      report.notes.push(`${stale} previously listed judges were not on this read, which looks incomplete; their status was left unchanged.`);
    }
  }
  return report;
}

async function enrichCourtAsset(ctx: Ctx, site: { courtId: string; siteUrl: string; logoUrl?: string }): Promise<CourtAssetReport> {
  const base: CourtAssetReport = { courtId: site.courtId, siteUrl: site.siteUrl, imageUrl: site.logoUrl ?? null, status: "skipped" };
  let imageUrl = site.logoUrl ?? null;
  try {
    if (!imageUrl) {
      const page = await ctx.scrape(site.siteUrl, { branding: true, markdown: false });
      imageUrl = page.logo;
    }
    if (!imageUrl) return { ...base, status: "skipped", reason: "The site's branding exposed no logo image" };
    const { media, vision, checked } = await checkedImage(ctx, imageUrl, { pageUrl: site.siteUrl, publisher: courtById(site.courtId)?.name ?? null, licenseNote: ATTRIBUTION_NOTE }, "emblem");
    if (!checked) return { ...base, imageUrl, status: "unchecked", mediaId: media.id, reason: vision.reason };
    if (!vision.ok) return { ...base, imageUrl, status: "rejected", mediaId: media.id, kind: vision.kind, reason: vision.reason };
    const kind = vision.kind === "emblem" ? "emblem" : "logo";
    // One identity image per court: an emblem and a logo are alternatives, so the newest accepted one replaces both.
    await ctx.store.transaction([
      { query: `DELETE FROM court_assets WHERE court_id = $1 AND kind IN ('emblem', 'logo') AND kind <> $2`, params: [site.courtId, kind] },
      {
        query: `INSERT INTO court_assets (court_id, kind, media_id, source_url, page_url, checked_at, vision, hidden) VALUES ($1, $2, $3, $4, $5, now(), $6::jsonb, false)
                ON CONFLICT (court_id, kind) DO UPDATE SET media_id = EXCLUDED.media_id, source_url = EXCLUDED.source_url, page_url = EXCLUDED.page_url, checked_at = now(), vision = EXCLUDED.vision, hidden = false`,
        params: [site.courtId, kind, media.id, imageUrl, site.siteUrl, JSON.stringify(vision)],
      },
    ]);
    return { ...base, imageUrl, status: "stored", kind, mediaId: media.id };
  } catch (e) {
    return { ...base, imageUrl, status: "failed", reason: (e as Error).message.slice(0, 300) };
  }
}

export interface RunEnrichmentInput {
  target: EnrichmentTarget;
  courts?: string[];
}

/** Run the job (bounded by `deadlineMs`, default 240 s). Never throws for a single court's failure; see the report. */
export async function runEnrichment(input: RunEnrichmentInput, deps: EnrichDeps = {}): Promise<EnrichmentReport> {
  const store = deps.store === undefined ? remoteStore() : deps.store;
  if (!store) throw new JudgesNotConfiguredError();
  await ensureJudgesSchema(store);
  const now = deps.now ?? (() => new Date());
  const ctx: Ctx = {
    store,
    scrape: deps.scrape ?? defaultScrape(),
    extractText: deps.extractText === undefined ? defaultExtractText() : deps.extractText,
    extractJudges: deps.extractJudges ?? defaultExtractJudges,
    fetchPage: deps.fetchPage === undefined ? defaultFetchPage : deps.fetchPage ?? undefined,
    storeImage: deps.storeImage ?? ((url, meta) => storeImageFromUrl(url, meta, { store })),
    classify: deps.classify ?? defaultClassify,
    now,
    deadline: Date.now() + (deps.deadlineMs ?? 240_000),
  };
  const startedAt = now().toISOString();
  const want = input.courts?.length ? new Set(input.courts) : null;
  const report: EnrichmentReport = { target: input.target, startedAt, finishedAt: startedAt, stop: "done", judges: [], courts: [], skippedCourts: [] };
  if (want) for (const id of want) if (!courtById(id)) report.skippedCourts.push({ courtId: id, reason: "Not a court in the registry" });

  if (input.target === "courts" || input.target === "all") {
    const sites = courtSites().filter((s) => !want || want.has(s.courtId));
    if (want) for (const id of want) if (courtById(id) && !sites.some((s) => s.courtId === id)) report.skippedCourts.push({ courtId: id, reason: "No official website recorded for this court" });
    for (const s of sites) {
      if (Date.now() > ctx.deadline) { report.stop = "deadline"; break; }
      report.courts.push(await enrichCourtAsset(ctx, s));
    }
  }
  if ((input.target === "judges" || input.target === "all") && report.stop === "done") {
    const sources = ROSTER_SOURCES.filter((s) => !want || want.has(s.courtId));
    const ids = want ? [...want].filter((id) => courtById(id)) : COURTS.map((c) => c.id);
    for (const id of ids) {
      if (!sources.some((s) => s.courtId === id)) report.skippedCourts.push({ courtId: id, reason: "No verified official roster page registered yet" });
    }
    for (const src of sources) {
      if (Date.now() > ctx.deadline) { report.stop = "deadline"; break; }
      const r = await enrichCourtJudges(ctx, src);
      report.judges.push(r);
      if (r.status === "partial") { report.stop = "deadline"; break; }
    }
  }
  report.finishedAt = now().toISOString();
  try {
    await store.query({ query: `INSERT INTO enrichment_state (key, value, updated_at) VALUES ('last_run', $1::jsonb, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, params: [JSON.stringify(report)] });
  } catch { /* the report is still returned */ }
  console.info(JSON.stringify({ level: "info", event: "enrichment.run", target: report.target, stop: report.stop, judges: report.judges.map((j) => ({ c: j.courtId, s: j.status, n: j.upserted, p: j.photos.accepted })), courts: report.courts.map((c) => ({ c: c.courtId, s: c.status })) }));
  return report;
}
