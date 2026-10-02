import "server-only";
import { createHash } from "node:crypto";
import type { RemoteStore, SqlQuery } from "@/lib/db/remote";
import { ensureCorpusSchema, getState, setState } from "@/modules/india/corpus/backfill";
import { readTar } from "@/modules/india/corpus/tar";
import { createOpenDataBucket, SCI_BUCKET_URL, type OpenDataBucket } from "@/modules/india/sources/s3";
import type { SciMetadataJson } from "@/modules/india/sources/sci";
import { canonicalInsc, caseNumberKey, decideScrLink, scrFromSciCard, scrYearOrder, type ScrRecord } from "./link";

/**
 * SCR register loader (server-only).
 *
 * Source of record: the Supreme Court Reports portal (scr.sci.gov.in, which absorbed digiscr.sci.gov.in; the old host
 * no longer resolves). Every search on the portal is behind a CAPTCHA (securimage), which is never bypassed, so the
 * loader reads the portal's own result cards as preserved by the public AWS Open Data mirror
 * (indian-supreme-court-judgments, metadata/tar/year=YYYY/*.tar: one JSON per reported judgment whose `raw_html` is the
 * portal card). Years are processed newest first, the last ten years before older ones (`scrYearOrder`).
 *
 * Each card with an SCR citation becomes one `scr_reports` row (full official headnote, SCR and INSC citations, case
 * number, decision date, source key + SHA-256) and is linked to `corpus_judgments` by exact identifiers only
 * (`decideScrLink`); unmatched and ambiguous records stay unlinked with the reason. Idempotent (upsert by SCR citation;
 * links recomputed on every load of the record). Progress lives in corpus_state under `scr_loader`.
 */

export const SCR_SCHEMA: SqlQuery[] = [
  {
    query: `CREATE TABLE IF NOT EXISTS scr_reports (
      id text PRIMARY KEY,
      scr_year int NOT NULL,
      scr_volume int,
      scr_supplement boolean NOT NULL DEFAULT false,
      scr_page int NOT NULL,
      scr_raw text NOT NULL,
      neutral_citation text,
      case_number text,
      case_key text,
      decision_date date,
      title text NOT NULL,
      headnote text,
      origin text NOT NULL,
      source_key text NOT NULL,
      source_sha256 text NOT NULL,
      judgment_id text,
      link_status text NOT NULL,
      link_method text,
      link_candidates text[],
      link_reason text,
      linked_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT scr_reports_link_status CHECK (link_status IN ('linked', 'ambiguous', 'unlinked'))
    )`,
  },
  { query: `CREATE INDEX IF NOT EXISTS scr_reports_judgment ON scr_reports (judgment_id) WHERE judgment_id IS NOT NULL` },
  { query: `CREATE INDEX IF NOT EXISTS scr_reports_neutral ON scr_reports (neutral_citation) WHERE neutral_citation IS NOT NULL` },
  { query: `CREATE INDEX IF NOT EXISTS scr_reports_status ON scr_reports (link_status, scr_year)` },
  // Exact case-number lookups on the corpus side (same key expression as caseNumberKey).
  { query: `CREATE INDEX IF NOT EXISTS corpus_judgments_case_key ON corpus_judgments ((upper(regexp_replace(case_number, '[^A-Za-z0-9]', '', 'g'))), decision_date) WHERE court_id = 'sci' AND case_number IS NOT NULL` },
];

let ready = false;
export function resetScrSchemaForTests() { ready = false; }

export async function ensureScrSchema(store: RemoteStore): Promise<void> {
  if (ready) return;
  await ensureCorpusSchema(store);
  for (const q of SCR_SCHEMA) await store.query(q);
  ready = true;
}

interface ScrLoaderState { years: number[]; yearIdx: number; archives: string[] | null; archiveIdx: number; entry: number; pass: number }

export interface ScrRunResult {
  stored: number;
  linked: number;
  ambiguous: number;
  unlinked: number;
  skipped: { reason: string; count: number }[];
  position: { year: number | null; archive: string | null; entry: number };
  stop: "deadline" | "pass_complete";
}

