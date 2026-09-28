/** Shortcut registry model for the `?` help dialog. Pure; unit-tested. */
import type { MessageKey } from "@/lib/i18n/catalog";

/** `label`/`title` are the English source text; the dialog renders `labelKey`/`titleKey` when present. */
export interface ShortcutItem { keys: string[]; label: string; labelKey?: MessageKey }
export interface ShortcutGroup { id: string; title: string; titleKey?: MessageKey; items: ShortcutItem[] }

/** Shortcuts the shell provides on every page. */
export const GLOBAL_SHORTCUTS: ShortcutGroup[] = [
  {
    id: "global",
    title: "Everywhere",
    titleKey: "shortcuts.group.global",
    items: [
      { keys: ["mod+k"], label: "Command palette", labelKey: "shortcuts.commandPalette" },
      { keys: ["?"], label: "Keyboard shortcuts", labelKey: "shortcuts.keyboardShortcuts" },
      { keys: ["/"], label: "Focus search", labelKey: "shortcuts.focusSearch" },
      { keys: ["["], label: "Toggle the navigation rail", labelKey: "shortcuts.toggleRail" },
      { keys: ["]"], label: "Toggle the right panel", labelKey: "shortcuts.toggleRightPanel" },
      { keys: ["esc"], label: "Close panel or dialog", labelKey: "shortcuts.closePanel" },
    ],
  },
  {
    id: "go",
    title: "Go to",
    titleKey: "shortcuts.group.go",
    items: [
      { keys: ["g", "h"], label: "Home", labelKey: "nav.home" },
      { keys: ["g", "m"], label: "Matters", labelKey: "nav.matters" },
      { keys: ["g", "s"], label: "Search", labelKey: "nav.search" },
      { keys: ["g", "i"], label: "Intelligence", labelKey: "nav.intel" },
      { keys: ["g", "e"], label: "E-Discovery", labelKey: "nav.ediscovery" },
      { keys: ["g", "w"], label: "Workflows", labelKey: "nav.workflows" },
      { keys: ["g", "o"], label: "Office", labelKey: "nav.office" },
      { keys: ["g", "l"], label: "Library", labelKey: "nav.library" },
      { keys: ["g", ","], label: "Settings", labelKey: "nav.settings" },
    ],
  },
  {
    id: "grid",
    title: "Tables and lists",
    titleKey: "shortcuts.group.grid",
    items: [
      { keys: ["j"], label: "Next row", labelKey: "shortcuts.nextRow" },
      { keys: ["k"], label: "Previous row", labelKey: "shortcuts.prevRow" },
      { keys: ["home"], label: "First row", labelKey: "shortcuts.firstRow" },
      { keys: ["end"], label: "Last row", labelKey: "shortcuts.lastRow" },
      { keys: ["shift+↑↓"], label: "Extend selection", labelKey: "shortcuts.extendSelection" },
      { keys: ["mod+click"], label: "Toggle a row", labelKey: "shortcuts.toggleRow" },
      { keys: ["space"], label: "Select the active row", labelKey: "shortcuts.selectRow" },
      { keys: ["enter"], label: "Open the active row", labelKey: "shortcuts.openRow" },
    ],
  },
];

/** Page groups override global groups with the same id; otherwise they are appended. */
export function mergeShortcutGroups(base: ShortcutGroup[], extra: ShortcutGroup[]): ShortcutGroup[] {
  const out = base.map((g) => ({ ...g, items: [...g.items] }));
  for (const g of extra) {
    const i = out.findIndex((x) => x.id === g.id);
    if (i >= 0) out[i] = { ...g, items: [...g.items] };
    else out.push({ ...g, items: [...g.items] });
  }
  return out.filter((g) => g.items.length > 0);
}

const NAMED: Record<string, string> = { esc: "Esc", enter: "↵", space: "Space", home: "Home", end: "End", tab: "Tab", up: "↑", down: "↓", left: "←", right: "→", backspace: "⌫", delete: "Del", click: "Click" };

/** "mod+k" → "⌘K" (mac) / "Ctrl K"; single letters upper-case; chords stay separate: ["g","h"] → ["G","H"]. */
export function formatKeys(keys: string[], platform: "mac" | "other" = "mac"): string[] {
  const mod = platform === "mac" ? "⌘" : "Ctrl";
  const shift = platform === "mac" ? "⇧" : "Shift";
  const alt = platform === "mac" ? "⌥" : "Alt";
  return keys.map((k) => {
    const parts = k.split("+").map((p) => p.trim()).filter(Boolean);
    const rendered = parts.map((p) => {
      const lower = p.toLowerCase();
      if (lower === "mod" || lower === "cmd" || lower === "meta") return mod;
      if (lower === "shift") return shift;
      if (lower === "alt" || lower === "option") return alt;
      if (NAMED[lower]) return NAMED[lower];
      return p.length === 1 ? p.toUpperCase() : p;
    });
    return rendered.join(platform === "mac" ? "" : " ");
  });
}

/** True when a key event originates in a text field (shortcuts must not fire). */
export function isTypingTarget(target: { tagName?: string; isContentEditable?: boolean; closest?: (sel: string) => unknown } | null | undefined): boolean {
  if (!target) return false;
  const tag = (target.tagName ?? "").toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  return false;
}

export function detectPlatform(userAgent: string | undefined): "mac" | "other" {
  return /mac|iphone|ipad/i.test(userAgent ?? "") ? "mac" : "other";
}
