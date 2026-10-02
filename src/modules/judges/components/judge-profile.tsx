"use client";
import * as React from "react";
import Link from "next/link";
import { ArrowLeft, Database, ExternalLink, FileText, Lock, RotateCcw, SearchX, TriangleAlert } from "lucide-react";
import { PhotoBackdrop } from "@/components/corpus/visual-image";
import { courtVisual, useVisuals } from "@/modules/media/use-visuals";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/misc";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { caseHref, formatCaseDate } from "@/modules/caselaw/shared";
import { CaseApiError, fetchCaseJson } from "@/modules/caselaw/components/fetch";
import { displayJudgeName } from "../names";
import { STATUS_LABEL, type JudgeJudgments, type JudgeProfile, type JudgeProfileResponse } from "../shared";
import { hostOf } from "./judges-directory";
import { JudgeAvatar } from "./judge-avatar";

/** /judges/<id>: one judge from an official roster, with the source and judgments matched by printed name. */
export function JudgeProfileView({ id }: { id: string }) {
  const [data, setData] = React.useState<JudgeProfileResponse | null>(null);
  const [error, setError] = React.useState<CaseApiError | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [nonce, setNonce] = React.useState(0);
  React.useEffect(() => {
    const ac = new AbortController();
    setLoading(true);
    setError(null);
    fetchCaseJson<JudgeProfileResponse>(`/api/judges/${encodeURIComponent(id)}`, ac.signal)
      .then(setData)
      .catch((e) => { if ((e as Error).name !== "AbortError") { setData(null); setError(e instanceof CaseApiError ? e : new CaseApiError(String(e), 0, null)); } })
      .finally(() => { if (!ac.signal.aborted) setLoading(false); });
    return () => ac.abort();
  }, [id, nonce]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
        <div className="mx-auto w-full max-w-[1180px] px-4 pb-12 pt-3 sm:px-6">
          <Link href="/judges" className="inline-flex items-center gap-1 rounded text-[12px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
            <ArrowLeft className="size-3.5" aria-hidden />Judges
          </Link>
          {loading && !data ? <ProfileSkeleton /> : error ? <ProfileError error={error} onRetry={() => setNonce((n) => n + 1)} /> : data ? <ProfileBody data={data} /> : null}
        </div>
      </div>
    </div>
  );
}

const DASH = <span className="text-muted-foreground/60">—</span>;

