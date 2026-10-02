import { FEATURES, type FeatureFlags } from "@/lib/features";
import { BookOpen, Home, MessageCircle, Briefcase, Files, Gavel, Landmark, Newspaper, Search, Radar, FileSearch, Workflow, LayoutGrid, Library, Settings, UserRound, FileText, FileSpreadsheet, Presentation, FileType, PenLine, Scale, type LucideIcon } from "lucide-react";
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
}

/** Children worth rendering as a group: a single child adds nothing over its parent. */
export const navGroupChildren = (item: Pick<NavItem, "children">): NavChild[] => (item.children && item.children.length > 1 ? item.children : []);

/** The Indian law corpus, grouped under one rail entry. Each page keeps its own G chord. */
const LAW_CHILDREN: NavChild[] = [
  { label: "Case law", labelKey: "nav.caselaw", href: "/cases", icon: Gavel, shortcut: "G J", description: "Supreme Court and High Court judgments: browse, search and trace each record to its source", descriptionKey: "nav.desc.caselaw" },
  { label: "Statutes", labelKey: "nav.statutes", href: "/law", icon: BookOpen, shortcut: "G A", description: "Central and State Acts and regulator regulations: browse, search and read section by section", descriptionKey: "nav.desc.statutes" },
  { label: "Courts", labelKey: "nav.courts", href: "/courts", icon: Landmark, shortcut: "G K", description: "Courts, tribunals and local law by city: official websites, e-filing, cause lists and case status", descriptionKey: "nav.desc.courts" },
  { label: "Judges", labelKey: "nav.judges", href: "/judges", icon: UserRound, shortcut: "G U", description: "Supreme Court and High Court judges from official rosters, with their judgments in the case law index", descriptionKey: "nav.desc.judges" },
];

/** The primary navigation for a set of product switches (pure; `NAV` is this for the build's `FEATURES`). */
export function buildNav(f: FeatureFlags): NavItem[] {
  return [
    { label: "Home", labelKey: "nav.home", href: "/", icon: Home, shortcut: "G H", description: "Today, matters, tasks, calendar and the team's updates", descriptionKey: "nav.desc.home" },
    { label: "Chat", labelKey: "nav.chat", href: "/chat", icon: MessageCircle, shortcut: "G C", description: "Quick answers, web search, calculations and files", descriptionKey: "nav.desc.chat" },
    { label: "Matters", labelKey: "nav.matters", href: "/matters", icon: Briefcase, shortcut: "G M", description: "Matters, parties, hearing dates and the workspace each one scopes", descriptionKey: "nav.desc.matters" },
    { label: "Research", labelKey: "nav.search", href: "/search", icon: Search, shortcut: "G S", description: "Judgments, statutes, rules, cause lists and internal knowledge", descriptionKey: "nav.desc.search" },
    ...(f.intel ? [{ label: "Intelligence", labelKey: "nav.intel", href: "/intel", icon: Radar, shortcut: "G I", description: "Courts, benches, authorities and notifications, watched and cross-analysed", descriptionKey: "nav.desc.intel" } satisfies NavItem] : []),
    { label: "Law", labelKey: "nav.law", href: LAW_CHILDREN[0].href, icon: Scale, description: "Indian law: judgments, statutes, courts and judges", descriptionKey: "nav.desc.law", children: LAW_CHILDREN },
    { label: "News", labelKey: "nav.news", href: "/news", icon: Newspaper, shortcut: "G N", description: "Indian legal news headlines from LiveLaw, Bar & Bench and other publishers", descriptionKey: "nav.desc.news" },
    { label: "Documents", labelKey: "nav.documents", href: "/documents", icon: Files, shortcut: "G D", description: "Upload document sets; ask questions, pull facts and build timelines", descriptionKey: "nav.desc.documents" },
    ...(f.ediscovery ? [{ label: "E-Discovery", labelKey: "nav.ediscovery", href: "/ediscovery", icon: FileSearch, shortcut: "G E", description: "Document review, witness evidence, chronologies and privilege", descriptionKey: "nav.desc.ediscovery" } satisfies NavItem] : []),
    ...(f.workflows ? [{ label: "Workflows", labelKey: "nav.workflows", href: "/workflows", icon: Workflow, shortcut: "G W", description: "Automations and multi-step agent playbooks", descriptionKey: "nav.desc.workflows" } satisfies NavItem] : []),
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
        }
      : // Only Word is enabled, so the entry is named for the job: drafting.
        { label: "Drafting", labelKey: "nav.drafting", href: "/office", icon: PenLine, shortcut: "G O", description: "Word documents with a drafting agent", descriptionKey: "nav.desc.drafting" },
    { label: "Library", labelKey: "nav.library", href: "/library", icon: Library, shortcut: "G L", description: "Shared folders, precedents, clause bank and knowledge", descriptionKey: "nav.desc.library" },
  ];
}

