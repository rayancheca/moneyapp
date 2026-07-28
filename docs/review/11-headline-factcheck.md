# Headline claims — fact-check

Eight headline claims from the 2026-07-27 adversarial review, re-measured from scratch.

**Method.** Every number below was produced by opening a database with raw `better-sqlite3` in
`{ readonly: true }` (never `src/db/client.ts`, which runs migrations), or by reading the cited
source, or by serving the actual page and counting bytes. Scratch scripts were deleted; the working
tree is clean. Two databases exist and the review mixed them repeatedly, so **every figure below is
labelled with the database it came from**:

- **REAL** — `/Users/rayankarimcheca/Desktop/Dev/MoneyApp/data/moneyapp.db` (his actual finances;
  9,688 active + 65 excluded transactions, 843 merchants, 88 import files, 73 live categories)
- **DEMO** — `.claude/worktrees/app-polish-adversarial-review-e80abb/data/moneyapp.db` (synthetic
  fixtures; 1,673 active transactions, 42 merchants, 67 live categories, **zero** user-categorized rows)

The single most common failure in the review is quoting a DEMO number as if it described his money,
or splicing one number from each database into a single sentence.

---

## Verdict table

| # | Claim (abbreviated) | Verdict | Measured reality | Corrected severity |
|---|---|---|---|---|
| 1 | Un-import is 8px grey text, hard-deletes 2,149 rows incl. ~1,300 hand-categorized, no confirm, no snapshot | **PARTLY-TRUE** | 12px AA-contrast text, not 8px. 2,149 rows is right (REAL, worst of 88 files) but only **103** are hand-categorized, not ~1,300. No confirm/no snapshot: true. Source file survives on disk → raw rows recoverable | medium |
| 2 | Re-import at a new parser version destroys every category, note, transfer link and split; docs promise the opposite; zero tests | **TRUE-BUT-OVERSTATED** | Mechanism real (`carryFrom = null`). But REAL: **0 notes at risk** (all 172 are on manual rows), **0 splits at risk** (table empty), 2,450 categories + 1,059 transfer links at risk. Currently **dormant** — 0 stale files. Zero test coverage: confirmed | high |
| 3 | The only backup can't be restored in-app; mis-sort hides 12 of 14 dailies | **PARTLY-TRUE** | Restore: fully true, no restore/download exists anywhere. Sort: **worse than claimed and for a different reason** — all **14 of 14** dailies and the 1 monthly are hidden; all 8 visible rows are `pre-*`. "The only backup" is false: 46 snapshots exist | medium |
| 4 | A payroll series 80 days stale projects +$5,886 phantom income, flips the Forecast headline, Calendar won't draw it | **PARTLY-TRUE** | Gate divergence is real. But the 80-day payroll is a **DEMO fixture**, not his data. $5,886 is the 30-day window; the Forecast card gets **half**. It flips **no** headline on either DB. On REAL the Calendar **does** draw the series. **The prescribed fix is backwards** | medium |
| 5 | 330 of 627 merchant drill-downs open an empty ledger, $34,403.46 unreachable | **TRUE-BUT-OVERSTATED** | Reproduces (REAL). But 627 is the *unlinked* subset — over all 1,292 groups it is 25.5%. **0 of 665** merchant-linked drill-downs broken. Nothing is unreachable; only the link is dead. User-visible: ~6 of 96 rendered rows | medium |
| 6 | 95% of /transactions HTML is invisible closed listboxes — 4.65 MB, 32,557 nodes — one line in Popover.tsx | **CONFIRMED** | Verified by serving the page and by applying the fix. DEMO 4,173,711 → **295,254 bytes**, 32,568 → **1,532 elements**. But the two headline numbers come from *different* databases, and the one-liner **silently breaks keyboard focus** | high |
| 7 | $93,004.29 across 47% of the ledger has no surface anywhere, incl. $46,928 of gifts and 250 unpaired legs | **PARTLY-TRUE** | Every figure reproduces **to the cent** (REAL). But "no surface anywhere" is false — the rows are in the default ledger, the Category filter, ⌘K, `/categories/[id]`, every account ledger, and inside the net-worth curve. What's missing is the **roll-up and reconciliation** | medium |
| 8 | The honesty vocabulary rides on `title=`, which touch never fires, while a complete Tooltip has zero importers | **TRUE-BUT-OVERSTATED** | Tooltip zero importers: confirmed repo-wide. But only **22** of the 55 `title=` hits are DOM attributes — 33 are `<Sheet>`/`<PageHeader>` props rendering **visible headings**. Two cited line numbers are wrong; two headline examples don't fire on his data | medium |

