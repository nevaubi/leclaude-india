import "server-only";
import { decodeHtml, htmlText, isoDate } from "@/modules/india/sources/parse-util";
import { isSafeFetchError } from "@/lib/net/safe-fetch";
import { normalizeCaseNumber, qualifiedCaseKey } from "../../case-numbers";
import type { AdapterContext, DiscoverResult } from "../../adapter";
import type { DiscoveredDoc } from "../../types";

/**
 * Shared machinery for the regulator / gazette / tax / Parliament adapters (deterministic, no model calls).
 *
 * Cursor (JSON, opaque to the runner): `{ v, mode, page, lastSeen, ... }`
 * - mode "incremental": every stream is walked newest-first until the stop marker of the previous completed pass
 *   (`lastSeen[stream]`) is met, or a per-stream page bound is reached (then a note says older items may be missing).
 * - mode "backfill": every stream (or `only`) is walked to its oldest page. When it finishes, the cursor switches to
 *   incremental with the markers captured when the backfill started.
 * A completed pass returns `done: true` WITH a cursor (not null): it carries the stop markers for the next pass.
 *
 * Streams are either paged listings (newest first; `lastSeen` is the key of the newest item) or numeric sequences
 * (ascending identifiers probed one by one; `lastSeen` is the highest number that held a document).
 *
 * `lastSeen` keys starting with "#" are not stream markers (stream ids never start with "#"):
 * - "#retry:<stream>"      numbers whose fetch failed while the numbers after them answered: "n:attempts,…" (or
 *                          "n@tag:attempts"); every later incremental pass probes them again (RETRY_ATTEMPTS at most).
 * - "#unverified:<stream>" numbers given up after RETRY_ATTEMPTS failed retries: never treated as published.
 * - "#unmet:<stream>"      date of the first incremental pass that hit the stream's page bound without meeting the
 *                          previous pass's newest item (older new items may be missing until a backfill completes).
 */

export const GOV_TERMS = "Government publication; verify against the official copy";

export type CursorMode = "incremental" | "backfill";

export interface RegCursor {
  v: 1;
  mode: CursorMode;
  /** Streams of the current pass (fixed when the pass starts). */
  plan: string[];
  /** Index into `plan`. */
  i: number;
  /** Page (listing) or number (sequence) to fetch next in the current stream; null = stream not started. */
  page: number | null;
  /** Items of `page` already returned (listing streams). */
  skip: number;
  /** Consecutive empty numbers (sequence streams). */
  misses: number;
  /** Consecutive numbers just before `page` whose fetch failed (not 404) — unverified, neither found nor missing. */
  fails: number;
  /** Pages / numbers walked in the current stream during this pass. */
  walked: number;
  /** Stop markers from the previous completed pass, per stream. */
  lastSeen: Record<string, string>;
  /** Newest key / highest number seen in this pass, per stream. */
  newest: Record<string, string>;
  /** Backfill restricted to these streams (null = all). */
  only: string[] | null;
}

export function emptyCursor(mode: CursorMode, lastSeen: Record<string, string> = {}, only: string[] | null = null): RegCursor {
  return { v: 1, mode, plan: [], i: 0, page: null, skip: 0, misses: 0, fails: 0, walked: 0, lastSeen, newest: {}, only };
}

const isStrRecord = (v: unknown): v is Record<string, string> =>
  !!v && typeof v === "object" && !Array.isArray(v) && Object.values(v as object).every((x) => typeof x === "string");
const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string" && x.length <= 200);
const isNat = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v < 1e9;

/** Parse a stored cursor; null when absent or not one of ours (never guessed into shape). */
export function parseCursor(raw: string | null): RegCursor | null {
  if (!raw) return null;
  let o: Record<string, unknown>;
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    o = v as Record<string, unknown>;
  } catch {
    return null;
  }
  if (o.mode !== "incremental" && o.mode !== "backfill") return null;
  const lastSeen = isStrRecord(o.lastSeen) ? o.lastSeen : {};
  const only = o.only == null ? null : isStrArray(o.only) ? o.only : null;
  const c = emptyCursor(o.mode, lastSeen, only);
  if (isStrArray(o.plan)) c.plan = o.plan.slice(0, 500);
  if (isNat(o.i) && o.i <= c.plan.length) c.i = o.i;
  if (o.page === null || isNat(o.page)) c.page = (o.page as number | null) ?? null;
  if (isNat(o.skip)) c.skip = o.skip;
  if (isNat(o.misses)) c.misses = o.misses;
  if (isNat(o.fails) && o.fails < FAIL_RUN) c.fails = o.fails;
  if (isNat(o.walked)) c.walked = o.walked;
  if (isStrRecord(o.newest)) c.newest = o.newest;
  return c;
}

