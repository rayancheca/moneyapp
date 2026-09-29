/**
 * Does the ledger still say what it said?
 *
 * Four things, none of which any existing arbiter asks:
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
 *   4. A WITNESS FLOOR — (1), (2), (3) and the pass-73 value anchors report
 *      only what DISAGREES, so a witness that agrees can leave without a word:
 *      un-importing a statement whose valuation agreed took "value anchors: 43
 *      checked" to 42 and exited 0. Each kind the check counts — value anchors,
 *      chain endpoints, chain windows, statement periods, accounts — has a
 *      high-water mark kept in the ledger itself (`ledger_witness_marks`), each
 *      witness keyed by its account's id. Fewer than the mark fails, and so
 *      does any witness the mark lists that is gone, whatever the count (a
 *      swap holds it; a raise would have erased what left); more, with none
 *      gone, raises the mark on its own, with no commit and no hand edit (the
 *      owner's rule, 2026-09-15). While one is gone, what arrives joins the
 *      mark beside it, so an arrival that leaves before the mark is lowered is
 *      named too. src/lib/witness-floor.ts.
 *
 * The rules live in src/lib/ledger-integrity.ts and src/lib/reconciliation.ts
 * and are unit-tested there; this file is the I/O around them.
 *
 * Exit 0 = the ledger matches BASELINE below, no verdict has gone stale, and no
 * witness kind is below its mark or missing a witness it lists.
 *
 *   pnpm ledger-check
 *
 * After a removal the OWNER APPROVED — never to quiet a failure nobody understands:
 *
 *   pnpm ledger-check --lower-marks=value-anchors            # dry run: prints what it would lower
 *   pnpm ledger-check --lower-marks=value-anchors --confirm  # lowers it to what is seen now
 */
import { createDatabase } from "@/db/client";
import type { AnchorSource } from "@/db/schema/balances";
import { keptOpeningOf, pickWinners, selectEndpoints } from "@/services/derivation";
import { RECONCILE_STATUSES, isVerdictStale, periodVerdict } from "@/lib/reconciliation";
import {
  type ChainBreak,
  type ChainWindow,
  type GradedPeriod,
  type LedgerBaseline,
  type LedgerObservation,
  type StaleVerdict,
  type ValueAnchor,
  compareToBaseline,
  findChainBreaks,
  findValueAnchorDrift,
  formatLedgerFailures,
  statementDayValuation,
} from "@/lib/ledger-integrity";
import { portfolioSeries, valuedInvestmentAccounts } from "@/services/portfolio";
import { formatCents } from "@/lib/money";
import { isRealDatabasePath } from "@/db/backup";
import { type LedgerCheckMode, WitnessFlagRefusal, compareToMarks, ledgerCheckMode, planLowering } from "@/lib/witness-floor";
import { readWitnessMarks, writeWitnessMarks } from "@/services/witness-marks";
import { filesWithoutPrintedLines } from "@/services/import/import-records";

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

/*
 * ⛔ Parsed before the database is opened, and anything unknown is refused: the
 * database comes from MONEYAPP_DB_PATH, so an ignored `--db=<copy>` would check
 * — and, on a first run or a rise, WRITE the marks of — the real ledger.
 */
const MODE: LedgerCheckMode = (() => {
  try {
    return ledgerCheckMode(process.argv.slice(2));
  } catch (error: unknown) {
    if (!(error instanceof WitnessFlagRefusal)) throw error;
    console.error(`REFUSED: ${error.message}`);
    process.exit(2);
  }
})();

const DB_PATH = process.env.MONEYAPP_DB_PATH ?? "data/moneyapp.db";
const { db, sqlite } = createDatabase(DB_PATH);

const accounts = sqlite
  .prepare(`SELECT id, name, type FROM accounts ORDER BY name`)
  .all() as { id: string; name: string; type: string }[];

