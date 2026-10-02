import type * as React from "react";
import { redirect } from "next/navigation";
import { hiddenSurfaceRedirect } from "@/lib/features";

/**
 * Workflows are hidden in the India product (NEXT_PUBLIC_ENABLE_WORKFLOWS=1 brings them back): /workflows,
 * /workflows/[id], /workflows/[id]/start and /workflows/runs/** land on Home. Only the pages are hidden; the engine,
 * the scheduler (started by instrumentation), the /api/workflows routes and the jobs other modules run are untouched.
 */
export default function WorkflowsLayout({ children }: { children: React.ReactNode }) {
  const to = hiddenSurfaceRedirect("workflows");
  if (to) redirect(to);
  return children;
}
