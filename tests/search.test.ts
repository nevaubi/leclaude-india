import { beforeAll, describe, expect, it } from "vitest";
import { db, resetSqlite } from "@/lib/db";
import { markdownToDoc, docToText } from "@/modules/office/shared/markdown-doc";
import { JURISDICTIONS, classifyAuthority, resolveCourts, courtAbbreviation, bindingReason, effectiveJurisdiction, forumFromMatterCourt, jurisdictionByKey, persuasiveCourtIds } from "@/modules/search/jurisdictions";
import { normalizeCfr, normalizeFederalRegister, normalizeStatute, normalizeLibrary, normalizeEdoc, normalizeToolResult, normalizeJudgment, normalizeIndiaSection, formatBluebook, shortCite, preferredCitation, guessStatuteCite, bluebookDate, sortHits, dedupe } from "@/modules/search/normalize";
import { courtGroupKeys } from "@/modules/search/service";
import { BNSS_482, SC_BAIL } from "../evals/india-research/fixtures";
import { buildQuery, toCourtListenerSyntax, extractTerms, parseQuery, highlightSegments, datePresetRange } from "@/modules/search/query-builder";
import { spellingSuggestions, synonymSuggestions, editDistance } from "@/modules/search/synonyms";
import { buildMemoMarkdown, authoritiesTable, splitSynthesis, memoTitle } from "@/modules/search/memo";
import { extractCitations } from "@/modules/search/citations";
import { SEARCH_SEED_IDS, seedSearch } from "@/modules/search/seed";
import { createSavedSearch, deleteSavedSearch, listRuns, listSavedSearches, parseReadRef, parseRunRequest, recordRun, sanitizeSettings, saveHitToLibrary, updateSavedSearch, checkCitations, SAVED_RESEARCH_FOLDER_ID } from "@/modules/search/service";
import type { SearchHit } from "@/modules/search/types";

beforeAll(() => { resetSqlite(); });

const ctxKar = { jurisdiction: "hc-karnataka", courts: "" };

describe("forums (jurisdictions)", () => {
  it("lists the matter's court, All India, the Supreme Court, the focus High Courts and their subordinate courts, then other High Courts", () => {
    expect(JURISDICTIONS[0].key).toBe("matter-forum");
    expect(courtGroupKeys()).toEqual(JURISDICTIONS.map((j) => j.key));
    for (const k of ["all-india", "sci", "hc-karnataka", "hc-telangana", "hc-andhra", "ka-subordinate", "ts-subordinate", "ap-subordinate", "hc-bombay"]) expect(JURISDICTIONS.some((j) => j.key === k), k).toBe(true);
    expect(jurisdictionByKey("4th-circuit").key).toBe("matter-forum"); // unknown (e.g. US) keys fall back, never to a guessed court
    expect(effectiveJurisdiction("matter-forum", "High Court of Karnataka, Dharwad Bench")).toBe("hc-karnataka");
    expect(effectiveJurisdiction("matter-forum", "City Civil Court, Hyderabad")).toBe("ts-subordinate");
    expect(effectiveJurisdiction("matter-forum", "Some Tribunal")).toBe("all-india");
    expect(effectiveJurisdiction("hc-andhra", "High Court of Karnataka")).toBe("hc-andhra"); // an explicit forum wins
    expect(forumFromMatterCourt("Supreme Court of India")).toBe("sci");
  });
  it("classifies binding vs persuasive deterministically from the court registry (Art. 141, territory, pre-2019 Hyderabad)", () => {
    expect(classifyAuthority("sci", "hc-karnataka")).toBe("binding");
    expect(classifyAuthority("hc-karnataka", "hc-karnataka")).toBe("binding");
    expect(classifyAuthority("hc-telangana", "hc-karnataka")).toBe("persuasive");
    expect(classifyAuthority("hc-karnataka", "hc-telangana")).toBe("persuasive");
    expect(classifyAuthority("hc-karnataka", "ka-subordinate")).toBe("binding"); // a High Court binds courts in its State
    expect(classifyAuthority("hc-telangana", "ka-subordinate")).toBe("persuasive");
    expect(classifyAuthority("hc-karnataka", "sci")).toBe("persuasive");
    expect(classifyAuthority("hc-karnataka", "all-india")).toBe("persuasive");
    expect(classifyAuthority("sci", "all-india")).toBe("binding");
    // Erstwhile common High Court at Hyderabad (indexed under Telangana/AP): persuasive in both States before 2019.
    expect(classifyAuthority("hc-telangana", "hc-telangana", undefined, "2016-07-12")).toBe("persuasive");
    expect(classifyAuthority("hc-telangana", "hc-telangana", undefined, "2020-01-10")).toBe("binding");
    expect(classifyAuthority(undefined, "hc-karnataka")).toBe("n/a");
    expect(classifyAuthority("ca4", "hc-karnataka")).toBe("n/a"); // an unregistered court is never mapped to the nearest one
    expect(bindingReason("sci", "hc-telangana")).toContain("Art. 141");
    expect(bindingReason("hc-telangana", "hc-telangana", "2016-07-12")).toContain("erstwhile common High Court");
  });
  it("narrows retrieval to registry courts only and lists persuasive courts for the forum", () => {
    expect(resolveCourts("hc-karnataka", "  hc-karnataka, sci , bogus ")).toBe("hc-karnataka sci");
    expect(resolveCourts("hc-karnataka")).toBe("");
    expect(persuasiveCourtIds("hc-karnataka")).toContain("hc-telangana");
    expect(persuasiveCourtIds("hc-karnataka")).not.toContain("hc-karnataka");
    expect(courtAbbreviation("hc-karnataka")).toBe("Kar HC");
    expect(courtAbbreviation("zzz", "Some Court")).toBe("Some Court");
  });
});

