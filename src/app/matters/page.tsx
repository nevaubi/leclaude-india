import { pageDb } from "@/lib/db/request";
import { getI18n } from "@/lib/i18n/server";
import type { Metadata } from "next";
import * as React from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { MattersPage } from "@/modules/matters/components/matters-page";

export const dynamic = "force-dynamic";
export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getI18n();
  return { title: t("matters.title") };
}

/** Matters: /matters?id=<matterId>&new=1. Data loads through the authorized /api/matters routes. */
export default async function Page() {
  await pageDb();
  return (
    <React.Suspense fallback={<div className="space-y-2 p-3"><Skeleton className="h-9" /><Skeleton className="h-64" /></div>}>
      <MattersPage />
    </React.Suspense>
  );
}
