# Handoff — the second reader, fanned out: two hunts, a reviewer, and 59 fixes

> `main` clean and pushed. **4,877 unit** in ~23s · tsc clean · coverage gate
> exit 0 · `E2E_GATE=1` **600 passed (8.6m)** at `maxDiffPixels: 0` ·
> `pnpm ledger-check` exit 0.
> Ledger: **10,178 active rows · 37 uncategorized — UNCHANGED.**
> **Zero DB writes for five sessions** — no transaction row has been written
> since 2026-09-03T19:06:53Z.
>
> ⛔ **37 is two states.** `category_id IS NULL` returns **31**; the other six sit
> ON the system category named `Uncategorized`. Counting only NULL reports a
> ledger that moved when it did not.

---

# ⛔ 0. THE JOB — what is next

**§7 is a queue of 31 already-measured, adversarially-verified findings**, nine
of them HIGH. Every one carries the route it is visible on, the sentence it
prints today, the file:line responsible, and the measurement that shows it
wrong. Verify each against the app before fixing it — five of this session's
were refuted on re-measurement and two more were my own errors — then fix it,
with a test that fails against the old code.

After that, run the method in §1 again. It has produced 58 findings and then 47
findings on two consecutive passes over the same codebase, and the second pass
found things the first did not look for.

---

## 1. ⭐⭐ WHAT ACTUALLY WORKED — RUN THIS AGAIN

Three instruments, in this order. Each found what the others could not.

**(a) TWELVE LENSES OVER THE WHOLE APP → 58 findings, 53 survived.**
Twelve independent readers, `pipeline()` into three adversarial verifiers each,
every verifier told to **default to `refuted: true`**. 186 agents, 55 minutes.
The lenses: span collapsed into a container · denominator and population · two
texts on one element · a boolean testing a proxy · counts/plurals/zero states ·
date-window arithmetic · dialogs and destructive actions · surfaces no
screenshot opens · tense and modality · sums and identities · superlatives ·
direction and sign.

**(b) TEN *INVARIANT* LENSES → 47 findings, 37 survived, 10 refuted.**
151 agents, 62 minutes. Different question: not "is this sentence wrong" but
"does this INVARIANT hold, everywhere, mechanically". The ten: the drill-down
contract · do the rows sum to the header · the same quantity on two surfaces ·
percents that cannot be what they claim · empty states that assert · raw machine
values in prose · hardcoded numbers in copy · branches unreachable on this
ledger · a count and a sum over different populations · superlatives against the
sort underneath.

⭐ **These are the better lenses.** An invariant can be checked by a loop over
every page that carries the shape; a "does this read right" lens cannot. The
headline came from one: **351 ledger links, on every equity holding page, all
opening an empty ledger.** No eye finds that; a loop finds it in a minute.

**(c) A SECOND READER ON MY OWN COMMITS → 10 problems, 7 real.**
⭐⭐ **Do not skip this, and do not soften the brief.** Point it at the diff you
just made, tell it your own doctrine, and tell it you have a history of
introducing regressions. It found that my fix to `/categories/<Uncategorized>`
had left its PROOF measuring the other population — a measured zero asserted
directly under a non-zero headline, *created by the fix* — and that I had
reintroduced, two commits later, the exact percent defect I had fixed on the
transfer spine that morning.

⛔ **Put the app's own doctrine in every prompt** — the KNOWN-GOOD list, "write
the checker to the app's convention", "a rule with one caller". Generic
code-review prompts produce noise.

---

## 2. ⚖️ THE TWO DECISIONS YOU CLOSED

**A merchant's Total and rank say what it COST** (2026-09-10) — net of returns;
visit statistics stay gross. `Best Buy` #1 → #55 on a merchant that returned 94%
of what it charged. Recorded in `moneyapp-merchant-cost-not-charge`.

**`/categories/<Uncategorized>` shows the 37** (2026-09-11). It linked from
"Uncategorized · Locked · 37 txn" to a page that could never show a row:
`activeTxnsInRange` rewrites a system-category row to `categoryId: null`, so a
query ASKING for that id matched nothing. For November 2023 — a month holding
three of them — it printed the empty state that asserts a measured zero in so
many words. It reconciles now: **-$1,284.93 over 37 transactions**, and the
ledger it links to reads "All 37".

