"use client";
import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ExternalLink, FileText } from "lucide-react";
import type { OfficialListResult } from "@/modules/official/service";
import type { SourceDocument } from "@/modules/official/types";
import { fetchOfficialJson } from "@/modules/official-ui/fetch";
import { formatDocDate, formatFetchedAt, kindLabel, safeHttp, sourceDocHref } from "@/modules/official-ui/shared";
import { exactDiaryOrders, scDiaryNumberOf, type CaseRecord } from "../shared";

/**
 * "Orders from the Supreme Court feed": orders and judgments published on sci.gov.in for this record's diary number,
 * from the official-sources corpus. Shown only for Supreme Court records whose case number labels exactly one diary
 * number ("… (Diary No. 54583/2026)"), and only with documents whose published diary number is exactly that one. Otherwise (no diary number, feed not configured or
 * not available, nothing exact) the card is omitted: nothing related-looking is shown in its place.
 */
export function ScOrdersCard({ r }: { r: CaseRecord }) {
  const diary = scDiaryNumberOf(r);
  const pathname = usePathname();
  const [docs, setDocs] = React.useState<SourceDocument[] | null>(null);
  React.useEffect(() => {
    if (!diary) return;
    const ac = new AbortController();
    setDocs(null);
    const qs = new URLSearchParams({ source: "sci-orders", q: diary, limit: "50" });
    fetchOfficialJson<OfficialListResult>(`/api/official/documents?${qs}`, ac.signal)
      .then((res) => setDocs(exactDiaryOrders(Array.isArray(res.documents) ? res.documents : [], diary)))
      .catch(() => { if (!ac.signal.aborted) setDocs([]); });
    return () => ac.abort();
  }, [diary]);
  if (!diary || !docs?.length) return null;
  return (
    <section className="rounded-lg border" aria-label="Orders from the Supreme Court feed">
      <header className="flex h-8 items-center gap-2 border-b px-3">
        <h2 className="text-[12.5px] font-medium">Orders from the Supreme Court feed</h2>
        <span className="flex-1" />
        <span className="text-[11px] text-muted-foreground tabular">{docs.length}</span>
      </header>
      <div className="px-3 py-2.5">
        <p className="mb-2 text-[11.5px] text-muted-foreground">Published on sci.gov.in for Diary No. <span className="tabular">{diary}</span>.</p>
        <ul className="divide-y">
          {docs.slice(0, 12).map((d) => {
            const official = safeHttp(d.fileUrl ?? d.url);
            return (
              <li key={d.id} className="py-1.5 text-[12.5px]">
                <Link href={sourceDocHref(d.id, undefined, pathname)} className="line-clamp-2 font-medium hover:underline">{d.title}</Link>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11.5px] text-muted-foreground">
                  <span>{kindLabel(d.kind)}</span>
                  <span className="tabular">{formatDocDate(d.docDate) ?? "undated"}</span>
                  {official ? <a href={official} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline"><FileText className="size-3" aria-hidden />PDF<ExternalLink className="size-3" aria-hidden /></a> : null}
                </div>
              </li>
            );
          })}
        </ul>
        {docs.length > 12 ? <p className="mt-1 text-[11.5px] text-muted-foreground">{docs.length - 12} more in the official sources library.</p> : null}
        <p className="mt-2 border-t pt-2 text-[11px] leading-snug text-muted-foreground">As published by the Supreme Court of India; most recent fetch {formatFetchedAt(docs.map((d) => d.fetchedAt).filter((x): x is string => Boolean(x)).sort().pop()) ?? "not recorded"}. The court&apos;s PDF is the text of record.</p>
      </div>
    </section>
  );
}
