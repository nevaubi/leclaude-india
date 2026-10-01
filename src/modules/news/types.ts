/** Legal news contracts (client-safe). */

/** Where a label came from. Labels are never inferred from body text. */
export type NewsLabelSource = "feed category" | "feed tag" | "title";

export interface NewsLabel {
  kind: "court" | "topic";
  /** Court registry id (`sci`, `hc-bombay`) for courts; a lowercase slug of the category for topics. */
  id: string;
  /** Display text: the registry court name, or the feed's category verbatim. */
  label: string;
  labelSource: NewsLabelSource;
  /** The feed value (or title phrase) that produced the label, verbatim. */
  matched: string;
}

export interface NewsSyndication {
  sourceId: string;
  url: string;
  seenAt: string;
}

/** One headline, stored in the `legal_news` collection. Never holds full article text. */
export interface NewsArticle {
  /** Stable hash of the canonical URL (scheme-insensitive); the dedupe key across feeds. */
  id: string;
  /** Canonical URL (tracking parameters removed). */
  url: string;
  sourceId: string;
  publisher: string;
  title: string;
  /** Plain-text summary from the feed (HTML stripped, at most 400 characters); empty when the feed gives none. */
  summary: string;
  authors: string[];
  /** Feed categories, verbatim (comma-separated categories are split). */
  categories: string[];
  /** Non-standard tags element (Verdictum), verbatim. */
  tags: string[];
  /** ISO time from the feed's pubDate/published/dc:date; null when the feed gives none or it cannot be parsed. */
  publishedAt: string | null;
  /** The feed's date string exactly as given. */
  publishedRaw: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  imageUrl: string | null;
  guid: string | null;
  labels: NewsLabel[];
  courtIds: string[];
  /** Other feeds that carried the same canonical URL (the first publisher keeps the item). */
  syndicatedBy: NewsSyndication[];
}

export interface FeedStatus {
  sourceId: string;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: { at: string; message: string; code: string } | null;
  /** Items parsed in the last successful fetch. */
  itemCount: number;
  /** New headlines stored by the last successful fetch. */
  added: number;
  httpStatus: number | null;
  etag: string | null;
  lastModified: string | null;
  durationMs: number | null;
  consecutiveFailures: number;
  /** True when the last fetch answered 304 Not Modified. */
  notModified: boolean;
}

export interface FeedRunResult {
  sourceId: string;
  ok: boolean;
  items: number;
  added: number;
  notModified: boolean;
  error?: string;
  code?: string;
  durationMs: number;
}

export interface NewsRunSummary {
  startedAt: string;
  finishedAt: string;
  feeds: FeedRunResult[];
  added: number;
  pruned: number;
  total: number;
}

export interface RefreshResult {
  status: "ran" | "skipped";
  reason?: "throttled" | "in_flight";
  /** When the last completed run started (the throttle anchor). */
  lastRunAt: string | null;
  /** Earliest time a non-forced run will execute. */
  nextAllowedAt: string | null;
  run?: NewsRunSummary;
}

export interface NewsListResponse {
  items: NewsArticle[];
  /** Cursor for the next page (`before=`), null at the end. */
  nextBefore: string | null;
  total: number;
  lastRun: NewsRunSummary | null;
  /** True when no feed has succeeded within the stale window (or never). */
  stale: boolean;
  lastSuccessAt: string | null;
  facets: { sources: Record<string, number>; courts: Record<string, number> };
}

export interface NewsSourceView {
  id: string;
  publisher: string;
  homepage: string;
  feedUrl: string;
  type: string;
  language: string;
  country: string;
  format: string;
  carries: string;
  enabled: boolean;
  verifiedAt: string;
  stored: number;
  status: FeedStatus | null;
}

export interface NewsSourcesResponse {
  sources: NewsSourceView[];
  excluded: ReadonlyArray<{ publisher: string; url: string; reason: string }>;
  lastRun: NewsRunSummary | null;
  refreshIntervalMinutes: number;
}

/** Sort key: publish time when known, otherwise first seen. */
export function articleSortKey(a: Pick<NewsArticle, "publishedAt" | "firstSeenAt">): string {
  return a.publishedAt ?? a.firstSeenAt;
}
