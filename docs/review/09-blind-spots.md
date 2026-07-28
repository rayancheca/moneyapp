# 09 — Blind spots: what the other 28 agents missed

**Role:** completeness critic. Everything below was found by running the app against the
**owner's real 9,753-transaction database** and by executing its own service functions
against that data — not by reading code alone. Every number is measured. Every claim
carries a `file:line`.

## How this pass was run (so you can reproduce it)

```
sqlite3 ~/Desktop/Dev/MoneyApp/data/moneyapp.db ".backup /tmp/…/live.db"   # safe copy, never written
MONEYAPP_DB_PATH=/tmp/…/live.db MONEYAPP_BACKUPS_DIR=/tmp/…/backups npx next dev -p 3117
PROBE_DB=/tmp/…/live.db npx tsx probe*.ts     # calls the real services directly
```

Real DB: 9,753 transactions, 2022-08-25 → 2026-07-14, 9 accounts, 27 recurring series,
73 categories, 88 import files. Demo DB (`data/moneyapp.db` in this worktree, and
`data/e2e.db` which every e2e test runs against): 1,673 transactions.
**Several defects below are invisible on the demo DB by construction.** That is the point.

---

# PART 1 — Cross-surface number disagreements

This is the class the brief called highest-value and it is the class that fell between
every agent's assignment. Six confirmed. All measured on real data.

## B1 — CRITICAL: 330 of the 627 "Top merchants" rows open an **empty ledger**. $34,403.46 unreachable.

`topMerchants` groups merchant-less rows by `strippedDescriptionKey()` and then builds the
drill-down link as a **full-text search for the stripped key**:

```ts
// src/services/spending.ts:685-687
href: g.kind === "merchant"
  ? ledgerHref({ merchant: g.id!, … })
  : ledgerHref({ q: g.query!, … })          // g.query = humanizeDescriptionKey(strippedKey)
```

But the ledger's `q` is a literal `LIKE '%…%'` against `raw_description` /
`normalized_description` (`src/services/transactions-query.ts:114-121`). The stripped key is a
**transformed** string — `strippedDescriptionKey` removes dates, amounts, CUSIPs and long digit
runs and trims edge punctuation off every token (`src/lib/description-key.ts:79-98`). It is a
literal substring of the description **only when stripping happened to be a no-op**.

Worked example, straight from the DB:

| | value |
|---|---|
| `raw_description` | `Card Purchase 01/25 Love & Peace Convenienc Bronx NY Card 7782` |
| `normalized_description` | `CARD PURCHASE 01/25 LOVE & PEACE CONVENIENC BRONX NY CARD 7782` |
| link generated | `?q=CARD+PURCHASE+LOVE+PEACE+CONVENIENC+BRONX+NY+CARD+7782` |
| rows matched | **0** |

The date `01/25` and the `&` token are gone from the key but present in both stored columns.
This is the **standard Chase card descriptor**, so it hits essentially every Chase row without a
merchant link — and 5,155 of 9,688 active rows have `merchant_id IS NULL`.

**Measured across the whole ledger (probe3):**

```
UNLINKED MERCHANT GROUPS (all history): ok=297   DEAD=330 (52.6%)   dead total = $34,403.46
  DEAD  n=40    $480.22  "CARD PURCHASE LOVE PEACE CONVENIENC BRONX NY CARD 7782"
  DEAD  n=13    $833.63  "RECURRING CARD PURCHASE SIMPLEMOBILE*SERVICES 877-878-7908 FL CARD 7782"
  DEAD  n=7   $1,435.00  "ATM WITHDRAWAL 4780 3RD AVE BRONX NY CARD 7782"
  DEAD  n=3   $8,410.00  "CARD PURCHASE FORDHAM U ENR SVCS 718 NY CARD 7782"
  DEAD  n=1   $1,814.72  "RESIDENT DREAMCLOUD RESIDENTHOME"
```

The same builder feeds the `TopMerchantsCard` on **`/spending` and on every
`/categories/[id]`** (`src/app/categories/[id]/page.tsx:87`). His single largest merchant-less
payee — 40 transactions — is a dead link on both.

