import "server-only";
import { courtById } from "@/lib/india/courts";
import { remoteStore, type RemoteStore, type Row } from "@/lib/db/remote";
import { parseArray } from "@/modules/india/corpus/search";
import { mediaUrl } from "@/modules/media/validate";
import { isJudgeId, normalizeJudgeName } from "./names";
import { ensureJudgesSchema, JudgesNotConfiguredError } from "./schema";
import type {
  CoramResponse, CourtEmblemInfo, CourtEmblemsResponse, CourtJudgeCount, JudgeJudgment, JudgeJudgments, JudgePhoto, JudgeProfileResponse, JudgesListResponse, JudgeStatus, JudgeSummary, LastRunInfo,
} from "./shared";
import { ROSTER_SOURCES } from "./sources";

/**
 * Read side of the judges directory. Judge ↔ judgment links are exact: a judgment is counted for a judge only when one
 * of its coram names, as printed in the record, normalizes to the judge's normalized name AND the judgment is from the
 * judge's court. Nothing is matched across courts, by initials, or by similarity.
 */

function requireStore(store?: RemoteStore | null): RemoteStore {
  const s = store === undefined ? remoteStore() : store;
  if (!s) throw new JudgesNotConfiguredError();
  return s;
}

const STATUSES: JudgeStatus[] = ["sitting", "off_roster", "former"];

function photoOf(r: Row): JudgePhoto | null {
  if (!r.photo_media_id) return null;
  let alt: string | null = null;
  try { alt = r.photo_vision ? ((JSON.parse(r.photo_vision) as { alt?: string | null }).alt ?? null) : null; } catch { alt = null; }
  return { mediaId: r.photo_media_id, url: mediaUrl(r.photo_media_id), sourceUrl: r.photo_source_url, alt };
}

function summary(r: Row): JudgeSummary {
  return {
    id: r.id!, courtId: r.court_id!, court: courtById(r.court_id)?.name ?? null, name: r.name!, designation: r.designation,
    status: (STATUSES as string[]).includes(r.status ?? "") ? (r.status as JudgeStatus) : "sitting",
    dateOfAppointment: r.date_of_appointment, retirementDate: r.retirement_date, termExpires: r.term_expires, photo: photoOf(r),
  };
}

const JUDGE_COLS = `id, court_id, name, printed_name, designation, status, date_of_appointment::text AS date_of_appointment, retirement_date::text AS retirement_date,
  term_expires::text AS term_expires, photo_media_id, photo_source_url, photo_vision, profile_url, source_url, source_title, checked_at::text AS checked_at, first_seen_at::text AS first_seen_at`;

async function lastRun(store: RemoteStore): Promise<LastRunInfo | null> {
  const r = await store.query({ query: `SELECT value, updated_at::text AS at FROM enrichment_state WHERE key = 'last_run'` });
  if (!r[0]?.value) return null;
  try {
    const v = JSON.parse(r[0].value) as { target?: string; stop?: string; finishedAt?: string };
    return { at: v.finishedAt ?? r[0].at ?? "", target: v.target ?? "", stop: v.stop ?? "" };
  } catch { return null; }
}

export interface ListJudgesInput {
  court?: string | null;
  q?: string | null;
  status?: string | null;
  limit?: number;
}

export async function listJudges(input: ListJudgesInput = {}, deps: { store?: RemoteStore | null } = {}): Promise<JudgesListResponse> {
  const store = requireStore(deps.store);
  await ensureJudgesSchema(store);
  const where: string[] = [];
  const params: string[] = [];
  if (input.court && courtById(input.court)) { params.push(input.court); where.push(`court_id = $${params.length}`); }
  else if (input.court) return { judges: [], total: 0, courts: [], sources: [], lastRun: await lastRun(store) };
  if (input.status && (STATUSES as string[]).includes(input.status)) { params.push(input.status); where.push(`status = $${params.length}`); }
  const q = (input.q ?? "").trim().slice(0, 80);
  if (q) {
    const norm = normalizeJudgeName(q);
    if (norm) { params.push(`%${norm.replace(/[%_]/g, "")}%`); where.push(`name_normalized LIKE $${params.length}`); }
  }
  const limit = Math.max(1, Math.min(Math.trunc(input.limit ?? 500), 1000));
  const sql = `SELECT ${JUDGE_COLS} FROM judges ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY CASE status WHEN 'sitting' THEN 0 WHEN 'off_roster' THEN 1 ELSE 2 END, court_id,
      CASE WHEN designation ILIKE 'chief justice%' THEN 0 ELSE 1 END, date_of_appointment NULLS LAST, name LIMIT ${limit}`;
  const [rows, counts, run] = await Promise.all([
    store.query({ query: sql, params }),
    store.query({ query: `SELECT court_id, count(*)::int AS total, count(*) FILTER (WHERE status = 'sitting')::int AS sitting, count(photo_media_id)::int AS with_photo FROM judges GROUP BY court_id` }),
    lastRun(store),
  ]);
  const courts: CourtJudgeCount[] = counts.map((c) => ({ courtId: c.court_id!, court: courtById(c.court_id)?.name ?? null, total: Number(c.total), sitting: Number(c.sitting), withPhoto: Number(c.with_photo) }));
  return {
    judges: rows.map(summary),
    total: rows.length,
    courts,
    sources: ROSTER_SOURCES.map((s) => ({ courtId: s.courtId, url: s.url, title: s.title, verified: s.verified, checkedAt: s.checkedAt })),
    lastRun: run,
  };
}

