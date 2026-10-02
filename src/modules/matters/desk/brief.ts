import "server-only";
import { createHash } from "node:crypto";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { audit } from "@/lib/integrity/audit";
import { currentPrincipal } from "@/lib/auth/context";
import { AIConfigError } from "@/lib/ai/config";
import { runAgent, type AgentEvent, type RunAgentOptions, type RunAgentResult } from "@/lib/ai/agent";
import { researchToolset } from "@/lib/ai/toolkit";
import type { SearchResultBlock } from "@/lib/ai/providers/types";
import type { Task } from "@/lib/types/domain";
import { ServiceError } from "@/modules/workspace/errors";
import { sourceRef } from "@/modules/official/types";
import type { listingsForMatters, ordersForIdentifiers, readOfficialDocument } from "@/modules/official/service";
import { formatCaseNumber, courtName } from "../india";
import { composeBriefMarkdown, collectToolSources, emptyLookupLine, expandNumberedRefs, resolveClaims, type LookupCheck, type RawBriefClaim } from "./brief-format";
import { addDays, indiaToday } from "./dates";
import { getTracking, listActionSets, listManualHearings, matterListings, matterOrders, readOrderText, requireMatter } from "./server";
import type { BriefSource, BriefStreamEvent, HearingBrief, MatterListing } from "./types";

/**
 * Hearing brief (server-only). Deterministic sections (listing as published, last orders, pending compliance) come
 * from records; a bounded research run (the Indian legal research toolset, which includes the official-sources tools
 * when they are registered) writes the points, authorities and questions, each citing refs that are then resolved
 * against what was supplied or returned by a tool in the same run (./brief-format.ts). Briefs are stored per matter in
 * `matter_briefs`, each bound to the SHA-256 of its markdown; a new run is a new version.
 */

export const BRIEFS = "matter_briefs";
const briefs = () => db().collection<HearingBrief>(BRIEFS);

export function listBriefs(matterId: string): HearingBrief[] {
  return briefs().find((b) => b.matterId === matterId).sort((a, b) => b.version - a.version);
}

const BRIEF_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "object", additionalProperties: false, properties: { text: { type: "string" }, sources: { type: "array", items: { type: "string" } } }, required: ["text", "sources"] },
    points: { type: "array", maxItems: 12, items: { type: "object", additionalProperties: false, properties: { text: { type: "string" }, sources: { type: "array", items: { type: "string" } } }, required: ["text", "sources"] } },
    authorities: { type: "array", maxItems: 10, items: { type: "object", additionalProperties: false, properties: { text: { type: "string" }, sources: { type: "array", items: { type: "string" } } }, required: ["text", "sources"] } },
    questions: { type: "array", maxItems: 10, items: { type: "object", additionalProperties: false, properties: { text: { type: "string" }, sources: { type: "array", items: { type: "string" } } }, required: ["text", "sources"] } },
  },
  required: ["summary", "points", "authorities", "questions"],
} as const;

type RawBrief = { summary: RawBriefClaim | string | null; points: RawBriefClaim[]; authorities: RawBriefClaim[]; questions: RawBriefClaim[] };

const INSTRUCTIONS = [
  "You prepare a short hearing brief for an Indian litigator from the matter record below and the supplied orders.",
  "Use the research tools to find authorities relevant to what the next hearing will deal with (search, then read or citator-check what you rely on). Prefer binding authority of the forum's High Court and the Supreme Court; note adverse authority you find.",
  "Output JSON only: summary (text: 3-5 sentences on where the matter stands, with its sources), points (what to address at the hearing), authorities (one per item: the citation and the proposition it supports), questions (what to prepare or confirm).",
  "Every item lists in `sources` the exact references it relies on: the src:// refs of the supplied orders, or the `source` / `id` / `ref` values the tools returned. Never invent a reference or a citation; an authority you did not get from a tool must not be listed. If the record does not establish something, say so instead of guessing.",
  "Do not compute deadlines; pending compliance and dates are already listed from the record.",
].join("\n");