export function serializeCursor(c: RegCursor): string {
  return JSON.stringify(c);
}

/** Cursor that starts a backfill (all streams, or only the listed ones) on the next discover call. */
export function backfillCursor(opts: { only?: string[]; lastSeen?: Record<string, string> } = {}): string {
  return serializeCursor(emptyCursor("backfill", opts.lastSeen ?? {}, opts.only?.length ? opts.only : null));
}

// ---- numbers that failed: retry list ---------------------------------------------------------------------------------

/**
 * Numbers whose fetch failed (not 404) are skipped for now — never counted as published — and put on the retry list
 * once the publisher answers for a later number. After FAIL_RUN consecutive failures one fetch of the number next to
 * them decides: when it answers, they are recorded and skipped the same way; when it fails too, the publisher is taken
 * to be failing and the walk stops, resuming at the first of them.
 */
export const FAIL_RUN = 3;
/** Failed retries (one per later incremental pass) before a number is recorded as unverified and no longer probed. */
export const RETRY_ATTEMPTS = 8;
/** Entries kept per retry / unverified list. */
const RETRY_MAX = 100;

export const retryKey = (stream: string) => `#retry:${stream}`;
export const unverifiedKey = (stream: string) => `#unverified:${stream}`;
export const unmetKey = (stream: string) => `#unmet:${stream}`;

export interface RetryEntry {
  n: number;
  /** Extra context needed to probe again (eGazette: the year folder). */
  tag: string | null;
  attempts: number;
}

const RETRY_RE = /^(\d{1,9})(?:@([0-9A-Za-z_-]{1,20}))?:(\d{1,3})$/;

export function readRetry(lastSeen: Record<string, string>, key: string): RetryEntry[] {
  const out: RetryEntry[] = [];
  for (const part of (lastSeen[key] ?? "").split(",")) {
    const m = RETRY_RE.exec(part.trim());
    if (m && !out.some((e) => e.n === Number(m[1]))) out.push({ n: Number(m[1]), tag: m[2] ?? null, attempts: Number(m[3]) });
  }
  return out;
}

function writeRetry(lastSeen: Record<string, string>, key: string, entries: RetryEntry[]): void {
  if (!entries.length) { delete lastSeen[key]; return; }
  lastSeen[key] = entries.map((e) => `${e.n}${e.tag ? `@${e.tag}` : ""}:${e.attempts}`).join(",");
}

function recordUnverified(lastSeen: Record<string, string>, stream: string, n: number): void {
  const k = unverifiedKey(stream);
  const list = (lastSeen[k] ?? "").split(",").filter((x) => /^\d{1,9}$/.test(x) && Number(x) !== n);
  list.push(String(n));
  lastSeen[k] = list.slice(-RETRY_MAX).join(",");
}

/** Put a number on the stream's retry list (no-op when it is already there). */
export function addRetry(lastSeen: Record<string, string>, stream: string, n: number, tag: string | null, notes: string[]): void {
  const key = retryKey(stream);
  const list = readRetry(lastSeen, key);
  if (list.some((e) => e.n === n)) return;
  list.push({ n, tag: tag && /^[0-9A-Za-z_-]{1,20}$/.test(tag) ? tag : null, attempts: 0 });
  while (list.length > RETRY_MAX) {
    const old = list.shift()!;
    recordUnverified(lastSeen, stream, old.n);
    notes.push(`${stream} #${old.n}: the retry list is full; recorded as unverified (not ingested).`);
  }
  writeRetry(lastSeen, key, list);
}