describe("normalization", () => {
  it("normalizes judgments with the forum's authority, Indian citations and a judgment read ref", () => {
    const h = normalizeJudgment({ source: "judgment://hc-telangana/j1", title: "x", id: "j1", case_name: "Syed Imran vs State of Telangana", court: "High Court for the State of Telangana", court_id: "hc-telangana", bench_strength: 2, decided: "2022-08-19", neutral_citation: "2022:TSHC:3301", reporter_citations: [], judges: ["H", "I"], content: ["<b>custodial</b> interrogation"], language: "en" }, ctxKar);
    expect(h.id).toBe("judgment:j1");
    expect(h.authority).toBe("persuasive");
    expect(h.snippet).toBe("custodial interrogation");
    expect(h.readRef).toEqual({ kind: "judgment", id: "j1" });
    expect(h.india?.benchStrength).toBe(2);
    expect(formatBluebook(h)).toBe("Syed Imran v. State of Telangana, 2022:TSHC:3301");
    expect(shortCite(h)).toBe("Syed Imran, 2022:TSHC:3301");
    const unresolved = normalizeJudgment({ source: "judgment://unresolved/j2", title: "x", id: "j2", case_name: "A v. B", court_id: null, unresolved_court: "99_9", decided: "2020-01-01" }, ctxKar);
    expect(unresolved.authority).toBe("n/a");
    expect(formatBluebook(unresolved)).toContain("[citation not verified");
    expect(formatBluebook(SC_BAIL)).toBe("Meera Nair v. State of Karnataka, 2023 INSC 212 : (2023) 5 SCC 301");
    const sec = normalizeIndiaSection({ source: "statute://bnss-2023/s/482", title: "BNSS s. 482", id: "bnss-2023:482", enactment: "Bharatiya Nagarik Suraksha Sanhita", section: "482", content: ["When any person has reason to believe"] });
    expect(sec.readRef).toEqual({ kind: "section", id: "bnss-2023:482" });
    expect(formatBluebook(sec)).toBe("Section 482 of the Bharatiya Nagarik Suraksha Sanhita, 2023");
    expect(formatBluebook(BNSS_482)).toBe("Section 482 of the Bharatiya Nagarik Suraksha Sanhita, 2023");
  });
  it("keeps the US normalizers compiling for the US fork (US courts are not registry courts here)", () => {
    expect(preferredCitation(["2020 WL 123", "980 F.3d 1"])).toBe("980 F.3d 1");
    expect(bluebookDate("2024-04-26")).toBe("Apr. 26, 2024");
  });
  it("normalizes dockets, CFR, Federal Register, statutes, library and e-discovery", () => {
    const c = normalizeCfr({ cite: "40 C.F.R. § 141.61", title: "40", part: "141", section: "141.61", heading: "MCLs", excerpt: "PFOA <em>4.0</em> ng/L", effective: "2024-06-25", url: "https://www.ecfr.gov/current/title-40/section-141.61" });
    expect(c.readRef).toEqual({ kind: "cfr", title: 40, section: "141.61" });
    expect(c.snippet).toBe("PFOA 4.0 ng/L");
    expect(formatBluebook(c)).toBe("40 C.F.R. § 141.61 (2024)");

    const f = normalizeFederalRegister({ title: "PFAS NPDWR", type: "Rule", agencies: ["Environmental Protection Agency", undefined], published: "2024-04-26", citation: "89 FR 32532", document_number: "2024-07773", url: "https://www.federalregister.gov/d/2024-07773" });
    expect(f.readRef).toEqual({ kind: "fr", id: "2024-07773" });
    expect(f.fr?.agencies).toEqual(["Environmental Protection Agency"]);
    expect(formatBluebook(f)).toBe("PFAS NPDWR, 89 FR 32532 (Apr. 26, 2024)");

    const s = normalizeStatute({ title: "15 U.S.C. 2607 - Reporting and retention of information", package_id: "USCODE-2023-title15", granule_id: "g1", date: "2023-01-03", collection: "USCODE", text_url: "https://www.govinfo.gov/x.htm" });
    expect(s.cite).toBe("15 U.S.C. § 2607");
    expect(s.readRef).toEqual({ kind: "statute", url: "https://www.govinfo.gov/x.htm", id: "g1" });
    expect(guessStatuteCite("Public Law 114-182")).toBe("Pub. L. No. 114-182");

    const l = normalizeLibrary({ id: "lib1", name: "Indemnity clause bank", type: "clause", passage: "hold harmless", score: 0.8, practice_area: "Commercial" });
    expect(l.readRef).toEqual({ kind: "library", id: "lib1" });
    expect(l.url).toBe("/library?item=lib1");
    const l2 = normalizeLibrary({ id: "lib2", name: "Memo", type: "docx", passage: "x", score: 0.5, office_doc_id: "od1" });
    expect(l2.url).toBe("/office/word/od1");

    const e = normalizeEdoc({ id: "ed1", bates: "MFC-0041877", date: "2011-03-04", custodian: "Helen Voss", type: "Memo", subject: "Interim summary", passage: "rat liver", score: 0.9, ai_score: 88 });
    expect(e.cite).toBe("MFC-0041877");
    expect(formatBluebook(e)).toBe("MFC-0041877, Interim summary (4 March 2011)");
  });
  it("dispatches by source and dedupes", () => {
    const { hits, total } = normalizeToolResult("caselaw", { total: 42, results: [{ source: "judgment://sci/a", title: "A", id: "a", case_name: "A", court_id: "sci" }, { source: "judgment://sci/a", title: "A", id: "a", case_name: "A", court_id: "sci" }, { source: "judgment://hc-karnataka/b", title: "B", id: "b", case_name: "B", court_id: "hc-karnataka" }] }, ctxKar);
    expect(total).toBe(42);
    expect(hits.map((h) => h.title)).toEqual(["A", "B"]);
    expect(hits.map((h) => h.authority)).toEqual(["binding", "binding"]);
    expect(normalizeToolResult("web", { results: [{}] }, ctxKar).hits).toEqual([]);
    expect(dedupe([{ id: "x", source: "web", title: "1" }, { id: "x", source: "web", title: "2" }]).length).toBe(1);
    const sorted = sortHits([{ id: "a", source: "caselaw", title: "a", date: "2020-01-01" }, { id: "b", source: "caselaw", title: "b", date: "2024-01-01" }], "date");
    expect(sorted[0].id).toBe("b");
  });
});

