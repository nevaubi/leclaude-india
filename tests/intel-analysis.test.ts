import { beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.LECLAUDE_DATA_DIR = `${process.env.TMPDIR || "/tmp"}/intel-vitest-analysis-${process.pid}`;
  process.env.LECLAUDE_BACKGROUND = "off";
  process.env.WORKFLOW_SCHEDULER_DISABLED = "1";
  process.env.INTEL_OFFLINE = "1";
  process.env.OPENAI_API_KEY = "";
});

import { NextRequest } from "next/server";
import { db, resetSqlite } from "@/lib/db";
import { CONFIDENCE_GATE } from "@/lib/integrity/types";
import { MATTERS } from "@/lib/seed/ids";
import { E } from "@/modules/intel/seed-corpus";
import { getDocument, intelEntities, intelInsights, upsertDocument, upsertEntity } from "@/modules/intel/store";
import { bucketByMonth, classifyMotion, classifyOutcome, extractCfrCites, extractUscCites, mergeTimelineEntries, monthsBetween, addMonths, rankInsightsPure, scoreInsight, seriesTrend, zScoreAnomalies } from "@/modules/intel/analysis/pure";
import { defaultK, kmeans, labelClusters, tfidfVectors, denseToSparse } from "@/modules/intel/analysis/vectors";
import { entityDocuments, extractMentions, listEntities, rebuildEntities, resolveEntities } from "@/modules/intel/analysis/entities";
import { buildRelations, graphExport, neighborhood, relationsOf } from "@/modules/intel/analysis/graph";
import { buildTrends, motionOutcomes, stateOf } from "@/modules/intel/analysis/trends";
import { clusterChunks, clusterScope } from "@/modules/intel/analysis/clusters";
import { buildChronology, entriesFromDocument, exportChronologyToTimeline } from "@/modules/intel/analysis/chronology";
import { entityProfile } from "@/modules/intel/analysis/profiles";
import { analysisStatus, composeInsight, dismissInsight, listInsights, publishInsight, rankInsights, runAnalysis, saveInsight } from "@/modules/intel/analysis/insights";
import { createWatch, deleteWatch, listWatches, toggleEntityWatch, watchedTargets } from "@/modules/intel/analysis/watches";
import { buildMatterContext, buildUserContext, insightsFor } from "@/modules/intel/context/user-context";
import { defaultDeps, intelHitsFor, mergeIntelHits, INTEL_READ_PREFIX } from "@/modules/search/engine/deps";
import { planLanes } from "@/modules/search/engine/planner";
import { DEFAULT_SETTINGS } from "@/modules/search/types";
import { getIntelContextTool } from "@/lib/ai/toolkit/internal";
import * as entitiesRoute from "@/app/api/intel/entities/route";
import * as entityRoute from "@/app/api/intel/entities/[id]/route";
import * as relationsRoute from "@/app/api/intel/relations/route";
import * as graphRoute from "@/app/api/intel/graph/route";
import * as trendsRoute from "@/app/api/intel/trends/route";
import * as clustersRoute from "@/app/api/intel/clusters/route";
import * as chronologyRoute from "@/app/api/intel/chronology/route";
import * as insightsRoute from "@/app/api/intel/insights/route";
import * as insightRoute from "@/app/api/intel/insights/[id]/route";
import * as watchesRoute from "@/app/api/intel/watches/route";
import * as watchRoute from "@/app/api/intel/watches/[id]/route";
import * as contextRoute from "@/app/api/intel/context/route";
import * as analysisRoute from "@/app/api/intel/analysis/route";
import type { IntelDocument, IntelInsight, IntelTimelineEntry } from "@/modules/intel/types";

