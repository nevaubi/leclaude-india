"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Check, Copy, ExternalLink, FileText, SearchX } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState, Spinner } from "@/components/ui/misc";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { OfficialReadResult } from "@/modules/official/service";
import { sourceRef, type SourceChunk, type SourceDocument } from "@/modules/official/types";
import { asOfficialApiError, fetchOfficialJson, type OfficialApiError } from "../fetch";
import { chunkFromOcr, docStatusLabel, documentApiHref, extractionLabel, formatBytes, formatDocDate, formatFetchedAt, hostOf, isOcrText, kindLabel, pageLabel, positiveInt, returnLabel, safeHttp, safeReturnPath, sourceDocHref } from "../shared";
import { isOfficialUnavailable, OcrBadge, OfficialErrorState, OfficialUnavailable, useOfficialStatus } from "./states";

/**
 * /sources/<id>[?page=n | ?chunk=n][&from=<path>] — one official document: its text in page-marked chunks, and its provenance (the
 * publisher's link, SHA-256 of the bytes read, when it was fetched, how the text was obtained, attribution). The
 * publisher's copy is the text of record; OCR text is always labelled.
 */
export function SourceDocumentReader({ id }: { id: string }) {
  const sp = useSearchParams();
  const router = useRouter();
  const page = positiveInt(sp.get("page"));
  const chunk = page == null ? (sp.get("chunk") && /^\d{1,6}$/.test(sp.get("chunk")!) ? Number(sp.get("chunk")) : null) : null;
  // Where the reader was opened from (the library with its search and filters, a case record, the tools); kept in the
  // URL so the back link survives client navigation and reloads.
  const from = safeReturnPath(sp.get("from"));
  const [data, setData] = React.useState<OfficialReadResult | null>(null);
  const [error, setError] = React.useState<OfficialApiError | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [nonce, setNonce] = React.useState(0);
  const [more, setMore] = React.useState<{ loading: boolean; error: string | null }>({ loading: false, error: null });
  const { status } = useOfficialStatus();

  React.useEffect(() => {
    const ac = new AbortController();
    setLoading(true);
    setError(null);
    fetchOfficialJson<OfficialReadResult>(documentApiHref(id, { page, fromChunk: chunk }), ac.signal)
      .then((d) => setData(d))
      .catch((e) => { if ((e as Error).name !== "AbortError") { setData(null); setError(asOfficialApiError(e)); } })
      .finally(() => { if (!ac.signal.aborted) setLoading(false); });
    return () => ac.abort();
  }, [id, page, chunk, nonce]);

  const loadMore = () => {
    if (!data?.hasMore || data.nextChunk == null || more.loading) return;
    setMore({ loading: true, error: null });
    fetchOfficialJson<OfficialReadResult>(documentApiHref(id, { fromChunk: data.nextChunk }))
      .then((d) => { setData((prev) => (prev ? { ...d, chunks: [...prev.chunks, ...d.chunks.filter((c) => !prev.chunks.some((p) => p.index === c.index))] } : d)); setMore({ loading: false, error: null }); })
      .catch((e) => setMore({ loading: false, error: asOfficialApiError(e).message }));
  };

  const source = data && status ? status.sources.find((s) => s.id === data.document.sourceId) ?? null : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 px-4 pt-3 sm:px-6"><BackLink from={from} /></div>
      {loading && !data ? <ReaderSkeleton /> : error ? (
        <div className="flex flex-1 items-center justify-center p-6">
          {isOfficialUnavailable(error) ? <OfficialUnavailable error={error} /> : error.notFound || error.badRequest ? (
            <EmptyState icon={SearchX} title="Document not found" description="This link does not match a collected official document. It may have been mistyped, or the document was removed." action={<Button asChild size="xs" variant="outline"><Link href="/sources?tab=browse">Browse official sources</Link></Button>} />
          ) : <OfficialErrorState title="The document could not be loaded" error={error} onRetry={() => setNonce((n) => n + 1)} />}
        </div>
      ) : data ? (
        <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_320px]">
          <main className="min-h-0 min-w-0 overflow-auto scrollbar-thin">
            <article className={cn("mx-auto w-full max-w-[78ch] px-5 pb-12 pt-3 sm:px-8", loading && "opacity-70")} aria-label={data.document.title}>
              <DocHeader d={data.document} publisher={source?.publisher ?? null} />
              <PageJump pages={data.document.pages} current={page} onGo={(p) => router.replace(sourceDocHref(id, p ? { page: p } : undefined, from), { scroll: false })} />
              <div className="mt-4 lg:hidden"><Provenance d={data.document} attribution={data.attribution} terms={source?.terms ?? null} /></div>
              {data.chunks.length ? <ChunkList doc={data.document} chunks={data.chunks} /> : (
                <p className="mt-6 rounded-md border border-dashed px-3 py-4 text-[12.5px] text-muted-foreground">
                  {data.document.status === "indexed" ? "No text is stored for this part of the document." : `The text is not available yet (${docStatusLabel(data.document.status).toLowerCase()}).`} Read the publisher&apos;s copy.
                </p>
              )}
              {data.hasMore ? (
                <div className="mt-5 flex items-center gap-2">
                  <Button size="xs" variant="outline" disabled={more.loading} onClick={loadMore}>{more.loading ? <Spinner size={12} /> : null}Continue reading</Button>
                  {more.error ? <span className="text-[11.5px] text-destructive">{more.error}</span> : null}
                </div>
              ) : data.chunks.length ? <p className="mt-6 text-[11.5px] text-muted-foreground">End of the stored text ({data.document.chunks} part{data.document.chunks === 1 ? "" : "s"}).</p> : null}
            </article>
          </main>
          <aside className="hidden min-h-0 overflow-auto border-l scrollbar-thin lg:block"><div className="p-4"><Provenance d={data.document} attribution={data.attribution} terms={source?.terms ?? null} /></div></aside>
        </div>
      ) : null}
    </div>
  );
}

