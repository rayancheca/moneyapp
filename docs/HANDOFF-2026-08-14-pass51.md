# Handoff — 2026-08-14, pass 51

> **`main` = `1d324dd`**, tree clean. tsc clean · **156 files / 2,840 unit** ·
> `pnpm test` coverage gate **exit 0** · `next build` clean · **full
> `E2E_GATE=1 pnpm e2e:fresh`: 408 passed** · **8 visual baselines regenerated —
> predicted, explained, and read back**.
>
> One queue item: **calendar-month stepping** (pass 46 §4, deferred there behind
> a five-item precondition list). All five shipped, plus a sixth that list did
> not name. An adversarial review of the diff raised 15 findings; 13 were
> refuted and the 2 that survived were the same defect, in my own comment.

## 0. What this pass was

Recurring series were projected forward by stepping `round(the measured average
gap)` days. A monthly bill does not work that way, so the schedule walked
backwards through the calendar. Everything below was measured against the real
ledger before the change and again after, never argued.

## 1. Gate

| gate | result |
|---|---|
| `tsc --noEmit` | clean |
| `pnpm test` (coverage) | **exit 0** — 156 files / 2,840 tests (155 / 2,807 at pass 50) |
| `next build` | clean |
| **`E2E_GATE=1 pnpm e2e:fresh`** | **408 passed / 0 failed** (407 at pass 50, +1 new spec) |
| visual baselines | **8 changed** — every `recurring-*`, predicted before the run (§4) |

Mutation harness: **14 mutations, 14 caught**, each with a green BASELINE case
run through the identical path (`scratchpad/mutate.py`, asserted applied by
`filecmp`, exit codes from `subprocess.returncode`).

## 2. 🔴 THE LESSON: a baseline too tolerant to see a change is not a witness

`/recurring` carries eight visual baselines. This change moved a rendered date
from `Aug 4` to `Aug 5`. **All eight passed, unchanged.** `maxDiffPixelRatio:
0.001` cannot resolve one glyph, so the dates on that page were in practice
asserted by nothing at all — 407 green tests over a page whose numbers no test
read.

Two consequences, both acted on:

- `e2e/recurring-schedule.spec.ts` (new) reads the Upcoming list as **text** and
  pins all seven projected dates. Mutation-checked the expensive way: the day
  stepping was restored, the app rebuilt, and the spec went red on exactly
  `Aug 5 → Aug 4` while the eight images stayed green.
- ⚠️ **`--update-snapshots` will not refresh a baseline whose diff is inside the
  tolerance** — its default mode is `changed`, and it considers a tolerated diff
  unchanged. The committed PNG still showed `Aug 4` after a normal update run.
  `--update-snapshots=all` scoped with `-g "recurring"` rewrote exactly the eight
  and nothing else; the regenerated 1440-light baseline was then *read* and shows
  `Aug 5 Meal Kit`.

> **Generalisation: a screenshot is a witness only to changes larger than its
> tolerance. Anything smaller — a date, a digit, a sign — needs a text assertion
> or it is unasserted, however many baselines cover the route.**

## 3. Shipped

### 3.1 One module decides how a schedule walks (`src/lib/recurring-step.ts`, new)

`stepPlan(cadence, intervalDaysAvg)` → `{ calendarMonths, stepDays }`;
`stepFrom(anchor, plan, i)` → occurrence `i`; `stepsToReach(anchor, plan, date)`
→ the first index on or after a boundary. Detection's anchor, the projection,
the rolled-forward "next", the detail page's window and the "Make recurring"
fallback all now come from that one call, so they cannot disagree about where a
charge lands.

`src/lib/dates.ts` gains `addCalendarMonths` (day-of-month preserved, clamped
into short months) and `calendarMonthsToReach` (the first index on or after a
date, in one hop — a stale anchor can be years behind). Both are in `src/lib/**`
and therefore under the 100%-branch gate, which is the point: **two of the four
`stepPlan` outcomes cannot be produced by any fixture this repo renders.**

`calendarMonthsToReach` needs no correction loop, and the reason is worth
keeping: `n₀` months puts the anchor inside the boundary's own month, and `n₀−1`
puts it in the month *before* the boundary's — strictly earlier whatever the
clamping did. So only `n₀` and `n₀+1` can ever be the answer.

### 3.2 The two-sided band

Calendar stepping applies to `monthly` **only**, and only when the raw average
gap is inside `[29, 32]`.

