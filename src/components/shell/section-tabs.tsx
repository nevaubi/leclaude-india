"use client";
import * as React from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";
import { isHrefActive, isTabActive, type NavChild, type NavItem, type NavTab } from "./nav";

/** True on pages that show a section tab bar, so page chrome can drop a title the active tab already states. */
const InTabbedSection = React.createContext(false);
export const InTabbedSectionProvider = InTabbedSection.Provider;
export function useInTabbedSection(): boolean {
  return React.useContext(InTabbedSection);
}

/** Roving focus between the bar's links with the arrow keys (mirrored in RTL), Home and End. */
function onArrowKeys(e: React.KeyboardEvent<HTMLElement>) {
  const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
  if (!keys.includes(e.key)) return;
  const links = Array.from(e.currentTarget.querySelectorAll<HTMLAnchorElement>("a[href]"));
  const i = links.indexOf(document.activeElement as HTMLAnchorElement);
  if (i < 0) return;
  const rtl = getComputedStyle(e.currentTarget).direction === "rtl";
  const step = e.key === "ArrowRight" ? (rtl ? -1 : 1) : e.key === "ArrowLeft" ? (rtl ? 1 : -1) : 0;
  const next = e.key === "Home" ? 0 : e.key === "End" ? links.length - 1 : (i + step + links.length) % links.length;
  e.preventDefault();
  links[next]?.focus();
}

/**
 * A section's pages as one compact, URL-driven tab row (Matters · Diary · Documents). Tabs are links, so the
 * browser history, middle-click and deep links all work; the current one carries aria-current. A tab with a
 * switch (Courts & judges) shows the switch beside it while it is current. Scrolls horizontally when narrow.
 */
export function SectionTabs({ section, tabs, pathname, className }: { section: NavItem; tabs: NavTab[]; pathname: string; className?: string }) {
  const t = useT();
  const ref = React.useRef<HTMLElement>(null);
  const label = (n: Pick<NavChild, "label" | "labelKey">) => (n.labelKey ? t(n.labelKey) : n.label);

  // Keep the current tab in view on narrow screens without scrolling the page itself.
  React.useEffect(() => {
    const nav = ref.current;
    const cur = nav?.querySelector<HTMLElement>("[data-current]");
    if (!nav || !cur) return;
    // The current tab and its switch (when it has one) are brought into view together, the tab's start first.
    const end = nav.querySelector<HTMLElement>("[data-current-switch]") ?? cur;
    const n = nav.getBoundingClientRect();
    const left = cur.getBoundingClientRect().left;
    const right = end.getBoundingClientRect().right;
    if (left < n.left) nav.scrollLeft -= n.left - left + 8;
    else if (right > n.right) nav.scrollLeft += Math.min(right - n.right + 8, left - n.left - 8);
  }, [pathname]);

  return (
    <nav
      ref={ref}
      aria-label={label(section)}
      onKeyDown={onArrowKeys}
      className={cn("flex min-w-0 items-center gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden", className)}
    >
      {tabs.map((tab) => {
        const active = isTabActive(tab, pathname);
        const sub = active ? tab.sub ?? [] : [];
        return (
          <React.Fragment key={tab.href}>
            <Link
              href={tab.href}
              data-current={active || undefined}
              aria-current={active ? (sub.length ? "location" : "page") : undefined}
              className={cn(
                "inline-flex h-7 shrink-0 items-center whitespace-nowrap rounded-md px-2.5 text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                active ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
              )}
            >
              {label(tab)}
            </Link>
            {sub.length > 1 && (
              <span role="group" data-current-switch aria-label={label(tab)} className="ms-0.5 inline-flex h-7 shrink-0 items-center gap-0.5 rounded-md border p-0.5">
                {sub.map((c) => {
                  const on = isHrefActive(c.href, pathname);
                  return (
                    <Link
                      key={c.href}
                      href={c.href}
                      aria-current={on ? "page" : undefined}
                      className={cn(
                        "inline-flex h-[22px] shrink-0 items-center whitespace-nowrap rounded px-2 text-[12px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                        on ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {label(c)}
                    </Link>
                  );
                })}
              </span>
            )}
          </React.Fragment>
        );
      })}
    </nav>
  );
}
