# Handoff — 2026-08-14, pass 54

> **`main` = `afb5002`**, tree clean. tsc clean · **159 files / 2,928 unit** ·
> `pnpm test` coverage gate **exit 0** · `next build` clean · **`E2E_GATE=1`
> full run: 410 passed**, zero baseline churn across all three commits.
>
> Same session as pass 53 — the owner asked to stop starting new ones. Three
> queue items closed: the anchor day-of-month (queued since pass 51), the
> `budgetOverdue` staleness gate, and two "a claim nobody checks" cleanups.

## 0. Working agreement changed

The owner asked to **keep working in one session to ~80% of the context window**
rather than one pass per session, and to get **one handoff at the end** rather
than one per item:

> *"im tired of starting a million sessions the point is to get this done"*
> *"yes keep doing handoffs, just give them to me at the end when youre done"*

Recorded in memory. Commit messages carry the per-item reasoning now, so they
are the durable record between handoffs — keep them thorough.

## 1. Gate

| gate | result |
|---|---|
| `tsc --noEmit` | clean |
| `pnpm test` (coverage) | **exit 0** — 159 files / 2,928 tests (159 / 2,897 at pass 53) |
| `next build` | clean |
| **`E2E_GATE=1` full run** | **410 passed**, run after each of the three commits |
| visual baselines | **zero churn** — none of this is visible on the fixture |
| mutation harnesses | **11/11** (anchor day) and **6/6** (lapsed gate), each with a green BASELINE case |

## 2. Shipped: `recurring_series.anchor_day` (migration 0013)

Queued by pass 51 as item 1. A single ISO date cannot express "the last day of
the month", so a month-end bill posts 2027-02-28, detection re-anchors there, and
every long month after lands on the 28th — forever. **Re-deriving from the newest
posting cannot fix it, because the newest posting is exactly the value that was
clamped.**

One integer is enough, because clamping already gives 31 the meaning "last day":
it lands on the 28th in February and the 30th in April. What one integer cannot
do is be *inferred from one date*, which is the entire reason for the column.
`deriveAnchorDay` therefore reads **all** of a group's postings.

### 2.1 Deliberately inert

It returns null unless the postings PROVE a day the calendar can clamp:

- below day 29 nothing clamps, so there is nothing to record;
- every posting must sit on the candidate day **or** be its own month's last day
  (i.e. be explainable as that schedule, clamped).

Rocket Money posts across days 15–24 on the real ledger. A modal day for it would
trade a 3-day error on the rare shape for a 3-day error on the common one — the
trap pass 51 named when it filed this. It fails both guards and is untouched.

**Measured, migration applied and detection re-run on a copy of the real ledger:
33 series, 0 carry an anchor_day.** Four `next_expected_on` values moved — and
they move **identically on unmodified HEAD**, checked in a `git worktree`. They
are detection drift against newer transactions, not this change.

### 2.2 Two traps found while wiring it

🔴 **`stepsToReach` had to stop re-deriving the date.** It counted whole months
and checked its answer with `addCalendarMonths`, which clamps. Anchored
2027-02-28 with anchorDay 31, against a boundary of 2027-03-30, it answered 2 —
**stepping straight over the real 2027-03-31 charge.** It now asks `stepFrom`, so
the two cannot disagree about where an occurrence is. Generalisation: *two
functions that must agree about a date should not both compute it.*

🔴 **`effectiveSeries` had to drop the anchor when the user sets a date.**
Otherwise picking the 15th on a month-end series is silently re-dayed to the 31st
and the override looks ignored.

Also closed the same defect on the **"Make recurring" seed path**, whose
`FALLBACK_CADENCE` note had asked for exactly this column. One date IS enough
there — the user typed that day on purpose.

## 3. Shipped: a series that stopped charging is not a forecast

UBER *ONE, quiet **446 days** against a 49-day tolerance, was still putting $4.99
a month into Travel; Rocket Money, quiet 87 days, $6.00 into Subscriptions.
`budgetOverdue` and `budgetTail` gated on status and nothing else.

### 3.1 🔴 The obvious gate would have been a far worse bug

`isSeriesActive` also calls a **never-posted** series inactive — right for "is
there evidence?", wrong for "is this coming?". Measured: five series are stale,
and **two of them are the car lease and car insurance**, whose
`last_matched_on` is null because the lease starts 2026-09-11 and has not charged
yet.

> Gating on `isSeriesActive` would have deleted **$559.89 + $361.49** of real,
> owed money from the Car budget in order to remove **$4.99** of dead Uber.

