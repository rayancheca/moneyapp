/**
 * Does the ledger still say what it said?
 *
 * Three things, none of which any existing arbiter asks:
 *
 *   1. CHAIN BREAKS — every consecutive chain-grade anchor pair on a cash
 *      account, walked with the derivation service's OWN endpoint selection
 *      (selectEndpoints), so a break here is a break there.
 *   2. STALE VERDICTS — statement_periods.reconciliation and gap_cents are
 *      written once, at import time, and nothing revisits them. Recompute each
 *      with the same rule that wrote it and report any that no longer match.
 *   3. SYNTHETIC MONEY — the net cents of replay-status rows carrying no
 *      import file, per account. Legitimately non-zero (the Robinhood crypto
 *      cash-leg mirrors are reconstructed from the crypto ledger, and the car
 *      down payment was hand-entered), so the check is that it has not MOVED.
 *
 * (3) is the one that would have caught the July 2026 plug: a +$3,579.67 row
 * with no source document, marked `excluded` so no spend view showed it, whose
 * only visible effect was to make a $3,811.52 hole read as $231.85.
 *
 * The rules live in src/lib/ledger-integrity.ts and src/lib/reconciliation.ts
 * and are unit-tested there; this file is the I/O around them.
 *
 * Exit 0 = the ledger matches BASELINE below, and no verdict has gone stale.
 *
 *   pnpm ledger-check
 */
import { createDatabase } from "@/db/client";
import { pickWinners, selectEndpoints } from "@/services/derivation";
import { RECONCILE_STATUSES, isVerdictStale, periodVerdict } from "@/lib/reconciliation";
import {
  type ChainBreak,
  type ChainWindow,
  type GradedPeriod,
  type LedgerBaseline,
  type StaleVerdict,
  type ValueAnchor,
  compareToBaseline,
  findChainBreaks,
  findValueAnchorDrift,
  formatLedgerFailures,
  statementDayValuation,
} from "@/lib/ledger-integrity";
import { investmentAccounts, portfolioSeries } from "@/services/portfolio";
import { formatCents } from "@/lib/money";

/**
 * The ledger as of 2026-08-17, pass 59, AFTER the crypto-movement migration.
 *
 * **No breaks. Every chain-grade anchor pair on every cash account closes to
 * the cent, and there are zero `gap` days in the ledger.**
 *
 * It got here by deleting the 74 approximated crypto cash legs that
 * `pnpm rh-mirror-crypto-cash` had written and re-importing the 32 Robinhood
 * statements under parser v2, which reads the `Crypto Money Movement` rows the
 * statements actually print. Nine breaks, 264 gap days, and the whole
 * $3,811.52 "shortfall" of 2026-07 were one dropped row type.
 *
 * ⚠️ Keeping this empty is the point. A break appearing here again is either a
 * new statement that does not close or a regression in that parser, and either
 * way it is worth stopping for — do not add an entry to quiet the check
 * without understanding what the money is.
 *
 * Synthetic totals: Cash on Hand is the -$5,000 car lease down payment, and it
 * traces to a real record. The Robinhood entry is gone because the rows it
 * described no longer exist.
 *
 * ✅ Chase Sapphire's +$9,680.91 left on 2026-09-14. It was 36 hand-reconstructed
 * card payments; 34 are printed on 12 of its own statements and now carry the
 * import file of the statement that prints them, and the unprinted +$115.00 /
 * −$115.00 pair of 2026-03-02 is superseded — so no Sapphire money in the chain
 * lacks a document. `scripts/attach-sapphire-payment-rows-2026-09-14.ts` made
 * that write; an entry reappearing here means a hand row came back.
 */
