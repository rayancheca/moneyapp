# Handoff — start here: the recurring calendar, and pass 66

> **`main` = `4b03d27`**, tree clean, pushed, everything green.
> tsc clean · **181 files / 3,393 unit** · coverage gate exit 0 ·
> `pnpm ledger-check` exit 0 · **E2E_GATE=1 e2e: 458 passed**, zero failed,
> zero flaky, zero skipped.
>
> Nothing is half-built. Passes 63, 64 and 65 all shipped and are reviewed —
> see `HANDOFF-2026-08-24-pass63.md` and `HANDOFF-2026-08-25-passes-64-65.md`.

---

# ⛔ 0. THE JOB THIS SESSION — ULTRATHINK

**The owner's words:**

> *"populate the recurring calendar. i need it to be backfilled from the
> beginning with actual recurring charges. i also want it to think about and
> change the design and ui/ux of that calendar meaning what's displayed in it
> and how. how it shows future confirmed charges vs future unconfirmed. color
> scheme. size. position. think about everything."*

**ULTRATHINK on this before writing a line.** This is a design pass as much as a
data pass, and the owner has asked for judgement, not just execution. Budget real
thinking for the design section (§3) — it is the half most likely to be done
badly by going straight to code.

Read §1 first. **The premise "the calendar is empty because the rows aren't
tagged" is 79% FALSE**, and starting from it would send you at a large, risky
database write to solve a rendering bug.

---

## 1. What is actually wrong — measured 2026-08-25

### 1.1 The calendar draws almost nothing before mid-2026

`recurringCalendar(db, month)` output, real database:

| month | entries drawn |
|---|---|
| 2023-06 | **0** |
| 2024-09 | **0** |
| 2025-01 | **0** |
| 2025-09 | 2 |
| 2026-01 | 2 |
| 2026-07 | 12 |
| 2026-09 | 10 (all upcoming) |

### 1.2 🔴 79% of the missing content is a RENDERING bug, not missing data

`services/recurring-calendar.ts` filters `status IN ('detected','confirmed')`.
So a series that has **ended** is erased from history — including months when it
was demonstrably live and the charges are already tagged.

```
ALL tagged rows:                          274
drawable today (live series only):         57
HIDDEN purely by the status filter:       217  (79%)
```

What is being hidden:

| rows | status | span | series |
|---|---|---|---|
| 60 | ended | 2023-03-06 → 2026-05-21 | **Knack Tutoring** |
| 56 | ended | 2023-11-15 → 2026-05-13 | **Fordham Payroll** |
| 18 | ended | 2024-02-26 → 2025-07-27 | Netflix |
| 13 | dismissed | 2024-10-05 → 2025-01-26 | CC Vending |
| 8 | ended | 2024-08-07 → 2025-03-26 | OpenAI ChatGPT |
| 7 | ended | 2024-08-10 → 2025-02-09 | T-Mobile |
| 7 + 7 | ended | 2024-07 → 2025-08 | YouTube Premium (×2 series) |
| 5 | ended | 2024-10-21 → 2025-03-20 | Extra Space Storage |

Fordham work-study and Knack tutoring **ended** — that is true, and it is why the
series are `ended`. It is not a reason to pretend he was never paid.

> **An `ended` series did not stop having existed.** For a PAST month the
> question is "what was recurring *then*", not "what is recurring *now*".

**Do this first. It needs zero database writes** and multiplies historical
content roughly 5×. Then re-measure §1.1 and see what is genuinely still thin
before considering §1.4.

### 1.3 🔴 The calendar paints MISSED where data is merely absent

`2026-08` renders **6 × missed** with `postedNetCents = $0.00`.

August's statements are not imported yet. Statement staleness is **expected, not
a defect** — it is a standing rule in this project. Those bills were very likely
paid; the ledger simply has not been shown. The calendar states failure from
absence of evidence, which is the exact error this whole program keeps finding.

The app already knows whether a day is covered — `daily_balances.basis`,
`verifiedThrough`, `CoveragePanel`, `statement-cadence`. **The calendar consults
none of it.** A fourth state is needed: *not yet known*, visually distinct from
*missed*, and `missed` should only be claimed where the day is actually covered.

