# Adversarial review — skeptic pass

Everything below was verified by reading the cited code in this worktree and by querying
both SQLite files directly (read-only). Where I disagree with an agent I say what is
actually true. Where an agent was right I say so and get out of the way.

**Two facts that reframe the entire report, established before anything else:**

| | worktree `data/moneyapp.db` | main checkout `data/moneyapp.db` |
|---|---|---|
| size | 3.8 MB | 12.8 MB |
| active transactions | 1,673 | 9,688 (+65 excluded) |
| `categorization_source='user'` | **0** | **2,515** |
| merchants | 42 | **843** |
| holding_events | 6 | 1,991 |
| import_files | 256 | 88 |
| accounts | 10 (Chase Total Checking, Chase Savings…) | 9 (Chase Checking, Chase Sapphire, Robinhood Cash…) |
| recurring_series | 31, **all `detected`** | 27 — 4 confirmed, 3 detected, 9 dismissed, 11 ended |
| budgets | 6 | 10 |
| transaction_splits | 0 | **0** |
| institutions | Capital One, Chase, Discover, Robinhood, SoFi | (same 5) |

The worktree DB is a **demo/seed database**. It contains fixture merchants like
*Acme Corp*, *Employer (cash)*, *Westview Apartments*, *Sweetgreen*. Several agents ran
against it, and then narrated its contents as the owner's real financial life.

---

## 1. WRONG OR UNSUPPORTED

### 1.1 [systemic] "MEASURED on the real DB" is not true for a large share of the report

Agents split across two different databases without noticing. The performance agent was
scrupulous — it said *"the 1,673-transaction demo DB (data/moneyapp.db)"* and projected
from there. Most others were not.

Concretely false-as-stated numbers, all traceable to the demo DB or to the memory file
rather than to measurement:

| claim | source | actually |
|---|---|---|
| "434 merchants" (repeated in ~6 findings) | memory file | **843** rows in `merchants` |
| "~1,300 rows he personally categorized" | memory file | **2,515** rows with `source='user'` |
| "31 series, all `status='detected'`… not one has ever been confirmed" (recurring, /recurring, IA) | demo DB | 27 series: 4 confirmed, 3 detected, 9 dismissed, 11 ended |
| "88 file rows" (imports) | real DB ✓ | 88 — **this one is correct** |
| "1,991 holding events" (investments) | real DB ✓ | 1,991 — **correct** |
| "404 review clusters / 404-row backlog" | memory file | `needs_review=1 AND status='active'` is **0** today |

**What is actually true:** the *mechanisms* those agents describe are almost all real —
I verified them in code. The *quantities, dollar figures and merchant names* attached to
them frequently are not. Any finding that leads with a dollar amount should be re-measured
before it is quoted to anyone.

### 1.2 The /recurring "critical" finding narrates demo fixtures as the owner's finances

`src/services/recurring.ts:714-729` (`upcomingOccurrences`) and
`src/services/forecast.ts:126-130` (`fixedComponents`) select on
`status IN ('detected','confirmed')` with **no `isSeriesActive` filter**, while
`src/services/recurring-calendar.ts:154-155` explicitly filters with `isSeriesActive` and
a comment saying why. **The divergence is real and I confirm it.** It is one of the two
best findings in the report.

What is not real: *"Employer (cash) $1,312.88 ×4, Acme Corp (payroll) $2,943.19 ×2,
Sweetgreen, Con Edison… 30-day net reads +$8,588.71 of which $10,934.12 comes from
inactive series… projected income $4,311.57, 98.7% from two dead series."* Those are demo
fixtures. "Acme Corp" is a seed name. On the real DB, 20 of 27 series are already
`dismissed` or `ended` — a status both call sites *do* exclude — so the live blast radius
is the 3 `detected` + 4 `confirmed` series, not 11 of 31.

Keep the finding. Delete every number in it.

### 1.3 The Claude user-guard hole is real but is one row, not a class

`src/services/claude-categorize.ts:264-270` filters only
`normalized_description = ? AND status='active' AND category_id IS NULL`, and is indeed
missing the `or(isNull(source), ne(source,'user'))` guard that its own queue applies at
`:106`. Confirmed.

