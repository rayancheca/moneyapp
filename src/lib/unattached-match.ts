import { compareDates, diffDays } from "@/lib/dates";
import { formatCents } from "@/lib/money";

/**
 * A ROW THAT MATCHES A DAY TO THE CENT, SITTING THERE UNATTACHED — the one rule every surface asks before it calls a
 * payday "did not reach a bank" or a due day "has not posted".
 *
 * 🔴 Measured on his ledger copy 2026-10-29, after the Wells Fargo statement of Sep 25 → Oct 26 was imported and before
 * he filed it: Earned vs banked read "4 paydays have passed since Sep 24 with no deposit. 4 of them fall on days the
 * records already cover, through Oct 26 — so the pay did not reach a bank."; /spending's October note "implies
 * $4,567.68 of earnings over Oct 1 – 22, 2026 and none of it reached an account"; the runway "$695.04 has not posted"
 * — while four +$1,141.92 "It America LLC Payroll" rows (Oct 1, 8, 15, 22) and the −$695.04 "Mbfs.Com Auto Pay" of
 * Oct 15, the Car lease's due day, sat on Wells Fargo unattached: each payer's new description ("Mbfs Web Pay" in
 * September) is what kept the import from linking them. False statements about his money, and the next format change
 * brings them back.
 *
 * ⛔ IT NEVER PAYS ANYTHING. Linking stays his act or the import's (2026-09-14: "im not attaching shit by hand"
 * — the import's): a surface NAMES the row, its day and its amount, and still counts the payday unbanked and the bill
 * owed — the safe direction is owed. What it takes away is only the claim of absence.
 *
 * The match: an ACTIVE row with no series link (and no transfer pairing it to his own money — a leg of a transfer is
 * attached, to the other leg) on the series' account (`services/unattached-match`), dated within the series' own
 * `toleranceDays` of the day, whose amount equals that day's expected amount TO THE CENT, sign and all.
 */
export interface UnattachedRow {
  readonly id: string;
  readonly postedOn: string;
  /** net-worth signed, as the ledger stores it */
  readonly amountCents: number;
}

/** A payday or due day a surface is about to call missed, with what the series expected on it (net-worth signed). */
export interface ExpectedDay {
  readonly date: string;
  readonly amountCents: number;
}

export interface UnattachedMatch {
  /** the payday or due day */
  readonly date: string;
  readonly row: UnattachedRow;
}

/**
 * For each day, the unattached row that matches it — at most one row a day, and each row answers one day: the day
 * nearest it takes it (the earlier day on a tie), and a day takes its nearest row (the earlier row on a tie, then the
 * lower id). Oldest day first.
 */
export function unattachedMatches(
  days: readonly ExpectedDay[],
  rows: readonly UnattachedRow[],
  toleranceDays: number,
): readonly UnattachedMatch[] {
  const pairs = days
    .flatMap((day) =>
      rows
        .filter((r) => r.amountCents === day.amountCents)
        .map((r) => ({ day, row: r, gap: Math.abs(diffDays(day.date, r.postedOn)) }))
        .filter((p) => p.gap <= toleranceDays),
    )
    .sort(
      (a, b) =>
        a.gap - b.gap ||
        compareDates(a.day.date, b.day.date) ||
        compareDates(a.row.postedOn, b.row.postedOn) ||
        a.row.id.localeCompare(b.row.id),
    );
  const takenDays = new Set<string>();
  const takenRows = new Set<string>();
  const matches: UnattachedMatch[] = [];
  for (const p of pairs) {
    if (takenDays.has(p.day.date) || takenRows.has(p.row.id)) continue;
    takenDays.add(p.day.date);
    takenRows.add(p.row.id);
    matches.push({ date: p.day.date, row: p.row });
  }
  return matches.sort((a, b) => compareDates(a.date, b.date));
}

/** The matched rows' money, as a positive magnitude — the part of a "never" or a "not posted" they answer. */
export function unattachedCents(matches: readonly UnattachedMatch[]): number {
  return matches.reduce((sum, m) => sum + Math.abs(m.row.amountCents), 0);
}

const AND_LIST = new Intl.ListFormat("en", { style: "long", type: "conjunction" });

/**
 * "a row of $695.04 on Oct 15 that is not attached to it", "rows of $1,141.92 on Oct 1, Oct 8, Oct 15, and Oct 22 that
 * are not attached to it" — the rows by their own day and amount (one amount named once), in the day format of the
 * sentence they finish. Every surface that would have claimed absence says this instead (`MATCHED_TO_THE_CENT_BY`).
 */
export function unattachedRowsWords(
  matches: readonly UnattachedMatch[],
  formatDay: (iso: string) => string,
): string {
  const byDay = [...matches].sort((a, b) => compareDates(a.row.postedOn, b.row.postedOn));
  const amounts = new Set(byDay.map((m) => Math.abs(m.row.amountCents)));
  const days = byDay.map((m) => formatDay(m.row.postedOn));
  if (byDay.length === 1) {
    return `a row of ${formatCents(Math.abs(byDay[0]!.row.amountCents))} on ${days[0]} that is not attached to it`;
  }
  const named =
    amounts.size === 1
      ? `${formatCents([...amounts][0]!)} on ${AND_LIST.format(days)}`
      : AND_LIST.format(byDay.map((m, i) => `${formatCents(Math.abs(m.row.amountCents))} on ${days[i]}`));
  return `rows of ${named} that are not attached to it`;
}

/** "matched to the cent by" — the lead of every sentence that names the rows (`unattachedRowsWords`). */
export const MATCHED_TO_THE_CENT_BY = "matched to the cent by";
