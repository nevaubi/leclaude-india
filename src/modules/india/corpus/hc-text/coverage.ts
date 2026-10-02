import "server-only";
import { remoteStore, type RemoteStore } from "@/lib/db/remote";
import { courtById } from "@/lib/india/courts";
import { courtOrder, hcTextConfig } from "./config";
import { SqlHcTextRepo, type CoverageRow, type HcTextRepo, type QueueCounts } from "./repo";
import type { HcCoverage, HcCoverageCourt } from "./shared";

/**
 * Coverage of High Court judgments per court × decision year: records, records with text (Open India Law, PDF text
 * layer, OCR, partial), failed and metadata-only, with the latest update. One grouped scan, cached for 5 minutes per
 * process (concurrent callers share one refresh); a failed refresh serves the last good value marked stale.
 */

export const HC_COVERAGE_TTL_MS = 5 * 60_000;

let cache: { at: number; value: HcCoverage } | null = null;
let inflight: Promise<HcCoverage> | null = null;

export function resetHcCoverageCacheForTests() { cache = null; inflight = null; }

const order = () => new Map(courtOrder().map((id, i) => [id, i]));

export function shapeCoverage(rows: CoverageRow[], queue: QueueCounts | null, extra: Pick<HcCoverage, "dbBytes" | "limitBytes" | "ingestEnabled">): HcCoverage {
  const rank = order();
  const byCourt = new Map<string, HcCoverageCourt>();
  for (const r of rows) {
    let c = byCourt.get(r.courtId);
    if (!c) {
      const court = courtById(r.courtId);
      c = { courtId: r.courtId, name: court?.name ?? r.courtId, shortName: court?.shortName ?? r.courtId, priority: rank.get(r.courtId) ?? 999, countedAt: null, totals: emptyTotals(), years: [] };
      byCourt.set(r.courtId, c);
    }
    c.years.push(r);
    if (r.refreshedAt && (!c.countedAt || r.refreshedAt < c.countedAt)) c.countedAt = r.refreshedAt;
    for (const k of TOTAL_KEYS) c.totals[k] += r[k];
    if (r.lastUpdate && (!c.totals.lastUpdate || r.lastUpdate > c.totals.lastUpdate)) c.totals.lastUpdate = r.lastUpdate;
  }
  const courts = [...byCourt.values()].sort((a, b) => a.priority - b.priority || a.courtId.localeCompare(b.courtId));
  for (const c of courts) c.years.sort((a, b) => (b.year ?? -1) - (a.year ?? -1));
  const totals = emptyTotals();
  for (const c of courts) {
    for (const k of TOTAL_KEYS) totals[k] += c.totals[k];
    if (c.totals.lastUpdate && (!totals.lastUpdate || c.totals.lastUpdate > totals.lastUpdate)) totals.lastUpdate = c.totals.lastUpdate;
  }
  return { configured: true, courts, totals, queue, checkedAt: new Date().toISOString(), stale: false, ...extra };
}

const TOTAL_KEYS = ["judgments", "withText", "openIndiaLaw", "pdfText", "ocr", "partial", "failed", "metadataOnly"] as const;
function emptyTotals(): HcCoverageCourt["totals"] {
  return { judgments: 0, withText: 0, openIndiaLaw: 0, pdfText: 0, ocr: 0, partial: 0, failed: 0, metadataOnly: 0, lastUpdate: null };
}

const NOT_CONFIGURED: HcCoverage = { configured: false, courts: [], totals: emptyTotals(), queue: null, checkedAt: null, stale: false, dbBytes: null, limitBytes: null, ingestEnabled: false };

async function compute(repo: HcTextRepo): Promise<HcCoverage> {
  const cfg = hcTextConfig();
  const { judgments } = await repo.ensureSchema();
  if (!judgments) return { ...NOT_CONFIGURED, configured: true, checkedAt: new Date().toISOString(), ingestEnabled: cfg.enabled, limitBytes: cfg.maxDbBytes };
  const [rows, queue, dbBytes] = await Promise.all([repo.coverage(), repo.queueCounts().catch(() => null), repo.dbBytes().catch(() => null)]);
  return shapeCoverage(rows, queue, { dbBytes, limitBytes: cfg.maxDbBytes, ingestEnabled: cfg.enabled });
}

/** Never throws for a missing database (configured: false); a failed first refresh throws (the route answers 500). */
export async function hcCoverage(opts: { store?: RemoteStore | null; repo?: HcTextRepo; now?: number; fresh?: boolean } = {}): Promise<HcCoverage> {
  const store = opts.store === undefined ? remoteStore() : opts.store;
  if (!opts.repo && !store) return NOT_CONFIGURED;
  const now = opts.now ?? Date.now();
  if (!opts.fresh && cache && now - cache.at < HC_COVERAGE_TTL_MS) return cache.value;
  if (!inflight) {
    inflight = compute(opts.repo ?? new SqlHcTextRepo(store!))
      .then((value) => { cache = { at: Date.now(), value }; return value; })
      .catch((e) => {
        if (cache) return { ...cache.value, stale: true };
        throw e;
      })
      .finally(() => { inflight = null; });
  }
  return inflight;
}
