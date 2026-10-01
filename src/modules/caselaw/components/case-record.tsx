"use client";
import * as React from "react";
import Link from "next/link";
import { ArrowLeft, Check, Copy, Database, ExternalLink, FileText, Lock, RotateCcw, Search, SearchX, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/misc";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { languageInfo } from "@/lib/india/languages";
import { caseApiHref, caseHref, formatCaseDate, formatTimestamp, urlHost, type CaseRecord, type CaseRecordResponse, type SameCaseRecord } from "../shared";
import { benchLabel, courtLabel } from "./case-directory";
import { CaseApiError, fetchCaseJson } from "./fetch";
import { JudgmentTextSection } from "./judgment-text";
import { CoramJudges } from "@/modules/judges/components/coram-judges";
import { CourtEmblem } from "@/modules/judges/components/court-emblem";

const DASH = <span className="text-muted-foreground/60">—</span>;
const show = (v: React.ReactNode) => (v === null || v === undefined || v === "" ? DASH : v);

/** /cases/<id>: one index record with every published field, the official PDF and its provenance. */
export function CaseRecordView({ id }: { id: string }) {
  const [data, setData] = React.useState<CaseRecordResponse | null>(null);
  const [error, setError] = React.useState<CaseApiError | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [nonce, setNonce] = React.useState(0);
  React.useEffect(() => {
    const ac = new AbortController();
    setLoading(true);
    setError(null);
    fetchCaseJson<CaseRecordResponse>(caseApiHref(id), ac.signal)
      .then((d) => setData(d))
      .catch((e) => { if ((e as Error).name !== "AbortError") { setData(null); setError(e instanceof CaseApiError ? e : new CaseApiError(String(e), 0, null)); } })
      .finally(() => { if (!ac.signal.aborted) setLoading(false); });
    return () => ac.abort();
  }, [id, nonce]);

  return (
    <div className="h-full overflow-auto scrollbar-thin">
      <div className="mx-auto w-full max-w-[1180px] px-4 pb-10 pt-3 sm:px-6">
        <BackLink />
        {loading && !data ? <RecordSkeleton /> : error ? <RecordError error={error} id={id} onRetry={() => setNonce((n) => n + 1)} /> : data ? <RecordBody data={data} /> : null}
      </div>
    </div>
  );
}

function BackLink() {
  return (
    <Link href="/cases" className="inline-flex items-center gap-1 rounded text-[12px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50" onClick={(e) => {
      // Return to the filtered directory when the user came from it.
      if (typeof window !== "undefined" && window.history.length > 1 && document.referrer && new URL(document.referrer).pathname === "/cases") { e.preventDefault(); window.history.back(); }
    }}>
      <ArrowLeft className="size-3.5" aria-hidden />Case law
    </Link>
  );
}

function RecordSkeleton() {
  return (
    <div className="mt-3 space-y-3" aria-busy>
      <Skeleton className="h-6 w-2/3" />
      <Skeleton className="h-4 w-1/3" />
      <div className="grid gap-4 lg:grid-cols-[1fr_360px]"><Skeleton className="h-72" /><Skeleton className="h-72" /></div>
    </div>
  );
}

function RecordError({ error, id, onRetry }: { error: CaseApiError; id: string; onRetry: () => void }) {
  if (error.notFound || error.status === 400) {
    return <EmptyState className="mt-10" icon={SearchX} title="No record with this id in the case law index" description={<>The id <code className="break-all text-[11px]">{id}</code> does not match any record. It may have been mistyped; no other record is shown in its place.</>} action={<Button asChild size="xs" variant="outline"><Link href="/cases">Open the directory</Link></Button>} />;
  }
  if (error.notConfigured) {
    return <EmptyState className="mt-10" icon={Database} title="The case law index is not configured" description="This deployment has no judgment corpus database (DATABASE_URL is not set)." />;
  }
  if (error.forbidden || error.unauthenticated) {
    return <EmptyState className="mt-10" icon={Lock} title={error.unauthenticated ? "Sign in to view this record" : "You do not have access to the case law index"} />;
  }
  return <EmptyState className="mt-10" icon={TriangleAlert} title="The record could not be loaded" description={error.message} action={<Button size="xs" variant="outline" onClick={onRetry}><RotateCcw className="size-3.5" />Retry</Button>} />;
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [done, setDone] = React.useState(false);
  return (
    <button
      type="button"
      className="inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      aria-label={`Copy ${label}`}
      title={`Copy ${label}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          toast.success(`${label} copied`);
          setTimeout(() => setDone(false), 1500);
        } catch {
          toast.error("Could not copy to the clipboard");
        }
      }}
    >
      {done ? <Check className="size-3" /> : <Copy className="size-3" />}
    </button>
  );
}

function Citation({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-[var(--radius-chip)] border px-1.5 py-0.5 text-[12px]">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate font-medium tabular">{value}</span>
      <CopyButton value={value} label={label} />
    </span>
  );
}

function Section({ title, children, className, aside }: { title: string; children: React.ReactNode; className?: string; aside?: React.ReactNode }) {
  return (
    <section className={cn("rounded-md border", className)} aria-label={title}>
      <header className="flex h-8 items-center gap-2 border-b px-3">
        <h2 className="text-[12.5px] font-medium">{title}</h2>
        <span className="flex-1" />
        {aside}
      </header>
      <div className="px-3 py-2.5">{children}</div>
    </section>
  );
}

/** Side panels use a narrower label column. */
const NarrowFields = React.createContext(false);

function Field({ label, children, mono }: { label: string; children: React.ReactNode; mono?: boolean }) {
  const narrow = React.useContext(NarrowFields);
  return (
    <div className={cn("grid gap-2 py-[3px] text-[12.5px] leading-snug", narrow ? "grid-cols-[104px_1fr]" : "grid-cols-[minmax(110px,132px)_1fr]")}>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn("min-w-0 break-words", mono && "font-mono text-[11.5px]")}>{children}</dd>
    </div>
  );
}

function languageName(code: string | null): string | null {
  if (!code) return null;
  const l = languageInfo(code);
  return l ? `${l.name} (${code})` : code;
}

function researchQuery(r: CaseRecord): string {
  return r.neutral_citation ?? r.reporter_citation ?? r.title;
}

function RecordBody({ data }: { data: CaseRecordResponse }) {
  const r = data.record;
  const date = formatCaseDate(r.decision_date);
  const pdfHost = urlHost(r.pdf_url);
  const bench = r.bench ?? benchLabel(r);
  return (
    <article className="mt-2">
      {/* Header */}
      <div className="border-b pb-3">
        <h1 className="max-w-[900px] text-[18px] font-semibold leading-snug tracking-[-0.01em]">{r.title}</h1>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 text-[12.5px] text-muted-foreground">
          <span className={cn("inline-flex items-center gap-1.5 text-foreground/85", !r.court && "text-warning-foreground dark:text-warning")}>
            {r.court_id ? <CourtEmblem courtId={r.court_id} size={18} /> : null}
            {r.court ?? courtLabel(r)}
          </span>
          {bench ? <><span aria-hidden>·</span><span>{bench}</span></> : null}
          <span aria-hidden>·</span>
          <span className="tabular">{date ? `Decided ${date}` : "Decision date not in the source metadata"}</span>
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <Citation label="Neutral" value={r.neutral_citation} />
          <Citation label="Reporter" value={r.reporter_citation} />
          <Citation label="Case no." value={r.case_number} />
          <Citation label="CNR" value={r.cnr} />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {r.pdf_url ? (
            <Button asChild size="xs" variant="outline" className="max-w-full">
              <a href={r.pdf_url} target="_blank" rel="noopener noreferrer" title={r.pdf_url}>
                <FileText className="size-3.5" />Official PDF<span className="min-w-0 truncate text-muted-foreground">{pdfHost ? `· ${pdfHost}` : ""}</span><ExternalLink className="size-3 opacity-60" />
              </a>
            </Button>
          ) : <span className="text-[12px] text-muted-foreground">No PDF link in the source metadata</span>}
          <Button asChild size="xs" variant="outline">
            <Link href={`/search?q=${encodeURIComponent(researchQuery(r))}`}><Search className="size-3.5" />Research this</Link>
          </Button>
          <span className="text-[11.5px] text-muted-foreground">{r.text_status === "full" ? "Full text below (from the official PDF; the PDF is the text of record)" : "Metadata only — full text not ingested"}</span>
        </div>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-w-0 space-y-4">
          {r.text_status === "full" ? <JudgmentTextSection id={r.id} citation={r.neutral_citation} /> : null}

          <Section title="Record">
            <dl>
              <Field label="Court">{r.court ? r.court : r.court_code ? <span className="text-warning-foreground dark:text-warning">Not in the court registry (dataset code {r.court_code})</span> : DASH}</Field>
              <Field label="Registry court id">{show(r.court_id)}</Field>
              <Field label="Dataset court code">{show(r.court_code)}</Field>
              <Field label="Bench">{show(r.bench)}</Field>
              <Field label="Dataset bench code">{show(r.bench_code)}</Field>
              <Field label="Bench strength">{r.bench_strength ? `${r.bench_strength} judge${r.bench_strength === 1 ? "" : "s"}` : DASH}</Field>
              <Field label="Case number">{show(r.case_number)}</Field>
              <Field label="Case type">{show(r.case_type)}</Field>
              <Field label="CNR">{show(r.cnr)}</Field>
              <Field label="Neutral citation">{show(r.neutral_citation)}</Field>
              <Field label="Reporter citation">{show(r.reporter_citation)}</Field>
              <Field label="Decision date">{show(date)}</Field>
              <Field label="Registration date">{show(formatCaseDate(r.registration_date))}</Field>
              <Field label="Decision year">{show(r.year)}</Field>
              <Field label="Disposal">{show(r.disposal)}</Field>
              <Field label="Language">{show(languageName(r.language))}</Field>
            </dl>
          </Section>

          <Section title="Parties">
            <dl>
              <Field label="Petitioner / appellant">{show(r.petitioner)}</Field>
              <Field label="Respondent">{show(r.respondent)}</Field>
            </dl>
          </Section>

          <Section title="Coram">
            <dl>
              <Field label="Judges">{r.judges.length ? <CoramJudges courtId={r.court_id} judges={r.judges} author={r.author} /> : DASH}</Field>
              <Field label="Author">{show(r.author)}</Field>
            </dl>
          </Section>

          <Section title="Source snippet (dataset)" aside={<span className="text-[11px] text-muted-foreground">as published in the dataset metadata; not the judgment text</span>}>
            {r.snippet ? <p className="whitespace-pre-wrap text-[13px] leading-relaxed">{r.snippet}</p> : <p className="text-[12.5px] text-muted-foreground">The dataset published no snippet for this record.</p>}
          </Section>

          {r.translations.length ? (
            <Section title="Translations">
              <ul className="space-y-1 text-[12.5px]">
                {r.translations.map((t, i) => (
                  <li key={`${t.language}-${i}`} className="flex flex-wrap items-center gap-2">
                    <span className="min-w-[120px]">{languageName(t.language)}</span>
                    <span className="text-[11.5px] text-muted-foreground">{t.origin === "court_published" ? "published by the court" : t.origin ?? "origin not recorded"}</span>
                    {t.url ? <a href={t.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">PDF · {urlHost(t.url)}<ExternalLink className="size-3" /></a> : <span className="text-muted-foreground">no link</span>}
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}

          {r.issues?.length ? (
            <Section title="Data issues flagged at ingest">
              <ul className="list-disc space-y-0.5 pl-4 text-[12.5px] text-warning-foreground dark:text-warning">{r.issues.map((x) => <li key={x}>{x}</li>)}</ul>
            </Section>
          ) : null}
        </div>

        <aside className="min-w-0 space-y-4">
          <NarrowFields.Provider value>
            <Provenance r={r} />
          </NarrowFields.Provider>
          <SameCase items={data.sameCase} r={r} />
        </aside>
      </div>
    </article>
  );
}

function Provenance({ r }: { r: CaseRecord }) {
  const s = r.sourceInfo;
  return (
    <Section title="Source & provenance">
      <dl>
        <Field label="Dataset">{s.registryUrl ? <a href={s.registryUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">{s.name}<ExternalLink className="ml-1 inline size-3" /></a> : <span className={cn(!s.registered && "text-warning-foreground dark:text-warning")}>{s.name}</span>}</Field>
        <Field label="Dataset id">{show(s.dataset)}</Field>
        <Field label="Publisher">{s.publisher}</Field>
        <Field label="Hosted on">{show(s.host)}</Field>
        <Field label="Licence">{s.licenceUrl ? <>{s.licence} <a href={s.licenceUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">Dataset terms</a></> : s.licence}</Field>
        <Field label="Source value" mono>{r.source}</Field>
        <Field label="Record id" mono><span className="break-all">{r.id}</span></Field>
        <Field label="Dataset key" mono><span className="break-all">{r.dataset_key}</span></Field>
        <Field label="Source archive" mono>
          {r.unit ? (
            <span className="break-all">
              {r.unit.archiveUrl ? <a href={r.unit.archiveUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">{r.unit.objectKey}</a> : r.unit.objectKey ?? r.unit.id}
            </span>
          ) : <span className="font-sans text-warning-foreground dark:text-warning">Archive {r.unit_id} is not in the unit registry</span>}
        </Field>
        {r.unit ? (
          <Field label="Archive status">
            <span className="tabular">{r.unit.status ?? "unknown"}{r.unit.expected != null ? ` · ${r.unit.stored ?? 0} of ${r.unit.expected} declared records stored` : r.unit.stored != null ? ` · ${r.unit.stored} stored` : ""}{r.unit.rejected ? ` · ${r.unit.rejected} rejected` : ""}</span>
            {r.unit.note ? <span className="block text-[11.5px] text-muted-foreground">{r.unit.note}</span> : null}
          </Field>
        ) : null}
        <Field label="Official PDF">{r.pdf_url ? <a href={r.pdf_url} target="_blank" rel="noopener noreferrer" className="break-all text-primary hover:underline">{urlHost(r.pdf_url)}</a> : DASH}</Field>
        <Field label="PDF key" mono><span className="break-all">{r.pdf_key ?? "—"}</span></Field>
        <Field label="Record hash" mono>
          <span className="flex items-start gap-1"><span className="break-all" title="SHA-256 of the dataset's metadata record as ingested">{r.record_sha256}</span><CopyButton value={r.record_sha256} label="Record hash" /></span>
        </Field>
        <Field label="Ingested">{show(formatTimestamp(r.ingested_at))}</Field>
        <Field label="Last changed">{show(formatTimestamp(r.updated_at))}</Field>
        <Field label="Text">{r.text_status === "none" ? "Metadata only — full text not ingested" : r.text_status === "full" ? "Full text (Open India Law, from the official PDF)" : r.text_status}</Field>
      </dl>
    </Section>
  );
}

function SameCase({ items, r }: { items: SameCaseRecord[]; r: CaseRecord }) {
  const keys = [r.cnr ? "CNR" : null, r.neutral_citation ? "neutral citation" : null].filter(Boolean).join(" or ");
  return (
    <Section title="Same case in other records" aside={items.length ? <span className="text-[11px] text-muted-foreground tabular">{items.length}</span> : null}>
      {!keys ? (
        <p className="text-[12px] text-muted-foreground">This record has no CNR or neutral citation, so other records of the same case cannot be identified.</p>
      ) : !items.length ? (
        <p className="text-[12px] text-muted-foreground">No other record in the index has this {keys}.</p>
      ) : (
        <>
          <p className="mb-2 text-[11.5px] text-muted-foreground">Separate dataset records with the same {keys}. A shared CNR can be another order or judgment in the same case; records are listed, never merged.</p>
          <ul className="divide-y">
            {items.map((h) => (
              <li key={h.id} className="py-1.5">
                <Link href={caseHref(h.id)} className="block text-[12.5px] font-medium hover:underline">{h.title}</Link>
                <div className="mt-0.5 flex flex-wrap gap-x-2 text-[11.5px] text-muted-foreground">
                  <span>{courtLabel(h)}</span>
                  <span className="tabular">{formatCaseDate(h.decision_date) ?? "undated"}</span>
                  {h.disposal ? <span>{h.disposal}</span> : null}
                  <span className="text-foreground/80">{h.reasons.map((x) => (x === "cnr" ? "same CNR" : "same neutral citation")).join(", ")}</span>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </Section>
  );
}
