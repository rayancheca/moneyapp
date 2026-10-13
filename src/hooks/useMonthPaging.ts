"use client";

import { useRef, useState } from "react";
import type { ActionResult } from "@/app/transactions/action-types";
import { toast } from "@/components/ui/Toast";
import { addMonths, monthsBetween } from "@/lib/calendar-math";
import { useAction } from "./useAction";

/**
 * A calendar's ‹ › paging — the one rule every calendar on `CalendarGrid` pages by: /recurring's calendar,
 * /investments' P/L calendar and /spending's heatmap, each loading its month through a server action.
 *
 * A press steps from the month last ASKED for, not the month on screen. 🔴 The grid steps from the month it draws, so
 * a press landing while the last one's month was still loading asked for that same month again and was lost: e2e's
 * 24 presses back from July 2026 stopped at May 2025, June 2025 or August 2024 (gate of 60d0d96, 2026-10-13, once each
 * month's read had grown by a few milliseconds). 5d156a4 fixed /recurring alone; the review of f978583 (2026-10-13)
 * found the P/L calendar and the heatmap still losing that press — on 2026-10, ‹ ‹ asked both for 2026-09 twice — and
 * the heatmap drawing whichever month answered last and calling itself idle when the first one did.
 *
 * Only the newest ask draws, calls `onLoaded`, and clears `pending` (`useAction`'s guard). A month that fails to load
 * is toasted and leaves the month on screen, and the next press steps from that month — not from the one that never
 * came, which is where 5d156a4's ‹ after a failure went (October on screen, ‹ asked for August). A month already
 * pressed past fails silently, as /recurring and the P/L calendar always had it: the newer ask speaks for both.
 */
export function useMonthPaging<M extends { monthKey: string }>(
  initial: M,
  load: (monthKey: string) => Promise<ActionResult<M>>,
  onLoaded?: (month: M) => void,
): { month: M; changeMonth: (stepTo: string) => void; pending: boolean } {
  const [month, setMonth] = useState(initial);
  // an object per ask, so "is this still the newest ask" is identity — two asks can name the same month
  const asked = useRef({ monthKey: initial.monthKey });
  const { run, pending } = useAction();

  function changeMonth(stepTo: string): void {
    // the grid hands over a step from the month it draws; the same step, taken from the month last asked for
    const ask = { monthKey: addMonths(asked.current.monthKey, monthsBetween(month.monthKey, stepTo)) };
    asked.current = ask;
    void run(() => load(ask.monthKey), {
      onSuccess: (data) => {
        setMonth(data);
        onLoaded?.(data);
      },
      onError: (message) => {
        // a month he has pressed past is moot, and its failure is not his to read — as both calendars had it
        if (asked.current !== ask) return;
        // nothing drew since this press (an older ask never draws), so the month on screen is still `month`
        asked.current = { monthKey: month.monthKey };
        toast({ title: message, tone: "negative" });
      },
    });
  }

  return { month, changeMonth, pending };
}