**Why no agent and no test caught it:** on `data/e2e.db` the same probe returns
`ok=5 DEAD=0`. The demo descriptors are clean, so the entire 243-test e2e suite is
structurally incapable of seeing this.

**Fix (one line, low risk):** stop searching for a derived string. Either (a) give the ledger a
first-class `descriptionKey` filter that recomputes `strippedDescriptionKey` server-side — the
review inbox already does exactly this for its `similar` clusters
(`src/services/review-inbox.ts:25-27`) — or (b) link with `q` set to the **longest literal
token run** of the key. (a) is correct; (b) is the 20-minute version.

## B2 — CRITICAL: `/investments` header Realized P/L is **$1,076.71 more** than the table under it.

| surface | value | source |
|---|---|---|
| Portfolio header: "Realized P/L **+$3,018.13** ≈ 88 sells" | `overview.realizedPlCents` | `src/components/investments/PortfolioStats.tsx:109` |
| Holdings table, Realized column, summed over its 9 rows | **+$1,941.42 / 43 sells** | `src/components/investments/PortfolioHoldingsTable.tsx:56-68` |
| **gap** | **$1,076.71 · 45 sells** | |

`portfolioRealizedPl` walks **every** `(account, assetType, symbol)` leg in `holding_events`
(`src/services/portfolio.ts:462-466`), including fully-closed positions. `holdingRows` returns
only legs with a **live quantity** (`src/services/portfolio.ts:556`). So more than half his
realized sells belong to **24 closed positions that have no row anywhere in the app**:

```
USAR +$504.22 (3)   GLD -$207.11 (5)   MRVL +$133.02   TSM -$99.36   NOW +$75.34
UUUU +$68.23   ADBE -$56.29   PYPL -$34.70   SLV -$30.13   GD -$16.32   … 24 legs, 45 sells
```

And they are not reachable by guessing either — **`/investments/stock/GLD` returns 404**
(verified live). `price_cache` still holds full daily history for 25 such symbols
(VEU, UBER, KO, NVDA, CVX, PM, BRK.B, GOOG, …), so the data to render them exists.

**Fix:** `holdingRows` should emit zero-quantity legs that have realized activity (flagged
`closed`), and `holdingDetail` should resolve a symbol with `quantityE8 = 0`. Additive, matches
"dont delete anything", and turns the header number back into a sum of visible rows.

## B3 — Two different "projected spending" for the same month, $635.48 apart, one click from each other.

| page | number | engine |
|---|---|---|
| `/` and `/spending` | "**$6,584.31 projected**" | linear pace: `$5,734.72 × 31/27` (`src/services/spending.ts`, `projectPace`) |
| `/recurring` "Forecast · July 2026" | "Projected spending **−$1,485.07**" (remaining) → **$7,219.79** total | 3-mo trailing avg + trend (`src/services/forecast.ts:157+`) |

Both are labelled "projected". Neither says which basis it uses in a way the other can be
compared against, and no surface reconciles them. The dashboard links to *both*.
`5,734.72 + 1,485.07 = 7,219.79` vs `6,584.31` — **Δ $635.48 (9.7%)**.

**Fix:** pick one engine for the headline "projected month spend" and label the other
explicitly as "remaining fixed + variable". `/recurring`'s "Show the math" table is the better
one — it is already fully inspectable — so promote it and have `/spending`'s pace chart draw
*that* projection as its target line.

## B4 — One page, one series, two "next expected" dates — and one of them is in the past.

On `/recurring` (verified in the live HTML):

* Forecast card: `Cash job (weekly pay) · Fixed (series) · 1 × $1,046.00 (weekly), **next 2026-07-30**`
* "All" tab, Inactive table, same series: `Next **Jul 23**` ← four days *before* today (2026-07-27)

Cause: `listSeries` renders the **stored** `nextExpectedOn` verbatim
(`effectiveSeries`, `src/services/recurring.ts:642-651` → `src/services/recurring.ts:576`),
while `forecastCurrentMonth` rolls it forward past `today` via `projectOccurrences`
(`src/services/forecast.ts:126-152`). Nothing ever writes the rolled value back.

**Three series currently display a past date as "Next"** (probe12):

