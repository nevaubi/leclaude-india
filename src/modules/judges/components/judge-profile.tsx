"use client";
import * as React from "react";
import Link from "next/link";
import { ArrowLeft, Database, ExternalLink, FileText, Lock, RotateCcw, SearchX, TriangleAlert, UserRound } from "lucide-react";
import { PageTopbar } from "@/components/shell/page-topbar";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/misc";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { caseHref, formatCaseDate, formatTimestamp } from "@/modules/caselaw/shared";
import { CaseApiError, fetchCaseJson } from "@/modules/caselaw/components/fetch";
import { displayJudgeName } from "../names";
import { STATUS_LABEL, type JudgeJudgments, type JudgeProfile, type JudgeProfileResponse } from "../shared";
import { CourtEmblem } from "./court-emblem";
import { hostOf } from "./judges-directory";
import { JudgeAvatar } from "./judge-avatar";

/** /judges/<id>: one judge from an official roster, with the record's source and judgments matched by printed name. */
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
      <PageTopbar icon={<UserRound />} title="Judges" context={data ? displayJudgeName(data.judge.name) : undefined} />
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
        <div className="mx-auto w-full max-w-[1100px] px-4 pb-10 pt-3 sm:px-6">
          <Link href="/judges" className="inline-flex items-center gap-1 rounded text-[12px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
            <ArrowLeft className="size-3.5" aria-hidden />Judges
          </Link>
          {loading && !data ? <ProfileSkeleton /> : error ? <ProfileError error={error} id={id} onRetry={() => setNonce((n) => n + 1)} /> : data ? <ProfileBody data={data} /> : null}
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[120px_1fr] gap-2 py-[3px] text-[12.5px] leading-snug">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

const DASH = <span className="text-muted-foreground/60">—</span>;

