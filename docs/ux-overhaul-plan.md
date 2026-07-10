# UX Overhaul Plan — MoneyApp

**Date:** 2026-07-10 · **Status: AWAITING APPROVAL — no code before sign-off (process gate)**

**Inputs:** [docs/research/ux-competitor-research-2026-07-10.md](research/ux-competitor-research-2026-07-10.md) (six teardowns: Rocket Money ×2, Copilot, Monarch, Robinhood, moomoo — cited as [RM-T], [RM-S], [CP], [MM], [RH], [MO]), codebase map (8-agent research workflow), user directive of 2026-07-10. This plan was **adversarially reviewed by a 4-lens workflow (44 findings — 3 critical, 16 high — verified against the live DB and folded in below)**; data claims marked ✓DB were checked against `data/moneyapp.db`.

**The verdict being fixed:** the app is correct but read-mostly — flat tables, one editable cell, no detail surface, no calendar, no chart drill-down, one accent color, "robotic" copy. Most of the data layer underneath is already built for the UX the competitors ship (rules table, merchant entities, daily price cache, category icon/color columns). The two real data gaps are named honestly in §6.0 and §9 — they are approval decisions, not surprises for later.

---

## 1. Universal contracts (the laws every tab obeys)

Hard contracts — every stage's review gate checks them.

1. **Drill-down contract** [MM][MO]: every chart segment, bar, donut slice, calendar day, budget row, stat card, top-merchant line, and heatmap tile click-navigates to a pre-filtered transaction list (or holding detail). Nothing is view-only. Destinations inherit the period being viewed.
2. **Edit-in-place, with an honest boundary** [CP][RM-T]: the displayed value is the control for *classification* — category, merchant name, notes, flags, budgets, series parameters. **Imported ledger facts (amount, date, raw description) are read-only by design** — the audit-integrity invariant — with a small affordance saying why. Manual transactions are fully editable. Multi-field edits open a Sheet; single-field edits never open anything.
3. **Correction-becomes-rule** [MM][CP]: after any manual recategorize/rename, a non-blocking toast offers "Always? Create rule → applies to N existing" with a server-computed retroactive count (§3.4).
4. **Review-as-inbox** [CP][MM][RM-T]: `needsReview` transactions form a clearable queue with count badge, batch clear, and keyboard triage. Includes a **first-run drain** for the existing backlog (✓DB: 1,775 rows today) so the queue is *completable on day one*, then stays a 30-second task.
5. **Semantic color, one grammar** [MO][MM][CP]: category identity = icon + hue, reused across chips, slices, bars, calendar dots. State grammar: green=paid/under/gain, amber=drift/at-risk, red=missed/over/loss (warm red, never alarm red [RH]), blue=upcoming/info. Gain/loss accent drives investment screens [RH]. Hue=direction, saturation=magnitude on heat surfaces [MO].
6. **URL-as-state**: period selectors, sub-tabs, ranges, sort → query params everywhere [RM-S]. Ephemeral UI state (open sheet id) syncs via shallow `history.replaceState` — linkable without server round-trips (§3.2).
7. **Keyboard grammar** [CP][MM]: `⌘K` palette, `g` chords, in-list mnemonics — `↑/↓` move, `X` select, `C` category, `R` reviewed, `E` sheet, `A` accept rule prompt, `⌘Enter` confirm. One **KeyScope stack** (palette > sheet > list) owns precedence; `Esc` pops the top scope only (§2.5).
8. **Blast-radius copy** [RM-T][MM]: bulk confirms state their server-computed count — "Apply to 23 transactions". Single edits autosave; bulk edits confirm.
9. **Honest math, visible** [RH][MO]: performance excludes cash flows; methodology and its anchor date labeled on-chart; carry-forward across market-closed days labeled ("vs Fri Jul 4"); partial coverage and uncategorized buckets stay explicit.
10. **Row tap navigates, `⋯` mutates** [RM-S], everywhere a row exists.

---

## 2. Stage 0 — Foundation: design system, primitives, harness

### 2.1 Direction

**"Editorial ledger, alive."** Keep the soul — warm paper/ink OKLCH tokens, tabular `.figures`, semantic color — and add what it lacks: category identity color, an overlay/interaction layer, motion with restraint. Evolution of the existing token contract, not a reskin.

### 2.2 Token additions (`src/app/globals.css`)

