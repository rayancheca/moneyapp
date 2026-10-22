import { Money } from "@/components/ui/Money";
import { noIncomeDayCheckedNote } from "@/lib/unbanked-income";

interface IncomeSoFarProps {
  /** not one day of the month checked where the pay lands, and nothing posted (`IncomeExpectation.noIncomeDayRead`) */
  noIncomeDayRead: boolean;
  postedCents: number;
  expectedCents: number;
  /** the pay series the expected money comes from, named after it — null when none */
  from: string | null;
}

/**
 * /budgets' header after "left to allocate ·": "$X in so far, $Y still expected from <pay>".
 *
 * ⚖️ §6A 68 (2026-10-13): an em dash, not a $0.00, while not one day of the month has been checked where the pay lands
 * — the frontier the passed paydays' line below names. 🔴 His ledger copy 2026-10-12 read "$0.00 in so far, $3,425.76
 * still expected" over an October nothing had read. Why there is no figure is a line of its own under it
 * (`IncomeSoFarNote`).
 *
 * ⛔ One text for every reader — no spoken stand-in beside the dash. 🔴 The stand-in sat between the dash and the
 * figures in the page's text (`scripts/read-surface.mjs`, a copy, a find): his ledger copy 2026-10-21 read "$33.76 left
 * to allocate · — in so far, what has come in so far is not shown, since no day of this month has been checked yet in
 * the accounts that pay lands in; $2,283.84 still expected from It America LLC (weekly pay)".
 *
 * Its own component so a test can render the dash: in the page it was the one branch no test reached (review of
 * 9652477), and the one his ledger copy shows.
 */
export function IncomeSoFar({ noIncomeDayRead, postedCents, expectedCents, from }: IncomeSoFarProps) {
  return (
    <>
      {noIncomeDayRead ? <span className="figures text-ink-faint">—</span> : <Money cents={postedCents} />}
      {" in so far, "}
      <Money cents={expectedCents} /> still expected
      {from !== null && ` from ${from}`}
    </>
  );
}

/**
 * …and the line under the header that says why "in so far" prints a dash: "Not one day of Oct 2026 has been checked in
 * the accounts that pay lands in, so nothing is shown." — the dashboard's note under its own dash for the same month
 * (`noIncomeDayCheckedNote`), word for word. Nothing when a day of the month is checked: a figure stands there.
 */
export function IncomeSoFarNote({ noIncomeDayRead, month }: { noIncomeDayRead: boolean; month: string }) {
  if (!noIncomeDayRead) return null;
  return <p className="mt-1 text-xs text-ink-faint">{noIncomeDayCheckedNote(month)}</p>;
}
