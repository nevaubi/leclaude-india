import "server-only";
import { courtById } from "@/lib/india/courts";
import { defaultLanguageForScript, detectScript, type LocaleCode } from "@/lib/india/languages";
import type { AdapterContext } from "@/modules/intel/adapters/types";
import { extractIntelText } from "@/modules/intel/extract";
import type { IntelEntityMention, IntelFlag } from "@/modules/intel/types";
import { findHcNeutral } from "./parse-util";
import type { JudgmentDraft } from "./sci";
import { putOriginalFile, upsertJudgment } from "./store";
import type { StoredJudgment } from "./types";

/**
 * Shared judgment ingestion: original PDF → content-addressed blob (sha256) → text extraction (pdfjs text layer,
 * page markers kept) → intel document (chunked, keyword/vector indexed, searchable) → judgment record linked to the
 * intel document. The original-language text is the text of record; nothing is machine-translated here.
 */
export interface JudgmentFile {
  bytes: Uint8Array;
  name: string;
  mime?: string;
}

export interface IngestJudgmentOptions {
  file?: JudgmentFile | null;
  /** Text supplied by a provider (Indian Kanoon HTML → text, export files) when there is no PDF. */
  text?: string;
  textMethod?: StoredJudgment["textMethod"];
  sourceEtag?: string;
  sourceModified?: string;
  /** Extra reasons the record needs review. */
  issues?: string[];
  matterIds?: string[];
  tags?: string[];
}

export interface IngestJudgmentResult {
  judgment: StoredJudgment;
  status: "added" | "updated" | "unchanged";
  textChars: number;
}

/** Share of non-Latin script characters above which the text of record is taken to be in that script's language. */
const SCRIPT_SHARE = 0.4;

export function languageOfText(text: string, fallback: LocaleCode): LocaleCode {
  const sample = text.slice(0, 20_000);
  const script = detectScript(sample);
  if (!script || script === "Latin") return fallback;
  const letters = (sample.match(/\p{L}/gu) ?? []).length || 1;
  const latin = (sample.match(/[A-Za-z]/g) ?? []).length;
  return 1 - latin / letters >= SCRIPT_SHARE ? defaultLanguageForScript(script) : fallback;
}

/**
 * Deterministic readability gate for an extracted text layer: enough letters, and letters make up most of the visible
 * characters (page markers excluded). Scripts are counted through Unicode letter classes, so Kannada/Telugu text passes.
 */
export function textQuality(text: string): { readable: boolean; letters: number; visible: number } {
  const body = text.replace(/\[Page \d+\]/g, "");
  const visible = (body.match(/\S/gu) ?? []).length;
  const letters = (body.match(/[\p{L}\p{M}]/gu) ?? []).length;
  return { readable: letters >= 40 && letters / Math.max(1, visible) >= 0.5, letters, visible };
}

function header(d: JudgmentDraft, courtName: string | undefined): string {
  const lines = [
    d.title,
    courtName ?? (d.unresolvedCourt ? `Court (unresolved code ${d.unresolvedCourt})` : undefined),
    d.neutralCitation ? `Neutral citation: ${d.neutralCitation}` : undefined,
    d.caseNumber ? `Case: ${d.caseNumber}` : undefined,
    d.cnr ? `CNR: ${d.cnr}` : undefined,
    d.decisionDate ? `Decided: ${d.decisionDate}` : undefined,
    d.judges.length ? `Coram: ${d.judges.join(", ")}` : undefined,
    d.disposal ? `Disposal: ${d.disposal}` : undefined,
  ];
  return lines.filter(Boolean).join("\n");
}

