# Transaction splitting (pass 20)

RocketMoney-style splitting: re-attribute one transaction's amount across
several categories without touching the immutable ledger row. Flagship case —
Robert Cohn's +$2,500 = +$1,500 refund + +$1,000 bed-sale (same-sign, mixed
category).

## The model

- **`transaction_splits`** table (`db/schema/transaction-splits.ts`): one row per
  part — `(id, transactionId→transactions ON DELETE CASCADE, categoryId, amountCents,
  note, sortOrder)`. The parent ledger row is **never** mutated (amount/date/
  description stay the audit trail), so **net worth, dedupe, recurring detection,
  transfer pairing, and balance derivation are all untouched** — the parts sum to
  the parent, so `daily_balances` is identical whether or not a row is split.
- **Invariant** (enforced in `services/transaction-splits.ts` `setSplits`, atomic):
  parts sum EXACTLY to the parent amount, ≥2 parts, each non-zero, each the same
  sign as the parent, each categorized.
- **The parent stamp**: on split, the parent's `categoryId` is stamped with the
  **largest-magnitude spend/earn-kind part** (falling back to the largest overall
  only if no part is expense/income kind), plus `categorizationSource='user'`,
  `needsReview=false`. This keeps the parent a real, categorized, reviewed row for
  every raw-`categoryId` reader (coverage, the categorize pipelines, the
  `spending`/`income`/`uncategorized` StatCard drill-down filters) and avoids ever
  stamping a Transfers-kind primary. Analytics ignore the stamp — they read the
  parts.

## How analytics stay correct

`analytics.activeTxnsInRange` is the single leverage point: it **explodes** a
split transaction into one pseudo-row per part (each with its own
category/amount), so the per-row classifiers (`spendingBucket`/`isIncome`)
attribute each part independently. That fixes the whole shared aggregate stack
(spend/income totals, category breakdown, heatmap, period-activity, the exact
drill-downs, `categorySpending`, budgets) at once. The handful of read paths that
run their own query are made split-aware individually: `spendingRowsInRange`
(top-merchants / largest-purchases), `budgets.recurringPostedCents`,
`category-forecast.nonRecurringSubtreeSpend`, `forecast.nonRecurringAllocations`,
`spending/actions.hydrateRows` (part-aware drill-down), and the
`/transactions` category filter (`transactions-query.filterConditions`).

## Split ⇄ transfer: mutually exclusive

A split row can never also be transfer-linked (its parts would be stranded, and a
transfer is excluded from spend/income by category kind). Enforced in **both**
directions:

- `setSplits` refuses a transfer-linked parent.
- The transfer-setting paths refuse a split row: `detectTransfers` (auto-pairing
  skips split rows), `setTransactionFlags` (the sheet checkbox — throws),
  `bulkApply` (mark-transfer skips split rows), `linkTransferPair` (throws), and
  `applyUndoPatch` (never restores a transfer link onto a row that has since been
  split — a stale undo toast). The sheet also **disables** the Transfer checkbox
  and hides the transfer-link panel for a split row.

As defense-in-depth, the split-explosion read paths also require
`transferGroupId IS NULL`, so any legacy "both" state still can't leak parts into
spend/income.

## Re-import safety

A split parent can be superseded by a **format takeover** (a higher-fidelity
source replaces a lower one for the same day). The import handles this inline with
its DIRECT correspondence: right after inserting the replacement row it calls
`migrateSplits(victim → replacement)` (the two rows are the same real charge, so
the amount and the sum invariant are preserved), carrying the parent's stamp
forward. This covers both the freshly-inserted and the deduped branch.

## Undo

Every `setSplits`/`clearSplits` returns a `SplitSnapshot` capturing the prior
split rows AND the prior parent fields (`categoryId`, `categorizationSource`,
`categorizationConfidence`, `needsReview`). `restoreSplits` reinstates all of them
— a lossless undo, offered via the toast.

## Known limitations (accepted for v1)

- **Recurring series → category membership** (`recurringSeriesIdsForCategory`,
  `seriesIdsForSubtree`) keys on the parent's stamped category, NOT the split
  parts. So a recurring bill split across categories (rent+utilities) forecasts
  its future "expected tail" into its ONE representative category rather than
  double-counting the whole bill into each. Spend ACTUALS still follow the parts
  (`recurringPostedCents` is split-aware); only the forward tail is single-bucket.
- **Category edits on a split row are blocked at every reachable surface**: the
  ledger chip and the sheet's top picker are hidden (they show a "Split · N" chip /
  a note), and `bulkApply`'s category branch SKIPS split rows (so "Recategorize
  all N", select-all-matching, and cluster recategorize never desync a split row's
  stamp from its parts). Splits are edited only in the split editor.
- **Marking a row Transfer excludes it from spend only by category kind**, not the
  `transferGroupId` flag — a pre-existing behavior that applies to unsplit rows
  too; splitting does not change it.
- **Parser-version re-parse** (not a takeover) that also changes a row's extracted
  raw text can strand that row's split, because there is no direct old→new
  correspondence to migrate across (matching would need the same fuzzy
  description scoring the takeover path uses). Rare (a profile rewrite AND changed
  extraction AND a split on that exact row); the money is never affected.
- **Ancillary `txnCount`** in `monthlySpending` / `categoryBreakdown` /
  `incomeByMonth` counts one per split PART, so a transaction split into two parts
  of the *same* top-level bucket shows "2 transactions" for that bucket. The cents
  (`spentCents`) are always correct; `categorySpending().txnCount` (the figure the
  category pages headline) is deduped to distinct transactions.
- **Editing a split, then clicking a stale "Undo" toast mid-edit, then Save**
  re-applies the edited draft (the undo is superseded by the explicit Save). The
  result is the split the user last built — coherent and valid — so this is left
  as-is rather than blocking Save on a background reload.