---

## 1 — The un-import link

**Verdict: PARTLY-TRUE.** The dangerous part is real. The two numbers that made it sound catastrophic
are both wrong.

### Corrected wording

> The un-import control (`src/app/imports/page.tsx:196`) is a 12px muted-but-AA-contrast text button
> (`text-xs text-ink-faint`, red on hover), and a single click fires a server action that hard-deletes
> every transaction, balance anchor and statement period owned by that file inside one transaction
> (`src/services/import/service.ts:962`) — with no confirmation dialog, no undo and no snapshot, even
> though the app already has undo-toast infrastructure used by every other destructive mutation.
> On the REAL database the worst-case click destroys **2,149 transactions** (the largest of 88 import
> files), of which **103 — not ~1,300 — are hand-categorized**. The file whose loss would cost the
> most manual work is `Chase3522_Activity_20260710.CSV` at **644 user-categorized rows of 1,114**.
> The archived source file is left on disk, so the raw rows can be recovered by re-uploading; the
> per-row hand categorization cannot.

### Evidence

Read `src/app/imports/page.tsx:194-206` — a bare server-action `<form>` with a `type="submit"` button,
in a server component with no `confirm()`, no dialog, no two-step. `src/app/imports/actions.ts:23`
calls `unimportFile()` with no guard. `src/services/import/service.ts:962-987` issues
`tx.delete(transactions)` plus deletes of `balanceAnchors`, `statementPeriods` and the `importFiles`
row. No backup is written and there is no soft-delete — rows are physically gone.

Measured on REAL (`readonly: true`), per-file counts grouped by `import_file_id`:

| File | rows | `source='user'` |
|---|---|---|
| `19f645c5-…(1).csv` (robinhood-activity-csv v2) | **2,149** | **103** |
| `Spending Report PDF.pdf` | 1,273 | 3 |
| `Chase3522_Activity_20260710.CSV` (chase-deposit-csv v2) | 1,114 | **644** |

DB-wide `categorization_source='user'` = **2,515** of 9,753. On DEMO it is **0**.

### What was wrong, and why

**"8px grey text."** Tailwind v4's `--text-xs` is `0.75rem` and there is no root font-size override in
`src/`, so `text-xs` is **12px**. No `8px` text size exists anywhere in the codebase. `--ink-faint` is
annotated in `globals.css:15` as meeting WCAG AA on all three surfaces. This looks like the number was
eyeballed from a screenshot rather than resolved through the token.

**"~1,300 hand-categorized."** This matches nothing in either database — not the 103 on that file, not
the 644 maximum, not the 2,515 DB-wide total, and not DEMO's zero. It appears to be a half-remembered
version of the stale-memory figure the skeptic already caught.

**Omitted mitigation.** `unimportFile` makes no filesystem calls, so the archived source CSV survives.
That materially changes the recovery story and should have been stated.

---

## 2 — Re-parse drops user-owned row state

**Verdict: TRUE-BUT-OVERSTATED.** The bug is real, the doc contradiction is real, and the fix is
nearly free. The blast radius was inflated by naming two categories of data that are at **zero** risk.

### Corrected wording

> When a file is re-uploaded after its parser profile's `version` is bumped, `service.ts:404`
> soft-supersedes the old file's entire contribution and `service.ts:549` inserts the replacement rows
> with `carryFrom = null`, so the replacements carry no category, `categorizationSource`, notes,
> `transferGroupId` or `recurringSeriesId`, and any splits stay stranded on the superseded parent.
> Nothing is deleted — old rows survive at `status='superseded'`, recoverable only by hand-written SQL.
> `docs/schema.md:90-93` promises the opposite in writing. The fix is nearly free: `insertTxn` already
> accepts a `carryFrom` argument that migrates exactly those four fields, and `migrateSplits` already
> exists — both are wired only to the cross-format takeover branch and never to the re-parse branch.
>
> On the REAL database: **0 notes at risk** (all 172 non-empty notes are on manual rows, which
> re-parse never touches), **0 splits at risk** (`transaction_splits` is empty), **2,450**
> user-categorized rows at risk, **1,059** transfer links at risk. `categorizeAll()` re-runs after
> import, but of those 2,450 rows only 83 have a merchant default matching the user's own choice, 737
> have one that **disagrees** (silently re-categorized wrong), and 1,630 have no merchant at all.
>
> The path is currently **dormant** — 0 import files on either database are stale against the shipped
> profile versions, so re-uploading anything today is a safe `skipped_duplicate`. It arms the moment a
> profile version ships, and version bumps are live practice here (three profiles are already at v2).
>
> A second failure mode the review missed: the supersede at `:404` happens **before** `parse()` at
> `:451` and in a separate transaction, so a new-version parser that throws leaves the file's
> contribution superseded with **no replacement at all**. That breaks the doc's "one synchronous
> transaction" wording outright.

