import { Home, Briefcase, Search, Radar, FileSearch, Workflow, LayoutGrid, Library, Settings, FileText, FileSpreadsheet, Presentation, FileType, type LucideIcon } from "lucide-react";
import type { MessageKey } from "@/lib/i18n/catalog";

/**
 * `label`/`description` are the English source strings (stable identifiers for tests and docs); the shell renders
 * `labelKey`/`descriptionKey` through the i18n catalogue.
 */
export interface NavItem {
  label: string;
  labelKey?: MessageKey;
  href: string;
  icon: LucideIcon;
  shortcut?: string;
  description?: string;
  descriptionKey?: MessageKey;
  children?: { label: string; labelKey?: MessageKey; href: string; icon?: LucideIcon }[];
}

export const NAV: NavItem[] = [
  { label: "Home", labelKey: "nav.home", href: "/", icon: Home, shortcut: "G H", description: "Today, matters, tasks, calendar and the team's updates", descriptionKey: "nav.desc.home" },
  { label: "Matters", labelKey: "nav.matters", href: "/matters", icon: Briefcase, shortcut: "G M", description: "Matters, parties, hearing dates and the workspace each one scopes", descriptionKey: "nav.desc.matters" },
  { label: "Search", labelKey: "nav.search", href: "/search", icon: Search, shortcut: "G S", description: "Judgments, statutes, rules, cause lists and internal knowledge", descriptionKey: "nav.desc.search" },
  { label: "Intelligence", labelKey: "nav.intel", href: "/intel", icon: Radar, shortcut: "G I", description: "Courts, benches, authorities and notifications, watched and cross-analysed", descriptionKey: "nav.desc.intel" },
  { label: "E-Discovery", labelKey: "nav.ediscovery", href: "/ediscovery", icon: FileSearch, shortcut: "G E", description: "Document review, witness evidence, chronologies and privilege", descriptionKey: "nav.desc.ediscovery" },
  { label: "Workflows", labelKey: "nav.workflows", href: "/workflows", icon: Workflow, shortcut: "G W", description: "Automations and multi-step agent playbooks", descriptionKey: "nav.desc.workflows" },
  {
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
  },
  { label: "Library", labelKey: "nav.library", href: "/library", icon: Library, shortcut: "G L", description: "Shared folders, precedents, clause bank and knowledge", descriptionKey: "nav.desc.library" },
];

export const SECONDARY_NAV: NavItem[] = [{ label: "Settings", labelKey: "nav.settings", href: "/settings", icon: Settings, shortcut: "G ,", description: "Language, AI, research providers, data & automation, integrity and the review queue", descriptionKey: "nav.desc.settings" }];

/** "G" chord targets: key → href (shared by the shell and the palette so both stay in sync). */
export const GO_CHORD: Record<string, string> = { h: "/", m: "/matters", s: "/search", i: "/intel", e: "/ediscovery", w: "/workflows", o: "/office", l: "/library", ",": "/settings" };