export const NAV: NavItem[] = buildNav(FEATURES);

export const SECONDARY_NAV: NavItem[] = [{ label: "Settings", labelKey: "nav.settings", href: "/settings", icon: Settings, shortcut: "G ,", description: "Language, AI, research providers, data & automation, integrity and the review queue", descriptionKey: "nav.desc.settings" }];

/** Every destination with a page of its own: top-level items, with a group replaced by its children. */
export type NavDestination = NavChild & { icon: LucideIcon; keywords?: string };
export function navDestinations(nav: NavItem[]): NavDestination[] {
  return nav.flatMap((item): NavDestination[] => {
    const kids = navGroupChildren(item);
    // A group whose children carry their own chords (Law) is reached through them; Office keeps its own entry.
    if (kids.length && kids.some((c) => c.shortcut)) return kids.map((c) => ({ ...c, icon: c.icon ?? item.icon, keywords: item.label }));
    return [{ label: item.label, labelKey: item.labelKey, href: item.href, icon: item.icon, shortcut: item.shortcut, description: item.description, descriptionKey: item.descriptionKey }];
  });
}

/** "G" chord targets derived from the nav shortcuts (key → href), so the shell, palette and help never drift. */
export function buildGoChord(nav: NavItem[]): Record<string, string> {
  const out: Record<string, string> = {};
  const add = (shortcut: string | undefined, href: string) => {
    const m = shortcut?.match(/^G (.)$/);
    if (m) out[m[1].toLowerCase()] = href;
  };
  for (const item of nav) {
    add(item.shortcut, item.href);
    for (const c of item.children ?? []) add(c.shortcut, c.href);
  }
  return out;
}

/** "G" chord targets: key → href (shared by the shell and the palette so both stay in sync). */
export const GO_CHORD: Record<string, string> = buildGoChord([...NAV, ...SECONDARY_NAV]);

/** "G x" shortcuts for the `?` help dialog, in nav order. */
export function goShortcuts(nav: NavItem[]): { keys: string[]; label: string; labelKey?: MessageKey }[] {
  const out: { keys: string[]; label: string; labelKey?: MessageKey }[] = [];
  const add = (n: { shortcut?: string; label: string; labelKey?: MessageKey }) => {
    const m = n.shortcut?.match(/^G (.)$/);
    if (m) out.push({ keys: ["g", m[1].toLowerCase()], label: n.label, labelKey: n.labelKey });
  };
  for (const item of nav) {
    add(item);
    for (const c of item.children ?? []) add(c);
  }
  return out;
}

const pathOf = (href: string) => href.split(/[?#]/)[0];

/** Whether `href` (path only; query and hash ignored) is the current page or an ancestor of it. Segment-aware: /law ≠ /lawyers. */
export function isHrefActive(href: string, pathname: string): boolean {
  const path = pathOf(href);
  if (path === "/") return pathname === "/";
  return pathname === path || pathname.startsWith(`${path}/`);
}

/** A nav item is active on its own route and on any of its children's routes (Law: /cases, /law, /courts, /judges). */
export function isNavItemActive(item: Pick<NavItem, "href" | "children">, pathname: string): boolean {
  return isHrefActive(item.href, pathname) || (item.children ?? []).some((c) => isHrefActive(c.href, pathname));
}
