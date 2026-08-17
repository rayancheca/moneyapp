# Handoff — 2026-08-17, pass 58

> **`main` = `683010c`** plus the coverage commit and this doc, tree clean.
> tsc clean · **163 files / 3,016 unit** · coverage gate exit 0 ·
> `E2E_GATE=1` **428 passed** (415 → 428: +8 baselines, +5 text tests) ·
> **zero baseline churn outside the eight new ones.**
>
> Real-DB write this pass: one deleted anchor. **Gap days 293 → 264** across the
> whole ledger; net worth unchanged.
>
> The pass had one theme, and it was not the one I started with. Pass 57 ended by
> flagging that the recurring calendar had no visual baselines and that closing
> that gap was "the first thing to close next session, before any further
> calendar work". That turned out to be exactly right, and for a reason better
> than bookkeeping: **the moment the calendar had baselines, they immediately
> found three real defects in the calendar pass 57 had already shipped.**

## 0. Read this first

**A route's visual baselines cover the tab they photograph, and no other.**
`visual.spec` shot `/recurring`, which renders the **Upcoming** tab. The Calendar
sub-view lives at `?tab=calendar` and had **no pixel coverage whatsoever** — pass
57 rewrote the entire grid and not one baseline moved. Adding one line to
`ROUTES` fixed it, and **all eight new baselines went red on the very first
change made after adding them**. That is the proof they were missing; look for
the same shape on any route with sub-views in a query param.

**"Does this text fit?" needs three checks, and the obvious one passes when you
make the bug worse.** In order, as they actually happened:

1. `scrollWidth > clientWidth` found all six amounts **ellipsised** at 320px
   under the pass-57 layout — the grid printed `-...` and `3...` where the money
   goes. But delete the `truncate` that causes the ellipsis and the identical
   too-wide text simply **overflows into the neighbouring day**, with
   `scrollWidth === clientWidth` throughout. The check goes green on the worse
   bug.
2. A `getBoundingClientRect` containment check catches that horizontally. It is
   **blind vertically** when the wrapper is `flex-1 min-h-0`: such a box is
   allowed to be shorter than its own children, so its rect stays inside the
   button while the content spills past it. It passed green over a real overflow
   and I nearly accepted it.
3. `scrollHeight > clientHeight` is the one that worked — `13 > 10`, `22 > 10`
   for every cell at 320px.

**A fit test written against the fixture proves the fixture fits.** Having built
the 320px checks above, I then re-read them adversarially and they were still
wrong in a way only the real data shows: the amount format always used one
decimal in the thousands, so the fixture's widest value `-1.8k` (5 chars) passed
— while the largest amount in the owner's actual ledger, **$29,800**, renders
`-29.8k` at six characters and would have overflowed the cell **on his data
only**. The format now spends its decimal solely below $10k, where `1.8k` and
`1.2k` are genuinely different bills, and is bounded to five characters for
anything under $1M. It moved out of the component into `src/lib` to get unit
tests, and the boundaries are the ROUNDED values — otherwise $9,989 becomes
`10.0k` and quietly costs the sixth character back.

**The owner's phone is 440px logical, which is BELOW Tailwind's `sm` (640px).**
The new series names were first written `hidden sm:block`, which would have shown
them on a laptop and hidden them on the device this page is actually read on.
They ship at `min-[400px]:`. Worth auditing other `sm:` gates written with the
word "mobile" in mind.

## 1. Shipped

| # | commit | item |
|---|---|---|
| 1 | `a7044a1` | the calendar gets pixel coverage, and then gets fixed |
| 2 | `683010c` | the stray $0.00 anchor; backlog re-measured |
| 3 | (below) | `brokenSince` — the coverage panel named the wrong day |

### 1.1 The calendar (`a7044a1`)

**Coverage first.** `/recurring?tab=calendar` is now a route in `visual.spec` (8
baselines), plus `e2e/recurring-calendar.spec.ts` asserting the money as TEXT —
because a baseline cannot see a digit (pass 51) and this grid's entire job is to
say how much leaves and when. Five tests: every day's signed total, the footer,
the aria-labels, the 320/440 fit checks, and `paid` — which July 2026 cannot
render at all and is reached by paging back 24 months to the one seeded posting.

⚠️ **What the eight baselines can see is bounded by the seed**, and this is
written into the spec rather than left implicit: July renders `missed` and
`upcoming` only, `paid` is reachable by paging, and **`paid_different` is not
reachable at all** — no seeded posting lands outside its series' tolerance band.

