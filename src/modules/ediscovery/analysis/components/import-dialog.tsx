"use client";
import * as React from "react";
import { Loader2, Upload } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field, SegmentedControl } from "@/components/ui/form";
import { FileDrop } from "@/components/ui/file-drop";
import type { DroppedFile } from "@/components/ui/form-helpers";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { Deposition } from "@/lib/types/domain";
import type { DepositionSummary, ParsedTranscript } from "../types";
import { formatPageLine } from "../types";
import { ISSUE_LABEL, parseTranscript, summarizeIssues } from "../transcript-import";
import { ApiError } from "./use-analysis-data";

type Mode = "file" | "paste";

const ACCEPT = [".txt", ".ptx", ".asc", ".docx", "text/plain"];

interface Meta { witnessName: string; witnessTitle: string; date: string; takenBy: string; defendingBy: string; volume: string; location: string }

/**
 * Import a transcript (.txt / .ptx / .asc / .docx, or pasted text). The text is
 * previewed with the same parser the server uses so page:line detection,
 * speakers, exhibits and parse issues are visible before anything is created.
 */
export function ImportTranscriptDialog({ open, onOpenChange, matterId, depositions, onImported }: { open: boolean; onOpenChange: (o: boolean) => void; matterId: string; depositions: DepositionSummary[]; onImported: (dep: Deposition) => void }) {
  const [mode, setMode] = React.useState<Mode>("file");
  const [files, setFiles] = React.useState<DroppedFile[]>([]);
  const [text, setText] = React.useState("");
  const [preview, setPreview] = React.useState<ParsedTranscript | null>(null);
  const [previewing, setPreviewing] = React.useState(false);
  const [meta, setMeta] = React.useState<Meta>({ witnessName: "", witnessTitle: "", date: "", takenBy: "", defendingBy: "", volume: "1", location: "" });
  const [replaceId, setReplaceId] = React.useState<string>("");
  const [saving, setSaving] = React.useState(false);
  const file = files[0]?.file;
  const isDocx = !!file && /\.docx$/i.test(file.name);

  React.useEffect(() => { if (!open) { setFiles([]); setText(""); setPreview(null); setReplaceId(""); setMeta({ witnessName: "", witnessTitle: "", date: "", takenBy: "", defendingBy: "", volume: "1", location: "" }); } }, [open]);

  // Preview: plain text is parsed in the browser; .docx goes to the server for extraction.
  React.useEffect(() => {
    let alive = true;
    const run = async () => {
      if (mode === "paste") { if (!text.trim()) { setPreview(null); return; } setPreview(parseTranscript(text)); return; }
      if (!file) { setPreview(null); return; }
      setPreviewing(true);
      try {
        if (!isDocx) { const t = await file.text(); if (alive) setPreview(parseTranscript(t)); }
        else {
          const fd = new FormData(); fd.append("file", file); fd.append("matterId", matterId); fd.append("preview", "1");
          const res = await fetch("/api/ediscovery/analysis/depositions/import", { method: "POST", body: fd });
          const data = await res.json();
          if (!res.ok) throw new ApiError(data.error ?? res.statusText, res.status, data.code);
          if (alive) setPreview(data.parsed as ParsedTranscript);
        }
      } catch (e) { if (alive) { setPreview(null); toast.error("Could not read the transcript", { description: (e as Error).message }); } }
      finally { if (alive) setPreviewing(false); }
    };
    const t = setTimeout(run, mode === "paste" ? 250 : 0);
    return () => { alive = false; clearTimeout(t); };
  }, [mode, file, text, isDocx, matterId]);

  // Header metadata fills the empty fields once a preview exists.
  React.useEffect(() => {
    if (!preview) return;
    setMeta((m) => ({ ...m, witnessName: m.witnessName || preview.meta.witnessName || "", date: m.date || preview.meta.date || "", takenBy: m.takenBy || preview.meta.takenBy || "", defendingBy: m.defendingBy || preview.meta.defendingBy || "", volume: m.volume === "1" && preview.meta.volume ? String(preview.meta.volume) : m.volume }));
  }, [preview]);

  const set = (k: keyof Meta, v: string) => setMeta((m) => ({ ...m, [k]: v }));
  const canSave = !!preview?.transcript.length && !!meta.witnessName.trim() && !saving;

  const save = async () => {
    if (!preview) return;
    setSaving(true);
    try {
      const common = { matterId, witnessName: meta.witnessName.trim(), witnessTitle: meta.witnessTitle.trim() || undefined, date: meta.date || undefined, takenBy: meta.takenBy.trim() || undefined, defendingBy: meta.defendingBy.trim() || undefined, volume: Number(meta.volume) || 1, location: meta.location.trim() || undefined, depositionId: replaceId || undefined };
      let res: Response;
      if (mode === "file" && file) {
        const fd = new FormData();
        fd.append("file", file);
        for (const [k, v] of Object.entries(common)) if (v !== undefined) fd.append(k, String(v));
        res = await fetch("/api/ediscovery/analysis/depositions/import", { method: "POST", body: fd });
      } else {
        res = await fetch("/api/ediscovery/analysis/depositions/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...common, text, sourceKind: "paste" }) });
      }
      const data = await res.json();
      if (!res.ok) throw new ApiError(data.error ?? res.statusText, res.status, data.code);
      toast.success(`Imported ${data.deposition.witnessName}`, { description: `${data.parsed.transcript.length} Q/A · ${data.parsed.pages} pages · ${Math.round(data.parsed.confidence * 100)}% parse confidence` });
      onImported(data.deposition as Deposition);
      onOpenChange(false);
    } catch (e) { toast.error("Import failed", { description: (e as Error).message }); }
    finally { setSaving(false); }
  };

  const issues = preview ? summarizeIssues(preview.issues) : [];
  const conf = preview ? Math.round(preview.confidence * 100) : 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="xl" className="flex max-h-[92vh] flex-col">
        <DialogHeader><DialogTitle className="flex items-center gap-2"><Upload className="size-4" /> Import transcript</DialogTitle><DialogDescription>Reporter formats with page:line on every line (.txt, .ptx, .asc), page-and-margin numbering, or a Word file. The preview shows what was recognised before the deposition is created.</DialogDescription></DialogHeader>
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-auto scrollbar-thin lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="space-y-3">
            <SegmentedControl<Mode> value={mode} onChange={setMode} options={[{ value: "file", label: "File" }, { value: "paste", label: "Paste text" }]} ariaLabel="Transcript source" />
            {mode === "file" ? (
              <FileDrop files={files} onChange={(f, rejected) => { setFiles(f.slice(-1)); if (rejected.length) toast.error(`${rejected[0].name}: ${rejected[0].reason}`); }} accept={ACCEPT} multiple={false} maxFiles={1} maxSize={25 * 1024 * 1024} label="Drop the transcript here" help=".txt, .ptx, .asc or .docx · up to 25 MB" />
            ) : (
              <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={12} className="font-mono text-[11.5px]" placeholder={"0024:05   Q.   When did you first see the report?\n0024:06   A.   In March of 2001.\n0024:07        MR. SMITH:  Objection, form."} aria-label="Transcript text" />
            )}
            <div className="grid grid-cols-2 gap-x-3 gap-y-2">
              <Field label="Witness" required htmlFor="imp-witness"><Input id="imp-witness" size="xs" value={meta.witnessName} onChange={(e) => set("witnessName", e.target.value)} placeholder="Witness name" /></Field>
              <Field label="Title" htmlFor="imp-title"><Input id="imp-title" size="xs" value={meta.witnessTitle} onChange={(e) => set("witnessTitle", e.target.value)} placeholder="Title or role" /></Field>
              <Field label="Date" htmlFor="imp-date"><Input id="imp-date" size="xs" type="date" value={meta.date} onChange={(e) => set("date", e.target.value)} /></Field>
              <Field label="Volume" htmlFor="imp-vol"><Input id="imp-vol" size="xs" type="number" min={1} value={meta.volume} onChange={(e) => set("volume", e.target.value)} /></Field>
              <Field label="Taken by" htmlFor="imp-taken"><Input id="imp-taken" size="xs" value={meta.takenBy} onChange={(e) => set("takenBy", e.target.value)} placeholder="Examining attorney" /></Field>
              <Field label="Defended by" htmlFor="imp-def"><Input id="imp-def" size="xs" value={meta.defendingBy} onChange={(e) => set("defendingBy", e.target.value)} placeholder="Defending attorney" /></Field>
              <Field label="Location" htmlFor="imp-loc" className="col-span-2"><Input id="imp-loc" size="xs" value={meta.location} onChange={(e) => set("location", e.target.value)} /></Field>
              <Field label="Replace existing" help="Optional: replace a scheduled or rough transcript instead of adding a deposition." htmlFor="imp-replace" className="col-span-2">
                <select id="imp-replace" value={replaceId} onChange={(e) => setReplaceId(e.target.value)} className="control h-7 w-full rounded-md border bg-background px-2 text-[12.5px]">
                  <option value="">Create a new deposition</option>
                  {depositions.map((d) => <option key={d.id} value={d.id}>{d.witnessName} · Vol. {d.volume ?? 1} · {d.status}</option>)}
                </select>
              </Field>
            </div>
          </div>
          <div className="min-w-0 space-y-3">
            <div className="text-[12px] font-medium text-muted-foreground">Preview</div>
            {previewing ? <div className="flex h-24 items-center justify-center text-xs text-muted-foreground"><Loader2 className="mr-2 size-4 animate-spin" /> Reading…</div> : !preview ? <div className="rounded-md border border-dashed p-6 text-center text-xs text-muted-foreground">Add a file or paste text to see what the parser recognises.</div> : (
              <>
                <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-1 text-[12px]">
                  <dt className="text-muted-foreground">Format</dt><dd>{preview.format === "indian" ? "deposition sheet: chief, cross- and re-examination" : preview.format === "page-line" ? "page:line on every line" : preview.format === "page-numbered" ? "page markers + margin numbers" : "unnumbered (estimated)"}</dd>
                  <dt className="text-muted-foreground">Confidence</dt><dd className={cn("tabular", conf < 70 && "text-warning-foreground dark:text-warning")}>{conf}%</dd>
                  <dt className="text-muted-foreground">Testimony</dt><dd className="tabular">{preview.transcript.length} Q/A · pages {preview.firstPage}–{preview.pages} · {preview.stats.objections} objections · {preview.stats.colloquy} colloquy</dd>
                  <dt className="text-muted-foreground">Speakers</dt><dd className="truncate">{preview.speakers.slice(0, 5).map((s) => `${s.label} (${s.role})`).join(", ") || "—"}</dd>
                  <dt className="text-muted-foreground">Exhibits</dt><dd className="truncate">{preview.exhibits.map((e) => e.id).join(", ") || "none marked"}</dd>
                  {preview.meta.caseCaption && <><dt className="text-muted-foreground">Caption</dt><dd className="truncate">{preview.meta.caseCaption}</dd></>}
                </dl>
                <div>
                  <div className="mb-1 text-[12px] font-medium text-muted-foreground">Parse issues ({preview.issues.length})</div>
                  {!issues.length ? <div className="text-[11.5px] text-muted-foreground">None.</div> : (
                    <div className="max-h-40 overflow-auto rounded-md border scrollbar-thin">
                      <table className="w-full text-[11.5px]">
                        <tbody>
                          {issues.map((i) => <tr key={i.kind} className="border-b last:border-0"><td className="px-2 py-1">{ISSUE_LABEL[i.kind]}</td><td className="px-2 py-1 text-right tabular text-muted-foreground">{i.count}</td></tr>)}
                          {preview.issues.slice(0, 6).map((i, n) => <tr key={n} className="border-b bg-muted/30 last:border-0"><td className="px-2 py-1 font-mono text-[10.5px] text-muted-foreground">{i.at}</td><td className="truncate px-2 py-1 text-muted-foreground" title={i.sample}>{i.message}</td></tr>)}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
                <div>
                  <div className="mb-1 text-[12px] font-medium text-muted-foreground">First testimony</div>
                  <ol className="max-h-48 space-y-1.5 overflow-auto rounded-md border p-2 text-[11.5px] scrollbar-thin">
                    {preview.transcript.slice(0, 5).map((qa, i) => <li key={i} className="grid grid-cols-[48px_1fr] gap-2"><span className="font-mono text-muted-foreground">{formatPageLine(qa.page, qa.line)}</span><span><span className="text-muted-foreground">Q.</span> {qa.question}<br /><span className="text-muted-foreground">A.</span> {qa.answer}{qa.objection && <span className="ml-1 text-muted-foreground">· objection ({qa.objection.basis})</span>}</span></li>)}
                  </ol>
                </div>
              </>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={save} disabled={!canSave}>{saving ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />} {replaceId ? "Replace transcript" : "Import"}{preview ? ` (${preview.transcript.length} Q/A)` : ""}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
