"use client";
import * as React from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Check, ChevronLeft, ChevronRight, Moon, Search, Sun, Monitor, Menu, X, LogOut, Keyboard } from "lucide-react";
import { cn } from "@/lib/utils";
import { GO_CHORD, NAV, SECONDARY_NAV } from "./nav";
import { useShellStore } from "./shell-store";
import { useTheme } from "./theme-provider";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tooltip";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { PersonAvatar } from "@/components/ui/avatar";
import { ShortcutHelpProvider, useShortcutHelp } from "@/components/ui/shortcut-help";
import { CommandPalette } from "./command-palette";
import { BrandMark, BrandLockup } from "@/components/brand/logo";
import { DEFAULT_USER } from "@/lib/current-user";
import { useT } from "@/lib/i18n/client";
import { LocaleMenu } from "./locale-switcher";

export interface ShellUser { id: string; name: string; role?: string; email?: string }

/** Neutral placeholder only; the layout always passes the workspace owner. */
const DEFAULT_SHELL_USER: ShellUser = { ...DEFAULT_USER };

/**
 * Application shell: a slim icon rail (expandable to labels), a 44px top bar
 * that pages fill through <TopbarSlot>, the ⌘K palette and the `?` shortcut
 * help. Designed around a litigator's day: one glance to orient, one key to move.
 */
export function AppShell({ children, appName, firmName, user }: { children: React.ReactNode; appName: string; firmName: string; user?: ShellUser }) {
  return (
    <ShortcutHelpProvider>
      <ShellFrame appName={appName} firmName={firmName} user={user ?? DEFAULT_SHELL_USER}>{children}</ShellFrame>
    </ShortcutHelpProvider>
  );
}

