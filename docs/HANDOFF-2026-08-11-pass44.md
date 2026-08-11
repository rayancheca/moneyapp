# Handoff — 2026-08-11, pass 44

> **The car is now in the ledger, and the review queue is nearly empty.** This pass ran alongside a
> SECOND Claude session working the same repo — read §2 before trusting any date-sensitive claim in
> a 2026-08-11 document, including this one.
>
> Real-DB writes this pass: **13 transfer pairs linked**, **1 budget created**, **1 anchor rewritten**,
> **1 manual transaction inserted**. Every one guarded, dry-run first, and verified after.
>
> ⛔ **NEXT: `recurring_series.category_id`.** Until it exists the $559.89 lease is *unrepresentable* —
> and that is now the only thing standing between the owner and a working car budget. §6.

## 1. Repo state

`main` = `1e97237`, pushed, tree clean.

| gate | result |
|---|---|
| `tsc --noEmit` | clean |
| unit | **151 files / 2,699 tests** |
| e2e | not re-run this pass — no UI change of mine; the last full green was `386/386` at `33190c3` |

Restore points: `data/backups/pre-car-down-payment-2026-08-11.db`,
`pre-car-category-move-2026-08-11.db`, `pre-2026-08-11T125259-pair-sofi-robinhood-transfers.db`.

Net worth **$91,392.26 → $89,592.26** (see §4 — it is a correction, not a loss).

---

## 2. 🔴 THE LESSON: with two sessions live, "I checked and it's there" proves nothing

Two Claude sessions edited this repo simultaneously today. The interleaving on `main` is real:
`5a3d5c1` (other) → `cff6eaa` (mine) → `e5bb8dd` (other) → `3dbf3d6`, `899f0c3`, `1e97237` (mine).

**It produced a wrong claim in a shipped document, and I was the one who shipped it.** An adversarial
review agent reported that no category-creation path existed — only `db/seed.ts` ever inserted a
category. I measured afterwards, found `createCategory` at `category-edit.ts:78`, and wrote
"**refuted**" into the handoff and a commit message.

The agent was **right when it ran**. The other session added `createCategory` in `5a3d5c1` at
**12:23**, between the agent's read and mine — about three minutes.

> **The rule: re-measurement beats quotation, but only if you also DATE it.** In a shared tree,
> `git log --since` is part of verifying a claim. "It's there now" does not refute "it wasn't there"
> until you check when it arrived.

Two more artefacts of the collision, both harmless but worth knowing:
- The other session's `git add -A` swept two of my uncommitted docs into `e5bb8dd`. **Stage explicitly
  in a shared tree.**
- It briefly believed the `Car` rows had vanished. They had not — it had `cp`'d a live SQLite DB
  without its `-wal` (65,952 uncheckpointed bytes). ⚠️ **`cp` on a live SQLite file silently drops
  recent writes; use `.backup` or `VACUUM INTO`.** (This is why every backup in this pass used
  `.backup`.)

**I was also wrong about `moveCategory`.** I guessed `IMPORT_HINT_ROOTS` was blocking the reparent.
It is not — `Transport` is not in that set (it holds `Income`, `Cash & ATM`, `Fees`, `Investments`).
It threw because **the category schema is deliberately ONE LEVEL DEEP**, so `Transport > Car >
{Car Payment, Car Insurance}` is structurally impossible. No carve-out will make it work.

---

## 3. The car — locked numbers

⚠️ **$369.00, $928.89 and $1,392.20 are SUPERSEDED.** The two sessions were given different figures;
the owner confirmed **$361.49** when the conflict was put to him directly.

| | |
|---|---|
| lease | **$559.89** on the **11th**, first payment **2026-09-11**, from **Wells Fargo** |
| term | 24 payments → last **2028-08-11** ($13,437.36) |
| down payment | **$5,000.00 cash, 2026-08-11** ✅ recorded (§4) |
| insurance | **$361.49/mo**, **6 payments 2026-08-11 → 2027-01-11** ($2,168.94) |
| insurance #1 | **already paid 2026-08-11 on VENTURE X** |
| insurance #2–6 | **Wells Fargo**, Sep → Jan |
| after Jan 2027 | ⚠️ **UNKNOWN.** "~20% lower" is his guess — his word was *"hopefully"*. Store `estimated` or not at all. |
| fixed commitment | **$921.38/mo** (Sep 2026 → Jan 2027) |

