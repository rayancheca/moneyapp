# Handoff — 2026-07-30, pass 27

> Supersedes `docs/HANDOFF-2026-07-29-pass26.md`. That pass shipped `/flow` (the spine, the
> rhythm rail, the matrix) and closed the detector gap. **This pass built the Tower**, which was
> the last undelivered piece of the transfer-flow brief and the last of the owner's three open
> questions that did not need him at the keyboard.

## 1. Repo state, exactly

| | |
|---|---|
| `main` | tip of `origin/main`, clean and pushed. Two commits this pass, both code+tests. The tip is a `test:` commit; the last **feature** commit is `313b195`. Verify with `git rev-parse main` — a handoff cannot name its own hash without lying. |
| worktree | `.claude/worktrees/app-polish-adversarial-review-e80abb` still exists, still at the *old* commit `4d45273`. It is stale but harmless. Remove it or `git -C … reset --hard main` before using it. |
| uncommitted | **none** |
| running | nothing. No dev/preview server, nothing on 3000 or 31xx, no handle on the real database, no test runner alive. |

**Gate at handoff, on a fresh build:** `tsc` clean · **134 files / 2,244 unit tests** ·
`next build` clean (17 routes) · **284/284 e2e** · `src/lib/transfer-tower-layout.ts` at **100%
statements / branches / functions / lines**.

⚠️ `pnpm test` runs with coverage and is **RED before you touch anything** — pre-existing, from
`in-flight.ts` (94.7%) and `xirr.ts` (89.1%). Gate on `pnpm test:fast` plus a targeted per-file
coverage read; do not read a red `pnpm test` as proof you broke something.

### Worktree setup — both symlinks are required, both are gitignored

```bash
ln -sfn /Users/rayankarimcheca/Desktop/Dev/MoneyApp/node_modules node_modules
ln -sfn /Users/rayankarimcheca/Desktop/Dev/MoneyApp/.env .env
```

The missing `.env` — not an expired key — was the long-standing cause of the dead
"Claude categorize" button.

---

## 2. What shipped

### 2.1 The Tower — `/flow?shape=tower`

```
src/lib/transfer-tower-layout.ts        pure geometry + orthographic projection (100% covered)
src/lib/transfer-tower-layout.test.ts   80 cases
src/components/charts/TransferTower.tsx the SVG renderer + the account rail
src/components/charts/TransferTower.test.ts   source + wiring contract
e2e/zz-zz-flow-views.spec.ts            enumerates FLOW_VIEW_SPEC — every option must render
```

Account pillars on a deterministic ring, **Y axis = time**, one arc per (edge, month) bucket that
carried money. **167 arcs on the real database where the spine draws 17.** A route used constantly
reads as a rope running the tower's whole height; a route used once for a large sum reads as a lone
strut at one altitude. That contrast is the reason the view exists and it is the one thing the
spine cannot show, because the spine has no time axis.

`shape` is a real view dimension (`spine|tower`), **inserted before `lens`** and referenced **BY
NAME** everywhere — `TransferFlowPanel` used to read `FLOW_VIEW_SPEC[0]`, which would have silently
repointed at the new dimension and pinned the surface to "gross" with no error anywhere.

Full record of all eight deviations from the original spec, each with its reason:
`docs/transfer-flow-view.md` **§0**. The short version:

- **SVG + orthographic**, not canvas/WebGL, not perspective.
- **Four named viewpoints** (quarter/front/side/plan), not free orbit. Viewpoint is **local state**,
  not URL and not persisted, so a shared link always opens at the same camera.
- **Arcs are pointer-only.** 167 arcs would be 167 tab stops. The **rail** beside the plate is the
  keyboard/AT path; the table lens carries every number.

### 2.2 Visual baselines for `/flow`

16 new PNGs — spine and tower × 2 themes × 4 widths. `/flow` had **no** visual coverage at all
before this; the spine shipped a pass ago without any. Generated, then verified over **three
consecutive runs with no `--update-snapshots`: 131 passed each time, not one baseline rewritten.**

---

## 3. ⚠️ Do not re-litigate these

They are settled decisions with reasons, not defaults that nobody thought about.

