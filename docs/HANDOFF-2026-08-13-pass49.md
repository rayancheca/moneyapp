# Handoff — 2026-08-13, pass 49

> **`main` = `b1963f2`**, tree clean. tsc clean · **154 files / 2,798 unit** ·
> `pnpm test` coverage gate **exit 0** · `next build` clean · **full
> `E2E_GATE=1 pnpm e2e:fresh`: 406 passed**.
>
> The queue's top item (tooltips on /budgets), two confirmed defects it carried, and one
> defect the **owner** reported mid-pass that turned out to be the most interesting thing here.

## 0. ⛔ The standing directive still stands

Pass 48 §0 told this session to work harder and named five specific ways. What that produced:

- **The adversarial review ran BEFORE the victory lap, and found two real defects in my own
  diff after every gate was green** (§4). One of them was a sentence that would have been
  false on a row nobody had built yet.
- **Every gate was mutation-checked** — 13 mutations, each verified as *applied* before its
  result was believed (§3.4). Two mutation runs reported nothing useful because the harness
  itself was broken; both were caught by checking the baseline rather than the result.
- **The one thing I punted, I punted explicitly and the owner immediately overruled it** (§2).
  That is the pass's real lesson and it is written up first.

**For the next session:** the failure mode this pass kept hitting was *reasoning about a
predicate instead of executing it*. Every genuine finding came from running something. The
two defects in §4 were both found by asking "under exactly what condition is this sentence
true?" and then reading the function that decides — not by reading my own code.

## 1. 🔴 THE LESSON: I decided the hardest term was out of scope, and the owner disagreed within the hour

I shipped three tooltips, all on terms printed **once per page or once per section**, and I
deliberately left the **pace verdict and the bar** alone. My reasoning, written into the
source: /categories established "one tip per GROUP, not per row", the verdict is printed once
per row, and an identical sentence beside every row is furniture rather than information.

The owner then looked at the page and said: *"the line inside of housing budget makes no sense
btw."*

He was right, and my rule was wrong **on its own terms**. The /categories precedent's stated
reason is a COST argument, quoted verbatim in that file: *"77 rows of info buttons would cost
more in keyboard traversal than the jargon costs in confusion."* /budgets renders four rows in
the fixture and a handful on the real ledger. I inherited the rule's conclusion and never
re-checked its premise against the page I was actually on.

> **Generalisation: a precedent in this repo carries its reasoning with it. Read the reason,
> not the rule, and check the reason still holds where you are standing.** Every one of these
> conventions was written with its own measurement attached, precisely so the next person can
> tell when it stops applying.

And the second half: **the thing the owner found confusing was the one thing on the page with
no words at all.** I annotated three *terms* — text a reader can at least google. The
unexplained artifact was a purely visual mark: `aria-hidden`, absent from `aria-valuetext`,
described nowhere in the app. I had read that element's source (it is three lines above code I
edited) and treated "it has a code comment" as "it is explained".

## 2. What the mark actually was, measured

Not reasoned — read off the built page:

| row | `aria-valuenow` | fill width | tick left |
|---|---|---|---|
| Food | 21 | 21.08% | 25.81% |
| **Housing** | **100** | **100%** | **25.81%** |
| Subscriptions | 39 | 38.73% | 25.81% |
| Utilities | 0 | 0% | 25.81% |

It is the **today mark** — the elapsed fraction of the period (Jul 8 of Jul 1–31), identical on
every row. Its job is to be a boundary you compare the fill's edge against.

On Housing it fails three ways, all real:

1. **The fill is clamped.** Housing is at 108% and draws 100%, so the mark is compared against
   a quantity the bar has stopped showing. 101% and 300% draw identically.
2. **A full bar gives the mark nothing to divide.** It needs an unfilled side to be a boundary.
3. **Nothing said what it was.** True on all four rows — Housing is only where it is loudest.

Owner picked *explain it, and hide it where it cannot be read*. Shipped as that.

## 3. Shipped

### 3.1 Three tooltips on the sums /budgets performs and never shows (`BUDGET_JARGON`)

Each written **after** reading the function that computes the figure:

- **expected income** — `incomeExpectation` returns `max(posted + still-due, whole-period
  series forecast)`. The max exists because most of every month reads `$0.00` posted while
  statements land weeks apart. A reader assuming plain addition cannot reconcile the headline
  with the two parts printed directly beneath it.
- **left to allocate** — subtracts **MONTHLY budgets only** (`page.tsx`: `income.totalCents -
  totalBudgetedCents(monthly)`). A weekly grocery budget does not reduce it. Nothing on screen
  said so, and this is the single most surprising arithmetic on the page.