/** Link a batch of records against corpus_judgments (two bounded queries) and return the decisions by record id. */
export async function linkScrBatch(store: RemoteStore, records: ScrRecord[]): Promise<Map<string, ReturnType<typeof decideScrLink>>> {
  const neutrals = [...new Set(records.map((r) => r.neutral).filter((x): x is string => Boolean(x)))];
  const keys = [...new Set(records.map((r) => (r.decisionDate ? `${caseNumberKey(r.caseNumber)}|${r.decisionDate}` : null)).filter((x): x is string => Boolean(x) && !x!.startsWith("null|")))];
  const byNeutral = new Map<string, string[]>();
  const byCase = new Map<string, string[]>();
  if (neutrals.length) {
    const rows = await store.query({ query: `SELECT id, neutral_citation FROM corpus_judgments WHERE court_id = 'sci' AND neutral_citation = ANY($1::text[])`, params: [`{${neutrals.map((n) => `"${n}"`).join(",")}}`] });
    for (const r of rows) {
      const k = canonicalInsc(r.neutral_citation);
      if (k) byNeutral.set(k, [...(byNeutral.get(k) ?? []), String(r.id)]);
    }
  }
  if (keys.length) {
    const rows = await store.query({
      query: `SELECT id, upper(regexp_replace(case_number, '[^A-Za-z0-9]', '', 'g')) || '|' || decision_date::text AS k FROM corpus_judgments
        WHERE court_id = 'sci' AND case_number IS NOT NULL AND (upper(regexp_replace(case_number, '[^A-Za-z0-9]', '', 'g')) || '|' || decision_date::text) = ANY($1::text[])`,
      params: [`{${keys.map((k) => `"${k.replace(/"/g, "")}"`).join(",")}}`],
    });
    for (const r of rows) byCase.set(String(r.k), [...(byCase.get(String(r.k)) ?? []), String(r.id)]);
  }
  const out = new Map<string, ReturnType<typeof decideScrLink>>();
  for (const rec of records) {
    const ck = rec.decisionDate ? `${caseNumberKey(rec.caseNumber)}|${rec.decisionDate}` : "";
    out.set(rec.id, decideScrLink(rec, { byNeutral: rec.neutral ? byNeutral.get(rec.neutral) ?? [] : [], byCaseAndDate: byCase.get(ck) ?? [] }));
  }
  return out;
}

const UPSERT = `INSERT INTO scr_reports (id, scr_year, scr_volume, scr_supplement, scr_page, scr_raw, neutral_citation, case_number, case_key, decision_date, title, headnote, origin, source_key, source_sha256, judgment_id, link_status, link_method, link_candidates, link_reason, linked_at)
  SELECT id, scr_year, scr_volume, scr_supplement, scr_page, scr_raw, neutral_citation, case_number, case_key, decision_date, title, headnote, origin, source_key, source_sha256, judgment_id, link_status, link_method, link_candidates, link_reason, now()
  FROM jsonb_to_recordset($1::jsonb) AS x(id text, scr_year int, scr_volume int, scr_supplement boolean, scr_page int, scr_raw text, neutral_citation text, case_number text, case_key text, decision_date date, title text, headnote text, origin text, source_key text, source_sha256 text, judgment_id text, link_status text, link_method text, link_candidates text[], link_reason text)
  ON CONFLICT (id) DO UPDATE SET scr_year = EXCLUDED.scr_year, scr_volume = EXCLUDED.scr_volume, scr_supplement = EXCLUDED.scr_supplement, scr_page = EXCLUDED.scr_page, scr_raw = EXCLUDED.scr_raw,
    neutral_citation = EXCLUDED.neutral_citation, case_number = EXCLUDED.case_number, case_key = EXCLUDED.case_key, decision_date = EXCLUDED.decision_date, title = EXCLUDED.title, headnote = EXCLUDED.headnote,
    origin = EXCLUDED.origin, source_key = EXCLUDED.source_key, source_sha256 = EXCLUDED.source_sha256, judgment_id = EXCLUDED.judgment_id, link_status = EXCLUDED.link_status, link_method = EXCLUDED.link_method,
    link_candidates = EXCLUDED.link_candidates, link_reason = EXCLUDED.link_reason, linked_at = now(), updated_at = now()`;

/** Store records and their exact-link decisions (one statement). Returns counts by link status. */
export async function storeScrRecords(store: RemoteStore, records: ScrRecord[]): Promise<{ linked: number; ambiguous: number; unlinked: number }> {
  // Two cards with the same SCR citation: the first is kept, the duplicate is reported by the caller.
  const uniq = [...new Map(records.map((r) => [r.id, r])).values()];
  const links = await linkScrBatch(store, uniq);
  const rows = uniq.map((r) => {
    const l = links.get(r.id)!;
    return {
      id: r.id, scr_year: r.scr.year, scr_volume: r.scr.volume, scr_supplement: r.scr.supplement, scr_page: r.scr.page, scr_raw: r.scr.raw,
      neutral_citation: r.neutral, case_number: r.caseNumber, case_key: caseNumberKey(r.caseNumber), decision_date: r.decisionDate, title: r.title, headnote: r.headnote,
      origin: r.origin, source_key: r.sourceKey, source_sha256: r.sourceSha256,
      judgment_id: l.status === "linked" ? l.judgmentId : null, link_status: l.status, link_method: l.status === "unlinked" ? null : l.method,
      link_candidates: l.status === "ambiguous" ? l.candidates : null, link_reason: l.status === "linked" ? null : l.reason,
    };
  });
  if (rows.length) await store.query({ query: UPSERT, params: [JSON.stringify(rows)] });
  const count = (s: string) => rows.filter((r) => r.link_status === s).length;
  return { linked: count("linked"), ambiguous: count("ambiguous"), unlinked: count("unlinked") };
}

const BATCH = 300;

