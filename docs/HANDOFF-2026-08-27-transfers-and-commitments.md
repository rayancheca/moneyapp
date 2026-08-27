# Handoff — the transfers are linked, one more insight surface, and why the sweep stopped at five

> **Supersedes `HANDOFF-2026-08-27-insights-everywhere.md`.**
>
> **`main` = `11e8979`**, tree clean, pushed. tsc clean ·
> **212 files / 4,068 unit** · coverage **99.76% stmts, 100% funcs** ·
> `pnpm ledger-check` exit 0 · **E2E_GATE=1: 534 passed** at `maxDiffPixels: 0`.
>
> Live ledger: **10,111 active rows** · income **$117,924.62** and spending
> **$167,828.49**, both unchanged by this session's write · **0 rows flagged for
> review** (was 2) · **9 uncategorized** (was 10) · 38 recurring series.
> `daily_balances` untouched.

---

# ⛔ 0. THE JOB — what is next

1. **PHASE III-B: the sweep is five surfaces in and the remaining seven are NOT
   more of the same.** §3 is the measured survey. Two of them need a
   **provenance kind that does not exist yet**, and the rest would restate
   figures their page already prints. ⛔ Do not work the list mechanically —
   the next real unit of work is the *provenance* question in §3.4, not another
   `*-insights.ts`.
2. **Pass 72d — cost, caching and the kill switch.** Still nothing calls a
   model: every sentence is composed by the app from measured facts. That
   remains the right order, and it means a model can be introduced as a
   SELECTOR over already-true claims rather than as a writer.
3. **Pass 73** (the Robinhood Brokerage arbiter) and **74** as scheduled.
4. **HOSTING goes last** — unchanged. `docs/deploy-plan-gcp-firebase-auth.md`.

---

## 1. ✅ The 21 transfer legs are linked

Owner-approved 2026-08-27: *"link the 20 unambiguous ones plus the wells fargo
trio FOR THE NEXT PASS."* Done — buckets A + B, **21 pairs, $3,839.64, 42 rows**.
Bucket C (4 legs, $1,462.00, two identical rival mirrors each) deliberately
untouched.

The transfers card moved exactly as predicted and nowhere else:

| | before | after |
|---|---|---|
| linked departures | 96 · $67,335.14 | **117 · $71,174.78** |
| unpaired | 47 · $7,644.98 | **26 · $3,805.34** |
| unpaired share | 32.9% | **18.2%** |
| "already sitting opposite an exact-amount row" | 25 · $5,301.64 | **4 · $1,462.00** |

That last row is the whole point: what remains is *exactly* bucket C, and
nothing else.

### ⛔ Every counterpart was NAMED, and the trap was real

`scripts/link-transfers-2026-08-27.ts` carries the 21 pairs as literal ids, and
`assertPlan()` re-derives the own-mirror rule and refuses to run unless it
reproduces that table exactly. Named **and** checked — neither alone is enough.

The brief's warning held up under measurement. Three legs **in scope** have an
income row among their exact mirrors:

| departure | the right leg | the rival `[0]` could have picked |
|---|---|---|
| 2026-02-12 −$201.00 | Chase Zelle arrival | 3× SoFi `Tutoring` deposits |
| 2026-03-04 −$695.03 | Chase Zelle arrival | SoFi **Fordham PAYROLL** |
| 2026-05-13 −$615.13 | Chase Zelle arrival | SoFi **Fordham PAYROLL** |

Only the own-account filter separates them. **18 guards held**: income unchanged
at $117,924.62, spending unchanged at $167,828.49, row sum / row count /
`daily_balances` / every recurring link byte-identical, 1,486 pre-existing links
undisturbed, each group holding exactly two legs summing to zero.

### 🔴 Two things the measurement corrected in the brief's favour

- **The opening deposit is document-provable too.** The brief said only the two
  Zelle REFs were. In fact the Chase leg reads `… CA Card 7782` and the Wells
  Fargo leg reads `… From Card Xxxxxxxxxxxx7782` — the same card number on both
  sides. Three of the 21 rest on a document, not two.
- **The ledger's two review-flagged rows WERE that pair.** The queue went
  **2 → 0** as a side effect. Nobody had connected the two facts.

---

## 2. `/recurring/[id]` — where a commitment sits among the ones still running

The page printed the annualized cost, the cadence, the confidence, the linked
count and the amount history, and never said where the commitment stood. Now:

> Flamingo South Beach (rent) is the largest of your 10 scheduled commitments,
> by what they cost in a year, at **$27,428.40**.
> Flamingo South Beach (rent) is more than half of what your scheduled
> commitments cost in a year, at **68.3%**.

⛔ **The basis is IN the sentence, not beside it.** Rent is $2,285.70 a month and
$27,428.40 a year, and every other figure on that page is per occurrence. "at
$27,428.40" with the basis in a caption would be true of the fact and wrong to a
reader — the shape of the `rose by +$1,185.70` bug over a month he paid LESS. So
the rank fact's own `amongLabel` carries it.

⛔ **Money out and money in are ranked apart.** `annualizedCents` is a MAGNITUDE,
so one sort over both would rank his $54,444/yr cash job above the rent and call
his income the largest thing he pays for.

⛔ **"Your commitments" is the LIVE set, and 23 of his 38 series are not in it**
(11 dismissed, 12 ended). Liveness is decided by the rules the forecast already
owns — status, then `lapsedSeriesShouldStopForecasting` + `seriesHasLapsed` —
never a fresh test. Anything outside the set gets **no strip**, not a last place
and not a 0% share.

⚠️ **`seriesHasLapsed` takes the RAW row, not the `SeriesView`.** A view carries
the effective cadence with the override folded in and `userCadence` gone, and
`seriesStaleness` reads that field to pick which tolerance applies. Rebuilding
an overrides-shaped object from a view silently takes the other branch, so this
page's liveness could disagree with the calendar's — pass 54's "two functions
computing one date".

### 🔴 The route had ZERO pixel coverage, and now has eight baselines

`hydration` and `overflow` both *visit* `/recurring/[id]`; neither photographs
it, so a full rewrite would have moved nothing. Same gap pass 58 found behind
`?tab=calendar`. Shot against **Rent** specifically, because it is the fixture's
largest and therefore exercises both `largest_in_set` and the above-half share.

⚠️ **Those baselines show "no basis yet" badges and the owner will never see
that here.** It is a property of the FIXTURE — its series carry no tagged
postings. On the real ledger all ten live series come back `unverified`,
`manual` or `derived`, every one with a named source
(`scripts/probe-series-provenance.ts`). Verified through his own dev server:
rent's badge reads **"4 different amounts"**.

### 🔴 Two of the seventeen new tests asserted nothing

Mutation testing found both, and **both were redundancy, not test bugs**:

- The row query pre-filtered on status, so deleting the status check in
  `isLive` broke nothing. Fixed by making `isLive` the single decider and
  querying every row — a `where` clause there is a second definition of "still
  running" that *looks* load-bearing and is not.
- `listSeries` already ends its sort with the same name comparison, so the tie
  break here is **unfalsifiable by absence**. Kept anyway, with a comment saying
  so plainly: inheriting a rank's stability from an upstream sort that has no
  reason to keep it fails as a rank that flickers with every test still green.

A third gap was real: **no test checked a SHARE with both sides populated**, so
a denominator that swept income in survived. It does not now.

---

## 3. ⛔ Why the sweep stopped at five — the measured survey

The old brief listed eight remaining surfaces and said "budget one surface per
~30 minutes". That framing is wrong, and the reason is the one
`merchant-insights.ts` already warns about: **most of them are already served.**
Each verdict below is measured, not read off.

### 3.1 Already served — a strip would RESTATE

| surface | what already prints it |
|---|---|
| `/investments/[assetType]/[symbol]` | **`diversityPct` is already on `PositionCard`** — a share-of-portfolio sentence is the exact merchant-insights mistake. Only a bare rank is new, and it is inferable from the share. |
| `/investments` (index) | 4 `SectionNotes` mounts already (`holdingPriceSectionNotes`). |
| `/imports` | dense inline prose per account — "closes to the cent through Aug 3, 2026 (24 days ago)…". Served, just not via `SectionNotes`. |
| dashboard hero | the **12-card deck** IS the insight surface. A strip would compete with it. |

### 3.2 🔴 `/summary/[year]` — the page has NO spending section at all

Measured: every section on that page is money **in** — "What you earned", "What
your investments returned", "Money in that you did not earn", "Money that
passed through". A category-spending ranking would introduce a subject the page
deliberately excludes; ranking the income lines would restate a short sorted
list that is fully printed.

