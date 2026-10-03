import "server-only";
import { createHash } from "node:crypto";
import type { RemoteStore, Row, SqlQuery } from "@/lib/db/remote";
import { normActTitle } from "@/modules/law/reader";
import { createIndiaCode, mdValue, parseActItem, parseSectionItem, type DspaceItem, type IndiaCodeClient } from "@/modules/india/sources/india-code";
import { parseSectionFootnotes, type SectionAmendment } from "./amendments";

/**
 * India Code (official) section text and amendment history, linked to the statutes collection (Open India Law).
 *
 * Source: the India Code DSpace REST API (indiacode.gov.in/server/api, read-only public JSON; no login, no CAPTCHA;
 * robots.txt answered HTTP 500 on 2026-10-02, so there is no published crawl rule to follow — requests stay at 2 per
 * second). Each statutes-collection Central Act whose India Code handle is known is a work item in `law_official_acts`
 * (highest priority: the six criminal codes and the key Central Acts). For each, the loader resolves the India Code Act
 * EXACTLY — by its handle, else by a unique Central ACT item with the same normalised title and year — then stores
 * every SECTION item with its text and parsed footnotes (`law_official_sections`). An Act that cannot be resolved
 * exactly is left unlinked with the reason; nothing is matched by similarity.
 */

export const OFFICIAL_SECTIONS_SCHEMA: SqlQuery[] = [
  {
    query: `CREATE TABLE IF NOT EXISTS law_official_acts (
      law_instrument_id text PRIMARY KEY,
      title text NOT NULL,
      year int,
      handle text,
      priority int NOT NULL DEFAULT 1,
      status text NOT NULL DEFAULT 'pending',
      ic_act_id text,
      ic_handle text,
      link_method text,
      reason text,
      sections_declared int,
      sections_stored int NOT NULL DEFAULT 0,
      attempts int NOT NULL DEFAULT 0,
      fetched_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT law_official_acts_status CHECK (status IN ('pending', 'done', 'unlinked', 'failed'))
    )`,
  },
  { query: `CREATE INDEX IF NOT EXISTS law_official_acts_queue ON law_official_acts (status, priority, law_instrument_id)` },
  {
    query: `CREATE TABLE IF NOT EXISTS law_official_sections (
      law_instrument_id text NOT NULL,
      section text NOT NULL,
      ic_act_id text NOT NULL,
      ord int,
      heading text,
      text text NOT NULL,
      amendments jsonb NOT NULL DEFAULT '[]',
      amendment_count int NOT NULL DEFAULT 0,
      ic_handle text,
      ic_url text,
      ic_last_modified text,
      content_sha256 text NOT NULL,
      fetched_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (law_instrument_id, section)
    )`,
  },
];

let ready = false;
export function resetOfficialSectionsSchemaForTests() { ready = false; }

export async function ensureOfficialSectionsSchema(store: RemoteStore): Promise<void> {
  if (ready) return;
  for (const q of OFFICIAL_SECTIONS_SCHEMA) await store.query(q);
  ready = true;
}

