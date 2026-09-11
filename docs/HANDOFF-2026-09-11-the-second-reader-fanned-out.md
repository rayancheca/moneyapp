# Handoff — the second reader, fanned out: 58 findings, 53 survived, 45 fixed

> **Supersedes `HANDOFF-2026-09-10-the-window-that-was-not-a-month.md`.**
>
> Repo: **`/Users/rayankarimcheca/dev/MoneyApp`**, `main`, tree clean, pushed.
> tsc clean · **4,845 unit** · `E2E_GATE=1` at `maxDiffPixels: 0` ·
> `pnpm ledger-check` exit 0.
>
> Ledger: **10,178 active rows · 37 uncategorized — UNCHANGED.**
> **ZERO real-DB writes for five sessions.**
>
> **24 fix commits. ~45 distinct defects.** Every figure in this document was read
> off the running app or measured in SQL on 2026-09-10; the session ran past
> midnight, so a few late re-reads are dated 2026-09-11 and say so.

---

# ⛔ 0. THE JOB — what is next

**One decision was put to you and you answered it** (§2). Nothing else waits.

1. **⛔⛔ `BTLEServer` at 100% of a core, for 19,550 CPU-minutes.** Seven
   handoffs have now asked. **Reboot.** It is why `vitest` refused to start
   four times this session and why five test files "failed" at 5.5s, 33s, 55s,
   252s and 985s — every one of them passing alone on a quiet box.
2. **10 confirmed findings are left unfixed** — §7 lists them with their
   measurements, followed by 5 more I deferred on purpose. That is the queue.
3. **28 merchants still queued for the paid Claude pass.** Unchanged. 37 rows
   have no category; coverage reads 99.6%.
4. **Pass 78 onward** — `docs/program-passes-60-94.md`. **HOSTING LAST.**

---

## 1. ⭐ THE SHAPE OF THIS SESSION: TWELVE READERS, THEN THREE SKEPTICS EACH

The last three sessions read surfaces one at a time, then harvested one
sentence family at a time. This one **ran twelve independent lenses over the
whole app in parallel and made three adversarial verifiers try to refute every
finding before any of it was believed.**

    186 agents · 6,195 tool calls · 55 minutes
    58 findings · 53 survived · 5 refuted

**The five refuted ones are the point.** Two of them I had independently judged
NOT to be defects before the verdicts came back — the forecast band's "all of
it running late" and the `/budgets` "33% has passed" arithmetic — and the
agreement is what makes the other 53 worth acting on. Do not skip the verify
phase to save time; it is what stops a pass filing noise.

⛔ **Write the lens prompts against the app's own doctrine, not against
general code review.** The twelve that worked were: span collapsed into a
container · denominator and population · two texts on one element ·
a boolean that tests a proxy · counts, plurals and zero states · date-window
arithmetic · dialogs and destructive actions · surfaces no screenshot opens ·
tense and modality · sums and identities · superlatives · direction and sign.
**All twelve produced a confirmed finding and ten of them produced a
high-severity one** — the two that did not (`counts-plurals`, `denominator`)
still returned five and four each. Do not drop a lens for being unglamorous.

⭐ **AND THE TWO SWEEPS STILL PAID FIRST.** Before the fan-out:

- The one-caller sweep (§9 of the 2026-09-08 handoff) — ten seconds.
- The sentence-family harvest — **1,062 pages cached with one `curl` loop**,
  then parsed and checked against SQL. Five families, **11,580 mechanical
  assertions**, of which 5,871 were done before the first agent reported:

| family | assertions | disagreements |
|---|---|---|
| merchant share sentences (window + %) | 247 | 0 after §2's fix |
| merchant cost cards (typical · purchases · total · seen · heading) | 3,515 | 0 |
| merchant rate, basis sentence and skew note | 2,109 | 0 |
| every day header on all **204** `/transactions` pages | 4,065 | 0 |
| merchant rank sentences + return notes (after §2) | 1,644 | 0 |

⛔ **Two of my own checkers were wrong before the app was.** A median that
differed by one cent on 33 pages was `Math.round` half-up in JS against Python's
banker's rounding. A "missing day header" on four pages was a day whose subtotal
is exactly `$0.00` and renders with no sign. Re-derive the convention from the
source before filing.

---

## 2. ⭐⭐ THE ONE DECISION, AND WHAT IT CHANGED

