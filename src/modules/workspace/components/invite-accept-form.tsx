"use client";

import * as React from "react";
import { AlertCircle, CheckCircle2, Loader2, LockKeyhole } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/form";
import type { FirmRole } from "@/modules/workspace/roles";

const PASSWORD_MIN = 12;

interface Invitation {
  email: string;
  firmName: string;
  firmRole: FirmRole;
  title?: string;
  expiresAt: string;
}

type ApiBody = {
  error?: string;
  fields?: Record<string, string>;
  next?: string;
};

export function InviteAcceptForm({ appName, token, invitation }: { appName: string; token: string; invitation: Invitation }) {
  const [firstName, setFirstName] = React.useState("");
  const [lastName, setLastName] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [touched, setTouched] = React.useState(false);
  const [fields, setFields] = React.useState<Record<string, string>>({});
  const [notice, setNotice] = React.useState<string | null>(null);

  const errors = {
    firstName: fields.firstName || (touched && !firstName.trim() ? "Enter your first name." : undefined),
    lastName: fields.lastName || (touched && !lastName.trim() ? "Enter your last name." : undefined),
    password: fields.password || (touched && password.length < PASSWORD_MIN ? `Use at least ${PASSWORD_MIN} characters.` : undefined),
    confirm: touched && confirm !== password ? "The passwords do not match." : undefined,
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setTouched(true);
    setFields({});
    setNotice(null);
    if (!firstName.trim() || !lastName.trim() || password.length < PASSWORD_MIN || confirm !== password) return;
    setBusy(true);
    try {
      const response = await fetch("/api/auth/invite", {
        method: "POST",
        headers: { "content-type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({ token, firstName: firstName.trim(), lastName: lastName.trim(), password }),
      });
      const body = (await response.json().catch(() => ({}))) as ApiBody;
      if (response.ok) {
        window.location.assign(body.next || "/");
        return;
      }
      if (body.fields) setFields(body.fields);
      setNotice(body.error || `Could not create the account (${response.status}).`);
    } catch {
      setNotice("Could not reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  const expires = new Date(invitation.expiresAt).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  return (
    <main className="h-full overflow-y-auto bg-background">
      <div className="mx-auto flex min-h-full w-full max-w-[440px] flex-col justify-center px-6 py-12">
        <div className="mb-7">
          <div className="text-[12px] font-medium tracking-wide text-muted-foreground" dir="ltr">
            {appName} · {invitation.firmName}
          </div>
          <h1 className="mt-2 text-[22px] font-semibold tracking-tight text-foreground">Create your account</h1>
          <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
            Your administrator assigned <span className="font-medium text-foreground">{invitation.email}</span> to
            {" "}{invitation.firmName} as {invitation.title || invitation.firmRole}.
          </p>
        </div>

        <form onSubmit={submit} noValidate className="space-y-4 rounded-xl border bg-card p-5 shadow-sm">
          <div className="grid grid-cols-2 gap-3">
            <Field label="First name" htmlFor="invite-first" error={errors.firstName}>
              <Input id="invite-first" autoFocus autoComplete="given-name" value={firstName} onChange={(e) => setFirstName(e.target.value)} disabled={busy} />
            </Field>
            <Field label="Last name" htmlFor="invite-last" error={errors.lastName}>
              <Input id="invite-last" autoComplete="family-name" value={lastName} onChange={(e) => setLastName(e.target.value)} disabled={busy} />
            </Field>
          </div>

          <Field label="Email" htmlFor="invite-email" help="Your administrator assigned this email to the account.">
            <Input id="invite-email" value={invitation.email} readOnly disabled />
          </Field>

          <Field label="Password" htmlFor="invite-password" error={errors.password} help={`At least ${PASSWORD_MIN} characters.`}>
            <Input id="invite-password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} />
          </Field>

          <Field label="Confirm password" htmlFor="invite-confirm" error={errors.confirm}>
            <Input id="invite-confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} disabled={busy} />
          </Field>

          {notice && (
            <div role="alert" className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[12.5px] text-destructive">
              <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
              <span>{notice}</span>
            </div>
          )}
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <LockKeyhole className="size-4" />}
            {busy ? "Creating account…" : "Create account"}
          </Button>

          <div className="flex items-start gap-2 border-t pt-3 text-[11.5px] leading-relaxed text-muted-foreground">
            <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" />
            <span>This single-use invitation expires {expires}. Your password is chosen here and is never visible to the administrator.</span>
          </div>
        </form>
      </div>
    </main>
  );
}
