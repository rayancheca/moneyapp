# Handoff — 2026-08-14, pass 52

> **`main` = `TBD`**, tree clean. tsc clean · **158 files / 2,878 unit** ·
> `pnpm test` coverage gate **exit 0** · `next build` clean · **full
> `E2E_GATE=1 pnpm e2e:fresh`: 410 passed** · **8 `dashboard-*` baselines regenerated,
> predicted and read back**.
>
> Owner dropped two statements mid-session and asked for a statement-pull
> reminder, on `/imports` and then on the dashboard. Both shipped. One of the two
> statements did not reconcile, and finding out why was most of the pass.

## 0. What this pass was

Not planned work — two files landed in `~/Downloads` and a feature request came
with them. The pass is worth reading anyway for §2: the trial import is the only
reason a silent parser regression did not reach the real ledger.

## 1. Gate

| gate | result |
|---|---|
| `tsc --noEmit` | clean |
| `pnpm test` (coverage) | **exit 0** — 158 files / 2,878 tests (156 / 2,840 at pass 51) |
| `next build` | clean |
| **`E2E_GATE=1 pnpm e2e:fresh`** | **410 passed / 0 failed** (408 at pass 51, +2 new specs) |
| visual baselines | **8 changed** — every `dashboard-*`, predicted before the run (§5) |

Mutation harnesses: **14 mutations, 14 caught** (`scratchpad/mutate2.py`), each
with a green BASELINE case through the identical path, applied-checks by
`filecmp`, exit codes from `subprocess.returncode`. Plus one e2e mutation
(month-end detection disabled → the schedule spec goes red on 5 rows).

## 2. 🔴 THE LESSON: a bank changing how it prints a number makes rows DISAPPEAR

The Discover statement quarantined 14 rows with a gap of exactly **$300.00**, and
Discover's coverage would have gone `verified → broken`.

**Capital One issues this card now**, and the August 2026 statement is the first
on their template. It prints a payment as `- $300.00` — minus, **space**, dollar
sign — where every earlier Discover statement printed `-$300.00`. `MONEY_RE`
required the minus to touch the `$`, so the token did not read as money, the row
had **no amount at all**, and it was skipped without a word.

| | ≤ Jul 2026 | Aug 2026 |
|---|---|---|
| payment token | `-$99.78` | **`- $300.00`** |
| description | `INTERNET PAYMENT - THANK YOU` | `INTERNET PAYMENT - THANKYOU` |
| description x | 80 | 74 |
| cycle close | the **2nd** | the **9th** |

> **Generalisation: a parser does not fail on a format change, it goes quiet. The
> only thing that noticed was the reconciliation, and the only reason it noticed
> before the real database did was `pnpm trial-import`.**

What identified it in a minute rather than an hour: the gap equalled
`07/23 Discover E-Payment 4741 −300.00` on the Chase checking statement imported
ten minutes earlier. **Two statements from different banks are a cross-check on
each other**, and this is the second time that has paid (pass 38 used the same
move on card payments).

