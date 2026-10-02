"use client";
import * as React from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { exactCentralAct } from "@/modules/law/reader";
import { lawHref } from "@/modules/law/shared";
import { ArrowRight, Search, X } from "lucide-react";
import { Kbd, Spinner } from "@/components/ui/misc";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";
import { areaOfPath, routeLawQuery, type LawArea, type LawScope } from "./law-intent";
import { loadVisuals } from "@/modules/media/use-visuals";

/**
 * The Law area header shared by Case law, Statutes, Courts and Judges: a compact row with the area tabs and one search
 * box that routes by what the query looks like (citation → case law, "s. 303 BNS" → that section, a judge → judges,
 * a city → its courts), with a small scope switch. On the four start pages a second quiet line carries the page's
 * coverage counts and its attribution, which the page supplies through <LawHubMeta>.
 */

/** Same labels and i18n keys as the rail's Law children (src/components/shell/nav.ts). */
const TABS = [
  { area: "cases", labelKey: "nav.caselaw", href: "/cases" },
  { area: "law", labelKey: "nav.statutes", href: "/law" },
  { area: "courts", labelKey: "nav.courts", href: "/courts" },
  { area: "judges", labelKey: "nav.judges", href: "/judges" },
] as const satisfies readonly { area: LawArea; labelKey: string; href: string }[];

const SCOPES: { value: LawScope; label: string }[] = [
  { value: "auto", label: "All" },
  { value: "cases", label: "Case law" },
  { value: "law", label: "Acts" },
  { value: "provisions", label: "Provisions" },
  { value: "judges", label: "Judges" },
  { value: "courts", label: "Courts" },
];

const LANDINGS = new Set(["/cases", "/law", "/courts", "/judges"]);

const MetaContext = React.createContext<HTMLElement | null>(null);

/** Content for the hub's quiet line (counts, freshness, attribution). Rendered only on the area start pages. */
export function LawHubMeta({ children }: { children: React.ReactNode }) {
  const node = React.useContext(MetaContext);
  return node ? createPortal(children, node) : null;
}

/** Resolve "Act title" to an instrument id by exact title (the statutes API), or null. Never a similar Act. */
async function resolveActId(title: string, signal: AbortSignal): Promise<string | null> {
  const res = await fetch(`/api/law?q=${encodeURIComponent(title)}&j=central&status=all&limit=5`, { signal, headers: { accept: "application/json" } });
  if (!res.ok) return null;
  const body = (await res.json().catch(() => null)) as { hits?: { id: string; title: string; year: number | null; jurisdiction: string }[] } | null;
  return exactCentralAct(title, body?.hits ?? [])?.id ?? null;
}

/** Statutes in Sections mode default the scope to provisions (kept apart so the hub needs no Suspense boundary). */
function ModeSync({ onChange }: { onChange: (sections: boolean) => void }) {
  const sp = useSearchParams();
  const sections = sp.get("mode") === "sections";
  React.useEffect(() => { onChange(sections); }, [sections, onChange]);
  return null;
}

