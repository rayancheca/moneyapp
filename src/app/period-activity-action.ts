"use server";

import { getDb } from "@/db/client";
import { compareDates, isValidIsoDate } from "@/lib/dates";
import { periodActivity, type PeriodActivity } from "@/services/period-activity";

/**
 * Loads the linked activity panel for a brushed window (dashboard-dynamic §2).
 * The client calls this on every window change (brush / back / forward), so it
 * validates the boundary — a malformed or inverted range is a client bug, not a
 * crash — and caps the row list for a light payload.
 */

const PANEL_ROW_LIMIT = 8;

export async function loadPeriodActivity(from: string, to: string): Promise<PeriodActivity> {
  if (!isValidIsoDate(from) || !isValidIsoDate(to)) {
    throw new Error(`period activity: invalid window ${from}..${to}`);
  }
  // normalize an inverted window rather than returning an empty list
  const [lo, hi] = compareDates(from, to) <= 0 ? [from, to] : [to, from];
  return periodActivity(getDb(), lo, hi, PANEL_ROW_LIMIT);
}
