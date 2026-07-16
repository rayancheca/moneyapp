# MoneyApp — MASTER GUIDE (the one living backlog)

> **THE single source of truth for all future work.** Every other planning doc
> (master-plan, ux-overhaul-plan, dashboard-dynamic plan) is fully shipped and
> historical — consolidated here 2026-07-14; nothing unchecked lives anywhere else.
> **Every working pass must expand + polish this list and tick off what shipped.**
> One focused item per session; end each session with a handoff prompt. Dates absolute.

Last updated: 2026-07-16 (pass 15 — **INCOME GROUND TRUTH** established from the user's own
`Finances 2026.xlsx` hand-tracking. New reference: **[`docs/income-ground-truth.md`](income-ground-truth.md)**
— the authoritative definition of what counts as income (Fordham DD wages + Knack tutoring + interest;
aid/dad/cash/transfers excluded). Reconciled + adversarially verified: the app's earned income matches the
user's own to **1.56%** ✓, but exposed a CONFIRMED regression — a seed rule (`src/db/seed.ts:212`
"ATM/cash deposit → Salary") re-labels **36 ATM cash rows = $52,625** as wages on every import, inflating
app income to ~$175k (3.18× the true earned $55,128). Correction proposed, NOT yet applied (needs
backup + dry-run + user OK). Pass 14 below.)

Prior update: 2026-07-15 (pass 14 — **NORTH STAR #2 STARTED.** Pillar 1 (predictions) shipped end-to-end:
the pure **`src/lib/projection.ts`** method registry (`2450ea8`) + the **`/spending` projection overlay**
(`5d3dd1c`) — "On pace for ~$Y · $X so far · $Z last {period}" + a faint prior-period ghost line. Pillar 2
(switchable views) foundation + first proof: pure **`src/lib/view-state.ts`** (`bc93a91`) + the
`useViewState`/`<ViewSwitcher>`/`<DataTable>` primitives + a **`/spending` chart↔table toggle** (URL +
per-surface `app_settings` persisted, adversarially reviewed). See the 🔮 build-sequence checklist — items
1-2 done, item 3 started (richer view types remain). Pass 13 below: P0.3 y-axis fix; investment
carry-forward + live Refresh-prices; Deployment plan; Monarch deep-dive. Pass 12 further below.

Pass 12 — P0.2 + P0.4 + P0.5a SHIPPED. User dropped 4 Chase 3522 2023
statements + a July Venture X statement; imported to the real db (backup + guards): Chase 2023
gaps closed (P0.2), Venture X merged as 4208 (card reissued from 4147), and the transfer detector
— rewritten over FOUR adversarial review rounds to pair only on two-sided/structural evidence,
never a single-sided hint — cleared the 240 SoFi overdraft pairs (P0.4) + widened the hinted window
(P0.5a). Review inbox 2232→1170. **Net worth honestly restated $94,144.53 → $83,014.51**: the
Venture X card carried ~$11.1k of real June–July spend that was invisible until its statement
landed. Pass 11 [S8–S10a] + pass 10 [S1–S7] below.).

---

## 🧠 GROUND TRUTH — the user's financial story (2026-07-14, verbatim intent)

Use this to VALIDATE every chart/number. Money mechanics, in the user's own words:

1. **2022**: arrived in the US, opened **Chase student checking (····3522)** — spent on its
   debit card for ~a year.
2. Got a **Discover card** — from then on spent ONLY on Discover, paid it off from Chase.
3. Opened **SoFi Savings (4.6% APY, Oct 2023)** — moved essentially ALL money there for APY.
4. ~A year after Discover, got **Chase Sapphire Preferred** (Feb 2025) — used both cards.
5. SoFi APY dropped → **moved everything to Robinhood** (higher APY on brokerage cash):
   parked the cash there earning APY, and ran **~$20/day recurring DCA buys** into selected
   stocks **until the cash ran out** (the buys then auto-stopped).
6. Standing pattern: **spends ONLY on credit cards** → sells stock when needed → transfers
   Robinhood→bank → pays the card. Debit basically unused post-2023.
7. **SoFi overdraft mechanics**: SoFi card/checking spends pull from Checking; Checking
   usually sits at $0, so Savings auto-covers each spend via an overdraft PAIR —
   `OVERDRAFT FROM SAVINGS - 5791` (+ into Checking) mirrored by `OVERDRAFT TO CHECKING - 9067`
   (− out of Savings). **240 pairs, $81,446.95 each way — pure internal moves, never income
   or spending.** Money "always searching for higher APY, then investing".

---

## 🔮 NORTH STAR #2 — "PREDICTIONS EVERYWHERE + SWITCHABLE VIEWS EVERYWHERE" (user's stated top want, 2026-07-15)

> **User intent (verbatim, pass 13):** *"I actually liked the predictions part of [Monarch].
> Every graph, you can see the estimate of your spending, the estimate of everything on every graph
> for everything. I want it to be able to give me predictions: 'Oh, I should be spending this. This is
> what I spent last month.' I have to be able to change between a million different kinds of views on
> every page of the site."* (They explicitly do NOT care about Monarch's look — it's the **forecast
> overlays** and the **view flexibility** they want.)

This is a program of work on the scale of the "nothing read-only" north star (below). It has TWO
cross-cutting pillars, each delivered as a **shared primitive** applied to every surface, plus an
**honesty doctrine** that keeps it MoneyApp (predictions are always marked estimates with visible
method — never dressed up as fact). Build the two primitives once (pure-first TDD), then light up
every page.

### Pillar 1 — Projections/estimates on EVERY graph and stat

Every chart and every number gets an **estimate companion** answering "what should this be?":
- **Pace / run-rate to end of period** — "you've spent $X; at this pace you'll spend **$Y** by month-end."
- **Prior-period ghost** — "last month you spent **$Z**" rendered as a faint reference line/area behind
  the current series (the "this is what I spent last month" ask).
- **Budget/target reference** — "your budget is **$W**" line, with over/under projected.
- **Forward forecast series** — a dashed/hollow continuation of the line to the period end (or a chosen
  horizon), so every time-series shows where it's heading, not just where it's been.
- **Expected-next** — recurring-driven ("$1,800 rent expected Aug 1"), already half-built in `recurring.ts`.

**We already have most of the engine — this GENERALIZES it, doesn't invent it:**
- `src/services/forecast.ts` — month-end forecast = **fixed (recurring still-expected) + variable
  (extrapolated from trailing full months)**, with *visible math* (it exposes `trailingFullMonths`,
  the fixed vs variable split — not a black box). This is the template for every projection.
- Budgets already compute a **pace projection** (spend-to-date + expected-recurring "hollow tail" +
  extrapolated variable remainder) with a "today" tick and green/amber/red — `budgets.ts`.
- The **dashed "estimated" convention** already exists (pass 13 carried-price tail; the coverage
  bands; `scrub-series.ts` `complete:false` → dashed). Reuse it as THE visual language for "projected."
- `/spending` already shows a **delta vs the prior period**. Extend that into a full ghost overlay.
- `netWorthSeries`/`portfolioSeries`/`accountSeries` are the series to extend forward.

**The shared primitive: a `Projection` layer.**
- Pure lib `src/lib/projection.ts` (TDD, 100%): given actuals + a chosen **method**, return a
  `{ projectedSeries, expectedTotal, priorPeriodSeries, targetCents, basis }` bundle. Methods (a small
  registry, each pure + testable):
  - `pace` (spend-to-date ÷ days-elapsed × days-in-period, + expected recurring),
  - `trailingAverage` (N-month mean per category),
  - `priorPeriod` (same period last month/quarter/year — the ghost),
  - `recurringDriven` (from `recurring.ts` next-expected),
  - `runRate` (linear extrapolation of the current series),
  - `budgetTarget` (the set budget line).
- A chart-side overlay component that renders a projection bundle on any `ScrubChart`/bar/area:
  the projected continuation is **dashed**, the prior-period ghost is a **faint** line/area, the target
  is a **reference line**, and the readout annotates "actual $X · projected $Y · last period $Z · budget $W."
