"use client";
import * as React from "react";
import { useI18n } from "@/lib/i18n/client";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Archive, ArchiveRestore, Briefcase, Loader2, Pencil, Plus, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { Inspector } from "@/components/ui/inspector";
import { Filterbar, type FilterValues } from "@/components/ui/filterbar";
import { KeyValueList } from "@/components/ui/form";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PageTopbar } from "@/components/shell/page-topbar";
import { cn } from "@/lib/utils";
import type { TeamMember } from "@/modules/workspace/roles";
import { MATTER_STATUS_FILTERS, sideLabel, statusLabel, type MatterRow, type MatterStatusFilter } from "../types";
import { apiJSON, ApiError, loadTeam } from "./api";
import { draftFrom, draftToInput, MatterFields, validateDraft, type DraftErrors, type MatterDraft } from "./matter-form";
import { NewMatterDialog } from "./new-matter-dialog";
import { causeListLabel, courtName, formatCaseNumber } from "../india";

type LoadState = { status: "loading" } | { status: "ready"; rows: MatterRow[]; archived: number } | { status: "error"; message: string; denied?: boolean };

/** Status label in the UI language (the English `statusLabel` stays the source text). */
function useStatusLabel() {
  const i18n = useI18n();
  return React.useCallback((s: MatterStatusFilter) => i18n.tx(`matters.status.${s}`, statusLabel(s)), [i18n]);
}

function StatusText({ m }: { m: MatterRow }) {
  const statusText = useStatusLabel();
  const label = m.archived ? statusText("archived") : statusText(m.status);
  const tone = m.archived ? "text-muted-foreground" : m.status === "active" ? "text-foreground" : "text-muted-foreground";
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-[12px]", tone)}>
      <span className={cn("size-1.5 rounded-full", m.archived ? "bg-muted-foreground/40" : m.status === "active" ? "bg-success" : m.status === "on hold" ? "bg-warning" : "bg-muted-foreground/60")} aria-hidden />
      {label}
    </span>
  );
}