`seriesHasLapsed` is a different predicate: it posted before, AND its newest
posting is older than its tolerance. **Lapsed means "it stopped", which only
something that started can do.**

Measured before → after (August 2026, real ledger):

| budget | series | was | now |
|---|---|---|---|
| Travel | UBER *ONE | $4.99 forecast | **gone** |
| Subscriptions | Rocket Money | $6.00 forecast | **gone** |
| Subscriptions | Amazon Prime | $4.99 overdue | kept (live) |
| Housing | rent | $2,285.70 overdue | kept (live) |

September still projects Car lease $559.89 + Car insurance $361.49 = the Car
budget's $921.38 exactly.

## 4. 🔴 Two tests that PINNED the old defect, rewritten not deleted

Pass 51 wrote a test titled *"a month-end bill anchors on the clamp — the
residual this model cannot avoid"*. After the fix **it still passed** — because
it built its `ProjectableSeries` literal without the new field. A green test
asserting stale documentation.

It now asserts **both halves**: with the anchor day the walk recovers the 31st,
without it the clamp is inherited. *The difference between them is the feature.*
Same treatment for the seed-path test in `recurring-links.test.ts`.

## 5. Also shipped

- **`PacePoint.idealCents` deleted.** Computed on all 31 buckets of every
  dashboard render, read by nothing but its own test. Rendering it would have
  added a third straight line to the card pass 53 just fixed for having too many.
- **`resolveInvestmentUrl`'s docstring was false** and the symbol is now
  asserted. It claimed "the largest holding by value"; it resolves DOM order,
  which is AAPL — the *smallest* position at $7,147.20. That wrong comment sent a
  dependency sweep to the wrong symbol earlier the same day. ETH sits 0.83% from
  MSFT, so a reorder is plausible, and without the assertion it would be silent:
  the suite green while all eight `holding-*` baselines quietly document a
  different asset.

## 6. Queue

**Item 1 needs a decision from you, and has since pass 45.** Trailing six full
months (Feb–Jul 2026), measured today:

| category | budget | 6-mo avg | median | last full month |
|---|---|---|---|---|
| Travel | $100.00 | $600.65 | $270.14 | $2,448.88 |
| Fees | $30.00 | $102.86 | $54.25 | $55.50 |
| Food | $1,430.00 | $1,978.30 | $2,060.75 | $999.37 |
| Entertainment | $60.00 | $106.42 | $55.52 | $0.00 |
| Shopping | $1,540.00 | $776.55 | $795.16 | $181.15 |
| Health | $170.00 | $251.69 | $145.03 | $4.24 |
| Cash & ATM | $710.00 | $520.43 | $488.00 | $78.00 |
| Housing | $2,109.00 | $1,793.13 | $1,557.85 | $2,285.70 |
| Subscriptions | $180.00 | $144.41 | $71.22 | $338.43 |
| Transport | $520.00 | $466.57 | $389.02 | $261.66 |

⚠️ **Average and median disagree badly**, so the choice of basis IS the decision:
Travel's average is $600 and its median $270 because one month held $2,448.
Entertainment averages $106 against a $55 median. Shopping is budgeted at **twice**
its own average. Pick a basis (and whether one-off travel belongs in a monthly
budget at all) and it is a short pass.

2. `HoldingRow.quotedOn` is still rendered nowhere per-row — the subtotal says
   "Last close" without dates precisely because rows may disagree.
3. The negative branch of the `left to allocate` tip is unrendered by any test
   (the fixture's budgets never exceed its income).
4. `pnpm assert-fixture-shape` is the only guard on pass 53's fixture fix and
   nothing runs it automatically.
5. ⛔ **Hosting LAST** — "the whole queue first".

## 7. Notes for the next session

- **Two functions that must agree about a date should not both compute it**
  (§2.2). `stepsToReach` calling `stepFrom` is the shape to copy.
- **"Is there evidence?" and "is this coming?" are different questions** (§3.1).
  A predicate that answers the first will quietly destroy registered commitments
  if you use it for the second.
- **A test that pins a defect must be revisited when the defect is fixed** (§4) —
  and check it FAILS first, or it may be passing for a reason unrelated to the
  behaviour it names.
- **Measure a "no-op" against unmodified HEAD in a worktree**, not by argument.
  Four dates moved in this pass's probe and none of them were mine.
- Still true: `E2E_GATE=1` makes a missing baseline fail rather than be written;
  regenerate baselines by DELETING them; a peer session may be editing the tree.
