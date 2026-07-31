# Handoff — 2026-07-31, pass 28

> Supersedes `docs/HANDOFF-2026-07-30-pass27.md`, which built the Tower. This pass closed
> **item 13b** (the last of the owner's open questions that needed him at the keyboard) and then
> cleared the whole §5.2 small-fixes list — after discovering that most of that list was wrong.

## 1. Repo state

| | |
|---|---|
| `main` | one commit this pass, on top of `f6fd644`. Verify with `git rev-parse main`; a handoff cannot name its own hash without lying. |
| worktree | `.claude/worktrees/app-polish-adversarial-review-e80abb` still stale at `4d45273`. Remove it or reset it before use. |
| real DB | **written this pass** (item 13b). Backup: `data/backups/moneyapp.db.pre-13b.2026-07-31T15-18-42-698Z`. |

**Gate, measured on a fresh build:**

| | pass 27 | now |
|---|---|---|
| `tsc --noEmit` | clean | clean |
| unit | 2,244 · **coverage RED** | **2,257** · **coverage GREEN, exit 0** |
| `next build` | clean | clean, 17 routes |
| e2e | 284/284 | **343/343** under `E2E_GATE=1` |
| visual baselines | 143 | 143 (14 intentionally regenerated) |

`pnpm test` **passes for the first time**. Previous handoffs told you to gate on `test:fast` and
ignore a red coverage run; that advice is now obsolete — a red `pnpm test` means you broke something.

---

## 2. Item 13b — done, and it inverted its own premise

Full record: `docs/review/12-item13-resolved.md` §13b. The short version:

Of the eight ATM cash deposits the "Cash job (weekly pay)" series had swept up, **only two are
pay** — the Florida pair, $1,447. The other six left income: **$1,500 → Loans** (Phil repaying the
$5,000 Zelled to him on 2025-06-25, a loan the app already tracked), **$1,000 → Family
pass-through** (his girlfriend's cash to forward; the send failed), **$1,180 → Internal Transfer**
(his own cash, plus one $730 he does not recognise).

Income **$122,593.85 → $118,913.85**. Salary **$49,194.86 → $45,514.86**. Balances unchanged.

**The premise that the projection was contaminated was WRONG.** Asked what the job actually pays:

> *"its 1046 a week for the past month or two i just havent been depositing it in the bank often
> ... i do get paid i just put it in the bank at random intervals and quantities."*

So $1,046/wk is real earnings, and the deposits were never a measurement of it. It is now pinned as
`user_amount_cents` / `user_cadence` on the series, which `effectiveSeries()` (`recurring.ts:681`)
reads ahead of the detected value — previously it survived only by accident, since it is not the
average of the series' members ($640.88).

**Carry forward:**
- Recorded `Salary` now deliberately **under-counts** what he earns. Earnings ≠ deposits; do not
  try to make them reconcile.
- ⚠️ **Unverified:** whether the series' fixed weekly occurrence and `projectOngoingIncome`'s
  trailing `Salary` average both count the same deposited cash. Two projection paths, one quantity.
- The **$3,500 Phil Zelled him is not missing, just not imported** — Chase Checking coverage ends
  2026-07-10; that landed ~07-17→07-24. A statement import will pick it up.
- A separate **−$1,495 Zelle to Philipe, 2026-05-29**, already filed `Loans` — possibly a second
  loan outstanding. Not touched.

### The guarded-write pattern, refined

`clarify-atm-pay-split.cjs` (in the session scratchpad). Beyond pass 24's backup + dry-run +
Δ-guards + `source='user'`, two additions worth keeping:

- **Preflight identity assertions.** Every target row must match its expected `posted_on`,
  `amount_cents`, `category_id` and series link, or the run aborts. The script cannot be replayed
  against a database it does not recognise.
- **Verify against the backup, not the script's own report.** Diff live-vs-backup row by row and
  assert exactly N rows differ in exactly the intended columns. That caught nothing this time,
  which is the point — it is what makes "balances unchanged" a measurement rather than a claim.

⚠️ **`series_link_source='user'` is load-bearing.** It is why detection skips these rows
(`recurring.ts:377`) and why the unlinks survive a re-run. Note also that dropping the series to 2
members puts it below `MIN_OCCURRENCES = 3`, so `analyzeGroup` returns null and
`recomputeSeriesStats` keeps the last good stats — the series is *more* protected, not less. But
`recomputeSeriesStats` also fires on **every user link/unlink through the UI**, so unlinking a row
from the series page is the one action that could still re-derive those stats.

---

## 3. §5.2 — all of it done, and most of it was mis-described

The single most useful thing in this pass: **re-measuring the handoff's own open-work list.**
Four of five bullets were wrong. Corrections are inline in
`docs/HANDOFF-2026-07-30-pass27.md` §6.2; what shipped:

### 3.1 The `?error=` gap — real, but on two pages nobody had named

`/investments`, `/recurring` and `/settings` had been fixed since pass 25. The pages actually
dropping it were **`/accounts/[id]`** — the target of `addAnchorAction`, i.e. the
"Record a balance" form the code comments say the owner crashed twice — and **`/transactions`**,
target of all four redirect actions via `returnPath`. A refusal on either re-rendered the page
completely unchanged.

Six pages had each hand-rolled byte-identical banner markup, which is *why* two got missed. Now one
shared `src/components/ui/ErrorBanner.tsx` (+ `errorParam`), used by all eight sites.

`e2e/error-banner.spec.ts` guards it, including a **drift test** that scans `src/app/*/actions.ts`
for `?error=` redirects and fails if any lands on a page the spec does not cover. Verified to have
teeth: reintroducing the bug fails 3 tests, and it fails even when the message is in the DOM but
without `role="alert"`.

### 3.2 Horizontal overflow — fixed, and now impossible to reintroduce silently

`e2e/overflow.spec.ts` asserts `documentElement.scrollWidth <= clientWidth` on 16 routes × {320,
375, 440}, and on failure **names the offending elements** (skipping anything inside a legitimate
`overflow-x` scroller). 49 tests.

**Why 143 green baselines never caught this:** `toHaveScreenshot({fullPage:true})` captures the
*scrollport*. A row running 87px past a 320px viewport is simply cropped out of the PNG — the
baseline is stable, reproducible, and blind. Three passes rediscovered these by hand.

| route | was | cause | fix |
|---|---|---|---|
| `/` | 11px @320 | `NumberRoll.tsx:52` gives each digit a fixed `w-[1ch]`; at `text-5xl` an 11-char value (**≥ $100,000.00**) needs ~316px in a 288px box | `text-4xl sm:text-5xl` — the same responsive-hero move `PortfolioChartPanel.tsx:185` already makes |
| `/transactions` | 87px @320, 32px @375 | 4 non-wrapping tabs ≈ 391px | scroller **wrapper** around the nav, `w-max min-w-full` so `border-b` spans the scroll width |
| `/categories/[id]` | 38px @320 — **never mentioned in any handoff** | `grid` track defaults to `minmax(auto,1fr)` and `auto` = min-content | `*:min-w-0`, same guard as `page.tsx:155` |

The ViewTabs scroller is a **wrapper**, not the nav itself, deliberately: `overflow-x:auto` forces
the other axis from `visible` to `auto`, and the links' `-mb-px` would put their border box 1px
below the nav's content box — enough to trip a vertical scrollbar. Measured `verticalOverflow: 0`.

### 3.3 Coverage gate — green, and it had five contributors, not two

`in-flight.ts` and `xirr.ts` were named. **`deviation-layout.ts` and `transfer-flow-layout.ts` were
not**, because the coverage text reporter only lists files with uncovered **lines** and theirs were
branch-only. Anyone reading that table would have declared victory two files early.

Closed with real tests where the code was reachable — a zero-delta in-flight window; xirr's
bisection fallback (a near-total two-year loss is the only shape that both defeats Newton *and*
puts the root in the lower half of the bracket, which is the sole path through `hi = mid`); a rate
past the domain ceiling; degenerate all-zero-net and zero-dollar-edge layouts. Four genuinely
unreachable float-overflow guards got `/* v8 ignore */` with the reasoning written out, following
`ofx.ts:107`.

⚠️ **Do not chase these by inference.** The merged "Uncovered Line #s" column lies: it showed
`76-78` when line 77 was fully covered. Read `coverage-final.json` and print the actual
`statementMap`/`branchMap` entries.

---

## 4. 🔴 Traps this pass paid for

- **The handoff's own open-work list was the least reliable document in the repo.** §8 of pass 27
  says to re-measure every quantity; its §6.2 was itself un-re-measured and wrong in four of five
  bullets. **Measure the backlog before working it, not just the code.**
- **Tailwind arbitrary-value tokens are invisible to a `var(--x)` grep.** `shadow-(--press-2)` is a
  consumer. The "0 consumers / thin adoption" claim came entirely from this and was false.
- **A passing test proves nothing until you have seen it fail.** Both new specs were verified by
  reintroducing the bug. Related: TypeScript caught one neutering attempt, because `error &&` is
  what narrows `string | null` — a nice accident, not a substitute.
- **Playwright's config owns port 3111 with `reuseExistingServer: false`.** Stop any preview server
  before an e2e run.
- **`playwright` is not hoisted under pnpm** — import from `@playwright/test`, and a script outside
  the repo cannot resolve `better-sqlite3` either; require it by absolute path from
  `<repo>/node_modules`.
- **The Browser pane would not follow a path** (URL stayed at root) and `get_page_text` returned
  only the nav. `curl` + a Playwright script were the reliable tools. Consistent with pass 27's
  finding that the pane reports every rect as 0 when hidden.
- **No prettier in this repo.** Format by hand; `tsc` will not catch indentation.
- **Leap years break "obvious" test arithmetic.** 2024-01-01→2025-01-01 is 366 days, so a 201×
  return solves to 197.11/yr, not 200. Pick a non-leap span when the expected value is meant to be
  derivable.
- Never `git add -A` — `node_modules` and `.env` are symlinks.

---

## 5. Open work — in the owner's stated order

### 5.1 Phase 2+ of the audit backlog ← **next**

`docs/review/08-backlog.md` — 84 items across 6 phases; Phase 1's 23 are done. Phase 2 is
"make it fast enough to host and to hold in one hand".

### 5.2 Small things still genuinely open

- **The income double-count check** (§2 above) — two projection paths over one quantity. Cheapest
  real win, and it touches the number the owner cares most about.
- **`--annotation` on the /flow charts** — `TransferSpine`/`TransferTower` use `text-ink-muted`
  where the token was meant for chart marginalia. A consistency decision, arguably the owner's.
- **Import the July 17–24 statements** so Phil's $3,500 lands.
- The main nav clips at 320px inside its own scroller (sanctioned, but worth a look), and the
  dashboard's segmented view pills wrap to three rows at 320px.

### 5.3 Hosting — ⛔ still NOT YET, by explicit instruction

> *"hosting is only at the end when im sure the final product is complete"*

Do not start it and do not propose it. The analysis is already written
(`docs/hosting-and-auth-plan.md`): keep SQLite, run it on the Mac, reach it over **Tailscale** —
$0/month, ~5–7 hours, zero database rewrite.

---

## 6. How to work on this repo

```bash
node_modules/.bin/tsc --noEmit
node_modules/.bin/vitest run --coverage --reporter=dot   # coverage is GREEN now — keep it there
node_modules/.bin/next build
E2E_GATE=1 node_modules/.bin/playwright test --reporter=line
```

`pnpm e2e` serves a **stale `.next`** — always `pnpm e2e:fresh`. `assertBundleIsFresh()` only stats
`./src`, so a `next.config.ts` change or a package bump will NOT mark the bundle stale.

**Screenshot every new chart, and every view of it.** Measuring is not looking: this pass had 49
green overflow assertions and still had to open the PNGs to confirm the pages *read* — that the
hero still dominates at `text-4xl`, that the tab strip's rule spans the scroll width, that
`min-w-0` truncated a merchant name gracefully instead of mangling it.

**Two databases — do not mix them.** DEMO/e2e (synthetic): `data/e2e.db`, reseeded by
`e2e/global-setup.ts`, 1,428 txns, hero $134,524.75. REAL: `data/moneyapp.db`, 9,753 txns, income
$118,913.85. Read the real one with raw `better-sqlite3`; **never `createDatabase()`** against it —
that runs migrations and writes, and defaults to the real path.

⚠️ **The dev server holds the real DB open.** `lsof data/moneyapp.db*` before any `--apply`. It was
already stopped this pass, so nothing had to be killed — check, don't assume in either direction.
