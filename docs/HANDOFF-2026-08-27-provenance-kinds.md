# Handoff — the two missing provenance kinds, and the year page that could not say what it spent

> **Supersedes `HANDOFF-2026-08-27-transfers-and-commitments.md`.**
>
> **`main` = `8546606`**, tree clean, pushed. tsc clean ·
> **214 files / 4,119 unit** · coverage **99.76% stmts, 100% funcs** ·
> **E2E_GATE=1: 540 passed at `maxDiffPixels: 0`** (7.9m, quiet box) — ⛔ §5 is the
> most useful thing this session learned: **under load both suites lie**, and
> `uptime` is the first thing to check before believing a red run.
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
3. **12 of the 13 decision cards have ZERO pixel coverage** — found while fixing
   §4.2 and recorded in §7. The dashboard baseline photographs the DECK, which
   shows one card at a time, so eleven cards behind the front one can be broken
   silently. `/?cards=grid` would photograph all of them for 8 baselines.
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

### 4.2 ✅ "Spending fell by **-$587.96**" — found, then fixed on request

`deltaFact` rendered signed (`+$X` / `-$X`) and its docstring explained why:
*"A delta that dropped its sign would read as a rise."* True of a delta rendered
ALONE — and false inside a sentence, because **every delta template already
states the direction in words** (`rose_between`, `fell_between`, and
`unchanged_between`, which prints no figure at all, are the entire delta
vocabulary). So the sign was redundant on the way up and a double negative on
the way down, and it had shipped on three surfaces.

I flagged it rather than fixing it mid-feature; the owner asked for the fix and
it is in.

**The shape of the fix matters.** The fact keeps its honest signed `display` —
that field is documented as the app's own formatting of `value`, and `value` is
signed. What changed is what the GRAMMAR prints: `DeltaFact` now derives a
`magnitude` beside `display`, from the same formatter and never by stripping a
character off it, and `factField` returns the magnitude for a delta's `value`
slot. That is the same decision `factField` already makes for a trend, in the
same place.

⛔ **The thing to check before removing a sign is whether the READ gate leaned
on it. It does not.** `validateProse` binds a slot to a fact and then runs the
claim's own `holds` predicate against the fact's SIGNED `value` — `rose_between`
requires `value > 0`. A fabricated "Travel rose by $42.00" over a fact that fell
is refused by that predicate, and two deltas of equal magnitude and opposite
sign are separated the same way. There is now a test that drives exactly that
case, with both facts in one set so only `holds` can tell them apart.

⛔ **And a new import-time guard, because the sentence is now the only thing
carrying the direction.** `assertTemplatesWellFormed` refuses a template that
binds a delta without a `holds` predicate — a future "X moved by $42.00" would
print identically over a rise and a fall, the gate would accept it, and nothing
downstream would notice.

Blast radius: **2 source files, 5 test files, 24 baselines** (spending,
spending-year, summary-year × 2 themes × 4 widths). No service and no component
changed, because the fix belongs entirely to the grammar layer. The dashboard
baselines did NOT move — see §7, which is why.

### 4.3 ⚠️ tsc caught fixture data that twelve green tests accepted

`reconciliation: "ok"` is not in the enum. SQLite has no CHECK constraint to
notice, so the rows inserted fine and every assertion passed.

---

## 5. ⛔ THIS BOX GETS LOADED, AND BOTH SUITES LIE WHEN IT IS

The single most useful thing this session learned, and it cost four hours.

**Green, on a quiet box:** `tsc` clean · **214 files / 4,119 unit** ·
99.76% stmts / 100% funcs · **E2E_GATE=1: 540 passed in 7.9m** at
`maxDiffPixels: 0`. Twice, reproducibly.

**Under load, both suites produce non-reproducing failures.** Across five e2e
runs and four unit runs, **fifteen different tests failed once each and not one
reproduced**; every single one passes in isolation.

| suite | quiet | loaded |
|---|---|---|
| e2e | 540 passed, **7.9m** | 507 / 538 / 539 / 514 passed, **8.5–24.1m** |
| unit | 4,119 passed | 12, then 9, then 2, then 1 failure — a different set each time |

⛔ **Diagnose with `uptime` before believing a red run.** A 1-minute load average
above ~8 on this box is enough. Sources seen this session, in order of size:

1. **A freshly started `pnpm dev`.** Turbopack's initial compile took the unit
   suite from 0 failures to **12**, including six `[vitest-pool]: Failed to
   start forks worker` — not assertion failures at all.
2. **My own concurrent work** — `npx tsx` probes and a second `vitest run`
   alongside an e2e run. One e2e spec FILE took **16.1 minutes** against 7.9
   for the whole suite when idle.
3. **Whatever else is on the machine.** Load sat at 13.17 with none of my
   processes running, 46 days into an uptime.

⚠️ **The failures are not random — they are the heaviest tests.** All six flaky
e2e specs are `zz-*` MUTATORS that click, write through a server action and
restore; no read-only spec has ever flaked. On the unit side it is the DB-heavy
files (`bulk-edit`'s past-the-variable-cap walk, `backup`'s snapshot,
`schema`'s constraint test). Under contention a server round-trip or a large
transaction takes longer and the timeout-bounded test tips over first. That
mechanism also rules this pass out as a cause: the work added here is 2–11ms of
READ on three routes and touches no server action
(`scripts/probe-insight-cost.ts`).

⚠️ **`boundingBox()` has no auto-wait** — the very first failure was
`Cannot read properties of null (reading 'height')`, the same class of trap
pass 38 recorded for `isVisible()`. It is the first thing in the e2e suite to
fall over under load, and `await expect(locator).toBeVisible()` in front of the
bare calls would harden them.

**Rule for next time: stop the dev server, wait for `uptime` to drop below ~4,
then run. Nothing else while either suite runs.**

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

## 7. 🔴 Twelve of the thirteen decision cards have ZERO pixel coverage

Found while regenerating baselines for §4.2, and it is a bigger gap than the
standing list said ("the notices card has no visual baseline").

The dashboard is a **deck** — one card at a time, the rest at `opacity: 0`
behind it. `visual.spec` photographs `/`, so the eight `dashboard-*` baselines
capture **Runway and nothing else**. Runway, the car, income, cards owed, eating
out, subscriptions, what changed, fees, transfers, performance, concentration,
notices and trust are thirteen cards; twelve of them could be rewritten, broken,
or emptied without moving a single pixel of any baseline.

Confirmed by this pass, not theorised: the delta fix changed the wording of
`notices-card`'s sentence, and **the dashboard baselines did not fail** — only
spending, spending-year and summary-year did. A real text change on a real card
was invisible to the whole visual suite.

This is the exact shape of the gap pass 58 found behind `?tab=calendar` and the
last session found on `/recurring/[id]`. The fix is one route entry:

```ts
{ path: "/?cards=grid", name: "dashboard-grid" },
```

⚠️ Safe to add, checked: `?cards=grid` is READ through `resolveViewState` and
does not write the preference — only `saveViewPreferenceAction` does, on click.
So it does not make `visual.spec` a fixture mutator and needs no `zz-` prefix.
The cost is churn: any change to any card would move 8 tall baselines. This
codebase has taken that trade four times already, on the grounds that zero
coverage is worse than churn.

Not taken here because it is 8 new baselines on top of the 24 this fix already
moved, and bundling them would make one commit's diff unreadable.

---

## 8. Still open (unchanged unless noted)

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

## 9. Notes that keep costing time

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
