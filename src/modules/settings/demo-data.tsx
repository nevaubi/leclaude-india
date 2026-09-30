"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowUpRight, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { StatusDot } from "@/components/ui/misc";
import { apiJSON, ApiError } from "@/modules/matters/components/api";
import { matterHref } from "@/lib/features";

/** Client view of GET /api/demo (mirrors DemoStatus in src/modules/demo; kept local so no server module is imported). */
export interface DemoStatusView {
  loaded: boolean;
  loadedAt: string | null;
  loadedBy: string | null;
  counts: Record<string, number> | null;
  matterId: string;
  relatedMatterId: string;
  matterIds?: string[];
}

const COUNT_LABELS: [string, string][] = [
  ["matters", "Matters"], ["teamMembers", "Team members"], ["edocs", "Case-record documents"], ["depositions", "Depositions (PW / DW)"],
  ["officeDocs", "Office documents"], ["libraryItems", "Library items"], ["tasks", "Tasks"], ["events", "Calendar events"],
  ["timeline", "Timeline events"], ["conflicts", "Conflicts"],
];

function when(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
}

/**
 * Settings → Demo data: loads (or removes) the synthetic India demo pack — a commercial suit before the Commercial
 * Court, Bengaluru, and a writ petition and a related bail matter before the Telangana High Court. The server
 * decides who may (owner, partner or admin) and records every id it writes, so removal touches nothing else.
 */
export function DemoDataSection({ initial }: { initial: DemoStatusView }) {
  const router = useRouter();
  const [status, setStatus] = React.useState<DemoStatusView>(initial);
  const [busy, setBusy] = React.useState<"load" | "remove" | null>(null);
  const [confirm, setConfirm] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const run = async (kind: "load" | "remove") => {
    setBusy(kind);
    setError(null);
    try {
      const next = await apiJSON<DemoStatusView & { durationMs?: number }>("/api/demo", { method: kind === "load" ? "POST" : "DELETE" });
      setStatus(next);
      setConfirm(false);
      if (kind === "load") toast.success(status.loaded ? "Demo data reloaded" : "Demo data loaded", { description: "The Bengaluru commercial suit and the Hyderabad writ and bail matters are ready in Matters and Case records." });
      else toast.success("Demo data removed", { description: "Only the records the demo added were deleted." });
      router.refresh();
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : (e as Error).message;
      setError(msg);
      toast.error(kind === "load" ? "Could not load the demo data" : "Could not remove the demo data", { description: msg });
    } finally {
      setBusy(null);
    }
  };

  const counts = status.counts;
  return (
    <div className="rounded-md border" aria-busy={!!busy}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5">
        <div className="flex min-w-0 flex-1 items-center gap-2 text-[12.5px]" role="status">
          <StatusDot tone={status.loaded ? "success" : "muted"} pulse={!!busy} />
          {busy === "load" ? (
            <span className="text-muted-foreground">Loading the demo matters, case records and depositions…</span>
          ) : busy === "remove" ? (
            <span className="text-muted-foreground">Removing the demo records…</span>
          ) : status.loaded ? (
            <span className="min-w-0 truncate"><span className="font-medium">Loaded</span><span className="text-muted-foreground">{status.loadedAt ? ` · ${when(status.loadedAt)}` : ""}{status.loadedBy ? ` by ${status.loadedBy}` : ""}</span></span>
          ) : (
            <span className="text-muted-foreground">Not loaded</span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {status.loaded && (
            <Button size="xs" variant="ghost" onClick={() => setConfirm(true)} disabled={!!busy}>
              {busy === "remove" && <Loader2 className="size-3 animate-spin" />} Remove demo data
            </Button>
          )}
          <Button size="xs" variant={status.loaded ? "outline" : "default"} onClick={() => void run("load")} disabled={!!busy}>
            {busy === "load" && <Loader2 className="size-3 animate-spin" />} {status.loaded ? "Reload demo data" : "Load demo data"}
          </Button>
        </div>
      </div>
      {error && <div className="border-t px-3 py-2 text-[12px] text-destructive" role="alert">{error}</div>}
      {status.loaded && counts && (
        <div className="border-t px-3 py-2.5">
          <div className="grid grid-cols-2 gap-x-6 sm:grid-cols-3">
            {COUNT_LABELS.filter(([k]) => typeof counts[k] === "number").map(([k, label]) => (
              <div key={k} className="flex h-7 items-center justify-between border-b border-line-quiet text-[12px]"><span className="text-muted-foreground">{label}</span><span className="tabular">{counts[k].toLocaleString()}</span></div>
            ))}
          </div>
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            <Button size="xs" variant="outline" asChild><Link href={`/matters?id=${encodeURIComponent(status.matterId)}`}>Open matter <ArrowUpRight className="size-3" /></Link></Button>
            <Button size="xs" variant="outline" asChild><Link href={matterHref(status.matterId)}>Open case records <ArrowUpRight className="size-3" /></Link></Button>
            <Button size="xs" variant="outline" asChild><Link href={`/matters?id=${encodeURIComponent(status.relatedMatterId)}`}>Open Hyderabad writ <ArrowUpRight className="size-3" /></Link></Button>
          </div>
        </div>
      )}
      <Dialog open={confirm} onOpenChange={(o) => !busy && setConfirm(o)}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Remove the demo data?</DialogTitle>
            <DialogDescription>This deletes the three demo matters, the demo team members and every document, deposition, task and file the demo added, including edits made to them. Your own matters, people and the workspace owner are not touched. This cannot be undone.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button size="sm" variant="ghost" onClick={() => setConfirm(false)} disabled={!!busy}>Cancel</Button>
            <Button size="sm" variant="destructive" onClick={() => void run("remove")} disabled={!!busy}>{busy === "remove" && <Loader2 className="size-3.5 animate-spin" />} Remove demo data</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
