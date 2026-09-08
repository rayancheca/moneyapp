import type { AppDatabase } from "@/db/client";
import { addCalendarMonths, diffDays, monthKey, periodBounds, todayIso } from "@/lib/dates";
import { activeTxnsInRange, loadCategoryIndex, type AnalyticsTxn, type CategoryIndex } from "./analytics";
import { baselineWindow, SPEND_BASELINE_MONTHS } from "./committed";

/**
 * What eating out actually costs — the dashboard's biggest real spend, and the
 * one the top-level totals hide.
 *
 * `Food` as a single row says $2,177 a month and stops. Underneath it, measured
 * over 2026-02 → 2026-07, are two populations that behave nothing alike: 399
 * restaurant visits and 82 delivery orders at ~$24 a ticket, against 133
 * grocery trips at $8.74. Rolling them together turns the most actionable
 * number on the dashboard into an average of two unrelated habits.
 *
 * ## Why the window is the runway's window
 *
 * `SPEND_BASELINE_MONTHS` is imported rather than re-picked, for the same
 * reason `MIN_OCCURRENCES` is imported in `provenance`: the runway card already
 * publishes "averaged over 6 complete months" on the same screen, and two cards
 * quoting different windows for the same ledger is a contradiction the reader
 * has to resolve. The current month is excluded rather than prorated — a
 * partial month understates the rate by however much of it is left.
 *
 * ## ⛔ Refunds NET, they are not filtered
 *
 * The obvious query is `WHERE amount_cents < 0`. It is wrong, and the ledger
 * has already been bitten by exactly this: pass 66 found twelve inflows sitting
 * in expense categories acting as silent negative expenses, and spending was
 * understated $487.50 until they were netted. A returned meal is not a meal
 * that never happened AND a refund that never happened — it is one event with
 * two legs, and the two legs belong in the same bucket where they cancel.
 *
 * `activeTxnsInRange` is reused rather than re-queried so SPLITS expand the
 * same way they do everywhere else: half a $60 check filed under Dining and
 * half under Groceries must land in both, not twice in one.
 */

/** The `Food` children that mean "someone else cooked it". */
const EATING_OUT_CHILDREN = ["Dining", "Delivery", "Coffee"] as const;
/** …and the one that means "you did". */
const HOME_CHILD = "Groceries";

export interface EatingOutLine {
  /** the child category's own name, e.g. "Dining" */
  name: string;
  /**
   * What ONE purchase from this line is called, e.g. "visit" — the SINGULAR.
   *
   * 🔴 It held the plural, and the card printed `{count} {unit}` against it, so
   * a window holding one coffee read "1 coffees" — and "1 visits", "1 orders",
   * "1 trips" and "1 purchases" beside it. The same defect as the 115
   * "1 transactions" fixed on 2026-09-08, in the one card that had five copies
   * of it. `countPhrase` does the pluralising now, from `blast-radius`, where
   * `/imports`, `/merchants` and `/accounts` already read it.
   */
  unit: string;
  /** positive = money out, refunds already netted */
  spentCents: number;
  count: number;
  /** null when nothing was bought — an average over zero purchases is not zero */
  averageTicketCents: number | null;
}

export interface EatingOutCard {
  /** mean monthly spend on food someone else made */
  monthlyCents: number;
  /** mean monthly spend on groceries */
  groceriesMonthlyCents: number;
  /**
   * How many times over the groceries figure the eating-out figure is.
   *
   * ⛔ Null when groceries are zero. `x / 0` is `Infinity` and would render as
   * "Infinity× what you spend on groceries"; a ledger with no grocery rows has
   * no ratio to publish, and the card says something else instead.
   */
  multipleOfGroceries: number | null;
  eatingOut: EatingOutLine[];
  groceries: EatingOutLine;
  /** every eating-out line summed */
  totalSpentCents: number;
  totalCount: number;
  /** across eating-out lines only — groceries have their own, much smaller, one */
  averageTicketCents: number | null;
  /** purchases per day, for the "how often" sentence */
  purchasesPerDay: number;
  months: number;
  fromMonth: string;
  toMonth: string;
  /** true when nothing at all was spent in the window — the card renders empty */
  isEmpty: boolean;
}

