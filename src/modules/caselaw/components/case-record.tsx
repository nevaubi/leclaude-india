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
import { caseApiHref, caseHref, formatCaseDate, urlHost, type CaseRecord, type CaseRecordResponse, type SameCaseRecord } from "../shared";
import { benchLabel, courtLabel } from "./case-labels";
import { CaseApiError, fetchCaseJson } from "./fetch";
import { JudgmentTextSection } from "./judgment-text";
import { CoramJudges } from "@/modules/judges/components/coram-judges";
import { CoramAvatars } from "@/modules/judges/components/coram-avatars";
import { PhotoBackdrop } from "@/components/corpus/visual-image";
import { courtVisual, useVisuals } from "@/modules/media/use-visuals";

const DASH = <span className="text-muted-foreground/60">—</span>;
const show = (v: React.ReactNode) => (v === null || v === undefined || v === "" ? DASH : v);

/** /cases/<id>: one case record with its details, the official PDF and a compact source card. */
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
        {loading && !data ? <RecordSkeleton /> : error ? <RecordError error={error} onRetry={() => setNonce((n) => n + 1)} /> : data ? <RecordBody data={data} /> : null}
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

function RecordError({ error, onRetry }: { error: CaseApiError; onRetry: () => void }) {
  if (error.notFound || error.status === 400) {
    return <EmptyState className="mt-10" icon={SearchX} title="Case not found" description="This link does not match a case in the case law collection. It may have been mistyped." action={<Button asChild size="xs" variant="outline"><Link href="/cases">Open the directory</Link></Button>} />;
  }
  if (error.notConfigured) {
    return <EmptyState className="mt-10" icon={Database} title="Case law is not available" description="Case law has not been set up for this workspace yet." />;
  }
  if (error.forbidden || error.unauthenticated) {
    return <EmptyState className="mt-10" icon={Lock} title={error.unauthenticated ? "Sign in to view this record" : "You do not have access to case law"} />;
  }
  return <EmptyState className="mt-10" icon={TriangleAlert} title="This case could not be loaded" description={error.message} action={<Button size="xs" variant="outline" onClick={onRetry}><RotateCcw className="size-3.5" />Retry</Button>} />;
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
    <section className={cn("rounded-lg border", className)} aria-label={title}>
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
  const visuals = useVisuals();
  const photo = courtVisual(visuals, r.court_id);
  return (
    <article className="mt-2">
      {/* Hero: the court's building as a quiet backdrop; parties as the title. */}
      <header className={cn("relative isolate overflow-hidden rounded-xl border px-5 pb-5 pt-4 sm:px-6", photo && "pb-8")}>
        <PhotoBackdrop visual={photo} />
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-muted-foreground">
          <span className={cn("font-medium", r.court ? "text-foreground/85" : "text-muted-foreground")}>{r.court ?? courtLabel(r)}</span>
          {bench ? <><span aria-hidden>·</span><span>{bench}</span></> : null}
          <span aria-hidden>·</span>
          <span className="tabular">{date ? `Decided ${date}` : "Decision date not available"}</span>
          {r.disposal ? <><span aria-hidden>·</span><span>{r.disposal}</span></> : null}
        </div>
        <h1 className="mt-1.5 max-w-[880px] font-serif text-[24px] leading-[1.25] tracking-[-0.01em] text-foreground">{r.title}</h1>
        <div className="mt-3 flex flex-wrap gap-1.5">
          <Citation label="Neutral" value={r.neutral_citation} />
          <Citation label="Reporter" value={r.reporter_citation} />
          <Citation label="Case no." value={r.case_number} />
          <Citation label="CNR" value={r.cnr} />
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
          {r.judges.length ? (
            <span className="inline-flex min-w-0 items-center gap-2 text-[12px] text-muted-foreground">
              <CoramAvatars courtId={r.court_id} judges={r.judges} size={26} max={5} linked />
              <span className="min-w-0 truncate">{r.judges.length === 1 ? r.judges[0] : `${r.judges.length}-judge bench`}</span>
            </span>
          ) : null}
          <span className="flex flex-wrap items-center gap-1.5">
            {r.pdf_url ? (
              <Button asChild size="xs" variant="outline" className="max-w-full bg-background/80">
                <a href={r.pdf_url} target="_blank" rel="noopener noreferrer">
                  <FileText className="size-3.5" />Official PDF<span className="min-w-0 truncate text-muted-foreground">{pdfHost ? `· ${pdfHost}` : ""}</span><ExternalLink className="size-3 opacity-60" />
                </a>
              </Button>
            ) : <span className="text-[12px] text-muted-foreground">Official PDF not available</span>}
            <Button asChild size="xs" variant="outline" className="bg-background/80">
              <Link href={`/search?q=${encodeURIComponent(researchQuery(r))}`}><Search className="size-3.5" />Research this</Link>
            </Button>
          </span>
        </div>
      </header>

      <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-4">
          {r.snippet ? (
            <section aria-label="Summary" className="rounded-lg border bg-[var(--surface-quiet)] px-4 py-3">
              <div className="mb-1 flex items-baseline gap-2"><h2 className="text-[12.5px] font-medium">Summary</h2><span className="text-[11px] text-muted-foreground">provided by the source; not the judgment text</span></div>
              <p className="max-w-[72ch] whitespace-pre-wrap font-serif text-[14.5px] leading-relaxed text-foreground/90">{r.snippet}</p>
            </section>
          ) : null}

          {r.text_status === "full" ? <JudgmentTextSection id={r.id} citation={r.neutral_citation} /> : (
            <section aria-label="Judgment text" className="flex flex-col items-start gap-2 rounded-lg border border-dashed px-4 py-5">
              <h2 className="text-[13px] font-medium">The judgment text is not available here</h2>
              <p className="max-w-[62ch] text-[12.5px] text-muted-foreground">Read the judgment in the official PDF published by the court. It is the text of record.</p>
              {r.pdf_url ? <Button asChild size="xs" variant="outline"><a href={r.pdf_url} target="_blank" rel="noopener noreferrer"><FileText className="size-3.5" />Open the official PDF<ExternalLink className="size-3 opacity-60" /></a></Button> : null}
            </section>
          )}

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
        </div>

        <aside className="min-w-0 space-y-4">
          <NarrowFields.Provider value>
            <Section title="Case details">
              <dl>
                <Field label="Court">{r.court ?? DASH}</Field>
                {r.bench ? <Field label="Bench">{r.bench}</Field> : null}
                <Field label="Bench strength">{r.bench_strength ? `${r.bench_strength} judge${r.bench_strength === 1 ? "" : "s"}` : DASH}</Field>
                <Field label="Case type">{show(r.case_type)}</Field>
                <Field label="Registered">{show(formatCaseDate(r.registration_date))}</Field>
                <Field label="Decided">{show(date)}</Field>
                <Field label="Disposal">{show(r.disposal)}</Field>
                <Field label="Language">{show(languageName(r.language))}</Field>
              </dl>
            </Section>
            <Section title="Parties">
              <dl>
                <Field label="Petitioner">{show(r.petitioner)}</Field>
                <Field label="Respondent">{show(r.respondent)}</Field>
              </dl>
            </Section>
            {r.judges.length ? (
              <Section title="Coram" className="text-[12.5px]">
                <CoramJudges courtId={r.court_id} judges={r.judges} author={r.author} />
                {r.author && !r.judges.includes(r.author) ? <p className="mt-1.5 text-[12px]"><span className="text-muted-foreground">Author: </span>{r.author}</p> : null}
              </Section>
            ) : null}
            <SourceCard r={r} />
          </NarrowFields.Provider>
          <SameCase items={data.sameCase} r={r} />
        </aside>
      </div>
    </article>
  );
}