**The Sankey labels its frame** (2026-09-11). `/spending?period=2026-07` drew
Housing as **$2,763.79** while five other places on the same page read
**$2,653.58**. Both right — gross out $2,763.79, refunds $110.21, net $2,653.58
— and the chart draws the $113.11 that came back as its own inflow, so netting
would double-count it. The figure was right and the label was silent.

---

## 3. ⭐ THE HEADLINE: 351 DEAD DRILL-DOWNS

`holding-detail.ts` scoped its ledger links to the account the SHARES sit in.
Every position is in **Robinhood Brokerage**, which holds **zero transactions of
any status**; every trade row posts to **Robinhood Cash**.

    ?account=<brokerage>&q=AAPL      0 rows
    ?q=AAPL                        253 rows

Swept all nine equity pages: **351 links, 351 empty**, under a page saying "View
all 244 trades in the ledger". After: **313 + 38 links, none empty.**

⛔ And the sentence named a different population than the link opens — `q=AAPL`
finds dividends too (241 buys + 2 sells + 10 dividends = 253 against 244 holding
events). It counts the destination now.

⛔ **The fixture could not express the defect.** It put the trade row in the SAME
account as the holding, so the existing assertion blessed a link that opened
nothing. It models the real topology now.

**Three more of the same family, all fixed:**
- **Top merchants** published `merchant + window` while the figure was computed
  over SPENDING rows, and on a category page over that subtree only. **34 of 497
  rows disagreed with the list their own link opens.** "Zelle · 1 transaction ·
  $1,495.00" → 23 rows; now 1.
- **Dashboard notices** linked by CANONICAL NAME through `q=`, a literal LIKE
  over the bank's text. **268 of 851 merchants (31.5%) have a canonical name
  that appears in none of their own rows**; four of the six notices live that
  day were dead. They link by merchant id now: 8 links, 0 dead.
- **The ⌘K palette** hand-built `/transactions?category=${id}`, so its
  "Uncategorized" opened the six hand-filed rows out of 37.

---

## 4. ⭐ ONE FACT, SPELLED FIVE WAYS, ON ONE SCREEN

Rendered all 197 routes of the running app, ran each through `read-surface`'s
text extractor, and grepped the PROSE — not the markup — for machine values.
The dashboard named a single window two ways:

    runway         …6 complete months, 2026-03 to 2026-08.
    eating out     …6 complete months, 2026-03 to 2026-08.
    subscriptions  …6 complete months, 2026-03 to 2026-08, refunds netted off.
    fees           …the 6 complete months Mar 2026 to Aug 2026…
    transfers      left one account for another, Mar 2026 to Aug 2026

`/accounts/<id>` carried both formats in ONE paragraph, three DOM nodes apart:
"since Aug 12 +$211.71 **as of 2026-09-11** · derived". And `/accounts`' table
lens said the same clause a third way, with a weekday.

`monthWindowLabel` and `dayWindowLabel` are the two rules now, and the spelling
is the one the correct siblings already used.

⚠️ **NOT changed, deliberately:** date COLUMNS, `/imports`' "statements →
2026-08-25" badge, `importRowSubject`'s "(imported 2026-08-05)" disambiguator,
and the bank's own row text. `readableDay`'s docstring draws the line — "for a
sentence rather than a table cell" — and the verifiers refuted four findings
that crossed it.

---

## 5. WHAT NO GATE COULD SEE

**A `<div>` inside a `<p>`.** Found by reading the dev server's own log:

    [browser] In HTML, <div> cannot be a descendant of <p>.
    This will cause a hydration error.

`ProvenancePopover` mounts its panel as a SIBLING of the trigger, and the
transaction sheet's header put it in a `<p>`. The parser closes the `<p>` early,
so the browser's tree is not React's. It is in **no server-rendered HTML** (the
popover arrives with a lazily loaded panel) and **no screenshot opens that
dialog** — a scan of all 196 cached pages for this returns zero.

⭐ **Read `/tmp/moneyapp-dev.log`.** It is free, it is already there, and it is
the only instrument that found this.

---

## 6. ✅ CHECKED AND FOUND RIGHT — do not re-litigate these

Ten findings were REFUTED by their own verifiers, and two more were my errors.

