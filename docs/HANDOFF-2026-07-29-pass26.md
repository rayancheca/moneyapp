# Handoff — 2026-07-29, pass 26

> Supersedes `docs/HANDOFF-2026-07-29.md` (written by the previous session, which was
> still mid-gate at the time). Everything that handoff listed as "uncommitted" is now
> committed, merged and pushed.

## 1. Repo state, exactly

| | |
|---|---|
| `main` | **`01462b0`** — clean, `== origin/main`, pushed |
| branch | `claude/app-polish-adversarial-review-e80abb` — **same commit** as main |
| worktree | `.claude/worktrees/app-polish-adversarial-review-e80abb` (the only one) |
| uncommitted | **none**, anywhere |

**Gate at handoff, run on `main` at `01462b0` against a fresh build:** `tsc` clean ·
**132 files / 2,143 unit tests** · `next build` clean (17 routes) · **258/258 e2e**.

**Closed out at handoff:** no dev/preview server running, nothing listening on 3000 or
31xx, no process holding the real database, no test runner alive. Three stale worktrees
(`chart-table-pass23`, `quirky-elgamal-570ccc`, `transaction-clarification-pass-483a26`)
were removed — all three were at commits already in `main` and held nothing but the
untracked `node_modules` symlink. **Their branches were kept**, so any of them can be
recreated with `git worktree add`. One throwaway debug spec was discarded from the first
of those (`e2e/zzz-cells.spec.ts`: hardcoded screenshot paths into a scratchpad belonging
to a different project directory, `console.log` inspection, `waitForTimeout`); the feature
it poked at is properly covered by `e2e/zz-spending-drilldowns.spec.ts:44`.

### ⚙️ Worktree setup — both symlinks are required, both are gitignored

```bash
ln -sfn /Users/rayankarimcheca/Desktop/Dev/MoneyApp/node_modules node_modules
ln -sfn /Users/rayankarimcheca/Desktop/Dev/MoneyApp/.env .env
```

The missing `.env` — not an expired key — was the long-standing cause of the dead
"Claude categorize" button.

---

## 2. ⚠️ A SECOND CLAUDE SESSION SHARED THIS WORKTREE — close its window

PID **90295**, open ~2 days, cwd = the same worktree. During pass 26 it independently
**committed the A+ work as `fb2caec`** and ran three of its own e2e gates, holding port
3111 the whole time.

**Status at handoff:** its processes are all stopped and its uncommitted work is preserved
in `01462b0` (see §5.3 — three real re-measurements that would otherwise have been lost).
The session *process* is still alive but idle, one of ~21 open in the Claude app. It was
left running on purpose: killing it is a UI action that belongs to the owner, not something
to force. **Close that window before starting the next pass** — two agents editing one
worktree is how work gets lost.

Symptoms to recognise if it happens again:

- `playwright` fails instantly with `http://localhost:3111 is already used`
- the PID listening on 3111 keeps *changing* (it is respawning per run)

**Diagnose before you kill anything:**

```bash
ps -eo pid,ppid,etime,command | grep -E "playwright.*cli\.js|next-server" | grep -v grep
```

Trace the PPID chain. A `next-server` with `PPID 1` is an orphan and safe to stop. One
whose grandparent is a `claude` process is a **live gate belonging to another session** —
killing it discards a real result. Ask the user before taking the worktree over.

Close that session if you can; two agents editing one worktree is how work gets lost.

---

## 3. What shipped in pass 26

Code commits, each gated on a fresh build before merge:

