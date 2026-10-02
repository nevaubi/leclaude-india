import "server-only";
import { db, type Database } from "@/lib/db";
import { indexDocuments } from "@/lib/ai/vector-store";
import { contentHash } from "@/lib/integrity/hash";
import { MATTERS } from "@/lib/seed/ids";
import { chunkIndexText, chunkIntelText, normalizeText } from "./chunk";
import { intelSampleMode } from "./config";
import { computeNextRunAt } from "./schedule";
import { SEED_DOCS, SEED_ENTITIES, type SeedSourceKey } from "./seed-corpus";
import { deleteDocument, docMetaForVector, textBlobIdFor } from "./store";
import { INTEL_COLLECTIONS, INTEL_VECTOR_NAMESPACE, type IntelChunk, type IntelDocument, type IntelEntity, type IntelInsight, type IntelRelation, type IntelSource } from "./types";

/**
 * Intel seeds, two modes (LECLAUDE_SEED, see src/lib/seed/index.ts):
 * - demo: one sample-configured system source per adapter (enabled where no key is needed) and the
 *   offline sample corpus (documents, chunks, keyword index, entities). Test suite and demos only.
 * - reference (production default): the same source catalog with neutral names and empty
 *   configuration, all disabled except the local folders when LECLAUDE_CORPUS_DIRS is set. No
 *   documents, entities or insights are created; the layer fills only from sources the firm turns on
 *   in Settings → Data & automation. Databases that received the sample corpus before this split are
 *   cleaned once (purgeSampleIntel).
 * Idempotent: stable ids, putMany; user edits to system sources are kept.
 */
export const INTEL_SEED_VERSION = 2;

export const SEED_SOURCE_IDS: Record<SeedSourceKey, string> = {
  clOpinions: "isrc_sys_cl_opinions",
  clDockets: "isrc_sys_cl_dockets",
  clJudges: "isrc_sys_cl_judges",
  ecfr: "isrc_sys_ecfr",
  federalRegister: "isrc_sys_federal_register",
  govinfo: "isrc_sys_govinfo",
  openfda: "isrc_sys_openfda",
  jpml: "isrc_sys_jpml",
  courtRules: "isrc_sys_court_rules",
  news: "isrc_sys_news",
  localCorpus: "isrc_sys_local_corpus",
  webList: "isrc_sys_web_list",
};

const hasEnv = (k: string) => Boolean(process.env[k]?.trim());

/**
 * LeClaude India default sources (stable ids). They replace the US sources (CourtListener, eCFR, Federal Register,
 * GovInfo, openFDA, JPML, US court rules) in this fork's production catalog; the US adapters stay registered and
 * compiling, and the demo catalog keeps its US sample sources because the bundled sample corpus is bound to them.
 */
export type IndiaSourceKey = "sciOpenData" | "hcOpenData" | "indianKanoon" | "indiaCode" | "sccOnline" | "manupatra";

export const INDIA_SOURCE_IDS: Record<IndiaSourceKey, string> = {
  sciOpenData: "isrc_sys_in_sci",
  hcOpenData: "isrc_sys_in_hc",
  indianKanoon: "isrc_sys_in_kanoon",
  indiaCode: "isrc_sys_in_india_code",
  sccOnline: "isrc_sys_in_scc_online",
  manupatra: "isrc_sys_in_manupatra",
};

/**
 * The India source catalog. Public open-data sources ship configured for the focus courts (Supreme Court; Karnataka,
 * Telangana and Andhra Pradesh High Courts; last two years) and the focus states' Acts, but stay disabled until the
 * firm enables them (or LECLAUDE_INDIA_OPEN_DATA=1 turns the public ones on). Indian Kanoon needs the firm's token;
 * SCC Online and Manupatra stay disabled and fail closed until a licence and an export folder or licensed API are set.
 */
