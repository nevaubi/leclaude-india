import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { readTar, TarError } from "@/modules/india/corpus/tar";
import { CORPUS_COLUMNS, jsonKeyFor, rowFromEntry, upsertSql } from "@/modules/india/corpus/rows";
import { FOCUS_HC_CODES, unitPriority } from "@/modules/india/corpus/backfill";
import { indiaCapabilities, indiaResearchTools, INDIA_TOOLS } from "@/lib/ai/toolkit/india";
import { languageBySciCode } from "@/lib/india/languages";

/** Build a ustar archive (the format of the open-data metadata archives). */
function tar(files: { name: string; body: string }[]): Uint8Array {
  const blocks: Uint8Array[] = [];
  const enc = new TextEncoder();
  for (const f of files) {
    const data = enc.encode(f.body);
    const h = new Uint8Array(512);
    h.set(enc.encode(f.name).subarray(0, 100), 0);
    h.set(enc.encode("0000644\0"), 100);
    h.set(enc.encode("0000000\0"), 108);
    h.set(enc.encode("0000000\0"), 116);
    h.set(enc.encode(data.length.toString(8).padStart(11, "0") + "\0"), 124);
    h.set(enc.encode("00000000000\0"), 136);
    h[156] = "0".charCodeAt(0);
    h.set(enc.encode("ustar\0"), 257);
    h.set(enc.encode("00"), 263);
    for (let i = 148; i < 156; i++) h[i] = 32;
    let sum = 0;
    for (const b of h) sum += b;
    h.set(enc.encode(sum.toString(8).padStart(6, "0") + "\0 "), 148);
    blocks.push(h);
    const padded = new Uint8Array(Math.ceil(data.length / 512) * 512);
    padded.set(data);
    blocks.push(padded);
  }
  blocks.push(new Uint8Array(1024));
  const out = new Uint8Array(blocks.reduce((n, b) => n + b.length, 0));
  let off = 0;
  for (const b of blocks) { out.set(b, off); off += b.length; }
  return out;
}

const HC_RECORD = {
  court_code: "29~3",
  court_name: "High Court of Karnataka",
  raw_html: `<button type='button' role='link' class='btn btn-link p-0 text-start' id='link_937' aria-label="x pdf" class='noToken' href='#' onclick=javascript:open_pdf('937','','court/cnrorders/karhcdharwad/orders/KAHC020100052022_1_2024-08-07.pdf#page=&search=%20'); ><font size='3'>MFA.CROB/100138/2022 of SHRI. GAJANAN BHUJANG PATIL Vs THE SPECIAL LAND ACQUISITION OFFICER</button></font><br><strong>Judge : KRISHNA S.DIXIT,VIJAYKUMAR A.PATIL</strong><br> 2024:KHC-D:1234 IN THE HIGH COURT OF KARNATAKA DHARWAD BENCH DATED THIS THE 7TH DAY OF AUGUST, 2024<br><strong class='caseDetailsTD' ><span style='color:#212F3D'> CNR :</span><font color='green'> KAHC020100052022</font><span style='color:#212F3D' > | Date of registration :</span><font color='green'> 28-12-2022</font><span style='color:#212F3D' > | Decision Date :</span><font color='green'> 07-08-2024</font><span style='color:#212F3D' > | Disposal Nature :</span><font color='green'> Partly Allowed</font><br><span style='opacity: 0.5;'>Court : High Court of Karnataka</span></strong>`,
};

describe("tar reader", () => {
  it("reads plain and gzipped ustar archives and validates checksums", () => {
    const a = tar([{ name: "A.json", body: "{\"a\":1}" }, { name: "B.json", body: "x".repeat(700) }]);
    for (const input of [a, new Uint8Array(gzipSync(a))]) {
      const e = readTar(input);
      expect(e.map((x) => x.name)).toEqual(["A.json", "B.json"]);
      expect(new TextDecoder().decode(e[0].data)).toBe("{\"a\":1}");
      expect(e[1].data.length).toBe(700);
    }
    const corrupt = a.slice();
    corrupt[10] ^= 0xff;
    expect(() => readTar(corrupt)).toThrow(TarError);
    expect(() => readTar(a.slice(0, 600))).toThrow(/Truncated/);
  });
});