/** Continue the SCR register load from its stored position until the deadline. */
export async function runScrLoad(o: { store: RemoteStore; deadlineMs: number; sci?: OpenDataBucket; now?: () => number; restart?: boolean; currentYear?: number }): Promise<ScrRunResult> {
  const now = o.now ?? Date.now;
  const deadline = now() + o.deadlineMs;
  const sci = o.sci ?? createOpenDataBucket("sci-open-data", SCI_BUCKET_URL, { timeoutMs: 120_000 });
  await ensureScrSchema(o.store);
  let st = o.restart ? null : await getState<ScrLoaderState>(o.store, "scr_loader");
  const res: ScrRunResult = { stored: 0, linked: 0, ambiguous: 0, unlinked: 0, skipped: [], position: { year: null, archive: null, entry: 0 }, stop: "deadline" };
  const skip = (reason: string) => { const s = res.skipped.find((x) => x.reason === reason); if (s) s.count++; else res.skipped.push({ reason, count: 1 }); };
  if (!st || st.yearIdx >= st.years.length) {
    const years = (await sci.folders("metadata/tar/")).map((p) => Number(/year=(\d{4})/.exec(p)?.[1])).filter((y) => Number.isInteger(y) && y >= 1950);
    st = { years: scrYearOrder(years, o.currentYear ?? new Date().getUTCFullYear()), yearIdx: 0, archives: null, archiveIdx: 0, entry: 0, pass: (st?.pass ?? 0) + 1 };
  }
  while (st.yearIdx < st.years.length) {
    const year = st.years[st.yearIdx];
    if (!st.archives) {
      const prefix = `metadata/tar/year=${year}/`;
      st.archives = (await sci.list(prefix)).objects.map((x) => x.key).filter((k) => /\.tar(\.gz)?$/i.test(k)).sort();
      st.archiveIdx = 0;
      st.entry = 0;
    }
    while (st.archiveIdx < st.archives.length) {
      const key = st.archives[st.archiveIdx];
      res.position = { year, archive: key, entry: st.entry };
      if (now() > deadline - 20_000) { await setState(o.store, "scr_loader", st); return res; }
      const got = await sci.getBytes(key, { maxBytes: 400 * 1024 * 1024 });
      if (got.truncated) throw new Error(`archive ${key} is larger than the read limit`);
      const entries = readTar(got.bytes).filter((e) => e.name.toLowerCase().endsWith(".json")).sort((a, b) => a.name.localeCompare(b.name));
      while (st.entry < entries.length) {
        if (now() > deadline - 10_000) { await setState(o.store, "scr_loader", st); res.position.entry = st.entry; return res; }
        const slice = entries.slice(st.entry, st.entry + BATCH);
        const records: ScrRecord[] = [];
        for (const e of slice) {
          let json: SciMetadataJson;
          try { json = JSON.parse(new TextDecoder().decode(e.data)) as SciMetadataJson; } catch { skip("invalid JSON"); continue; }
          const file = e.name.split("/").pop() ?? e.name;
          const r = scrFromSciCard(json, { key: `metadata/json/year=${year}/${file}`, sha256: createHash("sha256").update(e.data).digest("hex") });
          if (!r.ok) { skip(r.reason.startsWith("no SCR") ? "no SCR citation on the card" : r.reason.startsWith("card could not") ? "card could not be parsed" : "reporter citation is not an SCR citation"); continue; }
          records.push(r.record);
        }
        const c = await storeScrRecords(o.store, records);
        res.stored += records.length; res.linked += c.linked; res.ambiguous += c.ambiguous; res.unlinked += c.unlinked;
        st.entry += slice.length;
        await setState(o.store, "scr_loader", st);
      }
      st.archiveIdx++;
      st.entry = 0;
      await setState(o.store, "scr_loader", st);
    }
    st.yearIdx++;
    st.archives = null;
    await setState(o.store, "scr_loader", st);
  }
  res.stop = "pass_complete";
  return res;
}

export interface ScrReportView {
  id: string;
  scr: string;
  neutralCitation: string | null;
  caseNumber: string | null;
  decisionDate: string | null;
  title: string;
  headnote: string | null;
  linkStatus: "linked" | "ambiguous" | "unlinked";
  linkMethod: string | null;
  linkReason: string | null;
  sourceKey: string;
}

/** SCR reports linked to a corpus judgment (normally one). Null when the register has not been created. */
export async function scrReportsForJudgment(store: RemoteStore, judgmentId: string): Promise<ScrReportView[] | null> {
  const t = await store.query({ query: `SELECT to_regclass('public.scr_reports') IS NOT NULL AS ok` });
  if (!(String(t[0]?.ok) === "true" || String(t[0]?.ok) === "t")) return null;
  const rows = await store.query({ query: `SELECT id, scr_raw, neutral_citation, case_number, decision_date::text AS decision_date, title, headnote, link_status, link_method, link_reason, source_key FROM scr_reports WHERE judgment_id = $1 ORDER BY id LIMIT 5`, params: [judgmentId] });
  return rows.map((r) => ({ id: String(r.id), scr: String(r.scr_raw), neutralCitation: r.neutral_citation ?? null, caseNumber: r.case_number ?? null, decisionDate: r.decision_date ?? null, title: String(r.title), headnote: r.headnote ?? null, linkStatus: r.link_status as ScrReportView["linkStatus"], linkMethod: r.link_method ?? null, linkReason: r.link_reason ?? null, sourceKey: String(r.source_key) }));
}