- **Honesty doctrine (non-negotiable — this is what separates us from a toy):**
  1. A projection is ALWAYS visually distinct from actuals (dashed/faint/labeled "projected/estimated").
  2. A projection ALWAYS states its method + basis on demand ("pace from 12 days" / "avg of last 6
     months" / "same month last year"), mirroring `forecast.ts`'s visible-math rule.
  3. **Never predict what can't be honestly predicted** — do NOT forecast stock/crypto PRICES (market
     movement isn't extrapolable); for investments, project *contributions/DCA continuation* and show
     prior-period comparison, not a fabricated price path. (Consistent with the pass-13 carry-forward:
     we carry the last close flat + dashed, we don't invent a trend.)
  4. Low-confidence projections (thin data, high variance — reuse `recurring.ts`'s CV/confidence idea)
     render fainter and say so; never a false-precision number.

### Pillar 2 — Switchable views on EVERY page ("a million kinds of views")

Every data surface exposes a **view switcher** so the user flips the SAME data between many lenses,
persisted (URL + per-user `app_settings`) so a chosen view is shareable and sticky:
- **Chart type** — line / area / stacked-area / bar / grouped-bar / stacked-bar / donut / **Sankey** /
  calendar-heatmap / **table** (the same numbers, different renderer). (Monarch's "Breakdown vs Trends"
  is a 2-view subset of this — we want the full set.)
- **Slice/group-by** — by category / group / merchant / account / tag (once tags land).
- **Time granularity** — daily / weekly / monthly / quarterly / yearly.
- **Framing** — absolute $ vs **percent** vs vs-prior-period vs vs-budget; cumulative vs per-period.
- **Comparison on/off** — overlay the prior-period ghost (ties to Pillar 1).

**The shared primitive: a `ViewSwitcher` + a per-surface view registry.**
- A headless `useViewState` hook (URL-param + `app_settings` persistence, same pattern as the window
  history + dashboard layout) + a `<ViewSwitcher>` control (segmented/menu, keyboard + a11y, reduced-
  motion-safe), analogous to how `<InlineEditableText>` standardized editing everywhere.
- Each surface declares a **view registry**: the set of `{ chartType, groupBy, granularity, framing }`
  its data supports, and a common data adapter so the interchangeable renderers (reuse `ScrubChart`,
  the spending bars/donut/heatmap, the future Sankey, a generic `<DataTable>`) all read one shape.
- A **`<DataTable>`** renderer is part of this (every chart should be viewable as the raw numbers —
  also an accessibility win and the honest "show me the data" escape hatch).

### Where each lights up (application matrix — build the primitives, then walk this list)

| Surface | Projections (Pillar 1) | Switchable views (Pillar 2) |
|---|---|---|
| Dashboard net-worth chart | forward forecast to horizon + prior-period ghost; "projected net worth" hero stat | line/area/table; filter-by-account-type; granularity; % vs $ |
| `/spending` (cash flow) | pace-to-month-end + last-month ghost + "you should be spending $Y"; per-category expected | bar/stacked/donut/**Sankey**/heatmap/table; by category/group/merchant; granularity; abs/%/vs-prior |
| `/budgets` | already pace-projected — add the last-month ghost + projected over/under per row | table/bars; by category/group; this-vs-last; %/$ |
| `/investments` | DCA-continuation projection + prior-period compare (NOT price prediction); projected contributions | value/return/allocation views; line/area/donut/table; by holding/asset-class; granularity |
| `/recurring` | already predicts next — surface projected monthly total + calendar of expected | calendar/list/table; upcoming/all; by cadence |
| `/accounts` + account detail | per-account forward projection + prior-period ghost | line/area/table; granularity |
| Category / merchant detail | expected spend vs actual + trailing-average line + last-period ghost | bars/line/table; granularity; abs/% |

### Build sequence (pure-first, honest, incremental)
1. [x] **`src/lib/projection.ts` — SHIPPED (pass 14, commit `2450ea8`).** The pure method registry
   (pace/trailingAverage/priorPeriod/recurringDriven/runRate/budgetTarget) + `periodProgress` day-math +
   `buildForwardSeries` (dashed cumulative continuation) + `reindexByPosition` (resample a prior series to
   overlay unequal-length periods). Generalizes budgets.ts `projectSpend` (Engine A) / forecast.ts trailing
   avg+trend (Engine B) / spending.ts `computePace` (Engine C). Every point tail `complete:false` → dashed;
   every result carries a visible `basis` + a `confidence`; NO price method (honesty doctrine). 46 tests,
   src/lib 100%. Adversarially reviewed (3 lenses × verify) → fixed 2 basis-grammar defects.
2. [x] **Projection overlay on `/spending` — SHIPPED (pass 14, commit `5d3dd1c`).** The cash-flow chart now
   reads "On pace for ~$Y spent this period · $X so far · $Z in {prior period}" (the user's exact ask) +
   a faint dashed prior-period GHOST line (last period's gross spend, re-indexed 1:1) + a legend swatch +
   tooltip row. New `spendingProjection` service (pace floored at the full-period committed spend so the
   estimate never reads below the visible "Spent"). Low-confidence early pace reads muted + "(early estimate)";
   the pace basis has a dotted-underline + hover + screen-reader affordance. 4 service tests; 12 baselines
   regenerated. Adversarially reviewed (3 lenses × verify) → fixed all 3 confirmed (floor, tooltip label, basis a11y).
3. [~] **`useViewState` + `<ViewSwitcher>` + `<DataTable>` — STARTED (pass 14).** Pure `src/lib/view-state.ts`
   (URL > persisted `app_settings` > spec-default resolution; clean URLs omit defaults; 19 tests, src/lib
   100%; commit `bc93a91`). Then the hook (`src/hooks/useViewState.ts` — navigates via the proven
   `router.push(href)` + fire-and-forget persist via `saveViewPreferenceAction`), the a11y `<ViewSwitcher>`
   pill group, the reused generic `<DataTable>`, and a `/spending` **chart ↔ table** proof (the honest
   "show me the raw numbers" escape hatch; the table carries a prior-period column). URL-shareable + Back +
   per-surface sticky. Adversarially reviewed → the switch-to-default race + unhandled-rejection + isPending
   all fixed (await persist before navigate, inside the transition). **REMAINING for this item:** the richer
   view set on `/spending` — chart-type (stacked/donut/**Sankey**/heatmap), group-by (category/group/merchant),
   framing (abs/%/vs-prior), comparison toggle. The plumbing (spec registry + hook + switcher + table +
   persistence) is now proven; each new view is a renderer + a spec option.
4. Roll both across the matrix, surface by surface, regenerating e2e baselines per surface. The **Sankey**
   (Monarch steal, see `docs/monarch-money-deep-dive.md` §8 A3) is one of the switchable views.
5. Honesty pass: every projection labels its method; every chart has a table view; no price prediction.

> **Pre-hosting hardening notes (from the pass-14 view-switcher review, non-blocking on localhost):** the
> shared `viewPreferences` blob has no cap on surface/dimension count (bounded in practice — only the app's
> own known surfaces are ever written), and its read-modify-write merge could lose a concurrent
> cross-surface update once the data layer is async (Turso) — both are single-user-local non-issues today;
> revisit with the deploy work.

> **Relationship to the Monarch deep-dive doc:** this section is the user's REAL takeaway from Monarch —
> the forecast overlays + view flexibility, not the visual style. The Monarch steal-list
> (`docs/monarch-money-deep-dive.md`) still applies (Sankey/splits/tags/reports/goals), but THIS is the
> lens to prioritize it through: favor the items that add predictions or views (Sankey, Reports
> Breakdown/Trends, chart-as-filter) over cosmetic ones. Cross-links to the "nothing read-only" north star
> below — same "shared-primitive, apply-everywhere" playbook.

## 🚨 P0 — DATA CORRECTNESS (investigated 2026-07-14 on a db copy; do these FIRST)

- [ ] **P0.1 — Robinhood Brokerage CASH is missing from the balance model** (the "75k→18k
  Feb–Oct 2025" scare — CONFIRMED, no data is missing, the MODEL under-counts).
  **Evidence (copy queries, 2026-07-14):** SoFi Savings $51,970 (2025-06-01) → **$2,021**
  (2025-08-01) — ~$48k moved to Robinhood — but Robinhood Brokerage only shows $19,731 →
  $20,127 across the same window, then "slowly climbs" $49,077 (Oct) → $59,097 (Dec). The
  climb is the user's **$20/day DCA converting invisible CASH into visible holdings**. The
  brokerage curve tracks securities value, NOT the cash sweep balance the user parked there
  for APY. Also: brokerage `daily_balances` only start **2025-02-20** even though brokerage
  txns exist from 2024-08 — the pre-anchor cash era is entirely uncounted.
  **Fix plan:** model brokerage cash as a replayed ledger (deposits − buys + sells +
  dividends + interest = cash-over-time, exactly like a checking account — the activity
  CSV/statements already carry every flow), then `brokerage total = cash + holdings×prices`.
  Cross-check each statement month: parsed statement "account value" (Robinhood prints
  cash + securities totals — extend `robinhood` parsers to capture BOTH as anchors) must
  reconcile to the replayed cash + valued holdings to the cent; gaps quarantine, never guess.
  Also backfill the 2024-08→2025-02 pre-anchor era from the activity ledger. THIS IS A
  REAL-DB DATA PASS: backup + dry-run on a copy + Δ-guards + the session playbook below.
- [x] **P0.2 — missing Chase statement, cycle 2023-10-13 → 2023-11-10 — SHIPPED (pass 12).** The
  user provided it (+ the 2023-06-13→07-13 July cycle that was also absent, + Aug/Oct which
  deduped). Imported to the real db 2026-07-15: Chase 3522 now has 7 continuous 2023 periods
  (May→Dec), gap days in 2023-06-13..11-10 went 58 → 0, all reconciled to the cent. The
  "Oct–Nov 2023 drop to $0/−$106" dip on the chart is resolved (begin $9,792.80 → end $972.47,
  matching the move into brand-new SoFi Savings). Was: CONFIRMED coverage gap, not lost money.
- [x] **P0.3 — y-axis −$5k padding bug — SHIPPED (pass 13, commit `97b4636`).** `niceLinearTicks`
  (src/lib/chart-axis.ts) floored the domain a full range-step below 0 when a window dipped just
  under $0 (a −$106 Chase overdraft under a $13.1k window picked step $5,000 → bottom −$5,000). Fix:
  when `lo < 0 && hi > 0 && |lo| < hi*0.15`, the bottom binds to `-niceStep(2·|lo|)` (always ≤ lo so
  the line never clips) and the ticks anchor at 0 — a clean zero-based scale. Larger dips and
  all-positive/all-negative windows are byte-identical. 3 new unit tests; **no e2e baseline change**
  (the fixture's charted windows stay above zero — the fix only bites the real Chase-overdraft data).
- [x] **P0.4 — SoFi OVERDRAFT pairs auto-paired + cleared — SHIPPED (pass 12, commit `c185d6d`).**
  The 240+240 same-day `OVERDRAFT FROM SAVINGS - 5791` / `OVERDRAFT TO CHECKING - 9067` mirror
  pairs (ground truth §7) now auto-pair (they're same-day descriptor-symmetric mirrors —
  structural evidence) and clear from the review inbox: OVERDRAFT-in-review went 480 → 0, total
  review 2232 → 1170. **The detector was rewritten over FOUR adversarial review rounds** because
  the naive "descriptor hint + proximity" approach kept silently mislabeling coincidences (a real
  Investments›Buys row → Transfer; a wine purchase / paycheck / landlord check vs. an unrelated
  external transfer). Final doctrine: auto-pair ONLY on evidence tying the two SPECIFIC rows —
  structural (same-day internal mirror, S6 linked pair, both-already-Transfers) OR a hint on BOTH
  descriptors — AND mutually unique-nearest; a single-sided hint always goes to review. On the real
  9360-row ledger this preserved every legitimate pair (single-sided pairing was pure coincidence
  risk with zero benefit). 43 categorize tests (a regression for every finding).

- [ ] **P0.5 — IN-TRANSIT TRANSFER BRIDGING** (user insight, 2026-07-14, verbatim intent): *"when I
  transfer all my money from Chase to SoFi I had to do it in chunks, and whenever I transfer, the
  money is in the air for 3–5 business days — it leaves Chase and takes 3–9 days to enter SoFi.
  Same when I moved everything from SoFi to Robinhood. That's why the chart goes to 0 then back up…
  it knows the money left one account and it knows where it went and when, so the chart can stay
  accurate: I had 30k in Chase, moved 5k to SoFi on Jan 3, from Jan 3–8 the money wasn't in Chase
  OR SoFi, but on Jan 8 it was in SoFi — it should bridge that. It knows the money is mine, it's
  just being transferred."* This is a THIRD confirmed dip mechanism, alongside (not replacing)
  P0.1 (RH cash model) and P0.2 (missing statement): settlement float during the chunked
  Chase→SoFi (Oct–Nov 2023) and SoFi→RH (2025) migrations produces real V-dips.
  **Spec:**
  - [x] **(a) Pairing prerequisite — widen the match window — SHIPPED (pass 12, commit `c185d6d`).**
    `detectTransfers` now pairs auto-pairable legs within **±10 calendar days** (ACH float).
    IMPORTANT REFINEMENT from the 4-round review: "auto-pairable" = TWO-SIDED/structural evidence
    only (same-day mirror, S6 linked pair, both-in-Transfers, OR both descriptors hinted). A
    SINGLE-sided hint (e.g. "ONLINE TRANSFER TO SOFI" out ↔ a generic "DEPOSIT" in) no longer
    auto-pairs — it FLAGS for review, because it silently mislabels coincidences when the true
    partner is absent. **Consequence for (b–d):** in-transit bridging now runs on VERIFIED pairs
    only, which includes auto-paired both-hinted ACH legs AND user-confirmed single-sided ones
    (via S5 "Link as transfer…" / the P1.1 cluster confirm). Many Chase→SoFi/SoFi→RH legs whose
    inflow descriptor is generic will surface in review for one-click confirm rather than
    auto-pairing — consistent with the app's "never guess, surface for review" philosophy.
  - **(b) Derivation — an explicit "in transit" component.** For every transfer group whose two
    legs live in different accounts with `outflow.postedOn < inflow.postedOn`, add `|amountCents|`
    to a new `inTransitCents` bucket for days `[outflow.postedOn, inflow.postedOn)`. Surface it as
    its own series component in `netWorthSeries` (src/services/derivation.ts) — **never silently
    smooth the account lines themselves**; the per-account curves stay bank-true.
  - **(c) UI honesty.** Chart renders the bridge visibly (e.g. the total line includes in-transit,
    with the tooltip/scrub text saying "includes $5,000.00 in transit — Chase → SoFi, sent Jan 3,
    landed Jan 8"); the hero/net-worth figure on such days shows the same note. Legend/coverage
    grammar gains "in transit" alongside "partial".
  - **(d) Guards + edges.** Bridge ONLY verified pairs (transferGroupId with exactly 2 legs, both
    present in the ledger — never bridge into a P0.2 coverage gap or from an unpaired leg);
    unequal legs (wire fees) bridge the OUTFLOW amount and the tooltip names the difference;
    same-day pairs are a no-op; chunked migrations = many overlapping bridges that must sum
    correctly (TDD: the Jan-3/5k-Jan-8 example, overlapping chunks, fee-shaved pair, unpaired leg
    NOT bridged). Pure math 100% covered; real-data validation = the Oct–Nov 2023 and mid-2025
    windows must visibly flatten while every statement still reconciles to the cent.
  - **Order note:** do the pairing widen (a) BEFORE or WITH P0.4's OVERDRAFT hint work (same file,
    same detector), and expect P0.1's cash model to interact — a SoFi→RH "dip" is part float (this
    item) and part uncounted RH cash (P0.1). Reconcile both against the GROUND TRUTH story.

## 🔧 P1 — REVIEW-INBOX CLUSTER UX (the user's active workflow, 2232 items)

- [ ] **P1.1 — cluster cards must support partial, informed decisions** (user, 2026-07-14:
  "I don't want to accept all 240 at once… I can't even expand to see the data… what if I
  want to confirm specific ones and not others"). Spec:
  - **Expand a cluster** to the FULL member list (virtualized/paginated beyond ~50 rows,
    not a `+236 more` dead end); each row shows date · description · account · amount and
    opens the txn sheet on click (full context: counterpart, history, notes).
  - **Per-row confirm/reject**: checkboxes + "Confirm selected (N)" / "Leave in review";
    row-level quick actions (recategorize just this row → splits it from the cluster).
  - **Within-cluster filters/sort**: by amount, date range, account — so "confirm all the
    small ones, inspect the 3 big ones" is one gesture.
  - **Safety affordance**: cluster header shows sum + count + date span; for transfer-kind
    clusters show the NET against the counterpart cluster (the two SoFi overdraft clusters
    should visibly net $0.00) so "Confirm all" becomes an informed act, not a leap.
  - Files: review-inbox service (`src/services/review-inbox.ts`), the review page cluster
    cards (`src/components/**/review*`), `confirmClusterAction`/`recategorizeClusterAction`
    (src/app/transactions/actions.ts:383/399) — add `confirmSelectedAction(ids)` reusing
    bulk-edit's undo plumbing.

## 📊 P2 — CHART & COVERAGE TRANSPARENCY

- [ ] **P2.1 — "+2 more" must be expandable** (user: "it says SoFi Checking +2 more but I
  can't expand to actually see which accounts aren't being counted"). Everywhere a coverage
  label truncates (hero, chart header, tooltip via `src/lib/coverage-label.ts` callers):
  make it a popover/disclosure listing EVERY covered and missing account by name for that
  day/window; in the S8 focus modal show the full list inline (space is no longer scarce).
- [ ] **P2.2 — name the CAUSE of a coverage gap on the chart.** Where `basis=gap` spans
  exist (P0.2), annotate the dashed span: "Chase ····3522 uncovered — statement
  2023-10-13→11-10 missing" (derive from the statement_periods hole). Turns a scary dip
  into an actionable to-do. Consider a "Data health" card listing every gap + the exact
  statement to fetch.
- [ ] **P2.3 — focus/expand EVERY dashboard card** (user asked 2026-07-14; the chart got it
  in S8). Generalize the `ChartFocus` pattern (always-mounted card + view-transition-name
  hop into a native `<dialog>`) into a `FocusableCard` wrapper and apply to the activity
  hub, accounts, and recent sections. (Dashboard REORDER shipped in S7 the same day.)

## 🧭 P3 — REMAINING ROADMAP (Tracks; user order 4→3→2→1 — 4 and 3 are DONE)

---

### 🗺️ Session roadmap — how the remaining work splits into sessions

> User decision (2026-07-13): tackle the four tracks in priority order **4 → 3 → 2 → 1**
> (loose ends → nothing-read-only → motion/focus → multi-episode recurring), one focused
> session at a time, each ending with a handoff prompt for the next. Sizes are estimates —
> sessions can merge or split. Polish items (see "Known small issues") fold into the nearest
> relevant session. Deployment (Turso/libSQL + auth, then iOS) stays gated until the end.

**Track 4 — Loose ends (option 4)** — ✅ CLOSED 2026-07-14 (pass 10)
- [x] **S1 — covered-accounts chart phrasing** shipped (commit `2e26bc3`): adaptive "only …"/"missing …"
  labels via `src/lib/coverage-label.ts`. See "Active priorities".
- [x] **S1b — data hygiene (RESOLVED 2026-07-14, pass 10).** Three closures:
  1. **Cross-format reconciliation dedupe shipped** (`feat(import)` commit): when an incoming row's
     exact hash misses (different raw text across export formats), it now dedupes against existing
     balance-affecting rows from other sources by (account, posted_on, amount) with **multiset
     consumption** (two genuinely identical same-day charges still both count). New visible
     `FileOutcome.dedupedCrossFormat` counter. This is the user's stated model: files are parsed once,
     the DB is master, overlapping uploads are harmless by design. TDD'd (4 new tests, 17/17 import
     suite, 1034 unit total).
  2. **The 4 "orphan alt-export CSVs" were NOT user data** — byte-identical to
     `tests/fixtures/synthetic/` files (fake SoFi balances $20,078.53 + $8,150.00 explain the old
     +$28k double-count finding exactly; the "SoFi savings" rows had arithmetic-perfect fake interest).
     Deleted from `data/originals/` (now removed, archive lives in `data/statements/`) per the standing
     "no fake data" directive; scratch backup kept one session. Real db untouched.
  3. **Robinhood Crypto last4 + archive folder** (user chose rename+migrate): `last4=8474` set, folder
     → `data/statements/robinhood-crypto-8474/`, 8 `storage_path` rows repointed + verified on disk
     (`data/db-ops-2026-07-14.ts`, backup `data/backups/pre-dbops-2026-07-14.db`, Δ net worth = 0).
  Also: **Knack Payout → NEW Income › Tutoring** (60 rows, $10,023.00; 45 from Other Income + 15 from
  the review queue — all literal "Knack Payout" direct deposits; review queue 2255 → 2232).

**Track 3 — "Nothing read-only" (option 3, ~6 sessions)** — the north star; each a shippable slice.
- [x] **S2 — inline-edit primitive shipped (pass 9).** Built the pure edit-state core
  `src/lib/inline-edit.ts` (reducer + `keyToIntent` + `resolveTextCommit`/`resolveAmountCommit` →
  save/noop/invalid; TDD'd, src/lib 100%), the `useInlineEdit` hook (optimistic display + rollback,
  generation guard against overlapping saves, try/catch on a thrown/rejected save, Toast+Undo, keyboard
  focus return, Enter/Escape/blur grammar), and `<InlineEditableText>` (a role=button span that flows/wraps
  like the surrounding text, click→input in place, no layout jump). **First use: the account detail `<h1>`**
  is now editable in place via `renameAccountAction` (value-returning; reuses `updateAccount`). `StatCard`
  gained an optional `className`. e2e `zz-account-rename` (Escape cancels · Enter saves · Undo restores ·
  reload persists); adversarial 4-lens review → 5 findings fixed (2 high: save-rejection swallow, keyboard
  focus loss; 1 med: overlapping-save race; 2 low). Verified on real data (hover affordance, edit-in-place
  input, no jump) at desktop + mobile; net worth untouched.
  - NOTE: `<InlineEditableAmount>` component **deferred to S4** (its first real wiring = manual-txn
    amounts). The hard part is already done + tested here: `resolveAmountCommit` (cents via the ledger's
    string-math parser) and the shared hook are generic, so S4 is a thin renderer.
- [x] **S3 — inline-rename everywhere (pass 10).** Every name edits where it's shown via the shared
  `<InlineEditableText>`: **category detail `<h1>`** (net-new `renameCategory` service in
  `src/services/category-edit.ts` — guards sibling-name uniqueness with a readable error and BLOCKS
  transfer/system kinds because transfer detection matches on their names; 6 unit tests) +
  `renameCategoryAction`; **merchant detail header** (`MerchantNameHeading`, old name becomes a
  contains-alias so imports keep resolving); **series detail `<h1>`** and the **sheet's merchant row**
  (both bespoke toggle-inputs replaced by the primitive). **Account type/subtype now editable** in the
  edit sheet behind an explicit "re-derives history" checkbox: `editAccount` re-runs `rebuildAccount`
  on a semantics change, and the action rejects unconfirmed changes. e2e `zz-inline-renames` (series /
  category / merchant, each Undo-restored + reload-proven).
- [x] **S4 — inline txn fields in the ledger-row expander (pass 10).** Each ledger row gains a chevron
  expander (no sheet needed): **notes** edit on every row; **date / amount / description** edit ONLY on
  manual rows (`importFileId IS NULL` threaded through `LEDGER_SELECT`/`toLedgerRow` as
  `LedgerRow.isManual`) — imported rows render their facts read-only with an explicit "audit trail"
  note; **merchant** renames inline (lazy-loaded via the sheet's panel action). Built
  **`<InlineEditableAmount>`** (formats cents, edits through the string-math parser — no floats) and
  `resolveDateCommit` (pure, 100%); `InlineEditableText` gained a `resolve` override for dates. New
  `editManualTransaction` service recomputes the row's dedupe identity (occurrence index + hash) and
  rebuilds derived balances; 3 service tests + e2e `zz-zz-txn-expander` (manual edit round-trip +
  imported-row immutability).
- [x] **S5 — linkable (pass 10).** Transaction sheet gains two lazy-disclosure panels:
  **"Link as transfer…"** pairs a row with its counterpart (opposite sign, other account, ±14d,
  nearest amount first — the human override for fee-shaved/date-drifted pairs the detector can't
  match; outflow id keys the group, detector category conventions) + **Unlink** (keeps categories);
  **"Attach to recurring series…"/Detach** wires recurring-links into the ledger. Review-hardened
  (12 verified agents): stale-counterpart detach on group-key re-mint, zero-amount guard, link-only
  unlink undo, and **lossless series-link undo** — `undoFieldsSchema` grew `seriesLinkSource`,
  `applyUndoPatch` restores link ownership + re-settles series stats, so undo can't strand rows
  detector-invisible. `src/services/transfer-links.ts` (11 tests) + e2e `zz-zz-linking`.
  NOTE: link-by-DRAG deliberately deferred to S7's pointer-drag hook — the affordance version is the
  keyboard-accessible baseline a11y requires anyway.
- [x] **S6 — linkable cont. (pass 10).** **Merchant→category default rule** editable on the merchant
  page (picker + Undo; explicit "Apply to N uncategorized" backfill that never overwrites, lossless
  undo). **Card↔payment-source account link**: `accounts.payment_source_account_id` (migration 0005 —
  trimmed by hand: 0004 lacked a snapshot so drizzle-kit tried to re-add its columns, which would have
  crashed boot; LESSON: hand-written migrations must also hand-write their snapshot), Edit-sheet
  "Payment source" select (credit-only, cash-account target, never self), and `detectTransfers`
  treats the linked pair as hinted → card payments auto-pair without a descriptor match.
- [x] **S7 — movable (pass 10, `a5aae4e`).** Dashboard **Arrange mode**: sections drag-reorder (HTML5
  drag + keyboard Move up/down — every drag has a keyboard equivalent) persisted to a new
  `dashboardLayout` key in `app_settings`, normalized via pure `src/lib/reorder.ts` so a stale layout
  can never hide or duplicate a section. **Category re-parent**: `moveCategory` + a Menu of VALID
  destinations on the category page (same-kind roots + top level; depth/kind/clash/hint guards;
  parentId pointer only — history untouched; Undo). Review-hardened (7 confirmed findings fixed:
  Firefox dataTransfer, prop-desync reconciliation, duplicate-id dedupe + schema refine,
  aria-disabled edge buttons, undo-result checks). DEFERRED with reasons: **txn kanban drag** (the
  inline chip picker already covers recategorization — kanban is motion sugar, revisit with S10),
  **dashboard institution-card drag** (accounts reorder lives on /accounts; adding a second surface
  duplicates state), **category MERGE** (deep referential surface — budgets, rules JSON, merchant
  defaults, suggestions — needs its own guarded data-pass like the S1b/dedupe work).

**Track 2 — Motion + focus (option 2)** — all compositor-only + reduced-motion-gated.
- [x] **S8 — chart focus mode (pass 10).** `ChartFocus` wraps the net-worth chart: an expand button
  opens a native `<dialog>` (focus trap, Escape, focus return — the card stays MOUNTED so the opener
  survives for focus return) with the same scrub chart rendered at `h-[55vh]`; both instances share
  the dashboard window context so a zoom made in focus survives closing. The
  `view-transition-name` hops between card and dialog → real shared-element morph via
  `document.startViewTransition`, skipped under `usePrefersReducedMotion` and where unsupported.
  e2e `zz-zz-chart-focus`.
- [x] **S9 — activity hub merged (pass 10).** ToReviewCard + pace/investments bento + the
  UpcomingBillsStrip now compose ONE `Activity` section with tight internal rhythm (gap-4) — the
  dead gap is gone. `DASHBOARD_SECTION_IDS` dropped `upcoming`; the layout setting became
  read-tolerant (`z.array(z.string())` + normalize-on-use) so a saved layout can never crash
  `readSettings` after a section rename/removal.
- [x] **S10a — motion, first slice (pass 10).** Route-level fade-rise via `src/app/template.tsx`
  (re-mounts per navigation); dashboard section entrance CASCADE (per-index `animationDelay`,
  fill-mode both); the hero net-worth headline now `NumberRoll`s on change (never on first paint);
  institution sub-cards hover-lift (`-translate-y-0.5`, `motion-reduce` guarded). All
  compositor-only; the globals.css reduced-motion guard zeroes everything.
- [x] **S8 follow-ups (fixed, pass 11 2026-07-14):**
  (a) morph timing: `flushSync` inside the `startViewTransition` callback + `useLayoutEffect`
  for `showModal()`/`close()`. **Doctrine change discovered live-testing in real Chromium:
  Escape must close NATIVELY** — intercepting `cancel` (preventDefault → morph-close) consumes
  the close-watcher's user-activation grant (the next Escape fires no `cancel` at all) and a
  view-transition callback scheduled from inside close-request processing was observed never
  running → modal stranded open. Now: no `onCancel`; `onClose` syncs React state after any
  native close; the morph plays on expand/X/backdrop only. Headless e2e can't catch this class
  (no VT support there — it green-lights the fallback path), hence the live-browser check.
  (b) range pill lifted into `ChartFocus` (controlled `activeRange`/`onRangeChange` on
  ScrubChart/NetWorthChartPanel, mirroring `activeWindow`) — the modal opens on the pill being
  inspected, both directions e2e'd; and a pill click now NAVIGATES the shared history to base
  (`PUSH_BASE` — nullable stack entries in `window-history.ts`, unit-tested) instead of
  `reset()`-wiping the Back/Forward trail.
  (c) adversarial review (4 lenses × 3 refuters) confirmed + fixed 4 more: date-input windows
  with <2 chartable points are now ignored like hair-thin drags (was: ALL-series fallback
  mislabeled with a one-day caption — an all-time delta under a single-day label);
  ChartFocus got Sheet.tsx's pointerdown-origin backdrop guard (drag-release over backdrop no
  longer closes); the open focus modal is axe-swept in its e2e (overlay-open doctrine);
  the dashboard entrance cascade plays ONCE (classes removed on animationend — keyed reorders
  restart CSS animations, so arrange-mode moves flashed the moved section invisible; the global
  reduced-motion guard also zeroes `animation-delay` now, killing the fill-mode-both blank
  window inline delays created).
  (d) `e2e/axe-helpers.ts analyzeSettled()` — ALL axe scans (7 specs) settle every finite
  animation first (Web-Animations `finished`, not timeouts): the S10a route fade-rise made axe
  read mid-animation BLENDED colors (ink-faint scanned at 4.2:1 mid-fade, clean settled) —
  that was the whole "/investments/[holding] dark" gate failure; there was never a real
  contrast violation.
- [ ] **S10b — micro-interactions (remaining):** categorize checkmark-draw + (tasteful) confetti on
  clearing a review cluster; spring hover states on chips/buttons; NumberRoll in more stat surfaces
  (StatCards, account balances); consider the txn-kanban drag here where motion carries the meaning.

**Track 1 — Multi-episode recurring (option 1, ~4 sessions)** — schema + detection + projection + UI.
> **User intent (2026-07-15, verbatim):** *"when I click a transaction I should be able to say okay
> this was recurring for this period, sporadically… Netflix on the 3rd for 5 months, then I stopped,
> signed up again at a different price. I have to be able to categorise everything."* So S11–S14
> below must also deliver, on top of the schema/detection/UI:
> - **A from-the-transaction attach flow.** Click a txn → "Recurring…" → create a new series or
>   attach to an existing one; define THIS episode (cadence | sporadic, anchor day, amount±tolerance,
>   start, end|ongoing); PREVIEW every matching existing txn (same merchant/description key + amount
>   within tolerance + cadence window) → confirm to attach + categorize them ALL in one gesture. This
>   is the "categorise everything" lever — one confirm tags a whole recurring history. Reuses the S2
>   inline-edit + P1.1 cluster-confirm plumbing.
> - **Sporadic episodes** (no fixed cadence; occurrences are the attached txns) and **explicit
>   cancelled gaps** between episodes, both rendered on the calendar.
> - **Precedence guard:** attaching applies the episode category to matched txns but never overwrites
>   a `user` category — the same eligibility doctrine as the transfer detector (P0.4).
> This is Track 1 in the user's own 4→3→2→1 order — intentionally LAST, after P0 data correctness
> (a recurring editor is only as good as the reconciled ledger under it). Pure-first TDD: episode
> match, annualized-cost-across-episodes, gap detection, sporadic enumeration, split/merge — 100%.
- [ ] **S11** — `recurring_episodes` table + migration (each existing series → one open episode,
  behavior-preserving); episode-aware `isSeriesActive` + projection (`toProjectable`/`forecast`). TDD
  the projection math (pure, 100%).
- [ ] **S12** — auto-detect episodes: gap-analysis split in `recurring.ts` (gap > ~2× local cadence →
  new episode; infer per-episode cadence + day). TDD (StephanCodes→1 closed, Netflix→several).
- [ ] **S13** — calendar + list: episode-aware day-state grammar (active solid/accent vs past-episode
  muted/outlined); series list groups/labels active vs historical; fixes the wrong "Next expected" on
  ended series.
- [ ] **S14** — per-episode editor UI on the series detail page (add/remove, set start/end, cadence +
  day, amount, one-click "mark ended"); per-episode cadence sentence. Ties into "nothing read-only".

**Then (gated):** deployment — Turso/libSQL migration + auth before any public deploy of real
financial data; then iOS.

---

## 🎯 Active priorities (this thread)

- [x] **Investments — daily price carry-forward to today (pass 13, commit `5890c14`).** The
  per-holding price chart + the portfolio value chart were built straight from the price
  cache / daily balances, so they FROZE at the last quoted/rebuilt day ("the ETH price graph
  ends July 10"). New pure lib `src/lib/price-series.ts` `carryForwardTo(points, today)` extends
  a series flat to today: real points stay solid, the tail past the last real day repeats the last
  value tagged `complete:false` → drawn dashed ("estimated — no fresher price"). Wired into
  `holdingDetail.priceSeries` (today param) + the portfolio value series on /investments. Header
  stats / TWR stay on the REAL series. Derivation (`rebuildInvestmentHistory`) already extends
  daily_balances to today when rebuilt, so no change there. No e2e churn (fixture prices reach the
  pinned today). FOLLOW-UP: the investment ACCOUNT-detail chart (accounts/[id]) still stops at the
  last cached day — `accountSeries` feeds `buildPortfolio`, so extend it at the page layer only if
  wanted (not the named complaint).
- [x] **Investments — live "Refresh prices" button (pass 13, commit next).** `refreshPrices`
  gained `force` (bypasses the priceStalenessHours skip so a manual press pulls a LIVE quote at the
  exact press time) + `asOf` (the fetch timestamp). `refreshPricesAction` now returns a structured
  `ActionResult<RefreshPricesSummary>`; the button is a client component (`useTransition`) with a
  spinner, an "Updated <time>" stamp, and an outcome toast (positive / neutral-partial / negative /
  up-to-date). Provider outages still degrade to cached prices (no partial writes — quotes are
  written in a per-provider transaction after the fetch). Adversarial review (4 lenses) → fixed 1
  low finding (the partial toast overcounted a single provider outage as "N sources" — now says
  "some sources were unreachable", no misleading count). `MONEYAPP_FAKE_PRICES` still serves
  dev/e2e; the live path hits Yahoo/Coinbase. +1 `force` unit test.
- [x] **Data-correctness review (2026-07-13, pass 8)** — user-directed triage of the opaque income
  + the SoFi backfill. Applied via `data/categorize-review-2026-07-13.ts` (backup
  `data/backups/pre-catreview-2026-07-13.db`; in-txn net-worth/integrity/count guards → rollback on
  anomaly). 428 rows touched; **net worth $94,144.53 unchanged**, integrity ok, 9360 active txns, 83
  import_files. Total income 2022–2026 **$205,266 → $116,380** (−$88,886 — an honest correction, see below).
  - **DEPOSIT ID NUMBER (5 rows, $30,413)** → Transfers › Internal Transfer. User: their dad gave them
    euros in Spain → converted to USD → deposited (these inflows) → wired back to dad (the already-Transfers
    "CONSUMER ONLINE INTERNATIONAL WIRE" outflows −$25k/−$3.3k on Mar 4–5). A currency pass-through/wash,
    NOT the user's income. Both legs now Transfers → nets ~0, out of income.
  - **SoFi backfill (282 uncategorized, Oct 2023→Jul 2024)** auto-categorized per user's choice: 168
    internal sweeps + Chase moves → Transfers › Internal Transfer; 19 Discover e-payments → Transfers ›
    Credit Card Payment; 12 Interest Earned → Income › Interest; 13 rewards/promo → Rewards › Cash Back;
    the remaining **70** (debit-card purchases + misc, e.g. Fordham WEBCHECK) → **review queue** (flagged,
    left uncategorized) for normal categorization.
  - **ATM cash deposits (49 rows, $53,948, mislabeled "Salary")** + **Zelle-from-individuals (92 rows,
    $6,194, "Other Income")** → **reset to uncategorized + review queue** (+190 items total). User's call:
    these are heterogeneous (cash income / gambling / dad currency-exchange / a friend's tuition money;
    Zelle = reimbursement-vs-income unknown) and they want to tag each ONE BY ONE in the app's review UI
    (this is a concrete pull for the "nothing read-only" review-cards workflow). Income is now a known
    FLOOR ($116k) that grows back as the queue is tagged. Nothing fabricated; raw descriptions intact.
  - FOLLOW-UP: the +190 review-queue items are the user's to categorize. Knack Payout ($10k, tutoring
    platform) was LEFT as Income › Other Income (clearly income; user can move to a dedicated bucket).

- [x] **SoFi statement ingestion (2026-07-13, pass 6)** — built `sofiCombinedStatementPdf` parser
  (combined Checking-9067 + Savings-5791 sections per PDF; commit `611e6c7`, 66/66 sections reconcile
  to the cent). User uploaded 33 monthly combined statements (Oct 2023→Jun 2026). The statements
  OVERLAP the CSV-sourced SoFi data and use different raw descriptions (would double-count), so user
  chose **Replace**: superseded the 970 CSV txns + 2 CSV import_files, imported 1290 statement txns,
  **preserved 960 categories** by (account,date,amount) match (so only the pre-2024-07 backfill is
  uncategorized → review queue), re-applied Fordham→Salary. Real db: net worth $94,144.53 unchanged,
  0 negative months, 102 periods reconciled, integrity ok. Harness `data/replace-sofi.ts`, backup
  `data/backups/pre-sofi-replace-2026-07-13.db`. Note: `categorizeAll` recovered 0 (SoFi's 100% cat
  was not rule-based) — the ~282 backfill txns categorize via the review queue over time.

- [x] **Dynamic dashboard §1** — shared window-history reducer + lifted ScrubChart brush state (commit `7a97003`).
- [x] **Dynamic dashboard §2/§4** — brush the net-worth chart → linked activity panel + ← Back/→ timeframe history (commit `913a090`).
- [x] **Per-account coverage report** — done as analysis (see "Data coverage" below).
- [x] **Chart names WHICH accounts are missing** at each partial day (tooltip "● Partial · no Robinhood Crypto, Venture X", header, hero, aria) — commit `194477d`.
- [x] **Account editable from its detail page** (name / institution / last4) — commit `8b66cda`. First slice of "nothing read-only".
- [x] **Statement ingestion + per-account storage (PRIMARY MISSION)** — built 3 real-bank PDF
  parsers (Chase College Checking, Discover it, Robinhood Crypto), re-architected the archive to
  per-account folders the DB references, and imported ALL 52 real files in `data/inbox`. Every file
  is now tracked in `import_files` (52 rows, was 13); 36 periods reconcile to the cent, 8 crypto
  value-anchors, 0 gaps; net worth @2026-07-10 unchanged (Δ=0); Chase 3522 history back to 2022-08-25;
  Discover last4 learned = 4741. See the (now historical) plan sections below. Details: [[moneyapp-statement-ingestion-2026-07-13]].
- [x] **Chart: also name the COVERED accounts** (not just missing) — shipped as adaptive phrasing:
  on a partial day the tooltip/header/hero/aria now name whichever list is more concise via the pure
  `src/lib/coverage-label.ts` helper — "only Chase ····3522" on 2022 days (1/9 covered), "missing
  Robinhood Brokerage, Robinhood Crypto +2 more" when most accounts are covered. One canonical verb
  (`kind`) across all four surfaces so wording can't drift. Verified on real data.
- [x] **Robinhood Crypto last4 — RESOLVED 2026-07-14 (user chose rename+migrate).** `last4=8474`,
  folder migrated to `data/statements/robinhood-crypto-8474/`, 8 `storage_path` rows repointed and
  verified on disk. Future uploads land in the new folder via the unchanged `accountSlug()`.
- [x] **4 orphan alt-export CSVs — RESOLVED 2026-07-14: they were FAKE.** Byte-identical to
  `tests/fixtures/synthetic/` fixtures (leftover demo seeds that survived the 2026-07-13 purge because
  they sat in `data/originals/` disguised as untracked "alt exports"). The old +$28,173.87 dry-run
  delta ≈ the fixtures' fake SoFi balances ($20,078.53 + $8,150.00) — it was never a dedupe-hash
  problem alone. Deleted (with a one-session scratch backup); `data/originals/` removed (empty; the
  real archive is `data/statements/`). The REAL fix that came out of it: cross-format reconciliation
  dedupe in the import pipeline (see S1b above), so any future overlapping re-export dedupes against
  the DB by design. Lesson recorded: **synthetic-looking patterns (arithmetic-perfect interest, rigid
  monthly transfers) are a data-authenticity smell — check `tests/fixtures` before importing.**

## 🧮 Spending math — review + fix (2026-07-13, pass 5)

User asked "why is Spent negative in Jan 2026?" + review the math for credit/debit/investment.
Adversarially verified (2 review workflows) against the real db.

**Root cause of negative Spent:** `periodTotals` netted positive amounts in expense categories
(refunds/credits) against outflows with NO floor → 9 months went negative (2024-09 = −$14,439,
2026-01 = −$12,260, …). Dominated by ~$86k of INFLOWS miscategorized as expense (see clusters below).
The per-account-TYPE sign math is otherwise sound (investment buys/sells excluded, dividends→income,
transfers transfer-kind); the problem is (a) fragile netting + (b) categorization.

- [x] **Part A — gross debit-only "Spent" (commit `0614faf`).** `periodTotals`/`cashFlowByPeriod`/
  `dailySpendHeatmap` now count only expense-category DEBITS as Spent (mirrors `period-activity.ts`,
  which the dashboard already used — the two surfaces now agree). Positive expense-category amounts →
  a new `refundsCents` field, never netted into Spent; `netCents = earned + refunds − spent` (net
  unchanged, nothing dropped). Spent StatCard drill-down gained `flow=out`. Real-data: Jan 2026 Spent
  −$12,260 → **+$4,808** ($17,068 refunds surfaced). Per-category breakdown (analytics.ts) stays netted
  (separate view, UI-clamped). The inflated savings-rate for the Fordham months normalized once Part B landed.
  - [x] **Part A follow-up — refunds surfaced (pass 7, this commit).** `refundsCents` now shows as a
    conditional 5th "Refunds" stat card on /spending (only when > 0, so refund-free periods keep the clean
    4-card grid; 19/48 real months have refunds, $4.76-$1,959.74 after Part B). It links to
    `category=spending, flow=in` — the EXACT rows summed into `refundsCents` (verified: uncategorized
    positives excluded from both) — so the number reconciles to the list it opens. Net now reads as
    "earned + refunds - spent" right on the row (derivable on-screen, was the gap). On the 2-col mobile grid
    the card spans full width (`col-span-2 lg:col-span-1`) so it's a divider band, not an orphan. Pure logic
    lives in `src/lib/spending-stat-cards.ts` (9 unit tests, 100%); `StatCard` gained an optional
    `className` (additive, reusable for S2). Verified on real data (Jul 2026 $150, Mar 2026 $1,248.80 both
    reconcile) at desktop + mobile; adversarial 4-lens review -> 0 findings.
- [x] **Part B — recategorized the miscategorized inflows (REAL-DB, done 2026-07-13).** 134 rows
  recategorized via `data/recategorize-inflows.ts` (backup `data/backups/pre-recategorize-2026-07-13.db`,
  in-txn Δ=0 + integrity guards). VERIFIED on the real db: **0 negative-spent months** (was 9-10),
  net worth @2026-07-10 unchanged ($94,144.53), integrity ok, 9040 active txns, 52 import_files.
  Jan 2026 now: spent $4,808 · earned $17,776 (aid counted as income) · savings 73%. Clusters + targets:
  - **Fordham "…INVOICE" lumps** (6 rows, checking, +$51,872, currently Education) → **Income › Financial
    Aid** (NEW subcat). User's words: dad pays tuition from his (untracked) account, aid is deducted and
    the balance refunded to the user — net-new money IN from outside, not the user's own money (so not a
    Transfer) and not a refund of the user's own spend. Income is the honest treatment; a distinct
    "Financial Aid" bucket keeps it separate from earned wages (rename to "Papa money" if wanted).
  - **Fordham biweekly** (46 rows, savings, +$30,716, currently Education) → **Income › Wages** (work-study).
  - **"HOUSE RENT" received** (1 row, checking, +$3,505, from REZAUL KARIM KHATUN, currently Housing/Rent) → **Income**.
  - **Brokerage "ACH Deposit"** (79 rows, investment acct, +$7,103, currently Other Income) → **Transfers**
    (the user's own cash moving INTO Robinhood; matches checking-side −$7,016 "ROBINHOOD" outflows).
  - **CC statement credits** ($41 "CREDIT NOT PROCESSED", $100 statement credit) → **Rewards** (consistent).
  - Predicates + a staged dry/apply harness basis live in `data/audit-spend-math.ts` + `data/diag-jan2026.ts`
    (gitignored). After Part B: 0 negative months, income correctly includes the aid/wages, savings-rate normal.

## 🔁 BIG FEATURE — Recurring charges as MULTI-EPISODE (start/end, historical vs active, intermittent)

User ask (2026-07-13, verbatim intent): a recurring charge is NOT always "one cadence forever."
It recurs in EPISODES. Examples the user gave:
- **StephanCodes** (Discover, $40): charged Aug 3 / Sep 3 / Oct 3 2025, then STOPPED. It was
  recurring only for that 3-month window. The user must be able to say "these 3 dates, then done"
  → it becomes a HISTORICAL (previously-recurring) series, not a currently-active one.
- **Netflix**: 5th of the month for 5 months → stop for a year → restart on the 13th for 2 months
  → stop → start again… SAME merchant/series, but MULTIPLE recurrence episodes, each with its own
  date range + cadence (even a different day-of-month per episode).

Requirements:
1. **Multiple episodes per series.** A recurring series owns 1..N episodes; each episode has a
   `start_on`, `end_on` (nullable = still open/active), a cadence (day-of-month OR weekday +
   interval like monthly/biweekly), and optionally its own amount. StephanCodes = 1 closed episode
   (2025-08 → 2025-10, monthly on the 3rd). Netflix = several episodes with different days.
2. **Active vs historical, everywhere.** "Currently recurring" = has an episode with `end_on` null
   (or ≥ today) whose cadence still produces charges near today. "Previously recurring" = all
   episodes ended in the past. The **calendar** must VISUALLY distinguish the two (e.g. active
   occurrences solid/accent, past-episode occurrences muted/outlined) and the series list should
   group/label them. The recurring-detail page (screenshot 2026-07-13) shows one series
   (StephanCodes, "Detected · Bill · Inactive", amount history Aug/Sep/Oct, "Next expected" Jul/Aug
   2026) — that "Next expected" is WRONG for a series that ended in Oct 2025; episodes fix this
   (a closed episode projects nothing forward).
3. **Fully editable.** On the series detail page: an EPISODES editor — list episodes, add/remove,
   set each episode's start/end, change its cadence + day, set/override amount, and a one-click
   "mark ended" (sets `end_on` to the last real charge). The editable cadence sentence
   ("charges monthly around the 3rd") becomes PER-EPISODE. Nothing read-only.
4. **Auto-detect episodes (the "AI/engine" part).** The detection engine
   (`src/services/recurring.ts`) should, for each detected series, SPLIT its linked-charge history
   into episodes by gap analysis: sort the charges, and when a gap between consecutive charges
   exceeds ~2× the local cadence interval, start a new episode; infer each episode's cadence +
   day-of-month/weekday from its own charges. So StephanCodes auto-splits into one closed episode;
   Netflix into several. The user then refines by hand what the engine got wrong (their words:
   "do it yourself with an engine like AI, and whatever you can't do, I'll do it").

Implementation notes (for whoever builds this):
- CURRENT model (single-cadence): `recurring_series` has `cadence`, `next_expected_on`,
  `status` (detected/confirmed/dismissed/merged), and user overrides (`user_amount_cents`,
  `user_cadence`, `user_next_expected_on`, `merged_into_id`); `transactions.recurring_series_id` +
  `series_link_source` (detected/user). Projection + isActive derive from the single cadence.
  Files: `src/services/recurring.ts` (detection), `recurring-links.ts` (attach/merge/detach),
  `recurring-detail.ts` + `recurring-calendar.ts`, `src/components/recurring/*`
  (SeriesDetail, CadenceSentence, RecurringCalendar, AmountHistoryChart).
- NEW model: add a **`recurring_episodes`** table (migration): `{id, series_id, start_on,
  end_on|null, cadence, day_spec, amount_cents|null, source: detected|user}`. Migrate each existing
  series to a single open episode (behavior-preserving). Rework projection (`toProjectable`/
  `forecast`) + `isSeriesActive` + the calendar day-state grammar to be EPISODE-aware. Keep the
  money-integrity guards (a closed episode never projects; merged series forward-map).
- This is a SCHEMA + detection + projection + calendar + UI change — its own multi-commit project.
  TDD the episode-split + projection math (pure, 100% src/lib). Real financial data: never
  fabricate a charge; a detected episode is a hypothesis the user confirms.

## 🧭 The big vision: "nothing read-only — everything editable, linkable, movable"

User's north star (2026-07-13): *"I don't want jack shit to be read only. I want to
be able to play around with everything and link everything and move things around."*
This is a program of work, broken into shippable slices:

### Editable everywhere
- [x] Account **name** editable inline on the detail page `<h1>` (pass 9, S2) — via the shared
  `<InlineEditableText>` primitive. (The breadcrumb reflects the saved name after refresh; it's a static
  mirror, not a second editor — one editing surface per value avoids double-edit confusion.)
- [x] Account **institution / type / subtype / last4** editable from the detail page (pass 10, S3):
  type/subtype unlocked behind an explicit "re-derives history" confirm; `editAccount` re-derives via
  `rebuildAccount` when the semantics change.
- [x] **Inline-rename anywhere a name is shown** (pass 10, S3): merchants (detail header + sheet),
  categories (detail `<h1>`, transfer/system kinds excluded — detection matches on their names),
  recurring series (detail `<h1>`), accounts (S2). Budgets already edited in place.
- [~] **Every number that's an input should be editable in place** — budget amounts [done],
  manual-txn amounts [done, S4 via `<InlineEditableAmount>`]; balances-as-anchors still via AnchorForm.
- [x] Transaction fields beyond category: **notes, date, amount (manual txns), merchant** — inline in
  the ledger row expander (pass 10, S4); imported rows stay the immutable audit trail.

### Linkable
- [ ] **Link transactions ↔ transactions** (transfer pairs) by drag or a "link" affordance, beyond the auto transfer-detection.
- [ ] **Link a transaction → a recurring series** by drag (attach), and **merge** series by drag.
- [ ] **Link merchants → categories** (a merchant-default rule) from the merchant page inline.
- [ ] **Link accounts** (e.g. a credit card ↔ its payment source) for smarter transfer inference.

### Movable / rearrangeable
- [ ] **Drag-reorder dashboard sections** (net worth / activity hub / accounts / recent) — persist per-user layout order (a `dashboard_layout` setting).
- [ ] **Drag-reorder accounts** (exists on /accounts via up/down; add true drag on the dashboard institution cards too).
- [ ] **Drag a transaction between categories** (kanban-style) as an alternative to the picker.
- [ ] **Move/merge categories** (re-parent a subcategory by drag) with re-derivation.

> Shared infra these need: an `<InlineEditableText>` / `<InlineEditableAmount>` primitive;
> a small drag-and-drop hook (pointer-based, reduced-motion-safe, keyboard alternative
> for every drag per a11y); value-returning server actions + optimistic UI + undo
> (the established Toast+undo pattern); persistence of user layout/order in `app_settings`.

## 📊 Data coverage (as of 2026-07-13, real db — POST statement ingestion)

Transactions per account (active). After ingesting the historical PDF statements the ledger
now reaches back to **2022-08** (Chase 3522). Balances are still anchored at **today (2026-07-10)**
and derived backward; net worth @2026-07-10 is unchanged.

| Account | Type | Txns | First txn | Last txn |
|---|---|---|---|---|
| Chase ····3522 | checking | 2395 | 2022-08-25 | 2026-07-10 |
| Chase Sapphire | credit | 1736 | 2025-02-04 | 2026-07-09 |
| Capital One Venture X | credit | 670 | 2026-01-16 | 2026-06-13 |
| Discover ····4741 | credit | 1024 | 2023-10-11 | 2026-06-23 |
| Robinhood Brokerage | investment | 2181 | 2024-08-15 | 2026-07-07 |
| Robinhood Cash | checking | 0 | — | |
| Robinhood Crypto | investment | 64 | 2025-11-04 | 2026-06-23 |
| SoFi Checking | checking | 670 | 2023-10-30 | 2026-05-31 |
| SoFi Savings | savings | 620 | 2023-10-27 | 2026-05-31 |

- `statement_periods` now: 36 reconciled-to-the-cent + 8 crypto value-anchors + 2 declared-range
  (Chase Sapphire spending reports), **0 gaps**. Chase 3522 + Discover gained full monthly periods.
- **Discover last4 is now 4741** — learned from the Discover it statement header on import.
- Robinhood Crypto's balance curve still comes from `holding_events × priceCache` (Stage 4a); the
  imported crypto statements add the activity ledger + tracking, not the balance.

## 🧾 Statement import — Chase ····3522 (2022-09 → 2024-07) — ✅ DONE (parser shipped)

**Shipped 2026-07-13:** `chaseCheckingStatementPdf` parser built + TDD'd + validated (21/21
statements reconcile to the cent on the printed running balance) and imported. The decoded-format
notes below are kept as reference. (Original staging plan follows.)

**Why a parser (not "Claude reads it"):** the app's PDF parser (`profiles/pdf-profile.ts`,
`statementPdf`) only matches the app's SYNTHETIC fixture header (`PERIOD_RE =
/Statement Period:\s*MM/DD/YYYY\s*-\s*MM/DD/YYYY/`). Real Chase statements use a different
layout, so all 21 fail with "No statement period found". A deterministic + reconcilable
parser is the correct standard for money (vs. one-off LLM hand-parsing, which isn't
reproducible). Build a new `chaseCheckingStatementPdf` profile and register it in
`profiles/index.ts` (before the generic `statementPdf`).

**Already done (staged, all gitignored under data/):**
- 21 unique statements deduped by statement-date → `data/statements/chase/YYYYMMDD-statements-3522-.pdf`
  (original filenames; dropped a same-date re-download `20230810 (1)` — the pipeline's SHA-dedup
  wouldn't catch a byte-different re-download of the same statement, so dedupe by date). Moved out
  of ~/Downloads. Institution-organized under `data/statements/<institution>/` for browsing.
- DB backed up → `data/backups/pre-3522-import-2026-07-13.db`.
- Dry-run harness → `data/import-3522.ts` (`node --import tsx data/import-3522.ts` = dry on a
  copy; `--apply` = real db). **Bug to fix in the harness:** also set `MONEYAPP_DB_PATH=<copy>`
  in the dry env so any stray `getDb()` can't touch the real db.

**Decoded real Chase College Checking format** (from `extractLines`):
- Period header line: `August 25, 2022 through September 13, 2022` →
  `/^([A-Z][a-z]+) (\d{1,2}), (\d{4}) through ([A-Z][a-z]+) (\d{1,2}), (\d{4})$/`.
- `Account Number: 000000889063522` (endsWith 3522 → owns this account).
- Summary section between `*start*summary` / `*end*summary`: `Beginning Balance $0.00`,
  `Ending Balance $2,923.30` (labeled amounts).
- Transaction detail between `*start*transaction detail` / `*end*transaction detail`, header
  `DATE DESCRIPTION AMOUNT BALANCE`, then rows:
  `MM/DD <description...> <amount> <running-balance>`
  - **Date is MM/DD (NO year)** → infer year from the period (period spans a year boundary for
    Dec→Jan statements: if the row month < period-start month, it's the period-END year).
  - **Amounts:** commas; **negatives sometimes have a space after the minus**: `- 2.08`,
    `- 5.98`. Normalize `-\s*` → `-`.
  - **Wrapped rows:** a trailing token like `7782` (or a continued description) can wrap to the
    NEXT line — the amount + balance are on the FIRST line; fold the orphan line into the prior
    row's description. Detect a "real" row by the leading `MM/DD` + a trailing amount+balance pair.
- **Reconciliation is exact:** each row's printed running balance = prev balance + amount, and
  the last row's balance = `Ending Balance`. Use this to validate every row (a mismatch =
  quarantined gap, never a fabricated number).

**Plan:**
1. TDD `chaseCheckingStatementPdf` against the real `data/incoming-3522/*.pdf` text (fixtures can
   be small hand-made line arrays; keep the real PDFs out of git). Register it.
2. Dry-run `data/import-3522.ts` on a COPY (with `MONEYAPP_DB_PATH=copy`, `MONEYAPP_FAKE_TODAY=2026-07-10`
   so ONLY early history changes). Confirm: 21 parsed, each period reconciles to the cent, the
   2024-07 statement dedups cleanly against the existing 2024-07-12+ rows, and the July/Nov-2023
   cadence gaps surface honestly (quarantined, not fabricated).
3. Verify net worth @2026-07-10 DELTA = 0 (today unchanged; only 2022→2024 interior added).
4. `--apply` on the real db (already backed up). Re-verify. Commit the parser code (db gitignored).
- Gaps: 2023-07 and 2023-11 statement dates are absent — likely just the Chase cycle (confirm from
  each neighbor's opening balance == prior ending balance during reconciliation).

## 🏗️ PRIMARY MISSION — clean per-account statement storage + ingest ALL real statements — ✅ DONE (2026-07-13)

**Shipped:** archive re-architected to `data/statements/<account-slug>/` (root env
`MONEYAPP_ORIGINALS_DIR`, default moved to data/statements); the DB's `import_files.storage_path`
points there; new uploads auto-store into the resolved account's folder (single-account → per-account
slug, multi-account → `<institution>-combined/`, parse-fail → institution bucket); the 13 legacy flat
files were migrated (`migrateStorageLayout`). Confirmed slugs: chase-checking-3522, chase-sapphire-9805,
capital-one-venturex-4147, discover-4741, robinhood-brokerage-3525, robinhood-crypto, robinhood-cash,
sofi-checking-9067, sofi-savings-5791. All 52 `data/inbox` files imported + tracked; 3 new parsers
(Chase checking, Discover it, Robinhood crypto) built + TDD'd. Key decode wins below (kept as reference):
the Discover statement prints only the TRANS date but bills by POST date → each txn's postedOn is clamped
into its statement's `[start,end]` (transactedOn keeps the real date) so date-range reconciliation is exact.

_Original goal (for reference):_ User goal: ONE clean `data/` with **per-account subfolders**, each holding that account's
statements; **the DB references those paths** (`import_files.storage_path`); **auto-store on
upload** into the right account folder; **every statement the user gave is tracked** (currently
only 13 of ~60 are). No fake data (done — see cleanup below).

Why this is the fresh session's job (not a tail-end change): it's coupled + trust-critical.
The parser resolves which account each statement belongs to → that drives the per-account
folder → so the storage change must happen AFTER parsing. And "track all files" REQUIRES
importing them, which needs the real-statement parsers. Doing it piecemeal leaves a
half-migrated pipeline on real financial data. Do it as ONE reconciled unit.

Current storage code (localized — the change is bounded): `src/services/import/service.ts`
`originalsDir()` (line ~190) + the archive step (line ~266-288) writes
`data/originals/<sha16>-<safeName>` and records `storage_path`. Change: after account
resolution, write to `data/statements/<account-slug>/<name>` and store THAT path. Migrate the
17 existing files + UPDATE their 13 `import_files.storage_path` rows. Multi-account statements
(e.g. a SoFi combined, a multi-account QFX) need a rule — recommend per-INSTITUTION folder as
the fallback, or the primary account. (Honest design note: per-institution is simpler and
handles combined statements; per-account is what the user asked — offer both, default to the
user's per-account with an institution-level bucket for combined files.)

**What to ingest (all real, currently scattered — consolidate + import + reconcile to the cent):**
- `data/inbox/` — 52 real statements the user gave that are NOT yet imported: chase 24 (the 21
  historical 3522 checking PDFs 2022-24 + Chase3522_Activity.CSV + 2 Chase Sapphire-9805 spending
  reports), discover 11 (real Discover it ****4741 statement PDFs 2023-24 + CSVs), robinhood 10
  (brokerage activity CSVs + crypto statement PDFs 2025-11/12), capital-one 5 (VentureX-4147
  statement PDFs), sofi 2 (Checking-9067 / Savings-5791 CSVs).
- `data/originals/` — 17 real ALREADY imported (13 tracked import_files + 4 untracked alt exports).
- Parsers needed (real formats, not the synthetic "Statement Period:" template): **Chase checking
  PDF** ("… through …" — decoded, see below), **Discover it PDF** ("DISCOVER IT CARD ENDING IN
  4741 | … | MM/DD/YYYY - MM/DD/YYYY"), **Robinhood crypto/brokerage PDF**, **Capital One VentureX
  PDF** ("Venture X Card | Visa Infinite ending in 4147 | <mon d> - <mon d>"). CSV/OFX parsers for
  Chase deposit / Discover / SoFi / Robinhood likely already exist (chaseDepositCsv etc.) — verify.
- Reconcile every statement (running balance / begin-end) to the cent; gaps quarantine, never fake.
  Pin MONEYAPP_FAKE_TODAY=2026-07-10 so only history extends, "today" stays put.

## 🗂️ Statement files — CLEANED (2026-07-13)

The DB is 100% real: 9 real accounts (VentureX-4147, Chase-3522, Sapphire-9805, Discover,
Robinhood Brokerage-3525/Crypto/Cash, SoFi-9067/5791), 0 synthetic. `import_files` tracks 13
real uploads; the rest of the 7296-txn data came via the `data/*rebuild*.ts` scripts (no
`import_files` rows), which is why the DB "doesn't track every statement".

**Cleanup done (user directive "delete every fake seed, keep only what I uploaded"):**
- DELETED **206 synthetic fixtures** from `data/originals` (223→17; fake accts
  ****4321/2222/3333/7777/5555, `"Statement Period:"` template; none DB-referenced; backed up to
  scratch tgz first). DELETED **`data/demo/`** (9.2M fake demo-seed db; regeneratable via
  `pnpm demo:load`). REMOVED redundant `data/statements/` browse copy. Real DB verified intact
  (`integrity_check ok`, 7296 txns; 9 real accounts, 0 synthetic).
- NOT deleted (isolated test infra, auto-regenerated, never touches real data): `data/e2e.db`,
  `data/e2e-originals` (the e2e suite rebuilds these every run). The app's `seedDatabase` only
  seeds the category taxonomy + institutions (reference data), not fake transactions.
- **Clean 2-folder state:** `data/inbox/` = 52 real statements TO IMPORT (per-institution);
  `data/originals/` = 17 real ALREADY imported (DB-linked archive). The app reads only
  `data/originals` (`MONEYAPP_ORIGINALS_DIR`).

## 🎬 Deferred feature track (original items 3–5 of docs/dashboard-dynamic-and-animations-plan.md)

- [ ] **§3 Focus mode** — click the chart → expand to a focus modal via the View
  Transitions API (shared-element morph), CSS fallback. Reuse the native-`<dialog>`
  focus-trap pattern from `src/components/ui/Sheet.tsx`. Lazy-load.
- [ ] **§5 Activity-hub redesign** — kill the "To review / Upcoming" dead gap; segmented
  or bento composition; everything clickable/expandable. (Overlaps the editability vision.)
- [ ] **§7 App-wide bold-&-playful motion** — page/route transitions (View Transitions),
  card-entrance stagger, hover depth, NumberRoll everywhere, spring micro-interactions,
  categorize checkmark-draw + confetti. All compositor-only + reduced-motion-gated.

## 🐞 Known small issues / polish (from reviews)

- [ ] **ScrubChart From/To picking a <2-point window** un-zooms the chart to the full
  series while the context keeps the 1-day window → chart and panel disagree
  (`ScrubChart.tsx` slice fallback). Only reachable via the date inputs, not the brush.
  Fix: when a controlled window yields <2 points, clamp/widen or reflect the fallback
  back to the context. (LOW; review of item 2.)
- [ ] Period panel **aria-live** on the hero announces on every brush — consider debouncing
  or announcing only the settled value if it proves chatty.
- [ ] Balance-history **% on a near-zero baseline** reads huge (e.g. "+14636.2%" when the
  3-month-ago derived balance was ~$7). Consider suppressing/soft-capping the % when the
  baseline is below a threshold (same honesty spirit as the net-worth partial-% suppression).

## 🚀 DEPLOYMENT & HOSTED-DB — the plan (researched pass 13, 2026-07-15; **IMPLEMENT next pass**)

> **User goal (verbatim intent):** host the DB on a free online database as the SINGLE
> SOURCE OF TRUTH; every uploaded statement gets parsed and stored in the hosted DB
> (originals kept in the same per-account "folder" structure); the dashboard always reads
> the hosted DB; accessible at all times from any device incl. phone (ties into
> `docs/phone-remote-access-plan.md`). Security: the user "doesn't care" — but they SHOULD
> (see §Auth). This section is the researched plan; **do NOT implement it until it's chosen.**

### ⚠️ The one finding that reshapes everything — this is NOT a "near-drop-in"

The app is built **entirely on synchronous `better-sqlite3`** (via `drizzle-orm/better-sqlite3`).
A hosted Turso/libSQL DB is reachable only through `@libsql/client` + `drizzle-orm/libsql`,
whose driver is **Promise-based end to end** — every `.get()/.all()/.run()` and every
`db.transaction(cb)` returns a Promise. Moving to remote Turso therefore forces an
**async rewrite of the entire data layer**, measured on this repo (pass-13 audit):
- **68 non-test files** call `.get()/.all()/.run()` (≈305 / 152 / 98 raw call sites); 32 of
  them are RSC pages / server actions under `src/app`.
- **27 `db.transaction((tx) => {…})` sites in 15 files** use a *synchronous* callback (the
  only kind better-sqlite3 supports) — each must become `async (tx) => { await tx… }`. Some
  loop `tx.get()`/`tx.run()` inside one atomic block (categorize.ts pairing commit,
  bulk-edit undo batches, derivation rebuilds) and need careful await-ing to stay atomic.
- Every plain-sync service helper that returns a db result must become `async`, and every
  caller up the chain awaits it. Mechanical but invasive; **the largest single cost of Path A.**

So `src/db/client.ts` is a small change; the **68-file async ripple is the real work.** Two
honest paths follow — pick one before implementing.

### Path A — Turso + Vercel + Blob (the user's stated architecture) — HIGH effort

**A1. DB → Turso (hosted libSQL, free tier).** Free tier = **5 GB storage · 500M row
reads/mo · 10M row writes/mo** (turso.tech/pricing) — a single-user ledger (~10k txns) uses a
sliver of that. Changes:
- `src/db/client.ts`: replace `new Database(path)` + `drizzle-orm/better-sqlite3` with
  ```ts
  import { createClient } from "@libsql/client";
  import { drizzle } from "drizzle-orm/libsql";
  const client = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });
  export const db = drizzle(client, { schema });
  ```
- Drop the `journal_mode=WAL` / `busy_timeout` / `foreign_keys` pragmas + `fs.mkdirSync` (no
  local file). **Move `migrate()` OUT of the boot/request path** into a deploy-time CI step
  (`drizzle-kit push`, or `drizzle-orm/libsql/migrator` run once) — running it per cold start
  against a remote DB has no lock and races concurrent invocations.
- The `globalThis.__moneyappDb` singleton can stay (harmless) but gives no cross-invocation
  guarantee on serverless.
- **Then: the 68-file async rewrite** (above). This is the bulk of Path A.
- Keep the local-file better-sqlite3 path for **dev/e2e/tests** (they must stay offline +
  synchronous + deterministic under `MONEYAPP_FAKE_TODAY`/`MONEYAPP_FAKE_PRICES`). A remote
  Turso in the e2e harness would be non-deterministic and slow — so this is a driver *switch by
  env*, not a wholesale replacement: local file (better-sqlite3, sync) for dev/test, libsql
  (async) for prod. **The sync/async split is the hard part** — the app code must be async
  everywhere and better-sqlite3 also has a sync API, so the cleanest route is: rewrite to async,
  and back dev/e2e with libsql's *local file* mode (`createClient({ url: "file:data/e2e.db" })`)
  which IS async too — so ONE async code path serves both. (Embedded replicas are also async;
  same conclusion.) Verify determinism/perf of libsql-local in the e2e harness early.

**A2. Original statement files → Vercel Blob (private).** Serverless has **no writable
persistent disk** (only per-instance, wiped `/tmp`). The archive today is local-fs only —
`src/services/import/service.ts`: `statementsRoot()` → `archiveTo(folder, name, buf)` (writes
`data/statements/<slug>/<sha16>-<name>`) → `relocateArchive()` into the per-account folder
resolved by `resolveArchiveFolder()` (1 acct → `accountSlug`, >1 → `<institution>-combined`,
parse-fail → institution bucket) → `importFiles.storagePath` persisted. **Good news from the
audit: `storage_path` is WRITE-ONLY** — no route/page ever reads the bytes back (no download
route exists), so there is no "serve to browser" path to rewire; only the write/relocate path
needs abstracting. Plan:
- New `src/services/storage/archive-storage.ts` — an `ArchiveStorage` interface keyed by the
  SAME backend-agnostic string `<slug>/<sha16>-<name>` (forward-slash joined, NOT `path.join`):
  `put(key, buf)`, `exists(key)`, `move(from, to)`, `remove(key)`, `read(key)` (read unused
  today — keep for a future download route). `resolveArchiveFolder()` + `archiveName` are
  UNCHANGED; only the fs calls move behind the interface. `migrateStorageLayout()` (currently
  sync, test-only) becomes async.
- `LocalDiskArchiveStorage(root=statementsRoot())` wraps today's fs logic 1:1 → dev/e2e/tests
  keep working via `MONEYAPP_ORIGINALS_DIR` unchanged, and `storage_path = path.join(root, key)`
  keeps existing DB rows + tests byte-identical.
- `VercelBlobArchiveStorage` uses `@vercel/blob` (new dep) with a **PRIVATE** store
  (`put(key, buf, { access: "private", addRandomSuffix: false })`) — financial PII must never
  be a guessable public URL. Auth via injected OIDC on Vercel, or `BLOB_READ_WRITE_TOKEN` off-box.
  Uploads through a server action are fine for small PDFs, but the **function body limit is
  4.5 MB** (413 `FUNCTION_PAYLOAD_TOO_LARGE`) — for large statements use Blob **client uploads**
  (browser → Blob directly) to bypass it. If a download/view feature is ever added, read the
  bytes in an **authenticated route handler** next to `get(key, { access: "private" })` with
  `Cache-Control: private, no-store` — never a shared-CDN cache, never middleware-only auth.
- **DB backups** (`src/db/backup.ts` nightly `sqlite.backup()` → `data/backups/`) also assume
  local disk — on Turso, drop the local snapshot and rely on Turso's own backups / a scheduled
  `turso db dump` (or a cron `--from-db` snapshot). Un-gate its Settings UI accordingly.

**A3. App → Vercel (Hobby, free).** RSC + server actions + `force-dynamic` map cleanly to
Vercel Functions (each request = one invocation; Fluid compute). Hobby limits are ample:
300 s max duration, 2 GB / 1 vCPU, single region `iad1`. Personal-but-financial single-user
use fits Hobby's non-commercial terms. **Deploy-blocker to fix first (see A5).** Env:
`TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `BLOB_READ_WRITE_TOKEN` (or OIDC), the auth secret(s).

**A4. AUTH — non-negotiable; recommend a single-user passcode + signed-cookie middleware.**
Options weighed (pass-13 research):
- ❌ **Vercel Password Protection** — a real password wall is **Pro add-on ($150/mo) or
  Enterprise**, not free on Hobby. Vercel *Authentication* (free) ties access to a Vercel login
  and Hobby allows only one external user, and Standard Protection may leave the production
  alias publicly reachable. Awkward + doesn't cleanly lock the prod URL.
- ✅ **Single-user middleware guard (RECOMMENDED)** — `middleware.ts` checks a signed httpOnly
  session cookie; absent → redirect to `/login`, which compares the passcode against an
  argon2/scrypt/bcrypt hash in an env var, then sets `httpOnly; Secure; SameSite=Lax` HMAC-signed
  cookie (or `iron-session`). ~20 lines, $0, no third party, fully yours. (Plain HTTP Basic is the
  minimum variant but has no logout + clunky UX — the passcode-cookie is the sweet spot.)
- ⚖️ **Passkey/magic-link (Auth.js)** — most robust, but overkill for one user (adds a dep +
  session table + WebAuthn/email plumbing). Choose only for account-grade/multi-device auth.
- **WHY it's non-negotiable even though the user "doesn't care":** this app exposes bank
  balances, account/last-4s, full transaction history, and downloadable statements — a complete
  financial-identity dossier. "Nobody knows the URL" is NOT a control: every TLS cert Vercel
  issues is published in public Certificate Transparency logs and scraped within minutes,
  `*.vercel.app` hosts are continuously enumerated, and URLs leak via Referer/history/sync. One
  unauthenticated endpoint returning a statement = irreversible PII disclosure (identity theft,
  ATO, targeted phishing). The fix costs ~20 lines + one env hash; the downside is unbounded.
  **The owner's indifference doesn't lower the third-party risk — ship auth or don't ship.**

**A5. 🚨 Deploy-blocker: `src/middleware.ts` rejects any non-localhost `Host`.** Today it
hard-403s any `Host` header that isn't `localhost`/`127.0.0.1` (a DNS-rebinding defense for a
deliberately loopback-only, unauthenticated app; `dev`/`start` even bind `-H 127.0.0.1`). On
Vercel this **403s 100% of production traffic** regardless of any DB/blob work. It must be
replaced by the A4 auth guard (allow the real prod host + require the session cookie). Keep the
existing security headers (HSTS/nosniff/frame-deny/referrer/permissions) — they're already good.

**A6. One-time MIGRATION (reversible + verified).**
1. Back up first: `data/backups/pre-turso-migration.db` (copy the live file).
2. Create the Turso DB from the local file in one shot (≤2 GB):
   `turso db create moneyapp --from-file ./data/moneyapp.db` (or `--from-dump ./dump.sql` from
   `sqlite3 data/moneyapp.db .dump`). `turso db tokens create moneyapp` → `TURSO_AUTH_TOKEN`.
3. Upload `data/statements/*` to the Blob store under the SAME `<slug>/<sha16>-<name>` keys;
   `UPDATE import_files SET storage_path = <blob-key>` (a one-off script; keys are identical so
   it's a prefix swap, not a re-derivation).
4. **Verify to the cent:** row counts per table, net worth @ today, `PRAGMA integrity_check`,
   statement-period reconciliation, and a spot-read of a few blob keys — Turso vs the local
   backup must match before flipping DNS.
5. **Rollback:** keep the local file + `pre-turso-migration.db`; `turso db create` a
   `--from-db` snapshot before each risky change; the app can point back at the local file by
   env in minutes. Blob objects are additive (never deleted on rollback).

**A7. Cost check + rollback story.** All free: Turso free tier (5 GB / 500M reads / 10M writes),
Vercel Hobby, Vercel Blob free allotment (or Cloudflare R2 — ~10 GB + zero egress — as a
portable, egress-free alternative). Rollback = revert env to the local-file driver + keep the
pre-migration backup; nothing is destructive if the local file is preserved.

### Path B — persistent-disk host (Fly.io / Railway / a small VPS) — LOW-MEDIUM effort, **recommended to consider first**

Because Path A's async rewrite touches 68 files, the honest lower-risk alternative is to deploy
the app **essentially as-is** on a host with a **persistent volume**, keeping the entire
synchronous `better-sqlite3` data layer + the local statement archive + local backups untouched:
- Fly.io / Railway (both have free/cheap tiers) or a $5 VPS, with a mounted volume for
  `data/` (the DB file + `data/statements/` + `data/backups/`). Zero data-layer code change.
- Add the **same A4 auth** + fix the **A5 middleware Host guard** (allow the deployed host).
- Off-box durability: **Litestream** (continuous SQLite replication to S3/R2) or a Turso
  **embedded replica** for backup — without rewriting the app to async.
- Tradeoff: it's a single always-on instance (not serverless autoscale), and you manage the
  volume — but it ships the "hosted, single source of truth, any device incl. phone" goal with a
  fraction of Path A's code risk. iOS/phone access works the same (it's just a URL).

**Recommendation:** the user's premise ("libSQL is a near-drop-in") is not true for this
codebase — Path A is a real project (the 68-file async rewrite), Path B ships the same
user-visible goal far faster. **Present both to the user and let them choose next pass.** If
they specifically want Vercel serverless / the cloud-native shape, do Path A; if they want it
hosted-and-private soonest, do Path B (then Path A can follow later without urgency). Either
way: **AUTH + the middleware Host fix are mandatory before any public exposure**, and the
per-account "folder" structure is preserved in both (local volume in B, Blob keys in A).

**Env vars summary (Path A):** `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `BLOB_READ_WRITE_TOKEN`
(or OIDC), `SESSION_SECRET` + `AUTH_PASSCODE_HASH`. Keep all `MONEYAPP_*` (DB_PATH, ORIGINALS_DIR,
BACKUPS_DIR, SKIP_BACKUP, FAKE_PRICES, FAKE_TODAY, PREVIEW) for the local dev/e2e path.

## 🚀 Standing roadmap (unchanged)

- [x] **Deployment plan** — researched + written above (pass 13). Choose Path A vs B, then build.
- [ ] **Deployment**: execute the chosen path (Turso/libSQL OR persistent-disk host) + **auth**
  + the middleware Host fix before any public deploy of real financial data. Then **iOS**.
