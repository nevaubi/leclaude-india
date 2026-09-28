import { beforeAll, describe, expect, it, vi } from "vitest";

// Private database, no background work, no real network: every request goes to the fixture router below.
vi.hoisted(() => {
  process.env.LECLAUDE_DATA_DIR = process.env.VITEST_DATA_DIR ? `${process.env.VITEST_DATA_DIR}/india-sources-${process.pid}` : `${process.env.TMPDIR || "/tmp"}/india-sources-vitest-${process.pid}`;
  process.env.LECLAUDE_BACKGROUND = "off";
  process.env.WORKFLOW_SCHEDULER_DISABLED = "1";
  process.env.INTEL_OFFLINE = "1";
  process.env.OPENAI_API_KEY = "";
  process.env.LECLAUDE_CORPUS_DIRS = "";
  process.env.INDIAN_KANOON_API_TOKEN = "";
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { memoryHttpCache, TokenBucket } from "@/lib/ai/toolkit/http";
import { db, resetSqlite } from "@/lib/db";
import { HIGH_COURTS } from "@/lib/india/courts";
import { getAdapter, listAdapters } from "@/modules/intel/adapters";
import { createProviders, type IntelProviders } from "@/modules/intel/providers";
import { runFailed, runSource } from "@/modules/intel/run";
import { INDIA_SOURCE_IDS, indiaSources, referenceSources, SEED_SOURCE_IDS, systemSources } from "@/modules/intel/seed";
import { createSource } from "@/modules/intel/service";
import { getDocumentText, intelDocuments, listChunks } from "@/modules/intel/store";
import { ecourtsCnrLink } from "@/modules/india/sources/ecourts";
import { hcPdfKey, parseHcMetadata, type HcMetadataJson } from "@/modules/india/sources/hc";
import { createIndiaCode, parseActItem, parseSearchPage, parseSectionItem, type DspaceItem } from "@/modules/india/sources/india-code";
import { courtForDocsource, createIndianKanoon, ikDocToJudgment, ikQuery } from "@/modules/india/sources/indian-kanoon";
import { exportRecordToJudgment, licensedStatus, resolveExportCourt } from "@/modules/india/sources/licensed";
import { decodeCursor, yearsFor } from "@/modules/india/sources/open-data";
import { findHcNeutral, isoDate, normalizeNeutral, splitParties } from "@/modules/india/sources/parse-util";
import { createIndiaProviders } from "@/modules/india/sources/providers";
import { parseListObjectsV2 } from "@/modules/india/sources/s3";
import { parseSciMetadata, parseScrCitation, type SciMetadataJson } from "@/modules/india/sources/sci";
import { findJudgment, getEnactment, getOriginalFile, getSection, getSections, indiaEnactments, listJudgments } from "@/modules/india/sources/store";

const FX = path.resolve(__dirname, "fixtures");
const readJson = <T>(p: string): T => JSON.parse(fs.readFileSync(path.join(FX, p), "utf8")) as T;
const SC1 = readJson<SciMetadataJson>("india-sci/2024_10_108_125.json");
const SC2 = readJson<SciMetadataJson>("india-sci/2024_10_1313_1343.json");
const SC_OLD = readJson<SciMetadataJson>("india-sci/1995_1_1010_1191.json");
const PDF = new Uint8Array(fs.readFileSync(path.join(FX, "india-hc/36_29__taphc__HBHC010000032024_1_2024-08-13.pdf")));

/** HC fixture file → (S3 key, JSON). File names are `<court>__<bench>__<basename>.json`. */
function hcFixture(file: string, year = 2024): { key: string; json: HcMetadataJson } {
  const [court, bench, base] = file.replace(/\.json$/, "").split("__");
  return { key: `metadata/json/year=${year}/court=${court}/bench=${bench}/${base}.json`, json: readJson<HcMetadataJson>(`india-hc/${file}`) };
}

beforeAll(() => { resetSqlite(); db(); });

// ---------------------------------------------------------------------------
// Fixture HTTP router (fetchImpl for safeFetch; the DNS check is skipped for injected transports)
// ---------------------------------------------------------------------------
type Route = (url: URL, init: RequestInit) => Response | Promise<Response>;
function router(routes: [RegExp, Route][], log: { url: string; method: string; headers: Record<string, string> }[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => { headers[k] = v; });
    log.push({ url: url.href, method: init.method ?? "GET", headers });
    for (const [re, fn] of routes) if (re.test(url.href)) return fn(url, init);
    return new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404, headers: { "content-type": "application/xml" } });
  }) as typeof fetch;
}
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
const pdf = () => new Response(PDF, { status: 200, headers: { "content-type": "application/pdf" } });

function listXml(prefix: string, objects: { key: string; etag?: string; lastModified?: string }[], o: { prefixes?: string[]; truncated?: boolean; next?: string } = {}): Response {
  const body = `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>b</Name><Prefix>${prefix}</Prefix>${o.next ? `<NextContinuationToken>${o.next}</NextContinuationToken>` : ""}<KeyCount>${objects.length}</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>${o.truncated ? "true" : "false"}</IsTruncated>${objects.map((x) => `<Contents><Key>${x.key}</Key><LastModified>${x.lastModified ?? "2026-06-04T05:23:50.000Z"}</LastModified><ETag>&quot;${x.etag ?? "e1"}&quot;</ETag><Size>100</Size><StorageClass>STANDARD</StorageClass></Contents>`).join("")}${(o.prefixes ?? []).map((p) => `<CommonPrefixes><Prefix>${p}</Prefix></CommonPrefixes>`).join("")}</ListBucketResult>`;
  return new Response(body, { status: 200, headers: { "content-type": "application/xml" } });
}

