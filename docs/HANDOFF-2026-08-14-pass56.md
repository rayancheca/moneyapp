# Handoff — 2026-08-14, pass 56

> **`main` = `1dd0d3c`**, tree clean. tsc clean · **161 files / 2,962 unit** ·
> coverage gate exit 0 · `next build` clean · **`E2E_GATE=1` 414 passed**
> (410 before) · zero baseline churn.
>
> The queue from pass 55 §2 items 1–3 is **empty**. What remains of that list is
> hosting + auth, which is LAST by standing instruction.

## 1. Shipped

Three items, three commits, each pushed separately.

| # | commit | item |
|---|---|---|
| 3 | `7452602` | the fixture-shape check runs on every e2e invocation |
| 1 | `22af9ca` | holdings date their own price — but only when they disagree |
| 2 | `4dc083d` | the over-allocated header branch is rendered by a test |

### 1.1 The fixture-shape gate (`7452602`)

`pnpm assert-fixture-shape` guarded the pass-53 fix and **nothing ran it**. The
rules now live in `scripts/fixture-shape.ts` (pure, unit-tested) with two
callers: the standalone script and `e2e/global-setup.ts`.

⚠️ **Not `src/lib`, despite the 100% coverage threshold there being the obvious
draw.** `assertBundleIsFresh` (`e2e/global-setup.ts:38-40`) walks **only** the
`src` tree and throws when anything in it is newer than `.next/BUILD_ID`. A
harness-only checker in `src/lib` would make `pnpm e2e` refuse to run after
every edit to it, until a full rebuild, for a file that is never in the bundle.
`scripts/**/*.test.ts` is already a collected vitest glob, so the rules still
get unit tests — they just carry no coverage threshold.

⚠️ **Not gated on `E2E_GATE`.** It reads the database global-setup just built
rather than seeding a second one, so there is no speed argument; and `E2E_GATE`
is unset for `pnpm e2e:update`, the command that **regenerates baselines**.
Gating would have left the hole open at the one moment it ships.

Two holes closed on the way:

1. the loop was driven by the **query**, not the contract — deleting a symbol
   from `SEED_SECURITIES` made the script print three lines and **exit 0**;
2. closes were read **by symbol alone**, but `price_cache` is unique on
   `(symbol, asset_type, quoted_on)`. **`WMT` is an `etf`, not a stock** — one
   seeded symbol away from mattering.

`SEEDED_SERIES` deliberately **duplicates** the seeder instead of importing from
it. Importing would mean deleting a symbol from the seeder also deletes its
expectation, and the check would pass by agreeing with the mistake.

### 1.2 Per-row price age (`22af9ca`)

`HoldingRow.quotedOn` was computed for every row and rendered nowhere. It is now
an 11px sub-line under the Price cell — the idiom the component already uses
twice. **Not a 7th column**: `holding-cycle.ts:5-7` documents that a 7th
standing column overflows the desktop grid.

It speaks under **two** gates, and the second is the interesting one:

1. the row's close is older than today;
2. **the rows disagree about their close date.**

Gate 2 came from a measurement, not a preference. All ten holdings in the real
portfolio share one `quotedOn`, so without it this would have stamped an
identical `as of Aug 6` down all ten rows — restating ten times the single
sentence the page note already prints.

**The note structurally cannot say which rows are stale.**
`holdingPriceSectionNotes` is gated on the **newest** close across the page, so
ONE refreshed symbol silences it while every other holding is a week behind.
That gap is the entire reason per-row dates exist, and it is now pinned by a
test rather than left as an argument. Both surfaces share `isStaleClose`, so
they cannot drift on **where** the boundary is — only on which population they
apply it to, which is the point.

### 1.3 The over-allocated branch (`4dc083d`)

The old header test asserted `/left to allocate|Over-allocated by/` — an
alternation that **passes in either state**, which is exactly how a branch stays
uncovered while looking covered. It is now exact, and a new test drives the
amount editor to $8,000.00 of Food ($10,290.00 of budgets against $7,662.00 of
income) to render the other half.

Rejected: inflating the shared fixture. It would churn baselines, invert
Housing's `over` verdict that five assertions depend on, and would not add
coverage — it would **trade** it, making the positive branch the unrendered one.

### 1.4 What the adversarial review then found (`1dd0d3c`)

Three lenses over the diff, nine agents, every finding independently verified by
a second agent instructed to refute it. **Six findings, three confirmed, three
refuted** — and the confirmed ones were real defects in code that was already
green through every gate.

🔴 **The bend check would have blessed a ruler.** `Math.sign(0)` is `0` — a
THIRD value, distinct from -1 and +1 — so comparing raw deltas scored every
entry into and exit from a FLAT day as two "direction changes" on a series that
never reverses. A mathematically perfect ramp whose daily step is smaller than a
cent rounds to a staircase of zeros and one-cent steps, and **scored 0.814
against a 0.2 threshold**: the pass-53 defect sailing through the one check
built to catch it. Measured before and after — that ramp now scores 0.0% and
fails. Flat days are filtered out before the comparison, a series with fewer
than two non-flat days is a failure outright, and the denominator is now the
number of comparisons actually made. The real fixture is unaffected (64.5–67.8%).