But the agents rated this **high** on the premise that a population of user-owned
NULL-category rows exists. I checked: `categorization_source='user' AND category_id IS NULL`
returns **1 row** on the real DB and **0** on the demo. Reading `bulk-edit.ts:150-158`,
the only path that writes `source='user'` writes `categoryId` in the same `set` — so the
pairing is structurally hard to break; the one live row is likely an `applyUndoPatch`
artifact (`bulk-edit.ts:212-215` restores `categoryId` and `categorizationSource`
independently).

**The more serious version of the same bug, which nobody stated:** that `.where()` also
omits `merchantId IS NULL`, while the queue at `:104` requires it. So Claude will
overwrite `merchant_id` on rows that already have a merchant assigned — including the
"merchant with a NULL default is a dead end" rows the categorization agent separately
identified. That is the reachable half. Fix the same line; describe it correctly.

### 1.4 "Restoring a quarantined row desyncs the derived cache" — unreachable today

The mechanism checks out: `derivation.ts:228-236` replays
`status IN ('active','excluded')` and excludes `quarantined`; `bulk-edit.ts` never imports
`rebuildAccount`. But:

- the same report states there is **no Restore button** in `BulkActionBar` (`bulk-edit.ts:31`
  defines `restore` in the schema; nothing calls it),
- `setTransactionFlags`'s exclude toggle is bound to `status==='excluded'`, not `quarantined`,
- the real DB has **zero** `quarantined` rows and **zero** periods in `gap`.

Rated **high**. It is a latent hazard worth a guard, not a live defect. Downgrade to low
until a Restore control ships — at which point it becomes high on the same day.

### 1.5 "Mark as transfer leaves the money counted as spending" — true in code, zero wrong numbers live

Confirmed: `bulk-edit.ts:168-173` and `:285-292` set only `transferGroupId`;
`analytics.ts:201-208` (`spendingBucket`) never reads `transferGroupId` and excludes by
category *kind* only. The two paths genuinely differ from `transfer-links.ts:110-118`.

But I checked what the owner's 134 single-leg transfer groups are actually categorized as:

```
Credit Card Payment   107
Investment Contribution 27
```

Both transfer/investment kind. So every one of them is already excluded from spending by
kind, and the defect has produced **no incorrect number** in his live data. It is a
correctness trap for future use, not a current inflation of his spending totals. The
integrity agent's framing ("the owner's spending totals are silently inflated by however
many rows he ever marked this way") is unsupported.

### 1.6 Those 134 single-leg groups are **by design**, not orphans from deletion

The integrity and data-model agents both attribute one-legged `transfer_group_id`s to
`unimportFile`/`deleteManualTransaction` failing to clean up partners, and cite
`schema.md` invariant #6. Read `bulk-edit.ts:170-172`:

```
// mark without a detected pair: a self-group (kept when already
// grouped) — pairing tuning is a later stage, the flag is honest now
set.transferGroupId = ops.transfer === "mark" ? (row.transferGroupId ?? row.id) : null;
```

A single-row transfer mark creates a **self-group of one, deliberately**. 134 of them is
consistent with the owner marking transfers one at a time, not with data corruption. The
delete-orphans-a-partner hazard is still real in code, but it is not what produced the
number, and citing the number as evidence of it is wrong.

### 1.7 "/budgets has ZERO inbound links" — it has one, and the report contradicts itself

`/imports` genuinely has zero inbound links (`grep '"/imports"'` returns only
`nav-items.ts:19`). Confirmed, and it is a strong finding.

`/budgets` has an inbound link at `src/services/category-detail.ts:180` (rendered by
`/categories/[id]`). The IA agent says "ZERO inbound links from any page" in its headline
and "two — nav-items.ts:22 and category-detail.ts:180" three lines later. Use the second.

### 1.8 `src/middleware.ts` is not a defect

Filed as `[broken]` and as a hosting blocker. Read it: it is a deliberate, documented
DNS-rebinding defense for an intentionally unauthenticated loopback server, with the
threat model written in the comment. Calling it "broken" inverts the doctrine. The correct
statement is: **hosting requires replacing this file with real authentication, and nothing
in the repo says so.** That is a docs/roadmap gap, not a bug.

### 1.9 "Backups have never been tested / the safety net is 24 hours stale" — half unsupported

App-level claim is correct: `maybeSnapshot` has exactly one caller (`boot.ts:20`) and
short-circuits when today's daily file exists. Confirmed.