describe("query builder", () => {
  it("builds boolean queries", () => {
    expect(buildQuery({ phrases: ["failure to warn"], all: ["PFAS"], any: ["PFOA", "PFOS"], none: ["asbestos"] })).toBe('"failure to warn" AND PFAS AND (PFOA OR PFOS) NOT asbestos');
    expect(buildQuery({ proximity: [{ a: "warning", b: "adequate", within: 10 }], fields: { caseName: "Meridian" } })).toBe('"warning adequate"~10 AND caseName:(Meridian)');
    expect(buildQuery({})).toBe("");
  });
  it("converts Westlaw operators to CourtListener syntax", () => {
    expect(toCourtListenerSyntax("warn /s adequate")).toBe('"warn adequate"~15');
    expect(toCourtListenerSyntax('"duty to warn" /p PFAS')).toBe('"duty to warn PFAS"~50');
    expect(toCourtListenerSyntax("indemnif! /5 hold")).toBe('"indemnif* hold"~5');
    expect(toCourtListenerSyntax("waiver & consequential % punitive")).toBe("waiver AND consequential NOT punitive");
    expect(toCourtListenerSyntax('"and now" and later or never')).toBe('"and now" AND later OR never');
  });
  it("extracts highlight terms and parses structure", () => {
    expect(extractTerms('"failure to warn" AND (PFAS OR PFOA) NOT asbestos caseName:Meridian')).toEqual(["failure to warn", "asbestos", "meridian", "pfas", "pfoa"]);
    const p = parseQuery('"failure to warn" AND PFAS AND (PFOA OR PFOS) NOT asbestos "warn adequate"~15');
    expect(p.phrases).toEqual(["failure to warn"]);
    expect(p.all).toEqual(["PFAS"]);
    expect(p.any).toEqual(["PFOA", "PFOS"]);
    expect(p.none).toEqual(["asbestos"]);
    expect(p.proximity).toEqual([{ a: "warn", b: "adequate", within: 15 }]);
    const segs = highlightSegments("The duty to warn arises when PFAS is known.", ["duty to warn", "pfas"]);
    expect(segs.filter((s) => s.hit).map((s) => s.text)).toEqual(["duty to warn", "PFAS"]);
    expect(highlightSegments("plain", [])).toEqual([{ text: "plain", hit: false }]);
  });
  it("computes date presets", () => {
    const now = new Date("2026-09-23T00:00:00Z");
    expect(datePresetRange("any", {}, now)).toEqual({});
    expect(datePresetRange("5y", {}, now)).toEqual({ from: "2021-09-23" });
    expect(datePresetRange("custom", { from: "2020-01-01", to: "" }, now)).toEqual({ from: "2020-01-01", to: undefined });
  });
});

