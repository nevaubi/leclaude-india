import { pageDb } from "@/lib/db/request";
import { getI18n } from "@/lib/i18n/server";
import type { Metadata } from "next";
import { aiConfig } from "@/lib/ai/config";
import { loadHomeInitialData } from "@/modules/home/service";
import { HomePage } from "@/modules/home/components/home-page";

export const dynamic = "force-dynamic";
export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getI18n();
  return { title: t("home.title") };
}

export default async function Page() {
  await pageDb();
  const initial = loadHomeInitialData({ aiConfigured: aiConfig().hasKey });
  return <HomePage initial={initial} />;
}
