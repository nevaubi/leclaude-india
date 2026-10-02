"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator, CommandShortcut } from "@/components/ui/command";
import { NAV, SECONDARY_NAV, navDestinations } from "./nav";
import { useShellStore } from "./shell-store";
import { useTheme } from "./theme-provider";
import { useShortcutHelp } from "@/components/ui/shortcut-help";
import { FilePlus2, FileSpreadsheet, Presentation, FileType, Briefcase, FileText, Users, Calendar, ListTodo, Workflow, Sun, Moon, Monitor, ShieldCheck, ShieldAlert, PanelLeft, Search, Radar, Keyboard, Settings, Database, Languages, type LucideIcon } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { debounce } from "@/lib/utils";
import { groupHits, paletteSections, type PaletteCommand, type PaletteIcon, type QuickSearchHit } from "./palette-groups";

export { groupHits, paletteSections, type QuickSearchHit };

const KIND_ICON = { matter: Briefcase, document: FileText, person: Users, task: ListTodo, event: Calendar, workflow: Workflow, library: FileText, office: FileText } as const;
const ICONS: Record<PaletteIcon, LucideIcon> = { doc: FilePlus2, sheet: FileSpreadsheet, deck: Presentation, pdf: FileType, search: Search, radar: Radar, shield: ShieldCheck, "shield-alert": ShieldAlert, sun: Sun, moon: Moon, monitor: Monitor, panel: PanelLeft, keyboard: Keyboard, settings: Settings, database: Database, globe: Languages };

export function CommandPalette() {
  const router = useRouter();
  const { paletteOpen, setPaletteOpen, toggleSidebar } = useShellStore();
  const { setTheme } = useTheme();
  const help = useShortcutHelp(undefined);
  const t = useT();
  const [query, setQuery] = React.useState("");
  const [hits, setHits] = React.useState<QuickSearchHit[]>([]);
  const [loading, setLoading] = React.useState(false);

  const search = React.useMemo(
    () =>
      debounce(async (q: string) => {
        if (!q.trim()) { setHits([]); return; }
        setLoading(true);
        try {
          const res = await fetch(`/api/quick-search?q=${encodeURIComponent(q)}`);
          if (res.ok) setHits(((await res.json()) as { hits: QuickSearchHit[] }).hits ?? []);
        } catch { /* offline */ } finally { setLoading(false); }
      }, 120),
    [],
  );

  React.useEffect(() => { search(query); }, [query, search]);
  React.useEffect(() => { if (!paletteOpen) { setQuery(""); setHits([]); } }, [paletteOpen]);

  const go = (href: string) => { setPaletteOpen(false); router.push(href); };
  const run = (c: PaletteCommand) => {
    if (c.href) { go(c.href); return; }
    setPaletteOpen(false);
    switch (c.action) {
      case "theme:light": setTheme("light"); break;
      case "theme:dark": setTheme("dark"); break;
      case "theme:system": setTheme("system"); break;
      case "toggle-sidebar": toggleSidebar(); break;
      case "shortcuts": setTimeout(() => help.open(), 50); break;
      default: break;
    }
  };
  const groups = groupHits(hits);
  // Groups (Law) are listed by their pages, so "Statutes" or "Judges" is one keystroke away.
  const nav = navDestinations([...NAV, ...SECONDARY_NAV]);
  const sections = paletteSections({ query, nav });
  const navIcon = (href: string) => nav.find((n) => n.href === href)?.icon;

  return (
    <CommandDialog open={paletteOpen} onOpenChange={setPaletteOpen} title={t("ui.commandPalette")}>
      <CommandInput placeholder={t("palette.placeholder")} value={query} onValueChange={setQuery} />
      <CommandList>
        <CommandEmpty>{loading ? t("common.searching") : t("common.noResults")}</CommandEmpty>
        {groups.map((g) => (
          <CommandGroup key={g.kind} heading={t(`palette.kind.${g.kind}`, { count: g.hits.length })}>
            {g.hits.map((h) => { const Icon = KIND_ICON[h.kind] ?? FileText; return (
              <CommandItem key={`${h.kind}:${h.id}`} value={`${h.title} ${h.subtitle ?? ""} ${h.kind}`} onSelect={() => go(h.href)}>
                <Icon className="text-muted-foreground" />
                <span className="truncate">{h.title}</span>
                {h.subtitle && <span className="ml-2 truncate text-[11px] text-muted-foreground">{h.subtitle}</span>}
              </CommandItem>
            ); })}
          </CommandGroup>
        ))}
        {sections.map((s, i) => (
          <React.Fragment key={s.id}>
            {(i > 0 || groups.length > 0) && <CommandSeparator />}
            <CommandGroup heading={t(s.headingKey)}>
              {s.commands.map((c) => {
                const Icon = (s.id === "go" && c.href ? navIcon(c.href) : undefined) ?? ICONS[c.icon];
                const label = c.labelKey ? t(c.labelKey, c.labelVars) : c.label;
                return (
                  // The value keeps the English label and keywords so typing English still finds a translated command.
                  <CommandItem key={c.id} value={`${label} ${c.label} ${c.keywords ?? ""} ${t(s.headingKey)}`} onSelect={() => run(c)}>
                    <Icon className="text-muted-foreground" />
                    <span className="truncate">{label}</span>
                    {c.shortcut && <CommandShortcut>{c.shortcut}</CommandShortcut>}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </React.Fragment>
        ))}
      </CommandList>
    </CommandDialog>
  );
}
