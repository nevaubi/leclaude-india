import { pageDb } from "@/lib/db/request";
import * as React from "react";
import { redirect } from "next/navigation";
import { hiddenSurfaceRedirect } from "@/lib/features";
import { Radar } from "lucide-react";
import { PageTopbar } from "@/components/shell/page-topbar";
import { IntelNav } from "@/modules/intel/components/intel-nav";
import { IntelEmptyState } from "@/modules/intel/components/intel-empty";
import { intelAnalysisBootstrap } from "@/modules/intel/analysis/bootstrap";
import { intelDocuments, intelSources } from "@/modules/intel/store";

export const dynamic = "force-dynamic";

/**
 * /intel shell: the section navigation under the 44px top bar, then the page.
 * Each page renders its own PageTopbar (title + context) and owns its scroll.
 * With no intelligence records (a new workspace, no source has run) every
 * section would be empty, so the shell shows how to connect a source instead.
 */
export default async function IntelLayout({ children }: { children: React.ReactNode }) {
  // Hidden in the India product (its sources are US dockets and the Federal Register): every /intel page lands on
  // Home. Settings → Data & automation (sources, jobs, health) stays reachable; NEXT_PUBLIC_ENABLE_INTEL=1 restores it.
  const to = hiddenSurfaceRedirect("intel");
  if (to) redirect(to);
  await pageDb();
  intelAnalysisBootstrap();
  if (intelDocuments().count() === 0) {
    const sources = intelSources().all();
    return (
      <div className="flex h-full min-h-0 flex-col">
        <PageTopbar icon={<Radar />} title="Intelligence" />
        <IntelEmptyState enabledSources={sources.filter((s) => s.enabled).length} totalSources={sources.length} />
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <IntelNav />
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
