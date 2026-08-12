# Handoff — 2026-08-12, pass 46

> **`main` = `76f5c7c`**, pushed, tree clean. tsc clean · **152 files / 2,744 unit** ·
> `next build` clean · **401/401 e2e**. Two migrations' worth of queue cleared: the overdue e2e gap closed, opt-in
> rollover shipped, calendar-month stepping measured and deliberately deferred.
>
> ⛔ **Owner asked for a large feature set mid-pass (§6). Read that before picking anything up.**

## 1. Gate

| gate | result |
|---|---|
| `tsc --noEmit` | clean |
| unit | **152 files / 2,744 tests** (2,712 at pass 45) |
| `next build` | clean |
| `E2E_GATE=1 pnpm e2e:fresh` | **401 passed, 0 failed** (391 at pass 45) |

Restore points: `pre-0012-rollover.db`, `pre-travel-rebudget-2026-08-12.db`.

## 2. 🔴 THE LESSON: a brief that is right about the numbers can still be wrong about the design

Eight agents measured the rollover design and three more tried to refute them. Essentially every
*number* survived — and the load-bearing *design* recommendation was still wrong.

The brief said: switch `pct`, `alert` and `remainingCents` to the rollover-inflated
`availableCents`, but keep `computePace` on the plan amount, so a row that has spent past its plan
still reads "Over budget" rather than being silenced as "Awaiting statements".

Reading `BudgetRow.tsx:72-77` kills that. The headline gates on `status.pace` but computes its
percentage from `status.pct`:

```tsx
status.pace === "over" ? `Over budget by ${Math.round((status.pct - 1) * 100)}%` : …
```

Split the denominators and a row with a carry renders **"Over budget by <1%" while sitting
comfortably under its line** — a contradiction printed on screen. `pace` and `pct` must share a
denominator; they now do.

> **A verified number is not a verified design. The consequence of a recommendation lives in the
> render, and only reading the render finds it.**

Two of the brief's other claims were also wrong in ways that would have cost time, both caught by
reading rather than re-measuring: the "5 or 6 car-insurance payments?" question it flagged as needing
the owner is *already answered* in pass 45 (six total, the first paid on the Venture X, so five
projected — the ledger and memory never disagreed), and the `dataThroughOn` honesty guard it proposed
as load-bearing **cannot fire at all**, because `subtreeDataThrough` (`budgets.ts:667-679`) is an
all-time global `MAX` with no date predicate.

## 3. Shipped

### 3.1 `budgetOverdue` gets a rendered path (`6a87f87`)
Pass 45 shipped it with 3 unit tests and **zero** e2e. Seeded on **Food, not Housing**: Housing is
the `over` row whose verdict already speaks, while Food reads "Awaiting statements" — so this proves
the disclosure survives a row that looks benign, which is the exact failure it exists for (rent
overdue while Housing sat green). The series carries `user_category_id` because it has no postings by
construction — a linked posting inside `toleranceDays` is what "paid" means.

Churn was predicted, then measured: the gate ran **without** `--update-snapshots` first and returned
16 failures, all `budgets-*`/`recurring-*`, exactly as modelled. The regenerated baseline was then
*read* — Food renders `$125.00 expected by now, not imported · Meal Kit Jul 5`, projected `$778.36`.

### 3.2 Opt-in rollover — migration 0012 (`226fc21`)
`rollover_enabled` (default FALSE), `rollover_starts_on`, `rollover_cap_cents`. Applied to the real
ledger and **measured inert**: all 11 budgets off, carry `$0.00`, `available === plan` on every row.

`carryInto` walks CLOSED periods only. Each rule refuses a specific dishonest number, and each has a
test that **fails without it** — the floor and the overdue term were both confirmed by mutation:

| rule | what it refuses |
|---|---|
| floored at zero | Car's $921.38 is lease + insurance **exactly**, so planned surplus is $0.00/mo and a carried deficit would mark it over budget forever |
| partial first period skipped whole | the ten July-16 budgets would bank **$6,522.71** out of 16 days whose measured spend was $276.29 |
| never looks back past `starts_on` | `rollover_starts_on` may only move it LATER; seeding history would credit Car for months with no car |
| minus each period's **overdue** | Housing holds $0.00 spent against **$2,285.70** of rent overdue since 08-08 — banking that credits him for a bill the same row flags in red, then charges it again in September |
| derived at read time | the 08-03 import back-filled **$623.58** into an already-closed July |

**Deliberately NOT moved to `availableCents`:** the one-off threshold (raising it by a carry lets the
$5,000 deposit back into the run-rate and reproduces the **$105,000** projection), and
`totalBudgetedCents` + the expected-income card (a carry is money an *earlier* period brought in, so
it must not inflate "budgeted this month"). Consequence accepted: the section total and the sum of
the rows' "Left" figures no longer reconcile on one screen.

Both surfaces name the line they grade against — `Available $383.00 ($250.00 plan + $133.00 rolled
over)` — because "Budget $250.00 · Left $383.00" is a pair no reader can reconcile.

Fixture: **Utilities** rolls over, the only top-level category with steady spend in both closed
months and no series bound to it, so its carry is pure arithmetic ($56.00 + $77.00 = $133.00).

## 4. ⏸️ Calendar-month stepping — DEFERRED, with a measured deadline

The drift is real and I verified it independently: stepping by `round(intervalDaysAvg)` days, the
lease's 24 payments run `2026-09-11 … 2028-08-01` instead of `… 2028-08-11`. Occurrence **counts**
are identical under both models (24 and 5), so pass 45's verified figures survive the eventual fix.

Deferred because the first consequence any shipped surface could render is **476 days away**:

| series | first month projecting TWO charges | days out |
|---|---|---|
| Flamingo (rent) | 2027-12 (12-01 **and** 12-31) → **$4,571.40** vs a $2,109 budget | **476** |
| FPL, Breezeline | 2028-05 | 628 |
| Car lease/insurance | never — `user_ends_on` cuts the second charge | — |

The longest projection window in the app is 120 days (`recurring-detail.ts:214`), so nothing can
render a double-billed month for another ~356 days. Meanwhile the only *live* money delta the fix
produces today is −$4.99, and that $4.99 is `UBER *ONE` — 443 days stale against a 48.75-day
tolerance. The fix would make a dead subscription look current.

**What a revisit must include, or it makes the bug worse:**
1. The `analyzeGroup` anchor fix (`recurring.ts:186`, `nextExpectedOn: addDays(last.postedOn, …)`)
   **in the same commit**. Under day-stepping a one-day-early anchor is self-correcting noise; under
   calendar stepping it is permanent. ⚠️ `Flamingo (rent)` — the $2,285.70/mo bill — is already at
   `MIN_OCCURRENCES = 3` and is safe today only because its gaps `[0, 22]` give a median of 11 that
   matches no `CADENCE_BUCKETS` entry. That is luck.
2. A **two-sided** cadence guard (veto outside ~`[29, 32]`). The obvious `< 29` guard is one-sided
   and every dangerous row is on the high side — live monthly rows are 30.0–30.69, non-live run to
   **53.25**.
3. `monthly` only. Zero live series are quarterly or annual, and `CADENCE_BUCKETS` admits 85–97 and
   350–380.
4. `rollForwardNextExpected` (`recurring.ts:754-760`) in the same commit, or 5 of 9 live series show
   a next-expected date contradicting their own first projected occurrence.
5. Rewrite `recurring.test.ts:200`, `:593`, `:619`, and **add a ≥24-month projection test** — no test
   in the whole 2,724 projects a monthly series past ~2 months, which is why a one-line change breaks
   only one assertion.

⚠️ **Sequencing:** stepping flips Travel's $4.99 between `overdueCents` and the forward tail. Since
`carryInto` subtracts overdue, shipping stepping later will silently change historical carry
balances for any budget with rollover on.

