# Page-by-page dossier — Part 2 of 3

Surfaces owned by this part:

- `/investments` — the portfolio surface
- `/investments/[assetType]/[symbol]` — holding detail
- `/budgets`
- `/recurring` — "Recurring & forecast"
- `/recurring/[id]` — recurring series detail

Every claim below cites `file:line`. Verdict vocabulary in the inventory tables:
**broken** (does the wrong thing), **missing-state** (a state exists in the data and not on
screen), **confusing** (works, but teaches the wrong model), **undiscoverable** (works, but the
user cannot find or decode it), **dead-end** (renders a number/row that should lead somewhere
and does not), **sensible** (leave it alone).

---

## /investments

**Purpose** — This is the owner's "am I actually making money on the market?" screen. Everything
else in MoneyApp answers "where did my cash go"; this page answers "what is my brokerage/crypto
position worth today, how did it get there, and is that skill or just deposits?" It exists because
market value is the one part of net worth that moves without a transaction — so it needs its own
valuation engine (`holding_events` × `price_cache`) and its own honesty apparatus (TWR vs XIRR vs
cost-basis P/L, all stated separately at `PortfolioStats.tsx:22-131`). Concretely: the hero chart
flips between raw Value and flow-adjusted Return (`page.tsx:154-165`), the stat row states four
different return definitions, and the holdings table / donut / P&L calendar let him drill from
"the portfolio moved $X today" down to "because NVDA moved $Y" down to "here's the ledger row."
The owner imports statements, not broker APIs, so this page is also where he manually keeps
positions in sync (`HoldingActionsMenu.tsx:44`) and pulls fresh prices (`RefreshPricesButton.tsx:60`).

**Connections**

- **Reads:** `listAccounts` filtered to active investment accounts (`page.tsx:80`) gates the whole
  surface; `portfolioOverview / portfolioSeries / portfolioReturnDays / holdingRows / topMovers /
  allocationSlices / pnlCalendarMonth / portfolioBenchmarkDays / hasBenchmark` (`page.tsx:105-131`),
  all sitting on `buildPortfolio` (`portfolio.ts:191`) over `holding_events` × `price_cache` ×
  `daily_balances`; `readSettings` for the persisted view preference and benchmark symbol
  (`page.tsx:58, 67, 72`).
- **Writes:** `addHoldingAction` → `upsertHolding` (`actions.ts:50`) mutates `holdings` and appends
  `holding_events`; `refreshPricesAction` → `refreshPrices` (`actions.ts:83`) writes `price_cache`
  AND rebuilds investment `daily_balances`, which is why it `revalidatePath("/")` — this page is the
  only place in the app that can move the dashboard's net worth without a transaction;
  `setBenchmarkAction` (`actions.ts:107`) backfills `price_cache` and writes
  `app_settings.benchmarkSymbol`; `saveViewPreferenceAction` via `useViewState` (`useViewState.ts:52`)
  writes `app_settings.viewPreferences.investments`.
- **Links out:** every holding row (`PortfolioHoldingsTable.tsx:170`), every donut legend row
  (`AllocationDonut.tsx:126`), every mover chip (`TopMovers.tsx:46`), and every day-sheet
  holding/sale row (`PnlCalendar.tsx:177, 198`) go to `/investments/[assetType]/[symbol]`; the day
  sheet's transaction rows go to the ledger via `ledgerHref` (`PnlCalendar.tsx:222`); the
  zero-account empty state links to `/accounts` (`page.tsx:94`).
- **Links in:** the nav item, the command palette's Holdings group (`command-index.ts:109-120`,
  active holdings only), and the holding page's "← All investments" back-link.
- **Not connected:** there is no link from /investments to the investment ACCOUNTS themselves, none
  to the investment transactions in bulk, and the dashboard/net-worth hero has no reciprocal "how
  much of this is market value" link back here.

**Interactive inventory**

| element | file:line | intended | verdict |
| --- | --- | --- | --- |
| HoldingForm — Asset type `<select>` (Stock/ETF/Crypto) | `src/components/investments/HoldingForm.tsx:48-52` | Classify the symbol for the (symbol, assetType) price key | **broken** — re-entering an existing symbol with the wrong asset type silently REWRITES `holdings.assetType` (`holdings.ts:110-111`) because the unique index is (accountId, symbol) with no assetType. All `price_cache` rows are keyed by (symbol, assetType), so the holding instantly loses its entire price history: value → null, chart empties, allocation drops it. No warning, no undo. |
| HoldingForm — Average cost per unit `<input>` | `src/components/investments/HoldingForm.tsx:66-71` | Broker avg cost, feeds Unrealized P/L only | **broken** — a negative value (e.g. "-5") passes the zod schema, hits `throw new Error("Average cost must be positive")` at `actions.ts:47` inside a void-returning form action, and surfaces as a Next.js error boundary — not a field message. Same for any quantity that trips `QuantityParseError` (`holdings.ts:36-45`). |
| HoldingForm — "Save holding" submit | `src/components/investments/HoldingForm.tsx:77-82` | Persist the holding + append a dated `holding_events` delta | **broken** — (a) zero success feedback: no toast, no sheet close, no form reset; (b) no confirmation and no undo for a destructive overwrite of a position; (c) it never calls `rebuildAccount`, so the flow is recorded while the NAV is not. |
| Holdings table 30d sparkline | `src/components/investments/HoldingSparkline.tsx:4-14` | Trend glance | **broken** — applies TODAY'S quantity to the last 30 closes (`portfolio.ts:597-600`), so a position bought last week displays a 30-day value history that never existed. `aria-hidden` with no tooltip, so a user cannot learn that. |
| P/L calendar — Previous / Next month buttons | `src/components/ui/CalendarGrid.tsx:135-147` | Page the month | **broken** — never disabled and unbounded. Each press fires `loadPnlMonthAction` → `pnlCalendarMonth` → a full `buildPortfolio` walk (`portfolio.ts:704`) over every holding event, even for 1998. Paging forward returns a blank grid with "Month P/L $0.00 · 0 up · 0 down" and no "no data" message. |
| "Today" stat label | `src/components/investments/PortfolioStats.tsx:26-28` | Label the day change; `dayChangeVsDay` exists to state the comparison date | **broken** — `Today{overview.dayChangeVsDay ? "" : ""}`: a dead ternary with two empty branches. The comparison date is computed (`portfolio.ts:358`) and thrown away, so a 07-18→07-19 move is labelled "Today" on 07-27. |
| ⋯ "Portfolio actions" IconButton (page header, right) | `src/components/investments/HoldingActionsMenu.tsx:30` | Open the sheet holding Refresh prices + the add/update-holding form | **undiscoverable** — an unlabeled ⋯ icon is the ONLY entry point to the page's two write actions and the only way to get fresh prices. Nothing says prices are stale or that a refresh exists. On a phone this is a 32px glyph next to the h1. |
| Chart plot area — drag-to-zoom brush → custom window | `src/components/investments/ScrubChart.tsx:436-459` | Drag a span to zoom into it | **undiscoverable** — nothing says a drag zooms. On touch it competes with page scroll, and the drag window is silently dropped whenever the user flips to the Table lens (`ScrubTable.tsx:27-29`). |
| "Updated `<time>`" stamp under the refresh button | `src/components/investments/RefreshPricesButton.tsx:69-71` | Show when prices were last pulled | **missing-state** — client-only `useState`, blank on load and after any navigation, so it can never tell you prices are 8 days old. The real as-of date exists (`overview.asOf`, `HoldingRow.quotedOn` at `portfolio.ts:536`) and is never rendered. |
| HoldingForm — "As of" date `<input>` | `src/components/investments/HoldingForm.tsx:74` | Date the quantity change occurred; drives the event timeline | **missing-state** — no `max=today`, so a future-dated trade is accepted and lands in the flow series ahead of every close. |
| From date `<input type=date>` | `src/components/investments/ScrubChart.tsx:895-903` | Type an exact window start | **missing-state** — a window holding <2 points is silently ignored (`ScrubChart.tsx:399-403`); the input reverts with no message, so a valid-looking date just does nothing. |
| To date `<input type=date>` | `src/components/investments/ScrubChart.tsx:905-913` | Type an exact window end | **missing-state** — same silent no-op as From. |
| Holdings table Price cell / "no price" warning | `src/components/investments/PortfolioHoldingsTable.tsx:116-126` | Show the latest close | **missing-state** — `HoldingRow.quotedOn` is computed (`portfolio.ts:536, 608`) and never rendered. A price from 2026-07-19 and a price from today look identical. |
| P/L calendar — month change loading state | `src/components/investments/PnlCalendar.tsx:43` | Indicate a pending month fetch | **missing-state** — `const [, startTransition]` discards `isPending`, so paging a month shows no spinner, no dimming. The day sheet DOES render "Loading…" (`:127`), so the asymmetry is visible within one component. |
| Zero-HOLDINGS state (accounts exist, no positions) | `src/app/investments/page.tsx:166-197` | Guide a user with an empty portfolio | **missing-state** — a gray sentence, then a `PortfolioStats` row of four em-dashes, then an empty holdings table, then "Allocation appears once…", then a blank P/L calendar with "$0.00 · 0 up · 0 down". Five dead modules and no CTA. |
| "Refresh prices" button | `src/components/investments/RefreshPricesButton.tsx:60-68` | Force a live quote, backfill missing closes, rebuild investment `daily_balances`, toast the outcome | **confusing** — the single most important control on the page (the only thing that un-stales every number), buried two interactions deep with no urgency signal. It also silently repairs the add-holding NAV bug (`prices.ts:439`) with no indication. |
| HoldingForm — Symbol `<input>` (uppercases on change) | `src/components/investments/HoldingForm.tsx:36-45` | Ticker entry | **confusing** — no autocomplete against existing holdings, no validation feedback. A typo creates a brand-new holding with no price history rather than updating the intended one. |
| HoldingForm — Quantity `<input>` | `src/components/investments/HoldingForm.tsx:55-63` | The RESULTING total quantity (not a delta) | **confusing** — absolute set, not a trade. To record selling 20 of 100 shares the owner must type 80. Only the fine print at `:83-86` hints that a change becomes a buy/sell event. |
| Benchmark `<select>` ("vs S&P 500" etc.) | `src/components/investments/BenchmarkPicker.tsx:77-99` | Choose the comparison index for the Return view; persists and re-renders overlays | **confusing** — only visible in Return view AND chart lens (`PortfolioChartPanel.tsx:222`). Switching to the Table lens makes picker, legend and overlay vanish with no explanation. |
| View ViewSwitcher (Value ⇄ Return) | `src/components/investments/PortfolioChartPanel.tsx:234-242` | Flip the hero between market value and deposit-stripped return | **confusing** — the two series do not cover the same days: `points` is carried forward to today (`page.tsx:109-112`), `returnDays` stops at the last cached close (`page.tsx:113`). Switching silently changes the x-extent under an unchanged range pill. The prop doc at `PortfolioChartPanel.tsx:49` claims they are "aligned 1:1 by day". |
| Range pills 1M / 3M / YTD / 1Y / ALL | `src/components/charts/ChartRangePills.tsx:33-48` (mounted at `ScrubChart.tsx:878`, `ScrubTable.tsx:154`) | Slice the visible window | **confusing** — the only view state on this page not in the URL and not persisted (`ChartFocus.tsx:67`); `?range=` (`page.tsx:56`) is a one-time seed. Clicking 3M then reloading gives ALL. 1M/3M are trailing 30/91 DAY counts (`chart-range.ts:14-18`), never labelled as such. |
| Table lens rows (Day / Value\|Return / Basis) | `src/components/charts/ScrubTable.tsx:119-142` | The chart's window as numbers, newest first | **confusing** — unpaginated (`ScrubTable.tsx:109-113`). ALL range with ~2 years of daily points is 700+ rows on a phone, no virtualization, no page size, no CSV export. |
| Top movers Winners/Losers segmented toggle | `src/components/investments/TopMovers.tsx:23-34` | Flip the chip strip between the day's best and worst | **confusing** — component-local `useState`; not in the URL, not persisted, resets on every navigation, unlike the chart's own switchers three inches above. |
| Top movers chips (→ holding page) | `src/components/investments/TopMovers.tsx:45-54` | Open the mover's holding page | **confusing** — labelled as the day's move but computed from the two most recent CACHED closes (`portfolio.ts:643-655` via `holdingRows:581-590`), which can be a week apart. Nothing dates it. |
| Holdings table sort headers: Holding / Value / Alloc | `src/components/investments/PortfolioHoldingsTable.tsx:96,131,155` → `DataTable.tsx:202-215` | Sort the position list | **confusing** — sort state is `useState` (`PortfolioHoldingsTable.tsx:39`). Price, 30d and the metric column are not sortable, so you cannot rank by day change, P/L or realized. |
| Holdings metric column header — tap to cycle Day % → Day change → Unrealized P/L → Realized P/L | `src/components/investments/PortfolioHoldingsTable.tsx:138-148`, `src/lib/holding-cycle.ts:14-17` | Fit four metrics into one column | **confusing** — one-way cycle, no back step, no menu, no persistence. Landing on Realized P/L takes three taps and is lost on reload; it also cannot be sorted by. |
| Allocation legend rows (link + hover/focus highlight) | `src/components/investments/AllocationDonut.tsx:125-150` | Navigate to the holding and drive the highlight from the keyboard | **confusing** — uncapped: every priced holding gets a row, so a 40-position portfolio is a 40-row list in a 280px rail with no "other" bucket. No asset-class view. |
| P/L calendar legend (Gain / Loss / "Saturation = size of the move") | `src/components/investments/PnlCalendar.tsx:265-279` | Decode the heatmap | **confusing** — explains hue and saturation but never the two glyphs actually drawn in cells: the bold "!" for an inexact day (`:102`) and the corner dot for a realized sell (`:105-107`). |
| ≈ / ! honesty markers with `title=` tooltips | `PortfolioStats.tsx:35,68,113`; `PortfolioHoldingsTable.tsx:63,74,90` | Flag numbers estimated at daily closes | **confusing** — `title=` is not reachable on touch and not focusable. Two of them (`dayChangeExact`, `xirrExact`) can never fire: no producer sets `PortfolioDay.exact=false` (`portfolio.ts:159` hardcodes `exact:true`). |
| Total return stat — TWR + XIRR block | `src/components/investments/PortfolioStats.tsx:42-82` | State the flow-insensitive and money-weighted returns side by side | **confusing** — four different return definitions in one row with 11px captions, no glossary, no info popover, no link to a definition. |
| Best day / Worst day / Max drawdown strip (Return view) | `src/components/investments/ReturnViewParts.tsx:259-290` | Volatility context under the return line | **confusing** — Best/Worst name a date but are not clickable; they should open that day's P/L sheet, which already exists two sections below. |
| Realized P/L stat | `src/components/investments/PortfolioStats.tsx:103-129` | Total P/L locked in by sells | **dead-end** — the only stat with no drill-down. The holding page has a full `RealizedSalesList` (`[symbol]/page.tsx:135-137`); the portfolio has none. It also counts legs the Holdings table cannot show (`holdingRows` filters `isActive` at `portfolio.ts:569`). |
| Portfolio actions Sheet (right drawer / bottom sheet) | `src/components/ui/Sheet.tsx:80-127` | Host Prices + Add-holding sections | sensible |
| Sheet Close button / Escape / backdrop click | `src/components/ui/Sheet.tsx:52,99-111` | Dismiss the actions sheet | sensible |
| HoldingForm — Account `<select>` | `src/components/investments/HoldingForm.tsx:26-33` | Pick which investment account the position belongs to | sensible |
| "Focus the Portfolio chart" button | `src/components/charts/ChartFocus.tsx:119-126` | Expand the same chart into a native `<dialog>`, morphing via `startViewTransition` | sensible |
| Focus dialog: Close button / Escape / backdrop click | `src/components/charts/ChartFocus.tsx:140-167` | Dismiss focus view, return focus to the opener | sensible |
| Benchmark "Custom…" option → ticker `<input>` (Enter submits, Escape cancels) | `src/components/investments/BenchmarkPicker.tsx:61-76` | Type any ticker; backfills 2y of closes or rejects with a reason | sensible |
| "fetch 2 years of closes" button | `src/components/investments/BenchmarkPicker.tsx:109-117` | Backfill history for the selected symbol | sensible |
| Benchmark error `<p role="alert">` | `src/components/investments/BenchmarkPicker.tsx:101-105` | Surface a rejected symbol | sensible |
| Unit ViewSwitcher ($ ⇄ %) — Return view only | `src/components/investments/PortfolioChartPanel.tsx:225-233` | Switch the return line between cumulative dollar P/L and time-weighted percent | sensible |
| Lens ViewSwitcher (Chart ⇄ Table) | `src/components/investments/PortfolioChartPanel.tsx:243-249` | Render the same window as rows | sensible |
| Chart plot area — `role="slider"`, keyboard scrub (←/→ 1d, ↑/↓ 7d, Home/End) | `src/components/investments/ScrubChart.tsx:527-534`, `src/lib/scrub.ts` | Inspect any day; `aria-valuetext` announces day + value + delta | sensible |
| Chart plot area — pointer press/hover hairline scrub | `src/components/investments/ScrubChart.tsx:416-449` | Hover/press to read a day | sensible |
| "`<from>` – `<to>` · Reset" custom-window pill | `src/components/investments/ScrubChart.tsx:885-892` | Show and clear an active drag window | sensible |
| Holdings table row (whole row is a stretched link) | `src/components/investments/PortfolioHoldingsTable.tsx:170` → `DataTable.tsx:147-155` | Drill into a position | sensible |
| Allocation donut wedge hover (highlight + dim siblings) | `src/components/investments/AllocationDonut.tsx:103-104` | Tie a thin wedge to its name | sensible — documented at `:98-102` as unverified on touch; the legend row is the guaranteed path. |
| Allocation donut recharts Tooltip (symbol, value, %) | `src/components/investments/AllocationDonut.tsx:75-88` | Read a wedge's numbers | sensible |
| P/L calendar — day cells (click opens the day sheet) | `src/components/ui/CalendarGrid.tsx:165-193`, `PnlCalendar.tsx:59-69` | Open per-holding attribution for that day | sensible |
| P/L calendar — arrow-key roving grid nav + Home/End | `src/components/ui/CalendarGrid.tsx:93-124` | Keyboard-walk the month | sensible |
| P/L day sheet — per-holding delta rows (→ holding page) | `src/components/investments/PnlCalendar.tsx:176-184` | Attribute the day's move to symbols | sensible |
| P/L day sheet — realized-sale rows (→ holding page) | `src/components/investments/PnlCalendar.tsx:196-207` | Show what was locked in that day | sensible |
| P/L day sheet — transaction rows (→ filtered ledger) | `src/components/investments/PnlCalendar.tsx:219-229` | Jump to the day's investment transactions | sensible — the best drill-through on the page, and the only link from /investments into the ledger. |
| Decomposition bar (contributions vs market gains) | `src/components/investments/ReturnViewParts.tsx:300-346` | Split value into capital in and market P/L | sensible |
| Benchmark / replay legends | `src/components/investments/ReturnViewParts.tsx:181-256` | Name the You vs benchmark lines and state the benchmark's own baseline day | sensible |
| Zero-account empty state + "Go to Accounts →" link | `src/app/investments/page.tsx:89-100` | Route a first-time user to create an investment account | sensible |

**Good**

1. The four-return discipline is genuinely rare and worth protecting: TWR, XIRR, unrealized
   cost-basis P/L and realized P/L are stated as four separate facts with their own captions and
   never summed (`PortfolioStats.tsx:22-131`). Propagate this "state the basis next to the number"
   habit everywhere.
2. One panel renders in both the inline card and the focus dialog (`ChartFocus.tsx:127` and `:169`
   call the same `renderPanel`), so view/unit/lens/benchmark parity is structural rather than
   re-implemented.
3. The table lens re-uses the chart's OWN `summarize`, `renderHeader` and `formatValue` function
   objects (`ScrubTable.tsx:44-53`, wired at `PortfolioChartPanel.tsx:269-280`) and slices with the
   same pure `windowedPoints` — the numbers cannot drift from the line by construction. Best piece
   of engineering on the surface.
4. The `fellBack` caption (`ScrubTable.tsx:147-149`) refuses to name a window it isn't showing.
   Propagate that instinct to the range pills, which currently stay visually pressed while the chart
   silently shows everything.
5. The allocation donut's hover/focus highlight dims only wedges and swatches, never label text
   (`AllocationDonut.tsx:133-149`), so contrast can't regress in any highlight state — and focus,
   not a parallel set of SVG tab stops, drives it. Pinned at `zz-investments.spec.ts:157-188`.
6. The benchmark legend names the benchmark's OWN first-priced day rather than claiming "all time"
   (`ReturnViewParts.tsx:244-251`), because the 2-year backfill cap can start it later than the
   portfolio's baseline.
7. The P/L calendar puts the exact value in the cell's `aria-label` rather than printing unreadable
   text on a saturated tint (`PnlCalendar.tsx:71-86`), and the day sheet's per-holding deltas
   telescope to the header (`portfolio.ts:773-789`).
8. `setBenchmarkAction` refuses to persist a symbol it could not price (`actions.ts:114-124`) and
   returns the reason. Copy this "validate before persist, return the reason" shape into the
   add-holding action, which has none of it.
9. The refresh path degrades to cached prices on a provider outage and reports it as a neutral toast
   rather than an error page (`RefreshPricesButton.tsx:31-54`, `actions.ts:81-98`).

**Bad** (ranked)

