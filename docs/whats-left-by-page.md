# What's left — by page

> Built 2026-08-21 by walking all 17 routes, the master backlog
> (`docs/future-ideas.md`), and the last three handoffs, then **measuring every
> claim against the live database and the source**. Where the backlog and the
> code disagree, the code wins and the disagreement is written down in §1.
>
> Sizes: **XS** under an hour · **S** half a pass · **M** one pass · **L** multi-pass.

---

## 0. State, measured today

Ran this session: `npx tsc --noEmit` → **exit 0** · `pnpm ledger-check` → **exit 0**.
Not re-run (inherited from pass 59): 3,050 unit tests, 428 e2e.

| | |
|---|---|
| accounts | 10 |
| active transactions | 10,072 |
| uncategorized | **0** |
| `needs_review` | **59** |
| statement periods | 219 |
| import files | 294 |
| categories | 77 |
| merchants | 893 |
| budgets | 11 |
| recurring series | 29 (6 confirmed · 3 detected · 9 dismissed · 11 ended) |
| holdings | 34 |
| transaction splits | **0** — the feature exists and has never been used on real data |
| duplicate candidates | 71, **all** `confirmed_duplicate` → the nav badge is clear |

`ledger-check` passes but prints two accepted, un-evidenced chains:

- **Chase Sapphire $9,680.91** — 36 active rows with `import_file_id IS NULL`, all
  card payments 2025-02 → 2026-07. 71 more of the same are `superseded`.
- **Cash on Hand −$5,000.00** — one row, 2026-08-11, the car down payment.

Both are inside the recorded baseline, so they are known and allowed — but they
are the only money in the ledger that no document proves.

**Statement freshness** (today = 2026-08-21):

| account | last period | last transaction |
|---|---|---|
| Robinhood Brokerage | **none — 0 periods** | — |
| Robinhood Crypto | 2026-06-30 | 2026-06-23 |
| Robinhood Cash | 2026-07-31 | 2026-08-03 |
| SoFi Checking / Savings | 2026-07-31 | 2026-05-31 |
| Chase Sapphire | 2026-08-02 | 2026-07-30 |
| Discover | 2026-08-09 | 2026-08-07 |
| Chase Checking | 2026-08-12 | 2026-08-12 |
| Venture X | 2026-08-14 | 2026-08-14 |

Normal cadence, not a defect. The uploads that would actually buy something:
**Robinhood July + August** (two months behind, and it is the account with no
arbiter) and **SoFi August**.

---

## 1. Six places the backlog is now wrong

Written before the per-page list because they change what "left to do" means.

1. **Robinhood Brokerage has 8 `live` anchors, not 6.** Two more landed
   2026-08-17 and 2026-08-18, after pass 59 measured. The queue text is stale by
   two days of readings.

2. **The `live`-anchor schema violation is exactly one row.** Handoff §4 flags
   the RH Cash anchor at 2026-07-10 as violating *"'live' is only ever written
   for today"* and implies a soft rule. Measured: that row's `created_at` is
   **2026-07-11T23:34Z** — written for a day that was already yesterday, so it
   genuinely violates. The other 16 `live` anchors (8 Brokerage, 8 Crypto) each
   have `created_at` on their own `anchored_on` date. They are compliant. The
   rule is intact everywhere except that one hand-entered row.

3. **P0.5 in-transit bridging is shipped, not open.** The backlog checkbox at
   `future-ideas.md:748` is `[ ]`. The code is `src/lib/in-flight.ts`,
   `src/services/in-flight.ts`, `src/lib/multi-series-bridge.ts`, and the
   dashboard hero renders *"includes $X in transit"* at `src/app/page.tsx:216`.
   Sub-items (b), (c) and (d) are all built. Tick it.

4. **The "Linkable / Movable" checkboxes (`future-ideas.md:1222–1231`) are
   stale.** All four link items and two of four move items shipped in S5/S6/S7 —
   as *affordances*, not drags. What is genuinely left is only the drag gestures,
   which S7 deferred on purpose and which a11y requires a keyboard twin for
   anyway. Rewrite those six lines rather than leaving them reading as unbuilt.

