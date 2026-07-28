# MoneyApp — Adversarial Review

**Date:** 2026-07-27 · **Branch:** `claude/app-polish-adversarial-review-e80abb` · **Base:** `e49fb12`
**Method:** 6 comprehension agents, 14 route-interrogation agents, 7 cross-cutting agents. Every claim below carries a `file:line`. Measured numbers were taken from a live Chromium against a production `next build`, and from `tsx` probes against a copy of the real 12.8 MB database. Where agents disagreed or a claim is inferred rather than executed, it is marked **[unverified]**.

**Verdict in one line:** the engine is better than the products you are competing with; the *product wrapped around it* is a data-model tour with no safety rails, no loading states, no error states, and two of its nine destinations unreachable from anywhere but the nav.

---

## 1. What this app is (the goal)

MoneyApp is **a personal forensic-accounting instrument**, not a budgeting app.

The premise every other product declines to make: *statements are the only truth.* There is no Plaid, no bank API, no feed. You download the PDFs and CSVs your banks actually print, drop them in, and the app reconstructs your financial history from them — and then tells you, for every single day, exactly how much of that history it can prove.

That last clause is the whole product. `derivation.ts:147-158` refuses to interpolate a slope across a span it cannot verify; it stamps the day `gap` and keeps the replayed number visible so a human can inspect the drift. `import/service.ts:850` refuses to accept a statement whose beginning + transactions ≠ ending, to the cent, and quarantines the rows instead. `spending.ts:73-95` refuses to let a large refund drag a Spent figure negative. `sankey.ts:17-21` balances in ≡ out by construction. Four independent engines, written at different times, all made the same call: **fail honestly rather than smooth it over.**

### Why statements-not-Plaid matters

| | Monarch / Copilot / Mint | MoneyApp |
|---|---|---|
| Source of truth | A vendor's normalized feed | The PDF your bank printed |
| History depth | However far back the aggregator reaches | However far back you can download |
| Balance provenance | "The bank said so" | Replayed from anchors + transactions, with a per-day verdict |
| Reconciliation | Never surfaced | `beginning + Σ txns = ending` or it is flagged with its exact gap |
| Cash, family money, gambling flows | Invisible or mis-attributed | Modelled, because you told it |
| Data location | Their servers | `data/moneyapp.db` on your machine |
| If the connection breaks | Silent staleness | You notice, because coverage is stated |

A feed-based app **cannot** make the reconciliation promise, because it never sees a printed balance to reconcile against. That is the moat.

### Who it is for

One person with a genuinely non-standard financial life: a cash job with irregular pay, a father's money passing through his accounts, gambling inflows and outflows, a Robinhood settlement-cash ledger, a 1,991-event brokerage timeline reconstructed from an activity CSV, and ~1,300 rows hand-categorized over 24 working passes. No aggregator would produce a correct picture of that. This app was built because none of them could.

### Where it has drifted

Three honest observations, offered so you can push back:

1. **The engine's best output never reaches a screen.** `derivation.ts` classifies every single day as `derived` / `carried` / `derived_unverified` / `gap`. That verdict reaches exactly two UI surfaces: a dashed chart stroke and a Basis column in the table lens. There is **no summary anywhere** answering "is this screen trustworthy?" — measured today, the hero prints an eight-day-old net worth with no date, and `/imports` reports "Open gaps 0" in green while two of your accounts have had no statement since 2024.
2. **The nav is a schema tour, not a workflow.** The verb chain is ingest → reconcile → classify → interpret → decide. The nav is nine nouns. The two ends of that chain — `/imports` and `/budgets` — are the only two routes in the codebase with **zero inbound links** from any other page (verified by grep: `nav-items.ts:19` and `nav-items.ts:22` plus one reference at `category-detail.ts:180`).
3. **You built a bulletproof undo system and wired it to the safe actions.** `services/bulk-edit.ts:100-184` returns a lossless server-captured inverse patch for every bulk mutation. Marking one row reviewed gets an Undo toast. Hard-deleting 2,149 transactions does not.

Fix those three and this is a product. Leave them and it stays an instrument only you can operate.

---

## 2. How it all connects

### The spine

```
  BANK PDFs / CSVs / OFX
          │
          ▼
  ┌───────────────────────────────────────────────────────────────┐
  │ IMPORT  src/services/import/service.ts                        │
  │  sniff → profile match → parse → canonical net-worth sign     │
  │  identity = sha256(file) + parserVersion   (idempotent)       │
  │  row identity = dedupeHash(acct, date, cents, RAW desc, occ#) │
  │  fidelity order: OFX(0) < CSV(1) < PDF(2)  → ownership skip,  │
  │                                              takeover, dedupe │
  └───────────────────────────────────────────────────────────────┘
       │                 │                    │
       ▼                 ▼                    ▼
  transactions    balance_anchors      statement_periods
  (immutable)     (ground truth)       (printed bal → reconcile)
       │                 │                    │
       │                 │                    └─► gap? → quarantine rows
       │                 │
       ▼                 ▼
  ┌───────────────────────────────────────────────────────────────┐
  │ CATEGORIZE  categorize.ts → detectTransfers → claude fallback │
  │  precedence: user > rule > merchant_map > bank_cat > credit   │
  │              match > (claude)                                 │
  │  candidate set = status active AND category IS NULL           │
  │                  AND source IS NULL OR source != 'user'       │
  └───────────────────────────────────────────────────────────────┘
       │
       ▼
  ┌───────────────────────────────────────────────────────────────┐
  │ DERIVE  derivation.rebuildAccount  (DELETE + re-INSERT)       │
  │  daily_balances = f(anchors, transactions)  ← A CACHE          │
  │  chain-grade anchors {statement, manual} = replay endpoints    │
  │  per-day basis: derived | carried | derived_unverified | gap   │
  │  investment accts w/ holding_events → crypto-history instead   │
  └───────────────────────────────────────────────────────────────┘
       │
       ▼
  ┌───────────────────────────────────────────────────────────────┐
  │ ANALYTICS  analytics.activeTxnsInRange  (splits EXPLODED)     │
  │  ONE row source for every spending/income aggregate            │
  │  netWorthSeries + in-flight bridge → the hero number           │
  └───────────────────────────────────────────────────────────────┘
       │
   ┌───┴────┬─────────┬──────────┬──────────┬──────────┬─────────┐
   ▼        ▼         ▼          ▼          ▼          ▼         ▼
  /      /spending /budgets /recurring /investments /accounts /transactions
```

### Overlays and side-channels

| Layer | Table | Rule |
|---|---|---|
| Splits | `transaction_splits` | Parent immutable; parts sum EXACTLY; ≥2 parts; `ON DELETE cascade` (the only cascade in the schema) |
| Transfers | `transactions.transfer_group_id` | Auto-pair ONLY on two-sided/structural evidence + mutual-nearest; single-sided hints only FLAG |
| Recurring | `recurring_series` + `series_link_source` | User overrides shadow detection's columns; detection never re-touches a `user`-linked row |
| Holdings | `holding_events` × `price_cache` | Signed dated qty deltas; NAV = cumsum × close. **No importer creates these** — the real timeline came from ad-hoc scripts |
| Learning | `merchants` + `merchant_aliases` + `rules` | Rules: ascending priority, first match wins. `mappingSource='user'` wins permanently |

### The reconciliation contract — what must equal what

| These must agree | Where enforced | Status |
|---|---|---|
| Tab count ≡ rendered rows ≡ bulk-mutation set | one predicate `transactions-query.ts:47` | **holds** |
| Chart hero number ≡ table lens hero number | same `summarize`/`formatValue` objects `ScrubTable.tsx:44-53` | **holds** |
| Inline card ≡ focus dialog | one `renderPanel` called twice `ChartFocus.tsx:127,169` | **holds** |
| Sankey ribbons in ≡ out | by construction `sankey.ts:17-21` | **holds** |
| Split parts Σ ≡ parent | `lib/transaction-splits.ts:70-88` | **holds** |
| Budget tail ≡ /recurring projections | shared `projectOccurrences` `budgets.ts:342` | **holds** |
| StatCards ≡ cashFlow ≡ heatmap ≡ Sankey ≡ periodActivity | all GROSS | **holds** |
| Spent card ≡ "Where it went" table | **THREE different bases** | **BROKEN** — §4 |
| /spending category number ≡ /categories/[id] number | period dropped on the link | **BROKEN** — §4 |
| Spent card ≡ the list its href opens | not split-aware `transactions-query.ts:58-81` | **BROKEN** — §4 |
| Portfolio realized P/L header ≡ visible rows | header walks all legs, rows filter `isActive` | **BROKEN** — §4 |
| Holdings market value ≡ account balance headline | two pipelines | **BROKEN** — §4 |
| daily_balances ≡ transactions + anchors | nothing detects a desync | **BROKEN** — §4 |

### Sign convention (one rule, one exception)

Every `amount_cents` and `balance_cents` is **net-worth-signed**. Credit balances are negative. Parsers normalize at the boundary. The **only** place a UI-facing "amount owed" is flipped is `anchors.ts:27-30`.

### GROSS vs NET — the unlabeled fork

| GROSS (debits only, credits → `refundsCents`) | NET (refunds subtract) |
|---|---|
| `spending.periodTotals:73` | `analytics.categoryBreakdown:279` |
| `cashFlowByPeriod:157` | `analytics.monthlySpending:235` |
| `dailySpendHeatmap:438` | `analytics.categoryTrends:380` |
| `sankey.spendingSankey:56` | `analytics.categorySpending:453` |
| `periodActivity:56` | ← used by budgets, category pages, /spending's table |

Both conventions are deliberate and documented at their definitions. Nothing warns a caller which one they picked up — **and both render on `/spending` simultaneously**.

---

## 3. What's genuinely good

Ranked by "protect and propagate."

### 1. The honesty apparatus — this is the product
`derivation.ts:147-158` keeps replayed values for a chain that does not close and stamps them `gap` so a human can inspect the drift, rather than discarding or smoothing. `netWorthSeries:315-331` trailing-carries a stale account forward and reports exact `missingAccounts` by name. `NetWorthChartPanel.tsx:92-93` suppresses the % delta unless BOTH window endpoints are complete, so a partial endpoint can never fabricate a percentage. `ScrubTable.tsx:147-149` refuses to caption a window it is not actually showing (`fellBack`). `SpendHeatmap` uses the **sign**, not colour alone, to carry direction. `ReturnViewParts.tsx:244-251` names the benchmark's own first-priced day rather than claiming "all time." No consumer finance product does any of this.

### 2. The keyscope stack — `src/lib/keyscope.ts`
Explicit numeric priority tiers instead of push order; `modal: true` stops the dispatch walk; in-place re-push so a conditional binding cannot reorder equal-priority scopes (`:161-168`); editable targets ignore plain mnemonics but still see `mod+…` and `escape`; IME composition guarded at the provider; 800ms chord expiry. Pure, unit-tested, reasoning written at the top of the file. **Escape genuinely closes exactly one thing, app-wide.**

### 3. The bulk-mutation + undo contract — `services/bulk-edit.ts:100-184`
Server-captured lossless inverse patch of exactly the fields touched. `applyUndoPatch:204-257` treats its own input as hostile: never SETs `superseded`, never restores a transfer link onto a since-split row. `transfer-links.ts:135-137` captures ONLY `transferGroupId` with the reason written down ("undoing an unlink must not clobber category/review edits the user made in between"). Action toasts never auto-dismiss (`Toast.tsx:23-24`). This is production-grade.

