# Handoff — twenty-five phrasings of one boundary, a 15% faster app, and a harness that stops lying

> **Supersedes `HANDOFF-2026-08-31c-the-income-answer-and-the-split.md`.**
>
> **`main` = `4801441`** (last code commit; this doc follows it), tree clean,
> pushed. tsc clean · **4,432 unit in 13.4s** · coverage gate exit 0 ·
> **E2E_GATE=1: 591 passed at `maxDiffPixels: 0` in 8.2m, zero failures** ·
> 40 baselines regenerated, every diff cropped and read first ·
> `pnpm ledger-check` exit 0, on every commit.
>
> ⚡ **`/` 569ms → 484ms, `/spending` 118 → 95ms, `/investments` 163 → 116ms**
> (§15), measured against a production build on the real ledger.
>
> Repo: **`/Users/rayankarimcheca/dev/MoneyApp`**.
> Ledger unchanged: 10,111 active rows · income $117,924.62 ·
> spending $167,828.49 · **zero DB writes this session**.
>
> ⛔ **Both suites now REFUSE to start on a saturated box** (§15) — that is what
> turned a 8.4-minute gate into a 2.9-hour one and made three unit runs fail a
> different set of files each. On a quiet box vitest's default worker count is
> the fastest there is; no flag needed.

---

# ⛔ 0. THE JOB — what is next

**Nothing here is half-finished.** The clamp is closed (§14), the app is 15–29%
faster (§15), and the harness now refuses to run on a box that would lie about
the result. What is left is decisions:

1. **❓ Should an unpaid bill survive the turn of the month?** (§11) The arrears
   leg is scoped to the calendar month and the card says so — *"came due earlier
   this month"* — so a bill due on the 22nd is disclosed as late on the 31st and
   is **not** late on the 1st, with nothing paid in between. Internally honest,
   which is why I left it. One line either way.
2. **❓ Five view dimensions declare a URL key nothing reads** (§13), and three
   of them declare the SAME key (`viewpoint`), so they cannot be wired one file
   at a time. Either give them distinct keys and wire them, or drop `key` from
   the ones that are deliberately ephemeral so the type stops claiming
   something untrue. Wiring them changes what your dashboard remembers.
3. **Two decisions carried from the first half**: realized gains inside "All
   money in" on `/summary/[year]`, and the statement-reminder trade in §9.
4. **⛔⛔ `BTLEServer` HAS BEEN AT 100% CPU FOR 35 DAYS ON YOUR MAC**, with `mds`
   and `mobileassetd` alongside it. Nothing in this repo caused it and I did not
   touch a system daemon. **A reboot is the fix.** The guard in §15 now stops a
   suite from starting under it rather than spending 2.9 hours failing, but the
   daemon is still eating a core of every build you run.
5. **Pass 75 onward** — `docs/program-passes-60-94.md`. **HOSTING LAST.**

### Where the next performance work is, if you want it

The dashboard is **484ms** and drizzle-orm's query BUILDING is still the largest
share of it. The memos removed the repeated calls; what remains is that every
surviving query is constructed and prepared from scratch. Drizzle's `.prepare()`
would fix that, and it is a wide, mechanical change — worth doing deliberately,
not in passing. The e2e gate is **8.2 minutes at `workers: 1`**, held there
because the specs share one database; per-worker databases and servers would cut
it ~4× in wall time at the cost of more total CPU, which is a trade only you can
price.

## 1. The queue was empty, so the job was to find what is wrong

Eighteen defects, every one the class the last session named: **a date window
whose two ends disagree, or two surfaces answering one question differently.**
Ranked by what they put on the owner's screen.

| # | what the screen said | what is true |
|---|---|---|
| 1 | runway: "Committed bills come to **$3,733.14** a month" (2026-09-02) | **$3,542.21**, constant all month |
| 2 | pace tile: "≈ $947.00 free · **$0.00 spent**" (2026-09-20) | nothing imported; there is no figure |
| 3 | accounts: "Robinhood **+$585.31 today**" | measured 2026-08-27 → 08-28 |
| 4 | merchants: "5 visits inside **0 days**" | one day — 152 of 152 spans one short |
| 5 | budgets: "**4 bills** totalling $3,467.60" (2026-09-16) | eight bills |
| 6 | dashboard flow "1 month": **$9,148.10** (2025-08-06) | $5,353.72 — rent counted twice |
| 7 | recurring: Car insurance "next **2027-03-11**" (2027-02-20) | it ended 2027-01-11 |
| 8 | recurring: Chase Sapphire annual fee **2028-02-29** | 2028-03-01 — $95 in the wrong month |
| 9 | investments: "over **1 year and 11 months**" (2026-07-10) | exactly two years |
| 10 | eating out: "**1.9** purchases a day" (2026-03-10) | 2.0 over the window it names |
| 11 | runway on a young ledger | six-month average over three real months — **half** the burn |
| 12 | /spending YTD stepped back on a leap day | silently lands on the current month |
| 13 | recurring: "**7 series are running late**" | 3 were; 4 had never charged, and 3 of those were not due yet |
| 14 | recurring: "**$1,402.60 of it running late**" | $63.86 was; $1,338.74 had never been billed |
| 15 | runway on a ledger's first weeks | its OPENING month averaged in as a whole one |
| 16 | budgets: "**came due** this period" | past tense on the morning a bill falls due |
| 17 | summary: "All money in adds what you received without earning it" | a three-term total, two terms named |
| 18 | imports: Discover "**Ready to pull**" from Sep 3 | the statement closes on the 9th now |

Two more came out of re-checking those fourteen — §5b. One of them this
session created. §9 has 15–18 and the rest of the second half.

---

## 2. ⭐ THE FOURTH PHRASING — and the tests written for the first three could not see it

`committedBook`'s arrears leg opened at the month's first day while its horizon
was anchored on `today`, so the numerator spanned `[monthStart, today + 12
months)` — twelve months PLUS however far into the month it was — against a
divisor of twelve. Measured on the real ledger, **which holds no September rows
at all**, so nothing changed between these days except the day of the question:

    2026-09-01   $3,542.21 a month   (rent: 12 payments, $2,109.00/mo)
    2026-09-02   $3,733.14 a month   (rent: 13 payments, $2,284.75/mo)
    2026-09-23   $3,809.38 a month
    2026-10-01   $3,512.08 a month   ← and it resets

A **$267.17 sawtooth on the runway headline, every month**, on seven of the
thirteen lines at once. And a rent line publishing **$2,284.75 as the monthly
burden of a $2,109.00 bill**: a monthly series cannot cost more per month than
its own bill. `CommittedLine.perMonthCents` defends `total ÷ months` with the
insurance case — a series that ENDS inside the horizon and gets FEWER than N —
and never contemplated a series getting MORE.

