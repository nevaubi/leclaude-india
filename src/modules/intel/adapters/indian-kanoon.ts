import "server-only";
import { z } from "zod";
import { ingestJudgment } from "@/modules/india/sources/ingest";
import { IK_FOCUS_DOCTYPES, ikDocToJudgment, ikQuery } from "@/modules/india/sources/indian-kanoon";
import { indiaProvidersFor } from "@/modules/india/sources/providers";
import { findJudgment } from "@/modules/india/sources/store";
import { daysAgoISO, ProviderError } from "../providers/base";
import { defineAdapter } from "./types";

const schema = z.object({
  /** Saved queries (Indian Kanoon syntax: phrases, ANDD / ORR / NOTT). */
  queries: z.array(z.string().min(1)).default([]),
  /** Indian Kanoon doctypes filter; defaults to the Supreme Court and the focus High Courts. */
  doctypes: z.array(z.string().min(1)).default([...IK_FOCUS_DOCTYPES]),
  /** Only documents published in the last N days (first run; later runs use the incremental window). */
  sinceDays: z.number().int().min(1).max(3650).default(30),
  /** Result pages per query (each page is billed by the provider). */
  maxPagesPerQuery: z.number().int().min(1).max(10).default(1),
  maxDocs: z.number().int().min(1).max(500).default(20),
  fetchText: z.boolean().default(true),
  maxCites: z.number().int().min(0).max(50).default(10),
});

export type IndianKanoonConfig = z.infer<typeof schema>;

/**
 * Indian Kanoon (paid API; firm token). Runs saved queries restricted to the configured courts and date window,
 * fetches full text for new results and stores them as judgments. Without `INDIAN_KANOON_API_TOKEN` the run records a
 * `not_configured` error and makes no request.
 */
export const indianKanoonAdapter = defineAdapter<IndianKanoonConfig>({
  id: "indian-kanoon",
  name: "Indian Kanoon",
  description: "Saved Indian Kanoon searches (Supreme Court and focus High Courts by default) with full text and citing/cited-by counts. Needs the firm's API token.",
  kinds: ["opinion"],
  family: "indian-kanoon",
  requires: ["indian-kanoon"],
  configSchema: schema,
  defaults: schema.parse({}),
  async run(ctx) {
    const cfg = ctx.config;
    const { kanoon } = indiaProvidersFor(ctx);
    const st = kanoon.status();
    if (st.state !== "ready") { ctx.fail(new ProviderError("indian-kanoon", "not_configured", `indian-kanoon: ${st.state} — ${st.reason}`, false), { provider: "indian-kanoon", label: "Indian Kanoon" }); return; }
    const queries = Array.from(new Set([...cfg.queries, ...(ctx.scope.queries ?? [])].map((q) => q.trim()).filter(Boolean)));
    if (!queries.length) { ctx.note("No queries configured."); return; }
    const from = ctx.since ?? daysAgoISO(cfg.sinceDays, ctx.now);
    let fetched = 0;
    for (const query of queries) {
      for (let page = 0; page < cfg.maxPagesPerQuery; page++) {
        if (ctx.budgetLeft() <= 0 || fetched >= cfg.maxDocs) break;
        const formInput = ikQuery(query, { doctypes: cfg.doctypes, fromISO: from });
        const res = await ctx.attempt(`search "${query}" p${page}`, () => kanoon.search({ formInput, pagenum: page, signal: ctx.signal }), { provider: "indian-kanoon" });
        if (!res?.docs.length) break;
        for (const hit of res.docs) {
          if (ctx.budgetLeft() <= 0 || fetched >= cfg.maxDocs) break;
          if (!Number.isFinite(hit.tid)) continue;
          const prior = findJudgment("indian-kanoon", String(hit.tid));
          if (prior?.intelDocId && prior.textChars) { ctx.result.skipped++; continue; }
          const doc = cfg.fetchText ? await ctx.attempt(`doc ${hit.tid}`, () => kanoon.doc(hit.tid, { maxcites: cfg.maxCites, maxcitedby: cfg.maxCites, signal: ctx.signal }), { provider: "indian-kanoon" }) : undefined;
          const { draft, text } = ikDocToJudgment(doc ? { ...hit, ...doc } : hit);
          draft.pdfUrl = kanoon.webUrl(hit.tid);
          await ctx.attempt(`ingest ${hit.tid}`, () => ingestJudgment(ctx, draft, { text, textMethod: doc ? "provider" : "text", issues: doc ? undefined : ["Search snippet only; full text not fetched"], tags: [`q:${query.slice(0, 40)}`] }));
          fetched++;
        }
      }
    }
    ctx.note(`${queries.length} quer${queries.length === 1 ? "y" : "ies"} since ${from}: ${fetched} documents fetched.`);
  },
});
