import { pageDb } from "@/lib/db/request";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { pagePrincipal, signInEnforced } from "@/lib/auth/page";
import { safeNextPath } from "@/lib/auth/session-token";
import { bootstrapStatus } from "@/modules/workspace/signin";
import { workspaceView } from "@/modules/workspace/service";
import { LoginForm } from "@/modules/workspace/components/login-form";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Sign in" };

/**
 * /login — public. Signed-in members go straight to `next`; a workspace without an owner goes to /setup; a workspace
 * where no one has a password yet shows the one-time owner-password step (AUTH_SETUP_TOKEN).
 */
export default async function Page({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  await pageDb();
  const sp = await searchParams;
  const next = safeNextPath(sp.next);
  const ws = workspaceView();
  if (!ws.configured) redirect("/setup");
  if (signInEnforced() && (await pagePrincipal("/login"))) redirect(next);
  const s = bootstrapStatus();
  return (
    <LoginForm
      appName={process.env.NEXT_PUBLIC_APP_NAME?.trim() || "LeClaude India"}
      firmName={ws.firmName}
      next={next}
      status={{ needsOwnerPassword: s.needsOwnerPassword, setupTokenConfigured: s.setupTokenConfigured, signInConfigured: s.signInConfigured }}
    />
  );
}
