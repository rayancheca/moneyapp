import { nothingFoundSoFar } from "@/lib/budget-coverage";
import { formatCents } from "@/lib/money";
import { ledgerHref } from "@/lib/ledger-href";
import type { DateRange } from "@/services/analytics";
import type { PartlyRead } from "@/services/provenance";
import type { PeriodTotals } from "@/services/spending";

/**
 * Pure descriptor for the /spending summary cards. Lives in lib (type-only
 * imports of PeriodTotals / DateRange are erased at build time, so no drizzle
 * leaks into the client bundle) so the card set — especially the conditional
 * Refunds card and every aria string — is unit-testable without rendering.
 *
 * The card row makes Net self-explaining: Income + Refunds − Spent = Net, all
 * on screen. Refunds only appears when there are refunds (positive amounts in
 * expense categories — statement credits, reimbursements). Its drill-down
 * (`category=spending, flow=in`) resolves to exactly the rows summed into
 * `refundsCents`, so the number reconciles to the list it opens — the same
 * "nothing view-only" contract every other card honors.
 */
export interface SpendingStatCardSpec {
  key: "earned" | "spent" | "refunds" | "net" | "savings";
  label: string;
  /** money-valued cards carry cents; `flow` shows +/- and semantic tone */
  cents?: number;
  flow?: boolean;
  /** non-money value (the savings-rate percent, or an em-dash) */
  text?: string;
  /** render `text` in the faint tone (the em-dash placeholder) */
  muted?: boolean;
  /** small sub-line under the value */
  delta?: string;
  href: string;
  ariaLabel: string;
  /** span both columns on the 2-col mobile grid so the card isn't a lonely orphan */
  mobileFull?: boolean;
  /**
   * ⚖️ Decision 72: the figure is a total over days some account behind it has not been read for — one he spends from,
   * or one his income landed in — and the card wears the "partly read" chip (`VERDICT_PRESENTATION.partly_read`).
   * Absent on a window read in full, and on a dash.
   */
  partlyRead?: boolean;
}

/** What the page knows of the window beyond its totals — each null where its figures are a measurement. */
export interface SpendingStatCardFacts {
  /**
   * ⚖️ §6A 68: the dashboard's words under its Income dash, for this window (`noIncomeDayCheckedNote`) — where no
   * income was found and not one of its days is checked where the pay lands (`CashFlow.incomeUnread`)
   */
  incomeUnread?: string | null;
  /** ⚖️ Decision 72: the period proof's days read only in part and their line (`Provenance.partlyRead`, Where it went's) */
  partlyRead?: PartlyRead | null;
  /**
   * ⚖️ Decision 72, extended to income totals: the days of the window the accounts his income landed in are not read
   * for, and their line — `/categories/<Income>`'s reading of the same days (`provenance::allIncomePartlyRead`)
   */
  incomePartlyRead?: PartlyRead | null;
}

/** a card whose figure is no measurement (decisions 64 + 72): the em dash, in the faint tone */
const DASH = { text: "—", muted: true } as const;

/** decision 72's chip word, inside a screen reader's sentence (the card's whole content is its aria-label) */
const PARTLY_READ = "partly read";

/**
 * Why Net and the savings rate wait, for a screen reader — Spent's and Income's own cards say why each is a dash:
 * "until spending is found", "until income is found", or both. ⚖️ §6A 68: the dashboard's Free to spend, Income's
 * arithmetic too, waits in the same words (`SpendingPaceWidget`).
 */
export function untilFound(spending: boolean, income: boolean): string {
  return `until ${spending && income ? "spending and income are" : spending ? "spending is" : "income is"} found`;
}

/** aria-friendly "N dollars" (matches the existing StatCard phrasing) */
function dollars(cents: number): string {
  return `${cents / 100} dollars`;
}

/**
 * ⚖️ Decisions 64 + 72: `spendingUnaccounted` is the window's `CashFlow.spendingUnaccounted` — "spending imported
 * through Aug 12" where it holds no spending row and not one of its elapsed days is read by the day every account he
 * spends from is imported through. Spent prints "—" with it, and so do Net and the savings rate, which are Spent's
 * arithmetic; what was found (Income, Refunds) keeps its figure, and every card keeps its link. 🔴 Review of 516d6fc,
 * his ledger copy 2026-10-13: `/spending?period=2026-09-23` read "Spent $0.00 · Net +$4,567.68 · Savings rate 100%"
 * over its own table row "$4,567.68 — —".
 *
 * ⚖️ §6A 68, the one rule on every caller (2026-10-21): `facts.incomeUnread` dashes Income under the dashboard's words
 * for its own dash, and Net and the savings rate with it — they are Income's arithmetic too. ⚖️ Decision 72:
 * `facts.partlyRead` marks Spent, Refunds, Net and the savings rate "partly read" where each prints a figure, with the
 * period proof's line under Spent. 🔴 His ledger copy 2026-10-21: `/spending` carded October "INCOME $0.00 · SPENT
 * $1,603.00 · NET -$1,603.00 · SAVINGS RATE — no income yet" — under a dashboard printing "—" for October's income,
 * and over its own "Where it went" reading "partly read · spending imported through Aug 12 · 21 days of this period
 * unaccounted".
 *
 * ⚖️ Decision 72, extended to income totals (ruled implied 2026-10-14): `facts.incomePartlyRead` marks Income, with its
 * own line under it, and Net and the savings rate — Income's arithmetic as much as Spent's. 🔴 His ledger copy
 * 2026-10-21 (review of 827e9a5): `?period=2026-09` carded "Income $6,177.88" bare beside four cards wearing the chip,
 * while `/categories/<Income>` for the same days read "income imported through Jul 31 · 30 days of this period
 * unaccounted"; Net's chip read spending's proof alone.
 */
