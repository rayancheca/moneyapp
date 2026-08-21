# Handoff — 2026-08-21, passes 60–61 (+ the budget refactor)

> **`main` = `86eb030`**, tree clean.
> tsc clean · **168 files / 3,110 unit** (was 166 / 3,050) · coverage gate exit 0 ·
> `pnpm ledger-check` exit 0 · **E2E_GATE=1 e2e: 429 passed, zero baseline churn**.
> **Ledger: 0 gap days · 0 uncategorized · 59 `needs_review` · no account `broken`.**
> Net worth reads **$100,013.60** today — it moves daily with prices; the
> $101,594.99 in the pass-59 handoff was 2026-08-17's figure, not a discrepancy.
>
> Four real-DB writes, every one behind its own restore point and its own
> assertion that money could not have moved. All four proved it.

## 0. Read this first

**A plan's premise is a hypothesis, and this one was false.** Pass 60 was
scheduled as "cash income — the engine, plus an interactive classification pass
over the unclassified ATM rows". There are none. **Every ATM deposit in the
ledger is already classified, by hand, `source='user'`.** The sitting had no
input. Cash income is counted whenever it is banked and tagged — June 2026 booked
$1,447.00 of `Income > Salary` from two Miami deposits. The app is not blind to
cash; it is blind to **timing**.

**Measured, `2026-06-01 → 2026-08-21`:**

| | |
|---|---|
| implied by the confirmed schedule | **$12,552.00** over 12 pay periods |
| actually banked | **$1,447.00** |
| gap | **$11,105.00** |
| last banked | 2026-06-05 — **11 paydays** of silence |

The owner confirms the job is still running at ~$1,047/wk, so that gap is real
earnings that never touched a bank. $5,000 of it went to the car deposit via the
`Cash on Hand` anchor.

**A cached column that nothing revisits will eventually lie.**
`recurring_series.last_matched_on` froze whenever a series dropped below
`MIN_OCCURRENCES = 3` linked rows, because it was bundled into an all-or-nothing
early return with the *statistics*. It is not a statistic — it is
`max(posted_on)`, exact for one row and exact for none. Five series were
asserting dates with no row behind them, and unlinking **every** row left the
date stranded rather than clearing it. Same shape as pass 59's stored verdicts.

**Only real data found my own off-by-one.** `periodsSinceBanked` subtracted one
from the window, which is right only when a deposit lands exactly on a payday.
His landed Friday against a Thursday schedule. All 22 tests passed either way;
the probe against the live ledger reported 10 missed paydays where the truth was
11. Both sides are now pinned, because the two formulas agree on exactly one of
them and a single test would have been a coin flip.

**Mutation testing earned its keep four times.** Three mutants survived the first
round on `cash-earnings`, one on `section-notes`, one more on `income-budget`.
Two taught me the guarded code was genuinely **dead** (removed, not defended);
one taught me silence was being measured against the window instead of the
schedule; one was a `?? 0` that could never fire, removed by zipping two arrays
rather than satisfied by a test that would have lied about reaching it.

**I told the owner something false and he acted on it.** I said rollover would
stop the over-allocation warning. It does not — `/budgets` compares
`totalBudgetedCents` to `incomeExpectation` and `carryInto` touches neither.
Corrected in the commit and to his face before the write landed. §4.

## 1. Shipped

| # | commit | item |
|---|---|---|
| 1 | `bff665d` | `lib/cash-earnings` — earned vs banked, with a basis and a named remainder |
| 2 | `0b01d80` | the service, and an off-by-one only real data could find |
| 3 | `2fb4096` | `last_matched_on` is not a statistic — **REAL-DB WRITE** |
| 4 | `f83f928` | `/spending` says what the income figure cannot see |
| 5 | `a4e2052` | budgets sized from income, not from past spending |
| 6 | `17f8d35` | the income budgets applied — **REAL-DB WRITE** ×2 |
| 7 | `86eb030` | rollover on for nine discretionary budgets — **REAL-DB WRITE** |

Plus `dd7fb6c` / `b7e0fcc` / `23963a9`: the per-page inventory, the 35-session
program, and the plan ticked with the corrected premise.

### 1.1 `lib/cash-earnings` (`bff665d`)

