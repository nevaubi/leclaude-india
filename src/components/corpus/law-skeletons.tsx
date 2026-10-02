import { Skeleton } from "@/components/ui/skeleton";

/** Route-level loading shapes for the Law start pages (match the galleries, so nothing jumps when data arrives). */
export function LawPageSkeleton({ variant }: { variant: "gallery" | "tiles" | "people" }) {
  return (
    <div className="h-full overflow-hidden" aria-busy>
      <div className="mx-auto w-full max-w-[1180px] space-y-5 px-4 pt-5 sm:px-6">
        <Skeleton className="h-4 w-40" />
        {variant === "gallery" ? (
          <>
            <Skeleton className="h-[236px] w-full rounded-xl" />
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="aspect-[4/3] rounded-lg" />)}</div>
          </>
        ) : variant === "tiles" ? (
          <>
            <div className="grid gap-3 sm:grid-cols-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-[112px] rounded-xl" />)}</div>
            <div className="grid gap-3 md:grid-cols-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-[176px] rounded-xl" />)}</div>
          </>
        ) : (
          <>
            <Skeleton className="h-[76px] w-full rounded-lg" />
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="aspect-[4/5] w-full rounded-lg" />)}</div>
          </>
        )}
      </div>
    </div>
  );
}
