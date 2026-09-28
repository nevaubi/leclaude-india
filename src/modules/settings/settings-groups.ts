/** Settings sections in page order (pure; shared by the nav, the page and tests). `label` is the English source; the
 * nav renders `labelKey` through the i18n catalogue. */
import type { MessageKey } from "@/lib/i18n/catalog";

export interface SettingsGroup { id: "workspace" | "language" | "demo" | "team" | "ai" | "research" | "data" | "integrity" | "about"; label: string; labelKey: MessageKey; anchors?: string[] }

/** The firm: its profile and its people. Shown first, above the system configuration. */
export const WORKSPACE_GROUPS: SettingsGroup[] = [
  { id: "workspace", label: "Workspace", labelKey: "settings.group.workspace" },
  { id: "language", label: "Language & region", labelKey: "settings.group.language", anchors: ["region", "locale"] },
  { id: "demo", label: "Demo data", labelKey: "settings.group.demo" },
  { id: "team", label: "Team", labelKey: "settings.group.team" },
];

/** System configuration read from the environment and the automation state. */
export const SETTINGS_GROUPS: SettingsGroup[] = [
  { id: "ai", label: "AI", labelKey: "settings.group.ai" },
  { id: "research", label: "Research providers", labelKey: "settings.group.research" },
  { id: "data", label: "Data & automation", labelKey: "settings.group.data", anchors: ["sources", "jobs"] },
  { id: "integrity", label: "Integrity", labelKey: "settings.group.integrity", anchors: ["review", "scans", "audit"] },
  { id: "about", label: "About", labelKey: "settings.group.about" },
];

/** Every section in page order. */
export const ALL_SETTINGS_GROUPS: SettingsGroup[] = [...WORKSPACE_GROUPS, ...SETTINGS_GROUPS];

/** Section id for a location hash (#review → integrity); undefined when unknown. */
export function sectionForHash(hash: string): SettingsGroup["id"] | undefined {
  const h = hash.replace(/^#/, "");
  return ALL_SETTINGS_GROUPS.find((g) => g.id === h || g.anchors?.includes(h))?.id;
}