1. **CRITICAL — Adding a holding through the UI fabricates a loss (and can truncate the whole
   account's history).** `addHoldingAction` calls `upsertHolding` and then only `revalidatePath`
   (`src/app/investments/actions.ts:50-61`). `upsertHolding` appends a `holding_events` row
   (`holdings.ts:134-151`) and never calls `rebuildAccount`. But `flowsByDay` reads `holding_events`
   directly (`portfolio.ts:71-108`) while `buildAccountBook` reads NAV from the `daily_balances`
   cache (`portfolio.ts:128-163`). So the moment you save a position, a flow exists for a day whose
   NAV did not move — and `returnCents = nav − prevNav − flow` (`portfolio-returns.ts:79-83`)
   subtracts the entire purchase from that day's return. Add 1 AAPL dated 2026-07-17 through the ⋯
   sheet: the value chart does not move, but that day's P/L flips from −$1,597.79 to −$1,931.53 and
   headline TWR drops 6.485% → 6.084%. Worse, if the symbol has no cached closes,
   `rebuildInvestmentHistory` skips every day where any held symbol lacks a close
   (`crypto-history.ts:110-117`) on the next refresh, truncating the account's `daily_balances` at
   the day before — portfolio value falls from $88,968 to $47,087 and `netWorthSeries`' trailing
   carry-forward re-marks those days `complete:true, missingAccounts:[]`
   (`derivation.ts:315-331`), so nothing on any screen warns. Self-heals only if the owner happens
   to press Refresh prices.
2. **HIGH — The add-holding form has no error path, no success path, and no undo for a destructive
   overwrite.** `<form action={addHoldingAction}>` (`HoldingForm.tsx:24`) binds a `Promise<void>`
   server action that throws on failure: zod (`actions.ts:33`), `"Average cost must be positive"`
   (`actions.ts:47`), `QuantityParseError` (`holdings.ts:36-45`), `"Holdings belong to investment
   accounts only"` (`holdings.ts:93`). Fat-finger a minus into avg cost → the whole route
   error-boundaries. On SUCCESS nothing happens visibly: no toast, sheet stays open, fields keep
   their values, so a double-tap is easy. And because Quantity is an absolute set, typing 8 when you
   meant 80 appends a −72-share sell event that rewrites realized P/L, with no confirmation, no undo,
   and no delete path for holdings or holding_events anywhere in the UI.
3. **HIGH — Asset type is silently rewritable and orphans the holding's entire price history.** The
   `holdings` unique index is (account_id, symbol) with no asset_type, while every price/return path
   keys on (symbol, assetType) — `holdingRows` (`portfolio.ts:577`), `closeOn` (`portfolio.ts:864`),
   `benchmarkAssetType`. `upsertHolding` unconditionally sets `assetType: parsed.assetType`
   (`src/services/holdings.ts:110-111`). Re-enter ETH to update the quantity while the Asset type
   select has re-defaulted to "Stock" (`HoldingForm.tsx:49`, first option, no `defaultValue` bound to
   the existing holding): the row becomes a stock, every `price_cache` row for (ETH, crypto) is
   unreachable, the holding renders "no price" (`PortfolioHoldingsTable.tsx:124`), drops out of the
   donut (`portfolio.ts:902`), drops out of movers, and the account's NAV rebuild starts skipping
   days. No warning at any step.
4. **HIGH — Realized P/L headline does not reconcile to anything the page can show, and closed
   positions are unreachable.** `portfolioOverview.realizedPlCents` walks EVERY leg in
   `holding_events` (`portfolio.ts:462, 424-434`), but `holdingRows` filters `isActive = true`
   (`src/services/portfolio.ts:569`) and `allocationSlices`/`topMovers` build on it. On the owner's
   real book that is $3,018.13 across 34 legs in the header vs $1,941.42 visible across the 9 active
   rows — $1,076.71 living in 25 fully-closed positions that have no row, no list, and no link.
   `/investments/stock/GOOG` resolves (`holding-detail.ts:162`) but is reachable from nowhere: the
   palette's Holdings group also filters `isActive` (`command-index.ts:99`). Compounding it, the
   header carries "≈" (`realizedPlExact=false`) solely because of a closed CVX leg with one cached
   close — every visible row reads exact, so the marker is unexplainable.
5. **HIGH — Stale prices are presented as "Today" and the as-of date is computed but never
   rendered.** `price_cache`'s newest close can be days old (no automatic refresh exists).
   `overview.dayChangeVsDay` names the comparison day (`portfolio.ts:355-358`) but
   `src/components/investments/PortfolioStats.tsx:27` renders `Today{overview.dayChangeVsDay ? "" :
   ""}` — a dead ternary, so the date is discarded. `HoldingRow.quotedOn` (`portfolio.ts:536, 608`)
   is likewise never rendered. `RefreshPricesButton`'s "Updated `<time>`" is client `useState`
   (`RefreshPricesButton.tsx:22`) and blank on every fresh load. On 2026-07-27 with prices last
   cached 2026-07-19 the page states "Today +$412.18 (+0.46%)", the movers strip labels an eight-day
   move as the day's, and the only truthful cue is the dashed tail on the Value chart — which the
   Return view does not have because `returnDays` is not carried forward (`page.tsx:113`).
6. **MEDIUM — The value chart discards per-day account-coverage honesty.** `portfolioSeries` computes
   `complete = coveredAccounts === totalAccounts` (`portfolio.ts:242-248`); `src/app/investments/page.tsx:110`
   maps it to `{ day, valueCents }` only, and `carryForwardTo` then stamps every real point
   `complete: true` (`price-series.ts:40`). A brokerage held since 2023 plus a crypto account added in
   2026 draws 2023-2025 as a solid, exact line with the table lens's Basis column reading "exact".
   The dashboard's net-worth chart is scrupulous about exactly this.
7. **MEDIUM — The range pill is the only view state on the page that is neither shareable nor
   persisted.** `ChartFocus` owns the range in plain `useState(defaultRange)`
   (`src/components/charts/ChartFocus.tsx:67`) and `?range=` is read once as a seed (`page.tsx:56`),
   while `view`, `unit`, `lens` and `bench` all round-trip (`page.tsx:60-73`,
   `useViewState.ts:44-56`). Set 3M then switch Value→Return: `setView` navigates to a href built
   from `viewBaseParams`, which still carries the RSC-time range (`page.tsx:75-78`,
   `PortfolioChartPanel.tsx:136`). The URL advertises a range the chart is not on.
8. **MEDIUM — The Table lens deletes the benchmark comparison rather than tabulating it.**
   `src/components/investments/PortfolioChartPanel.tsx:222` gates the picker on `!isTable`, both
   legends are gated at `:252, :260`, and `ScrubTable` has no `compareLine` prop at all
   (`ScrubTable.tsx:37-69`). The one framing where a table is strictly better than a chart — "show me
   my % vs SPY's % by day" — is the one the table refuses to render.
9. **MEDIUM — P/L calendar month paging is unbounded, un-indicated, and expensive.** Chevrons are
   never disabled (`CalendarGrid.tsx:135-147`); each press calls `loadPnlMonthAction` →
   `pnlCalendarMonth` → `buildPortfolio(db)` (`portfolio.ts:704`), a full re-walk plus
   `realizedSalesByDay`, and `src/components/investments/PnlCalendar.tsx:43` discards `isPending`.
   Holding the chevron down is a trivial way to pin the process.
10. **MEDIUM — The 30-day row sparkline shows a value history that never happened.** `holdingRows`
    builds `sparkline` as `closes.slice().reverse().map(c => valueCentsOf(r.quantityE8, c.close))`
    (`src/services/portfolio.ts:597-600`) — today's quantity applied retroactively to 30 closes, and
    coloured green/red by that fictitious start-to-end delta (`HoldingSparkline.tsx:7`).
11. **MEDIUM — The zero-holdings state is five dead modules and four em-dashes.**
    `src/app/investments/page.tsx:166-197`: a gray sentence, a `PortfolioStats` row reading
    "$0.00 —", "—", "—", "—" (`PortfolioStats.tsx:96, 120`), an empty holdings table, "Allocation
    appears once holdings have cached prices", and a blank P/L calendar footer. The ⋯ menu is
    mentioned exactly once, inside the table's own empty string (`PortfolioHoldingsTable.tsx:171`).
12. **MEDIUM — The whole ≈ / exact honesty apparatus is permanently inert in the return path.**
    `buildAccountBook` hardcodes `exact: true` on every `PortfolioDay`
    (`src/services/portfolio.ts:159`) and no producer ever sets it false. So `overview.dayChangeExact`
    (`portfolio.ts:357`), `overview.xirrExact`, and `PnlDayCell.exact` are always true, and the
    tooltips at `PortfolioStats.tsx:34-38` and `:67-73` plus the bold "!" at `PnlCalendar.tsx:102`
    can never fire.
13. **MEDIUM — Three page-level toggles hold state the URL and app_settings never see.** Holdings
    sort (`src/components/investments/PortfolioHoldingsTable.tsx:39`), metric cycle (`:38`), and the
    movers side (`TopMovers.tsx:13`). Cycle the metric to Realized P/L (three taps), open a holding,
    hit Back — the column is on Day % again, sort is Value desc, movers is Winners. The chart's own
    switchers three inches above persist correctly, so the page teaches two contradictory rules.
14. **LOW — Value ⇄ Return silently changes the x-extent under an unchanged range pill.** `points` is
    carried to today (`page.tsx:109-112`); `returnDays` is not (`page.tsx:113`). `HoldingChartPanel`
    guards this exact hazard with `resetRangeKey`; `PortfolioChartPanel` passes none (`:209-212`),
    and the prop doc at `src/components/investments/PortfolioChartPanel.tsx:49` asserts they are
    "aligned 1:1 by day".
15. **LOW — Honesty markers are undecodable on the phone the owner actually uses.** Every ≈
    explanation is a `title=` attribute (`src/components/investments/PortfolioStats.tsx:35, 68, 113`;
    `PortfolioHoldingsTable.tsx:63, 74, 90`), and the spans are not focusable. The calendar's "!"
    (`PnlCalendar.tsx:102`) and realized dot (`:105-107`) have no explanation at all.
16. **LOW — Drag-to-zoom and the date inputs fail silently.** `applyWindow` returns without any state
    change when the requested span holds fewer than two points
    (`src/components/investments/ScrubChart.tsx:399-403`); the input snaps back with no message.
    Same for a hair-thin drag (`:459`).

**Change** (ranked by value ÷ effort)

1. **Make the add-holding action rebuild the account and report its result.** (M) In
   `addHoldingAction` (`actions.ts:50-61`) call `rebuildAccount(db, parsed.accountId)` after
   `upsertHolding`, and convert to the app's `ActionResult<T>` + `useActionState` + toast shape used
   everywhere else (compare `setBenchmarkAction`, `actions.ts:107-136`). Catch `QuantityParseError`
   and the avg-cost guard and return them as field-level messages instead of throwing
   (`actions.ts:47`). On success, toast, close the sheet, reset. Add a pre-save diff line to
   `HoldingForm` — "AAPL: 100 → 80 (sell 20 on 2026-07-27)".
2. **State the as-of date everywhere a price-derived number appears.** (S) Render
   `overview.dayChangeVsDay` in the Today label (replace the dead ternary at `PortfolioStats.tsx:27`
   with e.g. "Since Jul 19"), render `HoldingRow.quotedOn` in the Price cell
   (`PortfolioHoldingsTable.tsx:116-126`), date the Top movers heading, and add a persistent
   "Prices as of `<date>` · Refresh" line in the page header — warning-toned when `overview.asOf` is
   more than 1 trading day behind today.
3. **Surface Refresh prices as a first-class control, not a sheet item.** (S) Move
   `RefreshPricesButton` out of `HoldingActionsMenu` (`:37`) into the page header alongside the ⋯
   (`page.tsx:144-147`), keeping the sheet copy too (additive). It is the only thing that unblocks
   stale prices and repairs the add-holding NAV desync (`prices.ts:439`).
4. **Preserve the value chart's coverage honesty.** (S) Pass `complete` (and
   `coveredAccounts`/`totalAccounts`) through at `page.tsx:110` instead of mapping to
   `{day, valueCents}`, and let `carryForwardTo` preserve an existing false rather than stamping
   `complete: true` (`price-series.ts:40`).
5. **Bound and instrument the P/L calendar's month paging.** (S) Disable Previous at the first
   portfolio month and Next at the current month (`CalendarGrid.tsx:135-147` IconButtons accept
   `disabled`), consume `isPending` (`PnlCalendar.tsx:43`), and render "No portfolio activity in
   `<month>`" when `Object.keys(cellsByDay).length === 0`.
6. **Design the zero-holdings state.** (S) When `points.length < 2` and `holdingRows` is empty
   (`page.tsx:166-197`), replace the five dead modules with one EmptyState explaining that positions
   are entered manually, not imported, plus a primary "Add your first position" opening the same
   Sheet. Keep the existing modules for the has-holdings-no-prices case.
7. **Replace `title=` honesty markers with touch-reachable disclosures.** (S) Convert every ≈ / !
   marker (`PortfolioStats.tsx:35,68,113`; `PortfolioHoldingsTable.tsx:63,74,90`;
   `PnlCalendar.tsx:102`) into a focusable button opening the existing Popover, and extend the
   calendar Legend (`PnlCalendar.tsx:265-279`) to decode "!" and the realized-sell dot. Either wire a
   real producer for `PortfolioDay.exact` (`portfolio.ts:159`) or leave a TODO saying it is always
   true.
8. **Give the Best day / Worst day stats somewhere to go.** (S) Make `ReturnStatsList`'s dates
   (`ReturnViewParts.tsx:266-281`) open the P/L day sheet that already exists (`loadPnlDayAction`,
   `actions.ts:155`).
9. **Paginate or window the Table lens.** (S) `ScrubTable` renders every windowed row
   (`ScrubTable.tsx:109-113`); cap at ~90 with a "Show all N days" expander plus "Copy as CSV".
10. **Add a pending indication to the view switchers.** (S) `useViewState` returns `isPending` and
    `PortfolioChartPanel` discards it (`:93`); pass it to `ViewSwitcher`'s existing `disabled` prop.
