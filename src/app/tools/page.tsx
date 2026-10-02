import type { Metadata } from "next";
import { toolFromParam } from "@/modules/tools/ids";
import { PracticeTools } from "@/modules/tools/components/practice-tools";

export const metadata: Metadata = { title: "Practice tools" };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/** /tools?tool=limitation|cheque|arbitration|condonation|court-days|causelist|codes|fees — practice tools: deterministic computations in the browser, plus official court calendars and cause lists read from the official-sources API. */
export default async function ToolsPage({ searchParams }: Props) {
  const sp = await searchParams;
  return <PracticeTools initialTool={toolFromParam(sp.tool)} />;
}