5. **Parity-roadmap item 1 — "focus mode everywhere, the clean next slice" — is
   mostly done.** `ChartFocus` is wired into the dashboard net-worth chart,
   `BalanceChartPanel`, `PortfolioChartPanel`, `HoldingChartPanel` and
   `SeriesDetail`. The real remaining list is smaller and different; it is written
   per-page below.

6. **`InfoTip` reaches 2 of 11 pages** (`/budgets`, `/categories`) and
   `SectionNotes` reaches 3 (`/budgets`, `/categories`, `/investments`, plus
   `AccountHoldingsTable`). The backlog treats explanation as done because two
   passes shipped it; it is a per-surface feature that stopped after two surfaces.

---

## 2. Dashboard — `/`

- **Focus/expand every card, not just the chart** (P2.3). `ChartFocus` exists and
  works; there is no `FocusableCard` generalisation. Activity hub, accounts, and
  recent sections are still fixed-size. **M**
- **"+2 more" is a dead end** (P2.1). `formatNameList` truncates at 2 with
  `+N more` and nothing expands it — on the hero, the chart header, and the
  scrub tooltip. He asked for this on 2026-07-14 and it is still true. **S**
- **Name the cause of a coverage gap** (P2.2). The tooltip now splits "hadn't
  opened yet" from "real hole" (pass 40) but never says *which statement is
  missing*. Derivable from the `statement_periods` hole. **M**
- **Drag-reorder the institution cards.** Arrange mode reorders *sections*;
  account order lives on `/accounts` as up/down buttons. Deferred in S7 for a
  stated reason (two surfaces owning one order) — either build it or delete the
  backlog line. **S**
- **`NumberRoll` only on the hero headline.** S10b wants it on StatCards and
  account balances. **XS**
- **Period-panel `aria-live` fires on every brush** — possibly chatty, never
  measured with a screen reader. **XS**

## 3. Accounts — `/accounts` and `/accounts/[id]`

- **Robinhood Brokerage has no arbiter — the top queue item.** 8 `live` hand
  readings, 0 statement periods; its daily values come from `services/holdings.ts`,
  not from anchors. Emit a second `ParsedStatement` from the brokerage profile
  carrying an investment `period` anchored on **`Total Securities`** (first
  occurrence only — the second account section #655929651 repeats the label, and
  `Total Market Value` is the stock-lending subtotal), then extend `ledger-check`
  to fail when printed and holdings-derived diverge past a cent. Across 24
  statements: 16 exact, 2 within a cent, 6 that disagree (worst −$667.86 on
  2025-04-30, −$197.62 on the latest). `data/probe-brokerage-value.ts` already
  measures it. **M**
- **The one `live` anchor written for yesterday** (RH Cash 2026-07-10). Either
  reclassify it `manual` — which is what a hand reading of a past day *is* — or
  drop the schema note's claim. Right now the note is false by one row. **XS**
- **Balance-history % on a near-zero baseline** reads `+14636.2%` when three
  months ago the derived balance was ~$7. Suppress or soft-cap below a threshold,
  the same honesty move already made for the net-worth partial %. **XS**
- **The investment account-detail chart stops at the last cached price day.**
  `carryForwardTo` fixed `/investments`; `accountSeries` → `buildPortfolio` was
  never extended. Noted as a follow-up in pass 13 and never done. **S**
- **No focus mode on `AccountHoldingsTable`**, and no chart⇄table lens on it.
  **XS**
- **Archived accounts** are a disclosure with no explanation of what archiving
  costs. No `InfoTip` anywhere on this page. **XS**

## 4. Imports — `/imports`

- **`daysSinceVerified` has no UI consumer anywhere in `src`.** Measured in
  pass 58, still true. Either render it or delete the field. **XS**
- **A "data health" surface.** P2.2 suggests it: every coverage gap listed with
  the exact statement to fetch, plus which accounts are behind. Today the page
  tells you what *was* imported, never what is *missing*. Given that the answer
  is currently "Robinhood July + August, SoFi August", this is a screen that
  would actually change his behaviour. **M**
- **`CoveragePanel` prints `verifiedThrough` only in `case "verified"`** — a
  `broken` or `unverified` account gets the gap message instead and loses the
  "closed through X" fact it does have. Pass 58 explicitly recommended rendering
  "closed through X, first hole Y" as the version worth building. **S**