11. **Put the range pill in the URL and app_settings like every other view dimension.** (M) Lift it
    out of `ChartFocus`'s `useState` (`ChartFocus.tsx:67`) — either a `{key:"range", options:
    CHART_RANGES}` dimension APPENDED to `PORTFOLIO_VIEW_SPEC` (`investments-view-spec.ts:19-24`,
    honoring the positional-index invariant at `chart-lens.ts:17-19`) or a dedicated `?range=` write
    in `selectRange`. Until then, stop emitting a stale `range` into `viewBaseParams`
    (`page.tsx:75-78`).
12. **Give Realized P/L a drill-down and stop hiding closed positions.** (M) Make the stat a
    link/disclosure opening a portfolio-wide realized-sales list, reusing `RealizedSalesList`
    (`[symbol]/page.tsx:135-137`) fed by `portfolioRealizedPl(db).byLeg`. Add a "Closed positions"
    section (or a Holdings toggle "Show closed") for legs with `isActive = false`, and widen the
    palette's Holdings group beyond `isActive` (`command-index.ts:99`).
13. **Make the sparkline honest about quantity.** (M) Build it from the quantity actually held each
    day (replay `holding_events` the way `holdingReturnDays` already does,
    `holding-returns.ts:51`) rather than `portfolio.ts:597-600`. If too costly per row, truncate at
    the position's first event day.
14. **Carry the benchmark into the Table lens.** (M) Add an optional `compareColumn` to `ScrubTable`
    (`ScrubTable.tsx:37-69`) rendering the benchmark's per-day value from the same `compareLine.byDay`
    map, and drop the `!isTable` gate at `PortfolioChartPanel.tsx:222`.
15. **Persist the holdings sort, metric and movers side.** (M) Move the three `useState` toggles
    (`PortfolioHoldingsTable.tsx:38-39`, `TopMovers.tsx:13`) into the URL view-state model or at
    minimum `app_settings.viewPreferences.investments`. Make the metric column sortable, and add
    standing Realized/Unrealized columns at lg+ where the width compromise
    (`holding-cycle.ts:6-7`) is unnecessary.
16. **Guard asset type on an existing symbol.** (M) In `upsertHolding` (`holdings.ts:108-118`),
    refuse to change `assetType` on a row that has `holding_events` or cached prices — mirroring
    `accounts.ts:206-218` where an investment account's type is blocked to protect a derived cache.
    Return a typed error ("ETH is already tracked as Crypto"). Prefill Account/Asset type/Quantity/Avg
    cost from the matching holding as soon as the symbol resolves.

**Add** (ranked)

1. **A real trade entry path: Buy / Sell / Dividend, with a trade log and delete.** (L) Today the
   only write is "set the resulting total quantity" (`HoldingForm.tsx:55-63`), there is no delete for
   a holding or a `holding_event` anywhere in the UI, and no importer creates `holding_events`. Add a
   Buy/Sell form taking shares + price + date and deriving the delta, plus a portfolio-wide trade log
   (the per-holding `HoldingEventsList` already exists) with row-level edit/delete behind a confirm.
   Store the execution price so realized P/L stops being an estimate at daily closes. *This is the
   surface's biggest structural hole.*
2. **A "Prices are stale" banner with automatic refresh on visit.** (S) Compare `overview.asOf` to
   the last weekday and render a dismissible banner offering a one-tap refresh, plus an opt-in
   setting to refresh on load when the cache is older than N hours (`refreshPrices` already has a
   staleness window; only the manual button passes `force: true`, `actions.ts:83`).
3. **Account filter / per-account portfolio scope.** (S) `buildPortfolio`, `portfolioSeries` and
   `portfolioReturnDays` already accept an optional `accountIds` scope (`portfolio.ts:191, 240, 252`)
   and it is used nowhere. Add a URL-driven account chip filter scoping the whole surface.
4. **A portfolio-level "why did this move?" explanation strip.** (S) Under the hero, a sentence from
   `pnlDayDetail` for the latest day: "Up $412 since Jul 19 — NVDA +$580, ETH −$210, everything else
   flat." Same data the day sheet renders (`PnlCalendar.tsx:169-185`), hoisted to where the number
   lives.
5. **Export: CSV of holdings, of the value/return series, and of realized sales.** (S) Everything on
   this page is derived from data only this app holds and there is currently no way to get any of it
   out.
6. **Asset-class and account allocation views on the donut.** (M) `allocationSlices` aggregates by
   (assetType, symbol) only (`portfolio.ts:901-921`). Add a ViewSwitcher — By holding / By asset class
   / By account — with a top-N + "Other" rollup and a drill from a class wedge into its holdings.
7. **Contributions vs market gains over time, as its own chart.** (M) `decomposeValue` already
   computes gross contributed / withdrawn / net contributed / gains with an exact identity
   (`portfolio-returns.ts:249`, rendered as a static bar at `ReturnViewParts.tsx:300-346`). Promote it
   to a third `view` option: a stacked area across time, scrubable like the others.
8. **A dividend / income section.** (M) The pnl day sheet already surfaces investment-side
   transactions (`portfolio.ts:794-800`) and `description-key.ts:20-44` special-cases brokerage
   DIV/DRIP rows. Add trailing-12-month dividends, per-holding yield on cost, and an
   upcoming-dividend row.
9. **Per-holding drill-down from the P/L calendar to a symbol×day matrix.** (M)
   `holdingDeltasBetween` already computes per-symbol deltas for a single day (`portfolio.ts:834`);
   a symbols × days heatmap answers "which holding has been consistently bad".
10. **Multi-benchmark comparison and a "you vs" summary row.** (M) `portfolioBenchmarkDays`
    (`portfolio.ts:262`) is already generic over symbol; `ScrubChart` already supports named
    `overlays` (`ScrubChart.tsx:294-322`). Allow 2-3 overlays plus a You / SPY / QQQ / BTC table
    reusing `returnStats`.
11. **Wide-screen layout for the portfolio.** (M) The shell caps main at `max-w-5xl`
    (`AppShell.tsx:32,65`) and this page is one column. On a monitor, chart and P/L calendar side by
    side, standing metric columns instead of the cycle, donut with legend beside it.
12. **Memoize the per-render portfolio walk.** (M) One render calls `buildPortfolio` at least four
    times and `portfolioRealizedPl` five, each re-walking all 1,991 holding events with one `closeOn`
    query per event (`portfolio.ts:86`). Measured ~268ms of synchronous better-sqlite3 work per render
    on the real DB. Add a request-scoped cache (React `cache()`) and reuse `holdingRows` across
    allocation/movers.
13. **Position-level cost basis and tax lots.** (L) Unrealized P/L uses the single broker-supplied
    `holdings.avgCostCents` (`portfolio.ts:591`) while realized P/L uses an average-cost walk at
    closes (`realized-pnl.ts`) — two incompatible bases sitting adjacent in the stat row
    (`PortfolioStats.tsx:84-129`). Add per-lot tracking and a short-term/long-term split.

---

## /investments/[assetType]/[symbol]

**Purpose** — The "what is my money actually doing inside ONE security" page — the only screen in
MoneyApp that aggregates a symbol across every account (`holding-detail.ts:139-160` keys on
assetType+symbol, never accountId) and answers four separate questions: what is it worth
(PositionCard), what did the price do (Price chart), what did MY dollars do in it (Return chart,
flow-adjusted at daily closes), and what did I actually lock in (Realized P/L + trade history). It
exists because the /investments index can only show one row per (account, symbol) and one number per
row. In practice it is the "should I still own this / did I beat SPY / where did the $3k of realized
gains come from" page, and the only place per-account basis books, XIRR and individual sells are ever
visible.

**Connections**

- **Reads:** `holdingDetail` (`services/holding-detail.ts`) joining `holdings` + `holding_events` +
  `price_cache` + `accounts`, and calling `holdingRows(db)` (`portfolio.ts:554`) purely for the
  diversity percentage — dragging the ENTIRE portfolio's realized-P/L walk into this page's render.
  Also `readSettings` (`viewPreferences["holding"]`, `benchmarkSymbol`),
  `hasBenchmark`/`portfolioBenchmarkDays`, and the pure libs `holding-returns.ts`,
  `portfolio-returns.ts`, `benchmark-replay.ts`, `price-series.ts`, `realized-pnl.ts`, `xirr.ts`.
- **Writes:** nothing directly. The only mutation reachable is `setBenchmarkAction`
  (`app/investments/actions.ts:107`) via `BenchmarkPicker`, persisting `app_settings.benchmarkSymbol`
  and possibly backfilling `price_cache`; `useViewState` also fire-and-forget writes
  `app_settings.viewPreferences.holding` (`settings/actions.ts:72`).
- **Links in:** `PortfolioHoldingsTable` rowHref (`:170`), `AllocationDonut` legend (`:126`),
  `TopMovers` chips (`:47`), `AccountHoldingsTable` rowHref (`:121`), and the ⌘K palette Holdings
  group (`command-index.ts:117`). **Every one of those five filters `holdings.isActive`, so a
  fully-closed position has NO inbound link.**
- **Links out:** exactly three destinations — `/investments` (breadcrumb `page.tsx:89`, footer
  `page.tsx:139`), and `/transactions?q=SYMBOL&from=&to=` per trade row
  (`holding-detail.ts:282-284`) plus "view all trades". Nothing links to `/accounts/[id]`, to sibling
  holdings, or back to where the user came from.

**Interactive inventory**

| element | file:line | intended | verdict |
| --- | --- | --- | --- |
| PositionCard — "Today" (return $ + %) | `src/components/investments/PositionCard.tsx:50-59` | Today's move on the shares held entering the day | **broken** — it is not today. `holding-detail.ts:189-196` computes it from the last two rows in `price_cache`; with prices days old it labels a stale close-to-close move "Today". `detail.quotedOn` exists and is never shown, and there is no Refresh-prices control on this route. |
| Buy/sell trade marks on the price line | `src/components/investments/ScrubChart.tsx:784-794` | Pin every trade onto the price history | **broken** — non-interactive `ReferenceDot`s: no hover, no label, no accessible name, no quantity. `page.tsx:81-83` drops any mark whose `closeCents` is null, and `holding-detail.ts:265` only sets `closeCents` on an EXACT cached close day (no carry-forward, unlike `carriedCloseCents` at `:233-248`). A symbol whose price backfill is narrower than its trade history shows "12 trades" and zero dots. |
| 404 path (unknown symbol / asset type / any thrown error) | `src/app/investments/[assetType]/[symbol]/page.tsx:44-50` | `notFound()` on an unknown holding | **broken** — the bare catch swallows EVERY exception, including a real DB failure inside `holdingRows`/`portfolioRealizedPl`. There is no `not-found.tsx`, `loading.tsx` or `error.tsx` anywhere under `src/app` (verified by find), so the result is Next's default 404 with no breadcrumb and no route back. |
| "fetch 2 years of closes" button | `src/components/investments/BenchmarkPicker.tsx:109-116` | Backfill price history for a benchmark with no cached closes | **broken** — `pick(value)` with the already-active symbol → `setBenchmarkAction` (`actions.ts:107`) `revalidatePath("/investments")` ONLY (`actions.ts:131`), which does not cover this route, then `router.push(hrefFor(value))` targets the URL the user is already on. The closes land in `price_cache` but the overlay and the "No price history for X yet" line can stay exactly as they were. |
| Focus dialog content region | `src/components/charts/ChartFocus.tsx:169` | Render the SAME panel taller (`h-[55vh]`) | **missing-state** — unlike /investments, which passes `PortfolioStats` as ChartFocus's `footer` (`page.tsx:164` → `PortfolioChartPanel.tsx:308`, pinned by `zz-investments.spec.ts:93`), `PositionCard` is a sibling OUTSIDE `ChartFocus` (`page.tsx:128`). Opening focus hides quantity, market value, avg cost, total return and XIRR. |
| Chart plot — drag-to-zoom brush | `src/components/investments/ScrubChart.tsx:436-459` | Drag past `SELECT_DRAG_PX` to zoom into a custom window | **missing-state** — the custom window is local `ScrubChart` state, not lifted; toggling the lens to Table drops it back to the range pill (`ScrubTable.tsx:27-29`) with no notice, and it is never in the URL. |
| Chart range pills 1M / 3M / YTD / 1Y / ALL | `src/components/investments/ScrubChart.tsx:878-883` + `ChartRangePills.tsx` | Select the visible window; shared with the focus modal | **missing-state** — the only view state NOT in the URL on this route. `/investments` reads `?range=` (`page.tsx:56`); the holding page never reads a range param and hardcodes `defaultRange="ALL"` (`HoldingChartPanel.tsx:269`). "AAPL over 3 months" is unshareable and resets on every navigation. |
| Table lens — day rows (newest first) | `src/components/charts/ScrubTable.tsx:109-113,156` | Raw numbers behind the line | **missing-state** — unpaginated. ALL range for a two-year holding is 700+ DOM rows on a phone, and the rows are entirely non-interactive — a day with a trade cannot be opened. |
| PositionCard — Quantity | `src/components/investments/PositionCard.tsx:39-41` | Aggregated shares across active legs | **missing-state** — a fully-closed position renders "0" with no "Closed position" treatment (`holding-detail.ts:176-177` sums only isActive legs). |
| PositionCard — Market value | `src/components/investments/PositionCard.tsx:42` | qty × latest close | **missing-state** — no as-of date. `detail.quotedOn` is computed (`holding-detail.ts:299`) and rendered by nothing (verified by grep across `src/`). |
| "View all N trades in the ledger →" | `src/components/investments/HoldingEventsList.tsx:75-82` | Escape hatch past the 40-row cap | **missing-state** — gated on `hidden > 0`. A holding with ≤40 trades has no card-level route to its ledger rows at all. |
| Pre-chart fallback card | `src/app/investments/[assetType]/[symbol]/page.tsx:120-126` | Explain why no chart when <2 cached price days | **missing-state** — replaces the WHOLE panel, removing the lens switcher, the Return view and the table even when `detail.returnDays` is chartable. No action: no Refresh prices, no link to fetch history. |
| Keyboard shortcuts on this route | `src/components/shell/KeyScopeProvider.tsx` (no consumer on this page) | Per-surface mnemonics like ReviewInbox's `r` or the ledger's `x` | **missing-state** — this route registers no key scope at all. No shortcut to flip Price⇄Return, toggle the lens, or open focus. |
| Asset-type pill (Stock / ETF / Crypto) | `src/app/investments/[assetType]/[symbol]/page.tsx:94-96` | Classify the holding | **undiscoverable** — styled as a rounded chip identical to the app's interactive pills but is an inert `<span>`. Nothing filters by asset type from here. |
| Breadcrumb "Investments" link | `src/app/investments/[assetType]/[symbol]/page.tsx:89` | Return to the portfolio index | **confusing** — hardcoded to `/investments` regardless of entry point. `AccountHoldingsTable.tsx:121` routes here from `/accounts/[id]`; both exits dump the user on the portfolio index. |
| "Focus the Holding chart" button | `src/components/charts/ChartFocus.tsx:119-126` | Expand the chart into a full-width modal | **confusing** — `HoldingChartPanel.tsx:267` passes the literal `label="Holding"`, so the opener announces "Focus the Holding chart" and the dialog "Holding chart — focus view". It names neither the symbol nor the active view, contradicting ChartFocus's own contract at `ChartFocus.tsx:47-49`. |
| ViewSwitcher "Holding chart view" (Price / Return) | `src/components/investments/HoldingChartPanel.tsx:292-300` | Switch per-share price ⇄ flow-adjusted position return; URL + persisted | **confusing** — the preference is persisted for the whole "holding" SURFACE (`investments-view-spec.ts:37`), so leaving one holding on Return silently opens EVERY holding on Return. In Return view no per-share price appears anywhere on the page. |
| Table lens — "Trade" column (Buy / Sell / —) | `src/components/investments/HoldingChartPanel.tsx:243-261` | Name a trade day in rows since the plot pins it as a dot | **confusing** — built from `markByDay` over the ALREADY-FILTERED marks prop, inheriting the dropped-trade problem and disagreeing with the Trade history card below. |
| Avg-cost reference line + "Avg cost" label | `src/components/investments/ScrubChart.tsx:646-653` | Show where break-even sits against the price line | **confusing** — the label prints the words "Avg cost" with no number, and `detail.avgCostLineCents` is a quantity-weighted blend across accounts that the page never states, nor the total cost basis it implies. |
| Return stats strip — Best day / Worst day / Max drawdown | `src/components/investments/ReturnViewParts.tsx:259-290` | Characterize the return series | **confusing** — computed over the FULL series (`ReturnViewParts.tsx:89` `returnStats(returnDays)`) but rendered under a chart the user just filtered to 1M (`HoldingChartPanel.tsx:373`). Nothing says these ignore the range pill. |
| Decomposition bar (Value = contributions + market gains) | `src/components/investments/ReturnViewParts.tsx:300-346` | Reconcile value into capital vs P/L | **confusing** — same all-time-under-a-windowed-chart problem (`:143-146`). Also `role="img"` with a good aria-label but zero interactivity. |
| PositionCard — Avg cost / share | `src/components/investments/PositionCard.tsx:43-49` | Weighted broker basis per share | **confusing** — the total cost basis (`detail.costCents`, `holding-detail.ts:201-204`) is computed and thrown away, so "Total return +$1,204" is shown without its denominator. |
| PositionCard — Total return ($ + %) | `src/components/investments/PositionCard.tsx:60-69` | Unrealized P/L on cost-bearing shares only | **confusing** — correctly computed (`holding-detail.ts:208-216`) but sits three cards above a Realized P/L card computed from a completely different basis, with nothing warning that the two must not be added. |
| PositionCard — Money-weighted (XIRR) + ≈ marker | `src/components/investments/PositionCard.tsx:70-83` | Annualized growth rate of the dollars, with an inexactness marker | **confusing** — explained only by a `title=` tooltip, which does not exist on touch. |
| Trade history rows → `/transactions?q=SYM&from=&to=` | `src/components/investments/HoldingEventsList.tsx:61-67` + `holding-detail.ts:282-284` | Open the source ledger rows for that trade day | **confusing** — `holding-detail.ts:268-269` drops the account filter unless the symbol has exactly one leg, so on a multi-account holding the link searches every account. Crypto rows (`linkEvents=false`, `:272`) render as inert divs that look identical to linked ones. |
| Chart plot — desktop hover-to-inspect | `src/components/investments/ScrubChart.tsx:444-448` | Hover moves the hairline (non-vivid path) | **confusing** — `vivid=false` here, so no floating ScrubTooltip and no live-today dot; the holding chart is visibly plainer than the dashboard hero for no stated reason. |
| "From date" / "To date" native date inputs | `src/components/investments/ScrubChart.tsx:895-913` | Type an exact window | **confusing** — `applyWindow` silently returns when the range holds fewer than 2 points (`:403`); the input keeps the typed value and nothing says why the chart did not move. |
| Peak / trough extreme dots + labels (Return view only) | `src/components/investments/ScrubChart.tsx:762-783` | Call out the window's best and worst point | **confusing** — `showExtremes={isReturns}` (`HoldingChartPanel.tsx:360`), so the PRICE chart, where a 52-week high/low is the most-expected annotation in the category, has none. |
| PositionCard — Portfolio diversity % | `src/components/investments/PositionCard.tsx:84-86` | This holding's share of total priced portfolio value | **dead-end** — the most expensive number on the page: `holding-detail.ts:219` calls `holdingRows(db)`, which runs `portfolioRealizedPl` plus one 30-close query per active holding. And it is not clickable. |
| PositionCard — "By account" leg list | `src/components/investments/PositionCard.tsx:89-104` | Split the position across accounts | **dead-end** — account names are plain text with no link to `/accounts/[id]` even though `leg.accountId` is right there (`holding-detail.ts:314`), and it only renders when `legs.length > 1`, so a single-account holding never names its brokerage. |
| Realized sale rows (qty, day, proceeds − basis, gain) | `src/components/investments/RealizedSalesList.tsx:43-69` | Drill down into every sell | **dead-end** — entirely non-interactive: no link to the ledger rows for that sale, no account attribution (though the walk is deliberately per-account, `holding-detail.ts:249-256`), and the "clamped"/"≈" explanations are `title=` tooltips. |
| Realized "N earlier sells not shown" | `src/components/investments/RealizedSalesList.tsx:71-73` | Honest truncation notice at `SALES_SHOWN=40` | **dead-end** — unlike the trade-history card it offers no "view all"; the earlier sells are unreachable in the UI. |
| Account name in the position card | `src/components/investments/PositionCard.tsx:89-104` | Say which account holds the legs | **dead-end** — see above; `holdingDetail` returns `accountId` on the leg and the UI ignores it. |
| Breadcrumb current item (symbol) | `src/app/investments/[assetType]/[symbol]/page.tsx:89` | `aria-current` page marker | sensible |
| h1 symbol | `src/app/investments/[assetType]/[symbol]/page.tsx:93` | Name the holding | sensible |
| Security display name | `src/app/investments/[assetType]/[symbol]/page.tsx:98` | Human name from the trade description | sensible — but sourced from an unindexed leading-wildcard `LIKE '%(SYM)%'` over the whole transactions table (`holding-detail.ts:117-123`). |
| Focus dialog — Escape to close | `src/components/charts/ChartFocus.tsx:132-140` | Native dialog close + focus return to opener | sensible |
| Focus dialog — backdrop click to close | `src/components/charts/ChartFocus.tsx:141-148` | Click-outside dismiss, guarded so a drag released over the backdrop does not close | sensible |
| Focus dialog — "Close focus view" button | `src/components/charts/ChartFocus.tsx:160-167` | Dismiss with the view-transition morph | sensible |
| Benchmark `<select>` | `src/components/investments/BenchmarkPicker.tsx:77-99` | Pick the Return-view comparison index | sensible — but only rendered when `canShowReturns && isReturns && !isTable` (`HoldingChartPanel.tsx:280`), so "vs the market" is undiscoverable from the default Price view. |
| Benchmark "Custom…" option → ticker text input | `src/components/investments/BenchmarkPicker.tsx:61-76` | Type an arbitrary ticker; Enter submits, Escape cancels | sensible |
| Benchmark validation error (`role=alert`) | `src/components/investments/BenchmarkPicker.tsx:101-105` | Surface a rejected ticker with the reason | sensible |
| ViewSwitcher "Return unit" ($ / %) | `src/components/investments/HoldingChartPanel.tsx:284-291` | Switch the return line between cumulative $ P/L and TWR % | sensible |
| ViewSwitcher "Holding lens" (Chart / Table) | `src/components/investments/HoldingChartPanel.tsx:301-307` | Swap the plot for the same windowed rows | sensible |
| Benchmark legend (You / SPY +X% since day) | `src/components/investments/ReturnViewParts.tsx:223-256` | Name the overlay's own basis day, never "all time" | sensible |
| Replay legend ("you'd have $X · $Y ahead/behind") | `src/components/investments/ReturnViewParts.tsx:181-216` | The $-framing counterfactual, incl. an unfundable-withdrawal shortfall | sensible |
| Chart plot — `role="slider"`, pointer press + drag scrub | `src/components/investments/ScrubChart.tsx:416-467, 525-548` | Press-and-move to inspect a day | sensible |
| Chart plot — keyboard scrub (←/→ 1d, ↑/↓ 7d, Home/End) | `src/components/investments/ScrubChart.tsx:370-375` + `src/lib/scrub.ts` | Keyboard-reachable day inspection with `aria-valuetext` | sensible |
| Custom-window "Mar 3 – Apr 9 · Reset" chip | `src/components/investments/ScrubChart.tsx:884-892` | Name the brushed window and clear it | sensible |
| Window baseline dashed reference line | `src/components/investments/ScrubChart.tsx:643-645` | Mark the window's opening value | sensible |
| Benchmark comparison dashed line | `src/components/investments/ScrubChart.tsx:655-667` | Draw SPY's rebased % or the flow-replay $ gain | sensible |
| sr-only figcaption echo of the scrubbed value | `src/components/investments/ScrubChart.tsx:926` | Deterministic readout for AT + tests | sensible |
| Table lens — shared hero header | `src/components/charts/ScrubTable.tsx:153` | Render the panel's OWN `renderHeader`/`summarize` so the table's hero IS the chart's number | sensible |
| Table lens — range pills | `src/components/charts/ScrubTable.tsx:154` | A table that respects a window must be able to change it | sensible |
| Table lens — "Basis" column (exact / carried forward) | `src/components/charts/ScrubTable.tsx:78-84,117` | Never launder a dashed day as an exact number | sensible |
| Realized P/L card header (total + "N sells · at daily closes" + ≈) | `src/components/investments/RealizedSalesList.tsx:32-41` | State the locked-in gain and the method | sensible |
| Crypto truncation notice | `src/components/investments/HoldingEventsList.tsx:83-87` | Explain why crypto trades do not link out | sensible |
| Trade history empty state | `src/components/investments/HoldingEventsList.tsx:25-32` | "No recorded trades for this holding yet." | sensible |
| "← All investments" footer link | `src/app/investments/[assetType]/[symbol]/page.tsx:139-144` | Exit back to the index | sensible — duplicates the breadcrumb; neither knows where the user came from. |

**Good**

1. The four-dimension view model is best-in-class: Price⇄Return, $⇄%, chart⇄table all resolve
   URL > persisted > default (`page.tsx:54-62`) and are shareable links, with only non-defaults in
   the URL. Monarch and Copilot do not let you deep-link a specific framing of a holding.
2. `resetRangeKey` on the Price/Return switch (`HoldingChartPanel.tsx:270` → `ChartFocus.tsx:71-77`).
   The two series are not day-aligned, so carrying "1M" across would show all-time data captioned
   "1M". Fixed AND pinned by an e2e that explains why (`zz-investments.spec.ts:103-134`).
3. The realized walk carries the last close on/before a trade day (`holding-detail.ts:233-248`) and
   keeps a basis book PER ACCOUNT (`:249-256`), with a test naming the wrong blended answer it would
   otherwise produce (`holding-detail.test.ts:143-151`).
4. "Today" credits only the shares held ENTERING the latest quoted day (`holding-detail.ts:182-192`)
   — a same-day buy is a flow, not a gain.
5. Total return compares the value of only the cost-bearing shares against their basis
   (`holding-detail.ts:208-216`) instead of whole-position value minus a partial cost.
6. `carryForwardTo` tags the flat tail `complete:false` (`price-series.ts`) and BOTH lenses name it —
   dashed on the chart, a "Basis: carried forward" column that only appears when there is actually an
   estimated day (`ScrubTable.tsx:78-84,117`).
7. `ScrubTable` renders the panel's OWN `renderHeader` + `summarize` + `formatValue` function objects
   (`ScrubTable.tsx:44-53`), so the table's hero number is literally the number the chart computed.
8. Both Return legends name their own basis day rather than claiming "all time"
   (`ReturnViewParts.tsx:223-256`), and `ReplayLegend` surfaces `shortfallCents` — "couldn't fund $X
   of your withdrawals" (`:209-210`).
9. Realized sales carry per-row "≈" (partial basis) and "clamped" (over-sell from an import gap)
   markers with explanations (`RealizedSalesList.tsx:50-61`).
10. The `holdingReturnDays` flow convention — `flow(t) = value(qty_t, close_t) − value(qty_{t−1},
    close_t)` (`holding-returns.ts:116`) — makes every trade exactly return-neutral without guessing
    an execution price, and truncates a closed position at its final trade (`:86-94`).

**Bad** (ranked)

1. **CRITICAL — The "Today" stat is not today, and the page never states its as-of date.**
   `src/services/holding-detail.ts:189-196` computes `todayReturnCents` from the last TWO rows in
   `price_cache`; `PositionCard.tsx:50` labels that block "Today". `holdingDetail` also computes
   `detail.quotedOn` (`:299`), `detail.latestClose` (`:298`), `detail.priceDayChangeCents` (`:300`)
   and `detail.priceDayChangePct` (`:301`) — a repo-wide grep confirms NONE is rendered by any
   component. With `price_cache` a week old the owner reads "Today +$412.30 (+1.84%)" on his phone
   for a move that happened seven trading days ago, and there is no Refresh-prices control on this
   route (`HoldingActionsMenu` is only on `/investments`, `page.tsx:144`).
2. **HIGH — Any exception in the page's data path renders as a 404, and there is no 404 page.**
   `src/app/investments/[assetType]/[symbol]/page.tsx:44-50` wraps `holdingDetail` in a bare
   try/catch calling `notFound()` on ANY throw. `holdingDetail` calls `holdingRows(db)`
   (`holding-detail.ts:219`) → `portfolioRealizedPl`, a full walk of every holding_event. A bad
   `price_cache` row or an unsafe-integer quantity throws, the owner clicks AAPL and gets Next's
   default "404 | This page could not be found" (no `not-found.tsx`, `loading.tsx` or `error.tsx`
   anywhere under `src/app`). He concludes his position was deleted; the real error is never logged.
3. **HIGH — Trade marks silently vanish when a trade day has no exact cached close.**
   `src/services/holding-detail.ts:265` sets a mark's `closeCents` ONLY when
   `closeByDay.has(e.occurredOn)` — an exact-day lookup with no carry-forward, unlike
   `carriedCloseCents` (`:233-248`) which the realized walk deliberately uses.
   `src/app/investments/[assetType]/[symbol]/page.tsx:81-83` then drops every mark whose `closeCents`
   is null. Result: the Trade history card says "37 trades", the chart shows zero dots, and the table
   lens's Trade column reads "—" on every row (built from the already-filtered marks prop,
   `HoldingChartPanel.tsx:242`). Three surfaces on one page disagree about how many trades exist.
4. **HIGH — Best day / Worst day / Max drawdown / Decomposition are all-time but sit under a windowed
   chart.** `src/components/investments/ReturnViewParts.tsx:89` computes `returnStats(returnDays)` and
   `:143-146` computes `decomposeValue(returnDays)` over the FULL series, ignoring the range pill;
   `HoldingChartPanel.tsx:373-374` renders both directly beneath the chart. Click "1M" on a two-year
   holding: the hero says "+$118.40 · 1M" and immediately below, "Best day +$1,840 · March 3" from 14
   months ago.
5. **HIGH — The holding detail page shows no share price and no cost basis — both computed and
   discarded.** `src/components/investments/PositionCard.tsx:38-87` renders seven stats and neither a
   Price / Last close nor a total cost basis, though `holdingDetail` computes `latestClose` (`:298`)
   and `costCents` (`:201-204`). The `/investments` holdings table DOES have a Price column
   (`PortfolioHoldingsTable.tsx:117-126`), so drilling INTO a holding loses information — and because
   the Return preference is persisted for the whole surface (`investments-view-spec.ts:37`), the app
   can end up in a sticky state where no screen in the detail route states what a share costs.
6. **MEDIUM — Closed positions hold real realized P/L, have zero inbound links, and render as an
   all-zero card.** `holdingDetail` resolves fine for a closed position (`holding-detail.ts:162`), but
   `holdingRows` (`src/services/portfolio.ts:568`), `command-index.ts:99` and by extension
   AllocationDonut/TopMovers/AccountHoldingsTable all filter `isActive`. A GOOG sold last year for a
   $780 gain is reachable only by typing the URL, and when reached `PositionCard.tsx:39-86` prints
   "Quantity 0 · Market value $0.00 · Total return — · Portfolio diversity 0.0%".
7. **MEDIUM — "fetch 2 years of closes" can leave this page stale.** `setBenchmarkAction`
   (`src/app/investments/actions.ts:107-136`) backfills then calls `revalidatePath("/investments")` at
   `:131` — never this route. `BenchmarkPicker.tsx:45` then pushes `hrefFor(symbol)`, which for the
   fetch button (`:109-116`, `pick(value)` with the already-active symbol) is the current URL. The
   action returns ok, the closes are written, and the page can re-render with the same "No price
   history for QQQ yet" line. He presses it again.
8. **MEDIUM — Every exit leads to `/investments`, and account legs are dead text.** Breadcrumb
   (`page.tsx:89`) and footer (`page.tsx:139`) both hardcode `/investments`, while
   `AccountHoldingsTable.tsx:121` routes users here from `/accounts/[id]`.
   `PositionCard.tsx:89-104` renders account NAMES as plain text despite `leg.accountId` being present
   (`holding-detail.ts:314`), and only when `legs.length > 1`.
9. **MEDIUM — Focus mode on a holding hides the position stats — the opposite of the portfolio's own
   contract.** On `/investments`, `PortfolioStats` is ChartFocus's footer (`page.tsx:164` →
   `PortfolioChartPanel.tsx:308`) and `zz-investments.spec.ts:93` asserts "footer parity". Here
   `PositionCard` is a SIBLING of the panel
   (`src/app/investments/[assetType]/[symbol]/page.tsx:128`), outside `ChartFocus`.
10. **MEDIUM — The whole portfolio is recomputed on every render to print one percentage, with no
    loading state.** `src/services/holding-detail.ts:219` calls `holdingRows(db)` solely for
    `diversityPct`; `holdingRows` (`portfolio.ts:554-620`) first runs `portfolioRealizedPl` then one
    30-row `price_cache` query PER active holding. `displayName` (`:117-123`) runs an unindexed
    leading-wildcard LIKE over the whole transactions table, and `page.tsx:70-79` computes
    `portfolioBenchmarkDays` + `benchmarkReturns` + `replayFlows` even in the default Price view.
    better-sqlite3 is synchronous, the route is force-dynamic, and there is no `loading.tsx`.
11. **MEDIUM — Four independent chart controls stack above a short plot on a phone.**
    `src/components/investments/HoldingChartPanel.tsx:279-325` puts the BenchmarkPicker `<select>`,
    the Return-unit switcher, the Price/Return switcher and the Chart/Table lens in one flex-wrap
    `justify-end` row with `pr-9` clearance. At 375px in Return/$ that is a select plus three pill
    groups above an `h-56` plot.
12. **MEDIUM — Realized and unrealized P/L use different cost bases with nothing preventing
    addition.** PositionCard's Total return uses broker `holdings.avgCostCents`
    (`holding-detail.ts:205-216`); `RealizedSalesList`'s total comes from an average-cost walk valued
    at daily CLOSES (`holding-detail.ts:249-256` → `realized-pnl.ts`). "Total return +$1,204" plus
    "Realized P/L +$780" reads as $1,984 and nothing says otherwise
    (`PositionCard.tsx:60-69`, `RealizedSalesList.tsx:32-41`).
13. **LOW — The range pill is the only view state not in the URL on this route, unlike its sibling.**
    `/investments` parses `?range=` (`page.tsx:56`); here
    `src/components/investments/HoldingChartPanel.tsx:269` hardcodes `defaultRange="ALL"` and
    `page.tsx:41-67` never reads a range param.
14. **LOW — Every holding tab is titled "Holding".**
    `src/app/investments/[assetType]/[symbol]/page.tsx:29` exports a static `metadata = { title:
    "Holding" }`; there is no `generateMetadata`.
15. **LOW — The focus modal announces "Holding", not the symbol or the active view.**
    `src/components/investments/HoldingChartPanel.tsx:267` passes `label="Holding"` to `ChartFocus`,
    whose own doc (`ChartFocus.tsx:47-49`) says the label is "the current view's name".
16. **LOW — Asset type in the URL is case-sensitive while the symbol is not.**
    `src/app/investments/[assetType]/[symbol]/page.tsx:46` uppercases the symbol but passes
    `assetType` raw to `isAssetType` (`holding-detail.ts:111-113`), which tests the lowercase
    `ASSET_TYPES` tuple. `/investments/stock/aapl` works; `/investments/Stock/AAPL` 404s.
17. **LOW — Fewer than two cached price days removes the Return view and the table lens too.**
    `src/app/investments/[assetType]/[symbol]/page.tsx:104-126` gates the ENTIRE `HoldingChartPanel`
    on `detail.priceSeries.length >= 2`, and the fallback (`:121-125`) offers only prose.
18. **LOW — The table lens is unpaginated and its rows are inert.**
    `src/components/charts/ScrubTable.tsx:109-113,156` maps every windowed point to a row; nothing
    links anywhere.

**Change** (ranked)

1. **State the price and its as-of date; relabel "Today".** (S) Add a "Last close" stat to
   PositionCard using `detail.latestClose` with `detail.priceDayChangeCents/Pct` beside it, put "as of
   `{formatDayLong(detail.quotedOn)}`" under Market value, change the "Today" label to
   "`{quotedOn}` move" unless `quotedOn === today`, and add a staleness chip. Zero new queries —
   `holding-detail.ts:298-301` already returns all of it.
2. **Show the total cost basis next to Total return.** (S) `detail.costCents`
   (`holding-detail.ts:201-204`) is computed and never rendered; add a "Cost basis" stat so
   "+$1,204 (+11.4%)" has its visible denominator, as a line rather than a `title=`.
3. **Stop turning every error into a 404, and add the missing route states.** (S) In
   `page.tsx:44-50` catch only `UnknownHoldingError` (already exported from
   `holding-detail.ts:32`) and rethrow everything else. Add `src/app/not-found.tsx`,
   `src/app/investments/[assetType]/[symbol]/loading.tsx` (a skeleton matching the card stack), and an
   `error.tsx` with retry.
4. **Carry the close forward for trade marks so no trade disappears.** (S) `holding-detail.ts:265`
   uses an exact-day lookup; reuse the `carriedCloseCents` binary search at `:233-248` and add a
   `carried: true` flag so the mark renders hollow. Keep the `page.tsx:81-83` filter as a last resort,
   and state the dropped count under the chart.
5. **Move PositionCard inside ChartFocus as the panel footer.** (S) Add a `footer?: ReactNode` prop
   mirroring `PortfolioChartPanel.tsx:65-67,308` and pass `<PositionCard detail={detail}/>` from
   `page.tsx:105-119` instead of `:128`.
6. **Make the account legs and the entry context navigable.** (S) Link each leg in
   `PositionCard.tsx:94-101` to `/accounts/{leg.accountId}` (`holding-detail.ts:314`), render the
   single-account case too, and accept an optional `?from=` to render a contextual breadcrumb when
   arriving from `AccountHoldingsTable.tsx:121`.
7. **Put the chart range in the URL, like `/investments` does.** (S) Parse `range` with the same
   `z.enum(CHART_RANGES).catch("ALL")` used at `investments/page.tsx:48,56`, pass it as
   `HoldingChartPanel`'s `defaultRange` (replacing the hardcoded "ALL" at
   `HoldingChartPanel.tsx:269`), and include it in `baseParams`.
8. **Name the page and the focus modal after the actual holding.** (S) Replace the static metadata at
   `page.tsx:29` with `generateMetadata` returning `` `${symbol} · ${ASSET_LABEL[assetType]}` ``, and
   pass a dynamic label to ChartFocus (`HoldingChartPanel.tsx:267`).
9. **Fix the benchmark fetch's stale render.** (S) Add
   `revalidatePath("/investments/[assetType]/[symbol]", "page")` to `setBenchmarkAction`
   (`app/investments/actions.ts:131`), and in `BenchmarkPicker.tsx:45` use `router.refresh()` when
   `hrefFor(symbol)` equals the current URL.
10. **Always offer the ledger escape hatch, and give realized sales one too.** (S)
    `HoldingEventsList.tsx:75` gates "View all N trades" on `hidden > 0` — always render it when
    `allTradesHref` is non-null. Add the equivalent to `RealizedSalesList` (`:71-73`) and make each
    sale row link to `ledgerHref({account, q: symbol, from: s.day, to: s.day})`.
11. **Cap and enrich the table lens.** (S) Cap `ScrubTable.tsx:109-113` at ~120 with a "show all"
    expander (state the truncation in the caption, which already handles `fellBack` honestly at
    `:147-149`), and make trade-day rows link to that day's ledger rows.
12. **Warn that unrealized and realized P/L are not additive.** (S) One line of copy between
    PositionCard and RealizedSalesList (`page.tsx:128-131`) stating the two bases.
13. **Label the Return stats and decomposition as all-time, or window them.** (M) Either pass the
    active range/customWindow down and filter `returnDays` before `returnStats`/`decomposeValue`
    (`ReturnViewParts.tsx:89, 143-146`), or add "· all time" to the `<dt>`s and the caption. Applies
    identically to `PortfolioChartPanel.tsx:306-307`.
14. **Make the trade marks and the avg-cost line inspectable.** (M) Give `ScrubMark` an optional
    label/quantity and render an accessible `<title>` plus a hover readout
    (`ScrubChart.tsx:784-794`), print the actual number in the refLine label (`:646-653`), and set
    `showExtremes` on the PRICE view (`HoldingChartPanel.tsx:360`).
15. **Cut the render cost of the diversity number.** (M) Replace `holdingRows(db)`
    (`holding-detail.ts:219`) with a scalar query summing qty × latest close, scope `displayName`
    (`:117-123`) to the symbol's own account ids with a LIMIT, and gate the bench/replay work at
    `page.tsx:70-79` behind `holdingView.view === "returns"`.
16. **Fit the chart controls on a phone.** (M) Below `sm`, collapse the benchmark picker and the unit
    switcher into a "⋯ chart options" popover (`HoldingChartPanel.tsx:279`), keep only Price/Return
    and Chart/Table inline, and raise the mobile plot height.

**Add** (ranked)

1. **A "My position value" chart mode — qty × close over time.** (S) `holdingReturnDays` already
   returns `navCents` per day (`holding-returns.ts:117`), so
   `returnDays.map(d => ({day: d.day, valueCents: d.navCents}))` is a one-line ScrubPoint series with
   no new query. Today Price is per-share and Return is flow-adjusted; NEITHER answers "what was this
   position worth on March 3?"
2. **Break-even and what-if row under the position stats.** (S) With `avgCostCents` and `latestClose`
   in hand, print distance to break-even in $ and %, the price needed, and the dollar impact of a
   ±1% / ±5% move.
3. **Export the trade history and realized sales.** (S) A "Download CSV" on `HoldingEventsList` and
   `RealizedSalesList` covering ALL rows, not the 40 shown (`EVENTS_SHOWN`,
   `holding-detail.ts:109`; `SALES_SHOWN`, `RealizedSalesList.tsx:18`) — sales past the 40th are
   currently unreachable by any route.
4. **A key scope for this surface.** (S) Register a keyScope (`lib/keyscope.ts`, `PRIORITIES.list`)
   with `v` to flip Price⇄Return, `t` for the lens, `f` for focus, `r` to refresh once that exists —
   matching `ReviewInbox.tsx:108` and `TransactionsLedger.tsx:218`.
5. **Sibling navigation (prev/next holding).** (S) Prev/next chevrons walking the same ordering the
   holdings table used, so an audit sweep does not round-trip through `/investments`.
6. **Refresh prices + Add/update this holding, on this page.** (M) Reuse `RefreshPricesButton.tsx`
   verbatim and `HoldingForm.tsx` pre-filled, as `HoldingActionsMenu.tsx:28-49` does for the
   portfolio. Add a per-symbol backfill (`backfillSymbolHistory` already exists, used by
   `setBenchmarkAction`, `actions.ts:116`) so "no price history" is fixable in place, and extend
   `refreshPricesAction`/`addHoldingAction` (`actions.ts:59-60, 84-85`) to revalidate this route.
7. **Dividends and income for this holding.** (M) `description-key.ts:20-44` already collapses a
   trailing `(TICKER)` plus a brokerage marker into `ticker:SYMBOL:DIV` and splits dividends from DRIP
   reinvestments. Add an Income card with T12M dividends and yield-on-cost, and mark dividend days on
   the price chart.
8. **Per-holding P/L calendar.** (M) `/investments` has a full month-paging calendar with a day sheet
   (`page.tsx:192-197`, `PnlCalendar.tsx`, pinned by `zz-investments.spec.ts:136-150`). Add a
   symbol-scoped variant driven by `holdingReturnDays`.
9. **Compare against another holding (overlay).** (M) `ScrubChart` already supports a full `overlays`
   prop with per-series coverage splitting and tooltip rows (`ScrubChart.tsx:294-322, 669-696`), used
   today only by `DashboardModePanel`. Add a "compare" picker beside the benchmark picker.
10. **Inline ledger rows for this symbol.** (M) Below Trade history, embed the actual rows the deep
    links point at (`ledgerHref({account, q: symbol})`, `holding-detail.ts:336`).
11. **Notes and a target on a holding.** (M) A free-text thesis note plus an optional target/stop
    price for the (assetType, symbol) pair, rendered as a reference line (generalize `refLine` to an
    array).
12. **Ambitious viz: a contributions-vs-value ribbon over time.** (L) Extend `DecompositionBar`
    (`ReturnViewParts.tsx:300-346`) from a single all-time bar into a stacked area over the same day
    axis — net contributed as the base band, market gains/losses above/below. `decomposeValue`
    already produces the exact identity per series; it just needs per-day evaluation, reusing
    ScrubChart's existing stacked-area machinery.

---

## /budgets

**Purpose** — The only surface in the app that turns the owner's reconstructed ledger into a
forward-looking commitment: "I intend to spend $X on Food this month, am I going to make it?" Every
other spending surface is retrospective — `/spending` and `/categories/[id]` describe what happened;
`/budgets` is the one page that grades the current period while there is still time to change
behaviour. Its unit of work is one active budget per (category, period), whose "spent" is guaranteed
to be the exact same number `categorySpending` gives the category page and the transaction list, so a
budget can never drift from the ledger. It currently holds ten monthly budgets covering ~$6,799/mo of
intended spend against ~$5,670 spent so far this month — the single number that answers "am I ok this
month" — and the page never states it.

**Connections**

- **Reads:** `budgetPaceStatuses` (`services/budgets.ts:456`) → `budgetStatuses` (`:153`) →
  `categorySpending` (`services/analytics.ts:453`), the SAME row source (`activeTxnsInRange`,
  `analytics.ts:157`) as `/spending`'s tables and the `/transactions` ledger, and split-aware. The
  expected tail reads `recurringSeriesIdsForCategory` (`analytics.ts:100`) then `projectOccurrences`
  (`services/recurring.ts`) so the tail reconciles to `/recurring` to the cent (`budgets.ts:342`). The
  inline editor reads `budgetGuidanceCents` (`budgets.ts:511`) = 6 trailing full months of
  `categorySpending` expressed at the budget's period length. "Predict budgets" reads `predictBudgets`
  (`services/category-forecast.ts:310`) → `predictBudgetableCategories` (`:284`) → the pure
  `lib/category-forecast.ts` + `lib/projection.ts` engine — the identical engine `/spending` renders
  as its per-category forecast annotation (`app/spending/page.tsx:107`).
- **Writes:** `createBudget`/`updateBudget`/`deactivateBudget` (`budgets.ts:67/89/109`) against the
  `budgets` table (`db/schema/budgets.ts`), guarded by the partial unique index
  `ux_budgets_category_period_active` and `requireBudgetableCategory` (expense-kind, non-archived).
- **Links out:** each row → `/categories/{id}` (`BudgetRow.tsx:77`); each tail series →
  `/recurring/{id}` (`BudgetRow.tsx:148`).
- **Links in:** exactly one — `/categories/[id]`'s Budget card → `/budgets`
  (`services/category-detail.ts:180`, rendered `app/categories/[id]/page.tsx:173`).
- **Not connected:** the dashboard (grep for "budget" in `src/app/page.tsx` and
  `src/services/dashboard.ts` returns nothing), the nav badge (review-count only), and `/spending`'s
  categories table (`SpendingCategoriesTable.tsx` carries spend/share/MoM/forecast but no budget
  column) — so the three surfaces the owner opens daily never mention his budgets.

**Interactive inventory**

| element | file:line | intended | verdict |
| --- | --- | --- | --- |
| "Deactivate" submit button | `src/components/budgets/BudgetRow.tsx:202` | Retire a budget | **broken** — destructive, ~4px from "Edit", no confirmation, no toast, no Undo, full-page redirect. Nothing lists inactive budgets and no reactivate path exists (`isActive` is only ever set false, `services/budgets.ts:112`). Settings→Rules deletes with a lossless Undo snapshot toast (`RulesManager.tsx:84-96`); this does not. |
| Error banner (`role="alert"`) | `src/app/budgets/page.tsx:70` | Surface a failed create/deactivate | **missing-state** — no dismiss control; the message lives in `?error=` so it survives refresh and back-navigation. It renders at the very top while the form that produced it is at the very bottom (`page.tsx:116`). `raw.error` as an array (`?error=a&error=b`) silently renders nothing (`page.tsx:43`). |
| Filled spend segment | `src/components/budgets/BudgetRow.tsx:99` | Show fraction of budget consumed | **missing-state** — `clampPct` pins it at 100% (`:21-23`), so a 108%-over row and a 4,898%-over row are pixel-identical. `aria-valuenow` is the clamped 100 while `aria-valuetext` says 4898% (`:94-95`). |
| Dashed expected-tail segment | `src/components/budgets/BudgetRow.tsx:103` | Show recurring charges still expected before period end | **missing-state** — `aria-hidden`, no legend explaining the dashed style, and it collapses to zero width whenever `spentPct` is already 100 (`tailWidth = max(0, tailEndPct − spentPct)`, `:58`) — it vanishes exactly on the over-budget rows where upcoming bills matter most. |
| "Left / Over by $X" (NumberRoll) | `src/components/budgets/BudgetRow.tsx:180` | Remaining headroom, or the overrun in red | **missing-state** — with net refunds `remainingCents = amount − spent` exceeds the budget itself, so a $600 budget with a $50 net refund renders "Left $650.00" beside "On track · -8% used". Nothing handles negative `spentCents` (`services/budgets.ts:194-195`). |
| Amount `<input>` (create form) | `src/components/budgets/BudgetForm.tsx:27` | Type the budget amount | **missing-state** — `Field` supports `hint` and `error` slots (`ui/Field.tsx:37-42`) and neither is used. No 6-month guidance at creation time even though `budgetGuidanceCents` already exists. |
| "Create budget" submit button | `src/components/budgets/BudgetForm.tsx:30` | Create the budget | **missing-state** — no `useFormStatus` pending state and no client validation; every failure round-trips through `redirect('/budgets?error=…')` (`app/budgets/actions.ts:49`), resetting all three uncontrolled fields. |
| Keyboard shortcuts / KeyScope registration | `src/app/budgets/page.tsx:1` | Per-surface mnemonics like ReviewInbox's `r` and TransactionsLedger's `x` | **missing-state** — no `useKeyScope` anywhere under `src/components/budgets/` or `src/app/budgets/` (verified by grep). Every interactive element is a mouse target. |
| Period navigation / view switcher / chart lens | `src/app/budgets/page.tsx:46` | Time-travel and alternate views, as on every sibling surface | **missing-state** — no `PeriodSelector`, no `ViewSwitcher`, no `ScrubChart`, no `StatCard`, no `Sparkline`, no `Tooltip` (verified by grep). Hard-wired to `todayIso()`; the only major surface with zero view state and zero data visualization beyond a 10px bar. |
| Prediction basis text (`title={forecast.basis}`) | `src/components/budgets/PredictBudgets.tsx:178` | Reveal the full visible-math basis, e.g. "$64.21 expected recurring + $47.78 discretionary" | **undiscoverable** — a native `title` is hover-only: unreachable by touch and by keyboard. The component's own doc comment (`:19`) claims "no predicted number is ever a bare figure"; on mobile every one of them is. |
| Active/Inactive table column headers (Series / Cadence / Avg / Next / Annualized) — *budgets analogue:* section header sort | `src/components/budgets/BudgetRow.tsx:86` (pace headline) | One-glance verdict coloured by PROJECTED pace | **undiscoverable** — no tooltip or affordance explains what "Off pace" measures or how the projection is built. At 4,898% (real DB: Travel) it renders "Over budget by 4798%". |
| "6-mo avg ≈ $X" guide | `src/components/budgets/BudgetAmountEditor.tsx:110` | Anchor the edit to real history | **undiscoverable** — the most valuable number on the page, buried two clicks deep per row. 8 of 10 budgets sit >15% from their own 6-month average (Food −34%, Shopping +79%, Subscriptions +84%, Fees −82%, Travel −78%, Entertainment −79%). Renders nothing at all when guidance is 0, with no explanation (`:108`). |
| "Predict budgets" pill button | `src/components/budgets/PredictBudgets.tsx:81` | Load next-month per-category forecasts and open the review sheet | **confusing** — `predictBudgets` (`services/category-forecast.ts:311-320`) excludes every category that already has an ANY-period active budget and every non-top-level category. On the real DB it returns 3 rows and two are 0%-confidence. There is no path to re-predict the 10 budgets he has. |
| "Create N monthly budget(s)" footer button | `src/components/budgets/PredictBudgets.tsx:97` | Create the checked predictions as budgets | **confusing** — period hardcoded `monthly` (`app/budgets/actions.ts:130`) with no picker, so this flow can never populate the Daily/Weekly/Annual sections. `createBudget` stamps `startsOn: todayIso()` while the sheet copy says the amount forecasts *next* month (`PredictBudgets.tsx:118`). |
| Period section heading + date bounds | `src/app/budgets/page.tsx:89` | Name the period and the window being graded | **confusing** — `formatDayShort` emits no year (`lib/format-date.ts:21-24`), so an Annual section reads "Jan 1 – Dec 31". Bounds are taken from `section.statuses[0]` — correct only because `periodBounds` is a pure function of refDate, an undocumented coupling. |
| Category name link → `/categories/{id}` | `src/components/budgets/BudgetRow.tsx:76` | Drill into the category behind the budget | **confusing** — carries no period params, so `resolvePeriod` falls through to the current calendar month (`lib/period.ts:184-185`). A daily budget's row says "Spent $42" and lands on a page showing $1,200. |
| "Projected ≈ $X" | `src/components/budgets/BudgetRow.tsx:187` | Where the period is heading | **confusing** — no basis, no tooltip, and it disappears entirely for over-budget rows (`:185`). For daily budgets `remainingDays` is always 0 and the tail always empty (`services/budgets.test.ts:643-648`), so it is byte-identical to "Spent". |
| Section header counts ("Total budgeted", "· overlapping child budgets excluded") | `src/app/budgets/page.tsx:95` | State the section's total commitment and warn when a child budget was excluded | **dead-end** — not a link, no counterpart total spent/remaining, and no way to see WHICH budgets were excluded. The only aggregate on the page and it answers the least useful half of the question. |
| EmptyState "No budgets yet" | `src/app/budgets/page.tsx:81` | First-run guidance | **dead-end** — pure text with no control. It says "Create one below" but offers no anchor to the form and no link to "Predict budgets", the actual fastest path from zero. |
| Predicted amount figure | `src/components/budgets/PredictBudgets.tsx:188` | Show the budget that will be created | **dead-end** — not editable. The user can only accept the $10-rounded forecast or skip the row. |
| "also counts toward its parent's budget" note | `src/components/budgets/BudgetRow.tsx:82` | Explain parent/child overlap | **dead-end** — plain text; does not name or link to the parent budget, even though `ancestorCategoryIds` is already on the status object (`services/budgets.ts:141`). |
| Progress bar (`role="progressbar"`) | `src/components/budgets/BudgetRow.tsx:89` | The page's hero visual: spend vs budget with a pace reference | **dead-end** — completely inert: not focusable, no hover, no click, no tooltip, no drill-down. The most prominent element on every row does nothing. |
| "Spent $X" figure | `src/components/budgets/BudgetRow.tsx:170` | The actual, straight from spending analytics | **dead-end** — not a link. `analytics.transactionsHref({categoryId, from, to})` (`analytics.ts:466`) already produces the exact drill-down URL. The headline actual on the budgets page is the one number you cannot open. |
| "Today" tick mark | `src/components/budgets/BudgetRow.tsx:112` | The pace reference — fill left of it means you are ahead | **undiscoverable** — a 2px `aria-hidden` hairline with no label, legend or tooltip; its meaning exists only in a source comment (`:111`). For a daily budget `elapsedFraction` is always exactly 1 (`services/budgets.test.ts:646`), so the tick is permanently at the far right. |
| Category `<select>` (create form) | `src/components/budgets/BudgetForm.tsx:10` | Pick the category to budget | **confusing** — no placeholder option, so the first category is pre-selected and `required` is inert. Subcategories are indented with a single leading space (`" ${c.name}"`), which browsers collapse, and `BudgetableCategory.parentName` (`services/budgets.ts:265`) is never rendered. |
| Prediction row checkbox (one per prediction) | `src/components/budgets/PredictBudgets.tsx:168` | Include/exclude that category from the create batch | sensible — no select-all / select-none; with a fresh DB this is every top-level expense category, one at a time. |
| Prediction row label (whole row is a `<label>`) | `src/components/budgets/PredictBudgets.tsx:166` | Click anywhere on the row to toggle its checkbox | sensible |
| Sheet backdrop / Esc / Close icon | `src/components/ui/Sheet.tsx:103` | Dismiss the prediction sheet | sensible |
| Expected-tail popover trigger ("$6.00 expected before Jul 31") | `src/components/budgets/BudgetRow.tsx:121` | Open the list of contributing recurring series | sensible — correct and well-built, but renders only when `expectedTailCents > 0`: 0 of 10 rows on the real DB at 2026-07-27. |
| Tail popover series links → `/recurring/{id}` | `src/components/budgets/BudgetRow.tsx:147` | Drill from an expected charge to the series that predicts it | sensible |
| "Budget $X" (NumberRoll) | `src/components/budgets/BudgetRow.tsx:176` | Animated display of the target after an inline edit | sensible |
| "Edit" popover trigger | `src/components/budgets/BudgetAmountEditor.tsx:82` | Open the inline amount editor | sensible |
| Amount text input (inline editor) | `src/components/budgets/BudgetAmountEditor.tsx:96` | Type a new budget; Enter saves | sensible — no `$` affordance and no inline invalid styling; a bad parse comes back only as a toast (`:70`). |
| "Use" button (adopt the guide) | `src/components/budgets/BudgetAmountEditor.tsx:113` | One tap to set the amount to the 6-month average | sensible |
| "Cancel" button | `src/components/budgets/BudgetAmountEditor.tsx:126` | Close without saving; draft resets on next open (`:54-60`) | sensible |
| "Save" button | `src/components/budgets/BudgetAmountEditor.tsx:129` | Persist the amount, toast, refresh in place | sensible — double-submit guarded (`:65`) and pending-stated; the best-built control on the surface. |
| Period `<select>` (create form) | `src/components/budgets/BudgetForm.tsx:19` | Pick daily/weekly/monthly/annual | sensible |

**Good**

1. `projectSpend` (`services/budgets.ts:309-318`) extrapolates ONLY the non-recurring remainder, so a
   bill that already posted is never smeared by pace and a bill still to come is counted exactly once
   via the tail. Net-refund categories contribute no negative remainder. Five tests pin it
   (`budgets.test.ts:440-467`).
2. The spentToDate/tail disjointness argument at `services/budgets.ts:463-469` plus the
   `Math.max(s.spentCents, forecast)` floor at `:487` correctly handle a future-dated posting inside
   the current period without double-counting it against its own series
   (`budgets.test.ts:606`).
3. `totalBudgetedCents`/`hasOverlappingChildBudget` (`services/budgets.ts:216-232`) scope the
   parent/child exclusion to the SAME period set rather than globally, so a child budgeted weekly
   under a monthly-budgeted parent is not silently dropped (`budgets.test.ts:326`).
4. `BudgetRow.tsx:50-54` distinguishes "Over budget by 8%" from "108%" — a mistake most commercial
   budgeting apps ship.
5. `budgetTail` (`services/budgets.ts:344-389`) reuses `projectOccurrences`, filters to
   detected|confirmed, and drops money-in occurrences, so the tail agrees with `/recurring` to the
   cent AND drills through to the exact series (`BudgetRow.tsx:147`) — the only place on the page
   where the drill-down contract is honored.
6. `recurringPostedCents` (`services/budgets.ts:397-434`) is split-aware on both legs and excludes
   transfer-linked parts.
7. `PredictBudgets` never pre-checks a 0-confidence prediction (`PredictBudgets.tsx:36-40`) and
   disables Create until something is picked.
8. The progressbar's `aria-valuetext` (`BudgetRow.tsx:64-70`) speaks a complete sentence including the
   projection and the expected tail.
9. `updateBudgetAmountAction` returns `ActionResult` instead of redirecting
   (`app/budgets/actions.ts:57-86`) so the row updates in place with a toast; `save()` guards
   double-submit (`BudgetAmountEditor.tsx:65`) and the draft resets on every open (`:54-60`). This is
   the pattern the create and deactivate paths should have copied.
10. `e2e/zz-budgets.spec.ts` mutates and RESTORES the seed (`86-89`, `128-130`) and scopes the guide
    assertion to the open popover because all three editors are in the DOM (`:74`).

**Bad** (ranked)

1. **HIGH — Deactivate is a one-tap unrecoverable destroy sitting 4px from Edit.**
   `src/components/budgets/BudgetRow.tsx:200-208`, immediately adjacent to the Edit trigger at `:193`:
   `deactivateBudgetAction` fires with no confirmation, no toast, no Undo, and full-page-redirects.
   `deactivateBudget` (`services/budgets.ts:112`) sets `isActive=false`; `budgetStatuses` (`:155`)
   only ever selects `isActive=true`, no code path sets it back, and no screen lists inactive budgets.
   Recreating via the form produces a NEW row with `startsOn=today`. Settings→Rules deletes behind a
   lossless Undo snapshot toast (`RulesManager.tsx:84-96`), and `services/bulk-edit.ts:100-184`
   returns an `UndoPatch` for every bulk mutation. Budgets are the only destructive action in the app
   with neither.
2. **HIGH — `startsOn` is stored and then completely ignored, so "Predict budgets" creates an August
   budget instantly graded against July.** `budgetStatuses` computes `bounds = periodBounds(refDate,
   b.period)` (`src/services/budgets.ts:160-165`) and sums `categorySpending` over the WHOLE period
   with no clamp to `b.startsOn`; `createBudget` stamps `startsOn: todayIso()` (`:77`). On the real DB
   at 2026-07-27 the Predict sheet says "a forecast of your August 2026 spending"
   (`PredictBudgets.tsx:118`) and offers Utilities at $120; accepting it renders "Spent $64.21 of
   $120.00 · 54% used" against July with 4 days left and an 87% elapsed tick. Same for manual
   creation: a Travel budget created today opens at "Over budget by 4798%". `budgetInputSchema`
   already accepts `startsOn` (`:41`) and no UI ever passes it.
3. **HIGH — The page never states total spent, total remaining, or overall pace.**
   `src/app/budgets/page.tsx:95-101` renders exactly one aggregate: "Total budgeted". On the real DB
   that reads $6,799.00 while actual spend against those same ten budgets is $5,670.51 — a number the
   page computes ten times and never sums. `ui/StatCard.tsx` with drill-down hrefs already exists and
   is used on `/spending` and `/investments`.
4. **HIGH — "Spent" — the headline actual on every row — is not clickable.**
   `src/components/budgets/BudgetRow.tsx:170-173` renders `<Money cents={status.spentCents} />` as
   inert text, while `analytics.transactionsHref({categoryId, from: bounds.start, to: bounds.end})`
   (`analytics.ts:466`) already emits the exact URL. Travel reads $2,448.88 against a $50 budget and
   the owner cannot ask "why?" from this page.
5. **HIGH — The category link silently changes the period.**
   `src/components/budgets/BudgetRow.tsx:76-81` links to `/categories/${budget.categoryId}` with no
   `period`/`from`/`to`; `resolvePeriod` falls through to the current calendar month
   (`lib/period.ts:184-185`). A daily Food budget reading "Spent $42.00" lands on a page whose hero
   reads "Spent · July 2026 $444.77". The reciprocal link back
   (`categories/[id]/page.tsx:173` → `/budgets`) also carries nothing.
6. **MEDIUM — Two contradicting status systems.** `computeAlert` (`services/budgets.ts:144-148`)
   fires warn80 at 80% and over at 100%; `computePace` (`:283-287`) fires at-risk only when the
   PROJECTION overruns. `/budgets` renders `pace` (`BudgetRow.tsx:15-19`); `/categories/[id]` renders
   `alert` (`categories/[id]/page.tsx:160-167`). On day 28 of 30 at 85% with a projection landing at
   91%: `/budgets` shows GREEN "On track · 85% used"; the same budget on its category page shows
   AMBER.
7. **MEDIUM — `categoryBudgetRef` shows only ONE of a category's budgets and mislabels which.**
   `budgetStatuses(...).find(s => s.budget.categoryId === categoryId)`
   (`src/services/category-detail.ts:171-180`) takes the first match from a list sorted by
   PERIOD_ORDER daily<weekly<monthly<annual (`budgets.ts:150,202`). Budget Food daily $30 and monthly
   $1,430 and `/categories/[id]` renders the daily one; the $1,430 monthly budget is invisible with no
   hint another exists.
8. **MEDIUM — Net-refund periods render nonsense.** `pct = spentCents / amountCents`
   (`services/budgets.ts:195`) has no floor and nothing guards `spentCents < 0`. A $700 laptop return
   against a $600 monthly Shopping budget renders "On track · -8% used"
   (`src/components/budgets/BudgetRow.tsx:47-60`) beside an empty bar (`:21-23`) and "Left $650.00"
   (`:179-183`). `budgets.test.ts` has no status-level test for negative spend — only `projectSpend`
   is covered (`:459`).
9. **MEDIUM — Extreme overruns print a four-digit percentage against a bar clamped at 100%, and the
   accessible values contradict each other.** Travel budget $50.00, spent $2,448.88, pct 4897.8%.
   `src/components/budgets/BudgetRow.tsx:50-58` renders "Over budget by 4798%"; `spentPct` clamps to
   100 so 108%-over and 4,898%-over are pixel-identical; `aria-valuenow` = 100 while `aria-valuetext`
   embeds "4898% of budget" (`:94-95`).
10. **MEDIUM — The most decision-relevant number on the page is computed on every load and then
    hidden inside a per-row popover.** `src/app/budgets/page.tsx:51-53` eagerly builds a `guidance`
    map calling `budgetGuidanceCents` for every budget (measured 82.3ms for 10 budgets, on top of
    `budgetPaceStatuses` at 76.4ms — ~52% of the page's ~159ms of synchronous better-sqlite3 work is
    popover content nobody asked for). What it hides: Food −34%, Shopping +79%, Subscriptions +84%,
    Fees −82%, Travel −78%, Entertainment −79%. Entertainment reads a serene green "On track · 0%
    used" against a $292.22/month trailing average and a $60 budget.
11. **MEDIUM — Rows are sorted alphabetically, so the emergency is last.** `budgetStatuses` sorts by
    PERIOD_ORDER then `categoryPath.localeCompare` (`src/services/budgets.ts:201-205`) and
    `page.tsx:103` lays them into a grid in that order. On the real DB the worst overrun (Travel,
    4,898%) is the tenth card down on a phone. No sort control, no filter, no "needs attention"
    grouping.
12. **MEDIUM — Create-budget failures round-trip through the URL and wipe the form.**
    `createBudgetAction` catches every error into a string and `redirect('/budgets?error=…')`
    (`src/app/budgets/actions.ts:45-49`); all three form fields are uncontrolled
    (`BudgetForm.tsx:10,19,27`). The banner is off-screen on a phone (the form is the last element,
    `page.tsx:116`), `ui/Field.tsx:37-42` has a per-field `error` slot the form never uses, and
    `listBudgetableCategories` does not mark which categories are already budgeted.
13. **MEDIUM — The prediction basis is reachable only by mouse hover.**
    `src/components/budgets/PredictBudgets.tsx:176-181` puts the basis string in a native `title` on a
    `<span>`. On the real DB two of three predictions come back at 0% confidence with basis "$1,212.61
    discretionary (no recurring bills)" — on the phone the owner sees only the number.
    `ui/Tooltip.tsx` exists and is not used here.
14. **LOW — Daily budgets get a dead pace apparatus that still consumes a third of the row.** For a
    daily budget `totalDays = elapsedDays = 1` and `elapsedFraction = 1`
    (`services/budgets.test.ts:643-646`), so the today-tick is permanently at 100%
    (`BudgetRow.tsx:114-116`) and "Projected ≈ $X" (`src/components/budgets/BudgetRow.tsx:185-190`) is
    byte-identical to "Spent".
15. **LOW — Four of the surface's six buttons bypass the shared Button component.**
    `src/components/budgets/BudgetRow.tsx:202-207` (Deactivate), `BudgetForm.tsx:30-35`,
    `PredictBudgets.tsx:81-89` and `:97-107` hand-roll class strings while
    `BudgetAmountEditor.tsx:126,129` uses `<Button>`. `ui/Button.tsx:16` ships a `destructive` variant
    Deactivate does not use, and neither form button gets `pending` (`:29`).
16. **LOW — `revalidatePath` coverage is inconsistent.** `createPredictedBudgetsAction` revalidates
    "/" (`src/app/budgets/actions.ts:136-139`), which contains no budget UI at all, while none of the
    four actions revalidates `/categories/[id]`, which DOES render a live Budget card
    (`categories/[id]/page.tsx:149-177`).
17. **LOW — Daily / Weekly / Annual sections have zero e2e coverage and zero real usage.**
    `e2e/seed-helpers.ts:340-359` seeds three MONTHLY budgets only, the real DB holds ten monthly
    budgets and nothing else, and the only bulk-creation path hardcodes `monthly`
    (`actions.ts:130`). The weekly ISO-boundary and leap-February bounds logic is unit-tested
    (`budgets.test.ts:216,234`) but has never rendered.

**Change** (ranked)

1. **Put the 6-month guidance delta on the row, not in a popover.** (S) The page already computes
   `budgetGuidanceCents` for every budget on every load (`page.tsx:51-53`). Render it inline next to
   "Budget" as a delta chip — "$1,430 · 34% under your 6-mo avg of $2,155" — with "Use" promoted to a
   one-tap inline button; keep the popover for free-form typing.
2. **Make every number on the row openable.** (S) Wrap "Spent" in a Link to
   `analytics.transactionsHref({categoryId, from: bounds.start, to: bounds.end})`
   (`analytics.ts:466`), add the same bounds as `?from=&to=` to the category link
   (`BudgetRow.tsx:77`) so `resolvePeriod`'s custom branch (`lib/period.ts:165-167`) preserves the
   window, and add a matching `?period=` to the category page's back-link
   (`categories/[id]/page.tsx:173`).
3. **Add a page-level summary strip.** (S) Four `ui/StatCard`s per period set — Budgeted, Spent,
   Left/Over, Projected — each summing the statuses already in hand and each with an href
   drill-down. Keep the existing per-section "Total budgeted" line so nothing is removed.
4. **Rank rows by urgency and let the user re-sort.** (S) Add a `ViewSwitcher` dimension
   `{key:"sort", options:["attention","name","largest","pct"]}` through `lib/view-state.ts` so the
   choice lives in the URL and persists. Default "attention"; `budgetStatuses`' existing alphabetical
   sort (`budgets.ts:201-205`) becomes the "name" option.
5. **Explain the bar.** (S) A small legend under the first section (today-tick, solid fill, dashed
   tail) and an accessible tooltip on the tick via `ui/Tooltip.tsx` ("Day 27 of 31"). Suppress the
   tick for daily budgets where `elapsedFraction === 1` (`BudgetRow.tsx:111`) and relabel "Projected
   ≈" in that case.
6. **Show which budgets were excluded from the total.** (S) Turn "· overlapping child budgets
   excluded" (`page.tsx:99`, `services/budgets.ts:229-232`) into a popover listing the excluded child
   budgets with amounts and links, and badge each excluded row. `ancestorCategoryIds` is already on
   every status (`:141`).
7. **Stop prefetching popover content on every render.** (S) Move `budgetGuidanceCents`
   (`page.tsx:51-53`, 82.3ms) behind a server action the editor calls on open — unless CHANGE #1
   lands, in which case keep it eager because it is then visible on every row.
8. **Make Deactivate confirm-then-Undo, and add an Inactive budgets section.** (M) Convert
   `BudgetRow.tsx:200-208` to a value-returning `ActionResult` returning a snapshot of
   `{categoryId, period, amountCents, startsOn}`, then toast `Deactivated "Food" · Undo` using the
   `RulesManager.tsx:84-96` pattern with a `restoreBudgetAction`. Use
   `<Button variant="destructive" size="sm">` and move it behind a `ui/Menu` overflow. Additively add
   a collapsed "Inactive budgets" section with a Reactivate control.
9. **Honour `startsOn` in the status math, and let Predict budgets start next month.** (M) In
   `budgetStatuses` (`services/budgets.ts:160-165`) clamp the spend window to
   `max(bounds.start, budget.startsOn)` and `min(bounds.end, budget.endsOn ?? bounds.end)`, carry a
   `partialPeriod: true` flag so BudgetRow can caption "partial period — budget started Jul 27", and
   have `createPredictedBudgetsAction` (`actions.ts:130`) pass `startsOn: prediction.targetStart`.
10. **Design the extreme states the bar cannot express.** (M) For pct > 150% print a multiple —
    "4.9× budget" — instead of four digits (`BudgetRow.tsx:53`), add a segmented overflow bar, and
    make `aria-valuenow` and `aria-valuetext` agree (`:94-95`). For negative `spentCents`, floor
    `pct` at 0, cap "Left" at the budget amount, and caption "net refund this period".
11. **Give the create form the same guidance the edit popover has.** (M) Make `BudgetForm` a client
    component that on category+period change calls a `budgetGuidanceAction` and fills `Field`'s `hint`
    slot plus a Use button. Add a disabled placeholder option so `required` becomes real, render
    subcategories as "Food › Dining" using `parentName` (`services/budgets.ts:265`), annotate
    already-budgeted options, add `useFormStatus`, and surface errors through `Field`'s `error` slot
    rather than `?error=`.
12. **Make prediction basis and amount reachable on touch.** (M) Replace the `title` at
    `PredictBudgets.tsx:178` with the real `ui/Tooltip` (or a second line on small viewports), make
    the amount at `:188` an editable `ui/InlineEditableAmount`, and add Select all / Select none plus
    a period picker in the footer.
13. **Reconcile the two status vocabularies.** (M) `BudgetPaceStatus` already carries both `pace` and
    `alert` (`services/budgets.ts:196,446`). Render both on `/budgets` (pace tone as the fill colour
    plus an 80%-threshold tick), give `categories/[id]`'s Budget card the same pace tone
    (`categories/[id]/page.tsx:160-167`), and make `categoryBudgetRef` return ALL of a category's
    budgets instead of `.find()`'s first (`category-detail.ts:172`).

**Add** (ranked)

1. **Period navigation — "did I hit my budget last month?"** (S) Add the existing
   `components/spending/PeriodSelector` and pass its resolved date as `refDate` to
   `budgetPaceStatuses(db, refDate)`. The service is already parameterised and works: run at
   2026-06-10 it returns a complete historical picture ($9,612.80 spent against $6,799.00, two
   at-risk rows, one live tail). Follow with a per-budget 12-month hit-rate strip reusing
   `categoryMonthlyTrend` (`services/category-detail.ts`). The page is hard-wired to `todayIso()`
   (`page.tsx:46`).
2. **Copy-forward and templating.** (S) "Copy last period's budgets", "Duplicate to another period",
   and per-budget "Change period" — `updateBudget`'s `budgetPatchSchema` already accepts `period`
   (`budgets.ts:47`) and no UI ever sends it, so changing monthly→weekly today requires
   deactivate-then-recreate.
3. **Keyboard surface for the list.** (S) Register a `budgets` KeyScope at `PRIORITIES.list`
   (`lib/keyscope.ts`) with `j`/`k`, `e` to open the focused row's editor, `Enter` for the drill-down,
   `g b` as the global chord. Give the progressbar a focusable wrapper the way ScrubChart does.
4. **"Right-size my budgets" — re-predict the budgets that already exist.** (M) `predictBudgets`
   (`services/category-forecast.ts:310-320`) deliberately excludes every already-budgeted category, so
   the feature is structurally incapable of improving an existing budget. Add `repredictBudgets(db)`
   returning `{current, predicted, sixMonthAvg, delta, basis, confidence}` per budget, surfaced in the
   same review sheet with per-row Accept plus "Apply all". 8 of 10 budgets are >15% off their own
   6-month actuals and 5 are >34% off.
5. **Surface budgets on the pages he actually opens.** (M) Three additive wirings on `budgetStatuses`
   (the cheap variant, deliberately separated from `budgetPaceStatuses` for exactly this,
   `budgets.ts:450-455`): a budget-vs-actual column on `/spending`'s `SpendingCategoriesTable`; a
   Budgets card on the dashboard (worst three by pace + the summary strip); an attention count on the
   Budgets nav item when any budget is `over` or `warn80`. `alert === 'warn80'` is computed on every
   status and rendered nowhere.
6. **Per-budget notes, and the rollover decision made explicit.** (M) A `notes` field ("$50 Travel is
   deliberate — Cancun was reimbursed") shown as a row caption, and an explicit per-budget
   `rolloverPolicy: 'none' | 'carry'` defaulting to 'none' so the current doctrine
   (`db/schema/budgets.ts:10-11`) stays the default.
7. **Budget-vs-actual as a real chart, per row and for the page.** (L) Per row: a 12-month bar strip
   with the budget as a reference line (`categoryMonthlyTrend` supplies the data). Page level: a
   stacked budget-vs-actual chart with a chart⇄table lens via `charts/chart-lens.ts` and a
   `ChartFocus` expand. Ambitious variant: a radial burn dial where arc = period elapsed and fill =
   spend. `/budgets` is the only major surface with zero data visualization (verified by grep).
8. **Savings targets and income goals.** (L) `requireBudgetableCategory`
   (`services/budgets.ts:58-60`) hard-rejects any non-expense kind. Add a parallel goals concept —
   monthly savings target against net (income − spend), per-income-category targets against
   `incomeTransactions` (`analytics.ts:439`) — as a fourth section with the same pace bar.
9. **Alert history and a period-close digest.** (L) Record 80%/100% crossings and surface a
   per-budget timeline plus a period-close recap ("June: 6 of 10 budgets met; Housing over by
   $176.70"), all derivable by sweeping `budgetStatuses` across dates.

---

## /recurring

**Purpose** — The owner's "what is already committed" page — the only surface that answers "what
leaves my account no matter what I do this month, and what lands in it." Everything else in MoneyApp
is backward-looking; `/recurring` is the one forward-looking ledger: detected subscriptions, bills,
rent and paychecks with a next-expected date, an expected amount, and an annualized cost — plus the
end-of-month forecast those series drive. For a person on a variable, partly-cash income
(`docs/future-ideas.md:250`) the operative questions are "can I cover rent on the 1st", "what's still
due before my next paycheck", and "which subscription is quietly bleeding me $360/yr".
`/recurring?tab=all` is also the only place in the app that shows annualized cost per merchant, and
the page is the editorial surface for detection itself — confirm/dismiss, override cadence/amount/date,
attach or detach a charge, merge two identities of the same bill.

**Connections**

- **Reads:** `recurring_series` (31 rows in the checked DB, all `status='detected'`),
  `transactions.recurring_series_id` + `series_link_source`, `merchants`, `categories`, `accounts`,
  and — via `forecastCurrentMonth` — `latestBalances` and `bridgedNetWorthSeries`
  (`forecast.ts:326-336`).
- **Writes:** `recurring_series.status | name | user_cadence | user_amount_cents |
  user_next_expected_on | merged_into_id`, and `transactions.recurring_series_id |
  series_link_source='user'` (`recurring-links.ts`). Detection (`detectRecurringSeries`,
  `recurring.ts:348`) also runs automatically after every import (`import/service.ts`) and from the
  Transactions page's "Run categorization".
- **Links in:** dashboard `UpcomingBillsStrip` chips → `/recurring/{seriesId}`
  (`dashboard.ts:152`) and its empty state → `/recurring`; the transaction sheet's "Make recurring"
  (`LinkPanels.tsx:240` → `createSeriesFromTxnAction`); the nav item. The command palette has no
  recurring entities.
- **Links out:** series → `/merchants/{id}` (`SeriesDetail.tsx:127`) and `/categories/{id}` (`:134`).
  **Nothing else — there is NO link from any series to the transactions ledger, because
  `transactions-query.filterConditions` has no `series` filter at all
  (`src/services/transactions-query.ts:47-107`).**
- **Downstream consumers of the same math:** dashboard upcoming bills (`upcomingOccurrences` with a
  transfer filter), `forecast.fixedComponents`, `budgets.budgetTail`,
  `category-forecast.projectRecurringDriven`. An over-projecting series here silently inflates the
  dashboard, the budgets page, and `/spending`.

**Interactive inventory**

| element | file:line | intended | verdict |
| --- | --- | --- | --- |
| Forecast stat tile — "Projected income" | `src/components/recurring/ForecastCard.tsx:26-33` | Sum of positive forecast components for the rest of the month | **broken** — on the checked DB it reads $4,311.57, of which $4,256.07 (98.7%) comes from two series whose last charge was 80 and 25 days ago and which the page's own Calendar tab refuses to project. |
| "30-day net" footer total | `src/components/recurring/UpcomingList.tsx:38-43` | Net of the listed occurrences | **broken** — measured +$8,588.71 in green, of which $10,934.12 comes from 17 occurrences of 11 series the app's own `isSeriesActive()` classifies as inactive. Live-series-only the figure is −$2,345.41. It also mixes salary inflow with bills and includes both legs of internal transfers. |
| Suggestion card — "Not recurring" | `src/components/recurring/AllSeriesView.tsx:85-93` | `setSeriesStatus('dismissed')` | **broken** — destructive, no confirmation, no undo, no toast — AND dismissed series are rendered NOWHERE (`AllSeriesView.tsx:16-18` only renders detected/confirmed; `page.tsx:39` excludes them from the count). |
| Series row — "Dismiss" button | `src/components/recurring/AllSeriesView.tsx:175-183` | Remove a confirmed series | **broken** — sits at the end of every Active row. One misclick permanently removes a confirmed bill from the forecast, the calendar, the upcoming list AND the dashboard. Semantically wrong for the common case too: "End series" exists but only inside the detail page's ⋯ menu (`SeriesDetail.tsx:161-163`). |
| Amount token popover (decimal input, Enter or Save, "Use detected") | `src/components/recurring/CadenceSentence.tsx:275-326` | Override the expected per-charge amount | **broken** — the sign is inferred from the CURRENT effective amount (`const sign = cents < 0 ? -1 : 1`, `:257`). Override a bill to 0 (allowed — `overridesSchema` is `z.number().int().nullable()`, `actions.ts:93`), reopen and enter 20: the bill is saved as +$20.00, flipping into projected INCOME. "Use detected" also never names the detected amount. |
| Amount-history table lens rows | `src/components/recurring/AmountHistoryChart.tsx:91-103` | The same occurrences as numbers, newest first, with a variance column | **broken** — the "vs expected" column computes `abs(amount) − abs(expected)` (`:49`), so paying MORE on a bill renders POSITIVE, inverting the app-wide net-worth-signed convention. It also uses exact equality for "on plan" (`:45`) while the calendar uses a $1/2%/2σ tolerance band (`recurring-calendar.ts:68-79`). Rows are not sortable, not links, and DataTable is unpaginated. |
| "Detect now" submit button | `src/app/recurring/page.tsx:51-58` | Run `detectRecurringSeries` over the whole ledger and refresh | **missing-state** — `detectNowAction` (`actions.ts:38-41`) THROWS AWAY the `DetectionSummary {scannedGroups, created, updated, taggedTransactions}`. No toast, no count, no pending state, no `useFormStatus`, no disabled-while-running. Measured 24ms on the 1,673-row demo DB; the owner's DB is ~12× larger. Double-clicking fires it twice. |
| Tab link "Calendar" (+ count badge) | `src/components/recurring/RecurringTabs.tsx:21-34` | Navigate to `?tab=calendar` | **missing-state** — the badge is `calendarMonth.entryCount` for the CURRENT month, computed server-side (`page.tsx:35,40`), while the calendar's month is client state (`RecurringCalendar.tsx:66`). After paging to August the badge still reports July. |
| Calendar prev/next month IconButtons | `src/components/ui/CalendarGrid.tsx` header via `RecurringCalendar.tsx:105-113` | Page the month via `loadRecurringMonthAction` | **missing-state** — month lives in component `useState` (`RecurringCalendar.tsx:66`), not the URL and not persisted; it resets on every tab switch, back-navigation or refresh, and is unshareable. The transition is wrapped in `startTransition` but nothing renders a pending state, and there is no bound. |
| Suggestion card — "Confirm" (form action) | `src/components/recurring/AllSeriesView.tsx:76-84` | `setSeriesStatus('confirmed')` | **missing-state** — plain `<form action>` returning void: a full navigation with no toast, no undo, no pending state, while the detail page's equivalent uses the value-returning `setSeriesStatusAction` with a toast (`SeriesDetail.tsx:84-93`). With 31 detected series that is 31 separate page navigations; no "confirm all", no multi-select. |
| "Confirm" primary button (detail, detected only) | `src/components/recurring/SeriesDetail.tsx:143-149` | `setSeriesStatusAction('confirmed')` + toast | **missing-state** — no `.catch()` on the promise (`:85`). A rejected server action produces an unhandled rejection and a silent no-op. `LinkPanels.tsx` has 7 `.catch()` handlers for exactly this; all 8 action calls across SeriesDetail/SeriesMembership/CadenceSentence have zero. |
| ⋯ Menu → "Not recurring" | `src/components/recurring/SeriesDetail.tsx:158-160` | Dismiss | **missing-state** — toasts "Dismissed" with no Undo, while the far less consequential detach in the same page DOES offer Undo (`SeriesMembership.tsx:40-49`). |
| ⋯ Menu → "End series" (destructive) | `src/components/recurring/SeriesDetail.tsx:161-163` | Mark the series ended | **missing-state** — flagged `destructive:true` but no confirmation dialog and no undo; the toast is a bare "Series ended". This is the correct verb for "I cancelled Netflix" and it is buried two levels deep while the wrong verb (Dismiss) is a one-click button on the list. |
| Attach search input (debounced 200ms) + close button | `src/components/recurring/SeriesMembership.tsx:181-199` | Search unlinked active rows by description | **missing-state** — with an empty query the search falls back to an amount window around the expected charge (`recurring-detail.ts:308-317`) and the empty result reads "No similar unlinked transactions." with no mention of the amount filter. No date filter, no account filter, no "show all", and the 25-row cap (`ATTACH_LIMIT`) is never disclosed. |
| "Next expected" list (3 rows) | `src/components/recurring/SeriesDetail.tsx:237-249` | Show the next three projected occurrences | **missing-state** — rendered even for an INACTIVE series with no caveat, contradicting the "Inactive" badge two cards above. Rows are inert: no "skip this one", no "mark as paid", no calendar export. |
| Amount-history bar chart + hover tooltip | `src/components/recurring/AmountHistoryChart.tsx:105-154` | Show price creep against a dashed expected line | **missing-state / confusing** — the dashed `ReferenceLine` (`:126-131`) has no label and no legend; no tolerance band is drawn even though the calendar has a formal one; no range pills, no scrub, no focus/expand, no keyboard access to any bar. The only chart in the app with none of the ScrubChart kit (`docs/future-ideas.md:91`, open item #5). |
| Active/Inactive table column headers (Series / Cadence / Avg / Next / Annualized) | `src/components/recurring/AllSeriesView.tsx:117-124` | Label the columns | **undiscoverable** — not sortable. The single most valuable question this table can answer — "what are my most expensive subscriptions?" — requires sorting by Annualized, and the app already has a sortable `DataTable` primitive (`DataTable.tsx:11,193-215`) this table does not use. No filter by kind, no search. |
| Forecast stat tile — "Projected net" | `src/components/recurring/ForecastCard.tsx:42-49` | income + spending; the tfoot proves it sums to the component rows | **confusing** — the identity is honest (`forecast.ts:317-319`) but with the phantom series it reads +$4,063.52 when the live-series answer is roughly −$176.69 — a sign flip rendered in green. |
| Forecast stat tile — "EOM cash" | `src/components/recurring/ForecastCard.tsx:50-57` | Projected checking+savings balance at month end | **confusing** — today's cash + `projectedNet` (`forecast.ts:347`), but `projectedNet` includes credit-card charges while the card-autopay series is deliberately excluded (transfer kind, `forecast.ts:133`). Card spend is subtracted from CASH in the month it was charged; the payment that moves the cash is never modelled. The tile never states the starting cash. |
| Tab link "Upcoming" (+ count badge) | `src/components/recurring/RecurringTabs.tsx:21-34` | Navigate to `?tab=upcoming` | **confusing** — the badge is `upcoming.length` = 35, counting BOTH legs of every internal transfer (10 rows netting $0) and 17 phantom rows from dead series. The three badges (35 / 31 / 19) measure three unrelated things with no unit label. |
| Suggestion card — confidence % chip | `src/components/recurring/AllSeriesView.tsx:71-73` | Show detection confidence | **confusing** — bare percentages from 18% to 100% with no tooltip, no formula, no threshold. `confidence = 0.5·gapConsistency + 0.5·amountScore` (`recurring.ts:172-175`) and none of those inputs are shown anywhere in the UI. |
| Series row — "Avg ± σ" cell | `src/components/recurring/AllSeriesView.tsx:150-163` | Detected mean and stddev | **confusing** — shows `s.amountCentsAvg` (the DETECTED average) while the "Annualized" cell in the same row is computed from the EFFECTIVE amount (`annualizedCentsOf(eff)`, `recurring.ts:583`). A user amount override makes the two cells disagree with no marker. |
| Section header counts ("Suggestions — N to review", "Active N", "Inactive N") | `src/components/recurring/AllSeriesView.tsx:37,106` | Section sizes | **confusing** — the Active/Inactive split applies ONLY to confirmed series. All 11 inactive series in the checked DB are `status='detected'`, so they all sit in Suggestions with no staleness signal. |
| Calendar footer — Posted / Upcoming / N missed | `src/components/recurring/RecurringCalendar.tsx:151-169` | Month totals | **confusing** — "9 missed" is inert red text with no way to see WHICH nine, no filter, no list. `postedNetCents` nets income against bills into one figure labelled only "Posted". |
| Breadcrumb "Recurring" → `/recurring` | `src/components/recurring/SeriesDetail.tsx:97` | Return to the list | **confusing** — hardcoded with no `?tab=`, so a user who drilled in from All or Calendar is dumped on Upcoming. Same defect on "← All recurring" (`:266`), whose label says "All" while its href goes to Upcoming. |
| Status Badge (Detected / Confirmed / Dismissed / Ended) | `src/components/recurring/SeriesDetail.tsx:120` | State readout | **confusing** — a merged-away series gets a full explanatory paragraph with a link (`:169-177`); a dismissed or ended series gets only a neutral grey badge. Nothing says it has been removed from the forecast, the calendar and the upcoming list, or how to restore it. |
| "Inactive" Badge | `src/components/recurring/SeriesDetail.tsx:122-124` | Flag a stale series | **confusing** — states the conclusion but not the evidence: `lastMatchedOn`, `intervalDaysAvg` and `toleranceDays` are all in the payload (`recurring-detail.ts:249-252`) and none is rendered. |
| Category chip link → `/categories/{id}` | `src/components/recurring/SeriesDetail.tsx:133-137` | Close the category chain | **confusing** — derived as the MODAL category of linked rows (`recurring-detail.ts:108-130`), but the UI never says it is modal, so a 60/40 split shows one chip as if definitive. |
| Date token popover (`type=date` input, Save, "Use detected") | `src/components/recurring/CadenceSentence.tsx:193-241` | Override next-expected date | **confusing** — "Use detected" does not say WHAT the detected date is, even though `detectedNextExpectedOn` is in the payload (`recurring-detail.ts:246`) and simply never passed down (`SeriesDetail.tsx:181-193`). Inconsistent with the cadence token 40 lines above. |
| Stat tiles: Annualized / Per charge ±σ / Cadence / Confidence | `src/components/recurring/SeriesDetail.tsx:194-212` | The series' key statistics | **confusing** — "Per charge" renders the EFFECTIVE (override-first) amount with the DETECTED stddev appended (`:199-204`). Four tiles is thin: `lastMatchedOn`, `intervalDaysAvg`, `toleranceDays`, `matchedCount` and `detectedNextExpectedOn` are all shipped (`recurring-detail.ts:245-252`) and rendered nowhere. `recurring.ts:24-26` promises "statistics, not a black box"; the detail page shows four of nine. |
| Merge picker — search input + candidate buttons | `src/components/recurring/SeriesMembership.tsx:328-357` | Choose the series to absorb | **confusing** — each candidate shows only name + kind. No amount, no cadence, no last-charged, no linked count — nothing to distinguish "CHASE CREDIT CRD AUTOPAY" from "PAYMENT THANK YOU-MOBILE" (the two opposite legs of the same transfer, both offered). Candidates are every live series sorted alphabetically (`recurring-detail.ts:217-228`). |
| Forecast component rows (label / type / how computed / amount) | `src/components/recurring/ForecastCard.tsx:93-106` | Show every input that sums to Projected net | **dead-end** — `ForecastComponent` is `{label, kind, cents, detail}` with NO id (`forecast.ts:75-81`), so "Westview Apartments · 1 × $2,150.00 (monthly), next 2026-08-01" cannot be clicked to reach that series. No `overflow-x-auto` wrapper either (unlike `AllSeriesView.tsx:113`). |
| Forecast stat tile — "EOM net worth" | `src/components/recurring/ForecastCard.tsx:58-65` | Bridged latest net worth + projectedNet | **dead-end** — its two inputs (`bridgedNetWorthSeries` latest, `forecast.ts:336`) appear nowhere in "Show the math", which only covers income/spend/net. |
| Upcoming occurrence rows (date · name · kind · amount) | `src/components/recurring/UpcomingList.tsx:24-37` | List the next 30 days of expected charges | **dead-end** — plain `<li>` with no Link: the page's DEFAULT view has zero clickable rows, while the dashboard renders the same data as chips that each link to `/recurring/{seriesId}` (`dashboard.ts:152`, `UpcomingBillsStrip.tsx:46`). No merchant icon, no account. |
| Day-sheet entry link → `/recurring/{seriesId}` | `src/components/recurring/RecurringCalendar.tsx:124-141` | Open the series | **dead-end** — `CalendarEntry` carries `transactionId` for every posted charge (`recurring-calendar.ts:36,142`) and the UI never uses it. A 'missed' entry offers no action either. |
| Linked transaction row (date · description · account · amount) | `src/components/recurring/SeriesMembership.tsx:59-77` | The full membership history of the series | **dead-end** — not a link. `SeriesLinkedTxn.linkSource` is computed and shipped (`recurring-detail.ts:38,199`) and NEVER RENDERED, even though a 'user'-owned row is permanently outside detection's grouping pool (`recurring.ts:377`). Unpaginated; no date grouping, no totals, no anomaly filter. |
| "Show the math" `<details>` disclosure | `src/components/recurring/ForecastCard.tsx:68-74` | Expand the per-component breakdown | sensible |
| Forecast stat tile — "Projected spending" | `src/components/recurring/ForecastCard.tsx:34-41` | Sum of negative components | sensible |
| Tab link "All" (+ count badge) | `src/components/recurring/RecurringTabs.tsx:21-34` | Navigate to `?tab=all` | sensible |
| Suggestion card — series name link | `src/components/recurring/AllSeriesView.tsx:58` | Open `/recurring/{id}` | sensible |
| Series row — name link | `src/components/recurring/AllSeriesView.tsx:142-144` | Open `/recurring/{id}` | sensible — sub-label "{kind} · N matched" is genuinely useful. |
| Calendar day cell buttons (roving tabindex, arrows / Home / End) | `src/components/ui/CalendarGrid.tsx:162-185`, labels from `RecurringCalendar.tsx:78-84` | Focus a day and open its sheet; `aria-label` enumerates every entry | sensible — glyph-plus-color state grammar, per-cell label listing every item in words. |
| Calendar day glyphs and "+N" overflow marker | `src/components/recurring/RecurringCalendar.tsx:91-97` | Up to 4 state glyphs per day, then a count | sensible |
| Calendar Day Sheet (native `<dialog>`, Escape via KeyScope) | `src/components/recurring/RecurringCalendar.tsx:117-146` | List that day's recurring activity | sensible |
| Calendar legend | `src/components/recurring/RecurringCalendar.tsx:178-191` | Decode the four glyphs | sensible |
| Inline-editable series name (H1) | `src/components/recurring/SeriesDetail.tsx:106-116` | Click/Enter to edit, Enter/blur commits, toast+Undo | sensible — best-in-class control on this surface (`useInlineEdit.ts:94-98`). *See `/recurring/[id]` BAD #1 for the identity-fork hazard.* |
| Merchant chip link → `/merchants/{id}` | `src/components/recurring/SeriesDetail.tsx:126-131` | Close the merchant chain | sensible |
| ⋯ "Series actions" Menu → "Confirm" | `src/components/recurring/SeriesDetail.tsx:155-157` | Re-confirm a dismissed/ended series | sensible — correctly hidden for a merged-away series (guarded again in `recurring.ts:493`). |
| Merged-away banner link → target series | `src/components/recurring/SeriesDetail.tsx:169-177` | Explain the merge and link on | sensible — exemplary honesty pattern; propagate to dismissed/ended. |
| Cadence token popover (`role=menu` radio list + "Use detected (monthly)") | `src/components/recurring/CadenceSentence.tsx:123-167` | Override the cadence, or hand it back to detection | sensible — arrow-key cycling, `aria-checked`, and the reset item NAMES the detected value. The model the other two tokens fail to follow. |
| Amount-history lens ViewSwitcher (Chart ⇄ Table) | `src/components/recurring/SeriesDetail.tsx:221-227` | Flip the bars to numbers; URL + persisted per-surface | sensible |
| "Merge another series in" popover trigger | `src/components/recurring/SeriesMembership.tsx:286-294` | Open the merge picker (live series only) | sensible — correctly hidden when candidates are empty (`:282`) and when the series is not live (`SeriesDetail.tsx:256`). |
| Merge confirm step ("Cancel" / "Merge in") | `src/components/recurring/SeriesMembership.tsx:303-325` | Two-step confirmation for an irreversible reshape | **broken** — the confirm exists but the operation is PERMANENT: `mergeSeries` sets the source `status='ended'` with `mergedIntoId` (`recurring-links.ts:174-177`), `setSeriesStatus` then refuses to ever re-confirm it (`recurring.ts:493`), and there is no unmerge action anywhere in the codebase. The success toast (`:278`) offers no Undo. |
| "Find transactions to attach" toggle button | `src/components/recurring/SeriesMembership.tsx:166-177` | Open the attach search panel | sensible — focus returns to the trigger on close (`:101-106`). |
| Attach candidate checkboxes + "Attach N" button | `src/components/recurring/SeriesMembership.tsx:209-236` | Multi-select and attach with an Undo toast | sensible — disabled at zero selection, count shown. No shift-click range select, and no `.catch()`. |
| Linked-row ⋯ Menu → "Not part of this series" | `src/components/recurring/SeriesMembership.tsx:68-73` | Detach one charge, with Undo | sensible — the undo re-attaches by id (`:40-49`); the best destructive-action pattern on the surface, and the one Dismiss and Merge do not follow. |
| Global toast + `a` mnemonic to focus the newest action toast | `src/components/shell/AppShell.tsx:71-76`, `ToastMnemonic.tsx` | Reach Undo from the keyboard | sensible — works for rename/detach/attach; useless for Dismiss/End/Merge because those toasts carry no action. |

**Good**

1. The user-override model is genuinely excellent architecture: `user_cadence` /
   `user_amount_cents` / `user_next_expected_on` shadow detection's own columns, detection keeps
   refining underneath, and `effectiveSeries()` (`recurring.ts:642-651`) reads user-first. Nothing
   else in the app lets a human correct a derived value without destroying the derivation.
2. The editable cadence SENTENCE instead of a form. "charges monthly around the 3rd, about $15.49
   from Chase Freedom" with three dotted-underline tokens (`CadenceSentence.tsx:57-89`) is the single
   most product-feeling control in MoneyApp. `schedulePhrase()` (`labels.ts:81-85`) even switches from
   day-of-month to weekday for weekly/biweekly cadences.
3. `recomputeSeriesStats` as the shared settling point (`recurring.ts:274-320`). Every user link
   action re-derives stats over the FULL tagged set inside the same transaction, so a later detection
   run finds the stored stats already equal to what it would compute. This is why attach/detach/merge
   survive re-detection.
4. The calendar's day-state grammar: glyph carries meaning, color reinforces it, `aria-label`
   enumerates every entry in words (`RecurringCalendar.tsx:28-52,78-84`), and `classifyPostedAmount`
   (`recurring-calendar.ts:68-79`) uses a max($1, 2%, 2σ) band so a naturally-variable bill is not
   flagged amber every month.
5. Merge safety is unusually rigorous: `mergeSeries` refuses an already-merged source, follows the
   target's own merge chain, refuses a non-live target because "the money would silently vanish"
   (`recurring-links.ts:159-166`), and `setSeriesStatus` permanently refuses to re-confirm a merged
   series (`recurring.ts:493`). `resolveMergeTarget` is cycle-guarded.
6. The forecast's components-ARE-the-math contract: totals are derived by summing the visible
   component rows (`forecast.ts:317-319`) and the `<tfoot>` restates the identity
   (`ForecastCard.tsx:108-117`).
7. Detection deliberately never touches a row with `series_link_source='user'` (`recurring.ts:377`) —
   the same ownership shield as `categorization_source='user'`, enforced at the grouping stage.
8. `projectOccurrences` skips overdue occurrences before the window start (`recurring.ts:696`) rather
   than dumping a backlog into the forecast, and `CADENCE_TOLERANCE_DAYS` scales grace with cadence.

**Bad** (ranked)

1. **CRITICAL — The Upcoming tab and the Forecast card project charges from dead series; the Calendar
   tab on the same page refuses to.** `src/services/recurring-calendar.ts:154-155` skips any series
   failing `isSeriesActive()` before projecting forward, with an explicit comment that "a long-dead
   series must not litter the month with 'upcoming' charges it will never make."
   `upcomingOccurrences` (`src/services/recurring.ts:719-723`) and `forecast.fixedComponents`
   (`src/services/forecast.ts:126-130`) select on `status IN ('detected','confirmed')` with NO
   isActive filter. Measured against `data/moneyapp.db` at today=2026-07-27: 11 of 31 series are
   inactive; the Upcoming tab renders 35 rows totalling +$8,588.71 in green, of which 17 rows
   ($10,934.12) come from inactive series — Employer (cash) $1,312.88 ×4 (last charged 2026-07-02,
   cadence weekly), Acme Corp (payroll) $2,943.19 ×2 (last charged 2026-05-08, 80 days ago),
   Sweetgreen, Shell, Spotify, Con Edison, CAPITAL ONE 360 TRANSFER. Live-series-only the 30-day net
   is −$2,345.41. The Forecast card reads Projected income $4,311.57 (98.7% from those two series) and
   Projected net +$4,063.52 instead of roughly −$176.69, while the Calendar tab reports upcoming
   $55.50 for the same month. One page, three mutually contradictory answers, and the two wrong ones
   are the two he sees first. This also propagates to the dashboard, `budgets.budgetTail` and
   `category-forecast.projectRecurringDriven`.
2. **CRITICAL — "Not recurring" and row-level "Dismiss" are one-click, unconfirmed, un-undoable, and
   the dismissed series then vanishes from every screen.**
   `src/components/recurring/AllSeriesView.tsx:85-93` (suggestion cards) and `:175-183` (every Active
   row) post `dismissSeriesAction` directly. `AllSeriesView.tsx:16-18` only renders 'detected' and
   'confirmed', and `page.tsx:39` excludes dismissed/ended from the count, so a dismissed series is
   rendered NOWHERE. Mis-click Dismiss on Westview Apartments ($2,150/mo rent, the largest fixed cost
   in the file): the forecast silently drops $2,150 of committed spend, the dashboard's upcoming-bills
   strip loses it, and the only recovery is typing `/recurring/{uuid}` by hand. The detail page's
   equivalent at least toasts (`SeriesDetail.tsx:158-160`), so the same verb has two different safety
   levels depending on where you click it.
3. **HIGH — Suggestion cards hide the one fact that decides the answer: when the series last actually
   charged.** `SuggestionCard` (`src/components/recurring/AllSeriesView.tsx:53-97`) renders name,
   kind, cadence, approximate amount and confidence%, but not `lastMatchedOn`, `isActive` or
   `matchedCount` — all three present on `SeriesView` (`recurring.ts:516-519`). All 11 inactive series
   in the checked DB are `status='detected'`, so the Active/Inactive split (confirmed-only, `:17-18`)
   never touches them. "Acme Corp (payroll) — Biweekly · about $2,943.19 — 100%" gets confirmed and
   permanently blesses $5,886/mo of phantom income; the 100% figure measures how regular the PAST
   occurrences were, not whether the series is still alive.
4. **HIGH — Merge is irreversible with no unmerge path, and the picker gives you nothing to pick
   with.** `mergeSeries` (`src/services/recurring-links.ts:168-181`) relinks rows, sets the source
   ended with `mergedIntoId`, and there is no inverse function anywhere in `src/`. `setSeriesStatus`
   permanently refuses re-confirmation (`recurring.ts:491-495`). The success toast
   (`SeriesMembership.tsx:278`) carries no Undo, and the picker (`:339-357`) lists every live series
   alphabetically showing only name + kind (`recurring-detail.ts:217-228`). The checked DB contains
   "CHASE CREDIT CRD AUTOPAY" (transfer, −$993.02) and "PAYMENT THANK YOU-MOBILE" (transfer,
   +$993.02) — adjacent in an alphabetical list, indistinguishable in the picker.
5. **HIGH — The default tab has no clickable rows — a strict regression against the dashboard teaser
   that links into it.** `src/components/recurring/UpcomingList.tsx:24-37` renders each occurrence as
   a plain `<li>`. The dashboard renders the SAME `upcomingOccurrences` data as chips linking to
   `/recurring/{seriesId}` (`src/services/dashboard.ts:145-153`, `UpcomingBillsStrip.tsx:46-58`) AND
   filters out transfer-kind occurrences with an explicit comment. `/recurring` does neither, so it
   also shows 10 rows of internal transfers (5 pairs netting exactly $0). `dashboard.ts:20` claims
   "the numbers reconcile with the tab they link to"; they do not.
6. **HIGH — Eight server-action calls on this surface have no `.catch()`.**
   `src/components/recurring/SeriesDetail.tsx:85`, `SeriesMembership.tsx:33,45,145,158,271`, and
   `CadenceSentence.tsx:48` (all three token saves) use `void action().then(...)` with no rejection
   handler; `LinkPanels.tsx` on `/transactions` has 7 `.catch(() => toast(NETWORK_ERROR))` for exactly
   these. On a flaky phone connection "Merge in" fails: popover stays open, no toast, no error —
   indistinguishable from a dead button. He taps again, and if the first call actually succeeded
   server-side the second throws "Series has already been merged".
7. **MEDIUM — "Detect now" discards its own result summary and shows no progress.**
   `detectRecurringSeries` returns `DetectionSummary` (`recurring.ts:192-197`);
   `src/app/recurring/actions.ts:38-41` drops it and returns void, and the button
   (`src/app/recurring/page.tsx:51-58`) has no `useFormStatus`, no disabled state, no spinner.
8. **MEDIUM — The amount override infers direction from the current value, so a bill overridden to $0
   becomes income on the next edit.** `AmountToken` computes `const sign = cents < 0 ? -1 : 1` from
   the current EFFECTIVE amount (`src/components/recurring/CadenceSentence.tsx:255-271`) and commits
   `sign × abs(parsed)`; `overridesSchema` accepts 0 (`actions.ts:93`). Set a bill to 0 (a plausible
   "neutralise this" workaround given there is no pause/skip feature), reopen, enter 20 — the series
   is saved at +$2000 and appears as projected INCOME.
9. **MEDIUM — Two different definitions of "matches the expected amount" render on the same series.**
   The calendar uses a max($1, 2%, 2σ) tolerance band (`recurring-calendar.ts:55-79`); the
   amount-history table uses exact equality (`src/components/recurring/AmountHistoryChart.tsx:44-51`,
   tooltip likewise `:143`). Con Edison expected at $108.62 with σ ≈ $8: a $112.40 charge shows green
   ✓ "paid" on the Calendar tab and "+$3.78" variance on the detail page. The dashed `ReferenceLine`
   (`:126-131`) draws the expected value with no band and no label.
10. **MEDIUM — The "vs expected" column inverts the app's sign convention.**
    `src/components/recurring/AmountHistoryChart.tsx:44-51` renders
    `formatCentsSigned(abs(amount) − abs(expected))`, so paying MORE on an expense produces a
    plus-signed number in an app where + means money in (`docs/schema.md`, `Money.tsx:12`). It escapes
    being catastrophic only because the cell is ink-faint rather than flow-coloured.
11. **MEDIUM — Half the computed series statistics are shipped to the client and never rendered.**
    `lastMatchedOn`, `intervalDaysAvg`, `toleranceDays`, `detectedNextExpectedOn`, `amountCentsAvg`
    and per-row `linkSource` (`recurring-detail.ts:38,199,245-252`) return 0 grep occurrences in
    `SeriesDetail.tsx`/`AllSeriesView.tsx`. Consequences: "Inactive" and "Confidence 18%" are
    unfalsifiable; `DateToken`'s "Use detected" cannot name the detected date while `CadenceToken`
    does (`CadenceSentence.tsx:163`); the owner cannot see which links he made by hand
    (`src/components/recurring/SeriesDetail.tsx:194-212`,
    `src/components/recurring/SeriesMembership.tsx:59-77`).
12. **MEDIUM — "EOM cash" adds credit-card charges to a cash balance while excluding the payment that
    would move it.** `projectedEomCashCents = today's checking+savings + projectedNetCents`
    (`src/services/forecast.ts:325-347`); `projectedNet` includes card-charged spending while the
    autopay series is excluded as transfer-kind (`forecast.ts:133`). $400 of card charges drop EOM
    cash $400 this month even though nothing left checking, and next month's actual autopay is never
    modelled. `src/components/recurring/ForecastCard.tsx:50-57` shows no starting balance, no math
    row, no drill-through.
