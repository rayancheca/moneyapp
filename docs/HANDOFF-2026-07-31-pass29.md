# Handoff — 2026-07-31, pass 29

> Supersedes `docs/HANDOFF-2026-07-31-pass28.md`. Two pieces of work: Phase 2 of the audit backlog
> was **re-measured before being worked** (and its first item's "done" verdict overturned), and the
> owner's day-view ask got its **data path built end to end**. The chart itself is deliberately not
> wired — see §4, which names the trap that stopped it.

## 1. Repo state

| | |
|---|---|
| `main` | two commits this pass: `e7adcda` (overflows + gate holes), `a0c9828` (intraday groundwork). Both pushed. Verify with `git rev-parse main` — a handoff cannot name its own hash without lying. |
| worktree | `.claude/worktrees/app-polish-adversarial-review-e80abb` still stale at `4d45273`. Remove or reset it before use. It has its own copy of `chart-range.ts`, `ChartRangePills.tsx`, `ScrubTable.tsx` and `DashboardChartSection.tsx`, so an unscoped `grep -rn` from the repo root **double-counts and can send you editing the wrong tree**. Scope every grep to `src e2e scripts`. |
| real DB | **not written this pass.** Migration `0007` is committed but unapplied — it runs on the next `createDatabase()`, i.e. the next dev-server start. It is one `CREATE TABLE` + one index, no alters. |

**Gate, measured on a fresh build:**

| | pass 28 | now |
|---|---|---|
| `tsc --noEmit` | clean | clean |
| unit | 135 files / 2,294 · coverage green | **138 files / 2,340** · coverage green (99.63%) |
| `next build` | clean | clean, 17 routes |
| e2e | 345/345 | **372/372** under `E2E_GATE=1` |
| visual baselines | 143 | 143, **unchanged** (see §5 — that is a finding, not a reassurance) |

---

## 2. Phase 2, re-measured — and item 28 was not done

The backlog (`docs/review/08-backlog.md`) opens Phase 2 with items 24–32. Nine were re-measured
against the current tree before any work started. **Two survived word-for-word (26, 32). Seven carry
at least one false claim. Zero were done.** Full per-item evidence is in the workflow journal; the
corrections that change what you would build:

- **Item 24** says "four hot service functions" and then names five. The `transferFloats` pair is
  also mis-stated: `dashboard-series.ts:77` does not execute on the default dashboard at all
  (`dashboardSeriesMode("combined")` returns null), so the real second call is `forecast.ts:360` via
  `dashboard.ts:191`.
- **Item 25**: recharts is **four** chunks of 378,733 bytes, not five of 380,657, and three of six
  affected routes already share one — "zero cross-route cache reuse" is now false. The −107 KB gz
  per-route figure still holds exactly.
- **Item 27 points its fix at the wrong line.** Skipping the three inactive `/recurring` tabs buys
  ~2.8ms of a ~705ms page and cannot be taken cleanly anyway (the counts feed badges). The real
  defect is one line the item never mentions: `forecast.ts:360` calls `bridgedNetWorthSeries(db)` —
  measured 659.0ms — to read `.at(-1).totalCents`. That is 94% of `/recurring`, and `/` pays it too.
  **This is now the best-value item in Phase 2 and it is effectively an S.**
- **Item 31** is one-quarter done and two premises were never true: `AccountsTable.tsx:609-625`
  already does the `isPending` → `<ViewSwitcher disabled>` wiring, and `useFormStatus` is no longer
  zero (`Confirm.tsx:250`). It remains **blocked by item 33** (Phase 3).
- **Item 28 — see below.**

### 2.1 Item 28: the "DROP" verdict was wrong, and three routes really scrolled

The first measurement pass concluded DROP: 49/49 width assertions green, every named grid carrying
`*:min-w-0`, goal achieved. An adversarial re-check overturned it. Three routes genuinely scrolled
sideways, each reproduced twice — on the gate's own server with the gate's own `measure()`, and
independently on the live dev server with real data:

| route | over | cause |
|---|---|---|
| `/?chart=sankey` | 48px @320 | `DashboardChartSection.tsx` hand-rolls its own range pills for the Sankey (it has no scrubbable time axis) and that copy never got `flex-wrap`. Seven pills = 327px of min-content against 288px of page. |
| `/imports` | 39px @320 | a file input's min-content is its button plus filename text (318px); as a flex item the label defaulted to that and could not shrink. |
| `/recurring?tab=all` | 270px @320, **150px @440** | six columns give `AllSeriesView`'s table a 589px min-content. Its wrapper's box fits (408px) and scrolls internally, yet it still propagated that width to the document. |

The third is the interesting one. **Rect forensics could not name it** — every element overflowing at
440 was inside a sanctioned `overflow-x-auto` scroller, no element escaped the viewport, and the page
scrolled into *empty space*. Hiding any single element moved the document by exactly 24px. It was
found by testing candidate fixes live in the page: containing **both** wrappers takes the document
590 → 440; containing either alone does not. Fix is `contain-paint` on `AllSeriesView.tsx:113`, which
only tells the browser what the rounded card border already implies.

⚠️ Two "leftover" instructions in item 28 are **provable no-ops** — do not ship them to close a
checkbox: `min-w-0` on `DataTable.tsx:176` (its `overflow-x-auto` already zeroes the automatic
minimum on both axes) and `*:min-w-0` on the `sm:grid-cols-2` form at `settings/page.tsx:65` (single
column on every phone).

### 2.2 Why the gate was green through all three

Each got past a different structural hole, and closing those was the larger half of `e7adcda`:

- **Route coverage.** `overflow.spec.ts` measured 13 route strings; the app has 16 pages. Its drift
  guard compared against `visual.spec.ts`, so a route in **neither** list was invisible *by
  construction* — it could never flag `/imports`. Now the guard enumerates `src/app/**/page.tsx`, so
  a new page is measured or explicitly exempted and there is no third state. **The exemption list is
  empty**: `/design/stage-0a` was clean at all three widths, and a standing exemption for a route
  that passes is exactly the unused third state that hid `/imports`.
- **View-state coverage.** One state per route is not coverage for a URL-addressable view. The
  dashboard chart dimension is now enumerated **from the registry** (`DASHBOARD_VIEW_SPEC`), so an
  eighth option is measured the day it is added; `/recurring`'s three tabs are measured too, and
  `?tab=all` is where the third overflow was found. This is the pass-25 lesson recurring *inside* the
  gate that was supposed to be the backstop.
- **Source coverage.** `pill-rows.test.ts` already **matched** `DashboardChartSection.tsx` and already
  returned `flex-wrap === false`. The file simply was not in its two-entry array. Its own docstring
  predicts the failure verbatim: *"a LATENT bug that only appears when someone appends an option"* —
  and pass 28 appended `1D` and `1W`.

---

## 3. The day view — what was built

Owner's ask, verbatim: *"obviously the day view needs time on x axis."* He is right, and the reason
it looked wrong is structural. `price_cache` carries `uniqueIndex(symbol, asset_type, quoted_on)` —
**a second price on the same day cannot be stored.** 1D was two points because two points is all the
schema could hold.

Landed in `a0c9828`, all covered:

- **`price_intraday`** — a separate table, not a looser index on `price_cache`. Widening that index
  would let a mid-session tick satisfy a lookup meaning "the close", and every reader of a close (the
  daily series, net worth, realized P/L, the benchmark) would silently start answering with whatever
  was fetched last.
- **`getIntradayTicks` on all three providers.** Yahoo needed only `interval: "5m"` — the installed
  `yahoo-finance2@3.15.4` already types it (`chart.d.ts:267`). Coinbase needed `granularity=300` and
  deliberately does **not** reuse `getDailyCloses`' pagination loop, whose cursor is an epoch-DAY
  integer and whose `CANDLES_PER_CALL = 300` is coupled to the granularity (300 candles = 300 days at
  86400s but five hours at 60s). 288 five-minute candles fit one page, so a session never paginates.
- **`fakeIntradayClose`** so tests and demos never touch the network. Its last tick is *exactly*
  `fakeDailyClose(symbol, day)`, pinned by scaling the noise by `sin(pi*t)` (zero at both ends) rather
  than by a special case. Verified by removing the pin and watching three tests fail.
- **`intradayPortfolioGrid`** (pure). Symbols do not tick together; summing "the latest tick of each"
  would value one point at several different instants. The grid is the union of every reported
  instant, each symbol carried forward from its own last tick and valued at its **prior daily close**
  before its first tick — which is what makes the first point equal yesterday's closing valuation.
- **`refreshIntraday`**, kept out of `refreshPrices` (that flow backfills two years, quotes
  everything and writes balance anchors; nothing depends on intraday). Retention is two sessions,
  pruned every run.

**Also shipped, and it stands alone:** `1D` is gone from the six surfaces that cannot honour it, via
a `ranges` prop through `ChartRangePills`/`ScrubChart`/`ScrubTable` plus `DAILY_SERIES_RANGES`
derived from `CHART_RANGES` — so a *new* range is offered everywhere by default and opting out is the
thing you have to write down. Verified by counting rendered pills: `/` and `/?chart=sankey` offer
six, `/investments` still offers seven.

---

## 4. ⛔ What is NOT built, and the trap that stopped it

**The chart does not draw intraday yet.** `/investments` 1D still shows the old two-point segment.

The blocker is real and worth reading before you start:

> Rendering a time axis needs a **timezone**. `toLocaleTimeString` inside a client component runs
> once during the SSR pass (server TZ) and again in the browser (viewer TZ). When they differ you get
> a **hydration mismatch**, and `ScrubChart` is rendered from five surfaces.

**The decided design** (not yet applied):

1. **The server emits each tick's label.** `/investments/page.tsx` builds the points and formats the
   label server-side. Server-local time *is* the owner's time — this is a local-first app on his own
   Mac, and `todayIso()` already assumes exactly that. Server and client then render the same string
   and there is no locale call in the browser.
2. **Do not switch the axis type.** `XAxis` is `type="category"` on `dataKey="day"`, and scrubbing is
   index arithmetic (`ratioToIndex`) that is only correct *because* categories are evenly spaced.
   Five-minute ticks are also evenly spaced, so a categorical axis over instants works and preserves
   scrubbing **and** the nine `ReferenceArea`/`ReferenceLine`/`ReferenceDot` annotations that pass a
   day string as a category value.
3. So the work is: add `axisLabel?: string` to `ScrubPoint`, have `PortfolioChartPanel` /
   `HoldingChartPanel` swap in the intraday points when `range === "1D"`, and make the `tickFormatter`
   and the header/tooltip readout prefer `axisLabel` over `formatDayShort`. `dateAxisTicks` needs an
   intraday sibling — its finest granularity is one day and it calls `diffDays`, which will not parse
   an instant.
4. Then: a `?range=1D` e2e assertion, and new visual baselines for that state.

Two facts that make it cheaper than it looks: `/investments` is the **only** surface that reads
`?range=` (every other chart's range is client state in `ChartFocus`), and the RSC can simply always
send the intraday series — it is ≤288 points.

---

## 5. 🔴 Traps this pass paid for

- **An adversarial re-check earned its keep.** The first pass over item 28 concluded DROP with
  49 green assertions behind it. Three real overflows survived that verdict. When a verdict is
  "already done", make something try to refute it.
- **Naive overflow probing blames the victim.** My first culprit-finder reported the widest
  overflowing elements and named a table that was *inside* an `overflow-x-auto` scroller. An element
  only pushes the page if **every** ancestor up to `<body>` has `overflow-x: visible`. Fixing what the
  naive probe named would have changed nothing.
- **`scrollWidth` alone does not prove a user-visible bug.** Confirm with
  `window.scrollTo(5000,0)` and read `scrollX` back. On `/recurring?tab=all` it really scrolled;
  elsewhere a nonzero `scrollWidth` can be a phantom.
- **`--update-snapshots=all` rewrites every baseline unconditionally.** I ran it to see what my pill
  change had moved: 51 of 131 files changed *bytes*, including `/budgets`, `/settings` and
  `/transactions`, which have no range pills at all. That is font/antialiasing/animation noise, not
  signal. Reverted. **Do not commit a `=all` sweep to "capture" a change.**
- **…which exposed the real finding: removing a pill from two surfaces moved NO baseline past
  `maxDiffPixelRatio: 0.001`.** 372/372 passed with the change in place. The baselines are tolerant
  enough to miss a visible one-pill edit, so a regression that re-adds `1D` would not be caught. This
  is concrete evidence for the "tighten the ratio" item already sitting in pass 28 §6.2.
- **TypeScript is a real reviewer here.** Widening `PriceProvider` immediately failed three test
  stubs. Keeping the method **required** (rather than optional) is what forced every provider to state
  its intraday behaviour instead of silently lacking it.
- **`upsertHolding` SETS the quantity and rejects negatives** — it does not accumulate. A "sold to
  zero" test must upsert `0`.
- **Floating point breaks the obvious whole-cents assertion.** `2583.99 * 100` is
  `258398.99999999997`; assert `Math.round(p*100)/100 === p`, not the naive form.
- **`data/e2e-originals` can fail `global-setup` with `ENOTEMPTY`.** It is declared scratch ("droppings
  are not state") — `rm -rf` it and re-run.
- **`e2e` flakes exist.** Two `zz-zz-view-switcher` tests failed one full run and passed a clean one;
  the spec passes 9/9 in isolation. Before suspecting your own change: both view-preference writers
  (`useViewState.ts:52`, `DashboardChartSection.tsx:124`) are **click handlers**, so a `page.goto()`
  sweep cannot pollute `app_settings`. I checked that before "fixing" a non-problem.
- Never `git add -A` — `node_modules` and `.env` are symlinks.

---

## 6. Open work, in the owner's stated order

### 6.1 Finish the day view ← **next**
§4 has the design and the trap. Everything below it is fetched, stored, tested and covered.

### 6.2 Phase 2 of the audit backlog
Corrected order from the re-measurement, best value first:

1. **27, retargeted** (S, not M) — one substitution at `forecast.ts:360` removes ~659ms of ~703ms
   from `/recurring` **and** from `/`. Nothing else in Phase 2 pays that well per line. ⚠️ The comment
   at `:358-359` says the value is bridged deliberately so the EOM projection starts from the
   dashboard headline — assert the replacement equals `bridgedNetWorthSeries(db).at(-1).totalCents`
   on a seeded DB; do not eyeball it.
2. **24** (M) — React `cache()` on five (not four) service reads. Do it *after* 27, which deletes one
   of the two dashboard call sites its premise rests on. ⚠️ Prove `cache()` is inert outside a render
   scope: 2,340 unit tests call these directly in node-env vitest with a fresh in-memory DB each.
3. **26 part 1** (M) — `flowsByDay` hoisting kills 7,964 of 8,235 statements on `/investments`.
4. **32** (S), **30** (S), **29** (S) — bundle their verification; all three need a touch-emulation
   Playwright project that does not exist yet (`playwright.config.ts:41` is a single desktop chromium
   with no `hasTouch`, so **every `pointer-coarse:` branch in the codebase has never executed**).
5. **25** (M) — last. Its entire payoff is KB, and the perf/bundle constraint was explicitly removed.
6. **31** — do not schedule; blocked by item 33 in Phase 3.

### 6.3 Smaller things still open
- **The income double-count check** (pass 28 §6.2) — two projection paths over one quantity. Still
  unverified, still cheap, still touches the number he cares most about.
- Tighten `maxDiffPixelRatio` — now with evidence (§5).
- `--annotation` on the /flow charts; import the July 17–24 statements so Phil's $3,500 lands.

### 6.4 Hosting — ⛔ still NOT YET, by explicit instruction
> *"hosting is only at the end when im sure the final product is complete"*

Do not start it and do not propose it. The analysis is already written
(`docs/hosting-and-auth-plan.md`).

---

## 7. How to work on this repo

```bash
node_modules/.bin/tsc --noEmit
node_modules/.bin/vitest run --coverage --reporter=dot   # coverage is GREEN — keep it there
node_modules/.bin/next build
E2E_GATE=1 node_modules/.bin/playwright test --reporter=line
```

`pnpm e2e` serves a **stale `.next`** — always `pnpm e2e:fresh`. `assertBundleIsFresh()` only stats
`./src`, so a `next.config.ts` change or a package bump will NOT mark the bundle stale.

**Screenshot every new chart, and every view of it.** This pass had 49 green overflow assertions and
still had to open the PNGs to confirm the pages *read*.

**Two databases — do not mix them.** DEMO/e2e (synthetic): `data/e2e.db`, reseeded by
`e2e/global-setup.ts`. REAL: `data/moneyapp.db`, 9,753 txns, income $118,913.85. Read the real one
with raw `better-sqlite3`; **never `createDatabase()`** against it — that runs migrations and writes,
and defaults to the real path.

⚠️ **The dev server holds the real DB open.** `lsof data/moneyapp.db*` before any `--apply`, and note
it will not appear under a `next start`/`next dev` process-name grep — the process renames itself to
`next-server (vX)`. Kill by port: `kill -9 $(lsof -ti tcp:3111)`.
