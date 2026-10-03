"use client";
import * as React from "react";
import { cn } from "@/lib/utils";
import { Tip } from "@/components/ui/tooltip";
import { publisherMonogram } from "../images";
import { newsSourceById } from "../sources";
import type { NewsListItem } from "../types";
import { LabelList, TimeAgo } from "./news-ui";

/**
 * Headline image in a fixed aspect box. Remote images are rendered with a plain <img> (next.config has no
 * remotePatterns for publisher CDNs): lazy, async decode, no referrer. When there is no approved image, or it fails to
 * load, the box shows the publisher's monogram tile instead, so layouts never jump or show a broken image.
 */
export function NewsThumb({ item, className, ratio = "3/2", eager, monogramSize = "sm" }: { item: NewsListItem; className?: string; ratio?: "16/9" | "3/2" | "4/3" | "1/1"; eager?: boolean; monogramSize?: "sm" | "md" | "lg" }) {
  const [failed, setFailed] = React.useState(false);
  const ref = React.useRef<HTMLImageElement>(null);
  const img = item.image && !failed ? item.image : null;
  React.useEffect(() => {
    setFailed(false);
    // An image that failed before hydration never fires onError for React; detect it on mount.
    const el = ref.current;
    if (el && el.complete && el.naturalWidth === 0) setFailed(true);
  }, [item.image?.url]);
  const aspect = { "16/9": "aspect-[16/9]", "3/2": "aspect-[3/2]", "4/3": "aspect-[4/3]", "1/1": "aspect-square" }[ratio];
  return (
    <div className={cn("relative shrink-0 overflow-hidden rounded-[5px] bg-muted ring-1 ring-inset ring-border/60", aspect, className)}>
      {img ? (
        // eslint-disable-next-line @next/next/no-img-element -- publisher CDNs are not in next.config remotePatterns; see the component note.
        <img
          ref={ref}
          src={img.url}
          alt={img.alt}
          width={img.width ?? undefined}
          height={img.height ?? undefined}
          loading={eager ? "eager" : "lazy"}
          fetchPriority={eager ? "high" : "auto"}
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
          className="absolute inset-0 size-full object-cover"
        />
      ) : (
        <Monogram publisher={item.publisher} size={monogramSize} />
      )}
    </div>
  );
}

function Monogram({ publisher, size }: { publisher: string; size: "sm" | "md" | "lg" }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-muted text-muted-foreground" aria-hidden>
      <span className={cn("font-serif font-semibold tracking-wide text-foreground/45", size === "lg" ? "text-4xl" : size === "md" ? "text-2xl" : "text-[15px]")}>{publisherMonogram(publisher)}</span>
      {size !== "sm" && <span className="text-[10.5px] uppercase tracking-[0.12em] text-muted-foreground/80">{shortPublisher(publisher)}</span>}
    </div>
  );
}

/** Publisher · relative time (first-seen when the feed gave no date), with syndication on hover. */
export function NewsMeta({ item, now, className }: { item: NewsListItem; now: Date | null; className?: string }) {
  const syndicated = item.syndicatedBy.map((s) => newsSourceById(s.sourceId)?.publisher ?? s.sourceId);
  return (
    <div className={cn("flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground", className)}>
      <span className="truncate font-medium text-foreground/80" title={item.publisher}>{shortPublisher(item.publisher)}</span>
      <span aria-hidden>·</span>
      {item.publishedAt
        ? <TimeAgo iso={item.publishedAt} now={now} />
        : <Tip label="The publisher gave no publish date; shown by when it first appeared."><span className="whitespace-nowrap"><TimeAgo iso={item.firstSeenAt} now={now} prefix="first seen" /></span></Tip>}
      {syndicated.length > 0 && <Tip label={`Also carried by ${syndicated.join(", ")}`}><span className="hidden truncate @md:inline">· also {syndicated[0]}{syndicated.length > 1 ? ` +${syndicated.length - 1}` : ""}</span></Tip>}
    </div>
  );
}

const shortPublisher = (p: string) => p.replace(/\s*\(.*\)$/, "");

