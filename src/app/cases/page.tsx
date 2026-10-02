import { Suspense } from "react";
import type { Metadata } from "next";
import { pageDb } from "@/lib/db/request";
import { LawPageSkeleton } from "@/components/corpus/law-skeletons";
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
  return <LawPageSkeleton variant="gallery" />;
}
