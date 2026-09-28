import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * LeClaude India marks, drawn as inline SVG in theme tokens so they render crisply in both themes without network
 * fonts. The monogram is a quiet "LC" tile for the navigation rail; the lockup adds the product name with "India"
 * set as a small-caps qualifier. No flags or tricolour: the Counsel design system stays restrained.
 */
export function BrandMark({ className, size = 32, title = "LeClaude India" }: { className?: string; size?: number; title?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" role="img" aria-label={title} className={cn("shrink-0", className)}>
      <rect width="64" height="64" rx="10" style={{ fill: "var(--primary)" }} />
      <text x="32" y="42" textAnchor="middle" fontFamily="'Source Serif 4 Variable', Georgia, 'Times New Roman', serif" fontWeight="600" fontSize="28" letterSpacing="-0.5" style={{ fill: "var(--primary-foreground)" }}>LC</text>
    </svg>
  );
}

/** Wordmark: "LeClaude" in the serif with a small-caps "INDIA" qualifier. */
export function BrandWordmark({ className, height = 28 }: { className?: string; height?: number }) {
  const width = (height * 300) / 60;
  return (
    <svg height={height} width={width} viewBox="0 0 300 60" role="img" aria-label="LeClaude India" className={cn("shrink-0", className)}>
      <text x="0" y="42" fontFamily="'Source Serif 4 Variable', Georgia, 'Times New Roman', serif" fontWeight="600" fontSize="40" letterSpacing="-1" fill="currentColor">LeClaude</text>
      <text x="196" y="42" fontFamily="'Inter Variable', ui-sans-serif, system-ui, sans-serif" fontWeight="600" fontSize="15" letterSpacing="3" style={{ fill: "var(--muted-foreground)" }}>INDIA</text>
    </svg>
  );
}

/** Compact lockup for headers: monogram + product name + an optional firm line. */
export function BrandLockup({ collapsed, className, firmName }: { collapsed?: boolean; className?: string; firmName?: string }) {
  return (
    <span className={cn("flex min-w-0 items-center gap-2.5", className)}>
      <BrandMark size={28} />
      {!collapsed && (
        <span className="min-w-0 leading-tight">
          <span className="block truncate font-serif text-[15px] font-semibold tracking-tight" dir="ltr">LeClaude <span className="font-sans text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">India</span></span>
          {firmName && <span className="block truncate text-[10.5px] text-muted-foreground">{firmName}</span>}
        </span>
      )}
    </span>
  );
}

/** @deprecated Former monogram name, kept as an alias so older imports resolve to the neutral mark. */
export const SWMark = BrandMark;
