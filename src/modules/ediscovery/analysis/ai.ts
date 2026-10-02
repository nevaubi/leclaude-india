import "server-only";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { generateJSON, generateText } from "@/lib/ai/agent";
import { aiBudget, aiConfig, AIConfigError } from "@/lib/ai/config";
import { mapPool, mapPoolSettled } from "@/lib/ai/pool";
import { hybridSearch } from "@/lib/ai/vector-store";
import { VECTOR_COLLECTIONS } from "@/lib/ai/toolkit/internal";
import { FIRM_NAME, LEGAL_STYLE_RULES, todayLine } from "@/lib/ai/prompts";
import { crossCheckCitations, applyCiteCheck, type VerifySource } from "@/lib/ai/verify";
import { audit } from "@/lib/integrity/audit";
import { findNearDuplicateConflict, findNearDuplicateEvent, isDuplicateKnowledgeEntry } from "@/lib/integrity/dedupe";
import { confidenceFromLevel, gateReview } from "@/lib/integrity/provenance";
import { attachProvenance, depositionSource, documentSources, recordGeneration, verifyNarrative, verifyStructured } from "@/lib/integrity/record";
import { getProvenance } from "@/lib/integrity/store";
import type { Provenance, ProvenanceSource } from "@/lib/integrity/types";
import type { Conflict, Deposition, EDocument, TimelineEvent } from "@/lib/types/domain";
import type { FactMatrix, KnowledgeMap } from "./types";
import { formatPageLine } from "./types";
import { segmentTranscript, transcriptText, type TranscriptSegment } from "./transcript";
import { createConflict, crossAnalysis, exhibitDocuments, getDeposition, listEvents, listKnowledgeMaps, matterPeople, mergeEvents, saveFactMatrix, saveKnowledgeMap, setDigest } from "./service";
import { resolvePersonName } from "./graph";
import { getStory, storySources, updateStory } from "./service-stories";
import { storyFactsText } from "./stories";

export { AIConfigError };

/** Every wrapper accepts `verify` (default true) to skip the verification loops for speed. */
export interface VerifyOpt { verify?: boolean }

function requireKey() {
  if (!aiConfig().hasKey) throw new AIConfigError();
}

function clip(text: string, n: number) {
  return text.length > n ? text.slice(0, n) + "\n…[truncated]" : text;
}

function matterLine(matterId: string) {
  const m = db().matters.get(matterId);
  return m ? `${m.name} (${m.caption ?? ""}); the firm represents ${m.client} (${m.clientSide}).` : "a litigation matter.";
}

function docBlock(d: EDocument, max = 3500) {
  return `[${d.bates}${d.batesEnd ? `–${d.batesEnd}` : ""}] ${d.date} · ${d.type} · ${d.custodianName}${d.from ? ` · From: ${d.from}` : ""}${d.to?.length ? ` · To: ${d.to.join("; ")}` : ""}\nSubject: ${d.subject}\n${clip(d.text.replace(/\f/g, "\n"), max)}`;
}

function docVerifySources(docs: EDocument[], max = 5000): VerifySource[] {
  return docs.map((d) => ({ title: d.subject, cite: d.bates, text: docBlock(d, max) }));
}

/** Transcript as verification sources, chunked per ~40 Q/A so long depositions fit the verifier. */
function transcriptSources(dep: Deposition, indexes?: number[]): VerifySource[] {
  const idx = indexes?.length ? indexes : dep.transcript.map((_, i) => i);
  const out: VerifySource[] = [];
  for (let i = 0; i < idx.length; i += 40) {
    const slice = idx.slice(i, i + 40);
    const first = dep.transcript[slice[0]], last = dep.transcript[slice[slice.length - 1]];
    out.push({ title: `${dep.witnessName} deposition`, cite: `${formatPageLine(first.page, first.line)}–${formatPageLine(last.page, last.line)}`, text: transcriptText(dep, { indexes: slice, maxChars: 12_000 }) });
  }
  return out;
}

function matterBates(matterId: string): string[] {
  return db().edocs.find((x) => x.matterId === matterId).flatMap((x) => [x.bates, ...(x.batesEnd ? [x.batesEnd] : [])]);
}

const tabHref = (matterId: string, tab: string) => `/ediscovery?matter=${matterId}&tab=${tab}`;

// ---------------------------------------------------------------------------
// Deposition digest
// ---------------------------------------------------------------------------

const ADMISSION_SCHEMA = { type: "array", items: { type: "object", properties: { cite: { type: "string", description: "page:line, e.g. 24:05" }, text: { type: "string", description: "The admission in one or two sentences, quoting where possible." } }, required: ["cite", "text"] } };

const DIGEST_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string", description: "6–10 sentence narrative digest of the testimony for the trial team. Reference page:line." },
    keyAdmissions: ADMISSION_SCHEMA,
    themes: { type: "array", items: { type: "string" }, description: "4–8 short theme labels the examiner pursued." },
    credibilityNotes: { type: "array", items: { type: "string" }, description: "Observations on consistency, evasiveness, corrections, and demeanour inferred from the record, each with a cite." },
    followUps: { type: "array", items: { type: "string" }, description: "Questions to ask this witness at a further volume or to put to other witnesses, each tied to a page:line or Bates." },
    confidence: { type: "number", description: "0..1 calibrated confidence that every admission and cite is accurate to the transcript excerpt you were given." },
  },
  required: ["summary", "keyAdmissions", "themes", "credibilityNotes", "followUps", "confidence"],
};

const DIGEST_CHECK_SCHEMA = { type: "object", properties: { keyAdmissions: ADMISSION_SCHEMA, credibilityNotes: { type: "array", items: { type: "string" } }, followUps: { type: "array", items: { type: "string" } } }, required: ["keyAdmissions", "credibilityNotes", "followUps"] };

interface RawDigest { summary: string; keyAdmissions: { cite: string; text: string }[]; themes: string[]; credibilityNotes: string[]; followUps: string[]; confidence: number }

export type DigestRecord = NonNullable<Deposition["aiDigest"]> & { provenance?: Provenance };

export function digestWithProvenance(dep: Deposition): DigestRecord | null {
  if (!dep.aiDigest) return null;
  return { ...dep.aiDigest, provenance: getProvenance("deposition.digest", dep.id) ?? undefined };
}

/** Per-segment findings (one page:line window of the transcript). */
const SEGMENT_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string", description: "3–6 sentences on what the witness said in this window, with page:line cites." },
    admissions: ADMISSION_SCHEMA,
    qualifications: { type: "array", items: { type: "object", properties: { cite: { type: "string", description: "page:line in this window" }, text: { type: "string", description: "The qualification, correction, retraction or errata, quoting where possible." }, qualifies: { type: "string", description: "What earlier testimony it qualifies (topic, and its page:line when known), or empty." } }, required: ["cite", "text", "qualifies"] } },
    themes: { type: "array", items: { type: "string" } },
    credibilityNotes: { type: "array", items: { type: "string" } },
    followUps: { type: "array", items: { type: "string" } },
  },
  required: ["summary", "admissions", "qualifications", "themes", "credibilityNotes", "followUps"],
};

interface SegmentFindings { summary: string; admissions: { cite: string; text: string }[]; qualifications: { cite: string; text: string; qualifies: string }[]; themes: string[]; credibilityNotes: string[]; followUps: string[] }

/** Which windows of the transcript the digest actually analysed (constitution §28: never "comprehensive" on a prefix). */
export interface DigestCoverage {
  segments: { index: number; range: string; status: "analyzed" | "failed"; error?: string }[];
  analyzed: number;
  failed: number;
  /** True only when every window of the transcript was analysed. */
  complete: boolean;
  qaTotal: number;
  qaAnalyzed: number;
}

const cleanList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && Boolean(x.trim())) : []);
const cleanCites = (v: unknown): { cite: string; text: string }[] => (Array.isArray(v) ? (v as { cite?: unknown; text?: unknown }[]).filter((x) => x && typeof x.cite === "string" && typeof x.text === "string").map((x) => ({ cite: String(x.cite), text: String(x.text) })) : []);