/** Outcome of probing a retry entry again: answered (found or not published) or failed once more. */
export function settleRetry(lastSeen: Record<string, string>, stream: string, n: number, outcome: "answered" | "failed", notes: string[]): void {
  const key = retryKey(stream);
  const list = readRetry(lastSeen, key);
  const i = list.findIndex((e) => e.n === n);
  if (i < 0) return;
  if (outcome === "answered") list.splice(i, 1);
  else if (++list[i].attempts >= RETRY_ATTEMPTS) {
    list.splice(i, 1);
    recordUnverified(lastSeen, stream, n);
    notes.push(`${stream} #${n}: still failing after ${RETRY_ATTEMPTS} retries; recorded as unverified (not ingested).`);
  }
  writeRetry(lastSeen, key, list);
}

/** True when an error means "stop this call now" (the run's deadline or abort), not a failure of the publisher. */
export function isStopError(e: unknown, ctx?: Pick<AdapterContext, "signal">): boolean {
  if (ctx?.signal?.aborted) return true;
  const o = e as { name?: unknown; code?: unknown } | null;
  return o?.name === "OfficialDeadlineError" || o?.code === "official_deadline";
}

/** True when ctx.fetchJson failed because the body was not JSON (the core's ProviderError code "parse"), not a transport or HTTP error. */
export function isNotJsonError(e: unknown): boolean {
  const o = e as { name?: unknown; code?: unknown } | null;
  if (o?.name === "SyntaxError") return true;
  return o?.code === "parse" && !isTooLargeError(e);
}

// ---- streams and the walker ------------------------------------------------------------------------------------------

export interface ListingPage {
  /** Items on the page, newest first. */
  items: DiscoveredDoc[];
  /** True when no older page exists. */
  last: boolean;
  /**
   * Rows the publisher returned on this page before filtering (e.g. questions without a file yet). When given, a page
   * with no usable items ends the stream only when the publisher returned no rows at all.
   */
  rawCount?: number;
  notes?: string[];
}

interface StreamBase {
  id: string;
  /** False when the publisher offers no way to page older items. */
  backfill: boolean;
}

export interface ListingStream extends StreamBase {
  kind: "listing";
  firstPage: number;
  /** Max pages an incremental pass walks when the stop marker is not met. */
  incrementalPages: number;
  /**
   * Every incremental pass walks the whole list, without a stop marker: for small single-page lists whose order is not
   * the order of publication (a document added to an older row would sort below the marker). The pipeline's upsert
   * skips URLs it already holds.
   */
  markerless?: boolean;
  /**
   * Whether `d` (key `key`) is at or below the previous pass's marker, i.e. already seen. Default: `key === marker`.
   * Lists ordered by an upload id compare ids, so a marker that disappeared from the list still stops the walk.
   */
  atMarker?(d: DiscoveredDoc, key: string, marker: string): boolean;
  fetch(page: number, ctx: AdapterContext): Promise<ListingPage>;
}

export interface SequenceStream extends StreamBase {
  kind: "sequence";
  /** First number probed by a backfill. */
  start: number;
  /** First number probed by an incremental pass that has no marker yet (default `start`). */
  incrementalStart?: number;
  /** Consecutive missing numbers after which the stream ends (above the known ceiling). */
  maxMisses: number;
  /** Max numbers probed per incremental pass. */
  incrementalMax?: number;
  /** One document, or null when nothing is published under this number (404 / empty answer). */
  fetch(n: number, ctx: AdapterContext): Promise<DiscoveredDoc | null>;
}

export type StreamSpec = ListingStream | SequenceStream;

export interface WalkConfig {
  /** Stream ids for a new pass, in priority order. */
  plan(ctx: AdapterContext, mode: CursorMode, only: string[] | null): Promise<string[]>;
  stream(id: string): StreamSpec | null;
  /** Identity of an item for stop markers and in-call dedupe (default: fileUrl ?? url). */
  key?(d: DiscoveredDoc): string;
  /** Optional per-item completion (e.g. read a detail page for the PDF link); null excludes the item. */
  resolve?(d: DiscoveredDoc, ctx: AdapterContext): Promise<DiscoveredDoc | null>;
  /** Stop this many ms before the deadline (default 1500). */
  marginMs?: number;
}

