"use client";
import * as React from "react";
import { AlertTriangle, Check, ChevronDown, ChevronRight, ExternalLink, ListChecks, Loader2, RotateCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Chip } from "@/components/ui/misc";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import { apiJSON, ApiError } from "../api";
import type { MatterRow } from "../../types";
import type { MatterOrder, OrderActionItem, OrderActionSet, OrdersResponse } from "../../desk/types";
import { NotCheckable } from "./hearings-panel";
import { OfficialNotice, PanelError, PanelSkeleton, safeHref, useDeskFetch } from "./shared";

const GAP_KEYS = {
  no_period: "desk.gap.noPeriod", period_not_in_text: "desk.gap.periodNotInText", runs_from_event: "desk.gap.runsFromEvent",
  unparsed_period: "desk.gap.unparsedPeriod", no_order_date: "desk.gap.noOrderDate", quote_not_found: "desk.gap.quoteNotFound",
} as const;

/** Orders tab: orders published for the tracked identifiers, action items extracted for review, reviewer confirmation. */
export function OrdersPanel({ matter }: { matter: MatterRow }) {
  const { t } = useI18n();
  const res = useDeskFetch<OrdersResponse>(`/api/matters/${encodeURIComponent(matter.id)}/orders`);
  const [openId, setOpenId] = React.useState<string | null>(null);
  if (res.state === "loading") return <PanelSkeleton rows={3} />;
  if (res.state === "error") return <PanelError error={res.error} onRetry={res.reload} />;
  const d = res.data!;
  return (
    <div className="space-y-2 p-3">
      <div className="mb-1 flex items-center gap-2">
        <h3 className="text-[11.5px] font-medium text-muted-foreground">{t("desk.orders")}</h3>
        <div className="flex-1" />
        <Button size="icon-xs" variant="ghost" onClick={res.reload} aria-label={t("common.refresh")}><RotateCw className="size-3.5" /></Button>
      </div>
      {d.state !== "ok" ? <OfficialNotice state={d.state} message={d.message} onRetry={res.reload} /> : d.untracked ? (
        <p className="text-[12px] text-muted-foreground">{t("desk.untracked")}</p>
      ) : !d.orders.length ? (
        <p className="text-[12px] text-muted-foreground">{t("desk.noOrders")}</p>
      ) : (
        <ul className="space-y-2">
          {d.orders.map((o) => (
            <OrderRow key={o.document.id} matterId={matter.id} order={o} open={openId === o.document.id} onToggle={() => setOpenId((v) => (v === o.document.id ? null : o.document.id))} onChanged={res.reload} />
          ))}
        </ul>
      )}
      {d.state === "ok" && !!d.unmatchable?.length && <NotCheckable ids={d.unmatchable} />}
    </div>
  );
}