But `data/backups/` in the main checkout contains, alongside the dailies:

```
pre-recategorize-2026-07-13.db   pre-catreview-2026-07-13.db
pre-import-2026-07-15.db         pre-income-fix-2026-07-16.db
pre-clarify-bills-2026-07-18.db  pre-clarify-round1-2026-07-18.db
pre-clarify-mechanical-2026-07-23.db  pre-clarify-robinhood-2026-07-23.db
pre-clarify-uncat-2026-07-23.db
```

Nine pre-mutation snapshots. The ritual exists and runs; it just lives in the owner's
scripts rather than in the product. "The owner has never rehearsed recovery" is an
assertion about a person, made without evidence, and the file listing argues against it.
The real finding is narrower and still worth making: **the app cannot take or restore a
snapshot; only hand-run scripts can.**

### 1.10 Split-related defects are presented as active; the feature has never been used

`transaction_splits` contains **0 rows** on both databases. Every finding of the form
"the Spent card over-counts split rows", "split parts dead-end", "bulk category-set skips
split ids" is currently unobservable. They are correctly *described* — I verified
`transactions-query.ts:58-81` is not split-aware while `:81-107` is — but at least four
agents wrote them in the present tense as things the owner is experiencing. He is not.

The finding nobody made is more interesting: **a feature built over four review passes in
pass 20, with its own doc, has zero adoption.**

### 1.11 Counts that are database-dependent are quoted as constants

"51 closed popovers / 32,557 DOM nodes / 3,350 option nodes on /transactions" —
`Popover.tsx:125` renders `{children}` unconditionally, which I confirm, and
`CommandPalette.tsx:141` does gate on `isOpen`, which I also confirm. But the node count
is a function of `PAGE_SIZE × pickers-per-row × category-count`, and the taxonomy differs
between the two DBs. The mechanism is certain; treat every absolute number in that finding
as "on whichever DB was open."

### 1.12 Minor misreads worth correcting

- **`formatCentsSigned(0)` → `"+$0.00"`** — confirmed at `src/lib/money.ts:79-82`
  (`cents < 0 ? "-" : "+"`). Correct finding.
- **`rebuildAllAccounts` has zero callers** — confirmed (`derivation.ts:260`, no other hit
  in `src/` or `scripts/`). Correct.
- **`deleteManualTransactionAction` has zero callers** — confirmed
  (`cash-actions.ts:38`, no consumer). Correct.
- **`Tooltip` and `Skeleton` have zero consumers; `useFormStatus`/`useActionState` have
  zero usages; no `error.tsx`/`loading.tsx`/`not-found.tsx`/`Suspense` anywhere; no
  `*.test.tsx`** — all five confirmed by grep. Correct.
- **`addHoldingAction` never calls `rebuildAccount`** — confirmed
  (`investments/actions.ts:50-61` calls `upsertHolding` then only `revalidatePath`).
  Correct, and the derived-cache/flow desync follows.
- **`undoAction` validates shape only** — confirmed (`transactions/actions.ts:477-495`
  → `applyUndoPatch`). Correct as a pre-auth design note; it is not exploitable in a
  loopback single-user app, and `middleware.ts` is precisely why.

---

## 2. MISSED

Twenty-seven agents read a great deal of code and ran almost no queries. Here is what fell
through.

### 2.1 Nobody noticed they were auditing a demo database

The single largest blind spot. It is checkable in one command
(`select count(*) from transactions`) and it invalidates or rewrites the numeric half of
at least six surface reports. An audit whose premise is "read real code, cite real lines"
never established which data it was reading.

### 2.2 `todayIso()` uses **server-local** time, and the stated plan is to host it

`src/lib/dates.ts:118-128`:

```ts
const clock = now ?? new Date();
const y = clock.getFullYear(); const m = clock.getMonth()+1; const d = clock.getDate();
```

Local time on whatever machine runs the process. Today that is the owner's Mac in Miami.
Hosted on a free tier, it is **UTC** — so from roughly 7–8 pm ET until midnight, the app
believes it is already tomorrow. Everything keyed on "today" shifts with it:
`resolvePeriod` defaults, `budgetPaceStatuses(todayIso())` period bounds, `isSeriesActive`
grace, `projectOccurrences`' overdue skip, the heatmap's initial month, "Today" labels,
and `daily_balances`' carried tail. On the last evening of a month the entire app rolls
into the next month five hours early.