const breaks: Record<string, ChainBreak[]> = {};
/** every window walked, closing or not — what tells a closed break from a vanished one */
const chainWindows: Record<string, ChainWindow[]> = {};
/** every endpoint the chain is measured from — a lone anchor bounds no window, and is one all the same */
const chainEndpoints: Record<string, string[]> = {};
const syntheticNetCents: Record<string, number> = {};
/** accounts whose balance stands only on the opening of a statement he un-imported (owner decision 20) — said, not counted */
const keptOpenings: Record<string, string> = {};
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
      .all(account.id) as { anchoredOn: string; balanceCents: number; source: AnchorSource }[];

    // ⛔ an opening kept from a statement he un-imported is no endpoint and no witness (`selectEndpoints`)
    const { endpoints } = selectEndpoints(pickWinners(anchors));
    const kept = keptOpeningOf(pickWinners(anchors));
    if (kept) keptOpenings[account.name] = kept.anchoredOn;
    chainEndpoints[account.name] = endpoints.map((e) => e.anchoredOn);
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
for (const [name, day] of Object.entries(keptOpenings)) {
  console.log(`${name}: stands only on the opening of a statement you un-imported (${day}) — unchecked, and no witness`);
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
 * ⛔ The app values ACTIVE investment accounts only — `valuedInvestmentAccounts` is the
 * rule a scoped `portfolioSeries` reads — and for any other it returns no points,
 * which reads exactly like a book that never held anything. Asking it about a
 * deactivated account and trusting the empty answer valued all 25 Robinhood
 * Brokerage statements at $0.00 (measured on a copy, 2026-09-15).
 */
// ⛔ EVERY valued book, his or not: the book paired with Robinhood Agentic is outside his returns, never unchecked
const valuedByApp = new Set(valuedInvestmentAccounts(db).map((a) => a.id));
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

/*
 * 5. IMPORT RECORDS — what each imported file prints (`import-records`). A migration creates the record tables empty,
 * so a ledger restored from a snapshot older than the records has the files and none of the records, and an un-import
 * then deletes what another file still prints. 🔴 This check printed the same on such a ledger as on a whole one, and
 * exited 0 (the review of uc/final-integrate, 2026-09-16). A restore from Settings records them again itself; any other
 * way back to an older ledger needs the three backfills, in this order.
 */
const unrecorded = filesWithoutPrintedLines(db);
const backfillable = unrecorded.filter((f) => f.backfillCanRead);
/*
 * 🔴 …and the files the backfills CANNOT read. This line counted only files at their profile's CURRENT version, so
 * the 34 live files at an older version were in neither the number nor the failure: no record of what they print, no
 * backfill that can make one, and nothing said (measured on a copy of the real ledger, 2026-09-22 — the Discover CSV
 * at v1 against a v2 profile, 30 Robinhood brokerage statements at v3 and 3 at v4 against v5; the check printed 0 and
 * exited 0). They are NAMED here, because naming them is all this check can honestly do: only a re-read of the file,
 * at the version the profile has now, records what it prints, and whether to re-read is the owner's call — it
 * re-derives the account's categories (`engineCategoryCarry`).
 */
const beyondBackfills = unrecorded.filter((f) => !f.backfillCanRead);
const named = (files: readonly { fileName: string }[]) =>
  `${files.slice(0, 3).map((f) => f.fileName).join(", ")}${files.length > 3 ? ", …" : ""}`;
console.log(
  `import records: ${unrecorded.length} parsed file(s) with no record of what they print` +
    ` — ${backfillable.length} the backfills can read, ${beyondBackfills.length} read at a version their profile has moved past`,
);
const recordFailures = [
  ...(backfillable.length === 0
    ? []
    : [
        `${backfillable.length} imported file(s) have no record of what they print (${named(backfillable)}) — a ledger older than its records. Before any un-import, run:\n` +
          "    pnpm tsx scripts/record-account-numbers.ts --db=<ledger> --confirm\n" +
          "    pnpm tsx scripts/record-statement-copies.ts --db=<ledger> --confirm\n" +
          "    pnpm tsx scripts/record-printed-lines.ts --db=<ledger> --confirm",
      ]),
];

/*
 * The files beyond the backfills are NAMED, not failed. ⛔ Nothing the owner can run today clears them: only a
 * deliberate re-upload records what such a file prints, and a re-read re-derives that account's categories
 * (`engineCategoryCarry` — re-reading the 33 Robinhood statements at v5 moved Agentic's +$26.64 leg to Internal
 * Transfer and took /summary's 2026 money-weighted return 33.87% → 33.81%). Failing on a state with no remedy would
 * mean a red check on every commit until he chooses, which trains the hook to be ignored — the thing pass 74 built
 * it to stop. So it warns, every run, until he answers the either/or in the handoff (§6A 26): re-upload the 34, or
 * keep them as a standing "do not un-import anything on these accounts".
 */
if (beyondBackfills.length > 0) {
  console.log(
    `  ⚠️ ${beyondBackfills.length} of them were read at a version their profile has moved past (${named(beyondBackfills)}) — ` +
      "the backfills read a file only at the version that imported it, so they cannot cover these. " +
      "Un-importing any file whose rows one of them also prints loses those rows. Only a deliberate re-upload records it.",
  );
}

const observation: LedgerObservation = {
  accounts: accounts.map((a) => a.name),
  // the witness floor keys by id, so a renamed account is the same account
  accountIds: Object.fromEntries(accounts.map((a) => [a.name, a.id])),
  chainEndpoints,
  chainWindows,
  breaks,
  syntheticNetCents,
  staleVerdicts,
  valuedAnchorDays,
  valueAnchors,
  // an anchor the app cannot value is a finding of its own — the rule makes it, once per statement
  unpricedAnchors: unpriced,
  gradedPeriods,
};

/*
 * 4. THE WITNESS FLOOR. The marks live in the database this run opened, so a
 * rehearsal on a copy raises the copy's marks and never the real ledger's, and a
 * restored snapshot brings back the marks it was taken with.
 */
const marks = readWitnessMarks(db);

if (MODE.mode === "lower") {
  const plan = planLowering(observation, marks, MODE.kinds);
  const lowering = Object.keys(plan.writes).length;
  console.log(`\nLOWER WITNESS MARKS — ${DB_PATH}${isRealDatabasePath(DB_PATH) ? " (the real ledger)" : ""}`);
  for (const line of plan.lines) console.log(`  ${line}`);
  if (!MODE.confirm) {
    console.log("\ndry run: nothing was written. Only for a removal the owner approved: the same command with --confirm");
    process.exit(0);
  }
  writeWitnessMarks(db, plan.writes);
  console.log(`\nlowered ${lowering} mark${lowering === 1 ? "" : "s"}; the next plain run checks against what is seen now`);
  process.exit(0);
}

const floor = compareToMarks(observation, marks);
// recorded for the first time, raised, or — a drop (fewer, or any witness it lists gone) — joined by what
// arrived, with what left kept in it until lowered. A drop with nothing new arrived writes nothing.
writeWitnessMarks(db, floor.writes);
console.log(floor.summary);

// the floor's findings come last, so every finding the check made before it prints where it always did
const failures = [...compareToBaseline(observation, BASELINE), ...floor.failures];
if (failures.length > 0 || recordFailures.length > 0) {
  console.error(`\nLEDGER CHECK FAILED — ${failures.length + recordFailures.length} finding(s):`);
  if (failures.length > 0) console.error(formatLedgerFailures(failures));
  for (const line of recordFailures) console.error(`  ${line}`);
  process.exit(1);
}
console.log("\nledger matches the recorded baseline, and no stored verdict has gone stale");
