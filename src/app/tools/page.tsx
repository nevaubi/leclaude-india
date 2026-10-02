import type { Metadata } from "next";
import { toolFromParam } from "@/modules/tools/ids";
import { PracticeTools } from "@/modules/tools/components/practice-tools";

export const metadata: Metadata = { title: "Practice tools" };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/** /tools?tool=limitation|cheque|arbitration|codes|fees — deterministic practice tools computed in the browser. */
export default async function ToolsPage({ searchParams }: Props) {
  const sp = await searchParams;
  return <PracticeTools initialTool={toolFromParam(sp.tool)} />;
}