`Best Buy` charged **$3,758.43** and returned **$3,540.71** of it. It cost
**$217.72**. The page read:

    Best Buy is the largest of your 250 regular merchants, at $3,758.43.
    Best Buy is 21.3% of what you spent on Shopping over Dec 5, 2022 – Jul 24, 2026.
    Total  $3,758.43

`Apple Store` sat **15th of 250** on $1,248.80 charged and **$0.00** net — all
three purchases returned, on one day, a week later.

**You chose: the Total and the rank say what a merchant COST.** Visit
statistics stay gross, because a returned purchase was still a visit that cost
money on the day — the rule `merchants.ts` already states for why a refund is
not a visit.

    24 purchases came to $3,758.43, less $3,540.71 returned across 8 rows.
    Typical visit $91.29 · mean $156.60     24 × $156.60 = $3,758.43
    Year bars   957.29 + 575.90 + 1,499.11 + 475.73 + 250.40 = $3,758.43
    $3,758.43 − $3,540.71 = $217.72 = Total, and $4.99 a month over 1,328 days
    Best Buy is the 55th largest of your 250 regular merchants, at $217.72.
    Best Buy is 1.2% of what you spent on Shopping over …

⛔ **The years and the mix were netted first and reverted.** Netted,
`Best Buy`'s 2024 bar reads **-$1,004.99** — that year's returns outran its
purchases — and the bar is measured from the largest year and drawn from
`left: 0`, so a negative width renders as **no bar at all**: the most extreme
year would have read as the emptiest. Thirteen of 250 merchants carry a refund;
only Best Buy would have drawn one.

**Separately and not a decision: the SHARE was a mixed basis.** The whole came
from `categorySpending`, which nets refunds; the part came from
`dominantCategory`, which counts outflows only. Both sides come off ONE row
list now. Nine sentences moved, and the mix had also SILENCED a true one —
`DraftKings` charged $1,294.30 against a Gambling total of $831.11, so
`part <= whole` failed and it got no sentence at all. It is $794.30 of $831.11.

---

## 3. ⭐ "IMPLIES $1,047.00 OF EARNINGS IN THIS PERIOD" — OF NINE DAYS OF IT

The headline the harvest found before any agent ran. `cashEarnings` bounds the
implied figure at `today`, so **every period still running was counted to the
day and captioned with the whole container**:

    /spending?period=2026-09   "$1,047.00 … in this period"
                                 September's own schedule is $4,188.00 — 4×
    /spending?period=2026-Q3   "$10,470.00 … in this period"
                                 the quarter's own is $13,611.00
    /spending?from=2026-09-01&to=2026-12-31
                               "$1,047.00 … in this period", over a window
                                 holding seventeen paydays

`/budgets` says "4 paydays fall in this month, scheduled at $4,188.00" about the
same month. **Two surfaces, four times apart, on one figure.**

⛔ `cashEarnings` already published what it should say. `firstPeriodOn` /
`lastPeriodOn` carry the docstring *"NOT the window: a line that names the
window over a count bounded by the series says something false about both"* —
and `income-card`'s `paydaysLabelFor` was their ONLY reader. The dashboard row
it builds, **"14 paydays, Jun 4 – Sep 3"**, is what this now matches:

    on Sep 3, 2026 · over Jun 4 – 25, 2026
    over Jul 2 – Sep 3, 2026 · over Jun 4 – Sep 3, 2026

1, 4, 10 and 14 Thursdays at $1,047.00. **Every figure reproducible from its own
label**, and the visual gate caught it — sixteen `spending` baselines went red
at `maxDiffPixels: 0`, and the fixture expresses the defect exactly.

---

## 4. ⭐ "+$47,478.87 · ASSETS · 1Y" — AND THE DASHBOARD COULD NOT CLOSE

On one switcher, over one range:

    Assets      ▲ +$47,478.87 · Assets · 1Y          (no %, no scope)
    Owed        ▲ +$41.82 (+9.7% excl. Venture X, opened Jan 13, 2026)
    Net worth   ▲ +$8,434.38 (+12.7% excl. Robinhood Crypto, Venture X +2 more)

and 47,478.87 − 41.82 is not 8,434.38.

The 1Y start covers five asset accounts totalling $67,020.10; today's
$114,498.97 covers eight. **$39,002.67 of that "growth" is Robinhood Crypto,
Wells Fargo and Cash on Hand OPENING** — in the end total, in neither the start
total nor any exclusion note.

