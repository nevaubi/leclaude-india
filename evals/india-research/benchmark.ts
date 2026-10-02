/**
 * India research benchmark (roadmap "Evals"): ≥100 questions with known authorities, graded in code.
 *
 * Cases live in evals/india-research/benchmark/<category>.json ({ suite, version, cases[] }). Every expected authority is a
 * real judgment identified by its official citation (or, for the two High Court benchmark judgments, by the identity the
 * product owner gave), with `confidence` and `source`. `fixture` fields (topic keywords, whether the fixture treats the
 * record as full text) exist only for the OFFLINE grader below; they describe nothing about the judgment's holding or the
 * production corpus.
 *
 * Offline grader (CI, vitest): a fixture index over every expected authority stands in for the corpus; the REAL engine
 * code does the rest — retrieval queries and Indian query expansion (planner), RRF fusion, the binding-force classifier,
 * the code-side claim checks (quotes.ts), the authority status table and the transition note. It measures the pipeline's
 * mechanics, not the production corpus. Live numbers come from scripts/evals/india-research-live.ts against a configured
 * (non-production) database.
 *
 * Metrics: recall@10 of expected authorities (with and without query expansion), citation resolution rate (authority
 * strings in the answer that resolve to a corpus record), unsupported-claim rate (claims not supported by read text after
 * the code checks), wrong-binding-force count, fabricated citations resolved (must be 0), transition-rule accuracy.
 */
import fs from "node:fs";
import path from "node:path";
import { transitionNote } from "@/lib/india/transition";
import { buildAuthorityStatus, citationResolutionRate, type AuthorityStatusTable } from "@/modules/search/engine/authority-status";
import { expandedQueries, retrievalQuery } from "@/modules/search/engine/planner";
import { checkClaimEvidence } from "@/modules/search/engine/quotes";
import { numberSources, sourceFromHit } from "@/modules/search/engine/sources";
import type { ClaimVerdictView, ResearchSource } from "@/modules/search/engine/types";
import { classifyAuthority } from "@/modules/search/jurisdictions";
import type { SearchHit } from "@/modules/search/types";

export type BenchCategory = "retrieval" | "adverse" | "transition" | "citation_format" | "binding_force" | "no_answer";

export interface ExpectedAuthority {
  key: string;
  title: string;
  /** Official citation (SCC / SCR / AIR / neutral); null when only the identity is known (title, court, year). */
  citation: string | null;
  court: string;
  year: number;
  bench: number | null;
  role: "supporting" | "adverse" | "overruled";
  confidence: "high" | "medium";
  source: string;
  fixture: { keywords: string[]; fullText: boolean };
}

export interface BenchCase {
  id: string;
  category: BenchCategory;
  split: "dev" | "heldout";
  question: string;
  forum: string;
  expected: ExpectedAuthority[];
  expectTransition?: { substantive: string; procedure: string };
  expectBinding?: Record<string, "binding" | "persuasive">;
  /** citation_format: the form the answer cites the authority in. */
  citeAs?: string;
  /** no_answer: a fabricated citation a hallucinating answer might write; it must stay unresolved. */
  probe?: string;
  benchmark?: boolean;
  notes?: string;
  grading: "code";
  requiresModel: boolean;
}

export const BENCHMARK_DIR = path.join(__dirname, "benchmark");

export function loadBenchmarkCases(dir = BENCHMARK_DIR): BenchCase[] {
  return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort().flatMap((f) => (JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as { cases: BenchCase[] }).cases);
}

/** Every distinct expected authority across the cases (the fixture corpus). */
export function authorityRegistry(cases: BenchCase[]): Map<string, ExpectedAuthority> {
  const out = new Map<string, ExpectedAuthority>();
  for (const c of cases) for (const e of c.expected) if (!out.has(e.key)) out.set(e.key, e);
  return out;
}

// ---------------------------------------------------------------------------
// Metrics (pure; shared with the live script)
// ---------------------------------------------------------------------------

/** Share of expected keys found in the first `k` ranked keys (null when nothing is expected). */
export function recallAtK(expected: string[], ranked: string[], k = 10): number | null {
  if (!expected.length) return null;
  const top = new Set(ranked.slice(0, k));
  return expected.filter((e) => top.has(e)).length / expected.length;
}