describe("precision aids", () => {
  it("suggests synonyms and spelling fixes", () => {
    const syn = synonymSuggestions("PFAS failure to warn in the 4th circuit");
    expect(syn.map((s) => s.term)).toContain("failure to warn");
    expect(syn.find((s) => s.term === "pfas")?.synonyms).toContain("PFOA");
    expect(editDistance("preemtion", "preemption")).toBe(1);
    const sp = spellingSuggestions("impossibility preemtion under Albrecht");
    expect(sp).toEqual([{ term: "preemtion", suggestion: "preemption" }]);
    expect(spellingSuggestions("summary judgment")).toEqual([]);
  });
});

describe("citation extraction", () => {
  it("finds case, statute, regulation and register cites", () => {
    const text = "See Bell Atl. Corp. v. Twombly, 550 U.S. 544, 555 (2007); 15 U.S.C. § 2607(e); 40 C.F.R. § 141.61; 89 Fed. Reg. 32532 (Apr. 26, 2024); Sawyer, 860 F.3d 249.";
    const cites = extractCitations(text);
    expect(cites.map((c) => c.citation)).toEqual(["550 U.S. 544, 555", "15 U.S.C. § 2607(e)", "40 C.F.R. § 141.61", "89 Fed. Reg. 32532", "860 F.3d 249"]);
    expect(cites.map((c) => c.kind)).toEqual(["case", "statute", "regulation", "register", "case"]);
    expect(cites[2].lookupUrl).toBe("https://www.ecfr.gov/current/title-40/section-141.61");
  });
});

