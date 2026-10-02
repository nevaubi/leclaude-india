import "server-only";
import { db } from "@/lib/db";
import { generateJSON, generateText } from "@/lib/ai/agent";
import { aiBudget, aiConfig, AIConfigError } from "@/lib/ai/config";
import { mapPool } from "@/lib/ai/pool";
import { FIRM_NAME, LEGAL_STYLE_RULES, todayLine } from "@/lib/ai/prompts";
import { crossCheckCitations, applyCiteCheck } from "@/lib/ai/verify";
import { audit } from "@/lib/integrity/audit";
import { attachProvenance, documentSources, recordGeneration, verifyStructured } from "@/lib/integrity/record";
import { getProvenance } from "@/lib/integrity/store";
import { gateReview, isTrusted } from "@/lib/integrity/provenance";
import { CONFIDENCE_GATE, type Provenance } from "@/lib/integrity/types";
import type { EDocument, IssueCode } from "@/lib/types/domain";
import type { AIAnalysis, PredictProgressEvent } from "./types";
import { getCodingRules, listIssueCodes, matterDocs, upsertPrivilegeEntry, privilegedDocsWithoutEntry, generatePrivilegeLogTemplate } from "./service";
import { templatePrivilegeDescription } from "./privilege";
import { quoteConfidenceCap, verifyQuotes } from "./quotes";

const ANALYSIS_KEY = (docId: string) => `ediscovery:analysis:${docId}`;
/** Characters of a document given to the per-document analysis: the `ediscovery_doc` budget (never below 24,000). */
function maxText(): number {
  return Math.max(24_000, aiBudget("ediscovery_doc").perSourceChars);
}

export { AIConfigError };

/** Analysis as stored and returned by the API: the review plus its provenance (TrustBadge reads `provenance`). */
export type AIAnalysisRecord = AIAnalysis & { provenance?: Provenance };

function clip(text: string, n = maxText()) {
  return text.length > n ? text.slice(0, n) + "\n…[truncated]" : text;
}

function issueRubric(codes: IssueCode[]) {
  return codes.map((c) => `- ${c.code} — ${c.label}${c.description ? `: ${c.description}` : ""}`).join("\n");
}

function docHeader(d: EDocument) {
  return [`Bates: ${d.bates}${d.batesEnd ? ` – ${d.batesEnd}` : ""}`, `Date: ${d.date}`, `Type: ${d.type}`, `Custodian: ${d.custodianName}`, d.from ? `From: ${d.from}` : null, d.to?.length ? `To: ${d.to.join("; ")}` : null, d.cc?.length ? `Cc: ${d.cc.join("; ")}` : null, `Subject: ${d.subject}`].filter(Boolean).join("\n");
}

const docHref = (d: EDocument) => `/ediscovery?matter=${d.matterId}&doc=${d.id}`;

// ---------------------------------------------------------------------------
// Single-document analysis
// ---------------------------------------------------------------------------

const ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string", description: "3–5 sentence neutral summary written for a litigator. Cite the Bates number." },
    keyIssues: { type: "array", items: { type: "string" }, description: "Up to 6 short bullet points: the facts or statements in this document that matter for the case." },
    entities: {
      type: "object",
      properties: {
        people: { type: "array", items: { type: "string" } },
        orgs: { type: "array", items: { type: "string" } },
        places: { type: "array", items: { type: "string" } },
        chemicals: { type: "array", items: { type: "string" } },
      },
      required: ["people", "orgs", "places", "chemicals"],
    },
    suggestedCoding: {
      type: "object",
      properties: {
        responsive: { type: "boolean" },
        responsiveConfidence: { type: "integer", description: "0–100" },
        privileged: { type: "boolean" },
        privilegedConfidence: { type: "integer", description: "0–100" },
        privilegeBasis: { type: "string", enum: ["attorney-client", "work-product", "common-interest", "joint-defense", "none"] },
        hot: { type: "boolean" },
        issues: { type: "array", items: { type: "string" }, description: "Issue codes from the rubric, exact codes only." },
        rationale: { type: "string", description: "2–4 sentences explaining the suggested coding with reference to the protocol." },
      },
      required: ["responsive", "responsiveConfidence", "privileged", "privilegedConfidence", "privilegeBasis", "hot", "issues", "rationale"],
    },
    privilegeRisk: { type: "string", description: "One sentence on privilege risk (waiver, crime-fraud, dual-purpose) or 'None identified'." },
    supportingQuotes: { type: "array", items: { type: "string" }, description: "Up to 4 verbatim excerpts (8–30 words each, copied exactly from the document text) that support the suggested coding. Never paraphrase." },
    confidence: { type: "number", description: "0..1 calibrated confidence that the summary and coding suggestion are correct given the protocol and the text. Below 0.6 means a reviewer must look." },
  },
  required: ["summary", "keyIssues", "entities", "suggestedCoding", "privilegeRisk", "supportingQuotes", "confidence"],
};

const ANALYSIS_CHECK_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    keyIssues: { type: "array", items: { type: "string" } },
  },
  required: ["summary", "keyIssues"],
};

type RawAnalysis = Omit<AIAnalysis, "generatedAt" | "model" | "suggestedCoding" | "quotes"> & { suggestedCoding: Omit<AIAnalysis["suggestedCoding"], "privilegeBasis"> & { privilegeBasis: string }; supportingQuotes?: string[]; confidence: number };

export function cachedAnalysis(docId: string): AIAnalysisRecord | null {
  const a = db().kv.get<AIAnalysisRecord>(ANALYSIS_KEY(docId));
  if (!a) return null;
  if (!a.provenance) { const p = getProvenance("edoc.analysis", docId) ?? db().edocs.get(docId)?.aiProvenance; if (p) return { ...a, provenance: p }; }
  return a;
}

export interface AnalyzeOptions { force?: boolean; signal?: AbortSignal; /** Run the self-correction pass (default true). */ verify?: boolean }