### Evidence

Measured on REAL: 172 non-empty notes, all with `import_file_id IS NULL`; `transaction_splits` count
= 0; 2,450 rows with `categorization_source='user' AND status='active' AND import_file_id IS NOT NULL`;
1,166 active transfer-linked rows of which 1,059 are imported. Test coverage: `parserVersion` /
`parser_version` appears in schema, migrations and `service.ts` only — in **no test file** repo-wide.

Realistic worst case on his data: one re-upload of `Chase3522_Activity_20260710.CSV` after a
`chase-deposit-csv` v3 ships silently blanks **644 hand-made categorizations**, 81 transfer links and
38 recurring links across 1,114 rows, with no counter in `FileOutcome` reporting the loss.

### What was wrong, and why

"Every category, note, transfer link and split" reads as four equally-loaded barrels. Two are empty on
his data. Listing at-risk field *types* from the code without checking whether those columns are
populated is exactly the failure mode this fact-check exists to catch. The severity stays **high**
anyway — because of the dormant-but-arming property and the parse-throw hole, not because of notes.

---

## 3 — Backups can't be restored, and the list is mis-sorted

**Verdict: PARTLY-TRUE.** The restore half is completely true. The sort half is true in effect but the
review got the mechanism wrong, the number wrong, and understated the damage.

### Corrected wording

> The app can take snapshots but has no way to use one: `src/db/backup.ts` exports only
> `maybeSnapshot` — no restore or download function exists anywhere in the repo, there are no API
> route handlers (`src/app/api` does not exist), and the Backups card
> (`src/app/settings/page.tsx:121-128`) is a non-interactive filename+size list.
>
> Separately, `listBackups` (`page.tsx:22-24`) sorts whole filenames lexicographically and reverses,
> so the name **prefix** outranks the date (`pre-` > `monthly-` > `daily-`) before `.slice(0,8)`
> truncates. On his real archive (46 `.db` files: 14 daily, 1 monthly, 31 manual `pre-*`) **all 14
> dailies and the single monthly are hidden**, and every one of the 8 visible rows is a manual `pre-*`
> script snapshot in reverse-alphabetical order. Today's snapshot ranks **33rd**.

### Evidence

I re-ran `listBackups()` verbatim against the real archive. The 8 rows it returns:

```
pre-stage4a-20260710-200637.db      pre-recategorize-2026-07-13.db
pre-stage3-backfill-2026-07-11.db   pre-mark-reviewed-2026-07-18.db
pre-sofi-replace-2026-07-13.db      pre-income-fix-2026-07-16.db
pre-rh-cash-2026-07-17.db           pre-inbox-import-2026-07-13.db
```

Hidden dailies: **14 of 14**. Hidden monthlies: **1 of 1**. Rank of `daily-2026-07-27.db`: **33**.
`grep -n "^export" src/db/backup.ts` returns only `RetentionPolicy`, `DEFAULT_RETENTION`,
`SnapshotResult`, `maybeSnapshot`. A repo-wide grep for "restore" finds only rules/splits/account/focus
restore — never a DB restore.

### What was wrong, and why

**"12 of 14."** That is arithmetic off the `DEFAULT_RETENTION` constants at `backup.ts:20`
(`keepDaily: 14, keepMonthly: 6`), assuming a steady-state archive that has never existed. It is not a
measurement of either database. The review reasoned from the retention *policy* instead of reading the
*directory*.

**Wrong mechanism.** The review considered only `daily-` vs `monthly-`, ignoring the 31 `pre-*` files
that its own §B15 documents. Those are what actually fill all 8 slots.

**"6 monthlies."** Only **1** exists — the app has only ever run within July 2026.

**"The only backup."** 46 snapshots exist and the daily job has run every day the app started
(`daily-2026-07-10` through `daily-2026-07-27`).

---

## 4 — The stale payroll series

**Verdict: PARTLY-TRUE — and the prescribed fix is pointed the wrong way on his real data.** This is
the most consequential correction in this document.

### Corrected wording

