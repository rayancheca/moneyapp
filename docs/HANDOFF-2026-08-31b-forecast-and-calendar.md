# Handoff — the forecast that follows the month, and the bills it had stopped believing

> **Supersedes `HANDOFF-2026-08-31-new-home-and-real-commitments.md`.**
>
> **`main` = `0edb78c`**, tree clean, pushed. tsc clean · **4,230 unit** ·
> **E2E_GATE=1: 585 passed at `maxDiffPixels: 0`** (8.2m) ·
> `pnpm ledger-check` exit 0, on every commit.
>
> Repo: **`/Users/rayankarimcheca/dev/MoneyApp`** (lowercase `dev`).
> Ledger: 10,111 active rows · income $117,924.62 · spending $167,828.49 ·
> net worth $113,038.43.

---

# ⛔ 0. THE JOB — what is next

1. 🔴 **The app cannot see his income.** $0.00 recorded in August, $52.95 in
   July, against ~$10,000/month of spending, while `Cash job (weekly pay)`
   expects $1,047 a week. Unchanged and still the biggest thing. §3.
2. **Split the forecast's spending into COMMITTED and VARIABLE on screen.** §1
   ends with the measurement that makes this obvious.
3. ⛔ **The COKE stock split** — a 10× error in every historical valuation.
4. **Pass 75** onward — `docs/program-passes-60-94.md`. **HOSTING last.**

---

## 1. ✅ The forecast follows the calendar

The card said *"Forecast · August 2026"* directly above a grid showing October,
with nothing saying so. `forecastForMonth(db, monthKey, today)` now answers any
month the calendar can reach:

- the **running** month is byte-identical to `forecastCurrentMonth` (asserted);
- a **future** month is projected END TO END — the whole month remains, so the
  fixed window starts on the 1st rather than at today and the variable pace
  applies in full;
- a **past** month returns null and the card says the month has ended. A
  finished month is not a forecast; the grid below already shows what posted.

⛔ **End-of-month cash for a future month is CHAINED** through every intervening
month. "What will I have at the end of October" cannot be answered from October
alone. ⚠️ My own first test skipped August and failed — which is exactly why the
figure cannot simply be added to today's balance. Bounded at 24 months because
the chain is a loop.

### 🔴 The forecast was the only surface still paying the dead

`seriesHasLapsed` (3 missed cycles) already existed, and `budgets.ts` and
`recurring-calendar.ts` both used it. **`forecast.ts` did not**, so the three
surfaces disagreed about which commitments are alive. On the real ledger that
put **$1,779.49 a month of a PREVIOUS LANDLORD** (`DIRECT PAYMENT HOFFMAN LL`,
last charged 2026-01-08) into every future month beside the current rent, plus
three 2024-era subscriptions silent for over two years.

September's projected spending: **$13,632.66 → $11,765.34**.

⛔ **MONEY-OUT ONLY, and I got it wrong first.** Applying the lapse rule to
everything dropped `Cash job (weekly pay)` — his ONLY income series, whose
deposits have not been imported since July — and September's projected income
collapsed **$4,233.69 → $45.69**. The asymmetry is the whole rule: a dead
outflow that keeps projecting is conservative; a live inflow dropped for want of
an IMPORT is a false alarm. `LAPSED_MISS_LIMIT` says "money-out" in its own
docstring.

### ⛔ The measurement that should drive the next change

September, as the app now projects it:

| | |
|---|---|
| income | **$4,233.69** |
| spending | **$11,765.34** |
| — of which COMMITTED (rent, fees, lease, insurance, gym, FPL, internet, …) | **$3,567.60** |
| — of which VARIABLE (his own 3-month pace: Travel $2,235, Food $1,686, Shopping $1,151, …) | **$8,197.74** |

The owner expected "3-5k" of spending. **He was right about his committed
bills** — the card just shows one number and never separates them. Splitting
that line is probably the single most useful change left on this page.

⚠️ And look at `Travel`: *3-mo avg $1,018.29 **+ trend $1,216.57***. The trend
nudge more than DOUBLES a lumpy category. `(newest − oldest) / 2` is very
unstable on a category that fires a few times a year, and it is the largest
single line in his projection.