13. **MEDIUM — There is no way to reach a series' actual transactions, and no way to filter the ledger
    by series at all.** `src/services/transactions-query.ts:47-107` supports account, merchant,
    category and status views — there is no `series` filter. `LinkedTransactions` rows are plain text
    (`src/components/recurring/SeriesMembership.tsx:59-77`), amount-history rows have no `rowHref`,
    and the calendar day sheet links to the series rather than the transaction despite carrying
    `transactionId` (`recurring-calendar.ts:36,142`; `RecurringCalendar.tsx:124`).
14. **MEDIUM — The calendar's month is neither in the URL nor persisted, so it resets constantly and
    the tab badge goes stale.** `src/components/recurring/RecurringCalendar.tsx:66-76` holds the month
    in `useState` while every other lens in the app resolves URL > persisted > default
    (`lib/view-state.ts`), and the badge counts are computed server-side for the current month only
    (`src/app/recurring/page.tsx:35,40`).
15. **LOW — Every page load computes all three tabs' data plus the forecast, whether or not it is
    rendered.** `src/app/recurring/page.tsx:32-35` unconditionally calls `listSeries`,
    `upcomingOccurrences`, `forecastCurrentMonth` and `recurringCalendar`. Measured on the 1,673-row
    demo DB: `forecastCurrentMonth` 112.6ms, `listSeries` 7.5ms, calendar 0.9ms. `listSeries` loads
    every active transaction's `recurring_series_id` into JS to build a count map
    (`src/services/recurring.ts:551-560`) — a full table scan just to render "N matched". Tab switches
    are full navigations, so the 112ms forecast re-runs on every one.