/** Reciprocal rank fusion over ranked key lists (k = 60, the official-sources convention); ties keep first-seen order. */
export function fuseRanked(lists: string[][], k = 60): string[] {
  const acc = new Map<string, { score: number; first: number }>();
  let order = 0;
  for (const list of lists) list.forEach((key, i) => {
    const e = acc.get(key) ?? { score: 0, first: order++ };
    e.score += 1 / (k + i + 1);
    acc.set(key, e);
  });
  return [...acc.entries()].sort((a, b) => b[1].score - a[1].score || a[1].first - b[1].first).map(([key]) => key);
}

export const mean = (xs: (number | null)[]): number | null => { const v = xs.filter((x): x is number => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };

// ---------------------------------------------------------------------------
// Offline fixture index
// ---------------------------------------------------------------------------

const STOP = new Set(["a", "an", "the", "of", "to", "in", "on", "for", "under", "and", "or", "is", "are", "be", "by", "with", "at", "from", "that", "this", "it", "as", "can", "does", "do", "what", "which", "when", "how", "must", "may", "whether", "there", "any", "s", "u", "section", "sections", "act", "v", "vs"]);

export function tokens(text: string): string[] {
  return (text.toLowerCase().replace(/[()]/g, " ").match(/[a-z0-9]+/g) ?? []).filter((t) => !STOP.has(t)).map((t) => (t.length > 4 && t.endsWith("s") && !/\d/.test(t) ? t.slice(0, -1) : t));
}

export interface FixtureRecord { key: string; tokens: Set<string>; hit: SearchHit; text: string | null }

/** Placeholder text for fixture records with "full text": clearly not the judgment's words. */
export const FIXTURE_TEXT_NOTICE = "[FIXTURE PLACEHOLDER — not the text of the judgment; used only by the offline grader]";

export function buildFixtureIndex(registry: Map<string, ExpectedAuthority>): FixtureRecord[] {
  return [...registry.values()].map((e) => {
    const neutral = e.citation && /INSC|:[A-Z-]+:/.test(e.citation) ? e.citation : undefined;
    const reporters = e.citation && !neutral ? [e.citation] : [];
    const hit: SearchHit = {
      id: `fixture:${e.key}`, source: "caselaw", title: e.title, cite: e.citation ?? undefined, citations: e.citation ? [e.citation] : [], court: e.court, courtId: e.court,
      date: `${e.year}-06-30`, snippet: e.fixture.keywords.join("; "), authority: "n/a",
      ...(e.fixture.fullText ? { readRef: { kind: "url" as const, url: `fixture://${e.key}` } } : {}),
      india: { judgmentId: `fixture:${e.key}`, courtId: e.court, neutralCitation: neutral, reporterCitations: reporters.length ? reporters : undefined, provider: "corpus", ...(e.bench ? { benchStrength: e.bench } : {}) },
    };
    return { key: e.key, tokens: new Set(tokens(`${e.title} ${e.citation ?? ""} ${e.fixture.keywords.join(" ")}`)), hit, text: e.fixture.fullText ? `${FIXTURE_TEXT_NOTICE}\n1. ${e.title}. Topics: ${e.fixture.keywords.join("; ")}.` : null };
  });
}

/** Fixture retrieval for one query: token overlap (numbers weigh 2), at least 2, top `limit`, ties by key. */
export function fixtureSearch(index: FixtureRecord[], query: string, limit = 10): string[] {
  const q = Array.from(new Set(tokens(query)));
  return index.map((r) => ({ key: r.key, s: q.reduce((acc, t) => acc + (r.tokens.has(t) ? (/^\d/.test(t) ? 2 : 1) : 0), 0) }))
    .filter((x) => x.s >= 2).sort((a, b) => b.s - a.s || a.key.localeCompare(b.key)).slice(0, limit).map((x) => x.key);
}

// ---------------------------------------------------------------------------
// Offline grading
// ---------------------------------------------------------------------------

export interface BenchCheck { name: string; ok: boolean; actual?: string }
export interface BenchResult {
  id: string;
  category: BenchCategory;
  split: BenchCase["split"];
  status: "pass" | "fail";
  checks: BenchCheck[];
  metrics: { recall10: number | null; recall10Baseline: number | null; resolutionRate: number | null; unsupportedRate: number | null; wrongBinding: number; fabricatedResolved: number; claims: number; unsupported: number };
  top10: string[];
}

export interface BenchSummary {
  cases: number;
  byCategory: Record<string, number>;
  bySplit: Record<string, number>;
  recall10: number | null;
  recall10Baseline: number | null;
  resolutionRate: number | null;
  unsupportedClaimRate: number | null;
  wrongBindingForce: number;
  fabricatedResolved: number;
  transitionCorrect: number;
  transitionCases: number;
  failed: string[];
}

/** Forum-correct binding label the engine must give (explicit in the case, or: the Supreme Court always binds). */
function expectedBinding(c: BenchCase, e: ExpectedAuthority): "binding" | "persuasive" | null {
  if (c.expectBinding?.[e.key]) return c.expectBinding[e.key];
  return e.court === "sci" ? "binding" : null;
}

export function gradeOffline(c: BenchCase, index: FixtureRecord[]): BenchResult {
  const checks: BenchCheck[] = [];
  const check = (name: string, ok: boolean, actual?: unknown) => checks.push({ name, ok, actual: actual === undefined ? undefined : typeof actual === "string" ? actual : JSON.stringify(actual) });
  const base = retrievalQuery(c.question);
  const queries = expandedQueries(base);
  const top10 = fuseRanked(queries.map((q) => fixtureSearch(index, q))).slice(0, 10);
  const baselineTop = fuseRanked([fixtureSearch(index, base)]).slice(0, 10);
  const expectedKeys = c.expected.map((e) => e.key);
  const recall10 = recallAtK(expectedKeys, top10);
  const recall10Baseline = recallAtK(expectedKeys, baselineTop);

  // Answer over the retrieved records: every expected authority found is cited by number and by citation string.
  const byKey = new Map(index.map((r) => [r.key, r] as const));
  const found = top10.map((k) => byKey.get(k)!).filter(Boolean);
  const pool: ResearchSource[] = found.map((r) => {
    const s = sourceFromHit({ ...r.hit, authority: classifyAuthority(r.hit.courtId, c.forum, undefined, r.hit.date) }, "lane_fixture");
    return r.text ? { ...s, read: true, chars: r.text.length, excerpt: r.text.slice(0, 600) } : s;
  });
  const numbered = numberSources(pool).sources;
  const textOf = (s: ResearchSource) => byKey.get(s.id.replace(/^fixture:/, ""))?.text ?? undefined;
  const cited = numbered.filter((s) => expectedKeys.includes(s.id.replace(/^fixture:/, "")));
  const lines = cited.map((s) => {
    const e = c.expected.find((x) => `fixture:${x.key}` === s.id)!;
    const cite = c.citeAs && c.category === "citation_format" ? c.citeAs : e.citation;
    return `- ${e.title}${cite ? `, ${cite}` : ""} addresses the issue [${s.n}].`;
  });
  if (c.probe) lines.push(`- See also ${c.probe}.`);
  const answer = ["## Short Answer", lines.length ? lines.join("\n") : "The sources reviewed do not establish this."].join("\n");
  const verdicts: ClaimVerdictView[] = cited.map((s) => ({ claim: `${s.title} addresses the issue`, status: "supported", sourceN: s.n ?? null }));
  const checked = checkClaimEvidence(answer, verdicts, numbered, textOf);
  const hash = `fixture-${c.id}`;
  const table: AuthorityStatusTable = buildAuthorityStatus({ answer, artifactHash: hash, sources: numbered, verification: { artifactHash: hash, verdicts: checked.verdicts }, remotelyKnown: new Set() });
  // Resolution over the authorities the answer meant to cite (a fabricated probe is graded separately below).
  const resolutionRate = citationResolutionRate({ ...table, rows: table.rows.filter((r) => !c.probe || !r.citations.includes(c.probe)) });
  const unsupported = checked.verdicts.filter((v) => v.status !== "supported").length;
  const unsupportedRate = checked.verdicts.length ? unsupported / checked.verdicts.length : null;
  const fabricatedResolved = c.probe ? table.rows.filter((r) => r.citations.includes(c.probe!) && r.status !== "unresolved").length : 0;

  // Binding force through the engine's classifier.
  let wrongBinding = 0;
  for (const e of c.expected) {
    const want = expectedBinding(c, e);
    if (!want) continue;
    const got = classifyAuthority(e.court, c.forum, undefined, `${e.year}-06-30`);
    if (got !== want) { wrongBinding++; check(`binding force of ${e.key} for ${c.forum} is ${want}`, false, got); }
  }

  switch (c.category) {
    case "retrieval": case "adverse": case "citation_format": case "binding_force":
      // Recall is a metric (reported, thresholded in aggregate), not a per-case integrity check.
      check("every cited authority string resolves to its record", resolutionRate === 1 || (resolutionRate == null && !cited.some((s) => s.cite)), { resolutionRate, rows: table.rows.map((r) => [r.authority, r.status]) });
      for (const s of cited) {
        const row = table.rows.find((r) => r.sourceN === s.n);
        const want = s.read ? "supported" : "text_not_available";
        check(`${s.id} is ${want}`, row?.status === want, row?.status);
      }
      break;
    case "transition": {
      const n = transitionNote({ question: c.question });
      if (c.expectTransition) check("transition rule (substantive, procedure)", n.substantive === c.expectTransition.substantive && n.procedure === c.expectTransition.procedure, [n.substantive, n.procedure]);
      check("note applies and states the savings provisions", n.applies && n.lines.some((l) => l.includes("BNS s.358")) && n.lines.some((l) => l.includes("BNSS s.531")), n.applies);
      break;
    }
    case "no_answer":
      check("fabricated citation stays unresolved (never substituted)", fabricatedResolved === 0 && table.rows.some((r) => r.citations.includes(c.probe ?? "") && r.status === "unresolved"), table.rows.map((r) => [r.authority, r.status]));
      check("no supported authority invented", table.rows.every((r) => r.status !== "supported" || cited.length > 0));
      break;
  }
  if (c.category !== "no_answer" && c.category !== "transition") check("no fabricated resolution", fabricatedResolved === 0);
  return { id: c.id, category: c.category, split: c.split, status: checks.length && checks.every((x) => x.ok) ? "pass" : "fail", checks, metrics: { recall10, recall10Baseline, resolutionRate, unsupportedRate, wrongBinding, fabricatedResolved, claims: checked.verdicts.length, unsupported }, top10 };
}

export function runBenchmarkOffline(opts: { split?: BenchCase["split"]; ids?: string[] } = {}): { results: BenchResult[]; summary: BenchSummary } {
  const all = loadBenchmarkCases();
  const index = buildFixtureIndex(authorityRegistry(all));
  const cases = all.filter((c) => (!opts.split || c.split === opts.split) && (!opts.ids?.length || opts.ids.includes(c.id)));
  const results = cases.map((c) => gradeOffline(c, index));
  return { results, summary: summarize(cases, results) };
}

export function summarize(cases: BenchCase[], results: BenchResult[]): BenchSummary {
  const count = <K extends string>(xs: K[]) => xs.reduce<Record<string, number>>((m, k) => { m[k] = (m[k] ?? 0) + 1; return m; }, {});
  const claims = results.reduce((a, r) => a + r.metrics.claims, 0);
  const unsupported = results.reduce((a, r) => a + r.metrics.unsupported, 0);
  const tr = results.filter((r) => r.category === "transition");
  return {
    cases: cases.length,
    byCategory: count(cases.map((c) => c.category)),
    bySplit: count(cases.map((c) => c.split)),
    recall10: mean(results.map((r) => r.metrics.recall10)),
    recall10Baseline: mean(results.map((r) => r.metrics.recall10Baseline)),
    resolutionRate: mean(results.map((r) => r.metrics.resolutionRate)),
    unsupportedClaimRate: claims ? unsupported / claims : null,
    wrongBindingForce: results.reduce((a, r) => a + r.metrics.wrongBinding, 0),
    fabricatedResolved: results.reduce((a, r) => a + r.metrics.fabricatedResolved, 0),
    transitionCorrect: tr.filter((r) => r.checks.find((x) => x.name.startsWith("transition rule"))?.ok).length,
    transitionCases: tr.length,
    failed: results.filter((r) => r.status === "fail").map((r) => r.id),
  };
}
