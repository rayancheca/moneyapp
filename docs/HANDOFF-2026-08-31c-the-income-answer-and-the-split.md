# Handoff — the income question, answered; and the split that hid behind its own error

> **Supersedes `HANDOFF-2026-08-31b-forecast-and-calendar.md`.**
>
> **`main` = `cda9429`**, tree clean, pushed. tsc clean · **4,278 unit** ·
> **E2E_GATE=1: 585 passed at `maxDiffPixels: 0`** (8.3m, green on the first
> confirming run) · `pnpm ledger-check` exit 0, on every commit.
>
> Repo: **`/Users/rayankarimcheca/dev/MoneyApp`**.
> Ledger: 10,111 active rows · income $117,924.62 · spending $167,828.49 ·
> net worth unchanged.

---

# ⛔ 0. THE JOB — what is next

1. **Pass 75 onward** — `docs/program-passes-60-94.md`. **HOSTING LAST.**
2. The standing open list in §5. Nothing on it is urgent; the queue you set on
   2026-08-31 is empty.
3. ⚠️ If you upload a **Capital One 360** statement or a Chase statement covering
   **2026-08-13 → 09-10**, re-read §1 — the $3,000 from Argo North Venture lands
   with it.

---

## 1. ✅ THE INCOME QUESTION IS CLOSED, and it was never a data gap

The last three handoffs called this "the biggest thing". It is answered, and the
answer required no code and no recategorisation: **the ledger was already right.**

The brief asked which of three things was true — missing from the imports, in an
unimported account, or cash that never reaches a statement. Measured:

| hypothesis | verdict |
|---|---|
| deposits missing from the imports | **essentially false** — one row, §1.3 |
| landing in an unimported account | **false** — §1.2 |
| arriving as cash that never reaches a statement | **true**, and he confirmed it |

### 1.1 What the ledger actually says

`Cash job (weekly pay)` has exactly **two** matched rows in its life:

    2026-06-04   $1,047.00   ATM CASH DEPOSIT 474 W 41ST ST MIAMI BEACH FL
    2026-06-05     $400.00   ATM CASH DEPOSIT 3700 W FLAGLER ST CORAL GABLES FL

Since then, Chase Checking is imported continuously to **2026-08-12** (its newest
statement), and the Rocket Money export independently covers **08-13 → 08-24**.
That is **80 consecutive covered days** on the very account those two deposits
landed in, containing **zero** wage-shaped deposits.

The only large cash in that window is the 2026-07-21 ATM deposit of **$6,600 +
$300**, and it carries his own note from 2026-08-25: *"Cash from mum — she gave
$7,000."* Correctly filed `Gifts received`.

**He answered directly this session: "Still working, spending the cash."** So the
series stays. The money is real; it simply never touches a bank.

### 1.2 The unimported account is not the answer

`Capital One 360 Checking` exists in the topology with **zero rows** (created
2026-08-25). It looked like the obvious suspect, and the Rocket Money export
settles it: that account has **two transactions**, `$1,047.00 out` and `$0.02
interest`. Not where pay lands.

⭐ **How that got proved: a Zelle reference prefix identifies the SENDING bank.**
`0PE0…` is SoFi, `Jpm99C…` is Chase, `COF…`/`Cof…` is Capital One. The proof is a
matched pair — 2026-05-13 SoFi Checking `−$615.13 "Zelle® Payment to Rayan"` and
Chase `+$615.13 "…0PE0UBM17XOO"`, same day, same cent. That is worth remembering:
it is the cheapest way to identify a counterparty account the ledger cannot see.

### 1.3 What he actually lives on — and ⛔ do NOT reclassify it

| when | what | filed as |
|---|---|---|
| 2026-07-21 | $6,900 cash from his mother | `Gifts received` |
| 2026-07-29 | $2,022.92 (Rezaul Karim Kha) + $2,000.00 (Monira Hossain) → Wells Fargo | `Gifts received` |
| 2026-08-11/12 | $5,000 from **Arno Search Capital, LLC** | `Pass-through` |
| 2026-08-24 | $3,000 from **Argo North Venture Partners** | not yet imported |

I asked whether the two LLCs were earnings. **They are his father's money, routed
through a friend** — his words. `Pass-through` is already correct, and it matches
the December 2025 **$11,700 wire OUT** to Arno and the Standard Chartered CHIPS
credits from Rezaul. Leave them alone.

The one genuinely unseen inflow is the **$3,000 from Argo North Venture on
2026-08-24**, missing only because Chase's next statement does not exist yet.
Ordinary statement cadence, not a defect.

