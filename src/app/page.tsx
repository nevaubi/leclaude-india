import { pageDb } from "@/lib/db/request";
import { getI18n } from "@/lib/i18n/server";
import type { Metadata } from "next";
import { appDisplayName } from "@/lib/brand";
import { aiConfig } from "@/lib/ai/config";
import { loadHomeInitialData, withDocumentSetFiles } from "@/modules/home/service";
import { pagePrincipal } from "@/app/documents/_lib/page-data";
import { HomePage } from "@/modules/home/components/home-page";

export const dynamic = "force-dynamic";
export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getI18n();
  // The root page shares the root layout's segment, so the layout's "%s · <app>" title template does not apply here.
  return { title: { absolute: `${t("home.title")} · ${appDisplayName()}` } };
}

export default async function Page() {
  await pageDb();
  const principal = await pagePrincipal("/");
  const initial = await withDocumentSetFiles(loadHomeInitialData({ aiConfigured: aiConfig().hasKey, principal }), principal);
  return <HomePage initial={initial} />;
}
