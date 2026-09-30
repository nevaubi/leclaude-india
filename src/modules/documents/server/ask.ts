import "server-only";
import type { Principal } from "@/lib/auth/types";
import { runAgent } from "@/lib/ai/agent";
import type { SearchResultBlock } from "@/lib/ai/providers/types";
import { parseCiteMarkers } from "@/modules/search/engine/markers";
import type { DocAnswer, DocCitation, DocSearchHit } from "../types";
import { DocsError, loadSet } from "./access";
import { retrievePassages } from "./search";
import { docStore } from "./store";

/**
 * Ask a question of a document set. Passages are retrieved in code and handed to the model as citation-native
 * evidence (no tools); the answer's [n] markers are mapped back to passages in code. Markers that name no supplied
 * passage are listed as unresolved, never re-bound to a nearby passage. With no passages there is no model call.
 */

export const NO_EVIDENCE_ANSWER = "The documents in this set do not establish this.";
export const ASK_PASSAGES = 14;

export type AskEvent =
  | { type: "status"; message: string }
  | { type: "passages"; count: number; mode: "whole" | "search" }
  | { type: "delta"; text: string }
  | { type: "done"; answer: DocAnswer };

export const ASK_INSTRUCTIONS = [
  "You answer questions about a set of documents uploaded by a lawyer, using ONLY the numbered passages supplied as sources.",
  "Rules:",
  "- Use only what the passages say. No outside knowledge, no assumptions about facts the passages do not state.",
  "- Cite every factual sentence with the number of the passage that supports it in square brackets, e.g. [2] or [1][4]. Cite only passage numbers you were given.",
  "- Keep names, dates, amounts and defined terms exactly as the passages give them; quote short key phrases verbatim where precision matters.",
  "- If the passages answer only part of the question, answer that part and say plainly what the documents do not establish.",
  `- If nothing in the passages answers the question, reply exactly: "${NO_EVIDENCE_ANSWER}" and, in one sentence, what would be needed.`,
  "- Passages marked (OCR) were transcribed from scanned pages by a model and may contain transcription errors; say so if a point turns on their exact wording.",
  "- Be concise and direct: short paragraphs or a short list, no preamble, no closing summary.",
].join("\n");

export function passageTitle(h: DocSearchHit, n: number): string {
  return `[${n}] ${h.fileName}${h.page != null ? `, page ${h.page}` : ""}${h.ocr ? " (OCR)" : ""}`;
}

export function evidenceBlocks(hits: DocSearchHit[]): SearchResultBlock[] {
  return hits.map((h, i) => ({ type: "search_result", source: h.source, title: passageTitle(h, i + 1), content: [h.text], citationsEnabled: true }));
}

/** Map [n] markers in an answer to the passages supplied; unknown numbers are returned as unresolved. */
export function mapMarkers(answer: string, hits: DocSearchHit[]): { citations: DocCitation[]; unresolved: number[] } {
  const nums = Array.from(new Set(parseCiteMarkers(answer).map((m) => m.n))).sort((a, b) => a - b);
  const citations: DocCitation[] = [];
  const unresolved: number[] = [];
  for (const n of nums) {
    const h = hits[n - 1];
    if (!h || n < 1) { unresolved.push(n); continue; }
    citations.push({ n, source: h.source, fileId: h.fileId, fileName: h.fileName, page: h.page, snippet: h.text.replace(/\s+/g, " ").trim().slice(0, 320) });
  }
  return { citations, unresolved };
}

export interface AskInput { question?: unknown; fileIds?: unknown }

export async function askDocSet(principal: Principal, setId: string, input: AskInput, emit: (e: AskEvent) => void, signal?: AbortSignal): Promise<DocAnswer> {
  const started = Date.now();
  const set = await loadSet(principal, setId, "read");
  const question = typeof input.question === "string" ? input.question.trim() : "";
  if (!question) throw new DocsError("question is required", 422, "invalid");
  if (question.length > 4000) throw new DocsError("The question is too long", 422, "invalid");
  const fileIds = Array.isArray(input.fileIds) ? input.fileIds.filter((x): x is string => typeof x === "string" && !!x).slice(0, 500) : undefined;

  const store = await docStore();
  emit({ type: "status", message: "Searching the documents" });
  const { hits, mode } = await retrievePassages(store, [set.id], question, { limit: ASK_PASSAGES, fileIds });
  emit({ type: "passages", count: hits.length, mode });

  if (!hits.length) {
    const answer: DocAnswer = { question, answer: NO_EVIDENCE_ANSWER, citations: [], unresolved: [], noEvidence: true, passagesSearched: 0, durationMs: Date.now() - started };
    emit({ type: "delta", text: NO_EVIDENCE_ANSWER });
    return answer;
  }

  emit({ type: "status", message: `Reading ${hits.length} passage${hits.length === 1 ? "" : "s"}` });
  const prompt = [
    `Question: ${question}`,
    "",
    `Passages (${mode === "whole" ? "every passage in the selected documents" : `the ${hits.length} most relevant passages`}), cite by number:`,
    ...hits.map((h, i) => passageTitle(h, i + 1)),
  ].join("\n");
  let model: string | undefined;
  const result = await runAgent({
    instructions: ASK_INSTRUCTIONS,
    input: prompt,
    evidence: evidenceBlocks(hits),
    taskType: "synthesize",
    matterId: set.matterId ?? undefined,
    maxSteps: 1,
    signal,
    metadata: { surface: "documents.ask" },
    onEvent: (e) => {
      if (e.type === "start") model = e.model;
      else if (e.type === "text.delta" && e.delta) emit({ type: "delta", text: e.delta });
    },
  });
  const text = (result.text ?? "").trim();
  const { citations, unresolved } = mapMarkers(text, hits);
  return { question, answer: text, citations, unresolved, noEvidence: false, passagesSearched: hits.length, model, durationMs: Date.now() - started };
}