- **The transfer rhythm rail has NO `<desc>`** and never had one in any revision
  of the file. §7 of the previous handoff said it did. My claim was simply false.
- **Raw ISO in a TABLE CELL is not a defect** — the balances Date column, the
  `/transactions` expanded row's date field, "Recent activity" lists (1,852
  cells), `/recurring/<id>`'s linked-transaction cells (288). Four findings, all
  refuted on the "sentence, not cell" line.
- **`/summary/<year>`'s "N of M rows"** excluding the gambling block is a scope
  convention, not a defect — gambling is deliberately outside every section.
- **`/transactions`' filter bar** has two props with zero callers, and what it
  renders instead is TRUE and test-pinned.
- **The terrain's "12 accounts"** names the SET the total covers, and that total
  leaves no dollar of the twelfth out.
- **A detected bill overdue in the Suggestions section** — nothing on the card
  is false, and nothing contradicts a sibling.
- **`/budgets` at exactly 100%** and the **subscriptions `toFixed(1)`** — both
  refuted on re-measurement.
- **`spineNodeLabel` citing a gross total in the Net lens** — `/flow?measure=net`
  shows BOTH stat cards, so the figure is on the page.
- **`typicalCents` being a fractional cent** is deliberate: it is a cap
  threshold, never rendered, and `expectedCents` has a rounded twin for callers
  that present it.
- **Plural/formatting sweep over 196 pages: clean.** Every hit was a `toText`
  artifact at an element boundary.

---

## 7. ❓ THE QUEUE — 31 VERIFIED FINDINGS

Each survived at least two of three adversarial verifiers; the vote is in
brackets. Nine HIGH, thirteen MEDIUM, nine LOW.

1. **[HIGH] (3/3)** /spending cash-flow card: "Earned $6.54 · Spent $103.33 · Net +$1,152.01" — three printed figures that cannot make each other, on 62 of 596 rows
   - route: `/spending?period=2026-03&cash=chart (hover Mar 31) and /spending?period=2026-03&cash=table (row "31"); same shape on /spending?period=2026-07&cash=table row "27`
   - file: `src/components/spending/CashFlowView.tsx:55-71 (the Earned/Spent/Net columns) and src/components/spending/CashFlowChart.tsx:203-213 (the same triple in the tool`

2. **[HIGH] (3/3)** /spending?cash=graph prints a SECOND, different Net for the same period — −$10,301.01 under the page's own −$10,187.90
   - route: `/spending?period=2026-07&cash=graph (and /spending?period=ALL&cash=graph)`
   - file: `src/components/spending/CashFlowGraph.tsx:64`

3. **[HIGH] (3/3)** /spending?period=2026-07&cash=table — the "Spent, June 2026" column prints another calendar day's spend beside each day number (row 20 shows June 19's $1,984.89; June 20 was $89.71)
   - route: `/spending?period=2026-07&cash=table  (and every month whose prior month has a different number of days)`
   - file: `src/components/spending/CashFlowView.tsx:75  (column `Spent, ${priorLabel}` rendering `r.ghostCents`; fed by src/services/spending.ts:379 -> src/lib/projection.`

4. **[HIGH] (3/3)** /investments/stock/WMT prints "Portfolio diversity 0.0%" over a held position worth $43.70 — the one holding page where the figure is a measured zero
   - route: `/investments/stock/WMT (live, fetched 2026-09-11)`
   - file: `src/components/investments/PositionCard.tsx:160`

5. **[HIGH] (3/3)** /recurring/<Car lease>: "there is no evidence behind it at all" and "the ledger's own average of what actually posted is -$559.89" in the same headline — and no row in the ledger has ever posted at that amount
   - route: `/recurring/019ff202-9d0b-7000-9d80-6c48210459b3 (Car lease); same clause also on /recurring/019f72f5-055f-7000-a3ef-2ac408a6044b (rent), /recurring/019f72da-1fb`
   - file: `src/services/provenance.ts:1001-1002 (the disagreement clause), contradicting src/services/provenance.ts:992`

6. **[HIGH] (2/3)** /merchants/<id>: the same date window is printed twice on one screen — raw ISO in the "Seen" tile and the "Spread across" sentence, formatted in the insight right beside them (703 of 851 pages)
   - route: `/merchants/019f4cb2-fd80-79ed-8b87-674cac56a203 (Ram's Village) — and 702 other /merchants/<id>`
   - file: `src/components/merchants/MerchantProfileCards.tsx:111 and :113; src/lib/merchant-profile.ts:251`

