"use client";
import * as React from "react";
import { useT } from "@/lib/i18n/client";
import { usePathname, useRouter } from "next/navigation";
import { isSetupExempt } from "../gate";

export { isSetupExempt };

/**
 * First-run gate. Until the workspace has an owner, every page redirects to /setup; the page content is not
 * rendered meanwhile so an unconfigured workspace never flashes empty module screens.
 */
export function SetupGate({ configured, children }: { configured: boolean; children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const redirect = !configured && !isSetupExempt(pathname);
  const t = useT();
  React.useEffect(() => {
    if (redirect) router.replace("/setup");
  }, [redirect, router]);
  if (redirect) {
    return (
      <div className="flex h-full items-center justify-center text-[12.5px] text-muted-foreground" role="status">
        {t("setup.opening")}
      </div>
    );
  }
  return <>{children}</>;
}
