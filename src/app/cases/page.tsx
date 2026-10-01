import { Suspense } from "react";
import type { Metadata } from "next";
import { pageDb } from "@/lib/db/request";
import { Skeleton } from "@/components/ui/skeleton";
import { CaseDirectory } from "@/modules/caselaw/components/case-directory";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Case law" };

/** /cases?q=&court=&from=&to=&judge=&disposal=&sort= — the case law directory (data from /api/cases*). */
export default async function Page() {
  await pageDb();
  return (
    <Suspense fallback={<DirectorySkeleton />}>
      <CaseDirectory />
    </Suspense>
  );
}

function DirectorySkeleton() {
  return (
    <div className="flex h-full flex-col gap-2 p-4">
      <Skeleton className="h-5 w-40" />
      <Skeleton className="h-3 w-2/3" />
      <Skeleton className="h-7 w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}
