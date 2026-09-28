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

const appName = process.env.NEXT_PUBLIC_APP_NAME?.trim() || "LeClaude India";
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

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  await pageDb();
  const ws = readWorkspace();
  const firmName = ws.firmName || envFirmName;
  const user = ws.owner ? { id: ws.owner.id, name: ws.owner.name, email: ws.owner.email, role: ws.owner.title || ws.owner.firmRole || undefined } : undefined;
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
              <AppShell appName={appName} firmName={firmName} user={user}>{children}</AppShell>
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
