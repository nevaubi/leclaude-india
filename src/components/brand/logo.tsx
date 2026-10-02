import * as React from "react";
import { cn } from "@/lib/utils";
import { BRAND } from "@/lib/brand";

const SERIF = "'Source Serif 4 Variable', Georgia, 'Times New Roman', serif";
const SANS = "'Inter Variable', ui-sans-serif, system-ui, sans-serif";
const FULL_NAME = `${BRAND.name} ${BRAND.qualifier}`;

/**
 * Product marks (see src/lib/brand.ts), drawn as inline SVG in theme tokens so they render crisply in both themes
 * without network fonts. The monogram is a quiet serif initial on a primary tile for the navigation rail; the lockup
 * adds the product name with the market qualifier set in small caps. No flags or tricolour: the Counsel design system
 * stays restrained.
 */
export function BrandMark({ className, size = 32, title = FULL_NAME }: { className?: string; size?: number; title?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" role="img" aria-label={title} className={cn("shrink-0", className)}>
      <rect width="64" height="64" rx="10" style={{ fill: "var(--primary)" }} />
      <text x="32" y="44" textAnchor="middle" fontFamily={SERIF} fontWeight="600" fontSize="34" style={{ fill: "var(--primary-foreground)" }}>{BRAND.monogram}</text>
    </svg>
  );
}

/** Wordmark: the product name in the serif with the small-caps qualifier following it. */
export function BrandWordmark({ className, height = 28 }: { className?: string; height?: number }) {
  const width = (height * 300) / 60;
  return (
    <svg height={height} width={width} viewBox="0 0 300 60" role="img" aria-label={FULL_NAME} className={cn("shrink-0", className)}>
      <text x="0" y="42" fontFamily={SERIF} fontWeight="600" fontSize="40" letterSpacing="-0.5" fill="currentColor">
        {BRAND.name}
        <tspan dx="12" fontFamily={SANS} fontSize="15" letterSpacing="3" style={{ fill: "var(--muted-foreground)" }}>{BRAND.qualifier.toUpperCase()}</tspan>
      </text>
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
          <span className="block truncate font-serif text-[15px] font-semibold tracking-tight" dir="ltr">{BRAND.name} <span className="font-sans text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">{BRAND.qualifier}</span></span>
          {firmName && <span className="block truncate text-[10.5px] text-muted-foreground">{firmName}</span>}
        </span>
      )}
    </span>
  );
}

/** @deprecated Former monogram name, kept as an alias so older imports resolve to the neutral mark. */
export const SWMark = BrandMark;
