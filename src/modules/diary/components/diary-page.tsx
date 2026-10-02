"use client";
import * as React from "react";
import Link from "next/link";
import { CalendarClock, CalendarX2, ChevronLeft, ChevronRight, ExternalLink, Loader2, Plus, UserRound, X } from "lucide-react";
import { toast } from "sonner";
import { PageTopbar } from "@/components/shell/page-topbar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Chip, EmptyState } from "@/components/ui/misc";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import { addDays } from "@/lib/india/holidays";
import { matterHref } from "@/lib/features";
import { apiJSON, ApiError } from "@/modules/matters/components/api";
import { AuthorityNote, ListingDetails, OfficialNotice, PanelError, PanelSkeleton, useDeskFetch } from "@/modules/matters/components/desk/shared";
import { indiaToday } from "@/modules/matters/desk/dates";
import { forumLabel, forumShortLabel } from "@/modules/matters/desk/tracking";
import type { AdvocateListsResponse, CauseListEntry, DiaryEntry, DiaryResponse } from "@/modules/matters/desk/types";
import type { AdvocateListLink } from "../advocate-links";

const WINDOW = 14;

/** /diary: the next fortnight's hearings across the user's matters, plus advocate-wise lists. */
export function DiaryPage() {
  const i18n = useI18n();
  const { t } = i18n;
  const today = React.useMemo(() => indiaToday(), []);
  const [from, setFrom] = React.useState(today);
  const to = addDays(from, WINDOW - 1);
  const res = useDeskFetch<DiaryResponse>(`/api/diary?from=${from}&to=${to}`);
  const d = res.data;
  const days = React.useMemo(() => groupByDay(d?.entries ?? []), [d]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageTopbar icon={<CalendarClock />} title={t("diary.title")} context={`${i18n.date(from, "medium")} – ${i18n.date(to, "medium")}${d ? ` · ${t("diary.counts", { tracked: d.tracked, matters: d.matters })}` : ""}`}>
        <div className="ms-auto flex items-center gap-1">
          <Button size="icon-xs" variant="ghost" aria-label={t("diary.previous")} onClick={() => setFrom((f) => addDays(f, -WINDOW))}><ChevronLeft className="size-4" /></Button>
          <Button size="xs" variant={from === today ? "secondary" : "ghost"} onClick={() => setFrom(today)}>{t("diary.today")}</Button>
          <Button size="icon-xs" variant="ghost" aria-label={t("diary.next")} onClick={() => setFrom((f) => addDays(f, WINDOW))}><ChevronRight className="size-4" /></Button>
        </div>
      </PageTopbar>
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
        <div className="mx-auto grid w-full max-w-[1320px] gap-6 p-4 lg:grid-cols-[minmax(0,1fr)_340px]">
          <main className="min-w-0 space-y-3" aria-label={t("diary.title")}>
            {res.state === "loading" && !d ? <PanelSkeleton rows={5} /> : res.state === "error" ? <PanelError error={res.error} onRetry={res.reload} className="rounded-md border" /> : d && (
              <>
                {d.official.state !== "ok" && <OfficialNotice state={d.official.state} message={d.official.message} onRetry={res.reload} />}
                {!!d.official.uncoveredForums.length && <p className="text-[11.5px] leading-snug text-muted-foreground">{t("diary.partial", { forums: d.official.uncoveredForums.map(forumLabel).join(", ") })}</p>}
                {!days.length ? (
                  <EmptyState icon={CalendarX2} title={d.matters ? t("diary.empty") : t("diary.noMatters")} description={d.matters ? t("diary.emptyHint") : undefined} className="rounded-md border" />
                ) : (
                  <ol className="space-y-4">
                    {days.map(([date, entries]) => (
                      <li key={date}>
                        <h2 className="sticky top-0 z-[1] flex items-baseline gap-2 border-b bg-background py-1.5 text-[12.5px] font-semibold">
                          {i18n.date(date, "full")}
                          {date === today && <Chip tone="primary">{t("diary.today")}</Chip>}
                          {date === addDays(today, 1) && <Chip tone="quiet">{t("diary.tomorrow")}</Chip>}
                          <span className="ms-auto text-[11px] font-normal text-muted-foreground">{t("diary.entries", { count: entries.length })}</span>
                        </h2>
                        <ul className="divide-y">
                          {entries.map((e) => <DiaryRow key={e.id} entry={e} />)}
                        </ul>
                      </li>
                    ))}
                  </ol>
                )}
                {d.tracked > 0 && <AuthorityNote />}
              </>
            )}
          </main>
          <AdvocatePanel />
        </div>
      </div>
    </div>
  );
}

