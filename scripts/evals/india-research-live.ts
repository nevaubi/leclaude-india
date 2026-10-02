/**
 * Live India research benchmark against a configured, NON-PRODUCTION corpus database.
 *
 *   EVAL_DATABASE_URL=postgres://… npx tsx scripts/evals/india-research-live.ts [--split dev|heldout] [--ids a,b] [--rerank] [--full] [--out report.json]
 *
 * Guards: the database comes only from EVAL_DATABASE_URL (DATABASE_URL / POSTGRES_URL are ignored and overwritten for
 * this process); the script refuses to start when EVAL_DATABASE_URL equals PRODUCTION_DATABASE_URL (when that is set)
 * or when NODE_ENV=production. It only reads (plus the idempotent CREATE … IF NOT EXISTS of the embedding tables that
 * any hybrid search performs).
 *
 * Per case it runs the case-law retrieval the research lanes run — the retrieval query and its Indian expansions, each
 * through the hybrid judgment text search (keyword + embeddings where built) and the metadata index, fused by RRF — and
 * reports:
 *   recall@10 (expansion) and recall@10 (base query only); with --rerank also after the issue-level reranker
 *   citation resolution: expected citations the judgment index carries (found), and whether text exists
 *   wrong binding force: classifyAuthority for each matched record vs the expected label
 * With --full (needs model credentials) it also runs the whole research engine and reports, from message.authorities,
 * the citation resolution rate of the answer, unsupported-claim rate and supported authorities.
 */
import fs from "node:fs";
import Module from "node:module";
import path from "node:path";

// `server-only` is a bundler guard; this script runs in plain Node (tsx), as the tests do (tests/server-only-shim.ts).
const SHIM = path.resolve(__dirname, "../../tests/server-only-shim.ts");
const M = Module as unknown as { _resolveFilename: (req: string, ...rest: unknown[]) => string };
const resolve = M._resolveFilename;
M._resolveFilename = (req: string, ...rest: unknown[]) => (req === "server-only" ? SHIM : resolve.call(Module, req, ...rest));

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };

function guard(): void {
  const url = (process.env.EVAL_DATABASE_URL ?? "").trim();
  if (!url) { console.error("Set EVAL_DATABASE_URL to a non-production corpus database (DATABASE_URL is ignored by this script)."); process.exit(2); }
  if (process.env.NODE_ENV === "production") { console.error("Refusing to run with NODE_ENV=production."); process.exit(2); }
  const prod = (process.env.PRODUCTION_DATABASE_URL ?? "").trim();
  if (prod && prod === url) { console.error("EVAL_DATABASE_URL is the production database; refusing."); process.exit(2); }
  process.env.DATABASE_URL = url;
  delete process.env.POSTGRES_URL;
}

