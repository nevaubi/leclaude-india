"use client";
import * as React from "react";
import { relativeDue } from "@/lib/i18n/relative";
import { T, useI18n, useT } from "@/lib/i18n/client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Briefcase, FileSearch, Filter, Library, MoreHorizontal, Scale, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tooltip";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { MatterOverview as MatterOverviewRow } from "../types";
import { dueText } from "../time";
import { useHomeUI } from "../store";
import { useHome } from "./home-provider";
import { EmptyRow, PeopleStack, Section } from "./shared";
import { hotCell, matterMeta, matterRows, taskCell } from "./matters-table-model";

/** Columns the overview leaves out so the table fits beside the brief; the focused view offers them in the chooser. */
const OVERVIEW_HIDDEN = ["stage", "events", "team", "area", "client"];

/** Matters as one dense table: name, stage, next key date, due, open tasks, hot docs, events, team. */
export function MattersOverview() {
  const { matterOverview, matterFilter, setMatterFilter } = useHome();
  const setFocus = useHomeUI((s) => s.setFocus);
  const rows = React.useMemo(() => matterRows(matterOverview, matterFilter), [matterOverview, matterFilter]);
  const t = useT();
  return (
    <Section id="matters" title={t("home.section.matters")} count={rows.length} onExpand={() => setFocus("matters")} actions={matterFilter ? <Button variant="ghost" size="xs" onClick={() => setMatterFilter(null)}><X className="size-3" /> {t("home.section.clearFilter")}</Button> : undefined}>
      {rows.length === 0 ? <EmptyRow icon={Briefcase} title={t("home.section.noActiveMatters")} /> : <MattersTable rows={rows} virtualize={false} />}
    </Section>
  );
}

export function MattersFocus() {
  const { matterOverview, matterFilter } = useHome();
  const setFocus = useHomeUI((s) => s.setFocus);
  const rows = React.useMemo(() => matterRows(matterOverview, null), [matterOverview]);
  return (
    <Section id="matters" title={<T k="home.section.matters" />} icon={Briefcase} count={rows.length} expanded onExpand={() => setFocus(null)} bodyClassName="flex min-h-0 flex-col">
      <MattersTable rows={rows} virtualize activeId={matterFilter} density="comfortable" />
    </Section>
  );
}