This bug was inherited verbatim from the original script, but it shipped as a
"rule" module with tests claiming it catches rulers, so it belonged to this pass.

🔴 **The `>= 0` boundary in the budgets ternary was untested.** The new test
jumped straight to over-allocated and never touched exactly zero, so weakening
`>= 0` to `> 0` kept every test green — and at zero that renders "Over-allocated
by $0.00". The test now sets Food to $5,372.00 first, hitting the boundary
exactly ($3,090.00 − $800.00 + $5,372.00 = $7,662.00 = the income), and the
`> 0` mutation now fails.

🔴 **A test of mine passed for the wrong reason.** "The pinned last day cannot
flatter a straight series" used a final delta pointing the SAME way as the
trend, so the exclusion it claimed to test changed nothing. Worse, one extra
turn cannot move a 60-day series across the threshold, so ANY pass/fail
assertion there was untestable. It now asserts the reported turn COUNT with a
reversing final delta, where including the last day would score exactly 1.

Refuted and deliberately not changed: a NaN turn-rate for a 2-close series
(unreachable behind `MIN_CLOSES`), a denominator quibble that assumed a
different metric, and a claim that the budgets test leaks $8,000.00 into later
specs (the scenario does not hold — and a failed run is red anyway).

## 2. ⚠️ One judgement call to overrule if you disagree

**On the owner's real data this pass renders no visible change on
/investments.** Measured: all live holdings share exactly one `quotedOn`, so
gate 2 above suppresses every row date and the page note handles it alone. The
feature appears the moment the holdings drift apart — a partial refresh, a
provider gap, a delisting.

If the preference is "always show the date on a stale row, even when they all
agree", it is a one-line change: `dates.size > 1` → `dates.size > 0` in
`src/lib/holding-price-age.ts`, plus deleting the uniform-case test in
`e2e/zz-zz-zz-price-age.spec.ts`. Both directions are defensible; this one was
chosen because ten identical strings in a scannable numeric column is
repetition, not information.

## 3. What is left

1. ⛔ **Hosting + auth, LAST by standing instruction.** Plan is written
   (`docs/deploy-plan-gcp-firebase-auth.md`); the work is `requireSession()`
   across ~103 server actions. **Never propose a hosted-DB migration.**
2. `docs/future-ideas.md` — the master backlog — holds **26 open** items.
   (Pass 55 said "26 open against 37 done"; the done-count is **35** by `- [x]`
   marker. The open count was exact.) Several of those are programs rather than
   items — "predictions everywhere", Robinhood parity, recurring as
   multi-episode, "nothing read-only" — so emptying that list is realistically
   6–10 more passes, and which of them you actually want is worth choosing
   before starting.

Deferred deliberately, with reasons:

- **`AccountHoldingsTable` has the identical unrendered `quotedOn`**
  (`src/services/holdings.ts:216`). Fixing it from the same lib function is
  cheap, but it churns the `account-detail-*` baselines, so it was left out of a
  pass whose blast radius was otherwise zero. It is a genuinely small item.
- **A deliberately stale seeded security** would let a pixel baseline witness the
  stale branch. Rejected here: it changes `SEED_SECURITIES`, which feeds the
  portfolio series, movers, allocation, the dashboard teaser **and**
  `scripts/fixture-shape.ts`. Worth its own item if ever wanted.

## 4. Notes for the next session

- **A gate you have not mutated is decoration.** Every gate added this pass was
  mutation-tested, and each mutation was confirmed applied *and* confirmed
  restored with `cmp -s` — this repo has been burned three times by mutation
  harnesses that silently tested nothing. One mutation (`{false && …}`) turned
  out to be **invalid**: it broke TS narrowing and never compiled, so it proved
  nothing until replaced with a regression that actually builds.
- **`e2e/global-setup.ts:78` can throw `ENOTEMPTY`** on `data/e2e-originals`
  even with `{recursive: true, force: true}`. Hit once, cleared with `rm -rf`,
  did not recur. Pre-existing and unrelated to this pass — but if a run dies in
  global-setup before the seed, that is the first thing to check.
- **The scout that proposed `src/lib` for the fixture checker was wrong**, and
  the adversarial verifier caught it. Both halves of that pattern earned their
  keep this pass: the scouts were right about the shape of every item, and the
  verifiers caught two things that would have shipped bugs (this, and a claimed
  invariant between the note and the row helper that is simply false).
- 🔴 **Every gate in this pass was green BEFORE the review found three real
  defects in it.** tsc, 2,960 unit tests, 100% `src/lib` coverage, 414 e2e, zero
  baseline churn — and a perfect ruler still passed the ruler check. Green gates
  measure the questions someone thought to ask. The review was worth more than
  any of them, and the cheapest of the three findings to have missed would have
  been the most expensive: it would have re-armed the exact trap pass 53 paid
  for, while displaying a reassuring 67% turn rate.
- **`Math.sign(0) === 0`** is worth remembering on its own. Any "did this
  reverse?" comparison over deltas has this hole, and it fails OPEN — flat days
  inflate the score toward passing.
