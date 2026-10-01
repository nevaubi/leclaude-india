"use client";
import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { AlertTriangle, BookOpen, ExternalLink, Landmark, MapPin } from "lucide-react";
import { cn } from "@/lib/utils";
import { PageTopbar } from "@/components/shell/page-topbar";
import { EmptyState } from "@/components/ui/misc";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { courtById } from "@/lib/india/courts";
import { CITIES, FORUM_CHECKED_AT, FORUM_KIND_ORDER, cityById, forumsForCity, stateName, type City, type Forum, type ForumKind } from "@/lib/india/forums";
import { LocalLawList, useLocalLaw } from "./local-law-list";
import { CourtEmblem } from "@/modules/judges/components/court-emblem";

const NONE = "__none__";

export const KIND_LABEL: Record<ForumKind, string> = {
  high_court: "High Court", bench: "High Court bench", district: "District courts", city_civil: "City civil courts", sessions: "Sessions courts",
  commercial: "Commercial courts", small_causes: "Small causes courts", family: "Family courts", magistrate: "Magistrates' courts",
  nclt: "Company Law Tribunal (NCLT)", nclat: "Company Law Appellate Tribunal (NCLAT)", drt: "Debts Recovery Tribunal", drat: "Debts Recovery Appellate Tribunal",
  consumer_national: "National Consumer Commission", consumer_state: "State Consumer Commission", consumer_district: "District Consumer Commission",
  rera: "Real Estate Regulatory Authority", rera_appellate: "Real Estate Appellate Tribunal", labour: "Labour courts and tribunals", other: "Other forums",
};

const LINK_LABEL: Record<string, string> = { efiling: "E-filing", causeList: "Cause list", caseStatus: "Case status", judgments: "Judgments" };

