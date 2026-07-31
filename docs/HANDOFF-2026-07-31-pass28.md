# Handoff — 2026-07-31, pass 28

> Supersedes `docs/HANDOFF-2026-07-30-pass27.md`, which built the Tower. This pass closed
> **item 13b** on the real database, cleared the whole **§5.2** small-fixes list — after
> discovering most of that list was wrong — and then reworked the **investments chart** on four
> direct asks from the owner.

## 1. Repo state

| | |
|---|---|
| `main` | two commits this pass on top of `f6fd644`: `5e986e8` (§5.2) then `88099af` (investments). Pushed, tree clean. Verify with `git rev-parse main` — a handoff cannot name its own hash without lying. |
| worktree | `.claude/worktrees/app-polish-adversarial-review-e80abb` still stale at `4d45273`. Remove it or reset it before use. |
| real DB | **written this pass** (item 13b). Backup: `data/backups/moneyapp.db.pre-13b.2026-07-31T15-18-42-698Z`. |

**Gate, measured on a fresh build:**

| | pass 27 | now |
|---|---|---|
| `tsc --noEmit` | clean | clean |
| unit | 2,244 · **coverage RED** | **135 files / 2,294** · **coverage GREEN, exit 0** |
| `next build` | clean | clean, 17 routes |
| e2e | 284/284 | **345/345** under `E2E_GATE=1` |
| visual baselines | 143 | 143 (**54 regenerated**: 14 in `5e986e8`, 40 in `88099af`) |

`pnpm test` **passes for the first time**. Earlier handoffs said to gate on `test:fast` and ignore a
red coverage run; that advice is obsolete — a red `pnpm test` now means you broke something.

> ⚠️ `88099af`'s commit message says "2300 unit". The measured figure is **2,294**. The message was
> written from an estimate rather than a reading — exactly the habit §8 warns about, so it is
> corrected here rather than quietly left.

---

## 2. Item 13b — done, and it inverted its own premise

Full record: `docs/review/12-item13-resolved.md` §13b.