describe("rows", () => {
  const unit = { id: "hc:u1", source: "hc-open-data" as const, year: 2024, courtCode: "29_3", benchCode: "karhcdharwad" };
  it("maps a High Court record to the registry court and bench, with CNR, dates, coram and neutral citation", () => {
    expect(jsonKeyFor(unit, "KAHC020100052022_1_2024-08-07.json")).toBe("metadata/json/year=2024/court=29_3/bench=karhcdharwad/KAHC020100052022_1_2024-08-07.json");
    const r = rowFromEntry(unit, "KAHC020100052022_1_2024-08-07.json", new TextEncoder().encode(JSON.stringify(HC_RECORD)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.row).toMatchObject({
      id: "hc:29_3/karhcdharwad/KAHC020100052022_1_2024-08-07",
      court_id: "hc-karnataka", bench_id: "kar-dharwad", court_code: "29_3", bench_code: "karhcdharwad",
      cnr: "KAHC020100052022", case_number: "MFA.CROB/100138/2022", decision_date: "2024-08-07", registration_date: "2022-12-28",
      disposal: "Partly Allowed", judges: ["KRISHNA S.DIXIT", "VIJAYKUMAR A.PATIL"], neutral_citation: "2024:KHC-D:1234", issues: null,
    });
    expect(r.row.record_sha256).toMatch(/^[0-9a-f]{64}$/);
  });
  it("keeps an unknown court unresolved instead of mapping it to a nearby court", () => {
    const r = rowFromEntry({ ...unit, courtCode: "99_9", benchCode: "x" }, "X_1_2024-01-01.json", new TextEncoder().encode(JSON.stringify({ ...HC_RECORD, court_code: "99~9" })));
    expect(r.ok && r.row.court_id).toBe(null);
    expect(r.ok && r.row.court_code).toBe("99_9");
    expect(r.ok && r.row.issues?.some((i) => /not in the court registry/.test(i))).toBe(true);
  });
  it("rejects malformed records with a reason", () => {
    expect(rowFromEntry(unit, "bad.json", new TextEncoder().encode("{oops"))).toMatchObject({ ok: false, reason: expect.stringMatching(/invalid JSON/) });
    expect(rowFromEntry(unit, "readme.txt", new Uint8Array())).toMatchObject({ ok: false });
  });
  it("upserts through one JSON parameter and skips unchanged records", () => {
    const sql = upsertSql();
    expect(sql).toContain("jsonb_to_recordset($1::jsonb)");
    expect(sql).toContain("record_sha256 IS DISTINCT FROM EXCLUDED.record_sha256");
    for (const [c] of CORPUS_COLUMNS) expect(sql).toContain(c);
  });
});

describe("queue order", () => {
  it("runs the Supreme Court first, then the focus High Courts newest year first, then the other High Courts", () => {
    const sc2024 = unitPriority({ kind: "archive", source: "sci-open-data", year: 2024 });
    const sc1950 = unitPriority({ kind: "archive", source: "sci-open-data", year: 1950 });
    const discoverHc2024 = unitPriority({ kind: "discover", source: "hc-open-data", year: 2024 });
    const kar2024 = unitPriority({ kind: "archive", source: "hc-open-data", year: 2024, courtCode: FOCUS_HC_CODES[0] });
    const ap2024 = unitPriority({ kind: "archive", source: "hc-open-data", year: 2024, courtCode: "28_2" });
    const kar2023 = unitPriority({ kind: "archive", source: "hc-open-data", year: 2023, courtCode: "29_3" });
    const bom2024 = unitPriority({ kind: "archive", source: "hc-open-data", year: 2024, courtCode: "27_1" });
    expect(unitPriority({ kind: "discover", source: "sci-open-data", year: 0 })).toBeLessThan(sc2024);
    expect(sc2024).toBeLessThan(sc1950);
    expect(sc1950).toBeLessThan(discoverHc2024);
    expect(discoverHc2024).toBeLessThan(kar2024);
    expect(kar2024).toBeLessThan(ap2024);
    expect(ap2024).toBeLessThan(kar2023);
    expect(kar2023).toBeLessThan(bom2024);
  });
});

describe("tools and languages", () => {
  it("exposes the judgment index tool only when the corpus database is configured", () => {
    expect(indiaCapabilities({}).corpus).toBe(false);
    expect(indiaCapabilities({ DATABASE_URL: "postgres://u:p@h/db" }).corpus).toBe(true);
    expect(indiaResearchTools({ indianKanoon: false, corpus: false }).map((t) => t.name)).not.toContain("search_judgment_index");
    expect(indiaResearchTools({ indianKanoon: false, corpus: true }).map((t) => t.name)).toContain("search_judgment_index");
    expect(INDIA_TOOLS.map((t) => t.name)).toContain("search_judgment_index");
  });
  it("registers the court-published translation languages seen in the Supreme Court dataset", () => {
    expect(languageBySciCode("NEP")?.code).toBe("ne");
    expect(languageBySciCode("KOK")?.code).toBe("kok");
    expect(languageBySciCode("SAN")?.code).toBe("sa");
  });
});