```
Cash job (weekly pay)  next=2026-07-23  status=confirmed  active=false
UBER *ONE              next=2025-06-25  status=detected   active=false   ← 13 months stale
Rocket Money           next=2026-06-19  status=detected   active=false
```

`UBER *ONE` is simultaneously sitting in the **"Suggestions · 3 to review"** card at
**100% confidence** asking him to *Confirm* it. The same `nextExpectedOn` column feeds
`/categories/[id]`'s series list (`src/services/category-detail.ts:146`), so the stale date
propagates.

**Fix:** `listSeries` should call `projectOccurrences(toProjectable(s), today, …)[0]` for its
displayed next date, exactly like the forecast does. One line, and it makes the two halves of
`/recurring` agree.

## B5 — Two irreconcilable answers to "how much have I put into investments?"

| surface | number |
|---|---|
| `/investments`: "Net contributed **+$81,722.99** · in $145,310.02 · out $63,587.03" | NAV-flow walk |
| the ledger's own `Investment Contribution` category | **−$20,176.60** (in $117,004.50, out $137,181.10) |

**$101,899.59 apart.** Both are defensible (the portfolio walk counts security purchases inside
the brokerage; the category counts bank→broker cash moves), but nothing on either page says so,
and there is no link between them. This is the single most confusing pair of numbers in the app
for anyone who looks at both.

## B6 — Smaller but real, all confirmed in the live render

* **`/investments`: "Month P/L +$7,300.67" sits above "Total return +$7,245.59 all time."**
  July's gain exceeds the entire history's gain. Arithmetically possible; presented with no
  explanation, twelve inches apart.
* **The same page shows "Realized by sells −$765.31 · 2 sells" (July calendar) and
  "Realized P/L +$3,018.13 ≈ 88 sells" (header)** — opposite signs, no scope label on either.
* **A credit card's balance renders positive on its row and negative in its group header, on
  the same card.** `/accounts` shows `Capital One −$11,020.45` as the institution total and
  `Venture X · ····4208 **$11,020.45**` as the row, because `SubCard` negates liabilities to
  render a magnitude (`src/components/accounts/InstitutionCard.tsx:72`) while the header sums
  signed. Same on the dashboard.
* **The nine accounts appear in two different orders on two pages.** `/accounts` orders by
  `institutions.name, displayOrder, name` (`src/services/accounts.ts:80`); the `/transactions`
  account filter orders by `displayOrder, name` with no institution join
  (`src/app/transactions/page.tsx:81`), producing
  `Chase Sapphire, Discover, Robinhood Brokerage, SoFi Checking, SoFi Savings, Venture X,
  Chase Checking, …`.

---

# PART 2 — The $93,004.29 blind spot: half the ledger has no surface at all

This is the biggest structural finding of the audit and no agent owned it, because it is not on
any page — it is what is *missing* from every page.

**The app's two number systems disagree by $116,514.75 over the ledger's life and never mention it:**

```
cash-flow, all time (periodTotals)   earned $122,594.64   spent $159,414.90   net −$31,656.41
net worth, same window                $0.00 (2022-08-24) → $84,858.34 (2026-07-19)   +$84,858.34
```

The app says "you are $31,656 in the hole" and "you gained $84,858" and offers **no surface,
chart, table or drill-down that connects the two.** 100% of that gap lives in the four category
kinds analytics deliberately excludes (`src/services/analytics.ts:16-18`) — and **nothing else
in the app totals them either**:

| category | kind | rows | money in | money out | **net** |
|---|---|---:|---:|---:|---:|
| Buys | investment | 1,901 | $38,129.27 | $145,612.19 | −$107,482.92 |
| Sells | investment | 87 | $94,415.92 | $3,610.77 | +$90,805.15 |
| **Gifts received** | transfer | 35 | **$46,928.00** | **$0.00** | **+$46,928.00** |
| Internal Transfer | transfer | 990 | $268,949.18 | $222,142.81 | +$46,806.37 |
| **Family pass-through** | transfer | 23 | $115,661.66 | $84,698.22 | **+$30,963.44** |
| Investment Contribution | transfer | 292 | $117,004.50 | $137,181.10 | −$20,176.60 |
| Reimbursements | transfer | 719 | $16,485.72 | $14,528.50 | +$1,957.22 |
| Transfers / Loans / Rewards / Credit Card Payment / system | | 540 | | | +$3,203.63 |
| **TOTAL** | | **4,587 rows (47% of the ledger)** | | | **+$93,004.29** |

