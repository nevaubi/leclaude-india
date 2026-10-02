import "server-only";
import { defineTool, ToolExecutionError, type ToolContext, type ToolDef } from "@/lib/ai/tools";
import { indiaResearchTools } from "@/lib/ai/toolkit/india";
import { getLibraryItemTool, searchLibraryTool } from "@/lib/ai/toolkit/internal";
import type { Principal } from "@/lib/auth/types";
import { listDocSets, readDocPassage, searchDocSets } from "@/modules/documents/server";
import { reviewRowsForChat } from "@/modules/documents/server/review";
import { parseDocSourceId, type DocSearchHit } from "@/modules/documents/types";
import { DEFAULT_KNOWLEDGE, MAX_DOC_SETS, type ChatKnowledge, type ChatRequest } from "../types";

/**
 * The Chat knowledge switch on the server: request parsing (backward compatible with `tools.search`), document-set
 * authorization against the facade (fail closed), and the function tools each switch adds. The model never decides
 * which sets it may search: the tools close over the validated set ids.
 */

/** Library tools only (never the e-discovery / matter-evidence tools in INTERNAL_TOOLS). */
export const LIBRARY_TOOLS = [searchLibraryTool, getLibraryItemTool] as ToolDef<never, unknown>[];

/** Parse the request's knowledge switch. Returns an error string for a malformed body. */
export function parseKnowledge(body: Pick<ChatRequest, "knowledge" | "tools"> | null | undefined): ChatKnowledge | string {
  const legacyWeb = typeof body?.tools?.search === "boolean" ? body.tools.search : DEFAULT_KNOWLEDGE.web;
  const k = body?.knowledge;
  if (k == null) return { ...DEFAULT_KNOWLEDGE, web: legacyWeb, docSetIds: [] };
  if (typeof k !== "object" || Array.isArray(k)) return "knowledge must be an object";
  const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
  let docSetIds: string[] = [];
  if (k.docSetIds != null) {
    if (!Array.isArray(k.docSetIds) || k.docSetIds.some((x) => typeof x !== "string")) return "knowledge.docSetIds must be a list of ids";
    docSetIds = Array.from(new Set(k.docSetIds.map((x) => x.trim()).filter((x) => x && x.length <= 128)));
    if (docSetIds.length > MAX_DOC_SETS) return `At most ${MAX_DOC_SETS} document sets per message`;
  }
  return { web: bool(k.web, legacyWeb), law: bool(k.law, DEFAULT_KNOWLEDGE.law), library: bool(k.library, DEFAULT_KNOWLEDGE.library), docSetIds };
}

export interface AuthorizedKnowledge {
  knowledge: ChatKnowledge;
  /** Validated sets (id → name) the document tools may search. */
  sets: { id: string; name: string }[];
  /** Notes for the user (shown as steps): sets dropped, facade unavailable. */
  notes: string[];
}

/**
 * Keep only the document sets the principal may read. Unknown ids are dropped; if the facade fails, all sets are
 * dropped (fail closed) and the turn continues without them.
 */
export async function authorizeKnowledge(principal: Principal, k: ChatKnowledge): Promise<AuthorizedKnowledge> {
  if (!k.docSetIds.length) return { knowledge: k, sets: [], notes: [] };
  let readable: { id: string; name: string }[];
  try {
    readable = (await listDocSets(principal)).map((s) => ({ id: s.id, name: s.name }));
  } catch {
    return { knowledge: { ...k, docSetIds: [] }, sets: [], notes: ["Document sets unavailable"] };
  }
  const byId = new Map(readable.map((s) => [s.id, s]));
  const sets = k.docSetIds.map((id) => byId.get(id)).filter((s): s is { id: string; name: string } => Boolean(s));
  const dropped = k.docSetIds.length - sets.length;
  const notes = dropped ? [`${dropped} document set${dropped === 1 ? " is" : "s are"} not available and ${dropped === 1 ? "was" : "were"} skipped`] : [];
  return { knowledge: { ...k, docSetIds: sets.map((s) => s.id) }, sets, notes };
}

/** In-app link to a passage in the Documents workspace. */
export function docPassageUrl(hit: Pick<DocSearchHit, "setId" | "fileId" | "page">): string {
  return `/documents/${encodeURIComponent(hit.setId)}?tab=files&file=${encodeURIComponent(hit.fileId)}${hit.page ? `&page=${hit.page}` : ""}`;
}

export function docPassageTitle(hit: Pick<DocSearchHit, "fileName" | "page">): string {
  return `${hit.fileName}${hit.page ? `, p. ${hit.page}` : ""}`;
}

function principalOf(ctx: ToolContext): Principal {
  if (!ctx.principal) throw new ToolExecutionError("unauthorized", "Sign in to search documents");
  return ctx.principal;
}

function emitHits(ctx: ToolContext, hits: DocSearchHit[], tool: string, query?: string) {
  if (!hits.length) return;
  const retrievedAt = new Date().toISOString();
  ctx.emit({ type: "evidence", evidence: hits.map((h, i) => ({ source: h.source, kind: "document", provider: "documents", tool, query, rank: i + 1, score: h.score, documentId: h.fileId, page: h.page ?? undefined, chunkIndex: h.idx, url: docPassageUrl(h), retrievedAt })) });
  for (const h of hits) ctx.emit({ type: "citation", citation: { title: docPassageTitle(h), url: docPassageUrl(h), source: h.source } });
}