`src/lib/calendar-math.ts:58` has `addMonths`, but it takes a **`"YYYY-MM"` month key**, not a date —
a date-level month-add with day clamping does **not** exist and will need writing (`dates.ts:50`
`daysInMonth` and `:44` `isLeapYear` are the pieces).

## 5. Travel: a flights budget wearing a travel label (DB-only, no commit)

The owner asked why Travel read so high and whether it was flights. It was:

| | |
|---|---|
| trailing-12 Travel | **$4,092.68** |
| of which `Flights` | **$2,942.44** (72%, 8 charges) |
| July's spike | $2,448.88, of which **$2,374.89** is two tickets (COT\*FLT $1,843.10 on 07-02, Delta $531.79 on 07-01) |
| Travel **excluding** flights | **$1,155.23** over 57 rows = **$96.27/month** |

So `budgetGuidanceCents`' $617.24 was never a travel rate — it was an amortised airfare rate. He is
not flying much now that he has a car, so **Travel = $100.00/month with rollover ON** (his call:
"dealers choice"). That is precisely the case rollover was built for: a low steady number that banks
headroom, so an occasional ticket draws on the carry instead of grading one month as a failure. Carry
reads $0.00 until September. Income unchanged at **$117,915.41**.

⚠️ **Noted, NOT acted on:** 11 `CITY OF MIAMI BEACH` rows totalling **$88.84** sit inside Travel and
look like local parking, which belongs in Transport or Car. Recategorising is his call.

## 6. ⛔ OWNER FEATURE REQUEST — the live queue

Asked verbatim mid-pass:

> "can you make the category cards expandable and editable same with the budget cards. let me move
> them around. add animations and effects. add guidance and tips. add ai insights to every section.
> meaning the investments sections the busgets and categories... every section"

Infrastructure that already exists and **must be reused, not reinvented**:

- **Reorder:** `src/lib/reorder.ts` (`moveItem`, `normalizeOrder`) with two shipped precedents —
  `ArrangeableSections.tsx` (dashboard) and `ManagedAccounts.tsx` (accounts). ⚠️ `categories.sortOrder`
  **already exists** and is read by `listBudgetableCategories`; check whether manual ordering is
  already half-built before adding a parallel mechanism.
- **AI:** `src/services/claude-categorize.ts` is the client pattern (Anthropic SDK, Haiku
  `claude-haiku-4-5-20251001`, zod-validated output, per-call cost logged to `ai_calls`, monthly cap
  in `app_settings`, **fully functional with no API key**). `AI_PURPOSES` already contains an
  **unused `"annotate"`** value — that is the slot for insights.
- **Editing:** `/categories` today is a **list of rows, not cards**, and rename/re-parent deliberately
  live on the category's *own* page (`CategoryManager.tsx:35-45`), so "editable" here means bringing
  those onto the list. `node.isEditable` gates locked categories.

### 6.1 Shipped: /categories rows expand, edit and reorder (`d5707c9`)

Rename inline, re-parent, reorder within the row's own group — all previously off-page. `Disclosure`
is extracted from `InstitutionCard`'s shipped idiom. Reorder writes `sort_order` and renumbers roots
**globally across KIND_ORDER**, because every reader sorts by `sort_order` alone and a per-partition
renumber gives `expense` and `income` both a 0. Up/down buttons, not drag: `dragstart` never fires
from a finger and both existing drag surfaces here are mouse-only.

Two lessons worth keeping:
- **`toHaveCount(0)` cannot assert that collapsed content is unreachable.** Playwright resolves roles
  from the DOM, not the real accessibility tree, so it happily matches controls inside an `inert`
  subtree. Assert `aria-expanded` + `inert` on the region resolved through `aria-controls`.
