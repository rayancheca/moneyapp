# Handoff — 2026-08-03, pass 30

> Supersedes `docs/HANDOFF-2026-07-31-pass29.md`. One piece of work: the **1D day view is
> finished and shipped**. Getting there turned up three real defects, each of which had already
> been blessed by something — a green test, a 100%-covered module, or a screenshot.

## 1. Repo state

| | |
|---|---|
| `main` | `dd5f15f`, pushed, clean. Verify with `git rev-parse main` rather than trusting this line. |
| worktree | `.claude/worktrees/app-polish-adversarial-review-e80abb` **still stale at `4d45273`** — untouched for three passes. Remove or reset it. It duplicates several chart files, so an unscoped `grep -rn` from the repo root double-counts and can send you editing the wrong tree. Scope every grep to `src e2e scripts`. |
| real DB | **not written this pass.** Migration `0007` (`price_intraday`) was still unapplied to `data/moneyapp.db` at the start of this pass — measured, 7 migrations vs e2e.db's 8, table absent. `src/db/client.ts:47` calls `migrate()` on every `createDatabase()`, so it self-heals on the next dev-server start. It has not been verified as applied; check before assuming the 1D view works against the real DB. |

**Gate, measured on a fresh build:**

| | pass 29 | now |
|---|---|---|
| `tsc --noEmit` | clean | clean |
| unit | 138 files / 2,340 · coverage green | **139 files / 2,385** · coverage green (99.64%) |
| `next build` | clean | clean, 17 routes |
| e2e | 372/372 | **380/380** under `E2E_GATE=1` |
| visual baselines | 143 | **146** (3 new, stable across two consecutive no-update runs) |

---

## 2. What shipped

**`src/lib/intraday-axis.ts`** — the only place an instant becomes text. `sessionTimeLabel`,
`sessionDayOf`, `sessionView` (builds points + ticks + caption span, prepends the previous-close
anchor) and `sessionSummarize`. Pure, 100% covered.

**The seam is substitution, not widening.** On 1D, `ScrubChart` is handed its window and its axis
ticks instead of deriving them from `.day`. `chart-window.ts`, `chart-axis.ts`, `dates.ts` and
`chart-range.ts` are untouched and still refuse instants — now pinned by permanent guard tests that
replaced pass-29's throwaway `zz-probe-scratch.test.ts`. Everything is gated on
`sessionActive = range === "1D" && session.points.length >= 2`, and `DAILY_SERIES_RANGES` is
*derived* by excluding `"1D"`, so the five daily-only render sites cannot reach any new branch —
that is a structural proof, not an assertion.

**Read path:** both pages are already `force-dynamic`, so the RSC reads the session on every render
(1 + 2N indexed selects against a two-day-retention table) and passes it down. **Write path:** a new
`refreshIntradayAction` behind a "Load today's session" button — deliberately NOT folded into
`refreshPrices`, which `prices.test.ts:180` asserts must not fetch intraday.

**The caption is the honesty seam.** It names the basis (previous close vs first print), the coverage
(`N of M holdings priced`), and the timezone — because a bare "▲ $312" on a day view implies a
baseline it may not have.

---

## 3. 🔴 The three defects, and what had already blessed each

### 3.1 The timezone — invisible on this machine by construction

The plan of record (pass-29 §4) was *"the server emits each tick's label … server-local time **is** the
owner's time"*. **This dev box resolves to `America/New_York`.** That plan renders correct labels
here, passes all 143 baselines, and renders `1:35 PM` instead of `9:35 AM` under any UTC runner.
Measured, same code, only `TZ` changed: **9:35 AM / 1:35 PM / 3:35 PM / 7:05 PM** for
New York / UTC / Berlin / Kolkata.

Both the zone and the locale are now pinned explicitly. A fixed UTC offset was rejected on evidence:
09:30 ET is `13:30Z` in July and `14:30Z` in January, and because `price_intraday` is pruned to two
sessions an offset bug would stay invisible until the DST boundary.

⚠️ **`TZ` is still pinned nowhere in the repo** — not `playwright.config.ts` (which pins six other env
vars), not `vitest.config.ts`, not the browser context. So the value assertions are the CI guard and a
**source-text guard** is the local one: it fails on the machine where the pin is deleted. Do not remove
either; on an Eastern box the value test alone cannot fail.

### 3.2 The prior close that was never drawn — and the test that "proved" it

