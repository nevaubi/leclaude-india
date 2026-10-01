import "server-only";
import { generateJSON } from "@/lib/ai/agent";
import { AIConfigError } from "@/lib/ai/config";
import { COURTS, courtById } from "@/lib/india/courts";
import { remoteStore, type RemoteStore } from "@/lib/db/remote";
import { createFirecrawl } from "@/modules/intel/providers/firecrawl";
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

function defaultScrape(): NonNullable<EnrichDeps["scrape"]> {
  const fc = createFirecrawl();
  return async (url, o) => {
    if (!fc.configured) throw new Error("FIRECRAWL_API_KEY is not configured; official pages cannot be read");
    const p = await fc.scrapeRich(url, { markdown: o.markdown !== false, links: o.links, branding: o.branding, json: o.json, onlyMainContent: !o.branding });
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

async function mediaVision(store: RemoteStore, id: string): Promise<VisionVerdict | null> {
  const r = await store.query({ query: `SELECT vision FROM media_assets WHERE id = $1`, params: [id] });
  try { return r[0]?.vision ? (JSON.parse(r[0].vision) as VisionVerdict) : null; } catch { return null; }
}

interface Ctx {
  store: RemoteStore;
  scrape: NonNullable<EnrichDeps["scrape"]>;
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

async function readRoster(ctx: Ctx, src: RosterSource): Promise<RosterParseResult> {
  if (src.parser === "extract") {
    const page = await ctx.scrape(src.url, { links: true, json: { schema: EXTRACT_SCHEMA as unknown as Record<string, unknown>, prompt: "List every sitting judge on this page, with names exactly as printed. Leave a field empty when the page does not print it." } });
    const items = (page.json as { judges?: ExtractedJudge[] } | null)?.judges;
    return guardExtracted(Array.isArray(items) ? items : [], page.markdown, src.url, page.links);
  }
  const page = await ctx.scrape(src.url, { links: false });
  return parseRoster(src.parser, page.markdown, src.url, { designations: src.designations });
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
    parsed = await readRoster(ctx, src);
  } catch (e) {
    return { ...report, status: "failed", error: (e as Error).message.slice(0, 300) };
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
        query: `INSERT INTO court_assets (court_id, kind, media_id, source_url, page_url, checked_at, vision) VALUES ($1, $2, $3, $4, $5, now(), $6::jsonb)
                ON CONFLICT (court_id, kind) DO UPDATE SET media_id = EXCLUDED.media_id, source_url = EXCLUDED.source_url, page_url = EXCLUDED.page_url, checked_at = now(), vision = EXCLUDED.vision`,
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