export type BriefAgent = (opts: Pick<RunAgentOptions, "instructions" | "input" | "evidence" | "signal" | "onEvent" | "matterId">) => Promise<Pick<RunAgentResult, "json" | "text" | "toolCalls">>;

const defaultAgent: BriefAgent = async (opts) => {
  const { tools } = researchToolset({ web: false, legal: true, internal: false });
  return runAgent({
    ...opts, tools, maxSteps: 8, reasoningEffort: "medium", maxOutputTokens: 6000, taskType: "draft", privacy: "internal",
    jsonSchema: { name: "hearing_brief", schema: BRIEF_SCHEMA as unknown as Record<string, unknown> },
  });
};

function splitBlocks(text: string, size = 1400): string[] {
  const out: string[] = [];
  const paras = text.split(/\n{2,}/);
  let cur = "";
  for (const p of paras) {
    if ((cur + "\n\n" + p).length > size && cur) { out.push(cur); cur = ""; }
    if (p.length > size) { for (let i = 0; i < p.length; i += size) out.push(p.slice(i, i + size)); continue; }
    cur = cur ? `${cur}\n\n${p}` : p;
  }
  if (cur) out.push(cur);
  return out.filter((s) => s.trim());
}

/** Time allowed for the research step; the brief route's maxDuration is 300 s and the record reads come first. */
export const BRIEF_RESEARCH_BUDGET_MS = 200_000;

export interface BriefDeps {
  listings?: typeof listingsForMatters;
  orders?: typeof ordersForIdentifiers;
  read?: typeof readOfficialDocument;
  agent?: BriefAgent;
  now?: Date;
  researchBudgetMs?: number;
}