describe("memo builder", () => {
  const hitA: SearchHit = { ...SC_BAIL, snippet: "economic offence | with a pipe" };
  const hitB: SearchHit = BNSS_482;
  it("splits a synthesis into brief answer and analysis", () => {
    const s = splitSynthesis("## Answer\nYes.\n\n## Analysis\nBecause.\n\n## Next steps\n- x");
    expect(s.briefAnswer).toBe("Yes.");
    expect(s.analysis).toContain("Because.");
    expect(splitSynthesis("First para.\n\nSecond para.")).toEqual({ briefAnswer: "First para.", analysis: "Second para." });
  });
  it("produces a memo with all sections and a parseable authorities table", () => {
    const md = buildMemoMarkdown({ question: "Can anticipatory bail be refused only because the offence is economic?", synthesis: "## Answer\nNo.\n\n## Analysis\nSee [1].", sources: [{ hit: hitA, note: "Economic nature alone is not enough", addedAt: 1 }, { hit: hitB, addedAt: 2 }], openIssues: ["Pull the Dharwad Bench orders"], author: "Advocate", matterName: "State v. Ravi Kumar", matterCaption: "Crl.P. No. 1234 of 2024 (Kar HC)", jurisdictionLabel: "High Court of Karnataka", date: "2026-09-23" });
    for (const h of ["## Question presented", "## Brief answer", "## Analysis", "## Authorities", "## Open issues and next steps"]) expect(md).toContain(h);
    expect(md).toContain("No.");
    expect(md).toContain("| 1 | Judgments (SC & High Courts) | Meera Nair v. State of Karnataka, 2023 INSC 212 : (2023) 5 SCC 301 | SC | 14 March 2023 | Economic nature alone is not enough |");
    expect(md).toContain("Section 482 of the Bharatiya Nagarik Suraksha Sanhita, 2023");
    expect(md).toContain("**Date:** 23 September 2026");
    expect(md).toContain("- Pull the Dharwad Bench orders");
    expect(memoTitle("A very long question presented that should be truncated because it is longer than seventy characters")).toMatch(/…$/);
    const doc = markdownToDoc(md);
    const table = doc.content?.find((n) => n.type === "table");
    expect(table).toBeTruthy();
    expect(table!.content!.length).toBe(3); // header + 2 rows
    const text = docToText(doc);
    expect(text).toContain("Question presented");
    expect(text).toContain("Meera Nair v. State of Karnataka");
  });
  it("escapes pipes in table cells", () => {
    const t = authoritiesTable([{ hit: hitA, addedAt: 1 }]);
    expect(t).toContain("economic offence \\| with a pipe");
  });
});

