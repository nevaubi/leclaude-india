"use client";
import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { AlertCircle, CalendarRange, ChevronLeft, Files, FolderOpen, ListChecks, MessageSquareText, RotateCcw, ShieldAlert, Trash2 } from "lucide-react";
import { PageTopbar } from "@/components/shell/page-topbar";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { DocSet } from "../types";
import { docsApi, errorKind, errorMessage, setUrl, type ApiErrorKind, type DocsStatus } from "./api";
import { AskTab } from "./ask-tab";
import { WORKSPACE_TABS, type WorkspaceTab } from "./format";
import { FactsTab, TimelineTab, useExtraction } from "./extract-tabs";
import { FilesTab } from "./files-tab";
import { Notice, SurfaceState } from "./notice";
import { DeleteSetDialog, type MatterChoice } from "./sets-page";
import { TextViewer, type ViewerTarget } from "./text-viewer";
import { useDocUploads } from "./use-doc-uploads";


type Load = { status: "loading" } | { status: "ready"; set: DocSet } | { status: "error"; message: string; kind: ApiErrorKind };

/** /documents/[id]: one set, with Files | Ask | Facts | Timeline (tab in ?tab=). */
export function SetWorkspace({ setId, initialTab, matters }: { setId: string; initialTab: WorkspaceTab; matters: MatterChoice[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [tab, setTab] = React.useState<WorkspaceTab>(initialTab);
  const [load, setLoad] = React.useState<Load>({ status: "loading" });
  const [reload, setReload] = React.useState(0);
  const [status, setStatus] = React.useState<DocsStatus | null>(null);
  const [viewer, setViewer] = React.useState<ViewerTarget | null>(null);
  const [filesKey, setFilesKey] = React.useState(0);
  const [extractKey, setExtractKey] = React.useState(0);
  const [deleting, setDeleting] = React.useState(false);

  const refreshSet = React.useCallback(() => setReload((n) => n + 1), []);

  React.useEffect(() => {
    const ac = new AbortController();
    docsApi<{ set: DocSet }>(setUrl(setId), { signal: ac.signal })
      .then((r) => setLoad({ status: "ready", set: r.set }))
      .catch((e) => { if (!ac.signal.aborted) setLoad((l) => (l.status === "ready" && errorKind(e) === "other" ? l : { status: "error", message: errorMessage(e), kind: errorKind(e) })); });
    return () => ac.abort();
  }, [setId, reload]);

  React.useEffect(() => {
    const ac = new AbortController();
    docsApi<DocsStatus>("/api/documents/status", { signal: ac.signal }).then(setStatus).catch(() => {});
    return () => ac.abort();
  }, [reload]);

  const uploads = useDocUploads(setId, { onSettled: () => { setFilesKey((n) => n + 1); refreshSet(); } });
  const extraction = useExtraction(setId, () => { setExtractKey((n) => n + 1); refreshSet(); });

  const selectTab = (v: string) => {
    const next = (WORKSPACE_TABS as readonly string[]).includes(v) ? (v as WorkspaceTab) : "files";
    setTab(next);
    const sp = new URLSearchParams(params.toString());
    if (next === "files") sp.delete("tab"); else sp.set("tab", next);
    const qs = sp.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  // Warn before leaving while uploads are in flight (their File handles live only in this tab).
  React.useEffect(() => {
    if (!uploads.busy) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [uploads.busy]);

  if (load.status === "error" && (load.kind === "denied" || load.kind === "auth")) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <PageTopbar icon={<Files />} title="Documents" />
        <SurfaceState icon={ShieldAlert} title="Not found or no access" className="flex-1" action={<Button asChild size="sm" variant="outline"><Link href="/documents"><ChevronLeft className="size-3.5" /> All document sets</Link></Button>}>
          {load.message}
        </SurfaceState>
      </div>
    );
  }
  if (load.status === "error") {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <PageTopbar icon={<Files />} title="Documents" />
        <SurfaceState icon={AlertCircle} title="This set could not be opened" className="flex-1" action={<Button size="sm" variant="ghost" onClick={refreshSet}><RotateCcw className="size-3.5" /> Try again</Button>}>{load.message}</SurfaceState>
      </div>
    );
  }

  const set = load.status === "ready" ? load.set : null;
  const matter = set?.matterId ? matters.find((m) => m.id === set.matterId) : null;
  const aiReady = status ? status.ai : null;
  const storageFull = uploads.storageFull ?? (status?.storage.full ? `Document storage is full (${Math.round(status.storage.usedMb)} of ${status.storage.limitMb} MB). New files cannot be added until storage is increased.` : null);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageTopbar
        icon={<Files />}
        title={<span className="flex min-w-0 items-center gap-1.5"><Link href="/documents" className="text-muted-foreground hover:text-foreground">Documents</Link><span className="text-muted-foreground">/</span><span className="max-w-[40vw] truncate">{set?.name ?? "…"}</span></span>}
        context={set ? [matter ? matter.shortName : set.matterId ? "Matter" : "Personal", `${set.fileCount.toLocaleString("en-IN")} file${set.fileCount === 1 ? "" : "s"}`, `${set.pageCount.toLocaleString("en-IN")} pages`].join(" · ") : undefined}
      >
        <div className="ms-auto flex items-center gap-1">
          {set && <Button size="icon-xs" variant="ghost" aria-label="Delete set" title="Delete set" onClick={() => setDeleting(true)}><Trash2 className="size-3.5" /></Button>}
        </div>
      </PageTopbar>
      <Tabs value={tab} onValueChange={selectTab} className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-3 border-b px-3">
          <TabsList variant="underline" className="border-b-0">
            <TabsTrigger value="files"><FolderOpen /> Files{set ? <span className="tabular text-muted-foreground">{set.fileCount.toLocaleString("en-IN")}</span> : null}</TabsTrigger>
            <TabsTrigger value="ask"><MessageSquareText /> Ask</TabsTrigger>
            <TabsTrigger value="facts"><ListChecks /> Facts</TabsTrigger>
            <TabsTrigger value="timeline"><CalendarRange /> Timeline</TabsTrigger>
          </TabsList>
          {set?.description && <span className="hidden min-w-0 truncate text-[12px] text-muted-foreground lg:inline" title={set.description}>{set.description}</span>}
        </div>
        {load.status === "loading" ? (
          <div className="space-y-2 p-3" aria-busy="true">
            <div className="h-24 animate-pulse rounded-lg bg-muted" />
            <div className="h-64 animate-pulse rounded-md bg-muted/60" />
          </div>
        ) : (
          <>
            {aiReady === false && tab === "files" && <Notice tone="info" className="mx-3 mt-3">AI is not configured, so scanned pages cannot be read and Ask, Facts and Timeline are unavailable. Files can still be added and read.</Notice>}
            <TabsContent value="files" forceMount className="mt-0 min-h-0 flex-1 data-[state=inactive]:hidden">
              <FilesTab setId={setId} uploads={uploads} aiReady={aiReady} storageFull={storageFull} onView={setViewer} onChanged={refreshSet} refreshKey={filesKey} />
            </TabsContent>
            <TabsContent value="ask" forceMount className="mt-0 min-h-0 flex-1 data-[state=inactive]:hidden">
              <AskTab setId={setId} aiReady={aiReady} fileCount={set?.fileCount ?? 0} onView={setViewer} />
            </TabsContent>
            <TabsContent value="facts" className="mt-0 min-h-0 flex-1">
              <FactsTab setId={setId} setName={set?.name ?? "set"} extraction={extraction} aiReady={aiReady} refreshKey={extractKey + filesKey} onView={setViewer} />
            </TabsContent>
            <TabsContent value="timeline" className="mt-0 min-h-0 flex-1">
              <TimelineTab setId={setId} setName={set?.name ?? "set"} extraction={extraction} aiReady={aiReady} refreshKey={extractKey + filesKey} onView={setViewer} />
            </TabsContent>
          </>
        )}
      </Tabs>
      <TextViewer setId={setId} target={viewer} onClose={() => setViewer(null)} />
      <DeleteSetDialog set={deleting ? set : null} onClose={() => setDeleting(false)} onDeleted={() => router.push("/documents")} />
    </div>
  );
}
