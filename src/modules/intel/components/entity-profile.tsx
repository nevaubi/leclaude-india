"use client";
import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Eye, EyeOff, GitFork, History, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { KeyValueList } from "@/components/ui/form";
import { Stat } from "@/components/ui/misc";
import { TrustBadge } from "@/components/ai/trust-badge";
import { COURT_NAMES } from "../mentions";
import { DOC_KIND_LABEL, ENTITY_TYPE_LABEL, INSIGHT_KIND_LABEL, RELATION_LABEL, WATCH_KIND_FOR_ENTITY, fmtInt } from "../analysis/pure";
import type { DocLite, EntityProfile } from "../analysis/types";
import { ActivityBars } from "./activity-chart";
import { chronologyKindLabel, groupByMonth } from "./models";
import { BodySection, ConfidenceText, DateText, DocLink, EntityLink, FlagList, MethodNote } from "./shared";
import { matterHref } from "@/lib/features";

/** One line for a nested attribute value: scalars as-is, objects as their string fields ("U.S. District Judge · D.S.C. · 2010–"). */
function describeValue(v: unknown): string {
  if (v == null) return "";
  if (typeof v !== "object") return String(v);
  const o = v as Record<string, unknown>;
  const parts = ["title", "name", "court", "role", "position", "label"].map((k) => o[k]).filter((x): x is string => typeof x === "string" && x.trim() !== "");
  const from = typeof o.dateStart === "string" ? o.dateStart.slice(0, 4) : typeof o.from === "string" ? o.from.slice(0, 4) : undefined;
  const to = typeof o.dateEnd === "string" ? o.dateEnd.slice(0, 4) : typeof o.to === "string" ? o.to.slice(0, 4) : undefined;
  if (from || to) parts.push(`${from ?? ""}–${to ?? ""}`);
  if (parts.length) return parts.join(" · ");
  return Object.values(o).filter((x) => typeof x === "string" || typeof x === "number").map(String).join(" · ").slice(0, 120);
}

function attributeItems(attrs: Record<string, unknown>): { label: string; value: React.ReactNode; mono?: boolean }[] {
  const skip = new Set(["seeded", "demo"]);
  const label = (k: string) => k.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase()).replace(/\bId\b/, "id").replace(/Cfr/, "CFR").replace(/Usc/, "U.S.C.").replace(/Mdl/, "MDL").replace(/Ndc/, "NDC");
  return Object.entries(attrs).filter(([k, v]) => !skip.has(k) && v != null && v !== "" && !(Array.isArray(v) && !v.length)).slice(0, 14).map(([k, v]) => {
    if (k === "transfereeCourt" || k === "courtId") return { label: label(k), value: typeof v === "string" ? COURT_NAMES[v] ?? v : String(v) };
    if (Array.isArray(v)) return { label: label(k), value: v.map(describeValue).filter(Boolean).join("; ") };
    if (typeof v === "object") return { label: label(k), value: describeValue(v) };
    return { label: label(k), value: String(v), mono: /id$|number|ndc|cite/i.test(k) };
  });
}