function normalizeFindings(raw: Partial<SegmentFindings> | null | undefined): SegmentFindings {
  const q = Array.isArray(raw?.qualifications) ? (raw!.qualifications as { cite?: unknown; text?: unknown; qualifies?: unknown }[]).filter((x) => x && typeof x.cite === "string" && typeof x.text === "string").map((x) => ({ cite: String(x.cite), text: String(x.text), qualifies: typeof x.qualifies === "string" ? x.qualifies : "" })) : [];
  return { summary: typeof raw?.summary === "string" ? raw.summary : "", admissions: cleanCites(raw?.admissions), qualifications: q, themes: cleanList(raw?.themes), credibilityNotes: cleanList(raw?.credibilityNotes), followUps: cleanList(raw?.followUps) };
}

/** "20:5", "20:05", "p. 20 l. 5" → "20:5" (comparison key). */
function citeKey(cite: string): string | null {
  const m = /(\d{1,4})\s*:\s*(\d{1,2})/.exec(cite);
  return m ? `${Number(m[1])}:${Number(m[2])}` : null;
}

/**
 * Counterevidence scan (deterministic): every qualification, correction or retraction a segment found is kept in the
 * digest — when the synthesis did not carry it (no admission or credibility note at its page:line), it is appended to
 * the key admissions as a QUALIFICATION line. An early admission is never reported without its later qualification.
 */
export function preserveQualifications(keyAdmissions: { cite: string; text: string }[], credibilityNotes: string[], qualifications: { cite: string; text: string; qualifies: string }[]): { cite: string; text: string }[] {
  const present = new Set<string>();
  for (const k of keyAdmissions) { const c = citeKey(k.cite); if (c) present.add(c); }
  for (const n of credibilityNotes) for (const m of n.matchAll(/(\d{1,4})\s*:\s*(\d{1,2})/g)) present.add(`${Number(m[1])}:${Number(m[2])}`);
  const out = [...keyAdmissions];
  for (const q of qualifications) {
    const c = citeKey(q.cite);
    if (c && present.has(c)) continue;
    out.push({ cite: q.cite, text: `QUALIFICATION${q.qualifies ? ` (of ${q.qualifies})` : ""}: ${q.text}` });
    if (c) present.add(c);
  }
  return out;
}

/** Transcript windows for the verifier, those containing cited pages first (a long deposition exceeds the verifier's reach). */
function focusedTranscriptSources(dep: Deposition, citedPages: Set<number>): VerifySource[] {
  const all = transcriptSources(dep);
  const hit = (s: VerifySource) => { const m = /^(\d+):\d+–(\d+):\d+$/.exec(s.cite ?? ""); if (!m) return false; const a = Number(m[1]), b = Number(m[2]); for (const p of citedPages) if (p >= a && p <= b) return true; return false; };
  return [...all.filter(hit), ...all.filter((s) => !hit(s))];
}

