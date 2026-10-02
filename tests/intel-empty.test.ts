import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// A production (non-demo) workspace on a private database: no sample corpus, no background work, no network.
vi.hoisted(() => {
  process.env.LECLAUDE_DATA_DIR = `${process.env.TMPDIR || "/tmp"}/intel-vitest-empty-${process.pid}`;
  process.env.LECLAUDE_SEED = "reference";
  process.env.LECLAUDE_BACKGROUND = "off";
  process.env.WORKFLOW_SCHEDULER_DISABLED = "1";
  process.env.INTEL_OFFLINE = "1";
  process.env.LECLAUDE_CORPUS_DIRS = "";
  process.env.OPENAI_API_KEY = "";
});

import { db, resetSqlite } from "@/lib/db";
import { intelAnalysisBootstrap } from "@/modules/intel/analysis/bootstrap";
import { analysisStatus, listInsights, rankInsights, runAnalysis } from "@/modules/intel/analysis/insights";
import { listEntities } from "@/modules/intel/analysis/entities";
import { buildChronology } from "@/modules/intel/analysis/chronology";
import { buildUserContext } from "@/modules/intel/context/user-context";
import { ensureIntelSeeded, purgeSampleIntel, referenceSources, SEED_SOURCE_IDS, seedIntel } from "@/modules/intel/seed";
import { seedIntelAnalysis } from "@/modules/intel/analysis/seed";
import { createSource } from "@/modules/intel/service";
import { intelDocuments, intelEntities, intelInsights, intelSources, upsertDocument } from "@/modules/intel/store";
import { INTEL_COLLECTIONS, type IntelRelation } from "@/modules/intel/types";

/** Names and numbers that only exist in the bundled sample corpus. */
const SAMPLE = /VALSARA|Depo-Provera|3140|Rodgers|Kale & Associates|medroxyprogesterone/i;

beforeAll(() => { resetSqlite(); db(); });
afterAll(() => { resetSqlite(); });

describe("intelligence layer on an empty production workspace", () => {
  it("bootstraps a neutral source catalog and no records", () => {
    expect(() => intelAnalysisBootstrap()).not.toThrow();
    expect(intelDocuments().count()).toBe(0);
    expect(intelEntities().count()).toBe(0);
    expect(intelInsights().count()).toBe(0);
    const sources = intelSources().all();
    expect(sources.length).toBe(referenceSources().length); // LeClaude India catalog: India sources + local folders + web pages
    expect(sources.every((s) => !s.enabled)).toBe(true); // nothing runs until the firm enables it
    expect(JSON.stringify(sources)).not.toMatch(SAMPLE);
    expect(db().kv.get("intel:seed:version")).toBeNull();
  });

  it("returns empty insights, entities, chronology and context without throwing", () => {
    expect(listInsights().total).toBe(0);
    expect(rankInsights({ limit: 6 })).toEqual([]);
    expect(listEntities({ limit: 100 }).total).toBe(0);
    const run = runAnalysis({ enqueueVerify: false, audit: false });
    expect(run.insights.total).toBe(0);
    expect(intelInsights().count()).toBe(0);
    expect(analysisStatus().documents).toBe(0);
    expect(buildChronology({ limit: 20 }).entries.filter((e) => SAMPLE.test(e.title))).toEqual([]);
    const ctx = buildUserContext("u_owner");
    expect(ctx.insights).toEqual([]);
    expect(ctx.matterActivity).toEqual([]);
    expect(ctx.upcoming.every((u) => u.insights.length === 0 && u.records.length === 0)).toBe(true);
  });

  it("enables only the local folders source, and only when folders are configured", () => {
    const prev = process.env.LECLAUDE_CORPUS_DIRS;
    process.env.LECLAUDE_CORPUS_DIRS = "/srv/firm/docs";
    try {
      const enabled = referenceSources().filter((s) => s.enabled).map((s) => s.id);
      expect(enabled).toEqual([SEED_SOURCE_IDS.localCorpus]);
    } finally { process.env.LECLAUDE_CORPUS_DIRS = prev; }
    expect(referenceSources().some((s) => s.enabled)).toBe(false);
    // The upstream JPML source is out of the India catalog; its neutral form (used to reset old rows) never falls back.
    expect(referenceSources(new Date(), { includeUs: true }).find((s) => s.id === SEED_SOURCE_IDS.jpml)?.config.allowFallback).toBe(false);
  });
});

describe("sample corpus copied into a production workspace", () => {
  it("is removed once, keeping records from sources the firm configured", () => {
    const d = db();
    // Simulate a database that received the demo corpus and its analysis (the pre-split behaviour).
    process.env.LECLAUDE_SEED = "demo";
    try {
      seedIntel(d);
      seedIntelAnalysis(d);
    } finally { process.env.LECLAUDE_SEED = "reference"; }
    expect(intelDocuments().count()).toBeGreaterThan(10);
    expect(intelInsights().count()).toBeGreaterThan(0);

    // A source the firm set up itself, with one record: it must survive the purge.
    const mine = createSource({ adapter: "web-list", name: "Our court's standing orders", config: { urls: [{ url: "https://example.org/orders" }] }, schedule: { every: "manual" } });
    const kept = upsertDocument({ sourceId: mine.id, adapter: "web-list", kind: "web_page", title: "Standing order on discovery", text: "Standing order governing discovery disputes in civil cases.", externalId: "test:firm:standing-order", dates: { published: "2026-09-01" } });

    d.kv.delete("intel:reference:version");
    expect(ensureIntelSeeded(d)).toBe(true);

    const docs = intelDocuments().all();
    expect(docs.map((x) => x.id)).toEqual([kept.doc.id]);
    expect(docs.some((x) => x.meta?.seeded)).toBe(false);
    expect(intelEntities().all().some((e) => e.attributes?.seeded)).toBe(false);
    expect(intelInsights().all().filter((i) => SAMPLE.test(`${i.title} ${i.summary}`))).toEqual([]);
    const rels = d.collection<IntelRelation>(INTEL_COLLECTIONS.relations).all();
    expect(rels.every((r) => r.evidence.some((ev) => ev.docId === kept.doc.id))).toBe(true);
    const system = intelSources().all().filter((s) => Object.values(SEED_SOURCE_IDS).includes(s.id));
    expect(JSON.stringify(system)).not.toMatch(SAMPLE);
    expect(intelSources().get(mine.id)).toBeTruthy();
    expect(d.kv.get("intel:seed:version")).toBeNull();

    // Idempotent: a second pass finds nothing to remove.
    expect(purgeSampleIntel(d)).toEqual({ documents: 0, entities: 0, relations: 0, insights: 0, sources: 0 });
    expect(ensureIntelSeeded(d)).toBe(false);
  });
});