Not one agent mentioned timezone. It is a correctness bug that only exists in the
deployment the owner explicitly said he wants.

Adjacent, also unmentioned: `MONEYAPP_FAKE_TODAY` (`dates.ts:120-121`) is read in
production code with no environment guard. A stray env var freezes the app's clock
silently — the same class of foot-gun as `MONEYAPP_SKIP_BACKUP`, which one agent did catch.

### 2.3 Nobody ran a single integrity query against real data

Not one finding in 27 reports is of the form "I queried the database and found N violations."
Everything is inferred from code. Five minutes of SQL produced:

- **134 transfer groups with exactly one leg** (107 `Credit Card Payment`, 27
  `Investment Contribution`). Benign for spend totals (§1.5/1.6) but they are exactly what
  `in-flight.transferFloats` pairs on — the in-transit bridge and the dashboard hero's
  `inTransitCents` are computed over a graph where 134 nodes have no partner, and nobody
  checked what that does.
- **1 row with `source='user'` and a NULL category** — the reachability proof for §1.3.
- **0 quarantined rows, 0 `gap` periods, 0 splits, 0 needs-review** — four separate
  "critical" findings whose live instance count is zero.
- **`Robinhood Brokerage` has zero transactions** — so the accounts agent's hypothetical
  ("an account with no active rows has no route to its own ledger",
  `accounts/[id]/page.tsx:195`) is a **live** condition on the owner's real DB today, not
  a scenario. It was filed as a scenario.

A `verifyIntegrity(db)` script should have been the first artifact this review produced.

### 2.4 Nobody ran the gate

"1536 unit tests, 243 e2e tests" appears in the brief and is repeated by agents as
established fact. No agent reports running `pnpm typecheck`, `pnpm test`, or
`pnpm e2e`. Several findings propose changes to files (`Popover.tsx`, `bulk-edit.ts`,
`money.ts`) whose blast radius is only knowable if the suite currently passes. The review
does not know whether the branch is green.

### 2.5 Nobody read `scripts/` or `tests/fixtures/`

`scripts/demo/load-demo.ts` and `scripts/fixtures/generate.ts` are what *produced* the
database most agents measured. The performance agent quoted `load-demo.ts:77` (it prints
per-file import errors that the product hides) — a genuinely good observation — but nobody
audited these as part of the system. They are the only code that exercises
`importStatementFiles` end to end outside a browser, and per the memory file, ad-hoc
scripts in `data/` built the entire 1,991-event equity timeline. That is a first-class
input to the app's data integrity and it was out of scope for all 27 assignments.

### 2.6 The Settings backups list is worktree-relative and nobody checked what that means

`defaultBackupsDir()` resolves from the process cwd. In this worktree, `data/backups/`
does not exist — the nine snapshots live in the main checkout. So `/settings` in a
worktree shows an **empty backups card** with reassuring copy about crash-safe snapshots,
while the real backups sit elsewhere. Two agents wrote at length about the backups card;
neither noticed it reports on a directory that depends on where you launched from.

### 2.7 Currency and locale are hardcoded, and nobody said so

`src/lib/money.ts:68-71` constructs a single `Intl.NumberFormat("en-US", {currency:"USD"})`
module-level constant. `format-date.ts:2` and `calendar-math.ts:26` both deliberately hard-code
en-US month/day names with a comment explaining why (host-locale variance). These are
defensible decisions — but "this app is USD-only and English-only by construction" is a
scope boundary that belongs in a system map, and it appears in none of them.

### 2.8 Nobody executed a cross-surface number comparison

Every "must reconcile" claim in the money-math section is derived by reading two functions
and reasoning about them. Nobody loaded a period and compared the dashboard's spend, the
`/spending` StatCard, the `/budgets` total and the `/transactions` filtered sum for the
same window. The report asserts a reconciliation contract it never tested. Given §1.1,
that gap matters: the numeric claims and the reconciliation claims share a provenance
problem.

### 2.9 Nobody looked for conflicts *between* recommendations

Several proposed fixes fight each other and no agent owned the seam:

- "Add `<Suspense>` islands so the hero paints first" vs "every chart and table must
  reconcile to the same number" — streaming islands will render an aggregate computed at
  T against one computed at T+400ms, on a page whose entire premise is that the numbers
  agree.
