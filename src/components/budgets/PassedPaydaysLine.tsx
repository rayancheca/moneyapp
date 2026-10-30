import { Money } from "@/components/ui/Money";
import { formatDayLong, formatDayShort } from "@/lib/format-date";
import { countedDepositWords, MATCHED_TO_THE_CENT_BY, unattachedRowsWords } from "@/lib/unattached-match";
import { IMPORTS_NOT_EARNINGS, leftOutOf, unbankedIncomeFrontierClause } from "@/lib/unbanked-income";
import type { IncomeExpectation } from "@/services/budgets";

export interface PassedPaydaysLineProps {
  income: Pick<
    IncomeExpectation,
    | "passedUnpaidCents"
    | "passedUnpaidOccurrences"
    | "passedUnpaidCheckedOccurrences"
    | "passedUnpaidFrontier"
    | "passedUnpaidUnattached"
    | "passedUnpaidInSoFar"
  >;
}

/**
 * /budgets' line under its header naming the paydays that passed this month with nothing banked against them — the
 * third leg, which "in so far" (cut at today) and "still expected" (opening on it) both leave out: "1 payday worth
 * $1,141.92 already passed this month with no deposit against it — counted in neither figure above. That is evidence
 * about what has been imported, not about whether the money was earned." Nothing when no payday passed unpaid.
 *
 * 🔴 "With no deposit against them" was said of Sep 3 and Sep 10 while the account that pay lands in was checked through
 * Aug 12 (measured 2026-09-15): it is said only when every passed payday fell on a day the ledger has checked, and
 * otherwise the frontier clause (`unbankedIncomeFrontierClause`) names the rest as not looked for, in /spending's
 * words. ⛔ …and only where no row matches one unattached (`lib/unattached-match`): the rows are named, "with no deposit
 * attached to them" — "…and filed as income" once one of them is attached and filed nowhere (`countedDepositWords`).
 *
 * ⛔ "Counted in neither figure above" only of the paydays no row "in so far" holds answers (`leftOutOf` over
 * `IncomeExpectation.passedUnpaidInSoFar`, the rows the one rule matched that "in so far" counts): "— $1,141.92 of it
 * counted in neither figure above" where it holds some, nothing said of the figures where it holds them all. 🔴 Review
 * of 5c1c4903 (MEDIUM): Jul 9's $1,000 filed Income › Salary and attached to nothing read "$2,000.00 in so far" over
 * the same payday "counted in neither figure above". 🔴 Review of 082a0ef5 (B3, B4, MEDIUM): its fix held the claim
 * back of every payday while any Income sat unattached where some pay landed — and no test read this sentence, so
 * the claim always held back (`{"."}`) or always said passed every test there was. Its own component now, rendered by
 * PassedPaydaysLine.test.ts.
 */
export function PassedPaydaysLine({ income }: PassedPaydaysLineProps) {
  if (income.passedUnpaidCents <= 0) return null;
  // which of the passed paydays the ledger has looked for — null when all of them
  const passedUnread = unbankedIncomeFrontierClause(
    {
      occurrenceCount: income.passedUnpaidOccurrences,
      checkedOccurrenceCount: income.passedUnpaidCheckedOccurrences,
      frontier: income.passedUnpaidFrontier,
      unattached: income.passedUnpaidUnattached,
    },
    formatDayLong,
  );
  const matched = income.passedUnpaidUnattached;
  const them = income.passedUnpaidOccurrences === 1 ? "it" : "them";
  const noDeposit =
    matched.length === 0
      ? `with no deposit against ${them}`
      : `with no deposit ${countedDepositWords(matched, them)}, ` +
        `${MATCHED_TO_THE_CENT_BY} ${unattachedRowsWords(matched, formatDayShort)}`;
  const neither = leftOutOf(income.passedUnpaidCents, income.passedUnpaidInSoFar, "counted in neither figure above");
  return (
    <p className="mt-1 text-xs text-ink-faint">
      {income.passedUnpaidOccurrences === 1 ? "1 payday" : `${income.passedUnpaidOccurrences} paydays`} worth{" "}
      <Money cents={income.passedUnpaidCents} /> already passed this month
      {passedUnread === null && <> {noDeposit}</>}
      {neither !== null && (
        <>
          {" — "}
          {neither.cents !== null && (
            <>
              <Money cents={neither.cents} />{" "}
            </>
          )}
          {neither.words}
        </>
      )}
      .{" "}
      {passedUnread ?? IMPORTS_NOT_EARNINGS}
    </p>
  );
}
