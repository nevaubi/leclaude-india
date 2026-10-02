"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertCircle, Files, Loader2, Plus, RotateCcw, ShieldAlert, Trash2 } from "lucide-react";
import { PageTopbar } from "@/components/shell/page-topbar";
import { Button } from "@/components/ui/button";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState } from "@/components/ui/misc";
import { RelativeTime } from "@/components/ui/relative-time";
import type { DocSet } from "../types";
import { docsApi, errorKind, errorMessage, type ApiErrorKind, type DocsStatus } from "./api";
import { Notice } from "./notice";

export interface MatterChoice { id: string; shortName: string; name?: string }

type Load = { status: "loading" } | { status: "ready"; sets: DocSet[] } | { status: "error"; message: string; kind: ApiErrorKind; code?: number };

/** /documents: the document sets the user can see, with create and delete. */
/** `matterFilter` (?matter=<id>, where matter links across the app land) narrows the list to that matter's sets. */
export function SetsPage({ initialSets, matters, matterFilter = null }: { initialSets: DocSet[] | null; matters: MatterChoice[]; matterFilter?: string | null }) {
  const router = useRouter();
  const [load, setLoad] = React.useState<Load>(initialSets ? { status: "ready", sets: initialSets } : { status: "loading" });
  const [reload, setReload] = React.useState(initialSets ? 0 : 1);
  const [status, setStatus] = React.useState<DocsStatus | null>(null);
  const [newOpen, setNewOpen] = React.useState(false);
  const [toDelete, setToDelete] = React.useState<DocSet | null>(null);
  const matterName = React.useMemo(() => new Map(matters.map((m) => [m.id, m.shortName || m.name || m.id])), [matters]);

  React.useEffect(() => {
    if (!reload) return;
    const ac = new AbortController();
    setLoad((l) => (l.status === "ready" ? l : { status: "loading" }));
    docsApi<{ sets: DocSet[] }>("/api/documents/sets", { signal: ac.signal })
      .then((r) => setLoad({ status: "ready", sets: r.sets }))
      .catch((e) => { if (!ac.signal.aborted) setLoad({ status: "error", message: errorMessage(e), kind: errorKind(e), code: (e as { status?: number }).status }); });
    return () => ac.abort();
  }, [reload]);

  React.useEffect(() => {
    const ac = new AbortController();
    docsApi<DocsStatus>("/api/documents/status", { signal: ac.signal }).then(setStatus).catch(() => {});
    return () => ac.abort();
  }, []);

  const allSets = load.status === "ready" ? load.sets : [];
  const sets = matterFilter ? allSets.filter((s) => s.matterId === matterFilter) : allSets;
  const filterMatter = matterFilter ? matters.find((m) => m.id === matterFilter) : null;

  // Columns fit the panel: the set name takes the remaining width, and the lowest-priority columns (pages, facts
  // extracted) drop out when the panel is narrow, so nothing clips and the table never scrolls sideways at 1024 px.
  const tableRef = React.useRef<HTMLDivElement>(null);
  const [tableWidth, setTableWidth] = React.useState(0);
  React.useEffect(() => {
    const el = tableRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setTableWidth(Math.floor(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const SIDE = { matter: 160, files: 70, pages: 80, extracted: 120, updated: 130 } as const;
  const ACTIONS = 36 + 4; // row-actions column plus a hairline of slack
  const fullFixed = Object.values(SIDE).reduce((a, b) => a + b, 0) + ACTIONS;
  const compact = tableWidth > 0 && tableWidth - fullFixed < 300;
  const fixed = compact ? fullFixed - SIDE.pages - SIDE.extracted : fullFixed;
  const nameWidth = tableWidth > 0 ? Math.max(220, tableWidth - fixed) : 400;

  const columns = React.useMemo<DataTableColumn<DocSet>[]>(() => [
    { id: "name", header: "Set", width: nameWidth, minWidth: 180, sortable: true, locked: true, accessor: (s) => s.name, render: (s) => (
      // The name has priority: it keeps its full width (truncating only when it alone is wider than the column) and
      // the description takes what is left.
      <span className="flex min-w-0 items-baseline gap-2" title={s.description ? `${s.name} — ${s.description}` : s.name}>
        <span className="min-w-0 max-w-full shrink-0 truncate font-medium text-foreground">{s.name}</span>
        {s.description && <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">{s.description}</span>}
      </span>
    ) },
    { id: "matter", header: "Matter", width: SIDE.matter, sortable: true, accessor: (s) => (s.matterId ? matterName.get(s.matterId) ?? "" : ""), render: (s) => (
      s.matterId ? <span className="truncate">{matterName.get(s.matterId) ?? "Matter"}</span> : <span className="text-muted-foreground">Personal</span>
    ) },
    { id: "files", header: "Files", width: SIDE.files, align: "right", sortable: true, accessor: (s) => s.fileCount, render: (s) => <span className="tabular">{s.fileCount.toLocaleString("en-IN")}</span> },
    ...(compact ? [] : [
    { id: "pages", header: "Pages", width: SIDE.pages, align: "right", sortable: true, accessor: (s) => s.pageCount, render: (s) => <span className="tabular text-muted-foreground">{s.pageCount.toLocaleString("en-IN")}</span> },
    { id: "extracted", header: "Facts extracted", width: SIDE.extracted, align: "right", sortable: true, accessor: (s) => (s.fileCount ? s.extractedCount / s.fileCount : 0), render: (s) => (
      <span className="tabular text-muted-foreground">{s.fileCount ? `${s.extractedCount.toLocaleString("en-IN")} of ${s.fileCount.toLocaleString("en-IN")}` : "—"}</span>
    ) }] satisfies DataTableColumn<DocSet>[]),
    { id: "updated", header: "Updated", width: SIDE.updated, sortable: true, accessor: (s) => s.updatedAt, render: (s) => <RelativeTime value={s.updatedAt} className="text-muted-foreground" /> },
  ], [compact, matterName, nameWidth]); // eslint-disable-line react-hooks/exhaustive-deps -- SIDE is a constant

  const empty = (
    <EmptyState icon={Files} title="No document sets yet"
      description="Upload a set of files, then ask questions across them, pull out key facts and build a timeline."
      action={<Button size="sm" onClick={() => setNewOpen(true)}><Plus className="size-3.5" /> New set</Button>} />
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageTopbar icon={<Files />} title="Documents" context={load.status === "ready" ? `${sets.length} set${sets.length === 1 ? "" : "s"}` : undefined}>
        <div className="ms-auto flex items-center gap-2">
          <Button size="sm" onClick={() => setNewOpen(true)} disabled={load.status === "error" && load.kind === "auth"}><Plus className="size-3.5" /> New set</Button>
        </div>
      </PageTopbar>
      {matterFilter && (
        <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5 text-[12px]">
          <span className="text-muted-foreground">Matter</span>
          <span className="font-medium">{filterMatter ? filterMatter.shortName : "Not found or no access"}</span>
          <Link href="/documents" className="text-primary hover:underline">Show all sets</Link>
        </div>
      )}
      {status?.storage.full && (
        <Notice tone="warning" className="m-3 mb-0">Document storage is full ({Math.round(status.storage.usedMb)} of {status.storage.limitMb} MB). New files cannot be added until storage is increased.</Notice>
      )}
      <div ref={tableRef} className="min-h-0 flex-1">
        {load.status === "error" ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            {load.code === 403 || load.kind === "auth" ? <ShieldAlert className="size-5 text-muted-foreground" aria-hidden /> : <AlertCircle className="size-5 text-muted-foreground" aria-hidden />}
            <p className="max-w-md text-[13px] text-muted-foreground">
              {load.code === 403 ? "You do not have access to document sets." : load.code === 404 ? "Document sets are not available on this server yet." : load.message}
            </p>
            <Button size="xs" variant="ghost" onClick={() => setReload((n) => n + 1)}><RotateCcw className="size-3.5" /> Try again</Button>
          </div>
        ) : (
          <DataTable
            rows={sets}
            columns={columns}
            rowId={(s) => s.id}
            noun="set"
            selectionMode="none"
            onRowClick={(s) => router.push(`/documents/${encodeURIComponent(s.id)}`)}
            onRowActivate={(s) => router.push(`/documents/${encodeURIComponent(s.id)}`)}
            rowActions={(s) => (
              <Button size="icon-xs" variant="ghost" aria-label={`Delete ${s.name}`} title="Delete set" onClick={(e) => { e.stopPropagation(); setToDelete(s); }}>
                <Trash2 className="size-3.5" />
              </Button>
            )}
            defaultSort={{ columnId: "updated", dir: "desc" }}
            loading={load.status === "loading"}
            empty={empty}
            ariaLabel="Document sets"
          />
        )}
      </div>
      <NewSetDialog open={newOpen} onOpenChange={setNewOpen} matters={matters} defaultMatterId={filterMatter?.id} onCreated={(s) => router.push(`/documents/${encodeURIComponent(s.id)}`)} />
      <DeleteSetDialog set={toDelete} onClose={() => setToDelete(null)} onDeleted={(id) => setLoad((l) => (l.status === "ready" ? { ...l, sets: l.sets.filter((s) => s.id !== id) } : l))} />
    </div>
  );
}

const NO_MATTER = "__none__";

export function NewSetDialog({ open, onOpenChange, matters, onCreated, defaultMatterId }: { open: boolean; onOpenChange: (o: boolean) => void; matters: MatterChoice[]; onCreated: (s: DocSet) => void; defaultMatterId?: string }) {
  const [name, setName] = React.useState("");
  const [matterId, setMatterId] = React.useState<string>(NO_MATTER);
  const [description, setDescription] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [touched, setTouched] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setName(""); setMatterId(defaultMatterId ?? NO_MATTER); setDescription(""); setError(null); setTouched(false);
  }, [open, defaultMatterId]);

  const nameError = touched && !name.trim() ? "Give the set a name." : undefined;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!name.trim()) return;
    setBusy(true); setError(null);
    try {
      const r = await docsApi<{ set: DocSet }>("/api/documents/sets", { json: { name: name.trim(), description: description.trim() || undefined, matterId: matterId === NO_MATTER ? undefined : matterId } });
      toast.success(`Created ${r.set.name}`);
      onOpenChange(false);
      onCreated(r.set);
    } catch (err) {
      setError(errorKind(err) === "denied" ? "You cannot add document sets to that matter." : errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <form onSubmit={submit} className="grid gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>New document set</DialogTitle>
            <DialogDescription>A set holds files you want to question together. Files are read into text; the original files are not stored.</DialogDescription>
          </DialogHeader>
          <Field label="Name" required htmlFor="docset-name" error={nameError}>
            <Input id="docset-name" size="sm" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Tender correspondence 2019–2022" autoFocus maxLength={160} aria-invalid={!!nameError} />
          </Field>
          <Field label="Matter" htmlFor="docset-matter" help={matterId === NO_MATTER ? "Without a matter, only you can see this set." : "Everyone with access to the matter can see this set."}>
            <Select value={matterId} onValueChange={setMatterId}>
              <SelectTrigger id="docset-matter" size="sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_MATTER}>No matter (personal)</SelectItem>
                {matters.map((m) => <SelectItem key={m.id} value={m.id}>{m.shortName || m.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Description" htmlFor="docset-desc">
            <Textarea id="docset-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} maxLength={1000} placeholder="Optional" />
          </Field>
          {error && <Notice tone="destructive">{error}</Notice>}
          <DialogFooter>
            <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" size="sm" disabled={busy}>{busy && <Loader2 className="size-3.5 animate-spin" />} Create set</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function DeleteSetDialog({ set, onClose, onDeleted }: { set: DocSet | null; onClose: () => void; onDeleted: (id: string) => void }) {
  const [busy, setBusy] = React.useState(false);
  const del = async () => {
    if (!set) return;
    setBusy(true);
    try {
      await docsApi(`/api/documents/sets/${encodeURIComponent(set.id)}`, { method: "DELETE" });
      toast.success(`Deleted ${set.name}`);
      onDeleted(set.id);
      onClose();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={!!set} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Delete this set?</DialogTitle>
          <DialogDescription>
            {set ? <>“{set.name}” and its {set.fileCount.toLocaleString("en-IN")} file{set.fileCount === 1 ? "" : "s"}, extracted text, facts and timeline will be deleted. This cannot be undone.</> : null}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button variant="destructive" size="sm" onClick={del} disabled={busy}>{busy && <Loader2 className="size-3.5 animate-spin" />} Delete set</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
