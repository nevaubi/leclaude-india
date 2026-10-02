"use client";
import * as React from "react";
import { AlertCircle, Clock, KeyRound, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/form";

export interface LoginStatus {
  needsOwnerPassword: boolean;
  setupTokenConfigured: boolean;
  signInConfigured: boolean;
}

const PASSWORD_MIN = 12;

type Notice = { tone: "error" | "wait"; text: string } | null;

function Shell({ appName, firmName, title, intro, children }: { appName: string; firmName?: string; title: string; intro?: React.ReactNode; children: React.ReactNode }) {
  return (
    <main className="h-full overflow-y-auto bg-background">
      <div className="mx-auto flex min-h-full w-full max-w-[400px] flex-col justify-center px-6 py-12">
        <div className="mb-7">
          <div className="text-[12px] font-medium tracking-wide text-muted-foreground" dir="ltr">{[appName, firmName].filter(Boolean).join(" · ")}</div>
          <h1 className="mt-2 text-[20px] font-semibold tracking-tight text-foreground">{title}</h1>
          {intro && <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">{intro}</p>}
        </div>
        {children}
      </div>
    </main>
  );
}

function NoticeLine({ notice }: { notice: Notice }) {
  if (!notice) return null;
  const Icon = notice.tone === "wait" ? Clock : AlertCircle;
  return (
    <div role="alert" className={notice.tone === "wait" ? "flex items-start gap-2 rounded-md border bg-muted/40 px-3 py-2 text-[12.5px] text-foreground" : "flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[12.5px] text-destructive"}>
      <Icon className="mt-0.5 size-3.5 shrink-0" />
      <span>{notice.text}</span>
    </div>
  );
}

async function postJson(url: string, body: unknown): Promise<{ status: number; body: { error?: string; code?: string; retryAfter?: number; next?: string; fields?: Record<string, string> } }> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as { error?: string; code?: string; retryAfter?: number; next?: string } };
}

/** Sign-in page body: email + password, or the one-time owner password step while no account has one. */
export function LoginForm({ appName, firmName, next, status }: { appName: string; firmName?: string; next: string; status: LoginStatus }) {
  if (!status.signInConfigured) {
    return (
      <Shell appName={appName} firmName={firmName} title="Sign-in is not available">
        <NoticeLine notice={{ tone: "error", text: "Sign-in is not configured on this deployment. An administrator must set AUTH_JWT_SECRET (at least 32 characters) and redeploy." }} />
      </Shell>
    );
  }
  if (status.needsOwnerPassword) {
    if (!status.setupTokenConfigured) {
      return (
        <Shell appName={appName} firmName={firmName} title="Owner account not set up" intro="No one in this workspace has a password yet.">
          <NoticeLine notice={{ tone: "error", text: "An administrator must set AUTH_SETUP_TOKEN on the deployment, then return here to set the owner's password." }} />
        </Shell>
      );
    }
    return <OwnerPasswordForm appName={appName} firmName={firmName} next={next} />;
  }
  return <SignInForm appName={appName} firmName={firmName} next={next} />;
}

