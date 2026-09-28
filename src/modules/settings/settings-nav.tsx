"use client";
import * as React from "react";
import { useT } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import { ALL_SETTINGS_GROUPS, SETTINGS_GROUPS, WORKSPACE_GROUPS, sectionForHash, type SettingsGroup } from "./settings-groups";

export { SETTINGS_GROUPS } from "./settings-groups";

/** Left navigation for the Settings sections; follows the hash and the scroll position. Plain text, no icons. */
export function SettingsNav({ className }: { className?: string }) {
  const t = useT();
  const [active, setActive] = React.useState<string>("workspace");
  const lockUntil = React.useRef(0);
  React.useEffect(() => {
    // A hash (from a link like /settings#review) decides the section; the observer takes over once the user scrolls.
    const fromHash = () => { const id = sectionForHash(window.location.hash); if (id) { setActive(id); lockUntil.current = Date.now() + 1500; } };
    fromHash();
    window.addEventListener("hashchange", fromHash);
    const sections = ALL_SETTINGS_GROUPS.map((g) => document.getElementById(`group-${g.id}`)).filter(Boolean) as HTMLElement[];
    const io = new IntersectionObserver((entries) => { if (Date.now() < lockUntil.current) return; const vis = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0]; if (vis) setActive(vis.target.id.replace("group-", "")); }, { rootMargin: "-10% 0px -70% 0px" });
    sections.forEach((s) => io.observe(s));
    return () => { window.removeEventListener("hashchange", fromHash); io.disconnect(); };
  }, []);
  const link = (g: SettingsGroup) => (
    <a key={g.id} href={`#${g.id}`} onClick={() => setActive(g.id)} className={cn("flex h-7 shrink-0 items-center rounded-md px-2 text-[12.5px] transition-colors", active === g.id ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground")} aria-current={active === g.id ? "true" : undefined}>
      {t(g.labelKey)}
    </a>
  );
  return (
    <nav className={cn("flex gap-0.5 overflow-x-auto no-scrollbar md:flex-col", className)} aria-label={t("settings.sectionsAria")}>
      {WORKSPACE_GROUPS.map(link)}
      <div className="hidden h-3 md:block" aria-hidden />
      {SETTINGS_GROUPS.map(link)}
    </nav>
  );
}