function MattersTable({ rows, virtualize, activeId, density }: { rows: MatterOverviewRow[]; virtualize: boolean; activeId?: string | null; density?: "compact" | "comfortable" }) {
  const router = useRouter();
  const { now, matterFilter, setMatterFilter, personById } = useHome();
  const i18n = useI18n();
  const { t } = i18n;
  const columns = React.useMemo<DataTableColumn<MatterOverviewRow>[]>(() => [
    {
      id: "matter", header: t("home.matters.matter"), width: 260, minWidth: 160, sortable: true, locked: true, accessor: (m) => m.shortName,
      render: (m) => (
        <span className="flex min-w-0 items-baseline gap-1.5">
          <Link href={`/ediscovery?matter=${m.id}`} className="max-w-full shrink-0 truncate font-medium hover:underline underline-offset-2" onClick={(e) => e.stopPropagation()}>{m.shortName}</Link>
          <span className="hidden min-w-0 truncate text-[11px] text-muted-foreground xl:inline" title={matterMeta(m)}>{matterMeta(m)}</span>
        </span>
      ),
    },
    { id: "stage", header: t("home.matters.stage"), width: 150, minWidth: 90, sortable: true, accessor: (m) => m.stage ?? "", render: (m) => <span className="truncate text-muted-foreground">{m.stage ?? "—"}</span> },
    {
      id: "keyDate", header: t("home.matters.nextKeyDate"), width: 220, minWidth: 140, sortable: true, accessor: (m) => m.nextKeyDate?.daysUntil ?? null,
      render: (m) => m.nextKeyDate ? (
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="truncate">{m.nextKeyDate.label}</span>
          <span className="shrink-0 tabular text-[11px] text-muted-foreground">{i18n.date(m.nextKeyDate.date, "dayMonth")}</span>
        </span>
      ) : <span className="text-muted-foreground">—</span>,
    },
    {
      id: "due", header: t("home.matters.due"), width: 110, minWidth: 80, sortable: true, accessor: (m) => m.nextKeyDate?.daysUntil ?? null,
      render: (m) => {
        if (!m.nextKeyDate) return <span className="text-muted-foreground">—</span>;
        const due = relativeDue(dueText(m.nextKeyDate.date, now).days, t);
        return <span className={cn("tabular text-[11.5px]", due.overdue ? "text-destructive" : "text-muted-foreground")}>{due.text}</span>;
      },
    },
    {
      id: "tasks", header: t("home.matters.tasks"), width: 90, minWidth: 60, align: "right", sortable: true, accessor: (m) => m.openTasks,
      render: (m) => { const t = taskCell(m); return <span title={t.title} className={cn("tabular", t.late && "text-destructive")}>{t.text}</span>; },
    },
    {
      id: "hot", header: t("home.matters.hot"), width: 90, minWidth: 70, align: "right", sortable: true, accessor: (m) => m.hotDocs,
      render: (m) => { const h = hotCell(m); return <span className={cn("tabular", h.hot ? "text-foreground" : "text-muted-foreground")}>{h.text}</span>; },
    },
    { id: "events", header: t("home.matters.events"), width: 72, minWidth: 56, align: "right", sortable: true, accessor: (m) => m.upcomingEvents, render: (m) => <span className="tabular" title={m.nextEvent ? `Next: ${m.nextEvent.title}` : undefined}>{m.upcomingEvents}</span> },
    {
      id: "team", header: t("home.matters.team"), width: 130, minWidth: 80, accessor: (m) => m.teamIds.length,
      render: (m) => { const lead = personById(m.leadAttorneyId); return <span className="flex items-center gap-1.5"><PeopleStack ids={m.teamIds} max={4} /><span className="hidden truncate text-[11px] text-muted-foreground 2xl:inline">{lead?.name}</span></span>; },
    },
    { id: "area", header: t("home.matters.practiceArea"), width: 130, minWidth: 90, sortable: true, defaultHidden: true, accessor: (m) => m.practiceArea },
    { id: "client", header: t("home.matters.client"), width: 160, minWidth: 90, sortable: true, defaultHidden: true, accessor: (m) => m.client },
  ], [now, personById, t, i18n]);

  return (
    <DataTable
      rows={rows}
      columns={columns}
      rowId={(m) => m.id}
      noun="matter"
      density={density ?? "compact"}
      selectionMode="none"
      virtualize={virtualize}
      fill={virtualize}
      summary={virtualize}
      columnChooser={virtualize}
      hiddenColumns={virtualize ? undefined : OVERVIEW_HIDDEN}
      activeId={activeId ?? undefined}
      ariaLabel={t("home.section.matters")}
      onRowActivate={(m) => router.push(`/ediscovery?matter=${m.id}`)}
      rowClassName={(m) => (matterFilter === m.id ? "row-selected" : undefined)}
      rowActions={(m) => (
        <span className="flex items-center">
          <Tip label={matterFilter === m.id ? "Clear matter filter" : "Filter Home to this matter"}>
            <Button variant="ghost" size="icon-xs" className="size-6" data-row-action onClick={(e) => { e.stopPropagation(); setMatterFilter(matterFilter === m.id ? null : m.id); }} aria-label="Filter to matter"><Filter className={cn("size-3.5", matterFilter === m.id && "text-primary")} /></Button>
          </Tip>
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-xs" className="size-6" data-row-action onClick={(e) => e.stopPropagation()} aria-label="Matter actions"><MoreHorizontal className="size-3.5" /></Button></DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44" onClick={(e) => e.stopPropagation()}>
              <DropdownMenuItem asChild><Link href={`/ediscovery?matter=${m.id}`}><FileSearch /> E-Discovery</Link></DropdownMenuItem>
              <DropdownMenuItem asChild><Link href={`/library?matter=${m.id}`}><Library /> Library</Link></DropdownMenuItem>
              <DropdownMenuItem asChild><Link href={`/search?q=${encodeURIComponent(m.shortName)}`}><Scale /> Research</Link></DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setMatterFilter(matterFilter === m.id ? null : m.id)}><Filter /> {matterFilter === m.id ? "Clear filter" : "Filter Home"}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      )}
    />
  );
}