export async function analyzeDocument(docId: string, opts: AnalyzeOptions = {}): Promise<AIAnalysisRecord> {
  const d = db().edocs.get(docId);
  if (!d) throw new Error(`No document ${docId}`);
  if (!opts.force) {
    const cached = cachedAnalysis(docId);
    if (cached) return cached;
  }
  const matter = db().matters.get(d.matterId);
  const codes = listIssueCodes(d.matterId);
  const rules = getCodingRules(d.matterId);
  const instructions = `You are a senior document-review attorney at ${FIRM_NAME} conducting first-level review in ${matter?.name ?? "a litigation matter"} (${matter?.caption ?? ""}). The firm represents ${matter?.client ?? "the client"} (${matter?.clientSide ?? "party"}).
${todayLine()}
${LEGAL_STYLE_RULES}

Apply the matter's coding protocol below strictly. Suggest issue codes only from the rubric. Be conservative on privilege: a lawyer on cc does not make a business document privileged. Mark hot only for documents likely to be used as exhibits. Report a calibrated confidence: lower it when the text is truncated, ambiguous, or the protocol does not squarely address it.

## Coding protocol
${rules}

## Issue code rubric
${issueRubric(codes)}`;
  const input = `Analyse the following document and return the structured review.\n\n${docHeader(d)}\n\n---\n${clip(d.text)}`;
  const raw = await generateJSON<RawAnalysis>({ fast: true, instructions, input, schema: ANALYSIS_SCHEMA, name: "document_analysis", maxOutputTokens: Math.max(1_800, aiBudget("ediscovery_doc").maxOutputTokens), signal: opts.signal });
  const valid = new Set(codes.map((c) => c.code));
  const model = aiConfig().fastModel;
  const generatedAt = new Date().toISOString();
  // Supporting excerpts are checked verbatim against the text: an excerpt that is not there is a fabrication signal.
  const quotes = verifyQuotes(d.text, raw.supportingQuotes ?? []);
  const { supportingQuotes: _sq, ...rawRest } = raw;
  void _sq;
  let analysis: AIAnalysisRecord = {
    ...rawRest,
    quotes,
    suggestedCoding: {
      ...raw.suggestedCoding,
      privilegeBasis: raw.suggestedCoding.privilegeBasis === "none" ? undefined : (raw.suggestedCoding.privilegeBasis as AIAnalysis["suggestedCoding"]["privilegeBasis"]),
      issues: raw.suggestedCoding.issues.filter((i) => valid.has(i)),
      responsiveConfidence: Math.max(0, Math.min(100, raw.suggestedCoding.responsiveConfidence)),
      privilegedConfidence: Math.max(0, Math.min(100, raw.suggestedCoding.privilegedConfidence)),
    },
    generatedAt,
    model,
  };
  delete (analysis as unknown as { confidence?: number }).confidence;
  // Provenance: the document itself is the only source; confidence is the model's own calibrated number,
  // lowered when the coding suggestion is internally inconsistent with the protocol (privileged without a basis).
  let confidence = Number.isFinite(raw.confidence) ? raw.confidence : Math.min(raw.suggestedCoding.responsiveConfidence, 100 - Math.abs(50 - raw.suggestedCoding.responsiveConfidence)) / 100;
  if (analysis.suggestedCoding.privileged && !analysis.suggestedCoding.privilegeBasis) confidence = Math.min(confidence, CONFIDENCE_GATE - 0.05);
  confidence = Math.min(confidence, quoteConfidenceCap(quotes));
  let provenance = recordGeneration({ surface: "ediscovery.analysis", instructions, input, sources: documentSources([d]), confidence, model, target: { kind: "edoc", id: d.id, label: d.bates, matterId: d.matterId }, meta: { responsive: analysis.suggestedCoding.responsive, privileged: analysis.suggestedCoding.privileged, issues: analysis.suggestedCoding.issues, rationale: analysis.suggestedCoding.rationale, quotes: quotes.length, unverifiedQuotes: quotes.filter((q) => !q.verified).length } });
  // Verification loop: the summary and key issues are re-read against the document text.
  const checked = await verifyStructured(provenance, { label: "document summary and key issues", output: { summary: analysis.summary, keyIssues: analysis.keyIssues }, evidence: `${docHeader(d)}\n\n${clip(d.text, Math.max(30_000, maxText()))}`, schema: ANALYSIS_CHECK_SCHEMA, verify: opts.verify, signal: opts.signal, count: (v) => 1 + v.keyIssues.length }, { kind: "edoc", id: d.id, label: d.bates, matterId: d.matterId });
  provenance = checked.provenance;
  analysis = { ...analysis, summary: checked.output.summary || analysis.summary, keyIssues: checked.output.keyIssues ?? analysis.keyIssues };
  const cite = crossCheckCitations(analysis.summary, { bates: [d.bates, ...(d.batesEnd ? [d.batesEnd] : [])] });
  if (cite.unresolved.length) { analysis.summary = cite.text; provenance = applyCiteCheck(provenance, cite); }
  provenance = gateReview(provenance);
  analysis.provenance = attachProvenance({ kind: "edoc.analysis", recordId: d.id, matterId: d.matterId, title: `${d.bates} — ${d.subject}`, href: docHref(d), provenance });
  db().kv.set(ANALYSIS_KEY(docId), analysis);
  db().edocs.update(docId, (cur) => ({
    ...cur,
    aiSummary: analysis.summary,
    aiIssues: analysis.suggestedCoding.issues,
    entities: analysis.entities,
    aiScore: analysis.suggestedCoding.responsive ? Math.max(50, analysis.suggestedCoding.responsiveConfidence) : Math.min(49, 100 - analysis.suggestedCoding.responsiveConfidence),
    aiProvenance: provenance,
  }));
  return analysis;
}