const VALSARA = MATTERS.valsara;
const DEPO = MATTERS.depo;
const USER = "p_jwhitfield"; // demo workspace owner (LECLAUDE_SEED=demo)
const BASE = "http://localhost/api/intel";
const req = (path: string, init: RequestInit = {}) => new NextRequest(`${BASE}${path}`, init as ConstructorParameters<typeof NextRequest>[1]);
const post = (path: string, body: unknown, method = "POST") => req(path, { method, body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const params = (p: { id: string }) => ({ params: Promise.resolve(p) });
const json = async (r: Response) => ({ status: r.status, body: await r.json() });
const today = new Date().toISOString().slice(0, 10);

beforeAll(() => { resetSqlite(); db(); });

describe("pure helpers", () => {
  it("classifies motions and outcomes from order titles", () => {
    expect(classifyMotion("Order denying the defendant's motion for summary judgment on the government contractor defense")).toBe("summary_judgment");
    expect(classifyMotion("Order on Rule 702 motions to exclude expert testimony")).toBe("daubert");
    expect(classifyMotion("Case Management Order No. 26")).toBe("case_management");
    expect(classifyMotion("Transfer Order of the JPML")).toBe("transfer");
    expect(classifyMotion("Notice of appearance")).toBeNull();
    expect(classifyOutcome("Order denying motion to dismiss")).toBe("denied");
    expect(classifyOutcome("Order granting in part and denying in part motion to compel")).toBe("partial");
    expect(classifyOutcome("Opinion affirming the judgment")).toBe("affirmed");
    expect(classifyOutcome("Motion for leave to file")).toBeNull();
  });
  it("extracts CFR and U.S.C. cites in canonical form", () => {
    expect(extractCfrCites("See 40 C.F.R. § 705.3 and 40 CFR 141.61; also 21 C.F.R. 314.70(c)")).toEqual(["40 C.F.R. § 705.3", "40 C.F.R. § 141.61", "21 C.F.R. § 314.70"]);
    expect(extractUscCites("under 15 U.S.C. § 2607(e) and 28 USC 1407")).toEqual(["15 U.S.C. § 2607(e)", "28 U.S.C. § 1407"]);
  });
  it("buckets by month, finds z-score anomalies and trend slopes", () => {
    expect(monthsBetween("2024-11", "2025-02")).toEqual(["2024-11", "2024-12", "2025-01", "2025-02"]);
    expect(addMonths("2024-12", 1)).toBe("2025-01");
    const items = [...Array(8).fill("2024-01-15"), "2024-02-10", "2024-03-10", "2024-03-12", "2024-04-01"].map((d, i) => ({ d, g: i % 2 ? "b" : "a" }));
    const { months, series } = bucketByMonth(items, { date: (x) => x.d, group: (x) => x.g });
    expect(months).toEqual(["2024-01", "2024-02", "2024-03", "2024-04"]);
    expect(series.every((s) => s.points.length === months.length)).toBe(true);
    expect(series.reduce((n, s) => n + s.points.reduce((a, p) => a + p.v, 0), 0)).toBe(items.length);
    const quiet = Array.from({ length: 8 }, (_, i) => ({ t: `2024-0${i + 1}`.slice(0, 7), v: 1 }));
    const spike = [...quiet, { t: "2024-09", v: 12 }];
    const anomalies = zScoreAnomalies(spike);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]).toMatchObject({ t: "2024-09", v: 12, direction: "up" });
    expect(zScoreAnomalies(quiet)).toHaveLength(0);
    const trend = seriesTrend([{ t: "a", v: 1 }, { t: "b", v: 2 }, { t: "c", v: 3 }, { t: "d", v: 4 }]);
    expect(trend.slope).toBeGreaterThan(0);
    expect(trend.changePct).toBeGreaterThan(0);
  });
  it("ranks insights by recency, relevance, confidence and watches", () => {
    const now = "2026-09-24T00:00:00.000Z";
    type Rankable = Pick<IntelInsight, "scope" | "confidence" | "status" | "updatedAt" | "createdAt" | "kind">;
    const base: Omit<Rankable, "scope"> = { status: "published", confidence: 0.8, updatedAt: now, createdAt: now, kind: "trend" };
    const mine: Rankable = { ...base, scope: { matterId: "m1", entityIds: [] } };
    const active: Rankable = { ...base, scope: { matterId: "m2", entityIds: [] } };
    const firm: Rankable = { ...base, scope: { entityIds: [] } };
    const other: Rankable = { ...base, scope: { matterId: "m3", entityIds: [] } };
    const old: Rankable = { ...mine, updatedAt: "2026-07-01T00:00:00.000Z" };
    const dismissed: Rankable = { ...mine, status: "dismissed" };
    const ctx = { userId: "u", matterId: "m1", activeMatterIds: ["m2"], watchedTargets: ["e1"], now };
    const s = (i: Rankable) => scoreInsight(i, ctx).score;
    expect(s(mine)).toBeGreaterThan(s(active));
    expect(s(active)).toBeGreaterThan(s(firm));
    expect(s(firm)).toBeGreaterThan(s(other));
    expect(s(mine)).toBeGreaterThan(s(old));
    expect(s(dismissed)).toBe(0);
    expect(scoreInsight({ ...firm, scope: { entityIds: ["e1"] } }, ctx).watch).toBe(1.5);
    const ranked = rankInsightsPure([other, firm, mine, dismissed, active], ctx);
    expect(ranked.map((r) => r.scope.matterId)).toEqual(["m1", "m2", undefined, "m3"]);
  });
  it("merges chronology entries on the same day with near-identical titles and unions evidence", () => {
    const a: IntelTimelineEntry[] = [{ at: "2023-06-04", title: "Order continuing the City of Stuart bellwether trial", kind: "docket", evidence: [{ docId: "d1" }], confidence: 0.6 }];
    const b: IntelTimelineEntry[] = [{ at: "2023-06-04", title: "Order continuing the City of Stuart bellwether trial to permit settlement", kind: "ediscovery:litigation", evidence: [{ docId: "tl_1" }], confidence: 0.9 }, { at: "2022-09-16", title: "Summary judgment denied", kind: "docket", evidence: [{ docId: "d2" }], confidence: 0.8 }];
    const { entries, merged } = mergeTimelineEntries([a, b]);
    expect(merged).toBe(1);
    expect(entries).toHaveLength(2);
    expect(entries[0].at).toBe("2022-09-16");
    expect(entries[1].evidence.map((e) => e.docId).sort()).toEqual(["d1", "tl_1"]);
    expect(entries[1].confidence).toBe(0.9);
  });
});

