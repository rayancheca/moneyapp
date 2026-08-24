# THE PROGRAM — passes 60 → ~94

> Written 2026-08-21, from [`docs/whats-left-by-page.md`](whats-left-by-page.md).
> Ordered as the owner asked: **the "what else could be done" ideas first**, then
> the standing queue, then hosting and iOS last.
>
> Scope: **everything**. Every open item in the per-page inventory and every idea
> in its Part 2. Nothing is dropped; where something should be *deleted* rather
> than built, that decision is itself a scheduled line.
>
> **Estimate: ~35 sessions**, in nine phases. Phases I–IV (16 sessions) carry
> almost all of the value; V–VIII are the standing queue; IX ships it.

---

## How every session runs

Unchanged from the last 59. Each pass is one focused slice that ends green.

1. **Read** the previous handoff's §0 first, then measure the state — never quote it.
2. **Pure-first TDD.** New math goes in `src/lib` at 100% coverage before any
   renderer exists. Services next, UI last.
3. **Adversarial review** after the code, before the handoff: at least three
   lenses, each trying to *refute* the change rather than confirm it.
4. **Gates before the handoff:** `tsc` clean · unit suite green · coverage gate
   exit 0 · `pnpm ledger-check` exit 0 · `E2E_GATE=1 pnpm e2e:fresh` green with
   baseline churn either zero or *explained line by line*.
