"use client";
import * as React from "react";
import { Database, Lock, RotateCcw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/misc";
import { cn } from "@/lib/utils";
import type { OfficialStatus } from "@/modules/official/service";
import { asOfficialApiError, fetchOfficialJson, type OfficialApiError } from "../fetch";
import { OCR_BADGE } from "../shared";

/** Not configured / not available yet / no access: states in which nothing from another source is shown instead. */
export function OfficialUnavailable({ error, className, compact }: { error: OfficialApiError; className?: string; compact?: boolean }) {
  if (error.notConfigured) return <EmptyState compact={compact} className={className} icon={Database} title="Official sources are not set up" description="This workspace has no database for official court, tribunal and regulator documents." />;
  if (error.notAvailable) return <EmptyState compact={compact} className={className} icon={Database} title="Official sources are not available yet" description="Court, tribunal and regulator documents will appear here once they have been added to this workspace." />;
  if (error.forbidden || error.unauthenticated) return <EmptyState compact={compact} className={className} icon={Lock} title={error.unauthenticated ? "Sign in to view official sources" : "You do not have access to official sources"} description={error.unauthenticated ? "Your session has ended." : "Ask an administrator for research access."} />;
  return null;
}

export function isOfficialUnavailable(e: OfficialApiError | null | undefined): boolean {
  return Boolean(e && (e.notConfigured || e.notAvailable || e.forbidden || e.unauthenticated));
}

export function OfficialErrorState({ title, error, onRetry, className, compact }: { title: string; error: OfficialApiError; onRetry?: () => void; className?: string; compact?: boolean }) {
  return <EmptyState compact={compact} className={className} icon={TriangleAlert} title={title} description={error.timedOut ? "The search took too long. Add words or narrow the sources and try again." : error.message} action={onRetry ? <Button size="xs" variant="outline" onClick={onRetry}><RotateCcw className="size-3.5" />Retry</Button> : undefined} />;
}

/** The OCR label, always shown on text that came from OCR. */
export function OcrBadge({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex h-5 items-center gap-1 whitespace-nowrap rounded-[var(--radius-chip)] border border-warning/40 bg-warning/5 px-1.5 text-[11px] font-medium leading-none text-warning-foreground dark:text-warning", className)}>
      {OCR_BADGE}
    </span>
  );
}

// ---------------------------------------------------------------------------
// GET /api/official (status), shared by the library page and the reader for one page session
// ---------------------------------------------------------------------------

let statusMemo: { at: number; value: OfficialStatus } | null = null;
const STATUS_TTL = 30_000;

export function useOfficialStatus(): { status: OfficialStatus | null; error: OfficialApiError | null; loading: boolean; retry: () => void } {
  const fresh = statusMemo && Date.now() - statusMemo.at < STATUS_TTL ? statusMemo.value : null;
  const [status, setStatus] = React.useState<OfficialStatus | null>(fresh);
  const [error, setError] = React.useState<OfficialApiError | null>(null);
  const [loading, setLoading] = React.useState(!fresh);
  const [nonce, setNonce] = React.useState(0);
  React.useEffect(() => {
    if (!nonce && statusMemo && Date.now() - statusMemo.at < STATUS_TTL) return;
    const ac = new AbortController();
    setLoading(true);
    setError(null);
    fetchOfficialJson<OfficialStatus>("/api/official", ac.signal)
      .then((s) => { statusMemo = { at: Date.now(), value: s }; setStatus(s); })
      .catch((e) => { if ((e as Error).name !== "AbortError") { setStatus(null); setError(asOfficialApiError(e)); } })
      .finally(() => { if (!ac.signal.aborted) setLoading(false); });
    return () => ac.abort();
  }, [nonce]);
  return { status, error, loading, retry: () => setNonce((n) => n + 1) };
}
