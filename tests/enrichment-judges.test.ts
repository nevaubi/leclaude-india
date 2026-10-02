import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RemoteStore, Row, SqlQuery } from "@/lib/db/remote";
import { coramMatches, judgmentsForJudge } from "@/modules/judges/directory";
import { runEnrichment, type EnrichDeps } from "@/modules/judges/enrich";
import { cleanJudgeName, displayJudgeName, isJudgeId, judgeId, judgeInitials, normalizeJudgeName } from "@/modules/judges/names";
import { acceptVerdict, uncheckedVerdict } from "@/modules/judges/vision";
import type { StoredMedia } from "@/modules/media/store";

class FakeStore implements RemoteStore {
  calls: SqlQuery[] = [];
  constructor(private readonly reply: (q: SqlQuery) => Row[] = () => []) {}
  async query(q: SqlQuery): Promise<Row[]> { this.calls.push(q); return this.reply(q); }
  async transaction(qs: SqlQuery[]): Promise<Row[][]> { return Promise.all(qs.map((q) => this.query(q))); }
  find(re: RegExp) { return this.calls.filter((c) => re.test(c.query)); }
}

const fx = (name: string) => readFileSync(join(__dirname, "fixtures/enrichment", name), "utf8");

describe("judge names", () => {
  it("removes honorifics, titles and a trailing J. without touching the name itself", () => {
    expect(cleanJudgeName("HONOURABLE THE CHIEF JUSTICE  APARESH KUMAR SINGH")).toBe("APARESH KUMAR SINGH");
    expect(cleanJudgeName("Hon'ble Justice B.V. Nagarathna")).toBe("B.V. Nagarathna");
    expect(cleanJudgeName("Smt. BHARATI DANGRE, J.")).toBe("BHARATI DANGRE");
    expect(cleanJudgeName("RAJ D. WAKODE J.")).toBe("RAJ D. WAKODE");
    expect(cleanJudgeName("Dr. Justice Y. Lakshmana Rao")).toBe("Y. Lakshmana Rao");
    expect(cleanJudgeName("Sri. Justice Alapati Giridhar")).toBe("Alapati Giridhar");
    expect(cleanJudgeName("HON'BLE THE CHIEF JUSTICE MAHESH CHANDRA TRIPATHI")).toBe("MAHESH CHANDRA TRIPATHI");
  });

  it("normalizes punctuation and case so the record's printed coram compares equal", () => {
    expect(normalizeJudgeName("Hon'ble Justice B.V. Nagarathna")).toBe(normalizeJudgeName("B. V. NAGARATHNA"));
    expect(normalizeJudgeName("HONOURABLE SRI JUSTICE  K.LAKSHMAN")).toBe("K LAKSHMAN");
    expect(normalizeJudgeName("Justice Satish Chandra Sharma")).toBe("SATISH CHANDRA SHARMA");
  });

  it("never expands initials or treats different printings as the same judge", () => {
    expect(normalizeJudgeName("C.M. POONACHA")).not.toBe(normalizeJudgeName("Cheppudira Monappa Poonacha"));
    expect(normalizeJudgeName("S.G.PANDIT")).not.toBe(normalizeJudgeName("Shankar Ganapathi Pandit"));
  });

  it("builds stable ids, initials and display names", () => {
    expect(judgeId("sci", "B V NAGARATHNA")).toBe("sci--b-v-nagarathna");
    expect(isJudgeId("hc-andhra--ravi-nath-tilhari")).toBe(true);
    expect(isJudgeId("../../etc")).toBe(false);
    expect(judgeInitials("Justice Surya Kant")).toBe("SK");
    expect(judgeInitials("B.V. Nagarathna")).toBe("BN");
    expect(judgeInitials("K.LAKSHMAN")).toBe("KL");
    expect(displayJudgeName("K.LAKSHMAN")).toBe("K. Lakshman");
    expect(displayJudgeName("B.V. Nagarathna")).toBe("B.V. Nagarathna");
  });
});

