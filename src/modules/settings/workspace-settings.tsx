"use client";
import * as React from "react";
import { useT } from "@/lib/i18n/client";
import Link from "next/link";
import { Loader2, Pencil } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, KeyValueList } from "@/components/ui/form";
import { apiJSON, ApiError } from "@/modules/matters/components/api";
import type { WorkspaceView } from "@/modules/workspace/roles";

/**
 * Settings → Workspace: the firm name and the owner recorded at setup. The owner (or a partner/admin) edits
 * them through PUT /api/workspace; the server enforces who may. Before setup, points to /setup.
 */
export function WorkspaceSettings({ initial }: { initial: WorkspaceView }) {
  const t = useT();
  const [view, setView] = React.useState<WorkspaceView>(initial);
  const [editing, setEditing] = React.useState(false);
  const [firmName, setFirmName] = React.useState(initial.firmName);
  const [ownerName, setOwnerName] = React.useState(initial.owner?.name ?? "");
  const [ownerEmail, setOwnerEmail] = React.useState(initial.owner?.email ?? "");
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState(false);

  if (!view.configured || !view.owner) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2.5 text-[12.5px]" role="status">
        <span className="text-muted-foreground">{t("settings.ws.notSetUp")}</span>
        <Button size="xs" asChild><Link href="/setup">{t("settings.ws.setUp")}</Link></Button>
      </div>
    );
  }

  const reset = () => { setFirmName(view.firmName); setOwnerName(view.owner?.name ?? ""); setOwnerEmail(view.owner?.email ?? ""); setErrors({}); setEditing(false); };
  const save = async () => {
    const next: Record<string, string> = {};
    if (!firmName.trim()) next.firmName = t("settings.ws.enterFirm");
    if (!ownerName.trim()) next.name = t("settings.ws.enterName");
    if (Object.keys(next).length) { setErrors(next); return; }
    setBusy(true);
    try {
      const body: Record<string, string> = { firmName: firmName.trim(), name: ownerName.trim() };
      if (ownerEmail.trim()) body.email = ownerEmail.trim();
      const v = await apiJSON<WorkspaceView>("/api/workspace", { method: "PUT", json: body });
      setView(v);
      setErrors({});
      setEditing(false);
      toast.success(t("settings.ws.updated"));
    } catch (e) {
      if (e instanceof ApiError && e.fields) setErrors(e.fields);
      toast.error(t("settings.ws.updateFailed"), { description: (e as Error).message });
    } finally { setBusy(false); }
  };

  if (!editing) {
    return (
      <div className="rounded-md border">
        <div className="flex items-start gap-3 px-3 py-2.5">
          <div className="min-w-0 flex-1">
            <KeyValueList dense labelWidth={120} items={[
              { label: t("settings.ws.firm"), value: view.firmName },
              { label: t("settings.ws.owner"), value: view.owner.name },
              { label: t("settings.ws.email"), value: view.owner.email ?? "—", muted: !view.owner.email },
              { label: t("settings.ws.role"), value: view.owner.firmRole ? t(`role.${view.owner.firmRole}`) : view.owner.title ?? "—", muted: !(view.owner.firmRole ?? view.owner.title) },
            ]} />
          </div>
          <Button variant="ghost" size="xs" onClick={() => setEditing(true)}><Pencil className="size-3" /> {t("common.edit")}</Button>
        </div>
      </div>
    );
  }

  return (
    <form className="space-y-3 rounded-md border px-3 py-3" onSubmit={(e) => { e.preventDefault(); void save(); }} aria-label={t("settings.ws.editAria")}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t("settings.ws.firmName")} required error={errors.firmName} htmlFor="ws-firm"><Input id="ws-firm" value={firmName} onChange={(e) => setFirmName(e.target.value)} maxLength={120} autoFocus /></Field>
        <div />
        <Field label={t("settings.ws.ownerName")} required error={errors.name} htmlFor="ws-owner"><Input id="ws-owner" value={ownerName} onChange={(e) => setOwnerName(e.target.value)} maxLength={120} /></Field>
        <Field label={t("settings.ws.ownerEmail")} error={errors.email} htmlFor="ws-email"><Input id="ws-email" type="email" value={ownerEmail} onChange={(e) => setOwnerEmail(e.target.value)} maxLength={200} /></Field>
      </div>
      <div className="flex items-center gap-2">
        <Button size="xs" type="submit" disabled={busy}>{busy && <Loader2 className="size-3 animate-spin" />} {t("common.save")}</Button>
        <Button size="xs" type="button" variant="ghost" onClick={reset} disabled={busy}>{t("common.cancel")}</Button>
      </div>
    </form>
  );
}
