import { describe, expect, it } from "vitest";
import type { RemoteStore, Row, SqlQuery } from "@/lib/db/remote";
import { COURTS } from "@/lib/india/courts";
import { CITIES } from "@/lib/india/forums";
import { commonsGet, commonsLicence, commonsSearchUrl, commonsTargets, parseCommonsResponse, rankCandidates, scoreCandidate, stripHtml, type CommonsCandidate, type CommonsQuery } from "@/modules/media/commons";
import { auditCourtEmblems, visibleCourtEmblems } from "@/modules/media/emblem-audit";
import { decodeDataUri, logoCandidatesFromHtml, logoHostAllowed, looksLikeSvg, REGULATOR_SITES, sanitiseSvg } from "@/modules/media/logos";
import type { StoredMedia } from "@/modules/media/store";
import { decideVisual, visualFacts, VISUAL_CHECK_VERSION, type RawVisualVision } from "@/modules/media/visual-vision";
import { readVisuals, runVisuals, type VisualsDeps } from "@/modules/media/visuals";
import { creditLine } from "@/modules/media/visuals-types";
import { REGULATOR_LABEL } from "@/modules/law/shared";

class FakeStore implements RemoteStore {
  calls: SqlQuery[] = [];
  constructor(private readonly reply: (q: SqlQuery) => Row[] = () => []) {}
  async query(q: SqlQuery): Promise<Row[]> { this.calls.push(q); return this.reply(q); }
  async transaction(qs: SqlQuery[]): Promise<Row[][]> { return Promise.all(qs.map((q) => this.query(q))); }
  find(re: RegExp) { return this.calls.filter((c) => re.test(c.query)); }
}

const em = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { value: v }]));