describe("exact judge ↔ judgment matching", () => {
  const corpus: Record<string, Row[]> = {
    sci: [
      { id: "sc:1", title: "A v. B", decision_date: "2024-08-07", neutral_citation: "2024 INSC 1", case_number: null, judges: '{"B. V. NAGARATHNA","SATISH CHANDRA SHARMA"}', text_status: "full", pdf_url: null },
      { id: "sc:2", title: "C v. D", decision_date: "2023-01-01", neutral_citation: null, case_number: "CA 2/2023", judges: '{"B.V. NAGARATHNA"}', text_status: "none", pdf_url: null },
      { id: "sc:3", title: "E v. F", decision_date: "2022-01-01", neutral_citation: null, case_number: null, judges: '{"NAGARATHNA B V"}', text_status: "none", pdf_url: null },
    ],
    "hc-karnataka": [
      { id: "hc:x", title: "G v. H", decision_date: "2015-01-01", neutral_citation: null, case_number: null, judges: '{"B.V.NAGARATHNA"}', text_status: "none", pdf_url: null },
    ],
  };
  const store = new FakeStore((q) => {
    if (q.query.includes("to_regclass")) return [{ t: "corpus_judgments" }];
    if (q.query.includes("FROM corpus_judgments")) return corpus[String(q.params?.[0])] ?? [];
    return [];
  });

  it("counts only same-court records whose printed coram normalizes to the judge's name", async () => {
    const r = await judgmentsForJudge(store, "sci", "B V NAGARATHNA");
    expect(r).toMatchObject({ available: true, count: 2, capped: false });
    expect(r.recent.map((x) => x.id)).toEqual(["sc:1", "sc:2"]);
    const q = store.find(/FROM corpus_judgments/).at(-1)!;
    expect(q.query).toMatch(/court_id = \$1/);
    expect(q.params).toEqual(["sci", "%NAGARATHNA%"]);
  });

  it("does not bind a High Court record to a Supreme Court judge of the same name", async () => {
    const r = await judgmentsForJudge(store, "sci", "B V NAGARATHNA");
    expect(r.recent.some((x) => x.id.startsWith("hc:"))).toBe(false);
  });

  it("reports the corpus as unavailable instead of an empty match when its table is missing", async () => {
    const empty = new FakeStore((q) => (q.query.includes("to_regclass") ? [{ t: null }] : []));
    expect(await judgmentsForJudge(empty, "sci", "B V NAGARATHNA")).toEqual({ available: false, count: 0, capped: false, recent: [] });
  });

  it("links coram names only to judges of the record's own court", async () => {
    const s = new FakeStore((q) => {
      if (q.query.includes("FROM judges WHERE court_id = $1 AND name_normalized = ANY")) {
        expect(q.params?.[0]).toBe("sci");
        return String(q.params?.[1]).split("|").includes("B V NAGARATHNA") ? [{ id: "sci--b-v-nagarathna", name: "B.V. Nagarathna", name_normalized: "B V NAGARATHNA", photo_media_id: null, photo_source_url: null, photo_vision: null }] : [];
      }
      return [];
    });
    const r = await coramMatches("sci", ["B.V. NAGARATHNA", "SATISH CHANDRA SHARMA"], { store: s });
    expect(r.matches[0].judge?.id).toBe("sci--b-v-nagarathna");
    expect(r.matches[1].judge).toBeNull();
    const none = await coramMatches("not-a-court", ["X"], { store: s });
    expect(none.matches).toEqual([{ name: "X", judge: null }]);
  });
});

