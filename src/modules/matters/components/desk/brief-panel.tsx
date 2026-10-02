"use client";
import * as React from "react";
import { AlertTriangle, FileDown, FileText, Loader2, Square } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/misc";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Markdown } from "@/components/ai/markdown";
import { readSSE } from "@/lib/ai/sse";
import { useI18n } from "@/lib/i18n/client";
import { markdownToDoc } from "@/modules/office/shared/markdown-doc";
import { apiJSON, ApiError } from "../api";
import type { MatterRow } from "../../types";
import type { BriefStreamEvent, HearingBrief } from "../../desk/types";
import { PanelError, PanelSkeleton, useDeskFetch } from "./shared";

const STAGE_KEYS = { context: "desk.brief.stage.context", orders: "desk.brief.stage.orders", research: "desk.brief.stage.research", verify: "desk.brief.stage.verify", saved: "desk.brief.stage.saved" } as const;

type Run = { stage: keyof typeof STAGE_KEYS; tools: number; lastTool: string | null };

/**
 * Brief tab: prepare a hearing brief (streamed: stages and tool activity, cancellable), read stored versions and
 * export one to Word. `request` carries a listing chosen in the Hearings tab; each new request starts one run.
 */
export function BriefPanel({ matter, request }: { matter: MatterRow; request: { listingId: string | null; nonce: number } | null }) {
  const i18n = useI18n();
  const { t } = i18n;
  const res = useDeskFetch<{ briefs: HearingBrief[] }>(`/api/matters/${encodeURIComponent(matter.id)}/brief`);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [run, setRun] = React.useState<Run | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const abort = React.useRef<AbortController | null>(null);
  const handled = React.useRef<number | null>(null);
  const setData = res.setData;

  const start = React.useCallback(async (listingId: string | null) => {
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    setError(null);
    setRun({ stage: "context", tools: 0, lastTool: null });
    try {
      const resp = await fetch(`/api/matters/${encodeURIComponent(matter.id)}/brief`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(listingId ? { listingId } : {}), signal: ac.signal });
      if (!resp.ok) {
        const body = (await resp.json().catch(() => ({}))) as { error?: string; code?: string };
        throw new ApiError(resp.status === 503 ? t("settings.noProvider") : resp.status === 403 ? t("state.permissionDenied") : body.error ?? `HTTP ${resp.status}`, resp.status);
      }
      let done = false;
      await readSSE<BriefStreamEvent>(resp, (e) => {
        if (e.type === "stage") setRun((r) => (r ? { ...r, stage: e.stage } : r));
        else if (e.type === "tool") setRun((r) => (r ? { ...r, tools: r.tools + (e.ok === undefined ? 1 : 0), lastTool: e.label } : r));
        else if (e.type === "brief") {
          done = true;
          setData((d) => ({ briefs: [e.brief, ...(d?.briefs ?? []).filter((b) => b.id !== e.brief.id)] }));
          setSelected(e.brief.id);
        } else if (e.type === "error") {
          done = true;
          setError(e.code === "no_api_key" ? t("settings.noProvider") : e.message);
        }
      }, ac.signal);
      if (!done && !ac.signal.aborted) setError(t("desk.brief.failed"));
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError((e as Error).message);
    } finally {
      if (abort.current === ac) { abort.current = null; setRun(null); }
    }
  }, [matter.id, t, setData]);

  React.useEffect(() => {
    if (!request || handled.current === request.nonce) return;
    handled.current = request.nonce;
    void start(request.listingId);
  }, [request, start]);
  React.useEffect(() => () => abort.current?.abort(), []);

  const list = res.data?.briefs ?? [];
  const brief = list.find((b) => b.id === selected) ?? list[0] ?? null;
  const unsupported = brief?.claims.filter((c) => c.status === "unsupported").length ?? 0;

  const exportWord = async (b: HearingBrief) => {
    try {
      const r = await apiJSON<{ doc: { id: string } }>("/api/office/docs", { json: { kind: "word", title: `Hearing brief: ${matter.shortName || matter.name} (v${b.version})`, content: markdownToDoc(b.markdown), matterId: matter.id, tags: ["hearing-brief"], meta: { source: "matters.brief", briefId: b.id, briefHash: b.hash, briefVersion: b.version } } });
      toast.success(t("desk.brief.exported"), { action: { label: t("common.open"), onClick: () => window.open(`/office/word/${r.doc.id}`, "_blank") } });
    } catch (e) {
      toast.error(t("desk.toast.saveFailed"), { description: (e as Error).message });
    }
  };

  if (res.state === "loading") return <PanelSkeleton rows={3} />;
  if (res.state === "error") return <PanelError error={res.error} onRetry={res.reload} />;
  return (
    <div className="space-y-3 p-3">
      <div className="flex flex-wrap items-center gap-2">
        {run ? (
          <>
            <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-hidden />
            <span className="min-w-0 flex-1 truncate text-[12px]" aria-live="polite">{t(STAGE_KEYS[run.stage])}{run.tools ? ` · ${t("desk.brief.tools", { count: run.tools })}` : ""}</span>
            <Button size="xs" variant="ghost" onClick={() => abort.current?.abort()}><Square className="size-3" /> {t("desk.brief.stop")}</Button>
          </>
        ) : (
          <>
            <Button size="xs" variant={brief ? "outline" : "default"} onClick={() => void start(null)}><FileText className="size-3.5" /> {brief ? t("desk.brief.regenerate") : t("desk.brief.generate")}</Button>
            {list.length > 1 && (
              <Select value={brief?.id ?? ""} onValueChange={setSelected}>
                <SelectTrigger size="xs" className="h-7 w-auto text-[11.5px]" aria-label={t("desk.brief.versions")}><SelectValue /></SelectTrigger>
                <SelectContent>{list.map((b) => <SelectItem key={b.id} value={b.id}>{t("desk.brief.version", { version: b.version })} · {i18n.date(b.createdAt, "medium")}</SelectItem>)}</SelectContent>
              </Select>
            )}
            <div className="flex-1" />
            {brief && <Button size="xs" variant="ghost" onClick={() => void exportWord(brief)}><FileDown className="size-3.5" /> {t("desk.brief.exportWord")}</Button>}
          </>
        )}
      </div>
      {error && <p className="rounded border border-destructive/30 bg-destructive/5 px-2 py-1 text-[11.5px] text-destructive" role="alert">{error}</p>}
      {!brief ? (
        !run && <p className="text-[12px] leading-snug text-muted-foreground">{t("desk.brief.empty")}</p>
      ) : (
        <article className="space-y-2">
          <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
            <span>{t("desk.brief.version", { version: brief.version })} · {i18n.dateTime(brief.createdAt)}</span>
            {brief.listingDate && <span>· {t("desk.brief.forListing", { date: i18n.date(brief.listingDate, "medium") })}</span>}
            {brief.status === "partial" && <Chip tone="warning">{t("desk.brief.partial")}</Chip>}
            {unsupported > 0 && <Chip tone="warning" icon={AlertTriangle}>{t("desk.brief.unsupported", { count: unsupported })}</Chip>}
          </div>
          <div className="rounded-md border p-3">
            <Markdown compact>{brief.markdown}</Markdown>
          </div>
          <p className="font-mono text-[10.5px] text-muted-foreground" title={brief.hash}>sha256 {brief.hash.slice(0, 16)}…</p>
        </article>
      )}
    </div>
  );
}
