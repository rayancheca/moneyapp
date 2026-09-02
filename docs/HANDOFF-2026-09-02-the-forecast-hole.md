# Handoff — a $2,291.21 hole in the month's forecast, six switchers made real, and eleven more found by reading

> **Supersedes `HANDOFF-2026-09-01-twelve-boundaries.md`.**
>
> Repo: **`/Users/rayankarimcheca/dev/MoneyApp`**, `main`, tree clean, pushed.
> tsc clean · **4,491 unit** · coverage gate exit 0 ·
> **E2E_GATE=1: 598 passed at `maxDiffPixels: 0`** · `pnpm ledger-check` exit 0
> on every commit via `.githooks/pre-commit`.
>
> Ledger unchanged: **10,111 active rows · income $117,924.62 · spending
> $167,828.49 · ZERO DB writes this session.** The only thing this session wrote
> to your database is view preferences, which is the feature you asked for.
>
> 81 baselines regenerated, every diff cropped and read first.

---

# ⛔ 0. THE JOB — what is next

**Your two decisions are both closed.** You said keep the arrears
month-scoped, and wire the view dimensions URL + sticky. Both are done, and the
first one is now written down in the code so a future session cannot re-open it
by accident.

What is left for you:

1. **❓ Two cards on your dashboard state the monthly cost of the same 13
   recurring series, and differ by $210.87** (§7). Both are right. Only you can
   say whether they should be made to look different or made to agree.
2. **❓ Three smaller things I looked at and deliberately did not change**, each
   with the measurement behind it (§8).
3. **Two decisions carried from earlier sessions**: realized gains inside "All
   money in" on `/summary/[year]`, and the statement-reminder trade.
4. **⛔⛔ `BTLEServer` HAS NOW BEEN AT 100% OF A CORE FOR 51 DAYS.** `uptime`
   reports 51 days without a reboot and the daemon has been pinned the whole
   time. Nothing in this repo causes it. **A reboot is the fix**, and it is
   eating a core of every build you run.
5. **Pass 76 onward** — `docs/program-passes-60-94.md`. **HOSTING LAST.**

---

## 1. The queue was empty, so the job was to find what is wrong

Eleven defects, and the highest-yield twenty minutes were the ones you named:
**open the app and read it.** Ranked by what they put on your screen.

| # | what the screen said | what is true |
|---|---|---|
| 1 | recurring: September will cost **$1,276.39**, ending with **$8,429.87** | $3,567.60 and $6,138.66 — rent was in neither leg |
| 2 | dashboard: "Every recurring payment on the books **has charged** recently enough to still be counted" | five rows below it read "never billed" |
| 3 | dashboard: "**13 paydays** in this window", under "Measured from **Mar 2026** to today" | 13 weekly paydays cannot span 26 weeks |
| 4 | dashboard: "nothing checks it since Dec 5, 2023 · **52 days**" | the span is 1,001 days; 52 is a COUNT |
| 5 | /spending: "Housing is **the largest** of your 12 spending categories, at $2,653.58" | over a table reading Car $6,457.58 for the period on screen |
| 6 | /spending: "**Sep 2026** is still being imported, so these read Jul 2026" | with August selected, and August skipped in silence |
| 7 | /categories: "**2** categories hold no transactions" | over a list showing **eight** em dashes |
| 8 | dashboard: an account headed "**on Hand**" | it is called Cash on Hand |
| 9 | /investments, spoken: "**Wed, Sep 2, 2026**: $107,097.05" | the series ends Sep 1; Sep 2 is a hold |
| 10 | /budgets: "no spending imported since Aug 12 · **2 days** unaccounted" | 21 days elapsed; the 2 is the period's |
| 11 | six switchers declared a URL key and honoured none | `/?chart=terrain&terrainLens=table` opened on the relief |

Every one is the class the last two sessions named: **a pair of true statements
made false by sitting next to each other**, or **two surfaces answering one
question differently**. Ten of the eleven were found by reading the running app,
not by grepping it. One (§6) was found by a test I wrote for something else.

---

## 2. ⭐ THE ONE THAT MOVED REAL MONEY — a bill in neither leg of the forecast