- **A gate that goes red near your change still needs attribution.** `zz-zz-txn-expander` began
  failing ~3 runs in 4 while passing in isolation. I ran the full suite on **pristine main under the
  same load** (green, 7.6m) before concluding anything — the trigger was mine. The bug was latent: the
  date save's `router.refresh()` replaces the Notes button between locator resolution and click.
  Hardened with a retry, and it fixes a flake that predates this pass.

### 6.2 Shipped: /budgets cards open in place (`ef30b6a`)

A `Details` disclosure per card carrying the settings that are *decisions* rather than *readings* —
the period (newly editable), the graded window stated plainly, and the rollover carry-from date and
cap. The service already accepted both knobs; only `setRolloverSchema` was dropping them.

⛔ **Never emit a button named `"Save"` on /budgets.** `zz-budgets.spec.ts:182,191` click
`getByRole("button", { name: "Save" })` **unscoped**, and `BudgetAmountEditor` is the only match — a
second one is a strict-mode *throw*, not a soft failure. The period is a native `<select>` committing
on change; both text editors commit on blur/Enter.

`useDisclosure`/`DisclosureRegion` were split out (mirroring `usePopover`/`Popover`) because the
trigger belongs in the controls cluster beside Edit and Deactivate — the combined component forced it
onto its own line and orphaned Deactivate above it. `flex-wrap` added to that cluster: it now carries
four controls and 320px is swept for overflow.

The cap test is the one that matters — it sets $100 against the fixture's $133.00 carry and asserts
the row is then graded against **$350.00**, so the cap is proven to *clamp the carry* rather than
merely render.

### 6.3 Shipped: measured section notes (`76f5c7c`) — and 🔴 why the LLM layer is NOT

The model-written version was designed and then **rejected on executed evidence**. Its
anti-fabrication validator was run against 17 adversarial strings and **accepted 16**:

```
"{{f1}} is your largest spending category."   ← f1 is third largest
"{{f1}} has been climbing since July."        ← invented trend and date
"{{f1}} used about ½ of its plan."            ← /\d/ has no `u` flag
```

Root cause: a `Fact` carries only `display: string`. With no machine-readable value **no comparison,
ordering, delta or trend claim can be verified even in principle**, and a denylist of English
quantity words is unwinnable. Slots constrain fabricated **numbers** and say nothing about fabricated
**relationships**. Against the owner's standing *"i dont want you hallucinating"*, that is not
shippable.

What shipped instead — `src/lib/section-notes.ts` — is authored copy selected by a **measured
predicate**, every figure from the app's own formatter, no model in the path. Live on /budgets:

> *One bill totalling $125.00 came due this period and no import has covered it yet — Food. That
> money is committed, so the room left is smaller than it looks.*
> *3 of 4 budgets are grading days the ledger has not reached — up to 8 days on Utilities. Their
> spend and percentages are lower bounds, not measurements, so no verdict is shown for them.*

Both are strictly **cross-row**: each row already discloses its own overdue bill and coverage gap,
and neither can say how much of the page is affected. Each predicate has a test that fails without
it — `over` is exempt from the under-measured count exactly as `BudgetRow` exempts it, an empty page
emits nothing rather than "0 bills came due", and the category note counts **subtree** transactions
so a parent whose children hold 2,066 rows is never called unused.

`RESERVED_NOTE_PHRASES` + a sweep test stops a note repeating a phrase the surrounding UI owns —
`"rolled over"` and `"expected by now, not imported"` are matched by **page-level** e2e locators with
exact counts, so a duplicate breaks an unrelated assertion *and* says the same thing twice.

