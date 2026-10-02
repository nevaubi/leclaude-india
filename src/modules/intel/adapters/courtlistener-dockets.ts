import "server-only";
import { z } from "zod";
import type { Matter } from "@/lib/types/domain";
import { courtIdFromName, courtMention, COURT_NAMES, dedupeMentions, jurisdictionForCourt, mention, mentionsFromCaption, mentionsFromCounselString, mentionsFromJudgeField } from "../mentions";
import type { IntelEntityMention } from "../types";
import { daysAgoISO } from "../providers/base";
import type { CLDocketHit } from "../providers/courtlistener";
import { defineAdapter, type AdapterContext } from "./types";

const schema = z.object({
  docketIds: z.array(z.number().int().positive()).default([]),
  /** Docket numbers ("3:25-md-03140"); resolved through search, optionally restricted to `courts`. */
  docketNumbers: z.array(z.string().min(3)).default([]),
  courts: z.string().optional(),
  /** Resolve dockets for the matters in scope by case name and court. */
  includeMatters: z.boolean().default(true),
  /** Include dockets from intel_watches (kind "docket"). */
  includeWatches: z.boolean().default(true),
  /** Explicit matter → CourtListener docket id map (skips search). */
  matterDockets: z.record(z.string(), z.number().int().positive()).default({}),
  maxEntries: z.number().int().min(1).max(200).default(50),
  entrySinceDays: z.number().int().min(1).max(3650).default(90),
});

export type CourtListenerDocketsConfig = z.infer<typeof schema>;

interface Target { docketId?: number; docketNumber?: string; matterIds: string[]; label: string; court?: string; hit?: CLDocketHit }

function matterCaseName(m: Matter): string {
  return m.name.replace(/^in re:?\s*/i, "").replace(/\s*\(.*?\)\s*$/, "").trim();
}

