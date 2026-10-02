"use client";
import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { AlertTriangle, ArrowLeft, BookOpen, CalendarDays, ExternalLink, FileUp, Gavel, Globe, Landmark, ListChecks, MapPin, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { LawHubMeta } from "@/components/corpus/law-hub";
import { PhotoBackdrop, TypeTile, VisualImage } from "@/components/corpus/visual-image";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/misc";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { courtById } from "@/lib/india/courts";
import { CITIES, FORUM_CHECKED_AT, FORUM_KIND_ORDER, cityById, forumsForCity, highCourtForumFor, stateName, type City, type Forum, type ForumKind } from "@/lib/india/forums";
import { cityVisual, courtVisual, useVisuals } from "@/modules/media/use-visuals";
import { courtPlace } from "@/modules/caselaw/components/court-visuals";
import { LocalLawList, useLocalLaw } from "./local-law-list";

export const KIND_LABEL: Record<ForumKind, string> = {
  high_court: "High Court", bench: "High Court bench", district: "District courts", city_civil: "City civil courts", sessions: "Sessions courts",
  commercial: "Commercial courts", small_causes: "Small causes courts", family: "Family courts", magistrate: "Magistrates' courts",
  nclt: "Company Law Tribunal (NCLT)", nclat: "Company Law Appellate Tribunal (NCLAT)", drt: "Debts Recovery Tribunal", drat: "Debts Recovery Appellate Tribunal",
  consumer_national: "National Consumer Commission", consumer_state: "State Consumer Commission", consumer_district: "District Consumer Commission",
  rera: "Real Estate Regulatory Authority", rera_appellate: "Real Estate Appellate Tribunal", labour: "Labour courts and tribunals", other: "Other forums",
};

const LINKS: { key: "efiling" | "causeList" | "caseStatus" | "judgments"; label: string; icon: typeof FileUp }[] = [
  { key: "efiling", label: "E-filing", icon: FileUp },
  { key: "causeList", label: "Cause list", icon: CalendarDays },
  { key: "caseStatus", label: "Case status", icon: ListChecks },
  { key: "judgments", label: "Judgments", icon: Gavel },
];

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

/** The official pages of a forum as clear buttons (website first). */
function ForumLinks({ forum, className }: { forum: Forum; className?: string }) {
  const links = LINKS.filter((l) => forum.links?.[l.key]);
  if (!forum.website && !links.length) return null;
  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      {forum.website ? (
        <Button asChild size="xs" variant="outline" className="h-6 gap-1 px-2 text-[11.5px] font-normal">
          <a href={forum.website} target="_blank" rel="noopener noreferrer" title={forum.website}><Globe className="size-3" />{hostOf(forum.website)}</a>
        </Button>
      ) : null}
      {links.map((l) => (
        <Button key={l.key} asChild size="xs" variant="outline" className="h-6 gap-1 px-2 text-[11.5px] font-normal">
          <a href={forum.links![l.key]!} target="_blank" rel="noopener noreferrer"><l.icon className="size-3" />{l.label}<ExternalLink className="size-2.5 opacity-50" /></a>
        </Button>
      ))}
    </div>
  );
}

function Sources({ forum }: { forum: Forum }) {
  if (!forum.sources.length) return null;
  return (
    <ul className="mt-1.5 space-y-0.5" aria-label="Sources">
      {forum.sources.map((s, i) => (
        <li key={`${s.url}-${i}`} className="flex min-w-0 items-baseline gap-1 text-[10.5px] text-muted-foreground">
          <span className="shrink-0">Source:</span>
          <a href={s.url} target="_blank" rel="noopener noreferrer" className="min-w-0 truncate hover:text-foreground hover:underline">{s.title}</a>
          <span className="shrink-0">· {fmtChecked(s.checkedAt)}</span>
        </li>
      ))}
    </ul>
  );
}