async function main() {
  guard();
  const { loadBenchmarkCases, recallAtK, fuseRanked, mean } = await import("../../evals/india-research/benchmark");
  const { expandedQueries, retrievalQuery } = await import("@/modules/search/engine/planner");
  const { searchJudgmentTextHybrid } = await import("@/modules/india/corpus/hybrid");
  const { searchCorpus } = await import("@/modules/india/corpus/search");
  const { corpusCitationsKnown } = await import("@/modules/india/corpus/text");
  const { classifyAuthority } = await import("@/modules/search/jurisdictions");
  const { compactCitationKey } = await import("@/lib/india/citation-strings");
  const { normalizeCitation } = await import("@/lib/india/citations");
  const { remoteStore } = await import("@/lib/db/remote");
  const store = remoteStore();
  if (!store) { console.error("No database: EVAL_DATABASE_URL did not configure the remote store."); process.exit(2); }

  const split = value("split") as "dev" | "heldout" | undefined;
  const ids = value("ids")?.split(",").filter(Boolean);
  const cases = loadBenchmarkCases().filter((c) => (!split || c.split === split) && (!ids?.length || ids.includes(c.id)));
  const key = (s: string | null | undefined) => (s ? compactCitationKey(normalizeCitation(s) ?? s) : "");
  const titleKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").slice(0, 3).join(" ");

  interface Row { id: string; title: string | null; courtId: string | null; date: string | null; cites: string[] }
  const retrieve = async (q: string): Promise<Row[]> => {
    const [text, meta] = await Promise.all([
      searchJudgmentTextHybrid(q, { limit: 20 }, store).catch(() => ({ hits: [] as { judgmentId: string | null; title: string | null; courtId: string; decisionDate: string | null; neutralCitation: string | null; reporterCitation: string | null; recordNeutralCitation?: string | null }[] })),
      searchCorpus({ q, limit: 20 }, store).catch(() => ({ hits: [] as { id: string; title: string; court_id: string | null; decision_date: string | null; neutral_citation: string | null; reporter_citation: string | null; match: string }[] })),
    ]);
    const rows: Row[] = text.hits.map((h) => ({ id: h.judgmentId ?? `${h.neutralCitation}`, title: h.title, courtId: h.courtId, date: h.decisionDate, cites: [h.neutralCitation, h.reporterCitation, h.recordNeutralCitation ?? null].filter((x): x is string => Boolean(x)) }));
    for (const h of meta.hits) if (h.match !== "partial") rows.push({ id: h.id, title: h.title, courtId: h.court_id, date: h.decision_date, cites: [h.neutral_citation, h.reporter_citation].filter((x): x is string => Boolean(x)) });
    return rows;
  };

  const out: Record<string, unknown>[] = [];
  for (const c of cases) {
    const t0 = Date.now();
    const base = retrievalQuery(c.question);
    const queries = expandedQueries(base);
    const perQuery = await Promise.all(queries.map(retrieve));
    const rowsById = new Map<string, Row>();
    for (const list of perQuery) for (const r of list) if (!rowsById.has(r.id)) rowsById.set(r.id, r);
    const ranked = fuseRanked(perQuery.map((l) => l.map((r) => r.id)));
    const baseRanked = fuseRanked([perQuery[0].map((r) => r.id)]);
    // Expected authority ↔ retrieved record: by citation key; an authority known only by identity matches on title, court and year.
    const matches = (e: (typeof c.expected)[number], r: Row) => (e.citation ? r.cites.some((x) => key(x) === key(e.citation)) : Boolean(r.title && titleKey(r.title) === titleKey(e.title) && r.courtId === e.court && (r.date ?? "").startsWith(String(e.year))));
    const expectedIn = (list: string[]) => c.expected.map((e) => list.slice(0, 10).some((id) => { const r = rowsById.get(id); return r ? matches(e, r) : false; }) ? e.key : null).filter((x): x is string => Boolean(x));
    const recall10 = recallAtK(c.expected.map((e) => e.key), expectedIn(ranked));
    const recall10Baseline = recallAtK(c.expected.map((e) => e.key), expectedIn(baseRanked));
    let recall10Reranked: number | null | undefined;
    if (flag("rerank")) {
      const { defaultDeps } = await import("@/modules/search/engine/deps");
      const { rerankOrder, RERANK_TOP_N } = await import("@/modules/search/engine/rerank");
      const head = ranked.slice(0, RERANK_TOP_N).map((id) => rowsById.get(id)!).filter(Boolean);
      try {
        const scores = await defaultDeps().rerank!({ question: c.question, issues: [], candidates: head.map((r) => ({ id: r.id, title: r.title ?? r.id, date: r.date ?? undefined, court: r.courtId ?? undefined })) });
        const by = new Map(scores.map((x) => [x.id, x.score] as const));
        const order = rerankOrder(head.map((r, i) => ({ item: r.id, id: r.id, score: by.get(r.id) ?? null, date: r.date ?? undefined, rank: i })));
        recall10Reranked = recallAtK(c.expected.map((e) => e.key), expectedIn([...order, ...ranked.slice(RERANK_TOP_N)]));
      } catch (e) { console.error(`[${c.id}] reranker unavailable: ${(e as Error).message}`); recall10Reranked = null; }
    }
    const cites = c.expected.map((e) => e.citation).filter((x): x is string => Boolean(x));
    const known = cites.length ? await corpusCitationsKnown(cites, store).catch((e: unknown) => { console.error(`[${c.id}] citation lookup failed: ${(e as Error).message}`); return new Set<string>(); }) : new Set<string>();
    let wrongBinding = 0;
    for (const e of c.expected) {
      const want = c.expectBinding?.[e.key] ?? (e.court === "sci" ? "binding" : null);
      const r = [...rowsById.values()].find((x) => matches(e, x));
      if (want && r && classifyAuthority(r.courtId, c.forum, undefined, r.date) !== want) wrongBinding++;
    }
    let full: Record<string, unknown> | undefined;
    if (flag("full")) {
      const { runResearch } = await import("@/modules/search/engine/run");
      const { sanitizeSettings } = await import("@/modules/search/service");
      const res = await runResearch({ question: c.question, settings: sanitizeSettings({ sources: ["caselaw", "statutes"], jurisdiction: c.forum }), rerank: flag("rerank") }, () => {}, undefined);
      const t = res.message.authorities;
      const strings = t?.rows.filter((r) => r.citations.length) ?? [];
      const claims = res.message.verification?.verdicts ?? [];
      full = {
        terminal: res.terminal,
        authorities: t?.counts,
        resolutionRate: strings.length ? strings.filter((r) => r.status !== "unresolved").length / strings.length : null,
        unsupportedClaimRate: claims.length ? claims.filter((v) => v.status !== "supported").length / claims.length : null,
        expectedSupported: c.expected.filter((e) => t?.rows.some((r) => r.status === "supported" && r.citations.some((x) => e.citation && key(x) === key(e.citation)))).map((e) => e.key),
      };
    }
    const row = { id: c.id, category: c.category, split: c.split, recall10, recall10Baseline, ...(recall10Reranked !== undefined ? { recall10Reranked } : {}), expectedCitations: cites.length, citationsInIndex: known.size, wrongBinding, ms: Date.now() - t0, ...(full ? { full } : {}) };
    out.push(row);
    console.log(JSON.stringify(row));
  }
  const summary = {
    cases: out.length,
    recall10: mean(out.map((r) => r.recall10 as number | null)),
    recall10Baseline: mean(out.map((r) => r.recall10Baseline as number | null)),
    ...(flag("rerank") ? { recall10Reranked: mean(out.map((r) => (r.recall10Reranked as number | null | undefined) ?? null)) } : {}),
    citationIndexRate: (() => { const e = out.reduce((a, r) => a + (r.expectedCitations as number), 0); return e ? out.reduce((a, r) => a + (r.citationsInIndex as number), 0) / e : null; })(),
    wrongBindingForce: out.reduce((a, r) => a + (r.wrongBinding as number), 0),
  };
  console.log(JSON.stringify({ summary }, null, 1));
  const file = value("out");
  if (file) fs.writeFileSync(file, JSON.stringify({ summary, cases: out }, null, 1));
}

main().catch((e) => { console.error(e); process.exit(1); });