`intraday-grid.ts` claimed the first grid point equals yesterday's closing valuation. **It does not.**
The time axis is the union of instants that *ticked*, so the earliest instant is by definition
someone's first print. Measured: prior close $200, open $210 → **first point $210**. For an
equities-only book the overnight gap simply was not drawn, and "the day's move" silently meant "the
move since the open".

The existing test named *"the first grid point equals yesterday's closing valuation"* passed — because
it manufactured a zero-quantity ETH holding ticking at 00:00Z, the only condition under which the
claim holds, and then named itself after the general case. It is now renamed to what it actually pins,
and the refuting case sits beside it. The anchor is added by `sessionView`, at the view layer, where it
can be captioned when no prior close exists.

**This shipped last pass with 100% coverage.** Coverage proved the function computes; nothing proved
it answered the question anyone was asking.

### 3.3 The header that read $0.00 over a line that had visibly moved

`ReturnViewParts.tsx:154` selects rows with `d.day >= from`. Once `from` is an instant,
`"2026-07-08" >= "2026-07-08T00:00:00.000Z"` is **false** (a prefix sorts first), so the filter matched
nothing, the aggregate was empty, and the header reported **"$0.00 (+0.00%)" over an 11% session**.
No exception, no crash — just a wrong number.

`sessionSummarize` replaces it while a session is drawn. **This was found by looking at a screenshot,
not by a test**, and there is now an e2e assertion for it.

---

## 4. 🔴 Traps this pass paid for

- **Two obviously-correct DOM selectors both returned nothing.** recharts renders tick text into a
  separate `.recharts-cartesian-axis-tick-label` layer, so `.recharts-cartesian-axis-tick` matches six
  elements whose `textContent` is empty and `.recharts-xAxis text` matches **zero** nodes. My first
  helper reported "the axis has no time labels" about a chart that was painting them perfectly. Always
  dump the DOM before believing a negative measurement — and take a **control reading on the working
  case** (the daily axis had the same empty text, which is what proved the helper wrong rather than
  the chart).
- **Suppressing a chart element is not the same as removing it from the scale.** Dropping trade marks
  from the JSX but leaving them in `collectValues` kept an old $150 buy stretching the y-axis to
  $100–$250, squashing the whole day's move into the top sliver of a plot with nothing drawn down
  there to explain why. Same for the avg-cost `refLine`, now dropped on 1D.
- **recharts centres a tick label on its category**, and the first category sits ~6px from the edge, so
  a wide label loses its left half — `"Prev close"` rendered as `"v close"`. Ticks are now inset from
  both ends. A custom tick component would have been the "proper" fix and would have moved all 143
  daily baselines to solve a problem only this view has.
- **A new spec's writes leaked into a sibling.** `zz-zz-intraday` sorts before `zz-zz-view-switcher`,
  so the session it loads was still there when the older spec asserted 1D shows ≤2 points. Fixed by
  making that assertion read the page's own note rather than assume an order — renaming the file to
  sort later would have hidden the coupling instead of removing it.
- **A stray `zz-zz-intraday.spec 2.ts` appeared** in the working tree mid-pass (an editing artifact,
  holding a stale copy that would have failed). It never ran — `…spec 2.ts` does not match Playwright's
  default `*.spec.ts` — confirmed by the test count landing at exactly 372 + 8. Check `git status` for
  ` 2.` files before committing.
- **`--reporter=basic` no longer exists in vitest 4** and fails with an unhelpful module-resolution
  stack. Use `dot`.
- **The coverage text reporter hides the file you just wrote** when it is at 100%; scope it with
  `--coverage.include='<path>'` to see a per-file row.
- **`data/e2e-originals` can fail `global-setup` with `ENOTEMPTY`** — it is declared scratch, `rm -rf`
  it and re-run.
- Never `git add -A` — `node_modules` and `.env` are symlinks. Stage paths explicitly.

---

## 5. ⚠️ Known, deliberate, and NOT defects

- **The e2e portfolio 1D chart shows an ~11% step at the open.** This is a *fixture* inconsistency, not
  a product bug, and it is measured: `data/e2e.db` seeds ETH's daily close at **$2,323.33** while the
  fake provider's intraday walk starts it at **$3,726.58** — the seed and the fake provider are
  independent. AAPL (234.84 → 238.95) is sane. In the real app both closes and ticks come from the same
  provider. Fixing it would mean reseeding `price_cache` from `fakeDailyClose`, which would move
  portfolio values across the whole suite.
