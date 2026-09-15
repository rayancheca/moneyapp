"use client";

import { useState, useTransition } from "react";
import { loadMonthForecastAction } from "@/app/recurring/actions";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { ViewSwitcher } from "@/components/ui/ViewSwitcher";
import { useViewState } from "@/hooks/useViewState";
import type { MonthForecast } from "@/services/forecast";
import type { RecurringCalendarMonth } from "@/services/recurring-calendar";
import { ForecastCard } from "./ForecastCard";
import { monthLabel } from "./labels";
import { RecurringCalendar } from "./RecurringCalendar";
import { RecurringTabs, type RecurringTab } from "./RecurringTabs";
import {
  CALENDAR_VIEW_LABELS,
  CALENDAR_VIEW_SPEC,
  RECURRING_CALENDAR_SURFACE,
} from "./recurring-view-spec";

interface ForecastAndCalendarProps {
  initialForecast: MonthForecast;
  initialMonth: RecurringCalendarMonth;
  today: string;
  /** resolved `?cal=` state from the server (URL > persisted > default) */
  view: Record<string, string>;
  /** the active tab, for the strip rendered between the card and the grid */
  tab: RecurringTab;
  /**
   * The per-tab badges. ⚠️ `calendar` is NOT read from here — it is the count
   * of the month the grid is SHOWING, which this component owns (see below).
   */
  counts: Record<RecurringTab, number>;
}

/**
 * The forecast card and the calendar, moving together.
 *
 * ⛔ They used to disagree in public. The card said "Forecast · August 2026"
 * while the grid underneath it showed October — two different months, stacked,
 * with nothing saying so. The owner reported it as a bug and it plainly is one:
 * a projection is *about* a month, and the only month on screen was the other
 * one.
 *
 * 🔴 AND THE TAB BADGE BETWEEN THEM DID NOT MOVE. The strip was rendered once on
 * the server with the CURRENT month's count and handed in as a finished node, so
 * nothing could update it. Measured on the real ledger 2026-09-15: September
 * holds 12 entries, October 14 — paged to October the page read "Forecast ·
 * October 2026" over "Calendar 12" over a 14-entry grid. The strip is rendered
 * here now, from the month that was loaded, the same way the card follows it.
 *
 * ## Why this component exists at all
 *
 * The card sits ABOVE the tab strip and the grid sits below it, so the two
 * cannot share state without something wrapping both. This is that something,
 * and it renders the tabs between them so the DOM order does not change:
 * card, tabs, grid, exactly as before.
 *
 * ## What a future month's forecast means, and what it cannot mean
 *
 * `forecastForMonth` answers a whole month end-to-end rather than "what is left
 * of today's". Its end-of-month cash is CHAINED through every intervening month
 * — see that function — because "what will I have at the end of October" is not
 * answerable from October alone.
 *
 * ⚠️ A PAST month returns null, and this renders a plain note instead of a card.
 * A month that has finished is not a forecast; the grid below it already shows
 * what actually posted, and dressing that up as a projection would be the app
 * claiming to predict something it can simply read.
 */
export function ForecastAndCalendar({
  initialForecast,
  initialMonth,
  today,
  view,
  tab,
  counts,
}: ForecastAndCalendarProps) {
  const [forecast, setForecast] = useState<MonthForecast | null>(initialForecast);
  const [shownMonth, setShownMonth] = useState(initialForecast.monthKey);
  // the badge counts the month ON SCREEN — the same month the card follows
  const [calendarCount, setCalendarCount] = useState(initialMonth.entryCount);
  const [, startTransition] = useTransition();

  const { state, setView } = useViewState({
    surface: RECURRING_CALENDAR_SURFACE,
    spec: CALENDAR_VIEW_SPEC,
    state: view,
    basePath: "/recurring",
    baseParams: { tab: "calendar" },
  });
  const density = state[CALENDAR_VIEW_SPEC[0]!.key] ?? "regular";

  function followMonth(month: RecurringCalendarMonth): void {
    setShownMonth(month.monthKey);
    setCalendarCount(month.entryCount);
    startTransition(async () => {
      const r = await loadMonthForecastAction({ monthKey: month.monthKey });
      // a failed load leaves the previous card standing rather than blanking it:
      // a stale-but-labelled projection beats an empty space with no reason
      if (r.ok) setForecast(r.data);
    });
  }

  return (
    <>
      {forecast ? (
        <ForecastCard forecast={forecast} />
      ) : (
        <SurfaceCard>
          <h2 className="text-sm font-medium">{monthLabel(`${shownMonth}-01`)} has ended</h2>
          <p className="mt-1 text-sm text-ink-muted">
            There is nothing to project — the calendar below shows what actually posted.
          </p>
        </SurfaceCard>
      )}

      <div className="space-y-4">
        <RecurringTabs tab={tab} counts={{ ...counts, calendar: calendarCount }} />
        <div className="flex items-center justify-end">
          <ViewSwitcher
            dimension={CALENDAR_VIEW_SPEC[0]!}
            value={density}
            onSelect={(v) => setView(CALENDAR_VIEW_SPEC[0]!.key, v)}
            labels={CALENDAR_VIEW_LABELS}
            ariaLabel="Calendar row height"
          />
        </div>
        <RecurringCalendar
          initialMonth={initialMonth}
          today={today}
          density={density}
          onMonthLoaded={followMonth}
        />
      </div>
    </>
  );
}
