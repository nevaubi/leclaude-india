/** Pure grouping for the command palette (unit-tested; no React). English labels are the source strings; the
 * component renders `labelKey`/`headingKey` through the i18n catalogue. */
import type { MessageKey } from "@/lib/i18n/catalog";
import { FEATURES } from "@/lib/features";

export interface QuickSearchHit {
  id: string;
  kind: "matter" | "document" | "person" | "task" | "event" | "workflow" | "library" | "office";
  title: string;
  subtitle?: string;
  href: string;
}

export const KIND_LABEL: Record<QuickSearchHit["kind"], string> = { matter: "Matter", document: "Document", person: "Person", task: "Task", event: "Event", workflow: "Workflow", library: "Library", office: "Office" };

/** Order sections by what a litigator reaches for first: matters, then documents, then people and the rest. */
const ORDER: QuickSearchHit["kind"][] = ["matter", "document", "office", "library", "person", "task", "event", "workflow"];

/** Group hits by kind so a mixed result list reads as sections; headings pluralise when a group has several rows. */
export function groupHits(hits: QuickSearchHit[]): { kind: QuickSearchHit["kind"]; label: string; hits: QuickSearchHit[] }[] {
  const by = new Map<QuickSearchHit["kind"], QuickSearchHit[]>();
  for (const h of hits) by.set(h.kind, [...(by.get(h.kind) ?? []), h]);
  return ORDER.filter((k) => by.has(k)).map((k) => ({ kind: k, label: KIND_LABEL[k] + (by.get(k)!.length === 1 ? "" : "s"), hits: by.get(k)! }));
}

// ---------------------------------------------------------------------------
// Static commands, grouped. The component maps `icon` names onto lucide icons.
// ---------------------------------------------------------------------------

export type PaletteAction = "theme:light" | "theme:dark" | "theme:system" | "toggle-sidebar" | "shortcuts";
export type PaletteIcon = "doc" | "sheet" | "deck" | "pdf" | "search" | "radar" | "shield" | "shield-alert" | "sun" | "moon" | "monitor" | "panel" | "keyboard" | "settings" | "database" | "globe";

export interface PaletteCommand { id: string; label: string; labelKey?: MessageKey; labelVars?: Record<string, string>; href?: string; action?: PaletteAction; shortcut?: string; icon: PaletteIcon; keywords?: string }
export interface PaletteSection { id: "create" | "go" | "actions" | "integrity" | "preferences"; heading: string; headingKey: MessageKey; commands: PaletteCommand[] }

export interface NavLike { label: string; labelKey?: MessageKey; href: string; shortcut?: string }

/**
 * Command sections in reading order: Create, Go to (from the nav), Actions
 * (research the typed text, open intelligence), Integrity, Preferences. The
 * research command carries the query so it reads "Research: <text>".
 */
export function paletteSections(opts: { query: string; nav: NavLike[] }): PaletteSection[] {
  const q = opts.query.trim();
  return [
    {
      id: "create", heading: "Create", headingKey: "palette.section.create", commands: [
        { id: "new-doc", label: "New document", labelKey: "palette.newDoc", href: "/office/word/new", shortcut: "Word", icon: "doc", keywords: "word docx draft" },
        ...(FEATURES.officeAll ? [
          { id: "new-sheet", label: "New workbook", labelKey: "palette.newSheet" as const, href: "/office/sheet/new", shortcut: "Excel", icon: "sheet" as PaletteIcon, keywords: "excel xlsx" },
          { id: "new-deck", label: "New deck", labelKey: "palette.newDeck" as const, href: "/office/slides/new", shortcut: "PowerPoint", icon: "deck" as PaletteIcon, keywords: "slides pptx" },
        ] : []),
      ],
    },
    { id: "go", heading: "Go to", headingKey: "palette.section.go", commands: opts.nav.map((n) => ({ id: `go:${n.href}`, label: n.label, labelKey: n.labelKey, href: n.href, shortcut: n.shortcut, icon: "search" as PaletteIcon })) },
    {
      id: "actions", heading: "Actions", headingKey: "palette.section.actions", commands: [
        { id: "research", label: q ? `Research: “${q}”` : "Start research", labelKey: q ? "palette.research" : "palette.startResearch", labelVars: q ? { q } : undefined, href: `/search?q=${encodeURIComponent(q)}`, icon: "search", keywords: "ask question case law authority" },
        { id: "intel-search", label: q ? `Find in Intelligence: “${q}”` : "Browse Intelligence", labelKey: q ? "palette.findIntel" : "palette.browseIntel", labelVars: q ? { q } : undefined, href: q ? `/intel?q=${encodeURIComponent(q)}` : "/intel", icon: "radar", keywords: "judge docket regulation recall trend" },
        { id: "data-automation", label: "Data & automation", labelKey: "palette.dataAutomation", href: "/settings#data", icon: "database", keywords: "sources jobs schedule ingest" },
      ],
    },
    {
      id: "integrity", heading: "Integrity", headingKey: "palette.section.integrity", commands: [
        { id: "review-queue", label: "Open the AI review queue", labelKey: "palette.reviewQueue", href: "/settings#review", icon: "shield-alert", keywords: "pending approve reject" },
        { id: "scans", label: "Data integrity scans and audit log", labelKey: "palette.scans", href: "/settings#integrity", icon: "shield", keywords: "audit chain findings" },
      ],
    },
    {
      id: "preferences", heading: "Preferences", headingKey: "palette.section.preferences", commands: [
        { id: "language", label: "Language & region", labelKey: "palette.language", href: "/settings#language", icon: "globe", keywords: "language locale hindi kannada telugu tamil marathi bengali urdu region" },
        { id: "theme-light", label: "Light theme", labelKey: "palette.themeLight", action: "theme:light", icon: "sun" },
        { id: "theme-dark", label: "Dark theme", labelKey: "palette.themeDark", action: "theme:dark", icon: "moon" },
        { id: "theme-system", label: "System theme", labelKey: "palette.themeSystem", action: "theme:system", icon: "monitor" },
        { id: "toggle-nav", label: "Toggle navigation labels", labelKey: "palette.toggleNav", action: "toggle-sidebar", shortcut: "[", icon: "panel" },
        { id: "shortcuts", label: "Keyboard shortcuts", labelKey: "palette.shortcuts", action: "shortcuts", shortcut: "?", icon: "keyboard" },
      ],
    },
  ];
}
