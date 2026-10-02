import "server-only";
import type { RemoteStore, SqlQuery } from "@/lib/db/remote";
import { ensureMediaSchema } from "@/modules/media/store";

/**
 * Judge and court identity tables (Postgres).
 *
 * - `judges`: one row per judge per court roster. `id` is `<court id>--<normalized-name slug>`; `name` is as the
 *   official roster printed it (honorifics removed), `printed_name` verbatim. Dates are as printed; absent = null.
 *   `status` is "sitting" while the official roster lists the judge, "off_roster" once a later complete roster read
 *   no longer lists them (transfer, elevation or retirement: the roster does not say which), "former" only when an
 *   official former-judges page says so.
 * - `court_assets`: one emblem/logo (and optionally a building image) per court, each a vision-checked media asset;
 *   `hidden` marks one withdrawn by the State Emblem re-audit (never served).
 * - `enrichment_state`: last run report.
 */
export const JUDGES_SCHEMA: SqlQuery[] = [
  {
    query: `CREATE TABLE IF NOT EXISTS judges (
      id text PRIMARY KEY,
      court_id text NOT NULL,
      bench_id text,
      name text NOT NULL,
      printed_name text NOT NULL,
      name_normalized text NOT NULL,
      designation text,
      date_of_appointment date,
      retirement_date date,
      term_expires date,
      parent_high_court text,
      profile_url text,
      photo_media_id text,
      photo_source_url text,
      photo_vision jsonb,
      source_url text NOT NULL,
      source_title text,
      status text NOT NULL DEFAULT 'sitting',
      checked_at timestamptz NOT NULL DEFAULT now(),
      first_seen_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`,
  },
  { query: `CREATE UNIQUE INDEX IF NOT EXISTS judges_court_name ON judges (court_id, name_normalized)` },
  {
    query: `CREATE TABLE IF NOT EXISTS court_assets (
      court_id text NOT NULL,
      kind text NOT NULL,
      media_id text NOT NULL,
      source_url text NOT NULL,
      page_url text,
      checked_at timestamptz NOT NULL DEFAULT now(),
      vision jsonb,
      PRIMARY KEY (court_id, kind)
    )`,
  },
  { query: `CREATE TABLE IF NOT EXISTS enrichment_state (key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())` },
  // Emblem re-audit (State Emblem policy): a hidden identity image is never served by /api/courts/emblems.
  { query: `ALTER TABLE court_assets ADD COLUMN IF NOT EXISTS hidden boolean NOT NULL DEFAULT false` },
];

const ready = new WeakSet<RemoteStore>();

export async function ensureJudgesSchema(store: RemoteStore): Promise<void> {
  if (ready.has(store)) return;
  // One probe on a warm database; the DDL (all IF NOT EXISTS) runs only when a table is missing.
  const probe = await store.query({
    query: `SELECT to_regclass('public.judges') AS a, to_regclass('public.court_assets') AS b, to_regclass('public.enrichment_state') AS c, to_regclass('public.media_assets') AS d,
              (SELECT 'y' FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'court_assets' AND column_name = 'hidden') AS e,
              (SELECT 'y' FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'media_assets' AND column_name = 'dominant') AS f`,
  });
  const p = probe[0];
  if (!(p?.a && p?.b && p?.c && p?.d && p?.e && p?.f)) {
    await ensureMediaSchema(store);
    for (const q of JUDGES_SCHEMA) await store.query(q);
  }
  ready.add(store);
}

export class JudgesNotConfiguredError extends Error {
  readonly code = "judges_not_configured";
  constructor() {
    super("Judges and court identity live in Postgres; this deployment has no database (DATABASE_URL is not set).");
    this.name = "JudgesNotConfiguredError";
  }
}
