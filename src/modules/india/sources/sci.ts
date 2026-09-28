/**
 * Supreme Court of India judgments — AWS Open Data `indian-supreme-court-judgments` (pure parser, no I/O).
 *
 * Layout (verified against the live bucket, September 2026):
 *   metadata/json/year=YYYY/<path>.json            { path, citation_year, nc_display, scraped_at, raw_html }
 *   data/pdf/year=YYYY/english/<path>_EN.pdf       English judgment (text of record)
 *   data/pdf/year=YYYY/regional/<path>_<LANG>.pdf  court-published translations (HIN, KAN, TEL, PUN, …)
 *   data/tar/…, metadata/tar/…, metadata/parquet/… bulk archives (not used by the incremental path)
 *
 * `raw_html` is the court portal's result card: title (aria-label), eSCR citation, neutral citation, eSCR CNR,
 * coram (author marked with an asterisk), headnote extract, decision date, case number, disposal and bench size, and a
 * language <select> listing the published translations. Every field is parsed deterministically; a field that is not
 * present stays undefined.
 */
import { languageBySciCode, type LocaleCode } from "@/lib/india/languages";
import type { IndianCitation } from "@/lib/india/types";
import { SUPREME_COURT } from "@/lib/india/courts";
import { clean, htmlText, isoDate, normalizeNeutral, splitParties } from "./parse-util";
import type { StoredJudgment } from "./types";

export interface SciMetadataJson {
  path: string;
  citation_year?: string | number;
  nc_display?: string;
  scraped_at?: string;
  raw_html?: string;
}

export type JudgmentDraft = Omit<StoredJudgment, "id" | "retrievedAt" | "updatedAt">;

export const SCI_METADATA_PREFIX = "metadata/json/";

export function sciMetadataPrefix(year: number): string { return `${SCI_METADATA_PREFIX}year=${year}/`; }
export function sciEnglishPdfKey(year: number | string, path: string): string { return `data/pdf/year=${year}/english/${path}_EN.pdf`; }
export function sciRegionalPdfKey(year: number | string, path: string, code: string): string { return `data/pdf/year=${year}/regional/${path}_${code.toUpperCase()}.pdf`; }

/** Year folder of a metadata key (`metadata/json/year=2024/…`). */
export function yearOfKey(key: string): number | undefined {
  const m = /year=(\d{4})\//.exec(key);
  return m ? Number(m[1]) : undefined;
}

/** eSCR reporter citation "[2024] 10 S.C.R. 108" → structured citation. */
export function parseScrCitation(raw: string | undefined): IndianCitation | undefined {
  const s = clean(raw);
  if (!s) return undefined;
  const m = /^\[(\d{4})\]\s+(\d+)\s+S\.?\s?C\.?\s?R\.?\s+(\d+)$/i.exec(s);
  if (!m) return { raw: s, kind: "unknown" };
  return { raw: s, kind: "reporter", reporter: "SCR", year: Number(m[1]), volume: Number(m[2]), page: Number(m[3]), courtId: SUPREME_COURT.id };
}

/** Value that follows a `<span …> Label :</span><font …> value</font>` pair in the result card. */
function cardField(html: string, label: string): string | undefined {
  const re = new RegExp(`${label}\\s*:\\s*</span>\\s*<font[^>]*>([\\s\\S]*?)</font>`, "i");
  const m = re.exec(html);
  return m ? clean(htmlText(m[1])) : undefined;
}

export interface SciParseResult {
  draft: JudgmentDraft;
  /** Translation codes present in the portal that the language registry does not know (kept for review, never mapped). */
  unmappedLanguages: string[];
  englishPdfKey: string;
}