export function spendingStatCards(
  totals: PeriodTotals,
  range: DateRange,
  spendingUnaccounted: string | null = null,
  facts: SpendingStatCardFacts = {},
): SpendingStatCardSpec[] {
  const { earnedCents, spentCents, refundsCents, netCents, savingsRatePct } = totals;
  const showRefunds = refundsCents > 0;
  const cards: SpendingStatCardSpec[] = [];
  const notFound = spendingUnaccounted === null ? null : nothingFoundSoFar(spendingUnaccounted);
  const incomeUnread = facts.incomeUnread ?? null;
  // ⚖️ no Spent or no Income, no Net and no rate: both are their arithmetic (decisions 64 + 72, §6A 68)
  const arithmeticWaits = notFound !== null || incomeUnread !== null;
  const waitsFor = untilFound(notFound !== null, incomeUnread !== null);
  // ⚖️ decision 72: the chip, on a figure the spending accounts have read only in part — never on a dash
  const partly = facts.partlyRead ?? null;
  const chip = partly === null ? {} : { partlyRead: true };
  const partlySpoken = partly === null ? "" : `, ${PARTLY_READ}`;
  // …on Income, by the accounts his income landed in; and on Net and the rate by either — they are the arithmetic of both
  const incomePartly = facts.incomePartlyRead ?? null;
  const eitherPartly = partly ?? incomePartly;
  const netChip = eitherPartly === null ? {} : { partlyRead: true };
  const netSpoken = eitherPartly === null ? "" : `, ${PARTLY_READ}`;

  /*
   * 🔴 S22 — "Earned" NAMED A POPULATION IT DID NOT HOLD. `earnedCents` is every
   * positive row in an income-kind category (`isIncome`) — off the agent's cash
   * account since 2026-09-28, his pay by the day since decision 75 (`hisIncomeRows`),
   * and `?category=income` opens the same set; /summary's "Earned" is
   * wages, tutoring and savings interest, and files financial aid and
   * reimbursements under "Money in that you did not earn". Measured on the real
   * ledger 2026-09-15: `/spending?period=2024` read "Earned $32,717.06" over a
   * year holding a $14,171.00 financial-aid refund.
   *
   * ⛔ Owner decision 2026-09-14: this population is "Income" on every surface
   * that prints it — this card, the savings and Net deltas, the heatmap, the
   * cash-flow chart/table/graph and the dashboard bridge — while /summary keeps
   * its narrow "Earned". Only words moved: the figure, the savings-rate base and
   * every href are unchanged. The `key` stays "earned" (never printed).
   *
   * ⚖️ …and an Income nobody has looked for is no figure (§6A 68): "—", with the dashboard's note for its own dash as
   * the line under it — word for word, the one sentence for it (`noIncomeDayCheckedNote`).
   */
  const incomeHref = ledgerHref({ category: "income", from: range.from, to: range.to });
  cards.push(
    incomeUnread === null
      ? {
          key: "earned",
          label: "Income",
          cents: earnedCents,
          // ⚖️ decision 72: `/categories/<Income>`'s line for the days the chip calls partly read, under its figure
          ...(incomePartly === null ? {} : { partlyRead: true, delta: incomePartly.line }),
          href: incomeHref,
          ariaLabel:
            `Income this period. ${dollars(earnedCents)}` +
            `${incomePartly === null ? "" : `, ${PARTLY_READ}: ${incomePartly.line}`}. View income transactions.`,
        }
      : {
          key: "earned",
          label: "Income",
          ...DASH,
          delta: incomeUnread,
          href: incomeHref,
          ariaLabel: `Income this period: no figure. ${incomeUnread} View income transactions.`,
        },
  );

  const spentHref = ledgerHref({ category: "spending", from: range.from, to: range.to, flow: "out" });
  cards.push(
    notFound === null
      ? {
          key: "spent",
          label: "Spent",
          cents: spentCents,
          // ⚖️ decision 72: /budgets' line for the days the chip calls partly read, under the figure it grades
          ...(partly === null ? {} : { partlyRead: true, delta: partly.line }),
          href: spentHref,
          ariaLabel:
            `Spent this period, gross. ${dollars(spentCents)}` +
            `${partly === null ? "" : `, ${PARTLY_READ}: ${partly.line}`}. View spending transactions.`,
        }
      : {
          key: "spent",
          label: "Spent",
          ...DASH,
          delta: notFound,
          href: spentHref,
          ariaLabel: `Spent this period: ${notFound}. View spending transactions.`,
        },
  );

  if (showRefunds) {
    cards.push({
      key: "refunds",
      label: "Refunds",
      cents: refundsCents,
      flow: true,
      delta: "money back",
      // ⚖️ read from the accounts Spent is read from (decision 72)
      ...chip,
      href: ledgerHref({ category: "spending", from: range.from, to: range.to, flow: "in" }),
      ariaLabel: `Refunds this period. ${dollars(refundsCents)} back${partlySpoken}. View refund transactions.`,
      mobileFull: true,
    });
  }

  cards.push({
    key: "net",
    label: "Net",
    // ⚖️ no Spent or no Income, no Net: the figure is their arithmetic (decisions 64 + 72, §6A 68) — and over days
    // Spent or Income is read only in part, it is read only in part too
    ...(arithmeticWaits ? DASH : { cents: netCents, flow: true, ...netChip }),
    // with Refunds on screen the arithmetic is visible; name it for clarity
    delta: showRefunds ? "income + refunds − spent" : undefined,
    /*
     * 🔴 THE DRILL-DOWN CONTRACT, BROKEN ON THE ONE CARD THAT SUMS THE OTHER
     * THREE. This was an unscoped window, so `/spending?period=2026` printed
     * "Net -$31,733.19" over a link opening 2,682 rows summing to +$27,961.36 —
     * the whole ledger for the year, transfers, card payments and investment
     * flows included. Its Earned, Spent and Refunds siblings all opened exactly
     * the rows behind them. `cashflow` is their union, which is the population
     * this figure is over.
     */
    href: ledgerHref({ category: "cashflow", from: range.from, to: range.to }),
    ariaLabel: arithmeticWaits
      ? `Net this period: no figure ${waitsFor}. View the income and spending behind it.`
      : `Net this period. ${netCents < 0 ? "negative " : ""}${dollars(Math.abs(netCents))}${netSpoken}. ` +
        "View the income and spending behind it.",
  });

  /*
   * ❓ OWNER DECISION, 2026-09-04: NAME THE DENOMINATOR, never suppress the
   * figure.
   *
   * `/spending?from=2026-07-01&to=2026-07-31` read
   *
   *     EARNED $52.95 · SPENT $10,353.96 · REFUNDS +$113.11 · NET -$10,187.90
   *     SAVINGS RATE  -19240.6%   overspent
   *
   * The rate is `net ÷ earned`, and July's recorded income is $52.95 of
   * dividends and interest — the cash job's $5,235.00 never reached a bank,
   * which the note under these cards says in full. The house style elsewhere is
   * to REFUSE a ratio its denominator cannot carry (`merchantProfile` will not
   * state a monthly rate under three visits), but refusing this one whenever
   * there is unbanked pay would refuse it on every recent window — and his
   * decision of 2026-08-21 is that both readings stand when the spending and
   * income surfaces disagree about the cash: "suppressing this one would tell a
   * working man he has no income."
   *
   * So the base is printed instead, always and not past a threshold: nothing
   * here was wrong, only unreadable. The base is named with the word the sibling
   * card uses for the same figure — "Income" since S22, when "Earned" turned out
   * to hold financial aid and reimbursements that /summary says were not earned.
   *
   * ⚖️ …and a rate over a Spent nobody has found is no figure (decisions 64 + 72): "—", the base still named.
   *
   * ⚖️ …and over an Income nobody has looked for (§6A 68) there is no base to name, and "no income yet" would be a
   * claim about days no statement has read: the rate says what it waits for instead. (Such a window found no income,
   * so it has no rate to print: `savingsRatePct` is null.)
   */
  const waits = notFound !== null && savingsRatePct !== null;
  const rateFigure = savingsRatePct !== null && !waits;
  cards.push({
    key: "savings",
    label: "Savings rate",
    text: rateFigure ? `${savingsRatePct}%` : "—",
    muted: !rateFigure,
    delta:
      incomeUnread !== null
        ? waitsFor
        : savingsRatePct === null
          ? "no income yet"
          : waits
            ? `of ${formatCents(earnedCents)} income`
            : `${netCents >= 0 ? "kept" : "overspent"} · of ${formatCents(earnedCents)} income`,
    ...(rateFigure ? netChip : {}),
    // the same population as Net — this rate is net ÷ income, and both terms
    // come from these rows
    href: ledgerHref({ category: "cashflow", from: range.from, to: range.to }),
    ariaLabel:
      incomeUnread !== null
        ? `Savings rate unavailable ${waitsFor}.`
        : savingsRatePct === null
          ? "Savings rate unavailable without income."
          : waits
            ? `Savings rate unavailable ${waitsFor}, of ${dollars(earnedCents)} of income.`
            : `Savings rate ${savingsRatePct} percent, of ${dollars(earnedCents)} of income${netSpoken}.`,
  });

  return cards;
}