`/recurring` on 2026-09-02 said September would cost **$1,276.39** and end with
**$8,429.87** in cash. Both figures were missing **$2,291.21** — your rent
($2,109.00) and rent utilities ($182.21), both due September 1, neither posted.

The mechanism is a gap between two rules that are each correct:

- the FIXED leg of the running month opens on `today`
  (`fixedComponents(db, today, today, monthEnd)`), so a September 1 occurrence
  is behind it;
- the VARIABLE leg excludes every recurring-tagged row
  (`isNull(transactions.recurringSeriesId)`), so a pace can never double-count a
  bill.

A bill that came due earlier this month and never posted therefore fell into
**neither**, and left the projection entirely. `forecast.ts` contained no notion
of arrears at all — not a decision, a hole.

**The same app already published that exact figure twice, on two other screens.**
`/budgets`: *"2 bills totalling $2,291.21 due by today and no import has covered
them yet."* The runway card: *"A further $2,291.21 came due earlier this month
and never posted."* Three surfaces, one bill, two answers.

⛔ **It is wrong in both worlds, which is why it is not a judgement call.** If
the bill has not been paid, it will be, and the month owes it. If it HAS been
paid and the statement is not imported, then the cash balance the projection
starts from predates the payment — so the money still has to leave EOM cash.

    PROJECTED SPENDING  -$1,276.39  ->  -$3,567.60
    EOM CASH             $8,429.87  ->   $6,138.66
    EOM NET WORTH      $114,601.31  ->  $112,310.10   (both read in one minute; see §10)
    committed lines              7  ->           9

### How it is built, and the three things that constrain it

- **`overdueForSeries` moved to a new `services/arrears.ts`.** It could not
  simply be imported: `budgets.ts` already imports `trailingFullMonths` from
  `forecast.ts`, so the rule needed a home neither owns. Every existing import
  path still resolves — budgets re-exports it and its two types — so no caller
  churned. Three surfaces now answer "what came due and never arrived?" out of
  one implementation, which is the whole point.
- ⛔ **The legs ABUT, never overlap.** Forward is `[today, monthEnd]`; arrears
  closes the day BEFORE today. **A bill due today is DUE, not late**, and the
  forward leg owns it — the same edge `committedBook` pins, stated the same way,
  so the two cannot disagree about the one day a month where they meet.
- ⛔ **MONEY-OUT ONLY.** A payday that came and went without a deposit is
  evidence about the IMPORTS, not about the job — and projecting it as
  still-to-come would inflate EOM cash on a ledger whose owner is paid in cash.
  `overdueForSeries` keeps only negative occurrences, so this falls out of the
  rule rather than being bolted on.

⭐ **Five tests, and the mutation pass earned its keep.** Three guards died on
the first try — legs overlapping on today, the window opening on `today` instead
of the month start, the sign flipped. The fourth, **the transfer-kind filter,
SURVIVED**: without it a card payment that came due on the 1st and had not
imported posted itself into September's *spending*. It has its own test now.

⚠️ **One latent bug fell out of it.** `staleComponentEntries` was documented as
"keyed by label … one per series" and keyed nothing. Harmless while one series
meant one component — and a weekly bill overdue on the 1st and due again on the
8th now makes two, which would have counted one series as two running late. It
dedupes now, which is what its docstring already claimed.

---

## 3. Three cards that refuted themselves on one screen

**The subscriptions card.** *"Every recurring payment on the books has charged
recently enough to still be counted"* — with five rows below it wearing a "never
billed" badge, and its own footnote reading *"$1,461.69 of the figure above —
38.9% of it — has never been billed by a bank."* The branch condition is that
nothing has LAPSED, and a series that never charged cannot lapse; that is
exactly why it survives into `live`. It speaks about going quiet now and claims
nothing about charging.

**The trust card.** *"nothing checks it since Dec 5, 2023 · 52 days"*. The span
is 1,001 days. The 52 is a count of unchecked days — and the same card closes
with *"checked through 2026-07-31 — 33 days ago"*, where the identical shape
means elapsed time. One card, one shape, two quantities. The row says **"52 days
unchecked"** now, which is the vocabulary `/imports` already uses for this exact
number: *"52 days rest on an export with no closing balance."*