⚠️ Whatever you do here must not make the opposite error either — a genuinely
missed bill on a covered day must still read as missed. Pass 45 found $2,285.70
of overdue rent sitting behind a green budget.

### 1.4 The tagging rate is low — but fix §1.2 before deciding this matters

274 of 10,072 active rows (2.7%) carry a `recurring_series_id`:
2022 0% · 2023 1.5% · 2024 5.2% · 2025 2.4% · 2026 2.7%.

Confirmed series carry almost no history: Flamingo rent **3 rows**, Breezeline 2,
FPL 1, Cash job 2, Car lease/insurance 0 (correct — not started).

⛔ **If you do backfill tags, it is a REAL-DB WRITE and needs the pass-24
playbook**: `.backup` restore point (`VACUUM INTO`), Δ-guards, post-condition
that throws. The guards are unusually clean here because tagging moves no money:

- net worth unchanged
- active row count unchanged
- every row's `category_id` unchanged
- `daily_balances` untouched
- **only** `recurring_series_id` changes, and only from `NULL`

⛔ **Never invent a tag.** Tagging a row is a claim that *this charge is that
series*. Where the match is ambiguous, leave it `NULL`. An untagged row is
honest; a wrongly-tagged one corrupts the calendar, the budgets' tail, the
overdue detector and `/recurring` all at once.

### 1.5 Two series for one landlord

`Hoffman LL` (ended, 1 row) and `DIRECT PAYMENT HOFFMAN LL HOFFMAN LL` (detected,
7 rows) are the same apartment — $1,779.49/month, 2025-06 → 2026-01. The prior
rent, before Miami. A merge candidate; `resolveMergeTarget` already exists.

Also: `YouTube Premium` (ended, 7) and `YOUTUBEPREMIUM` (ended, 7) are the same
subscription under two descriptors.

---

## 2. What the calendar looks like today

`src/services/recurring-calendar.ts` · `src/components/recurring/` · a tab on
`/recurring`.

- Four day-states: `paid` (green ✓), `paid_different` (amber ✓), `upcoming`
  (blue), `missed` (red ✗).
- `classifyPostedAmount` decides paid vs paid_different on the widest of a $1
  floor, 2% of the expected magnitude, and 2σ of the series' own history.
- Posted entries come from `transactions.recurring_series_id`; upcoming and
  missed come from `projectOccurrences`.
- Baselines: `recurring-{light,dark}-{320,768,1024,1440}` — **all 8 are already
  stale** (see §4). They will be regenerated by this work anyway, but the reason
  they drifted still needs explaining before you accept them.

---

## 3. 🎨 The design brief — ULTRATHINK HERE

The owner named the dimensions himself: **what is displayed and how · future
confirmed vs future unconfirmed · colour scheme · size · position · everything.**

Do not treat this as a list to tick. Decide what the calendar is *for*, then let
the answers fall out. Below is what the measurements suggest is at stake — it is
input to your thinking, not a spec.

### 3.1 Confirmed vs unconfirmed future — the owner asked for this explicitly

Today every future occurrence is one state: `upcoming`. But the ledger holds at
least four genuinely different confidences, and they are currently identical on
screen:

| what it is | evidence | example |
|---|---|---|
| `confirmed` series, user-set amount + anchor | **he told the app** | Car lease $559.89 from 2026-09-11 |
| `confirmed`, detected amount | posted history | Flamingo rent $2,285.70 |
| `detected`, unconfirmed | the app inferred it, he has not agreed | PURA VIDA, YA-FIT, Rocket Money |
| live but **evidence stale** | last posting older than its own tolerance | Cash job — 11 silent paydays |

A registered commitment with no postings yet (the car) and a guess the detector
made last week should not look the same. **`seriesStaleness` already computes the
fourth case** and the calendar ignores it.

Think about whether confidence is a *colour*, a *weight*, a *border*, an
*opacity*, a *shape*, or a separate lane — and what that choice does to the
colourblind reader and to print.

### 3.2 Colour now has to carry two dimensions