| Decision | Why |
|---|---|
| **SVG, not canvas** | The pass-26 handoff §5.1 had already reversed the old spec, and `NetWorthTerrain` is the in-repo precedent ("SVG with real projection maths, not WebGL"). SVG is axe-inspectable, resolves `var(--cat-*)` natively (a canvas would need a `getComputedStyle` resolver and a repaint-on-theme-change that **nothing in this repo does today**), and the browser hit-tests it for free — paint order is back-to-front, so the topmost element under the cursor IS the nearest arc. |
| **Orthographic, not perspective** | A stroke width encodes dollars, so it must mean the same thing at the front of the ring as at the back. Perspective would inflate whatever the azimuth happened to favour. |
| **Named viewpoints, no free tumble** | The terrain's doctrine verbatim. Keyboard-reachable without a drag gesture nobody can perform from a keyboard, and the geometry stays snapshot-stable. |
| **`role="img"` on the tower's SVG, and NOT on the spine's** | The role PRUNES nested interactive content. Fatal on the spine, where each of 13 arcs is a focusable button; exactly right here, where there is deliberately nothing inside to prune. |
| **No rhythm rail under the tower** | Its Y axis IS time. A monthly rail below would be a second, worse answer to a question already on screen. |

---

## 4. 🔴 Traps this pass paid for

- **Next 16: `dynamic(…, {ssr:false})` inside a Server Component is a HARD BUILD ERROR.** The
  string is compiled into `@next/swc-darwin-arm64`. All 18 page/layout files are Server Components,
  so it must live in a `"use client"` module. **TypeScript does not catch it** — `ssr` is a plain
  `boolean?`. Moot now that the Tower is SVG, but it will bite whoever next reaches for canvas.
- **vitest is `environment: "node"` and `include` is `src/**/*.test.ts` ONLY.** No jsdom, no
  `canvas`, no @testing-library. **A `.test.tsx` is collected as ZERO tests and appears to pass.**
  Component tests are source-text assertions via `fs.readFileSync` — precedent
  `src/components/charts/NetWorthTerrain.test.ts`.
- **`src/lib/**` demands 100% coverage, so design for it.** Prefer `Math.max(x, EPS)` over a
  ternary, `.entries()` over indexed access, and **carry a value WITH its object instead of looking
  it up in a parallel array** — `arr[i] ?? 0` is an unreachable branch that costs the gate. (I had
  to restructure exactly that once.)
- **The Browser pane reports every `getBoundingClientRect()` as 0 while it is hidden.** I chased a
  phantom "the ResizeObserver never fires" bug for several minutes. **Drive a Playwright script
  instead** — and note `playwright` is not hoisted under pnpm: import from `@playwright/test`. A
  script under the scratchpad cannot resolve it; put it in the repo root and delete it after.
- **Orthographic needs more elevation than perspective.** The prototype's 16° read fine under
  perspective; orthographic squashes the ring to 28% of its width and the pillars become a flat
  picket fence. 27° now. **No assertion can see this — only a screenshot.**
- `--reporter=line` is a Playwright reporter, not a vitest one. vitest wants `--reporter=dot`.
- **Never `git add -A`** — `node_modules` and `.env` are symlinks. Add explicit paths.

---

## 5. ⚠️ What adversarial review caught that tests AND screenshots both missed

Four review lenses → 7 findings confirmed after independent refutation. **Two were real bugs I had
already screenshotted past**, which is the part worth internalising:

1. **HIGH — `nearness` normalised a ROUNDED value against UNROUNDED bounds.** On a one-arc tower
   the true depth range is 0, the divisor falls back to `EPS = 1e-9`, and the numerator is a
   rounding residual → nearness ≈ ±10⁴ → the renderer computed `opacity ≈ −3484`, SVG clamped it to
   0, and **the tower's only arc rendered invisible** while the caption still read "1 arcs".
   *Never normalise against a different quantity than the one you publish.*
2. **The label de-collision was undone by a clamp applied after it.** The clamp pulled an outer
   label inward — straight into a neighbour the lift loop had just cleared it against. Reproduced
   at 432–471px with seven accounts: **the owner's own iPhone 17 Pro Max.**