function ProfileBody({ data }: { data: JudgeProfileResponse }) {
  const j = data.judge;
  const name = displayJudgeName(j.name);
  const visuals = useVisuals();
  const photo = courtVisual(visuals, j.courtId);
  return (
    <article className="mt-2">
      <header className={cn("relative isolate flex flex-col gap-5 overflow-hidden rounded-xl border p-5 sm:flex-row sm:items-end sm:p-6", photo && "pb-8 sm:pb-8")}>
        <PhotoBackdrop visual={photo} />
        <JudgeAvatar name={j.name} photo={j.photo} fill rounded="md" className="aspect-[4/5] w-[136px] text-[28px] shadow-sm ring-4 ring-background" />
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">{j.court ?? "Court not recorded"}</div>
          <h1 className="mt-1 font-serif text-[28px] leading-tight tracking-[-0.015em]">{name}</h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-muted-foreground">
            {j.designation ? <span className="text-foreground/85">{j.designation}</span> : null}
            {j.designation ? <span aria-hidden>·</span> : null}
            <span className={cn(j.status !== "sitting" && "text-warning-foreground dark:text-warning")}>{STATUS_LABEL[j.status]}</span>
          </div>
          <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-[12.5px]">
            <div><dt className="text-[11px] text-muted-foreground">As printed</dt><dd>{j.printedName}</dd></div>
            <div><dt className="text-[11px] text-muted-foreground">Appointed</dt><dd className="tabular">{formatCaseDate(j.dateOfAppointment) ?? DASH}</dd></div>
            {j.termExpires ? <div><dt className="text-[11px] text-muted-foreground">Present term to</dt><dd className="tabular">{formatCaseDate(j.termExpires)}</dd></div> : <div><dt className="text-[11px] text-muted-foreground">Retires</dt><dd className="tabular">{formatCaseDate(j.retirementDate) ?? DASH}</dd></div>}
          </dl>
          <div className="mt-3.5 flex flex-wrap gap-1.5">
            {j.profileUrl ? (
              <Button asChild size="xs" variant="outline" className="bg-background/80"><a href={j.profileUrl} target="_blank" rel="noopener noreferrer">Official profile · {hostOf(j.profileUrl)}<ExternalLink className="size-3 opacity-60" /></a></Button>
            ) : null}
            <Button asChild size="xs" variant="outline" className="bg-background/80"><Link href={`/cases?judge=${encodeURIComponent(j.name)}`}><FileText className="size-3.5" />Search case law by this name</Link></Button>
          </div>
        </div>
      </header>

      <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        <Judgments j={j} judgments={data.judgments} />
        <aside className="min-w-0">
          <section className="rounded-lg border" aria-label="Source">
            <header className="flex h-8 items-center border-b px-3"><h2 className="text-[12.5px] font-medium">Source</h2></header>
            <ul className="space-y-2 px-3 py-2.5 text-[11.5px] leading-snug text-muted-foreground">
              <li>
                Official roster: <a href={j.sourceUrl} target="_blank" rel="noopener noreferrer" className="break-words text-primary hover:underline">{j.sourceTitle ?? hostOf(j.sourceUrl)}</a>
              </li>
              {j.photo ? (
                <li>
                  Photograph: {j.photoPublisher ?? "official court website"}
                  {j.photo.sourceUrl ? <> (<a href={j.photo.sourceUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">{hostOf(j.photo.sourceUrl)}</a>)</> : null}
                  , reproduced for identification.
                </li>
              ) : null}
              <li>Dates and designation are as published on the roster.</li>
            </ul>
          </section>
        </aside>
      </div>
    </article>
  );
}

function Judgments({ j, judgments }: { j: JudgeProfile; judgments: JudgeJudgments }) {
  return (
    <section className="min-w-0 rounded-lg border" aria-label="Judgments">
      <header className="flex h-8 items-center gap-2 border-b px-3">
        <h2 className="text-[12.5px] font-medium">Judgments</h2>
        <span className="flex-1" />
        {judgments.available ? <span className="text-[11px] text-muted-foreground tabular">{judgments.capped ? `${judgments.count.toLocaleString("en-IN")}+` : judgments.count.toLocaleString("en-IN")}</span> : null}
      </header>
      <div className="px-3 py-2">
        <p className="mb-2 text-[11px] text-muted-foreground">{j.court ?? "Court"} judgments whose coram prints this judge&apos;s name exactly. Judgments that print the name differently (initials, spelling) are not listed.</p>
        {!judgments.available ? (
          <EmptyState compact icon={Database} title="Case law is not available" />
        ) : judgments.note ? (
          <p className="text-[12px] text-muted-foreground">{judgments.note}</p>
        ) : !judgments.recent.length ? (
          <EmptyState compact icon={SearchX} title="No judgments found under this name" description="Case law may not cover this court's years yet, or judgments print the name differently." />
        ) : (
          <ul className="divide-y">
            {judgments.recent.map((r) => (
              <li key={r.id} className="py-1.5">
                <Link href={caseHref(r.id)} className="block text-[12.5px] font-medium hover:underline">{r.title}</Link>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11.5px] text-muted-foreground">
                  <span className="tabular">{formatCaseDate(r.decisionDate) ?? "undated"}</span>
                  {r.neutralCitation ? <span className="tabular">{r.neutralCitation}</span> : r.caseNumber ? <span>{r.caseNumber}</span> : null}
                  <span className={cn("rounded-[var(--radius-chip)] border px-1 text-[10.5px]", r.textStatus === "full" ? "text-foreground/80" : "text-muted-foreground")}>{r.textStatus === "full" ? "Full text" : "PDF only"}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function ProfileError({ error, onRetry }: { error: CaseApiError; onRetry: () => void }) {
  if (error.notFound || error.status === 400) {
    return <EmptyState className="mt-10" icon={SearchX} title="Judge not found" description="This link does not match a judge in the directory." action={<Button asChild size="xs" variant="outline"><Link href="/judges">Open the directory</Link></Button>} />;
  }
  if (error.status === 503 && error.code === "judges_not_configured") {
    return <EmptyState className="mt-10" icon={Database} title="The judges directory is not available" description="It has not been set up for this workspace yet." />;
  }
  if (error.forbidden || error.unauthenticated) {
    return <EmptyState className="mt-10" icon={Lock} title={error.unauthenticated ? "Sign in to view this judge" : "You do not have access to the judges directory"} />;
  }
  return <EmptyState className="mt-10" icon={TriangleAlert} title="The profile could not be loaded" description={error.message} action={<Button size="xs" variant="outline" onClick={onRetry}><RotateCcw className="size-3.5" />Retry</Button>} />;
}

function ProfileSkeleton() {
  return (
    <div className="mt-3 space-y-3" aria-busy>
      <div className="flex gap-4"><Skeleton className="aspect-[4/5] w-[132px]" /><div className="flex-1 space-y-2"><Skeleton className="h-6 w-1/2" /><Skeleton className="h-4 w-1/3" /><Skeleton className="h-4 w-1/4" /></div></div>
      <Skeleton className="h-64 w-full" />
    </div>
  );
}
