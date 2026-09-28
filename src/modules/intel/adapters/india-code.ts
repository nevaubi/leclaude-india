import "server-only";
import { z } from "zod";
import type { StateCode } from "@/lib/india/courts";
import { actText, INDIA_CODE_STATE_NAMES, mdValue, parseActItem, parseSectionItem, type DspaceItem, type SectionDraft } from "@/modules/india/sources/india-code";
import { indiaProvidersFor } from "@/modules/india/sources/providers";
import { enactmentIdFor, getEnactment, replaceSections, upsertEnactment } from "@/modules/india/sources/store";
import { ProviderError } from "../providers/base";
import { defineAdapter, type AdapterContext } from "./types";

/** Central Acts a litigation practice in Karnataka / Telangana / Andhra Pradesh needs first (matched by exact title). */
export const DEFAULT_CENTRAL_ACTS = [
  "The Bharatiya Nyaya Sanhita, 2023",
  "The Bharatiya Nagarik Suraksha Sanhita, 2023",
  "The Bharatiya Sakshya Adhiniyam, 2023",
  "The Indian Penal Code, 1860",
  "The Code of Criminal Procedure, 1973",
  "The Indian Evidence Act, 1872",
  "The Code of Civil Procedure, 1908",
  "The Limitation Act, 1963",
  "The Indian Contract Act, 1872",
  "The Specific Relief Act, 1963",
  "The Negotiable Instruments Act, 1881",
  "The Arbitration and Conciliation Act, 1996",
  "The Transfer of Property Act, 1882",
  "The Commercial Courts Act, 2015",
  "The Consumer Protection Act, 2019",
];

const STATE_CODES = ["KA", "TS", "AP", "TN", "MH", "KL", "DL"] as const;

const schema = z.object({
  /** Central Acts to keep current, by exact title as printed on India Code. */
  centralActs: z.array(z.string().min(3)).default(DEFAULT_CENTRAL_ACTS),
  /** States whose Acts are walked newest first (India Code state names are resolved through a fixed table). */
  states: z.array(z.enum(STATE_CODES)).default(["KA", "TS", "AP"]),
  /** Extra Acts by DSpace handle ("123456789/496548"). */
  handles: z.array(z.string().regex(/^\d+\/\d+$/)).default([]),
  maxActsPerRun: z.number().int().min(1).max(500).default(25),
  pageSize: z.number().int().min(5).max(100).default(20),
  fetchSections: z.boolean().default(true),
  maxSectionsPerAct: z.number().int().min(10).max(3000).default(1500),
});

export type IndiaCodeConfig = z.infer<typeof schema>;

interface IndiaCodeCursor { v: 1; states: Record<string, { page: number; complete?: boolean }> }

function decode(raw: string | undefined): IndiaCodeCursor {
  try { const c = raw ? (JSON.parse(raw) as IndiaCodeCursor) : null; if (c?.v === 1 && c.states) return c; } catch { /* ignore */ }
  return { v: 1, states: {} };
}

/** Title comparison key: case, punctuation and a leading "The" are ignored; nothing else is (no fuzzy matching). */
export function titleKey(t: string): string {
  return t.toLowerCase().replace(/^the\s+/, "").replace(/[^a-z0-9]+/g, " ").trim();
}

async function ingestAct(ctx: AdapterContext<IndiaCodeConfig>, item: DspaceItem): Promise<"ingested" | "skipped" | "failed"> {
  const { indiaCode } = indiaProvidersFor(ctx);
  const draft = parseActItem(item);
  const id = enactmentIdFor("india-code", draft.externalId);
  const prior = getEnactment(id);
  if (prior && prior.lastModified && prior.lastModified === draft.lastModified && prior.intelDocId && (prior.sections > 0 || !ctx.config.fetchSections)) { ctx.result.skipped++; return "skipped"; }

  const sections: SectionDraft[] = [];
  if (ctx.config.fetchSections && draft.actId) {
    for (let page = 0; page < 60 && sections.length < ctx.config.maxSectionsPerAct; page++) {
      const res = await ctx.attempt(`sections ${draft.title} p${page}`, () => indiaCode.sections(draft.actId!, { page, size: 100, signal: ctx.signal }), { provider: "india-code" });
      if (!res) return "failed";
      for (const s of res.items) {
        // A section is attached only when it carries this Act's id (never by title or position).
        if (mdValue(s.metadata, "dc.identifier.act_id") !== draft.actId) continue;
        const parsed = parseSectionItem(s);
        if (parsed) sections.push(parsed);
      }
      if (page + 1 >= res.page.totalPages || !res.items.length) break;
    }
  }
  const text = actText(draft, sections);
  const issues = draft.state?.startsWith("unresolved:") ? [`State "${draft.state.slice(11)}" not in the state table`] : [];
  const r = await ctx.ingest({
    kind: "statute",
    title: draft.title,
    summary: draft.longTitle,
    jurisdiction: draft.jurisdiction === "central" ? "IN" : draft.state && !draft.state.startsWith("unresolved:") ? `IN-${draft.state}` : undefined,
    citation: draft.actNumber ? `Act ${draft.actNumber} of ${draft.year}` : undefined,
    dates: { effective: draft.inForceFrom, published: draft.enactedOn, modified: draft.lastModified?.slice(0, 10) },
    url: draft.url,
    externalId: `india-code:${draft.externalId}`,
    text,
    tags: ["india", "india-code", draft.jurisdiction, ...(draft.state ? [draft.state] : []), ...(draft.repealed ? ["repealed"] : [])],
    flags: [
      ...(sections.length === 0 && ctx.config.fetchSections ? [{ kind: "needs_review" as const, note: "No section text on India Code for this Act", at: ctx.now.toISOString(), by: "india-code" }] : []),
      ...(issues.length ? [{ kind: "needs_review" as const, note: issues.join("; "), at: ctx.now.toISOString(), by: "india-code" }] : []),
    ],
    confidence: sections.length ? 0.9 : 0.6,
    meta: { india: true, source: "india-code", enactmentId: id, actId: draft.actId, handle: draft.handle, sections: sections.length, repealed: draft.repealed, regionalTitle: draft.regionalTitle },
  });
  const { externalId, ...rest } = draft;
  upsertEnactment({ ...rest, externalId, id, sections: sections.length, retrievedAt: ctx.now.toISOString(), intelDocId: r.doc.id }, ctx.now);
  if (ctx.config.fetchSections) replaceSections(id, sections, ctx.now);
  return "ingested";
}

