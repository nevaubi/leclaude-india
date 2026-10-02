"use client";
import * as React from "react";
import Link from "next/link";
import { Database, FileText, Lock, RotateCcw, Search, SearchX, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Chip, EmptyState, Spinner } from "@/components/ui/misc";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import type { CauseListEntry } from "@/modules/official/types";
import { asOfficialApiError, fetchOfficialJson, type OfficialApiError } from "@/modules/official-ui/fetch";
import { formatFetchedAt, pageLabel, sourceDocHref } from "@/modules/official-ui/shared";
import { CAUSE_LIST_FORUMS, causeListQuery, DECISION_SUPPORT_FOOTER, formatIsoDate, type CauseListSearch } from "../lib";
import { CopyButton, DateField, Field, ToolHeader } from "./shared";
import { indiaToday } from "./use-court-calendars";

const LIST_TYPE: Record<string, string> = { main: "Main list", supplementary: "Supplementary list", advance: "Advance list", weekly: "Weekly list", daily: "Daily list", other: "List" };

function entryText(e: CauseListEntry): string {
  const parts = [
    `${formatIsoDate(e.listDate)} · ${LIST_TYPE[e.listType] ?? "List"}${e.courtNo ? ` · Court ${e.courtNo}` : ""}${e.itemNo ? ` · Item ${e.itemNo}` : ""}`,
    e.caseNumbers.length ? e.caseNumbers.map((c) => c.printed).join("; ") : null,
    e.diaryNo ? `Diary No. ${e.diaryNo}` : null,
    e.parties,
    e.advocates.length ? `Advocates: ${e.advocates.join(", ")}` : null,
    e.bench ? `Bench: ${e.bench}` : null,
    `As published${e.publishedAt ? ` at ${formatFetchedAt(e.publishedAt)}` : ""}; fetched ${formatFetchedAt(e.fetchedAt) ?? e.fetchedAt}`,
  ];
  return parts.filter(Boolean).join("\n");
}

