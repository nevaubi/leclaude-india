import type { Metadata } from "next";
import { pageDb } from "@/lib/db/request";
import { CaseRecordView } from "@/modules/caselaw/components/case-record";
import { caseIdFromSegments } from "@/modules/caselaw/shared";
import { EmptyState } from "@/components/ui/misc";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Case law record" };

type Props = { params: Promise<{ id: string[] }> };

/** /cases/<record id> — one record of the judgment index (data from /api/cases/<id>). */
export default async function Page({ params }: Props) {
  await pageDb();
  const id = caseIdFromSegments((await params).id);
  if (!id) {
    return <div className="flex h-full items-center justify-center p-6"><EmptyState title="Not a case law record id" description="Record ids start with sc: or hc:. Open the directory to find a record." /></div>;
  }
  return <CaseRecordView id={id} />;
}