- The low side is load-bearing: a 28-day series is **four-weekly** and genuinely
  drifts through the month, but `fitCadence` buckets it `monthly` (median 28 is
  inside 28–33). Without the low guard it would be pinned to a day-of-month it
  never charges on.
- The high side is where every dangerous row on the real ledger sits: live
  monthly series average **30.0–30.69**, non-live ones run to **53.25**.
- The band tests the **raw** average, not a rounded one — a true calendar-monthly
  series cannot average under 29.5 days (two consecutive 28-day gaps would need
  February twice), so 28.6 is measurably not one even though it rounds to 29.

`quarterly`/`annual` deliberately stay on day stepping: zero live series carry
either, and their buckets are 85–97 and 350–380 days.

### 3.3 The anchor, in the same commit (pass 46 §4 item 1)

`analyzeGroup` laid its anchor with `addDays(last.postedOn, round(medianGap))`.
Under day stepping a one-day-early anchor is self-correcting noise; under a
calendar walk it repeats every month forever. The plan is now built from the
interval the same call is about to **store**, so the anchor and the walk are the
same decision. Three anchors in the test corpus were wrong before it, each by a
day, each on a series whose whole history lands on one day of the month:

| series | charges on | old anchor | new |
|---|---|---|---|
| corpus rent | the 1st | 2026-07-02 | 2026-07-01 |
| corpus Netflix | the 15th | 2026-07-16 | 2026-07-15 |
| Breezeline (links test) | the 10th | 2026-07-11 | 2026-07-10 |

The real ledger's stored anchors are untouched until the next detection run —
`analyzeGroup` writes them, and this pass ran no detection against it.

### 3.4 The sixth precondition pass 46 did not name

`createSeriesFromTransaction`'s thin-evidence fallback (`recurring-links.ts`)
creates a series `monthly` with a **null** `intervalDaysAvg` — which `stepPlan`
reads as calendar-monthly — and anchored it with a hard-coded 30-day hop. A
charge seen on the 31st would have been anchored on the 2nd, and
`recomputeSeriesStats` **cannot** correct it: it declines to write below
`MIN_OCCURRENCES = 3`, and detection does not even link the second charge.

### 3.5 Measured on the real ledger (read-only copy, five dates)

| | before | after |
|---|---|---|
| **Housing projected, 2027-12-05** | **$4,571.40** (rent on 12-01 *and* 12-31) against a $2,109 budget | **$2,285.70** |
| Car lease, final payment | 2028-08-01 | **2028-08-11** — its own end date |
| Flamingo, Breezeline, FPL, Amazon, Rocket Money | drifting: 09-07, 09-09, 09-09, 10-06, 10-21 | the 8th, 10th, 10th, 5th, 19th |
| Travel `overdue` at today | $4.99 (UBER *ONE) | $0.00 — the same $4.99 moved to the forward tail; `projected` unchanged |
| **rollover carry, all five dates** | 0 / 9,501 / 142,515 / 152,016 / 199,521 | **identical** |

That last row settles pass 46 §4's sequencing warning: it did **not** materialise.
`carryInto` measures overdue over a whole CLOSED period, and at these anchors both
models put exactly one occurrence inside such a month. It would have differed only
where the old model double-billed a closed month.

And the mirror defect, which is the worse one: a 30-day walk from an anchor on
the 30th lands on 2026-03-01, so **February holds no charge at all** and
$2,285.70 of committed money vanishes from that period. A calendar walk puts
exactly one occurrence in every month between the first and the last, never zero
and never two.

## 4. Baseline churn — predicted, then measured

Predicted before the run: **only** `/recurring`, because it is the only
baselined route whose window (30 days from 2026-07-08) contains a *second*
occurrence — Meal Kit, anchored 2026-07-05. Every other second occurrence (Rent
08-09, Netflix 08-16, Gym 08-20) falls outside the window under both models, and
the dashboard's strip is 14 days. Measured: exactly the eight `recurring-*`
images, no others. The 30-day net is unchanged — the same occurrences, one on a
different day.

## 5. ⚠️ The residual this model cannot avoid — and the review that found it

An adversarial review (5 lenses, each finding then attacked by a skeptic) raised
15 findings. 13 were refuted with reproductions. **The 2 that survived are the
same defect**, and it was in my own prose:

**A single ISO date cannot express "the last day of the month".** The anchor one
month past `2027-01-31` is `2027-02-28`, and because the walk indexes off the
stored anchor, a month-end bill then sits on the **28th** — three days early in
every long month. The `FALLBACK_CADENCE` doc claimed "the anchor has to keep the
seed's day-of-month too", and the test was *titled* "keeps a month-end seed's
day" while asserting the clamp. The comment was aspiration; the code was not.

What is true about it, measured:

- **Bounded and self-correcting**, unlike what it replaces: each detection run
  re-anchors on the newest charge, so the error never exceeds the short/long
  month gap (≤3 days). The 30-day walk on the same series reached 2027-02-25 and
  kept going.
- **Inside `toleranceDays: 3`**, so `budgetOverdue` still matches a real posting
  and no phantom overdue or double count appears.
- **Zero exposure on the real ledger**: every live series anchors on day ≤ 25.
- **One real money case exists**: a window boundary inside the 3-day error drops
  the charge — `today = 2027-03-29`, period end `2027-03-31`, true charge on the
  31st, projected on the 28th → $0 where $2,109 was due.

Fixed in this commit: the false comment, the false test title, and the missing
coverage — the anchor-production path with a clamping input had **no test at
all** (the one test that proves the 31st survives hand-sets the anchor, so it
covers the walk and never the path that produces it). Both the clamped anchor
and the walk that inherits it are now asserted, so the behaviour is *stated*.

**Not fixed, and it is the top queue item** — see §6.1.

## 6. Queue

1. **An anchor day-of-month, so a month-end bill can say so** (§5). The
   information does not fit in `next_expected_on`; it needs either a
   `recurring_series.anchor_day` column written by `analyzeGroup` (from the
   postings, not from the last one — the last one can itself be clamped) and
   read by `stepFrom`, or a last-day-of-month schedule flag. ⚠️ Do **not** try to
   infer it from a single date at read time: "anchor lands on the 28th of
   February" is genuinely ambiguous between a 28th bill and a month-end bill, and
   guessing trades a 3-day error on the rare shape for a 3-day error on the
   common one.
2. **Re-set stale budgets from data**: Fees $30 vs $102.86 (⚠️ also measured
   −$499.00 across the Fees subtree lifetime — re-derive before trusting either),
   Food $1,430 vs $1,990.88, Entertainment $60 vs $123.09. **Needs an owner
   decision, not just a measurement.**
3. `budgetOverdue` has no staleness gate (`UBER *ONE`, dead 446 days, still
   fabricates $4.99 on Travel). **New information:** stepping moved that $4.99
   from `overdue` to the forward tail, so it now reads as an upcoming charge
   rather than a missed one. Same money, still wrong, arguably now less visibly
   so — this item did not get easier.
4. **`HoldingRow.quotedOn` is still rendered nowhere per-row.** The subtotal says
   "Last close" without dates precisely because rows may disagree; a per-row date
   would let the reader see *which* rows are stale.
5. **The negative branch of the `left to allocate` tip is unrendered by any
   test.** The fixture's budgets never exceed its income. Same fixture-reach
   problem as §3.1 — if it is worth closing, the answer is a fixture with an
   over-allocated month, not a component assertion.
6. ⛔ **Hosting LAST** — "the whole queue first".

## 7. Notes for the next session

- **A screenshot is not a witness below its tolerance** (§2). Before claiming
  "no baseline churn", ask whether the change is large enough for the baseline
  to see. `--update-snapshots` alone will not refresh a tolerated diff.
- **A comment that states an invariant is a claim, and claims need tests.** Both
  surviving review findings were prose asserting something the code did not do,
  next to a test whose title repeated the prose and whose assertion matched the
  code. The assertion was right and the words around it were wrong, which is the
  hardest version to notice.
- **Count what your fixture can render before deciding where logic lives.** Two
  of the four `stepPlan` outcomes cannot be produced by any Playwright run here;
  `src/lib/**`'s 100% gate is what forces them to execute.
- Harness discipline that held this pass: applied-mutation checks by content
  (`filecmp` / `cmp -s`, never git), exit codes from the process (never through a
  pipe), and a BASELINE case through the identical harness to prove it can report
  green.
- Still true: `rm -rf .next` if `next build` hits `ENOTEMPTY` after a Playwright
  run; don't run two `vitest --coverage` at once; don't run the gate while agents
  are working.
