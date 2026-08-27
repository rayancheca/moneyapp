# Handoff — the two missing provenance kinds, and the year page that could not say what it spent

> **Supersedes `HANDOFF-2026-08-27-transfers-and-commitments.md`.**
>
> **`main` = `1309ace`**, tree clean, pushed. tsc clean ·
> **214 files / 4,113 unit** · coverage **99.76% stmts, 100% funcs** ·
> **E2E_GATE=1: 540 tests, 538–540 passing** — see §5, which is an honest
> report of flake and not a green claim.
>
> Live ledger unchanged by this pass: **10,111 active rows** · income
> **$117,924.62** · zero DB writes. Nothing was written to the database at all.

---

# ⛔ 0. THE JOB — what is next

The previous handoff's §3.4 named the next unit of work as *"build the two
`FigureRef` kinds first, and both surfaces become cheap"*. That is done, and
both surfaces shipped. What remains:

1. **Pass 72d — cost, caching and the kill switch.** Still nothing calls a
   model: every sentence on all seven insight surfaces is composed by the app
   from measured facts. That remains the right order, and it means a model can
   be introduced as a SELECTOR over already-true claims rather than as a writer.
2. **Pass 73** (the Robinhood Brokerage arbiter) and **74** as scheduled.
3. **A small, real copy defect is named in §4.2** — "fell by -$587.96" — with
   the exact one-line fix. Deliberately not taken: it changes shared sentence
   grammar across three already-reviewed surfaces and is your call.
4. **HOSTING goes last** — unchanged. `docs/deploy-plan-gcp-firebase-auth.md`.

⛔ **The insight sweep is finished as a sweep.** Seven surfaces now carry
measured prose. The previous handoff's §3.1 already established that
`/investments`, `/investments/[assetType]/[symbol]`, `/imports` and the
dashboard deck are *already served* and would only restate. `/flow` and
`/transactions` remain genuinely open, and neither has an obvious claim a chart
does not already show — the shape of one is a design question, not a checklist
item.

---

## 1. ✅ Two figure kinds, for numbers that are not a category's rows

`provenanceFor` could prove a category's sum, a merchant's sum, a balance, a
holding and a forecast. It had no kind for a total that is not a category's
rows, nor for a figure that was **decided rather than measured**.

### `allSpend` — every dollar the app calls spending in a window

⛔ **Not `categorySpend` over some root, because there is no root.** The app's
spending total is the union of every top-level `expense` category AND every
uncategorized outflow, and no category id names that set.

⛔ **The predicate is borrowed, never rewritten.** `spendingBucket` plus a debit
is the app's definition of spending. Restating it as SQL would be a second
definition of the largest number in the app, which this codebase has paid for
three times (two functions computing one due date; a ruler that graded itself; a
`where` clause that made a liveness test dead code while it still looked
load-bearing). So it walks the same `activeTxnsInRange` rows through the same
classifier the figure walks, and adds only the join back to the documents.

⛔ **A SPLIT transaction is ONE row, not three.** `activeTxnsInRange` explodes a
split into a pseudo-row per part so each part lands in its own category —
correct for the SUM, wrong for a PROOF, which counts rows and names documents. A
$50 charge split three ways is one line on one statement, and "the sum of 3 rows
from 1 document" would be a count of something that does not exist. This is the
single most valuable line in the module and the mutation that proves it is the
one that matters.

Measured on the real ledger (`scripts/probe-new-figure-kinds.ts`): the whole
four-year window is **4,954 rows from 72 documents in 15ms**; 2026-so-far is
**"1435 of 1439 checked" through 2026-07-31**.

### `budgetPlan` — the one figure this service grades that is a decision

⛔ **"Nothing checks it" is the right answer here, not a hole.** Every other
figure is a claim about something that happened, so an absent document is a gap.
A budget is a claim about what he *intends*, and there is nothing in the world to
check it against until the period ends — at which point the thing that closes
against a document is the ACTUAL, which `/budgets` already proves separately.
`manual`, for the same reason cash in a safe is: the owner is not a missing
source, he is the source.