> Recurring series are gated inconsistently across three surfaces: `forecast.fixedComponents`
> (`forecast.ts:130`) and `upcomingOccurrences` (`recurring.ts:719-723`) filter on
> `status IN ('detected','confirmed')` only, while `recurringCalendar` (`recurring-calendar.ts:155`)
> additionally requires `isSeriesActive`. A stale series therefore projects into the Forecast card and
> the Upcoming tab but is missing from the Calendar's expected occurrences.
>
> On the **DEMO fixture**, "Acme Corp (payroll)" (last matched 2026-05-08 — 80 days, biweekly) adds
> $5,886.38 to the 30-day Upcoming window but only **$2,943.19** to the current-month Forecast card,
> and is absent from the July Calendar. Removing it alone leaves the Forecast headline **positive**
> (+$4,063.52 → +$1,120.33), so it does not flip the sign.
>
> On the **REAL** database there is no 80-day payroll series at all. The analogous one is "Cash job
> (weekly pay)" (confirmed, weekly, last matched 2026-07-06 — 21 days), which adds **$1,046.00** to
> the Forecast card and $4,184.00 to the 30-day window. The real Forecast headline is −$431.36 and
> stays negative (−$1,477.36) without it. And the Calendar **does** draw the series — only its forward
> projection is suppressed.
>
> **Critically: the REAL database's newest transaction of any kind is 2026-07-14, so the 21-day
> staleness is import lag against a live income stream, not a dead one.** Adding `isSeriesActive` to
> the forecast would suppress genuinely ongoing income on his real data. The safer fix is to make the
> Calendar project what the Forecast projects, or to surface staleness in the UI — not the reverse.

### Evidence

Code read confirms the three-surface divergence exactly as described: `forecast.ts:126-131` selects
`inArray(recurringSeries.status, ["detected","confirmed"])` and never calls `isSeriesActive`;
`recurring.ts:713-723` uses the same status-only gate; `recurring-calendar.ts:155` does
`if (!isSeriesActive(s, today)) continue`.

Measured series (today = 2026-07-27, `isSeriesActive` threshold = `step × 1.5 + tolerance`):

| DB | Series | Status | Cadence | Last matched | Stale | Active? | Amount |
|---|---|---|---|---|---|---|---|
| DEMO | Acme Corp (payroll) | detected | biweekly | 2026-05-08 | **80d** | no (thr 24.0) | $2,943.19 |
| REAL | Cash job (weekly pay) | confirmed | weekly | 2026-07-06 | **21d** | no (thr 12.5) | $1,046.00 |
| REAL | UBER *ONE | detected | monthly | 2025-05-25 | 428d | no | −$4.99 |
| REAL | Rocket Money | detected | monthly | 2026-05-19 | 69d | no | −$6.00 |

REAL `MAX(posted_on)` on active rows = **2026-07-14**; max positive-amount row = 2026-07-07. The real
stale-*spend* leak is **−$10.99/cycle** across two subscriptions, consistent with what was already
established. Both "does not flip" arithmetic checks are internally exact: 4,063.52 − 2,943.19 =
1,120.33, and −431.36 − 1,046.00 = −1,477.36.

### What was wrong, and why

**"On the real DB 'Acme Corp (payroll)'."** Acme is a synthetic fixture. It does not exist in his data.
This is the review's signature error — a DEMO series presented as his payroll.

**"+$5,886 … and flips the Forecast card's sign."** Two different windows were welded together. $5,886
is the 30-day *Upcoming* total; the *Forecast card* gets one occurrence, $2,943.19. And nothing flips:
the demo headline stays positive without Acme, and the real headline stays negative without the cash
job. Flipping the demo would take the whole stale cohort, not one series.

**"The Calendar refuses to draw it."** False on REAL — the Calendar renders the posted 2026-07-06
charge (`paid_different`, $150.00). Only the forward projection is omitted.

**The recommendation is actively harmful.** Backlog #13 says to add `isSeriesActive` to the forecast.
On his real data that deletes $1,046/week of income he is genuinely still earning, because the series
looks stale only due to a 13-day import gap. This is the one item where shipping the review's fix
makes his numbers *worse*.

---

## 5 — Dead merchant drill-downs

**Verdict: TRUE-BUT-OVERSTATED.** Real bug, correctly located, dollars roughly right. "Unreachable"
is the wrong word and the denominator is misleading.

### Corrected wording

