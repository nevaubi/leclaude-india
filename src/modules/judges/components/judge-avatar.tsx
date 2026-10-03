"use client";
import * as React from "react";
import { displayImageUrl, displayImageSrcSet } from "@/modules/media/display";
import { cn } from "@/lib/utils";
import { judgeInitials } from "../names";
import type { JudgePhoto } from "../shared";

/**
 * A judge's official photograph (vision-checked, served from our media store) over their initials. The initials
 * monogram is always rendered, so a lazy-loading or failed photo never shows as a blank tile; the photo fades in once
 * it has loaded. `fill` sizes the avatar from its className (e.g. a grid card) instead of `size`.
 */
export function JudgeAvatar({ name, photo, size = 32, fill = false, className, rounded = "full" }: { name: string; photo?: JudgePhoto | null; size?: number; fill?: boolean; className?: string; rounded?: "full" | "md" }) {
  const [failed, setFailed] = React.useState(false);
  const [loaded, setLoaded] = React.useState(false);
  const imgRef = React.useRef<HTMLImageElement>(null);
  React.useEffect(() => {
    setFailed(false);
    // A cached image can finish before hydration attaches onLoad.
    const img = imgRef.current;
    setLoaded(Boolean(img && img.complete && img.naturalWidth > 0));
  }, [photo?.mediaId]);
  const shape = rounded === "full" ? "rounded-full" : "rounded-md";
  const style = fill ? undefined : { width: size, height: size };
  const showPhoto = Boolean(photo && !failed);
  return (
    <span
      className={cn("relative inline-flex shrink-0 select-none items-center justify-center overflow-hidden bg-muted font-medium text-muted-foreground ring-1 ring-border", shape, className)}
      style={{ ...style, fontSize: fill ? undefined : Math.max(9, Math.round(size * 0.36)) }}
      aria-hidden={showPhoto ? undefined : true}
    >
      <span aria-hidden className={cn("transition-opacity duration-200 motion-reduce:transition-none", showPhoto && loaded && "opacity-0")}>{judgeInitials(name)}</span>
      {photo && !failed ? (
        // eslint-disable-next-line @next/next/no-img-element -- served from our media store (content-addressed, cached)
        <img
          ref={imgRef}
          src={displayImageUrl(photo.url, fill ? 384 : 128)}
          srcSet={displayImageSrcSet(photo.url)}
          sizes={fill ? "(max-width: 640px) 50vw, 220px" : `${size}px`}
          alt={photo.alt ?? `Official photograph of ${name}`}
          className={cn("absolute inset-0 size-full object-cover object-top transition-opacity duration-300 motion-reduce:transition-none", loaded ? "opacity-100" : "opacity-0")}
          loading="lazy"
          decoding="async"
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
        />
      ) : null}
    </span>
  );
}