⛔ **THREE BUCKETS, and `rollupLine` had two.** `splitMissing`'s docstring names
the very account it broke on: *"`Capital One 360 Checking` holds zero rows and
zero balances, so it has no `opensOn`, so it fell through to `gapAccounts` on
all 1,464 days of the live series."* That was fixed in `derivation`, which
passes `hasHistory` and gets an EMPTY bucket back — and this second
implementation of the same question kept the old answer. A permanent gap makes
`sharedCoverageChange` bail before it can compare like with like.

Net worth escaped because `derivation` builds it. Owed escaped because no
liability account is empty. **One rule, one caller, and the second caller was
the one on screen.** Now:

    ▲ +$8,476.20 (+12.6% excl. Cash on Hand, Robinhood Crypto +1 more) · Assets · 1Y
    ▲ +$41.82 (+9.7% excl. Venture X, opened Jan 13, 2026) · Amount owed · 1Y
    ▲ +$8,434.38 (+12.7% excl. Robinhood Crypto, Venture X +2 more) · 1Y

8,476.20 − 41.82 = 8,434.38, to the cent.

---

## 5. THE SPAN FAMILY — SEVEN MORE OF THE SAME SHAPE

Item 2 of the last prompt said *"look for the same shape wherever a span is
collapsed."* It was there seven more times.

| where | said | measured over |
|---|---|---|
| `/investments?view=returns&range=1M` | "Worst day −$3,394.03 · Fri, Jun 5, 2026 · mdd −23.91%" | the WHOLE series. In window: Sep 2, −$845.53, −2.02%. **35 of 66 (page × range) wrong**, drawdown in 27 |
| `subBuckets` month buckets | "Jun" | Jun 15–30. YTD's last bar holds ten days; ALL clamps both ends |
| `subBuckets` day buckets | "25" twice in one window | Jul 25 and Aug 25 |
| the insight panel's count | "94 transactions landed in Food." | ONE month — 94 in Jul 2026 against 2,735 all time. Its three siblings all carry the window |
| a custom chart window | "Nov 15 – Feb 3" | 2025-11-15 → 2026-02-03, beside "opened Jan 13, 2026" on the same line |
| an annual series' Next | "Jan 16" | **2027**-01-16 — and 2026-01-16 is exactly the day it last charged |
| the sheet's merchant panel | "At Netflix · 18 txns" over "$0.00" | 18 is all time, $0.00 is 2026. **512 of 851 merchants differ; 389 print $0.00 beside a real history** |

⛔ `dayWindowLabel` is the app's rule and it had **no direct test** despite six
surfaces reading it. It does now.

---

## 6. ✅ WHAT WAS CHECKED AND FOUND RIGHT

Beyond the 11,580 in §1:

- **The 2026-09-10 fixes all hold.** 247 merchant share sentences exact in
  window and percentage; 4,065 transaction day-header assertions exact across
  all 204 pages; "Nothing has been imported for 10 days of it" exact against a
  ledger stopping 2026-08-31.
- **"all of it running late"** on the forecast's Money in band. "Running late"
  is the app's vocabulary for *evidence past tolerance*, `SERIES_EVIDENCE_NOTE`
  defines it, and the band carries a `title` pointing at the footer that does.
  Refuted 3/3.
- **`/budgets` "33% has passed" vs `/recurring` "21 of 30 days remaining".**
  Refuted — they are elapsed-fraction and remaining-days-inclusive, and
  10 + 21 = 31 only if you add two different conventions.
- **The transfer tower's `<desc>`** pointing at the Spine and Table views.
  Refuted.
- **The `/budgets` "no spending imported since <date>"** proxy. Refuted.
- **The "irreversible" lines** that then say how to reverse. Refuted — the
  marked line is irreversible; the reassurance is about the rest.
- **Every forecast component, arrears figure and payday count on `/recurring`
  and `/budgets`** re-derived by hand: `$3,567.60` committed over 9 lines,
  `$69.86` running late, `$977.25` never billed, `5 bills totalling $2,405.07`,
  `4 paydays … $4,188.00`, `$349.00 under the annualised figure`. All exact.
- **`/imports`' coverage prose.** `Cash on Hand` "carries that balance forward
  for 7 days; the first day it does not is Aug 11, 2026 — 1 day rests on
  entries alone" is exactly its 1 anchored + 7 carried + 1 derived_unverified
  rows. `Robinhood Cash`'s "26 days … of 52 unchecked in all" is two runs of 26.
