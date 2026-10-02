import "server-only";
import { ADAPTERS } from "./adapters";
import type { SourceAdapter } from "./adapter";
import { SOURCE_IDS, type SourceDef, type SourceId, type SourceKind } from "./types";

/**
 * Coded registry of the official sources (constitution §53.5: platform facts are coded, not remembered).
 *
 * `officialSources()` returns every SourceId in display order: the adapter's own definition when one is registered,
 * otherwise a disabled placeholder (so status pages and agents can say "not available yet" instead of omitting it).
 *
 * Egress: every outbound request for a source is limited to its hosts (`allowHostsFor`): the homepage host, the coded
 * `ALLOW_HOSTS` below and any extra hosts an adapter registers with `registerAllowHosts` (e.g. a CDN the publisher
 * links its PDFs from). A bare domain covers its subdomains (safeFetch `hostMatches`).
 */

const GOV = "Government publication; verify against the official copy";

/** Hosts each source may be fetched from (publisher sites and the CDNs they serve files from). */
export const ALLOW_HOSTS: Record<SourceId, string[]> = {
  "sci-causelist": ["sci.gov.in", "s3waas.gov.in"],
  "sci-orders": ["sci.gov.in", "s3waas.gov.in"],
  "sci-calendar": ["sci.gov.in", "s3waas.gov.in"],
  "hc-calendars": ["delhihighcourt.nic.in", "judiciary.karnataka.gov.in", "karnatakajudiciary.kar.nic.in", "hcmadras.tn.gov.in", "bombayhighcourt.gov.in", "bombayhighcourt.nic.in", "tshc.gov.in", "aphc.gov.in", "s3waas.gov.in"],
  "dhc-causelist": ["delhihighcourt.nic.in"],
  nclt: ["nclt.gov.in"],
  nclat: ["nclat.nic.in", "nclat.gov.in"],
  ibbi: ["ibbi.gov.in"],
  "sebi-orders": ["sebi.gov.in"],
  "sat-orders": ["sat.gov.in"],
  "cci-orders": ["cci.gov.in"],
  "ngt-orders": ["greentribunal.gov.in"],
  egazette: ["egazette.gov.in", "egazette.nic.in"],
  cbic: ["cbic.gov.in", "cbic-gst.gov.in"],
  "gst-council": ["gstcouncil.gov.in"],
  cbdt: ["incometaxindia.gov.in", "incometax.gov.in"],
  "mca-master": ["data.gov.in", "mca.gov.in"],
  sansad: ["sansad.in", "rsdoc.nic.in", "loksabhadocs.nic.in", "eparlib.nic.in"],
  lawcommission: ["lawcommissionofindia.nic.in", "cdnbbsr.s3waas.gov.in"],
};

/** Placeholder definitions for sources without a registered adapter (disabled; shown as "not available"). */
const PLACEHOLDER: Record<SourceId, { name: string; publisher: string; kinds: SourceKind[]; forum: string | null; homepage: string; cadenceMinutes: number }> = {
  "sci-causelist": { name: "Supreme Court cause lists", publisher: "Supreme Court of India", kinds: ["cause_list"], forum: "sci", homepage: "https://www.sci.gov.in/cause-list/", cadenceMinutes: 60 },
  "sci-orders": { name: "Supreme Court judgments and daily orders", publisher: "Supreme Court of India", kinds: ["judgment", "order"], forum: "sci", homepage: "https://www.sci.gov.in/", cadenceMinutes: 360 },
  "sci-calendar": { name: "Supreme Court calendar", publisher: "Supreme Court of India", kinds: ["calendar"], forum: "sci", homepage: "https://www.sci.gov.in/calendar/", cadenceMinutes: 1440 * 7 },
  "hc-calendars": { name: "High Court calendars", publisher: "High Courts of India", kinds: ["calendar"], forum: null, homepage: "https://delhihighcourt.nic.in/", cadenceMinutes: 1440 * 7 },
  "dhc-causelist": { name: "Delhi High Court cause lists", publisher: "High Court of Delhi", kinds: ["cause_list"], forum: "hc-delhi", homepage: "https://delhihighcourt.nic.in/", cadenceMinutes: 60 },
  nclt: { name: "NCLT cause lists and orders", publisher: "National Company Law Tribunal", kinds: ["cause_list", "defect_list", "calendar"], forum: "nclt", homepage: "https://nclt.gov.in/", cadenceMinutes: 120 },
  nclat: { name: "NCLAT cause lists, judgments and orders", publisher: "National Company Law Appellate Tribunal", kinds: ["cause_list", "judgment", "order", "calendar"], forum: "nclat", homepage: "https://nclat.nic.in/", cadenceMinutes: 120 },
  ibbi: { name: "IBBI orders and announcements", publisher: "Insolvency and Bankruptcy Board of India", kinds: ["order", "judgment"], forum: "ibbi", homepage: "https://ibbi.gov.in/", cadenceMinutes: 720 },
  "sebi-orders": { name: "SEBI enforcement orders", publisher: "Securities and Exchange Board of India", kinds: ["order"], forum: "sebi", homepage: "https://www.sebi.gov.in/", cadenceMinutes: 720 },
  "sat-orders": { name: "Securities Appellate Tribunal orders", publisher: "Securities Appellate Tribunal", kinds: ["order", "judgment"], forum: "sat", homepage: "https://sat.gov.in/", cadenceMinutes: 1440 },
  "cci-orders": { name: "CCI orders", publisher: "Competition Commission of India", kinds: ["order"], forum: "cci", homepage: "https://www.cci.gov.in/", cadenceMinutes: 1440 },
  "ngt-orders": { name: "NGT judgments and orders", publisher: "National Green Tribunal", kinds: ["judgment", "order"], forum: "ngt", homepage: "https://greentribunal.gov.in/", cadenceMinutes: 1440 },
  egazette: { name: "e-Gazette of India", publisher: "Department of Publication, Government of India", kinds: ["gazette", "notification"], forum: null, homepage: "https://egazette.gov.in/", cadenceMinutes: 720 },
  cbic: { name: "CBIC notifications and circulars", publisher: "Central Board of Indirect Taxes and Customs", kinds: ["notification", "circular"], forum: "cbic", homepage: "https://taxinformation.cbic.gov.in/", cadenceMinutes: 720 },
  "gst-council": { name: "GST Council agenda and minutes", publisher: "GST Council", kinds: ["minutes"], forum: "gst-council", homepage: "https://gstcouncil.gov.in/", cadenceMinutes: 1440 },
  cbdt: { name: "Income-tax circulars and notifications", publisher: "Central Board of Direct Taxes", kinds: ["circular", "notification"], forum: "cbdt", homepage: "https://incometaxindia.gov.in/", cadenceMinutes: 1440 },
  "mca-master": { name: "MCA company master data", publisher: "Ministry of Corporate Affairs", kinds: ["company_record", "dataset"], forum: "mca", homepage: "https://data.gov.in/", cadenceMinutes: 1440 * 7 },
  sansad: { name: "Parliament questions, debates and committee reports", publisher: "Parliament of India", kinds: ["parliament_question", "parliament_debate", "committee_report"], forum: "parliament", homepage: "https://sansad.in/", cadenceMinutes: 1440 },
  lawcommission: { name: "Law Commission of India reports", publisher: "Law Commission of India", kinds: ["reference_report"], forum: "lawcommission", homepage: "https://lawcommissionofindia.nic.in/law-commission-reports/", cadenceMinutes: 1440 * 7 },
};