| commit | what |
|---|---|
| `fb2caec` | Direction A+ waves 1–2 (**the other session's commit**) |
| `c4d6610` | fix: portfolio view-switcher spec no longer races React hydration |
| `097304d` | feat: `/flow` — the transfer-flow view |
| `2d9d3dd` | fix: spine fits its canvas, clears its labels, rhythm rail legible |
| `d4deccf` | feat: "What moved" — Direction C's deviation bar on `/spending` |

Then documentation, up to the current `main`:

| commit | what |
|---|---|
| `4bf6fe6` | this handoff |
| `4232a12` | folds §5.3's re-measurements into this handoff |
| `01462b0` | the other session's own final handoff update, preserved rather than discarded |

### 3.1 ⚠️ THE HYDRATION RACE — this is repo-wide, not one spec

The `zz-zz-view-switcher` portfolio failure was **not** a flake to retry. Measured
**3 failures in 5 isolated runs**, always the same assertion, always the same dump:

```
- button "Value"
- button "Return" [pressed]
- slider "Portfolio return over time"
```

The pill had not moved, so this was never a slow render or a stale baseline: **the click
was swallowed.** Every segmented-control pill is a `"use client"` button that ships in
the SSR HTML *already visible and already enabled*, so Playwright's actionability checks
pass **before** React attaches `onClick`. A click landing in that window does nothing at
all and reports no error.

Two fixes were needed, and the first alone was not enough:

1. **`gotoHydrated()`** waits for the **SVG inside the theme toggle**. `ThemeToggle`
   renders `{mounted ? <Icon/> : <span/>}`, so that svg is a true post-hydration signal.
   **Its `aria-label` is NOT** — the label is in the SSR markup too, which means the
   existing `openHydrated` precedent in `visual.spec.ts` and `keyboard.spec.ts` is
   **unsound and proves nothing**. This alone took 3-in-5 → 2-in-12.
2. **`pressView()`** retries the press until the control reports `aria-pressed="true"`.
   The theme toggle lives in `AppShell`, so waiting on it proves the **shell** hydrated,
   not the panel — React hydrates client boundaries independently and no DOM signal
   marks that moment. Safe because it is idempotent: `useViewState.setView` early-returns
   when the value is already selected (`if (next === state) return`).

**Result: 0 failures in 15 consecutive runs.** Both helpers live in
`e2e/zz-zz-view-switcher.spec.ts` and are copied into `e2e/zz-zz-flow.spec.ts`.
**Copy this pattern into any new spec that clicks a control soon after `goto`.**

### 3.2 `/flow` — the transfer-flow view

```
src/services/transfer-flow.ts          DB → graph (reconciles EVERY group)
src/lib/transfer-flow-layout.ts        pure spine geometry
src/components/charts/TransferSpine.tsx     2D renderer
src/components/charts/TransferRhythm.tsx    monthly rail
src/components/charts/TransferMatrix.tsx    table lens (directed matrix)
src/components/charts/TransferFlowPanel.tsx switchers + lifted hover
src/components/charts/transfer-flow-view-spec.ts
src/app/flow/page.tsx                  the route
e2e/zz-zz-flow.spec.ts
```

Route is **`/flow`** (owner's call; the spec proposed `/transfers`). Nav entry sits after
Spending, icon `flow` → `ArrowLeftRight`.

**Design invariants that must not be broken:**

- **Bulge is a function of node SPAN, never of value.** Amounts can change without moving
  the layout — that is what keeps the baselines stable.
- **Two channels: stroke width = dollars, dash gap = transfer COUNT.** On the real data
  SoFi Savings→SoFi Checking is 299 × ~$327 while Chase→SoFi Savings is 23 × ~$3,435 —
  near-identical totals, opposite behaviour. One ribbon width would call them the same.
- The dash **gap** is static geometry; only the **drift** is motion, so
  `prefers-reduced-motion` costs no meaning.
- **Deliberately NOT `role="img"`** on the SVG. The spec asked for it; `SankeyChart`
  already learned that `role="img"` **prunes nested interactive content** from the a11y
  tree, which would destroy the keyboard path to every arc and node. `<title>` + `<desc>`.
- Drill goes to the **sending account's** ledger over the window — `ledgerHref` has no
  transfer-pair filter, and inventing a param `/transactions` cannot honour is a dead link.

**Net ≠ "no returning arcs".** Nodes are ordered by each account's *total* net position,
so a pair can legitimately net "up" the ladder — an account that is a net sink overall may
be a net sender to one counterparty. Exactly one such arc survives on the real data.
The e2e spec asserts `net returning ≤ gross returning`; **asserting zero would assert a bug**
(the first draft did exactly that and failed honestly).

### 3.3 "What moved" — the deviation bar

`src/lib/deviation-layout.ts` + `src/components/spending/CategoryDeviation.tsx`, wired
into `/spending`. One vertical rule, bars right when more was spent than last period and
left when less. Ordered by **size of move**, not amount spent. Reads the *same* two
breakdowns the categories table already compares (`breakdown` + `prevById`), so the two
panels cannot disagree. Scale is **linear** here — unlike the spine's stroke widths this
axis *is* the quantity being compared.

On `/spending`, not the dashboard: the dashboard's category list already prints the move
beside each amount and encodes it in the block heights; a third encoding is noise.

---

## 4. ✅ Real-DB write applied — the detector gap is closed

Backup: `data/moneyapp.db.backup-detector-2026-07-27T19-34-59-363Z` (12.8 MB, with
`-wal`/`-shm`).

**109 of 134 orphan legs paired.** Measured after the write:

| | before | after |
|---|---|---|
| single-leg groups | 134 | **25** |
| two-leg groups | 516 | **625** |
| total groups | 650 | 650 (unchanged) |
| directed edges | 13 | **17** |
| accounts in graph | 6 | **7** (Chase Sapphire enters) |
| gross | $330,513.57 | **$368,107.54** |

Δ gross = exactly the **$37,593.97** repaired. `integrity_check: ok`, 0 foreign-key
violations. **Every guard unchanged**: rows, active, amountSum, spend (15907506), income
(12259464), investment, categorized.

Safe by construction: **only `transfer_group_id` was written** — never an amount, category,
status or note. `spendingBucket` gates on category **kind**, and 108 of 109 counterparts
were already `kind='transfer'` (one was `investment`). So no spending or income total
could move, and the guards proved it rather than assuming it.

**25 legs remain unpaired ($12,797)** — 21 have no same-day counterpart (mostly external
Robinhood deposits, i.e. the counterparty is outside the tracked accounts) and 4 are
genuinely ambiguous. `/flow` shows them explicitly in a "Not shown above" panel with the
reason breakdown. **Never let that panel disappear** — dropping 21% of groups silently was
the original sin this view exists to avoid.

⚠️ **Bug worth remembering** if you write a similar pass: the mutual-nearest check must
count orphans matching **`o.amount_cents`** (the counterpart's opposite), not
`-o.amount_cents`. Getting that sign wrong computed **0 proposals** while the DB was
provably unchanged — it looked like "the database moved", and it hadn't.

---

## 5. Open work

### 5.1 The 3D "Tower" — NOT built
`docs/transfer-flow-view.md` §3.2. Account pillars on a deterministic ring with **time as
the vertical axis**, one arc per (edge, month). Decision already made: **SVG +
orthographic projection, not WebGL** — deterministic so visual snapshots survive,
axe-inspectable, zero bundle. Fixed default camera (`az −0.62, el 0.28, zoom 1`, `Home`
resets), no auto-spin, no `Math.random`. This is the largest remaining piece and the one
part of the owner's brief ("the 3D charts from design C") not yet delivered for transfers.
`/flow` currently ships the 2D spine + rhythm + matrix only.

### 5.2 Smaller, well-specified
- **`?error=` unrendered** on `/investments`, `/recurring`, `/settings` — server actions
  redirect with a human message these pages drop. Copy `src/app/budgets/page.tsx:43,70-75`
  (a `role="alert"` banner).
- **`HeaderStrip.tsx`** doesn't render the `failed` Claude-run state that exists in the model.
- **`--press-2` / `--press-3`** still have few consumers; the depth scale is partly applied.
  (`TransferSpine`'s tooltip uses `shadow-press-2`.)
- **`--annotation` adoption is thin** — 8 elements. Worth extending.
- **Residual overflow**, both pre-existing and untouched: **11px at 320px** on `/` — the hero
  odometer's per-digit `w-[1ch]` spans measure 315px in a 288px box (`src/app/page.tsx:154`) —
  and **~87px at 320px** on `/transactions`. Everything else is 0 at 440px.

### 5.3 Two measurement lessons inherited from the A+ session
Recorded in `5db96eb`; both generalise beyond the work that produced them.

**Count token adoption on COMPUTED STYLES, not by source grep.** Measured across 10 routes ×
both themes: `--emboss-hi` **157** elements, `--emboss-lo` 139 light / 194 dark,
`--ink-display` **85**, `--surface-leaf` 41, `--accent-ink` 20, `--annotation` 8. A source
grep of the same tree reported roughly 8 and 6 — it counts declaration sites, not the
elements that actually inherit them, and so understates adoption by more than an order of
magnitude.

**A registry that drives UI needs a spec that ENUMERATES the registry.** `/?chart=terrain`
was a **500**: the option was registered in the view spec — so it rendered a clickable pill
and a persistable URL — but was never wired to a renderer, so the raw slug fell through an
exhaustive switch and threw. **All 246 e2e passed over it, because not one test opened the
view.** `e2e/zz-zz-dashboard-chart-options.spec.ts` now walks the spec itself, so the next
appended option is covered automatically. This is the same failure shape as the
`{key:"lens"}` positional-index warning in `chart-lens.ts`: registries need tests that
iterate them.
- **Coverage gate RED** (pre-existing): `src/lib/**` 100% threshold missed by
  `in-flight.ts` (94.7%) and `xirr.ts` (89.1%). `pnpm test` runs with coverage and is red;
  `vitest run` is green.
- **Item 13b** — separating pay from non-pay ATM deposits. Owner confirmed the deposits are
  *"mixed — some are pay, some aren't"*, so **projected cash income is an upper bound**
  ($5,127/55d ≈ $651/wk actual vs $1,046 projected). This is a guarded real-DB
  clarification pass in the style of pass 24, not a code change.
- **Phase 2+** of the audit backlog: `docs/review/08-backlog.md` (84 items, 6 phases).

---

## 6. How to work on this repo

### The gate sequence

```bash
node_modules/.bin/tsc --noEmit
node_modules/.bin/vitest run --reporter=dot
node_modules/.bin/next build
node_modules/.bin/playwright test --reporter=line
```

### 🔴 SCREENSHOT EVERY NEW CHART

`/flow` passed `tsc`, **2,113 unit tests and 258 e2e** — and was still **visibly broken**:

- node labels drawn *underneath* the returning arcs (unreadable)
- the chart clipped: a 438px layout inside a fixed 416px container
- the rhythm rail illegible — linear bar heights on data where one month peaks near $98k,
  so every other month collapsed to a 1px sliver
- ~55% of the card's width dead, reintroducing exactly the problem the shell was widened
  to fix

None of that is reachable by any assertion. The layout tests now assert label/lobe/canvas
fit at **320, 375, 440, 768, 1024, 1440, 2560** (RED-verified: restoring the old one-line
label placement fails 7 of them).

Rail bars: scale the **stack** by sqrt, then split proportionally among its edges.
Scaling each segment individually overflows, since `Σ√xᵢ > √Σxᵢ`.

### Traps hit this pass

- **`--reporter=line` is a Playwright reporter, not a vitest one.** vitest dies with
  `Failed to load url line`. Use `--reporter=dot`.
- **`sqlite3 -readonly` fails with error 14** on the real DB when no `-shm` file exists:
  SQLite cannot open a WAL database read-only without being able to create the shm.
  Earlier reads only worked because the dev server was holding it. **Not corruption** —
  verify with `better-sqlite3` read-write plus `integrity_check`.
- **Bash cwd silently drifts worktree → main.** A full `tsc` + `vitest` run passed against
  main's stale copies and looked green. Prefix every command with `cd <worktree> &&` and
  `pwd -P` after git operations.
- **`preview_start` runs in the PRIMARY working directory (main), not the worktree** — so a
  new route 404s until it is merged. It also serves the **real** database and holds it
  open: **stop it before any `--apply`.**
- **Trailing `echo` masks exit codes.** `cmd; echo "EXIT=$?" | tee` reports the *echo's*
  status — a failing e2e run was summarised as "exit code 0". Read the log, not the summary.
- **Never `git add -A`** — `node_modules` and `.env` are symlinks. Add explicit paths.
- **Visual baselines:** never bulk-regenerate. Inspect the diff image, prove every changed
  pixel maps to an intended change, then `--update-snapshots=changed`. This pass: 9
  baselines for the new nav row (diff confirmed confined to the sidebar) and 16 for the new
  `/spending` panel (height 2505 → 2798, no other content moved).

---

## 7. ⚠️ Trust discipline

Pass 25's fact-check found **0 of 8 headline claims survived their original wording**.
That pattern repeated here in miniature — the handoff I inherited said Chase Sapphire
carried **$33,578.97**; measured, it was **$33,893.97**.

**Re-measure every quantity and name the database.** Mechanisms in these docs are almost
always real; the numbers attached to them frequently are not.

**Two databases — do not mix them:**
- DEMO (synthetic): `<worktree>/data/moneyapp.db` — 122 transfer groups
- REAL (his finances): `~/Desktop/Dev/MoneyApp/data/moneyapp.db`

To read the real one, prefer raw `better-sqlite3`. **Never `createDatabase()` against it**
— that runs migrations and writes. To *test* against real data, **copy the file first**
(`+ -wal`/`-shm`) and open the copy; that is how `/flow`'s service was verified, and the
temporary check file was deleted afterwards because it hardcoded a private path and
financial figures.

### Verified TRUE — protect these
- `/flow`'s service reproduces the SQL-measured figures exactly: gross **$330,513.57**,
  net **$234,031.31**, churn **$96,482.26 (29.2%)**, six net positions summing to **$0.00**
  to the cent (pre-write numbers; see §4 for post-write).
- `churn === gross − net === 2 × Σ min(A→B, B→A)`, asserted both ways.
- **Zero** transfer-paired outflows leak into spending, on either database.
- Money reconciles: `categoryBreakdown` == `periodTotals.spentCents` to the cent.

---

## 8. Open questions for the owner

1. **Build the 3D Tower?** It is the last piece of the original brief. Spec and camera
   decisions are settled (§5.1); it is a day of work, not a spike.
2. **Hosting.** Recommendation unchanged: keep SQLite, run it on the Mac, reach it via
   **Tailscale** — $0/month, ~5–7 hours, **zero database rewrite**. The measured
   alternative cost is 211 non-async service functions vs 5 already async, 448 sync call
   sites, and 30+ `db.transaction()` callbacks wrapping the money-mutating paths where a
   missed `await` **silently commits partial state**. Full analysis in
   `docs/hosting-and-auth-plan.md`.
3. **Item 13b** (§5.2) — the ATM-deposit split. Needs his input on which deposits are pay.
