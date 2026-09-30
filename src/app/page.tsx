import { pageDb } from "@/lib/db/request";
import { getI18n } from "@/lib/i18n/server";
import type { Metadata } from "next";
import { aiConfig } from "@/lib/ai/config";
import { loadHomeInitialData, withDocumentSetFiles } from "@/modules/home/service";
import { pagePrincipal } from "@/app/documents/_lib/page-data";
import { HomePage } from "@/modules/home/components/home-page";

export const dynamic = "force-dynamic";
export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getI18n();
  return { title: t("home.title") };
}

export default async function Page() {
  await pageDb();
  const initial = await withDocumentSetFiles(loadHomeInitialData({ aiConfigured: aiConfig().hasKey }), await pagePrincipal("/"));
  return <HomePage initial={initial} />;
}