export async function ingestJudgment(ctx: AdapterContext<unknown>, draft: JudgmentDraft, o: IngestJudgmentOptions = {}): Promise<IngestJudgmentResult> {
  const now = ctx.now;
  const issues = [...(draft.issues ?? []), ...(o.issues ?? [])];
  const flags: IntelFlag[] = [];
  let body = (o.text ?? "").trim();
  let textMethod: StoredJudgment["textMethod"] = body ? o.textMethod ?? "text" : "none";
  let pages: number | undefined;
  let pdfBlobId: string | undefined;
  let sha: string | undefined;

  if (o.file) {
    const stored = putOriginalFile(o.file.bytes, o.file.mime ?? "application/pdf", { name: o.file.name, source: draft.source, externalId: draft.externalId });
    pdfBlobId = stored.blobId;
    sha = stored.sha256;
    const ex = await extractIntelText(o.file.bytes, o.file.name, o.file.mime ?? "application/pdf");
    pages = ex.pages;
    const quality = ex.method === "none" ? null : textQuality(ex.text);
    if (ex.method === "none" || !ex.text.trim()) {
      issues.push(ex.warning ?? "No text layer in the PDF (scanned); OCR is required before the text can be read");
      flags.push({ kind: "parse_error", note: ex.warning ?? "PDF has no text layer", at: now.toISOString(), by: draft.source });
    } else if (quality && !quality.readable) {
      // Fonts without a Unicode map (common in court PDFs typeset with legacy Indic fonts) yield glyph garbage: never index it as text of record.
      issues.push(`PDF text layer is unreadable (${quality.letters} letters in ${quality.visible} visible characters); OCR is required before the text can be read`);
      flags.push({ kind: "parse_error", note: "PDF text layer unreadable (font without Unicode mapping); OCR required", at: now.toISOString(), by: draft.source });
    } else {
      body = ex.text;
      textMethod = ex.method === "pdfjs" ? "pdfjs" : ex.method === "html" ? "html" : "text";
      if (ex.truncated) issues.push("Extracted text truncated at the extraction limit");
    }
  } else if (!body) {
    issues.push("Full text not available; only the source metadata was stored");
  }

  const court = courtById(draft.courtId);
  let neutral = draft.neutralCitation;
  const citations = [...draft.citations];
  if (!neutral && court?.neutralCitationPrefix && court.level === "high" && body) {
    // HC neutral citations are printed at the top of the judgment; accept only the registry prefix for this court.
    neutral = findHcNeutral(body.slice(0, 4000), [court.neutralCitationPrefix]);
    if (neutral) citations.unshift({ raw: neutral, kind: "neutral", neutral, year: Number(neutral.slice(0, 4)), courtId: court.id });
  }
  const language = body ? languageOfText(body, draft.language) : draft.language;
  if (!court) flags.push({ kind: "needs_review", note: `Court not resolved (${draft.unresolvedCourt ?? "unknown"}); not attributed to any registry court`, at: now.toISOString(), by: draft.source });
  if (textMethod === "none" && !flags.some((f) => f.kind === "parse_error")) flags.push({ kind: "needs_review", note: "Metadata only; full text unavailable", at: now.toISOString(), by: draft.source });

  const text = `${header({ ...draft, neutralCitation: neutral }, court?.name)}\n\n${body || draft.headnote || ""}`.trim();
  const entities: IntelEntityMention[] = [
    ...draft.judges.map((name) => ({ type: "judge" as const, name, role: name === draft.author ? "author" : "coram" })),
    ...(draft.petitioner ? [{ type: "party" as const, name: draft.petitioner, role: "petitioner" }] : []),
    ...(draft.respondent ? [{ type: "party" as const, name: draft.respondent, role: "respondent" }] : []),
    ...(court ? [{ type: "court" as const, name: court.name, externalId: court.id }] : []),
  ];

  const r = await ctx.ingest({
    kind: "opinion",
    title: draft.title,
    summary: draft.headnote?.slice(0, 800),
    jurisdiction: court ? (court.level === "supreme" ? "IN" : `IN-${court.territory[0]}`) : undefined,
    court: court?.name,
    courtId: court?.id,
    docketNumber: draft.caseNumber,
    caseName: draft.title,
    citation: neutral ?? citations.find((c) => c.kind === "reporter")?.raw,
    dates: { decided: draft.decisionDate, filed: draft.registrationDate },
    url: draft.pdfUrl,
    externalId: `${draft.source}:${draft.externalId}`,
    text,
    tags: ["india", draft.source, ...(court ? [court.id] : ["unresolved-court"]), ...(draft.benchId ? [draft.benchId] : []), ...(o.tags ?? [])],
    matterIds: o.matterIds,
    flags,
    confidence: court && textMethod !== "none" ? 0.9 : 0.6,
    entities,
    meta: {
      india: true,
      source: draft.source,
      datasetKey: draft.datasetKey,
      courtId: draft.courtId,
      unresolvedCourt: draft.unresolvedCourt,
      benchId: draft.benchId,
      unresolvedBench: draft.unresolvedBench,
      cnr: draft.cnr,
      neutralCitation: neutral,
      caseNumber: draft.caseNumber,
      caseType: draft.caseType,
      judges: draft.judges,
      coramRoles: draft.coramRoles,
      author: draft.author,
      benchStrength: draft.benchStrength,
      disposal: draft.disposal,
      language,
      translations: draft.translations,
      pdfBlobId,
      sha256: sha,
      textMethod,
      pages,
    },
  });

  const judgment = upsertJudgment({
    ...draft,
    neutralCitation: neutral,
    citations,
    language,
    pdfBlobId,
    sha256: sha,
    textChars: textMethod === "none" ? 0 : body.length,
    textMethod,
    pages,
    intelDocId: r.doc.id,
    sourceEtag: o.sourceEtag,
    sourceModified: o.sourceModified,
    issues: issues.length ? Array.from(new Set(issues)) : undefined,
    retrievedAt: now.toISOString(),
  }, now);
  return { judgment, status: r.status, textChars: judgment.textChars ?? 0 };
}