**Category: top-level `Car` → `Car Payment`, `Car Insurance`** (owner's choice, and the only possible
one — §2). **`Car` budget = $921.38/mo** ✅ created (`019ff1c6-7893…`, monthly, from 2026-08-11).
**`Transport` stays $520** for Uber/transit/gas/parking.

His reasoning is worth keeping: *a fixed lease and variable getting-around spend are different
questions; merging them means the budget answers neither.*

---

## 4. The $5,000 down payment — and why it was an INCOME question

The owner: *"no more cash after i give the 5k"* and *"1800 i had and ive been saving the cash from
getting paid from work."* So the safe held exactly **$5,000** and is empty — but the ledger had only
ever recorded **$1,800**.

**The other $3,200 is cash pay he earned and never deposited, which no statement has ever seen.**
That is what made zeroing the wallet a decision rather than an edit, and it was put to him:

- **(a)** record the $3,200 as previously-unrecorded income, then book −$5,000
- **(b)** ✅ **CHOSEN** — treat the safe as an untracked float: correct the opening figure, book the
  payment, leave income alone

So `scripts/record-car-down-payment.ts` deliberately creates **no income row**.
**Verified: income totals $118,969.23 before and after, identical.** $3,200 of real earnings stays
invisible to income, and that is the owner's explicit choice — not an oversight.

**Mechanism:** `setCashWalletOpening` rewrites the **existing** 2026-08-03 anchor. It must not add a
second one — `cash-wallets.ts:113-122` explains why: two unequal chain-grade anchors with no
transactions between them turn every day in the span to `basis='gap'`, dropping them from the chart,
the latest balance and net-worth coverage. Not wrapped in a transaction, because the pre-mutation
restore point VACUUMs and that throws inside one.

⚠️ **Honest limitation:** raising the 08-03 anchor asserts the safe held $5,000 from the 3rd, when he
was in fact still accumulating through the 10th. At most **$3,200 overstated across 8 days**. The
alternative is worse. Documented in the script's own header.

Result: wallet **$1,800 → $0**, net worth **$91,392.26 → $89,592.26** (+$3,200 correction,
−$5,000 payment).

⚠️ **Watch:** August's `Car` budget now shows a $5,000 one-off against a $921.38 monthly limit —
~542% used. That is *honest* (he did spend it), but it is exactly the missing **one-off / sinking
fund** concept. Do not "fix" it by hiding the row.

---

## 5. The review queue — 28 rows → 4

The owner described the route: *"this is just me transfering from sofi saving into robinhood but it
goes sofi saving into sofi checking then into robinhood."* The reviewed rows are the **second hop**.

15 SoFi outflows (−$17,800) + 13 Robinhood inflows (+$17,500) → **13 pairs linked**, lag 0–5 days,
with Robinhood usually crediting **before** SoFi debits (the pass-19 float direction, so the matcher
must not assume the outflow lands first).

🔴 **The category was NOT hand-picked, and that mattered.** Both accounts are `checking`, so
"Internal Transfer" looks obviously right — and is wrong. `transferCategoryResolver`
(`transfer-links.ts:59-80`) deliberately treats the Robinhood settlement-cash sibling as
**investment-SIDE**, so the pair resolves to `Transfers > Investment Contribution`. That is what the
SoFi legs already said and what the Robinhood legs (`Internal Transfer`) did not. Letting the shipped
resolver decide keeps a manual mark identical to what the detector stamps on every future import.

Net worth unchanged by the pairing ($91,392.26 → $91,392.26) — a pairing moves no money.

⏸️ **Left in review on purpose, not force-fitted:** 2 SoFi legs (2025-03-09 −$100, 2025-04-16 −$200 —
exactly the $300 difference) and 2 Robinhood `ACH Deposit` rows (+$187.22).

