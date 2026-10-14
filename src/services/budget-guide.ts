import type { AppDatabase } from "@/db/client";
import type { BudgetPeriodKind } from "@/db/schema/budgets";
import { guideWindowWords } from "@/lib/committed";
import { diffDays, periodBounds, todayIso } from "@/lib/dates";
import { spendingTransactions } from "./analytics";
import { isUpfrontCarRow, readUpfrontCarRule } from "./car-upfront";
import { baselineWindow, type BaselineWindow } from "./committed";

/*
 * The budget editor's spend guide, in a module of its own: it reads the dashboard's window (`committed.ts`), and
 * `committed.ts` reads `budgets.ts` — so the guide cannot live in `budgets.ts` without the two importing each other.
 */

/** What the inline budget editor prints under the amount: "6-mo avg ≈ $X", one tap to adopt. */
export interface BudgetGuide {
  /** the guide at the budget period's length — never zero (a guide of nothing is no guide, and is not printed) */
  cents: number;
  /** "6-mo avg" — the window's own month count (`guideWindowWords`) */
  lead: string;
  /** the months the guide averaged and why the later ones are left out — null when the frontier cut none */
  note: string | null;
}

/**
 * A trailing spend guide for the inline editor (ux-overhaul §8): the subtree's spend over the dashboard's window
 * (`baselineWindow`) expressed at the budget PERIOD's length via a daily rate, so the figure is directly comparable to
 * a daily/weekly/monthly/annual amount alike. Net refunds never push it below zero. This is what kills
 * deactivate-and-recreate — the user adjusts a live number against real history.
 *
 * ⚖️ His decision 71 (2026-10-13, asked as an either/or, the recommended option): an AVERAGE uses only months EVERY
 * account he spends from has been read through to the END of — and this one is the runway's and Eating out's kind, a
 * category's months averaged. 🔴 Review of cf8f8dc, measured on his ledger copy that day: the guide still averaged the
 * calendar's six months back from today (Apr–Sep, `trailingFullMonths`) while Chase Checking was read only through
 * Aug 12 — Food $1,517.03 where the fully read Feb–Jul make it $2,216.50, below the dashboard's own Eating out ($1,963.24
 * a month over Feb–Jul), which is part of Food; Housing $2,762.43 vs $2,161.72; Car $347.71 vs nothing — while the
 * same /budgets rows printed "Spent — · Left —" for the days nobody had read (decision 64). ONE WINDOW, ONE PLACE: the
 * guide takes `baselineWindow`'s, floor included — a month before the ledger opens is not a month of nothing spent,
 * and the calendar's six used to divide by it as if it were.
 */
export function budgetGuidanceCents(
  db: AppDatabase,
  categoryId: string,
  period: BudgetPeriodKind,
  refDate: string = todayIso(),
  window: BaselineWindow = baselineWindow(db, refDate),
): number {
  // ⛔ a window of no month is no measurement: no guide, rather than a figure divided by nothing
  if (window.keys.length === 0) return 0;
  /*
   * ⚖️ The car's up-front money is no guide to a month (owner decision 2026-10-07, §6A 51). 🔴 On his ledger the Car
   * guide read $1,093.91 a month, most of it the $6,100 down payment and deposit ÷ 6 — a budget set from it would
   * plan for a down payment every month. The rows `categorySpending` sums, less the card's own up-front set.
   */
  const upfront = readUpfrontCarRule(db);
  // the window's months are contiguous, so its days are one span: `from` to `to`
  const totalSpent = spendingTransactions(db, { categoryId, from: window.from, to: window.to })
    .filter((t) => !isUpfrontCarRow(upfront, t))
    .reduce((sum, t) => sum - t.amountCents, 0);
  const totalDays = diffDays(window.from, window.to) + 1;
  const bounds = periodBounds(refDate, period);
  const periodDays = diffDays(bounds.start, bounds.end) + 1;
  return Math.max(0, Math.round((totalSpent / totalDays) * periodDays));
}

/**
 * One guide per budget, for /budgets' inline editors — null where there is none to print: no month to average, or
 * nothing spent over it. The window is taken ONCE, and the figure and the words that name it read the same one.
 */
export function budgetGuides(
  db: AppDatabase,
  budgets: readonly { id: string; categoryId: string; period: BudgetPeriodKind }[],
  refDate: string = todayIso(),
): Map<string, BudgetGuide | null> {
  const window = baselineWindow(db, refDate);
  const words = guideWindowWords(window);
  return new Map(
    budgets.map((b) => {
      const cents = words === null ? 0 : budgetGuidanceCents(db, b.categoryId, b.period, refDate, window);
      return [b.id, words !== null && cents > 0 ? { cents, ...words } : null];
    }),
  );
}
