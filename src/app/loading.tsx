import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="h-full space-y-4 overflow-hidden p-6" role="status" aria-label="Loading page" aria-busy="true">
      <Skeleton className="h-7 w-64" />
      <Skeleton className="h-4 w-full max-w-96" />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Skeleton className="h-40" /><Skeleton className="h-40" /><Skeleton className="h-40" />
      </div>
      <Skeleton className="h-64" />
    </div>
  );
}