const BASELINE: LedgerBaseline = {
  breaks: {},
  syntheticNetCents: {
    "Cash on Hand": -500_000,
  },
  /*
   * PASS 73 — where the app's own valuation disagrees with what a statement
   * printed, on the day it printed it. Every entry names what the money IS: an
   * entry without a reason is a check that has been quieted rather than passed.
   *
   * ⛔ **Robinhood Crypto was already carrying nine of these and nobody knew.**
   * This check was built for `Robinhood Brokerage` — the last account with no
   * arbiter — and fired on the account next door before that import happened.
   *
   *   ✅ 2025-10-31 was -$1,505.00 and is -$0.14 now — FIXED, and it was the one
   *               entry here that was a HOLE rather than a disagreement. The
   *               cause was written down in the data: the book's first
   *               `holding_events` row was a placeholder, honestly labelled
   *               "opening balance per Nov 2025 statement (pre-Nov history
   *               unknown)", written when November was the earliest statement
   *               imported. October has since arrived, and its ten trades sum
   *               to 0.39130100 ETH — the placeholder's own quantity, to the
   *               eighth decimal — so `backfill-october-crypto-history.ts`
   *               replaced one with the other. Sixteen days of October gained a
   *               value they always had; not one day the book already covered
   *               moved. The 14¢ left is a price mark, like the rest.
   *   all nine    -$24.65 … +$18.94 against printed values of $1,505 → $27,360
   *               — 0.01% to 0.7%. Crypto has no closing auction: the app marks
   *               a daily close from its own source and Robinhood marks its own
   *               venue at its own instant, so two honest numbers differ. Kept
   *               to the cent anyway (see VALUE_ANCHOR_TOLERANCE_CENTS): a band
   *               wide enough to swallow these would be wide enough to swallow
   *               a missing position.
   */
  valueAnchors: {
    /*
     * ✅ **THREE ENTRIES LEFT THIS LIST ON 2026-08-31 — the split is fixed.**
     *
     * They used to read:
     *
     *   2025-02-28   -$91.21   COKE  printed $1,417.12  ledger $141.712
     *   2025-03-31  -$445.12   COKE  printed $1,350.00  ledger $135.00
     *   2025-04-30  -$667.86   COKE  printed $1,355.81  ledger $135.581
     *
     * — Coca-Cola Consolidated's 10-for-1, where a split-ADJUSTED price met an
     * unadjusted quantity and published exactly a tenth. The note here said it
     * was "worth its own pass, not a line in a baseline", and that pass landed:
     * `event_kind` now distinguishes a split from a trade (migration 0015),
     * `lib/split-adjust.ts` restates the timeline in today's shares, and
     * `scripts/mark-coke-split-2026-08-31.ts` marked the one row.
     *
     * ⭐ THIS CHECK IS THE INDEPENDENT WITNESS. The fix was designed against the
     * price cache and the event timeline; these three lines come from
     * ROBINHOOD'S OWN month-end statements, which the fix never consulted. All
     * three now agree to the cent, and this file failed loudly to say so —
     * exactly what a baseline of known disagreements is for.
     *
     * The three that remain are cached closes differing from the broker's marks
     * (2025-08-31 is NVDA at $181.60 against a printed $174.18; 2026-07-31 is
     * eight symbols each a few tenths of a percent apart). Every QUANTITY
     * matches the statement exactly on every date — measured — so none of this
     * is a missing position.
     */
    "Robinhood Brokerage": [
      { on: "2025-08-31", offByCents: 816 },
      { on: "2026-02-28", offByCents: -8_915 },
      { on: "2026-07-31", offByCents: -19_762 },
      // 2026-09-15: the August statement imported; the rebuilt holdings match all
      // nine of its positions to the share, so this is the price mark alone
      { on: "2026-08-31", offByCents: 10_625 },
    ],
    "Robinhood Crypto": [
      { on: "2025-10-31", offByCents: -14 },
      { on: "2025-11-30", offByCents: -240 },
      { on: "2025-12-31", offByCents: 38 },
      { on: "2026-01-31", offByCents: 246 },
      { on: "2026-02-28", offByCents: -2_465 },
      { on: "2026-03-31", offByCents: 1_894 },
      { on: "2026-04-30", offByCents: -1_618 },
      { on: "2026-05-31", offByCents: 40 },
      { on: "2026-06-30", offByCents: -2_449 },
      // 2026-09-15: the July and August crypto statements were imported and the
      // typed ETH event replaced by their 15 trades — the quantity matches both
      // closes exactly; what is left is the price mark (the cached close vs the
      // price Robinhood printed), the same kind as every entry above
      { on: "2026-07-31", offByCents: 4_006 },
      { on: "2026-08-31", offByCents: 2_811 },
    ],
  },
};