function groupByDay(entries: DiaryEntry[]): [string, DiaryEntry[]][] {
  const by = new Map<string, DiaryEntry[]>();
  for (const e of entries) by.set(e.date, [...(by.get(e.date) ?? []), e]);
  return Array.from(by.entries()).sort((a, b) => a[0].localeCompare(b[0]));
}

function DiaryRow({ entry: e }: { entry: DiaryEntry }) {
  const { t } = useI18n();
  const href = `${matterHref(e.matterId)}&tab=hearings`;
  return (
    <li className="grid gap-x-4 gap-y-1 py-2.5 sm:grid-cols-[200px_minmax(0,1fr)]">
      <div className="min-w-0">
        <Link href={href} className="block truncate text-[12.5px] font-medium underline-offset-4 hover:underline" title={e.matterName}>{e.matterName}</Link>
        <span className="text-[11px] text-muted-foreground">{e.kind === "listing" ? t("diary.listed") : e.kind === "manual" ? t("desk.manualBadge") : t("diary.particulars")}</span>
      </div>
      {e.kind === "listing" ? (
        <ListingDetails entry={e.entry} source={e.source} matchedOn={e.matchedOn} printed={e.printed} />
      ) : e.kind === "manual" ? (
        <div className="min-w-0 text-[12.5px]">
          <div className="flex flex-wrap items-baseline gap-x-2">
            {e.hearing.time && <span className="tabular">{e.hearing.time}</span>}
            {e.hearing.courtNo && <span className="font-medium">{t("desk.court", { no: e.hearing.courtNo })}</span>}
            {e.hearing.itemNo && <span className="tabular">{t("desk.item", { no: e.hearing.itemNo })}</span>}
            {e.hearing.court && <span className="text-muted-foreground">{e.hearing.court}</span>}
          </div>
          {e.hearing.purpose && <div className="text-[12px] text-muted-foreground">{e.hearing.purpose}</div>}
        </div>
      ) : (
        <div className="min-w-0 text-[12.5px]">
          <div className="flex flex-wrap items-baseline gap-x-2">
            {e.courtHall && <span className="font-medium">{e.courtHall}</span>}
            {e.item != null && <span className="tabular">{t("desk.item", { no: String(e.item) })}</span>}
          </div>
          {e.purpose && <div className="text-[12px] text-muted-foreground">{e.purpose}</div>}
        </div>
      )}
    </li>
  );
}

type AdvocatesResponse = AdvocateListsResponse & { links: AdvocateListLink[]; linksCheckedOn: string };

