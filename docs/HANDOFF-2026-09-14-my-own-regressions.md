# Handoff — a Capital One statement, 36 fixes, and three regressions of my own

> `main` pushed. **38 commits since `1e8cc16`.** **4,958 unit** · tsc
> clean · `pnpm ledger-check` matches its baseline · `E2E_GATE=1 pnpm e2e:fresh`:
> **600 passed (8.4m) at `maxDiffPixels: 0`** — after 72 baselines in ten families were cropped, traced to their commits and regenerated (§7b).
> Ledger: **10,274 active rows · 38 uncategorized** (NULL or the system category)
> · net worth **$113,120.59** as of 2026-09-14.
>
> ⛔ **The zero-DB-writes streak ended, on the owner's request.** Two writes: the
> Venture X September statement (§2), then his categories for its 17 new rows
> (§3a). Restore points `data/backups/pre-2026-09-14T125116-manual-backup.db` and
> `…T130654-manual-backup.db`.

---

# ⛔ 0. THE JOB — what is next

1. **§7 is the queue** — 13 open, adversarially-verified findings from the
   invariant hunt, plus second-reader claims whose verifiers died on the session
   limit (unverified, NOT refuted). Verify before fixing.
2. **Run the second reader on whatever you change, before you finish.** It found
   three HIGH regressions in this session's own commits (§4). The hunt found two
   more second surfaces of fixes made hours earlier.

---

## 1. ⭐ WHAT THE SESSION DID