### 1.4 So the fix was DISCLOSURE, not deletion

September projects **$4,233.69** of income, of which **$4,188.00 — 98.9% — is one
series that has not deposited since 2026-06-05.** The card said none of that. It
does now: see §2.

---

## 2. ✅ The forecast card says what its numbers are MADE OF

The card published one spending figure. For September that figure is
**$11,030.77**, read against an expectation of "3-5k". He was right about his
bills; the card just never separated them.

    MONEY IN   ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░   all of it running late
               Scheduled $4,188.00 (1 line) · Recent pace $45.69 (2 lines)
    MONEY OUT  ▓▓▓▓▓▓░░░░░░░░░░░░░░░   $1,402.60 of it running late
               Committed $3,567.60 (9 lines) · Recent pace $7,463.17 (15 lines)

Both halves were always in `f.components`, which has carried a `kind` of
`"fixed" | "variable"` since it was written. `lib/forecast-split.ts` partitions
that array by **sign first, kind second** — which is exactly how
`services/forecast` derives the totals it publishes — so

    income.totalCents   === projectedIncomeCents
    spending.totalCents === projectedSpendCents

hold by arithmetic, not by luck, with no rounding anywhere.

**A band, not two more tiles.** Seven tiles is a wall, and the split is the
working rather than a seventh headline. Putting money in and money out on one
picture is also the only way the asymmetry shows: spending is 30.3% committed,
income is 98.9% one stale series.

⛔ `fixedShare` is **null**, not zero, for an empty side — "nothing is projected"
and "none of what is projected is committed" are different claims. And the
magnitudes in that division are load-bearing: the RUNNING month reaches
`0 / −26_444`, which is `-0`, and renders as "-0%" the moment anything formats it
as a percentage.

---

## 3. ✅ A trend may move the projection by at most one typical month

`Travel` projected **$2,234.86** for September off a 3-month average of
$1,018.29. The nudge — `(newest − oldest) / 2` — was $1,216.57, so it **more than
doubled** the average. It read that slope off July, which holds $2,448.88 of
which **$2,374.89 is two flight bookings**; the rest of the category is $2-$17
Miami Beach parking. Over 23 months Travel's median month is about $131.

### ⛔ Only the UPWARD nudge is capped, and I got that wrong first

A symmetric cap scored BEST on the backtest and I took it — then an existing test
went red and was right to. A window of `[$600, $0, $0]` has a median of **$0**, so
a symmetric cap is a cap of zero: it deletes the −$300 slope and republishes the
$200 mean forever. **A habit you quit, still costing you money** — the dead
landlord arriving through the arithmetic instead of through `seriesHasLapsed`.
The downward direction already has a bound (`Math.max(0, …)`).

Chosen by backtest, 36 months × 19 root buckets, scored on the monthly TOTAL:

| rule | MAE total | MAE/cat | over | under | dead category |
|---|---:|---:|---:|---:|---:|
| ± median (symmetric) | $1,194 | $2,707 | $512 | $682 | ⛔ $200 |
| **up-only median** ← shipped | $1,239 | $2,630 | $427 | $812 | ✅ $0 |
| no trend at all | $1,290 | $2,623 | $547 | $743 | ⛔ $200 |
| raw trend (the old rule) | $1,372 | $2,918 | $675 | $697 | ✅ $0 |

10% better on the published figure, 37% less over-prediction, stable across
halves ($1,196 / $1,282 against $1,377 / $1,368). **An aggregate score does not
buy the right to tell someone a cancelled habit still costs $200 a month.**

⛔ And it does not live in `forecast.ts`. `projection.ts`'s own header names
"Engine B forecast.ts `variableComponents`" as a formula it was written to
absorb — yet `variableComponents` still computed the nudge inline, so the
recurring card and `/spending` could project one category two ways.
`trailingPace` is now the single home.

**It binds on exactly two categories:** Travel $2,234.86 → **$1,608.53**,
Entertainment $329.85 → $221.61. September variable spend $8,197.74 →
**$7,463.17**; total $11,765.34 → **$11,030.77**; net −$7,531.65 → **−$6,797.08**.
`/budgets` and `/spending` are unchanged — all four budgeted categories have
slopes under their medians.

⚠️ If Travel still reads high, the lever is the CENTRE, not the cap: median3
gives $1,180.48, at the cost of under-predicting the total by ~$1,175/month.

---

## 4. ✅ The COKE split — and ⛔ TWO defects that CANCELLED

`rebuildInvestmentHistory` values a position as cumulative-sum(holding_events) ×
the cached close, and the two halves disagreed about when Coca-Cola
Consolidated's 10-for-1 happened.

