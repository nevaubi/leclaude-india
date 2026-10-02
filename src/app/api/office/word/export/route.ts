import { withDb } from "@/lib/db/request";
import { NextRequest } from "next/server";
import { jsonError } from "@/lib/ai/sse";
import { blobs } from "@/lib/db";
import type { OfficeComment } from "@/lib/types/domain";
import { getOfficeDoc, listComments } from "@/modules/office/shared/docs-service";
import type { DocSettings } from "@/modules/office/word/constants";
import { ensureBlockIds, type PMNode } from "@/modules/office/word/doc-model";
import { exportDocx, exportMarkdown, exportText } from "@/modules/office/word/export";
import { exportImageFetcher } from "@/modules/office/word/export-images";
import { isDocxMeta, type DocxImportedComment } from "@/modules/office/word/ooxml/types";
import { withAuth } from "@/lib/auth/route";
import { requirePrincipal } from "@/lib/auth/context";
import { can } from "@/lib/auth/policy";
import { refs } from "@/lib/auth/resources";
import { audit } from "@/lib/integrity/audit";
import { officeDocFromBody } from "@/modules/office/shared/route-auth";
import { assistantRecord, docBodyHash, exportCheckState, providerRole } from "@/modules/office/word/filing-check-server";
import { aiSurfacesFromMeta, appendixBlocks, declarationBlocks, dedupeSourceItems, exportCustomProps, type CheckState } from "@/modules/office/word/provenance";
import type { CustomProp } from "@/modules/office/word/ooxml/custom-props";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * Export provenance options (the Word editor sends these after its filing-check gate). A .docx exported without them
 * (document list, library, API) still carries the provenance properties, recording that no check ran and no gate was
 * shown; nothing is appended to its body.
 */
interface ProvenanceRequest {
  /** Append the visible "Declaration on use of AI tools" block (text editable by the user). */
  declaration?: { text?: string } | null;
  /** Append the provenance appendix (sources the drafting assistant consulted). */
  appendix?: boolean;
  /** The user's acknowledgement in the pre-export filing check gate. */
  acknowledgement?: { acknowledged?: boolean; docHash?: string; items?: number } | null;
}

interface Body { docId?: string; content?: PMNode; title?: string; format?: "docx" | "md" | "txt"; settings?: Partial<DocSettings>; changes?: "revisions" | "accepted"; includeComments?: boolean; provenance?: ProvenanceRequest | null }

