"use client";
import * as React from "react";
import { AlertCircle, ChevronLeft, Loader2, PenLine, RotateCcw, Scale } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { PRACTICE_AREA_LABEL, type CreateReviewInput, type DocReview, type ReviewPlaybook } from "../../review-types";
import { docsApi, errorKind, errorMessage, UNCONFIGURED_MESSAGE, type ApiErrorKind } from "../api";
import { Notice, SurfaceState } from "../notice";
import { ReviewEditor, type ReviewDefinitionValue } from "./review-editor";
import { docsBase, groupPlaybooks, KIND_LABEL, reviewsUrl } from "./review-helpers";

type Load = { status: "loading" } | { status: "ready"; playbooks: ReviewPlaybook[] } | { status: "error"; message: string; kind: ApiErrorKind };
const CUSTOM = "__custom__";

/** Start a review: pick a practice-area playbook (or define custom columns and issues) and create it. */
export function PlaybookPicker({ setId, aiReady, fileCount, onCreated, onBack }: {
  setId: string; aiReady: boolean | null; fileCount: number; onCreated: (r: DocReview) => void; onBack?: () => void;
}) {
  const [load, setLoad] = React.useState<Load>({ status: "loading" });
  const [reload, setReload] = React.useState(0);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [name, setName] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    const ac = new AbortController();
    setLoad({ status: "loading" });
    docsApi<{ playbooks: ReviewPlaybook[] }>(`${docsBase}/playbooks`, { signal: ac.signal })
      .then((r) => { setLoad({ status: "ready", playbooks: r.playbooks ?? [] }); setSelected((s) => s ?? r.playbooks?.[0]?.id ?? CUSTOM); })
      .catch((e) => { if (!ac.signal.aborted) setLoad({ status: "error", message: errorMessage(e), kind: errorKind(e) }); });
    return () => ac.abort();
  }, [reload]);

  const playbooks = React.useMemo(() => (load.status === "ready" ? load.playbooks : []), [load]);
  const groups = React.useMemo(() => groupPlaybooks(playbooks), [playbooks]);
  const pb = playbooks.find((p) => p.id === selected) ?? null;
  React.useEffect(() => { setName(pb ? pb.name : ""); setError(null); }, [pb]);

  const create = async (input: CreateReviewInput) => {
    setBusy(true); setError(null);
    try {
      const r = await docsApi<{ review: DocReview }>(reviewsUrl(setId), { json: input });
      onCreated(r.review);
    } catch (e) {
      setError(errorKind(e) === "unconfigured" ? UNCONFIGURED_MESSAGE : errorMessage(e));
    } finally { setBusy(false); }
  };

  const startCustom = (v: ReviewDefinitionValue) => void create({ name: v.name, playbookId: null, columns: v.columns, issues: v.issues });

  if (load.status === "error") {
    return load.kind === "denied"
      ? <SurfaceState title="Not found or no access">{load.message}</SurfaceState>
      : <SurfaceState icon={AlertCircle} title="Playbooks could not be loaded" action={<Button size="xs" variant="ghost" onClick={() => setReload((n) => n + 1)}><RotateCcw className="size-3.5" /> Try again</Button>}>{load.message}</SurfaceState>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-2">
        {onBack && <Button size="xs" variant="ghost" onClick={onBack}><ChevronLeft className="size-3.5" /> Back to review</Button>}
        <div className="min-w-0">
          <h2 className="text-[13px] font-medium">Start a review</h2>
          <p className="text-[12px] text-muted-foreground">Each file is classified, rated against the issues, screened for privilege and given one value per column, each tied to a quote and page. Results are suggestions for a reviewer to code.</p>
        </div>
      </div>
      {(aiReady === false || fileCount === 0) && (
        <div className="shrink-0 px-3 pt-2">
          {aiReady === false ? <Notice tone="warning">{UNCONFIGURED_MESSAGE}</Notice> : <Notice>Add files to this set first; a review runs over the files in the set.</Notice>}
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <nav aria-label="Playbooks" className="w-[300px] shrink-0 overflow-y-auto border-r scrollbar-thin xl:w-[340px]">
          <button type="button" onClick={() => setSelected(CUSTOM)} aria-current={selected === CUSTOM ? "true" : undefined}
            className={cn("flex w-full items-start gap-2 border-b px-3 py-2 text-left hover:bg-accent/60", selected === CUSTOM && "bg-accent")}>
            <PenLine className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0">
              <span className="block text-[12.5px] font-medium">Custom review</span>
              <span className="block text-[11.5px] leading-snug text-muted-foreground">Define your own columns and issues.</span>
            </span>
          </button>
          {load.status === "loading" && <div className="space-y-2 p-3" aria-busy="true">{[0, 1, 2, 3].map((i) => <div key={i} className="h-12 animate-pulse rounded bg-muted" />)}</div>}
          {groups.map((g) => (
            <section key={g.area} aria-label={g.label}>
              <h3 className="sticky top-0 z-[1] border-b bg-background/95 px-3 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground backdrop-blur">{g.label}</h3>
              <ul>
                {g.items.map((p) => (
                  <li key={p.id}>
                    <button type="button" onClick={() => setSelected(p.id)} aria-current={selected === p.id ? "true" : undefined}
                      className={cn("block w-full border-b px-3 py-2 text-left hover:bg-accent/60", selected === p.id && "bg-accent")}>
                      <span className="block text-[12.5px] font-medium">{p.name}</span>
                      <span className="line-clamp-2 block text-[11.5px] leading-snug text-muted-foreground">{p.description}</span>
                      {p.statutes.length > 0 && <span className="mt-0.5 block truncate text-[11px] text-muted-foreground/80" title={p.statutes.join("; ")}>{p.statutes.join(" · ")}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {load.status === "ready" && playbooks.length === 0 && <p className="px-3 py-4 text-[12px] text-muted-foreground">No playbooks are available. Start a custom review.</p>}
        </nav>
        <div className="min-w-0 flex-1 overflow-y-auto scrollbar-thin">
          <div className="mx-auto w-full max-w-[760px] px-4 py-3">
            {selected === CUSTOM ? (
              <ReviewEditor initial={{ name: "", columns: [], issues: [] }} submitLabel="Start review" busy={busy} error={error} onSubmit={startCustom} />
            ) : pb ? (
              <PlaybookDetail pb={pb} name={name} setName={setName} busy={busy} error={error} disabled={fileCount === 0}
                onStart={() => void create({ name: name.trim() || pb.name, playbookId: pb.id })} />
            ) : load.status === "loading" ? (
              <div className="flex items-center gap-2 py-8 text-[13px] text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading playbooks…</div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function PlaybookDetail({ pb, name, setName, busy, error, disabled, onStart }: { pb: ReviewPlaybook; name: string; setName: (v: string) => void; busy: boolean; error: string | null; disabled: boolean; onStart: () => void }) {
  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <div className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground"><Scale className="size-3.5" /> {PRACTICE_AREA_LABEL[pb.area] ?? pb.area}</div>
        <h3 className="text-[15px] font-semibold tracking-[-0.01em]">{pb.name}</h3>
        <p className="text-[12.5px] leading-snug text-muted-foreground">{pb.description}</p>
        {pb.statutes.length > 0 && (
          <ul className="flex flex-wrap gap-1 pt-1">{pb.statutes.map((s) => <li key={s} className="rounded-[var(--radius-chip)] bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">{s}</li>)}</ul>
        )}
      </header>
      <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); onStart(); }}>
        <label className="min-w-[220px] flex-1 space-y-1">
          <span className="text-[12px] font-medium">Review name</span>
          <Input size="sm" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
        </label>
        <Button size="sm" type="submit" disabled={busy || disabled}>{busy && <Loader2 className="size-3.5 animate-spin" />}Start review</Button>
      </form>
      {error && <Notice tone="destructive">{error}</Notice>}
      <Section title="Issues" count={pb.issues.length}>
        <dl className="divide-y rounded-md border">
          {pb.issues.map((i) => (
            <div key={i.id} className="grid gap-x-3 px-3 py-1.5 sm:grid-cols-[180px_minmax(0,1fr)]">
              <dt className="text-[12.5px] font-medium">{i.label}</dt>
              <dd className="text-[12px] leading-snug text-muted-foreground">{i.description}</dd>
            </div>
          ))}
        </dl>
      </Section>
      <Section title="Columns" count={pb.columns.length}>
        <dl className="divide-y rounded-md border">
          {pb.columns.map((c) => (
            <div key={c.id} className="grid gap-x-3 px-3 py-1.5 sm:grid-cols-[180px_minmax(0,1fr)]">
              <dt className="text-[12.5px] font-medium">{c.label} <span className="font-normal text-muted-foreground">· {KIND_LABEL[c.kind] ?? c.kind}</span></dt>
              <dd className="text-[12px] leading-snug text-muted-foreground">{c.prompt}{c.choices?.length ? ` (${c.choices.join(", ")})` : ""}</dd>
            </div>
          ))}
        </dl>
      </Section>
      {pb.docTypes.length > 0 && (
        <Section title="Document types" count={pb.docTypes.length}>
          <p className="text-[12px] leading-snug text-muted-foreground">{pb.docTypes.join(" · ")}</p>
        </Section>
      )}
      {pb.questions.length > 0 && (
        <Section title="Report questions" count={pb.questions.length}>
          <ol className="list-decimal space-y-0.5 pl-5 text-[12px] leading-snug text-muted-foreground">{pb.questions.map((q) => <li key={q}>{q}</li>)}</ol>
        </Section>
      )}
      <p className="text-[11.5px] text-muted-foreground">Columns and issues can be changed after the review starts.</p>
    </div>
  );
}

function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <section className="space-y-1.5">
      <h4 className="text-[12px] font-medium">{title} <span className="tabular text-muted-foreground">{count}</span></h4>
      {children}
    </section>
  );
}
