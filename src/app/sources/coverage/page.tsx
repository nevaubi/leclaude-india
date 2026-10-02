import type { Metadata } from "next";
import Link from "next/link";
import { Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/misc";
import { pagePrincipal } from "@/lib/auth/page";
import { CoverageDashboard } from "@/modules/india/corpus/hc-text/components/coverage-dashboard";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Coverage" };

/**
 * /sources/coverage — private coverage dashboard for signed-in members (the data comes from
 * /api/india/hc-text/coverage and /api/official, which authorize every request; the middleware already keeps anonymous
 * visitors out when sign-in is enforced, and this page renders nothing without a principal).
 */
export default async function Page() {
  const principal = await pagePrincipal("/sources/coverage");
  if (!principal) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <EmptyState icon={Lock} title="Sign in to view coverage" description="Coverage is visible to members of this workspace." action={<Button asChild size="xs" variant="outline"><Link href="/login?next=/sources/coverage">Sign in</Link></Button>} />
      </div>
    );
  }
  return <CoverageDashboard />;
}
