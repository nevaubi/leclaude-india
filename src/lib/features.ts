/**
 * Product switches for LeClaude India. Client-safe (NEXT_PUBLIC_*, inlined at build).
 *
 * E-discovery (review, coding, productions, depositions) stays in the code base but is hidden from the India product:
 * no navigation entry, and /ediscovery redirects to Documents. Set NEXT_PUBLIC_ENABLE_EDISCOVERY=1 to bring it back.
 *
 * Workflows and Intelligence follow the same pattern: the engines, API routes, scheduler and background jobs keep
 * running (other modules depend on them), but their pages, navigation entries, chords, palette commands and links are
 * hidden, and their routes redirect home. NEXT_PUBLIC_ENABLE_WORKFLOWS=1 / NEXT_PUBLIC_ENABLE_INTEL=1 bring them back.
 */
export interface FeatureFlags {
  ediscovery: boolean;
  officeAll: boolean;
  workflows: boolean;
  intel: boolean;
}

/** Read the switches from an environment (pure; tests pass their own). */
export function readFeatures(env: Record<string, string | undefined>): FeatureFlags {
  return {
    ediscovery: env.NEXT_PUBLIC_ENABLE_EDISCOVERY === "1",
    /** Office shows only Word (documents and the drafting agent); Excel, PowerPoint and PDF return with NEXT_PUBLIC_ENABLE_OFFICE_ALL=1. */
    officeAll: env.NEXT_PUBLIC_ENABLE_OFFICE_ALL === "1",
    /** Workflow builder, gallery and run pages (the engine and scheduler always run). */
    workflows: env.NEXT_PUBLIC_ENABLE_WORKFLOWS === "1",
    /** Intelligence explorer (US dockets / Federal Register); Settings → Data & automation stays available. */
    intel: env.NEXT_PUBLIC_ENABLE_INTEL === "1",
  };
}

// NEXT_PUBLIC_* must be read by literal name so Next inlines them into the client bundle.
export const FEATURES: Readonly<FeatureFlags> = readFeatures({
  NEXT_PUBLIC_ENABLE_EDISCOVERY: process.env.NEXT_PUBLIC_ENABLE_EDISCOVERY,
  NEXT_PUBLIC_ENABLE_OFFICE_ALL: process.env.NEXT_PUBLIC_ENABLE_OFFICE_ALL,
  NEXT_PUBLIC_ENABLE_WORKFLOWS: process.env.NEXT_PUBLIC_ENABLE_WORKFLOWS,
  NEXT_PUBLIC_ENABLE_INTEL: process.env.NEXT_PUBLIC_ENABLE_INTEL,
});

const pathOf = (href: string) => href.split(/[?#]/)[0];
const under = (path: string, root: string) => path === root || path.startsWith(`${root}/`);

/**
 * Whether an in-app link leads to a surface the product hides (Workflows or Intelligence when switched off).
 * Links stored in data (task links, team-update attachments, brief items, integrity findings) pass through this so
 * the UI never shows a link that would only bounce back home. External and API URLs are never hidden here.
 */
export function isHiddenHref(href: string | null | undefined, features: FeatureFlags = FEATURES): boolean {
  if (!href || !href.startsWith("/")) return false;
  const path = pathOf(href);
  if (!features.workflows && under(path, "/workflows")) return true;
  if (!features.intel && under(path, "/intel")) return true;
  return false;
}

/**
 * Where a hidden surface's pages send the user (its layout calls `redirect()` with this), or null when the surface is
 * on. Workflows and Intelligence land on Home.
 */
export function hiddenSurfaceRedirect(surface: "workflows" | "intel", features: FeatureFlags = FEATURES): string | null {
  return features[surface] ? null : "/";
}

/** The matter's own page (Matters workspace). */
export const matterHref = (matterId: string) => `/matters?id=${encodeURIComponent(matterId)}`;

/** The matter's document sets. */
export const matterDocumentsHref = (matterId?: string | null) => (matterId ? `/documents?matter=${encodeURIComponent(matterId)}` : "/documents");
