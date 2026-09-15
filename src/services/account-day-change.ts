import type { AppDatabase } from "@/db/client";
import type { AccountType } from "@/db/schema/accounts";
import { closesDayChange, dayChangeLabel, type DayChangeLabel } from "@/lib/day-change-label";
import { derivesFromHoldings } from "./derivation";
import { listAccountHoldings } from "./holdings";
import { portfolioDayChange } from "./portfolio";

/** One covered day of a balance series, in the net-worth sign convention. */
export interface CoveredDay {
  day: string;
  cents: number;
}

/** A day change, the two days it was measured between, and what to call it — from one read. */
export interface AccountDayChange {
  /** net-worth frame; null when there is nothing to measure, never a 0 that would say "moved nowhere" */
  cents: number | null;
  /** the newer of the two days the figure was measured between */
  asOf: string | null;
  /** the older of them */
  vsDay: string | null;
  /** `dayChangeLabel` over those days, or `closesDayChange` over the closes the move is made of */
  heading: DayChangeLabel;
}

interface AccountRef {
  id: string;
  type: AccountType;
}

/**
 * The day change of one account — the /accounts/[id] header chip and the
 * account's card on /accounts and the dashboard.
 *
 * 🔴 Both read it off the account's balance series, and for an account priced
 * from holdings that series is carried to today whatever the newest close
 * (`rebuildInvestmentHistory`). Measured on the real ledger, Tue 2026-09-15:
 * Robinhood Brokerage's header read "Today $0.00" — Tuesday against Monday, both
 * at Monday's closes — directly above a Day column dated "Sep 14 vs Sep 11"
 * whose nine rows summed to +$1,110.27; Robinhood Crypto read "Today $0.00"
 * above ETH's +$794.72; both cards "$0.00 today". /investments had been fixed
 * for exactly this an hour earlier (`portfolioDayChange`), and these two
 * surfaces still asked the series.
 *
 * ⛔ So the branch is `derivesFromHoldings` — the one `rebuildAccount` takes —
 * and the move is `portfolioDayChange` scoped to the account, named by the
 * closes it is made of. An investment account with NO holding events is priced
 * from its recorded balances and keeps its series' own two days.
 */
export function accountDayChange(
  db: AppDatabase,
  account: AccountRef,
  /** the account's covered series, oldest first — already cut where the caller dates its balance */
  series: readonly CoveredDay[],
  today: string,
  formatDay: (iso: string) => string,
): AccountDayChange {
  return groupDayChange(db, [account], series, today, formatDay);
}

/**
 * The same rule over a group of accounts and their COMBINED series — an
 * institution card's heading.
 *
 * A group made only of accounts priced from holdings has the carried tail
 * `accountDayChange` refuses, so it is measured the same way over all of their
 * holdings. ⚠️ A group that mixes them with ledger accounts keeps its combined
 * series: it covers only the days every child covers, and a ledger child is cut
 * at the day its balance was observed. On the real ledger, Tue 2026-09-15, the
 * Robinhood group (Agentic, Brokerage, Cash, Crypto) reads "Aug 31 vs Aug 30" —
 * its own two days, not the carried pair.
 */
export function groupDayChange(
  db: AppDatabase,
  accounts: readonly AccountRef[],
  combined: readonly CoveredDay[],
  today: string,
  formatDay: (iso: string) => string,
): AccountDayChange {
  if (accounts.length > 0 && accounts.every((a) => derivesFromHoldings(db, a))) {
    const ids = accounts.map((a) => a.id);
    const move = portfolioDayChange(db, ids.flatMap((id) => listAccountHoldings(db, id)), ids);
    return {
      cents: move.cents,
      asOf: move.on,
      vsDay: move.vsDay,
      heading: closesDayChange(move.closes, today, formatDay).heading,
    };
  }
  const change = seriesDayChange(combined);
  return { ...change, heading: dayChangeLabel(change.asOf, change.vsDay, today, formatDay) };
}

/**
 * The move between the last two covered days — AND the two days it was measured
 * between, from one read of the same array.
 *
 * ⛔ The figure and the word for it are returned together on purpose. A caller
 * that took the cents here and read the date off `AccountCard.asOf` (or, worse,
 * `InstitutionGroup.asOf`) would be two places agreeing about a date, which is
 * the defect pass 54 was written to stop — and for a GROUP the two are not even
 * the same day.
 */
function seriesDayChange(series: readonly CoveredDay[]): Omit<AccountDayChange, "heading"> {
  // Fewer than two covered days is no measured change at all, so there is no
  // pair of days to name either — null, not the single day, which would invite
  // a caller to print "as of X" over a figure that does not exist.
  if (series.length < 2) return { cents: null, asOf: null, vsDay: null };
  const last = series[series.length - 1]!;
  const prev = series[series.length - 2]!;
  return { cents: last.cents - prev.cents, asOf: last.day, vsDay: prev.day };
}
