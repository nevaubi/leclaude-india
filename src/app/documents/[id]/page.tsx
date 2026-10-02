import type { Metadata } from "next";
import * as React from "react";
import { pageDb } from "@/lib/db/request";
import { Skeleton } from "@/components/ui/skeleton";
import { SetWorkspace } from "@/modules/documents/components/set-workspace";
import { WORKSPACE_TABS, type WorkspaceTab } from "@/modules/documents/components/format";
import { pagePrincipal, visibleMatters } from "../_lib/page-data";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Document set" };

/** /documents/<setId>?tab=files|ask|facts|timeline|review|drafting[&review=<reviewId>][&tool=dates|paperbook|reply|defects]. The set itself loads through the authorized API (404 → not found or no access). */
export default async function Page({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string }> }) {
  await pageDb();
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const tab: WorkspaceTab = (WORKSPACE_TABS as readonly string[]).includes(sp.tab ?? "") ? (sp.tab as WorkspaceTab) : "files";
  const principal = await pagePrincipal(`/documents/${encodeURIComponent(id)}`);
  return (
    <React.Suspense fallback={<div className="space-y-2 p-3"><Skeleton className="h-9" /><Skeleton className="h-64" /></div>}>
      <SetWorkspace key={id} setId={id} initialTab={tab} matters={visibleMatters(principal)} />
    </React.Suspense>
  );
}