**Then the fixes the coverage found:**

- **320px ellipsised every amount** (§0). Figures sat `justify-between`, glyph
  hard left and amount hard right, leaving ~21px for text needing 30. They sit
  adjacent now and wrap to a second line when they must.
- **Cells overflowed vertically** once the amount wrapped: an `aspect-square` day
  is ~30px at 320 and the content measured 13–22px against a 10px box. Days now
  carry a min-height below `sm`, where a square stops fitting. A calendar cell
  does not have to be square, and under ~48px wide it must not be.
- **The bar scale made three different amounts identical.** Linear with a 0.08
  floor put a $125 meal kit, a $49 gym and a $15.99 subscription **all on the
  floor** against the month's $3,200 heaviest day — a scale whose bottom half is
  a single value is the tick grammar this was meant to replace. It is `√(share)`
  now. That trades exact proportionality for separation at the bottom, and it is
  honest only because the exact figure is printed beside it: the bar answers "is
  this heavy?", the number answers "how much?".
- **The amount took the STATE colour**, so −$1,800 rent and +$3,200 pay — the
  month's two biggest marks, opposite in meaning — drew in the same blue. It
  takes the app's flow colour now, so direction is on the figure and state stays
  on the glyph.
- **The magnitude was a 4px rule pinned to the TOP of a square cell** — about
  25px of content over 75px of nothing at 1024, which is precisely the "it's
  empty" complaint the redesign started from. It is a column standing on the
  cell's bottom edge, so the month reads as a bar chart wrapped by weeks.
- **That column then read as belonging to the row below it**, because a cell has
  no boundary and a bar on the bottom edge sits directly above the next row's
  date. Days with money now carry their own surface — which also answers the
  "empty weeks are dead space" note: a quiet week now reads as quiet rather than
  as a rendering failure.
- **Heavy days name their series.** `dayWeight` returns the dominant entry by
  magnitude (ties keep the first, and the caller has already sorted), so a cell
  says "Rent" instead of making you open it. The spec asserts the name is
  present at 440 **and absent at 320** — without that second half, a
  `min-[400px]:` variant that silently failed to generate would have made every
  fit assertion *easier* and nothing would have noticed.
- **The compact amount format is bounded to five characters** (§0), tested
  against the largest amount the real ledger holds rather than the largest the
  fixture happens to contain.

`CalendarGrid` gained one optional `getCellClassName`, empty by default. It is
shared by **three** surfaces (recurring, `/spending` SpendHeatmap, `/investments`
PnlCalendar) and the full suite confirms the other two are untouched.

### 1.2 The stray anchor (`683010c`) — REAL-DB WRITE

2024-08-14, `source='manual'`, **$0.00**, on Robinhood Cash — between statement
anchors of **$0.04** (07-31) and **$0.06** (08-31), with exactly one transaction
in between: a **+$0.02** dividend on the 15th. So 0.04 → +0.02 → 0.06 closes to
the cent, and the August period was *already graded `reconciled`* on that
arithmetic. The stray row only cut one closing walk into two failing ones.

| | before | after |
|---|---|---|
| gap days (whole ledger) | 293 | **264** |
| RH Cash trusted days | 384 | **413** |
| 2024-08 basis | 29 `gap` | **`anchored=1 derived=30`** |
| every other account | — | byte-identical |

The guard is the part worth keeping: the script **refuses to delete unless the
month closes without the anchor**. Otherwise you are not removing a false break,
you are hiding a real one — which matters immediately, because of §2.

### 1.3 `brokenSince` — the panel named the wrong day

`CoveragePanel` printed, for a `broken` account:

> the balance chain stops closing at **{unverifiedSince}** — **{days.gap}** days
> cannot be trusted

Those are two different populations. `unverifiedSince` is the first
`derived_unverified` **or** `gap` day; `days.gap` counts only the latter. On
Robinhood Cash they are **23 months apart**: it accused **2023-12-05** — merely
where the replay starts, 26 days before the account's first anchor — of being
where 264 gap days that all begin in **2025-11** started. A date and a count in
one sentence, describing different things.

Fixed with a new `brokenSince` (first `gap` day). Two mutations confirmed red,
including the one that reintroduces the exact bug.

⚠️ **The sentence itself is still untested, by construction.** There are **zero
`.test.tsx` files** in this repo, and the e2e seed is gap-free on purpose —
`global-setup` *throws* if a gap period survives. So the `broken` branch of
`detail()` can never render in a test. The unit tests pin the data, not the
pairing. Closing this needs either a component-test setup or a `zz-zz-zz-` spec
that manufactures a gap account and restores it.

