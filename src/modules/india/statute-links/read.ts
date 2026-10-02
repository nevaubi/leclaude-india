import "server-only";
import type { RemoteStore, SqlValue } from "@/lib/db/remote";
import { citatorActFor, linkableSectionKey, type InterpretingJudgment, type InterpretingResponse } from "@/modules/law/interpreting";
import { getState } from "@/modules/india/corpus/backfill";

/**
 * Judgments linked to one statute section (server-only, read-only): the union of text links (corpus_citations, kind
 * 'statute') and headnote links (corpus_statute_meta), one row per judgment with both origins kept. A section matches
 * itself and its sub-sections ("302" matches "302" and "302(1)"), never a neighbouring number.
 */

const PAGE = 20;
const t = (v: unknown) => String(v) === "true" || String(v) === "t";

export async function interpretingJudgments(store: RemoteStore, i: { title: string; year: number | null; jurisdiction: string }, sectionRaw: string, offsetRaw = 0): Promise<InterpretingResponse> {
  const actId = citatorActFor(i);
  const section = linkableSectionKey(sectionRaw);
  const offset = Math.max(0, Math.min(Math.trunc(offsetRaw) || 0, 5000));
  const empty = (state: InterpretingResponse["state"], coverage: string, note: string | null = null): InterpretingResponse => ({ actId, section: section ?? sectionRaw, state, total: 0, fromText: 0, headnoteOnly: 0, textAvailable: 0, judgments: [], offset, hasMore: false, coverage, note });
  if (!actId || !section) return empty("not_applicable", "", actId ? "Only numbered sections are linked to judgments." : "Judgment links are kept for the Acts the citation parser recognises by exact title; this instrument is not one of them.");
  const tables = await store.query({ query: `SELECT to_regclass('public.corpus_judgments') IS NOT NULL AS j, to_regclass('public.corpus_citations') IS NOT NULL AS c, to_regclass('public.corpus_statute_meta') IS NOT NULL AS m, to_regclass('public.corpus_citator_scans') IS NOT NULL AS s` });
  const has = { j: t(tables[0]?.j), c: t(tables[0]?.c), m: t(tables[0]?.m), s: t(tables[0]?.s) };
  if (!has.j || (!has.c && !has.m)) return empty("not_built", "Neither the citator nor the headnote links have been built on this deployment.");
  const params: SqlValue[] = [actId, section, `${section}(%`];
  const parts: string[] = [];
  if (has.c) parts.push(`SELECT citing_id AS id, true AS t, false AS m FROM corpus_citations WHERE kind = 'statute' AND act_id = $1 AND (section = $2 OR section LIKE $3)`);
  if (has.m) parts.push(`SELECT judgment_id AS id, false AS t, true AS m FROM corpus_statute_meta WHERE act_id = $1 AND (section = $2 OR section LIKE $3)`);
  params.push(offset);
  const rows = await store.query({
    query: `WITH hits AS (${parts.join(" UNION ALL ")}),
      agg AS (SELECT id, bool_or(t) AS from_text, bool_or(m) AS from_meta FROM hits GROUP BY id),
      joined AS (SELECT j.id, j.title, j.court_id, j.decision_date, j.neutral_citation, j.reporter_citation, j.text_status, a.from_text, a.from_meta FROM agg a JOIN corpus_judgments j ON j.id = a.id)
      SELECT id, title, court_id, decision_date::text AS decision_date, neutral_citation, reporter_citation, text_status, from_text, from_meta,
        count(*) OVER () AS total, count(*) FILTER (WHERE from_text) OVER () AS n_text, count(*) FILTER (WHERE NOT from_text) OVER () AS n_head, count(*) FILTER (WHERE text_status = 'full') OVER () AS n_avail
      FROM joined ORDER BY decision_date DESC NULLS LAST, id LIMIT ${PAGE + 1} OFFSET $4`,
    params,
  });
  const judgments: InterpretingJudgment[] = rows.slice(0, PAGE).map((r) => ({
    id: String(r.id), title: String(r.title ?? r.id), courtId: r.court_id ?? null, decisionDate: r.decision_date ?? null,
    citation: r.neutral_citation ?? r.reporter_citation ?? null, textAvailable: r.text_status === "full", fromText: t(r.from_text), fromHeadnote: t(r.from_meta),
  }));
  const [scans, meta] = await Promise.all([
    has.s ? store.query({ query: `SELECT count(*)::int AS n FROM corpus_citator_scans` }) : Promise.resolve([]),
    has.m ? getState<{ scanned: number; done: boolean }>(store, "statute_meta_cursor") : Promise.resolve(null),
  ]);
  const scannedText = Number(scans[0]?.n ?? 0);
  const coverage = [
    has.c ? `full text of ${scannedText.toLocaleString("en-IN")} judgment${scannedText === 1 ? "" : "s"} scanned` : "text links not built",
    has.m ? (meta?.done ? "headnotes of every judgment in the corpus read" : `headnotes of ${(meta?.scanned ?? 0).toLocaleString("en-IN")} judgments read so far`) : "headnote links not built",
  ].join("; ");
  const first = rows[0];
  return {
    actId, section, state: "ok",
    total: Number(first?.total ?? 0), fromText: Number(first?.n_text ?? 0), headnoteOnly: Number(first?.n_head ?? 0), textAvailable: Number(first?.n_avail ?? 0),
    judgments, offset, hasMore: rows.length > PAGE, coverage,
    note: "Counts are judgments in this collection linked by the citation parser; they are not a complete citator and never say how the court treated the section.",
  };
}
