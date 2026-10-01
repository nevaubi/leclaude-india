import type { Metadata } from "next";
import { EmptyState } from "@/components/ui/misc";
import { JudgeProfileView } from "@/modules/judges/components/judge-profile";
import { isJudgeId } from "@/modules/judges/names";

export const metadata: Metadata = { title: "Judge" };

type Props = { params: Promise<{ id: string }> };

/** /judges/<id> — one judge (data from /api/judges/<id>). */
export default async function Page({ params }: Props) {
  const id = decodeURIComponent((await params).id);
  if (!isJudgeId(id)) {
    return <div className="flex h-full items-center justify-center p-6"><EmptyState title="Judge not found" description="This link does not point to a judge. Open the judges directory to find one." /></div>;
  }
  return <JudgeProfileView id={id} />;
}
