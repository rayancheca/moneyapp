import type { SeriesKind } from "@/db/schema/recurring";

/**
 * Whether a recurring series' money is his income or his spending — every kind's is, by its sign, except a
 * transfer's.
 *
 * ⚖️ A transfer series moves his money between his own accounts. The analytics law is authoritative (a transfer is
 * never income or spending), and counting both legs would double-book cash that never leaves the household. So no
 * NET counts one: not the forecast's lines (`fixedComponents`, `arrearsComponents`), not what a calendar mark adds to
 * its month (`flowEntryOf` — the strip, each day's figure, the footer), not the Upcoming tab's 30-day net, and no
 * series page ranks one among his commitments or his deposits (`recurringInsightInput`). The grid and the list still
 * DRAW it, because it is a real scheduled movement of his money; they just do not add it up.
 *
 * 🔴 This was the forecast's private test, `series.kind === "transfer"`, and the /recurring strip printed directly
 * under the forecast card's net summed every mark the grid draws. A one-legged transfer series — the card autopay
 * out of checking, with no PAYMENT THANK YOU leg imported to cancel it — moved "as scheduled", the calendar's footer
 * and the Upcoming tab's 30-day net by its whole amount while the card above them left it out. A pair on one day
 * hides it: on the e2e ledger after "Detect now", eight transfer series in four such pairs moved no total at all.
 *
 * Client-safe (no database), because `flowEntryOf` runs in the calendar's browser bundle.
 */
export function seriesIsIncomeOrSpending(kind: SeriesKind): boolean {
  return kind !== "transfer";
}