⭐ **The cross-check the last fix was proved with only ever ran on the 1st.**
`committedBook(months=1)` was said to equal the forecast card's committed spend
"to the cent". It does — on 2026-09-01. On the 2nd they are $4,582.42 apart, and
by the 23rd the one-month book reads **$7,504.06** against a real month of
$3,567.60.

⛔ **All six boundary tests written for the first three phrasings ask on
2026-09-01** — the single day of the month where `today` and `monthStart` are
the same day, and therefore the one day this cannot fire. **Widening a fixture
to reach one boundary can land it exactly where the next one hides.**

### ⛔ The obvious fix is the same defect mirrored, and it was MEASURED before being rejected

Anchoring the window on the month start instead gives `[monthStart, monthStart +
12)`, a whole number of months. But a bill already paid this month has no
occurrence left in it, so on **2026-08-25 the same rent reads ELEVEN payments
and $1,933.25 a month**. Less than the bill is as false as more than it. Only a
window that opens on `today` holds exactly N payments of a monthly series
whatever day you ask on.

That forces the other half: `[today, today + N)` cannot contain a payment that
came due before today, so **arrears left the total**. They are counted, reported
and left out — the treatment the module already gives an inflow handed to an
outflow roll-up, and for the same reason. The arrears leg now closes the day
BEFORE today, so the two abut exactly: no day in both, no day in neither. **A
bill due today and unposted is not late — it is due**, and on 2026-09-01 the
card correctly reports no arrears at all.

⭐ **It also settled a contradiction between two cards on one screen.** Before,
the dashboard listed `Flamingo South Beach (rent)` and `Rent utilities & fees`
under *"Upcoming · next 14 days — $2,291.21 due before your next paycheck (Sep
3)"* while the runway card called the same $2,291.21 *"came due this month and
never posted"*. Same money, same screen, opposite tense. With the arrears leg
closing the day before today they agree: on the day rent falls due, it is due.

⚠️ **`carCard` shares none of this and must not be "fixed" the same way.** No
overdue leg, so its window already opened on `today` and already spanned its own
denominator. Swept day by day across September on the real ledger, its all-in
figure is constant at $1,325.60 before and after. **Three surfaces, one rule,
still not one fix** — for the second session running.

---

## 3. 🔴 The tile that asserted "$0.00 spent" over a month nobody had looked at

`/budgets` already refuses to grade days the ledger has not reached — *"their
spend and percentages are lower bounds, not measurements, so no verdict is shown
for them"* — and the income card says it in words. The dashboard's **spending
tile was the surface that did not ask**:

    today = 2026-09-20   0 of 20 elapsed days imported, and the tile read
                         "≈ $947.00 free · $0.00 spent · $0.00 projected"

Twenty days into a month with nothing imported, it read as a measurement of a
month in which he had spent nothing. **Free-to-spend is the figure the eye lands
on**, so a note underneath would not have undone it — the lesson he had to give
twice last session. `freeToSpendCents` is now null when NOT ONE elapsed day is
imported, and the tile shows an em dash with the month's name, which is the
refusal `dayChangeLabel` already makes for a portfolio with no prior close.

⚠️ With PART of the window measured the figures stand, marked "at least",
because they genuinely are lower bounds. With NONE of it measured, "at least
$0.00" is true of every month there has ever been, so the reason replaces the
figures rather than joining them.

---

## 4. 🔴 One word, three surfaces, and only two of them asked

`lib/day-change-label.ts` exists because the portfolio header once claimed a
move between Aug 5 and Aug 6 happened "today". `InstitutionCard` printed a
hard-coded **"today"** beside every day change on the dashboard. Measured at
today = 2026-09-01:

| row | printed | actually measured |
|---|---|---|
| Chase group | −$50.00 today | 2026-08-04 → 08-05 |
| its two children | $0.00 today | their own last two days |
| Robinhood group | +$585.31 today | 2026-08-27 → 08-28 |
| investments teaser, same screen | −$447.83 today | 2026-08-31 → 09-01 ✅ |
| Cash on Hand | −$5,000.00 today | 2026-08-11 → 08-10 |

⭐ **`daily_balances` is a CACHED derivation.** It walks forward to whatever
`today` was at the last rebuild, so on this ledger the last two covered days are
routinely weeks old — Chase Sapphire ends 2026-08-05, Chase Checking 2026-08-14,
Robinhood 2026-09-01. That is a property of when each account was last rebuilt,
not of the data.

⚠️ **A group's day cannot be read off its `asOf`.** `asOf` is the newest day ANY
child covers; the change is measured on the combined series, which keeps only
days EVERY child covers — the oldest of them. One row, three dates, and the
loudest word on it belonged to none. `dayChangeOf` now returns the figure and
its two days together, so no caller can date it from the wrong one.

---

## 5. The other eleven, briefly

- **`merchant-profile.spanDays` was endpoint-EXCLUSIVE** while both sentences it
  feeds name a count of days from first visit to last. **152 of 152** merchants
  printed a count one short, and four printed *"N visits inside 0 days"* over
  purchases that all fell on a single day. The divisor moves with the sentence,
  deliberately — the branch picks the rate and the words together.
- **`budgetSectionNotes` counted budget ROWS and called them bills.** At
  today = 2026-09-16, "4 bills totalling $3,467.60" over eight. ⛔ The TYPE could
  not express the difference, so no fixture over it could catch it.
- **The "1 month" money flow spanned 31 days.** A chart and a bridge answer a
  DIFFERENCE between two endpoints and need 31 points for 30 changes; a Sankey
  answers a SUM OVER DAYS. One pill, two kinds of window, one function.
  `rangeStartDay` is unchanged — fixing the shared function would have moved the
  chart and the bridge to windows genuinely one change short.
- **`rollForwardNextExpected` ignored `userEndsOn`.** `subscriptions-card` had
  the test at its CALL SITE; the rule now lives in the function.
- **365 is not a year.** `quarterly` and `annual` were exempted from calendar
  stepping on a premise the ledger has since falsified — "zero live series carry
  either". Four do, and all four drift. ⛔ **An exemption justified by a
  measurement has to be re-measured.**
- **The portfolio span lost a whole month on the anchor's own anniversary** —
  `n − 1` is the last completed month only while `anchor + n` falls strictly
  after `asOf`.
- **"purchases a day" divided by a window ending on a notional 31st.** The query
  bound was the same fabricated date; both now come from `periodBounds`.