/** /matters: every matter the user can access, with search, a status filter, an inspector and create/edit/archive. */
export function MattersPage() {
  const router = useRouter();
  const i18n = useI18n();
  const { t } = i18n;
  const statusText = useStatusLabel();
  // Indian convention, "31 May 2024"; date-only values are never shifted by the time zone.
  const fmtDate = React.useCallback((iso?: string) => i18n.date(iso, "medium"), [i18n]);
  const STATUS_OPTIONS = React.useMemo(() => MATTER_STATUS_FILTERS.filter((s) => s !== "open").map((s) => ({ value: s, label: statusText(s) })), [statusText]);
  const pathname = usePathname();
  const params = useSearchParams();
  const [filters, setFilters] = React.useState<FilterValues>(() => {
    const s = params.get("status");
    return s && s !== "open" && (MATTER_STATUS_FILTERS as readonly string[]).includes(s) ? { status: s } : {};
  });
  const [query, setQuery] = React.useState("");
  const [state, setState] = React.useState<LoadState>({ status: "loading" });
  const [activeId, setActiveId] = React.useState<string | null>(params.get("id"));
  const [newOpen, setNewOpen] = React.useState(params.get("new") === "1");
  const [reload, setReload] = React.useState(0);
  const status = (typeof filters.status === "string" ? filters.status : "open") as MatterStatusFilter;

  // Mirror ?id= in the URL; drop ?new=1 once the dialog has opened so a refresh does not reopen it.
  React.useEffect(() => {
    const sp = new URLSearchParams(params.toString());
    const before = sp.toString();
    sp.delete("new");
    if (activeId) sp.set("id", activeId); else sp.delete("id");
    if (status !== "open") sp.set("status", status); else sp.delete("status");
    const after = sp.toString();
    if (after !== before) router.replace(after ? `${pathname}?${after}` : pathname, { scroll: false });
  }, [activeId, status, params, pathname, router]);

  React.useEffect(() => {
    const ac = new AbortController();
    setState((s) => (s.status === "ready" ? s : { status: "loading" }));
    apiJSON<{ matters: MatterRow[]; archived: number }>(`/api/matters?status=${encodeURIComponent(status)}`, { signal: ac.signal })
      .then((r) => setState({ status: "ready", rows: r.matters, archived: r.archived ?? 0 }))
      .catch((e) => {
        if ((e as Error).name === "AbortError") return;
        const a = e as ApiError;
        setState({ status: "error", message: a.message, denied: a.status === 403 || a.status === 401 });
      });
    return () => ac.abort();
  }, [status, reload]);

  const rows = React.useMemo(() => {
    if (state.status !== "ready") return [];
    const q = query.trim().toLowerCase();
    if (!q) return state.rows;
    return state.rows.filter((m) => [m.name, m.shortName, m.number, m.client, m.court, m.caption, m.leadAttorneyName, m.practiceArea].some((v) => v?.toLowerCase().includes(q)));
  }, [state, query]);

  const active = state.status === "ready" ? state.rows.find((m) => m.id === activeId) ?? null : null;
  const [activeFallback, setActiveFallback] = React.useState<MatterRow | null>(null);
  // A matter selected by URL but outside the current filter (e.g. archived) is loaded directly.
  React.useEffect(() => {
    if (!activeId || active || state.status !== "ready") { setActiveFallback(null); return; }
    const ac = new AbortController();
    apiJSON<{ matter: MatterRow }>(`/api/matters/${encodeURIComponent(activeId)}`, { signal: ac.signal }).then((r) => setActiveFallback(r.matter)).catch(() => setActiveFallback(null));
    return () => ac.abort();
  }, [activeId, active, state.status]);
  const selected = active ?? activeFallback;

  const upsert = React.useCallback((m: MatterRow) => {
    setState((s) => {
      if (s.status !== "ready") return s;
      const exists = s.rows.some((r) => r.id === m.id);
      return { ...s, rows: exists ? s.rows.map((r) => (r.id === m.id ? m : r)) : [m, ...s.rows] };
    });
    setActiveFallback((f) => (f?.id === m.id ? m : f));
  }, []);

  const columns = React.useMemo<DataTableColumn<MatterRow>[]>(() => [
    { id: "name", header: t("matters.col.matter"), width: 300, minWidth: 180, sortable: true, locked: true, accessor: (m) => m.shortName || m.name, render: (m) => (
      <span className="flex min-w-0 items-baseline gap-2" title={m.name}>
        <span className="truncate font-medium text-foreground">{m.shortName || m.name}</span>
        {m.shortName && m.shortName !== m.name && <span className="min-w-0 truncate text-[11px] text-muted-foreground">{m.name}</span>}
      </span>
    ) },
    { id: "number", header: t("matters.col.number"), width: 120, sortable: true, accessor: (m) => m.number ?? "", render: (m) => <span className="font-mono text-[11.5px] text-muted-foreground">{m.number || "—"}</span> },
    { id: "client", header: t("matters.col.client"), width: 170, sortable: true, accessor: (m) => m.client, render: (m) => <span className="truncate">{m.client || <span className="text-muted-foreground">—</span>}</span> },
    { id: "case", header: t("matters.col.caseNo"), width: 170, sortable: true, accessor: (m) => formatCaseNumber(m.india?.caseType, m.india?.caseNumber, m.india?.caseYear) || m.caption || "", render: (m) => { const n = formatCaseNumber(m.india?.caseType, m.india?.caseNumber, m.india?.caseYear); return <span className="truncate font-mono text-[11.5px]" title={m.india?.cnr ? `CNR ${m.india.cnr}` : undefined}>{n || <span className="text-muted-foreground">{m.caption || "—"}</span>}</span>; } },
    { id: "court", header: t("matters.col.court"), width: 170, sortable: true, accessor: (m) => m.court ?? "", render: (m) => <span className="truncate text-muted-foreground">{m.court || "—"}</span> },
    { id: "hearing", header: t("matters.col.nextHearing"), width: 130, sortable: true, accessor: (m) => m.india?.nextHearing ?? "", render: (m) => m.india?.nextHearing ? <span className="flex min-w-0 items-baseline gap-1.5"><span className="tabular text-[11.5px]">{fmtDate(m.india.nextHearing)}</span>{m.india.causeList?.status === "listed" && <span className="text-[10.5px] text-muted-foreground">{m.india.causeList.item ? `item ${m.india.causeList.item}` : "listed"}</span>}</span> : <span className="text-muted-foreground">—</span> },
    { id: "area", header: t("matters.col.practiceArea"), width: 140, sortable: true, accessor: (m) => m.practiceArea },
    { id: "lead", header: t("matters.col.lead"), width: 150, sortable: true, accessor: (m) => m.leadAttorneyName ?? "", render: (m) => <span className="truncate">{m.leadAttorneyName || <span className="text-muted-foreground">—</span>}</span> },
    { id: "status", header: t("matters.col.status"), width: 110, sortable: true, accessor: (m) => (m.archived ? "zz" : m.status), render: (m) => <StatusText m={m} /> },
    { id: "updated", header: t("matters.col.updated"), width: 120, sortable: true, align: "right", accessor: (m) => m.updatedAt ?? m.openedAt, render: (m) => <span className="tabular text-[11.5px] text-muted-foreground">{fmtDate(m.updatedAt ?? m.openedAt)}</span> },
  ], [t, fmtDate]);

  const total = state.status === "ready" ? state.rows.length : 0;
  const filtered = Boolean(query.trim()) || status !== "open";
  const archivedCount = state.status === "ready" ? state.archived : 0;
  const empty = state.status === "ready" && total === 0 && !filtered ? (
    <div className="flex h-full min-h-[240px] flex-col items-center justify-center gap-3 px-6 text-center">
      <p className="text-[13px] text-muted-foreground">
        {archivedCount ? t("matters.empty.onlyArchived", { count: archivedCount }) : t("matters.empty.none")}
      </p>
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => setNewOpen(true)}><Plus className="size-3.5" /> {t("matters.new")}</Button>
        {archivedCount > 0 && <Button size="sm" variant="ghost" onClick={() => setFilters({ status: "archived" })}>{t("matters.empty.showArchived")}</Button>}
      </div>
    </div>
  ) : (
    <div className="flex h-full min-h-[200px] flex-col items-center justify-center gap-2 px-6 text-center">
      <p className="text-[13px] text-muted-foreground">{query.trim() ? t("matters.empty.noMatchQuery", { q: query.trim() }) : t("matters.empty.noMatchFilter")}</p>
      <Button size="xs" variant="ghost" onClick={() => { setQuery(""); setFilters({}); }}>{t("matters.empty.clearFilters")}</Button>
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageTopbar icon={<Briefcase />} title={t("matters.title")} context={state.status === "ready" ? t("matters.contextCount", { count: total, status: statusText(status).toLocaleLowerCase(i18n.locale) }) : undefined}>
        <div className="ms-auto flex items-center gap-2">
          <Button size="sm" onClick={() => setNewOpen(true)}><Plus className="size-3.5" /> {t("matters.new")}</Button>
        </div>
      </PageTopbar>
      <Filterbar
        filters={[{ id: "status", label: t("matters.statusFilter"), options: STATUS_OPTIONS }]}
        values={filters}
        onChange={setFilters}
        query={query}
        onQueryChange={setQuery}
        queryPlaceholder={t("matters.search")}
        status={state.status === "ready" && query.trim() ? t("matters.shownOf", { shown: rows.length, total: t("noun.matter", { count: total }) }) : undefined}
      />
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">
          {state.status === "error" && state.denied ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
              <ShieldAlert className="size-5 text-muted-foreground" aria-hidden />
              <p className="text-[13px] text-muted-foreground">{t("matters.denied")}</p>
            </div>
          ) : (
            <DataTable
              rows={rows}
              columns={columns}
              rowId={(m) => m.id}
              noun="matter"
              selectionMode="none"
              activeId={activeId}
              onActiveChange={setActiveId}
              onRowClick={(m) => setActiveId(m.id)}
              defaultSort={{ columnId: "updated", dir: "desc" }}
              loading={state.status === "loading"}
              error={state.status === "error" ? state.message : null}
              empty={empty}
              ariaLabel={t("matters.title")}
            />
          )}
        </div>
        {selected && <MatterInspector key={selected.id} matter={selected} onClose={() => setActiveId(null)} onSaved={upsert} onArchived={(m) => { upsert(m); if (status !== "all" && status !== "archived") { setActiveId(null); setReload((n) => n + 1); } }} />}
      </div>
      <NewMatterDialog open={newOpen} onOpenChange={setNewOpen} onCreated={(m) => { upsert(m); setActiveId(m.id); }} />
    </div>
  );
}

