import type { BudgetPeriodKind } from "@/db/schema/budgets";
import { monthLabel } from "./calendar-math";
import type { PeriodBounds } from "./dates";
import { formatDayShortIn } from "./format-date";

/**
 * What a rolling budget's panel says about the closed periods its carry is waiting on.
 *
 * ⚖️ OWNER DECISION 2026-10-13 (decision 67): a CLOSED period with any day not yet read banks nothing until its
 * statements land (`services/budgets::carryInto`, its `heldBack`). 🔴 On his ledger copy 2026-10-12 September banked
 * $761.52 that no statement confirmed, under a panel that had ended "…, so a missing statement cannot bank itself as
 * savings" (8f9f408) — false, and cut (review of 8f9f408) until this made it true.
 *
 * ⛔ The rule is said once (`ROLLOVER_WAITS`), by its own cause: it is the carry's hold, not the arrears' subtraction
 * (`lib/arrears-reading::ROLLOVER_SUBTRACTS`), that keeps a missing statement out of the carry.
 *
 * ⚠️ …and no further than it reaches. A period is read as its category page reads it (`categoryReachFor`): on the
 * accounts the category has lately been spent from, and `categoryCoverage`'s documented gap is that "a FIRST charge on
 * an account the category was never spent from in the window is not waited for". 🔴 The sentence ended flatly "…, so
 * a missing statement cannot bank itself as savings" — false of a statement missing on such an account, whose June
 * banks (review of 73a743d; pinned in `budgets.test.ts`). It names the accounts it waits on now.
 */
export const ROLLOVER_WAITS =
  "A period adds nothing until the accounts this category has lately been spent from are imported through its " +
  "last day, so a missing statement on one of them cannot bank itself as savings.";

const PERIOD_NOUN: Record<BudgetPeriodKind, string> = {
  daily: "days",
  weekly: "weeks",
  monthly: "months",
  annual: "years",
};

/** "September 2026", "the week of Sep 28", "Sep 30", "2025" — a day from outside `reference`'s year says its year */
function periodName(p: PeriodBounds, period: BudgetPeriodKind, reference: string): string {
  if (period === "monthly") return monthLabel(p.start.slice(0, 7));
  if (period === "annual") return p.start.slice(0, 4);
  const day = formatDayShortIn(p.start, reference);
  return period === "weekly" ? `the week of ${day}` : day;
}

/**
 * "September 2026 is not fully imported, so nothing rolls over from it yet." — null when nothing is held back. Several
 * are named both, or counted between the first and the last ("3 months, July 2026 to September 2026, …"; days and
 * weeks by their days, "4 days, Oct 10 – Oct 13, …"). `reference` is the graded window's first day.
 */
export function rolloverHeldBackSentence(
  heldBack: readonly PeriodBounds[],
  period: BudgetPeriodKind,
  reference: string,
): string | null {
  if (heldBack.length === 0) return null;
  const first = heldBack[0]!;
  const last = heldBack[heldBack.length - 1]!;
  const one = heldBack.length === 1;
  const named = (p: PeriodBounds): string => periodName(p, period, reference);
  const span =
    period === "monthly" || period === "annual"
      ? `${named(first)} to ${named(last)}`
      : `${formatDayShortIn(first.start, reference)} – ${formatDayShortIn(last.end, reference)}`;
  const subject = one
    ? named(first)
    : heldBack.length === 2
      ? `${named(first)} and ${named(last)}`
      : `${heldBack.length} ${PERIOD_NOUN[period]}, ${span},`;
  const sentence = one
    ? `${subject} is not fully imported, so nothing rolls over from it yet.`
    : `${subject} are not fully imported, so nothing rolls over from them yet.`;
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}
