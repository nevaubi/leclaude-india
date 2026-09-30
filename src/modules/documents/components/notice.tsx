import * as React from "react";
import { AlertTriangle, Info, ShieldAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { StatusDot } from "@/components/ui/misc";
import type { DocFileStatus } from "../types";
import { STATUS_META } from "./format";

/** One quiet inline message (banner) for states such as storage full, AI unavailable or an error. */
export function Notice({ tone = "info", children, className, action }: { tone?: "info" | "warning" | "destructive" | "denied"; children: React.ReactNode; className?: string; action?: React.ReactNode }) {
  const Icon = tone === "denied" ? ShieldAlert : tone === "info" ? Info : AlertTriangle;
  return (
    <div role={tone === "destructive" ? "alert" : "status"}
      className={cn("flex items-start gap-2 rounded-md border px-3 py-2 text-[12.5px] leading-snug",
        tone === "destructive" ? "border-destructive/30 bg-destructive/5 text-foreground" : tone === "warning" ? "border-warning/40 bg-warning/10 text-foreground" : "bg-surface-quiet text-muted-foreground", className)}>
      <Icon className={cn("mt-0.5 size-3.5 shrink-0", tone === "destructive" ? "text-destructive" : tone === "warning" ? "text-warning-foreground dark:text-warning" : "text-muted-foreground")} aria-hidden />
      <div className="min-w-0 flex-1">{children}</div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

/** A file status as a dot + label. */
export function FileStatus({ status }: { status: DocFileStatus }) {
  const m = STATUS_META[status];
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px]">
      <StatusDot tone={m.tone} />
      <span className={cn(status === "failed" ? "text-foreground" : "text-muted-foreground")}>{m.label}</span>
    </span>
  );
}

/** Centered surface state (empty, error, denied, not configured). */
export function SurfaceState({ icon: Icon, title, children, action, className }: { icon?: React.ComponentType<{ className?: string }>; title: string; children?: React.ReactNode; action?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-1.5 px-6 py-12 text-center", className)} role="status">
      {Icon && <Icon className="mb-1 size-5 text-muted-foreground/70" aria-hidden />}
      <div className="text-[13px] font-medium">{title}</div>
      {children && <div className="max-w-md text-[12px] leading-snug text-muted-foreground">{children}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
