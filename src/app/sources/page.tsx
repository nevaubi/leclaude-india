import { Suspense } from "react";
import type { Metadata } from "next";
import { pageDb } from "@/lib/db/request";
import { Skeleton } from "@/components/ui/skeleton";
import { SourcesLibrary } from "@/modules/official-ui/components/sources-library";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Official sources" };

/**
 * /sources?tab=search|browse|coverage&q=&source=&kind=&forum=&from=&to= — the official sources library (data from
 * /api/official, /api/official/search and /api/official/documents; authorization is enforced by those routes).
 */
export default async function Page() {
  await pageDb();
  return (
    <Suspense fallback={<div className="flex h-full flex-col" aria-busy><div className="space-y-2 border-b px-6 pb-3 pt-3"><Skeleton className="h-4 w-40" /><Skeleton className="h-3 w-72" /></div><div className="mx-auto w-full max-w-[920px] space-y-3 px-6 py-5"><Skeleton className="h-8 w-full" /><Skeleton className="h-20 w-full" /><Skeleton className="h-20 w-full" /></div></div>}>
      <SourcesLibrary />
    </Suspense>
  );
}
