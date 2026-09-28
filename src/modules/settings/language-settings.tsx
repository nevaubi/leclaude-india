"use client";
import * as React from "react";
import { toast } from "sonner";
import { LANGUAGES, type LocaleCode } from "@/lib/india/languages";
import { useI18n } from "@/lib/i18n/client";
import { inrWords } from "@/lib/i18n/format";
import type { AnswerLanguage } from "@/lib/i18n/answer-language";
import { Field, KeyValueList } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { LocaleSelect, UI_LANGUAGE_OPTIONS } from "@/components/shell/locale-switcher";

export interface LanguageSettingsInitial {
  userAnswerLanguage: AnswerLanguage | null;
  answerLanguage: AnswerLanguage;
  workspace: { defaultLocale: LocaleCode; answerLanguage: AnswerLanguage; timeZone: string };
  canManageWorkspace: boolean;
}

/** A sample from the record: dates, amounts and counts as Indian court papers write them. */
const SAMPLE_DATE = "2024-05-31";
const SAMPLE_AMOUNT = 1250000;
const SAMPLE_COUNT = 12345678;

async function put(body: unknown): Promise<boolean> {
  try {
    const res = await fetch("/api/i18n", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Settings → Language & region: the member's interface and answer languages, the workspace default (owner,
 * partner or admin only; the server enforces it) and the regional formats the interface uses.
 */
export function LanguageSettings({ initial }: { initial: LanguageSettingsInitial }) {
  const i18n = useI18n();
  const { t } = i18n;
  const [answer, setAnswer] = React.useState<AnswerLanguage>(initial.userAnswerLanguage ?? initial.answerLanguage);
  const [wsLocale, setWsLocale] = React.useState<LocaleCode>(initial.workspace.defaultLocale);
  const [wsAnswer, setWsAnswer] = React.useState<AnswerLanguage>(initial.workspace.answerLanguage);
  const [busy, setBusy] = React.useState(false);

  const save = async (body: unknown, apply: () => void, revert: () => void) => {
    setBusy(true);
    apply();
    const ok = await put(body);
    setBusy(false);
    if (ok) toast.success(t("settings.lang.saved"));
    else { revert(); toast.error(t("settings.lang.saveFailed")); }
  };

  const answerOptions = (
    <SelectContent>
      <SelectItem value="auto">{t("settings.lang.answerAuto")}</SelectItem>
      <SelectSeparator />
      {LANGUAGES.map((l) => (
        <SelectItem key={l.code} value={l.code}>
          <span lang={l.code} dir={l.dir}>{l.native}</span>
          {l.code !== "en" && <span className="ms-1.5 text-muted-foreground">· {l.name}</span>}
        </SelectItem>
      ))}
    </SelectContent>
  );

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("settings.lang.interface")} help={t("settings.lang.interfaceHelp")} htmlFor="lang-ui">
          <LocaleSelect id="lang-ui" ariaLabel={t("settings.lang.interface")} />
        </Field>
        <Field label={t("settings.lang.answer")} help={t("settings.lang.answerHelp")} htmlFor="lang-answer">
          <Select value={answer} disabled={busy} onValueChange={(v) => { const prev = answer; void save({ answerLanguage: v }, () => setAnswer(v as AnswerLanguage), () => setAnswer(prev)); }}>
            <SelectTrigger id="lang-answer" size="sm" className="w-full" aria-label={t("settings.lang.answer")}><SelectValue /></SelectTrigger>
            {answerOptions}
          </Select>
        </Field>
      </div>

      <div className="rounded-md border px-3 py-2.5">
        <div className="mb-2 flex items-baseline gap-2">
          <div className="text-[12.5px] font-medium">{t("settings.lang.workspaceDefault")}</div>
          <div className="min-w-0 truncate text-[11.5px] text-muted-foreground">{initial.canManageWorkspace ? t("settings.lang.workspaceDefaultHelp") : t("settings.lang.workspaceOnlyAdmins")}</div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("settings.lang.interface")} htmlFor="lang-ws-ui">
            <Select value={wsLocale} disabled={busy || !initial.canManageWorkspace} onValueChange={(v) => { const prev = wsLocale; void save({ workspace: { defaultLocale: v } }, () => setWsLocale(v as LocaleCode), () => setWsLocale(prev)); }}>
              <SelectTrigger id="lang-ws-ui" size="sm" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                {UI_LANGUAGE_OPTIONS.map((l) => (
                  <SelectItem key={l.code} value={l.code}><span lang={l.code} dir={l.dir}>{l.native}</span>{l.code !== "en" && <span className="ms-1.5 text-muted-foreground">· {l.name}</span>}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label={t("settings.lang.answer")} htmlFor="lang-ws-answer">
            <Select value={wsAnswer} disabled={busy || !initial.canManageWorkspace} onValueChange={(v) => { const prev = wsAnswer; void save({ workspace: { answerLanguage: v } }, () => setWsAnswer(v as AnswerLanguage), () => setWsAnswer(prev)); }}>
              <SelectTrigger id="lang-ws-answer" size="sm" className="w-full"><SelectValue /></SelectTrigger>
              {answerOptions}
            </Select>
          </Field>
        </div>
      </div>

      <div>
        <div className="mb-1 text-[12.5px] font-medium">{t("settings.lang.formats")}</div>
        <KeyValueList dense labelWidth={140} items={[
          { label: t("settings.lang.timeZone"), value: t("settings.lang.timeZoneValue") },
          { label: t("settings.lang.date"), value: <span className="tabular"><bdi>{i18n.date(SAMPLE_DATE, "numeric")}</bdi> · <bdi>{i18n.date(SAMPLE_DATE, "medium")}</bdi> · <bdi>{i18n.date(SAMPLE_DATE, "full")}</bdi></span> },
          { label: t("settings.lang.numbers"), value: <span className="tabular" dir="ltr">{i18n.number(SAMPLE_COUNT)}</span> },
          { label: t("settings.lang.currency"), value: <span className="tabular" dir="ltr">{i18n.currency(SAMPLE_AMOUNT)} · {inrWords(SAMPLE_AMOUNT)}</span> },
        ]} />
        <p className="mt-2 text-[11.5px] text-muted-foreground">{t("settings.lang.machineNote")}</p>
      </div>
    </div>
  );
}