export function EntityProfileView({ profile, userId, matterNames }: { profile: EntityProfile; userId: string; matterNames: Record<string, string> }) {
  const { entity } = profile;
  const [watched, setWatched] = React.useState(profile.watched);
  const [busy, setBusy] = React.useState(false);
  const canWatch = Boolean(WATCH_KIND_FOR_ENTITY[entity.type]);
  const toggleWatch = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/intel/entities/${encodeURIComponent(entity.id)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "watch", userId }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? res.statusText);
      setWatched(Boolean(j.watched));
      toast.success(j.watched ? `Watching ${entity.name}` : `Stopped watching ${entity.name}`);
    } catch (e) { toast.error("Could not update the watch", { description: (e as Error).message }); } finally { setBusy(false); }
  };
  const chronologyHref = entity.type === "mdl" ? `/intel/chronologies?mdlId=${encodeURIComponent(entity.id)}` : entity.type === "product" ? `/intel/chronologies?productId=${encodeURIComponent(entity.id)}` : `/intel/chronologies?entityId=${encodeURIComponent(entity.id)}`;
  const lastSeen = profile.recent[0]?.date;
  const months = React.useMemo(() => groupByMonth(profile.timeline).reverse(), [profile.timeline]);
  const docColumns: DataTableColumn<DocLite>[] = [
    { id: "title", header: "Record", width: 380, minWidth: 200, locked: true, sortable: true, accessor: (d) => d.title.toLowerCase(), render: (d) => <DocLink doc={d} className="font-medium" /> },
    { id: "kind", header: "Kind", width: 110, sortable: true, accessor: (d) => d.kind, render: (d) => <span className="text-muted-foreground">{DOC_KIND_LABEL[d.kind]}</span> },
    { id: "date", header: "Date", width: 104, sortable: true, accessor: (d) => d.date ?? "", render: (d) => <DateText value={d.date} /> },
    { id: "court", header: "Court", width: 220, accessor: (d) => d.court ?? "", render: (d) => <span className="truncate text-muted-foreground" title={d.court}>{d.court ?? d.citation ?? "—"}</span> },
    { id: "matters", header: "Matter", width: 120, accessor: (d) => d.matterIds.map((m) => matterNames[m] ?? m).join(", "), render: (d) => <span className="truncate text-muted-foreground">{d.matterIds.map((m) => matterNames[m] ?? m).join(", ") || "—"}</span> },
    { id: "confidence", header: "Conf.", width: 64, align: "right", sortable: true, accessor: (d) => d.confidence, render: (d) => <ConfidenceText value={d.confidence} /> },
    { id: "flags", header: "Flags", width: 150, accessor: (d) => d.flags.length, render: (d) => (d.flags.length ? <FlagList flags={d.flags} /> : <span className="text-muted-foreground">—</span>) },
  ];

  return (
    <div className="min-h-0 flex-1 overflow-auto scrollbar-thin">
      <div className="mx-auto max-w-[1400px] space-y-4 p-3 pb-8">
        <header className="flex flex-wrap items-start gap-x-4 gap-y-2">
          <div className="min-w-0 flex-1">
            <div className="text-[11.5px] font-medium text-muted-foreground">{ENTITY_TYPE_LABEL[entity.type]}</div>
            <h1 className="truncate text-[17px] font-semibold tracking-tight">{entity.name}</h1>
            {entity.aliases.length > 0 && <div className="truncate text-[11.5px] text-muted-foreground" title={entity.aliases.join(" · ")}>Also: {entity.aliases.join(" · ")}</div>}
            {(entity.flags?.length ?? 0) > 0 && <FlagList flags={entity.flags ?? []} max={4} className="mt-1" />}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button size="xs" variant={watched ? "secondary" : "default"} onClick={() => void toggleWatch()} disabled={!canWatch || busy} title={canWatch ? undefined : `${ENTITY_TYPE_LABEL[entity.type]} entities cannot be watched`}>{watched ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}{watched ? "Unwatch" : "Watch"}</Button>
            <Button size="xs" variant="ghost" asChild><Link href={`/intel/graph?entityId=${encodeURIComponent(entity.id)}`}><GitFork className="size-3.5" /> Graph</Link></Button>
            <Button size="xs" variant="ghost" asChild><Link href={chronologyHref}><History className="size-3.5" /> Chronology</Link></Button>
            <Button size="xs" variant="ghost" asChild><Link href={`/search?q=${encodeURIComponent(entity.name)}`}><Search className="size-3.5" /> Research</Link></Button>
          </div>
        </header>

        <div className="grid grid-cols-2 hairline-x rounded-md border sm:grid-cols-5">
          <Stat size="sm" label="Records" value={fmtInt(profile.counts.documents)} />
          <Stat size="sm" label="Relations" value={fmtInt(profile.counts.relations)} />
          <Stat size="sm" label="Matters" value={fmtInt(profile.counts.matters)} />
          <Stat size="sm" label="Mentions" value={fmtInt(entity.mentionCount)} />
          <Stat size="sm" label="Last seen" value={<DateText value={lastSeen} className="text-foreground" />} />
        </div>

        <div className="grid gap-x-6 gap-y-4 xl:grid-cols-[minmax(0,1fr)_320px]">
          <div className="min-w-0 space-y-5">
            <BodySection title="Activity" count="24 months">
              <ActivityBars series={profile.activity} height={132} />
            </BodySection>

            <BodySection title="Motion outcomes" count={profile.tendencies.length || undefined}>
              {profile.tendencies.length ? (
                <div className="rounded-md border">
                  <div role="table" aria-label="Motion outcomes" className="text-[12px]">
                    <div role="row" className="grid h-7 grid-cols-[minmax(0,1fr)_56px_56px_56px_56px_64px] items-center gap-2 border-b px-2 grid-head"><span>Motion</span><span className="text-right">Total</span><span className="text-right">Granted</span><span className="text-right">Denied</span><span className="text-right">In part</span><span className="text-right">Grant rate</span></div>
                    {profile.tendencies.map((t) => (
                      <div key={t.motion} className="border-b border-line-quiet last:border-b-0">
                        <div role="row" className="grid min-h-7 grid-cols-[minmax(0,1fr)_56px_56px_56px_56px_64px] items-center gap-2 px-2"><span className="truncate font-medium">{t.label}</span><span className="text-right tabular">{t.total}</span><span className="text-right tabular">{t.granted}</span><span className="text-right tabular">{t.denied}</span><span className="text-right tabular">{t.partial}</span><span className="text-right tabular">{t.grantRate == null ? "—" : `${Math.round(t.grantRate * 100)}%`}</span></div>
                        <div className="flex flex-wrap gap-x-3 gap-y-0.5 px-2 pb-1 text-[11px] text-muted-foreground">{t.evidence.slice(0, 4).map((e) => <span key={e.docId} className="inline-flex min-w-0 max-w-full items-center gap-1"><DateText value={e.date} className="text-[11px]" /><DocLink doc={{ id: e.docId, title: e.title, kind: "docket_entry", url: e.url }} className="max-w-[360px]" />{e.outcome && <span className="shrink-0">· {e.outcome.replace(/_/g, " ")}</span>}</span>)}</div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : <MethodNote>No motion outcomes are derivable from the records on file; outcomes are read from order and opinion titles and text, never inferred.</MethodNote>}
            </BodySection>

            <BodySection title="Timeline" count={profile.timeline.length || undefined}>
              {profile.timeline.length ? (
                <div className="space-y-2">
                  {months.map((m) => (
                    <div key={m.month}>
                      <div className="mb-0.5 text-[11.5px] font-medium text-muted-foreground">{m.label}</div>
                      <div className="divide-hairline rounded-md border">
                        {m.entries.slice().reverse().map((e, i) => (
                          <div key={`${e.at}-${i}`} className="flex min-h-7 items-center gap-3 px-2 py-0.5 text-[12px]">
                            <DateText value={e.at} className="w-[86px] shrink-0 text-[11px]" />
                            <span className="w-[80px] shrink-0 truncate text-[11px] text-muted-foreground">{chronologyKindLabel(e.kind)}</span>
                            <span className="min-w-0 flex-1 truncate" title={e.detail ?? e.title}>{e.evidence[0] && !e.evidence[0].docId.startsWith("tl_") ? <Link href={e.evidence[0].href ?? "#"} className="hover:text-primary hover:underline">{e.title}</Link> : e.title}</span>
                            <ConfidenceText value={e.confidence} />
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              ) : <MethodNote>No dated records yet.</MethodNote>}
            </BodySection>

            <BodySection title="Records" count={profile.counts.documents}>
              {profile.recent.length ? <DataTable rows={profile.recent} columns={docColumns} rowId={(d) => d.id} defaultSort={{ columnId: "date", dir: "desc" }} virtualize={false} fill={false} columnChooser={false} noun="record" ariaLabel="Records" /> : <MethodNote>No records linked yet.</MethodNote>}
              {profile.counts.documents > profile.recent.length && <MethodNote className="mt-1">Showing the {profile.recent.length} most recent of {fmtInt(profile.counts.documents)} records.</MethodNote>}
            </BodySection>
          </div>

          <aside className="min-w-0 space-y-5">
            <BodySection title="Attributes">
              <KeyValueList dense labelWidth={118} items={attributeItems(entity.attributes)} />
              {entity.externalIds && Object.keys(entity.externalIds).length > 0 && <KeyValueList dense labelWidth={118} className="mt-1" items={Object.entries(entity.externalIds).map(([k, v]) => ({ label: k, value: v, mono: true }))} />}
            </BodySection>
            <BodySection title="Related" count={profile.related.length || undefined}>
              {profile.related.length ? (
                <div className="divide-hairline">
                  {profile.related.map((r) => (
                    <div key={`${r.relation}-${r.entity.id}-${r.direction}`} className="flex h-7 items-center gap-2 text-[12px]" title={`${r.direction === "out" ? `${entity.name} ${RELATION_LABEL[r.relation]} ${r.entity.name}` : `${r.entity.name} ${RELATION_LABEL[r.relation]} ${entity.name}`} · ${r.weight} record${r.weight === 1 ? "" : "s"} · confidence ${Math.round(r.confidence * 100)}%`}>
                      <span className="w-[104px] shrink-0 truncate text-[11px] text-muted-foreground">{r.direction === "out" ? RELATION_LABEL[r.relation] : `← ${RELATION_LABEL[r.relation]}`}</span>
                      <EntityLink id={r.entity.id} type={r.entity.type} name={r.entity.name} className="min-w-0 flex-1" />
                      <span className="tabular text-[11px] text-muted-foreground">×{r.weight}</span>
                    </div>
                  ))}
                </div>
              ) : <MethodNote>No relations yet.</MethodNote>}
            </BodySection>
            {profile.matters.length > 0 && (
              <BodySection title="Matters" count={profile.matters.length}>
                <div className="divide-hairline">{profile.matters.map((m) => <div key={m.id} className="flex h-7 items-center text-[12px]"><Link href={matterHref(m.id)} className="truncate hover:text-primary hover:underline" title={m.name}>{m.shortName}</Link></div>)}</div>
              </BodySection>
            )}
            <BodySection title="Insights" count={profile.insights.length || undefined}>
              {profile.insights.length ? (
                <div className="divide-hairline">
                  {profile.insights.map((i) => (
                    <Link key={i.id} href={`/intel/insights?insight=${encodeURIComponent(i.id)}`} className="flex min-h-8 items-center gap-2 py-0.5 text-[12px] hover:bg-accent/50">
                      <span className="w-[70px] shrink-0 text-[11.5px] text-muted-foreground">{INSIGHT_KIND_LABEL[i.kind]}</span>
                      <span className="min-w-0 flex-1 truncate" title={i.summary}>{i.title}</span>
                      <TrustBadge provenance={i.provenance} compact />
                    </Link>
                  ))}
                </div>
              ) : <MethodNote>No insights mention this entity yet. Insights are composed by the analysis pass and carry evidence and a trust badge.</MethodNote>}
            </BodySection>
          </aside>
        </div>
      </div>
    </div>
  );
}
