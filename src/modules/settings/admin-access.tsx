"use client";

import * as React from "react";
import { Ban, Building2, Copy, Loader2, RefreshCw, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SettingsBlock } from "@/modules/settings/settings-section";
import { FIRM_ROLES, type FirmRole, type TeamMember } from "@/modules/workspace/roles";

type Firm = {
  id: string;
  name: string;
  description?: string;
  jurisdiction?: string;
  matterIds: "*" | string[];
  userCount: number;
};

type Invite = {
  id: string;
  email: string;
  firmId: string;
  firmName: string;
  firmRole: FirmRole;
  title?: string;
  status: "pending" | "accepted" | "revoked" | "expired";
  expiresAt: string;
  emailDelivery?: "sent" | "not_configured" | "failed";
};

type Matter = { id: string; name: string; shortName?: string; status?: string };
type View = { firms: Firm[]; invitations: Invite[]; users: TeamMember[]; matters: Matter[] };
type ActionResult = { error?: string; fields?: Record<string, string>; inviteUrl?: string; emailSent?: boolean; emailError?: string };

async function api(body?: Record<string, unknown>): Promise<{ ok: boolean; body: View & ActionResult }> {
  const response = await fetch("/api/admin/access", body ? {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  } : { cache: "no-store" });
  return { ok: response.ok, body: (await response.json().catch(() => ({}))) as View & ActionResult };
}

function ScopeLabel({ firm, matters }: { firm: Firm; matters: Matter[] }) {
  if (firm.matterIds === "*") return <span>All matters</span>;
  if (!firm.matterIds.length) return <span>No matters</span>;
  const names = firm.matterIds.map((id) => matters.find((m) => m.id === id)?.shortName || matters.find((m) => m.id === id)?.name || id);
  return <span>{names.slice(0, 3).join(", ")}{names.length > 3 ? " +" + (names.length - 3) : ""}</span>;
}

