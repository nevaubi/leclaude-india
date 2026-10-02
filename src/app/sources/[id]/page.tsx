import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { SearchX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/misc";
import { Skeleton } from "@/components/ui/skeleton";
import { pageDb } from "@/lib/db/request";
import { SourceDocumentReader } from "@/modules/official-ui/components/document-reader";
import { sourceDocIdFromParam } from "@/modules/official-ui/shared";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Official document" };

type Props = { params: Promise<{ id: string }> };

/** /sources/<documentId>[?page=n|?chunk=n] — one official document with its provenance (data from /api/official/documents/<id>). */
export default async function Page({ params }: Props) {
  await pageDb();
  const id = sourceDocIdFromParam((await params).id);
  if (!id) {
    return <div className="flex h-full items-center justify-center p-6"><EmptyState icon={SearchX} title="Document not found" description="This link does not point to an official document. It may have been mistyped." action={<Button asChild size="xs" variant="outline"><Link href="/sources">Open official sources</Link></Button>} /></div>;
  }
  return (
    <Suspense fallback={<div className="mx-auto w-full max-w-[78ch] space-y-3 px-8 py-6" aria-busy><Skeleton className="h-3 w-40" /><Skeleton className="h-6 w-3/4" /><Skeleton className="h-64 w-full" /></div>}>
      <SourceDocumentReader id={id} />
    </Suspense>
  );
}