export async function digestDeposition(depositionId: string, opts: { force?: boolean; signal?: AbortSignal } & VerifyOpt = {}): Promise<DigestRecord & { coverage?: DigestCoverage }> {
  const dep = getDeposition(depositionId);
  if (!dep) throw Object.assign(new Error(`No deposition ${depositionId}`), { status: 404 });
  if (dep.aiDigest && !opts.force) return digestWithProvenance(dep)!;
  if (!dep.transcript.length) throw Object.assign(new Error("No transcript to digest"), { status: 400 });
  requireKey();
  const budget = aiBudget("deposition_segment");
  const instructions = `You are a senior litigation associate at ${FIRM_NAME} preparing a deposition digest in ${matterLine(dep.matterId)}
${todayLine()}
${LEGAL_STYLE_RULES}
The digest is for the defending team. Be precise about what the witness actually said; do not overstate admissions. Every key admission, credibility note and follow-up must carry a page:line cite from the transcript. When a later answer qualifies, corrects or retracts an earlier admission (including errata), keep BOTH and say so, each with its own cite.`;
  const header = `Deposition of ${dep.witnessName}${dep.witnessTitle ? `, ${dep.witnessTitle}` : ""}, taken ${dep.date} by ${dep.takenBy}${dep.defendingBy ? `, defended by ${dep.defendingBy}` : ""}. ${dep.pages} pages.\n\nExhibits:\n${(dep.exhibits ?? []).map((e) => `- ${e.id}: ${e.description}${e.bates ? ` (${e.bates})` : ""}`).join("\n")}`;
  // 1. Segment the WHOLE transcript into page:line windows sized by the budget (no prefix truncation).
  const segments: TranscriptSegment[] = segmentTranscript(dep, budget.perSourceChars);
  let raw: RawDigest;
  let input: string;
  let coverage: DigestCoverage;
  let qualifications: SegmentFindings["qualifications"] = [];
  let structuredEvidence: string;
  if (segments.length <= 1) {
    // The whole transcript fits one window: one call sees all of it.
    const transcript = transcriptText(dep, { maxChars: Number.MAX_SAFE_INTEGER });
    input = `${header}\n\nFull transcript (all ${dep.transcript.length} Q/A):\n${transcript}`;
    raw = await generateJSON<RawDigest>({ instructions, input, schema: DIGEST_SCHEMA, name: "deposition_digest", maxOutputTokens: Math.max(3_000, budget.maxOutputTokens), signal: opts.signal });
    coverage = { segments: segments.map((g) => ({ index: g.index, range: g.range, status: "analyzed" })), analyzed: segments.length, failed: 0, complete: true, qaTotal: dep.transcript.length, qaAnalyzed: dep.transcript.length };
    structuredEvidence = transcript;
  } else {
    // 2. Analyse every window in parallel (bounded pool); a failed window is recorded, never silently skipped.
    const settled = await mapPoolSettled(segments, budget.concurrency, async (g, _index, poolSignal) => {
      const text = transcriptText(dep, { indexes: g.indexes, maxChars: Number.MAX_SAFE_INTEGER });
      const r = await generateJSON<SegmentFindings>({ instructions: `${instructions}\nYou are reading window ${g.index + 1} of ${segments.length} (${g.range}). Report what is in this window only, with page:line cites from it; list every qualification, correction, retraction or errata separately under qualifications.`, input: `${header}\n\nTranscript window ${g.range}:\n${text}`, schema: SEGMENT_SCHEMA, name: "deposition_segment", maxOutputTokens: budget.maxOutputTokens, signal: poolSignal });
      return normalizeFindings(r);
    }, opts.signal);
    const findings = settled.map((x, i) => ({ segment: segments[i], result: x }));
    const ok = findings.filter((f) => f.result.ok) as { segment: TranscriptSegment; result: { ok: true; value: SegmentFindings } }[];
    // 3. Coverage map.
    coverage = {
      segments: findings.map((f) => (f.result.ok ? { index: f.segment.index, range: f.segment.range, status: "analyzed" as const } : { index: f.segment.index, range: f.segment.range, status: "failed" as const, error: String((f.result.error as Error)?.message ?? f.result.error).slice(0, 200) })),
      analyzed: ok.length,
      failed: findings.length - ok.length,
      complete: ok.length === findings.length,
      qaTotal: dep.transcript.length,
      qaAnalyzed: ok.reduce((a, f) => a + f.segment.indexes.length, 0),
    };
    if (!ok.length) throw Object.assign(new Error(`Deposition digest failed: none of the ${segments.length} transcript windows could be analysed (${coverage.segments[0]?.error ?? "unknown error"}).`), { status: 502 });
    qualifications = ok.flatMap((f) => f.result.value.qualifications);
    // 4. Synthesis over the window findings (in transcript order), with the coverage stated.
    const gaps = coverage.segments.filter((x) => x.status === "failed").map((x) => x.range);
    input = `${header}\n\nCoverage: ${coverage.analyzed} of ${segments.length} transcript windows analysed${gaps.length ? `; NOT analysed: ${gaps.join(", ")} — say so in the summary and do not describe that testimony` : " (the whole transcript)"}.\n\nWindow findings in transcript order:\n${ok.map((f) => `### ${f.segment.range}\n${JSON.stringify(f.result.value)}`).join("\n\n")}`;
    raw = await generateJSON<RawDigest>({ instructions: `${instructions}\nYou are synthesising the findings of every analysed window into one digest. Keep each admission together with any later qualification of it (both cites).`, input, schema: DIGEST_SCHEMA, name: "deposition_digest", maxOutputTokens: Math.max(3_000, budget.maxOutputTokens), signal: opts.signal });
    structuredEvidence = "";
  }
  raw = { ...raw, keyAdmissions: cleanCites(raw.keyAdmissions), themes: cleanList(raw.themes), credibilityNotes: cleanList(raw.credibilityNotes), followUps: cleanList(raw.followUps), summary: typeof raw.summary === "string" ? raw.summary : "" };
  // 5. Counterevidence scan: no qualification found in any window is lost.
  raw.keyAdmissions = preserveQualifications(raw.keyAdmissions, raw.credibilityNotes, qualifications);
  if (!coverage.complete) raw.summary = `${raw.summary}\n\nCoverage: ${coverage.analyzed} of ${coverage.segments.length} transcript windows were analysed; not analysed: ${coverage.segments.filter((x) => x.status === "failed").map((x) => x.range).join(", ")}. This digest is not comprehensive.`;
  const target = { kind: "deposition", id: dep.id, label: `${dep.witnessName} digest`, matterId: dep.matterId };
  let provenance = recordGeneration({ surface: "ediscovery.digest", instructions, input, sources: [depositionSource(dep), ...(dep.exhibits ?? []).filter((e) => e.bates).map((e) => ({ kind: "document" as const, cite: e.bates, title: e.description }))], confidence: raw.confidence, target, meta: { admissions: raw.keyAdmissions.length, segments: coverage.segments.length, segmentsAnalyzed: coverage.analyzed, coverageComplete: coverage.complete } });
  // (a) structured items are self-corrected against the transcript windows they cite (a long transcript is not cut to a prefix)
  const citedPages = new Set<number>();
  for (const line of [...raw.keyAdmissions.map((k) => k.cite), ...raw.credibilityNotes, ...raw.followUps]) for (const m of String(line).matchAll(/(\d{1,4})\s*:\s*\d{1,2}/g)) citedPages.add(Number(m[1]));
  if (!structuredEvidence) {
    const idx = dep.transcript.map((q, i) => ({ q, i })).filter(({ q }) => citedPages.has(q.page) || citedPages.has(q.page - 1) || citedPages.has(q.page + 1)).map(({ i }) => i);
    structuredEvidence = transcriptText(dep, { indexes: idx, maxChars: Number.MAX_SAFE_INTEGER });
  }
  const checked = await verifyStructured(provenance, { label: "deposition digest (admissions, credibility notes, follow-ups)", output: { keyAdmissions: raw.keyAdmissions, credibilityNotes: raw.credibilityNotes, followUps: raw.followUps }, evidence: structuredEvidence, schema: DIGEST_CHECK_SCHEMA, verify: opts.verify, signal: opts.signal, count: (v) => v.keyAdmissions.length + v.credibilityNotes.length + v.followUps.length, instructions: "Every cite must match a page:line that appears in the evidence and the quoted words must be the witness's. A QUALIFICATION line is kept whenever its page:line supports it, even if it narrows an earlier admission." }, target);
  provenance = checked.provenance;
  const structuredVerification = provenance.verification;
  // (b) the narrative summary is claim-verified against the transcript (windows with cited pages first); (c) cites are cross-checked
  const pages = dep.transcript.map((q) => q.page);
  const cites = { bates: [...matterBates(dep.matterId), ...(dep.exhibits ?? []).map((e) => e.bates ?? "").filter(Boolean)], pages };
  for (const m of raw.summary.matchAll(/(\d{1,4})\s*:\s*\d{1,2}/g)) citedPages.add(Number(m[1]));
  const narrative = await verifyNarrative({ ...provenance, verification: undefined }, { answer: raw.summary, sources: focusedTranscriptSources(dep, citedPages), cites, verify: opts.verify, signal: opts.signal, maxClaims: 20 }, target);
  const items = checked.output;
  const admissionLines = items.keyAdmissions.map((k) => crossCheckCitations(`${k.cite} — ${k.text}`, cites).text);
  const credibility = items.credibilityNotes.map((n) => crossCheckCitations(n, cites).text);
  const followUps = items.followUps.map((n) => crossCheckCitations(n, cites).text);
  const lineCheck = crossCheckCitations([...admissionLines, ...credibility, ...followUps].join("\n"), cites);
  // Merge: claims verification on the summary + cite check on the items + schema corrections
  let merged = applyCiteCheck(narrative.provenance, lineCheck);
  const v = merged.verification;
  if (v && structuredVerification) merged = { ...merged, verification: { ...v, status: structuredVerification.status === "contradicted" || v.status === "contradicted" ? "contradicted" : v.status, changes: structuredVerification.changes, notes: [structuredVerification.notes, v.notes].filter(Boolean).join("; ") || undefined } };
  if (!coverage.complete && merged.verification) {
    // Incomplete coverage can never read as verified.
    const st = merged.verification.status === "verified" ? "partially-verified" : merged.verification.status;
    merged = { ...merged, verification: { ...merged.verification, status: st, notes: [merged.verification.notes, `coverage incomplete: ${coverage.failed} of ${coverage.segments.length} transcript windows not analysed`].filter(Boolean).join("; ") } };
  }
  provenance = gateReview(merged);
  const digest: NonNullable<Deposition["aiDigest"]> = { summary: narrative.text, keyAdmissions: admissionLines, themes: raw.themes, credibilityNotes: credibility, followUps };
  setDigest(depositionId, digest);
  attachProvenance({ kind: "deposition.digest", recordId: dep.id, matterId: dep.matterId, title: `Digest — ${dep.witnessName} (${dep.date})`, href: `${tabHref(dep.matterId, "depositions")}&deposition=${dep.id}`, provenance });
  return { ...digest, provenance, coverage };
}

// ---------------------------------------------------------------------------
// Outline for the next witness
// ---------------------------------------------------------------------------

export interface OutlineResult { markdown: string; title: string; sources: string[]; provenance: Provenance; unresolvedCites: string[] }

