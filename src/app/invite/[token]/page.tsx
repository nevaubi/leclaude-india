import type { Metadata } from "next";
import Link from "next/link";
import { pageDb } from "@/lib/db/request";
import { appDisplayName } from "@/lib/brand";
import { publicInvitation } from "@/modules/workspace/admin-access";
import { InviteAcceptForm } from "@/modules/workspace/components/invite-accept-form";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Create account" };

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  await pageDb();
  const { token } = await params;
  const appName = appDisplayName();
  try {
    const invitation = publicInvitation(token);
    return <InviteAcceptForm appName={appName} token={token} invitation={invitation} />;
  } catch {
    return (
      <main className="h-full overflow-y-auto bg-background">
        <div className="mx-auto flex min-h-full w-full max-w-[420px] flex-col justify-center px-6 py-12">
          <div className="rounded-xl border bg-card p-6 shadow-sm">
            <div className="text-[12px] font-medium tracking-wide text-muted-foreground">{appName}</div>
            <h1 className="mt-2 text-[20px] font-semibold tracking-tight">Invitation unavailable</h1>
            <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
              This invitation is invalid, expired, revoked, or has already been used.
            </p>
            <Link href="/login" className="mt-5 inline-flex text-[13px] font-medium text-foreground underline underline-offset-4">
              Go to sign in
            </Link>
          </div>
        </div>
      </main>
    );
  }
}