State (paid / drifted / upcoming / missed / **not-yet-known**) × confidence
(confirmed / detected / stale). Naïvely crossed that is 15 swatches, which is a
rainbow and unreadable.

House doctrine that applies: colour is **semantic, never decorative**; the
letterpress tones (`PLATE` / `LEAF` / `BLANK_LEAF`) already express "how present
is this"; `magnitudeTiers` exists for the size problem below. Consider whether one
dimension should be colour and the other should be something else entirely.

### 3.3 The money on a calendar has the scale problem

Rent $2,285.70 and Uber One $4.99 on the same grid. This is the owner's own
earlier complaint, and `src/lib/magnitude-tiers.ts` was built in pass 62 for
exactly it — with four refusals written into it (no log scale, no minimum-bar
floor, no broken axis, no unlimited magnification). If the redesign draws
magnitude at all, use it. If it draws no magnitude, say so deliberately.

### 3.4 Density, once §1.2 lands

Today's months are nearly empty, so density has never been tested. After the
rendering fix, a month like 2026-04 has 13 tagged rows plus projections, and a
fully backfilled month could hold more. **Design for the populated case**, then
check the sparse one still reads — the current design was only ever seen sparse.

### 3.5 Past and future are different questions

The grid spans both and renders them almost identically. A past day asks *did
this happen?*; a future day asks *is this coming, and how sure are we?*. Whether
one grid should answer both is a real question — a month straddling today
currently mixes four backward states and one forward state with no seam.

### 3.6 Size and position

It is a tab on `/recurring`. Worth asking: is the calendar the *primary* view of
recurring money rather than a tab? Does a compact form belong on the dashboard
(there is a reorderable section system — `DASHBOARD_SECTION_IDS`, and pass 63
added `decisions` to it)? Does a printed month make sense, given `/summary/[year]`
now has a print stylesheet to copy from?

### 3.7 What must remain true

- **Never assert from absence** (§1.3).
- **A figure and the words describing it come from ONE call** — `budgetVerdict`'s
  rule, followed by `runway`, `carCost` and `merchantProfile`.
- Pure geometry and pure decisions go in `src/lib` at **100% branch coverage**;
  the renderer owns colour, weight and order only. `pace-geometry`,
  `waterfall-layout` and `magnitude-tiers` are the precedents.
- Every new day-state needs a **jargon entry** (`RUNWAY_JARGON` is the newest
  example) — and the reflective sweep in `jargon.test.ts` counts the maps, so a
  new map must be registered there or that test fails.

---

## 4. ⚠️ Before you regenerate any baseline: 28 of 139 are already stale

Measured this session with `maxDiffPixelRatio: 0` — and **all 28 are real content
drift**, not antialiasing: every one survives a 1.5px Gaussian blur with hundreds
to thousands of pixels above delta 40.

| cluster | count | diff size |
|---|---|---|
| `recurring` (all 8) | 8 | ~740 px each |
| `transactions` + `transactions-review` | 15 | 674 – 74,972 px |
| `flow-spine` + `flow-tower` | 5 | ~15,700 px each |

**Rendering is deterministic** — I ran three of them twice and the two renders
were byte-identical, so this is stale baselines, not flake. That means a
tolerance fix is safe to apply.

🔴 **But do not blanket-regenerate.** Pass 45's rule: *regenerating a baseline you
cannot explain converts a bug report into a bug.* Each cluster needs one
explanation first. I identified the `recurring` one already: a projected
**"EOM NET WORTH $140,108.07 → $139,056.71"**. The e2e clock is pinned to
`E2E_FAKE_TODAY = 2026-07-08` and the fixture is re-seeded deterministically, so
**something in the code moved that projection** — that is worth understanding
before accepting it.

**The underlying cause** — `maxDiffPixelRatio: 0.001` is 3,813 pixels of
allowance on a 1440×2648 page, and the ratio scales with page height. Recommended
fix: a flat, size-independent **`maxDiffPixels`** floor. It is written up in
`HANDOFF-2026-08-25-passes-64-65.md` §0 and deliberately not applied, because
applying it surfaces all 28 at once — which is the point, and wants its own slice.