function fmtChecked(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

/** An external link to an official page: new tab, no opener, no referrer. */
export function ExtLink({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={cn("inline-flex items-center gap-1 text-[11.5px] text-primary underline-offset-2 hover:underline focus-visible:underline", className)}>
      {children}<ExternalLink className="size-3 shrink-0 opacity-70" aria-hidden />
    </a>
  );
}

function ForumRow({ forum, cityId }: { forum: Forum; cityId: string }) {
  const elsewhere = forum.cityId !== cityId ? cityById(forum.cityId) : null;
  const bench = forum.courtId && forum.benchId ? courtById(forum.courtId)?.benches.find((b) => b.id === forum.benchId) : undefined;
  const links = Object.entries(forum.links ?? {}).filter(([, v]) => !!v) as [string, string][];
  return (
    <li className="border-b border-line-quiet px-3 py-2.5 last:border-b-0" id={`forum-${forum.id}`}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        {forum.kind === "high_court" && forum.courtId ? <CourtEmblem courtId={forum.courtId} size={22} /> : null}
        <span className="text-[13px] font-medium">{forum.name}</span>
        {elsewhere && <span className="text-[11px] text-muted-foreground">sits at {bench?.city ?? elsewhere.name}</span>}
      </div>
      {forum.address && <div className="mt-0.5 flex items-start gap-1 text-[11.5px] text-muted-foreground"><MapPin className="mt-0.5 size-3 shrink-0" aria-hidden />{forum.address}</div>}
      {forum.note && <div className="mt-0.5 text-[11.5px] text-muted-foreground">{forum.note}</div>}
      {(forum.website || links.length > 0) && (
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
          {forum.website && <ExtLink href={forum.website}>{hostOf(forum.website)}</ExtLink>}
          {links.map(([k, v]) => <ExtLink key={k} href={v}>{LINK_LABEL[k] ?? k}</ExtLink>)}
        </div>
      )}
      {forum.sources.length ? (
        <ul className="mt-1 space-y-0.5" aria-label="Sources">
          {forum.sources.map((s, i) => (
            <li key={`${s.url}-${i}`} className="flex min-w-0 items-baseline gap-1 text-[10.5px] text-muted-foreground">
              <span className="shrink-0">Source:</span>
              <a href={s.url} target="_blank" rel="noopener noreferrer" className="min-w-0 truncate hover:text-foreground hover:underline">{s.title}</a>
              <span className="shrink-0">· {fmtChecked(s.checkedAt)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function CityForums({ city }: { city: City }) {
  const forums = forumsForCity(city.id);
  const byKind = FORUM_KIND_ORDER.map((k) => ({ kind: k, items: forums.filter((f) => f.kind === k) })).filter((g) => g.items.length);
  if (!forums.length) return <EmptyState icon={Landmark} title="No forums recorded for this city" description="Only forums confirmed on an official page are listed." />;
  return (
    <div className="space-y-4">
      {byKind.map((g) => (
        <section key={g.kind} aria-labelledby={`kind-${g.kind}`}>
          <h2 id={`kind-${g.kind}`} className="mb-1 px-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{KIND_LABEL[g.kind]}</h2>
          <ul className="rounded-md border">{g.items.map((f) => <ForumRow key={f.id} forum={f} cityId={city.id} />)}</ul>
        </section>
      ))}
    </div>
  );
}

function LocalLawPanel({ city }: { city: City }) {
  const state = useLocalLaw(city.id);
  return (
    <section aria-labelledby="local-law" className="rounded-md border">
      <div className="flex items-center gap-1.5 border-b px-3 py-2">
        <BookOpen className="size-3.5 text-muted-foreground" aria-hidden />
        <h2 id="local-law" className="text-[12.5px] font-semibold">Local law · {stateName(city.state)}</h2>
      </div>
      <div className="px-3 py-2">
        <p className="mb-2 text-[11px] leading-snug text-muted-foreground">State statutes a litigator here commonly needs. Titles are matched exactly against the law corpus; an unmatched title is shown as not found and is never replaced by a similar Act.</p>
        <LocalLawList state={state} />
      </div>
    </section>
  );
}

function CityPicker({ value, onChange, className }: { value: string; onChange: (id: string | null) => void; className?: string }) {
  return (
    <Select value={value || NONE} onValueChange={(v) => onChange(v === NONE ? null : v)}>
      <SelectTrigger size="xs" className={cn("w-[12rem] text-[11.5px]", className)} aria-label="City"><SelectValue placeholder="Choose a city" /></SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}><span className="text-muted-foreground">All cities</span></SelectItem>
        {CITIES.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

/** /courts?city=<id> — forums by city with official links and sources, and the State's local-law pointers. */
export function CourtsBrowser({ initialCity, unknownCity }: { initialCity: string | null; unknownCity?: string | null }) {
  const router = useRouter();
  const pathname = usePathname();
  const [cityId, setCityId] = React.useState<string | null>(initialCity);
  React.useEffect(() => { setCityId(initialCity); }, [initialCity]);
  const city = cityById(cityId);
  const choose = (id: string | null) => {
    setCityId(id);
    router.replace(id ? `${pathname}?city=${encodeURIComponent(id)}` : pathname, { scroll: false });
  };
  const forumCount = city ? forumsForCity(city.id).length : 0;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageTopbar icon={<Landmark />} title="Courts & forums" context={city ? `${city.name} · ${stateName(city.state)} · ${forumCount} forums` : "Official websites, e-filing, cause lists and local law by city"}>
        <div className="flex-1" />
        <CityPicker value={cityId ?? ""} onChange={choose} />
      </PageTopbar>
      <div className="flex min-h-0 flex-1">
        <nav aria-label="Cities" className="hidden w-48 shrink-0 overflow-y-auto border-r py-2 md:block">
          <ul>
            {CITIES.map((c) => (
              <li key={c.id}>
                <button type="button" onClick={() => choose(c.id)} aria-current={c.id === cityId ? "page" : undefined}
                  className={cn("flex w-full items-baseline justify-between gap-2 px-3 py-1 text-left text-[12.5px] hover:bg-accent focus-visible:bg-accent focus-visible:outline-none", c.id === cityId && "bg-accent font-medium")}>
                  <span className="truncate">{c.name}</span><span className="shrink-0 text-[10.5px] text-muted-foreground">{c.state}</span>
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <main className="min-w-0 flex-1 overflow-y-auto">
          {unknownCity && !city && (
            <div className="mx-auto max-w-5xl px-4 pt-4">
              <div className="flex items-center gap-2 rounded-md border px-3 py-2 text-[12px]" role="alert">
                <AlertTriangle className="size-3.5 text-warning" aria-hidden />
                <span>No city called “{unknownCity.slice(0, 40)}” is recorded. Choose one of the listed cities.</span>
              </div>
            </div>
          )}
          {!city ? (
            <div className="mx-auto max-w-5xl px-4 py-6">
              <EmptyState icon={MapPin} title="Choose a city" description="See which courts and tribunals sit there, their official e-filing, cause-list and case-status pages, and the State statutes litigators commonly need." />
              <ul className="mt-2 grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-4">
                {CITIES.map((c) => (
                  <li key={c.id}>
                    <button type="button" onClick={() => choose(c.id)} className="flex w-full items-baseline justify-between gap-2 rounded-md border px-3 py-2 text-left text-[12.5px] hover:bg-accent focus-visible:bg-accent focus-visible:outline-none">
                      <span className="truncate">{c.name}</span><span className="shrink-0 text-[10.5px] text-muted-foreground">{stateName(c.state)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="mx-auto grid max-w-6xl gap-4 px-4 py-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
              <div className="min-w-0">
                <CityForums city={city} />
                <p className="mt-3 text-[10.5px] text-muted-foreground">Details are as shown on the official sources on {fmtChecked(FORUM_CHECKED_AT)}. Designations, benches and links change by notification; confirm on the official page before filing.</p>
              </div>
              <div className="min-w-0 lg:sticky lg:top-0 lg:self-start">
                <LocalLawPanel city={city} />
                <p className="mt-2 text-[10.5px] text-muted-foreground">
                  Matters can record this city: <Link href="/matters" className="underline-offset-2 hover:underline">open Matters</Link>.
                </p>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
