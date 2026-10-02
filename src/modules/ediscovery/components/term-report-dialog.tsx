"use client";
import * as React from "react";
import { Download, Loader2, Play } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/ui/form";
import type { SearchTermReport } from "../types";
import { useReviewStore } from "./store";
import { useReview } from "./review-page";
import { api } from "./use-review-data";

/**
 * Search-term report: one query per line (full syntax), run against the current
 * view and facets; hits, unique documents and families per term, totals, CSV export.
 */
export function TermReportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { matterId } = useReview();
  const view = useReviewStore((s) => s.view);
  const filters = useReviewStore((s) => s.filters);
  const [text, setText] = React.useState("");
  const [scoped, setScoped] = React.useState(true);
  const [save, setSave] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [report, setReport] = React.useState<SearchTermReport | null>(null);
  React.useEffect(() => { if (open) setReport(null); }, [open]);
  const terms = React.useMemo(() => text.split(/\r?\n/).map((t) => t.trim()).filter(Boolean), [text]);
  const body = () => ({ matterId, terms, ...(scoped ? { view: view === "all" ? undefined : view, filters } : {}), save });
  const run = async () => {
    if (!terms.length) return;
    setBusy(true);
    try { setReport(await api<SearchTermReport>("/api/ediscovery/search-terms", { method: "POST", json: body() })); }
    catch (e) { toast.error("Report failed", { description: (e as Error).message }); }
    finally { setBusy(false); }
  };
  const exportCsv = async () => {
    try {
      const res = await fetch("/api/ediscovery/search-terms?format=csv", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body()) });
      if (!res.ok) throw new Error((await res.json().catch(() => ({ error: res.statusText })) as { error?: string }).error ?? res.statusText);
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `search-term-report-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) { toast.error("Export failed", { description: (e as Error).message }); }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader><DialogTitle>Search-term report</DialogTitle><DialogDescription>One term or query per line. Hits count occurrences; families add parents and attachments of the hits.</DialogDescription></DialogHeader>
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
          <div className="space-y-2">
            <Field label="Terms" hint={`${terms.length} term${terms.length === 1 ? "" : "s"}`}><Textarea value={text} onChange={(e) => setText(e.target.value)} className="min-h-[200px] font-mono text-[12px]" placeholder={'bioassay\n"monitoring well"\nliver w/5 study\ncustodian:kapur priv:yes'} spellCheck={false} /></Field>
            <label className="flex items-center gap-2 text-[12px]"><Checkbox size="sm" checked={scoped} onCheckedChange={(v) => setScoped(!!v)} /> Limit to the current view and facets</label>
            <label className="flex items-center gap-2 text-[12px]"><Checkbox size="sm" checked={save} onCheckedChange={(v) => setSave(!!v)} /> Keep this report in the matter</label>
          </div>
          <div className="min-w-0">
            {!report ? (
              <div className="flex h-full min-h-[200px] items-center justify-center rounded-md border border-dashed text-[12px] text-muted-foreground">Run the report to see hits per term.</div>
            ) : (
              <div className="overflow-auto rounded-md border scrollbar-thin" style={{ maxHeight: 320 }}>
                <table className="w-full text-[11.5px]">
                  <thead className="sticky top-0 bg-background"><tr className="grid-head border-b"><th className="px-2 py-1 text-left font-medium">Term</th><th className="px-2 py-1 text-right font-medium">Hits</th><th className="px-2 py-1 text-right font-medium">Docs</th><th className="px-2 py-1 text-right font-medium">Families</th><th className="px-2 py-1 text-right font-medium">With families</th></tr></thead>
                  <tbody>
                    {report.rows.map((r) => (
                      <tr key={r.term} className="border-b border-line-quiet last:border-b-0" title={r.warnings?.join("; ")}>
                        <td className="px-2 py-0.5 font-mono">{r.term}{r.warnings?.length ? <span className="ml-1 text-warning-foreground dark:text-warning">!</span> : null}</td>
                        <td className="px-2 py-0.5 text-right tabular">{r.hits.toLocaleString()}</td>
                        <td className="px-2 py-0.5 text-right tabular">{r.uniqueDocs.toLocaleString()}</td>
                        <td className="px-2 py-0.5 text-right tabular">{r.families.toLocaleString()}</td>
                        <td className="px-2 py-0.5 text-right tabular">{r.withFamilies.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot><tr className="border-t bg-muted/30 font-medium"><td className="px-2 py-1">Unique across terms</td><td /><td className="px-2 py-1 text-right tabular">{report.totalUnique.toLocaleString()}</td><td /><td className="px-2 py-1 text-right tabular">{report.totalWithFamilies.toLocaleString()}</td></tr></tfoot>
                </table>
                <div className="px-2 py-1 text-[10.5px] text-muted-foreground">Corpus {report.corpus.toLocaleString()} documents · {new Date(report.ranAt).toLocaleString()}{report.id ? " · saved" : ""}</div>
              </div>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>Close</Button>
          <Button variant="outline" size="sm" onClick={() => void exportCsv()} disabled={!terms.length}><Download className="size-3.5" /> CSV</Button>
          <Button size="sm" onClick={() => void run()} disabled={busy || !terms.length}>{busy ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />} Run</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