Three habits that held, and should keep holding:
- the token positions were **probed off the real PDF** before any regex was
  touched (pass 47's rule), which is how the space was found rather than guessed;
- the same probe was run against **July, June and December** statements, which is
  what bounds the fix to the new template and proves no old period is affected;
- `parseAmountToCents` **throws** on the inner space, so widening the pattern
  alone would have swapped a silent drop for a hard parse failure.

## 3. Shipped: two statements

| file | account | period | result |
|---|---|---|---|
| `20260812-statements-3522-.pdf` | Chase Checking | 07-11 → **08-12** | 30 rows, **reconciled**, coverage → `verified 2026-08-12` |
| `Statement_082026_4741.pdf` | Discover | 07-03 → **08-09** | 15 rows, **reconciled**, coverage → `verified 2026-08-09` |

Net worth `$89,592.26 → $90,942.53`. Both archived byte-identically (verified
with `cmp`, not sha) and moved into their drop folders so
`pnpm backup:statements` mirrors them.

## 4. Shipped: the statement schedule

`src/lib/statement-cadence.ts` (new, under the 100%-branch gate) +
`src/services/statement-pulls.ts` + a panel on `/imports` + a teaser on the
dashboard. The cadence is **measured per account from its own close dates** —
nothing anywhere tells the app that a cycle is monthly.

### 4.1 What the real data forced

Three rhythms, and the first is the one a naive version gets wrong:

| rhythm | accounts | why it cannot be day-stepped |
|---|---|---|
| `month-end` | SoFi ×2, Robinhood Cash, Robinhood Crypto — **4 of 8** | the last day of a month is not "the 31st"; pass 51's calendar stepping is reused |
| `day-of-month` | Discover, Chase Sapphire (2nd), Venture X (14th), Chase Checking (11th) | Chase wanders the 10th–13th on business days |
| `every-n-days` | none live | a quarterly or annual statement should not be forced into a month |

Two exclusions, each with a test that fails without it:

- **Only the most recent 12 closes decide the rhythm.** Discover's 28 run back to
  2023-11-18, and it has billed on the **18th**, then the **2nd**, and now the
  **9th**. The median across all of them is **the 14th** — a day it has never once
  closed on — carrying a 13-day tolerance to span both clusters.
- **`not_applicable` periods are excluded.** That is what a Chase *Spending
  Report* parses into, and the ledger holds two. One downloaded today would move
  the Sapphire cycle off the 2nd and make an already-imported statement look
  outstanding.

The tolerance is the **trimmed** maximum deviation (drop the single worst) plus
one day of publishing slack. Untrimmed, Chase Sapphire's one stray close on the
10th would have held its reminder back eight days every month thereafter.

### 4.2 Where the words live

`rhythmPhrase`, `pullDemand` and `pullSentence` are all in `src/lib`, not in
either component, for the reason pass 50 established: **the e2e fixture renders
`On schedule` on all seven of its accounts**, so `due` and `behind` — the two
states the feature exists for — are unreachable from any Playwright run.
`src/lib/**` is what the 100%-branch gate covers. The components hold colours and
order only.

`pullSentence` is built **from** `pullDemand`, so the dashboard's short line and
the `/imports` row cannot word the same fact differently.

### 4.3 The dashboard teaser is present when satisfied

It renders an all-clear rather than disappearing, the contract `ToReviewCard`
already holds: a teaser that vanishes when satisfied cannot tell you it is
satisfied, and on a home screen the absence of a warning has to mean something.
It lists only accounts with a close already behind them.

`CoveragePanel` lost its `"the next statement is overdue"` clause in the same
commit. It fired off a flat 45-day rule, which is not a fact about any particular
account — a cycle that closes on the 2nd is 45 days quiet every month by
construction — and two panels asserting "overdue" against different definitions
is exactly the shape that lets them drift apart.

**Measured live:** Robinhood Crypto is one statement behind (closed Jun 30);
every other account is inside its cycle.

## 5. 🔴 The mutation harness caught two of MY OWN tests asserting nothing

12 of 14 first time. Both survivors were tests written specifically to cover the
guard they failed to cover:

- the *"a spending report is excluded"* test dated the report **older** than the
  newest statement, so it sat invisible behind a later close and the exclusion
  changed nothing;
- the *"an account with no statements is omitted"* test asserted `[]` against a
  seed that **creates zero accounts** (`seedDatabase` ships institutions, not
  accounts), so it was true no matter what the code did.

> **Writing a test in order to cover a guard is not evidence that it covers it.
> The only evidence is breaking the guard and watching the test go red.**

Both were rewritten to be decisive — the report dated after the last statement,
and two accounts so that one of them being dropped is observable — then re-run:
14/14.

## 6. Queue

1. **An anchor day-of-month for recurring series** (pass 51 §5, unchanged). One
   ISO date cannot express "the last day of the month", so a month-end bill
   anchors on the clamp and sits on the 28th. Bounded at 3 days, inside
   `toleranceDays`, no live series exposed. Needs a `recurring_series.anchor_day`
   column, not a smarter hop. ⚠️ **`statement-cadence.ts` solves the same problem
   the other way** — it has the whole close history, so it can detect `month-end`
   directly. That option is not available to `recurring.ts`, which stores one
   date; do not copy the approach across without noticing the difference.
2. **Re-set stale budgets from data**: Fees $30 vs $102.86 (⚠️ also measured
   −$499.00 across the Fees subtree lifetime — re-derive before trusting either),
   Food $1,430 vs $1,990.88, Entertainment $60 vs $123.09. **Needs an owner
   decision, not just a measurement.**
3. `budgetOverdue` has no staleness gate (`UBER *ONE`, dead 446 days, fabricates
   $4.99 on Travel).
4. **`HoldingRow.quotedOn` is still rendered nowhere per-row.**
5. **The negative branch of the `left to allocate` tip is unrendered by any test.**
6. ⛔ **Hosting LAST** — "the whole queue first".

### Smaller things this pass surfaced

- **Discover's cycle moved to the 9th.** The 12-close window needs a few months
  to swing, so expect one or two months of a slightly early "Ready to pull" on
  Discover. By design — the panel prints the day it inferred, so the prediction
  is checkable — but worth not re-diagnosing.
- **Robinhood Cash still reads `broken`** in coverage (unrelated, pre-existing).

## 7. Notes for the next session

- **Always `pnpm trial-import` first** (§2). It is the only thing between a
  silent parser regression and the real ledger, and it earned its keep again.
- **Statements from different banks cross-check each other.** A gap that equals a
  line on another account's statement names its own cause.
- **A test written to cover a guard is not evidence** (§5). Mutate it.
- **`section:has(heading)` matches ancestors too.** The dashboard teaser locator
  resolved to 2 elements because the activity hub is an outer `<section>`
  containing the same heading; `getByRole("region", { name })` resolves the
  landmark and only the landmark.
- Still true: `rm -rf .next` if `next build` hits `ENOTEMPTY` after a Playwright
  run; `--update-snapshots` will not refresh a baseline whose diff is inside the
  tolerance (use `=all` scoped with `-g`); don't run the gate while agents work.