- **Category hue ramp:** 12 hues (`--cat-red…--cat-brown`), each with a `-soft` chip tint. **Light-theme lightness sits at L 0.50–0.53, tuned per hue** (lime/amber/yellow need lower L or reduced chroma) — matching the ceiling the existing validated tokens already discovered (`--ink-faint` 0.52, `--positive` 0.50); dark theme ~L 0.72. **Chip text stays `--ink` on the tint; the hue carries icon, border, dots, and fills** — so AA never depends on 12 hue×surface combinations. Gate: a **lib-level unit test computes WCAG contrast for all 12 hues × both themes × every surface they sit on** (axe can't see hues that aren't rendered on a given page; this test can).
- **State tokens:** `--info` + `--info-soft`; `--warning-soft`, `--negative-soft`.
- **Gain/loss pair:** `--gain`/`--loss` aliases consumed by all investment surfaces (pre-wires a colorblind pair swap, deferred §9).
- **Elevation:** `--shadow-overlay`, `--shadow-sheet`, `--surface-overlay`, `--radius-overlay: 1rem`.
- **Motion:** keep 150/300ms; add `--ease-spring`. All behind `prefers-reduced-motion`.

### 2.3 Category identity (data, not schema)

`categories.icon`/`color` exist and are unused ✓DB. Seed migration assigns every root a hue + icon; children inherit hue with own icon. `CategoryChip` renders identity everywhere a category appears. Editable in a Settings category manager.

### 2.4 Icon system

Adopt **lucide-react** (tree-shaken, stroke-consistent). `Icon.tsx` becomes a thin semantic-name → lucide wrapper so call sites keep `<Icon name="accounts" />`. *(Alternative: hand-roll ~40 paths — rejected as toil, §9 Q1.)*

### 2.5 New primitives (`src/components/ui/`)

Overlays on **native `<dialog>` + popover attribute** (zero deps). Implementation notes so nobody detours to Radix mid-stage: sheet enter/exit uses `@starting-style` + `transition-behavior: allow-discrete`; popover-in-sheet nesting rides top-layer stacking; **positioning uses a ~40-line JS flip+clamp util as the primary mechanism** (CSS anchor positioning is progressive sugar; the e2e project is chromium-only so an untested fallback is dead code).

| Primitive | Notes |
|---|---|
| `Button`, `IconButton` | primary/secondary/ghost/destructive; replaces ~15 ad-hoc class strings |
| `Field`, `Input`, `Select`, `Checkbox` | replaces the `FIELD` const copy-pasted across 6 files |
| `CategoryChip`, `Badge`, `LetterBadge` | `[T]` `[R]` `[I]` letter badges on rows [CP] |
| `Sheet` | right drawer ≥md, bottom sheet <md; native `<dialog>` |
| `Popover`, `Menu` (`⋯`) | popover attribute + JS positioning util |
| `Toast` | action-capable; **does not auto-dismiss while its action is available**; singleton throttled polite live region; never steals focus (§3.4) |
| `Tooltip` | methodology/basis annotations |
| `DataTable` | consolidates the three divergent hand-built tables; sortable, selectable, sticky head. **Row controls (checkbox, `⋯`) reveal on `:hover` OR `:focus-within` OR selection-mode; always visible on coarse pointers** — never hover-only |
| `StatCard` | tappable stat block — drill-down contract built in |
| `CalendarGrid` | **Stage 0 ships only the stable core: date math (weeks matrix, month paging) + a11y contract** — one focusable element per day cell, roving tabindex + arrow-key 2D nav, dots/tints `aria-hidden`, required `getCellLabel(day, data)` prop. Cell-rendering API lands in Stage 2 with its first real consumer; Spending/Investments cells are render-prop variations. The three label vocabularies are fixed now: "expected Netflix $15.99 — paid" / "spent $142, 3 transactions" / "portfolio up $312" |
| `NumberRoll` | odometer [RH]. Constraints: **CSS-transition only** (neutralized by both `animations:'disabled'` and reduced-motion), **never animates on first paint**, digit strips `aria-hidden` inside a container carrying the full value as one accessible name, fixed-width digit slots (`.figures` never reflows). Reduced-motion branch unit-tested |
| `CommandPalette` | `⌘K`: pages, accounts, categories, merchants, saved views; context actions when a sheet is open [MM] |
| `KeyScope` | the keyboard-precedence stack (palette > sheet > list); all mnemonics register per-scope. Built here so Stages 1–4 reuse it |
| `Skeleton` | pending states |

**`ScrubChart` + `RangePills`** are load-bearing for Stages 4–5 but are **built in Stage 4** with their most demanding consumer (§6.3) against an API contract fixed now: nullable points (net-worth partial days), per-point metadata, pluggable header renderer, gain/loss accent input, keyboard scrub as `role="slider"`. Dashboard/balance charts adopt it in Stage 5.

### 2.6 Shell fixes

