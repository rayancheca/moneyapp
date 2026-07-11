import type { Metadata } from "next";
import { z } from "zod";
import { getDb } from "@/db/client";
import { monthKey, todayIso } from "@/lib/dates";
import { forecastCurrentMonth } from "@/services/forecast";
import { listSeries, upcomingOccurrences } from "@/services/recurring";
import { recurringCalendar } from "@/services/recurring-calendar";
import { AllSeriesView } from "@/components/recurring/AllSeriesView";
import { ForecastCard } from "@/components/recurring/ForecastCard";
import { RecurringCalendar } from "@/components/recurring/RecurringCalendar";
import { RecurringTabs, type RecurringTab } from "@/components/recurring/RecurringTabs";
import { UpcomingList } from "@/components/recurring/UpcomingList";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { detectNowAction } from "./actions";

export const metadata: Metadata = { title: "Recurring" };
export const dynamic = "force-dynamic";

const searchSchema = z.object({ tab: z.enum(["upcoming", "all", "calendar"]).catch("upcoming") });

export default async function RecurringPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const { tab } = searchSchema.parse({ tab: raw.tab }) as { tab: RecurringTab };

  const db = getDb();
  const today = todayIso();
  const series = listSeries(db, today);
  const upcoming = upcomingOccurrences(db, today, 30);
  const forecast = forecastCurrentMonth(db, today);
  const calendarMonth = recurringCalendar(db, monthKey(today), today);

  const counts: Record<RecurringTab, number> = {
    upcoming: upcoming.length,
    all: series.filter((s) => s.status !== "dismissed" && s.status !== "ended").length,
    calendar: calendarMonth.entryCount,
  };
  const hasSeries = series.length > 0;

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

        {!hasSeries ? (
          <EmptyState
            title="Nothing detected yet"
            description="Detection needs transaction history: stable cadence plus stable amount, at least three occurrences. Run “Detect now” after importing or categorizing."
          />
        ) : (
          <div className="space-y-4">
            <RecurringTabs tab={tab} counts={counts} />
            {tab === "upcoming" ? (
              <UpcomingList occurrences={upcoming} />
            ) : tab === "all" ? (
              <AllSeriesView series={series} />
            ) : (
              <RecurringCalendar initialMonth={calendarMonth} today={today} />
            )}
          </div>
        )}
      </div>
    </>
  );
}
