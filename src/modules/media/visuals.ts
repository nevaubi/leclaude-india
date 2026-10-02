import "server-only";
import { generateJSON } from "@/lib/ai/agent";
import { AIConfigError } from "@/lib/ai/config";
import { courtById } from "@/lib/india/courts";
import { cityById } from "@/lib/india/forums";
import { remoteStore, type RemoteStore, type Row, type SqlQuery } from "@/lib/db/remote";
import { createFirecrawl } from "@/modules/intel/providers/firecrawl";
import { ensureJudgesSchema } from "@/modules/judges/schema";
import { COMMONS_SOURCE_NAME, commonsTargets, rankCandidates, searchCommons, type CommonsCandidate, type CommonsQuery, type CommonsTarget } from "./commons";
import { decodeDataUri, fetchPublic, logoCandidatesFromHtml, logoHostAllowed, looksLikeSvg, rasteriseSvg, REGULATOR_SITES, REGULATORS_WITHOUT_LOGO, regulatorSite, type FetchedBytes, type LogoCandidate, type RegulatorSite } from "./logos";
import { fitImageForStore } from "./resize";
import { setMediaCredit, setMediaVision, storeImageBytes, storeImageFromUrl, type MediaMeta, type StoredMedia } from "./store";
import { mediaUrl, sniffImage } from "./validate";
import { decideVisual, storedVisualFacts, visualFacts, VISUAL_VISION_SCHEMA, visualVisionPrompt, type RawVisualVision, type VisualExpect, type VisualVerdict } from "./visual-vision";
import type { Visual, VisualCredit, VisualKind, VisualsResponse } from "./visuals-types";

/**
 * Visual library: court building and city landmark photographs from Wikimedia Commons, regulator logos from official
 * sites. Each image is stored in `media_assets` (validated bytes, credit columns), vision-checked, and recorded in
 * `visuals` keyed by (kind, key). Only rows that are not hidden and whose verdict is ok are ever served. An image that
 * shows the State Emblem of India is recorded as hidden (audit trail) and never served.
 */

export const VISUALS_SCHEMA: SqlQuery[] = [
  {
    query: `CREATE TABLE IF NOT EXISTS visuals (
      kind text NOT NULL,
      key text NOT NULL,
      media_id text,
      source_url text,
      page_url text,
      credit jsonb,
      alt text,
      dominant text,
      checked_at timestamptz NOT NULL DEFAULT now(),
      vision jsonb,
      hidden boolean NOT NULL DEFAULT false,
      PRIMARY KEY (kind, key)
    )`,
  },
];

export const VISUAL_KINDS_ALL: VisualKind[] = ["court_building", "city", "regulator_logo"];

const ready = new WeakSet<RemoteStore>();

export async function ensureVisualsSchema(store: RemoteStore): Promise<void> {
  if (ready.has(store)) return;
  await ensureJudgesSchema(store);
  for (const q of VISUALS_SCHEMA) await store.query(q);
  ready.add(store);
}

export class VisualsNotConfiguredError extends Error {
  readonly code = "visuals_not_configured";
  constructor() {
    super("The visual library lives in Postgres; this deployment has no database (DATABASE_URL is not set).");
    this.name = "VisualsNotConfiguredError";
  }
}

// ---------------------------------------------------------------------------
// Read (GET /api/india/visuals)
// ---------------------------------------------------------------------------

export function emptyVisuals(): VisualsResponse {
  return { courts: {}, cities: {}, regulators: {}, updatedAt: null };
}

function parseJson<T>(v: string | null | undefined): T | null {
  if (!v) return null;
  try { return JSON.parse(v) as T; } catch { return null; }
}

function rowToVisual(r: Row): Visual | null {
  const credit = parseJson<VisualCredit>(r.credit);
  if (!r.media_id || !credit || typeof credit.license !== "string" || typeof credit.sourceUrl !== "string") return null;
  const n = (v: string | null | undefined) => (v && Number.isFinite(Number(v)) ? Number(v) : null);
  return {
    kind: r.kind as VisualKind,
    key: r.key!,
    url: mediaUrl(r.media_id),
    width: n(r.width),
    height: n(r.height),
    alt: r.alt ?? "",
    credit: { author: credit.author ?? null, license: credit.license, licenseUrl: credit.licenseUrl ?? null, sourceUrl: credit.sourceUrl, sourceName: credit.sourceName ?? "" },
    dominant: r.dominant && /^#[0-9a-f]{6}$/i.test(r.dominant) ? r.dominant.toLowerCase() : null,
  };
}