Three of these are not transfers in any meaningful sense:

1. **`Gifts received` — $46,928.00 in, $0.00 out, 35 rows, all hand-categorized (`source='user'`).**
   A category with a six-month-plus inflow and literally zero outflow is not a move between his
   own accounts. Because its parent is `Transfers` (kind=`transfer`), it is excluded from income
   everywhere. The app reports his all-time income as $122,594.64; $46,928 of money that
   arrived and stayed is in no total on any screen.
2. **`Internal Transfer` nets +$46,806.37 — which is impossible for internal transfers.** Split
   by pairing state, the story is exact:
   * **740 rows with a `transfer_group_id`: net $0.00.** The detector is sound.
   * **250 rows with no pair: $63,602.33 in / $16,795.96 out.** These are single legs whose
     counterparty is not in the ledger, hand-labelled "Internal Transfer" and thereby removed
     from income. No surface reports the imbalance.
3. **`Family pass-through` — see B7 below.**

**The gap is a missing concept, not a bug.** Today a row has exactly two destinations: *income*
(counts) or *transfer* (vanishes). There is no third state for "money that arrived, isn't
earnings, and isn't a move between my own accounts". 4,587 rows are in that third state.

**What to build (additive, and this is the highest-value ADD in the whole audit):**

* A **"Money in, not income"** section on `/spending` — gifts, reimbursements, loans, unpaired
  transfers — with its own total and drill-down. It answers "where did the other $93k go?"
* A **transfer-integrity report**: per transfer category, `paired net` vs `unpaired net` and the
  250 orphan legs, listed and clickable. The doctrine says single-sided hints only *flag* —
  but nothing renders the flags.
* The **net-worth waterfall** already on the ADD list, wired to *these* buckets:
  `visible net (−$31,656) + excluded net (+$93,004) + market value change + anchors = Δ net worth`.

## B7 — The hero net-worth chart's all-time high is $30,000 of his father's money, and the app already knows it isn't his.

Largest single-day net-worth moves in the entire 1,426-point series (probe8/probe9):

```
2026-05-06  +$29,904.00   coverage 9→9   inTransit $0.00   complete=true
2026-05-07  −$26,509.58
2026-03-04  −$22,466.43
2025-12-11  +$19,226.06
2026-03-03  +$18,463.02
```

**Every one of the top eight is a `Family pass-through` row.** On 2026-05-06 a $29,800 CHIPS
wire lands in Chase Checking and on 2026-05-07 $25,000 leaves as an international wire — both
hand-categorized `Family pass-through`, both correctly excluded from income and spending. The
chart shows net worth touching **$116,015.17** that day. That is his all-time peak and the
hero's peak marker will label it.

The in-flight bridge cannot help: this is not an internal transfer, so there is no
`transfer_group_id` to bridge. Measured, the bridge corrects **200 of 1,426 days** and its
corrections are $8.70, $47.17, $100.00 — it never touches a five-figure move.

**So the "this isn't my money" law is enforced in exactly one of the two number systems.**
Analytics honours `Family pass-through`; the balance/net-worth layer has never heard of it.

**Fix (additive):** give the net-worth series the same vocabulary — a `passThroughCents` band
on `BridgedNetWorthPoint` alongside the existing `inTransitCents`
(`src/services/dashboard.ts:37-40` already establishes the pattern), drawn as a hatched
sub-band with the hero saying "$30,963 of this is pass-through". Zero deletion, one new field.

---

# PART 3 — Failures that only exist when the app is running on real data

## B8 — 87% of the net-worth chart is a partial sum, and only the last point's honesty flag is read.

```
points 1426 (2022-08-24 → 2026-07-19)     incomplete days: 1238  (87%)
coverage histogram (accounts covered → days):
   1 → 402 days      2 → 26      4 → 293      5 → 173      6 → 17      7 → 254      8 → 73      9 → 188
```