- **Total budgeted** — `totalBudgetedCents` drops any budget whose ancestor is budgeted in the
  same set. The page prints "overlapping child budgets excluded" *only when that actually
  bites*, so on every other load the sum looks like plain addition and is not.

⚠️ **The `leftToAllocate` tip has two mount sites, one per branch of the over/under ternary,
and the fixture only ever renders the positive one.** The negative branch ("Over-allocated by")
is verified by tsc and review only. The e2e asserts `/^What (left to allocate|over-allocated)
means$/` has count 1, which pins "exactly one renders" without pinning which.

### 3.2 The bar, explained per row — and the mark suppressed where it lies

`paceBar` / `paceBarFull`: **two bodies, because one would have been false.** A clamped row
does not render the mark, so a single definition describing it would describe something that
row does not have.

The today mark is no longer drawn when the fill covers the track. The elapsed figure it encoded
is now spoken in `aria-valuetext` on **every** row, including the one that no longer draws it —
hiding a visual must never cost assistive tech a fact. The clause is placed **early** in the
string on purpose: the overdue assertion at `zz-budgets.spec.ts` is an end-anchored regex.

### 3.3 🔴 The predicate, and why it is not the obvious one

`barIsFull = status.pace === "over"`, **not** the `over = remainingCents < 0` sitting three
lines above it. They are not the same predicate:

- `computePace` turns over at `spent >= available` (pinned: `computePace(10_000, 10_000,
  10_000) === "over"`).
- `over` is `remaining < 0`, i.e. **strictly** greater.

They disagree at **exactly 100%** — a budget sitting precisely on its line. That is the case
where the bar is already full, the mark is buried underneath it, and `paceBarFull`'s sentence
*"the heading beside it says by how much"* would have promised a heading that does not exist
(the headline branches on `pace === "over"`, so at exactly 100% it says "Over budget by <1%",
but `over` is false so my first version drew the mark and showed the wrong tooltip).

Sharing the **headline's own predicate** is what makes the copy true by construction rather than
by coincidence. The e2e now asserts this as an invariant over every row —
`aria-valuenow === "100"` ⟺ zero marks — rather than as a fact about Housing.

### 3.4 Guards, all mutation-checked

Thirteen mutations, each verified as *applied* (non-empty `git diff`) before its result counted.