/** Every shown visual (not hidden, verdict ok). Empty maps when there is no database or the table does not exist yet. */
export async function readVisuals(deps: { store?: RemoteStore | null } = {}): Promise<VisualsResponse> {
  const store = deps.store === undefined ? remoteStore() : deps.store;
  if (!store) return emptyVisuals();
  const probe = await store.query({ query: `SELECT to_regclass('public.visuals')::text AS v` });
  if (!probe[0]?.v) return emptyVisuals();
  const rows = await store.query({
    query: `SELECT v.kind, v.key, v.media_id, v.credit, v.alt, v.dominant, to_char(v.checked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS checked_at, m.width, m.height
            FROM visuals v JOIN media_assets m ON m.id = v.media_id
            WHERE v.hidden = false AND (v.vision->>'ok') = 'true' AND COALESCE(v.vision->>'containsStateEmblem', 'true') = 'false'
            ORDER BY v.kind, v.key`,
  });
  const out = emptyVisuals();
  for (const r of rows) {
    const v = rowToVisual(r);
    if (!v) continue;
    const map = v.kind === "court_building" ? out.courts : v.kind === "city" ? out.cities : v.kind === "regulator_logo" ? out.regulators : null;
    if (!map) continue;
    map[v.key] = v;
    if (r.checked_at && (!out.updatedAt || r.checked_at > out.updatedAt)) out.updatedAt = r.checked_at;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Run (POST /api/india/enrichment/run { target: "visuals" })
// ---------------------------------------------------------------------------

export interface VisualItemReport {
  kind: VisualKind;
  key: string;
  status: "stored" | "rejected" | "skipped" | "failed";
  reason?: string;
  license?: string | null;
  author?: string | null;
  mediaId?: string;
  sourceUrl?: string;
  /** Candidates downloaded and checked for this key. */
  tried?: number;
  /** True when a candidate was refused because it shows the State Emblem (recorded hidden). */
  stateEmblem?: boolean;
}

export interface VisualsReport {
  target: "visuals";
  startedAt: string;
  finishedAt: string;
  stop: "done" | "deadline";
  refresh: boolean;
  items: VisualItemReport[];
  counts: { stored: number; rejected: number; skipped: number; failed: number };
  /** Keys not reached before the deadline; call again to continue. */
  remaining: Array<{ kind: VisualKind; key: string }>;
}

export interface RunVisualsInput {
  kinds?: VisualKind[];
  keys?: string[];
  /** Re-fetch keys that already have a shown image. */
  refresh?: boolean;
}

export type ClassifyVisual = (dataUrl: string, expect: VisualExpect, subject: string) => Promise<{ raw: RawVisualVision; model: string | null } | null>;

export interface VisualsDeps {
  store?: RemoteStore | null;
  searchCommons?: (q: CommonsQuery) => Promise<CommonsCandidate[]>;
  storeImage?: (url: string, meta: MediaMeta) => Promise<StoredMedia>;
  storeBytes?: (bytes: Uint8Array, declaredType: string | null, sourceUrl: string, meta: MediaMeta) => Promise<StoredMedia>;
  fetchBytes?: (url: string, accept: string) => Promise<FetchedBytes>;
  /** Site branding (Firecrawl): the header logo and og:image; null when no reader is configured. */
  scrapeBranding?: (url: string) => Promise<{ logo: string | null; image: string | null } | null>;
  rasterise?: (svg: string) => Promise<Uint8Array>;
  classify?: ClassifyVisual;
  dominant?: (bytes: Uint8Array) => Promise<string | null>;
  now?: () => Date;
  deadlineMs?: number;
  concurrency?: number;
  /** Candidates downloaded and checked per key at most (default 3, logos 4). */
  maxTries?: number;
}

export async function defaultClassifyVisual(dataUrl: string, expect: VisualExpect, subject: string): Promise<{ raw: RawVisualVision; model: string | null } | null> {
  try {
    const raw = await generateJSON<RawVisualVision>({
      fast: true,
      taskType: "vision",
      schema: VISUAL_VISION_SCHEMA as unknown as Record<string, unknown>,
      name: "visual_check",
      input: [{ role: "user", content: [{ type: "input_text", text: visualVisionPrompt(expect, subject) }, { type: "input_image", image_url: dataUrl, detail: "high" }] }],
    });
    return { raw, model: null };
  } catch (e) {
    if (e instanceof AIConfigError) return null;
    throw e;
  }
}

type SharpStats = (input: Uint8Array) => { stats(): Promise<{ dominant?: { r: number; g: number; b: number } }> };
let sharpLoader: Promise<SharpStats | null> | null = null;

/** Dominant colour as #rrggbb (sharp `stats().dominant`), or null when it cannot be computed. */
export async function dominantColour(bytes: Uint8Array): Promise<string | null> {
  sharpLoader ??= import("sharp").then((m) => ((m as { default?: unknown }).default ?? m) as unknown as SharpStats).catch(() => null);
  const sharp = await sharpLoader;
  if (!sharp) return null;
  try {
    const d = (await sharp(bytes).stats()).dominant;
    if (!d) return null;
    return `#${[d.r, d.g, d.b].map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, "0")).join("")}`;
  } catch { return null; }
}

function dataUrlBytes(dataUrl: string): Uint8Array {
  const i = dataUrl.indexOf(",");
  return new Uint8Array(Buffer.from(dataUrl.slice(i + 1), "base64"));
}

interface Ctx {
  store: RemoteStore;
  refresh: boolean;
  searchCommons: NonNullable<VisualsDeps["searchCommons"]>;
  storeImage: NonNullable<VisualsDeps["storeImage"]>;
  storeBytes: NonNullable<VisualsDeps["storeBytes"]>;
  fetchBytes: NonNullable<VisualsDeps["fetchBytes"]>;
  scrapeBranding: NonNullable<VisualsDeps["scrapeBranding"]>;
  rasterise: NonNullable<VisualsDeps["rasterise"]>;
  classify: ClassifyVisual;
  dominant: NonNullable<VisualsDeps["dominant"]>;
  now: () => Date;
  maxTries: number;
}

type Checked = { verdict: VisualVerdict } | { unchecked: string };

/** Vision verdict for stored bytes; a verdict already stored for the same hash (this check's version) is re-decided, not re-asked. */
async function checkVisual(ctx: Ctx, media: StoredMedia, expect: VisualExpect, subject: string): Promise<Checked> {
  if (media.existed) {
    const r = await ctx.store.query({ query: `SELECT vision FROM media_assets WHERE id = $1`, params: [media.id] });
    const prior = parseJson<VisualVerdict>(r[0]?.vision);
    const facts = storedVisualFacts(prior);
    if (facts) return { verdict: decideVisual(expect, facts, prior?.model ?? null, ctx.now()) };
  }
  const res = await ctx.classify(media.dataUrl, expect, subject);
  if (!res) return { unchecked: "No vision model is configured; images cannot be checked, so none is shown." };
  const verdict = decideVisual(expect, visualFacts(res.raw), res.model, ctx.now());
  await setMediaVision(media.id, verdict, { store: ctx.store });
  return { verdict };
}

async function hasShown(ctx: Ctx, kind: VisualKind, key: string): Promise<boolean> {
  const r = await ctx.store.query({ query: `SELECT 1 AS x FROM visuals WHERE kind = $1 AND key = $2 AND hidden = false AND media_id IS NOT NULL AND (vision->>'ok') = 'true'`, params: [kind, key] });
  return r.length > 0;
}

async function saveVisual(ctx: Ctx, kind: VisualKind, key: string, media: StoredMedia, pageUrl: string, credit: VisualCredit, alt: string, verdict: VisualVerdict, hidden: boolean): Promise<void> {
  const dominant = hidden ? null : await ctx.dominant(dataUrlBytes(media.dataUrl)).catch(() => null);
  if (!hidden) await setMediaCredit(media.id, { author: credit.author, licenseUrl: credit.licenseUrl, alt, dominant }, { store: ctx.store });
  await ctx.store.query({
    query: `INSERT INTO visuals (kind, key, media_id, source_url, page_url, credit, alt, dominant, checked_at, vision, hidden)
            VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, now(), $9::jsonb, $10)
            ON CONFLICT (kind, key) DO UPDATE SET media_id = EXCLUDED.media_id, source_url = EXCLUDED.source_url, page_url = EXCLUDED.page_url,
              credit = EXCLUDED.credit, alt = EXCLUDED.alt, dominant = EXCLUDED.dominant, checked_at = now(), vision = EXCLUDED.vision, hidden = EXCLUDED.hidden
            ${hidden ? "WHERE visuals.hidden = true OR (visuals.vision->>'ok') IS DISTINCT FROM 'true'" : ""}`,
    params: [kind, key, media.id, credit.sourceUrl, pageUrl, JSON.stringify(credit), alt, dominant, JSON.stringify(verdict), hidden],
  });
}

interface Attempt { media: StoredMedia; pageUrl: string; credit: VisualCredit; alt: string }

/** Check attempts in order; store the first accepted one. Shared by Commons photographs and logos. */
async function settle(ctx: Ctx, kind: VisualKind, key: string, expect: VisualExpect, subject: string, attempts: AsyncGenerator<Attempt | { error: string }>): Promise<VisualItemReport> {
  const reasons: string[] = [];
  let tried = 0;
  let emblem: { a: Attempt; v: VisualVerdict } | null = null;
  for await (const a of attempts) {
    if ("error" in a) { reasons.push(a.error); continue; }
    tried++;
    const c = await checkVisual(ctx, a.media, expect, subject);
    if ("unchecked" in c) return { kind, key, status: "skipped", reason: c.unchecked, tried, mediaId: a.media.id };
    if (c.verdict.ok) {
      await saveVisual(ctx, kind, key, a.media, a.pageUrl, a.credit, a.alt, c.verdict, false);
      return { kind, key, status: "stored", license: a.credit.license, author: a.credit.author, mediaId: a.media.id, sourceUrl: a.credit.sourceUrl, tried };
    }
    reasons.push(c.verdict.reason);
    if (c.verdict.containsStateEmblem && !emblem) emblem = { a, v: c.verdict };
  }
  if (emblem) await saveVisual(ctx, kind, key, emblem.a.media, emblem.a.pageUrl, emblem.a.credit, emblem.a.alt, emblem.v, true);
  if (!tried) return { kind, key, status: reasons.length ? "failed" : "rejected", reason: reasons.slice(0, 4).join("; ") || "no usable candidate", tried };
  return { kind, key, status: "rejected", reason: reasons.slice(0, 4).join("; "), tried, ...(emblem ? { stateEmblem: true } : {}) };
}

async function commonsItem(ctx: Ctx, t: CommonsTarget): Promise<VisualItemReport> {
  const cands: CommonsCandidate[] = [];
  const errors: string[] = [];
  for (const q of t.queries) {
    try { cands.push(...(await ctx.searchCommons(q))); } catch (e) { errors.push(`search "${q.q}" failed: ${(e as Error).message.slice(0, 160)}`); }
  }
  const requireFor = (c: CommonsCandidate) => t.queries.find((q) => q.q === c.query)?.require ?? [];
  const ranked = rankCandidates(cands, requireFor);
  if (!ranked.length) {
    if (errors.length && !cands.length) return { kind: t.kind, key: t.key, status: "failed", reason: errors.join("; ") };
    return { kind: t.kind, key: t.key, status: "rejected", reason: `No Commons file had an accepted licence, size and title (${cands.length} results)${errors.length ? `; ${errors.join("; ")}` : ""}` };
  }
  const expect: VisualExpect = t.kind === "court_building" ? "building" : "landmark";
  const subject = t.queries[0].label;
  const tries = ctx.maxTries;
  async function* attempts(): AsyncGenerator<Attempt | { error: string }> {
    for (const c of ranked.slice(0, tries)) {
      try {
        const media = await ctx.storeImage(c.imageUrl, { pageUrl: c.pageUrl, publisher: COMMONS_SOURCE_NAME, licenseNote: c.licence.license });
        yield { media, pageUrl: c.pageUrl, alt: c.label, credit: { author: c.author, license: c.licence.license ?? "", licenseUrl: c.licence.licenseUrl, sourceUrl: c.pageUrl, sourceName: COMMONS_SOURCE_NAME } };
      } catch (e) {
        yield { error: `${c.title}: ${(e as Error).message.slice(0, 160)}` };
      }
    }
  }
  return settle(ctx, t.kind, t.key, expect, subject, attempts());
}

async function logoBytes(ctx: Ctx, c: LogoCandidate): Promise<{ bytes: Uint8Array; type: string | null; sourceUrl: string }> {
  let bytes: Uint8Array;
  let type: string | null;
  let sourceUrl = c.url;
  if (/^data:/i.test(c.url)) {
    const d = decodeDataUri(c.url);
    bytes = d.bytes; type = d.type; sourceUrl = "";
  } else {
    const f = await ctx.fetchBytes(c.url, "image/png,image/jpeg,image/webp,image/svg+xml;q=0.8,*/*;q=0.1");
    bytes = f.bytes; type = f.contentType; sourceUrl = f.finalUrl;
  }
  if (looksLikeSvg(bytes, type)) {
    const png = await ctx.rasterise(new TextDecoder().decode(bytes));
    return { bytes: png, type: "image/png", sourceUrl };
  }
  const fitted = await fitImageForStore(bytes, type);
  return { bytes: fitted.bytes, type: fitted.declaredType, sourceUrl };
}

async function logoItem(ctx: Ctx, site: RegulatorSite): Promise<VisualItemReport> {
  const kind: VisualKind = "regulator_logo";
  const cands: LogoCandidate[] = [];
  const notes: string[] = [];
  const add = (url: string | null | undefined, via: LogoCandidate["via"]) => {
    if (!url || cands.some((c) => c.url === url)) return;
    if (!logoHostAllowed(url, site)) { notes.push(`${via} on an unrelated host refused: ${url.slice(0, 120)}`); return; }
    cands.push({ url, via });
  };
  try {
    const b = await ctx.scrapeBranding(site.siteUrl);
    if (b?.logo) add(/^(https?:|data:)/i.test(b.logo) ? b.logo : new URL(b.logo, site.siteUrl).toString(), "branding");
    if (b?.image) add(b.image, "og_image");
  } catch (e) { notes.push(`branding read failed: ${(e as Error).message.slice(0, 160)}`); }
  try {
    const page = await ctx.fetchBytes(site.siteUrl, "text/html,application/xhtml+xml");
    for (const c of logoCandidatesFromHtml(new TextDecoder().decode(page.bytes), page.finalUrl)) add(c.url, c.via);
  } catch (e) { notes.push(`home page read failed: ${(e as Error).message.slice(0, 160)}`); }
  // Prefer real logos over social images and icons; og:image from branding goes after header images.
  const order: LogoCandidate["via"][] = ["branding", "header_img", "og_image", "apple_touch_icon", "icon"];
  cands.sort((a, b) => order.indexOf(a.via) - order.indexOf(b.via));
  if (!cands.length) return { kind, key: site.key, status: notes.some((n) => /failed/.test(n)) ? "failed" : "rejected", reason: notes.join("; ") || "The site exposed no logo image" };
  const credit: VisualCredit = { author: site.name, license: `Logo of ${site.name}`, licenseUrl: null, sourceUrl: site.siteUrl, sourceName: site.name };
  const tries = Math.max(ctx.maxTries, 4);
  async function* attempts(): AsyncGenerator<Attempt | { error: string }> {
    for (const c of cands.slice(0, tries)) {
      try {
        const b = await logoBytes(ctx, c);
        const s = sniffImage(b.bytes);
        if (s?.width && s.height && Math.max(s.width, s.height) < 128) { yield { error: `${c.via} is only ${s.width}x${s.height}` }; continue; }
        const media = await ctx.storeBytes(b.bytes, b.type, b.sourceUrl || site.siteUrl, { pageUrl: site.siteUrl, publisher: site.name, licenseNote: credit.license });
        yield { media, pageUrl: site.siteUrl, alt: `Logo of the ${site.name}`, credit };
      } catch (e) {
        yield { error: `${c.via}: ${(e as Error).message.slice(0, 160)}` };
      }
    }
  }
  const r = await settle(ctx, kind, site.key, "logo", site.name, attempts());
  if (r.status !== "stored" && notes.length) r.reason = [r.reason, ...notes].filter(Boolean).join("; ").slice(0, 600);
  return r;
}

type Job = { kind: VisualKind; key: string; run: (ctx: Ctx) => Promise<VisualItemReport> };

function jobs(input: RunVisualsInput): { jobs: Job[]; unknown: VisualItemReport[] } {
  const kinds = new Set(input.kinds?.length ? input.kinds : VISUAL_KINDS_ALL);
  const want = input.keys?.length ? new Set(input.keys) : null;
  const out: Job[] = [];
  for (const t of commonsTargets()) if (kinds.has(t.kind) && (!want || want.has(t.key))) out.push({ kind: t.kind, key: t.key, run: (ctx) => commonsItem(ctx, t) });
  if (kinds.has("regulator_logo")) {
    for (const s of REGULATOR_SITES) if (!want || want.has(s.key)) out.push({ kind: "regulator_logo", key: s.key, run: (ctx) => logoItem(ctx, s) });
  }
  const unknown: VisualItemReport[] = [];
  if (want) {
    for (const k of want) {
      if (out.some((j) => j.key === k)) continue;
      const kind: VisualKind = courtById(k) ? "court_building" : cityById(k) ? "city" : "regulator_logo";
      const reason = REGULATORS_WITHOUT_LOGO[k] ?? (courtById(k) || cityById(k) || regulatorSite(k) ? "Not in the requested kinds" : "Not a registered court, city or regulator key");
      unknown.push({ kind, key: k, status: "skipped", reason });
    }
  }
  return { jobs: out, unknown };
}

function defaultScrapeBranding(): NonNullable<VisualsDeps["scrapeBranding"]> {
  const fc = createFirecrawl();
  return async (url) => {
    if (!fc.configured) return null;
    const p = await fc.scrapeRich(url, { markdown: false, branding: true, onlyMainContent: false });
    return { logo: p.logo, image: p.image ?? null };
  };
}

/** Run the campaign (bounded by `deadlineMs`, default 240 s). Idempotent and resumable: shown keys are skipped unless `refresh`. */
export async function runVisuals(input: RunVisualsInput, deps: VisualsDeps = {}): Promise<VisualsReport> {
  const store = deps.store === undefined ? remoteStore() : deps.store;
  if (!store) throw new VisualsNotConfiguredError();
  await ensureVisualsSchema(store);
  const now = deps.now ?? (() => new Date());
  const ctx: Ctx = {
    store,
    refresh: input.refresh === true,
    searchCommons: deps.searchCommons ?? ((q) => searchCommons(q)),
    storeImage: deps.storeImage ?? ((url, meta) => storeImageFromUrl(url, meta, { store })),
    storeBytes: deps.storeBytes ?? ((bytes, type, src, meta) => storeImageBytes(bytes, type, src, meta, { store })),
    fetchBytes: deps.fetchBytes ?? ((url, accept) => fetchPublic(url, accept)),
    scrapeBranding: deps.scrapeBranding ?? defaultScrapeBranding(),
    rasterise: deps.rasterise ?? ((svg) => rasteriseSvg(svg)),
    classify: deps.classify ?? defaultClassifyVisual,
    dominant: deps.dominant ?? dominantColour,
    now,
    maxTries: Math.max(1, Math.min(deps.maxTries ?? 3, 6)),
  };
  const deadline = Date.now() + (deps.deadlineMs ?? 240_000);
  const startedAt = now().toISOString();
  const { jobs: list, unknown } = jobs(input);
  const results = new Map<Job, VisualItemReport>();
  let i = 0;
  let cut = false;
  await Promise.all(Array.from({ length: Math.min(Math.max(1, deps.concurrency ?? 3), list.length || 1) }, async () => {
    while (i < list.length) {
      if (Date.now() > deadline) { cut = true; return; }
      const j = list[i++];
      let r: VisualItemReport;
      try {
        r = !ctx.refresh && (await hasShown(ctx, j.kind, j.key)) ? { kind: j.kind, key: j.key, status: "skipped", reason: "already stored (pass refresh: true to replace)" } : await j.run(ctx);
      } catch (e) {
        r = { kind: j.kind, key: j.key, status: "failed", reason: (e as Error).message.slice(0, 300) };
      }
      results.set(j, r);
    }
  }));
  const items = [...unknown, ...list.filter((j) => results.has(j)).map((j) => results.get(j)!)];
  const remaining = list.filter((j) => !results.has(j)).map((j) => ({ kind: j.kind, key: j.key }));
  const counts = { stored: 0, rejected: 0, skipped: 0, failed: 0 };
  for (const it of items) counts[it.status]++;
  const report: VisualsReport = { target: "visuals", startedAt, finishedAt: now().toISOString(), stop: cut || remaining.length ? "deadline" : "done", refresh: ctx.refresh, items, counts, remaining };
  try {
    await store.query({ query: `INSERT INTO enrichment_state (key, value, updated_at) VALUES ('visuals_last_run', $1::jsonb, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, params: [JSON.stringify(report)] });
  } catch { /* the report is still returned */ }
  console.info(JSON.stringify({ level: "info", event: "enrichment.visuals", stop: report.stop, counts, remaining: remaining.length, items: items.map((x) => ({ k: x.kind, key: x.key, s: x.status })) }));
  return report;
}