/**
 * India Code: central Acts (a configurable core list plus handles) and the Acts of the focus states, with section text,
 * through India Code's public DSpace REST API. Enactments and sections are stored as records and each Act is indexed
 * as one searchable statute document ("Section N. Heading" blocks).
 */
export const indiaCodeAdapter = defineAdapter<IndiaCodeConfig>({
  id: "india-code",
  name: "India Code (Acts and sections)",
  description: "Central and state Acts with section text from India Code (Karnataka, Telangana and Andhra Pradesh by default, plus the core central codes).",
  kinds: ["statute"],
  family: "india-code",
  requires: ["india-code"],
  configSchema: schema,
  defaults: schema.parse({}),
  async run(ctx) {
    const cfg = ctx.config;
    const { indiaCode } = indiaProvidersFor(ctx);
    if (indiaCode.http.offline) { ctx.fail(new ProviderError("india-code", "not_configured", "india-code: offline (INTEL_OFFLINE is set); nothing was fetched", false), { provider: "india-code", label: "India Code" }); return; }
    let done = 0;
    const counts = { ingested: 0, skipped: 0, failed: 0, notFound: [] as string[] };
    const take = async (item: DspaceItem) => {
      if (done >= cfg.maxActsPerRun || ctx.budgetLeft() <= 0) return;
      const r = await ctx.attempt(`act ${item.handle ?? item.id}`, () => ingestAct(ctx, item), { provider: "india-code" });
      counts[r ?? "failed"]++;
      if (r !== "skipped") done++;
    };

    // Central Acts by exact title.
    for (const title of cfg.centralActs) {
      if (done >= cfg.maxActsPerRun || ctx.budgetLeft() <= 0) break;
      const res = await ctx.attempt(`find "${title}"`, () => indiaCode.searchActs({ query: `dc.title:"${title.replace(/"/g, "")}"`, size: 10, signal: ctx.signal }), { provider: "india-code" });
      if (!res) continue;
      const exact = res.items.filter((i) => titleKey(mdValue(i.metadata, "dc.title") ?? i.name ?? "") === titleKey(title) && /^central$/i.test(mdValue(i.metadata, "dc.identifier.state_name") ?? ""));
      if (!exact.length) { counts.notFound.push(title); continue; }
      for (const item of exact.slice(0, 1)) await take(item);
    }
    for (const handle of cfg.handles) {
      if (done >= cfg.maxActsPerRun) break;
      const item = await ctx.attempt(`handle ${handle}`, () => indiaCode.getByHandle(handle, ctx.signal), { provider: "india-code" });
      if (item) await take(item);
    }

    // State Acts, newest first, resumable.
    const cursor = decode(ctx.cursor);
    try {
      for (const st of cfg.states as StateCode[]) {
        const cp = cursor.states[st] ?? { page: 0 };
        // A fully walked state only re-reads the newest pages (new and amended Acts appear first).
        let page = cp.complete ? 0 : cp.page;
        const lastPage = cp.complete ? 1 : Number.POSITIVE_INFINITY;
        while (page <= lastPage && done < cfg.maxActsPerRun && ctx.budgetLeft() > 0) {
          const res = await ctx.attempt(`${INDIA_CODE_STATE_NAMES[st] ?? st} Acts p${page}`, () => indiaCode.searchActs({ query: indiaCode.jurisdictionQuery(st), page, size: cfg.pageSize, signal: ctx.signal }), { provider: "india-code" });
          if (!res) break;
          let handledAll = true;
          for (const item of res.items) {
            if (done >= cfg.maxActsPerRun || ctx.budgetLeft() <= 0) { handledAll = false; break; }
            // Only Acts whose state name is this state are taken (the query is a text match).
            if ((mdValue(item.metadata, "dc.identifier.state_name") ?? "").toLowerCase() !== (INDIA_CODE_STATE_NAMES[st] ?? "").toLowerCase()) continue;
            await take(item);
          }
          if (!handledAll) break; // resume this page next run
          const finished = page + 1 >= res.page.totalPages || !res.items.length;
          if (!cp.complete) { cp.page = finished ? page : page + 1; if (finished) cp.complete = true; }
          if (finished) break;
          page++;
        }
        cursor.states[st] = cp;
      }
    } finally {
      ctx.result.nextCursor = JSON.stringify(cursor);
    }
    if (counts.notFound.length) ctx.note(`Not found on India Code by exact title: ${counts.notFound.join("; ")}`);
    ctx.note(`India Code: ${counts.ingested} Acts ingested, ${counts.skipped} unchanged, ${counts.failed} failed.`);
  },
});
