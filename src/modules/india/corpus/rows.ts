import "server-only";
import { createHash } from "node:crypto";
import { HC_BUCKET_URL, SCI_BUCKET_URL } from "../sources/s3";
import { parseHcMetadata, type HcMetadataJson } from "../sources/hc";
import { parseSciMetadata, type SciMetadataJson } from "../sources/sci";

/** A source archive: one year of Supreme Court metadata, or one year of one High Court bench. */
export interface CorpusUnitRef {
  id: string;
  source: "sci-open-data" | "hc-open-data";
  year: number;
  courtCode?: string | null;
  benchCode?: string | null;
}

export interface CorpusRow {
  id: string;
  source: string;
  unit_id: string;
  dataset_key: string;
  court_id: string | null;
  court_code: string | null;
  bench_id: string | null;
  bench_code: string | null;
  year: number | null;
  title: string;
  petitioner: string | null;
  respondent: string | null;
  case_number: string | null;
  case_type: string | null;
  cnr: string | null;
  neutral_citation: string | null;
  reporter_citation: string | null;
  judges: string[];
  judges_text: string | null;
  author: string | null;
  bench_strength: number | null;
  decision_date: string | null;
  registration_date: string | null;
  disposal: string | null;
  language: string;
  translations: unknown;
  pdf_key: string | null;
  pdf_url: string | null;
  snippet: string | null;
  issues: string[] | null;
  record_sha256: string;
}

export type EntryResult = { ok: true; row: CorpusRow } | { ok: false; reason: string };

const MAX_SNIPPET = 1500;

const basename = (name: string) => name.split("/").pop() ?? name;
const n = <T>(v: T | undefined | null): T | null => (v === undefined || v === "" ? null : v);
const isoOrNull = (v: string | undefined) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
/**
 * The judgment's own year (decision date), not the dataset folder it was listed in: the Supreme Court dataset lists some
 * judgments under two adjacent years with identical metadata, and the row must not depend on which folder was read last.
 */
const yearOf = (decisionDate: string | undefined, folderYear: number) => (decisionDate && /^\d{4}-/.test(decisionDate) ? Number(decisionDate.slice(0, 4)) : folderYear);

/** The per-record metadata key the dataset's JSON layout uses (the parsers read year, court and bench from it). */
export function jsonKeyFor(unit: CorpusUnitRef, entryName: string): string {
  const file = basename(entryName);
  return unit.source === "sci-open-data"
    ? `metadata/json/year=${unit.year}/${file}`
    : `metadata/json/year=${unit.year}/court=${unit.courtCode}/bench=${unit.benchCode}/${file}`;
}

/**
 * Parse one archive entry into a corpus row with the existing, registry-backed parsers. Nothing is guessed: an unknown
 * court stays unresolved (court_id null, the raw code kept), a missing date stays null, and the parser's review
 * reasons are kept in `issues`.
 */
