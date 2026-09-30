"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Download, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Filterbar, type FilterbarFilter } from "@/components/ui/filterbar";
import type { FilterValues } from "@/components/ui/filterbar-helpers";
import { Stat } from "@/components/ui/misc";
import type { IntelDocumentKind } from "../types";
import { DOC_KIND_LABEL, fmtInt } from "../analysis/pure";
import type { ChronologyExportResult, ChronologyResult } from "../analysis/types";
import { chronologyKindLabel, groupByMonth } from "./models";
import { ConfidenceText, DateText, EmptySources, MethodNote, useJson } from "./shared";
import { matterDocumentsHref } from "@/lib/features";

const KINDS: IntelDocumentKind[] = ["docket", "docket_entry", "opinion", "register_notice", "regulation", "recall", "adverse_event", "mdl", "news"];

export function ChronologyView({ initial, options, entityName }: { initial: ChronologyResult | null; options: { matters: { value: string; label: string; records: number }[]; mdls: { value: string; label: string }[]; products: { value: string; label: string }[] }; entityName?: string }) {
  const router = useRouter();
  const q = initial?.query;
  const scopeValue = q?.matterId ? `matter:${q.matterId}` : q?.mdlId ? `mdl:${q.mdlId}` : q?.productId ? `product:${q.productId}` : q?.entityId ? `entity:${q.entityId}` : null;
  const [values, setValues] = React.useState<FilterValues>({ scope: scopeValue, kinds: q?.kinds?.length ? q.kinds : null, ediscovery: q?.includeEdiscovery === false ? "0" : null, from: q?.from ?? null, to: q?.to ?? null });
  const [exporting, setExporting] = React.useState(false);
  const first = React.useRef(true);
  const url = React.useMemo(() => {
    const sp = new URLSearchParams();
    const scope = typeof values.scope === "string" ? values.scope : "";
    const [kind, id] = scope.split(":");
    if (kind === "matter") sp.set("matterId", id); else if (kind === "mdl") sp.set("mdlId", id); else if (kind === "product") sp.set("productId", id); else if (kind === "entity") sp.set("entityId", id);
    const kinds = Array.isArray(values.kinds) ? values.kinds : values.kinds ? [values.kinds] : [];
    if (kinds.length) sp.set("kinds", kinds.join(","));
    if (values.ediscovery === "0") sp.set("ediscovery", "0");
    if (typeof values.from === "string") sp.set("from", values.from);
    if (typeof values.to === "string") sp.set("to", values.to);
    return sp.toString();
  }, [values]);
  const { data, loading, error } = useJson<ChronologyResult>(first.current || !url ? null : `/api/intel/chronology?${url}`, [url]);
  React.useEffect(() => { if (first.current) { first.current = false; return; } router.replace(url ? `/intel/chronologies?${url}` : "/intel/chronologies", { scroll: false }); }, [url, router]);
  const result = data ?? initial;
  const months = React.useMemo(() => (result ? groupByMonth(result.entries).reverse() : []), [result]);
  const matterId = result?.query.matterId;
  const scopeOptions = [
    ...options.matters.map((m) => ({ value: `matter:${m.value}`, label: `${m.label}`, count: m.records })),
    ...options.mdls.map((m) => ({ value: `mdl:${m.value}`, label: m.label })),
    ...options.products.map((p) => ({ value: `product:${p.value}`, label: p.label })),
    ...(q?.entityId ? [{ value: `entity:${q.entityId}`, label: entityName ?? q.entityId }] : []),
  ];
  const filters: FilterbarFilter[] = [
    { id: "scope", label: "Scope", options: scopeOptions },
    { id: "kinds", label: "Kinds", multi: true, options: KINDS.map((k) => ({ value: k, label: DOC_KIND_LABEL[k] })) },
    { id: "ediscovery", label: "E-discovery timeline", options: [{ value: "0", label: "Hide e-discovery events" }], pinned: false },
    { id: "from", label: "From", kind: "date", options: [], pinned: false },
    { id: "to", label: "To", kind: "date", options: [], pinned: false },
  ];
  const exportToTimeline = async () => {
    if (!matterId) return;
    setExporting(true);
    try {
      const res = await fetch("/api/intel/chronology", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ matterId }) });
      const j = (await res.json()) as ChronologyExportResult & { error?: string };
      if (!res.ok) throw new Error(j.error ?? res.statusText);
      toast.success(`${j.created} event${j.created === 1 ? "" : "s"} added to the e-discovery timeline`, { description: `${j.skippedDuplicates} already present · ${j.belowGate} below the confidence gate` });
    } catch (e) { toast.error("Export failed", { description: (e as Error).message }); } finally { setExporting(false); }
  };

  if (!result) {
    return <div className="min-h-0 flex-1 overflow-auto scrollbar-thin"><div className="mx-auto max-w-3xl p-6"><EmptySources title="No dated records to build a chronology from" /></div></div>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Filterbar filters={filters} values={values} onChange={setValues} status={<span className="tabular">{loading ? "Building…" : error ? `Error: ${error}` : `${fmtInt(result.entries.length)} events · ${result.sources.intel} from intelligence records · ${result.sources.ediscovery} from the e-discovery timeline · ${result.merged} merged`}</span>}>
        {matterId && <Button size="xs" onClick={() => void exportToTimeline()} disabled={exporting}>{exporting ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />} Export to e-discovery timeline</Button>}
        {matterId && <Button size="xs" variant="ghost" asChild><Link href={matterDocumentsHref(matterId)}>Documents</Link></Button>}
      </Filterbar>
      <div className="min-h-0 flex-1 overflow-auto scrollbar-thin">
        <div className="mx-auto max-w-[1100px] space-y-4 p-3 pb-8">
          <div className="grid grid-cols-2 hairline-x rounded-md border sm:grid-cols-4">
            <Stat size="sm" label="Events" value={fmtInt(result.entries.length)} />
            <Stat size="sm" label="First" value={<DateText value={result.entries[0]?.at} className="text-foreground" />} />
            <Stat size="sm" label="Latest" value={<DateText value={result.entries[result.entries.length - 1]?.at} className="text-foreground" />} />
            <Stat size="sm" label="Gate-passing" value={fmtInt(result.entries.filter((e) => e.confidence >= 0.6).length)} hint="confidence ≥ 60%" />
          </div>
          {months.map((m) => (
            <section key={m.month}>
              <div className="sticky top-0 z-10 flex h-7 items-center border-b bg-background text-[11.5px] font-medium text-muted-foreground">{m.label}<span className="ml-2 tabular normal-case tracking-normal">{m.entries.length}</span></div>
              <div className="divide-hairline">
                {m.entries.slice().reverse().map((e, i) => {
                  const ev = e.evidence[0];
                  const edisc = ev?.docId.startsWith("tl_");
                  return (
                    <div key={`${e.at}-${i}`} className="grid min-h-8 grid-cols-[92px_112px_minmax(0,1fr)_56px] items-start gap-3 py-1 text-[12.5px]">
                      <DateText value={e.at} className="pt-0.5 text-[11.5px]" />
                      <span className="truncate pt-0.5 text-[11px] text-muted-foreground" title={chronologyKindLabel(e.kind)}>{chronologyKindLabel(e.kind)}</span>
                      <div className="min-w-0">
                        <div className="truncate font-medium">{ev && !edisc ? <Link href={ev.href ?? `/intel/documents/${encodeURIComponent(ev.docId)}`} className="hover:text-primary hover:underline">{e.title}</Link> : e.title}</div>
                        {e.detail && <div className="truncate text-[11.5px] text-muted-foreground" title={e.detail}>{e.detail}</div>}
                        {e.evidence.length > 1 && <div className="text-[11px] text-muted-foreground">{e.evidence.length} sources{e.evidence.some((x) => x.docId.startsWith("tl_")) ? " · includes the e-discovery timeline" : ""}</div>}
                      </div>
                      <ConfidenceText value={e.confidence} className="pt-0.5 text-right" />
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
          {!result.entries.length && <MethodNote>No dated events for this scope.</MethodNote>}
          <MethodNote>Dates come from the records themselves (filed, decided, published, effective, event); entries on the same day with the same or a near-identical title are merged with the platform&apos;s timeline dedupe. Exported events are marked as created by the analysis, carry provenance and stay below the review gate until a reviewer confirms them.</MethodNote>
        </div>
      </div>
    </div>
  );
}