- **No `InfoTip`, no `SectionNotes`** on the app's most jargon-dense page
  (reconciled / unverified / gap / quarantined / superseded all appear here).
  **S**

## 5. Transactions — `/transactions`

- **P1.1 — cluster cards cannot make partial decisions.** This is the oldest
  unbuilt user ask in the file (2026-07-14, verbatim: *"I can't even expand to
  see the data… what if I want to confirm specific ones and not others"*).
  `confirmClusterAction` is all-or-nothing; there is no `confirmSelectedAction`.
  Needs: expand to the full member list (virtualised past ~50), per-row
  checkboxes, within-cluster filter/sort, and a header showing sum + count + date
  span so "Confirm all" is informed. `ReviewInbox.tsx` is 263 lines and the
  plumbing (bulk-edit undo) already exists. **M**
- **59 rows sit at `needs_review`** — the categoriser's own low-confidence flags.
  None affects income or net worth. They need a human pass, not code. **S** (his
  time, not mine)
- **0 splits in 10,072 transactions.** The split feature shipped in pass 22–23,
  is fully tested, and has never been used. Either surface it where it would be
  used (a prompt on large mixed-merchant charges — the Costco/Target case) or
  accept it as dormant and stop maintaining its surface area. **S**
- **Drag a transaction between categories** (kanban). Deferred twice, with a good
  reason both times: the inline chip picker already does it. Probably delete.
- **No `InfoTip`** explaining `quarantined` vs `excluded` vs `superseded` — three
  statuses with very different money semantics, on a tab bar, unexplained.
  Given that `excluded` silently moving money in the replay chain is exactly what
  hid the fabricated plug, this one has a track record. **S**

## 6. Spending — `/spending`

- **No focus mode on any of its charts** — `CashFlowView`, `SpendHeatmap`,
  `CategoryMassif`, the Sankey. It is the page with the most charts and the least
  focus support. **S**
- **Chart-type switcher not unified** (parity roadmap item 4). Stacked, donut,
  heatmap and Sankey exist as *separate cards*; the ask was one view registry so
  the cash-flow card flips between line / bars / donut / Sankey / heatmap / table
  from a single switcher. **M**
- **No `SectionNotes`.** The insight layer that says *"this page noticed…"* runs
  on `/budgets`, `/categories` and `/investments` but not on the page about
  spending. **S**

## 7. Categories — `/categories` and `/categories/[id]`

- **`MonthlyTrendBars` is bare** — CSS bars with a drill link, no axes, no range,
  no scrub, no table lens, no focus. Parity roadmap item 5. **S**
- **Category merge** was deferred in S7 with a real reason: budgets, rules JSON,
  merchant defaults and suggestions all reference a category id, so a merge needs
  its own guarded data pass. Still the right call, still unbuilt. **M**
- **Re-parent by drag** — the Move menu covers it; the drag is sugar. **XS**
- Detail page has no `InfoTip` despite `/categories` (the list) having them.

## 8. Flow — `/flow`

- **No focus mode** on `TransferFlowPanel` — and this page carries five distinct
  views (Tower, Matrix, Rhythm, Spine, Sankey), the richest visual surface in the
  app, all locked to inline size. Highest value-per-hour focus wiring left. **S**
- **No table lens** on any of the five views. **S**
- **No `SectionNotes`** — a transfers page that noticed *"$X round-tripped
  between SoFi and Robinhood in July"* would be earning its place.

## 9. Budgets — `/budgets`

The best-explained page in the app (pass 47/49 shipped the tooltips and the
verdict work). What is left is small:

- **`budgetOverdue`** exists; there is no view of *which* bill is overdue from
  the budget row — it names a count, not the rows.
- **Rollover is opt-in and per-budget** — no way to see, across all 12 budgets,
  which ones roll and what the accumulated balance is. Nine of the twelve now
  roll (pass 61); the aggregate view is still missing.
- 12 budgets cover Housing, Food, Shopping, Cash & ATM, Transport, Health,
  Subscriptions, Entertainment, Travel, Fees, Car and Utilities, totalling
  **$4,506.29** — sized from income rather than from trailing spend (pass 61).
  **No Income-side budget** — there is no target-earnings counterpart, which for
  a cash-paid job is arguably the number that matters most.
- The header grades against an **annualised** income rate as of 2026-08-24, so it
  reads `$30.71 left to allocate` in all twelve months of the year rather than
  swinging between over- and under-allocated. See the closed decisions at the top
  of [`program-passes-60-94.md`](program-passes-60-94.md).

## 10. Recurring — `/recurring` and `/recurring/[id]`

- **S11–S14: multi-episode recurring.** The whole track is unbuilt — measured:
  no `recurring_episodes` table, no migration, nothing in the schema. This is the
  largest single unbuilt feature in the app, and the user asked for it in his own
  words on 2026-07-13 (StephanCodes, Netflix). Four sub-items:
  - **S11** table + migration + episode-aware `isSeriesActive`/projection. **M**
  - **S12** auto-split by gap analysis in `services/recurring.ts`. **M**
  - **S13** calendar + list episode-aware day-state grammar; fixes the wrong
    "Next expected" on the 11 series already marked `ended`. **M**
  - **S14** per-episode editor on the detail page. **M**
  - Plus the **attach-from-a-transaction flow** the user described: click a txn →
    "Recurring…" → preview every match → confirm to attach *and categorise them
    all* in one gesture.
- **`ForecastCard` has no hierarchy** — measured: a 5-column `<dl>`, every value
  `text-lg font-medium`. Projected income, spend, net, EOM cash and EOM net worth
  all shout equally. Third pass carrying this item. **S**
- **No week-level total on the calendar.** Blocked on a real decision: an 8th
  column breaks the 7-day arrow-key math under `role="grid"`. Options are a
  separate aside, or `aria-colcount` surgery. **S**
- **`paid_different` has no rendered coverage** — no baseline, no text assertion,
  because no seeded posting lands outside its tolerance band. A state the UI can
  reach that no test has ever seen. **XS**
- **`AmountHistoryChart`** — no scrub, no range, no table (parity item 5). **S**

## 11. Investments — `/investments` and `/investments/[type]/[symbol]`

- **The brokerage arbiter** (see §3 — it is an accounts-side fix that this page
  is the consumer of).
- **No focus mode on `AllocationDonut` or `PnlCalendar`.** The donut got
  hover-highlight in pass 23 but never expansion. **S**
- **No table lens on the donut** — the "show me the numbers" escape hatch that
  every other chart got. **XS**
- **`TopMovers`, `PortfolioStats`, `RealizedSalesList`** — no focus, no lens.
- Benchmarks: `BenchmarkPicker` exists; only SPY is wired as a comparison in the
  shipped copy.

## 12. Settings — `/settings`

Four sections: Thresholds (AI cap, price staleness, review-deposit floor, Claude
confidence minimum), Rules, AI spend, Backups.

- **No data export.** Everything lives in one gitignored SQLite file. A
  "download everything as CSV/JSON" button is the cheapest disaster insurance in
  the app and does not exist. **S**
- **No import/restore counterpart** to `BackupsManager` beyond what it does.
- **No theme setting** beyond the toggle in the shell.
- **The `ANTHROPIC_API_KEY` lives in `.env` only** — there is no in-app place to
  see whether a key is present, which is why `classifyPendingMerchants` can
  return `{ran:false}` silently. A one-line "AI: key detected / not detected" in
  the AI spend card would have saved a debugging session. **XS**

## 13. Merchants — `/merchants/[id]`

Measured: 91 lines. Name, this-year total, default-category rule, a recent list,
a back link. Thinnest real page in the app.

- **No chart of any kind** — no spend-over-time, no year-over-year.
- **No cadence** — the recurring engine knows if this merchant is a series;
  the merchant page does not say so.
- **No first-seen / last-seen**, no average ticket, no category mix.
- **No "you spend $X/month here"** — the number a merchant page exists to give.
- Not reachable from the nav; only via a transaction. **S–M**

## 14. App-wide

- **Hosting + auth — the gated finale.** `docs/deploy-plan-gcp-firebase-auth.md`
  exists; the work is `requireSession()` on 103 server actions. Owner's standing
  order: the whole queue first. Do not propose a hosted-DB migration. **M**
- **iOS** — after hosting. **L**
- **S10b micro-interactions** — categorize checkmark-draw, confetti on clearing a
  cluster, spring hover on chips, `NumberRoll` in more surfaces. **S**
- **§7 app-wide motion** — route transitions via the View Transitions API beyond
  the current `template.tsx` fade-rise. **M**
- **`ScrubChart` From/To picking a <2-point window** un-zooms the chart while the
  context keeps the 1-day window — chart and panel disagree. Only reachable via
  the date inputs. **XS**
- **`InfoTip` and `SectionNotes` should reach every page** or be declared
  finished at two. Right now the app explains itself on `/budgets` and
  `/categories` and goes quiet everywhere else. **M**
- **`/design/stage-0a`** is a design-preview route gated out of production
  (`NODE_ENV === "production" && MONEYAPP_PREVIEW !== "1"`), kept alive because
  `e2e/keyboard.spec.ts` is the only surface that exercises the keyboard/Esc
  precedence grammar. Fine as-is — but it means that grammar is tested on a page
  no user sees, not on the real ones.

---

## 15. Data work that is his, not the code's

- **The $560.54 on 2026-07-29** — self-to-self, routing 021000021, received
  10:13:20, same day as the $1,320 Robinhood withdrawal and the −$1,300 card
  payment. Nine other rows on that rail are Internal Transfer / Investment
  Contribution. Which account did it leave?
- **Dad's remaining ~$5k** via Arno Search Capital LLC. Pass-through, not
  income. Expect it; do not let it be classified as earnings.
- **59 `needs_review` rows** — one sitting.
- **Upload Robinhood July + August, SoFi August.**

---
---

# Part 2 — what else could be done

Everything above is *the queue*: work someone already wrote down. This half is
the argument for what is **not** on the list.

## 16. The strategic read

Sixty passes have gone into making the **past provable**. That job is now
essentially finished: 0 gap days, 0 uncategorized, no account `broken`, three
arbiters that fail when a number stops being true, and 219 statement periods
that close to the cent. The marginal return on more ledger archaeology is
dropping fast — the brokerage arbiter is one pass, and after it there is nothing
left to prove.

Which means the honest next frontier is **the future and the decision**, not the
past. The app is very good at telling him what happened. It barely tells him
anything about what to do. Everything below follows from that.

And it can do this in a way no commercial app can. Mint, Monarch, Copilot all
have *aggregated* data — a Plaid feed, unreconciled, unprovable. This ledger is
*reconciled*. Every claim it makes can cite the statement it came from. That is
the asset, and almost none of it is currently visible.

## 17. Five things this ledger can answer that nothing else can

**a. Cash income — the biggest blind spot in his own data.** He is paid in cash,
roughly $1,046/week. July income reads **$52.95**. That is correct *by design*
— cash enters through `Cash on Hand`, not as a bank transaction — and it is also
the reason he asked about it. The app's income view is structurally blind to
most of what he earns.

The evidence to fix it already exists: ATM deposits, `Cash on Hand` movements,
a known weekly rate, and the stretches where he simply did not deposit. What it
should *not* do is infer, because "ATM deposit" already means three different
things on this ledger (his cash float, a loan repayment, his mother's cash).
So: a **cash-earnings estimator that offers, never asserts** — a second line
reading *"Banked income $52.95 · Estimated cash earnings $4,184 — estimated,
3 deposits unclassified"*, drawn in the same dashed grammar `complete:false`
already uses for carried prices. Never mixed into the reconciled figure.
**Highest value of anything in this document.**

**b. Net-worth attribution — the bridge chart.** Net worth moved from X to Y.
*Why?* Decompose it: earned · spent · market moves · family pass-through · in
transit. Every one of those five components already exists in a service —
`periodTotals`, `market_change_cents`, the Pass-through category,
`inTransitCents`. Nobody has assembled the waterfall. It answers "am I actually
getting richer, or is it just the market" — which for a portfolio that is now
most of his net worth is *the* question, and it needs reconciled data to answer
honestly.

**c. Runway.** Cash + committed outflows + income cadence → "N months". Recurring
detection, forecast, budgets and cash balances are all built; this is assembly,
not invention. Low novelty, high daily value.

**d. The car, priced honestly.** He took a lease last month: $559.89/mo,
$361.49 insurance ×6, $5,000 down — and that down payment is currently the only
un-evidenced −$5,000 in the whole ledger. The app knows his pre-car and post-car
spending exactly. "The car costs $X/month all-in, which is Y% of everything you
spend" is decision support from data only he has.

**e. A year-end summary, with citations.** January is coming. The ledger holds
Fordham direct-deposit wages, $10,023 of Knack tutoring, dividends, interest, and
realized gains with XIRR already computed. A one-page *summary of what is
reportable and which document each number came from* — a data summary with
provenance, explicitly not advice — turns a week of spreadsheet work into a page.

## 18. Make the invisible investment visible

The single most under-sold thing about this app is that **every number is
provable**, and there is no UI anywhere that shows it.

**a. A "prove it" affordance.** Click any figure → which import file, which
statement period, which arbiter graded it, what basis the day carries, when it
was last checked. `import_files`, `statement_periods`, `basis` and
`reconciliation` all already hold this. One popover would surface sixty passes of
hidden work. This is the most on-brand idea in the document.

**b. Statement-due on the dashboard, not only on `/imports`.** The app already
knows every account's cadence — `StatementSchedule` computes it. Right now it
says "Robinhood is two months behind" only on a page he visits when he is already
uploading. Say it where he looks.

**c. Price-change and outlier notice, neutrally worded.** `paid_different` is a
real state in `RecurringCalendar` that **no test has ever rendered** and no
seeded posting reaches. A subscription that changed price, or a charge 4× a
merchant's own median, is worth a quiet flag. Neutral wording matters here —
he travels and drives an EV, and three "card-testing probes" once flagged were
all legitimate.

## 19. The ambitious one — ask the ledger

He already pays for Claude categorisation ($0.027 a run). The natural next step
is a question box over his own reconciled data.

The discipline that makes it honest, and that no commercial version bothers with:
**the model never emits a number.** It compiles the question into a query, the
ledger runs it, and the answer renders as a real chart *plus the rows it used*.
Every answer is clickable down to the transaction, and every transaction is
traceable to a statement. A wrong answer becomes visibly wrong instead of
plausibly wrong. That is the only version compatible with the no-fake-data rule,
and it is strictly better than what the aggregators ship, because they cannot
cite anything.

Given the hardware, build the ambitious version.

## 20. Fix the thinnest page

`/merchants/[id]` is 91 lines: a name, a year total, a category rule, and a
recent list. There are **893 merchants**. The page should show spend over time,
cadence (the recurring engine already knows), first and last seen, average
ticket, category mix, and year-over-year. Cheap, obvious, and currently the
weakest surface in an otherwise dense app.

## 21. Engineering hygiene worth doing

- **Export everything.** One gitignored SQLite file holds four years of
  reconciled financial history. A "download as CSV/JSON" button is the cheapest
  disaster insurance available and takes an afternoon.
- **Run the arbiter automatically.** `pnpm ledger-check` is manual, which means
  drift is found in whichever pass someone thinks to look. A pre-commit hook or a
  scheduled run catches it the day it happens.
- **Call `reconcileAccounts` from `rebuildAccount`** so a stored verdict cannot go
  stale at all — with the caveat the last handoff flagged: it carries a quarantine
  side effect that is now *live* on Robinhood Cash since the crypto rows belong to
  the statement's own file. Assert statuses around any call.
- **Audit for states nothing reaches.** 3,050 unit tests and 428 e2e, and
  `paid_different` still renders in zero of them. Enumerate every discriminated
  union the components switch on, check which variants a fixture has ever
  produced, and either seed them or delete them. `paid_different` was found by
  hand; there are almost certainly others.
- **Delete or render `daysSinceVerified`.** A computed field with no consumer is
  a claim nobody checks.

## 22. If I had to pick three

1. **The brokerage arbiter** — finishes the correctness program. One pass, fully
   specified, and after it every account in the ledger can fail a check.
2. **Cash income** — the one number he personally noticed was wrong-feeling, and
   the largest structural gap between his ledger and his life.
3. **"Prove it"** — makes sixty passes of invisible work visible, and costs a
   popover.

Then multi-episode recurring (S11–S14), because it is the largest thing he asked
for in his own words that has never been started.