/** Generate, store and return a hearing brief, streaming stage / tool events through `emit`. */
export async function generateHearingBrief(matterId: string, opts: { listingId?: string | null }, emit: (e: BriefStreamEvent) => void, signal: AbortSignal | undefined, deps: BriefDeps = {}): Promise<HearingBrief> {
  const matter = requireMatter(matterId);
  const principal = currentPrincipal();
  const who = principal ? { id: principal.id, name: principal.name } : { id: "unknown", name: "Unknown" };
  const today = indiaToday(deps.now);
  const notes: string[] = [];
  // Inputs that could not be checked make the brief partial, whatever the research step does.
  let degraded = false;

  emit({ type: "stage", stage: "context", label: "Reading the matter and its listings" });
  const tracking = getTracking(matterId);
  const listed = await matterListings(matterId, today, addDays(today, 30), { listings: deps.listings, read: deps.read });
  let listing: MatterListing | null = null;
  if (opts.listingId) {
    listing = listed.listings.find((l) => l.id === opts.listingId) ?? null;
    // A requested listing that is not this matter's is an error, never replaced by another listing.
    if (!listing) throw new ServiceError(404, "That listing is not among this matter's listings for the next 30 days.", undefined, "listing_not_found");
  } else {
    listing = listed.listings[0] ?? null;
  }
  const listingCheck: LookupCheck = { state: listed.state, ...(listed.untracked ? { untracked: true } : {}) };
  if (listed.state !== "ok") { degraded = true; notes.push(`Cause lists could not be checked (${listed.state.replace("_", " ")}).`); }
  else if (listed.untracked) notes.push("No case number or diary number the official sources can match is tracked for this matter, so listings and orders were not looked up.");
  if (listed.unmatchable.length) notes.push(`Not checked against cause lists or orders (kept for reference only): ${listed.unmatchable.map((i) => i.printed).join("; ")}.`);
  const manual = listing ? null : listManualHearings(matterId, { from: today, to: addDays(today, 30) })[0] ?? null;

  emit({ type: "stage", stage: "orders", label: "Reading the last orders" });
  const registry = new Map<string, BriefSource>();
  const evidence: SearchResultBlock[] = [];
  const ordersRes = await matterOrders(matterId, { orders: deps.orders }, { limit: 10 });
  const ordersCheck: LookupCheck = { state: ordersRes.state, ...(ordersRes.untracked ? { untracked: true } : {}) };
  if (ordersRes.state !== "ok") { degraded = true; notes.push(`Orders could not be checked (${ordersRes.state.replace("_", " ")}).`); }
  const lastOrders = ordersRes.orders.slice(0, 3);
  for (const o of lastOrders) {
    const read = await readOrderText(o.document.id, { read: deps.read }, 14_000).catch(() => null);
    if (!read?.chunks.length) { degraded = true; notes.push(`The text of "${o.document.title}" is not available; it is listed but was not read.`); continue; }
    if (!read.complete) notes.push(`Only the first part of "${o.document.title}" was read for this brief.`);
    for (const c of read.chunks) {
      const ref = sourceRef(o.document.id, { page: c.pageStart });
      const title = `${o.document.title}${o.document.docDate ? ` (${o.document.docDate})` : ""}${c.pageStart ? `, p. ${c.pageStart}` : ""}`;
      if (!registry.has(ref)) registry.set(ref, { ref, title, url: o.document.fileUrl ?? o.document.url, state: "supplied" });
      const existing = evidence.find((e) => e.source === ref);
      if (existing) existing.content.push(...splitBlocks(c.text));
      else evidence.push({ type: "search_result", source: ref, title, content: splitBlocks(c.text), citationsEnabled: true });
    }
  }
  const compliance = db().tasks.find((t: Task) => t.matterId === matterId && t.status !== "done" && (t.tags ?? []).includes("order-action")).sort((a, b) => (a.dueAt ?? "9999").localeCompare(b.dueAt ?? "9999"));
  const pendingReview = listActionSets(matterId).filter((s) => s.status === "pending_review").length;

  const caseNumber = formatCaseNumber(matter.india?.caseType, matter.india?.caseNumber, matter.india?.caseYear) || undefined;
  const court = matter.court || courtName(matter.india?.courtId) || undefined;
  const context = [
    `MATTER: ${matter.name}${matter.caption ? ` (${matter.caption})` : ""}`,
    `Court: ${court ?? "not recorded"} · Case no.: ${caseNumber ?? "not recorded"} · Stage: ${matter.stage ?? "not recorded"} · Client side: ${matter.clientSide}`,
    tracking?.identifiers.length ? `Tracked identifiers: ${tracking.identifiers.map((i) => `${i.printed} (${i.forum})`).join("; ")}` : "Tracked identifiers: none",
    listing ? `NEXT LISTING: ${listing.entry.listDate}, court ${listing.entry.courtNo ?? "?"}, item ${listing.entry.itemNo ?? "?"}, bench ${listing.entry.bench ?? "not printed"}, ${listing.entry.listType} list. Entry as printed: ${listing.entry.raw.slice(0, 600)}` : manual ? `NEXT HEARING (entered by hand): ${manual.date}${manual.purpose ? `, ${manual.purpose}` : ""}${listingCheck.state !== "ok" ? `. ${emptyLookupLine("listing", listingCheck)}` : ""}` : `NEXT LISTING: ${emptyLookupLine("listing", listingCheck)}`,
    `LAST ORDERS (supplied as sources): ${lastOrders.map((o) => `${o.document.docDate ?? "undated"} ${o.document.title}`).join("; ") || emptyLookupLine("orders", ordersCheck)}`,
    `PENDING COMPLIANCE: ${compliance.map((t) => `${t.title}${t.dueAt ? ` (due ${t.dueAt})` : ""}`).join("; ") || "none recorded"}`,
    matter.description ? `NOTES: ${matter.description.slice(0, 2000)}` : "",
  ].filter(Boolean).join("\n");

  emit({ type: "stage", stage: "research", label: "Researching authorities" });
  let raw: RawBrief | null = null;
  const sent = evidence.slice(0, 40);
  let toolCalls: { name: string; result?: unknown }[] = [];
  // The research step gets a budget below the route's limit: running out keeps the record sections (partial brief).
  const budget = AbortSignal.timeout(deps.researchBudgetMs ?? BRIEF_RESEARCH_BUDGET_MS);
  const researchSignal = signal ? AbortSignal.any([signal, budget]) : budget;
  try {
    const r = await (deps.agent ?? defaultAgent)({
      instructions: INSTRUCTIONS, input: context, evidence: sent, signal: researchSignal, matterId,
      onEvent: (e: AgentEvent) => {
        if (e.type === "tool.call") emit({ type: "tool", name: e.name, label: e.label });
        else if (e.type === "tool.result") emit({ type: "tool", name: e.name, label: e.name, ok: e.ok });
      },
    });
    toolCalls = r.toolCalls ?? [];
    raw = (r.json as RawBrief | undefined) ?? (() => { try { return JSON.parse(r.text) as RawBrief; } catch { return null; } })();
    if (!raw) notes.push("The research step returned no usable output; only the record sections are included.");
  } catch (e) {
    if (e instanceof AIConfigError) throw e;
    // Stopped by the user: nothing is saved. Out of time: the record sections are saved as a partial brief.
    if (signal?.aborted) throw e;
    if (budget.aborted) notes.push(`The research step ran out of its ${Math.round((deps.researchBudgetMs ?? BRIEF_RESEARCH_BUDGET_MS) / 1000)} s budget; only the record sections are included.`);
    else notes.push(`The research step failed (${(e as Error)?.message ?? String(e)}); only the record sections are included.`);
  }

  emit({ type: "stage", stage: "verify", label: "Checking every reference" });
  for (const [ref, s] of collectToolSources(toolCalls)) if (!registry.has(ref)) registry.set(ref, s);
  const refs = sent.map((e) => e.source);
  const summary: RawBriefClaim | null = typeof raw?.summary === "string" ? { text: raw.summary, sources: [] } : raw?.summary && typeof raw.summary.text === "string" ? { text: raw.summary.text, sources: Array.isArray(raw.summary.sources) ? raw.summary.sources : [] } : null;
  const resolved = resolveClaims([
    { section: "summary", claims: expandNumberedRefs(summary?.text.trim() ? [summary] : [], refs) },
    { section: "points", claims: expandNumberedRefs(raw?.points ?? [], refs) },
    { section: "authorities", claims: expandNumberedRefs(raw?.authorities ?? [], refs) },
    { section: "questions", claims: expandNumberedRefs(raw?.questions ?? [], refs) },
  ], registry);
  const unsupported = resolved.claims.filter((c) => c.status === "unsupported").length;
  if (unsupported) notes.push(`${unsupported} item${unsupported === 1 ? " is" : "s are"} not linked to any source and must be verified before use.`);

  const version = listBriefs(matterId).reduce((n, b) => Math.max(n, b.version), 0) + 1;
  const markdown = composeBriefMarkdown({
    matterName: matter.shortName || matter.name, caption: matter.caption, caseNumber, court, preparedOn: today, version,
    listing: listing ? { entry: listing.entry, matchedOn: { ...listing.matchedOn, printed: tracking?.identifiers.find((i) => i.value === listing!.matchedOn.value && i.kind === listing!.matchedOn.kind)?.printed }, sourceUrl: listing.source?.url ?? null } : null,
    manualHearing: manual, listingCheck,
    orders: ordersRes.orders.slice(0, 5).map((o) => ({ title: o.document.title, date: o.document.docDate, url: o.document.fileUrl ?? o.document.url })), ordersCheck,
    compliance: compliance.map((t) => ({ title: t.title, dueAt: t.dueAt })), pendingReview,
    claims: resolved.claims, sources: resolved.sources, notes,
  });
  const brief: HearingBrief = {
    id: `hb_${nanoid(10)}`, matterId, version, hash: createHash("sha256").update(markdown).digest("hex"),
    listingId: listing?.id ?? null, listingDate: listing?.entry.listDate ?? manual?.date ?? null, markdown,
    claims: resolved.claims, sources: resolved.sources, status: raw && !degraded ? "succeeded" : "partial", notes,
    createdAt: new Date().toISOString(), createdBy: who.id,
  };
  briefs().put(brief);
  audit("ai.generate", { kind: "hearing_brief", id: brief.id, label: `Hearing brief v${version}`, matterId }, { hash: brief.hash, listingId: brief.listingId, claims: brief.claims.length, unsupported, status: brief.status, tools: toolCalls.length }, who);
  emit({ type: "stage", stage: "saved", label: "Saved" });
  return brief;
}