⚠️ **The wording does not say "you typed this", and neither does the badge.**
The real budgets were sized by `pnpm propose-budgets` and kept, and the schema
carries no column that could tell a typed plan from an accepted proposal. So the
verdict's stock word — `manual` presents as **"you entered it"** — is overridden
to **"a plan"**. A headline that is careful about this beside a badge that is
not would contradict itself at a glance.

### `against` — a comparison stands on BOTH of its windows

`allSpend` takes an optional second window. A year-over-year sentence rests on
last year's documents exactly as much as on this year's, and proving one half is
proving half the claim.

⚠️ `spending-insights` already renders a `rose_between` delta and proves only
its current window. That is a pre-existing looseness, left alone, and
deliberately not extended to a sentence about a whole year.

The grading runs over **both row sets at once** rather than taking the weaker of
two badges: "2 of 3 checked" has to be true of a real set of rows, and a
weaker-of-two fraction is true of neither half. Each window is then named in
`inputs` with its OWN verdict, so a reader can see *which* half is weak instead
of being told only that one of them is.

---

## 2. `/summary/[year]` — and the premise that was backwards

Owner-approved this session: the year page gets one thread of money OUT, on a
same-days window. Every section on it was money in.

### 🔴 The previous handoff got the direction wrong while warning about it

It predicted a naive line reading *"your spending fell by $22,000 between 2025
and 2026"*. Measured (`scripts/probe-window-spend.ts`):

| | 2025 | 2026 | |
|---|---|---|---|
| naive full-year | $41,501.86 | $65,988.77 (8 months) | **rose $24,486.91, +59%** |
| like-for-like through Jul 31 | $21,727.10 | $56,576.24 | **rose $34,849.14, +160%** |

So the naive comparison **does not flip the sign here — it understates a rise by
eighteen thousand dollars while looking entirely plausible**, which is worse
than being obviously wrong.

### Three gates, and the handoff had named one

1. ⛔ **The end day is the OBSERVATION FRONTIER, not the ledger's last row.**
   The newest active row is 2026-08-24, but SoFi Checking and SoFi Savings have
   only been shown through **2026-07-31** — measured, **$9,503.76** of spending
   sits in a window two accounts have not reported into. Ending at the last row
   compares a fully-reported 2025 against a 2026 missing whole accounts for
   three weeks. This is the statement-lag trap that once dropped his rent out of
   the committed book for being one day late, in a new place.
2. **Both windows cover the same calendar days.** Jan 1 → the frontier, in each
   year. Feb 29 steps back to the 28th in a common year — SQLite would compare
   `'2027-02-29'` lexicographically without complaint while the label printed a
   date that has never existed.
3. ⛔ **The earlier window must lie wholly inside the ledger.** Without this,
   2023 is compared against the four months of 2022 the ledger holds and
   publishes **"+622.8%"** — a measurement of when importing started. On the real
   data this gate is what silently withholds 2022 and 2023; only **2024, 2025 and
   2026** get a line.

⛔ **The window is IN the sentence.** *"Spending rose by +$34,849.14 between
Jan 1 – Jul 31, 2025 and Jan 1 – Jul 31, 2026."* And the note names the
SUBJECT whether or not the window needs explaining — this page's own design note
calls its three figures "the ones a reader most often conflates", so a fourth
subject arriving unlabelled is how a spending figure gets added to an earnings
figure.

---

## 3. `/budgets` and `/spending`

**`/budgets`** — every row now carries two proofs. The actual is a sum of
documented rows (`categorySpend`, unchanged); the plan is a decision
(`budgetPlan`). With rollover ON the badge is named **"plan"** rather than
"budget", because the figure beside it is `availableCents` — plan plus a
ledger-measured carry — and the panel says so in words rather than in a
recomputed figure.

