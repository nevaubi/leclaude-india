"use client";
import * as React from "react";
import { cn } from "@/lib/utils";
import { courtById } from "@/lib/india/courts";
import { TypeTile, VisualImage, type CreditMode } from "@/components/corpus/visual-image";
import { courtVisual, useVisuals } from "@/modules/media/use-visuals";
import { courtShortName, type CourtFacet } from "../shared";

const fmt = (n: number) => n.toLocaleString("en-IN");

/** "High Court of Bombay" → "Bombay"; "Supreme Court of India" → "Supreme Court"; other forms are kept. */
export function courtPlace(courtId: string | null | undefined, name?: string | null): string {
  if (courtId === "sci") return "Supreme Court";
  const n = courtById(courtId)?.name ?? name ?? "";
  const short = courtShortName(n);
  return short.endsWith(" HC") ? short.slice(0, -3) : short.replace(/\s+High Court$/, "") || "Court";
}

/** A court's building photograph in a fixed frame, or a typographic tile with its place name. */
export function CourtPhoto({ courtId, name, className, credit = "hover", eager, size = "md" }: { courtId: string | null | undefined; name?: string | null; className?: string; credit?: CreditMode; eager?: boolean; size?: "sm" | "md" | "lg" }) {
  const data = useVisuals();
  const v = courtVisual(data, courtId);
  const place = courtPlace(courtId, name);
  return (
    <VisualImage
      visual={v}
      pending={!data}
      credit={credit}
      eager={eager}
      className={className}
      fallback={<TypeTile title={place} subtitle={courtId === "sci" ? "of India" : courtId ? "High Court" : null} size={size} />}
    />
  );
}

/** Small square court avatar (list rows): the building photo, else a monogram. No credit overlay at this size; the credit is in the title. */
export function CourtThumb({ courtId, name, size = 36, className }: { courtId: string | null | undefined; name?: string | null; size?: number; className?: string }) {
  const data = useVisuals();
  const v = courtVisual(data, courtId);
  const place = courtPlace(courtId, name);
  const letters = courtId === "sci" ? "SC" : place.split(/[\s&]+/).filter(Boolean).map((w) => w[0]).join("").slice(0, 2).toUpperCase() || "C";
  return (
    <span className={cn("inline-block shrink-0 overflow-hidden rounded-md ring-1 ring-border", className)} style={{ width: size, height: size }}>
      <VisualImage
        visual={v}
        pending={!data}
        credit="none"
        className="size-full"
        fallback={<span aria-hidden className="flex size-full items-center justify-center bg-muted font-serif text-[13px] text-muted-foreground">{letters}</span>}
      />
    </span>
  );
}

/** Decisions per year as quiet bars (oldest → newest); each bar carries its year and count. */
export function YearSparkline({ years, className, height = 28 }: { years: CourtFacet["years"]; className?: string; height?: number }) {
  const ys = years.filter((y): y is { year: number; records: number } => y.year != null).sort((a, b) => a.year - b.year);
  if (ys.length < 2) return null;
  const max = Math.max(...ys.map((y) => y.records), 1);
  return (
    <div className={cn("flex items-end gap-px", className)} style={{ height }} role="img" aria-label={`Decisions per year, ${ys[0].year} to ${ys[ys.length - 1].year}`}>
      {ys.map((y) => (
        <span
          key={y.year}
          title={`${y.year}: ${fmt(y.records)} decisions`}
          className="min-w-px max-w-2.5 flex-1 rounded-t-[1.5px] bg-primary/30 transition-colors hover:bg-primary/70 dark:bg-primary/35"
          style={{ height: `${Math.max(5, (y.records / max) * 100)}%` }}
        />
      ))}
    </div>
  );
}
