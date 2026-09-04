import type { Metadata } from "next";
import { z } from "zod";
import { getDb } from "@/db/client";
import { addDays, monthKey, periodBounds, todayIso } from "@/lib/dates";
import { overdueForSeries } from "@/services/arrears";
import { forecastCurrentMonth } from "@/services/forecast";
import { listSeries, upcomingOccurrences } from "@/services/recurring";
import { readSettings } from "@/services/settings";
import { resolveViewState } from "@/lib/view-state";
import { recurringCalendar } from "@/services/recurring-calendar";
import { AllSeriesView } from "@/components/recurring/AllSeriesView";
import { ForecastCard } from "@/components/recurring/ForecastCard";
import { ForecastAndCalendar } from "@/components/recurring/ForecastAndCalendar";
import {
  CALENDAR_VIEW_SPEC,
  RECURRING_CALENDAR_SURFACE,
} from "@/components/recurring/recurring-view-spec";
import { RecurringTabs, type RecurringTab } from "@/components/recurring/RecurringTabs";
import { UpcomingList } from "@/components/recurring/UpcomingList";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { ErrorBanner, errorParam } from "@/components/ui/ErrorBanner";
import { detectNowAction } from "./actions";

export const metadata: Metadata = { title: "Recurring" };
export const dynamic = "force-dynamic";

/** the first value of a repeated query param — Next gives arrays for `?a=1&a=2` */
function firstParam(value: string | string[] | undefined): string | null {
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

const searchSchema = z.object({ tab: z.enum(["upcoming", "all", "calendar"]).catch("upcoming") });

export default async function RecurringPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const { tab } = searchSchema.parse({ tab: raw.tab }) as { tab: RecurringTab };
  // detectNow / confirmSeries / dismissSeries are `Promise<void>` form actions,
  // so their failures travel back as ?error= (actions.ts:97,127,139) — the
  // /budgets pattern. Unread, a confirm refused because its restore point could
  // not be written was indistinguishable from one that quietly did nothing.
  const error = errorParam(raw);

  const db = getDb();
  const today = todayIso();
  const calendarView = resolveViewState(
    CALENDAR_VIEW_SPEC,
    { cal: firstParam(raw.cal) ?? undefined },
    readSettings(db).viewPreferences[RECURRING_CALENDAR_SURFACE],
  );
  const series = listSeries(db, today);
  const upcoming = upcomingOccurrences(db, today, 30);
  const forecast = forecastCurrentMonth(db, today);
  const calendarMonth = recurringCalendar(db, monthKey(today), today);

  /*
   * ⛔ Same call the forecast above the tabs makes, and the same one the bill's
   * own page makes: the calendar month, closing the day before today, so a bill
   * due TODAY is due rather than late. Without it the "Next" column walked
   * forward past a charge the math table on this very screen named as "came due
   * 2026-09-01 and has not posted".
   */
  const liveIds = new Set(
    series.filter((s) => s.status === "detected" || s.status === "confirmed").map((s) => s.id),
  );
  const overdueBySeries = new Map(
    overdueForSeries(db, liveIds, periodBounds(today, "monthly").start, addDays(today, -1)).series.map(
      (o) => [o.id, { date: o.nextDate, occurrenceCount: o.occurrenceCount }] as const,
    ),
  );

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

      {error && <ErrorBanner message={error} />}

      <div className="space-y-6">
        {/*
          ⛔ The calendar tab renders its OWN forecast card, because on that tab
          the card follows the month the grid is showing — and the card sits
          above the tab strip, so the two cannot share state without something
          wrapping both. The tabs are passed through as a prop precisely so the
          DOM order is unchanged: card, tabs, content, on every tab.
        */}
        {!hasSeries ? (
          <>
            <ForecastCard forecast={forecast} />
            <EmptyState
              title="Nothing detected yet"
              description="Detection needs transaction history: stable cadence plus stable amount, at least three occurrences. Run “Detect now” after importing or categorizing."
            />
          </>
        ) : tab === "calendar" ? (
          <ForecastAndCalendar
            initialForecast={forecast}
            initialMonth={calendarMonth}
            today={today}
            view={calendarView}
            tabs={<RecurringTabs tab={tab} counts={counts} />}
          />
        ) : (
          <>
            <ForecastCard forecast={forecast} />
            <div className="space-y-4">
              <RecurringTabs tab={tab} counts={counts} />
              {tab === "upcoming" ? (
                <UpcomingList occurrences={upcoming} />
              ) : (
                <AllSeriesView series={series} overdueBySeries={overdueBySeries} />
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
}