**The income card.** *"13 paydays in this window"*, one line under *"Measured
from Mar 2026 to today."* Thirteen WEEKLY paydays cannot span twenty-six weeks.
Both halves were true: `cashEarnings` bounds the count by the SERIES' own life
(your job's first payday is 2026-06-04), and only the window was ever named. The
row names its own span now — **"13 paydays, Jun 4 – Aug 27"** — and a reader can
check it: twelve weeks, thirteen Thursdays.

⚠️ The last one needed a real change, not a wording one: `cashEarnings` now
returns `firstPeriodOn` / `lastPeriodOn`, read off **the very steps it counted**
rather than re-derived. A fifth mutant — collapsing "1 payday, Aug 20" into a
range of one day to itself — survived until it got its own test.

---

## 4. Two surfaces telling you about a month you did not select

`/spending` with **August** on the period selector printed, above the fold:

> Jul 2026
> **Sep 2026** is still being imported, so these read Jul 2026 — the newest month
> every account has been shown through.
> **Housing is the largest of your 12 spending categories, at $2,653.58.**

…directly above the page's own table reading **Car 70% $6,457.58** for August.

Two separate problems, and the panel is deliberately period-independent, so
neither is fixed by making it follow the selector.

1. **A two-month jump explained by a one-month reason.** August is skipped in
   silence, and a reader with August selected is left asking about it.
   `moversCard` walks BACK from the current month and takes the first candidate
   every live spending account is imported through — so every month between the
   window and today failed that test *by construction*. The note says that now:
   *"Jul 2026 is the newest month every account has been shown through, and no
   month after it is fully imported yet — so these read Jul 2026 rather than
   Sep 2026."*
2. **A superlative with no window.** The module's own docstring promises every
   sentence names its own window, and the share fact beside it already did. The
   rank fact does too now: *"…of your 12 spending categories in Jul 2026"*.

⚖️ **Left deliberately:** *"7 transactions landed in Housing."* still carries no
window. `CountFact` has no slot for one and its noun is pluralised by the
formatter, so naming the month there means a new grammar template rather than a
copy change — and unlike a superlative, a bare count is not contradicted by the
table below it.

---

## 5. A note counting subtrees over a list counting direct rows

*"2 categories hold no transactions"* sat directly above a list showing **eight**
em dashes. Both were right, and they could not both move:

- the NOTE counts subtrees on purpose — calling a parent that holds thousands
  through its children "empty" would be a claim about money that plainly exists;
- the ROW counts rows filed on that category itself.

One screen, two meanings of "holds transactions", three centimetres apart. The
row says which zero it is now: a parent whose subcategories hold rows is not
empty, it is **unused as a filing destination**, and that is a different fact.

    Subscriptions  —  ->  none direct   (title: 259 transactions sit in its subcategories)
    Water/Gas      —  ->  —             (genuinely nothing, anywhere)

On your ledger exactly two rows now read "—", which is what the note says.

---

## 6. ⭐ Six switchers declared a URL key and honoured none — and the sixth was not on the list

You said wire them, URL + sticky. `ViewDimension.key` is documented as *"the URL
param key AND the app_settings key for this dimension"*, and six declared one
while holding their value in `useState`: `/?chart=terrain&terrainLens=table`
opened on the relief, and every choice was lost on reload.

| what | was | is |
|---|---|---|
| terrain lens | `useState` | `?terrainLens=` (dashboard) |
| terrain camera | `useState` | `?terrainView=` (dashboard) |
| money-flow lens | `useState` | `?sankeyLens=` (dashboard) |
| **bridge lens** | `useState` | `?bridgeLens=` (dashboard) |
| massif camera | `useState` | `?massifView=` (spending) |
| tower camera | `useState` | `?towerView=` (flow) |

🔴 **THE BRIDGE WAS THE SIXTH AND IT WAS NOT ON THE HANDOFF'S LIST OF FIVE.** It
declared `key: "bridge"` — and `bridge` is already a VALUE of the `chart`
dimension, so the one name it chose was the one guaranteed to read as something
else. **The money-flow lens had the identical flaw and I did not see it either**
(`?chart=sankey&sankey=table`); the new wiring guard did, by enumerating the
registry rather than checking the two I knew about. Both carry a `…Lens` suffix
now, and the test forbids the SHAPE — *no dimension may be named after a hero
view* — rather than those two instances of it.

⛔ **`viewpoint` was declared by three components at once**, which is why none of
them could be wired one file at a time. Each camera now carries a name only its
own surface uses.

⚠️ **`options[0]` IS the default**, so every spec leads with the value its
`useState` used to hold. The terrain listed "front" first and opened on
"quarter" — reading the spec off the old switcher ORDER would have silently
changed what your dashboard draws on a cold load. The pills reorder; what you
see does not.

The components are CONTROLLED now: the value and its setter come from the
surface, and a chart handed no lens renders no toggle — which is what keeps
/spending's Sankey without one, since that surface owns a table of its own.

### The guard, and what it cost to find out it was needed

`dashboard-view-spec.test.ts` is written the way `TransferTower.test.ts` guards
/flow: it ENUMERATES THE REGISTRY. Three mutants killed — the page dropping a
`?param=`, a switcher rebound to an inline literal, a lens put back in
`useState`. /flow's own guard was extended to search the tower's file too, since
a switcher can now live beside the drawing it turns.

🔴 **AND TWO SPECS STARTED MUTATING THE SHARED FIXTURE THE MOMENT THE LENSES
BECAME REAL — 87 failures from one press.** A press persists the WHOLE resolved
view, `chart` included, and the suite shares one database:

- `networth-bridge.spec.ts` pressed the bridge's Table pill. Its own header said
  *"the Bridge/Table switcher is local `useState`, so nothing persists"* — true
  when written. It is not `zz`-prefixed, so it ran early and left every later
  spec on the bridge's TABLE: the net-worth slider absent on `/`, and eight
  visual baselines of pages nobody had touched. It restores both now, in order.
- `zz-zz-dashboard-chart-options.spec.ts` clicked the terrain's Table pill, with
  a comment explaining that it had to *because `?terrainLens=table` did nothing*.
  It LINKS now — which persists nothing **and** proves the URL is honoured,
  which the click never could.

⭐ **The lesson generalises**: making a control persistent turns every test that
presses it into a fixture mutation. Grep for the presses before shipping the
persistence, not after.

---

## 7. ❓ THE ONE QUESTION FOR YOU — two cards, thirteen series, $210.87 apart

On your dashboard, right now, two cards state the monthly cost of the **same
thirteen recurring series** and neither mentions the other:

    RUNWAY         "Committed bills come to $3,542.21 a month"
    SUBSCRIPTIONS  "$3,753.08 a month, still forecast"

Both are correct, and the difference is exactly **$210.87 = $361.49 × 7/12**.
Your car insurance is evidenced through 2027-01-11 and there is no renewal in
the ledger, so only **five** of the next twelve months carry it:

- the runway card is a RATE over a 12-month horizon, so a series that ends
  inside the horizon contributes fewer payments;
- the subscriptions card LEVELS each row to a month — what these cost per month
  *right now* — which is the right basis for the list of rows beneath it.

Neither is wrong and I did not guess which you meant. **Three options:**

1. Leave it. The car card already discloses the insurance end date, and each
   card's tooltip states its own basis.
2. Have the subscriptions card name the other basis in a clause — costs a line
   of prose on a card that is already dense.
3. Have the runway card name what shrank it ("…$3,542.21 a month, because car
   insurance is only evidenced for five more of the next twelve").

⚖️ This is the same shape as the arrears question you just answered: two
defensible readings, one money figure, and only you can say which the card
should mean.

---

## 8. ⚖️ Three more I looked at and did NOT change, with the measurement

1. **`/recurring`: "MONEY IN — all of it running late" over `Scheduled
   $4,188.00`.** None of that $4,188 is late: it is four *future* paydays (Sep 3,
   10, 17, 24). What is late is the SERIES — last matched 2026-06-05, twelve
   paydays ago. The money-out side has the same compression: *"$69.86 of it
   running late"* over charges dated Sep 5 and Sep 8. **The previous session
   reasoned about this label explicitly** (`stalePartLabel`'s docstring records
   the measurement that produced it), and the footer beneath says *"4 series are
   running late"*, which is the true form. I am not going to overturn a
   deliberate wording decision on a preference — but the header says the MONEY is
   late and the footer says the SERIES are, on one card, and you should know that.
2. **The accounts panel prints a group total as the negation of its only child.**
   *Capital One −$367.99* over *Venture X $367.99*. The group is a net-worth
   contribution; the row is what you owe, drawn in the negative tone with "Credit
   card" beside it. The convention is stated out loud on the cards card
   (*"A card balance is stored the way a statement writes a debt, as a negative.
   Shown here as what you owe."*) and nowhere on `/accounts`. A one-word fix
   exists — render "$367.99 owed" — and it is a judgement about noise on a dense
   card, so it is yours.
3. **`/imports` predicts Discover closes Sep 2 when its last statement closed
   Aug 9.** The cadence is a median over twelve statements that mostly landed on
   the 2nd, and the newest evidence — the Capital One reissue that moved the
   close day to the 9th (`moneyapp-discover-is-capital-one-now`) — does not move
   the prediction. The page says out loud that these are *"predictions from that
   history rather than a setting"*, so it is not lying; it is just slow to learn.
   Weighting recent statements harder is a real change to the schedule engine and
   wants its own pass.

---

## 9. Notes that cost time, and would again

- ⛔ **A spec that PRESSES a newly-persistent control mutates the shared
  fixture.** 87 failures, and the first 20 minutes of reading them went to the
  wrong hypothesis (a regression in `DashboardChartSection`) because the symptom
  — the net-worth slider missing on `/` — looks nothing like the cause. The
  `error-context.md` beside each failure carries the full accessibility snapshot,
  and `grep -n "pressed\]"` on it named the state in one line.
- ⛔ **`scripts/crop-visual-diff.mjs` is still the fastest way to read a
  baseline diff**, and two of the eight families this session were only
  explainable through it: `accounts` was 325 px and turned out to be a REAL bug
  in the fixture ("it Card" for "Discover it Card"), while `spending` was 75,328
  px and turned out to be one note rewrapping to two lines.
- ⚠️ **A fixture can carry the same defect as the real ledger and nobody looks.**
  The `shortNameOf` bug was found on your dashboard as "on Hand" — and the e2e
  fixture had been rendering "it Card" for **Discover it Card** in eight
  committed baselines the whole time.
- ⚠️ **`npx vitest run --maxWorkers=4`** remains the reliable invocation on this
  box; 4,490 tests in ~20s.
- ⛔ The dev server on :3000 is left running, as it was found.

---

## 10. What was measured, and when

Every figure in this document is **as of 2026-09-02**, and two classes of them
move on their own:

- ⚠️ **Crypto re-prices intraday on your ledger.** Between two reads three hours
  apart in this session, ETH went $2,455.96 → $2,395.19, the portfolio
  $107,097.05 → $106,251.52, and net worth $111,689.70 → $110,844.17. Nothing
  wrote to the database. Any EOM-net-worth figure quoted here is only paired
  with the one measured in the same minute — the DELTA ($2,291.21) is the stable
  fact, not the endpoints.
- ⚠️ **Every trailing window moves with the date.** The runway's six complete
  months, the insight panel's newest fully-observed month, the arrears leg's
  calendar month: all of them roll. Re-derive before quoting any of it.

Confirmed live at the end of the session:

    /recurring   PROJECTED SPENDING -$3,567.60 · EOM CASH $6,138.66
    dashboard    "Committed bills come to $3,542.21 a month"
    dashboard    "$3,753.08 a month, still forecast"   ← the $210.87 in §7
    dashboard    "13 paydays, Jun 4 – Aug 27" · "52 days unchecked"
    /budgets     "no spending imported since Aug 12 · 2 days of this period unaccounted"
    /categories  exactly two rows read "—", which is what its note says

---

# 📋 THE PROMPT FOR THE NEXT SESSION

> Read `docs/HANDOFF-2026-09-02-the-forecast-hole.md` first — it is the brief.
> §0 of it is the job.
> Repo `/Users/rayankarimcheca/dev/MoneyApp`, `main` clean and pushed. Baseline:
> 4,491 unit in ~20s · tsc clean · coverage gate exit 0 · `E2E_GATE=1`: 598
> passed at `maxDiffPixels: 0` in 8.2m · `pnpm ledger-check` exit 0 on every
> commit. Ledger: 10,111 active rows · income $117,924.62 · spending
> $167,828.49.
>
> My queue is empty again — so the job is to find what is wrong. Three sessions
> running have emptied it and then found more by checking their own work. Do
> that. Do not invent features.
>
> 1. ⭐ **OPEN THE APP AND READ IT BEFORE YOU GREP IT.** My dev server runs on
>    :3000 with real data. Ten of last session's eleven defects came from
>    navigating each page and reading the sentences, including the only one that
>    moved money. Every one was a pair of true statements made false by sitting
>    next to each other. That is a property of a PAGE.
> 2. **Read a BASELINE as a sentence, not as pixels.** The e2e fixture had been
>    printing "it Card" for *Discover it Card* in eight committed baselines, and
>    a gate at `maxDiffPixels: 0` was perfectly happy: it proves a page has not
>    CHANGED and says nothing about whether it was ever right.
> 3. **Keep hunting the boundary class.** Two more phrasings shipped wrong
>    numbers this month. Ask what else answers one question two ways — and
>    ⛔ before making any control persistent, grep for the tests that PRESS it.
> 4. **One decision is waiting on me in §7** — the $210.87 between two cards.
>    Put it to me early, not at the end.
> 5. HOSTING goes last. Never propose a hosted-DB migration.
>
> How I want you to work
>
> * ONE long session, ONE handoff at the very end. Commit and push to `main`
>   between items without asking.
> * No fabricated numbers. Re-derive rather than quote — correct me rather than
>   inherit me. **Crypto re-prices intraday**, so any figure standing on the
>   portfolio moves without a write.
> * Measure before you assert, and look at the page. Do NOT read money off a
>   screenshot.
> * Mutation-test every new guard. A green first run is when to break it — two
>   of last session's guards survived their first pass and needed their own tests.
> * Explain a visual diff before regenerating a baseline
>   (`scripts/crop-visual-diff.mjs`), and regenerate WITHOUT `E2E_GATE=1`.
> * ⚠️ The pre-commit hook runs `ledger-check`, NOT coverage. `src/lib/**` is
>   gated at 100% and nothing will remind you.
> * Real-DB writes: rehearse on a `.backup` copy with guards, show me, then ask.
> * I run my own dev server on :3000. Standing permission to stop it; put it back.
>
> Rules that keep biting
>
> * ⛔⛔ `BTLEServer` has been at 100% of a core for **51 days** and the box has
>   not been rebooted. Both suites refuse to start above 1.5 load per core; if
>   one refuses, that is the guard working. Reboot.
> * A fixture that cannot express a condition cannot test it — and one that
>   expresses it by COINCIDENCE hides it. `/budgets` read "since Jul 4 · 4 days"
>   in the fixture, four uncovered days against five elapsed, so the wrong
>   reading was invisible there and obvious on my ledger at "since Aug 12 · 2 days".
> * A test can ENCODE the bug, and an assertion loose enough to survive it is not
>   coverage.
> * A disclosure underneath does not undo a wrong number on top.
> * Grep for who else answers a question before fixing one caller.
> * ⛔ `react`'s `cache`, never a module-level Map.
> * `git checkout -- <file>` destroys uncommitted work.
> * TWO DEFINITIONS OF SPENDING: the headline $167,828.49 is the expense-KIND
>   signed sum; `periodTotals().spentCents` reads $175,018.27 on the same ledger.
> * `user_category_id` is an OVERRIDE, not the membership.
> * My income is cash I spend. $0 recorded is correct, not a bug.
> * ⚖️ **Arrears stay scoped to the calendar month** — I decided that on
>   2026-09-02. Do not widen the leg and do not "fix" the cliff.
> * A Playwright call that RETURNS a value usually does not retry.
> * `pnpm e2e` refuses a stale `.next` — use `pnpm e2e:fresh`, or build first.
