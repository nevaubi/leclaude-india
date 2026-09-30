import { pageDb } from "@/lib/db/request";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ExternalLink, Radar } from "lucide-react";
import { PageTopbar } from "@/components/shell/page-topbar";
import { KeyValueList } from "@/components/ui/form";
import { db } from "@/lib/db";
import { intelAnalysisBootstrap } from "@/modules/intel/analysis/bootstrap";
import { DOC_KIND_LABEL, FLAG_LABEL, entityHref, fmtDate } from "@/modules/intel/analysis/pure";
import { getDocument, getDocumentText, intelEntities, intelSources, listChunks } from "@/modules/intel/store";
import type { IntelEntity } from "@/modules/intel/types";
import { matterHref } from "@/lib/features";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const doc = getDocument(decodeURIComponent(id));
  return { title: doc ? `${doc.title} · Intelligence` : "Intelligence" };
}

/**
 * One intelligence record: metadata, flags, linked entities, matters and the
 * stored text with chunk anchors (evidence links point at `#chunk-<idx>`).
 * Read-only; flags are managed by the steward, the sweeps and the API.
 */
export default async function IntelDocumentPage({ params }: Props) {
  await pageDb();
  intelAnalysisBootstrap();
  const { id } = await params;
  const doc = getDocument(decodeURIComponent(id));
  if (!doc) notFound();
  const text = getDocumentText(doc.id) ?? "";
  const chunks = listChunks(doc.id);
  const source = intelSources().get(doc.sourceId);
  const ids = Array.from(new Set([...doc.judgeIds, ...doc.attorneyIds, ...doc.firmIds, ...doc.partyIds, ...doc.productIds, ...(doc.mdlId ? [doc.mdlId] : []), ...(((doc.meta?.entityIds as string[] | undefined) ?? []))]));
  const entities = ids.map((x) => intelEntities().get(x)).filter((e): e is IntelEntity => Boolean(e));
  const matters = doc.matterIds.map((m) => db().matters.get(m)).filter((m): m is NonNullable<typeof m> => Boolean(m));
  const date = doc.dates.decided ?? doc.dates.filed ?? doc.dates.published ?? doc.dates.effective ?? doc.dates.event ?? doc.dates.modified;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageTopbar icon={<Radar />} title="Intelligence" context={`${DOC_KIND_LABEL[doc.kind]} · ${doc.title}`} />
      <div className="min-h-0 flex-1 overflow-auto scrollbar-thin">
        <div className="mx-auto max-w-[1200px] p-3 pb-8">
          <header className="mb-3">
            <div className="text-[11.5px] font-medium text-muted-foreground">{DOC_KIND_LABEL[doc.kind]}{source ? ` · ${source.name}` : ""}</div>
            <h1 className="text-[17px] font-semibold tracking-tight">{doc.title}</h1>
            {doc.summary && <p className="mt-0.5 max-w-3xl text-[12.5px] text-muted-foreground">{doc.summary}</p>}
            {doc.flags.length > 0 && <ul className="mt-1.5 space-y-0.5 text-[11.5px] text-warning-foreground dark:text-warning">{doc.flags.map((f) => <li key={f.kind}>{FLAG_LABEL[f.kind]}{f.note ? ` — ${f.note}` : ""}{f.by ? ` (${f.by}, ${fmtDate(f.at)})` : ""}</li>)}</ul>}
          </header>
          <div className="grid gap-x-6 gap-y-4 lg:grid-cols-[minmax(0,1fr)_320px]">
            <article className="min-w-0">
              <div className="flex h-8 items-center gap-2 border-b text-[12.5px] font-semibold tracking-tight">Text<span className="section-count">{text.length.toLocaleString()} chars · {chunks.length} passages</span></div>
              {chunks.length ? chunks.map((c) => (
                <section key={c.id} id={`chunk-${c.idx}`} className="scroll-mt-3 border-b border-line-quiet py-2">
                  <div className="mb-1 text-[10.5px] tabular text-muted-foreground">Passage {c.idx + 1}{c.section ? ` · ${c.section}` : ""}{c.page ? ` · p. ${c.page}` : ""}</div>
                  <p className="whitespace-pre-line font-serif text-[14px] leading-relaxed">{c.text}</p>
                </section>
              )) : <p className="whitespace-pre-line py-2 font-serif text-[14px] leading-relaxed">{text || "No text stored for this record."}</p>}
            </article>
            <aside className="min-w-0 space-y-4">
              <div>
                <div className="flex h-8 items-center border-b text-[12.5px] font-semibold tracking-tight">Record</div>
                <KeyValueList dense labelWidth={104} className="pt-1" items={[
                  { label: "Date", value: fmtDate(date) },
                  { label: "Court", value: doc.court ?? "—", muted: !doc.court },
                  { label: "Jurisdiction", value: doc.jurisdiction ?? "—", muted: !doc.jurisdiction },
                  { label: "Docket", value: doc.docketNumber ?? "—", mono: Boolean(doc.docketNumber), muted: !doc.docketNumber },
                  { label: "Citation", value: doc.citation ?? "—", muted: !doc.citation },
                  { label: "Confidence", value: `${Math.round(doc.confidence * 100)}%` },
                  { label: "Fetched", value: fmtDate(doc.fetchedAt) },
                  { label: "External id", value: doc.externalId ?? "—", mono: Boolean(doc.externalId), muted: !doc.externalId },
                  { label: "Source", value: doc.url ? <a href={doc.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline"><span className="truncate">{doc.url.replace(/^https?:\/\//, "").slice(0, 40)}</span><ExternalLink className="size-3 shrink-0" /></a> : "—", muted: !doc.url },
                ]} />
              </div>
              <div>
                <div className="flex h-8 items-center border-b text-[12.5px] font-semibold tracking-tight">Entities<span className="section-count">{entities.length}</span></div>
                <div className="divide-hairline">{entities.map((e) => <div key={e.id} className="flex h-7 items-center gap-2 text-[12px]"><span className="w-[72px] shrink-0 text-[11px] text-muted-foreground">{e.type}</span><Link href={entityHref(e)} className="truncate hover:text-primary hover:underline">{e.name}</Link></div>)}{!entities.length && <div className="py-2 text-[11.5px] text-muted-foreground">No entities resolved yet.</div>}</div>
              </div>
              {matters.length > 0 && (
                <div>
                  <div className="flex h-8 items-center border-b text-[12.5px] font-semibold tracking-tight">Matters</div>
                  <div className="divide-hairline">{matters.map((m) => <div key={m.id} className="flex h-7 items-center text-[12px]"><Link href={matterHref(m.id)} className="truncate hover:text-primary hover:underline">{m.shortName}</Link></div>)}</div>
                </div>
              )}
              {doc.tags.length > 0 && <div className="text-[11px] text-muted-foreground">Tags: {doc.tags.join(", ")}</div>}
            </aside>
          </div>
        </div>
      </div>
    </div>
  );
}