- **`spendBaseline` averaged over months the ledger never had.** `moversCard`
  states the rule and applies it; `ledgerOpens` is now shared.
- **Stepping YTD back from a leap day built "2027-02-29"**, which `resolvePeriod`
  rejects, landing silently on the current month. ⚠️ My commit called it
  URL-only; it is reachable from the /spending YTD pill through two existing
  callers of `stepPeriodParams`. The fix is right, the reachability note was not.
- **"7 series are running late"** over three that were and four that had never
  charged — `Car lease` (first payment a fortnight away), `Car insurance`, `Gym`
  and `Rent utilities & fees`. `seriesStaleness.isStale` is the union of "the
  evidence is past tolerance" and "there is no evidence at all", which is right;
  calling both LATE is not. The per-row text already distinguished them.
- **"$1,402.60 of it running late"** in the composition band, over $1,338.74
  never billed. Same conflation, same card. ⛔ Here the TYPE could not express
  it: `SplittableComponent` carried `isStale` and nothing else.

---

## 5b. 🔴 Two more, from re-checking the first fourteen — one of them self-inflicted

- **The `userEndsOn` fix broke the subscriptions card.** Moving the end test
  into `rollForwardNextExpected` was right, but it turned a bare `continue` into
  a `null` that fell into the "no expected amount or no expected date" bucket.
  On the real ledger that sentence would have been printed about `Car insurance`
  ($361.49, monthly on the 11th) and `Car lease` ($695.04, monthly on the 15th)
  — the two largest commitments in the book. Ended is its own count now.
- **A FOURTH surface saying "Today".** `9017021` fixed the dashboard's group and
  account rows and missed `/accounts/[id]` — the page those rows LINK TO. Cash
  on Hand's detail page read "Today −$5,000.00" over a move between 2026-08-10
  and 2026-08-11: the exact figure that commit quotes as the defect it closed,
  one click away. ⛔ **Grepping for `>today<` found three surfaces and there were
  four, because this one builds the word as a prop.** A grep for the STRING is
  not a grep for the CLAIM.

---

## 6. ⛔ What the fixtures still cannot express

**Most of these fixes move ZERO pixels — 24 baselines out of 202 moved, from
four changes.** That is not a comfort, it is
the measurement: the e2e fixture cannot reach the condition, so the gate would
have blessed the defect forever.

| condition | why the fixture cannot reach it |
|---|---|
| a group's day change is stale | every account in `data/e2e.db` has `daily_balances` running to exactly `E2E_FAKE_TODAY`, so `asOf === today` everywhere |
| ~~a month with nothing imported~~ | ⚠️ **reachable after all** — see below |
| a bill anchored ON today | the series are anchored on the 9th, 10th, 16th and 20th; fake today is the 8th |
| an annual or quarterly bill drifting | the two quarterly series in the fixture are `detected` dividends whose next dates are months out |
| a young ledger | the fixture opens years before its own window |
| a leap day | fake today is 2026-07-08 |

🔴 **AND ONE OF THOSE ROWS WAS WRONG WHEN I WROTE IT.** `a6d8501` claimed the
pace tile's uncovered-days branch could not render in e2e. It renders: at
visual-spec time the fixture's newest active row is 2026-07-04, so four of
July's eight elapsed days are unimported and the tile says so. I had measured
`uncoveredDays = 0` against `data/e2e.db` **in the working tree — which is
POST-SUITE**, mutated by the `zz-*` specs that run after the visual ones.
⛔ **Measuring the fixture from the file the last run left behind is measuring a
different ledger.** Build a pristine one with `seedE2eDatabase()` into a scratch
path.

⛔ **And the unit fixtures inherit it.** `institution-groups.test.ts` could not
express a stale group at all: every helper in it rebuilds derived balances
through the REAL today, so a fixture account's series always ended today. The
new test calls `rebuildAccount(db, id, STALE)` — which is exactly what a stale
cache is on the owner's machine, where Chase Sapphire ends 2026-08-05 and Chase
Checking 2026-08-14 because that is when each was last rebuilt.

⛔ **Twice this session the TYPE was the thing that could not express the
condition**, not the fixture: `BudgetNoteInput` carried no bill count, and
`SplittableComponent` carried `isStale` and nothing else. No fixture over either
could have distinguished the cases. **When a fixture cannot reach a condition,
check whether the type can hold it first.**

### The costed options for widening e2e — YOUR CALL, measured

⚠️ **First, a number three handoffs have got wrong, this one included until it
was counted: there are 202 PIXEL BASELINES, not 590.** 590 is the E2E TEST
count. The baselines are 23 visual families × 2 themes × 4 widths (184) + 12
interaction-states + 3 golden-path + 3 intraday. Every "590 pixel tests" in a
commit message this week is loose.

⚠️ **And `data/e2e.db` in the working tree is NOT the fixture the baselines
see.** It is post-suite — 36 series and 17 accounts against the pristine seed's
8 and 8, because the `zz-*` specs create their own. `global-setup` reseeds it
every run. Anything measured against the checked-in file is measured against a
different ledger; build a pristine one with `seedE2eDatabase()` into a scratch
path instead.

Ranked by conditions unlocked ÷ baselines disturbed:

| widening | baselines | unlocks |
|---|---:|---|
| **a ONE-DAY merchant** (re-point three rows already dated 2025-02-27 onto a new merchant — no amount, date, account or category moves) | **8** | `spanDays < 60` and the "N visits inside D days" sentence, which the fixture cannot print at all today |
| move an existing UNCATEGORISED series onto today (Car Insurance 07-26 → 07-08) | 32 | the calendar state on an anchor day, `committedBook` opening on today, the upcoming strip's today edge |
| lapse an existing series (`Gym Membership userEndsOn = 2026-06-30`) | 32 | the money-out lapse rule end to end, and `subscriptionsCard`'s new `endedCount` |
| move a BUDGETED series onto today (Netflix) | 40 | all of the above PLUS the first non-zero `budgetOverdue` the fixture has ever produced |
| ADD any series | 40 | whatever the series is for; the cost is the same whatever you add |
| make an account's balances stop before today (SoFi Savings) | 48 + a hard-coded net-worth assertion | the stale day-change branch |

⭐ **The one-day merchant is the cheapest and it is NOT free — and how that was
established is the best thing in this section.** The first measurement said 0
baselines: it dumped `merchantProfile`, `topMerchants`, `yearSummary` and
`spendingInsights` for every merchant, found Whole Foods' own figures unchanged,
and concluded the Whole Foods page was unchanged. It is not. That page prints
*"Whole Foods is the 2nd largest of your 17 regular merchants"* — **a merchant
page states a fact about the OTHER merchants**, so an 18th moves all eight of
its baselines while touching none of its own numbers.