7. **[HIGH] (2/3)** /recurring "Show the math": 10 of 24 rows say "came due 2026-09-01" / "next 2026-09-11" while the tooltip on the same row says "since Jul 5, 2026" and the list below says "Sep 11"
   - route: `/recurring (and every ?tab= variant — the math table renders on all of them)`
   - file: `src/services/forecast.ts:308 and :376`

8. **[HIGH] (2/3)** / dashboard, "What you are riding on" card: the negative-remainder branch claims "the portfolio is worth more than everything you own put together" from a NET-of-debt subtraction — false whenever any non-portfolio asset exists
   - route: `/ (Concentration card, "What you are riding on", in the 13-card deck)`
   - file: `src/services/concentration-card.ts:410`

9. **[HIGH] (3/3)** /investments, Return view in % — "Best day +5.27% · Wed, Aug 19, 2026" names the biggest DOLLAR day, not the biggest percentage day (the real best is +9.99% on 2025-04-09)
   - route: `/investments?view=returns&unit=percent (the hero's "Return" view with the "%" unit selected; default ALL range)`
   - file: `src/lib/portfolio-returns.ts:214 (selection) + src/components/investments/ReturnViewParts.tsx:283 (render); mounted at src/components/investments/PortfolioChart`

10. **[MEDIUM] (2/3)** /spending?period=2026-07 — "tap a category to open its page" on Housing $2,653.58 lands on "Spent · September 2026 · $0.00 · 0 transactions"; all 12 category links drop the period
   - route: `/spending?period=2026-07 (Where it went, all three lenses) → /categories/019f4c7d-cc89-7efd-804b-575149208734`
   - file: `src/components/spending/SpendingCategoriesTable.tsx:106 (parent row) and :155 (child row); src/components/charts/CategoryMassif.tsx:206 and :617 for the Relief/`

11. **[MEDIUM] (2/3)** /categories/<Food>?period=2026-07 — the Subcategories card's "Dining $1,414.98" opens Dining's page showing "Spent · September 2026 · $0.00"; 34 such rows across 14 category pages
   - route: `/categories/019f4c7d-cc8a-7aea-8ab0-472727d1fca9?period=2026-07 → /categories/019f4c7d-cc8a-76a3-87e2-e1ad8fbce064`
   - file: `src/app/categories/[id]/page.tsx:301`

12. **[MEDIUM] (2/3)** /spending cash-flow table lens: Earned − Spent ≠ Net on 33 of 401 rows, because Net silently includes Refunds and there is no Refunds column
   - route: `/spending?period=2026&cash=table  (row "Jul"); also /spending?period=2026-03&cash=table row 31, /spending?period=2024&cash=table row "May", and 30 more`
   - file: `src/components/spending/CashFlowView.tsx:56-70 (Earned / Spent / Net columns; `refundsCents` is on the row but never rendered — src/services/spending.ts:120-123`

13. **[MEDIUM] (2/3)** Car insurance costs $4,337.88 "in a year" on /recurring and $1,807.45 over "the next 12 months" on the dashboard — the same series, the same window
   - route: `/recurring?tab=all (Annualized column) and /recurring/019ff202-9d0c-7000-96e8-d678b7d13783, against / (the Runway and The car cards)`
   - file: `src/services/recurring.ts:761 (`annualizedCentsOf` = |amount| × OCCURRENCES_PER_YEAR, no horizon term); the caveat that exists only on the detail page is src/co`

14. **[MEDIUM] (3/3)** /merchants/…63e7 "Where it lands" prints 100% + 0% for a two-category split — the 100% denies the $0.03 row sitting directly under it
   - route: `/merchants/019f4ccc-63e7-7ee2-8374-eb5f0a4da283 (Metropolitan Museum of Art), section "Where it lands"`
   - file: `src/components/merchants/MerchantProfileCards.tsx:162`

15. **[MEDIUM] (3/3)** /investments holdings subtotal renders the same allocation share at a different precision than the column it subtotals — "Share 0.0%" under a row whose own Alloc cell reads "<0.1%"
   - route: `/investments — Holdings table, select the WMT row's checkbox; the subtotal bar's "Share" stat`
   - file: `src/lib/holding-subtotal.ts:78`

