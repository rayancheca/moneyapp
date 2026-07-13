# Dashboard Dynamic Redesign + App-Wide Animation Pass — Build Plan

> Status: **PLANNED — not started.** Authored 2026-07-13 as the handoff for the
> next session(s). The net-worth chart redesign (vivid animated chart) is DONE and
> pushed (commit `ae091bc`). This document is the detailed spec for everything the
> user asked for next. Style direction: **bold & playful**, but disciplined — every
> animation is compositor-only (`transform`/`opacity`/`filter`) and gated on
> `prefers-reduced-motion`.

---

## 0. What the user asked for (verbatim intent)

1. **Kill the "gap" between the "To review" and "Upcoming" dashboard sections** — the
   layout feels disconnected/dead in the middle. Rethink the whole view.
2. **Make everything clickable + expandable**, with cool animations and strong visuals.
3. **Click the graph → it expands** with a cool animation (focus mode).
4. **Select a timeframe on the graph with the mouse → the bottom of the screen changes
   to show the transactions in that period** (or a summary of it).
5. **The page is dynamic** — changing one view changes the others accordingly
   (coordinated / linked views).
6. **Go back to the previous timeframe** — after selecting a window with the mouse,
   be able to step back to the previous selection (selection history / undo).
7. **Bold & playful** everywhere.
8. Plus the standing roadmap: **deployment (Turso/libSQL + auth), then iOS.**

The core UX pattern behind 3–6 is a classic infovis technique: **brushing & linking
across coordinated views** (overview+detail, focus+context). The chart is the
*overview*; the transaction/activity area is the *detail*; brushing the overview
filters the detail; a selection stack gives back/forward.

---

## 1. Architecture: one shared "active window" as the single source of truth

Everything dynamic hangs off ONE piece of state. Do NOT duplicate it into each panel.

### 1.1 `DashboardWindowProvider` (new: `src/components/dashboard/DashboardWindowContext.tsx`)
- Holds `{ start: string; end: string; source: "pill" | "brush" | "input" | "reset" }`.
- Backed by a **history stack** via `useReducer`:
  ```
  state = { stack: Window[], index: number }
  actions: PUSH(window) | BACK | FORWARD | RESET
  current = stack[index]
  ```
  - `PUSH` truncates any forward history (like a browser), appends, sets index to last.
  - `BACK`/`FORWARD` move the index; expose `canGoBack`/`canGoForward`.
- **URL sync**: mirror `current` into search params `?from=YYYY-MM-DD&to=YYYY-MM-DD`
  (Next App Router `useSearchParams` + `router.replace`, shallow). This makes the
  view shareable AND lets the browser Back button pop the window — but keep the
  in-app "← Back" button as the primary, discoverable control (req #6).
  - Decision to make: in-app stack vs browser history. Recommended: **in-app stack is
    the source of truth**; push a URL entry on each brush so browser-back also works,
    but the visible "← Back" button drives `BACK` on the reducer. Reconcile on
    `popstate`. (Keep it simple first: in-app stack only, URL mirror read-only.)

### 1.2 Wiring
- `ScrubChart` already computes `customWindow` locally. **Lift it**: when `vivid`+
  `selectable`, the chart's `applyWindow`/`selectRange` should call an optional
  `onWindowChange(window, source)` prop instead of (or in addition to) local state.
  `NetWorthChartPanel` passes a handler that dispatches `PUSH` to the context.
- Every other panel (transactions, spending, budgets pace, account rows) reads
  `current` from the context and filters its data to `[start, end]`.
- **Derive, don't refetch where possible**: the dashboard already loads rich data
  server-side. For instant cross-filter, either (a) pass full ranges to the client and
  filter in memory, or (b) use a server action / route handler keyed on the window
  and stream results. Prefer (a) for the transaction *summary* (fast) and (b) or
  windowed queries for the full filtered list if the dataset is large.

---

## 2. Feature: brush the graph → the bottom cross-filters (reqs #4, #5)

**Interaction:** the chart already supports drag-to-select (it currently zooms the
chart). Extend it so a brush ALSO updates a linked "Activity in this period" panel
below.

- On brush commit (`applyWindow`), dispatch `PUSH({start,end,source:"brush"})`.
- A new **`PeriodActivityPanel`** (below the chart) subscribes to `current` and animates
  its content swap:
  - **Summary strip** (animated count-up via `NumberRoll`): net change, total in,
    total out, # transactions, top 3 merchants/categories for the window.
  - **Filtered transaction list**: the ledger filtered to `[start,end]`, with a
    cross-fade + list-reflow animation (FLIP or staggered enter). Reuse the existing
    `TransactionsLedger`/row components; add a `window` filter prop.
  - **Empty/edge states**: window with no transactions → a friendly animated empty state.
- **Two-way linking (bonus):** hovering a transaction row highlights its day on the
  chart (a marker), and scrubbing the chart highlights the nearest row. Optional, high-delight.

**Animation:** when the window changes, the summary numbers roll, and the list does a
FLIP transition (measure → reflow → animate transforms). Keep it snappy (~250–350ms,
`--ease-out-expo`). Reduced-motion → instant swap.

---

## 3. Feature: click the graph → expand to focus mode (req #3)

**Affordance (important):** click-to-expand must NOT conflict with the existing
press-drag-scrub / brush. Options, pick one:
- **A dedicated "Expand" button** (⤢ icon) in the chart's top-right corner (clearest;
  recommended for v1).
