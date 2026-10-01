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
    <Suspense fallback={<div className="space-y-3 p-6"><Skeleton className="h-6 w-2/3" /><Skeleton className="h-80 w-full" /></div>}>
      <LawInstrumentView id={id} />
    </Suspense>
  );
}