/** Back to where the reader was opened from (?from=, a path on this site), else to the library. */
function BackLink({ from }: { from: string | null }) {
  return (
    <Link href={from ?? "/sources"} className="inline-flex items-center gap-1 rounded text-[12px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
      <ArrowLeft className="size-3.5" aria-hidden />{returnLabel(from)}
    </Link>
  );
}

function ReaderSkeleton() {
  return (
    <div className="mx-auto w-full max-w-[78ch] space-y-3 px-8 py-6" aria-busy>
      <Skeleton className="h-3 w-40" /><Skeleton className="h-6 w-3/4" /><Skeleton className="h-3.5 w-1/2" />
      {Array.from({ length: 9 }, (_, k) => <Skeleton key={k} className="h-3.5" style={{ width: `${78 + ((k * 9) % 22)}%` }} />)}
    </div>
  );
}

function DocHeader({ d, publisher }: { d: SourceDocument; publisher: string | null }) {
  const official = safeHttp(d.fileUrl ?? d.url);
  return (
    <header className="pt-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted-foreground">
        {publisher ? <span className="font-medium text-foreground/85">{publisher}</span> : null}
        {publisher ? <span aria-hidden>·</span> : null}
        <span>{kindLabel(d.kind)}</span>
        <span aria-hidden>·</span>
        <span className="tabular">{formatDocDate(d.docDate) ?? "Date not printed"}</span>
        {d.pages ? <><span aria-hidden>·</span><span className="tabular">{d.pages} page{d.pages === 1 ? "" : "s"}</span></> : null}
        {isOcrText(d.extraction, d.ocrPages) ? <OcrBadge /> : null}
      </div>
      <h1 className="mt-1.5 font-serif text-[22px] leading-tight tracking-[-0.01em]">{d.title}</h1>
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        {official ? <Button asChild size="xs" variant="outline"><a href={official} target="_blank" rel="noopener noreferrer"><FileText className="size-3.5" />Publisher&apos;s copy<span className="text-muted-foreground">· {hostOf(official)}</span><ExternalLink className="size-3 opacity-60" /></a></Button> : <span className="text-[12px] text-muted-foreground">Official link not recorded</span>}
      </div>
    </header>
  );
}

