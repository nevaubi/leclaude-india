import { Suspense } from "react";
import type { Metadata } from "next";
import { pageDb } from "@/lib/db/request";
import { CorpusHeaderSkeleton } from "@/components/corpus/corpus-header";
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
    <div className="flex h-full flex-col" aria-busy>
      <CorpusHeaderSkeleton />
      <div className="border-b px-4 pb-4 sm:px-6"><Skeleton className="h-9 w-full max-w-[760px]" /></div>
      <div className="mx-auto w-full max-w-[1180px] space-y-3 px-4 pt-4 sm:px-6">
        <Skeleton className="h-3.5 w-40" />
        <div className="grid gap-2.5 sm:grid-cols-4">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-[88px] rounded-lg" />)}</div>
        <Skeleton className="h-64 w-full rounded-lg" />
      </div>
    </div>
  );
}