export function indiaSources(now = new Date(), order0 = 0): IntelSource[] {
  const ts = now.toISOString();
  const openData = hasEnv("LECLAUDE_INDIA_OPEN_DATA") && ["1", "true", "yes"].includes(process.env.LECLAUDE_INDIA_OPEN_DATA!.trim().toLowerCase());
  const base = (key: IndiaSourceKey, s: Pick<IntelSource, "adapter" | "name" | "description" | "config" | "schedule"> & { enabled?: boolean }, order: number): IntelSource => {
    const enabled = Boolean(s.enabled);
    return {
      id: INDIA_SOURCE_IDS[key],
      adapter: s.adapter,
      name: s.name,
      description: s.description,
      config: s.config,
      schedule: s.schedule,
      enabled,
      status: enabled ? "idle" : "disabled",
      health: { ok: true, consecutiveFailures: 0 },
      nextRunAt: enabled ? new Date(now.getTime() + (order0 + order + 1) * 90_000).toISOString() : computeNextRunAt(s.schedule, now)?.toISOString(),
      stats: { documents: 0, chunks: 0, entities: 0, lastAdded: 0 },
      system: true,
      createdAt: ts,
      updatedAt: ts,
    };
  };
  return [
    base("sciOpenData", { adapter: "sci-open-data", name: "Supreme Court of India judgments", description: "Supreme Court judgments from the AWS Open Data set (English text of record, neutral and SCR citations, coram, court-published translations). Last two years, incremental.", config: { lastYears: 2, fetchPdf: true, translationLanguages: [] }, schedule: { every: "daily", at: "03:10" }, enabled: openData }, 0),
    base("hcOpenData", { adapter: "hc-open-data", name: "High Court judgments: Karnataka, Telangana, Andhra Pradesh", description: "High Court judgments from the AWS Open Data set for the focus courts and all their benches (Bengaluru, Dharwad, Kalaburagi; Hyderabad; Amaravati). Last two years, incremental.", config: { courts: ["29_3", "36_29", "28_2"], lastYears: 2, fetchPdf: true }, schedule: { every: "daily", at: "03:40" }, enabled: openData }, 1),
    base("indiaCode", { adapter: "india-code", name: "Acts and sections (India Code)", description: "Core central codes (BNS, BNSS, BSA, IPC, CrPC, Evidence Act, CPC, Limitation, Contract…) and the Acts of Karnataka, Telangana and Andhra Pradesh, with section text.", config: { states: ["KA", "TS", "AP"] }, schedule: { every: "weekly", at: "02:40", weekday: 0 }, enabled: openData }, 2),
    base("indianKanoon", { adapter: "indian-kanoon", name: "Indian Kanoon searches", description: "Saved Indian Kanoon searches over the Supreme Court and the focus High Courts (needs INDIAN_KANOON_API_TOKEN). Add queries, then enable.", config: { queries: [] }, schedule: { every: "daily", at: "06:10" } }, 3),
    base("sccOnline", { adapter: "scc-online", name: "SCC Online (firm licence only)", description: "Judgments from files the firm exports from its own SCC Online subscription, or a licensed API. Disabled until the licence is confirmed; never scraped.", config: { licenseAcknowledged: false, mode: "export" }, schedule: { every: "manual" } }, 4),
    base("manupatra", { adapter: "manupatra", name: "Manupatra (firm licence only)", description: "Judgments from files the firm exports from its own Manupatra subscription, or a licensed API. Disabled until the licence is confirmed; never scraped.", config: { licenseAcknowledged: false, mode: "export" }, schedule: { every: "manual" } }, 5),
  ];
}