For the first **402 days** the line is drawn from **one account of nine**. `netWorthSummary`
reads `complete` only off `series.at(-1)` (`src/services/dashboard.ts:133`), which today is
`true`, so the hero reports full coverage while 87% of the curve behind it is a different
number of accounts than the point beside it. Only **188 of 1,426 days** are what the axis label
implies.

**Fix:** the series already carries `coveredAccounts/totalAccounts/missingAccounts` per point.
Render coverage as a ribbon under the chart (grey where <9, solid where 9), and label the
scrub tooltip "4 of 9 accounts". Nothing to delete; the data is already in the payload.

## B9 — The portfolio's "as of" is a **Sunday**, its equity day-change column is all zeros, and the price cache contains a fabricated close.

```
AAPL  2026-07-17  333.739990234375  yahoo
AAPL  2026-07-19  333.74            yahoo     ← Sunday. No 07-18 row at all.
ETH   2026-07-18  1861.54 / 07-19   1871.25   coinbase   ← crypto really does trade weekends
```

`refreshPrices` writes "today's quote becomes today's close" (`src/services/prices.ts:378-391`),
so running it on a weekend stamps Friday's price with **Sunday's date and `source='yahoo'`** —
indistinguishable from a real quote. Consequence in the live render: `Day %` reads **+0.00% for
8 of the 9 holdings**, while the header proudly announces "**Today +$141.95 +0.16%**" — a number
that is 100% ETH (27,355.93 × 0.52% ≈ $142).

The whole app's "today" is 2026-07-19; the actual today is 2026-07-27. Eight days and a market
closure, unlabelled.

**Fix:** stamp carried/synthetic closes with a distinct `source` (`'carry'`), don't write a
close for a day the provider didn't trade, and have the day-change column render "—  market
closed" rather than "+0.00%".

## B10 — `/transactions` ships **4.65 MB of HTML** for 50 rows. 95% of it is invisible.

Measured live against the real DB:

```
/transactions            4,647,518 bytes   role="option" ×3,650   role="listbox" ×50
/transactions?view=review  240,974 bytes   (0 rows)
```

⇒ **88 KB of HTML per visible ledger row.** Each row renders a closed category picker
containing all **73** categories. Other agents said "95% invisible markup"; nobody put a number
on it, and the number is what makes it a P0 for a phone. `/` is 1.40 MB for the same reason —
it server-renders **all five dashboard view-modes' chart payloads** (Net worth / Assets / Owed /
Split / Accounts / Flow) when one is visible.

**Fix:** render the listbox on open (one shared portal instance keyed by row id). This is the
single biggest mobile win available and it deletes nothing users can see.

## B11 — Four statements imported **zero transactions** and the page reports "Open gaps 0".

```
88 import files · all status='parsed' · 4 produced 0 transactions
```

`/imports` renders them identically to successful ones — "Parsed", `Txns 0`, an `un-import`
link — under a header that promises *"Every statement must reconcile: beginning + transactions
= ending, to the cent, or it is flagged with its exact gap"* and a stat card reading
**"Open gaps 0"**. A statement that parsed to nothing is the most likely real failure mode of a
PDF pipeline, and it is the one state the page cannot express.

**Fix:** `Txns 0` is a failure, not a status. Badge it, exclude it from "Reconciled periods",
and let "Open gaps" count it.

## B12 — An out-of-range page shows the *filter* empty state and a live pager.

`GET /transactions?page=99999` (live, 200 OK) renders:

> **No matching transactions** — Nothing matches the current filters. Adjust them or reset to
> see everything.
> Page **99999 of 194** · 9688 transactions   [Previous] [Next]

The filters match 9,688 rows. The copy blames the filters, the pager prints an impossible
ordinal as fact, and `Previous` walks back one page at a time from 99,999.

**Fix:** clamp `page` to `[1, pageCount]` in `parseFilters` (`src/components/transactions/query.ts:58`)
— it already validates every other param.

---

# PART 4 — Fell between two agents (nobody owned these)

## B13 — The app prints a privacy promise on all 15 routes that is **false**.

```tsx
// src/components/shell/AppShell.tsx:46
Local-first · your data never leaves this Mac
```

