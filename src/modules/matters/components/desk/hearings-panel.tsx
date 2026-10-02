"use client";
import * as React from "react";
import { CalendarPlus, FileText, Loader2, Plus, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import { apiJSON, ApiError } from "../api";
import type { MatterRow } from "../../types";
import type { ListingsResponse, ManualHearing, MatterTracking, TrackedIdentifier, TrackedIdentifierKind } from "../../desk/types";
import { forumLabel, type ForumOption } from "../../desk/tracking";
import { AuthorityNote, ListingDetails, OfficialNotice, PanelError, PanelSkeleton, useDeskFetch, type DeskFetch } from "./shared";

type TrackingResponse = { tracking: MatterTracking | null; suggestions: TrackedIdentifier[]; forums: ForumOption[] };

const KIND_KEYS = { case_number: "desk.kind.caseNumber", diary_no: "desk.kind.diaryNo", cnr: "matters.f.cnr" } as const;

function SectionTitle({ children, aside }: { children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <div className="mb-1.5 flex items-center gap-2">
      <h3 className="text-[11.5px] font-medium text-muted-foreground">{children}</h3>
      <div className="flex-1" />
      {aside}
    </div>
  );
}

/** Hearings tab: tracked identifiers, listings in parsed cause lists (next 14 days) and hearings entered by hand. */
export function HearingsPanel({ matter, onBrief }: { matter: MatterRow; onBrief: (listingId: string) => void }) {
  const base = `/api/matters/${encodeURIComponent(matter.id)}`;
  const tracking = useDeskFetch<TrackingResponse>(`${base}/tracking`);
  const listings = useDeskFetch<ListingsResponse>(`${base}/listings`);
  const manual = useDeskFetch<{ hearings: ManualHearing[] }>(`${base}/hearings`);
  const reloadListings = listings.reload;

  const { t } = useI18n();
  if (tracking.state === "error" && (tracking.error?.status === 403 || tracking.error?.status === 401)) return <PanelError error={tracking.error} />;
  return (
    <div className="space-y-5 p-3">
      <IdentifiersSection matterId={matter.id} res={tracking} onSaved={reloadListings} />
      <section aria-label={t("desk.listings")}>
        <ListingsSection res={listings} tracking={tracking.data?.tracking ?? null} onBrief={onBrief} />
      </section>
      <ManualSection matterId={matter.id} res={manual} />
    </div>
  );
}

function IdentifiersSection({ matterId, res, onSaved }: { matterId: string; res: DeskFetch<TrackingResponse>; onSaved: () => void }) {
  const { t } = useI18n();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [forum, setForum] = React.useState("");
  const [kind, setKind] = React.useState<TrackedIdentifierKind>("case_number");
  const [value, setValue] = React.useState("");
  const [advocate, setAdvocate] = React.useState("");
  const data = res.data;
  const ids = data?.tracking?.identifiers ?? [];
  const advocates = data?.tracking?.advocateNames ?? [];
  const forums = data?.forums ?? [];
  const forumName = (id: string) => forums.find((f) => f.id === id)?.label ?? id;

  const save = async (identifiers: TrackedIdentifier[], advocateNames: string[]) => {
    setBusy(true);
    setError(null);
    try {
      const r = await apiJSON<{ tracking: MatterTracking }>(`/api/matters/${encodeURIComponent(matterId)}/tracking`, { method: "PUT", json: { identifiers: identifiers.map(({ forum, kind, printed }) => ({ forum, kind, printed })), advocateNames } });
      res.setData((d) => (d ? { ...d, tracking: r.tracking, suggestions: d.suggestions.filter((s) => !r.tracking.identifiers.some((i) => i.forum === s.forum && i.kind === s.kind && i.value === s.value)) } : d));
      toast.success(t("desk.toast.tracked"));
      onSaved();
      return true;
    } catch (e) {
      setError((e as ApiError).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!forum || !value.trim()) return;
    if (await save([...ids, { forum, kind, value: value.trim(), printed: value.trim() }], advocates)) setValue("");
  };
  const addAdvocate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!advocate.trim()) return;
    if (await save(ids, [...advocates, advocate.trim()])) setAdvocate("");
  };

  return (
    <section aria-label={t("desk.identifiers")}>
      <SectionTitle>{t("desk.identifiers")}</SectionTitle>
      {res.state === "loading" ? <PanelSkeleton rows={1} /> : res.state === "error" ? <PanelError error={res.error} onRetry={res.reload} /> : (
        <div className="space-y-2">
          <p className="text-[11px] leading-snug text-muted-foreground">{t("desk.identifiersHint")}</p>
          {ids.length ? (
            <ul className="divide-y rounded-md border">
              {ids.map((i, n) => (
                <li key={`${i.forum}|${i.kind}|${i.value}`} className="flex items-center gap-2 px-2 py-1.5">
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-[12px]" title={i.value}>{i.printed}</div>
                    <div className="truncate text-[11px] text-muted-foreground">{t(KIND_KEYS[i.kind])} · {forumName(i.forum)}</div>
                  </div>
                  <Button size="icon-xs" variant="ghost" disabled={busy} aria-label={t("common.remove")} onClick={() => void save(ids.filter((_, k) => k !== n), advocates)}><X className="size-3.5" /></Button>
                </li>
              ))}
            </ul>
          ) : <p className="text-[12px] text-muted-foreground">{t("desk.noIdentifiers")}</p>}
          {!!data?.suggestions.length && (
            <div className="flex flex-wrap items-center gap-1.5 text-[11.5px]">
              <span className="text-muted-foreground">{t("desk.suggested")}</span>
              {data.suggestions.map((s) => (
                <button key={`${s.kind}|${s.value}`} type="button" disabled={busy} onClick={() => void save([...ids, s], advocates)} className="inline-flex h-6 items-center gap-1 rounded border px-1.5 font-mono text-[11px] hover:bg-accent disabled:opacity-50">
                  <Plus className="size-3" aria-hidden />{s.printed}
                </button>
              ))}
            </div>
          )}
          <form onSubmit={add} className="grid grid-cols-[1fr_auto] gap-1.5">
            <Select value={forum} onValueChange={setForum}>
              <SelectTrigger size="sm" aria-label={t("desk.forum")} className="h-8 text-[12px]"><SelectValue placeholder={t("desk.forum")} /></SelectTrigger>
              <SelectContent className="max-h-72">
                {forums.map((f) => <SelectItem key={f.id} value={f.id}>{f.label}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={kind} onValueChange={(v) => setKind(v as TrackedIdentifierKind)}>
              <SelectTrigger size="sm" aria-label={t("desk.kind")} className="h-8 w-[104px] text-[12px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                {(["case_number", "diary_no", "cnr"] as const).map((k) => <SelectItem key={k} value={k}>{t(KIND_KEYS[k])}</SelectItem>)}
              </SelectContent>
            </Select>
            <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder={kind === "cnr" ? "KAHC010123452024" : kind === "diary_no" ? "54583/2026" : t("desk.identifierPlaceholder")} aria-label={t("desk.identifierValue")} maxLength={160} className="h-8 font-mono text-[12px]" />
            <Button size="sm" type="submit" variant="outline" disabled={busy || !forum || !value.trim()}>{busy ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />} {t("desk.track")}</Button>
          </form>
          {error && <p className="text-[11.5px] text-destructive" role="alert">{error}</p>}
          <div className="pt-1">
            <div className="text-[11.5px] font-medium text-muted-foreground">{t("desk.advocates")}</div>
            <p className="mb-1 text-[11px] leading-snug text-muted-foreground">{t("desk.advocatesHint")}</p>
            {!!advocates.length && (
              <div className="mb-1.5 flex flex-wrap gap-1">
                {advocates.map((a, n) => (
                  <span key={a} className="inline-flex h-6 items-center gap-1 rounded border px-1.5 text-[11.5px]">
                    {a}
                    <button type="button" disabled={busy} aria-label={`${t("common.remove")} ${a}`} className="text-muted-foreground hover:text-foreground" onClick={() => void save(ids, advocates.filter((_, k) => k !== n))}><X className="size-3" /></button>
                  </span>
                ))}
              </div>
            )}
            <form onSubmit={addAdvocate} className="flex gap-1.5">
              <Input value={advocate} onChange={(e) => setAdvocate(e.target.value)} placeholder={t("desk.addAdvocate")} aria-label={t("desk.addAdvocate")} maxLength={80} className="h-8 text-[12px]" />
              <Button size="sm" type="submit" variant="ghost" disabled={busy || !advocate.trim()}><Plus className="size-3.5" /></Button>
            </form>
          </div>
        </div>
      )}
    </section>
  );
}

function ListingsSection({ res, tracking, onBrief }: { res: DeskFetch<ListingsResponse>; tracking: MatterTracking | null; onBrief: (listingId: string) => void }) {
  const { t } = useI18n();
  const d = res.data;
  const printedFor = (v: string, k: string) => tracking?.identifiers.find((i) => i.value === v && i.kind === k)?.printed;
  return (
    <>
      <SectionTitle aside={<span className="text-[11px] text-muted-foreground">{t("desk.listingsRange")}</span>}>{t("desk.listings")}</SectionTitle>
      {res.state === "loading" ? <PanelSkeleton rows={2} /> : res.state === "error" ? <PanelError error={res.error} onRetry={res.reload} /> : d && (
        <div className="space-y-2">
          {d.state !== "ok" ? <OfficialNotice state={d.state} message={d.message} onRetry={res.reload} /> : d.untracked ? (
            <p className="text-[12px] text-muted-foreground">{t("desk.untracked")}</p>
          ) : d.listings.length ? (
            <ul className="space-y-2">
              {d.listings.map((l) => (
                <li key={l.id} className="rounded-md border p-2">
                  <ListingDetails entry={l.entry} source={l.source} matchedOn={l.matchedOn} printed={printedFor(l.matchedOn.value, l.matchedOn.kind)} showDate />
                  <div className="mt-1.5 flex justify-end">
                    <Button size="xs" variant="outline" onClick={() => onBrief(l.id)}><FileText className="size-3.5" /> {t("desk.prepareBrief")}</Button>
                  </div>
                </li>
              ))}
            </ul>
          ) : <p className="text-[12px] text-muted-foreground">{t("desk.noListings")}</p>}
          {!!d.uncoveredForums.length && <p className="text-[11px] leading-snug text-muted-foreground">{t("desk.uncovered", { forums: d.uncoveredForums.map(forumLabel).join(", ") })}</p>}
          {d.state === "ok" && !d.untracked && <AuthorityNote />}
        </div>
      )}
    </>
  );
}

function ManualSection({ matterId, res }: { matterId: string; res: DeskFetch<{ hearings: ManualHearing[] }> }) {
  const i18n = useI18n();
  const { t } = i18n;
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [form, setForm] = React.useState({ date: "", time: "", courtNo: "", itemNo: "", purpose: "" });
  const [error, setError] = React.useState<string | null>(null);
  const list = res.data?.hearings ?? [];

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await apiJSON<{ hearing: ManualHearing }>(`/api/matters/${encodeURIComponent(matterId)}/hearings`, { json: form });
      res.setData((d) => ({ hearings: [...(d?.hearings ?? []), r.hearing].sort((a, b) => a.date.localeCompare(b.date)) }));
      setForm({ date: "", time: "", courtNo: "", itemNo: "", purpose: "" });
      setOpen(false);
      toast.success(t("desk.toast.hearingAdded"));
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (h: ManualHearing) => {
    try {
      await apiJSON(`/api/matters/${encodeURIComponent(matterId)}/hearings/${encodeURIComponent(h.id)}`, { method: "DELETE" });
      res.setData((d) => ({ hearings: (d?.hearings ?? []).filter((x) => x.id !== h.id) }));
      toast.success(t("desk.toast.hearingRemoved"));
    } catch (err) {
      toast.error(t("desk.toast.saveFailed"), { description: (err as Error).message });
    }
  };
  const field = (k: keyof typeof form, label: string, props: Omit<React.InputHTMLAttributes<HTMLInputElement>, "size"> = {}) => (
    <label className="grid gap-0.5 text-[11px] text-muted-foreground">
      {label}
      <Input value={form[k]} onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))} className="h-8 text-[12px] text-foreground" {...props} />
    </label>
  );

  return (
    <section aria-label={t("desk.manual")}>
      <SectionTitle aside={!open && <Button size="xs" variant="ghost" onClick={() => setOpen(true)}><CalendarPlus className="size-3.5" /> {t("desk.addHearing")}</Button>}>{t("desk.manual")}</SectionTitle>
      {res.state === "loading" ? <PanelSkeleton rows={1} /> : res.state === "error" ? <PanelError error={res.error} onRetry={res.reload} /> : (
        <div className="space-y-2">
          {open && (
            <form onSubmit={submit} className="space-y-1.5 rounded-md border p-2">
              <div className="grid grid-cols-2 gap-1.5">
                {field("date", t("desk.f.date"), { type: "date", required: true })}
                {field("time", t("desk.f.time"), { type: "time" })}
                {field("courtNo", t("desk.f.courtNo"), { maxLength: 40 })}
                {field("itemNo", t("desk.f.itemNo"), { maxLength: 20 })}
              </div>
              {field("purpose", t("desk.f.purpose"), { maxLength: 160 })}
              {error && <p className="text-[11.5px] text-destructive" role="alert">{error}</p>}
              <div className="flex justify-end gap-1.5">
                <Button size="xs" variant="ghost" type="button" onClick={() => { setOpen(false); setError(null); }}>{t("common.cancel")}</Button>
                <Button size="xs" type="submit" disabled={busy || !form.date}>{busy && <Loader2 className="size-3.5 animate-spin" />} {t("common.save")}</Button>
              </div>
            </form>
          )}
          {list.length ? (
            <ul className="divide-y rounded-md border">
              {list.map((h) => (
                <li key={h.id} className="flex items-start gap-2 px-2 py-1.5">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2 text-[12.5px]">
                      <span className="font-medium tabular">{i18n.date(h.date, "full")}</span>
                      {h.time && <span className="tabular text-muted-foreground">{h.time}</span>}
                      {h.courtNo && <span>{t("desk.court", { no: h.courtNo })}</span>}
                      {h.itemNo && <span className="tabular">{t("desk.item", { no: h.itemNo })}</span>}
                    </div>
                    {h.purpose && <div className="truncate text-[11.5px] text-muted-foreground">{h.purpose}</div>}
                  </div>
                  <Button size="icon-xs" variant="ghost" aria-label={t("common.remove")} onClick={() => void remove(h)}><Trash2 className="size-3.5" /></Button>
                </li>
              ))}
            </ul>
          ) : !open && <p className={cn("text-[12px] text-muted-foreground")}>{t("desk.manualEmpty")}</p>}
        </div>
      )}
    </section>
  );
}
