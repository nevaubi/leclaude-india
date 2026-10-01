import { pageDb } from "@/lib/db/request";
import type { Metadata } from "next";
import { listLegalNews, legalNewsSources } from "@/modules/news/service";
import { NewsBrowser } from "@/modules/news/components/news-page";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "News" };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/** /news?source=<id>&court=<court id>&q=<text> — Indian legal headlines from the registered publisher feeds. */
export default async function NewsPage({ searchParams }: Props) {
  await pageDb();
  const sp = await searchParams;
  const one = (k: string) => (typeof sp[k] === "string" && (sp[k] as string).trim() ? (sp[k] as string).trim() : null);
  const filters = { source: one("source"), court: one("court"), q: one("q") ?? "" };
  const initial = listLegalNews({ ...filters, limit: 50 });
  return <NewsBrowser initial={initial} initialSources={legalNewsSources()} initialFilters={filters} />;
}