/** Search published cause lists by forum, date, exact case or diary number, or an advocate's name as printed. */
export function CauseListPanel() {
  const [form, setForm] = React.useState<CauseListSearch>(() => ({ forum: "sci", date: indiaToday(), caseNumber: "", diary: "", advocate: "" }));
  const [submitted, setSubmitted] = React.useState<string | null>(null);
  const [entries, setEntries] = React.useState<CauseListEntry[] | null>(null);
  const [error, setError] = React.useState<OfficialApiError | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [nonce, setNonce] = React.useState(0);
  const check = causeListQuery(form);
  const forum = CAUSE_LIST_FORUMS.find((f) => f.forum === form.forum)!;
  const set = (patch: Partial<CauseListSearch>) => setForm((f) => ({ ...f, ...patch }));

  React.useEffect(() => {
    if (!submitted) return;
    const ac = new AbortController();
    setLoading(true);
    setError(null);
    fetchOfficialJson<{ entries: CauseListEntry[]; count: number }>(`/api/official/causelists?${submitted}`, ac.signal)
      .then((r) => setEntries(Array.isArray(r.entries) ? r.entries : []))
      .catch((e) => { if ((e as Error).name !== "AbortError") { setEntries(null); setError(asOfficialApiError(e)); } })
      .finally(() => { if (!ac.signal.aborted) setLoading(false); });
    return () => ac.abort();
  }, [submitted, nonce]);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!check.qs) return;
    if (check.qs === submitted) setNonce((n) => n + 1);
    else setSubmitted(check.qs);
  };

  const groups = React.useMemo(() => {
    const m = new Map<string, CauseListEntry[]>();
    for (const e of entries ?? []) {
      const k = `${e.forum}|${e.listDate}|${e.listType}|${e.courtNo ?? ""}`;
      m.set(k, [...(m.get(k) ?? []), e]);
    }
    return [...m.values()];
  }, [entries]);
  const copyAll = entries?.length ? [`Cause list entries (${forum.label})`, "", ...entries.map(entryText).flatMap((t) => [t, ""]), "Cause lists are not authoritative: confirm against the court's published list.", DECISION_SUPPORT_FOOTER].join("\n") : null;

  return (
    <div>
      <ToolHeader title="Cause list search" description="Entries from cause lists as the court published them. Case and diary numbers match exactly; an advocate's name matches the whole name as printed. A list can change after publication — confirm against the court's list." />
      <form onSubmit={onSubmit} className="grid gap-4 lg:grid-cols-2" aria-label="Cause list search">
        <Field id="cl-forum" label="Court or tribunal">
          <Select value={form.forum} onValueChange={(v) => set({ forum: v, diary: CAUSE_LIST_FORUMS.find((f) => f.forum === v)?.diary ? form.diary : "" })}>
            <SelectTrigger id="cl-forum" size="sm" className="w-full sm:w-[320px]"><SelectValue /></SelectTrigger>
            <SelectContent>{CAUSE_LIST_FORUMS.map((f) => <SelectItem key={f.forum} value={f.forum}>{f.label}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
        <DateField id="cl-date" label="List date" optional value={form.date} onChange={(v) => set({ date: v })} hint="Leave empty to search every loaded list for a case or diary number." />
        <Field id="cl-case" label={<>Case number<span className="ml-1 font-normal text-muted-foreground">(optional)</span></>} hint="As printed, e.g. SLP(C) No. 1234/2026 or W.P.(C) 5812/2016.">
          <Input id="cl-case" size="sm" value={form.caseNumber} onChange={(e) => set({ caseNumber: e.target.value })} maxLength={160} className="w-full sm:w-[320px]" />
        </Field>
        {forum.diary ? (
          <Field id="cl-diary" label={<>Diary number<span className="ml-1 font-normal text-muted-foreground">(optional)</span></>} hint="e.g. 54583/2026.">
            <Input id="cl-diary" size="sm" value={form.diary} onChange={(e) => set({ diary: e.target.value })} maxLength={40} className="w-full tabular sm:w-[200px]" />
          </Field>
        ) : <div className="hidden lg:block" />}
        <Field id="cl-adv" label={<>Advocate<span className="ml-1 font-normal text-muted-foreground">(optional)</span></>} hint="The whole name as printed on the list; not a partial match.">
          <Input id="cl-adv" size="sm" value={form.advocate} onChange={(e) => set({ advocate: e.target.value })} maxLength={120} className="w-full sm:w-[320px]" />
        </Field>
        <div className="flex items-end gap-2">
          <Button type="submit" size="sm" disabled={!check.qs || loading}>{loading ? <Spinner size={12} /> : <Search className="size-3.5" />}Search lists</Button>
          {check.error && (form.caseNumber || form.diary || form.advocate || !form.date) ? <p className="text-[11.5px] text-destructive">{check.error}</p> : null}
        </div>
      </form>

      <div className="mt-5" aria-live="polite">
        {!submitted ? (
          <div role="status" className="rounded-lg border border-dashed px-4 py-8 text-center text-[12.5px] text-muted-foreground">Choose a court, then a date, a case or diary number, or an advocate, and search.</div>
        ) : loading && !entries ? (
          <div className="space-y-2" aria-busy>{Array.from({ length: 4 }, (_, k) => <Skeleton key={k} className="h-14 rounded-md" />)}</div>
        ) : error ? (
          error.notConfigured ? <EmptyState icon={Database} title="Cause lists are not set up" description="Official sources are not configured on this workspace." />
            : error.notAvailable ? <EmptyState icon={Database} title="Cause lists are not available yet" description="Cause-list search will appear here once official sources are added." />
            : error.forbidden || error.unauthenticated ? <EmptyState icon={Lock} title={error.unauthenticated ? "Sign in to search cause lists" : "You do not have access to official sources"} />
            : error.badRequest ? <EmptyState icon={TriangleAlert} title="This search cannot be run" description={error.message} />
            : <EmptyState icon={TriangleAlert} title="Cause lists could not be searched" description={error.message} action={<Button size="xs" variant="outline" onClick={() => setNonce((n) => n + 1)}><RotateCcw className="size-3.5" />Retry</Button>} />
        ) : entries && !entries.length ? (
          <EmptyState icon={SearchX} title="No entries found" description="No loaded cause list has an entry matching exactly. The list may not be published or loaded yet; nothing similar is shown in its place." />
        ) : entries ? (
          <section aria-label="Cause list entries" className="rounded-lg border bg-card">
            <header className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
              <h3 className="text-[13px] font-medium">{entries.length} entr{entries.length === 1 ? "y" : "ies"}</h3>
              {loading ? <Spinner size={12} /> : null}
              <span className="text-[11.5px] text-muted-foreground">as published; not authoritative</span>
              <span className="flex-1" />
              <CopyButton text={copyAll} />
            </header>
            <div className="divide-y">
              {groups.map((g) => {
                const h = g[0];
                return (
                  <div key={`${h.forum}|${h.listDate}|${h.listType}|${h.courtNo ?? ""}`}>
                    <div className="flex flex-wrap items-center gap-x-2 bg-[var(--surface-quiet)] px-4 py-1.5 text-[11.5px] text-muted-foreground">
                      <span className="font-medium text-foreground/85 tabular">{formatIsoDate(h.listDate)}</span>
                      <span>{LIST_TYPE[h.listType] ?? "List"}</span>
                      {h.courtNo ? <span>· Court {h.courtNo}</span> : null}
                      {h.bench ? <span className="min-w-0 truncate" title={h.bench}>· {h.bench}</span> : null}
                    </div>
                    <ul className="divide-y divide-line-quiet">
                      {g.map((e) => <EntryRow key={e.id} e={e} />)}
                    </ul>
                  </div>
                );
              })}
            </div>
            <p className="border-t px-4 py-2 text-[11px] text-muted-foreground">Cause lists are published by the court and can be revised. Confirm the listing on the court&apos;s own list before relying on it.</p>
          </section>
        ) : null}
      </div>
    </div>
  );
}

function EntryRow({ e }: { e: CauseListEntry }) {
  const page = pageLabel(e.page);
  return (
    <li className="grid gap-x-3 gap-y-1 px-4 py-2 text-[12.5px] sm:grid-cols-[4.5rem_minmax(0,1fr)_auto]">
      <span className="text-[11.5px] text-muted-foreground tabular">{e.itemNo ? `Item ${e.itemNo}` : "Item —"}</span>
      <div className="min-w-0">
        {e.parsed ? (
          <>
            <div className="flex flex-wrap items-baseline gap-x-2">
              {e.caseNumbers.length ? <span className="font-medium tabular">{e.caseNumbers.map((c) => c.printed).join("; ")}</span> : <span className="text-muted-foreground">Case number not printed</span>}
              {e.diaryNo ? <span className="text-[11.5px] text-muted-foreground tabular">Diary No. {e.diaryNo}</span> : null}
            </div>
            {e.parties ? <div className="mt-0.5 text-foreground/85">{e.parties}</div> : null}
            {e.advocates.length ? <div className="mt-0.5 text-[11.5px] text-muted-foreground">{e.advocates.join(", ")}</div> : null}
          </>
        ) : (
          <>
            <Chip tone="warning">Not split into fields</Chip>
            <p className="mt-1 whitespace-pre-wrap font-mono text-[11.5px] text-foreground/85">{e.raw}</p>
          </>
        )}
        <div className="mt-1 text-[11px] text-muted-foreground">
          {e.publishedAt ? <>As published at {formatFetchedAt(e.publishedAt)}</> : <>Publication time not printed</>} · fetched {formatFetchedAt(e.fetchedAt) ?? e.fetchedAt}
        </div>
      </div>
      <Link href={sourceDocHref(e.documentId, { page: e.page })} className="inline-flex h-6 items-center gap-1 self-start rounded px-1.5 text-[11.5px] text-primary hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
        <FileText className="size-3.5" aria-hidden />Source list{page ? ` · ${page}` : ""}
      </Link>
    </li>
  );
}