describe("vectors and clustering", () => {
  const water = ["solvent contamination of public water systems from industrial discharge near the estate", "trichloroethylene detected in drinking water wells near the industrial estate drain", "water provider claims for treatment costs from solvent contamination", "groundwater sampling shows solvent above the drinking water limit near the estate", "effluent runoff contaminated the water supply of the town and its wells"];
  const drug = ["prescription drug labeling changes for meningioma risk warnings on the injectable contraceptive", "the manufacturer updated the label warning after adverse event reports of intracranial meningioma", "failure to warn claims turn on whether the drug label could be changed under the CBE regulation", "the FDA approved a labeling supplement adding the meningioma warning to the prescription drug", "pharmacovigilance reports of meningioma in patients using the injectable drug"];
  it("builds normalized TF-IDF vectors and clusters two obvious topics deterministically", () => {
    const model = tfidfVectors([...water, ...drug]);
    expect(model.vocab.length).toBeGreaterThan(5);
    for (const v of model.vectors) { const n = Math.sqrt(Array.from(v.val).reduce((a, b) => a + b * b, 0)); expect(n).toBeCloseTo(1, 4); }
    const a = kmeans(model.vectors, 2, { dims: model.vocab.length, seed: 3 });
    const b = kmeans(model.vectors, 2, { dims: model.vocab.length, seed: 3 });
    expect(Array.from(a.assignments)).toEqual(Array.from(b.assignments));
    expect(a.k).toBe(2);
    const waterCluster = a.assignments[0];
    expect(water.every((_, i) => a.assignments[i] === waterCluster)).toBe(true);
    expect(drug.every((_, i) => a.assignments[water.length + i] !== waterCluster)).toBe(true);
    const labels = labelClusters(model, a.assignments, 2);
    expect(labels).toHaveLength(2);
    expect(labels.every((l) => l.terms.length > 0)).toBe(true);
    expect(defaultK(50)).toBe(5);
    expect(defaultK(3)).toBe(2);
  });
  it("uses embeddings when every chunk has one, else TF-IDF", () => {
    const chunks = [...water, ...drug].map((text, i) => ({ id: `c${i}`, docId: `d${i}`, text }));
    const vectors = new Map(chunks.map((c, i) => [c.id, i < water.length ? new Float32Array([1, 0.1, 0]) : new Float32Array([0, 0.1, 1])]));
    const withVec = clusterChunks({ chunks, vectors, k: 2 });
    expect(withVec.method).toBe("embeddings");
    expect(new Set(Array.from(withVec.assignments)).size).toBe(2);
    const without = clusterChunks({ chunks, k: 2 });
    expect(without.method).toBe("tfidf");
    expect(denseToSparse(new Float32Array([3, 4])).val[1]).toBeCloseTo(0.8, 5);
  });
});

describe("entities", () => {
  it("seeds entities, resolves mentions into existing records by alias and creates regulation entities from cites", () => {
    const rodgers = intelEntities().get(E.rodgers)!;
    expect(rodgers).toBeTruthy();
    expect(rodgers.docIds.length).toBeGreaterThan(0);
    expect(rodgers.mentionCount).toBe(rodgers.docIds.length);
    const docket = getDocument("idoc_seed_depo_docket")!;
    const before = intelEntities().count();
    const r = resolveEntities(docket)!;
    expect(r.entities.some((e) => e.id === E.rodgers)).toBe(true);
    expect(r.entities.some((e) => e.type === "court" && e.id === E.flnd)).toBe(true);
    expect(intelEntities().count()).toBe(before); // idempotent
    expect(getDocument(docket.id)!.judgeIds).toContain(E.rodgers);
    const regs = intelEntities().find((e) => e.type === "regulation");
    expect(regs.some((e) => e.name.startsWith("21 C.F.R. § 314"))).toBe(true);
    const statutes = intelEntities().find((e) => e.type === "statute");
    expect(statutes.some((e) => e.name.includes("1407"))).toBe(true);
    expect(rodgers.sources.some((s) => s.quote && s.chunkId)).toBe(true);
  });
  it("extracts parties, counsel, courts, MDLs and FDA fields from structured metadata", () => {
    const doc = { ...getDocument("idoc_seed_depo_docket")!, id: "x", meta: { parties: [{ name: "Harbor County Water Authority", role: "plaintiff", attorneys: ["Example & Partners LLP (Jane Q. Example)"] }], attorneys: ["John R. Sample, Sample Law Group, P.C."], mdlNumber: "3140", entities: [] }, agencies: ["Food and Drug Administration"] } as IntelDocument;
    const m = extractMentions(doc, "");
    expect(m.find((x) => x.type === "party" && x.name === "Harbor County Water Authority")?.role).toBe("plaintiff");
    expect(m.some((x) => x.type === "attorney" && x.name === "Jane Q. Example")).toBe(true);
    expect(m.some((x) => x.type === "firm" && /Example & Partners/.test(x.name))).toBe(true);
    expect(m.some((x) => x.type === "attorney" && x.name === "John R. Sample")).toBe(true);
    expect(m.some((x) => x.type === "mdl" && x.name === "MDL 3140" && x.externalId === "jpml:3140")).toBe(true);
    expect(m.some((x) => x.type === "court" && x.externalId === "cl:court:flnd")).toBe(true);
    expect(m.some((x) => x.type === "agency")).toBe(true);
    const recall = { ...doc, kind: "recall" as const, tags: [], meta: { product: "Depo-Provera CI 150 mg/mL", recallingFirm: "Pfizer Inc.", entities: [] }, agencies: [] } as IntelDocument;
    const rm = extractMentions(recall, "");
    expect(rm.some((x) => x.type === "product")).toBe(true);
    expect(rm.find((x) => x.type === "party")?.role).toBe("manufacturer");
    expect(rm.some((x) => x.type === "agency" && /Food and Drug/.test(x.name))).toBe(true);
  });
  it("lists entities with type filters, search and counts, and returns linked documents", () => {
    const judges = listEntities({ type: "judge", watchedBy: USER });
    expect(judges.items.length).toBeGreaterThanOrEqual(3);
    expect(judges.items.every((i) => i.type === "judge")).toBe(true);
    expect(judges.counts.judge).toBe(judges.total);
    const q = listEntities({ q: "rodgers" });
    expect(q.items.map((i) => i.id)).toContain(E.rodgers);
    expect(q.items[0].detail).toMatch(/Northern District of Florida/);
    expect(entityDocuments(E.mdl3140).length).toBeGreaterThan(2);
    const r = rebuildEntities({ docIds: ["idoc_seed_depo_docket"] });
    expect(r.docs).toBe(1);
  });
});