Nav active uses `startsWith` (fixes `/accounts/[id]` orphaning); breadcrumbs on detail pages [MM]; unreviewed-count badge on Transactions nav (display capped **99+**); internal vocabulary purged from UI copy ("Phase 4 · Analytics", `parsed_with_claude` → human labels).

### 2.7 Test-harness upgrades (prerequisites, not afterthoughts)

The adversarial review verified that **visual + axe specs currently run against an empty DB** (global-setup deletes it; the golden path seeds it *last*), and nothing pins the clock — both would make every data-state gate in this plan false-green. Stage 0 therefore ships:

1. **Seeded e2e data**: global-setup imports the synthetic fixture set through the real import pipeline before specs run; `zz-golden-path` switches to a *different* fixture set so its mutations don't collide. Visual/a11y specs then see populated pages.
2. **Frozen clock**: `MONEYAPP_FAKE_TODAY` env honored by `lib/dates` (server-side — RSC renders on the server, so Playwright's client clock is not enough), set in `playwright.config` webServer, pinned inside the fixture window. Mirrors the `MONEYAPP_FAKE_PRICES` pattern; unit-tested. All calendar/pace/upcoming baselines are only valid under it.
3. **Interaction-states spec** (new): opens the transaction sheet, ⌘K, rule toast, bulk mode, calendar day sheet — screenshots × both themes (theme toggled via the existing button helper) **and AxeBuilder runs in each state**. New routes get appended to the visual + a11y route lists as stages add them (with seeded entity ids).
4. **Baseline policy**: the 8 core routes keep the 4-width × 2-theme sweep; **new routes and interaction states baseline at 375 + 1440 only** (states, not layouts, are under test). Per-stage gate lists its expected new-baseline count and e2e runtime.

### 2.8 Stage-0a: design sign-off checkpoint (before the app-wide sweep)

"Premium, not template-y" can't be approved from prose. Before tokens/icons roll out app-wide: **one high-fidelity sample screen** (transactions ledger + open sheet: hues, chips, icons, elevation, motion notes) rendered in **both themes**, screenshotted, and posted for your explicit sign-off. Only then does the full sweep + one-time regeneration of all 64 baselines proceed. Cheap insurance against the most expensive rework path in the plan.

### 2.9 Stage-0 gates

Primitive unit tests (incl. contrast test, NumberRoll reduced-motion, KeyScope precedence, CalendarGrid a11y core); harness upgrades verified (seeded specs see data; fake-today unit test); all 64 baselines regenerated once post-sign-off; axe all routes × both themes on seeded data; keyboard walkthrough of Sheet/Menu/Palette; bundle delta < +30kb gz.

---

## 3. Tab 1 — Transactions: the triage machine

**Goal:** Rocket-Money-fast review with Monarch-grade editing. See a transaction's siblings, bulk-fix in one gesture, clear the queue in seconds, automate corrections permanently.

### 3.0 Action-layer refactor (unlocks everything below)

Today every mutation action ends in `revalidatePath` + `redirect(?notice=)` — incompatible with toasts, undo, live counts, and a sheet that stays open. Stage 1 converts transaction mutations to **value-returning server actions** (`{ok, retroCount, undoPatch}`) invoked from client components; `Toast` replaces `NoticeBanner`; undo = server-captured inverse patches (bulk category changes, status changes; undo after "create rule" also reverts the rule). Cluster/bulk operations are **single batch actions** (server actions execute serially per client — per-row calls would visibly queue during `R,R,R` triage).

### 3.1 Layout

- **Date-grouped ledger** (client component fed serialized rows — required by the keyboard grammar): day headers with daily net [RM-T]. Row anatomy: `CategoryChip (tappable) · normalized name (raw preserved in sheet) · account · LetterBadges · unreviewed dot · amount`. Checkbox + `⋯` per §2.5's reveal rules.
- `ViewTabs` stays; Review becomes the inbox (§3.3).
- `FiltersBar`: live debounced search (client-owned input value so re-renders never eat keystrokes; `router.replace` + `useTransition`), filter chips incl. **amount min/max** (new), removable active-filter chips, reset.
- Column sort (date/amount) via `DataTable`, in URL.

### 3.2 Transaction Sheet

Row click → Sheet. **Mechanism (specified, not improvised):** visibility + current txn are client state seeded from loaded rows; `?txn=<id>` syncs via shallow `history.replaceState` (linkable, back-button-friendly, **zero RSC round-trips**); direct visits with `?txn=` server-render the sheet once; `↑/↓` flips through transactions with the sheet open — **gate: flip < 100ms perceived**; same-merchant panel data arrives via one debounced server action per settle.

Contents:
1. **Header:** amount (read-only, §1.2 boundary), merchant name — tap to rename → `merchantAliases` row + rule prompt. Date (read-only), account link, status.
2. **Category chip** → picker: search + tree; low-confidence items surface Claude's top-2 guesses first [CP]; "remember for merchant" / "apply to history" carry over.
3. **Toggles** [RM-T]: Transfer (feeds pairing tuning — ✓DB current state: 82 txns paired in 41 groups, not the stale 0/316; scope re-derived pre-stage), Exclude, Recurring → link/unlink series (§4.4).
4. **Notes** — wired to the **existing `transactions.notes` column** ✓DB (the previously claimed migration was wrong; **Tab 1 has zero migrations**).
5. **Same-merchant panel (the headline ask):** "At {merchant} · 14 txns · $482 this year" + last 5 + **Recategorize all 14 →** + View all →. Fallback for merchantless rows: **stripped-key matching** (dates/amounts/CUSIP-type tokens removed — shares the recurring-detection grouping helper). ✓DB: 47% of rows are merchantless and mostly brokerage strings like `CASH DIV: R/D 2026-04-24 … (COKE)` — exact-match would fragment; ticker-in-parens is the natural key. **Panel suppressed on investment-account transactions** (trades aren't merchants).
6. **Raw detail** (collapsible): raw description, import file, confidence, source — audit trail present, not shouting.

### 3.3 Review inbox (with a day-one drain)

- Review tab groups by **merchant cluster** ("Trader Joe's ×6 — all Groceries?"); confirm cluster (`R`/✓) or fix cluster (picker for the group) [RM-T adapted].
- Special card types for big-deposit and ambiguous-transfer reviews with their specific actions.
- **First-run drain** (✓DB: 1,775 needsReview today): cluster-bulk confirm works across the whole backlog, plus a one-time amnesty — "Mark all 1,502 before {date} as reviewed" with blast-radius copy. **Acceptance criterion: the seeded backlog is clearable in minutes via clusters in the e2e run.**
- `Mark all as reviewed` stays as the happy-path header action [CP].

### 3.4 Rules: prompt + manager

- **Post-edit toast**: "Always categorize {merchant} as {category}? · Create rule — applies to **N** existing" [MM]. Toast per §2.5: non-dismissing while actionable, never steals focus, **`A` accepts from the keyboard mid-triage**, one throttled live region.
- **Retro-apply is a new service, not the existing engine** (✓code: `categorizeAll` only touches *uncategorized* rows, and the ledger is 100% categorized — through that path N would always be 0): `retroApplyRule(db, ruleId)` applies to matches where `categorizationSource != 'user'`, regardless of current category; the toast count uses the identical predicate.
- **One precedence model**: rules execute in priority order (drag-reorder in the manager); new rules insert at top priority — "newest wins" falls out as a consequence, not a second rule.
- **Rules manager** (Settings → Rules): sentence-rendered rules, enable/disable, reorder, `timesApplied`, pre-save preview of matches [MM], delete. `ruleActionsSchema` extends with `renameTo?`, `markRecurringSeriesId?` (JSON column — no migration).

### 3.5 Bulk edit

`Edit` (or first `X`) → selection mode: checkboxes, **Select all (matching filter)**, bottom-pinned bar [CP]: category / reviewed / exclude / transfer / merchant. Two service contracts: `bulkApply(db, ids, patch)` for checkbox selections, **`bulkApplyByFilter(db, filters, patch)`** for select-all — reusing `parseFilters`/`filterConditions` (extracted from `transactions/query.ts` + page into a service), **returning the affected count server-side** for the confirm copy. Undo per §3.0.

### 3.6 Merchant page (`/merchants/[id]`)

Icon/name (editable), default category chip, aliases, monthly spend bars (click month → filtered txns), linked recurring series, full txn list (same components), merge-into [MM]. Reached from sheet, top-merchants, ⌘K. **In §3.9's visual + axe route lists.**

### 3.7 Manual transactions (cash economy)

**Model decided now:** manual transactions live on **manual cash-wallet accounts only** (no statement periods, no anchors) — e.g. a "Cash" account for the weekly ATM salary, whose withdrawal already exists on the bank statement. There they *do* drive balance derivation. **They are not allowed on statement-anchored accounts** — ✓code: derivation replays all active txns between anchors, so a manual row would break to-the-cent anchor closure, the app's core invariant. This needs **zero schema change** (manual = `importFileId IS NULL`; `dedupeHash` synthesized from description+date+amount+counter; spec'd in the service). Add flow: `⋯` → "Add transaction" sheet (amount, direction, date, account [cash wallets only], category, note) [RM-T].

### 3.8 Data/services

`merchantSummary`, `similarTransactions` (stripped-key), `bulkApply`, `bulkApplyByFilter`, `retroApplyRule`, `createRuleFromCorrection`, `renameMerchant`, `addManualTransaction`, filter-condition extraction. All pure, 100%-lib-covered. ⌘K index preloads merchants/categories/accounts/pages.

### 3.9 Gates

Unit: services + cluster grouping + retro-apply predicate + stripped-key + manual-txn dedupe/derivation rules. E2E: triage golden path (clusters → rule → retro-apply verified), backlog drain, sheet keyboard flow incl. `A`, bulk by-filter count copy, Tab-to-row control visibility. Visual+axe (seeded, both themes): transactions default / sheet / review / bulk **+ `/merchants/[id]`**; interaction-states spec extended. Expected new baselines: ~10 (375+1440).

---

## 4. Tab 2 — Recurring: series you can trust and touch

### 4.1 Three sub-views (`?tab=`) [RM-S]

1. **Upcoming (default):** 14-day strip (category-colored dots + amounts) above a date-sorted expected-charge list; paychecks included so "before next paycheck" reads naturally. `ForecastCard` stays.
2. **All:** Active / **Inactive** (auto: no charge within cadence+grace → Inactive; new charge auto-restores [RM-S]) × kind sections. Rows: icon+name, cadence, avg ±σ, next expected, **annualized cost**, status pill, amount-history sparkline, `⋯`.
3. **Calendar:** month grid (`CalendarGrid`). State grammar: green ✓ paid / amber ✓ paid-different / blue upcoming / red ✗ missed [MM]. Day click → **Day Sheet** (expected + posted, each linking on). Month footer totals.

**Suggestion queue** on All ("Detected: Spotify monthly — confirm / not recurring") replaces raw status-table presentation [MM].

### 4.2 Series detail (`/recurring/[id]`)

- Header: icon+name (editable), **merchant + category chips** (closing the chain both directions), kind, status; cadence as an **editable sentence** of underlined tokens [CP]: "charges **monthly** around the **12th**, about **$15.99** from **Chase Checking**".
- **Amount-history chart** (drift/price-increases visible [RM-S]); annualized cost; next 3 expected.
- **Linked transactions** (full history; `⋯` → "not part of this series").
- **Find transactions** attach flow (search unlinked by description/amount window, checkbox-attach with count) [RM-S].
- **Merge series**: occurrences relink; source marked `ended` + `mergedIntoId`; cadence re-derived.
- Confirm / dismiss / end.

### 4.3 Detection must respect user decisions (schema delta)

✓code: `detectRecurringSeries` re-tags `recurringSeriesId` for all group members on **every run** and resolves series by merchant/name — so merge, unlink, and attach would be silently reverted next run. Fix requires **link ownership**: `transactions.seriesLinkSource: 'detected' | 'user'` (+ user-unlink honored), and detection forward-maps merged series via `mergedIntoId` (tags the target, never the source). **Unit test: a detection run after merge/unlink/attach changes nothing.** This column joins the approval list (§9.3).

### 4.4 Data/schema

- `recurringSeries` overrides: `userAmountCents`, `userCadence`, `userNextExpectedOn`, `mergedIntoId` (nullable; detection keeps its fields; UI reads user-first; forecast reads overrides).
- `transactions.seriesLinkSource` (§4.3).
- Services: `seriesDetail`, `attachTransactions`, `mergeSeries`, `seriesLifecycleSweep`.

### 4.5 Gates

Unit: lifecycle, merge relink, override precedence, detection-respects-user, day-state derivation. E2E: suggestion confirm, calendar day sheet, attach + merge path. Visual+axe seeded both themes: 3 sub-views + detail + day sheet (~10 baselines, 375+1440); `/recurring/[id]` appended to route lists.

---

## 5. Tab 3 — Spending: one cash-flow surface, every period tappable

### 5.1 Header + period model

- Tappable **StatCards**: Earned · Spent · Net · Savings-rate % — each drills to its filtered list [MM].
- **Period selector, URL state** (`?period=2026-07 | 2026-Q3 | 2026`, custom `?from/to`): month ⇄ quarter ⇄ year, ‹ › paging, "This month" reset [RM-S]. Every module inherits the period.

### 5.2 Combined chart (replaces the spending/income toggle)

**Mirrored bars**: income above axis (stacked by source), spending below (stacked by category), **net line** across. Click a segment → that category+period's txns; click an axis label → the whole period [MM]. Granularity follows the selector (days within a month, months within a year). Current period gets **pace**: solid actual + dotted ideal + "on pace for $X" [CP].

### 5.3 Day-level heatmap

`CalendarGrid` month view, cells tinted by net outflow (saturation=magnitude [MO]), income corner dots; **click a day → `/transactions?from=D&to=D`** — the literal "tap any day" ask. Cell labels per §2.5 vocabulary.

### 5.4 Breakdown modules (all click-through)

- **Categories table**: CategoryChips, share-of-period mini bar, MoM delta, expandable parents → **category page**.
- **Category page (`/categories/[id]`)**: monthly trend (click month → txns), ranked merchants within, budget link, **recurring-series-in-this-category section** (closing the chain), subcategory split, txn list.
- **Top merchants** [RM-S]: ✓DB — only 53% of txns carry `merchant_id`, so ranking by it alone would silently omit half the ledger. The module groups by merchant **plus stripped-key groups for unlinked rows** (rendered distinctly, no icon), and a **merchant-linkage backfill task** (alias sweep + one Claude pass over the ~3,359 unlinked rows) runs before this stage; coverage % shown until it's high.
- **Largest purchases** (top 5 → sheet) [RM-S].
- **Honesty buckets**: Uncategorized + Excluded rows stay explicit and clickable.

### 5.5 Services

No schema change. `cashFlowByPeriod`, `dailySpendHeatmap`, `topMerchants` (merchant+stripped-key), `largestTransactions`, category-page aggregates; `transactionsHref` extends to day precision.

### 5.6 Gates

Unit: period bucketing (frozen-clock), pace projection, heatmap tints, top-merchant grouping. E2E: bar-segment → filtered list, day → day list, period URL round-trip. Visual+axe seeded both themes: month + year granularity, heatmap, category page (~8 baselines); `/categories/[id]` appended to route lists.

---

## 6. Tab 4 — Investments: Robinhood feel, moomoo honesty

### 6.0 The data gap, named (approval decision, not a surprise)

✓DB findings from the adversarial review: **all 8 equity holdings have exactly one `holding_events` row, dated 2026-07-10 ("Robinhood connector seed")** — only ETH has a real 66-event timeline. A naive `cumsum × closes` portfolio chart would render **$0 → ~$68k as a cliff on seed day**; trade marks would show one fake "buy"; `costCents` on those seed events is cumulative basis compressed onto one date, so flow-adjusted returns would read a ~$50k phantom deposit. Meanwhile the **real history exists**: 1,902 CUSIP trade transactions (2025-02 → 2026-06) are already imported, and the source CSV (`data/inbox/robinhood/robinhood-brokerage-activity-…csv`) has **Quantity and Price columns the importer dropped**. Daily closes are already backfilled (✓DB ~502/symbol back to 2024-07).

**Stage 4a (prerequisite): rebuild the equity `holding_events` timeline** from the brokerage activity CSV (mirroring `data/rebuild-eth-timeline-2026-07-10.ts`): dated buy/sell events with quantities; residual opening events for positions predating the CSV window; handles fully-sold symbols (PM, BRK.B, GOOG, MRVL); **reconciles the rebuilt cumsum to the verified 2026-07-10 quantities** (gate: exact match per symbol). Replaces the synthetic seed events.

**If 4a is deferred** (your call, §9 Q4): charts clip to each account's first real event with an on-chart "history begins Jul 2026" label; trade marks + avg-cost line ship **ETH-only**; TWR is blocked; simple period return only. No synthetic history, ever.

### 6.1 Price history service

`backfillPriceHistory` (yahoo chart API tickers, Coinbase candles for ETH) — mostly *maintenance* since backfill exists ✓DB; idempotent, staleness-aware, spliced with the fake-price walk under `MONEYAPP_FAKE_PRICES`. Benchmark (SPY) rides the same cache. No schema change.

### 6.2 Portfolio series + return math

- `portfolioSeries`: per-day Σ(quantity timeline × close), **carry-forward last close per symbol** across market-closed days. Positions-only and labeled so — Robinhood **cash** is not yet anchored (statement pending); upgraded when the anchor lands.
- `flowAdjustedReturns`: `r(t) = NAV(t) − NAV(t−1) − netFlows(t)` where **netFlows come from the signed CUSIP trade transactions** (cent-exact, by trans-code class) — **never `holdingEvents.costCents`** (display-only per its own schema comment). **TWR is computable only from the rebuilt timeline's anchor date and is labeled with it on-chart**; simple return offered alongside [MO]. Unit fixtures include: deposit mid-period ≠ gain, the phantom-seed-deposit case, missing-close carry-forward, mixed stock+crypto weekend.
- **Weekend/holiday honesty** [contract 9]: "day change" labels its comparison date when the gap exceeds a day ("vs Fri Jul 4"); P/L-calendar weekend cells show ETH-only movement with a subtle "markets closed" treatment.

### 6.3 Portfolio screen

- **Header**: value (NumberRoll), day change $/%, period return; **accent state** (chart, delta, active pill) from the period's gain/loss [RH].
- **ScrubChart** (built here, consumed later by dashboard/account charts): range pills `1M/3M/YTD/1Y/ALL` (daily granularity, stated honestly — no fake intraday); press/drag hairline with header value+date swap and period-return recompute; release snaps back [RH]; dotted period-start baseline. Implementation notes (verified feasible): Recharts 3.9 `useActiveTooltipDataPoints`/`useActiveTooltipCoordinate` for the header swap (child-component pattern, not prop plumbing); `touch-action:none` + pointer capture for drag; `ReferenceLine` baseline, `ReferenceDot` marks, gradient offset for above/below coloring. **Keyboard scrub = `role="slider"`** on a focusable wrapper owning the scrub index (Recharts' accessibilityLayer can't expose it): `aria-valuemin/max/now` + `aria-valuetext` ("Jul 8, 2026: $48,210, up 1.2%") — SRs self-announce with built-in rate limiting, axe validates the attributes, e2e asserts `aria-valuetext` after N ArrowRights. One debounced polite region for range-pill summaries only.
- **Top movers** strip (W/L toggle → holding page) [MO].
- **Holdings list** (`DataTable`): ticker + qty subtitle, day sparkline, price, day-change block — **tap to cycle** % → $ → total P/L [MO]; sort sheet [RH]. Row → holding page.
- **Allocation donut** (slices → holding page). Treemap: stretch goal (§9).
- **P/L Calendar** [MO]: daily portfolio change cells (hue=direction, saturation=magnitude), monthly footer, year mini-grid; day click → Day Sheet (per-holding deltas + that day's investment txns).
- Add/update holding + refresh prices move into `⋯` + sheet.

### 6.4 Holding detail (`/investments/[assetType]/[symbol]`)

Route keys on **(assetType, symbol)** — the schema's own warning: bare `ETH` collides with a NYSE ticker ✓schema. Multi-account symbols aggregate by default with a per-account breakdown section.

- Header: symbol/name, price (NumberRoll), day change; ScrubChart with pills.
- **Position card** [RH]: quantity, market value, avg cost, today's return, total return, **portfolio diversity %**.
- **Trade marks + avg-cost line** from the rebuilt timeline (§6.0; ETH-only if 4a deferred — never synthetic).
- **Events history**: dated buys/sells/transfers linking to source transactions.

### 6.5 Gates

Unit: return math vs fixtures (list in §6.2), timeline-rebuild reconciliation (cumsum = verified quantities), scrub index, cycle state. E2E: pill switch, keyboard scrub `aria-valuetext`, marks render, P/L day sheet. Visual+axe seeded both themes: portfolio in **gain and loss accent states** (fixture-forced), holding page, P/L calendar (~8 baselines); route appended to lists. Perf: page JS < 300kb gz held.

---

## 7. Tab 5 — Dashboard + Accounts: the hub that links everything

### 7.1 Dashboard (`/`)

**Aggregator of teasers — never dead-ends** [CP]. Stack (static, deliberate order; reorder deferred §9):
1. **Net worth header** + **ScrubChart** (adopted from Stage 4; its API already handles the dual solid/dashed partial-coverage series with null gaps — scrub announces "partial · 5/7 accounts") + range-delta chip.
2. **To Review card**: count + 3 newest + Review all → [CP].
3. **Upcoming bills strip** (14 days, horizontal) → series pages; "$X due before your next paycheck" when income series exist [RM-S].
4. **Spending pace widget**: solid-vs-dotted mini chart + "Free to spend ≈ $X" [CP] → /spending.
5. **Accounts** (institution cards — kept).
6. **Investments teaser**: value + day change + sparkline + top mover.
7. **Recent transactions** (5, CategoryChips, click opens the txn sheet in place).

### 7.2 Accounts

Institution cards stay. Add: per-account unreviewed dots; styled archived group; **edit account** sheet (rename, institution, last4 — currently impossible without SQL); add-institution inline; drag-reorder (writes existing `displayOrder`).

### 7.3 Account detail

Tables → `DataTable`; recent txns become the **same interactive rows** as the ledger (chips, sheet); balance chart → ScrubChart with anchor/basis honesty labels preserved; holdings rows → `/investments/[assetType]/[symbol]`; breadcrumb + nav fix land in Stage 0. Credit utilization deferred (needs `creditLimit`, §9).

### 7.4 Gates

E2E: an enumerated **drill-down contract test** — every dashboard widget click lands on its target; account edit flow. Visual+axe seeded both themes: dashboard, accounts, account detail (~6 baselines).

---

## 8. Budgets (light touch — rides in Stage 6)

Pace-colored bars (green→amber→red by *projected* pace [CP]) + today tick [MM] + hollow tail = expected-but-unposted recurring — **the tail is clickable** → popover listing the contributing series (drill-down contract). Inline budget edit with 6-month average as guidance [MM] (kills deactivate-and-recreate). Row → category page; budget shown reciprocally there. No flex modes, no rollover redesign.

---

## 9. Decisions needed with approval

1. **Icons**: lucide-react (recommended) vs hand-rolling ~40 paths.
2. **Overlays**: native `<dialog>`/popover + JS positioning (recommended) vs Radix.
3. **Schema/data deltas** (each needs explicit approval — now verified against the live schema; the earlier `transactions.note` claim was wrong and is withdrawn):
   - `recurringSeries.{userAmountCents, userCadence, userNextExpectedOn, mergedIntoId}` — Tab 2.
   - `transactions.seriesLinkSource` (`'detected' | 'user'`) — required so detection can't revert user link decisions (§4.3).
   - **Stage 4a equity timeline rebuild** (data task, no migration): rebuild `holding_events` from the brokerage CSV (§6.0). *Strongly recommended — without it the portfolio chart can only honestly start at 2026-07-10.*
   - Manual transactions = **cash-wallet-accounts-only** model (§3.7 — a semantics decision, zero migration).
4. **If Stage 4a is deferred**: accept the "history begins Jul 2026" clipped chart + ETH-only trade marks + no TWR (§6.0).
5. **New routes**: `/merchants/[id]`, `/categories/[id]`, `/recurring/[id]`, `/investments/[assetType]/[symbol]` (recommended as pages).
6. **Stage-0a design checkpoint** (§2.8): you sign off on one sample screen before the app-wide visual sweep. Recommended.
7. **Deferred by recommendation** (say the word to pull forward): splits, tags, colorblind gain/loss pair (tokens pre-wired), holdings treemap, dashboard widget reorder, Month-in-Review story [CP], credit-limit/utilization, Sankey [MM], demo-mode toggle.
8. **Naming**: keep "Spending" with income integrated (recommended) vs rename "Cash flow".

---

## 10. Build order and gates

Each stage = implement → unit (100% lib) + e2e green → **seeded** visual baselines both themes → axe (routes **and** interaction states) → adversarial review workflow → fix findings → commit. Baseline reality: Stage 0 regenerates all 64 once; **each later stage regenerates its own tab's baselines** (shared-primitive freeze in Stage 0 is what guarantees stages don't churn *other* tabs); new routes/states at 375+1440; per-stage counts listed in the gate sections (~40–45 new baselines total).

| Stage | Scope | Notes |
|---|---|---|
| **0. Foundation** | §2: tokens, category identity, primitives, KeyScope, icon migration, shell fixes, copy sweep, **harness upgrades (§2.7)**, **Stage-0a sign-off (§2.8)** | Everything consumes it |
| **1. Transactions** | §3: action-layer refactor, ledger, sheet, inbox + backlog drain, rules prompt/manager, bulk, merchant pages, manual cash txns, ⌘K v1 | Daily-use core; establishes the patterns; transfer-pairing tuning rides here (scope from live data: 82 paired / 41 groups) |
| **2. Recurring** | §4: sub-views, calendar, series detail, attach/merge, lifecycle, link-ownership | CalendarGrid cell API lands here |
| **3. Spending** | §5: combined cash-flow, period drill-downs, heatmap, category pages, merchant-linkage backfill | Completes the linking chain |
| **4. Investments** | **4a: equity timeline rebuild (§6.0)** → §6: return math, ScrubChart, holding pages, P/L calendar, movers | ScrubChart built here against the §2.5 contract |
| **5. Dashboard + Accounts** | §7: widgets, ScrubChart adoption (net worth + balance), account editing, detail consolidation | Aggregates 1–4 |
| **6. Budgets + polish** | §8 + NumberRoll sweep, motion pass, full visual/axe/perf audit, README screenshot refresh | Final coherence pass |

**Definition of done:** every §1 law spot-checked on every tab; both themes verified on seeded data; axe critical+serious = 0 incl. interaction states; unit suite ≥ current 336 green with new coverage; golden path extended to triage/recurring/investments; README refreshed with live-workflow screenshots (pre-publish gate).

---

*Approval gate: answer §9 (or "approve as recommended") and work begins at Stage 0. Reminder: Sapphire ····9805 and Discover ····4741 still each need one owed-balance anchor — independent of this plan, quick to land, completes net-worth coverage 9/9.*