export function LawHub({ children }: { children: React.ReactNode }) {
  // Start loading the photo library with the header, not when the first card mounts (cards wait for court statistics).
  React.useEffect(() => { loadVisuals().catch(() => {}); }, []);
  const pathname = usePathname();
  const router = useRouter();
  const t = useT();
  const area = areaOfPath(pathname);
  const landing = LANDINGS.has(pathname ?? "");
  const [meta, setMeta] = React.useState<HTMLElement | null>(null);

  const [sectionsMode, setSectionsMode] = React.useState(false);
  const defaultScope: LawScope = area === "law" && sectionsMode ? "provisions" : "auto";
  const [scope, setScope] = React.useState<LawScope>(defaultScope);
  React.useEffect(() => { setScope(defaultScope); }, [defaultScope]);
  const [q, setQ] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const abort = React.useRef<AbortController | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  // "/" focuses the hub search unless the page has already handled it (its own search box).
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t?.isContentEditable) return;
      e.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  React.useEffect(() => () => abort.current?.abort(), []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const route = routeLawQuery(q, scope, area);
    if (!route) return;
    abort.current?.abort();
    if (route.kind === "href") { router.push(route.href); return; }
    const ac = new AbortController();
    abort.current = ac;
    setBusy(true);
    try {
      const id = await resolveActId(route.actTitle, ac.signal);
      if (ac.signal.aborted) return;
      router.push(id ? lawHref(id, route.section) : route.fallback);
    } catch (err) {
      if ((err as Error).name !== "AbortError") router.push(route.fallback);
    } finally {
      if (!ac.signal.aborted) setBusy(false);
    }
  };

  const placeholder = area === "law" ? "Act or section, e.g. s. 303 BNS" : area === "judges" ? "Judge, citation, Act or city" : area === "courts" ? "City, citation, Act or judge" : "Citation, parties, s. 303 BNS, judge, city";

  return (
    <MetaContext.Provider value={meta}>
      <div className="flex h-full min-h-0 flex-col">
        <React.Suspense fallback={null}><ModeSync onChange={setSectionsMode} /></React.Suspense>
        <header className="shrink-0 border-b bg-background">
          {landing ? <h1 className="sr-only">{t(TABS.find((x) => x.area === area)?.labelKey ?? "nav.caselaw")}</h1> : null}
          <div className="flex h-11 items-center gap-3 px-4 sm:px-6">
            <nav aria-label="Law" className="flex min-w-0 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]">
              {TABS.map((tab) => {
                const active = tab.area === area;
                return (
                  <Link
                    key={tab.area}
                    href={tab.href}
                    aria-current={active ? (landing ? "page" : "location") : undefined}
                    className={cn(
                      "inline-flex h-7 shrink-0 items-center rounded-md px-2.5 text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                      active ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                    )}
                  >
                    {t(tab.labelKey)}
                  </Link>
                );
              })}
            </nav>
            <form role="search" aria-label="Search the law" onSubmit={submit} className="ml-auto flex min-w-0 max-w-[460px] flex-1 items-center justify-end">
              <div className="flex h-8 w-full min-w-0 items-center rounded-md border bg-background shadow-[0_1px_0_0_var(--line-quiet)] focus-within:border-ring/60 focus-within:ring-2 focus-within:ring-ring/25">
                <Search className="ml-2.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <input
                  ref={inputRef}
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Escape" && q) { e.preventDefault(); setQ(""); } }}
                  placeholder={placeholder}
                  aria-label="Search the law"
                  maxLength={200}
                  className="h-full min-w-0 flex-1 bg-transparent px-2 text-[12.5px] outline-none placeholder:text-muted-foreground/80"
                />
                {busy ? <Spinner size={12} className="mr-1.5" /> : q ? (
                  <button type="button" aria-label="Clear" onClick={() => setQ("")} className="mr-1 rounded p-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"><X className="size-3.5" /></button>
                ) : <Kbd className="mr-1.5 hidden rounded border px-1 text-[10px] text-muted-foreground md:inline-flex">/</Kbd>}
                <span aria-hidden className="h-4 w-px shrink-0 bg-border" />
                <Select value={scope} onValueChange={(v) => setScope(v as LawScope)}>
                  <SelectTrigger size="xs" aria-label="Search in" className="h-7 w-auto shrink-0 gap-1 border-0 bg-transparent px-2 text-[11.5px] text-muted-foreground shadow-none hover:text-foreground focus-visible:ring-inset">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent align="end">
                    {SCOPES.map((s) => <SelectItem key={s.value} value={s.value}>{s.value === "auto" ? "All of Law" : s.label}</SelectItem>)}
                  </SelectContent>
                </Select>
                <button type="submit" aria-label="Search" disabled={!q.trim() || busy} className="mr-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-40">
                  <ArrowRight className="size-3.5" />
                </button>
              </div>
            </form>
          </div>
          {landing ? <div ref={setMeta} className="flex min-h-7 flex-wrap items-center gap-x-1.5 gap-y-0.5 px-4 pb-2 text-[11.5px] text-muted-foreground empty:hidden sm:px-6" /> : null}
        </header>
        <div className="relative min-h-0 flex-1">{children}</div>
      </div>
    </MetaContext.Provider>
  );
}