> On the REAL database, the Top-Merchants card's **by-name (unlinked)** groups have broken
> drill-downs: ~330 of the ~627 stripped-key groups link to a `/transactions?q=<label>` search
> returning zero rows, covering ~$34.4k of spending. **Merchant-linked drill-downs are fine — 0 of 665
> merchant-kind entries and 0 of 843 merchant detail pages are affected**, because those filter on
> `merchant_id`.
>
> The cause is `spending.ts:685-687`: an unlinked group's href reuses
> `humanizeDescriptionKey(strippedDescriptionKey(...))` as a `q=` substring search, but
> `strippedDescriptionKey` deletes volatile tokens from the **middle** of the descriptor and re-joins
> survivors with single spaces, so the label is no longer a contiguous substring of any
> `raw_description` and the `LIKE '%q%'` filter matches nothing.
>
> **No money is missing or unreachable** — these rows still appear in `/transactions`, in the Spent
> totals, in the category breakdown and in the heatmap. Only the drill-down link is dead. Because the
> card renders its top 8 entries, actual exposure is roughly **6 broken rows out of 96 rendered**
> across the last 12 monthly views.

### Evidence

I replicated the grouping independently against REAL with a hand-rolled proxy for
`spendingRowsInRange` (expense-kind outflow plus uncategorized outflow) and got **328 empty of 625
unlinked groups, $34,645.08** — against the original fact-check's 330 / 627 / $34,403.46, which
replicated the real function including refund netting. The residual (2 groups, $242) is replication
noise from refund handling. **DEMO reproduced exactly: 31 groups, 25 merchant, 6 unlinked, 0 empty,
$0.00.** Empty merchant-kind drill-downs: **0** on both.

Worst offenders (REAL):

| Derived `q` label | Spend | Rows returned |
|---|---|---|
| `CARD PURCHASE FORDHAM U ENR SVCS 718 NY CARD 7782` | $8,410.00 | 0 |
| `CARD PURCHASE FORDHAM U ENR SVCS BRONX NY CARD 7782` | $2,610.00 | 0 |
| `RESIDENT DREAMCLOUD RESIDENTHOME` | $1,814.72 | 0 |
| `ATM WITHDRAWAL 4780 3RD AVE BRONX NY CARD 7782` | $1,435.00 | 0 |

### What was wrong, and why

**"330 of 627 (52.6%)."** Correct as a ratio *within the unlinked subset*, but the sentence reads as
"half of all merchant drill-downs". Over all 1,292 Top-Merchants groups it is **25.5%**, and over the
rows a user actually sees it is ~6%.

**"$34,403.46 unreachable."** The money is fully reachable and fully counted. Only the link is dead.
"Unreachable" implies missing money, which is the one thing that is not happening.

The review's own note — **"invisible on the demo DB, so no test can catch it today"** — is confirmed
and is the most useful sentence in that item.

---

## 6 — 95% of /transactions is invisible listboxes

**Verdict: CONFIRMED.** The only claim of the eight that survives intact. Two caveats: the headline
numbers come from two different databases, and the "one line" fix is not safe alone.

### Corrected wording

> Every closed `CategoryPicker` on `/transactions` ships its entire category listbox in the HTML,
> because `Popover.tsx:134` renders `{children}` unconditionally and the ledger renders one picker per
> row (`PAGE_SIZE = 50`). On the REAL data that is **4,647,518 bytes / 35,341 elements / 3,650
> `role=option`**; on the DEMO fixture the same page is **4,173,711 bytes / 32,568 elements / 3,350
> `role=option`**. The closed popovers are ~93% of the response bytes and ~95% of the elements.
>
> Gating the children is genuinely one line and cuts the demo page to **295,254 bytes / 1,532
> elements**, with options still rendering on demand.
>
> **It is not a safe one-line change on its own.** It drops the SSR `autofocus` attribute that
> currently causes native `showPopover()` to focus the search field, so the picker opens with focus on
> `<body>` and type-to-search plus the arrow/Enter grammar stop working. Ship it with a second change
> — an effect on `open` calling `inputRef.current?.focus()` in `CategoryPicker`, where `inputRef` is
> already declared, already attached at line 129, and never dereferenced.

### Evidence

I served the page myself on the DEMO db and measured, then applied the fix and re-measured:

| | baseline | with `{open ? children : null}` |
|---|---|---|
| bytes | **4,173,711** | **295,254** (−92.9%) |
| element open tags | **32,568** | **1,532** (−95.3%) |
| `role="option"` | **3,350** | 0 |
| `popover="auto"` / `role="listbox"` | 50 / 50 | 50 / 0 |
| `autofocus` attributes | **50** | **0** |

The baseline byte count is an **exact** match to the fact-check's figure. The `autofocus` count going
50 → 0 is direct confirmation of the focus regression: React 19 serializes `autoFocus`
(`CategoryPicker.tsx:130`) into the SSR HTML, native `showPopover()` honours it on the persisted node,
and gating the children removes it. The Popover change was reverted; `git status` on `src/` is clean.