/** "Supreme Court of India (judgments and metadata as published by the Court)" → "Supreme Court of India". */
function plainPublisher(s: CaseRecord["sourceInfo"], r: CaseRecord): string {
  if (!s.registered) return r.court ?? "Not recorded";
  return s.publisher.replace(/\s*\(.*\)\s*$/, "") || s.publisher;
}

function SourceCard({ r }: { r: CaseRecord }) {
  const s = r.sourceInfo;
  const date = formatCaseDate(r.decision_date);
  return (
    <Section title="Source">
      <dl>
        <Field label="Published by">{plainPublisher(s, r)}</Field>
        <Field label="Official PDF">{r.pdf_url ? <a href={r.pdf_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 break-all text-primary hover:underline">{urlHost(r.pdf_url) ?? "Open PDF"}<ExternalLink className="size-3" /></a> : <span className="text-muted-foreground">Not available</span>}</Field>
        <Field label="Decided">{show(date)}</Field>
      </dl>
      <p className="mt-2 border-t pt-2 text-[11px] leading-snug text-muted-foreground">
        {s.registered ? <>Collected from {s.registryUrl ? <a href={s.registryUrl} target="_blank" rel="noopener noreferrer" className="hover:text-foreground hover:underline">{s.name.replace(/\s*\(open data\)\s*$/i, "")}</a> : s.name}{s.licenceUrl ? <> (<a href={s.licenceUrl} target="_blank" rel="noopener noreferrer" className="hover:text-foreground hover:underline">terms</a>)</> : null}. </> : null}
        The official PDF is the text of record.
      </p>
    </Section>
  );
}

function SameCase({ items, r }: { items: SameCaseRecord[]; r: CaseRecord }) {
  const keys = [r.cnr ? "CNR" : null, r.neutral_citation ? "neutral citation" : null].filter(Boolean).join(" or ");
  return (
    <Section title="Related orders and judgments" aside={items.length ? <span className="text-[11px] text-muted-foreground tabular">{items.length}</span> : null}>
      {!keys ? (
        <p className="text-[12px] text-muted-foreground">No CNR or neutral citation is available to find related orders.</p>
      ) : !items.length ? (
        <p className="text-[12px] text-muted-foreground">No other orders or judgments found with this {keys}.</p>
      ) : (
        <>
          <p className="mb-2 text-[11.5px] text-muted-foreground">Other orders or judgments with the same {keys}.</p>
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