- "Wrap the hot readers in React `cache()`" vs "`rebuildAccount` mutates mid-request" —
  memoizing a read across a request that also writes is exactly how a stale aggregate
  ships.
- "Make `unimportFile` soft-delete" vs the partial unique dedupe index
  (`WHERE status != 'superseded'`) — a fourth non-deleted status changes which rows the
  index constrains.
- "Route the range pill through `useViewState`" vs the append-only `LENS_DIMENSION`
  invariant and three call sites that index `SPEC[0]`/`SPEC[1]` positionally.

### 2.10 Nobody costed or sequenced the output

~400 recommendations, no dependency graph, no dedupe. The same three fixes
(`error.tsx`, adopt `Tooltip`, adopt `Skeleton`) appear independently in eight or more
lists as if they were eight pieces of work. The `Popover` one-liner and the
`formatCentsSigned` one-liner are buried at equal weight with "build a WebGL composition
view." A reader cannot tell what to do Monday.

### 2.11 Smaller unowned seams

- **Migration 0004 has no meta snapshot** (flagged by data-model) — nobody ran
  `drizzle-kit generate` to confirm the chain still works. It is a five-second check on a
  claim about future breakage.
- **65 `excluded` rows on the real DB** — in balance replay, out of analytics. Nobody
  asked whether that split matches the owner's intent, or listed what they are.
- **WAL concurrency** — the memory file records "the dev server holds the DB open" as a
  known operational hazard. No agent surfaced what a *hosted* multi-request Node process
  does to a synchronous `better-sqlite3` handle under concurrent writes.
- **README** — a global rule in this environment mandates README standards (live
  screenshots, architecture, technical deep-dive). Nobody audited it.

---

## 3. OVERRATED / UNDERRATED

### Overrated

| finding | filed | should be | why |
|---|---|---|---|
| Quarantined→active cache desync | high | low | No UI path, 0 live rows (§1.4) |
| Claude missing user-guard | high | medium | 1 row; the merchant-clobber half is the real bug (§1.3) |
| "Transfer mark counts as spending" | critical | medium | 0 wrong numbers live; all 134 legs carry transfer-kind categories (§1.5) |
| `undoAction` arbitrary write | high | medium | Correct, but `middleware.ts` is the compensating control today; it is a pre-auth prerequisite, not a live hole |
| recharts ×5 / bundle over budget | critical/high | medium | Owner explicitly deprioritized bundle size; produces no wrong numbers |
| 48% of targets under 44px | critical | high | Real and pervasive, but it is one change to `Button.tsx`'s size map, not a correctness class |
| Archive account changes net worth | critical (×2) | high | Deliberate, pinned by `derivation.test.ts:406`; needs a confirm, not a redesign |
| `middleware.ts` "will 403 everything" | broken | note | Working as designed (§1.8) |
| Split-aware drill-down defects | critical/high | medium | Entirely latent — 0 splits exist (§1.10) |

### Underrated

| finding | filed | should be | why |
|---|---|---|---|
| **Re-parse destroys user attributes** | a RISKS bullet + one import finding | **#1** | 2,515 rows, not 1,300. Triggered by the owner's own stated workflow. Verified: `coveredRanges` filters `importFiles.status IN ('parsed','parsed_with_claude')` (`service.ts:123`), superseded files leave the map, `lowerOwners` is empty, `insertTxn(..., null)` at `service.ts:549`, `migrateSplits` only runs on the takeover branch at `:525`. `docs/schema.md:94-95` promises the opposite. |
| **No error boundary anywhere** | high | **#2** | It is the multiplier. ~15 separate medium findings (bad balance input, Zod out-of-range, expired key, ENOENT in `listBackups`, malformed `app_settings`) are only *full-page outages* because two files don't exist. |
| **`renameSeries` docstring is false** | inside a critical finding | call it out on its own | `recurring-detail.ts:365` says "does not affect grouping". `recurring.ts:408-410` matches merchant-less series on `s.name === normalizedDescription`. In a codebase where comments are load-bearing and correct ~95% of the time, one that actively lies is worse than none. |
| **Chase Checking / Discover: no statement since 2024** | high | **#3** | Verified: `max(period_end)` = 2024-07-11 and 2024-08-18, today 2026-07-27, and `/imports` reports "Open gaps 0" in green. The product's single differentiated claim silently failing on 2 of 9 accounts. |
| **20 of 27 real series render nowhere** | broken/low | high | `AllSeriesView.tsx:16-18` renders only `detected|confirmed`. On the real DB that hides 9 dismissed + 11 ended series — 74% of the owner's recurring model is unreachable except by raw UUID. |
| **`todayIso()` server-local** | not filed | high | §2.2 |
| **`upcomingOccurrences`/`fixedComponents` vs calendar** | critical | keep critical | Independently verified; one of the two best findings in the report. |

