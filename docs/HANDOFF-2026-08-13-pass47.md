# Handoff — 2026-08-13, pass 47

> **`main` = `4a12d95`**, pushed, tree clean. tsc clean · **153 files / 2,763 unit** ·
> `pnpm test` coverage gate **exit 0** · `next build` clean · targeted e2e green (see §1).
>
> Three commits, all from the owner's §6 feature queue. One deferred item (§5) is deferred for a
> measured honesty reason, not for effort.

## 1. Gate

| gate | result |
|---|---|
| `tsc --noEmit` | clean |
| `pnpm test:fast` | **153 files / 2,763 tests** (152 / 2,744 at pass 46) |
| `pnpm test` (coverage) | **exit 0** — 100% on `src/lib/**` restored, see §4 |
| `next build` | clean |
| e2e (targeted) | 35 (categories-arrange + a11y all routes) · 6 (overflow /categories) · 26 (zz-investments + all 16 investments visual baselines) |

⚠️ The **full** 401-test e2e suite was NOT run this pass. The three routes touched were covered
directly, and both changed surfaces were proven to leave their visual baselines untouched, but a
full `E2E_GATE=1 pnpm e2e:fresh` is still owed before the next push that touches shared UI.

## 2. 🔴 THE LESSON: a probe is worth more than a plan, and it is cheapest *before* you write the line

Three of this pass's decisions were made by running something rather than reasoning, and **two of
the three reversed what I was about to do.**

1. **The `block` class that would have broken every tooltip.** Moving `Tooltip`'s body from `<div>`
   to `<span>` (so it can live inside a `<p>`), I was about to add a `block` utility so the span
   would lay out. A 20-line Chromium probe: with `block`, a **closed** popover computes
   `display: block` — the utility overrides the UA rule that hides it, so every tooltip on the page
   would have been permanently visible. Bare span: closed `none`, open `block`, because
   `position: fixed` blockifies it for free. **The fix was to add nothing.**
2. **The regression test that would have proved nothing.** The obvious test for the /budgets header
   bug is an e2e assertion. No fixture budget is ever clamped, so it renders identically before and
   after the fix — green either way. The test only became real once the derivation was extracted and
   the clamped budget was placed in the position that broke it, and it was **mutation-checked**:
   reverting to `statuses[0].bounds` fails it with `expected { start: '2026-08-11' } to deeply equal
   { start: '2026-08-01' }`.
3. **The coverage gate found three holes that predate this pass** (§4).

> **Corollary worth keeping: "it should work" and "it should fail without the fix" are both claims
> about behaviour, and behaviour is cheap to execute.**

## 3. Shipped

### 3.1 `bfcd974` — a budget section is labelled by its period, not by whichever row sorts first
`page.tsx:153` read each period section's range off `statuses[0].bounds`. A budget created
mid-period is START-clamped, so the section inherited one row's short window. Measured on the real
ledger: the Monthly header read **"Aug 11 – Aug 31"** over eleven budgets, ten graded since Aug 1.
Confirmed twice — by executing `budgetPaceStatuses` against a `.backup` snapshot, and by an agent
serving the page and reading the header out of the HTML (`'MonthlyAug 11 – Aug 31'`).

Two refinements from the refutation pass, both of which argue this is a correctness fix rather than
a symptom chase:
- **It self-heals on 2026-09-01**, when `startsOn` falls before the period start. Live window: 21 days.
- **It is contingent, not absolute.** Rename the category and `statuses[0]` becomes an unclamped
  row — identical code, identical clamp, no visible defect. Only its *visibility* depended on data.

Grouping now lives in `budgetSections(statuses, refDate)` (pure, generic over the status shape).
Zero visual churn, proven by probing the fixture at `MONEYAPP_FAKE_TODAY`.

