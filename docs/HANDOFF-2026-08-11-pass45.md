# Handoff — 2026-08-11, pass 45

> **`main` = `32ccac5`, tree clean, EVERY GATE GREEN** — tsc clean · 151 files / 2,712 unit ·
> `next build` clean · **391/391 e2e**. Six shipped items, two migrations, four guarded real-DB
> writes.
>
> ⛔ **One decision waiting on the owner (§7), and one defect found but deliberately not fixed (§6).**

## 1. Gate

| gate | result |
|---|---|
| `tsc --noEmit` | clean |
| unit | **151 files / 2,712 tests** (2,699 at pass 44) |
| `next build` | clean |
| `E2E_GATE=1 pnpm e2e:fresh` | **391 passed, 0 failed** |

Restore points: `pre-0010-user-category-id.db`, `pre-0011-user-ends-on.db`,
`pre-car-down-payment-2026-08-11.db`, plus each script's own `pre-*` snapshot.

## 2. 🔴 THE LESSON: diagnose churn before you accept it

27 visual baselines were failing, and the obvious move — regenerate — would have been wrong for the
right-looking reason. A **budgets-only** change was moving a **holding** snapshot, which makes no
sense, so I went looking instead. Two distinct causes:

1. `5a3d5c1` added a **"Categories" nav item**, shifting the sidebar on *every* page. That is why
   `recurring`, `flow-spine`, `flow-tower`, `transactions-review` and `category` moved — and why it
   concentrated at 768/1024, the viewports where the nav renders as a list.
2. This pass's income card, which is why `budgets` moved at all four viewports.

Both intended, so regeneration was correct — but only after it was *explained*. I then **read the
regenerated baseline** rather than trusting the count, and it showed the nav item, the income card
and `e5bb8dd`'s coverage sentences all rendering correctly.

> **Regenerating a baseline you cannot explain converts a bug report into a bug.**

The same sweep caught `overflow.spec.ts:300` — a meta-test asserting every page in `src/app` is
measured. `5a3d5c1` shipped `/categories` and never added it. The guard worked; the route is now
swept at every viewport.

## 3. Shipped

### 3.1 Migration 0010 — `recurring_series.user_category_id` (`50295d4`)
Series→category was derived purely from POSTED transactions, so a commitment that had not charged
was invisible. **An OVERRIDE, not a union**: a series carrying it is removed from the posted-row
derivation, or it would answer to two categories and `budgetTail` would project the full amount into
each. Applied in the one shared bridge (`analytics.ts`) so the budget forecast and the category
drill-down cannot disagree.

Both car commitments registered. Verified: `Car` resolves 2 series, **`Transport` 0** (no leak), and
September/October tails are exactly **$921.38**.