export async function prepareOutline(matterId: string, opts: { witnessId?: string; witnessName: string; topics?: string[]; depositionId?: string; signal?: AbortSignal } & VerifyOpt): Promise<OutlineResult> {
  requireKey();
  const d = db();
  const witnessName = opts.witnessName.trim();
  const people = matterPeople(matterId);
  // The witness must be one of this matter's people; an id from another matter is ignored rather than trusted.
  const person = opts.witnessId ? people.find((p) => p.id === opts.witnessId) : resolvePersonName(witnessName, people);
  const deps = d.depositions.find((x) => x.matterId === matterId && x.transcript.length > 0);
  const last = witnessName.split(" ").pop()!.toLowerCase();
  // Prior testimony about this witness from other deponents, plus their own prior volume(s).
  const prior = deps.flatMap((dep) => dep.transcript.map((qa, i) => ({ dep, qa, i })).filter(({ dep, qa }) => dep.witnessId === person?.id || `${qa.question} ${qa.answer}`.toLowerCase().includes(last) || (qa.flags?.length ?? 0) > 0)).slice(0, 80);
  const priorText = prior.map(({ dep, qa }) => `${dep.witnessName} ${formatPageLine(qa.page, qa.line)}${qa.flags?.length ? ` [${qa.flags.join(", ")}]` : ""}\nQ. ${qa.question}\nA. ${qa.answer}`).join("\n\n");
  // Documents: authored/received by the witness plus topic hits.
  const docs = d.edocs.find((x) => x.matterId === matterId);
  const own = docs.filter((x) => x.custodianId === person?.id || (x.from && resolvePersonName(x.from, people)?.id === person?.id) || (x.to ?? []).some((n) => resolvePersonName(n, people)?.id === person?.id)).sort((a, b) => (b.coding.hot ? 1 : 0) - (a.coding.hot ? 1 : 0) || (b.aiScore ?? 0) - (a.aiScore ?? 0)).slice(0, 14);
  const topicDocs: EDocument[] = [];
  for (const t of opts.topics ?? []) {
    const hits = await hybridSearch(VECTOR_COLLECTIONS.edocs, t, { k: 4, perDoc: 1, filter: (meta) => meta.matterId === matterId });
    for (const h of hits) { const doc = d.edocs.get(h.docId); if (doc && !own.includes(doc) && !topicDocs.includes(doc)) topicDocs.push(doc); }
  }
  const allDocs = [...own, ...topicDocs].slice(0, 20);
  const conflicts = d.conflicts.find((c) => c.matterId === matterId && c.status === "open");
  const events = listEvents(matterId, { personId: person?.id }).slice(0, 30);
  const matter = d.matters.get(matterId);
  const instructions = `You are ${matter?.clientSide === "plaintiff" ? "lead trial counsel" : "defending counsel"} at ${FIRM_NAME} in ${matterLine(matterId)}
${todayLine()}
${LEGAL_STYLE_RULES}
Write a deposition ${matter?.clientSide === "defendant" ? "preparation and defence" : "examination"} outline for the witness in Markdown. Structure: 1. Witness profile and role; 2. Objectives; 3. Chronology the witness can speak to (dated, with Bates); 4. Topic-by-topic outline with the documents to use (Bates), the prior testimony to confront or reconcile (witness page:line), the questions to ask, and the answers to prepare for; 5. Privilege and instruction points; 6. Open conflicts to resolve; 7. Exhibit list. Use only the record provided; mark anything unverified [VERIFY].`;
  const input = `Witness: ${witnessName}${person?.title ? `, ${person.title}` : ""}${person?.organization ? ` (${person.organization})` : ""}
Topics requested: ${(opts.topics ?? []).join("; ") || "(counsel did not specify; infer from the record)"}

## Chronology entries involving the witness
${events.map((e) => `- ${e.date} — ${e.title} [${e.sources.map((s) => s.bates ?? s.cite ?? "").filter(Boolean).join(", ")}]`).join("\n") || "(none)"}

## Open conflicts
${conflicts.map((c) => `- ${c.title} (${c.severity}): ${c.sides.map((s) => `${s.cite}`).join(" vs ")}`).join("\n") || "(none)"}

## Prior testimony (this witness and others)
${clip(priorText, 40_000) || "(none)"}

## Documents
${allDocs.map((x) => docBlock(x, 2200)).join("\n\n---\n\n") || "(none)"}`;
  const res = await generateText({ instructions, input, maxOutputTokens: 6000, signal: opts.signal });
  const title = `Deposition outline — ${witnessName}`;
  const recordId = `${matterId}:${(person?.id ?? last).replace(/[^a-z0-9_-]/gi, "")}`;
  const target = { kind: "deposition.outline", id: recordId, label: title, matterId };
  const sources: ProvenanceSource[] = [...documentSources(allDocs), ...Array.from(new Set(prior.map((p) => p.dep.id))).map((id) => depositionSource(d.depositions.get(id)!))];
  let provenance = recordGeneration({ surface: "ediscovery.outline", instructions, input, sources, target, usage: res.usage ? { input: res.usage.input_tokens, output: res.usage.output_tokens, total: res.usage.total_tokens } : undefined });
  const priorPages = prior.map((p) => p.qa.page);
  const verifySources: VerifySource[] = [...docVerifySources(allDocs, 3000), ...(priorText ? [{ title: "Prior testimony", text: clip(priorText, 24_000) }] : []), ...(events.length ? [{ title: "Chronology", text: events.map((e) => `${e.date} — ${e.title} [${e.sources.map((s) => s.bates ?? s.cite ?? "").join(", ")}]`).join("\n") }] : [])];
  const narrative = await verifyNarrative(provenance, { answer: res.text, sources: verifySources, cites: { bates: allDocs.flatMap((x) => [x.bates, ...(x.batesEnd ? [x.batesEnd] : [])]), pages: priorPages }, verify: opts.verify, signal: opts.signal, maxClaims: 30 }, target);
  provenance = narrative.provenance;
  attachProvenance({ kind: "deposition.outline", recordId, matterId, title, href: tabHref(matterId, "depositions"), provenance });
  return { markdown: narrative.text, title, sources: [...allDocs.map((x) => x.bates), ...Array.from(new Set(prior.map((p) => p.dep.witnessName)))], provenance, unresolvedCites: narrative.unresolvedCites };
}

// ---------------------------------------------------------------------------
// Find contradictions → Conflict records
// ---------------------------------------------------------------------------

const CONTRADICTION_ITEM = {
  type: "object",
  properties: {
    title: { type: "string", description: "One-line description: '<Witness>: <claim> vs. <source> <what it says>'" },
    kind: { type: "string", enum: ["testimony_vs_document", "testimony_vs_testimony", "document_vs_document", "date_inconsistency", "position_inconsistency"] },
    severity: { type: "string", enum: ["low", "medium", "high"] },
    testimonyCite: { type: "string", description: "Witness and page:line, e.g. 'Vasudevan 19:15'" },
    testimonyExcerpt: { type: "string" },
    sourceKind: { type: "string", enum: ["document", "deposition"] },
    sourceCite: { type: "string", description: "Bates number or witness page:line" },
    sourceExcerpt: { type: "string" },
    analysis: { type: "string", description: "3–5 sentences: why they conflict, how serious it is, and how to handle it." },
    confidence: { type: "number", description: "0..1 how sure you are this is a genuine inconsistency rather than a difference of emphasis." },
  },
  required: ["title", "kind", "severity", "testimonyCite", "testimonyExcerpt", "sourceKind", "sourceCite", "sourceExcerpt", "analysis", "confidence"],
};

const CONTRADICTIONS_SCHEMA = { type: "object", properties: { contradictions: { type: "array", items: CONTRADICTION_ITEM } }, required: ["contradictions"] };

interface RawContradiction { title: string; kind: Conflict["kind"]; severity: Conflict["severity"]; testimonyCite: string; testimonyExcerpt: string; sourceKind: "document" | "deposition"; sourceCite: string; sourceExcerpt: string; analysis: string; confidence: number }

export interface ContradictionsResult {
  created: Conflict[];
  considered: number;
  skipped: { title: string; duplicateOf: string }[];
  dropped: string[];
  /** Contradictions whose cited source could not be resolved in this matter's record; never mapped to another document or witness. */
  unresolved: { title: string; cite: string; reason: string }[];
}

/** Resolve a Bates cite to a document of this matter, or nothing. Never falls back to another document. */
export function resolveBatesInMatter(matterId: string, cite: string): EDocument | null {
  const upper = cite.toUpperCase();
  // Whole-token match: "MFC-00418770" must not resolve to MFC-0041877 because one is a prefix of the other.
  const has = (bates: string) => new RegExp(`(^|[^A-Z0-9])${bates.toUpperCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![0-9])`).test(upper);
  return db().edocs.findOne((x) => x.matterId === matterId && (has(x.bates) || (!!x.batesEnd && has(x.batesEnd)))) ?? null;
}

/**
 * Resolve a "Witness 24:05" cite to a transcribed deposition of this matter by the witness's last name, or nothing.
 * When several transcripts match (two witnesses sharing a surname, or several volumes) the cited page must select
 * exactly one of them; otherwise the cite stays unresolved rather than binding to the earliest or closest one.
 */