**Working practice meanwhile:** after any UI change, temporarily set
`maxDiffPixelRatio: 0`, run the affected specs, restore. Regenerate by
**deleting** the PNGs, and regenerate **all** of a route's baselines, not only
the ones that failed.

---

## 5. The scheduled work — pass 66

`docs/program-passes-60-94.md`: 60, 61, 62a, 62b, 63, 64, 65 are ticked.
**Pass 66** is `src/services/provenance.ts` + the `<ProvenancePopover>`
primitive — "given any rendered figure's identity, return which import file,
which statement period, which arbiter graded it, what basis the day carries".

**Suggested order for this session:**

1. The calendar rendering fix (§1.2) — zero writes, largest effect.
2. The missed-vs-unknown state (§1.3) — the correctness item.
3. The redesign (§3) — the owner's actual ask; ultrathink it.
4. Only then, if still warranted, the tagging backfill (§1.4) — guarded write.
5. Pass 66 if there is room. **The calendar comes first.**

---

## 6. Still open (unchanged)

- **The $560.54 on 2026-07-29** — self-to-self, routing 021000021.
- **Dad's remaining ~$5k** via Arno Search Capital LLC. The pass-through legs do
  **not** cancel: $49,100.00 in vs $28,398.22 out (2025); $75,264.18 vs
  $56,300.00 (2026).
- **59 rows at `needs_review`.**
- **Statement uploads**: Robinhood July + August (no arbiter — pass 73), SoFi
  August. ⚠️ This is why §1.3 matters.
- **69 exact opposite transfer pairs** unlinked; **24 transfer groups with one
  active member**.
- **`user_ends_on` mid-month keeps its full annualised rate** — latent, no
  writer. ⛔ Pass 84's episode editor creates one.
- **Scale**: `/investments` donut, holdings table, `/accounts` — pass 78.
- **Progressive $3.91 gap**: first charge $357.58, registered series $361.49.
- **`notFound()` returns HTTP 200** app-wide from force-dynamic pages.
- **`/summary/[year]` has no visual baseline** — deliberately deferred, because
  the tolerance fix (§4) will regenerate baselines anyway and doing it now means
  doing it twice.
- **Merchant page ships year bars, not the ScrubChart kit.**

---

## 7. Notes that keep costing time if forgotten

- ⚠️ **`Desktop/` is iCloud-synced** — makes `"… 2.png"` conflict copies during
  rapid baseline regeneration. `git status --porcelain` before believing a tree.
- ⚠️ **The Bash tool's cwd persists across calls.** A stray `cd` makes later
  relative paths silently resolve nowhere — a `find` and a python glob both
  reported "nothing found" rather than failing.
- ⚠️ **Never pipe a gate run through `tail`.** One run read "430 passed" in 1.5h
  (normal 6.5m) under load 9.24 and the truncated log could not distinguish a
  regression from machine contention. Capture the whole log, count `✓`/`✘`.
- ⚠️ **`aliasedTable` self-joins break drizzle's row inference** — rows type as
  `never` while working at runtime, so `tsc` fails and the tests pass. Use
  `loadCategoryIndex` for category rollups.
- ⚠️ **`tsc` catches what green tests do not** — `EmptyState` takes
  `description`; `"imported"` is not a valid `importFiles.status`.
- ⚠️ **`seedDatabase` predates several categories** the newer pages read —
  Tutoring, Financial Aid, Family pass-through, Gambling, Car. Create them in
  tests; skipping the case passes on a DB where the feature cannot work.
- ⚠️ **The app themes on a `.dark` CLASS**, not `prefers-color-scheme` —
  Playwright's `colorScheme` alone produces a byte-identical "dark" shot.
- ⚠️ **The Browser pane screenshots blank for this app** (the DOM reads fine via
  `javascript_tool`). Use Playwright for anything visual.
- ⚠️ **The owner runs his own dev server on :3000** — do not kill it, curl it.
  `.claude/launch.json` uses :3111.
- The overflow sweep's route-coverage guard fires on any new `page.tsx`.
- `data/app.db` is a 0-byte stub; the real database is **`data/moneyapp.db`**.
- Push: `git -c credential.helper='!gh auth git-credential' push origin main`
