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

### 13b — DATA: the series over-captures
It matches every `ATM CASH DEPOSIT`, but only some are pay. The $1,046 average is contaminated by
gifts, reimbursements and sales, which is why the projection sits ~60% above what the deposits
average. This is a guarded real-DB clarification pass in the style of pass 24 (backup + dry-run +
delta-guards + `source='user'`), **not** a code change. Until it is done, treat the cash-income
projection as an upper bound.