export function resolveWitnessInMatter(matterId: string, cite: string): Deposition | null {
  const tokens = cite.trim().split(/\s+/);
  const last = tokens.find((t) => /[a-z]/i.test(t) && !/^(vol|volume|dep|depo|tr|at|p|pp)\.?$/i.test(t))?.toLowerCase().replace(/[^a-z'-]/g, "");
  if (!last) return null;
  const hits = db().depositions.find((x) => x.matterId === matterId && x.transcript.length > 0 && x.witnessName.toLowerCase().split(/\s+/).pop() === last);
  if (hits.length <= 1) return hits[0] ?? null;
  const page = Number(cite.match(/(\d+)\s*:\s*\d+/)?.[1] ?? NaN);
  const volume = Number(cite.match(/vol(?:ume)?\.?\s*(\d+)/i)?.[1] ?? NaN);
  const narrowed = hits.filter((x) => (!Number.isFinite(volume) || (x.volume ?? 1) === volume) && (!Number.isFinite(page) || x.transcript.some((q) => q.page === page)));
  return narrowed.length === 1 ? narrowed[0] : null;
}

export async function findContradictions(matterId: string, opts: { depositionId: string; topic: string; indexes?: number[]; signal?: AbortSignal } & VerifyOpt): Promise<ContradictionsResult> {
  requireKey();
  const dep = getDeposition(opts.depositionId);
  if (!dep) throw Object.assign(new Error("Unknown deposition"), { status: 404 });
  const d = db();
  const cross = await crossAnalysis(matterId, { topic: opts.topic, depositionId: dep.id, k: 12 });
  const indexes = opts.indexes?.length ? opts.indexes : cross.testimony.map((t) => t.index!).filter((i) => i != null);
  const testimony = transcriptText(dep, { indexes, maxChars: 30_000 });
  const docs = cross.documents.map((x) => d.edocs.get(x.id)).filter((x): x is EDocument => !!x);
  const other = cross.otherTestimony.map((t) => `${t.cite}\n${t.text}`).join("\n\n");
  const existing = d.conflicts.find((c) => c.matterId === matterId);
  const instructions = `You are a senior litigator at ${FIRM_NAME} in ${matterLine(matterId)}
${todayLine()}
${LEGAL_STYLE_RULES}
Compare the witness's testimony against the documents and other testimony. Report only genuine inconsistencies of fact, date, or position, quoting both sides verbatim with exact cites. Do not report differences of emphasis. Skip anything already in the existing conflicts list. Return an empty array if nothing qualifies.`;
  const evidence = `## Testimony under review\n${testimony}\n\n## Other witnesses on this topic\n${other || "(none)"}\n\n## Documents\n${docs.map((x) => docBlock(x, 3000)).join("\n\n---\n\n") || "(none)"}`;
  const input = `Topic: ${opts.topic}\nWitness: ${dep.witnessName} (${dep.date})\n\n## Existing conflicts (skip)\n${existing.map((c) => `- ${c.title}`).join("\n") || "(none)"}\n\n${evidence}`;
  const raw = await generateJSON<{ contradictions: RawContradiction[] }>({ instructions, input, schema: CONTRADICTIONS_SCHEMA, name: "contradictions", maxOutputTokens: 4000, signal: opts.signal });
  const target = { kind: "conflict", label: `contradictions: ${dep.witnessName} / ${opts.topic}`, matterId };
  const base = recordGeneration({ surface: "ediscovery.contradictions", instructions, input, sources: [depositionSource(dep), ...documentSources(docs)], target, meta: { returned: raw.contradictions.length } });
  const checked = await verifyStructured(base, { label: "list of contradictions", output: raw.contradictions, evidence, schema: { type: "array", items: CONTRADICTION_ITEM }, verify: opts.verify, signal: opts.signal, instructions: "Both excerpts must appear in the evidence with the cites given; drop any pair that is only a difference of emphasis." }, target);
  const dropped = raw.contradictions.filter((c) => !checked.output.some((k) => k.title === c.title)).map((c) => c.title);
  const created: Conflict[] = [];
  const skipped: ContradictionsResult["skipped"] = [];
  const unresolved: ContradictionsResult["unresolved"] = [];
  const known = matterBates(matterId);
  for (const c of checked.output) {
    // Evidence contract: an unresolved Bates or witness is excluded, never mapped to "the first document" or "this deposition".
    const sourceId = c.sourceKind === "document" ? resolveBatesInMatter(matterId, c.sourceCite)?.id ?? "" : resolveWitnessInMatter(matterId, c.sourceCite)?.id ?? "";
    if (!sourceId) {
      const reason = c.sourceKind === "document" ? "Bates number not in this matter's review set" : "witness not deposed in this matter";
      unresolved.push({ title: c.title, cite: c.sourceCite, reason });
      audit("ai.verify", { kind: "conflict", label: c.title, matterId }, { method: "citations", decision: "excluded", cite: c.sourceCite, reason });
      continue;
    }
    const sides: Conflict["sides"] = [
      { label: `${dep.witnessName} testimony`, sourceKind: "deposition", sourceId: dep.id, cite: c.testimonyCite, excerpt: c.testimonyExcerpt },
      { label: c.sourceKind === "document" ? (d.edocs.get(sourceId)?.subject ?? "Document") : `${d.depositions.get(sourceId)?.witnessName ?? "Witness"} testimony`, sourceKind: c.sourceKind, sourceId, cite: c.sourceCite, excerpt: c.sourceExcerpt },
    ];
    // Cross-context check: the same inconsistency may already be on the register (from a prior run or a reviewer).
    const dup = findNearDuplicateConflict([...existing, ...created], { title: c.title, sides });
    if (dup) { skipped.push({ title: c.title, duplicateOf: dup.id }); audit("ai.verify", { kind: "conflict", id: dup.id, label: dup.title, matterId }, { method: "dedupe", skippedTitle: c.title, reason: "near-duplicate of an existing conflict" }); continue; }
    // Cite check: the cited page must be in the transcript and the Bates in the review set.
    const cite = crossCheckCitations(`${c.testimonyCite} ${c.sourceCite}`, { bates: known, pages: dep.transcript.map((q) => q.page) });
    const sourceCites: ProvenanceSource[] = [{ kind: "deposition", id: dep.id, cite: c.testimonyCite, title: dep.witnessName }, { kind: c.sourceKind, id: sourceId, cite: c.sourceCite }];
    let provenance: Provenance = { ...checked.provenance, sources: sourceCites, confidence: Number.isFinite(c.confidence) ? c.confidence : undefined, review: undefined };
    provenance = gateReview(applyCiteCheck(provenance, cite));
    const conflict = createConflict(matterId, { title: c.title, kind: c.kind, severity: c.severity, analysis: c.analysis, createdBy: "ai", sides, provenance });
    attachProvenance({ kind: "conflict", recordId: conflict.id, matterId, title: conflict.title, href: `${tabHref(matterId, "conflicts")}&conflict=${conflict.id}`, provenance });
    audit("create", { kind: "conflict", id: conflict.id, label: conflict.title, matterId }, { by: "ai", confidence: provenance.confidence, review: provenance.review?.status });
    created.push(conflict);
  }
  return { created, considered: indexes.length + docs.length + cross.otherTestimony.length, skipped, dropped, unresolved };
}

// ---------------------------------------------------------------------------
// Fact matrix
// ---------------------------------------------------------------------------

const CELL_SCHEMA = { type: "object", properties: { topic: { type: "string" }, sourceId: { type: "string", description: "Exactly one of the provided source ids" }, position: { type: "string", description: "What this source says on the topic, one or two sentences; 'Silent' if nothing." }, cite: { type: "string", description: "page:line or Bates" }, stance: { type: "string", enum: ["supports", "contradicts", "neutral", "silent"], description: "Relative to the client's position" } }, required: ["topic", "sourceId", "position", "cite", "stance"] };

const MATRIX_SCHEMA = {
  type: "object",
  properties: {
    topics: { type: "array", items: { type: "string" }, description: "4–8 fact questions or sub-topics, short." },
    cells: { type: "array", items: CELL_SCHEMA },
    confidence: { type: "number", description: "0..1 calibrated confidence that every cell quotes or fairly paraphrases its source with the right cite." },
  },
  required: ["topics", "cells", "confidence"],
};

export type FactMatrixRecord = FactMatrix & { provenance?: Provenance };

export async function buildFactMatrix(matterId: string, opts: { topic: string; witnessId?: string; signal?: AbortSignal } & VerifyOpt): Promise<FactMatrixRecord> {
  requireKey();
  const d = db();
  const cross = await crossAnalysis(matterId, { topic: opts.topic, witnessId: opts.witnessId, k: 8 });
  const sources: FactMatrix["sources"] = [];
  const blocks: string[] = [];
  const deps = new Map<string, number[]>();
  for (const t of [...cross.testimony, ...cross.otherTestimony]) { const arr = deps.get(t.id) ?? []; if (t.index != null) arr.push(t.index); deps.set(t.id, arr); }
  const provSources: ProvenanceSource[] = [];
  for (const [id, idx] of deps) {
    const dep = d.depositions.get(id)!;
    sources.push({ id, kind: "deposition", label: `${dep.witnessName} deposition`, cite: `${dep.witnessName.split(" ").pop()} Vol. ${dep.volume ?? 1}` });
    provSources.push(depositionSource(dep));
    blocks.push(`### Source ${id} — ${dep.witnessName} testimony\n${transcriptText(dep, { indexes: idx, maxChars: 12_000 })}`);
  }
  const matrixDocs: EDocument[] = [];
  for (const x of cross.documents.slice(0, 8)) {
    const doc = d.edocs.get(x.id);
    if (!doc) continue;
    matrixDocs.push(doc);
    sources.push({ id: doc.id, kind: "document", label: doc.subject, cite: doc.bates });
    blocks.push(`### Source ${doc.id} — ${doc.bates}\n${docBlock(doc, 2500)}`);
  }
  provSources.push(...documentSources(matrixDocs));
  const instructions = `You are a litigation analyst at ${FIRM_NAME} in ${matterLine(matterId)}
${todayLine()}
Build a fact matrix: rows are sub-topics of the requested topic, columns are the sources. For every (topic, source) pair produce one cell. Quote or closely paraphrase; cite page:line for testimony and Bates for documents. Use sourceId values exactly as given.`;
  const evidence = blocks.join("\n\n");
  const input = `Topic: ${opts.topic}\n\nSources:\n${sources.map((s) => `- ${s.id}: ${s.label} (${s.cite})`).join("\n")}\n\n${evidence}`;
  const raw = await generateJSON<{ topics: string[]; cells: FactMatrix["cells"]; confidence: number }>({ instructions, input, schema: MATRIX_SCHEMA, name: "fact_matrix", maxOutputTokens: 5000, signal: opts.signal });
  const valid = new Set(sources.map((s) => s.id));
  const id = `fm_${nanoid(10)}`;
  const target = { kind: "fact-matrix", id, label: `fact matrix: ${opts.topic}`, matterId };
  let provenance = recordGeneration({ surface: "ediscovery.factMatrix", instructions, input, sources: provSources, confidence: raw.confidence, target, meta: { cells: raw.cells.length } });
  const cells = raw.cells.filter((c) => valid.has(c.sourceId));
  const checked = await verifyStructured(provenance, { label: "fact matrix cells", output: cells, evidence, schema: { type: "array", items: CELL_SCHEMA }, verify: opts.verify, signal: opts.signal, instructions: "Keep 'Silent' cells. Fix a cite only when the evidence shows the right one; drop a cell whose position is not in its source." }, target);
  provenance = checked.provenance;
  const pages = Array.from(deps.keys()).flatMap((k) => d.depositions.get(k)?.transcript.map((q) => q.page) ?? []);
  const cite = crossCheckCitations(checked.output.map((c) => c.cite).join("\n"), { bates: matrixDocs.flatMap((x) => [x.bates, ...(x.batesEnd ? [x.batesEnd] : [])]), pages });
  provenance = gateReview(applyCiteCheck(provenance, cite));
  const matrix: FactMatrixRecord = { id, matterId, topic: opts.topic, createdAt: new Date().toISOString(), createdBy: "ai", topics: raw.topics, sources, cells: checked.output.filter((c) => valid.has(c.sourceId)), provenance };
  saveFactMatrix(matrix);
  attachProvenance({ kind: "fact-matrix", recordId: id, matterId, title: `Fact matrix — ${opts.topic}`, href: tabHref(matterId, "cross"), provenance });
  return matrix;
}

// ---------------------------------------------------------------------------
// Timeline extraction
// ---------------------------------------------------------------------------

const EVENT_ITEM = {
  type: "object",
  properties: {
    date: { type: "string", description: "ISO date YYYY-MM-DD; use the first of the month or year if only that precision is known" },
    precision: { type: "string", enum: ["day", "month", "year"] },
    title: { type: "string", description: "Short factual headline, under 120 characters" },
    description: { type: "string" },
    category: { type: "string", enum: ["corporate", "scientific", "regulatory", "communication", "litigation", "testimony", "product", "other"] },
    significance: { type: "integer", description: "1 (background) to 5 (case-critical)" },
    bates: { type: "string", description: "Bates number of the source document" },
    excerpt: { type: "string", description: "Short quotation supporting the event" },
    people: { type: "array", items: { type: "string" }, description: "Names of people involved" },
    confidence: { type: "number", description: "0..1 how sure you are of the date and the fact, given the text" },
  },
  required: ["date", "precision", "title", "description", "category", "significance", "bates", "excerpt", "people", "confidence"],
};

const EVENTS_SCHEMA = { type: "object", properties: { events: { type: "array", items: EVENT_ITEM } }, required: ["events"] };

interface RawEvent { date: string; precision: "day" | "month" | "year"; title: string; description: string; category: TimelineEvent["category"]; significance: number; bates: string; excerpt: string; people: string[]; confidence: number }

export interface ExtractResult {
  added: TimelineEvent[];
  merged: number;
  extracted: number;
  dropped: number;
  duplicates: { title: string; date: string; duplicateOf: string }[];
  needsReview: number;
  /** Events whose cited Bates number is not in this matter's review set; excluded rather than attached to another document. */
  unresolved: { title: string; date: string; bates: string }[];
}

export async function extractTimelineEvents(matterId: string, opts: { docIds: string[]; signal?: AbortSignal; onProgress?: (done: number, total: number) => void } & VerifyOpt): Promise<ExtractResult> {
  requireKey();
  const d = db();
  const docs = opts.docIds.map((id) => d.edocs.get(id)).filter((x): x is EDocument => !!x && x.matterId === matterId);
  if (!docs.length) throw Object.assign(new Error("No documents to extract from"), { status: 400 });
  const people = matterPeople(matterId);
  const instructions = `You are a litigation analyst at ${FIRM_NAME} building a chronology in ${matterLine(matterId)}
${todayLine()}
Extract dated events from the documents: things that happened (a study delivered, a decision made, a letter sent, a result received, a meeting held), not the document itself. Use the document date for events the document itself records unless the text gives a different date. One event per distinct fact; skip trivial scheduling. Cite the Bates number of the document that supports each event.`;
  const all: TimelineEvent[] = [];
  const duplicates: ExtractResult["duplicates"] = [];
  const unresolved: ExtractResult["unresolved"] = [];
  let extracted = 0, dropped = 0, needsReview = 0;
  const known = matterBates(matterId);
  // Batch size and per-document text follow the e-discovery batch budget (never below 6 documents × 4,000 chars).
  const budget = aiBudget("ediscovery_batch");
  const batchSize = 6;
  const docChars = Math.max(4_000, Math.min(budget.perSourceChars, Math.floor(budget.totalEvidenceChars / batchSize)));
  const batches: EDocument[][] = [];
  for (let i = 0; i < docs.length; i += batchSize) batches.push(docs.slice(i, i + batchSize));
  // Model work (extraction + self-correction) runs in parallel across batches (bounded); merging and dedupe then run
  // in document order so the result does not depend on which batch finished first.
  let finished = 0;
  // Stop-on-failure: a failed batch stops the extraction (no further model calls; batches in flight are aborted through
  // poolSignal) and nothing is merged, so a failed run never writes a partial chronology.
  const modelResults = await mapPool(batches, budget.concurrency, async (batch, _index, poolSignal) => {
    const evidence = batch.map((x) => docBlock(x, docChars)).join("\n\n---\n\n");
    const raw = await generateJSON<{ events: RawEvent[] }>({ fast: true, instructions, input: evidence, schema: EVENTS_SCHEMA, name: "timeline_events", maxOutputTokens: Math.max(4_000, budget.maxOutputTokens), signal: poolSignal });
    const target = { kind: "timeline", label: `event extraction (${batch.map((x) => x.bates).join(", ")})`, matterId };
    const base = recordGeneration({ surface: "ediscovery.timeline", instructions, input: evidence, sources: documentSources(batch), model: aiConfig().fastModel, target, meta: { events: raw.events.length } });
    const checked = await verifyStructured(base, { label: "chronology events", output: raw.events, evidence, schema: { type: "array", items: EVENT_ITEM }, verify: opts.verify, signal: poolSignal, instructions: "A date must appear in, or be the date of, the cited document. Drop events whose Bates number is not in the evidence." }, target);
    finished += batch.length;
    opts.onProgress?.(Math.min(docs.length, finished), docs.length);
    return { raw, checked };
  }, opts.signal);
  for (const { raw, checked } of modelResults) {
    extracted += raw.events.length;
    dropped += Math.max(0, raw.events.length - checked.output.length);
    const existingEvents = [...d.timeline.find((e) => e.matterId === matterId), ...all];
    for (const e of checked.output) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date)) { dropped++; continue; }
      // Evidence contract: an event whose Bates does not resolve in this matter is excluded, never attached to another document.
      const src = resolveBatesInMatter(matterId, e.bates);
      if (!src) { dropped++; unresolved.push({ title: e.title, date: e.date, bates: e.bates }); audit("ai.verify", { kind: "timeline.event", label: e.title, matterId }, { method: "citations", decision: "excluded", bates: e.bates, reason: "Bates number not in this matter's review set" }); continue; }
      const cite = crossCheckCitations(e.bates, { bates: known });
      const sources: TimelineEvent["sources"] = [{ kind: "document", id: src.id, bates: src.bates, excerpt: e.excerpt }];
      // Cross-context: same date + near-identical title (or same Bates) already on the chronology → merge, do not twin.
      const dup = findNearDuplicateEvent(existingEvents, { date: e.date, title: e.title, sources });
      const eventProvenance = gateReview(applyCiteCheck({ ...checked.provenance, sources: documentSources([src]), confidence: Number.isFinite(e.confidence) ? e.confidence : undefined, review: undefined, duplicateOf: dup?.id }, cite));
      if (dup) {
        duplicates.push({ title: e.title, date: e.date, duplicateOf: dup.id });
        // union the source into the existing record (merge instead of skip), never overwrite a human's event.
        const stored = d.timeline.get(dup.id);
        if (stored && !stored.sources.some((s) => s.id === src.id)) d.timeline.put({ ...stored, sources: [...stored.sources, sources[0]] });
        audit("ai.verify", { kind: "timeline.event", id: dup.id, label: dup.title, matterId }, { method: "dedupe", mergedTitle: e.title, date: e.date, reason: "near-duplicate of an existing event; source merged" });
        continue;
      }
      if (eventProvenance.review?.status === "pending") needsReview++;
      const ev: TimelineEvent = { id: `tl_${nanoid(10)}`, matterId, date: e.date, precision: e.precision, title: e.title, description: e.description, category: e.category, significance: Math.min(5, Math.max(1, Math.round(e.significance))) as TimelineEvent["significance"], sources, personIds: e.people.map((n) => resolvePersonName(n, people)?.id).filter((x): x is string => !!x), createdBy: "ai", verified: false, provenance: eventProvenance };
      all.push(ev);
      existingEvents.push(ev);
    }
  }
  const res = mergeEvents(matterId, all);
  for (const ev of res.added) {
    attachProvenance({ kind: "timeline.event", recordId: ev.id, matterId, title: `${ev.date} — ${ev.title}`, href: `${tabHref(matterId, "timeline")}&event=${ev.id}`, provenance: ev.provenance! });
    audit("create", { kind: "timeline.event", id: ev.id, label: ev.title, matterId }, { by: "ai", date: ev.date, bates: ev.sources[0]?.bates, confidence: ev.provenance?.confidence, review: ev.provenance?.review?.status });
  }
  return { added: res.added, merged: res.merged + duplicates.length, extracted, dropped, duplicates, needsReview, unresolved };
}

