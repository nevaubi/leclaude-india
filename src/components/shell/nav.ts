import { FEATURES, type FeatureFlags } from "@/lib/features";
import { BookOpen, Home, MessageCircle, Briefcase, Files, Gavel, Landmark, Newspaper, Search, Radar, FileSearch, Workflow, LayoutGrid, Library, Settings, UserRound, FileText, FileSpreadsheet, Presentation, FileType, PenLine, Scale, Calculator, CalendarClock, FileStack, type LucideIcon } from "lucide-react";
import type { MessageKey } from "@/lib/i18n/catalog";

/**
 * `label`/`description` are the English source strings (stable identifiers for tests and docs); the shell renders
 * `labelKey`/`descriptionKey` through the i18n catalogue.
 */
export interface NavChild {
  label: string;
  labelKey?: MessageKey;
  href: string;
  icon?: LucideIcon;
  shortcut?: string;
  description?: string;
  descriptionKey?: MessageKey;
}

export interface NavItem {
  label: string;
  labelKey?: MessageKey;
  /** Where the item leads. A group (an item whose children have their own pages) leads to its first child. */
  href: string;
  icon: LucideIcon;
  shortcut?: string;
  description?: string;
  descriptionKey?: MessageKey;
  /** Sub-pages. Rendered as a disclosure in the expanded sidebar and a flyout from the icon rail when there are two or more. */
  children?: NavChild[];
  /** The section's pages, rendered as tabs at the top of each of them (not in the rail). */
  tabs?: NavTab[];
}

