import "server-only";
import type { RemoteStore, SqlQuery } from "@/lib/db/remote";
import { ensureCorpusSchema, getState, setState } from "@/modules/india/corpus/backfill";
import { extractMetaSectionRefs, META_EXTRACTOR_VERSION } from "./extract";

/**
 * Statute ↔ judgment links from METADATA (server-only). Text-based links already exist: the citator writes one
 * `corpus_citations` row (kind 'statute', act_id, section) per section a judgment's full text cites. Judgments without
 * text (and every judgment's official headnote) are linked here from the metadata field the corpus holds — the SCR card
 * headnote extract (`corpus_judgments.snippet`) — into `corpus_statute_meta`. A row records the field it came from, so
 * the section page can say "from the headnote" rather than "cited in the judgment".
 *
 * Idempotent: a judgment's rows are replaced together; progress is the last judgment id scanned (corpus_state
 * `statute_meta_cursor`), and a new extractor version restarts the pass.
 */

export const STATUTE_META_SCHEMA: SqlQuery[] = [
  {
    query: `CREATE TABLE IF NOT EXISTS corpus_statute_meta (
      judgment_id text NOT NULL,
      act_id text NOT NULL,
      section text NOT NULL,
      field text NOT NULL,
      raw text NOT NULL,
      form text NOT NULL,
      extractor_version int NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (judgment_id, act_id, section)
    )`,
  },
  { query: `CREATE INDEX IF NOT EXISTS corpus_statute_meta_section ON corpus_statute_meta (act_id, section)` },
];

let ready = false;
export function resetStatuteMetaSchemaForTests() { ready = false; }

export async function ensureStatuteMetaSchema(store: RemoteStore): Promise<void> {
  if (ready) return;
  await ensureCorpusSchema(store);
  for (const q of STATUTE_META_SCHEMA) await store.query(q);
  ready = true;
}

interface Cursor { version: number; after: string; scanned: number; links: number; done: boolean }

export interface StatuteMetaRunResult { scanned: number; links: number; cursor: string; done: boolean; stop: "deadline" | "pass_complete" }

const BATCH = 1000;

export async function runStatuteMetaBuild(o: { store: RemoteStore; deadlineMs: number; restart?: boolean; now?: () => number }): Promise<StatuteMetaRunResult> {
  const now = o.now ?? Date.now;
  const deadline = now() + o.deadlineMs;
  await ensureStatuteMetaSchema(o.store);
  let c = await getState<Cursor>(o.store, "statute_meta_cursor");
  if (o.restart || !c || c.version !== META_EXTRACTOR_VERSION) c = { version: META_EXTRACTOR_VERSION, after: "", scanned: 0, links: 0, done: false };
  if (c.done) return { scanned: 0, links: 0, cursor: c.after, done: true, stop: "pass_complete" };
  let scanned = 0, links = 0;
  while (now() < deadline - 5_000) {
    const rows = await o.store.query({ query: `SELECT id, snippet FROM corpus_judgments WHERE id > $1 ORDER BY id LIMIT ${BATCH}`, params: [c.after] });
    if (!rows.length) { c.done = true; await setState(o.store, "statute_meta_cursor", c); return { scanned, links, cursor: c.after, done: true, stop: "pass_complete" }; }
    const out: { judgment_id: string; act_id: string; section: string; field: string; raw: string; form: string; extractor_version: number }[] = [];
    for (const r of rows) for (const ref of extractMetaSectionRefs(r.snippet)) out.push({ judgment_id: String(r.id), act_id: ref.actId, section: ref.section, field: "headnote", raw: ref.raw.slice(0, 300), form: ref.form, extractor_version: META_EXTRACTOR_VERSION });
    const ids = rows.map((r) => String(r.id));
    await o.store.transaction([
      { query: `DELETE FROM corpus_statute_meta WHERE judgment_id = ANY($1::text[])`, params: [`{${ids.map((i) => `"${i.replace(/["\\]/g, "")}"`).join(",")}}`] },
      ...(out.length ? [{ query: `INSERT INTO corpus_statute_meta (judgment_id, act_id, section, field, raw, form, extractor_version) SELECT judgment_id, act_id, section, field, raw, form, extractor_version FROM jsonb_to_recordset($1::jsonb) AS x(judgment_id text, act_id text, section text, field text, raw text, form text, extractor_version int) ON CONFLICT DO NOTHING`, params: [JSON.stringify(out)] }] : []),
    ]);
    c.after = ids[ids.length - 1];
    c.scanned += rows.length; c.links += out.length;
    scanned += rows.length; links += out.length;
    await setState(o.store, "statute_meta_cursor", c);
  }
  return { scanned, links, cursor: c.after, done: false, stop: "deadline" };
}