// ---------------------------------------------------------------------------
// Who knew what, when
// ---------------------------------------------------------------------------

const ENTRY_ITEM = {
  type: "object",
  properties: {
    personName: { type: "string" },
    knew: { type: "string", description: "What this person knew or was told, precisely." },
    firstKnownDate: { type: "string", description: "ISO date of the earliest evidence" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    cites: { type: "array", items: { type: "object", properties: { cite: { type: "string", description: "Bates or witness page:line" }, sourceKind: { type: "string", enum: ["document", "deposition"] } }, required: ["cite", "sourceKind"] } },
  },
  required: ["personName", "knew", "firstKnownDate", "confidence", "cites"],
};

const KNOWLEDGE_SCHEMA = {
  type: "object",
  properties: {
    narrative: { type: "string", description: "One paragraph summarising the knowledge timeline across people." },
    entries: { type: "array", items: ENTRY_ITEM },
    confidence: { type: "number", description: "0..1 calibrated confidence that dates and attributions are right." },
  },
  required: ["narrative", "entries", "confidence"],
};

export type KnowledgeMapRecord = KnowledgeMap & { provenance?: Provenance; duplicateOf?: string };

type RawEntry = KnowledgeMap["entries"][number] & { personName: string };

export async function knowledgeMap(matterId: string, opts: { topic: string; signal?: AbortSignal } & VerifyOpt): Promise<KnowledgeMapRecord> {
  requireKey();
  const d = db();
  const cross = await crossAnalysis(matterId, { topic: opts.topic, k: 16 });
  const docs = cross.documents.map((x) => d.edocs.get(x.id)).filter((x): x is EDocument => !!x);
  const testimony = [...cross.testimony, ...cross.otherTestimony].map((t) => `${t.cite} (${t.date})\n${t.text}`).join("\n\n");
  const events = listEvents(matterId, { q: opts.topic.split(/\s+/)[0] }).slice(0, 25);
  const people = matterPeople(matterId);
  const instructions = `You are a litigation analyst at ${FIRM_NAME} in ${matterLine(matterId)}
${todayLine()}
Produce a "who knew what, when" map for the topic. For each person with evidence, state precisely what they knew, the earliest date the record shows it, and the cites. Distinguish direct knowledge (author or recipient) from inference. Do not invent people or dates.`;
  const evidence = `## Chronology\n${events.map((e) => `- ${e.date} — ${e.title} [${e.sources.map((s) => s.bates ?? s.cite ?? "").filter(Boolean).join(", ")}]`).join("\n") || "(none)"}\n\n## Testimony\n${clip(testimony, 30_000) || "(none)"}\n\n## Documents\n${docs.map((x) => docBlock(x, 2500)).join("\n\n---\n\n") || "(none)"}`;
  const input = `Topic: ${opts.topic}\n\n${evidence}`;
  const raw = await generateJSON<{ narrative: string; entries: RawEntry[]; confidence: number }>({ instructions, input, schema: KNOWLEDGE_SCHEMA, name: "knowledge_map", maxOutputTokens: 4000, signal: opts.signal });
  const id = `km_${nanoid(10)}`;
  const target = { kind: "knowledge-map", id, label: `knowledge map: ${opts.topic}`, matterId };
  const depIds = Array.from(new Set([...cross.testimony, ...cross.otherTestimony].map((t) => t.id)));
  let provenance = recordGeneration({ surface: "ediscovery.knowledgeMap", instructions, input, sources: [...documentSources(docs), ...depIds.map((x) => depositionSource(d.depositions.get(x)!))], confidence: raw.confidence, target, meta: { entries: raw.entries.length } });
  const checked = await verifyStructured(provenance, { label: "who-knew-what entries", output: raw.entries, evidence, schema: { type: "array", items: ENTRY_ITEM }, verify: opts.verify, signal: opts.signal, instructions: "Every cite must be a Bates number or page:line present in the evidence; firstKnownDate must be supported by that cite." }, target);
  provenance = checked.provenance;
  // Cross-context: entries that repeat an earlier map on the same topic (same person, cite and claim) are marked, and
  // within this map near-identical entries are collapsed.
  const prior = listKnowledgeMaps(matterId).filter((m) => m.topic.trim().toLowerCase() === opts.topic.trim().toLowerCase());
  const priorEntries = prior.flatMap((m) => m.entries);
  const entries: KnowledgeMap["entries"] = [];
  let collapsed = 0;
  for (const e of checked.output) {
    if (entries.some((x) => isDuplicateKnowledgeEntry(x, e))) { collapsed++; continue; }
    const p = resolvePersonName(e.personName, people);
    entries.push({ personId: p?.id, personName: p?.name ?? e.personName, knew: e.knew, firstKnownDate: e.firstKnownDate, confidence: e.confidence, cites: e.cites.map((c) => ({ ...c, sourceId: resolveCiteSourceId(matterId, c) })) });
  }
  entries.sort((a, b) => a.firstKnownDate.localeCompare(b.firstKnownDate));
  const overlap = entries.filter((e) => priorEntries.some((p) => isDuplicateKnowledgeEntry(p, e))).length;
  const pages = depIds.flatMap((x) => d.depositions.get(x)?.transcript.map((q) => q.page) ?? []);
  const cite = crossCheckCitations(entries.flatMap((e) => e.cites.map((c) => c.cite)).join("\n"), { bates: matterBates(matterId), pages });
  provenance = applyCiteCheck(provenance, cite);
  const entryConfidences = entries.map((e) => confidenceFromLevel(e.confidence)).filter((x): x is number => x != null);
  if (provenance.confidence == null && entryConfidences.length) provenance = { ...provenance, confidence: entryConfidences.reduce((a, b) => a + b, 0) / entryConfidences.length };
  const duplicateOf = prior.length && entries.length && overlap === entries.length ? prior[0].id : undefined;
  if (duplicateOf) provenance = { ...provenance, duplicateOf };
  provenance = gateReview(provenance);
  if (collapsed || overlap) audit("ai.verify", target, { method: "dedupe", collapsed, overlapWithPrior: overlap, duplicateOf });
  const map: KnowledgeMapRecord = { id, matterId, topic: opts.topic, createdAt: new Date().toISOString(), narrative: raw.narrative, entries, provenance, duplicateOf };
  saveKnowledgeMap(map);
  attachProvenance({ kind: "knowledge-map", recordId: id, matterId, title: `Who knew what — ${opts.topic}`, href: tabHref(matterId, "people"), provenance });
  return map;
}

/**
 * The source id a model cite points at, resolved only inside this matter: a Bates cite to one of the matter's
 * documents, a page:line cite to one of its transcripts. Unresolved cites keep `sourceId` undefined (the UI shows
 * them as unresolved); they are never mapped to the first document, another matter's document or the closest name.
 */
export function resolveCiteSourceId(matterId: string, c: { sourceKind: string; cite: string }): string | undefined {
  if (c.sourceKind === "document") return resolveBatesInMatter(matterId, c.cite)?.id;
  if (c.sourceKind === "deposition") return resolveWitnessInMatter(matterId, c.cite)?.id;
  return undefined;
}

export function exhibitDocs(dep: Deposition) { return exhibitDocuments(dep); }

// ---------------------------------------------------------------------------
// Story narrative draft
// ---------------------------------------------------------------------------

export interface StoryDraftResult { text: string; provenance: Provenance; unresolvedCites: string[] }

/**
 * Draft a narrative from a story's facts. The model may only use the facts and
 * their evidence; the draft is claim-verified against the cited documents and
 * transcripts, every Bates / page:line cite is cross-checked, low-confidence
 * output is gated for review and the provenance is attached to the story.
 */
export async function draftStoryNarrative(storyId: string, opts: { audience?: "brief" | "opening" | "memo"; signal?: AbortSignal } & VerifyOpt = {}): Promise<StoryDraftResult> {
  requireKey();
  const story = getStory(storyId);
  if (!story) throw Object.assign(new Error(`No story ${storyId}`), { status: 404 });
  if (!story.facts.length) throw Object.assign(new Error("The story has no facts to draft from"), { status: 400 });
  const d = db();
  const src = storySources(story);
  const docs = src.docs.map((x) => d.edocs.get(x.id)).filter((x): x is EDocument => !!x).slice(0, 16);
  const deps = src.depositions.map((x) => ({ dep: d.depositions.get(x.id)!, indexes: x.indexes })).filter((x) => !!x.dep);
  const audience = opts.audience ?? "memo";
  const form = audience === "opening" ? "an opening-statement narrative (plain, chronological, no citations in the prose but a bracketed cite after each paragraph)" : audience === "brief" ? "a statement of facts for a brief (numbered paragraphs, record cite after every sentence)" : "an internal factual memo (headed sections, cite after every factual sentence)";
  const instructions = `You are a senior litigator at ${FIRM_NAME} in ${matterLine(story.matterId)}
${todayLine()}
${LEGAL_STYLE_RULES}
Write ${form} from the numbered facts below. Use only those facts and the excerpts provided; every factual sentence carries the Bates number or witness page:line from the fact's evidence. Mark disputed facts as disputed. Do not add facts, dates or characterisations that are not in the record. Markdown.`;
  const input = `Story: ${story.title}${story.theme ? ` — ${story.theme}` : ""}

## Facts
${storyFactsText(story)}

## Documents cited
${docs.map((x) => docBlock(x, 2000)).join("\n\n---\n\n") || "(none)"}

## Testimony cited
${deps.map(({ dep, indexes }) => `### ${dep.witnessName}\n${transcriptText(dep, { indexes, maxChars: 8000 })}`).join("\n\n") || "(none)"}`;
  const res = await generateText({ instructions, input, maxOutputTokens: 4000, signal: opts.signal });
  const title = `Narrative — ${story.title}`;
  const target = { kind: "story", id: story.id, label: title, matterId: story.matterId };
  const sources: ProvenanceSource[] = [...documentSources(docs), ...deps.map(({ dep }) => depositionSource(dep))];
  let provenance = recordGeneration({ surface: "ediscovery.story", instructions, input, sources, target, usage: res.usage ? { input: res.usage.input_tokens, output: res.usage.output_tokens, total: res.usage.total_tokens } : undefined });
  const verifySources: VerifySource[] = [{ title: "Story facts", text: storyFactsText(story, 20_000) }, ...docVerifySources(docs, 2500), ...deps.map(({ dep, indexes }) => ({ title: `${dep.witnessName} deposition`, text: transcriptText(dep, { indexes, maxChars: 8000 }) }))];
  const pages = deps.flatMap(({ dep }) => dep.transcript.map((q) => q.page));
  const narrative = await verifyNarrative(provenance, { answer: res.text, sources: verifySources, cites: { bates: matterBates(story.matterId), pages }, verify: opts.verify, signal: opts.signal, maxClaims: 30 }, target);
  provenance = gateReview(narrative.provenance);
  updateStory(story.id, { narrative: { text: narrative.text, provenance, generatedAt: new Date().toISOString() } });
  attachProvenance({ kind: "story.draft", recordId: story.id, matterId: story.matterId, title, href: `${tabHref(story.matterId, "story")}&story=${story.id}`, provenance });
  return { text: narrative.text, provenance, unresolvedCites: narrative.unresolvedCites };
}
