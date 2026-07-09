import type { Metadata } from "next";
import { getDb } from "@/db/client";
import { todayIso } from "@/lib/dates";
import { forecastCurrentMonth } from "@/services/forecast";
import { listSeries, upcomingOccurrences } from "@/services/recurring";
import { ForecastCard } from "@/components/recurring/ForecastCard";
import { SeriesTable } from "@/components/recurring/SeriesTable";
import { UpcomingList } from "@/components/recurring/UpcomingList";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { detectNowAction } from "./actions";

export const metadata: Metadata = { title: "Recurring" };
export const dynamic = "force-dynamic";

export default function RecurringPage() {
  const db = getDb();
  const today = todayIso();
  const series = listSeries(db);
  const upcoming = upcomingOccurrences(db, today, 30);
  const forecast = forecastCurrentMonth(db, today);

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <PageHeader
          title="Recurring & forecast"
          description="Detected subscriptions, bills, and salary with next expected dates — feeding an inspectable end-of-month forecast."
        />
        <form action={detectNowAction}>
          <button
            type="submit"
            className="rounded-md border border-line bg-surface-raised px-3 py-1.5 text-sm font-medium text-accent transition-colors duration-(--duration-fast) hover:border-accent hover:bg-accent-soft"
          >
            Detect now
          </button>
        </form>
      </div>

      <div className="space-y-6">
        <ForecastCard forecast={forecast} />

        {series.length === 0 ? (
          <EmptyState
            title="Nothing detected yet"
            description="Detection needs transaction history: stable cadence plus stable amount, at least three occurrences. Run “Detect now” after importing or categorizing."
            phase="Phase 6 · Recurring + Forecasting"
          />
        ) : (
          <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <section aria-label="Recurring series">
              <h2 className="mb-2 text-xs font-medium uppercase tracking-[0.12em] text-ink-faint">
                Series
              </h2>
              <SeriesTable series={series} />
            </section>
            <section aria-label="Upcoming occurrences">
              <h2 className="mb-2 text-xs font-medium uppercase tracking-[0.12em] text-ink-faint">
                Calendar
              </h2>
              <UpcomingList occurrences={upcoming} />
            </section>
          </div>
        )}
      </div>
    </>
  );
}
