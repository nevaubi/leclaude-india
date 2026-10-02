"use client";
import * as React from "react";
import { RefreshCw, Wrench, ExternalLink, Loader2 } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { RelativeTime } from "@/components/ui/relative-time";
import type { AuditEvent, ScanFinding, ScanReport, ScanSeverity } from "@/lib/integrity/types";
import { SettingsBlock } from "./settings-section";
import { isHiddenHref } from "@/lib/features";

const TONE: Record<ScanSeverity, "muted" | "info" | "warning" | "destructive"> = { info: "muted", low: "info", medium: "warning", high: "destructive" };

/** Settings → Integrity: scans (with fixes) and the hash-chained audit log, as two dense tables. */
export function IntegrityPanel() {
  const [report, setReport] = React.useState<ScanReport | null>(null);
  const [running, setRunning] = React.useState(false);
  const [audit, setAudit] = React.useState<AuditEvent[]>([]);
  const [chain, setChain] = React.useState<{ ok: boolean; checked: number; brokenAt?: string } | null>(null);
  const load = React.useCallback(async () => {
    const [s, a, c] = await Promise.all([fetch("/api/integrity/scan").then((r) => r.json()), fetch("/api/integrity/audit?limit=40").then((r) => r.json()), fetch("/api/integrity/audit?verify=1").then((r) => r.json())]);
    setReport(s.report ?? null); setAudit(a.events ?? []); setChain(c);
  }, []);
  React.useEffect(() => { void load(); }, [load]);
  const run = async () => {
    setRunning(true);
    try { const r = await fetch("/api/integrity/scan", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }); const j = await r.json(); setReport(j.report); toast.success(`Scan complete: ${j.report.totals.findings} finding${j.report.totals.findings === 1 ? "" : "s"}`); void load(); } catch (e) { toast.error(String(e)); } finally { setRunning(false); }
  };
  const fix = async (f: ScanFinding) => {
    const r = await fetch("/api/integrity/scan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fix: f.id }) });
    const j = await r.json();
    if (j.ok) { toast.success(j.message); void load(); } else toast.error(j.message);
  };
  const findings = (report?.results ?? []).flatMap((r) => r.findings.map((f) => ({ ...f, scanName: r.name }))).sort((a, b) => ["high", "medium", "low", "info"].indexOf(a.severity) - ["high", "medium", "low", "info"].indexOf(b.severity));
  return (
    <>
      <SettingsBlock
        id="scans"
        title="Data integrity scans"
        description="Orphaned references, duplicate documents, index coverage, stuck workflow runs, office document consistency and calendar gaps. Runs every 6 hours and shortly after startup."
        actions={<Button size="xs" variant="outline" onClick={run} disabled={running}>{running ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />} Run scans</Button>}
      >
        {report ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-muted-foreground">
            <span>Last run <RelativeTime value={report.ranAt} /> ({report.trigger})</span>
            <span>· {report.totals.checked.toLocaleString()} records checked</span>
            <span className="tabular">· {(["high", "medium", "low", "info"] as ScanSeverity[]).filter((s) => report.totals.bySeverity[s]).map((s) => `${report.totals.bySeverity[s]} ${s}`).join(", ") || "no findings"}</span>
          </div>
        ) : <div className="text-[11.5px] text-muted-foreground">No scan has run yet.</div>}
        {findings.length > 0 && (
          <ul className="mt-2 divide-y divide-line-quiet rounded-md border">
            {findings.map((f) => (
              <li key={f.id} className="flex min-h-8 items-center gap-3 px-2.5 py-1 text-[12px]">
                <Badge variant={TONE[f.severity]} size="sm" className="w-16 justify-center capitalize">{f.severity}</Badge>
                <div className="min-w-0 flex-1 leading-tight">
                  <div className="truncate font-medium">{f.title}{f.fixed && <span className="ml-2 text-[10.5px] text-success">fixed</span>}</div>
                  <div className="truncate text-[11px] text-muted-foreground">{f.scanName} · {f.detail}</div>
                </div>
                {f.target?.href && !isHiddenHref(f.target.href) && <Button asChild variant="ghost" size="xs"><Link href={f.target.href}><ExternalLink className="size-3" /> Open</Link></Button>}
                {f.fixable && !f.fixed && <Button variant="outline" size="xs" onClick={() => fix(f)}><Wrench className="size-3" /> Fix</Button>}
              </li>
            ))}
          </ul>
        )}
      </SettingsBlock>
      <SettingsBlock
        id="audit"
        title={<span className="inline-flex items-center gap-2">Audit log {chain && (chain.ok ? <span className="inline-flex items-center gap-1 text-[11px] font-normal text-muted-foreground"><span className="size-1.5 rounded-full bg-success" aria-hidden />chain intact · {chain.checked}</span> : <span className="inline-flex items-center gap-1 text-[11px] font-normal text-destructive"><span className="size-1.5 rounded-full bg-destructive" aria-hidden />chain broken at {chain.brokenAt}</span>)}</span>}
        description="Every AI generation, applied edit, coding change, import, export, workflow run and integrity fix, hash-chained so history cannot be silently altered."
      >
        {audit.length === 0 ? <div className="text-[11.5px] text-muted-foreground">No events yet.</div> : (
          <ul className="divide-y divide-line-quiet text-[12px]">
            {audit.map((e) => (
              <li key={e.id} className="flex h-7 items-center gap-3">
                <span className="w-24 shrink-0 truncate text-[11px] text-muted-foreground"><RelativeTime value={e.ts} /></span>
                <span className={cn("w-32 shrink-0 truncate font-mono text-[11px]", e.action.startsWith("ai.") ? "text-primary" : "text-muted-foreground")}>{e.action}</span>
                <span className="min-w-0 flex-1 truncate">{e.target.label ?? `${e.target.kind}${e.target.id ? ` ${e.target.id}` : ""}`}</span>
                <span className="shrink-0 truncate text-[11px] text-muted-foreground">{e.actorName}</span>
              </li>
            ))}
          </ul>
        )}
      </SettingsBlock>
    </>
  );
}