/** Export a document. Body: { docId | content, title?, format: docx|md|txt, settings?, changes?: revisions|accepted, provenance? }. */
async function handlePOST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as Body | null;
  if (!body) return jsonError("Invalid body");
  const principal = requirePrincipal();
  let content = body.content;
  let title = body.title;
  let settings = body.settings;
  let comments: OfficeComment[] = [];
  let basePackage: Uint8Array | null = null;
  let importedComments: DocxImportedComment[] | undefined;
  let matterId: string | undefined;
  let aiSurfaces: string[] = [];
  if (body.docId) {
    const doc = getOfficeDoc(body.docId);
    if (!doc) return jsonError("Document not found", 404);
    matterId = doc.matterId ?? undefined;
    aiSurfaces = aiSurfacesFromMeta(doc.meta as Record<string, unknown> | undefined);
    content = content ?? (doc.content as PMNode);
    title = title ?? doc.title;
    settings = settings ?? ((doc.meta?.settings as Partial<DocSettings> | undefined) ?? undefined);
    if (body.includeComments !== false) comments = listComments(body.docId);
    // Imported .docx: write back into the original package (styles, theme, headers/footers, custom XML stay byte-identical).
    const docxMeta = doc.meta?.docx;
    const originalId = typeof doc.meta?.originalBlobId === "string" ? doc.meta.originalBlobId : null;
    if (isDocxMeta(docxMeta) && originalId) {
      const original = blobs.get(originalId);
      if (original) basePackage = new Uint8Array(original.bytes);
      if (body.includeComments !== false) importedComments = docxMeta.comments;
    }
  }
  if (!content || content.type !== "doc") return jsonError("`content` (ProseMirror doc) or `docId` is required");
  let doc = ensureBlockIds(content);
  const safe = (title ?? "document").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-") || "document";
  const format = body.format ?? "docx";

  // ---- provenance: declaration, appendix, custom properties (all bound to the body hash before anything is appended)
  let customProps: CustomProp[] | undefined;
  const prov = body.provenance && typeof body.provenance === "object" ? body.provenance : null;
  let auditMeta: Record<string, unknown> = {};
  if (prov) {
    const hash = docBodyHash(doc);
    const { state: check, report } = await exportCheckState(doc);
    const assistant = assistantRecord(body.docId);
    const sources = dedupeSourceItems(assistant.sources);
    const extra: PMNode[] = [];
    const declarationText = prov.declaration && typeof prov.declaration === "object" ? String(prov.declaration.text ?? "") : null;
    if (declarationText !== null) extra.push(...declarationBlocks(declarationText, check));
    if (prov.appendix) extra.push(...appendixBlocks(sources, assistant.turns));
    if (extra.length) doc = ensureBlockIds({ ...doc, content: [...(doc.content ?? []), ...extra] });
    const ack = prov.acknowledgement && typeof prov.acknowledgement === "object"
      ? { acknowledged: prov.acknowledgement.acknowledged === true, by: principal.name || principal.id, at: new Date().toISOString(), items: Math.max(0, Math.floor(Number(prov.acknowledgement.items) || 0)), matchesExport: prov.acknowledgement.docHash === hash }
      : null;
    customProps = exportCustomProps({
      exportedAt: new Date().toISOString(), docHash: hash, check: check as CheckState, gate: "editor", openIssues: report ? report.issues.length : undefined, acknowledgement: ack,
      assistantTurns: assistant.turns, aiSurfaces, providerRole: providerRole(), models: assistant.models,
      declaration: declarationText !== null, appendix: { included: Boolean(prov.appendix), sources: sources.length },
    });
    auditMeta = {
      docHash: hash, gate: "editor", citationCheck: check.state === "not_run" ? { state: "not_run", reason: check.reason } : { state: check.state, ...check.counts },
      acknowledgement: ack ? { acknowledged: ack.acknowledged, items: ack.items, matchesExport: ack.matchesExport } : null, openIssues: report ? report.issues.length : null,
      declaration: declarationText !== null, appendix: Boolean(prov.appendix),
    };
  } else if (format === "docx") {
    // No gate was shown for this export: the file says so (check not run, nothing acknowledged) instead of saying nothing.
    const hash = docBodyHash(doc);
    const assistant = assistantRecord(body.docId);
    const check: CheckState = { state: "not_run", reason: "exported without the Word editor's filing check; no citation check ran for this export" };
    customProps = exportCustomProps({
      exportedAt: new Date().toISOString(), docHash: hash, check, gate: "none", acknowledgement: null, assistantTurns: assistant.turns, aiSurfaces, providerRole: providerRole(), models: assistant.models,
      declaration: false, appendix: { included: false, sources: 0 },
    });
    auditMeta = { docHash: hash, gate: "none", citationCheck: { state: "not_run", reason: check.reason }, acknowledgement: null };
  }
  const record = () => {
    if (!prov && format !== "docx") return;
    try { audit("export", { kind: "officeDoc", id: body.docId, label: title ?? "Document", matterId }, { format, ...auditMeta }, { id: principal.id, name: principal.name }); } catch (e) { console.warn("[word export] audit failed", (e as Error).message); }
  };

  if (format === "md") { record(); return new Response(exportMarkdown(doc, title ?? "Document"), { headers: { "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": `attachment; filename="${safe}.md"` } }); }
  if (format === "txt") { record(); return new Response(exportText(doc), { headers: { "Content-Type": "text/plain; charset=utf-8", "Content-Disposition": `attachment; filename="${safe}.txt"` } }); }
  try {
    let mode = "fresh";
    const fetchImage = exportImageFetcher({
      canReadBlob: (id) => can(principal, "read", refs.blob(id)),
      signal: req.signal,
      onSkip: (src, reason, detail) => console.warn(JSON.stringify({ level: "warn", event: "word.export.image_skipped", reason, detail, src: src.startsWith("data:") ? "data:" : src })),
    });
    const buf = await exportDocx(doc, { title: title ?? "Document", settings, comments, fetchImage, changes: body.changes ?? "revisions", basePackage, importedComments, customProps, onReport: (r) => { mode = r.mode; if (r.warnings.length) console.warn("[word export]", r.warnings.join("; ")); } });
    record();
    return new Response(new Uint8Array(buf), { headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "Content-Disposition": `attachment; filename="${safe}.docx"`, "Content-Length": String(buf.byteLength), "X-Docx-Export-Mode": mode } });
  } catch (e) {
    return jsonError(`Export failed: ${(e as Error).message}`, 500);
  }
}

export const POST = withDb(withAuth(handlePOST, { action: "export", resource: officeDocFromBody }));