It also found **two of my own tests asserting nothing**: an `if (overlapping) expect(…)` whose body
never ran on the single plate it sampled, and an `if (prev.depth === cur.depth)` that never fired on
the sampled camera. **Any `expect` living inside an `if` needs a guards-the-guard counter.** Both
now have one, and the de-collision test sweeps 11 widths × 4 heights × 4 viewpoints.

### The geometry bug worth remembering

**A→B and B→A landed on exactly the same control point.** Reversing an edge flips the perpendicular
*and* flips the bow sign, and the two cancel — so the two directions drew one on top of the other,
hiding the round-trip churn this whole surface exists to reveal. Take the perpendicular along the
pair's **canonical** direction (low ring index → high) and the sign from the edge's own direction.
Its own invariant test caught it on the first run, before a single pixel was drawn.

---

## 6. Open work — in the owner's stated order

### 6.1 Item 13b — split pay from non-pay ATM deposits  ← **do this next**

A guarded real-DB clarification pass in the style of pass 24. Projected cash income is currently an
**upper bound**: $1,046/wk projected against roughly $651/wk actual over the last 55 days, because
the owner confirmed the deposits are *"mixed — some are pay, some aren't"*. **This needs him at the
keyboard, deposit by deposit.** Follow pass 24's playbook exactly: backup, dry-run, Δ-guards on
LIVE deltas, `source='user'`, confirm before `--apply`.

⚠️ **The dev server holds the real database open.** `lsof data/moneyapp.db*` and stop it before any
`--apply`; the owner restarts `pnpm dev` afterwards.

### 6.2 The §5.2 small fixes

> ⚠️ **CORRECTED 2026-07-31 (pass 28). Four of the five bullets below were wrong, and they were
> wrong because this list was copied forward from pass 26 without re-measuring — the exact failure
> §8 warns about, committed by §8's own author. All of it is now done; see
> `docs/HANDOFF-2026-07-31-pass28.md`. Read the corrections before trusting anything in this list:**
>
> - **`?error=`** — already fixed on `/investments`, `/recurring` and `/settings` since pass 25
>   (`5d200c3`); all three read it and render a `role="alert"` banner in every return branch. The
>   defect was real but on **two pages this list never named**: `/accounts/[id]` (the
>   "Record a balance" path) and `/transactions`. Both fixed, both now guarded by
>   `e2e/error-banner.spec.ts`.
> - **`HeaderStrip` `failed` state** — already rendered, at `HeaderStrip.tsx:163-167`, and had been
>   through three handoffs described as missing. What was actually absent was a TEST; it has one now.
> - **`--press-2`/`--press-3`/`--annotation`** — "few consumers" is **false**. `--press-2` reaches
>   54 of 55 `SurfaceCard` renders across 23 files plus `DataTable`, `Button` and `StatCard`; it is
>   the workhorse of the depth scale. `--press-3`'s single consumer (Toast) is mandated by
>   `letterpress.ts:27` — a design invariant, not a gap. The counting method was the bug: these are
>   consumed as Tailwind arbitrary values (`shadow-(--press-2)`), which a `var(--press-2)` grep
>   misses entirely. The only real item left is that `TransferSpine`/`TransferTower` use
>   `text-ink-muted` where `--annotation` was meant for chart marginalia.
> - **Overflow** — real, and now fixed and guarded. But the cited line was stale
>   (`page.tsx:154` → the culprit is `NumberRoll.tsx:52`), and the list **missed
>   `/categories/[id]`**, which overflowed by 38px.
> - **Coverage** — the two files named were accurate but the list was **incomplete**: five files
>   were short, not two. `deviation-layout.ts` and `transfer-flow-layout.ts` never appeared because
>   the coverage text reporter only lists files with uncovered LINES, and theirs were branch-only.
>   The gate is green now.

- **`?error=` unrendered** on `/investments`, `/recurring`, `/settings` — server actions redirect
  with a human message these pages drop on the floor. Copy `src/app/budgets/page.tsx:43,70-75`
  (a `role="alert"` banner).
