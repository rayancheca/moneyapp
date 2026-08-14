# Handoff — 2026-08-14, pass 50

> **`main` = `5077d96`**, tree clean. tsc clean · **155 files / 2,807 unit** ·
> `pnpm test` coverage gate **exit 0** · `next build` clean · **full
> `E2E_GATE=1 pnpm e2e:fresh`: 407 passed** · **zero visual baseline churn**.
>
> Two queue items, both about a screen saying something it had not measured. Continues pass 49
> directly — read that handoff's §1 first, it is still the governing lesson.

## 0. What this pass was

Pass 49 shipped tooltips on /budgets and left two things in the queue that were the *same
defect wearing different clothes*: a verdict that never said what it graded, and a third
surface still calling a week-old figure "today". Both are closed.

Nothing here was discovered by reading code and reasoning about it. The verdict refactor came
out of asking "which of these four states can the fixture actually render?" and counting (two).
The subtotal fix came out of pass 49's own queue note. **Every mutation was verified as applied
before its result was believed — and one applied-check was silently broken again (§5).**

## 1. Gate

| gate | result |
|---|---|
| `tsc --noEmit` | clean |
| `pnpm test` (coverage) | **exit 0** — 155 files / 2,807 tests (154 / 2,798 at pass 49) |
| `next build` | clean |
| **`E2E_GATE=1 pnpm e2e:fresh`** | **407 passed / 0 failed** |
| visual baselines | **0 changed** — verified by running the suite WITHOUT `--update-snapshots` |

## 2. 🔴 THE LESSON: a headline and its explanation must come out of ONE branch

The pace verdict tooltip could have been four strings selected by a ternary in `BudgetRow`,
sitting next to the ternary that picks the headline. That is exactly the shape that produced
pass 49's worst defect — a tooltip gated on `remaining < 0` promising a today mark on a row
whose headline was chosen by `pace === "over"`, two predicates that disagree at exactly 100%.

So the words, their definition, and `barIsFull` now come back from **one call**
(`src/lib/budget-verdict.ts`). The pairing is not "fixed", it is **unrepresentable**: there is
no way to return `paceOver`'s copy without also returning the `Over budget by …%` headline and
`barIsFull: true`.

> **Generalisation: when a bug is "two things that must agree drifted apart", the fix is not to
> re-align them. It is to make them come from one place, so a future edit cannot separate them.**

The second half is the same argument pass 48 made for `dayChangeLabel`: **count which states
your fixture can render before you decide where the logic lives.** The e2e fixture is one
`over` budget and three `withheld`, and the suite asserts `On track` and `Off pace` appear
**zero** times. So two of four states cannot render in any Playwright run, and a
component-level assertion would have passed whether or not they were right. `src/lib/**` is
under the 100%-coverage gate, which forces every branch to be executed.

## 3. Shipped

### 3.1 The pace verdict says what it grades (`src/lib/budget-verdict.ts`, new)

"Off pace · 39% used" is not a contradiction — it is a claim about where spending is **heading**
rather than where it stands — and no screen said so. Four bodies, one per state the headline can
render:

| state | headline | what the tooltip adds |
|---|---|---|
| `over` | `Over budget by 8%` | measured, not a forecast; the bar is full and no longer to scale, and the period mark is left off |
| `at-risk` | `Off pace · 39% used` | still inside the line **today**, but at this rate lands on or past it |
| `under` | `On track · 21% used` | at this rate would finish inside the line |
| withheld | `Awaiting statements` | the figures are floors, not measurements; no reading is offered over them |

⛔ **None of these may contain the words they explain.** "On track", "Off pace", "Over budget",
"Awaiting statements" and "projected" are all in `RESERVED_JARGON_PHRASES` — each is read by an
exact-count locator, and a tooltip body is live DOM text even while closed. Each body therefore
describes its state without naming it, which is also better writing.

`PACE` in the component keeps **only its colours**; the labels moved to the module that owns
their definitions. The shared "how to read the bar" sentence is factored as `BAR_ANATOMY` and
deliberately **not** used by `paceOver` — that row draws no mark and would be describing
something it does not render.

### 3.2 The holdings subtotal stops saying "today" (third and last instance)

The subtotal bar labelled its day-change column `Today` and the live-region sentence ended
`+$25.00 today`. The summed figure is each holding's last close against its previous one, so
the word is true only when prices were refreshed today; on the real ledger the closes trail by
about a week.