function ShellFrame({ children, appName, firmName, user }: { children: React.ReactNode; appName: string; firmName: string; user: ShellUser }) {
  const pathname = usePathname();
  const router = useRouter();
  const { sidebarCollapsed, toggleSidebar, setPaletteOpen } = useShellStore();
  const help = useShortcutHelp(undefined);
  const t = useT();
  const [hydrated, setHydrated] = React.useState(false);
  const [mobileOpen, setMobileOpen] = React.useState(false);
  React.useEffect(() => setHydrated(true), []);
  React.useEffect(() => { setMobileOpen(false); }, [pathname]);

  React.useEffect(() => {
    let chord: string | null = null;
    let chordTimer: ReturnType<typeof setTimeout> | undefined;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable);
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        if (target?.isContentEditable) return;
        e.preventDefault();
        setPaletteOpen(true);
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (chord === "g") {
        const dest = GO_CHORD[e.key.toLowerCase()];
        chord = null;
        if (dest) { e.preventDefault(); router.push(dest); }
        return;
      }
      if (e.key.toLowerCase() === "g") {
        chord = "g";
        clearTimeout(chordTimer);
        chordTimer = setTimeout(() => (chord = null), 900);
      }
      // "[" toggles the rail only on pages that do not claim it for their own left panel.
      if (e.key === "[" && !typing && !document.querySelector("[data-owns-bracket-left]")) { e.preventDefault(); toggleSidebar(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router, setPaletteOpen, toggleSidebar]);

  // Icon rail is the default; labels expand on demand ("[" or the chevron).
  const expanded = hydrated && !sidebarCollapsed;
  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));

  const railItem = (item: (typeof NAV)[number]) => {
    const active = isActive(item.href);
    const label = item.labelKey ? t(item.labelKey) : item.label;
    const link = (
      <Link
        href={item.href}
        aria-label={label}
        aria-current={active ? "page" : undefined}
        className={cn(
          "group relative flex items-center rounded-md text-[12.5px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
          expanded ? "gap-2.5 px-2.5 py-1.5" : "size-9 justify-center",
          active ? "bg-primary/8 text-primary dark:bg-primary/12" : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground",
        )}
      >
        <item.icon className={cn("size-[17px] shrink-0", active ? "text-primary" : "")} strokeWidth={active ? 2 : 1.75} />
        {expanded && <span className="flex-1 truncate">{label}</span>}
        {expanded && item.shortcut && <span className="text-[10px] tabular text-muted-foreground/70 opacity-0 transition-opacity group-hover:opacity-100">{item.shortcut}</span>}
      </Link>
    );
    return expanded ? <div key={item.href}>{link}</div> : <Tip key={item.href} label={label} side="right" shortcut={item.shortcut}>{link}</Tip>;
  };

  return (
    <div className="flex h-full w-full overflow-hidden">
      {mobileOpen && <button aria-label={t("shell.closeNav")} className="fixed inset-0 z-40 bg-black/40 md:hidden" onClick={() => setMobileOpen(false)} />}
      <aside
        className={cn(
          "h-full shrink-0 flex-col border-e border-sidebar-border bg-sidebar text-sidebar-foreground transition-[width] duration-150",
          expanded ? "md:w-[220px]" : "md:w-[68px]",
          "fixed inset-y-0 start-0 z-50 w-[248px] md:static md:z-auto md:flex",
          mobileOpen ? "flex shadow-2xl" : "hidden",
        )}
      >
        <div className={cn("flex h-11 items-center border-b border-sidebar-border", expanded ? "px-3" : "justify-center px-0")}>
          <Link href="/" className="flex min-w-0 items-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50" aria-label={t("brand.homeAria", { app: appName })}>
            {expanded || mobileOpen ? <BrandLockup firmName={firmName} /> : <BrandMark size={26} />}
          </Link>
        </div>

        <div className={cn("pt-2", expanded ? "px-3" : "px-0 flex justify-center")}>
          <Tip label={t("shell.searchOrJump")} side="right" shortcut="⌘K">
            <button
              onClick={() => setPaletteOpen(true)}
              aria-label={t("shell.searchOrJump")}
              className={cn(
                "flex items-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                expanded && "border",
                expanded ? "h-8 w-full gap-2 px-2.5 text-[12px]" : "size-9 justify-center",
              )}
            >
              <Search className="size-4 shrink-0" strokeWidth={1.75} />
              {expanded && (<><span className="flex-1 truncate text-start">{t("shell.searchOrJumpShort")}</span><kbd className="hidden sm:inline">⌘K</kbd></>)}
            </button>
          </Tip>
        </div>

        <nav className={cn("mt-2 flex flex-1 flex-col gap-0.5 overflow-y-auto no-scrollbar", expanded ? "px-3" : "items-center px-0")} aria-label={t("shell.primaryNav")}>
          {NAV.map(railItem)}
        </nav>

        <div className={cn("flex flex-col gap-0.5 border-t border-sidebar-border py-2", expanded ? "px-3" : "items-center px-0")}>
          {SECONDARY_NAV.map(railItem)}
          <Tip label={expanded ? t("common.collapse") : t("common.expand")} side="right" shortcut="[">
            <button onClick={toggleSidebar} aria-label={expanded ? t("shell.collapseNav") : t("shell.expandNav")} className={cn("flex items-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-foreground cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50", expanded ? "gap-2.5 px-2.5 py-1.5 text-[12.5px]" : "size-9 justify-center")}>
              {expanded ? <><ChevronLeft className="size-[17px] rtl:rotate-180" /> {t("common.collapse")}</> : <ChevronRight className="size-[17px] rtl:rotate-180" />}
            </button>
          </Tip>
          {expanded && (
            <button aria-label={t("shell.signOut")} className="flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[12.5px] text-muted-foreground/70 hover:bg-sidebar-accent hover:text-foreground" disabled>
              <LogOut className="size-[17px] rtl:-scale-x-100" /> {t("shell.signOut")}
            </button>
          )}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-11 shrink-0 items-center gap-2 border-b bg-background px-3" style={{ height: "var(--topbar-height)" }}>
          <Button variant="ghost" size="icon-xs" className="md:hidden" aria-label={t("shell.openNav")} onClick={() => setMobileOpen((o) => !o)}>{mobileOpen ? <X className="size-4" /> : <Menu className="size-4" />}</Button>
          <div className="min-w-0 flex-1" id="topbar-slot" />
          <div className="flex items-center gap-2">
            <AiStatus />
            <ReviewQueueIndicator />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="ms-0.5 rounded-full ring-offset-background focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 cursor-pointer" aria-label={t("shell.accountMenu")}><PersonAvatar name={user.name} size="sm" /></button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-60">
                <DropdownMenuLabel className="font-normal">
                  <div className="text-[13px] font-medium text-foreground">{user.name}</div>
                  <div className="text-[11.5px]">{[user.role, firmName].filter(Boolean).join(" · ")}</div>
                  {user.email && <div className="text-[11.5px] text-muted-foreground">{user.email}</div>}
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild><Link href="/settings">{t("shell.menu.settings")}</Link></DropdownMenuItem>
                <DropdownMenuItem asChild><Link href="/settings#language">{t("shell.menu.language")}</Link></DropdownMenuItem>
                <DropdownMenuItem asChild><Link href="/settings#ai">{t("shell.menu.ai")}</Link></DropdownMenuItem>
                <DropdownMenuItem asChild><Link href="/settings#data">{t("shell.menu.data")}</Link></DropdownMenuItem>
                <DropdownMenuItem asChild><Link href="/settings#review">{t("shell.menu.review")}</Link></DropdownMenuItem>
                <DropdownMenuItem onClick={() => setTimeout(() => help.open(), 50)}><Keyboard /> {t("shell.menu.shortcuts")}<DropdownMenuShortcut>?</DropdownMenuShortcut></DropdownMenuItem>
                <DropdownMenuSeparator />
                <LocaleMenu />
                <DropdownMenuSeparator />
                <ThemeItems />
                <DropdownMenuSeparator />
                <DropdownMenuItem disabled>{t("shell.signOut")}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>
        <main className="min-h-0 flex-1 overflow-hidden">{children}</main>
      </div>
      <CommandPalette />
    </div>
  );
}

