/**
 * High Court judgments — AWS Open Data `indian-high-court-judgments` (pure parser, no I/O).
 *
 * Layout (verified against the live bucket, September 2026):
 *   metadata/json/year=YYYY/court=<state>_<n>/bench=<bench>/<CNR>_<n>_<YYYY-MM-DD>.json
 *       { court_code "29~3", court_name, raw_html, pdf_link, downloaded }
 *   data/pdf/year=YYYY/court=<state>_<n>/bench=<bench>/<same basename>.pdf
 *   metadata/parquet/…, metadata/parquet_case_details/…, metadata/tar/…, data/tar/…   bulk archives (unused here)
 *
 * Focus bench folders observed for 2010–2026: 29_3 → karnataka_bng_old (Bengaluru), karhcdharwad, karhckalaburagi;
 * 36_29 → taphc; 28_2 → aphc. They match `datasetBench` in src/lib/india/courts.ts.
 *
 * Court identity comes only from `courtByDatasetCode`; an unknown code is kept as `unresolvedCourt` and the record
 * gets no court id (constitution §23: never the nearest court). The same applies to the bench folder.
 */
import { courtByDatasetCode, type Court } from "@/lib/india/courts";
import type { IndianCitation } from "@/lib/india/types";
import { clean, findHcNeutral, htmlText, isoDate, splitParties } from "./parse-util";
import type { JudgmentDraft } from "./sci";

export interface HcMetadataJson {
  court_code?: string;
  court_name?: string;
  raw_html?: string;
  pdf_link?: string;
  downloaded?: boolean;
}

export const HC_METADATA_PREFIX = "metadata/json/";

/** Coram entries that are roles or fora, never persons (kept verbatim in `coramRoles`). */
const CORAM_ROLES = /^(CHIEF JUSTICE|ACTING CHIEF JUSTICE|LOK ADALATH?|LOK ADALAT|REGISTRAR.*|VACATION (JUDGE|BENCH)|DIVISION BENCH|FULL BENCH)$/i;

export function hcCourtPrefix(year: number, datasetCode: string): string { return `${HC_METADATA_PREFIX}year=${year}/court=${datasetCode}/`; }
export function hcBenchPrefix(year: number, datasetCode: string, bench: string): string { return `${hcCourtPrefix(year, datasetCode)}bench=${bench}/`; }

export interface HcKeyParts { year?: number; courtCode?: string; bench?: string; basename: string }

export function parseHcKey(key: string): HcKeyParts {
  const year = /year=(\d{4})\//.exec(key)?.[1];
  const courtCode = /court=([0-9]+_[0-9]+)\//.exec(key)?.[1];
  const bench = /bench=([^/]+)\//.exec(key)?.[1];
  const basename = key.split("/").pop()!.replace(/\.(json|pdf)$/i, "");
  return { year: year ? Number(year) : undefined, courtCode, bench, basename };
}

