# Item 13 — resolved (do NOT implement as written)

## The backlog said
> **[correctness] (S) Filter `upcomingOccurrences` and `forecast.fixedComponents` by `isSeriesActive`.**

## Verdict: CANCELLED as written. It would delete real income.

Measured with the exact constants (`recurring.ts:661` `INACTIVE_MISS_LIMIT = 1.5`; `:48`
weekly tolerance `2`), a weekly series goes inactive after **7 × 1.5 + 2 = 12.5 days**:

| Series | kind | stale | threshold | would suppress? |
|---|---|---|---|---|
| **Cash job (weekly pay) — $1,046/wk** | **income** | 22d | 12.5d | **YES** ⛔ |
| UBER *ONE — $4.99 | expense | 429d | 48.8d | yes |
| Rocket Money — $6.00 | expense | 70d | 49.0d | yes |
| Amazon Prime · Breezeline · FPL · rent | expense | 18–23d | 48.0d | no |

Suppressing **$1,046/week of live income** to remove **$10.99/cycle** of dead subscriptions is
net-negative by roughly 400×.

A coverage-relative variant was tried and **also fails**: the cash series' deposits land in Chase
Checking, whose coverage runs to today, so staleness-vs-coverage is still 22 days. Rejected.

## What the data actually shows

`Cash job (weekly pay)` is stored `cadence=weekly, interval_days_avg=7, confidence=1.0, confirmed`.
Its matched rows are not weekly:

| date | amount | description |
|---|---|---|
| 2026-07-06 | $150 | ATM CASH DEPOSIT |
| 2026-06-12 | $1,000 | ATM CASH DEPOSIT |
| 2026-06-11 | $730 | ATM CASH DEPOSIT |
| 2026-06-05 | $400 | ATM CASH DEPOSIT |
| 2026-06-04 | $1,047 | ATM CASH DEPOSIT |
| 2026-05-15 | $300 | ATM CASH DEPOSIT |
| 2026-05-12 | $100 | ATM CASH DEPOSIT |
| 2026-05-12 | $1,400 | ATM CASH DEPOSIT |

$5,127 over 55 days ≈ **$651/week actual**, against **$1,046/week projected**.

## Owner's answers (2026-07-28)

- **Is the cash job still going?** → *"Still working it."* The income is live; the gap is deposit
  and import lag, not cessation.
- **Do the deposits equal your pay?** → *"Mixed — some are pay, some aren't."*

## Therefore, two separate pieces of work

### 13a — CODE: make staleness visible, never decisive
Keep `detected|confirmed` series in `upcomingOccurrences` and `forecast.fixedComponents`. Do **not**
add an `isSeriesActive` filter. Instead carry the staleness forward and render it — "last seen 22
days ago" — so a projection running on old data says so. The genuine defect (three functions
disagreeing about liveness) is resolved by making all three agree on *disclosure*, not on exclusion.

Rationale: this app's whole doctrine is that it refuses to invent a slope and stamps the span `gap`
instead. Silently dropping a live income series is the same class of dishonesty the derivation layer
was built to prevent — and silently keeping it without a staleness note is the other half.

Note `UBER *ONE` (429 days stale, still advertising a "next expected" date at 100% confidence in
Suggestions) is handled by item 14, which fixes the read path — not by suppression here.

### 13b — DATA: the series over-captures  ✅ **DONE 2026-07-31**

> **Outcome, and it inverts this section's conclusion.** The owner ruled on all eight deposits
> individually. Only **two** — the Florida pair, $1,047 + $400 = **$1,447** — are cash-job pay. The
> other six left income: $1,500 (Phil repaying the $5,000 Zelled to him on 2025-06-25, already
> filed as `Loans`) → **Loans**; $1,000 (his girlfriend's cash to forward, send failed) → **Family
> pass-through**; $300 + $150 + $730 (his own cash, and one he does not recognise) → **Internal
> Transfer**. Income **$122,593.85 → $118,913.85** (−$3,680); Salary **$49,194.86 → $45,514.86**;
> balances and net worth provably unchanged.
>
> **The projection was NOT contaminated — this section's premise was wrong.** Asked what the job
> actually pays, the owner said: *"its 1046 a week for the past month or two i just havent been
> depositing it in the bank often ... i do get paid i just put it in the bank at random intervals
> and quantities."* So $1,046/wk is real EARNINGS. The deposits were never a measurement of pay;
> they are a lumpy, partial proxy for it, and reading a rate out of them — in either direction —
> was the mistake. The "~60% above what the deposits average" framing above therefore describes
> a gap between *earning* and *depositing*, not an error in the rate.
>
> $1,046/wk is now recorded as an explicit override (`recurring_series.user_amount_cents`,
> `user_cadence='weekly'`), which `effectiveSeries()` (recurring.ts:681) reads ahead of the
> detected value. Before this it survived only by luck: it is not the average of the series'
> members ($640.88), and it persisted purely because all eight rows were already
> `series_link_source='user'`, which makes detection skip the series entirely (recurring.ts:377).
>
> Two consequences to carry forward:
> 1. **Recorded `Salary` now UNDER-counts what he earns**, by design — it records what reached the
>    bank. Earnings and deposits are different quantities and the app should not be made to
>    reconcile them.
> 2. Verify that the recurring series' fixed occurrence and `projectOngoingIncome`'s trailing
>    `Salary` average are not both counting the same deposited cash. **Not yet checked.**
>
> Script: `clarify-atm-pay-split.cjs` (backup + preflight identity assertions + LIVE delta guards
> + `source='user'`). Backup at `data/backups/moneyapp.db.pre-13b.2026-07-31T15-18-42-698Z`.
> Verified by diffing the live DB against that backup: exactly 6 rows differ, only in
> `category_id` and `recurring_series_id`, per-account sums byte-identical.
>
> Still open: the **$3,500 Phil Zelled him** is not missing, just **not imported** — Chase Checking
> coverage ends 2026-07-10 and that landed around 07-17→07-24. And a separate **−$1,495 Zelle to
> Philipe on 2026-05-29** is already filed as `Loans`, so there may be a second loan outstanding.

#### Original analysis (kept — the reasoning that led here)
It matches every `ATM CASH DEPOSIT`, but only some are pay. The $1,046 average is contaminated by
gifts, reimbursements and sales, which is why the projection sits ~60% above what the deposits
average. This is a guarded real-DB clarification pass in the style of pass 24 (backup + dry-run +
delta-guards + `source='user'`), **not** a code change. Until it is done, treat the cash-income
projection as an upper bound.