/**
 * Apply an AI coding suggestion to a document. Trusted suggestions become the
 * coding; untrusted ones (below the gate, contradicted, pending review) are
 * written into coding.notes as a suggestion and the document is flagged for
 * review instead. Used by the workflow executor and the "apply suggestion" API.
 */
export function applySuggestedCoding(docId: string, opts: { reviewerId?: string; force?: boolean } = {}): { applied: boolean; needsReview: boolean; reason: string; doc: EDocument | null } {
  const d = db().edocs.get(docId);
  const a = cachedAnalysis(docId);
  if (!d || !a) return { applied: false, needsReview: false, reason: a ? "document not found" : "no AI analysis cached for this document", doc: d };
  const trusted = opts.force || isTrusted(a.provenance);
  const s = a.suggestedCoding;
  const now = new Date().toISOString();
  const suggestion = `AI suggestion (${(a.provenance?.confidence != null ? Math.round(a.provenance.confidence * 100) : "—")}% confidence): ${s.responsive ? "responsive" : "non-responsive"}${s.privileged ? `, privileged (${s.privilegeBasis ?? "basis?"})` : ""}${s.hot ? ", hot" : ""}${s.issues.length ? `; issues ${s.issues.join(", ")}` : ""}. ${s.rationale}`;
  if (!trusted) {
    const note = `[${now.slice(0, 10)}] NEEDS REVIEW — ${suggestion}`;
    const next = db().edocs.put({ ...d, coding: { ...d.coding, notes: d.coding.notes?.includes(suggestion) ? d.coding.notes : `${d.coding.notes ? d.coding.notes + "\n" : ""}${note}` } });
    audit("coding.change", { kind: "edoc", id: d.id, label: d.bates, matterId: d.matterId }, { source: "ai-suggestion", applied: false, needsReview: true, confidence: a.provenance?.confidence, verification: a.provenance?.verification?.status });
    return { applied: false, needsReview: true, reason: "AI suggestion is not trusted (below the confidence gate, contradicted or pending review); written to notes for a reviewer", doc: next };
  }
  const coding: EDocument["coding"] = { ...d.coding, responsive: s.responsive, privileged: s.privileged, privilegeBasis: s.privileged ? s.privilegeBasis ?? d.coding.privilegeBasis ?? "attorney-client" : undefined, hot: s.hot, issues: Array.from(new Set([...(d.coding.issues ?? []), ...s.issues])), reviewerId: opts.reviewerId ?? "ai", reviewedAt: now, notes: `${d.coding.notes ? d.coding.notes + "\n" : ""}[${now.slice(0, 10)}] Applied ${suggestion}` };
  if (!coding.privileged) delete coding.privilegeBasis;
  const next = db().edocs.put({ ...d, coding });
  audit("coding.change", { kind: "edoc", id: d.id, label: d.bates, matterId: d.matterId }, { source: "ai-suggestion", applied: true, before: d.coding, after: coding, confidence: a.provenance?.confidence });
  return { applied: true, needsReview: false, reason: "trusted suggestion applied", doc: next };
}

// ---------------------------------------------------------------------------
// Batch responsiveness prediction (10 docs per call)
// ---------------------------------------------------------------------------

const BATCH_SCHEMA = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          score: { type: "integer", description: "0–100 probability that the document is responsive under the protocol" },
          issues: { type: "array", items: { type: "string" } },
          rationale: { type: "string", description: "One sentence." },
          confidence: { type: "number", description: "0..1 how confident you are in this score (not the score itself): lower for truncated, ambiguous or off-protocol documents" },
        },
        required: ["id", "score", "issues", "rationale", "confidence"],
      },
    },
  },
  required: ["results"],
};

export interface PredictOptions {
  matterId: string;
  ids?: string[];
  /** Re-score documents that already have an aiScore. */
  force?: boolean;
  batchSize?: number;
  signal?: AbortSignal;
  onEvent?: (e: PredictProgressEvent) => void;
}