And a strip: the page prints every plan amount **ordered by category**, so which
is biggest and what share of the month it is are the two facts it holds and never
states. Real data: *"Housing is the largest of your 12 monthly budgets, by what
you planned to spend, at $2,285.70"* and *"more than half … at 50.7%"*.

⛔ Ranked within **monthly only**, borrowing the set and the denominator the page
already uses for its income comparison (`totalBudgetedCents`, which excludes a
child budget inside a budgeted parent) rather than defining a second idea of
"everything budgeted" that could drift from the figure at the top of the page.

**`/spending`** — the period's whole spending, the biggest figure on the page and
until now the only one with no way to check it.

⛔ Mounted on the **heading**, not on a StatCard. Every stat tile there is wrapped
in a `<Link>` when it has an href, and a `<button>` inside one is axe
`nested-interactive` (serious) — the trap `ProvenancePopover` documents.

---

## 4. What was wrong, and was not found by a test

### 4.1 🔴 `accountCoverage(db, day)` takes a TODAY, not an as-of

Found while mutating. It *reads* as though the day argument decides what rows are
graded against. It does not. Measured on the real ledger
(`scripts/probe-cov-day.ts`, since removed — reproduce in three lines): moving
that argument from 2026 to 2023 changes `grade`, `verifiedThrough`,
`unverifiedSince` and `brokenSince` on **none of the twelve accounts**. The only
field it moves is `daysSinceVerified`, which no provenance path reads and which
goes **negative** for a past day.

No existing caller is wrong — coverage is a fact about the ledger as it stands
now, which is the right thing for a proof to report. But **a future caller
reaching for historical grading by passing an old date gets today's answer and no
warning.** My own first comment in `allSpendProvenance` asserted the opposite;
it now states the trap.

### 4.2 🔴 "Spending fell by **-$587.96**" — a double negative, on screen

`deltaFact` renders signed (`+$X` / `-$X`) and its docstring explains why: *"A
delta that dropped its sign would read as a rise."* True of a delta rendered
alone. But **every delta template already states the direction in words** —
`rose_between`, `fell_between`, `unchanged_between` — so inside them the sign is
redundant on the way up and a double negative on the way down.

**Deliberately not fixed.** It is established across three shipped surfaces
(`spending-insights`, `notices-card`, and now this) with seven test assertions
pinning it, and `notices-card`'s own comment shows this text was scrutinised in a
prior pass and the sign survived. The fix is one line —
`factField(fact, "value")` returns the magnitude for `kind === "delta"`, with a
`magnitude` field derived on `DeltaFact` beside `display` — plus ~7 test
assertions and probably some dashboard baselines. **Your call, not mine to make
while shipping something else.**

### 4.3 ⚠️ tsc caught fixture data that twelve green tests accepted

`reconciliation: "ok"` is not in the enum. SQLite has no CHECK constraint to
notice, so the rows inserted fine and every assertion passed.

---

## 5. ⚠️ The e2e suite flakes under a full serial run — an honest report

The previous handoff recorded a clean **534 passed**. This pass adds 6 tests
(540 total). Across three full `E2E_GATE=1` runs:

| run | result | failing |
|---|---|---|
| 1 | 507 passed, 33 failed | 32 expected visual baselines + `zz-card-deck` "the deck is a fraction of the grid" |
| 2 | 538 passed, 2 failed | `zz-zz-view-switcher` (holding's table), `zz-zz-zz-cash-wallet-opening` |
| 3 | *(see below)* | |

⛔ **Three different tests failed across two runs and not one reproduced.** Each
passes in isolation, and re-running them together passes:

- `zz-card-deck` fails on `boundingBox()` returning null — a call with **no
  auto-wait**, which is the same class of trap pass 38 already recorded
  (`isVisible()` doesn't auto-wait).
- None of the three is on a route this pass touched.

I measured whether my changes could have slowed a page enough to tip a timing
test (`scripts/probe-insight-cost.ts`): **+2.4ms on /spending, +2.4ms on
/budgets, +11.4ms on /summary/[year]**. That cannot be the cause.

**So this reads as pre-existing flake surfaced by a longer suite, not a
regression — but I did not prove that, and I am not calling the suite green.**
The concrete next step if it bothers you: replace bare `boundingBox()` calls with
an `expect(locator).toBeVisible()` first, which does auto-wait.

The 32 visual failures in run 1 were expected and are resolved — see §6.

---

## 6. Visual baselines — 32 regenerated, every diff read first

Four routes changed, all four mine. Each diff was cropped with
`scripts/crop-visual-diff.mjs` and **looked at** before anything was written:

| route | changed px | page height | what it is |
|---|---|---|---|
| `spending` | 162 | 3149 → **3149** | the badge after "Where it went" |
| `spending-year` | 232 | 3263 → **3263** | same |
| `budgets` | 53,482 | 1098 → 1270 | the new strip + a plan badge per row |
| `summary-year` | 25,602 | 1379 → 1587 | the new "What you spent" card |

⛔ The two `/spending` heights are **unchanged**, which is the point:
`ProvenancePopover`'s `-my-0.5 py-0.5` keeps an annotation from moving its
figure. 320px was checked by eye — sentences wrap, badges collapse to the glyph,
no overflow. `git status` confirms exactly 32 files modified and nothing else.

---

## 7. Still open (unchanged unless noted)

- **Pass 72d** — no model is called yet; the vocabulary is ready for one.
- **The delta sign** — §4.2.
- **`accountCoverage`'s day argument** — §4.1, documented not changed.
- **Discover is missing five statements**, 152 days, named on `/imports`.
- **`docs/income-ground-truth.md:40` still says income ≈ $119,982.68.** The
  measured figure is **$117,924.62**, now stable across nine passes.
- **The merchant map calls his rent "Flamingos Restaurant"**.
- **`/merchants/[id]` and the notices card have no visual baseline.**
- **`notFound()` returns HTTP 200** app-wide from force-dynamic pages.
- **45 `WEIXIN*` rows, $340.00**, deliberately in bare `Shopping`.
- **HBO Max is registered as RENEWING** — one click on `/recurring` ends it if
  it does not auto-renew.
- **4 transfer legs, $1,462.00** (bucket C) still unpaired — two identical rival
  mirrors each, deliberately untouched.

---

## 8. Notes that keep costing time

- ⚠️ **A green first run on new tests is when to mutate them, not to trust
  them.** 45 mutants this pass; 3 survivors were real test gaps and 2 are
  genuinely unobservable and say so in a comment rather than being papered over.
- ⚠️ **`pnpm e2e` serves a STALE `.next` — always `e2e:fresh`.** Regeneration
  runs **without** `E2E_GATE=1`; verify with it. `-g` targeting regenerates only
  the intended baselines (confirmed: exactly 32, nothing else).
- ⚠️ **`pnpm test`/playwright output is buffered through `| tail`** — a task file
  stays empty until the run ends. Poll the process, not the file.
- ⛔ **Measure the FIXTURE before writing an e2e assertion.**
  `scripts/probe-e2e-year-insights.ts` and `scripts/probe-e2e-budget-insights.ts`
  seed a throwaway e2e DB and print what actually renders.
- ⚠️ **`categories.name` is UNIQUE and the seed already holds "Housing",
  "Food", "Travel"…** — a fixture that reuses those names fails on insert, not
  on assertion.
- ⛔ **EMPTY IS NOT A WEAKNESS**, still. Three more places this pass: a year with
  no predecessor gets no strip rather than a 0% one; a measured zero is refused
  as a finding; one monthly budget is not a ranking.
- Push: `git -c credential.helper='!gh auth git-credential' push origin main`