### Re-ranked top 15

Ordered by (correctness risk × live reachability) ÷ effort. Everything above the line
changes a number the owner relies on or destroys work he did.

1. **Re-parse silently discards 2,515 hand-categorized rows, their notes, transfer links
   and series links.** `import/service.ts:549` passes `carryFrom: null` on the plain-insert
   branch; `migrateSplits` is inside the takeover branch only.
2. **Add `src/app/error.tsx` + `global-error.tsx` + `not-found.tsx` + `loading.tsx`.**
   Four files. Converts a dozen full-page outages into recoverable cards and is a
   prerequisite for honestly rating anything else.
3. **`upcomingOccurrences` and `forecast.fixedComponents` project dead series while the
   calendar refuses to.** One `isSeriesActive` filter in two places; add a unit test
   asserting the three surfaces agree.
4. **Two accounts have no statement since 2024 and `/imports` reports all-green.** Add
   per-account freshness; this is the product's core claim failing.
5. **`todayIso()` is server-local; hosting makes it UTC.** Pin the app's timezone
   explicitly before deploying, and guard `MONEYAPP_FAKE_TODAY` behind `NODE_ENV`.
6. **Un-import hard-deletes with no confirm, no count, no undo** —
   `import/service.ts:974`, an 8px link at `imports/page.tsx:198`. `transaction_splits`
   cascades with it.
7. **`addHoldingAction` never rebuilds, so a UI-added holding fabricates a return.**
   `investments/actions.ts:50-61`. One `rebuildAccount` call.
8. **Renaming a merchant-less series forks it on the next detection run**, and the
   docstring says it cannot. `recurring-detail.ts:365` vs `recurring.ts:402-410`.
9. **`Popover` renders every closed popover's children.** One line
   (`Popover.tsx:125` → `{open ? children : null}`); the correct pattern is at
   `CommandPalette.tsx:141`. Best value-per-character in the codebase.
10. **`/imports` has zero inbound links** and `/budgets` has one. The two ends of the
    workflow are unreachable from the work.
11. **20 of 27 recurring series are invisible** (`AllSeriesView.tsx:16-18`); dismiss and
    end are one-click and unrecoverable.
12. **Freshness is computed four times and rendered once as a raw ISO string**; five
    components label 8–17-day-old data "today", including a dead ternary at
    `PortfolioStats.tsx:27` that was clearly meant to disclose it.
13. **`Tooltip` and `Skeleton` ship with zero consumers** while 55 `title=` attributes
    carry the app's honesty copy in the one channel that excludes touch and keyboard.
14. **Eighteen `Promise<void>` server actions use throwing `.parse()`** while seven use
    `ActionResult`; the destructive ones are all in the first group.
15. **The mobile nav hides 51% of its destinations and five routes scroll horizontally at
    390px** — the owner's stated primary device. Two CSS changes
    (`minmax(0,1fr)`, `flex-wrap`) plus a `scrollIntoView`.

**Dropped from the top tier:** recharts duplication, tap-target sizing, archive-account
confirm, `undoAction` hardening, and every split-aware fix — all real, none of them
currently producing a wrong number or losing work.

---

## Method note

Verified by reading: `Popover.tsx`, `CommandPalette.tsx`, `money.ts`, `dates.ts`,
`derivation.ts`, `bulk-edit.ts`, `claude-categorize.ts`, `analytics.ts`,
`import/service.ts`, `recurring.ts`, `recurring-calendar.ts`, `recurring-detail.ts`,
`forecast.ts`, `investments/actions.ts`, `transactions/actions.ts`, `middleware.ts`,
`nav-items.ts`, `package.json`. Verified by query: both `moneyapp.db` files and `e2e.db`,
read-only, plus a per-account staleness and transfer-group-cardinality sweep against the
main checkout's real database.