export function AdminAccessSettings() {
  const [view, setView] = React.useState<View | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [lastInviteUrl, setLastInviteUrl] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    const r = await api();
    if (r.ok) setView(r.body);
    else toast.error(r.body.error || "Could not load account administration.");
    setLoading(false);
  }, []);

  React.useEffect(() => { void load(); }, [load]);

  if (loading || !view) {
    return <div className="flex h-20 items-center justify-center text-muted-foreground"><Loader2 className="size-4 animate-spin" /></div>;
  }

  return (
    <div className="mb-6 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-[14px] font-semibold">Account administration</h3>
          <p className="mt-1 max-w-2xl text-[12.5px] leading-relaxed text-muted-foreground">
            Create mock firms, define their matter scope, and invite users. Invited users choose their own name and password.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => void load()}><RefreshCw className="size-3.5" />Refresh</Button>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <FirmCreator view={view} busy={busy} setBusy={setBusy} onDone={load} />
        <InviteCreator view={view} busy={busy} setBusy={setBusy} onDone={load} onInviteUrl={setLastInviteUrl} />
      </div>

      {lastInviteUrl && (
        <div className="flex items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2">
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Latest invite link</div>
            <div className="truncate font-mono text-[11.5px]">{lastInviteUrl}</div>
          </div>
          <Button size="sm" variant="outline" onClick={() => { void navigator.clipboard.writeText(lastInviteUrl); toast.success("Invite link copied"); }}>
            <Copy className="size-3.5" />Copy
          </Button>
        </div>
      )}

      <SettingsBlock title="Mock firms">
        <div className="divide-y">
          {view.firms.map((firm) => (
            <div key={firm.id} className="grid gap-2 py-2.5 text-[12px] sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_90px]">
              <div className="min-w-0">
                <div className="font-medium">{firm.name}</div>
                <div className="truncate text-muted-foreground">{[firm.jurisdiction, firm.description].filter(Boolean).join(" · ") || "No additional details"}</div>
              </div>
              <div className="text-muted-foreground"><ScopeLabel firm={firm} matters={view.matters} /></div>
              <div className="text-right tabular-nums text-muted-foreground">{firm.userCount} user{firm.userCount === 1 ? "" : "s"}</div>
            </div>
          ))}
        </div>
      </SettingsBlock>

      <SettingsBlock title="Invitations">
        <div className="divide-y">
          {view.invitations.length === 0 && <div className="py-4 text-[12px] text-muted-foreground">No invitations yet.</div>}
          {view.invitations.map((invite) => (
            <div key={invite.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5 text-[12px]">
              <div className="min-w-[180px] flex-1">
                <div className="font-medium">{invite.email}</div>
                <div className="text-muted-foreground">{invite.firmName} · {invite.title || invite.firmRole}</div>
              </div>
              <Badge size="sm" variant={invite.status === "accepted" ? "success" : invite.status === "pending" ? "accent" : invite.status === "expired" ? "warning" : "info"}>
                {invite.status}
              </Badge>
              <span className="text-[11px] text-muted-foreground">
                {invite.emailDelivery === "sent" ? "Email sent" : invite.emailDelivery === "failed" ? "Email failed" : invite.emailDelivery === "not_configured" ? "Copy link" : ""}
              </span>
              {invite.status === "pending" && (
                <>
                  <Button size="xs" variant="ghost" disabled={busy === invite.id} onClick={() => void resend(invite.id)}>
                    <RefreshCw className="size-3" />Resend
                  </Button>
                  <Button size="xs" variant="ghost" disabled={busy === invite.id} onClick={() => void revoke(invite.id)}>
                    <Ban className="size-3" />Revoke
                  </Button>
                </>
              )}
            </div>
          ))}
        </div>
      </SettingsBlock>

      <SettingsBlock title="Provisioned users">
        <div className="divide-y">
          {view.users.map((user) => (
            <div key={user.id} className="grid items-center gap-2 py-2.5 text-[12px] sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_110px]">
              <div className="min-w-0">
                <div className="font-medium">{user.name}{user.platformAdmin ? " · Platform admin" : ""}</div>
                <div className="truncate text-muted-foreground">{user.email || "No email"}</div>
              </div>
              <div className="text-muted-foreground">{user.firmName || "Default firm"} · {user.firmRole || user.title || "Member"}</div>
              <div className="text-right"><Badge size="sm" variant={user.active ? "success" : "info"}>{user.active ? "Active" : "Inactive"}</Badge></div>
            </div>
          ))}
        </div>
      </SettingsBlock>
    </div>
  );

  async function resend(id: string) {
    setBusy(id);
    const r = await api({ action: "resend_invite", id });
    setBusy(null);
    if (!r.ok) return toast.error(r.body.error || "Could not resend invitation.");
    if (r.body.inviteUrl) setLastInviteUrl(r.body.inviteUrl);
    toast.success(r.body.emailSent ? "Invitation resent" : "Invite link regenerated");
    await load();
  }

  async function revoke(id: string) {
    setBusy(id);
    const r = await api({ action: "revoke_invite", id });
    setBusy(null);
    if (!r.ok) return toast.error(r.body.error || "Could not revoke invitation.");
    toast.success("Invitation revoked");
    await load();
  }
}

function FirmCreator({ view, busy, setBusy, onDone }: { view: View; busy: string | null; setBusy: (v: string | null) => void; onDone: () => Promise<void> }) {
  const [name, setName] = React.useState("");
  const [jurisdiction, setJurisdiction] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [allMatters, setAllMatters] = React.useState(true);
  const [selected, setSelected] = React.useState<string[]>([]);

  const toggleMatter = (id: string, checked: boolean) => {
    setSelected((prev) => checked ? Array.from(new Set([...prev, id])) : prev.filter((x) => x !== id));
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return toast.error("Enter a firm name.");
    setBusy("firm");
    const r = await api({
      action: "create_firm",
      name: name.trim(),
      jurisdiction: jurisdiction.trim(),
      description: description.trim(),
      matterIds: allMatters ? "*" : selected,
    });
    setBusy(null);
    if (!r.ok) return toast.error(r.body.error || "Could not create firm.");
    setName(""); setJurisdiction(""); setDescription(""); setSelected([]); setAllMatters(true);
    toast.success("Mock firm created");
    await onDone();
  };

  return (
    <form onSubmit={submit} className="rounded-xl border bg-card p-4">
      <div className="mb-3 flex items-center gap-2"><Building2 className="size-4" /><h4 className="text-[13px] font-semibold">Create mock firm</h4></div>
      <div className="space-y-3">
        <Field label="Firm name" htmlFor="admin-firm-name"><Input id="admin-firm-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Sharma & Rao LLP" /></Field>
        <Field label="Jurisdiction / office" htmlFor="admin-firm-jurisdiction"><Input id="admin-firm-jurisdiction" value={jurisdiction} onChange={(e) => setJurisdiction(e.target.value)} placeholder="Delhi · Supreme Court / NCLT" /></Field>
        <Field label="Details" htmlFor="admin-firm-description"><Textarea id="admin-firm-description" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional mock-firm notes or practice scope" className="min-h-16" /></Field>

        <div className="rounded-md border p-3">
          <label className="flex cursor-pointer items-center gap-2 text-[12px] font-medium">
            <Checkbox size="sm" checked={allMatters} onCheckedChange={(v) => setAllMatters(v === true)} />
            Access all matters
          </label>
          {!allMatters && (
            <div className="mt-2 max-h-32 space-y-1.5 overflow-auto border-t pt-2">
              {view.matters.map((matter) => (
                <label key={matter.id} className="flex cursor-pointer items-center gap-2 text-[11.5px]">
                  <Checkbox size="xs" checked={selected.includes(matter.id)} onCheckedChange={(v) => toggleMatter(matter.id, v === true)} />
                  <span>{matter.shortName || matter.name}</span>
                </label>
              ))}
              {view.matters.length === 0 && <div className="text-muted-foreground">No matters are loaded yet.</div>}
            </div>
          )}
        </div>

        <Button type="submit" size="sm" disabled={busy === "firm"}>{busy === "firm" ? <Loader2 className="size-3.5 animate-spin" /> : <Building2 className="size-3.5" />}Create firm</Button>
      </div>
    </form>
  );
}