- **Double-click** the plot to expand (discoverable-ish, no extra chrome).
- A long-press on touch.

**Transition (the "cool animation"):** use the **View Transitions API**
(`document.startViewTransition`, supported in Next 16 / modern Chromium; feature-detect
and fall back to a CSS scale/opacity for others). Give the chart container a
`view-transition-name` so it morphs/scales from its inline slot into a large modal /
full-bleed overlay. This is the bold shared-element "zoom" the user wants.

**Focus mode contents:** a taller chart, richer axes, optional area/candle or
cumulative/periodic toggle, period-compare (overlay last year), annotations for big
moves, and the same brushing that drives the linked panel. Esc / backdrop click
collapses with the reverse transition. Lazy-load this component (`next/dynamic`) so it
doesn't weigh down first paint.

---

## 4. Feature: "← Back" to the previous timeframe (req #6)

- The chart control row shows a **"← Back"** chip whenever `canGoBack` (history depth > 1),
  and a subtle **"→"** when `canGoForward`.
- Clicking dispatches `BACK`/`FORWARD`; the chart + linked panel animate to the restored
  window (same FLIP/roll transitions as a fresh brush, so going back feels identical).
- The existing "Reset" chip becomes `RESET` (clear stack back to the default range).
- Keyboard: `[` = back, `]` = forward (document, don't require).

---

## 5. Redesign: kill the "To review / Upcoming" gap (req #1)

The user finds the current stacked sections disconnected with dead space between them.
Rework into a **cohesive activity hub** — a single, dense, intentional composition
rather than two islands. Directions (pick one; lean bento for "bold"):

- **Segmented activity card:** one bordered surface with a header and an animated
  **segmented control** — `Needs review (N)` · `Upcoming (N)` · `Recent`. Switching
  segments slides/cross-fades the content beneath (shared container, no vertical gap).
  A sliding "pill" indicator under the active segment (FLIP between segment rects).
- **Bento grid:** a 2–3 column bento where "Needs review", "Upcoming bills", "Recent
  activity", and a mini "Spending this period" tile interlock with varied sizes — no
  uniform stack, no dead middle. Each tile is clickable/expandable.
- **Unified stream + filter chips:** one chronological stream with chips that filter
  (Review / Upcoming / All), chips animate the list.

Whatever is chosen: **no empty vertical gutter**; use scale/weight hierarchy, overlap,
and a clear rhythm (per the design-quality rules). Everything in it is clickable and
expands (accordion or drill-in with a shared-element transition).

---

## 6. "Everything clickable + expandable" (req #2)

- **Account rows** → expand (accordion) to reveal a mini balance sparkline + last few
  transactions. Animate height via `grid-template-rows: 0fr → 1fr` (the compositor-safe
  height trick) or FLIP; never animate raw `height`.
- **Stat tiles** (assets, liabilities, spending) → click to flip/expand to a trend.
- **Category chips** → drill to the category page with a shared-element transition
  (the chip morphs into the detail header via `view-transition-name`).
- **Every row/tile** gets a designed hover (lift + shadow), focus ring, and active
  (spring press). Consistency matters more than novelty.

---

## 7. App-wide bold & playful animation pass (req #7)

### 7.1 Tokens (extend `globals.css`)
- Add spring/stagger easings: `--ease-spring-lg: cubic-bezier(0.34, 1.56, 0.64, 1)`,
  a `--ease-in-out-quart`, plus `--duration-slow` (already added).
- Stagger helper: a small util or data-attr driven `animation-delay` ramp.
- Keyframes: `pop-in`, `slide-fade`, `flip-in`, `checkmark-draw` (categorize success),
  a subtle `float`/`sheen` for hero surfaces. **Every keyframe's resting frame must be
  the valid final visible state** (so the reduced-motion `animation-duration: 0.01ms`
  collapse is safe — this bit us once already with `pulse-ring`).

### 7.2 Motion inventory
- **Page/route transitions:** View Transitions API across App Router navigations
  (cross-fade + directional slide). Feature-detect; reduced-motion → none.
- **Card entrance stagger** on mount / on-scroll (IntersectionObserver; transform+opacity).
- **Hover depth** on cards/rows/buttons; **springy press** (`active:scale-95`) everywhere
  interactive (note: gate any shared helper so it doesn't leak into byte-identical
  surfaces — see the pill-scale invariant lesson in `ScrubChart.pill`).
- **NumberRoll everywhere**: hero net worth (add a mount count-up variant), stat tiles,
  account balances, budget numbers.
- **Micro-interactions:** category-pill pop on select; a `checkmark-draw` + tiny confetti
  on "categorized" in the Categorize walk; toggle/checkbox springs; toast slide-in.
- **Chart:** already done (glow line, reveal, tooltip, pulse dot). Optionally add a
  gradient sheen sweep on first reveal.

### 7.3 Guardrails (do not skip)
- Compositor-only properties. For layout changes (accordions, list reflow, expand),
  use **FLIP** or **View Transitions**, never animate `height/width/top/left/margin`.
- **`prefers-reduced-motion`**: the global CSS guard only zeroes `animation-duration`
  — it does NOT stop `infinite` iterations or fix invisible terminal frames. For any
  looping/entrance animation, ALSO gate in the component (pass `reduced`), as done for
  `LiveDot`. Add `animation-iteration-count: 1 !important` to the guard as a backstop.
- Lazy-load heavy pieces (focus-mode modal). Keep the dashboard's JS budget in check
  (app-page budget ~300kb gz per the perf rules).
- **Do not regress the byte-identical invariant** for shared components: any new shared
  helper that adds motion must be opt-in (a prop), so sibling surfaces are unchanged.

---

## 8. Testing / gates for the above

- **Unit:** the window-history reducer (PUSH truncates forward, BACK/FORWARD bounds,
  RESET), any new pure filter/summary helpers → keep `src/lib` at 100% coverage.
- **e2e (Playwright):** brush the chart → linked panel shows the period's transactions;
  "← Back" restores the previous window; expand → focus mode opens and Esc collapses;
  segmented activity hub switches; reduced-motion snaps. Add visual baselines for the
  new states in both themes at 320/768/1024/1440.
- **a11y:** axe on every new surface; keyboard paths for brush-back, expand/collapse,
  segments; focus management for the focus-mode modal (trap + restore).
- Run the standing gate: typecheck · unit (100% lib) · build · e2e (both themes, axe).
- Consider an adversarial multi-lens review before commit (it caught 11 real issues on
  the chart — including two honesty bugs and a reduced-motion leak).

---

## 9. Suggested sequencing (each a clean commit)

1. **Window context + history reducer** (unit-tested) and lift `customWindow` out of
   `ScrubChart` via `onWindowChange`. No visual change yet.
2. **PeriodActivityPanel** + brush→cross-filter + "← Back"/Reset (req #4,#5,#6).
3. **Focus-mode expand** with View Transitions (req #3).
4. **Activity-hub redesign** killing the gap (req #1) + clickable/expandable rows (req #2).
5. **App-wide animation pass** (req #7) — tokens, page transitions, stagger, micro-interactions.
6. **Deployment prep** (separate track): Turso/libSQL migration + auth, then iOS.

---

## 10. The rest of the project (standing roadmap)

- **Turso/libSQL + AUTH** before any public deploy (the app currently has no auth and
  runs on local SQLite via Drizzle). See `[[moneyapp-handoff-2026-07-10]]`.
- **iOS** after the web app is deployable.
- Optional: a §8-style motion/NumberRoll polish sweep folds into §7 above.

---

### Reference: how the chart already implements the primitives you'll reuse
- Drag-select / brush + custom window: `ScrubChart.tsx` (`selection`, `applyWindow`,
  `customWindow`, `onPointerDown/Move/Up`).
- Coverage-honest series + axis math: `src/lib/scrub-series.ts`, `src/lib/chart-axis.ts`.
- Reduced-motion gating pattern: `src/hooks/usePrefersReducedMotion.ts` + `LiveDot`.
- NumberRoll odometer: `src/components/ui/NumberRoll.tsx`.
- Motion tokens/keyframes: `src/app/globals.css` (`--animate-*`, `@keyframes`).