---

## 6. ⛔ NEXT: `recurring_series.category_id`

**This is now the only thing blocking a working car budget**, and it is a small migration.

`recurringSeriesIdsForCategory` (`analytics.ts:100-120`) resolves series→category **only through
posted transactions**:

```sql
selectDistinct(transactions.recurringSeriesId) … where categoryId in subtree
```

A commitment with **no posted rows has no category**, so `budgetTail` (`budgets.ts:361`) can never
project it. Measured: `Transport` has **0** linked series today.

**Consequence for the car:** the lease does not post until Wells Fargo's first statement, so until
this column exists, the `Car` budget will read "no data" every month and the $559.89 will be
invisible — while he is paying it. Every "just enter the lease as a recurring series" plan is
**inert** without this.

⚠️ Design note from the review: make `recurring_series.category_id` an **override, not a union** —
a union would double-count against the posted-row path once the real rows arrive.

### Then, in order
1. **Register the lease + insurance as recurring series** bound to Wells Fargo (after the account
   exists — §7).
2. **A one-off / sinking-fund concept** — the $5,000 case above, and it is what rollover needs.
3. **Rollover, opt-in per budget** (owner's choice). Travel is the case: $8.75 in Feb, $2,448.88 in
   Jul, against $50/mo.
4. **The income line on `/budgets`** — budgeted **$6,799 + $921.38 = $7,720.38/mo** against ~$4,184
   expected. Nothing on the page says so.
5. **Overdue bills** — `recurringCalendar` already returns `missedCount 4` (rent $2,285.70 due
   2026-08-08 never posted), and `/budgets` shows Housing green. `budgetTail` anchors at
   `addDays(today,1)` and never looks backwards.
6. **Gambling → its own category**, gross-staked + net-result (owner's choice). Today stakes hit an
   expense category while payouts land in `Income > Other Income`, so it grades GROSS — ~$1,148 of
   phantom overspend on a roughly break-even activity.

---

## 7. Wells Fargo — deferred, deliberately

**Do not create the account yet.** The previous session's reasoning is sound and I have adopted it:
an account with no statement reads **permanently unverified** on every coverage surface. The lease
does not debit until **2026-09-11**, so there is no rush.

- **Specimen data: ⛔ FIXTURE ONLY** (owner's decision). Nothing fabricated may enter
  `data/moneyapp.db`. Build against `data/e2e-originals/` + the fixture world, rehearse with
  `pnpm trial-import` against `.trial/trial.db`.
- **Formats WF actually offers** (researched): **CSV, QFX, QBO/OFX, and PDF statements**; 90 days by
  default, up to 18 months.
- ⭐ **Ask him for the QFX.** `ofxProfile` already accepts `.qfx` (`ofx-profile.ts:23`) and the
  sniffer maps the extension (`sniff.ts:11`), so it needs **almost no new code** — and it is the only
  export carrying a balance, which is what gives the account an anchor. The CSV alone can never
  reconcile.
- ⚠️ The previous session found **public sources contradict each other** on the WF CSV layout. Do not
  write `requireHeader` from a guess — wait for a real file.

---

## 8. The rest of the queue

1. **The last $1,911.24 on Robinhood Cash** — 74% is 2025-10; the rest is four adjacent cancelling
   pairs down to 1¢. Suspect the **65 hand-entered rows**, NOT the crypto export.
   (`docs/HANDOFF-2026-08-06-pass42.md` §5.)
2. **All-time stats under the windowed chart** — `ReturnViewParts.tsx:89` computes best/worst day and
   max drawdown over the FULL series while the chart shows a slice. ⚠️ `dailyReturns()` starts at
   `i=1`, so the slice must include one day BEFORE the window start.
3. **Wire `/investments` panels to `?range=`.**
4. **`/flow` range** — `flow/page.tsx:44` hardcodes `2000-01-01` while `transfer-flow.ts:145` already
   honours a range. Cheapest win left.
5. **Transaction drawer + `/transactions` breadcrumb + name the filter chips.**
6. **Robinhood crypto export.** ⛔ Do NOT delete the $3,579.67 plug first.
7. ⛔ **Hosting LAST** — standing instruction: the whole queue first.

## 9. Open questions

1. **Insurance after 2027-01-11** — he has not been told the renewal rate. Ask before storing
   anything; the ~20% drop is a hope, not a number.
2. **The 4 rows still in review** (§5) — the 2 orphan SoFi legs and the 2 Robinhood ACH deposits.
3. **Does he want the $5,000 excluded from August's `Car` budget** once a one-off concept exists, or
   left visible as a 542% month?

---

# PASS 44b — the migration, the income line, and a RED gate on `main`

`main` = `8e64933`. **⛔ Read §R first: e2e is red, and it is not from this work.**

## R. ⛔ `main` HAS A RED E2E GATE — inherited, precisely located

`E2E_GATE=1 pnpm e2e:fresh` → **357 passed, several failed**, including
`e2e/zz-budgets.spec.ts:22` and a set of `visual.spec.ts` snapshots.

**Cause: commit `e5bb8dd`** (the concurrent session's budgets-coverage work), which added to
`BudgetRow.tsx`:

```ts
const undermeasured = status.uncoveredDays > 0 && status.pace !== "over";
```

and renders `coverageSentence(status)` in place of `paceSentence(status)` when true. So
**"On track" / "Off pace" no longer render for any budget with unaccounted days** — which
`zz-budgets.spec.ts:34-36` asserts must be visible.

That session shipped it having run **unit tests only** (`2699/2699`); it never ran e2e.

**Proof it is not the income line (this pass):** the new card only ADDS a `SurfaceCard` above the
sections — it cannot remove verdict text. The failing assertions are on strings that `e5bb8dd`
gated away.

**The fix is to update the TEST, not revert the behaviour** — the new behaviour is correct and is
the whole point of `e5bb8dd`. The test should assert a *covered* budget shows a verdict and an
*uncovered* one shows the coverage sentence. ⚠️ Check first whether the fixture world contains any
budget with covered days; if not, the fixture needs one, or the assertion cannot exist.

The `visual.spec.ts` snapshots need regenerating for **both** `e5bb8dd`'s row change and this pass's
new card. ⚠️ Do not regenerate blind — confirm each diff is the intended change first.

## S. Shipped this pass

### S.1 `recurring_series.user_category_id` — migration 0010 (`50295d4`)

The blocker named in §6 is gone. `recurringSeriesIdsForCategory` derived a series' category purely
from POSTED transactions, so a commitment that has not charged could never be projected — measured
before: **Transport had 0 linked series**, and so did every category the car touches.

**An OVERRIDE, not a union**, and that is the design. A series carrying `user_category_id` is
REMOVED from the posted-row derivation; otherwise one with rows under category A and an override
pointing at B would answer to both and `budgetTail` would project the full amount into each. Three
tests pin it: maps a never-posted commitment, leaves its posted-row category when overridden, hands
itself back when cleared.

Applied in the one shared bridge (`analytics.ts`) rather than in `budgetTail`, because that bridge
also feeds the category page's series list — fixing it lower would let the forecast and the
drill-down disagree.

**Both car commitments registered** (`scripts/register-car-commitments.ts`), `accountId` NULL on
purpose (Wells Fargo has no row yet, by design). Verified end to end on the real DB:

| refDate | window | tail |
|---|---|---|
| 2026-08-11 | Aug 11–31 | $0.00 — correct, both next charges are 2026-09-11 |
| 2026-09-01 | Sep 1–30 | **$921.38** = $559.89 + $361.49 |
| 2026-10-01 | Oct 1–31 | **$921.38** |

`Car` resolves 2 series, `Car Payment` 1, `Car Insurance` 1, **`Transport` 0** — the override does
not leak.

### S.2 The income line on `/budgets` (`8e64933`)

Now reads: **Budgeted $7,720.38 of $4,184.00 expected income — OVER-ALLOCATED by $3,536.38.**

`incomeExpectation()` is built like `budgetTail` (posted over `[start, today]` + projections
strictly after, disjoint by construction). Series-driven, not a trailing average: his income is a
cash job deposited IRREGULARLY, so the series is the stated fact and the deposits are its noisy
shadow.

**Two bugs caught while verifying against the real ledger — both would have shipped a wrong number:**
1. The window came from `monthly[0].bounds`, an **arbitrary** budget. The Car budget is start-clamped
   to 2026-08-11, so it compared a full month of budgeted amounts against 3 weeks of income. Now uses
   `periodBounds(today, "monthly")`.
2. posted+future alone read **$3,138.00**, because August income is not imported and `$0.00 posted`
   silently dropped paydays that already happened — asserting a measured zero where "not measured
   yet" is true, the *same failure* `e5bb8dd` fixed for spending. Now takes the max with a
   whole-period series projection (mirroring `projectSpend`'s `max(spent, forecast)`), giving
   **$4,184.00** — matching an independent measurement of the confirmed weekly series.

## T. ⚠️ NEW FINDING: the one-off breaks the run-rate projection

August's `Car` budget projects **$105,000.00**, pace `over`.

`projectSpend` (`budgets.ts:320-328`) extrapolates `variablePosted × remainingDays / elapsedDays`.
With the $5,000 down payment on day 1 of a 21-day window: $5,000 × 20 ÷ 1 = $100,000, plus the
$5,000 spent.

**The verdict (`over`) is TRUE** — he did blow the Car budget in August. Only the number is absurd.

I deliberately did **not** patch this. A minimum-elapsed-days guard was the obvious fix and it does
not work: by day 3 it still extrapolates ~$28,000. The real defect is that **a one-off event is
being treated as a rate**, which is the sinking-fund gap already open for the owner's decision. A
threshold would only hide day 1 while leaving the wrong model in place.

Related and still open: the schema has **no end date for a series** (only `status`), so the lease
projects past 2028-08-11 and the insurance past 2027-01-11. Harmless inside a monthly budget
(`budgetTail` stops at `periodEnd`), wrong for any long-range forecast.

## U. Gate

| gate | result |
|---|---|
| `tsc --noEmit` | clean |
| unit | **151 files / 2,705 tests** (2,699 → +3 bridge, +3 income) |
| `next build` | clean |
| e2e | ⛔ **RED — inherited from `e5bb8dd`, see §R** |

## V. Queue

1. ⛔ **Fix the red e2e** (§R) — test update, not a revert. Do this first.
2. **One-off / sinking fund** (§T) — also fixes the $105,000 projection and needs the owner's call on
   whether the $5,000 stays visible in August.
3. **Series end dates** (§T) — `ends_on`, so a 24-payment lease stops projecting.
4. **Overdue bills on `/budgets`** — `recurringCalendar` already returns `missedCount 4` (rent
   $2,285.70 due 2026-08-08, never posted) while Housing shows green. `budgetTail` anchors at
   `addDays(today,1)` and never looks backwards.
5. **Rollover, opt-in per budget** (owner's choice). Travel is the case: $8.75 Feb → $2,448.88 Jul
   against $50/mo.
6. **Gambling → own category**, gross + net (owner's choice).
7. **Wells Fargo** — still deferred until its first statement; ask for the **QFX**.
8. Then the pass-42 tail: the last $1,911.24, `ReturnViewParts.tsx:89`, `?range=` on `/investments`,
   `/flow` range, the transaction drawer.
9. ⛔ **Hosting LAST.**

---

# PASS 44c — e2e fixed; two owner decisions

`main` = `c7a355e`.

## W. ✅ The red gate is fixed (`c7a355e`)

`zz-budgets.spec.ts` **7/7 green**; suite **357 → 360 passed**. `e5bb8dd`'s behaviour was correct —
the *test* asserted the old contract. It now asserts the real one, and gives `e5bb8dd` the e2e
coverage it never had: `Over budget` still speaks (pace `over` is exempt), unaccounted days are
reported, and `On track` / `Off pace` appear **zero** times. Two more tests pin that a verdict and a
coverage note are mutually exclusive per row, and cover the new income header.

⚠️ **STILL RED: `visual.spec.ts` snapshots only.** Failures include `category dark @1024`,
`holding light/dark @768/@1024` — pages I did **not** touch. Do NOT regenerate blind: a budgets-only
change should not move a *holding* snapshot, so find out why before accepting them. Suspect
`e5bb8dd`'s `BudgetRow` change reaching the category page's budget reference, or a shared
`SurfaceCard` metric. This is the next task after reading this.

## X. ⭐ OWNER DECISION: the $5,000 STAYS VISIBLE

> *"5k stays visible. its a payment i made"*

So August's `Car` budget showing ~542% used is **correct and stays**. Do not add a one-off exclusion
that hides it, and do not net it out of the category. It was money he spent, on the day he spent it.

⚠️ This does **not** dissolve §T. The $105,000 *projection* is still wrong and he called it out
himself (§Y). Hiding the row was never the fix; fixing the run-rate is.

## Y. ⭐ OWNER on the $105,000, and the true all-in figure

> *"car shouldnt be 105k. im paying 550 a month plus 365 for insurance plus 120 parking and 100 gas
> so around 1200 (these are estimates you already know the exact amounts) for two years is 24k but
> insurance will go down so lets say 21k around there"*

He is confirming the §T defect from the outside, and giving the shape of the real number:

| | his estimate | exact, from §3 |
|---|---|---|
| lease | ~$550 | **$559.89** |
| insurance | ~$365 | **$361.49** (→ unknown after 2027-01-11) |
| parking | ~$120 | *not yet measured — Parking & Tolls averaged $11.12/mo BEFORE the car* |
| gas | ~$100 | *not yet measured — Gas averaged $36.84/mo BEFORE the car* |
| **all-in/mo** | **~$1,200** | ~$921.38 contractual + fuel/parking |
| **24-month total** | **~$21–24k** | $18,437.36 lease + insurance + running costs |

**Two things follow, and neither is a licence to invent numbers:**
1. **`Car` ($921.38) is only the contractual half.** Parking and gas live under `Transport`, and his
   ~$220/mo estimate for them is **~5× the measured pre-car rate**. That is entirely plausible — he
   did not drive before — but it is an ESTIMATE. Do not write it into a budget as fact. Watch the
   first two Wells Fargo statements, then set it from data.
2. **The $105,000 projection must be fixed** (§T). He should never see it again. The defect is that
   `projectSpend` treats a one-off as a rate; since the $5,000 now stays visible by decision (§X),
   the projection is the ONLY thing left to fix. A minimum-elapsed-days guard does **not** work —
   measured: by day 3 it still extrapolates ~$28,000.

**Suggested direction, unverified:** exclude from the run-rate any single transaction that exceeds
the whole period's budget — it is definitionally not a rate. Keep it in `spentCents` (so the row
still reads 542% and `over`), just not in the extrapolation. ⚠️ Measure against all 11 budgets before
shipping; `projectSpend` is shared.

## Z. Queue

1. ⛔ **Why do `holding` / `category` visual snapshots move on a budgets change?** (§W) — diagnose
   before regenerating.
2. ⛔ **Fix the run-rate one-off** (§Y.2). The $5,000 stays; the $105,000 goes.
3. **Series end dates** — the lease projects past 2028-08-11, the insurance past 2027-01-11.
4. **Overdue bills on `/budgets`** — `recurringCalendar` returns `missedCount 4` (rent $2,285.70 due
   2026-08-08) while Housing shows green.
5. **Set `Transport` from data** once two Wells Fargo statements land (§Y.1) — not from the estimate.
6. **Rollover, opt-in per budget.** **Gambling → own category**, gross + net.
7. **Wells Fargo** — deferred until its first statement; ask for the **QFX**.
8. The pass-42 tail: the last $1,911.24, `ReturnViewParts.tsx:89`, `?range=`, `/flow` range, drawer.
9. ⛔ **Hosting LAST.**
