# Handoff — eighteen more phrasings of one boundary, and where they were hiding

> **Supersedes `HANDOFF-2026-08-31c-the-income-answer-and-the-split.md`.**
>
> **`main` = `f609bbd`** (this doc), tree clean, pushed. tsc clean · **4,368 unit** ·
> **E2E_GATE=1: 590 passed at `maxDiffPixels: 0`** (8.3m, green on the confirming run) · 24 baselines regenerated, every diff cropped and read first · `pnpm ledger-check` exit 0, on every commit.
>
> Repo: **`/Users/rayankarimcheca/dev/MoneyApp`**.
> Ledger unchanged: 10,111 active rows · income $117,924.62 ·
> spending $167,828.49 · **zero DB writes this session**.

---

# ⛔ 0. THE JOB — what is next

**Nothing here is urgent and nothing is half-finished.** Every item the first
half of this session left open has since been closed — see §9. What is left:

1. **Pass 75 onward** — `docs/program-passes-60-94.md`. **HOSTING LAST.**
2. **Two decisions that are yours, not mine** (both measured, neither changed):
   - `year-summary` counts **realized gains** inside "All money in". $2,190.48
     of 2025's $38,409.23 headline is an accounting result, not money that
     arrived; the other two lines in that section (dividends, brokerage cash
     interest) are real inflows. Naming the term was a copy fix (§9); deciding
     whether a gain belongs in a money-in total would move the headline.
   - The statement-reminder trade in §9: a one-off late close now delays the
     reminder for one cycle. Reversing it is one line.
3. **Three mutants recorded as equivalent, with their arguments** (§7 and §9).
   If any turns out not to be, the argument is written down to be attacked.

---

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