describe("graph", () => {
  it("derives typed relations with weights and evidence and answers neighborhood queries", () => {
    // Fictional counsel fixture (the sample corpus carries no counsel records): an appearance before the MDL judge.
    const firm = upsertEntity({ type: "firm", name: "Example & Partners LLP" });
    const atty = upsertEntity({ type: "attorney", name: "Jane Q. Example", attributes: { firmId: firm.id } });
    upsertDocument({ sourceId: "isrc_sys_cl_dockets", adapter: "courtlistener-dockets", kind: "docket_entry", title: "Notice of appearance of Jane Q. Example (Example & Partners LLP) — test fixture", text: "NOTICE OF APPEARANCE of Jane Q. Example of Example & Partners LLP. Test fixture; not a real filing.", dates: { filed: "2025-03-03", event: "2025-03-03" }, externalId: "test:appearance:example", judgeIds: [E.rodgers], attorneyIds: [atty.id], firmIds: [firm.id], mdlId: E.mdl3140, confidence: 0.8 });
    const res = buildRelations({});
    expect(res.total).toBeGreaterThan(10);
    const presides = relationsOf(E.rodgers, { types: ["presides"] });
    expect(presides.some((r) => r.to === E.mdl3140)).toBe(true);
    const edge = presides.find((r) => r.to === E.mdl3140)!;
    expect(edge.weight).toBeGreaterThanOrEqual(2);
    expect(edge.evidence.length).toBeGreaterThan(0);
    expect(edge.confidence).toBeGreaterThan(0.5);
    expect(relationsOf(atty.id, { types: ["before_judge"] }).some((r) => r.to === E.rodgers)).toBe(true);
    expect(relationsOf(atty.id, { types: ["employed_by"] }).some((r) => r.to === firm.id)).toBe(true);
    expect(relationsOf(E.mdl3140, { types: ["transferred_to"] }).some((r) => r.to === E.flnd)).toBe(true);
    expect(relationsOf(E.fda, { types: ["regulates"] }).length).toBeGreaterThan(0);
    const n1 = neighborhood(E.rodgers, 1);
    expect(n1.nodes.map((n) => n.id)).toContain(E.mdl3140);
    expect(n1.edges.every((e) => n1.nodes.some((n) => n.id === e.from) && n1.nodes.some((n) => n.id === e.to))).toBe(true);
    const n2 = neighborhood(E.rodgers, 2, { limit: 200 });
    expect(n2.nodes.length).toBeGreaterThanOrEqual(n1.nodes.length);
    const again = buildRelations({});
    expect(again.created).toBe(0);
    expect(again.total).toBe(res.total);
  });
  it("exports a bounded node/link graph for d3-force", () => {
    const g = graphExport({ limit: 20 });
    expect(g.nodes.length).toBeLessThanOrEqual(20);
    const ids = new Set(g.nodes.map((n) => n.id));
    expect(g.links.every((l) => ids.has(l.source) && ids.has(l.target))).toBe(true);
    expect(g.nodes.every((n) => typeof n.degree === "number")).toBe(true);
    const centered = graphExport({ entityId: E.rodgers, depth: 1 });
    expect(centered.center).toBe(E.rodgers);
    expect(centered.nodes.some((n) => n.id === E.rodgers)).toBe(true);
  });
});

describe("trends", () => {
  it("builds aligned month series by court, motion and judge with totals and label ids", () => {
    const byCourt = buildTrends({ groupBy: "court" });
    expect(byCourt.sample).toBeGreaterThan(5);
    expect(byCourt.months.every((m, i) => i === 0 || m > byCourt.months[i - 1])).toBe(true);
    expect(byCourt.series.every((s) => s.points.length === byCourt.months.length)).toBe(true);
    expect(byCourt.totals[0].count).toBeGreaterThan(0);
    const byMotion = buildTrends({ groupBy: "motion" });
    expect(byMotion.totals.map((t) => t.label)).toContain("Case management order");
    const byJudge = buildTrends({ groupBy: "judge" });
    expect(byJudge.labelIds[intelEntities().get(E.rodgers)!.name]).toBe(E.rodgers);
    const cmp = buildTrends({ groupBy: "judge", compare: [E.rodgers] });
    expect(cmp.series).toHaveLength(1);
    expect(stateOf({ courtId: "dsc" })).toBe("South Carolina");
    expect(stateOf({ court: "U.S. District Court for the Northern District of Florida" })).toBe("Florida");
  });
  it("detects anomalies over a fabricated docket burst and derives motion outcomes", () => {
    const base = getDocument("idoc_seed_depo_entry_preemption")!;
    const docs: IntelDocument[] = [];
    let n = 0;
    for (let m = 1; m <= 9; m++) for (let k = 0; k < (m === 9 ? 10 : 1); k++) docs.push({ ...base, id: `fake_${n++}`, title: k % 2 ? "Order denying motion to dismiss" : "Order granting motion to dismiss", dates: { filed: `2024-0${m}-1${k % 9}` } });
    const t = buildTrends({ groupBy: "kind", from: "2024-01", to: "2024-09" }, docs);
    expect(t.anomalies.some((a) => a.anomaly.t === "2024-09" && a.anomaly.direction === "up")).toBe(true);
    const outcomes = motionOutcomes(docs);
    expect(outcomes[0].motion).toBe("dismiss");
    expect(outcomes[0].granted + outcomes[0].denied).toBe(docs.length);
  });
});