describe("Commons licence filter", () => {
  it("accepts CC BY-SA, CC BY, CC0 and public domain with a normalised label", () => {
    expect(commonsLicence(em({ LicenseShortName: "CC BY-SA 4.0", License: "cc-by-sa-4.0", LicenseUrl: "https://creativecommons.org/licenses/by-sa/4.0" }))).toEqual({ ok: true, license: "CC BY-SA 4.0", licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0", attribution: true });
    expect(commonsLicence(em({ LicenseShortName: "CC BY 2.0", License: "cc-by-2.0" }))).toMatchObject({ ok: true, license: "CC BY 2.0", attribution: true });
    expect(commonsLicence(em({ LicenseShortName: "CC BY-SA 3.0 in" }))).toMatchObject({ ok: true, license: "CC BY-SA 3.0 IN" });
    expect(commonsLicence(em({ LicenseShortName: "CC0", License: "cc0" }))).toMatchObject({ ok: true, license: "CC0", attribution: false, licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/" });
    expect(commonsLicence(em({ LicenseShortName: "Public domain", License: "pd" }))).toMatchObject({ ok: true, license: "Public domain", attribution: false });
  });

  it("rejects all-rights-reserved, non-free, NC/ND, insignia-restricted, unknown and missing licences", () => {
    expect(commonsLicence(em({ LicenseShortName: "All rights reserved" })).ok).toBe(false);
    expect(commonsLicence(em({ LicenseShortName: "CC BY-SA 4.0", NonFree: "true" })).ok).toBe(false);
    expect(commonsLicence(em({ LicenseShortName: "CC BY-NC-SA 2.0", License: "cc-by-nc-sa-2.0" })).ok).toBe(false);
    expect(commonsLicence(em({ LicenseShortName: "CC BY-ND 4.0" })).ok).toBe(false);
    expect(commonsLicence(em({ LicenseShortName: "Public domain", Restrictions: "insignia" })).ok).toBe(false);
    expect(commonsLicence(em({ LicenseShortName: "GFDL" }))).toMatchObject({ ok: false, reason: expect.stringMatching(/not accepted/) });
    expect(commonsLicence(em({}))).toMatchObject({ ok: false, reason: "no licence recorded" });
    expect(commonsLicence(undefined).ok).toBe(false);
  });
});

describe("artist HTML", () => {
  it("strips tags, decodes entities and collapses whitespace", () => {
    expect(stripHtml('<a href="//commons.wikimedia.org/wiki/User:Jane_Doe" title="User:Jane Doe">Jane&nbsp;Doe</a>')).toBe("Jane Doe");
    expect(stripHtml('<span class="fn"><bdi>A.&#32;Savin</bdi></span> &amp; <i>Friends</i>\n')).toBe("A. Savin & Friends");
    expect(stripHtml("<script>alert(1)</script>Ram &#x2014; Lal")).toBe("Ram — Lal");
    expect(stripHtml("<br/>")).toBeNull();
    expect(stripHtml(null)).toBeNull();
  });
});

const lic = commonsLicence(em({ LicenseShortName: "CC BY-SA 4.0" }));
const cand = (o: Partial<CommonsCandidate>): CommonsCandidate => ({
  title: "File:Bombay High Court.jpg", imageUrl: "https://upload.wikimedia.org/a.jpg", pageUrl: "https://commons.wikimedia.org/wiki/File:Bombay_High_Court.jpg",
  width: 3000, height: 2000, mime: "image/jpeg", licence: lic, author: "Jane Doe", query: "Bombay High Court building", label: "Bombay High Court building, Fort, Mumbai", ...o,
});

describe("candidate scoring", () => {
  const req = ["bombay high court", "high court bombay"];
  it("excludes unusable files: bad licence, unattributable, SVG, small, off-subject or non-photographic titles", () => {
    expect(scoreCandidate(cand({ licence: commonsLicence(em({ LicenseShortName: "All rights reserved" })) }), req)).toBeNull();
    expect(scoreCandidate(cand({ author: null }), req)).toBeNull();
    expect(scoreCandidate(cand({ author: null, licence: commonsLicence(em({ LicenseShortName: "CC0" })) }), req)).not.toBeNull();
    expect(scoreCandidate(cand({ mime: "image/svg+xml" }), req)).toBeNull();
    expect(scoreCandidate(cand({ width: 500, height: 300 }), req)).toBeNull();
    expect(scoreCandidate(cand({ title: "File:Mumbai skyline.jpg" }), req)).toBeNull();
    for (const t of ["File:Bombay High Court logo.png", "File:Bombay High Court interior.jpg", "File:Bombay High Court map.jpg", "File:Bombay High Court emblem.jpg"]) expect(scoreCandidate(cand({ title: t }), req), t).toBeNull();
  });

  it("prefers a large landscape JPEG naming the subject, deterministically", () => {
    const ranked = rankCandidates([
      cand({ title: "File:Bombay High Court portrait crop.png", mime: "image/png", width: 1200, height: 1800 }),
      cand({ title: "File:Bombay High Court, Mumbai.jpg", width: 4000, height: 2600 }),
      cand({ title: "File:High Court Bombay 2010.jpg", width: 1100, height: 1000 }),
      cand({ title: "File:Bombay High Court, Mumbai.jpg", width: 4000, height: 2600 }), // duplicate title
    ], () => req);
    expect(ranked.map((c) => c.title)).toEqual(["File:Bombay High Court, Mumbai.jpg", "File:High Court Bombay 2010.jpg"]);
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });

  it("has a curated query for every court and every city", () => {
    const t = commonsTargets();
    expect(t.filter((x) => x.kind === "court_building").map((x) => x.key).sort()).toEqual(COURTS.map((c) => c.id).sort());
    expect(t.filter((x) => x.kind === "city").map((x) => x.key).sort()).toEqual(CITIES.map((c) => c.id).sort());
    expect(COURTS).toHaveLength(26);
  });
});

describe("Commons API client", () => {
  const q: CommonsQuery = { q: "Bombay High Court building", label: "Bombay High Court building, Fort, Mumbai", require: ["bombay high court"] };
  const body = {
    query: { pages: [
      { title: "File:Bombay High Court.jpg", index: 2, imageinfo: [{ url: "https://upload.wikimedia.org/wikipedia/commons/a/ab/Bombay_High_Court.jpg", thumburl: "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Bombay_High_Court.jpg/1280px-Bombay_High_Court.jpg", descriptionurl: "https://commons.wikimedia.org/wiki/File:Bombay_High_Court.jpg", width: 4000, height: 2600, mime: "image/jpeg", extmetadata: em({ LicenseShortName: "CC BY-SA 3.0", Artist: '<a href="//x">A. Savin</a>', LicenseUrl: "https://creativecommons.org/licenses/by-sa/3.0" }) }] },
      { title: "File:Evil.jpg", index: 1, imageinfo: [{ thumburl: "https://evil.example/x.jpg", descriptionurl: "https://commons.wikimedia.org/wiki/File:Evil.jpg", width: 4000, height: 2000, mime: "image/jpeg" }] },
    ] },
  };

  it("builds a namespace-6 generator search with a bounded standard thumbnail, and parses candidates", () => {
    const u = new URL(commonsSearchUrl("Bombay High Court building"));
    expect(u.origin + u.pathname).toBe("https://commons.wikimedia.org/w/api.php");
    expect(u.searchParams.get("generator")).toBe("search");
    expect(u.searchParams.get("gsrnamespace")).toBe("6");
    expect(u.searchParams.get("iiprop")).toBe("url|size|mime|extmetadata");
    expect(u.searchParams.get("iiurlwidth")).toBe("1280");
    expect(u.searchParams.get("maxlag")).toBe("5");
    const c = parseCommonsResponse(body, q);
    // The candidate whose image is not on upload.wikimedia.org is dropped.
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ author: "A. Savin", width: 4000, licence: { ok: true, license: "CC BY-SA 3.0" }, imageUrl: expect.stringContaining("/thumb/") });
  });

  it("sends a descriptive User-Agent and backs off on 429 and maxlag before succeeding", async () => {
    const seen: { ua: string | null }[] = [];
    const replies = [
      new Response("{}", { status: 429, headers: { "retry-after": "2" } }),
      new Response(JSON.stringify({ error: { code: "maxlag", info: "Waiting for a database server" } }), { status: 200, headers: { "content-type": "application/json" } }),
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }),
    ];
    const fetchImpl = (async (_u: string, init: RequestInit) => { seen.push({ ua: new Headers(init.headers).get("user-agent") }); return replies.shift()!; }) as unknown as typeof fetch;
    const waits: number[] = [];
    const out = await commonsGet<typeof body>(commonsSearchUrl(q.q), { fetchImpl, sleep: async (ms) => { waits.push(ms); } });
    expect(out.query.pages).toHaveLength(2);
    expect(waits).toEqual([2000, 2000]);
    expect(seen[0].ua).toMatch(/^LeClaude-VisualLibrary\/1\.0 \(/);
  });

  it("gives up after bounded retries and refuses non-Commons hosts", async () => {
    const fetchImpl = (async () => new Response("{}", { status: 503 })) as unknown as typeof fetch;
    await expect(commonsGet(commonsSearchUrl("x"), { fetchImpl, sleep: async () => {} })).rejects.toMatchObject({ code: "rate_limited" });
    await expect(commonsGet("https://evil.example/w/api.php", { fetchImpl, sleep: async () => {} })).rejects.toMatchObject({ code: "blocked_host" });
  });
});

describe("visual vision verdicts", () => {
  const raw = (o: Partial<RawVisualVision>): RawVisualVision => ({ kind: "building", contains_state_emblem: false, has_watermark: false, quality: 4, is_interior: false, people_are_subject: false, subject_match: "yes", reason: "A colonial court building", alt: "A stone building", ...o });
  const now = new Date("2026-10-02T00:00:00Z");
  it("never shows an image with the State Emblem, and fails closed when the flag is missing", () => {
    expect(decideVisual("logo", visualFacts(raw({ kind: "logo", contains_state_emblem: true })), null, now)).toMatchObject({ ok: false, containsStateEmblem: true, reason: expect.stringMatching(/State Emblem/) });
    expect(decideVisual("building", visualFacts(raw({ contains_state_emblem: undefined })), null, now)).toMatchObject({ ok: false, containsStateEmblem: true });
    expect(decideVisual("building", null, null, now).ok).toBe(false);
  });
  it("requires buildings as the subject, landmarks for cities, and a logo graphic for logos", () => {
    expect(decideVisual("building", visualFacts(raw({})), null, now)).toMatchObject({ ok: true, check: VISUAL_CHECK_VERSION, quality: 4 });
    expect(decideVisual("building", visualFacts(raw({ is_interior: true })), null, now).reason).toMatch(/interior/);
    expect(decideVisual("building", visualFacts(raw({ people_are_subject: true })), null, now).ok).toBe(false);
    expect(decideVisual("building", visualFacts(raw({ kind: "landmark" })), null, now).ok).toBe(false);
    expect(decideVisual("landmark", visualFacts(raw({ kind: "landmark" })), null, now).ok).toBe(true);
    expect(decideVisual("landmark", visualFacts(raw({ kind: "landmark", has_watermark: true })), null, now).reason).toMatch(/watermark/);
    expect(decideVisual("landmark", visualFacts(raw({ kind: "landmark", quality: 2 })), null, now).ok).toBe(false);
    expect(decideVisual("landmark", visualFacts(raw({ kind: "landmark", subject_match: "no" })), null, now).ok).toBe(false);
    expect(decideVisual("logo", visualFacts(raw({ kind: "other", reason: "a banner" })), null, now).ok).toBe(false);
    expect(decideVisual("logo", visualFacts(raw({ kind: "logo" })), null, now).ok).toBe(true);
  });
});

describe("regulator logos", () => {
  it("covers every regulator the statutes corpus names, except State GST", () => {
    expect(REGULATOR_SITES.map((r) => r.key).sort()).toEqual(Object.keys(REGULATOR_LABEL).filter((k) => k !== "state-gst").sort());
  });
  it("finds header logos, og:image and large icons in order, skipping campaign banners", () => {
    const html = `<html><head><meta property="og:image" content="/og.png"><link rel="apple-touch-icon" sizes="180x180" href="/apple.png"><link rel="icon" sizes="32x32" href="/f32.png"><link rel="icon" sizes="192x192" href="/f192.png"></head>
      <body><img src="/images/g20-logo.png" alt="G20 logo"><img class="site-logo" src="/images/rbi_logo.png" alt="RBI"><img src="/banner.jpg"></body></html>`;
    expect(logoCandidatesFromHtml(html, "https://www.rbi.org.in/home.aspx")).toEqual([
      { url: "https://www.rbi.org.in/images/rbi_logo.png", via: "header_img" },
      { url: "https://www.rbi.org.in/og.png", via: "og_image" },
      { url: "https://www.rbi.org.in/apple.png", via: "apple_touch_icon" },
      { url: "https://www.rbi.org.in/f192.png", via: "icon" },
    ]);
  });
  it("allows the site's own domain and government hosts only", () => {
    const rbi = REGULATOR_SITES.find((r) => r.key === "rbi")!;
    expect(logoHostAllowed("https://rbidocs.rbi.org.in/x.png", rbi)).toBe(true);
    expect(logoHostAllowed("https://cdnbbsr.s3waas.gov.in/x.png", rbi)).toBe(true);
    expect(logoHostAllowed("https://evil.example/rbi.png", rbi)).toBe(false);
    expect(logoHostAllowed("file:///etc/passwd", rbi)).toBe(false);
  });
  it("sanitises SVG before rasterising: no entities, external references or foreign content", () => {
    expect(() => sanitiseSvg(`<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg>&x;</svg>`)).toThrow(/DOCTYPE/);
    expect(() => sanitiseSvg(`<svg><image href="https://evil.example/a.png"/></svg>`)).toThrow(/external/);
    expect(() => sanitiseSvg(`<svg><style>@import url(https://x)</style></svg>`)).toThrow(/external|import/);
    expect(() => sanitiseSvg(`<svg><foreignObject/></svg>`)).toThrow(/foreign/);
    expect(sanitiseSvg(`<svg onload="alert(1)"><script>alert(1)</script><use href="#a"/></svg>`)).toBe(`<svg><use href="#a"/></svg>`);
    expect(looksLikeSvg(new TextEncoder().encode(`﻿  <?xml version="1.0"?><svg/>`), null)).toBe(true);
    expect(decodeDataUri("data:image/svg+xml;utf8,%3Csvg%2F%3E")).toMatchObject({ type: "image/svg+xml" });
  });
});

// ---------------------------------------------------------------------------
// Campaign runs
// ---------------------------------------------------------------------------

const PNG_DATA = "data:image/png;base64,iVBORw0KGgo=";
function media(url: string, existed = false): StoredMedia {
  let h = 0;
  for (const ch of url) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const id = h.toString(16).padStart(8, "0").repeat(8);
  return { id, url: `/api/media/${id}`, mime: "image/jpeg", size: 1000, width: 1280, height: 853, existed, dataUrl: PNG_DATA };
}

const okRaw = (kind: string): RawVisualVision => ({ kind, contains_state_emblem: false, has_watermark: false, quality: 4, is_interior: false, people_are_subject: false, subject_match: "yes", reason: `a ${kind}`, alt: `a ${kind}` });

function commonsCandidates(q: CommonsQuery): CommonsCandidate[] {
  const title = `File:${q.require[0].replace(/\b\w/g, (m) => m.toUpperCase())}.jpg`;
  return [cand({ title, query: q.q, label: q.label, imageUrl: `https://upload.wikimedia.org/thumb/${encodeURIComponent(title)}`, pageUrl: `https://commons.wikimedia.org/wiki/${encodeURIComponent(title)}` })];
}

function vdeps(store: FakeStore, over: Partial<VisualsDeps> = {}): VisualsDeps {
  return {
    store,
    searchCommons: async (q) => commonsCandidates(q),
    storeImage: async (url) => media(url),
    storeBytes: async (_b, _t, src) => media(src),
    fetchBytes: async () => { throw new Error("offline"); },
    scrapeBranding: async () => null,
    rasterise: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 2, 0, 0, 0, 1, 0, ...new Array(80).fill(0)]),
    classify: async (_d, expect) => ({ raw: okRaw(expect === "building" ? "building" : expect === "landmark" ? "landmark" : "logo"), model: "test-vision" }),
    dominant: async () => "#336699",
    now: () => new Date("2026-10-02T10:00:00Z"),
    deadlineMs: 60_000,
    ...over,
  };
}