**The spoken channel is the worse of the two** — its user cannot see the price-age note a few
elements above that correctly says the closes are seven days old. So the label has to arrive
already correct rather than be corrected elsewhere on screen. `subtotalAnnouncement` now takes
the term; the page resolves it with the same `dayChangeLabel` the header stat uses.

⚠️ **A bare LABEL, never an interval.** A selection can span holdings with different `quotedOn`
dates, so no single pair of days honestly describes them all — the same reason
`holdingPriceSectionNotes` anchors on the oldest close instead of claiming one date for every
position. This is why the subtotal gets `"Last close"` and not `"Aug 6 vs Aug 5"`.

### 3.3 Mutations (8 this pass, all caught)

| # | mutation | result |
|---|---|---|
| M14 | at-risk gets the wrong definition | 1 failed ✅ |
| M15 | withheld row stops declaring itself withheld | 1 failed ✅ |
| M16 | a sub-1% overshoot rounds to "by 0%" | 1 failed ✅ |
| M18 | over row loses its exemption from the coverage gate | 1 failed ✅ |
| M19 | the full bar denies it is full | 3 failed ✅ |
| M20 | the row ignores its own pace | **4 e2e failed** ✅ |
| M21 | `subtotalAnnouncement` re-hardcodes "today" | 1 failed ✅ |

## 4. ✅ A defect that turned out not to exist

While refactoring I noticed `pct: spentCents / availableCents` and traced a zero-budget path to
`"Over budget by NaN%"`. **It is not reachable**, and this is recorded so nobody spends the time
again:

- `createBudgetAction` and the edit action both reject `amountCents <= 0` (`actions.ts:62`, `:110`).
- The carry is clamped: `balance = Math.max(0, …)` (`budgets.ts:279`), so `rolloverCents >= 0`.
- Therefore `availableCents = amountCents + rolloverCents` is always **> 0**.

## 5. ⚠️ The harness lied again — third time in two passes

`git diff --quiet -- <file>` reports **no change for an UNTRACKED file**. `budget-verdict.ts`
was new and uncommitted, so my applied-mutation check was vacuous and the first four mutation
runs reported "MUTATION NOT APPLIED" when they had in fact been written. The check is now
`cmp -s <file> <backup>`, which is agnostic to git state.

Running tally of harness traps that produced a *confidently wrong* result:

1. **zsh does not word-split unquoted `$VAR`** — the test filter became one argument, vitest
   found no files, and every mutation "failed", baseline included.
2. **`perl -0pi -e` chokes on `${...}` in a TS template literal** — file unchanged, run green,
   reads as an uncaught mutation.
3. **`git diff --quiet` on an untracked file** — always "unchanged".

> **The common shape: the harness reported something about a mutation it had not actually
> performed. Always run the UNMUTATED baseline through the identical harness, and assert the
> mutation is present by content — never by git, never by the absence of an error.**

## 6. Queue

1. **Calendar-month stepping** (pass 46 §4), ~356 days of runway left.
2. **Re-set stale budgets from data**: Fees $30 vs $102.86 (⚠️ also measured −$499.00 across the
   Fees subtree lifetime — re-derive before trusting either), Food $1,430 vs $1,990.88,
   Entertainment $60 vs $123.09. **Needs an owner decision, not just a measurement.**
3. `budgetOverdue` has no staleness gate (`UBER *ONE`, dead 443 days, fabricates $4.99 on Travel).
4. **`HoldingRow.quotedOn` is still rendered nowhere per-row.** Now more attractive than before:
   the subtotal says "Last close" without dates precisely because rows may disagree, and a
   per-row date would let the reader see *which* rows are stale.
5. **The negative branch of the `left to allocate` tip is unrendered by any test.** The fixture's
   budgets never exceed its income, so `"What over-allocated means"` is verified by tsc and
   review only. Same fixture-reach problem as §2 — if it is worth closing, the answer is a
   fixture with an over-allocated month, not a component assertion.
6. ⛔ **Hosting LAST** — "the whole queue first".

## 7. Notes for the next session

- **Count what your fixture can render before deciding where logic lives.** Two of four verdict
  states, one of two allocation branches, one of three `dayChangeLabel` branches — this repo's
  fixture is deliberately narrow, and "the test passed" often means "that branch never ran".
- **`cmp -s`, not `git diff`, for applied-mutation checks** (§5).
- **A `pnpm build` can fail with `ENOTEMPTY: rmdir '.next/server'`** after a Playwright run.
  Not a code error — `rm -rf .next` and retry.
- Still true: don't run two `vitest --coverage` at once; finish every edit before starting a
  gate; `cmd > file 2>&1; echo $?`, never `| tail`.