### 3.2 `31867c5` — /categories kind headings explain what the kind does to the money math
The manager already says the kind "drives the money math" and never says how. Six definitions, one
per group heading, grounded in `analytics.ts`'s stated contract (expense-kind is the only kind
counted as spending and nets refunds against purchases; transfer/investment/rewards/system are held
out entirely). **One tip per GROUP, never per row** — 77 rows of info buttons would cost more in
keyboard traversal than the jargon costs in confusion.

New: `ui/InfoTip.tsx` (client wrapper around the previously-unused `ui/Tooltip`), `lib/jargon.ts`.
`Tooltip`'s body is now a `<span>` (§2). Trigger is a `<button>` with `aria-label`: a bare span never
enters the tab order so the `:focus-visible` handler could never fire, and an icon-only control with
no name is an axe `button-name` CRITICAL on a gated route.

### 3.3 `4a12d95` — /investments says how old the closes behind its figures are
Every active holding still carries its close from **2026-08-06** (7 days) and nothing on a cold load
said so. The page's two existing disclosures answer different questions: `SessionNote` is mounted
only when the range pill is on **1D** (a cold load lands on ALL), and the holdings table discloses
holdings with **no** price. A holding priced a week ago is neither.

**Worse than silent:** `carryForwardTo` appends flat points to today, making the chart's
`endsAtToday` true and planting a **pulsing live dot on 2026-08-13 over a value last measured on the
6th**. The page was asserting currency it did not have. `/accounts` already does the honest version
("Balances as of …"); prices never got it.

⚠️ **The wording turns on min vs max deliberately.** A `max()`-driven *"every position … from
⟨newest⟩"* becomes a FALSE statement about the stalest rows the moment one symbol lags (delisting,
partial backfill, provider gap). When the dates disagree the note anchors on the **oldest** and
changes its opening clause — with a test that fails if it does not. Costs no query: `HoldingRow.quotedOn`
was already computed per row and rendered nowhere. Mounted beside the `ErrorBanner`, **not** inside
`PortfolioChartPanel` — `ChartFocus` renders its panel twice, so a note inside would exist twice in
the DOM. Silent on the fixture (priced through fake-today), so the 16 baselines do not move.

## 4. 🔴 `pnpm test:fast` is not the gate, and pass 46 shipped through the gap

`pnpm test` adds v8 coverage with a **100% statement/branch/function/line threshold on `src/lib/**`**.
`pnpm test:fast` does not. Running the real gate surfaced **three uncovered branches in
`section-notes.ts` that predate this pass**, confirmed against `206a86d`:

| branch | why it was never hit |
|---|---|
| `worst.uncoveredDays === 1 ? "day" : "days"` | no test ever passed `uncoveredDays: 1` |
| `if (live.length === 0) return []` | the only `isArchived: true` case was mixed, never all-archived |
| the worst-gap `reduce` replacement arm | the fixture's worst gap was always the FIRST row |

All three now have tests. **Whatever a handoff's gate table says, ask which command produced it.**

## 5. ⏸️ DEFERRED — `categorySectionNotes` must not ship as written

It is fully written and unit-tested but still **unmounted**, and mounting it as-is would print
something dishonest. Measured on the real ledger, it renders:

> *4 of 77 live categories have never had a transaction in them. Archiving one keeps its id …*

Three of the four are seeded defaults. The fourth is **Car Insurance**, which the owner created
**2026-08-11** and attached a **confirmed −$361.49 recurring series** to (`next_expected_on
2026-09-11`, `user_ends_on 2027-01-11`). That category is not idle, it is **scheduled** — making an
uncharged commitment visible was the entire point of pass 45's `user_category_id` override. The note
would be right about the number and wrong about the person.

**Three fixes required before it mounts:**
1. **Gate on the absence of a recurring series** pointing at the category (via `user_category_id`,
   the same resolution `budgetOverdue` uses). This is the load-bearing one.
2. **Fix the denominator.** "4 of 77" counts *leaves* in the numerator and *every* category in the
   denominator. Either count zero-subtree parents too, or narrow to leaves (**4 of 61**). `Car` is
   one deleted transaction away from exposing this.
