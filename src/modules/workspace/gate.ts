/** Paths that stay reachable before first-run setup. Client-safe and pure (unit-tested). */
export function isSetupExempt(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return pathname === "/setup" || pathname.startsWith("/setup/") || pathname === "/login" || pathname.startsWith("/api/");
}