function ProfileBody({ data }: { data: JudgeProfileResponse }) {
  const j = data.judge;
  const name = displayJudgeName(j.name);
  return (
    <article className="mt-3">
      <div className="flex flex-col gap-4 border-b pb-4 sm:flex-row sm:items-start">
        <JudgeAvatar name={j.name} photo={j.photo} fill rounded="md" className="aspect-[4/5] w-[132px] text-[28px]" />
        <div className="min-w-0 flex-1">
          <h1 className="text-[19px] font-semibold leading-snug tracking-[-0.01em]">{name}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-muted-foreground">
            {j.designation ? <span className="text-foreground/85">{j.designation}</span> : null}
            {j.designation ? <span aria-hidden>·</span> : null}
            <span className="inline-flex items-center gap-1.5"><CourtEmblem courtId={j.courtId} size={18} />{j.court ?? j.courtId}</span>
            <span aria-hidden>·</span>
            <span className={cn(j.status !== "sitting" && "text-warning-foreground dark:text-warning")}>{STATUS_LABEL[j.status]}</span>
          </div>
          <dl className="mt-3 max-w-[560px]">
            <Field label="As printed">{j.printedName}</Field>
            <Field label="Appointed">{formatCaseDate(j.dateOfAppointment) ?? DASH}</Field>
            {j.termExpires ? <Field label="Present term to">{formatCaseDate(j.termExpires)}</Field> : <Field label="Retires">{formatCaseDate(j.retirementDate) ?? DASH}</Field>}
          </dl>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {j.profileUrl ? (
              <Button asChild size="xs" variant="outline"><a href={j.profileUrl} target="_blank" rel="noopener noreferrer">Official profile · {hostOf(j.profileUrl)}<ExternalLink className="size-3 opacity-60" /></a></Button>
            ) : null}
            <Button asChild size="xs" variant="outline"><Link href={`/cases?judge=${encodeURIComponent(j.name)}`}><FileText className="size-3.5" />Search case law by this name</Link></Button>
          </div>
        </div>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <Judgments j={j} judgments={data.judgments} />
        <aside className="min-w-0">
          <section className="rounded-md border" aria-label="Source">
            <header className="flex h-8 items-center border-b px-3"><h2 className="text-[12.5px] font-medium">Source</h2></header>
            <ol className="space-y-2 px-3 py-2.5 text-[11.5px] leading-snug text-muted-foreground">
              <li>
                <span className="tabular">[1]</span> Roster: <a href={j.sourceUrl} target="_blank" rel="noopener noreferrer" className="break-words text-primary hover:underline">{j.sourceTitle ?? hostOf(j.sourceUrl)}</a>
                {j.checkedAt ? <> · read {formatTimestamp(j.checkedAt)}</> : null}
              </li>
              {j.photo ? (
                <li>
                  <span className="tabular">[2]</span> Photograph: {j.photoPublisher ?? "official court website"}
                  {j.photo.sourceUrl ? <> · <a href={j.photo.sourceUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">{hostOf(j.photo.sourceUrl)}</a></> : null}
                  . Reproduced with attribution for identification; shown after an automated check that it is a single-person portrait.
                </li>
              ) : <li>No photograph is shown: none was published, or the published image did not pass the portrait check.</li>}
              <li>Dates and designation are as printed on the roster; absent fields were not printed.</li>
            </ol>
          </section>
        </aside>
      </div>
    </article>
  );
}

function Judgments({ j, judgments }: { j: JudgeProfile; judgments: JudgeJudgments }) {
  return (
    <section className="min-w-0 rounded-md border" aria-label="Judgments in the case law index">
      <header className="flex h-8 items-center gap-2 border-b px-3">
        <h2 className="text-[12.5px] font-medium">Judgments in the case law index</h2>
        <span className="flex-1" />
        {judgments.available ? <span className="text-[11px] text-muted-foreground tabular">{judgments.capped ? `${judgments.count.toLocaleString("en-IN")}+` : judgments.count.toLocaleString("en-IN")}</span> : null}
      </header>
      <div className="px-3 py-2">
        <p className="mb-2 text-[11px] text-muted-foreground">Matched by name as printed in the record: the coram name, without honorifics, equals this judge&apos;s name exactly, in a {j.court ?? "court"} record. Records printing the name differently (initials, spelling) are not linked.</p>
        {!judgments.available ? (
          <EmptyState compact icon={Database} title="The case law index is not available on this deployment" />
        ) : judgments.note ? (
          <p className="text-[12px] text-muted-foreground">{judgments.note}</p>
        ) : !judgments.recent.length ? (
          <EmptyState compact icon={SearchX} title="No judgments in the index print this name" description="The index may not cover this court's years yet, or records print the name differently." />
        ) : (
          <ul className="divide-y">
            {judgments.recent.map((r) => (
              <li key={r.id} className="py-1.5">
                <Link href={caseHref(r.id)} className="block text-[12.5px] font-medium hover:underline">{r.title}</Link>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11.5px] text-muted-foreground">
                  <span className="tabular">{formatCaseDate(r.decisionDate) ?? "undated"}</span>
                  {r.neutralCitation ? <span className="tabular">{r.neutralCitation}</span> : r.caseNumber ? <span>{r.caseNumber}</span> : null}
                  <span className={cn("rounded-[var(--radius-chip)] border px-1 text-[10.5px]", r.textStatus === "full" ? "text-foreground/80" : "text-muted-foreground")}>{r.textStatus === "full" ? "Full text" : "Metadata only"}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function ProfileError({ error, id, onRetry }: { error: CaseApiError; id: string; onRetry: () => void }) {
  if (error.notFound || error.status === 400) {
    return <EmptyState className="mt-10" icon={SearchX} title="No judge with this id" description={<>The id <code className="break-all text-[11px]">{id}</code> is not in the directory. No other judge is shown in its place.</>} action={<Button asChild size="xs" variant="outline"><Link href="/judges">Open the directory</Link></Button>} />;
  }
  if (error.status === 503 && error.code === "judges_not_configured") {
    return <EmptyState className="mt-10" icon={Database} title="The judges directory is not configured" description="This deployment has no database (DATABASE_URL is not set)." />;
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