16. **[MEDIUM] (2/3)** /spending prints "0.0%" as a share for a category that netted an INFLOW — "Shopping · 0.0% · −$1,605.11" — where the app's own accounts table refuses and names the reason
   - route: `/spending?period=2024-05 (and /spending?period=2025-02, Gambling row)`
   - file: `src/app/spending/page.tsx:213`

17. **[MEDIUM] (3/3)** /spending heatmap: 79 days labelled "no activity", and the day sheet says "Nothing posted on this day." over 298 real transactions
   - route: `/spending?period=2025-04 (Apr 11), /spending?period=2023-12 (Dec 4) — 79 days across the ledger`
   - file: `src/components/spending/SpendHeatmap.tsx:284 (day sheet) and src/components/spending/SpendHeatmap.tsx:91 (cell aria-label)`

18. **[MEDIUM] (2/3)** Dashboard Subscriptions card: "Flamingo South Beach (rent) last seen 2026-08-04" ×9, while the card beside it says "latest Sep 18, 2024 — 723 days ago" and /recurring's shared rule says "last seen 68d ago"
   - route: `/`
   - file: `src/components/dashboard/SubscriptionsCard.tsx:42 and :112`

19. **[MEDIUM] (3/3)** /transactions header: "Last Claude run: … · $0.03 · 2026-08-18 16:06" — an ISO timestamp sliced in half and shown as prose
   - route: `/transactions`
   - file: `src/components/transactions/HeaderStrip.tsx:165`

20. **[MEDIUM] (2/3)** /summary/<year>: "from $65,038.62 on 2025-12-31 to $109,204.16 on 2026-09-11" on a page that says "Jan 1 – Jul 31, 2026" three times
   - route: `/summary/2026 (and /summary/2025)`
   - file: `src/app/summary/[year]/page.tsx:255; src/lib/money-weighted-return.ts:69 and :75`

21. **[MEDIUM] (3/3)** /categories/[id] — the "12-month trend" card ignores the period selector and always draws the 12 months ending today, so on ?period=2023-11 it heads a November-2023 page with bars from Oct 2025 to Sep 2026
   - route: `/categories/019f4c7d-cc8a-7d27-892c-41dda63c8f8c?period=2023-11 (Food > Groceries); same on every one of the 80 category pages and every past period`
   - file: `src/app/categories/[id]/page.tsx:223 (heading) and :110 (today-anchored call); accessible name at src/components/spending/MonthlyTrendBars.tsx:55`

22. **[MEDIUM] (2/3)** /transactions transaction sheet — the History card's per-account rows put a gross row count beside a debits-only sum: "Venture X · 36" next to "$395.00", where 35 of those 36 rows are $26,921.32 of credits
   - route: `/transactions?q=CAPITAL+ONE+MOBILE → click the first row (opens the TransactionSheet) → the "History" card. Same shape on 12 of the 122 groups that render this `
   - file: `src/services/txn-detail.ts:238 (acc.count += 1 / acc.cents += out) — rendered at src/components/transactions/TransactionSheet.tsx:358 and :360`

23. **[MEDIUM] (2/3)** /summary/2026 — "92 of 149 rows behind this page" counts only the money-in lines; the page's largest figure, $56,576.24 of spending, rests on 1,394 further rows from 11 documents the sentence never counts or lists
   - route: `/summary/2026 (and /summary/2025, /summary/2024, /summary/2023, /summary/2022) — the "Where these figures come from" card at the foot of the page`
   - file: `src/lib/year-summary.ts:188 (provenance.rowCount, built only from the money-in lines by lineFor at src/services/year-summary.ts:83-136) — rendered at src/app/su`

24. **[MEDIUM] (3/3)** Holding pages, Return view in % — the same dollar-frame "Best day"/"Worst day" is wrong on 11 of 32 holdings, including ETH (his largest position): shown -10.50%, real worst -14.95%
   - route: `/investments/crypto/ETH?view=returns&unit=percent — and 10 more: /investments/stock/AAPL, /stock/MSFT, /etf/SPY, /stock/AMZN, /stock/META, /stock/GOOG, /stock/W`
   - file: `src/components/investments/HoldingChartPanel.tsx:470 (mount); root cause src/lib/portfolio-returns.ts:214 + src/components/investments/ReturnViewParts.tsx:283`