3. **Gate on `isEditable`** — the note advertises archiving, and the service refuses it for
   transfer/system/import-hint categories (**6 of 32 unarchivable in the e2e fixture**).

⚠️ Also latent: `hasChildren` from the tree counts **archived** children (`category-edit.ts:478-481`
filters by `parentId` only), so a root whose only child is archived escapes the count forever. Zero
impact today (0 archived rows). And the fixture renders **32 of 67** — eight times louder than the
real ledger's 4 of 77; do not calibrate the copy's tone on it.

## 6. Two findings on /investments I did NOT fix

Both surfaced while verifying §3.3; neither is mine to sneak into an unrelated commit.

1. **`PortfolioStats.tsx:27` is a vestigial no-op:** `Today{overview.dayChangeVsDay ? "" : ""}` —
   **both ternary branches are the empty string.** The label reads "Today" while
   `dayChangeVsDay = "2026-08-05"` and the figure is the 08-05→08-06 move. The one stat that names a
   date-relative concept states the wrong one, and the code to fix it was written and then neutered.
2. **`HoldingRow.quotedOn` is computed per row and rendered nowhere** (`portfolio.ts:536`/`:608`;
   `grep quotedOn src/components src/app` → zero hits before this pass). The per-row price date is
   available for free if the holdings table ever wants it.

## 7. Statement check (owner request, mid-pass)

Owner supplied `~/Downloads/20260802-statements-9805-.pdf` (Sapphire, August). **Already imported —
nothing to do.** `pnpm trial-import` against a throwaway copy: **active 9868 → 9868 (zero rows)**,
net worth **$89,592.26 → $89,592.26, delta $0.00**, Sapphire coverage `verified (2026-08-02)`
unchanged. The archive already holds it as `20260802-statements-9805- (1).pdf` — different sha
(Chase regenerates bytes per download, which is precisely why sha is not a usable duplicate guard)
but identical content. The real DB was opened READONLY and never written.

## 8. Queue

1. **§5 — `categorySectionNotes`**, with all three gates. Do not mount it without the series gate.
2. **§6 — the two /investments defects**, especially the `PortfolioStats` "Today" label.
3. **Tooltips on /budgets.** `InfoTip` and the sweep now exist, and the `<span>` change makes `<p>`
   mounts safe. ⚠️ /budgets is the hostile route: 8 visual baselines, and **~19 phrases asserted by
   exact count**. Proven this pass by execution: a **closed** popover's text IS matched by
   `getByText` and counted by `toHaveCount` (a phrase existing *only* in a closed tooltip resolved
   to 1 for the full timeout); `.first()` does not shield it, scoping does not help, and
   `{exact:true}` is not a workaround. `RESERVED_JARGON_PHRASES` already carries the measured list.
   ⛔ Still never emit a control whose accessible name contains `"Save"` — role-name matching is
   case-insensitive **substring**, so `"Save changes"`/`"Autosave"` collide too.
4. **Run the full `E2E_GATE=1 pnpm e2e:fresh`** — owed from §1.
5. **Calendar-month stepping** (pass 46 §4), ~356 days of runway left.
6. **Re-set stale budgets from data**: Fees $30 vs $102.86, Food $1,430 vs $1,990.88,
   Entertainment $60 vs $123.09.
7. `budgetOverdue` has no staleness gate (`UBER *ONE`, dead 443 days, fabricates $4.99 on Travel).
8. ⛔ **Hosting LAST** — "the whole queue first".

## 9. Note for the next session

Two scouts this pass independently reported "another session is editing this tree," citing a
`scripts/scout-probe-invest.ts` that appeared and vanished. **That was my own investments scout**
writing a probe into the repo and cleaning up after itself. `git status` was clean throughout. A
sub-agent's side effects can look exactly like a concurrent session — check whether the timing
matches your own fan-out before inheriting a phantom into a handoff.