/** The twelve sample-configured system sources (demo mode). Enabled only where no key is needed. */
export function systemSources(now = new Date()): IntelSource[] {
  const ts = now.toISOString();
  const base = (key: SeedSourceKey, s: Omit<IntelSource, "id" | "status" | "health" | "stats" | "createdAt" | "updatedAt" | "system" | "nextRunAt">, order: number): IntelSource => ({
    id: SEED_SOURCE_IDS[key],
    ...s,
    status: s.enabled ? "idle" : "disabled",
    health: { ok: true, consecutiveFailures: 0 },
    // Enabled sources start staggered shortly after boot; later runs follow the schedule.
    nextRunAt: s.enabled ? new Date(now.getTime() + (order + 1) * 90_000).toISOString() : computeNextRunAt(s.schedule, now)?.toISOString(),
    stats: { documents: 0, chunks: 0, entities: 0, lastAdded: 0 },
    system: true,
    createdAt: ts,
    updatedAt: ts,
  });
  const corpusDirs = (process.env.LECLAUDE_CORPUS_DIRS ?? "").split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  return [
    base("clOpinions", { adapter: "courtlistener-opinions", name: "Case law: product liability and preemption", description: "CourtListener opinions matching the matters' research themes in the 4th, 9th and 11th Circuits and the Supreme Court.", config: { queries: ['"Depo-Provera" OR medroxyprogesterone meningioma', '"failure to warn" AND preemption AND "clear evidence"', '"government contractor defense" AND Boyle'], courts: "scotus ca4 ca11 flnd ca9 cand", sinceDays: 60, maxResults: 15, fetchText: true }, schedule: { every: "daily", at: "05:00" }, enabled: true, scope: { matterIds: [MATTERS.depo] } }, 0),
    base("clDockets", { adapter: "courtlistener-dockets", name: "Docket watch: matter dockets", description: "RECAP dockets for the Depo-Provera MDL and watched dockets; new entries become docket_entry documents.", config: { docketNumbers: ["3:25-md-03140"], includeMatters: true, includeWatches: true, maxEntries: 50, entrySinceDays: 90 }, schedule: { every: "1h" }, enabled: true, scope: { matterIds: [MATTERS.depo], targets: ["3:25-md-03140"] } }, 1),
    base("clJudges", { adapter: "courtlistener-judges", name: "Judges: assigned and frequently seen", description: "Judge profiles (positions, courts, appointing authority) for the judges on matter dockets and opinions.", config: { names: ["M. Casey Rodgers"], fromDocuments: true, maxJudges: 10 }, schedule: { every: "weekly", at: "03:00", weekday: 1 }, enabled: true, scope: { matterIds: [MATTERS.depo] } }, 2),
    base("ecfr", { adapter: "ecfr", name: "Regulations: FDA labeling and drug safety reporting", description: "Tracked CFR sections kept current from eCFR.", config: { sections: [{ title: 21, section: "314.70" }, { title: 21, section: "314.80" }, { title: 21, section: "314.81" }, { title: 21, section: "201.56" }, { title: 21, section: "201.57" }], queries: ["medroxyprogesterone"], maxResults: 5, fetchSections: true }, schedule: { every: "daily", at: "04:00" }, enabled: true }, 3),
    base("federalRegister", { adapter: "federal-register", name: "Federal Register: FDA labeling and drug safety", description: "Rules, proposed rules and notices from FDA on the matters' subjects.", config: { queries: ["medroxyprogesterone", "prescription drug labeling"], agencies: ["food-and-drug-administration"], types: [], sinceDays: 30, maxResults: 15, fetchText: true }, schedule: { every: "daily", at: "06:30" }, enabled: true }, 4),
    base("govinfo", { adapter: "govinfo", name: "Statutes: TSCA, FDCA and MDL provisions", description: "U.S. Code sections from GovInfo (DEMO_KEY unless GOVINFO_API_KEY is set).", config: { queries: ["15 U.S.C. 2607", "21 U.S.C. 355", "28 U.S.C. 1407"], collection: "USCODE", maxResults: 5, fetchText: true }, schedule: { every: "weekly", at: "03:30", weekday: 2 }, enabled: true }, 5),
    base("openfda", { adapter: "openfda-recalls", name: "FDA enforcement: watched products", description: "openFDA recalls and current labeling for products in the matters.", config: { endpoints: ["drug", "device"], products: ["medroxyprogesterone", "Depo-Provera", "ranitidine"], firms: [], classifications: [], sinceDays: 365, maxResults: 50, labels: ["Depo-Provera"], deviceEvents: [], maxDeviceEvents: 25 }, schedule: { every: "daily", at: "05:30" }, enabled: true, scope: { matterIds: [MATTERS.depo] } }, 6),
    base("jpml", { adapter: "jpml-mdls", name: "JPML: pending MDL dockets", description: "The JPML pending MDL list, linked to the matters by MDL number; falls back to a seeded list when the page cannot be parsed.", config: { maxResults: 200, watch: ["3140"], allowFallback: true }, schedule: { every: "weekly", at: "02:30", weekday: 1 }, enabled: true }, 7),
    base("courtRules", { adapter: "court-rules", name: "Court rules: D.S.C., N.D. Fla., N.D. Cal. and FRCP", description: "Local rules, standing orders and MDL practice pages for the matters' courts.", config: { rules: [
      { court: "U.S. District Court for the District of South Carolina", courtId: "dsc", label: "D.S.C. Local Civil Rules", url: "https://www.scd.uscourts.gov/rules/localrules.asp" },
      { court: "U.S. District Court for the Northern District of Florida", courtId: "flnd", label: "N.D. Fla. Local Rules", url: "https://www.flnd.uscourts.gov/local-rules" },
      { court: "U.S. District Court for the Northern District of California", courtId: "cand", label: "N.D. Cal. Civil Local Rules", url: "https://www.cand.uscourts.gov/rules/civil-local-rules/" },
      { court: "United States federal courts", label: "Federal Rules of Civil Procedure (LII)", url: "https://www.law.cornell.edu/rules/frcp", jurisdiction: "Federal" },
    ], maxTextChars: 200_000, prefer: "auto" }, schedule: { every: "weekly", at: "02:00", weekday: 0 }, enabled: true }, 8),
    base("news", { adapter: "news", name: "News: matters, products and regulators", description: "Recent news for the matters and their products (needs TAVILY_API_KEY or FIRECRAWL_API_KEY).", config: { queries: ["Depo-Provera meningioma lawsuit", "FDA medroxyprogesterone label"], includeMatters: true, sinceDays: 7, maxResults: 8, provider: "auto", includeDomains: [], maxTextChars: 20_000 }, schedule: { every: "daily", at: "07:00" }, enabled: hasEnv("TAVILY_API_KEY") || hasEnv("FIRECRAWL_API_KEY"), scope: { matterIds: [MATTERS.depo] } }, 9),
    base("localCorpus", { adapter: "local-corpus", name: "Local document folders", description: "The firm's document folders (LECLAUDE_CORPUS_DIRS or the folders below), indexed incrementally and mapped to matters by folder name.", config: { dirs: corpusDirs, recursive: true, maxFileMb: 25, maxFiles: 500, skipHidden: true, matterMap: { "Valsara-Arbitration": MATTERS.valsara, "Depo-Provera": MATTERS.depo, "Northgate": MATTERS.northgate, "Project-Harbor": MATTERS.harbor, "Sterling": MATTERS.sterling }, maxTextChars: 400_000 }, schedule: { every: "daily", at: "02:00" }, enabled: corpusDirs.length > 0 }, 10),
    base("webList", { adapter: "web-list", name: "Watched web pages: CPCB and FDA drug safety", description: "Agency hub pages kept current as web_page documents.", config: { urls: [{ url: "https://cpcb.nic.in/", title: "Central Pollution Control Board — home page", matterId: MATTERS.valsara, tags: ["regulator"] }, { url: "https://www.fda.gov/drugs/drug-safety-and-availability", title: "FDA — Drug Safety and Availability", matterId: MATTERS.depo, tags: ["fda"] }], kind: "web_page", maxTextChars: 120_000, prefer: "auto" }, schedule: { every: "weekly", at: "01:30", weekday: 3 }, enabled: true }, 11),
    ...indiaSources(now, 12),
  ];
}