function InviteCreator({ view, busy, setBusy, onDone, onInviteUrl }: { view: View; busy: string | null; setBusy: (v: string | null) => void; onDone: () => Promise<void>; onInviteUrl: (url: string) => void }) {
  const [email, setEmail] = React.useState("");
  const [firmId, setFirmId] = React.useState(view.firms[0]?.id || "");
  const [role, setRole] = React.useState<FirmRole>("Associate");
  const [title, setTitle] = React.useState("");

  React.useEffect(() => {
    if (!firmId && view.firms[0]) setFirmId(view.firms[0].id);
  }, [firmId, view.firms]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!email.trim() || !firmId) return toast.error("Enter an email and choose a firm.");
    setBusy("invite");
    const r = await api({ action: "invite_user", email: email.trim(), firmId, firmRole: role, title: title.trim() });
    setBusy(null);
    if (!r.ok) return toast.error(r.body.error || "Could not create invitation.");
    if (r.body.inviteUrl) onInviteUrl(r.body.inviteUrl);
    setEmail(""); setTitle("");
    toast.success(r.body.emailSent ? "Invitation email sent" : "Invitation created — copy the link below");
    if (r.body.emailError && r.body.emailError !== "Email delivery is not configured.") toast.warning(r.body.emailError);
    await onDone();
  };

  return (
    <form onSubmit={submit} className="rounded-xl border bg-card p-4">
      <div className="mb-3 flex items-center gap-2"><UserPlus className="size-4" /><h4 className="text-[13px] font-semibold">Invite user</h4></div>
      <div className="space-y-3">
        <Field label="Email" htmlFor="admin-invite-email"><Input id="admin-invite-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="lawyer@example.com" /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Mock firm" htmlFor="admin-invite-firm">
            <Select value={firmId} onValueChange={setFirmId}>
              <SelectTrigger id="admin-invite-firm"><SelectValue placeholder="Choose firm" /></SelectTrigger>
              <SelectContent>{view.firms.map((firm) => <SelectItem key={firm.id} value={firm.id}>{firm.name}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <Field label="Role" htmlFor="admin-invite-role">
            <Select value={role} onValueChange={(v) => setRole(v as FirmRole)}>
              <SelectTrigger id="admin-invite-role"><SelectValue /></SelectTrigger>
              <SelectContent>{FIRM_ROLES.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
        </div>
        <Field label="Title (optional)" htmlFor="admin-invite-title"><Input id="admin-invite-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Senior Associate" /></Field>

        <div className="rounded-md bg-muted/40 px-3 py-2 text-[11.5px] leading-relaxed text-muted-foreground">
          The user inherits the selected firm's matter scope. They choose their own first name, last name and password from a single-use invitation link.
        </div>
        <Button type="submit" size="sm" disabled={busy === "invite" || view.firms.length === 0}>
          {busy === "invite" ? <Loader2 className="size-3.5 animate-spin" /> : <UserPlus className="size-3.5" />}Send invitation
        </Button>
      </div>
    </form>
  );
}