16. **LOW — Confirming 31 detected series requires 31 full page navigations; the owner has confirmed
    zero.** Each Confirm is an individual `<form action>` POST + navigation
    (`src/components/recurring/AllSeriesView.tsx:76-93`) with no toast, no keyboard shortcut, no
    multi-select. 15 of the 31 have confidence ≥ 1.0. Meanwhile status barely matters for money —
    `upcomingOccurrences`, `recurringCalendar` and `fixedComponents` treat 'detected' and 'confirmed'
    identically — so the triage buys nothing visible.
17. **LOW — Breadcrumb and "← All recurring" both drop the tab, and the footer link's label
    contradicts its href.** `src/components/recurring/SeriesDetail.tsx:97,266` both point at bare
    `/recurring`, which `page.tsx:20` resolves to `tab='upcoming'`.
18. **LOW — Dismissed and ended series get no explanation, while merged ones get a good one.**
    `src/components/recurring/SeriesDetail.tsx:118-124,169-177`.
19. **LOW — "9 missed" is a dead number and a missed occurrence has no verbs.**
    `src/components/recurring/RecurringCalendar.tsx:117-146,162-166`: no filter, no list, and in the
    day sheet no "I paid this in cash", no "skip this month", no "attach the charge that covered it".

**Change** (ranked)

