import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.LECLAUDE_DATA_DIR = `${process.env.TMPDIR || "/tmp"}/legal-news-vitest-${process.pid}`;
  process.env.LECLAUDE_SEED = "reference";
  process.env.LECLAUDE_BACKGROUND = "off";
  process.env.WORKFLOW_SCHEDULER_DISABLED = "1";
  process.env.INTEL_OFFLINE = "1";
  delete process.env.AUTH_MODE;
  delete process.env.LEGAL_NEWS_FIXTURE_DIR;
});

import { readFileSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { db, resetSqlite } from "@/lib/db";
import { parseFeed, decodeEntities } from "@/modules/news/parse";
import { articleIdFor, canonicalUrl, normalizeItem, parseFeedDate, stripHtml, summarize } from "@/modules/news/normalize";
import { courtIdForExactName, labelsFor, titleNamesSupremeCourt } from "@/modules/news/labels";
import { NEWS_SOURCES, newsSourceById, type NewsSource } from "@/modules/news/sources";
import { FORCE_FLOOR_MS, REFRESH_INTERVAL_MS, feedStatuses, fixtureFeedFetcher, httpFeedFetcher, listLegalNews, mergeArticles, pruneArticles, refreshLegalNews, resetLegalNews, type FeedFetcher } from "@/modules/news/service";
import type { NewsArticle, NewsListResponse, NewsSourcesResponse } from "@/modules/news/types";
import { GET as newsGET } from "@/app/api/news/route";
import { GET as sourcesGET } from "@/app/api/news/sources/route";
import { POST as refreshPOST } from "@/app/api/news/refresh/route";

const FIXTURES = path.resolve(__dirname, "fixtures/legal-news");
const fixture = (id: string) => readFileSync(path.join(FIXTURES, `${id}.xml`), "utf8");
const src = (id: string) => newsSourceById(id)!;
const NOW = new Date("2026-10-01T06:00:00Z");
const clock = (d: Date) => () => new Date(d);

const call = (h: unknown, ...args: unknown[]) => (h as (...a: unknown[]) => Promise<Response>)(...args);
const nreq = (p: string, init?: RequestInit) => new NextRequest(`http://localhost${p}`, init as ConstructorParameters<typeof NextRequest>[1]);

beforeAll(() => { resetSqlite(); db(); });

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

describe("source registry", () => {
  it("lists exactly the six verified Indian feeds with complete metadata", () => {
    expect(NEWS_SOURCES.map((s) => s.id)).toEqual(["livelaw", "barandbench", "verdictum", "scc-times", "lawbeat", "lawtrend"]);
    expect(NEWS_SOURCES.map((s) => s.feedUrl)).toEqual([
      "https://www.livelaw.in/google_feeds.xml",
      "https://www.barandbench.com/feed",
      "https://www.verdictum.in/feed",
      "https://www.scconline.com/blog/feed/",
      "https://www.lawbeat.in/feed",
      "https://lawtrend.in/feed/",
    ]);
    for (const s of NEWS_SOURCES) {
      expect(s).toMatchObject({ language: "en", country: "IN", enabled: true, format: "RSS 2.0" });
      expect(["legal news", "legal blog"]).toContain(s.type);
      expect(new URL(s.homepage).protocol).toBe("https:");
      expect(s.carries.length).toBeGreaterThan(20);
    }
    // Known-broken feeds are not registered.
    expect(NEWS_SOURCES.some((s) => /livelaw\.in\/feed$|latestlaws|pib\.gov|sci\.gov|legallyindia|lawyersclubindia/.test(s.feedUrl))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

describe("parseFeed", () => {
  it("LiveLaw: CDATA titles, comma-separated categories, dc:creator, enclosure image, empty description", () => {
    const f = parseFeed(fixture("livelaw"));
    expect(f.format).toBe("rss");
    expect(f.title).toBe("LiveLaw");
    expect(f.items).toHaveLength(4);
    const a = f.items[0];
    expect(a.title).toMatch(/^Bombay High Court Grants Bail/);
    expect(a.link).toBe("https://www.livelaw.in/high-court/bombay-high-court/bombay-high-court-bail-cheating-custody-recovery-301245?utm_source=google&utm_medium=feed");
    expect(a.guidIsPermaLink).toBe(true);
    expect(a.categories).toEqual(["High Courts", "Bombay High Court", "All High Courts"]);
    expect(a.authors).toEqual(["Amisha Shrivastava"]);
    expect(a.date).toBe("Wed, 30 Sep 2026 14:05:12 GMT");
    expect(a.imageUrl).toBe("https://www.livelaw.in/h-upload/2026/09/30/bombay-hc.jpg");
    expect(a.description).toBeNull();
  });

  it("Bar & Bench: escaped HTML description, numeric entities, content:encoded and media namespace", () => {
    const f = parseFeed(fixture("barandbench"));
    expect(f.title).toBe("Bar & Bench - Indian Legal news");
    expect(f.items).toHaveLength(2);
    expect(f.items[0].title).toBe("Delhi High Court refuses to stay trademark injunction in ‘Haldiram’ dispute");
    expect(f.items[0].description).toContain("<strong>prima facie</strong>");
    expect(f.items[0].content).toContain("FULL ARTICLE BODY");
    expect(f.items[0].imageUrl).toBe("https://media.barandbench.com/haldiram.jpg");
    expect(f.items[0].categories).toEqual(["Litigation News", "Delhi High Court"]);
    expect(f.items[1].title).toBe("Law firm Khaitan & Co elevates 12 partners");
    expect(f.items[1].imageUrl).toBe("https://media.barandbench.com/khaitan.jpg");
    expect(f.items[1].guidIsPermaLink).toBe(false);
  });

  it("Verdictum: CDATA summary and the non-standard tags element", () => {
    const f = parseFeed(fixture("verdictum"));
    expect(f.items).toHaveLength(2);
    expect(f.items[0].tags).toEqual(["Justice B.V. Nagarathna", "Justice Satish Chandra Sharma", "ABC Infra Ltd.", "Union of India"]);
    expect(f.items[1].tags).toContain("Karnataka High Court");
    expect(f.items[0].description).toMatch(/^The Supreme Court held/);
  });

  it("SCC Times (WordPress): multiple categories, &#8216; entities, isPermaLink=false guid", () => {
    const f = parseFeed(fixture("scc-times"));
    expect(f.items).toHaveLength(2);
    expect(f.items[0].title).toBe("Madras High Court sets aside detention order; ‘non-application of mind’ evident");
    expect(f.items[0].categories).toEqual(["Case Briefs", "High Courts", "Madras High Court"]);
    expect(f.items[0].link).toBe("https://www.scconline.com/blog/post/2026/10/01/madras-high-court-detention-order-set-aside/");
    expect(f.items[0].guidIsPermaLink).toBe(false);
  });

  it("LawBeat: &apos; entity, media:content without type, an item without pubDate", () => {
    const f = parseFeed(fixture("lawbeat"));
    expect(f.items).toHaveLength(3);
    expect(f.items[0].title).toBe("Allahabad High Court seeks State's reply on encroachment of ponds");
    expect(f.items[0].imageUrl).toBe("https://www.lawbeat.in/sites/default/files/ponds.jpg");
    expect(f.items[2].date).toBeNull();
  });

  it("LawTrend (WordPress): &#8211; and curly quotes", () => {
    const f = parseFeed(fixture("lawtrend"));
    expect(f.items).toHaveLength(1);
    expect(f.items[0].title).toBe("Gujarat High Court Directs Fresh Inquiry Into Custodial Death – Says Earlier Probe “Perfunctory”");
    expect(f.items[0].authors).toEqual(["Law Trend"]);
  });

  it("Atom entries, CDATA hiding markup, and non-feeds", () => {
    const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>X</title><link href="https://x.example/"/>
      <entry><title type="html">A &amp;amp; B</title><link rel="alternate" href="https://x.example/a"/><id>tag:x,2026:1</id><published>2026-09-30T10:00:00+05:30</published><author><name>R. Rao</name></author><category term="Delhi High Court"/><summary><![CDATA[<p>Text with </entry> inside</p>]]></summary></entry></feed>`;
    const f = parseFeed(atom);
    expect(f.format).toBe("atom");
    expect(f.items).toHaveLength(1);
    expect(f.items[0]).toMatchObject({ link: "https://x.example/a", date: "2026-09-30T10:00:00+05:30", authors: ["R. Rao"], categories: ["Delhi High Court"] });
    expect(f.items[0].description).toBe("<p>Text with </entry> inside</p>");
    expect(parseFeed("<html><body>Not a feed</body></html>")).toMatchObject({ format: "unknown", items: [] });
    expect(parseFeed("")).toMatchObject({ format: "unknown", items: [] });
  });

  it("decodes entities", () => {
    expect(decodeEntities("A &amp; B &#038; C &#8216;x&#8217; &#x2014; &hellip; &unknown;")).toBe("A & B & C ‘x’ — … &unknown;");
  });
});

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

describe("canonical URLs and ids", () => {
  it("strips tracking parameters and fragments, keeps the path and real parameters", () => {
    expect(canonicalUrl("https://WWW.LiveLaw.in/a/b-1?utm_source=x&utm_medium=y#top")).toBe("https://www.livelaw.in/a/b-1");
    expect(canonicalUrl("https://x.in/p?id=7&fbclid=abc&gclid=1&ref=rss&page=2")).toBe("https://x.in/p?id=7&page=2");
    expect(canonicalUrl("https://x.in:443/Case/Path/")).toBe("https://x.in/Case/Path/");
    expect(canonicalUrl("javascript:alert(1)")).toBeNull();
    expect(canonicalUrl("not a url")).toBeNull();
    expect(canonicalUrl("/relative/post", "https://lawtrend.in")).toBe("https://lawtrend.in/relative/post");
  });

  it("ids are stable and collapse http/https and tracking variants", () => {
    const a = articleIdFor(canonicalUrl("https://x.in/a?utm_source=1")!);
    expect(articleIdFor(canonicalUrl("http://x.in/a#c")!)).toBe(a);
    expect(articleIdFor(canonicalUrl("https://x.in/b")!)).not.toBe(a);
    expect(a).toMatch(/^ln_[0-9a-f]{24}$/);
  });
});

describe("parseFeedDate", () => {
  it("parses RFC 822 dates with GMT, numeric offsets and IST", () => {
    expect(parseFeedDate("Wed, 30 Sep 2026 14:05:12 GMT")).toBe("2026-09-30T14:05:12.000Z");
    expect(parseFeedDate("Thu, 01 Oct 2026 09:20:00 +0530")).toBe("2026-10-01T03:50:00.000Z");
    expect(parseFeedDate("Thu, 01 Oct 2026 04:30:00 +0000")).toBe("2026-10-01T04:30:00.000Z");
    expect(parseFeedDate("Thu, 01 Oct 2026 09:20:00 +05:30")).toBe("2026-10-01T03:50:00.000Z");
    expect(parseFeedDate("01 Oct 2026 09:20 IST")).toBe("2026-10-01T03:50:00.000Z");
    expect(parseFeedDate("Thu, 1 October 2026 00:10:00 +0530")).toBe("2026-09-30T18:40:00.000Z");
  });
  it("parses ISO 8601 with a zone", () => {
    expect(parseFeedDate("2026-09-30T10:00:00+05:30")).toBe("2026-09-30T04:30:00.000Z");
    expect(parseFeedDate("2026-09-30T10:00:00Z")).toBe("2026-09-30T10:00:00.000Z");
  });
  it("never guesses: no zone, nonsense or impossible dates give null", () => {
    expect(parseFeedDate("Thu, 01 Oct 2026 09:20:00")).toBeNull();
    expect(parseFeedDate("2026-09-30T10:00:00")).toBeNull();
    expect(parseFeedDate("yesterday")).toBeNull();
    expect(parseFeedDate("Thu, 31 Sep 2026 09:20:00 GMT")).toBeNull();
    expect(parseFeedDate(null)).toBeNull();
  });
});

describe("summaries", () => {
  it("strips HTML, WordPress boilerplate and caps at 400 characters", () => {
    expect(stripHtml("<p>A <strong>b</strong> &amp;amp; c</p>")).toBe("A b & c");
    const scc = parseFeed(fixture("scc-times")).items[0];
    const s = summarize(scc.description, scc.title);
    expect(s).toMatch(/^Madras High Court: In a habeas corpus petition/);
    expect(s).not.toMatch(/appeared first on/);
    const long = summarize(`<p>${"word ".repeat(200)}</p>`, "t");
    expect(long.length).toBeLessThanOrEqual(400);
    expect(long.endsWith("…")).toBe(true);
  });
  it("never uses the article body (content:encoded) as a summary", () => {
    const items = parseFeed(fixture("barandbench")).items.map((r) => normalizeItem(r, src("barandbench"), NOW)!);
    expect(items[0].summary).toBe("The Court said the plaintiff had made out a prima facie case & that the balance of convenience lay in its favour.");
    expect(items[1].summary).toBe("");
    expect(JSON.stringify(items)).not.toContain("FULL ARTICLE BODY");
  });
});

describe("labels", () => {
  it("matches courts only on exact names (case-insensitive)", () => {
    expect(courtIdForExactName("Bombay High Court")).toBe("hc-bombay");
    expect(courtIdForExactName("  bombay   high court ")).toBe("hc-bombay");
    expect(courtIdForExactName("High Court of Bombay")).toBe("hc-bombay");
    expect(courtIdForExactName("Supreme Court")).toBe("sci");
    expect(courtIdForExactName("All High Courts")).toBeNull();
    expect(courtIdForExactName("High Courts")).toBeNull();
    expect(courtIdForExactName("Bombay")).toBeNull();
    expect(courtIdForExactName("Bombay High Court Weekly")).toBeNull();
    expect(courtIdForExactName("SC")).toBeNull();
  });

  it("labels LiveLaw categories exactly and keeps the rest as topics", () => {
    const { labels, courtIds } = labelsFor({ title: "Bombay High Court Grants Bail", categories: ["High Courts", "Bombay High Court", "All High Courts"], tags: [] });
    expect(courtIds).toEqual(["hc-bombay"]);
    expect(labels.find((l) => l.kind === "court")).toEqual({ kind: "court", id: "hc-bombay", label: "High Court of Bombay", labelSource: "feed category", matched: "Bombay High Court" });
    expect(labels.filter((l) => l.kind === "topic").map((l) => l.label)).toEqual(["High Courts", "All High Courts"]);
  });

  it("never infers a High Court from title text", () => {
    expect(labelsFor({ title: "Weekly Round-Up: Decisions From The Bombay And Madras Benches", categories: ["High Courts"], tags: [] }).courtIds).toEqual([]);
    expect(labelsFor({ title: "Karnataka HC Quashes FIR", categories: [], tags: [] }).courtIds).toEqual([]);
    expect(labelsFor({ title: "Delhi High Court orders X", categories: ["Litigation News"], tags: [] }).courtIds).toEqual([]);
  });

  it("labels the Supreme Court from a title that names it, but not a foreign Supreme Court", () => {
    const sc = labelsFor({ title: "Supreme Court Issues Notice On Plea", categories: ["Top Stories"], tags: [] });
    expect(sc.courtIds).toEqual(["sci"]);
    expect(sc.labels[0]).toMatchObject({ labelSource: "title", matched: "Supreme Court" });
    expect(titleNamesSupremeCourt("Pakistan Supreme Court stays election tribunal order")).toBe(false);
    expect(titleNamesSupremeCourt("US Supreme Court hears tariff case")).toBe(false);
    expect(titleNamesSupremeCourt("Supreme Court of the United Kingdom rules on X")).toBe(false);
    expect(titleNamesSupremeCourt("Supreme Court of India collegium recommends names")).toBe(true);
  });

  it("uses exact court names in tags (Verdictum) with labelSource 'feed tag'; judges and parties are not topics", () => {
    const r = labelsFor({ title: "Karnataka HC Quashes FIR", categories: ["High Courts"], tags: ["Karnataka High Court", "Justice M. Nagaprasanna"] });
    expect(r.courtIds).toEqual(["hc-karnataka"]);
    expect(r.labels.find((l) => l.kind === "court")?.labelSource).toBe("feed tag");
    expect(r.labels.some((l) => l.label.includes("Nagaprasanna"))).toBe(false);
  });
});

describe("normalizeItem", () => {
  it("builds a headline with canonical URL, ISO and raw dates, authors, categories and image", () => {
    const raw = parseFeed(fixture("livelaw")).items[0];
    const a = normalizeItem(raw, src("livelaw"), NOW)!;
    expect(a.url).toBe("https://www.livelaw.in/high-court/bombay-high-court/bombay-high-court-bail-cheating-custody-recovery-301245");
    expect(a.id).toBe(articleIdFor(a.url));
    expect(a).toMatchObject({ sourceId: "livelaw", publisher: "LiveLaw", publishedAt: "2026-09-30T14:05:12.000Z", publishedRaw: "Wed, 30 Sep 2026 14:05:12 GMT", firstSeenAt: NOW.toISOString(), authors: ["Amisha Shrivastava"], summary: "", courtIds: ["hc-bombay"] });
    expect(a.imageUrl).toBe("https://www.livelaw.in/h-upload/2026/09/30/bombay-hc.jpg");
  });
  it("never uses fetch time as published time", () => {
    const raw = parseFeed(fixture("lawbeat")).items[2];
    const a = normalizeItem(raw, src("lawbeat"), NOW)!;
    expect(a.publishedAt).toBeNull();
    expect(a.publishedRaw).toBeNull();
    expect(a.firstSeenAt).toBe(NOW.toISOString());
  });
  it("drops items without a usable link or title", () => {
    const base = parseFeed(fixture("lawbeat")).items[0];
    expect(normalizeItem({ ...base, link: null, guid: null }, src("lawbeat"), NOW)).toBeNull();
    expect(normalizeItem({ ...base, title: "  " }, src("lawbeat"), NOW)).toBeNull();
    expect(normalizeItem({ ...base, link: "javascript:alert(1)" }, src("lawbeat"), NOW)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Refresh, storage, throttle, partial failure, pruning
// ---------------------------------------------------------------------------

const fixtures: FeedFetcher = fixtureFeedFetcher(FIXTURES);

describe("refreshLegalNews", () => {
  beforeEach(() => resetLegalNews());

  it("fetches all feeds, stores deduplicated headlines and records per-feed status", async () => {
    const r = await refreshLegalNews({ fetcher: fixtures, now: clock(NOW) });
    expect(r.status).toBe("ran");
    expect(r.run!.feeds.every((f) => f.ok)).toBe(true);
    expect(r.run!.added).toBe(4 + 2 + 2 + 2 + 3 + 1);
    const st = feedStatuses();
    expect(Object.keys(st).sort()).toEqual(NEWS_SOURCES.map((s) => s.id).sort());
    expect(st.livelaw).toMatchObject({ lastSuccessAt: NOW.toISOString(), itemCount: 4, added: 4, lastError: null, consecutiveFailures: 0 });
    const list = listLegalNews({}, NOW);
    expect(list.total).toBe(14);
    expect(list.stale).toBe(false);
    // Newest first by publish time; the undated item sorts by first seen.
    const keys = list.items.map((a) => a.publishedAt ?? a.firstSeenAt);
    expect([...keys].sort().reverse()).toEqual(keys);
    // Re-running the same feeds adds nothing.
    const again = await refreshLegalNews({ fetcher: fixtures, now: clock(new Date(NOW.getTime() + REFRESH_INTERVAL_MS + 1000)) });
    expect(again.run!.added).toBe(0);
    expect(listLegalNews({}, NOW).total).toBe(14);
  });

  it("is throttled to one run per 15 minutes; force waits at least 60 s", async () => {
    await refreshLegalNews({ fetcher: fixtures, now: clock(NOW) });
    const t5 = new Date(NOW.getTime() + 5 * 60_000);
    const skipped = await refreshLegalNews({ fetcher: fixtures, now: clock(t5) });
    expect(skipped).toMatchObject({ status: "skipped", reason: "throttled", lastRunAt: NOW.toISOString(), nextAllowedAt: new Date(NOW.getTime() + REFRESH_INTERVAL_MS).toISOString() });
    expect((await refreshLegalNews({ force: true, fetcher: fixtures, now: clock(new Date(NOW.getTime() + FORCE_FLOOR_MS - 1000)) })).status).toBe("skipped");
    expect((await refreshLegalNews({ force: true, fetcher: fixtures, now: clock(t5) })).status).toBe("ran");
    expect((await refreshLegalNews({ fetcher: fixtures, now: clock(new Date(t5.getTime() + REFRESH_INTERVAL_MS)) })).status).toBe("ran");
  });

  it("one failing feed never blocks the others", async () => {
    const failing: FeedFetcher = async (s, c, signal) => {
      if (s.id === "verdictum") throw new Error("connect ECONNRESET");
      if (s.id === "lawtrend") return { status: 200, body: "<html>Maintenance</html>", etag: null, lastModified: null, notModified: false };
      if (s.id === "lawbeat") return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
      return fixtures(s, c, signal);
    };
    const r = await refreshLegalNews({ fetcher: failing, now: clock(NOW), deadlineMs: 1_000 });
    const byId = Object.fromEntries(r.run!.feeds.map((f) => [f.sourceId, f]));
    expect(byId.verdictum).toMatchObject({ ok: false, error: "connect ECONNRESET" });
    expect(byId.lawtrend).toMatchObject({ ok: false, code: "not_a_feed" });
    expect(byId.lawbeat.ok).toBe(false);
    expect(byId.livelaw).toMatchObject({ ok: true, added: 4 });
    expect(r.run!.added).toBe(4 + 2 + 2);
    const st = feedStatuses();
    expect(st.verdictum).toMatchObject({ lastSuccessAt: null, consecutiveFailures: 1 });
    expect(st.verdictum.lastError?.message).toBe("connect ECONNRESET");
    expect(st.livelaw.lastError).toBeNull();
  });

  it("dedupes the same canonical URL across feeds, keeping the first publisher and recording syndication", () => {
    const raw = parseFeed(fixture("livelaw")).items[0];
    const a = normalizeItem(raw, src("livelaw"), NOW)!;
    const b = normalizeItem({ ...raw, link: `${raw.link}&fbclid=zzz` }, src("lawtrend"), NOW)!;
    expect(b.id).toBe(a.id);
    expect(mergeArticles([a], NOW)).toBe(1);
    expect(mergeArticles([b], NOW)).toBe(0);
    const stored = db().collection<NewsArticle>("legal_news").get(a.id)!;
    expect(stored.sourceId).toBe("livelaw");
    expect(stored.syndicatedBy).toEqual([{ sourceId: "lawtrend", url: a.url, seenAt: NOW.toISOString() }]);
    expect(mergeArticles([b], NOW)).toBe(0);
    expect(db().collection<NewsArticle>("legal_news").get(a.id)!.syndicatedBy).toHaveLength(1);
  });

  it("keeps first-seen and an earlier publish time when the publisher re-lists an item", () => {
    const raw = parseFeed(fixture("livelaw")).items[0];
    mergeArticles([normalizeItem(raw, src("livelaw"), NOW)!], NOW);
    const later = new Date(NOW.getTime() + 3_600_000);
    mergeArticles([normalizeItem({ ...raw, title: "Corrected headline", date: null }, src("livelaw"), later)!], later);
    const s = listLegalNews({}, later).items[0];
    expect(s).toMatchObject({ title: "Corrected headline", firstSeenAt: NOW.toISOString(), lastSeenAt: later.toISOString(), publishedAt: "2026-09-30T14:05:12.000Z" });
  });

  it("prunes to the most recent items and the age window", () => {
    const mk = (i: number, iso: string): NewsArticle => ({ id: `ln_t${i}`, url: `https://x.in/${i}`, sourceId: "livelaw", publisher: "LiveLaw", title: `T${i}`, summary: "", authors: [], categories: [], tags: [], publishedAt: iso, publishedRaw: null, firstSeenAt: iso, lastSeenAt: iso, imageUrl: null, guid: null, labels: [], courtIds: [], syndicatedBy: [] });
    const items = Array.from({ length: 30 }, (_, i) => mk(i, new Date(NOW.getTime() - i * 3_600_000).toISOString()));
    items.push(mk(99, new Date(NOW.getTime() - 50 * 86_400_000).toISOString()));
    db().collection<NewsArticle>("legal_news").putMany(items);
    expect(pruneArticles(NOW, { maxItems: 20 })).toBe(11);
    const left = db().collection<NewsArticle>("legal_news").all();
    expect(left).toHaveLength(20);
    expect(left.some((a) => a.id === "ln_t99")).toBe(false);
    expect(left.some((a) => a.id === "ln_t0")).toBe(true);
    expect(left.some((a) => a.id === "ln_t25")).toBe(false);
  });

  it("marks the list stale when no feed has succeeded recently", async () => {
    await refreshLegalNews({ fetcher: fixtures, now: clock(NOW) });
    expect(listLegalNews({}, new Date(NOW.getTime() + 4 * 3_600_000)).stale).toBe(true);
  });

  it("HTTP fetcher sends a descriptive User-Agent and conditional headers, and handles 304 and HTTP errors", async () => {
    const seen: Headers[] = [];
    const fake = (async (_url: string, init: RequestInit) => {
      const h = new Headers(init.headers);
      seen.push(h);
      if (h.get("if-none-match") === "\"v1\"") return new Response(null, { status: 304, headers: { etag: "\"v1\"" } });
      return new Response(fixture("lawtrend"), { status: 200, headers: { etag: "\"v1\"", "last-modified": "Thu, 01 Oct 2026 03:45:10 GMT", "content-type": "application/rss+xml" } });
    }) as unknown as typeof fetch;
    const fetcher = httpFeedFetcher(fake);
    const only: NewsSource[] = [src("lawtrend")];
    const r1 = await refreshLegalNews({ fetcher, sources: only, now: clock(NOW) });
    expect(r1.run!.feeds[0]).toMatchObject({ ok: true, items: 1, added: 1 });
    expect(seen[0].get("user-agent")).toMatch(/^LeClaude-India-LegalNews\//);
    expect(feedStatuses().lawtrend).toMatchObject({ etag: "\"v1\"", lastModified: "Thu, 01 Oct 2026 03:45:10 GMT", httpStatus: 200 });
    const r2 = await refreshLegalNews({ fetcher, sources: only, force: true, now: clock(new Date(NOW.getTime() + 120_000)) });
    expect(seen[1].get("if-none-match")).toBe("\"v1\"");
    expect(seen[1].get("if-modified-since")).toBe("Thu, 01 Oct 2026 03:45:10 GMT");
    expect(r2.run!.feeds[0]).toMatchObject({ ok: true, notModified: true, added: 0 });
    expect(feedStatuses().lawtrend).toMatchObject({ httpStatus: 304, notModified: true, itemCount: 1 });
    const err = httpFeedFetcher((async () => new Response("oops", { status: 500, statusText: "Internal Server Error" })) as unknown as typeof fetch);
    const r3 = await refreshLegalNews({ fetcher: err, sources: only, force: true, now: clock(new Date(NOW.getTime() + 240_000)) });
    expect(r3.run!.feeds[0]).toMatchObject({ ok: false, code: "http_500" });
    expect(feedStatuses().lawtrend).toMatchObject({ httpStatus: 500, consecutiveFailures: 1 });
  });
});

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

describe("news API", () => {
  beforeAll(async () => {
    resetLegalNews();
    await refreshLegalNews({ fetcher: fixtures, now: clock(new Date()) });
  });
  afterEach(() => { delete process.env.AUTH_MODE; });

  const list = async (qs: string) => {
    const res = await call(newsGET, nreq(`/api/news${qs}`));
    expect(res.status).toBe(200);
    return (await res.json()) as NewsListResponse;
  };

  it("lists newest first with facets", async () => {
    const r = await list("");
    expect(r.total).toBe(14);
    expect(r.facets.sources).toMatchObject({ livelaw: 4, barandbench: 2, verdictum: 2, "scc-times": 2, lawbeat: 3, lawtrend: 1 });
    expect(r.facets.courts["hc-bombay"]).toBe(1);
    expect(r.facets.courts.sci).toBe(2);
  });

  it("filters by source, court and text", async () => {
    expect((await list("?source=verdictum")).items.every((a) => a.sourceId === "verdictum")).toBe(true);
    const bom = await list("?court=hc-bombay");
    expect(bom.items.map((a) => a.title)).toEqual(["Bombay High Court Grants Bail To Accused In Cheating Case, Says Custody Not Required For Recovery"]);
    const kar = await list("?court=hc-karnataka");
    expect(kar.items).toHaveLength(1);
    expect(kar.items[0].sourceId).toBe("verdictum");
    expect((await list("?court=hc-madras")).items.map((a) => a.sourceId)).toEqual(["scc-times"]);
    expect((await list("?q=haldiram")).items.map((a) => a.sourceId)).toEqual(["barandbench"]);
    expect((await list("?q=nothing-matches-this")).total).toBe(0);
    expect((await list("?court=no-such-court")).total).toBe(0);
  });

  it("paginates with limit and before", async () => {
    const p1 = await list("?limit=5");
    expect(p1.items).toHaveLength(5);
    expect(p1.nextBefore).toBeTruthy();
    const p2 = await list(`?limit=5&before=${encodeURIComponent(p1.nextBefore!)}`);
    const p3 = await list(`?limit=5&before=${encodeURIComponent(p2.nextBefore!)}`);
    const ids = [...p1.items, ...p2.items, ...p3.items].map((a) => a.id);
    expect(new Set(ids).size).toBe(14);
    expect(p3.nextBefore).toBeNull();
  });

  it("returns the registry with status", async () => {
    const res = await call(sourcesGET, nreq("/api/news/sources"));
    const body = (await res.json()) as NewsSourcesResponse;
    expect(body.sources).toHaveLength(6);
    expect(body.sources.find((s) => s.id === "livelaw")).toMatchObject({ stored: 4, feedUrl: "https://www.livelaw.in/google_feeds.xml" });
    expect(body.sources.every((s) => s.status?.lastSuccessAt)).toBe(true);
    expect(body.excluded.length).toBeGreaterThan(0);
    expect(body.refreshIntervalMinutes).toBe(15);
  });

  it("refresh endpoint honours the throttle", async () => {
    const res = await call(refreshPOST, nreq("/api/news/refresh", { method: "POST", body: "{}", headers: { "content-type": "application/json" } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "skipped", reason: "throttled" });
  });
});
