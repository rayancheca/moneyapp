# 08 — The backlog

One list. Most valuable first. **Execution follows this order.**

Value = (does it stop a wrong number or a data loss) × (does it happen on the owner's real data)
÷ effort, with a thumb on the scale for his stated goals: the phone is the primary device, it will
be hosted, and it must be beautiful and highly interactive.

- **Tags** — `[correctness]` truth or data safety · `[clarity]` the number is right, the screen isn't ·
  `[craft]` how it feels: perf, motion, touch, a11y · `[consistency]` one app not twelve ·
  `[feature]` net-new capability.
- **Size** — **S** ≤ half a day · **M** 1–3 days · **L** ≥ 3 days.
- Every item names the files it touches. `Blocked by:` means do the other one first or you will do
  the work twice.
- Cross-references: `#n` = defect register rank in `04-what-is-bad.md`; `C/L/K/S n` = row in
  `05-what-to-change.md`; `ADD n` = row in `06-what-to-add.md`.

---

## Phase 1 — Stop the bleeding (one week, and everything after it becomes safe to iterate on)

1. **[craft] (S) Gate `Popover`'s children on `open`.** One line: `{open && children}` in
   `src/components/ui/Popover.tsx:134`. The correct pattern is already written at
   `src/components/ui/CommandPalette.tsx:141`. Measured payoff on the real DB: `/transactions` drops
   from **4,647,518 bytes / 32,557 DOM nodes / 3,650 `role=option`** to roughly 259 KB and ~1,520
   nodes; it fixes 10 `CategoryPicker` sites plus `Menu`, `BudgetAmountEditor`, `BudgetRow`,
   `SeriesMembership` and three `CadenceSentence` editors at once. *Best effort-to-payoff item in the
   entire audit.* (#17, #B10, K1)

2. **[correctness] (S) Add the error/loading/not-found boundary layer.** Create
   `src/app/error.tsx`, `global-error.tsx`, `not-found.tsx`, `loading.tsx`, plus per-route
   `error.tsx` for `/accounts/[id]`, `/transactions`, `/imports`, `/settings`. Today a mistyped
   balance replaces the whole document with a Next error digest and loses every other field —
   confirmed live twice. `find src/app -name error.tsx` currently returns nothing. (#16, C1)

3. **[correctness] (S) Make `readSettings` fall back to `DEFAULT_SETTINGS`.**
   `src/services/settings.ts:50-54` runs a strict `.parse()` and is called unguarded from seven
   routes. (#16, C2) *Note: the "one bad view preference blacks out the app" claim was falsified —
   those two fields are already `.default()`-guarded. This is still correct-by-construction hygiene
   and costs one line.*

4. **[correctness] (M) Convert the 18 `Promise<void>` server actions to `ActionResult<T>` +
   `safeParse` + toast.** `accounts/actions.ts:31,57,72,84,94` · `investments/actions.ts:33,47` ·
   `settings/actions.ts:17` · `budgets/actions.ts:90` · `imports/actions.ts:19,23,30` ·
   `recurring/actions.ts:38,49`. The contract already exists at
   `src/app/transactions/action-types.ts:9` and `ui/Field.tsx:25` already ships an unused `error`
   slot passed at 0 of 42 call sites. (#16, C10) *Blocked by: nothing, but item 2 makes it safe to
   land incrementally.*

5. **[correctness] (M) One `useAction()` hook, and a `.catch` on every action call site.**
   New `src/hooks/useAction.ts` modelled on the sequence-guarded `hooks/useInlineEdit.ts:71-102`:
   pending in a `finally`, a `catch` that surfaces the server message, a stale-response guard.
   Then migrate the ~47 unguarded `.then(` sites (measured: 52 `.then(` vs 5 `.catch(` across
   `src/components` + `src/hooks`, all five catches in `LinkPanels.tsx`). (#3, C8, ADD 21)

6. **[correctness] (S) Make Undo verifiable.** Add the `else`/`catch` branch at
   `src/components/transactions/undo-toast.ts:22-26`, and stop `src/components/ui/Toast.tsx:223-226`
   dismissing the toast synchronously before `onAction()` resolves — the patch currently leaves
   client memory before the request settles. Same missing branch at `RulesManager.tsx:93`,
   `SeriesMembership.tsx:46`, `SplitEditor.tsx:70`. (#3, C9) *Blocked by: 5 (use the hook).*

7. **[correctness] (M) A `<Confirm>` primitive with a blast radius in money, on the eight
   irreversible actions.** The best destructive-action design in the codebase already exists and was
   never reused: the re-derive gate at `EditAccountSheet.tsx:150-155,199-214` (live region, plain
   English consequence, checkbox that resets). Adopt at: un-import (`imports/page.tsx:198` — "deletes
   2,149 transactions, 312 categorized by you"), accept gap, delete anchor
   (`accounts/[id]/page.tsx:246` — "turns 143 days from derived to gap"), archive account (`:272` —
   "net worth will read $11,020.45 higher"), delete rule, deactivate budget, end/dismiss series,
   merge series, and "Select all N" in `BulkActionBar.tsx:68-76`. (#1, #14, L13, ADD 20)

8. **[correctness] (M) Snapshot before every irreversible mutation.** New
   `withPreMutationSnapshot()` in `src/db/backup.ts` reusing the tmp+rename mechanism at `:63-78`;
   wrap `unimportFile` (`import/service.ts:962`), `acceptGap` (`:990`), `deleteAnchor`
   (`anchors.ts:60`), the `addManualAnchor` conflict branch (`anchors.ts:40`),
   `deleteManualTransaction` (`manual-transactions.ts:267`), `mergeSeries`
   (`recurring-links.ts:168`), `retroApplyRule` (`rule-corrections.ts:203`), and `bulkApplyByFilter`
   above a threshold (`bulk-edit.ts:187`). Snapshot cost on a 12.8 MB DB is milliseconds. (#1, #4,
   C28) *Blocked by: 7 (the confirm dialog is where you offer it).*

9. **[feature] (M) Restore from a backup, from inside the app.** `src/app/settings/page.tsx:113-130`
   lists filenames and can do nothing with them. Add per-row Restore behind a typed confirmation, a
   pre-restore safety snapshot, Download, "Back up now", and a per-snapshot summary (txn count,
   latest txn date, net worth that day) so he picks a state not a filename. Also fix the sort —
   `.sort().reverse()` puts every `monthly-*` before every `daily-*`, so `slice(0,8)` hides 12 of 14
   dailies — guard the `statSync` inside the `.map`, list the `pre-*` files and `-wal`/`-shm`
   siblings the directory actually holds (**80 files / 505 MB** vs UI copy "14 daily + 6 monthly"),
   and say which files retention governs. (#4, #91, C13, ADD 3)

10. **[correctness] (L) Preserve user attributes across re-parse and un-import.**
    `import/service.ts:396-405, 525, 548, 772-786`. Two independent bugs: `supersedeFileContribution`
    marks the `importFiles` row superseded so `coveredRanges` drops it from the ownership map, AND
    the takeover branch is gated on a *strictly lower* fidelity source so a same-format re-parse can
    never take over anyway. `migrateSplits` is imported and unreachable. `docs/schema.md:91-93`
    promises the opposite in writing and there is **zero** test coverage — add a test asserting a
    hand-categorized, noted, split row survives a parser-version bump. (#2, C27)

11. **[correctness] (M) One meaning for "Transfer".** `bulk-edit.ts:168-173` and `:285-292` set only
    `transferGroupId`; make them stamp the Transfers-kind category exactly as
    `transfer-links.ts:110-121` already does. **Do not** make analytics exclude on `transferGroupId`
    — a self-group has no counterparty and excluding it would hide a real outflow, which is precisely
    what the two-sided-evidence doctrine exists to prevent. Then extract the stale-leg cleanup at
    `transfer-links.ts:107-110` and call it from `import/service.ts:985` and
    `manual-transactions.ts:273`. (#5, C6, C25)

12. **[correctness] (M) Give the derived cache an invalidation it cannot forget.** Export
    `REPLAY_STATUSES` from `derivation.ts` and assert against it; rebuild after the two paths that
    change replay membership — the **quarantined → active** transition in `bulk-edit.ts:164-167` and
    `upsertHolding` in `holdings.ts:151`. Give `rebuildAllAccounts` (`derivation.ts:260`, currently
    **zero callers anywhere**) a callable home in /settings as "Rebuild derived balances". (#6, C22)

13. **[correctness] (S) Filter `upcomingOccurrences` and `forecast.fixedComponents` by
    `isSeriesActive`.** `recurring.ts:719-723` and `forecast.ts:126-130`; `recurring-calendar.ts:155`
    already does it and says why in a comment. On the real DB "Acme Corp (payroll)" — last matched 80
    days ago, biweekly — projects **+$5,886 of phantom income** into the 30-day window and flips the
    Forecast card's sign. Show the exclusions in a collapsed footer rather than hiding them. (#8,
    #B17, C15)

14. **[correctness] (S) One "next expected" date.** `listSeries` renders the stored
    `nextExpectedOn` verbatim (`recurring.ts:576, 642-651`) while the forecast rolls it forward via
    `projectOccurrences` (`forecast.ts:126-152`). Three series currently display a date in the past
    as "Next" — including `UBER *ONE` at 13 months stale, sitting in Suggestions at **100%
    confidence** asking to be confirmed. One line. (#85)

15. **[correctness] (M) Make the FiltersBar preserve every filter the URL supports.**
    `components/transactions/FiltersBar.tsx:27-32,45-52` — add hidden inputs for `merchant`, `flow`,
    `amountMin`, `amountMax`, include them in `hasActiveFilters` so a chip and Reset render, and
    populate the Category select from the full tree plus the `uncategorized|spending|income`
    sentinels so it stops displaying "All categories" while the ledger is filtered. Every drill-down
    in the app lands here. (#11, C21)

16. **[correctness] (S) Honour `startsOn` in budget status math.** `services/budgets.ts:160-165` —
    clamp to `max(bounds.start, b.startsOn)` and carry a `partialPeriod` flag the row can caption.
    Today a $50 Travel budget created this morning opens at "Over budget by 4798%", and the Predict
    sheet promises "a forecast of your **August** spending" then grades it against July. (#15, C14)

17. **[correctness] (S) Fix the dead merchant drill-downs.** `services/spending.ts:685-687` builds
    the unlinked-group href as a full-text `q` search for a *derived* string, while the ledger's `q`
    is a literal `LIKE` against raw/normalized description. **Measured: 330 of 627 groups (52.6%) open
    an empty ledger — $34,403.46 unreachable**, including his largest merchant-less payee.
    Correct fix: a first-class `descriptionKey` filter on `TxnFilters` that recomputes
    `strippedDescriptionKey` server-side — `review-inbox.ts:25-27` already does exactly this. The
    20-minute version: link with the longest literal token run. **Invisible on the demo DB, so no
    test can catch it today.** (#79)

18. **[correctness] (S) Close the two AI-path `source='user'` holes and stop the merchant-default
    contradiction.** Add `or(isNull(source), ne(source,'user'))` to the UPDATEs at
    `claude-categorize.ts:264-270` and `merchants.ts:115-122`, unified behind one exported
    `notUserOwned()` replacing four hand-written copies. Separately, `claude-categorize.ts:233-249`
    correctly refuses to overwrite a user-set merchant *default* and then stamps Claude's category on
    the transactions anyway — that is the live half. **Do not touch the rules path**: it is already
    clean (`{excludeUserSet:true}` + identical preview predicate) and is load-bearing over 2,515
    user-sourced rows. (#13, #40, C23)

19. **[correctness] (S) Catch the Claude run, and stop reporting a failure as a success.**
    `claude-categorize.ts:148` has `try`/`finally` and **no catch**, so a rejection escapes the
    server action; the `finally` then writes `claudeLastRun` from a half-populated `{ran:true}`
    object. Add a `failed` state to the run model. Gate `/transactions`' HeaderStrip button on the
    same `Boolean(process.env.ANTHROPIC_API_KEY)` `/settings:34` already computes, and label it
    "present" not "configured". Also: copy/symlink `.env` into git worktrees — **that is the actual
    root cause of the owner's open "the Claude button stopped working" bug**, not an expired key.
    (#26, #90, C24)

20. **[correctness] (S) Bound every date input and floor `deriveDailyRows`.** No date input in the
    app has a `max` and no schema bounds the year (`AnchorForm.tsx:17`, `CashWallets.tsx:164,272`,
    `HoldingForm.tsx:74`, `anchors.ts:17`, `manual-transactions.ts:27,177`, `holdings.ts:79`). A
    fat-fingered year makes `deriveCashSpans` (`derivation.ts:127-158`) emit one row per day between
    endpoints and `rebuildAccount:250-257` insert them one `.run()` at a time. A typed cap in the
    pure function protects every future caller including scripts. (#29, C26)

21. **[correctness] (S) Fix `retroApplyRule`'s no-op writes.** `rule-corrections.ts:216-234` assigns
    `set.categoryId` unconditionally, so the existing `if (Object.keys(set).length === 0) continue`
    guard at `:238` is never reached: the blast-radius badge never decays, `timesApplied` inflates,
    and "Re-applied to 300" is reported when zero categories moved. Guard each assignment on `!==`
    current value. (#40, C3)

22. **[correctness] (S) Clamp `filters.page` and fix the page-boundary day totals.** Clamp to
    `[1, pageCount]` in `components/transactions/query.ts:58` — live today,
    `?page=99999` returns 200 with "Page 99999 of 194 · 9688 transactions", the *filter* empty state
    and a working Previous. And compute `groupByDay` (`TransactionsLedger.tsx:65-82`) server-side over
    the full filtered set, or label the straddling group "partial — continues on next page". (#61,
    #B12, C5, C12)

23. **[correctness] (S) Stop the four remaining silent no-ops and the sign bugs.**
    `PeriodSelector.applyCustom:85-91` (returns with no navigation and no error while the button
    stays primary) · `ScrubChart.applyWindow:398-404` (silent bail on the <2-point rule — reuse the
    string `ScrubTable.tsx:147-149` already writes) · `CadenceSentence.commit:263-271` (`close()`
    outside the try/catch destroys the draft on a parse error; `InlineEditableText.tsx:74-78` does it
    right) · `formatCentsSigned` returning `+$0.00` (`lib/money.ts:80-83`, ~39 render sites). (#54,
    #76, C4, C19, C20)

---

## Phase 2 — Make it fast enough to host and to hold in one hand

24. **[craft] (M) Wrap the four hot service functions in React `cache()`.** Zero uses of `cache()`
    exist in `src/`. Targets: `analytics.activeTxnsInRange`, `analytics.loadCategoryIndex`,
    `in-flight.transferFloats` (the dashboard computes it **twice at 439ms each** —
    `dashboard.ts:117` and `dashboard-series.ts:77`), `portfolio.buildPortfolio` +
    `portfolioRealizedPl` (/investments builds them 4× and 5× per render). Behaviour-preserving, and
    doctrine-safe: it memoizes reads within one request, it does not persist anything derived.
    (#20, K16, ADD 34)

25. **[craft] (M) Lazy-load recharts behind one shared `next/dynamic` chunk.** There is no
    `next/dynamic` anywhere in the repo and recharts is emitted as **five** 380,657-byte chunks with
    zero cross-route cache reuse. Entry points: `ScrubChart.tsx:12`, `AllocationDonut`,
    `AmountHistoryChart`, `CashFlowChart`, `CashFlowGraph`. Measured −107 KB gz off /, /spending and
    /investments, and ~215 KB gz saved per session from de-duplication. The `loading` slot also gives
    charts the skeleton they don't have. (#19, K15)

26. **[craft] (M) Kill the two N+1s and the two page-load scans that grow with usage.**
    `portfolio.ts:864` does a single-row `price_cache` lookup per holding_event (119 → ~31
    statements measured on a 6-event DB; the owner has 1,991 events × 4 calls) — replace with one
    grouped query plus the binary search already written at `holding-detail.ts:233-248`.
    `manual-transactions.ts:63-97` runs 4–5 queries per account (/accounts 28 → ~8).
    `rules-manager.ts:161` runs a full active-transaction scan **per enabled rule** with a
    `new RegExp` compile per row. `categorize.ts:739-744` materializes every active row for two
    integers. (#20, K17, K19)

27. **[craft] (S) Stop /recurring computing all four tabs on every render.**
    `recurring/page.tsx:32-35` — `forecastCurrentMonth` alone measures 102–112ms, the app's most
    expensive per-row call, and one tab is rendered. Also give `listSeries` a `GROUP BY` count
    instead of loading every active row into JS (`recurring.ts:551-560`). Same class:
    `budgets/page.tsx:51-53` computes `budgetGuidanceCents` for every budget (82.3ms of ~159ms) to
    fill a hover popover, and `recurring-detail.ts:217-228` selects every live series as merge
    candidates whether or not the popover opens. (#77, K18)

28. **[craft] (S) Fix the six measured horizontal overflows.** Add `minmax(0,1fr)` /`min-w-0` at
    `page.tsx:217`, `investments/page.tsx:181`, `spending/page.tsx:214,240`,
    `categories/[id]/page.tsx:179`, `settings/page.tsx:84`, and on the `DataTable` wrapper itself
    (`ui/DataTable.tsx:175`) so every future consumer is protected. `grep "minmax(0" src` currently
    returns **exactly one hit**, at `lg:` only. Then make `ViewSwitcher.tsx:25` and
    `transactions/ViewTabs.tsx:23` wrap or scroll instead of escaping their card — today the
    dashboard's 6-option dimension (including Flow/Sankey) is literally unreachable on a phone.
    (#22, K2, K3)

29. **[craft] (S) Replace `touch-none` with `touch-pan-y` on the chart plot.**
    `ScrubChart.tsx:545` — a measured 208–256px dead band, 25–30% of the phone viewport, on four
    routes, for a drag gesture with no touch equivalent. Delete it from
    `ManagedAccounts.tsx:104`, whose HTML5 `dragstart` cannot fire from touch anyway. Pointer capture
    at `:417` still wins an intentional horizontal drag. (#53, K5)

30. **[craft] (S) Give `Button`/`IconButton` a coarse-pointer floor, and normalize the destructive
    clusters.** `ui/Button.tsx:19-21` and `:60-63` — add an `lg` size plus
    `pointer-coarse:min-h-11 min-w-11`; same for `ViewSwitcher.tsx:35` and `ChartRangePills.tsx:42`.
    ~6 lines moves the measured under-44px count from 709/1470 with zero call-site changes. Then fix
    the two clusters where an irreversible action is a sub-24px target beside a benign one:
    `RulesManager.tsx:148-177` and `BudgetRow.tsx:193-207`, and give the padding-less 14×14 reorder
    chevrons at `ManagedAccounts.tsx:114-131` a real hit area. (#24, K4, K33)

31. **[craft] (S) Wire the pending flags that are already computed.** `ViewSwitcher`'s `disabled`
    prop exists and is passed by 0 of 11 consumers; six `useViewState` consumers destructure
    `isPending` and throw it away (`CashFlowView.tsx:37`, `DashboardChartSection.tsx:90`,
    `BalanceChartPanel.tsx:87`, `SeriesDetail.tsx:65`, `HoldingChartPanel.tsx:98`,
    `PortfolioChartPanel.tsx:93`); 14 of 21 `useTransition` sites are `const [, startTransition]`.
    Then give every `<form action>` a pending submit via `useFormStatus` (**zero** usages today),
    starting with `imports/page.tsx:96` — a 30-second import that looks frozen and can be
    double-submitted into two 100 MB in-memory batches. (#18, K8, K9) *Blocked by: 33 (do it once,
    on the shared `Button`).*

32. **[craft] (S) Add the two missing `pointer-coarse:opacity-100`.** `ui/StatCard.tsx:45` and
    `ui/InlineEditableText.tsx:123` — `DataTable.tsx:65` already does it. Two words restore the
    drill-through signal on every stat card and the rename affordance on all four entity detail
    pages, on the device with no hover. (#71, K6)

---

## Phase 3 — Make it one app (the visible quality jump)

33. **[consistency] (M) Retire the 16 hand-rolled primary buttons onto `Button`.**
    `settings/page.tsx:61` · `imports/page.tsx:97` · `PeriodSelector.tsx:194` · `ReviewInbox.tsx:251`
    · `HeaderStrip.tsx:63` · `AnchorForm.tsx:26` · `AccountForm.tsx:62` · `BudgetForm.tsx:32` ·
    `PredictBudgets.tsx:101` · `SeriesDetail.tsx:146` · `CadenceSentence.tsx:235,320` ·
    `AllSeriesView.tsx:80` · `SeriesMembership.tsx:233,320` · `HoldingForm.tsx:79`. Eight geometries
    collapse to one; `pending`, `disabled:` and `active:` come free, closing "no pending state /
    double-submit / silent save" — filed as five separate bugs by five separate route audits. Add
    `active:` to the three variants that lack one. (#45, S5)

34. **[consistency] (S) Ship a type scale and apply it to headings first.** Add
    `--text-eyebrow/-body/-section/-title/-hero` to `globals.css` (which today defines **zero**
    typography and spacing tokens, in violation of the project's own web rule), then replace the
    **39** `<h2 className="text-sm font-medium">` section headings that are byte-identical to body
    copy. One mechanical pass gives every surface a visible three-level hierarchy for the first time;
    the dashboard hero already proves the proportions. (#44, S1)

35. **[consistency] (M) Migrate the 119 hardcoded sub-12px sizes onto the scale.** 102× `text-[11px]`,
    15× `text-[10px]`, 2× `text-[9px]` across 58 files. Worst: `SpendHeatmap.tsx:157` (10px money in a
    44px cell), `ForecastCard.tsx:84`, `AllSeriesView.tsx`, `PortfolioStats.tsx`. After this, raising
    the phone floor is a one-line token change. (#44, S3) *Blocked by: 34.*

36. **[craft] (S) Add `--shadow-card` as a theme-aware token.** `globals.css` beside
    `--shadow-overlay`, replacing the hardcoded `oklch(0% 0 0/0.04)` literal at `SurfaceCard.tsx:12`,
    `HeaderStrip.tsx:40`, `InstitutionCard.tsx:98`, `ManagedAccounts.tsx:71`. On a 0.19-lightness dark
    background a 4%-black shadow is arithmetically invisible, so dark mode currently has **no
    elevation model at all**. Add `--shadow-card-hover` for the drill-down lift the app lacks. (#46, S4)

37. **[consistency] (M) Make the period a first-class param carried on every cross-surface link.**
    One `periodParams()` in `lib/period.ts`, applied at `SpendingCategoriesTable.tsx:105,154` ·
    `BudgetRow.tsx:77` · `categories/[id]/page.tsx:95,186` · `SeriesDetail.tsx:134` ·
    `MonthlyTrendBars.tsx:21`; accepted on /budgets (`page.tsx:46`), /merchants/[id] and /accounts.
    `resolvePeriod` has exactly **two** route callers today. Then delete the `?period=2026`
    workarounds from `e2e/zz-spending-categorize.spec.ts:21` and `e2e/a11y.spec.ts:56` and let the
    specs assert the carry instead. (#9, S7)

38. **[consistency] (M) Route the remaining local state through the existing view-state system.**
    `lib/view-state.ts` + `useViewState.ts` already implement URL > persisted > default with only
    non-defaults in the URL. Migrate: `ChartFocus.tsx:67` (range), `SankeyChart.tsx:82`,
    `spending/page.tsx:220` (heatmap month — also deletes the `key={heatMonth}` remount hack),
    `RecurringCalendar.tsx:66`, the dashboard brushed window into `DashboardWindowProvider`,
    `PortfolioHoldingsTable.tsx:38-39`, `TopMovers.tsx:13`, and the open transaction sheet
    (`TransactionsLedger.tsx:109` → `?txn=`). Honour the append-only invariant at
    `chart-lens.ts:17-19`. (#33, S8, ADD 29)

39. **[consistency] (M) Retire the four raw `<table>`s onto `DataTable`.** `imports/page.tsx:168`
    (88 rows — gains sort, row links, caption, empty state), `accounts/[id]/page.tsx:227`,
    `AllSeriesView.tsx:114` (31 series — gains sort-by-annualized, the most-wanted affordance on that
    surface), `ForecastCard.tsx:80` (the only table in the app with **no** overflow wrapper at all).
    `DataTable` already has `aria-sort`, `rowHref` overlays and controlled URL sort state. (#72, S6, K27)

40. **[consistency] (S) Extract one `revalidateFor(kind)` map.** 87 `revalidatePath` calls across 8
    action files, hand-rolled and wrong in both directions. Measured holes: `recurring/actions.ts:33`
    (missing `/`, /budgets, /spending) · `budgets/actions.ts:98` (missing /categories/[id]) ·
    `merchants/actions.ts:41` (missing `/`, /budgets, while the identical mutation from the ledger
    revalidates `/`). `imports/actions.ts:7` already has the right idea. (#37, S9)

41. **[consistency] (M) One month-pager, one tolerance, one budget vocabulary.** Extract
    `useMonthPager` from the correct implementation (`PnlCalendar.tsx:44-69` — latest-request guard,
    `isPending`, negative toast) and adopt in `RecurringCalendar.tsx:70-76` and
    `SpendHeatmap.tsx:54-61` (which drops `!res.ok` entirely); bound all three and render "No
    activity in {month}". Export `classifyPostedAmount` (`recurring-calendar.ts:66-79`) and use it in
    `AmountHistoryChart.tsx:45` so "on plan" stops meaning two different things on two tabs of the
    same series. Reconcile `pace` vs `alert` (`budgets.ts:196,446`) so a budget is not green on
    /budgets and amber on /categories/[id], and make `categoryBudgetRef` return **all** of a
    category's budgets instead of `.find()`'s first. (#47, #55, #60, S11, S14, S15)

42. **[consistency] (S) Fix the detail-route identity layer.** `generateMetadata` on
    `/merchants/[id]`, `/investments/[t]/[s]` and `/categories/[id]` (three open tabs currently read
    "Merchant", "Holding", "Category"); use the shared `ui/Breadcrumbs` instead of
    `categories/[id]/page.tsx:94-106`'s hand-rolled nav; add `?from=` so `/merchants/[id]` stops
    claiming Transactions is always its parent and `/recurring/[id]`'s footer stops saying "All
    recurring" while linking to the Upcoming tab. Route palette categories to `/categories/[id]`
    (`command-index.ts:66` — the comment says "until Stage 3 lands"; it landed) and update
    `command-index.test.ts:48`, which currently pins the stale behaviour. (#56, #73, S13, S16)

---

## Phase 4 — Say what the numbers mean (this is where the product gets good)

43. **[clarity] (M) One `<AsOf day basis />` component, used everywhere a money figure appears.**
    Every value already exists and is discarded: `dashboard.ts:131`, `institution-groups.ts:169-170`,
    `derivation.ts:378-383` (both loaded and dropped by `ManagedAccounts.tsx:160-167`),
    `holding-detail.ts:298-301`, `portfolio.ts:536`. Then kill the four "today" lies —
    `InvestmentsTeaser.tsx:55`, `InstitutionCard.tsx:28`, `PositionCard.tsx:50`,
    `accounts/[id]/page.tsx:152` — and the dead ternary at `PortfolioStats.tsx:27`
    (`Today{overview.dayChangeVsDay ? "" : ""}`). Name the real comparison day. (#7, L1, L2)

44. **[clarity] (M) Report what the three bulk engines actually did.** `imports/actions.ts:19`
    discards a fully-populated `FileOutcome[]` with six counters *and* the only message that says
    partial rows were committed; `transactions/actions.ts:128-129` discards `categorizeAll` +
    `detectTransfers` stats; `recurring/actions.ts:38-41` discards `DetectionSummary`. Today a batch
    where every row was `skippedOwned` is pixel-identical to one that inserted 2,000 rows — and four
    files on the real DB imported **zero** transactions while the page reports "Open gaps 0". Badge
    `Txns 0` as a failure, exclude it from "Reconciled periods". (#36, #88, L3)

45. **[clarity] (M) Migrate the honesty vocabulary from `title=` to the built-and-unused `Tooltip`.**
    `ui/Tooltip.tsx` has **zero importers** and is complete (300ms hover intent, focus-visible,
    Escape, `aria-describedby`, `popover="manual"`). 35 `title=` sites carry the differentiating copy.
    Priority: `PortfolioStats.tsx:35,68,113` · `RealizedSalesList.tsx:51,60` · `PredictBudgets.tsx:178`
    · `PositionCard.tsx:67,72,75` · `PortfolioHoldingsTable.tsx:61,74,90` · `SpendingCategoriesTable.tsx:132`
    · `CashFlowChart.tsx:126`. Special case: `imports/page.tsx:186` puts the entire parser error string
    in a `title` — make that an expandable row, because it is the only place a failed import's cause
    is shown anywhere in the app. (#23, L10)

46. **[clarity] (S) State the GROSS / NET / uncategorized reconciliation on /spending.**
    `spending/page.tsx:88-97` — three denominators on one screen and the comment at `:91-94` still
    calls the gross total "the NET total". Every component is already loaded. Then make the
    `category=spending|income` predicate split-aware (`transactions-query.ts:58-81`) to match the
    named-category branch 12 lines below, so the Spent card's own drill-down stops over-counting split
    rows. (#10, L5, C7)

47. **[clarity] (M) Render the coverage the series already carries.** A ribbon under every balance
    chart: `coveredAccounts/totalAccounts/missingAccounts` per point, grey where partial, and a scrub
    tooltip reading "4 of 9 accounts". **87% of the hero curve is a partial sum and only the last
    point's flag is read** (`dashboard.ts:133`); for the first 402 days the line is drawn from **one
    account of nine**. Same fix stops `accountSeries:361` filtering gap days out of existence and then
    drawing a straight line across them on a categorical axis — keep the gap rows and render them.
    (#30, #82, ADD-blind-spots 4)

48. **[clarity] (M) Persist and render a review *reason* per row and per cluster.** Four independent
    producers write one boolean: `categorize.ts:261-266` (large deposit), `categorize.ts:631-644`
    (ambiguous transfer), `claude-categorize.ts` (low confidence), `import/service.ts:891-894`
    (suspected **duplicate** — which changes net worth, not categorization, and must not be clearable
    by the same "Confirm all" as a confidence wobble). Render on `ReviewInbox.tsx:186-209` and the
    ledger dot; the empty-state copy at `transactions/page.tsx:54-56` names only three of the four.
    Add a persisted `reviewDismissedAt` so detector pass 2 stops re-flagging rows the owner already
    cleared. And design the **empty** state — measured `needsReviewCount = 0` on the real DB, so that
    is the state he lives in, and it currently gets one sentence and no next action. (#25, L14, C31)

49. **[clarity] (M) Surface categorization provenance.** Add `categorizationSource` to
    `transactions/page.tsx:95-111` and `services/ledger-rows.ts:42-68`; render a source glyph on the
    row and a "Why this category" line in the sheet reusing the `suggestionReason` copy pattern at
    `TransactionSheet.tsx:32-36`. It is populated on 9,522 of 9,753 real rows and rendered nowhere,
    in an app whose pitch is auditability. (#27, L15, ADD 30)

50. **[clarity] (S) Render the numbers the pages already compute and discard.** Nine of them:
    `pace.points[].idealCents` as a third faint line so "Free to spend" can answer ahead/behind (and
    give it a negative branch — it renders "≈ −$4,538.72" today with no copy or colour for that
    case); `upcoming.netCents` as the strip headline and `beforePaycheck` even when 0;
    `accountName` on all three dashboard lists; the six SeriesDetail evidence fields
    (`recurring-detail.ts:247-252` — `lastMatchedOn`, `intervalDaysAvg`, `toleranceDays`,
    `amountCentsAvg`, `amountCentsStddev`, `detectedNextExpectedOn`), which is what makes "Confidence
    18%" falsifiable; `costCents` and `latestClose` on the holding page, so "Total return +$1,204"
    finally has a visible denominator; the 6-month `budgetGuidanceCents` delta on each budget row —
    which instantly surfaces that **8 of 10 budgets are >15% off their own actuals**; `txnCount` per
    category row; and the amount on the Excluded honesty bucket. (#58, #34, L4, L6, L7, L22, L23,
    L24, L21, #B18)

51. **[clarity] (S) Add an `action` slot to `EmptyState` and fill all nine dead ends.**
    `ui/EmptyState.tsx:3-6` is `{title, description}` with no children and no href. Sites:
    `transactions/page.tsx:199,217` · `imports/page.tsx:158` · `budgets/page.tsx:81` ·
    `recurring/page.tsx:65` · `spending/page.tsx:194` · `ReviewInbox.tsx:124` · `AllSeriesView.tsx:22`
    · the dashboard first-run cards (`page.tsx:124`, **zero interactive elements on the entire
    first-run screen**). Also derive "no accounts" from `listAccounts`, not from the last
    daily_balances point — today a user with five saved accounts is told "No accounts yet". (#39, L11)

52. **[clarity] (S) Give the twelve `&&`-gated sections an else branch.** Two are functional bugs, not
    cosmetics: `accounts/[id]/page.tsx:195` hides the "All transactions →" escape hatch exactly when
    an account has no *active* rows (confirmed live on Robinhood Crypto), and `page.tsx:188` renders
    blank space instead of ScrubChart's own "not enough history" copy. (#38, L12)

53. **[clarity] (S) Make the drill-down contract hold on the numbers that matter most.** The budget
    Spent figure (`BudgetRow.tsx:170-173` — `analytics.transactionsHref` already emits the exact URL),
    /budgets' missing page total (budgeted $6,799.00 vs actual $5,670.51, computed ten times and never
    summed), the dashboard's Assets/Liabilities and coverage warning, `PeriodActivityPanel.tsx:122`'s
    inert top-category chips, and /spending's Net + Savings-rate cards, which both open the identical
    whole-period list. Also scope the top-merchant href to the category on /categories/[id]
    (`spending.ts:679-681`). (#65, C36)

54. **[craft] (S) Add a route announcer and a focus anchor to the shell.** New
    `shell/RouteAnnouncer.tsx` mounted in `AppShell.tsx`; `#main` already carries `tabIndex={-1}` and
    `outline-none` at `:62-66` for exactly this. One component fixes silent navigation on all 15
    routes. While there: fix the two `aria-label`-on-a-`<span>` sites
    (`TransactionsLedger.tsx:300`, `RecentTransactions.tsx:75`) using the `LetterBadge` shape at
    `ui/Badge.tsx:44-53`, and stop `display:none` stripping the T/R badges from the accessibility tree
    below `md`. (#42, #50, #49, K7, K10)

55. **[clarity] (S) Correct the privacy line and disclose the egress.**
    `AppShell.tsx:46` prints "Local-first · your data never leaves this Mac" on all 15 routes while
    three outbound destinations exist, and what goes to Anthropic includes strings like
    `CARD PURCHASE LOVE PEACE CONVENIENC BRONX NY CARD 7782` — his card's last four and his ATM's
    street address. Change the line to "your statements stay on this Mac", and put a one-time
    disclosure plus a preview of the exact strings on the Run-categorization button. Render the 10
    populated AI call records `settings.ts:90-96` already returns, under a page that claims to log
    them. (#57, #89, L8)

---

## Phase 5 — The missing surfaces (the app's biggest holes)

56. **[feature] (L) "Money in, not income" + a transfer-integrity report.** **$93,004.29 across 4,587
    rows — 47% of the ledger — has no surface anywhere in the app.** `Gifts received` is $46,928.00
    in and $0.00 out across 35 hand-categorized rows; `Internal Transfer` nets +$46,806.37, which is
    impossible for internal transfers (740 paired rows net $0.00 — the detector is sound — while 250
    unpaired legs net +$46,806). Build: a "Money in, not income" section on /spending with its own
    total and drill-down; a per-transfer-category `paired net` vs `unpaired net` report listing the
    250 orphan legs (the doctrine says single-sided hints only *flag* — nothing renders the flags);
    and **one reconciliation page**: `Δ net worth = visible net + excluded net + market Δ + anchors`.
    Three sums, and it is the only thing that stops the app's two headline numbers contradicting each
    other by $116,514.75. (#80, blind-spots PART 2)

57. **[feature] (M) A pass-through band on the net-worth chart.** Add `passThroughCents` to
    `BridgedNetWorthPoint` alongside the existing `inTransitCents` pattern (`dashboard.ts:37-40`),
    drawn as a hatched sub-band, with the hero saying "$30,963 of this is pass-through". **Every one
    of the top eight single-day net-worth moves in the 1,426-point series is a `Family pass-through`
    row**, and his all-time peak of $116,015.17 is a $29,800 wire of his father's money that the app
    already knows isn't his. Zero deletion, one new field. (#81)

58. **[feature] (M) Closed positions.** `holdingRows` (`portfolio.ts:569`) should emit zero-quantity
    legs with realized activity, flagged `closed`, and `holdingDetail` should resolve a symbol with
    `quantityE8 = 0` — today `/investments/stock/GLD` 404s. This turns the header's "+$3,018.13 · 88
    sells" back into a sum of visible rows; **$1,076.71 across 24 legs and 45 sells is currently
    unreachable**, while `price_cache` still holds full history for 25 such symbols. (#32, #B2)

59. **[feature] (M) A statement coverage map and per-account staleness on /imports.** Extend the
    `statement_periods ⋈ accounts` query already at `imports/page.tsx:51-64` into account rows ×
    month columns for the whole history, each cell reconciled / value anchor / accepted gap / open gap
    / nothing imported, with per-account last statement date and days stale. On the real DB Chase
    Checking's newest period ends **2024-07-11** and Discover's **2024-08-18** while the page reports
    "Reconciled periods 105" in green. This also gives /imports its first inbound link from anywhere.
    (#28, ADD 16)

60. **[feature] (M) A freshness + coverage strip in the shell.** One persistent line above `main`:
    balances as of {date}, N days since last import, M accounts uncovered today (named), K open gaps,
    prices as of {date}, R rows awaiting review — each segment linking to the fix. `layout.tsx:22-46`
    already does two guarded DB reads. (#7, ADD 1) *Blocked by: 43 (build `<AsOf>` first).*

61. **[feature] (M) Export.** CSV of any filtered set (stream `matchingTransactionIds`,
    `transactions-query.ts:158`) and of every table; JSON of categories/merchants/rules/anchors; a raw
    `.db` download from /settings. `grep` finds **zero** export code in the repo — the app is a
    one-way sink holding five years of reconstructed history. Table stakes at tax time and the
    cheapest possible trust win. (ADD 2)

62. **[feature] (M) A visible ⌘K trigger, plus `/merchants` and `/categories` index routes.**
    `AppShell.tsx:50-59` is a wordmark, a static tagline and a theme toggle; the palette is the ONLY
    enumeration of merchants, categories, accounts and holdings and is keyboard-only — i.e. does not
    exist on his phone. Add a "Search… ⌘K" button and a mobile magnifier (**S**), then the two index
    routes with merge, alias panel and archive (**L**): Claude wrote ~434 merchant mappings on his
    behalf and there is no screen that shows them, while duplicate merchants are structurally
    guaranteed by `claude-categorize.ts:233-249`. (#51, #31, ADD 7, ADD 19, ADD 33)

63. **[feature] (M) `?series=`, `?importFile=`, `?source=` and `sort`/`dir` on the ledger.**
    `components/transactions/query.ts:17-31` + `transactions-query.ts:47-107`. Unlocks: every
    recurring number becoming a visitable list (the doctrine's own promise, honoured everywhere except
    the surface most likely to be wrong), an auditable /imports "Txns" count beside the un-import
    button, "why is this categorized as X" as a filter, and "what were my five biggest charges in
    June" — unanswerable today on the only full-ledger filter in the app. Pair with the filtered-set
    summary strip (total in/out/net/count/span, same predicate as the counts so it reconciles by
    construction). (#27, ADD 5, ADD 13)

64. **[feature] (M) Categorize from the report that tells you to categorize.** Wire the already-built
    `components/spending/InlineCategorizeList` and `loadSpendingCategoryTxns`
    (`spending/actions.ts:15-21`, whose own docstring calls it "the Spending page's inline
    categorizer") into /spending's Honesty card, each category row's expander and the largest-purchase
    sheet. It exists, has one consumer, and /spending cannot reach it — while categorization is his
    entire working pass. (#41, ADD 8)

65. **[feature] (L) A real rule editor with a match preview.** `RulesManager` reads a vocabulary it
    cannot write. Compose the full condition set (accountIds, amount range, direction, description
    regex) and action set (category, markTransfer, exclude, renameTo, series) that
    `renderRuleSentence` (`rules-manager.ts:63-93`) can already render, with the sentence as a live
    preview and the matching **rows** shown before Re-apply. He hand-categorized ~1,300 rows over a
    full pass because he could not express "every Wise transfer from dad is a Family pass-through" as
    a rule. Add a `reason` field to disabled rules — the exact rule that produced the $52,625
    phantom-income error sits disabled at the top of that list, one click from live, with no note
    saying why. (ADD 6, #40)

66. **[feature] (M) Missed occurrences, and a cancelled/paused/skip vocabulary.**
    `recurring-calendar.ts:24-78` already computes paid / paid_different / upcoming / **missed** per
    day and no surface says "missed". Add a per-series expected-vs-actual timeline with variance and a
    link to the charge; promote `ended` to "I cancelled this"; add a `recurring_skips` overlay honoured
    by projection and forecast; auto-pause when `isSeriesActive` goes false. Rent expected on the 1st
    with nothing posted by the 10th currently says "next expected Aug 1" and never mentions July.
    (ADD 12) *Blocked by: 13.*

67. **[feature] (M) Compare to the previous period, and to last year.** `/categories/[id]`
    (`SpendDelta` is imported and unused at `page.tsx:32`), `/spending` (the prior window is already
    computed at `page.tsx:87-90` and reduced to one ghost line, and the MoM delta is gated on
    `granularity === "month"` and hidden below `md`), the recurring calendar, and the dashboard hero.
    Two thirds of the plumbing is paid for on every render and thrown away. (#54, L4, S21, S22, ADD 26)

68. **[feature] (M) Account scope and a shared period bar on every analytical surface.** Promote
    `components/spending/PeriodSelector` to `components/ui` and mount on /budgets (whose
    `budgetPaceStatuses(db, refDate)` already accepts a historical date — so "did I hit my budget last
    month" is unanswerable purely because nothing passes one), /merchants/[id], /accounts,
    /investments and the dashboard. Add an account multi-select that scopes every aggregate;
    `portfolio.ts:191,240,252` already accept `accountIds` and nothing passes them. (ADD 4, ADD 9)
    *Blocked by: 37.*

69. **[feature] (M) Notes on every entity.** One nullable column plus the existing
    `InlineEditableText` on accounts, merchants, series, budgets, holdings and categories. "This is
    dad's money, it passes through" · "Citi promo run through Carson's account" · "$50 Travel is
    deliberate, Cancun was reimbursed". Pass 24 was 16 questions of him reconstructing what merchants
    were; every answer lives in a session-memory file instead of the app. Also extend search
    (`transactions-query.ts:111-122`) to cover notes and merchant names, which makes the existing
    notes feature stop being write-only. (ADD 28, ADD 36)

70. **[feature] (M) The escape hatches that are missing.** Expose `restore` and `clearTransfer` on
    `BulkActionBar.tsx:87-95` (the patch schema already supports both, and standing in the Excluded
    tab the only buttons are a no-op Exclude and Reviewed); wire the orphaned
    `deleteManualTransactionAction` (`cash-actions.ts:38-50`, **zero callers in the repository**);
    make `runCategoryCorrection` offer single-row undo instead of only "Apply to N"; add
    `unmergeSeries`, `unacceptGap`, `reactivateBudget`, and a merchant-default clear option to
    `CategoryPicker`. (#31, #62, #63)

---

## Phase 6 — Lock it in, then be ambitious

71. **[craft] (M) Extend the test gates to cover what this audit found.** (a) assert
    `document.documentElement.scrollWidth === clientWidth` at 390/768/1024/1440 for every route —
    `grep scrollWidth e2e/` currently returns **zero** and `toHaveScreenshot` clips the viewport, so
    overflow is invisible in a baseline; (b) add `/imports`, `/merchants/[id]`, `/recurring/[id]` to
    the axe and visual sweeps and run axe at a **phone width at least once** (it has only ever run at
    1280×720); (c) a second Playwright project with `hasTouch` so the `pointer-coarse` branches
    execute at all; (d) register the nine overlay states `interaction-states.spec.ts:15-22` promised
    and never got; (e) re-point `keyboard.spec.ts` off `/design/stage-0a` — the entire keyboard gate
    runs against a page users cannot reach, which is exactly why the a11y audit found the real routes
    lacking while the gate stayed green; (f) gate `/design/stage-0a` behind
    `NODE_ENV !== "production"` (it currently serves his real net worth, un-gated, in the build);
    (g) a perf budget: ≤300 KB gz JS, ≤3,000 DOM nodes, zero `[popover] [role=option]` before
    interaction. (#43, #92, K35, ADD 23) *Blocked by: 1, 25, 28 — write the gates after the fixes so
    they lock in a green state.*

72. **[craft] (M) Give charts a keyboard and screen-reader path.** New pure `stepSelection()` in
    `lib/scrub.ts` mirroring `stepScrubIndex`, wired into `ScrubChart.onKeyDown:370-375`, so the brush
    — the app's signature gesture on five surfaces — has a non-pointer route. Make the recharts
    drill-downs reachable on /spending (`CashFlowChart.tsx:97` gates `focusable` on month buckets, so
    the page's **default** period has zero keyboard chart interaction, and the Sankey ribbons are
    `aria-hidden` with `showTableToggle` false — unreachable by keyboard, screen reader **and**
    touch). Add a shared `<ChartDataTable className="sr-only">` inside every `<figure>`, fed by the
    same `chart-window.windowedPoints` slice `ScrubTable` already renders visibly. (#48, K31, K32,
    ADD 18)

73. **[craft] (M) Add the wide-screen tier the app has never used.** Breakpoint histogram is
    `sm 42, md 34, lg 12, xl 0, 2xl 0`; measured **1320px (52%) of a 2560px viewport is empty on every
    route**, main floating asymmetric to the sidebar. Lift `AppShell.tsx:32,65`'s `max-w-5xl` at 2xl
    into a context rail + wide canvas + detail rail for the four analytical routes; step chart heights
    past `sm:` (`ScrubChart.tsx:220` stops at `h-64`; `AllocationDonut.tsx:72` is a flat `h-44` from
    320 to 2560); add a density mode persisted beside `dashboardLayout` with a reset in Settings.
    Several route-level compromises exist only because of the cap. (#69, K30, ADD 19)

74. **[craft] (M) Motion that does work.** Define `--transition-ui`/`--transition-emphasis` and swap
    the **114** bare `transition-colors` sites (which specify no timing function and therefore ignore
    all six authored easing curves — three of which are dead, and a dead token is a lie about the
    system). Add hover lift on drill-down cards, `active:scale-[0.98]` on pills, a staggered bento
    entrance, `NumberRoll` count-up on stat tiles, a highlight flash on rows that just changed after
    an undo or bulk edit, and a shared-element morph from a table row into its sheet reusing the
    view-transition machinery `ChartFocus` already proved. (#71, S19, ADD 25)

75. **[feature] (L) The "why did it change" waterfall.** For any brushed window, decompose the delta
    into income, spending, market gains/losses, transfers in/out, pass-through and coverage drift,
    reconciling exactly to the delta the chart header already shows. Composes
    `services/period-activity.ts`, `portfolio-returns.decomposeValue` (which already produces the
    exact `netContributed + gains == value` identity, unit-tested) and `in-flight.transferFloats`.
    The chart says "+$24,759 (+28.8%)" and there is no way to ask why. Every input exists; nothing new
    needs deriving. Shared by the dashboard hero, `/accounts/[id]` and `/spending`. (ADD-amb 1)
    *Blocked by: 56 (the excluded-kinds buckets are half the waterfall).*

76. **[feature] (L) Provenance drawer + basis ribbon on `/accounts/[id]`.** The headline opens a
    drawer reconstructing the level: the winning anchor it replayed from (date, source, amount), the
    count and sum of transactions replayed since, whether the chain closed to the cent, and how many
    days are carried vs derived vs missing. Under the chart, a thin band with one segment per span,
    clickable to zoom. This is the product's single best idea — "daily_balances is a derived cache,
    truth is transactions + anchors" — and the page currently shows the cache and hides the
    derivation. It also fixes, visually, the fact that a manual anchor silently loses to a statement
    anchor and that an anchor on an investment account is accepted and never read. (#29, #30,
    ADD-amb 3) *Blocked by: 47.*

77. **[feature] (L) Net worth by composition over time — the abstract one.** A stacked-area /
    streamgraph of cash vs brokerage vs crypto vs debt as bands across two years, scrubbable on the
    same day axis, with the same coverage honesty (partial days soft, gaps not invented). Ships as a
    7th option appended to the existing `DASHBOARD_VIEW_SPEC` dimension, plus a per-institution
    variant on /accounts from the combined arrays `institution-groups.ts:196-205` already computes.
    Reuses `accountSeries` + `multi-series.alignOverDays`, so it costs **no new math**. This is the
    one that is both spectacular and truthful. (ADD-amb 4)

78. **[feature] (M) Contributions vs market gains over time, and overlay compare.**
    `decomposeValue` already produces the exact identity and is unit-tested — it just needs evaluating
    per day, turning today's single static `DecompositionBar` into a stacked area. And `ScrubChart`
    already supports named `overlays` with per-series coverage splitting and a legend
    (`:294-322, 669-696`), driven today by exactly one consumer: wire sibling-account compare on
    `/accounts/[id]`, 2–3 simultaneous benchmarks on `/investments`, and holding-vs-holding on the
    symbol page. The engine is built, tested and in production on one surface. (ADD-amb 6, ADD-amb 12)

79. **[feature] (L) Cash runway and a 14-day calendar with the projected low point.** "Liquid $X ·
    N days at your current burn" with a depletion sparkline, and a day-column strip flagging the
    paycheck and marking the tightest projected day. Inputs already exist: `latestBalances`,
    `cashFlow` spend rate, `upcomingOccurrences`, `forecast.ts:325-334`. Net worth includes an $88k
    portfolio and cannot tell him whether rent clears next week — the operative question on a variable
    cash income. Fix `beforePaycheck` while here: it windows on the next income occurrence, so for a
    **weekly** earner it is structurally $0.00 (window on `max(next paycheck, +14 days)`). (#B17,
    ADD-amb 5) *Blocked by: 13.*

80. **[feature] (M) The subscription audit.** A fourth /recurring tab ranking every subscription and
    bill by annualized cost (`recurring.ts:534-537`) with an amount-history sparkline, total
    monthly-equivalent burn, cost-since-first-charge, and price-creep detection ("$9.99 → $12.99 on
    Mar 14 (+30%) … you have paid $187.44 more than the original price"). He cannot currently answer
    "how much am I committed to per year?" without adding 31 numbers by hand. (ADD-amb 7)
    *Blocked by: 39 (sortable table).*

81. **[feature] (L) The budget visualization suite + re-predict existing budgets.** /budgets is the
    only major surface with **zero** data visualization (verified by grep: no ScrubChart, Sparkline,
    StatCard, lens or focus). Per row: a 12-month actual strip with the budget as a reference line and
    a hit-rate squares strip from `categoryMonthlyTrend`. Page level: budget-vs-actual with a
    chart⇄table lens and focus, and a radial burn dial. Plus `repredictBudgets(db)` running
    `predictBudgetableCategories` over the **budgeted** set, which `predictBudgets` deliberately
    excludes — which is why "Predict budgets" returns 3 rows, 2 at 0% confidence, while 8 of his 10
    budgets are >15% off their own actuals. Design the two bar extremes at the same time (108% over
    and 4,898% over are currently pixel-identical, and `aria-valuenow` disagrees with
    `aria-valuetext`). (#70, L19, ADD-amb 8) *Blocked by: 16, 50.*

82. **[feature] (L) A statement-period timeline ribbon on /imports.** A horizontal time axis per
    account, periods as segments coloured by reconciliation state, transaction density as a histogram
    inside each segment, anchor ticks where chain-grade anchors land, and **visible white where no
    statement exists** — brushable, with a segment opening the file detail sheet. Reuses `ScrubChart`'s
    coverage band and `lib/chart-axis.ts`. It is "think abstract" pointed at the one question the
    trust layer cannot answer, and it turns the plainest screen in the app into the most striking.
    (ADD-amb 9) *Blocked by: 59.*

83. **[feature] (L) The 3D layer, as progressive enhancement.** A WebGL net-worth composition ribbon
    or symbol×day P/L surface, consuming only the existing pure, DB-free, unit-tested math
    (`multi-series.alignOverDays`, `portfolio-returns.decomposeValue`, `sankey-layout`,
    `chart-axis.niceLinearTicks`, `chart-window.windowedPoints`). Ships as an appended option on an
    existing ViewSpec dimension, behind `next/dynamic` with `ssr:false`, with a 2D fallback for
    reduced-motion and low-memory devices. Budget: three.js core + a thin r3f slice ≈ 250 KB gz,
    while items 1 and 25 return more than that. **The real blockers are not bundle size** — they are
    iOS Safari OOM (`/transactions` holds 32,557 DOM nodes and 9,098 SVG paths before any GL context),
    main-thread contention (zero Suspense boundaries, so hydration starves the first frames) and touch
    orchestration. (ADD-amb 21) *Blocked by: 1, 24, 25, 29.*

84. **[feature] (L) Hosting, tracked as a decision rather than discovered on deploy day.**
    `src/middleware.ts:14-20` 403s every Host that is not localhost — correct today, a total outage
    the moment it is deployed, and nothing in the repo says so. Replace it with real auth; move the
    client-supplied `UndoPatch` server-side behind a short-lived token or HMAC
    (`transactions/actions.ts:477-495` + `bulk-edit.ts:204-257` currently accept arbitrary row writes
    plus a rule delete by id, shape-validated only) — harmless on loopback, a cross-tenant write
    primitive the day there are two users. And pick the runtime deliberately: `better-sqlite3` is
    native and synchronous and cannot run on edge, and the pass-13 Turso investigation priced the
    async rewrite at ~68 files. (#78, ADD 35) *Blocked by: 24, 27 (a 1.4s synchronous render is a
    free-tier timeout).*

---

## Deferred deliberately

- **Trade entry (Buy/Sell/Dividend) and a trade log** (`L`) — real, but the investments half is not
  statement-fed at all (`holding_events` is written only by the manual form; the import pipeline
  deliberately discards Robinhood holdings rows at `pdf-profile.ts:171`, and the script that built the
  1,991-event timeline is no longer in the repo). Decide the *architecture* question first: does the
  importer feed positions, or does the manual form stay the source? Everything else here is downstream
  of that answer. (ADD 15)
- **Tax lots and cost-basis reconciliation** (`L`) — unrealized P/L uses broker average cost while
  realized uses an average-cost walk at daily closes, and the two sit adjacent with nothing stopping a
  reader from adding them. Add the "these are not additive" line now (item 50); build lots later. (ADD 16)
- **Mutation log / operations log** (`L`), **anomaly engine** (`L`), **alert history and period-close
  digest** (`L`), **interest and APY** (`L`), **savings goals** (`L`), **`.ics` bill export and
  shareable snapshot** (`S`), **percentage helpers in the split editor** (`S`), **prev/next sibling
  navigation on detail routes** (`S`), **first-run guided path** (`L`), **integrity checker + soft
  delete + rehearsed restore drill** (`L`), **living design system specimen route** (`M`). All are
  real and all are in `06-what-to-add.md` with their reasoning; none of them changes a wrong number or
  loses data, so none of them outranks Phases 1–4.
