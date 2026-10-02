"use client";
import * as React from "react";
import { ArrowDown, ArrowUp, BookCopy, FileDown, Loader2, Paperclip, Plus, RotateCcw, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/form";
import { annexureLabels, pageRangeLabel, PAPERBOOK_LIMITS, paperbookSourceLabel, type AnnexurePrefix, type PaperbookIndexRow } from "../../drafting";
import { errorKind, errorMessage } from "../api";
import { FilePicker } from "../file-picker";
import { formatBytes, safeFileName } from "../format";
import { Notice, SurfaceState } from "../notice";
import { postPaperbook, saveBlob } from "./drafting-api";
import type { DraftingProps } from "./drafting-tab";

interface Entry { key: string; fileId?: string; fileName?: string; title: string; annexure: boolean; attachment?: File }

const ACCEPT = ".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg";
let seq = 0;
const nextKey = () => `e${Date.now().toString(36)}${(seq++).toString(36)}`;
const stripExt = (n: string) => n.replace(/\.[a-z0-9]{2,5}$/i, "");

/** Paperbook builder: order the files, mark annexures, preview the index, build one paginated, bookmarked PDF. */
export function PaperbookTool({ setId, setName, fileCount }: DraftingProps) {
  const [title, setTitle] = React.useState(`Paperbook — ${setName}`);
  const [court, setCourt] = React.useState("");
  const [prefix, setPrefix] = React.useState<AnnexurePrefix>("P");
  const [startPage, setStartPage] = React.useState("1");
  const [indexPage, setIndexPage] = React.useState(true);
  const [trueCopy, setTrueCopy] = React.useState(true);
  const [entries, setEntries] = React.useState<Entry[]>([]);
  const [preview, setPreview] = React.useState<{ index: PaperbookIndexRow[]; totalPages: number } | null>(null);
  const [busy, setBusy] = React.useState<"preview" | "build" | null>(null);
  const [error, setError] = React.useState<{ message: string; denied: boolean } | null>(null);
  const attachRef = React.useRef<HTMLInputElement>(null);
  const originalFor = React.useRef<string | null>(null);
  const ctrl = React.useRef<AbortController | null>(null);
  React.useEffect(() => () => ctrl.current?.abort(), []);
  // Any change to the plan invalidates a shown index.
  React.useEffect(() => { setPreview(null); }, [entries, prefix, startPage, indexPage]);

  const labels = annexureLabels(entries, prefix);
  const attachedBytes = entries.reduce((n, e) => n + (e.attachment?.size ?? 0), 0);
  const overLimit = attachedBytes > PAPERBOOK_LIMITS.maxUploadBytes;

  const addFiles = (ids: string[], names: Record<string, string>) => {
    setEntries((cur) => [...cur, ...ids.filter((id) => !cur.some((e) => e.fileId === id)).map((id) => ({ key: nextKey(), fileId: id, fileName: names[id], title: stripExt(names[id] ?? "Document"), annexure: cur.length > 0 }))]);
  };
  const onPick = (files: FileList | null) => {
    const list = Array.from(files ?? []);
    if (!list.length) return;
    const target = originalFor.current;
    originalFor.current = null;
    if (target) { setEntries((cur) => cur.map((e) => (e.key === target ? { ...e, attachment: list[0] } : e))); return; }
    setEntries((cur) => [...cur, ...list.map((f) => ({ key: nextKey(), title: stripExt(f.name), annexure: true, attachment: f, fileName: f.name }))]);
  };
  const move = (i: number, d: -1 | 1) => setEntries((cur) => { const next = cur.slice(); const j = i + d; if (j < 0 || j >= next.length) return cur; [next[i], next[j]] = [next[j], next[i]]; return next; });
  const patch = (key: string, p: Partial<Entry>) => setEntries((cur) => cur.map((e) => (e.key === key ? { ...e, ...p } : e)));

  const spec = () => ({
    title: title.trim() || "Paperbook", court: court.trim() || undefined, prefix, startPage: Math.max(1, Number(startPage) || 1), indexPage, trueCopy,
    entries: entries.map((e) => ({ fileId: e.fileId, uploadKey: e.attachment ? e.key : undefined, title: e.title.trim() || e.fileName || "Document", annexure: e.annexure })),
  });
  const attachments = () => entries.filter((e) => e.attachment).map((e) => ({ key: e.key, file: e.attachment! }));

  const run = async (kind: "preview" | "build") => {
    ctrl.current?.abort();
    const ac = new AbortController();
    ctrl.current = ac;
    setBusy(kind); setError(null);
    try {
      const out = await postPaperbook(setId, spec(), attachments(), { preview: kind === "preview", signal: ac.signal });
      if (out instanceof Blob) { saveBlob(out, `${safeFileName(title || "Paperbook")}.pdf`); toast.success("Paperbook built", { description: "The download has started." }); }
      else setPreview(out);
    } catch (e) {
      if (ac.signal.aborted) return;
      setError({ message: errorMessage(e), denied: errorKind(e) === "denied" });
    } finally { setBusy(null); }
  };

  if (fileCount === 0 && !entries.length) {
    return <SurfaceState icon={BookCopy} title="No files to bind yet" action={<Button size="xs" variant="outline" onClick={() => attachRef.current?.click()}><Paperclip className="size-3.5" /> Attach a PDF or image</Button>}>Add files to this set (Files tab), or attach PDFs and images here, then order them into a paperbook.<input ref={attachRef} type="file" accept={ACCEPT} multiple className="hidden" onChange={(e) => { onPick(e.target.files); e.target.value = ""; }} /></SurfaceState>;
  }

  return (
    <div className="h-full overflow-y-auto scrollbar-thin">
      <div className="mx-auto w-full max-w-[1100px] space-y-3 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-[13px] font-semibold">Paperbook</h2>
          <span className="text-[11.5px] text-muted-foreground">Continuous page numbers on every page, annexure marks, index and bookmarks.</span>
        </div>
        <div className="grid gap-2 rounded-md border p-3 sm:grid-cols-2">
          <label className="space-y-1 text-[12px]"><span className="text-muted-foreground">Title</span><Input size="xs" value={title} onChange={(e) => setTitle(e.target.value)} /></label>
          <label className="space-y-1 text-[12px]"><span className="text-muted-foreground">Court / cause title line (index page)</span><Input size="xs" value={court} onChange={(e) => setCourt(e.target.value)} placeholder="IN THE SUPREME COURT OF INDIA" /></label>
          <div className="flex flex-wrap items-center gap-3 text-[12px] sm:col-span-2">
            <span className="flex items-center gap-1.5 text-muted-foreground">Annexure prefix <SegmentedControl size="xs" ariaLabel="Annexure prefix" value={prefix} onChange={(v: AnnexurePrefix) => setPrefix(v)} options={[{ value: "P", label: "P", title: "Petitioner" }, { value: "R", label: "R", title: "Respondent" }, { value: "A", label: "A", title: "Applicant / Appellant" }]} /></span>
            <label className="flex items-center gap-1.5 text-muted-foreground">First page no. <Input size="xs" className="w-16" inputMode="numeric" value={startPage} onChange={(e) => setStartPage(e.target.value.replace(/\D/g, "").slice(0, 4))} /></label>
            <label className="flex items-center gap-1.5"><Checkbox size="sm" checked={indexPage} onCheckedChange={(v) => setIndexPage(v === true)} /> Index page</label>
            <label className="flex items-center gap-1.5"><Checkbox size="sm" checked={trueCopy} onCheckedChange={(v) => setTrueCopy(v === true)} /> “TRUE COPY” on annexure pages</label>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <FilePicker setId={setId} value={[]} multi placeholder="Add files from this set" onChange={addFiles} />
          <Button size="xs" variant="outline" onClick={() => { originalFor.current = null; attachRef.current?.click(); }}><Paperclip className="size-3.5" /> Attach PDF or image</Button>
          <input ref={attachRef} type="file" accept={ACCEPT} multiple className="hidden" onChange={(e) => { onPick(e.target.files); e.target.value = ""; }} />
          <span className={cn("ms-auto text-[11.5px] tabular", overLimit ? "text-destructive" : "text-muted-foreground")}>Attachments {formatBytes(attachedBytes)} of {formatBytes(PAPERBOOK_LIMITS.maxUploadBytes)}</span>
        </div>

        {entries.length === 0 ? (
          <SurfaceState icon={Plus} title="Nothing in the paperbook yet">Add files from this set. A set file is typed from its stored text unless you attach its original PDF (used only if its SHA-256 matches the hash recorded for the set file; the index preview says whether that hash was computed on the server or declared by the browser at upload).</SurfaceState>
        ) : (
          <ol className="divide-y rounded-md border">
            {entries.map((e, i) => (
              <li key={e.key} className="flex flex-wrap items-center gap-2 px-2.5 py-2">
                <span className="w-5 text-right text-[11.5px] tabular text-muted-foreground">{i + 1}.</span>
                <Input size="xs" className="min-w-[200px] flex-1" value={e.title} onChange={(ev) => patch(e.key, { title: ev.target.value })} aria-label={`Title of entry ${i + 1}`} />
                <label className="flex items-center gap-1.5 text-[12px]"><Checkbox size="sm" checked={e.annexure} onCheckedChange={(v) => patch(e.key, { annexure: v === true })} /> Annexure</label>
                <span className="w-[104px] text-[11.5px] font-medium tabular">{labels[i] ?? <span className="text-muted-foreground">—</span>}</span>
                {(() => {
                  const what = e.fileId ? (e.attachment ? `Original attached: ${e.attachment.name} (${formatBytes(e.attachment.size)}) · hash checked on preview / build` : `${e.fileName ?? "Set file"} · typed from stored text`) : `Attachment: ${e.attachment?.name} (${formatBytes(e.attachment?.size ?? 0)})`;
                  return <span className="w-full min-w-0 text-[11.5px] text-muted-foreground sm:order-none sm:w-auto sm:max-w-[260px] sm:truncate" title={e.fileId && e.attachment ? `${what}: its SHA-256 is compared with the hash recorded for the set file; the index preview says whether that hash was computed on the server or declared by the browser at upload.` : what}>{what}</span>;
                })()}
                <div className="ms-auto flex items-center gap-0.5">
                  {e.fileId && !e.attachment && <Button size="xs" variant="ghost" onClick={() => { originalFor.current = e.key; attachRef.current?.click(); }} title="Attach the original PDF of this file">Attach original</Button>}
                  {e.fileId && e.attachment && <Button size="icon-xs" variant="ghost" aria-label="Remove attached original" onClick={() => patch(e.key, { attachment: undefined })}><X className="size-3.5" /></Button>}
                  <Button size="icon-xs" variant="ghost" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp className="size-3.5" /></Button>
                  <Button size="icon-xs" variant="ghost" aria-label="Move down" disabled={i === entries.length - 1} onClick={() => move(i, 1)}><ArrowDown className="size-3.5" /></Button>
                  <Button size="icon-xs" variant="ghost" aria-label="Remove from paperbook" onClick={() => setEntries((cur) => cur.filter((x) => x.key !== e.key))}><Trash2 className="size-3.5" /></Button>
                </div>
              </li>
            ))}
          </ol>
        )}

        {error && (error.denied
          ? <Notice tone="denied">{error.message}</Notice>
          : <Notice tone="destructive" action={<Button size="xs" variant="ghost" onClick={() => setError(null)}>Dismiss</Button>}>{error.message}</Notice>)}

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" disabled={!entries.length || overLimit || !!busy} onClick={() => void run("preview")}>{busy === "preview" ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />} Preview index</Button>
          <Button size="sm" disabled={!entries.length || overLimit || !!busy} onClick={() => void run("build")}>{busy === "build" ? <Loader2 className="size-3.5 animate-spin" /> : <FileDown className="size-3.5" />} Build PDF</Button>
          {busy && <Button size="sm" variant="ghost" onClick={() => ctrl.current?.abort()}>Cancel</Button>}
        </div>

        {preview && (
          <div className="rounded-md border">
            <div className="flex items-center gap-2 border-b px-3 py-1.5 text-[12px]"><span className="font-medium">Index</span><span className="ms-auto tabular text-muted-foreground">{preview.totalPages} pages</span></div>
            <table className="w-full text-[12.5px]">
              <thead className="text-left text-[11.5px] text-muted-foreground"><tr><th className="w-10 px-3 py-1 font-medium">Sl.</th><th className="px-2 py-1 font-medium">Particulars</th><th className="w-[120px] px-2 py-1 font-medium">Annexure</th><th className="w-[90px] px-3 py-1 text-right font-medium">Pages</th></tr></thead>
              <tbody className="divide-y">{preview.index.map((r) => (
                <tr key={r.sl} className="align-top">
                  <td className="px-3 py-1 tabular">{r.sl}</td>
                  <td className="px-2 py-1">
                    <div>{r.title}</div>
                    {r.source && <div className={cn("text-[11px]", r.source.kind === "original" && r.source.hash === "browser_declared" ? "text-warning-foreground dark:text-warning" : "text-muted-foreground")}>{paperbookSourceLabel(r.source)}</div>}
                  </td>
                  <td className="px-2 py-1 tabular">{r.annexure ?? "—"}</td>
                  <td className="px-3 py-1 text-right tabular">{pageRangeLabel(r)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
