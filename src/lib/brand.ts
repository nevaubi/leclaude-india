/**
 * Product brand: the single source of the user-visible product name (client-safe; no server imports).
 *
 * "Pramana" (Sanskrit pramāṇa: a valid means of knowledge, proof) is provisional pending a trademark clearance search
 * (docs/product/rename-plan.md). The name is written in Latin script in every locale. Internal identifiers that predate
 * the rename (LECLAUDE_* env vars, lc_* cookies and tables, leclaude:* storage keys, x-leclaude-* headers, outbound
 * user agents) are deliberately not derived from this constant.
 */
export const BRAND = {
  /** Product name, shown in titles, the shell, sign-in, exports and agent prompts. */
  name: "Pramana",
  /** Market qualifier set in small caps beside the wordmark; not part of the name. */
  qualifier: "India",
  /** One-line description. */
  description: "Litigation intelligence for Indian courts",
  /** Monogram for the square mark (navigation rail, favicon). */
  monogram: "P",
} as const;

/** Names a deployment may still carry in NEXT_PUBLIC_APP_NAME from before the rename; they fall back to BRAND.name. */
const LEGACY_NAME = /le\s*claude/i;

/**
 * Display name for this deployment: NEXT_PUBLIC_APP_NAME when set (a white-label override), else BRAND.name. A
 * leftover pre-rename value ("LeClaude", "LeClaude India") is ignored so an old environment cannot keep the retired
 * name on screen.
 */
export function appDisplayName(override: string | undefined = process.env.NEXT_PUBLIC_APP_NAME): string {
  const v = override?.trim();
  return v && !LEGACY_NAME.test(v) ? v : BRAND.name;
}
