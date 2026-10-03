import { pageDb } from "@/lib/db/request";
import type { Metadata, Viewport } from "next";
import { Noto_Nastaliq_Urdu, Noto_Sans_Bengali, Noto_Sans_Devanagari, Noto_Sans_Kannada, Noto_Sans_Tamil, Noto_Sans_Telugu } from "next/font/google";
import "./globals.css";
import { AppShell } from "@/components/shell/app-shell";
import { ThemeProvider } from "@/components/shell/theme-provider";
import { Toaster } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SetupGate } from "@/modules/workspace/components/setup-gate";
import { workspaceView } from "@/modules/workspace/service";
import type { WorkspaceView } from "@/modules/workspace/roles";
import { I18nProvider } from "@/lib/i18n/client";
import { getI18n } from "@/lib/i18n/server";
import { pagePrincipal, signInEnforced } from "@/lib/auth/page";
import { db } from "@/lib/db";
import type { ShellUser } from "@/components/shell/app-shell";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { isPublicPath, PATH_HEADER } from "@/lib/auth/gatekeeper";
import { safeNextPath } from "@/lib/auth/session-token";
import { appDisplayName } from "@/lib/brand";

const appName = appDisplayName();
const envFirmName = process.env.NEXT_PUBLIC_FIRM_NAME?.trim() || "Your firm";

/*
 * Indic and Urdu faces for mixed-script legal text (a Kannada cause title inside an English page). Loaded with
 * next/font (Google Fonts, self-hosted at build), exposed as CSS variables that globals.css places after the Latin UI
 * font, so each glyph falls through to the face that has it. Only the script subset is requested and nothing is
 * preloaded: a page without Kannada never downloads the Kannada face. No metric-adjusted fallback faces, which would
 * otherwise sit in the stack ahead of the next script's font.
 */
// next/font requires literal options at each call site.
const notoDevanagari = Noto_Sans_Devanagari({ display: "swap", preload: false, adjustFontFallback: false, subsets: ["devanagari"], variable: "--font-noto-deva" });
const notoKannada = Noto_Sans_Kannada({ display: "swap", preload: false, adjustFontFallback: false, subsets: ["kannada"], variable: "--font-noto-knda" });
const notoTelugu = Noto_Sans_Telugu({ display: "swap", preload: false, adjustFontFallback: false, subsets: ["telugu"], variable: "--font-noto-telu" });
const notoTamil = Noto_Sans_Tamil({ display: "swap", preload: false, adjustFontFallback: false, subsets: ["tamil"], variable: "--font-noto-taml" });
const notoBengali = Noto_Sans_Bengali({ display: "swap", preload: false, adjustFontFallback: false, subsets: ["bengali"], variable: "--font-noto-beng" });
const notoNastaliq = Noto_Nastaliq_Urdu({ display: "swap", preload: false, adjustFontFallback: false, subsets: ["arabic"], variable: "--font-noto-urdu" });
const fontVariables = [notoDevanagari, notoKannada, notoTelugu, notoTamil, notoBengali, notoNastaliq].map((f) => f.variable).join(" ");

// The shell reads the workspace (firm, owner) from the database on every request.
export const dynamic = "force-dynamic";

/** The workspace for the shell; an unreadable or empty database renders the setup state instead of crashing. */
function readWorkspace(): WorkspaceView {
  try {
    return workspaceView();
  } catch (e) {
    console.error("[layout] could not read the workspace", (e as Error).message);
    return { configured: false, firmName: envFirmName, owner: null };
  }
}

export function generateMetadata(): Metadata {
  const { firmName } = readWorkspace();
  return {
    title: { default: appName, template: `%s · ${appName}` },
    description: `${firmName || envFirmName} litigation platform for Indian courts: research across judgments and statutes, intelligence, document review, workflows and an AI-native office suite.`,
    applicationName: appName,
  };
}

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#121212" },
  ],
  width: "device-width",
  initialScale: 1,
};

/**
 * The person shown in the shell. Dev mode: the workspace owner persona. With sign-in enforced: the signed-in member,
 * or null when the request is not signed in (the sign-in and setup pages render without the shell, and nothing
 * about the workspace's people reaches an anonymous page).
 */
async function shellUser(ws: WorkspaceView): Promise<ShellUser | null> {
  if (!signInEnforced()) return ws.owner ? { id: ws.owner.id, name: ws.owner.name, email: ws.owner.email, role: ws.owner.title || ws.owner.firmRole || undefined } : null;
  const p = await pagePrincipal();
  if (!p) return null;
  let title: string | undefined;
  let firmName: string | undefined;
  try {
    const person = db().people.get(p.id);
    title = person?.title;
    firmName = person?.organization;
  } catch { /* the shell still renders with the name */ }
  return { id: p.id, name: p.name, email: p.email, role: title, firmName };
}

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  await pageDb();
  const ws = readWorkspace();
  const firmName = ws.firmName || envFirmName;
  const user = await shellUser(ws);
  const enforced = signInEnforced();
  if (enforced && ws.configured && !user) {
    // The edge gate checks the cookie's signature and expiry only; a revoked session (password reset, deactivated
    // member) is caught here, so no page renders workspace data for it. The middleware supplies the path.
    const path = (await headers()).get(PATH_HEADER) ?? "/";
    if (!isPublicPath(path)) {
      const next = safeNextPath(path);
      redirect(next === "/" ? "/login" : `/login?next=${encodeURIComponent(next)}`);
    }
  }
  const i18n = await getI18n();
  return (
    <html lang={i18n.locale} dir={i18n.dir} className={fontVariables} suppressHydrationWarning>
      <head>
        <script
          // Apply the persisted theme before paint to avoid a flash.
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('leclaude:theme');var d=t==='dark'||(!t||t==='system')&&window.matchMedia('(prefers-color-scheme: dark)').matches;if(d)document.documentElement.classList.add('dark');}catch(e){}})();`,
          }}
        />
      </head>
      <body className="h-full overflow-hidden">
        <I18nProvider locale={i18n.locale} messages={i18n.messages}>
        <ThemeProvider>
          <TooltipProvider delayDuration={250}>
            {ws.configured && user ? (
              <AppShell appName={appName} firmName={user.firmName || firmName} user={user} signInEnabled={enforced}>{children}</AppShell>
            ) : enforced && ws.configured ? (
              // Signed out with sign-in enforced: only /login (and /setup, which redirects) reach here; render bare.
              children
            ) : (
              // Before first-run setup there is no identity to show: render full-page and send every route to /setup.
              <SetupGate configured={false}>{children}</SetupGate>
            )}
            <Toaster position={i18n.dir === "rtl" ? "bottom-left" : "bottom-right"} dir={i18n.dir} closeButton toastOptions={{ className: "font-sans text-[12.5px]" }} />
          </TooltipProvider>
        </ThemeProvider>
        </I18nProvider>
      </body>
    </html>
  );
}