Option counts confirm the DB attribution arithmetically: 50 rows × 67 live DEMO categories = 3,350;
50 × 73 live REAL categories = 3,650.

### What was wrong, and why

Only the attribution. "4.65 MB, 32,557 DOM nodes" splices a REAL byte count onto a DEMO node count.
Each is right for its own database (REAL is 35,341 nodes), but quoted together they describe a page
that exists nowhere. Backlog #1 repeats the splice verbatim.

---

## 7 — $93,004.29 with no surface

**Verdict: PARTLY-TRUE.** Every single number reproduces to the cent. The word "no surface anywhere"
is what fails.

### Corrected wording

> On the REAL database, **$93,004.29 net across 4,587 active rows — 47.3% of the ledger** — sits in
> the four category kinds analytics excludes (transfer/investment/rewards/system), and **no surface
> totals it**.
>
> The rows themselves are fully reachable: they are in the default `/transactions` ledger, filterable
> by the Transfers/Investments/Rewards root options in the Category dropdown, one ⌘K search away from
> a filtered ledger, listed in every `/accounts/[id]` ledger, and each category has a working
> `/categories/[id]` page with a Net figure, monthly trend and row list. The money is also fully
> inside the net-worth curve — `derivation.ts` replays transactions with no category filter.
>
> What is missing is the **roll-up** and the **reconciliation**: nothing sums these four kinds,
> `/spending`'s category table is expense-gated, and nothing connects cash-flow net (−$31,656.41) to
> the net-worth change. Two buckets deserve a named concept rather than the Transfers bin:
> **Gifts received** ($46,928.00 in, $0.00 out, 35 rows, all hand-categorized) and the **250 Internal
> Transfer legs with no `transfer_group_id`** (+$46,806.37 net, against 740 paired legs that net
> exactly $0.00).
>
> Separately — a defect the review missed — `/categories/[id]` would render Gifts received as
> **"Net −$46,928.00"**, a negative figure for pure inflow, because its sign convention
> (`sign = isIncome ? -1 : 1`, `page.tsx:74`) assumes money-out for every non-income kind.

### Evidence

Measured on REAL, all exact:

| Root kind | rows | net |
|---|---|---|
| transfer | 2,569 | +$109,144.10 |
| investment | 1,988 | −$16,677.77 |
| rewards | 24 | +$630.68 |
| system | 6 | −$92.72 |
| **excluded total** | **4,587 / 9,688 = 47.35%** | **+$93,004.29** |

`Gifts received`: 35 rows, $46,928.00 in, $0.00 out. `Internal Transfer`: 740 paired rows netting
**exactly $0.00**, 250 unpaired netting **+$46,806.37**. `transaction_splits` = 0 rows, so no
split-aware correction applies.

**No DB confusion here** — DEMO has only 268 excluded-kind rows (16.0%), net −$12,152.86, **no
"Gifts received" category at all**, and **zero** unpaired Internal Transfer legs. These numbers could
only have come from REAL. This claim is clean on the axis that sank the others.

I confirmed the sign bug by reading `src/app/categories/[id]/page.tsx:74-76`: `sign = isIncome ? -1 : 1`
with `flowLabel = "Net"` for the excluded kinds, over a money-out convention.

### What was wrong, and why

"Has no surface anywhere in the app" conflates *no aggregate* with *no access*. The rows have at least
five working surfaces. The real finding — no roll-up, no reconciliation, and two buckets that need a
name — is strong enough without the overstatement, and the overstatement is the part that would send
someone building a page that already exists.

---

## 8 — The honesty vocabulary rides on `title=`

**Verdict: TRUE-BUT-OVERSTATED.** The core observation is correct and worth acting on. The count is
inflated ~2.5×, two citations are wrong, and two headline examples don't occur in his data.

### Corrected wording