describe("clusters", () => {
  it("clusters the seeded corpus deterministically with TF-IDF when no key is present", () => {
    const a = clusterScope({ kinds: ["opinion", "docket_entry", "regulation"], k: 3, maxChunks: 120 });
    expect(a.method).toBe("tfidf");
    expect(a.clusters.length).toBeLessThanOrEqual(3);
    expect(a.clusters.reduce((s, c) => s + c.size, 0)).toBe(a.chunks);
    expect(a.clusters.every((c) => c.topDocs.length > 0 && c.label)).toBe(true);
    const b = clusterScope({ kinds: ["opinion", "docket_entry", "regulation"], k: 3, maxChunks: 120 });
    expect(b.clusters.map((c) => c.size)).toEqual(a.clusters.map((c) => c.size));
  });
});

describe("chronology", () => {
  it("merges docket, regulatory, recall, opinion and e-discovery events into a sorted sourced timeline", () => {
    // The Valsara matter is a private arbitration with no public docket in the sample corpus: two fictional
    // record fixtures (one above and one below the confidence gate) stand in for matter-linked intelligence.
    upsertDocument({ sourceId: "isrc_sys_cl_dockets", adapter: "courtlistener-dockets", kind: "docket_entry", title: "Order on the Claimant's application for interim measures (test fixture)", text: "ORDER on the application for interim measures. Test fixture; not a real filing.", dates: { filed: today, event: today }, externalId: "test:vls:interim", matterIds: [VALSARA], confidence: 0.85 });
    upsertDocument({ sourceId: "isrc_sys_cl_dockets", adapter: "courtlistener-dockets", kind: "docket_entry", title: "Notice of hearing on document production (test fixture)", text: "NOTICE of hearing. Test fixture; not a real filing.", dates: { filed: "2025-04-02", event: "2025-04-02" }, externalId: "test:vls:hearing", matterIds: [VALSARA], confidence: 0.5 });
    const c = buildChronology({ matterId: VALSARA });
    expect(c.entries.length).toBeGreaterThan(5);
    expect(c.sources.intel).toBeGreaterThan(0);
    expect(c.sources.ediscovery).toBeGreaterThan(0);
    expect(c.entries.every((e, i) => i === 0 || e.at >= c.entries[i - 1].at)).toBe(true);
    expect(c.entries.every((e) => e.evidence.length > 0 && e.confidence > 0)).toBe(true);
    expect(c.entries.some((e) => e.kind === "docket")).toBe(true);
    const mdl = buildChronology({ mdlId: E.mdl3140, includeEdiscovery: false });
    expect(mdl.sources.ediscovery).toBe(0);
    expect(mdl.entries.length).toBeGreaterThan(3);
    const fr = getDocument("idoc_seed_fr_plr")!;
    const entries = entriesFromDocument(fr);
    expect(entries[0].kind).toBe("regulatory");
    expect(entries[0].evidence[0].href).toMatch(/^\/intel\/documents\//);
    expect(entriesFromDocument(getDocument("idoc_seed_judge_rodgers")!)).toHaveLength(0);
  });
  it("exports gate-passing entries to the e-discovery timeline once, as AI-created events with provenance", () => {
    const before = db().timeline.count((e) => e.matterId === VALSARA);
    const r1 = exportChronologyToTimeline(VALSARA);
    expect(r1.created).toBeGreaterThan(0);
    expect(db().timeline.count((e) => e.matterId === VALSARA)).toBe(before + r1.created);
    const ev = db().timeline.get(r1.eventIds[0])!;
    expect(ev.createdBy).toBe("ai");
    expect(ev.verified).toBe(false);
    expect(ev.provenance?.surface).toBe("intel.chronology");
    expect(ev.provenance?.verification?.method).toBe("schema");
    expect((ev.provenance?.confidence ?? 0) >= CONFIDENCE_GATE).toBe(true);
    expect(ev.sources[0].kind).toBe("external");
    const r2 = exportChronologyToTimeline(VALSARA);
    expect(r2.created).toBe(0);
    expect(r2.skippedDuplicates).toBeGreaterThanOrEqual(r1.created);
    const strict = exportChronologyToTimeline(VALSARA, { minConfidence: 0.99 });
    expect(strict.created).toBe(0);
    expect(strict.belowGate).toBeGreaterThan(0);
  });
});

describe("profiles", () => {
  it("builds a judge profile with counts, tendencies, related entities and a timeline", () => {
    const p = entityProfile(E.rodgers, { userId: USER })!;
    expect(p.counts.documents).toBeGreaterThan(3);
    expect(p.counts.byKind.docket_entry).toBeGreaterThan(0);
    expect(p.activity.points).toHaveLength(24);
    expect(Array.isArray(p.tendencies)).toBe(true); // outcome tendencies are covered by motionOutcomes above
    expect(p.related.some((r) => r.entity.id === E.mdl3140)).toBe(true);
    expect(p.recent.length).toBeGreaterThan(0);
    expect(p.timeline.length).toBeGreaterThan(0);
    expect(p.matters.map((m) => m.id)).toContain(DEPO);
    expect(p.watched).toBe(false);
  });
});

describe("insights", () => {
  it("seeds published, schema-verified insights with evidence for the matters and the firm", () => {
    const all = intelInsights().all();
    expect(all.length).toBeGreaterThan(4);
    const kinds = new Set(all.map((i) => i.kind));
    expect(kinds.has("chronology")).toBe(true);
    expect(kinds.has("trend")).toBe(true);
    expect(kinds.has("profile")).toBe(true);
    // Motion patterns need three rulings of one type; the trimmed sample corpus has none, so add fictional rulings.
    for (let i = 0; i < 3; i++) upsertDocument({ sourceId: "isrc_sys_cl_dockets", adapter: "courtlistener-dockets", kind: "docket_entry", title: `Order granting motion to dismiss member case ${i + 1} (test fixture)`, text: "ORDER granting motion to dismiss. Test fixture; not a real filing.", dates: { filed: `2025-05-0${i + 1}`, event: `2025-05-0${i + 1}` }, externalId: `test:pattern:${i}`, judgeIds: [E.rodgers], mdlId: E.mdl3140, matterIds: [DEPO], confidence: 0.85 });
    runAnalysis({ kinds: ["pattern"], enqueueVerify: false, audit: false });
    expect(intelInsights().all().some((i) => i.kind === "pattern")).toBe(true);
    const valsara = all.filter((i) => i.scope.matterId === DEPO);
    expect(valsara.length).toBeGreaterThan(1);
    expect(all.every((i) => i.provenance.surface === "intel.analysis" && i.provenance.verification?.method === "schema")).toBe(true);
    // Deterministic analyses never claim model verification: the badge reads source-backed / partially verified until the claims sweep runs with a key.
    expect(all.every((i) => i.provenance.verification?.status === "unverified" || i.provenance.verification?.status === "partially-verified")).toBe(true);
    expect(all.filter((i) => i.flags.some((f) => f.kind === "unverified")).every((i) => i.provenance.verification?.status === "partially-verified" && (i.provenance.verification?.unsupported ?? 0) > 0)).toBe(true);
    expect(all.filter((i) => i.status === "published").every((i) => i.evidence.length > 0 && i.confidence >= CONFIDENCE_GATE)).toBe(true);
    expect(analysisStatus().lastRun).toBeTruthy();
  });
  it("composes, stores idempotently, ranks, publishes and dismisses insights", () => {
    const ev = [{ docId: "idoc_seed_depo_entry_transfer", quote: "TRANSFER ORDER of the United States Judicial Panel" }];
    const draft = composeInsight({ kind: "pattern", scope: { matterId: DEPO, entityIds: [E.rodgers] }, key: "test-low", title: "Low confidence test", summary: "s", data: {}, evidence: ev, confidence: 0.4 });
    expect(draft.status).toBe("draft");
    expect(draft.flags.some((f) => f.kind === "low_confidence")).toBe(true);
    expect(draft.provenance.review?.status).toBe("pending");
    const ok = composeInsight({ kind: "pattern", scope: { matterId: DEPO, entityIds: [E.rodgers] }, key: "test-ok", title: "Good test", summary: "s", data: {}, evidence: ev, confidence: 0.85 });
    expect(ok.status).toBe("published");
    expect(ok.flags.some((f) => f.kind === "unverified")).toBe(false);
    expect(saveInsight(ok, { audit: false }).status).toBe("created");
    expect(saveInsight(ok, { audit: false }).status).toBe("unchanged");
    expect(saveInsight({ ...ok, summary: "changed" }, { audit: false }).status).toBe("updated");
    const pub = publishInsight(draft.id);
    saveInsight(draft, { audit: false });
    expect(publishInsight(draft.id).ok).toBe(false);
    expect(publishInsight(draft.id, { force: true }).ok).toBe(true);
    expect(pub.ok).toBe(false);
    expect(dismissInsight(ok.id)?.status).toBe("dismissed");
    expect(saveInsight({ ...ok, summary: "changed again" }, { audit: false }).insight.status).toBe("dismissed");
    const ranked = rankInsights({ userId: USER, matterId: DEPO, limit: 5 });
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked.every((i) => i.status === "published" || i.status === "verified")).toBe(true);
    expect(ranked[0].scope.matterId === DEPO || !ranked[0].scope.matterId).toBe(true);
    const list = listInsights({ userId: USER, rank: true, limit: 3 });
    expect(list.items).toEqual(list.insights);
    expect(list.ranked).toBe(true);
  });
  it("raises watch and recent-activity alerts after new records arrive", () => {
    const w = createWatch({ userId: USER, kind: "judge", target: E.rodgers });
    expect(watchedTargets(USER).has(E.rodgers)).toBe(true);
    upsertDocument({ sourceId: "isrc_sys_cl_dockets", adapter: "courtlistener-dockets", kind: "docket_entry", title: "Order granting motion to compel production of labeling history records", text: "ORDER granting plaintiffs' motion to compel. Judge Rodgers ordered production within 14 days.", dates: { filed: today, event: today }, externalId: `test:entry:${today}`, matterIds: [DEPO], judgeIds: [E.rodgers], mdlId: E.mdl3140, entities: [{ type: "judge", name: "M. Casey Rodgers", role: "presiding" }] });
    const r = runAnalysis({ enqueueVerify: false, audit: false });
    expect(r.entities.docs).toBeGreaterThanOrEqual(1);
    const alerts = intelInsights().find((i) => i.kind === "alert" && i.status !== "dismissed");
    expect(alerts.some((i) => i.scope.userId === USER && i.scope.entityIds.includes(E.rodgers))).toBe(true);
    expect(alerts.some((i) => i.scope.matterId === DEPO && /new record/.test(i.title))).toBe(true);
    expect(listWatches({ userId: USER })[0].lastNotifiedAt).toBeTruthy();
    expect(toggleEntityWatch(E.rodgers, { userId: USER }).watched).toBe(false);
    expect(deleteWatch(w.id)).toBe(false);
    expect(() => createWatch({ userId: USER, kind: "attorney", target: "nope" })).toThrow();
  });
});

