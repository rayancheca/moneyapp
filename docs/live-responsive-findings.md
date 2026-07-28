# Live responsive findings — measured, not inferred

Measured against the running dev server (port 3111) on the seeded demo DB
(1,673 txns · 10 accounts · net worth $110,617.82) on 2026-07-27.

Target devices (owner's actual hardware): **iPhone 17 Pro Max** (~440 × 956 CSS px
portrait) and a **Mac M5** driving a large display.

Method: for each route + viewport, walk every element, compute its bounding rect,
and keep only elements whose right edge exceeds the viewport **and** which have no
ancestor with `overflow-x: auto|scroll|hidden`. That filter excludes deliberately
scrollable strips (the mobile nav is one) and leaves only genuine page overflow.

> **Methodology correction.** A first pass resized the viewport *without reloading*
> and reported ~576px of overflow with `recharts-wrapper` at 910px. That was wrong —
> recharts sizes via `ResizeObserver` and held stale dimensions from the desktop
> render. **Every number below is from a clean load at the stated width.** Recharts
> is correctly responsive: on a fresh 375px load the wrapper renders **293px**.
> All measurements were re-taken after this was found.

---

## R1 — MEDIUM: a CSS Grid track refuses to shrink, so the page scrolls sideways

| Viewport | Document width | Overflow | % offscreen |
|---|---|---|---|
| 440px (**iPhone 17 Pro Max**) | 470px | **+30px** | 6% |
| 375px (iPhone SE / Mini) | 470px | **+95px** | 20% |

The page has a hard **470px floor** regardless of viewport. Root cause chain,
measured on the dashboard:

```
DIV.grid.gap-4.lg:grid-cols-[1.5fr_1fr]   width: 343px
    └─ computed grid-template-columns:     454.227px   ← track wider than container
        └─ DIV.space-y-4                   min-width: auto   ← the culprit
            └─ SECTION.space-y-3           width: 454px
                └─ A.flex…                 width: 454px
```

Grid and flex items default to `min-width: auto`, which means a track will not
shrink below its content's min-content width. The single-column mobile grid
therefore inherits a 454px minimum from the account-row content inside it.

**Fix:** `min-w-0` on the grid child. This is the same class of bug noted in the
pass-23 handoff (`truncate` in a flex item needs `min-w-0`) — worth grepping for
every `grid-cols`/`flex` container in the app, not just this one.

Other routes on clean loads at 375px: `/spending` +100px, `/investments` +283px,
`/transactions` +32px — all the same family of content-floor overflow, none of
them caused by charts.

**What is already right:** the sidebar collapses to a horizontally scrollable nav
strip that is correctly clipped by an `overflow-x` ancestor, so it contributes no
page overflow. Charts reflow properly. Mobile work here is close — it is leaking
at the seams, not missing.

## R2 — HIGH: 60% of a large display is dead space

`main` has a hard `max-width: 1024px` (computed style, viewport-independent).

| Viewport | `main` width | Unused width to the right |
|---|---|---|
| 2545px (measured) | 1024px | **653px** |

On the Mac's display the app is a 1024px column with a void beside it. Nothing
claims the space — no second column, no persistent detail pane, no wider chart. A
data-dense finance app has obvious uses for it: chart + ledger side by side, or
master/detail without navigating away and losing context.

## R3 — MEDIUM: 39 interactive elements below the 44px touch floor

On a clean 375px dashboard load, **39** interactive elements are under 44px tall.
The primary navigation links are **29px**. Apple's HIG specifies 44pt; Material
specifies 48dp. This applies equally at 440px — it is a sizing decision, not a
viewport artifact.

Also **37 text nodes below 12px**, including chart axis labels at 11px and the
`99+` review badge at 10px.

---

## Verified strengths (do not regress these)

- **Net worth reconciles to the cent across surfaces.** Summing the five
  institution totals independently: `10,493.73 + 50,701.47 − 86.89 + 21,280.98 +
  28,228.53 = $110,617.82`, matching the hero exactly. `/investments` reports
  $21,280.98 / −$242.09 / −1.12%, matching the dashboard card exactly.
- **All 51 internal links resolve 200.** No dead routes.
- **Animated numerals are correctly `aria-hidden`** with `sr-only` text
  alternates, so the odometer does not corrupt the accessibility tree.

## Scope limits

These are viewport-geometry facts. They say nothing about touch *interaction* —
hover-only affordances with no tap equivalent are a separate audit, owned by the
cross-cutting agents.
