"use client";
import * as React from "react";
import { AlertCircle, CalendarDays, FileDown, FileText, Loader2, Pencil, Plus, RotateCcw, ShieldAlert, Sparkles, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { SegmentedControl } from "@/components/ui/form";
import { checkSynopsis, courtDate, datesMarkdown, rowsHash, rowVerification, synopsisCheckSummary, synopsisForExport, type DateRow, type DatesFormat } from "../../drafting";
import { downloadText, errorKind, errorMessage, isAbort, UNCONFIGURED_MESSAGE, type ApiErrorKind } from "../api";
import { safeFileName } from "../format";
import { Notice, SurfaceState } from "../notice";
import { datesApi, saveToWord, type DatesView } from "./drafting-api";
import type { DraftingProps } from "./drafting-tab";

type Load = { status: "loading" } | { status: "ready"; view: DatesView } | { status: "error"; message: string; kind: ApiErrorKind };

const VERIFY_STYLE: Record<ReturnType<typeof rowVerification>, string> = {
  "quote found": "text-muted-foreground",
  edited: "text-foreground",
  unverified: "text-warning-foreground dark:text-warning",
  manual: "text-foreground",
};

/** List of dates & synopsis: the set's timeline as a court-format table with sources; edits and hand-added rows marked. */
export function DatesTool({ setId, setName, matterId, aiReady, onView, onOpenTab, active }: DraftingProps & { active: boolean }) {
  const [load, setLoad] = React.useState<Load>({ status: "loading" });
  const [reload, setReload] = React.useState(0);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [editing, setEditing] = React.useState<{ id: string; date: string; particulars: string } | null>(null);
  const [adding, setAdding] = React.useState<{ date: string; particulars: string } | null>(null);
  const [synText, setSynText] = React.useState("");
  const draftCtrl = React.useRef<AbortController | null>(null);

  React.useEffect(() => {
    if (!active && load.status === "ready") return;
    const ac = new AbortController();
    datesApi.get(setId, ac.signal)
      .then((view) => { setLoad({ status: "ready", view }); setSynText(view.state.synopsis?.text ?? ""); })
      .catch((e) => { if (!ac.signal.aborted) setLoad({ status: "error", message: errorMessage(e), kind: errorKind(e) }); });
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setId, reload, active]);
  React.useEffect(() => () => draftCtrl.current?.abort(), []);

  const view = load.status === "ready" ? load.view : null;
  const rows = React.useMemo(() => view?.rows ?? [], [view]);
  const selected = React.useMemo(() => rows.filter((r) => r.selected), [rows]);
  const synopsis = view?.state.synopsis ?? null;
  const synopsisStale = !!synopsis && rowsHash(selected) !== synopsis.rowsHash;

  const save = async (patch: Record<string, unknown>, label = "save") => {
    if (!view) return null;
    setBusy(label);
    try {
      const next = await datesApi.save(setId, { version: view.state.version, ...patch });
      setLoad({ status: "ready", view: next });
      return next;
    } catch (e) {
      if (errorKind(e) === "conflict") { toast.error("Someone else changed this list. Reloaded the latest version."); setReload((n) => n + 1); }
      else toast.error(errorMessage(e));
      return null;
    } finally { setBusy(null); }
  };

  const toggle = (r: DateRow, on: boolean) => r.manual
    ? save({ manual: view!.state.manual.map((m) => (m.id === r.id ? { ...m, selected: on } : m)) })
    : save({ overrides: { [r.id]: { selected: on } } });
  const remove = (r: DateRow) => r.manual ? save({ manual: view!.state.manual.filter((m) => m.id !== r.id) }) : save({ overrides: { [r.id]: { removed: true } } });
  const removedCount = view ? Object.values(view.state.overrides).filter((o) => o.removed).length : 0;
  const restoreAll = () => save({ overrides: Object.fromEntries(Object.entries(view!.state.overrides).filter(([, o]) => o.removed).map(([id]) => [id, { removed: false }])) });

  const commitEdit = async () => {
    if (!editing) return;
    const r = rows.find((x) => x.id === editing.id);
    if (!r) { setEditing(null); return; }
    const ok = r.manual
      ? await save({ manual: view!.state.manual.map((m) => (m.id === r.id ? { ...m, date: editing.date, particulars: editing.particulars } : m)) })
      : await save({ overrides: { [r.id]: { particulars: editing.particulars, ...(editing.date !== courtDate(r.date, r.datePrecision) ? { date: editing.date } : {}) } } });
    if (ok) setEditing(null);
  };
  const commitAdd = async () => {
    if (!adding?.date.trim() || !adding.particulars.trim()) return;
    const ok = await save({ manual: [...view!.state.manual, { date: adding.date, particulars: adding.particulars, selected: true }] });
    if (ok) setAdding(null);
  };

  const draft = async () => {
    if (!view) return;
    draftCtrl.current?.abort();
    const ac = new AbortController();
    draftCtrl.current = ac;
    setBusy("synopsis");
    try {
      const next = await datesApi.synopsis(setId, { rowIds: selected.map((r) => r.id), version: view.state.version }, ac.signal);
      setLoad({ status: "ready", view: next });
      setSynText(next.state.synopsis?.text ?? "");
    } catch (e) {
      if (isAbort(e)) return;
      toast.error(errorKind(e) === "unconfigured" ? UNCONFIGURED_MESSAGE : errorMessage(e));
    } finally { setBusy(null); draftCtrl.current = null; }
  };

  const exportRows = selected;
  // The rows the synopsis cites, in [Rn] order (null where a row has since been removed).
  const synRows = React.useMemo(() => {
    if (!synopsis) return [];
    const byId = new Map(rows.map((r) => [r.id, r]));
    return synopsis.rowIds.map((id) => byId.get(id) ?? null);
  }, [synopsis, rows]);
  // Checks run on the text as it is now in the editor (not only on the drafted text), so hand edits are checked too.
  const liveChecks = React.useMemo(() => (synopsis && synText.trim() ? checkSynopsis(synText, synRows) : null), [synopsis, synText, synRows]);
  const editedNow = !!synopsis && (synopsis.edited || synText !== synopsis.text);
  const synopsisExport = () => {
    if (!synopsis || !synText.trim()) return null;
    return synopsisForExport(synText, synRows as DateRow[]);
  };
  const synopsisNote = () => {
    if (!synopsis || !synText.trim()) return null;
    const origin = editedNow ? "Synopsis drafted with AI from the listed rows and edited by hand." : "Synopsis drafted with AI from the listed rows only.";
    const found = liveChecks ? synopsisCheckSummary(liveChecks) : "";
    return `${origin} ${found ? `Automated checks on this text found ${found}.` : "Automated checks found no unlisted dates or amounts, and every sentence cites a row."} Review before filing.`;
  };
  const markdown = () => datesMarkdown(exportRows, { format: view?.state.format ?? "sc", title: setName, synopsis: synopsisExport(), synopsisNote: synopsisNote() });
  const aiUse = () => ({ assisted: true, detail: `List of dates built from AI-extracted timeline events (${exportRows.length} rows, ${exportRows.filter((r) => rowVerification(r) !== "quote found").length} not backed by a found quote)${synopsis && synText.trim() ? `; synopsis drafted by AI${editedNow ? " and edited by hand" : ""}` : ""}.` });

  if (load.status === "loading") return <div className="space-y-2 p-3" aria-busy="true"><div className="h-8 w-64 animate-pulse rounded bg-muted" /><div className="h-48 animate-pulse rounded-md bg-muted/60" /></div>;
  if (load.status === "error") {
    return load.kind === "denied" || load.kind === "auth"
      ? <SurfaceState icon={ShieldAlert} title="Not found or no access">{load.message}</SurfaceState>
      : <SurfaceState icon={AlertCircle} title="The list of dates could not be loaded" action={<Button size="xs" variant="ghost" onClick={() => setReload((n) => n + 1)}><RotateCcw className="size-3.5" /> Try again</Button>}>{load.message}</SurfaceState>;
  }
  const v = load.view;
  const partial = v.total > 0 && v.extracted < v.total;
  const unverified = exportRows.filter((r) => rowVerification(r) !== "quote found").length;

  return (
    <div className="h-full overflow-y-auto scrollbar-thin">
      <div className="mx-auto w-full max-w-[1100px] space-y-3 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-[13px] font-semibold">List of dates &amp; synopsis</h2>
          <SegmentedControl size="xs" ariaLabel="Court format" value={v.state.format} onChange={(f: DatesFormat) => void save({ format: f })} options={[{ value: "sc", label: "Supreme Court" }, { value: "hc", label: "High Court" }]} />
          {busy && busy !== "synopsis" && <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-label="Saving" />}
          <div className="ms-auto flex items-center gap-1">
            <Button size="xs" variant="outline" disabled={!exportRows.length} onClick={() => downloadText(`${safeFileName(setName)} - list of dates.md`, markdown(), "text/markdown;charset=utf-8")}><FileDown className="size-3.5" /> Markdown</Button>
            <Button size="xs" variant="outline" disabled={!exportRows.length || busy === "word"} onClick={async () => { setBusy("word"); await saveToWord({ title: `${v.state.format === "sc" ? "Synopsis and list of dates" : "List of dates and synopsis"} — ${setName}`, markdown: markdown(), matterId, source: "documents.dates", tags: ["list of dates", "synopsis"], ai: aiUse() }); setBusy(null); }}><FileText className="size-3.5" /> Word</Button>
          </div>
        </div>
        {partial && <Notice action={<Button size="xs" variant="ghost" onClick={() => onOpenTab("timeline")}>Open Timeline</Button>}>Built from the timeline of {v.extracted.toLocaleString("en-IN")} of {v.total.toLocaleString("en-IN")} files. Extract the rest in the Timeline tab to include their dates.</Notice>}
        {rows.length === 0 ? (
          <SurfaceState icon={CalendarDays} title="No dated events yet" action={<div className="flex gap-1.5"><Button size="xs" variant="outline" onClick={() => onOpenTab("timeline")}>Open Timeline</Button><Button size="xs" variant="ghost" onClick={() => setAdding({ date: "", particulars: "" })}><Plus className="size-3.5" /> Add a row by hand</Button></div>}>
            Extract facts &amp; events in the Timeline tab; each dated event becomes a row with its file, page and quote.
          </SurfaceState>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full min-w-[720px] border-collapse text-[12.5px]">
              <thead className="bg-surface-quiet text-left text-[11.5px] text-muted-foreground">
                <tr>
                  <th className="w-8 px-2 py-1.5 font-medium"><span className="sr-only">Include</span></th>
                  <th className="w-10 px-1 py-1.5 font-medium">Row</th>
                  <th className="w-[110px] px-2 py-1.5 font-medium">Date</th>
                  <th className="px-2 py-1.5 font-medium">Particulars</th>
                  <th className="w-[220px] px-2 py-1.5 font-medium">Source</th>
                  <th className="w-16 px-2 py-1.5"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((r) => {
                  const ver = rowVerification(r);
                  const rn = r.selected ? selected.indexOf(r) + 1 : null;
                  const isEditing = editing?.id === r.id;
                  return (
                    <tr key={r.id} className={cn("align-top", !r.selected && "text-muted-foreground")}>
                      <td className="px-2 py-2"><Checkbox size="sm" checked={r.selected} onCheckedChange={(c) => void toggle(r, c === true)} aria-label={`Include ${courtDate(r.date, r.datePrecision)}`} /></td>
                      <td className="px-1 py-2 tabular text-[11.5px] text-muted-foreground">{rn ? `R${rn}` : "—"}</td>
                      <td className="px-2 py-2 tabular">
                        {isEditing ? <Input size="xs" value={editing.date} onChange={(e) => setEditing({ ...editing, date: e.target.value })} aria-label="Date" placeholder="DD.MM.YYYY" /> : courtDate(r.date, r.datePrecision)}
                      </td>
                      <td className="px-2 py-2">
                        {isEditing ? (
                          <div className="space-y-1">
                            <Textarea rows={2} value={editing.particulars} onChange={(e) => setEditing({ ...editing, particulars: e.target.value })} className="text-[12.5px]" aria-label="Particulars" />
                            <div className="flex gap-1"><Button size="xs" onClick={() => void commitEdit()} disabled={!!busy}>Save</Button><Button size="xs" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button></div>
                          </div>
                        ) : (
                          <>
                            <div className="leading-snug">{r.particulars}</div>
                            {r.quote && <div className="mt-0.5 line-clamp-2 text-[11.5px] italic text-muted-foreground">“{r.quote}”</div>}
                          </>
                        )}
                      </td>
                      <td className="px-2 py-2">
                        {r.manual ? <span className="text-[11.5px]">Added by hand · no source</span> : (
                          <button type="button" className="max-w-full truncate text-left text-[12px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" onClick={() => r.fileId && onView({ fileId: r.fileId, page: r.page, highlight: r.quote, name: r.fileName ?? undefined })} title={`Open ${r.fileName}${r.page != null ? ` at page ${r.page}` : ""}`}>
                            {r.fileName}{r.page != null ? ` · p. ${r.page}` : ""}
                          </button>
                        )}
                        <div className={cn("text-[11px] font-medium", VERIFY_STYLE[ver])} title={ver === "unverified" ? "The quote for this event was not found in the stored text. Check the page." : undefined}>{ver === "quote found" ? "Quote found" : ver === "unverified" ? "Unverified" : ver === "edited" ? "Edited" : "Manual"}</div>
                      </td>
                      <td className="px-2 py-2 text-right">
                        {!isEditing && (
                          <div className="flex justify-end gap-0.5">
                            <Button size="icon-xs" variant="ghost" aria-label="Edit row" onClick={() => setEditing({ id: r.id, date: courtDate(r.date, r.datePrecision), particulars: r.particulars })}><Pencil className="size-3.5" /></Button>
                            <Button size="icon-xs" variant="ghost" aria-label="Remove row" onClick={() => void remove(r)}><Trash2 className="size-3.5" /></Button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground">
          {adding ? (
            <div className="flex w-full flex-wrap items-start gap-1.5 rounded-md border p-2">
              <Input size="xs" className="w-[130px]" placeholder="DD.MM.YYYY" value={adding.date} onChange={(e) => setAdding({ ...adding, date: e.target.value })} aria-label="New row date" />
              <Input size="xs" className="min-w-[240px] flex-1" placeholder="Particulars" value={adding.particulars} onChange={(e) => setAdding({ ...adding, particulars: e.target.value })} aria-label="New row particulars" onKeyDown={(e) => { if (e.key === "Enter") void commitAdd(); }} />
              <Button size="xs" onClick={() => void commitAdd()} disabled={!adding.date.trim() || !adding.particulars.trim() || !!busy}>Add row</Button>
              <Button size="icon-xs" variant="ghost" aria-label="Cancel" onClick={() => setAdding(null)}><X className="size-3.5" /></Button>
              <p className="basis-full text-[11px]">A hand-added row has no source document and is marked “Added by hand” in the export.</p>
            </div>
          ) : rows.length > 0 && <Button size="xs" variant="ghost" onClick={() => setAdding({ date: "", particulars: "" })}><Plus className="size-3.5" /> Add a row by hand</Button>}
          {removedCount > 0 && <Button size="xs" variant="ghost" onClick={() => void restoreAll()}><RotateCcw className="size-3.5" /> Restore {removedCount} removed row{removedCount === 1 ? "" : "s"}</Button>}
          {exportRows.length > 0 && <span className="ms-auto tabular">{exportRows.length} of {rows.length} rows in the list{unverified ? ` · ${unverified} not backed by a found quote` : ""}</span>}
        </div>

        <section className="space-y-2 rounded-md border p-3" aria-label="Synopsis">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[12.5px] font-semibold">Synopsis</h3>
            <span className="text-[11.5px] text-muted-foreground">Drafted only from the selected rows; each sentence cites its rows as [R1], [R2]…</span>
            <div className="ms-auto flex gap-1">
              {busy === "synopsis" && <Button size="xs" variant="ghost" onClick={() => draftCtrl.current?.abort()}><X className="size-3.5" /> Cancel</Button>}
              <Button size="xs" variant={synopsis ? "outline" : "default"} disabled={!selected.length || aiReady === false || busy === "synopsis"} onClick={() => void draft()}>
                {busy === "synopsis" ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />} {synopsis ? "Re-draft" : "Draft synopsis"} from {selected.length} row{selected.length === 1 ? "" : "s"}
              </Button>
            </div>
          </div>
          {aiReady === false && <Notice tone="warning">{UNCONFIGURED_MESSAGE}</Notice>}
          {synopsis ? (
            <>
              {liveChecks && (liveChecks.unresolved.length > 0 || liveChecks.unknownDates.length > 0 || liveChecks.unknownAmounts.length > 0 || liveChecks.uncited > 0) && (
                <Notice tone="warning">
                  {liveChecks.unresolved.length > 0 && <div>Cites rows that are not in the list it was drafted from: {liveChecks.unresolved.map((n) => `R${n}`).join(", ")} (kept visible as unresolved in the export).</div>}
                  {liveChecks.unknownDates.length > 0 && <div>Mentions dates not in those rows: {liveChecks.unknownDates.join(", ")}. Remove or verify them.</div>}
                  {liveChecks.unknownAmounts.length > 0 && <div>Mentions amounts not in those rows: {liveChecks.unknownAmounts.join(", ")}. Remove or verify them.</div>}
                  {liveChecks.uncited > 0 && <div>{liveChecks.uncited} sentence{liveChecks.uncited === 1 ? " has" : "s have"} no row citation.</div>}
                </Notice>
              )}
              {synopsisStale && <Notice tone="warning">The selected rows changed after this synopsis was drafted. Its row numbers refer to the rows at drafting time; re-draft to match the current list.</Notice>}
              <Textarea rows={7} value={synText} onChange={(e) => setSynText(e.target.value)} onBlur={() => { if (synText !== synopsis.text) void save({ synopsisText: synText }); }} className="font-serif text-[13px] leading-relaxed" aria-label="Synopsis text" />
              <p className="text-[11px] text-muted-foreground">{editedNow ? "Edited by hand; the checks above run on the current text." : `Drafted ${new Date(synopsis.generatedAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })} from ${synopsis.rowIds.length} rows.`} In the export, [Rn] is replaced by the row’s date, and the note under the synopsis states what the checks found.</p>
            </>
          ) : (
            <p className="text-[12px] text-muted-foreground">No synopsis yet. Select the rows that tell the story and draft one; nothing outside those rows is used.</p>
          )}
        </section>
      </div>
    </div>
  );
}