describe("context", () => {
  it("builds the user context with matters, calendar, tasks, watches, insights and activity", () => {
    const u = buildUserContext(USER);
    expect(u.user.id).toBe(USER);
    expect(u.matters.length).toBeGreaterThan(0);
    expect(u.matters.some((m) => m.id === VALSARA && m.records > 0)).toBe(true);
    expect(Array.isArray(u.calendar) && Array.isArray(u.tasks)).toBe(true);
    expect(u.calendar.every((e) => e.daysUntil >= 0 && e.daysUntil <= 14)).toBe(true);
    expect(u.insights.length).toBeGreaterThan(0);
    expect(u.matterActivity.some((a) => a.matterId === VALSARA && a.docket.length > 0)).toBe(true);
    expect(u.team.every((p) => p.id !== USER)).toBe(true);
    expect(insightsFor({ userId: USER, matterId: DEPO, limit: 2 }).length).toBeLessThanOrEqual(2);
  });
  it("builds the matter context with resolved judge, MDL and court, chronology and insights", () => {
    const m = buildMatterContext(DEPO, { userId: USER })!;
    expect(m.judge?.id).toBe(E.rodgers);
    expect(m.mdl?.id).toBe(E.mdl3140);
    expect(intelEntities().get(m.court!.id)?.type).toBe("court"); // the most frequent court among the matter's records
    expect(m.chronology.length).toBeGreaterThan(0);
    expect(m.insights.every((i) => i.scope.matterId === DEPO || !i.scope.matterId)).toBe(true);
    expect(m.byKind.docket_entry).toBeGreaterThan(0);
    expect(buildMatterContext("m_missing")).toBeNull();
  });
});