Rendered in the persistent chrome of every page. Meanwhile:

| destination | what leaves | code |
|---|---|---|
| `api.anthropic.com` | normalized merchant descriptions, batched | `src/services/claude-categorize.ts:164` |
| Yahoo Finance | every holding symbol | `src/services/prices.ts:74` |
| `api.exchange.coinbase.com` | crypto symbols | `src/services/prices.ts:127,135` |

And the descriptions are not anonymous. `normalizeDescription` only strips 5+-digit runs
(`src/lib/normalize.ts:29`), so what is actually sent includes strings like
`CARD PURCHASE LOVE PEACE CONVENIENC BRONX NY CARD 7782` — **his card's last four and the street
address of his ATM**. `/transactions` currently offers "Classify **11** merchants with Claude".

Another agent noted "third parties' names leave the machine with no disclosure". The sharper
fact is that the app makes the opposite claim, in the header, permanently. Before hosting this
with auth, that line is a liability.

**Fix:** change the line to "Local-first · your statements stay on this Mac", and put a
one-time disclosure + a preview of the exact strings on the "Run categorization" button.

## B14 — Root cause of the owner's open "the Claude button stopped working" bug.

`.gitignore:12` ignores `.env*` (keeping only `.env.example`). Therefore:

```
~/Desktop/Dev/MoneyApp/.env                                       exists (188 B, Jul 10)
~/…/.claude/worktrees/app-polish-adversarial-review-e80abb/.env    DOES NOT EXIST
```

**Every dev server started from a git worktree has no `ANTHROPIC_API_KEY`.** With no key,
`classifyPendingMerchants` returns `{ ran: false }` immediately
(`src/services/claude-categorize.ts:131-135`) and the action redirects with a `no-api-key`
notice (`src/app/transactions/actions.ts:155-156`). The key itself is fine. This matches the
owner's memory note ("Claude button likely fails on an expired key") — it is neither expired
nor deleted; it is *absent from the worktree*.

Compounding it: `/settings` says "**No ANTHROPIC_API_KEY** — the app fully works" while
`/transactions`, on the same boot, renders "Run categorization · Classify 11 merchants with
Claude ≈ $0.01 est." with no hint. Two pages, one environment variable, no shared truth.

**Fix:** `git config --local` a symlink or copy `.env` into worktrees; and gate the
`/transactions` HeaderStrip button on the same `Boolean(process.env.ANTHROPIC_API_KEY)` that
`src/app/settings/page.tsx:34` already computes.

## B15 — The backups directory is **80 files / 505 MB** under a UI that promises 20.

`/settings` states: *"Backups keep 14 daily + 6 monthly snapshots."* Reality in
`~/Desktop/Dev/MoneyApp/data/backups`:

```
80 files · 505 MB
   15  daily-* / monthly-*          ← the only files retention governs
   65  pre-rh-cash-*, pre-sofi-replace-*, pre-stage3-backfill-*, pre-stage4a-*,
       and orphaned .db-wal / .db-shm siblings   ← grow forever, never listed, never pruned
```

Retention only prunes what it names. The ad-hoc `pre-*` snapshots (written by the guarded
real-DB write scripts) and every `-wal`/`-shm` sibling accumulate indefinitely, and the Settings
list filters them out — so the page describes 15 files while the directory holds 80 and half a
gigabyte. A first boot on a new day writes 2 × 12.8 MB.

**Fix:** list everything the directory contains with size and a total, and say which files
retention governs. (Restore is already on the register; this is about honesty of the list.)

## B16 — `/design/stage-0a` is a live route serving **his real net worth**, and it is the only page the keyboard test suite covers.

`GET /design/stage-0a` → **200, 341 KB**, titled *"Stage-0a design preview — real ledger rows,
new identity system. Sign-off gates the app-wide sweep,"* rendering **"This month $5,734.72"**
and **"Net worth $84,858.34"**. No env gate, no `noindex`, not in the nav, ships in the build.

Worse — and this is the answer to "the gap between what the 243 e2e tests assert and what a
human would notice", written by the test suite itself:

```ts
// e2e/keyboard.spec.ts:9
 * and Esc precedence — against the /design/stage-0a preview, the only surface …
// e2e/keyboard.spec.ts:18
const PREVIEW = "/design/stage-0a";
```

**The keyboard-grammar gate runs against a page users cannot reach.** That is precisely why the
a11y agent found the real routes lacking while the gate stayed green. `e2e/a11y.spec.ts:23`
scans it too, inflating the "all routes pass axe" claim by one route that is not a route.

**Fix:** either promote the preview's grammar to the real surfaces and point the spec at
`/transactions`, or gate the route behind `process.env.NODE_ENV !== "production"`. Do not
delete it — but it must not be the thing the gate proves.

## B17 — "Spending owed before your next paycheck" is structurally $0.00 for a weekly earner.

Live dashboard, real data: `beforePaycheck: $0.00 before 2026-07-30`.

`upcomingBills` finds the next income occurrence and sums the *bills dated on or before it*
(`src/services/dashboard.ts:151-161`). With a **weekly** income series the window is ≤7 days, so
the answer is $0.00 nearly always — the rent that matters ($2,285.70) falls on Aug 8, after the
next three paychecks. The widget is designed for a biweekly/monthly earner and silently degrades
to a constant for this user.

It is worse than useless here because the paycheck it anchors on is the **dead** `Cash job`
series (see B4): `/recurring` files it under **"Inactive 1"**, its calendar shows
**"Upcoming +$0.00"** for July, and the dashboard still projects **4 occurrences totalling
+$4,184** in the next 30 days. Measured (probe12):

```
Upcoming(30d): 10 occurrences, net +$1,818.11
   of which from INACTIVE series: 6 occurrences, +$4,173.01
```

**Fix:** window on `max(next paycheck, +14 days)` and label it "bills due before Aug 10"; and
apply `isSeriesActive` at both `upcomingOccurrences` and `fixedComponents` call sites (already
on the register as V1 — this is the real-data proof of how bad it is).

## B18 — "Free to spend ≈ −$4,538.72"

The dashboard's most decision-relevant number renders as a negative "free to spend"
(live HTML; `src/services/dashboard.ts:196-200`). "Free to spend" has no negative branch in
copy or colour. It should read **"Over by $4,538.72"** with the negative tone, and probably
should say what it is over *against*.

---

# PART 5 — Corrections: two register findings are **not true** on this database

I am the completeness critic; the register is also incomplete in the other direction.

* **"Transfers … spending is silently inflated in one direction."** Measured: all **1,166**
  rows carrying a `transfer_group_id` are also in a `transfer`-kind category. **Zero** rows are
  paired-but-spending-categorised, and **zero** are paired-but-uncategorised. The
  double-counting direction does not exist here. Only the *hiding* direction is real, and its
  size is Part 2 (1,403 transfer-category rows with no pair).
* **"The review queue … re-inflates after every import; the one journey with a finish line
  cannot be finished."** Measured: `needsReviewCount = 0`, `reviewInbox.totalCount = 0`,
  `clusterCount = 0`. He finished it. The dashboard correctly renders *"Nothing to review —
  every transaction is categorized and confirmed."* The *empty* state of the review queue is
  therefore the state he will live in — and it currently gets one sentence and no next action,
  which is the finding that should replace the old one.
* **"The `source='user'` shield has two holes."** Whatever is true of the AI paths, the
  **rules** path is clean and should not be "fixed": `retroApplyRule` filters with
  `{ excludeUserSet: true }` (`src/services/rule-corrections.ts:209`) and `previewRuleMatches`
  uses the identical predicate (`src/services/rules-manager.ts:138`), so the blast-radius badge
  and the write agree and neither can touch a hand-categorized row. Given that 35 of his
  `Gifts received` rows and 434 hand-categorized merchants carry `source='user'`, this shield is
  load-bearing — verify before touching it.

---

# PART 6 — Shallowest route, and what a deeper pass finds

**`/settings` got the thinnest audit** (one agent, bundled with rules). One live look at it on
real data produced two defects nobody listed — B14 (it contradicts `/transactions` about whether
the API key exists) and B15 (retention copy vs 80 files / 505 MB) — plus this, verified in the
live HTML:

The Rules card shows a **disabled** rule reading *"When a transaction is money in and matches
`/ATM|CASH DEPOSIT/` and is at least $200, categorize it as Income › Salary and set its merchant
to Employer (cash) · applied 3 × · disabled · [Enable]"*. That is the exact rule that produced
the $52,625 phantom-income error the owner spent a whole pass unwinding, sitting one click from
being live, with no note saying why it was turned off. `listRules` deliberately zeroes
`matchCount` for disabled rules (`src/services/rules-manager.ts:159-160`), so re-enabling it
shows a blast radius of nothing until the next import runs it. A disabled rule needs a reason
field and the Enable button needs to state what it will do on the next import.

**Second-thinnest: `/imports`** — B11 is the whole finding, and it is a *data-loss-shaped* one.

---

# PART 7 — Adds that are missing from the 130-item ADD list

Ranked by value to this owner, on this data.

1. **"Money in, not income" surface + transfer-integrity report.** $93,004.29 / 4,587 rows have
   no page. Nothing else on the ADD list covers it. (Part 2)
2. **A pass-through band on the net-worth chart.** His all-time high is his father's wire. (B7)
3. **Closed positions.** A `/investments` "Closed" tab and a `holdingDetail` that resolves
   `quantity = 0`, so the header's 88 sells are all reachable and `GET /investments/stock/GLD`
   stops 404-ing. (B2)
4. **A coverage ribbon under every balance chart**, driven by the `coveredAccounts` the series
   already carries. 87% of the hero curve needs it. (B8)
5. **"Markets were closed" state** for price-derived numbers, and a real `source='carry'` for
   synthetic closes. (B9)
6. **A `descriptionKey` filter on `/transactions`** — fixes B1 properly, and unlocks
   "every transaction shaped like this one" as a first-class, shareable URL for the 5,155
   merchant-less rows.
7. **One reconciliation page**: `Δ net worth = visible net + excluded net + market Δ + anchors`.
   It is the only thing that would make the app's two headline numbers stop contradicting
   each other, and it is three sums.

---

# Appendix — every measurement in one block

```
DB: 9,753 txns (9,688 active, 65 excluded) · 2022-08-25→2026-07-14 · 9 accounts · 73 categories
    27 recurring series (4 confirmed, 3 detected, 9 dismissed, 11 ended) · 88 import files

net worth (hero)              $84,858.34   asOf 2026-07-19  (assets 97,311.03 + liabilities −12,452.69) ✓
portfolio value               $88,968.58   = Σ holdingRows = allocationSlices total ✓
cash-flow all-time            earned $122,594.64 · spent $159,414.90 · net −$31,656.41
excluded kinds all-time       +$93,004.29 across 4,587 rows
Gifts received                +$46,928.00 in / $0.00 out / 35 rows / source='user'
Internal Transfer paired      740 rows, net $0.00        unpaired 250 rows, net +$46,806.37
Family pass-through           in $115,661.66 / out $84,698.22 / net +$30,963.44 / 23 rows
July 2026                     spent $5,734.72 · earned $150.00 · uncategorized $0.00 · excluded 1
projections for July          /spending $6,584.31   vs   /recurring $7,219.79   (Δ $635.48)
realized P/L                  header $3,018.13 / 88 sells   table $1,941.42 / 43   ghost $1,076.71 / 45 / 24 legs
unlinked merchant groups      627 total · 330 dead links · $34,403.46
net-worth series              1,426 points · 1,238 incomplete (87%) · bridge corrects 200 days
biggest daily jumps           top 8 are all Family pass-through
/transactions HTML            4,647,518 bytes · 3,650 role="option" · 50 listboxes · 73 categories
import files with 0 txns      4 of 88, all status='parsed', page reports "Open gaps 0"
backups                       80 files / 505 MB vs UI copy "14 daily + 6 monthly"
demo DB (what e2e runs on)    unlinked groups 5 · dead links 0 · pass-through rows 0
```

Categories reconcile exactly: for all 10 top-level expense categories in July,
`categoryBreakdown` (the `/spending` table) == `categorySpending` (the `/categories/[id]`
headline) == the row count the drill-down href actually returns. That contract holds. The
failures above are all *outside* it.