- **"2 accounts nothing is checking"** on `/imports` — it agrees with the
  dashboard trust card's "2 are priced from holdings, 2 have nothing checking
  them, 1 is empty". Not a population mismatch.

---

## 7. ❓ THE QUEUE — 10 CONFIRMED FINDINGS LEFT, PLUS 5 DEFERRED

Every one survived three adversarial verifiers. The refuter count is in
brackets (0 = unanimous).

**MEDIUM**

1. **[0] `/categories/<Uncategorized>` asserts a measured zero over months that
   hold rows filed on that exact category.** `SELECT count(*) … category_id =
   '019f4c7d-cc8c-7dad-af32-bc6e0d53640c' AND posted_on BETWEEN '2023-11-01'
   AND '2023-11-30'` → **3**; all-time on that id → **6**. `/categories` renders
   the row as "Uncategorized · Locked · 37 txn" and links straight to the page
   that says zero. ⚠️ **This is a consequence of the 2026-09-03 normalisation**
   ("a row filed on the system Uncategorized reads as category-less to every
   aggregate") and may be a decision rather than a defect — put it to him.
2. **[0] The subcategory rows on transfer / investment / rewards category pages
   strip direction and sort by the OPPOSITE frame.** `category-detail.ts:106`
   flips back to money-in for `income` only. Investments July 2026: header
   "-$3,090.00" over a child row printed "$3,090.00", and the child's own page
   says "-$3,090.00". Transfers all-time: two children are money OUT and five
   money IN, printed identically with no sign or word, ordered by the money-OUT
   frame — so the biggest movement ($58,150.92 in) is listed last.
3. **[1] Transfer spine labels a NET figure as a share of GROSS volume.**
   `share = Math.abs(netCents) / data.totals.grossCents` — an account's NET
   (in − out) over the whole ledger's GROSS volume. Chase Checking:
   136,433.19 / 415,945.05 = 33%, where its share of that volume in the same
   out-leg convention the total is built from is 172,517.92 / 415,945.05 = 41%.
   The eight labels sum to 91.06% (printed 89%) and **can never sum to 100**.
4. **[1] Net-worth terrain captions its totals "12 accounts"** while the same
   figure's own description says 11 ribbons are drawn. ⚠️ One refuter; the
   headline is arguably about the SET and the aria already discloses the one
   not drawn.

**LOW**

5. **[1] "N of M rows behind this page"** on `/summary/<year>` excludes the
   gambling rows the same page prints a count for. The printed 149 is the sum
   of its own section counts (35 + 89 + 11 + 14); the Gambling section beside
   them reads "Net over 19 rows", all 19 sourced from a file already in the
   list. The page stands on **168 rows, 111 sourced — "111 of 168", not
   "92 of 149"**.
6. **[1] The annualized caveat fires on `endsOn !== null`** instead of "ends
   inside the year". Only two series carry an end date: `Car lease` ends
   **2028-08-15**, nearly two years out, and is warned about a year it will bill
   in full twice over; `Car insurance` ends 2027-01-11, four months out, where
   the caveat is right. **1 of 2 is a false warning.**
7. **[1] `/transactions`' filter bar can name the merchant and the category it
   is filtered to, and its only caller passes neither.**
8. **[1] A detected bill already overdue this month shows no overdue note in
   the Suggestions section**, while the two other surfaces listing the same
   series do.
9. **[1] One page, one month, two figures for Housing.**
   `/spending?period=2026-07`: the Sankey node reads **$2,763.79** while the
   insight sentence, the Where-it-went list, the relief, the table lens and
   every `/categories` page read **$2,653.58**. Verified in SQL — Housing gross
   $2,763.79, refunds $110.21, net $2,653.58; Subscriptions $613.02 / $2.90 /
   $610.12. **The Sankey prints the gross pair and everything else the net.**
   Each panel is internally consistent (the Sankey's own "Refunds $113.11"
   node is 110.21 + 2.90), so this is one page holding two conventions rather
   than an arithmetic error — likely a decision.
10. **[1] The transfer rhythm rail's `<desc>`** still sends a screen-reader user
    to a table lens that holds none of its figures. (The `aria-label` on the same
    element was fixed; this is the second reading.)

**LEFT ON PURPOSE**

11. **Dismiss posts immediately; End is behind a full blast-radius Confirm** —
    and Dismiss costs MORE on the calendar: `recurring-calendar` builds its
    history population from `status in (detected, confirmed, ended)`, so an
    ended series keeps every posted charge drawn and a dismissed one loses them
    all. The accessible names are fixed; **the gate asymmetry is your call.**
12. **Five merchants have returns dated OUTSIDE their purchase span**, so the
    Total nets a refund the windowed share cannot see. On `Apple Store` that is
    all of them — "Total $0.00" above "100.0% of what you spent on Shopping over
    Mar 23 – 24, 2026", and over those two days it really was. Widening the span
    would move `Seen`, `spanDays`, the rate's basis and all 248 share windows.
13. **The per-account rows under the sheet's History card** carry the same
    count/money split the header now names.
14. **The rounded staleness tolerance can equal the day count that triggered
    it.** `Rocket Money`'s tolerance is 48.6 days and prints as 49; at 49 days
    elapsed the sentence would read "49 days, past the 49-day tolerance". Not
    reachable today — it was on 2026-09-02.
15. **§7 of the 2026-09-10 handoff still stands** — the Honesty check's empty
    state, `Charged since May 2024`, the six local `plural` copies, the 227
    shared `<title>`s, `/transactions`' filter empty state.

---

## 8. NOTES THAT COST TIME, AND WOULD AGAIN

- ⭐⭐ **RUN THE WORKFLOW EARLY AND KEEP WORKING WHILE IT RUNS.** Fifty-five
  minutes of twelve-lens fan-out is fifty-five minutes you spend on the
  sentence-family harvest. I found four defects by hand in that window and the
  agents found the other fifty-four.
- ⭐ **THE VERIFY PHASE IS NOT OPTIONAL.** Five of 58 were refuted, and two of
  those I had independently judged correct. Three verifiers per finding, each
  told to default to `refuted: true`.
- ⛔ **THE MAC MADE `vitest` LIE FIVE TIMES.** `BTLEServer` has burned 19,550
  CPU-minutes. The load guard in `scripts/quiet-box.ts` refused to start four
  runs (good), and the runs it allowed reported failures at 5.5s, 33s, 33s, 55s,
  252s and **985s** — every one passing alone. **A multi-second duration on a
  unit test is a load flake.** Wait for load < 7 with
  `until [ "$(uptime | sed 's/.*load averages: //' | awk '{print int($1)}')" -lt 7 ]; do sleep 10; done`.
- ⚠️ **`test-results/` feeds `fseventsd`.** Sixteen failed-test artifacts with
  traces kept the load average above 20 for ten minutes after the gate ended.
  `rm -rf test-results` before re-running anything timing-sensitive.
- ⛔ **A fixture that cannot express a condition cannot test it — again.**
  `provenance.test.ts`'s `addPeriod` always wrote `endingBalanceCents: 1000`, so
  the "carries no balances" branch it was written to pin could not be reached.
  It takes the balances now, and the real ledger settles it: all 4
  `not_applicable` periods hold NULL, all 202 `reconciled` and all 40
  `value_anchor` hold them.
- ⚠️ **`Math.round` is half-up in JS and banker's in Python.** 33 merchant
  medians "disagreed" by one cent until my checker used `floor(x + 0.5)`.
- ⚠️ **A day whose subtotal is exactly `$0.00` renders with no sign.** Four
  `/transactions` pages looked short a day header.
- ⚠️ `npx vitest run --maxWorkers=4` — 4,845 in ~30s on a quiet box. Full e2e
  ≈ 9 minutes. `pnpm build` needs the dev server stopped.
- ⚠️ **THE GATE IS NOT BLIND, and this was its best showing yet.** Third session
  running. The closing run went red on **35 of 599** across four families, and
  every one was a sentence I had changed on purpose:

      16 spending / spending-year   "in this period" → "on Jul 3, 2026"
       8 account-detail             "landed in X." → "landed in X since it opened."
       8 category                   "landed in Housing in Jun 2026." and
                                      "every LIVE SPENDING account has been shown through"
       1 zz-golden-path             the same account-detail sentence
       2 zz-zz-zz-duplicate-pairs   ⛔ NOT a pixel diff — a REAL BREAK

  ⛔ **An `aria-label` REPLACES the accessible name, and two e2e specs located
  a button by the old one.** `getByRole("button", { name: "Undo" })` stopped
  matching the moment the button was named "Restore the retired $12.50 copy
  from …". Naming a repeated trigger is the right fix and the specs move with
  it — but expect this every time, and grep `e2e/` for the old string BEFORE
  running nine minutes of gate.

  `node scripts/crop-visual-diff.mjs <test-results dir> <name>` settled all 33
  pixel diffs in one glance each. At 320 the cash-earnings crop shows a 16px
  page-height delta — the sentence wraps one line further, so everything below
  shifts and the changed-pixel count balloons to 53,843. **A large diff whose
  bbox starts at the changed sentence and runs to the page bottom is a reflow,
  not a second change.**
- ⛔ **The dev server was left STOPPED** — the build and the gate both need
  `.next`. Restart it with `pnpm dev` if you want :3000 back.

---

## 9. WHAT WAS MEASURED, AND WHEN

Every figure here is **as of 2026-09-10** unless stated. Net worth read
$113,656.08 throughout. The session ran past midnight; the closing gate and the
last two commits are dated 2026-09-11 and the ledger did not move.

Confirmed live on the rebuilt bundle after the fixes:

    /?chart=assets       "▲ +$8,476.20 (+12.6% excl. Cash on Hand,
                           Robinhood Crypto +1 more) · Assets · 1Y"
    /?chart=liabilities  "▲ +$41.82 (+9.7% excl. Venture X, opened Jan 13, 2026)"
    /?chart=combined     "▲ +$8,434.38 (+12.7% excl. Robinhood Crypto,
                           Venture X +2 more) · 1Y"
    /merchants/<Best Buy>
                         "24 purchases came to $3,758.43, less $3,540.71
                           returned across 8 rows" · Total $217.72 ·
                           "the 55th largest of your 250 regular merchants,
                           at $217.72" · "1.2% of what you spent on Shopping"
    /merchants/<DraftKings>
                         "95.6% of what you spent on Gambling over
                           Apr 7, 2025 – Jun 9, 2026"  (previously silenced)
    /spending?period=2026-09
                         "implies $1,047.00 of earnings on Sep 3, 2026"
    /spending?period=2026-Q3
                         "… over Jul 2 – Sep 3, 2026"
    /recurring           "3-mo avg $2,033.33 + trend $0.00 (one typical month,
                           which the $3,050.00 slope was capped to)"