export function parseSciMetadata(json: SciMetadataJson, opts: { key?: string; bucketUrl?: string } = {}): SciParseResult {
  const html = json.raw_html ?? "";
  const path = String(json.path ?? "").trim();
  if (!path) throw new Error("SC metadata has no path");
  const year = String(json.citation_year ?? (opts.key ? yearOfKey(opts.key) : "") ?? "").trim() || path.slice(0, 4);
  const url = (key: string) => (opts.bucketUrl ? `${opts.bucketUrl}/${key.split("/").map((p) => encodeURIComponent(p).replace(/%3D/g, "=")).join("/")}` : undefined);

  const aria = /aria-label="\s*([^"]*?)\s+pdf"/i.exec(html)?.[1];
  const strongTitle = /<font size='?4'?>\s*<strong>([\s\S]*?)<\/strong>/i.exec(html)?.[1];
  const title = clean(htmlText(aria)) ?? clean(htmlText(strongTitle)) ?? `Supreme Court judgment ${path}`;
  const parties = splitParties(clean(htmlText(strongTitle)) ?? title);

  const neutral = normalizeNeutral(/<span class='ncDisplay'>([^<]+)<\/span>/i.exec(html)?.[1] ?? json.nc_display);
  const scr = parseScrCitation(htmlText(/<span class='escrText'>([^<]+)<\/span>/i.exec(html)?.[1]));
  const cnr = clean(/id='cnr'\s+value=['"]?([A-Z0-9]+)/i.exec(html)?.[1]);

  // Coram: "BELA M. TRIVEDI<sup …>*</sup>, SATISH CHANDRA SHARMA" — the asterisk marks the author.
  const coramHtml = /Coram\s*:\s*([\s\S]*?)<\/strong>/i.exec(html)?.[1] ?? "";
  let author: string | undefined;
  const judges = coramHtml.split(/,(?![^<]*>)/).map((part) => {
    const isAuthor = /data-tooltip="Author"|>\s*\*\s*</i.test(part);
    const name = clean(htmlText(part.replace(/<sup[\s\S]*?<\/sup>/gi, "")).replace(/\*/g, ""));
    if (isAuthor && name) author = name;
    return name;
  }).filter((n): n is string => Boolean(n));

  const headnoteHtml = /Coram\s*:[\s\S]*?<\/strong>\s*<br>([\s\S]*?)<br>\s*<strong class='caseDetailsTD'/i.exec(html)?.[1];
  const headnote = clean(htmlText(headnoteHtml));

  const decisionDate = isoDate(cardField(html, "Decision Date"));
  const caseNumber = cardField(html, "Case No");
  const disposal = cardField(html, "Disposal Nature");
  const benchRaw = cardField(html, "Bench");
  const benchStrength = benchRaw && /^(\d+)\s+Judges?$/i.test(benchRaw) ? Number(/^(\d+)/.exec(benchRaw)![1]) : judges.length || undefined;
  const caseType = caseNumber ? clean(/^(.*?)\s+No\.?\s*\d/i.exec(caseNumber)?.[1]) : undefined;

  const translations: JudgmentDraft["translations"] = [];
  const unmappedLanguages: string[] = [];
  const select = /<select[^>]*name='language'[^>]*>([\s\S]*?)<\/select>/i.exec(html)?.[1] ?? "";
  for (const m of select.matchAll(/<option value='([A-Z]*)'>/gi)) {
    const code = m[1].toUpperCase();
    if (!code) continue; // "" is the English original
    const lang = languageBySciCode(code);
    if (!lang) { unmappedLanguages.push(code); continue; }
    if (lang.code === "en" || translations.some((t) => t.language === lang.code)) continue;
    translations.push({ language: lang.code as LocaleCode, origin: "court_published", url: url(sciRegionalPdfKey(year, path, code)) });
  }

  const citations: IndianCitation[] = [];
  if (neutral) citations.push({ raw: neutral, kind: "neutral", neutral, year: Number(neutral.slice(0, 4)), courtId: SUPREME_COURT.id });
  if (scr) citations.push(scr);
  if (caseNumber) citations.push({ raw: caseNumber, kind: "case_number", caseNumber, courtId: SUPREME_COURT.id });

  const englishPdfKey = sciEnglishPdfKey(year, path);
  const issues: string[] = [];
  if (unmappedLanguages.length) issues.push(`Translations in unregistered languages: ${unmappedLanguages.join(", ")}`);
  if (!decisionDate) issues.push("Decision date not present in the source metadata");

  return {
    englishPdfKey,
    unmappedLanguages,
    draft: {
      source: "sci-open-data",
      externalId: path,
      courtId: SUPREME_COURT.id,
      benchId: SUPREME_COURT.benches[0]?.id,
      title,
      petitioner: parties.petitioner,
      respondent: parties.respondent,
      caseNumber,
      caseType,
      cnr,
      neutralCitation: neutral,
      citations,
      judges,
      author,
      benchStrength,
      decisionDate,
      disposal,
      language: "en",
      translations,
      pdfUrl: url(englishPdfKey),
      statutes: [],
      headnote,
      datasetKey: opts.key,
      issues: issues.length ? issues : undefined,
      license: "AWS Open Data Registry: indian-supreme-court-judgments (see the dataset licence in the registry entry)",
    },
  };
}