5. **Real-DB writes** only behind a `.backup` restore point, with Δ-guards that
   assert what must not move (net worth, today's balance, active row count) and
   a post-condition that throws rather than leaving a bad database.
6. **Commit + push between items**, `git -c credential.helper='!gh auth git-credential' push origin main`.
7. **One handoff at the very end of the session**, not per item.

**Standing rules that outrank convenience**

- No fabricated numbers, ever. Every figure traces to a source document, and if
  it cannot, it is labelled *estimated* with its basis named.
- When a reading is genuinely the owner's call, **ask** — early, as a concrete
  either/or — rather than guessing and writing it down as fact.
- A green gate is not proof. Make something try to refute the result.
- Never propose a hosted-DB migration.

---

# PHASE I — The decision layer

*Six sessions. The app knows what happened; this phase makes it say what that
means.* This is the half the owner said he wanted first.

### ✅ Pass 60 — Cash income, part 1: the engine — SHIPPED 2026-08-21

The largest structural gap between the ledger and his life. July income reads
$52.95 against a cash job paying roughly $1,046/week — correct by design, and
useless as a picture of what he earns.

- Pure `src/lib/cash-earnings.ts`: given ATM deposits, `Cash on Hand` movements,
  a declared weekly rate and a set of *classified* deposits, produce an estimate
  with an explicit basis and an explicit unclassified remainder. 100% covered.
- **It offers, it never asserts.** "ATM deposit" already means three different
  things on this ledger (his cash float, a loan repayment, his mother's cash), so
  the engine's output is always `{ estimatedCents, basis, unclassifiedCount }`
  and never a bare number.
- An interactive classification pass over the real ATM rows, in the app, with the
  owner — the same shape as pass 59's categorisation session, `source='user'`
  stamped so no import can re-stamp it.
- **Gate that matters:** reconciled all-time income must not move by one cent.

### ✅ Pass 61 — Cash income, part 2: the honest surfaces — SHIPPED 2026-08-21

- A second income line wherever income is shown — dashboard, `/spending`,
  `/categories/[id]` for Income kinds — reading *"Banked $52.95 · Estimated cash
  $4,184 — estimated, 3 deposits unclassified"*.
- Drawn in the grammar the app already owns for uncertainty: the dashed
  `complete:false` treatment, and a basis chip that names *why* it is an estimate.
- Never summed into the reconciled figure. The two numbers stay adjacent and
  separately labelled, and every view that could confuse them gets an `InfoTip`.
- New e2e: the estimate is visible, is labelled, and the reconciled figure beside
  it is byte-identical to before the feature existed.

> **⚠️ What passes 60–61 actually found, 2026-08-21. The plan's premise was
> wrong and the correction is worth carrying forward.**
>
> The app is **not** blind to cash income. Every ATM deposit in the ledger is
> already classified by hand, all `source='user'`, so **the interactive
> classification sitting pass 60 was built around had no input**. Cash income is
> counted whenever it is banked and tagged — June 2026 booked $1,447.00 of
> `Income > Salary` from two Miami ATM deposits.
>
> The real gap is **timing**: cash is earned continuously and banked in lumps.
> Measured since the job began, `2026-06-01 → 2026-08-21`:
>
> | | |
> |---|---|
> | implied by the confirmed schedule | **$12,552.00** over 12 pay periods |
> | actually banked | **$1,447.00** |
> | gap | **$11,105.00** |
> | last banked | 2026-06-05, **11 paydays** of silence |
>
> The owner confirms the job is still running at ~$1,046/wk, so that gap is real
> earnings that never touched a bank — $5,000 of it demonstrably went to the car
> deposit through the `Cash on Hand` anchor.
>
> Two defects fell out of building it, both now fixed:
>
> - `recurring_series.last_matched_on` **froze** whenever a series dropped below
>   `MIN_OCCURRENCES = 3` linked rows, because it was bundled into an
>   all-or-nothing early return with the statistics. It is not a statistic. Five
>   series on the live DB were asserting dates with no row behind them; the cash
>   job claimed pay was 46 days old when the evidence said 77.
> - and my own `periodsSinceBanked` was off by one whenever a deposit landed off
>   the payday — which is exactly what the real data does.
>
> **Still owed from pass 61:** the note has no VISIBLE e2e state. The simulator's
> cash series banks on time to `FAKE_TODAY`, so only the silent case renders.
> Seeding a schedule that has gone quiet moves income totals across several
> baselines, so it is folded into **pass 75**'s state-coverage audit rather than
> regenerated incidentally here.

### ✅ The two open decisions, closed — SHIPPED 2026-08-24

Both items §2 of the pass-60 handoff left open were the owner's to make, and he
made them with the measured numbers in front of him.

**1. A `series-stale` income series KEEPS feeding expected income.** Owner:
*"Leave both pages as they are."* `/spending` says the cash job has banked
nothing in eleven paydays and the money may not be coming; `/budgets` still
projects a full month from it. They answer different questions, and suppressing
the second would tell a working man he has no income. **No code changed** — the
decision is recorded in `incomeExpectation`'s docstring so the next pass does not
"fix" it. ⛔ Do not reopen without asking again.

**2. The over-allocation header is graded against an ANNUALISED rate**
(`01eca64`). Owner: *"Annualise, name the month underneath."* Measured twelve
months forward before and after:

| | before | after |
|---|---|---|
| 4-payday month (×8/yr) | over-allocated **$318.29** | **$30.71 left** |
| 5-payday month (×4/yr) | **$728.71 left** | **$30.71 left** |

`src/lib/income-basis.ts` returns the figure, its definition, the over-allocation
clause and the month sentence from ONE branch. The calendar month is named
underneath, not deleted: *"4 paydays fall in this month, scheduled at $4,188.00 —
$349.00 under the annualised figure above."*

> **⚠️ The adversarial review found two real defects in that commit, and the
> worse one is the lesson.** Twenty agents, four lenses, sixteen findings.
>
> - **A rate is a FLOOR, not a ceiling** (`ca912ad`). The levelled branch
>   published its rate unconditionally and dropped the old
>   `max(posted + still-due, forecast)`. Reproduced end to end: $5,000.00 of
>   salary posts, the detector picks up a **fourteen-cent** INTEREST PAYMENT
>   series — one it creates by itself on the real fixture — and the header reads
>   **$0.14 expected income** with every budget over-allocated behind it. The
>   floor is `postedCents` and nothing else: flooring on the SCHEDULE hands back
>   the very swing the levelling removes.
> - **My own test asserted the rule that caused it.** *"Posted actuals never
>   inflate the basis — a lumpy month is not a raise"* was a stricter rule than
>   the app had ever had, and it is what deleted the floor. A test can encode a
>   defect as confidently as code can.
> - **The hard-coded clause.** *"— these budgets total more than this month is
>   expected to bring in"* stayed in the JSX while the yardstick became a rate;
>   in the four five-payday months a year it states the reverse of the note two
>   lines beneath it. The commit claimed the one-branch rule and broke it in its
>   own page.
> - Three surviving mutants closed in `7e41fca` (`Math.round`→`floor`,
>   `BASIS_HORIZON_MONTHS` 12→6, the three clauses collapsible into one).
>
> **Known and accepted, not defects:** a series with `user_ends_on` mid-month
> keeps its full rate for that month (latent — `user_ends_on` has no writer in
> the app; **pass 84's episode editor will create one, so fix it there**), and a
> series whose cadence label disagrees with its measured gap levels from the
> label (pinned as a decision, with the reasoning, in `budgets.test.ts`).

### ✅ Pass 62a — Net-worth attribution: the engine — SHIPPED 2026-08-24

*Net worth moved from X to Y. Why?* — the arithmetic half. **Pass 62 split**; the
chart is 62b below, and the reason is at the end of this entry.

> **⚠️ The plan's premise was partly false, and measuring said so before any
> code.** It claimed "every component already exists in a service (`periodTotals`,
> `market_change_cents`, the Family pass-through category, `inTransitCents`) —
> this assembles them and proves they close." Measured:
>
> - **`market_change_cents` cannot supply a windowed market term.** Populated on
>   16 of 219 `statement_periods` rows, every one Robinhood Crypto, newest period
>   ending 2026-06-30. Robinhood Brokerage — the larger account, +$9,648.16 in
>   July–August alone — has **no statement periods at all**.
> - **`periodTotals` is not a partition of net-worth movement.** Over 2026-07-01 →
>   08-24 it reports net **−$16,468.15** while net worth **rose $26,424.71**:
>   wrong in sign, off by $46,326.64. It drops +$18,870.53 of transfer- and
>   investment-kind rows by design.
> - **`src/db/derive/**`, cited by the plan, does not exist.** The engine is
>   `src/services/derivation.ts` + `crypto-history.ts`.
> - `inTransitCents` IS the right idea, and is $0.00 on every window ending today.

**What is true, and is what the pass rests on: the identity closes.** Measured
across seven windows from one month to the full four-year axis, *before* writing
anything:

    Δ net worth = transactions on REPLAYING accounts
                + market gain + portfolio flow + Δ in transit
                + unexplained

`unexplained` is exactly **$0.00** on every window spanning neither an account
opening nor a manual anchor — and on the three that do, every cent has a NAME:
$5,000.00 (Cash on Hand's manual anchor, the owner's untracked float, deliberate)
and $20.19 (Robinhood Brokerage entering coverage, 2024-07-10). **7/7 windows
fully accounted for.**

| | |
|---|---|
| `src/lib/attribution.ts` | pure, 100%, `unexplained` is SUBTRACTION only |
| `src/services/attribution.ts` | the queries, each chosen so the identity closes |
| `marketChangeBetween` | the window slice that lived only in a client hook |
| `inTransitAt` / `inFlightDeltaOn` | the float boundary, written twice, now once |

🔴 **A test caught a defect that would have shipped green.** The replay divider
was written as "investment type AND has holding events" — the same set as
"investment type" on today's ledger. A bare value-anchored investment account
does not replay either (`deriveDailyRows`: *"value anchors + step-hold; replay
never applies"*), so the narrow divider would have double-counted the market term
the moment one existed. ⛔ And never `investmentSideAccountIds()`, which includes
the settlement-cash sibling — typed `checking`, replayed, 1,989 rows worth
−$55,659.37.

🔴 **The adversarial review found three more** (`ca912ad` → `df3a17a`): archived
accounts were read by the bands but not by net worth (every net-worth surface is
active-only, so the bridge would report a hole it invented itself); the CLOSING
window bound was unpinned (`lte` → `lt` survived all 13 tests); and
`reason: "opening"` was **dead code** for a replaying account — removed rather
than defended. Six further surviving mutants killed. All 14 now die.

### Pass 62b — the waterfall, and the surface it lives on

**Part one shipped 2026-08-24** (`34756ad`): `src/lib/waterfall-layout.ts` at
100%, plus the contrast gate the palette test was missing. Two geometry decisions
are made and pinned:

- **The axis is the excursion, not zero**, and `axisStartsAtZero` is a first-class
  output so the renderer must disclose it. Zero-anchored, `earned` is 0.05% of the
  height on the real window.
- **A band too small to draw is MARKED, never floored.** `deviation-layout`'s 2px
  minimum is right for bars that need not sum to anything; a waterfall's whole
  claim is that the parts add up, and a floored bar makes the geometry visibly not
  close. `earned` is 0.18px and stays 0.18px; `belowHairline` says so.

**Still to build — everything is specified, nothing is decided-by-default:**

- The bespoke-SVG renderer. ⛔ The plan's cited precedent is wrong:
  `AllocationDonut` is **recharts**, not bespoke SVG. `SankeyChart` is the real
  exemplar — copy its `<title>`-not-`role="img"` a11y model (role="img" prunes
  the nested drill `<a>` from the a11y tree), its modified-click passthrough, and
  its `useId()` for element ids (ChartFocus mounts the panel TWICE).
- ⛔ **Hue can never be the only carrier of direction.** Measured: `--positive`
  and `--negative` are contrast **1.00** apart in light theme, 1.35 in dark. The
  house answer is PnlCalendar's aria-hidden ▲/▼ over neutral numerals. A test now
  pins this as a limit.
- **Split `moved` into named bands.** The plan's own spec lists *family
  pass-through* as a component and it is currently inside `moved`. Measured:
  `Transfers > Family pass-through` is **+$43,863.44 across 28 rows, all in Chase
  Checking, all unpaired** — and `docs/adversarial-review-2026-07-27.md` finding
  81 records that **every one of the top eight single-day net-worth moves in the
  series is a Family pass-through row**. Naming it is most of this band's value.
- **Where it lives.** `PeriodSelector` already takes a `basePath`, and
  `resolvePeriod` + `stepPeriodParams` give a window and its predecessor — the
  "moved from X to Y" framing, ready. A new route costs 8 visual baselines, 2 axe
  tests and 3 overflow tests (`overflow.spec.ts` enumerates `src/app/**/page.tsx`
  off the filesystem and FAILS unless the route is listed). A dashboard chart
  option instead auto-generates its own tests from `DASHBOARD_VIEW_SPEC`.
- **Seed the fixture first.** The e2e taxonomy has no `Family pass-through`, and
  `unexplained` has no seeded non-zero case, so those bands would photograph as
  structurally $0 in every baseline — the pass-53 blindness, exactly.

### Pass 63 — Runway, and the car priced all-in### Pass 63 — Runway, and the car priced all-in

Two decision cards over one new engine.

- Pure `src/lib/committed.ts` — committed outflows over the next N months from
  confirmed recurring series, anchor days, and overdue bills.
- **Runway:** cash + income cadence vs committed outflows → "N months", with the
  assumptions listed and each one clickable.
- **The car:** lease $559.89, insurance $361.49 ×6, $5,000 down (currently the
  only un-evidenced −$5,000 in the ledger), plus charging and any car-category
  spend → "$X/month all-in, Y% of everything you spend", with pre-car and
  post-car spend measured rather than assumed.

### Pass 64 — The year-end summary

January is coming and this turns a week of spreadsheet work into a page.

- New route `/summary/[year]`: Fordham direct-deposit wages, Knack tutoring,
  dividends, interest, realized gains with the XIRR already computed, gambling
  kept separate, family pass-through kept out.
- **Every figure cites its source document** — this is a data summary with
  provenance, explicitly not advice, and the page says so in its own words.
- Print stylesheet, because this one gets printed.

### Pass 65 — Merchant intelligence

`/merchants/[id]` is 91 lines across 893 merchants — the thinnest real page in
the app.

- Spend over time with the full ScrubChart kit, cadence pulled from the recurring
  engine (which already knows), first and last seen, average ticket, category
  mix, year-over-year.
- "You spend $X a month here" — the number a merchant page exists to give.
- Reachable from somewhere other than a transaction row.

---

# PHASE II — Provenance made visible

*Four sessions. Sixty passes bought a ledger where every number is provable and
there is no UI anywhere that shows it.*

### Pass 66 — The provenance service and the "prove it" primitive

- `src/services/provenance.ts`: given any rendered figure's identity, return
  which import file, which statement period, which arbiter graded it, what basis
  the day carries, and when it was last checked. All four tables already hold it.
- A `<ProvenancePopover>` primitive with the popover-focus doctrine the app
  already enforces, keyboard-reachable, and honest when the answer is *"this is
  derived, and here is what it was derived from"*.
- First surfaces: the dashboard hero, account balances, statement periods.

### Pass 67 — The "prove it" sweep

Wire it to every number that has a source: transaction rows, category totals,
budget actuals, holdings values, recurring amounts, the net-worth chart's scrub
readout. Where a number *cannot* be proved, the popover says so plainly — that
is the more valuable answer.

### Pass 68 — Data health, and statement-due where he looks

- `/imports` gains the surface it is missing: not what *was* imported but what is
  **missing** — every coverage gap with the exact statement to fetch, every
  account behind its cadence.
- `CoveragePanel` stops hiding `verifiedThrough` behind `case "verified"` and
  renders **"closed through X, first hole Y"** for broken and unverified
  accounts — the version pass 58 named as the one worth building.
- `StatementSchedule` already computes cadence; surface "Robinhood is two months
  behind" on the **dashboard**, not only on the page he visits when already uploading.
- `daysSinceVerified` gets a consumer here, or gets deleted.

### Pass 69 — Neutral notices

- A subscription whose price changed; a charge 4× a merchant's own median; a new
  merchant with a large first charge.
- **Neutral wording is the whole design.** He travels and drives an EV, and three
  "card-testing probes" once flagged were all legitimate. The notice describes,
  it never accuses.
- This is also where `paid_different` finally gets rendered coverage — a real
  state that no test has ever reached.

---

# PHASE III — Ask the ledger

*Three sessions. The ambitious one.*

### Pass 70 — The query layer

- Natural language compiles to a **query**, never to a number. A schema-aware
  compiler over an explicit allowlist of tables, columns and aggregate shapes;
  anything outside it is refused, not improvised.
- Read-only by construction: a separate connection, a statement allowlist, a row
  cap, a timeout. No write path exists to abuse.
- Golden-question test suite: ~40 questions with known answers computed
  independently from the services, so a regression in the compiler is a failing
  test rather than a wrong answer.

### Pass 71 — The answer surface

- A question box that returns **a real chart plus the rows the answer used**.
  Every answer is clickable down to the transaction, and every transaction is
  traceable to a statement — which is exactly what Phase II built.
- Reuses the existing chart registry, so an answer is a first-class chart with
  focus, lens and drill, not a screenshot.
- Cost control against the AI spend cap already in Settings, and the "is a key
  present?" indicator that would have saved a debugging session.

### Pass 72 — Hardening

- Adversarial pass whose whole job is to make it lie: ambiguous questions,
  questions about data that is not there, questions that invite a hallucinated
  number.
- The required behaviour is **refusal with a reason**, and the reason has to be
  true. A wrong answer must be visibly wrong, never plausibly wrong.

---

# PHASE IV — Finish the correctness program

*Three sessions. After this, every account in the ledger can fail a check.*

### Pass 73 — The Robinhood Brokerage arbiter

The last account without one, and fully specified already.

- Emit a second `ParsedStatement` from the brokerage profile with an investment
  `period` anchored on **`Total Securities`** — first occurrence only, since a
  second account section repeats the label and `Total Market Value` is the
  stock-lending subtotal.
- Extend `pnpm ledger-check` to fail when printed and holdings-derived diverge by
  more than a cent. Across 24 statements: 16 exact, 2 within a cent, 6 that
  genuinely disagree — worst −$667.86 on 2025-04-30.
- Also: the one `live` anchor written for a past day gets reclassified `manual`,
  or the schema note that forbids it gets corrected. One of the two must give.

### Pass 74 — Verdicts that cannot go stale, and an arbiter that runs itself

- Call `reconcileAccounts` from `rebuildAccount` so a stored verdict cannot stop
  describing the ledger beneath it. ⚠️ Its quarantine side effect is now **live**
  on Robinhood Cash since the crypto rows belong to the statement's own file —
  assert statuses around the call, and prove nothing moves.
- `pnpm ledger-check` moves from "run it when someone thinks to" to a pre-commit
  hook or a scheduled run, so drift is caught the day it happens.

### Pass 75 — The states nothing reaches, and getting the data out

- **State-coverage audit:** enumerate every discriminated union the components
  switch on, check which variants a fixture has ever produced, then seed them or
  delete them. `paid_different` was found by hand; there are almost certainly others.
- **Export everything** — CSV and JSON, every table, from Settings. Four years of
  reconciled history currently live in one gitignored SQLite file, and this is
  the cheapest disaster insurance available.
- Restore counterpart to `BackupsManager`, and a theme preference.

---

# PHASE V — The queue: interaction

*Five sessions.*

### Pass 76 — Cluster cards that can make a partial decision

P1.1 — the oldest unbuilt ask in the backlog, in his own words on 2026-07-14:
*"I can't even expand to see the data… what if I want to confirm specific ones
and not others."*

- Expand a cluster to its full member list, virtualised past ~50 rows.
- Per-row checkboxes and `confirmSelectedAction(ids)`, reusing bulk-edit's undo.
- Within-cluster filter and sort; header showing sum, count and date span so
  "Confirm all" becomes an informed act rather than a leap.

### Pass 77 — Focus and lens sweep, part 1

`/flow`'s five views (Tower, Matrix, Rhythm, Spine, Sankey) — the richest visual
surface in the app and entirely locked to inline size — plus `/spending`'s four
charts. Focus mode and a table lens on each.

### Pass 78 — Focus and lens sweep, part 2

`/categories/[id]` (`MonthlyTrendBars` gets the full ScrubChart treatment),
`/investments` (donut, PnlCalendar, TopMovers, PortfolioStats, RealizedSales),
`/accounts/[id]` (`AccountHoldingsTable`) — and the `FocusableCard`
generalisation so P2.3's "expand every dashboard card" finally lands.

### Pass 79 — Coverage transparency

- **P2.1** — "+2 more" stops being a dead end: a disclosure listing every covered
  and missing account, on the hero, the chart header and the scrub tooltip.
- **P2.2** — the chart names the *cause* of a gap: "Chase ····3522 uncovered —
  statement 2023-10-13→11-10 missing", derived from the `statement_periods` hole.

### Pass 80 — One chart-type registry on `/spending`

Stacked, donut, heatmap and Sankey stop being separate cards and become options
on a single switcher — the last unbuilt piece of the parity roadmap.

---

# PHASE VI — Multi-episode recurring

*Four sessions. The largest thing he asked for in his own words that has never
been started.* A recurring charge is not one cadence forever — StephanCodes ran
three months and stopped; Netflix ran on the 5th, stopped for a year, came back
on the 13th at a different price.

### Pass 81 — S11: schema and projection

`recurring_episodes` table + migration, each existing series migrating to one
open episode behaviour-preservingly. Episode-aware `isSeriesActive`,
`toProjectable` and `forecast`. Projection math pure and 100% covered — and a
closed episode projects nothing, which is what fixes the wrong "Next expected"
on all 11 series already marked `ended`.

### Pass 82 — S12: auto-split by gap analysis

For each detected series, split its charge history into episodes where a gap
exceeds ~2× the local cadence, and infer each episode's own cadence and day.
StephanCodes → one closed episode. Netflix → several. A detected episode is a
hypothesis the owner confirms, never a fact.

### Pass 83 — S13: the calendar and list grammar

Active occurrences solid, past-episode occurrences muted, cancelled gaps
explicit. The series list groups active from historical. Also lands the
**week-level total** the calendar has never had — which needs the `role="grid"`
decision made properly, since an eighth column breaks the seven-day arrow math.

### Pass 84 — S14: the editor, and attach-from-a-transaction

- Per-episode editor on the series detail page: add, remove, set start and end,
  cadence and day, amount, one-click "mark ended", per-episode cadence sentence.
- **The attach flow he described:** click a transaction → "Recurring…" → create
  or attach → define this episode → **preview every matching transaction** →
  confirm to attach *and categorise them all in one gesture*. Never overwrites a
  `user` category — the same precedence doctrine as the transfer detector.

---

# PHASE VII — Explanation and polish

*Four sessions.*

### Pass 85 — The app explains itself everywhere

`InfoTip` reaches 2 of 11 pages today and `SectionNotes` 3. Both go everywhere
they earn their place — starting with `/imports`, the most jargon-dense page in
the app, and `/transactions`, where `quarantined` / `excluded` / `superseded`
have very different money semantics and sit unexplained on a tab bar. That last
one has a track record: `excluded` silently moving money through the replay chain
is exactly what hid the fabricated plug.

### Pass 86 — Budgets

Which bill is overdue, not just how many. Rollover visible in aggregate across
all 11 budgets. And an **income-side budget** — for a cash-paid job, a target
earnings counterpart is arguably the number that matters most.

### Pass 87 — The polish bundle

`ForecastCard` gets hierarchy (measured: a five-column `<dl>` where every value
shouts equally, third pass carrying it) · `AmountHistoryChart` gets scrub, range
and table · balance-history % stops reading `+14636.2%` on a near-zero baseline ·
`ScrubChart`'s <2-point window stops disagreeing with its panel · `NumberRoll` in
StatCards and account balances · the investment account-detail chart carries
forward to today · `aria-live` on the period panel gets measured with a real
screen reader.

### Pass 88 — Category merge, and the splits decision

- **Merge** needs its own guarded data pass: budgets, rules JSON, merchant
  defaults and suggestions all reference a category id. Deferred twice for that
  reason; do it properly, behind a restore point.
- **Splits**: 0 used in 10,072 transactions. Either surface it where it would be
  used — a prompt on a large mixed-merchant charge — or retire the surface. Decide
  with evidence, then act on the decision.

---

# PHASE VIII — Motion and gesture

*Two sessions. All compositor-only, all reduced-motion gated, every drag with a
keyboard twin.*

### Pass 89 — S10b micro-interactions

Categorize checkmark-draw, tasteful confetti on clearing a review cluster, spring
hover on chips and buttons.

### Pass 90 — Gestures and route transitions

Drag-reorder institution cards, kanban drag between categories, re-parent by drag
— **or a written decision to delete each**, since the chip picker and Move menu
already cover two of the three. Then app-wide View Transitions beyond the current
`template.tsx` fade-rise.

---

# PHASE IX — Ship it

*Three to four sessions. Gated behind everything above, on standing orders.*

### Pass 91 — Auth

`requireSession()` across all 103 server actions, per
[`docs/deploy-plan-gcp-firebase-auth.md`](deploy-plan-gcp-firebase-auth.md). The
middleware Host fix. A hostile pass over every action that currently trusts its
caller.

### Pass 92 — Deploy and verify

The chosen path executed, the real database moved once and proven byte-identical
on the other side, every arbiter re-run against the hosted copy. **No hosted-DB
migration proposal** — the file goes as it is.

### Passes 93–94 — iOS

Genuinely unknown until 92 lands; two sessions is the floor, not the estimate.

---

## Session count

| Phase | Sessions | Passes |
|---|---|---|
| I — the decision layer | 6 | 60–65 |
| II — provenance made visible | 4 | 66–69 |
| III — ask the ledger | 3 | 70–72 |
| IV — finish correctness | 3 | 73–75 |
| V — queue: interaction | 5 | 76–80 |
| VI — multi-episode recurring | 4 | 81–84 |
| VII — explanation and polish | 4 | 85–88 |
| VIII — motion and gesture | 2 | 89–90 |
| IX — ship it | 3–4 | 91–94 |
| **Total** | **34–35** | **60 → 94** |

Phases I–IV are **16 sessions** and carry almost all of the value. Everything
after is the standing queue, polish, and shipping.

Sessions will merge and split as they meet the code — that has happened in
roughly a third of the last 59 passes, and the plan is expected to be edited
rather than obeyed. What will not move is the ordering: the decision layer first,
because that is what was asked for, and hosting last, because that is the
standing order.

## Four things only the owner can answer

Asked at the moment they block, not up front.

- **Pass 60** needs the ATM rows classified, and the weekly cash rate confirmed.
- **The $560.54 on 2026-07-29** — self-to-self, routing 021000021. Which account
  did it leave?
- **Dad's remaining ~$5k** via Arno Search Capital LLC — family pass-through,
  never income.
- **Statement uploads**: Robinhood July and August, SoFi August. Pass 73 wants
  the Robinhood ones.