/** "https://www.indiacode.nic.in/handle/123456789/20062?view_type=…" → "123456789/20062". */
export function handleFromUrl(url: string | null | undefined): string | null {
  const m = /\/handle\/(\d+\/\d+)(?:[/?#]|$)/.exec(url ?? "");
  return m ? m[1] : null;
}

export type ActResolution = { ok: true; item: DspaceItem; method: "handle" | "title_year" } | { ok: false; reason: string };

/** Exact choice among India Code ACT items for an instrument: same normalised title, same year, Central. */
export function chooseExactAct(title: string, year: number | null, items: DspaceItem[]): ActResolution {
  const want = normActTitle(title);
  const hits = items.filter((it) => {
    const md = it.metadata;
    if (mdValue(md, "dc.identifier.collection") !== "ACT") return false;
    if (!/^central$/i.test(mdValue(md, "dc.identifier.state_name") ?? "")) return false;
    const t = normActTitle(mdValue(md, "dc.title") ?? "");
    const y = Number(mdValue(md, "dc.date.act_year"));
    return t === want && (year == null || y === year);
  });
  if (hits.length === 1) return { ok: true, item: hits[0], method: "title_year" };
  if (hits.length > 1) return { ok: false, reason: `${hits.length} Central India Code Acts have the title "${title}"${year ? ` and year ${year}` : ""}; none chosen` };
  return { ok: false, reason: `no Central India Code Act titled "${title}"${year ? ` of ${year}` : ""}` };
}

export interface OfficialSectionRow {
  section: string;
  ord: number | null;
  heading: string | null;
  text: string;
  amendments: SectionAmendment[];
  handle: string | null;
  url: string | null;
  lastModified: string | null;
  sha256: string;
}

/** SECTION item → stored row (null for items that are not sections or have no number). */
export function officialSectionRow(item: DspaceItem): OfficialSectionRow | null {
  const s = parseSectionItem(item);
  if (!s) return null;
  const footnotes = item.metadata["dc.identifier.section_footnote"]?.[0]?.value ?? null;
  const amendments = parseSectionFootnotes(footnotes);
  const sha256 = createHash("sha256").update(JSON.stringify([s.number, s.heading ?? null, s.text, footnotes])).digest("hex");
  return { section: s.number, ord: s.order ?? null, heading: s.heading ?? null, text: s.text, amendments, handle: s.handle ?? null, url: s.url ?? null, lastModified: item.lastModified ?? null, sha256 };
}

const PRIORITY_TITLES = [
  "Indian Penal Code, 1860", "Bharatiya Nyaya Sanhita, 2023", "Code of Criminal Procedure, 1973", "Bharatiya Nagarik Suraksha Sanhita, 2023",
  "Indian Evidence Act, 1872", "Bharatiya Sakshya Adhiniyam, 2023", "Code of Civil Procedure, 1908", "Indian Contract Act, 1872", "Specific Relief Act, 1963",
  "Limitation Act, 1963", "Arbitration and Conciliation Act, 1996", "Negotiable Instruments Act, 1881", "Companies Act, 2013", "Insolvency and Bankruptcy Code, 2016",
  "Transfer of Property Act, 1882", "Consumer Protection Act, 2019", "Information Technology Act, 2000", "Commercial Courts Act, 2015",
];

/** Queue every Central instrument of the statutes collection (idempotent; existing rows keep their state). */
export async function seedOfficialActs(store: RemoteStore): Promise<number> {
  const keys = PRIORITY_TITLES.map(normActTitle);
  const r = await store.query({
    query: `WITH ins AS (
      INSERT INTO law_official_acts (law_instrument_id, title, year, handle, priority)
      SELECT i.id, i.title, i.year, substring(i.source_url from '/handle/([0-9]+/[0-9]+)'),
        CASE WHEN trim(both ' ' from regexp_replace(regexp_replace(lower(i.title), '^\\s*the\\s+', ''), '[^a-z0-9]+', ' ', 'g')) = ANY($1::text[]) THEN 0 ELSE 1 END
      FROM law_instruments i WHERE i.jurisdiction = 'central' AND i.kind = 'act'
      ON CONFLICT (law_instrument_id) DO NOTHING RETURNING 1)
      SELECT count(*)::int AS n FROM ins`,
    params: [`{${keys.map((k) => `"${k}"`).join(",")}}`],
  });
  return Number(r[0]?.n ?? 0);
}

export interface OfficialSectionsRunResult {
  acts: { id: string; status: string; sections: number; reason?: string }[];
  seeded: number;
  stop: "deadline" | "queue_empty" | "limit";
}

export async function resolveAct(client: IndiaCodeClient, row: Row, signal?: AbortSignal): Promise<ActResolution> {
  const year = row.year == null ? null : Number(row.year);
  const title = String(row.title);
  if (row.handle) {
    try {
      const item = await client.getByHandle(String(row.handle), signal);
      if (chooseExactAct(title, year, [item]).ok) return { ok: true, item, method: "handle" };
    } catch (error) { if (signal?.aborted) throw error; }
  }
  const query = '"' + title.replace(/"/g, '') + '" AND (' + client.jurisdictionQuery('central') + ')';
  const candidates = new Map<string, DspaceItem>();
  for (let page = 0; page < 20; page++) {
    signal?.throwIfAborted();
    const result = await client.searchActs({ query, page, size: 100, signal });
    for (const item of result.items) candidates.set(item.id, item);
    if (page + 1 >= result.page.totalPages) return chooseExactAct(title, year, [...candidates.values()]);
  }
  // Never call a partially searched result set unique, or label an unseen exact match missing.
  throw new Error('India Code exact-match search exceeded its bounded page window; reconciliation incomplete');
}

/** Process queued Acts until the deadline (or `limit` Acts). Idempotent: an Act's sections are replaced as a whole. */
export async function runOfficialSectionsLoad(o: { store: RemoteStore; deadlineMs: number; limit?: number; client?: IndiaCodeClient; now?: () => number; signal?: AbortSignal }): Promise<OfficialSectionsRunResult> {
  const now = o.now ?? Date.now;
  const deadline = now() + o.deadlineMs;
  const client = o.client ?? createIndiaCode();
  await ensureOfficialSectionsSchema(o.store);
  const seeded = await seedOfficialActs(o.store);
  const acts: OfficialSectionsRunResult["acts"] = [];
  while (now() < deadline - 5_000) {
    if (o.limit && acts.length >= o.limit) return { acts, seeded, stop: "limit" };
    const [row] = await o.store.query({ query: `UPDATE law_official_acts SET attempts = attempts + 1, updated_at = now() WHERE law_instrument_id = (SELECT law_instrument_id FROM law_official_acts WHERE status = 'pending' OR (status = 'failed' AND attempts < 3) ORDER BY priority, law_instrument_id LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *` });
    if (!row) return { acts, seeded, stop: "queue_empty" };
    const id = String(row.law_instrument_id);
    try {
      const res = await resolveAct(client, row, o.signal);
      if (!res.ok) {
        await o.store.query({ query: `UPDATE law_official_acts SET status = 'unlinked', reason = $2, updated_at = now() WHERE law_instrument_id = $1`, params: [id, res.reason] });
        acts.push({ id, status: "unlinked", sections: 0, reason: res.reason });
        continue;
      }
      const act = parseActItem(res.item);
      if (!act.actId) throw new Error("India Code Act item has no act_id");
      const rows: OfficialSectionRow[] = [];
      let declared = 0;
      for (let page = 0; page < 40; page++) {
        const p = await client.sections(act.actId, { page, size: 100, signal: o.signal });
        declared = p.page.totalElements;
        for (const it of p.items) {
          // A section item belongs to this Act only when it carries the same act_id (the search is a phrase query).
          if (mdValue(it.metadata, "dc.identifier.act_id") !== act.actId) continue;
          const r = officialSectionRow(it);
          if (r) rows.push(r);
        }
        if (page + 1 >= p.page.totalPages) break;
      }
      const unique = new Map<string, OfficialSectionRow>();
      for (const r of rows) if (!unique.has(r.section)) unique.set(r.section, r);
      const payload = [...unique.values()].map((r) => ({ law_instrument_id: id, section: r.section, ic_act_id: act.actId, ord: r.ord, heading: r.heading, text: r.text, amendments: r.amendments, amendment_count: r.amendments.length, ic_handle: r.handle, ic_url: r.url, ic_last_modified: r.lastModified, content_sha256: r.sha256 }));
      await o.store.transaction([
        { query: `DELETE FROM law_official_sections WHERE law_instrument_id = $1`, params: [id] },
        {
          query: `INSERT INTO law_official_sections (law_instrument_id, section, ic_act_id, ord, heading, text, amendments, amendment_count, ic_handle, ic_url, ic_last_modified, content_sha256)
            SELECT law_instrument_id, section, ic_act_id, ord, heading, text, amendments, amendment_count, ic_handle, ic_url, ic_last_modified, content_sha256
            FROM jsonb_to_recordset($1::jsonb) AS x(law_instrument_id text, section text, ic_act_id text, ord int, heading text, text text, amendments jsonb, amendment_count int, ic_handle text, ic_url text, ic_last_modified text, content_sha256 text)`,
          params: [JSON.stringify(payload)],
        },
        {
          query: `UPDATE law_official_acts SET status = 'done', ic_act_id = $2, ic_handle = $3, link_method = $4, reason = $5, sections_declared = $6, sections_stored = $7, fetched_at = now(), updated_at = now() WHERE law_instrument_id = $1`,
          params: [id, act.actId, res.item.handle ?? null, res.method, payload.length < declared ? `${declared - payload.length} section item(s) were not stored (other Acts' items in the phrase search, duplicates or unnumbered)` : null, declared, payload.length],
        },
      ]);
      acts.push({ id, status: "done", sections: payload.length });
    } catch (e) {
      const msg = (e as Error).message.slice(0, 300);
      await o.store.query({ query: `UPDATE law_official_acts SET status = 'failed', reason = $2, updated_at = now() WHERE law_instrument_id = $1`, params: [id, msg] });
      acts.push({ id, status: "failed", sections: 0, reason: msg });
    }
  }
  return { acts, seeded, stop: "deadline" };
}

export interface OfficialSectionView {
  lawInstrumentId: string;
  section: string;
  heading: string | null;
  amendments: SectionAmendment[];
  icUrl: string | null;
  icActId: string;
  linkMethod: string | null;
  fetchedAt: string | null;
}

export type OfficialSectionLookup =
  | { state: "not_loaded" }
  | { state: "act_pending" | "act_unlinked" | "act_failed"; reason: string | null }
  | { state: "no_section" }
  | { state: "found"; section: OfficialSectionView };

/** The official section for (instrument, section), with an explicit state when it is not available. */
export async function officialSection(store: RemoteStore, lawInstrumentId: string, section: string): Promise<OfficialSectionLookup> {
  const t = await store.query({ query: `SELECT to_regclass('public.law_official_acts') IS NOT NULL AS a, to_regclass('public.law_official_sections') IS NOT NULL AS s` });
  if (!(String(t[0]?.a) === "true" || String(t[0]?.a) === "t")) return { state: "not_loaded" };
  const [act] = await store.query({ query: `SELECT status, reason, link_method, fetched_at::text AS fetched_at FROM law_official_acts WHERE law_instrument_id = $1`, params: [lawInstrumentId] });
  if (!act) return { state: "not_loaded" };
  if (act.status !== "done") return { state: act.status === "unlinked" ? "act_unlinked" : act.status === "failed" ? "act_failed" : "act_pending", reason: act.reason ?? null };
  const [s] = await store.query({ query: `SELECT section, heading, amendments::text AS amendments, ic_url, ic_act_id FROM law_official_sections WHERE law_instrument_id = $1 AND section = $2`, params: [lawInstrumentId, section] });
  if (!s) return { state: "no_section" };
  let amendments: SectionAmendment[] = [];
  try { amendments = JSON.parse(s.amendments ?? "[]") as SectionAmendment[]; } catch { amendments = []; }
  return { state: "found", section: { lawInstrumentId, section: String(s.section), heading: s.heading ?? null, amendments, icUrl: s.ic_url ?? null, icActId: String(s.ic_act_id), linkMethod: act.link_method ?? null, fetchedAt: act.fetched_at ?? null } };
}