function ForumRow({ forum, cityId }: { forum: Forum; cityId: string }) {
  const elsewhere = forum.cityId !== cityId ? cityById(forum.cityId) : null;
  const bench = forum.courtId && forum.benchId ? courtById(forum.courtId)?.benches.find((b) => b.id === forum.benchId) : undefined;
  return (
    <li className="px-4 py-3" id={`forum-${forum.id}`}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-[13px] font-medium">{forum.name}</span>
        {elsewhere ? <span className="text-[11px] text-muted-foreground">sits at {bench?.city ?? elsewhere.name}</span> : null}
      </div>
      {forum.address ? <div className="mt-0.5 flex items-start gap-1 text-[11.5px] text-muted-foreground"><MapPin className="mt-0.5 size-3 shrink-0" aria-hidden />{forum.address}</div> : null}
      {forum.note ? <div className="mt-0.5 text-[11.5px] text-muted-foreground">{forum.note}</div> : null}
      <ForumLinks forum={forum} className="mt-2" />
      <Sources forum={forum} />
    </li>
  );
}

/** The jurisdictional High Court seat or bench, first and prominent, with its building photograph. */
function HighCourtCard({ forum, city }: { forum: Forum; city: City }) {
  const data = useVisuals();
  const court = courtById(forum.courtId);
  const bench = court?.benches.find((b) => b.id === forum.benchId);
  const elsewhere = forum.cityId !== city.id;
  return (
    <section aria-labelledby="hc-card" className="group overflow-hidden rounded-xl border bg-card sm:grid sm:grid-cols-[220px_minmax(0,1fr)]">
      <VisualImage
        visual={courtVisual(data, forum.courtId)}
        pending={!data}
        credit="hover"
        className="aspect-[16/9] sm:aspect-auto sm:h-full sm:min-h-[150px]"
        fallback={<TypeTile title={court?.seat ?? city.name} subtitle="High Court" />}
      />
      <div className="min-w-0 px-4 py-3.5">
        <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">{elsewhere ? "Jurisdictional High Court" : forum.kind === "bench" ? "High Court bench" : "High Court"}</div>
        <h2 id="hc-card" className="mt-1 font-serif text-[19px] leading-snug tracking-[-0.005em]">{forum.name}</h2>
        {elsewhere ? <p className="mt-0.5 text-[12px] text-muted-foreground">{city.name} matters are heard at {bench?.city ?? cityById(forum.cityId)?.name ?? court?.seat}.</p> : null}
        {forum.address ? <div className="mt-1 flex items-start gap-1 text-[11.5px] text-muted-foreground"><MapPin className="mt-0.5 size-3 shrink-0" aria-hidden />{forum.address}</div> : null}
        <ForumLinks forum={forum} className="mt-2.5" />
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11.5px]">
          {forum.courtId ? <Link href={`/cases?court=${encodeURIComponent(forum.courtId)}`} className="inline-flex items-center gap-1 text-foreground/80 underline-offset-2 hover:text-foreground hover:underline"><Search className="size-3" aria-hidden />Decisions of this court</Link> : null}
          {forum.courtId ? <Link href={`/judges?court=${encodeURIComponent(forum.courtId)}`} className="text-foreground/80 underline-offset-2 hover:text-foreground hover:underline">Judges</Link> : null}
        </div>
        <Sources forum={forum} />
      </div>
    </section>
  );
}

function CityForums({ city }: { city: City }) {
  const forums = forumsForCity(city.id);
  const hc = highCourtForumFor(city.id);
  const rest = forums.filter((f) => f !== hc);
  const byKind = FORUM_KIND_ORDER.map((k) => ({ kind: k, items: rest.filter((f) => f.kind === k) })).filter((g) => g.items.length);
  if (!forums.length) return <EmptyState icon={Landmark} title="No forums recorded for this city" description="Only forums confirmed on an official page are listed." />;
  return (
    <div className="space-y-5">
      {hc ? <HighCourtCard forum={hc} city={city} /> : null}
      {byKind.map((g) => (
        <section key={g.kind} aria-labelledby={`kind-${g.kind}`}>
          <h2 id={`kind-${g.kind}`} className="mb-1.5 px-0.5 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">{KIND_LABEL[g.kind]}</h2>
          <ul className="divide-y divide-line-quiet rounded-lg border bg-card">{g.items.map((f) => <ForumRow key={f.id} forum={f} cityId={city.id} />)}</ul>
        </section>
      ))}
    </div>
  );
}

