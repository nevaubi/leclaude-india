import { Suspense } from "react";
import type { Metadata } from "next";
import { LawPageSkeleton } from "@/components/corpus/law-skeletons";
import { JudgesDirectory } from "@/modules/judges/components/judges-directory";

export const metadata: Metadata = { title: "Judges" };

/** /judges?court=&q=&status= — judges from official court rosters (data from /api/judges). */
export default function Page() {
  return (
    <Suspense fallback={<LawPageSkeleton variant="people" />}>
      <JudgesDirectory />
    </Suspense>
  );
}