- **1D applies to the portfolio VALUE view and the holding PRICE view only.** In the Return view the
  1D pill keeps the existing two-point daily behaviour: `returnPoints` is a flow-adjusted daily series
  with a different y-meaning, and intraday flow-adjustment would need a second grid. Unchanged
  behaviour, not a regression.
- **Drag-zoom, pinch/pan and the From/To date inputs are disabled inside a session**; hover, press-drag
  scrub and keyboard scrub are kept. A sub-window of one session is a time range, and giving it a
  `{start, end}` *day* pair would be a lie.
- **No auto-refresh.** A session loaded at 10:00 and viewed at 14:00 draws a line ending at 10:00 — the
  caption states its own end time, so it does not imply it is current.
- **A crypto-holding portfolio's session is a UTC day**, which in ET begins at 8:00 PM the previous
  evening. Axis labels and the caption are date-prefixed so it cannot read as one continuous clock, and
  the tick target drops from 6 to 4 because those labels are twice as wide (six of them collide into a
  smear at 440px).

---

## 6. Open work, in the owner's stated order

### 6.1 Phase 2 of the audit backlog ← **next**
Corrected order from pass 29's re-measurement, best value first. Nothing here has been started.

1. **27, retargeted** (S, not M) — `forecast.ts:360` calls `bridgedNetWorthSeries(db)` (measured
   **659.0ms**) just to read `.at(-1).totalCents`. That is 94% of `/recurring`, and `/` pays it too.
   ⚠️ The comment at `:358-359` says the value is bridged deliberately so the EOM projection starts from
   the dashboard headline — assert the replacement equals `bridgedNetWorthSeries(db).at(-1).totalCents`
   on a seeded DB; do not eyeball it.
2. **24** (M) — React `cache()` on five (not four) service reads. Do it *after* 27, which deletes one of
   the two dashboard call sites its premise rests on. ⚠️ Prove `cache()` is inert outside a render scope:
   2,385 unit tests call these directly in node-env vitest.
3. **26 part 1** (M) — `flowsByDay` hoisting kills 7,964 of 8,235 statements on `/investments`.
4. **32** (S), **30** (S), **29** (S) — bundle their verification; all three need a touch-emulation
   Playwright project that does not exist yet (`playwright.config.ts:41` is a single desktop chromium
   with no `hasTouch`, so **every `pointer-coarse:` branch has never executed**).
5. **25** (M) — last. Its entire payoff is KB, and the perf/bundle constraint was explicitly removed.
6. **31** — do not schedule; blocked by item 33 in Phase 3.

### 6.2 Smaller things still open
- **The income double-count check** (pass 28 §6.2) — two projection paths over one quantity. Still
  unverified, still cheap, still touches the number the owner cares most about.
- **Tighten `maxDiffPixelRatio`** — pass 29 proved removing a visible pill moved no baseline past
  `0.001`. Evidence is already written down.
- **Pin `TZ` in the test configs** so a UTC run is exercised, rather than relying on the source guard
  (§3.1). Cheap, and it would have caught the defect this pass had to reason its way to.
- `--annotation` on the /flow charts; import the July 17–24 statements so Phil's $3,500 lands.

### 6.3 Hosting — ⛔ still NOT YET, by explicit instruction
> *"hosting is only at the end when im sure the final product is complete"*

Do not start it and do not propose it. The analysis is already written (`docs/hosting-and-auth-plan.md`).

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

**Screenshot every new chart, and every view of it, and then LOOK at the PNG.** This pass had a green
gate, a correct `aria-valuetext`, and a header reporting $0.00 over an 11% move. The screenshot is what
found it.

**Two databases — do not mix them.** DEMO/e2e (synthetic): `data/e2e.db`, reseeded by
`e2e/global-setup.ts`. REAL: `data/moneyapp.db`, 9,753 txns, income $118,913.85. Read the real one with
raw `better-sqlite3`; **never `createDatabase()`** against it — that runs migrations and writes, and
defaults to the real path.

⚠️ **The dev server holds the real DB open.** `lsof data/moneyapp.db*` before any `--apply`, and note it
will not appear under a `next start`/`next dev` process-name grep — the process renames itself to
`next-server (vX)`. Kill by port: `kill -9 $(lsof -ti tcp:3111)`.