### 4. The `source='user'` shield
Five independent write paths enforce it, and the SQL subtlety is documented where it matters: `categorize.ts:178` and `claude-categorize.ts:106` both carry the comment *"NULL != user is NULL in SQL, not true."* `categorize.ts:463-467` then generalizes it correctly — the transfer detector protects a row categorized outside Transfers by **any** source, not just `user`, crediting the 2026-07-15 review that found the bug. (Two holes remain — §4 #14.)

### 5. Import idempotency and the no-silent-drop rule
`(file_sha256, parser_version)` uniqueness makes re-dropping a folder a no-op. Every non-insert path increments a **named, visible** counter — `skippedOwned`, `deduped`, `dedupedCrossFormat`, `supersededTakeover`, `quarantined` (`service.ts:41-58`). `dedupeHash` covers the **RAW** description, never the normalized one (`lib/hash.ts:3-8`), with the reason recorded: the normalizer evolves, and hashing its output would re-duplicate the entire ledger. Parsers fail **loudly** on drift rather than importing a guess.

### 6. `ChartFocus` — a small masterpiece of correctness
`ChartFocus.tsx:132-139` documents a real Chromium trap: intercepting the dialog's `cancel` to run a view transition consumes the close-watcher's activation grant, stranding the modal open. It chooses correctness over decoration. The inline card stays mounted so focus returns to the same node; the morph is `flushSync`'d inside `startViewTransition`; backdrop close requires a full press+release so an overshooting drag cannot dismiss.

### 7. Four returns stated as four separate facts — `PortfolioStats.tsx:22-131`
TWR, XIRR, unrealized cost-basis P/L and realized P/L, each with its own caption, never summed. Most consumer apps show one number and hide the definition.

### 8. `e2e/axe-helpers.ts` — `analyzeSettled`
Axe computes contrast from *mid-animation blended* colours; the route fade-rise made a passing palette scan as a serious violation at 4.2:1. This waits on every **finite** animation's `finished` promise (deterministic, not a timeout) and skips infinite loops. Almost nobody catches this.

### 9. The token contract — `src/app/globals.css`
60 tokens defined twice with contrast reasoning **inline at the point of decision** (`:15` "≥4.5:1 on all three surfaces"; `:65-67` documenting that `--positive-soft` exists because a /12 tint landed at 4.45:1). **Zero `dark:` variants exist anywhere in the repo** — the dark theme is architecturally incapable of drifting from light. `.figures` (`:230-234`) does three jobs in one class so money never reflows.

### 10. The chart layer's re-render discipline
`ScrubChart.tsx` carries 13 `useMemo` hooks with tight dependency arrays; **all five** consuming panels wrap their callbacks in `useCallback`. Every recharts series sets `isAnimationActive={false}` except the one deliberate reveal.

### 11. The server/client boundary
Across all 91 `"use client"` files, **every single** import from `@/services` is `import type` (grep-verified). Not one line of drizzle or better-sqlite3 can reach a browser chunk.

### 12. The reduced-motion collapse — `globals.css:241-252`
Kills `animation-delay` as well as duration, with the reason written down: a staggered entrance with `fill-mode: both` would otherwise hold its invisible first frame for up to 300ms. `ScrubChart.tsx:950-955` then drops the pulse *class* rather than trusting the global rule, because an infinite pulse would rest on an invisible frame. `sheet.module.css:87` covers `::backdrop`, which `*` cannot select.

### 13. The `Sheet` primitive
`sheet.module.css` ships a bottom sheet at `max-height: 85dvh` below 48rem and morphs to a right drawer above it, with separate `@starting-style` entrances per axis. `Sheet.tsx:64-67` lands initial focus on the scrollable **body**, not the Close button, so readers hear content first and Enter cannot instantly re-close. **This is the only component in the app that treats the two form factors as different products.**

### 14. Selection safety
`TransactionsLedger.tsx:124-129` force-resets selection on any params change, with the reasoning written down — this is the exact bug ("select all" silently re-binding to a new result set) that ships in real products, and there is an e2e regression for it. `clusterMatchingIds` and `similarGroupIds` recompute the live set **server-side** from an opaque ref.

### 15. `editAccount` blocks a type change while `holding_events` exist
`accounts.ts:206-218` — the only place in the app where a schema-level edit is refused purely to protect a derived cache. Exactly the right instinct.

---

## 4. What's bad

One ranked table. Deduplicated: a defect found on five pages is **one row naming five pages**.

### CRITICAL

| # | Surface | Problem | Concrete failure | file:line |
|---|---|---|---|---|
| 1 | **All 15 routes** | No `error.tsx`, `global-error.tsx`, `not-found.tsx`, `loading.tsx` or `Suspense` **anywhere** (verified: `find` returns nothing; `grep Suspense src` returns 0) | Type `about 5k` into a balance field → `MoneyParseError` escapes a `Promise<void>` action → the entire screen is replaced by Next's stock "A server error occurred · ERROR 4062620856" and every field you typed is gone. Same for a Zod out-of-range AI cap, an expired API key, an ENOENT in `listBackups`, and one malformed `app_settings` row (which blacks out 7 routes at once). Separately: every navigation freezes the previous page for 0.3–2.0s of synchronous SQLite with zero feedback | `src/app/` (absent) · `accounts/actions.ts:57,77` · `settings.ts:50-54` |
| 2 | **8 destructive ops across 5 routes** | Consequence and ceremony are **inversely correlated**. 18 actions return `Promise<void>`; the 7 that return `ActionResult`+toast+undo are the *safe* ones. There is no confirmation primitive in the app at all (`grep 'confirm('` → one local function name) | Un-import (`imports/page.tsx:198`, 8px grey text, 88 identical buttons) hard-DELETEs a file's transactions **including ~1,300 hand-categorized rows**, cascading every split, with no confirm/count/undo. Archive account silently moves net worth $11,020.45. Delete anchor can flip months of chart to `gap`. Deactivate budget is unrecoverable — no screen lists inactive budgets. Merge series has **no unmerge function anywhere in src/** | `imports/actions.ts:23` → `service.ts:974` · `accounts/actions.ts:84,94` · `budgets/actions.ts:90` · `recurring-links.ts:168-190` |
| 3 | **Backups** | `maybeSnapshot` has exactly **one caller** — server boot — and short-circuits if today's file exists. No mutation path snapshots. Settings can only *list* filenames | Start dev at 9am (snapshot), hand-categorize 200 rows, un-import the wrong file at 6pm → the only restore point is 9am, and recovery is a manual `cp` you have never rehearsed. `MONEYAPP_SKIP_BACKUP=1` silently disables the entire net with no UI indicator | `backup.ts:37` ← `boot.ts:19-24` · `settings/page.tsx:16-26` |
| 4 | `/transactions` (+ every page with a picker) | **`Popover` renders `{children}` unconditionally while CLOSED**. `CategoryPicker` mounts a full 67-option listbox per instance × 10 call sites | MEASURED: /transactions ships **4,054 KB of HTML / 32,557 DOM nodes**, of which **31,036 (95.3%)** sit in 51 closed popovers — 3,350 `role="option"` and 9,098 SVG paths nobody will see. 36.9ms of DOM parse on an M-series Mac ≈ 200ms on a phone. Projected at your real 404-cluster review backlog: 808 pickers → 54,136 option nodes → ~59 MB of HTML. The correct pattern (`if (isOpen)`) is 3 files away at `CommandPalette.tsx:141` | `src/components/ui/Popover.tsx:125` |
| 5 | `/` `/spending` `/investments` | **recharts is emitted FIVE times.** 5 byte-length-identical 380,657-byte chunks; no `next/dynamic` anywhere in the repo | Walking dashboard → spending → investments downloads **1.14 MB raw / ~322 KB gz of the same library** with zero cache reuse. recharts is 2,239 KB of the app's 4,548 KB total static JS (49%). /investments = 548 KB gz initial, **1.83× your own stated 300 KB budget** | `ScrubChart.tsx:12` (+4 more) |
| 6 | Every cross-surface link | **"The period I am looking at" is not an app-level concept.** `resolvePeriod` has exactly TWO route callers (`spending/page.tsx:52`, `categories/[id]/page.tsx:65`); everything else hardcodes `today` | On `/spending?period=2026` you read "Groceries $14,200", click it, and land on a page showing **$980** for July. Same category, one click, 14× different number, no explanation. Both e2e specs that touch this page re-append `?period=2026` **by hand** — the workaround is committed to the test suite | `lib/period.ts:161` · `SpendingCategoriesTable.tsx:105,154` · `BudgetRow.tsx:77` |
| 7 | `/imports`, `/budgets` | **Zero inbound links** from any of the other 14 routes (grep-verified: `nav-items.ts:19` / `:22`, plus `category-detail.ts:180`) | The dashboard prints "partial · 8/9 covered · missing Chase Checking" and links nowhere. On the real DB two accounts have had **no statement since 2024** while /imports reports "Open gaps 0" in green. You created 9 real budgets; the dashboard, /spending's table, and the nav badge never mention them | `nav-items.ts:19,22` · `page.tsx:175` |
| 8 | Mobile, 6 route/viewport combos | **Five routes scroll horizontally at 390px**, three still at 768px. Root cause: only **1 of 31** grid declarations uses `minmax(0,1fr)` | MEASURED at 390px: /investments 657 vs 390 (**+267px, pans 267**), /recurring?tab=all +207, /spending +85, / +67, /transactions +17. This defeats `DataTable`'s own `overflow-x-auto` — the wrapper renders 591px wide instead of scrolling inside 358px | `investments/page.tsx:181` · `page.tsx:217` · `ui/DataTable.tsx:175` |
| 9 | Mobile navigation | `MobileNav` renders a 796px pill rail in a 390px viewport and never scrolls the active item into view | MEASURED: **406px (51%) of the app's navigation is off-screen**, and on **5 of 9 routes** the `aria-current=page` pill is entirely outside the visible rail. On /investments you cannot see you are on Investments, and Spending onward are undiscoverable. No fade, no arrows, no bottom tab bar, no fallback (SideNav is `hidden md:flex`) | `MobileNav.tsx:14` |

### HIGH

| # | Surface | Problem | Concrete failure | file:line |
|---|---|---|---|---|
| 10 | `/transactions`, all bulk paths | **"Mark as transfer" sets a badge and leaves the money counted as spending.** `bulkApply` and `setTransactionFlags` set ONLY `transferGroupId`; analytics excludes transfers purely by category **kind** and never reads it | Select 40 internal transfers → "Marked as transfer · 40" → /spending, the Sankey, the heatmap and every budget keep counting them. `linkTransferPair:110-118` DOES stamp a Transfers category, so two identical-looking controls produce different analytics. Your spending totals are silently inflated by however many rows you marked this way | `bulk-edit.ts:168-173, 285-292` |
| 11 | `/transactions` | **Pressing "Filter" silently deletes `merchant` / `flow` / `amountMin` / `amountMax`.** The GET form posts only its own fields; `hasActiveFilters` omits them so no Reset link even appears | Click "View all 312 →" from a merchant → land on `?merchant=<id>` → the FiltersBar renders **completely empty** → type a date, press Filter → you are now looking at the **entire ledger** for that range while believing it is scoped, and any bulk action hits that set | `FiltersBar.tsx:27-31` |
| 12 | Import re-parse | **A parser-version bump destroys every hand-edit on that file.** `supersedeFileContribution` hides the old file from `coveredRanges`, so `lowerOwners` is empty, no takeover fires, `insertTxn` runs with `carryFrom=null`, and `migrateSplits` (which lives in the takeover branch) never runs | Improve the Chase PDF parser, bump the version, re-drop 24 statements → every category, note, transfer link and series link is gone, every split is orphaned on a superseded parent. `docs/schema.md:94-95` explicitly promises the opposite. **Zero tests cover this** | `import/service.ts:396-405, 548, 772-786` |
| 13 | `/investments` | **Adding a holding through the UI fabricates a loss.** `addHoldingAction` appends a `holding_events` row and never calls `rebuildAccount`; flows read events directly while NAV reads the cache | MEASURED on a copy of the real DB: adding 1 AAPL dated 2026-07-17 changed that day's return from −$1,597.79 to −$1,931.53 and dropped headline TWR 6.485% → 6.084%, while the value chart did not move. Worse: if the symbol has no cached closes, the next rebuild **truncates the whole account's history** — portfolio $88,968 → $47,087, net worth $84,858 → $42,977, and the trailing carry-forward re-marks those days `complete:true, missingAccounts:[]`. No warning anywhere | `investments/actions.ts:50-61` · `crypto-history.ts:110-117` |
| 14 | Claude + merchant backfill | **Two holes in the `source='user'` shield**, both in automated write paths | `claude-categorize.ts:264-270` filters only description + active + NULL category — its own queue applies the user guard nine lines earlier at `:106`. A row you touched with a NULL category is invisible to the queue and fully writable by the update. Same hole at `merchants.ts:115-122`, whose doc comment claims it "never overwrites an existing categorization." Compounding it, `:233-249` correctly refuses to overwrite a user merchant *default* and then stamps Claude's category on the rows anyway | `claude-categorize.ts:264-270` · `merchants.ts:115-122` |
| 15 | Balance chain | **Two UI paths mutate replay membership without invalidating the cache, and there is no repair path** | Replay includes `active`+`excluded` but not `quarantined`. Restore 40 quarantined rows from the Excluded tab → those amounts now belong in the replay; `daily_balances` still reflects a chain without them. `bulk-edit.ts` never imports `rebuildAccount`. Net worth is silently wrong until an unrelated import happens to rebuild. `rebuildAllAccounts` has **zero callers** in src/, scripts/ or boot | `bulk-edit.ts:164-167, 296-298` · `derivation.ts:235, 260` |
| 16 | Everywhere a date is shown | **Freshness is computed by four services and rendered once, as a raw ISO string.** Five components label stale data "today" | MEASURED: `netWorth.asOf` = 2026-07-19, today = 2026-07-27 — `dashboard.ts:131` computes it, `page.tsx` renders it nowhere. `PortfolioStats.tsx:27` is `Today{overview.dayChangeVsDay ? "" : ""}` — a **dead ternary with two empty branches**, the fossil of the disclosure someone meant to write. `holding-detail.ts:299` computes `quotedOn`; grep says nothing renders it. The app that refuses to invent a balance confidently misdates every number on its home screen | `dashboard.ts:131` · `PortfolioStats.tsx:27` · `InvestmentsTeaser.tsx:55` · `InstitutionCard.tsx:28` · `PositionCard.tsx:50` |
| 17 | Touch, all routes | **48% of interactive elements are under 44px, and the design system cannot produce a 44px control.** `Button` has only `sm` (24px) and `md` (32px); `IconButton` only `size-6`/`size-8`. No `lg`, no `pointer-coarse:` bump | MEASURED at 390px across 18 routes: **709 of 1,470** interactive elements under 44px in at least one axis. Worst: /accounts reorder chevrons at **14×14px** stacked 14px apart; /settings 24px delete adjacent to 24px chevrons with no confirmation; /budgets 71×20 "Deactivate" beside 49×20 "Edit". On two surfaces the *destructive* control is a sub-24px target next to a benign one | `ui/Button.tsx:19-21, 60-63` · `ManagedAccounts.tsx:114-131` |
| 18 | Touch + keyboard | **No coarse-pointer tier.** The correct pattern exists in 2 files and was never propagated; `globals.css` has no `pointer: coarse` query at all | ~50 affordances do not exist on a phone: `StatCard`'s drill arrow (every stat card on 4 surfaces), `InlineEditableText`'s pencil (the rename control on all 4 entity pages — they look like static text), `MonthlyTrendBars`' hover (the only way to read a value off the category chart), and **55 `title=` attributes** of which ~20 carry the honesty copy — the ≈ explanations, the forecast basis, the parser error string | `globals.css:241` · `StatCard.tsx:45` · `InlineEditableText.tsx:123` |
| 19 | Design system | **`ui/Tooltip.tsx` has ZERO consumers. `ui/Skeleton.tsx` has ZERO consumers.** Both are complete and unused | Tooltip implements 300ms hover intent, immediate on focus, Esc dismiss, `aria-describedby`, `popover="manual"`. In its place, native `title` on non-focusable spans delivers the entire estimate-disclosure vocabulary — invisible on touch and keyboard. Skeleton is unused while 15 force-dynamic routes have no loading state | `ui/Tooltip.tsx:32` · `ui/Skeleton.tsx:5` |
| 20 | Type scale | **92% of all text is 10–14px, and 39 of 49 `<h2>` headings are `text-sm font-medium` — byte-identical to body copy.** Zero `--text-*`, `--space-*` or `clamp()` tokens exist | 261 `text-xs` + 254 `text-sm` + 102 `text-[11px]` + 15 `text-[10px]` = 632 of ~685 declarations. `text-base` appears **once**. On /budgets, a section header, a budget name, the money, the verdict and a destructive control all render 11–14px — there is no visual answer to "what do I read first." 119 hardcoded pixel values across 58 files, identical on a phone and a 2560px monitor. Directly violates your own `web/coding-style.md` | `globals.css:189-190` · `PageHeader.tsx:9` |
| 21 | `/transactions` | **The page cannot answer "why is this categorized as X?"** `categorizationSource` is never selected, never mapped into `LedgerRow`, never rendered. The confidence *number* is never shown | The sheet's "Matching rules" panel explicitly disclaims being the cause (`TransactionSheet.tsx:333-337`). In an app whose entire pitch is auditability, the single most consequential derived field is unauditable | `transactions/page.tsx:95-111` · `ledger-rows.ts:42-68` |
| 22 | `/transactions`, `/recurring` | **"Run categorization" re-inflates the review queue you just drained, reports nothing, and cannot be undone** | `detectTransfers` pass 2 unconditionally re-sets `needsReview=true` on every contended outflow, and `bulkApply({markReviewed})` stores no dismissal memory. Pass 24's 404→0 drain is undone by one click. Both engines RETURN stats; the action discards both and redirects | `categorize.ts:631-646` · `transactions/actions.ts:122-134` |
| 23 | Claude button | **`classifyPendingMerchants` has `try/finally` but no `catch`**, awaited inside a form navigation | ~430 merchants = 9 sequential Haiku calls in one blocking request. An expired key rejects out of the server action into the missing error boundary. The `finally` then writes `claudeLastRun` from the **partial** result, so the app's own history records a short success. "Stop Claude run" only renders when `isRunning`, which cannot render until the blocking action resolves. Meanwhile Settings shows the key **green** from `Boolean(process.env.…)` — presence, never validity. **This is the documented pass-24 outage, and the diagnostic surface actively lied** | `claude-categorize.ts:148-283` · `settings/page.tsx:34,103` |
| 24 | Import | **The result is computed in full and thrown on the floor** | `importStatementFiles` returns `FileOutcome[]` with six per-file counters; `uploadStatementsAction` discards it. Drop November's PDF when November's QFX already owns that range → every row `skippedOwned`, file lands "Parsed", Txns reads 0, **pixel-identical to a successful import of new data**. Four such 0-txn files already exist on the real DB. The submit button is also the only one in the app with no pending state, for a 30-second operation | `imports/actions.ts:19` · `imports/page.tsx:95` |
| 25 | `/spending` | **"Where it went" can never be made to add up to the Spent card**, and the comment above it is wrong | Spent is GROSS *including* uncategorized; the table is NET *excluding* uncategorized; the share bar uses a THIRD base (positive categorized only). With a $400 refund and $900 uncategorized, a $5,000 headline sits above rows totalling $3,700 with no reconciliation note. `page.tsx:91-94` still calls the gross figure "the NET total" | `spending/page.tsx:88-97` |
| 26 | `/investments` | **Realized P/L header does not reconcile to anything on the page, and closed positions are unreachable** | MEASURED on the real DB: header $3,018.13 across 34 legs; the 9 active rows total $1,941.42. The missing **$1,076.71** lives in 25 fully-closed positions with no row, no list, no link — every entry point filters `isActive`. `/investments/stock/GOOG` resolves and is reachable from nowhere. The header also carries "≈" solely because of a closed CVX leg, while every visible row reads exact | `portfolio.ts:569` · `command-index.ts:99` |
| 27 | `/transactions` | **The open transaction is not in the URL**, contradicting this feature's own written doctrine | `query.ts:3-7` says "URL is the state: every filter, tab, and page lives in searchParams so views are shareable and the back button works." `openId` is `useState`. Refresh closes the sheet; it cannot be linked; browser Back — the phone reflex — navigates off the page entirely | `TransactionsLedger.tsx:109` |
| 28 | `/transactions` | **"Select all N" on the unfiltered tab arms an unbounded mutation whose undo patch is shipped row-by-row to the browser** | On the real ledger that is ~21,000 rows. The id SELECT is chunked at 500; the `UndoPatch` is one object per mutated row returned across the RSC boundary and posted back on Undo — a multi-megabyte round trip from one click, with no confirmation and no cap | `BulkActionBar.tsx:68-76` · `bulk-edit.ts:183` |
| 29 | Test gates | **The suite structurally cannot catch the mobile or overflow class of bug, and the keyboard gate runs against a route that 404s in production** | `grep scrollWidth e2e/` returns **zero**. `visual.spec.ts:7` omits 390 and 2560, and `toHaveScreenshot` captures the *clipped* viewport so a 267px overflow produces a byte-identical baseline. `a11y.spec.ts` never calls `setViewportSize` — **no route has ever been axe-scanned at a phone width**. `playwright.config.ts:41` has one desktop project with no `hasTouch`, so the `pointer-coarse:` branches have never executed. All three `keyboard.spec.ts` tests target `/design/stage-0a`, which `notFound()`s in production | `e2e/visual.spec.ts:7` · `e2e/keyboard.spec.ts:19` |
| 30 | Client mutations | **47 of 52 client action handlers have no `.catch`** (5 catches exist, all in `LinkPanels.tsx`) | On cellular: tap a category in the merchant picker, the request never arrives, `.then` never runs, `setBusy(false)` never fires. The Apply button is disabled **forever** and every subsequent pick returns silently at the busy guard. The page looks alive and is inert until reload. Same shape in RulesManager, SeriesMembership, TransactionSheet, SplitEditor, CashWallets, ManagedAccounts | `MerchantDefaultCategory.tsx:41-67` (+13 files) |
| 31 | Undo | **A failed Undo destroys its own affordance and reports nothing** | `undo-toast.ts:22-26` does `.then(r => { if (r.ok) … })` — no else, no catch. Independently `Toast.tsx:223-226` dismisses the toast the instant the action button is clicked, *before* it resolves. Bulk-recategorize 300 rows, click Undo, it fails → toast vanishes, no message, 300 rows stay changed, and the patch is gone from the client. Same `if (r.ok)`-with-no-else in 5 more undo handlers; `MerchantDefaultCategory.tsx:55` does not even check `ok` | `undo-toast.ts:22-26` · `Toast.tsx:223-226` |
| 32 | Aggregates | **Two filter dimensions were never built, so no aggregate can reach its rows** | `TxnFilters` has no `series` and no `importFile` (and no `sort`). A recurring series cannot reach its own charges — `SeriesMembership.tsx:59-77` renders 49 of them as **inert text**, and the calendar day sheet carries `transactionId` and links to the series instead. An import file cannot reach its rows — so the un-import button asks you to authorize an irreversible delete of a set the app refuses to show you. And "my five biggest charges in June" is unanswerable | `components/transactions/query.ts:17-31` |
| 33 | Global search | **The command palette has no visible trigger, and `/categories` + `/merchants` both 404** | Each directory contains only `[id]/page.tsx`. The header is a static tagline plus a ThemeToggle that renders an empty span until hydration. So on your stated primary device, the entire learned entity layer — 434+ merchants, 67 categories, closed holdings, cash wallets — is **unreachable**. `command-index.ts:66` also routes every category to `/transactions?category=` behind a comment saying "until /categories/[id] lands (Stage 3)" — it landed, and `command-index.test.ts:48` now **pins the bug** | `AppShell.tsx:50-59` · `command-index.ts:66` |
| 34 | `/settings` | **The page gets quadratically slower the more you use the feature it exists for** | `listRules` runs a full active-transactions scan **per enabled rule**, materialized into JS, with `new RegExp` recompiled **per row**. Rules are created one-per-correction. On ~20k rows every rule you create adds another 20k-row scan plus 20k regex compilations to every page load | `rules-manager.ts:161` → `rule-corrections.ts:160-180` |
| 35 | `/settings` | **`categorizationConfidenceMin` is a dead control** | It is in the schema, the seed, and the form. `classifyMerchantsAction` calls `classifyPendingMerchants(getDb())` with no options, so the hard-coded 0.8 always wins. You can set it to 0.99 and nothing changes. Same class: `backupRetention` is displayed and never passed to `maybeSnapshot`; `weekStartsOn` is a `z.literal("monday")` | `settings/page.tsx:55-57` · `transactions/actions.ts:150` |
| 36 | Server render | **No request-scoped memoization anywhere** (`grep 'cache('` in services → 0 React `cache`) | `transferFloats` runs **twice** per dashboard render (~439ms each on the real DB — roughly 880ms of the measured 1,440ms). `/investments` calls `buildPortfolio` 4× and `portfolioRealizedPl` 5×, each re-walking 1,991 events. `/spending` runs ~10 independent full scans over the same window. `/accounts` scans `daily_balances` three times (~20,000 redundant rows to draw 9 sparklines) | `dashboard.ts:117` + `dashboard-series.ts:77` |
| 37 | Server queries | **Two confirmed N+1s, both invisible on the demo DB** | MEASURED with a statement counter: `/investments` fires 119 statements, **88 of them single-row `price_cache` lookups** — one per holding_event — on a DB with only **6** events. You have **1,991**, and `buildPortfolio` runs 4× per render. `/accounts` fires 28, of which 20 are one pair per account inside `isCashWallet`, which re-resolves the cash institution id **every call** | `portfolio.ts:864` · `manual-transactions.ts:63-97` |
| 38 | `/imports` | **The trust-layer page has never been axe-scanned or screenshotted, and its markup is the worst in the app** | Absent from both `a11y.spec.ts:8` and `visual.spec.ts:9`. It renders a 5-column table with **88 buttons all named "un-import"** and N named "Accept as-is", `<th>`s with no `scope`, no `<caption>`, inside a `max-h-[28rem] overflow-y-auto` that accidentally makes overflow-x auto too — a two-axis nested scroller inside the page scroller | `imports/page.tsx:167-209` |
| 39 | Review queue | **One boolean conflates four unrelated problems, one of which changes net worth** | Producers: Claude confidence, large uncategorized deposit, ambiguous transfer, and **suspected cross-file duplicate**. The inbox shows none of this; the empty-state copy enumerates three reasons and omits duplicates. "Confirm all 12" on a Trader Joe's cluster can silently accept a double-counted transaction as reviewed | `ReviewInbox.tsx:229-258` · `import/service.ts:891-894` |

### MEDIUM (condensed — full detail in §7)

| # | Surface | Problem | file:line |
|---|---|---|---|
| 40 | `/spending` Spent card | Drill-down is **not split-aware** while the named-category branch is — a 60/40 split counts $120 and opens at $200 | `transactions-query.ts:58-81` |
| 41 | `/transactions` | Day-group net totals are **arithmetically false across page boundaries** — `groupByDay` runs over the 50-row slice | `TransactionsLedger.tsx:65-82` |
| 42 | `/transactions` Review tab | Tab count is **filtered**, inbox content is **unfiltered** — "Review 12" above "404 to review", with the causing filter invisible | `transactions/page.tsx:88` vs `:158` |
| 43 | Route change | **No route announcer, no focus management** — `main` content is replaced in silence, focus stays on the unmounted trigger, for every navigation in the app | `app/template.tsx:7` · `AppShell.tsx:62-66` |
| 44 | All view switchers | `useViewState` returns `isPending`; **all 6 consumers discard it**. `ViewSwitcher` has a `disabled` prop **no caller passes**. `aria-busy` appears **zero times** in the repo. 14 of 20 `useTransition` sites write `const [, startTransition]` | `useViewState.ts:62` · `ViewSwitcher.tsx:20` |
| 45 | Time state | **Every window the user picks dies on the next navigation.** `template.tsx` remounts; brushed window, range pill, heatmap month, calendar month, Sankey lens, holdings sort/metric, movers side are all `useState` | `template.tsx:8` · `DashboardWindowContext.tsx:46` · `ChartFocus.tsx:67` |
| 46 | 12 sections app-wide | Bare `&&` gating with **no else branch** — the heading, card and link all vanish. `/accounts/[id]:195` removes the only route to that account's ledger; `page.tsx:188` removes the chart AND the panel so ScrubChart's own "not enough history" copy can never render | `accounts/[id]/page.tsx:195` (+11) |
| 47 | 4 detail routes | Bare `catch { notFound() }` swallows **every** exception — a SQLITE_BUSY during a backup tells you your AAPL position does not exist | `investments/[assetType]/[symbol]/page.tsx:44-50` (+3) |
| 48 | `/accounts` | The same figure appears with **opposite signs 3cm apart** — header −$11,020.45 above a row reading $11,020.45, with nothing labelling either frame | `ManagedAccounts.tsx:75` vs `:162` |
| 49 | `/accounts` | An account re-homed to the "Cash" institution **disappears from the page entirely** while still counting in net worth and accepting imports | `accounts/page.tsx:25,28` |
| 50 | `/accounts` | Creating an account under "Cash" from the bottom form **skips the load-bearing $0 opening anchor** — two creation paths, one quietly broken | `accounts/actions.ts:44-50` vs `cash-wallets.ts:56` |
| 51 | Cash wallets | `deleteManualTransactionAction` has **zero callers in the entire repo** — a mistyped cash row is permanent by omission | `cash-actions.ts:38-50` |
| 52 | Dates | **No `max` on any date input and no year bound in any schema.** `deriveDailyRows` iterates one row per day; a 2036 typo = ~3,600 synchronous INSERTs, 2999 = ~355,000 | `derivation.ts:126-190` · `AnchorForm.tsx:17` |
| 53 | `/recurring` | The Upcoming tab and Forecast **project charges from dead series; the Calendar tab on the same page refuses to.** MEASURED: 11 of 31 series inactive; Upcoming shows +$8,588.71 where live-only is −$2,345.41; the forecast's projected income is 98.7% phantom, sign-flipping net from −$177 to +$4,064 | `recurring.ts:719-723` vs `recurring-calendar.ts:154-155` |
| 54 | `/recurring/[id]` | **Renaming a merchant-less series silently forks it** on the next detection run. The service docstring claims the opposite | `recurring-detail.ts:365-376` · `recurring.ts:402,408-410` |
| 55 | `/budgets` | `startsOn` is stored and **completely ignored** — an August prediction becomes a budget instantly graded against July at 54% used with 4 days left | `budgets.ts:160-165` |
| 56 | `/budgets` | The page **never states total spent, remaining, or overall pace** — you must add ten rows in your head. MEASURED: $5,670.51 against $6,799.00, computed ten times and never summed | `budgets/page.tsx:95-101` |
| 57 | `/budgets` | The **most decision-relevant number is computed on every load and hidden in a per-row popover.** MEASURED: 8 of 10 budgets are >15% from their own 6-month average (Subscriptions +84%, Fees −82%, Travel −78%); Entertainment reads a serene green "On track · 0% used" against a $292/mo trailing average | `budgets/page.tsx:51-53` |
| 58 | `/investments` | **Asset type is silently rewritable and orphans the entire price history.** The unique index is (account, symbol) with no assetType; re-entering ETH with the select defaulted to "Stock" makes every `(ETH, crypto)` price row unreachable | `holdings.ts:110-111` |
| 59 | `/investments` | The `exact` / "≈" honesty apparatus is **permanently inert** — no producer ever sets `PortfolioDay.exact=false`, so three carefully-written tooltips are dead code | `portfolio.ts:159` |
| 60 | `/investments` | The 30-day row sparkline **applies today's quantity to 30 historical closes** — a position bought 4 days ago draws a full 30-day value curve that never existed, `aria-hidden` with no caveat | `portfolio.ts:597-600` |
| 61 | `/investments/[…]` | Best day / Worst day / Max drawdown / Decomposition are **all-time under a windowed chart**, unlabeled | `ReturnViewParts.tsx:89,143-146` |
| 62 | `/investments/[…]` | The holding page **shows no share price and no cost basis** — both computed, both discarded. Drilling *into* a holding loses information the table had | `PositionCard.tsx:38-87` |
| 63 | `/accounts/[id]` | "Today" and "30 days" chips **ignore basis**. MEASURED: "Today +$0.00 · 30 days +$0.00 · carried" on a checking account with three weeks of no data. The chart 200px below draws those exact days dashed | `accounts/[id]/page.tsx:94-101` |
| 64 | `/accounts/[id]` | Recording a balance on an investment account is **accepted, listed, and completely ignored** — the rebuild path never reads anchors | `derivation.ts:204-215` vs `accounts/[id]/page.tsx:217` |
| 65 | `/accounts/[id]` | A manual anchor is **silently outranked** by a same-date statement anchor; both render as identical peer rows. And `addManualAnchor` **silently overwrites** a prior manual anchor with no diff and no toast | `derivation.ts:23-30` · `anchors.ts:40-43` |
| 66 | Charts | `accountSeries` **filters out `gap` days** and the category x-axis then draws a straight line across a 90-day hole in one segment width. The engine goes to great lengths never to invent a slope; the presentation layer invents one anyway | `derivation.ts:361` · `BalanceChartPanel.tsx:95-98` |
| 67 | Charts, 5 surfaces | `touch-none` on the plot blocks page scrolling. MEASURED dead zone: 308×256px at y=411 on the dashboard (**30% of the phone viewport**) | `ScrubChart.tsx:545` |
| 68 | Charts | Focus mode **drops the brushed window**; the lens toggle drops it too and the caption then names a range the user never picked | `BalanceChartPanel.tsx:207-223` · `ScrubTable.tsx:102,147-149` |
| 69 | `/merchants/[id]` | **A merchant default cannot be cleared** — the picker has no "None" row, though the service and the action schema both accept null | `MerchantDefaultCategory.tsx:85` |
| 70 | `/merchants/[id]` | Aliases — **the thing that actually decides what lands on this merchant** — are completely invisible: no list, no add, no delete, no explanation | `merchants/[id]/page.tsx:33-88` |
| 71 | `/categories/[id]` | The 12-month trend **shows no readable number to anyone not using a screen reader** — amounts exist only in `aria-label`; hover only changes fill | `MonthlyTrendBars.tsx:23` |
| 72 | `/categories/[id]` | **Rename is offered on categories the service will always reject** (Income, Cash & ATM, Fees, Investments + 7 paths). The move menu 20px away correctly hides itself for the same set | `categories/[id]/page.tsx:116` vs `category-edit.ts:25-34` |
| 73 | `/imports` | The three stat cards **do not account for the period population** — 105+8+0 vs 115 rows. `accepted` and `not_applicable` are counted nowhere; the label map for both is declared and never referenced | `imports/page.tsx:66-121, 24` |
| 74 | `/imports` | "Accept as-is" is permanent (`reconcileAccounts` skips accepted forever, no un-accept exists) **and can be a silent no-op** that still decrements the counter and hides the gap | `import/service.ts:822, 990-1013` |
| 75 | `/spending` | The **Graph lens renders an empty plot** on a Day period — one bucket, `dot={false}`, no empty state | `CashFlowGraph.tsx:139-165` |
| 76 | `/spending` | Income series are **unbounded** — no top-N, no "Other" — while spending is capped at 7. Seven-plus income buckets stack a 4-line legend under a 288px plot | `spending.ts:233-235` |
| 77 | Cross-surface | **12 action files hand-roll 12 different revalidation sets.** Dismiss a phantom series on /recurring, tap Dashboard, the bills strip still shows it. `createPredictedBudgetsAction` revalidates "/" which has no budget UI; no budget action revalidates `/categories/[id]` which does | `recurring/actions.ts:33` (+11) |
| 78 | `undoAction` | Accepts a **fully client-supplied patch** and writes 8 fields onto any transaction id; `deleteRuleId` deletes any rule. Shape-validated only, no ownership check. Harmless local; an arbitrary-ledger-write endpoint the day auth ships | `transactions/actions.ts:477-495` |
| 79 | Deploy | `middleware.ts:14-20` **403s every non-localhost Host**. Correct today, a total outage on any real hostname, and nothing in the repo says so | `src/middleware.ts:14-20` |
| 80 | Privacy | **Third parties' names leave the machine with no disclosure.** `normalizeDescription` strips card numbers and 5+ digit runs but **not person names**, and the queue is by construction the Zelle/Venmo/Wise peer traffic. Amounts and accounts are correctly not sent. Grep finds **no user-facing string** anywhere mentioning it, no preview, no per-row opt-out | `claude-categorize.ts:194-201` · `lib/normalize.ts:20-43` |
| 81 | Zero component tests | 98 `*.test.ts`, **0 `*.test.tsx`**. Every focus trap, roving tabindex, aria wiring, rollback and zero-value render has no unit safety net. In-state axe covers 3 states, all on /transactions, **none of which opens an overlay** | `e2e/interaction-states.spec.ts:75-107` |
| 82 | `EmptyState` | **No action slot** — props are `{title, description}`. That is why 8 of 9 empty screens in the app are prose with nothing to click, including the zero-account first run (**zero interactive elements**) | `ui/EmptyState.tsx:3-6` · `page.tsx:111-135` |
| 83 | `Field` | **`error=` is passed zero times across 42 call sites**; `hint=` twice. Every form reports failure by crashing the route instead of annotating the input | `ui/Field.tsx:26,35-37` |
| 84 | Wide screens | **Zero `xl:` and zero `2xl:` utilities exist in the entire codebase.** MEASURED at 2560px: 1,320px (52%) empty, main floating asymmetric to the sidebar; the flagship chart still 256px tall | `AppShell.tsx:65` |
| 85 | Dark mode | **Cards have zero elevation** — the shadow is a hardcoded 4%-black literal with no dark variant, copy-pasted into 4 files. On a 0.19-lightness surface it is arithmetically invisible | `SurfaceCard.tsx:12` |
| 86 | Motion | Effectively **one motion in the app**: a 150ms colour fade with Tailwind's *default* easing. `transition-colors` ×114 (none specify a curve), `--duration-slow` ×0, `--ease-in-out-sine` ×0, `active:` on 14 elements total | `globals.css:193-200` |
| 87 | Buttons | **16 hand-rolled primary buttons in 8 geometries** bypass `ui/Button`; only 8 have `active:`, only 2 handle `disabled:`, **none can accept `pending`** | `ui/Button.tsx:32` |
| 88 | `/imports`, `/settings` | Repeated destructive controls share **identical accessible names** — 88 × "un-import", N × "Accept as-is" | `imports/page.tsx:198,142` |
| 89 | `/settings` | Backups list **hides 12 of 14 dailies** — `sort().reverse()` puts every `monthly-*` first, then `slice(0,8)` cuts exactly the recent recovery points. `statSync` is unguarded, so a concurrently-pruned file 500s the route | `settings/page.tsx:16-26` |
| 90 | Transactions | Deleting a row **orphans its transfer partner's group**, permanently hiding a real outflow from every analytic (analytics excludes by kind and never reads the group) | `import/service.ts:974` · `manual-transactions.ts:273` |
| 91 | Mid-operation crash | Mutation and rebuild commit in **three separate transactions**. A crash between them leaves `daily_balances` describing a ledger that no longer exists — **with no detector and no repair path** | `import/service.ts:354-363, 973-987` |
| 92 | `formatCentsSigned(0)` | Returns **`+$0.00`** at 39+ `<Money flow>` sites where zero is the common case — an empty P/L month, a quiet recurring month, a zero-activity merchant. In an app where + means money in, that reads as a gain that did not happen | `lib/money.ts:80-83` |

---

## 5. What to change

Ranked by impact ÷ effort within each group. **Nothing here removes a feature** — every item is additive or a repair.

### 5.1 CORRECTNESS — the numbers and the data

| # | Change | Effort | Files | Why it ranks here |
|---|---|---|---|---|
| C1 | **Add `error.tsx`, `global-error.tsx`, `not-found.tsx`, `loading.tsx`.** Plus per-route loading for `/`, `/spending`, `/investments`, `/transactions`. Give `readSettings` a try/catch falling back to defaults. Narrow the four `catch { notFound() }` to their own typed errors (`UnknownHoldingError` is already exported and unused) | **S** | `src/app/*.tsx` (4 new) · `settings.ts:50-54` | Four files convert a dozen full-page outages into recoverable cards, across all 15 routes |
| C2 | **Promote all 18 `Promise<void>` actions to `ActionResult` + `safeParse` + toast + Undo.** Order: `unimportFileAction`, `setAccountActiveAction`, `deleteAnchorAction`, `deactivateBudgetAction`, `dismissSeriesAction`, `acceptGapAction`, `addAnchorAction`, `createAccountAction`, `addHoldingAction`, `updateSettingsAction` | **L** | `imports/actions.ts` · `accounts/actions.ts` · `budgets/actions.ts` · `recurring/actions.ts` · `investments/actions.ts` · `settings/actions.ts` | The contract, the toast host and `offerUndoToast` already exist. This removes ~17 unguarded destructive controls and most of the demand for C1 |
| C3 | **Snapshot before every destructive mutation.** `withPreMutationSnapshot(db, label, fn)` reusing the existing tmp+rename mechanism, wrapping the 8 irreversible services | **M** | `db/backup.ts` + 8 call sites | Snapshot cost on 12.8 MB is milliseconds. This single wrapper converts every remaining integrity finding from *unrecoverable* to *recoverable* |
| C4 | **Make "Mark as transfer" mean what its badge says.** Stamp the Transfers-kind category exactly the way `linkTransferPair:110-118` does, capturing the prior category into the undo patch | **M** | `bulk-edit.ts:168-173, 285-292` | Until this lands your spending totals are inflated by every row you ever marked this way |
| C5 | **Preserve user attributes across re-parse and un-import.** Build a `dedupeHash`-keyed carry map from the superseded predecessor and pass it as `carryFrom` on the plain-insert branch (the param already exists and already does the right thing); run `migrateSplits` for every matched pair. Add the missing `import.test.ts` case | **L** | `import/service.ts:396-405, 548, 772-786` | Today a parser improvement costs you 24 passes of hand-work. `docs/schema.md:94-95` already promises this |
| C6 | **Close the two `source='user'` holes with one shared predicate.** Export `notUserOwned()` and use it at both sites, replacing the four hand-written copies so there is one definition to audit. Write the merchant's user default onto rows rather than Claude's | **S** | `claude-categorize.ts:264-270` · `merchants.ts:115-122` | Two clauses. Restores precedence in the one path you cannot supervise |
| C7 | **Rebuild the cache whenever replay membership changes.** Add `rebuildAccount` after status transitions in `bulkApply`/`setTransactionFlags` and after `upsertHolding`. Export `REPLAY_STATUSES` as one constant so a future status cannot create a third desync. Give `rebuildAllAccounts` its first caller | **M** | `bulk-edit.ts:164-167, 296-298` · `holdings.ts:151` · `derivation.ts:235` | Fixes the fabricated-loss bug (#13) and the quarantine-restore desync (#15) with the same idea |
| C8 | **Carry the period on every cross-surface link.** A `periodParams(period)` helper appended to ~10 hrefs, then `?period=` accepted on `/budgets`, `/merchants/[id]`, `/accounts`. Delete the `?period=2026` workarounds from both e2e specs and let them assert the carry | **M** | `lib/period.ts` + 10 call sites | One helper stops the app changing the number under your finger |
| C9 | **Filter dead series out of `upcomingOccurrences` and `forecast.fixedComponents`** using the same `isSeriesActive` guard the calendar already applies — additively, with a collapsed "3 series paused — $4,240 not projected. Show →" footer. Add a unit test asserting the two sets are identical for any (db, today) | **M** | `recurring.ts:719-723` · `forecast.ts:126-130` | Today one page gives three contradictory answers, and the two wrong ones are the two you see first |
| C10 | **Make the Spent/Earned drill-downs split-aware** — reuse the `EXISTS transaction_splits` shape from the named-category branch immediately below. Add a test that the card's number equals the row-sum of what its href returns | **M** | `transactions-query.ts:58-81` | The page's central promise fails on the most-clicked card the moment you use splits |
| C11 | **Honour `startsOn` in budget status math** (clamp the spend window, add a `partialPeriod` flag) and have Predict-budgets pass `startsOn: targetStart` | **M** | `budgets.ts:160-165` · `budgets/actions.ts:130` | An August forecast is currently graded against July with 4 days left |
| C12 | **Bound every date at the boundary.** `boundedIsoDate({minYear:1990, max:'today+1y'})` in 5 schemas, `max={todayIso()}` on 4 inputs, plus a defensive row cap in `deriveDailyRows` that throws naming the offending anchor | **S** | `derivation.ts:126-190` + 4 forms | A four-digit typo currently generates up to 355,000 synchronous INSERTs |
| C13 | **Skip no-op writes in `retroApplyRule`** (compare before assigning) so the blast-radius badge decays and `timesApplied` stops inflating | **S** | `rule-corrections.ts:216-224, 244` | The badge is the only preview before an unconfirmed bulk ledger rewrite |
| C14 | **Guard asset type on an existing symbol** — refuse to change it when `holding_events` or cached prices exist, mirroring `accounts.ts:206-218`. Prefill the form from the matching holding | **M** | `holdings.ts:108-118` · `HoldingForm.tsx` | Currently one mis-defaulted select orphans a symbol's entire price history |
| C15 | **Clean up orphaned transfer groups on delete.** Extract the cleanup already written in `transfer-links.ts:107-110` and call it from both delete paths | **S** | `import/service.ts:985` · `manual-transactions.ts:273` | A one-legged group hides a real outflow from every analytic, permanently |
| C16 | **Add `catch` to `classifyPendingMerchants`** recording a *failed* `claudeLastRun`, and replace Settings' presence-only key light with a real "Test connection" action | **M** | `claude-categorize.ts:148` · `settings/page.tsx:34,103` | This is the pass-24 outage plus the surface that misdiagnosed it |
| C17 | **Server-side the undo patch** — store it keyed to a short-lived token and return only the token. Also removes the multi-megabyte "Select all 21,438" round trip | **M** | `transactions/actions.ts:477-495` · `bulk-edit.ts:204-257` | Much cheaper now than retrofitting across 12 call sites after auth |

### 5.2 CLARITY — say what you already know

| # | Change | Effort | Files |
|---|---|---|---|
| L1 | **Render freshness everywhere.** One `<AsOf day basis />` used on the hero (`netWorth.asOf` is computed and discarded), every `/accounts` row (`asOf`+`basis` both dropped), the account headline, `PortfolioStats` (replace the dead ternary with `dayChangeVsDay`), `PositionCard` (`quotedOn`), the holdings Price cell. Stop labelling non-today deltas "today" at 5 sites. Run every date through `formatDayShort` (fixes 3 raw-ISO leaks) | **M** | `dashboard.ts:131` · `PortfolioStats.tsx:27` · `ManagedAccounts.tsx:160` · `PositionCard.tsx:50` |
| L2 | **Report what every bulk engine did.** `uploadStatementsAction` → an import receipt from the `FileOutcome[]` it already discards; `runCategorizationAction` → "Categorized 42 · matched 7 rules · paired 5 transfers · flagged 3"; `detectNowAction` → its `DetectionSummary` | **M** | `imports/actions.ts:19` · `transactions/actions.ts:128-129` · `recurring/actions.ts:38-41` |
| L3 | **Surface categorization provenance.** Add `categorizationSource` to the page select and to `LedgerRow`; render a source glyph on the row and a "Why this category" line in the sheet with the confidence number and the specific rule/merchant/batch. Reuse the excellent `suggestionReason` copy pattern | **M** | `transactions/page.tsx:95-111` · `ledger-rows.ts:42-68` · `TransactionSheet.tsx` |
| L4 | **State the GROSS/NET/uncategorized reconciliation on /spending.** A footer line assembling four numbers already on the page. Fix the stale comment calling gross "the NET total". Relabel the share column "% of categorized spend" | **S** | `spending/page.tsx:88-97` |
| L5 | **Give the review queue a reason per row.** Persist it at all four producers and badge it on the cluster card and the ledger dot. Suspected duplicates must never clear through the same "Confirm all" as a confidence wobble | **L** | `categorize.ts:261,631` · `claude-categorize.ts` · `import/service.ts:891` |
| L6 | **Adopt the orphaned `Tooltip` at the ~20 honesty sites** via a focusable `<Annotation>` wrapper. Keep `title` as a fallback. `/imports`' parser error becomes an expandable row, not a tooltip | **M** | `ui/Tooltip.tsx` + 14 call sites |
| L7 | **Add a route announcer + focus anchor.** One client component on `usePathname` writing the new `<h1>` into an `sr-only` live region and focusing `#main` (which already has `tabIndex={-1}` for the skip link) | **S** | `AppShell.tsx` (1 new component) |
| L8 | **Wire the pending flags that are already computed.** `isPending` → `ViewSwitcher disabled` at all 6 sites; stop discarding it at the 14 `const [, startTransition]` sites; add `useFormStatus` to the 18 form submits via a `<SubmitButton>` | **M** | `useViewState.ts:62` · `ViewSwitcher.tsx:20` + 18 forms |
| L9 | **Explain "Free to spend."** A popover listing the four terms actually used, each linked to its rows, plus "assumes $X of income still to arrive." Draw `idealCents` — computed for all 31 points and never rendered | **M** | `SpendingPaceWidget.tsx:20,76` · `dashboard.ts:185,198-202` |
| L10 | **Add the missing budget aggregates.** Four StatCards (Budgeted / Spent / Left / Projected) per period set, and put the 6-month guidance delta **on the row** instead of two clicks deep in a popover the page already pays for | **S** | `budgets/page.tsx:51-53, 95-101` |
| L11 | **Make `/imports` legible.** Render `importedAt` and `format` (both selected, both unrendered), add `parserVersion`, join the account, and make the three stat cards complete and clickable using the already-written-and-unreferenced `RECONCILIATION_LABEL` | **M** | `imports/page.tsx:24, 34-49, 66-121` |
| L12 | **Show the evidence behind every verdict.** Suggestion cards get `lastMatchedOn` + `matchedCount` + a staleness chip; the series detail gets a "How this was detected" block (5 of 9 stats are shipped to the client and rendered nowhere) | **M** | `AllSeriesView.tsx:53-97` · `SeriesDetail.tsx:194-212` |
| L13 | **Label the unlabeled.** The amber pace ReferenceLine in the /spending legend; the `!` and realized-sell glyphs in the P/L calendar legend; `header.kind` through a display map instead of the raw enum; the `$0` "upcoming" forecast rows under an "Expected next month" heading | **S** | `CashFlowChart.tsx:292-311` · `PnlCalendar.tsx:265-279` · `categories/[id]/page.tsx:127` |
| L14 | **Say "as of" and "no data" on the change chips.** Pass basis into the /accounts/[id] chip computation and suppress or annotate a delta whose endpoint is carried | **S** | `accounts/[id]/page.tsx:94-101` |

### 5.3 CRAFT — how it feels

| # | Change | Effort | Files |
|---|---|---|---|
| F1 | **Gate `Popover`'s children on `open`.** One line, copied from `CommandPalette.tsx:141`. MEASURED effect on /transactions: 32,557 → ~1,520 DOM nodes, 4,054 KB → ~259 KB, 9,098 → 0 SVG paths. Fixes 10 picker sites + Menu + 4 more at once | **S** | `ui/Popover.tsx:125` |
| F2 | **Lazy-load recharts behind `next/dynamic` with one shared chunk.** −107 KB gz off three routes' initial payload, and the 2nd and 3rd chart route in a session become cache hits (~215 KB gz saved per session). The `loading` slot also gives charts their first skeleton | **M** | `ScrubChart.tsx:12` + 4 modules |
| F3 | **Fix the mobile overflows.** `minmax(0,1fr)` on the 5 confirmed grids + `min-w-0` on the `DataTable` wrapper itself (protects every current and future consumer). `flex-wrap`/`overflow-x-auto` on `ViewSwitcher` and `ViewTabs`. Verified in the live DOM: the dashboard hub collapses 454px → 343px | **S** | `page.tsx:217` · `investments/page.tsx:181` · `ui/DataTable.tsx:175` · `ui/ViewSwitcher.tsx:24` |
| F4 | **Give the phone a real navigation.** Minimum: `scrollIntoView` the active pill + an edge fade + 44px targets. Right answer: a bottom tab bar of 5 primaries with the rest behind a "More" sheet, which also reclaims the 46px the rail steals from every screen | **M** | `MobileNav.tsx:14` |
| F5 | **Add a `lg` button size and a `pointer-coarse` hit-area floor** to `Button` and `IconButton` (~6 lines) so every control in the app reaches a thumb target on touch without a single call-site change. Same for `ViewSwitcher` and `ChartRangePills` | **S** | `ui/Button.tsx:19-21, 60-63` |
| F6 | **Add `pointer-coarse:opacity-100`** to `StatCard`'s drill arrow and `InlineEditableText`'s pencil (two words), then decide the remaining 4 hover reveals deliberately | **S** | `StatCard.tsx:45` · `InlineEditableText.tsx:123` |
| F7 | **Ship a type scale, then apply it to headings first.** `--text-eyebrow` (pick ONE of the four tracking values), `--text-body`, `--text-section` (the missing rung), `--text-title`, `--text-hero` (clamp). Then change the 39 `text-sm font-medium` `<h2>`s to the section rung — one mechanical replace that gives every surface a visible three-level hierarchy | **M** | `globals.css:189-190` · 39 headings |
| F8 | **Retire the 16 hand-rolled primary buttons onto `Button`** with `pending`, and add `active:` to the three variants that lack one. This closes the double-submit/silent-save defect that five route audits reported as five separate bugs | **M** | `ui/Button.tsx` + 16 sites |
| F9 | **Add `--shadow-card` as a theme-aware token** (dark elevation reads through a rim highlight, not a shadow) and replace the four hardcoded literals | **S** | `globals.css` · `SurfaceCard.tsx:12` (+3) |
| F10 | **Swap `touch-none` for `touch-pan-y`** on the chart plot so a vertical swipe scrolls the page again. Delete or gate it on the account drag grip, where HTML5 drag cannot fire from touch anyway | **S** | `ScrubChart.tsx:545` · `ManagedAccounts.tsx:104` |
| F11 | **Give `EmptyState` an `action` slot** and fill all nine dead-end empty screens, including making the dashboard's first-run cards Links with a primary CTA | **S** | `ui/EmptyState.tsx:3-6` + 9 sites |
| F12 | **Stop hiding content on mobile — re-compose it.** Move the account name and T/R badges to a compact second line (`display:none` also strips their sr-only meaning), keep the heatmap magnitude bars and the account sparklines at every width | **M** | `TransactionsLedger.tsx:294,298` (+5) |
| F13 | **Give every horizontal rail and table scroller an affordance** — one shared edge-fade utility applied to `MobileNav`, `UpcomingBillsStrip`, `DataTable`, `AllSeriesView` | **M** | 4 files + `globals.css` |
| F14 | **Add the wide-screen tier.** `xl:max-w-7xl 2xl:max-w-[110rem]` on main + a density toggle persisted beside `dashboardLayout`, then let the existing two-column grids go three-up | **M** | `AppShell.tsx:65` |
| F15 | **Give the chart brush a keyboard path** (`Shift+Arrow` extend / `Enter` commit in the pure `lib/scrub.ts`) and make the date inputs announce the <2-point fallback instead of silently reverting | **M** | `lib/scrub.ts:24-37` · `ScrubChart.tsx:398-404` |
| F16 | **Fix the two `aria-label`-on-a-span sites** using the `LetterBadge` pattern the codebase already documents 40 lines away | **S** | `TransactionsLedger.tsx:300` · `RecentTransactions.tsx:75` |
| F17 | **Give `ChartFocus` a modal KeyScope and an initial-focus target** so the two dialogs share one contract; give bare `Popover` an `initialFocus`/`restoreFocus` contract so it stops being per-consumer folklore | **M** | `ChartFocus.tsx:128-171` · `ui/Popover.tsx:73-136` |
| F18 | **Move the page layer onto the motion vocabulary the overlay layer already uses.** Two composite transitions with `--ease-out-expo`, hover lift on drill-down cards, `active:scale` on pills, a `:has(:focus-visible)` card treatment | **M** | `globals.css:193-200` + 114 sites |

### 5.4 CONSISTENCY — one way to do each thing

| # | Change | Effort | Files |
|---|---|---|---|
| S1 | **Add `.catch` to all 47 unguarded action handlers** using `LinkPanels`' `NETWORK_ERROR` as the template, releasing the busy flag in the catch. Better: build a `useAction(fn)` hook that owns pending + latest-request guard + catch + toast + optional rollback, and migrate everything onto it | **M** | 14 files → 1 hook |
| S2 | **Fix Undo end-to-end.** Add the else and the catch in `undo-toast.ts`; stop `Toast` dismissing before the action resolves; apply the same in the 5 other undo handlers | **S** | `undo-toast.ts:22-26` · `Toast.tsx:223-226` |
| S3 | **Make `FiltersBar` carry every filter the URL supports** (hidden inputs + real controls for merchant/flow/amount, `hasActiveFilters` and Reset covering them, a full category option tree with sentinels) and add an active-filter chip row | **M** | `FiltersBar.tsx:27-105` |
| S4 | **Put the remaining time state in the URL** through the existing view-state system: chart range (appended, never inserted — 3 files index positionally), Sankey lens, heatmap month, calendar month, brushed window, holdings sort/metric | **M** | `ChartFocus.tsx:67` · `SankeyChart.tsx:82` · `SpendHeatmap.tsx:46` · `RecurringCalendar.tsx:66` |
| S5 | **Extract the revalidation fanout into one map keyed by what changed** and fix the 3 measurable holes (recurring→dashboard/budgets/spending, budgets→categories, merchants→dashboard/budgets) | **S** | 12 action files |
| S6 | **Add `series` and `importFile` to `TxnFilters` + a `sort`/`dir` pair**, then wire the links from the recurring series, the calendar day sheet, the amount-history rows, and each import file row | **M** | `query.ts:17-31` · `transactions-query.ts:47` |
| S7 | **Retire the four raw `<table>`s onto `DataTable`** (gaining sort, row links, caption, empty state) and collapse the five competing eyebrow specs onto one | **M** | `imports/page.tsx:168` · `accounts/[id]/page.tsx:227` · `AllSeriesView.tsx:114` · `ForecastCard.tsx:80` |
| S8 | **Route the palette to `/categories/[id]`** and update the test that currently pins the stale routing; give every detail route a `?from=` context breadcrumb and `generateMetadata` (three tabs currently all read "Merchant") | **S** | `command-index.ts:66` + test · 4 detail routes |
| S9 | **Make the Review view honor (or visibly reject) the URL filters** so the tab count, the inbox, CategorizeMode and "Mark all" describe the same set | **M** | `transactions/page.tsx:158` · `ReviewInbox.tsx:91` |
| S10 | **Normalize the reorder pattern** — same padding, same optimistic update, same `aria-busy`, in both places that implement it | **S** | `ManagedAccounts.tsx:113-131` · `ArrangeableSections.tsx:125-136` |
| S11 | **Reconcile the two budget status vocabularies** (`pace` on /budgets, `alert` on /categories) and make `categoryBudgetRef` return all of a category's budgets, not `.find()`'s first | **M** | `budgets.ts:144-148` · `category-detail.ts:171-180` |
| S12 | **Reconcile the two "matched expectation" definitions** — export the calendar's tolerance band and use it in the amount-history table; fix the sign inversion in "vs expected" | **S** | `AmountHistoryChart.tsx:44-51` · `recurring-calendar.ts:66-78` |

### 5.5 PERFORMANCE — before hosting

| # | Change | Effort | Files |
|---|---|---|---|
| P1 | **Wrap the 5 hot readers in React `cache()`** — `activeTxnsInRange`, `loadCategoryIndex`, `transferFloats`, `buildPortfolio`, `portfolioRealizedPl`. Behaviour-preserving; roughly halves the three worst routes | **M** | 5 service functions |
| P2 | **Kill the two N+1s** — batch `price_cache` into one keyed map with a binary search (the shape already exists in `holding-detail.ts:233-248`); batch `isCashWallet` into one grouped query with the institution resolved once | **M** | `portfolio.ts:864` · `manual-transactions.ts:63-97` |
| P3 | **Move `/settings`' per-rule full-table scan off the render path** — push the expressible predicates into SQL, hoist regex compilation out of the row loop, or compute lazily behind a button | **M** | `rules-manager.ts:161` · `categorize.ts:102` |
| P4 | **Stop `/recurring` computing all four tabs and `forecastCurrentMonth` (measured 102.8ms on 1,673 rows) on every render**; give `listSeries` a `GROUP BY` instead of loading every row's series id into JS | **S** | `recurring/page.tsx:32-35` · `recurring.ts:551-560` |
| P5 | **Bound `institutionGroups`' `daily_balances` query by day** and memoize `latestBalances` — `/accounts` currently reads ~20,000 redundant rows to draw 9 sparklines | **M** | `institution-groups.ts:112-128` |
| P6 | **Make the import and Claude runs non-blocking** — return a run id, work off-request using the run-state heartbeat that already exists, poll or stream. Scope `flagFuzzyDuplicates` to touched accounts + a date window instead of self-joining the whole table | **L** | `imports/actions.ts:19` · `transactions/actions.ts:150` · `import/service.ts:878-889` |
| P7 | **Bound `rebuildAccount` to the affected span**, or at minimum give every caller a pending state — recording one balance currently rewrites thousands of rows synchronously with no toast | **M** | `derivation.ts:195-258` |
| P8 | **Memoize the three unmemoized charts** and add `React.memo` (there is not one in the codebase); `AllocationDonut` re-derives its full geometry on every pointer move | **S** | `CashFlowChart.tsx:81-95` · `CashFlowGraph.tsx` · `AllocationDonut.tsx` |

### 5.6 TESTS — so none of this regresses

| # | Change | Effort | Files |
|---|---|---|---|
| T1 | **A responsive contract spec:** for every route × {390, 768, 1024, 1440, 2560}, assert `scrollWidth === clientWidth`, no interactive element under 24px (44 on the touch project), the active nav item inside its container, every `title` element focusable. Add a second Playwright project with `hasTouch`. Add `setViewportSize({width:390})` to the axe sweep | **M** | new spec · `playwright.config.ts:41` · `a11y.spec.ts` |
| T2 | **Register the overlay states `interaction-states.spec.ts` was built for** — its own docblock shows a `txn-sheet-open` example that was never implemented. ~6 lines each for 9 overlays. Highest test ROI in the repo | **M** | `e2e/interaction-states.spec.ts:75-107` |
| T3 | **Add `/imports`, `/merchants/[id]`, `/recurring/[id]` to the axe sweep and `/imports` to the visual sweep.** Expect immediate failures on the repeated accessible names — fix them in the same PR | **S** | `a11y.spec.ts:8` · `visual.spec.ts:9` |
| T4 | **Re-point the keyboard gate at `/transactions`** (duplicate, do not remove) so the coverage survives `/design/stage-0a` being deleted | **S** | `e2e/keyboard.spec.ts:19` |
| T5 | **A performance budget spec:** initial gz JS ≤ 300 KB, DOM ≤ 3,000 nodes, zero closed-popover options before interaction. Two of these would have caught the two critical findings the day they landed | **S** | new spec |
| T6 | **An integrity spec + a `verifyIntegrity(db)` service:** split parts sum, transfer groups have ≥2 legs, all cents are safe integers, `daily_balances` matches a fresh derivation, no user row carries a dead category. Turns documented invariants into enforced ones without a single SQL constraint | **M** | new `integrity.test.ts` + service |
| T7 | **Introduce component tests** (98 `*.test.ts`, 0 `*.test.tsx`): rollback on rejection, undo keeps its affordance on failure, stale responses never win, zero renders without a plus sign, `EmptyState` always exposes an action | **M** | new runner + 5 specs |

---

## 6. What to add

Two tiers. **Table stakes** are things a competent finance product has and this one does not. **Exceptional** is what makes it better than anything you could buy.

### 6.1 Table stakes this app is missing

| # | Add | Effort | Why it is table stakes |
|---|---|---|---|
| A1 | **A data-health strip in the shell, on every route.** Balances as of {date} · N days since last import · M accounts uncovered (named) · K open gaps · prices as of {date} · R awaiting review. Each segment links to the fix. Every input already exists; the root layout already does two guarded DB reads | **M** | Fixes the biggest trust gap and gives `/imports` its first entry point. A pissed-off investor's first question is "as of when?" and the app refuses to answer it on any screen |
| A2 | **Restore from a backup, inside the app.** Per-row Restore behind a typed confirm, a pre-restore snapshot, a Download, and a summary of what each restore point contains (txn count, latest date, net worth then) so you pick a *state* not a filename. Plus "Back up now" — one call | **L** | A backup nobody has restored from is a hypothesis. This is the highest-consequence missing button in the app |
| A3 | **Export.** CSV of any filtered set (the streaming id set already exists), plus holdings, realized sales, series, rules, anchors, and a raw `.db` download | **M** | Grep finds only import-side CSV. Five years of reconstructed history in a proprietary local file with no way out. Table stakes at tax time and the cheapest possible trust win |
| A4 | **Period navigation on `/budgets`, `/merchants/[id]`, `/accounts`, `/investments`.** `budgetPaceStatuses` already takes a `refDate` and returns a correct historical picture (verified at 2026-06-10); `merchantSummary` already takes an injectable `today`. Only the control is missing | **M** | "Did I hit my budget last month?" is unanswerable anywhere in the app. You have ten targets and zero track record |
| A5 | **A `/merchants` and a `/categories` index.** Sortable, searchable, with default-category editing inline and an uncategorized-count column sorted descending. Register both in NAV_ITEMS | **L** | Both routes 404 today. There is no screen that answers "what has the app learned, and where is it still ignorant?" — after Claude wrote ~434 mappings on your behalf |
| A6 | **A visible command/search trigger in the header** (currently a static tagline) | **S** | The palette is the only entity index and has no button — i.e. the whole learned layer is unreachable on your primary device |
| A7 | **Sortable columns + a filtered-set summary strip on `/transactions`.** Total in / out / net / count / distinct merchants / date span, from the same predicate the counts already use | **M** | The only full-ledger filter in the app cannot answer "how much is that?", and "my five biggest charges in June" is unanswerable |
| A8 | **Series → ledger and file → ledger drill-through** (the two missing filter dimensions) | **M** | Every aggregate in the app is supposed to open its rows. These two structurally cannot |
| A9 | **Merchant merge + an alias panel.** `mergeMerchants(from, into)` repointing transactions, aliases, and series, with a lossless undo — surfaced as the recovery when a rename collides instead of a dead-end error | **L** | Claude creates merchants by canonical name, so duplicates are structurally guaranteed and there is **zero** way to fix one without hand-editing SQLite. Every competitor ships merge |
| A10 | **A real trade entry path: Buy / Sell / Dividend, plus a trade log with delete.** Store the execution price so realized P/L stops being an estimate at daily closes | **L** | The only write today is "set the resulting total quantity" — no delete anywhere, no importer creates events. The two most common real actions both require mental arithmetic and are irreversible |
| A11 | **Refresh prices and add/update a holding from the holding page**, plus per-symbol backfill | **M** | The number that is lying to you ("Today +$412" from an 8-day-old close) can only be fixed by leaving the page |
| A12 | **Inline categorize on `/spending`.** The component (`InlineCategorizeList`), the loader, and the doc comment calling it "the Spending page's inline categorizer" all exist; nothing on /spending calls it | **M** | The page that tells you to categorize gives you no way to. Every competitor recategorizes from the report |
| A13 | **Set / edit a budget from the category page**, with a suggested amount from the prediction engine, and parent-budget inheritance on subcategories | **M** | The decision "I'm spending too much on this" happens here and the page answers it with a link to a screen showing every other category |
| A14 | **A cancelled / paused / skip-this-occurrence vocabulary for recurring** (`ended` is already in the schema; skip needs a small overrides table) | **M** | Cancel a gym membership and your only options are Dismiss (wrong meaning, unrecoverable, hides it forever) or leave it phantom-projecting into your forecast |
| A15 | **Bulk merchant reassignment + bulk notes/tags.** The undo schema already carries `merchantId` and `notes`; `BulkActionBar`'s own comment concedes merchant is deferred | **M** | With 434 merchants, fragmentation cleanup is a core task with no bulk path — which is exactly why pass 24 was done with guarded SQL scripts |
| A16 | **Add / duplicate / delete a transaction from `/transactions`.** `addManualTransactionAction` and `deleteManualTransaction` both exist and are reachable only from `/accounts` (delete: from nowhere) | **M** | The page literally named for the object cannot create one |
| A17 | **A running-balance column when the ledger is scoped to one account**, with a basis marker on estimated days | **L** | This is how you reconcile against a paper statement — the exact activity the app exists for — and it is the one thing every bank register has that this ledger does not |
| A18 | **Credit-card specifics: limit, utilisation, statement balance, due date** | **L** | Venture X sits at −$11,020.45 and the app cannot say whether that is 20% or 95% of the limit, or when it is due |
| A19 | **A statement coverage map on `/imports`** — account × month, coloured by state, with per-account staleness above it | **L** | It is the answer to the question journey 1 exists to ask and cannot: *what am I missing?* |
| A20 | **A suspected-duplicate review surface** showing the two rows side by side with their source files | **M** | Duplicates are the one review category that changes **net worth**, and today they are indistinguishable from a confidence wobble |
| A21 | **Keyboard scopes for the list surfaces that register none** — /accounts, /budgets, /recurring, /investments, /spending — plus a `?` shortcut legend | **M** | Five surfaces register scopes; ten do not. Three genuinely good accelerators exist and there is not one character of UI mentioning any of them |

### 6.2 Things that would make it exceptional

| # | Add | Effort | Why it would be exceptional |
|---|---|---|---|
| X1 | **A "why did it change" waterfall** for any selected window: income, spending, market gains, transfers, coverage drift — reconciling exactly to the delta the chart header already computes. Reusable on the dashboard, /spending and /accounts/[id]. `periodActivity` returns in/out/categories, `decomposeValue` returns an exact contributions-vs-gains identity, `transferFloats` isolates transit. **Nothing new needs deriving** | **L** | The one thing the app almost has and does not deliver. The chart says "+$24,759 (+28.8%)" and there is no way to ask why. For your specific financial life — cash job, family money, gambling, a 1,991-event brokerage — attribution *is* the product |
| X2 | **An anomaly / attention rail** on the dashboard and /spending: a category 2σ above its trailing mean, a first-time merchant over a threshold, a subscription that stepped up, an account not updated in 21 days, the period's 95th-percentile transaction. Every input exists | **L** | The app currently **reports**; it never **notices**. This is Copilot's and Monarch's entire differentiator, and after 1,300 hand-categorized rows this app knows more than either of them |
| X3 | **A net-worth composition view over time** — cash vs brokerage vs crypto vs debt as bands across two years, scrubbable, with the same coverage honesty. Slots in as a 7th option on the existing dashboard dimension and reuses `accountSeries` + `alignOverDays`, so it costs **no new math** | **L** | The ambitious visualization you asked for that is also *truthful*. It shows the SHAPE of the balance sheet changing, which none of the five current modes do |
| X4 | **A per-account basis ribbon** under the balance chart — one segment per span coloured anchored / derived / carried / unverified, clickable to zoom, hoverable to read "derived from 143 transactions, chain closed to the cent" | **M** | Turns the app's single best idea into something you can *see* in one glance on a phone, and fixes the straight-line-across-a-gap dishonesty at the same time |
| X5 | **Compare mode** — this period vs any other, side by side, across StatCards, categories and merchants. Two thirds of the plumbing is already paid for (the prior-period breakdown is computed and reduced to one hidden column) | **L** | The real question is never "what did I spend" — it is "what changed, and why". Today that needs two browser tabs and arithmetic |
| X6 | **Contributions vs market gains as a stacked area over time.** `decomposeValue` already produces the exact identity per series; it just needs evaluating per day | **M** | The single most motivating visualization in personal investing, and the math is already written, tested and reconciling |
| X7 | **An operations log + mutation log.** Append-only records of every automated run and every user mutation (before/after + the undo patch), surfaced on /settings and in the transaction sheet's Raw detail | **L** | An audit app with no audit trail. `categorization_source` names *who* last wrote a category and nothing names *when*, *why*, or *what it was*. After 24 passes you cannot answer "when did this stop being Groceries?" about any row |
| X8 | **A cash-flow calendar with a running projected balance** and the tightest day flagged | **L** | "Can I cover rent on the 1st?" is the operative question for an irregular income, and the app makes you reconstruct it from a list of dates in your head |
| X9 | **"Right-size my budgets"** — re-predict the budgets that already exist. `predictBudgets` structurally excludes them, so the prediction engine's single best use is the one thing it cannot do. MEASURED: 8 of 10 of your budgets are >15% off their own 6-month actuals | **M** | The flashiest control on the page returns 3 rows, 2 of them at 0% confidence, precisely *because* you already did the work |
| X10 | **A "why is this in review / why this category" explain panel** — reason, source, confidence, the winning rule (with a disable action), the merchant default, the Claude batch | **M** | This is the feature that turns the ledger from a data dump into a product, on a surface whose whole premise is that statements are truth |
| X11 | **A symbol × day P/L heatmap.** `holdingDeltasBetween` already computes per-symbol daily deltas | **M** | The calendar answers "which day was bad"; nothing answers "which holding has been consistently bad" |
| X12 | **Multi-holding and multi-benchmark overlays.** `ScrubChart` already supports named overlays with per-series coverage splitting; only the dashboard uses it | **M** | Deciding what to sell is a relative question. Engine, rendering, legend and coverage honesty are all built and shipped elsewhere — this is wiring |
| X13 | **Streaming page shells** — Suspense around the expensive aggregates so the hero paints before the forecast resolves | **L** | Zero boundaries today, so the fastest number on the page waits for the slowest. This is also the prerequisite for any 3D work having a frame budget |
| X14 | **A living design-system route.** Promote `/design/stage-0a` into a real specimen page: type scale, spacing, all button states, 12 hues in both themes, elevation planes, motion, chart palette, basis vocabulary | **M** | The rules live in prose comments scattered across 30 files, which is exactly why the same recipe was reinvented 16 times for buttons and 8 times for eyebrows |
| X15 | **Notes on merchants, accounts and holdings.** Wise = dad's money; Ingrid = Cancun reimbursement; StephanCodes = a SwiftUI course; "this is Carson's card, he reimburses me" | **S** | Pass 24 was sixteen questions of you reconstructing exactly this, and every answer currently lives only in a session memory file |
| X16 | **An .ics feed for upcoming bills** | **S** | Bills you need to act on belong in the surface your phone already nags you from. Nobody at this price point does it well |

### 6.3 On the 3D / ambitious-visualization ask — quantified

You said you do not care about bundle size as long as performance does not badly regress. That is defensible, but only if the budget is being *spent on something*.

| | Measured / projected |
|---|---|
| /investments today | 511 KB encoded, **1,805 KB decoded** JS to paint 831 DOM nodes with 113 nodes of chart |
| recharts share of all client JS | **2,239 KB of 4,548 KB (49%)** — five identical copies |
| Compile cost of just the recharts chunk | 10.7ms on an M-series Mac ≈ **50–85ms on a mid-tier Android** |
| Tree-shaken three.js r160+ core | ~160 KB gz |
| + @react-three/fiber + thin drei | +50–90 KB gz |
| **Total 3D cost** | **~250 KB gz (+45% on /investments today)** |
| Freed by F2 (lazy + dedupe recharts) | **−107 KB gz initial, −215 KB gz per 3-route session** |

**The verdict:** F1 and F2 free more budget than three.js costs. You can afford ambitious 3D — *after* those two land, and only behind `next/dynamic` with `ssr:false`. Shipping three.js on top of today's payload puts /investments at ~800 KB gz, which is not a regression, it is a different product.

**The three things that will actually break a 3D dashboard on your phone — none of which is bundle size:**

1. **Memory.** iOS Safari terminates tabs around 200–380 MB. /transactions currently holds 32,557 DOM nodes and 9,098 SVG paths before any WebGL context exists; a context plus geometry is another 50–150 MB. **Fix F1 first** or a 3D route plus a tab-switch back to /transactions will OOM on a real iPhone.
2. **Main-thread contention.** A canvas needs a stable 16.7ms frame. Today every route hydrates in one unbroken synchronous burst with **zero Suspense boundaries**, so the scene's first ~400ms would be starved. X13 is a prerequisite, not a nicety.
3. **Touch orchestration.** `touch-none` on a 256px plot already blocks page scroll on five surfaces (F10). A full-bleed canvas has the same problem at 5× the area. Design the gesture zones before the shader.

**And the structural advantage you already have:** every geometry input is a pure, unit-tested, DB-free function — `alignOverDays`, `decomposeValue` (exact identity), `sankey-layout` (deliberately deterministic), `niceLinearTicks`, `windowedPoints`. Build any 3D layer as a *third lens option* consuming those same functions. A parallel data path for the pretty view is how every finance app ends up with a chart that disagrees with its own table.

---
