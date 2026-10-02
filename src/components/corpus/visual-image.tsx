"use client";
import * as React from "react";
import type { Visual } from "@/modules/media/visuals-types";
import { cn } from "@/lib/utils";
import { creditLabel, placeholderColor, safeLink } from "./visual-credit";

/**
 * Images from the visual library (court buildings, city landmarks, regulator logos), always with their credit.
 *
 * - The frame has a fixed size or aspect ratio from `className`, so nothing shifts when the image arrives.
 * - The dominant colour fills the frame while the image loads; the image fades in; `loading="lazy"` by default.
 * - With no image (none stored, library unavailable, load error) the `fallback` tile is shown instead.
 */

function useLoaded(src: string | undefined) {
  const ref = React.useRef<HTMLImageElement>(null);
  const [loaded, setLoaded] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => {
    setFailed(false);
    // A cached image can complete before hydration attaches onLoad.
    const img = ref.current;
    setLoaded(Boolean(img && img.complete && img.naturalWidth > 0));
  }, [src]);
  return { ref, loaded, failed, onLoad: () => setLoaded(true), onError: () => setFailed(true) };
}

export type CreditMode = "hover" | "corner" | "none";

export function VisualImage({ visual, pending = false, fallback, className, imgClassName, credit = "hover", eager = false, contain = false, children }: {
  visual: Visual | null;
  /** The library is still loading: show the quiet placeholder, not the fallback tile. */
  pending?: boolean;
  fallback?: React.ReactNode;
  className?: string;
  imgClassName?: string;
  /** hover: the credit appears when the enclosing `group` is hovered or focused; corner: always visible. */
  credit?: CreditMode;
  eager?: boolean;
  /** Logos: fit inside the frame instead of covering it. */
  contain?: boolean;
  children?: React.ReactNode;
}) {
  const { ref, loaded, failed, onLoad, onError } = useLoaded(visual?.url);
  const show = Boolean(visual && !failed);
  const label = visual ? creditLabel(visual) : null;
  return (
    <div
      className={cn("relative isolate overflow-hidden bg-muted", className)}
      style={show ? { backgroundColor: placeholderColor(visual) } : undefined}
      title={show && label ? label : undefined}
    >
      {show && visual ? (
        // eslint-disable-next-line @next/next/no-img-element -- served from our media store (validated, content-addressed)
        <img
          ref={ref}
          src={visual.url}
          alt={visual.alt}
          width={visual.width ?? undefined}
          height={visual.height ?? undefined}
          loading={eager ? "eager" : "lazy"}
          decoding="async"
          onLoad={onLoad}
          onError={onError}
          className={cn("absolute inset-0 size-full transition-opacity duration-500 motion-reduce:transition-none", contain ? "object-contain p-[12%]" : "object-cover", loaded ? "opacity-100" : "opacity-0", imgClassName)}
        />
      ) : pending ? null : <div className="absolute inset-0">{fallback}</div>}
      {children}
      {show && label && credit !== "none" ? (
        <span
          className={cn(
            "pointer-events-none absolute bottom-1 right-1 z-[2] max-w-[calc(100%-0.5rem)] truncate rounded-[3px] bg-background/85 px-1 py-px text-[9.5px] leading-tight text-muted-foreground backdrop-blur-sm",
            credit === "hover" && "opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 group-focus-within:opacity-100",
          )}
        >
          {label}
        </span>
      ) : null}
    </div>
  );
}

/** The credit as a line with links to the source page and the licence (for heroes and captions outside a link). */
export function VisualCredit({ visual, className }: { visual: Visual; className?: string }) {
  const source = safeLink(visual.credit.sourceUrl);
  const licence = safeLink(visual.credit.licenseUrl);
  const c = visual.credit;
  if (visual.kind === "regulator_logo") {
    return <span className={cn("text-[10.5px] text-muted-foreground", className)}>Logo: {source ? <a className="hover:text-foreground hover:underline" href={source} target="_blank" rel="noopener noreferrer">{c.sourceName}</a> : c.sourceName}</span>;
  }
  return (
    <span className={cn("text-[10.5px] text-muted-foreground", className)}>
      Photo{c.author ? <>: {c.author}</> : null}
      {" · "}{licence ? <a className="hover:text-foreground hover:underline" href={licence} target="_blank" rel="noopener noreferrer">{c.license}</a> : c.license}
      {" · "}{source ? <a className="hover:text-foreground hover:underline" href={source} target="_blank" rel="noopener noreferrer">{c.sourceName}</a> : c.sourceName}
    </span>
  );
}

/**
 * A photograph as a quiet backdrop behind a header: muted, washed toward the page background so text in front keeps
 * its contrast in light and dark themes. Renders nothing without an image. The credit sits in the bottom-right corner.
 */
export function PhotoBackdrop({ visual, className }: { visual: Visual | null; className?: string }) {
  const { ref, loaded, failed, onLoad, onError } = useLoaded(visual?.url);
  if (!visual || failed) return null;
  return (
    <>
      <div aria-hidden className={cn("pointer-events-none absolute inset-0 -z-10 overflow-hidden", className)} style={{ backgroundColor: placeholderColor(visual) }}>
        {/* eslint-disable-next-line @next/next/no-img-element -- served from our media store (validated, content-addressed) */}
        <img ref={ref} src={visual.url} alt="" decoding="async" onLoad={onLoad} onError={onError}
          className={cn("absolute inset-0 size-full object-cover saturate-[0.8] transition-opacity duration-700 motion-reduce:transition-none", loaded ? "opacity-100" : "opacity-0")} />
        {/* Legibility wash: the page background over the photograph, strongest where the text sits. */}
        <div className="absolute inset-0 bg-gradient-to-r from-background from-30% via-background/88 to-background/45" />
        <div className="absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-background/70 to-transparent" />
      </div>
      <span className="sr-only">{visual.alt}</span>
      <VisualCredit visual={visual} className="absolute bottom-1.5 right-2.5 z-[1] max-w-[60%] truncate rounded-[3px] bg-background/70 px-1 backdrop-blur-sm" />
    </>
  );
}

/** Typographic stand-in for a missing image: a quiet surface with the place name set large. */
export function TypeTile({ title, subtitle, className, size = "md" }: { title: string; subtitle?: string | null; className?: string; size?: "sm" | "md" | "lg" }) {
  return (
    <div className={cn("flex size-full flex-col justify-end bg-[color-mix(in_oklab,var(--muted)_70%,var(--background))] p-3", className)} aria-hidden>
      <span className={cn("font-serif leading-none tracking-[-0.01em] text-foreground/35", size === "lg" ? "text-[40px]" : size === "sm" ? "text-[15px]" : "text-[26px]")}>{title}</span>
      {subtitle ? <span className="mt-1 text-[10.5px] uppercase tracking-[0.08em] text-muted-foreground/80">{subtitle}</span> : null}
    </div>
  );
}