function HeadlineLink({ item, className }: { item: NewsListItem; className?: string }) {
  return (
    <a href={item.url} target="_blank" rel="noopener noreferrer" title={item.title} className={cn("decoration-foreground/30 underline-offset-[3px] hover:underline focus-visible:underline focus-visible:outline-none", className)}>
      {item.title}<span className="sr-only"> (opens {item.publisher} in a new tab)</span>
    </a>
  );
}

/** The lead story: large image, serif headline, the publisher's summary, labels. */
export function LeadStory({ item, now }: { item: NewsListItem; now: Date | null }) {
  return (
    <article className="group min-w-0">
      <a href={item.url} target="_blank" rel="noopener noreferrer" tabIndex={-1} aria-hidden className="block">
        <NewsThumb item={item} ratio="16/9" eager monogramSize="lg" className="w-full transition-opacity group-hover:opacity-95" />
      </a>
      <NewsMeta item={item} now={now} className="mt-3" />
      <h2 className="mt-1 font-serif text-[22px] font-semibold leading-[1.22] tracking-[-0.005em] text-foreground @4xl:text-[24px]">
        <HeadlineLink item={item} />
      </h2>
      {item.summary && <p className="mt-2 line-clamp-3 text-[13px] leading-relaxed text-muted-foreground">{item.summary}</p>}
      <LabelList labels={item.labels} maxTopics={3} className="mt-2" />
    </article>
  );
}

/** Secondary top story: thumbnail on the right, compact serif headline. */
export function SideStory({ item, now }: { item: NewsListItem; now: Date | null }) {
  return (
    <article className="group flex min-w-0 gap-3 py-3 first:pt-0 last:pb-0">
      <div className="min-w-0 flex-1">
        <NewsMeta item={item} now={now} />
        <h3 className="mt-1 line-clamp-4 font-serif text-[14.5px] font-semibold leading-snug text-foreground"><HeadlineLink item={item} /></h3>
        <LabelList labels={item.labels} maxTopics={1} className="mt-1.5" />
      </div>
      {/* No image: the headline takes the full width instead of sitting beside an empty tile. */}
      {item.image ? (
        <a href={item.url} target="_blank" rel="noopener noreferrer" tabIndex={-1} aria-hidden className="block w-[96px] shrink-0">
          <NewsThumb item={item} ratio="4/3" className="w-full" />
        </a>
      ) : null}
    </article>
  );
}

/** Grid card: image on top, headline, meta. */
export function StoryCard({ item, now }: { item: NewsListItem; now: Date | null }) {
  return (
    <article className="group flex min-w-0 flex-col">
      <a href={item.url} target="_blank" rel="noopener noreferrer" tabIndex={-1} aria-hidden className="block">
        <NewsThumb item={item} ratio="3/2" monogramSize="md" className="w-full" />
      </a>
      <NewsMeta item={item} now={now} className="mt-2" />
      <h3 className="mt-1 line-clamp-3 font-serif text-[14.5px] font-semibold leading-snug text-foreground"><HeadlineLink item={item} /></h3>
      <LabelList labels={item.labels} maxTopics={1} className="mt-1.5" />
    </article>
  );
}

/** List row for the chronological feed: text left, small thumbnail right. */
export function StoryRow({ item, now, summary = true, thumb = true, dense }: { item: NewsListItem; now: Date | null; summary?: boolean; thumb?: boolean; dense?: boolean }) {
  return (
    <li className={cn("group flex min-w-0 gap-3 px-3 transition-colors hover:bg-accent/40", dense ? "py-2" : "py-3")}>
      <div className="min-w-0 flex-1">
        <NewsMeta item={item} now={now} />
        <h3 className={cn("mt-0.5 font-medium leading-snug text-foreground", dense ? "line-clamp-2 text-[12.5px]" : "text-[13.5px]")}><HeadlineLink item={item} /></h3>
        {summary && item.summary && <p className="mt-0.5 line-clamp-2 text-[12px] leading-relaxed text-muted-foreground">{item.summary}</p>}
        <LabelList labels={item.labels} maxTopics={dense ? 1 : 3} className="mt-1" />
      </div>
      {thumb && item.image && (
        <a href={item.url} target="_blank" rel="noopener noreferrer" tabIndex={-1} aria-hidden className={cn("block shrink-0", dense ? "w-[72px]" : "hidden w-[120px] @md:block")}>
          <NewsThumb item={item} ratio="3/2" className="w-full" />
        </a>
      )}
    </li>
  );
}