---

## 2. ✅ The calendar can be screenshotted

`CalendarGrid` sizes days `aspect-square` — exactly right at 320px, and wrong at
1280px where a column is ~150px wide and therefore **~150px tall**. Six rows of
that is a grid the owner had to scroll and could not capture.

A new **`?cal=` view dimension**: **Regular** (the new default), **Compact**,
**Tall** (the old uncapped square). Implemented as a `sm:`-gated `max-height`, so
no narrow screen is touched and the square keeps applying wherever it still fits.

⚠️ **Compact DROPS content rather than squeezing it.** Capping the height alone
left the name line and the weight column in the box and they spilled into the
row below. A cell half the height carries half the content: WHO (the merchant
tile) and HOW MUCH (the figure, at 13px instead of 11).

⚠️ The month stays CLIENT state while the density goes in the URL, deliberately.
Paging is rapid and repeated: a navigation per arrow-press would remount
`CalendarGrid` and drop its roving-tabindex focus, which is the whole keyboard
story of the grid. A density is a rare, deliberate choice worth putting in a
link — and it is registered in `e2e/view-options.spec.ts`, because an option
nobody enumerates is an option nobody opens.

---

## 3. 🔴 Still the biggest thing: the app cannot see his income

| month | recorded income | recorded spending |
|---|---|---|
| 2026-06 | $5,377.30 | $12,349.01 |
| 2026-07 | **$52.95** | $10,353.96 |
| 2026-08 | **$0.00** | $9,412.53 |

A data gap, not a life event — `docs/income-ground-truth.md` records $117,924.62
over the ledger's life and the app already has a cash-earnings disclosure for
exactly this shape. What it needs is a measurement: are the deposits missing
from the imports, landing in an unimported account, or arriving as cash that
never reaches a statement?

---

## 4. Still open

- 🔴 Income invisible for two months — §3.
- **Split committed vs variable in the forecast card** — §1.
- **The `Travel` trend nudge** doubling a lumpy category — §1.
- ⛔ **The COKE stock split** — a 10× historical-valuation error.
- **`Parking` renewal price** — he wrote "268.86" once against "368.86".
- **`Breezeline (internet)` provider name** — the screenshot's logo is not
  Breezeline's; amount and cadence match, so the series was corrected not
  replaced.
- **Four dead series still in the DB** (`DIRECT PAYMENT HOFFMAN LL`, `TMOBILE*`,
  `CHATGPT SUBSCRIPTION`, `YOUTUBEPREMIUM`). The forecast now ignores them, but
  they still show on `/recurring`; retiring them is a real-DB write.
- **The archive folder drift** — `migrateStorageLayout` would re-derive it.
- **Eight crypto price marks** in `ledger-check`'s baseline.
- Discover missing five statements · 45 `WEIXIN*` rows · HBO Max renewing ·
  4 unpaired transfer legs.

---

## 5. Notes that keep costing time

- ⛔ **Three surfaces can disagree about one rule.** `seriesHasLapsed` existed
  and two of its three callers used it. Grep for who ELSE answers a question
  before adding an answer.
- ⛔ **`LAPSED_MISS_LIMIT` is money-out.** Dropping a quiet INCOME series is a
  statement about the imports, not the job.
- ⛔ **Do not read money off a screenshot** — a cell I read as "−781" is −$701.04.
- ⛔ **Do not `tail` your own diagnostic and then conclude from it.** I "found"
  that rent was missing from the forecast; it was first in a list I had cut.
- ⚠️ **TWO DEFINITIONS OF SPENDING.** The headline **$167,828.49** is the
  expense-KIND signed sum; `periodTotals().spentCents` reads **$175,018.27**.
- ⚠️ **`user_category_id` is an OVERRIDE, not the membership.** Use
  `recurringSeriesIdsForCategory`.
- ⛔ **A repo move changes the ROOT and nothing else.**
- ⚠️ **`pnpm e2e:update <file>` does not work** — the flag takes a mode.
  `npx playwright test e2e/visual.spec.ts --update-snapshots -g "<name>"`.
- Push: `git -c credential.helper='!gh auth git-credential' push origin main`