| # | mutation | result |
|---|---|---|
| M1 | reserved phrase into a definition | 1 failed ✅ |
| M2 | a digit into a definition | 1 failed ✅ |
| M3 | reflection narrowed to one jargon map | 1 failed ✅ |
| M4 | duplicate in the reserved list | 1 failed ✅ |
| M5–M6 | drop the name guard from create / rename | 1 failed each ✅ |
| M7 | forbid only `,`, not `>` | 3 failed ✅ |
| M8 | list separator changed to one no validator bans | 4 failed ✅ |
| M9 | `dayChangeCents` initialised to 0 again | 2 failed ✅ |
| M10 | remove the per-section tip | 1 failed (expected 3, got 2) ✅ |
| M11 | `block` on the tooltip span (pass 47's near-miss) | 1 failed — "unexpected value visible" ✅ |
| M12 | draw the mark even when clamped | 1 failed (Housing expected 0, got 1) ✅ |
| M13 | drop the elapsed clause from `aria-valuetext` | 1 failed ✅ |

### 3.5 Category names may no longer contain `,` or `>` (queue §5.7, both halves)

- `,` — a section note states a COUNT and then joins names with `", "`. `Food, Drink` renders
  *"2 categories hold no transactions: Food, Drink, Pets"* — says two, lists three.
- `>` — a ROOT named `Fees > Interest Charges` prints identically to the real child of that
  path, and sibling-uniqueness cannot see it because they are not siblings.

Rejected at the boundary rather than escaped at each render: `createCategory` and
`renameCategory` are the only two paths that put a name in the table. **The separators are now
named constants** (`NAME_LIST_SEPARATOR`, `PATH_SEPARATOR`) and a test asserts every separator
character is one a name may not contain — so changing a separator fails the build instead of
silently reopening the ambiguity. The seeded taxonomy is the third naming path and calls
neither, so it gets its own sweep. Verified: **zero** names in the real DB or the seed contain
either character, so this is non-breaking.

### 3.6 `dayChangeCents` is nullable (queue §5.2)

It was `0` with no prior covered day — a *measurement*, saying the portfolio moved nowhere.
/investments guards its empty state on `investmentAccounts.length`, never on covered days, so
that is exactly what the header rendered the first time a brokerage account was priced. Now
null → the em dash idiom its two sibling stats already used.

⚠️ **My first test for this was wrong and the failure taught me the shape.** I seeded one price
at a back-dated day and expected one covered day; `buildPortfolio` fills **forward to today**,
so it produced a long series and a perfectly real flat change. The only shape that yields one
covered day is a position opened *today*. The test now dates everything at `todayIso()` and
says why.

The dashboard teaser also stopped calling a week-old figure **"today"** — the same defect pass
48 fixed on `PortfolioStats` and left standing one component away. `dayChangeTerm` was extracted
into `src/lib/day-change-label.ts` **because it was reachable by no test at all**: the fixture is
priced through its own fake today, so only the "today" branch can ever render. `src/lib/**` is
under the 100% coverage gate, which forces the other branch to be executed.

> An argument **swap** in that call is still caught — it would change the fixture's rendered
> string and fail the dashboard visual baselines. That is the one part of this wiring a unit
> test does not cover, and it is covered by pixels instead.

## 4. What the adversarial review found in my own diff (2 fixed)

Both were **false statements**, not broken code, and both were found by asking "under exactly
what condition is this sentence true?" then reading the function that decides.

1. **🔴 The tick predicate diverged from the headline at exactly 100%** (§3.3). The copy would
   have promised a mark that is not drawn and a heading that is not shown.
2. **🟡 Four buttons with the same accessible name.** Every row's tip was
   `"What this bar means"` — indistinguishable in a screen reader's control list. Now
   `"What the Food bar means"`, matching the row's existing `Details for the Food budget` idiom.

## 5. Baselines

8 budgets baselines regenerated, **and nothing else** (`git status` on the snapshot dir: exactly 8).

The +2px height was **measured, not assumed**: the two `text-xs` lines that gained a tip each
grew **0.81px** (a 16px inline-flex icon in a 16px line-height box), and the `text-sm` line
absorbed its icon at 20px with no growth. 1.62px → a 2px taller full-page shot. Adding the four
per-row tips in 3.2 changed the height by **zero** — the row headline was already taller than
the icon. Widths unchanged at 320, so no new horizontal overflow.

## 6. Queue

1. **Calendar-month stepping** (pass 46 §4), ~356 days of runway left.
2. **Re-set stale budgets from data**: Fees $30 vs $102.86 (⚠️ also measured −$499.00 across the
   Fees subtree lifetime — re-derive before trusting either), Food $1,430 vs $1,990.88,
   Entertainment $60 vs $123.09.
3. `budgetOverdue` has no staleness gate (`UBER *ONE`, dead 443 days, fabricates $4.99 on Travel).
4. **`HoldingRow.quotedOn` is still rendered nowhere per-row** (`portfolio.ts`). The price-age
   note consumes it in aggregate; the per-row date remains free if the holdings table wants it.
5. **NEW — `holding-subtotal.ts:111` still says "today"** about the subtotal day change
   (`${formatCentsSigned(...)} today`). Same defect class as §3.6, third instance. It has no
   `asOf` to hand, so fixing it means threading one in.
6. **NEW — the pace verdict itself is still unannotated.** The bar now has a definition; "On
   track · 12% used" vs "Off pace" still does not say it grades a PROJECTION rather than
   spend-so-far. The per-row tip added in 3.2 is the obvious home for a second sentence.
7. ⛔ **Hosting LAST** — "the whole queue first".

## 7. Notes for the next session

- **zsh does not word-split unquoted `$VAR`.** A mutation harness written as `T="a b"; vitest
  run $T` passes ONE argument, vitest reports "No test files found", and every mutation reads
  as a failure — including the baseline. Use an array. I caught this only because I ran the
  baseline first; **always run the unmutated baseline through the same harness.**
- **`perl -0pi -e` chokes on `${...}` in a TS template literal** (`Backslash found where
  operator expected`) and silently leaves the file unchanged — after which the test run passes
  and reads like a mutation that was not caught. Use a literal `String.replace` via node, and
  assert the needle was found.
- **`next build` can fail with `ENOTEMPTY: rmdir '.next/server'`** after a Playwright run. Not
  a code error — `rm -rf .next` and retry.
- Still true from pass 48: don't run two `vitest --coverage` at once; finish every edit before
  starting a gate (the e2e freshness guard is real); `cmd > file 2>&1; echo $?`, never `| tail`.
