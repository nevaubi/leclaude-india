/**
 * Registry of Indian legal news feeds (client-safe: shown to users on /news and Home).
 *
 * Every entry was checked against the live feed on 2026-10-01 (HTTP 200, well-formed RSS 2.0, item count as noted).
 * Feeds that failed that check are recorded in `EXCLUDED_FEEDS` so nobody re-adds them without re-verifying.
 * Accuracy matters here: the registry is the user-facing answer to "where do these headlines come from?".
 */
import { BRAND } from "@/lib/brand";

export type NewsSourceType = "legal news" | "legal blog";

export interface NewsSource {
  id: string;
  publisher: string;
  homepage: string;
  feedUrl: string;
  type: NewsSourceType;
  language: "en";
  country: "IN";
  format: "RSS 2.0";
  /** What the feed carries, in plain words (shown in the Sources panel). */
  carries: string;
  /** Approximate number of items in one fetch when verified. */
  itemsWhenVerified: number;
  verifiedAt: string;
  enabled: boolean;
}

export const NEWS_SOURCES: readonly NewsSource[] = [
  {
    id: "livelaw",
    publisher: "LiveLaw",
    homepage: "https://www.livelaw.in",
    feedUrl: "https://www.livelaw.in/google_feeds.xml",
    type: "legal news",
    language: "en",
    country: "IN",
    format: "RSS 2.0",
    carries: "Latest LiveLaw reports on the Supreme Court, High Courts and tribunals. Each item has a headline, author, publish time, image and comma-separated categories naming the court (e.g. \"Bombay High Court\"); the feed carries no summary text.",
    itemsWhenVerified: 60,
    verifiedAt: "2026-10-01",
    enabled: true,
  },
  {
    id: "barandbench",
    publisher: "Bar & Bench",
    homepage: "https://www.barandbench.com",
    feedUrl: "https://www.barandbench.com/feed",
    type: "legal news",
    language: "en",
    country: "IN",
    format: "RSS 2.0",
    carries: `Bar & Bench headlines with author and publish time; items carry the article body (content:encoded) and media images, ${BRAND.name} keeps only the headline, the feed's description when present and the link, never the article body.`,
    itemsWhenVerified: 18,
    verifiedAt: "2026-10-01",
    enabled: true,
  },
  {
    id: "verdictum",
    publisher: "Verdictum",
    homepage: "https://www.verdictum.in",
    feedUrl: "https://www.verdictum.in/feed",
    type: "legal news",
    language: "en",
    country: "IN",
    format: "RSS 2.0",
    carries: "Verdictum reports with a short summary and a non-standard tags element that typically lists judges and parties.",
    itemsWhenVerified: 47,
    verifiedAt: "2026-10-01",
    enabled: true,
  },
  {
    id: "scc-times",
    publisher: "SCC Times (SCC Online Blog)",
    homepage: "https://www.scconline.com/blog",
    feedUrl: "https://www.scconline.com/blog/feed/",
    type: "legal blog",
    language: "en",
    country: "IN",
    format: "RSS 2.0",
    carries: "SCC Online Blog (SCC Times) posts from a WordPress feed, with categories and an excerpt.",
    itemsWhenVerified: 10,
    verifiedAt: "2026-10-01",
    enabled: true,
  },
  {
    id: "lawbeat",
    publisher: "LawBeat",
    homepage: "https://www.lawbeat.in",
    feedUrl: "https://www.lawbeat.in/feed",
    type: "legal news",
    language: "en",
    country: "IN",
    format: "RSS 2.0",
    carries: "LawBeat legal news with headline, summary and publish time.",
    itemsWhenVerified: 46,
    verifiedAt: "2026-10-01",
    enabled: true,
  },
  {
    id: "lawtrend",
    publisher: "LawTrend",
    homepage: "https://lawtrend.in",
    feedUrl: "https://lawtrend.in/feed/",
    type: "legal news",
    language: "en",
    country: "IN",
    format: "RSS 2.0",
    carries: "LawTrend legal news from a WordPress feed, with categories and an excerpt.",
    itemsWhenVerified: 10,
    verifiedAt: "2026-10-01",
    enabled: true,
  },
];

/** Feeds checked on 2026-10-01 and deliberately left out (they did not return a usable feed). */
export const EXCLUDED_FEEDS: ReadonlyArray<{ publisher: string; url: string; reason: string }> = [
  { publisher: "LiveLaw (main feed)", url: "https://www.livelaw.in/feed", reason: "HTTP 500" },
  { publisher: "LatestLaws", url: "https://www.latestlaws.com", reason: "Feed returned HTTP 500" },
  { publisher: "Press Information Bureau", url: "https://pib.gov.in", reason: "Feed returned HTTP 403" },
  { publisher: "Supreme Court of India", url: "https://www.sci.gov.in/feed", reason: "HTTP 403" },
  { publisher: "Legally India", url: "https://www.legallyindia.com", reason: "No working feed found" },
  { publisher: "LawyersClubIndia", url: "https://www.lawyersclubindia.com", reason: "No working feed found" },
];

export function newsSourceById(id: string | null | undefined): NewsSource | null {
  return id ? NEWS_SOURCES.find((s) => s.id === id) ?? null : null;
}

export function enabledNewsSources(): NewsSource[] {
  return NEWS_SOURCES.filter((s) => s.enabled);
}
