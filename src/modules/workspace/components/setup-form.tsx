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

type Errors = Partial<Record<"firmName" | "name" | "email" | "role" | "password" | "confirm" | "token" | "form", string>>;

const PASSWORD_MIN = 12;

function validate(v: { firmName: string; name: string; email: string; role: FirmRole | ""; password: string; confirm: string; token: string; requireToken: boolean }, t: TFunction): Errors {
  const e: Errors = {};
  if (!v.firmName.trim()) e.firmName = t("setup.err.firm");
  if (!v.name.trim()) e.name = t("setup.err.name");
  if (!v.email.trim()) e.email = t("setup.err.email");
  else if (!EMAIL_RE.test(v.email.trim())) e.email = t("setup.err.emailInvalid");
  if (!v.role) e.role = t("setup.err.role");
  // Sign-in password for the owner (English until the catalogues carry auth strings).
  if (v.password.length < PASSWORD_MIN) e.password = `Use at least ${PASSWORD_MIN} characters.`;
  else if (v.confirm !== v.password) e.confirm = "The passwords do not match.";
  if (v.requireToken && !v.token.trim()) e.token = "Enter the setup token.";
  return e;
}

/** First-run setup form: the firm and the owner account. One column, one primary action. */
export function SetupForm({ appName, defaultFirmName, requireToken = false }: { appName: string; defaultFirmName?: string; requireToken?: boolean }) {
  const t = useT();
  const [firmName, setFirmName] = React.useState(defaultFirmName ?? "");
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [role, setRole] = React.useState<FirmRole | "">("");
  const [password, setPassword] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [token, setToken] = React.useState("");
  const [errors, setErrors] = React.useState<Errors>({});
  const [touched, setTouched] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const values = { firmName, name, email, role, password, confirm, token, requireToken };
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
      // With sign-in enforced, setup goes through the token-gated bootstrap, which also signs the owner in.
      const url = requireToken ? "/api/auth/bootstrap" : "/api/workspace";
      const payload = { firmName: firmName.trim(), name: name.trim(), email: email.trim(), role, password, ...(requireToken ? { token: token.trim() } : {}) };
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      const body = (await res.json().catch(() => ({}))) as { error?: string; fields?: Record<string, string> };
      if (res.status === 409) { window.location.assign(requireToken ? "/login" : "/matters"); return; }
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
          <Field label="Password" required htmlFor="setup-password" error={shown.password} help={`Your sign-in password. At least ${PASSWORD_MIN} characters.`}>
            <Input id="setup-password" size="sm" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} aria-invalid={!!shown.password} />
          </Field>
          <Field label="Confirm password" required htmlFor="setup-confirm" error={shown.confirm}>
            <Input id="setup-confirm" size="sm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} aria-invalid={!!shown.confirm} />
          </Field>
          {requireToken && (
            <Field label="Setup token" required htmlFor="setup-token" error={shown.token} help="The value of AUTH_SETUP_TOKEN in the deployment settings.">
              <Input id="setup-token" size="sm" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} aria-invalid={!!shown.token} />
            </Field>
          )}
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
