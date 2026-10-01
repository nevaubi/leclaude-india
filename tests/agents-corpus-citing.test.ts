/**
 * citing_references over the Postgres corpus: sc:/hc: ids and neutral citations resolve exactly, later judgments whose
 * text mentions the citation come back with passage and page, labelled "mentions (text match)" (never a treatment);
 * the target's own text is excluded; unknown ids fail without substitution; the ijdg_ path is untouched. Also the engine
 * deps (treatment signal, remote citation check) and the HC citation fields of text hits.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteStore, SqlQuery } from "@/lib/db/remote";

vi.mock("@/lib/db/remote", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/db/remote")>()), remoteStore: () => fake }));

const calls: SqlQuery[] = [];
const TARGET = { id: "sc:2024_10_108_125", title: "Vijay Singh v. State of Bihar", court_id: "sci", neutral_citation: "2024 INSC 735", reporter_citation: "[2024] 10 S.C.R. 108", cnr: null, decision_date: "2024-09-25" };
const HC_TARGET = { id: "hc:kar_1", title: "Ramesh v. State of Karnataka", court_id: "hc-karnataka", neutral_citation: "2025:KHC:1234", reporter_citation: null, cnr: "KAHC010000012025", decision_date: "2025-02-03" };
const mention = (o: Record<string, string | null>) => ({ neutral_citation: null, cnr: null, t_date: null, court_id: "sci", t_title: null, chunk_index: "3", page_start: "6", id: null, title: null, decision_date: null, ...o });

const fake: RemoteStore = {
  async query(q) {
    calls.push(q);
    const sql = q.query;
    if (sql.includes("to_regclass('public.corpus_texts')")) return [{ ok: "t", hc: "t" }];
    if (sql.includes("FROM corpus_judgments WHERE id = $1")) return q.params?.[0] === TARGET.id ? [TARGET] : q.params?.[0] === HC_TARGET.id ? [HC_TARGET] : [];
    if (sql.includes("FROM corpus_judgments WHERE upper(neutral_citation) = $1")) return q.params?.[0] === "2024 INSC 735" ? [TARGET] : [];
    if (sql.includes("upper(replace(neutral_citation")) return q.params?.[0] === "2025:KHC:1234" ? [HC_TARGET] : [];
    if (sql.includes("phraseto_tsquery")) {
      const phrase = String(q.params?.[0]);
      if (phrase === "2024 INSC 735") return [
        // The target's own text mentions itself: excluded.
        mention({ neutral_citation: "2024 INSC 735", text: "This judgment 2024 INSC 735 is reported.", id: TARGET.id, title: TARGET.title, decision_date: TARGET.decision_date }),
        mention({ neutral_citation: "2025 INSC 12", text: `${"x ".repeat(300)}Following Vijay Singh v. State of Bihar, 2024 INSC 735, we hold that parity is relevant. ${"y ".repeat(300)}`, id: "sc:2025_1", title: "A v. B", decision_date: "2025-01-10" }),
        // The phrase search matched words, but the exact citation is a different number: rejected by the pattern check.
        mention({ neutral_citation: "2025 INSC 99", text: "see 2024 INSC 7350 for another point", id: "sc:2025_99", title: "C v. D", decision_date: "2025-03-01" }),
        mention({ neutral_citation: null, cnr: "KAHC010219082025", t_date: "2025-06-02", court_id: "hc-karnataka", t_title: "E v. F", page_start: "4", text: "The view in 2024 INSC 735 was doubted by a larger bench reference.", decision_date: null }),
      ];
      if (phrase === "[2024] 10 S.C.R. 108") return [
        mention({ neutral_citation: "2025 INSC 12", text: "reported in (2024) 10 SCR 108", id: "sc:2025_1", title: "A v. B", decision_date: "2025-01-10" }),
        mention({ neutral_citation: "2025 INSC 40", page_start: "2", text: "relied on (2024) 10 SCR 108 at para 9", id: "sc:2025_40", title: "G v. H", decision_date: "2025-02-11" }),
      ];
      return [];
    }
    if (sql.includes("upper(neutral_citation) = ANY")) return [{ n: "2024 INSC 735", r: "[2024] 10 S.C.R. 108" }];
    return [];
  },
  async transaction() { return []; },
};

import { citingReferencesTool, corpusCitingReferences, isCorpusJudgmentKey } from "@/lib/ai/toolkit/india";
import { citationPattern, corpusCitationsKnown, findCitationMentions, resetTextTableCacheForTests, resolveCorpusJudgment } from "@/modules/india/corpus/text";
import { defaultDeps, textHit } from "@/modules/search/engine/deps";
import { formatJudgmentCitation } from "@/modules/search/india-citations";
import { crossCheckCitations, normCite } from "@/modules/search/engine/citecheck";
import { sourceFromHit } from "@/modules/search/engine/sources";

const ctx = () => { const events: unknown[] = []; return { ctx: { emit: (e: unknown) => events.push(e), state: {} }, events }; };

beforeEach(() => { calls.length = 0; resetTextTableCacheForTests(); });

describe("citing_references for corpus judgments", () => {
  it("routes sc:/hc: ids, neutral citations and CNR@date to the corpus path; ijdg_ ids stay on the local path", () => {
    for (const id of ["sc:2024_10_108_125", "corpus:sc:2024_10_108_125", "hc:kar_1", "2024 INSC 735", "2025:KHC-D:7336", "KAHC010219082014@2014-09-09"]) expect(isCorpusJudgmentKey(id), id).toBe(true);
    for (const id of ["ijdg_8f2a61c0d9e4b7a35c10", "(2014) 8 SCC 273", "Arnesh Kumar"]) expect(isCorpusJudgmentKey(id), id).toBe(false);
  });

  it("resolves a target exactly and never by a nearby record", async () => {
    expect(await resolveCorpusJudgment("2024 INSC 735")).toMatchObject({ id: TARGET.id, textKey: "2024 INSC 735", reporterCitation: TARGET.reporter_citation });
    expect(await resolveCorpusJudgment("hc:kar_1")).toMatchObject({ textKey: "KAHC010000012025@2025-02-03", neutralCitation: "2025:KHC:1234" });
    expect(await resolveCorpusJudgment("2025:khc:01234")).toMatchObject({ id: "hc:kar_1" });
    expect(await resolveCorpusJudgment("2099 INSC 1")).toBeNull();
    expect(await resolveCorpusJudgment("Vijay Singh")).toBeNull();
  });

  it("finds later judgments that mention the neutral or reporter citation, with passage and page, excluding itself", async () => {
    const r = await corpusCitingReferences("sc:2024_10_108_125");
    expect(r.searched).toEqual(["2024 INSC 735", "[2024] 10 S.C.R. 108"]);
    // Newest first; one row per judgment; the target and the 7350 false positive are out.
    expect(r.mentions.map((m) => m.key)).toEqual(["KAHC010219082025@2025-06-02", "2025 INSC 40", "2025 INSC 12"]);
    const a = r.mentions.find((m) => m.key === "2025 INSC 12")!;
    expect(a).toMatchObject({ judgmentId: "sc:2025_1", page: 6, matched: "2024 INSC 735", citation: "2025 INSC 12" });
    expect(a.passage).toContain("Following Vijay Singh v. State of Bihar, 2024 INSC 735, we hold");
    expect(a.passage.startsWith("…")).toBe(true);
    expect(r.mentions.find((m) => m.key.startsWith("KAHC"))!.citation).toBe("CNR KAHC010219082025, decided 2025-06-02");
    const phraseCalls = calls.filter((c) => c.query.includes("phraseto_tsquery"));
    expect(phraseCalls.map((c) => c.params?.[0])).toEqual(["2024 INSC 735", "[2024] 10 S.C.R. 108"]);
    expect(phraseCalls[0].query).toMatch(/LIMIT 200/);
  });

  it("the tool labels results as mentions (text match), not treatment, and emits provenance with pages", async () => {
    const { ctx: c, events } = ctx();
    const out = (await citingReferencesTool.execute({ id: "2024 INSC 735" }, c)) as { relation: string; citing: { relation: string; source: string; title: string; page: number | null; negative_words_nearby: string | null; content: string[] }[]; note: string; searched_for: string[] };
    expect(out.relation).toBe("mentions (text match)");
    expect(out.citing.every((x) => x.relation === "mentions (text match)")).toBe(true);
    expect(out.citing.find((x) => x.title.startsWith("A v. B"))).toMatchObject({ source: "corpus://judgment/sc:2025_1#p6", title: "A v. B, 2025 INSC 12 (Supreme Court of India, 2025-01-10), p. 6" });
    expect(out.citing.find((x) => x.title.startsWith("E v. F"))!.negative_words_nearby).toBe("doubted");
    expect(out.note).toMatch(/not a treatment finding/);
    expect(JSON.stringify(out)).not.toMatch(/"(followed|overruled)"/);
    const ev = events.find((e) => (e as { type: string }).type === "evidence") as { evidence: { tool: string; page?: number }[] };
    expect(ev.evidence[0]).toMatchObject({ tool: "citing_references" });
  });

  it("fails explicitly for unknown ids and for records without a citation string; the ijdg_ path keeps its own error", async () => {
    const { ctx: c } = ctx();
    await expect(Promise.resolve().then(() => citingReferencesTool.execute({ id: "sc:missing" }, c))).rejects.toThrow(/not substituted/);
    await expect(Promise.resolve().then(() => citingReferencesTool.execute({ id: "ijdg_nope" }, c))).rejects.toThrow(/local judgment store/);
  });

  it("citationPattern tolerates reporter punctuation but not a different number", () => {
    const re = citationPattern("[2024] 10 S.C.R. 108")!;
    expect(re.test("(2024) 10 SCR 108")).toBe(true);
    expect(re.test("(2024) 10 SCR 1080")).toBe(false);
    expect(citationPattern("2024 INSC 735")!.test("2024 INSC 7350")).toBe(false);
    expect(citationPattern("x")).toBeNull();
  });

  it("findCitationMentions is bounded and reports unavailability without a text table", async () => {
    const r = await findCitationMentions(["2024 INSC 735"], { excludeKey: "2024 INSC 735", limit: 1 });
    expect(r.mentions).toHaveLength(1);
    expect(r.checked).toBe(4);
  });
});

describe("engine deps over the corpus", () => {
  it("citing() for a corpus judgment returns a corpus-basis treatment signal built from mentions", async () => {
    const t = await defaultDeps().citing!({ judgmentId: "2024 INSC 735" });
    expect(t).toMatchObject({ basis: "corpus", citingCount: 3, signal: "possibly_negative" });
    expect(t.examples?.[0].title).toMatch(/mentions \(text match\)/);
  });

  it("verifyCitationsRemote finds citations the Postgres index carries (found, not read)", async () => {
    const found = await defaultDeps().verifyCitationsRemote("See 2024 INSC 735 and 2099 INSC 1.");
    expect(found).toEqual(["2024 INSC 735"]);
    expect(await corpusCitationsKnown(["[2024] 10 s.c.r. 108"])).toEqual(new Set(["[2024] 10 s.c.r. 108"]));
  });

  it("High Court text hits carry the record's own neutral citation, or format as CNR with the decision date (never 'citation not verified')", () => {
    const nctx = { jurisdiction: "hc-karnataka" as never, courts: [] as never };
    const base = { judgmentId: null, neutralCitation: null, cnr: "KAHC010219082014", courtId: "hc-karnataka", citation: "CNR KAHC010219082014, decided 2014-09-09", title: "Ramesh v. State of Karnataka", court: "High Court of Karnataka", decisionDate: "2014-09-09", reporterCitation: null, caseNumber: "WP 1/2014", judges: [], pdfUrl: null, chunkIndex: 0, pageStart: 3, pageEnd: 3, passage: "p", rank: 1 };
    const plain = textHit(base, nctx);
    expect(plain).toMatchObject({ id: "corpus:KAHC010219082014@2014-09-09", readRef: { kind: "url", url: "corpus-text://KAHC010219082014@2014-09-09" } });
    expect(plain.cite).toBeUndefined();
    expect(formatJudgmentCitation(plain)).toBe("Ramesh v. State of Karnataka (CNR KAHC010219082014, High Court of Karnataka, decided on 9 September 2014)");
    const withNeutral = textHit({ ...base, judgmentId: "hc:x", recordNeutralCitation: "2014:KHC:5678" }, nctx);
    expect(withNeutral.cite).toBe("2014:KHC:5678");
    expect(withNeutral.citations).toEqual(["2014:KHC:5678"]);
    expect(formatJudgmentCitation(withNeutral)).toBe("Ramesh v. State of Karnataka, 2014:KHC:5678");
  });

  it("answers citing a read corpus judgment as 'Title, 2024 INSC 735, p. 6' or by its reporter in another print form resolve to it (no [VERIFY])", () => {
    const nctx = { jurisdiction: "sci" as never, courts: [] as never };
    const hit = textHit({ judgmentId: "sc:2024_10_108_125", neutralCitation: "2024 INSC 735", cnr: null, courtId: "sci", citation: "2024 INSC 735", title: "Vijay Singh v. State of Bihar", court: "Supreme Court of India", decisionDate: "2024-09-25", reporterCitation: "[2024] 10 S.C.R. 108", caseNumber: null, judges: [], pdfUrl: null, chunkIndex: 1, pageStart: 6, pageEnd: 6, passage: "p", rank: 1 }, nctx);
    const source = { ...sourceFromHit(hit, "l"), n: 1, read: true };
    const answer = "Parity is relevant: Vijay Singh v. State of Bihar, 2024 INSC 735, p. 6 [1]; reported as (2024) 10 SCR 108 [1]. Contrast 2099 INSC 1.";
    const r = crossCheckCitations(answer, [source]);
    expect(r.checks.filter((c) => c.matched).map((c) => c.citation)).toEqual(["2024 INSC 735", "(2024) 10 SCR 108"]);
    expect(r.unmatched.map((c) => c.citation)).toEqual(["2099 INSC 1"]);
    expect(normCite("2024 INSC 735, p. 6")).toBe(normCite("2024 INSC 735"));
    expect(normCite("(2024) 10 SCR 108")).toBe(normCite("[2024] 10 S.C.R. 108"));
  });
});