function placeholderDef(id: SourceId): SourceDef {
  const p = PLACEHOLDER[id];
  return {
    id,
    name: p.name,
    publisher: p.publisher,
    kinds: p.kinds,
    forum: p.forum,
    homepage: p.homepage,
    fetch: "direct",
    cadenceMinutes: p.cadenceMinutes,
    attribution: `Source: ${p.publisher} (${p.homepage})`,
    terms: GOV,
    enabled: false,
    notes: ["No adapter is registered for this source on this deployment."],
  };
}

/** Adapters by id; tests may replace the lookup. */
let adapterLookup: (id: SourceId) => SourceAdapter | null = (id) => ADAPTERS[id] ?? null;

export function setOfficialAdaptersForTests(adapters: Partial<Record<SourceId, SourceAdapter>> | null): void {
  adapterLookup = adapters ? (id) => adapters[id] ?? null : (id) => ADAPTERS[id] ?? null;
}

export function officialAdapter(id: SourceId): SourceAdapter | null {
  return adapterLookup(id);
}

/** Every source in display order (adapter definitions, or disabled placeholders). */
export function officialSources(): SourceDef[] {
  return SOURCE_IDS.map((id) => sourceDef(id)!);
}

/** The definition for a source id (adapter's own, else a disabled placeholder); null for an unknown id. */
export function sourceDef(id: SourceId | string): SourceDef | null {
  if (!(SOURCE_IDS as readonly string[]).includes(id)) return null;
  const sid = id as SourceId;
  const a = adapterLookup(sid);
  if (a?.def && a.def.id === sid) return a.def;
  return placeholderDef(sid);
}

/** True when the source has an adapter and its definition is enabled. */
export function sourceEnabled(id: SourceId): boolean {
  const a = adapterLookup(id);
  return Boolean(a && a.def.id === id && a.def.enabled);
}

// Extra hosts registered by adapters at runtime. Kept on globalThis (not a module constant) so an adapter module that
// registers hosts while this module is still being evaluated (import cycle registry → adapters → registry) cannot hit
// a temporal-dead-zone error.
function extraHosts(): Map<SourceId, Set<string>> {
  const g = globalThis as { __leclaudeOfficialHosts?: Map<SourceId, Set<string>> };
  if (!g.__leclaudeOfficialHosts) g.__leclaudeOfficialHosts = new Map();
  return g.__leclaudeOfficialHosts;
}

/** A plain DNS name (no IP literal, port or wildcard). A function, not a module constant, for the same TDZ reason. */
function validHost(h: string): boolean {
  return /^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(h);
}

/** Let an adapter add hosts its publisher serves files from. Hosts must be plain DNS names (no IPs, no wildcards). */
export function registerAllowHosts(id: SourceId, hosts: string[]): void {
  const set = extraHosts().get(id) ?? new Set<string>();
  for (const h of hosts) {
    const host = h.trim().toLowerCase().replace(/^www\./, "");
    if (validHost(host)) set.add(host);
  }
  extraHosts().set(id, set);
}

/** The egress allowlist for a source: homepage host (without www.), coded hosts and adapter-registered hosts. */
export function allowHostsFor(def: Pick<SourceDef, "id" | "homepage">): string[] {
  const out = new Set<string>();
  try {
    const h = new URL(def.homepage).hostname.toLowerCase().replace(/^www\./, "");
    if (validHost(h)) out.add(h);
  } catch { /* no homepage host */ }
  for (const h of ALLOW_HOSTS[def.id] ?? []) out.add(h);
  for (const h of extraHosts().get(def.id) ?? []) out.add(h);
  return [...out];
}