⛔ And the trap is structural, not incidental: `merchant-insights` counts a
merchant as "regular" at 2 visits while `merchant-profile` needs 3 to print the
sentence at all, so **any new merchant that can say "N visits inside 1 day" is
necessarily also in that set.** The only way to cover the branch without moving
a baseline is to re-shape an EXISTING merchant, which moves its dates and so
moves whatever windows those dates were in.

I did not take it: it is a change to your fixture, the condition it unlocks is
already pinned by a unit test (`merchant-profile.test.ts`, "visits on a single
day span one day, not zero"), and 8 baselines is a real cost for a branch that
is already covered where it lives.

---

## 7. ⭐ The mutation audit: 20 boundaries that could be moved silently

A mutation sweep over the boundary-adjacent suites — ~55 single edits applied to
the SOURCE one at a time, each run against its own test file and restored —
found twenty edits that changed no test. **None is a shipped defect.** Each is a
boundary that could be moved without anything going red, which is the absence
that let three phrasings of one window ship last week.

**Fifteen are now dead.** Tests added to `budgets` (4), `recurring-calendar` (4),
`dashboard` (3), `coverage` (2), `statement-cadence` (3), `month-flow` (1) and
`forecast` (1). Every one verified by applying the mutation and watching the new
test go red, then restoring.

### 🔴 Two lessons from doing it

⛔ **An assertion that passes over an EMPTY collection is the same defect as one
that survives the bug.** My first calendar-tolerance test put the charge in a
past month — and the calendar never projects into past months, so `entriesByDay`
was empty and both assertions were trivially true of nothing. It was committed,
and caught only by re-running the mutant afterwards. Fixed in `945ba57`.

⛔ **A relationship between consecutive terms cannot pin a term common to all of
them.** `forecast`'s chain test asserts each month's end-of-month cash against
the previous month's plus its own net. Starting the chain loop at `i = 0` adds
the running month twice — but it adds the SAME extra term to every future month,
so every difference the test asserts is unchanged. It survived doubly: the
fixture's only series is anchored on the 1st of the NEXT month, so the running
month's net is exactly zero and the double count adds nothing at all.

### The five still standing, with their exact mutations

| file | mutation that survives | why it was left |
|---|---|---|
| `services/in-flight.ts:194` | `compareDates(day, out.postedOn) >= 0` → `> 0` | needs a sender invisible on its own posting day; four days of a false $50 dip |
| `services/in-flight.ts:99` | gap-run end `<= 0` → `< 0` | one day of bridging dropped — a one-day notch in the net-worth curve |
| `services/in-flight.ts:97` | `firstVisible < 0` → `<= 0` | two fixtures built and neither moved the float windows; not provably equivalent either |
| `services/budgets.ts:274` | `carryInto`'s `p.end >= currentPeriodStart` break | on an aligned period grid `p.end` is always strictly before; may be equivalent |
| `services/dashboard.ts:266` | `slice(-SPARKLINE_DAYS)` → `slice(0, N)`, and `dayChangeTerm`'s two dates swapped | `investmentsTeaser` has NO unit coverage at all — the sparkline would draw the oldest 30 days and the term would name the dates backwards |

⭐ The last one is the one to take first: it is a card on the dashboard with zero
unit coverage, and one of its two mutants is the exact defect this session's
first fix was about.

### Six mutants recorded as EQUIVALENT rather than filed

`statement-gaps.ts:59` (`< 2` → `< 1`, guarded by the `holes.length === 0` check
below), `lib/in-flight.ts:69` (dropping a zero-delta skip — adding zero),
`forecast.ts:443` (`<= 0` → `< 0` on an amount the caller already drops),
`calendar-day-weight` (`<` → `<=` on a confidence rank tie — equal ranks),
`recurring-calendar.ts:451` (a frontier computed and never read — a wasted query,
not a wrong number), and two no-ops in `month-flow`. **An equivalent mutant is
not a coverage gap, and papering over one with a test that asserts the fixture
back to itself is worse than recording it.**

---

## 9. ⭐ Closing the list — everything §0 asked for, and four more defects

Every item the first half of this session left open is done.

### `investmentsTeaser` had no unit coverage at all — six tests, four mutants dead

The card on your dashboard that nothing exercised. The two mutants the audit
found both survive no longer, and two more turned out to be equally unpinned:
- `slice(-30)` → `slice(0, 30)` drew the OLDEST thirty days beside "today's
  move";
- `dayChangeTerm`'s two dates SWAPPED — this session's first defect in a
  different tense, and unreachable in e2e because every price there is quoted
  through `E2E_FAKE_TODAY`;
- the top mover taken as the biggest WINNER rather than the biggest move (a 4%
  fall beats a 1% rise and the card has room for one);
- the `valueCents === 0` guard — a book sold down to nothing still has an
  `asOf`, so without it the dashboard headlines a card at $0.00.

⚠️ One EQUIVALENT mutant recorded rather than papered over: `dayChangeExact` is
true by construction (`buildPortfolio` writes `exact: true` unconditionally and
nothing sets it false), so the "≈" the teaser renders cannot be reached.

### The four other surviving mutants — two killed, two argued

`in-flight`'s float now pins both of its own edges, from ONE fixture: a sender
whose span derives as `gap` because its statement chain misses by a cent. The
float must open on the day the money LEAVES (the sender is invisible then, so
the money is in nobody's ledger), and the last day of a gap run must stay
invisible (or the sender is counted beside the receiver's own credit).

Two are recorded as equivalent with their arguments: `in-flight`'s
`firstVisible` edge (three fixtures built, none moved a float) and `carryInto`'s
`p.end >= currentPeriodStart` break — **brute-forced over 198,400 (cursor,
period) pairs across all four period kinds: zero hits**, because a period's LAST
day can never equal a period's FIRST day of the same kind.

### 🔴 Four more defects, found after the list was closed

- **`spendBaseline` kept the ledger's OPENING MONTH whole.** At today =
  2022-10-01 it published $519.61/mo over "2 complete months, 2022-08 to
  2022-09" — the one month covered in full spent $992.78. ⚠️ The fixture had the
  same stub and hid it: every baseline row sat on the 5th, so the test ledger
  opened 2026-02-05 and the fix shrank the file's core window from six months to
  five, breaking five tests.
- **The /budgets note said "came due"** — past tense, on the morning a bill
  falls due. ⭐ And the reason the two surfaces split that instant differently is
  NOT the calendar: **only the overdue leg checks postings.** `budgetTail`
  projects the schedule and nothing else, so a bill due today that has already
  posted would be counted twice against `spentCents` if it sat there;
  `committedBook`'s forward leg is a RATE, has no such hazard, and can safely own
  today. Both boundaries are right, the reason is now written into both, and only
  the sentence was wrong.
- **`year-summary` defined a three-term total with two terms.**
  `totalReceivedCents` is `earned + investment + notEarned` — an identity with
  its own test — and the lede named two: "All money in adds what you received
  without earning it". The unnamed term is 7.5% of the 2025 headline
  ($2,866.35 of $38,409.23) and sits on the same page under a heading of its own.
- **The statement-cadence trim erased the only evidence a cycle had changed.**
  A permanent change looks EXACTLY like a single outlier in the month it happens.
  `Discover` is issued by Capital One now and closed on the 9th after eleven
  closes on the 2nd; the trim dropped that 7-day deviation and left
  `toleranceDays = 1` — **removing the newest close from the input produced the
  IDENTICAL rhythm and tolerance**, which is what "contributes nothing" means.
  /imports read "Ready to pull" from 2026-09-03, six days before the statement
  existed. It now waits until the 10th. On the real ledger the change touches
  exactly one account; every other tolerance is identical.

### ⛔ Three more traps, from doing the work

- **My own test encoded the old behaviour, twice in one day.** The
  trim-threshold test I wrote in the morning put its outlier LAST — exactly where
  the afternoon's rule exempts it. A fixture that puts the case where the rule
  does not apply cannot test the rule.
- **A raw-table dump is not the production path.** The trim change looked like
  it moved two e2e accounts from `tol=4` to `tol=27` — until I ran it through
  `statementPulls`, which filters `not_applicable` periods. Through the real
  caller the e2e output is byte-identical. I nearly reported a consequence the
  app cannot have.
- **A test that passes over an EMPTY collection is agreement with nothing** —
  §7, and it cost a commit to catch.

---

## 10. Notes that keep costing time

- ⛔ **Widening a fixture to reach one boundary can land it exactly where the
  next one hides.** §2.
- ⛔ **An exemption justified by a measurement has to be re-measured.** The
  `quarterly`/`annual` docstring was right when it was written and the data moved
  underneath it.
- ⛔ **The obvious fix can be the same defect mirrored.** §2 — measure the
  alternative before taking it, not after.
- ⛔ **A cached derivation dates itself by when it last ran**, not by the data.
  §4.
- ⛔ **A grep for the STRING is not a grep for the CLAIM.** `>today<` found three
  surfaces; the fourth built the word as a prop.
- ⛔ **An assertion that passes over an EMPTY collection is agreement with
  nothing.** §7.
- ⛔ **A relationship between consecutive terms cannot pin a term common to all
  of them.** §7.
- ⛔ **A page states facts about things OTHER than itself.** The Whole Foods
  baseline moves when an 18th merchant appears, though not one of its own
  figures changes. §6.
- ⚠️ **`data/e2e.db` in the tree is post-suite, not the fixture.** §6.
- ⚠️ **202 pixel baselines, 590 e2e tests.** They are not the same number and
  three handoffs have conflated them.
- ⚠️ Everything carried forward from the previous handoff still holds: the two
  definitions of spending, `user_category_id` as an override, the income answer,
  `pnpm e2e` refusing a stale `.next`, and the WAL read-only gotcha.

---

## 11. ⭐ The third block — six more defects, and one the sweep found that I did NOT fix

Written after §9 closed the list a second time. Same class every time: something
answers one question two ways.

| # | Surface | What it said | Commit |
|---|---|---|---|
| 19 | runway tooltip | arrears are "inside the rate" — three lines above the sentence saying they are not | `7b132fd` |
| 20 | 5 spending cards | one ledger, two window lengths: runway "1 complete month", subscriptions "6" | `7b132fd` |
| 21 | car card | car spend removed at $100/mo from a total built at $200/mo | `0af85d0` |
| 22 | runway caption | "0 complete months, 2022-09 to 2022-09" — a range made of the month it excluded | `0af85d0` |
| 23 | net-worth terrain | **"$0.00" under "Today"** for an account with no history at all | `413fb93` |
| 24 | top movers | "No winners today." above a header reading "Last close" | `78085a5` |

### 🔴 #23 is live on his ledger right now

**Capital One 360 Checking is an ACTIVE account with zero daily balances and
zero transactions** (measured 2026-09-01 on a `.backup` snapshot). The terrain's
table lens printed `$0.00` under **Today** and `$0.00` under **Change** for it —
two claims about money, about an account nobody has a single figure for.

What made it findable is that the row disagreed with itself: the **First day**
column had already refused to answer with an em dash, two columns left of two
that claimed a balance. Three columns, three separate decisions about whether
there was anything to say. `terrainRowFigures` makes that decision once.

⛔ It keys on `lastDay`, **not** on `lastCents === 0`. A real account can sit at
exactly zero and that zero is worth printing — its own test.

### 🔴 #20 was created by this session's own fix, and only re-checking found it

`spendBaseline` learned to shrink its window to the months the ledger covers
(§9). Five services import `SPEND_BASELINE_MONTHS` **precisely so they cannot
quote different windows** — and a constant is not enough on its own, because the
FLOOR is data-dependent. Measured at `today = 2022-10-01` before the fix: runway
"1 complete month", subscriptions "6". `baselineWindow(db, today, months)` is
now the one place; all five read it. Unchanged on his ledger (all five still say
2026-03 … 2026-08 at 2026-09-01).

⚠️ Four fixtures had the same stub the floor exists to catch — their earliest
row dated the ledger mid-window, so ~20 tests went red. Each now opens on a
month boundary and says why.

### ⭐ The sweep the fixtures could not do — and the one thing it found that is still open

`committed.test.ts` now grades the boundary over **every day of the month**: 32
series (one per anchor day, plus one that is late on every asking day) × 62
consecutive asking days. Every hand-written test in this repo fixes both halves
of the pair — which day the bill falls on, and which day you ask on — and all
three of the session's live bugs hid in the gap.

**It found a seventh defect. I did not fix it, deliberately.**

🔴 `addCalendarMonths` **clamps**: 29 August + 6 months is 28 February, because
29 February 2027 does not exist. The horizon is then a day short of six whole
months, a bill anchored on the 28th loses its sixth payment, and the rate still
divides by six — a 5-payment window over a 6-month divisor, the exact shape of
the three bugs above. Six (day, bill) pairs inside the 62-day span:

```
2026-08-29  Bill 28        2026-08-31  Bill 28
2026-08-30  Bill 28        2026-08-31  Bill 29
2026-08-30  Bill 29        2026-08-31  Bill 30
```

⛔ **THE OBVIOUS FIX TRADES ONE ERROR FOR ANOTHER — measured, not guessed.** The
recurring engine clamps too. Asked for the actual projected dates, the series
anchored on the 28th, 29th, 30th **and** 31st all fall on **2027-02-28**:

```
Bill 28  2027-01-28  2027-02-28  2027-03-28
Bill 29  2027-01-29  2027-02-28  2027-03-29
Bill 30  2027-01-30  2027-02-28  2027-03-30
Bill 31  2027-01-31  2027-02-28  2027-03-31
```

Including that day fixes the 28th and hands the 29th and 30th a **seventh**
payment. No date cut can separate four anchors sharing one date. An exact fix
has to bound each series by its own **step index**, which `SeriesOccurrence` does
not carry — a real change to `projectOccurrences` and every consumer, and
exactly the kind this codebase gets wrong when it is rushed.

⚠️ **Latent for him either way: his latest anchor day is the 22nd** (measured —
Gym 22, Parking 20, HBO 18, Venture X fee 16, car lease 15, the rest ≤ 8).
Nothing he owes can reach the condition.

The exact shortfall list is **asserted**, not excused, so a fix has to come here
and empty it on purpose.

### ⚠️ Two ways that sweep was VACUOUS before it was right

Both found by mutation, both the shape §7 keeps finding.

1. **A static fixture LAPSES.** `seriesHasLapsed` correctly stops forecasting a
   series nobody pays, so a two-month sweep dissolved partway through and read
   that as a boundary bug. The sweep now re-pays every series on each asking day,
   as an import would.
2. **Paying a bill ON its anchor day** — which a fixture does and a bank does not
   — hid the day the two legs meet. The bill due today is inside the horizon and
   must not *also* be in arrears; with `>=` there, an overdue leg widened to
   include today **survived**. It is `>` now, and that mutant dies.

Seven mutants; six die to the sweep alone.

### ❓ ONE QUESTION FOR YOU — the arrears leg stops at the 1st

Pinned by the sweep, not changed. The overdue leg is scoped to the **calendar
month**, and the card says so: *"A further $X came due earlier this month and
never posted."* So a bill due on the **22nd** is disclosed as late on the 31st
and **is not late on the 1st**, with nothing paid in between. The debt did not
go away; the calendar turned.

It is internally honest — the wording owns its scope — which is why I left it.
**Should an unpaid bill survive the turn of the month?** One line either way.

### 🔴 A memory file was telling future sessions to break your ledger

`moneyapp-car-lease-and-insurance.md` still led with **$559.89 on the 11th** —
what you said on 2026-08-11 — while the ledger holds **$695.04 on the 15th**,
which the 2026-08-31 session read off the Mercedes-Benz statement. A number
stated from memory lost to a number printed on a statement, correctly. But the
memory file would have talked the next session into "fixing" the right figure
back to the wrong one, $135.15/month and four days. Corrected, with the reason
and a ⛔ against reverting it.

### ⛔⛔ `pnpm test` OVER-SUBSCRIBES A BUSY BOX — use `--maxWorkers=4`

Not a code finding — an environment one, and it nearly cost a false bug report.

`uptime` reported **load averages 44.65 / 31.10 / 18.02** with **5 users** and two
other interactive Claude sessions live. Three consecutive full unit runs failed
**different** tests each time — 4 files, then 8, then 9 — and every one of them
**passed alone**. The failures were uniform **208.7-second stalls**, one per file:
an I/O wall, not an assertion. The reported test COUNT moved between runs
(4,349 / 4,396 / 4,408) because a file that dies in `beforeEach` never registers
its tests at all.

✅ **The fix is one flag, and it is also three times faster:**

```
npx vitest run --maxWorkers=4     # 221 files · 4,408 tests · ALL PASSED · 56.8s
npx vitest run                    # 9 files failed · 261s   (same tree, same minute)
```

Vitest's default worker count assumes it owns the machine. It does not here.
⚠️ Worth making the default in `vitest.config.ts` — **not done**, because
changing how the suite runs is not a change to make in the same breath as
reading its result.

The standing rule in memory — *"NEVER run anything else during a suite run;
quiet box = 582/582 in 8.4m"* — is the same lesson; this is the number behind it.

---

## 12. ⭐ Eight more boundaries, pinned — and the guard that refused a good run

A mutation audit over the screen-facing services (53 agents, adversarially
verified) found the same blind spot everywhere, and it is the brief's item 2
stated in general form:

> **Every fixture dates its rows comfortably INSIDE the window it tests.**

That proves a row outside is excluded and says *nothing* about a row ON the
edge. Nine one-character mutations went green across the whole suite. Each test
below was written against the exact mutation that survived; all thirteen
mutants now die (`36c661f`).

| Boundary | What the surviving mutant did |
|---|---|
| `spending.ts` pace basis | dropped **all of today's spending** from the tile the dashboard leads with, while `elapsedFraction` still counted today as elapsed |
| `movers-card.ts` grid depth | printed *"the mean of the 6 complete months before it, Jan 2026 to Jun 2026"* and averaged **five** |
| `movers-card.ts` sort | sorted by signed delta, pushing the **biggest fall** off a card whose job is the biggest moves |
| `fees-card.ts` row loop | rendered lines summing to **$218.45 under a $313.45 total** |
| `spendingRowsInRange` ×2 | dropped the first / last day from Top merchants and Largest purchases |
| `yearBounds` ×2 | put 1 January and 31 December outside their own year |
| `sumOccurrencesInWindow` ×2 | dropped an occurrence on the day the window opens / closes |
| `within()` (isCurrent) ×2 | said a period is not current on its own first or last day |

### 🔴 The two that are load-bearing on HIS ledger today

**The movers grid.** `MAX_MONTHS_BEHIND + months + 1` matters only on the
FALLBACK path — and his ledger is on it (it compares 2026-07 against a running
2026-09). The one test that reaches that path asserted the window's LABELS,
which the bug cannot move. It now asserts what the window AVERAGES. Verified
non-equivalent on a real snapshot: headline $3,040.49 → $3,841.81, and a
coverage note reading *"106% of your usual spending"* — a share of a whole
larger than the whole, because the ratio's numerator and denominator read
different windows.

**The pace tile.** `TODAY` in `spending.test.ts` is 2026-07-08 and no fixture
row was dated the 8th.

### ⛔ The terrain's table lens had NO coverage at all

Not a pixel, not an assertion — while the relief above it had both. That is what
hid #23. The new e2e test asserts the invariant that holds for **any** fixture:
the three columns agree about whether there is anything to say. (The em-dash
branch itself is data-dependent, so it is unit-tested on both sides instead.)

### ⛔ A guard that refused a run it had already reasoned was fine

`assertBundleIsFresh` walks `src/**/*.{ts,tsx,css}` — **including
`src/**/*.test.ts`, which is never bundled.** Editing a unit test therefore made
it declare the served pages stale and refuse the e2e run. Its own comment says a
file that cannot affect the bundle must not block a run; that is now true of test
files too. A guard people learn to skip with `E2E_ALLOW_STALE=1` is worse than
no guard.

### The 40 baselines, each cropped and read before regenerating

`budgets` ×8 (*"came due this period"* → *"due by today"*), `summary-year` ×8
(the lede now names all three terms), `spending-year` ×8 (the deviation caption
on its own line, *"0 up · 10 down · 8 biggest shown"* — it used to count AFTER
the cut), `investments` + `investments-loss` ×16 (*"Top movers · Today"*).

⚠️ That last one renders as **"Today"** because the fixture is priced through its
own fake today — the branch that was WRONG cannot appear in any Playwright run,
which is exactly why the rule lives in `lib/day-change-label` under unit test.

---

## 13. ❓ Five view dimensions declare a URL key that nothing reads — and three share one

Found by writing the terrain table-lens test: `/?chart=terrain&terrainLens=table`
opens on the **relief**. The lens is `useState("relief")`, so the param does
nothing and the choice is lost on reload.

That is not a naming accident. `ViewDimension.key` is documented in
`src/lib/view-state.ts` as:

> *"the URL param key AND the app_settings key for this dimension"*

Five declarations make that promise and nothing keeps it:

| Component | `key` | held in |
|---|---|---|
| `NetWorthTerrain` lens | `terrainLens` | `useState` |
| `NetWorthTerrain` viewpoint | `viewpoint` | `useState` |
| `CategoryMassif` viewpoint | `viewpoint` | `useState` |
| `TransferTower` viewpoint | `viewpoint` | `useState` |
| `SankeyChart` flow/table | `sankey` | `useState` |

⚠️ **`viewpoint` is declared by three different components.** Wiring any of them
naively would put three surfaces on one URL param, so this cannot be fixed by
swapping in `useViewState` one file at a time — the keys have to be made
distinct first.

The app already does this correctly elsewhere: `CategoryMassif`'s *own* "where"
dimension and `TransferFlowPanel`'s two both go through `useViewState` and are
linkable and persisted. So the same question — *is a view choice part of the
address?* — is answered two ways inside one component.

⛔ **Not changed, and this one is genuinely yours.** Making these real changes
what your dashboard remembers between visits (they would start writing
`app_settings`), and it is the exact promise `zz-zz-dashboard-chart-options.spec.ts`
was written to defend: *"a view dimension is a PROMISE."* Either wire them with
distinct keys, or drop `key` from the declarations that are deliberately
ephemeral so the type stops claiming something untrue.

### ⚠️ And the honest limit of the new terrain test

**Measured:** the e2e fixture holds no account without history, so the em-dash
branch cannot render in any Playwright run — a mutation reverting the "Today"
column to `formatCents(r.lastCents)` **survives** it. Said out loud rather than
left implied. The decision therefore lives in `terrainRowFigures`, unit-tested on
both sides (blank, and a real balance of exactly zero); the component is a
one-line pass-through with no branch left to get wrong; and the e2e test adds the
promise the lens had none of before — that the table renders, names its window,
and that its three columns agree about what is known.

This is the strongest argument yet for the fixture widening costed in §6.

---

## 14. ✅ THE CLAMP IS CLOSED — and the fix is not the one that was obvious

You said fix it, so it is fixed, and the shape of the fix is the point.

`addCalendarMonths("2026-08-29", 6)` is `2027-02-28`, because 29 February 2027
does not exist. A half-open `[today, to)` was therefore a DAY SHORT of six whole
months, and a bill anchored on the 28th lost its sixth payment while the rate
still divided by six.

⛔ **A DATE CUT CANNOT EXPRESS THIS WINDOW.** The recurring engine clamps too —
asked for its own projected dates, the series anchored on the **28th, 29th, 30th
and 31st all land on 2027-02-28**:

```
Bill 28  2027-01-28  2027-02-28  2027-03-28
Bill 29  2027-01-29  2027-02-28  2027-03-29
Bill 30  2027-01-30  2027-02-28  2027-03-30
Bill 31  2027-01-31  2027-02-28  2027-03-31
```

Making that day inclusive fixes the 28th and hands the 29th and 30th a SEVENTH
payment. So the window stopped being a pair of dates. **`MonthHorizon` decides
membership in month space**: every month before the last is inside, and inside
the last month an occurrence is in iff *the day the series is really billed on*
precedes the day the window opened on. That is exactly the date comparison
whenever nothing clamps, and it is the only thing that separates the four when
something does.

- `SeriesOccurrence` now carries **`anchorDayOfMonth`** — the engine's own
  anchor day, so this exposes a fact rather than re-deriving one, and inherits
  `deriveAnchorDay`'s limits exactly rather than adding new ones.
- ⛔ **TWO SURFACES, ONE RULE.** `carCard` kept its own copy of the horizon and
  its own copy of this bug with it. Both read `monthHorizon` now.
- ✅ **Nothing moves on your ledger**, measured: the runway holds $3,542.21/mo on
  2026-09-01, 09-02 and 08-29 alike, and the car card is constant at $1,325.60
  across the clamp days. Your latest anchor day is the 22nd.
- The sweep runs **400 asking days** rather than 62, so every month-length
  pairing the calendar can produce is asked at least once, and its
  known-shortfall list is **empty on purpose**.
- Eleven mutants, ten dead. The eleventh is EQUIVALENT and proved so rather than
  argued: a property test grades **67,890** (asking day, horizon, anchor day)
  triples and nothing the horizon admits ever falls after the nominal end.

---

## 15. ⚡ THE APP IS 15–29% FASTER, and the harness now refuses to lie

### What was actually slow — from `--cpu-prof`, not from reading the code

| Page | before | after |
|---|---|---|
| `/` | 569ms | **484ms** (−15%) |
| `/spending` | 118ms | **95ms** (−20%) |
| `/investments` | 163ms | **116ms** (−29%) |

Measured end to end against a production build serving your real ledger.

🔴 **drizzle-orm was 44% of all active CPU** — not the queries, the *building*
of them, over and over. Counted per dashboard render: `activeTxnsInRange` **×14**
at 5ms each, `accountCoverage` ×7, `monthlySpending` ×5, `observationFrontier`
×4, `loadCategoryIndex` ×20, `buildPortfolio` ×2 at **57ms each** — for a
handful of distinct arguments.

🔴 **`dates.ts` was 14%** — `digitsAt` alone 458ms of 5.2s. Every `compareDates`,
`diffDays` and `addDays` re-reads its arguments character by character, and a
sort re-reads them O(n log n) times, across a ledger spanning only a few
thousand distinct days.

### How it is cached, and why that is not a staleness bug waiting to happen

⛔ **`react`'s `cache`, never a module-level Map.** A result that outlives the
request is a wrong number the moment an import lands, and this app has no
invalidation signal worth trusting — SQLite's `data_version` does not move for
writes on our own connection, which is every write it makes. `cache()` is scoped
to one React request and **measurably does not memoise outside one**, so tests,
scripts and `ledger-check` are untouched. The date memo needs none of that
care: it is a pure function of a string, so it has only a bound, which is capped.

⛔ **Two traps, both measured, both worth remembering:**

1. **`cache()` keys on the arguments AS PASSED.** `buildPortfolio(db)` and
   `buildPortfolio(db, undefined)` are different calls and miss each other — the
   counter still read TWO builds per request with the memo naively in place. An
   array key misses too, because `[...]` is a fresh identity every call. The
   scope is a normalised **string** now.
2. **A cached array is shared.** One caller sorting it in place would rewrite
   what the next one reads, so `activeTxnsInRange` and `accountCoverage` return
   a `.slice()` — a few thousand references against the 5ms query it replaces.

### ⛔ And the harness now refuses to start on a box that will lie

`scripts/quiet-box.ts`. Both suites read the load average **before their workers
spawn** — so they see what they are about to compete with, not what they create
— and refuse above 1.5 runnable processes per core. The message names the three
busiest processes, because diagnosing this by hand took most of an hour: the
failures pointed at tests, `uptime` pointed at a number, and only `ps` pointed at
`BTLEServer`, which had been spinning at 100% for 35 days.

⛔ **NOT a retry policy, deliberately.** A retry spends more of the CPU that is
already the problem and turns a machine fault into a test that "sometimes
passes". `E2E_ALLOW_LOAD=1` / `VITEST_ALLOW_LOAD=1` when you want the answer
anyway.

⚠️ Two method notes that cost real time this session, so they are written down:

- **`kill %1` does not reap a backgrounded `next start`** from a non-interactive
  shell. A first before/after comparison read "no difference" because every later
  measurement was still being served by the FIRST server. Kill by port
  (`lsof -ti:PORT`) and check the port is free before believing a measurement.
- **On a quiet box vitest's DEFAULT worker count is fastest** (11.9s at ~14
  workers vs 21.5s at 4). `--maxWorkers=4` was the right answer only while the
  machine was saturated — which is now what the guard is for, so the flag is no
  longer the advice.


---

## 16. ⭐ Four more, found by READING THE RUNNING APP on your real ledger

Not by grepping, not by a mutation audit — by opening the dev server and reading
the sentences. All four are the same class as everything above: two figures that
are each true, made to contradict each other by where they sit or how they are
worded.

### 🔴 "-$0.00" on /accounts

Chase Sapphire's balance is exactly zero. Liability rows render
`-balanceCents`, and negating an exact zero gives **`-0`** — which JavaScript
keeps and `Intl` prints **with its sign**. The Venture X row two lines up
printed a plain "$367.99", so one card stated that it owed nothing in a notation
nothing else on the page used.

`formatCentsSigned` had already guarded its own zero and written down why;
`formatCents` had not. ⛔ Fixed with `+ 0`, not `Math.abs` — this must normalise
NEGATIVE ZERO and nothing else, and `Math.abs` would silently print a real debt
as a credit. Both mutants die.

### 🔴 "2 charges, latest Sep 18 — 714 days ago"

On the dashboard's cards card. The charge is from **September 2024**, and
`formatDayShort` never prints a year — so in September 2026 the bare "Sep 18"
reads as a date **sixteen days in the future**, inside the same phrase that
calls it two years old.

`formatDayShortIn(iso, reference)` names the year outside the reference year and
stays short inside it. ⛔ It takes a reference day rather than reading the clock,
because a formatter that calls `todayIso()` cannot be used from a client
component — and the surfaces that need this already hold `today` to compute the
age they print beside the date.

⚠️ Every fixture in `cards-owed.test.ts` dates its rows inside `TODAY`'s own
year. That is why a formatter that never prints one went unnoticed — the same
fixture blindness as §12, in a new costume.

### 🔴 The same sentence said 3 and 4, a screen apart

`/recurring`, over the September forecast: *"4 series are running late and **3**
have never charged — all still projected."* Under the 30-day list, in identical
words: *"…and **4** have never charged."*

Both true. `Rent utilities & fees` first falls due on 1 October — inside thirty
days, outside September. Neither sentence said which set it had counted.
`staleSummaryLabel` and `StaleFooter` now REQUIRE the window, so a third caller
cannot reintroduce it by omission.

⛔ The window LEADS the sentence. "…and 3 have never charged in September" would
say they had never charged IN SEPTEMBER — weaker, and false.

### 🔴 "14.7% of everything you spend" was a projection

The car card printed "against a monthly total of **$9,019.90**" two tiles from
the runway card's "What you spend a month **$8,770.56**".

Both right for what they are: the runway prints the MEASURED six-month average;
the car card's denominator is the same baseline with car spending taken out and
the car's full monthly cost put back in — a projection of a month in which the
lease, the insurance and the amortised deposit are all paid. The field is called
`allInProjectedMonthlySpendCents`. The sentence did not say so, and now does.

### ⚖️ One left deliberately, and why

`/investments`' chart readout says **"Wed, Sep 2, 2026: $107,097.05"** for a
value whose prices are Sep 1's — the series ends 2026-09-01 and `carryForwardTo`
extends a dashed tail to today. It is the app's documented model (net worth
carries forward the same way), the tail is drawn dashed from its own
`complete: false`, and the page's own header states the price age in the first
sentence you read. I could not call the number false, so I left it. If you want
the readout to name a carried point, `ScrubSummary` would need to carry
`complete` through — small, and it is the kind of change worth wanting rather
than inferring.
