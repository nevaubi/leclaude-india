import "server-only";
import { searchIntel, getDocumentText } from "@/modules/intel/store";
import type { IntelDocumentKind, IntelSearchHit } from "@/modules/intel/types";
import { intelConfig } from "@/modules/intel/config";
import { INDIAN_KANOON_ENV } from "./indian-kanoon";
import { LICENSED_EXPORT_ENV } from "./licensed";
import { getJudgment, indiaJudgments, indiaEnactments } from "./store";
import type { IndiaConnectorStatus, StoredEnactment, StoredJudgment } from "./types";

/**
 * Public surface of the India source layer for the research engine and the UI.
 *
 * - Records: `listJudgments`, `getJudgment`, `findJudgment`, `judgmentText`, `listEnactments`, `getEnactment`,
 *   `getSections`, `getSection` (exact section number; null when absent).
 * - Retrieval: `searchIndianAuthorities` — hybrid search over the ingested judgments and Acts (the intel index), with
 *   every hit mapped back to its judgment or enactment record and carrying its court id (or `unresolvedCourt`).
 * - Connectors: `indiaConnectorStatuses()` for Settings; `ecourtsCnrLink` for the manual eCourts lookup.
 * Authorization: these are public-law records (no matter data); matter-scoped callers still pass `matterId` filters
 * only through the intel search options, never widen them.
 */
export { listJudgments, getJudgment, findJudgment, listEnactments, getEnactment, getSections, getSection, getOriginalFile } from "./store";
export { ecourtsCnrLink, isValidCnr, normalizeCnr } from "./ecourts";
export type { StoredJudgment, StoredEnactment, StoredEnactmentSection, IndiaConnectorStatus, IndiaConnectorState } from "./types";

/** Full text of record of a judgment (header + extracted PDF/provider text), or null when not stored. */
export function judgmentText(id: string): string | null {
  const j = getJudgment(id);
  return j?.intelDocId ? getDocumentText(j.intelDocId) : null;
}

export interface IndianAuthorityHit {
  kind: "judgment" | "enactment";
  judgment?: StoredJudgment;
  enactment?: StoredEnactment;
  hit: IntelSearchHit;
}

/** Hybrid search over Indian judgments and Acts; `courtIds` narrows judgments to registry courts (unresolved courts never match a court filter). */
export async function searchIndianAuthorities(q: string, o: { courtIds?: string[]; kinds?: ("judgment" | "enactment")[]; from?: string; to?: string; limit?: number } = {}): Promise<IndianAuthorityHit[]> {
  const kinds = (o.kinds ?? ["judgment", "enactment"]).map((k): IntelDocumentKind => (k === "judgment" ? "opinion" : "statute"));
  const limit = Math.max(1, Math.min(o.limit ?? 20, 100));
  const hits = await searchIntel({ q, kinds, dateFrom: o.from, dateTo: o.to, limit: limit * 3 });
  const byDoc = new Map(indiaJudgments().all().filter((j) => j.intelDocId).map((j) => [j.intelDocId!, j]));
  const actsByDoc = new Map(indiaEnactments().all().filter((e) => e.intelDocId).map((e) => [e.intelDocId!, e]));
  const out: IndianAuthorityHit[] = [];
  for (const hit of hits) {
    const judgment = byDoc.get(hit.doc.id);
    const enactment = actsByDoc.get(hit.doc.id);
    if (judgment) {
      if (o.courtIds?.length && !(judgment.courtId && o.courtIds.includes(judgment.courtId))) continue;
      out.push({ kind: "judgment", judgment, hit });
    } else if (enactment) out.push({ kind: "enactment", enactment, hit });
    if (out.length >= limit) break;
  }
  return out;
}

/** Connector states for Settings (no secrets; environment-based only — per-source licence state is on the source). */
export function indiaConnectorStatuses(env: Readonly<Record<string, string | undefined>> = process.env): IndiaConnectorStatus[] {
  const offline = intelConfig().offline;
  const pub = (source: IndiaConnectorStatus["source"]): IndiaConnectorStatus => (offline ? { source, state: "offline", reason: "INTEL_OFFLINE is set." } : { source, state: "ready" });
  return [
    pub("sci-open-data"),
    pub("hc-open-data"),
    pub("india-code"),
    env[INDIAN_KANOON_ENV]?.trim() ? (offline ? { source: "indian-kanoon", state: "offline", envVar: INDIAN_KANOON_ENV } : { source: "indian-kanoon", state: "ready", envVar: INDIAN_KANOON_ENV }) : { source: "indian-kanoon", state: "not_configured", envVar: INDIAN_KANOON_ENV, reason: "Paid API: set the firm's token." },
    { source: "scc-online", state: "license_required", envVar: LICENSED_EXPORT_ENV["scc-online"], reason: "Subscription service: enable the source with the firm's licence and an export folder or licensed API. Never scraped." },
    { source: "manupatra", state: "license_required", envVar: LICENSED_EXPORT_ENV.manupatra, reason: "Subscription service: enable the source with the firm's licence and an export folder or licensed API. Never scraped." },
    { source: "ecourts", state: "disabled", reason: "Case status sits behind a captcha; only a manual CNR lookup link is offered." },
  ];
}