1. **Filter `upcomingOccurrences` and `forecast.fixedComponents` by `isSeriesActive`, and show what
   was excluded rather than hiding it.** (M) Add an `activeOnly` option to `upcomingOccurrences`
   (`recurring.ts:714`) applying `isSeriesActive(s, today)` where `recurring-calendar.ts:155` already
   does; same in `forecast.fixedComponents` (`forecast.ts:126-130`). Additive: a collapsed footer
   under `UpcomingList` — "3 series paused (no charge in 78+ days) — $4,240.21 not projected. Show →"
   — expanding into the excluded rows, each linking to its series. Add the same as a component row
   with `cents=0`. Pin the divergence with a unit test asserting the set of series contributing to
   `upcomingOccurrences` equals the set contributing 'upcoming' entries to `recurringCalendar`.
2. **Link everything in the Upcoming tab, and filter transfers the way the dashboard does.** (S) Wrap
   each row in a Link to `/recurring/{seriesId}` (`UpcomingList.tsx:24-37`; `seriesId` is already on
   `SeriesOccurrence`), apply the `kind !== 'transfer'` filter `dashboard.ts:145` uses but keep a
   "Transfers (5 pairs, net $0)" collapsed group, and split the footer into "Due: −$X · Expected in:
   +$Y · Net: $Z" plus the dashboard's "$X due before your next paycheck (Aug 6)" line.