/** search_documents / read_document_passage / review_rows bound to the validated sets. */
export function documentTools(sets: { id: string; name: string }[]): ToolDef<never, unknown>[] {
  const setIds = sets.map((s) => s.id);
  const allowed = new Set(setIds);
  const names = sets.map((s) => s.name).join(", ");
  const search = defineTool<{ query: string; limit?: number }>({
    name: "search_documents",
    description: `Full-text search of the user's selected document sets (${names}). Returns passages as search_result blocks with a stable source (docs://<setId>/<fileId>/p/<page>#<chunk>), the file name and page. Cite the file and page of every passage you rely on. No hit means the documents do not establish the point; say so rather than guessing.`,
    parameters: { type: "object", properties: { query: { type: "string", description: "Words or phrase to find" }, limit: { type: "integer", description: "Default 8, max 20" } }, required: ["query"] },
    timeoutMs: 20_000,
    maxResultChars: 24_000,
    access: "read",
    label: (a) => `Searching your documents: ${a.query}`,
    async execute(args, ctx) {
      const principal = principalOf(ctx);
      const limit = Math.min(Math.max(1, Math.floor(args.limit ?? 8)), 20);
      const hits = (await searchDocSets(principal, setIds, String(args.query ?? ""), { limit })).filter((h) => allowed.has(h.setId)).slice(0, limit);
      emitHits(ctx, hits, "search_documents", args.query);
      return {
        count: hits.length,
        results: hits.map((h) => ({ type: "search_result" as const, source: h.source, title: docPassageTitle(h), content: [h.text.length > 1500 ? `${h.text.slice(0, 1500)} …` : h.text], file: h.fileName, page: h.page })),
        ...(hits.length ? {} : { note: "No passage in the selected document sets matched. Try other words; if nothing is found, say the documents do not establish this." }),
      };
    },
  });
  const read = defineTool<{ source: string }>({
    name: "read_document_passage",
    description: "Read one passage from the selected document sets by its source id (docs://…, from search_documents), with the surrounding text on the same page.",
    parameters: { type: "object", properties: { source: { type: "string", description: "Source id returned by search_documents" } }, required: ["source"] },
    timeoutMs: 15_000,
    maxResultChars: 20_000,
    access: "read",
    label: () => "Reading a document passage",
    async execute(args, ctx) {
      const principal = principalOf(ctx);
      const parsed = parseDocSourceId(String(args.source ?? ""));
      if (!parsed) throw new ToolExecutionError("invalid_args", "Use a source id returned by search_documents");
      if (!allowed.has(parsed.setId)) throw new ToolExecutionError("unauthorized", "That passage is not in the selected document sets");
      const r = await readDocPassage(principal, args.source);
      if (!r || r.hit.setId !== parsed.setId) throw new ToolExecutionError("not_found", "No such passage");
      emitHits(ctx, [r.hit], "read_document_passage");
      return { type: "search_result" as const, source: r.hit.source, title: docPassageTitle(r.hit), content: [r.hit.text, ...(r.context ? [r.context] : [])], file: r.hit.fileName, page: r.hit.page };
    },
  });
  const reviewRows = defineTool<{ reviewId?: string; issue?: string; docType?: string; privilege?: string; coding?: string; q?: string; limit?: number }>({
    name: "review_rows",
    description: `Read the document-review table of the selected document sets (${names}): one row per file with its document type, importance, summary, issue relevance, privilege screen, extracted column values (each with page and quoteFound = the quote was found verbatim in the file) and the reviewer's coding. Without reviewId the most recent review is used; the result lists the available reviews. Filters: issue (issue id, at least low relevance), docType, privilege (possible|likely), coding (key|relevant|not_relevant|privileged|needs_review|uncoded|stale), q (words). Values with quoteFound false are unverified model output: say so. Privilege flags are suggestions, not decisions.`,
    parameters: {
      type: "object",
      properties: {
        reviewId: { type: "string", description: "Review id (from a previous result); omit for the most recent review" },
        issue: { type: "string", description: "Only rows relevant to this issue id" },
        docType: { type: "string", description: "Only this document type" },
        privilege: { type: "string", enum: ["possible", "likely"], description: "Only rows with this privilege flag" },
        coding: { type: "string", enum: ["key", "relevant", "not_relevant", "privileged", "needs_review", "uncoded", "stale"], description: "Only rows with this coding" },
        q: { type: "string", description: "Words to match in file name, summary and values" },
        limit: { type: "integer", description: "Default 15, max 40" },
      },
      required: [],
    },
    timeoutMs: 20_000,
    maxResultChars: 24_000,
    access: "read",
    label: () => "Reading the document review",
    async execute(args, ctx) {
      const principal = principalOf(ctx);
      const out = await reviewRowsForChat(principal, setIds, { reviewId: args.reviewId || undefined, issue: args.issue || undefined, docType: args.docType || undefined, privilege: args.privilege || undefined, coding: args.coding || undefined, q: args.q || undefined, limit: Number.isFinite(Number(args.limit)) ? Number(args.limit) : undefined });
      if (out.review && !allowed.has(out.review.setId)) throw new ToolExecutionError("unauthorized", "That review is not in the selected document sets");
      if (args.reviewId && !out.review) throw new ToolExecutionError("not_found", "No such review in the selected document sets");
      return out.review ? out : { ...out, note: "No review has been run on the selected document sets." };
    },
  });
  return [search, read, reviewRows] as ToolDef<never, unknown>[];
}

/** Every function tool the knowledge switch adds for this turn. */
export function knowledgeTools(k: ChatKnowledge, sets: { id: string; name: string }[]): ToolDef<never, unknown>[] {
  const out: ToolDef<never, unknown>[] = [];
  if (k.law) out.push(...(indiaResearchTools() as ToolDef<never, unknown>[]));
  if (k.library) out.push(...LIBRARY_TOOLS);
  const valid = sets.filter((s) => k.docSetIds.includes(s.id));
  if (valid.length) out.push(...documentTools(valid));
  return out;
}