/**
 * Production source catalog (LeClaude India): the India sources, the local folders and watched web pages,
 * disabled until the firm enables them (the public India sources also when LECLAUDE_INDIA_OPEN_DATA=1); the
 * local folders are enabled only when LECLAUDE_CORPUS_DIRS names folders. The upstream US sources are left out
 * unless `includeUs` is set (used to reset sample-configured rows in older workspaces).
 */
export function referenceSources(now = new Date(), o: { includeUs?: boolean } = {}): IntelSource[] {
  const ts = now.toISOString();
  const corpusDirs = (process.env.LECLAUDE_CORPUS_DIRS ?? "").split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  const base = (key: SeedSourceKey, s: Pick<IntelSource, "adapter" | "name" | "description" | "config" | "schedule"> & { enabled?: boolean }, order: number): IntelSource => {
    const enabled = Boolean(s.enabled);
    return {
      id: SEED_SOURCE_IDS[key],
      adapter: s.adapter,
      name: s.name,
      description: s.description,
      config: s.config,
      schedule: s.schedule,
      enabled,
      status: enabled ? "idle" : "disabled",
      health: { ok: true, consecutiveFailures: 0 },
      nextRunAt: enabled ? new Date(now.getTime() + (order + 1) * 90_000).toISOString() : computeNextRunAt(s.schedule, now)?.toISOString(),
      stats: { documents: 0, chunks: 0, entities: 0, lastAdded: 0 },
      system: true,
      createdAt: ts,
      updatedAt: ts,
    };
  };
  const configure = "Add queries to this source, then enable it.";
  // LeClaude India: the US sources below are not part of this fork's default catalog (US_REFERENCE_KEYS).
  const us: IntelSource[] = [
    base("clOpinions", { adapter: "courtlistener-opinions", name: "Case law (CourtListener opinions)", description: `Opinions matching saved queries. ${configure}`, config: { queries: [] }, schedule: { every: "daily", at: "05:00" } }, 0),
    base("clDockets", { adapter: "courtlistener-dockets", name: "Docket watch (CourtListener RECAP)", description: "Follows the dockets of your matters and watched docket numbers; new entries become records.", config: { docketNumbers: [], includeMatters: true, includeWatches: true }, schedule: { every: "1h" } }, 1),
    base("clJudges", { adapter: "courtlistener-judges", name: "Judge profiles (CourtListener)", description: "Profiles for judges named on your dockets and opinions.", config: { names: [], fromDocuments: true }, schedule: { every: "weekly", at: "03:00", weekday: 1 } }, 2),
    base("ecfr", { adapter: "ecfr", name: "Regulations (eCFR)", description: `Tracked CFR sections kept current. ${configure}`, config: { sections: [], queries: [] }, schedule: { every: "daily", at: "04:00" } }, 3),
    base("federalRegister", { adapter: "federal-register", name: "Federal Register", description: `Rules, proposed rules and notices matching saved queries. ${configure}`, config: { queries: [], agencies: [] }, schedule: { every: "daily", at: "06:30" } }, 4),
    base("govinfo", { adapter: "govinfo", name: "Statutes (GovInfo)", description: `U.S. Code sections from GovInfo. ${configure}`, config: { queries: [] }, schedule: { every: "weekly", at: "03:30", weekday: 2 } }, 5),
    base("openfda", { adapter: "openfda-recalls", name: "FDA enforcement (openFDA)", description: `Recalls and labeling for watched products. ${configure}`, config: { products: [], firms: [], labels: [] }, schedule: { every: "daily", at: "05:30" } }, 6),
    base("jpml", { adapter: "jpml-mdls", name: "JPML pending MDL list", description: "The JPML pending MDL list, linked to your matters by MDL number. Live page only.", config: { watch: [], allowFallback: false }, schedule: { every: "weekly", at: "02:30", weekday: 1 } }, 7),
    base("courtRules", { adapter: "court-rules", name: "Court rules and standing orders", description: `Local rules and standing orders for your courts. ${configure}`, config: { rules: [] }, schedule: { every: "weekly", at: "02:00", weekday: 0 } }, 8),
    base("news", { adapter: "news", name: "News on your matters", description: "Recent news for your matters (needs TAVILY_API_KEY or FIRECRAWL_API_KEY).", config: { queries: [], includeMatters: true }, schedule: { every: "daily", at: "07:00" } }, 9),
    base("localCorpus", { adapter: "local-corpus", name: "Local document folders", description: "The firm's document folders from LECLAUDE_CORPUS_DIRS, indexed incrementally and mapped to matters by folder name.", config: { dirs: corpusDirs, recursive: true, matterMap: {} }, schedule: { every: "daily", at: "02:00" }, enabled: corpusDirs.length > 0 }, 10),
    base("webList", { adapter: "web-list", name: "Watched web pages", description: `Web pages kept current as records. ${configure}`, config: { urls: [] }, schedule: { every: "weekly", at: "01:30", weekday: 3 } }, 11),
  ];
  return [...indiaSources(now), ...(o.includeUs ? us : us.filter((x) => !US_REFERENCE_IDS.has(x.id)))];
}