export function rowFromEntry(unit: CorpusUnitRef, entryName: string, data: Uint8Array): EntryResult {
  if (!entryName.toLowerCase().endsWith(".json")) return { ok: false, reason: "not a JSON metadata record" };
  let json: unknown;
  try { json = JSON.parse(new TextDecoder("utf-8").decode(data)); } catch (e) { return { ok: false, reason: `invalid JSON: ${(e as Error).message.slice(0, 120)}` }; }
  if (!json || typeof json !== "object") return { ok: false, reason: "metadata is not an object" };
  const key = jsonKeyFor(unit, entryName);
  const sha = createHash("sha256").update(data).digest("hex");
  try {
    if (unit.source === "sci-open-data") {
      const { draft, englishPdfKey } = parseSciMetadata(json as SciMetadataJson, { key, bucketUrl: SCI_BUCKET_URL });
      const reporter = draft.citations.find((c) => c.kind === "reporter")?.raw;
      return {
        ok: true,
        row: {
          id: `sc:${draft.externalId}`,
          source: draft.source,
          unit_id: unit.id,
          dataset_key: key,
          court_id: draft.courtId,
          court_code: null,
          bench_id: n(draft.benchId),
          bench_code: null,
          year: yearOf(draft.decisionDate, unit.year),
          title: draft.title,
          petitioner: n(draft.petitioner),
          respondent: n(draft.respondent),
          case_number: n(draft.caseNumber),
          case_type: n(draft.caseType),
          cnr: n(draft.cnr),
          neutral_citation: n(draft.neutralCitation),
          reporter_citation: n(reporter),
          judges: draft.judges,
          judges_text: draft.judges.length ? draft.judges.join(" ; ") : null,
          author: n(draft.author),
          bench_strength: n(draft.benchStrength),
          decision_date: isoOrNull(draft.decisionDate),
          registration_date: isoOrNull(draft.registrationDate),
          disposal: n(draft.disposal),
          language: draft.language,
          translations: draft.translations.length ? draft.translations : null,
          pdf_key: englishPdfKey,
          pdf_url: n(draft.pdfUrl),
          snippet: draft.headnote ? draft.headnote.slice(0, MAX_SNIPPET) : null,
          issues: draft.issues?.length ? draft.issues : null,
          record_sha256: sha,
        },
      };
    }
    const { draft, pdfKey } = parseHcMetadata(json as HcMetadataJson, { key, bucketUrl: HC_BUCKET_URL });
    return {
      ok: true,
      row: {
        id: `hc:${draft.externalId}`,
        source: draft.source,
        unit_id: unit.id,
        dataset_key: key,
        court_id: draft.courtId,
        court_code: unit.courtCode ?? null,
        bench_id: n(draft.benchId),
        bench_code: unit.benchCode ?? null,
        year: yearOf(draft.decisionDate, unit.year),
        title: draft.title,
        petitioner: n(draft.petitioner),
        respondent: n(draft.respondent),
        case_number: n(draft.caseNumber),
        case_type: n(draft.caseType),
        cnr: n(draft.cnr),
        neutral_citation: n(draft.neutralCitation),
        reporter_citation: null,
        judges: draft.judges,
        judges_text: draft.judges.length ? draft.judges.join(" ; ") : null,
        author: null,
        bench_strength: n(draft.benchStrength),
        decision_date: isoOrNull(draft.decisionDate),
        registration_date: isoOrNull(draft.registrationDate),
        disposal: n(draft.disposal),
        language: draft.language,
        translations: null,
        pdf_key: n(pdfKey),
        pdf_url: n(draft.pdfUrl),
        snippet: draft.headnote ? draft.headnote.slice(0, MAX_SNIPPET) : null,
        // Bench folders outside the focus courts are not in the registry yet; the raw bench code is kept, and that is
        // not a defect of the record, so that one reason is not repeated on every row.
        issues: (draft.issues ?? []).filter((i) => !/^Bench folder .* is not registered/.test(i)).length ? (draft.issues ?? []).filter((i) => !/^Bench folder .* is not registered/.test(i)) : null,
        record_sha256: sha,
      },
    };
  } catch (e) {
    return { ok: false, reason: `parse failed: ${(e as Error).message.slice(0, 160)}` };
  }
}

/** Column order used by the bulk upsert (jsonb_to_recordset). */
export const CORPUS_COLUMNS: [keyof CorpusRow, string][] = [
  ["id", "text"], ["source", "text"], ["unit_id", "text"], ["dataset_key", "text"], ["court_id", "text"], ["court_code", "text"],
  ["bench_id", "text"], ["bench_code", "text"], ["year", "int"], ["title", "text"], ["petitioner", "text"], ["respondent", "text"],
  ["case_number", "text"], ["case_type", "text"], ["cnr", "text"], ["neutral_citation", "text"], ["reporter_citation", "text"],
  ["judges", "text[]"], ["judges_text", "text"], ["author", "text"], ["bench_strength", "int"], ["decision_date", "date"],
  ["registration_date", "date"], ["disposal", "text"], ["language", "text"], ["translations", "jsonb"], ["pdf_key", "text"],
  ["pdf_url", "text"], ["snippet", "text"], ["issues", "text[]"], ["record_sha256", "text"],
];

/**
 * One statement that upserts a batch of rows passed as a single JSON parameter. A row whose record hash is unchanged
 * is left untouched (no rewrite, no index churn). Returns the number of rows inserted or changed.
 */
export function upsertSql(): string {
  const cols = CORPUS_COLUMNS.map(([c]) => c);
  const defs = CORPUS_COLUMNS.map(([c, t]) => `${c} ${t}`).join(", ");
  const updates = cols.filter((c) => c !== "id").map((c) => `${c} = EXCLUDED.${c}`).join(", ");
  return `WITH ins AS (
    INSERT INTO corpus_judgments (${cols.join(", ")})
    SELECT ${cols.join(", ")} FROM jsonb_to_recordset($1::jsonb) AS x(${defs})
    ON CONFLICT (id) DO UPDATE SET ${updates}, updated_at = now()
    WHERE corpus_judgments.record_sha256 IS DISTINCT FROM EXCLUDED.record_sha256
    RETURNING 1
  ) SELECT count(*)::int AS n FROM ins`;
}