> `src/components/ui/Tooltip.tsx` is complete and has **zero importers repo-wide**, while **22** native
> `title` attributes — not 35 or 55 — carry 14 static and 3 dynamic explanation strings. 19 of the 22
> sit on non-focusable `<span>`/`<p>`/`<div>`/`<td>`, so no browser exposes them to keyboard and iOS
> Safari exposes none to touch. `playwright.config.ts:41` runs a single Desktop Chrome project, so this
> path has never been tested at a phone width.
>
> Genuinely lost to a sighted iPhone user: the crypto/cached-price `≈` explanations
> (`PortfolioStats.tsx:35,70,113`, `PositionCard.tsx:75`), the realized-P/L basis strings
> (`PortfolioHoldingsTable.tsx:61,74`), the clamped-sell and partial-basis notes
> (`RealizedSalesList.tsx:51,60`), the XIRR definition (`PositionCard.tsx:72`), the categorization-cost
> note (`HeaderStrip.tsx:62`), the disabled-transfer reason (`TransactionSheet.tsx:243`), and three
> dynamic forecast-basis strings.
>
> Four corrections: (a) `Badge.tsx:51`, `CashFlowChart.tsx:130` and `SpendingCategoriesTable.tsx:145`
> carry `sr-only` twins, so screen readers do reach those — the loss is sighted-touch only;
> (b) `HoldingForm.tsx:61` is a `pattern` validation message iOS surfaces in the constraint bubble;
> (c) `PnlCalendar.tsx:102` has **no `title` attribute at all** and its day Sheet already renders
> "≈ approximate" as visible text on tap — drop it from the migration list; (d) two headline impact
> examples do not fire on his data — the REAL db has **88 import files with zero errors**, and all
> **9** REAL holdings have an `avg_cost_cents`, so "Add an average cost to see P/L" never renders.
>
> Migration caveat: `Tooltip` fires on `onMouseEnter`/`onFocus` and spreads no `tabIndex`, so dropped
> onto the current non-focusable spans it fixes keyboard but **not** touch. It needs a focusable
> `<Annotation>` wrapper — which `00-dossier-v1-sections-1-6.md:346` specifies and
> `05-what-to-change.md:84` omits.

### Evidence

`grep -rn "ui/Tooltip" --exclude-dir=node_modules --exclude-dir=.git .` returns **only `docs/*.md`** —
zero code importers, including tests. `grep -rn "title=" src/components src/app` = **55** hits;
classifying each by its owning JSX tag splits them **22 real DOM attributes / 33 component props**.
The 33 are `<Sheet>`/`<PageHeader>`/`<EmptyState>`/`<EntryList>`/`<SeriesSection>` `title` props that
render **visible `<h1>`/`<h2>` text** — not tooltips at all.

`playwright.config.ts:41` = `projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }]`.
REAL: `import_files` = 88 rows, all `status='parsed'`, **0** with a non-null `error`; `holdings` = 9
rows, **0** with NULL `avg_cost_cents`; 1 active crypto holding (so the `≈` markers *do* fire).

### What was wrong, and why

**"35 title= attributes" / "55 title= sites."** Both counts are `grep` hits, not attributes. Counting
`title=` without distinguishing a DOM attribute from a React prop inflates the finding 2.5× and, worse,
lists visible page headings as inaccessible tooltips.

**`PortfolioStats.tsx:68`** is actually line **70**. **`PnlCalendar.tsx:102`** has no `title` at all.

**"The only place a failed import's cause is shown."** True as written, but on his data there are zero
failed imports, and the row already shows a visible status label beside the dot — so "a red dot and no
reachable reason" is wrong. Only the cause *detail* is hidden.

---

## What this means for the backlog

`docs/review/08-backlog.md` needs six edits, one reversal and one removal-of-claim. In priority order:

**#13 — reverse the prescription. This is the urgent one.**
The item says to filter `upcomingOccurrences` and `forecast.fixedComponents` by `isSeriesActive`, and
justifies it with "on the real DB 'Acme Corp (payroll)' … projects +$5,886 of phantom income … and
flips the Forecast card's sign." Every clause of that justification is wrong: Acme is a DEMO fixture;
$5,886 is the 30-day window not the card; nothing flips on either database. Shipping the fix as written
would suppress **$1,046/week of income he is genuinely still earning**, because "Cash job (weekly pay)"
looks stale only from a 13-day import gap. **Re-word to: unify the gate by making the Calendar project
what the Forecast projects, and surface staleness in the UI ("last seen 21 days ago") instead of
silently dropping the series.** Keep the "show the exclusions in a collapsed footer" instinct — it was
the right one all along. Severity stays S, but the direction inverts.

**#1 — keep the rank, fix the numbers, add the second line.**
"Best effort-to-payoff item in the entire audit" is correct and now independently verified end-to-end.
But it quotes "4,647,518 bytes / 32,557 DOM nodes" — a REAL byte count spliced to a DEMO node count.
Correct to *REAL 4,647,518 bytes / 35,341 nodes / 3,650 options* or *DEMO 4,173,711 bytes / 32,568
nodes / 3,350 options*, and correct the payoff from "roughly 259 KB and ~1,520 nodes" to the measured
**295,254 bytes / 1,532 elements**. Critically, **it is no longer a one-line item**: add the paired
`inputRef.current?.focus()` effect in `CategoryPicker`, or the fix ships a keyboard regression.