### 3.2 Migration 0011 — `recurring_series.user_ends_on` (`160730c`)
A 24-payment lease is not "monthly forever". Verified by projecting to 2029: the lease yields
**exactly 24** occurrences and the insurance **exactly 5** (#2–#6; #1 was paid on the Venture X).
Null stays open-ended — correct for a subscription or a paycheque.

### 3.3 The income line on `/budgets` (`8e64933`)
**Budgeted $7,720.38 of $4,184.00 expected income — over-allocated by $3,536.38.**
Two bugs caught while verifying against the real ledger, both of which would have shipped a wrong
number: the window came from an *arbitrary* budget (the start-clamped Car budget, comparing a full
month of budgets against 3 weeks of income), and posted+future read **$3,138.00** because August
income is not imported — asserting a measured zero where "not measured yet" is true. Now takes the
max with a whole-period projection, mirroring `projectSpend`'s `max(spent, forecast)`.

### 3.4 The $105,000 projection (`ca3769c`)
The owner spotted it himself. `projectSpend` extrapolated his $5,000 down payment across 1 elapsed
day. Now a single charge **larger than the whole period's budget** is excluded from the RATE while
staying fully in `spentCents` — the row still reads $5,000 and `over`, which is what he asked for
(*"5k stays visible. its a payment i made"*). **$105,000 → $5,000.**

⚠️ A minimum-elapsed-days guard was tried first and **rejected by measurement**: by day 3 it still
extrapolated ~$28,000. The elapsed window was never the defect; treating an event as a rate was.

### 3.5 Overdue bills (`ae42a69`)
`budgetTail` only ever looked forward, so a bill that came due and never posted was in neither
`spentCents` nor the tail. **Housing read green with $2,109.00 left while rent of $2,285.70 had been
due since 2026-08-08.** `budgetOverdue` uses the SAME `alreadyPosted` rule as `recurringCalendar` so
the two surfaces cannot disagree, which is also what keeps it disjoint from spend.

Real ledger now: Housing **overdue $2,285.70 → pace at-risk**, plus Amazon Prime $4.99 and
UBER *ONE $4.99.

### 3.6 Gambling split out (`32ccac5`)
44 rows / **$1,445.10** moved out of `Games` into a top-level `Gambling`. Entertainment's 6-month
average drops **$290.19 → $123.09**.

## 4. Real-DB writes this pass
| write | verified |
|---|---|
| 2 car commitments registered | Sep/Oct tails $921.38 |
| end dates set on both | 24 and 5 occurrences exactly |
| 44 rows → `Gambling` | income $118,969.23 **identical** |
| migrations 0010 + 0011 | applied, columns present |

## 5. ⚠️ Found, NOT fixed: monthly series drift by day, not by month
`projectOccurrences` steps by `intervalDaysAvg` **days** (30), not calendar months. A bill pinned to
the 11th drifts ~1 day/month — the lease's 24th occurrence lands **2028-08-01**, not the 11th.
Harmless for the next few months; eventually it puts a payment in the wrong month. Fixing it changes
stepping for **every** series, which is not a late-session change.

## 6. ⚠️ Found, NOT fixed: `budgetOverdue` has no e2e coverage
It shipped with 3 unit tests and **zero** e2e, because the fixture world has no overdue bill in a
budgeted category — which is also why the 391 run showed no baseline churn for it. Add one to the
fixture, or the UI path can rot silently.

## 7. ⛔ OWNER DECISION WAITING: the gambling winnings

`Gambling` currently shows **GROSS staked**. To get the "net" half he asked for, the 7 winnings rows
(**$1,053.82**, currently `Income > Other Income`) must move into it — the same category then nets
them automatically.

**That is an INCOME change, not a categorisation one.** It drops his income total
$118,969.23 → **$117,915.41**. `docs/income-ground-truth.md` is hand-maintained and passes 15 and 28
both had to *un-contaminate* it.

There is a real argument that gambling winnings were never earned income and their presence there IS
the contamination — but with that history, it is his call with the number in front of him, not
something to slip into a categorisation pass. **Ask; do not assume.**

## 8. Queue

1. ⛔ **§7** — the winnings decision.
2. **Rollover, opt-in per budget** (his choice). Travel is the case: $8.75 Feb → $2,448.88 Jul
   against $50/mo.
3. **§6** — an overdue bill in the e2e fixture.
4. **§5** — calendar-month stepping.
5. **Re-set the wrong budgets from data.** Still stale: Travel $50 vs $600.65 actual, Fees $30 vs
   $102.86, Food $1,430 vs $1,990.88. Entertainment is now $60 vs $123.09 (was $290.19).
6. **Set `Transport` from data** once two Wells Fargo statements land — his ~$220/mo parking+gas
   estimate is ~5× the measured pre-car rate, which is plausible but unmeasured.
7. **Wells Fargo** — deferred until its first statement; ask for the **QFX**
   (`ofxProfile` already accepts `.qfx`, and it is the only export carrying a balance).
8. The pass-42 tail: the last $1,911.24, `ReturnViewParts.tsx:89`, `?range=`, `/flow` range, drawer.
9. ⛔ **Hosting LAST.**
