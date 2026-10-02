"use client";
import * as React from "react";
import { AlertTriangle, CalendarOff, Database, ExternalLink, RotateCw, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import { apiJSON, ApiError } from "../api";
import type { CauseListEntry, ListingSource, MatterCaseIdentifier, OfficialState } from "../../desk/types";

export interface DeskFetch<T> {
  state: "loading" | "ready" | "error";
  data: T | null;
  error: ApiError | null;
  reload: () => void;
  setData: React.Dispatch<React.SetStateAction<T | null>>;
}

/** Fetch JSON with abort + reload; errors keep their HTTP status so the panel can show denied vs failed. */
export function useDeskFetch<T>(url: string | null): DeskFetch<T> {
  const [nonce, setNonce] = React.useState(0);
  const [data, setData] = React.useState<T | null>(null);
  const [error, setError] = React.useState<ApiError | null>(null);
  const [state, setState] = React.useState<"loading" | "ready" | "error">("loading");
  React.useEffect(() => {
    if (!url) return;
    const ac = new AbortController();
    setState((s) => (s === "ready" ? s : "loading"));
    apiJSON<T>(url, { signal: ac.signal })
      .then((r) => { setData(r); setError(null); setState("ready"); })
      .catch((e) => {
        if ((e as Error).name === "AbortError") return;
        setError(e instanceof ApiError ? e : new ApiError((e as Error).message, 0));
        setState("error");
      });
    return () => ac.abort();
  }, [url, nonce]);
  const reload = React.useCallback(() => setNonce((n) => n + 1), []);
  return { state, data, error, reload, setData };
}

export function PanelSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2 p-3" aria-busy="true">
      {Array.from({ length: rows }, (_, i) => <Skeleton key={i} className="h-12" />)}
    </div>
  );
}

/** Denied / failed state for a desk panel (403 and 401 read as no access, never as "empty"). */
export function PanelError({ error, onRetry, className }: { error: ApiError | null; onRetry?: () => void; className?: string }) {
  const { t } = useI18n();
  const denied = error?.status === 403 || error?.status === 401;
  return (
    <div className={cn("flex flex-col items-center gap-1.5 px-4 py-8 text-center", className)} role="alert">
      {denied ? <ShieldAlert className="size-4 text-muted-foreground" aria-hidden /> : <AlertTriangle className="size-4 text-muted-foreground" aria-hidden />}
      <p className="text-[12.5px] font-medium">{denied ? t("state.permissionDenied") : t("state.couldNotLoad")}</p>
      <p className="max-w-xs text-[11.5px] text-muted-foreground">{denied ? t("state.permissionDeniedHint") : error?.message}</p>
      {!denied && onRetry && <Button size="xs" variant="ghost" onClick={onRetry}><RotateCw className="size-3.5" /> {t("common.retry")}</Button>}
    </div>
  );
}

/** The official corpus is not usable here: not configured, not wired yet, or failing. Quiet, never alarming. */
export function OfficialNotice({ state, message, onRetry, compact }: { state: OfficialState; message?: string; onRetry?: () => void; compact?: boolean }) {
  const { t } = useI18n();
  if (state === "ok") return null;
  const Icon = state === "not_configured" ? Database : state === "not_available" ? CalendarOff : AlertTriangle;
  const title = state === "not_configured" ? t("desk.state.notConfigured") : state === "not_available" ? t("desk.state.notAvailable") : t("desk.state.error");
  const hint = state === "not_configured" ? t("desk.state.notConfiguredHint") : state === "not_available" ? t("desk.state.notAvailableHint") : message;
  return (
    <div className={cn("flex items-start gap-2 rounded-md border border-dashed px-2.5 py-2", compact ? "text-[11.5px]" : "text-[12px]")} role="status">
      <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="font-medium text-foreground">{title}</div>
        {hint && <div className="mt-0.5 text-muted-foreground">{hint}</div>}
      </div>
      {state === "error" && onRetry && <Button size="icon-xs" variant="ghost" onClick={onRetry} aria-label={t("common.retry")}><RotateCw className="size-3.5" /></Button>}
    </div>
  );
}

/** Only http(s) links are rendered as links (publisher URLs come from the corpus; anything else is shown as text). */
export function safeHref(url: string | null | undefined): string | null {
  return url && /^https?:\/\//i.test(url.trim()) ? url.trim() : null;
}

/** "Lists are published by the courts; online lists are not authoritative." */
export function AuthorityNote({ className }: { className?: string }) {
  const { t } = useI18n();
  return <p className={cn("text-[11px] leading-snug text-muted-foreground", className)}>{t("desk.notAuthoritative")}</p>;
}

const LIST_TYPE_KEYS = { main: "desk.listType.main", supplementary: "desk.listType.supplementary", advance: "desk.listType.advance", weekly: "desk.listType.weekly", daily: "desk.listType.daily", other: "desk.listType.other" } as const;

/** One cause-list entry: court / item / bench, the entry as printed, and where it was published. */
export function ListingDetails({ entry, source, matchedOn, printed, showDate, className }: { entry: CauseListEntry; source: ListingSource | null; matchedOn?: MatterCaseIdentifier; printed?: string; showDate?: boolean; className?: string }) {
  const i18n = useI18n();
  const { t } = i18n;
  const [open, setOpen] = React.useState(false);
  return (
    <div className={cn("min-w-0 space-y-1", className)}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[12.5px]">
        {showDate && <span className="font-medium tabular">{i18n.date(entry.listDate, "full")}</span>}
        {entry.courtNo && <span className="font-medium">{t("desk.court", { no: entry.courtNo })}</span>}
        {entry.itemNo && <span className="tabular">{t("desk.item", { no: entry.itemNo })}</span>}
        <span className="text-[11px] text-muted-foreground">{t(LIST_TYPE_KEYS[entry.listType] ?? "desk.listType.other")}</span>
      </div>
      {entry.bench && <div className="truncate text-[11.5px] text-muted-foreground" title={entry.bench}>{entry.bench}</div>}
      {entry.parties && <div className="line-clamp-2 text-[12px]">{entry.parties}</div>}
      {matchedOn && <div className="text-[11px] text-muted-foreground">{t("desk.matchedOn", { value: printed ?? matchedOn.value })}</div>}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
        <span>{entry.publishedAt ? t("desk.asPublished", { at: i18n.dateTime(entry.publishedAt) }) : t("desk.asFetched", { at: i18n.dateTime(entry.fetchedAt) })}</span>
        {source && safeHref(source.url) ? (
          <a href={safeHref(source.url)!} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground" title={source.title}>
            {t("desk.sourceList")}{entry.page ? ` · ${t("desk.page", { page: entry.page })}` : ""}<ExternalLink className="size-3" aria-hidden />
          </a>
        ) : <span>{t("desk.sourceUnavailable")}</span>}
        <button type="button" className="underline decoration-dotted underline-offset-2 hover:text-foreground" onClick={() => setOpen((v) => !v)} aria-expanded={open}>{open ? t("desk.hidePrinted") : t("desk.showPrinted")}</button>
      </div>
      {open && <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded border bg-[var(--surface-quiet)] p-2 font-mono text-[11px] leading-snug">{entry.raw}</pre>}
    </div>
  );
}