function PageJump({ pages, current, onGo }: { pages: number | null; current: number | null; onGo: (p: number | null) => void }) {
  const [v, setV] = React.useState(current ? String(current) : "");
  React.useEffect(() => { setV(current ? String(current) : ""); }, [current]);
  if (!pages || pages < 2) return null;
  const n = positiveInt(v, pages);
  return (
    <form className="mt-3 flex items-center gap-1.5 text-[12px] text-muted-foreground" onSubmit={(e) => { e.preventDefault(); if (n) onGo(n); }}>
      <label htmlFor="src-page">Go to page</label>
      <Input id="src-page" size="xs" inputMode="numeric" value={v} onChange={(e) => setV(e.target.value)} className="w-[64px] tabular" aria-invalid={Boolean(v) && !n} />
      <span className="tabular">of {pages}</span>
      <Button type="submit" size="xs" variant="ghost" disabled={!n}>Go</Button>
      {current ? <Button type="button" size="xs" variant="ghost" onClick={() => onGo(null)}>From the start</Button> : null}
    </form>
  );
}

/** Chunks with a page marker wherever the page changes; OCR chunks carry the OCR label. */
function ChunkList({ doc, chunks }: { doc: SourceDocument; chunks: SourceChunk[] }) {
  let lastPage: number | null = null;
  return (
    <div className="mt-6">
      {chunks.map((c) => {
        const marker = c.pageStart != null && c.pageStart !== lastPage ? c.pageStart : null;
        lastPage = c.pageEnd ?? c.pageStart ?? lastPage;
        const ocr = chunkFromOcr(doc, c);
        const ref = sourceRef(doc.id, c.pageStart != null ? { page: c.pageStart } : { chunk: c.index });
        return (
          <section key={c.index} id={`c${c.index}`} className="group scroll-mt-4" aria-label={pageLabel(c.pageStart, c.pageEnd) ?? `Part ${c.index + 1}`}>
            {marker != null ? (
              <div className="my-4 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground" id={`p${marker}`}>
                <span className="h-px flex-1 bg-border" aria-hidden />Page {marker}<span className="h-px flex-1 bg-border" aria-hidden />
              </div>
            ) : null}
            <div className="flex items-center gap-2">
              {c.heading ? <h2 className="text-[12.5px] font-semibold text-foreground/85">{c.heading}</h2> : null}
              {ocr ? <OcrBadge /> : null}
              {c.pageStart != null && c.pageEnd != null && c.pageEnd !== c.pageStart ? <span className="text-[11px] text-muted-foreground tabular">{pageLabel(c.pageStart, c.pageEnd)}</span> : null}
              <span className="ml-auto opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100"><CopyRef value={ref} /></span>
            </div>
            <div className="mt-1 whitespace-pre-wrap break-words font-serif text-[15px] leading-[1.7] text-foreground">{c.text}</div>
          </section>
        );
      })}
    </div>
  );
}

function CopyRef({ value }: { value: string }) {
  const [done, setDone] = React.useState(false);
  return (
    <button type="button" aria-label={`Copy reference ${value}`} title={value} onClick={async () => {
      try { await navigator.clipboard.writeText(value); setDone(true); toast.success("Reference copied"); setTimeout(() => setDone(false), 1500); } catch { toast.error("Could not copy to the clipboard"); }
    }} className="inline-flex h-6 items-center gap-1 rounded px-1.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
      {done ? <Check className="size-3" aria-hidden /> : <Copy className="size-3" aria-hidden />}Copy reference
    </button>
  );
}

function Row({ label, children, mono }: { label: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[92px_minmax(0,1fr)] gap-2 py-[3px] text-[12px] leading-snug">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn("min-w-0 break-words", mono && "font-mono text-[11px]")}>{children}</dd>
    </div>
  );
}

const META_LABEL: Record<string, string> = {
  caseNumbers: "Case numbers", diaryNo: "Diary No.", parties: "Parties", bench: "Bench", orderDate: "Order date", notificationNo: "Notification", circularNo: "Circular", forum: "Forum",
};

