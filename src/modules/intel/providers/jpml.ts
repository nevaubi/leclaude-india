import "server-only";
import { decodeEntities } from "@/lib/ai/toolkit/http";
import { ProviderClient, ProviderError, providerEgress, type ProviderFactoryOptions } from "./base";

/**
 * Judicial Panel on Multidistrict Litigation — pending MDL dockets. The JPML
 * publishes the list as an HTML table; we parse it defensively and fall back
 * to a seeded list (flagged, lower confidence) when the page cannot be read.
 */
export const JPML_PENDING_URL = "https://www.jpml.uscourts.gov/pending-mdls-0";

export interface JpmlMdl {
  mdlNumber: string;
  title: string;
  court?: string;
  courtId?: string;
  judge?: string;
  docketNumber?: string;
  pendingActions?: number;
  transferDate?: string;
  /** True when the record came from the seeded fallback list rather than the live page. */
  fallback?: boolean;
  url?: string;
}

/** Fallback list: MDLs with pending dockets that we are confident about (court, transferee judge). */
export const JPML_FALLBACK: JpmlMdl[] = [
  { mdlNumber: "3140", title: "In re: Depo-Provera (Depot Medroxyprogesterone Acetate) Products Liability Litigation", court: "N.D. Florida", courtId: "flnd", judge: "M. Casey Rodgers", docketNumber: "3:25-md-03140", transferDate: "2025-02-07", fallback: true },
  { mdlNumber: "2804", title: "In re: National Prescription Opiate Litigation", court: "N.D. Ohio", courtId: "ohnd", judge: "Dan Aaron Polster", docketNumber: "1:17-md-02804", transferDate: "2017-12-05", fallback: true },
  { mdlNumber: "2846", title: "In re: Davol, Inc./C.R. Bard, Inc., Polypropylene Hernia Mesh Products Liability Litigation", court: "S.D. Ohio", courtId: "ohsd", judge: "Edmund A. Sargus, Jr.", docketNumber: "2:18-md-02846", fallback: true },
  { mdlNumber: "2924", title: "In re: Zantac (Ranitidine) Products Liability Litigation", court: "S.D. Florida", courtId: "flsd", judge: "Robin L. Rosenberg", docketNumber: "9:20-md-02924", transferDate: "2020-02-06", fallback: true },
  { mdlNumber: "3004", title: "In re: Paraquat Products Liability Litigation", court: "S.D. Illinois", courtId: "ilsd", judge: "Nancy J. Rosenstengel", docketNumber: "3:21-md-03004", transferDate: "2021-06-07", fallback: true },
  { mdlNumber: "3026", title: "In re: Abbott Laboratories, et al., Preterm Infant Nutrition Products Liability Litigation", court: "N.D. Illinois", courtId: "ilnd", judge: "Rebecca R. Pallmeyer", docketNumber: "1:22-cv-00071", fallback: true },
  { mdlNumber: "3036", title: "In re: Gardasil Products Liability Litigation", court: "W.D. North Carolina", courtId: "ncwd", judge: "Robert J. Conrad, Jr.", docketNumber: "3:22-md-03036", fallback: true },
  { mdlNumber: "3047", title: "In re: Social Media Adolescent Addiction/Personal Injury Products Liability Litigation", court: "N.D. California", courtId: "cand", judge: "Yvonne Gonzalez Rogers", docketNumber: "4:22-md-03047", transferDate: "2022-10-06", fallback: true },
  { mdlNumber: "3060", title: "In re: Hair Relaxer Marketing, Sales Practices, and Products Liability Litigation", court: "N.D. Illinois", courtId: "ilnd", judge: "Mary M. Rowland", docketNumber: "1:23-cv-00818", transferDate: "2023-02-06", fallback: true },
  { mdlNumber: "3081", title: "In re: Bard Implanted Port Catheter Products Liability Litigation", court: "D. Arizona", courtId: "azd", judge: "David G. Campbell", docketNumber: "2:23-md-03081", transferDate: "2023-08-08", fallback: true },
  { mdlNumber: "3084", title: "In re: Uber Technologies, Inc., Passenger Sexual Assault Litigation", court: "N.D. California", courtId: "cand", judge: "Charles R. Breyer", docketNumber: "3:23-md-03084", transferDate: "2023-10-04", fallback: true },
  { mdlNumber: "3089", title: "In re: Oral Phenylephrine Marketing and Sales Practices Litigation", court: "E.D. New York", courtId: "nyed", judge: "Brian M. Cogan", docketNumber: "1:23-md-03089", transferDate: "2023-12-06", fallback: true },
  { mdlNumber: "3092", title: "In re: Suboxone (Buprenorphine/Naloxone) Film Products Liability Litigation", court: "N.D. Ohio", courtId: "ohnd", judge: "J. Philip Calabrese", docketNumber: "1:24-md-03092", transferDate: "2024-02-02", fallback: true },
  { mdlNumber: "3094", title: "In re: Glucagon-Like Peptide-1 Receptor Agonists (GLP-1 RAs) Products Liability Litigation", court: "E.D. Pennsylvania", courtId: "paed", judge: "Karen S. Marston", docketNumber: "2:24-md-03094", transferDate: "2024-02-02", fallback: true },
  { mdlNumber: "3100", title: "In re: Real Estate Commission Antitrust Litigation", court: "W.D. Missouri", courtId: "mowd", judge: "Stephen R. Bough", docketNumber: "4:24-md-03100", fallback: true },
];

