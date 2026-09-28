"use client";
import * as React from "react";
import { useT } from "@/lib/i18n/client";
import { X, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "./button";
import { Tip } from "./tooltip";

export interface InspectorTab { id: string; label: React.ReactNode; count?: number; disabled?: boolean }

export interface InspectorProps {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  icon?: LucideIcon;
  onClose?: () => void;
  closeShortcut?: string;
  tabs?: InspectorTab[];
  activeTab?: string;
  onTabChange?: (id: string) => void;
  /** Right-aligned header controls (before the close button). */
  actions?: React.ReactNode;
  /** Fixed width in px; omit to let the parent size it. */
  width?: number;
  minWidth?: number;
  maxWidth?: number;
  /** Drag the leading edge to resize; `onWidthChange` receives the new width. */
  resizable?: boolean;
  onWidthChange?: (w: number) => void;
  side?: "right" | "left";
  children: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
  bodyClassName?: string;
  /** Extra strip under the header (search box, filter chips). */
  toolbar?: React.ReactNode;
  ariaLabel?: string;
}

/**
 * Right-hand inspector: a 36px header (icon, title, subtitle, actions, close),
 * optional underline tabs, a scrolling body and a footer. Drag the leading
 * edge to resize when `resizable`. Quiet by design: hairline borders, no
 * shadow, no card-in-card.
 */
export function Inspector(p: InspectorProps) {
  const side = p.side ?? "right";
  const t = useT();
  const Icon = p.icon;
  const startResize = (e: React.PointerEvent) => {
    if (!p.resizable || !p.width) return;
    e.preventDefault();
    const startX = e.clientX, startW = p.width;
    const min = p.minWidth ?? 280, max = p.maxWidth ?? 720;
    const move = (ev: PointerEvent) => { const delta = side === "right" ? startX - ev.clientX : ev.clientX - startX; p.onWidthChange?.(Math.round(Math.max(min, Math.min(max, startW + delta)))); };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return (
    <aside className={cn("relative flex h-full min-h-0 shrink-0 flex-col bg-background", side === "right" ? "border-l" : "border-r", p.className)} style={p.width ? { width: p.width } : undefined} aria-label={p.ariaLabel ?? (typeof p.title === "string" ? p.title : undefined)}>
      {p.resizable && p.width && (
        <div role="separator" aria-orientation="vertical" aria-label={t("ui.resizePanel")} onPointerDown={startResize} className={cn("absolute inset-y-0 z-20 w-1.5 cursor-col-resize hover:bg-ring/40", side === "right" ? "-left-0.5" : "-right-0.5")} />
      )}
      <header className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
        {Icon && <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
        <div className="min-w-0 flex-1 leading-tight">
          <div className="truncate text-[12.5px] font-medium">{p.title}</div>
          {p.subtitle && <div className="truncate text-[11px] text-muted-foreground">{p.subtitle}</div>}
        </div>
        {p.actions && <div className="flex shrink-0 items-center gap-0.5">{p.actions}</div>}
        {p.onClose && (
          <Tip label={t("ui.close")} shortcut={p.closeShortcut}><Button variant="ghost" size="icon-xs" onClick={p.onClose} aria-label={t("ui.closePanel")}><X className="size-3.5" /></Button></Tip>
        )}
      </header>
      {p.tabs && p.tabs.length > 0 && (
        <div role="tablist" className="flex h-8 shrink-0 items-stretch gap-0.5 border-b px-2">
          {p.tabs.map((t) => {
            const active = t.id === p.activeTab;
            return (
              <button key={t.id} role="tab" aria-selected={active} disabled={t.disabled} onClick={() => p.onTabChange?.(t.id)} className={cn("relative flex items-center gap-1.5 px-2 text-[12px] font-medium transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-50", active ? "text-foreground" : "text-muted-foreground hover:text-foreground")}>
                {t.label}
                {t.count != null && t.count > 0 && <span className="tabular text-[10.5px] text-muted-foreground">{t.count}</span>}
                {active && <span className="absolute inset-x-1 bottom-0 h-0.5 bg-foreground" aria-hidden />}
              </button>
            );
          })}
        </div>
      )}
      {p.toolbar && <div className="shrink-0 border-b px-2 py-1.5">{p.toolbar}</div>}
      <div className={cn("min-h-0 flex-1 overflow-y-auto scrollbar-thin", p.bodyClassName)} role={p.tabs ? "tabpanel" : undefined}>{p.children}</div>
      {p.footer && <div className="shrink-0 border-t">{p.footer}</div>}
    </aside>
  );
}
