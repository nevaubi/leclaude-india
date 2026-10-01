import { Suspense } from "react";
import type { Metadata } from "next";
import { pageDb } from "@/lib/db/request";
import { EmptyState } from "@/components/ui/misc";
import { Skeleton } from "@/components/ui/skeleton";
import { LawInstrumentView } from "@/modules/law/components/law-instrument";
import { lawIdFromSegments } from "@/modules/law/shared";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Statute" };

type Props = { params: Promise<{ id: string[] }> };

/** /law/<actId>[?s=<section>&v=<variant>] — one Act or regulation with its sections (data from /api/law/<actId>). */
export default async function Page({ params }: Props) {
  await pageDb();
  const id = lawIdFromSegments((await params).id);
  if (!id) {
    return <div className="flex h-full items-center justify-center p-6"><EmptyState title="Not an instrument id" description="Open the statutes directory to find an Act or regulation." /></div>;
  }
  return (
    <Suspense fallback={<div className="flex h-full flex-col" aria-busy><div className="space-y-2 px-4 pb-3 pt-3 sm:px-6"><Skeleton className="h-3 w-28" /><Skeleton className="h-6 w-[min(560px,80%)]" /><Skeleton className="h-3.5 w-[min(420px,60%)]" /></div><div className="grid flex-1 border-t md:grid-cols-[296px_1fr]"><div className="hidden border-r md:block" /><div className="mx-auto w-full max-w-[76ch] space-y-3 px-6 py-6"><Skeleton className="h-6 w-2/3" /><Skeleton className="h-64 w-full" /></div></div></div>}>
      <LawInstrumentView id={id} />
    </Suspense>
  );
}