/** Metadata key → PDF key (same partitioning under data/pdf/). */
export function hcPdfKey(metadataKey: string): string {
  return metadataKey.replace(/^metadata\/json\//, "data/pdf/").replace(/\.json$/i, ".pdf");
}

function cardField(html: string, label: string): string | undefined {
  const re = new RegExp(`${label}\\s*:\\s*</span>\\s*<font[^>]*>([\\s\\S]*?)</font>`, "i");
  const m = re.exec(html);
  return m ? clean(htmlText(m[1])) : undefined;
}

export interface HcParseResult {
  draft: JudgmentDraft;
  court: Court | null;
  pdfKey?: string;
}

/**
 * Parse one HC metadata record. `key` is the S3 metadata key (it carries year, court and bench partitions).
 * The dataset court code in the JSON wins over the key partition only when both are present and agree; when they
 * disagree the record is left unresolved and flagged.
 */
export function parseHcMetadata(json: HcMetadataJson, opts: { key: string; bucketUrl?: string }): HcParseResult {
  const html = json.raw_html ?? "";
  const parts = parseHcKey(opts.key);
  const issues: string[] = [];
  const jsonCode = clean(json.court_code)?.replace("~", "_");
  const keyCode = parts.courtCode;
  let rawCode = jsonCode ?? keyCode;
  if (jsonCode && keyCode && jsonCode !== keyCode) { issues.push(`Court code ${json.court_code} disagrees with the dataset folder court=${keyCode}`); rawCode = undefined; }
  const court = rawCode ? courtByDatasetCode(rawCode) : null;
  if (!court) issues.push(`Court code ${json.court_code ?? keyCode ?? "(missing)"} is not in the court registry`);
  const bench = court && parts.bench ? court.benches.find((b) => b.datasetBench === parts.bench) : undefined;
  if (court && parts.bench && !bench) issues.push(`Bench folder ${parts.bench} is not registered for ${court.shortName}`);

  const heading = clean(htmlText(/<font size='?3'?>([\s\S]*?)<\/button>/i.exec(html)?.[1]));
  // "WP/98/2024 of SRI SHADAKSHARI K N Vs THE STATE OF KARNATAKA"
  const hm = heading ? /^(\S+\/\d+\/\d{4})\s+of\s+([\s\S]+)$/i.exec(heading) : null;
  const caseNumber = hm?.[1];
  const caseType = caseNumber?.split("/")[0];
  const title = clean(hm?.[2]) ?? heading ?? `${court?.shortName ?? "High Court"} judgment ${parts.basename}`;
  const parties = splitParties(title);

  const coram = (clean(htmlText(/Judge\s*:\s*([^<]*)<\/strong>/i.exec(html)?.[1])) ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const judges = coram.filter((c) => !CORAM_ROLES.test(c));
  const coramRoles = coram.filter((c) => CORAM_ROLES.test(c));
  const benchStrength = coram.filter((c) => !/^LOK ADALATH?$|^LOK ADALAT$/i.test(c)).length || undefined;

  const snippet = clean(htmlText(/Judge\s*:[^<]*<\/strong>\s*<br>([\s\S]*?)<br>\s*<strong class='caseDetailsTD'/i.exec(html)?.[1]));
  const cnr = cardField(html, "CNR");
  const registrationDate = isoDate(cardField(html, "Date of registration"));
  const decisionDate = isoDate(cardField(html, "Decision Date")) ?? isoDate(/_(\d{4}-\d{2}-\d{2})$/.exec(parts.basename)?.[1]);
  const disposal = cardField(html, "Disposal Nature");
  const prefixes = court?.neutralCitationPrefix ? [court.neutralCitationPrefix] : [];
  const neutral = snippet ? findHcNeutral(snippet, prefixes) : undefined;

  const citations: IndianCitation[] = [];
  if (neutral) citations.push({ raw: neutral, kind: "neutral", neutral, year: Number(neutral.slice(0, 4)), courtId: court?.id });
  if (caseNumber) citations.push({ raw: caseNumber, kind: "case_number", caseNumber, courtId: court?.id });
  if (cnr) citations.push({ raw: cnr, kind: "cnr", cnr, courtId: court?.id });

  const pdfKey = hcPdfKey(opts.key);
  const url = opts.bucketUrl ? `${opts.bucketUrl}/${pdfKey.split("/").map((p) => encodeURIComponent(p).replace(/%3D/g, "=")).join("/")}` : undefined;
  if (!decisionDate) issues.push("Decision date not present in the source metadata");

  return {
    court,
    pdfKey,
    draft: {
      source: "hc-open-data",
      externalId: `${keyCode ?? rawCode ?? "unknown"}/${parts.bench ?? "unknown"}/${parts.basename}`,
      courtId: court?.id ?? null,
      unresolvedCourt: court ? undefined : clean(json.court_code) ?? keyCode ?? "unknown",
      benchId: bench?.id,
      unresolvedBench: court && parts.bench && !bench ? parts.bench : undefined,
      title,
      petitioner: parties.petitioner,
      respondent: parties.respondent,
      caseNumber,
      caseType,
      cnr,
      neutralCitation: neutral,
      citations,
      judges,
      coramRoles: coramRoles.length ? coramRoles : undefined,
      benchStrength,
      decisionDate,
      registrationDate,
      disposal,
      language: "en",
      translations: [],
      pdfUrl: url,
      statutes: [],
      headnote: snippet,
      datasetKey: opts.key,
      issues: issues.length ? issues : undefined,
      license: "AWS Open Data Registry: indian-high-court-judgments (see the dataset licence in the registry entry)",
    },
  };
}
