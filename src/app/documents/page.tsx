import type { Metadata } from "next";
import { pageDb } from "@/lib/db/request";
import { listDocSets } from "@/modules/documents/server";
import { SetsPage } from "@/modules/documents/components/sets-page";
import type { DocSet } from "@/modules/documents/types";
import { pagePrincipal, visibleMatters } from "./_lib/page-data";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Documents" };

/** /documents: document sets. Sets are listed on the server when possible; otherwise the client loads them from the API. */
export default async function Page() {
  await pageDb();
  const principal = await pagePrincipal("/documents");
  let sets: DocSet[] | null = null;
  if (principal) {
    try { sets = await listDocSets(principal); } catch { sets = null; /* the client retries through /api/documents/sets and shows the error */ }
  }
  return <SetsPage initialSets={sets} matters={visibleMatters(principal)} />;
}
