import "server-only";
import { createHash } from "node:crypto";
import { fromBytea, remoteStore, type RemoteStore, type SqlQuery } from "@/lib/db/remote";
import { safeFetch, type EgressPolicy, type SafeFetchInit } from "@/lib/net/safe-fetch";
import { isMediaId, MAX_IMAGE_BYTES, mediaUrl, validateImage, type ImageMime } from "./validate";

/**
 * Media store: images we fetched from official sources, kept in Postgres (`media_assets`) and served by us at
 * `/api/media/<sha256>` with attribution. Identity is the SHA-256 of the bytes, so the same image fetched twice is one
 * row. Every fetch goes through `safeFetch` (HTTP/S only, private and link-local addresses refused, redirects
 * re-validated, size and time limits) and every body is validated as a raster image by its magic bytes.
 */

export const MEDIA_SCHEMA: SqlQuery[] = [
  {
    query: `CREATE TABLE IF NOT EXISTS media_assets (
      id text PRIMARY KEY,
      mime text NOT NULL,
      bytes bytea NOT NULL,
      size int NOT NULL,
      width int,
      height int,
      source_url text NOT NULL,
      page_url text,
      publisher text,
      license_note text,
      fetched_at timestamptz NOT NULL DEFAULT now(),
      vision jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    )`,
  },
];

export class MediaNotConfiguredError extends Error {
  readonly code = "media_not_configured";
  constructor() {
    super("The media store is not configured on this deployment (no DATABASE_URL).");
    this.name = "MediaNotConfiguredError";
  }
}

const ready = new WeakSet<RemoteStore>();

export async function ensureMediaSchema(store: RemoteStore): Promise<void> {
  if (ready.has(store)) return;
  for (const q of MEDIA_SCHEMA) await store.query(q);
  ready.add(store);
}

function requireStore(store?: RemoteStore | null): RemoteStore {
  const s = store === undefined ? remoteStore() : store;
  if (!s) throw new MediaNotConfiguredError();
  return s;
}

export interface MediaMeta {
  /** The official page the image was found on. */
  pageUrl?: string | null;
  publisher?: string | null;
  licenseNote?: string | null;
}

export interface VisionVerdict {
  ok: boolean;
  kind: string;
  reason: string;
  alt: string | null;
  checkedAt?: string;
  model?: string | null;
}

export interface StoredMedia {
  id: string;
  url: string;
  mime: ImageMime;
  size: number;
  width: number | null;
  height: number | null;
  /** True when the bytes were already stored (same SHA-256). */
  existed: boolean;
  /** The data the vision check can read without another network fetch. */
  dataUrl: string;
}

export interface MediaDeps {
  store?: RemoteStore | null;
  fetchImpl?: SafeFetchInit["fetchImpl"];
  egress?: EgressPolicy;
  signal?: AbortSignal;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function toDataUrl(mime: string, bytes: Uint8Array): string {
  return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
}

/** Store validated image bytes (idempotent by content hash). */
export async function storeImageBytes(bytes: Uint8Array, declaredType: string | null, sourceUrl: string, meta: MediaMeta = {}, deps: MediaDeps = {}): Promise<StoredMedia> {
  const sniffed = validateImage(bytes, declaredType);
  const store = requireStore(deps.store);
  await ensureMediaSchema(store);
  const id = sha256Hex(bytes);
  const rows = await store.query({
    query: `INSERT INTO media_assets (id, mime, bytes, size, width, height, source_url, page_url, publisher, license_note, fetched_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
            ON CONFLICT (id) DO UPDATE SET fetched_at = now(), source_url = EXCLUDED.source_url, page_url = COALESCE(EXCLUDED.page_url, media_assets.page_url),
              publisher = COALESCE(EXCLUDED.publisher, media_assets.publisher), license_note = COALESCE(EXCLUDED.license_note, media_assets.license_note)
            RETURNING (xmax = 0) AS inserted`,
    params: [id, sniffed.mime, bytes, bytes.byteLength, sniffed.width, sniffed.height, sourceUrl, meta.pageUrl ?? null, meta.publisher ?? null, meta.licenseNote ?? null],
  });
  const inserted = rows[0]?.inserted;
  return { id, url: mediaUrl(id), mime: sniffed.mime, size: bytes.byteLength, width: sniffed.width, height: sniffed.height, existed: inserted === "f" || inserted === "false", dataUrl: toDataUrl(sniffed.mime, bytes) };
}

/** Download an image from an official page (SSRF-safe) and store it. Throws SafeFetchError / MediaValidationError. */
export async function storeImageFromUrl(url: string, meta: MediaMeta = {}, deps: MediaDeps = {}): Promise<StoredMedia> {
  const res = await safeFetch(url, { headers: { accept: "image/png,image/jpeg,image/gif,image/webp;q=0.9,*/*;q=0.1", "user-agent": "LeClaude-Enrichment/1.0 (+court and judge identity; attribution kept)" }, signal: deps.signal, fetchImpl: deps.fetchImpl }, {
    name: "media",
    maxBytes: MAX_IMAGE_BYTES,
    timeoutMs: 20_000,
    maxRedirects: 3,
    ...deps.egress,
  });
  if (!res.ok) throw new Error(`Image request failed with HTTP ${res.status}`);
  return storeImageBytes(res.body, res.contentType || null, res.finalUrl || url, meta, deps);
}

export async function setMediaVision(id: string, vision: VisionVerdict, deps: { store?: RemoteStore | null } = {}): Promise<void> {
  const store = requireStore(deps.store);
  await store.query({ query: `UPDATE media_assets SET vision = $2::jsonb WHERE id = $1`, params: [id, JSON.stringify(vision)] });
}

export interface MediaRecord {
  id: string;
  mime: string;
  bytes: Uint8Array;
  size: number;
  width: number | null;
  height: number | null;
  sourceUrl: string;
  pageUrl: string | null;
  publisher: string | null;
  licenseNote: string | null;
  fetchedAt: string | null;
  vision: VisionVerdict | null;
}

/** One stored image, or null. Ids that are not a SHA-256 never reach the database. */
export async function getMedia(id: string, deps: { store?: RemoteStore | null } = {}): Promise<MediaRecord | null> {
  if (!isMediaId(id)) return null;
  const store = requireStore(deps.store);
  await ensureMediaSchema(store);
  const rows = await store.query({ query: `SELECT id, mime, bytes, size, width, height, source_url, page_url, publisher, license_note, fetched_at::text AS fetched_at, vision FROM media_assets WHERE id = $1`, params: [id] });
  const r = rows[0];
  if (!r) return null;
  const bytes = fromBytea(r.bytes);
  if (!bytes) return null;
  let vision: VisionVerdict | null = null;
  try { vision = r.vision ? (JSON.parse(r.vision) as VisionVerdict) : null; } catch { vision = null; }
  return {
    id: r.id!, mime: r.mime!, bytes, size: Number(r.size), width: r.width ? Number(r.width) : null, height: r.height ? Number(r.height) : null,
    sourceUrl: r.source_url!, pageUrl: r.page_url, publisher: r.publisher, licenseNote: r.license_note, fetchedAt: r.fetched_at, vision,
  };
}
