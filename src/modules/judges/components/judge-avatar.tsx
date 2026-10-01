"use client";
import * as React from "react";
import { cn } from "@/lib/utils";
import { judgeInitials } from "../names";
import type { JudgePhoto } from "../shared";

/**
 * A judge's official photograph (vision-checked, served from our media store) or their initials.
 * `fill` sizes the avatar from its className (e.g. a grid card) instead of `size`. */
export function JudgeAvatar({ name, photo, size = 32, fill = false, className, rounded = "full" }: { name: string; photo?: JudgePhoto | null; size?: number; fill?: boolean; className?: string; rounded?: "full" | "md" }) {
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => setFailed(false), [photo?.mediaId]);
  const shape = rounded === "full" ? "rounded-full" : "rounded-md";
  const style = fill ? undefined : { width: size, height: size };
  if (photo && !failed) {
    return (
      <span className={cn("inline-block shrink-0 overflow-hidden bg-muted ring-1 ring-border", shape, className)} style={style}>
        {/* eslint-disable-next-line @next/next/no-img-element -- served from our media store (content-addressed, cached) */}
        <img src={photo.url} alt={photo.alt ?? `Official photograph of ${name}`} className="size-full object-cover object-top" loading="lazy" decoding="async" onError={() => setFailed(true)} />
      </span>
    );
  }
  return (
    <span
      className={cn("inline-flex shrink-0 select-none items-center justify-center bg-muted font-medium text-muted-foreground ring-1 ring-border", shape, className)}
      style={{ ...style, fontSize: fill ? undefined : Math.max(9, Math.round(size * 0.36)) }}
      aria-hidden
    >
      {judgeInitials(name)}
    </span>
  );
}
