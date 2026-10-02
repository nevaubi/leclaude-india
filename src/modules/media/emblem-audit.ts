import "server-only";
import { courtById } from "@/lib/india/courts";
import { remoteStore, type RemoteStore } from "@/lib/db/remote";
import { ensureJudgesSchema, JudgesNotConfiguredError } from "@/modules/judges/schema";
import type { CourtEmblemInfo, CourtEmblemsResponse } from "@/modules/judges/shared";
import { getMedia } from "./store";
import { mediaUrl } from "./validate";
import { decideVisual, storedVisualFacts, visualFacts, type VisualVerdict } from "./visual-vision";
import { defaultClassifyVisual, type ClassifyVisual } from "./visuals";

/**
 * Re-audit of the court emblems and logos already stored in `court_assets` against the State Emblem policy: an image
 * that shows the State Emblem of India (Lion Capital of Ashoka) is hidden (court_assets.hidden = true, verdict recorded)
 * and the emblems API stops returning it. Images that cannot be checked (no vision model) are left as they are and
 * reported as unchecked.
 */

export interface EmblemAuditItem {
  courtId: string;
  kind: string;
  mediaId: string;
  status: "kept" | "hidden" | "unchecked" | "failed";
  reason: string;
  reused?: boolean;
}

export interface EmblemAuditReport {
  target: "emblems_audit";
  startedAt: string;
  finishedAt: string;
  items: EmblemAuditItem[];
  hidden: string[];
}

export interface EmblemAuditDeps {
  store?: RemoteStore | null;
  classify?: ClassifyVisual;
  now?: () => Date;
}

export async function auditCourtEmblems(deps: EmblemAuditDeps = {}): Promise<EmblemAuditReport> {
  const store = deps.store === undefined ? remoteStore() : deps.store;
  if (!store) throw new JudgesNotConfiguredError();
  await ensureJudgesSchema(store);
  const now = deps.now ?? (() => new Date());
  const classify = deps.classify ?? defaultClassifyVisual;
  const startedAt = now().toISOString();
  const rows = await store.query({ query: `SELECT court_id, kind, media_id FROM court_assets WHERE kind IN ('emblem', 'logo') ORDER BY court_id, kind` });
  const items: EmblemAuditItem[] = [];
  for (const r of rows) {
    const courtId = r.court_id!;
    const kind = r.kind!;
    const mediaId = r.media_id!;
    const subject = `the ${courtById(courtId)?.name ?? courtId}`;
    try {
      const media = await getMedia(mediaId, { store });
      if (!media) { items.push({ courtId, kind, mediaId, status: "failed", reason: "stored image not found" }); continue; }
      let verdict: VisualVerdict;
      let reused = false;
      const prior = storedVisualFacts(media.vision);
      if (prior) {
        verdict = decideVisual("emblem_audit", prior, media.vision?.model ?? null, now());
        reused = true;
      } else {
        const dataUrl = `data:${media.mime};base64,${Buffer.from(media.bytes).toString("base64")}`;
        const res = await classify(dataUrl, "emblem_audit", subject);
        if (!res) { items.push({ courtId, kind, mediaId, status: "unchecked", reason: "No vision model is configured; the emblem was not re-checked" }); continue; }
        verdict = decideVisual("emblem_audit", visualFacts(res.raw), res.model, now());
        // Recorded on the image too, so a later court-identity run reuses it instead of re-storing an emblem image.
        await store.query({ query: `UPDATE media_assets SET vision = $2::jsonb WHERE id = $1`, params: [mediaId, JSON.stringify(verdict)] });
      }
      const hidden = verdict.containsStateEmblem;
      await store.query({ query: `UPDATE court_assets SET hidden = $3, vision = $4::jsonb, checked_at = now() WHERE court_id = $1 AND kind = $2`, params: [courtId, kind, hidden, JSON.stringify(verdict)] });
      items.push({ courtId, kind, mediaId, status: hidden ? "hidden" : "kept", reason: verdict.reason, ...(reused ? { reused } : {}) });
    } catch (e) {
      items.push({ courtId, kind, mediaId, status: "failed", reason: (e as Error).message.slice(0, 300) });
    }
  }
  const report: EmblemAuditReport = { target: "emblems_audit", startedAt, finishedAt: now().toISOString(), items, hidden: items.filter((i) => i.status === "hidden").map((i) => i.courtId) };
  console.info(JSON.stringify({ level: "info", event: "enrichment.emblems_audit", hidden: report.hidden, items: items.map((i) => ({ c: i.courtId, s: i.status })) }));
  return report;
}

/** Court emblems/logos that may be shown: hidden rows and rows whose verdict found the State Emblem are left out. */
export async function visibleCourtEmblems(deps: { store?: RemoteStore | null } = {}): Promise<CourtEmblemsResponse> {
  const store = deps.store === undefined ? remoteStore() : deps.store;
  if (!store) throw new JudgesNotConfiguredError();
  await ensureJudgesSchema(store);
  const rows = await store.query({
    query: `SELECT court_id, kind, media_id, source_url, page_url FROM court_assets
            WHERE kind IN ('emblem', 'logo') AND hidden IS NOT TRUE AND COALESCE(vision->>'containsStateEmblem', 'false') <> 'true'
            ORDER BY court_id, CASE kind WHEN 'emblem' THEN 0 ELSE 1 END`,
  });
  const emblems: Record<string, CourtEmblemInfo> = {};
  for (const r of rows) {
    if (emblems[r.court_id!]) continue;
    emblems[r.court_id!] = { courtId: r.court_id!, kind: r.kind as CourtEmblemInfo["kind"], mediaId: r.media_id!, url: mediaUrl(r.media_id!), sourceUrl: r.source_url!, pageUrl: r.page_url };
  }
  return { emblems };
}