**#9 — fix the mechanism and the number.**
"`.sort().reverse()` puts every `monthly-*` before every `daily-*`, so `slice(0,8)` hides 12 of 14
dailies" is wrong twice. The prefix that actually wins is **`pre-`**, all 8 visible rows are manual
script snapshots, and **14 of 14** dailies plus the 1 monthly are hidden. "12 of 14" was arithmetic off
`DEFAULT_RETENTION`, not a measurement. Also correct "14 daily + 6 monthly" — only **1** monthly exists
— and note that 46 of the 80 files are `.db`. The restore half of the item needs no change; it is
fully confirmed and is the strongest feature item in Phase 1.

**#10 — correct the mechanism, drop two of the four data types, add the missed failure mode.**
The item blames `coveredRanges` and a fidelity gate. The actual mechanism is simpler and cheaper to fix:
`service.ts:549` passes `carryFrom = null` on the re-parse branch while `insertTxn` already implements
the migration. Drop notes and splits from the test assertion — **0 notes and 0 splits are at risk on
his data**; assert on categories and transfer links instead. Add the failure mode the review missed:
supersede runs **before** parse in a separate transaction, so a throwing parser leaves the file
superseded with no replacement. And note the item is **dormant until a profile version ships** — which
is why it belongs in Phase 1 before the next bump, not because it is firing today.

**#17 — keep it, fix the framing.**
330 of 627 and ~$34.4k reproduce. But change "330 of 627 groups (52.6%)" to make clear that 627 is the
*unlinked subset* (25.5% of all 1,292 groups; ~6 of 96 rendered rows), and delete the word
**"unreachable"** — the money is fully counted in Spent, the category breakdown, the heatmap and the
ledger. Only the link is dead. Add the verified fact that **0 of 665 merchant-linked drill-downs and 0
of 843 merchant pages are affected**, so nobody wastes time on `/merchants/[id]`. Keep the "invisible
on the demo DB" note — confirmed, and it is the reason this needs a real-DB regression test.

**#45 — halve the scope and fix three citations.**
"35 `title=` sites" → **22 DOM attributes**; the other 33 hits are `<Sheet>`/`<PageHeader>` props
rendering visible headings. Fix `PortfolioStats.tsx:68` → **:70**. **Remove `PnlCalendar.tsx:102`
entirely** — it has no `title` and already renders "≈ approximate" as visible text on tap. Soften the
`imports/page.tsx:186` special case: it is still worth doing, but his DB has **zero** failed imports
and the status label is already visible, so it is not "a red dot and no reachable reason". Add the
migration caveat from `00-dossier-v1-sections-1-6.md:346` that `05-what-to-change.md:84` dropped:
`Tooltip` needs a **focusable `<Annotation>` wrapper** or it fixes keyboard without fixing touch —
which is the entire point of the item.

**#56 — keep every number, kill the headline sentence.**
All figures reproduce to the cent and are unambiguously from the REAL database. But
"**$93,004.29 across 4,587 rows — 47% of the ledger — has no surface anywhere in the app**" is false
and would send someone building surfaces that already work: the rows are in the default ledger, the
Category filter, ⌘K, `/categories/[id]`, every account ledger, and inside the net-worth curve.
Re-word to "**no surface totals it**" and keep the three real deliverables (the "Money in, not income"
section, the paired-vs-unpaired transfer report, the reconciliation page). **Add a new small item:**
`/categories/[id]` renders Gifts received as "Net −$46,928.00" for $46,928 of pure inflow —
`page.tsx:74`, `sign = isIncome ? -1 : 1` — a one-line sign fix that makes an existing surface stop
lying before any new surface is built.

**#7 and #8 — keep as-is, correct one supporting number.**
Both are well-founded: the un-import path is a genuine no-confirm hard delete of up to 2,149 rows, and
`unimportFile` is correctly listed first among the mutations needing a snapshot. Correct the supporting
figure wherever "~1,300 hand-categorized rows" appears — the true worst case is **644** user-categorized
rows on `Chase3522_Activity_20260710.CSV` (103 on the 2,149-row file). Add the mitigation the review
omitted: the **archived source file survives on disk**, so raw rows are recoverable by re-upload; what
is unrecoverable is the per-row manual work. That makes #7's confirm dialog the higher-value half and
slightly lowers #8's urgency relative to its current placement.

**No item should be removed outright.** Every one of the eight claims points at a real defect. What
failed was the quantification and, in exactly one case (#13), the direction of the fix.