3. **Add `.catch()` + toast to every server-action promise, and pending state to every mutating
   control.** (S) Mirror `LinkPanels.tsx` at `SeriesDetail.tsx:85`,
   `SeriesMembership.tsx:33/45/145/158/271`, `CadenceSentence.tsx:48`; add a `busy` guard so
   double-taps cannot fire a merge twice; give "Detect now" a `useFormStatus` label and surface the
   `DetectionSummary` as a toast by converting `detectNowAction` (`actions.ts:38-41`) to the
   `ActionResult` pattern the rest of the file already uses.
4. **Fix the amount-override sign trap and the two "Use detected" asymmetries.** (S) Derive the sign
   from the series KIND rather than the current cents (`CadenceSentence.tsx:255-271`), or add an
   explicit direction toggle; reject 0 in `overridesSchema` (`actions.ts:93`). Pass
   `detectedNextExpectedOn` (`recurring-detail.ts:246`) and `amountCentsAvg` down so the reset items
   read "Use detected (Aug 1)" and "Use detected ($108.62)" like `:163`.
5. **Reconcile the variance semantics and label the reference line.** (S) Use
   `classifyPostedAmount`'s tolerance (`recurring-calendar.ts:68-79`) in `AMOUNT_COLUMNS`
   (`AmountHistoryChart.tsx:44-51`), draw the band as a shaded region, label the dashed line
   ("expected $108.62"), and change the variance formula to net-worth-signed
   (`r.amountCents − expectedCents`).
6. **Preserve the tab across navigation and put the calendar month in the URL.** (S) Pass `?tab=`
   through `SeriesDetail.tsx:97,266` (the detail page already receives searchParams, `page.tsx:28`,
   and discards everything but `lens`), fix the label/href contradiction, and promote the calendar
   month to `?month=YYYY-MM` resolved server-side (`RecurringCalendar.tsx:66`), which also fixes the
   stale badge.
7. **Paginate or window the linked-transactions list and the amount-history table.** (S)
   `SeriesMembership.tsx:58-77` and `AmountHistoryChart.tsx:92-102` render every row (49 in the demo
   DB; 200+ for a weekly cash-salary series on the real ledger). Show the most recent 20 with "Show
   all N", add a per-row `linkSource` marker, and an "only show amount anomalies" toggle.
8. **Put the evidence on the card: last-charged, matched count, staleness chip.** (M)
   `SuggestionCard` (`AllSeriesView.tsx:53-97`) already receives `lastMatchedOn`, `matchedCount` and
   `isActive`. Render "12 charges · last Jul 3" and a warning chip "No charge in 80 days" when
   `!isActive`; add last-charged to the Active/Inactive tables; on the detail page expand the Stat row
   or add a "Detection evidence" disclosure with `intervalDaysAvg`, `toleranceDays`, `matchedCount`
   and the confidence breakdown (`recurring.ts:172-175`).
9. **Give the forecast components identity so the math table drills through, and explain the two
   orphan tiles.** (M) Add an optional `href` (and `seriesId`/`categoryId`) to `ForecastComponent`
   (`forecast.ts:75-81`) — `fixedComponents` already has the series row at `:126` — and render labels
   as links (`ForecastCard.tsx:95-97`). Add disclosure rows for EOM cash and EOM net worth showing
   their starting values, wrap the table in `overflow-x-auto`, and note when a fixed component came
   from a user override.
10. **Make the All table a real table: sortable, filterable, reusing DataTable.** (M) Port
    `AllSeriesView.tsx:113-133` to `DataTable` (`DataTable.tsx:11,148-155,193-215`) with
    `?sort=annualized&dir=desc` in the URL, plus kind filter chips and a text filter.
11. **Make Dismiss, End and Merge safe.** (L) Convert the two `<form action>` buttons
    (`AllSeriesView.tsx:76-93,175-183`) to `setSeriesStatusAction` with an Undo toast capturing the
    prior status. Add `unmergeSeries`: clear `mergedIntoId`, restore status, move back the rows the
    merge relinked (record the moved ids in `MergeResult`, mirroring `AttachResult.undo` at
    `recurring-links.ts:22-25`). Add a collapsed "Dismissed & ended (N)" section. Enrich merge
    candidates with amount, cadence, last-charged and matched count, ranked by similarity.

**Add** (ranked)

1. **Export the next 90 days as an `.ics` feed / add a single occurrence to the phone calendar.** (S)
   A VEVENT per projected occurrence with the amount in the title — pure formatting over data
   `upcomingOccurrences` already returns, and the owner reads this app on his phone.
2. **Subscription audit view — the "what am I actually paying for" screen.** (M) A fourth tab (or a
   re-sort of All) ranking subscription/bill series by annualized cost
   (`annualizedCents`, `recurring.ts:534-537`), with a sparkline from `amountHistory`
   (`recurring-detail.ts:202-204`), a "price increased 3 times, +18% since Jan 2024" flag comparing
   the first and last thirds, a per-series "cost since first charge", and a total monthly-equivalent
   burn. Every input already exists and the total is never stated anywhere.
3. **A "cancelled / paused / skip this month" vocabulary.** (M) Three additive states: promote
   `ended` to a one-click "I cancelled this" on every row (distinct from "Not recurring"); a
   per-occurrence skip (`recurring_skips` overlay subtracted by `projectOccurrences`, surfaced in the
   calendar day sheet and the Next-expected list); an auto-pause once `isSeriesActive` goes false with
   a one-click "still active, reset next date".
4. **Bulk triage for the suggestion queue.** (M) Multi-select checkboxes with bulk Confirm / Not
   recurring, "Confirm all above 90% confidence", and keyboard triage (j/k, y/n) through the existing
   KeyScope stack at `PRIORITIES.list` — the review inbox already does this (`ReviewInbox.tsx:108`).
   Return an `UndoPatch` the way `bulk-edit.ts:100-184` does.
5. **Series → ledger drill-through (`?series=` filter on `/transactions`).** (M) Add `series` to
   `TxnFilters`/`filterConditions` (`src/services/transactions-query.ts:47-107`) as
   `eq(transactions.recurringSeriesId, id)`, then link the "Linked transactions · N" heading, each
   linked row, each amount-history row, and use the `transactionId` the calendar already carries
   (`recurring-calendar.ts:142`) to open that row's TransactionSheet.
6. **Compare-to-last-month and year-over-year on the calendar and the forecast.** (M) A ghost overlay
   of last month's entries and a "vs last month" delta on each forecast tile; the ghost machinery
   already exists as `reindexByPosition` (`projection.ts:408`) and is used on `/spending`.