/** Upstream US sources left out of the India production catalog (their adapters stay registered). */
export const US_REFERENCE_KEYS: SeedSourceKey[] = ["clOpinions", "clDockets", "clJudges", "ecfr", "federalRegister", "govinfo", "openfda", "jpml", "courtRules", "news"];
const US_REFERENCE_IDS = new Set(US_REFERENCE_KEYS.map((k) => SEED_SOURCE_IDS[k]));

export const INTEL_REFERENCE_VERSION = 2;
const REFERENCE_KEY = "intel:reference:version";

export interface SamplePurgeReport { documents: number; entities: number; relations: number; insights: number; sources: number }

/**
 * Remove the bundled sample corpus and everything derived from it from a production (non-demo)
 * database: seeded documents (with chunks, blobs and vectors), documents fetched by sources that
 * still carry the sample configuration, seeded entities, and relations/insights whose evidence no
 * longer resolves. Sample-configured system sources are replaced by the neutral catalog. Records
 * from sources the firm configured itself are kept.
 */
export function purgeSampleIntel(database: Database = db(), now = new Date()): SamplePurgeReport {
  const sources = database.collection<IntelSource>(INTEL_COLLECTIONS.sources);
  const documents = database.collection<IntelDocument>(INTEL_COLLECTIONS.documents);
  const entities = database.collection<IntelEntity>(INTEL_COLLECTIONS.entities);
  const relations = database.collection<IntelRelation>(INTEL_COLLECTIONS.relations);
  const insights = database.collection<IntelInsight>(INTEL_COLLECTIONS.insights);
  const report: SamplePurgeReport = { documents: 0, entities: 0, relations: 0, insights: 0, sources: 0 };

  const sampleIds = new Set(Object.values(SEED_SOURCE_IDS));
  const sample = new Map(systemSources(now).filter((s) => sampleIds.has(s.id)).map((s) => [s.id, JSON.stringify(s.config)]));
  const sampleSourceIds = new Set(sources.all().filter((s) => sample.get(s.id) === JSON.stringify(s.config)).map((s) => s.id));

  for (const d of documents.all()) {
    if (d.meta?.seeded === true || sampleSourceIds.has(d.sourceId)) { if (deleteDocument(d.id)) report.documents++; }
  }
  const alive = (docId: string) => documents.has(docId);
  for (const e of entities.all()) {
    const live = e.docIds.filter(alive);
    if (e.attributes?.seeded || (e.docIds.length > 0 && live.length === 0)) { entities.delete(e.id); report.entities++; }
    else if (live.length !== e.docIds.length) entities.put({ ...e, docIds: live, updatedAt: now.toISOString() });
  }
  for (const r of relations.all()) {
    if (!r.evidence.some((ev) => alive(ev.docId)) || !entities.has(r.from) || !entities.has(r.to)) { relations.delete(r.id); report.relations++; }
  }
  for (const i of insights.all()) {
    const evidenceGone = i.evidence.length > 0 && !i.evidence.some((ev) => alive(ev.docId));
    const scopeGone = i.evidence.length === 0 && (i.scope.entityIds ?? []).length > 0 && !(i.scope.entityIds ?? []).some((id) => entities.has(id));
    if (evidenceGone || scopeGone) { insights.delete(i.id); report.insights++; }
  }
  // Sample-configured US sources are reset to their neutral form too (they are no longer added to new workspaces).
  const neutral = new Map(referenceSources(now, { includeUs: true }).map((s) => [s.id, s]));
  for (const id of sampleSourceIds) {
    const next = neutral.get(id);
    if (next) { sources.put(next); report.sources++; }
  }
  return report;
}