describe("visuals campaign", () => {
  it("stores a vision-checked Commons photograph with its credit and dominant colour", async () => {
    const store = new FakeStore();
    const r = await runVisuals({ kinds: ["court_building"], keys: ["hc-bombay"] }, vdeps(store));
    expect(r.items).toEqual([expect.objectContaining({ kind: "court_building", key: "hc-bombay", status: "stored", license: "CC BY-SA 4.0", author: "Jane Doe", tried: 1 })]);
    expect(r.counts).toEqual({ stored: 1, rejected: 0, skipped: 0, failed: 0 });
    expect(r.stop).toBe("done");
    const ins = store.find(/INSERT INTO visuals/)[0];
    expect(ins.params?.slice(0, 2)).toEqual(["court_building", "hc-bombay"]);
    expect(JSON.parse(String(ins.params?.[5]))).toEqual({ author: "Jane Doe", license: "CC BY-SA 4.0", licenseUrl: null, sourceUrl: expect.stringMatching(/^https:\/\/commons\.wikimedia\.org\/wiki\//), sourceName: "Wikimedia Commons" });
    expect(ins.params?.[6]).toBe("Bombay High Court building, Fort, Mumbai");
    expect(ins.params?.[7]).toBe("#336699");
    expect(ins.params?.[9]).toBe(false);
    expect(store.find(/UPDATE media_assets SET author/)[0].params).toEqual([expect.any(String), "Jane Doe", null, "Bombay High Court building, Fort, Mumbai", "#336699"]);
    expect(store.find(/CREATE TABLE IF NOT EXISTS visuals/)).toHaveLength(1);
    expect(store.find(/INSERT INTO enrichment_state/)[0].params?.[0]).toMatch(/"target":"visuals"/);
  });

  it("records a State-Emblem image as hidden and never as shown, then tries the next candidate", async () => {
    const store = new FakeStore();
    const r = await runVisuals({ kinds: ["regulator_logo"], keys: ["mca"] }, vdeps(store, {
      scrapeBranding: async () => ({ logo: "https://www.mca.gov.in/logo.png", image: "https://www.mca.gov.in/og.jpg" }),
      fetchBytes: async (url) => ({ bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(100).fill(0)]), contentType: "image/jpeg", finalUrl: url }),
      classify: async () => ({ raw: { ...okRaw("logo"), contains_state_emblem: true, reason: "Lion Capital above the ministry name" }, model: null }),
    }));
    expect(r.items[0]).toMatchObject({ key: "mca", status: "rejected", stateEmblem: true, tried: 2 });
    const ins = store.find(/INSERT INTO visuals/);
    expect(ins).toHaveLength(1);
    expect(ins[0].params?.[9]).toBe(true); // hidden
    expect(ins[0].query).toMatch(/WHERE visuals\.hidden = true/); // never replaces a shown row
    expect(JSON.parse(String(ins[0].params?.[8]))).toMatchObject({ ok: false, containsStateEmblem: true });
    expect(store.find(/UPDATE media_assets SET author/)).toHaveLength(0);
  });

  it("rasterises an SVG logo and stores it as PNG", async () => {
    const store = new FakeStore();
    const types: (string | null)[] = [];
    const r = await runVisuals({ keys: ["sebi"] }, vdeps(store, {
      scrapeBranding: async () => ({ logo: "data:image/svg+xml;base64," + Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="80"><rect width="200" height="80"/></svg>`).toString("base64"), image: null }),
      storeBytes: async (_b, type, src) => { types.push(type); return media(src); },
    }));
    expect(r.items[0]).toMatchObject({ kind: "regulator_logo", key: "sebi", status: "stored", license: "Logo of Securities and Exchange Board of India", author: "Securities and Exchange Board of India" });
    expect(types).toEqual(["image/png"]);
    expect(creditLine({ credit: JSON.parse(String(store.find(/INSERT INTO visuals/)[0].params?.[5])) })).toBe("Securities and Exchange Board of India · Logo of Securities and Exchange Board of India · Securities and Exchange Board of India");
  });

  it("does not store anything when no vision model is configured", async () => {
    const store = new FakeStore();
    const r = await runVisuals({ keys: ["delhi"] }, vdeps(store, { classify: async () => null }));
    expect(r.items[0]).toMatchObject({ kind: "city", key: "delhi", status: "skipped", reason: expect.stringMatching(/No vision model/) });
    expect(store.find(/INSERT INTO visuals/)).toHaveLength(0);
  });

  it("is idempotent: keys already shown are skipped without any search unless refresh is set", async () => {
    const store = new FakeStore((q) => (/SELECT 1 AS x FROM visuals/.test(q.query) ? [{ x: "1" }] : []));
    let searches = 0;
    const d = vdeps(store, { searchCommons: async (q) => { searches++; return commonsCandidates(q); } });
    const r = await runVisuals({ keys: ["sci", "mumbai"] }, d);
    expect(r.items.map((i) => [i.key, i.status])).toEqual([["sci", "skipped"], ["mumbai", "skipped"]]);
    expect(searches).toBe(0);
    const again = await runVisuals({ keys: ["sci"], refresh: true }, d);
    expect(again.items[0].status).toBe("stored");
    expect(searches).toBe(1);
  });

  it("re-uses a stored verdict for the same bytes instead of calling the model", async () => {
    const prior = JSON.stringify(decideVisual("landmark", visualFacts(okRaw("landmark")), "m", new Date()));
    const store = new FakeStore((q) => (/SELECT vision FROM media_assets/.test(q.query) ? [{ vision: prior }] : []));
    let calls = 0;
    const r = await runVisuals({ keys: ["jaipur"] }, vdeps(store, { storeImage: async (url) => media(url, true), classify: async () => { calls++; return null; } }));
    expect(r.items[0].status).toBe("stored");
    expect(calls).toBe(0);
  });

  it("reports unknown keys and search failures per key, and stops at the deadline with the remaining keys", async () => {
    const store = new FakeStore();
    const r = await runVisuals({ keys: ["hc-nowhere", "state-gst", "hc-madras"] }, vdeps(store, { searchCommons: async () => { throw new Error("HTTP 500"); } }));
    expect(r.items).toEqual([
      expect.objectContaining({ key: "hc-nowhere", status: "skipped", reason: "Not a registered court, city or regulator key" }),
      expect.objectContaining({ key: "state-gst", status: "skipped", reason: expect.stringMatching(/no single publisher/) }),
      expect.objectContaining({ key: "hc-madras", status: "failed", reason: expect.stringMatching(/HTTP 500/) }),
    ]);
    const late = await runVisuals({ kinds: ["city"] }, vdeps(new FakeStore(), { deadlineMs: -1 }));
    expect(late.stop).toBe("deadline");
    expect(late.remaining).toHaveLength(CITIES.length);
  });
});

// ---------------------------------------------------------------------------
// Read API and emblem re-audit (fake store that applies the hidden/ok filters the SQL expresses)
// ---------------------------------------------------------------------------

describe("readVisuals", () => {
  const credit = (s: string) => JSON.stringify({ author: "A. Savin", license: "CC BY-SA 3.0", licenseUrl: "https://creativecommons.org/licenses/by-sa/3.0", sourceUrl: `https://commons.wikimedia.org/wiki/File:${s}.jpg`, sourceName: "Wikimedia Commons" });
  const rows: Array<Row & { hidden: string; ok: string; emblem: string }> = [
    { kind: "court_building", key: "hc-bombay", media_id: "a".repeat(64), credit: credit("BHC"), alt: "Bombay High Court building, Fort, Mumbai", dominant: "#A0B0C0", checked_at: "2026-10-02T10:00:00Z", width: "1280", height: "853", hidden: "f", ok: "true", emblem: "false" },
    { kind: "city", key: "delhi", media_id: "b".repeat(64), credit: credit("India_Gate"), alt: "India Gate, New Delhi", dominant: null, checked_at: "2026-10-02T11:00:00Z", width: "1280", height: "720", hidden: "f", ok: "true", emblem: "false" },
    { kind: "regulator_logo", key: "mca", media_id: "c".repeat(64), credit: credit("x"), alt: "Logo", dominant: null, checked_at: "2026-10-02T12:00:00Z", width: "200", height: "200", hidden: "t", ok: "false", emblem: "true" },
  ];
  const store = () => new FakeStore((q) => {
    if (/to_regclass\('public\.visuals'\)/.test(q.query)) return [{ v: "visuals" }];
    if (/FROM visuals v JOIN media_assets/.test(q.query)) {
      expect(q.query).toMatch(/v\.hidden = false/);
      expect(q.query).toMatch(/containsStateEmblem/);
      return rows.filter((r) => r.hidden === "f" && r.ok === "true" && r.emblem === "false");
    }
    return [];
  });

  it("returns the contract shape with only shown visuals", async () => {
    const res = await readVisuals({ store: store() });
    expect(Object.keys(res).sort()).toEqual(["cities", "courts", "regulators", "updatedAt"]);
    expect(res.courts["hc-bombay"]).toEqual({ kind: "court_building", key: "hc-bombay", url: `/api/media/${"a".repeat(64)}`, width: 1280, height: 853, alt: "Bombay High Court building, Fort, Mumbai", credit: { author: "A. Savin", license: "CC BY-SA 3.0", licenseUrl: "https://creativecommons.org/licenses/by-sa/3.0", sourceUrl: "https://commons.wikimedia.org/wiki/File:BHC.jpg", sourceName: "Wikimedia Commons" }, dominant: "#a0b0c0" });
    expect(res.cities.delhi.dominant).toBeNull();
    expect(res.regulators).toEqual({});
    expect(res.updatedAt).toBe("2026-10-02T11:00:00Z");
  });

  it("returns empty maps without a store or before the table exists", async () => {
    expect(await readVisuals({ store: null })).toEqual({ courts: {}, cities: {}, regulators: {}, updatedAt: null });
    expect(await readVisuals({ store: new FakeStore() })).toEqual({ courts: {}, cities: {}, regulators: {}, updatedAt: null });
  });
});

describe("court emblem re-audit", () => {
  const assets = [
    { court_id: "hc-delhi", kind: "emblem", media_id: "d".repeat(64), source_url: "https://delhihighcourt.nic.in/logo.png", page_url: null, hidden: false, vision: null as string | null },
    { court_id: "hc-telangana", kind: "emblem", media_id: "e".repeat(64), source_url: "https://tshc.gov.in/logo.png", page_url: null, hidden: false, vision: null as string | null },
    { court_id: "sci", kind: "logo", media_id: "f".repeat(64), source_url: "https://www.sci.gov.in/logo.png", page_url: null, hidden: false, vision: null as string | null },
  ];
  const store = new FakeStore((q) => {
    if (/SELECT court_id, kind, media_id FROM court_assets/.test(q.query)) return assets.map((a) => ({ court_id: a.court_id, kind: a.kind, media_id: a.media_id }));
    if (/SELECT id, mime, bytes/.test(q.query)) return [{ id: String(q.params?.[0]), mime: "image/png", bytes: "\\x89504e47", size: "4", width: "1", height: "1", source_url: "x", page_url: null, publisher: null, license_note: null, fetched_at: null, vision: null }];
    if (/UPDATE court_assets SET hidden/.test(q.query)) {
      const a = assets.find((x) => x.court_id === q.params?.[0] && x.kind === q.params?.[1])!;
      a.hidden = q.params?.[2] === true;
      a.vision = String(q.params?.[3]);
      return [];
    }
    if (/SELECT court_id, kind, media_id, source_url, page_url FROM court_assets/.test(q.query)) {
      expect(q.query).toMatch(/hidden IS NOT TRUE/);
      return assets.filter((a) => !a.hidden).map(({ court_id, kind, media_id, source_url, page_url }) => ({ court_id, kind, media_id, source_url, page_url }));
    }
    return [];
  });

  it("hides emblems that show the State Emblem, records the verdict, and the emblems list omits them", async () => {
    const before = await visibleCourtEmblems({ store });
    expect(Object.keys(before.emblems).sort()).toEqual(["hc-delhi", "hc-telangana", "sci"]);
    const r = await auditCourtEmblems({ store, classify: async (_d, _expect, subject) => {
      return { raw: { ...okRaw("logo"), contains_state_emblem: /Delhi|Supreme/.test(subject) }, model: "test-vision" };
    } });
    expect(r.hidden.sort()).toEqual(["hc-delhi", "sci"]);
    expect(r.items.find((i) => i.courtId === "hc-telangana")).toMatchObject({ status: "kept" });
    expect(JSON.parse(assets[0].vision!)).toMatchObject({ containsStateEmblem: true, ok: false, expect: "emblem_audit" });
    expect(store.find(/UPDATE media_assets SET vision/)).toHaveLength(3);
    const after = await visibleCourtEmblems({ store });
    expect(Object.keys(after.emblems)).toEqual(["hc-telangana"]);
  });

  it("leaves emblems untouched and reports them unchecked when no vision model is configured", async () => {
    const s = new FakeStore((q) => (/SELECT court_id, kind, media_id FROM court_assets/.test(q.query) ? [{ court_id: "hc-delhi", kind: "emblem", media_id: "d".repeat(64) }] : /SELECT id, mime, bytes/.test(q.query) ? [{ id: "d".repeat(64), mime: "image/png", bytes: "\\x89504e47", size: "4", width: null, height: null, source_url: "x", page_url: null, publisher: null, license_note: null, fetched_at: null, vision: null }] : []));
    const r = await auditCourtEmblems({ store: s, classify: async () => null });
    expect(r.items[0]).toMatchObject({ courtId: "hc-delhi", status: "unchecked" });
    expect(s.find(/UPDATE court_assets/)).toHaveLength(0);
  });
});