export async function predictResponsiveness(opts: PredictOptions) {
  const t0 = Date.now();
  const emit = opts.onEvent ?? (() => {});
  if (!aiConfig().hasKey) throw new AIConfigError();
  const matter = db().matters.get(opts.matterId);
  const codes = listIssueCodes(opts.matterId);
  const rules = getCodingRules(opts.matterId);
  let docs = opts.ids?.length ? (opts.ids.map((id) => db().edocs.get(id)).filter(Boolean) as EDocument[]) : matterDocs(opts.matterId).filter((d) => d.coding.responsive == null);
  if (!opts.force) docs = docs.filter((d) => d.aiScore == null || opts.ids?.length);
  docs = docs.sort((a, b) => a.bates.localeCompare(b.bates));
  const total = docs.length;
  emit({ type: "start", total });
  const instructions = `You are a predictive-coding model for ${FIRM_NAME} in ${matter?.name ?? "a matter"}. For each document, estimate the probability (0–100) that a careful reviewer applying the protocol below would code it Responsive, and list the applicable issue codes from the rubric (exact codes only). Judge each document independently. Be calibrated: routine business, HR, pricing and social messages score low; documents squarely within the RFP topics score high. Also report, separately, your confidence (0..1) in the score.
${todayLine()}

## Coding protocol
${rules}

## Issue code rubric
${issueRubric(codes)}`;
  const valid = new Set(codes.map((c) => c.code));
  const size = Math.max(1, Math.min(20, opts.batchSize ?? 10));
  const model = aiConfig().fastModel;
  let done = 0;
  let scored = 0;
  let likelyResponsive = 0;
  let likelyNonResponsive = 0;
  let uncertain = 0;
  let belowGate = 0;
  // Batches run in parallel (bounded by the e-discovery batch budget); each batch is applied as soon as it returns.
  const budget = aiBudget("ediscovery_batch");
  const perDoc = Math.max(6_000, budget.perSourceChars);
  const batches: EDocument[][] = [];
  for (let i = 0; i < docs.length; i += size) batches.push(docs.slice(i, i + size));
  // Stop-on-failure: after a failed batch no further batch starts, the ones in flight are aborted (poolSignal), and a
  // batch whose model call returned after the failure writes nothing (the run fails; earlier batches stay written).
  await mapPool(batches, budget.concurrency, async (batch, _index, poolSignal) => {
    if (poolSignal.aborted) return;
    const input = batch.map((d, n) => `### Document ${n + 1} (id: ${d.id})\n${docHeader(d)}\n\n${clip(d.text, perDoc)}`).join("\n\n");
    const res = await generateJSON<{ results: { id: string; score: number; issues: string[]; rationale: string; confidence?: number }[] }>({
      fast: true,
      instructions,
      input: `Score the following ${batch.length} documents. Return one result per document id.\n\n${input}`,
      schema: BATCH_SCHEMA,
      name: "batch_prediction",
      maxOutputTokens: 220 * batch.length + 200,
      signal: poolSignal,
    });
    if (poolSignal.aborted) return;
    audit("ai.generate", { kind: "edoc", label: `batch prediction (${batch.length} docs)`, matterId: opts.matterId }, { surface: "ediscovery.predict", model, batch: batch.map((d) => d.bates), returned: res.results.length });
    const byId = new Map(res.results.map((r) => [r.id, r]));
    const updates: EDocument[] = [];
    for (const d of batch) {
      const r = byId.get(d.id);
      done++;
      if (!r) { emit({ type: "progress", done, total, scored }); continue; }
      const score = Math.max(0, Math.min(100, Math.round(r.score)));
      const issues = r.issues.filter((x) => valid.has(x));
      // Confidence: the model's own number, capped by how decisive the score is (a 50 is never confident).
      const decisiveness = Math.abs(score - 50) / 50;
      const confidence = Math.min(Number.isFinite(r.confidence ?? NaN) ? Math.max(0, Math.min(1, r.confidence!)) : 0.5, 0.4 + 0.6 * decisiveness);
      const provenance = gateReview({ ...recordGeneration({ surface: "ediscovery.predict", instructions, input: d.id, sources: documentSources([d]), confidence, model, target: { kind: "edoc", id: d.id, label: d.bates, matterId: d.matterId }, meta: { score, issues, rationale: r.rationale } }), verification: { status: "unverified", checkedAt: new Date().toISOString(), method: "schema", supported: 0, unsupported: 0, contradicted: 0, notes: "batch prediction; verified when a reviewer codes the document" } });
      if (provenance.review?.status === "pending") belowGate++;
      attachProvenance({ kind: "edoc.prediction", recordId: d.id, matterId: d.matterId, title: `${d.bates} — predicted ${score}`, href: docHref(d), provenance });
      updates.push({ ...d, aiScore: score, aiIssues: issues, aiProvenance: provenance });
      scored++;
      if (score >= 70) likelyResponsive++; else if (score < 40) likelyNonResponsive++; else uncertain++;
      emit({ type: "doc", docId: d.id, bates: d.bates, aiScore: score, message: `${r.rationale}${provenance.review?.status === "pending" ? " (below confidence gate — needs review)" : ""}`, done, total, scored });
    }
    if (updates.length) db().edocs.putMany(updates);
    emit({ type: "progress", done, total, scored });
  }, opts.signal);
  const summary = { scored, likelyResponsive, likelyNonResponsive, uncertain, tookMs: Date.now() - t0, belowGate };
  emit({ type: "done", done, total, scored, summary });
  return summary;
}