function similarity(a: string, b: string): number {
  const ta = new Set(a.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
  const tb = new Set(b.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
  if (!ta.size || !tb.size) return 0;
  let common = 0;
  for (const w of ta) if (tb.has(w)) common++;
  return common / Math.max(ta.size, tb.size);
}

async function resolveTargets(ctx: AdapterContext<CourtListenerDocketsConfig>): Promise<Target[]> {
  const cfg = ctx.config;
  const targets: Target[] = [];
  for (const id of cfg.docketIds) targets.push({ docketId: id, matterIds: [], label: `docket #${id}` });
  for (const n of [...cfg.docketNumbers, ...(ctx.scope.targets ?? [])]) if (/\d/.test(n)) targets.push({ docketNumber: n, matterIds: [], label: n, court: cfg.courts });
  if (cfg.includeWatches) {
    for (const w of ctx.watches.filter((w) => w.kind === "docket")) {
      if (/^\d+$/.test(w.target)) targets.push({ docketId: Number(w.target), matterIds: w.matterId ? [w.matterId] : [], label: w.label });
      else targets.push({ docketNumber: w.target.replace(/^cl:docket:/, ""), matterIds: w.matterId ? [w.matterId] : [], label: w.label });
    }
  }
  if (cfg.includeMatters) {
    for (const m of ctx.matters) {
      const mapped = cfg.matterDockets[m.id];
      if (mapped) { targets.push({ docketId: mapped, matterIds: [m.id], label: m.shortName }); continue; }
      const courtId = courtIdFromName(m.court);
      const mdl = m.caption?.match(/MDL\s*(?:No\.?)?\s*(\d{3,4})/i)?.[1];
      const query = mdl ? `"MDL ${mdl}" OR "${matterCaseName(m)}"` : `"${matterCaseName(m)}"`;
      const res = await ctx.attempt(`resolve docket for ${m.shortName}`, () => ctx.providers.courtlistener.searchDockets({ query, courts: courtId, limit: 5, signal: ctx.signal }), { provider: "courtlistener" });
      if (!res?.results.length) { ctx.note(`No CourtListener docket found for ${m.shortName}.`); continue; }
      const best = res.results.map((r) => ({ r, s: similarity(r.caseName, m.name) + (mdl && r.docketNumber?.includes(mdl) ? 0.5 : 0) })).sort((a, b) => b.s - a.s)[0];
      if (best.s < 0.2 || !best.r.docketId) { ctx.note(`Docket candidates for ${m.shortName} did not match well enough (best: ${best.r.caseName}).`); continue; }
      targets.push({ docketId: best.r.docketId, matterIds: [m.id], label: m.shortName, court: best.r.courtId, hit: best.r });
    }
  }
  // merge duplicates
  const byKey = new Map<string, Target>();
  for (const t of targets) {
    const key = t.docketId ? `id:${t.docketId}` : `no:${t.docketNumber!.toLowerCase()}`;
    const prev = byKey.get(key);
    if (prev) { prev.matterIds = Array.from(new Set([...prev.matterIds, ...t.matterIds])); prev.hit = prev.hit ?? t.hit; } else byKey.set(key, { ...t });
  }
  return Array.from(byKey.values());
}

function docketText(d: CLDocketHit): string {
  return [
    `${d.caseName}`,
    d.docketNumber ? `Docket No. ${d.docketNumber}` : "",
    d.courtId ? `Court: ${COURT_NAMES[d.courtId] ?? d.court ?? d.courtId}` : d.court ? `Court: ${d.court}` : "",
    d.assignedTo ? `Assigned to: ${d.assignedTo}` : "",
    d.referredTo ? `Referred to: ${d.referredTo}` : "",
    d.dateFiled ? `Date filed: ${d.dateFiled}` : "",
    d.dateTerminated ? `Date terminated: ${d.dateTerminated}` : "",
    d.natureOfSuit ? `Nature of suit: ${d.natureOfSuit}` : "",
    d.cause ? `Cause: ${d.cause}` : "",
    d.parties.length ? `\nParties\n${d.parties.map((p) => `• ${p}`).join("\n")}` : "",
    d.attorneys.length ? `\nCounsel\n${d.attorneys.map((a) => `• ${a}`).join("\n")}` : "",
  ].filter(Boolean).join("\n");
}

/** Watched and matter dockets: the docket header becomes a `docket` document and each entry a `docket_entry`. */
export const courtListenerDocketsAdapter = defineAdapter<CourtListenerDocketsConfig>({
  id: "courtlistener-dockets",
  name: "Docket watch (CourtListener/RECAP)",
  description: "Tracks watched dockets and the dockets of matters in scope; new entries become docket_entry documents.",
  kinds: ["docket", "docket_entry"],
  family: "courtlistener",
  requires: ["courtlistener"],
  configSchema: schema,
  defaults: schema.parse({}),
  async run(ctx) {
    const cfg = ctx.config;
    const targets = await resolveTargets(ctx);
    if (!targets.length) { ctx.note("No dockets to watch (add docket numbers, watches or matters in scope)."); return; }
    const entrySince = ctx.since ?? daysAgoISO(cfg.entrySinceDays, ctx.now);
    for (const t of targets) {
      if (ctx.budgetLeft() <= 0) break;
      let docket: CLDocketHit | undefined;
      if (t.docketId) docket = await ctx.attempt(`docket #${t.docketId}`, () => ctx.providers.courtlistener.getDocket(t.docketId!, { signal: ctx.signal, ttlMs: 6 * 3600_000 }), { provider: "courtlistener" });
      else {
        const res = await ctx.attempt(`find docket ${t.docketNumber}`, () => ctx.providers.courtlistener.searchDockets({ query: "", docketNumber: t.docketNumber, courts: t.court, limit: 3, signal: ctx.signal }), { provider: "courtlistener" });
        docket = res?.results[0];
        if (res && !docket) ctx.note(`Docket ${t.docketNumber} was not found on CourtListener.`);
      }
      if (!docket?.docketId) continue;
      // The docket endpoint omits parties and counsel; merge them from the search hit when we have one.
      if (t.hit) docket = { ...docket, parties: docket.parties.length ? docket.parties : t.hit.parties, attorneys: docket.attorneys.length ? docket.attorneys : t.hit.attorneys, assignedTo: docket.assignedTo ?? t.hit.assignedTo, referredTo: docket.referredTo ?? t.hit.referredTo, natureOfSuit: docket.natureOfSuit ?? t.hit.natureOfSuit, cause: docket.cause ?? t.hit.cause };
      const courtId = docket.courtId;
      const court = courtId ? COURT_NAMES[courtId] ?? docket.court : docket.court;
      const judgeMentions = mentionsFromJudgeField(docket.assignedTo);
      const entities: IntelEntityMention[] = dedupeMentions([
        ...judgeMentions,
        ...mentionsFromJudgeField(docket.referredTo).map((m) => ({ ...m, role: "magistrate" })),
        ...mentionsFromCaption(docket.caseName),
        ...docket.parties.slice(0, 20).map((p) => mention("party", p)),
        ...docket.attorneys.slice(0, 20).flatMap((a) => mentionsFromCounselString(a)),
        courtMention(court, courtId),
      ]);
      const docketExternalId = `cl:docket:${docket.docketId}`;
      const header = await ctx.attempt(`ingest docket ${docket.docketNumber ?? docket.docketId}`, () => ctx.ingest({
        kind: "docket",
        title: `${docket!.caseName}${docket!.docketNumber ? ` (${docket!.docketNumber})` : ""}`,
        caseName: docket!.caseName,
        docketNumber: docket!.docketNumber,
        court, courtId,
        jurisdiction: jurisdictionForCourt(courtId),
        dates: { filed: docket!.dateFiled, event: docket!.dateTerminated ?? undefined, modified: ctx.now.toISOString().slice(0, 10) },
        url: docket!.url,
        externalId: docketExternalId,
        matterIds: t.matterIds,
        text: docketText(docket!),
        tags: ["docket"],
        entities,
        confidence: 0.9,
        meta: { docketId: docket!.docketId, assignedTo: docket!.assignedTo, referredTo: docket!.referredTo, natureOfSuit: docket!.natureOfSuit, cause: docket!.cause, parties: docket!.parties.slice(0, 40), attorneys: docket!.attorneys.slice(0, 40), watchLabel: t.label },
      }));
      if (!header) continue;
      const entries = await ctx.attempt(`entries for ${docket.docketNumber ?? docket.docketId}`, () => ctx.providers.courtlistener.getDocketEntries(docket!.docketId!, { since: entrySince, limit: cfg.maxEntries, signal: ctx.signal }), { provider: "courtlistener" });
      for (const e of entries ?? []) {
        if (ctx.budgetLeft() <= 0) break;
        if (!e.description && !e.documents.length) continue;
        const label = e.entryNumber != null ? `Dkt. ${e.entryNumber}` : "Docket entry";
        const docs = e.documents.filter((d) => d.description || d.url);
        await ctx.attempt(`ingest ${label}`, () => ctx.ingest({
          kind: "docket_entry",
          title: `${label}: ${(e.description || docs[0]?.description || "Entry").replace(/\s+/g, " ").slice(0, 140)}`,
          caseName: docket!.caseName,
          docketNumber: docket!.docketNumber,
          court, courtId,
          jurisdiction: jurisdictionForCourt(courtId),
          dates: { filed: e.dateFiled, event: e.dateFiled },
          url: docs[0]?.url ?? docket!.url,
          externalId: e.id != null ? `cl:entry:${e.id}` : `cl:entry:${docket!.docketId}:${e.entryNumber ?? e.dateFiled ?? "x"}`,
          matterIds: t.matterIds,
          text: [`${docket!.caseName} — ${label}${e.dateFiled ? ` (${e.dateFiled})` : ""}`, e.description, docs.length ? `\nDocuments\n${docs.map((d) => `• ${d.description ?? "Document"}${d.pageCount ? ` (${d.pageCount} pp.)` : ""}${d.available ? " [available]" : ""}`).join("\n")}` : ""].filter(Boolean).join("\n"),
          summary: e.description?.slice(0, 400),
          tags: ["docket-entry"],
          entities: dedupeMentions([...judgeMentions, courtMention(court, courtId)]),
          confidence: 0.9,
          meta: { docketId: docket!.docketId, docketDocId: header.doc.id, entryId: e.id, entryNumber: e.entryNumber, documents: docs.slice(0, 5) },
        }));
      }
    }
  },
});