export const itemKey = (d: DiscoveredDoc): string => d.fileUrl ?? d.url;

export function nearDeadline(ctx: AdapterContext, marginMs = 1500): boolean {
  return Date.now() >= ctx.deadline - marginMs || !!ctx.signal?.aborted;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Walk the configured streams within ctx.limit / ctx.deadline and return items plus a resumable cursor. */
export async function walkStreams(ctx: AdapterContext, cfg: WalkConfig): Promise<DiscoverResult> {
  const notes: string[] = [];
  const key = cfg.key ?? itemKey;
  const margin = cfg.marginMs ?? 1500;
  let cur = parseCursor(ctx.cursor);
  if (!cur) {
    if (ctx.cursor) notes.push("Stored cursor was not readable; started a new incremental pass.");
    cur = emptyCursor("incremental");
  }
  if (!cur.plan.length || cur.i >= cur.plan.length) {
    cur.plan = await cfg.plan(ctx, cur.mode, cur.only);
    cur.i = 0;
    cur.page = null;
    cur.skip = 0;
    cur.misses = 0;
    cur.fails = 0;
    cur.walked = 0;
  }
  const items: DiscoveredDoc[] = [];
  const seen = new Set<string>();
  const c = cur;
  const partial = (why?: string): DiscoverResult => {
    if (allFailed()) throw failures[0];
    if (why) notes.push(why);
    return { items, nextCursor: serializeCursor(c), done: false, notes: notes.length ? notes : undefined };
  };
  // The run's deadline / abort cut a request: keep the position (resumed by the next call), never skip anything.
  const stopped = (e: unknown): DiscoverResult => {
    if (items.length || fetched) return partial("Stopped before the deadline.");
    throw e;
  };
  const nextStream = () => {
    c.i += 1;
    c.page = null;
    c.skip = 0;
    c.misses = 0;
    c.fails = 0;
    c.walked = 0;
  };
  // Incremental passes skip a failing stream (its marker is kept, so the next pass retries it) instead of blocking
  // every later stream; backfills stop and resume at the same place. When every fetch of a call failed, the first
  // error is thrown so the runner records the failure.
  const failures: unknown[] = [];
  let fetched = 0;
  const failStream = (sid: string, e: unknown, revertMarker: boolean) => {
    notes.push(`${sid}: ${errorText(e)}; skipped for this pass.`);
    failures.push(e);
    if (revertMarker) delete c.newest[sid];
    nextStream();
  };
  const allFailed = () => items.length === 0 && fetched === 0 && failures.length > 0;
  /** Put numbers from..to (failed, unverified) on the stream's retry list; they are never counted as published. */
  const recordFailed = (sid: string, from: number, to: number, why: string) => {
    for (let n = from; n <= to; n++) addRetry(c.lastSeen, sid, n, null, notes);
    notes.push(`${sid} #${from}${to > from ? `..${to}` : ""}: ${why}; skipped for now and recorded for retry (not counted as published).`);
    c.fails = 0;
  };
  const push = (d: DiscoveredDoc) => {
    const kk = key(d);
    if (seen.has(kk)) return;
    seen.add(kk);
    items.push(d);
  };

  while (c.i < c.plan.length) {
    const sid = c.plan[c.i];
    const s = cfg.stream(sid);
    if (!s || (c.mode === "backfill" && !s.backfill)) {
      if (!s) notes.push(`Stream ${sid} is no longer offered; skipped.`);
      else if (c.only?.includes(sid)) notes.push(`${sid}: the publisher offers no way to page older items; backfill skipped.`);
      nextStream();
      continue;
    }
    if (s.kind === "listing") {
      if (c.page == null) { c.page = s.firstPage; c.skip = 0; c.walked = 0; }
      if (items.length >= ctx.limit) return partial();
      if (nearDeadline(ctx, margin)) return partial("Stopped before the deadline.");
      let res: ListingPage;
      try {
        res = await s.fetch(c.page, ctx);
        fetched += 1;
      } catch (e) {
        if (isNotFound(e)) { notes.push(`${sid} page ${c.page}: not found; stream ended.`); nextStream(); continue; }
        if (isStopError(e, ctx)) return stopped(e);
        if (c.mode === "backfill") {
          if (items.length) return partial(`${sid} page ${c.page}: ${errorText(e)}`);
          throw e;
        }
        failStream(sid, e, true);
        continue;
      }
      if (res.notes?.length) notes.push(...res.notes.map((n) => `${sid}: ${n}`));
      const rows = res.items;
      // The pass's marker for this stream: the first item of the first page that has any.
      if (rows.length && c.newest[sid] == null) c.newest[sid] = key(rows[0]);
      const stopAt = c.mode === "incremental" && !s.markerless ? c.lastSeen[sid] : undefined;
      let reachedMarker = false;
      let failed = false;
      for (let k = c.skip; k < rows.length; k++) {
        const kk = key(rows[k]);
        if (stopAt != null && (s.atMarker ? s.atMarker(rows[k], kk, stopAt) : stopAt === kk)) { reachedMarker = true; break; }
        if (items.length >= ctx.limit) { c.skip = k; return partial(); }
        if (nearDeadline(ctx, margin)) { c.skip = k; return partial("Stopped before the deadline."); }
        if (seen.has(kk)) continue;
        seen.add(kk);
        let d: DiscoveredDoc | null = rows[k];
        if (cfg.resolve) {
          try {
            d = await cfg.resolve(d, ctx);
          } catch (e) {
            if (isNotFound(e)) { notes.push(`${kk}: detail page not found; not ingested.`); continue; }
            if (isStopError(e, ctx)) { c.skip = k; return stopped(e); }
            if (c.mode === "backfill") {
              c.skip = k;
              if (items.length) return partial(`${kk}: ${errorText(e)}`);
              throw e;
            }
            failStream(sid, e, true);
            failed = true;
            break;
          }
        }
        if (d) items.push(d);
      }
      if (failed) continue;
      c.walked += 1;
      // A page whose rows were all filtered out is not the end of the list when the publisher still returned rows.
      const exhausted = rows.length === 0 && !((res.rawCount ?? 0) > 0);
      if (reachedMarker || res.last || exhausted) { nextStream(); continue; }
      if (c.mode === "incremental" && c.walked >= s.incrementalPages) {
        if (stopAt != null) {
          notes.push(`${sid}: the previous pass's newest item was not met within ${s.incrementalPages} page(s); older new items may be missing until a backfill runs.`);
          if (c.lastSeen[unmetKey(sid)] == null) c.lastSeen[unmetKey(sid)] = ctx.today;
        }
        nextStream();
        continue;
      }
      c.page += 1;
      c.skip = 0;
      continue;
    }

    // sequence stream (ascending numbers)
    const marker = c.lastSeen[sid] != null ? Number(c.lastSeen[sid]) : NaN;
    if (c.page == null) {
      // Incremental: numbers that failed in earlier passes are probed again first (see FAIL_RUN / RETRY_ATTEMPTS).
      if (c.mode === "incremental") {
        for (const r of readRetry(c.lastSeen, retryKey(sid))) {
          if (items.length >= ctx.limit) return partial();
          if (nearDeadline(ctx, margin)) return partial("Stopped before the deadline.");
          let d: DiscoveredDoc | null;
          try {
            d = await s.fetch(r.n, ctx);
            fetched += 1;
          } catch (e) {
            if (isStopError(e, ctx)) return stopped(e);
            if (!isNotFound(e)) { settleRetry(c.lastSeen, sid, r.n, "failed", notes); continue; }
            d = null;
          }
          settleRetry(c.lastSeen, sid, r.n, "answered", notes);
          notes.push(`${sid} #${r.n}: ${d ? "found" : "not published"} on retry.`);
          if (d) push(d);
        }
      }
      c.page = c.mode === "incremental" ? (Number.isFinite(marker) ? marker + 1 : (s.incrementalStart ?? s.start)) : s.start;
      c.misses = 0;
      c.fails = 0;
      c.walked = 0;
    }
    if (items.length >= ctx.limit) return partial();
    if (nearDeadline(ctx, margin)) return partial("Stopped before the deadline.");
    if (c.mode === "incremental" && s.incrementalMax && c.walked >= s.incrementalMax) {
      // The marker stays at the highest number that held a document (c.newest): numbers probed after it (misses, or
      // failures still pending) are probed again by the next pass, so nothing published there is skipped.
      notes.push(`${sid}: probed ${s.incrementalMax} numbers this pass; continuing next pass.`);
      nextStream();
      continue;
    }
    let d: DiscoveredDoc | null;
    try {
      d = await s.fetch(c.page, ctx);
      fetched += 1;
    } catch (e) {
      if (isStopError(e, ctx)) return stopped(e);
      if (!isNotFound(e)) {
        c.fails += 1;
        c.walked += 1;
        if (c.fails < FAIL_RUN) { c.page += 1; continue; }
        // FAIL_RUN consecutive numbers failed. One fetch of the number next to them tells failing documents (the
        // publisher answers: record them and step over) from a failing publisher (resume at the first of them).
        const first = c.page - c.fails + 1;
        const probe = first - 1 >= s.start ? first - 1 : c.page + 1;
        let answers = false;
        try {
          await s.fetch(probe, ctx);
          answers = true;
        } catch (e2) {
          if (isStopError(e2, ctx)) return stopped(e2);
          answers = isNotFound(e2);
        }
        if (answers) {
          fetched += 1;
          recordFailed(sid, first, c.page, `fetch failed while #${probe} answered`);
          c.page += 1;
          continue;
        }
        c.page = first;
        c.fails = 0;
        if (c.mode === "backfill") {
          if (items.length) return partial(`${sid} #${c.page}: ${errorText(e)}`);
          throw e;
        }
        failStream(sid, e, false);
        continue;
      }
      d = null;
    }
    c.walked += 1;
    // The publisher answered for this number: the failures just before it are those documents' own problem.
    if (c.fails) recordFailed(sid, c.page - c.fails, c.page - 1, "fetch failed while later numbers answered");
    if (!d) {
      c.misses += 1;
      const belowCeiling = c.mode === "backfill" && Number.isFinite(marker) && c.page < marker;
      if (!belowCeiling && c.misses >= s.maxMisses) { nextStream(); continue; }
      c.page += 1;
      continue;
    }
    c.misses = 0;
    const hi = Math.max(Number(c.newest[sid] ?? NaN) || 0, c.page);
    c.newest[sid] = String(hi);
    push(d);
    c.page += 1;
  }

  if (allFailed()) throw failures[0];
  // Pass complete: carry the markers forward into the next incremental pass.
  const lastSeen: Record<string, string> = { ...c.lastSeen };
  for (const [sid, v] of Object.entries(c.newest)) {
    const prev = lastSeen[sid];
    const s = cfg.stream(sid);
    if (s?.kind === "sequence" && prev != null && Number(prev) > Number(v)) continue;
    lastSeen[sid] = v;
  }
  // A completed backfill walked every listed stream to its oldest page: earlier "marker not met" records are moot.
  if (c.mode === "backfill") for (const sid of c.plan) if (cfg.stream(sid)?.backfill) delete lastSeen[unmetKey(sid)];
  const next = emptyCursor("incremental", lastSeen);
  return { items, nextCursor: serializeCursor(next), done: true, notes: notes.length ? notes : undefined };
}

/** A disabled adapter's discover: nothing, with the reason. */
export function disabledResult(reason: string): DiscoverResult {
  return { items: [], nextCursor: null, done: true, notes: [reason] };
}

// ---- HTML and text helpers -------------------------------------------------------------------------------------------

export { decodeHtml, htmlText };

export function stripComments(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, " ");
}

