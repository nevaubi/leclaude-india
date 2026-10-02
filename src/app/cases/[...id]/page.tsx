import type { Metadata } from "next";
import Link from "next/link";
import { SearchX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { pageDb } from "@/lib/db/request";
import { CaseRecordView } from "@/modules/caselaw/components/case-record";
import { caseIdFromSegments } from "@/modules/caselaw/shared";
import { EmptyState } from "@/components/ui/misc";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Case" };

type Props = { params: Promise<{ id: string[] }> };

/** /cases/<record id> — one record of the judgment index (data from /api/cases/<id>). */
export default async function Page({ params }: Props) {
  await pageDb();
  const id = caseIdFromSegments((await params).id);
  if (!id) {
    return <div className="flex h-full items-center justify-center p-6"><EmptyState icon={SearchX} title="Case not found" description="This link does not point to a case. It may have been mistyped." action={<Button asChild size="xs" variant="outline"><Link href="/cases">Open the directory</Link></Button>} /></div>;
  }
  return <CaseRecordView id={id} />;
}