/** Production path of ensureIntelSeeded: neutral source catalog, one-time purge of any sample corpus. */
function ensureIntelReference(database: Database): boolean {
  if (database.kv.get<number>(REFERENCE_KEY) === INTEL_REFERENCE_VERSION) return false;
  const now = new Date();
  if (database.kv.get<number>("intel:seed:version") != null) {
    const r = purgeSampleIntel(database, now);
    if (r.documents || r.entities || r.insights || r.relations || r.sources) console.log(`[intel] removed sample data from a production workspace: ${r.documents} records, ${r.entities} entities, ${r.relations} relations, ${r.insights} insights; ${r.sources} sources reset`);
    database.kv.delete("intel:seed:version");
    database.kv.delete("intel:analysis:seed:version");
    if (r.documents || r.insights) { database.kv.delete("intel:analysis:lastRun"); database.kv.delete("intel:last-sweep"); }
  }
  const sources = database.collection<IntelSource>(INTEL_COLLECTIONS.sources);
  const missing = referenceSources(now).filter((s) => !sources.has(s.id));
  if (missing.length) sources.putMany(missing);
  database.kv.set(REFERENCE_KEY, INTEL_REFERENCE_VERSION);
  return true;
}

export function seedIntel(database: Database): void {
  const now = new Date();
  const ts = now.toISOString();
  const sources = database.collection<IntelSource>(INTEL_COLLECTIONS.sources);
  const documents = database.collection<IntelDocument>(INTEL_COLLECTIONS.documents);
  const chunks = database.collection<IntelChunk>(INTEL_COLLECTIONS.chunks);
  const entities = database.collection<IntelEntity>(INTEL_COLLECTIONS.entities);

  // Sources: keep user edits (enabled, schedule, config) on re-seed; only fill in missing ones.
  const missing = systemSources(now).filter((s) => !sources.has(s.id));
  if (missing.length) sources.putMany(missing);

  // Entities.
  entities.putMany(SEED_ENTITIES.map((e): IntelEntity => {
    const existing = entities.get(e.id);
    return { id: e.id, type: e.type, name: e.name, canonical: e.name.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim(), aliases: e.aliases ?? [], attributes: { ...(existing?.attributes ?? {}), ...e.attributes, seeded: true }, mentionCount: existing?.mentionCount ?? 0, docIds: existing?.docIds ?? [], sources: existing?.sources ?? [], externalIds: e.externalIds, flags: existing?.flags, createdAt: existing?.createdAt ?? ts, updatedAt: ts };
  }));

  // Documents: rows, blobs, chunks and the keyword index (embeddings are added later by the doc.index job when a key exists).
  const rows: IntelDocument[] = [];
  const chunkRows: IntelChunk[] = [];
  const vectorDocs: { id: string; text: string; meta: Record<string, unknown> }[] = [];
  for (const s of SEED_DOCS) {
    const text = normalizeText(s.text);
    const sourceId = SEED_SOURCE_IDS[s.source];
    const adapter = (sources.get(sourceId)?.adapter ?? systemSources(now).find((x) => x.id === sourceId)!.adapter);
    const blobId = textBlobIdFor(s.id);
    database.blobs.put(new TextEncoder().encode(text), "text/plain; charset=utf-8", { id: blobId, name: `${s.title.slice(0, 80)}.txt`, meta: { docId: s.id, kind: s.kind, seeded: true } });
    const parts = chunkIntelText(text, { size: 1200, overlap: 150 });
    const existing = documents.get(s.id);
    const doc: IntelDocument = {
      id: s.id,
      sourceId,
      adapter,
      kind: s.kind,
      title: s.title,
      summary: s.summary,
      jurisdiction: s.jurisdiction,
      court: s.court,
      courtId: s.courtId,
      docketNumber: s.docketNumber,
      caseName: s.caseName,
      citation: s.citation,
      judgeIds: s.judgeIds ?? [],
      attorneyIds: s.attorneyIds ?? [],
      firmIds: s.firmIds ?? [],
      partyIds: s.partyIds ?? [],
      mdlId: s.mdlId,
      productIds: s.productIds ?? [],
      agencies: s.agencies ?? [],
      dates: s.dates,
      url: s.url,
      externalId: s.externalId,
      hash: contentHash(text),
      textBlobId: blobId,
      textLength: text.length,
      chunkCount: parts.length,
      matterIds: s.matterIds ?? [],
      tags: s.tags ?? [],
      flags: (s.flags ?? []).map((f) => ({ ...f, at: ts })),
      confidence: s.confidence ?? 0.8,
      meta: { ...(s.meta ?? {}), seeded: true, entities: s.entities ?? [] },
      fetchedAt: existing?.fetchedAt ?? ts,
      updatedAt: ts,
    };
    rows.push(doc);
    for (const c of parts) {
      const chunk: IntelChunk = { id: `${doc.id}#${c.idx}`, docId: doc.id, idx: c.idx, text: c.text, section: c.section, page: c.page, startChar: c.startChar, endChar: c.endChar, hash: contentHash(c.text) };
      chunkRows.push(chunk);
      vectorDocs.push({ id: chunk.id, text: chunkIndexText(chunk, doc.title), meta: docMetaForVector(doc, chunk) });
    }
  }
  documents.putMany(rows);
  chunks.putMany(chunkRows);
  void indexDocuments(INTEL_VECTOR_NAMESPACE, vectorDocs, { embed: false, chunkSize: 4000 }).catch((e) => console.error("[seed:intel] index", e));

  // Link seeded entities to their documents.
  const docIdsByEntity = new Map<string, string[]>();
  for (const d of rows) for (const id of [...d.judgeIds, ...d.attorneyIds, ...d.firmIds, ...d.partyIds, ...d.productIds, d.mdlId]) if (id) docIdsByEntity.set(id, [...(docIdsByEntity.get(id) ?? []), d.id]);
  for (const [id, docIds] of docIdsByEntity) {
    const e = entities.get(id);
    if (e) entities.put({ ...e, docIds: Array.from(new Set([...e.docIds, ...docIds])).slice(-200), mentionCount: Math.max(e.mentionCount, docIds.length), updatedAt: ts });
  }

  // Source stats reflect the seeded corpus.
  for (const s of sources.all()) {
    const mine = rows.filter((d) => d.sourceId === s.id);
    if (!mine.length) continue;
    sources.put({ ...s, stats: { ...s.stats, documents: documents.count((d) => d.sourceId === s.id), chunks: mine.reduce((n, d) => n + d.chunkCount, 0), entities: SEED_ENTITIES.length }, updatedAt: ts });
  }
  database.kv.set("intel:seed:version", INTEL_SEED_VERSION);
}

/**
 * Seed the intel layer lazily (cheap kv check). Demo mode: the sample corpus, for databases created
 * before the intel seeder was registered. Production: the neutral source catalog only.
 */
export function ensureIntelSeeded(database: Database = db()): boolean {
  if (!intelSampleMode()) return ensureIntelReference(database);
  if (database.kv.get<number>("intel:seed:version") === INTEL_SEED_VERSION) return false;
  seedIntel(database);
  return true;
}