const { db, sqlite } = createDatabase(process.env.MONEYAPP_DB_PATH ?? "data/moneyapp.db");

const accounts = sqlite
  .prepare(`SELECT id, name, type FROM accounts ORDER BY name`)
  .all() as { id: string; name: string; type: string }[];

const breaks: Record<string, ChainBreak[]> = {};
/** every window walked, closing or not — what tells a closed break from a vanished one */
const chainWindows: Record<string, ChainWindow[]> = {};
const syntheticNetCents: Record<string, number> = {};
const staleVerdicts: StaleVerdict[] = [];
/** every period re-graded, agreeing or not — what tells a removed period from one that still agrees */
const gradedPeriods: Record<string, GradedPeriod[]> = {};

for (const account of accounts) {
  const isInvestment = account.type === "investment";

  // 1. chain breaks — cash accounts only. An investment account replays no
  // transactions at all (market movement is not one), so closure is not a
  // question that can be asked of it.
  if (!isInvestment) {
    const anchors = sqlite
      .prepare(
        `SELECT anchored_on AS anchoredOn, balance_cents AS balanceCents, source
           FROM balance_anchors WHERE account_id = ? ORDER BY anchored_on`,
      )
      .all(account.id) as { anchoredOn: string; balanceCents: number; source: string }[];

    const { endpoints } = selectEndpoints(pickWinners(anchors as never));
    const pairs = [];
    for (let i = 0; i + 1 < endpoints.length; i += 1) {
      const from = endpoints[i]!;
      const to = endpoints[i + 1]!;
      const movementCents = (
        sqlite
          .prepare(
            `SELECT COALESCE(SUM(amount_cents), 0) s FROM transactions
              WHERE account_id = ? AND status IN ('active','excluded')
                AND posted_on > ? AND posted_on <= ?`,
          )
          .get(account.id, from.anchoredOn, to.anchoredOn) as { s: number }
      ).s;
      pairs.push({
        from: from.anchoredOn,
        to: to.anchoredOn,
        fromCents: from.balanceCents,
        toCents: to.balanceCents,
        movementCents,
      });
    }
    chainWindows[account.name] = pairs.map(({ from, to }) => ({ from, to }));
    const found = findChainBreaks(pairs);
    if (found.length > 0) breaks[account.name] = found;
  }

  // 2. stale verdicts
  const periods = sqlite
    .prepare(
      `SELECT period_start AS periodStart, period_end AS periodEnd,
              beginning_balance_cents AS beginningBalanceCents,
              ending_balance_cents AS endingBalanceCents,
              reconciliation, gap_cents AS gapCents
         FROM statement_periods WHERE account_id = ? ORDER BY period_start`,
    )
    .all(account.id) as {
    periodStart: string;
    periodEnd: string;
    beginningBalanceCents: number | null;
    endingBalanceCents: number | null;
    reconciliation: string;
    gapCents: number | null;
  }[];

  gradedPeriods[account.name] = periods.map(({ periodStart, periodEnd }) => ({ periodStart, periodEnd }));
  for (const p of periods) {
    const movement = (
      sqlite
        .prepare(
          `SELECT COALESCE(SUM(amount_cents), 0) s FROM transactions
            WHERE account_id = ? AND status IN (${RECONCILE_STATUSES.map(() => "?").join(",")})
              AND posted_on >= ? AND posted_on <= ?`,
        )
        .get(account.id, ...RECONCILE_STATUSES, p.periodStart, p.periodEnd) as { s: number }
    ).s;
    const fresh = periodVerdict(p, movement, { isInvestment });
    if (isVerdictStale({ reconciliation: p.reconciliation as never, gapCents: p.gapCents }, fresh)) {
      staleVerdicts.push({
        account: account.name,
        periodStart: p.periodStart,
        storedGapCents: p.gapCents,
        freshGapCents: fresh.gapCents,
      });
    }
  }

  // 3. synthetic money inside the balance chain
  const synthetic = (
    sqlite
      .prepare(
        `SELECT COALESCE(SUM(amount_cents), 0) s FROM transactions
          WHERE account_id = ? AND import_file_id IS NULL AND status IN ('active','excluded')`,
      )
      .get(account.id) as { s: number }
  ).s;
  if (synthetic !== 0) syntheticNetCents[account.name] = synthetic;
}

