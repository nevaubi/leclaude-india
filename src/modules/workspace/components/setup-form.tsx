"use client";
import * as React from "react";
import { LocaleSelect } from "@/components/shell/locale-switcher";
import type { TFunction } from "@/lib/i18n/translator";
import { useT } from "@/lib/i18n/client";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EMAIL_RE, FIRM_ROLES, type FirmRole } from "../roles";

type Errors = Partial<Record<"firmName" | "name" | "email" | "role" | "form", string>>;

function validate(v: { firmName: string; name: string; email: string; role: FirmRole | "" }, t: TFunction): Errors {
  const e: Errors = {};
  if (!v.firmName.trim()) e.firmName = t("setup.err.firm");
  if (!v.name.trim()) e.name = t("setup.err.name");
  if (!v.email.trim()) e.email = t("setup.err.email");
  else if (!EMAIL_RE.test(v.email.trim())) e.email = t("setup.err.emailInvalid");
  if (!v.role) e.role = t("setup.err.role");
  return e;
}

/** First-run setup form: the firm and the owner account. One column, one primary action. */
export function SetupForm({ appName, defaultFirmName }: { appName: string; defaultFirmName?: string }) {
  const t = useT();
  const [firmName, setFirmName] = React.useState(defaultFirmName ?? "");
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [role, setRole] = React.useState<FirmRole | "">("");
  const [errors, setErrors] = React.useState<Errors>({});
  const [touched, setTouched] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const values = { firmName, name, email, role };
  const live = touched ? validate(values, t) : {};
  const shown: Errors = { ...live, ...errors };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
    const v = validate(values, t);
    if (Object.keys(v).length) { setErrors({}); return; }
    setBusy(true);
    setErrors({});
    try {
      const res = await fetch("/api/workspace", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ firmName: firmName.trim(), name: name.trim(), email: email.trim(), role }) });
      const body = (await res.json().catch(() => ({}))) as { error?: string; fields?: Record<string, string> };
      if (res.status === 409) { window.location.assign("/matters"); return; }
      if (!res.ok) {
        setErrors({ ...(body.fields ?? {}), form: body.fields ? undefined : body.error ?? t("setup.err.failed", { status: res.status }) });
        setBusy(false);
        return;
      }
      // A full navigation so the root layout re-reads the workspace and renders the shell for the new owner.
      window.location.assign("/matters?new=1");
    } catch (err) {
      setErrors({ form: t("setup.err.unreachable", { message: (err as Error).message }) });
      setBusy(false);
    }
  };

  return (
    <main className="h-full overflow-y-auto bg-background">
      <div className="mx-auto flex min-h-full w-full max-w-[420px] flex-col justify-center px-6 py-12">
        <div className="mb-8">
          <div className="text-[12px] font-medium tracking-wide text-muted-foreground" dir="ltr">{appName}</div>
          <h1 className="mt-2 text-[20px] font-semibold tracking-tight text-foreground">{t("setup.title")}</h1>
          <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">{t("setup.intro")}</p>
        </div>
        <form onSubmit={submit} noValidate className="space-y-4" aria-label={t("setup.formAria")}>
          <Field label={t("setup.language")} htmlFor="setup-language">
            <LocaleSelect id="setup-language" ariaLabel={t("setup.language")} />
          </Field>
          <Field label={t("setup.firmName")} required htmlFor="setup-firm" error={shown.firmName}>
            <Input id="setup-firm" size="sm" autoFocus autoComplete="organization" value={firmName} onChange={(e) => setFirmName(e.target.value)} aria-invalid={!!shown.firmName} />
          </Field>
          <Field label={t("setup.fullName")} required htmlFor="setup-name" error={shown.name}>
            <Input id="setup-name" size="sm" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} aria-invalid={!!shown.name} />
          </Field>
          <Field label={t("setup.email")} required htmlFor="setup-email" error={shown.email}>
            <Input id="setup-email" size="sm" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} aria-invalid={!!shown.email} />
          </Field>
          <Field label={t("setup.role")} required htmlFor="setup-role" error={shown.role}>
            <Select value={role} onValueChange={(v) => setRole(v as FirmRole)}>
              <SelectTrigger id="setup-role" size="sm" aria-invalid={!!shown.role}><SelectValue placeholder={t("setup.chooseRole")} /></SelectTrigger>
              <SelectContent>{FIRM_ROLES.map((r) => <SelectItem key={r} value={r}>{t(`role.${r}`)}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          {shown.form && <p className="text-[12px] text-destructive" role="alert">{shown.form}</p>}
          <Button type="submit" className="w-full" disabled={busy}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            {busy ? t("setup.creating") : t("setup.create")}
          </Button>
          <p className="text-[11.5px] leading-relaxed text-muted-foreground">{t("setup.footnote")}</p>
        </form>
      </div>
    </main>
  );
}
