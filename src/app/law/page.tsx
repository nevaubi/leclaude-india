import { Suspense } from "react";
import type { Metadata } from "next";
import { pageDb } from "@/lib/db/request";
import { Skeleton } from "@/components/ui/skeleton";
import { LawDirectory } from "@/modules/law/components/law-directory";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Statutes" };

/** /law?q=&mode=sections&j=&state=&reg=&status=&kind=&from=&to=&sort= — the statutes directory (data from /api/law*). */
export default async function Page() {
  await pageDb();
  return (
    <Suspense fallback={<DirectorySkeleton />}>
      <LawDirectory />
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