Three numbers that refuse to collapse into one: what a **confirmed** schedule
implies, what actually reached a bank, and the difference — behind a `basis`
discriminant (`no-series` / `series-live` / `series-stale`) so a caller cannot
show the number without showing which world it lives in. Same doctrine as
`budgetVerdict`: the reading and the meaning of the reading come from one call.

⛔ A positive `unbankedCents` is **not** a claim the money exists. Three innocent
readings fit — held as cash, spent as cash, or the schedule has ended — and the
module names all three rather than choosing. `STALE_PERIODS = 3`, because banking
in lumps is his ordinary rhythm and one skipped week is not news.

Every date decision goes through `stepPlan`/`stepFrom`/`stepsToReach` (pass 54:
two functions that must agree about a date must not both compute it).

### 1.2 The service (`0b01d80`)

Reads the series' life from its **linked rows**, never from `last_matched_on` —
which is how §0's defect was found. Only **attributed** deposits count as
banked: a row must carry `recurring_series_id`, never merely look like a cash
deposit, or the 2026-07-21 pair totalling $6,900 (his mother's money) becomes
wages.

⚠️ Not to be confused with `lib/income-forecast`'s `projectOngoingIncome`, which
looks *forward* from trailing history. This looks *backward* from a confirmed
schedule. Merging them is a category error.

### 1.3 `last_matched_on` (`2fb4096`) — REAL-DB WRITE

Restore point `data/backups/pre-2026-08-21T1755-resettle-last-matched.db`.
Five series disagreed with their evidence; only one was live:

| series | status | stored → evidence |
|---|---|---|
| Cash job (weekly pay) | confirmed | 2026-07-06 → **2026-06-05** |
| Hoffman LL | ended | 2026-01-08 → 2025-06-02 |
| WALMART … DIVIDEND | dismissed | 2026-05-13 → 2026-05-14 |
| Rocket Money Premium | ended | 2026-01-15 → **null** |
| ZELLE … ENRIQUE | dismissed | 2026-05-12 → **null** |

Guards asserted a cache column moves no money: $100,013.60 → $100,013.60,
10,072 → 10,072 active rows, 0 still disagreeing. `cadence` and
`interval_days_avg` on the cash job untouched (weekly, 7.0) — the thin-evidence
guard doing exactly its job.

### 1.4 `/spending` (`f83f928`)

> "Cash job (weekly pay) implies **$5,230.00** of earnings in this period and
> none of it reached an account. Across the whole schedule, 11 expected paydays
> have passed since the last deposit on Fri, Jun 5, 2026 — that money was held as
> cash, spent as cash, or the schedule has ended. The income figures on this page
> count deposits, so they cannot tell you which."

Two rendering bugs the tests could not see: the never-paid branch produced
*"paydays have passed since no deposit has ever been attributed to it"*, and June
juxtaposed a **window** figure with a **schedule** figure ("$4,184.00 in this
period … 11 expected paydays" — June has four). "Across the whole schedule" now
marks the scope shift and a test pins the phrase.

### 1.5–1.7 The budget refactor

Owner: *"you have to use my salary as a base… i want to budget based on my income
and you know its 1047 a week."* The spend-based rule had produced eleven budgets
totalling **$7,575.00** against **$4,537.00** of monthly cash income.

**Income sets the SIZE; trailing spend only sets the SHAPE.** Both bases his,
chosen with the numbers in front of him: $1,047 × 52 ÷ 12 (not × 4, which is
eleven months of pay a year), and commitments funded exactly first with the
remainder split by each category's *uncommitted* median spend.

| | |
|---|---|
| income base | $4,537.00 |
| committed | $3,271.29 (**72%**) |
| left to split | $1,265.71 |
| total | $7,639.21 → **$4,506.29** |

Food $2,065.00 → $560.00. Rent and car funded to the cent.

**Adding Utilities exposed a defect in the trailing basis.** Its median over six
months is **$0.00** — he moved to Miami in June, so four months are structural
zeroes — which would have funded it at its $64.21 floor against $115.38 of real
usage, silently, forever. `typicalMonthlySpend` now takes the median of the
months a category *existed*. The Car is the control: every trailing month is a
genuine zero (lease starts 2026-09-11), so it keeps its honest $0.00.

## 2. ⛔ NEXT — the two things this session opened and did not close

- 🔴 **`/budgets` and `/spending` disagree about the same series.** Spending says
  the cash job has been silent 11 paydays and the money may not be coming;
  `incomeExpectation` projects $4,188.00 of August income from it. Both are
  internally defensible; together they are incoherent. The decision is whether a
  confirmed income series that has gone `series-stale` should keep feeding
  expected income — and it is the owner's, not the code's.
- 🔴 **The over-allocation header will swing by design.** `/budgets` reads
  "Budgeted $4,506.29 of $4,188.00 expected income". The budget base is
  annualised; the page grades against the paydays that fall in *this* month:

  | | |
  |---|---|
  | 4-payday month | income $4,188.00 → short $318.29 — **8 months a year** |
  | 5-payday month | income $5,235.00 → surplus $728.71 — **4 months a year** |
  | annual | income $54,444.00 vs budgets $54,075.48 |

  Both numbers are right. Options are to leave it, or to teach
  `incomeExpectation` an annualised basis for weekly series — which changes what
  a shipped, InfoTip-documented number means.

## 3. Still open

- **The $560.54 on 2026-07-29** — self-to-self, routing 021000021. Which account
  did it leave? Unchanged from pass 59.
- **Dad's remaining ~$5k** via Arno Search Capital LLC — family pass-through.
- **59 rows at `needs_review`** — the categoriser's low-confidence flags.
- **Statement uploads**: Robinhood July + August (two months behind, and the
  account with no arbiter), SoFi August.
- **Pass 61's note has no VISIBLE e2e state.** The simulator's cash series banks
  on time to `FAKE_TODAY`, so only the silent case renders — the same ruler-drawn
  blindness pass 53 found in the price fixtures. Seeding a schedule that goes
  quiet moves income totals across several baselines, so it is folded into
  **pass 75**'s state-coverage audit. The assertion the fixture *can* prove — that
  the note does not cry wolf on a current schedule — is in
  `zz-spending-drilldowns`, with the limitation written into the spec.

## 4. The correction, recorded

I told the owner rollover would stop the over-allocation warning appearing eight
months a year, and he instructed the change on that basis. **It does not.**
`carryInto` banks unspent budget from *closed* periods; the header compares
`totalBudgetedCents` to `incomeExpectation`. Corrected before the write landed.
Rollover is still worth having and was still applied — after Food fell to
$560.00 those categories will be lumpy — but for the real reason, not mine.

Nine ON (no contractual commitment inside them). Three OFF: Housing and Car **are**
their contracts, so planned surplus is $0.00 every month and a carry could only
be zero; Utilities is mostly committed and already under-funded.
`rolloverStartsOn = 2026-09-01` because `carryInto` has no notion of amount
history — unbounded it would grade July and August, lived under a $7,639.21
plan, against the $4,506.29 one that replaced them.

## 5. Notes for the next session

- ⚠️ **I used `cp` for a trial DB copy and it dropped the `-wal`** — the trial ran
  against a pre-apply snapshot and reported the old totals. Harmless here, but it
  is precisely the trap pass 44 recorded. **Use `.backup()`.**
- ⚠️ **The owner runs his own dev server on :3000.** `preview_start` fails with
  *"Another next dev server is already running"*. Do not kill it — `curl
  localhost:3000` reads the live app fine, and the Browser pane still renders
  blank for this app.
- **`macOS is case-insensitive`**: `docs/MASTER-PLAN.md` silently overwrote the
  historical `docs/master-plan.md`. Restored; the new program lives at
  `docs/program-passes-60-94.md`.
- `budgets` has **no** `rollover` column — it is `rollover_enabled` /
  `rollover_starts_on` / `rollover_cap_cents`. `transactions` has no
  `category_source` — it is `categorization_source`. `accounts` has no
  `archived_at`.
- `MIN_OCCURRENCES = 3`, and `analyzeGroup` returns null below it — which is why
  a two-row series never recomputes its statistics.
- **`data/` probes from this session** (gitignored): `probe-cash-earnings.ts`,
  `probe-income-exp.ts`, `probe-carry.ts`.
- The git-push workaround still required:

      git -c credential.helper='!gh auth git-credential' push origin main

## 6. The program

`docs/program-passes-60-94.md` — nine phases, ~35 sessions, decision layer first
and hosting last. Passes 60–61 are ticked and carry the corrected premise.
**Next scheduled: pass 62, the net-worth attribution bridge** (earned · spent ·
market · family · in-transit · **unexplained**, where unexplained must be zero on
a reconciled window). The two items in §2 are unscheduled and may outrank it —
they are the owner's call.