25. **[LOW] (2/3)** /spending?period=2026 — the Net card reads -$31,733.19 and its link opens 2,682 rows that sum to +$27,961.36
   - route: `/spending?period=2026 → /transactions?from=2026-01-01&to=2026-12-31`
   - file: `src/lib/spending-stat-cards.ts:83 (Net) and :119 (Savings rate)`

26. **[LOW] (2/3)** "Uncategorized · 35 transactions" on /spending against "37 transactions have no category yet" on the dashboard
   - route: `/spending?period=ALL (Honesty check) vs / (To review card) and /transactions?category=uncategorized`
   - file: `src/components/spending/HonestyBucketsCard.tsx:35 (label) with src/services/spending.ts:869 (`flow: "out"` in the href)`

27. **[LOW] (2/3)** Dashboard import-coverage note: headline says 94% while the four accounts it names add to 95%
   - route: `/ (dashboard) — "What changed" card, coverage note`
   - file: `src/services/movers-card.ts:498`

28. **[LOW] (3/3)** /categories/<Hotels>: "No activity in the last 12 months." over a 12-month window whose newest month has not been imported
   - route: `/categories/019f4c7d-cc8a-76a8-9939-040a0274129d (Hotels); also Water/Gas and Interest Charges`
   - file: `src/components/spending/MonthlyTrendBars.tsx:52`

29. **[LOW] (2/3)** /imports un-import confirmation: "Un-importing 20230810-statements-3522-.pdf (imported 2026-08-05) deletes every row it brought in" — a raw ISO inside a destructive-action dialog, 448 renders
   - route: `/imports`
   - file: `src/lib/import-file-label.ts:47, :53, :83`

30. **[LOW] (2/3)** /accounts/<id> subtitle: "Investment · brokerage · ····3525" — the raw lowercase DB enum next to the mapped "Investment"
   - route: `/accounts/019f4c7d-cc91-74b0-9349-1c012e2cfb50 and /accounts/019f4c7d-cc91-7eb1-a3bb-aee70ab6193e`
   - file: `src/app/accounts/[id]/page.tsx:240`

31. **[LOW] (3/3)** /summary/[year] — "Other income: Income-kind rows that fit none of the named sources above" is not a residual bucket; it is the category literally named "Other Income", and 7 income rows the page names nowhere are silently absent from "All money in"
   - route: `/summary/2023, /summary/2024, /summary/2025, /summary/2026`
   - file: `src/services/year-summary.ts:435 (the sentence) with :391 and :405 (the two hardcoded account names that create the gap)`

**ALSO STILL OPEN (from earlier passes):**
- ⚖️ **Dismiss posts immediately; End is behind a full blast-radius Confirm** —
  and Dismiss costs MORE on the calendar. The accessible names are fixed; the
  gate asymmetry is your call.
- **Five merchants have returns dated OUTSIDE their purchase span**, so the
  Total nets a refund the windowed share cannot see.
- **The rounded staleness tolerance can equal the day count that triggered it**
  ("49 days, past the 49-day tolerance"). Not reachable today.
- §7 of the 2026-09-10 handoff: the Honesty check's empty state,
  `Charged since May 2024`, six local `plural` copies, 227 shared `<title>`s.

---

## 8. NOTES THAT COST TIME, AND WOULD AGAIN

- ⛔ **`pnpm e2e:fresh`, not `pnpm exec playwright test`.** The suite has a
  staleness guard that refuses to run against a `.next` older than your edits —
  it caught me after 14 fixes. `e2e:fresh` is `next build && playwright test`.
  Once the build is current, `E2E_ALLOW_STALE=1` lets you re-run without
  rebuilding.
- ⛔ **The dev server must be STOPPED for the build**, and agents driving the
  app need it RUNNING. Sequence the two: hunt first, gate last.
- ⛔ **A large diff whose bbox starts at the changed sentence and runs to the
  page bottom is a REFLOW, not a second change.** `dashboard-grid-dark-320`'s
  bbox ran y2795–y10920 of an 11240px page for one longer month label.