const pathOf = (href: string) => href.split(/[?#]/)[0];

/** Children worth rendering as a group: a single child adds nothing over its parent. */
export const navGroupChildren = (item: Pick<NavItem, "children">): NavChild[] => (item.children && item.children.length > 1 ? item.children : []);

/**
 * A page of a section, shown in the section tab bar at the top of each of its pages. `sub` turns a tab into a
 * two-way switch (Courts & judges: /courts and /judges); `exact` limits the tab (and so the tab bar) to the page
 * itself, so full-screen editors underneath it keep the whole top bar.
 */
export interface NavTab extends NavChild {
  sub?: NavChild[];
  exact?: boolean;
}

/** Courts and judges share one Law tab with a switch between the two directories. */
const COURTS_AND_JUDGES: NavChild[] = [
  { label: "Courts", labelKey: "nav.courts", href: "/courts", icon: Landmark, shortcut: "G K", description: "Courts, tribunals and local law by city: official websites, e-filing, cause lists and case status", descriptionKey: "nav.desc.courts" },
  { label: "Judges", labelKey: "nav.judges", href: "/judges", icon: UserRound, shortcut: "G U", description: "Supreme Court and High Court judges from official rosters, with their judgments in the case law index", descriptionKey: "nav.desc.judges" },
];

/** The Indian law corpus, the practice tools and the legal news, as the tabs of Law. Each page keeps its own G chord. */
const LAW_TABS: NavTab[] = [
  { label: "Case law", labelKey: "nav.caselaw", href: "/cases", icon: Gavel, shortcut: "G J", description: "Supreme Court and High Court judgments: browse, search and trace each record to its source", descriptionKey: "nav.desc.caselaw" },
  { label: "Statutes", labelKey: "nav.statutes", href: "/law", icon: BookOpen, shortcut: "G A", description: "Central and State Acts and regulator regulations: browse, search and read section by section", descriptionKey: "nav.desc.statutes" },
  { label: "Official sources", labelKey: "nav.officialSources", href: "/sources", icon: FileStack, shortcut: "G F", description: "Official cause lists, orders, circulars, notifications and gazettes, as the publisher issued them", descriptionKey: "nav.desc.sources" },
  { label: "Courts & judges", labelKey: "nav.courtsJudges", href: "/courts", icon: Landmark, description: "Courts by city and judges from the official rosters", descriptionKey: "nav.desc.courtsJudges", sub: COURTS_AND_JUDGES },
  { label: "Tools", labelKey: "nav.tools", href: "/tools", icon: Calculator, shortcut: "G T", description: "Limitation, cheque-dishonour and arbitration deadlines, IPC to BNS section converter and court-fee calculator", descriptionKey: "nav.desc.tools" },
  { label: "News", labelKey: "nav.news", href: "/news", icon: Newspaper, shortcut: "G N", description: "Indian legal news headlines from LiveLaw, Bar & Bench and other publishers", descriptionKey: "nav.desc.news" },
];

/**
 * The primary navigation for a set of product switches (pure; `NAV` is this for the build's `FEATURES`): a few
 * sections, each with its pages as in-page tabs (`tabs`). A section's first tab is the section's own page.
 */
export function buildNav(f: FeatureFlags): NavItem[] {
  const library: NavTab = { label: "Library", labelKey: "nav.library", href: "/library", icon: Library, shortcut: "G L", description: "Shared folders, precedents, clause bank and knowledge", descriptionKey: "nav.desc.library" };
  return [
    { label: "Home", labelKey: "nav.home", href: "/", icon: Home, shortcut: "G H", description: "Today, matters, tasks, calendar and the team's updates", descriptionKey: "nav.desc.home" },
    {
      label: "Research", labelKey: "nav.search", href: "/search", icon: Search, shortcut: "G S", description: "Judgments, statutes, rules, cause lists and internal knowledge", descriptionKey: "nav.desc.search",
      tabs: [
        { label: "Research", labelKey: "nav.search", href: "/search", icon: Search, description: "Judgments, statutes, rules, cause lists and internal knowledge", descriptionKey: "nav.desc.search" },
        { label: "Quick answer", labelKey: "nav.quickAnswer", href: "/chat", icon: MessageCircle, shortcut: "G C", description: "Quick answers, web search, calculations and files", descriptionKey: "nav.desc.chat" },
      ],
    },
    {
      label: "Matters", labelKey: "nav.matters", href: "/matters", icon: Briefcase, shortcut: "G M", description: "Matters, parties, hearing dates and the workspace each one scopes", descriptionKey: "nav.desc.matters",
      tabs: [
        { label: "Matters", labelKey: "nav.matters", href: "/matters", icon: Briefcase, description: "Matters, parties, hearing dates and the workspace each one scopes", descriptionKey: "nav.desc.matters" },
        { label: "Diary", labelKey: "nav.diary", href: "/diary", icon: CalendarClock, shortcut: "G Y", description: "Hearings across your matters from the courts' cause lists, hand-entered hearings and advocate-wise lists", descriptionKey: "nav.desc.diary" },
        { label: "Documents", labelKey: "nav.documents", href: "/documents", icon: Files, shortcut: "G D", description: "Upload document sets; ask questions, pull facts and build timelines", descriptionKey: "nav.desc.documents" },
      ],
    },
    ...(f.intel ? [{ label: "Intelligence", labelKey: "nav.intel", href: "/intel", icon: Radar, shortcut: "G I", description: "Courts, benches, authorities and notifications, watched and cross-analysed", descriptionKey: "nav.desc.intel" } satisfies NavItem] : []),
    { label: "Law", labelKey: "nav.law", href: LAW_TABS[0].href, icon: Scale, description: "Indian law: judgments, statutes, courts and judges", descriptionKey: "nav.desc.law", tabs: LAW_TABS },
    ...(f.ediscovery ? [{ label: "E-Discovery", labelKey: "nav.ediscovery", href: "/ediscovery", icon: FileSearch, shortcut: "G E", description: "Document review, witness evidence, chronologies and privilege", descriptionKey: "nav.desc.ediscovery" } satisfies NavItem] : []),
    f.officeAll
      ? {
          label: "Office",
          labelKey: "nav.office",
          href: "/office",
          icon: LayoutGrid,
          shortcut: "G O",
          description: "Word, Excel, PowerPoint and PDF editors with drafting agents",
          descriptionKey: "nav.desc.office",
          children: [
            { label: "Documents", labelKey: "nav.office.documents", href: "/office?kind=word", icon: FileText },
            { label: "Workbooks", labelKey: "nav.office.workbooks", href: "/office?kind=sheet", icon: FileSpreadsheet },
            { label: "Decks", labelKey: "nav.office.decks", href: "/office?kind=slides", icon: Presentation },
            { label: "PDFs", labelKey: "nav.office.pdfs", href: "/office?kind=pdf", icon: FileType },
          ],
          tabs: [{ label: "Office", labelKey: "nav.office", href: "/office", icon: LayoutGrid, exact: true }, library],
        }
      : // Only Word is enabled, so the entry is named for the job: drafting.
        {
          label: "Drafting", labelKey: "nav.drafting", href: "/office", icon: PenLine, shortcut: "G O", description: "Word documents with a drafting agent", descriptionKey: "nav.desc.drafting",
          tabs: [{ label: "Drafting", labelKey: "nav.drafting", href: "/office", icon: PenLine, description: "Word documents with a drafting agent", descriptionKey: "nav.desc.drafting", exact: true }, library],
        },
    ...(f.workflows ? [{ label: "Workflows", labelKey: "nav.workflows", href: "/workflows", icon: Workflow, shortcut: "G W", description: "Automations and multi-step agent playbooks", descriptionKey: "nav.desc.workflows" } satisfies NavItem] : []),
  ];
}

export const NAV: NavItem[] = buildNav(FEATURES);

export const SECONDARY_NAV: NavItem[] = [{ label: "Settings", labelKey: "nav.settings", href: "/settings", icon: Settings, shortcut: "G ,", description: "Language, AI, research providers, data & automation, integrity and the review queue", descriptionKey: "nav.desc.settings" }];

/** Every destination with a page of its own: top-level items, with a section's other tabs (and tab switches) after it. */
export type NavDestination = NavChild & { icon: LucideIcon; keywords?: string };
export function navDestinations(nav: NavItem[]): NavDestination[] {
  return nav.flatMap((item): NavDestination[] => {
    const own: NavDestination = { label: item.label, labelKey: item.labelKey, href: item.href, icon: item.icon, shortcut: item.shortcut, description: item.description, descriptionKey: item.descriptionKey };
    const tabs = item.tabs ?? [];
    if (tabs.length < 2) return [own];
    // A section with a page of its own (it has a chord) leads with it; Law has none and is reached through its tabs.
    const pages = item.shortcut ? tabs.filter((tb) => pathOf(tb.href) !== pathOf(item.href)) : tabs;
    const rest = pages.flatMap((tb) => (tb.sub?.length ? tb.sub : [tb])).map((c) => ({ ...c, icon: c.icon ?? item.icon, keywords: item.label }));
    return item.shortcut ? [own, ...rest] : rest;
  });
}

/** Every chord-carrying entry of a nav (items, rail children, tabs and tab switches), in nav order. */
function chordEntries(nav: NavItem[]): NavChild[] {
  const out: NavChild[] = [];
  for (const item of nav) {
    out.push(item);
    for (const c of item.children ?? []) out.push(c);
    for (const tb of item.tabs ?? []) {
      out.push(tb);
      for (const c of tb.sub ?? []) out.push(c);
    }
  }
  return out;
}

/** "G" chord targets derived from the nav shortcuts (key → href), so the shell, palette and help never drift. */
export function buildGoChord(nav: NavItem[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of chordEntries(nav)) {
    const m = n.shortcut?.match(/^G (.)$/);
    if (m) out[m[1].toLowerCase()] = n.href;
  }
  return out;
}

/** "G" chord targets: key → href (shared by the shell and the palette so both stay in sync). */
export const GO_CHORD: Record<string, string> = buildGoChord([...NAV, ...SECONDARY_NAV]);

/** "G x" shortcuts for the `?` help dialog, in nav order. */
export function goShortcuts(nav: NavItem[]): { keys: string[]; label: string; labelKey?: MessageKey }[] {
  const out: { keys: string[]; label: string; labelKey?: MessageKey }[] = [];
  for (const n of chordEntries(nav)) {
    const m = n.shortcut?.match(/^G (.)$/);
    if (m) out.push({ keys: ["g", m[1].toLowerCase()], label: n.label, labelKey: n.labelKey });
  }
  return out;
}


/** Whether `href` (path only; query and hash ignored) is the current page or an ancestor of it. Segment-aware: /law ≠ /lawyers. */
export function isHrefActive(href: string, pathname: string): boolean {
  const path = pathOf(href);
  if (path === "/") return pathname === "/";
  return pathname === path || pathname.startsWith(`${path}/`);
}

/** Whether a section tab is current: its own page (only that page when `exact`) or one of its switch's pages. */
export function isTabActive(tab: NavTab, pathname: string): boolean {
  const own = tab.exact ? pathname === pathOf(tab.href) : isHrefActive(tab.href, pathname);
  return own || (tab.sub ?? []).some((c) => isHrefActive(c.href, pathname));
}

/** A nav item is active on its own route and on any of its children's or tabs' routes (Law: /cases … /news). */
export function isNavItemActive(item: Pick<NavItem, "href" | "children" | "tabs">, pathname: string): boolean {
  return (
    isHrefActive(item.href, pathname) ||
    (item.children ?? []).some((c) => isHrefActive(c.href, pathname)) ||
    (item.tabs ?? []).some((tb) => isHrefActive(tb.href, pathname) || (tb.sub ?? []).some((c) => isHrefActive(c.href, pathname)))
  );
}

/**
 * The section whose tab bar belongs at the top of `pathname`, with its current tab, or null (Home, Settings, a
 * single-page section, or a page under an `exact` tab such as the document editor).
 */
export function sectionTabsFor(nav: NavItem[], pathname: string): { section: NavItem; tabs: NavTab[]; active: NavTab } | null {
  for (const section of nav) {
    const tabs = section.tabs ?? [];
    if (tabs.length < 2) continue;
    const active = tabs.find((tb) => isTabActive(tb, pathname));
    if (active) return { section, tabs, active };
  }
  return null;
}