function OrderRow({ matterId, order, open, onToggle, onChanged }: { matterId: string; order: MatterOrder; open: boolean; onToggle: () => void; onChanged: () => void }) {
  const i18n = useI18n();
  const { t } = i18n;
  const doc = order.document;
  const a = order.actions;
  const [busy, setBusy] = React.useState(false);
  const [set, setSet] = React.useState<OrderActionSet | null>(null);
  const [loadError, setLoadError] = React.useState<ApiError | null>(null);

  React.useEffect(() => {
    if (!open || !a || set?.id === a.id) return;
    const ac = new AbortController();
    apiJSON<{ sets: OrderActionSet[] }>(`/api/matters/${encodeURIComponent(matterId)}/orders/actions?documentId=${encodeURIComponent(doc.id)}`, { signal: ac.signal })
      .then((r) => { setSet(r.sets.find((s) => s.id === a.id) ?? r.sets[0] ?? null); setLoadError(null); })
      .catch((e) => { if ((e as Error).name !== "AbortError") setLoadError(e as ApiError); });
    return () => ac.abort();
  }, [open, a, set?.id, matterId, doc.id]);

  const extract = async () => {
    setBusy(true);
    try {
      const r = await apiJSON<{ set: OrderActionSet }>(`/api/matters/${encodeURIComponent(matterId)}/orders/actions`, { json: { documentId: doc.id } });
      setSet(r.set);
      toast.success(t("desk.toast.extracted"));
      if (!open) onToggle();
      onChanged();
    } catch (e) {
      const err = e as ApiError;
      toast.error(err.status === 503 ? t("settings.noProvider") : t("desk.toast.extractFailed"), { description: err.status === 503 ? undefined : err.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="rounded-md border">
      <div className="flex items-start gap-2 p-2">
        <button type="button" onClick={onToggle} disabled={!a} aria-expanded={open} aria-label={t("desk.showItems")} className="mt-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30">
          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 text-[12.5px]">
            <span className="font-medium tabular">{doc.docDate ? i18n.date(doc.docDate, "medium") : t("desk.undated")}</span>
            <span className="text-[11px] text-muted-foreground">{doc.kind === "judgment" ? t("desk.judgment") : t("desk.order")}</span>
          </div>
          <div className="line-clamp-2 text-[12px]" title={doc.title}>{doc.title}</div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
            {safeHref(doc.fileUrl ?? doc.url) && <a href={safeHref(doc.fileUrl ?? doc.url)!} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground">{t("desk.officialCopy")}<ExternalLink className="size-3" aria-hidden /></a>}
            {doc.extraction === "ocr_model" && <span>{t("desk.ocrText")}</span>}
            {a && (a.stale ? <Chip tone="warning">{t("desk.staleShort")}</Chip> : a.status === "reviewed" ? <Chip tone="quiet" icon={Check}>{t("desk.reviewedShort")}</Chip> : <Chip tone="quiet">{t("desk.pendingReview")}</Chip>)}
            {a && a.flagged > 0 && !a.stale && <Chip tone="warning" icon={AlertTriangle}>{t("desk.flagged", { count: a.flagged })}</Chip>}
          </div>
        </div>
        {(!a || a.stale) && (
          <Button size="xs" variant="outline" disabled={busy || doc.status !== "indexed"} onClick={() => void extract()} title={doc.status !== "indexed" ? t("desk.notIndexed") : undefined}>
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <ListChecks className="size-3.5" />} {busy ? t("desk.extracting") : a?.stale ? t("desk.reextract") : t("desk.extract")}
          </Button>
        )}
      </div>
      {open && (
        <div className="border-t px-2 pb-2 pt-1.5">
          {loadError ? <PanelError error={loadError} /> : !set ? <PanelSkeleton rows={1} /> : <ActionSetView key={set.id} matterId={matterId} set={set} stale={!!a?.stale} onReviewed={(s) => { setSet(s); onChanged(); }} />}
        </div>
      )}
    </li>
  );
}

function QuoteBadge({ item }: { item: OrderActionItem }) {
  const { t } = useI18n();
  const c = item.check;
  if (!c.quoteFound) return <Chip tone="warning" icon={AlertTriangle}>{t("desk.quoteMissing")}</Chip>;
  if (!c.pageVerified) {
    const pages = c.foundPages?.start != null ? (c.foundPages.end != null && c.foundPages.end !== c.foundPages.start ? `${c.foundPages.start}–${c.foundPages.end}` : String(c.foundPages.start)) : "?";
    return <Chip tone="warning">{t("desk.quoteOtherPage", { pages })}</Chip>;
  }
  return <Chip tone="quiet" icon={Check}>{t("desk.quoteVerified")}</Chip>;
}

function ItemView({ item, children }: { item: OrderActionItem; children?: React.ReactNode }) {
  const i18n = useI18n();
  const { t } = i18n;
  return (
    <div className={cn("space-y-1 rounded border p-2", item.flagged && "border-warning/40 bg-warning/5")}>
      <div className="text-[12.5px] leading-snug">{item.text}{item.party && <span className="text-muted-foreground"> · {item.party}</span>}</div>
      {item.quote && <blockquote className="border-s-2 ps-2 text-[11.5px] italic leading-snug text-muted-foreground">“{item.quote}”{item.page ? ` (${t("desk.page", { page: item.page })})` : ""}</blockquote>}
      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
        <QuoteBadge item={item} />
        {item.deadline ? (
          <span className="text-foreground" title={item.deadline.rule}>{t(item.kind === "next_date" ? "desk.nextDateOn" : "desk.deadline", { date: i18n.date(item.deadline.date, "medium") })} <span className="text-muted-foreground">· {item.deadline.rule}</span></span>
        ) : item.deadlineGap && item.kind !== "direction" ? <span className="text-muted-foreground">{t(GAP_KEYS[item.deadlineGap])}</span> : null}
      </div>
      {children}
    </div>
  );
}

function ActionSetView({ matterId, set, stale, onReviewed }: { matterId: string; set: OrderActionSet; stale: boolean; onReviewed: (s: OrderActionSet) => void }) {
  const i18n = useI18n();
  const { t } = i18n;
  const compliance = set.items.filter((i) => i.kind === "compliance");
  const [picks, setPicks] = React.useState<Record<string, { create: boolean; dueAt: string }>>(() => Object.fromEntries(compliance.map((i) => [i.id, { create: false, dueAt: i.deadline?.date ?? "" }])));
  const [busy, setBusy] = React.useState(false);
  const pending = set.status === "pending_review" && !stale;
  const chosen = Object.values(picks).filter((p) => p.create).length;

  const confirm = async () => {
    setBusy(true);
    try {
      const r = await apiJSON<{ set: OrderActionSet; created: string[] }>(`/api/matters/${encodeURIComponent(matterId)}/orders/actions/${encodeURIComponent(set.id)}/review`, { json: { decisions: compliance.map((i) => ({ itemId: i.id, create: picks[i.id]?.create ?? false, dueAt: picks[i.id]?.dueAt || null })) } });
      onReviewed(r.set);
      toast.success(t("desk.toast.reviewed", { count: r.created.length }));
    } catch (e) {
      toast.error(t("desk.toast.saveFailed"), { description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const groups: { key: OrderActionItem["kind"]; title: string }[] = [
    { key: "next_date", title: t("desk.section.nextDate") },
    { key: "compliance", title: t("desk.section.compliance") },
    { key: "direction", title: t("desk.section.directions") },
  ];
  const decisions = new Map((set.review?.decisions ?? []).map((d) => [d.itemId, d]));
  return (
    <div className="space-y-2.5">
      {stale && <p className="rounded border border-warning/40 bg-warning/5 px-2 py-1 text-[11.5px]">{t("desk.stale")}</p>}
      {set.coverage === "partial" && <p className="text-[11.5px] text-muted-foreground">{t("desk.coveragePartial")}</p>}
      {!set.items.length && <p className="text-[12px] text-muted-foreground">{t("desk.noItems")}</p>}
      {groups.map((g) => {
        const items = set.items.filter((i) => i.kind === g.key);
        if (!items.length) return null;
        return (
          <div key={g.key} className="space-y-1.5">
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{g.title}</div>
            {items.map((item) => (
              <ItemView key={item.id} item={item}>
                {item.kind === "compliance" && pending && (
                  <div className="flex flex-wrap items-center gap-2 pt-0.5">
                    <label className="inline-flex items-center gap-1.5 text-[11.5px]">
                      <Checkbox checked={picks[item.id]?.create ?? false} onCheckedChange={(v) => setPicks((p) => ({ ...p, [item.id]: { ...p[item.id], create: v === true } }))} />
                      {t("desk.createTask")}
                    </label>
                    <label className="inline-flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
                      {t("desk.dueDate")}
                      <Input type="date" value={picks[item.id]?.dueAt ?? ""} onChange={(e) => setPicks((p) => ({ ...p, [item.id]: { ...p[item.id], dueAt: e.target.value } }))} className="h-7 w-[140px] text-[11.5px] text-foreground" />
                    </label>
                  </div>
                )}
                {item.kind === "compliance" && decisions.get(item.id)?.create && <div className="text-[11px] text-muted-foreground">{t("desk.taskCreated", { date: decisions.get(item.id)?.dueAt ? i18n.date(decisions.get(item.id)!.dueAt!, "medium") : "—" })}</div>}
              </ItemView>
            ))}
          </div>
        );
      })}
      {pending && compliance.length > 0 && (
        <div className="space-y-1.5 border-t pt-2">
          <p className="text-[11px] leading-snug text-muted-foreground">{t("desk.reviewHint")}</p>
          <div className="flex justify-end">
            <Button size="xs" onClick={() => void confirm()} disabled={busy}>{busy && <Loader2 className="size-3.5 animate-spin" />} {chosen ? t("desk.confirmCreate", { count: chosen }) : t("desk.confirmNone")}</Button>
          </div>
        </div>
      )}
      {set.review && <p className="text-[11px] text-muted-foreground">{t("desk.reviewed", { at: i18n.dateTime(set.review.reviewedAt), count: set.review.decisions.filter((d) => d.create).length })}</p>}
    </div>
  );
}