function lineOf(name: string, unit: string, txns: readonly AnalyticsTxn[]): EatingOutLine {
  // ⛔ netting, not filtering — see the header note
  const spentCents = txns.reduce((sum, t) => sum - t.amountCents, 0);
  // a refund is not a purchase, so it nets the money without counting a visit
  const count = txns.filter((t) => t.amountCents < 0).length;
  return {
    name,
    unit,
    spentCents,
    count,
    averageTicketCents: count === 0 ? null : Math.round(spentCents / count),
  };
}

/**
 * What one purchase from each child is called, in the card's own voice.
 *
 * ⛔ Singular. `countPhrase` appends the "s", and every one of these pluralises
 * regularly — the card must never hand a reader "1 coffees".
 */
const UNITS: Record<string, string> = {
  Dining: "visit",
  Delivery: "order",
  Coffee: "coffee",
  Groceries: "trip",
};

export function eatingOutCard(
  db: AppDatabase,
  today: string = todayIso(),
  months: number = SPEND_BASELINE_MONTHS,
): EatingOutCard | null {
  const idx: CategoryIndex = loadCategoryIndex(db);
  const food = [...idx.byId.values()].find((c) => c.parentId === null && c.name === "Food");
  // a ledger with no Food taxonomy has nothing to say here, and a card of
  // zeroes is worse than no card (the rule carCard already follows)
  if (!food) return null;

  const childByName = new Map(
    [...idx.byId.values()].filter((c) => c.parentId === food.id).map((c) => [c.name, c.id] as const),
  );

  /*
   * ⛔ ONE WINDOW, ONE PLACE — `baselineWindow` floors this at the first month
   * the ledger covers in full. Building it here from the constant alone let a
   * young ledger put two different windows in two captions on one dashboard.
   */
  const window = baselineWindow(db, today, months);
  const { fromMonth, toMonth, from } = window;
  // the month's real last day — `${toMonth}-31` worked as a string upper bound
  // but is not a date, and the day count below has to be able to trust it
  const to = periodBounds(`${toMonth}-01`, "monthly").end;

  const txns = activeTxnsInRange(db, from, to);
  const inChild = (childId: string | undefined): AnalyticsTxn[] =>
    childId === undefined ? [] : txns.filter((t) => t.categoryId === childId);

  const eatingOut = EATING_OUT_CHILDREN.map((name) => lineOf(name, UNITS[name] ?? "purchases", inChild(childByName.get(name))))
    // a child with nothing in it is not a row — it is an absence, and printing
    // "Coffee 0 coffees $0.00" spends a line saying nothing happened
    .filter((l) => l.count > 0 || l.spentCents !== 0)
    .sort((a, b) => b.spentCents - a.spentCents);

  const groceries = lineOf(HOME_CHILD, UNITS[HOME_CHILD]!, inChild(childByName.get(HOME_CHILD)));

  const totalSpentCents = eatingOut.reduce((s, l) => s + l.spentCents, 0);
  const totalCount = eatingOut.reduce((s, l) => s + l.count, 0);
  const monthlyCents = Math.round(totalSpentCents / months);
  const groceriesMonthlyCents = Math.round(groceries.spentCents / months);

  /*
   * Days in the window the sentence NAMES — calendar days, not transaction days,
   * counted inclusively over exactly [from, to].
   *
   * 🔴 This was `diffDays(fromMonth-01, toMonth-28) + 3`, i.e. the diff to a
   * notional "toMonth-31". The error is exactly `30 − daysInMonth(toMonth)`:
   * one day long when the window ends in a 31-day month, one short in a 30-day
   * one, two or three short in February. Measured on the real ledger at
   * today = 2026-03-10 the card printed "1.9 purchases a day. Averaged over 6
   * complete months, 2025-09 to 2026-02" — those six months are 181 days, it
   * divided 353 by 183, and 353/181 rounds to 2.0. The figure and the window
   * printed beside it in one sentence disagreed by a whole tenth.
   */
  const windowDays = Math.max(1, diffDays(from, to) + 1);

  return {
    monthlyCents,
    groceriesMonthlyCents,
    multipleOfGroceries: groceries.spentCents > 0 ? totalSpentCents / groceries.spentCents : null,
    eatingOut,
    groceries,
    totalSpentCents,
    totalCount,
    averageTicketCents: totalCount === 0 ? null : Math.round(totalSpentCents / totalCount),
    purchasesPerDay: totalCount / windowDays,
    // the window's OWN month count, which the ledger may have shortened
    months: window.months,
    fromMonth,
    toMonth,
    isEmpty: totalCount === 0 || groceries.count === 0,
  };
}