## 2. 🔴 The next stray anchor — and why it must NOT be deleted

Walking every consecutive **anchor pair** (a sharper lens than period
reconciliation, which is what found all of this) shows 10 of 33 pairs on
Robinhood Cash fail. They are **three** different problems:

- **near-mirror month-boundary pairs** — −$19.79/+$19.91, −$9.87/+$10.01,
  +$100.03/−$99.98. The settlement-lag story from pass 57, except they are
  *near*, not exact: **12¢, 14¢ and 5¢ of residual survive the mirroring**, so
  pure timing does not explain all of it.
- **two one-cent breaks** (2026-02→03, 2026-03→04) which **alone hold 57 days at
  `gap`**. Probably the cheapest 57 gap days in the ledger to recover.
- 🔴 **a real $231.85 shortfall in 2026-07, disguised as two much larger breaks.**
  A `source='live'` anchor on 2026-07-10 ($7,235.65) sits between two statement
  anchors and splits July into **−$1,420.07** and **+$1,188.22**. Structurally
  the same defect as the one deleted in §1.2 — a non-statement anchor
  contradicting the statement chain — **but deleting it would be wrong**: without
  it the month is still **$231.85** short. It is masking real missing money, not
  manufacturing a fake break. **Find the $231.85 first.**

After §1.2, **all 264 remaining gap days in the entire ledger are on this one
account and every one is 2025-11 or later.** The whole 2023-12 → 2025-10 history
now closes.

## 3. ⛔ A backlog item that should NOT be built

P0.1's "coverage-grading artifact worth its own fix" — re-measured and corrected
in place. It is wrong in its particulars and worthless in its effect:

- the leading `derived_unverified` run is **26 days, not one**;
- the span it supposedly hides is mostly basis **`carried`**, which was never in
  `TRUSTED` and would not have counted as verified regardless;
- and `verifiedThrough` **is not rendered for a `broken` account at all** —
  `CoveragePanel` prints it only in `case "verified"` — while
  `daysSinceVerified` has **no UI consumer anywhere in `src`**.

Visible cost today: zero. The proposed fix would loosen a money-integrity field
so a single fresh anchor could report "verified through today" on an account with
years of holes. If it is ever worth doing, do it for something the UI can show.

## 4. Still open

- ⛔ **His call, carried over from pass 57**: tolerate an explained month-boundary
  settlement difference, or keep the hard line and accept the `broken` grade?
  §2 sharpens it — the residuals are 5–14¢, not zero, so "it's only timing" is
  not quite the whole story.
- **The ForecastCard was not touched.** Pass 57 listed it, but the owner's words
  — *"its empty with ticks and crosses"* — are about the grid, and I judged
  finishing the grid properly worth more than polishing a card he did not
  mention. It is still five equal-weight numbers with no hierarchy.
- **Robinhood Brokerage still has no arbiter** (P0.1). 0 statement periods,
  `market_value` grade, so its reconciliation cannot fail and proves nothing.
  Every one of the 32 statements prints `Portfolio Value`; the parser reads it
  only in the detection gate and throws it away. ⚠️ `Total Market Value` is the
  stock-LENDING subtotal, not securities.
- **`paid_different` has no rendered coverage anywhere** — not a baseline, not a
  text assertion — because no seeded posting lands outside its tolerance band.
- The calendar's **month-shape at a glance** is better (active days are raised)
  but there is still no week-level total; adding one safely needs a decision
  about the `role="grid"` semantics, since an 8th column would break the 7-day
  arrow-key math.

## 5. Notes for the next session

- **`data/` one-shot scripts from this pass** (gitignored): `drop-stray-anchor.ts`
  (with its refuse-unless-it-closes guard), `probe-breaks.ts` (the anchor-pair
  walk that found §2), `probe-coverage.ts`, `probe-runs.ts`, `probe-anchor.ts`.
  The anchor-pair walk is worth promoting to a real `pnpm` check — it found a
  defect the period-level reconciliation could not see.
- **`balance_anchors` has no `asOf` column** — it is `anchored_on`. Drizzle emits
  a silent syntax error (`near ">="`) for an undefined column reference rather
  than a type error, because the column object is `undefined` at runtime.
- The **dev server was not running** for most of this pass, so nothing held the
  real DB. Check before assuming you need to stop it.
- Baselines were regenerated by **deleting** the PNGs first (pass 53's lesson);
  `--update-snapshots` will not refresh a diff that sits inside tolerance.