describe("vision verdicts", () => {
  const now = new Date("2026-10-01T00:00:00Z");
  it("keeps a portrait only when it is a single person and not a placeholder", () => {
    expect(acceptVerdict("portrait", { kind: "portrait", single_person: true, placeholder: false, reason: "A man in robes", alt: "Portrait" }, null, now).ok).toBe(true);
    expect(acceptVerdict("portrait", { kind: "portrait", single_person: false, placeholder: false, reason: "two people" }, null, now)).toMatchObject({ ok: false, reason: expect.stringMatching(/not a single-person/) });
    expect(acceptVerdict("portrait", { kind: "placeholder", single_person: false, placeholder: true, reason: "silhouette" }, null, now)).toMatchObject({ ok: false, reason: expect.stringMatching(/placeholder/) });
    expect(acceptVerdict("portrait", { kind: "logo", single_person: true, placeholder: false, reason: "logo" }, null, now).ok).toBe(false);
  });
  it("keeps an emblem or logo for court identity and rejects anything else", () => {
    expect(acceptVerdict("emblem", { kind: "emblem", single_person: false, placeholder: false, reason: "Lion Capital" }, null, now)).toMatchObject({ ok: true, kind: "emblem" });
    expect(acceptVerdict("emblem", { kind: "logo", single_person: false, placeholder: false, reason: "logo" }, null, now).ok).toBe(true);
    expect(acceptVerdict("emblem", { kind: "building", single_person: false, placeholder: false, reason: "court building" }, null, now).ok).toBe(false);
  });
  it("rejects malformed or missing model output", () => {
    expect(acceptVerdict("portrait", null, null, now).ok).toBe(false);
    expect(acceptVerdict("portrait", { kind: "selfie", single_person: true }, null, now)).toMatchObject({ ok: false, kind: "other" });
    expect(uncheckedVerdict("no model", now)).toMatchObject({ ok: false, kind: "unchecked" });
  });
});