function MatterInspector({ matter: m, onClose, onSaved, onArchived }: { matter: MatterRow; onClose: () => void; onSaved: (m: MatterRow) => void; onArchived: (m: MatterRow) => void }) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState<MatterDraft>(() => draftFrom(m));
  const [errors, setErrors] = React.useState<DraftErrors>({});
  const [busy, setBusy] = React.useState(false);
  const [team, setTeam] = React.useState<TeamMember[] | null>(null);
  const [confirmArchive, setConfirmArchive] = React.useState(false);
  const i18n = useI18n();
  const { t } = i18n;
  const fmtDate = (iso?: string) => i18n.date(iso, "medium");

  React.useEffect(() => {
    if (!editing) return;
    const ac = new AbortController();
    loadTeam(ac.signal).then((t) => {
      // Keep current (possibly deactivated) members visible so they are not silently dropped.
      const extra = m.team.filter((p) => !t.some((x) => x.id === p.id)).map((p): TeamMember => ({ id: p.id, name: p.name, title: p.title, firmRole: null, active: false, owner: false }));
      setTeam([...t, ...extra]);
    }).catch((e) => { if ((e as Error).name !== "AbortError") setTeam([]); });
    return () => ac.abort();
  }, [editing, m.team]);

  const startEdit = () => { setDraft(draftFrom(m)); setErrors({}); setEditing(true); };

  const save = async () => {
    const v = validateDraft(draft);
    if (Object.keys(v).length) { setErrors(v); return; }
    setBusy(true);
    setErrors({});
    try {
      const r = await apiJSON<{ matter: MatterRow }>(`/api/matters/${encodeURIComponent(m.id)}`, { method: "PATCH", json: draftToInput(draft) });
      onSaved(r.matter);
      setEditing(false);
      toast.success(t("matters.toast.saved"));
    } catch (e) {
      const a = e as ApiError;
      setErrors({ ...(a.fields ?? {}), form: a.fields ? undefined : a.message });
    } finally {
      setBusy(false);
    }
  };

  const archive = async () => {
    setBusy(true);
    try {
      const r = await apiJSON<{ matter: MatterRow }>(`/api/matters/${encodeURIComponent(m.id)}`, { method: "DELETE" });
      setConfirmArchive(false);
      onArchived(r.matter);
      toast.success(t("matters.toast.archived", { name: r.matter.shortName }));
    } catch (e) {
      toast.error(t("matters.toast.archiveFailed"), { description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const restore = async () => {
    setBusy(true);
    try {
      const r = await apiJSON<{ matter: MatterRow }>(`/api/matters/${encodeURIComponent(m.id)}`, { method: "PATCH", json: { archived: false, status: "active" } });
      onSaved(r.matter);
      toast.success(t("matters.toast.restored", { name: r.matter.shortName }));
    } catch (e) {
      toast.error(t("matters.toast.restoreFailed"), { description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const footer = editing ? (
    <div className="flex items-center justify-end gap-2 px-3 py-2">
      {errors.form && <p className="me-auto truncate text-[11.5px] text-destructive" role="alert" title={errors.form}>{errors.form}</p>}
      <Button size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={busy}>{t("common.cancel")}</Button>
      <Button size="sm" onClick={() => void save()} disabled={busy}>{busy && <Loader2 className="size-3.5 animate-spin" />} {t("common.save")}</Button>
    </div>
  ) : (
    <div className="flex items-center gap-2 px-3 py-2">
      <Button size="sm" variant="outline" onClick={startEdit}><Pencil className="size-3.5" /> {t("common.edit")}</Button>
      {m.archived ? (
        <Button size="sm" variant="ghost" onClick={() => void restore()} disabled={busy}><ArchiveRestore className="size-3.5" /> {t("matters.restore")}</Button>
      ) : (
        <Button size="sm" variant="ghost" onClick={() => setConfirmArchive(true)} disabled={busy}><Archive className="size-3.5" /> {t("matters.archive")}</Button>
      )}
    </div>
  );

  return (
    <Inspector title={m.shortName || m.name} subtitle={m.number ? `${m.number} · ${m.practiceArea}` : m.practiceArea} icon={Briefcase} onClose={onClose} width={400} footer={footer} ariaLabel={t("matters.detailsAria")}>
      {editing ? (
        <div className="p-3"><MatterFields draft={draft} onChange={setDraft} errors={errors} team={team} idPrefix={`edit-${m.id}`} compact /></div>
      ) : (
        <div className="space-y-4 p-3">
          <div>
            <div className="text-[13px] font-medium leading-snug">{m.name}</div>
            {m.caption && <div className="mt-0.5 text-[12px] text-muted-foreground">{m.caption}</div>}
            <div className="mt-1.5"><StatusText m={m} /></div>
          </div>
          <KeyValueList dense labelWidth={110} items={[
            { label: t("matters.f.number"), value: m.number || "—", mono: !!m.number, muted: !m.number },
            { label: t("matters.f.client"), value: m.client ? `${m.client} (${sideLabel(m.clientSide)})` : "—", muted: !m.client },
            { label: t("matters.f.practiceArea"), value: m.practiceArea },
            { label: t("matters.f.court"), value: m.court || courtName(m.india?.courtId) || "—", muted: !m.court && !m.india?.courtId },
            ...(m.india ? [
              { label: t("matters.f.caseNo"), value: formatCaseNumber(m.india.caseType, m.india.caseNumber, m.india.caseYear) || "—", mono: true },
              { label: t("matters.f.cnr"), value: m.india.cnr || "—", mono: !!m.india.cnr, muted: !m.india.cnr },
              ...(m.india.courtHall ? [{ label: t("matters.f.courtHall"), value: m.india.courtHall }] : []),
              { label: t("matters.f.nextHearing"), value: m.india.nextHearing ? `${fmtDate(m.india.nextHearing)}${m.india.hearingPurpose ? ` · ${m.india.hearingPurpose}` : ""}` : "—", muted: !m.india.nextHearing },
              { label: t("matters.f.causeList"), value: `${causeListLabel(m.india.causeList?.status)}${m.india.causeList?.item ? ` · item ${m.india.causeList.item}` : ""}`, muted: !m.india.causeList },
            ] : []),
            { label: t("matters.f.jurisdiction"), value: m.jurisdiction || "—", muted: !m.jurisdiction },
            { label: t("matters.f.judge"), value: m.judge || "—", muted: !m.judge },
            { label: t("matters.f.stage"), value: m.stage || "—", muted: !m.stage },
            { label: t("matters.f.opened"), value: fmtDate(m.openedAt) || "—" },
            { label: t("matters.f.lead"), value: m.leadAttorneyName || "—", muted: !m.leadAttorneyName },
            ...(m.archivedAt ? [{ label: t("matters.f.archived"), value: fmtDate(m.archivedAt) }] : []),
          ]} />
          <section>
            <h3 className="mb-1 text-[11.5px] font-medium text-muted-foreground">{t("matters.team")}</h3>
            {m.team.length ? (
              <ul className="space-y-0.5 text-[12.5px]">{m.team.map((p) => <li key={p.id} className="flex items-baseline gap-2"><span>{p.name}</span>{p.title && <span className="text-[11px] text-muted-foreground">{p.title}</span>}</li>)}</ul>
            ) : <p className="text-[12px] text-muted-foreground">{t("matters.noTeam")}</p>}
          </section>
          {m.description && (
            <section>
              <h3 className="mb-1 text-[11.5px] font-medium text-muted-foreground">{t("matters.description")}</h3>
              <p className="whitespace-pre-wrap text-[12.5px] leading-relaxed">{m.description}</p>
            </section>
          )}
          <section className="flex flex-col gap-1 border-t pt-3 text-[12.5px]">
            <Link className="w-fit text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground" href={`/ediscovery?matter=${encodeURIComponent(m.id)}`}>{t("matters.documentsLink")}</Link>
            <Link className="w-fit text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground" href={`/?matter=${encodeURIComponent(m.id)}`}>{t("matters.openWorkspace")}</Link>
          </section>
        </div>
      )}
      <Dialog open={confirmArchive} onOpenChange={setConfirmArchive}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>{t("matters.archiveTitle", { name: m.shortName })}</DialogTitle>
            <DialogDescription>{t("matters.archiveDesc")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button size="sm" variant="ghost" onClick={() => setConfirmArchive(false)}>{t("common.cancel")}</Button>
            <Button size="sm" onClick={() => void archive()} disabled={busy}>{busy && <Loader2 className="size-3.5 animate-spin" />} {t("matters.archive")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Inspector>
  );
}