const COURT_ABBR: Record<string, string> = { "D. South Carolina": "dsc", "D.S.C.": "dsc", "N.D. Florida": "flnd", "S.D. Florida": "flsd", "M.D. Florida": "flmd", "N.D. California": "cand", "C.D. California": "cacd", "N.D. Illinois": "ilnd", "S.D. Illinois": "ilsd", "N.D. Ohio": "ohnd", "S.D. Ohio": "ohsd", "E.D. Pennsylvania": "paed", "D. Arizona": "azd", "E.D. New York": "nyed", "S.D. New York": "nysd", "D. New Jersey": "njd", "W.D. Missouri": "mowd", "W.D. North Carolina": "ncwd", "N.D. Texas": "txnd", "D. Delaware": "ded" };

export function courtIdFromAbbr(abbr: string | undefined): string | undefined {
  if (!abbr) return undefined;
  const key = abbr.replace(/\s+/g, " ").trim();
  if (COURT_ABBR[key]) return COURT_ABBR[key];
  const m = key.match(/^([NSEWCM]\.?D\.?|D\.?)\s*(.+)$/i);
  if (!m) return undefined;
  const norm = `${m[1].replace(/\./g, "").toUpperCase().replace(/^([NSEWCM])D$/, "$1.D.").replace(/^D$/, "D.")} ${m[2].trim()}`;
  return COURT_ABBR[norm];
}

/** Parse the JPML pending MDL HTML table into records. Tolerates column reordering by header names. */
export function parseJpmlTable(html: string): JpmlMdl[] {
  const tables = Array.from(html.matchAll(/<table[\s\S]*?<\/table>/gi)).map((m) => m[0]);
  const out: JpmlMdl[] = [];
  for (const table of tables) {
    const rows = Array.from(table.matchAll(/<tr[\s\S]*?<\/tr>/gi)).map((m) => m[0]);
    if (rows.length < 2) continue;
    const cells = (row: string) => Array.from(row.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)).map((m) => decodeEntities(m[1].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim());
    const header = cells(rows[0]).map((h) => h.toLowerCase());
    const col = (...names: string[]) => header.findIndex((h) => names.some((n) => h.includes(n)));
    const iMdl = col("mdl"), iTitle = col("litigation", "title", "name"), iCourt = col("district", "court"), iJudge = col("judge"), iActions = col("pending", "actions", "cases");
    if (iMdl < 0 || iTitle < 0) continue;
    for (const row of rows.slice(1)) {
      const c = cells(row);
      const mdlNumber = (c[iMdl] ?? "").replace(/[^0-9]/g, "");
      const title = c[iTitle] ?? "";
      if (!/^\d{3,4}$/.test(mdlNumber) || !title) continue;
      const court = iCourt >= 0 ? c[iCourt] : undefined;
      const actions = iActions >= 0 ? Number((c[iActions] ?? "").replace(/[^0-9]/g, "")) : NaN;
      out.push({ mdlNumber, title: title.startsWith("In re") ? title : `In re: ${title}`, court, courtId: courtIdFromAbbr(court), judge: iJudge >= 0 ? c[iJudge]?.replace(/^(?:hon\.?|judge)\s+/i, "") : undefined, pendingActions: Number.isFinite(actions) ? actions : undefined });
    }
  }
  return out;
}

export function createJpml(opts: ProviderFactoryOptions & { url?: string } = {}) {
  const client = new ProviderClient({ name: "jpml", egress: providerEgress("jpml"), rps: 0.5, burst: 2, timeoutMs: 30_000, cache: opts.cache, fetchImpl: opts.fetchImpl, offline: opts.offline, limiter: opts.limiter, sleep: opts.sleep, maxWaitMs: opts.maxWaitMs });
  const url = opts.url ?? JPML_PENDING_URL;
  return {
    name: "jpml" as const,
    client,
    url,
    /** Live list when the page parses to a plausible table; otherwise the fallback list with `fallback: true` and a note. */
    async pendingMDLs(o: { signal?: AbortSignal; ttlMs?: number; allowFallback?: boolean } = {}): Promise<{ mdls: JpmlMdl[]; source: "live" | "fallback"; note?: string }> {
      let note: string | undefined;
      try {
        const res = await client.getText(url, { signal: o.signal, ttlMs: o.ttlMs, maxBytes: 4_000_000 });
        const parsed = parseJpmlTable(res.text);
        if (parsed.length >= 5) return { mdls: parsed.map((m) => ({ ...m, url })), source: "live" };
        note = `JPML page parsed to ${parsed.length} rows; layout may have changed`;
      } catch (e) {
        if (o.allowFallback === false) throw e;
        note = (e as Error).message;
      }
      if (o.allowFallback === false) throw new ProviderError("jpml", "parse", note ?? "jpml: could not parse the pending MDL list", false, undefined, url);
      return { mdls: JPML_FALLBACK.map((m) => ({ ...m, url })), source: "fallback", note };
    },
  };
}

export type JpmlProvider = ReturnType<typeof createJpml>;
