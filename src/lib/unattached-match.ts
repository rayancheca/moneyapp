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
 * `toleranceDays` of the day, whose amount equals that day's expected amount TO THE CENT, sign and all — or, for a pay
 * series, a row attached to it that its settlement never reads (`UnattachedRow.notFiledAsIncome`).
 */
export interface UnattachedRow {
  readonly id: string;
  readonly postedOn: string;
  /** net-worth signed, as the ledger stores it */
  readonly amountCents: number;
  /**
   * ATTACHED to the pay series, on a day no row of it is filed as his pay (`payDayRows`): an import's link files
   * nothing (`absorbIntoLiveSeries`), and settlement counts no unfiled credit — so the row is there, attached, and
   * counted as nothing. Said as what it is, "attached to it but not filed as income", never "not attached to it".
   * Absent on a row with no series link.
   *
   * 🔴 Review of de31d22 (HIGH): with the import's link of b53989c, the trial import of the Oct 26 statement into his
   * pre-import copy attached the four +$1,141.92 payroll rows, filed none — and every surface said the pay "did not
   * reach a bank" again, since the rule skipped any row with a series link. ⚖️ Default built, not asked (2026-10-29):
   * named, never counted; whether the import should FILE it is his call.
   */
  readonly notFiledAsIncome?: boolean;
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

/** One series' question: the days it is about to call missed, the rows that could answer them, its own tolerance. */
export interface SeriesAsk {
  readonly seriesId: string;
  readonly days: readonly ExpectedDay[];
  readonly rows: readonly UnattachedRow[];
  readonly toleranceDays: number;
}

/** uuidv7 ids are lowercase hex and sort by creation: the older series first (`lib/ids`) */
const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * For each series, the unattached rows that match its days — at most one row a day, and EACH ROW ANSWERS ONE DAY OF ONE
 * SERIES: the day nearest it takes it (the earlier day on a tie, then the older series), and a day takes its nearest
 * row (the earlier row on a tie, then the lower id). Oldest day first; a series nothing matches is absent.
 *
 * 🔴 Review of e6ad55a (MEDIUM): each series was matched on its own. Two confirmed −$15.99 monthly bills on one card
 * both due Oct 10, and a single −$15.99 row of Oct 10 unattached: both took it — the runway read "$31.98 is matched to
 * the cent by rows of $15.99 on Oct 10 and Oct 10 that are not attached to it", and each bill's page claimed the row,
 * so the one that really did not post lost its "not posted". ⛔ One row is one payment: it is named once, under one
 * series, and the other still owes — the safe direction. ⚖️ Default built, not asked (2026-10-29): which of two equally
 * near series takes it is the older one — a stable order, never a guess at which bill it paid.
 */
export function unattachedMatchesAcross(asks: readonly SeriesAsk[]): ReadonlyMap<string, readonly UnattachedMatch[]> {
  const pairs = asks
    .flatMap((a) =>
      a.days.flatMap((day) =>
        a.rows
          .filter((r) => r.amountCents === day.amountCents)
          .map((r) => ({ seriesId: a.seriesId, day, row: r, gap: Math.abs(diffDays(day.date, r.postedOn)) }))
          .filter((p) => p.gap <= a.toleranceDays),
      ),
    )
    .sort(
      (a, b) =>
        a.gap - b.gap ||
        compareDates(a.day.date, b.day.date) ||
        byId(a.seriesId, b.seriesId) ||
        compareDates(a.row.postedOn, b.row.postedOn) ||
        a.row.id.localeCompare(b.row.id),
    );
  const takenDays = new Set<string>();
  const takenRows = new Set<string>();
  const bySeries = new Map<string, UnattachedMatch[]>();
  for (const p of pairs) {
    const dayKey = `${p.seriesId} ${p.day.date}`;
    if (takenDays.has(dayKey) || takenRows.has(p.row.id)) continue;
    takenDays.add(dayKey);
    takenRows.add(p.row.id);
    bySeries.set(p.seriesId, [...(bySeries.get(p.seriesId) ?? []), { date: p.day.date, row: p.row }]);
  }
  return new Map(
    [...bySeries].map(([id, matches]) => [id, [...matches].sort((a, b) => compareDates(a.date, b.date))] as const),
  );
}

/** For one series' days, the unattached rows that match them (`unattachedMatchesAcross`, asked of it alone). */
export function unattachedMatches(
  days: readonly ExpectedDay[],
  rows: readonly UnattachedRow[],
  toleranceDays: number,
): readonly UnattachedMatch[] {
  return unattachedMatchesAcross([{ seriesId: "", days, rows, toleranceDays }]).get("") ?? [];
}

/** The matched rows' money, as a positive magnitude — the part of a "never" or a "not posted" they answer. */
export function unattachedCents(matches: readonly UnattachedMatch[]): number {
  return matches.reduce((sum, m) => sum + Math.abs(m.row.amountCents), 0);
}

/**
 * Of the rows the one rule matched over a schedule's life (`CashEarningsReading.unattachedPaydays`), those for the
 * paydays of its SILENCE — after the last day that banked, every one when nothing ever has — oldest first. ⛔ One
 * reading for every sentence about the silence, whatever window it is printed in: Earned vs banked's verdict
 * (`IncomePayLine.silenceUnattached`) and /spending's note for a stale schedule. 🔴 Review of ff0bf19 (MEDIUM): that
 * note explained the schedule-wide silence by its own window's rows, so on his pre-filing and trial copies read Oct 31
 * Q3 said "that money was held as cash, …" where October, Q4 and YTD on the same page said "that money sits in the
 * rows named above" — one silence, the same four payroll rows on Wells Fargo, two answers.
 */
export function silenceMatches(
  matches: readonly UnattachedMatch[],
  lastBankedOn: string | null,
): readonly UnattachedMatch[] {
  if (lastBankedOn === null) return matches;
  return matches.filter((m) => compareDates(m.date, lastBankedOn) > 0);
}

const AND_LIST = new Intl.ListFormat("en", { style: "long", type: "conjunction" });

/** What a row is that the series does not count: never attached, or attached and filed as no income. */
const NOT_ATTACHED = { one: "that is not attached to it", many: "that are not attached to it" };
const NOT_FILED = {
  one: "that is attached to it but not filed as income",
  many: "that are attached to it but not filed as income",
};

/** One kind of row by its own day and amount (one amount named once), oldest first. */
function rowsOfOneKind(
  byDay: readonly UnattachedMatch[],
  formatDay: (iso: string) => string,
  kind: { one: string; many: string },
): string {
  const amounts = new Set(byDay.map((m) => Math.abs(m.row.amountCents)));
  const days = byDay.map((m) => formatDay(m.row.postedOn));
  if (byDay.length === 1) {
    return `a row of ${formatCents(Math.abs(byDay[0]!.row.amountCents))} on ${days[0]} ${kind.one}`;
  }
  const named =
    amounts.size === 1
      ? `${formatCents([...amounts][0]!)} on ${AND_LIST.format(days)}`
      : AND_LIST.format(byDay.map((m, i) => `${formatCents(Math.abs(m.row.amountCents))} on ${days[i]}`));
  return `rows of ${named} ${kind.many}`;
}

/**
 * "a row of $695.04 on Oct 15 that is not attached to it", "rows of $1,141.92 on Oct 1, Oct 8, Oct 15, and Oct 22 that
 * are not attached to it" — the rows by their own day and amount (one amount named once), in the day format of the
 * sentence they finish. Every surface that would have claimed absence says this instead (`MATCHED_TO_THE_CENT_BY`).
 * ⚖️ A row attached to the pay and filed as no income is said as that (`UnattachedRow.notFiledAsIncome`) — "that is
 * attached to it but not filed as income" — the unattached first when there are both.
 */
export function unattachedRowsWords(
  matches: readonly UnattachedMatch[],
  formatDay: (iso: string) => string,
): string {
  const byDay = [...matches].sort((a, b) => compareDates(a.row.postedOn, b.row.postedOn));
  const unattached = byDay.filter((m) => m.row.notFiledAsIncome !== true);
  const notFiled = byDay.filter((m) => m.row.notFiledAsIncome === true);
  return [
    ...(unattached.length === 0 ? [] : [rowsOfOneKind(unattached, formatDay, NOT_ATTACHED)]),
    ...(notFiled.length === 0 ? [] : [rowsOfOneKind(notFiled, formatDay, NOT_FILED)]),
  ].join(", and ");
}

/** "matched to the cent by" — the lead of every sentence that names the rows (`unattachedRowsWords`). */
export const MATCHED_TO_THE_CENT_BY = "matched to the cent by";

/**
 * Of the `of` paydays a sentence has just counted, the ones the rows answer: "it is matched to the cent by a row of …",
 * "they are matched …" when the rows answer every one, "3 of them are matched …" when they answer some — never "they
 * are" of paydays no row matches, the money that hides. Earned vs banked's verdict and the passed paydays' frontier
 * clause (`unbankedIncomeFrontierClause`) say it in these words.
 */
export function matchedOfWords(
  matched: readonly UnattachedMatch[],
  of: number,
  formatDay: (iso: string) => string,
): string {
  const rows = `${MATCHED_TO_THE_CENT_BY} ${unattachedRowsWords(matched, formatDay)}`;
  if (matched.length >= of) return `${of === 1 ? "it is" : "they are"} ${rows}`;
  return `${matched.length} of them ${matched.length === 1 ? "is" : "are"} ${rows}`;
}

/** Whether one of the rows is attached and filed as no income (`UnattachedRow.notFiledAsIncome`). */
const anyNotFiled = (matches: readonly UnattachedMatch[]): boolean =>
  matches.some((m) => m.row.notFiledAsIncome === true);

/**
 * What a deposit needs to count toward the schedule, where a surface naming the rows would have said "with no deposit":
 * "attached to {it}" — and once one of them is attached and filed as no income, "attached to {it} and filed as income".
 * ⛔ True of every payday the rows answer: no deposit both attached and filed has paid it. 🔴 "With no deposit attached
 * to this schedule" was false beside the payroll rows the next import attaches, unfiled (review of de31d22).
 */
export function countedDepositWords(matches: readonly UnattachedMatch[], it: string): string {
  return anyNotFiled(matches) ? `attached to ${it} and filed as income` : `attached to ${it}`;
}

/**
 * What the rows are not, after a surface has named them: "not attached to {it}", "not filed as income" — or, some of
 * each, "not attached to {it} or not filed as income" — the reason none of them is counted.
 */
export function notCountedWords(matches: readonly UnattachedMatch[], it: string): string {
  if (!anyNotFiled(matches)) return `not attached to ${it}`;
  return matches.every((m) => m.row.notFiledAsIncome === true)
    ? "not filed as income"
    : `not attached to ${it} or not filed as income`;
}

/** A "never reached a bank" figure, and what of it the rows the one rule matched answer. */
export interface NeverSplit {
  readonly cents: number;
  /** of `cents`, the rows' money — never more than the figure (a net shortfall can be less than a payday) */
  readonly matchedCents: number;
  /** the rows `matchedCents` is — none when it is zero */
  readonly matched: readonly UnattachedMatch[];
}

/**
 * ⛔ ONE SPLIT of a "never reached a bank" figure by the rows the one rule matched to its paydays — Earned vs banked's
 * difference (`gapOf`) and /spending's shortfall note (`payShortfallNote`). The rows pay nothing: the figure is
 * unchanged, and only the claim that their money did not arrive is withdrawn. Capped at the figure, so the parts add
 * up to it: a window whose net shortfall is $941.92 holds no $1,141.92 the rows answer.
 */
export function neverSplit(neverCents: number, matched: readonly UnattachedMatch[]): NeverSplit {
  const matchedCents = Math.max(0, Math.min(neverCents, unattachedCents(matched)));
  return { cents: neverCents, matchedCents, matched: matchedCents === 0 ? [] : matched };
}

/**
 * The split said as clauses: "$X of it never reached a bank" (`ofIt`; "$X never reached a bank" in a note's list), or
 * `bare` "never reached a bank" when it is the whole difference — and of what the rows answer, "$Y is matched to the
 * cent by rows of $1,141.92 on Oct 1, … that are not attached to it", or "all of it is …" (bare) when they answer every
 * cent. Empty for no figure. 🔴 His ledger copy 2026-10-29 (before his filing): the difference read "never reached a
 * bank" over $4,567.68 of October paydays whose four payroll rows sat on Wells Fargo, unattached; and /spending's note
 * "none of it reached a bank" beside the card naming them (review of de31d22).
 */
export function neverClauses(
  never: NeverSplit,
  formatDay: (iso: string) => string,
  form: { ofIt: boolean; bare: boolean },
): string[] {
  if (never.cents <= 0) return [];
  const amount = (cents: number): string => (form.ofIt ? `${formatCents(cents)} of it` : formatCents(cents));
  /*
   * ⛔ Capped — the rows hold more than the figure, money that paid no payday netted into it — the figure is named as
   * their paydays', and the rows as matching THOSE: "$941.92 is for the payday of Oct 22, which a row of $1,141.92 on
   * Oct 22 that is not attached to it matches to the cent", never "$941.92 is matched to the cent by a row of
   * $1,141.92". Measured on a copy of his ledger with Oct 1, 8 and 15 filed and Oct 22 unattached, read Nov 2: the
   * $200.00 of Oct 15 that went toward no payday is netted into October's figure.
   */
  const capped = never.matchedCents < unattachedCents(never.matched);
  const paydays = [...new Set(never.matched.map((m) => m.date))].sort(compareDates).map(formatDay);
  const rows = capped
    ? `for the ${paydays.length === 1 ? "payday" : "paydays"} of ${AND_LIST.format(paydays)}, which ` +
      `${unattachedRowsWords(never.matched, formatDay)} ${never.matched.length === 1 ? "matches" : "match"} to the cent`
    : `${MATCHED_TO_THE_CENT_BY} ${unattachedRowsWords(never.matched, formatDay)}`;
  if (never.matchedCents === 0) {
    return [form.bare ? "never reached a bank" : `${amount(never.cents)} never reached a bank`];
  }
  if (never.matchedCents === never.cents) {
    return [form.bare ? `all of it is ${rows}` : `${amount(never.cents)} is ${rows}`];
  }
  return [
    `${amount(never.cents - never.matchedCents)} never reached a bank`,
    `${formatCents(never.matchedCents)} is ${rows}`,
  ];
}