for (const [name, found] of Object.entries(breaks)) {
  console.log(`${name}: ${found.length} chain break${found.length === 1 ? "" : "s"}`);
  for (const b of found) console.log(`  ${b.from} → ${b.to}  off by ${formatCents(b.offByCents)}`);
}
for (const [name, cents] of Object.entries(syntheticNetCents)) {
  console.log(`${name}: ${formatCents(cents)} in the balance chain has no source document`);
}
console.log(`stale verdicts: ${staleVerdicts.length}`);

/*
 * PASS 73 — the printed market value against the app's own, on the same day.
 *
 * `portfolioSeries` is the app's OWN valuation — the one the value chart draws —
 * so a disagreement here is a disagreement a reader can already see, not a
 * second opinion invented by this checker. An account with no securities
 * anchors imported yet simply contributes nothing.
 */
const anchors: ValueAnchor[] = [];
/*
 * ⛔ The app values ACTIVE investment accounts only — `investmentAccounts` is the
 * rule `portfolioSeries` scopes by — and for any other it returns no points,
 * which reads exactly like a book that never held anything. Asking it about a
 * deactivated account and trusting the empty answer valued all 25 Robinhood
 * Brokerage statements at $0.00 (measured on a copy, 2026-09-15).
 */
const valuedByApp = new Set(investmentAccounts(db).map((a) => a.id));
for (const account of accounts.filter((a) => a.type === "investment")) {
  const derivedOn = statementDayValuation(
    valuedByApp.has(account.id) ? portfolioSeries(db, [account.id]) : null,
  );
  const periods = sqlite
    .prepare(
      `SELECT period_end e, ending_balance_cents c FROM statement_periods
        WHERE account_id = ? AND ending_balance_cents IS NOT NULL ORDER BY period_end`,
    )
    .all(account.id) as { e: string; c: number }[];
  for (const p of periods) {
    anchors.push({ account: account.name, on: p.e, printedCents: p.c, derivedCents: derivedOn(p.e) });
  }
}
const { drifts: valueAnchors, unpriced, valued: valuedAnchorDays } = findValueAnchorDrift(anchors);
console.log(
  `value anchors: ${anchors.length} checked · ${Object.values(valueAnchors).flat().length} disagree · ${unpriced.length} the app cannot value`,
);
for (const [name, list] of Object.entries(valueAnchors)) {
  for (const d of list) console.log(`  ${name} ${d.on}  off by ${formatCents(d.offByCents)}`);
}

const failures = compareToBaseline(
  {
    accounts: accounts.map((a) => a.name),
    chainWindows,
    breaks,
    syntheticNetCents,
    staleVerdicts,
    valuedAnchorDays,
    valueAnchors,
    // an anchor the app cannot value is a finding of its own — the rule makes it, once per statement
    unpricedAnchors: unpriced,
    gradedPeriods,
  },
  BASELINE,
);
if (failures.length > 0) {
  console.error(`\nLEDGER CHECK FAILED — ${failures.length} finding(s):`);
  console.error(formatLedgerFailures(failures));
  process.exit(1);
}
console.log("\nledger matches the recorded baseline, and no stored verdict has gone stale");
