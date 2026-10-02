import { pageDb } from "@/lib/db/request";
import { getI18n } from "@/lib/i18n/server";
import type { Metadata } from "next";
import { DiaryPage } from "@/modules/diary/components/diary-page";

export const dynamic = "force-dynamic";
export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getI18n();
  return { title: t("diary.title") };
}

/** Diary: hearings across the matters the user can see. Data loads through the authorized /api/diary routes. */
export default async function Page() {
  await pageDb();
  return <DiaryPage />;
}