// ---------------------------------------------------------------------------
// Privilege log descriptions
// ---------------------------------------------------------------------------

export interface PrivilegeDescription { description: string; ai: boolean; provenance?: Provenance }

/** People named in the header: the only names a privilege-safe description may mention. */
function headerNames(d: EDocument): string[] {
  return [d.custodianName, d.from ?? "", ...(d.to ?? []), ...(d.cc ?? [])].flatMap((n) => n.split(/[;,]/)).map((n) => n.replace(/<[^>]*>/g, "").replace(/\(.*?\)/g, "").trim()).filter((n) => n.length > 2);
}

export async function draftPrivilegeDescription(docId: string, opts: { signal?: AbortSignal; verify?: boolean } = {}): Promise<PrivilegeDescription> {
  const d = db().edocs.get(docId);
  if (!d) throw new Error(`No document ${docId}`);
  if (!aiConfig().hasKey) return { description: templatePrivilegeDescription(d), ai: false };
  const instructions = `You draft privilege-log entries for ${FIRM_NAME}. Write ONE sentence (max 45 words) describing the document for a Rule 26(b)(5)(A) privilege log: document type, author and role, recipients and roles, the general legal subject, and the basis (attorney-client communication / work product). Never disclose the substance of the advice, any conclusions, numbers, or the content of the document. Do not use quotation marks. Use the style: "Email from Robert Kaine (Associate General Counsel) to Martin Suarez providing legal advice regarding regulatory reporting obligations."`;
  const input = `${docHeader(d)}\nPrivilege basis coded by reviewer: ${d.coding.privilegeBasis ?? "attorney-client"}\nReviewer note: ${d.coding.notes ?? "(none)"}\n\n---\n${clip(d.text, 8000)}`;
  const res = await generateText({ fast: true, instructions, input, maxOutputTokens: 160, signal: opts.signal });
  const text = res.text.trim().replace(/^["“]|["”]$/g, "");
  const description = text || templatePrivilegeDescription(d);
  // Deterministic checks (no second model call): the description must not quote the body, must not carry numbers
  // beyond the date, and every capitalised name it mentions should appear in the header. Each miss lowers confidence.
  const problems: string[] = [];
  if (opts.verify !== false) {
    const body = d.text.toLowerCase();
    const sentences = description.split(/(?<=[.;])\s+/).map((s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim()).filter((s) => s.length > 40);
    if (sentences.some((s) => body.includes(s))) problems.push("quotes the document body");
    if (/\$\s?\d|\b\d{2,}(?:\.\d+)?\s?(?:%|ppb|ppm|mg)\b/i.test(description)) problems.push("contains figures");
    const names = Array.from(description.matchAll(/\b([A-Z][a-z]+ [A-Z][a-z]+)\b/g)).map((m) => m[1]);
    const known = headerNames(d).map((n) => n.toLowerCase());
    const unknownNames = names.filter((n) => !known.some((k) => k.includes(n.toLowerCase()) || n.toLowerCase().includes(k.split(" ").pop()!)));
    if (unknownNames.length) problems.push(`names not in the header: ${unknownNames.join(", ")}`);
    if (description.split(/\s+/).length > 60) problems.push("longer than 45 words");
  }
  const confidence = Math.max(0.2, 0.95 - 0.25 * problems.length);
  let provenance = recordGeneration({ surface: "ediscovery.privilege", instructions, input, sources: documentSources([d]), confidence, model: aiConfig().fastModel, target: { kind: "edoc", id: d.id, label: d.bates, matterId: d.matterId } });
  const verification: NonNullable<Provenance["verification"]> = opts.verify === false
    ? { status: "unverified", checkedAt: new Date().toISOString(), method: "citations", supported: 0, unsupported: 0, contradicted: 0, notes: "verification skipped by caller" }
    : { status: problems.length ? (problems.length >= 2 ? "contradicted" : "partially-verified") : "verified", checkedAt: new Date().toISOString(), method: "citations", supported: 4 - problems.length, unsupported: problems.length, contradicted: problems.some((p) => p.startsWith("quotes")) ? 1 : 0, notes: problems.length ? problems.join("; ") : undefined };
  provenance = gateReview({ ...provenance, verification });
  return { description, ai: true, provenance };
}

export async function generatePrivilegeLog(matterId: string, opts: { regenerate?: boolean; useAI?: boolean; signal?: AbortSignal; onProgress?: (done: number, total: number) => void; verify?: boolean } = {}) {
  const useAI = opts.useAI !== false && aiConfig().hasKey;
  if (!useAI) {
    const r = generatePrivilegeLogTemplate(matterId, { regenerate: opts.regenerate });
    audit("ai.generate", { kind: "privilegeLog", label: `template privilege log (${r.created} entries)`, matterId }, { surface: "ediscovery.privilege", ai: false });
    return { ...r, needsReview: 0 };
  }
  const docs = opts.regenerate ? matterDocs(matterId).filter((d) => d.coding.privileged === true) : privilegedDocsWithoutEntry(matterId);
  let n = 0;
  let needsReview = 0;
  for (const d of docs) {
    if (opts.signal?.aborted) break;
    const { description, provenance } = await draftPrivilegeDescription(d.id, { signal: opts.signal, verify: opts.verify });
    const entry = upsertPrivilegeEntry(d, description);
    if (provenance) {
      if (provenance.review?.status === "pending") needsReview++;
      attachProvenance({ kind: "privilege.entry", recordId: entry.id, matterId, title: `${d.bates} privilege log entry`, href: `/ediscovery?matter=${matterId}&tab=codes`, provenance });
    }
    n++;
    opts.onProgress?.(n, docs.length);
  }
  const stale = db().privilegeLog.find((e) => e.matterId === matterId && db().edocs.get(e.docId)?.coding.privileged !== true);
  for (const e of stale) db().privilegeLog.delete(e.id);
  audit("ai.generate", { kind: "privilegeLog", label: `AI privilege log (${n} entries)`, matterId }, { surface: "ediscovery.privilege", created: n, removed: stale.length, needsReview });
  return { created: n, removed: stale.length, ai: true, needsReview };
}