/** `<tr>` blocks of a table fragment (comments removed first). */
export function tableRows(html: string): string[] {
  return stripComments(html).match(/<tr\b[\s\S]*?<\/tr>/gi) ?? [];
}

/** `<td>` inner HTML of a row (header cells excluded). */
export function rowCells(rowHtml: string): string[] {
  return [...rowHtml.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]);
}

/** Value of an attribute in a tag's HTML (decoded), or null. */
export function attr(tagHtml: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(tagHtml);
  if (!m) return null;
  return decodeHtml(m[2] ?? m[3] ?? "");
}

/** All href values of anchors in a fragment, decoded. */
export function hrefs(html: string): string[] {
  return [...html.matchAll(/<a\b[^>]*>/gi)].map((m) => attr(m[0], "href")).filter((h): h is string => !!h);
}

/** Absolute http(s) URL on one of the allowed hosts (or their subdomains); null otherwise. */
export function safeUrl(href: string | null | undefined, base: string, hosts: string[]): string | null {
  if (!href) return null;
  const h = href.trim();
  if (!h || /^(javascript|mailto|data|file):/i.test(h)) return null;
  let u: URL;
  try {
    u = new URL(h, base);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.toLowerCase();
  if (!hosts.some((a) => host === a || host.endsWith(`.${a}`))) return null;
  return u.toString();
}

/** Collapse whitespace (incl. nbsp) and trim. */
export function clean(s: string | null | undefined): string {
  return (s ?? "").replace(/[\s ]+/g, " ").trim();
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  january: 1, february: 2, march: 3, april: 4, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

function ymd(y: number, m: number, d: number): string | null {
  if (!(y >= 1800 && y <= 2200 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

/**
 * A date as printed by these publishers → ISO date; null when it is not one (never guessed).
 * "25 Sep, 2026", "Oct 01, 2026", "02-Oct-2026", "12.08.2026", "13/12/2024", "29-09-2026", "September 28th, 2026",
 * "SEPTEMBER 24, 2026", "the 24th September, 2026", "01 Oct, 2026 +0530", "2026-05-07T05:30:00+05:30".
 */
export function printedDate(raw: string | null | undefined): string | null {
  const s = clean(raw).replace(/^the\s+/i, "");
  if (!s) return null;
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(s);
  if (m) return ymd(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s);
  if (m) return isoDate(`${m[1]}-${m[2]}-${m[3]}`) ?? null;
  // 25 Sep, 2026 | 02-Oct-2026 | 24th September, 2026 | 01 Oct, 2026 +0530
  m = /^(\d{1,2})(?:st|nd|rd|th)?[\s-]+([A-Za-z]{3,9})\.?,?[\s-]+(\d{4})(?:\s+[+-]\d{4})?$/.exec(s);
  if (m) {
    const mo = MONTHS[m[2].toLowerCase()];
    return mo ? ymd(+m[3], mo, +m[1]) : null;
  }
  // Oct 01, 2026 | September 28th, 2026 | SEPTEMBER 24, 2026
  m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/.exec(s);
  if (m) {
    const mo = MONTHS[m[1].toLowerCase()];
    return mo ? ymd(+m[3], mo, +m[2]) : null;
  }
  return null;
}

// ---- case numbers in titles ----------------------------------------------------------------------------------------

export interface TitleCaseNumbers {
  /** Parts as printed inside the trailing [...] group, split on " in ". */
  printed: string[];
  /** Normalized keys ("CPIB/192/2026") for the parts that are a single recognisable case number (or an "a, b & c of YEAR" list). */
  keys: string[];
}

const YEAR_RE = /\b(?:19|20)\d{2}\b/g;

/**
 * Exact keys for one printed number: the normalized key and, when the number carries an NCLT bench code
 * ("CP(IB)/271(AHM)2025", "C.P.(IB)/507/MB/2021"), the bench-qualified key ("CPIB/271/2025@AHM") — the same keys the
 * cause-list parser emits (case-numbers.ts caseNumberKeys), so matters match orders and listings consistently.
 */
function normalizeOne(part: string): string[] {
  let p = clean(part);
  // "TYPE/123/MB/2021" (bench between slashes) is the same printing as "TYPE/123(MB)2021".
  p = p.replace(/^(.+?)\s*\/\s*(\d{1,7})\s*\/\s*([A-Za-z]{1,6})\s*\/\s*((?:19|20)\d{2})$/, "$1/$2($3)$4");
  // "CP (IB)" → "CP(IB)" (space between a type and its parenthetical).
  p = p.replace(/([A-Za-z.])\s+\(/g, "$1(");
  const n = normalizeCaseNumber(p);
  if (!n || /\d/.test(n.type) || n.type.length > 24) return [];
  const q = qualifiedCaseKey(n);
  return q ? [n.key, q] : [n.key];
}

/**
 * Case numbers from the last [...] group of a title. Only parts with exactly one year and no list separators are
 * normalized, plus the strict "TYPE No. a, b & c of YEAR" list form; anything else keeps its printed form only.
 */
export function caseNumbersFromTitle(title: string): TitleCaseNumbers {
  const groups = [...clean(title).matchAll(/\[([^\]]{2,300})\]/g)];
  if (!groups.length) return { printed: [], keys: [] };
  const inner = groups[groups.length - 1][1];
  const printed = inner.split(/\s+in\s+/i).map(clean).filter(Boolean);
  const keys: string[] = [];
  for (const part of printed) {
    const years = part.match(YEAR_RE) ?? [];
    if (years.length !== 1) continue;
    const list = /^(.+?)\s*Nos?\.?\s*(\d{1,7}(?:\s*(?:,|&|and)\s*\d{1,7})+)\s*(?:of|\/)\s*((?:19|20)\d{2})$/i.exec(part);
    if (list) {
      for (const num of list[2].split(/\s*(?:,|&|and)\s*/i)) {
        for (const k of normalizeOne(`${list[1]} No. ${num} of ${list[3]}`)) if (!keys.includes(k)) keys.push(k);
      }
      continue;
    }
    if (/[&,;]|\band\b/i.test(part)) continue;
    for (const k of normalizeOne(part)) if (!keys.includes(k)) keys.push(k);
  }
  return { printed, keys };
}

// ---- fetch helpers -------------------------------------------------------------------------------------------------

/** True when an error from ctx.fetch* means "not published" (404/410). */
export function isNotFound(e: unknown): boolean {
  const o = e as { status?: unknown; statusCode?: unknown; code?: unknown; message?: unknown } | null;
  const st = Number(o?.status ?? o?.statusCode);
  if (st === 404 || st === 410) return true;
  return typeof o?.message === "string" && /\b(404|410)\b/.test(o.message) && /not found|gone|status|http/i.test(o.message);
}

/**
 * True when an error from ctx.fetchFile means "the body is larger than the byte limit" — the same test as the
 * pipeline's isTooLarge (official/http.ts; not imported here: http.ts → registry → adapters would be an import cycle).
 * Covers safe-fetch's messages ("Response declares N bytes, above the M-byte limit", "Response is larger than ...",
 * "Response exceeded the M-byte limit") and the official fetcher's "file larger than N bytes".
 */
export function isTooLargeError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return (isSafeFetchError(e) && e.code === "body_too_large") || /byte limit|larger than|too large/i.test(msg);
}

/** HTTP status carried by an error from ctx.fetch*, when it carries one. */
export function errorStatus(e: unknown): number | null {
  const o = e as { status?: unknown; statusCode?: unknown; message?: unknown } | null;
  const st = Number(o?.status ?? o?.statusCode);
  if (Number.isInteger(st) && st >= 100 && st < 600) return st;
  const m = typeof o?.message === "string" ? /\b([45]\d{2})\b/.exec(o.message) : null;
  return m ? Number(m[1]) : null;
}

/** JSON from an endpoint that may answer with a text/html content type (rsdoc.nic.in): fetchJson, else page text. */
export async function getJsonLoose<T>(ctx: AdapterContext, url: string, headers?: Record<string, string>): Promise<T> {
  try {
    return await ctx.fetchJson<T>(url, headers ? { headers } : undefined);
  } catch (e) {
    if (isNotFound(e)) throw e;
    const page = await ctx.fetchPage(url, headers ? { headers } : undefined);
    const body = (page.html ?? "").replace(/^[\s\S]*?<body[^>]*>/i, "").replace(/<\/body>[\s\S]*$/i, "").trim();
    try {
      return JSON.parse(decodeHtml(body.replace(/<\/?pre[^>]*>/gi, ""))) as T;
    } catch {
      throw e;
    }
  }
}

/** A context whose fields are overridden (cursor, limit) while every method still reaches the original context. */
export function overrideCtx(ctx: AdapterContext, over: Partial<Pick<AdapterContext, "cursor" | "limit" | "deadline">>): AdapterContext {
  return Object.assign(Object.create(ctx) as AdapterContext, over);
}

export function limitText(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