describe("enrichment run", () => {
  function media(url: string): StoredMedia {
    const id = Buffer.from(url).toString("hex").padEnd(64, "0").slice(0, 64);
    return { id, url: `/api/media/${id}`, mime: "image/jpeg", size: 100, width: 300, height: 375, existed: false, dataUrl: `data:image/jpeg;base64,${url}` };
  }

  function deps(store: FakeStore, over: Partial<EnrichDeps> = {}): EnrichDeps {
    return {
      store,
      fetchPage: null,
      scrape: async (url, o) => {
        if (url.includes("sci.gov.in/chief-justice-judges")) return { markdown: fx("sci-chief-justice-judges.md"), links: [], json: null, logo: null };
        if (o.branding) return { markdown: "", links: [], json: null, logo: "https://tshc.gov.in/assets/logo.png" };
        throw new Error(`unexpected scrape ${url}`);
      },
      storeImage: async (url) => media(url),
      classify: async (dataUrl, expect) => ({ raw: expect === "emblem" ? { kind: "emblem", single_person: false, placeholder: false, reason: "seal" } : dataUrl.includes("2025110998") ? { kind: "placeholder", single_person: false, placeholder: true, reason: "silhouette" } : { kind: "portrait", single_person: true, placeholder: false, reason: "portrait", alt: "Portrait photograph" }, model: null }),
      now: () => new Date("2026-10-01T10:00:00Z"),
      deadlineMs: 60_000,
      ...over,
    };
  }

  it("upserts every roster judge with printed fields and keeps only accepted photographs", async () => {
    const store = new FakeStore((q) => (/SELECT count\(\*\)::int AS n FROM judges/.test(q.query) ? [{ n: "0" }] : []));
    const report = await runEnrichment({ target: "judges", courts: ["sci"] }, deps(store));
    const sci = report.judges[0];
    expect(sci).toMatchObject({ courtId: "sci", status: "ok", found: 5, upserted: 5, offRoster: 0 });
    expect(sci.photos).toMatchObject({ stored: 5, accepted: 4, rejected: 1, unchecked: 0, failed: 0 });
    const upserts = store.find(/INSERT INTO judges/);
    expect(upserts).toHaveLength(5);
    const vikram = upserts.find((u) => u.params?.[0] === "sci--vikram-nath")!;
    // Placeholder photo: no media id is linked.
    expect(vikram.params?.[10]).toBeNull();
    const cji = upserts.find((u) => u.params?.[0] === "sci--surya-kant")!;
    expect(cji.params?.slice(1, 9)).toEqual(["sci", "Surya Kant", "Justice Surya Kant", "SURYA KANT", "Chief Justice of India", "2019-05-24", "2027-02-09", null]);
    expect(typeof cji.params?.[10]).toBe("string");
    expect(report.skippedCourts).toEqual([]);
    expect(store.find(/INSERT INTO enrichment_state/)).toHaveLength(1);
  });

  it("does not link unchecked photos when no vision model is configured, and keeps any earlier photo", async () => {
    const store = new FakeStore((q) => (/SELECT count/.test(q.query) ? [{ n: "0" }] : []));
    const report = await runEnrichment({ target: "judges", courts: ["sci"] }, deps(store, { classify: async () => null }));
    expect(report.judges[0].photos).toMatchObject({ accepted: 0, unchecked: 5 });
    for (const u of store.find(/INSERT INTO judges/)) expect(u.params?.[16]).toBe(true); // keep the existing photo
    expect(store.find(/UPDATE media_assets SET vision/).every((u) => String(u.params?.[1]).includes('"unchecked"'))).toBe(true);
  });

  it("marks judges no longer listed off-roster only after a complete, plausible read", async () => {
    const plausible = new FakeStore((q) => (/SELECT count/.test(q.query) ? [{ n: "2" }] : /UPDATE judges SET status = 'off_roster'/.test(q.query) ? [{ id: "a" }, { id: "b" }] : []));
    expect((await runEnrichment({ target: "judges", courts: ["sci"] }, deps(plausible))).judges[0].offRoster).toBe(2);
    const suspicious = new FakeStore((q) => (/SELECT count/.test(q.query) ? [{ n: "30" }] : []));
    const r = await runEnrichment({ target: "judges", courts: ["sci"] }, deps(suspicious));
    expect(r.judges[0].offRoster).toBe(0);
    expect(suspicious.find(/off_roster/)).toHaveLength(0);
    expect(r.judges[0].notes.join(" ")).toMatch(/looks incomplete/);
  });

  it("reports a failed read without touching stored judges", async () => {
    const store = new FakeStore();
    const r = await runEnrichment({ target: "judges", courts: ["sci"] }, deps(store, { scrape: async () => { throw new Error("timeout"); } }));
    expect(r.judges[0]).toMatchObject({ status: "failed", error: "timeout", upserted: 0 });
    expect(store.find(/INSERT INTO judges|UPDATE judges/)).toHaveLength(0);
  });

  it("stores court emblems that pass the check and skips courts with no roster page", async () => {
    const store = new FakeStore();
    const r = await runEnrichment({ target: "all", courts: ["sci", "hc-telangana", "hc-sikkim"] }, deps(store, {
      scrape: async (url, o) => {
        if (o.branding) return { markdown: "", links: [], json: null, logo: "https://tshc.gov.in/assets/frontmodule/images/logo.png" };
        if (url.includes("sci.gov.in")) return { markdown: fx("sci-chief-justice-judges.md"), links: [], json: null, logo: null };
        return { markdown: fx("tshc-sitting-judges.md"), links: [], json: null, logo: null };
      },
    }));
    expect(r.courts.map((c) => [c.courtId, c.status, c.kind])).toEqual([["sci", "stored", "emblem"], ["hc-telangana", "stored", "emblem"]]);
    expect(r.courts[0].imageUrl).toMatch(/cdnbbsr\.s3waas\.gov\.in/);
    expect(r.skippedCourts).toEqual(expect.arrayContaining([{ courtId: "hc-sikkim", reason: "No official website recorded for this court" }, { courtId: "hc-sikkim", reason: "No verified official roster page registered yet" }]));
    expect(r.judges.map((j) => [j.courtId, j.found])).toEqual([["sci", 5], ["hc-telangana", 5]]);
    expect(store.find(/INSERT INTO court_assets/)).toHaveLength(2);
  });
});