function providersWith(fetchImpl: typeof fetch, env: { INDIAN_KANOON_API_TOKEN?: string } = {}): IntelProviders {
  const base = createProviders({ cache: memoryHttpCache(), offline: true, sleep: async () => {} });
  return { ...base, india: createIndiaProviders({ fetchImpl, offline: false, sleep: async () => {}, env, limiter: new TokenBucket(10_000, 10_000) }) } as IntelProviders;
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------
describe("Supreme Court metadata parser (live fixtures)", () => {
  it("parses title, parties, neutral and SCR citations, coram with author, bench, date, case and translations", () => {
    const { draft, englishPdfKey, unmappedLanguages } = parseSciMetadata(SC1, { key: "metadata/json/year=2024/2024_10_108_125.json", bucketUrl: "https://indian-supreme-court-judgments.s3.amazonaws.com" });
    expect(draft).toMatchObject({
      source: "sci-open-data", externalId: "2024_10_108_125", courtId: "sci", title: "Vijay Singh @ Vijay Kr. Sharma versus The State of Bihar",
      petitioner: "VIJAY SINGH @ VIJAY KR. SHARMA", respondent: "THE STATE OF BIHAR", neutralCitation: "2024 INSC 735", cnr: "ESCR010004822024",
      judges: ["BELA M. TRIVEDI", "SATISH CHANDRA SHARMA"], author: "BELA M. TRIVEDI", benchStrength: 2, decisionDate: "2024-09-25",
      caseNumber: "CRIMINAL APPEAL No. 1031/2015", caseType: "CRIMINAL APPEAL", disposal: "Disposed off", language: "en",
    });
    expect(draft.citations).toEqual(expect.arrayContaining([
      { raw: "2024 INSC 735", kind: "neutral", neutral: "2024 INSC 735", year: 2024, courtId: "sci" },
      { raw: "[2024] 10 S.C.R. 108", kind: "reporter", reporter: "SCR", year: 2024, volume: 10, page: 108, courtId: "sci" },
    ]));
    expect(draft.translations).toEqual([
      { language: "hi", origin: "court_published", url: "https://indian-supreme-court-judgments.s3.amazonaws.com/data/pdf/year=2024/regional/2024_10_108_125_HIN.pdf" },
      { language: "pa", origin: "court_published", url: "https://indian-supreme-court-judgments.s3.amazonaws.com/data/pdf/year=2024/regional/2024_10_108_125_PUN.pdf" },
    ]);
    expect(unmappedLanguages).toEqual([]);
    expect(englishPdfKey).toBe("data/pdf/year=2024/english/2024_10_108_125_EN.pdf");
    expect(draft.headnote).toMatch(/^Issue for Consideration/);
  });
  it("handles a three-judge bench without translations and a 1995 record", () => {
    const b = parseSciMetadata(SC2).draft;
    expect(b).toMatchObject({ benchStrength: 3, author: "SANJIV KHANNA", neutralCitation: "2024 INSC 755", decisionDate: "2024-10-03", disposal: "Case Partly allowed", translations: [] });
    expect(b.judges).toEqual(["SANJIV KHANNA", "SANJAY KUMAR", "R MAHADEVAN"]);
    const old = parseSciMetadata(SC_OLD).draft;
    expect(old).toMatchObject({ neutralCitation: "1995 INSC 105", decisionDate: "1995-02-08", caseType: "SUO MOTO CONTEMPT PETITION (CIVIL)", benchStrength: 3, author: undefined });
    expect(old.judges).toEqual(["P.B. SAWANT", "S. MOHAN", "B.P. JEEVAN REDDY"]);
  });
  it("keeps unknown translation codes out of the translation list instead of mapping them", () => {
    const html = SC1.raw_html!.replace("<option value='PUN'>", "<option value='XYZ'>");
    const r = parseSciMetadata({ ...SC1, raw_html: html });
    expect(r.unmappedLanguages).toEqual(["XYZ"]);
    expect(r.draft.translations.map((t) => t.language)).toEqual(["hi"]);
    expect(r.draft.issues?.[0]).toMatch(/unregistered languages: XYZ/);
  });
  it("parses SCR citations strictly", () => {
    expect(parseScrCitation("[1995] 1 S.C.R. 1010")).toMatchObject({ kind: "reporter", year: 1995, volume: 1, page: 1010 });
    expect(parseScrCitation("1995 SCR 12 (some other form)")).toMatchObject({ kind: "unknown" });
  });
});

describe("High Court metadata parser (live fixtures)", () => {
  it("resolves the Dharwad and Kalaburagi benches and their neutral citations", () => {
    const d = hcFixture("29_3__karhcdharwad__KAHC020000022024_1_2024-05-31.json");
    const { draft, court, pdfKey } = parseHcMetadata(d.json, { key: d.key });
    expect(court?.id).toBe("hc-karnataka");
    expect(draft).toMatchObject({
      courtId: "hc-karnataka", benchId: "kar-dharwad", neutralCitation: "2024:KHC-D:7336", caseNumber: "RSA/100004/2024", caseType: "RSA", cnr: "KAHC020000022024",
      registrationDate: "2024-01-12", decisionDate: "2024-05-31", disposal: "DISMISSED", judges: ["C.M. POONACHA"], benchStrength: 1,
      petitioner: "SMT LAKSHMAVVA W/O NAGAPPA DOLLIN ALIAS KARIGAR", respondent: "SMT.DEVAKKA W/O HANAMANTAPA MALLUR",
      externalId: "29_3/karhcdharwad/KAHC020000022024_1_2024-05-31",
    });
    expect(pdfKey).toBe("data/pdf/year=2024/court=29_3/bench=karhcdharwad/KAHC020000022024_1_2024-05-31.pdf");
    const k = hcFixture("29_3__karhckalaburagi__KAHC030000012020_1_2024-10-25.json");
    expect(parseHcMetadata(k.json, { key: k.key }).draft).toMatchObject({ benchId: "kar-kalaburagi", neutralCitation: "2024:KHC-K:7904", registrationDate: "2020-01-29" });
    const b = hcFixture("29_3__karnataka_bng_old__KAHC010000012024_1_2024-10-16.json");
    expect(parseHcMetadata(b.json, { key: b.key }).draft).toMatchObject({ benchId: "kar-bengaluru", neutralCitation: "2024:KHC:41936", caseNumber: "WP/98/2024" });
  });
  it("resolves Telangana and Andhra Pradesh without inventing neutral citations", () => {
    const t = hcFixture("36_29__taphc__HBHC010000032024_1_2024-08-13.json");
    expect(parseHcMetadata(t.json, { key: t.key }).draft).toMatchObject({ courtId: "hc-telangana", benchId: "ts-hyderabad", neutralCitation: undefined, caseNumber: "CRP/1/2024", judges: ["P.SREE SUDHA"] });
    const a = hcFixture("28_2__aphc__APHC010000012018_1_2024-07-01.json");
    expect(parseHcMetadata(a.json, { key: a.key }).draft).toMatchObject({ courtId: "hc-andhra", benchId: "ap-amaravati", disposal: "WITHDRAWN", decisionDate: "2024-07-01" });
  });
  it("splits division benches and keeps roles (Chief Justice, Lok Adalat) out of the judge list", () => {
    const db2 = hcFixture("36_29__taphc__HBHC010001492007_1_2024-11-14.json");
    const all = fs.readdirSync(path.join(FX, "india-hc")).filter((f) => f.endsWith(".json")).map((f) => ({ f, ...hcFixture(f) }));
    const parsed = all.map((x) => ({ f: x.f, d: parseHcMetadata(x.json, { key: x.key }).draft }));
    const cj = parsed.find((p) => p.d.coramRoles?.includes("CHIEF JUSTICE"))!;
    expect(cj.d.judges).toEqual(["K. V. ARAVIND"]);
    expect(cj.d.benchStrength).toBe(2);
    const lok = parsed.find((p) => p.d.coramRoles?.some((r) => /LOK ADALATH/.test(r)))!;
    expect(lok.d.judges).toEqual([]);
    expect(lok.d.benchStrength).toBeUndefined();
    const two = parsed.filter((p) => p.d.judges.length === 2);
    expect(two.length).toBeGreaterThanOrEqual(3);
    expect(parseHcMetadata(db2.json, { key: db2.key }).draft.courtId).toBe("hc-telangana");
  });
  it("never maps an unknown court code or bench folder to the nearest one", () => {
    const d = hcFixture("29_3__karhcdharwad__KAHC020000022024_1_2024-05-31.json");
    const unknown = parseHcMetadata({ ...d.json, court_code: "99~9" }, { key: d.key.replace("court=29_3", "court=99_9") });
    expect(unknown.court).toBeNull();
    expect(unknown.draft).toMatchObject({ courtId: null, unresolvedCourt: "99~9", benchId: undefined, neutralCitation: undefined });
    const mismatch = parseHcMetadata({ ...d.json, court_code: "36~29" }, { key: d.key });
    expect(mismatch.draft.courtId).toBeNull();
    expect(mismatch.draft.issues?.[0]).toMatch(/disagrees/);
    const bench = parseHcMetadata(d.json, { key: d.key.replace("bench=karhcdharwad", "bench=karhcnewbench") });
    expect(bench.draft).toMatchObject({ courtId: "hc-karnataka", benchId: undefined, unresolvedBench: "karhcnewbench" });
  });
  it("accepts only the registry prefix when finding HC neutral citations", () => {
    expect(findHcNeutral("2024:KHC-D:7336 RSA No. 1", ["KHC"])).toBe("2024:KHC-D:7336");
    expect(findHcNeutral("relying on 2023:KHC:100, see", ["TSHC"])).toBeUndefined();
    expect(findHcNeutral("2025:TSHC:0412 W.P.", ["TSHC"])).toBe("2025:TSHC:412");
  });
  it("matches the dataset bench folders recorded in the court registry", () => {
    const benches = (id: string) => HIGH_COURTS.find((c) => c.id === id)!.benches.map((b) => b.datasetBench);
    expect(benches("hc-karnataka")).toEqual(["karnataka_bng_old", "karhcdharwad", "karhckalaburagi"]);
    expect(benches("hc-telangana")).toEqual(["taphc"]);
    expect(benches("hc-andhra")).toEqual(["aphc"]);
    expect(hcPdfKey("metadata/json/year=2024/court=28_2/bench=aphc/X_1_2024-01-01.json")).toBe("data/pdf/year=2024/court=28_2/bench=aphc/X_1_2024-01-01.pdf");
  });
});

describe("parse utilities", () => {
  it("parses dates strictly and normalizes neutral citations", () => {
    expect(isoDate("25-09-2024")).toBe("2024-09-25");
    expect(isoDate("1-7-2024")).toBe("2024-07-01");
    expect(isoDate("31-02-2024")).toBeUndefined();
    expect(isoDate("September 2024")).toBeUndefined();
    expect(normalizeNeutral("2024INSC735")).toBe("2024 INSC 735");
    expect(normalizeNeutral("2024 insc 0735")).toBe("2024 INSC 735");
    expect(normalizeNeutral("AIR 1973 SC 1461")).toBeUndefined();
    expect(splitParties("A Vs B")).toEqual({ petitioner: "A", respondent: "B" });
    expect(splitParties("In re: Something")).toEqual({});
  });
  it("parses an S3 ListObjectsV2 page (live fixture)", () => {
    const page = parseListObjectsV2(fs.readFileSync(path.join(FX, "india-hc/list-2024-29_3-dharwad.xml"), "utf8"));
    expect(page.truncated).toBe(true);
    expect(page.nextToken).toBeTruthy();
    expect(page.objects).toHaveLength(3);
    expect(page.objects[0].key).toMatch(/^metadata\/json\/year=2024\/court=29_3\/bench=karhcdharwad\/KAHC02/);
    expect(page.objects[0].etag).not.toContain('"');
    expect(() => parseListObjectsV2("<Error><Code>AccessDenied</Code></Error>")).toThrow(/AccessDenied/);
  });
  it("chooses years deterministically", () => {
    expect(yearsFor({ lastYears: 2 }, new Date("2026-09-28T00:00:00Z"))).toEqual([2026, 2025]);
    expect(yearsFor({ lastYears: 5, fromYear: 2024 }, new Date("2026-09-28T00:00:00Z"))).toEqual([2026, 2025, 2024]);
    expect(yearsFor({ years: [2019, 2024, 2019], lastYears: 2 }, new Date())).toEqual([2024, 2019]);
    expect(decodeCursor("not json")).toEqual({ v: 1, prefixes: {} });
  });
});

// ---------------------------------------------------------------------------
// Adapters end to end (fixture network)
// ---------------------------------------------------------------------------
describe("sci-open-data adapter", () => {
  it("ingests metadata + PDF into a judgment and a searchable intel document, checkpoints, then skips unchanged records", async () => {
    const log: { url: string; method: string; headers: Record<string, string> }[] = [];
    const keys = ["metadata/json/year=2024/2024_10_108_125.json", "metadata/json/year=2024/2024_10_1313_1343.json"];
    let pdfFetches = 0;
    const fetchImpl = router([
      [/\/\?list-type=2&prefix=metadata%2Fjson%2Fyear%3D2024%2F/, (u) => {
        const after = u.searchParams.get("start-after");
        return listXml("metadata/json/year=2024/", keys.filter((k) => !after || k > after).map((key) => ({ key, etag: `etag-${key.length}` })));
      }],
      [/\/metadata\/json\/year=2024\/2024_10_108_125\.json$/, () => json(SC1)],
      [/\/metadata\/json\/year=2024\/2024_10_1313_1343\.json$/, () => json(SC2)],
      [/\/data\/pdf\/year=2024\/english\/2024_10_108_125_EN\.pdf$/, () => { pdfFetches++; return pdf(); }],
      // 2024_10_1313_1343_EN.pdf is missing → metadata-only record with an issue
    ], log);
    const p = providersWith(fetchImpl);
    const source = createSource({ adapter: "sci-open-data", name: "SC test", config: { years: [2024], maxPerPrefix: 1, concurrency: 2 }, schedule: { every: "manual" } });

    // Run 1: quota of one record per prefix → one judgment, checkpoint after the first key.
    const r1 = await runSource(source, { providers: p, embed: false });
    expect(r1.errors).toEqual([]);
    expect(runFailed(r1).failed).toBe(false);
    expect(r1.added).toBe(1);
    const cursor1 = decodeCursor(r1.nextCursor);
    expect(cursor1.prefixes["metadata/json/year=2024/"]).toMatchObject({ after: keys[0] });
    expect(cursor1.prefixes["metadata/json/year=2024/"].complete).toBeFalsy();

    const j = findJudgment("sci-open-data", "2024_10_108_125")!;
    expect(j).toMatchObject({ courtId: "sci", neutralCitation: "2024 INSC 735", textMethod: "pdfjs", sourceEtag: `etag-${keys[0].length}` });
    expect(j.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(j.pdfBlobId).toBe(`ipdf_${j.sha256}`);
    expect(getOriginalFile(j.pdfBlobId!)!.bytes.byteLength).toBe(PDF.byteLength);
    expect(j.textChars).toBeGreaterThan(500);
    expect(j.pages).toBeGreaterThan(0);
    const doc = intelDocuments().get(j.intelDocId!)!;
    expect(doc).toMatchObject({ kind: "opinion", adapter: "sci-open-data", courtId: "sci", court: "Supreme Court of India", citation: "2024 INSC 735", jurisdiction: "IN", externalId: "sci-open-data:2024_10_108_125" });
    expect(doc.dates.decided).toBe("2024-09-25");
    expect(getDocumentText(doc.id)).toContain("Neutral citation: 2024 INSC 735");
    expect(listChunks(doc.id).length).toBeGreaterThan(1);
    expect(log.every((l) => l.url.startsWith("https://indian-supreme-court-judgments.s3.amazonaws.com/"))).toBe(true);

    // Run 2 resumes after the checkpoint: the second record, whose PDF is absent (stored with an issue, never another PDF).
    const r2 = await runSource({ ...source, cursor: r1.nextCursor }, { providers: p, embed: false });
    expect(r2.added).toBe(1);
    const j2 = findJudgment("sci-open-data", "2024_10_1313_1343")!;
    expect(j2).toMatchObject({ textMethod: "none", textChars: 0, pdfBlobId: undefined });
    expect(j2.issues).toContain("English PDF not present in the dataset");
    expect(intelDocuments().get(j2.intelDocId!)!.flags.map((f) => f.kind)).toContain("needs_review");
    const c2 = decodeCursor(r2.nextCursor).prefixes["metadata/json/year=2024/"];
    expect(c2.complete).toBe(true);

    // Run 3 on a complete prefix: incremental pass; same ETags → skipped with no metadata or PDF download.
    const before = log.length;
    const r3 = await runSource({ ...source, cursor: r2.nextCursor, config: { ...source.config, maxPerPrefix: 50 } }, { providers: p, embed: false });
    expect(r3).toMatchObject({ added: 0, updated: 0 });
    expect(r3.skipped).toBe(2);
    expect(pdfFetches).toBe(1);
    expect(log.slice(before).every((l) => l.url.includes("list-type=2"))).toBe(true);
  });

  it("reports not_configured without any request when the network is off", async () => {
    let calls = 0;
    const base = createProviders({ cache: memoryHttpCache(), offline: true, sleep: async () => {} });
    const p = { ...base, india: createIndiaProviders({ fetchImpl: (async () => { calls++; return new Response(""); }) as typeof fetch, offline: true }) } as IntelProviders;
    const source = createSource({ adapter: "sci-open-data", name: "SC offline", config: {}, schedule: { every: "manual" } });
    const r = await runSource(source, { providers: p, embed: false });
    expect(r.errors[0]).toMatchObject({ code: "not_configured" });
    expect(runFailed(r).failed).toBe(false);
    expect(calls).toBe(0);
  });
});

describe("hc-open-data adapter", () => {
  it("discovers bench folders, retries transient failures, stores unknown benches unresolved and links PDFs", async () => {
    const dharwad = hcFixture("29_3__karhcdharwad__KAHC020000022024_1_2024-05-31.json");
    const newBenchKey = "metadata/json/year=2024/court=29_3/bench=karhcnewbench/KAHC990000012024_1_2024-02-02.json";
    let pdf503 = 0;
    const fetchImpl = router([
      [/list-type=2&prefix=metadata%2Fjson%2Fyear%3D2024%2Fcourt%3D29_3%2F&delimiter=%2F/, () => listXml("metadata/json/year=2024/court=29_3/", [], { prefixes: ["metadata/json/year=2024/court=29_3/bench=karhcdharwad/", "metadata/json/year=2024/court=29_3/bench=karhcnewbench/"] })],
      [/list-type=2&prefix=metadata%2Fjson%2Fyear%3D2024%2Fcourt%3D29_3%2Fbench%3Dkarhcdharwad%2F/, () => listXml("…", [{ key: dharwad.key, etag: "d1" }])],
      [/list-type=2&prefix=metadata%2Fjson%2Fyear%3D2024%2Fcourt%3D29_3%2Fbench%3Dkarhcnewbench%2F/, () => listXml("…", [{ key: newBenchKey, etag: "n1" }])],
      [/KAHC020000022024_1_2024-05-31\.json$/, () => json(dharwad.json)],
      [/KAHC990000012024_1_2024-02-02\.json$/, () => json(dharwad.json)],
      [/data\/pdf\/year=2024\/court=29_3\/bench=karhcdharwad\/KAHC020000022024_1_2024-05-31\.pdf$/, () => (pdf503++ < 1 ? new Response("SlowDown", { status: 503 }) : pdf())],
    ]);
    const p = providersWith(fetchImpl);
    const source = createSource({ adapter: "hc-open-data", name: "HC test", config: { courts: ["hc-karnataka"], years: [2024] }, schedule: { every: "manual" } });
    const r = await runSource(source, { providers: p, embed: false });
    expect(r.errors).toEqual([]);
    expect(r.added).toBe(2);
    expect(pdf503).toBe(2); // one 503, then the retry succeeded
    expect(r.notes?.some((n) => /karhcnewbench/.test(n))).toBe(true);

    const j = findJudgment("hc-open-data", "29_3/karhcdharwad/KAHC020000022024_1_2024-05-31")!;
    expect(j).toMatchObject({ courtId: "hc-karnataka", benchId: "kar-dharwad", neutralCitation: "2024:KHC-D:7336", cnr: "KAHC020000022024", textMethod: "pdfjs" });
    expect(intelDocuments().get(j.intelDocId!)).toMatchObject({ court: "High Court of Karnataka", jurisdiction: "IN-KA", docketNumber: "RSA/100004/2024" });
    const unresolvedBench = findJudgment("hc-open-data", "29_3/karhcnewbench/KAHC990000012024_1_2024-02-02")!;
    expect(unresolvedBench).toMatchObject({ courtId: "hc-karnataka", benchId: undefined, unresolvedBench: "karhcnewbench" });
    expect(listJudgments({ courtIds: ["hc-karnataka"], from: "2024-01-01" }).total).toBeGreaterThanOrEqual(2);
  });

  it("rejects an unknown registry court id in the configuration", () => {
    const a = getAdapter("hc-open-data")!;
    expect(a.configSchema.safeParse({ courts: ["hc-nowhere"] }).success).toBe(false);
    expect(a.configSchema.safeParse({ courts: ["hc-telangana", "28_2"] }).success).toBe(true);
    expect(a.defaults.courts).toEqual(["29_3", "36_29", "28_2"]);
  });
});

describe("indian-kanoon", () => {
  it("is not_configured without a token and makes no request", async () => {
    let calls = 0;
    const kanoon = createIndianKanoon({ fetchImpl: (async () => { calls++; return json({}); }) as typeof fetch });
    expect(kanoon.status()).toMatchObject({ state: "not_configured", envVar: "INDIAN_KANOON_API_TOKEN" });
    await expect(kanoon.search({ formInput: "bail" })).rejects.toMatchObject({ code: "not_configured" });
    const p = providersWith((async () => { calls++; return json({}); }) as typeof fetch);
    const source = createSource({ adapter: "indian-kanoon", name: "IK none", config: { queries: ["bail"] }, schedule: { every: "manual" } });
    const r = await runSource(source, { providers: p, embed: false });
    expect(r.errors[0]).toMatchObject({ code: "not_configured" });
    expect(runFailed(r).failed).toBe(false);
    expect(calls).toBe(0);
  });

  it("searches with the documented POST + Token header, fetches full text and never resolves the pre-2019 Andhra HC", async () => {
    const log: { url: string; method: string; headers: Record<string, string> }[] = [];
    const fetchImpl = router([
      [/\/search\/\?/, () => json(readJson("india-kanoon/search.shape.json"))],
      [/\/doc\/900000001\//, () => json(readJson("india-kanoon/doc-900000001.shape.json"))],
      [/\/doc\/900000002\//, () => json({ errmsg: "document not found" })],
    ], log);
    const p = providersWith(fetchImpl, { INDIAN_KANOON_API_TOKEN: "tok_test" });
    const source = createSource({ adapter: "indian-kanoon", name: "IK test", config: { queries: ["anticipatory bail"], sinceDays: 400 }, schedule: { every: "manual" } });
    const r = await runSource(source, { providers: p, embed: false, now: new Date("2026-09-28T00:00:00Z") });
    expect(r.added).toBe(2);
    expect(r.errors.map((e) => e.code)).toEqual(["parse"]); // errmsg for doc 900000002 → recorded, snippet kept
    const search = log.find((l) => l.url.includes("/search/"))!;
    expect(search.method).toBe("POST");
    expect(search.headers.authorization).toBe("Token tok_test");
    expect(new URL(search.url).searchParams.get("formInput")).toBe("anticipatory bail doctypes: supremecourt,karnataka,andhra fromdate: 24-8-2025");
    const kar = findJudgment("indian-kanoon", "900000001")!;
    expect(kar).toMatchObject({ courtId: "hc-karnataka", decisionDate: "2025-03-12", textMethod: "provider", pdfUrl: "https://indiankanoon.org/doc/900000001/" });
    expect(getDocumentText(kar.intelDocId!)).toContain("Bharatiya Nagarik Suraksha Sanhita");
    const old = findJudgment("indian-kanoon", "900000002")!;
    expect(old).toMatchObject({ courtId: null, unresolvedCourt: "indian-kanoon:Andhra HC (Pre-Telangana)" });
    expect(old.issues).toContain("Search snippet only; full text not fetched");
  });

  it("maps docsources exactly and composes documented filters", () => {
    expect(courtForDocsource("Supreme Court of India", "1973-04-24").court?.id).toBe("sci");
    expect(courtForDocsource("Andhra Pradesh High Court", "2018-12-31").court).toBeNull();
    expect(courtForDocsource("Andhra Pradesh High Court", "2020-02-01").court?.id).toBe("hc-andhra");
    expect(courtForDocsource("Karnataka HC", "2020-01-01")).toMatchObject({ court: null, unresolved: "indian-kanoon:Karnataka HC" });
    expect(ikQuery("bail", { toISO: "2024-10-01" })).toBe("bail todate: 1-10-2024");
    expect(ikDocToJudgment({ tid: 1, title: "A vs B on 1 January, 2020", doc: "<p>x</p>", publishdate: "2020-01-01", docsource: "Karnataka High Court" }).draft).toMatchObject({ petitioner: "A", respondent: "B", courtId: "hc-karnataka" });
  });
});

describe("india-code", () => {
  const item = readJson<DspaceItem>("india-code/item-bns-2023.json");
  const sections = readJson<unknown>("india-code/sections-bns-2023.json");
  const ka = readJson<unknown>("india-code/acts-karnataka-page0.json");

  it("parses an Act item and its sections (live DSpace fixtures)", () => {
    expect(parseActItem(item)).toMatchObject({ externalId: "AC_CEN_5_23_00048_2023-45_1719292564123", title: "The Bharatiya Nyaya Sanhita, 2023", actNumber: "45", year: 2023, jurisdiction: "central", state: undefined, enactedOn: "2023-12-25", inForceFrom: "2024-07-01", handle: "123456789/496548", ministry: "Ministry of Home Affairs", repealed: false, url: "https://indiacode.gov.in/handle/123456789/496548" });
    const page = parseSearchPage(sections);
    const s = page.items.map((i) => parseSectionItem(i)!);
    expect(s.map((x) => x.number)).toEqual(["33", "34", "146"]);
    expect(s[0]).toMatchObject({ heading: "Act causing slight harm.", order: 33, sectionId: "90398" });
    expect(s[0].text).toMatch(/^Nothing is an offence by reason that it causes/);
    expect(s[0].text).not.toMatch(/<|span/);
    const kaActs = parseSearchPage(ka).items.map((i) => parseActItem(i));
    expect(kaActs[0]).toMatchObject({ jurisdiction: "state", state: "KA", year: 2026, actNumber: "26" });
    expect(kaActs[0].regionalTitle).toMatch(/ಕರ್ನಾಟಕ/);
    expect(() => parseActItem(page.items[0])).toThrow(/not an ACT/);
  });

  it("ingests Acts with sections, attaching sections only by act id", async () => {
    const foreign = JSON.parse(JSON.stringify(sections)) as { _embedded: { searchResult: { _embedded: { objects: { _embedded: { indexableObject: DspaceItem } }[] } } } };
    const stray = JSON.parse(JSON.stringify(foreign._embedded.searchResult._embedded.objects[0]));
    stray._embedded.indexableObject.metadata["dc.identifier.act_id"][0].value = "AC_OTHER";
    stray._embedded.indexableObject.metadata["dc.identifier.section_number"][0].value = "999";
    foreign._embedded.searchResult._embedded.objects.push(stray);
    const empty = { _embedded: { searchResult: { _embedded: { objects: [] }, page: { number: 0, size: 20, totalPages: 0, totalElements: 0 } } } };
    const fetchImpl = router([
      [/discover\/search\/objects\?query=dc\.title%3A%22The\+Bharatiya\+Nyaya\+Sanhita%2C\+2023%22/, () => json({ _embedded: { searchResult: { _embedded: { objects: [{ _embedded: { indexableObject: item } }] }, page: { number: 0, size: 10, totalPages: 1, totalElements: 1 } } } })],
      [/f\.identifier_collection=SECTION/, () => json(foreign)],
      [/query=dc\.identifier\.state_name%3A%22Karnataka%22/, () => json(ka)],
      [/discover\/search\/objects/, () => json(empty)],
    ]);
    const p = providersWith(fetchImpl);
    const source = createSource({ adapter: "india-code", name: "India Code test", config: { centralActs: ["The Bharatiya Nyaya Sanhita, 2023", "The Nonexistent Act, 1999"], states: ["KA"], fetchSections: true }, schedule: { every: "manual" } });
    const r = await runSource(source, { providers: p, embed: false });
    expect(r.errors).toEqual([]);
    expect(r.added).toBe(3); // BNS + two Karnataka Acts
    expect(r.notes?.some((n) => /Nonexistent Act/.test(n))).toBe(true);
    const bns = indiaEnactments().findOne((e) => e.actId === "AC_CEN_5_23_00048_2023-45_1719292564123")!;
    expect(bns.sections).toBe(3);
    expect(getSections(bns.id).map((s) => s.number)).toEqual(["33", "34", "146"]);
    expect(getSection(bns.id, "999")).toBeNull();
    expect(getSection(bns.id, "34")?.text).toMatch(/private defence/);
    const doc = intelDocuments().get(bns.intelDocId!)!;
    expect(doc).toMatchObject({ kind: "statute", jurisdiction: "IN", citation: "Act 45 of 2023" });
    expect(getDocumentText(doc.id)).toContain("Section 33. Act causing slight harm.");
    expect(getEnactment(bns.id)?.inForceFrom).toBe("2024-07-01");
    // A second run with unchanged lastModified skips every Act.
    const r2 = await runSource({ ...source, cursor: r.nextCursor }, { providers: p, embed: false });
    expect(r2.added).toBe(0);
    expect(r2.skipped).toBeGreaterThanOrEqual(3);
  });

  it("restricts egress to India Code hosts", () => {
    const c = createIndiaCode();
    expect(c.jurisdictionQuery("TS")).toBe('dc.identifier.state_name:"Telangana"');
    expect(c.jurisdictionQuery("central")).toBe("dc.identifier.state_name:CENTRAL");
  });
});

describe("licensed connectors (SCC Online, Manupatra)", () => {
  it("fail closed: licence first, then an export folder or licensed API; vendor websites are refused", () => {
    const base = { licenseAcknowledged: false, mode: "export" as const, maxFiles: 10, maxFileMb: 5 };
    expect(licensedStatus("scc-online", base, {}).state).toBe("license_required");
    expect(licensedStatus("scc-online", { ...base, licenseAcknowledged: true }, {}).state).toBe("not_configured");
    expect(licensedStatus("manupatra", { ...base, licenseAcknowledged: true, mode: "api", apiEndpoint: "https://www.manupatrafast.com/search" }, { MANUPATRA_API_TOKEN: "x" })).toMatchObject({ state: "not_configured", reason: expect.stringMatching(/not an API/) });
    expect(licensedStatus("manupatra", { ...base, licenseAcknowledged: true, mode: "api", apiEndpoint: "http://gateway.firm.example/api" }, { MANUPATRA_API_TOKEN: "x" }).state).toBe("not_configured");
    expect(licensedStatus("manupatra", { ...base, licenseAcknowledged: true, mode: "api", apiEndpoint: "https://gateway.firm.example/manupatra" }, {}).state).toBe("not_configured");
    expect(licensedStatus("manupatra", { ...base, licenseAcknowledged: true, mode: "api", apiEndpoint: "https://gateway.firm.example/manupatra" }, { MANUPATRA_API_TOKEN: "x" }).state).toBe("ready");
  });

  it("the default source does nothing, and an acknowledged export folder is ingested with exact court resolution", async () => {
    const def = createSource({ adapter: "scc-online", name: "SCC default", config: {}, schedule: { every: "manual" } });
    const r0 = await runSource(def, { providers: providersWith(router([])), embed: false });
    expect(r0.errors[0]).toMatchObject({ code: "not_configured" });
    expect(r0.errors[0].message).toMatch(/license_required/);
    expect(r0.added).toBe(0);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scc-export-"));
    fs.writeFileSync(path.join(dir, "export.json"), JSON.stringify([
      { id: "A1", title: "Firm Client vs State of Karnataka", court: "High Court of Karnataka", date: "14-03-2025", neutralCitation: "2025:KHC:1234", judges: ["X J"], text: "Held: the petition is allowed." },
      { id: "A2", title: "Other vs Other", court: "Karnataka HC Bench", date: "2025-03-15", text: "Dismissed." },
    ]));
    fs.writeFileSync(path.join(dir, "note.txt"), "Plain text judgment export body.");
    const src = createSource({ adapter: "scc-online", name: "SCC export", config: { licenseAcknowledged: true, exportDir: dir }, schedule: { every: "manual" } });
    const r = await runSource(src, { providers: providersWith(router([])), embed: false });
    expect(r.errors).toEqual([]);
    expect(r.added).toBe(3);
    expect(findJudgment("scc-online", "file:export.json#A1")).toMatchObject({ courtId: "hc-karnataka", neutralCitation: "2025:KHC:1234", decisionDate: "2025-03-14", license: expect.stringMatching(/firm licence/) });
    expect(findJudgment("scc-online", "file:export.json#A2")).toMatchObject({ courtId: null, unresolvedCourt: "export:Karnataka HC Bench" });
    const again = await runSource(src, { providers: providersWith(router([])), embed: false });
    expect(again).toMatchObject({ added: 0, skipped: 3 });
    expect(resolveExportCourt({ courtId: "hc-nowhere" })).toEqual({ courtId: null, unresolved: "export:hc-nowhere" });
    expect(exportRecordToJudgment("manupatra", { title: "T", html: "<p>a</p><p>b</p>" }, "x").text).toBe("a\nb");
  });
});

describe("eCourts (manual lookup only)", () => {
  it("builds a manual CNR lookup link and never claims automation", () => {
    expect(ecourtsCnrLink("kahc01 000001 2024")).toMatchObject({ cnr: "KAHC010000012024", valid: true, level: "high", automated: false, url: "https://hcservices.ecourts.gov.in/hcservices/main.php", court: { id: "hc-karnataka" } });
    expect(ecourtsCnrLink("KAHC01000001202")).toMatchObject({ valid: false, reason: "invalid_cnr" });
    expect(ecourtsCnrLink("KABG010012342023")).toMatchObject({ valid: true, level: "district", court: null });
  });
});

describe("registry and default sources", () => {
  it("registers the India adapters with valid defaults", () => {
    for (const id of ["sci-open-data", "hc-open-data", "indian-kanoon", "india-code", "scc-online", "manupatra"]) {
      const a = getAdapter(id)!;
      expect(a, id).toBeTruthy();
      expect(a.configSchema.safeParse(a.defaults).success, id).toBe(true);
    }
    expect(listAdapters().map((a) => a.id)).toEqual(expect.arrayContaining(["courtlistener-opinions", "ecfr"])); // US adapters still compile and register
  });
  it("replaces the US sources in the production catalog with the India sources, all disabled by default", () => {
    const ref = referenceSources(new Date("2026-09-28T00:00:00Z"));
    const adapters = ref.map((s) => s.adapter);
    expect(adapters).toEqual(expect.arrayContaining(["sci-open-data", "hc-open-data", "indian-kanoon", "india-code", "scc-online", "manupatra", "local-corpus", "web-list"]));
    for (const us of ["courtlistener-opinions", "courtlistener-dockets", "courtlistener-judges", "ecfr", "federal-register", "govinfo", "openfda-recalls", "jpml-mdls", "court-rules", "news"]) expect(adapters).not.toContain(us);
    expect(ref.some((s) => s.enabled)).toBe(false);
    expect(ref.find((s) => s.id === INDIA_SOURCE_IDS.hcOpenData)?.config).toMatchObject({ courts: ["29_3", "36_29", "28_2"], lastYears: 2 });
    expect(ref.find((s) => s.id === INDIA_SOURCE_IDS.sccOnline)?.config).toMatchObject({ licenseAcknowledged: false });
    // The demo catalog keeps the sample-corpus sources and adds the India sources.
    const demo = systemSources().map((s) => s.id);
    expect(demo).toEqual(expect.arrayContaining([...Object.values(SEED_SOURCE_IDS), ...Object.values(INDIA_SOURCE_IDS)]));
    const prev = process.env.LECLAUDE_INDIA_OPEN_DATA;
    process.env.LECLAUDE_INDIA_OPEN_DATA = "1";
    try { expect(indiaSources().filter((s) => s.enabled).map((s) => s.adapter).sort()).toEqual(["hc-open-data", "india-code", "sci-open-data"]); }
    finally { if (prev === undefined) delete process.env.LECLAUDE_INDIA_OPEN_DATA; else process.env.LECLAUDE_INDIA_OPEN_DATA = prev; }
  });
});

describe("text quality gate and retrieval surface", () => {
  it("rejects glyph garbage from fonts without a Unicode map, and accepts Indic-script text", async () => {
    const { textQuality } = await import("@/modules/india/sources/ingest");
    expect(textQuality("[Page 1]\n   \n !\"# !$%   %   \n [Page 2] &'( )*+").readable).toBe(false);
    expect(textQuality("[Page 1]\nIN THE HIGH COURT OF KARNATAKA AT BENGALURU DATED THIS THE 16TH DAY OF OCTOBER 2024").readable).toBe(true);
    expect(textQuality("ಕರ್ನಾಟಕ ಉಚ್ಚ ನ್ಯಾಯಾಲಯ ಬೆಂಗಳೂರು ದಿನಾಂಕ ಅಕ್ಟೋಬರ್ ತಿಂಗಳ ಹದಿನಾರನೇ ದಿನ ಎರಡು ಸಾವಿರದ ಇಪ್ಪತ್ತನಾಲ್ಕು").readable).toBe(true);
  });
  it("maps search hits back to judgment and enactment records and honours court filters", async () => {
    const { searchIndianAuthorities, judgmentText, indiaConnectorStatuses } = await import("@/modules/india/sources");
    const hits = await searchIndianAuthorities("State of Bihar", { kinds: ["judgment"] });
    expect(hits.some((h) => h.judgment?.externalId === "2024_10_108_125")).toBe(true);
    expect((await searchIndianAuthorities("State of Bihar", { kinds: ["judgment"], courtIds: ["hc-karnataka"] })).some((h) => h.judgment?.courtId === "sci")).toBe(false);
    const acts = await searchIndianAuthorities("private defence", { kinds: ["enactment"] });
    expect(acts[0]?.enactment?.title).toBe("The Bharatiya Nyaya Sanhita, 2023");
    expect(judgmentText(findJudgment("sci-open-data", "2024_10_108_125")!.id)).toContain("2024 INSC 735");
    const st = indiaConnectorStatuses({});
    expect(st.find((s) => s.source === "indian-kanoon")?.state).toBe("not_configured");
    expect(st.find((s) => s.source === "scc-online")?.state).toBe("license_required");
    expect(st.find((s) => s.source === "ecourts")?.state).toBe("disabled");
  });
});