Of the eight ATM cash deposits the "Cash job (weekly pay)" series had swept up, **only two are
pay** — the Florida pair, $1,447. The other six left income: **$1,500 → Loans** (Phil repaying the
$5,000 Zelled to him on 2025-06-25, a loan the app already tracked), **$1,000 → Family
pass-through** (his girlfriend's cash to forward; the send failed), **$1,180 → Internal Transfer**
(his own cash, plus one $730 he does not recognise).

Income **$122,593.85 → $118,913.85**. Salary **$49,194.86 → $45,514.86**. Balances unchanged.

**The premise that the projection was contaminated was WRONG.** Asked what the job actually pays:

> *"its 1046 a week for the past month or two i just havent been depositing it in the bank often
> ... i do get paid i just put it in the bank at random intervals and quantities."*

$1,046/wk is real earnings; the deposits were never a measurement of it. It is now pinned as
`user_amount_cents` / `user_cadence` on the series, which `effectiveSeries()` (`recurring.ts:681`)
reads ahead of the detected value — previously it survived only by accident, since it is not the
average of the series' members ($640.88).

**Carry forward:**
- Recorded `Salary` now deliberately **under-counts** what he earns. Earnings ≠ deposits; do not
  try to make them reconcile.
- ⚠️ **Unverified:** whether the series' fixed weekly occurrence and `projectOngoingIncome`'s
  trailing `Salary` average both count the same deposited cash. Two projection paths, one quantity.
  **Cheapest real win left, and it touches the number he cares most about.**
- The **$3,500 Phil Zelled him is not missing, just not imported** — Chase Checking coverage ends
  2026-07-10; that landed ~07-17→07-24.
- A separate **−$1,495 Zelle to Philipe, 2026-05-29**, already filed `Loans` — possibly a second
  loan. Not touched.

### The guarded-write pattern, refined

`clarify-atm-pay-split.cjs` (session scratchpad). Beyond pass 24's backup + dry-run + Δ-guards +
`source='user'`:

- **Preflight identity assertions** — every target row must match its expected date, amount,
  category and series link or the run aborts, so the script cannot be replayed against a database
  it does not recognise.
- **Verify against the BACKUP, not the script's own report** — diff live-vs-backup row by row and
  assert exactly N rows differ in exactly the intended columns. It caught nothing, which is the
  point: it makes "balances unchanged" a measurement rather than a claim.

⚠️ `series_link_source='user'` is load-bearing — it is why detection skips these rows
(`recurring.ts:377`). Dropping the series below `MIN_OCCURRENCES = 3` also makes
`recomputeSeriesStats` keep its last good stats, so the series is *more* protected, not less. But
that same function fires on **every UI link/unlink**, which is the one action that could still
re-derive those stats.

---

## 3. §5.2 — all done, and most of it was mis-described

The highest-value thing in this pass: **re-measuring the handoff's own open-work list.** Four of
five bullets were wrong, inherited from pass 26 unmeasured. Corrections are inline in
`docs/HANDOFF-2026-07-30-pass27.md` §6.2.

### 3.1 `?error=` — real, but on two pages nobody had named

`/investments`, `/recurring`, `/settings` had been fixed since pass 25. The pages actually dropping
it were **`/accounts/[id]`** (target of `addAnchorAction`, i.e. the "Record a balance" form) and
**`/transactions`** (all four redirect actions via `returnPath`). Six pages had each hand-rolled
byte-identical banner markup, which is *why* two got missed; now one shared
`src/components/ui/ErrorBanner.tsx` serves all eight.

`e2e/error-banner.spec.ts` guards it, with a **drift test** that scans `src/app/*/actions.ts` for
`?error=` redirects and fails if one lands on an uncovered page.

### 3.2 Horizontal overflow — fixed and now un-reintroducible

`e2e/overflow.spec.ts`: `scrollWidth <= clientWidth` on 16 routes × {320, 375, 440}, naming the
offending elements on failure. 49 tests.

**Why 143 green baselines never caught it:** `toHaveScreenshot({fullPage:true})` captures the
*scrollport*. Content past the viewport is cropped out of the PNG, so the baseline is stable,
reproducible and blind.

| route | was | cause | fix |
|---|---|---|---|
| `/` | 11px @320 | `NumberRoll.tsx:52` fixed `w-[1ch]` per digit; at `text-5xl` an 11-char value (**≥ $100,000.00**) needs ~316px in a 288px box | `text-4xl sm:text-5xl`, as `PortfolioChartPanel.tsx:185` already did |
| `/transactions` | 87px @320 | 4 non-wrapping tabs ≈ 391px | scroller **wrapper**, `w-max min-w-full` so `border-b` spans the scroll width |
| `/categories/[id]` | 38px @320 — **in no handoff** | grid track defaults to `minmax(auto,1fr)`, `auto` = min-content | `*:min-w-0`, same guard as `page.tsx:155` |

### 3.3 Coverage — green, and it had five contributors, not two

`deviation-layout.ts` and `transfer-flow-layout.ts` were never named because the coverage text
reporter only lists files with uncovered **lines** and theirs were branch-only.

Closed with real tests where reachable (xirr's bisection fallback needs a near-total two-year loss —
the only shape that both defeats Newton *and* puts the root in the lower half of the bracket, the
sole path through `hi = mid`), and `/* v8 ignore */` with written-out reasoning for four genuinely
unreachable float-overflow guards, following `ofx.ts:107`.

---

## 4. The investments chart — four owner asks (`88099af`)

### 4.1 Comparison is now optional

> *"i am forced to compare my performance to something. what if i want to see just my performance."*

He was right that it was forced: `resolveBenchmarkSymbol` fell through to `SPY`, so no state of the
UI showed your line alone. **"Just my return"** is now the first option in the picker and a
first-class persisted choice (`NO_BENCHMARK` in `src/lib/benchmark-symbol.ts`).

The sentinel is `"__none"` — underscores, which `SYMBOL_RE` rejects — so **no ticker can impersonate
it, including one literally spelled `NONE`**. `normalizeBenchmarkChoice` accepts it where
`normalizeBenchmarkSymbol` does not, keeping it away from the provider calls. Both the portfolio and
holding pages short-circuit before `hasBenchmark`, and the picker suppresses the "no price history"
nag for a choice that has none by design.

### 4.2 Trackpad zoom and pan

Rides the **existing `customWindow` path** the drag-brush already produced, so it inherits the
header caption, the From/To inputs, Reset and the table lens instead of inventing a second notion of
what is on screen. Maths is pure in `src/lib/chart-zoom.ts` (100% covered, 27 tests).

- **Pinch → zoom about the cursor.** Anchoring at the cursor is what makes it feel attached to the
  data; a centre-anchored zoom slides the thing under your fingers away.
- **Two-finger horizontal → pan**, span preserved exactly, so reaching an edge parks against it
  rather than squashing the window.
- **Plain vertical scroll is deliberately left to the page.** A chart halfway down a long page that
  eats scroll is a worse bug than one that does not zoom.

🔴 **The listener is registered natively, not via `onWheel`.** React attaches wheel listeners
**passively**, so `preventDefault()` on the synthetic event silently does nothing and the browser
zooms the whole page instead of the chart. It is held in a ref so it registers once while always
seeing the current render's state.

### 4.3 Day and week views

> *"i also need a week and day view"*

`CHART_RANGES` is now `1D 1W 1M 3M YTD 1Y ALL`, shortest first. Everything that renders pills reads
that array, so both chart and table lenses got them everywhere at once. **1D is one trailing day on
a daily series** — the change since the previous close, which is the honest reading for a ledger
with no intraday prices. Verified: 1D reads −$132.00, matching the TODAY stat exactly.

Adding the two windows most likely to fall short exposed a real honesty gap worth closing:
`windowedPoints` widens to the full series when a range holds < 2 points, and the **chart** said
nothing while the header still captioned it "1D". The table lens had always said so; now the chart
does too, in the same words.

Seven pills still fit at 320px (they wrap to `1D 1W 1M 3M YTD` / `1Y ALL`) — confirmed by the new
overflow gate, not by eye.

### 4.4 Refresh prices is on the surface

It already existed and already revalidated — **nothing about the fetch was broken.** It was behind
`⋯` → sheet → "Prices", two clicks deep beside the forms, so he could not find it. Moved to the page
header; the sheet's explanatory sentence became the button's tooltip.

---

## 5. 🔴 Traps this pass paid for

- **The handoff's own open-work list was the least reliable document in the repo.** Pass 27 §8 says
  to re-measure every quantity; its §6.2 was itself unmeasured and wrong in four of five bullets.
  **Measure the backlog before working it, not just the code.**
- **Tailwind arbitrary-value tokens are invisible to a `var(--x)` grep.** `shadow-(--press-2)` is a
  consumer; the "~0 consumers" claim came entirely from this and was false.
- **`next start` renames its process to `next-server (vX)`.** `pkill -f "next start"` never matches
  it, so a "restart" silently fails to bind and the OLD build keeps serving — which is exactly how
  a verified-looking run reported the pre-change UI. **Kill by port: `kill -9 $(lsof -ti tcp:3111)`.**
- **Bare `--update-snapshots` only rewrites baselines that FAILED.** With
  `maxDiffPixelRatio: 0.001`, a real UI change can leave baselines stale-but-passing — adding a
  visible button to `/investments` churned only the @1024 shots until
  `--update-snapshots=all` was run on the affected routes, which revealed the true scope of 40.
- **A passing test proves nothing until you have seen it fail.** All four new specs were verified by
  reintroducing the bug. TypeScript caught two neutering attempts on its own, which is a nice
  accident, not a substitute.
- **Playwright's config owns port 3111 with `reuseExistingServer: false`** — stop any preview server
  before an e2e run.
- **`playwright` is not hoisted under pnpm** — import from `@playwright/test`; a script outside the
  repo cannot resolve `better-sqlite3` either, so require it by absolute path from
  `<repo>/node_modules`.
- **The Browser pane would not follow a path** (URL stuck at root) and `get_page_text` returned only
  the nav. `curl` and a Playwright script were the reliable tools.
- **No prettier in this repo.** Format by hand; `tsc` will not catch indentation.
- **Leap years break "obvious" test arithmetic** — 2024-01-01→2025-01-01 is 366 days, so a 201×
  return solves to 197.11/yr, not 200. Use a non-leap span when the expected value must be derivable.
- Never `git add -A` — `node_modules` and `.env` are symlinks.

---

## 6. Open work — in the owner's stated order

### 6.1 Phase 2+ of the audit backlog ← **next**

`docs/review/08-backlog.md` — 84 items across 6 phases; Phase 1's 23 are done. Phase 2 is
"make it fast enough to host and to hold in one hand".

### 6.2 Small things genuinely open

- **The income double-count check** (§2) — two projection paths over one quantity.
- **`--annotation` on the /flow charts** — `TransferSpine`/`TransferTower` use `text-ink-muted`
  where the token was meant for chart marginalia. A consistency decision, arguably his.
- **Import the July 17–24 statements** so Phil's $3,500 lands.
- The main nav clips at 320px inside its own scroller (sanctioned, but worth a look); the
  dashboard's segmented view pills wrap to three rows at 320px.
- **Consider whether `maxDiffPixelRatio: 0.001` is too loose** now that it is known to hide real
  changes (§5). Tightening it would be a large, destabilising diff across 143 baselines — a
  deliberate decision, not a drive-by.

### 6.3 Hosting — ⛔ still NOT YET, by explicit instruction

> *"hosting is only at the end when im sure the final product is complete"*

Do not start it and do not propose it. The analysis is already written
(`docs/hosting-and-auth-plan.md`): keep SQLite, run it on the Mac, reach it over **Tailscale** —
$0/month, ~5–7 hours, zero database rewrite.

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

**Screenshot every new chart, and every view of it.** Measuring is not looking: this pass had 49
green overflow assertions and still had to open the PNGs to confirm the pages *read* — that the hero
still dominates at `text-4xl`, that the tab strip's rule spans the scroll width, that `min-w-0`
truncated a merchant name gracefully, that a two-point 1D chart is legible.

**Two databases — do not mix them.** DEMO/e2e (synthetic): `data/e2e.db`, reseeded by
`e2e/global-setup.ts`, 1,428 txns, hero $134,524.75. REAL: `data/moneyapp.db`, 9,753 txns, income
$118,913.85. Read the real one with raw `better-sqlite3`; **never `createDatabase()`** against it —
that runs migrations and writes, and defaults to the real path.

⚠️ **The dev server holds the real DB open.** `lsof data/moneyapp.db*` before any `--apply`, and
remember it will not appear under a `next start`/`next dev` process-name grep (§5).
