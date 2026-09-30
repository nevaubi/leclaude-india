import "server-only";
import { runAgent, strictJsonSchema } from "@/lib/ai/agent";
import { aiConfig } from "@/lib/ai/config";
import { researchToolset } from "@/lib/ai/toolkit";
import { LEGAL_STYLE_RULES } from "@/lib/ai/prompts";
import { firmLabel } from "@/modules/search/firm";
import { attachProvenance, recordGeneration, verifyNarrative } from "@/lib/integrity/record";
import type { Provenance, ProvenanceSource } from "@/lib/integrity/types";
import { collectBriefFacts, computeFallbackBrief, briefStats, renderFactsForModel } from "./brief-fallback";
import { buildBriefContext, cacheBrief } from "./service";
import { currentUser } from "@/lib/current-user";
import { type BriefItem, type DailyBrief } from "./types";
import { dateKey } from "./time";

const BRIEF_SCHEMA = strictJsonSchema({
  type: "object",
  properties: {
    headline: { type: "string", description: "One line, ≤ 90 characters, the shape of the day." },
    items: {
      type: "array",
      description: "6 to 10 bullets, most urgent first.",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["deadline", "hearing", "task", "news", "update", "matter", "note"] },
          text: { type: "string", description: "One or two sentences. Specific: names, dates, Bates or docket numbers when given." },
          matterId: { type: "string", description: "Matter id when the bullet concerns one matter" },
          href: { type: "string", description: "In-app link: /#calendar, /#tasks, /#news, /#updates, /matters?id=<id>, or the news URL" },
        },
        required: ["kind", "text"],
      },
    },
    confidence: { type: "number", description: "0..1 calibrated confidence that every bullet is grounded in the facts provided (dates, counts and names exact)." },
  },
  required: ["headline", "items", "confidence"],
});

interface BriefJson { headline: string; items: { kind: BriefItem["kind"]; text: string; matterId?: string | null; href?: string | null }[]; confidence?: number }

/** The brief as returned by the API: the shared DailyBrief plus its provenance (TrustBadge reads `provenance`). */
export type DailyBriefRecord = DailyBrief & { provenance?: Provenance };

/**
 * Generate the AI daily brief with the fast model and the internal research
 * toolset (library, e-discovery, matter context). Throws AIConfigError when
 * no key is configured; callers fall back to computeFallbackBrief.
 *
 * Integrity: the brief is claim-verified against the facts it was given
 * (calendar, tasks, key dates, news, updates); bullets are source-backed by
 * those facts and the provenance is audited and stored under home.brief.
 */
export async function generateDailyBrief(opts: { now?: Date; userId?: string; signal?: AbortSignal; verify?: boolean } = {}): Promise<DailyBriefRecord> {
  const now = opts.now ?? new Date();
  const userId = opts.userId ?? currentUser().id;
  const ctx = buildBriefContext(now, userId);
  const facts = collectBriefFacts(ctx);
  const cfg = aiConfig();
  const { tools } = researchToolset({ web: false, legal: false, internal: true });

  const instructions = [
    `You write the morning brief for ${ctx.userName || "the user"}, a lawyer at ${firmLabel()}. Today is ${facts.today}.`,
    "Produce a headline and 6–10 bullets that a busy litigator can act on before 9 a.m. Order: today's calendar, overdue and due-soon tasks, matter deadlines in the next 30 days, hearings/depositions later this week, hot news that changes strategy, then team updates that need a reply.",
    "Every bullet must be grounded in the facts provided (or in a tool result). Use names, dates, docket/CMO references and Bates numbers exactly as given. Say 'in 3 days' / 'overdue 2 days' rather than raw dates where it helps. No filler, no motivational language.",
    "Use get_matter_context only if you need a detail that is missing from the facts. Do not search the library or e-discovery unless a bullet requires it.",
    "Report a calibrated confidence: lower it when you had to infer anything the facts do not state.",
    LEGAL_STYLE_RULES,
  ].join("\n\n");

  const factsText = renderFactsForModel(ctx, facts);
  const toolEvidence: { title: string; text: string }[] = [];
  const result = await runAgent({
    instructions,
    input: factsText,
    tools,
    model: cfg.fastModel,
    reasoningEffort: "low",
    maxSteps: 3,
    maxOutputTokens: 1800,
    jsonSchema: { name: "daily_brief", schema: BRIEF_SCHEMA },
    metadata: { app: "leclaude", surface: "home-brief" },
    signal: opts.signal,
    onEvent: (e) => { if (e.type === "tool.result" && e.ok && e.result != null) toolEvidence.push({ title: `tool ${e.name}`, text: (typeof e.result === "string" ? e.result : JSON.stringify(e.result)).slice(0, 8000) }); },
  });

  const json = (result.json ?? safeParse(result.text)) as BriefJson | undefined;
  if (!json?.items?.length) {
    // Model returned nothing usable; keep the card populated.
    return { ...computeFallbackBrief(ctx), model: cfg.fastModel };
  }
  const date = dateKey(now);
  const target = { kind: "home.brief", id: date, label: `Daily brief ${date}` };
  const sources: ProvenanceSource[] = [
    ...facts.eventsToday.map((e) => ({ kind: "internal" as const, id: e.id, title: `event: ${e.title}` })),
    ...facts.overdue.map((t) => ({ kind: "internal" as const, id: t.id, title: `task: ${t.title}` })),
    ...facts.dueSoon.map((t) => ({ kind: "internal" as const, id: t.id, title: `task: ${t.title}` })),
    ...facts.keyDatesSoon.map((k) => ({ kind: "internal" as const, id: k.matter.id, title: `key date: ${k.matter.shortName} ${k.label}` })),
    ...facts.hotNews.slice(0, 8).map((n) => ({ kind: "web" as const, id: n.id, url: n.url, title: n.title })),
    ...facts.recentUpdates.slice(0, 10).map((u) => ({ kind: "internal" as const, id: u.id, title: "team update" })),
  ];
  let provenance = recordGeneration({ surface: "home.brief", instructions, input: factsText, sources, confidence: json.confidence, model: cfg.fastModel, usage: result.usage, target, meta: { items: json.items.length, toolCalls: result.toolCalls.length } });
  const items = json.items.slice(0, 10).map((it) => ({ kind: it.kind ?? "note", text: it.text.trim(), matterId: it.matterId ?? null, href: it.href ?? null }));
  const verified = await verifyNarrative(provenance, { answer: `${json.headline}\n${items.map((i) => `- ${i.text}`).join("\n")}`, sources: [{ title: "Facts", text: factsText }, ...toolEvidence], verify: opts.verify, signal: opts.signal, maxClaims: 20 }, target);
  provenance = verified.provenance;
  const brief: DailyBriefRecord = {
    date,
    generatedAt: now.toISOString(),
    source: "ai",
    model: cfg.fastModel,
    headline: json.headline?.trim() || computeFallbackBrief(ctx).headline,
    items,
    stats: briefStats(facts),
    provenance,
  };
  attachProvenance({ kind: "home.brief", recordId: date, title: `Daily brief — ${date}`, href: "/", provenance });
  cacheBrief(brief);
  return brief;
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return undefined; }
}