The one genuinely valuable sentence — **year-over-year** — is blocked twice:

- `provenanceFor` has **no kind for "all spending in a window"**;
  `categorySpend` requires a category id.
- ⛔ And the ledger runs **2022-08-25 → 2026-08-24**, so 2022 is missing seven
  months and 2026 is missing four. A naive line would publish *"your spending
  fell by $22,000 between 2025 and 2026"* in August, when four months simply had
  not happened. Only **2025 and 2024** can carry a delta at all.

### 3.3 `/budgets` — real, and not worth what it costs

Budgets are ordered by category, never by amount, so a rank *is* new, and
`totalBudgetedCents` (which excludes overlapping child budgets) is the only
honest denominator. Measured: 12 monthly budgets, **$4,506.29**, Housing
**50.7%**.

But the share is a division of two figures already on the page, and a budget
amount is a **plan he typed**, not a measured sum — so `categorySpend` would
prove the wrong thing and it needs a `budget` provenance kind. **Low value,
core-infrastructure cost. Left alone deliberately.**

### 3.4 ⛔ So the real next unit of work is provenance, not insights

Two surfaces are blocked on the same missing thing: a `FigureRef` for a figure
that is **not a category's sum of rows** —

- **an all-spending-in-a-window total** (unblocks the year-over-year line), and
- **a hand-entered plan** (unblocks `/budgets`).

Both are small and principled: `summedRowsProvenance` already takes an arbitrary
row set, and `recurringSeriesProvenance` already shows how a `manual` verdict
with a `hand-entered` source reads. Do that first and both surfaces become
cheap. Doing them in the other order produces a sentence with a proof that does
not cover it, which is the thing this feature was rebuilt to make impossible.

`/flow` and `/transactions` carry no measured prose at all and remain genuinely
open — but neither has an obvious claim that a chart does not already show, and
the shape of one is the owner's call, not a checklist item.

---

## 4. Notes that keep costing time

- ⚠️ **A green first run on new tests is when to mutate them, not to trust
  them.** 2 of 17 asserted nothing here; the full harness is in the commit body.
- ⚠️ **`pnpm e2e` serves a STALE `.next` — always `e2e:fresh`.** Regeneration
  runs **without** `E2E_GATE=1`; verify with it. Targeting `-g` regenerates only
  the new baselines and leaves every existing one byte-identical (confirmed:
  0 modified).
- ⚠️ **`pnpm test`/playwright output is buffered through `| tail`** — the task
  file stays empty until the run ends. Poll the process, not the file.
- ⚠️ **A probe outside the repo cannot resolve `@/` or `drizzle-orm`.** Put it
  in `scripts/`.
- ⛔ **Measure the FIXTURE before writing an e2e assertion.**
  `scripts/probe-e2e-series-insights.ts` seeds a throwaway e2e DB and prints
  what actually renders — that is how the `toHaveCount(2)` here is a real
  assertion and not a count-agnostic silent pass.
- ⛔ **EMPTY IS NOT A WEAKNESS**, still. Designed in twice more this session: a
  side of one gets no rank (a rank of 1-of-1 is not a ranking), and a
  retired series gets no strip rather than last place.
- The owner runs his own dev server on **:3000 with REAL data** — standing
  permission to stop it; **it was stopped for the write and restarted after**
  (HTTP 200 confirmed).
- Push: `git -c credential.helper='!gh auth git-credential' push origin main`

---

## 5. Still open (unchanged unless noted)

- **The insight sweep** — see §3. The list is shorter and differently shaped
  than the old brief claimed.
- **Pass 72d** — no model is called yet; the vocabulary is ready for one.
- **Discover is missing five statements**, 152 days, named on `/imports`.
- **`docs/income-ground-truth.md:40` still says income ≈ $119,982.68.** The
  measured figure is **$117,924.62**, now stable across eight passes.
- **The merchant map calls his rent "Flamingos Restaurant"**.
- **`/merchants/[id]` and the notices card have no visual baseline.**
  (`/recurring/[id]` no longer belongs on this list.)
- **`notFound()` returns HTTP 200** app-wide from force-dynamic pages.
- **45 `WEIXIN*` rows, $340.00**, deliberately in bare `Shopping`.
- **HBO Max is registered as RENEWING** — one click on `/recurring` ends it if
  it does not auto-renew.