- ⛔ **`zz-zz-txn-expander` has a documented race** — its own comment says it
  "fails ~3 runs in 4". It passed alone in 7.4s. Do not chase it.
- ⚠️ **Agents will take the Browser pane's tab.** Ten hunt agents were driving
  `localhost:3000` while I tried to verify a fix in the browser; the tab kept
  navigating away. Use the dev log, or a tab you create yourself, or wait.
- ⚠️ **`read-surface.mjs` reads only the FIRST RSC flush**, so a client-only
  chart (the Sankey, the transfer spine, the terrain) renders NOTHING to it.
  Verify those in the browser or by unit test.
- ⛔ **My own checkers were wrong four times.** "37 uncategorized" needs
  `NULL OR system-category` (the obvious SQL returns 31); a `<p>`-nesting
  scan over server HTML returns zero for a popover that mounts lazily; a
  regex for `/transactions?q=` misses links whose params start with `from=`;
  and a "prose vs cell" heuristic needs the verifiers to arbitrate.

---

## 9. WHAT WAS MEASURED, AND WHEN

Every figure here is **as of 2026-09-11** unless stated. The ledger did not move:
`max(updated_at)` over `transactions` is `2026-09-03T19:06:53.293Z`, and 0 rows
carry an `updated_at` after 2026-09-08.

Confirmed live on the rebuilt bundle after the fixes:

    /investments/stock/AAPL   "View all 253 AAPL rows in the ledger →"
                              → /transactions?q=AAPL → 253 transactions
    /categories/<Uncat>       "-$1,284.93 · 37 transactions" → "All 37"
    /spending?period=2026-05  "Zelle · 1 transaction · $1,495.00" → "All 1"
    /flow?shape=spine         "Chase Checking, net source -$136,433.19 — sent
                              $172,517.92, received $36,084.73; 41.5% of the
                              $415,945.05 that moved between these 8 accounts
                              left from here"
    /                         "…6 complete months, Mar 2026 to Aug 2026." ×5
    /accounts/<id>            "since Aug 12 +$211.71 as of Sep 11, 2026 · derived"

- ✅ **The dev server is RUNNING on :3000.** Stop it yourself if you need
  `.next`; that is standing permission.

---

# 📋 THE PROMPT FOR THE NEXT SESSION

> Read `docs/HANDOFF-2026-09-11-the-second-reader-fanned-out.md` first — it is
> the brief. §0 is the job and §7 is the queue.
> Repo `/Users/rayankarimcheca/dev/MoneyApp`, `main` clean and pushed. Baseline:
> 4,877 unit · tsc clean · `E2E_GATE=1` 600 passed (8.6m) at `maxDiffPixels: 0` ·
> `pnpm ledger-check` exit 0. Ledger: 10,178 active rows · 37 uncategorized.
> Zero DB writes for five sessions.
>
> No decision is waiting on me. The job is the same as the last twelve sessions:
> find what is wrong. Do not invent features.
>
> 1. ⭐⭐ **§7 is 31 already-measured, adversarially-verified findings**, nine of
>    them HIGH, each with its route, its sentence, its file:line and the
>    measurement. Verify before fixing — five of last session's were refuted on
>    re-measurement — then fix, with a test that fails against the old code.
> 2. ⭐⭐ **Start an INVARIANT hunt in the first five minutes** (§1b). Ten lenses,
>    three adversarial verifiers each, every verifier told to default to
>    refuted. Invariants beat impressions: a loop over every page that carries
>    the shape makes assertions no eye can.
> 3. ⭐⭐ **Put a SECOND READER on your own diff before you finish.** Mine found
>    seven real problems in my own commits, two of which I had created that
>    morning while fixing something else.
> 4. ⭐ **Read the dev server's log.** It found an invalid-HTML hydration error
>    no gate, no screenshot and no server-rendered HTML could have.
> 5. ⛔ **`pnpm e2e:fresh`** — the plain gate refuses a stale `.next`. Stop the
>    dev server first; the build needs it.
> 6. When a figure is right and a sentence about it is wrong, the SENTENCE is
>    the defect — but VERIFY first: §6 is twelve things that looked wrong and
>    were not, and four of my own checkers were wrong before the app was.
> 7. If you find a decision, put it to me EARLY with the measurement.
> 8. HOSTING goes last. Never propose a hosted-DB migration.