- **`HeaderStrip.tsx`** does not render the `failed` Claude-run state that exists in its model.
- **Residual overflow**, pre-existing and untouched: **11px at 320px** on `/` (the hero odometer's
  per-digit `w-[1ch]` spans measure 315px in a 288px box, `src/app/page.tsx:154`) and **~87px at
  320px** on `/transactions`. Everything else is 0 at 440px, and `/flow` is 0 at every width.
- **Coverage gate RED** on `in-flight.ts` (94.7%) and `xirr.ts` (89.1%).
- `--press-2`/`--press-3` still have few consumers; `--annotation` adoption is thin (8 elements).

### 6.3 Phase 2+ of the audit backlog

`docs/review/08-backlog.md` — 84 items across 6 phases. Phase 1's 23 are done.

### 6.4 Hosting — ⛔ NOT YET, by the owner's explicit instruction

> *"hosting is only at the end when im sure the final product is complete"*

Do not start this, and do not propose it as the next step. When he does call for it, the
recommendation is unchanged and the analysis is already written up in
`docs/hosting-and-auth-plan.md`: keep SQLite, run it on the Mac, reach it over **Tailscale** —
$0/month, ~5–7 hours, **zero database rewrite**. The measured alternative is 211 non-async service
functions, 448 sync call sites and 30+ `db.transaction()` callbacks wrapping the money-mutating
paths, where a missed `await` **silently commits partial state**.

---

## 7. How to work on this repo

### The gate sequence

```bash
node_modules/.bin/tsc --noEmit
node_modules/.bin/vitest run --reporter=dot
node_modules/.bin/next build
node_modules/.bin/playwright test --reporter=line
```

`pnpm e2e` serves a **stale `.next`** — always `pnpm e2e:fresh`, now guarded by
`assertBundleIsFresh()` in `e2e/global-setup.ts`. Note it only stats `./src`, so a change to
`next.config.ts` or a package bump will NOT mark the bundle stale.

### 🔴 SCREENSHOT EVERY NEW CHART — and every VIEW of it

`/flow`'s spine passed `tsc`, 2,113 unit tests and 258 e2e and was still visibly broken. The Tower
would have shipped with three defects that no assertion could reach. **And measuring is not
looking**: an audit reporting 0 escaped ink, 0 label collisions and 0 console errors across all four
viewpoints still told me nothing about whether the figure *reads*. Open the image.

### Visual baselines

Never bulk-regenerate. Inspect the diff, prove every changed pixel maps to an intended change, then
`--update-snapshots`. **143 baselines** now. When adding a route whose chart measures itself, give
it a per-route `settle` in `visual.spec.ts` rather than changing `openHydrated` — that helper waits
on the theme toggle's accessible NAME, which is in the SSR markup and proves nothing about
hydration; the **SVG inside it** is the sound signal.

---

## 8. ⚠️ Trust discipline

Pass 25's fact-check found **0 of 8 headline claims survived their original wording**, and pass 26
inherited a figure that was wrong by $315. **Re-measure every quantity and name the database.**
Mechanisms in these docs are almost always real; the numbers attached to them frequently are not.

**Two databases — do not mix them:**
- DEMO / e2e (synthetic): `data/e2e.db`, seeded fresh by `e2e/global-setup.ts` — 5 accounts,
  96 tower arcs, $44,682.58 gross, $0.00 round-tripped.
- REAL (his finances): `~/Desktop/Dev/MoneyApp/data/moneyapp.db` — 7 accounts, **167 tower arcs**
  gross / 125 net, 34 months, $368,107.54 gross, $104,612.26 round-tripped (28.4%).

To read the real one, prefer raw `better-sqlite3`. **Never `createDatabase()` against it** — that
runs migrations and writes, and with no argument it defaults to the real path. To *test* against
real data, copy the file first (plus `-wal`/`-shm`) and open the copy.

### Verified TRUE this pass — protect these

- The tower's arc count exceeds the spine's edge count on both databases, asserted in e2e.
- Markup is byte-identical across a resize cycle, asserted in e2e.
- Zero horizontal overflow on `/flow` at 320, 375, 440, 768, 1440 and 2560.
- axe clean (critical + serious) in the tower view, at both lenses.
- Pillars, rings and the label layout are **identical** between gross and net — only the arcs move.
