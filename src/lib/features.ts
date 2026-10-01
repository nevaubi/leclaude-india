/**
 * Product switches for LeClaude India. Client-safe (NEXT_PUBLIC_*, inlined at build).
 *
 * E-discovery (review, coding, productions, depositions) stays in the code base but is hidden from the India product:
 * no navigation entry, and /ediscovery redirects to Documents. Set NEXT_PUBLIC_ENABLE_EDISCOVERY=1 to bring it back.
 */
export const FEATURES = {
  ediscovery: process.env.NEXT_PUBLIC_ENABLE_EDISCOVERY === "1",
  /** Office shows only Word (documents and the drafting agent); Excel, PowerPoint and PDF return with NEXT_PUBLIC_ENABLE_OFFICE_ALL=1. */
  officeAll: process.env.NEXT_PUBLIC_ENABLE_OFFICE_ALL === "1",
} as const;

/** The matter's own page (Matters workspace). */
export const matterHref = (matterId: string) => `/matters?id=${encodeURIComponent(matterId)}`;

/** The matter's document sets. */
export const matterDocumentsHref = (matterId?: string | null) => (matterId ? `/documents?matter=${encodeURIComponent(matterId)}` : "/documents");