function LocalLawPanel({ city }: { city: City }) {
  const state = useLocalLaw(city.id);
  return (
    <section aria-labelledby="local-law" className="rounded-lg border bg-card">
      <div className="flex items-center gap-1.5 border-b px-3.5 py-2.5">
        <BookOpen className="size-3.5 text-muted-foreground" aria-hidden />
        <h2 id="local-law" className="text-[12.5px] font-semibold">Local law · {stateName(city.state)}</h2>
      </div>
      <div className="px-3.5 py-2.5">
        <p className="mb-2 text-[11px] leading-snug text-muted-foreground">State statutes a litigator here commonly needs. Each title opens that exact Act; a title that cannot be found is marked as not found and is never replaced by a similar Act.</p>
        <LocalLawList state={state} />
      </div>
    </section>
  );
}

function CityPicker({ value, onChange, className }: { value: string; onChange: (id: string | null) => void; className?: string }) {
  return (
    <Select value={value || "__none__"} onValueChange={(v) => onChange(v === "__none__" ? null : v)}>
      <SelectTrigger size="xs" className={cn("w-[12rem] bg-background/80 text-[12px]", className)} aria-label="City"><SelectValue placeholder="Choose a city" /></SelectTrigger>
      <SelectContent>
        <SelectItem value="__none__"><span className="text-muted-foreground">All cities</span></SelectItem>
        {CITIES.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

/** One card per city: landmark photograph, name, State and how many courts and forums are recorded. */
function CityCard({ city, onChoose }: { city: City; onChoose: (id: string) => void }) {
  const data = useVisuals();
  const n = forumsForCity(city.id).length;
  const hc = courtById(city.highCourt.courtId);
  return (
    <a
      href={`/courts?city=${encodeURIComponent(city.id)}`}
      onClick={(e) => { if (!(e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1)) { e.preventDefault(); onChoose(city.id); } }}
      className="group flex h-full flex-col overflow-hidden rounded-lg border bg-card transition-colors hover:border-foreground/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <VisualImage
        visual={cityVisual(data, city.id)}
        pending={!data}
        credit="hover"
        className="aspect-[3/2] w-full"
        imgClassName="transition-[opacity,transform] duration-500 group-hover:scale-[1.02] motion-reduce:transform-none"
        fallback={<TypeTile title={city.name.split(" / ")[0]} subtitle={stateName(city.state)} />}
      />
      <span className="flex flex-1 flex-col px-3 pb-3 pt-2.5">
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 truncate text-[13.5px] font-medium text-foreground">{city.name}</span>
          <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">{stateName(city.state)}</span>
        </span>
        <span className="mt-1 truncate text-[11.5px] text-muted-foreground"><span className="tabular text-foreground/80">{n}</span> courts and forums{hc ? <> · {courtPlace(hc.id)} HC</> : null}</span>
      </span>
    </a>
  );
}

/** /courts?city=<id> — a city gallery; a city page with its High Court, forums by kind with official links, and local law. */
export function CourtsBrowser({ initialCity, unknownCity }: { initialCity: string | null; unknownCity?: string | null }) {
  const router = useRouter();
  const pathname = usePathname();
  const [cityId, setCityId] = React.useState<string | null>(initialCity);
  React.useEffect(() => { setCityId(initialCity); }, [initialCity]);
  const city = cityById(cityId);
  const scroller = React.useRef<HTMLDivElement>(null);
  const choose = (id: string | null) => {
    setCityId(id);
    router.replace(id ? `${pathname}?city=${encodeURIComponent(id)}` : pathname, { scroll: false });
    scroller.current?.scrollTo({ top: 0 });
  };
  const forumCount = city ? forumsForCity(city.id).length : 0;
  const totalForums = React.useMemo(() => new Set(CITIES.flatMap((c) => forumsForCity(c.id).map((f) => f.id))).size, []);

  return (
    <div ref={scroller} className="h-full overflow-y-auto scrollbar-thin">
      <LawHubMeta>
        <span className="tabular"><span className="font-medium text-foreground/85">{CITIES.length}</span> cities</span>
        <span aria-hidden className="text-muted-foreground/50">·</span>
        <span className="tabular">{totalForums} courts and forums</span>
        <span aria-hidden className="text-muted-foreground/50">·</span>
        <span>Official websites, e-filing, cause lists and local law, as shown on official sources on {fmtChecked(FORUM_CHECKED_AT)}</span>
      </LawHubMeta>
      {unknownCity && !city ? (
        <div className="mx-auto max-w-[1180px] px-4 pt-4 sm:px-6">
          <div className="flex items-center gap-2 rounded-md border px-3 py-2 text-[12px]" role="alert">
            <AlertTriangle className="size-3.5 text-warning" aria-hidden />
            <span>No city called “{unknownCity.slice(0, 40)}” is recorded. Choose one of the listed cities.</span>
          </div>
        </div>
      ) : null}
      {!city ? (
        <div className="mx-auto max-w-[1180px] px-4 pb-12 pt-5 sm:px-6">
          <div className="mb-3 flex items-baseline gap-2">
            <h2 className="text-[14px] font-semibold tracking-[-0.01em]">Cities</h2>
            <span className="min-w-0 truncate text-[12px] text-muted-foreground">Courts, tribunals and their official pages, city by city</span>
          </div>
          <ul className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
            {CITIES.map((c) => <li key={c.id}><CityCard city={c} onChoose={choose} /></li>)}
          </ul>
        </div>
      ) : (
        <CityPage city={city} forumCount={forumCount} onChoose={choose} />
      )}
    </div>
  );
}

function CityPage({ city, forumCount, onChoose }: { city: City; forumCount: number; onChoose: (id: string | null) => void }) {
  const data = useVisuals();
  const photo = cityVisual(data, city.id);
  return (
    <div className="mx-auto max-w-[1180px] px-4 pb-12 pt-3 sm:px-6">
      <button type="button" onClick={() => onChoose(null)} className="inline-flex items-center gap-1 rounded text-[12px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
        <ArrowLeft className="size-3.5" aria-hidden />All cities
      </button>
      <header className={cn("relative isolate mt-2 flex flex-wrap items-end justify-between gap-3 overflow-hidden rounded-xl border px-5 pb-5 pt-6 sm:px-6", photo && "min-h-[168px] pb-8")}>
        <PhotoBackdrop visual={photo} />
        <div className="min-w-0">
          <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">{stateName(city.state)}</div>
          <h1 className="mt-1 font-serif text-[30px] leading-none tracking-[-0.015em]">{city.name}</h1>
          <p className="mt-2 text-[12.5px] text-muted-foreground"><span className="tabular text-foreground/85">{forumCount}</span> courts and forums with their official pages{city.aliases.length ? <> · also {city.aliases.slice(0, 2).join(", ")}</> : null}</p>
        </div>
        <CityPicker value={city.id} onChange={onChoose} />
      </header>
      <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0">
          <CityForums city={city} />
          <p className="mt-4 text-[10.5px] text-muted-foreground">Details are as shown on the official sources on {fmtChecked(FORUM_CHECKED_AT)}. Designations, benches and links change by notification; confirm on the official page before filing.</p>
        </div>
        <div className="min-w-0 lg:sticky lg:top-4 lg:self-start">
          <LocalLawPanel city={city} />
          <p className="mt-2 text-[10.5px] text-muted-foreground">
            Matters can record this city: <Link href="/matters" className="underline-offset-2 hover:underline">open Matters</Link>.
          </p>
        </div>
      </div>
    </div>
  );
}