function SignInForm({ appName, firmName, next }: { appName: string; firmName?: string; next: string }) {
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState<Notice>(null);
  const [waitUntil, setWaitUntil] = React.useState<number | null>(null);
  const [now, setNow] = React.useState(() => Date.now());
  const [touched, setTouched] = React.useState(false);

  React.useEffect(() => {
    if (!waitUntil) return;
    const t = window.setInterval(() => {
      const n = Date.now();
      setNow(n);
      if (n >= waitUntil) {
        setWaitUntil(null);
        setNotice(null);
      }
    }, 1000);
    return () => window.clearInterval(t);
  }, [waitUntil]);

  const waiting = waitUntil != null && now < waitUntil;
  const emailError = touched && !email.trim() ? "Enter your email." : undefined;
  const passwordError = touched && !password ? "Enter your password." : undefined;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!email.trim() || !password || waiting) return;
    setBusy(true);
    setNotice(null);
    try {
      const r = await postJson("/api/auth/login", { email: email.trim(), password, next });
      if (r.status === 200) {
        // Full navigation: the root layout re-reads the signed-in member.
        window.location.assign(r.body.next || next || "/");
        return;
      }
      // Clear the password for the next try without flagging the now-empty field as a validation error.
      setPassword("");
      setTouched(false);
      if (r.status === 429) {
        const secs = Math.max(1, Number(r.body.retryAfter) || 60);
        setWaitUntil(Date.now() + secs * 1000);
        setNow(Date.now());
        setNotice({ tone: "wait", text: r.body.error ?? "Too many sign-in attempts. Try again later." });
      } else {
        setNotice({ tone: "error", text: r.body.error ?? `Sign-in failed (${r.status}).` });
      }
    } catch {
      setNotice({ tone: "error", text: "Could not reach the server. Check your connection and try again." });
    } finally {
      setBusy(false);
    }
  };

  const remaining = waiting ? Math.ceil((waitUntil! - now) / 1000) : 0;
  return (
    <Shell appName={appName} firmName={firmName} title="Sign in" intro="Use the email and password your workspace administrator set for you.">
      <form onSubmit={submit} noValidate className="space-y-4" aria-label="Sign in">
        <Field label="Email" htmlFor="login-email" error={emailError}>
          <Input id="login-email" size="sm" type="email" autoComplete="username" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} aria-invalid={!!emailError} disabled={busy} />
        </Field>
        <Field label="Password" htmlFor="login-password" error={passwordError}>
          <Input id="login-password" size="sm" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} aria-invalid={!!passwordError} disabled={busy} />
        </Field>
        <NoticeLine notice={notice} />
        <Button type="submit" className="w-full" disabled={busy || waiting}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : null}
          {busy ? "Signing in…" : waiting ? `Try again in ${remaining}s` : "Sign in"}
        </Button>
        <p className="text-[11.5px] leading-relaxed text-muted-foreground">Forgot your password? Ask the workspace owner or an administrator to reset it in Settings › Team.</p>
      </form>
    </Shell>
  );
}

function OwnerPasswordForm({ appName, firmName, next }: { appName: string; firmName?: string; next: string }) {
  const [token, setToken] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [touched, setTouched] = React.useState(false);
  const [notice, setNotice] = React.useState<Notice>(null);
  const [fields, setFields] = React.useState<Record<string, string>>({});

  const errors = {
    token: touched && !token.trim() ? "Enter the setup token." : fields.token,
    password: touched && password.length < PASSWORD_MIN ? `Use at least ${PASSWORD_MIN} characters.` : fields.password,
    confirm: touched && confirm !== password ? "The passwords do not match." : undefined,
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
    setFields({});
    if (!token.trim() || password.length < PASSWORD_MIN || confirm !== password) return;
    setBusy(true);
    setNotice(null);
    try {
      const r = await postJson("/api/auth/bootstrap", { token: token.trim(), password });
      if (r.status === 201) {
        window.location.assign(next || "/");
        return;
      }
      if (r.status === 409 && r.body.code === "already_bootstrapped") {
        window.location.assign(`/login${next && next !== "/" ? `?next=${encodeURIComponent(next)}` : ""}`);
        return;
      }
      if (r.body.fields) setFields(r.body.fields);
      setNotice({ tone: r.status === 429 ? "wait" : "error", text: r.body.error ?? `Could not set the password (${r.status}).` });
    } catch {
      setNotice({ tone: "error", text: "Could not reach the server. Check your connection and try again." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell appName={appName} firmName={firmName} title="Set the owner password" intro="One-time step: no one in this workspace has a password yet. Enter the setup token from the deployment settings and choose the owner's password.">
      <form onSubmit={submit} noValidate className="space-y-4" aria-label="Set the owner password">
        <Field label="Setup token" htmlFor="boot-token" error={errors.token} help="The value of AUTH_SETUP_TOKEN.">
          <Input id="boot-token" size="sm" type="password" autoComplete="off" autoFocus value={token} onChange={(e) => setToken(e.target.value)} aria-invalid={!!errors.token} disabled={busy} />
        </Field>
        <Field label="New password" htmlFor="boot-password" error={errors.password} help={`At least ${PASSWORD_MIN} characters.`}>
          <Input id="boot-password" size="sm" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} aria-invalid={!!errors.password} disabled={busy} />
        </Field>
        <Field label="Confirm password" htmlFor="boot-confirm" error={errors.confirm}>
          <Input id="boot-confirm" size="sm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} aria-invalid={!!errors.confirm} disabled={busy} />
        </Field>
        <NoticeLine notice={notice} />
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : <KeyRound className="size-4" />}
          {busy ? "Saving…" : "Set password and sign in"}
        </Button>
      </form>
    </Shell>
  );
}