**To finish the LLM path** (a pass of its own): `Fact.value?: number`; `rank`/`delta`/`trend`/
`projection` kinds gating a relational lexicon; an **allowlisted** prose vocabulary, not a denylist;
NFKC-normalise before scanning; validate on **read** as well as write; and
`delete process.env.ANTHROPIC_API_KEY` in `e2e/global-setup.ts` (playwright.config pins it empty for
the webServer only — the setup process inherits the developer's shell).

## 7. Queue

1. **§6 — what is left of the owner's feature set**, in this order. `/categories` has **zero** visual
   baselines, so prove each mechanism there for free; `/budgets` owns exactly 8 of the 128 PNGs, so
   land all its DOM in ONE commit and regenerate once with one explanation.
   1. **Jargon tooltips** on `/budgets` and `/categories` — the remaining half of "guidance and
      tips". `Tooltip` (`ui/Tooltip.tsx`) is a `"use client"` render-prop component, so a server
      page cannot pass it a function child: split a small client wrapper. Terms worth annotating:
      *Projected*, *expected income*, *overlapping child budgets excluded*, and the kind-group
      headings on /categories. ⚠️ A tooltip body is **live DOM text** (`popover="manual"` renders it
      unconditionally and `getByText` matches `display:none` nodes), so it counts against
      `RESERVED_NOTE_PHRASES` — extend the `section-notes` sweep to cover tooltip copy too.
   2. **`SectionNote` on the remaining sections** — investments, spending, recurring, dashboard. The
      lib and the component are done and mounted on /budgets; each new section needs only a measured
      predicate. `categorySectionNotes` is written and tested but **not yet mounted** (it needs a
      subtree-count source; `listCategoryTree`'s `txnCount` is direct-only by design).
   3. **`/budgets` card reorder.** Blocked on a prerequisite bug: `app/budgets/page.tsx` renders the
      section date range from `formatBounds(section.statuses[0]!)`, so the Monthly header shows Car's
      clamped `Aug 11 – Aug 31` instead of the whole month. Fix that first, then order via a new
      `budgets.display_order` column (NOT `app_settings` — budget ids are random UUIDs, so the
      `z.enum` strictness that makes `dashboardLayout` safe is unavailable and `deactivateBudget`
      would accrete dead UUIDs forever). Cards may never cross a period section.
   4. **Category drag-and-drop** (pointer events, touch-capable). The up/down buttons already cover
      keyboard and touch, so this is polish. Separately: `ManagedAccounts.tsx`'s `touch-none` on an
      `aria-hidden` grip makes a finger landing there unable to scroll `/accounts`.
   5. **Animate the pace-bar refill.** Needs the fill to stop encoding its value as `width` (→
      `clip-path: inset()` at `width:100%`), which is a pixel question against
      `maxDiffPixelRatio: 0.001` — ship it alone and measure. Any WAAPI fallback must read tokens via
      `getComputedStyle` and gate on `usePrefersReducedMotion()`; the CSS reduced-motion guard cannot
      reach `element.animate()` timing.
   6. **Add `/categories` to `visual.spec.ts` ROUTES** (+8 new PNGs) — defensible now that it carries
      real UI, but argue it and commit it alone.
2. **§4 — calendar-month stepping**, with all five prerequisites. ~356 days of runway.
3. **Re-set the remaining stale budgets from data.** Travel is done ($50 → $100). Still stale: Fees
   $30 vs $102.86 measured, Food $1,430 vs $1,990.88, Entertainment $60 vs $123.09.
4. **`budgetOverdue` has no staleness gate** — `UBER *ONE`, dead 443 days, currently fabricates
   $4.99 of "overdue" on Travel. ⚠️ Amazon Prime's $4.99 on Subscriptions is **legitimate**
   (`last_matched_on 2026-07-05`), so a blanket staleness filter would suppress a true one. The
   house-doctrine fix is to *disclose* staleness on the line, not hide the row.
5. **Set `Transport` from data** once two Wells Fargo statements land.
6. **Wells Fargo** — ask for the **QFX** (`ofxProfile` accepts `.qfx`, and it is the only export
   carrying a balance).
7. The pass-42 tail: the last $1,911.24, `ReturnViewParts.tsx:89`, `?range=`, `/flow` range, drawer.
8. ⛔ **Hosting LAST** — "the whole queue first".
