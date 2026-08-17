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
  type LedgerBaseline,
  type StaleVerdict,
  compareToBaseline,
  findChainBreaks,
  formatLedgerFailures,
} from "@/lib/ledger-integrity";
import { formatCents } from "@/lib/money";

/**
 * The ledger as of 2026-08-17, pass 59.
 *
 * Nine breaks, every one on Robinhood Cash, every one from 2025-11 onward —
 * the whole 2023-12 → 2025-10 history closes to the cent. They are three
 * different problems and are NOT interchangeable:
 *
 *   · three near-mirror month-boundary pairs (Nov/Dec, Jan/Feb, May/Jun) that
 *     look like settlement lag but leave 12c, 14c and 5c of residual, so
 *     timing alone does not explain them;
 *   · two one-cent breaks (Mar, Apr) which between them hold 59 days at `gap`;
 *   · July 2026, genuinely $3,811.52 short — real missing money, and the
 *     largest single unexplained figure in the ledger.
 *
 * Synthetic totals: Robinhood Cash is the crypto cash-leg mirrors written by
 * `pnpm rh-mirror-crypto-cash` (amount and date taken from the printed sweep
 * row, or from the crypto trade itself when the bank batched the sweep);
 * Chase Sapphire is the hand-entered card activity; Cash on Hand is the
 * -$5,000 car lease down payment. All three trace to a real record.
 */
const BASELINE: LedgerBaseline = {
  breaks: {
    "Robinhood Cash": [
      { from: "2025-10-31", to: "2025-11-30", offByCents: 1_979 },
      { from: "2025-11-30", to: "2025-12-31", offByCents: -1_991 },
      { from: "2025-12-31", to: "2026-01-31", offByCents: 987 },
      { from: "2026-01-31", to: "2026-02-28", offByCents: -1_001 },
      { from: "2026-02-28", to: "2026-03-31", offByCents: -1 },
      { from: "2026-03-31", to: "2026-04-30", offByCents: -1 },
      { from: "2026-04-30", to: "2026-05-31", offByCents: -10_003 },
      { from: "2026-05-31", to: "2026-06-30", offByCents: 9_998 },
      { from: "2026-06-30", to: "2026-07-31", offByCents: 381_152 },
    ],
  },
  syntheticNetCents: {
    "Robinhood Cash": -3_593_828,
    "Chase Sapphire": 968_091,
    "Cash on Hand": -500_000,
  },
};

const { sqlite } = createDatabase(process.env.MONEYAPP_DB_PATH ?? "data/moneyapp.db");

const accounts = sqlite
  .prepare(`SELECT id, name, type FROM accounts ORDER BY name`)
  .all() as { id: string; name: string; type: string }[];

const breaks: Record<string, ChainBreak[]> = {};
const syntheticNetCents: Record<string, number> = {};
const staleVerdicts: StaleVerdict[] = [];

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

const failures = compareToBaseline({ breaks, syntheticNetCents, staleVerdicts }, BASELINE);
if (failures.length > 0) {
  console.error(`\nLEDGER CHECK FAILED — ${failures.length} finding(s):`);
  console.error(formatLedgerFailures(failures));
  process.exit(1);
}
console.log("\nledger matches the recorded baseline, and no stored verdict has gone stale");