7. **Chart parity for the amount-history chart** (roadmap item #5, `docs/future-ideas.md:127`). (M)
   Wrap in `ChartFocus`, add `ChartRangePills` driven by `lib/chart-window`, add keyboard scrub via
   `lib/scrub`, and draw the tolerance band. All five primitives already exist in
   `src/components/charts/` and `src/lib/`.
8. **Notification-grade attention surface: a "needs your attention" band above the tabs.** (M) N
   missed occurrences this month (`recurring-calendar.ts` `missedCount`), N series that just went
   inactive, N amount changes beyond tolerance in the last 30 days, N suggestions awaiting a decision
   — each a filter link, plus a nav badge the way Transactions has one (`SideNav.tsx:34-41`).
9. **Cash-flow calendar view: a running projected balance rail alongside the recurring calendar.** (L)
   The calendar knows every expected in/outflow per day and the app knows today's cash
   (`forecast.ts:325-334`). Render a projected daily balance through month end with the lowest point
   flagged ("tightest day: Aug 2, $412") and negative days marked. "Can I cover rent on the 1st?" is
   the operative question for a variable cash income and the page currently makes him reconstruct it.
10. **Detection tuning surface: "why isn't X detected?" and a manual series builder.** (L) A panel of
    near-miss groups (≥3 occurrences failing `fitCadence` or the CV≤0.2 amount-stability test,
    `recurring.ts:159,166`) with the reason in words and a "make it recurring anyway" button, plus a
    "New series" wizard reusing `createSeriesFromTransaction` and `attachTransactions`.
    `docs/future-ideas.md:250` records that the owner's real Fordham payroll is NOT modelled as a
    series and his projected income was $0.01 for that reason. The page that owns recurring has no way
    to create a recurring.

---

## /recurring/[id]

**Purpose** — The page where the owner argues with the app's guess about a repeating charge.
Detection (`services/recurring.ts:348`) mines the ledger for merchant/description groups with a stable
gap and a stable amount and files them as series; this page is the one place where a human can say
"yes that's my rent", "no that's not recurring", "it's actually $1,150 not $1,046", "these two are the
same subscription", or "that charge isn't part of this". Every edit here is a user override the
forecast reads first (`recurring.ts:642` `effectiveSeries`; `services/forecast.ts:136-137`), so this
page is literally the steering wheel on the end-of-month projection and the 30-day upcoming list.

**Connections**

- **Inbound:** every series name across the app — `/recurring` All tab rows and suggestion cards
  (`AllSeriesView.tsx:58,142`), the calendar day sheet (`RecurringCalendar.tsx:125`), the dashboard's
  upcoming-bills list (`services/dashboard.ts:152`), the budgets recurring tail
  (`services/budgets.ts:384`), the category page's series list (`services/category-detail.ts:155`),
  and a merged-away series' banner (`SeriesDetail.tsx:172`). The `/recurring` Upcoming tab rows are
  NOT links (`UpcomingList.tsx:24-36`) — the default tab is the one place a series name is inert.
- **Reads:** `recurring_series` (all stats + the three `user_*` override columns,
  `schema/recurring.ts:33-50`), its active linked transactions joined to accounts, the whole
  `categories` table (to pick a modal category, `recurring-detail.ts:180-192`), the merchant row, and
  every other live series as merge candidates (`recurring-detail.ts:217-228`).
- **Writes:** `recurring_series.name / status / user_cadence / user_next_expected_on /
  user_amount_cents / merged_into_id`, and `transactions.recurring_series_id + series_link_source` on
  attach/detach/merge (`recurring-links.ts:29,93,136`). Those writes propagate to the month forecast
  (`forecast.ts:126-154`, status detected|confirmed only), the calendar
  (`recurring-calendar.ts:95-97`), `upcomingOccurrences` (`recurring.ts:714-729`), budget tails and
  the dashboard.
- **Outbound:** `/merchants/[id]`, `/categories/[id]`, `/recurring` (twice),
  `/recurring/[mergeTarget]`. There is NO outbound link to a transaction, to `/accounts/[id]`, or to a
  ledger filtered by this series — `services/transactions-query.ts:48-144` has no `series` filter, so
  "show me every charge of this series in the ledger" is unrepresentable in a URL.

**Interactive inventory**

| element | file:line | intended | verdict |
| --- | --- | --- | --- |
| Series-name inline editor (click / Enter / Space → input, Enter or blur commits, Esc cancels) | `src/components/recurring/SeriesDetail.tsx:106-116` | Rename the series to something human | **broken** — for a merchant-less series the name IS detection's identity key (`recurring.ts:402` `name = txns[0].normalizedDescription`, matched at `:408-410`). Renaming silently forks the series on the next Detect now. `renameSeries`'s own docstring claims it "does not affect grouping" (`recurring-detail.ts:365`). |
| Menu item "Not recurring" (dismiss) | `src/components/recurring/SeriesDetail.tsx:158-160` | Mark the pattern as not a series | **broken** — one click, no confirmation, no undo in the toast. Removes the series from the forecast, the calendar and the 30-day upcoming list. It is also offered on a merged-away (already dead) series, flipping its status ended→dismissed while `mergedIntoId` stays set — a state no other code path produces. |
| Menu item "End series" (destructive) | `src/components/recurring/SeriesDetail.tsx:161-163` | Stop projecting this series | **broken** — same: mutates money projections with one click, no confirm, no undo — while detaching a single transaction two cards below DOES get an Undo toast (`SeriesMembership.tsx:40-49`) and merging DOES get a two-step confirm (`:303-325`). The consequence ranking is inverted. |
| Amount token → popover with $ input, Enter-to-commit, Save + "Use detected" | `src/components/recurring/CadenceSentence.tsx:246-329` | Override the expected per-occurrence amount | **broken** — `commit()` calls `close()` unconditionally after the catch (`:270`), so an unparseable entry fires the error toast AND closes the editor, discarding what was typed. The sign is also locked to the current value's sign (`:257`), so an income series can never be overridden negative and vice versa. |
| Stat: "Per charge" with ±σ | `src/components/recurring/SeriesDetail.tsx:198-209` | Expected charge and its historical spread | **broken** — the number is `nextExpectedAmountCents` (the USER override when one exists, `recurring.ts:649`) but the ± is `amountCentsStddev`, the population stddev around the DETECTED mean (`recurring.ts:168`). Overriding rent to $1,150 on a series detected at $1,046 ± 12 renders "$1,150.00 ±12.00". |
| "Next expected" list rows (date + amount) | `src/components/recurring/SeriesDetail.tsx:237-249` | Show the next three projected occurrences | **broken** — rendered regardless of status. `projectOccurrences` (`recurring.ts:687`) has no status filter, so a DISMISSED, ENDED or MERGED-AWAY series still lists three future charges with amounts — money `forecast.ts:130`, `recurring-calendar.ts:96` and `recurring.ts:722` have all deliberately excluded. Rows are inert: no skip, no mark-paid, no calendar export. |
| Table-lens "vs expected" cell verdict "on plan" | `src/components/recurring/AmountHistoryChart.tsx:45-51` | Flag charges that match the expectation | **broken/confusing** — exact-cent equality (`r.amountCents === expectedCents`), while the calendar for the SAME series uses `classifyPostedAmount`'s max($1, 2%, 2σ) band (`recurring-calendar.ts:66-78`). On a variable bill this column reads as drift on every row while the calendar shows all green. |
| "Merge another series in" button → popover | `src/components/recurring/SeriesMembership.tsx:286-294` | Fold a duplicate series into this one | **broken** — irreversible: `mergeSeries` (`recurring-links.ts:176-186`) relinks the source's rows to the target, sets the source `status='ended'` with `mergedIntoId`, and a repo-wide grep shows NO unmerge path exists (`mergedIntoId` is only ever written at `recurring-links.ts:184`). The two-step confirm is the only protection. |
| Attach "Undo" toast action | `src/components/recurring/SeriesMembership.tsx:153-162` | Reverse an accidental attach | **broken** — rolls back by calling `detachFromSeriesAction` per id, which SETS `series_link_source='user'` (`recurring-links.ts:117`). The action already returned a lossless `UndoPatch` (`actions.ts:128`) the client throws away. A never-linked row attached and immediately undone is left permanently user-owned and skipped forever by detection (`recurring.ts:377`). |
| Detach "Undo" toast action | `src/components/recurring/SeriesMembership.tsx:40-49` | Restore a detached charge | **broken** — the inline comment claims "lossless: re-attaching restores the exact link (user-owned either way)" — false for a detection-owned row: it re-attaches via `attachToSeriesAction` which stamps 'user' (`recurring-links.ts:75`). `detachFromSeriesAction` returns the real lossless patch (`actions.ts:143`) and the client ignores it, unlike the transaction sheet which routes every mutation through `offerUndoToast` (`components/transactions/undo-toast.ts:12-27`). |
| Kind avatar (banknote/receipt/repeat/arrow-left-right/tag) | `src/components/recurring/SeriesDetail.tsx:102-104` | Show the series kind at a glance | **missing-state** — decorative only. `kind` drives whether the series is excluded from the forecast (`forecast.ts:135` skips transfer kinds) and which verb the sentence uses, but there is no control anywhere in the app to correct a mis-classified kind. |
| "Confirm" primary button (status=detected only) | `src/components/recurring/SeriesDetail.tsx:142-150` | Promote a detected suggestion to confirmed | **missing-state** — no pending/disabled state; `useTransition`'s `isPending` is discarded at `SeriesDetail.tsx:64` (`const [, startTransition]`). Also duplicated: the same Confirm exists in the ⋯ menu at `:155-157` whenever status!=='confirmed'. |
| Merge confirm "Merge in" / "Cancel" | `src/components/recurring/SeriesMembership.tsx:303-325` | Confirm an irreversible merge | **missing-state** — the sentence says "Its charges move here and it ends" but never says how many charges (the relinked count is only known after the fact, `:278`). No busy state — a double-click fires `mergeSeries` twice, the second throwing "Series has already been merged" (`recurring-links.ts:163`) into a red toast. |
| Attach candidate checkbox rows | `src/components/recurring/SeriesMembership.tsx:209-224` | Multi-select rows to attach | **missing-state** — date, description, amount only. No account, no category, no existing-series indicator — and no "select all", which the ledger's bulk bar has. |
| Attach empty-query fallback list | `src/components/recurring/SeriesMembership.tsx:204-207` | Suggest similar unlinked rows before typing | **missing-state** — with no query the search bands ±15% around the expected amount (`recurring-detail.ts:309-317`) — but ONLY if the series has an expected amount. When it is null the amount conditions are skipped entirely and the panel lists the 25 most recent unlinked rows in the whole ledger, under "No similar unlinked transactions." The band is never stated on screen. |
| Amount-history bars + recharts hover tooltip | `src/components/recurring/AmountHistoryChart.tsx:105-154` | Make price creep visible | **missing-state** — pointer-only: no keyboard scrub (unlike ScrubChart's `role=slider`), no click-through, no range pills, no brush, no focus/expand. Renders ALL occurrences, so a 5-year weekly series is ~260 slivers in a 176px box. |
| Per-row ⋯ menu "Actions for {description}" | `src/components/recurring/SeriesMembership.tsx:68-73` | Row verbs on a linked charge | **missing-state** — exactly one item: "Not part of this series". No open-transaction, no recategorize, no "same charge as…", no split view, while the ledger's row menu and TransactionSheet offer all of that. |
| Linked-transaction list as a whole | `src/components/recurring/SeriesMembership.tsx:57-78` | Full charge history | **missing-state** — unbounded and unpaginated (`recurring-detail.ts:164-178` selects every active linked row with no limit). A 5-year weekly series renders ~260 rows into the RSC payload and the DOM. No sort control, no date filter, no total. |
| Keyboard shortcuts on this surface | `src/components/recurring/SeriesDetail.tsx:52-71` | — | **missing-state** — none registered. Sibling surfaces push KeyScope bindings (ReviewInbox `r`, TransactionsLedger `x`/`escape`); this page — where the owner will chew through dozens of series — has no confirm/dismiss/next-series keys at all. |
| Status Badge (Detected / Confirmed / Dismissed / Ended) | `src/components/recurring/SeriesDetail.tsx:120` | State the series' lifecycle position | **undiscoverable** — no tooltip, no legend, no consequence stated. Nothing says dismissed/ended means "excluded from the forecast, calendar and upcoming list" (`forecast.ts:130`, `recurring-calendar.ts:96`, `recurring.ts:722`). |
| "Inactive" Badge | `src/components/recurring/SeriesDetail.tsx:122-124` | Warn that the series has gone quiet | **undiscoverable** — computed by `isSeriesActive` (`recurring.ts:669-679`). The page shows the verdict but never the input — `lastMatchedOn` is fetched (`recurring-detail.ts:252`) and never rendered. |
| Stat: "Confidence" (rounded %) | `src/components/recurring/SeriesDetail.tsx:211` | State how sure detection is | **undiscoverable** — the doctrine is "statistics, not a black box" (`recurring.ts:24-26`) yet this is exactly a black box: `0.5×gap-consistency + 0.5×amount-score` (`recurring.ts:172-175`) with neither input shown. `intervalDaysAvg`, `toleranceDays` and `amountCentsAvg` are all fetched (`recurring-detail.ts:247-251`) and never rendered. |
| Breadcrumb "Recurring" link | `src/components/recurring/SeriesDetail.tsx:97` | Return to the recurring index | **confusing** — hardcoded `/recurring` = the Upcoming tab, while the main entry points are the All tab (`AllSeriesView.tsx:142`) and the Calendar day sheet (`RecurringCalendar.tsx:125`). `RecurringTabs` hrefs are `/recurring?tab=…` (`RecurringTabs.tsx:23`) so the tab is a real, preservable URL param that is thrown away. |
| Category chip link → `/categories/[id]` | `src/components/recurring/SeriesDetail.tsx:133-137` | Jump to the category page | **confusing** — the chip is the MODAL category of the linked rows (`recurring-detail.ts:108-130`), a derived plurality, not a property of the series. Nothing says so, and the minority is hidden. |
| Stat: "Annualized" | `src/components/recurring/SeriesDetail.tsx:195-197` | Show the yearly cost of this series | **confusing** — rendered with `<Money>` WITHOUT `flow`, so it is unsigned and uncolored: an income series' $27k/yr and a bill's $27k/yr look identical. It is `|amount| × occurrences/year` by CADENCE (`recurring.ts:534-537`), not by the measured `intervalDaysAvg`, and nothing on screen says either. |
| Stat: "Cadence" | `src/components/recurring/SeriesDetail.tsx:210` | Restate the cadence | **confusing** — pure duplication: the cadence is already the first editable token of the sentence above, and this copy is not clickable. |
| Merge search input + candidate list | `src/components/recurring/SeriesMembership.tsx:330-357` | Pick the series to fold in | **confusing** — candidates are EVERY live series in the DB sorted by name (`recurring-detail.ts:217-228`), each row showing only `name` and `KIND_LABEL[kind]` (`:351-352`). No amount, no cadence, no account, no last-charge date. The whole list also ships in the RSC payload on every render whether or not the popover is opened. |
| Attach search input (200ms debounce) | `src/components/recurring/SeriesMembership.tsx:183-190` | Find unlinked rows to attach | **confusing** — results hard-capped at 25 (`recurring-detail.ts:273`) with NO truncation indication and no paging. Future-dated rows are excluded (`recurring-detail.ts:296`) even though `createSeriesFromTransaction` explicitly supports a future seed (`recurring-links.ts:328-342`). |
| Account name in the cadence sentence | `src/components/recurring/CadenceSentence.tsx:87` | Say which account the charge hits | **dead-end** — plain `<span>`. The merchant and category beside it are links; `seriesDetail` does not even return `accountId` (`recurring-detail.ts:150-153` selects only the name), so the link cannot be built without a service change. |
| Table-lens DataTable rows (Date / Amount / vs expected) | `src/components/recurring/AmountHistoryChart.tsx:91-103` | The tooltip's facts, all at once | **dead-end** — `DataTable` supports sortable headers, `rowHref` and `onRowClick` (`DataTable.tsx:26-41`) and this call site uses none of them; the row showing a $40 price jump gives you no way to open that transaction. |
| Table-lens "vs expected" signed delta | `src/components/recurring/AmountHistoryChart.tsx:49` | Show how far off the charge was | **confusing** — `\|amount\| − \|expected\|` rendered with `formatCentsSigned`: on a bill, being charged $10 MORE renders "+$10.00", a leading + that means money-in everywhere else (`Money.tsx:12`). |
| Linked-transaction row (date, description, account, amount) | `src/components/recurring/SeriesMembership.tsx:60-65` | Show the series' actual charges | **dead-end** — not a link, not clickable, no sheet, and no ledger URL filters by series. `linkSource` is selected and typed as "who owns this link" (`recurring-detail.ts:37-38`) and never displayed, and the row shows no paid/paid_different state even though the calendar computes exactly that per charge (`recurring-calendar.ts:66-78`). Cosmetic: `truncate` on an inline `<span>` (`:63`) is a no-op. |
| "← All recurring" footer link | `src/components/recurring/SeriesDetail.tsx:266-268` | Get back after a long scroll | **confusing** — labelled "All recurring" but points at `/recurring`, which renders the Upcoming tab (`page.tsx:20`). |
| Merchant chip link → `/merchants/[id]` | `src/components/recurring/SeriesDetail.tsx:126-131` | Jump to the merchant's learning record | sensible |
| Menu item "Confirm" | `src/components/recurring/SeriesDetail.tsx:155-157` | Confirm from any non-confirmed state | sensible — correctly hidden for a merged-away series (`setSeriesStatus` throws for that case, `recurring.ts:493`). |
| ⋯ "Series actions" menu trigger (arrow keys cycle, Home/End, Tab exits, Esc light-dismisses) | `src/components/recurring/SeriesDetail.tsx:151-165` | House the lifecycle verbs | sensible |
| Merged-into link → `/recurring/[target]` | `src/components/recurring/SeriesDetail.tsx:169-177` | Follow a merged-away series to where its charges live | sensible |
| Cadence token → popover radio menu of 6 cadences + "Use detected (x)" | `src/components/recurring/CadenceSentence.tsx:123-167` | Override the detected cadence, or hand it back | sensible — dotted underline + accent color marks an active override, arrow-key nav follows APG, reset is offered only when overridden. |
| Date token → popover with `<input type=date>` + Save + "Use detected" | `src/components/recurring/CadenceSentence.tsx:172-244` | Override the next expected date | sensible — draft re-syncs on open (`:188-190`) and a calendar-invalid date is rejected at both the zod boundary and the service (`actions.ts:96-99`, `recurring-detail.ts:355`). *Reset item does not name the detected date — see Change #6 on `/recurring`.* |
| Chart⇄Table lens ViewSwitcher | `src/components/recurring/SeriesDetail.tsx:221-227` | Show the amount history as numbers | sensible — URL-shareable (`?lens=table`) and persisted per surface (`hooks/useViewState.ts:40-57`). Note it disappears entirely when `amountHistory<2` (`:215`), so a persisted 'table' preference becomes invisible on sparse series. |
| "Linked transactions · N" heading | `src/components/recurring/SeriesDetail.tsx:253` | Count the series' charges | sensible — the e2e spec keys its assertions off this exact string (`zz-recurring-detail.spec.ts:23-26,48,56`); it is load-bearing. |
| "Find transactions to attach" button | `src/components/recurring/SeriesMembership.tsx:166-177` | Open the attach search | sensible — focus is returned to the trigger on close, guarded against the initial mount (`:101-106`). |
| "Attach N" button | `src/components/recurring/SeriesMembership.tsx:229-236` | Commit the attach | sensible — correctly disabled at zero selection. |
| Attach panel close ✕ | `src/components/recurring/SeriesMembership.tsx:191-198` | Close the search, clear state | sensible |

**Good**

1. The editable cadence sentence is the best idea on the page and one of the best in the app: the
   schedule stated in English with each fact a dotted-underline token that opens an editor, an
   accent-colored token marking an active override, and a "Use detected (monthly)" escape in every
   editor (`CadenceSentence.tsx:60-88, 153-165`).
2. Override columns are a correct architecture: detection keeps writing its own columns while
   `user_cadence` / `user_next_expected_on` / `user_amount_cents` shadow them
   (`schema/recurring.ts:42-46`), read user-first by `effectiveSeries` (`recurring.ts:642-651`) and
   honored by the forecast (`forecast.ts:136-137`). A user edit never fights the next detection run.
3. The merged-away lifecycle is thought through end-to-end: `setSeriesStatus` refuses to re-confirm a
   merged series with a stated reason (`recurring.ts:493-495`), the page hides that menu item
   (`SeriesDetail.tsx:155`), hides every reshaping control via `isLive` (`:256`), and shows a banner
   linking to where the charges went (`:169-177`). Detection forward-maps the dead identity to the
   live target instead of resurrecting it (`recurring.ts:412-422`).
4. Cadence-aware schedule wording: weekly/biweekly render as "on Fridays" and monthly-family as
   "around the 15th" (`labels.ts:76-85`).
5. The date override is validated twice — at the zod action boundary and again inside the service —
   with the reason written down ("a calendar-invalid date would poison every future projection",
   `actions.ts:96-99`, `recurring-detail.ts:353-357`).
6. The projection window is sized off the series' own step so an annual series still yields three
   occurrences instead of zero (`recurring-detail.ts:207-215`).
7. Attach search escapes LIKE wildcards with an explicit ESCAPE clause
   (`recurring-detail.ts:301-306`), matching the ledger's own query hygiene.
8. The lens is a real view dimension, not local state: URL-shareable, persisted, resolved server-side
   URL > persisted > default (`page.tsx:41-46`, `recurring-view-spec.ts`).
9. `AttachPanel` returns focus to its trigger on close, guarded so the initial closed mount doesn't
   steal focus (`SeriesMembership.tsx:99-106`).
10. The e2e spec drives the actual round-trip (detach → count drops → find → attach → count restored,
    `zz-recurring-detail.spec.ts:40-57`) and runs axe on the settled surface.

**Bad** (ranked)

1. **CRITICAL — Renaming a merchant-less series silently forks it on the next "Detect now".**
   Detection identifies a merchant-less group by `(merchantId IS NULL, accountId, name ===
   normalizedDescription)` (`recurring.ts:402, 408-410`). The rename control
   (`src/components/recurring/SeriesDetail.tsx:106-116`) writes an arbitrary name
   (`src/services/recurring-detail.ts:365-376`) and its docstring asserts it "does not affect
   grouping". Rename a cash-deposit series "ATM CASH DEPOSIT" on Chase Checking (confirmed, 30 linked
   charges) to "Paycheck (cash job)": on the next import or Detect now the group matches no existing
   series, a NEW series named "ATM CASH DEPOSIT" is created with `status='detected'`, and `tagGroup`
   (`recurring.ts:389-394`) re-tags all 30 detection-owned rows onto it. The renamed series is left
   with zero linked rows but keeps its stale stats (`recomputeSeriesStats` bails when `analyzeGroup`
   returns null, `recurring.ts:296-297`) — so "Paycheck" shows $1,046/charge and three future
   occurrences with no charges behind it, plus a duplicate suggestion card for the same money. Any
   hand-attached rows stay on the orphan (user-owned, skipped at `recurring.ts:377`), so the history
   is split in two.
2. **HIGH — A dead series (dismissed / ended / merged-away) still advertises "Next expected" money and
   an annualized cost.** `seriesDetail` calls `projectOccurrences` unconditionally
   (`src/services/recurring-detail.ts:211-215`) and `SeriesDetail` renders the card whenever the array
   is non-empty (`src/components/recurring/SeriesDetail.tsx:237-249`, plus Annualized at `:195-197`),
   with no status gate — while `forecast.ts:130`, `recurring-calendar.ts:96` and `recurring.ts:722`
   all filter to detected|confirmed. Merge "NETFLIX.COM" into "Netflix" and the source page shows the
   merged-away banner AND three future $22.99 charges AND "Annualized ~$275.88/yr" — the exact phantom
   money `setSeriesStatus`'s own comment says must never be resurrected (`recurring.ts:490-495`).
3. **HIGH — Attach/detach Undo is lossy and permanently ejects rows from detection, while the lossless
   patch sits unused in the response.** `attachToSeriesAction` and `detachFromSeriesAction` both
   return a server-captured lossless `UndoPatch` (`actions.ts:128, 143`) built from each row's prior
   `recurringSeriesId` AND `seriesLinkSource` (`recurring-links.ts:63-66, 113-115`). Both client
   handlers discard it and hand-roll an inverse from the forward action instead
   (`src/components/recurring/SeriesMembership.tsx:40-49, 153-162`), and both forward actions stamp
   `series_link_source='user'` (`recurring-links.ts:75, 117`). Detach one Spotify charge by mistake
   and immediately Undo: the row is back, but its ownership has flipped detected→user and detection
   now skips it forever (`recurring.ts:377`). The correct primitive exists one directory away
   (`components/transactions/undo-toast.ts:12-27`).
4. **HIGH — Merge is irreversible with no unmerge anywhere, chosen from an unfiltered alphabetical
   list showing only a name.** `mergeSeries` (`src/services/recurring-links.ts:136-190`) relinks every
   active row of the source to the target as user-owned, sets the source ended with `mergedIntoId`, and
   recomputes the target's stats over the union. `mergedIntoId` is written in exactly one place and
   read in seven — no inverse function, no action, no UI. The candidate list
   (`src/components/recurring/SeriesMembership.tsx:243-363`) renders only `name` and
   `KIND_LABEL[kind]` (`:351-352`). Two "Transfer to Savings" series (SoFi and Chase): pick the wrong
   one, read a confirm sentence naming neither the account nor the charge count, and 40 Chase
   transfers are now user-owned rows on the SoFi series with no path back short of hand-written SQL.
5. **HIGH — A series with zero linked charges still displays full statistics and a forecast.**
   `recomputeSeriesStats` deliberately leaves the last good stats in place when the current set is too
   small to analyze (`recurring.ts:296-297`). The detail page has no zero-row branch:
   `LinkedTransactions` renders "No linked transactions yet."
   (`src/components/recurring/SeriesMembership.tsx:53-55`) while the stat block above
   (`src/components/recurring/SeriesDetail.tsx:194-249`) still shows Annualized, Per charge ±σ and
   Confidence, and Next expected still lists three dated amounts.
6. **MEDIUM — The two most consequential buttons on the page have no confirmation and no undo; the
   least consequential one has both.** "End series" and "Not recurring" fire `setSeriesStatusAction`
   on a single menu click (`src/components/recurring/SeriesDetail.tsx:84-93, 151-165`) and immediately
   remove the series from the month forecast, the calendar and the 30-day upcoming list; their toasts
   carry no action (`:91`). Detaching one transaction gets an Undo toast; merging gets a two-step
   confirm. Open the ⋯ menu intending Confirm, arrow one item too far, press Enter — $1,900 of rent
   silently drops out of the projection with a neutral "Dismissed" toast.
7. **MEDIUM — "Per charge" pairs a user-overridden amount with a standard deviation measured around
   the detected mean.** `src/components/recurring/SeriesDetail.tsx:198-209`: the value is
   `effectiveSeries().nextExpectedAmountCents` (`recurring.ts:649`) and the ± is `amountCentsStddev`
   around `amountCentsAvg` (`recurring.ts:163-168, 181-183`). Rent detected at $1,046 ± $12,
   overridden to $1,150, renders "$1,150.00 ±12.00". Nothing distinguishes an overridden value from a
   detected one in the stat block at all — the sentence marks overrides in accent color; the stats do
   not.
8. **MEDIUM — Two different definitions of "the charge matched the expectation" inside one feature.**
   `src/components/recurring/AmountHistoryChart.tsx:36-53` says "on plan" only on exact cent equality;
   `recurring-calendar.ts:56-78` (an exported pure function) classifies the SAME charge against the
   same series using max($1, 2%, 2σ). An electricity bill averaging $142 ± $9 is a green ✓ every month
   on the calendar and shows a signed variance on every single row here.
9. **MEDIUM — Attach search silently truncates at 25 and mislabels its own empty state.**
   `searchAttachCandidates` hard-limits to `ATTACH_LIMIT=25`
   (`src/services/recurring-detail.ts:270-334`, `:273, :332`) with no total returned and no truncation
   notice. With no query it bands ±max(15%, $5) around the expected amount (`:309-317`) — but only
   when the series HAS an expected amount; when it is null the query degenerates to "the 25 most
   recent unlinked active rows in the entire ledger", still rendered under "No similar unlinked
   transactions." when empty (`src/components/recurring/SeriesMembership.tsx:201-224`, `:206`).
10. **MEDIUM — Any failure inside `seriesDetail` renders a 404 "not found".**
    `src/app/recurring/[id]/page.tsx:33-39` wraps the whole read in
    `try { seriesDetail(...) } catch { notFound() }`. Only a genuinely unknown id throws "Unknown
    recurring series" (`recurring-detail.ts:140`); a `DateParseError` from a poisoned date reaching
    `projectOccurrences`, a SQLITE_BUSY while the dev server holds the DB, or a drizzle failure all
    become the same page telling the owner his series does not exist.
11. **MEDIUM — The amount editor closes and discards the draft when parsing fails.** `commit()`
    catches the `MoneyParseError`, toasts, then calls `close()` outside the try/catch
    (`src/components/recurring/CadenceSentence.tsx:263-271`). Type "1 150", press Enter, get a red
    toast, and the popover is gone with what you typed. Every other inline editor
    (`InlineEditableText.tsx:74-78`) keeps the input open and renders the error inline with
    `role="alert"`.
12. **MEDIUM — No pending state on any mutation.** `SeriesDetail` discards `useTransition`'s
    `isPending` (`const [, startTransition]`, `src/components/recurring/SeriesDetail.tsx:63-76`) and
    `useViewState`'s `isPending` (`:65`), and every handler is a bare `void action().then(...)`. On a
    900ms round-trip the owner taps Confirm twice; the same pattern on "Merge in"
    (`SeriesMembership.tsx:317-323`) produces a red "Series has already been merged" on the second tap.
13. **MEDIUM — The attach search panel expands inside the card-header toolbar row.** `AttachPanel`'s
    open state returns a full search card (`src/components/recurring/SeriesMembership.tsx:179-239`)
    rendered as a flex item inside `<div className="flex flex-wrap items-center gap-2">`, itself the
    right-hand side of a `justify-between` header row shared with the h2 and the Merge button
    (`src/components/recurring/SeriesDetail.tsx:252-262`). It has no width class, so the input, the
    64-max-height result list and the Attach button are sized by whatever the flex row leaves over.
14. **LOW — Both "back" affordances land on the wrong tab.**
    `src/components/recurring/SeriesDetail.tsx:97, 266-268` both point at `/recurring`, which
    `page.tsx:20` resolves to `tab='upcoming'`, while the dominant inbound path is the All tab.
15. **LOW — The cadence sentence is ungrammatical for annual series.** The sentence composes
    `CADENCE_LABEL[cadence].toLowerCase()` (`src/components/recurring/CadenceSentence.tsx:124`) and
    `CADENCE_LABEL.annual` is "Annual" (`src/components/recurring/labels.ts:4-11`), producing "charges
    annual around the 12th". Semimonthly is worse: `schedulePhrase` only branches on
    weekday-vs-day-of-month (`labels.ts:76-85`), so a two-days-a-month series is described with a
    single ordinal.
16. **LOW — `linkSource` is fetched, typed and documented — and never rendered.**
    `SeriesLinkedTxn.linkSource` (`recurring-detail.ts:37-38, 171, 200`) is passed into
    `LinkedTransactions` and never displayed (`src/components/recurring/SeriesMembership.tsx:59-76`).
    It is the most consequential invisible fact on the page: a 'user'-owned row is permanently outside
    detection's grouping pool (`recurring.ts:377`).
17. **LOW — Unbounded payload.** `src/services/recurring-detail.ts:164-228`: all active linked rows
    with no limit (`:164-178`), a chart point per row (`:202-204`), and every live series as merge
    candidates whether or not the popover opens (`:217-228`) — plus the whole categories table loaded
    to resolve one modal category (`:180-192`).
18. **LOW — `truncate` on an inline span does nothing.**
    `src/components/recurring/SeriesMembership.tsx:60-65` applies `truncate` to an inline `<span>`
    inside a flex item; overflow does not apply to non-replaced inline boxes, so a long bank descriptor
    wraps to three lines. The attach-candidate list two blocks down gets this right
    (`min-w-0 flex-1 truncate`, `:219`).

**Change** (ranked)

1. **Gate the projection, the annualized cost and the stat block on the series being live.** (S) Wrap
   the Next-expected card and the Annualized stat in `isLive && !isMergedAway`, and for a non-live
   series state the consequence ("Ended — not counted in the forecast, calendar or upcoming list").
   Cheapest correct fix is a `projectionCounts: boolean` on `SeriesDetail` computed beside `isActive`
   (`recurring-detail.ts:253`) so the page never re-derives the status rule `forecast.ts:130` /
   `recurring-calendar.ts:96` / `recurring.ts:722` already share. Add a unit test asserting
   `seriesDetail` on an ended series reports `projectionCounts=false`.
2. **Route detach/attach undo through the existing lossless patch.** (S) Replace the hand-rolled
   inverses at `SeriesMembership.tsx:40-49` and `153-162` with
   `offerUndoToast(title, r.data.undo, onChanged)` from `components/transactions/undo-toast.ts:12`,
   exactly as the transaction sheet's SeriesLinkPanel does. Delete the false "lossless" comment at
   `:39` or make it true.
3. **Give End series / Not recurring the same ceremony as merge, plus undo.** (S) Add the two-step
   confirm the merge popover uses (`SeriesMembership.tsx:303-325`), state the consequence and the
   number affected ("3 projected charges totalling $296.97 will stop being forecast"), and put an Undo
   on the toast calling `setSeriesStatusAction` back to the prior status (already in `data.status` on
   the client).
4. **Preserve the tab on both back links, and add a pending state to every mutation.** (S) Accept
   `?from=all|calendar|upcoming` and build the breadcrumb/footer hrefs from it
   (`SeriesDetail.tsx:97, 266`). Stop discarding `isPending` at `SeriesDetail.tsx:64`, and add a
   `busy` guard to `MergeControl.merge` and `AttachPanel.attach` the way `LinkPanels.tsx:43,63` does.
5. **Keep the amount editor open on a parse error.** (S) Move `close()` inside the success path at
   `CadenceSentence.tsx:263-271` and render the error inline with `role="alert"`, matching
   `InlineEditableText.tsx:74-78`. Allow the sign to be changed (accept a leading − / parentheses
   instead of forcing sign from the current value at `:257`).
6. **Reconcile the table lens's "on plan" with the calendar's noise band.** (S) Replace the exact-cent
   comparison at `AmountHistoryChart.tsx:45` with
   `classifyPostedAmount(amount, expected, stddev)` (`recurring-calendar.ts:66-78`) so one definition
   serves the calendar, the day sheet and this table, and render the variance with an explicit
   direction word for expense series ("$10.00 more than expected").
7. **Fix the cadence sentence's adverbs and the semimonthly case.** (S) Add an adverb map beside
   `CADENCE_LABEL` (`labels.ts:4-11`) for sentence use, and for semimonthly derive both cluster days
   from the linked history (`isDayOfMonthBimodal` already finds them, `recurring.ts:77-91`).
   Distinguish an overridden token in the stat block, not just in the sentence.
8. **Replace the redundant Cadence stat tile.** (S) Swap `SeriesDetail.tsx:210` for "Charges to date"
   (count + total spent) or "Since" (first linked charge date) — both derivable from `linkedTxns` with
   no new query.
9. **Make renaming safe for merchant-less series.** (M) Add a `displayName` column and leave `name` as
   the immutable identity key, with effective-name resolution `displayName ?? name` in
   `listSeries`/`seriesDetail`/calendar/forecast labels. Until that lands, make `renameSeries`
   (`recurring-detail.ts:365-376`) reject or warn when `merchantId IS NULL` and surface a banner:
   "Renaming this series will split it on the next detection run — it has no merchant to group by."
   Fix the false docstring at `:365` either way.
10. **Show the evidence behind Confidence, Inactive and Per charge.** (M) The service already returns
    `intervalDaysAvg`, `toleranceDays`, `amountCentsAvg`, `amountCentsStddev`, `lastMatchedOn` and
    `detectedNextExpectedOn` (`recurring-detail.ts:247-252`) and the page renders none of the first
    five. Add a collapsible "How this was detected" block: median/average gap ±tolerance, amount mean
    ±σ, occurrence count, last matched date, and the confidence formula's two halves
    (`recurring.ts:172-175`). When the amount IS overridden, show the detected value beside it instead
    of a σ measured around a different mean.
11. **Paginate/window the linked list and the amount-history chart.** (M) Add `ChartRangePills`
    (`components/charts/ChartRangePills`) to the amount-history card and window both the bars and the
    table through the same slice; add a limit + "show all" to the linked list and a limit/offset to
    `recurring-detail.ts:164-178`.
12. **Fix the attach panel: placement, truncation notice, future rows, empty-query story.** (M)
    Render the open panel in the card body below the heading; return a total count from
    `searchAttachCandidates` and show "25 of 41 — refine your search"; drop the `lte(postedOn, today)`
    restriction (`recurring-detail.ts:296`); state the amount band in the panel and give the
    null-amount case its own copy.
13. **Make merge choosable and reversible.** (M) Show amount, cadence, account and last-charge date on
    each candidate (all available from `listSeries`), rank by similarity rather than alphabetically,
    state the charge count in the confirm sentence, and add either an `unmergeSeries` service or an
    `UndoPatch` of the relinked rows captured in `MergeResult` with Undo on the merge toast.
14. **Make the linked-transaction rows first-class.** (L) Link the description to the transaction
    (needs a `?txn=` deep link on `/transactions`, which does not exist — `TransactionsLedger` owns
    the sheet in local state — or an inline expander reusing `LedgerRowExpander`), show the category
    chip, show the paid / paid-different / missed badge via the exported `classifyPostedAmount`
    (`recurring-calendar.ts:66-78`), and show the link owner. Add a `series` filter in
    `services/transactions-query.ts:48` plus "See all N in the ledger".

**Add** (ranked)

1. **Make the Upcoming tab's rows link here.** (S) `UpcomingList.tsx:24-36` renders series names as
   plain text on the DEFAULT tab of `/recurring` while the All tab and the calendar day sheet both
   link (`AllSeriesView.tsx:58,142`; `RecurringCalendar.tsx:125`). One-line fix removing a dead end on
   the most-visited path into this page.
2. **Focus/expand for the amount-history chart.** (S) Wrap the card in `components/charts/ChartFocus`
   the way the Balance, Portfolio and Holding charts were wrapped in pass 22. The comment at
   `SeriesDetail.tsx:217-218` explicitly notes this card has no focus button.
3. **Notes / cancellation memory on the series.** (S) `recurring_series` has no notes column while
   transactions do. Add one and surface it: "cancel before the annual renewal on Mar 3", "this is
   Carson's card, he reimburses me".
4. **Export the trade/charge history.** (S) *(covered by the series-scoped ledger filter below; keep
   a CSV of `amountHistory` on the card as the cheap version.)*
5. **Series-scoped ledger filter and totals.** (M) Add `series` to `TxnFilters`/`filterConditions`
   (`services/transactions-query.ts:48`) so `/transactions?series=<id>` works, then put "See all 41
   charges · $2,438.59 total" on the linked-transactions card, plus lifetime-total and
   charges-per-year lines in the stat block.
6. **Price-change history as a narrative, not just bars.** (M) Derive change points from
   `amountHistory` (already on the page) and state them: "$9.99 → $12.99 on Mar 14, 2025 (+30%) ·
   $12.99 → $15.49 on Feb 2, 2026 (+19%) · you have paid $187.44 more than the original price since",
   with cumulative-paid-to-date beside Annualized.
7. **"Why this is recurring" panel — the detection audit trail.** (M) Every gap in days between
   consecutive charges with a ✓/✗ against `toleranceDays`, the amount mean/σ/CV against the 0.2
   stability threshold, and the confidence arithmetic. All inputs are on the client already
   (`amountHistory` gives the dates; `recurring-detail.ts:247-251` gives the stats) and the constants
   are exported (`MIN_OCCURRENCES`, `AMOUNT_STABILITY_CV_MAX`, `recurring.ts:33-36`).
8. **Kind and account correction.** (M) There is no control anywhere in the app to fix a
   mis-classified `kind` or a wrong `accountId`, yet kind decides whether the series is excluded from
   the forecast entirely (`forecast.ts:135`). Add `user_kind` as a fourth override column read by
   `effectiveSeries`, exposed as another token in the cadence sentence (the verb is already derived
   from kind, `labels.ts:88-90`).
9. **Keyboard flow and next/previous series navigation.** (M) Register a KeyScope
   (`lib/keyscope.ts`, `PRIORITIES.list`) with confirm/dismiss/edit-amount/attach keys — noting a
   plain `a` is currently swallowed app-wide by `ToastMnemonic` — plus ‹ / › to move through the All
   ordering (`recurring.ts:586-591`) without a round trip.
10. **Health strip: what this series costs relative to everything.** (M) Share of monthly fixed spend,
    rank among the owner's series by annualized cost, and this year vs last — all derivable from
    `listSeries` plus `recurring.ts:534-537`.
11. **Similar/duplicate-series detector on the page.** (M) `MergeControl` already fetches every live
    series (`recurring-detail.ts:217-228`); rank by name/merchant/amount/cadence similarity and
    surface a strong candidate proactively ("'NETFLIX.COM' looks like the same charge — merge?")
    instead of hiding it behind a button and an alphabetical list.
12. **Occurrence timeline: expected vs actual, with misses.** (L) The single biggest hole. The page
    shows past amounts (bars) and future dates (a list) as two unrelated blocks and never shows
    whether a past expectation was met. The calendar already computes the whole grammar per day —
    paid / paid_different / upcoming / missed — with a tuned noise band and a missed count
    (`recurring-calendar.ts:24-78, 120+`). Build a per-series timeline: one row per expected
    occurrence back through history, each matched to its posted charge or marked missed, with the
    variance and a link. `projectOccurrences` silently skips overdue occurrences
    (`recurring.ts:696`), so rent expected on the 1st that never arrived by the 10th shows only "next
    expected Aug 1" and the miss is structurally unsayable.
13. **Per-occurrence actions on the Next-expected list: skip, mark paid, snooze, one-off amount.** (L)
    The three projected rows (`SeriesDetail.tsx:241-247`) are inert text; a one-off skip ("I cancelled
    the gym for August") today requires either corrupting the cadence by hand-moving
    `next_expected_on` or ending the whole series. Add a `series_occurrence_overrides` exception table
    (seriesId, date, action skip|amount) read by `projectOccurrences` so the forecast and calendar
    honor it too.



