"use client";
import * as React from "react";
import { Check, Languages } from "lucide-react";
import { toast } from "sonner";
import { LANGUAGES, UI_LOCALES, type LocaleCode } from "@/lib/india/languages";
import { useI18n } from "@/lib/i18n/client";
import { DropdownMenuItem, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger } from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

/** UI locales with their names, in registry order. Each name is shown in its own script so a reader finds theirs. */
export const UI_LANGUAGE_OPTIONS = LANGUAGES.filter((l) => (UI_LOCALES as string[]).includes(l.code));

function useChangeLocale() {
  const { locale, setLocale, t } = useI18n();
  const [busy, setBusy] = React.useState<LocaleCode | null>(null);
  const change = React.useCallback(async (next: LocaleCode) => {
    if (next === locale) return;
    setBusy(next);
    const ok = await setLocale(next);
    setBusy(null);
    const info = UI_LANGUAGE_OPTIONS.find((l) => l.code === next);
    // The toast is written in the new language's own name; the page re-renders in it right after.
    if (ok) toast.success(t("shell.languageChanged", { language: info?.native ?? next }));
    else toast.error(t("shell.languageFailed"));
  }, [locale, setLocale, t]);
  return { locale, change, busy };
}

/** Account-menu submenu: "Language" → the eight interface languages, current one checked. */
export function LocaleMenu() {
  const { t } = useI18n();
  const { locale, change, busy } = useChangeLocale();
  const current = UI_LANGUAGE_OPTIONS.find((l) => l.code === locale);
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <Languages />
        <span className="min-w-0 flex-1 truncate">{t("shell.interfaceLanguage")}</span>
        <span className="ms-2 shrink-0 text-[11px] text-muted-foreground" lang={current?.code}>{current?.native}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-52">
        {UI_LANGUAGE_OPTIONS.map((l) => (
          <DropdownMenuItem key={l.code} role="menuitemradio" aria-checked={l.code === locale} disabled={busy !== null} onSelect={(e) => { e.preventDefault(); void change(l.code); }}>
            <span className="flex-1" lang={l.code} dir={l.dir}>{l.native}</span>
            <span className="text-[11px] text-muted-foreground">{l.name}</span>
            {l.code === locale ? <Check className="size-3.5 text-muted-foreground" /> : <span className="size-3.5" aria-hidden />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

/** Inline select for Settings → Language & region and the setup page. */
export function LocaleSelect({ id, className, size = "sm", ariaLabel }: { id?: string; className?: string; size?: "xs" | "sm" | "default"; ariaLabel?: string }) {
  const { locale, change, busy } = useChangeLocale();
  return (
    <Select value={locale} onValueChange={(v) => void change(v as LocaleCode)} disabled={busy !== null}>
      <SelectTrigger id={id} size={size} className={cn("w-full", className)} aria-label={ariaLabel}><SelectValue /></SelectTrigger>
      <SelectContent>
        {UI_LANGUAGE_OPTIONS.map((l) => (
          <SelectItem key={l.code} value={l.code}>
            <span lang={l.code} dir={l.dir}>{l.native}</span>
            {l.code !== "en" && <span className="ms-1.5 text-muted-foreground">· {l.name}</span>}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