---

# 📋 THE PROMPT FOR THE NEXT SESSION

> Read `docs/HANDOFF-2026-09-11-the-second-reader-fanned-out.md` first — it is
> the brief. §0 of it is the job and §7 is the queue.
> Repo `/Users/rayankarimcheca/dev/MoneyApp`, `main` clean and pushed. Baseline:
> 4,845 unit · tsc clean · `E2E_GATE=1` at `maxDiffPixels: 0` ·
> `pnpm ledger-check` exit 0. Ledger: 10,178 active rows · 37 uncategorized.
> Zero DB writes for five sessions.
>
> No decision is waiting on me. The job is the same as the last eleven
> sessions: find what is wrong. Do not invent features.
>
> 1. ⭐⭐ **Start the twelve-lens workflow in the FIRST five minutes**, then do
>    the two sweeps by hand while it runs. §1 has the twelve lenses that worked
>    and the doctrine to paste into each prompt. Three adversarial verifiers per
>    finding, each told to default to refuted — five of 58 were refuted and two
>    of those I had independently judged correct.
> 2. ⭐ **§7 is a queue of 15 already-measured findings.** Verify each against
>    the app before acting on it — it is a day old and the ledger may have moved
>    — but the measurement is there.
> 3. **Prove a new test can fail.** Revert the fix, run the test. Reverting one
>    arithmetic line should fail exactly the tests that pin it and nothing else.
> 4. ⛔ **The box lies when it is busy.** `BTLEServer` has burned 19,550
>    CPU-minutes; a unit test taking 33 seconds is a load flake, not a
>    regression. Wait for load < 7, and `rm -rf test-results` first.
> 5. When a figure is right and a sentence about it is wrong, the sentence is
>    the defect — but VERIFY first: §6 lists eight things that looked wrong and
>    were not, and two of my own checkers were wrong before the app was.
> 6. If you find a decision, put it to me EARLY with the measurement.
> 7. HOSTING goes last. Never propose a hosted-DB migration.