describe("service + seeds", () => {
  it("seeds saved searches and runs idempotently", () => {
    const d = db();
    const saved = d.collection("search_saved");
    const runs = d.collection("search_runs");
    expect(saved.count()).toBeGreaterThanOrEqual(8);
    expect(runs.count()).toBeGreaterThanOrEqual(6);
    const before = { s: saved.count(), r: runs.count() };
    seedSearch(d);
    expect(saved.count()).toBe(before.s);
    expect(runs.count()).toBe(before.r);
    expect(SEARCH_SEED_IDS.savedSearches).toContain("ss_pfas_ftw_ca4");
    expect(listSavedSearches()[0].pinned).toBe(true);
    const named = listSavedSearches().map((s) => s.name);
    for (const n of ["PFAS failure to warn — 4th Cir.", "Consequential damages waiver enforceability — 7th Cir.", "TSCA 8(e) substantial risk", "PAGA manageability", "Meningioma DMPA"]) expect(named).toContain(n);
    const run = listRuns(50).find((r) => r.id === "run_seed_pfas_ftw_01");
    expect(run?.synthesis).toContain("## Answer");
    expect(run?.topHits?.length).toBeGreaterThan(3);
  });
  it("sanitizes settings and parses run requests", () => {
    const s = sanitizeSettings({ sources: ["caselaw", "bogus" as never, "caselaw"], limit: 999, order: "date", datePreset: "5y", dateFrom: "nope" });
    expect(s.sources).toEqual(["caselaw"]);
    expect(s.limit).toBe(50);
    expect(s.order).toBe("date");
    expect(s.dateFrom).toBeUndefined();
    expect(sanitizeSettings(undefined).sources.length).toBeGreaterThan(0);
    expect(parseRunRequest({})).toEqual({ error: "`message` (the research query) is required" });
    const ok = parseRunRequest({ message: "  anticipatory bail  ", sources: ["statutes"], runId: "run_x" });
    expect("error" in ok).toBe(false);
    if (!("error" in ok)) { expect(ok.query).toBe("anticipatory bail"); expect(ok.runId).toBe("run_x"); expect(ok.settings.sources).toEqual(["statutes"]); expect(ok.settings.jurisdiction).toBe("matter-forum"); }
    // US providers are not offered in this fork: they are dropped, never silently kept.
    expect(sanitizeSettings({ sources: ["dockets", "regulations", "federal_register"] }).sources).toEqual(["caselaw", "statutes", "library"]);
  });
  it("saved search CRUD", () => {
    const created = createSavedSearch({ query: "spoliation Rule 37(e) adverse inference", settings: { jurisdiction: "7th-circuit", sources: ["caselaw"] }, tags: ["test"] });
    expect(created.name).toBe("spoliation Rule 37(e) adverse inference");
    expect(created.settings.jurisdiction).toBe("7th-circuit");
    const updated = updateSavedSearch(created.id, { name: "Spoliation", pinned: true, settings: { limit: 30 } });
    expect(updated?.name).toBe("Spoliation");
    expect(updated?.settings.limit).toBe(30);
    expect(updated?.settings.jurisdiction).toBe("7th-circuit");
    expect(listSavedSearches()[0].id).toBe(created.id);
    expect(deleteSavedSearch(created.id)).toBe(true);
    expect(updateSavedSearch("missing", { name: "x" })).toBeNull();
  });
  it("records runs and bumps saved-search counters", () => {
    const before = listSavedSearches().find((s) => s.id === "ss_tsca_8e")!.runCount ?? 0;
    const run = recordRun({ id: "run_test_1", query: "substantial risk", settings: sanitizeSettings({ sources: ["caselaw", "statutes"] }), startedAt: Date.now() - 1500, outcome: { hits: { caselaw: [{ id: "caselaw:9", source: "caselaw", title: "X v. Y" }], statutes: [] }, totals: { caselaw: 10, statutes: 0 }, errors: [{ source: "statutes", message: "Provider unreachable (network). Retry when online." }], durationMs: 1200 }, synthesis: "## Answer\nok", aiStatus: "ok", savedSearchId: "ss_tsca_8e" });
    expect(run.counts).toEqual({ caselaw: 1, statutes: 0 });
    expect(run.errors?.length).toBe(1);
    expect(run.durationMs).toBeGreaterThanOrEqual(1500);
    expect(listRuns(1)[0].id).toBe("run_test_1");
    expect(listSavedSearches().find((s) => s.id === "ss_tsca_8e")!.runCount).toBe(before + 1);
  });
  it("parses read refs", () => {
    expect(parseReadRef({ kind: "opinion", id: "123" })).toEqual({ kind: "opinion", id: 123 });
    expect(parseReadRef({ kind: "cfr", title: 40, section: "141.61" })).toEqual({ kind: "cfr", title: 40, section: "141.61" });
    expect(parseReadRef({ kind: "url", url: "ftp://x" })).toBeNull();
    expect(parseReadRef({ kind: "edoc", id: "MFC-0041877" })).toEqual({ kind: "edoc", id: "MFC-0041877" });
    expect(parseReadRef({ kind: "judgment", id: "ijdg_1" })).toEqual({ kind: "judgment", id: "ijdg_1" });
    expect(parseReadRef({ kind: "section", id: "ienact_1:482" })).toEqual({ kind: "section", id: "ienact_1:482" });
    expect(parseReadRef({ kind: "nope" })).toBeNull();
  });
  it("saves a hit to the library once", () => {
    const hit: SearchHit = { id: "caselaw:77", source: "caselaw", title: "Estrada v. Royalty Carpet Mills, Inc.", cite: "15 Cal. 5th 582", courtId: "cal", date: "2024-01-18", url: "https://www.courtlistener.com/x", snippet: "manageability", authority: "binding" };
    const a = saveHitToLibrary(hit, { matterId: "m_sterling_employment" });
    const b = saveHitToLibrary(hit);
    expect(a.id).toBe(b.id);
    expect(a.parentId).toBe(SAVED_RESEARCH_FOLDER_ID);
    expect(a.type).toBe("link");
    expect(db().library.get(SAVED_RESEARCH_FOLDER_ID)?.type).toBe("folder");
    expect(a.tags).toContain("binding");
  });
  it("citation check degrades gracefully when the provider is unreachable", async () => {
    const r = await checkCitations("See 550 U.S. 544 and 40 C.F.R. § 141.61.");
    expect(r.extracted.length).toBe(2);
    expect(r.summary.total).toBe(2);
    // offline sandbox: provider error is reported, extraction still returned
    expect(r.checks.length === 0 ? typeof r.providerError === "string" : r.checks.length > 0).toBe(true);
  }, 40_000);
});
