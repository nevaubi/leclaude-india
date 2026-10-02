"use client";
import * as React from "react";
import { TopbarSlot } from "./app-shell";
import { useInTabbedSection } from "./section-tabs";

/**
 * Standard page chrome inside the 44px top bar: icon, title, optional context
 * text and whatever the page adds (breadcrumb, one primary action). `icon` is a
 * rendered node (e.g. `<Radar className="size-4" />`) so server pages can pass it. In a section with a tab bar
 * the current tab already names the page, so the icon and title give way to the `crumb` (the open record, if any)
 * and the context.
 */
export function PageTopbar({ icon, title, crumb, context, children }: { icon?: React.ReactNode; title: React.ReactNode; crumb?: React.ReactNode; context?: React.ReactNode; children?: React.ReactNode }) {
  const tabbed = useInTabbedSection();
  return (
    <TopbarSlot>
      {!tabbed && icon && <span className="flex shrink-0 items-center text-muted-foreground [&>svg]:size-4" aria-hidden>{icon}</span>}
      {!tabbed && <span className="shrink-0 text-[13px] font-semibold">{title}</span>}
      {crumb && (
        <>
          {!tabbed && <span className="text-muted-foreground" aria-hidden>/</span>}
          <span className="min-w-0 max-w-[40vw] truncate text-[13px] font-semibold">{crumb}</span>
        </>
      )}
      {context && <span className="hidden min-w-0 truncate text-[12px] text-muted-foreground md:inline">{context}</span>}
      {children}
    </TopbarSlot>
  );
}