describe("routes", () => {
  it("serves entities, profiles, watch toggles, relations, graph, trends, clusters and chronologies", async () => {
    const list = await json(await entitiesRoute.GET(req("/entities?type=judge,mdl&limit=50")));
    expect(list.status).toBe(200);
    expect(list.body.items.every((i: { type: string }) => i.type === "judge" || i.type === "mdl")).toBe(true);
    expect(list.body.counts.judge).toBeGreaterThan(0);
    const prof = await json(await entityRoute.GET(req(`/entities/${E.rodgers}`), params({ id: E.rodgers })));
    expect(prof.status).toBe(200);
    expect(prof.body.entity.id).toBe(E.rodgers);
    expect(prof.body.tendencies.length).toBeGreaterThan(0);
    const compact = await json(await entityRoute.GET(req(`/entities/${E.rodgers}?compact=1`), params({ id: E.rodgers })));
    expect(compact.body.counts.documents).toBeGreaterThan(0);
    const on = await json(await entityRoute.POST(post(`/entities/${E.rodgers}`, { action: "watch" }), params({ id: E.rodgers })));
    expect(on.body.watched).toBe(true);
    const off = await json(await entityRoute.POST(post(`/entities/${E.rodgers}`, { action: "watch" }), params({ id: E.rodgers })));
    expect(off.body.watched).toBe(false);
    expect((await entityRoute.GET(req("/entities/nope"), params({ id: "nope" }))).status).toBe(404);
    const rel = await json(await relationsRoute.GET(req(`/relations?entityId=${E.rodgers}&types=presides`)));
    expect(rel.body.relations.some((r: { to: string; toName: string }) => r.to === E.mdl3140 && r.toName)).toBe(true);
    const g = await json(await graphRoute.GET(req(`/graph?entityId=${E.rodgers}&depth=1`)));
    expect(g.body.nodes.some((n: { id: string }) => n.id === E.rodgers)).toBe(true);
    const t = await json(await trendsRoute.GET(req("/trends?groupBy=court&top=3")));
    expect(t.body.series.length).toBeLessThanOrEqual(3);
    expect((await trendsRoute.GET(req("/trends?groupBy=nope"))).status).toBe(422);
    const opts = await json(await trendsRoute.GET(req("/trends?options=1")));
    expect(opts.body.judges.length).toBeGreaterThan(0);
    const c = await json(await clustersRoute.GET(req("/clusters?kinds=opinion&k=2&maxChunks=60")));
    expect(c.body.method).toBe("tfidf");
    expect((await chronologyRoute.GET(req("/chronology"))).status).toBe(422);
    const ch = await json(await chronologyRoute.GET(req(`/chronology?matterId=${DEPO}&ediscovery=0`)));
    expect(ch.body.sources.ediscovery).toBe(0);
    expect(ch.body.entries.length).toBeGreaterThan(0);
    const exp = await json(await chronologyRoute.POST(post("/chronology", { matterId: DEPO })));
    expect(exp.status).toBe(200);
    expect(typeof exp.body.created).toBe("number");
    expect((await chronologyRoute.POST(post("/chronology", { matterId: "m_missing" }))).status).toBe(404);
  });
  it("serves ranked insights, insight actions, watches, context and analysis status", async () => {
    const list = await json(await insightsRoute.GET(req(`/insights?userId=${USER}&limit=6&status=published`)));
    expect(list.status).toBe(200);
    expect(list.body.ranked).toBe(true);
    expect(list.body.items.length).toBeGreaterThan(0);
    expect(list.body.items.every((i: { status: string }) => i.status === "published")).toBe(true);
    const id = list.body.items[0].id as string;
    const one = await json(await insightRoute.GET(req(`/insights/${id}`), params({ id })));
    expect(one.body.insight.id).toBe(id);
    expect(one.body.evidence[0].doc).toBeTruthy();
    const verify = await insightRoute.POST(post(`/insights/${id}`, { action: "verify" }), params({ id }));
    expect(verify.status).toBe(503);
    const dismissed = await json(await insightRoute.POST(post(`/insights/${id}`, { action: "dismiss" }), params({ id })));
    expect(dismissed.body.insight.status).toBe("dismissed");
    expect((await insightRoute.POST(post(`/insights/${id}`, { action: "nope" }), params({ id }))).status).toBe(422);
    const created = await json(await watchesRoute.POST(post("/watches", { kind: "mdl", target: E.mdl3140 })));
    expect(created.status).toBe(201);
    const watches = await json(await watchesRoute.GET(req(`/watches?userId=${USER}`)));
    expect(watches.body.watches.some((w: { id: string; entity: { name: string } | null }) => w.id === created.body.watch.id && w.entity?.name)).toBe(true);
    const patched = await json(await watchRoute.PATCH(post(`/watches/${created.body.watch.id}`, { label: "Depo-Provera MDL" }, "PATCH"), params({ id: created.body.watch.id })));
    expect(patched.body.watch.label).toBe("Depo-Provera MDL");
    const del = await json(await watchRoute.DELETE(req(`/watches/${created.body.watch.id}`, { method: "DELETE" }), params({ id: created.body.watch.id })));
    expect(del.body.deleted).toBe(true);
    expect((await watchesRoute.POST(post("/watches", { kind: "judge" }))).status).toBe(422);
    const ctx = await json(await contextRoute.GET(req(`/context?userId=${USER}`)));
    expect(ctx.body.user.matters.length).toBeGreaterThan(0);
    const mctx = await json(await contextRoute.GET(req(`/context?matterId=${DEPO}`)));
    expect(mctx.body.matter.judge.id).toBe(E.rodgers);
    expect((await contextRoute.GET(req("/context?matterId=m_missing"))).status).toBe(404);
    const status = await json(await analysisRoute.GET());
    expect(status.body.entities).toBeGreaterThan(0);
    const run = await json(await analysisRoute.POST(post("/analysis", { run: "insights" })));
    expect(run.status).toBe(200);
    expect(run.body.insights.total).toBeGreaterThan(0);
    expect((await analysisRoute.POST(post("/analysis", { run: "nope" }))).status).toBe(422);
    const ent = await json(await entitiesRoute.POST(post("/entities", { action: "rebuild", docIds: ["idoc_seed_depo_docket"] })));
    expect(ent.body.entities.docs).toBe(1);
  });
});