function AdvocatePanel() {
  const i18n = useI18n();
  const { t } = i18n;
  const res = useDeskFetch<AdvocatesResponse>("/api/diary/advocates");
  const [name, setName] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const names = res.data?.names ?? [];
  const results = res.data?.results ?? [];
  const sharedFailure = results.length > 0 && results.every((r) => r.state !== "ok" && r.state === results[0].state) ? results[0] : null;

  const save = async (next: string[]) => {
    setBusy(true);
    setError(null);
    try {
      await apiJSON("/api/diary/advocates", { method: "PUT", json: { names: next } });
      toast.success(t("diary.toast.namesSaved"));
      res.reload();
      return true;
    } catch (e) {
      setError((e as ApiError).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (name.trim() && (await save([...names, name.trim()]))) setName("");
  };

  return (
    <aside className="min-w-0 space-y-4 lg:border-s lg:ps-6" aria-label={t("diary.advocates")}>
      <section className="space-y-2">
        <div>
          <h2 className="text-[12.5px] font-semibold">{t("diary.advocates")}</h2>
          <p className="text-[11.5px] leading-snug text-muted-foreground">{t("diary.advocatesHint")}</p>
        </div>
        {res.state === "loading" && !res.data ? <PanelSkeleton rows={2} /> : res.state === "error" ? <PanelError error={res.error} onRetry={res.reload} /> : (
          <>
            {!!names.length && (
              <div className="flex flex-wrap gap-1">
                {names.map((n) => (
                  <span key={n} className="inline-flex h-6 items-center gap-1 rounded border px-1.5 text-[11.5px]">
                    <UserRound className="size-3 text-muted-foreground" aria-hidden />{n}
                    <button type="button" disabled={busy} aria-label={`${t("common.remove")} ${n}`} className="text-muted-foreground hover:text-foreground" onClick={() => void save(names.filter((x) => x !== n))}><X className="size-3" /></button>
                  </span>
                ))}
              </div>
            )}
            <form onSubmit={add} className="flex gap-1.5">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("diary.advocateAdd")} aria-label={t("diary.advocateAdd")} maxLength={80} className="h-8 text-[12px]" />
              <Button size="sm" variant="outline" type="submit" disabled={busy || !name.trim()}>{busy ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}</Button>
            </form>
            {error && <p className="text-[11.5px] text-destructive" role="alert">{error}</p>}
            {!names.length ? <p className="text-[12px] text-muted-foreground">{t("diary.advocateNone")}</p> : sharedFailure ? (
              // Every name failed the same way (lists not configured / not available): one notice, not one per name.
              <OfficialNotice state={sharedFailure.state} message={sharedFailure.message} compact onRetry={res.reload} />
            ) : (
              <div className="space-y-3">
                {res.data?.results.map((r) => (
                  <div key={r.name} className="space-y-1">
                    <div className="text-[11.5px] font-medium">{r.name}</div>
                    {r.state !== "ok" ? <OfficialNotice state={r.state} message={r.message} compact /> : !r.entries.length ? (
                      <p className="text-[11.5px] text-muted-foreground">{t("diary.advocateNoMatches")}</p>
                    ) : (
                      <ul className="divide-y rounded-md border">
                        {r.entries.slice(0, 25).map((e) => <AdvocateEntry key={e.id} entry={e} />)}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </section>
      <section className="space-y-1.5 border-t pt-3">
        <h2 className="text-[12.5px] font-semibold">{t("diary.courtPages")}</h2>
        <p className="text-[11.5px] leading-snug text-muted-foreground">{t("diary.courtPagesHint")}</p>
        <ul className="space-y-1.5">
          {(res.data?.links ?? []).map((l) => (
            <li key={l.url} className="text-[12px]">
              <a href={l.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium underline decoration-border underline-offset-2 hover:decoration-foreground">{l.court}<ExternalLink className="size-3" aria-hidden /></a>
              <div className="text-[11px] text-muted-foreground">{l.label} · {l.note}</div>
            </li>
          ))}
        </ul>
        {res.data?.linksCheckedOn && <p className="text-[10.5px] text-muted-foreground">{t("diary.linksChecked", { date: i18n.date(res.data.linksCheckedOn, "medium") })}</p>}
      </section>
    </aside>
  );
}

function AdvocateEntry({ entry: e }: { entry: CauseListEntry }) {
  const i18n = useI18n();
  const { t } = i18n;
  return (
    <li className={cn("space-y-0.5 px-2 py-1.5 text-[12px]")}>
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-medium tabular">{i18n.date(e.listDate, "medium")}</span>
        <span className="text-[11px] text-muted-foreground" title={forumLabel(e.forum)}>{forumShortLabel(e.forum)}</span>
        {e.courtNo && <span>{t("desk.court", { no: e.courtNo })}</span>}
        {e.itemNo && <span className="tabular">{t("desk.item", { no: e.itemNo })}</span>}
      </div>
      {e.caseNumbers.length > 0 && <div className="truncate font-mono text-[11px]">{e.caseNumbers.map((c) => c.printed).join(", ")}</div>}
      {e.parties && <div className="line-clamp-2 text-[11.5px] text-muted-foreground">{e.parties}</div>}
    </li>
  );
}
