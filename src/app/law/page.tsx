import { Suspense } from "react";
import type { Metadata } from "next";
import { pageDb } from "@/lib/db/request";
import { LawPageSkeleton } from "@/components/corpus/law-skeletons";
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
  return <LawPageSkeleton variant="tiles" />;
}
