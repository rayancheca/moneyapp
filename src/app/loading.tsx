import { Skeleton } from "@/components/ui/Skeleton";
import { SurfaceCard } from "@/components/ui/SurfaceCard";

/**
 * Root Suspense fallback for every route. Every page is force-dynamic and reads
 * SQLite on the server, so without this a navigation just sits on the old page.
 * Deliberately the shape of a page — header, a stat row, a chart, a ledger —
 * rather than a spinner, so the layout doesn't jump when the real data lands.
 */
const STAT_KEYS = ["a", "b", "c"];
const ROW_KEYS = ["r1", "r2", "r3", "r4", "r5"];

export default function Loading() {
  return (
    <div role="status" aria-label="Loading" aria-busy="true">
      <header className="mb-8">
        <Skeleton className="h-7 w-52 max-w-full" />
        <Skeleton className="mt-2.5 h-3.5 w-80 max-w-full" />
      </header>

      <div className="grid gap-4 sm:grid-cols-3">
        {STAT_KEYS.map((key) => (
          <SurfaceCard key={key}>
            <Skeleton className="h-3 w-24" />
            <Skeleton className="mt-3 h-6 w-32 max-w-full" />
            <Skeleton className="mt-2 h-3 w-20" />
          </SurfaceCard>
        ))}
      </div>

      <SurfaceCard className="mt-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Skeleton className="h-3.5 w-36" />
          <Skeleton className="h-6 w-40 max-w-full" />
        </div>
        <Skeleton className="mt-5 h-48 w-full sm:h-56" />
      </SurfaceCard>

      <SurfaceCard className="mt-4">
        <Skeleton className="h-3.5 w-32" />
        <div className="mt-4 grid gap-3">
          {ROW_KEYS.map((key) => (
            /* amount column is fixed-width so the rows read as a ledger, not a
               stack of bars; it holds its width down to 440px */
            <div key={key} className="flex items-center gap-3 border-t border-line pt-3 first:border-0 first:pt-0">
              <Skeleton className="size-7 shrink-0 rounded-full" />
              <div className="min-w-0 flex-1">
                <Skeleton className="h-3.5 w-full max-w-48" />
                <Skeleton className="mt-1.5 h-3 w-24" />
              </div>
              <Skeleton className="h-3.5 w-16 shrink-0" />
            </div>
          ))}
        </div>
      </SurfaceCard>
    </div>
  );
}