| | |
|---|---|
| §7 queue of the last handoff | **29 fixed, 2 refuted** (#26 mechanism wrong; #29 the deliberate `(imported …)` disambiguator) |
| invariant hunt (10 lenses × 3 refuters, 103 agents) | 31 raised · **16 survived** · 3 fixed this session, 13 queued in §7 |
| second reader on my own 21 commits (8 lenses, 182 agents) | 58 raised · **10 verified real** · all 10 fixed · 48 not verified (78 verifiers died on the session limit) |
| self-directed second surfaces | the chart ghost tooltip, InsightsManager's sliced instant, cards-owed apportionment, the `/categories` index links, e2e specs double-appending a period |
| instrument | `scripts/click-sweep.mjs` — clicks every dialog/popover/tab on a SANDBOX copy of the ledger. 584 triggers, 32 surfaces: **zero nesting errors.** |

The families, in the order they paid:

- **Drill-down contract** — category links dropped the period (195 links); the
  `/categories` index opened September for all 80 rows; the Net card opened 2,682
  rows of the opposite sign (`category=cashflow`); a gross spending bar opened its
  own refunds (`flow=out`, 47 of 2,415 segments); an unlinked merchant row could not
  say "no merchant" (`merchant=none`, 50 of 1,191 rows).
- **A resample read as a fact** — `reindexByPosition` printed the wrong calendar day
  in 610 of 1,539 table cells, summed to a total the prior month never had (33 of
  53 periods), and fed a tooltip. It is deleted; `alignByIndex` is the rule.
- **A missing term** — Earned − Spent ≠ Net on 83 of 1,936 buckets (refunds never
  rendered); the graph re-derived its own Net.
- **Unit and rounding** — best/worst day ranked in dollars, shown in percent (12
  surfaces); `sharePercent` on 8 more sites; apportioned shares (coverage note,
  cards-owed); a clamp printed as `0.0%` over a refunded category.
- **Windows** — the trend ignored the period (480 of 560 pairs); annualized ignored
  a contract's end (Car insurance $4,337.88 → $1,807.45); raw ISO in prose on
  /recurring, /merchants, the dashboard, /summary; a UTC instant sliced and shown
  four hours wrong.
- **Populations** — the heatmap's and the page's "no activity" over 298 rows of
  transfers; "Venture X · 36" beside a debits-only $395.00; the year summary's
  Interest lines pinned by account name, dropping SoFi Checking interest.

## 2. THE STATEMENT — Venture X ····4208, Aug 15 – Sep 13, 2026

Followed the import rules: dropped into `statements/venture-x/`, `pnpm
trial-import` first, then `pnpm import-statements --confirm` behind a restore
point, then `pnpm ledger-check` and `pnpm backup:statements`.

    printed   previous $367.99 − payments $1,960.00 + transactions $2,718.94
              + fees $0.00 + interest $0.00 = new balance $1,126.93
    imported  95 charges $2,718.94 · 1 payment $1,960.00 · deduped 0 · quarantined 0
    period    2026-08-15 → 2026-09-13, opening −$367.99 = August's closing  ✓ reconciled
    coverage  Venture X verified → 2026-09-13
    net worth $113,879.53 → $113,120.59  (−$758.94 = the card's balance change exactly)

The trial and the real import agreed row for row. The $1,960.00 payment's
checking leg arrives with that account's next statement — staleness, not a gap.

## 3. ❓ THE OWNER'S DECISIONS

**(a) CLOSED — the 17 new Venture X rows.** Owner, 2026-09-14: *"topgolf is
entertainment, murphy and 7-eleven are gas, jiu jitsu fitness. i bought a tennis
racket. exotic hub is gas the ai is uncategorised."* The proposed Dining/AMC/IKEA
rows were not contested. Written through `applyCorrection` (source `user`,
confidence 1) by `data/categorize-venturex-2026-09-14.ts`, behind a restore point:

| rows | category |
|---|---|
| Culinary Ventures · 365 Market · Plantabaja · Einstein Bros · Beatrice Pizza · Shake Shack · Chocolate on Tap · IKEA Restaurant | Food › Dining |
| Topgolf ×2 | Entertainment (the parent — his word) |
| AMC | Entertainment › Events |
| Murphy (at Walmart) · 7-Eleven · Exotic Hub | Transport › Gas |
| Jorge Pereira Jiu Jitsu | Health › Fitness |
| LS World Tennis (a racket) | Shopping › General — ⚠️ my placement; Entertainment › Hobbies is the alternative |
| KnockBox AI | uncategorized, deliberately (NULL, source `user`) |

Uncategorized 54 → **38**; net worth, row count and ledger sum unchanged. No
merchant default was learned — none of the rows is linked to a merchant.

**(b) `/categories` index links open `?period=ALL`.** The index counts all time,
and a bare link opened an empty current month on all 80 rows. The hunt REFUTED this
0/3: the anchor wraps the category NAME, not the count, and the destination
explains its empty window in full. Kept, because a link out of an all-time page
carries that page's scope — the same rule applied to /spending. His call if he
prefers the app-wide default. Cost: ~0.14s → ~0.3s per category page.

**(c) Still open from before:** Dismiss posts immediately while End is behind a
blast-radius confirm.

## 4. ⛔ THE REGRESSIONS I CREATED — read before fixing anything like them

Each was found by the second reader on this session's own diff, 3/3, and fixed:

1. **Anchoring the trend on the period (4f13859) made past windows reachable, and
   `reached` checked only the closing frontier.** Result: zeros asserted before the
   ledger opens — 1,040 windows; "No activity in the last 12 months" beside "June
   2021 is before your records begin". And the same commit left the empty sentence
   saying "the last 12 months" under a heading naming another window (802 pages).
   → `categoryMonthlyTrend` REQUIRES `ledgerOpens`; `emptyTrendCopy` names its window.
2. **`projectOccurrences` is inclusive at its far end,** so `[today, today+12mo]`
   billed a monthly series 13 times on its billing day, and a series with no next
   date read "~$0.00/yr". → half-open year; no next date is `null`.
3. **A test I wrote could not fail** — `"ytd"`/`"all"` are not the keys (`YTD`/`ALL`),
   and it compared against the value the code reads.

Two more second surfaces of my own fixes, found by the hunt within hours:
`/spending`'s page-level empty state still said "nothing posted" after the
heatmap's identical sentence was fixed; and the unlinked-merchant fix left a test
red because the commit's tally was never read (§8).

## 5. ✅ CHECKED AND FOUND RIGHT — do not re-litigate

- **Weekly series annualize to 53×** on some days. 52 weeks is 364 days; a
  365-day year starting on a payday holds 53. Arithmetic, not a defect.
- **`/merchants/[id]` and `/budgets` take no period**, so links to them without one
  are correct. `/recurring/<id>`'s category chip carries no figure.
- **`ProvenanceSource.on`** is never rendered.
- **The dialog/popover family is clean** — 584 triggers, zero nesting errors.
- **Refuted by the hunt:** the relief's aggregate ordering; `-0.0%` on the table
  lens; "Cash you can spend today" dates; "6 complete months" on the dashboard;
  the institution card's day change; /summary/2024's dropped negative income row;
  138 provenance badges; 71 Undo buttons; the "What what they cost means" tooltip.
- **Refuted by the second reader:** coverage sentence counting Pass-through;
  `readableDay` losing its fallback; `flowNoun` never passed (deliberate: the
  points are a net); the provenance-disagreement test; annualized's cost.

## 6. INSTRUMENTS AND HOW TO USE THEM

- `node scripts/read-surface.mjs <route>` — still the highest yield per minute.
- `node scripts/click-sweep.mjs [routes]` — **sandbox only**; recipe in its docstring.
- A probe importing `@/` must live INSIDE the repo: name it `zz-*.ts` (ignored).
- Trial every import: `pnpm trial-import statements/<folder>` before `--confirm`.

## 7. ❓ THE QUEUE

**Verified by the invariant hunt, not yet fixed** (votes in brackets):

1. **[MEDIUM 3/3]** `/investments/stock/PM` — "View all 592 PM rows in the ledger":
   401 are Zelle and card payments matching `q=PM`. `HoldingEventsList.tsx:93`.
2. **[MEDIUM 2/3]** Top-merchants rows whose literal anchor is SHORTER than the group
   still over-match (the half `merchant=none` did not close). `spending.ts:709`,
   `/categories/019f4c7d-cc8b-7bd9-88e5-38f31b00988a?period=2026`.
3. **[MEDIUM 3/3]** "new" over a category the same page shows 12 prior transactions
   for. `/spending?from=2024-06-01&to=2024-06-30`, `deviation-layout.ts:139`.
4. **[MEDIUM 3/3]** 56 buttons on one series page share one accessible name.
   `/recurring/019f72da-1fbf-7001-836b-1bc46d632742`, `SeriesMembership.tsx:86`.
5. **[MEDIUM 2/3]** 874 ledger checkboxes share a name with a sibling.
   `/transactions?page=7`, `TransactionsLedger.tsx:388`.
6. **[MEDIUM 3/3]** "none of it reached an account" over paydays nobody has imported.
   `/spending?period=2026-09`, `section-notes.ts:512`.
7. **[MEDIUM 3/3]** The holdings "30d" column spans 43–44 days for 9 of 10 holdings.
   `/investments`, `portfolio.ts:709`.
8. **[MEDIUM 2/3]** "What moved" reports 20 categories rising against a prior window
   with zero rows. `/spending?period=ALL`, `period.ts:284`.
9. **[MEDIUM 3/3]** An ended series WITH a next date still prints a forward annual
   rate above "nothing more is expected from it". `/recurring/01a03972-4df5-7000-b30f-f0fdaeaa18d2`,
   `SeriesDetail.tsx:277`. (c9458a6 closed only the no-next-date case.)
10. **[MEDIUM 3/3]** `/budgets` calls a bill due TODAY "already due".
    `deactivate-radius.ts:47`.
11. **[LOW 3/3]** Dashboard all-time fee total $0.15 short of the Fees category.
    `fees-card.ts:448`.
12. **[LOW 2/3]** 240 provenance triggers whose accessible name has a full stop
    mid-sentence. `/budgets`, `InsightList.tsx:44`.
13. **[LOW 3/3]** "Dismiss" named "Mark X as not recurring" beside its twin.
    `/recurring?tab=all`, `AllSeriesView.tsx:305`.

**Raised by the second reader, verifiers died — UNVERIFIED, not refuted:**

- `?period=ALL` resolves from `ALL_TIME_FLOOR` on `/categories/<id>` (no `earliest`
  passed) but from the ledger's first day on `/spending` — claimed 967 days wider.
- `?period=` is case-sensitive; an unrecognised value silently becomes the current
  month (`?period=all` reads September).
- `sharePercent` on the net-worth bridge's "Share of movement", whose values may be
  signed; `renderPercent` has no rule for a negative.
- A raw ISO date left in a sentence on `/summary/<year>`.
- The graph's ghost tooltip still says "Spent by here" at the point pinned to the
  prior period's whole total (one reading refuted this 0/3).

**Older, still open:** five merchants with returns outside their purchase span;
the rounded staleness tolerance equal to its trigger; six local `plural` copies
(three shapes — two same-named `(n, word)` functions format thousands
differently; neither prints four digits on this ledger today).

## 7b. THE BASELINES THAT MOVED — every one explained before it was regenerated

The first gate ran **532 passed · 68 failed**, all 68 in ten families and none
functional. Each was cropped (`scripts/crop-visual-diffs.py`) and traced to a commit
before `--update-snapshots` touched it, and ONLY those ten families were regenerated:

| family | what changed on screen | commit |
|---|---|---|
| transactions · interaction-states transactions-seeded / bulk-selection | the Category `<select>` is ~48px wider — a native select sizes to its longest option, now "All earning and spending" | d43d718 |
| account-detail | "Investment · brokerage" → "Investment · Brokerage" | b7c8eb5 |
| category | "12-month trend" → "12-month trend · Aug 2025 to Jul 2026" | 4f13859 |
| dashboard-grid | "last seen 2026-06-09" → "last seen Jun 9" | 7e862b6 |
| merchant-detail | "from 2024-07-03 to 2026-07-01" → "of Jul 3, 2024 – Jul 1, 2026" | 7e862b6 |
| summary-year | the money-in coverage heading and sentence; "on Dec 31, 2025 … on Jul 8, 2026" | 7af8c29, 6e87d86 |
| spending | only the faint prior-period ghost line moves — the bars and the Net line are identical | 553c562 |
| series-detail | "Rent is more than half of what your scheduled commitments cost in a year, at 68.9%" → "70.1%" | 9ef8863 |

The series-detail diff was checked to the cent: the fixture seeds a $45/month
series with `userEndsOn` 2026-07-10, before its next billing (08-06). The old rule
counted it 12 × $45; the horizon rule counts nothing. 12 × $2,612.99 = $31,355.88
and $21,600 is 68.9% of it; minus $540 is $30,815.88, of which $21,600 is 70.1%.

⚠️ "Rent is the largest of your 7 scheduled commitments" still counts that ended
series among the seven while it costs $0.00 in the year. A count of commitments,
not of costs — noted, not changed.

## 8. NOTES THAT COST TIME, AND WOULD AGAIN

- ⛔ **`cmd | tail` returns tail's exit code.** A test went red in 52e0a98 and the
  commit ran anyway. `set -o pipefail`, and READ the `Tests` line.
- ⛔ **Never `git add -A` while agents are running in the repo.** Twelve, then two
  more, scratch probes were committed; one broke `tsc`. `.gitignore` now anchors
  `/probe-*`, `/zz*`, `/.p*.ts` at the root — an unanchored `*probe*.ts` would
  have hidden the repo's own `scripts/probe-*.ts`.
- ⛔ **A failed `git add` inside `a && commit` skips that commit silently, and the
  next `git commit` takes the whole staged index.** e2bc00b carries two deletions
  its message does not mention.
- ⛔ **The session limit killed the first hunt outright (zero findings) and 78 of the
  second reader's verifiers.** A workflow's "0 survivors" can mean "0 ran". Read the
  failures list before believing a clean result.
- ⚠️ **My own probes were wrong five times** — wrong signatures (`portfolioReturnDays`,
  `categoryMonthlyTrend`), lower-case period keys, a regex that matched a
  `<select>`'s options instead of the rows, and a `NAMED` list missing a line. Each
  printed a confident zero.
- ⚠️ A transient compile error (a duplicated `const`) served 500s to the hunt's
  agents for a stretch of the dev log; nothing it produced traced to that window.

---

# 📋 THE PROMPT FOR THE NEXT SESSION

> Read `docs/HANDOFF-2026-09-14-my-own-regressions.md` first — it is the brief.
> §0 is the job, §7 is the queue, §4 is the regressions I made and must not make
> again. Repo `/Users/rayankarimcheca/dev/MoneyApp`, `main` clean and pushed.
> Baseline: 4,958 unit · tsc clean · `E2E_GATE=1` 600 passed (8.4m) at
> `maxDiffPixels: 0` · `pnpm ledger-check` matches its baseline.
> Ledger: 10,274 active rows · 38 uncategorized · net worth $113,120.59. The Venture X
> Sep statement and its categories were written on the owner's request; no other
> DB write.
>
> The job is the same: find what is wrong. Do not invent features.
>
> 1. ⭐⭐ **§7 is 13 verified findings plus 5 unverified ones** whose verifiers died on
>    the session limit. Verify before fixing — unverified is not refuted, and it is
>    not confirmed either.
> 2. ⭐⭐ **Start an INVARIANT hunt early**, and READ ITS FAILURES LIST: the first one
>    last session returned "0 survivors" because every agent had died.
> 3. ⭐⭐ **Put a SECOND READER on your own diff before you finish.** It found three
>    HIGH regressions in mine. When a fix widens what a user can steer into — a
>    period, a date range, a scope — re-check every guard written for the narrower
>    domain, at BOTH ends.
> 4. ⛔ `set -o pipefail` on every `vitest | tail`, and read the `Tests` line before
>    committing. ⛔ Never `git add -A` while agents run in the repo.
> 5. ⛔ `pnpm e2e:fresh` needs `.next`, so stop the dev server first — and restart it
>    after. Crop every failed baseline and name its commit before regenerating it.
> 6. Owner decisions open (§3): `/categories` index `?period=ALL` (the hunt refuted
>    it 0/3; kept); Dismiss vs End.
> 7. HOSTING goes last. Never propose a hosted-DB migration.