/** Scan cap for the judgments of one judge (counts above it are reported as "at least"). */
export const JUDGMENT_SCAN_CAP = 5000;

/** Judgments of the judge's court whose coram, as printed, normalizes to the judge's name. */
export async function judgmentsForJudge(store: RemoteStore, courtId: string, nameNormalized: string, recent = 20): Promise<JudgeJudgments> {
  const exists = await store.query({ query: `SELECT to_regclass('public.corpus_judgments') AS t` });
  if (!exists[0]?.t) return { available: false, count: 0, capped: false, recent: [] };
  // Prefilter with the longest word of the name (index-free scan within one court), then compare exactly.
  const word = nameNormalized.split(" ").filter((w) => /^[A-Z]{3,}$/.test(w)).sort((a, b) => b.length - a.length)[0];
  if (!word) return { available: true, count: 0, capped: false, recent: [], note: "The name has no word long enough to search the record index by; no judgments are linked." };
  const rows = await store.query({
    query: `SELECT id, title, decision_date::text AS decision_date, neutral_citation, case_number, judges, text_status, pdf_url FROM corpus_judgments
            WHERE court_id = $1 AND judges_text ILIKE $2 ORDER BY decision_date DESC NULLS LAST, id DESC LIMIT ${JUDGMENT_SCAN_CAP}`,
    params: [courtId, `%${word}%`],
  });
  const matched = rows.filter((r) => parseArray(r.judges).some((n) => normalizeJudgeName(n) === nameNormalized));
  const list: JudgeJudgment[] = matched.slice(0, recent).map((r) => ({
    id: r.id!, title: r.title ?? r.id!, decisionDate: r.decision_date, neutralCitation: r.neutral_citation, caseNumber: r.case_number, textStatus: r.text_status ?? "none", pdfUrl: r.pdf_url,
  }));
  return { available: true, count: matched.length, capped: rows.length >= JUDGMENT_SCAN_CAP, recent: list };
}

export async function getJudgeProfile(id: string, deps: { store?: RemoteStore | null } = {}): Promise<JudgeProfileResponse | null> {
  if (!isJudgeId(id)) return null;
  const store = requireStore(deps.store);
  await ensureJudgesSchema(store);
  const rows = await store.query({ query: `SELECT ${JUDGE_COLS}, name_normalized FROM judges WHERE id = $1`, params: [id] });
  const r = rows[0];
  if (!r) return null;
  let photoPublisher: string | null = null;
  let photoPageUrl: string | null = null;
  if (r.photo_media_id) {
    const m = await store.query({ query: `SELECT publisher, page_url FROM media_assets WHERE id = $1`, params: [r.photo_media_id] });
    photoPublisher = m[0]?.publisher ?? null;
    photoPageUrl = m[0]?.page_url ?? null;
  }
  const judgments = await judgmentsForJudge(store, r.court_id!, r.name_normalized!);
  return {
    judge: {
      ...summary(r), printedName: r.printed_name ?? r.name!, profileUrl: r.profile_url, sourceUrl: r.source_url!, sourceTitle: r.source_title,
      checkedAt: r.checked_at, firstSeenAt: r.first_seen_at, photoPublisher, photoPageUrl,
    },
    judgments,
  };
}

/** Coram names of a record → judges of the same court with exactly that normalized name (others: null). */
export async function coramMatches(courtId: string, names: string[], deps: { store?: RemoteStore | null } = {}): Promise<CoramResponse> {
  const clean = names.map((n) => n.trim()).filter(Boolean).slice(0, 20);
  if (!courtById(courtId) || !clean.length) return { courtId, matches: clean.map((name) => ({ name, judge: null })) };
  const store = requireStore(deps.store);
  await ensureJudgesSchema(store);
  const norms = [...new Set(clean.map(normalizeJudgeName).filter(Boolean))];
  const rows = norms.length
    ? await store.query({ query: `SELECT id, name, name_normalized, photo_media_id, photo_source_url, photo_vision FROM judges WHERE court_id = $1 AND name_normalized = ANY(string_to_array($2, '|'))`, params: [courtId, norms.join("|")] })
    : [];
  const byNorm = new Map(rows.map((r) => [r.name_normalized!, r]));
  return {
    courtId,
    matches: clean.map((name) => {
      const r = byNorm.get(normalizeJudgeName(name));
      return { name, judge: r ? { id: r.id!, name: r.name!, photo: photoOf(r) } : null };
    }),
  };
}

export async function courtEmblems(deps: { store?: RemoteStore | null } = {}): Promise<CourtEmblemsResponse> {
  const store = requireStore(deps.store);
  await ensureJudgesSchema(store);
  const rows = await store.query({ query: `SELECT court_id, kind, media_id, source_url, page_url FROM court_assets WHERE kind IN ('emblem', 'logo') ORDER BY court_id, CASE kind WHEN 'emblem' THEN 0 ELSE 1 END` });
  const emblems: Record<string, CourtEmblemInfo> = {};
  for (const r of rows) {
    if (emblems[r.court_id!]) continue;
    emblems[r.court_id!] = { courtId: r.court_id!, kind: r.kind as CourtEmblemInfo["kind"], mediaId: r.media_id!, url: mediaUrl(r.media_id!), sourceUrl: r.source_url!, pageUrl: r.page_url };
  }
  return { emblems };
}
