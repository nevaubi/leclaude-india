"use client";
import * as React from "react";
import Link from "next/link";
import { ArrowRight, CalendarClock, ExternalLink } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import { addDays } from "@/lib/india/holidays";
import { matterHref } from "@/lib/features";
import { indiaToday } from "@/modules/matters/desk/dates";
import type { DiaryResponse } from "@/modules/matters/desk/types";
import { useHome } from "./home-provider";
import { listedSoonEntries } from "./listed-soon-model";
import { Section } from "./shared";

/**
 * "Listed today and tomorrow" on Home, right after the Today spine: official listings, hand-entered hearings and
 * recorded next hearings for the matters the user can see (from /api/diary, which is scoped to the principal).
 * Renders nothing when there is nothing listed, and nothing when the user has no access.
 */
export function ListedSoon() {
  const { matters, matterFilter } = useHome();
  const i18n = useI18n();
  const { t } = i18n;
  const today = React.useMemo(() => indiaToday(), []);
  const tomorrow = addDays(today, 1);
  const [state, setState] = React.useState<{ status: "loading" | "ready" | "denied" | "error"; data?: DiaryResponse }>({ status: "loading" });

  React.useEffect(() => {
    const ac = new AbortController();
    fetch(`/api/diary?from=${today}&to=${tomorrow}`, { signal: ac.signal, headers: { accept: "application/json" } })
      .then(async (r) => {
        if (r.status === 401 || r.status === 403) return setState({ status: "denied" });
        if (!r.ok) return setState({ status: "error" });
        setState({ status: "ready", data: (await r.json()) as DiaryResponse });
      })
      .catch((e) => { if ((e as Error).name !== "AbortError") setState({ status: "error" }); });
    return () => ac.abort();
  }, [today, tomorrow]);

  const entries = React.useMemo(() => listedSoonEntries({ status: state.status, diary: state.data?.entries, matters, today, matterFilter }), [state, matters, today, matterFilter]);

  if (!entries.length) return null;
  const partial = state.status === "ready" && state.data && state.data.official.state !== "ok";
  return (
    <Section
      title={t("home.listed.title")}
      icon={CalendarClock}
      count={entries.length}
      description={t("desk.notAuthoritative")}
      actions={<Link href="/diary" className="inline-flex items-center gap-1 text-[11.5px] text-muted-foreground hover:text-foreground">{t("home.listed.openDiary")}<ArrowRight className="size-3" aria-hidden /></Link>}
    >
      <ul className="divide-y rounded-md border">
        {entries.map((e) => (
          <li key={e.id} className="grid items-baseline gap-x-3 gap-y-0.5 px-3 py-2 text-[12.5px] sm:grid-cols-[88px_minmax(0,220px)_minmax(0,1fr)]">
            <span className={cn("text-[11.5px] font-medium", e.date === today ? "text-foreground" : "text-muted-foreground")}>{e.date === today ? t("diary.today") : t("diary.tomorrow")}</span>
            <Link href={`${matterHref(e.matterId)}&tab=hearings`} className="truncate font-medium underline-offset-4 hover:underline" title={e.matterName}>{e.matterName}</Link>
            <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-muted-foreground">
              {e.kind === "listing" ? (
                <>
                  {e.entry.courtNo && <span className="text-foreground">{t("desk.court", { no: e.entry.courtNo })}</span>}
                  {e.entry.itemNo && <span className="tabular text-foreground">{t("desk.item", { no: e.entry.itemNo })}</span>}
                  {e.entry.bench && <span className="truncate text-[11.5px]" title={e.entry.bench}>{e.entry.bench}</span>}
                  {e.source && /^https?:\/\//i.test(e.source.url) && <a href={e.source.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-[11px] underline decoration-border underline-offset-2 hover:text-foreground">{t("desk.sourceList")}<ExternalLink className="size-3" aria-hidden /></a>}
                </>
              ) : e.kind === "manual" ? (
                <>
                  {e.hearing.time && <span className="tabular text-foreground">{e.hearing.time}</span>}
                  {e.hearing.courtNo && <span className="text-foreground">{t("desk.court", { no: e.hearing.courtNo })}</span>}
                  {e.hearing.itemNo && <span className="tabular text-foreground">{t("desk.item", { no: e.hearing.itemNo })}</span>}
                  {e.hearing.purpose && <span className="truncate text-[11.5px]">{e.hearing.purpose}</span>}
                  <span className="text-[11px]">{t("desk.manualBadge")}</span>
                </>
              ) : (
                <>
                  {e.courtHall && <span className="text-foreground">{e.courtHall}</span>}
                  {e.item != null && <span className="tabular text-foreground">{t("desk.item", { no: String(e.item) })}</span>}
                  {e.purpose && <span className="truncate text-[11.5px]">{e.purpose}</span>}
                  <span className="text-[11px]">{t("diary.particulars")}</span>
                </>
              )}
            </span>
          </li>
        ))}
      </ul>
      {partial && <p className="mt-1.5 px-1 text-[11px] text-muted-foreground">{state.data!.official.state === "not_configured" ? t("desk.state.notConfigured") : state.data!.official.state === "not_available" ? t("desk.state.notAvailable") : t("desk.state.error")}</p>}
    </Section>
  );
}
