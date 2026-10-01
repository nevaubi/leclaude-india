import "server-only";
import { db } from "@/lib/db";
import type { OfficeKind } from "@/lib/types/domain";
import { aiConfig } from "@/lib/ai/config";
import { allTemplates } from "@/modules/office/shared/template-registry";
import { syncOfficeDocs } from "@/modules/library/service";
import { currentPrincipal } from "@/lib/auth/context";
import { hasMatterAccess } from "@/lib/auth/policy";
import type { OfficeDocSummary, OfficeHomeData, OfficeTemplateSummary } from "./types";
import { OFFICE_KINDS } from "./types";

/** Matter filter for the signed-in principal: documents on a matter they cannot open are never listed. */
function matterVisible(): (matterId: string | undefined | null) => boolean {
  const p = currentPrincipal();
  return (matterId) => !matterId || !p || hasMatterAccess(p, matterId);
}

export function listOfficeDocSummaries(opts: { kind?: OfficeKind; matterId?: string; q?: string; limit?: number } = {}): OfficeDocSummary[] {
  syncOfficeDocs();
  const d = db();
  const people = new Map(d.people.all().map((p) => [p.id, p.name]));
  const matters = new Map(d.matters.all().map((m) => [m.id, m.shortName]));
  const versionCounts = new Map<string, number>();
  for (const v of d.officeVersions.all()) versionCounts.set(v.docId, (versionCounts.get(v.docId) ?? 0) + 1);
  const commentCounts = new Map<string, number>();
  for (const c of d.officeComments.all()) if (!c.resolved) commentCounts.set(c.docId, (commentCounts.get(c.docId) ?? 0) + 1);
  const libByDoc = new Map<string, { id: string; parentId: string | null }>();
  for (const l of d.library.all()) if (l.officeDocId && !libByDoc.has(l.officeDocId)) libByDoc.set(l.officeDocId, { id: l.id, parentId: l.parentId });
  const folderNames = new Map(d.library.all().filter((l) => l.type === "folder").map((l) => [l.id, l.name]));
  const q = opts.q?.trim().toLowerCase();
  const visible = matterVisible();
  const docs = d.officeDocs.list({
    where: (x) => visible(x.matterId) && OFFICE_KINDS.includes(x.kind) && (!opts.kind || x.kind === opts.kind) && (!opts.matterId || x.matterId === opts.matterId) && (!q || x.title.toLowerCase().includes(q) || (x.tags ?? []).some((t) => t.toLowerCase().includes(q))),
    sortBy: "updatedAt",
    direction: "desc",
    limit: opts.limit,
  });
  return docs.map(({ content: _c, ...doc }) => {
    void _c;
    const lib = libByDoc.get(doc.id);
    return {
      ...doc,
      versionCount: versionCounts.get(doc.id) ?? 0,
      commentCount: commentCounts.get(doc.id) ?? 0,
      matterShortName: doc.matterId ? matters.get(doc.matterId) : undefined,
      ownerName: doc.createdById ? people.get(doc.createdById) : undefined,
      libraryItemId: lib?.id,
      folderName: lib?.parentId ? folderNames.get(lib.parentId) : undefined,
    };
  });
}

export function listTemplateSummaries(kind?: OfficeKind): OfficeTemplateSummary[] {
  return allTemplates().filter((t) => OFFICE_KINDS.includes(t.kind) && (!kind || t.kind === kind)).map(({ build: _b, ...rest }) => { void _b; return rest; });
}

export function officeHomeData(kind?: OfficeKind): OfficeHomeData {
  const d = db();
  const all = listOfficeDocSummaries();
  const counts = { word: 0, sheet: 0, slides: 0, pdf: 0 } as Record<OfficeKind, number>;
  for (const doc of all) counts[doc.kind]++;
  return {
    docs: kind ? all.filter((x) => x.kind === kind) : all,
    templates: listTemplateSummaries(),
    matters: d.matters.list({ sortBy: "shortName" }).filter((m) => matterVisible()(m.id)).map((m) => ({ id: m.id, shortName: m.shortName, name: m.name })),
    counts,
    aiConfigured: aiConfig().hasKey,
    generatedAt: new Date().toISOString(),
  };
}