describe("research engine feed and agent tool", () => {
  it("feeds provider lanes with normalized intelligence hits and reads them without the network", async () => {
    const hits = await intelHitsFor("caselaw", "preemption failure to warn", DEFAULT_SETTINGS);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.source === "caselaw" && h.id.startsWith("intel:") && h.readRef?.kind === "url" && (h.readRef as { url: string }).url.startsWith(INTEL_READ_PREFIX))).toBe(true);
    expect(hits[0].subtitle).toMatch(/intelligence corpus/);
    const merged = mergeIntelHits([{ id: "caselaw:1", source: "caselaw", title: "x", cite: hits[0].cite }], hits);
    expect(merged.filter((h) => h.cite === hits[0].cite)).toHaveLength(hits[0].cite ? 1 : 2);
    expect(await intelHitsFor("web", "anything", DEFAULT_SETTINGS)).toEqual([]);
    const deps = defaultDeps();
    const read = await deps.read(hits[0].readRef!, {});
    expect(read.text.length).toBeGreaterThan(50);
    expect(read.cached).toBe(true);
    await expect(deps.read({ kind: "url", url: `${INTEL_READ_PREFIX}missing` }, {})).rejects.toThrow();
    const lanes = planLanes({ question: "Is failure to warn preempted for a branded drug?", settings: DEFAULT_SETTINGS, mode: "deep", hasMatter: false });
    expect(lanes.every((l) => l.intel === true && l.note)).toBe(true);
  });
  it("answers the agents' get_intel_context tool with matter, user, entity and passage context", async () => {
    const ctx = { emit: () => {}, state: {} };
    const m = (await getIntelContextTool.execute({ matter_id: DEPO, query: "meningioma failure to warn preemption", entity_id: E.rodgers, limit: 3 }, ctx)) as Record<string, unknown>;
    const matter = m.matter as { judge?: { id: string }; recent_docket: unknown[]; chronology: unknown[] };
    expect(matter.judge?.id).toBe(E.rodgers);
    expect(matter.chronology.length).toBeGreaterThan(0);
    expect((m.hits as { passage: string }[]).length).toBeGreaterThan(0);
    expect((m.entity as { tendencies: unknown[] }).tendencies.length).toBeGreaterThan(0);
    const u = (await getIntelContextTool.execute({}, ctx)) as { user: { matters: unknown[] } };
    expect(u.user.matters.length).toBeGreaterThan(0);
    await expect(getIntelContextTool.execute({ matter_id: "m_missing" }, ctx)).rejects.toThrow();
  });
});
