import { Money } from "@/components/ui/Money";
import { IN_SO_FAR_UNCHECKED_SPOKEN } from "@/lib/unbanked-income";

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
 * still expected" over an October nothing had read. A screen reader hears why there is no figure, in one sentence with
 * the figures after it (`IN_SO_FAR_UNCHECKED_SPOKEN`).
 *
 * Its own component so a test can render the dash: in the page it was the one branch no test reached (review of
 * 9652477), and the one his ledger copy shows.
 */
export function IncomeSoFar({ noIncomeDayRead, postedCents, expectedCents, from }: IncomeSoFarProps) {
  return (
    <>
      {noIncomeDayRead ? (
        <>
          <span aria-hidden="true">
            <span className="figures text-ink-faint">—</span> in so far,
          </span>
          <span className="sr-only">{IN_SO_FAR_UNCHECKED_SPOKEN}</span>
        </>
      ) : (
        <>
          <Money cents={postedCents} /> in so far,
        </>
      )}{" "}
      <Money cents={expectedCents} /> still expected
      {from !== null && ` from ${from}`}
    </>
  );
}