- the QUANTITY is as-traded — the split is stored as a delta, `2025-05-27 COKE
  +9.013095`, so the count is ~1.0 before and ~10.0 after;
- the PRICE is split-ADJUSTED all the way back, and the cache proves it rather
  than assuming it: COKE closes **$114.36 on 2025-05-23 and $112.93 on
  2025-05-27** — continuous across a 10-for-1.

So every day before the split multiplied one pre-split share by a tenth of what
it cost. **60 trading days**, COKE contributing $3,835.95 where the truth is
$38,359.50 — $575.39 a day on average, peaking at **$1,021.71**.

### ⛔ The second defect, and why fixing one alone would have been worse

`flowsByDay` valued the same delta at the split-day close and called it money
going IN: a phantom **$1,017.85 contribution** on a day nothing was bought
($2,127.74 reported against $1,109.89 of real trades).

Because `return = ΔNAV − flow`, the fake step in the level and the fake flow very
nearly **annihilate** — which is why this survived so long, and why **fixing
either one alone would have created a defect**, turning a cancelled pair into a
$1,017.85 loss on a day the market did nothing.

Four call sites had it, so there is a loader rather than four fixes:
`services/holding-timeline.ts`. Migration 0015 adds `event_kind` (default
`trade`), `lib/split-adjust.ts` restates the timeline in today's shares, and the
ratio is **derived, never stored** — `Q → Q + delta` fixes it at `(Q + delta) / Q`
and a stored copy would be two numbers that must agree about one event.

### ⭐ `ledger-check` was the independent witness — it failed to say the fix worked

Immediately after the write, `pnpm ledger-check` went red with three
`fixed-value-drift` findings: **2025-02-28 (−$91.21), 2025-03-31 (−$445.12),
2025-04-30 (−$667.86)** were "recorded as a known disagreement but now agree".

Those numbers come from **Robinhood's own month-end statements**, which the fix
never consulted — it was built from the price cache and the event timeline alone.
Two of the three are the exact corrections the rehearsal printed. The baseline's
own comment had already diagnosed the cause and said it was *"worth its own pass,
not a line in a baseline"*. It is now removed, and the comment records that this
check witnessed the fix rather than authored it.

**A baseline of known disagreements is the cheapest oracle you have: it fails
when you get something RIGHT.**

---

## 5. Still open

- **Cash-earnings and the composition band both tell the income story now**, but
  `/spending`'s cash-earnings note and `/recurring`'s band are separate surfaces.
  Not a defect — worth knowing before adding a third.
- **`Parking` renewal price** — he wrote "268.86" once against "368.86".
- **`Breezeline (internet)` provider name** — the screenshot's logo is not
  Breezeline's; amount and cadence match, so the series was corrected not
  replaced.
- **The archive folder drift** — `migrateStorageLayout` would re-derive it.
- **Eight crypto price marks** in `ledger-check`'s baseline (down from a
  brokerage six to a brokerage three — see §4).
- Discover missing five statements · 45 `WEIXIN*` rows · HBO Max renewing ·
  4 unpaired transfer legs.
- **`Capital One 360 Checking` is still empty** and now known to be nearly so in
  reality — 2 transactions. Importing it is low value.

---

## 6. Notes that keep costing time

- ⛔ **Check whether a second wrong number is HIDING the first.** §4. A cancelling
  pair is invisible in the derived figure and only shows in the levels.
- ⛔ **An aggregate score does not buy a wrong behaviour.** §3 — the symmetric cap
  won the backtest and was still wrong.
- ⛔ **A Zelle reference prefix names the sending bank.** §1.2.
- ⛔ **`.next` staleness is guarded** — `pnpm e2e` refuses to run against a stale
  bundle and tells you to use `pnpm e2e:fresh`. Trust it; it saved a whole run
  that would have passed against code I had not built.
- ⚠️ **`sqlite3 "file:…?mode=ro"` fails right after a write** with "unable to open
  database file (14)": a WAL database with no `-shm` cannot be opened read-only.
  Open it normally to read.
- ⚠️ **TWO DEFINITIONS OF SPENDING.** The headline **$167,828.49** is the
  expense-KIND signed sum; `periodTotals().spentCents` reads **$175,018.27**.
- ⚠️ **`user_category_id` is an OVERRIDE, not the membership.** Use
  `recurringSeriesIdsForCategory`.
- ⚠️ **10,111 active rows, 9 of them uncategorised** — a `JOIN categories` count
  reads 10,102 and that is not a discrepancy.
- Push: `git -c credential.helper='!gh auth git-credential' push origin main`