/** Printed metadata worth showing (strings and string lists only; internal flags left out). */
function metaRows(meta: Record<string, unknown>): [string, string][] {
  const out: [string, string][] = [];
  for (const [k, v] of Object.entries(meta ?? {})) {
    if (/url|pattern|listing|uploadedAt|docKind|orderType|caseKeys|coversYears/i.test(k)) continue;
    const text = typeof v === "string" ? v : Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]).join("; ") : typeof v === "number" ? String(v) : null;
    if (!text || text.length > 400) continue;
    out.push([META_LABEL[k] ?? k.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase()), text]);
    if (out.length >= 8) break;
  }
  return out;
}

/** Ends a sentence with a full stop when it has none. */
const sentence = (t: string) => (/[.!?]$/.test(t.trim()) ? t.trim() : `${t.trim()}.`);

function Provenance({ d, attribution, terms }: { d: SourceDocument; attribution: string; terms: string | null }) {
  const page = safeHttp(d.url);
  const file = safeHttp(d.fileUrl);
  const [copied, setCopied] = React.useState(false);
  const meta = metaRows(d.meta);
  return (
    <section aria-label="Source and provenance" className="rounded-lg border">
      <header className="flex h-8 items-center border-b px-3"><h2 className="text-[12.5px] font-medium">Source</h2></header>
      <dl className="px-3 py-2">
        <Row label="Official page">{page ? <a href={page} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 break-all text-primary hover:underline">{hostOf(page)}<ExternalLink className="size-3 shrink-0" aria-hidden /></a> : <span className="text-muted-foreground">Not recorded</span>}</Row>
        {file && file !== page ? <Row label="File">{<a href={file} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 break-all text-primary hover:underline">{hostOf(file)}<ExternalLink className="size-3 shrink-0" aria-hidden /></a>}</Row> : null}
        <Row label="Fetched">{formatFetchedAt(d.fetchedAt) ?? <span className="text-muted-foreground">Not fetched yet</span>}</Row>
        <Row label="Text">{extractionLabel(d.extraction)}{d.ocrPages.length && d.extraction !== "ocr_model" ? <span className="text-muted-foreground"> · OCR on page{d.ocrPages.length === 1 ? "" : "s"} {d.ocrPages.slice(0, 20).join(", ")}{d.ocrPages.length > 20 ? "…" : ""}</span> : null}</Row>
        <Row label="SHA-256" mono>
          {d.sha256 ? (
            <span className="inline-flex max-w-full items-start gap-1">
              <span className="min-w-0 break-all">{d.sha256}</span>
              <button type="button" aria-label="Copy SHA-256" className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50" onClick={async () => {
                try { await navigator.clipboard.writeText(d.sha256!); setCopied(true); toast.success("SHA-256 copied"); setTimeout(() => setCopied(false), 1500); } catch { toast.error("Could not copy to the clipboard"); }
              }}>{copied ? <Check className="size-3" /> : <Copy className="size-3" />}</button>
            </span>
          ) : <span className="font-sans text-muted-foreground">Not recorded</span>}
        </Row>
        {d.bytes != null ? <Row label="Size">{formatBytes(d.bytes)}{d.mime ? <span className="text-muted-foreground"> · {d.mime}</span> : null}</Row> : null}
        <Row label="Version">{d.version}{d.version > 1 ? <span className="text-muted-foreground"> (the publisher changed the file since it was first read)</span> : null}</Row>
        <Row label="Status">{docStatusLabel(d.status)}{d.error ? <span className="block text-[11.5px] text-destructive">{d.error}</span> : null}</Row>
        {meta.map(([k, v]) => <Row key={k} label={k}>{v}</Row>)}
      </dl>
      <p className="border-t px-3 py-2 text-[11px] leading-snug text-muted-foreground">{sentence(attribution)}{terms ? <> {sentence(terms)}</> : null} The publisher&apos;s copy is the text of record{isOcrText(d.extraction, d.ocrPages) ? "; check quotes from OCR text against the PDF before filing" : ""}.</p>
    </section>
  );
}