/** AI availability: nothing when configured; a dot and "AI off · add key" when it needs setup. */
function AiStatus() {
  const t = useT();
  const [status, setStatus] = React.useState<{ configured: boolean; model: string } | null>(null);
  React.useEffect(() => {
    let alive = true;
    fetch("/api/ai/status").then((r) => (r.ok ? r.json() : null)).then((j) => { if (alive && j) setStatus({ configured: Boolean(j.configured), model: String(j.model ?? "") }); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  // Quiet when healthy: the top bar only speaks up when AI needs configuring.
  if (!status || status.configured) return null;
  return (
    <Tip label={t("shell.aiOffTip")}><Link href="/settings#ai" className="hidden h-7 items-center gap-1.5 rounded px-1.5 text-[11px] text-muted-foreground hover:text-foreground md:inline-flex" aria-label={t("shell.aiOff")}><span className="size-1.5 rounded-full bg-warning" aria-hidden /> {t("shell.aiOff")}</Link></Tip>
  );
}

/** Pending AI records awaiting a human decision, as text and a dot; hidden when none or when the endpoint is unavailable. */
function ReviewQueueIndicator() {
  const t = useT();
  const pathname = usePathname();
  const [pending, setPending] = React.useState<number | null>(null);
  React.useEffect(() => {
    let alive = true;
    // Counts only: the review endpoint is far lighter than shipping the whole last scan report on every navigation.
    fetch("/api/integrity/review?limit=1").then((r) => (r.ok ? r.json() : null)).then((j) => { if (alive && j?.counts) setPending(Number(j.counts.pending ?? 0)); }).catch(() => {});
    return () => { alive = false; };
  }, [pathname]);
  if (!pending) return null;
  return (
    <Tip label={t("shell.reviewPendingTip", { count: pending })}>
      <Link href="/settings#review" className="hidden h-7 items-center gap-1.5 rounded px-1.5 text-[11px] text-muted-foreground hover:text-foreground md:inline-flex" aria-label={t("shell.reviewQueue")}><span className="size-1.5 rounded-full bg-warning" aria-hidden /> <span className="tabular">{pending}</span> {t("shell.toReview")}</Link>
    </Tip>
  );
}

/** Theme choice lives in the account menu so the top bar keeps one control per job. */
function ThemeItems() {
  const { theme, setTheme } = useTheme();
  const t = useT();
  const item = (value: "light" | "dark" | "system", label: string, Icon: typeof Sun) => (
    <DropdownMenuItem onSelect={(e) => { e.preventDefault(); setTheme(value); }} aria-checked={theme === value} role="menuitemradio">
      <Icon /> {label}{theme === value && <Check className="ms-auto size-3.5 text-muted-foreground" />}
    </DropdownMenuItem>
  );
  return (
    <>
      <DropdownMenuLabel className="py-1 text-[11px] font-normal text-muted-foreground">{t("shell.theme")}</DropdownMenuLabel>
      {item("light", t("shell.theme.light"), Sun)}
      {item("dark", t("shell.theme.dark"), Moon)}
      {item("system", t("shell.theme.system"), Monitor)}
    </>
  );
}

/** Portal a page's own header content into the top bar. */
export function TopbarSlot({ children }: { children: React.ReactNode }) {
  const [el, setEl] = React.useState<HTMLElement | null>(null);
  React.useEffect(() => setEl(document.getElementById("topbar-slot")), []);
  if (!el) return null;
  return createPortal(<div className="flex min-w-0 items-center gap-2 text-[13px]">{children}</div>, el);
}
