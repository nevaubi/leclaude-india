import { Suspense } from "react";
import type { Metadata } from "next";
import { Skeleton } from "@/components/ui/skeleton";
import { JudgesDirectory } from "@/modules/judges/components/judges-directory";

export const metadata: Metadata = { title: "Judges" };

/** /judges?court=&q=&status= — judges from official court rosters (data from /api/judges). */
export default function Page() {
  return (
    <Suspense fallback={<div className="flex h-full flex-col gap-2 p-4"><Skeleton className="h-5 w-40" /><Skeleton className="h-7 w-full" /><Skeleton className="h-64 w-full" /></div>}>
      <JudgesDirectory />
    </Suspense>
  );
}
