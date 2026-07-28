# MoneyApp — Adversarial Review

**Audit date 2026-07-27 · branch `claude/app-polish-adversarial-review-e80abb` · reviewed against real source and the owner's real 9,753-transaction database, not documentation.**

---

## Executive summary

MoneyApp is a reconciliation engine with a finance app on top, and the engine is genuinely
excellent. It treats printed statement balances as ground truth, replays transactions between
them, and when the chain does not close it refuses to invent a slope — it stamps the span
`gap` and every chart declines to draw it. No consumer finance product encodes derivation
confidence at all. That single decision is the product, and it is implemented with unusual
rigour: evidence-based transfer pairing, splits as a lossless overlay, one predicate driving
tab counts and bulk mutations, server-recomputed blast radius, a token contract with contrast
ratios reasoned inline.

The app is not "basically done." Three classes of problem stand between it and finished.
**It can lose data**: eight one-click irreversible actions ship with no confirmation, a
re-import silently destroys every hand-set category on a file, and the only backup cannot be
restored from inside the app. **It states numbers it cannot defend**: dead recurring series
project phantom income, transfers marked in bulk still count as spending, and $93,004.29
across 47% of the ledger has no surface anywhere. **It is worst on the device he says is
primary**: 95% of `/transactions`' HTML is invisible closed listboxes, five routes pan
sideways at 390px, and the honesty vocabulary rides entirely on `title=`, which touch never
fires.

Almost every fix is small and additive. Nothing here requires deleting a feature.

---

## Read this first — the ten that matter

| # | What | Why it is first | Where | Effort |
|---|---|---|---|---|
| 1 | **Gate `Popover`'s children on `open`** | One line. Measured on the real DB: `/transactions` drops from **4,647,518 bytes / 32,557 DOM nodes** to ~259 KB / ~1,520. Fixes 10 pickers plus Menu, BudgetRow, SeriesMembership at once. The correct pattern is already written three files away. | `ui/Popover.tsx:134` | S |
| 2 | **Confirm + snapshot the eight irreversible actions** | An 8px grey "un-import" link runs a hard `DELETE` of 2,149 transactions including ~1,300 he hand-categorized. No dialog, no undo, no snapshot — recovery is a manual file copy. The app already owns a lossless UndoPatch system wired into none of them. | `imports/page.tsx:196` → `import/service.ts:962-987` | M |
| 3 | **Preserve user attributes across re-parse** | Improving a parser and re-dropping statements silently destroys every category, note, transfer link and split on those files, and orphans the splits forever. `docs/schema.md:91-93` promises the opposite. Zero test coverage. | `import/service.ts:396-405, 548, 772-786` | L |
| 4 | **Filter recurring projections by `isSeriesActive`** | A payroll series last matched 80 days ago still projects **+$5,886 of phantom income** into the Upcoming tab and the Forecast card, flipping the headline positive — while the Calendar tab on the same page refuses to draw it. | `recurring.ts:719-723` + `forecast.ts:126-130` | S |
| 5 | **Make "Transfer" mean one thing** | `grep -c transferGroupId src/services/analytics.ts` = **0**. Marking 40 rows as transfers shows a T badge on every one and they keep counting as spending in /spending, the Sankey, the heatmap and all ten budgets. | `bulk-edit.ts:168-173` vs `transfer-links.ts:110-121` | M |
| 6 | **Add `error.tsx` / `loading.tsx` / `not-found.tsx`** | Confirmed live twice: typing a bad amount into *Record a balance* replaces the whole document with a Next error digest and loses every other field. `find src/app -name error.tsx` returns nothing. | `src/app/` (absent) | S |
| 7 | **Fix the dead merchant drill-downs** | **330 of 627 unlinked merchant groups open an empty ledger — $34,403.46 unreachable**, including his largest merchant-less payee. Invisible on the demo DB, so no test can catch it. | `spending.ts:685-687` | S |
| 8 | **Build "money in, not income"** | Cash flow says net −$31,656; net worth says +$84,858. **$93,004.29 across 4,587 rows (47% of the ledger) has no surface at all** — $46,928 of gifts with zero outflow, 250 unpaired transfer legs. It is a missing concept, not a bug. | `analytics.ts:16-18` | L |
| 9 | **Make the period an app-level concept** | `resolvePeriod` has two route callers; every outbound link drops it. "Groceries $14,200" → click → "$980". The workaround is committed to the test suite in two places. | `lib/period.ts:161` + every drill-down href | M |
| 10 | **`cache()` the hot services and lazy-load recharts** | 1.4–2.0s of synchronous SQLite per render with zero memoization (the dashboard computes `transferFloats` twice at 439ms each), and recharts ships as five identical chunks with no cross-route reuse. `/investments` is 1.83× the project's own JS budget. This is the difference between the hosted free tier feeling instant and feeling broken. | `dashboard.ts:117` + `ScrubChart.tsx:12` | M |

---

## How to read this document

This is the full dossier, inlined in order. Nothing is behind a link.

| Section | What it answers |
|---|---|
| **01 — Goal & architecture** | What the app is, how every part connects, the 20-row reconciliation contract, and the 20 things that are genuinely good and must not be refactored away. |
| **04 — What is bad** | The ranked defect register: 92 findings, the top 30 put through three adversarial lenses, plus every claim that **failed** verification and why. |
| **05 — What to change** | 97 fixes to things that already exist, split correctness / clarity / craft / consistency, each with a target `file:line`. |
| **06 — What to add** | 62 net-new items: table stakes first, then the ambitious tier. |
| **07 — Page by page (parts 1–3)** | Every route, every button, every tab: interactive inventory with a verdict per control, then Good / Bad / Change / Add. |
| **08 — Backlog** | The single ordered execution list. **Start here when you start working.** |
| **09 — Blind spots** | What 28 agents missed, found by running the app against the real database. Every number measured. |

Verdict vocabulary used in the page dossiers: **broken** (does the wrong thing) · **missing-state**
(a state exists in the data and not on screen) · **confusing** (works, teaches the wrong model) ·
**undiscoverable** (works, cannot be found) · **dead-end** (shows a number that should lead somewhere
and does not) · **sensible** (leave it alone).



---

<div id="sec-01"></div>

> **▼ SECTION 01 — The goal, the machine, the good parts**

# MoneyApp — Adversarial Review, Part 1: The Goal, The Machine, The Good Parts

> Audit date 2026-07-27 · branch `claude/app-polish-adversarial-review-e80abb` · reviewed against
> real source, not documentation. Every claim below carries a `file:line`. Where a doc and the code
> disagree, the code wins and the doc is named as stale.

---

## 1. What this app is (the goal)

**MoneyApp is a reconciliation engine with a finance app bolted on top. That is the whole thesis, and
it is a good one.**

The problem it solves: every consumer finance product answers "what is my net worth" by *asking a
third party*. Plaid, MX and Finicity log into your bank with your credentials, scrape a balance, and
hand it over. When that scrape flakes — and it flakes constantly; it is the #1 complaint against
Monarch (`docs/monarch-money-deep-dive.md:293`) — the app has no way to know it is wrong. It shows
you a number and you either believe it or you don't. There is no proof.

MoneyApp inverts that. It takes the artifacts your bank already gives you — the PDF statement, the
CSV export, the OFX file — and treats the *printed balances on those documents* as ground truth. It
then replays your transactions between two printed balances and checks that the chain closes:

```
beginning_balance + Σ(transactions in period) = ending_balance     — to the cent
```

If it closes, the days in between are marked `derived` and you are looking at arithmetic. If it does
not close, the app does **not** interpolate a plausible line. It keeps the replayed numbers so you
can inspect the drift, stamps them `basis='gap'`, and every chart in the app then refuses to draw
them (`src/services/derivation.ts:147-158`). The comment at the fix site says it plainly: *"an honest
gap, never an invented slope."*

That single decision is the product. Everything downstream — spending, income, budgets, recurring
detection, forecasts, net worth — is derived from a ledger whose every span is labelled with how much
it is trusted, and the UI carries that label all the way to the pixel: dashed strokes for estimated
days, a Basis column that only materialises when an estimated day exists, coverage bands naming the
specific missing accounts.

### Who it is for

One person: the owner. Not a household, not a team. The DB is a single SQLite file, there is no auth,
and there is no multi-tenancy anywhere in the schema. This is not a limitation to apologise for — it
is what makes the "nothing is read-only, everything is correctable" posture safe.

### Why statements-not-Plaid is the defining choice

Three consequences follow, and they are the app's entire competitive position:

1. **Nobody holds your bank credentials.** Not Plaid, not the app, not a cloud. The only optional
   outbound calls are free price APIs and batched Claude merchant classification.
2. **The numbers are provable.** A statement is a legal document your bank printed. A Plaid balance
   is a scrape. When MoneyApp says $88,968.58, there is a chain of printed anchors behind it and a
   named basis on every day of the curve. No aggregator-fed app can make that claim.
3. **You pay for it in labour.** You have to go download the files. There is no background sync.
   The app's honest answer to "why is my October missing" is "you didn't import October."

### How it differs from Monarch / Copilot / Mint / YNAB

| | Them | MoneyApp |
|---|---|---|
| Balance source | aggregator scrape, unverifiable | printed statement anchors + txn replay, reconciled to the cent |
| Unverifiable span | silently interpolated or hidden | `basis='gap'`, dashed, named in words, excluded from totals (`derivation.ts:147-158`) |
| Transfers | excluded by *category tag*; user fixes mislabeled legs | evidence-based two-sided detector; a one-sided hint may only FLAG, never auto-pair (`categorize.ts:487-502`) |
| Investment return | Monarch uses a documented hypothetical ("as if you held today's securities") | contribution-timed, NAV-consistent TWR + XIRR + realized + unrealized, stated as four separate facts that are never summed (`PortfolioStats.tsx:22-131`) |
| Refunds | folded into a net number | GROSS spend with an explicit Refunds card, and the identity `earned + refunds − spent` printed on the row (`lib/spending-stat-cards.ts:80-84`) |
| Credentials | held by a third party | none exist |
| Cost | $8–15/mo | free, local |

YNAB is a different religion entirely (envelope budgeting, forward-allocating every dollar). MoneyApp
is retrospective-truth-first: it tells you what *happened*, precisely, before it tells you what to do.

### Where it may have drifted — read this part twice

You said the app is "basically done." Three things in the code contradict the thesis above, and you
should decide deliberately whether you accept them:

**(a) The investments half is not statement-fed.** The entire thesis is "statements are the source of
truth." That is false for `/investments`. The only code path in the whole app that writes
`holding_events` — the position timeline that every return, benchmark and P/L number is computed from
— is `upsertHolding` at `src/services/holdings.ts:140`, which is reachable only from the manual
"Add holding" form. The import pipeline deliberately *discards* the holdings section of a Robinhood
statement (`src/services/import/profiles/pdf-profile.ts:171`: *"holdings rows in Robinhood statements
are not activity — cut everything"*). Your real 1,991-event equity timeline was built by a one-off
script that **no longer exists in the repo** (`data/` now contains only `backups/`, `statements/`
and the DB files). So: import a new brokerage statement and the transactions land, but the position
timeline stays frozen at whatever that vanished script left behind. Half the app is running on a
foundation the other half's doctrine forbids.

**(b) "Local-first" and "hosted on a free tier, viewed from my phone" are in direct conflict.**
`better-sqlite3` is a synchronous native module. It cannot run on Vercel or any edge/serverless
runtime. Hosting requires either a long-lived Node process with a persistent volume, or the async
rewrite the pass-13 Turso investigation already priced at ~68 files. This is not a polish item; it is
an architecture decision you have not made yet.

**(c) The phone is the least-served surface, and you say it is the primary one.** The command palette
— the only route to accounts, categories, merchants and holdings as browsable entities — has **no
visible trigger anywhere in the UI**; the only reference in the shell is a code comment
(`AppShell.tsx:14`). There is no `/categories` index and no `/merchants` index at all: both
directories contain only `[id]/page.tsx` and `actions.ts`. On a phone, with no keyboard, the entire
learning layer of the app — every merchant it has learned, every default category — is unreachable.

If (a), (b) and (c) don't bother you, the app is what you wanted. If they do, they are the real
roadmap, not the chart polish.

---

## 2. How it all connects

### The machine, end to end

```
 ┌─ YOU ────────────────────────────────────────────────────────────────────────────┐
 │  drop PDF / CSV / OFX / QFX files onto /imports                                   │
 └────────────────────────────────┬─────────────────────────────────────────────────┘
                                  ▼
 ┌─ INGEST ─────────────────────────────────────────────────────────────────────────┐
 │ sniff.ts (first 512 bytes) → PROFILES (first matches() wins, filename-routed PDFs)│
 │ sort by FORMAT_PRIORITY  ofx/qfx 0  <  csv 1  <  pdf 2      ← fidelity order      │
 │ parse → ParsedStatement { txns, period(printed balances), declaredRange, ledger } │
 │        every profile normalises to NET-WORTH SIGN at the boundary                 │
 │ identity: file = sha256+parserVersion   row = dedupeHash(acct,date,cents,RAW,occ) │
 │ per-row ladder: skippedOwned → takeover → cross-format dedupe → insert            │
 │   (no row is ever silently dropped — every path bumps a named counter)            │
 └──────────┬───────────────────────────────────────────────┬───────────────────────┘
            ▼                                               ▼
   ┌─ transactions ─────────┐                     ┌─ balance_anchors ──────────┐
   │ IMMUTABLE ledger rows  │                     │ statement > ofx_ledger >   │
   │ amount/date/desc from  │                     │ manual > live  (read-time  │
   │ import; category etc.  │                     │ precedence, derivation.ts) │
   │ assigned later         │                     │ CHAIN_GRADE = {stmt,manual}│
   └────┬───────────────────┘                     └────────────┬───────────────┘
        │                                                      │
        │   ┌────────────── RECONCILE ─────────────────────────┘
        │   │ begin + Σtxn = end ?  yes → period reconciled
        │   │                       no  → gap(cents) + QUARANTINE that file's rows
        ▼   ▼
 ┌─ ENRICH (deterministic, free, runs after every import) ──────────────────────────┐
 │ categorizeAll: rules(priority ASC, first match) → merchant map → bank_category    │
 │                → credit_match → else uncategorized                               │
 │   candidate set = active AND category IS NULL AND source != 'user'   ← the shield │
 │ detectTransfers: auto-pair ONLY on two-sided/structural evidence + mutual-nearest;│
 │                  single-sided hint may only FLAG for review                       │
 │ [optional] Claude Haiku: batches 50 unknown merchants, enum-constrained categories│
 │ recurring detection → series (+ user_* override columns that shadow detection)    │
 └────────────────────────────────┬─────────────────────────────────────────────────┘
                                  ▼
 ┌─ DERIVE ─────────────────────────────────────────────────────────────────────────┐
 │ rebuildAccount → DELETE+INSERT the whole account's daily_balances (a CACHE)       │
 │   replay includes status IN ('active','excluded')  ← 'excluded' hides from        │
 │   ANALYTICS only; the money still moved                                           │
 │   basis ∈ derived | derived_unverified | carried | gap                            │
 │ investment accounts w/ holding_events bypass this → crypto-history: Σqty × close  │
 │ netWorthSeries: sum non-gap days across ACTIVE accts, trailing-carry each acct's   │
 │   last known balance forward, report covered/missing BY NAME                      │
 │ in-flight bridge: two-leg transfer pairs → inTransitCents (hero ≠ assets−liab)    │
 └────────────────────────────────┬─────────────────────────────────────────────────┘
                                  ▼
 ┌─ ONE ROW SOURCE for all spend/income ────────────────────────────────────────────┐
 │ analytics.activeTxnsInRange  — status='active' in [from,to], then EXPLODED by     │
 │ activeSplitsInRange into one pseudo-row per split part (parts sum to the parent,  │
 │ so grand totals never move; only category attribution does)                       │
 │   split whose parent has a transferGroupId is NEVER exploded                      │
 │ classifiers: spendingBucket (expense-kind, or uncategorized NEGATIVE)             │
 │              isIncome     (income-kind AND amount > 0)                            │
 │ ⚠ transfers are excluded BY CATEGORY KIND ONLY — transferGroupId is invisible here│
 └───┬──────────────────────────────────────────────────────────────────────────────┘
     │
     ├─ GROSS fork (refunds are their own bucket):
     │    periodTotals · cashFlowByPeriod · dailySpendHeatmap · spendingSankey
     │    largestTransactions · periodActivity
     └─ NET fork (refunds subtract from the category):
          categoryBreakdown · monthlySpending · categoryTrends · categorySpending
          → budgets, /categories/[id], and /spending's "Where it went" table
                                  │
                                  ▼
 ┌─ SURFACES (15 routes; 6 are drill-down-only, no nav entry) ──────────────────────┐
 │ /  dashboard hero + 6 modes + Sankey   /transactions triage   /spending           │
 │ /accounts (+[id])  /budgets  /recurring (+[id])  /investments (+[assetType]/[sym])│
 │ /imports  /settings   ·  drill-only: /categories/[id] /merchants/[id]             │
 │ view state: URL > persisted app_settings > spec default; only non-defaults in URL │
 │ one chart engine: components/investments/ScrubChart.tsx (5 consumers)             │
 │ one focus wrapper: ChartFocus renders ONE renderPanel twice (inline + <dialog>)   │
 │ one table lens:   ScrubTable renders the panel's OWN summarize/header/formatValue │
 └──────────────────────────────────────────────────────────────────────────────────┘
```

### The reconciliation table

This is the contract. Every row is a pair of numbers that must be equal, and where that equality is
actually enforced. Rows marked ⚠ are places where the equality is *claimed* but not structurally
guaranteed — those are Part 2 material.

| # | This number | must equal | Enforced at | Status |
|---|---|---|---|---|
| 1 | `beginning + Σ txns in period` | statement's printed `ending` | `import/service.ts:811` (`reconcileAccounts`); failure ⇒ `gap` + quarantine | ✅ structural |
| 2 | Σ split parts | parent `amountCents` | `lib/transaction-splits.ts:70-88` (pure) + re-checked at write in `services/transaction-splits.ts:209-213` | ✅ structural |
| 3 | Σ exploded analytics rows | Σ raw ledger rows | falls out of #2 — `analytics.ts:157-193` emits one pseudo-row per part | ✅ structural |
| 4 | Spending StatCards | `cashFlow.totals` ≡ `periodTotals` | all three call `periodTotals` (`spending.ts:73`) | ✅ same function |
| 5 | Sankey ribbons in | Sankey ribbons out | `sankey.ts:17-21`: `in = earned+refunds+max(−net,0)`, `out = spent+max(net,0)` — balances by algebra | ✅ structural |
| 6 | Σ heatmap days over a full month | that month's `spentCents` | shared classifiers on the same row source | ✅ by construction |
| 7 | A StatCard's figure | the row list its href opens | `lib/ledger-href.ts` mirrors `transactions-query.filterConditions:47-84` param-for-param | ⚠ **the `category=spending\|income` branch is NOT split-aware** (matches the parent's categoryId); the named-category branch is |
| 8 | Tab count on /transactions | rows rendered ≡ rows a bulk action mutates | one predicate: `filterConditions` + `viewCondition` shared by counts, rows and `bulkApplyByFilter:187-194` | ✅ structural — the best one in the app |
| 9 | Cluster "Apply to N" | rows actually written | `review-inbox.ts:250-277` recomputes the live id set server-side from an opaque ref | ✅ never trusts the client |
| 10 | "Apply to N uncategorized" (merchant) | rows written | same predicate twice: `merchants.ts:77` (label) and `merchants.ts:113-123` (write) | ✅ structural |
| 11 | Dashboard hero `latestCents` | `assets − liabilities` | deliberately ≠ by exactly `inTransitCents`, and the UI says so in words (`app/page.tsx:166-172`) | ✅ documented divergence |
| 12 | Chart line | table lens rows | both slice through `windowedPoints` and the table renders the chart's own `summarize`/`renderHeader`/`formatValue` (`ScrubTable.tsx:44-53`) | ✅ structural |
| 13 | Inline chart card | focus-dialog chart | `ChartFocus` calls one `renderPanel` twice | ✅ structural |
| 14 | Category page headline | its transaction list | both route through `analytics.spendingTransactions:429` | ✅ same predicate |
| 15 | Budget tail | `/recurring` projections | `budgets.ts:344-389` reuses `projectOccurrences` and drills to the exact series | ✅ shared function |
| 16 | Forecast total | Σ visible component rows | `forecast.ts:317-319` derives the total by summing components; `<tfoot>` restates the identity | ✅ "the components ARE the math" |
| 17 | /spending "Spent" card | Σ "Where it went" table rows | **NOT equal by design** — card is GROSS, table is NET. Nothing on screen says why | ⚠ **unlabelled fork** |
| 18 | dashboard-series 'combined' | hero `bridgedNetWorthSeries` | `multi-series.alignOverDays:92` carries across interior gap runs; `netWorthSeries` carries only past an account's LAST day | ⚠ **can differ on interior-gap days**, contradicting `dashboard-series.ts:16-19` |
| 19 | Portfolio value chart | portfolio return chart | different x-extents (515+8 carried vs 515 days) despite `PortfolioChartPanel.tsx:49` claiming "aligned 1:1 by day" | ⚠ **doc comment is wrong** |
| 20 | Realized P/L header | Σ realized rows in the holdings table | header walks all 34 legs ($3,018.13); the table renders only the 9 ACTIVE legs ($1,941.42) | ⚠ **$1,076.71 unreconciled, no link to the closed positions** |

Rows 1–6, 8–10, 12–16 are the reason this app can be trusted. Rows 7, 17, 18, 19, 20 are the reason
Part 2 exists.

### The doctrines that hold it together

Five rules, each enforced in more than one place, each with the reasoning written at the fix site:

- **`daily_balances` is a derived cache.** Truth is transactions + anchors. Only two functions may
  write it, and both DELETE-then-INSERT a whole account inside one transaction
  (`derivation.ts:250-257`, `crypto-history.ts:39,119`). It is the only table in the schema with no
  timestamps — deliberately (`docs/schema.md:19-21`).
- **Sign is net-worth-signed everywhere.** Credit balances are negative. Parsers normalise at the
  boundary; nothing downstream re-signs. There is exactly one flip in the app, at `anchors.ts:27-30`.
- **`categorization_source='user'` is sacred.** Enforced at five independent write paths, with the
  SQL subtlety written down at two of them: *"NULL != 'user' is NULL in SQL, not true"*
  (`categorize.ts:176-178`, `claude-categorize.ts:106`).
- **Splits are an overlay.** The parent stays immutable, parts sum exactly, and "has splits" is an
  `EXISTS`, never a stored flag. Splits and transfer links are mutually exclusive at three sites.
- **Money math lives in pure lib/ modules.** Projection functions are DB-free *and clock-free* —
  callers pass `today`. That is why 98 test files can pin the arithmetic without a database.

---

## 3. What is genuinely good

Ranked by how expensive it would be to lose. Protect the top of this list; propagate its patterns
downward into the surfaces Part 2 will criticise.

### Tier 1 — the differentiators. Do not let a refactor touch these.

**1. The honest-gap derivation engine.** `src/services/derivation.ts:147-158`. A chain that does not
close keeps its replayed values *for inspection* but is stamped `gap`, and `netWorthSeries`,
`accountSeries` and `latestBalances` all refuse to show them. Querying `daily_balances` directly
therefore gives you numbers the app has already declared untrustworthy. No consumer finance product
encodes derivation confidence at all, let alone at the row level.

**2. The honesty vocabulary carried all the way to the pixel.** `basis` flows from the DB into
dashed strokes, a Basis column that only appears when an estimated day exists
(`ScrubTable.tsx:78-84,117`; `BalanceChartPanel.tsx:153-169`), coverage bands naming the actual
missing accounts (`app/page.tsx:175-184`), `≈` and `~` markers with the basis in a `title` *and* an
sr-only span, and a `deltaPct` that is suppressed unless BOTH window endpoints are complete
(`NetWorthChartPanel.tsx:92-93`) so a partial endpoint can never fabricate a percentage. And a
caption that refuses to name a window it isn't showing (`ScrubTable.tsx:147-149` `fellBack`).

**3. The `user` shield, generalised correctly.** The transfer detector protects a row categorised
outside Transfers *by any source*, not just `user`, and the comment names the 2026-07-15 review that
found a real `Investments › Buys` row being overwritten (`categorize.ts:455-466`). Widening a guard
from "protect the user" to "protect any real categorisation" is the single best piece of integrity
reasoning in the repo.

**4. Evidence-based transfer pairing.** `categorize.ts:487-502` requires *structural* evidence (a
same-day internal mirror, the card↔source link, or both legs already in Transfers) or a hint on BOTH
descriptors — plus mutual unique-nearest. A single-sided hint may only FLAG. The comment enumerates
the exact coincidences four adversarial rounds found it pairing otherwise (a wine purchase vs an
external wire; a paycheck vs a transfer). Monarch cannot do this.

**5. `dedupeHash` covers the RAW description, never the normalised one.** `src/lib/hash.ts:3-8`, with
a length-prefixed canonical encoding so a hostile description cannot forge a field boundary. That one
decision is why five years of overlapping statements reconcile instead of re-duplicating on every
normaliser tweak.

**6. Splits as a pure overlay with the invariant in a pure function.** `lib/transaction-splits.ts:70-88`
is the single validator, and the SplitEditor's live "$X left / $X over" readout and its save gate both
call it (`SplitEditor.tsx:180-182, 266-273`) — the UI physically cannot let you save a split the
service would reject.

### Tier 2 — the patterns to propagate

**7. One predicate, three consumers.** `services/transactions-query.ts:34-107` — `filterConditions`
and `viewCondition` drive the tab counts, the rendered rows AND `bulkApplyByFilter`. The number on the
tab *is* the set the bulk action mutates. This should be the template for every count-bearing control
in the app.

**8. Server-recomputed blast radius.** `review-inbox.ts:246-277` recomputes a cluster's live id set
from an opaque ref rather than trusting the client's list, with the reasoning written down; the same
shape appears at `merchants.ts:77` vs `merchants.ts:113-123`. A re-click is idempotent and the "Apply
to N" promise is honest even if the queue shifted underneath.

**9. Lossless server-captured undo that treats its own input as hostile.** `bulk-edit.ts:218-249`:
never SETs `status='superseded'`, never restores a transfer link onto a row that has *since* been
split ("it would strand the parts and leak the whole stamped row into spend"), and guards every write
with `ne(status,'superseded')` so a stale undo toast cannot corrupt the partial unique index.

**10. One panel rendered twice.** `ChartFocus.tsx:127,169` and `ScrubTable.tsx:44-53`. View parity
between inline/focus and between chart/table is *structural*, not a convention someone has to
remember. This is the correct answer to "keep two renderings in sync" and it should be reached for
every time that problem appears again.

**11. The user-override architecture on recurring series.** `user_cadence` / `user_amount_cents` /
`user_next_expected_on` shadow detection's own columns, read user-first at `recurring.ts:642-651`.
Detection keeps refining underneath and a reset genuinely hands the field back. Nothing else in the
app lets a human correct a derived value without destroying the derivation — and the editable cadence
*sentence* (`CadenceSentence.tsx:57-89`) that edits it is the most product-feeling control you have
built. Extend that pattern to budgets and rules.

**12. The Sankey that balances by algebra.** `services/sankey.ts:10-21`. `in ≡ out` for every period
because the identity is written into the node construction, not asserted afterwards.

**13. GROSS spend with an explicit Refunds card.** `spending.ts:73-95` refuses to let a big statement
credit drag Spent negative, and `spending-stat-cards.ts:80-84` only shows the Refunds card when
refunds exist — then relabels Net as `earned + refunds − spent` so the arithmetic is visible on the
row. (The unlabelled GROSS/NET fork below it on the same page is Part 2's problem; this half is right.)

**14. Prompt injection handled at the right layer.** `claude-categorize.ts:222-229` validates the
model's returned `description` against the submitted batch before using it as a DB write selector,
because *"a hostile bank string could poison OTHER merchants' mappings."* The threat was modelled
correctly, at the boundary where it matters.

### Tier 3 — the craft layer

**15. The keyscope stack.** `src/lib/keyscope.ts` — explicit numeric tiers instead of push order,
`modal:true` stopping the walk, in-place re-push so a conditional binding cannot reorder equal-priority
scopes, editable targets ignoring plain mnemonics but still seeing `mod+`/Escape, 800ms chord expiry.
Pure, unit-tested, reasoning at the top of the file. Escape always closes exactly one thing.

**16. The token contract.** `src/app/globals.css:9-133` defines one ~60-token contract twice with
contrast ratios reasoned *inline at the point of decision* — `--ink-faint` annotated "≥4.5:1 on all
three surfaces", `--positive-soft` added with the note that the previous /12 tint "landed at 4.45:1 —
a hair under AA on small badge text." **Zero `dark:` variants exist anywhere in the repo**, which
means the dark theme is architecturally incapable of drifting from light. And `.figures`
(`globals.css:230-234`) is one class doing three jobs — mono, tabular-nums, −0.01em tracking — applied
100+ times, which is why money never wiggles during a NumberRoll.

**17. Native-platform correctness the hard way.** `ChartFocus.tsx:130-139` documents a real Chromium
trap (intercepting `cancel` to run a view transition consumes the close-watcher's activation grant and
strands the modal open) and chooses correctness over decoration: Escape closes natively, only the
button/backdrop paths morph. Same instinct at `sheet.module.css:87` (reduced-motion for `::backdrop`,
which the global `*` rule cannot select) and `globals.css:241-252` (zeroing animation-*delay* as well
as duration, because a staggered entrance with `fill-mode:both` would otherwise hold its invisible
first frame for ~300ms).

**18. `aria-disabled` rather than `disabled` at list boundaries**, with the reason written at three
independent sites — disabling the focused element drops focus to `<body>`
(`ManagedAccounts.tsx:108-112`, `ArrangeableSections.tsx:123-124`, `RulesManager.tsx:152`) — plus a
service-level no-op so the semantics stay safe (`accounts.ts:267-275`).

**19. `e2e/axe-helpers.ts` `analyzeSettled`.** Axe computes contrast from mid-animation *blended*
colours, so the route fade-rise made a passing palette scan as a serious violation at 4.2:1. The
helper waits on every FINITE animation's `finished` promise — deterministic, not a timeout — and skips
infinite loops. Almost nobody diagnoses this.

**20. The clean server/client boundary.** Across all 91 `"use client"` files, every import from
`@/services` is `import type`. Not one line of drizzle, better-sqlite3 or service logic can reach a
browser chunk. Most Next apps this size leak something.

---

### One correction before Part 2

`docs/monarch-money-deep-dive.md:288-330` — the scoreboard — is **stale**. It lists Splits as ⛔
(shipped pass 20), Sankey as ⛔ (shipped pass 21), and Reports/chart-as-filter as missing (the
drill-down contract shipped). `docs/future-ideas.md:82-92` (the chart parity table) is stale in the
same way: Balance/Portfolio/Holding show `focus ❌` and `chart↔table ❌` when both shipped in passes 22
and 23, AmountHistory shows `table ❌` when it shipped, and AllocationDonut still lists hover-highlight
as its gap. Anyone planning the next pass from those two documents will rebuild work that already
exists. Fix the docs or delete them.


---

<div id="sec-04"></div>

> **▼ SECTION 04 — What is bad — the ranked defect register**

# 04 — What Is Bad: the ranked defect register

> 78 unique defects, merged from 21 route- and concern-level audits, then put through **three
> independent adversarial lenses** (a citation-checker, a doctrine-checker, and a severity-checker).
> Ranks 1–30 carry all three verdicts. Ranks 31–78 are register-only: cited but not adversarially
> re-verified. Ranks 79–92 (the **B-series**) were found only by running the app against the owner's
> **real 9,753-transaction database** and are invisible on the demo DB the 243 e2e tests use.
>
> **Severity in column 2 is the post-verification severity**, not the severity the original agent
> claimed. Where a lens downgraded or corrected a finding, the verification column says so.
> Nothing was silently dropped: claims that failed verification are listed in full at the bottom.

Category key: `safety` (data loss / irreversibility) · `correctness` (wrong number, wrong behaviour) ·
`clarity` (right number, unreadable or unreachable) · `performance` · `a11y` · `responsive` ·
`consistency` · `craft`.

---

| # | Sev | Cat | Surfaces | Problem | Concrete failure | file:line | Verification (3 lenses) |
|---|---|---|---|---|---|---|---|
| 1 | critical | safety | /imports, /accounts/[id], /settings, /budgets, /recurring | Nine destructive actions with no confirmation, no undo and no stated blast radius. `unimportFile` runs a hard `tx.delete(transactions)` behind an 8px ghost link. The app already owns a lossless UndoPatch system wired into none of them. | Owner taps the 8px grey "un-import" link on his phone → 2,149 transactions including ~1,300 he hand-categorized in pass 24 are gone. No dialog, no toast, no undo; recovery is a manual file copy. | `src/app/imports/page.tsx:196-204` → `imports/actions.ts:23` → `services/import/service.ts:962-987` | 3/3 confirmed the un-import path verbatim. **Corrections:** "Archive account" IS reversible (`accounts/[id]/page.tsx:265-278` renders "Restore account") → 8 irreversible + 1 unexplained-reversible; `EditAccountSheet.tsx:66,210` and `RulesManager.tsx:100-104` ARE confirmation/undo primitives, so "no primitive at all" is false. Core stands. |
| 2 | critical | safety | /imports, /transactions, all downstream analytics | Re-importing a file at a new parser version marks the old rows AND the old `importFiles` row `superseded`; `coveredRanges` then filters it out of the ownership map, so the takeover branch never runs, `migrateSplits` is unreachable, and `insertTxn` is called with `carryFrom = null`. | Owner improves the Chase parser, re-drops 24 statements. Every hand-set category, note, transfer link and split on those files is gone, and the file table double-counts. `docs/schema.md:91-93` promises the opposite in writing. | `services/import/service.ts:396-405, 525, 548, 772-786` | 3/3 confirmed end-to-end. One lens found it is **worse**: the takeover branch is gated on a *strictly lower* fidelity source, so a same-format re-parse can never take over even if the status filter were fixed. Zero test coverage. |
| 3 | critical | safety | /transactions, /merchants/[id], /settings, /recurring/[id], /accounts | Undo is the app's whole safety net and fails silently: `offerUndoToast` has no `else` and no `catch`, and `Toast.tsx` dismisses the toast synchronously *before* the action resolves, destroying the patch. | Owner bulk-recategorizes 300 rows, clicks Undo, it fails, the toast vanishes, the rows stay changed, and the patch is gone from client memory. He has no way to know. | `components/transactions/undo-toast.ts:22-26` + `components/ui/Toast.tsx:223-226` | 2/3 confirmed at critical; 1 downgraded to high (undo is a second-line net and needs a genuine DB fault to fire). Both mechanism cites exact. Census verified: 52 `.then(` vs 5 `.catch(` in components+hooks. **Correction:** `MerchantDefaultCategory.tsx:43-47` does reset busy and does check `ok`. |
| 4 | critical | safety | /settings, every destructive action | Backups run **once at boot**, nothing in the app can restore them, and `MONEYAPP_SKIP_BACKUP=1` silently disables the net. The list is also mis-sorted (`daily-` < `monthly-`), hiding 12 of 14 daily snapshots. | Owner categorizes 200 rows all day, un-imports the wrong file at 6pm. The only restore point is 9am, the procedure is a manual `cp` while the server holds the file open, and it appears nowhere in the UI. | `db/backup.ts:37` + `db/boot.ts:19-24` + `app/settings/page.tsx:16-26` | 2/3 confirmed critical, 1 downgraded to high (a real snapshot does exist; `cp` recovery is 5 seconds for a developer). Sort bug, single caller, `statSync`-without-try/catch all confirmed. **Correction:** the card DOES show size (`page.tsx:25` → `:126`). |
| 5 | critical | correctness | /transactions, /spending, dashboard, /budgets, /imports | Transfers are modelled two incompatible ways. `grep -c transferGroupId src/services/analytics.ts` = **0**. `bulkApply`/`setTransactionFlags` set ONLY `transferGroupId`; `linkTransferPair` also stamps a Transfers category. Deletes never clear the partner's group id. | Owner selects 40 internal transfers, clicks Transfer, sees "Marked as transfer · 40" and a T badge on every row — and /spending, the Sankey, the heatmap and all ten budgets keep counting them as spending. | `services/bulk-edit.ts:168-173` + `services/analytics.ts:201-208` + `import/service.ts:974` | 3/3 confirmed; strongest structural finding in the set. **Doctrine flag:** do NOT "exclude any row with a transferGroupId" — a self-group has no counterparty and excluding it would hide a real outflow. Fix by making the manual mark stamp the category, as `linkTransferPair` already does. **Real-DB correction:** the double-count direction currently has 0 rows on the owner's DB (all 1,166 paired rows are already transfer-kind); only the *hiding* direction is live today. |
| 6 | critical | correctness | /transactions, /investments, /accounts, dashboard | Balance replay covers `status IN ('active','excluded')` but not `quarantined`; `bulk-edit.ts` never imports `rebuildAccount`; `upsertHolding` never rebuilds; and `rebuildAllAccounts` has **zero callers** anywhere, so there is no repair path. | Restore 40 rows from the Quarantined tab → those amounts belong in the replay, `daily_balances` still reflects a chain without them, and `basis` still reads "derived" so nothing indicates the cache is stale. | `services/bulk-edit.ts:164-167, 296-298` + `services/derivation.ts:235, 260` | 2/3 confirmed critical, 1 downgraded to high. **Scope narrowed by 2 lenses:** ordinary Exclude/Restore does NOT desync (both statuses are in the replay); the invalidating transitions are quarantined→active and `upsertHolding`. `rebuildAllAccounts` zero-callers confirmed by grep. |
| 7 | high | correctness | dashboard, /accounts, /accounts/[id], /investments | Stale numbers stated as current. `asOf` is computed by six services and rendered essentially nowhere; five components label non-today data "today", including `PortfolioStats.tsx:27`'s `Today{overview.dayChangeVsDay ? "" : ""}` — a dead ternary with two empty branches. | Dashboard states NET WORTH complete, 9/9 covered, and a "today" investment move that happened eight days ago, under a header reading "reconciled to the cent". | `services/dashboard.ts:131` + `components/investments/PortfolioStats.tsx:27` + `components/accounts/ManagedAccounts.tsx:160-167` | 1/3 confirmed critical, 2 downgraded to high. Dead ternary and discarded `asOf`/`basis` confirmed verbatim. **Correction:** `accounts/[id]/page.tsx:155-156` DOES render `as of {day} · {basis}`, so "rendered in exactly one place" is false. **Doctrine flag:** the trailing carry-forward that produces `complete:true` is deliberate and load-bearing — surface `asOf`, do not tighten completeness. |
| 8 | critical | correctness | /recurring (3 tabs), /recurring/[id], dashboard, /budgets | `recurring-calendar.ts` skips series failing `isSeriesActive`; `upcomingOccurrences` and `forecast.fixedComponents` filter on `status` only. One page gives three contradictory answers and the headline flips sign. | "Acme Corp (payroll)", last matched 80 days ago on a biweekly cadence, still projects +$5,886 of phantom income into the 30-day window and the Forecast card. The Calendar tab, same page, refuses to draw it. | `services/recurring.ts:719-723` + `services/forecast.ts:126-130` vs `services/recurring-calendar.ts:154-155` | 3/3 confirmed, including a direct DB check of the Acme row. Totals differ between demo and real DB; the shape is identical on both. `seriesDetail` calls `projectOccurrences` unconditionally, so dismissed/ended series still advertise "Next expected". |
| 9 | critical | correctness | /spending ⇄ /categories/[id], /budgets, /merchants/[id], dashboard | "The period I am looking at" is not an app-level concept. `resolvePeriod` has exactly **two** route callers; everything else hardcodes today. Every outbound link drops the period. | On /spending?period=2026 "Groceries $14,200" → click → the category page shows $980 for July. Same category, one click apart, 14× different, nothing on either screen explaining the switch. | `lib/period.ts:161` + `components/spending/SpendingCategoriesTable.tsx:105` + `services/category-detail.ts:172` | 2/3 confirmed critical, 1 downgraded to high (nothing is arithmetically wrong; the cost is context loss + rework). Decisive corroboration: **the workaround is committed to the test suite** — `e2e/a11y.spec.ts:54-56` and `e2e/zz-spending-categorize.spec.ts:21-22` both re-append `?period=2026` by hand. |
| 10 | critical | correctness | /spending, /transactions | Three different bases on one screen: the Spent StatCard is GROSS incl. uncategorized; "Where it went" is NET and filtered to `categoryId !== null`; the share-bar denominator is a third base. Plus `ledgerHref({category:'spending'})` is not split-aware while the named-category branch 12 lines below is. | A month with a $400 refund and $900 uncategorized shows a $5,000 headline above rows totalling $3,700. A $200 row split 60/40 contributes $120 to the card and appears at $200 in the list that card opens. | `app/spending/page.tsx:88-97` + `services/transactions-query.ts:58-81` | 2/3 confirmed critical, 1 downgraded to medium. **Correction:** "no reconciliation note anywhere" is false — `HonestyBucketsCard` (page.tsx:247) states the uncategorized bucket and `SpendingCategoriesTable.tsx:24` documents the exclusion. The undisclosed parts are the gross/net refund fork (the comment at `page.tsx:91-94` is stale) and the split asymmetry. |
| 11 | critical | correctness | /transactions (arrived from merchants, spending, categories) | Pressing "Filter" silently deletes `merchant`, `flow`, `amountMin`, `amountMax` from the URL — the GET form posts only 6 params — and `hasActiveFilters` ignores them so no chip and no Reset render. The category select is built from roots only, so a child id or a sentinel displays "All categories" while the ledger IS filtered. | "View all 312" on Netflix → adjust the From date → press Filter → he is now looking at the entire ledger for that range while believing he is looking at Netflix, and the bulk bar acts on that set. | `components/transactions/FiltersBar.tsx:27-31, 45-52` | 2/3 confirmed critical, 1 downgraded to high (the row list visibly changes and the bulk bar restates the count). All three called the select-lies-about-its-value half the strongest part. |
| 12 | critical | correctness | /investments, /accounts/[id], dashboard | `addHoldingAction` calls `upsertHolding` then only `revalidatePath`. Flows come from `holding_events`, NAV from the `daily_balances` cache, and `return = nav − prevNav − flow` — so the purchase is subtracted from that day's return. The unique index is `(account_id, symbol)` with no asset type while every price path keys on `(symbol, assetType)`. | Add 1 AAPL: the value chart does not move but that day's P/L flips −$1,597.79 → −$1,931.53 and headline TWR drops 6.485% → 6.084%. Re-entering ETH to fix a quantity silently converts it to a stock. | `app/investments/actions.ts:50-61` + `services/holdings.ts:110-111` | 2/3 confirmed critical, 1 downgraded to high (manual low-traffic path, repairable). **Correction:** `flowsByDay:83-101` already rolls an unpriced acquisition forward to its first priceable day, so half the fabricated-gain story is already defended. The missing rebuild and the assetType clobber are live. |
| 13 | medium | correctness | /transactions (Classify with Claude), /merchants/[id] | Two AI write paths filter on `normalized_description = ? AND status='active' AND category_id IS NULL` while their own queues correctly apply `or(isNull(source), ne(source,'user'))`. A row the owner touched that still has a NULL category is invisible to the queue and writable by the update. | Defence-in-depth gap: the documented precedence (user > rule > merchant > bank > claude) is not enforced in the two paths the owner cannot supervise. | `services/claude-categorize.ts:264-270` + `services/merchants.ts:115-122` | **3/3 downgraded.** The headline ("hand-categorization is silently overwritten") was measured false: both UPDATEs require `category_id IS NULL`, and `SELECT count(*) WHERE source='user' AND category_id IS NULL AND status='active'` returns **0** on the owner's real DB and 0–1 on the demo DB. No UI path produces that state. Real residual: one missing WHERE clause. |
| 14 | high | safety | /transactions (All tab, no filters) | "Select all N" arms an unbounded mutation whose UndoPatch is built one `{id, prev}` object per row and shipped across the RSC boundary into client memory. No confirmation, no cap, no chunking on the wire (only on the id SELECT). | One click produces a multi-MB round trip across the whole ledger; on a hosted free tier it is a request that dies halfway, leaving an unknown fraction applied and no undo. | `components/transactions/BulkActionBar.tsx:68-76` + `services/bulk-edit.ts:145-183` | 1/3 confirmed, 2 downgraded to high/medium. Mechanism exact. **Corrections:** the real count is 9,688 active rows, not 21,438; the count is rendered in the link itself and the action is a second click, so it is deliberate. Largely fixed by rank 1's confirmation work. |
| 15 | critical | correctness | /budgets, /categories/[id] | `budgetStatuses` computes bounds from `periodBounds(refDate, period)` and sums the whole period with no clamp to `b.startsOn`, which `createBudget` stamps as today. The schema already accepts `startsOn` and no UI passes it. | A $50 Travel budget created today opens at "Over budget by 4798%" for $2,448.88 of spend that happened before the budget existed — and it is the loudest alert on the page. | `services/budgets.ts:160-165` | 2/3 confirmed critical, 1 downgraded to medium (grading a monthly budget against the calendar month is conventional). All three flagged the sharper mismatch: the Predict sheet promises "a forecast of your **August**" and then grades it against July. Fix is a two-line `max(bounds.start, startsOn)`. |
| 16 | high | correctness | all 15 routes; worst on /accounts, /settings, /investments | No `error.tsx`, `loading.tsx`, `not-found.tsx` or `Suspense` anywhere, while 18 `Promise<void>` server actions call throwing `.parse()`. `Field.tsx` ships an unused `error` slot at 0 of 42 call sites. | CONFIRMED LIVE twice: typing "not a number" into *Record a balance* replaced the whole document with "A server error occurred — ERROR 4062620856". Every other field is lost; no keyboard route back. | `src/app/` (absent) + `app/accounts/actions.ts:73` + `services/settings.ts:50-54` | 3/3 confirmed by `find`/`grep` returning nothing. **Corrections:** the count is 18, not 22. The claim that a malformed view preference blacks out seven routes is **false** — `viewPreferences`/`dashboardLayout` are `.default()`-guarded and documented read-tolerant, and the writer uses `safeParse`. |
| 17 | high | performance | /transactions (ledger + review inbox), /accounts, /categories/[id] | `Popover` renders `{children}` unconditionally — no open gate — so every closed `CategoryPicker` mounts its full 67-option listbox. Measured: **31,036 of 32,557 DOM nodes (95.3%) and 3,795 KB of 4,054 KB inside 51 closed popovers**; 3,350 `role=option` nodes, 9,098 SVG paths. | On the owner's phone the ledger takes seconds to become interactive and the review inbox is the slowest page in the app, for markup nobody will ever see. It scales as categories × pickers, unbounded in the review view. | `components/ui/Popover.tsx:125` (the `{children}` render is at `:134`) | 3/3 confirmed; the correct pattern is already written at `CommandPalette.tsx:141` (`if (isOpen)`). Independently re-measured on the **real DB**: `/transactions` = 4,647,518 bytes, 3,650 `role=option`, 50 listboxes, 73 categories → **88 KB of HTML per visible row** (B10). Best effort-to-payoff item in the register: one `if (open)`. |
| 18 | high | correctness | every form, every view switcher, /imports upload, /settings Save | `useFormStatus` and `useActionState` have **zero** usages. `useViewState` returns `isPending` and all six consumers discard it; `ViewSwitcher` accepts `disabled` and 0 of 11 consumers pass it; 14 of 21 `useTransition` sites are `const [, startTransition]`. | Owner taps "Split" on the dashboard, ~1.46s of synchronous SQLite runs, nothing changes, he taps again. On /imports he drops 12 statements, sees nothing for 30s, taps Import again — two 100 MB batches in flight against one synchronous handle. | `hooks/useViewState.ts:62` + `components/ui/ViewSwitcher.tsx:20` + `app/imports/page.tsx:95-100` | 2/3 confirmed high, 1 downgraded to medium. **Correction:** "nothing anywhere shows a pending state" is false — `Button.tsx:20` has a documented `pending` prop passed at 11 sites. The true statement is: view switchers, chart lenses and every `<form action>` submit have none. |
| 19 | high | performance | /, /spending, /investments, /accounts/[id], /investments/[t]/[s] | recharts is emitted **five times** as 380,657-byte chunks with zero cross-route cache reuse; `grep next/dynamic src` returns 0. Per-route initial JS: /investments 548 KB gz (1.83× the project's own 300 KB budget), /spending 472, / 351; chartless routes 198–218. | Walking /, /spending and /investments downloads 1.14 MB raw of identical library code. On a phone on cellular this is the difference between a usable app and a spinner. | `components/investments/ScrubChart.tsx:12` (+ AllocationDonut, AmountHistoryChart, CashFlowChart, CashFlowGraph) | 2/3 confirmed, 1 "miscited" on wording only: the five chunks are byte-**length**-identical, not byte-identical (different md5 — same library under different module ids), which is exactly why there is no cache reuse. Conclusion and remedy unchanged. |
| 20 | high | performance | /, /spending, /investments, /settings, /recurring, /accounts | 1.4–2.0s of synchronous SQLite per render with no request-scoped memoization (`React.cache()`: 0 uses). Dashboard computes `transferFloats` twice (439ms each). /settings compiles a `new RegExp` per row **per enabled rule**. Two confirmed N+1s. | On the free-tier host the owner plans, /settings and /spending time out before anything else. All 15 routes are force-dynamic and better-sqlite3 blocks the event loop for every concurrent request. | `services/dashboard.ts:117` + `services/dashboard-series.ts:77` + `services/rules-manager.ts:161` | 3/3 confirmed structurally (timings not re-run by two lenses). N+1s verified: `portfolio.ts:864` single-row price lookup per holding_event (119→~31 statements); `manual-transactions.ts:63-97` runs 4–5 queries per account (/accounts 28→~8). Proposed `cache()` wrapper is behaviour-preserving and doctrine-safe. |
| 21 | medium | responsive | every route, on the owner's primary device | The mobile nav rail never scrolls the active item into view, has no edge fade and no overflow affordance, and the command palette — the only other index — has no visible trigger anywhere in the shell. | Owner opens Investments on his phone and sees no indication he is on Investments and no cue that five other destinations exist. | `components/shell/MobileNav.tsx:14` + `AppShell.tsx:50-59` | **2/3 downgraded to medium.** The headline ("half the nav is off-screen / unreachable") is **not supported**: `MobileNav.tsx:14` sets `overflow-x-auto`, so every item is reachable by swipe, and the repo's own `docs/live-responsive-findings.md` explicitly classifies this rail as correct. Residual (no scroll-into-view, no affordance, no ⌘K trigger) is real and is a two-line fix. |
| 22 | high | responsive | /investments, /recurring, /spending, /, /transactions, /accounts | Five routes scroll the document horizontally at 390px and three at 768px. `grep -rn "minmax(0" src` returns **exactly one hit**, and only at `lg:`. Every other grid track is a bare `1fr`, so items keep `min-width:auto` and are floored by their widest min-content child — which is why `DataTable`'s own `overflow-x-auto` is defeated. | The owner's phone pans sideways on the app's five densest routes, violating the project's own web rule. The dashboard's 6-option ViewSwitcher lands 28px outside `main`, so Sankey mode is unreachable on a phone. | `app/investments/page.tsx:181` + `components/ui/ViewSwitcher.tsx:24` | 3/3 confirmed. Independently corroborated inside the repo: `docs/live-responsive-findings.md` R1 reaches the same root cause and reports the same route ordering at 375px. `ViewSwitcher` has no `flex-wrap` and no `overflow-x`, so any future 5+ option lens reproduces it. |
| 23 | high | a11y | /investments, /budgets, /spending, /imports, /accounts/[id] | The `Tooltip` primitive has **zero importers** while 35 `title=` attributes in components carry the app's entire honesty vocabulary — every `≈` explanation, "clamped"/"partial basis", the forecast basis, and the only place a failed import's cause is shown. `title` fires on neither touch nor keyboard. | On /imports a failed statement shows a red dot and no reachable reason — including the "Failed mid-import (un-import to clean up)" message that signals partial rows were committed. | `components/ui/Tooltip.tsx:33` (zero importers) vs `components/investments/PortfolioStats.tsx:35` | 3/3 confirmed by grep. `Tooltip.tsx` is complete (300ms hover intent, focus-visible, Escape, `aria-describedby`, `popover="manual"` so it never light-dismisses a menu stack). The single feature differentiating this app from Monarch is delivered exclusively through the one channel that excludes the owner's primary device. |
| 24 | high | a11y | /accounts, /settings, /budgets, every pill rail | 709 of 1,470 interactive elements are under 44px, and the design system cannot produce a 44px control: `Button` offers only 24px and 32px, `IconButton` only `size-6`/`size-8`, no `lg`, and `pointer-coarse` appears twice in all of `src` (both opacity, not sizing). The destructive ones are the smallest. | On /settings a thumb aiming for "Disable" lands on an unconfirmed rule delete 4px away. The account reorder chevrons have **no padding at all** — a bare ~14×14 target, under even WCAG 2.5.8's relaxed 24×24. | `components/ui/Button.tsx:19-21, 60-63` + `components/accounts/ManagedAccounts.tsx:114-131` | 3/3 confirmed at the primitive level. `grep "pointer: coarse"` across CSS returns zero. Compounds rank 1: the small unpadded control next to a benign one is the unconfirmed destructive one. |
| 25 | high | correctness | /transactions?view=review, nav badge, /imports | The review queue conflates four unrelated producers into one boolean (Claude confidence, large uncategorized deposit, ambiguous transfer, suspected **duplicate**), the empty-state copy names only three, `markReviewed` records no human judgement, and detector pass 2 unconditionally re-flags every contended outflow after **every** import. | "Confirm all 12" on a Trader Joe's cluster can silently accept a double-counted transaction as reviewed. The tab said 12 while the screen holds 404 — the tab preserves the account filter, `page.tsx:158` renders `reviewInbox(db)` with none. | `services/categorize.ts:631-644` + `app/transactions/page.tsx:158` + `components/transactions/ReviewInbox.tsx:229-258` | 3/3 confirmed. **Doctrine note:** the unfiltered inbox is deliberate (`page.tsx:156-157`); fix the COUNT and "Mark all reviewed", not the inbox. **Real-DB correction:** the queue is currently drained (`needsReviewCount = 0`) — the re-inflation risk is future-tense, and the *empty* state is the one the owner lives in and it has one sentence and no next action. |
| 26 | high | correctness | /transactions (Classify), /settings (API key, AI spend) | The Claude run blocks the whole request (~9 sequential calls inside a form navigation), has `try`/`finally` and **no catch**, records a failure as a partial success, and `settings/page.tsx:34` reports the key green on `Boolean(process.env...)` — presence, never validity. | This is the documented pass-24 outage verbatim: a bad key produced a full-page crash, no toast, a run record that looked fine, and a diagnostic page saying the key was good. "Stop Claude run" cannot render until the blocking action resolves. | `app/transactions/actions.ts:145-159` + `services/claude-categorize.ts:148` + `app/settings/page.tsx:34,103` | 3/3 confirmed, every clause. Grep over `claude-categorize.ts:148-285` finds exactly one `try` and one `finally`, no `catch`. See also B14: on this worktree the key is simply **absent** (`.env` is gitignored and not copied into worktrees). |
| 27 | high | correctness | /recurring/[id], /recurring, /imports, /transactions, /merchants/[id] | Aggregates are one-way. `TxnFilters` has no `series`, no `importFile`, no `source` and no `sort` dimension, and `categorizationSource` is not in the ledger's column selection or on `LedgerRow`. | Rent posts at $2,300 where $2,150 was expected and there is no path from that bar to the row. The /imports "Txns" count is an unauditable integer beside a button that irreversibly deletes that exact set. "Why is this categorized as X?" is unanswerable in an app whose pitch is auditability. | `components/transactions/query.ts:17-31` + `app/transactions/page.tsx:95-111` | 2/3 confirmed high, 1 downgraded to medium (these are absent features, and the /imports half is already the core of rank 1). Provenance is populated on 9,522 of 9,753 real rows and rendered nowhere. |
| 28 | high | clarity | /imports, /budgets, dashboard, nav | `/imports` appears as an href in exactly one place app-wide and `/budgets` in two. `/imports` has no concept of missing data: no per-account last-statement date, no staleness. The nav badges one surface out of eight that each compute an attention number. | The one page whose job is ingestion cannot tell the owner which data is missing. On the real DB, Chase Checking's newest statement ends 2024-07-11 and Discover's 2024-08-18 — both **over two years stale** — under a green "Reconciled periods 105". | `components/shell/nav-items.ts:19` + `app/imports/page.tsx:51-64` | 2/3 confirmed, 1 downgraded to medium ("orphan" overstates a one-tap nav item). All three agreed the staleness half is the real finding. |
| 29 | high | correctness | /accounts/[id], /accounts | Four failures around the app's ground truth, all silent: (a) a manual anchor on a day with a statement anchor loses to it at read time with nothing indicating which wins; (b) an anchor on an investment account with holding_events is accepted, listed and **never read**; (c) `addManualAnchor` upserts, silently overwriting the previous truth; (d) no date input has a `max`. | CONFIRMED LIVE: two identically-styled peer rows, the correction did nothing. A far-future typo generates thousands of one-row-per-day INSERTs and flips every day between now and then to `basis='gap'`, erasing the recent chart. | `services/anchors.ts:32-47` + `services/derivation.ts:126-190, 204-215` + `components/accounts/AnchorForm.tsx:17` | 3/3 confirmed. Two lenses ranked (a) and (b) as the serious pair. **Mechanism correction:** the row explosion comes from `deriveCashSpans` iterating between endpoints, not `deriveForward` (which stops at today). |
| 30 | high | correctness | /accounts/[id], /investments, dashboard | The balance chart hides coverage gaps by **omission** — `accountSeries` filters out every `basis='gap'` day — and then draws a straight line across them on a categorical X axis, so a 90-day hole is one segment wide. `/investments` maps `complete` away and `carryForwardTo` re-stamps `complete: true` on every point. | The one thing this app computes better than any competitor — exactly how much of a number it can prove — is thrown away at the last step, on the chart the owner reads most. | `services/derivation.ts:353-364` + `components/accounts/BalanceChartPanel.tsx:95-98` + `app/investments/page.tsx:110` | 3/3 confirmed, with the irony verified in source: `deriveCashSpans:145-152` deliberately refuses to invent a slope and marks the span `gap`; the presentation layer then draws exactly that slope. Fix is purely additive: keep the gap rows and render them. |
| 31 | high | correctness | /merchants/[id], /recurring/[id], /transactions | The learning layer is write-only: merchant defaults cannot be cleared (the picker can only emit a string), merchants cannot be merged, `merchant_aliases` rows are read by no service and rendered on no page, and `mergeSeries` has no inverse anywhere in src. | Owner picks the wrong "Transfer to Savings" in an unfiltered alphabetical list → 40 Chase transfers become user-owned rows on the SoFi series, the Chase series is ended, detection forward-maps future transfers onto SoFi forever, and the only recovery is hand-written SQL. | `components/merchants/MerchantDefaultCategory.tsx:85` + `services/merchants.ts:281-301` + `services/recurring-links.ts:168-190` | Register-only (not adversarially re-verified). Corroborated by B-series: Claude reuses merchants by canonical name only, so duplicate merchants are structurally guaranteed. |
| 32 | high | correctness | /investments, /investments/[t]/[s], command palette | `portfolioOverview.realizedPlCents` walks every leg in `holding_events`; `holdingRows` filters `isActive`, and `allocationSlices`/`topMovers`/`command-index` build on it. Closed positions have no row, no list and no link. | Header reads "Realized P/L +$3,018.13 · 88 sells"; the visible rows total **+$1,941.42 / 43 sells**. **$1,076.71 across 24 closed legs** is unreachable, and `/investments/stock/GLD` returns 404 (verified live). | `services/portfolio.ts:569` + `services/command-index.ts:99` | Register-only, but independently **measured on the real DB** (B2): 24 ghost legs, 45 sells, exact figures above. `price_cache` still holds full history for 25 such symbols, so the data to render them exists. |
| 33 | high | consistency | dashboard, /spending, /recurring, /investments, /accounts/[id], /transactions | `template.tsx` remounts on every navigation and none of the windowed/lens/month/sort state is in the URL. The tell is the inconsistency: chart MODE round-trips through URL + app_settings while the range pill three pixels away does not. | Brush Feb–Apr on the net-worth chart, click "Assets" to see the same window in asset terms → land on the 1Y default with the panel reset. On a phone, Back with a transaction sheet open leaves /transactions entirely. | `app/template.tsx:8` + `components/charts/ChartFocus.tsx:67` + `components/transactions/TransactionsLedger.tsx:109` | Register-only. `lib/view-state.ts` already implements the exact URL > persisted > default contract these need, and `query.ts:3-7` states the doctrine the sheet violates. |
| 34 | high | clarity | /recurring?tab=all | Suggestion cards render name, kind, cadence, amount and confidence% — and not `lastMatchedOn`, `isActive` or `matchedCount`, all three already computed. "100% confidence" measures how regular the PAST was, not whether the series is alive. | Owner confirms "Acme Corp (payroll) · Biweekly · ~$2,943.19 · 100%" because nothing says the last paycheck landed 80 days ago — permanently blessing $5,886/mo of phantom income. 31 confirms = 31 full navigations. | `components/recurring/AllSeriesView.tsx:53-97` | Register-only. Corroborated by rank 8's DB check. Explains why 15 series at ≥1.0 confidence have never been confirmed: status barely affects money, since upcoming/calendar/forecast treat detected and confirmed identically. |
| 35 | high | correctness | /recurring/[id], /recurring, dashboard, forecast | Detection identifies a merchant-less group by `(merchantId IS NULL, accountId, name === normalizedDescription)`. The rename control writes an arbitrary name and its docstring **falsely** asserts grouping is unaffected. | Rename "ATM CASH DEPOSIT" → "Paycheck (cash job)". After the next import: a renamed series with stale stats and zero charges behind it, PLUS a duplicate suggestion card for the same money, history split across both. | `services/recurring-detail.ts:365-376` vs `services/recurring.ts:402, 408-410` | Register-only. `recomputeSeriesStats` bails when `analyzeGroup` returns null, which is why the orphan keeps stale numbers. |
| 36 | high | clarity | /imports | `importStatementFiles` returns `FileOutcome[]` with six per-file counters plus a status and a message for every failure mode — and `uploadStatementsAction` discards the return value entirely. The demo CLI loader prints per-file errors; the product does not. | Drop November's PDF after already importing November's QFX: every row is `skippedOwned`, the file lands "Parsed" with `Txns 0`, and the screen is byte-identical to a successful import. Four such 0-txn files already exist on the real DB. | `app/imports/actions.ts:13-21` | Register-only; independently confirmed on the real DB by B11. |
| 37 | medium | consistency | /recurring, /budgets, /merchants/[id], /settings, /transactions, dashboard | 87 `revalidatePath` calls across 8 action files, hand-rolled, wrong in both directions: `createPredictedBudgetsAction` revalidates `/` (which has no budget UI) and no budget action revalidates `/categories/[id]` (which renders a live budget card). | Owner dismisses a phantom payroll series on /recurring to fix his forecast, taps Dashboard, and the bills strip still shows it from the router cache — so he dismisses it again. | `app/recurring/actions.ts:33` + `app/budgets/actions.ts:136-139` | Register-only. `imports/actions.ts:7` already names its set as a const — the pattern exists. |
| 38 | medium | clarity | /accounts/[id], /, /accounts, /categories/[id], /imports, /investments | Twelve `{x.length > 0 && (…)}` sections with no else branch. Two are load-bearing: `accounts/[id]:195` wraps BOTH the "Recent transactions" heading and the "All transactions →" link, and `page.tsx:188` gates the hero chart so ScrubChart's own "Not enough history" copy never renders. | CONFIRMED LIVE on Robinhood Crypto: the page contains neither "Recent transactions" nor "All transactions" — an account with zero active rows (exactly the one whose import hit a gap) has no route to its own ledger. | `app/accounts/[id]/page.tsx:195` + `app/page.tsx:188` | Register-only. `recentLedgerRows` hard-filters `status='active'`, so there is also no surface for quarantined rows. |
| 39 | medium | clarity | /transactions, /imports, /budgets, /recurring, /spending, /investments, /accounts | `EmptyStateProps` is exactly `{title, description}` — no children, no action, no href — so nine empty screens are dead ends. Only `/investments` hand-rolls a sibling Link, proving both the need and the workaround. | The dashboard first-run state has **zero interactive elements**, and reads `totalAccounts` off the last series point rather than the accounts table — so a user with five saved accounts and no daily_balances is told "No accounts yet" and concludes the save failed. | `components/ui/EmptyState.tsx:3-6` + `app/page.tsx:111` | Register-only. One optional `action?: ReactNode` prop on an 18-line component fixes all nine sites. |
| 40 | medium | correctness | /settings (rules) | `retroApplyRule` writes `set.categoryId` unconditionally without comparing to the current value, so every matching row is written and pushed to `undoRows` regardless of change. | Press Re-apply five times: the badge still says "would change 300", history says 1,500, the ledger is unchanged. That count is the ONLY preview before an unconfirmed bulk rewrite — and the seeded "ATM/cash deposit → Salary" rule, which once mislabeled $52,625 as income, sits enabled at the top of that list. | `services/rule-corrections.ts:216-224, 244` | Register-only. **Doctrine correction (from the real-DB pass):** the rules path's `source='user'` shield is CLEAN — `retroApplyRule` uses `{excludeUserSet:true}` and `previewRuleMatches` uses the identical predicate. Do not "fix" that half. |
| 41 | medium | correctness | /settings, /transactions, /investments, /spending, /imports | Six dead controls/paths: the Claude confidence minimum is never passed (hard-coded 0.8 always wins); the AI cap coerces empty→0 and permanently disables Claude; `suggestedCategoryIds` is hardcoded `[]` so the suggestion pill can never fire; `correctCategoryAction` has zero callers; `exact:true` is hardcoded so three honesty affordances are unreachable; `loadSpendingCategoryTxns` has no consumer on /spending. | Owner sets Claude confidence to 0.99 expecting everything flagged; the next run flags exactly what it would at 0.8. He clears the AI cap field to retype it, saves, and Claude is silently off behind a red alert that reads like an overspend. | `app/settings/page.tsx:47,55-57` + `services/ledger-rows.ts:67` + `services/portfolio.ts:159` | Register-only. |
| 42 | medium | a11y | all 15 routes | No route-change announcement and no focus management anywhere. `usePathname` is used only for active styling. `#main` already carries `tabIndex={-1}` for the skip link, so the anchor for the fix exists and is unused. Router-refresh mutations announce nothing at all. | A screen-reader user presses Enter on "Spending": 0.5–2s of silence, `main` is replaced, the virtual cursor is still on the nav link, the reader says nothing. Same for "Move Chase Checking up". | `app/template.tsx:7` + `components/shell/AppShell.tsx:62-66` | Register-only. |
| 43 | medium | correctness | e2e/*.spec.ts, playwright.config.ts | Five structural gaps: `grep scrollWidth e2e/` = **0** (no overflow assertion in 243 tests, and screenshots clip the viewport); widths are 320/768/1024/1440 with no 390 and no 2560; axe has only ever run at 1280×720; one Chrome project with no `hasTouch` so every `pointer-coarse` branch is unexecuted; and all three keyboard tests target `/design/stage-0a`, which `notFound()`s in production. | Six overflowing route/viewport combinations shipped through a green gate. Deleting the stage-0a preview as dead code silently removes the entire keyboard suite. | `e2e/visual.spec.ts:7` + `e2e/keyboard.spec.ts:19` + `playwright.config.ts:41` | Register-only; every grep independently reproduced by the B-series (B16). 98 `*.test.ts`, 0 `*.test.tsx` — no component test exercises a rollback, a rejected action or a zero-value render. |
| 44 | medium | craft | all 15 routes | No type scale: 632 of ~685 type declarations are 10–14px, 39 of 49 `h2` section headings are byte-identical to body text, `globals.css` defines **zero** typography and spacing tokens (a direct violation of the project's own web rule), and 119 sub-12px sizes are raw literals across 58 files. | On /budgets a section header, a budget name, the money, the verdict and a destructive control all render between 11 and 14px. There is no visual answer to "what should I read first", and any readability fix today touches 58 files. | `app/globals.css:189-190` + `components/ui/PageHeader.tsx:9` + `components/ui/StatCard.tsx:29` | Register-only. The "page hero number" takes six different sizes across routes while `StatCard` — built for exactly that — has 2 importers. |
| 45 | medium | consistency | /settings, /imports, /accounts, /budgets, /investments, /spending, /recurring, /transactions | Sixteen hand-rolled primary buttons in eight geometries; `Button`'s `md` matches two of sixteen. Only 8 have an `active:` state, 2 handle `disabled:`, and **none** can accept `pending` — the mechanical root cause of rank 18. `Button` also ships a `destructive` variant the destructive controls do not use. | Owner presses Save on the Settings form; the button neither disables nor spins; he presses again and the void action fires twice. | `components/ui/Button.tsx:32` | Register-only. |
| 46 | medium | craft | every surface, dark theme only | The card shadow is a hardcoded `oklch(0% 0 0/0.04)` literal copy-pasted into four components, with no `--shadow-card` token — while `--shadow-overlay`/`--shadow-sheet` both have proper dark variants. On a 0.19-lightness background a 4%-black shadow is arithmetically invisible. | The dashboard bento of six cards reads as one undifferentiated slab at night, separated only by a 0.31-lightness line, while the same screen in light mode has real layering. | `components/ui/SurfaceCard.tsx:12` | Register-only. Zero `dark:` variants exist in any `.tsx`, so a hardcoded value is a guaranteed dark-mode bug. |
| 47 | medium | consistency | /budgets, /categories/[id] | Two contradicting budget status systems from the same object: `/budgets` renders `pace` (fires only when the projection overruns), `/categories/[id]` renders `alert` (fires at 80%). Neither page mentions the other exists. `categoryBudgetRef` takes `.find()`'s first match from a list sorted daily<weekly<monthly<annual. | On day 28 of 30 a category at 85% shows GREEN "On track" on /budgets and AMBER on its category page. A category with a daily $30 and a monthly $1,430 budget renders the daily one, hiding the budget he actually manages. | `services/budgets.ts:144-148` + `services/category-detail.ts:171-180` | Register-only. |
| 48 | medium | a11y | /spending, /, /accounts/[id], /investments | Chart interaction is pointer-only outside ScrubChart: recharts `<Bar>` onClick is not focusable, x-axis ticks are focusable **only for month buckets** (and the default period's buckets are days), Sankey ribbons are `aria-hidden` with no table toggle on /spending, and no key sets, extends or commits a brush window. | A keyboard user on the dashboard hears each day's value and has no way to select Feb–Apr and cross-filter the linked panel — the interaction the panel's own copy instructs them to perform. Typing a From date inside a sparse span snaps back in silence. | `lib/scrub.ts:24-37` + `components/spending/CashFlowChart.tsx:97, 236, 256` | Register-only. |
| 49 | medium | responsive | /transactions, /, /spending, /accounts, /categories/[id] | Responsive strategy is `display:none`: twelve sites drop content on mobile, four components make the same account-name decision at three different breakpoints and one made the opposite call. Hiding also strips the accessible name — a `hidden sm:flex` badge wrapper removes the LetterBadge's sr-only text. | On the surface he uses most, from the device he uses most, the owner cannot tell which of eight accounts a row came from, cannot see that a row is a transfer, and gets no compensating density. | `components/transactions/TransactionsLedger.tsx:294-298` | Register-only. Also dropped on mobile: share bars, MoM deltas, per-account sparklines, and the heatmap magnitude bar — whose own header argues at length for the colour wash it then disables. |
| 50 | medium | a11y | /transactions, /, /accounts | `aria-label` on bare `<span>`s makes the needs-review dot and the unreviewed count invisible to AT, on two surfaces — while two sibling primitives already solve it and say so in comments (`NumberRoll.tsx:19-21`: "aria-label on a generic span is prohibited ARIA"). | A screen-reader user working the ledger cannot distinguish a row awaiting review from a verified one — and on mobile the visual dot is the only signal left after the T/R badges are `display:none`'d. | `components/transactions/TransactionsLedger.tsx:299-301` | Register-only. The unreviewed-count dot is also inert to the mouse even though `?view=review&account=<id>` is a supported deep link. |
| 51 | medium | clarity | global shell, /categories, /merchants, /accounts, /investments | The command palette is the only index of the learned entity layer and has no visible trigger; `/categories` and `/merchants` both 404 (each directory holds only `[id]/`). On touch there is no route to any merchant page, any cash wallet, or any closed position. | Owner wants to see what Claude decided about his 434 merchants in pass 24. There is no screen, no index, no search — while the palette's 434-merchant + 67-category payload is serialized into **every** route's RSC payload for a control that cannot be opened on his device. | `components/shell/AppShell.tsx:50` + `services/command-index.ts:66, 73-75` | Register-only. `command-index.ts:66` still routes categories to `/transactions?category=` behind a comment saying "until /categories/[id] lands (Stage 3)" — it landed, and `command-index.test.ts:48` now pins the stale routing, so the test protects the bug. |
| 52 | medium | a11y | all ChartFocus and Sheet consumers, every Popover | Two modal patterns with incompatible focus/Escape contracts: `Sheet` registers a modal KeyScope, `ChartFocus` registers nothing and lets `showModal()` auto-focus Close — the exact anti-pattern `Sheet.tsx:64-67` documents avoiding. Bare `Popover` provides no focus management at all, so five consumers re-implement it. | A keyboard user who Escapes out of the amount editor loses their place. `ToastMnemonic` registers the plain `a` key globally with `active:true` and discards the handler's false return, so `a` is preventDefault'd app-wide even with no toast. | `components/charts/ChartFocus.tsx:128-171` + `components/ui/Popover.tsx:73-136` + `components/ui/ToastMnemonic.tsx:16-24` | Register-only. |
| 53 | medium | responsive | /, /accounts/[id], /investments, /investments/[t]/[s], /accounts | `touch-none` on the chart plot creates a 25–30%-of-viewport scroll dead zone above the fold on four routes, for a drag-to-zoom gesture that has no touch equivalent and no on-screen affordance. `ManagedAccounts.tsx:104` puts `touch-none` on a drag grip whose HTML5 `dragstart` cannot fire from touch at all. | Owner scrolls his dashboard with a swipe starting on the net-worth chart. Nothing moves; he must find the ~41px margin beside the plot. | `components/investments/ScrubChart.tsx:545` + `components/accounts/ManagedAccounts.tsx:104` | Register-only. `touch-action: pan-y` preserves vertical scroll while still letting horizontal drags reach the brush. |
| 54 | medium | correctness | /spending, /categories/[id], /recurring, /merchants/[id], /investments, /budgets | Five sign/zero defects: `formatCentsSigned` returns `+$0.00` for zero at 39+ sites; a refund-dominant category renders a bare negative under "Where it went"; `Math.abs(flowCents)` makes an inflow look like spend; a negative month draws a 2% stub identical to $0; and the amount-history variance is inverted, so paying MORE than expected shows a plus. | A returned $600 laptop makes Shopping read "On track · −8% used" with an empty bar and "Left $650.00" on a $600 budget, while its category page shows the same money as $600 of spending. | `lib/money.ts:80-83` + `app/categories/[id]/page.tsx:188` + `components/recurring/AmountHistoryChart.tsx:44-51` | Register-only. |
| 55 | medium | correctness | /spending, /recurring, /investments | Three sibling month-pagers at three levels of correctness. The worst drops the error branch entirely (`if (res.ok) setData(...)`) and has no latest-request guard, and none is in the URL. The heatmap has no clamp and no month in its header. | Owner pages the heatmap back to May, the load returns `{ok:false}`, the grid keeps April's cells, the opacity flickers back, and the button appears to have done nothing — a hard failure and an empty month are pixel-identical. | `components/spending/SpendHeatmap.tsx:54-61` | Register-only. `PnlCalendar.tsx:49-69` is the correct implementation to extract. |
| 56 | medium | clarity | /merchants/[id], /recurring/[id], /investments/[t]/[s], /categories/[id] | Every entity detail page is a one-way exit with a breadcrumb naming a parent it did not come from. `/recurring/[id]`'s footer is labelled "← All recurring" while the href resolves to the Upcoming tab. | Triaging 31 detected series from the All tab: every confirm is a full navigation and every back-click deposits him on Upcoming, where he re-clicks All and re-finds his place — 31 times. | `components/recurring/SeriesDetail.tsx:97, 266` + `app/merchants/[id]/page.tsx:35-38` | Register-only. `ui/Breadcrumbs.tsx` provides the `<ol>` + `aria-current` that `/categories/[id]` hand-rolls without. |
| 57 | medium | safety | /transactions (Classify), /settings | Third parties' names leave the machine with no disclosure, no preview and no per-row exclusion. `normalizeDescription` strips masked card numbers and 5+ digit runs — **not person names** — and the queue is by construction the rows the deterministic engine could not identify (the Zelle/Venmo/Wise peer traffic). `grep` for "anthropic"/"privacy"/"third part" in components+app: nothing. | A button that spends real money sending real people's names to a third party never says so, and the settings page that claims "every call is logged" renders none of the 10 populated call records it already loads. | `services/claude-categorize.ts:194-201` + `lib/normalize.ts:20-43` + `app/settings/page.tsx:86-110` | Register-only; escalated by B13 — the shell prints "**your data never leaves this Mac**" on all 15 routes while three outbound destinations exist. |
| 58 | medium | clarity | /, /spending, /recurring, /recurring/[id], /investments, /accounts, /transactions | Nine computed values that answer the page's own question are discarded at render: `idealCents` (so the pace widget cannot answer "am I ahead?"), `upcoming.netCents`, `accountName` on all three dashboard lists, six SeriesDetail evidence fields, `dayChangeVsDay`, `quotedOn`, `latestClose`, `costCents`, `priceDayChangeCents`. | `recurring.ts:24-26` explicitly promises every decision-driving stat is stored "so the UI can show the math"; the UI shows four of nine. "Total return +$1,204" on a holding page has no visible denominator anywhere. | `components/recurring/SeriesDetail.tsx:194-212` + `components/dashboard/SpendingPaceWidget.tsx:20` + `services/holding-detail.ts:298-301` | Register-only. |
| 59 | medium | safety | /accounts (cash sheet), /imports, /accounts/[id], /recurring | Two money-parsing conventions (`Math.round(Number(x)*100)` accepts `1e5` as $100,000) and two validation conventions — six write actions skip Zod entirely, and they are the six most destructive entry points. `uploadStatementsAction` has no file-count cap, no size cap and no MIME check beyond a 512-byte sniff, while `next.config.ts` raises the body limit to 100mb. | `docs/schema.md:22-23` records that enums are application-level only, so the guarded real-DB scripts the owner actually runs bypass every invariant TypeScript enforces — a script writing `amount_cents = 12.5` produces silently wrong analytics with no error at any layer. | `components/accounts/CashWallets.tsx:201` + `app/imports/actions.ts:13-34` | Register-only. |
| 60 | medium | consistency | /recurring, /recurring/[id] | Two definitions of "the charge matched the expectation" inside one feature: the calendar uses a noise band (max $1, 2%, 2σ); the amount-history table uses exact cent equality. "Per charge" also pairs an overridden amount with a σ measured around the DETECTED mean. | An electricity bill averaging $142 ± $9 shows a green ✓ "paid" every month on the calendar and a signed variance on **every single row** of the detail table. Same data, two conclusions. | `components/recurring/AmountHistoryChart.tsx:36-53` vs `services/recurring-calendar.ts:55-79` | Register-only. `classifyPostedAmount` is already an exported pure function — export it to the second consumer. |
| 61 | medium | correctness | /transactions | `groupByDay` runs over the 50-row page slice, so a busy day straddling a boundary prints two different numbers, both presented as that day's net, neither labelled partial. `page` is offset blindly with no clamp. | A day total that is arithmetically false, on the page whose contract is that every number reconciles to the raw ledger. `?page=99999` renders (live, 200 OK) "Page 99999 of 194 · 9688 transactions" with the *filter* empty state and a working Previous. | `components/transactions/TransactionsLedger.tsx:65-82` + `app/transactions/page.tsx:135` | Register-only; the pager half independently reproduced live on the real DB (B12). |
| 62 | medium | clarity | /transactions (Excluded tab), /accounts (cash), /categories/[id] | Missing escape hatches: `txnPatchSchema` supports `restore` and `clearTransfer` and `BulkActionBar` exposes neither; `runCategoryCorrection` discards the server-captured undo whenever a rule prompt matches, offering only "Apply to N"; `deleteManualTransactionAction` has **zero callers in the repository**. | Owner adds a $200 cash spend, realizes a statement already captured it, and there is no delete anywhere in the app. Restoring 200 excluded rows means opening 200 sheets. Mis-tagging one Amazon row escalates to 24 rows plus a permanent rule instead of reverting one. | `components/transactions/BulkActionBar.tsx:87-95` + `app/accounts/cash-actions.ts:38-50` + `components/transactions/correct-category.ts:32-45` | Register-only. |
| 63 | medium | correctness | /accounts | Cash wallets are second-class: `createAccountAction` skips the `$0` opening anchor that `createCashWallet` seeds (and the Add form offers "Cash"); choosing Cash in the Edit sheet removes an account from **both** lists on /accounts while it still contributes to net worth; wallet rows have no rename, no href, no archive, no ledger. | Add "Wallet" under Cash from the bottom form: it reads "no balance yet" forever and the first $20 spend moves nothing. Re-home SoFi Checking to Cash and it renders NOWHERE on /accounts — reachable only by ⌘K, which has no visible trigger. | `app/accounts/page.tsx:25` + `app/accounts/actions.ts:44-50` + `components/accounts/CashWallets.tsx:65-84` | Register-only. |
| 64 | medium | clarity | / (Flow mode), /accounts/[id], /investments | The signature brush interaction is taught where it does nothing: `PeriodActivityPanel` renders unconditionally beneath the hero, but Flow mode draws a Sankey with no brush — and the mode persists in app_settings, so it is permanent. `/accounts/[id]` passes `selectable` but no `history`, so the chips never render. | Owner leaves the dashboard in Flow mode, returns, drags across the Sankey, nothing happens, and the app looks broken. CONFIRMED LIVE: brushing May 24–Jun 30 then pressing Focus opens the dialog with no Reset chip; switching to Table captions "3 months, 92 days" for a 10-day brush. | `app/page.tsx:204` + `components/accounts/BalanceChartPanel.tsx:207-223` + `components/charts/ScrubTable.tsx:102, 147-149` | Register-only. |
| 65 | medium | clarity | /budgets, /categories/[id], /, /spending | The drill-down contract is upheld everywhere except where it matters: the budget Spent figure is inert text although `transactionsHref` already emits the exact URL; /budgets never states total spent, remaining or overall pace; the dashboard's Assets/Liabilities and coverage warning link nowhere; /spending's Net and Savings-rate cards both open the identical whole-period list. | To answer "am I ok this month?" the owner must read ten budget cards and mentally add ten Spent figures — while the page computes that sum ten times and never prints it. Budgeted $6,799.00 vs actual $5,670.51, unstated. | `components/budgets/BudgetRow.tsx:170-173` + `app/budgets/page.tsx:95-101` + `lib/spending-stat-cards.ts:82` | Register-only. |
| 66 | medium | correctness | /spending, /investments | Charts render misleading or blank output in reachable states: a Day period produces one bucket and four `dot={false}` lines, so the plot is blank under a full four-series legend; income series are uncapped while spending is capped at 7 + Other; the holdings sparkline applies today's quantity to 30 historical closes; and the Value/Return charts have different x-extents while the prop doc asserts they are "aligned 1:1 by day". | A user on Day granularity sees an empty chart with a full legend and no empty state; a user reading a holdings row sees a 30-day trend for a 4-day position, tinted by a fictitious delta. | `components/spending/CashFlowGraph.tsx:139-165` + `services/portfolio.ts:597-600` + `services/spending.ts:233-235` | Register-only. |
| 67 | medium | correctness | /accounts, / (arrange mode) | Reorder has no optimistic update and no rollback on transport failure: `ManagedAccounts.move()` only refreshes on success (so a second click sends a stale transform and silently loses a move), while `ArrangeableSections.persist` rolls back inside `.then` — skipped entirely on a rejected promise. The drop target is the whole section wrapper. | A drag-to-zoom brush released over the net-worth plot in arrange mode reorders the dashboard instead of selecting a window. Institutions cannot be reordered at all, so the owner's largest holding sits permanently below a negative card. | `components/accounts/ManagedAccounts.tsx:47-63` + `components/dashboard/ArrangeableSections.tsx:46-54, 90-91` | Register-only. |
| 68 | low | craft | /, /accounts/[id], /imports, /categories/[id], /recurring/[id] | Raw DB values leak into the UI: ISO dates (`2026-07-04`, `as of 2026-07-19`) while `formatDayShort` is used in the same card; the Drizzle column enum rendered verbatim ("Food · expense"); `<th>`s with no scope; and `truncate` on an inline span inside a flex item, where it does nothing. | Nothing breaks — but these are the clearest signals that a surface is a developer's data dump rather than a product, and they are on the screens the owner would screenshot. | `components/transactions/RecentTransactions.tsx:73` + `app/categories/[id]/page.tsx:127` | Register-only. |
| 69 | low | responsive | all 15 routes at ≥1440px | No wide tier. At 2560×1440: sidebar 216 + main 1024 = 1240px used, **1320px (52%) empty**, main asymmetric to the sidebar. Breakpoint histogram: sm 42, md 34, lg 12, xl 0, 2xl 0. Chart heights stop stepping at 768px; the allocation donut is a flat `h-44` from 320 to 2560. | This is the direct obstacle to the owner's stated goal of ambitious data visualization on a monitor — the flagship net-worth chart is 256px tall on a 27-inch display, and /transactions is 3,578px of scroll with half the width blank. | `components/shell/AppShell.tsx:65` + `components/investments/ScrubChart.tsx:220` | Register-only. |
| 70 | low | craft | /, /spending, /budgets, /categories/[id], /investments, /accounts | Micro-charts are five hand-rolled idioms with no shared scale, tone, empty state or interaction: the pace widget never draws `idealCents`; the budget bar clamps at 100% so 108%-over and 4,898%-over are pixel-identical while `aria-valuenow` and `aria-valuetext` disagree; `MonthlyTrendBars` puts the amount only in an aria-label; `Sparkline` returns null below 2 points while `HoldingSparkline` returns a visible "—". | The owner cannot read a single number off /categories/[id]'s only chart on his phone, and cannot distinguish a mildly-over budget from a catastrophically-over one anywhere on /budgets. | `components/ui/Sparkline.tsx:25` + `components/budgets/BudgetRow.tsx:50-58` + `components/spending/MonthlyTrendBars.tsx:23` | Register-only. |
| 71 | low | craft | all 15 routes | There is effectively one motion in the app: `transition-colors` ×114 (all specifying no timing function, so they inherit Tailwind's default), `--duration-normal` in 4 files, `--duration-slow` in 0, `--ease-in-out-sine` in 0. `active:` states exist on 14 elements app-wide. | Combined with hover-gated affordances (the rename pencil, the StatCard arrow, DataTable row controls), on a phone the overwhelming majority of interactive elements give the same feedback as static text — the app looks read-only. | `app/globals.css:193-200` + `components/ui/InlineEditableText.tsx:111-128` | Register-only. Three of six authored easing curves are dead — a dead token is a lie about the system. |
| 72 | low | craft | all 15 routes | No spacing system: ten card-padding values across 47 containers, four undifferentiated vertical rhythms, five eyebrow specs in eight combinations, and `globals.css` defines no `--space-*` token. Four raw `<table>`s bypass `DataTable` entirely. | Two adjacent dashboard cards have visibly different breathing room for no semantic reason, and there is no way to say "this section matters more". The raw tables are the mechanical reason /imports' 88 rows have no sort, no search and no row links. | `components/ui/SurfaceCard.tsx:12` + `components/ui/StatCard.tsx:19` + `app/imports/page.tsx:168` | Register-only. |
| 73 | low | a11y | /investments/[t]/[s], /merchants/[id], /imports | Static metadata and repeated accessible names: three open holdings produce three tabs reading "Holding"; `ChartFocus` is labelled "Holding" against its own doc; and 88 buttons are named exactly "un-import" with no disambiguation, for an irreversible hard delete, inside a table whose row context is truncated in a different cell. | A screen-reader user tabbing the imports ledger hears the same word 88 times with no way to know which file is focused, before an operation that deletes thousands of rows. | `app/investments/[assetType]/[symbol]/page.tsx:29` + `app/imports/page.tsx:198-203` | Register-only. |
| 74 | low | consistency | /transactions, /recurring/[id], /budgets, /imports, /spending | Nine doc-comment drifts in a codebase where comments are unusually load-bearing: "↑/↓ flips through rows with the sheet open" (no such binding exists, and the sheet disables the ledger's key scope); the rename docstring (rank 35); "no predicted number is ever a bare figure" (it is a `title`); `RECONCILIATION_LABEL` declared and never referenced (the only copy for two states); `supersededBy` declared and never written; `needs_claude`/`parsed_with_claude` have labels nothing sets. | A keyboard user in the sheet must Tab to the chevron buttons, and the next maintainer distrusts every comment in the surrounding files. | `components/transactions/TransactionsLedger.tsx:88-90` + `app/imports/page.tsx:24-30` | Register-only. The e2e spec clicks the chevrons, so it never caught the missing binding. |
| 75 | low | clarity | /accounts/[id], /recurring/[id], /spending, /investments | Copy/unit/grammar defects on numbers he must act on: "Amount owed $1,041.29 · 30 days **+$361.00**" in red (colour right, glyph backwards); "charges annual around the 12th"; an unnamed amber pace line in the legend; an Excluded honesty bucket with a row count and no dollars; a find-or-create that unconditionally toasts "Added X"; and a case-sensitive asset type (`/investments/Stock/AAPL` 404s while `/investments/stock/aapl` works). | The user cannot tell whether his exclusions are immaterial or hiding five figures, and a title-cased pasted holding URL 404s. | `app/accounts/[id]/page.tsx:55-65` + `components/recurring/labels.ts:76-85` + `services/spending.ts:731` | Register-only. |
| 76 | low | clarity | /spending, /categories/[id], /, /investments, /accounts/[id], /recurring/[id] | Four silent no-ops on inputs just typed: `applyCustom` returns without navigating and without an error while the button stays enabled; `applyWindow` bails silently on the <2-point rule; `commit()` calls `close()` outside the try/catch so a parse error destroys the draft; `stepPeriodParams` pages past the end of the ledger with no bound. | Owner types "1 150" into the expected-amount editor, gets a red toast, and the popover is gone along with what he typed. `InlineEditableText.tsx:74-78` already does this correctly. | `components/spending/PeriodSelector.tsx:85-91` + `components/investments/ScrubChart.tsx:398-404` + `components/recurring/CadenceSentence.tsx:263-271` | Register-only. |
| 77 | low | performance | /budgets, /spending, /recurring, /recurring/[id], /transactions, /investments | Expensive work computed and thrown away, or fetched eagerly for a popover nobody opened: `budgetGuidanceCents` for every budget (82.3ms of ~159ms) to fill a hover popover; prior-period breakdown always computed and rendered only for month granularity; all three /recurring tabs plus `forecastCurrentMonth` (112.6ms) computed and one rendered; every live series selected as merge candidates on every render; `loadSheetPanel` (4 queries) to display one merchant name. | The most decision-relevant number on /budgets is computed on every load, costs half the page's render budget, and is reachable only by mouse hover on a device with no hover — and what it says is that 8 of 10 budgets are materially wrong. | `app/budgets/page.tsx:51-53` + `app/recurring/page.tsx:32-35` + `services/recurring-detail.ts:164-228` | Register-only. |
| 78 | low | safety | global (middleware, undo endpoint) | Pre-hosting blockers: `undoAction` accepts a fully client-supplied `UndoPatch` and writes 10 columns onto whatever ids it names plus deletes any rule by id — shape-validated only, no ownership check, no issued-by-us token. And `middleware.ts` 403s every Host that is not localhost. | The first deploy returns 403 for every request; the first multi-user deploy ships a cross-tenant write primitive. Nothing in the repo, README or docs acknowledges that hosting requires replacing the guard with real auth. | `src/middleware.ts:14-20` + `app/transactions/actions.ts:477-495` | Register-only. Harmless today (single user, loopback); far cheaper to sign the patch now than to retrofit across 12 call sites. |
| **B-series below: found only against the owner's real 9,753-row database. Single lens, every number measured live. Invisible on the demo DB the e2e suite runs against.** | | | | | | | |
| 79 | critical | correctness | /spending, /categories/[id] | `topMerchants` groups merchant-less rows by `strippedDescriptionKey()` and then builds the drill-down as a full-text `q` search **for that derived string**, while the ledger's `q` is a literal `LIKE` against raw/normalized description. The key has had dates, `&`, CUSIPs and digit runs removed, so it matches only when stripping was a no-op. | Measured across all history: **330 of 627 unlinked merchant groups (52.6%) open an empty ledger — $34,403.46 unreachable.** His single largest merchant-less payee (40 transactions) is a dead link on both surfaces. On the demo DB the same probe returns 0 dead links, which is why nothing caught it. | `services/spending.ts:685-687` + `services/transactions-query.ts:114-121` + `lib/description-key.ts:79-98` | Measured live (probe3). Fix: give the ledger a first-class `descriptionKey` filter that recomputes the key server-side — `review-inbox.ts:25-27` already does exactly this for its clusters. |
| 80 | critical | clarity | /spending, /, everywhere | **The app's two number systems disagree by $116,514.75 over the ledger's life and nothing connects them.** Cash flow says net −$31,656.41; net worth says +$84,858.34. 100% of the gap is the four category kinds analytics excludes — **+$93,004.29 across 4,587 rows (47% of the ledger)** — and nothing else in the app totals them either. | `Gifts received`: $46,928.00 in, **$0.00 out**, 35 rows, all hand-categorized — money that arrived and stayed, in no total on any screen. `Internal Transfer` nets +$46,806.37, which is impossible: 740 paired rows net $0.00 (detector sound), 250 unpaired legs net +$46,806. | `services/analytics.ts:16-18` | Measured live. **This is a missing concept, not a bug**: a row has exactly two destinations — income (counts) or transfer (vanishes) — and there is no third state for "money that arrived, isn't earnings, and isn't a move between my own accounts". |
| 81 | high | correctness | / (hero net-worth chart) | The "this isn't my money" law is enforced in exactly one of the two number systems. Analytics honours `Family pass-through`; the balance/net-worth layer has never heard of it. The in-flight bridge cannot help — there is no `transfer_group_id` on a pass-through. | **Every one of the top eight single-day net-worth moves in the 1,426-point series is a `Family pass-through` row.** A $29,800 wire in on 2026-05-06 and $25,000 out on 05-07 put the all-time peak at $116,015.17 — which the hero's peak marker will label. The bridge corrects 200 days by $8.70–$100.00 and never touches a five-figure move. | `services/dashboard.ts:37-40` (the `inTransitCents` pattern to copy) | Measured live (probe8/probe9). Fix is additive: a `passThroughCents` band on `BridgedNetWorthPoint`, drawn hatched, with the hero saying "$30,963 of this is pass-through". |
| 82 | high | correctness | / (hero), every balance chart | 87% of the net-worth chart is a partial sum and only the **last** point's honesty flag is read. Coverage histogram: 402 days drawn from **one account of nine**; only 188 of 1,426 days are what the axis label implies. | `netWorthSummary` reads `complete` off `series.at(-1)`, which is `true` today, so the hero reports full coverage while 87% of the curve behind it is a different number of accounts than the point beside it. | `services/dashboard.ts:133` + `services/derivation.ts:284-345` | Measured live. The series already carries `coveredAccounts/totalAccounts/missingAccounts` per point — render it as a ribbon and label the scrub tooltip "4 of 9 accounts". Nothing to delete. |
| 83 | high | correctness | /investments | `refreshPrices` writes "today's quote becomes today's close", so running it on a weekend stamps Friday's price with **Sunday's date and `source='yahoo'`** — indistinguishable from a real quote. The whole app's "today" is 2026-07-19; the actual today is 2026-07-27. | `Day %` reads **+0.00% for 8 of 9 holdings** while the header announces "Today +$141.95 +0.16%" — a number that is 100% ETH. The as-of is a Sunday with no 07-18 row at all. | `services/prices.ts:378-391` | Measured live. Fix: a distinct `source='carry'` for synthetic closes, no close written for a day the provider did not trade, and "— market closed" instead of "+0.00%". |
| 84 | high | correctness | /spending, /, /recurring | **Two different "projected spending" for the same month, $635.48 apart (9.7%), one click from each other**, both labelled "projected", with the dashboard linking to both: /spending's linear pace ($6,584.31) vs /recurring's 3-month trailing average + trend ($7,219.79). | Neither states its basis in terms the other can be compared against, and no surface reconciles them. | `services/spending.ts` (`projectPace`) vs `services/forecast.ts:157+` | Measured live. Fix: pick one engine for the headline and label the other "remaining fixed + variable". /recurring's "Show the math" table is the better one — promote it and have /spending's pace chart draw that projection as its target. |
| 85 | high | correctness | /recurring, /categories/[id] | One page, one series, **two "next expected" dates — and one is in the past**. `listSeries` renders the stored `nextExpectedOn` verbatim while `forecastCurrentMonth` rolls it forward past today via `projectOccurrences`, and nothing ever writes the rolled value back. | Three series currently display a past date as "Next", including `UBER *ONE` at **next=2025-06-25 (13 months stale)** — which is simultaneously sitting in "Suggestions · 3 to review" at **100% confidence** asking him to Confirm it. | `services/recurring.ts:642-651, 576` vs `services/forecast.ts:126-152` | Measured live (probe12). One-line fix: `listSeries` should display `projectOccurrences(...)[0]` exactly as the forecast does. |
| 86 | high | clarity | /investments, /transactions | **Two irreconcilable answers to "how much have I put into investments?", $101,899.59 apart**: the portfolio's NAV-flow walk says net contributed **+$81,722.99**; the ledger's own `Investment Contribution` category says **−$20,176.60**. | Both are defensible (one counts security purchases inside the brokerage, the other counts bank→broker cash moves) but nothing on either page says so and there is no link between them. The most confusing pair of numbers in the app for anyone who looks at both. | `services/portfolio.ts` (contribution walk) vs the `Investment Contribution` category | Measured live. |
| 87 | medium | consistency | /investments, /accounts, /transactions, / | Four smaller cross-surface disagreements, all confirmed in the live render: "Month P/L +$7,300.67" sits above "Total return +$7,245.59 all time"; "Realized by sells −$765.31 · 2 sells" (July) vs "Realized P/L +$3,018.13 · 88 sells" (header) with no scope label on either; a credit card renders **+$11,020.45** on its row and **−$11,020.45** in its own group header; and the nine accounts appear in two different orders on two pages. | Each is arithmetically defensible and none is explained, so every one reads as a bug to the person who notices it. | `components/accounts/InstitutionCard.tsx:72` + `services/accounts.ts:80` vs `app/transactions/page.tsx:81` | Measured live. |
| 88 | medium | clarity | /imports | Four statements imported **zero transactions** and the page reports "Open gaps 0". They render identically to successful imports — "Parsed", `Txns 0`, an un-import link — under a header promising every statement must reconcile to the cent. | A statement that parsed to nothing is the most likely real failure mode of a PDF pipeline, and it is the one state the page cannot express. | `app/imports/page.tsx:51-64` | Measured live (4 of 88 files). `Txns 0` is a failure, not a status: badge it, exclude it from "Reconciled periods", and let "Open gaps" count it. |
| 89 | medium | safety | global shell (all 15 routes) | The persistent chrome prints **"Local-first · your data never leaves this Mac"** while three outbound destinations exist (Anthropic, Yahoo, Coinbase) — and what is sent to Anthropic includes strings like `CARD PURCHASE LOVE PEACE CONVENIENC BRONX NY CARD 7782`: his card's last four and the street address of his ATM. | The app makes the opposite claim, in the header, permanently, on every page. Before hosting with auth, that line is a liability. | `components/shell/AppShell.tsx:46` + `lib/normalize.ts:29` | Measured live. Escalates rank 57. Fix: "your statements stay on this Mac", plus a one-time disclosure and a preview of the exact strings on the Run-categorization button. |
| 90 | medium | correctness | dev environment, /transactions, /settings | **Root cause of the owner's open "the Claude button stopped working" bug**: `.gitignore` ignores `.env*`, so every dev server started from a git worktree has no `ANTHROPIC_API_KEY`. The key is neither expired nor deleted — it is absent from the worktree. | Compounding it: /settings says "No ANTHROPIC_API_KEY — the app fully works" while /transactions, on the same boot, renders "Classify 11 merchants with Claude ≈ $0.01 est." Two pages, one env var, no shared truth. | `.gitignore:12` + `services/claude-categorize.ts:131-135` + `app/settings/page.tsx:34` | Measured live. Fix: copy/symlink `.env` into worktrees, and gate the HeaderStrip button on the same boolean /settings already computes. |
| 91 | medium | clarity | /settings | The backups directory is **80 files / 505 MB** under a UI that promises "14 daily + 6 monthly". Retention only prunes what it names; the ad-hoc `pre-*` snapshots written by the guarded real-DB scripts and every orphaned `-wal`/`-shm` sibling grow forever, are never listed and are never pruned. | The page describes 15 files while the directory holds 80 and half a gigabyte. A first boot on a new day writes 2 × 12.8 MB. | `db/backup.ts` retention + `app/settings/page.tsx:113-130` | Measured live. Compounds rank 4. |
| 92 | medium | safety | /design/stage-0a, e2e | `/design/stage-0a` returns **200, 341 KB**, un-gated and in the build, rendering his real "Net worth $84,858.34" — and it is the page the entire keyboard-grammar gate runs against, plus one of the routes inflating the "all routes pass axe" claim. | The keyboard gate proves focus trapping and Escape precedence on a surface users cannot reach, which is exactly why the a11y audit found the real routes lacking while the gate stayed green. | `app/design/stage-0a/page.tsx:49` + `e2e/keyboard.spec.ts:9, 18` + `e2e/a11y.spec.ts:23` | Measured live. Do not delete it — gate it on `NODE_ENV !== "production"` and re-point the spec at `/transactions`. |

---

## Claims that did not survive verification

Nothing here was deleted from the audit — it is recorded so the owner can see what was checked and
rejected, and so nobody re-files it next pass.

### A. Whole findings whose headline was falsified

| Register # | The claim as filed | Why it failed | What survives |
|---|---|---|---|
| **13** | "The `source='user'` shield has two holes … a Claude run rewrites decisions he made by hand across seven guarded DB passes." | All three lenses downgraded. Both cited UPDATEs are gated on `isNull(transactions.categoryId)`, so they **cannot** overwrite any categorization. The exposed state (user-touched AND uncategorized) measures **0 rows** on the owner's real DB and 0–1 on the demo DB, and no UI path produces it — `CategoryPicker` has no clear option and every user write sets category + source together. The doc comment at `merchants.ts:107-108` is accurate as written. | One missing WHERE clause as defence-in-depth, and the separate real issue that Claude stamps its own category onto transactions after correctly refusing to overwrite the user-set merchant default. Kept at **medium**. |
| **21** | "Half the navigation is off-screen on a phone … no cue that Spending, Budgets, Recurring, Investments and Settings exist." | Two lenses rejected. `MobileNav.tsx:14` sets `overflow-x-auto` — the rail is a deliberately scrollable strip and every item is reachable by swipe. The repo's own measured `docs/live-responsive-findings.md` explicitly lists this rail under "what is already right" and excludes it from overflow measurement by design. | No `scrollIntoView` on mount (the active pill can start outside the visible box), no edge fade, and no visible ⌘K trigger. Kept at **medium**; still a two-line fix. |

### B. Sub-claims inside otherwise-confirmed findings

| Register # | Sub-claim | Verdict |
|---|---|---|
| 1 | "Nine irreversible actions" / "the app contains no confirmation primitive at all" | **False on both counts.** Archive is a toggle (`accounts/[id]/page.tsx:265-278` renders "Restore account") → 8 irreversible + 1 unexplained-reversible. `EditAccountSheet.tsx:66,210` is a real confirmation primitive (checkbox gate + rejecting toast) and `RulesManager.tsx:100-104` already ships a lossless undo with a rule snapshot. |
| 3 | "`MerchantDefaultCategory.tsx:55` does not even check ok … permanently inert" | **Miscited.** `:43-47` resets busy as the first statement and does check `r.ok`. Only a *rejected* promise (no `.catch`) leaves busy stuck. |
| 4 | "no size" on the backups card | **False.** `settings/page.tsx:25` computes `sizeKb` and `:126` renders it. Also: `MONEYAPP_SKIP_BACKUP` is set per-process by `playwright.config.ts:50`, not in the owner's shell. |
| 5 | "spending is silently inflated" (the double-count direction) | **Not present on the real DB today.** All 1,166 rows carrying a `transfer_group_id` are already in a transfer-kind category; zero are paired-but-spending-categorised. The mechanism is real and one bulk click creates it — but only the *hiding* direction is live now, and its size is finding 80. |
| 6 | "bulk restore/exclude and the sheet flags desync the cache" | **Two-thirds false.** Both `active` and `excluded` are in the replay set, so the ordinary Exclude/Restore pair changes nothing. The invalidating transitions are **quarantined → active** and `upsertHolding`. `setTransactionFlags:296-298` is the `reviewed` block, not the status block. |
| 7 | "asOf is rendered once, as a raw ISO string" | **False.** `accounts/[id]/page.tsx:155-156` renders `as of {day} · {BASIS_LABEL}` on the same line as the "Today" chips, and `investments/page.tsx:139` renders `overview.asOf`. Also: the trailing carry-forward producing `complete:true` is deliberate and load-bearing — do not tighten it. |
| 10 | "no reconciliation note anywhere" | **False.** `HonestyBucketsCard` (rendered at `spending/page.tsx:247`) states the uncategorized spend and links to those rows, and `SpendingCategoriesTable.tsx:24` documents the exclusion in a comment. The undisclosed forks are gross-vs-net on refunds and the split asymmetry. |
| 12 | "fabricates a one-day loss on an unpriced acquisition" | **Half-defended already.** `flowsByDay:83-101` contains an explicit guard rolling an unpriced acquisition forward to its first priceable day. The live defects are the missing rebuild and the unconditional `assetType` overwrite. |
| 14 | "Select all 21,438" | **Wrong number.** With no filters, view `all` resolves to `status='active'` = **9,688 rows** on the owner's DB. The patch is hundreds of KB to low MB, not guaranteed multi-MB. |
| 16 | "One malformed persisted view preference blacks out seven routes at once" | **False and contradicted by the cited code.** `viewPreferences` and `dashboardLayout` are `.default()`-guarded with comments stating they are read-tolerant precisely so a stale preference can never crash `readSettings`, and `saveViewPreferenceAction` uses `safeParse`. Also: 18 void actions, not 22. |
| 18 | "Nothing anywhere in the app shows a pending state" | **False.** `Button.tsx:20` has a documented `pending` prop, passed at 11 sites. True statement: view switchers, chart lenses and every `<form action>` submit have none. |
| 19 | "byte-identical chunks" | **Wording.** Byte-*length*-identical (different md5 — same library, different module ids), which is exactly why there is no cache reuse. Conclusion unchanged. |
| 25 | "the review queue re-inflates … cannot be finished" | **Future-tense on this DB.** Measured `needsReviewCount = 0`, `reviewInbox.totalCount = 0`. He finished it. The mechanism (detector pass 2 re-flags after every import) is real; the finding that should replace the present-tense framing is that the **empty** state — the one he now lives in — gets one sentence and no next action. |
| 28 | "orphans in the link graph" | **Overstated.** Both are one tap away in a nine-item nav present on every route. The real half is that /imports shows no per-account staleness. |
| 29 | "a 2036 typo generates ~3,600 INSERTs via `deriveForward`" | **Right conclusion, wrong function.** `deriveForward` stops at today. The explosion comes from `deriveCashSpans` iterating one row per day between endpoints. |
| 40 | "the rules path overwrites hand-categorization" | **False — do not touch this shield.** `retroApplyRule` filters with `{excludeUserSet: true}` and `previewRuleMatches` uses the identical predicate, so badge and write agree and neither can touch a `source='user'` row. Given 2,515 user-sourced rows on the real DB, this guard is load-bearing. |

### C. Documents that are stale and will cause rework if trusted

- `docs/monarch-money-deep-dive.md:288-330` — the scoreboard lists Splits ⛔ (shipped pass 20), Sankey ⛔ (shipped pass 21) and chart-as-filter as missing (shipped).
- `docs/future-ideas.md:82-92` — the chart-parity table shows Balance/Portfolio/Holding `focus ❌` and `chart↔table ❌` when both shipped in passes 22–23, and still lists AllocationDonut hover-highlight as a gap.


---

<div id="sec-05"></div>

> **▼ SECTION 05 — What to change**

# 05 — What To Change

298 raw proposals from 21 audit agents, deduplicated into **97 changes** to things that
**already exist**. Anything that was net-new functionality has been removed and is listed at the
bottom under [Dropped → belongs in the ADD list](#dropped--belongs-in-the-add-list).

Four sections, ranked inside each by **impact ÷ effort** (best ratio first):

| Section | Question it answers |
|---|---|
| **[Correctness](#1-correctness)** | Is the app telling the truth, and can it lose your data? |
| **[Clarity](#2-clarity)** | The number is right — but does the screen say what it means? |
| **[Craft](#3-craft)** | Does it feel built — on a phone, by keyboard, under load? |
| **[Consistency](#4-consistency)** | Is this one app, or twelve apps that share a stylesheet? |

Effort key: **S** ≤ half a day · **M** 1–3 days · **L** ≥ 3 days.
Every row was traced to real code. Claims marked ✔ were re-verified against the working tree
while assembling this list.

---

## 1. Correctness

Things that are **wrong**: false numbers, destroyed data, unrecoverable actions, silent failures,
full-page crashes. Fix this section before anything else on the list.

| # | Fix | Target (file:line) | The defect | Impact | Effort |
|---|---|---|---|---|---|
| C1 | Add `error.tsx`, `global-error.tsx`, `not-found.tsx`, `loading.tsx` at the app root (+ per-route `error.tsx` for `/accounts/[id]`, `/transactions`, `/imports`) | `src/app/` — ✔ verified: **none of these files exist anywhere under `src/app`** | Every throw in the app — a `MoneyParseError` from typing "about 1.1k" into a balance field, a Zod range failure, an `ENOENT` in `listBackups` — drops the user on Next's stock error screen with no landmarks, no navigation, no retry | Very high | S |
| C2 | Make `readSettings` fall back to `DEFAULT_SETTINGS` instead of throwing | `src/services/settings.ts:50-54` | One malformed persisted view preference blacks out every route that reads settings — i.e. most of the app | Very high | S |
| C3 | Fix `retroApplyRule`'s no-op writes | `src/services/rule-corrections.ts:216-234` — ✔ verified: `set.categoryId` is assigned unconditionally; the `if (Object.keys(set).length === 0) continue` guard at :238 is therefore never reached for a category rule | "Would change N" never decays after a successful re-apply, `timesApplied` inflates, and the rule badge lies permanently. Guarding each assignment on `!==` current value makes the existing continue-guard do the rest for free | High | S |
| C4 | Stop `formatCentsSigned` printing `+$0.00` | `src/lib/money.ts:80-83` — ✔ verified: `cents < 0 ? "-" : "+"`, so zero renders `+` | Corrects ~39 render sites at once: every quiet-month calendar footer, the recurring forecast, a zero-activity merchant page. `Money` already tones zero as muted, so only the glyph changes | Medium | S |
| C5 | Fix the day-group net across page boundaries | `src/components/transactions/TransactionsLedger.tsx:65-82` | `groupByDay` sums only the rows on the current page, then prints the result as that day's net. It is arithmetically false whenever a day straddles the page boundary. Either compute day nets server-side over the full filtered set, or label the group "partial — continues on next page" | High | S |
| C6 | Make "Transfer" mean what its badge implies | `src/services/bulk-edit.ts:168-173` and `:285-292` — ✔ verified: only `transferGroupId` is set; compare `src/services/transfer-links.ts:115-121` which also stamps the Transfers-kind category | A row marked as a transfer in bulk still counts as spending in every analytic. Two write paths, two different meanings for the same badge | High | M |
| C7 | Make the `category=spending\|income` predicate split-aware | `src/services/transactions-query.ts:58-81` (vs the named-category branch immediately below at `:81-107`, which already uses the `EXISTS transaction_splits` shape) | The Spent StatCard's own drill-down over-counts split rows, so the headline and the list it links to disagree — a direct violation of the chart⇄table⇄ledger reconciliation doctrine | High | M |
| C8 | Add `.catch` to the 47 unguarded action handlers, and release the busy flag there | `MerchantDefaultCategory.tsx:44,65` · `SeriesMembership.tsx:145,271` · `SplitEditor.tsx:187,205` · `BudgetAmountEditor.tsx:67` — template already written at `LinkPanels.tsx:30` (`NETWORK_ERROR`) | On a rejected action the busy flag is only cleared on the success path, so a flaky connection permanently bricks the control with no message. Extract a `useAction()` hook so this is one implementation, not 47 | High | M |
| C9 | Make Undo verifiable | `src/components/transactions/undo-toast.ts:22-26` (no `else`/`catch` on `!r.ok`) · `src/components/ui/Toast.tsx:223-226` (dismisses synchronously before `onAction()` resolves) | Undo is the app's entire safety story and it is currently unverified end-to-end: a failed undo looks exactly like a successful one. Same missing branch at `RulesManager.tsx:93`, `SeriesMembership.tsx:46`, `SplitEditor.tsx:70`, `MerchantDefaultCategory.tsx:55` | High | M |
| C10 | Convert the 18 `Promise<void>` server actions to the existing `ActionResult<T>` + `safeParse` + toast contract | `accounts/actions.ts:57,72,84,94` · `investments/actions.ts:31,47` · `settings/actions.ts:17` · `budgets/actions.ts:90` · `imports/actions.ts:19,23,30` · `recurring/actions.ts:38,49` — contract already exists at `transactions/action-types.ts:9`, `Field` already has an unused `error` slot (`ui/Field.tsx:26`) | These use `schema.parse` and throw on bad input, which — until C1 lands — is a full-page crash for a mistyped amount. Every one of them also silently discards its result | Very high | M |
| C11 | Stop `catch { notFound() }` masking real failures | `merchants/[id]/page.tsx:25-31` · `categories/[id]/page.tsx:60` · `recurring/[id]/page.tsx:36` · `investments/[assetType]/[symbol]/page.tsx:44-50` — `UnknownHoldingError` is already exported at `holding-detail.ts:32` and never used | A transient DB failure currently tells the owner his holding does not exist | Medium | S |
| C12 | Clamp `filters.page` server-side | `src/app/transactions/page.tsx:135` | `?page=9999` renders an empty ledger with no way back except editing the URL | Medium | S |
| C13 | Fix the backups list ordering and guard `statSync` | `src/app/settings/page.tsx:22-25` | `sort().reverse()` puts every `monthly-*` before every `daily-*`, so `slice(0,8)` shows 6 monthlies and only 2 of 14 dailies — the *recent* recovery points are exactly the ones cut off. A concurrently-pruned file 500s the whole route | Medium | S |
| C14 | Honour `startsOn` in budget status math | `src/services/budgets.ts:160-165` | A budget created mid-period is graded against the full period's spend, so a brand-new budget reads as instantly blown. Carry a `partialPeriod` flag so the row can caption it | Medium | M |
| C15 | Filter `upcomingOccurrences` and `forecast.fixedComponents` by `isSeriesActive` | `src/services/recurring.ts:714` · `src/services/forecast.ts:126-130` — `recurring-calendar.ts:155` already does this | Paused/dead series are projected into the forecast and the Upcoming list but not the calendar: the same series is simultaneously live and not live. Show the exclusions in a collapsed footer rather than hiding them | High | M |
| C16 | Make the holdings sparkline honest about quantity | `src/services/portfolio.ts:597-600` | Applies *today's* `quantityE8` to 30 historical closes, drawing a 30-day line for a position opened 4 days ago. Replay `holding_events` as `holdingReturnDays` already does (`holding-returns.ts:51`), or truncate at the first event day | Medium | M |
| C17 | Reconcile the two investment totals on the account page | `src/app/accounts/[id]/page.tsx:104` | The Holdings card sums positions at their own latest close while the headline uses the account NAV, and unpriced symbols are silently added as **zero**. Label them distinctly and badge unpriced rows out of the denominator | Medium | M |
| C18 | Carry the close forward for trade marks | `src/services/holding-detail.ts:265` (exact-day `closeByDay` lookup; the binary search it needs is already written at `:233-248`) | A trade on a day with no exact close vanishes from the chart, and `page.tsx:81-83` silently filters it out | Medium | S |
| C19 | Fix the recurring amount-override sign trap and reject `0` | `src/components/recurring/CadenceSentence.tsx:255-271` · `src/app/recurring/actions.ts:93` | The sign is derived from the *current* cents, not the series kind, so overriding an income series flips it into an expense. `0` is accepted and is indistinguishable from "no override" | Medium | S |
| C20 | Keep the amount editor open on a parse error | `src/components/recurring/CadenceSentence.tsx:263-271` | `close()` runs outside the success path, so a bad value closes the popover and discards the input with no message. `InlineEditableText.tsx:74-78` already does this correctly | Low | S |
| C21 | Make the FiltersBar preserve every filter the URL supports | `src/components/transactions/FiltersBar.tsx:27-32` — ✔ verified: `hasActiveFilters` covers only account/category/from/to/q, and the only hidden input is `view` | `ledgerHref` is the app's universal exit and this form **destroys** `merchant`, `flow`, `amountMin`, `amountMax` on any submit, while Reset stays hidden because they don't count as active. Every drill-down in the app lands here | High | M |
| C22 | Give the derived cache an invalidation it cannot forget | `src/services/bulk-edit.ts:164-167` and `:296-298` (status transitions with no rebuild) · `src/services/holdings.ts:151` · export a `REPLAY_STATUSES` constant from `derivation.ts` and assert against it | Any write that changes a row's membership in the replay set must rebuild `daily_balances`. Two paths currently don't, so the cache silently desyncs from the truth it is derived from | High | M |
| C23 | Close the two `source='user'` precedence holes | `claude-categorize.ts:256-271` (reused merchant with a user-set `defaultCategoryId` gets Claude's category anyway) · `merchants.ts:115-122` — unify on one exported `notUserOwned()` predicate replacing the four hand-written copies at `categorize.ts:178`, `categorize.ts:720`, `claude-categorize.ts:106`, `rule-corrections.ts:212` | Automation overwrites hand-categorization. The precedence exists in a comment, not in the code | High | S |
| C24 | Wrap `classifyPendingMerchants` in a catch that records a failed run | `src/services/claude-categorize.ts:148` · surfaced at `settings/page.tsx:34,103` | The rejection escapes the server action, and a failed run is indistinguishable from a short successful one — this is exactly the pass-24 failure mode | Medium | S |
| C25 | Clean up orphaned transfer groups on delete | extract the cleanup already written at `transfer-links.ts:107-110`; call from `import/service.ts:985` and `manual-transactions.ts:273` | A one-legged transfer group hides a real outflow from every analytic, permanently, with nothing to find it by | Medium | S |
| C26 | Bound every date at the boundary, and floor `deriveDailyRows` | `anchors.ts:17` · `manual-transactions.ts:27,177` · `holdings.ts:79` · `AnchorForm.tsx:17`, `CashWallets.tsx:164,272`, `HoldingForm.tsx:74` (no `max`) | A fat-fingered year emits ~355,000 daily rows. A typed cap in the pure function protects every caller including future scripts | Medium | S |
| C27 | Preserve user attributes across re-parse and un-import | `import/service.ts:548` (`carryFrom` exists and works at `:706-722` but is only applied on the takeover branch) · `:973` (the un-import DELETE) · `migrateSplits` is imported at `service.ts:11` and never called for the superseded pair · promise made at `docs/schema.md:94-95` | Re-importing a file after a parser-version bump destroys hand-set categories, notes, transfer links and splits. There is **zero** test coverage of this — add one asserting a hand-categorized row survives a parser bump | Very high | L |
| C28 | Take a pre-mutation snapshot before the eight irreversible services | new `withPreMutationSnapshot()` in `src/db/backup.ts` reusing the tmp+rename mechanism at `:63-78`; wrap `unimportFile` (`service.ts:962`), `acceptGap` (`:990`), `deleteAnchor` (`anchors.ts:60`), `addManualAnchor` conflict branch (`anchors.ts:40`), `deleteManualTransaction` (`manual-transactions.ts:267`), `mergeSeries` (`recurring-links.ts:168`), `retroApplyRule` (`rule-corrections.ts:203`), `bulkApplyByFilter` above a threshold (`bulk-edit.ts:187`) | Snapshot cost on a 12.8 MB file is milliseconds. This converts every remaining unrecoverable action in the app into a recoverable one. *(Partly net-new infrastructure — kept here because it de-risks eight existing mutations rather than adding a feature.)* | Very high | M |
| C29 | Make the mutation + rebuild sequence atomic, or detectable | hoist the outer `db.transaction` to enclose reconcile+rebuild in `import/service.ts:479,973,1005` (better-sqlite3 nests via savepoints, so `rebuildAccount`'s inner transaction is compatible) | A crash between the write and the rebuild leaves a cache the app cannot tell is wrong. If the hoist is too invasive, add a `verifyDerivedCache()` that diffs one account in memory | High | L |
| C30 | Fix the two optimistic-reorder rollbacks | `dashboard/ArrangeableSections.tsx:46-54` (no `.catch` → an order the server rejected stays on screen) · `accounts/ManagedAccounts.tsx:47-55` (no optimistic apply and no `aria-busy` → a second click inside the round-trip applies a stale index transform and silently loses a move) — adopt the `saveSeqRef` guard from `useInlineEdit.ts:60,76-84` | Medium | S |
| C31 | Stop detection pass 2 re-flagging rows the user already cleared | `src/services/categorize.ts:631-644` — needs a persisted `reviewDismissedAt` (or a reuse of `needsReviewSource`) | The review queue has no finish line: clearing it is undone by the next categorization run | High | M |
| C32 | Move the undo patch server-side before hosting + auth | `src/services/bulk-edit.ts:183` — `undoAction` accepts a client-supplied arbitrary row patch | Today this is an unauthenticated arbitrary-ledger-write endpoint. Store the patch in a short-lived token table (or HMAC-sign it) and return only an opaque id. Side benefit: "select all 21,438" stops round-tripping one object per row | High | M |
| C33 | Make the rename gate match the rename service | `categories/[id]/page.tsx:116` vs the private `IMPORT_HINT_ROOTS`/`IMPORT_HINT_PATHS` at `category-edit.ts:25-34` | The pencil appears on categories the service will refuse to rename. Export one `isRenameLocked()` predicate and drive both | Low | S |
| C34 | Stop a merchant-less series being silently split by a rename | `recurring-detail.ts:365` — the docstring claims the identity is preserved; it is not when `merchantId IS NULL` | The rename survives until the next detection run, then the series splits and the forecast changes underneath the owner. At minimum warn on screen and fix the false docstring | Medium | M |
| C35 | Pass the settings that currently cannot change anything | `transactions/actions.ts:150` never passes `categorizationConfidenceMin` (the option already exists at `claude-categorize.ts:128,141`) · `boot.ts:20` never passes `backupRetention` into `backup.ts:41` | /settings advertises two controls that are inert, and the retention sentence at `settings/page.tsx:68` is false | Medium | S |
| C36 | Scope the top-merchant drill-down hrefs to the category | `src/services/spending.ts:679-681` — `transactions-query.ts:53,80` and `lib/ledger-href.ts:26` already compose merchant AND category | On /categories/[id], clicking a merchant leaves the category behind and shows a larger list than the number that was clicked | Medium | S |

---

## 2. Clarity

The number is right; the screen does not say what it means, when it is from, or what a button will
do. Nearly every row here renders a value the code **already computes and discards**.

| # | Fix | Target (file:line) | What's missing | Impact | Effort |
|---|---|---|---|---|---|
| L1 | One `<AsOf day basis />` component, used everywhere a money figure appears | `netWorth.asOf` (`dashboard.ts:131`) · `institution-groups.ts:169-170` + `derivation.ts:378-383` (`asOf`/`basis`, both loaded and dropped on /accounts) · `PortfolioStats.tsx:27` (dead ternary) · `holding-detail.ts:298-301` (`quotedOn`) · `portfolio.ts:536` | Nothing on any surface dates the number it prints. All the values exist; none reach the DOM | Very high | M |
| L2 | Kill the four "today" lies | `InvestmentsTeaser.tsx:55` · `InstitutionCard.tsx:28` · `PositionCard.tsx:50` · `accounts/[id]/page.tsx:152` | These label a delta "today" that is actually against the last covered/priced day. Name the real comparison day | High | S |
| L3 | Report what the three bulk engines actually did | `imports/actions.ts:19` discards a fully-populated `FileOutcome[]` with six counters (`service.ts:41-58`) · `transactions/actions.ts:128-129` discards `categorizeAll` + `detectTransfers` stats · `recurring/actions.ts:38-41` discards `DetectionSummary` | A batch where every row was skipped, a run that re-flagged 400 rows, and a run that created nothing are all visually identical to success. This is why the owner cannot tell when his data changed underneath him | Very high | M |
| L4 | Render the 6-month guidance delta on the budget row | `budgets/page.tsx:51-53` already computes `budgetGuidanceCents` for every budget on every load | On the real DB this instantly surfaces that 8 of 10 budgets are materially mis-set — the page's highest-value latent insight, currently two clicks deep, per row | High | S |
| L5 | State the GROSS / NET / uncategorized reconciliation on "Where it went" | `spending/page.tsx:91-94` (the comment there still calls the gross total "the NET total") | Three different denominators are on screen with no sentence connecting them. Every component of the reconciliation is already loaded | High | S |
| L6 | Add the amount to the Excluded honesty bucket | `services/spending.ts:744-754` already scans the rows · `HonestyBucketsCard.tsx:53-57` | "12 rows" is not actionable. "12 rows, $3,410 kept out of spending" is | Medium | S |
| L7 | Show the transaction count per category row | `analytics.ts:294-309` returns `txnCount`; `spending/page.tsx:123-135` discards it | First thing that tells you whether a big category is one bad row or a habit | Medium | S |
| L8 | Render the AI-spend detail | `services/settings.ts:90-96` returns 10 fully-populated call records that `settings/page.tsx` never touches | Add a progress bar against the cap and label the figures "estimated from published rates, not billed" | Medium | S |
| L9 | Give every settings threshold a hint that says what it governs | `settings/page.tsx` — `Field` already accepts a `hint` prop (`ui/Field.tsx:23,38`), and the page passes none | The single highest-value string on that page: "Review deposits applies to **newly imported** uncategorized deposits only — changing it does not re-scan existing transactions" | Medium | S |
| L10 | Migrate the ~14 honesty-bearing `title=` attributes to the built-and-unused `Tooltip` | ✔ verified: `ui/Tooltip.tsx` has **zero consumers**; 55 `title=` sites exist. Priority: `PortfolioStats.tsx:35,68,113` · `PortfolioHoldingsTable.tsx:61,74,90` · `PositionCard.tsx:67,72,75` · `PredictBudgets.tsx:178` · `SpendingCategoriesTable.tsx:132` · `AccountHoldingsTable.tsx:95` · `RealizedSalesList.tsx:51,60` · `CashFlowChart.tsx:126` · `PnlCalendar.tsx:102` | On the phone the owner actually uses, every `≈` and `!` marker is an undecodable glyph. The app's best idea is currently unreadable on its primary device. (`imports/page.tsx:186` is the special case — the whole parser error string is in a `title`; make that an expandable row) | High | M |
| L11 | Add an `action` slot to `EmptyState` and fill all nine dead ends | `ui/EmptyState.tsx:8-17` · sites: `transactions/page.tsx:199,217` · `imports/page.tsx:158` · `budgets/page.tsx:81` · `recurring/page.tsx:65` · `spending/page.tsx:194` · `ReviewInbox.tsx:124` · `AllSeriesView.tsx:22` · dashboard first-run cards `page.tsx:124` (currently zero interactive elements on the entire first-run screen) | High | S |
| L12 | Give the twelve `&&`-gated sections an else branch | `page.tsx:188` · `accounts/[id]/page.tsx:166,183,195` · `accounts/page.tsx:42,44` · `categories/[id]/page.tsx:180` · `imports/page.tsx:104,123` · `investments/page.tsx:175` · `DashboardModePanel.tsx:189` · `PositionCard.tsx:89` | Two are functional bugs, not cosmetics: `accounts/[id]:195` hides the "All transactions →" escape hatch when an account has no *active* rows (exactly when you need it), and `page.tsx:188` renders blank space instead of ScrubChart's own "not enough history" copy | Medium | S |
| L13 | Confirmations that state the blast radius in money | Model already written at `EditAccountSheet.tsx:150-155,199-214`. Apply to: archive account (`accounts/actions.ts:94` — "your net worth will read $11,020.45 higher", one `latestBalances` lookup away) · un-import (`imports/actions.ts:23` — "deletes 2,149 transactions, 312 categorized by you") · delete anchor (`:84` — "turns 143 days from derived to gap") · deactivate budget · end/dismiss series · re-apply rule | Very high | M |
| L14 | Persist and render a review **reason** per row and per cluster | four producers: `categorize.ts:261-266` (large deposit) · `categorize.ts:631-644` (ambiguous transfer) · `claude-categorize.ts` (low confidence) · `import/service.ts:891-894` (suspected duplicate). Render on `ReviewInbox.tsx:186-209` and the ledger dot | A suspected duplicate changes **net worth**, not just categorization, and must not be clearable by the same generic "Confirm all" as a confidence wobble | High | M |
| L15 | Surface categorization provenance | add `categorizationSource` to `transactions/page.tsx:95-111` and `services/ledger-rows.ts:42-68`; render a source glyph on the row and a "Why this category" line in the sheet, reusing the `suggestionReason` copy pattern at `TransactionSheet.tsx:32-36` | Medium | M |
| L16 | Label the all-time return stats sitting under a windowed chart | `ReturnViewParts.tsx:89,143-146` · same at `PortfolioChartPanel.tsx:306-307` | `returnStats`/`decomposeValue` take the full `returnDays` regardless of the active range. Either window them or append "· all time" — do not leave them unlabeled | Medium | M |
| L17 | Stop the lens toggle silently dropping the brushed window | `ScrubTable.tsx:102` (window not passed through) · `:147-149` (the caption already handles the `fellBack` case honestly) | The table's entire design premise is that it cannot lie about its window. Today it can | Medium | S |
| L18 | Resolve the liability sign clash | `ManagedAccounts.tsx:75` vs `:162` | The same balance shows opposite signs 3cm apart. Append "owed" / "net" suffixes, matching the detail page's `Amount owed` label at `accounts/[id]/page.tsx:143-145` | Medium | S |
| L19 | Design the two budget-bar extremes | `BudgetRow.tsx:53` (prints four-digit percentages — 4,898% and 108% look identical) · `:94-95` (`aria-valuenow` and `aria-valuetext` disagree) · negative `spentCents` renders "On track · -8% used" | Medium | M |
| L20 | Explain the bar and the pace line | `BudgetRow.tsx:111` (the today-tick's meaning exists only in a source comment; the dashed tail is `aria-hidden` with no explanation anywhere) · `CashFlowChart.tsx:292-311` (the amber pace `ReferenceLine` has no legend entry) | Medium | S |
| L21 | Explain "Free to spend" | `services/dashboard.ts:198-202` — four terms feed it and none is named on screen; draw `pace.points[].idealCents` as a third faint line so the sparkline answers ahead/behind | Medium | M |
| L22 | Render the two Upcoming numbers that already exist | `upcoming.netCents` as the strip headline; the `beforePaycheck` line whenever it is non-null **including 0** ("Nothing due before your next paycheck (Jul 30)") | Medium | S |
| L23 | Put the evidence on every recurring card and the detail stat block | `recurring-detail.ts:247-252` returns `intervalDaysAvg`, `toleranceDays`, `amountCentsAvg`, `amountCentsStddev`, `lastMatchedOn`, `detectedNextExpectedOn` — the page renders none of the first five. `AllSeriesView.tsx:53-97` already receives `lastMatchedOn`/`matchedCount`/`isActive` and shows none | High | M |
| L24 | Show cost basis and last close on the holding page | `holding-detail.ts:201-204` (`costCents`) and `:298-301` (`latestClose`, `priceDayChangeCents/Pct`, `quotedOn`) — all four computed, none rendered | "Total return +$1,204 (+11.4%)" currently has no visible denominator | Medium | S |
| L25 | Say gap **direction** in words, and link the gap to its evidence | `imports/page.tsx:127-153` | "printed ending is $43.64 **higher** than the transactions sum — a debit is missing" is actionable; a signed number is not. Link each gap row to the account, the date-ranged ledger, and `?view=quarantined` | Medium | M |
| L26 | Rewrite the two transaction-list copy defects | `InlineCategorizeList.tsx:26` says the uncategorized-bucket sentence on the category page · `categories/[id]/page.tsx:127` prints the raw `kind` instead of "Transfer — excluded from spending and income" | Low | S |
| L27 | Fix the sparkline-window docstring | `institution-groups.ts:20` documents `SPARK_WINDOW_DAYS = 30` as "days of history"; `:172` applies it as `series.slice(-30)` — the last 30 covered **points**, which on sparse investment coverage silently stretches across an arbitrary span | Low | S |
| L28 | Reconcile or relabel the two transaction counts | `spending/actions.ts:76` (allocations) vs `analytics.ts:463` (distinct parents) | The header count and the list count disagree by design and nothing says so. "18 transactions · 22 allocations" | Low | S |
| L29 | Note that unrealized and realized P/L are not additive | one line between `PositionCard` and `RealizedSalesList` (`investments/[assetType]/[symbol]/page.tsx:128-131`) — `holding-detail.ts:205-216` uses broker average cost, `:249-256` uses an average-cost walk at daily closes | Low | S |
| L30 | Reconcile the variance semantics between calendar and amount history | `AmountHistoryChart.tsx:44-51` (exact-cent) vs `recurring-calendar.ts:66-79` (`classifyPostedAmount` tolerance band) — export the latter and use it in both; flip the variance sign to net-worth-signed so "paid more on a bill" reads negative | Medium | S |

---

## 3. Craft

Does it feel built. Measured against a real `next build` on the demo DB, and in Chromium at
390 / 768 / 1440 / 2560.

| # | Fix | Target (file:line) | Why | Impact | Effort |
|---|---|---|---|---|---|
| K1 | Gate `Popover`'s children on `open` | `src/components/ui/Popover.tsx:134` — ✔ verified: `{children}` renders unconditionally. `CommandPalette.tsx:141` already does the right thing | **Measured on /transactions: 32,557 → ~1,520 DOM nodes, 4,054 KB → ~259 KB HTML, 9,098 → 0 SVG paths.** One line, and it fixes 10 CategoryPicker call sites plus Menu, BudgetAmountEditor, BudgetRow, SeriesMembership and three CadenceSentence token editors at once | Very high | S |
| K2 | Add the `min-w-0` grid guard | `page.tsx:217` · `investments/page.tsx:181` · `spending/page.tsx:214,240` · `categories/[id]/page.tsx:179` · `settings/page.tsx:84` · plus the `DataTable` wrapper itself at `ui/DataTable.tsx:175` | Six measured horizontal overflows. Verified by injecting `grid-template-columns: minmax(0,1fr)` into the live dashboard: the hub collapses from 454px back to 343px. The `DataTable` line protects every future consumer | High | S |
| K3 | Make `ViewSwitcher` and `ViewTabs` degrade instead of escaping their card | `ui/ViewSwitcher.tsx:25` — ✔ verified: bare `flex gap-1` with no wrap and no scroll · `transactions/ViewTabs.tsx:23` (sole cause of /transactions' measured 17px overflow) | The dashboard's 6-option dimension is unreachable on a phone. Adding one option to any other surface reproduces the bug | High | S |
| K4 | Give `Button`/`IconButton` a coarse-pointer size floor | `ui/Button.tsx:19-21` and `:60-63` — add an `lg` size plus `pointer-coarse:min-h-11 min-w-11`; same for `ViewSwitcher.tsx:35`, `ChartRangePills.tsx:42` | ~6 lines moves the measured under-44px control count from 709/1470 toward the handful of genuinely inline links, with zero call-site changes | High | S |
| K5 | Replace `touch-none` with `touch-pan-y` on the chart plot | `ScrubChart.tsx:545` · and delete/gate it on `ManagedAccounts.tsx:104` (a drag handle whose HTML5 `dragstart` cannot fire from touch anyway) | A measured 208–256px dead band — 25–30% of the phone viewport on four routes — where the page cannot be scrolled. The brush is horizontal; `pan-y` keeps vertical scroll and pointer capture at `:417` still wins an intentional drag | High | S |
| K6 | Add the missing `pointer-coarse:opacity-100` to the two universal hover reveals | `ui/StatCard.tsx:45` · `ui/InlineEditableText.tsx:123` — `DataTable.tsx:65` already does this | Two words restore the drill-through signal on every stat card and the rename affordance on all four entity detail pages. Then decide `MonthlyTrendBars.tsx:29`, `UpcomingBillsStrip.tsx:50`, `ManagedAccounts.tsx:140`, `InstitutionCard.tsx:50` deliberately | Medium | S |
| K7 | Add a route announcer + focus anchor to the shell | new `shell/RouteAnnouncer.tsx` mounted in `AppShell.tsx` — `#main` already carries `tabIndex={-1}` and `outline-none` at `:62-66` for exactly this | One component fixes silent navigation on all 15 routes and every drill-down link in the app | High | S |
| K8 | Wire the pending flags that are already computed | `ViewSwitcher`'s `disabled` prop exists and is unused (`ui/ViewSwitcher.tsx:20,33`); six `useViewState` consumers destructure `isPending` and throw it away (`CashFlowView.tsx:37`, `DashboardChartSection.tsx:90`, `BalanceChartPanel.tsx:87`, `SeriesDetail.tsx:65`, `HoldingChartPanel.tsx:98`, `PortfolioChartPanel.tsx:93`); 14 sites do `const [, startTransition]` | Every view switch is a server round-trip; a ~1.5s account-chip toggle currently looks like a dead button | High | S |
| K9 | Give every `<form action>` a pending submit | `useFormStatus` has **zero** usages; `Button` already supports `pending` (`Button.tsx:29,50`). Order: `imports/page.tsx:96` (a 30s import that looks frozen and can be double-submitted) · `recurring/page.tsx:53` · `HeaderStrip.tsx:61,83` · `settings/page.tsx:60` · the four account/budget/holding forms | High | S |
| K10 | Fix the two `aria-label`-on-a-span sites and stop hiding badges below `md` | `TransactionsLedger.tsx:300` · `RecentTransactions.tsx:75` — use the `LetterBadge` shape at `ui/Badge.tsx:44-53`. `TransactionsLedger.tsx:294,298` `display:none` removes the T/R badges from the **accessibility tree**, so a mobile screen-reader user loses transfer and recurring status entirely | Medium | S |
| K11 | Stop the `a` mnemonic swallowing every keypress | `lib/keyscope.ts:31,199-206,224-234` — widen `KeyHandler` to `boolean \| void` and treat `false` as unhandled; `ToastMnemonic.tsx:20` already returns the right boolean from `Toast.tsx:76-84` | `void`-returning handlers keep today's behaviour exactly, so nothing else changes | Medium | S |
| K12 | Restrict `ArrangeableSections`' drop target to the grip row | `dashboard/ArrangeableSections.tsx:90-91` → move the handlers onto the grip header at `:108-118` | A drag released over the net-worth chart currently reorders the page; the brush and the reorder compete for the same gesture | Medium | S |
| K13 | Unify the two modal contracts | `ChartFocus.tsx:104-109,128-171` needs an empty modal `KeyScope` (as `Sheet.tsx:52-55` has) and a `tabIndex={-1}` initial-focus target — better, extract one `useModalDialog` hook so the next dialog cannot diverge | Medium | M |
| K14 | Give `Popover` a focus contract instead of leaving it per-consumer | `ui/Popover.tsx:73` — add `initialFocus` / `restoreFocus`, then delete the hand-rolled versions at `CadenceSentence.tsx:107-108,188,259` and `SeriesMembership.tsx:101-106,257-258` | Medium | M |
| K15 | Lazy-load recharts behind one shared `next/dynamic` chunk | ✔ there is **no** `next/dynamic` anywhere in the repo. Entry points: `ScrubChart.tsx:12`, `AllocationDonut`, `AmountHistoryChart`, `CashFlowChart`, `CashFlowGraph` | **Measured −107 KB gz** off the initial payload of /, /spending and /investments (/investments 548 → ~441 KB gz), and one addressable chunk means route 2 and 3 in a session get a cache hit instead of a second 372 KB copy (~215 KB gz saved per session). The `loading` slot also gives charts the skeleton they don't have | High | M |
| K16 | Wrap the four hot service functions in React `cache()` | ✔ zero uses of `cache()` in `src/`. Targets: `analytics.activeTxnsInRange`, `analytics.loadCategoryIndex`, `in-flight.transferFloats`, `portfolio.buildPortfolio` (+ `portfolioRealizedPl`) | Behaviour-preserving. The dashboard stops computing `transferFloats` twice (**measured 439ms each** on the real DB); /investments stops running `buildPortfolio` 4× and `portfolioRealizedPl` 5×; /spending's ~10 aggregates (`spending/page.tsx:59-162`) share one row scan instead of ten | Very high | M |
| K17 | Kill the two confirmed N+1s | `portfolio.ts:864` (per-event close lookup → one grouped query + the binary search already written at `holding-detail.ts:233-248`; **measured 119 → ~31 statements** on a 6-event DB, and the owner has 1,991 events × 4 calls) · `manual-transactions.ts:63-97` (four queries per account → one `cashWalletAccountIds` pass; **measured /accounts 28 → ~8**) | High | M |
| K18 | Stop /recurring computing all four tabs on every render | `recurring/page.tsx:32-35` — `forecastCurrentMonth` alone is **measured 102.8ms**, the app's most expensive per-row call. Also give `listSeries` a `GROUP BY` count instead of loading every active row into JS to build a count map (`recurring.ts:551-560`) | High | S |
| K19 | Bound the two page-load scans that grow with usage | `rules-manager.ts:161` runs one full active-transaction scan **per enabled rule**, with a `new RegExp` compile per row (`categorize.ts:102`) — ~20k regex compilations per /settings load on the owner's ledger · `categorize.ts:739-744` materializes every active row to produce two integers · `categorize.ts:274-290` re-SELECTs the whole account per inbound credit | High | M |
| K20 | Stop `merchantSummary` pulling the whole merchant ledger for four numbers | `services/merchants.ts:58-77` — for a Robinhood-class merchant that is 1,837 rows per render. Three aggregates + `LIMIT 5`; `ix_transactions_merchant` already exists (`db/schema/transactions.ts:76`) | Medium | M |
| K21 | Cut the render cost of the holding-detail diversity number | `holding-detail.ts:219` calls the full `holdingRows(db)` — including the whole realized-P/L event walk — for one percentage; `:117-123` does a full-table leading-wildcard LIKE; `page.tsx:70-79` computes bench/replay work unconditionally instead of gating on the returns view | Medium | M |
| K22 | Memoize the three unmemoized charts and add `React.memo` | `CashFlowChart.tsx:81-95` (rebuilds rows + three Maps in the render body; 0 `useMemo` in 367 lines) · `CashFlowGraph.tsx` · `AllocationDonut.tsx` (worst — it drives a hover highlight, so every pointer move re-derives the slice geometry). ✔ there is not a single `React.memo` in the codebase. Copy the discipline from `ScrubChart.tsx:254-360` | Medium | S |
| K23 | Make the two long blocking mutations non-blocking | `imports/actions.ts:19` (100 MB in-memory body awaited inside a form navigation) · `transactions/actions.ts:150` (~9 sequential Haiku calls, and the "Stop Claude run" button at `HeaderStrip.tsx:69-77` is unreachable until it resolves — the heartbeat machinery at `claude-categorize.ts:52-89` already exists for this) · scope `flagFuzzyDuplicates` (`import/service.ts:878-889`) to touched accounts and a date window instead of self-joining the whole table | High | L |
| K24 | Bound `rebuildAccount`'s blast radius, or make it visibly async | `derivation.ts:250-257` DELETEs and re-inserts an account's entire `daily_balances` on every anchor write, manual transaction, price refresh and import | Everything before the earliest touched anchor is provably unchanged. If the idempotency guarantee is worth keeping, at minimum give every caller a pending state | Medium | M |
| K25 | Trim the shared baseline | `lib/ledger-href.ts:1` carries `"use client"` but is pure string building — removing it stops it being duplicated into every consuming client chunk (audit the four `*-view-spec.ts` too) · `command-index.ts:73-75` explicitly declines a LIMIT on merchants ("dozens, not thousands"); the owner has **434**, serialized into every navigation's RSC payload for a palette with no visible trigger | Medium | S |
| K26 | Cap the unbounded lists | `ScrubTable.tsx:109-113` (700+ rows on ALL) · `SeriesMembership.tsx:58-77` · `AmountHistoryChart.tsx:92-102` · `ReviewInbox.tsx:153-163` (404 clusters on the real DB) · `imports/page.tsx:167` (88 rows in a two-axis nested scroller on a phone) | Medium | S |
| K27 | Wrap the two unprotected tables and make the third explicit | `ForecastCard.tsx:80` has **no** overflow wrapper at all — the only table in the app with neither `DataTable` nor an `overflow-x-auto` div; it fits today only because the seed's labels are short · `accounts/[id]/page.tsx:227` same shape · `imports/page.tsx:167` scrolls sideways only because `overflow-y-auto` forces `overflow-x: auto` to compute | Medium | S |
| K28 | Give every horizontal rail an overflow affordance | `MobileNav.tsx:14` (51% hidden, and the current item is not scrolled into view) · `UpcomingBillsStrip.tsx:42` · `DataTable.tsx:175` · `AllSeriesView.tsx:113` | On the owner's primary device the app's IA is invisible | High | M |
| K29 | Show the magnitude bar and the sparkline on the phone | `SpendHeatmap.tsx:166` (`hidden ... sm:block` removes the shared-scale magnitude bar — the component's own thesis — exactly where the 10px figures are least legible) · `ManagedAccounts.tsx:157` (removes the sparkline that the dashboard renders at every width) | Medium | S |
| K30 | Add the wide-screen tier the app has never used | `AppShell.tsx:65` — breakpoint histogram is `sm 42, md 34, lg 12, xl 0, 2xl 0`. Measured: **1320px (52%) of a 2560px viewport is empty on every route** | Medium | M |
| K31 | Give the chart brush a keyboard path and make the date inputs fail out loud | new pure `stepSelection()` in `lib/scrub.ts` (mirroring `stepScrubIndex`), wired into `ScrubChart.onKeyDown` (`:370-375`); when `applyWindow` bails on the <2-point rule (`:398-404`) announce it instead of returning silently — reuse the string `ScrubTable.tsx:147-149` already writes | Medium | M |
| K32 | Make the recharts drill-downs keyboard-reachable on /spending | `CashFlowChart.tsx:97` gates `focusable` on `monthBuckets`, so the page's **default** month period has zero keyboard chart interaction; the Sankey ribbons (`SankeyChart.tsx:237-249`, `aria-hidden`, with `showTableToggle` false at `CashFlowView.tsx:107-111`) are unreachable by keyboard, screen reader **and** touch | Medium | M |
| K33 | Normalize the destructive-control clusters for a thumb | `RulesManager.tsx:148-177` (two 24×24 chevrons and an **unconfirmed** 24×24 delete in one ~200px non-wrapping row) · `BudgetRow.tsx:193-207` (49×20 Edit adjacent to 71×20 Deactivate) — the only two places where an irreversible action is a sub-24px target next to a benign one | Medium | S |
| K34 | Make hero figures survive their containers | responsive step on `page.tsx:151`, `accounts/[id]/page.tsx:148`, `merchants/[id]/page.tsx:48`; `min-w-0` on `ui/StatCard.tsx:23`. Add a seven-figure fixture (positive and negative) to the e2e seed and a 320px baseline | Low | S |
| K35 | Extend the test gates to cover what this audit found | (a) `document.documentElement.scrollWidth === clientWidth` at 390/768/1024/1440 for every route in `a11y.spec.ts` · (b) add `/imports` to `a11y.spec.ts:8` and `visual.spec.ts:9`, plus dynamic resolvers for `/merchants/[id]` and `/recurring/[id]` · (c) a second Playwright project on `devices['iPhone 14 Pro']` so the `pointer-coarse:` branches are exercised at least once — **no route has ever been axe-scanned at a phone width** · (d) register the nine overlay states `interaction-states.spec.ts:15-22` promised and never got (txn sheet, split editor, category picker, chart focus, edit-account sheet + re-derive warning, cash-txn sheet, heatmap day sheet, palette-over-transactions) · (e) re-point `keyboard.spec.ts` off `/design/stage-0a`, which `notFound()`s in production · (f) perf budget: ≤300 KB gz JS, ≤3,000 DOM nodes, zero `[popover] [role=option]` before interaction | Very high | M |

---

## 4. Consistency

One app or twelve. Every row here is *dedupe onto something that already exists* — no new
concepts, no new components except where a wrapper collapses N copies into one.

| # | Fix | Target (file:line) | The divergence | Impact | Effort |
|---|---|---|---|---|---|
| S1 | Ship a type scale, then apply it to headings first | `globals.css` (add `--text-eyebrow/-body/-section/-title/-hero`), then the **39** `<h2 className="text-sm font-medium">` section headings · `PageHeader.tsx:9` · the six detail routes that hand-roll their own `h1` | One mechanical find-and-replace gives every surface in the product a visible three-level hierarchy for the first time. The dashboard hero (`page.tsx:148-152`) already proves the proportions | Very high | S |
| S2 | Collapse the five eyebrow specs into one | 26 + 25 + 9 + 5 occurrences of four different tracking values, plus `imports/page.tsx:170`'s `tracking-wide` | Expose it as one class/token pair so no future surface invents a sixth | Medium | S |
| S3 | Migrate the 119 hardcoded sub-12px declarations onto the scale | 102× `text-[11px]`, 15× `text-[10px]`, 2× `text-[9px]` across 58 files. Worst: `SpendHeatmap.tsx:157` (10px money in a 44px cell), `ForecastCard.tsx:84`, `AllSeriesView.tsx`, `PortfolioStats.tsx` | After this, raising the phone floor is a one-line token change instead of 58 files | High | M |
| S4 | Add `--shadow-card` as a theme-aware token | `globals.css` (register beside `--shadow-overlay` at `:187`), replacing the four literals at `SurfaceCard.tsx:12`, `HeaderStrip.tsx:40`, `InstitutionCard.tsx:98`, `ManagedAccounts.tsx:71` | Dark mode currently has no elevation model — in a dark theme elevation reads through a rim highlight, not a drop shadow. Add `--shadow-card-hover` for the drill-down lift the app lacks entirely | Medium | S |
| S5 | Retire the 16 hand-rolled primary buttons onto `Button` | `settings/page.tsx:61` · `imports/page.tsx:97` · `PeriodSelector.tsx:194` · `ReviewInbox.tsx:251` · `HeaderStrip.tsx:63` · `AnchorForm.tsx:26` · `AccountForm.tsx:62` · `BudgetForm.tsx:32` · `PredictBudgets.tsx:101` · `SeriesDetail.tsx:146` · `CadenceSentence.tsx:235,320` · `AllSeriesView.tsx:80` · `SeriesMembership.tsx:233,320` · `HoldingForm.tsx:79` | Closes "no pending state / double-submit / silent save" — reported as five separate bugs by five separate route audits — in one edit. Add `active:` states to the three variants that lack one (`Button.tsx:12-16`) | High | M |
| S6 | Retire the four raw tables onto `DataTable` | `imports/page.tsx:168` (88 rows — gains sort, row links, caption, empty state) · `accounts/[id]/page.tsx:227` · `AllSeriesView.tsx:114` (31 series — gains sort-by-annualized, the most-requested affordance on that surface) · `ForecastCard.tsx:80` | `DataTable` already has sortable headers with `aria-sort`, `rowHref` overlays and controlled URL sort state (`DataTable.tsx:11,148-155,193-215`) | High | M |
| S7 | Make the period a first-class param carried on every cross-surface link | one `periodParams()` helper in `lib/period.ts`, applied at `SpendingCategoriesTable.tsx:105,154` · `BudgetRow.tsx:77` · `categories/[id]/page.tsx:95,186` · `SeriesDetail.tsx:134` · `MonthlyTrendBars.tsx:21` · `SpendingPaceWidget.tsx:69`; accepted on /budgets (`page.tsx:46`), /merchants/[id] (`merchants.ts:53` already takes an injectable `today`) and /accounts | The app changes the number under the owner's finger on every navigation. Then delete the `?period=2026` workarounds from `zz-spending-categorize.spec.ts:21` and `visual.spec.ts:28` and let the specs assert the carry | High | M |
| S8 | Route the remaining local state through the existing view-state system | `ChartFocus.tsx:67` (range) · `SankeyChart.tsx:82` (flow/table lens) · `spending/page.tsx:220` (heatmap month — also deletes the `key={heatMonth}` remount hack) · `RecurringCalendar.tsx:66` (month) · the dashboard brushed window into `DashboardWindowProvider` · `PortfolioHoldingsTable.tsx:38-39` and `TopMovers.tsx:13` | `lib/view-state.ts` + `useViewState.ts` already implement URL > persisted > default with only non-defaults in the URL. Honour the append-only invariant at `chart-lens.ts:17-19` — `DashboardChartSection.tsx:141`, `PortfolioChartPanel.tsx:100` and `HoldingChartPanel.tsx:105` index positionally | High | M |
| S9 | Extract one `revalidateFor(kind)` map | `imports/actions.ts:7` already has the right idea; 12 hand-rolled sets elsewhere. Measured holes: `recurring/actions.ts:33` (missing /, /budgets, /spending) · `budgets/actions.ts:98` (missing /categories/[id], /) · `merchants/actions.ts:41` (missing /, /budgets) | A category change on one surface leaves three others stale | Medium | S |
| S10 | Replace the Sankey's hand-rolled range pills with `ChartRangePills` | `DashboardChartSection.tsx:180-195` — duplicate markup and styling for the shared component; the `Flow range` aria-label can be preserved so `zz-zz-sankey.spec.ts` keeps passing | Low | S |
| S11 | Make the three calendar month-pagers one implementation | extract `useMonthPager` from the correct one (`PnlCalendar.tsx:44-69` — latest-request ref guard, `isPending`, negative toast) and adopt in `RecurringCalendar.tsx:70-76` (no guard) and `SpendHeatmap.tsx:54-61` (no guard **and** no error branch — `!res.ok` is dropped on the floor). Bound all three: disable ‹ before first data, › after the current month, and render "No activity in {month}" instead of a blank grid with a $0 footer | Medium | M |
| S12 | Extract one ledger-row grammar component | `TransactionsLedger.tsx:294,298` · `RecentTransactions.tsx:69,73` · `ReviewInbox.tsx:219` · `InlineCategorizeList.tsx:49` — four components, three different breakpoints, one decision. `RecentTransactions` never renders the account name at **any** width despite `LedgerRow` carrying it (`services/ledger-rows.ts:87`) | Medium | M |
| S13 | Use `Breadcrumbs` and `generateMetadata` on all four detail routes | `categories/[id]/page.tsx:94-106` hand-rolls the nav the other three share; `/merchants/[id]`, `/investments/[t]/[s]` and `/categories/[id]` all export a static `metadata` title, so three open tabs read "Merchant", "Holding", "Category". Add an optional `?from=` so `/merchants/[id]` stops claiming Transactions is always its parent (`page.tsx:37`) and `/investments/[t]/[s]` stops hardcoding /investments when arrived from `AccountHoldingsTable.tsx:121` | Medium | S |
| S14 | One `classifyPostedAmount` tolerance, two consumers | `AmountHistoryChart.tsx:45` (exact cents) vs `recurring-calendar.ts:66-79` (σ-based band) | "On plan" means two different things on two tabs of the same series | Medium | S |
| S15 | Reconcile the two budget status vocabularies | `BudgetPaceStatus` already carries both `pace` and `alert` (`services/budgets.ts:196,446`); `/budgets` renders one and `categories/[id]/page.tsx:160-167` renders the other. Also make `categoryBudgetRef` return **all** of a category's budgets instead of `.find()`'s first (`category-detail.ts:172`) | The same budget is green on one page and amber on another | Medium | M |
| S16 | Route category links to the category page | `command-index.ts:66` (merchants two lines above already do the equivalent) + update the assertion at `command-index.test.ts:48` that pins the stale behaviour; add a category link to the transaction sheet and the ledger's category chip | Low | S |
| S17 | Route detach/attach undo through the existing lossless patch | `SeriesMembership.tsx:40-49,153-162` hand-rolls inverses while the actions already return `undo` (`recurring/actions.ts:128,143`) and `offerUndoToast` already exists (`undo-toast.ts:12`) | The hand-rolled inverse restores `recurringSeriesId` but not `seriesLinkSource` — which is the entire point of the patch. The "lossless" comment at `:39` is false | Medium | S |
| S18 | Adopt `StatCard` / one `HeroFigure` for the seven hand-rolled headline numbers | `accounts/[id]/page.tsx:148` · `merchants/[id]/page.tsx:48` · `categories/[id]/page.tsx:134` · `settings/page.tsx:87` · `imports/page.tsx:108-116` · `PortfolioChartPanel.tsx:185` · `HoldingChartPanel.tsx:217`; push `StatCard` (2 consumers today) into `ForecastCard.tsx:31-63`, `PortfolioStats`, `PositionCard`, `PeriodActivityPanel.tsx:98-106` | Money stops changing size as the owner navigates, and every tile inherits the drill-down arrow for free | Medium | M |
| S19 | Move the page layer onto the motion vocabulary the overlay layer already uses | define `--transition-ui` / `--transition-emphasis` in `globals.css`, swap the **114** bare `transition-colors duration-(--duration-fast)` sites; add hover lift on drill-down cards and `active:scale-[0.98]` on pills. Kill or use `--duration-slow` and `--ease-in-out-sine` — a dead token is a lie about the system | Medium | M |
| S20 | Make the money-input parse path one wrapper | `parseAmountToCents` is called raw at `accounts/actions.ts:57,77`, `investments/actions.ts:47`, and the cash-wallet forms — each with its own (absent) error story | Medium | S |
| S21 | Use the dead `SpendDelta` import instead of leaving it | `categories/[id]/page.tsx:32` imports it unused; render the MoM delta beside the headline exactly as `spending/page.tsx:87-89` does. Same class of fix: `PortfolioStats.tsx:27`'s dead ternary, `imports/page.tsx:24-30`'s unused `RECONCILIATION_LABEL` map, `imports/page.tsx:38,42` (`format`, `importedAt` selected and never rendered) | Low | S |
| S22 | Show the MoM delta at every granularity and on mobile | `spending/page.tsx:89` already pays for the prior-period breakdown unconditionally, then gates the display on `granularity === "month"` at `:235`; `SpendingCategoriesTable.tsx:119` hides it below `md` | Low | S |

---

## Dropped — belongs in the ADD list

These appeared in the raw proposals but are **net-new functionality**, not fixes to something that
exists. They are removed from the tables above and belong in `06-what-to-add.md`.

| Proposal | Why it's an ADD |
|---|---|
| Restore-from-backup UI, "Back up now" button, `verifyDerivedCache` maintenance panel | New /settings capabilities; no restore path exists today at all |
| `unmergeSeries`, `unacceptGap`, `reactivateBudget`, `restoreBudgetAction` | New inverse services. The *confirmations* for the forward actions are fixes (L13); the inverses are new |
| `/categories` and `/merchants` index routes | Both directories contain only `[id]/page.tsx` — these are new pages |
| Bottom tab bar for the phone | New navigation surface. The `MobileNav` overflow/edge-fade/scroll-into-view fix (K28) stays |
| Series `displayName` column + effective-name resolution | New schema column and resolution layer |
| Closed-positions section; portfolio-wide realized-P/L drill-down | New sections (though `RealizedSalesList` exists to feed them) |
| Savings-rate history view | New surface |
| `series` and `importFile` ledger filter dimensions + a `sort`/`dir` pair | New filter dimensions in `TxnFilters`. The *existing*-filter preservation bug is C21 |
| Free-text search + filter chips on rules, imports, series, review clusters | New controls. Sorting via the existing `DataTable` is S6 |
| Real "Test connection" action for the Claude API key | New server action. The key-presence light being misleading is noted under L8/C24 |
| Claude egress preview + per-string suppression list + name redaction | New privacy surface and a new suppression store |
| `?txn=` deep-linkable transaction sheet | New URL contract for a sheet that is currently local state |
| `suggestedCategoryIds` population + suggestion float | `ledger-rows.ts:67` hardcodes `[]`; wiring a real producer is new inference work |
| Density toggle, third grid column at `xl` | New layout modes. Raising `AppShell`'s max-width (K30) stays |
| Non-blocking import/Claude run-id + polling infrastructure | K23 keeps the *catch* and the pending state as fixes; the background-job system itself is new |
| Heavy 3D / ambitious abstract dataviz | Entirely new — and blocked on K15/K16/C1 landing first, since there is no frame budget or streaming boundary to give it today |

---

### Suggested landing order

1. **C1 + C2 + K1 + K2 + K3** — one afternoon; removes the crash class and the two measured mobile overflows.
2. **C10 + C8 + C9** — the mutation contract. Everything after this becomes safe to iterate on.
3. **K16 + K15 + K18** — the measured perf wins, before hosting.
4. **C27 + C28 + C22** — the data-integrity block. Do not host without these.
5. **S1 + S5 + L1 + L3** — the visible quality jump: hierarchy, buttons, dates, receipts.
6. **K35** — lock all of it in, so none of it silently comes back.


---

<div id="sec-06"></div>

> **▼ SECTION 06 — What to add**

# 06 — What to add

235 raw proposals from 21 route- and concern-level audits, merged down to 62 distinct items.
Duplicates were collapsed hard: "add an export button" was proposed 8 times on 8 surfaces and is
one row here; "show a freshness date" was proposed 6 times and is one row; "add a period selector"
was proposed 5 times and is one row. Where a merged row covers several surfaces, every surface is
named so nothing gets lost in the merge.

Two groups, each ranked by value to **one owner managing his own money** — not by effort, not by
how impressive it is in a screenshot.

- **Table stakes** — a reasonable user opens the app expecting this and it is not there. Most of
  these are wiring: the service already computes the number, or the component already exists and is
  rendered on exactly one sibling surface.
- **Ambitious tier** — nobody expects it, and it is why this app would beat Monarch/Copilot for
  this owner specifically. Every one of these is built on the pure, unit-tested `lib/` math that
  already exists, so none of them can disagree with the ledger.

Everything below is **additive**. Nothing in this document removes a feature.

---

## Table stakes this app is missing — things a user reasonably expects that simply are not there

| # | Add | Surfaces it touches | What it does | Why the owner would miss it | Effort |
|---|-----|---------------------|--------------|------------------------------|--------|
| 1 | **A freshness + coverage strip in the shell** | `src/app/layout.tsx` (already does two guarded DB reads, layout.tsx:22-46), new `components/shell/DataHealthStrip.tsx`; consumes `dashboard.ts:131` asOf, `derivation.ts:284-345` coveredAccountNames/missingAccounts, `imports/page.tsx:51-64` gap query, `review-count.ts:6`, `price_cache` max quotedOn | One persistent line above `main`: balances as of {date}, N days since last import, M accounts uncovered today (named), K open gaps, prices as of {date}, R rows awaiting review — each segment a link to the fix | Every number in this app is derived and the app never says "as of when". Five surfaces currently label 8-day-old data "today". It also gives `/imports` its first inbound link from anywhere | M |
| 2 | **Export — CSV of any filtered set, and of every table** | New route handlers; buttons on `TransactionsLedger`, `PortfolioHoldingsTable`, `ScrubTable`, `SpendingCategoriesTable`, `RealizedSalesList`, `HoldingEventsList`, `imports/page.tsx:168`; plus JSON of categories/merchants/rules/anchors and a raw `.db` download from `/settings` | Streams `matchingTransactionIds` (transactions-query.ts:158) with date, account, description, raw description, merchant, category or split parts, amount, status, transfer group, notes, source, confidence | Grep finds zero export code in the repo — the app is a one-way sink holding five years of reconstructed history. Table stakes at tax time, and the cheapest possible trust win | M |
| 3 | **Restore from a backup, and snapshot before anything destructive** | `src/app/settings/page.tsx:113-130` (today lists filenames and sizes and nothing else), `src/services/backup.ts`, offered inline before un-import and accept-gap | Per-row Restore behind a typed confirmation, a pre-restore safety snapshot, a Download, and a summary of each restore point (txn count, latest txn date, net worth that day) so he chooses a state not a filename. Plus a "Back up now" button | The app takes real `sqlite.backup()` snapshots and cannot use one. Backups nobody has restored from are a hypothesis. Two one-click irreversible buttons ship today with no net under them | L |
| 4 | **A shared period bar on every analytical surface** | Promote `components/spending/PeriodSelector` to `components/ui`; mount on `/budgets` (verified: `budgetPaceStatuses(db, refDate)` already returns a correct historical picture), `/merchants/[id]` (`merchants.ts:53` takes an injectable today), `/accounts`, `/investments`, dashboard | Period pills plus a bounded prev/next pager, with an empty period offering "jump to your most recent activity" | Two of fifteen routes have a period control. `/budgets` is hard-wired to `todayIso()` (budgets/page.tsx:46) so "did I hit my budget last month" is unanswerable anywhere in the app — he has ten targets and zero track record | M |
| 5 | **A filtered-set summary strip and sortable columns on the ledger** | `src/app/transactions/page.tsx` (ledgerOrder is a hardcoded const at page.tsx:114-121), `src/components/transactions/query.ts:17-31`, `transactions-query.ts:48` | A bar under the tabs stating total in, total out, net, count, distinct merchants, distinct accounts, date span, average for the CURRENT filter set (same predicate as the counts, so it reconciles by construction); plus sort/dir params driving `ledgerOrder` with the content tiebreaks kept last | Filter to "Dunkin, last 90 days", get 41 rows and no total. "What were my five biggest charges in June" is unanswerable on the only full-ledger filter in the app | M |
| 6 | **A real rule editor with a match preview** | `src/components/settings/RulesManager.tsx`, `src/app/settings/rules-actions.ts`, `schema/rules.ts:21-51`, `rule-corrections.ts:104-181` | New rule and edit rule, composing the full condition set (accountIds, amount range, direction, description regex) and action set (category, markTransfer, exclude, renameTo, series) that `renderRuleSentence` (rules-manager.ts:63-93) can already render — with the sentence as a live preview, and the matching ROWS shown before Re-apply | The manager reads a vocabulary it cannot write. He hand-categorized ~1,300 rows over a full pass because he could not express "every Wise transfer from dad is a Family pass-through" as a rule. And Re-apply currently fires a bulk ledger mutation blind against a count | L |
| 7 | **A /merchants index, with merge and an alias panel** | `src/app/merchants/page.tsx` does not exist (verified) — add it plus `mergeMerchants(db, fromId, intoId)` in `services/merchants.ts`, an aliases reader, and a Merchants entry in `shell/nav-items.ts` | Sortable searchable table: merchant, alias count, txn count, YTD spend, default category (inline editable), uncategorized count, last seen — default sorted by uncategorized desc. Merge repoints transactions, aliases, and `recurring_series.merchant_id` and returns an undo patch. Alias panel lists, tests and deletes patterns | Claude wrote ~434 merchant mappings on his behalf and there is no screen that shows them. Duplicate merchants are structurally guaranteed by `claude-categorize.ts:233-249` and there is currently zero way to fix one without hand-editing SQLite | L |
| 8 | **Categorize from the report that tells you to categorize** | `/spending` — wire the already-built `components/spending/InlineCategorizeList` and `loadSpendingCategoryTxns` (spending/actions.ts:15-21) into the Honesty card's Uncategorized row, each category row's expander, and the largest-purchase sheet | Expands in place into the capped list with its CategoryPicker, routed through `runCategoryCorrection` so the "apply to all N" snackbar and Undo come free | The component exists and is currently rendered by exactly one consumer, `/categories/[id]:215` — the loader's own docstring calls it "the Spending page's inline categorizer" and /spending cannot reach it. His entire pass-24 workflow was categorization | M |
| 9 | **Account scope, everywhere it is already supported in the service layer** | `/spending` (reads only period/from/to today), `/accounts/[id]` per-account spend and income summary, `/investments` (`portfolio.ts:191,240,252` already accept `accountIds` and nothing passes them) | An account multi-select in the period bar that scopes every aggregate, URL-driven so it is shareable; plus a this-month-vs-last card on each account page with top categories, top merchants and recurring charges | "What did I put on the Venture X this month" is unanswerable anywhere. He runs three checking accounts, three cards, a Robinhood settlement ledger and a dad's-money pass-through | M |
| 10 | **A running-balance register** | `/accounts/[id]` and `/transactions` when scoped to one account with date-desc sort | Each transaction with the balance after it, straight off the derived series, with basis-shaded rows so the chain is visibly verified or not | It is how he reconciles against a paper statement — the exact activity this app exists for — and it is the one thing every bank register has that this ledger does not. Also the fastest way to spot the row where a reconciliation broke | M |
| 11 | **Budgets visible on the pages he actually opens** | Dashboard activity hub card, `SpendingCategoriesTable` budget column, `SideNav`/`MobileNav` badge, `/categories/[id]` set-and-edit inline via `BudgetAmountEditor` | Worst-three-by-pace with progress and projected end-of-month, a budget column beside actual and forecast, a nav count when any status is `warn80` or `over`, and budget creation from the category page | Budgets have exactly ONE inbound link in the whole app (categories/[id]:173). `alert === 'warn80'` is computed on every status (budgets.ts:144-148) and rendered on no page at all | M |
| 12 | **Missed occurrences, and a cancelled / paused / skip-this-one vocabulary** | `/recurring`, `/recurring/[id]`, `services/recurring.ts:696` (projectOccurrences silently skips overdue), `recurring-calendar.ts:24-78` (already computes paid / paid_different / upcoming / missed per day) | A per-series timeline of expected vs actual with variance and a link to the charge; plus promoting `ended` to a one-click "I cancelled this", a `recurring_skips` overlay honoured by the projection and the forecast, and an auto-pause when `isSeriesActive` goes false | Rent expected on the 1st, nothing posted by the 10th, and the page says "next expected Aug 1" without ever mentioning July. A missed bill is the single most valuable thing a recurring tracker can say. And cancelling a gym today means Dismiss (wrong meaning, unrecoverable) or a phantom in the forecast forever | L |
| 13 | **`?series=` on the ledger, and drill-through from every recurring number** | `services/transactions-query.ts:47-107` (add `eq(transactions.recurringSeriesId, id)`), `SeriesDetail.tsx`, `AmountHistoryChart`, `RecurringCalendar` day sheet, `UpcomingList.tsx:24-36` (rows are plain text on the default tab while All and the calendar both link) | Every count, amount and calendar cell opens the rows behind it, and "See all 41 charges · $2,438.59 total" replaces a bare count | The app's own doctrine is that a displayed number is always a visitable list. Recurring is the one surface where it is not honored, on the numbers most likely to be wrong | M |
| 14 | **Create, duplicate and delete a transaction from the ledger; see and delete cash-wallet rows** | `/transactions` (wire `addManualTransactionAction`, actions.ts:516 and `deleteManualTransaction`, manual-transactions.ts:267), `/accounts` cash wallet card (wire the orphaned `deleteManualTransactionAction`, cash-actions.ts:38) | Add transaction beside Select, row-level Duplicate for repeated cash entries, delete on manual rows only with the existing audit guard refusing everything else; wallet cards list their last rows with a running balance and an inline edit | Cash spending, reimbursements and IOUs are a real part of his ledger (the cash-job story) and the page literally named for the object cannot create one. A typo'd cash entry is currently permanent from the UI's point of view | M |
| 15 | **Real trade entry: Buy / Sell / Dividend, with a trade log and delete** | `/investments`, `HoldingForm.tsx:55-63` (today the only write is "set the resulting total quantity"), `HoldingEventsList` | Buy/Sell taking shares plus price plus date and deriving the delta, a portfolio-wide trade log with row-level edit and delete behind a confirm, and a stored execution price so realized P/L stops being a daily-close estimate | The two most common real actions ("I bought 10 more", "I sold half") both require mental arithmetic today, and there is no delete for a holding or a holding_event anywhere in the UI. His 1,991-event timeline came from ad-hoc scripts, not the product | L |
| 16 | **A statement coverage map, and per-account staleness** | `/imports` — extend the `statement_periods ⋈ accounts` query already at imports/page.tsx:51-64 | Account rows × month columns for the whole history, each cell reconciled / value anchor / accepted gap / open gap / declared-range-only / nothing imported, with per-account last statement date, days stale and missing months since. Cells link to the file and to the date-ranged ledger | On his real DB, Chase Checking's newest period ends 2024-07-11 and Discover's 2024-08-18 against today, while the page reports "Reconciled periods 105" in green. He is making net-worth decisions on two accounts that stopped two years ago and the surface actively reassures him | L |
| 17 | **An import receipt, kept as history** | `/imports`, `src/app/imports/actions.ts:19` (discards every FileOutcome), `src/services/import/service.ts:41-58` | Persist each batch's outcomes and render the last run: files, rows inserted, deduped, deferred to a higher-fidelity source, takeovers, quarantines, accounts touched, net effect on each balance — with a scrollable history | A batch where every row was `skippedOwned` is pixel-identical to one that inserted 2,000 rows. "Did last month's drop actually land?" is the most basic question a file-based finance app gets asked | M |
| 18 | **A gap workbench, and un-accept** | `/imports`, `imports/page.tsx:127-147`, `service.ts:822` (accept permanently disables re-reconciliation), `service.ts:990-1013` | Per unreconciled period: printed beginning, printed ending, replayed sum, signed delta, the rows in range with a ledger link, the file that produced it, and three explicit paths (import a corrected file, add a manual transaction, accept as-is) plus a persistent Accepted-gaps list with the dollars each is carrying and an un-accept | Today a $43.64 discrepancy offers one irreversible button that then erases the evidence he pressed it. This is the page's own headline promise with no workflow behind it | L |
| 19 | **A visible search / command trigger in the header** | `src/components/shell/AppShell.tsx:50-59` (currently a static tagline plus a theme toggle) | A "Search… ⌘K" button on desktop, a magnifier on mobile, opening the existing `CommandPalette` | The palette is the ONLY enumeration of merchants, categories, accounts and holdings in the app, and it is reachable by keyboard shortcut only — i.e. not at all on the phone he says he will read this from | S |
| 20 | **Confirmation with a stated blast radius on every destructive and bulk action** | A `useConfirm` hook over the existing `Sheet`, plus a `<BlastRadius>` that renders the affected ROWS from the same predicate the mutation will use. Adopt in `RulesManager.tsx:163`, `BulkActionBar.tsx:68-76`, `TransactionSheet.tsx:290-294`, `imports/page.tsx:198`, `accounts/[id]/page.tsx:245,272`, `BudgetRow.tsx:202`, `AllSeriesView.tsx:85,175`, `SeriesMembership.tsx:317` | Names the consequence and the count, shows a sample of the rows, then commits | The best destructive-action design in the codebase already exists — the re-derive gate at `EditAccountSheet.tsx:150-155,199-214` with a live region, a plain-English consequence and a checkbox that resets — and was never reused. Eight one-click irreversible actions ship without it | M |
| 21 | **A `useAction` hook, and a degraded-state vocabulary** | New `hooks/useAction.ts` modelled on the sequence-guarded `hooks/useInlineEdit.ts:71-102`; then migrate the ~47 unguarded `.then` call sites. Plus `DegradedCard`, `StaleBadge`, `RetryButton` beside `Skeleton` and `EmptyState` | One hook owning pending in a `finally`, a `catch` that surfaces the server's message, a stale-response guard, and optional optimistic-with-rollback. The three primitives let one card fail without taking the page | Today a rejected server action is indistinguishable from success, a partial failure has only two presentations (a 5-second toast or a full-page crash), and `netWorth.asOf`, `HoldingRow.quotedOn` and every institution's asOf are computed and thrown away | M |
| 22 | **The mobile survivability pack** | `FiltersBar.tsx:32` into a "Filters (3)" Sheet below md; a shared `<ResponsiveTable>` (card layout below sm) for `PortfolioHoldingsTable`, `AllSeriesView`, `imports/page.tsx:168`, `AccountHoldingsTable`; a `<ScrollRail>` with edge fades and an "N more" count for `MobileNav.tsx:14`, `UpcomingBillsStrip.tsx:42`, `DataTable.tsx:175`, `AllSeriesView.tsx:113`; a phone-first summary block above the fold on all five detail routes | Makes the phone the first-class device it is supposed to be | Measured at 390px: /investments' holdings table needs 591px, /recurring's needs 596px, /accounts/[id] is 3341px tall (4 screens) before the answer, and half the nav destinations are off-screen with no affordance saying so | L |
| 23 | **A responsive + touch contract test, and a `pnpm shots` script** | New `e2e/responsive-contract.spec.ts`; `playwright.config.ts:41` gains a touch project; a script capturing every route at 390/768/1440/2560 in both themes into `docs/screenshots/` | Per route per width: `scrollWidth === clientWidth`, no interactive element under 24px (44px on touch), the `aria-current` nav item inside its visible box, no `title=` as the sole carrier of meaning | `grep scrollWidth e2e/` returns zero hits and `visual.spec.ts` screenshots the clipped viewport, so overflow is invisible in a baseline. Five routes shipped with visible horizontal overflow. Without a gate, pass 26 reintroduces all of it | M |
| 24 | **A keyboard legend, and KeyScopes on the ten surfaces that register none** | New `?` overlay listing the real bindings; `useKeyScope` at `PRIORITIES.list` on `/accounts`, `/budgets`, `/recurring`, `/recurring/[id]`, `/investments`, `/investments/[assetType]/[symbol]`, `/categories/[id]`, `/spending`, `/merchants/[id]` | j/k movement, Enter to open, `e` to edit, `[`/`]` to reorder or page, `/` to focus a filter — plus small `<kbd>` hints on Select and Confirm | Three genuinely good accelerators exist (`x`, `r`, `⌘K`) and not one character of UI anywhere mentions them, so in practice they do not exist. Writing the legend will also immediately surface that the ↑/↓ sheet navigation documented at TransactionsLedger.tsx:88-90 was never implemented | M |
| 25 | **Chart parity for the last four charts** | `AmountHistoryChart` (recurring detail), `MonthlyTrendBars` (categories), `CashFlowView` including the Sankey (/spending), and a new merchant spend chart | Wrap in `components/charts/ChartFocus`, add `ChartRangePills` via `lib/chart-window`, append `LENS_DIMENSION` to a new view spec (append, never insert — chart-lens.ts:17-19), add keyboard scrub | These are roadmap rows 4 and 5 in `docs/future-ideas.md`, still open. The /spending Sankey is unreadable at 22rem with a dozen categories while the dashboard's identical Sankey gets focus mode. The merchant PAGE has no chart while the transaction SHEET shows a sparkline of the same series | M |
| 26 | **Compare to the previous period, and to last year** | `/categories/[id]` (SpendDelta is already imported and unused at page.tsx:32), `/spending` (prior window already computed at page.tsx:87-90 and reduced to one ghost line), `/recurring` calendar and forecast tiles, dashboard hero | A delta amount, a percentage and a link to that period, plus a ghosted prior-period curve via the existing `projection.reindexByPosition` | "Food $5,113" means nothing without last month beside it. Two thirds of the plumbing is already paid for and thrown away on every render | M |
| 27 | **A first-run guided path** | Dashboard zero state (`page.tsx:111-135`, three static cards with zero interactive elements), every empty state | Add institution → add account → drop a statement → watch it reconcile, with a live checklist, done in place rather than across three routes. Derive "no accounts" from `listAccounts` not from the last daily_balances point (dashboard.ts:135 currently mislabels an accounts-added install as "No accounts yet") | The only state every future user hits with certainty, and the least designed screen in the app. It is also where the real differentiator — statements reconciling to the cent — is most persuasive and never demonstrated | L |
| 28 | **Notes on every entity** | One nullable column plus the existing `InlineEditableText` on accounts, merchants, recurring series, budgets, holdings and categories | "This is dad's money, it passes through" · "Citi promo run through Carson's account" · "$50 Travel is deliberate, Cancun was reimbursed" · "cancel before the annual renewal" | Pass 24 was 16 questions of him reconstructing what merchants were. Every answer lives in a session-memory file, not in the app, and the Travel budget will read "over by 4798%" forever with no way to record why | S |
| 29 | **Saved views on /transactions** | Persist named filter sets into `app_settings.viewPreferences` (`lib/view-state.ts` plus the settings actions already exist), render as a chip row above `FiltersBar` | Uncategorized · Needs review · This month · Large (>$200) · Manual rows · Split rows · Low confidence, plus user-saved — each just a `filtersToQuery` string | His working passes are the same handful of queries over and over, each currently a hand-built URL or a five-control form fill | M |
| 30 | **Explain panels: why is this in review, and why this category** | `TransactionSheet.tsx` (pair with the suggestion line at :32-36), and a "what the app has learned about this category" panel on `/categories/[id]` | Review reason, assigning source and confidence, the winning rule with a link and a disable action, the merchant default, and for a Claude row the batch and date. On the category page: the rules targeting it, the merchants defaulting to it, and a count by `categorization_source` | A categorized row is an assertion with no evidence, on a surface whose whole premise is that everything is provable. After seven guarded write passes his central question is "why does this row keep landing here?" and no screen answers it | M |
| 31 | **A suspected-duplicate review surface** | `/transactions` — give `flagFuzzyDuplicates` (import/service.ts:877-894) its own view or cluster kind | Two rows side by side with account, date, amount, description and source file, and "same transaction, exclude one" vs "genuinely two charges" | Duplicates are the one review category that changes NET WORTH rather than categorization, and today they are indistinguishable from a Claude confidence wobble in the same queue | M |
| 32 | **Bulk verbs on the surfaces that never got them** | `BulkActionBar` gains Note and Merchant (the undo schema already carries `merchantId`, bulk-edit.ts:46, and the header comment at :12-13 concedes merchant is deferred); `/accounts` multi-select archive/re-home/reorder; `/recurring` suggestion queue multi-select with "confirm all above 90%"; selection plus the existing `bulkEdit` verbs on `/categories/[id]` | Every bulk path returns the same lossless `UndoPatch` the ledger already produces | He tagged cohorts ("dad's money", "Cancun reimbursement", "Carson's card") with guarded SQL scripts because the UI has no bulk annotation. 31 recurring suggestions × one full navigation each is why he has confirmed zero series in this database's history | M |
| 33 | **A /categories index, plus archive, merge and identity editing** | New `src/app/categories/page.tsx` (the directory contains only `[id]/`), a Categories nav entry, and an identity picker on the header CategoryChip | Index lists every top-level category with period spend, share, MoM delta, 12-month sparkline, budget status and subcategory count. Archive writes the `categories.isArchived` flag that the schema, `category-options.ts:20` and `command-index.ts:53` already honour and no UI writes. Merge re-points `transactions.category_id` in one transaction with an undo patch | Categories are the app's primary organizing concept and no screen lists them. A 67-category taxonomy can be renamed and re-parented but never retired or folded in, so the picker only ever grows. The 12-hue identity ramp that colours the donut, the Sankey and every chip is entirely unwritable from the UI | M |
| 34 | **Suspense boundaries and a request-scoped cache** | `React.cache()` around `activeTxnsInRange`, `loadCategoryIndex`, `transferFloats` (dashboard runs it twice at ~439ms each), `buildPortfolio` and `portfolioRealizedPl` (/investments builds them 4× and 5× per render), `latestBalances`; `<Suspense>` around `forecastCurrentMonth` (~637ms) and the portfolio aggregates | Fast shell, slow islands, and per-island error boundaries | Zero Suspense boundaries exist in the repo, so the fastest number on every page waits for the slowest. better-sqlite3 is synchronous — every ms blocks the whole process. This is the difference between the hosted free tier feeling instant and feeling broken | M |
| 35 | **Hosting prerequisites, tracked as a decision** | `src/middleware.ts:14-20` 403s every Host that is not localhost; `db/client.ts:46` runs `migrate()` on every cold boot | Replace the loopback guard with real auth, and pick the runtime deliberately (long-lived Node with a persistent volume, since better-sqlite3 is native and synchronous and cannot run on edge — the pass-13 Turso investigation priced the async rewrite at ~68 files) | "Eventually hosted with auth" is stated as a goal in three places in this codebase and there is exactly one file that makes it impossible, with no note anywhere saying so. It should be a tracked decision, not a discovery on deploy day | L |
| 36 | **Search that covers notes, merchant names and amounts** | `transactions-query.ts:111-122` | Extend `q` to match notes and the joined merchant canonical name, parse amount literals ("42.50", "> 100"), debounce into the URL instead of requiring a Filter press, and highlight the match in the row | He can annotate every row (`LedgerRowExpander.tsx:134`) and can never find those annotations again, which makes the notes feature write-only | M |
| 37 | **Percentage and even-split helpers in the split editor** | `SplitEditor.tsx:158-182` | A "%" toggle per line and "Split evenly across N", with the existing remainder readout absorbing the rounding penny | Splitting a $214.83 Costco run three ways is three manual subtractions the editor already has the numbers to do | S |
| 38 | **Prev / next sibling navigation on detail routes** | `/investments/[assetType]/[symbol]`, `/recurring/[id]`, `/accounts/[id]`, `/merchants/[id]` | Chevrons walking the same ordering the index used, so an audit sweep does not round-trip through the list | His stated workflow is "check every page, every button". Reviewing 30 positions currently costs 60 navigations | S |

---

## Things that would make it exceptional — the ambitious tier

| # | Add | Surfaces it touches | What it does | Why the owner would miss it | Effort |
|---|-----|---------------------|--------------|------------------------------|--------|
| 1 | **A "why did it change" waterfall, shared by three surfaces** | Dashboard hero, `/accounts/[id]` chart, `/spending`; composes `services/period-activity.ts` (in/out/topCategories), `portfolio-returns.decomposeValue` (exact contributions-vs-gains identity), `in-flight.transferFloats` | For any brushed window, a horizontal waterfall decomposing the delta into income, spending, market gains and losses, transfers in and out, and unexplained/coverage drift — reconciling exactly to the delta the chart header already shows | The chart says "+$24,759 (+28.8%)" and there is no way to ask why. For an owner with a cash job, family money passing through, gambling flows and a 1,991-event brokerage timeline, attribution IS the product. Every input already exists; nothing new needs deriving | L |
| 2 | **An anomaly engine, surfaced as an attention rail and nav badges** | Dashboard rail, `/spending` strip, `SideNav`/`MobileNav` badges per surface (Imports = open gaps plus quarantined, Budgets = warn80 plus over, Recurring = missed plus newly-inactive, Accounts = stale) | Server-generated cards: a category >2σ or >50% above its trailing-3-month mean, a first-time merchant over a threshold, a recurring charge that stepped up, the period's largest transaction, an account not updated in 21 days — each linking to the exact filtered rows | The app reports; it never notices. It knows more than enough after 1,300 hand-categorized rows to volunteer something. The nav has one dynamic signal for eight surfaces that each compute an attention number, which is exactly why /imports and /budgets are orphans | L |
| 3 | **Provenance: a "why is this number what it is" drawer, and a basis ribbon** | `/accounts/[id]` headline and chart; `services/derivation.ts:145-158` already returns the verdict | The headline opens a drawer reconstructing the level: the winning anchor it replayed from (date, source, amount), the count and sum of transactions replayed since, whether the chain closed to the cent, and how many days are carried vs derived vs missing. Under the chart, a thin band with one segment per span coloured anchored / derived / carried / unverified, clickable to zoom | This is the product's single best idea — "daily_balances is a derived cache, truth is transactions plus anchors" — and the page currently shows the cache and hides the derivation. The ribbon makes it legible in one glance on a phone and fixes the straight-line-across-a-gap dishonesty at the same time | L |
| 4 | **Net worth by composition over time — the abstract one** | Dashboard, as a 7th option on the existing `DASHBOARD_VIEW_SPEC` dimension; and a per-institution variant on `/accounts` from the combined arrays `institution-groups.ts:196-205` already computes | A stacked-area / streamgraph of cash vs brokerage vs crypto vs debt as bands across two years, scrubbable on the same day axis, with the same coverage honesty (partial days soft, gaps not invented). Reuses `accountSeries` plus `multi-series.alignOverDays`, so it costs no new math | He explicitly asked for ambitious visualization. This is the one that is both spectacular and truthful: it shows the SHAPE of the balance sheet changing, which none of the five current modes do, and answers "where did my money migrate to" | L |
| 5 | **Cash runway and a 14-day calendar with the projected low point** | Dashboard tile beside Free to spend, `/recurring` calendar | "Liquid $X across checking and savings · N days at your current burn" with a depletion sparkline; and a day-column strip where each day shows what is due, the paycheck is flagged, and a running lowest-projected-balance line marks the tightest day and any day the projection goes negative. Inputs: `latestBalances`, `cashFlow` spend rate, `upcomingOccurrences`, `forecast.ts:325-334` | Net worth includes an $88k portfolio and cannot tell him whether rent clears next week. "Can I cover the 1st" is the operative question on a variable cash income and today he reconstructs it in his head from a list of dates | L |
| 6 | **Contributions vs market gains, over time** | `/investments` as a third view option, and `/investments/[assetType]/[symbol]` extending `DecompositionBar` (`ReturnViewParts.tsx:300-346`) from one all-time bar into a stacked area | Net contributed capital as the base band, cumulative market gains or losses above or below it, across the same day axis. `decomposeValue` already produces the exact identity (netContributed + gains == value) and is unit-tested; it just needs evaluating per day | The most motivating chart in personal investing — "how much of my $89k did I put in vs earn?" — and the math is already written, tested and reconciling. It currently collapses to a single static bar | M |
| 7 | **A subscription audit view, and price creep as a narrative** | `/recurring` fourth tab plus `/recurring/[id]` | All subscription and bill series ranked by annualized cost (`recurring.ts:534-537`), with a sparkline of amountHistory, a total monthly-equivalent burn, a cost-since-first-charge per series, and a "price increased 3 times, +18% since Jan 2024" badge derived by comparing the first and last thirds of the history. On the detail page, state the change points: "$9.99 → $12.99 on Mar 14 (+30%) … you have paid $187.44 more than the original price" | The single highest-value thing a finance app does that a bank statement does not, and the reason Rocket Money exists. He cannot currently answer "how much am I committed to per year?" without adding 31 numbers by hand | M |
| 8 | **The budget visualization suite, and re-predicting existing budgets** | `/budgets` — the only major surface in the app with zero data visualization (verified by grep: no ScrubChart, Sparkline, StatCard, lens or focus) | Per row: a 12-month actual strip with the budget as a reference line, plus a 12-month hit-rate squares strip from `categoryMonthlyTrend`. Page level: budget-vs-actual with a chart⇄table lens and focus; a radial burn dial where arc is period elapsed and fill is spend. Plus `repredictBudgets(db)` running `predictBudgetableCategories` over the BUDGETED set (which `predictBudgets`, category-forecast.ts:310-320, deliberately excludes) with per-row Accept | Measured on his real DB: 8 of 10 budgets are >15% from their own 6-month actuals and 5 are >34% off, while "Predict budgets" returns 3 rows, 2 at 0% confidence, because he already budgeted everything. The prediction engine's best use is the one thing it cannot do. And the bar he has is 10px tall and clamped at 100%, so 108% over and 4,898% over look identical | L |
| 9 | **A statement-period timeline ribbon** | `/imports` | A horizontal time axis per account with periods as segments coloured by reconciliation state, transaction density as a histogram inside each segment, anchor ticks where chain-grade anchors land, and visible white where no statement exists. Brushable; a segment opens the file detail sheet. Reuses `ScrubChart`'s coverage band and `lib/chart-axis.ts` | It is "think abstract" pointed at the one question the trust layer cannot answer, and it makes two-year gaps physically visible instead of a number he has to notice is absent. It also turns the plainest screen in the app into the most striking | L |
| 10 | **A file provenance sheet, and one-click re-parse** | `/imports` row click; `storage_path`, `parser_version`, `statement_periods.import_file_id`, `balance_anchors.import_file_id` are all modelled and none is reachable; `PROFILES` version at `import/profiles/index.ts:21`; supersede-then-reimport at `service.ts:397-405` already carries user categories forward | Institution, resolved accounts, format, sha256, parser profile and version, imported-at, archive path with download, the periods it created with their reconciliation, the anchors it wrote, and its transactions via a new `importFile` ledger filter. Plus "N files were parsed with an older parser" and re-parse from the archived original | The whole re-parse lifecycle is implemented and completely unreachable — the only trigger is finding the file on disk and re-uploading it. Every parser improvement he ships is dead capital across 88 files | L |
| 11 | **A per-symbol-per-day P/L heatmap** | `/investments`, from `holdingDeltasBetween` (portfolio.ts:834) which already computes per-symbol deltas per day | Symbols on one axis, days on the other, so he can see which position drove a bad week rather than opening 20 day sheets. Pair with a one-line "why did this move" strip under the hero generated from `pnlDayDetail` — "Up $412 since Jul 19 — NVDA +$580, ETH −$210, everything else flat" | The calendar answers "which day was bad" and nothing answers "which holding has been consistently bad". The attribution sentence is three sections and a click away from the question it answers | M |
| 12 | **Overlay compare, everywhere the engine already supports it** | `/accounts/[id]` (sibling accounts), `/investments` (2-3 simultaneous benchmarks plus a You/SPY/QQQ/BTC table with total return, best day, worst day, max drawdown), `/investments/[assetType]/[symbol]` (compare against another holding) | `ScrubChart` already supports named `overlays` with per-series coverage splitting and a legend (ScrubChart.tsx:294-322, 669-696), driven today only by `DashboardModePanel` | "Is my savings growing faster than my card balance", "was I taking more risk for that return", "which of these two do I sell" — all one-line service calls away. The engine is built, tested and in production on exactly one surface | M |
| 13 | **An append-only mutation log, and an operations log** | New `mutation_log` and `operation_runs` tables, one wrapper around the value-returning actions; surfaced on `/settings` and in the transaction sheet's Raw block (`TransactionSheet.tsx:362-374`) | Mutation log: at, action, actor, target ids, compact before/after, the UndoPatch where one exists, with per-entry Undo. Operations log: every import, categorization, Claude classification, price refresh, recurring detection and rebuild with status, summary and error text | `categorization_source` names WHO last wrote a category and nothing names WHEN, WHY or WHAT IT WAS. When the Claude button "was failing" in pass 24 there was no record anywhere of the attempt, the error or the cost. An app whose pitch is auditability keeps no audit trail of its own automation | L |
| 14 | **Detection tuning: "why isn't X recurring", and a manual series builder** | `/recurring`, `services/recurring.ts:33-36,159,166` (MIN_OCCURRENCES, AMOUNT_STABILITY_CV_MAX are exported), `/recurring/[id]` audit panel | Near-miss groups with the reason in words ("gaps 18/45/22 days, no cadence fits") and a "make it recurring anyway" button; a New series wizard (name → cadence → amount → next date → attach) reusing `createSeriesFromTransaction` and `attachTransactions`; and on the detail page every gap with a ✓/✗ against toleranceDays plus the amount mean/σ/CV against the 0.2 threshold | `docs/future-ideas.md:250` records that his real Fordham payroll is not modelled and his projected income was $0.01 because of it. The page that owns recurring has no way to create a recurring, and the module's own header promises "statistics, not a black box" | L |
| 15 | **Savings goals and income targets** | `/budgets` as a parallel concept — `requireBudgetableCategory` (budgets.ts:58-60) hard-rejects non-expense kinds, so this is additive and the existing path is untouched | A monthly savings target measured against net (income − spend) and per-income-category targets measured against `incomeTransactions` (analytics.ts:439), rendered with the same pace bar | His income is irregular (cash job plus family pass-through), which is exactly the situation that makes "am I saving anything this month" the operative question — and the app's only goal-setting surface refuses to answer it | L |
| 16 | **Tax lots, and a cost-basis reconciliation** | `/investments` — unrealized P/L uses the broker-supplied `holdings.avgCostCents` (portfolio.ts:591) while realized uses an average-cost walk at closes (`realized-pnl.ts`), and the two sit adjacent in `PortfolioStats.tsx:84-129` with nothing stopping a reader from adding them | Per-lot tracking (date, shares, price), a short-term vs long-term split on realized gains, and one stated basis | Two incompatible cost bases displayed side by side with no warning is a correctness hazard at tax time, and "which lots are long-term yet" is the one question a portfolio page can answer that actually saves money | L |
| 17 | **An integrity checker, soft delete, and a rehearsed restore drill** | New `services/integrity.ts` plus `integrity.test.ts`; the three remaining hard deletes at `import/service.ts:974`, `manual-transactions.ts:273`, `rule-corrections.ts:256`; a `pnpm restore:drill` script and `docs/recovery.md` | Assert what is currently only prose: every split's parts sum to its parent, every transferGroupId has ≥2 legs, every amount is a safe integer, every daily_balances row matches a fresh `deriveDailyRows`, no active row carries `source='user'` with a category the taxonomy lost. Soft-delete plus a "Recently removed" view with restore. The drill copies the newest snapshot to scratch, verifies it, prints its counts and net worth and diffs against live | The schema already treats retired data as history (`superseded` is a status, not a DELETE) and three code paths quietly opt out — the three that destroy the most work per click. His guarded-SQL workflow bypasses every invariant, and SQLite has no CHECK constraints here by deliberate choice | L |
| 18 | **Screen-reader-grade charts and a token-level contrast gate** | A shared `<ChartDataTable className="sr-only">` inside `ScrubChart`'s `<figure>` and inside `CashFlowChart`, `SankeyChart`, `AmountHistoryChart`, `MonthlyTrendBars`, fed by the same `chart-window.windowedPoints` slice `ScrubTable` already renders visibly; plus a test rendering the semantic tone set and the 12-hue ramp in both themes asserting AA and a greyscale-readable verdict | Every chart becomes readable without sight, and the "WCAG-AA verified" claim becomes tested rather than asserted | Charts are the centrepiece and for a screen-reader user they currently reduce to one scrubbed value — or nothing on the four charts with no slider. `MonthlyTrendBars.tsx:23` puts the amount ONLY in an aria-label, so it is simultaneously the only channel for AT and absent for every sighted touch user | M |
| 19 | **Container queries, a wide 2xl composition, and a density mode** | Tailwind v4 `@container` on `SurfaceCard` and grid tracks, converting ~30 `sm:`/`md:` decisions in `InstitutionCard`, `SpendHeatmap`, `PortfolioHoldingsTable`, `CashFlowChart`, `ScrubChart`; lift `AppShell.tsx:32,65` max-w-5xl at 2xl into a left context rail plus wide canvas plus right detail rail for the four analytical routes; a `density` setting persisted beside `dashboardLayout` with a reset in Settings | Components adapt to their slot rather than the viewport, and a 27" monitor stops rendering the tablet layout | 52% of a 2560px viewport is blank on every route, and several route-level compromises exist only because of the cap — the cycling metric column (`holding-cycle.ts:6-7` documents it as a width compromise), hidden deltas, single-column bento. Meanwhile `SpendHeatmap.tsx:166` hides its bars at a viewport threshold that has nothing to do with how wide its cell actually is | L |
| 20 | **A living design system: specimen route, states gallery, and a craft gate** | Promote `/design/stage-0a` (prod-gated, currently only a keyboard e2e fixture) into a real specimen page; add `/design/states` behind the same guard; extend `e2e/visual.spec.ts` and `e2e/a11y.spec.ts` to `/imports` and the six detail routes | Specimen: type scale, spacing rhythm, all button variants × sizes × states, every badge tone, all 12 hues in both themes, elevation planes, motion durations, chart palette, the basis vocabulary. States gallery: every empty, error, skeleton, zero, one-item, negative-category, seven-figure and 4,898%-over variant against fixtures | The system's rules live in prose comments across globals.css and 30 components, which is exactly why the same button recipe was reinvented 16 times and the eyebrow 8 times. And the non-happy states are unreachable in the seeded fixture, so they have never been rendered in a test at any width in either theme | M |
| 21 | **The 3D layer, built as progressive enhancement over the existing pure math** | New renderer only; consumes `multi-series.alignOverDays`, `portfolio-returns.decomposeValue`, `sankey-layout`, `chart-axis.niceLinearTicks`, `chart-window.windowedPoints` — all pure, DB-free and unit-tested. Ships as an appended option on an existing ViewSpec dimension, behind `next/dynamic` with `ssr:false`, with a 2D fallback for reduced-motion and low-memory devices | A WebGL net-worth composition ribbon or symbol×day P/L surface needing no new query and no new math | Measured budget: three.js core plus a thin r3f slice is ~250 KB gz, about +45% on /investments' current 511 KB. But lazy-loading recharts returns 107 KB gz per chart route and de-duplicating it returns ~215 KB gz across a session — the two fixes free MORE than 3D costs. The real blockers are not bundle size: iOS Safari OOM (/transactions holds 32,557 DOM nodes and 9,098 SVG paths before any GL context), main-thread contention (zero Suspense boundaries means hydration starves the first frames), and touch orchestration (`ScrubChart.tsx:545` already sets `touch-none` on a 256px plot). Do items 34 and 22 of the table-stakes list first | L |
| 22 | **Alert history and a period-close digest** | `/budgets`, `/recurring`, dashboard | "Crossed 80% on Jul 14, went over on Jul 21" per budget, and a close recap: "June: 6 of 10 budgets met; Housing over by $176.70; two subscriptions raised their price". Derivable by sweeping `budgetStatuses` across dates, no new writes required beyond an optional cache | A budget's whole value is the moment it starts predicting trouble, and the page shows only the instantaneous present. Two categories crossed into over-budget this month and the app cannot say when, so it can never tell him a story about his own behaviour | L |
| 23 | **Category detail depth: day heatmap, biggest hits, sibling comparison, forecast** | `/categories/[id]` — `largestTransactions` (spending.ts:710) needs a categoryId option the way `topMerchants` (spending.ts:624) already has one; `ui/CalendarGrid` is the same primitive `SpendHeatmap` uses; `predictBudgetableCategories` is already rendered on the /spending row he clicked to get here | A category-scoped heatmap with the pass-23 day sheet, a Biggest hits card, the other children of the same parent when viewing a subcategory, and the next-month forecast line the summary row already shows | Clicking a /spending row into its category currently LOSES the forecast — the detail page is strictly poorer than the summary. And a subcategory page is the emptiest state in the app: no subcategories, no budget, and a parent link that drops the period | M |
| 24 | **Interest and APY, the two flows that compound while he sleeps** | `/accounts` and `/accounts/[id]`: a stored APR/APY plus a stored credit limit, rendering utilisation, statement balance vs current balance, next due date from the detected series, minimum, and projected annual interest earned or paid | Makes the balance sheet forward-looking | Venture X sits at −$11,020.45 and the app cannot say whether that is 20% or 95% of his limit, when it is due, or what it costs him. The app forecasts spending, income, budgets and portfolio returns and models neither of the two flows that move on their own | L |
| 25 | **Motion for arrival and change, not just for hover** | `template.tsx` fade-rise extended to a staggered bento entrance, a highlight flash on rows that just changed after an undo or bulk edit, `NumberRoll` count-up on stat tiles, and a shared-element morph from a table row into its sheet reusing the view-transition machinery `ChartFocus` proved (globals.css:265-289) | Motion that does work rather than decorates | The app has exactly one moment of designed motion outside overlays and it is the most impressive thing in the product. After a bulk edit of 128 rows or an Undo, nothing on screen indicates which rows changed | M |
| 26 | **Bills in the phone's own calendar, and a shareable snapshot** | `.ics` VEVENT per projected occurrence from `upcomingOccurrences` (pure formatting), plus a dashboard PNG or printable summary stamped with the asOf date and coverage state | Adds to the surface his phone already nags him from, and makes the honesty metadata portable | Small, self-contained, disproportionate real-life payoff, and no competitor at this price point does either well. The snapshot is the natural payoff of an editorial-quality dashboard and — because of the asOf stamp — could actually be trustworthy | S |

---

### Notes on the merge

- **Collapsed hardest:** export (8 proposals → 1), freshness and as-of (6 → 1), period selector (5 → 1),
  visible ⌘K trigger (4 → 1), keyboard scopes (7 → 1), notes fields (6 → 1), chart focus/lens parity
  (4 → 1), blast radius and confirmation (5 → 2), backup restore (3 → 1), anomaly rail (4 → 1),
  net-worth composition viz (3 → 1), merchant index and merge (3 → 1).
- **Deliberately kept split:** the mutation log and the operations log share a table shape but answer
  different questions; the coverage MAP and the timeline RIBBON are the same data at different
  ambitions and the map is table stakes while the ribbon is not; the sr-only chart table and the
  contrast gate travel together but neither implies the other.
- **Dropped as already-covered elsewhere in this review set:** every proposal whose body was a bug
  report rather than an addition (stale pending states, missing catches, hidden hover controls,
  clipped overflow) — those belong in the BAD and WHAT-TO-CHANGE documents, not here.


---

<div id="sec-07a"></div>

> **▼ SECTION 07a — Page by page, part 1 of 3**

# 07 — Page-by-page dossier, part 1 of 3

Surfaces owned by this part: `/` (dashboard), `/transactions`, `/spending`, `/accounts`, `/accounts/[id]`.

Verdict vocabulary used in every inventory table: **broken** (does not do what it claims) · **missing-state** (a state that will happen was never designed) · **dead-end** (shows something and gives you nowhere to go) · **confusing** (works, but misleads or costs the user) · **undiscoverable** (exists, nothing tells you) · **sensible** (correct — protect it).

Problem rows are sorted to the top of every table. Every row is kept; the tables are the working checklist for the polish passes.

---

## `/` (dashboard)

**Purpose** — This is the owner's 20-second "am I OK?" screen — the one surface he opens on his phone without a question in mind. It answers four things: what am I worth right now (bridged net worth + assets/liabilities + a 2-year scrubbable curve), what needs my attention (the review queue, the next 14 days of bills), am I overspending this month (pace + free-to-spend), and did my money move (investments teaser, institution cards, recent transactions). It is explicitly designed as a hub that never dead-ends — every teaser carries the exact drill target it opens (`src/services/dashboard.ts:14-21`), so it is a router into the other 14 routes rather than a place to do work. Secondarily it is the app's showpiece: the vivid net-worth ScrubChart, the brush→linked-activity interaction, and the arrangeable bento are the proof that this is a product and not a SQL browser.

**Connections** — READS (one RSC pass, all synchronous better-sqlite3): `dashboardData()` → `bridgedNetWorthSeries` (netWorthSeries + transferFloats), `listAccounts`, `needsReviewCount`, `upcomingOccurrences`×2, `cashFlowByPeriod` + `forecastCurrentMonth` (pace/free-to-spend), `portfolioOverview` + `portfolioSeries` + `topMovers` (investments teaser); plus `readSettings` (view prefs + section order), `institutionGroups`, `recentLedgerRows`×2, all categories for the picker, and either `dashboardChartData` (non-combined modes, re-runs transferFloats) or `spendingSankey`×5 (Flow mode, `page.tsx:103-107`). WRITES: only two, both settings — `saveDashboardLayoutAction` (section order, `settings/actions.ts:38`) and `saveViewPreferenceAction` (chart mode + accts selection, `settings/actions.ts:73`). Every money mutation is delegated to `TransactionSheet` (category, split, transfer/exclude/reviewed flags, notes, merchant rename), opened in place from three places on this page. ON-DEMAND: `loadPeriodActivity` server action (`app/period-activity-action.ts:16`) for a brushed window. LINKS OUT: `/transactions?view=review`, `/transactions?from&to`, `/transactions`, `/spending`, `/investments`, `/investments/{assetType}/{symbol}`, `/recurring/{id}`, `/recurring`, `/accounts`, `/accounts/{id}`, plus Sankey node drills to `/transactions?…`. NEVER LINKS TO: `/budgets`, `/imports`, `/categories/{id}`, `/merchants/{id}` — three of them are one nav click away, but `/budgets` and `/imports` have zero dashboard representation despite both having live "needs you" numbers. STATE: chart mode + account selection live in the URL and `app_settings`; the brushed window lives only in React (`DashboardWindowContext`) and dies on any navigation; the range pill lives only in `ChartFocus` useState and dies on reload.

### Interactive inventory

| element | file:line | intended | verdict |
|---|---|---|---|
| Section drag grip (draggable row, HTML5 dragstart) | `src/components/dashboard/ArrangeableSections.tsx:109` | Drag a section to a new position | **broken** — HTML5 drag-and-drop does not fire on touch, so on the phone the owner says he will use, the grip is inert. The keyboard buttons are the only working path (they exist, which saves it), but the grip gives no hint it is desktop-only. |
| Hero chart mode switcher (Net worth / Assets / Owed / Split / Accounts / Flow) | `src/components/dashboard/DashboardChartSection.tsx:140` | Flip the hero between 6 views; persists in URL + app_settings | **broken** — MEASURED at 390px viewport: the group's scrollWidth is 377px inside a card whose content box is ~295px. It overflows main (main clientWidth 390, scrollWidth 470) and the 'Flow' button's right edge lands at x=418 — 28px outside main. ViewSwitcher is `flex gap-1` with no wrap and no overflow-x (`ui/ViewSwitcher.tsx:24`), so on a phone the Flow/Sankey mode is off-screen and the page scrolls horizontally. |
| Investments value card (Link) | `src/components/dashboard/InvestmentsTeaser.tsx:38` | Portfolio value + today's move + 30-day sparkline | **broken** — The move is labelled ' today' (`InvestmentsTeaser.tsx:55`) but `portfolioOverview.dayChangeCents` is the delta between the two most recent CACHED closes. Measured on the real DB the newest close is 2026-07-19 against today 2026-07-27, so the dashboard states an 8-day-old move as today's. The honesty escape hatch is dead too: `dayChangeExact` is hard-coded true by every producer, so the '≈' at line 46 can never render. |
| Linked-activity base prompt "Drag across the chart to break down any window" | `src/components/dashboard/PeriodActivityPanel.tsx:65` | Teach the brush interaction instead of leaving a gap | **broken** — It renders unconditionally under the hero (`page.tsx:204`) including in Flow/Sankey mode, where the chart is a SankeyChart that never calls `useDashboardWindowProps` and has no brush at all. In Flow mode the app instructs the user to perform an interaction that does not exist. It is also a permanent full-width banner that never dismisses once learned. |
| Net worth headline (NumberRoll) | `src/app/page.tsx:151` | The hero number, odometer-rolls when it changes | **missing-state** — No as-of date anywhere on the page. `netWorth.asOf` is computed (`services/dashboard.ts:131`) and never rendered — measured on the real DB it is 2026-07-19 against today 2026-07-27. The headline presents an 8-day-old number as 'now' with no staleness cue and no path to refresh it. |
| Chart plot — drag-to-zoom brush | `src/components/investments/ScrubChart.tsx:436` | Select a window, push it to the shared history, cross-filter the activity panel | **missing-state** — The window lives only in React state (`DashboardWindowContext`). `app/template.tsx` re-mounts on every navigation, so switching chart mode, toggling an account chip, or reloading silently discards a brushed window and the linked panel snaps back to its empty prompt. Every other view choice on this page is in the URL. |
| Range pills 1M / 3M / YTD / 1Y / ALL | `src/components/charts/ChartRangePills.tsx:41` | Set the visible window; shared between the inline card and the focus dialog | **missing-state** — The range lives in `ChartFocus` useState (`ChartFocus.tsx:67`) — not in the URL and not persisted, unlike the chart MODE which is both. Reload the dashboard in Split mode and you get Split at 1Y, never the 3M you were reading. Also: when a range holds <2 points the chart silently falls back to the whole series while the pill still reads pressed (`lib/chart-window.ts` fellBack is never surfaced here). |
| Sankey "Sankey view" Flow/Table switcher | `src/components/charts/SankeyChart.tsx:268` | Show the flow as a numeric table | **missing-state** — Component-local useState (`SankeyChart.tsx:82`) — not a view dimension, not in the URL, not persisted. It silently resets on every remount, unlike every other lens in the app. |
| "$X due before your next paycheck" | `src/components/dashboard/UpcomingBillsStrip.tsx:20` | The headline the strip was built for | **missing-state** — Gated on `beforePaycheck.cents < 0`. Measured on the real DB beforePaycheck is `{date:'2026-07-30', cents:0}`, so the line renders NOTHING — the user is not even told when the next paycheck lands. Separately `upcoming.netCents` (`services/dashboard.ts:154`) — the net of the whole 14-day window, the actual 'can I afford this' number — is computed and never rendered anywhere. |
| InstitutionCard expand/collapse button | `src/components/accounts/InstitutionCard.tsx:100` | Reveal per-account sub-cards; aria-expanded + inert when closed | **missing-state** — Open/closed is component-local useState with no persistence — it collapses on every navigation back to the dashboard. With 5 institutions the owner re-expands the same card every single visit. |
| Hero chart + linked activity panel (whole block) | `src/app/page.tsx:188` | Render when there is history to draw | **missing-state** — Gated on `netWorth.series.length > 1`. With exactly one day of history BOTH the chart and the activity panel vanish with no message at all — the user gets a bare number and empty space, and the ScrubChart's own 'Not enough history to chart yet' copy (`ScrubChart.tsx:470`) never gets a chance to render. |
| "Assets $X" figure | `src/app/page.tsx:157` | Show the asset side of the identity | **dead-end** — Plain text. There is an 'Assets' chart mode two inches below and an `/accounts` page one click away, and neither is reachable from this number. |
| "Liabilities $X" figure | `src/app/page.tsx:161` | Show the owed side (sign-flipped to a positive red 'amount owed') | **dead-end** — Plain text; the sibling 'Owed' chart mode is not linked from it. The user also has to do 112,032.51 − 1,414.69 in his head to confirm the hero — nothing states the identity, even though the app header tagline does. |
| "partial · N/M covered · only/missing {accounts}" warning | `src/app/page.tsx:175` | Name the accounts missing from today's coverage | **dead-end** — Names the uncovered accounts but is not a link. The user is told his net worth is incomplete and given no way to act — no link to `/imports`, to the account, or to an explanation. |
| Linked-activity top-category chips | `src/components/dashboard/PeriodActivityPanel.tsx:122` | Show the 3 biggest spending categories in the window | **dead-end** — CategoryChip + amount are inert. The same chip is a link everywhere else in the app; here the user cannot click 'Groceries $412' to see the rows. |
| Linked-activity "Income" / "Transactions" stat tiles | `src/components/dashboard/PeriodActivityPanel.tsx:106` | Money-in and row count for the window | **dead-end** — Not links, while the hero 'spent' figure above them is also not a link — three numbers, zero drill-throughs, on a panel whose entire premise is overview→detail. |
| Account unreviewed dot | `src/components/accounts/InstitutionCard.tsx:53` | Signal N transactions awaiting review in that account | **dead-end** — aria-label carries the count but the dot is not separately actionable — clicking it opens the account page, not that account's review queue. |
| Empty state (0 accounts): 3 setup cards | `src/app/page.tsx:124` | Teach the three-step onboarding | **dead-end** — The entire first-run screen contains ZERO interactive elements — no 'Add account' button, no link to `/accounts`, no link to `/imports`. Card 01 literally says 'Add your accounts' and gives the user nothing to click. On a phone the only escape is a horizontally-scrolling nav pill row. |
| "Arrange" / "Done arranging" toggle | `src/components/dashboard/ArrangeableSections.tsx:78` | Enter section-reorder mode (grips + move buttons appear) | **confusing** — It is the FIRST interactive element in `<main>`, rendered above the net-worth headline on every load (screenshot at 1440 confirms). A layout-arrangement affordance visually outranks the money. It also has no 'Reset to default order' anywhere, so a user who scrambles the layout can only fix it by hand-moving sections back. |
| Section wrapper drop target (onDragOver/onDrop) | `src/components/dashboard/ArrangeableSections.tsx:90` | Dropping on a section swaps the dragged one into its index | **confusing** — The drop target is the ENTIRE section wrapper, including the chart plot and every link inside it. In arrange mode the section content stays fully interactive (only a dashed outline marks the mode), so a drag released over the net-worth chart reorders the page instead of brushing a window. |
| Account chips in Accounts mode (aria-pressed toggles) | `src/components/dashboard/DashboardChartSection.tsx:152` | Toggle which account lines are drawn; selection persists via `?accts=` | **confusing** — Each toggle does `router.push` → a full force-dynamic RSC re-render measured at ~1.46s of synchronous SQLite work, with NO pending state (the useTransition pending flag is discarded at `DashboardChartSection.tsx:77`). There is no Select all / None / Only-this, so curating 9 accounts down to 2 is 7 clicks × ~1.5s ≈ 10 seconds of silent UI. |
| Sankey "Flow range" pills (1M/3M/YTD/1Y/ALL) | `src/components/dashboard/DashboardChartSection.tsx:180` | Switch the money-flow window with no round-trip (all 5 precomputed) | **confusing** — A second, hand-rolled pill row with different markup and styling from the shared `ChartRangePills` the rest of the app uses (`components/charts/ChartRangePills.tsx`) — exactly the drift that component was extracted to prevent. |
| Chart plot — press-and-drag scrub (role=slider) | `src/components/investments/ScrubChart.tsx:416` | Inspect a single day; the header swaps to that day's value | **confusing** — The plot is `touch-none` (`ScrubChart.tsx:545`). On a phone a vertical swipe that starts anywhere on the ~256px-tall chart does not scroll the page — the user has to find a non-chart strip to scroll past the hero. |
| Chart legend (Split / Accounts modes) | `src/components/dashboard/DashboardModePanel.tsx:190` | Name each colored line | **confusing** — Legend entries are inert `<span>`s. In Accounts mode the chips above toggle series and the legend below does not — two representations of the same set, one interactive, one not. |
| To-review rows (6) → TransactionSheet | `src/components/dashboard/ToReviewCard.tsx:51` | Open the full editor in place without leaving the dashboard | **confusing** — MEASURED: this list is what breaks the mobile layout — its min-content width is 454px inside a 343px grid track (`page.tsx:217` uses `grid ... lg:grid-cols-[1.5fr_1fr]` with no `minmax(0,1fr)`), pushing the whole activity hub 111px past main. It also shows no account name on a row (`RecentTransactions.tsx:53-78` renders chip/description/badges/date/amount only), so 'DIRECTPAY FULL BALANCE +$155.60' gives no clue which card it hit. |
| Transaction row date | `src/components/transactions/RecentTransactions.tsx:73` | Show when the transaction posted | **confusing** — Renders the raw ISO string `{r.postedOn}` → '2026-07-04'. Every other date on the app is run through formatDayShort/formatDayLong. This is the clearest 'developer data dump' tell on the surface. |
| Spending pace card (whole card is a Link) | `src/components/dashboard/SpendingPaceWidget.tsx:69` | Free-to-spend headline + spent/projected + a pace sparkline, links to `/spending` | **confusing** — MEASURED on the real DB this reads '≈ −$4,538.72' in red. The formula (month income + remaining fixed income − spend to date + remaining fixed bills, `services/dashboard.ts:198`) is nowhere on screen, has no tooltip and no breakdown — the single most alarming number on the dashboard is unexplainable without reading the source. It also counts income that has not arrived yet as spendable. |
| Spending pace sparkline | `src/components/dashboard/SpendingPaceWidget.tsx:90` | Solid actual + dotted projection to month end | **confusing** — aria-hidden with no axis, no labels, no 'ideal' line, and `pace.points[].idealCents` is computed (`services/dashboard.ts:185`) and never drawn — so the one line that would answer 'am I ahead or behind?' is calculated and thrown away. |
| InstitutionCard "as of {date}" meta | `src/components/accounts/InstitutionCard.tsx:111` | Freshness of the group's balance | **confusing** — Raw ISO string interpolated ('as of 2026-07-19'), and it sits directly beside a DayChange labelled 'today' (line 28) that is actually the delta between the last two COVERED days — which can be weeks apart. |
| "To date" input (type=date) | `src/components/investments/ScrubChart.tsx:905` | Type a window end | **undiscoverable** — This is the only keyboard/touch route to the linked activity panel, but the panel's own teaching copy says 'Drag across the chart' (`PeriodActivityPanel.tsx:70`) and never mentions the date inputs. |
| "← Back" / "→" timeframe history chips | `src/components/investments/ScrubChart.tsx:858` | Step through the window history stack | **undiscoverable** — They only appear once a window has been pushed, are unlabelled apart from aria, and the whole stack is wiped by any navigation (see brush finding). |
| Upcoming horizontal scroll rail | `src/components/dashboard/UpcomingBillsStrip.tsx:42` | Scroll through more than fits | **undiscoverable** — `overflow-x-auto` with snap but no edge fade, no arrows and no count — on desktop the 8th+ bill is invisible with no cue that it exists. |
| "Move {label} up" button | `src/components/dashboard/ArrangeableSections.tsx:125` | Move the section one slot up, persist immediately, revert+toast on failure | sensible |
| "Move {label} down" button | `src/components/dashboard/ArrangeableSections.tsx:134` | Move the section one slot down | sensible |
| "includes $X in transit" / "excludes $X posted twice" note | `src/app/page.tsx:166` | Explain why the hero ≠ assets − liabilities while money is in the air | sensible |
| "Focus the {label} chart" button | `src/components/charts/ChartFocus.tsx:119` | Expand the hero into a native `<dialog>` with a view-transition morph | sensible |
| "Close focus view" button | `src/components/charts/ChartFocus.tsx:160` | Close the focus dialog with the morph | sensible |
| Focus dialog backdrop click | `src/components/charts/ChartFocus.tsx:141` | Click-outside closes, but only when the full press+release happened on the backdrop | sensible |
| Escape in focus dialog | `src/components/charts/ChartFocus.tsx:140` | Native close + focus return to the opener | sensible |
| Chart plot — hover tooltip (vivid, non-touch) | `src/components/investments/ScrubChart.tsx:519` | Floating readout on desktop hover without moving the header | sensible |
| Chart plot — keyboard scrub (←/→ 1d, ↑/↓ 7d, Home/End) | `src/components/investments/ScrubChart.tsx:370` | Keyboard-inspect any day, announced via aria-valuetext | sensible |
| "{start} – {end} · Reset" pill (custom window) | `src/components/investments/ScrubChart.tsx:884` | Show the brushed window and return to the range pill | sensible |
| "From date" input (type=date) | `src/components/investments/ScrubChart.tsx:895` | Type a window start; the keyboard equivalent of the brush | sensible |
| Sankey node `<a>` drill | `src/components/charts/SankeyChart.tsx:220` | Click a node → the exact ledger rows behind it; honours cmd/ctrl/middle click | sensible |
| Sankey node/ribbon hover highlight + tooltip | `src/components/charts/SankeyChart.tsx:159` | Dim unrelated flows, float a card with amount + share | sensible |
| Linked-activity "View all N transactions →" | `src/components/dashboard/PeriodActivityPanel.tsx:156` | Open `/transactions?from&to` for exactly the brushed window | sensible |
| Linked-activity "Retry" button | `src/components/dashboard/PeriodActivityPanel.tsx:145` | Re-fetch after a failed window load | sensible |
| "To review" count badge | `src/components/dashboard/ToReviewCard.tsx:30` | How many transactions need attention | sensible |
| "Review all →" link | `src/components/dashboard/ToReviewCard.tsx:36` | Hand off to the clustered review inbox at `/transactions?view=review` | sensible |
| To-review all-clear empty state | `src/components/dashboard/ToReviewCard.tsx:45` | Stay calm and present when the queue is empty | sensible |
| Spending pace "Details →" link | `src/components/dashboard/SpendingPaceWidget.tsx:61` | Hand off to `/spending` | sensible |
| Investments "Portfolio →" link | `src/components/dashboard/InvestmentsTeaser.tsx:30` | Open `/investments` | sensible |
| Investments "Top mover {SYMBOL}" link | `src/components/dashboard/InvestmentsTeaser.tsx:62` | Drill straight to the holding page | sensible |
| Upcoming bill chips → `/recurring/{id}` | `src/components/dashboard/UpcomingBillsStrip.tsx:45` | Next 14 days of projected occurrences, each linking to its series | sensible |
| Upcoming empty state "Review recurring →" | `src/components/dashboard/UpcomingBillsStrip.tsx:34` | Keep the empty state a live handoff | sensible |
| Accounts "Manage →" link | `src/app/page.tsx:241` | Open `/accounts` | sensible |
| Account sub-card → `/accounts/{id}` | `src/components/accounts/InstitutionCard.tsx:43` | Drill into the account detail page | sensible |
| "All →" link (recent transactions) | `src/app/page.tsx:260` | Open the full ledger | sensible |
| Recent transaction rows (5) → TransactionSheet | `src/app/page.tsx:267` | Open the editor in place; e2e asserts no navigation | sensible |
| TransactionSheet: prev/next flip arrows | `src/components/transactions/TransactionSheet.tsx:163` | Move through the teaser list without closing | sensible |
| TransactionSheet: "Accept" suggestion | `src/components/transactions/TransactionSheet.tsx:188` | One-tap categorize from the suggestion | sensible |
| TransactionSheet: merchant inline rename | `src/components/transactions/TransactionSheet.tsx:199` | Rename the merchant where its name shows | sensible |
| TransactionSheet: CategoryPicker | `src/components/transactions/TransactionSheet.tsx:229` | Set the category, offer undo + rule creation | sensible |
| TransactionSheet: Transfer / Exclude / Reviewed checkboxes | `src/components/transactions/TransactionSheet.tsx:239` | Flag toggles with undo | sensible |
| TransactionSheet: "Recategorize all N →" | `src/components/transactions/TransactionSheet.tsx:290` | Fix the whole merchant group's past and future | sensible |
| TransactionSheet: "View merchant →" | `src/components/transactions/TransactionSheet.tsx:297` | Open `/merchants/{id}` | sensible |

### Good

1. **The honesty apparatus around the hero is genuinely best-in-class and should be propagated everywhere** — a partial day is named in words with the actual account names (`page.tsx:175-184` via `coverageLabel`), the % delta is suppressed unless BOTH window endpoints are complete so a partial endpoint can never fabricate a percentage (`NetWorthChartPanel.tsx:92-93`), and the in-transit bridge explains in plain English why the headline does not equal assets − liabilities (`page.tsx:166-174`). Most finance apps would have silently interpolated.
2. **ChartFocus is a small masterpiece of correctness** — the inline card stays mounted so the native `<dialog>` can return focus to the same node, Escape closes natively rather than through a view-transition (the comment at `ChartFocus.tsx:132-139` documents a real Chromium trap that stranded the modal open), the morph is `flushSync`'d inside `startViewTransition`, and backdrop-close requires the full press+release on the backdrop so a drag-to-zoom that overshoots does not dismiss the modal.
3. **View parity is structural, not re-implemented** — `ChartFocus` takes one `renderPanel` and calls it twice, so the focus dialog physically cannot drift from the inline card (`DashboardChartSection.tsx:137-225`). The e2e spec asserts the switcher and the account chips both appear inside the dialog.
4. **The multi-series primary-selection rule** — the x-axis owner must be the series with the EARLIEST first covered day (`DashboardModePanel.tsx:71-83`) — is a subtle correctness fix credited to a prior adversarial review, and the owed frame inverting the accent (debt down = green) in header, stroke, aria AND tooltip is the kind of detail that separates a product from a chart library demo.
5. **The linked-activity panel's staleness discipline** — a latest-request guard (`PeriodActivityPanel.tsx:47-60`), figures shown ONLY when the loaded window matches the active selection (line 80) so money is never displayed under the wrong date label, an explicit error state instead of stale numbers, and a keyed fade so the swap reads as stale-while-revalidate.
6. **The drill-down contract is real and tested** — every teaser's href is built in one service (`services/dashboard.ts`) rather than scattered across JSX, and `e2e/zz-dashboard-drilldowns.spec.ts` walks all seven of them. That is why the hub genuinely does not dead-end at the link level.
7. **Arrange-mode accessibility** — every drag has a keyboard equivalent, boundary buttons use `aria-disabled` rather than `disabled` so focus never drops at the edges (`ArrangeableSections.tsx:123-128`), and the entrance cascade removes its own animation classes after the last section so reordering never re-triggers a `fill-mode:both` opacity-0 frame (lines 28-32) — a bug most codebases ship.

### Bad

1. **[CRITICAL] The dashboard scrolls horizontally on phone and tablet — two independent overflows.** MEASURED in the running app at 390×844: `document.documentElement.scrollWidth` 470 vs `clientWidth` 390 (canScrollX true), main clientWidth 390 / scrollWidth 470. Cause 1 — the activity hub grid at `src/app/page.tsx:217` is `grid gap-4 lg:grid-cols-[1.5fr_1fr]`; below `lg` the single implicit track is `auto` and grid items default to `min-width:auto`, so ToReviewCard's min-content of 454px (measured; the RecentTransactions rows are the driver) forces BOTH children to 454px inside a 343px section. Injecting `grid-template-columns: minmax(0,1fr)` in the live DOM immediately collapsed both children to 343px. Cause 2 — the 6-option hero ViewSwitcher (`src/components/ui/ViewSwitcher.tsx:24`, `flex gap-1`, no wrap, no overflow-x) has scrollWidth 377px inside a card content box of ~295px; its last button ('Flow') sits at x=363→414, i.e. 28px outside main, so the Sankey mode is unreachable on a phone. Still broken at tablet: at 768px main is 537/581 and the hub is 473/549. The owner's stated primary device is his phone, and the project's own web rule says the body must never scroll horizontally. — `src/app/page.tsx:217`, `src/components/ui/ViewSwitcher.tsx:24`, `src/components/dashboard/ToReviewCard.tsx:51`
2. **[HIGH] ~1.5–2.0 seconds of synchronous SQLite work per dashboard render, with no loading state anywhere.** MEASURED against a copy of the real 12.8MB DB: `dashboardData()` = 1440ms, broken down as `bridgedNetWorthSeries` 710ms, `forecastCurrentMonth` 637ms, `portfolioOverview` 100ms, `portfolioSeries` 66ms, `topMovers` 5ms. In assets/split mode `dashboardChartData` adds another 572ms because `transferFloats` (439ms) is recomputed a SECOND time (`services/dashboard.ts:117` → `in-flight.ts:271` and `services/dashboard-series.ts:77`) with no memoization. Total ≈1.46s combined, ≈2.03s split. The route is force-dynamic (`page.tsx:35`), there is no `loading.tsx` anywhere in `src/app`, and every mode switch and every account-chip toggle is a `router.push` that re-runs the whole thing while discarding the pending flag (`DashboardChartSection.tsx:77` and `:90` both drop it). Failure scenario: the owner taps 'Split' on his phone, nothing whatsoever changes on screen for two seconds, he taps again, and now two navigations are queued. On the free-tier host he plans, this is the first thing that times out. — `src/app/page.tsx:35`, `src/services/dashboard.ts:117`, `src/services/dashboard-series.ts:77`
3. **[HIGH] The hero states a stale net worth as if it were current — asOf is computed and thrown away.** `services/dashboard.ts:131` computes `asOf` from the latest series point; `page.tsx` never renders it. Measured on the real DB: asOf = 2026-07-19 while today = 2026-07-27. The screen therefore says 'NET WORTH $84,858.34' with `complete:true` and 9/9 covered, and nothing tells the owner the number is eight days old or that importing a statement would move it. The same lie repeats twice more: `InvestmentsTeaser.tsx:55` labels the two-most-recent-cached-closes delta ' today' (prices are also stale to 2026-07-19), and `InstitutionCard.tsx:28` labels the last-two-covered-days delta ' today' right beside a raw 'as of 2026-07-19'. Failure scenario: he checks the dashboard after a big purchase, sees an unchanged number, and concludes the app is broken — or worse, concludes he has more money than he does. — `src/app/page.tsx:151`, `src/services/dashboard.ts:131`, `src/components/dashboard/InvestmentsTeaser.tsx:55`
4. **[HIGH] Flow mode tells the user to perform an interaction that does not exist.** `page.tsx:204` renders `<PeriodActivityPanel/>` unconditionally beneath the hero chart. In Flow mode `DashboardChartSection.tsx:175-203` renders a SankeyChart, which never touches `useDashboardWindowProps` and has no brush, so the panel's window stays null and `PeriodActivityPanel.tsx:65-73` prints 'Drag across the chart to break down any window — money in, out, and every transaction in it.' Failure scenario: the owner leaves the dashboard in Flow mode (it persists in app_settings), returns, drags across the Sankey, nothing happens, and the app looks broken. The mode is also the one persisted state that makes this permanent rather than transient. — `src/app/page.tsx:204`, `src/components/dashboard/PeriodActivityPanel.tsx:65`
5. **[HIGH] The first-run screen has zero interactive elements and can mislabel the problem.** `page.tsx:111-135`: when `netWorth.totalAccounts === 0` the page returns three static SurfaceCards. There is no button, no link, nothing to click — card 01 says 'Add your accounts' and provides no way to do it. Worse, `totalAccounts` is read off the LAST SERIES POINT (`services/dashboard.ts:135`, `latest?.totalAccounts ?? 0`), not from the accounts table, so a user who has already created five accounts but has no `daily_balances` rows yet is told 'No accounts yet.' Failure scenario: someone adds accounts, sees 'No accounts yet', and reasonably concludes the save failed. — `src/app/page.tsx:111`
6. **[MEDIUM] A brushed window — the page's signature interaction — is destroyed by any navigation.** The window lives in `DashboardWindowContext` React state (`DashboardWindowContext.tsx:46`) and `app/template.tsx` re-mounts on every navigation. Switching chart mode, toggling an account chip, or reloading discards it along with the entire Back/Forward history stack. Failure scenario: the owner brushes Feb–Apr, reads the linked breakdown, clicks 'Assets' to see the same window in asset terms — and lands back at the 1Y default with the panel reset to its teaching prompt. Every other view choice on this surface (mode, account selection) is in the URL; this one is not. — `src/components/dashboard/DashboardWindowContext.tsx:46`, `src/app/template.tsx:8`
7. **[MEDIUM] The single most alarming number on the page cannot be interrogated.** SpendingPaceWidget renders 'Free to spend ≈ −$4,538.72' (measured on the real DB: `freeToSpendCents = −453872`) in red with no breakdown, no tooltip, no title attribute, and a link that only goes to `/spending`. The formula — `cashFlow.earned + remaining fixed income − cashFlow.spent + remaining fixed bills` (`services/dashboard.ts:198-202`) — counts income that has not arrived yet as spendable and is invisible to the user. Failure scenario: the owner sees a big red negative, cannot tell whether it means 'you overspent' or 'your paycheck has not landed yet', and has no way to find out from the UI. — `src/components/dashboard/SpendingPaceWidget.tsx:76`
8. **[MEDIUM] Upcoming computes the two numbers that answer 'can I afford this' and renders neither.** `services/dashboard.ts:154` computes `upcoming.netCents` (the signed net of the next 14 days) — UpcomingBillsStrip never reads it. The 'due before your next paycheck' line is gated on `beforePaycheck.cents < 0` (`UpcomingBillsStrip.tsx:20`); measured on the real DB `beforePaycheck = {date:'2026-07-30', cents:0}`, so the strip renders nothing at all and the owner is not even shown when his next paycheck lands. Failure scenario: seven bill chips are displayed and the user must add them up in his head to answer the only question the widget exists for. — `src/components/dashboard/UpcomingBillsStrip.tsx:20`, `src/services/dashboard.ts:154`
9. **[MEDIUM] Exactly one day of history renders a bare number and empty space.** `page.tsx:188` gates the chart AND the linked activity panel on `netWorth.series.length > 1`. At length 1 both disappear silently — no 'not enough history yet' copy, no prompt to import statements. ScrubChart has that exact message at `ScrubChart.tsx:470` but never gets rendered. Failure scenario: a brand-new user enters one balance, gets a hero number floating above nothing, and has no idea what to do next. — `src/app/page.tsx:188`
10. **[MEDIUM] The pace widget computes the 'ideal' line and never draws it.** `services/dashboard.ts:185` fills `PacePoint.idealCents` (straight-line pace to the projected total) for all 31 points. `SpendingPaceWidget.buildGeometry` (lines 20-49) only builds `solid` (actual) and `projection` (last actual → month-end), and never touches `idealCents`. Failure scenario: the user sees two lines and cannot answer 'am I ahead of or behind pace?' — the exact question a pace widget exists to answer — even though the data is already in the props. — `src/components/dashboard/SpendingPaceWidget.tsx:20`
11. **[MEDIUM] Teaser rows hide the account, so a dashboard transaction is unattributable.** LedgerRow carries `accountName` (`services/ledger-rows.ts:87`) and `RecentTransactions.tsx:53-78` never renders it. All three dashboard transaction lists (to-review, recent, linked-activity) therefore show 'DIRECTPAY FULL BALANCE − THANK YOU  +$155.60' with no card. Failure scenario: the owner sees a $155.60 credit he does not recognise and must open the sheet just to learn which account it hit — one extra click × 190 review rows. — `src/components/transactions/RecentTransactions.tsx:53`
12. **[MEDIUM] Raw ISO dates leak into the UI in two places.** `RecentTransactions.tsx:73` renders `{r.postedOn}` → '2026-07-04'; `InstitutionCard.tsx:111` renders `as of ${group.asOf}` → 'as of 2026-07-19'. The app has `formatDayShort`/`formatDayLong` and uses them everywhere else including inside the same chart card. Failure scenario: none functionally — but it is the single clearest visual signal that this is a developer's data dump rather than a product, on the surface the owner will screenshot. — `src/components/transactions/RecentTransactions.tsx:73`
13. **[MEDIUM] The range pill is not persisted while the chart mode is — inconsistent stickiness.** Chart mode round-trips through URL + app_settings (`page.tsx:82-87`), but the range lives in `ChartFocus` useState (`ChartFocus.tsx:67`) and resets to 1Y on every load. `/investments` even accepts `?range=` as a seed; the dashboard has no such param. Failure scenario: the owner works in 3M all week; every single visit reopens at 1Y and he re-clicks the pill, paying a re-render each time. — `src/components/charts/ChartFocus.tsx:67`
14. **[MEDIUM] No error boundary anywhere in the app, on the route with the most service calls.** `find src/app -name error.tsx` returns nothing. The dashboard calls ~14 services; `readSettings` alone throws on any `app_settings` row that fails Zod (`services/settings.ts:52-56`, no fallback-to-defaults). Failure scenario: one malformed persisted view preference and the owner's home screen is Next.js's unstyled default error page with no recovery action. — `src/app/page.tsx:81`
15. **[LOW] Sankey Flow⇄Table is the only lens in the app that is not a view dimension.** `SankeyChart.tsx:82` holds it in component useState. It is not shareable, not persisted, and resets on remount — which on this page means every navigation. Failure scenario: the owner switches to Table to read the numbers, taps a node to drill, hits Back, and is on the diagram again. — `src/components/charts/SankeyChart.tsx:82`
16. **[LOW] Arrange mode has no reset, and its drop target swallows the chart.** `ArrangeableSections.tsx:90` puts `onDrop` on the whole section wrapper while section content stays fully interactive in arrange mode, so a drag released over the net-worth plot reorders the page. There is also no 'Reset to default order' control anywhere, and the persisted layout is invisible from Settings. — `src/components/dashboard/ArrangeableSections.tsx:90`
17. **[LOW] Chart plot blocks page scrolling on touch.** `ScrubChart.tsx:545` sets `touch-none` on the ~256px-tall plot so the brush can capture the pointer. On a phone a vertical swipe starting on the chart does nothing — the user must find the thin margins beside it to scroll past the hero. — `src/components/investments/ScrubChart.tsx:545`
18. **[LOW] Stale doc comment on the review teaser.** `ToReviewCard.tsx:9` says 'the three newest rows awaiting review'; `page.tsx:43` passes `REVIEW_PREVIEW_LIMIT = 6`. Harmless today, but it is the kind of drift that makes the next reader distrust the surrounding comments — which on this codebase are unusually load-bearing. — `src/components/dashboard/ToReviewCard.tsx:9`

### Change

1. **Fix both mobile overflows** (S) — `page.tsx:217` → `grid gap-4 [grid-template-columns:minmax(0,1fr)] lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]` (verified in the live DOM: this collapses the hub from 454px back to 343px). ViewSwitcher (`ui/ViewSwitcher.tsx:24`) → add `flex-wrap` or `overflow-x-auto overscroll-x-contain [scrollbar-width:none]` so a 6-option dimension degrades instead of escaping its card; the dashboard is the only surface with 6 options, so nothing else changes visually. Add a Playwright assertion to `zz-zz-dashboard-modes`: at 390px, `document.documentElement.scrollWidth === clientWidth` on `/`, and the 'Flow' pill is in-viewport.
2. **Say when — put asOf on the hero and kill the three 'today' lies** (S) — Render `netWorth.asOf` beside the headline as 'as of {formatDayShort(asOf)}', and when asOf < today add a muted '· N days ago · Import →' link to `/imports`. Change InvestmentsTeaser's ' today' to the real close date (`portfolioOverview` already knows it; `PortfolioStats.tsx:27` has a dead ternary that was clearly meant to disclose it) and InstitutionCard's DayChange to the actual covered day. Run both dates through `formatDayShort` while you are there, and fix `RecentTransactions.tsx:73` too.
3. **Make the mode switch and chip toggles feel instant** (M) — DashboardChartSection already gets `isPending` from `useViewState` (line 90) and a transition at line 77 — surface both: dim the panel and show a spinner on the pressed pill. Then cut the actual cost: memoize `transferFloats` for the request (it runs twice, 439ms each), and lazy-load the investments teaser + pace behind `<Suspense>` so the hero paints before `portfolioOverview`/`forecastCurrentMonth` (737ms combined) finish. Add an `app/loading.tsx` that renders the hero skeleton.
4. **Make Flow mode honest** (S) — When `mode === 'sankey'`, either hide the PeriodActivityPanel base prompt or swap its copy to 'Click any node to see the transactions behind it.' Better: give the Sankey a range→window bridge so selecting a range pill also pushes that window into `DashboardWindowContext`, and the linked panel keeps working in Flow mode like it does in every other mode.
5. **Give the empty state something to click** (S) — `page.tsx:124` — make each SETUP_STEP card a Link (01 → `/accounts`, 02 → `/accounts`, 03 → `/imports`) with a primary 'Add your first account' Button above them. Separately, split the condition: use a real account count (`listAccounts`) for 'no accounts yet' and a distinct 'accounts added, no balances yet' state for `totalAccounts === 0` with a series length of 0.
6. **Put the brushed window and the range in the URL** (M) — Add `?win=YYYY-MM-DD..YYYY-MM-DD` and `?range=` params resolved in the RSC and threaded into `DashboardWindowProvider`'s initial state and ChartFocus's `defaultRange`. That makes a brushed window shareable, survivable across mode switches, and Back-navigable — and it is the same pattern the chart mode already uses, so no new concept.
7. **Explain Free to spend** (M) — Add a Popover on the figure listing the four terms actually used at `services/dashboard.ts:198-202` (income so far, expected fixed income, spent so far, fixed bills still due) with each as a link to the rows behind it, plus an explicit 'assumes $X of income still to arrive' line when `remainingFixedIncome > 0`. Draw `pace.points[].idealCents` as a third faint line so the sparkline answers ahead/behind.
8. **Render the two Upcoming numbers that already exist** (S) — Show `upcoming.netCents` as the strip's headline ('Next 14 days: −$267.89 net'), and render the paycheck line whenever `beforePaycheck` is non-null — including `cents === 0`, phrased as 'Nothing due before your next paycheck (Jul 30)'. Add a right-edge fade + a '7 bills' count so the scroll rail advertises itself.
9. **Show the account on every dashboard transaction row** (S) — `RecentTransactions.tsx:53-78` already receives `accountName`; render it as a muted suffix under or beside the description (hidden below `sm` if space is tight). This also shrinks the row's min-content problem's blast radius by making the truncating column carry more of the width.
10. **Make the dashboard's dead numbers live** (S) — Link Assets → `/?chart=assets`, Liabilities → `/?chart=liabilities`, the partial-coverage warning → `/imports`, the linked-activity top-category chips → `/transactions?category=…&from&to`, and the Income/Transactions stat tiles → the same filtered ledger. Every one of those targets already exists; only the anchor is missing.
11. **Persist InstitutionCard expansion and add a reset for Arrange** (S) — Store the open institution set under the same viewPreferences surface key as the chart mode, and add a 'Reset order' button next to 'Done arranging' that writes `DASHBOARD_SECTION_IDS`. Also restrict the arrange drop target to the grip header row so a drag over the plot cannot reorder the page.
12. **Promote the Sankey table lens to a real view dimension** (M) — Replace SankeyChart's local useState with the shared `LENS_DIMENSION` appended to `DASHBOARD_VIEW_SPEC` (`chart-lens.ts` documents that it must be appended, never inserted, because `DashboardChartSection.tsx:141` indexes `SPEC[0]`). Same change gives the net-worth hero a chart⇄table lens — it is currently the only ScrubChart in the app without one.
13. **Replace the hand-rolled Sankey range pills with ChartRangePills** (S) — `DashboardChartSection.tsx:180-195` duplicates the shared component with different markup and styling. Swap it for `<ChartRangePills active={activeRange} onSelect={onRangeChange} press />` and delete nothing else — the aria-label 'Flow range' can be preserved via the className/container so `zz-zz-sankey.spec.ts` keeps passing.
14. **Add an error boundary and a settings fallback** (S) — `src/app/error.tsx` with a 'Something went wrong reading your data' card and a retry, plus a try/catch in `readSettings` that falls back to `DEFAULT_SETTINGS` instead of throwing. One bad persisted view preference should never black out the home screen.

### Add

1. **A freshness + coverage health strip under the hero** (M) — One line that answers 'is this number trustworthy?': balances as of {date}, N days since the last import, M accounts uncovered today (named), K open reconciliation gaps, prices as of {date}. Each segment links to the fix (`/imports`, the account, refresh prices). All of this data is already computed — `asOf`, `coveredAccountNames`/`missingAccounts`, and the imports page's gap state — it just has no home. *Why:* This is the single biggest trust gap on the surface. Right now the dashboard confidently displays an 8-day-old net worth, an 8-day-old 'today' investment move, and never once mentions that a statement is overdue. A pissed-off investor's first question is 'as of when?', and the app refuses to answer it.
2. **A period-delta row on the hero: this month / YTD / 1Y, each drillable** (M) — Beside or under the headline: '+$2,140 this month · +$18,905 YTD · +$24,759 1Y', each a link that sets the chart window to that period AND opens the linked-activity breakdown for it. The chart header already computes exactly this delta for the visible window (`NetWorthChartPanel.tsx:142-195`); it just is not exposed at the hero level where the eye lands first. *Why:* The hero currently states a level and no motion. Monarch, Copilot and Mint all lead with 'net worth, and how it changed'. Today the owner has to open the card, pick a pill, and read a secondary header to learn whether he is up or down this month.
3. **A 'why did it change' waterfall for the selected window** (L) — When a window is brushed, decompose the net-worth delta into: income, spending, market gains/losses, transfers in/out, and unexplained/coverage drift — as a horizontal waterfall that reconciles exactly to the delta the chart header shows. `periodActivity` already returns in/out/topCategories, portfolio already returns `decomposeValue` (contributions vs gains) with an exact identity, and in-flight already isolates transit. Nothing new needs to be derived; it needs to be composed and drawn. *Why:* This is the one thing the app almost has and does not deliver. The chart says '+$24,759 (+28.8%)' and there is no way to ask why. Every serious competitor has some version of this, and for this owner — cash job, dad's money passing through, gambling flows, a 1,991-event brokerage timeline — attribution is the whole point.
4. **Budgets on the dashboard** (M) — A compact card in the activity hub: the 3 budgets closest to breaching, each with a progress bar, projected end-of-month (`budgets.projectSpend` already exists), and a link to `/budgets`. Plus a single 'N of 9 budgets on track' line. *Why:* The owner created 9 real budgets in pass 16 and the dashboard has literally zero budget presence — no number, no link, not even in the nav-adjacent teasers. It is a whole feature he has to remember exists.
5. **A cash + runway tile** (M) — 'Liquid: $X across checking/savings · N days at your current burn' with a small depletion sparkline, sitting beside Free to spend. It composes `latestBalances` (already loaded for assets/liabilities) with cashFlow's spend rate (already computed for pace). *Why:* Net worth includes an $88k portfolio; it does not tell him whether rent clears next week. 'Can I pay my bills' is the most common real question a personal-finance dashboard gets asked and this one cannot answer it.
6. **An anomaly / attention rail** (L) — A horizontal strip of 3-5 generated cards: 'largest transaction this month', 'first time you paid {merchant}', 'this subscription went up $4.99', 'spending in Dining is 62% above your 3-month average', 'an account has not been updated in 21 days'. Each links to the exact filtered rows. `spending.largestTransactions`, `category-forecast`'s trend model, and recurring's amount history already produce all the inputs. *Why:* The dashboard currently reports; it never notices. This is Copilot's and Monarch's entire differentiator, and for an owner with 1,300 hand-categorized rows the app knows more than enough to volunteer something.
7. **Compare-periods overlay on the hero chart** (M) — A 'vs last year' / 'vs last month' toggle that draws a ghosted re-indexed prior-period curve behind the current one, exactly the way `/spending` already ghosts the prior period via `projection.reindexByPosition`. Also add the same overlay to the pace sparkline. *Why:* 'Am I doing better than last year?' is unanswerable today without brushing two windows and remembering the first number. The re-indexing machinery already exists on a sibling surface.
8. **Select all / none / only-this on the account chips** (S) — Three small controls in the 'Accounts shown' group, plus shift-click for 'only this'. Combined with the pending-state fix, this turns a 7-click, 10-second curation into one click. *Why:* With 9 accounts the current chip row is unusable in practice — each toggle is a ~1.5s full-page round trip with no feedback.
9. **A net-worth composition view — the ambitious one** (L) — An 'Assets by layer' abstract visualization: a stacked/streamgraph or radial composition over time showing cash vs brokerage vs crypto vs debt as bands, scrubbable on the same day axis, with the same coverage-honesty rules (partial days soft, gaps not invented). It slots in as a 7th option on the existing `DASHBOARD_VIEW_SPEC` dimension and reuses `accountSeries` + multi-series's `alignOverDays`, so it costs no new math — and it is the '3D / think abstract' surface the owner asked for that would still be honest. *Why:* The owner explicitly wants ambitious data visualization. This is the one that is both spectacular and truthful: it shows the SHAPE of the balance sheet changing over two years, which none of the five current modes do.
10. **Upcoming as a 14-day calendar strip with the paycheck marked** (M) — Replace/augment the chip rail with a day-column strip: each day a small bar of what is due, the paycheck day flagged, and a running 'lowest projected balance' line so the strip shows whether he dips below zero before payday. `upcomingOccurrences` + the forecast engine already produce every input. *Why:* The current rail is seven equal-weight chips in date order. It shows what is due but not whether he can cover it — and the 'before your next paycheck' line, the one feature that addressed this, silently renders nothing when the sum is zero.
11. **An import/data-health card** (M) — 'Last import: 8 days ago · 2 open gaps · 3 accounts stale' with a drop-target that accepts a dragged statement file straight from the dashboard and posts to `uploadStatementsAction`. *Why:* Statements are the sole source of truth in this app and the home screen has no relationship with them at all. Drag-a-PDF-onto-the-dashboard is the single highest-leverage interaction this product could add.
12. **A compact/dense mode and a saved layout manager** (M) — A density toggle (comfortable/compact) persisted alongside `dashboardLayout`, plus a Settings panel that lists the saved dashboard layout and view preferences with a Reset for each. *Why:* On a 1440 monitor main is capped at 1024 with 200px of measured dead space; on a phone the same stack is four screens tall. One layout is currently being asked to serve both, and the persisted preferences are invisible and unresettable from anywhere in the UI.
13. **Share / export a dashboard snapshot** (S) — A button that renders the hero + key tiles to a PNG or a printable summary for a given date, stamped with the asOf date and coverage state. *Why:* Lowest priority of this list, but it is the natural payoff of an editorial-quality dashboard, and the honesty metadata means the snapshot could actually be trustworthy — which is more than most finance-app exports manage.

---

## `/transactions` — the triage ledger

(`src/app/transactions/page.tsx` + `src/components/transactions/**` — 16 components, 2 action files, 7 e2e specs)

**Purpose** — This is the owner's workbench — the one screen where imported bank rows stop being raw parser output and become classified money. Everything downstream (net worth honesty, `/spending`, `/budgets`, forecasts) is only as true as the categorization done here, so this page is where the owner spends his actual working passes: drain the review backlog, correct a category and teach the engine a rule, split a Costco run, pair a transfer the detector missed, and audit "did the import actually land". It is also the app's only full-ledger search: every other surface (dashboard stat cards, spending heatmap days, category pages, merchant pages, account pages) deep-links HERE with `?category=` / `?merchant=` / `?from=` / `?to=` / `?flow=` to answer "which rows are behind that number?". It is the app's evidence locker and its teaching loop at the same time.

**Connections** — READS: `transactions ⋈ accounts` (`page.tsx:123-136`) through the shared predicate `filterConditions`/`viewCondition`/`countMatching` (`src/services/transactions-query.ts:34-170`) — the same predicate bulk-by-filter mutates, so the tab count IS the blast radius; `toLedgerRow` (`src/services/ledger-rows.ts:42`) shared with the dashboard teaser and account detail; `splitCountsByTxn`; `coverageStats` (`src/services/categorize.ts:739` — materializes every active row into JS); `pendingMerchantQueue` + `claudeRunState` + `aiSpend`; `reviewInbox` (`src/services/review-inbox.ts:163`). WRITES: `bulkApply`/`bulkApplyByFilter`/`setTransactionFlags`/`markAllReviewedBefore` (`src/services/bulk-edit.ts`), always stamping `categorizationSource='user'` (`bulk-edit.ts:156`) — the hand-edit shield the whole pipeline honors; `ruleFromCorrection` + `retroApplyRule` (rule corrections, surfaced on `/settings`); `setSplits`/`clearSplits`; `linkTransferPair`/`unlinkTransferGroup`; `renameMerchant`; `editManualTransaction`; `attachToSeries`/`createSeriesFromTxn` (`src/app/recurring/actions.ts`). Every mutation revalidates `/transactions` and `/` (`actions.ts:172-175`) — splits also revalidate `/spending` and `/budgets` (`actions.ts:582-587`). INBOUND: nav badge (`needsReviewCount`), `ledgerHref` (`src/lib/ledger-href.ts:25`) from spending/analytics/sankey/heatmap, `/merchants/[id]:64`, `/accounts/[id]:202`, `/categories/[id]`, dashboard `ToReviewCard` (`/transactions?view=review`), command palette (`command-index.ts:66`). OUTBOUND: `/merchants/{id}` (`TransactionSheet.tsx:297`), `/settings` for rules (`TransactionSheet.tsx:344`). It does NOT own balances — `daily_balances` is rebuilt by `editManualTransactionAction` only (`actions.ts:569`).

### Interactive inventory

| element | file:line | intended | verdict |
|---|---|---|---|
| FiltersBar — Category `<select>` | `src/components/transactions/FiltersBar.tsx:45-52` | Scope to a category subtree | **broken** — Options are ROOT categories only (`page.tsx:151-154`). A URL carrying `category=<child id>`, `category=uncategorized`, `category=spending` or `category=income` — all produced by `ledgerHref` (`src/lib/ledger-href.ts:28-29`) and spending-stat-cards — matches no `<option>`, so the select silently renders "All categories" while the ledger is filtered. Pressing Filter then drops the filter. |
| FiltersBar — "Filter" submit button | `src/components/transactions/FiltersBar.tsx:82-87` | Write the form's fields into the URL | **broken** — A GET form replaces the whole query string with only its own fields. `merchant`, `flow`, `amountMin`, `amountMax` are parsed (`query.ts:68-70`) and honored (`transactions-query.ts:53-134`) but have no input in this form, so pressing Filter silently DELETES them. |
| FiltersBar — "Reset" link | `src/components/transactions/FiltersBar.tsx:88-102` | Clear all filters | **broken** — `hasActiveFilters` (`FiltersBar.tsx:27-29`) ignores merchant/flow/amountMin/amountMax, and the reset href (`:90-97`) does not null them. Landing on `/transactions?merchant=<id>` shows no Reset link at all and no way to clear it. |
| "Run categorization" button | `src/components/transactions/HeaderStrip.tsx:58-66` | Run the free deterministic engine | **broken** — `categorizeAll` and `detectTransfers` both return stats which the action discards (`actions.ts:128-129`) and it redirects with no notice — the user gets zero feedback about what changed. Worse, `detectTransfers` pass 2 unconditionally re-sets `needsReview=true` on every contended outflow (`categorize.ts:631-644`) with no memory of user dismissal, so one click can re-inflate a queue the owner just drained. No confirm, no undo, no pending state. |
| "Classify N merchants with Claude" button | `src/components/transactions/HeaderStrip.tsx:80-89` | Send the pending merchant queue to Haiku | **broken** — `classifyMerchantsAction` awaits the ENTIRE queue synchronously inside a form navigation (`actions.ts:150`) and `classifyPendingMerchants` has try/finally but no catch — an expired key or a network error throws out of the server action into the Next error boundary instead of a toast. No pending state on the button; the page cannot re-render, so the "Stop Claude run" button (`:69-77`) is unreachable for the whole run. |
| Day group header + day net | `src/components/transactions/TransactionsLedger.tsx:238-241` | Group rows by day and state that day's net | **broken** — `groupByDay` (`TransactionsLedger.tsx:65-82`) runs over the 50-row PAGE slice (`page.tsx:134`). A day straddling a page boundary shows a partial net on page 1 and another partial net on page 2, both labeled as the day's net, with nothing saying so. |
| Picker's "Claude" suggestion pills | `src/components/transactions/CategoryPicker.tsx:69-74,153,172-174` | Float low-confidence Claude guesses to the top of the picker | **broken** — Dead. `suggestedCategoryIds` is hardcoded `[]` in the one factory that builds every LedgerRow (`src/services/ledger-rows.ts:67`) and no other producer exists — the branch can never fire on this page or in the sheet (`TransactionSheet.tsx:229`). |
| "Needs review" dot | `src/components/transactions/TransactionsLedger.tsx:299-301` | Mark a row that needs attention | **broken** — `aria-label` on a bare `<span>` with no role is prohibited/ignored — screen readers get nothing. It also never says WHY (low confidence vs big uncategorized credit vs ambiguous transfer vs suspected duplicate). |
| BulkActionBar — "Transfer" | `src/components/transactions/BulkActionBar.tsx:93-95` | Mark the selection as transfers | **broken** — Sets ONLY `transferGroupId = row.id` (`bulk-edit.ts:172`). Analytics excludes transfers purely by category KIND (`spendingBucket`, `src/services/analytics.ts:201-208`) and never reads `transferGroupId` — so the rows keep counting as spending. `clearTransfer` exists in the schema (`bulk-edit.ts:33`) but has no button either. |
| TransactionSheet — open/close | `src/components/transactions/TransactionsLedger.tsx:343-352` | Detail drawer for one row | **broken** — `openId` is pure client state — the open transaction is NOT in the URL. Refreshing closes it, it cannot be shared or bookmarked, and browser Back navigates away instead of closing it. This directly contradicts the file that governs this page: "URL is the state: every filter, tab, and page lives in searchParams" (`query.ts:3-7`). |
| Sheet — Previous / Next transaction chevrons | `src/components/transactions/TransactionSheet.tsx:163,166` | Flip through the ledger without closing | **broken** — Dead-ends silently at the 50-row page boundary (`flip`, `TransactionsLedger.tsx:146-150`) with no "next page" continuation and no disabled state on the button. |
| Sheet — ↑/↓ keyboard flip | `src/components/transactions/TransactionSheet.tsx:42` (doc) / `TransactionsLedger.tsx:88-90` (doc) | Documented as "↑/↓ flips through rows with the sheet open" | **broken** — Does not exist. There is no ArrowUp/ArrowDown binding anywhere in `src/components/transactions` except inside CategoryPicker (`:89-94`), and the ledger's key scope is disabled while the sheet is open (`TransactionsLedger.tsx:221` `openId === null`). Two doc comments describe a feature that was never built; `zz-categorize.spec.ts` only clicks the buttons, so e2e never caught it. |
| Sheet — "Transfer" checkbox | `src/components/transactions/TransactionSheet.tsx:239-245` | Mark this row a transfer | **broken** — Same defect as the bulk button: `setTransactionFlags` sets only `transferGroupId` (`bulk-edit.ts:290-291`) and no transfer-kind category, unlike `linkTransferPair` (`transfer-links.ts:115-121`). The T badge appears, the row keeps counting as spending. |
| ReviewInbox — "Mark all reviewed" | `src/components/transactions/ReviewInbox.tsx:147-149` | Clear the entire queue | **broken** — Ghost-styled (lowest visual weight) directly beside the amnesty button, no count in the label, no confirmation — one misclick clears the whole backlog. It also hardcodes `{view:"review"}` (`:91`), ignoring any filters in the URL, so its radius differs from the tab count above it. |
| ReviewInbox — cluster list | `src/components/transactions/ReviewInbox.tsx:153-163` | Render every cluster | **broken** — Unbounded `data.clusters.map` — the owner's real backlog was 404 rows / hundreds of clusters. Hundreds of cards, no pagination, no search, no filter, no collapse, on a phone. |
| Active-filter chips / summary | `src/components/transactions/FiltersBar.tsx:26-105` | Show what is currently filtering the list | **missing-state** — Does not exist. A `?flow=out&merchant=X` deep link renders a form that looks completely empty while showing a filtered ledger. |
| Day group header as a link | `src/components/transactions/TransactionsLedger.tsx:238-239` | — | **missing-state** — Not a link. Siblings make days clickable (`dayLedgerHref`, `src/services/spending.ts:510`) but the ledger's own day headers are inert. |
| BulkActionBar — "N selected" | `src/components/transactions/BulkActionBar.tsx:64-66` | State the blast radius | **missing-state** — Count only — no sum of the selected amounts. Selecting 40 rows to exclude gives no idea how much money is being removed from analytics. |
| Sheet — Category picker | `src/components/transactions/TransactionSheet.tsx:229` | Correct this row's category | **missing-state** — Nothing on the sheet says HOW the current category was assigned. `categorizationSource` is never selected (`page.tsx:95-111`), never mapped (`ledger-rows.ts:42-68`), never rendered. The "Matching rules" panel explicitly disclaims being the cause (`TransactionSheet.tsx:333-337`). The app cannot answer "why is this Groceries?". |
| Sheet — "Raw detail" `<details>` | `src/components/transactions/TransactionSheet.tsx:362-374` | Audit escape hatch | **missing-state** — Shows only raw description + T/R badges. No dedupe hash, no import file, no statement period, no occurrence index, no categorization source/confidence, no created/updated timestamps — the audit panel of an audit app. |
| Filtered-set totals / stats strip | `src/components/transactions/Pagination.tsx:22-26` | — | **missing-state** — The only aggregate shown for a filtered set is the row COUNT. Filtering to a merchant or a month gives no sum, no average, no in/out split — the owner must add it up himself or leave for `/spending`. |
| Sort control | `src/app/transactions/page.tsx:114-121` | — | **missing-state** — Order is hardcoded date desc with content tiebreaks. No column headers, no sort by amount/merchant/account — "what were my biggest charges last month" is unanswerable here. |
| Export | `src/app/transactions/page.tsx` (whole file) | — | **missing-state** — No CSV/JSON export anywhere in the app (repo-wide grep finds only import-side CSV parsing). A ledger app that can only ingest. |
| Delete a manual transaction | `src/services/manual-transactions.ts:267` | — | **missing-state** — `deleteManualTransaction` is exposed only via `/accounts` (`cash-actions.ts:38`). A mistyped manual row created from `/accounts` can be edited here but never removed here. |
| HeaderStrip Stat — "Coverage %" | `src/components/transactions/HeaderStrip.tsx:44` | State categorization coverage | **dead-end** — Plain `<dd>`, not a link. The obvious next question — "show me the uncategorized rows" — is one URL away (`?category=uncategorized`) and unreachable by click. |
| HeaderStrip Stat — "Needs review" | `src/components/transactions/HeaderStrip.tsx:45-49` | Size the review backlog | **dead-end** — Not a link to `?view=review`, even though the tab two rows below is exactly that. |
| HeaderStrip Stat — "Queued for Claude" | `src/components/transactions/HeaderStrip.tsx:50` | Size the AI classification queue | **dead-end** — Not clickable and there is no screen anywhere that lists WHICH merchant strings are queued — the owner authorizes spend against a number he cannot inspect. |
| HeaderStrip Stat — "AI spend (month)" | `src/components/transactions/HeaderStrip.tsx:51-55` | Show MTD estimated AI cost vs cap | **dead-end** — Not a link; the over-cap message says "raise it in Settings" (`:96`) with no link to Settings. |
| NoticeBanner "direction-guard" copy path | `src/components/transactions/NoticeBanner.tsx:5-9` | Explain refund protection when a sign-opposing correction leaves the merchant mapping alone | **dead-end** — Unreachable. Its only producer is `correctCategoryAction` (`actions.ts:94-118`), which has zero callers in the app — the live correction path is `correctCategory` (`actions.ts:237`) → `bulkApply`, which never calls `applyCorrection` and never trips the guard. |
| Expander — Notes inline edit | `src/components/transactions/LedgerRowExpander.tsx:134-150` | Annotate any row | **dead-end** — Notes are write-only from the user's perspective: no indicator on the collapsed row that a note exists, and `q` does not search notes (`transactions-query.ts:117-120`). |
| Pagination — Previous / Next | `src/components/transactions/Pagination.tsx:28-45` | Page through 50-row slices | **dead-end** — No first/last, no page-number jump, no rows-per-page. `?page=99` on a 3-page result renders "Page 99 of 3", an empty state, a disabled Next, and a Previous that must be clicked 96 times to reach data (`page.tsx:135` offsets blindly). |
| Filtered empty state | `src/app/transactions/page.tsx:216-220` + `src/components/ui/EmptyState.tsx` | Explain why nothing showed | **dead-end** — EmptyState has no action slot. With `?merchant=X` and no matches, the FiltersBar above renders no Reset link either (`FiltersBar.tsx:27-29`) — the only escape is editing the URL. |
| Zero-import empty state | `src/app/transactions/page.tsx:198-202` | First-run guidance | **dead-end** — Three sentences about the trust layer and no link to `/imports`, which is the only thing the user can actually do. |
| ReviewInbox — cluster sample rows | `src/components/transactions/ReviewInbox.tsx:215-226` | Show representative rows and "+N more" | **dead-end** — Sample rows are not links and "+N more" (`:223-225`) is inert text — there is no way to see the rest of a cluster or open one of its transactions. |
| View tabs: All / Review / Quarantined / Excluded, each with a count | `src/components/transactions/ViewTabs.tsx:23-36` | Switch `view` in the URL, preserving current filters, resetting page to 1 | **confusing** — In the Review view the tab count is FILTERED (`page.tsx:88` `countMatching(db, filters, "review")`) but the content below is UNFILTERED (`page.tsx:158` `reviewInbox(db)` takes no filters). Arriving at Review from a filtered All view shows "Review 12" in the tab and "404 to review" in the inbox header. |
| FiltersBar — Search descriptions input | `src/components/transactions/FiltersBar.tsx:73-79` | Substring match on the description | **confusing** — Searches only `rawDescription` + `normalizedDescription` (`transactions-query.ts:117-120`). Notes (editable on every row, `LedgerRowExpander.tsx:134`) and merchant canonical names are NOT searchable, so a note the owner writes can never be found again. |
| Row body button (open sheet / toggle selection) | `src/components/transactions/TransactionsLedger.tsx:287-303` | Open the detail sheet, or toggle selection in selection mode | **confusing** — Shows description, T/R badges (`hidden sm:flex`, `:294`), account name (`hidden md:inline`, `:298`), review dot, amount. On a phone the account name AND both badges are gone, so the owner cannot tell which account a row came from without opening the sheet. |
| Expander — Merchant inline rename | `src/components/transactions/LedgerRowExpander.tsx:109-122` | Rename the merchant from the row | **confusing** — Fires `loadSheetPanel(row.id)` (`:30`) — the FULL sheet panel (merchant summary + similar txns + suggestion + history + matching rules, `sheet-actions.ts:53-98`) — just to read a name. Expanding 10 rows runs 10 of the page's most expensive read. |
| BulkActionBar — "Select all N" | `src/components/transactions/BulkActionBar.tsx:68-76` | Escalate to the whole server-side filtered set | **confusing** — On the unfiltered All tab, N is the entire active ledger (`page.tsx:87`). One click then arms a mutation over ~20k rows whose undo patch is returned to the browser row-by-row (`bulk-edit.ts:183`). |
| BulkActionBar — "Exclude" | `src/components/transactions/BulkActionBar.tsx:90-92` | Set `status='excluded'` | **confusing** — There is no "Restore" counterpart, although `restore` exists in the patch schema (`bulk-edit.ts:31`). In the Excluded tab, "Exclude" is a no-op that still reports "Excluded · N", and un-excluding requires opening every row's sheet one at a time. |
| BulkActionBar — "Cancel selection" | `src/components/transactions/BulkActionBar.tsx:100` | Leave selection mode | **confusing** — Also the only way to clear picks — there is no "clear picks but stay in selection mode". |
| Sheet — "low confidence" badge | `src/components/transactions/TransactionSheet.tsx:230` | Flag a shaky categorization | **confusing** — Shows the boolean but never the number, never the source, and has no counterpart in the ledger row — a low-confidence row is visually identical to a hand-verified one in the list, and there is no filter for it. |
| Sheet — "Exclude from analytics" checkbox | `src/components/transactions/TransactionSheet.tsx:246` | Hide from analytics, keep in balance replay | **confusing** — No inline explanation that an excluded row STILL moves money in the balance chain (derivation replays `status IN ('active','excluded')`). The excluded-tab empty state says "out of every analytic" (`page.tsx:64`) which reads as "deleted". |
| Sheet — Notes input | `src/components/transactions/TransactionSheet.tsx:250-252` | Free-text note, saved on blur | **confusing** — Saves on blur only (`saveNotes`, `:143-148`) with no toast and no undo, unlike every other mutation on the page. Closing the sheet by Escape or backdrop before blurring can lose the edit. |
| Sheet — "Recategorize all N →" | `src/components/transactions/TransactionSheet.tsx:290-294` | Fix a whole merchant/name group's past AND create the forward rule | **confusing** — N can be four figures and a single picker click commits it with no confirmation step — `recategorizeGroupAction` (`actions.ts:287-307`) runs `bulkApply` over the whole group and creates a rule. The only safety is a toast. |
| Sheet — "View merchant →" | `src/components/transactions/TransactionSheet.tsx:296-300` | Open the merchant page | **confusing** — `router.push` leaves the page and loses the open sheet, the scroll position, and the selection; coming back re-renders the ledger at the top with nothing open. |
| Sheet — matching-rules "Manage →" | `src/components/transactions/TransactionSheet.tsx:344-346` | Jump to the rules manager | **confusing** — Links to `/settings` with no anchor — lands at the top of Settings, above thresholds and backups, and the user must scroll to find Rules (`settings/page.tsx:75-81`). |
| CategorizeMode — "Start · N" launcher | `src/components/transactions/CategorizeMode.tsx:70-72` | Guided one-by-one walk over the flagged backlog | **confusing** — Silently capped at 200 rows (`page.tsx:163`) with no mention on the button — with a 404-row backlog the walk covers half of it and just ends. |
| ReviewInbox — cluster "Confirm all N" | `src/components/transactions/ReviewInbox.tsx:231-233` | Accept the cluster's existing categorizations | **confusing** — Confirms without ever saying why the rows were flagged — suspected duplicates flagged by the importer (`flagFuzzyDuplicates`, `src/services/import/service.ts:891-894`) are cleared by the same button and the same copy as a low-confidence guess. |
| ReviewInbox — cluster "Mark reviewed" (uncategorized clusters) | `src/components/transactions/ReviewInbox.tsx:255-257` | Dismiss without categorizing | **confusing** — Leaves the rows permanently uncategorized and permanently out of the review queue — they now count as Uncategorized spending forever with no surface that lists them. |
| "Apply to N" rule-prompt toast action | `src/components/transactions/correct-category.ts:32-45` | Turn one correction into a rule + retro-apply, undoable including the rule | **confusing** — When the prompt fires, the plain Undo is discarded (`:32-45`) — mis-tagging one row at a busy merchant leaves no one-click revert, only "Apply to N". |
| "Stop Claude run" button | `src/components/transactions/HeaderStrip.tsx:69-77` | Request a stop between batches | **undiscoverable** — Only rendered when `runState.isRunning` (`:68`), which the page cannot learn until the blocking action resolves — by which time the run is over. |
| `X` keyboard accelerator → selection mode | `src/components/transactions/TransactionsLedger.tsx:218-223` | Fast path into bulk edit | **undiscoverable** — No kbd hint on the Select button, no help overlay, no mention anywhere in the UI. Repo-wide grep for a shortcut legend in `src/components/transactions` returns nothing. |
| ReviewInbox — `R` accelerator (confirm focused cluster) | `src/components/transactions/ReviewInbox.tsx:108-120` | Fast triage | **undiscoverable** — Resolved from live `document.activeElement` (good design) but nothing in the UI mentions it; a bare `r` with focus outside a card is a silent no-op. |
| Add transaction | `src/app/transactions/actions.ts:516-528` | — | **undiscoverable** — `addManualTransactionAction` exists and works, but its only caller is CashWallets on `/accounts` (`src/components/accounts/CashWallets.tsx:207`). You cannot add a transaction from the transactions page. |
| FiltersBar — Account `<select>` | `src/components/transactions/FiltersBar.tsx:35-42` | Scope the ledger to one account | sensible |
| FiltersBar — From / To date inputs | `src/components/transactions/FiltersBar.tsx:56,64` | Bound the ledger by posted date | sensible — no presets (this month / last 30 / YTD); every date range must be typed twice. |
| NoticeBanner "Dismiss" link | `src/components/transactions/NoticeBanner.tsx:38-43` | Clear `?notice=` and keep the filters | sensible |
| "Select" button (enter selection mode) | `src/components/transactions/TransactionsLedger.tsx:229-231` | Reveal checkboxes and the bulk bar | sensible |
| Per-row checkbox | `src/components/transactions/TransactionsLedger.tsx:252-261` | Add/remove a row from the selection | sensible — always visible on coarse pointers (REVEAL, `:61-63`) so a mobile tap silently enters selection mode; acceptable but unannounced. |
| Inline category chip picker (row) | `src/components/transactions/TransactionsLedger.tsx:279-284` | Recategorize without opening the sheet, then offer "Apply to N" | sensible — best interaction on the page; protect it. |
| "Split · N" chip (split rows) | `src/components/transactions/TransactionsLedger.tsx:269-275` | Signal a split row and open the sheet to edit parts | sensible |
| Row expander chevron | `src/components/transactions/TransactionsLedger.tsx:306-317` | Edit date/amount/description/notes in place | sensible |
| Expander — Date / Amount fields | `src/components/transactions/LedgerRowExpander.tsx:47-64,70-86` | Editable on manual rows, read-only on imported rows | sensible |
| BulkActionBar — Category picker | `src/components/transactions/BulkActionBar.tsx:82-86` | Set one category on the selection | sensible — silently skips split rows (`bulk-edit.ts:150`); honest, since `affected` reflects it, but the toast never says "3 split rows skipped". |
| BulkActionBar — "Reviewed" | `src/components/transactions/BulkActionBar.tsx:87-89` | Clear needsReview on the selection | sensible |
| `Escape` in selection mode | `src/components/transactions/TransactionsLedger.tsx:220` | Exit selection | sensible |
| Sheet — suggestion "Accept" button | `src/components/transactions/TransactionSheet.tsx:181-192` | One-tap accept of a computed suggestion with a why-line | sensible — best trust affordance in the app; propagate the "reason" pattern elsewhere. |
| Sheet — merchant inline rename | `src/components/transactions/TransactionSheet.tsx:199-216` | Rename the merchant, old name becomes an alias | sensible |
| Sheet — SplitEditor entry ("Split transaction") | `src/components/transactions/SplitEditor.tsx:257-259` | Open the split draft seeded with the whole amount | sensible |
| SplitEditor — per-line category picker / amount input / Remove part / Add part | `src/components/transactions/SplitEditor.tsx:283-287,291-298,300-310,316-318` | Carve the parent across categories with a live remainder readout | sensible — excellent: "$X left" / "$X over" (`:266-273`) and a save gate reusing the pure invariant. Protect. |
| SplitEditor — Save split / Cancel / Edit split / Remove split | `src/components/transactions/SplitEditor.tsx:323,326,248,251` | Persist, abandon, re-edit, un-split — each undoable | sensible — no percentage entry and no "split evenly across N" helper; every split is manual cents arithmetic. |
| Sheet — "Reviewed" checkbox | `src/components/transactions/TransactionSheet.tsx:247` | Clear/set needsReview | sensible |
| Sheet — TransferLinkPanel "Link as transfer…" + candidate rows | `src/components/transactions/LinkPanels.tsx:133-142,158-168` | Human override for a pair the detector missed; candidates load on disclosure | sensible — zero-candidate copy is precise ("No opposite-signed rows in other accounts within two weeks", `:151-153`). Protect. |
| Sheet — "Show counterpart" / "Unlink transfer" | `src/components/transactions/LinkPanels.tsx:123,112-120` | Inspect and dissolve an existing pair | sensible |
| Sheet — "Make recurring" | `src/components/transactions/LinkPanels.tsx:314-316` | Promote this row into a confirmed series, mode-aware undo | sensible |
| Sheet — "Attach to recurring series…" + candidates / "Detach" | `src/components/transactions/LinkPanels.tsx:318-327,343-352,302` | Link a row to an existing series | sensible — candidate list is capped at 12 with no search (`sheet-actions.ts:200,238`); with many series the right one may be unreachable. |
| Sheet — Close button / backdrop click / Escape | `src/components/ui/Sheet.tsx:111,96-104,85-90` | Dismiss with native focus return | sensible — pointerdown-then-click backdrop guard (`:45,97,103`) is genuinely well built. |
| CategoryPicker — trigger, search combobox, listbox, ↑/↓/Enter/Esc | `src/components/transactions/CategoryPicker.tsx:103-117,128-146,148-179,88-99,57-60` | Searchable category tree, Esc scoped above the sheet | sensible — search matches `label` only (`:66`), so it cannot find a category by its icon/hue or a parent term the child label omits; there is also no "create category" affordance because none exists in the app. |
| CategorizeMode — walk card, progress, auto-advance, Esc to exit | `src/components/transactions/CategorizeMode.tsx:76-87` | Snapshot the queue and advance on categorize | sensible — no "skip" button and no "done for now / resume later" memory; closing loses your place. |
| ReviewInbox — amnesty "Mark N before &lt;month&gt; reviewed" | `src/components/transactions/ReviewInbox.tsx:143-145` | Drain the historical backlog in one gesture | sensible — states its exact blast radius and is undoable. Protect. |
| ReviewInbox — cluster "Recategorize" / "Categorize all N" pickers | `src/components/transactions/ReviewInbox.tsx:234-242,246-254` | Fix a whole cluster in one gesture | sensible — server recomputes the live id set from an opaque ref (`review-inbox.ts:250-277`). Protect. |
| Undo toast action (every mutation) | `src/components/transactions/undo-toast.ts:12-28` + `src/components/ui/Toast.tsx:23-24` | Lossless inverse patch, never auto-dismissed | sensible — genuinely strong. But the patch lives only in client memory — a hard reload loses the undo for a mutation that touched thousands of rows. |

### Good

1. **The one-predicate discipline is real and rare** — `filterConditions`/`viewCondition`/`countMatching` (`src/services/transactions-query.ts:34-170`) are shared by the tab counts (`page.tsx:87-91`), the rendered rows (`page.tsx:127`) and `bulkApplyByFilter` (`bulk-edit.ts:187-194`) — the number on the tab IS the set the bulk action mutates. Most finance apps lie here.
2. **Every bulk mutation returns a server-captured lossless inverse patch** of exactly the fields it touched (`bulk-edit.ts:145-183`) and action toasts never auto-dismiss (`Toast.tsx:23-24, 52-57`). Undo is real, not a re-guess.
3. **Selection is force-reset on any params change** (`TransactionsLedger.tsx:124-129`) with the reasoning written down — this is the exact bug ("select all" silently re-binding to a new result set) that ships in real products, and there is an e2e regression for it (`zz-bulk-edit.spec.ts:32-49`).
4. **Cluster and group actions never trust client id lists** — `clusterMatchingIds` (`review-inbox.ts:250-277`) and `similarGroupIds` recompute the live set server-side from an opaque ref, so a re-click is idempotent and the blast radius is honest even if the queue shifted.
5. **The split editor's live "$X left" / "$X over" readout and its save gate both reuse the same pure invariant** (`validateSplitDraft`, `SplitEditor.tsx:180-182, 266-273`) — the UI cannot let you save a split the service would reject.
6. **The imported-row immutability story is stated in the product, not just enforced in code** — the expander renders imported facts read-only with the sentence "Imported row — date and amount are the audit trail" (`LedgerRowExpander.tsx:154-159`), and e2e pins it (`zz-zz-txn-expander.spec.ts`).
7. **Suggestion provenance in the sheet** — "matches a rule" / "usual for this merchant" / "N like it before" (`TransactionSheet.tsx:32-36`) — is exactly the half-sentence of trust the rest of the page is missing. Propagate this pattern everywhere a number or a guess appears.
8. **The keyboard scope stack is correctly layered** — the category picker owns Escape ABOVE the sheet and swallows it (`CategoryPicker.tsx:56-60`), the ledger scope stands down while the sheet is open (`TransactionsLedger.tsx:221`), and the sheet holds a modal tier (`Sheet.tsx:52-55`). Esc always closes exactly one thing.
9. **Transfer-link candidate copy states its own search window in words** — "No opposite-signed rows in other accounts within two weeks" (`LinkPanels.tsx:151-153`) — instead of an empty list.
10. **LetterBadge carries a visible letter plus sr-only meaning** (`Badge.tsx:47-56`) — the right pattern; the needs-review dot should copy it.
11. **The ledger order uses content-column tiebreaks rather than ids** (`page.tsx:114-121`, mirrored in `ledger-rows.ts:92-99`) so re-imports and re-seeds cannot shuffle same-day rows — visual baselines stay byte-stable.

### Bad

1. **[CRITICAL] "Transfer" (bulk bar and sheet checkbox) marks the badge but leaves the money counted as spending.** The owner selects 40 internal-transfer rows, clicks Transfer in the bulk bar, and gets "Marked as transfer · 40". `bulkApply` sets ONLY `transferGroupId = row.id` (`bulk-edit.ts:168-173`); the sheet checkbox does the same via `setTransactionFlags` (`bulk-edit.ts:285-292`). But analytics excludes transfers purely by category KIND — `spendingBucket` (`src/services/analytics.ts:201-208`) never reads `transferGroupId`. So `/spending`, the Sankey, the heatmap and the budgets all keep counting those 40 rows as spending. The T badge on the row says otherwise. `linkTransferPair` (`transfer-links.ts:115-121`) DOES stamp a Transfers category, so two paths that look identical in the UI produce different analytics. The owner's spending totals are silently inflated by however many rows he ever marked this way. — `src/services/bulk-edit.ts:172` + `src/components/transactions/BulkActionBar.tsx:93-95` + `src/components/transactions/TransactionSheet.tsx:239-245`
2. **[CRITICAL] Pressing "Filter" silently deletes merchant / flow / amount filters that the URL carries.** The owner clicks "View all 312 →" on `/merchants/[id]` (`merchants/[id]/page.tsx:64`) landing on `/transactions?merchant=<id>`. The FiltersBar renders completely empty — no chip, no indication (`FiltersBar.tsx:26-105` has no merchant/flow/amount input). He types a date in From and presses Filter; the GET form replaces the whole query string with only its own fields, so `merchant` vanishes and he is now looking at the ENTIRE ledger for that date range while believing he is looking at that merchant. Same for `flow=out` from every spending StatCard (`spending-stat-cards.ts`) and `amountMin`/`amountMax`. `hasActiveFilters` (`FiltersBar.tsx:27-29`) also ignores these, so there is not even a Reset link to tell him a filter is on. — `src/components/transactions/FiltersBar.tsx:32-105`
3. **[HIGH] The page cannot answer "why is this categorized as X?" — categorizationSource is never surfaced.** A row reads "Groceries". The owner wants to know whether he set it, a rule set it, the merchant map set it, the bank category set it, or Claude guessed it — because the answer decides whether to trust it. `categorizationSource` is not in the page's column selection (`page.tsx:95-111`), not in `LedgerRow` (`ledger-rows.ts:42-68`), and rendered nowhere. The sheet's "Matching rules" section explicitly disclaims being the cause ("a match here is what WOULD fire if this row were re-run, not necessarily what set its current category", `TransactionSheet.tsx:333-337`). The confidence NUMBER is also never shown — only a boolean "low confidence" badge (`TransactionSheet.tsx:230`). In an app whose entire pitch is auditability, the single most consequential derived field is unauditable. — `src/app/transactions/page.tsx:95-111`
4. **[HIGH] "Run categorization" re-inflates the review queue the owner just drained, reports nothing, and cannot be undone.** Pass 24 drained the review queue 404 → 0. One click of "Run categorization" calls `detectTransfers`, whose pass 2 unconditionally sets `needsReview = true` on every eligible contended outflow (`categorize.ts:631-644`) with no memory that the user already dismissed those rows — `bulkApply({markReviewed:true})` only clears the flag (`bulk-edit.ts:160-163`) and stores nothing. The queue re-fills. Meanwhile `categorizeAll` and `detectTransfers` both RETURN stats which the action throws away (`actions.ts:128-129`) and the action redirects with no notice, so the owner sees numbers move with no explanation, and there is no undo for a batch that just rewrote thousands of rows' review state. — `src/app/transactions/actions.ts:122-134`
5. **[HIGH] The Claude button blocks the whole request and shows a Next.js error page instead of a toast on failure.** With ~430 pending merchants that is 9 sequential Haiku calls awaited inside a single form-action navigation (`await classifyPendingMerchants(getDb())`, `actions.ts:150`). `classifyPendingMerchants` has try/finally but no catch, so an expired `ANTHROPIC_API_KEY`, a rate limit, or a dropped connection propagates out of the server action — the owner gets the error boundary, not the carefully-written "no-api-key" NoticeBanner (which only fires on the `result.ran === false` path, `actions.ts:154-157`). The button has no pending state and "Stop Claude run" is only rendered when `isRunning` (`HeaderStrip.tsx:68`), which cannot render until the blocking action resolves. This is exactly the reported "Claude button was failing" symptom. — `src/app/transactions/actions.ts:145-159`
6. **[HIGH] The Review tab's count and its content disagree, and the filter that causes it is invisible.** From `/transactions?account=<chase>` the owner clicks the Review tab. `filtersToQuery(filters, {view:"review"})` (`ViewTabs.tsx:25`) preserves `account`, so the tab reads "Review 12" (`page.tsx:88`, filtered). But the page renders `reviewInbox(db)` with NO filters (`page.tsx:158`), so the inbox header says "404 to review" and shows every cluster in the database. The FiltersBar is not rendered in the review view at all (`page.tsx:206-215`), so nothing on screen reveals the account filter, and "Mark all reviewed" hardcodes `{view:"review"}` (`ReviewInbox.tsx:91`) — clearing 404 rows from a screen the tab said held 12. — `src/app/transactions/page.tsx:158`
7. **[HIGH] The review queue conflates four unrelated problems into one undifferentiated boolean.** `needsReview` is set by at least four independent producers: Claude confidence < 0.8 (`claude-categorize.ts`), a large uncategorized deposit (`categorize.ts:261-266`), an ambiguous transfer pair (`categorize.ts:631-644`), and — critically — a suspected cross-file DUPLICATE row (`flagFuzzyDuplicates`, `src/services/import/service.ts:891-894`). The inbox shows none of this; the empty-state copy even enumerates only three reasons and omits duplicates (`page.tsx:54-56`). So "Confirm all 12" on a Trader Joe's cluster can silently accept a double-counted transaction as reviewed, and the owner's net worth is wrong with no trace. — `src/components/transactions/ReviewInbox.tsx:229-258`
8. **[HIGH] The open transaction is not in the URL, contradicting the page's own stated doctrine.** `openId` is `useState` in a client component (`TransactionsLedger.tsx:109`). Refreshing the page while investigating a transaction closes the sheet and loses the position. The sheet cannot be linked to, bookmarked, or sent to himself. Browser Back navigates off `/transactions` instead of closing the drawer — a phone user's reflex gesture. This directly violates the doctrine written at the top of this feature's own query parser: "URL is the state: every filter, tab, and page lives in searchParams so views are shareable and the back button works" (`query.ts:3-7`). Every other view state in the app — filters, tab, page, chart lens, dashboard mode — is in the URL; the most detailed one is not. — `src/components/transactions/TransactionsLedger.tsx:109,343-352`
9. **[HIGH] "Select all N" on the unfiltered All tab arms an unbounded mutation whose undo patch is shipped row-by-row to the browser.** On `/transactions` with no filters, `totalMatching` is `counts.all` = every active row (`page.tsx:87`). "Select all 21,438" → Reviewed calls `bulkApplyByFilter` (`actions.ts:340-353`), which builds an `UndoPatch` containing one `{id, prev}` object per mutated row (`bulk-edit.ts:145-183`) and returns the whole array across the RSC boundary into client memory; clicking Undo posts all 21,438 back. There is no confirmation dialog, no cap, and no chunking on the wire (only on the id SELECT, `bulk-edit.ts:98`). On the owner's real DB this is a multi-megabyte round trip from a single click; on a hosted free tier it is a request that dies halfway. — `src/components/transactions/BulkActionBar.tsx:68-76`
10. **[MEDIUM] The Category filter select silently disagrees with the URL, then destroys it.** `rootCategories` is roots only (`page.tsx:151-154`). Every deep link that sets `category` to a CHILD id (`/categories/[id]`, `categoryTrends`), or to the sentinels `uncategorized` / `spending` / `income` (`ledger-href.ts:28-29`, spending-stat-cards), produces a `defaultValue` matching no `<option>`, so the select displays "All categories" while the ledger is filtered. Pressing Filter then submits `category=""` and drops it. The owner clicks "Uncategorized $2,140" on `/spending`, sees the right rows, adjusts a date, and is now looking at everything. — `src/components/transactions/FiltersBar.tsx:45-52`
11. **[MEDIUM] Day-group net totals are wrong across page boundaries.** `groupByDay` (`TransactionsLedger.tsx:65-82`) runs over the 50-row page slice. A busy day with 60 rows renders as "Tue, Jul 14 · −$412.30" at the bottom of page 1 and "Tue, Jul 14 · −$188.05" at the top of page 2 — two different numbers, both presented as that day's net, neither labeled partial. The owner reads a day total that is arithmetically false. — `src/components/transactions/TransactionsLedger.tsx:65-82`
12. **[MEDIUM] No way to un-exclude in bulk; the Excluded tab's bulk bar offers a no-op instead.** `txnPatchSchema` supports `restore` and `clearTransfer` (`bulk-edit.ts:31,33`) but `BulkActionBar` exposes neither (`BulkActionBar.tsx:87-95`). Standing in the Excluded tab with 200 wrongly-excluded rows, the only bulk buttons are Reviewed, Exclude (a no-op that still reports "Excluded · 200" because the UPDATE runs, `bulk-edit.ts:164-167`) and Transfer. Restoring requires opening 200 sheets one at a time. — `src/components/transactions/BulkActionBar.tsx:87-95`
13. **[MEDIUM] Documented ↑/↓ sheet navigation does not exist.** Two doc comments promise it — "↑/↓ flips through rows with it open" (`TransactionsLedger.tsx:88-90`) and "↑/↓ flip through the ledger with the sheet open (§3.2)" (`TransactionSheet.tsx:42`). No ArrowUp/ArrowDown binding exists anywhere in `src/components/transactions` outside CategoryPicker's own listbox (`:89-94`), and the ledger's key scope is explicitly disabled while the sheet is open (`TransactionsLedger.tsx:221`). A keyboard user in the sheet must Tab to the chevron buttons. `zz-categorize.spec.ts` clicks the buttons, so e2e never caught the gap. — `src/components/transactions/TransactionsLedger.tsx:88-90`
14. **[MEDIUM] An out-of-range page is a 96-click dead end.** `page` is offset blindly (`page.tsx:135`) with no clamp. Bookmarking `?page=42`, then filtering to a small set, renders "Page 42 of 3", the "No matching transactions" empty state, a disabled Next, and a Previous link to page 41. There is no first/last, no page-number input, and no clamp-to-last on the server. — `src/components/transactions/Pagination.tsx:15-48`
15. **[MEDIUM] Filtered-empty is an unrecoverable dead end for merchant/flow/amount filters.** `EmptyState` has no action slot (`src/components/ui/EmptyState.tsx:8-17`), and the FiltersBar above it renders a Reset link only when account/category/from/to/q are set (`FiltersBar.tsx:27-29`). On `/transactions?merchant=<id>&flow=in` with zero matches, the screen is an empty form, a paragraph, and no way out except editing the address bar. — `src/app/transactions/page.tsx:216-220`
16. **[MEDIUM] The review inbox renders every cluster unbounded — hundreds of cards, no pagination, no search.** `data.clusters.map(...)` with no slice (`ReviewInbox.tsx:153-163`) over `reviewInbox`, which loads and clusters the entire active needsReview backlog (`review-inbox.ts:163-243`). The owner's real backlog was 404 rows; each cluster renders a card with up to `SAMPLE_LIMIT` rows and two pickers whose option list is the whole taxonomy. On a phone this is a multi-thousand-node DOM with no way to jump to a specific merchant. — `src/components/transactions/ReviewInbox.tsx:153-163`
17. **[MEDIUM] The Claude-suggestion feature in the picker is dead code.** `suggestedCategoryIds` is hardcoded to `[]` in the single factory that builds every LedgerRow (`ledger-rows.ts:67`) and no other producer exists in the repo. So the picker's suggestion float (`CategoryPicker.tsx:67-74`) and its "Claude" pill (`:172-174`) can never fire from the ledger row (`TransactionsLedger.tsx:282`) or the sheet (`TransactionSheet.tsx:229`). The exact affordance that would make triaging 400 rows fast is wired up and disconnected. — `src/services/ledger-rows.ts:67`
18. **[MEDIUM] "Mark all reviewed" is a ghost button that nukes the entire queue with no confirm and no count.** Rendered as `variant="ghost"` — the lowest visual weight in the design system — directly beside the amnesty button which is `variant="secondary"` and states its exact count (`ReviewInbox.tsx:143-149`). Its own label carries no number. A single misclick clears the whole backlog; the only protection is a toast that the user must notice and click. — `src/components/transactions/ReviewInbox.tsx:147-149`
19. **[MEDIUM] On a phone the row hides the account name and both status badges.** Account name is `hidden ... md:inline` (`TransactionsLedger.tsx:298`) and the T/R badge wrapper is `hidden ... sm:flex` (`:294`) — and because `display:none` removes nodes from the accessibility tree, the LetterBadge's sr-only text goes with it. The owner explicitly views this from his phone; below 768px he cannot tell which of his eight accounts a transaction came from without opening the sheet, and below 640px he cannot see that a row is a transfer or a recurring charge at all. — `src/components/transactions/TransactionsLedger.tsx:294,298`
20. **[MEDIUM] The needs-review dot is invisible to screen readers.** `<span aria-label="Needs review" className="... rounded-full bg-info" />` (`TransactionsLedger.tsx:299-301`) — `aria-label` on a role=generic element is prohibited and ignored by AT, and the span has no text. It sits inside the row button, contributing nothing to that button's accessible name. The page's own `LetterBadge` (`Badge.tsx:47-56`) already demonstrates the correct sr-only pattern. — `src/components/transactions/TransactionsLedger.tsx:299-301`
21. **[MEDIUM] A single-row correction at a busy merchant has no Undo.** In `runCategoryCorrection`, when a rule prompt exists with `matchCount > 0` the returned `undo` patch is discarded and the toast offers only "Apply to N" (`correct-category.ts:32-45`). Mis-tagging one Amazon row means the only recovery is manually re-picking the old category — which the user may no longer remember. — `src/components/transactions/correct-category.ts:32-45`
22. **[LOW] The direction-guard notice is unreachable dead code.** `NoticeBanner`'s "direction-guard" copy (`NoticeBanner.tsx:5-9`) is produced only by `correctCategoryAction` (`actions.ts:94-118`), which has zero callers in the app. The live correction path is `correctCategory` → `bulkApply`, which never calls `applyCorrection` and never touches a merchant default. The refund-protection story the app tells about itself never reaches the user. — `src/app/transactions/actions.ts:94-118`
23. **[LOW] The expander fires the full sheet panel just to read a merchant name.** `LedgerRowExpander` calls `loadSheetPanel(row.id)` (`LedgerRowExpander.tsx:30`), which runs `similarTransactions`, `merchantSummary`, `similarGroupIds`, and `categorizeContext` (suggestion + 12-month history + matching rules) — `sheet-actions.ts:53-98` — to display one string. Expanding ten rows to read notes fires ten of the page's heaviest reads. — `src/components/transactions/LedgerRowExpander.tsx:27-38`
24. **[LOW] Notes in the sheet save on blur with no toast and no undo, unlike every sibling mutation.** `saveNotes` fires on blur and swallows its result (`TransactionSheet.tsx:143-148, 251`) — no toast, no undo, and closing the sheet via Escape or a backdrop click before the field blurs can drop the edit. Every other mutation on this page routes through the value-returning action → toast → lossless undo pattern. The expander's own notes field DOES use InlineEditableText with a `describe()` and undo (`LedgerRowExpander.tsx:134-150`), so the two notes editors behave differently. — `src/components/transactions/TransactionSheet.tsx:143-148`
25. **[LOW] Per-render cost is a full-table materialization plus five counting scans.** One render runs `coverageStats` (selects EVERY active row into JS, `categorize.ts:739-744`), four `countMatching` calls each re-loading all category refs (`page.tsx:87-90` → `transactions-query.ts:146-155`), `totalInLedger`, `pendingMerchantQueue`, and in the review view a full `reviewInbox` load. All synchronous better-sqlite3. Fine on a local ledger; on the free-tier host the owner is planning, `/transactions` will be the first page to time out. — `src/app/transactions/page.tsx:86-158`

### Change

1. **Make FiltersBar carry every filter the URL supports, and never destroy one** (M) — Add hidden inputs for `merchant`, `flow`, `amountMin`, `amountMax` (and keep `view`) so a GET submit preserves them, then add real controls: a flow segmented control (All / In / Out), a min/max amount pair, and a merchant field. Change `hasActiveFilters` (`FiltersBar.tsx:27-29`) and the Reset href (`:90-97`) to cover all of them. Populate the Category select from `pickerOptions` (the full indented tree already built at `page.tsx:155`) plus explicit `Uncategorized` / `All spending` / `All income` sentinel options so every URL value round-trips.
2. **Add an active-filter chip row above the ledger** (S) — Render one dismissible chip per non-default filter (Account: Chase · Merchant: Dunkin' · Out only · $15–$60 · Jul 1–Jul 31 · "STARBUCKS"), each linking to `filtersToQuery(filters, {<key>: null, page: 1})`. This makes deep-linked state visible for the first time and gives the filtered-empty state an escape hatch. Also pass an optional `action` slot into `EmptyState` (`src/components/ui/EmptyState.tsx:8-17`) and use it for "Clear filters" and, on the zero-import state, "Import statements →".
3. **Make "Transfer" mean what the badge implies** (M) — In `bulkApply` (`bulk-edit.ts:168-173`) and `setTransactionFlags` (`bulk-edit.ts:285-292`), when marking a transfer also stamp the Transfers-kind category exactly the way `linkTransferPair` does (`transfer-links.ts:115-121`), capturing the prior category into the undo patch. Until then, at minimum relabel the controls "Mark as transfer (link only)" and show an inline warning that unlinked transfer marks still count as spending.
4. **Surface categorization provenance everywhere the category appears** (M) — Add `categorizationSource` to the page's column selection (`page.tsx:95-111`) and to `LedgerRow` (`ledger-rows.ts:42-68`). Render a tiny source glyph on the row (rule / merchant / bank / Claude / you) and a full "Why this category" line in the sheet: source + confidence number + the specific rule sentence or merchant default or Claude batch that assigned it. Reuse the excellent `suggestionReason` copy pattern (`TransactionSheet.tsx:32-36`).
5. **Give the review queue a reason per row and per cluster** (L) — Persist a review reason (low-confidence / large-uncategorized-credit / ambiguous-transfer / suspected-duplicate) at each of the four producers — `categorize.ts:261-266`, `categorize.ts:631-644`, `claude-categorize.ts`, and `import/service.ts:891-894` — and render it as a badge on the ClusterCard (`ReviewInbox.tsx:186-209`) and on the ledger's review dot. Suspected duplicates in particular must never be clearable by the same generic "Confirm all" as a low-confidence guess.
6. **Make the Review view honor (or visibly reject) the URL filters** (M) — Pass `filters` into `reviewInbox` (`page.tsx:158`) so the inbox, the tab count (`page.tsx:88`), the CategorizeMode source (`page.tsx:164-174`) and `markAll` (`ReviewInbox.tsx:91`) all describe the same set — or, if the inbox is deliberately global, strip non-view params from the Review tab link (`ViewTabs.tsx:25`) and say so on screen. Today they silently disagree.
7. **Put the open transaction in the URL** (M) — Move `openId` (`TransactionsLedger.tsx:109`) into a `?txn=<id>` search param via `useViewState`-style push, and have the page render the sheet server-side when present. This makes a transaction linkable, survivable across refresh, and closable with the phone's Back gesture — and brings the page back in line with `query.ts:3-7`.
8. **Report what "Run categorization" actually did, and stop it silently re-flagging** (M) — `categorizeAll` and `detectTransfers` already return stats (discarded at `actions.ts:128-129`). Convert the button to a value-returning action + toast: "Categorized 42 · matched 7 rules · flagged 3 ambiguous transfers · paired 5 transfers", with a link to the newly-flagged rows. Separately, add a `reviewDismissedAt` (or reuse a source column) so pass 2 (`categorize.ts:631-644`) never re-flags a row the user already cleared.
9. **Make the Claude run non-blocking and failure-safe** (L) — Wrap `classifyPendingMerchants` in a catch that records a failed `claudeLastRun`, and move the run off the request: fire-and-return with the run-state flag already in place (`claude-run-state`), then poll or stream progress so "Stop Claude run" (`HeaderStrip.tsx:69-77`) is actually reachable and the button can show a real pending state.
10. **Make the header stats clickable** (S) — Turn each `Stat` (`HeaderStrip.tsx:44-55`) into a link: Coverage → `?category=uncategorized`, Needs review → `?view=review`, Queued for Claude → a merchant-queue list, AI spend → `/settings`. Four numbers that currently answer nothing become four one-click investigations.
11. **Fix the day-group net across page boundaries** (S) — Either compute day nets server-side over the full filtered set (a single GROUP BY alongside the page query) and pass them into `groupByDay`, or label a boundary-straddling group "partial — continues on the next page". Today `TransactionsLedger.tsx:65-82` prints an arithmetically false total.
12. **Complete the bulk action set and state the money involved** (S) — Add "Restore" (`restore: true`) and "Clear transfer" (`clearTransfer: true`) buttons — both already in the patch schema (`bulk-edit.ts:31,33`) — and make the Exclude/Restore pair swap by view. Show the summed amount beside the count in the bar ("128 selected · −$4,208.11") and add a confirm step whenever the count exceeds a threshold or `allMatching` is on.
13. **Clamp and complete pagination** (S) — Clamp `filters.page` to `ceil(totalRows/PAGE_SIZE)` server-side (`page.tsx:135`), and add First/Last links plus a page-number input to `Pagination.tsx:27-46`. Optionally offer 50/100/250 rows per page.
14. **Bound and search the review inbox** (M) — Paginate or virtualize the cluster list (`ReviewInbox.tsx:153-163`), add a cluster search field, sort options (count / net / newest), and make cluster sample rows and "+N more" (`:215-225`) link into `/transactions?merchant=<id>&view=review` so a cluster can be inspected rather than only confirmed.
15. **Implement the documented ↑/↓ sheet navigation, or delete the claim** (S) — Bind ArrowUp/ArrowDown at the sheet tier when a transaction sheet is open so `onFlip` fires from the keyboard (`TransactionsLedger.tsx:146-150`), and disable/annotate the chevrons at the page boundary. Add an e2e assertion so the doc comments at `TransactionsLedger.tsx:88-90` and `TransactionSheet.tsx:42` are enforced rather than aspirational.
16. **Fix the mobile row and the review dot's accessibility** (S) — Below `md`, move the account name and T/R badges to a compact second line of the row rather than hiding them (`TransactionsLedger.tsx:294,298`) — the owner reads this on a phone. Replace the needs-review span's `aria-label` (`:299-301`) with the LetterBadge pattern: an aria-hidden dot plus sr-only text that also names the reason.
17. **Stop the expander over-fetching, and mark rows that carry notes** (S) — Add a narrow `loadMerchantName(txnId)` action instead of `loadSheetPanel` (`LedgerRowExpander.tsx:30`), or include the merchant name in the page's join. Add a small note glyph on the collapsed row when `notes !== null` so annotations are discoverable without expanding every row.
18. **Preserve the single-row Undo alongside the rule prompt** (S) — In `correct-category.ts:32-45`, render both affordances — "Apply to N" and "Undo" — on the same toast, or chain them so accepting the rule prompt still leaves an undo for the original single-row change.
19. **Link the sheet's rules "Manage →" to the actual rules section** (S) — Point `TransactionSheet.tsx:344` at `/settings#rules` and add the matching anchor id in `settings/page.tsx:75`, so the user does not land above thresholds and backups and have to hunt.
20. **Populate suggestedCategoryIds or remove the affordance's promise** (M) — `ledger-rows.ts:67` hardcodes `[]`. Have `toLedgerRow` accept optional suggestions (the low-confidence Claude alternates, or the top-3 categories for the row's merchant/name key) so the picker's suggestion float and "Claude" pill (`CategoryPicker.tsx:67-74,172-174`) can actually fire — this is the single highest-leverage speedup for the guided walk.

### Add

1. **A filtered-set summary strip above the ledger** (M) — A compact bar directly under the tabs stating, for the CURRENT filter set (not the page): total in, total out, net, transaction count, distinct merchants, distinct accounts, date span, and average. Reuse the same `filterConditions` predicate the counts already use (`transactions-query.ts:48`) so the strip reconciles to the ledger by construction. *Why:* The number-one thing a user asks after filtering is "how much is that?", and this page — the only full-ledger filter in the app — cannot answer it. `Pagination.tsx:22-26` gives a row count and nothing else.
2. **Sortable columns (amount, date, merchant, account, category)** (M) — Add a `sort`/`dir` pair to `TxnFilters` (`query.ts:17-31`) and a sort control (or clickable column headers) mapping into the existing `ledgerOrder` array (`page.tsx:114-121`), keeping the content-column tiebreaks as the final terms so baselines stay stable. Default stays date desc. *Why:* Order is hardcoded date-desc. "What were my five biggest charges in June?" — a first-minute question for anyone with money in this — is unanswerable on the ledger and requires a detour to `/spending`'s `largestTransactions`.
3. **CSV export of the current filtered set** (S) — A route handler that streams the `matchingTransactionIds` set (`transactions-query.ts:158`) with date, account, description, raw description, merchant, category (or split parts), amount, status, transfer group, notes, source and confidence. A single "Export" button beside Select. *Why:* No export path exists anywhere in the repo — the app can only ingest. For taxes, for a CPA, for a spreadsheet sanity-check, or simply to not feel locked in, this is table stakes and it is the cheapest trust win on the page.
4. **Full-text search that covers notes, merchant names and amounts, with live results** (M) — Extend the `q` clause (`transactions-query.ts:111-122`) to also match notes and the joined merchant canonical name, add an amount-literal parser (typing "42.50" matches the amount, "> 100" sets amountMin), and debounce the input into the URL instead of requiring a Filter press. Highlight the matched substring in the row description. *Why:* The owner can annotate every row (`LedgerRowExpander.tsx:134`) and can never find those annotations again. Search that misses notes and merchant names makes the notes feature write-only.
5. **Saved views / quick-filter presets** (M) — Persist named filter sets into `app_settings.viewPreferences` (the mechanism already exists — `src/lib/view-state.ts`, settings actions) and render them as pills above the FiltersBar: "Uncategorized", "Needs review", "This month", "Large (> $200)", "Manual rows", "Split rows", "Low confidence", plus user-saved ones. Each is just a `filtersToQuery` string. *Why:* The owner's working passes are the same handful of queries over and over (uncategorized tail, big deposits, one merchant's history). Today each one is a hand-built URL or a five-control form fill.
6. **A "why is this in review?" and "why this category?" explain panel in the sheet** (M) — One collapsible section stating: review reason (from the new reason field), assigning source + confidence, the winning rule (with a link and a "disable this rule" action), the merchant default, and — for a Claude-assigned row — the batch and date. Pair it with the existing suggestion reason line (`TransactionSheet.tsx:32-36`). *Why:* This is the single feature that turns the page from a data dump into a product. Right now a categorized row is an assertion with no evidence, on a surface whose whole premise is that statements are the source of truth.
7. **Add / duplicate / delete a transaction from the ledger** (M) — Wire the existing `addManualTransactionAction` (`actions.ts:516`) and `deleteManualTransaction` (`manual-transactions.ts:267`) into this page: an "Add transaction" button beside Select (account picker + date + amount + description + category), a row-level "Duplicate" for recurring cash entries, and a delete affordance on manual rows only, with the existing audit-trail guard doing the refusing. *Why:* Cash spending, reimbursements and IOUs are a real part of this owner's ledger (the cash-job story), and today they can only be entered from `/accounts` wallets. The transactions page — literally named for the object — cannot create one.
8. **Bulk notes / tags on the selection** (S) — Add a "Note" action to BulkActionBar that appends or sets a note across the selection through the existing `notes` field on `txnFlagsSchema` (`bulk-edit.ts:264`), captured in the undo patch like everything else. If a tag concept is added later, this is the same control. *Why:* The owner's real workflow (pass 24) was tagging cohorts — "dad's money", "Cancun reimbursement", "Carson's card". He had to do it with guarded SQL scripts because the UI has no bulk annotation.
9. **A keyboard shortcut legend / help overlay** (S) — A `?` overlay (and small kbd hints on the Select and Confirm buttons) listing the real bindings: `X` selection mode, `Esc` exit, `R` confirm focused cluster, `A` focus newest toast action, `⌘K` palette. Ship it after fixing/implementing ↑/↓ so the legend is true. *Why:* Three genuinely good accelerators exist (`TransactionsLedger.tsx:218-223`, `ReviewInbox.tsx:108-120`, ToastMnemonic) and there is not one character of UI anywhere that mentions them, so they may as well not exist.
10. **A running balance column when the ledger is scoped to a single account** (L) — When `filters.account` is set and the sort is date-desc with no amount filter, render a running balance per row derived from `daily_balances` + intra-day replay, with a basis marker on estimated days (the same honesty vocabulary the charts use). *Why:* This is how the owner reconciles against a paper statement — the exact activity this app exists for — and it is the one thing every bank register has that this ledger does not.
11. **Bulk merchant reassignment** (M) — A "Merchant" action in BulkActionBar that reassigns `merchantId` across the selection (the undo schema already carries `merchantId`, `bulk-edit.ts:46`). BulkActionBar's own header comment concedes this is deferred (`BulkActionBar.tsx:12-13`). *Why:* With ~434 distinct merchants, cleaning up merchant fragmentation ("AMZN MKTP", "AMAZON.COM", "AMZN Mktp US*2K3") is a core maintenance task with no bulk path today — only one-at-a-time renames.
12. **A suspected-duplicate review surface** (M) — Give `flagFuzzyDuplicates` (`import/service.ts:877-894`) its own view or cluster kind that shows the two rows side by side with account, date, amount, description, and source file, plus "same transaction — exclude one" / "genuinely two charges" actions. *Why:* Duplicates are the one review category that changes NET WORTH, not just categorization, and today they are indistinguishable from a Claude confidence wobble in the same queue.
13. **Percentage and even-split helpers in the split editor** (S) — Add a "%" toggle on each split line and a "Split evenly across N" button, computing cents with the existing remainder readout absorbing the rounding penny (`SplitEditor.tsx:158-182`). *Why:* Splitting a $214.83 Costco run three ways is currently three manual subtractions; the editor already knows the remainder and could do the arithmetic the user is doing in his head.
14. **An account column filter and per-account grouping toggle** (M) — Alongside the day grouping, offer "group by account" and "group by merchant" as a view dimension in the URL, reusing the app's `ViewSpec` machinery (`src/lib/view-state.ts`) exactly like the charts do. *Why:* Every other surface in this app has a lens/mode dimension in the URL; the ledger — the most-used surface — has exactly one immutable presentation.
15. **Mobile-first filter sheet** (S) — Below `md`, collapse the FiltersBar into a single "Filters (3)" button opening the existing Sheet primitive, with the chip row remaining visible inline. Keep the desktop bar as-is. *Why:* At 320–375px the current flex-wrap form (`FiltersBar.tsx:32`) stacks into five full-width fields plus a button before a single transaction is visible — on the device the owner says he will actually use.

---

## `/spending` — the Spending tab

(`src/app/spending/page.tsx`, `src/app/spending/actions.ts`, `src/components/spending/**`)

**Purpose** — This is the owner's "where did the money actually go this month" surface — the one page that puts income and outflow on the same axis and refuses to hide anything. He lands here after an import to answer four questions in order: how much came in and went out this period (StatCards), was that normal or is he running hot (pace + prior-period ghost), what drove it (categories / merchants / largest purchases / heatmap), and what is still unaccounted for (the Honesty card's Uncategorized + Excluded buckets). It is the reporting counterpart to `/transactions`: every number is meant to be a doorway into the exact rows behind it, so he never has to trust a chart. Given his real ledger (~1300 hand-categorized rows, 434 merchants, a cash job, gambling flows, and dad's money passing through), the page's real job is to make miscategorization *visible* fast — a suspicious category total is the signal that a rule or a merchant default is wrong.

**Connections** — READS: `cashFlowByPeriod` / `spendingProjection` / `honestyBuckets` / `dailySpendHeatmap` / `topMerchants` / `largestTransactions` from `services/spending.ts`; `categoryBreakdown` (twice — this period and the prior) from `services/analytics.ts`; `spendingSankey` from `services/sankey.ts`; `predictBudgetableCategories` from `services/category-forecast.ts` (the SAME engine `/budgets`' Predict-budgets uses, surfaced read-only at `page.tsx:106-121`); `readSettings(db).viewPreferences.spending` for the persisted cash-flow lens (`page.tsx:68`). All aggregates funnel through `analytics.activeTxnsInRange`, which explodes splits, so this page is split-aware by construction. WRITES: nothing to the ledger. The only server actions are read-loaders — `loadSpendHeatmap` (`actions.ts:94`) for month paging, and `loadSpendingCategoryTxns` (`actions.ts:57`) which despite its doc comment is consumed ONLY by `/categories/[id]` (`page.tsx:90`), never by `/spending`. `saveViewPreferenceAction` writes `app_settings.viewPreferences` via `useViewState.ts:52`. LINKS OUT: `/transactions` with exact filters (5 stat cards, every chart bar segment via `cashFlowSegmentHref` `spending.ts:377`, every axis tick, every Sankey node, every merchant row, the day sheet, the largest-purchase sheet, both honesty buckets); `/categories/[id]` from the categories table (`SpendingCategoriesTable.tsx:105,154`). LINKS IN: the nav item (`shell/nav-items.ts`), and `/categories/[id]`'s breadcrumb back to "/spending" (`categories/[id]/page.tsx:95`). The whole period is URL state (`?period=` / `?from=&to=`), and the cash lens is a `{key:"cash"}` view dimension (`spending-view-spec.ts:13`) resolved URL > persisted > default.

### Interactive inventory

| element | file:line | intended | verdict |
|---|---|---|---|
| Cash-flow ViewSwitcher — Graph | `src/components/spending/CashFlowView.tsx:112-113` | Cumulative running-total lines | **broken** — With Day granularity `subBuckets` returns exactly one bucket (`lib/period.ts:291-296`); recharts `<Line dot={false}>` over a 1-point dataset (`CashFlowGraph.tsx:139-165`) draws nothing. The user gets axes, a legend and an empty plot, with no empty state (the `buckets.length === 0` guard at `:69` does not fire). |
| Spent StatCard (link) | `src/lib/spending-stat-cards.ts:54-60` | Open `/transactions?category=spending&flow=out&from&to` | **broken** — `filterConditions`' `category="spending"` branch (`services/transactions-query.ts:58-81`) matches on the PARENT row's `category_id` only, unlike the named-category branch (`:81-107`) which is split-aware. A split row counted at 60% by the Spent card opens in the list at 100%, so the drill-down does not reconcile with the number that opened it. |
| Category row link → `/categories/[id]` | `src/components/spending/SpendingCategoriesTable.tsx:104-110` | Open the entity that closes the chain (trend, subcats, merchants, budget, series) | **broken** — Drops the period. From `?period=2026` showing "Groceries $14,200", the link is a bare `/categories/<id>`, and the category page falls back to the CURRENT MONTH (`categories/[id]/page.tsx:64-67` → `lib/period.ts:184-185`). The user clicks a year number and lands on a month number with no explanation. `e2e/zz-spending-categorize.spec.ts:22` works around it by re-appending `?period=2026` by hand. |
| Subcategory row link | `src/components/spending/SpendingCategoriesTable.tsx:153-159` | Open the child category | **broken** — Same dropped period as the parent row. |
| "Apply range" submit button | `src/components/spending/PeriodSelector.tsx:192-197` | Navigate to `?from=&to=` | **missing-state** — `applyCustom` (`:87`) silently returns when `from`/`to` are empty or inverted — the button is enabled, the click does nothing, and no message appears. There is also no busy/pending state during the RSC round-trip. |
| ViewSwitcher pending feedback | `src/components/spending/CashFlowView.tsx:37` | Indicate the awaited persist + navigation | **missing-state** — `useViewState` returns `isPending` (`hooks/useViewState.ts:62`) and ViewSwitcher accepts `disabled` (`ui/ViewSwitcher.tsx:20`) — CashFlowView destructures neither. The pill click awaits `saveViewPreferenceAction` THEN `router.push` (`useViewState.ts:45-57`) with zero visual response. |
| Heatmap ‹ Previous month | `src/components/ui/CalendarGrid.tsx:135-140`; `SpendHeatmap.tsx:54-61` | Load a new month through `loadSpendHeatmap` without leaving the page | **missing-state** — On `res.ok === false` (`actions.ts:96-100`) nothing happens: `setPending(false)` runs, the grid keeps the old month, no toast, no message. A failed load is indistinguishable from a month with no data. |
| Category expand/collapse chevron | `src/components/spending/SpendingCategoriesTable.tsx:91-102` | Reveal subcategory rows | **missing-state** — Correctly `invisible` + disabled when there are no children, but the open/closed set is component-local useState (`:70`) with no URL or persistence — any navigation on this page (including a cash-lens pill click) collapses everything. |
| Page-level loading / error boundary | `src/app/spending/page.tsx:38` | Cover the force-dynamic render | **missing-state** — There is no `loading.tsx` or `error.tsx` anywhere under `src/app`. Every period step, granularity switch and lens toggle blocks on ~10 full transaction scans with no skeleton, and a `readSettings` Zod throw (`page.tsx:68`) takes the route to Next's default error screen. |
| › Next period link | `src/components/spending/PeriodSelector.tsx:126-132` | Step one period forward | **dead-end** — Never disabled and never bounded. From the current month it pages into 2026-08, 2026-09, … forever; each lands on the EmptyState (`page.tsx:193`) which strips every control on the page and offers no way back to data except the browser Back button or the reset link. |
| `cash=table` DataTable rows (Period / Earned / Spent / Net / prior) | `src/components/spending/CashFlowView.tsx:56-105` | The same numbers as rows | **dead-end** — No `rowHref` and no `onRowClick`, though DataTable supports both (`ui/DataTable.tsx:31-40`). Every other lens on this page drills; the table — the one place a specific week's number is legible — is the only inert one. |
| Day sheet "Where it went" / "Who it went to" entries | `src/components/spending/SpendHeatmap.tsx:243-273` | Top-3 categories and merchants for the day with a residual row | **dead-end** — Static text. The category and merchant names in the sheet are not links, though both `/categories/[id]` and a merchant-filtered ledger exist and the card 20 pixels away (TopMerchantsCard) links exactly these names. |
| Merchant-coverage footnote ("N% of spending rows are linked") | `src/components/spending/TopMerchantsCard.tsx:45-48` | State linkage honesty | **dead-end** — Names a real backlog (`unlinkedCount` grouped by name) with no action attached. There is no link to the unlinked rows and no `/merchants` index to fix them on. |
| Largest-purchase sheet "Category" row | `src/components/spending/LargestPurchases.tsx:69-77` | Show the chip, or italic "Uncategorized" | **dead-end** — The single most likely reason to open this sheet is that the biggest charge of the month is mis-tagged, and there is no way to fix it: no CategoryPicker, no link to the category, no link to the transaction. `InlineCategorizeList` (which does exactly this) exists in this very directory and is not wired here. |
| EmptyState (no activity in the period) | `src/app/spending/page.tsx:193-197` | Explain an empty period | **dead-end** — Replaces the ENTIRE body — stat cards, lenses, honesty card, heatmap all vanish, leaving only the period selector. It offers no "jump to the latest period with data" link and no statement of what the nearest non-empty period is. |
| Custom panel Escape / outside-pointerdown dismissal | `src/components/spending/PeriodSelector.tsx:66-83` | Close the disclosure from anywhere | **confusing** — Bypasses the app's KeyScope stack (`lib/keyscope.ts`) that Sheet and CommandPalette use — a raw document keydown listener. Works today because nothing modal coexists with it. |
| Net StatCard (link) | `src/lib/spending-stat-cards.ts:75-84` | Show earned + refunds − spent, drill to the period | **confusing** — href is `ledgerHref({from,to})` — the WHOLE period ledger including transfers, investment rows and every excluded-kind category. The list it opens does not sum to the number on the card, and there is no note saying so. |
| Savings-rate StatCard (link) | `src/lib/spending-stat-cards.ts:86-97` | net ÷ earned as a percent | **confusing** — Identical href to the Net card (`:82` vs `:92`) — two of five cards are the same destination. A percentage that opens an unfiltered transaction list answers nothing; there is no route to "which months was this higher". |
| Cash-flow ViewSwitcher — Table | `src/components/spending/CashFlowView.tsx:96-105` | The same per-bucket numbers as rows (the honest escape hatch) | **confusing** — In Sankey mode the Table option does NOT table the Sankey — it swaps to the per-bucket cash-flow table, a different dataset. The dashboard's Sankey has its own Flow/Table toggle (`SankeyChart.tsx:263-278`) which `/spending` deliberately does not pass (`:74` `showTableToggle = false`), so the ribbon amounts here exist only in an aria-hidden pointer tooltip (`:241`). |
| "Other" spending segment | `src/components/spending/CashFlowChart.tsx:245,255` | Deliberately inert — an aggregate with no exact filter | **confusing** — Correct decision, but the user gets no explanation: hovering gives `cursor:default` and nothing else. Every neighbouring segment navigates. A tooltip line ("aggregate of N smaller categories") or a drill to the whole bucket would close it. |
| Heatmap › Next month | `src/components/ui/CalendarGrid.tsx:141-146` | Same, forward | **confusing** — Unbounded and unrelated to the period: from `?period=2026-07` you can page the heatmap to 2026-12 while every other card on the page still describes July. Nothing on screen flags the divergence, and the month is lost on the next navigation. |
| Heatmap cell figures + magnitude bars | `src/components/spending/SpendHeatmap.tsx:106-113,144-172` | State both sides of the day as signed figures over a shared-scale bar | **confusing** — The bars are `hidden sm:block` (`:166`), so on the phone the owner says he will use, the magnitude signal is gone entirely and the cells fall back to 10px truncated text (`:157`) in a 7-column aspect-square grid — the exact "a wash of colour that never says how much" problem this component's header says it fixed, inverted. |
| Top merchant row link | `src/components/spending/TopMerchantsCard.tsx:21-42` | Drill to that merchant's (or stripped-key group's) filtered ledger | **confusing** — For `kind === "merchant"` the entry carries a real merchant id (`services/spending.ts:685`) but links to `/transactions?merchant=…`, never to `/merchants/[id]` — which exists and is the only screen that shows what the app has LEARNED about that payee (default category, aliases). The one card on the page that names merchants declines to open the merchant. |
| Share-of-period bar + % | `src/components/spending/SpendingCategoriesTable.tsx:112-117`; `page.tsx:95-97` | Proportion of the period's spending | **confusing** — The denominator is the sum of POSITIVE categorized spends only (`page.tsx:97`). Uncategorized outflows — which the Spent card and the chart both include — are excluded, so the percentages are of a smaller base than the headline and can never be reconciled from what is on screen. |
| MoM delta column | `src/components/spending/SpendingCategoriesTable.tsx:118-122`; `SpendDelta.tsx:8-11` | Current − previous period, with inverted semantics (more spend = negative tone) | **confusing** — Hidden below `md` (`hidden md:block`) so the phone never sees it, and hidden entirely for quarter/year/week/day (`page.tsx:235`) even though `page.tsx:87-90` computes the previous period's breakdown unconditionally. QoQ and YoY comparison is calculated and thrown away. |
| $0 "upcoming" forecast rows | `src/app/spending/page.tsx:142-159` | Surface a confidently-forecast category that had no spend this period | **confusing** — Renders as a normal row showing $0, 0%, +$0 delta, indistinguishable from a real zero-spend category except by the forecast sub-line. No heading, no divider, no "upcoming" label. |
| Largest-purchase sheet "View that day in the ledger →" | `src/components/spending/LargestPurchases.tsx:83-88` | Escape to context | **confusing** — Drops you on the whole DAY, not the transaction. The row has `id` in hand (`LargestPurchaseRow.id`, `:16`) and `/transactions` supports `q=`; the user must re-find the row they just clicked. |
| Income bar segment click | `src/components/spending/CashFlowChart.tsx:236-239` | Drill to that income category × that bucket, `flow=in` | **undiscoverable** — Pointer-only. recharts' accessibility layer is not used and no segment is focusable, so on a month period (day buckets, where ClickableTick's `focusable` is false — `:97,349`) there is NO keyboard route to any chart drill at all. |
| Spending bar segment click | `src/components/spending/CashFlowChart.tsx:256-263` | Drill to that top-level category × bucket | **undiscoverable** — Same pointer-only limitation. `cursor:pointer` is the only affordance; nothing on screen says the bars are clickable. |
| Dotted amber pace ReferenceLine | `src/components/spending/CashFlowChart.tsx:185-192` | The typical-spend-per-bucket reference | **undiscoverable** — Drawn but absent from the figcaption legend (`:292-311`), which names every series, Net, and the ghost. An unlabelled amber dashed line across the plot has no explanation anywhere on screen. |
| Sankey ribbon hover tooltip (amount + share) | `src/components/charts/SankeyChart.tsx:178-181,237-249` | Name the flow, amount and share of throughput | **undiscoverable** — aria-hidden and pointer-only, and on `/spending` there is no Table lens for the ribbons — so every ribbon amount is unreachable by keyboard, by screen reader, and on touch. |
| Granularity pills — Day / Week / Month / Quarter / Year (5 links) | `src/components/spending/PeriodSelector.tsx:97-111` | Re-anchor the period at a new granularity via `switchGranularityParams`, keeping the old period's start date inside the new window | sensible |
| ‹ Previous period link | `src/components/spending/PeriodSelector.tsx:116-124` | Step one period back at the current granularity | sensible |
| Period label with `aria-live="polite"` | `src/components/spending/PeriodSelector.tsx:123` | Announce the new period on navigation | sensible |
| Contextual reset link ("Today" / "This week" / "This month" / …) | `src/components/spending/PeriodSelector.tsx:136-143` | Jump to today's period at the active granularity; hidden when already there | sensible |
| "Custom" disclosure button | `src/components/spending/PeriodSelector.tsx:147-161` | Toggle the from/to panel; aria-expanded + aria-controls wired | sensible |
| Custom From date input | `src/components/spending/PeriodSelector.tsx:174-180` | Pick the window start; max clamped to `to` | sensible |
| Custom To date input | `src/components/spending/PeriodSelector.tsx:182-190` | Pick the window end; min clamped to `from` | sensible |
| Earned StatCard (link) | `src/lib/spending-stat-cards.ts:46-52` | Open `/transactions?category=income&from&to` — exactly the rows summed into `earnedCents` | sensible |
| Refunds StatCard (conditional, link) | `src/lib/spending-stat-cards.ts:62-73` | Only rendered when `refundsCents > 0`; drills to expense-category credits (`flow=in`) | sensible |
| Cash-flow ViewSwitcher — Chart | `src/components/spending/CashFlowView.tsx:88-94`; `spending-view-spec.ts:13` | Stacked composition bars (default) | sensible |
| Cash-flow ViewSwitcher — Sankey | `src/components/spending/CashFlowView.tsx:106-111` | Money-flow diagram for the same period | sensible |
| "Uncategorized" spending segment | `src/components/spending/CashFlowChart.tsx:242-266`; `services/spending.ts:385` | Drill to category-less outflows in that bucket | sensible |
| X-axis tick click | `src/components/spending/CashFlowChart.tsx:352` | Drill to the whole bucket window | sensible |
| X-axis tick keyboard (Enter/Space) | `src/components/spending/CashFlowChart.tsx:349-362` | Keyboard route to a month's ledger from quarter/year views | sensible — correctly gated to month buckets only (`focusable={monthBuckets}`, `:97`) with the reasoning documented at `:95-97`. |
| Bar chart hover tooltip (Earned / Spent / Net / prior-period point) | `src/components/spending/CashFlowChart.tsx:193-225` | Per-bucket readout | sensible |
| "On pace for ~$Y" dotted-underline hover title | `src/components/spending/CashFlowChart.tsx:125-131` | Reveal the projection basis on hover; sr-only copy for AT | sensible — genuinely good: the estimate is marked (~ + dotted underline), the basis is available two ways, and low confidence reads muted and says "(early estimate)". |
| Chart legend swatches | `src/components/spending/CashFlowChart.tsx:293-311` | Name each series and the ghost line | sensible — not interactive; no click-to-isolate/hide a series, which every competitor's stacked chart offers. |
| Graph view hover tooltip | `src/components/spending/CashFlowGraph.tsx:95-125` | Cumulative earned/spent/net through this bucket | sensible |
| Sankey node link (income source, category, hub-leaf) | `src/components/charts/SankeyChart.tsx:219-228`; `services/sankey.ts:113,134,145` | Real `<a href>` to the exact ledger rows; modified clicks keep native behaviour | sensible — "Money in" hub, "Refunds", "From savings" and "Net saved" carry no href (`sankey.ts:102,119,123,151`) and render aria-hidden — correct, but the four biggest labels on the diagram are silently non-interactive. |
| Sankey node hover highlight / dim | `src/components/charts/SankeyChart.tsx:187-201` | Light up the hovered node's ribbons | sensible |
| Heatmap day cell (in-month) → detail sheet | `src/components/spending/SpendHeatmap.tsx:89-91,132-138` | Open the day's total, count, where/who, and net | sensible — strong work: the sheet states the residual ("Everything else", `:265-269`) so a capped breakdown can never read as the whole story. |
| Heatmap padding cell (neighbouring month) → ledger | `src/components/spending/SpendHeatmap.tsx:90` | Skip the sheet (that month was never queried) and go straight to the day's ledger | sensible — deliberate and correct, pinned by `e2e/zz-spending-drilldowns.spec.ts:63-72`. But the two cell types are visually identical apart from faint text — the same gesture produces a sheet or a full navigation with no cue. |
| Heatmap arrow / Home / End roving navigation | `src/components/ui/CalendarGrid.tsx:93-124,174` | 2D keyboard nav with a single tab stop | sensible |
| Day sheet "All transactions for this day →" | `src/components/spending/SpendHeatmap.tsx:276-284` | Escape to the full day ledger | sensible |
| Sheet close (X / Escape / backdrop) | `src/components/ui/Sheet.tsx:22-50` | Native `<dialog>` modal with focus trap and focus return, Esc routed through the KeyScope stack | sensible |
| Largest-purchase row button → sheet | `src/components/spending/LargestPurchases.tsx:38-51` | Open a detail drawer for one of the top 5 outflows | sensible — fixed at 5 (`services/spending.ts:710` `limit = 5`) with no "show more", no sort control, and no threshold option. |
| Category forecast line (sparkles + confidence + basis title) | `src/components/spending/SpendingCategoriesTable.tsx:129-147` | Read-only surfacing of the `/budgets` prediction engine, with visible-math basis in a title AND sr-only | sensible — excellent honesty discipline. Only reachable on the current month (`page.tsx:106-107`), correctly. |
| Honesty card — Uncategorized link | `src/components/spending/HonestyBucketsCard.tsx:25-39` | Never let uncategorized spend vanish; drill to the category-less outflows | sensible — the copy says "categorize to sharpen the report" but the destination is the ledger, off this page. `actions.ts:15-21` documents an inline categorizer "so you can fix categories without leaving the report" that is not wired to any `/spending` surface. |
| Honesty card — Excluded link | `src/components/spending/HonestyBucketsCard.tsx:43-58` | Surface deliberately-excluded rows with a drill to `?view=excluded` | sensible — shows a count but no dollar amount, unlike the Uncategorized row directly above it (`excluded` has no `spentCents` in `services/spending.ts:731`). "12 rows deliberately kept out" doesn't say whether that is $40 or $40,000. |
| Honesty card all-clear state | `src/components/spending/HonestyBucketsCard.tsx:13-20` | Positive confirmation when nothing is outstanding | sensible |
| "tap a category to open its page" hint | `src/app/spending/page.tsx:231` | Teach the categories-table affordance | sensible — the only such hint on the page. The chart bars, the Sankey nodes, the merchant rows and the largest-purchase rows are all interactive with no equivalent cue. |

### Good

1. **The drill-down contract is real and mostly kept** — `cashFlowSegmentHref` (`services/spending.ts:377-390`) and `ledgerHref` (`lib/ledger-href.ts`) mirror the `/transactions` query parser param-for-param, and the Uncategorized aggregate correctly drills with `flow=out` because it is a negatives-only bucket (`:385`). This is the page's best idea and it should be propagated to the two cards that still open unfiltered lists.
2. **The GROSS/NET/refunds split is thought through and documented at the source** — `periodTotals` (`services/spending.ts:73-95`) refuses to let a big statement credit drag Spent negative, and `spendingStatCards` (`lib/spending-stat-cards.ts:62-84`) only renders the Refunds card when refunds exist and then relabels Net as "earned + refunds − spent" so the arithmetic is visible on the row. Protect this.
3. **The projection readout is the most honest estimate UI in the app** — `~` prefix, dotted underline, `cursor-help`, the basis in a `title` AND an sr-only span, and a muted tone plus "(early estimate)" under 0.5 confidence (`CashFlowChart.tsx:116-133`). Every future estimate on any surface should copy this exact pattern.
4. **The day sheet reconciles by construction** — `EntryList` computes `rest = total − shown` and renders an "Everything else" row (`SpendHeatmap.tsx:243-273`) so a top-3 list under an exact total can never read as the whole story — and `e2e/zz-spending-drilldowns.spec.ts:74-91` asserts the sum. Same rule as the chart's "Other".
5. **The heatmap deliberately shares ONE scale across spent and earned bars** (`services/spending.ts:433-435`; `SpendHeatmap.tsx:96-99`) so a small payday can never out-draw the rent, and uses the SIGN rather than colour alone to carry direction (`:106-113`) — a WCAG decision made for the right reason and written down.
6. **The heatmap's unlinked-merchant grouping deliberately reuses `strippedDescriptionKey(normalizeDescription(raw))`** so the day sheet and the Top-merchants card beside it can never disagree about one payee on one page (`services/spending.ts:480-486`). That kind of cross-widget consistency reasoning is what makes the page trustworthy.
7. **The Sankey balances exactly by construction** — `in = earned + refunds + max(−net,0)`, `out = spent + max(net,0)` (`services/sankey.ts:17-21`), with a "From savings" source when the period overspent. It is the only widget on the page whose total is provably the same as the StatCards'.
8. **View state is URL-first and shareable**, resolved URL > persisted > spec default, with only non-defaults written to the URL, and `saveViewPreferenceAction` awaited BEFORE the push so switching back to the default doesn't re-read a stale preference (`hooks/useViewState.ts:45-57`). The reasoning is in a comment; keep it.
9. **The forecast annotation never shows a bare figure** — the basis string rides in a `title` and is repeated sr-only (`SpendingCategoriesTable.tsx:143-146`), and a 0-confidence prediction is dropped rather than shown as noise (`page.tsx:110`).
10. **`heatmapInitialMonth` + the `key={heatMonth}` remount** (`page.tsx:75,220`) correctly keeps the heatmap in step with the period — a real regression that has its own e2e test (`zz-spending-drilldowns.spec.ts:133-141`).

### Bad

1. **[CRITICAL] Clicking a category row silently changes the number you clicked.** On `/spending?period=2026` the categories table shows "Groceries — $14,200". `SpendingCategoriesTable.tsx:105` renders `href={`/categories/${row.categoryId}`}` with no period params. `/categories/[id]` resolves its own period from searchParams and falls back to the current month (`categories/[id]/page.tsx:64-67` → `lib/period.ts:184-185`), so the page opens showing "Spent $980" for July. Same category, same app, a 14× different number, one click apart, with nothing on either screen explaining the switch. The child rows (`:154`) have the identical bug. `e2e/zz-spending-categorize.spec.ts:22` quietly compensates by re-appending `?period=2026` by hand, which is direct evidence the gap is known and untested. — `src/components/spending/SpendingCategoriesTable.tsx:105`
2. **[HIGH] "Where it went" can never be made to add up to the Spent card, and nothing says why.** The Spent StatCard is GROSS (debits only, INCLUDING uncategorized outflows) — `services/spending.ts:73-95`. The "Where it went" table twelve inches below is `categoryBreakdown` (`page.tsx:88`), which is NET (refunds subtract, `analytics.ts:296-310`) and is then filtered to `categoryId !== null` (`page.tsx:124`), dropping uncategorized entirely. Σ table rows = spent − refunds − uncategorized. With a month containing a $400 refund and $900 of uncategorized, a $5,000 Spent headline sits above rows totalling $3,700 with no reconciliation note anywhere. The share bar makes it worse: its denominator (`page.tsx:95-97`) is a THIRD base — positive categorized spends only. The stale comment at `page.tsx:91-94` still calls `cashFlow.totals.spentCents` "the NET total", which it has not been since the refunds split, so the next reader will draw exactly the wrong conclusion. — `src/app/spending/page.tsx:88-97`
3. **[HIGH] Every piece of client state on the page is destroyed by any view-switcher or period click.** `setView` calls `router.push` (`hooks/useViewState.ts:56`), and `src/app/template.tsx` re-mounts its children on every navigation by design. So: page the heatmap to May, then click the "Table" cash-flow pill — the heatmap snaps back to July (`SpendHeatmap.tsx:46` `useState(initial)`). Expand three categories, click "Sankey" — all collapse (`SpendingCategoriesTable.tsx:70`). Open the largest-purchase sheet and the same thing. None of this state is in the URL, so it is neither shareable nor survivable, and the user has no way to know a lens toggle will discard their heatmap navigation. — `src/components/spending/SpendHeatmap.tsx:46`
4. **[HIGH] The Spent card's drill-down is not split-aware, so the list it opens over-counts split rows.** `ledgerHref({category:"spending"})` resolves through `services/transactions-query.ts:58-81`, which matches expense-kind rows by the PARENT `transactions.category_id`. The named-category branch immediately below (`:81-107`) IS split-aware (`NOT EXISTS`/`EXISTS` over `transaction_splits`). A $200 row split 60/40 between Groceries and a Transfers part contributes $120 to the Spent card (`analytics.activeTxnsInRange` explodes splits) but appears at its full $200 in the list the card opens. The page's central promise — "every stat reconciles to a filterable transaction list" (`page.tsx:186`) — fails on the most-clicked card as soon as the owner uses the splitting feature he built in pass 20. — `src/services/transactions-query.ts:58-81`
5. **[HIGH] Graph view renders an empty plot on a Day period.** Select Day granularity (`PeriodSelector.tsx:27`) then the Graph lens. `subBuckets` returns exactly one bucket for a day period (`lib/period.ts:291-296`), so CashFlowGraph builds one row. All four `<Line>` series pass `dot={false}` (`CashFlowGraph.tsx:135,146,154,163`), and a polyline through a single point renders nothing. The `buckets.length === 0` guard at `:69` does not fire. The user sees axes, a grid, a full legend claiming four series, and a blank chart area — no empty state, no explanation. The Chart lens at least draws one bar. — `src/components/spending/CashFlowGraph.tsx:139-165`
6. **[MEDIUM] The heatmap can silently describe a different month than the rest of the page.** `changeMonth` (`SpendHeatmap.tsx:54-61`) loads any month through a server action with no relation to the selected period and no clamping. From `?period=2026-07`, two clicks of the heatmap's › puts September's cells under a card headed "Daily heatmap" while the StatCards, the cash-flow chart, the categories table and the honesty card all still describe July. The card header carries no month; only CalendarGrid's own small `<span aria-live>` label (`CalendarGrid.tsx:131`) does. And because the state is lost on the next navigation, the user cannot even keep the month they navigated to. — `src/components/spending/SpendHeatmap.tsx:54-61`
7. **[MEDIUM] A failed heatmap month load is completely silent.** `loadSpendHeatmap` returns `{ok:false,error}` on an invalid month key or a thrown DB error (`actions.ts:94-101`). `SpendHeatmap.tsx:56-58` does `if (res.ok) setData(res.data)` and then unconditionally `setPending(false)` — the error branch is dropped on the floor. The grid keeps the previous month, the opacity flickers back, and the ‹ › button appears to have done nothing. A month with genuinely no spending and a hard failure are pixel-identical. — `src/components/spending/SpendHeatmap.tsx:56-58`
8. **[MEDIUM] Net and Savings-rate cards are the same link, and neither list sums to its number.** `lib/spending-stat-cards.ts:82` and `:92` both emit `ledgerHref({from, to})` — the entire period ledger including transfers, investment rows, rewards and every excluded-kind category. Clicking "Net −$1,842" opens hundreds of rows that sum to something else entirely, and clicking "Savings rate 12.4%" opens the identical list. Two of five cards are duplicates, and neither honours the reconciliation contract the other three do. — `src/lib/spending-stat-cards.ts:82`
9. **[MEDIUM] Income series are unbounded — no top-N, no "Other" — unlike spending.** Spending series are capped at 7 with an explicit Other bucket (`services/spending.ts:44,226-231`). Income gets no such treatment: `incomeSeries` maps EVERY income subcategory that had a positive row (`services/spending.ts:233-235`). The owner's real DB has Salary, Financial Aid, Family pass-through, Refunds & Reimbursements, Other Income, gambling winnings and more. Every one becomes a stacked bar segment above the axis plus a legend swatch (`CashFlowChart.tsx:293-295`), on a chart whose spending half is deliberately capped at 8. On a phone the legend wraps to four or five lines below a 288px plot. — `src/services/spending.ts:233-235`
10. **[MEDIUM] A negative-net category renders in "Where it went" as a negative spend with a 0% bar.** `categoryBreakdown` is net, so a category whose refunds exceed its purchases in the window (a returned laptop, a reimbursed flight, a reversed charge) yields `spentCents < 0`. `page.tsx:131` clamps the share to `Math.max(0, …)` → 0%, but `SpendingCategoriesTable.tsx:123` renders `<Money cents={row.spentCents}>` with `flow` off, so it prints a bare negative dollar figure under a heading that says "Where it went", with an empty bar and a 0% label. Nothing labels it a net refund. — `src/components/spending/SpendingCategoriesTable.tsx:123`
11. **[MEDIUM] On a month period there is no keyboard route to any chart drill-down.** Bar segments are pointer-only (`onClick` on recharts `<Bar>`, `CashFlowChart.tsx:236,256`) and the X-axis ticks are only made focusable for MONTH buckets (`focusable={monthBuckets}`, `:97,169,349-362`). The default period IS a month, whose buckets are days — so on the page's default state every single chart interaction is mouse-only. The in-code justification ("the heatmap already drills days by keyboard", `:95-96`) covers the axis but not the income and category segments, which have no keyboard equivalent anywhere. — `src/components/spending/CashFlowChart.tsx:97`
12. **[MEDIUM] Sankey ribbon amounts are unreachable without a pointer on `/spending`.** `CashFlowView.tsx:107-111` renders `<SankeyChart>` without `showTableToggle`, so it defaults false (`SankeyChart.tsx:74`) and the internal Flow/Table lens never mounts (`:263`). The only place a ribbon's value exists is the tooltip at `:237-249`, which is explicitly `aria-hidden="true"` and pointer-driven. The surface `cash=table` lens shows the per-bucket cash-flow table — a different dataset — so switching to "Table" while in Sankey mode does not table what you were looking at. The dashboard's Sankey has the ribbon table; `/spending`'s does not. — `src/components/spending/CashFlowView.tsx:107-111`
13. **[MEDIUM] ~10 full transaction scans per render with no loading state.** One `/spending` render runs: `cashFlowByPeriod` (`page.tsx:59`), `spendingProjection` which recursively re-runs `cashFlowByPeriod` on the prior period (`:60` → `services/spending.ts:354`), `spendingSankey` (`:61`), `topMerchants` (`:62`), `honestyBuckets` plus a separate excluded query (`:74`), `dailySpendHeatmap` (`:76`), `categoryBreakdown` twice (`:88,89`), `predictBudgetableCategories` (`:106`), and `largestTransactions` (`:162`) — each an independent full `activeTxnsInRange` or `spendingRowsInRange` pass, several also re-reading the whole categories table via `loadCategoryIndex`. There is no memoization and no `loading.tsx` anywhere in `src/app`, so every ‹ › click, granularity pill and lens toggle blocks on all of it with zero feedback. On the owner's ~20k-row ledger over a hosted free tier this is the page that will feel broken first. — `src/app/spending/page.tsx:59-89`
14. **[MEDIUM] The phone heatmap loses its magnitude signal entirely.** `CellAmount`'s bar is `hidden h-1 rounded-full sm:block` (`SpendHeatmap.tsx:166`) — below 640px there are no bars at all, leaving a 7-column aspect-square grid of 10px `truncate`d figures (`:157`). At 375px each cell is roughly 44px wide inside a card with padding, so "−$1.2k" and "+$3.4k" stacked in one cell clip. The component's own header (`:16-22`) argues at length that a colour wash "says a lot without ever saying how much" — on the device the owner explicitly says he will use, the fix is switched off and the numbers are illegible. — `src/components/spending/SpendHeatmap.tsx:166`
15. **[MEDIUM] The one thing the page tells you to fix, it gives you no way to fix.** The Honesty card says "N transactions — categorize to sharpen the report" (`HonestyBucketsCard.tsx:35-36`) and links away to `/transactions`. `InlineCategorizeList` — a row-level CategoryPicker routed through the shared `runCategoryCorrection` with the smart "apply to all" snackbar and Undo — lives in `src/components/spending/InlineCategorizeList.tsx` and is imported by exactly one consumer: `/categories/[id]` (via `CategoryTxnPanel.tsx`). The loader that feeds it, `loadSpendingCategoryTxns`, is declared in `src/app/spending/actions.ts` under a header comment reading "the Spending page's inline categorizer … so you can fix categories without leaving the report" (`actions.ts:15-21`). Nothing on `/spending` calls it. The comment describes a feature that does not exist on this surface. — `src/app/spending/actions.ts:15-21`
16. **[MEDIUM] Category-page breadcrumb throws away the period on the way back.** After drilling from `?period=2026-Q3` into a category, the breadcrumb's "Spending" link is a bare `<Link href="/spending">` (`categories/[id]/page.tsx:95`). It returns the user to the current month, not the quarter they came from. Combined with the outbound bug, a round trip through a category silently rewrites the period twice. — `src/app/categories/[id]/page.tsx:95`
17. **[LOW] The amber pace reference line is drawn but never named.** `CashFlowChart.tsx:185-192` draws a dashed `var(--warning)` line at `−pace.avgPerBucketCents`. The figcaption legend (`:292-311`) enumerates every income series, every spending series, Net and the prior-period ghost — and omits it. An unexplained amber dashed line runs across the plot on every in-progress period. — `src/components/spending/CashFlowChart.tsx:185-192`
18. **[LOW] Excluded bucket shows a count with no amount.** `honestyBuckets.excluded` carries only `{txnCount, href}` (`services/spending.ts:731,763-766`), so the card renders "12 rows deliberately kept out of spending" (`HonestyBucketsCard.tsx:53-55`) directly under an Uncategorized row that DOES show dollars. The user cannot tell whether the exclusions are immaterial or are hiding five figures. — `src/services/spending.ts:731`
19. **[LOW] The prior period is fully computed for every granularity and then discarded for four of five.** `page.tsx:87-90` always runs `categoryBreakdown` over the previous period and computes `momDeltaCents` for every row, but SpendingCategoriesTable only renders it when `period.granularity === "month"` (`page.tsx:235`). Week-over-week, quarter-over-quarter and year-over-year deltas are calculated at full scan cost and thrown away, and the column is additionally hidden below `md` so the phone never sees it even on a month. — `src/app/spending/page.tsx:89`
20. **[LOW] `hasActivity`'s third clause is unreachable.** `page.tsx:180` ORs in `honesty.uncategorized.txnCount > 0`. But an uncategorized outflow is classified as spending by `spendingBucket` (`analytics.ts:201-203`), so any row that increments `uncatCount` (`services/spending.ts:739`) also increments `spentCents` — making the first clause true. The condition can never be the deciding one, which reads as a bug to the next maintainer. — `src/app/spending/page.tsx:177-180`
21. **[LOW] Custom-range Apply is a silent no-op on bad input, with no busy state.** `applyCustom` (`PeriodSelector.tsx:85-91`) guards `from && to && from <= to` and otherwise returns without navigating and without setting any error. The submit button stays enabled and styled as primary. On a valid submit there is likewise no pending state during the RSC round-trip. — `src/components/spending/PeriodSelector.tsx:85-91`

### Change

1. **Carry the period on every `/categories` link, and back again** (S) — Thread the resolved period into SpendingCategoriesTable as a `periodQuery` prop built from the same `baseParams` object `page.tsx:71-73` already computes for CashFlowView, and append it to both the parent (`SpendingCategoriesTable.tsx:105`) and child (`:154`) hrefs. Mirror it on the return trip: `categories/[id]/page.tsx:95` should render `/spending?${periodParams}` from its own resolved period. Then delete the manual `?period=2026` workaround in `e2e/zz-spending-categorize.spec.ts:22` and let the spec assert the period survives the round trip.
2. **State the GROSS/NET/uncategorized reconciliation on the "Where it went" card** (S) — Add a footer row under SpendingCategoriesTable, computed server-side in `page.tsx`, that closes the loop in words and numbers: "These rows total $3,700 (net of $400 refunds). The Spent card is $5,000 gross and also includes $900 uncategorized." Every component of that sentence is already on the page (`cashFlow.totals.spentCents`, `.refundsCents`, `honesty.uncategorized.spentCents`, and the row sum) — it just is not assembled anywhere. While there, fix the stale comment at `page.tsx:91-94` that still calls the gross total "the NET total", and label the share column "% of categorized spend" so its third denominator is honest.
3. **Make the split-aware category predicate the one used by the Spent/Earned cards** (M) — `services/transactions-query.ts:58-81`'s `spending`/`income` branch should reuse the same `NOT EXISTS`/`EXISTS transaction_splits` shape as the named-category branch at `:81-107`, matching split PARTS by their category's top-level kind. Add a unit test in `transactions-query.test.ts` that a 60/40 Groceries/Transfers split appears in `category=spending&flow=out` only when the expense part matches, and that `spendingStatCards`' Spent number equals the row-count sum of what its href returns.
4. **Give the Graph lens a real single-point rendering** (S) — `CashFlowGraph.tsx` should render dots when `rows.length < 2` (swap `dot={false}` for `dot={rows.length < 2}`) so a one-bucket period draws four visible points instead of a blank plot, and add an explicit note when the period has a single bucket ("one day — use the Chart lens for composition"). Same guard belongs in CashFlowChart for symmetry.
5. **Lift the heatmap month and the expanded-category set into the URL** (M) — `?heat=2026-05` and `?open=<catId>,<catId>` resolved in `page.tsx` alongside `period` would survive the template remount that a lens or period click causes, make a specific view shareable, and let Back work. This also removes the `key={heatMonth}` remount hack at `page.tsx:220`. Additionally clamp or badge the heatmap when its month falls outside the selected period — a small "outside Q3 2026" chip on the card header is enough.
6. **Surface heatmap load failures and the view-switcher's pending state** (S) — `SpendHeatmap.tsx:56-58` should route `!res.ok` through the existing toast store rather than dropping it. `CashFlowView.tsx:37` should destructure `isPending` from `useViewState` and pass it to `<ViewSwitcher disabled={isPending}>` — the prop already exists (`ui/ViewSwitcher.tsx:20,33`) and is unused. Add a `src/app/spending/loading.tsx` skeleton so the ~10-scan render stops feeling like a dead click, and an `error.tsx` so a `readSettings` parse failure degrades to a message instead of Next's default screen.
7. **Give the Spent card's siblings honest destinations** (M) — Net should drill to a list that actually sums to it — the union of the income and spending predicates (`?category=cashflow` or, minimally, reuse the Spent+Earned filters). Savings rate should not duplicate Net's href; point it at a savings-rate history view (see ADD) or at least at the Earned list, and say in the delta line which numerator/denominator produced it.
8. **Cap and bucket income series the way spending is capped** (S) — `services/spending.ts:233-235` should apply the same `TOP_SPENDING_SERIES` treatment as `:226-231` — top N income subcategories plus an "Other income" aggregate — so the chart legend and the stacked bars stay readable on a phone with the owner's seven-plus income buckets.
9. **Make the ribbon numbers reachable on `/spending`'s Sankey** (S) — Pass `showTableToggle` when the cash lens is `sankey` (`CashFlowView.tsx:107-111`), or better: make the surface `cash=table` lens render the Sankey's flow table when the previously-active lens was sankey. Today "Table" changes the dataset rather than the representation, which breaks the one-dataset-several-lenses promise in `spending-view-spec.ts:10-13`.
10. **Label the amber pace line and the $0 upcoming rows** (S) — Add a legend entry in CashFlowChart's figcaption (`:292-311`) for the pace ReferenceLine naming its value ("typical $X/day so far"). In `page.tsx:142-159`, give the upcoming rows a section divider and an "Expected next month" heading so a $0/0% row is never mistaken for a real zero-spend category.
11. **Add the amount to the Excluded honesty bucket** (S) — `services/spending.ts:744-754` already scans the excluded rows; sum their outflow into `excluded.spentCents` and render it in `HonestyBucketsCard.tsx:53-57` the same way Uncategorized does. "12 rows, $3,410 kept out of spending" is actionable; "12 rows" is not.
12. **Show the transaction count per category row** (S) — `categoryBreakdown` already returns `txnCount` per top-level and per child (`analytics.ts:294-309`) and `page.tsx:123-135` discards it. Render it beside the amount ("Groceries · 41 txns"). It is free, and it is the first thing that tells the owner whether a big category is one bad row or a habit.
13. **Point the Top-merchants card at the merchant entity** (S) — For `kind === "merchant"` rows, add a secondary link (or make the icon a link) to `/merchants/[id]` alongside the existing ledger drill (`TopMerchantsCard.tsx:21-42`) — that page is where the default category and aliases live, and this card is the only place on `/spending` that names merchants. Also make the day sheet's "Who it went to" / "Where it went" entries links (`SpendHeatmap.tsx:258-264`) using the same hrefs.
14. **Show the MoM delta at every granularity and on mobile** (S) — `page.tsx:89` already pays for the prior-period breakdown unconditionally. Drop the `showDelta={period.granularity === "month"}` gate (`page.tsx:235`) in favour of a granularity-aware label ("vs Q2 2026", "vs 2025"), and replace the `hidden md:block` on `SpendingCategoriesTable.tsx:119` with a compact inline delta under the category name at small widths.
15. **Bound the period pager and make the empty state a way forward** (S) — Disable › (or render it inert with a tooltip) once the next period starts after the newest transaction in the DB, and give the EmptyState (`page.tsx:193-197`) a "Go to July 2026 — your most recent activity" link computed from `max(posted_on)`. Today the only escape from an empty future period is browser Back.
16. **Memoize the per-request row scan** (M) — Introduce a request-scoped cache (React `cache()` around `activeTxnsInRange(db, from, to)` and `loadCategoryIndex(db)`) so the 10 aggregates in `page.tsx:59-162` share one pass over the window instead of ten. This is the single highest-leverage change before hosting, and it is behaviour-preserving.

### Add

1. **Inline categorize, on the surface that tells you to categorize** (M) — Wire the already-built `InlineCategorizeList` + `loadSpendingCategoryTxns` into `/spending`, in three places: (1) the Honesty card's Uncategorized row expands in place into the capped list with its CategoryPicker instead of navigating away; (2) each category row's expand chevron gains a second tab — "Subcategories" / "Transactions" — showing the rows behind that number; (3) the largest-purchase sheet gets a CategoryPicker on its Category row. All three route through `runCategoryCorrection`, so the "apply to all N with this name" snackbar and Undo come for free. *Why:* This is the page's single biggest miss: the machinery exists in `src/components/spending/InlineCategorizeList.tsx`, the loader is documented as "the Spending page's inline categorizer" in `src/app/spending/actions.ts:15-21`, and neither is reachable from `/spending`. The owner's whole pass-24 workflow was categorization; the report that shows him what is wrong should be where he fixes it. Every competitor (Copilot, Monarch, Lunch Money) recategorizes from the report.
2. **"Where it came from" — an income table matching "Where it went"** (M) — A sibling SurfaceCard listing income subcategories for the period with amount, share, txn count, MoM delta, and a link to the category page — fed by `incomeByMonth`/an income variant of `categoryBreakdown` (`analytics.ts:329-345` already has the shape). Add a "Top payers" card mirroring TopMerchantsCard for income sources. *Why:* The page header promises "Income and spending on one surface" (`page.tsx:186`) but income gets exactly one stat card and some unbounded bar segments — no table, no ranking, no delta, no forecast, no drill. For someone whose income is a cash job plus family pass-through plus financial aid plus gambling winnings, "is my income mix changing" is a first-order question the page cannot answer.
3. **Compare mode — this period vs any other, side by side** (L) — A "Compare" control next to the period selector that adds `?vs=2026-06` (or `vs=lastyear`) and re-renders the StatCards, the categories table and the merchants card with a second column and a delta column. The prior-period machinery is already there: `spendingProjection` computes the prior window's full cash flow (`services/spending.ts:353-366`) and `page.tsx:87-90` computes the prior breakdown — both are currently reduced to a single ghost line and a hidden MoM column. *Why:* The pissed-off-investor question is never "what did I spend" — it is "what changed, and why". Right now the answer requires opening two browser tabs and doing arithmetic. Monarch, Copilot and YNAB all lead with period comparison. Two thirds of the data plumbing is already paid for.
4. **Spending trends over time — the 12-month view `/spending` does not have** (M) — A trend card (or a `cash=trend` lens) showing this period's top categories as multi-month lines/small multiples, plus a savings-rate sparkline. `analytics.monthlySpending` and `categoryTrends` already exist and are already used by `/categories/[id]` (via `MonthlyTrendBars`, which is in `src/components/spending/` but never rendered on `/spending`). *Why:* Every number on this page is a single-period snapshot. There is no way to ask "has Groceries been creeping up for six months" without visiting twelve category pages one at a time. `MonthlyTrendBars.tsx` sits in the spending component directory unused by the spending page — the component is literally already written.
5. **Chart focus / expand, matching every other chart surface** (S) — Wrap CashFlowView's renderer in the shared `components/charts/ChartFocus` so the chart, graph and Sankey can open in a full-viewport dialog with the view-transition morph, exactly as `/accounts/[id]`, `/investments`, the holding page and the dashboard already do. *Why:* The owner wants ambitious visualization on a monitor, and `/spending` is the one analytical surface with no expand. The Sankey in particular is unreadable at 22rem with a dozen categories; the dashboard's identical Sankey gets focus mode because it lives inside ChartFocus and `/spending`'s does not. The component exists and is proven by `e2e/zz-zz-chart-focus.spec.ts`.
6. **Recurring vs discretionary framing** (M) — A card (or a toggle on the Spent card) splitting the period's gross spend into "committed" (rows with a `recurring_series_id`, via the detected/confirmed series) and "discretionary" (everything else), with each side drilling to its rows. `forecast.ts:135` and `budgets.ts` already separate fixed from variable components for the forecast engine. *Why:* "How much of my spending is actually controllable" is the question that turns a report into a decision. The app already computes exactly this split for its forecasts and never shows it as an actual. Copilot's "recurring vs variable" and YNAB's "true expenses" are both built on this framing.
7. **An anomaly / "what changed" strip at the top of the report** (L) — A short server-computed list under the StatCards: categories more than ~2σ (or a simple 50%) above their trailing-3-month mean, first-time merchants over a threshold, a recurring charge whose amount stepped up, and any single transaction above the period's 95th percentile. Every input exists — `categoryTrends`, `topMerchants`, the recurring series with `amountCents` history, `largestTransactions`. *Why:* The page currently makes the owner scan seven widgets to find the one thing worth knowing. This is the highest-value thing an AI-adjacent finance app can do and the clearest differentiator versus a spreadsheet. Rank first among adds after inline categorization because it converts a data dump into a product.
8. **Account and flow filters on the whole report** (M) — An account multi-select (and a "cash only / cards only" toggle) in the period bar that adds `?account=` and scopes every aggregate on the page, mirroring what `/transactions` already supports (`ledgerHref` carries `account`, `lib/ledger-href.ts:16`). *Why:* The owner has a checking account, savings, multiple cards, a Robinhood Cash settlement ledger and family pass-through money. "What did I spend on the Venture X this month" is unanswerable on `/spending` today — he has to go to the ledger and lose every chart. The param plumbing already exists on the ledger side.
9. **Budget status inline on the categories table** (S) — For each category with a budget, render the budgeted amount and a progress bar beside the actual (the forecast sub-line's slot is already there). `categoryBudgetRef` exists and is used by `/categories/[id]`. *Why:* The forecast line already says "August 2026 ≈ $412" but the page never says what he decided to spend. He created nine real budgets in pass 16; the spending report is where over/under should be confronted, not on a separate `/budgets` tab.
10. **Export the period** (S) — A "Download CSV" affordance on the report (period rows, or the categories table) plus a copy-as-markdown for the summary. *Why:* Every finance product ships this, and it is the cheapest possible answer to "I want to do my own arithmetic". The data is already fully materialized server-side.
11. **Savings-rate history** (S) — Make the Savings-rate card open a small trend of the rate over the last 12 periods rather than duplicating Net's href. *Why:* A single-period savings rate is meaningless in isolation — 12% is either a triumph or a collapse depending on the last six months. Today the card is the only stat on the page with no distinct destination.
12. **Per-day and per-week burn readout** (S) — Under the pace line, state "$X/day so far · $Y/day needed to match last month" — the `avgPerBucketCents` value that the unlabelled amber reference line already draws. *Why:* It turns an unexplained dashed line into the one number that changes behaviour mid-month, and it requires no new computation (`services/spending.ts:283` already produces it).

---

## `/accounts` — the account registry

(`src/app/accounts/page.tsx` + `src/components/accounts/**`, plus its drill-down `/accounts/[id]`)

**Purpose** — This is the owner's registry of every place his money sits, and the one screen that answers "what accounts exist, what is in each, and are they configured correctly". It is where the statement-import world gets its structure: institutions, account type (which decides liability math and which derivation engine runs), last-4 (which the parsers match on), the credit-card→funding-account link that the transfer detector uses as structural pairing evidence, display order, and archive state. It is also the only door into the cash economy the statements never see — cash wallets, the only accounts where a hand-typed transaction is legal. Every other surface in the app (net worth, spending, budgets, recurring, investments) is derived from rows defined here, so a mistake on this page silently poisons all of them.

**Connections** — READS: `institutionGroups` (`src/services/institution-groups.ts:92`) joins accounts+institutions, scans all of `daily_balances`, joins `holdings` for the "8 positions · MSFT SPY…" summary, and `unreviewedByAccount` (`src/services/review-count.ts:20`) for the blue dot; `listAccounts` (`src/services/accounts.ts:66`) → `latestBalances`; `listCashWallets` (`src/services/cash-wallets.ts:61`) → `listAccounts` again + `isCashWallet` per account; the whole `categories` table for the cash-transaction picker (`page.tsx:33`). WRITES: `accounts.displayOrder` (`reorderAccountsAction` → `accounts.ts:267`), name/institutionId/last4/type/subtype/paymentSourceAccountId (`editAccountAction` → `accounts.ts:168`, which runs `rebuildAccount` inside a transaction on a type/subtype flip), institutions (`createInstitutionAction`), and via cash wallets `balance_anchors` (the seeded $0 opening anchor, `cash-wallets.ts:56`) and `transactions` (`addManualTransactionAction`). LINKS OUT: every account row → `/accounts/[id]`; the detail page → `/transactions?account=<id>` and `/investments/<assetType>/<symbol>` (`AccountHoldingsTable.tsx:117`). LINKS IN: dashboard "Manage →" (`src/app/page.tsx:240`) and the ⌘K palette's Accounts group (`src/services/command-index.ts:33-36`), which is the ONLY path to a cash wallet's detail page. SHARED MODEL, DIFFERENT UI: the dashboard renders the exact same `institutionGroups` output through `InstitutionCard` (`src/app/page.tsx:247`), a collapsible card that shows MORE (account count, "as of" date, group day change, always-visible sparkline) than the `/accounts` list does. Every mutation revalidates "/" and "/accounts"; `paymentSourceAccountId` feeds `detectTransfers`' auto-pair evidence; archiving removes the account from `netWorthSeries` (`src/services/derivation.ts:284-289`).

### Interactive inventory

| element | file:line | intended | verdict |
|---|---|---|---|
| Drag grip (draggable span, aria-hidden) | `src/components/accounts/ManagedAccounts.tsx:99-107` | Pointer-drag an account to a new position within its institution | **broken** — HTML5 drag-and-drop never fires on touch, and `touch-none` (line 104) additionally kills scroll on that element — so on the phone the owner says he uses, this control is pure dead weight that eats ~24px of a 375px row. There is also no drop indicator, no drag-over highlight, and no cross-institution drop feedback (dragover only preventDefaults for the same institution, line 87). |
| Edit sheet — Institution select | `src/components/accounts/EditAccountSheet.tsx:128-136` | Re-home the account to another institution | **broken** — The option list is `listInstitutions` (`page.tsx:26`), which includes the 'Cash' institution the moment the first wallet exists. Selecting it makes the account disappear from `/accounts` entirely: `page.tsx:25` drops the whole Cash group from ManagedAccounts, and `page.tsx:28` only lists it if `isCashWallet` passes (`manual-transactions.ts:63-97`), which returns false for any account with a statement period, an import anchor, or an imported transaction. The account is not archived, still counts in net worth, and is rendered nowhere. |
| Add an account — Institution select | `src/components/accounts/AccountForm.tsx:17-25` | Pick the institution for the new account | **broken** — Includes the 'Cash' institution once any wallet exists. Creating an account there goes through `createAccount` (`actions.ts:44-50`), which does NOT seed the $0 opening anchor that `createCashWallet` (`cash-wallets.ts:56`) documents as load-bearing — so the wallet shows 'no balance yet' forever and its first manual transaction derives nothing. This is exactly the bug the anchor comment says it closes. |
| Add an account — Current balance input | `src/components/accounts/AccountForm.tsx:49-58` | Optionally seed a manual anchor at today's date | **broken** — A plain text input with no type, pattern or client validation, fed straight into `parseAmountToCents` (`actions.ts:57`), which throws `MoneyParseError` (`money.ts:33`). There is no `error.tsx` anywhere under `src/app` (verified: zero loading/error/not-found files), so typing 'about 5k' returns a raw Next.js error page and destroys every other field in the form. |
| Detail page — 'Record a balance' anchor form | `src/components/accounts/AnchorForm.tsx:14-29` | Add a manual chain-grade anchor at a chosen date | **broken** — Same unguarded money field as the create form: `name="balance"` is plain text fed to `parseAmountToCents` (`actions.ts:77`) with no `error.tsx` to catch the throw. A typo here loses the form and shows a stack-trace page — on the control that writes ground truth into the balance chain. |
| Detail page — 'remove' anchor button | `src/app/accounts/[id]/page.tsx:244-256` | Delete a manual or live anchor | **broken** — A destructive write with no confirmation, no toast, and no undo. Deleting a chain-grade `manual` anchor re-derives the account's entire curve (it is a replay endpoint, `derivation.ts:30`) and can flip whole spans from `derived` to `gap`, silently changing net worth. The affordance is 10px grey text labelled 'remove'. |
| Detail page — 'Archive account' / 'Restore account' submit | `src/app/accounts/[id]/page.tsx:269-278` | Deactivate or reactivate the account | **broken** — No confirmation, no toast, no undo, and the actual consequence is undisclosed: `netWorthSeries` filters `isActive` (`derivation.ts:284-289`), so archiving an account with a live balance instantly drops net worth by that amount everywhere in the app. On the owner's data, archiving Robinhood Brokerage would remove $61,612.65 with one click on a 12px grey link. |
| Per-account sparkline | `src/components/accounts/ManagedAccounts.tsx:152-158` | Show 30 points of balance shape next to the figure | **missing-state** — `hidden sm:block` removes it entirely below 640px — so the phone view of the ACCOUNTS page has no trend at all, while the dashboard's `InstitutionCard.tsx:62-67` shows the same sparkline at every width. It is also aria-hidden with no tooltip, no scrub, and no click-through to the balance chart, so on desktop it is decoration you cannot interrogate. |
| Balance figure | `src/components/accounts/ManagedAccounts.tsx:160-167` | Print the account's latest known balance | **missing-state** — Rendered with no date and no basis. On the owner's live DB right now (today = 2026-07-27) Chase Checking prints $1,106.69 from a row dated 2026-07-10 whose basis is `derived_unverified` — the engine's own word for 'estimated'. Both `asOf` and `basis` are computed and available (`institution-groups.ts:169-170`, `derivation.ts:378-383`) and thrown away. The dashboard shows 'as of' (`InstitutionCard.tsx:111`) and the detail page names the basis in words (`[id]/page.tsx:154-156`); this page, the canonical one, is the least honest of the three. |
| 'no balance' fallback text | `src/components/accounts/ManagedAccounts.tsx:166` | State that the account has no derived balance yet | **missing-state** — Says nothing about why or what to do, and the institution header silently counts that account as 0 in its total (`institution-groups.ts:207`) with no disclosure — the header reads as a complete figure when it is not. |
| Add-transaction sheet — Date input | `src/components/accounts/CashWallets.tsx:271-273` | Date the transaction | **missing-state** — No bound: a date before the wallet's opening anchor is accepted, lands outside the derived span, and moves no balance — with no error and no explanation. |
| Institution section header (name + combined total) | `src/components/accounts/ManagedAccounts.tsx:73-76` | Name the institution and print the combined balance of its accounts | **dead-end** — Not interactive at all: cannot collapse, cannot click through to a filtered ledger, no account count, no 'as of' date, no day change, no sparkline — all of which the dashboard's InstitutionCard shows for the same group (`InstitutionCard.tsx:107-125`). It is also the sign-clash point: for Capital One this renders −$11,020.45 while the single row 3cm below renders $11,020.45. |
| Unreviewed blue dot | `src/components/accounts/ManagedAccounts.tsx:143-148` | Signal that this account has transactions awaiting review | **dead-end** — Two problems. (1) `aria-label` on a bare `<span>` with no role is prohibited on the generic role and is dropped by most screen readers, so the count is announced to nobody. (2) It is not its own link — the whole row goes to `/accounts/[id]`, which has no review filter. `/transactions?view=review&account=<id>` is a valid deep link (`services/transactions-query.ts:34-52` + `components/transactions/query.ts:53-62`) and nothing points at it. |
| Cash wallet row (name + balance) | `src/components/accounts/CashWallets.tsx:65-72` | Show each manual wallet and its derived balance | **dead-end** — The name is plain text — not the `InlineEditableText` primitive the app uses for account, category, merchant and series names (`AccountNameHeading.tsx:26-36`) — there is no pencil, no link to `/accounts/[id]`, no ledger, no archive. A wallet created with a typo can only be reached through the ⌘K palette (`command-index.ts:33-36`), which the shell renders with no visible trigger and is therefore unreachable on a phone. There is also no 'as of' and no basis on the balance even though `listCashWallets` returns both (`page.tsx:28-32` discards them). |
| Move up button (chevron) | `src/components/accounts/ManagedAccounts.tsx:114-122` | Move this account one position up within its institution | **confusing** — The button has no padding or size class — the hit target is exactly the 3.5-unit icon, ~14×14 CSS px, below the 24×24 WCAG 2.5.8 minimum and unusable with a thumb. There is also no optimistic update and no pending state (`commitOrder` → server → `router.refresh`, lines 47-55), so a second click within the round-trip re-applies the SAME index transform against a stale list and silently loses one move. |
| Move down button (chevron) | `src/components/accounts/ManagedAccounts.tsx:123-131` | Move this account one position down within its institution | **confusing** — Same 14×14 target and same double-click race as Move up. |
| Day-change figure under the balance | `src/components/accounts/ManagedAccounts.tsx:168-174` | Show the most recent day-over-day move | **confusing** — A bare signed number with NO label at all. It is `dayChangeOf(series)` = last two non-gap points (`institution-groups.ts:73-78`), which are not necessarily adjacent days and are not necessarily recent: Chase Checking's −$14.21 is the 07-09→07-10 delta, displayed on 07-27. The dashboard sibling labels the identical value 'today' (`InstitutionCard.tsx:28`) — an outright false claim whenever coverage lags. |
| Archived accounts list item → `/accounts/[id]` | `src/app/accounts/page.tsx:50-60` | Reach an archived account to restore it | **confusing** — Shows name + institution and nothing else — no balance, no type, no archived-on date, and no Restore control in place. Restoring means clicking through and finding a 12px text button at the very bottom of the detail page (`[id]/page.tsx:269-278`). The section is also invisible when empty, so a user who just archived something has no obvious 'undo' target. |
| New wallet — opening date input | `src/components/accounts/CashWallets.tsx:163-165` | Set the day balances start deriving from | **confusing** — No explanation of consequence. The service anchors $0 at openingOn−1 (`cash-wallets.ts:50-56`) and derivation never replays the anchor day's own sum — pick a date after your first cash spend and that spend is silently outside the wallet's history. Nothing on screen says so. |
| Add-transaction sheet — Amount input | `src/components/accounts/CashWallets.tsx:250-262` | Enter the cash amount in dollars | **confusing** — `Math.round(Number(amount)*100)` (line 201) accepts scientific notation — '1e5' silently becomes $100,000.00 — while the rest of the app parses money through `parseAmountToCents` (`money.ts:21`), which is string math and rejects it. Two money-parsing conventions in one app. |
| Add-transaction sheet — CategoryPicker | `src/components/accounts/CashWallets.tsx:279-284` | Assign a category via the searchable popover | **confusing** — One-way. `onPick` only ever emits an id (`CategoryPicker.tsx:27`), so once you pick a category in this sheet you cannot clear it back to null — there is no 'no category' option and no clear affordance. |
| Add an account — Investment kind select (conditional) | `src/components/accounts/AccountForm.tsx:37-43` | Brokerage vs Crypto for investment accounts | **confusing** — Swapping this field IN swaps the last-4 field OUT (lines 37-48), so an investment account can never be given a last-4 at creation — even though the owner's real Robinhood Brokerage and Robinhood Crypto both have one (3525 / 8474) and the edit sheet allows it. You must create, then immediately edit. |
| Add an account — last-4 input (conditional) | `src/components/accounts/AccountForm.tsx:44-48` | Masked digits for statement matching | **confusing** — `pattern` with no `title` produces a generic browser message, and if the pattern is somehow bypassed the server silently discards the value (`actions.ts:49`) instead of erroring like the edit path does (`actions.ts:134-136`). |
| Add an account — submit button | `src/components/accounts/AccountForm.tsx:59-66` | Create the account and redirect to its detail page | **confusing** — Bare `<button>` with no pending state, no spinner, no disabled-on-submit — and it uses hand-rolled classes instead of the shared `<Button>` primitive used everywhere else on this page. The redirect (`actions.ts:63`) also bounces the owner off `/accounts`, so adding two accounts in a row means navigating back each time. |
| Add institution — Add button | `src/components/accounts/AddInstitution.tsx:49-51` | Find-or-create the institution, toast, refresh | **confusing** — `pending` comes from `useTransition` (line 4), which is only started AFTER the action resolves (line 30) — so the spinner never covers the actual server call. A duplicate name silently no-ops but still toasts 'Added X' (line 28), telling the owner he created something he did not. |
| Edit sheet — Payment source select (credit only) | `src/components/accounts/EditAccountSheet.tsx:164-178` | Link the card to its funding checking/savings account so payments auto-pair | **undiscoverable** — This is the single highest-leverage control on the page — it is structural evidence for the transfer detector — and it appears only after you open a sheet, pick 'Credit card', and scroll. Nothing on the row, and nothing in the page description (`page.tsx:39`), tells the owner this link exists or which of his three cards is missing it. `fundingCandidates` is also built from `groups.flatMap` (`ManagedAccounts.tsx:204-207`), which excludes cash wallets and archived accounts. |
| Account row link → `/accounts/[id]` | `src/components/accounts/ManagedAccounts.tsx:134-176` | Open the account detail page (balance chart, holdings, recent transactions, anchors) | sensible |
| Edit pencil (IconButton) | `src/components/accounts/ManagedAccounts.tsx:178-192` | Open the edit-account sheet for this row | sensible |
| Edit sheet — Account name input (Enter saves) | `src/components/accounts/EditAccountSheet.tsx:118-127` | Rename the account | sensible |
| Edit sheet — Last 4 input | `src/components/accounts/EditAccountSheet.tsx:137-146` | Set or clear the masked account digits | sensible — validated server-side with a real message (`actions.ts:134-136`); note the create form silently discards a bad value instead (`actions.ts:49`). |
| Edit sheet — Type select | `src/components/accounts/EditAccountSheet.tsx:147-163` | Change checking/savings/credit/investment; re-derives the balance curve | sensible |
| Edit sheet — Subtype select (investment only) | `src/components/accounts/EditAccountSheet.tsx:179-196` | Brokerage vs Crypto; re-derives the curve | sensible |
| Edit sheet — 're-derive the balance history' confirm checkbox | `src/components/accounts/EditAccountSheet.tsx:197-215` | Gate a semantics change behind an explicit acknowledgement, announced via a persistent live region | sensible |
| Edit sheet — Cancel button | `src/components/accounts/EditAccountSheet.tsx:108-110` | Close without saving | sensible |
| Edit sheet — Save changes button | `src/components/accounts/EditAccountSheet.tsx:111-113` | Persist the edit, toast, refresh | sensible — no dirty-state check; Save on an untouched sheet fires a full write + revalidate of three routes. |
| Edit sheet — Escape / backdrop click / native close button | `src/components/ui/Sheet.tsx:50-53, 79-86` | Dismiss the sheet via KeyScope-routed Escape or a full backdrop gesture | sensible — no unsaved-changes guard: type a new name, press Escape, the edit is gone with no prompt. |
| 'Add transaction' button per wallet | `src/components/accounts/CashWallets.tsx:73-81` | Open the manual-transaction sheet for this wallet | sensible |
| 'New cash wallet' button | `src/components/accounts/CashWallets.tsx:103-105` | Reveal the inline create-wallet form | sensible |
| New wallet — name input | `src/components/accounts/CashWallets.tsx:160-162` | Name the wallet | sensible |
| New wallet — Create button | `src/components/accounts/CashWallets.tsx:166-168` | Create the wallet with its seeded opening anchor | sensible |
| New wallet — Cancel button | `src/components/accounts/CashWallets.tsx:169-171` | Abandon creation, restore focus to the trigger | sensible |
| Add-transaction sheet — Direction select (Spent/Received) | `src/components/accounts/CashWallets.tsx:263-268` | Choose the sign of the amount | sensible |
| Add-transaction sheet — Description input | `src/components/accounts/CashWallets.tsx:275-277` | Describe the transaction (required) | sensible |
| Add-transaction sheet — Note input | `src/components/accounts/CashWallets.tsx:286-288` | Optional free-text note | sensible |
| Add-transaction sheet — Cancel / Add transaction buttons | `src/components/accounts/CashWallets.tsx:231-238` | Dismiss or submit the manual row | sensible — submit closes the sheet immediately; there is no 'add another' and no way to see or delete what you just entered from this page. |
| Add an account — Account name input | `src/components/accounts/AccountForm.tsx:26-28` | Name the account | sensible |
| Add an account — Type select | `src/components/accounts/AccountForm.tsx:29-36` | Pick checking/savings/credit/investment | sensible |
| Add institution — name input (Enter submits) | `src/components/accounts/AddInstitution.tsx:36-48` | Type a new institution name | sensible |
| Detail page — inline-editable account name | `src/components/accounts/AccountNameHeading.tsx:26-36` | Rename in place with optimistic update, toast and Undo | sensible — covered end-to-end by `e2e/zz-account-rename.spec.ts`. This primitive is conspicuously absent from the `/accounts` list rows and from every cash-wallet row. |
| Detail page — 'Edit account' pill | `src/components/accounts/EditAccountButton.tsx:22-28` | Open the same edit sheet from the detail page | sensible |
| Detail page — balance chart lens switcher (chart⇄table) | `src/components/accounts/BalanceChartPanel.tsx:176-186` | Swap the balance chart for a dated table with a Basis column | sensible |
| Detail page — chart focus/expand + scrub + drag-zoom + range pills | `src/components/accounts/BalanceChartPanel.tsx:170-215` | Inspect any day's balance and its basis in words | sensible — the range pill is held in ChartFocus's local useState, so it is neither in the URL nor persisted; a shared `/accounts/<id>` link always opens at 3M. |
| Detail page — holdings table sort headers + row → `/investments/<type>/<symbol>` | `src/components/accounts/AccountHoldingsTable.tsx:110-119` | Sort by symbol/day/value/alloc and drill into a holding | sensible |
| Detail page — 'All transactions →' link | `src/app/accounts/[id]/page.tsx:201-206` | Open the ledger filtered to this account | sensible |
| Detail page — '← All accounts' link | `src/app/accounts/[id]/page.tsx:266-268` | Return to the registry | sensible — duplicates the Breadcrumbs at the top (`[id]/page.tsx:113-116`); harmless, but it sits next to the archive button, which is the riskiest control on the page. |

### Good

1. **The reorder buttons use `aria-disabled` rather than `disabled` at the list boundaries**, with a comment explaining that disabling the focused element drops focus to `<body>`, and `move()` independently no-ops out-of-range targets (`ManagedAccounts.tsx:109-131`). This is the kind of detail almost nobody gets right — propagate the pattern to every other boundary control in the app.
2. **Type/subtype changes are gated properly** — a persistent `aria-live="polite"` region (never conditionally mounted, so the warning is actually announced), a plain-English explanation that nothing is deleted, and a confirm checkbox that resets on every new target so a stale tick can never carry across a flip-and-flip-back (`EditAccountSheet.tsx:150-155, 182-186, 197-215`). The server re-checks the same gate independently (`actions.ts:138-147`).
3. **`editAccount` refuses to change an investment account's type when `holding_events` exist**, because the anchor path has nothing to replay and the holdings-derived curve would be lost (`accounts.ts:208-219`). This is the only schema-level edit block in the app and it exists to protect a derived cache — exactly right.
4. **The combined institution sparkline only uses days where EVERY account in the group is covered** (`institution-groups.ts:196-205`), so a missing account cannot masquerade as a balance drop. Same honesty instinct as `netWorthSeries`.
5. **`shortNameOf` strips a leading institution prefix** (`institution-groups.ts:65-71`) so rows read "Brokerage" under a "Robinhood" header instead of "Robinhood Brokerage" — small, and it is why the row still fits on a phone.
6. **Cash wallets are defined by DATA, not a schema flag**, and `isCashWallet` requires the institution marker specifically so a freshly-created, not-yet-imported real bank account can never be mistaken for a wallet and accept a manual row (`manual-transactions.ts:53-97`). The reasoning is written down at the definition.
7. **The $0 opening anchor is dated openingOn−1** with a comment explaining that derivation never adds the anchor day's own transaction sum, so an anchor ON the opening day would drop a same-day first transaction (`cash-wallets.ts:50-56`). That is a real bug caught and documented at the fix site.
8. **`reorderAccounts` ignores unknown ids** so a stale drag can never renumber an account the caller did not mean to touch (`accounts.ts:267-275`).
9. **The edit sheet guards against double-submit** with a single in-flight flag before any async work, so Enter-in-the-name-field and a Save click cannot both fire (`EditAccountSheet.tsx:74`).
10. **The new-wallet form explicitly restores focus to its trigger on close**, with a comment noting it is a region and not a dialog so there is no native focus restoration (`CashWallets.tsx:42-49`).
11. **`createInstitution` is find-or-create** so a duplicate name is a no-op rather than an error (`accounts.ts:249-258`).
12. **The account DETAIL page's balance header is a model of honesty** — owed-frame for liabilities, day and 30-day change chips whose color inverts correctly for debt (more debt = red), and the basis printed in words next to the as-of date (`[id]/page.tsx:55-65, 143-157`). The table lens carries a Basis column for exactly the same reason (`BalanceChartPanel.tsx:152-170`). This is the standard the index page should be held to.
13. **The cash-transaction sheet validates on CENTS rather than the dollar string**, with a comment noting sub-cent amounts round to 0 and the service rejects them — catching a server error on the client (`CashWallets.tsx:199-202`).

### Bad

1. **[CRITICAL] Archiving an account silently deletes it from net worth, with no confirmation and no undo.** On `/accounts/[id]` the archive control is a bare form submit styled as 12px grey text (`[id]/page.tsx:269-278`) calling `setAccountActiveAction` (`actions.ts:94-102`). `netWorthSeries` selects only `isActive` accounts (`derivation.ts:284-289`), so the account's balance vanishes from the hero, the chart, and every downstream aggregate the instant the click lands. Scenario: the owner archives "Robinhood Brokerage" to tidy the list; net worth drops from $84,858.34 to $23,245.69 with no dialog, no toast, no undo, and no text anywhere explaining the link between the two. The archived list on `/accounts` (`page.tsx:44-63`) shows no balance, so nothing tells him where the money went. — `src/app/accounts/[id]/page.tsx:269-278`
2. **[HIGH] Every balance on `/accounts` is printed undated and unqualified, including ones the engine itself calls estimates.** `ManagedAccounts.tsx:160-167` renders only `balanceCents`. `asOf` and `basis` are computed one line away (`institution-groups.ts:169-170`) and discarded. On the owner's live database today (2026-07-27), Chase Checking's row prints $1,106.69 — a value dated 2026-07-10 with basis `derived_unverified`, i.e. replayed backward with no verifying anchor. Chase Sapphire, Discover, SoFi Checking and SoFi Savings are all `carried` or `derived_unverified` from 2026-07-10; Robinhood is from 07-18/07-19. Five of nine accounts are between 8 and 17 days stale and every one of them looks like a live figure. The dashboard shows "as of" for the same data (`InstitutionCard.tsx:111`) and the detail page names the basis in words (`[id]/page.tsx:154-156`) — the registry page is the least honest surface showing the number, under a shell header that reads "reconciled to the cent". — `src/components/accounts/ManagedAccounts.tsx:160-167`
3. **[HIGH] The same figure appears with opposite signs inches apart inside one card.** The institution header renders `group.totalCents` in the net-worth sign convention (`ManagedAccounts.tsx:75`) while each row renders `a.isLiability ? -a.balanceCents : a.balanceCents` in the owed frame (`ManagedAccounts.tsx:162`). Live data: the Capital One card header reads −$11,020.45 and the single Venture X row beneath it reads $11,020.45. The Chase card header reads −$318.57 above rows of $1,106.69 and $1,425.26 — a reader who adds the two visible numbers gets $2,531.95. Nothing labels either frame; the only cue is a red tint on the row and the word "Credit card" buried in an 11px meta string. — `src/components/accounts/ManagedAccounts.tsx:75`
4. **[HIGH] An account re-homed to the 'Cash' institution disappears from the page entirely.** `page.tsx:25` removes the whole Cash group from `ManagedAccounts`; `page.tsx:28` lists only accounts passing `isCashWallet`, which returns false for anything with a statement period, an import anchor, or an imported transaction (`manual-transactions.ts:73-97`). The Edit sheet's Institution select is populated from all institutions (`page.tsx:26` → `EditAccountSheet.tsx:128-136`) and includes 'Cash' as soon as one wallet exists. Scenario: the owner re-homes "SoFi Checking" to Cash while tidying up. It is not in the institution list, not in the cash-wallet list, not in the Archived list (it is still active) — it is rendered nowhere on `/accounts`, while continuing to contribute $0.01 to net worth and continuing to accept imports. The only route back is the ⌘K palette, which has no visible trigger anywhere in the shell. — `src/app/accounts/page.tsx:25`
5. **[HIGH] Creating an account under the 'Cash' institution from the Add-account form skips the load-bearing $0 opening anchor.** `createAccountAction` calls `createAccount` directly (`actions.ts:44-50`); only `createCashWallet` seeds the anchor at openingOn−1 (`cash-wallets.ts:56`), which its own comment identifies as the fix for 'the deferred bug this closes'. The Add-account form's institution select offers 'Cash' (`AccountForm.tsx:17-25`). Scenario: the owner adds "Wallet" under Cash from the bottom form. `isCashWallet` passes, so it appears in the Cash wallets card, but with no anchor derivation has no baseline: the row reads 'no balance yet' forever and the first $20 manual spend moves nothing. Two creation paths to the same object, one of which is quietly broken. — `src/app/accounts/actions.ts:44-50`
6. **[HIGH] Manual cash transactions can be created here but never deleted anywhere.** `deleteManualTransactionAction` (`cash-actions.ts:38-50`) has zero callers in the entire repository — verified by grep across `src/`. `deleteManualTransaction` exists in the service (`manual-transactions.ts:267`) and is exercised only by unit tests. Scenario: the owner adds a $200 cash spend, realises it was already captured by a statement, and has no way to remove it. He can edit its description and amount through the ledger's row expander (`LedgerRowExpander.tsx:54-99`), but only if he first discovers that the row is on `/transactions` — the cash-wallet card gives him no link to its own transactions at all (`CashWallets.tsx:65-84`). — `src/app/accounts/cash-actions.ts:38-50`
7. **[HIGH] Typing anything non-numeric into a balance field returns a raw Next.js error page.** `createAccountAction` (`actions.ts:57`) and `addAnchorAction` (`actions.ts:77`) both pass a plain text input straight to `parseAmountToCents`, which throws `MoneyParseError` (`money.ts:33`). Neither field has a type, pattern, or client guard (`AccountForm.tsx:53-57`, `AnchorForm.tsx:21-23`), and there is no `error.tsx`, `loading.tsx` or `not-found.tsx` anywhere under `src/app`. Scenario: the owner records his Venture X balance as '11,020.45 owed' or 'about 1.1k'. The server action throws, Next renders its default error boundary, and every other field he filled in is lost. This is the control that writes chain-grade ground truth into the balance derivation. — `src/app/accounts/actions.ts:57`
8. **[HIGH] Reorder is unusable by touch: 14px tap targets and a drag handle that cannot fire on a phone.** The Move up/down buttons carry no padding or size class, so the hit target is exactly the `size-3.5` icon — about 14×14 CSS px (`ManagedAccounts.tsx:114-131`), well under the 24×24 WCAG 2.5.8 minimum. The drag grip uses HTML5 dragstart/drop (lines 100-102, 89-96), which never fires from touch, and additionally sets `touch-none` (line 104), disabling scroll on that element without enabling anything. Scenario: on the phone the owner says he will use, the two controls that consume the leftmost ~40px of every account row are one that cannot be hit and one that cannot work. — `src/components/accounts/ManagedAccounts.tsx:114-131`
9. **[MEDIUM] Deleting a manual anchor is destructive, unconfirmed, and can rewrite the whole balance curve.** The 'remove' control on `/accounts/[id]` is 10px grey text inside a bare form (`page.tsx:244-256`) calling `deleteAnchorAction` (`actions.ts:84-92`) with no confirmation, toast or undo. A `manual` anchor is CHAIN_GRADE — a replay endpoint (`derivation.ts:30`). Scenario: the owner removes a manual anchor he thinks is redundant; the span it terminated no longer closes to the cent, `deriveCashSpans` stamps those days `basis='gap'`, `netWorthSeries` skips them entirely, and months of his chart go partial. Nothing on screen warned him, and there is no way back except re-typing the exact value and date. — `src/app/accounts/[id]/page.tsx:244-256`
10. **[MEDIUM] The unlabeled day-change number is not a day change.** `dayChangeOf` takes the last two non-gap points regardless of the interval between them (`institution-groups.ts:73-78`). On `/accounts` it renders with no label at all (`ManagedAccounts.tsx:168-174`); on the dashboard the identical value is labelled 'today' (`InstitutionCard.tsx:28`). Scenario: on 2026-07-27 the dashboard tells the owner Chase Checking moved −$14.21 'today'. It moved that on 2026-07-10. If an account's coverage had an interior gap, the same field would present a multi-month swing as a one-day move. — `src/components/accounts/ManagedAccounts.tsx:168-174`
11. **[MEDIUM] The page has no total — the owner must sum five institution headers with mixed signs in his head.** `page.tsx:41-83` renders institution cards, an archived list, a cash card and a form, and never computes a page-level figure. Live data: to learn what he is worth the owner must add −$318.57 + −$11,020.45 + −$6.98 + $96,204.23 + $0.11 = $84,858.34 across five separate card headers, three of which are negative and none of which is labelled asset or liability. The dashboard already computes assets/liabilities/net with an in-transit disclosure; the registry page — the one that exists to answer 'what do I have' — computes nothing. — `src/app/accounts/page.tsx:41-83`
12. **[MEDIUM] Reordering has no optimistic update, so a double-click silently loses a move.** `move()` fires the server action and only refreshes on success (`ManagedAccounts.tsx:47-63`); the rendered list does not change until the RSC round-trip completes, and that round-trip re-runs three full `daily_balances` scans. Scenario: the owner clicks Move up twice on the account at index 2, expecting it at index 0. The second click reads the still-stale index 2 and sends the identical transform. The account lands at index 1 and one click evaporated with no feedback, no spinner, and no `aria-busy`. — `src/components/accounts/ManagedAccounts.tsx:47-63`
13. **[MEDIUM] Institutions cannot be reordered — only accounts within them.** `institutionGroups` orders by `asc(institutions.name)` (`institution-groups.ts:108`) and nothing in the schema or the UI stores an institution order. Scenario: the owner's largest holding by far is Robinhood ($96,204.23), and his page opens with Capital One's −$11,020.45 card. The page description explicitly advertises reordering (`page.tsx:39`) but the axis that matters most is fixed alphabetically forever. — `src/services/institution-groups.ts:108`
14. **[MEDIUM] Three full scans of `daily_balances` per page render.** `institutionGroups` selects every `daily_balances` row for every active account with no date bound and filters in JS (`institution-groups.ts:112-128`) — 6,596 rows on the owner's live DB — to use the last 30 points per account. `page.tsx:27` then calls `listAccounts` → `latestBalances`, another unbounded full scan (`derivation.ts:374`). `page.tsx:28` calls `listCashWallets` → `listAccounts` again → a third full scan, plus four queries per account inside `isCashWallet`. Scenario: this page is destined for a hosted free tier over a network with request-scoped connections; today it is ~20,000 rows of redundant IO to render nine sparklines. — `src/services/institution-groups.ts:112-128`
15. **[MEDIUM] The unreviewed-count dot is announced to nobody and links nowhere.** `<span aria-label={...}>` with no role (`ManagedAccounts.tsx:143-148`, and identically `InstitutionCard.tsx:53-58`): ARIA prohibits `aria-label` on the generic role and screen readers routinely drop it, so the count is invisible to assistive tech. It is also inert to the mouse — the enclosing link goes to `/accounts/[id]`, which has no review filter — even though `/transactions?view=review&account=<id>` is a supported deep link (`transactions-query.ts:34-52`, `query.ts:53-62`). Scenario: the owner sees a blue dot on Chase Checking, clicks it, lands on the account page, and still has to find Transactions, switch to the Review tab, and filter by account by hand. — `src/components/accounts/ManagedAccounts.tsx:143-148`
16. **[MEDIUM] Cash wallet rows are dead ends: not renamable, not linkable, not archivable, not inspectable.** `CashWallets.tsx:65-84` renders a plain `<span>` name and a balance, with a single button. There is no `InlineEditableText` (the primitive the app uses for account, category, merchant and series names — `AccountNameHeading.tsx:26-36`), no href, no pencil, no archive, and no ledger. Scenario: the owner creates 'Pockte cash' with a typo. He cannot rename it, cannot archive it, and cannot see the transactions he has been adding to it. The only route to its detail page is the ⌘K palette (`command-index.ts:33-36`) — keyboard-only, with no visible trigger, hence unreachable on the phone this app is built to be read from. — `src/components/accounts/CashWallets.tsx:65-84`
17. **[MEDIUM] The payment-source link — the page's highest-leverage setting — is invisible until you open a sheet.** `paymentSourceAccountId` is structural evidence the transfer detector uses to auto-pair card payments without descriptor hints. It is settable only inside the edit sheet, only after switching Type to 'Credit card', and only when candidates exist (`EditAccountSheet.tsx:164-178`). Nothing on the row shows whether a card HAS a funding account. Scenario: the owner has three credit cards; two are linked, one is not, and his card payments from that one keep landing in the review queue as unpaired outflows. `/accounts`, the page whose entire job is account configuration, gives him no way to see which is which without opening three sheets. — `src/components/accounts/EditAccountSheet.tsx:164-178`
18. **[LOW] Institution totals silently count null-balance accounts as zero.** `totalCents` reduces `c.balanceCents ?? 0` (`institution-groups.ts:207`) while the row renders 'no balance' (`ManagedAccounts.tsx:166`). Scenario: the owner adds a new SoFi account before importing anything. The SoFi header keeps printing a confident total that excludes it, with nothing marking the total as partial — the same class of understatement `netWorthSeries` goes to great lengths to disclose via `missingAccounts`. — `src/services/institution-groups.ts:207`
19. **[LOW] Sparklines vanish on mobile here but not on the dashboard.** `hidden sm:block` (`ManagedAccounts.tsx:157`) removes the per-account sparkline below 640px, while the dashboard's identical sub-card renders it at every width (`InstitutionCard.tsx:62-67`). Scenario: on his phone, the owner's Accounts page shows nine rows of bare numbers with no trend, while the Dashboard one tap away shows the shape for the same accounts. — `src/components/accounts/ManagedAccounts.tsx:157`
20. **[LOW] The archived list is an unactionable stub.** `page.tsx:50-60` renders name and institution and nothing else: no balance (so the owner cannot see what archiving cost him), no type, no archive date, no Restore button, and the whole section is hidden when empty so there is no visible undo target immediately after archiving. Restore lives at the very bottom of the detail page (`[id]/page.tsx:272-277`). — `src/app/accounts/page.tsx:44-63`
21. **[LOW] Two money-parsing conventions coexist within this one surface.** The cash-transaction sheet uses `Math.round(Number(amount)*100)` (`CashWallets.tsx:201`), which accepts '1e5' as $100,000.00 and JS float semantics, while every other money path in the app uses `parseAmountToCents` (`money.ts:21`), documented as string math end-to-end precisely so bank amounts never touch a float. — `src/components/accounts/CashWallets.tsx:201`
22. **[LOW] A picked category in the cash sheet cannot be un-picked.** `CategoryPicker`'s `onPick` only ever emits an id (`CategoryPicker.tsx:27`) and CashWallets passes `setCategoryId` directly (`CashWallets.tsx:282`). There is no 'no category' option and no clear control, so a mis-click is unrecoverable within the sheet — the owner must cancel and retype the whole transaction. — `src/components/accounts/CashWallets.tsx:282`
23. **[LOW] 'Added X' toasts even when nothing was added.** `createInstitution` is find-or-create (`accounts.ts:249-258`) and returns the existing id on a duplicate, but `AddInstitution` unconditionally toasts `Added ${trimmed}` (`AddInstitution.tsx:28`). Its `pending` prop is also driven by a `useTransition` that only starts after the action resolves (line 30), so the button never shows busy during the actual call. — `src/components/accounts/AddInstitution.tsx:23-31`
24. **[LOW] Zero interaction-state coverage for this surface.** `e2e/interaction-states.spec.ts` registers states only for `/transactions` (lines 76, 85, 96). The edit-account sheet, the re-derive warning, the new-wallet form, and the add-transaction sheet have no visual baseline and no in-state axe sweep in either theme at either width — even though the axe route sweep only ever sees `/accounts` with every overlay closed (`a11y.spec.ts:10`). — `e2e/interaction-states.spec.ts:76`

### Change

1. **Print as-of date and basis on every balance the page shows** (S) — `institution-groups.ts:169-170` already computes `asOf`, and `latestBalances` already returns `basis` (`derivation.ts:378-383`) — both are loaded and discarded. Add `asOf` and `basis` to `AccountCard`, render them in the row's meta line (`ManagedAccounts.tsx:150`) as e.g. 'Checking · ····3522 · as of Jul 10 · estimated', reuse the detail page's `BASIS_LABEL` map (`[id]/page.tsx:41-46`), and give the institution header the group `asOf` the dashboard already shows (`InstitutionCard.tsx:111`). Same for the cash-wallet rows: `page.tsx:28-32` currently drops `balance.asOf` and `balance.basis` on the floor. Nothing on this page should print a money figure it cannot date.
2. **Resolve the sign clash: state the frame on every liability figure** (S) — Either label the row ('$11,020.45 owed') or render the header in the same owed frame with an explicit 'net' qualifier — do not leave the same number showing opposite signs 3cm apart (`ManagedAccounts.tsx:75` vs `:162`). Cheapest additive fix: append a small 'owed' suffix beside liability row figures and a 'net' suffix on the header, matching the detail page's 'Amount owed' label (`[id]/page.tsx:143-145`).
3. **Label the day-change and stop claiming 'today'** (S) — Carry the two dates `dayChangeOf` compares (`institution-groups.ts:73-78`) onto the card and render 'Jul 9 → Jul 10' rather than nothing (`ManagedAccounts.tsx:168-174`) or 'today' (`InstitutionCard.tsx:28`). When the interval is not one day, or the latest day is not today, say so.
4. **Put a confirmation and an undo on archive, and disclose the net-worth consequence** (M) — Convert `setAccountActiveAction` (`actions.ts:94-102`) to the value-returning `ActionResult` + toast pattern the rest of the page already uses (see `reorderAccountsAction`), gate it behind a confirm that names the amount leaving net worth (it is one `latestBalances` lookup away), and offer Undo in the toast. Same treatment for `deleteAnchorAction` (`actions.ts:84-92`), which can silently turn months of chart into gaps.
5. **Make the money inputs safe: catch MoneyParseError and add an error boundary** (M) — Wrap `parseAmountToCents` in `createAccountAction` (`actions.ts:57`) and `addAnchorAction` (`actions.ts:77`) so a parse failure returns a field-level message instead of throwing, and convert both forms to the value-returning action + `<Field error>` pattern already available (`Field.tsx:26`). Independently, add `src/app/error.tsx` and `src/app/loading.tsx` — the app currently has none, so any server throw anywhere becomes a stack-trace page.
6. **Make reorder work with a thumb and feel instant** (M) — Give the Move buttons real padding (min 24×24, ideally 44×44 on touch) at `ManagedAccounts.tsx:114-131`; apply the order optimistically in local state before `commitOrder` and set `aria-busy` while it settles (lines 47-63) so a double-click cannot lose a move; and add a pointer-events-based drag (or long-press reorder) so the grip is not dead on touch (line 104's `touch-none` currently only removes scroll).
7. **Make the unreviewed dot a real, reachable control** (S) — Replace the `aria-label`-on-a-span (`ManagedAccounts.tsx:143-148`, `InstitutionCard.tsx:53-58`) with a proper `<Link href={`/transactions?view=review&account=${a.id}`}>` carrying visible text (the count) — the deep link is already supported by `viewCondition` + `filterConditions` (`transactions-query.ts:34-52`). That fixes the a11y prohibition and turns a decoration into the fastest route to the review queue.
8. **Give cash wallets the same affordances as every other account** (M) — Link the wallet name to `/accounts/${w.id}` (`CashWallets.tsx:66`) so its chart, ledger, anchors and archive control become reachable without ⌘K; wrap the name in `InlineEditableText` + `renameAccountAction` (the primitive and the action both already exist, `AccountNameHeading.tsx:26-36`); and surface the last few manual rows inline with a delete that finally calls the orphaned `deleteManualTransactionAction` (`cash-actions.ts:38`).
9. **Close the 'Cash' institution escape hatches** (S) — Filter `CASH_INSTITUTION_NAME` out of the institution options passed to `AccountForm` and `EditAccountSheet` (`page.tsx:26`) so a real account can never be re-homed into the invisible group and a wallet can never be created without its opening anchor. Additively, render any Cash-institution account that fails `isCashWallet` in a small 'Needs attention' list rather than dropping it (`page.tsx:25`) — nothing that counts toward net worth should be renderable nowhere.
10. **Stop scanning `daily_balances` three times per render** (M) — Bound `institutionGroups`' balance query by day (it only needs the last ~31 rows per account for the sparkline plus the latest two for the change) at `institution-groups.ts:112-128`; memoize `latestBalances` per request so `page.tsx:27` and `page.tsx:28` (via `listCashWallets` → `listAccounts`) do not each re-scan; and batch `isCashWallet`'s four per-account queries (`manual-transactions.ts:63-97`) into one pass. On the live DB this is ~20,000 redundant rows per page view and it is the first thing that will time out on a hosted free tier.
11. **Show the sparkline on mobile and make it interrogable** (S) — Drop `hidden sm:block` (`ManagedAccounts.tsx:157`) — the dashboard already renders the same sparkline at all widths — and make the row's trend area a secondary link into the detail page's balance chart, so the shape can be scrubbed rather than just glanced at.
12. **Make the archived list actionable in place** (S) — Add balance, type, and a Restore button to each archived row (`page.tsx:50-60`) reusing `setAccountActiveAction`, and keep the section rendered (empty-state copy) so there is always a visible target after an archive.
13. **Bring the create form up to the edit sheet's standard** (M) — `AccountForm` uses hand-rolled button classes instead of the shared `<Button>` (`AccountForm.tsx:59-66`), has no pending state, hides the last-4 field for investment accounts (lines 37-48) even though the edit sheet allows one, offers no payment-source field for credit cards, silently discards a bad last-4 (`actions.ts:49`), and redirects away from `/accounts` on success (`actions.ts:63`). Align it with the sheet and offer 'stay here / add another'.
14. **Correct the pending state and the duplicate toast on Add institution** (S) — `AddInstitution` starts its `useTransition` only after the action resolves (`AddInstitution.tsx:30`), so the button never shows busy during the call; and it toasts 'Added X' even when `createInstitution` found an existing row (`accounts.ts:254-256`). Return a `created` flag from the action and toast accordingly.
15. **Fix the docstring and semantics of the sparkline window** (S) — `SPARK_WINDOW_DAYS = 30` is documented as 'days of history' (`institution-groups.ts:20`) but applied as `series.slice(-30)` — the last 30 covered POINTS (line 172). On accounts with sparse coverage (investment accounts skip unpriced days entirely, per crypto-history) that window silently stretches across an arbitrary span. Slice by date, or rename the constant.
16. **Let the cash sheet clear a category and reject out-of-range dates** (S) — Add a 'no category' option to the picker used at `CashWallets.tsx:282`, and warn (or block) when the chosen date precedes the wallet's opening anchor, where the transaction lands outside the derived span and moves nothing.
17. **Register interaction-state baselines for this surface** (M) — Add `defineStateTests` entries to `e2e/interaction-states.spec.ts` for edit-sheet-open, edit-sheet-rederive-warning, new-wallet-form-open and cash-txn-sheet-open. These are the only overlays on `/accounts` and none is covered by a visual baseline or an in-state axe sweep today (the file registers only `/transactions` states at lines 76, 85, 96).

### Add

1. **A page-level net-worth summary bar with assets / owed / net** (S) — A sticky summary at the top of `/accounts` computing total assets, total owed, and net across all active accounts, plus the in-transit figure the dashboard hero already exposes via `bridgedNetWorthSeries`. Show a coverage note when any account's latest day is stale ('5 of 9 accounts as of Jul 10'). *Why:* Today the owner has to mentally add five institution headers with mixed signs to reach $84,858.34 — the registry page cannot answer its own headline question. This is the single most-missed thing here and every competitor (Monarch, Copilot, Mint) leads with it.
2. **A freshness column with a one-click path to fix it** (M) — Per account: days since its last covered day, a coloured staleness pill, the last import file that touched it, and an 'Import statements →' link straight to `/imports`. Roll it up to an institution-level 'last updated' on the card header. *Why:* Statements are the only way a balance moves in this app, and five of the owner's nine accounts are 8-17 days stale right now with nothing on screen saying so and no route from 'this looks old' to the action that fixes it.
3. **An account health strip per row** (M) — Compact indicators for: unreviewed count (linked to the filtered review queue), open reconciliation gaps, quarantined rows, whether a credit card has a payment source configured, and whether the account has any anchor at all. Roll up per institution. *Why:* The blue dot is the only signal the page carries, it is unlabeled and links nowhere, and the payment-source link — which decides whether card payments auto-pair — is invisible unless you open three separate sheets. This turns `/accounts` into the real 'is my setup correct' screen it claims to be.
4. **Group-by toggle: institution ⇄ type (assets vs liabilities) ⇄ balance** (M) — A `ViewSwitcher` on a proper `{key:"group", options:["institution","type","size"]}` view dimension, resolved URL > persisted > default through `resolveViewState` exactly like the account chart's lens (`accounts-view-spec.ts:15`). *Why:* Assets and debts are the two things the owner actually reasons about, and the page can only ever show them interleaved and alphabetical by bank. The app already has the whole view-state machinery; this surface is one of the few that never adopted it.
5. **Cash wallet ledger inline, with delete** (M) — Under each wallet: the last five manual rows with running balance, an inline edit, and a delete wired to the already-written-and-orphaned `deleteManualTransactionAction` (`cash-actions.ts:38`). Plus a wallet total across all wallets. *Why:* This card is the only place manual transactions can be created and it offers no way to see, correct, or remove them. A typo'd cash entry is currently permanent from the UI's point of view.
6. **Credit-card specifics: limit, utilisation, statement balance, due date, minimum** (L) — Store a credit limit on the account (new nullable column) and render utilisation as a bar on credit rows, with statement balance vs current balance and the next due date derived from the recurring series already detected for that card. *Why:* Venture X sits at −$11,020.45 and the page cannot tell the owner whether that is 20% or 95% of his limit, when it is due, or what the minimum is. Every card-aware competitor shows utilisation; it is also the single number that moves a credit score.
7. **Search / filter across accounts, and a visible ⌘K trigger** (M) — A filter box above the institution list (name, institution, type, last-4) plus 'hide zero-balance' and 'show archived inline' toggles — and a visible search affordance in the shell header, which today contains only a static tagline. *Why:* Nine accounts is fine; twenty is not, and the entity index that already makes every account searchable is reachable only by a keyboard shortcut with no visible trigger — i.e. not at all on the phone the owner reads this from.
8. **Reorderable institutions and a per-institution collapse** (M) — An `institutions.displayOrder` column plus the same move-up/down + drag affordances used for accounts, and the dashboard's collapse/expand behaviour (`InstitutionCard.tsx:100-136`) brought to the registry so long lists compress. *Why:* The page description promises reordering, but the axis that decides what the owner sees first — which bank is at the top — is hard-coded alphabetical (`institution-groups.ts:108`), so his largest holding ($96k Robinhood) sits below his smallest debt.
9. **A 'net worth by institution over time' stacked ribbon on this page** (L) — A stacked-area / streamgraph of each institution's combined series over the selected range, built from the per-group combined arrays `institutionGroups` already computes (`institution-groups.ts:196-205`), rendered through the existing ScrubChart scaffolding with the same coverage-honesty (dashed where any member is uncovered). *Why:* This is the ambitious visualisation the owner asked for and the data is already in hand and already coverage-correct. It answers 'where did my money migrate to' — the one question a flat list of nine numbers structurally cannot.
10. **Bulk account operations** (M) — Multi-select rows to archive, re-home to another institution, or reorder together, with a server-captured undo patch matching the `UndoPatch` pattern the bulk-edit service already implements for transactions. *Why:* Every account operation here is one-at-a-time through a sheet. The app already has a proven bulk+undo pattern; this surface never got it.
11. **Per-account keyboard navigation** (S) — Register an `accounts-list` KeyScope with j/k to move between rows, Enter to open, `e` to edit, `[`/`]` to reorder, and `/` to focus the filter — the KeyScope stack, priorities and mnemonic conventions all already exist (`lib/keyscope.ts`). *Why:* `/transactions` has x/escape, the review inbox has r, the palette has ⌘K — `/accounts` registers nothing. On a desktop monitor this is the page you edit from, and it is entirely mouse-driven.
12. **Account metadata: opening date, notes, tags, colour/icon** (M) — A free-text note and a colour or icon per account, shown on the row and carried into the chart legends and the dashboard cards. *Why:* 'Robinhood Cash' vs 'Robinhood Brokerage' vs 'Robinhood Crypto' are three near-identical rows under one header. Identity cues are how the owner will scan this on a 375px screen, and the design system already ships a 12-hue identity ramp used for categories.
13. **A designed empty state for a first-boot database** (S) — When there are no accounts, replace the bare 'Add an account' form with a guided path: add institution → add account → import a statement, with the `/imports` link inline. *Why:* With zero accounts the page renders an empty Cash card and a form at the bottom, with no explanation of the order operations must happen in. It is the first screen a new install shows and nobody designed it.
14. **Interest rate / APY on savings and credit accounts, with projected interest** (L) — Store an APR/APY per account and show projected annual interest earned or paid beside the balance. *Why:* The app forecasts spending, income, budgets and portfolio returns, but the two flows that compound automatically — savings interest and card interest — are invisible. On an $11k card balance that is the largest un-modelled line in the owner's finances.

---

## `/accounts/[id]` — account detail

(`src/app/accounts/[id]/page.tsx`, `src/components/accounts/**`)

**Purpose** — This is the owner's per-account truth page: the one screen that answers "what is the real balance of this specific card/checking/brokerage account, and is that number trustworthy?" It is where a statement-driven app has to prove itself — it shows the derived level (`page.tsx:146-157`), the derivation basis in words ("as of 2026-07-27 · carried", `page.tsx:154-156`), the ground-truth anchors the level was replayed from (`page.tsx:222-263`), and the transactions that moved it (`page.tsx:195-210`). It is also the only place the owner can hand-correct an account: rename it inline (`AccountNameHeading.tsx:26-36`), re-home/retype it (`EditAccountSheet.tsx`), record a manual balance (`AnchorForm.tsx`), and archive it (`page.tsx:269-278`). In his actual life this is the page he opens when the dashboard number looks wrong and he wants to find out which account is lying.

**Connections** — READS: `getAccount` + `listAccounts` + `listInstitutions` (`services/accounts.ts`) for identity and the edit sheet's funding candidates; `accountSeries` (`services/derivation.ts:353-364`) for the balance curve — gap days are filtered out here; `listAnchors` (`services/anchors.ts:51-58`) for the recorded-balance table; `listAccountHoldings` (`services/holdings.ts:177-230`) for investment accounts; `recentLedgerRows` (`services/ledger-rows.ts:114-133`, `status='active'` only, limit 10); `readSettings().viewPreferences["account"]` for the persisted chart/table lens (`accounts-view-spec.ts:13-15`). WRITES: `renameAccountAction` / `editAccountAction` / `addAnchorAction` / `deleteAnchorAction` / `setAccountActiveAction` (`app/accounts/actions.ts`) — every anchor write and every type flip calls `rebuildAccount` (`anchors.ts:47,69`; `accounts.ts:239`), which DELETEs and re-inserts this account's whole `daily_balances`. LINKS OUT: `/accounts` (breadcrumb + footer), `/transactions?account=<id>` (`page.tsx:202`, honored by `transactions-query.ts:52`), `/investments/{assetType}/{symbol}` (`AccountHoldingsTable.tsx:121`), `/merchants/{id}` via the transaction sheet (`TransactionSheet.tsx:297`). LINKS IN: InstitutionCard sub-cards (`InstitutionCard.tsx:44`), the archived list (`accounts/page.tsx:52`), the command palette's Accounts group (`services/command-index.ts`). FEEDS: whatever happens here propagates to net worth — archiving drops the account from `netWorthSeries` entirely (`derivation.ts:285-289`), and every anchor add/remove rewrites the curve the dashboard hero draws. NOT CONNECTED (and should be): `/imports` (no statement/period/gap surface for this account), `/spending` (no account filter exists at all), `/budgets`, `/recurring`.

### Interactive inventory

| element | file:line | intended | verdict |
|---|---|---|---|
| "Today" change chip | `src/app/accounts/[id]/page.tsx:152` (computed at `:94`) | today's movement | **broken** — It is latest-covered-day minus the PREVIOUS covered day, and it never consults basis. Measured live on a real-shaped DB: Capital One 360 Checking renders "Today +$0.00 · 30 days +$0.00 · as of 2026-07-27 · carried" — both numbers are the difference between two carried-forward copies of a 2026-07-05 balance. The chip asserts "nothing moved today" when the truth is "we have no data for three weeks". |
| "30 days" change chip | `src/app/accounts/[id]/page.tsx:153` (computed at `:96-101`) | 30-day movement | **broken** — Same basis-blindness, plus it renders nothing at all (returns null, `ChangeChip:56`) when the series is shorter than 30 days — a new account silently shows one chip instead of two with no explanation. |
| "Focus the Balance chart" expand button | `src/components/charts/ChartFocus.tsx:119-126` | open the same chart bigger in a native `<dialog>` | **broken** — CONFIRMED live: brush May 24–Jun 30 on the inline chart, press Focus → the modal shows 3M, no Reset chip, no brushed window. Only `range` is lifted (`ChartFocus.tsx:67`); BalanceChartPanel passes no `onWindowChange` so each ScrubChart keeps its own window. ChartFocus's own doc (`:25-28`) promises "the same chart, bigger". |
| Record a balance — Date input | `src/components/accounts/AnchorForm.tsx:17` | date the anchor | **broken** — No `max` attribute (confirmed live: max attr is null) and no server-side upper bound (`actions.ts:66-70` only checks length ≥ 10). A fat-fingered 2036 date is accepted and becomes a chain endpoint, turning every span before it into an unverifiable gap or an invented carry. |
| Record a balance — Balance input | `src/components/accounts/AnchorForm.tsx:22` | type the known balance | **broken** — CONFIRMED live: typing "not a number" and pressing Record balance replaces the entire page with "This page couldn't load — A server error occurred. Reload to try again. ERROR 4062620856". `parseAmountToCents` throws `MoneyParseError` (`money.ts:33`), `addAnchorAction` is a void action with no try/catch (`actions.ts:72-82`), and there is no `error.tsx` anywhere in `src/app`. |
| Record a balance — "Record balance" submit | `src/components/accounts/AnchorForm.tsx:24-29` | anchor the account's history at a known level | **broken** — Three separate failures. (1) On a credit card, entering "-50" crashes the page identically (CONFIRMED live) because `addManualAnchor` throws (`anchors.ts:27-29`). (2) On an investment account with `holding_events` the anchor is written, listed, and completely ignored — `rebuildAccount` returns early into `rebuildInvestmentHistory` and never reads anchors (`derivation.ts:204-215`), yet the card copy says "A known balance on a known date anchors this account's history" (`page.tsx:217`). (3) Success produces no toast at all — the action returns void (`actions.ts:72`), unlike every other mutation on this page. |
| Anchor "remove" submit button | `src/app/accounts/[id]/page.tsx:245-256` | delete a manual/live anchor | **broken** — Destructive with no confirmation, no undo, and no statement of consequence — `deleteAnchor` immediately re-derives the whole account (`anchors.ts:69`), which can flip a closed chain to `basis='gap'` and change net worth. It is rendered as 11px `text-ink-faint` reading "remove", the least prominent control on the page. |
| "Archive account" / "Restore account" submit | `src/app/accounts/[id]/page.tsx:269-278` → `actions.ts:94-102` | hide an account you no longer use | **broken** — No confirmation, no undo, no warning — and archiving REMOVES the account from `netWorthSeries` (`derivation.ts:285-289`, pinned by `derivation.test.ts:406`). Archiving a card with -$1,041 owed silently raises reported net worth by $1,041 with a single click on an 11px faint link. |
| Page-level error handling | `src/app/` (no `error.tsx` exists anywhere) | contain a failure to one region | **broken** — Verified by find: zero `error.tsx` / `global-error.tsx` / `loading.tsx` files in `src/app`. Every throw from an RSC read or a void server action on this page becomes a full-page "A server error occurred" replacement with a hex code. |
| Range pills 1M / 3M / YTD / 1Y / ALL | `src/components/charts/ChartRangePills.tsx:34-50`, owned by `ChartFocus.tsx:67` | pick the charted window | **missing-state** — The only view state on this page NOT in the URL and NOT persisted — the sibling `lens` is both. `/accounts/[id]` accepts no `?range=` at all, so a chosen range cannot be linked, bookmarked, or survive a reload, while the lens beside it does. |
| Holdings table sort headers (Holding / Day / Value / Alloc) | `src/components/accounts/AccountHoldingsTable.tsx:34-38, 41-111` | re-sort the positions | **missing-state** — Sort lives in component useState, not the URL and not `app_settings` — DataTable's own doc says "the page owns sort state (usually in the URL)" (`DataTable.tsx:27`). It resets on every navigation and cannot be shared. Quantity, Price and P/L are not sortable at all with no stated reason. |
| Holdings "market value" total | `src/app/accounts/[id]/page.tsx:187-189` (sum at `:104`) | the account's position value | **missing-state** — Sums `h.valueCents ?? 0`, so an unpriced symbol contributes a silent zero, and it is computed from each symbol's own latest close while the Balance headline directly above comes from crypto-history's whole-day NAV (`services/crypto-history.ts:110-117`, which SKIPS any day where a held symbol has no close). Two numbers on one card from two pipelines, with no note that they can disagree. |
| Recent-transactions list length | `src/app/accounts/[id]/page.tsx:32,106` | a teaser of the newest rows | **missing-state** — Hard-capped at 10 with no "showing 10 of 322" count and no "load more". The user cannot tell whether the account has 11 transactions or 700. |
| Recorded balances — table header row | `src/app/accounts/[id]/page.tsx:229-234` | label Date / Source / Balance | **missing-state** — Not sortable, no provenance column, and nothing indicates which anchor WINS. CONFIRMED live: after recording $500 manual on 2026-06-30, the table showed "2026-06-30 statement $10,780.24" and "2026-06-30 manual $500.00" as two peer rows. Precedence (statement > ofx_ledger > manual > live, `derivation.ts:23-30`) is invisible, so the user's entry looks accepted and is silently outranked. |
| Chart section as a whole | `src/app/accounts/[id]/page.tsx:166-181` | balance history | **missing-state** — Gated on `series.length > 1` with no else branch — a brand-new account with one anchor gets no chart, no placeholder, no explanation, and the whole "Balance history" heading vanishes. |
| Holdings section as a whole | `src/app/accounts/[id]/page.tsx:183-193` | positions in this investment account | **missing-state** — Gated on `holdings.length > 0` — an investment account with no holdings shows nothing and offers no "Add a holding" affordance; that form only exists on `/investments`. |
| Balance / "Amount owed" headline figure | `src/app/accounts/[id]/page.tsx:143-150` | the account's current level, owed-frame for liabilities | **dead-end** — Not clickable, not explainable. There is no path from the number to "which anchor and which transactions produced this?" even though the page has both datasets in memory. |
| Chart plot — drag-to-zoom brush | `src/components/investments/ScrubChart.tsx:416-462` | zoom into a custom date window | **dead-end** — CONFIRMED live: after brushing, the page has 0 elements matching /In this window/ and 0 "Timeframe history" groups. The dashboard's identical brush cross-filters a whole activity panel and gets Back/Forward chips (`e2e/zz-period-activity.spec.ts:37-76`). Here the same gesture zooms a line and nothing else on the page reacts. |
| Holdings P/L cell "—" with `title="Add an average cost to see P/L"` | `src/components/accounts/AccountHoldingsTable.tsx:95-97` | explain a missing P/L | **dead-end** — The hint tells the user to do something with no control anywhere on this page to do it; `avgCostCents` is only settable through the Add-holding form on `/investments` (`app/investments/actions.ts:31-61`). Also a `title` attribute is invisible to touch and to keyboard. |
| Sheet › Institution select | `src/components/accounts/EditAccountSheet.tsx:129-135` | re-home the account to another institution | **confusing** — Only lists EXISTING institutions. `/accounts` offers inline creation via `AddInstitution.tsx` (`accounts/page.tsx:80`) and `createInstitutionAction` already exists (`actions.ts:200-210`); from here a new institution is unreachable, so the user must leave, create it, and come back. |
| "Balance lens" chart⇄table ViewSwitcher (rendered in BOTH the inline card and the focus dialog) | `src/components/accounts/BalanceChartPanel.tsx:180-190` | switch the same window between a line and rows; URL `?lens=table` + persisted per surface | **confusing** — CONFIRMED live: with a Jun 4–Jun 13 brush active, toggling to Table produced "Balance by day — 3 months, 92 days". The window is dropped and the caption confidently names a range the user did not choose. Documented at `ScrubTable.tsx:27-29`, but the caption logic (`ScrubTable.tsx:147-149`) only guards the `fellBack` case, not the dropped-window case. |
| "From date" / "To date" inputs | `src/components/investments/ScrubChart.tsx:893-912` | type an exact window | **confusing** — `applyWindow` silently returns when the requested window holds <2 chartable points (`ScrubChart.tsx:398-404`). On a sparse account the user types a date, nothing happens, and no message explains why. |
| Table lens — day/balance/Basis rows | `src/components/charts/ScrubTable.tsx:109-142` + `BalanceChartPanel.tsx:153-169` | the chart's numbers as rows, with the basis named in words | **confusing** — Unpaginated. Measured live: the 1Y window rendered "366 days" — 366 DOM rows with no virtualization, no paging, no "show more", on a phone. ALL range on the owner's real ledger is ~2 years. |
| Holdings row → `/investments/{assetType}/{symbol}` | `src/components/accounts/AccountHoldingsTable.tsx:121` | open the position detail | **confusing** — The destination is the AGGREGATED holding across all accounts, but the row the user clicked was captioned "Holdings in this account" with an allocation % scoped to this account. Nothing on the destination says "you came from Robinhood Brokerage" or scopes back. |
| "All transactions →" link | `src/app/accounts/[id]/page.tsx:201-206` | open the full ledger scoped to this account | **confusing** — The whole section (heading AND link) is conditional on `ledgerRows.length > 0` (`page.tsx:195`). Measured live on Robinhood Crypto (0 transactions): the page renders no Recent-transactions section and no link at all, so the account's ledger is unreachable from its own page. It also only ever reaches `status='active'` rows — quarantined and excluded rows for this account have no route from here. |
| Transaction sheet — "View merchant" → `/merchants/{id}` | `src/components/transactions/TransactionSheet.tsx:297` | open the merchant's page | **confusing** — One-way exit: `/merchants` has no index route and the merchant page has no way back to the account the user came from. |
| Recorded balances — the list itself | `src/app/accounts/[id]/page.tsx:109, 236-260` | show the ground truth the curve replays from | **confusing** — Unpaginated and unfiltered (27 rows on a demo account, far more on the owner's real statement archive), with no link from a statement anchor to the import file that created it even though `balance_anchors.importFileId` exists (`db/schema/balances.ts:27`). |
| Sheet › Payment source select (credit only) | `src/components/accounts/EditAccountSheet.tsx:164-178` | link the card to its funding account so card payments auto-pair | **undiscoverable** — Renders only when `type==='credit'` AND `fundingCandidates.length>0` (`page.tsx:135-137`). Nothing on the account page states that this link exists, what it does to the transfer detector, or whether it is currently set — a user with an unlinked card has no signal that pairing is available. |
| Breadcrumb "Accounts" link | `src/app/accounts/[id]/page.tsx:113-116` | return to the account index | sensible |
| Account name — inline-editable trigger (role=button span, click/Enter/Space) | `src/components/accounts/AccountNameHeading.tsx:26-36` → `src/components/ui/InlineEditableText.tsx:90-107` | rename in place; Escape cancels, Enter/blur saves optimistically with toast+Undo | sensible |
| Inline rename input (Escape / Enter / blur, maxLength 80) | `src/components/ui/InlineEditableText.tsx:61-79` | edit and commit the name; role=alert on error | sensible |
| "Edit account" pill button | `src/components/accounts/EditAccountButton.tsx:23-28` | open the edit sheet | sensible |
| Sheet › Account name input (Enter saves) | `src/components/accounts/EditAccountSheet.tsx:119-126` | rename from the sheet | sensible |
| Sheet › Last 4 input | `src/components/accounts/EditAccountSheet.tsx:138-145` | set/clear the masked digits | sensible |
| Sheet › Type select | `src/components/accounts/EditAccountSheet.tsx:148-162` | change checking/savings/credit/investment; resets the confirm box on every flip | sensible |
| Sheet › Subtype select (investment only) | `src/components/accounts/EditAccountSheet.tsx:179-196` | brokerage vs crypto | sensible |
| Sheet › "I understand — re-derive the balance history" checkbox + warning in aria-live region | `src/components/accounts/EditAccountSheet.tsx:199-214` | gate a semantics change behind explicit consent | sensible |
| Sheet › Cancel / Save changes buttons | `src/components/accounts/EditAccountSheet.tsx:106-115` | dismiss / persist; save is single-flight and toasts the result incl. "balance history re-derived" | sensible |
| "as of {day} · {basis}" caption | `src/app/accounts/[id]/page.tsx:154-156` | state the level's date and derivation basis | sensible |
| Focus dialog: Escape / backdrop click / "Close focus view" button | `src/components/charts/ChartFocus.tsx:140-148, 160-167` | dismiss and return focus to the opener | sensible |
| Chart plot — `role="slider"`, tabIndex=0, arrow/Home/End keyboard scrub | `src/components/investments/ScrubChart.tsx:526-534, 370-375` | inspect any day by keyboard; aria-valuetext speaks the value AND the basis | sensible |
| Chart plot — pointer hover-to-inspect (hairline) | `src/components/investments/ScrubChart.tsx:427-447` | read a day under the cursor | sensible |
| Custom-window "{start} – {end} · Reset" chip | `src/components/investments/ScrubChart.tsx:884-892` | show the brushed window and clear it back to the pill | sensible |
| Peak / trough extreme dots | `src/components/investments/ScrubChart.tsx:358-362` (`showExtremes`) | mark the window's high and low | sensible |
| Table lens — range pills | `src/components/charts/ScrubTable.tsx:154` | re-window the rows | sensible |
| Recent transaction row (opens the shared TransactionSheet) | `src/components/transactions/RecentTransactions.tsx:53-79` | inspect/edit a transaction in place | sensible |
| Transaction sheet — prev/next flip, suggestion apply, category picker, transfer mark, split, notes | `src/components/transactions/TransactionSheet.tsx:163-167, 188, 243` | full single-row editor without leaving the page | sensible |
| "← All accounts" footer link | `src/app/accounts/[id]/page.tsx:266-268` | back to the index | sensible |

### Good

1. **The basis honesty chain is genuinely excellent and is the app's differentiator.** `accountSeries` carries basis per day (`derivation.ts:353-364`), BalanceChartPanel maps it to solid vs dashed (`BalanceChartPanel.tsx:51-53, 96`), the scrub `aria-valuetext` SPEAKS it (confirmed live: "Mon, Jul 27, 2026: $10,780.24, up 6.3% — carried forward", `BalanceChartPanel.tsx:112-119`), and the table lens supplies its own Basis column rather than laundering estimates as exact (`BalanceChartPanel.tsx:153-169` + `ownsCompleteness` at `ScrubTable.tsx:117`). No competitor does this. Protect it and push it UP into the headline chips.
2. **The chart⇄table lens is architecturally right**: one `summarize`, one `renderHeader`, one `formatValue` object shared by both renderings (`ScrubTable.tsx:44-53`), and both slice through the same pure `windowedPoints` (`chart-window.ts`). The table literally cannot print a different number than the chart. Propagate this pattern to the holdings table and the anchors table.
3. **The edit sheet's re-derive gate is the best destructive-action design in the app**: a persistent aria-live region, a plain-English consequence ("Nothing is deleted; the history is recomputed"), an explicit checkbox, AND the checkbox resets on every type/subtype change so consent can never be carried across a flip (`EditAccountSheet.tsx:150-155, 199-214`). This is exactly the treatment Archive and anchor-remove are missing.
4. **Inline rename is the model interaction**: optimistic, Escape-cancellable, toast+Undo, persisted, and proven end-to-end including the reload assertion (`e2e/zz-account-rename.spec.ts:25-56`). It is also the only control on the page that returns a value and reports failure to the user rather than throwing.
5. **`editAccount` refuses to change an investment account's type when `holding_events` exist**, with a real explanation instead of silent data loss (`accounts.ts:211-218`) — the only place in the app where a schema edit is blocked to protect a derived cache.
6. **Owed-frame is handled correctly and in ONE place**: sign is computed once (`page.tsx:88`) and applied to the headline, the chips, the chart points, and the anchor rows, so a rising line always means a rising displayed figure for both assets and debts (`BalanceChartPanel.tsx:26-32`).
7. **Every table on the page carries a real caption used as its accessible name**, which is why the e2e suite can locate them unambiguously (`ScrubTable.tsx:147-149`, `AccountHoldingsTable.tsx:119`, `e2e/zz-zz-view-switcher.spec.ts:207-209`).
8. **The recent-transactions list reuses the exact same LedgerRow assembly** as `/transactions` and the dashboard (`services/ledger-rows.ts:42-69`) and opens the identical TransactionSheet, so a fix to the row grammar lands everywhere at once.

### Bad

1. **[CRITICAL] Typing a bad balance destroys the whole page.** CONFIRMED live twice. On Capital One 360 Checking, entering "not a number" in Record a balance and pressing Record balance replaced the entire document with "This page couldn't load — A server error occurred. Reload to try again. ERROR 4062620856" (pageerror: `Cannot parse amount: "not a number"`). On Chase Freedom Unlimited, entering "-50" for Balance owed produced the same full-page crash (`addManualAnchor` throws "Enter credit-card balances as the positive amount owed", `anchors.ts:27-29`). Cause: `addAnchorAction` is a void server action with zod `.parse` and `parseAmountToCents` and no try/catch (`actions.ts:72-82`), AnchorForm has no client validation beyond `required` (`AnchorForm.tsx:22`), and there is no `error.tsx` anywhere in `src/app` (verified by find). The owner loses the page, gets a hex code, and has no idea the input was the problem. — `src/app/accounts/actions.ts:72-82` + `src/components/accounts/AnchorForm.tsx:22`
2. **[CRITICAL] "Archive account" silently changes net worth with no confirm and no undo.** A single click on an 11px `text-ink-faint` link labeled "Archive account" (`page.tsx:272-277`) posts `setAccountActiveAction`, which sets `isActive=false` (`actions.ts:94-102`). `netWorthSeries` filters to `isActive=true` accounts (`derivation.ts:285-289`, pinned by `derivation.test.ts:406`), so archiving Venture X while it owes $1,041.29 instantly raises reported net worth by $1,041.29 across the dashboard, and archiving a $10,780 checking account instantly lowers it by $10,780. No confirmation dialog, no toast, no undo, and no sentence anywhere warning that archiving removes the account from net worth. — `src/app/accounts/[id]/page.tsx:269-278`
3. **[HIGH] The "Today" and "30 days" chips ignore basis and assert movement that did not happen.** `dayChange` = latest minus the previous covered day (`page.tsx:94`) and `monthChange` walks back 30 days from `latest.day` (`page.tsx:96-101`); neither reads `point.basis`. Measured live: Capital One 360 Checking renders "Today +$0.00 · 30 days +$0.00 · as of 2026-07-27 · carried" while its newest real anchor is 2026-07-05 — three weeks of carried-forward copies of one number. The owner reads "nothing moved in 30 days" on a checking account he has been using daily. The chart directly below draws those exact days DASHED and the scrub says "carried forward", so the page contradicts itself within 200px. Worse for investment accounts, where crypto-history skips unpriceable days (`crypto-history.ts:110-117`), so "Today" can be a Friday→Monday move. — `src/app/accounts/[id]/page.tsx:94-101, 152-153`
4. **[HIGH] Recording a balance on an investment account is accepted, listed, and completely ignored.** The card says "A known balance on a known date anchors this account's history" (`page.tsx:217`) and offers the form on every account type. But `rebuildAccount` returns early into `rebuildInvestmentHistory` for any investment account that has `holding_events` (`derivation.ts:204-215`), so the anchors table is never read. On Robinhood Brokerage the owner records $17,000, sees the row appear under Recorded balances, and the balance stays $17,549.74 forever with no error and no explanation. — `src/app/accounts/[id]/page.tsx:212-220`
5. **[HIGH] A manual anchor is silently outranked by a statement anchor on the same date.** CONFIRMED live: recorded $500.00 manual on 2026-06-30 for Capital One 360 Checking. The Recorded balances table then showed two peer rows — "2026-06-30 statement $10,780.24" and "2026-06-30 manual $500.00" — with identical styling and nothing indicating which one drives the curve. `pickWinners` enforces statement > ofx_ledger > manual > live at read time (`derivation.ts:23-30`), so the user's correction did nothing. He will conclude the app is broken, or worse, believe the correction took. — `src/app/accounts/[id]/page.tsx:236-260`
6. **[HIGH] Removing an anchor is destructive, unconfirmed, and re-derives the account instantly.** The "remove" button is a bare form submit with no confirmation and no undo (`page.tsx:245-256`). `deleteAnchor` deletes the row and calls `rebuildAccount` synchronously (`anchors.ts:60-70`), which DELETEs and re-inserts the account's entire `daily_balances`. Removing an endpoint that was closing a chain flips every day in that span from `basis='derived'` to `basis='gap'` (`derivation.ts:147-158`), and gap days are dropped from `accountSeries` entirely (`derivation.ts:361`) — so a mis-click can erase months of the balance chart with no way back except re-typing the number from memory. — `src/app/accounts/[id]/page.tsx:245-256`
7. **[HIGH] The chart hides gaps by omission and then draws a straight line across them.** `accountSeries` filters out every `basis='gap'` day (`derivation.ts:361`) and ScrubChart's XAxis is `type="category"` over the surviving days (`ScrubChart.tsx:588-599`). A 90-day unreconciled hole therefore occupies exactly ONE segment width, identical to a one-day step, and the line is drawn straight across it. The derivation engine goes to great lengths never to invent a slope ("replayed values kept for inspection, marked gap", `derivation.ts:155-157`) — and the presentation layer invents one anyway. Nothing in the chart, the table lens, or the header states that days are missing. — `src/services/derivation.ts:353-364` + `src/components/accounts/BalanceChartPanel.tsx:95-98`
8. **[HIGH] An account with zero active transactions has no route to its own ledger.** Both the "Recent transactions" heading and the "All transactions →" link are inside a single `ledgerRows.length > 0 &&` guard (`page.tsx:195-210`). CONFIRMED live on Robinhood Crypto: the rendered page contains neither string. There is also no surface anywhere on this page for quarantined or excluded rows (`recentLedgerRows` hard-filters `status='active'`, `ledger-rows.ts:115`), so an account whose import hit a reconciliation gap — the exact case where the owner needs to look — shows a clean page and says nothing. — `src/app/accounts/[id]/page.tsx:195-210`
9. **[MEDIUM] Focus mode drops the window the user brushed.** CONFIRMED live: brushed May 24 – Jun 30 (Reset chip present), pressed "Focus the Balance chart", and the dialog rendered with no Reset chip — the modal fell back to the 3M pill. ChartFocus lifts only `range` (`ChartFocus.tsx:67`) and BalanceChartPanel passes no `onWindowChange`, so the inline and dialog ScrubCharts each keep private window state. The component's own doc claims "the modal opens on the pill the user was inspecting" (`ChartFocus.tsx:25-28`) — for a brushed window that is false, and the user's zoom is the exact thing he pressed Focus to see bigger. — `src/components/accounts/BalanceChartPanel.tsx:207-223`
10. **[MEDIUM] The lens toggle drops the brushed window and the caption lies about it.** CONFIRMED live: with a Jun 4 – Jun 13 brush active, clicking Table produced a table captioned "Balance by day — 3 months, 92 days, newest first." The 10-day window silently became 92 rows and the caption asserted a range the user never picked. `ScrubTable`'s caption logic guards only the `fellBack` case (`ScrubTable.tsx:147-149`); the dropped-custom-window case — acknowledged in its own header comment at `:27-29` — has no guard at all. — `src/components/charts/ScrubTable.tsx:102, 147-149`
11. **[MEDIUM] The range pill is the only view state on this page that is neither shareable nor sticky.** `lens` lives in the URL (`?lens=table`) and in `app_settings` (`accounts-view-spec.ts:13-15`, `useViewState.ts:44-53`). The range pill sitting three pixels away lives in plain useState inside ChartFocus (`ChartFocus.tsx:67`) and `/accounts/[id]/page.tsx` reads no `range` searchParam at all. The owner sets 1Y, navigates to another account, comes back — he is on 3M again, and he cannot send anyone a link to the 1Y view. `/investments` at least accepts `?range=` as a seed (`investments/page.tsx:56`); this route does not. — `src/app/accounts/[id]/page.tsx:81-85`
12. **[MEDIUM] Holdings "market value" and the Balance headline are computed by two different pipelines that can disagree.** The headline reads `daily_balances`, which for an investment account with `holding_events` comes from `rebuildInvestmentHistory` and SKIPS any day where a held symbol lacks a close on or before it (`crypto-history.ts:110-117`). The Holdings card's "market value" is an independent sum of each symbol's own latest close (`page.tsx:104`, `holdings.ts:196`), and unpriced symbols contribute `?? 0` silently. Concrete failure: a thinly-priced or delisted position (the CVX single-close case already known in this codebase) freezes the NAV curve at an old date while the market-value total keeps updating from fresher siblings — two numbers, one card, no reconciliation note. — `src/app/accounts/[id]/page.tsx:103-104, 187-189`
13. **[MEDIUM] The brush gesture exists with none of the payoff its sibling surface has.** BalanceChartPanel passes `selectable` (`BalanceChartPanel.tsx:218`) so the account chart offers drag-to-zoom, From/To inputs and Reset — but passes no `history` prop, so the Back/Forward timeframe chips never render (`ScrubChart.tsx:856`), and there is no linked panel. CONFIRMED live: 0 matches for /In this window/ and 0 "Timeframe history" groups after brushing. On the dashboard the identical gesture produces a full cash-flow breakdown of the window plus back/forward navigation (`e2e/zz-period-activity.spec.ts:37-76`). The account page teaches the gesture and then does nothing with it. — `src/components/accounts/BalanceChartPanel.tsx:207-223`
14. **[MEDIUM] No error, loading, or empty states were designed for this route.** There is no `error.tsx`, no `global-error.tsx` and no `loading.tsx` anywhere under `src/app` (verified by find) — so every RSC throw is a full-page hex-coded crash and every navigation to a heavy account (`accountSeries` reads ~780 daily rows, `listAnchors` 27+, plus a full categories scan at `page.tsx:107`) shows the previous page frozen with no skeleton. Within the page, three whole sections vanish without a placeholder: the chart when `series.length <= 1` (`page.tsx:166`), Holdings when empty (`page.tsx:183`), Recent transactions when empty (`page.tsx:195`). A newly created account renders as a near-blank page with a form on it. — `src/app/accounts/[id]/page.tsx:166, 183, 195`
15. **[MEDIUM] Successful anchor writes are silent while every other mutation on the page toasts.** `addAnchorAction`, `deleteAnchorAction` and `setAccountActiveAction` all return void and only `revalidatePath` (`actions.ts:72-102`). `renameAccountAction` and `editAccountAction` return `ActionResult` and drive a toast with an Undo (`AccountNameHeading.tsx:31-35`, `EditAccountSheet.tsx:89-98`). So the four highest-consequence actions on the page — record a balance, remove a balance, archive, restore — are the four with no feedback at all. On a same-date upsert (`anchors.ts:40-44`) the page can look completely unchanged after a successful write. — `src/app/accounts/actions.ts:72-102`
16. **[LOW] The anchor date input accepts any date, including the far future.** CONFIRMED live: the date input's `max` attribute is null (`AnchorForm.tsx:17`) and `anchorFormSchema` only checks string length ≥ 10 (`actions.ts:66-70`). A typo of 2036-07-27 becomes a chain endpoint; `deriveCashSpans` then evaluates the span from the last real anchor to it, and with no transaction data in that decade it stamps every day `basis='gap'` (`derivation.ts:145-149`), silently deleting the account's recent history from the chart. — `src/components/accounts/AnchorForm.tsx:17`
17. **[LOW] Signed change chips in owed-frame read backwards at a glance.** On Chase Freedom Unlimited the page renders "Amount owed $1,041.29 · 30 days +$361.00" where the +$361.00 is red. The color is correct (ChangeChip's liability branch, `page.tsx:58`) but the glyph is not: a plus sign next to a debt figure parses as good news. Copilot and Monarch write this as "↑ $361 owed" or "$361 more owed". The chip has the semantics right and the typography wrong. — `src/app/accounts/[id]/page.tsx:55-65`
18. **[LOW] Holdings sort resets on every navigation and half the columns can't be sorted.** Sort is component-local useState defaulting to value/desc (`AccountHoldingsTable.tsx:34`), contradicting DataTable's own documented contract that "the page owns sort state (usually in the URL)" (`DataTable.tsx:27`). Quantity, Price and P/L carry no `sortable: true` (`AccountHoldingsTable.tsx:54,60,87`) so a user who wants to see his biggest loser first cannot. — `src/components/accounts/AccountHoldingsTable.tsx:34-111`

### Change

1. **Make the anchor form a value-returning action with field-level errors** (M) — Convert `addAnchorAction` to the `ActionResult` pattern already used by `editAccountAction` (`actions.ts:119-168`): `safeParse` instead of `parse`, wrap `parseAmountToCents` and `addManualAnchor` in try/catch, and return `{ok:false,error}` for "Cannot parse amount", "Enter credit-card balances as the positive amount owed", and an out-of-range date. Turn AnchorForm into a client component that awaits the result, renders the error under the offending Field, and toasts on success. Add `max={today}` to the date input and validate the amount client-side before submit. Do the same for `deleteAnchorAction` and `setAccountActiveAction`. Separately, add `src/app/error.tsx` (and ideally `src/app/accounts/[id]/error.tsx`) so no future throw can nuke the page again.
2. **Make the change chips basis-aware, or say why they can't be** (S) — Pass each series point's basis into the chip computation (`page.tsx:94-101` already has `series` in scope). If either endpoint of a delta is `carried` or `derived_unverified`, render the chip as "— no data since {lastExactDay}" or annotate it ("+$0.00 · carried since Jul 5") rather than printing a confident zero. Rename "Today" to the actual comparison it makes — the previous covered day — or suppress it entirely when `latest.day !== today`. This single change makes the headline as honest as the chart already is.
3. **Confirm and explain the two destructive controls** (M) — Archive: route `setAccountActiveAction` through a confirm sheet that states the consequence in money ("Archiving removes Venture X from net worth. Your net worth will read $1,041.29 higher.") and returns an `ActionResult` with a toast+Undo. Anchor remove: same treatment, with the blast radius precomputed ("Removing this anchor turns 143 days from derived to gap"). Reuse `EditAccountSheet`'s re-derive gate pattern (`EditAccountSheet.tsx:199-214`) — the page already contains the right design, it just isn't applied to the two riskiest buttons.
4. **Lift the chart window into ChartFocus alongside the range** (M) — Add `window` + `onWindowChange` to `ChartFocusRenderOpts` (`ChartFocus.tsx:30-35`) and have BalanceChartPanel pass them through to ScrubChart (which already supports the controlled seam at `ScrubChart.tsx:238, 379-383`). Then pressing Focus with a brush active shows the brushed window bigger — the thing the button promises. Do the same on the Portfolio and Holding panels so the fix is systemic.
5. **Stop the lens toggle from silently dropping the window** (S) — Once the window is lifted, pass it into ScrubTable's `windowedPoints` call (`ScrubTable.tsx:102`) so the table shows the same rows. Until then, at minimum extend the caption: when a custom window was active at toggle time, say "Balance by day — 3 months, 92 days (your Jun 4 – Jun 13 zoom was cleared)." The table's whole design premise is that it cannot lie about its window (`ScrubTable.tsx:11-29`); today it can.
6. **Put the range in the URL, like the lens** (M) — Add a `range` dimension to `ACCOUNT_VIEW_SPEC` (`accounts-view-spec.ts:15`) or read a `?range=` searchParam in `page.tsx` and pass it as ChartFocus's `defaultRange`, with the pill click writing back through `useViewState`. This makes the account view linkable and sticky and removes the last inconsistency between two adjacent controls. Note the `LENS_DIMENSION` append-only invariant (`chart-lens.ts:17-19`) — add the new dimension AFTER lens or fix the positional indexing.
7. **Make Recorded balances explain itself** (M) — Add a "winner" marker (a dot or a bold row) computed with the same `pickWinners` precedence the engine uses (`derivation.ts:23-30`), and a fourth column showing provenance — the import file name for statement/ofx anchors, linked to `/imports` (`balance_anchors.importFileId` already exists, `db/schema/balances.ts:27`). When a user records a manual balance on a date that already has a higher-precedence anchor, toast "Saved, but the statement balance for Jun 30 takes precedence." Paginate or collapse to the newest 12 with a "show all 27".
8. **Never let the whole ledger section disappear** (S) — Move the "All transactions →" link out of the `ledgerRows.length > 0` guard (`page.tsx:195`) and render an EmptyState (the component exists — `components/ui/EmptyState.tsx`, used by `/spending`) reading "No active transactions in this account" with the link and, when applicable, a count of quarantined/excluded rows for this account and a link to them. Do the same for the empty Holdings and single-point chart cases.
9. **Reconcile the two investment numbers on screen** (M) — Either compute the Holdings card total from the same NAV the headline uses, or label them distinctly ("Positions priced at their own latest close" vs "Account value, {asOfDay}") and flag unpriced symbols instead of adding them as zero (`page.tsx:104`). A row whose `latestClose` is null should render an explicit "no price" badge and be excluded from the allocation denominator with a footnote.
10. **Fix the small typographic and state leaks** (M) — Owed-frame chips: render "↑ $361 owed" / "↓ $214 paid down" rather than a signed figure (`page.tsx:55-65`). Holdings table: move sort into the URL and add `sortable` to Quantity/Price/P/L (`AccountHoldingsTable.tsx:54,60,87`). Replace the title-attribute P/L hint with a real inline control or a visible link to where average cost is set (`AccountHoldingsTable.tsx:95-97`). Add an inline "+ New institution" to the edit sheet's institution select, reusing `createInstitutionAction` (`actions.ts:200-210`). Add a "showing 10 of N" count above Recent transactions. Paginate ScrubTable at ~60 rows with a "show all".

### Add

1. **"Why is this number what it is?" — a provenance drawer on the balance headline** (L) — Make the headline figure activatable. It opens a drawer that reconstructs the level: the winning anchor it replayed from (date, source, amount), the count and sum of transactions replayed since, whether the chain closed to the cent, and how many days between here and there are carried vs derived vs missing. Every input already exists in the page's own scope (series basis, anchors, ledger rows) plus `deriveCashSpans`' own verdict (`derivation.ts:145-158`). *Why:* This is the single most valuable thing this page could do and no consumer app does it. The owner's entire stated doctrine is 'daily_balances is a derived cache; truth = transactions + anchors' — right now the page shows the cache and hides the derivation. Every other finding on this list is downstream of the user being unable to ask 'why?'
2. **An account-scoped activity panel wired to the chart brush** (L) — Port the dashboard's linked period-activity panel (`services/period-activity.ts`, `e2e/zz-period-activity.spec.ts`) to this route, scoped to one accountId: brush a window on the balance chart and get spent / earned / net / transaction count for that window, the top categories and merchants inside it, and the rows themselves. Add the Back/Forward timeframe chips by passing ScrubChart's `history` prop (`ScrubChart.tsx:184, 856`). *Why:* The brush gesture is already taught here and currently pays nothing. 'What happened during that drop?' is the first question any user asks of a balance chart, and today the answer requires leaving for `/transactions` and hand-typing a date range. This is also the biggest single sibling-parity gap on the surface.
3. **A per-account spending and income summary** (L) — A card showing this month vs last month for this account: spent, earned, net, top 5 categories, top 5 merchants, and a recurring-charges list — all as links into `/transactions?account=<id>&…`. The aggregate machinery exists (`services/spending.ts`, `services/analytics.ts`); it just has no account dimension, and `/spending` has no account filter at all (verified: `spending/page.tsx` reads only period/from/to). *Why:* 'How much do I put on this card each month?' is unanswerable anywhere in the app today. Monarch, Copilot, Mint and Lunch Money all answer it on the account page. For the owner's real usage — three checking accounts, three cards, a dad's-money pass-through — this is the missing per-account P&L.
4. **A statement / import coverage strip** (L) — A timeline showing which date spans this account has statement coverage for, which came from which file, which reconciled to the cent, which are open gaps with their `gapCents`, and how many rows are quarantined — with links to `/imports` and an inline 'Accept as-is' (`acceptGap` already exists, `import/service.ts:990-1013`). Statement periods and their reconciliation status are already stored per account. *Why:* This page is where a user goes when the balance looks wrong; the reason is almost always a missing statement or a failed reconciliation, and that information currently lives only on `/imports` with no per-account view. It also closes the 'quarantined rows are invisible from the account' hole.
5. **Ledger view of the balance: transactions with a running balance column** (M) — A table joining each active transaction to the balance after it, straight off the derived series, with basis-shaded rows so the user can see exactly where the chain stops being verified. This is the classic bank-statement register view. *Why:* Every real bank and every competitor shows a running balance next to transactions. It is also the most natural place to notice a duplicate, a missing deposit, or the exact row where a reconciliation broke — the debugging tool the owner actually needs for a statement-driven app.
6. **Account health / at-a-glance status card** (M) — One card answering: last statement imported (date + file), days since last transaction, unreviewed count for this account with a link to `/transactions?account=<id>&view=review`, uncategorized count, whether the last reconciliation closed, and whether the balance is currently carried. `unreviewedByAccount` already exists and is already used on the `/accounts` sub-cards (`institution-groups.ts` + `InstitutionCard.tsx:53-58`) — the detail page shows none of it. *Why:* A control that exists on the index card and is missing from the detail page is exactly the inconsistency the owner asked to hunt for. The review dot tells him something needs attention on `/accounts`, then the page he clicks into to do something about it has no such affordance and no link to the queue.
7. **Multi-account compare overlay on the balance chart** (M) — Let the user overlay one or more sibling accounts on this chart. ScrubChart already supports `overlays` with per-series coverage splitting and a legend (`ScrubChart.tsx:669-696`), and DashboardModePanel already drives it in accounts mode — including the primary-series rule that the longest-history series must be primary (`DashboardModePanel.tsx:76-89`). *Why:* 'Is my savings growing faster than my card balance?' needs two lines on one axis. The engine is built, tested, and in production on the dashboard; this route is the natural second consumer and it costs almost nothing to wire.
8. **Edit an existing anchor in place** (M) — Make the Balance cell in Recorded balances an `InlineEditableText` (or a date+amount inline editor) for manual anchors, reusing the same primitive as the account name (`InlineEditableText.tsx`) — correcting a typo currently means remove-then-re-add, which is two destructive-then-creative steps with two full re-derivations. *Why:* The page's own stated design principle is 'nothing read-only' (`AccountNameHeading.tsx:7-12`). The anchors table is the one thing on this page that is pure read-only, and it holds the most consequential numbers on the surface.
9. **Per-holding average cost and quantity editing from the account page** (M) — Make the Quantity and P/L cells actionable — an inline editor or a sheet that calls `upsertHolding` (`holdings.ts:88-155`) — so the 'Add an average cost to see P/L' hint has somewhere to go, plus an 'Add a holding' empty state when an investment account has none. *Why:* The hint text explicitly instructs the user to do something the page provides no way to do, and the only entry point is a form on a different route. Note: `upsertHolding` does not call `rebuildAccount`, so this must trigger a rebuild or the NAV and the flow series will disagree.
10. **A per-account notes / context field** (S) — A free-text note on the account record ('this is dad's money, it passes through', 'Citi promo run through Carson's account'), shown under the heading and surfaced in the command palette's Accounts group. *Why:* The owner's real DB is full of exactly this kind of context, currently living only in session memory and commit messages. An account is the natural home for it and it costs one column plus the inline-edit primitive that already exists.
11. **Ambitious visualization the owner asked for: a basis ribbon under the chart** (M) — A thin full-width band beneath the balance line, one segment per span, colored by basis — anchored / derived / carried / unverified — and, once gap days are re-admitted for display, a visible break for gaps. Click a segment to zoom the chart to that span; hover to read 'derived from 143 transactions, chain closed to the cent'. *Why:* This turns the app's single best idea — provable balances — into something you can SEE in one glance, on a phone, without reading a caption. It is abstract, it is beautiful, it is cheap (the data is already per-day in the series), and it fixes the straight-line-across-a-gap dishonesty at the same time.
12. **Keyboard shortcuts and a page-level command scope** (M) — Register a keyscope for this route (`lib/keyscope.ts`, `PRIORITIES.list`) with e.g. `e` to edit the account, `b` to record a balance, `t` to jump to all transactions, `f` to focus the chart, `[`/`]` to move to the previous/next account within the institution. *Why:* The app has a real, well-designed keyscope stack used by exactly five consumers, none of them a ledger detail page. Account-to-account navigation currently requires going back to `/accounts` and re-expanding an institution card every time — the highest-friction repeated action on the surface.

---

*End of part 1. Parts 2 and 3 cover the remaining routes.*


---

<div id="sec-07b"></div>

> **▼ SECTION 07b — Page by page, part 2 of 3**

# Page-by-page dossier — Part 2 of 3

Surfaces owned by this part:

- `/investments` — the portfolio surface
- `/investments/[assetType]/[symbol]` — holding detail
- `/budgets`
- `/recurring` — "Recurring & forecast"
- `/recurring/[id]` — recurring series detail

Every claim below cites `file:line`. Verdict vocabulary in the inventory tables:
**broken** (does the wrong thing), **missing-state** (a state exists in the data and not on
screen), **confusing** (works, but teaches the wrong model), **undiscoverable** (works, but the
user cannot find or decode it), **dead-end** (renders a number/row that should lead somewhere
and does not), **sensible** (leave it alone).

---

## /investments

**Purpose** — This is the owner's "am I actually making money on the market?" screen. Everything
else in MoneyApp answers "where did my cash go"; this page answers "what is my brokerage/crypto
position worth today, how did it get there, and is that skill or just deposits?" It exists because
market value is the one part of net worth that moves without a transaction — so it needs its own
valuation engine (`holding_events` × `price_cache`) and its own honesty apparatus (TWR vs XIRR vs
cost-basis P/L, all stated separately at `PortfolioStats.tsx:22-131`). Concretely: the hero chart
flips between raw Value and flow-adjusted Return (`page.tsx:154-165`), the stat row states four
different return definitions, and the holdings table / donut / P&L calendar let him drill from
"the portfolio moved $X today" down to "because NVDA moved $Y" down to "here's the ledger row."
The owner imports statements, not broker APIs, so this page is also where he manually keeps
positions in sync (`HoldingActionsMenu.tsx:44`) and pulls fresh prices (`RefreshPricesButton.tsx:60`).

**Connections**

- **Reads:** `listAccounts` filtered to active investment accounts (`page.tsx:80`) gates the whole
  surface; `portfolioOverview / portfolioSeries / portfolioReturnDays / holdingRows / topMovers /
  allocationSlices / pnlCalendarMonth / portfolioBenchmarkDays / hasBenchmark` (`page.tsx:105-131`),
  all sitting on `buildPortfolio` (`portfolio.ts:191`) over `holding_events` × `price_cache` ×
  `daily_balances`; `readSettings` for the persisted view preference and benchmark symbol
  (`page.tsx:58, 67, 72`).
- **Writes:** `addHoldingAction` → `upsertHolding` (`actions.ts:50`) mutates `holdings` and appends
  `holding_events`; `refreshPricesAction` → `refreshPrices` (`actions.ts:83`) writes `price_cache`
  AND rebuilds investment `daily_balances`, which is why it `revalidatePath("/")` — this page is the
  only place in the app that can move the dashboard's net worth without a transaction;
  `setBenchmarkAction` (`actions.ts:107`) backfills `price_cache` and writes
  `app_settings.benchmarkSymbol`; `saveViewPreferenceAction` via `useViewState` (`useViewState.ts:52`)
  writes `app_settings.viewPreferences.investments`.
- **Links out:** every holding row (`PortfolioHoldingsTable.tsx:170`), every donut legend row
  (`AllocationDonut.tsx:126`), every mover chip (`TopMovers.tsx:46`), and every day-sheet
  holding/sale row (`PnlCalendar.tsx:177, 198`) go to `/investments/[assetType]/[symbol]`; the day
  sheet's transaction rows go to the ledger via `ledgerHref` (`PnlCalendar.tsx:222`); the
  zero-account empty state links to `/accounts` (`page.tsx:94`).
- **Links in:** the nav item, the command palette's Holdings group (`command-index.ts:109-120`,
  active holdings only), and the holding page's "← All investments" back-link.
- **Not connected:** there is no link from /investments to the investment ACCOUNTS themselves, none
  to the investment transactions in bulk, and the dashboard/net-worth hero has no reciprocal "how
  much of this is market value" link back here.

**Interactive inventory**

| element | file:line | intended | verdict |
| --- | --- | --- | --- |
| HoldingForm — Asset type `<select>` (Stock/ETF/Crypto) | `src/components/investments/HoldingForm.tsx:48-52` | Classify the symbol for the (symbol, assetType) price key | **broken** — re-entering an existing symbol with the wrong asset type silently REWRITES `holdings.assetType` (`holdings.ts:110-111`) because the unique index is (accountId, symbol) with no assetType. All `price_cache` rows are keyed by (symbol, assetType), so the holding instantly loses its entire price history: value → null, chart empties, allocation drops it. No warning, no undo. |
| HoldingForm — Average cost per unit `<input>` | `src/components/investments/HoldingForm.tsx:66-71` | Broker avg cost, feeds Unrealized P/L only | **broken** — a negative value (e.g. "-5") passes the zod schema, hits `throw new Error("Average cost must be positive")` at `actions.ts:47` inside a void-returning form action, and surfaces as a Next.js error boundary — not a field message. Same for any quantity that trips `QuantityParseError` (`holdings.ts:36-45`). |
| HoldingForm — "Save holding" submit | `src/components/investments/HoldingForm.tsx:77-82` | Persist the holding + append a dated `holding_events` delta | **broken** — (a) zero success feedback: no toast, no sheet close, no form reset; (b) no confirmation and no undo for a destructive overwrite of a position; (c) it never calls `rebuildAccount`, so the flow is recorded while the NAV is not. |
| Holdings table 30d sparkline | `src/components/investments/HoldingSparkline.tsx:4-14` | Trend glance | **broken** — applies TODAY'S quantity to the last 30 closes (`portfolio.ts:597-600`), so a position bought last week displays a 30-day value history that never existed. `aria-hidden` with no tooltip, so a user cannot learn that. |
| P/L calendar — Previous / Next month buttons | `src/components/ui/CalendarGrid.tsx:135-147` | Page the month | **broken** — never disabled and unbounded. Each press fires `loadPnlMonthAction` → `pnlCalendarMonth` → a full `buildPortfolio` walk (`portfolio.ts:704`) over every holding event, even for 1998. Paging forward returns a blank grid with "Month P/L $0.00 · 0 up · 0 down" and no "no data" message. |
| "Today" stat label | `src/components/investments/PortfolioStats.tsx:26-28` | Label the day change; `dayChangeVsDay` exists to state the comparison date | **broken** — `Today{overview.dayChangeVsDay ? "" : ""}`: a dead ternary with two empty branches. The comparison date is computed (`portfolio.ts:358`) and thrown away, so a 07-18→07-19 move is labelled "Today" on 07-27. |
| ⋯ "Portfolio actions" IconButton (page header, right) | `src/components/investments/HoldingActionsMenu.tsx:30` | Open the sheet holding Refresh prices + the add/update-holding form | **undiscoverable** — an unlabeled ⋯ icon is the ONLY entry point to the page's two write actions and the only way to get fresh prices. Nothing says prices are stale or that a refresh exists. On a phone this is a 32px glyph next to the h1. |
| Chart plot area — drag-to-zoom brush → custom window | `src/components/investments/ScrubChart.tsx:436-459` | Drag a span to zoom into it | **undiscoverable** — nothing says a drag zooms. On touch it competes with page scroll, and the drag window is silently dropped whenever the user flips to the Table lens (`ScrubTable.tsx:27-29`). |
| "Updated `<time>`" stamp under the refresh button | `src/components/investments/RefreshPricesButton.tsx:69-71` | Show when prices were last pulled | **missing-state** — client-only `useState`, blank on load and after any navigation, so it can never tell you prices are 8 days old. The real as-of date exists (`overview.asOf`, `HoldingRow.quotedOn` at `portfolio.ts:536`) and is never rendered. |
| HoldingForm — "As of" date `<input>` | `src/components/investments/HoldingForm.tsx:74` | Date the quantity change occurred; drives the event timeline | **missing-state** — no `max=today`, so a future-dated trade is accepted and lands in the flow series ahead of every close. |
| From date `<input type=date>` | `src/components/investments/ScrubChart.tsx:895-903` | Type an exact window start | **missing-state** — a window holding <2 points is silently ignored (`ScrubChart.tsx:399-403`); the input reverts with no message, so a valid-looking date just does nothing. |
| To date `<input type=date>` | `src/components/investments/ScrubChart.tsx:905-913` | Type an exact window end | **missing-state** — same silent no-op as From. |
| Holdings table Price cell / "no price" warning | `src/components/investments/PortfolioHoldingsTable.tsx:116-126` | Show the latest close | **missing-state** — `HoldingRow.quotedOn` is computed (`portfolio.ts:536, 608`) and never rendered. A price from 2026-07-19 and a price from today look identical. |
| P/L calendar — month change loading state | `src/components/investments/PnlCalendar.tsx:43` | Indicate a pending month fetch | **missing-state** — `const [, startTransition]` discards `isPending`, so paging a month shows no spinner, no dimming. The day sheet DOES render "Loading…" (`:127`), so the asymmetry is visible within one component. |
| Zero-HOLDINGS state (accounts exist, no positions) | `src/app/investments/page.tsx:166-197` | Guide a user with an empty portfolio | **missing-state** — a gray sentence, then a `PortfolioStats` row of four em-dashes, then an empty holdings table, then "Allocation appears once…", then a blank P/L calendar with "$0.00 · 0 up · 0 down". Five dead modules and no CTA. |
| "Refresh prices" button | `src/components/investments/RefreshPricesButton.tsx:60-68` | Force a live quote, backfill missing closes, rebuild investment `daily_balances`, toast the outcome | **confusing** — the single most important control on the page (the only thing that un-stales every number), buried two interactions deep with no urgency signal. It also silently repairs the add-holding NAV bug (`prices.ts:439`) with no indication. |
| HoldingForm — Symbol `<input>` (uppercases on change) | `src/components/investments/HoldingForm.tsx:36-45` | Ticker entry | **confusing** — no autocomplete against existing holdings, no validation feedback. A typo creates a brand-new holding with no price history rather than updating the intended one. |
| HoldingForm — Quantity `<input>` | `src/components/investments/HoldingForm.tsx:55-63` | The RESULTING total quantity (not a delta) | **confusing** — absolute set, not a trade. To record selling 20 of 100 shares the owner must type 80. Only the fine print at `:83-86` hints that a change becomes a buy/sell event. |
| Benchmark `<select>` ("vs S&P 500" etc.) | `src/components/investments/BenchmarkPicker.tsx:77-99` | Choose the comparison index for the Return view; persists and re-renders overlays | **confusing** — only visible in Return view AND chart lens (`PortfolioChartPanel.tsx:222`). Switching to the Table lens makes picker, legend and overlay vanish with no explanation. |
| View ViewSwitcher (Value ⇄ Return) | `src/components/investments/PortfolioChartPanel.tsx:234-242` | Flip the hero between market value and deposit-stripped return | **confusing** — the two series do not cover the same days: `points` is carried forward to today (`page.tsx:109-112`), `returnDays` stops at the last cached close (`page.tsx:113`). Switching silently changes the x-extent under an unchanged range pill. The prop doc at `PortfolioChartPanel.tsx:49` claims they are "aligned 1:1 by day". |
| Range pills 1M / 3M / YTD / 1Y / ALL | `src/components/charts/ChartRangePills.tsx:33-48` (mounted at `ScrubChart.tsx:878`, `ScrubTable.tsx:154`) | Slice the visible window | **confusing** — the only view state on this page not in the URL and not persisted (`ChartFocus.tsx:67`); `?range=` (`page.tsx:56`) is a one-time seed. Clicking 3M then reloading gives ALL. 1M/3M are trailing 30/91 DAY counts (`chart-range.ts:14-18`), never labelled as such. |
| Table lens rows (Day / Value\|Return / Basis) | `src/components/charts/ScrubTable.tsx:119-142` | The chart's window as numbers, newest first | **confusing** — unpaginated (`ScrubTable.tsx:109-113`). ALL range with ~2 years of daily points is 700+ rows on a phone, no virtualization, no page size, no CSV export. |
| Top movers Winners/Losers segmented toggle | `src/components/investments/TopMovers.tsx:23-34` | Flip the chip strip between the day's best and worst | **confusing** — component-local `useState`; not in the URL, not persisted, resets on every navigation, unlike the chart's own switchers three inches above. |
| Top movers chips (→ holding page) | `src/components/investments/TopMovers.tsx:45-54` | Open the mover's holding page | **confusing** — labelled as the day's move but computed from the two most recent CACHED closes (`portfolio.ts:643-655` via `holdingRows:581-590`), which can be a week apart. Nothing dates it. |
| Holdings table sort headers: Holding / Value / Alloc | `src/components/investments/PortfolioHoldingsTable.tsx:96,131,155` → `DataTable.tsx:202-215` | Sort the position list | **confusing** — sort state is `useState` (`PortfolioHoldingsTable.tsx:39`). Price, 30d and the metric column are not sortable, so you cannot rank by day change, P/L or realized. |
| Holdings metric column header — tap to cycle Day % → Day change → Unrealized P/L → Realized P/L | `src/components/investments/PortfolioHoldingsTable.tsx:138-148`, `src/lib/holding-cycle.ts:14-17` | Fit four metrics into one column | **confusing** — one-way cycle, no back step, no menu, no persistence. Landing on Realized P/L takes three taps and is lost on reload; it also cannot be sorted by. |
| Allocation legend rows (link + hover/focus highlight) | `src/components/investments/AllocationDonut.tsx:125-150` | Navigate to the holding and drive the highlight from the keyboard | **confusing** — uncapped: every priced holding gets a row, so a 40-position portfolio is a 40-row list in a 280px rail with no "other" bucket. No asset-class view. |
| P/L calendar legend (Gain / Loss / "Saturation = size of the move") | `src/components/investments/PnlCalendar.tsx:265-279` | Decode the heatmap | **confusing** — explains hue and saturation but never the two glyphs actually drawn in cells: the bold "!" for an inexact day (`:102`) and the corner dot for a realized sell (`:105-107`). |
| ≈ / ! honesty markers with `title=` tooltips | `PortfolioStats.tsx:35,68,113`; `PortfolioHoldingsTable.tsx:63,74,90` | Flag numbers estimated at daily closes | **confusing** — `title=` is not reachable on touch and not focusable. Two of them (`dayChangeExact`, `xirrExact`) can never fire: no producer sets `PortfolioDay.exact=false` (`portfolio.ts:159` hardcodes `exact:true`). |
| Total return stat — TWR + XIRR block | `src/components/investments/PortfolioStats.tsx:42-82` | State the flow-insensitive and money-weighted returns side by side | **confusing** — four different return definitions in one row with 11px captions, no glossary, no info popover, no link to a definition. |
| Best day / Worst day / Max drawdown strip (Return view) | `src/components/investments/ReturnViewParts.tsx:259-290` | Volatility context under the return line | **confusing** — Best/Worst name a date but are not clickable; they should open that day's P/L sheet, which already exists two sections below. |
| Realized P/L stat | `src/components/investments/PortfolioStats.tsx:103-129` | Total P/L locked in by sells | **dead-end** — the only stat with no drill-down. The holding page has a full `RealizedSalesList` (`[symbol]/page.tsx:135-137`); the portfolio has none. It also counts legs the Holdings table cannot show (`holdingRows` filters `isActive` at `portfolio.ts:569`). |
| Portfolio actions Sheet (right drawer / bottom sheet) | `src/components/ui/Sheet.tsx:80-127` | Host Prices + Add-holding sections | sensible |
| Sheet Close button / Escape / backdrop click | `src/components/ui/Sheet.tsx:52,99-111` | Dismiss the actions sheet | sensible |
| HoldingForm — Account `<select>` | `src/components/investments/HoldingForm.tsx:26-33` | Pick which investment account the position belongs to | sensible |
| "Focus the Portfolio chart" button | `src/components/charts/ChartFocus.tsx:119-126` | Expand the same chart into a native `<dialog>`, morphing via `startViewTransition` | sensible |
| Focus dialog: Close button / Escape / backdrop click | `src/components/charts/ChartFocus.tsx:140-167` | Dismiss focus view, return focus to the opener | sensible |
| Benchmark "Custom…" option → ticker `<input>` (Enter submits, Escape cancels) | `src/components/investments/BenchmarkPicker.tsx:61-76` | Type any ticker; backfills 2y of closes or rejects with a reason | sensible |
| "fetch 2 years of closes" button | `src/components/investments/BenchmarkPicker.tsx:109-117` | Backfill history for the selected symbol | sensible |
| Benchmark error `<p role="alert">` | `src/components/investments/BenchmarkPicker.tsx:101-105` | Surface a rejected symbol | sensible |
| Unit ViewSwitcher ($ ⇄ %) — Return view only | `src/components/investments/PortfolioChartPanel.tsx:225-233` | Switch the return line between cumulative dollar P/L and time-weighted percent | sensible |
| Lens ViewSwitcher (Chart ⇄ Table) | `src/components/investments/PortfolioChartPanel.tsx:243-249` | Render the same window as rows | sensible |
| Chart plot area — `role="slider"`, keyboard scrub (←/→ 1d, ↑/↓ 7d, Home/End) | `src/components/investments/ScrubChart.tsx:527-534`, `src/lib/scrub.ts` | Inspect any day; `aria-valuetext` announces day + value + delta | sensible |
| Chart plot area — pointer press/hover hairline scrub | `src/components/investments/ScrubChart.tsx:416-449` | Hover/press to read a day | sensible |
| "`<from>` – `<to>` · Reset" custom-window pill | `src/components/investments/ScrubChart.tsx:885-892` | Show and clear an active drag window | sensible |
| Holdings table row (whole row is a stretched link) | `src/components/investments/PortfolioHoldingsTable.tsx:170` → `DataTable.tsx:147-155` | Drill into a position | sensible |
| Allocation donut wedge hover (highlight + dim siblings) | `src/components/investments/AllocationDonut.tsx:103-104` | Tie a thin wedge to its name | sensible — documented at `:98-102` as unverified on touch; the legend row is the guaranteed path. |
| Allocation donut recharts Tooltip (symbol, value, %) | `src/components/investments/AllocationDonut.tsx:75-88` | Read a wedge's numbers | sensible |
| P/L calendar — day cells (click opens the day sheet) | `src/components/ui/CalendarGrid.tsx:165-193`, `PnlCalendar.tsx:59-69` | Open per-holding attribution for that day | sensible |
| P/L calendar — arrow-key roving grid nav + Home/End | `src/components/ui/CalendarGrid.tsx:93-124` | Keyboard-walk the month | sensible |
| P/L day sheet — per-holding delta rows (→ holding page) | `src/components/investments/PnlCalendar.tsx:176-184` | Attribute the day's move to symbols | sensible |
| P/L day sheet — realized-sale rows (→ holding page) | `src/components/investments/PnlCalendar.tsx:196-207` | Show what was locked in that day | sensible |
| P/L day sheet — transaction rows (→ filtered ledger) | `src/components/investments/PnlCalendar.tsx:219-229` | Jump to the day's investment transactions | sensible — the best drill-through on the page, and the only link from /investments into the ledger. |
| Decomposition bar (contributions vs market gains) | `src/components/investments/ReturnViewParts.tsx:300-346` | Split value into capital in and market P/L | sensible |
| Benchmark / replay legends | `src/components/investments/ReturnViewParts.tsx:181-256` | Name the You vs benchmark lines and state the benchmark's own baseline day | sensible |
| Zero-account empty state + "Go to Accounts →" link | `src/app/investments/page.tsx:89-100` | Route a first-time user to create an investment account | sensible |

**Good**

1. The four-return discipline is genuinely rare and worth protecting: TWR, XIRR, unrealized
   cost-basis P/L and realized P/L are stated as four separate facts with their own captions and
   never summed (`PortfolioStats.tsx:22-131`). Propagate this "state the basis next to the number"
   habit everywhere.
2. One panel renders in both the inline card and the focus dialog (`ChartFocus.tsx:127` and `:169`
   call the same `renderPanel`), so view/unit/lens/benchmark parity is structural rather than
   re-implemented.
3. The table lens re-uses the chart's OWN `summarize`, `renderHeader` and `formatValue` function
   objects (`ScrubTable.tsx:44-53`, wired at `PortfolioChartPanel.tsx:269-280`) and slices with the
   same pure `windowedPoints` — the numbers cannot drift from the line by construction. Best piece
   of engineering on the surface.
4. The `fellBack` caption (`ScrubTable.tsx:147-149`) refuses to name a window it isn't showing.
   Propagate that instinct to the range pills, which currently stay visually pressed while the chart
   silently shows everything.
5. The allocation donut's hover/focus highlight dims only wedges and swatches, never label text
   (`AllocationDonut.tsx:133-149`), so contrast can't regress in any highlight state — and focus,
   not a parallel set of SVG tab stops, drives it. Pinned at `zz-investments.spec.ts:157-188`.
6. The benchmark legend names the benchmark's OWN first-priced day rather than claiming "all time"
   (`ReturnViewParts.tsx:244-251`), because the 2-year backfill cap can start it later than the
   portfolio's baseline.
7. The P/L calendar puts the exact value in the cell's `aria-label` rather than printing unreadable
   text on a saturated tint (`PnlCalendar.tsx:71-86`), and the day sheet's per-holding deltas
   telescope to the header (`portfolio.ts:773-789`).
8. `setBenchmarkAction` refuses to persist a symbol it could not price (`actions.ts:114-124`) and
   returns the reason. Copy this "validate before persist, return the reason" shape into the
   add-holding action, which has none of it.
9. The refresh path degrades to cached prices on a provider outage and reports it as a neutral toast
   rather than an error page (`RefreshPricesButton.tsx:31-54`, `actions.ts:81-98`).

**Bad** (ranked)

1. **CRITICAL — Adding a holding through the UI fabricates a loss (and can truncate the whole
   account's history).** `addHoldingAction` calls `upsertHolding` and then only `revalidatePath`
   (`src/app/investments/actions.ts:50-61`). `upsertHolding` appends a `holding_events` row
   (`holdings.ts:134-151`) and never calls `rebuildAccount`. But `flowsByDay` reads `holding_events`
   directly (`portfolio.ts:71-108`) while `buildAccountBook` reads NAV from the `daily_balances`
   cache (`portfolio.ts:128-163`). So the moment you save a position, a flow exists for a day whose
   NAV did not move — and `returnCents = nav − prevNav − flow` (`portfolio-returns.ts:79-83`)
   subtracts the entire purchase from that day's return. Add 1 AAPL dated 2026-07-17 through the ⋯
   sheet: the value chart does not move, but that day's P/L flips from −$1,597.79 to −$1,931.53 and
   headline TWR drops 6.485% → 6.084%. Worse, if the symbol has no cached closes,
   `rebuildInvestmentHistory` skips every day where any held symbol lacks a close
   (`crypto-history.ts:110-117`) on the next refresh, truncating the account's `daily_balances` at
   the day before — portfolio value falls from $88,968 to $47,087 and `netWorthSeries`' trailing
   carry-forward re-marks those days `complete:true, missingAccounts:[]`
   (`derivation.ts:315-331`), so nothing on any screen warns. Self-heals only if the owner happens
   to press Refresh prices.
2. **HIGH — The add-holding form has no error path, no success path, and no undo for a destructive
   overwrite.** `<form action={addHoldingAction}>` (`HoldingForm.tsx:24`) binds a `Promise<void>`
   server action that throws on failure: zod (`actions.ts:33`), `"Average cost must be positive"`
   (`actions.ts:47`), `QuantityParseError` (`holdings.ts:36-45`), `"Holdings belong to investment
   accounts only"` (`holdings.ts:93`). Fat-finger a minus into avg cost → the whole route
   error-boundaries. On SUCCESS nothing happens visibly: no toast, sheet stays open, fields keep
   their values, so a double-tap is easy. And because Quantity is an absolute set, typing 8 when you
   meant 80 appends a −72-share sell event that rewrites realized P/L, with no confirmation, no undo,
   and no delete path for holdings or holding_events anywhere in the UI.
3. **HIGH — Asset type is silently rewritable and orphans the holding's entire price history.** The
   `holdings` unique index is (account_id, symbol) with no asset_type, while every price/return path
   keys on (symbol, assetType) — `holdingRows` (`portfolio.ts:577`), `closeOn` (`portfolio.ts:864`),
   `benchmarkAssetType`. `upsertHolding` unconditionally sets `assetType: parsed.assetType`
   (`src/services/holdings.ts:110-111`). Re-enter ETH to update the quantity while the Asset type
   select has re-defaulted to "Stock" (`HoldingForm.tsx:49`, first option, no `defaultValue` bound to
   the existing holding): the row becomes a stock, every `price_cache` row for (ETH, crypto) is
   unreachable, the holding renders "no price" (`PortfolioHoldingsTable.tsx:124`), drops out of the
   donut (`portfolio.ts:902`), drops out of movers, and the account's NAV rebuild starts skipping
   days. No warning at any step.
4. **HIGH — Realized P/L headline does not reconcile to anything the page can show, and closed
   positions are unreachable.** `portfolioOverview.realizedPlCents` walks EVERY leg in
   `holding_events` (`portfolio.ts:462, 424-434`), but `holdingRows` filters `isActive = true`
   (`src/services/portfolio.ts:569`) and `allocationSlices`/`topMovers` build on it. On the owner's
   real book that is $3,018.13 across 34 legs in the header vs $1,941.42 visible across the 9 active
   rows — $1,076.71 living in 25 fully-closed positions that have no row, no list, and no link.
   `/investments/stock/GOOG` resolves (`holding-detail.ts:162`) but is reachable from nowhere: the
   palette's Holdings group also filters `isActive` (`command-index.ts:99`). Compounding it, the
   header carries "≈" (`realizedPlExact=false`) solely because of a closed CVX leg with one cached
   close — every visible row reads exact, so the marker is unexplainable.
5. **HIGH — Stale prices are presented as "Today" and the as-of date is computed but never
   rendered.** `price_cache`'s newest close can be days old (no automatic refresh exists).
   `overview.dayChangeVsDay` names the comparison day (`portfolio.ts:355-358`) but
   `src/components/investments/PortfolioStats.tsx:27` renders `Today{overview.dayChangeVsDay ? "" :
   ""}` — a dead ternary, so the date is discarded. `HoldingRow.quotedOn` (`portfolio.ts:536, 608`)
   is likewise never rendered. `RefreshPricesButton`'s "Updated `<time>`" is client `useState`
   (`RefreshPricesButton.tsx:22`) and blank on every fresh load. On 2026-07-27 with prices last
   cached 2026-07-19 the page states "Today +$412.18 (+0.46%)", the movers strip labels an eight-day
   move as the day's, and the only truthful cue is the dashed tail on the Value chart — which the
   Return view does not have because `returnDays` is not carried forward (`page.tsx:113`).
6. **MEDIUM — The value chart discards per-day account-coverage honesty.** `portfolioSeries` computes
   `complete = coveredAccounts === totalAccounts` (`portfolio.ts:242-248`); `src/app/investments/page.tsx:110`
   maps it to `{ day, valueCents }` only, and `carryForwardTo` then stamps every real point
   `complete: true` (`price-series.ts:40`). A brokerage held since 2023 plus a crypto account added in
   2026 draws 2023-2025 as a solid, exact line with the table lens's Basis column reading "exact".
   The dashboard's net-worth chart is scrupulous about exactly this.
7. **MEDIUM — The range pill is the only view state on the page that is neither shareable nor
   persisted.** `ChartFocus` owns the range in plain `useState(defaultRange)`
   (`src/components/charts/ChartFocus.tsx:67`) and `?range=` is read once as a seed (`page.tsx:56`),
   while `view`, `unit`, `lens` and `bench` all round-trip (`page.tsx:60-73`,
   `useViewState.ts:44-56`). Set 3M then switch Value→Return: `setView` navigates to a href built
   from `viewBaseParams`, which still carries the RSC-time range (`page.tsx:75-78`,
   `PortfolioChartPanel.tsx:136`). The URL advertises a range the chart is not on.
8. **MEDIUM — The Table lens deletes the benchmark comparison rather than tabulating it.**
   `src/components/investments/PortfolioChartPanel.tsx:222` gates the picker on `!isTable`, both
   legends are gated at `:252, :260`, and `ScrubTable` has no `compareLine` prop at all
   (`ScrubTable.tsx:37-69`). The one framing where a table is strictly better than a chart — "show me
   my % vs SPY's % by day" — is the one the table refuses to render.
9. **MEDIUM — P/L calendar month paging is unbounded, un-indicated, and expensive.** Chevrons are
   never disabled (`CalendarGrid.tsx:135-147`); each press calls `loadPnlMonthAction` →
   `pnlCalendarMonth` → `buildPortfolio(db)` (`portfolio.ts:704`), a full re-walk plus
   `realizedSalesByDay`, and `src/components/investments/PnlCalendar.tsx:43` discards `isPending`.
   Holding the chevron down is a trivial way to pin the process.
10. **MEDIUM — The 30-day row sparkline shows a value history that never happened.** `holdingRows`
    builds `sparkline` as `closes.slice().reverse().map(c => valueCentsOf(r.quantityE8, c.close))`
    (`src/services/portfolio.ts:597-600`) — today's quantity applied retroactively to 30 closes, and
    coloured green/red by that fictitious start-to-end delta (`HoldingSparkline.tsx:7`).
11. **MEDIUM — The zero-holdings state is five dead modules and four em-dashes.**
    `src/app/investments/page.tsx:166-197`: a gray sentence, a `PortfolioStats` row reading
    "$0.00 —", "—", "—", "—" (`PortfolioStats.tsx:96, 120`), an empty holdings table, "Allocation
    appears once holdings have cached prices", and a blank P/L calendar footer. The ⋯ menu is
    mentioned exactly once, inside the table's own empty string (`PortfolioHoldingsTable.tsx:171`).
12. **MEDIUM — The whole ≈ / exact honesty apparatus is permanently inert in the return path.**
    `buildAccountBook` hardcodes `exact: true` on every `PortfolioDay`
    (`src/services/portfolio.ts:159`) and no producer ever sets it false. So `overview.dayChangeExact`
    (`portfolio.ts:357`), `overview.xirrExact`, and `PnlDayCell.exact` are always true, and the
    tooltips at `PortfolioStats.tsx:34-38` and `:67-73` plus the bold "!" at `PnlCalendar.tsx:102`
    can never fire.
13. **MEDIUM — Three page-level toggles hold state the URL and app_settings never see.** Holdings
    sort (`src/components/investments/PortfolioHoldingsTable.tsx:39`), metric cycle (`:38`), and the
    movers side (`TopMovers.tsx:13`). Cycle the metric to Realized P/L (three taps), open a holding,
    hit Back — the column is on Day % again, sort is Value desc, movers is Winners. The chart's own
    switchers three inches above persist correctly, so the page teaches two contradictory rules.
14. **LOW — Value ⇄ Return silently changes the x-extent under an unchanged range pill.** `points` is
    carried to today (`page.tsx:109-112`); `returnDays` is not (`page.tsx:113`). `HoldingChartPanel`
    guards this exact hazard with `resetRangeKey`; `PortfolioChartPanel` passes none (`:209-212`),
    and the prop doc at `src/components/investments/PortfolioChartPanel.tsx:49` asserts they are
    "aligned 1:1 by day".
15. **LOW — Honesty markers are undecodable on the phone the owner actually uses.** Every ≈
    explanation is a `title=` attribute (`src/components/investments/PortfolioStats.tsx:35, 68, 113`;
    `PortfolioHoldingsTable.tsx:63, 74, 90`), and the spans are not focusable. The calendar's "!"
    (`PnlCalendar.tsx:102`) and realized dot (`:105-107`) have no explanation at all.
16. **LOW — Drag-to-zoom and the date inputs fail silently.** `applyWindow` returns without any state
    change when the requested span holds fewer than two points
    (`src/components/investments/ScrubChart.tsx:399-403`); the input snaps back with no message.
    Same for a hair-thin drag (`:459`).

**Change** (ranked by value ÷ effort)

1. **Make the add-holding action rebuild the account and report its result.** (M) In
   `addHoldingAction` (`actions.ts:50-61`) call `rebuildAccount(db, parsed.accountId)` after
   `upsertHolding`, and convert to the app's `ActionResult<T>` + `useActionState` + toast shape used
   everywhere else (compare `setBenchmarkAction`, `actions.ts:107-136`). Catch `QuantityParseError`
   and the avg-cost guard and return them as field-level messages instead of throwing
   (`actions.ts:47`). On success, toast, close the sheet, reset. Add a pre-save diff line to
   `HoldingForm` — "AAPL: 100 → 80 (sell 20 on 2026-07-27)".
2. **State the as-of date everywhere a price-derived number appears.** (S) Render
   `overview.dayChangeVsDay` in the Today label (replace the dead ternary at `PortfolioStats.tsx:27`
   with e.g. "Since Jul 19"), render `HoldingRow.quotedOn` in the Price cell
   (`PortfolioHoldingsTable.tsx:116-126`), date the Top movers heading, and add a persistent
   "Prices as of `<date>` · Refresh" line in the page header — warning-toned when `overview.asOf` is
   more than 1 trading day behind today.
3. **Surface Refresh prices as a first-class control, not a sheet item.** (S) Move
   `RefreshPricesButton` out of `HoldingActionsMenu` (`:37`) into the page header alongside the ⋯
   (`page.tsx:144-147`), keeping the sheet copy too (additive). It is the only thing that unblocks
   stale prices and repairs the add-holding NAV desync (`prices.ts:439`).
4. **Preserve the value chart's coverage honesty.** (S) Pass `complete` (and
   `coveredAccounts`/`totalAccounts`) through at `page.tsx:110` instead of mapping to
   `{day, valueCents}`, and let `carryForwardTo` preserve an existing false rather than stamping
   `complete: true` (`price-series.ts:40`).
5. **Bound and instrument the P/L calendar's month paging.** (S) Disable Previous at the first
   portfolio month and Next at the current month (`CalendarGrid.tsx:135-147` IconButtons accept
   `disabled`), consume `isPending` (`PnlCalendar.tsx:43`), and render "No portfolio activity in
   `<month>`" when `Object.keys(cellsByDay).length === 0`.
6. **Design the zero-holdings state.** (S) When `points.length < 2` and `holdingRows` is empty
   (`page.tsx:166-197`), replace the five dead modules with one EmptyState explaining that positions
   are entered manually, not imported, plus a primary "Add your first position" opening the same
   Sheet. Keep the existing modules for the has-holdings-no-prices case.
7. **Replace `title=` honesty markers with touch-reachable disclosures.** (S) Convert every ≈ / !
   marker (`PortfolioStats.tsx:35,68,113`; `PortfolioHoldingsTable.tsx:63,74,90`;
   `PnlCalendar.tsx:102`) into a focusable button opening the existing Popover, and extend the
   calendar Legend (`PnlCalendar.tsx:265-279`) to decode "!" and the realized-sell dot. Either wire a
   real producer for `PortfolioDay.exact` (`portfolio.ts:159`) or leave a TODO saying it is always
   true.
8. **Give the Best day / Worst day stats somewhere to go.** (S) Make `ReturnStatsList`'s dates
   (`ReturnViewParts.tsx:266-281`) open the P/L day sheet that already exists (`loadPnlDayAction`,
   `actions.ts:155`).
9. **Paginate or window the Table lens.** (S) `ScrubTable` renders every windowed row
   (`ScrubTable.tsx:109-113`); cap at ~90 with a "Show all N days" expander plus "Copy as CSV".
10. **Add a pending indication to the view switchers.** (S) `useViewState` returns `isPending` and
    `PortfolioChartPanel` discards it (`:93`); pass it to `ViewSwitcher`'s existing `disabled` prop.
11. **Put the range pill in the URL and app_settings like every other view dimension.** (M) Lift it
    out of `ChartFocus`'s `useState` (`ChartFocus.tsx:67`) — either a `{key:"range", options:
    CHART_RANGES}` dimension APPENDED to `PORTFOLIO_VIEW_SPEC` (`investments-view-spec.ts:19-24`,
    honoring the positional-index invariant at `chart-lens.ts:17-19`) or a dedicated `?range=` write
    in `selectRange`. Until then, stop emitting a stale `range` into `viewBaseParams`
    (`page.tsx:75-78`).
12. **Give Realized P/L a drill-down and stop hiding closed positions.** (M) Make the stat a
    link/disclosure opening a portfolio-wide realized-sales list, reusing `RealizedSalesList`
    (`[symbol]/page.tsx:135-137`) fed by `portfolioRealizedPl(db).byLeg`. Add a "Closed positions"
    section (or a Holdings toggle "Show closed") for legs with `isActive = false`, and widen the
    palette's Holdings group beyond `isActive` (`command-index.ts:99`).
13. **Make the sparkline honest about quantity.** (M) Build it from the quantity actually held each
    day (replay `holding_events` the way `holdingReturnDays` already does,
    `holding-returns.ts:51`) rather than `portfolio.ts:597-600`. If too costly per row, truncate at
    the position's first event day.
14. **Carry the benchmark into the Table lens.** (M) Add an optional `compareColumn` to `ScrubTable`
    (`ScrubTable.tsx:37-69`) rendering the benchmark's per-day value from the same `compareLine.byDay`
    map, and drop the `!isTable` gate at `PortfolioChartPanel.tsx:222`.
15. **Persist the holdings sort, metric and movers side.** (M) Move the three `useState` toggles
    (`PortfolioHoldingsTable.tsx:38-39`, `TopMovers.tsx:13`) into the URL view-state model or at
    minimum `app_settings.viewPreferences.investments`. Make the metric column sortable, and add
    standing Realized/Unrealized columns at lg+ where the width compromise
    (`holding-cycle.ts:6-7`) is unnecessary.
16. **Guard asset type on an existing symbol.** (M) In `upsertHolding` (`holdings.ts:108-118`),
    refuse to change `assetType` on a row that has `holding_events` or cached prices — mirroring
    `accounts.ts:206-218` where an investment account's type is blocked to protect a derived cache.
    Return a typed error ("ETH is already tracked as Crypto"). Prefill Account/Asset type/Quantity/Avg
    cost from the matching holding as soon as the symbol resolves.

**Add** (ranked)

1. **A real trade entry path: Buy / Sell / Dividend, with a trade log and delete.** (L) Today the
   only write is "set the resulting total quantity" (`HoldingForm.tsx:55-63`), there is no delete for
   a holding or a `holding_event` anywhere in the UI, and no importer creates `holding_events`. Add a
   Buy/Sell form taking shares + price + date and deriving the delta, plus a portfolio-wide trade log
   (the per-holding `HoldingEventsList` already exists) with row-level edit/delete behind a confirm.
   Store the execution price so realized P/L stops being an estimate at daily closes. *This is the
   surface's biggest structural hole.*
2. **A "Prices are stale" banner with automatic refresh on visit.** (S) Compare `overview.asOf` to
   the last weekday and render a dismissible banner offering a one-tap refresh, plus an opt-in
   setting to refresh on load when the cache is older than N hours (`refreshPrices` already has a
   staleness window; only the manual button passes `force: true`, `actions.ts:83`).
3. **Account filter / per-account portfolio scope.** (S) `buildPortfolio`, `portfolioSeries` and
   `portfolioReturnDays` already accept an optional `accountIds` scope (`portfolio.ts:191, 240, 252`)
   and it is used nowhere. Add a URL-driven account chip filter scoping the whole surface.
4. **A portfolio-level "why did this move?" explanation strip.** (S) Under the hero, a sentence from
   `pnlDayDetail` for the latest day: "Up $412 since Jul 19 — NVDA +$580, ETH −$210, everything else
   flat." Same data the day sheet renders (`PnlCalendar.tsx:169-185`), hoisted to where the number
   lives.
5. **Export: CSV of holdings, of the value/return series, and of realized sales.** (S) Everything on
   this page is derived from data only this app holds and there is currently no way to get any of it
   out.
6. **Asset-class and account allocation views on the donut.** (M) `allocationSlices` aggregates by
   (assetType, symbol) only (`portfolio.ts:901-921`). Add a ViewSwitcher — By holding / By asset class
   / By account — with a top-N + "Other" rollup and a drill from a class wedge into its holdings.
7. **Contributions vs market gains over time, as its own chart.** (M) `decomposeValue` already
   computes gross contributed / withdrawn / net contributed / gains with an exact identity
   (`portfolio-returns.ts:249`, rendered as a static bar at `ReturnViewParts.tsx:300-346`). Promote it
   to a third `view` option: a stacked area across time, scrubable like the others.
8. **A dividend / income section.** (M) The pnl day sheet already surfaces investment-side
   transactions (`portfolio.ts:794-800`) and `description-key.ts:20-44` special-cases brokerage
   DIV/DRIP rows. Add trailing-12-month dividends, per-holding yield on cost, and an
   upcoming-dividend row.
9. **Per-holding drill-down from the P/L calendar to a symbol×day matrix.** (M)
   `holdingDeltasBetween` already computes per-symbol deltas for a single day (`portfolio.ts:834`);
   a symbols × days heatmap answers "which holding has been consistently bad".
10. **Multi-benchmark comparison and a "you vs" summary row.** (M) `portfolioBenchmarkDays`
    (`portfolio.ts:262`) is already generic over symbol; `ScrubChart` already supports named
    `overlays` (`ScrubChart.tsx:294-322`). Allow 2-3 overlays plus a You / SPY / QQQ / BTC table
    reusing `returnStats`.
11. **Wide-screen layout for the portfolio.** (M) The shell caps main at `max-w-5xl`
    (`AppShell.tsx:32,65`) and this page is one column. On a monitor, chart and P/L calendar side by
    side, standing metric columns instead of the cycle, donut with legend beside it.
12. **Memoize the per-render portfolio walk.** (M) One render calls `buildPortfolio` at least four
    times and `portfolioRealizedPl` five, each re-walking all 1,991 holding events with one `closeOn`
    query per event (`portfolio.ts:86`). Measured ~268ms of synchronous better-sqlite3 work per render
    on the real DB. Add a request-scoped cache (React `cache()`) and reuse `holdingRows` across
    allocation/movers.
13. **Position-level cost basis and tax lots.** (L) Unrealized P/L uses the single broker-supplied
    `holdings.avgCostCents` (`portfolio.ts:591`) while realized P/L uses an average-cost walk at
    closes (`realized-pnl.ts`) — two incompatible bases sitting adjacent in the stat row
    (`PortfolioStats.tsx:84-129`). Add per-lot tracking and a short-term/long-term split.

---

## /investments/[assetType]/[symbol]

**Purpose** — The "what is my money actually doing inside ONE security" page — the only screen in
MoneyApp that aggregates a symbol across every account (`holding-detail.ts:139-160` keys on
assetType+symbol, never accountId) and answers four separate questions: what is it worth
(PositionCard), what did the price do (Price chart), what did MY dollars do in it (Return chart,
flow-adjusted at daily closes), and what did I actually lock in (Realized P/L + trade history). It
exists because the /investments index can only show one row per (account, symbol) and one number per
row. In practice it is the "should I still own this / did I beat SPY / where did the $3k of realized
gains come from" page, and the only place per-account basis books, XIRR and individual sells are ever
visible.

**Connections**

- **Reads:** `holdingDetail` (`services/holding-detail.ts`) joining `holdings` + `holding_events` +
  `price_cache` + `accounts`, and calling `holdingRows(db)` (`portfolio.ts:554`) purely for the
  diversity percentage — dragging the ENTIRE portfolio's realized-P/L walk into this page's render.
  Also `readSettings` (`viewPreferences["holding"]`, `benchmarkSymbol`),
  `hasBenchmark`/`portfolioBenchmarkDays`, and the pure libs `holding-returns.ts`,
  `portfolio-returns.ts`, `benchmark-replay.ts`, `price-series.ts`, `realized-pnl.ts`, `xirr.ts`.
- **Writes:** nothing directly. The only mutation reachable is `setBenchmarkAction`
  (`app/investments/actions.ts:107`) via `BenchmarkPicker`, persisting `app_settings.benchmarkSymbol`
  and possibly backfilling `price_cache`; `useViewState` also fire-and-forget writes
  `app_settings.viewPreferences.holding` (`settings/actions.ts:72`).
- **Links in:** `PortfolioHoldingsTable` rowHref (`:170`), `AllocationDonut` legend (`:126`),
  `TopMovers` chips (`:47`), `AccountHoldingsTable` rowHref (`:121`), and the ⌘K palette Holdings
  group (`command-index.ts:117`). **Every one of those five filters `holdings.isActive`, so a
  fully-closed position has NO inbound link.**
- **Links out:** exactly three destinations — `/investments` (breadcrumb `page.tsx:89`, footer
  `page.tsx:139`), and `/transactions?q=SYMBOL&from=&to=` per trade row
  (`holding-detail.ts:282-284`) plus "view all trades". Nothing links to `/accounts/[id]`, to sibling
  holdings, or back to where the user came from.

**Interactive inventory**

| element | file:line | intended | verdict |
| --- | --- | --- | --- |
| PositionCard — "Today" (return $ + %) | `src/components/investments/PositionCard.tsx:50-59` | Today's move on the shares held entering the day | **broken** — it is not today. `holding-detail.ts:189-196` computes it from the last two rows in `price_cache`; with prices days old it labels a stale close-to-close move "Today". `detail.quotedOn` exists and is never shown, and there is no Refresh-prices control on this route. |
| Buy/sell trade marks on the price line | `src/components/investments/ScrubChart.tsx:784-794` | Pin every trade onto the price history | **broken** — non-interactive `ReferenceDot`s: no hover, no label, no accessible name, no quantity. `page.tsx:81-83` drops any mark whose `closeCents` is null, and `holding-detail.ts:265` only sets `closeCents` on an EXACT cached close day (no carry-forward, unlike `carriedCloseCents` at `:233-248`). A symbol whose price backfill is narrower than its trade history shows "12 trades" and zero dots. |
| 404 path (unknown symbol / asset type / any thrown error) | `src/app/investments/[assetType]/[symbol]/page.tsx:44-50` | `notFound()` on an unknown holding | **broken** — the bare catch swallows EVERY exception, including a real DB failure inside `holdingRows`/`portfolioRealizedPl`. There is no `not-found.tsx`, `loading.tsx` or `error.tsx` anywhere under `src/app` (verified by find), so the result is Next's default 404 with no breadcrumb and no route back. |
| "fetch 2 years of closes" button | `src/components/investments/BenchmarkPicker.tsx:109-116` | Backfill price history for a benchmark with no cached closes | **broken** — `pick(value)` with the already-active symbol → `setBenchmarkAction` (`actions.ts:107`) `revalidatePath("/investments")` ONLY (`actions.ts:131`), which does not cover this route, then `router.push(hrefFor(value))` targets the URL the user is already on. The closes land in `price_cache` but the overlay and the "No price history for X yet" line can stay exactly as they were. |
| Focus dialog content region | `src/components/charts/ChartFocus.tsx:169` | Render the SAME panel taller (`h-[55vh]`) | **missing-state** — unlike /investments, which passes `PortfolioStats` as ChartFocus's `footer` (`page.tsx:164` → `PortfolioChartPanel.tsx:308`, pinned by `zz-investments.spec.ts:93`), `PositionCard` is a sibling OUTSIDE `ChartFocus` (`page.tsx:128`). Opening focus hides quantity, market value, avg cost, total return and XIRR. |
| Chart plot — drag-to-zoom brush | `src/components/investments/ScrubChart.tsx:436-459` | Drag past `SELECT_DRAG_PX` to zoom into a custom window | **missing-state** — the custom window is local `ScrubChart` state, not lifted; toggling the lens to Table drops it back to the range pill (`ScrubTable.tsx:27-29`) with no notice, and it is never in the URL. |
| Chart range pills 1M / 3M / YTD / 1Y / ALL | `src/components/investments/ScrubChart.tsx:878-883` + `ChartRangePills.tsx` | Select the visible window; shared with the focus modal | **missing-state** — the only view state NOT in the URL on this route. `/investments` reads `?range=` (`page.tsx:56`); the holding page never reads a range param and hardcodes `defaultRange="ALL"` (`HoldingChartPanel.tsx:269`). "AAPL over 3 months" is unshareable and resets on every navigation. |
| Table lens — day rows (newest first) | `src/components/charts/ScrubTable.tsx:109-113,156` | Raw numbers behind the line | **missing-state** — unpaginated. ALL range for a two-year holding is 700+ DOM rows on a phone, and the rows are entirely non-interactive — a day with a trade cannot be opened. |
| PositionCard — Quantity | `src/components/investments/PositionCard.tsx:39-41` | Aggregated shares across active legs | **missing-state** — a fully-closed position renders "0" with no "Closed position" treatment (`holding-detail.ts:176-177` sums only isActive legs). |
| PositionCard — Market value | `src/components/investments/PositionCard.tsx:42` | qty × latest close | **missing-state** — no as-of date. `detail.quotedOn` is computed (`holding-detail.ts:299`) and rendered by nothing (verified by grep across `src/`). |
| "View all N trades in the ledger →" | `src/components/investments/HoldingEventsList.tsx:75-82` | Escape hatch past the 40-row cap | **missing-state** — gated on `hidden > 0`. A holding with ≤40 trades has no card-level route to its ledger rows at all. |
| Pre-chart fallback card | `src/app/investments/[assetType]/[symbol]/page.tsx:120-126` | Explain why no chart when <2 cached price days | **missing-state** — replaces the WHOLE panel, removing the lens switcher, the Return view and the table even when `detail.returnDays` is chartable. No action: no Refresh prices, no link to fetch history. |
| Keyboard shortcuts on this route | `src/components/shell/KeyScopeProvider.tsx` (no consumer on this page) | Per-surface mnemonics like ReviewInbox's `r` or the ledger's `x` | **missing-state** — this route registers no key scope at all. No shortcut to flip Price⇄Return, toggle the lens, or open focus. |
| Asset-type pill (Stock / ETF / Crypto) | `src/app/investments/[assetType]/[symbol]/page.tsx:94-96` | Classify the holding | **undiscoverable** — styled as a rounded chip identical to the app's interactive pills but is an inert `<span>`. Nothing filters by asset type from here. |
| Breadcrumb "Investments" link | `src/app/investments/[assetType]/[symbol]/page.tsx:89` | Return to the portfolio index | **confusing** — hardcoded to `/investments` regardless of entry point. `AccountHoldingsTable.tsx:121` routes here from `/accounts/[id]`; both exits dump the user on the portfolio index. |
| "Focus the Holding chart" button | `src/components/charts/ChartFocus.tsx:119-126` | Expand the chart into a full-width modal | **confusing** — `HoldingChartPanel.tsx:267` passes the literal `label="Holding"`, so the opener announces "Focus the Holding chart" and the dialog "Holding chart — focus view". It names neither the symbol nor the active view, contradicting ChartFocus's own contract at `ChartFocus.tsx:47-49`. |
| ViewSwitcher "Holding chart view" (Price / Return) | `src/components/investments/HoldingChartPanel.tsx:292-300` | Switch per-share price ⇄ flow-adjusted position return; URL + persisted | **confusing** — the preference is persisted for the whole "holding" SURFACE (`investments-view-spec.ts:37`), so leaving one holding on Return silently opens EVERY holding on Return. In Return view no per-share price appears anywhere on the page. |
| Table lens — "Trade" column (Buy / Sell / —) | `src/components/investments/HoldingChartPanel.tsx:243-261` | Name a trade day in rows since the plot pins it as a dot | **confusing** — built from `markByDay` over the ALREADY-FILTERED marks prop, inheriting the dropped-trade problem and disagreeing with the Trade history card below. |
| Avg-cost reference line + "Avg cost" label | `src/components/investments/ScrubChart.tsx:646-653` | Show where break-even sits against the price line | **confusing** — the label prints the words "Avg cost" with no number, and `detail.avgCostLineCents` is a quantity-weighted blend across accounts that the page never states, nor the total cost basis it implies. |
| Return stats strip — Best day / Worst day / Max drawdown | `src/components/investments/ReturnViewParts.tsx:259-290` | Characterize the return series | **confusing** — computed over the FULL series (`ReturnViewParts.tsx:89` `returnStats(returnDays)`) but rendered under a chart the user just filtered to 1M (`HoldingChartPanel.tsx:373`). Nothing says these ignore the range pill. |
| Decomposition bar (Value = contributions + market gains) | `src/components/investments/ReturnViewParts.tsx:300-346` | Reconcile value into capital vs P/L | **confusing** — same all-time-under-a-windowed-chart problem (`:143-146`). Also `role="img"` with a good aria-label but zero interactivity. |
| PositionCard — Avg cost / share | `src/components/investments/PositionCard.tsx:43-49` | Weighted broker basis per share | **confusing** — the total cost basis (`detail.costCents`, `holding-detail.ts:201-204`) is computed and thrown away, so "Total return +$1,204" is shown without its denominator. |
| PositionCard — Total return ($ + %) | `src/components/investments/PositionCard.tsx:60-69` | Unrealized P/L on cost-bearing shares only | **confusing** — correctly computed (`holding-detail.ts:208-216`) but sits three cards above a Realized P/L card computed from a completely different basis, with nothing warning that the two must not be added. |
| PositionCard — Money-weighted (XIRR) + ≈ marker | `src/components/investments/PositionCard.tsx:70-83` | Annualized growth rate of the dollars, with an inexactness marker | **confusing** — explained only by a `title=` tooltip, which does not exist on touch. |
| Trade history rows → `/transactions?q=SYM&from=&to=` | `src/components/investments/HoldingEventsList.tsx:61-67` + `holding-detail.ts:282-284` | Open the source ledger rows for that trade day | **confusing** — `holding-detail.ts:268-269` drops the account filter unless the symbol has exactly one leg, so on a multi-account holding the link searches every account. Crypto rows (`linkEvents=false`, `:272`) render as inert divs that look identical to linked ones. |
| Chart plot — desktop hover-to-inspect | `src/components/investments/ScrubChart.tsx:444-448` | Hover moves the hairline (non-vivid path) | **confusing** — `vivid=false` here, so no floating ScrubTooltip and no live-today dot; the holding chart is visibly plainer than the dashboard hero for no stated reason. |
| "From date" / "To date" native date inputs | `src/components/investments/ScrubChart.tsx:895-913` | Type an exact window | **confusing** — `applyWindow` silently returns when the range holds fewer than 2 points (`:403`); the input keeps the typed value and nothing says why the chart did not move. |
| Peak / trough extreme dots + labels (Return view only) | `src/components/investments/ScrubChart.tsx:762-783` | Call out the window's best and worst point | **confusing** — `showExtremes={isReturns}` (`HoldingChartPanel.tsx:360`), so the PRICE chart, where a 52-week high/low is the most-expected annotation in the category, has none. |
| PositionCard — Portfolio diversity % | `src/components/investments/PositionCard.tsx:84-86` | This holding's share of total priced portfolio value | **dead-end** — the most expensive number on the page: `holding-detail.ts:219` calls `holdingRows(db)`, which runs `portfolioRealizedPl` plus one 30-close query per active holding. And it is not clickable. |
| PositionCard — "By account" leg list | `src/components/investments/PositionCard.tsx:89-104` | Split the position across accounts | **dead-end** — account names are plain text with no link to `/accounts/[id]` even though `leg.accountId` is right there (`holding-detail.ts:314`), and it only renders when `legs.length > 1`, so a single-account holding never names its brokerage. |
| Realized sale rows (qty, day, proceeds − basis, gain) | `src/components/investments/RealizedSalesList.tsx:43-69` | Drill down into every sell | **dead-end** — entirely non-interactive: no link to the ledger rows for that sale, no account attribution (though the walk is deliberately per-account, `holding-detail.ts:249-256`), and the "clamped"/"≈" explanations are `title=` tooltips. |
| Realized "N earlier sells not shown" | `src/components/investments/RealizedSalesList.tsx:71-73` | Honest truncation notice at `SALES_SHOWN=40` | **dead-end** — unlike the trade-history card it offers no "view all"; the earlier sells are unreachable in the UI. |
| Account name in the position card | `src/components/investments/PositionCard.tsx:89-104` | Say which account holds the legs | **dead-end** — see above; `holdingDetail` returns `accountId` on the leg and the UI ignores it. |
| Breadcrumb current item (symbol) | `src/app/investments/[assetType]/[symbol]/page.tsx:89` | `aria-current` page marker | sensible |
| h1 symbol | `src/app/investments/[assetType]/[symbol]/page.tsx:93` | Name the holding | sensible |
| Security display name | `src/app/investments/[assetType]/[symbol]/page.tsx:98` | Human name from the trade description | sensible — but sourced from an unindexed leading-wildcard `LIKE '%(SYM)%'` over the whole transactions table (`holding-detail.ts:117-123`). |
| Focus dialog — Escape to close | `src/components/charts/ChartFocus.tsx:132-140` | Native dialog close + focus return to opener | sensible |
| Focus dialog — backdrop click to close | `src/components/charts/ChartFocus.tsx:141-148` | Click-outside dismiss, guarded so a drag released over the backdrop does not close | sensible |
| Focus dialog — "Close focus view" button | `src/components/charts/ChartFocus.tsx:160-167` | Dismiss with the view-transition morph | sensible |
| Benchmark `<select>` | `src/components/investments/BenchmarkPicker.tsx:77-99` | Pick the Return-view comparison index | sensible — but only rendered when `canShowReturns && isReturns && !isTable` (`HoldingChartPanel.tsx:280`), so "vs the market" is undiscoverable from the default Price view. |
| Benchmark "Custom…" option → ticker text input | `src/components/investments/BenchmarkPicker.tsx:61-76` | Type an arbitrary ticker; Enter submits, Escape cancels | sensible |
| Benchmark validation error (`role=alert`) | `src/components/investments/BenchmarkPicker.tsx:101-105` | Surface a rejected ticker with the reason | sensible |
| ViewSwitcher "Return unit" ($ / %) | `src/components/investments/HoldingChartPanel.tsx:284-291` | Switch the return line between cumulative $ P/L and TWR % | sensible |
| ViewSwitcher "Holding lens" (Chart / Table) | `src/components/investments/HoldingChartPanel.tsx:301-307` | Swap the plot for the same windowed rows | sensible |
| Benchmark legend (You / SPY +X% since day) | `src/components/investments/ReturnViewParts.tsx:223-256` | Name the overlay's own basis day, never "all time" | sensible |
| Replay legend ("you'd have $X · $Y ahead/behind") | `src/components/investments/ReturnViewParts.tsx:181-216` | The $-framing counterfactual, incl. an unfundable-withdrawal shortfall | sensible |
| Chart plot — `role="slider"`, pointer press + drag scrub | `src/components/investments/ScrubChart.tsx:416-467, 525-548` | Press-and-move to inspect a day | sensible |
| Chart plot — keyboard scrub (←/→ 1d, ↑/↓ 7d, Home/End) | `src/components/investments/ScrubChart.tsx:370-375` + `src/lib/scrub.ts` | Keyboard-reachable day inspection with `aria-valuetext` | sensible |
| Custom-window "Mar 3 – Apr 9 · Reset" chip | `src/components/investments/ScrubChart.tsx:884-892` | Name the brushed window and clear it | sensible |
| Window baseline dashed reference line | `src/components/investments/ScrubChart.tsx:643-645` | Mark the window's opening value | sensible |
| Benchmark comparison dashed line | `src/components/investments/ScrubChart.tsx:655-667` | Draw SPY's rebased % or the flow-replay $ gain | sensible |
| sr-only figcaption echo of the scrubbed value | `src/components/investments/ScrubChart.tsx:926` | Deterministic readout for AT + tests | sensible |
| Table lens — shared hero header | `src/components/charts/ScrubTable.tsx:153` | Render the panel's OWN `renderHeader`/`summarize` so the table's hero IS the chart's number | sensible |
| Table lens — range pills | `src/components/charts/ScrubTable.tsx:154` | A table that respects a window must be able to change it | sensible |
| Table lens — "Basis" column (exact / carried forward) | `src/components/charts/ScrubTable.tsx:78-84,117` | Never launder a dashed day as an exact number | sensible |
| Realized P/L card header (total + "N sells · at daily closes" + ≈) | `src/components/investments/RealizedSalesList.tsx:32-41` | State the locked-in gain and the method | sensible |
| Crypto truncation notice | `src/components/investments/HoldingEventsList.tsx:83-87` | Explain why crypto trades do not link out | sensible |
| Trade history empty state | `src/components/investments/HoldingEventsList.tsx:25-32` | "No recorded trades for this holding yet." | sensible |
| "← All investments" footer link | `src/app/investments/[assetType]/[symbol]/page.tsx:139-144` | Exit back to the index | sensible — duplicates the breadcrumb; neither knows where the user came from. |

**Good**

1. The four-dimension view model is best-in-class: Price⇄Return, $⇄%, chart⇄table all resolve
   URL > persisted > default (`page.tsx:54-62`) and are shareable links, with only non-defaults in
   the URL. Monarch and Copilot do not let you deep-link a specific framing of a holding.
2. `resetRangeKey` on the Price/Return switch (`HoldingChartPanel.tsx:270` → `ChartFocus.tsx:71-77`).
   The two series are not day-aligned, so carrying "1M" across would show all-time data captioned
   "1M". Fixed AND pinned by an e2e that explains why (`zz-investments.spec.ts:103-134`).
3. The realized walk carries the last close on/before a trade day (`holding-detail.ts:233-248`) and
   keeps a basis book PER ACCOUNT (`:249-256`), with a test naming the wrong blended answer it would
   otherwise produce (`holding-detail.test.ts:143-151`).
4. "Today" credits only the shares held ENTERING the latest quoted day (`holding-detail.ts:182-192`)
   — a same-day buy is a flow, not a gain.
5. Total return compares the value of only the cost-bearing shares against their basis
   (`holding-detail.ts:208-216`) instead of whole-position value minus a partial cost.
6. `carryForwardTo` tags the flat tail `complete:false` (`price-series.ts`) and BOTH lenses name it —
   dashed on the chart, a "Basis: carried forward" column that only appears when there is actually an
   estimated day (`ScrubTable.tsx:78-84,117`).
7. `ScrubTable` renders the panel's OWN `renderHeader` + `summarize` + `formatValue` function objects
   (`ScrubTable.tsx:44-53`), so the table's hero number is literally the number the chart computed.
8. Both Return legends name their own basis day rather than claiming "all time"
   (`ReturnViewParts.tsx:223-256`), and `ReplayLegend` surfaces `shortfallCents` — "couldn't fund $X
   of your withdrawals" (`:209-210`).
9. Realized sales carry per-row "≈" (partial basis) and "clamped" (over-sell from an import gap)
   markers with explanations (`RealizedSalesList.tsx:50-61`).
10. The `holdingReturnDays` flow convention — `flow(t) = value(qty_t, close_t) − value(qty_{t−1},
    close_t)` (`holding-returns.ts:116`) — makes every trade exactly return-neutral without guessing
    an execution price, and truncates a closed position at its final trade (`:86-94`).

**Bad** (ranked)

1. **CRITICAL — The "Today" stat is not today, and the page never states its as-of date.**
   `src/services/holding-detail.ts:189-196` computes `todayReturnCents` from the last TWO rows in
   `price_cache`; `PositionCard.tsx:50` labels that block "Today". `holdingDetail` also computes
   `detail.quotedOn` (`:299`), `detail.latestClose` (`:298`), `detail.priceDayChangeCents` (`:300`)
   and `detail.priceDayChangePct` (`:301`) — a repo-wide grep confirms NONE is rendered by any
   component. With `price_cache` a week old the owner reads "Today +$412.30 (+1.84%)" on his phone
   for a move that happened seven trading days ago, and there is no Refresh-prices control on this
   route (`HoldingActionsMenu` is only on `/investments`, `page.tsx:144`).
2. **HIGH — Any exception in the page's data path renders as a 404, and there is no 404 page.**
   `src/app/investments/[assetType]/[symbol]/page.tsx:44-50` wraps `holdingDetail` in a bare
   try/catch calling `notFound()` on ANY throw. `holdingDetail` calls `holdingRows(db)`
   (`holding-detail.ts:219`) → `portfolioRealizedPl`, a full walk of every holding_event. A bad
   `price_cache` row or an unsafe-integer quantity throws, the owner clicks AAPL and gets Next's
   default "404 | This page could not be found" (no `not-found.tsx`, `loading.tsx` or `error.tsx`
   anywhere under `src/app`). He concludes his position was deleted; the real error is never logged.
3. **HIGH — Trade marks silently vanish when a trade day has no exact cached close.**
   `src/services/holding-detail.ts:265` sets a mark's `closeCents` ONLY when
   `closeByDay.has(e.occurredOn)` — an exact-day lookup with no carry-forward, unlike
   `carriedCloseCents` (`:233-248`) which the realized walk deliberately uses.
   `src/app/investments/[assetType]/[symbol]/page.tsx:81-83` then drops every mark whose `closeCents`
   is null. Result: the Trade history card says "37 trades", the chart shows zero dots, and the table
   lens's Trade column reads "—" on every row (built from the already-filtered marks prop,
   `HoldingChartPanel.tsx:242`). Three surfaces on one page disagree about how many trades exist.
4. **HIGH — Best day / Worst day / Max drawdown / Decomposition are all-time but sit under a windowed
   chart.** `src/components/investments/ReturnViewParts.tsx:89` computes `returnStats(returnDays)` and
   `:143-146` computes `decomposeValue(returnDays)` over the FULL series, ignoring the range pill;
   `HoldingChartPanel.tsx:373-374` renders both directly beneath the chart. Click "1M" on a two-year
   holding: the hero says "+$118.40 · 1M" and immediately below, "Best day +$1,840 · March 3" from 14
   months ago.
5. **HIGH — The holding detail page shows no share price and no cost basis — both computed and
   discarded.** `src/components/investments/PositionCard.tsx:38-87` renders seven stats and neither a
   Price / Last close nor a total cost basis, though `holdingDetail` computes `latestClose` (`:298`)
   and `costCents` (`:201-204`). The `/investments` holdings table DOES have a Price column
   (`PortfolioHoldingsTable.tsx:117-126`), so drilling INTO a holding loses information — and because
   the Return preference is persisted for the whole surface (`investments-view-spec.ts:37`), the app
   can end up in a sticky state where no screen in the detail route states what a share costs.
6. **MEDIUM — Closed positions hold real realized P/L, have zero inbound links, and render as an
   all-zero card.** `holdingDetail` resolves fine for a closed position (`holding-detail.ts:162`), but
   `holdingRows` (`src/services/portfolio.ts:568`), `command-index.ts:99` and by extension
   AllocationDonut/TopMovers/AccountHoldingsTable all filter `isActive`. A GOOG sold last year for a
   $780 gain is reachable only by typing the URL, and when reached `PositionCard.tsx:39-86` prints
   "Quantity 0 · Market value $0.00 · Total return — · Portfolio diversity 0.0%".
7. **MEDIUM — "fetch 2 years of closes" can leave this page stale.** `setBenchmarkAction`
   (`src/app/investments/actions.ts:107-136`) backfills then calls `revalidatePath("/investments")` at
   `:131` — never this route. `BenchmarkPicker.tsx:45` then pushes `hrefFor(symbol)`, which for the
   fetch button (`:109-116`, `pick(value)` with the already-active symbol) is the current URL. The
   action returns ok, the closes are written, and the page can re-render with the same "No price
   history for QQQ yet" line. He presses it again.
8. **MEDIUM — Every exit leads to `/investments`, and account legs are dead text.** Breadcrumb
   (`page.tsx:89`) and footer (`page.tsx:139`) both hardcode `/investments`, while
   `AccountHoldingsTable.tsx:121` routes users here from `/accounts/[id]`.
   `PositionCard.tsx:89-104` renders account NAMES as plain text despite `leg.accountId` being present
   (`holding-detail.ts:314`), and only when `legs.length > 1`.
9. **MEDIUM — Focus mode on a holding hides the position stats — the opposite of the portfolio's own
   contract.** On `/investments`, `PortfolioStats` is ChartFocus's footer (`page.tsx:164` →
   `PortfolioChartPanel.tsx:308`) and `zz-investments.spec.ts:93` asserts "footer parity". Here
   `PositionCard` is a SIBLING of the panel
   (`src/app/investments/[assetType]/[symbol]/page.tsx:128`), outside `ChartFocus`.
10. **MEDIUM — The whole portfolio is recomputed on every render to print one percentage, with no
    loading state.** `src/services/holding-detail.ts:219` calls `holdingRows(db)` solely for
    `diversityPct`; `holdingRows` (`portfolio.ts:554-620`) first runs `portfolioRealizedPl` then one
    30-row `price_cache` query PER active holding. `displayName` (`:117-123`) runs an unindexed
    leading-wildcard LIKE over the whole transactions table, and `page.tsx:70-79` computes
    `portfolioBenchmarkDays` + `benchmarkReturns` + `replayFlows` even in the default Price view.
    better-sqlite3 is synchronous, the route is force-dynamic, and there is no `loading.tsx`.
11. **MEDIUM — Four independent chart controls stack above a short plot on a phone.**
    `src/components/investments/HoldingChartPanel.tsx:279-325` puts the BenchmarkPicker `<select>`,
    the Return-unit switcher, the Price/Return switcher and the Chart/Table lens in one flex-wrap
    `justify-end` row with `pr-9` clearance. At 375px in Return/$ that is a select plus three pill
    groups above an `h-56` plot.
12. **MEDIUM — Realized and unrealized P/L use different cost bases with nothing preventing
    addition.** PositionCard's Total return uses broker `holdings.avgCostCents`
    (`holding-detail.ts:205-216`); `RealizedSalesList`'s total comes from an average-cost walk valued
    at daily CLOSES (`holding-detail.ts:249-256` → `realized-pnl.ts`). "Total return +$1,204" plus
    "Realized P/L +$780" reads as $1,984 and nothing says otherwise
    (`PositionCard.tsx:60-69`, `RealizedSalesList.tsx:32-41`).
13. **LOW — The range pill is the only view state not in the URL on this route, unlike its sibling.**
    `/investments` parses `?range=` (`page.tsx:56`); here
    `src/components/investments/HoldingChartPanel.tsx:269` hardcodes `defaultRange="ALL"` and
    `page.tsx:41-67` never reads a range param.
14. **LOW — Every holding tab is titled "Holding".**
    `src/app/investments/[assetType]/[symbol]/page.tsx:29` exports a static `metadata = { title:
    "Holding" }`; there is no `generateMetadata`.
15. **LOW — The focus modal announces "Holding", not the symbol or the active view.**
    `src/components/investments/HoldingChartPanel.tsx:267` passes `label="Holding"` to `ChartFocus`,
    whose own doc (`ChartFocus.tsx:47-49`) says the label is "the current view's name".
16. **LOW — Asset type in the URL is case-sensitive while the symbol is not.**
    `src/app/investments/[assetType]/[symbol]/page.tsx:46` uppercases the symbol but passes
    `assetType` raw to `isAssetType` (`holding-detail.ts:111-113`), which tests the lowercase
    `ASSET_TYPES` tuple. `/investments/stock/aapl` works; `/investments/Stock/AAPL` 404s.
17. **LOW — Fewer than two cached price days removes the Return view and the table lens too.**
    `src/app/investments/[assetType]/[symbol]/page.tsx:104-126` gates the ENTIRE `HoldingChartPanel`
    on `detail.priceSeries.length >= 2`, and the fallback (`:121-125`) offers only prose.
18. **LOW — The table lens is unpaginated and its rows are inert.**
    `src/components/charts/ScrubTable.tsx:109-113,156` maps every windowed point to a row; nothing
    links anywhere.

**Change** (ranked)

1. **State the price and its as-of date; relabel "Today".** (S) Add a "Last close" stat to
   PositionCard using `detail.latestClose` with `detail.priceDayChangeCents/Pct` beside it, put "as of
   `{formatDayLong(detail.quotedOn)}`" under Market value, change the "Today" label to
   "`{quotedOn}` move" unless `quotedOn === today`, and add a staleness chip. Zero new queries —
   `holding-detail.ts:298-301` already returns all of it.
2. **Show the total cost basis next to Total return.** (S) `detail.costCents`
   (`holding-detail.ts:201-204`) is computed and never rendered; add a "Cost basis" stat so
   "+$1,204 (+11.4%)" has its visible denominator, as a line rather than a `title=`.
3. **Stop turning every error into a 404, and add the missing route states.** (S) In
   `page.tsx:44-50` catch only `UnknownHoldingError` (already exported from
   `holding-detail.ts:32`) and rethrow everything else. Add `src/app/not-found.tsx`,
   `src/app/investments/[assetType]/[symbol]/loading.tsx` (a skeleton matching the card stack), and an
   `error.tsx` with retry.
4. **Carry the close forward for trade marks so no trade disappears.** (S) `holding-detail.ts:265`
   uses an exact-day lookup; reuse the `carriedCloseCents` binary search at `:233-248` and add a
   `carried: true` flag so the mark renders hollow. Keep the `page.tsx:81-83` filter as a last resort,
   and state the dropped count under the chart.
5. **Move PositionCard inside ChartFocus as the panel footer.** (S) Add a `footer?: ReactNode` prop
   mirroring `PortfolioChartPanel.tsx:65-67,308` and pass `<PositionCard detail={detail}/>` from
   `page.tsx:105-119` instead of `:128`.
6. **Make the account legs and the entry context navigable.** (S) Link each leg in
   `PositionCard.tsx:94-101` to `/accounts/{leg.accountId}` (`holding-detail.ts:314`), render the
   single-account case too, and accept an optional `?from=` to render a contextual breadcrumb when
   arriving from `AccountHoldingsTable.tsx:121`.
7. **Put the chart range in the URL, like `/investments` does.** (S) Parse `range` with the same
   `z.enum(CHART_RANGES).catch("ALL")` used at `investments/page.tsx:48,56`, pass it as
   `HoldingChartPanel`'s `defaultRange` (replacing the hardcoded "ALL" at
   `HoldingChartPanel.tsx:269`), and include it in `baseParams`.
8. **Name the page and the focus modal after the actual holding.** (S) Replace the static metadata at
   `page.tsx:29` with `generateMetadata` returning `` `${symbol} · ${ASSET_LABEL[assetType]}` ``, and
   pass a dynamic label to ChartFocus (`HoldingChartPanel.tsx:267`).
9. **Fix the benchmark fetch's stale render.** (S) Add
   `revalidatePath("/investments/[assetType]/[symbol]", "page")` to `setBenchmarkAction`
   (`app/investments/actions.ts:131`), and in `BenchmarkPicker.tsx:45` use `router.refresh()` when
   `hrefFor(symbol)` equals the current URL.
10. **Always offer the ledger escape hatch, and give realized sales one too.** (S)
    `HoldingEventsList.tsx:75` gates "View all N trades" on `hidden > 0` — always render it when
    `allTradesHref` is non-null. Add the equivalent to `RealizedSalesList` (`:71-73`) and make each
    sale row link to `ledgerHref({account, q: symbol, from: s.day, to: s.day})`.
11. **Cap and enrich the table lens.** (S) Cap `ScrubTable.tsx:109-113` at ~120 with a "show all"
    expander (state the truncation in the caption, which already handles `fellBack` honestly at
    `:147-149`), and make trade-day rows link to that day's ledger rows.
12. **Warn that unrealized and realized P/L are not additive.** (S) One line of copy between
    PositionCard and RealizedSalesList (`page.tsx:128-131`) stating the two bases.
13. **Label the Return stats and decomposition as all-time, or window them.** (M) Either pass the
    active range/customWindow down and filter `returnDays` before `returnStats`/`decomposeValue`
    (`ReturnViewParts.tsx:89, 143-146`), or add "· all time" to the `<dt>`s and the caption. Applies
    identically to `PortfolioChartPanel.tsx:306-307`.
14. **Make the trade marks and the avg-cost line inspectable.** (M) Give `ScrubMark` an optional
    label/quantity and render an accessible `<title>` plus a hover readout
    (`ScrubChart.tsx:784-794`), print the actual number in the refLine label (`:646-653`), and set
    `showExtremes` on the PRICE view (`HoldingChartPanel.tsx:360`).
15. **Cut the render cost of the diversity number.** (M) Replace `holdingRows(db)`
    (`holding-detail.ts:219`) with a scalar query summing qty × latest close, scope `displayName`
    (`:117-123`) to the symbol's own account ids with a LIMIT, and gate the bench/replay work at
    `page.tsx:70-79` behind `holdingView.view === "returns"`.
16. **Fit the chart controls on a phone.** (M) Below `sm`, collapse the benchmark picker and the unit
    switcher into a "⋯ chart options" popover (`HoldingChartPanel.tsx:279`), keep only Price/Return
    and Chart/Table inline, and raise the mobile plot height.

**Add** (ranked)

1. **A "My position value" chart mode — qty × close over time.** (S) `holdingReturnDays` already
   returns `navCents` per day (`holding-returns.ts:117`), so
   `returnDays.map(d => ({day: d.day, valueCents: d.navCents}))` is a one-line ScrubPoint series with
   no new query. Today Price is per-share and Return is flow-adjusted; NEITHER answers "what was this
   position worth on March 3?"
2. **Break-even and what-if row under the position stats.** (S) With `avgCostCents` and `latestClose`
   in hand, print distance to break-even in $ and %, the price needed, and the dollar impact of a
   ±1% / ±5% move.
3. **Export the trade history and realized sales.** (S) A "Download CSV" on `HoldingEventsList` and
   `RealizedSalesList` covering ALL rows, not the 40 shown (`EVENTS_SHOWN`,
   `holding-detail.ts:109`; `SALES_SHOWN`, `RealizedSalesList.tsx:18`) — sales past the 40th are
   currently unreachable by any route.
4. **A key scope for this surface.** (S) Register a keyScope (`lib/keyscope.ts`, `PRIORITIES.list`)
   with `v` to flip Price⇄Return, `t` for the lens, `f` for focus, `r` to refresh once that exists —
   matching `ReviewInbox.tsx:108` and `TransactionsLedger.tsx:218`.
5. **Sibling navigation (prev/next holding).** (S) Prev/next chevrons walking the same ordering the
   holdings table used, so an audit sweep does not round-trip through `/investments`.
6. **Refresh prices + Add/update this holding, on this page.** (M) Reuse `RefreshPricesButton.tsx`
   verbatim and `HoldingForm.tsx` pre-filled, as `HoldingActionsMenu.tsx:28-49` does for the
   portfolio. Add a per-symbol backfill (`backfillSymbolHistory` already exists, used by
   `setBenchmarkAction`, `actions.ts:116`) so "no price history" is fixable in place, and extend
   `refreshPricesAction`/`addHoldingAction` (`actions.ts:59-60, 84-85`) to revalidate this route.
7. **Dividends and income for this holding.** (M) `description-key.ts:20-44` already collapses a
   trailing `(TICKER)` plus a brokerage marker into `ticker:SYMBOL:DIV` and splits dividends from DRIP
   reinvestments. Add an Income card with T12M dividends and yield-on-cost, and mark dividend days on
   the price chart.
8. **Per-holding P/L calendar.** (M) `/investments` has a full month-paging calendar with a day sheet
   (`page.tsx:192-197`, `PnlCalendar.tsx`, pinned by `zz-investments.spec.ts:136-150`). Add a
   symbol-scoped variant driven by `holdingReturnDays`.
9. **Compare against another holding (overlay).** (M) `ScrubChart` already supports a full `overlays`
   prop with per-series coverage splitting and tooltip rows (`ScrubChart.tsx:294-322, 669-696`), used
   today only by `DashboardModePanel`. Add a "compare" picker beside the benchmark picker.
10. **Inline ledger rows for this symbol.** (M) Below Trade history, embed the actual rows the deep
    links point at (`ledgerHref({account, q: symbol})`, `holding-detail.ts:336`).
11. **Notes and a target on a holding.** (M) A free-text thesis note plus an optional target/stop
    price for the (assetType, symbol) pair, rendered as a reference line (generalize `refLine` to an
    array).
12. **Ambitious viz: a contributions-vs-value ribbon over time.** (L) Extend `DecompositionBar`
    (`ReturnViewParts.tsx:300-346`) from a single all-time bar into a stacked area over the same day
    axis — net contributed as the base band, market gains/losses above/below. `decomposeValue`
    already produces the exact identity per series; it just needs per-day evaluation, reusing
    ScrubChart's existing stacked-area machinery.

---

## /budgets

**Purpose** — The only surface in the app that turns the owner's reconstructed ledger into a
forward-looking commitment: "I intend to spend $X on Food this month, am I going to make it?" Every
other spending surface is retrospective — `/spending` and `/categories/[id]` describe what happened;
`/budgets` is the one page that grades the current period while there is still time to change
behaviour. Its unit of work is one active budget per (category, period), whose "spent" is guaranteed
to be the exact same number `categorySpending` gives the category page and the transaction list, so a
budget can never drift from the ledger. It currently holds ten monthly budgets covering ~$6,799/mo of
intended spend against ~$5,670 spent so far this month — the single number that answers "am I ok this
month" — and the page never states it.

**Connections**

- **Reads:** `budgetPaceStatuses` (`services/budgets.ts:456`) → `budgetStatuses` (`:153`) →
  `categorySpending` (`services/analytics.ts:453`), the SAME row source (`activeTxnsInRange`,
  `analytics.ts:157`) as `/spending`'s tables and the `/transactions` ledger, and split-aware. The
  expected tail reads `recurringSeriesIdsForCategory` (`analytics.ts:100`) then `projectOccurrences`
  (`services/recurring.ts`) so the tail reconciles to `/recurring` to the cent (`budgets.ts:342`). The
  inline editor reads `budgetGuidanceCents` (`budgets.ts:511`) = 6 trailing full months of
  `categorySpending` expressed at the budget's period length. "Predict budgets" reads `predictBudgets`
  (`services/category-forecast.ts:310`) → `predictBudgetableCategories` (`:284`) → the pure
  `lib/category-forecast.ts` + `lib/projection.ts` engine — the identical engine `/spending` renders
  as its per-category forecast annotation (`app/spending/page.tsx:107`).
- **Writes:** `createBudget`/`updateBudget`/`deactivateBudget` (`budgets.ts:67/89/109`) against the
  `budgets` table (`db/schema/budgets.ts`), guarded by the partial unique index
  `ux_budgets_category_period_active` and `requireBudgetableCategory` (expense-kind, non-archived).
- **Links out:** each row → `/categories/{id}` (`BudgetRow.tsx:77`); each tail series →
  `/recurring/{id}` (`BudgetRow.tsx:148`).
- **Links in:** exactly one — `/categories/[id]`'s Budget card → `/budgets`
  (`services/category-detail.ts:180`, rendered `app/categories/[id]/page.tsx:173`).
- **Not connected:** the dashboard (grep for "budget" in `src/app/page.tsx` and
  `src/services/dashboard.ts` returns nothing), the nav badge (review-count only), and `/spending`'s
  categories table (`SpendingCategoriesTable.tsx` carries spend/share/MoM/forecast but no budget
  column) — so the three surfaces the owner opens daily never mention his budgets.

**Interactive inventory**

| element | file:line | intended | verdict |
| --- | --- | --- | --- |
| "Deactivate" submit button | `src/components/budgets/BudgetRow.tsx:202` | Retire a budget | **broken** — destructive, ~4px from "Edit", no confirmation, no toast, no Undo, full-page redirect. Nothing lists inactive budgets and no reactivate path exists (`isActive` is only ever set false, `services/budgets.ts:112`). Settings→Rules deletes with a lossless Undo snapshot toast (`RulesManager.tsx:84-96`); this does not. |
| Error banner (`role="alert"`) | `src/app/budgets/page.tsx:70` | Surface a failed create/deactivate | **missing-state** — no dismiss control; the message lives in `?error=` so it survives refresh and back-navigation. It renders at the very top while the form that produced it is at the very bottom (`page.tsx:116`). `raw.error` as an array (`?error=a&error=b`) silently renders nothing (`page.tsx:43`). |
| Filled spend segment | `src/components/budgets/BudgetRow.tsx:99` | Show fraction of budget consumed | **missing-state** — `clampPct` pins it at 100% (`:21-23`), so a 108%-over row and a 4,898%-over row are pixel-identical. `aria-valuenow` is the clamped 100 while `aria-valuetext` says 4898% (`:94-95`). |
| Dashed expected-tail segment | `src/components/budgets/BudgetRow.tsx:103` | Show recurring charges still expected before period end | **missing-state** — `aria-hidden`, no legend explaining the dashed style, and it collapses to zero width whenever `spentPct` is already 100 (`tailWidth = max(0, tailEndPct − spentPct)`, `:58`) — it vanishes exactly on the over-budget rows where upcoming bills matter most. |
| "Left / Over by $X" (NumberRoll) | `src/components/budgets/BudgetRow.tsx:180` | Remaining headroom, or the overrun in red | **missing-state** — with net refunds `remainingCents = amount − spent` exceeds the budget itself, so a $600 budget with a $50 net refund renders "Left $650.00" beside "On track · -8% used". Nothing handles negative `spentCents` (`services/budgets.ts:194-195`). |
| Amount `<input>` (create form) | `src/components/budgets/BudgetForm.tsx:27` | Type the budget amount | **missing-state** — `Field` supports `hint` and `error` slots (`ui/Field.tsx:37-42`) and neither is used. No 6-month guidance at creation time even though `budgetGuidanceCents` already exists. |
| "Create budget" submit button | `src/components/budgets/BudgetForm.tsx:30` | Create the budget | **missing-state** — no `useFormStatus` pending state and no client validation; every failure round-trips through `redirect('/budgets?error=…')` (`app/budgets/actions.ts:49`), resetting all three uncontrolled fields. |
| Keyboard shortcuts / KeyScope registration | `src/app/budgets/page.tsx:1` | Per-surface mnemonics like ReviewInbox's `r` and TransactionsLedger's `x` | **missing-state** — no `useKeyScope` anywhere under `src/components/budgets/` or `src/app/budgets/` (verified by grep). Every interactive element is a mouse target. |
| Period navigation / view switcher / chart lens | `src/app/budgets/page.tsx:46` | Time-travel and alternate views, as on every sibling surface | **missing-state** — no `PeriodSelector`, no `ViewSwitcher`, no `ScrubChart`, no `StatCard`, no `Sparkline`, no `Tooltip` (verified by grep). Hard-wired to `todayIso()`; the only major surface with zero view state and zero data visualization beyond a 10px bar. |
| Prediction basis text (`title={forecast.basis}`) | `src/components/budgets/PredictBudgets.tsx:178` | Reveal the full visible-math basis, e.g. "$64.21 expected recurring + $47.78 discretionary" | **undiscoverable** — a native `title` is hover-only: unreachable by touch and by keyboard. The component's own doc comment (`:19`) claims "no predicted number is ever a bare figure"; on mobile every one of them is. |
| Active/Inactive table column headers (Series / Cadence / Avg / Next / Annualized) — *budgets analogue:* section header sort | `src/components/budgets/BudgetRow.tsx:86` (pace headline) | One-glance verdict coloured by PROJECTED pace | **undiscoverable** — no tooltip or affordance explains what "Off pace" measures or how the projection is built. At 4,898% (real DB: Travel) it renders "Over budget by 4798%". |
| "6-mo avg ≈ $X" guide | `src/components/budgets/BudgetAmountEditor.tsx:110` | Anchor the edit to real history | **undiscoverable** — the most valuable number on the page, buried two clicks deep per row. 8 of 10 budgets sit >15% from their own 6-month average (Food −34%, Shopping +79%, Subscriptions +84%, Fees −82%, Travel −78%, Entertainment −79%). Renders nothing at all when guidance is 0, with no explanation (`:108`). |
| "Predict budgets" pill button | `src/components/budgets/PredictBudgets.tsx:81` | Load next-month per-category forecasts and open the review sheet | **confusing** — `predictBudgets` (`services/category-forecast.ts:311-320`) excludes every category that already has an ANY-period active budget and every non-top-level category. On the real DB it returns 3 rows and two are 0%-confidence. There is no path to re-predict the 10 budgets he has. |
| "Create N monthly budget(s)" footer button | `src/components/budgets/PredictBudgets.tsx:97` | Create the checked predictions as budgets | **confusing** — period hardcoded `monthly` (`app/budgets/actions.ts:130`) with no picker, so this flow can never populate the Daily/Weekly/Annual sections. `createBudget` stamps `startsOn: todayIso()` while the sheet copy says the amount forecasts *next* month (`PredictBudgets.tsx:118`). |
| Period section heading + date bounds | `src/app/budgets/page.tsx:89` | Name the period and the window being graded | **confusing** — `formatDayShort` emits no year (`lib/format-date.ts:21-24`), so an Annual section reads "Jan 1 – Dec 31". Bounds are taken from `section.statuses[0]` — correct only because `periodBounds` is a pure function of refDate, an undocumented coupling. |
| Category name link → `/categories/{id}` | `src/components/budgets/BudgetRow.tsx:76` | Drill into the category behind the budget | **confusing** — carries no period params, so `resolvePeriod` falls through to the current calendar month (`lib/period.ts:184-185`). A daily budget's row says "Spent $42" and lands on a page showing $1,200. |
| "Projected ≈ $X" | `src/components/budgets/BudgetRow.tsx:187` | Where the period is heading | **confusing** — no basis, no tooltip, and it disappears entirely for over-budget rows (`:185`). For daily budgets `remainingDays` is always 0 and the tail always empty (`services/budgets.test.ts:643-648`), so it is byte-identical to "Spent". |
| Section header counts ("Total budgeted", "· overlapping child budgets excluded") | `src/app/budgets/page.tsx:95` | State the section's total commitment and warn when a child budget was excluded | **dead-end** — not a link, no counterpart total spent/remaining, and no way to see WHICH budgets were excluded. The only aggregate on the page and it answers the least useful half of the question. |
| EmptyState "No budgets yet" | `src/app/budgets/page.tsx:81` | First-run guidance | **dead-end** — pure text with no control. It says "Create one below" but offers no anchor to the form and no link to "Predict budgets", the actual fastest path from zero. |
| Predicted amount figure | `src/components/budgets/PredictBudgets.tsx:188` | Show the budget that will be created | **dead-end** — not editable. The user can only accept the $10-rounded forecast or skip the row. |
| "also counts toward its parent's budget" note | `src/components/budgets/BudgetRow.tsx:82` | Explain parent/child overlap | **dead-end** — plain text; does not name or link to the parent budget, even though `ancestorCategoryIds` is already on the status object (`services/budgets.ts:141`). |
| Progress bar (`role="progressbar"`) | `src/components/budgets/BudgetRow.tsx:89` | The page's hero visual: spend vs budget with a pace reference | **dead-end** — completely inert: not focusable, no hover, no click, no tooltip, no drill-down. The most prominent element on every row does nothing. |
| "Spent $X" figure | `src/components/budgets/BudgetRow.tsx:170` | The actual, straight from spending analytics | **dead-end** — not a link. `analytics.transactionsHref({categoryId, from, to})` (`analytics.ts:466`) already produces the exact drill-down URL. The headline actual on the budgets page is the one number you cannot open. |
| "Today" tick mark | `src/components/budgets/BudgetRow.tsx:112` | The pace reference — fill left of it means you are ahead | **undiscoverable** — a 2px `aria-hidden` hairline with no label, legend or tooltip; its meaning exists only in a source comment (`:111`). For a daily budget `elapsedFraction` is always exactly 1 (`services/budgets.test.ts:646`), so the tick is permanently at the far right. |
| Category `<select>` (create form) | `src/components/budgets/BudgetForm.tsx:10` | Pick the category to budget | **confusing** — no placeholder option, so the first category is pre-selected and `required` is inert. Subcategories are indented with a single leading space (`" ${c.name}"`), which browsers collapse, and `BudgetableCategory.parentName` (`services/budgets.ts:265`) is never rendered. |
| Prediction row checkbox (one per prediction) | `src/components/budgets/PredictBudgets.tsx:168` | Include/exclude that category from the create batch | sensible — no select-all / select-none; with a fresh DB this is every top-level expense category, one at a time. |
| Prediction row label (whole row is a `<label>`) | `src/components/budgets/PredictBudgets.tsx:166` | Click anywhere on the row to toggle its checkbox | sensible |
| Sheet backdrop / Esc / Close icon | `src/components/ui/Sheet.tsx:103` | Dismiss the prediction sheet | sensible |
| Expected-tail popover trigger ("$6.00 expected before Jul 31") | `src/components/budgets/BudgetRow.tsx:121` | Open the list of contributing recurring series | sensible — correct and well-built, but renders only when `expectedTailCents > 0`: 0 of 10 rows on the real DB at 2026-07-27. |
| Tail popover series links → `/recurring/{id}` | `src/components/budgets/BudgetRow.tsx:147` | Drill from an expected charge to the series that predicts it | sensible |
| "Budget $X" (NumberRoll) | `src/components/budgets/BudgetRow.tsx:176` | Animated display of the target after an inline edit | sensible |
| "Edit" popover trigger | `src/components/budgets/BudgetAmountEditor.tsx:82` | Open the inline amount editor | sensible |
| Amount text input (inline editor) | `src/components/budgets/BudgetAmountEditor.tsx:96` | Type a new budget; Enter saves | sensible — no `$` affordance and no inline invalid styling; a bad parse comes back only as a toast (`:70`). |
| "Use" button (adopt the guide) | `src/components/budgets/BudgetAmountEditor.tsx:113` | One tap to set the amount to the 6-month average | sensible |
| "Cancel" button | `src/components/budgets/BudgetAmountEditor.tsx:126` | Close without saving; draft resets on next open (`:54-60`) | sensible |
| "Save" button | `src/components/budgets/BudgetAmountEditor.tsx:129` | Persist the amount, toast, refresh in place | sensible — double-submit guarded (`:65`) and pending-stated; the best-built control on the surface. |
| Period `<select>` (create form) | `src/components/budgets/BudgetForm.tsx:19` | Pick daily/weekly/monthly/annual | sensible |

**Good**

1. `projectSpend` (`services/budgets.ts:309-318`) extrapolates ONLY the non-recurring remainder, so a
   bill that already posted is never smeared by pace and a bill still to come is counted exactly once
   via the tail. Net-refund categories contribute no negative remainder. Five tests pin it
   (`budgets.test.ts:440-467`).
2. The spentToDate/tail disjointness argument at `services/budgets.ts:463-469` plus the
   `Math.max(s.spentCents, forecast)` floor at `:487` correctly handle a future-dated posting inside
   the current period without double-counting it against its own series
   (`budgets.test.ts:606`).
3. `totalBudgetedCents`/`hasOverlappingChildBudget` (`services/budgets.ts:216-232`) scope the
   parent/child exclusion to the SAME period set rather than globally, so a child budgeted weekly
   under a monthly-budgeted parent is not silently dropped (`budgets.test.ts:326`).
4. `BudgetRow.tsx:50-54` distinguishes "Over budget by 8%" from "108%" — a mistake most commercial
   budgeting apps ship.
5. `budgetTail` (`services/budgets.ts:344-389`) reuses `projectOccurrences`, filters to
   detected|confirmed, and drops money-in occurrences, so the tail agrees with `/recurring` to the
   cent AND drills through to the exact series (`BudgetRow.tsx:147`) — the only place on the page
   where the drill-down contract is honored.
6. `recurringPostedCents` (`services/budgets.ts:397-434`) is split-aware on both legs and excludes
   transfer-linked parts.
7. `PredictBudgets` never pre-checks a 0-confidence prediction (`PredictBudgets.tsx:36-40`) and
   disables Create until something is picked.
8. The progressbar's `aria-valuetext` (`BudgetRow.tsx:64-70`) speaks a complete sentence including the
   projection and the expected tail.
9. `updateBudgetAmountAction` returns `ActionResult` instead of redirecting
   (`app/budgets/actions.ts:57-86`) so the row updates in place with a toast; `save()` guards
   double-submit (`BudgetAmountEditor.tsx:65`) and the draft resets on every open (`:54-60`). This is
   the pattern the create and deactivate paths should have copied.
10. `e2e/zz-budgets.spec.ts` mutates and RESTORES the seed (`86-89`, `128-130`) and scopes the guide
    assertion to the open popover because all three editors are in the DOM (`:74`).

**Bad** (ranked)

1. **HIGH — Deactivate is a one-tap unrecoverable destroy sitting 4px from Edit.**
   `src/components/budgets/BudgetRow.tsx:200-208`, immediately adjacent to the Edit trigger at `:193`:
   `deactivateBudgetAction` fires with no confirmation, no toast, no Undo, and full-page-redirects.
   `deactivateBudget` (`services/budgets.ts:112`) sets `isActive=false`; `budgetStatuses` (`:155`)
   only ever selects `isActive=true`, no code path sets it back, and no screen lists inactive budgets.
   Recreating via the form produces a NEW row with `startsOn=today`. Settings→Rules deletes behind a
   lossless Undo snapshot toast (`RulesManager.tsx:84-96`), and `services/bulk-edit.ts:100-184`
   returns an `UndoPatch` for every bulk mutation. Budgets are the only destructive action in the app
   with neither.
2. **HIGH — `startsOn` is stored and then completely ignored, so "Predict budgets" creates an August
   budget instantly graded against July.** `budgetStatuses` computes `bounds = periodBounds(refDate,
   b.period)` (`src/services/budgets.ts:160-165`) and sums `categorySpending` over the WHOLE period
   with no clamp to `b.startsOn`; `createBudget` stamps `startsOn: todayIso()` (`:77`). On the real DB
   at 2026-07-27 the Predict sheet says "a forecast of your August 2026 spending"
   (`PredictBudgets.tsx:118`) and offers Utilities at $120; accepting it renders "Spent $64.21 of
   $120.00 · 54% used" against July with 4 days left and an 87% elapsed tick. Same for manual
   creation: a Travel budget created today opens at "Over budget by 4798%". `budgetInputSchema`
   already accepts `startsOn` (`:41`) and no UI ever passes it.
3. **HIGH — The page never states total spent, total remaining, or overall pace.**
   `src/app/budgets/page.tsx:95-101` renders exactly one aggregate: "Total budgeted". On the real DB
   that reads $6,799.00 while actual spend against those same ten budgets is $5,670.51 — a number the
   page computes ten times and never sums. `ui/StatCard.tsx` with drill-down hrefs already exists and
   is used on `/spending` and `/investments`.
4. **HIGH — "Spent" — the headline actual on every row — is not clickable.**
   `src/components/budgets/BudgetRow.tsx:170-173` renders `<Money cents={status.spentCents} />` as
   inert text, while `analytics.transactionsHref({categoryId, from: bounds.start, to: bounds.end})`
   (`analytics.ts:466`) already emits the exact URL. Travel reads $2,448.88 against a $50 budget and
   the owner cannot ask "why?" from this page.
5. **HIGH — The category link silently changes the period.**
   `src/components/budgets/BudgetRow.tsx:76-81` links to `/categories/${budget.categoryId}` with no
   `period`/`from`/`to`; `resolvePeriod` falls through to the current calendar month
   (`lib/period.ts:184-185`). A daily Food budget reading "Spent $42.00" lands on a page whose hero
   reads "Spent · July 2026 $444.77". The reciprocal link back
   (`categories/[id]/page.tsx:173` → `/budgets`) also carries nothing.
6. **MEDIUM — Two contradicting status systems.** `computeAlert` (`services/budgets.ts:144-148`)
   fires warn80 at 80% and over at 100%; `computePace` (`:283-287`) fires at-risk only when the
   PROJECTION overruns. `/budgets` renders `pace` (`BudgetRow.tsx:15-19`); `/categories/[id]` renders
   `alert` (`categories/[id]/page.tsx:160-167`). On day 28 of 30 at 85% with a projection landing at
   91%: `/budgets` shows GREEN "On track · 85% used"; the same budget on its category page shows
   AMBER.
7. **MEDIUM — `categoryBudgetRef` shows only ONE of a category's budgets and mislabels which.**
   `budgetStatuses(...).find(s => s.budget.categoryId === categoryId)`
   (`src/services/category-detail.ts:171-180`) takes the first match from a list sorted by
   PERIOD_ORDER daily<weekly<monthly<annual (`budgets.ts:150,202`). Budget Food daily $30 and monthly
   $1,430 and `/categories/[id]` renders the daily one; the $1,430 monthly budget is invisible with no
   hint another exists.
8. **MEDIUM — Net-refund periods render nonsense.** `pct = spentCents / amountCents`
   (`services/budgets.ts:195`) has no floor and nothing guards `spentCents < 0`. A $700 laptop return
   against a $600 monthly Shopping budget renders "On track · -8% used"
   (`src/components/budgets/BudgetRow.tsx:47-60`) beside an empty bar (`:21-23`) and "Left $650.00"
   (`:179-183`). `budgets.test.ts` has no status-level test for negative spend — only `projectSpend`
   is covered (`:459`).
9. **MEDIUM — Extreme overruns print a four-digit percentage against a bar clamped at 100%, and the
   accessible values contradict each other.** Travel budget $50.00, spent $2,448.88, pct 4897.8%.
   `src/components/budgets/BudgetRow.tsx:50-58` renders "Over budget by 4798%"; `spentPct` clamps to
   100 so 108%-over and 4,898%-over are pixel-identical; `aria-valuenow` = 100 while `aria-valuetext`
   embeds "4898% of budget" (`:94-95`).
10. **MEDIUM — The most decision-relevant number on the page is computed on every load and then
    hidden inside a per-row popover.** `src/app/budgets/page.tsx:51-53` eagerly builds a `guidance`
    map calling `budgetGuidanceCents` for every budget (measured 82.3ms for 10 budgets, on top of
    `budgetPaceStatuses` at 76.4ms — ~52% of the page's ~159ms of synchronous better-sqlite3 work is
    popover content nobody asked for). What it hides: Food −34%, Shopping +79%, Subscriptions +84%,
    Fees −82%, Travel −78%, Entertainment −79%. Entertainment reads a serene green "On track · 0%
    used" against a $292.22/month trailing average and a $60 budget.
11. **MEDIUM — Rows are sorted alphabetically, so the emergency is last.** `budgetStatuses` sorts by
    PERIOD_ORDER then `categoryPath.localeCompare` (`src/services/budgets.ts:201-205`) and
    `page.tsx:103` lays them into a grid in that order. On the real DB the worst overrun (Travel,
    4,898%) is the tenth card down on a phone. No sort control, no filter, no "needs attention"
    grouping.
12. **MEDIUM — Create-budget failures round-trip through the URL and wipe the form.**
    `createBudgetAction` catches every error into a string and `redirect('/budgets?error=…')`
    (`src/app/budgets/actions.ts:45-49`); all three form fields are uncontrolled
    (`BudgetForm.tsx:10,19,27`). The banner is off-screen on a phone (the form is the last element,
    `page.tsx:116`), `ui/Field.tsx:37-42` has a per-field `error` slot the form never uses, and
    `listBudgetableCategories` does not mark which categories are already budgeted.
13. **MEDIUM — The prediction basis is reachable only by mouse hover.**
    `src/components/budgets/PredictBudgets.tsx:176-181` puts the basis string in a native `title` on a
    `<span>`. On the real DB two of three predictions come back at 0% confidence with basis "$1,212.61
    discretionary (no recurring bills)" — on the phone the owner sees only the number.
    `ui/Tooltip.tsx` exists and is not used here.
14. **LOW — Daily budgets get a dead pace apparatus that still consumes a third of the row.** For a
    daily budget `totalDays = elapsedDays = 1` and `elapsedFraction = 1`
    (`services/budgets.test.ts:643-646`), so the today-tick is permanently at 100%
    (`BudgetRow.tsx:114-116`) and "Projected ≈ $X" (`src/components/budgets/BudgetRow.tsx:185-190`) is
    byte-identical to "Spent".
15. **LOW — Four of the surface's six buttons bypass the shared Button component.**
    `src/components/budgets/BudgetRow.tsx:202-207` (Deactivate), `BudgetForm.tsx:30-35`,
    `PredictBudgets.tsx:81-89` and `:97-107` hand-roll class strings while
    `BudgetAmountEditor.tsx:126,129` uses `<Button>`. `ui/Button.tsx:16` ships a `destructive` variant
    Deactivate does not use, and neither form button gets `pending` (`:29`).
16. **LOW — `revalidatePath` coverage is inconsistent.** `createPredictedBudgetsAction` revalidates
    "/" (`src/app/budgets/actions.ts:136-139`), which contains no budget UI at all, while none of the
    four actions revalidates `/categories/[id]`, which DOES render a live Budget card
    (`categories/[id]/page.tsx:149-177`).
17. **LOW — Daily / Weekly / Annual sections have zero e2e coverage and zero real usage.**
    `e2e/seed-helpers.ts:340-359` seeds three MONTHLY budgets only, the real DB holds ten monthly
    budgets and nothing else, and the only bulk-creation path hardcodes `monthly`
    (`actions.ts:130`). The weekly ISO-boundary and leap-February bounds logic is unit-tested
    (`budgets.test.ts:216,234`) but has never rendered.

**Change** (ranked)

1. **Put the 6-month guidance delta on the row, not in a popover.** (S) The page already computes
   `budgetGuidanceCents` for every budget on every load (`page.tsx:51-53`). Render it inline next to
   "Budget" as a delta chip — "$1,430 · 34% under your 6-mo avg of $2,155" — with "Use" promoted to a
   one-tap inline button; keep the popover for free-form typing.
2. **Make every number on the row openable.** (S) Wrap "Spent" in a Link to
   `analytics.transactionsHref({categoryId, from: bounds.start, to: bounds.end})`
   (`analytics.ts:466`), add the same bounds as `?from=&to=` to the category link
   (`BudgetRow.tsx:77`) so `resolvePeriod`'s custom branch (`lib/period.ts:165-167`) preserves the
   window, and add a matching `?period=` to the category page's back-link
   (`categories/[id]/page.tsx:173`).
3. **Add a page-level summary strip.** (S) Four `ui/StatCard`s per period set — Budgeted, Spent,
   Left/Over, Projected — each summing the statuses already in hand and each with an href
   drill-down. Keep the existing per-section "Total budgeted" line so nothing is removed.
4. **Rank rows by urgency and let the user re-sort.** (S) Add a `ViewSwitcher` dimension
   `{key:"sort", options:["attention","name","largest","pct"]}` through `lib/view-state.ts` so the
   choice lives in the URL and persists. Default "attention"; `budgetStatuses`' existing alphabetical
   sort (`budgets.ts:201-205`) becomes the "name" option.
5. **Explain the bar.** (S) A small legend under the first section (today-tick, solid fill, dashed
   tail) and an accessible tooltip on the tick via `ui/Tooltip.tsx` ("Day 27 of 31"). Suppress the
   tick for daily budgets where `elapsedFraction === 1` (`BudgetRow.tsx:111`) and relabel "Projected
   ≈" in that case.
6. **Show which budgets were excluded from the total.** (S) Turn "· overlapping child budgets
   excluded" (`page.tsx:99`, `services/budgets.ts:229-232`) into a popover listing the excluded child
   budgets with amounts and links, and badge each excluded row. `ancestorCategoryIds` is already on
   every status (`:141`).
7. **Stop prefetching popover content on every render.** (S) Move `budgetGuidanceCents`
   (`page.tsx:51-53`, 82.3ms) behind a server action the editor calls on open — unless CHANGE #1
   lands, in which case keep it eager because it is then visible on every row.
8. **Make Deactivate confirm-then-Undo, and add an Inactive budgets section.** (M) Convert
   `BudgetRow.tsx:200-208` to a value-returning `ActionResult` returning a snapshot of
   `{categoryId, period, amountCents, startsOn}`, then toast `Deactivated "Food" · Undo` using the
   `RulesManager.tsx:84-96` pattern with a `restoreBudgetAction`. Use
   `<Button variant="destructive" size="sm">` and move it behind a `ui/Menu` overflow. Additively add
   a collapsed "Inactive budgets" section with a Reactivate control.
9. **Honour `startsOn` in the status math, and let Predict budgets start next month.** (M) In
   `budgetStatuses` (`services/budgets.ts:160-165`) clamp the spend window to
   `max(bounds.start, budget.startsOn)` and `min(bounds.end, budget.endsOn ?? bounds.end)`, carry a
   `partialPeriod: true` flag so BudgetRow can caption "partial period — budget started Jul 27", and
   have `createPredictedBudgetsAction` (`actions.ts:130`) pass `startsOn: prediction.targetStart`.
10. **Design the extreme states the bar cannot express.** (M) For pct > 150% print a multiple —
    "4.9× budget" — instead of four digits (`BudgetRow.tsx:53`), add a segmented overflow bar, and
    make `aria-valuenow` and `aria-valuetext` agree (`:94-95`). For negative `spentCents`, floor
    `pct` at 0, cap "Left" at the budget amount, and caption "net refund this period".
11. **Give the create form the same guidance the edit popover has.** (M) Make `BudgetForm` a client
    component that on category+period change calls a `budgetGuidanceAction` and fills `Field`'s `hint`
    slot plus a Use button. Add a disabled placeholder option so `required` becomes real, render
    subcategories as "Food › Dining" using `parentName` (`services/budgets.ts:265`), annotate
    already-budgeted options, add `useFormStatus`, and surface errors through `Field`'s `error` slot
    rather than `?error=`.
12. **Make prediction basis and amount reachable on touch.** (M) Replace the `title` at
    `PredictBudgets.tsx:178` with the real `ui/Tooltip` (or a second line on small viewports), make
    the amount at `:188` an editable `ui/InlineEditableAmount`, and add Select all / Select none plus
    a period picker in the footer.
13. **Reconcile the two status vocabularies.** (M) `BudgetPaceStatus` already carries both `pace` and
    `alert` (`services/budgets.ts:196,446`). Render both on `/budgets` (pace tone as the fill colour
    plus an 80%-threshold tick), give `categories/[id]`'s Budget card the same pace tone
    (`categories/[id]/page.tsx:160-167`), and make `categoryBudgetRef` return ALL of a category's
    budgets instead of `.find()`'s first (`category-detail.ts:172`).

**Add** (ranked)

1. **Period navigation — "did I hit my budget last month?"** (S) Add the existing
   `components/spending/PeriodSelector` and pass its resolved date as `refDate` to
   `budgetPaceStatuses(db, refDate)`. The service is already parameterised and works: run at
   2026-06-10 it returns a complete historical picture ($9,612.80 spent against $6,799.00, two
   at-risk rows, one live tail). Follow with a per-budget 12-month hit-rate strip reusing
   `categoryMonthlyTrend` (`services/category-detail.ts`). The page is hard-wired to `todayIso()`
   (`page.tsx:46`).
2. **Copy-forward and templating.** (S) "Copy last period's budgets", "Duplicate to another period",
   and per-budget "Change period" — `updateBudget`'s `budgetPatchSchema` already accepts `period`
   (`budgets.ts:47`) and no UI ever sends it, so changing monthly→weekly today requires
   deactivate-then-recreate.
3. **Keyboard surface for the list.** (S) Register a `budgets` KeyScope at `PRIORITIES.list`
   (`lib/keyscope.ts`) with `j`/`k`, `e` to open the focused row's editor, `Enter` for the drill-down,
   `g b` as the global chord. Give the progressbar a focusable wrapper the way ScrubChart does.
4. **"Right-size my budgets" — re-predict the budgets that already exist.** (M) `predictBudgets`
   (`services/category-forecast.ts:310-320`) deliberately excludes every already-budgeted category, so
   the feature is structurally incapable of improving an existing budget. Add `repredictBudgets(db)`
   returning `{current, predicted, sixMonthAvg, delta, basis, confidence}` per budget, surfaced in the
   same review sheet with per-row Accept plus "Apply all". 8 of 10 budgets are >15% off their own
   6-month actuals and 5 are >34% off.
5. **Surface budgets on the pages he actually opens.** (M) Three additive wirings on `budgetStatuses`
   (the cheap variant, deliberately separated from `budgetPaceStatuses` for exactly this,
   `budgets.ts:450-455`): a budget-vs-actual column on `/spending`'s `SpendingCategoriesTable`; a
   Budgets card on the dashboard (worst three by pace + the summary strip); an attention count on the
   Budgets nav item when any budget is `over` or `warn80`. `alert === 'warn80'` is computed on every
   status and rendered nowhere.
6. **Per-budget notes, and the rollover decision made explicit.** (M) A `notes` field ("$50 Travel is
   deliberate — Cancun was reimbursed") shown as a row caption, and an explicit per-budget
   `rolloverPolicy: 'none' | 'carry'` defaulting to 'none' so the current doctrine
   (`db/schema/budgets.ts:10-11`) stays the default.
7. **Budget-vs-actual as a real chart, per row and for the page.** (L) Per row: a 12-month bar strip
   with the budget as a reference line (`categoryMonthlyTrend` supplies the data). Page level: a
   stacked budget-vs-actual chart with a chart⇄table lens via `charts/chart-lens.ts` and a
   `ChartFocus` expand. Ambitious variant: a radial burn dial where arc = period elapsed and fill =
   spend. `/budgets` is the only major surface with zero data visualization (verified by grep).
8. **Savings targets and income goals.** (L) `requireBudgetableCategory`
   (`services/budgets.ts:58-60`) hard-rejects any non-expense kind. Add a parallel goals concept —
   monthly savings target against net (income − spend), per-income-category targets against
   `incomeTransactions` (`analytics.ts:439`) — as a fourth section with the same pace bar.
9. **Alert history and a period-close digest.** (L) Record 80%/100% crossings and surface a
   per-budget timeline plus a period-close recap ("June: 6 of 10 budgets met; Housing over by
   $176.70"), all derivable by sweeping `budgetStatuses` across dates.

---

## /recurring

**Purpose** — The owner's "what is already committed" page — the only surface that answers "what
leaves my account no matter what I do this month, and what lands in it." Everything else in MoneyApp
is backward-looking; `/recurring` is the one forward-looking ledger: detected subscriptions, bills,
rent and paychecks with a next-expected date, an expected amount, and an annualized cost — plus the
end-of-month forecast those series drive. For a person on a variable, partly-cash income
(`docs/future-ideas.md:250`) the operative questions are "can I cover rent on the 1st", "what's still
due before my next paycheck", and "which subscription is quietly bleeding me $360/yr".
`/recurring?tab=all` is also the only place in the app that shows annualized cost per merchant, and
the page is the editorial surface for detection itself — confirm/dismiss, override cadence/amount/date,
attach or detach a charge, merge two identities of the same bill.

**Connections**

- **Reads:** `recurring_series` (31 rows in the checked DB, all `status='detected'`),
  `transactions.recurring_series_id` + `series_link_source`, `merchants`, `categories`, `accounts`,
  and — via `forecastCurrentMonth` — `latestBalances` and `bridgedNetWorthSeries`
  (`forecast.ts:326-336`).
- **Writes:** `recurring_series.status | name | user_cadence | user_amount_cents |
  user_next_expected_on | merged_into_id`, and `transactions.recurring_series_id |
  series_link_source='user'` (`recurring-links.ts`). Detection (`detectRecurringSeries`,
  `recurring.ts:348`) also runs automatically after every import (`import/service.ts`) and from the
  Transactions page's "Run categorization".
- **Links in:** dashboard `UpcomingBillsStrip` chips → `/recurring/{seriesId}`
  (`dashboard.ts:152`) and its empty state → `/recurring`; the transaction sheet's "Make recurring"
  (`LinkPanels.tsx:240` → `createSeriesFromTxnAction`); the nav item. The command palette has no
  recurring entities.
- **Links out:** series → `/merchants/{id}` (`SeriesDetail.tsx:127`) and `/categories/{id}` (`:134`).
  **Nothing else — there is NO link from any series to the transactions ledger, because
  `transactions-query.filterConditions` has no `series` filter at all
  (`src/services/transactions-query.ts:47-107`).**
- **Downstream consumers of the same math:** dashboard upcoming bills (`upcomingOccurrences` with a
  transfer filter), `forecast.fixedComponents`, `budgets.budgetTail`,
  `category-forecast.projectRecurringDriven`. An over-projecting series here silently inflates the
  dashboard, the budgets page, and `/spending`.

**Interactive inventory**

| element | file:line | intended | verdict |
| --- | --- | --- | --- |
| Forecast stat tile — "Projected income" | `src/components/recurring/ForecastCard.tsx:26-33` | Sum of positive forecast components for the rest of the month | **broken** — on the checked DB it reads $4,311.57, of which $4,256.07 (98.7%) comes from two series whose last charge was 80 and 25 days ago and which the page's own Calendar tab refuses to project. |
| "30-day net" footer total | `src/components/recurring/UpcomingList.tsx:38-43` | Net of the listed occurrences | **broken** — measured +$8,588.71 in green, of which $10,934.12 comes from 17 occurrences of 11 series the app's own `isSeriesActive()` classifies as inactive. Live-series-only the figure is −$2,345.41. It also mixes salary inflow with bills and includes both legs of internal transfers. |
| Suggestion card — "Not recurring" | `src/components/recurring/AllSeriesView.tsx:85-93` | `setSeriesStatus('dismissed')` | **broken** — destructive, no confirmation, no undo, no toast — AND dismissed series are rendered NOWHERE (`AllSeriesView.tsx:16-18` only renders detected/confirmed; `page.tsx:39` excludes them from the count). |
| Series row — "Dismiss" button | `src/components/recurring/AllSeriesView.tsx:175-183` | Remove a confirmed series | **broken** — sits at the end of every Active row. One misclick permanently removes a confirmed bill from the forecast, the calendar, the upcoming list AND the dashboard. Semantically wrong for the common case too: "End series" exists but only inside the detail page's ⋯ menu (`SeriesDetail.tsx:161-163`). |
| Amount token popover (decimal input, Enter or Save, "Use detected") | `src/components/recurring/CadenceSentence.tsx:275-326` | Override the expected per-charge amount | **broken** — the sign is inferred from the CURRENT effective amount (`const sign = cents < 0 ? -1 : 1`, `:257`). Override a bill to 0 (allowed — `overridesSchema` is `z.number().int().nullable()`, `actions.ts:93`), reopen and enter 20: the bill is saved as +$20.00, flipping into projected INCOME. "Use detected" also never names the detected amount. |
| Amount-history table lens rows | `src/components/recurring/AmountHistoryChart.tsx:91-103` | The same occurrences as numbers, newest first, with a variance column | **broken** — the "vs expected" column computes `abs(amount) − abs(expected)` (`:49`), so paying MORE on a bill renders POSITIVE, inverting the app-wide net-worth-signed convention. It also uses exact equality for "on plan" (`:45`) while the calendar uses a $1/2%/2σ tolerance band (`recurring-calendar.ts:68-79`). Rows are not sortable, not links, and DataTable is unpaginated. |
| "Detect now" submit button | `src/app/recurring/page.tsx:51-58` | Run `detectRecurringSeries` over the whole ledger and refresh | **missing-state** — `detectNowAction` (`actions.ts:38-41`) THROWS AWAY the `DetectionSummary {scannedGroups, created, updated, taggedTransactions}`. No toast, no count, no pending state, no `useFormStatus`, no disabled-while-running. Measured 24ms on the 1,673-row demo DB; the owner's DB is ~12× larger. Double-clicking fires it twice. |
| Tab link "Calendar" (+ count badge) | `src/components/recurring/RecurringTabs.tsx:21-34` | Navigate to `?tab=calendar` | **missing-state** — the badge is `calendarMonth.entryCount` for the CURRENT month, computed server-side (`page.tsx:35,40`), while the calendar's month is client state (`RecurringCalendar.tsx:66`). After paging to August the badge still reports July. |
| Calendar prev/next month IconButtons | `src/components/ui/CalendarGrid.tsx` header via `RecurringCalendar.tsx:105-113` | Page the month via `loadRecurringMonthAction` | **missing-state** — month lives in component `useState` (`RecurringCalendar.tsx:66`), not the URL and not persisted; it resets on every tab switch, back-navigation or refresh, and is unshareable. The transition is wrapped in `startTransition` but nothing renders a pending state, and there is no bound. |
| Suggestion card — "Confirm" (form action) | `src/components/recurring/AllSeriesView.tsx:76-84` | `setSeriesStatus('confirmed')` | **missing-state** — plain `<form action>` returning void: a full navigation with no toast, no undo, no pending state, while the detail page's equivalent uses the value-returning `setSeriesStatusAction` with a toast (`SeriesDetail.tsx:84-93`). With 31 detected series that is 31 separate page navigations; no "confirm all", no multi-select. |
| "Confirm" primary button (detail, detected only) | `src/components/recurring/SeriesDetail.tsx:143-149` | `setSeriesStatusAction('confirmed')` + toast | **missing-state** — no `.catch()` on the promise (`:85`). A rejected server action produces an unhandled rejection and a silent no-op. `LinkPanels.tsx` has 7 `.catch()` handlers for exactly this; all 8 action calls across SeriesDetail/SeriesMembership/CadenceSentence have zero. |
| ⋯ Menu → "Not recurring" | `src/components/recurring/SeriesDetail.tsx:158-160` | Dismiss | **missing-state** — toasts "Dismissed" with no Undo, while the far less consequential detach in the same page DOES offer Undo (`SeriesMembership.tsx:40-49`). |
| ⋯ Menu → "End series" (destructive) | `src/components/recurring/SeriesDetail.tsx:161-163` | Mark the series ended | **missing-state** — flagged `destructive:true` but no confirmation dialog and no undo; the toast is a bare "Series ended". This is the correct verb for "I cancelled Netflix" and it is buried two levels deep while the wrong verb (Dismiss) is a one-click button on the list. |
| Attach search input (debounced 200ms) + close button | `src/components/recurring/SeriesMembership.tsx:181-199` | Search unlinked active rows by description | **missing-state** — with an empty query the search falls back to an amount window around the expected charge (`recurring-detail.ts:308-317`) and the empty result reads "No similar unlinked transactions." with no mention of the amount filter. No date filter, no account filter, no "show all", and the 25-row cap (`ATTACH_LIMIT`) is never disclosed. |
| "Next expected" list (3 rows) | `src/components/recurring/SeriesDetail.tsx:237-249` | Show the next three projected occurrences | **missing-state** — rendered even for an INACTIVE series with no caveat, contradicting the "Inactive" badge two cards above. Rows are inert: no "skip this one", no "mark as paid", no calendar export. |
| Amount-history bar chart + hover tooltip | `src/components/recurring/AmountHistoryChart.tsx:105-154` | Show price creep against a dashed expected line | **missing-state / confusing** — the dashed `ReferenceLine` (`:126-131`) has no label and no legend; no tolerance band is drawn even though the calendar has a formal one; no range pills, no scrub, no focus/expand, no keyboard access to any bar. The only chart in the app with none of the ScrubChart kit (`docs/future-ideas.md:91`, open item #5). |
| Active/Inactive table column headers (Series / Cadence / Avg / Next / Annualized) | `src/components/recurring/AllSeriesView.tsx:117-124` | Label the columns | **undiscoverable** — not sortable. The single most valuable question this table can answer — "what are my most expensive subscriptions?" — requires sorting by Annualized, and the app already has a sortable `DataTable` primitive (`DataTable.tsx:11,193-215`) this table does not use. No filter by kind, no search. |
| Forecast stat tile — "Projected net" | `src/components/recurring/ForecastCard.tsx:42-49` | income + spending; the tfoot proves it sums to the component rows | **confusing** — the identity is honest (`forecast.ts:317-319`) but with the phantom series it reads +$4,063.52 when the live-series answer is roughly −$176.69 — a sign flip rendered in green. |
| Forecast stat tile — "EOM cash" | `src/components/recurring/ForecastCard.tsx:50-57` | Projected checking+savings balance at month end | **confusing** — today's cash + `projectedNet` (`forecast.ts:347`), but `projectedNet` includes credit-card charges while the card-autopay series is deliberately excluded (transfer kind, `forecast.ts:133`). Card spend is subtracted from CASH in the month it was charged; the payment that moves the cash is never modelled. The tile never states the starting cash. |
| Tab link "Upcoming" (+ count badge) | `src/components/recurring/RecurringTabs.tsx:21-34` | Navigate to `?tab=upcoming` | **confusing** — the badge is `upcoming.length` = 35, counting BOTH legs of every internal transfer (10 rows netting $0) and 17 phantom rows from dead series. The three badges (35 / 31 / 19) measure three unrelated things with no unit label. |
| Suggestion card — confidence % chip | `src/components/recurring/AllSeriesView.tsx:71-73` | Show detection confidence | **confusing** — bare percentages from 18% to 100% with no tooltip, no formula, no threshold. `confidence = 0.5·gapConsistency + 0.5·amountScore` (`recurring.ts:172-175`) and none of those inputs are shown anywhere in the UI. |
| Series row — "Avg ± σ" cell | `src/components/recurring/AllSeriesView.tsx:150-163` | Detected mean and stddev | **confusing** — shows `s.amountCentsAvg` (the DETECTED average) while the "Annualized" cell in the same row is computed from the EFFECTIVE amount (`annualizedCentsOf(eff)`, `recurring.ts:583`). A user amount override makes the two cells disagree with no marker. |
| Section header counts ("Suggestions — N to review", "Active N", "Inactive N") | `src/components/recurring/AllSeriesView.tsx:37,106` | Section sizes | **confusing** — the Active/Inactive split applies ONLY to confirmed series. All 11 inactive series in the checked DB are `status='detected'`, so they all sit in Suggestions with no staleness signal. |
| Calendar footer — Posted / Upcoming / N missed | `src/components/recurring/RecurringCalendar.tsx:151-169` | Month totals | **confusing** — "9 missed" is inert red text with no way to see WHICH nine, no filter, no list. `postedNetCents` nets income against bills into one figure labelled only "Posted". |
| Breadcrumb "Recurring" → `/recurring` | `src/components/recurring/SeriesDetail.tsx:97` | Return to the list | **confusing** — hardcoded with no `?tab=`, so a user who drilled in from All or Calendar is dumped on Upcoming. Same defect on "← All recurring" (`:266`), whose label says "All" while its href goes to Upcoming. |
| Status Badge (Detected / Confirmed / Dismissed / Ended) | `src/components/recurring/SeriesDetail.tsx:120` | State readout | **confusing** — a merged-away series gets a full explanatory paragraph with a link (`:169-177`); a dismissed or ended series gets only a neutral grey badge. Nothing says it has been removed from the forecast, the calendar and the upcoming list, or how to restore it. |
| "Inactive" Badge | `src/components/recurring/SeriesDetail.tsx:122-124` | Flag a stale series | **confusing** — states the conclusion but not the evidence: `lastMatchedOn`, `intervalDaysAvg` and `toleranceDays` are all in the payload (`recurring-detail.ts:249-252`) and none is rendered. |
| Category chip link → `/categories/{id}` | `src/components/recurring/SeriesDetail.tsx:133-137` | Close the category chain | **confusing** — derived as the MODAL category of linked rows (`recurring-detail.ts:108-130`), but the UI never says it is modal, so a 60/40 split shows one chip as if definitive. |
| Date token popover (`type=date` input, Save, "Use detected") | `src/components/recurring/CadenceSentence.tsx:193-241` | Override next-expected date | **confusing** — "Use detected" does not say WHAT the detected date is, even though `detectedNextExpectedOn` is in the payload (`recurring-detail.ts:246`) and simply never passed down (`SeriesDetail.tsx:181-193`). Inconsistent with the cadence token 40 lines above. |
| Stat tiles: Annualized / Per charge ±σ / Cadence / Confidence | `src/components/recurring/SeriesDetail.tsx:194-212` | The series' key statistics | **confusing** — "Per charge" renders the EFFECTIVE (override-first) amount with the DETECTED stddev appended (`:199-204`). Four tiles is thin: `lastMatchedOn`, `intervalDaysAvg`, `toleranceDays`, `matchedCount` and `detectedNextExpectedOn` are all shipped (`recurring-detail.ts:245-252`) and rendered nowhere. `recurring.ts:24-26` promises "statistics, not a black box"; the detail page shows four of nine. |
| Merge picker — search input + candidate buttons | `src/components/recurring/SeriesMembership.tsx:328-357` | Choose the series to absorb | **confusing** — each candidate shows only name + kind. No amount, no cadence, no last-charged, no linked count — nothing to distinguish "CHASE CREDIT CRD AUTOPAY" from "PAYMENT THANK YOU-MOBILE" (the two opposite legs of the same transfer, both offered). Candidates are every live series sorted alphabetically (`recurring-detail.ts:217-228`). |
| Forecast component rows (label / type / how computed / amount) | `src/components/recurring/ForecastCard.tsx:93-106` | Show every input that sums to Projected net | **dead-end** — `ForecastComponent` is `{label, kind, cents, detail}` with NO id (`forecast.ts:75-81`), so "Westview Apartments · 1 × $2,150.00 (monthly), next 2026-08-01" cannot be clicked to reach that series. No `overflow-x-auto` wrapper either (unlike `AllSeriesView.tsx:113`). |
| Forecast stat tile — "EOM net worth" | `src/components/recurring/ForecastCard.tsx:58-65` | Bridged latest net worth + projectedNet | **dead-end** — its two inputs (`bridgedNetWorthSeries` latest, `forecast.ts:336`) appear nowhere in "Show the math", which only covers income/spend/net. |
| Upcoming occurrence rows (date · name · kind · amount) | `src/components/recurring/UpcomingList.tsx:24-37` | List the next 30 days of expected charges | **dead-end** — plain `<li>` with no Link: the page's DEFAULT view has zero clickable rows, while the dashboard renders the same data as chips that each link to `/recurring/{seriesId}` (`dashboard.ts:152`, `UpcomingBillsStrip.tsx:46`). No merchant icon, no account. |
| Day-sheet entry link → `/recurring/{seriesId}` | `src/components/recurring/RecurringCalendar.tsx:124-141` | Open the series | **dead-end** — `CalendarEntry` carries `transactionId` for every posted charge (`recurring-calendar.ts:36,142`) and the UI never uses it. A 'missed' entry offers no action either. |
| Linked transaction row (date · description · account · amount) | `src/components/recurring/SeriesMembership.tsx:59-77` | The full membership history of the series | **dead-end** — not a link. `SeriesLinkedTxn.linkSource` is computed and shipped (`recurring-detail.ts:38,199`) and NEVER RENDERED, even though a 'user'-owned row is permanently outside detection's grouping pool (`recurring.ts:377`). Unpaginated; no date grouping, no totals, no anomaly filter. |
| "Show the math" `<details>` disclosure | `src/components/recurring/ForecastCard.tsx:68-74` | Expand the per-component breakdown | sensible |
| Forecast stat tile — "Projected spending" | `src/components/recurring/ForecastCard.tsx:34-41` | Sum of negative components | sensible |
| Tab link "All" (+ count badge) | `src/components/recurring/RecurringTabs.tsx:21-34` | Navigate to `?tab=all` | sensible |
| Suggestion card — series name link | `src/components/recurring/AllSeriesView.tsx:58` | Open `/recurring/{id}` | sensible |
| Series row — name link | `src/components/recurring/AllSeriesView.tsx:142-144` | Open `/recurring/{id}` | sensible — sub-label "{kind} · N matched" is genuinely useful. |
| Calendar day cell buttons (roving tabindex, arrows / Home / End) | `src/components/ui/CalendarGrid.tsx:162-185`, labels from `RecurringCalendar.tsx:78-84` | Focus a day and open its sheet; `aria-label` enumerates every entry | sensible — glyph-plus-color state grammar, per-cell label listing every item in words. |
| Calendar day glyphs and "+N" overflow marker | `src/components/recurring/RecurringCalendar.tsx:91-97` | Up to 4 state glyphs per day, then a count | sensible |
| Calendar Day Sheet (native `<dialog>`, Escape via KeyScope) | `src/components/recurring/RecurringCalendar.tsx:117-146` | List that day's recurring activity | sensible |
| Calendar legend | `src/components/recurring/RecurringCalendar.tsx:178-191` | Decode the four glyphs | sensible |
| Inline-editable series name (H1) | `src/components/recurring/SeriesDetail.tsx:106-116` | Click/Enter to edit, Enter/blur commits, toast+Undo | sensible — best-in-class control on this surface (`useInlineEdit.ts:94-98`). *See `/recurring/[id]` BAD #1 for the identity-fork hazard.* |
| Merchant chip link → `/merchants/{id}` | `src/components/recurring/SeriesDetail.tsx:126-131` | Close the merchant chain | sensible |
| ⋯ "Series actions" Menu → "Confirm" | `src/components/recurring/SeriesDetail.tsx:155-157` | Re-confirm a dismissed/ended series | sensible — correctly hidden for a merged-away series (guarded again in `recurring.ts:493`). |
| Merged-away banner link → target series | `src/components/recurring/SeriesDetail.tsx:169-177` | Explain the merge and link on | sensible — exemplary honesty pattern; propagate to dismissed/ended. |
| Cadence token popover (`role=menu` radio list + "Use detected (monthly)") | `src/components/recurring/CadenceSentence.tsx:123-167` | Override the cadence, or hand it back to detection | sensible — arrow-key cycling, `aria-checked`, and the reset item NAMES the detected value. The model the other two tokens fail to follow. |
| Amount-history lens ViewSwitcher (Chart ⇄ Table) | `src/components/recurring/SeriesDetail.tsx:221-227` | Flip the bars to numbers; URL + persisted per-surface | sensible |
| "Merge another series in" popover trigger | `src/components/recurring/SeriesMembership.tsx:286-294` | Open the merge picker (live series only) | sensible — correctly hidden when candidates are empty (`:282`) and when the series is not live (`SeriesDetail.tsx:256`). |
| Merge confirm step ("Cancel" / "Merge in") | `src/components/recurring/SeriesMembership.tsx:303-325` | Two-step confirmation for an irreversible reshape | **broken** — the confirm exists but the operation is PERMANENT: `mergeSeries` sets the source `status='ended'` with `mergedIntoId` (`recurring-links.ts:174-177`), `setSeriesStatus` then refuses to ever re-confirm it (`recurring.ts:493`), and there is no unmerge action anywhere in the codebase. The success toast (`:278`) offers no Undo. |
| "Find transactions to attach" toggle button | `src/components/recurring/SeriesMembership.tsx:166-177` | Open the attach search panel | sensible — focus returns to the trigger on close (`:101-106`). |
| Attach candidate checkboxes + "Attach N" button | `src/components/recurring/SeriesMembership.tsx:209-236` | Multi-select and attach with an Undo toast | sensible — disabled at zero selection, count shown. No shift-click range select, and no `.catch()`. |
| Linked-row ⋯ Menu → "Not part of this series" | `src/components/recurring/SeriesMembership.tsx:68-73` | Detach one charge, with Undo | sensible — the undo re-attaches by id (`:40-49`); the best destructive-action pattern on the surface, and the one Dismiss and Merge do not follow. |
| Global toast + `a` mnemonic to focus the newest action toast | `src/components/shell/AppShell.tsx:71-76`, `ToastMnemonic.tsx` | Reach Undo from the keyboard | sensible — works for rename/detach/attach; useless for Dismiss/End/Merge because those toasts carry no action. |

**Good**

1. The user-override model is genuinely excellent architecture: `user_cadence` /
   `user_amount_cents` / `user_next_expected_on` shadow detection's own columns, detection keeps
   refining underneath, and `effectiveSeries()` (`recurring.ts:642-651`) reads user-first. Nothing
   else in the app lets a human correct a derived value without destroying the derivation.
2. The editable cadence SENTENCE instead of a form. "charges monthly around the 3rd, about $15.49
   from Chase Freedom" with three dotted-underline tokens (`CadenceSentence.tsx:57-89`) is the single
   most product-feeling control in MoneyApp. `schedulePhrase()` (`labels.ts:81-85`) even switches from
   day-of-month to weekday for weekly/biweekly cadences.
3. `recomputeSeriesStats` as the shared settling point (`recurring.ts:274-320`). Every user link
   action re-derives stats over the FULL tagged set inside the same transaction, so a later detection
   run finds the stored stats already equal to what it would compute. This is why attach/detach/merge
   survive re-detection.
4. The calendar's day-state grammar: glyph carries meaning, color reinforces it, `aria-label`
   enumerates every entry in words (`RecurringCalendar.tsx:28-52,78-84`), and `classifyPostedAmount`
   (`recurring-calendar.ts:68-79`) uses a max($1, 2%, 2σ) band so a naturally-variable bill is not
   flagged amber every month.
5. Merge safety is unusually rigorous: `mergeSeries` refuses an already-merged source, follows the
   target's own merge chain, refuses a non-live target because "the money would silently vanish"
   (`recurring-links.ts:159-166`), and `setSeriesStatus` permanently refuses to re-confirm a merged
   series (`recurring.ts:493`). `resolveMergeTarget` is cycle-guarded.
6. The forecast's components-ARE-the-math contract: totals are derived by summing the visible
   component rows (`forecast.ts:317-319`) and the `<tfoot>` restates the identity
   (`ForecastCard.tsx:108-117`).
7. Detection deliberately never touches a row with `series_link_source='user'` (`recurring.ts:377`) —
   the same ownership shield as `categorization_source='user'`, enforced at the grouping stage.
8. `projectOccurrences` skips overdue occurrences before the window start (`recurring.ts:696`) rather
   than dumping a backlog into the forecast, and `CADENCE_TOLERANCE_DAYS` scales grace with cadence.

**Bad** (ranked)

1. **CRITICAL — The Upcoming tab and the Forecast card project charges from dead series; the Calendar
   tab on the same page refuses to.** `src/services/recurring-calendar.ts:154-155` skips any series
   failing `isSeriesActive()` before projecting forward, with an explicit comment that "a long-dead
   series must not litter the month with 'upcoming' charges it will never make."
   `upcomingOccurrences` (`src/services/recurring.ts:719-723`) and `forecast.fixedComponents`
   (`src/services/forecast.ts:126-130`) select on `status IN ('detected','confirmed')` with NO
   isActive filter. Measured against `data/moneyapp.db` at today=2026-07-27: 11 of 31 series are
   inactive; the Upcoming tab renders 35 rows totalling +$8,588.71 in green, of which 17 rows
   ($10,934.12) come from inactive series — Employer (cash) $1,312.88 ×4 (last charged 2026-07-02,
   cadence weekly), Acme Corp (payroll) $2,943.19 ×2 (last charged 2026-05-08, 80 days ago),
   Sweetgreen, Shell, Spotify, Con Edison, CAPITAL ONE 360 TRANSFER. Live-series-only the 30-day net
   is −$2,345.41. The Forecast card reads Projected income $4,311.57 (98.7% from those two series) and
   Projected net +$4,063.52 instead of roughly −$176.69, while the Calendar tab reports upcoming
   $55.50 for the same month. One page, three mutually contradictory answers, and the two wrong ones
   are the two he sees first. This also propagates to the dashboard, `budgets.budgetTail` and
   `category-forecast.projectRecurringDriven`.
2. **CRITICAL — "Not recurring" and row-level "Dismiss" are one-click, unconfirmed, un-undoable, and
   the dismissed series then vanishes from every screen.**
   `src/components/recurring/AllSeriesView.tsx:85-93` (suggestion cards) and `:175-183` (every Active
   row) post `dismissSeriesAction` directly. `AllSeriesView.tsx:16-18` only renders 'detected' and
   'confirmed', and `page.tsx:39` excludes dismissed/ended from the count, so a dismissed series is
   rendered NOWHERE. Mis-click Dismiss on Westview Apartments ($2,150/mo rent, the largest fixed cost
   in the file): the forecast silently drops $2,150 of committed spend, the dashboard's upcoming-bills
   strip loses it, and the only recovery is typing `/recurring/{uuid}` by hand. The detail page's
   equivalent at least toasts (`SeriesDetail.tsx:158-160`), so the same verb has two different safety
   levels depending on where you click it.
3. **HIGH — Suggestion cards hide the one fact that decides the answer: when the series last actually
   charged.** `SuggestionCard` (`src/components/recurring/AllSeriesView.tsx:53-97`) renders name,
   kind, cadence, approximate amount and confidence%, but not `lastMatchedOn`, `isActive` or
   `matchedCount` — all three present on `SeriesView` (`recurring.ts:516-519`). All 11 inactive series
   in the checked DB are `status='detected'`, so the Active/Inactive split (confirmed-only, `:17-18`)
   never touches them. "Acme Corp (payroll) — Biweekly · about $2,943.19 — 100%" gets confirmed and
   permanently blesses $5,886/mo of phantom income; the 100% figure measures how regular the PAST
   occurrences were, not whether the series is still alive.
4. **HIGH — Merge is irreversible with no unmerge path, and the picker gives you nothing to pick
   with.** `mergeSeries` (`src/services/recurring-links.ts:168-181`) relinks rows, sets the source
   ended with `mergedIntoId`, and there is no inverse function anywhere in `src/`. `setSeriesStatus`
   permanently refuses re-confirmation (`recurring.ts:491-495`). The success toast
   (`SeriesMembership.tsx:278`) carries no Undo, and the picker (`:339-357`) lists every live series
   alphabetically showing only name + kind (`recurring-detail.ts:217-228`). The checked DB contains
   "CHASE CREDIT CRD AUTOPAY" (transfer, −$993.02) and "PAYMENT THANK YOU-MOBILE" (transfer,
   +$993.02) — adjacent in an alphabetical list, indistinguishable in the picker.
5. **HIGH — The default tab has no clickable rows — a strict regression against the dashboard teaser
   that links into it.** `src/components/recurring/UpcomingList.tsx:24-37` renders each occurrence as
   a plain `<li>`. The dashboard renders the SAME `upcomingOccurrences` data as chips linking to
   `/recurring/{seriesId}` (`src/services/dashboard.ts:145-153`, `UpcomingBillsStrip.tsx:46-58`) AND
   filters out transfer-kind occurrences with an explicit comment. `/recurring` does neither, so it
   also shows 10 rows of internal transfers (5 pairs netting exactly $0). `dashboard.ts:20` claims
   "the numbers reconcile with the tab they link to"; they do not.
6. **HIGH — Eight server-action calls on this surface have no `.catch()`.**
   `src/components/recurring/SeriesDetail.tsx:85`, `SeriesMembership.tsx:33,45,145,158,271`, and
   `CadenceSentence.tsx:48` (all three token saves) use `void action().then(...)` with no rejection
   handler; `LinkPanels.tsx` on `/transactions` has 7 `.catch(() => toast(NETWORK_ERROR))` for exactly
   these. On a flaky phone connection "Merge in" fails: popover stays open, no toast, no error —
   indistinguishable from a dead button. He taps again, and if the first call actually succeeded
   server-side the second throws "Series has already been merged".
7. **MEDIUM — "Detect now" discards its own result summary and shows no progress.**
   `detectRecurringSeries` returns `DetectionSummary` (`recurring.ts:192-197`);
   `src/app/recurring/actions.ts:38-41` drops it and returns void, and the button
   (`src/app/recurring/page.tsx:51-58`) has no `useFormStatus`, no disabled state, no spinner.
8. **MEDIUM — The amount override infers direction from the current value, so a bill overridden to $0
   becomes income on the next edit.** `AmountToken` computes `const sign = cents < 0 ? -1 : 1` from
   the current EFFECTIVE amount (`src/components/recurring/CadenceSentence.tsx:255-271`) and commits
   `sign × abs(parsed)`; `overridesSchema` accepts 0 (`actions.ts:93`). Set a bill to 0 (a plausible
   "neutralise this" workaround given there is no pause/skip feature), reopen, enter 20 — the series
   is saved at +$2000 and appears as projected INCOME.
9. **MEDIUM — Two different definitions of "matches the expected amount" render on the same series.**
   The calendar uses a max($1, 2%, 2σ) tolerance band (`recurring-calendar.ts:55-79`); the
   amount-history table uses exact equality (`src/components/recurring/AmountHistoryChart.tsx:44-51`,
   tooltip likewise `:143`). Con Edison expected at $108.62 with σ ≈ $8: a $112.40 charge shows green
   ✓ "paid" on the Calendar tab and "+$3.78" variance on the detail page. The dashed `ReferenceLine`
   (`:126-131`) draws the expected value with no band and no label.
10. **MEDIUM — The "vs expected" column inverts the app's sign convention.**
    `src/components/recurring/AmountHistoryChart.tsx:44-51` renders
    `formatCentsSigned(abs(amount) − abs(expected))`, so paying MORE on an expense produces a
    plus-signed number in an app where + means money in (`docs/schema.md`, `Money.tsx:12`). It escapes
    being catastrophic only because the cell is ink-faint rather than flow-coloured.
11. **MEDIUM — Half the computed series statistics are shipped to the client and never rendered.**
    `lastMatchedOn`, `intervalDaysAvg`, `toleranceDays`, `detectedNextExpectedOn`, `amountCentsAvg`
    and per-row `linkSource` (`recurring-detail.ts:38,199,245-252`) return 0 grep occurrences in
    `SeriesDetail.tsx`/`AllSeriesView.tsx`. Consequences: "Inactive" and "Confidence 18%" are
    unfalsifiable; `DateToken`'s "Use detected" cannot name the detected date while `CadenceToken`
    does (`CadenceSentence.tsx:163`); the owner cannot see which links he made by hand
    (`src/components/recurring/SeriesDetail.tsx:194-212`,
    `src/components/recurring/SeriesMembership.tsx:59-77`).
12. **MEDIUM — "EOM cash" adds credit-card charges to a cash balance while excluding the payment that
    would move it.** `projectedEomCashCents = today's checking+savings + projectedNetCents`
    (`src/services/forecast.ts:325-347`); `projectedNet` includes card-charged spending while the
    autopay series is excluded as transfer-kind (`forecast.ts:133`). $400 of card charges drop EOM
    cash $400 this month even though nothing left checking, and next month's actual autopay is never
    modelled. `src/components/recurring/ForecastCard.tsx:50-57` shows no starting balance, no math
    row, no drill-through.
13. **MEDIUM — There is no way to reach a series' actual transactions, and no way to filter the ledger
    by series at all.** `src/services/transactions-query.ts:47-107` supports account, merchant,
    category and status views — there is no `series` filter. `LinkedTransactions` rows are plain text
    (`src/components/recurring/SeriesMembership.tsx:59-77`), amount-history rows have no `rowHref`,
    and the calendar day sheet links to the series rather than the transaction despite carrying
    `transactionId` (`recurring-calendar.ts:36,142`; `RecurringCalendar.tsx:124`).
14. **MEDIUM — The calendar's month is neither in the URL nor persisted, so it resets constantly and
    the tab badge goes stale.** `src/components/recurring/RecurringCalendar.tsx:66-76` holds the month
    in `useState` while every other lens in the app resolves URL > persisted > default
    (`lib/view-state.ts`), and the badge counts are computed server-side for the current month only
    (`src/app/recurring/page.tsx:35,40`).
15. **LOW — Every page load computes all three tabs' data plus the forecast, whether or not it is
    rendered.** `src/app/recurring/page.tsx:32-35` unconditionally calls `listSeries`,
    `upcomingOccurrences`, `forecastCurrentMonth` and `recurringCalendar`. Measured on the 1,673-row
    demo DB: `forecastCurrentMonth` 112.6ms, `listSeries` 7.5ms, calendar 0.9ms. `listSeries` loads
    every active transaction's `recurring_series_id` into JS to build a count map
    (`src/services/recurring.ts:551-560`) — a full table scan just to render "N matched". Tab switches
    are full navigations, so the 112ms forecast re-runs on every one.
16. **LOW — Confirming 31 detected series requires 31 full page navigations; the owner has confirmed
    zero.** Each Confirm is an individual `<form action>` POST + navigation
    (`src/components/recurring/AllSeriesView.tsx:76-93`) with no toast, no keyboard shortcut, no
    multi-select. 15 of the 31 have confidence ≥ 1.0. Meanwhile status barely matters for money —
    `upcomingOccurrences`, `recurringCalendar` and `fixedComponents` treat 'detected' and 'confirmed'
    identically — so the triage buys nothing visible.
17. **LOW — Breadcrumb and "← All recurring" both drop the tab, and the footer link's label
    contradicts its href.** `src/components/recurring/SeriesDetail.tsx:97,266` both point at bare
    `/recurring`, which `page.tsx:20` resolves to `tab='upcoming'`.
18. **LOW — Dismissed and ended series get no explanation, while merged ones get a good one.**
    `src/components/recurring/SeriesDetail.tsx:118-124,169-177`.
19. **LOW — "9 missed" is a dead number and a missed occurrence has no verbs.**
    `src/components/recurring/RecurringCalendar.tsx:117-146,162-166`: no filter, no list, and in the
    day sheet no "I paid this in cash", no "skip this month", no "attach the charge that covered it".

**Change** (ranked)

1. **Filter `upcomingOccurrences` and `forecast.fixedComponents` by `isSeriesActive`, and show what
   was excluded rather than hiding it.** (M) Add an `activeOnly` option to `upcomingOccurrences`
   (`recurring.ts:714`) applying `isSeriesActive(s, today)` where `recurring-calendar.ts:155` already
   does; same in `forecast.fixedComponents` (`forecast.ts:126-130`). Additive: a collapsed footer
   under `UpcomingList` — "3 series paused (no charge in 78+ days) — $4,240.21 not projected. Show →"
   — expanding into the excluded rows, each linking to its series. Add the same as a component row
   with `cents=0`. Pin the divergence with a unit test asserting the set of series contributing to
   `upcomingOccurrences` equals the set contributing 'upcoming' entries to `recurringCalendar`.
2. **Link everything in the Upcoming tab, and filter transfers the way the dashboard does.** (S) Wrap
   each row in a Link to `/recurring/{seriesId}` (`UpcomingList.tsx:24-37`; `seriesId` is already on
   `SeriesOccurrence`), apply the `kind !== 'transfer'` filter `dashboard.ts:145` uses but keep a
   "Transfers (5 pairs, net $0)" collapsed group, and split the footer into "Due: −$X · Expected in:
   +$Y · Net: $Z" plus the dashboard's "$X due before your next paycheck (Aug 6)" line.
3. **Add `.catch()` + toast to every server-action promise, and pending state to every mutating
   control.** (S) Mirror `LinkPanels.tsx` at `SeriesDetail.tsx:85`,
   `SeriesMembership.tsx:33/45/145/158/271`, `CadenceSentence.tsx:48`; add a `busy` guard so
   double-taps cannot fire a merge twice; give "Detect now" a `useFormStatus` label and surface the
   `DetectionSummary` as a toast by converting `detectNowAction` (`actions.ts:38-41`) to the
   `ActionResult` pattern the rest of the file already uses.
4. **Fix the amount-override sign trap and the two "Use detected" asymmetries.** (S) Derive the sign
   from the series KIND rather than the current cents (`CadenceSentence.tsx:255-271`), or add an
   explicit direction toggle; reject 0 in `overridesSchema` (`actions.ts:93`). Pass
   `detectedNextExpectedOn` (`recurring-detail.ts:246`) and `amountCentsAvg` down so the reset items
   read "Use detected (Aug 1)" and "Use detected ($108.62)" like `:163`.
5. **Reconcile the variance semantics and label the reference line.** (S) Use
   `classifyPostedAmount`'s tolerance (`recurring-calendar.ts:68-79`) in `AMOUNT_COLUMNS`
   (`AmountHistoryChart.tsx:44-51`), draw the band as a shaded region, label the dashed line
   ("expected $108.62"), and change the variance formula to net-worth-signed
   (`r.amountCents − expectedCents`).
6. **Preserve the tab across navigation and put the calendar month in the URL.** (S) Pass `?tab=`
   through `SeriesDetail.tsx:97,266` (the detail page already receives searchParams, `page.tsx:28`,
   and discards everything but `lens`), fix the label/href contradiction, and promote the calendar
   month to `?month=YYYY-MM` resolved server-side (`RecurringCalendar.tsx:66`), which also fixes the
   stale badge.
7. **Paginate or window the linked-transactions list and the amount-history table.** (S)
   `SeriesMembership.tsx:58-77` and `AmountHistoryChart.tsx:92-102` render every row (49 in the demo
   DB; 200+ for a weekly cash-salary series on the real ledger). Show the most recent 20 with "Show
   all N", add a per-row `linkSource` marker, and an "only show amount anomalies" toggle.
8. **Put the evidence on the card: last-charged, matched count, staleness chip.** (M)
   `SuggestionCard` (`AllSeriesView.tsx:53-97`) already receives `lastMatchedOn`, `matchedCount` and
   `isActive`. Render "12 charges · last Jul 3" and a warning chip "No charge in 80 days" when
   `!isActive`; add last-charged to the Active/Inactive tables; on the detail page expand the Stat row
   or add a "Detection evidence" disclosure with `intervalDaysAvg`, `toleranceDays`, `matchedCount`
   and the confidence breakdown (`recurring.ts:172-175`).
9. **Give the forecast components identity so the math table drills through, and explain the two
   orphan tiles.** (M) Add an optional `href` (and `seriesId`/`categoryId`) to `ForecastComponent`
   (`forecast.ts:75-81`) — `fixedComponents` already has the series row at `:126` — and render labels
   as links (`ForecastCard.tsx:95-97`). Add disclosure rows for EOM cash and EOM net worth showing
   their starting values, wrap the table in `overflow-x-auto`, and note when a fixed component came
   from a user override.
10. **Make the All table a real table: sortable, filterable, reusing DataTable.** (M) Port
    `AllSeriesView.tsx:113-133` to `DataTable` (`DataTable.tsx:11,148-155,193-215`) with
    `?sort=annualized&dir=desc` in the URL, plus kind filter chips and a text filter.
11. **Make Dismiss, End and Merge safe.** (L) Convert the two `<form action>` buttons
    (`AllSeriesView.tsx:76-93,175-183`) to `setSeriesStatusAction` with an Undo toast capturing the
    prior status. Add `unmergeSeries`: clear `mergedIntoId`, restore status, move back the rows the
    merge relinked (record the moved ids in `MergeResult`, mirroring `AttachResult.undo` at
    `recurring-links.ts:22-25`). Add a collapsed "Dismissed & ended (N)" section. Enrich merge
    candidates with amount, cadence, last-charged and matched count, ranked by similarity.

**Add** (ranked)

1. **Export the next 90 days as an `.ics` feed / add a single occurrence to the phone calendar.** (S)
   A VEVENT per projected occurrence with the amount in the title — pure formatting over data
   `upcomingOccurrences` already returns, and the owner reads this app on his phone.
2. **Subscription audit view — the "what am I actually paying for" screen.** (M) A fourth tab (or a
   re-sort of All) ranking subscription/bill series by annualized cost
   (`annualizedCents`, `recurring.ts:534-537`), with a sparkline from `amountHistory`
   (`recurring-detail.ts:202-204`), a "price increased 3 times, +18% since Jan 2024" flag comparing
   the first and last thirds, a per-series "cost since first charge", and a total monthly-equivalent
   burn. Every input already exists and the total is never stated anywhere.
3. **A "cancelled / paused / skip this month" vocabulary.** (M) Three additive states: promote
   `ended` to a one-click "I cancelled this" on every row (distinct from "Not recurring"); a
   per-occurrence skip (`recurring_skips` overlay subtracted by `projectOccurrences`, surfaced in the
   calendar day sheet and the Next-expected list); an auto-pause once `isSeriesActive` goes false with
   a one-click "still active, reset next date".
4. **Bulk triage for the suggestion queue.** (M) Multi-select checkboxes with bulk Confirm / Not
   recurring, "Confirm all above 90% confidence", and keyboard triage (j/k, y/n) through the existing
   KeyScope stack at `PRIORITIES.list` — the review inbox already does this (`ReviewInbox.tsx:108`).
   Return an `UndoPatch` the way `bulk-edit.ts:100-184` does.
5. **Series → ledger drill-through (`?series=` filter on `/transactions`).** (M) Add `series` to
   `TxnFilters`/`filterConditions` (`src/services/transactions-query.ts:47-107`) as
   `eq(transactions.recurringSeriesId, id)`, then link the "Linked transactions · N" heading, each
   linked row, each amount-history row, and use the `transactionId` the calendar already carries
   (`recurring-calendar.ts:142`) to open that row's TransactionSheet.
6. **Compare-to-last-month and year-over-year on the calendar and the forecast.** (M) A ghost overlay
   of last month's entries and a "vs last month" delta on each forecast tile; the ghost machinery
   already exists as `reindexByPosition` (`projection.ts:408`) and is used on `/spending`.
7. **Chart parity for the amount-history chart** (roadmap item #5, `docs/future-ideas.md:127`). (M)
   Wrap in `ChartFocus`, add `ChartRangePills` driven by `lib/chart-window`, add keyboard scrub via
   `lib/scrub`, and draw the tolerance band. All five primitives already exist in
   `src/components/charts/` and `src/lib/`.
8. **Notification-grade attention surface: a "needs your attention" band above the tabs.** (M) N
   missed occurrences this month (`recurring-calendar.ts` `missedCount`), N series that just went
   inactive, N amount changes beyond tolerance in the last 30 days, N suggestions awaiting a decision
   — each a filter link, plus a nav badge the way Transactions has one (`SideNav.tsx:34-41`).
9. **Cash-flow calendar view: a running projected balance rail alongside the recurring calendar.** (L)
   The calendar knows every expected in/outflow per day and the app knows today's cash
   (`forecast.ts:325-334`). Render a projected daily balance through month end with the lowest point
   flagged ("tightest day: Aug 2, $412") and negative days marked. "Can I cover rent on the 1st?" is
   the operative question for a variable cash income and the page currently makes him reconstruct it.
10. **Detection tuning surface: "why isn't X detected?" and a manual series builder.** (L) A panel of
    near-miss groups (≥3 occurrences failing `fitCadence` or the CV≤0.2 amount-stability test,
    `recurring.ts:159,166`) with the reason in words and a "make it recurring anyway" button, plus a
    "New series" wizard reusing `createSeriesFromTransaction` and `attachTransactions`.
    `docs/future-ideas.md:250` records that the owner's real Fordham payroll is NOT modelled as a
    series and his projected income was $0.01 for that reason. The page that owns recurring has no way
    to create a recurring.

---

## /recurring/[id]

**Purpose** — The page where the owner argues with the app's guess about a repeating charge.
Detection (`services/recurring.ts:348`) mines the ledger for merchant/description groups with a stable
gap and a stable amount and files them as series; this page is the one place where a human can say
"yes that's my rent", "no that's not recurring", "it's actually $1,150 not $1,046", "these two are the
same subscription", or "that charge isn't part of this". Every edit here is a user override the
forecast reads first (`recurring.ts:642` `effectiveSeries`; `services/forecast.ts:136-137`), so this
page is literally the steering wheel on the end-of-month projection and the 30-day upcoming list.

**Connections**

- **Inbound:** every series name across the app — `/recurring` All tab rows and suggestion cards
  (`AllSeriesView.tsx:58,142`), the calendar day sheet (`RecurringCalendar.tsx:125`), the dashboard's
  upcoming-bills list (`services/dashboard.ts:152`), the budgets recurring tail
  (`services/budgets.ts:384`), the category page's series list (`services/category-detail.ts:155`),
  and a merged-away series' banner (`SeriesDetail.tsx:172`). The `/recurring` Upcoming tab rows are
  NOT links (`UpcomingList.tsx:24-36`) — the default tab is the one place a series name is inert.
- **Reads:** `recurring_series` (all stats + the three `user_*` override columns,
  `schema/recurring.ts:33-50`), its active linked transactions joined to accounts, the whole
  `categories` table (to pick a modal category, `recurring-detail.ts:180-192`), the merchant row, and
  every other live series as merge candidates (`recurring-detail.ts:217-228`).
- **Writes:** `recurring_series.name / status / user_cadence / user_next_expected_on /
  user_amount_cents / merged_into_id`, and `transactions.recurring_series_id + series_link_source` on
  attach/detach/merge (`recurring-links.ts:29,93,136`). Those writes propagate to the month forecast
  (`forecast.ts:126-154`, status detected|confirmed only), the calendar
  (`recurring-calendar.ts:95-97`), `upcomingOccurrences` (`recurring.ts:714-729`), budget tails and
  the dashboard.
- **Outbound:** `/merchants/[id]`, `/categories/[id]`, `/recurring` (twice),
  `/recurring/[mergeTarget]`. There is NO outbound link to a transaction, to `/accounts/[id]`, or to a
  ledger filtered by this series — `services/transactions-query.ts:48-144` has no `series` filter, so
  "show me every charge of this series in the ledger" is unrepresentable in a URL.

**Interactive inventory**

| element | file:line | intended | verdict |
| --- | --- | --- | --- |
| Series-name inline editor (click / Enter / Space → input, Enter or blur commits, Esc cancels) | `src/components/recurring/SeriesDetail.tsx:106-116` | Rename the series to something human | **broken** — for a merchant-less series the name IS detection's identity key (`recurring.ts:402` `name = txns[0].normalizedDescription`, matched at `:408-410`). Renaming silently forks the series on the next Detect now. `renameSeries`'s own docstring claims it "does not affect grouping" (`recurring-detail.ts:365`). |
| Menu item "Not recurring" (dismiss) | `src/components/recurring/SeriesDetail.tsx:158-160` | Mark the pattern as not a series | **broken** — one click, no confirmation, no undo in the toast. Removes the series from the forecast, the calendar and the 30-day upcoming list. It is also offered on a merged-away (already dead) series, flipping its status ended→dismissed while `mergedIntoId` stays set — a state no other code path produces. |
| Menu item "End series" (destructive) | `src/components/recurring/SeriesDetail.tsx:161-163` | Stop projecting this series | **broken** — same: mutates money projections with one click, no confirm, no undo — while detaching a single transaction two cards below DOES get an Undo toast (`SeriesMembership.tsx:40-49`) and merging DOES get a two-step confirm (`:303-325`). The consequence ranking is inverted. |
| Amount token → popover with $ input, Enter-to-commit, Save + "Use detected" | `src/components/recurring/CadenceSentence.tsx:246-329` | Override the expected per-occurrence amount | **broken** — `commit()` calls `close()` unconditionally after the catch (`:270`), so an unparseable entry fires the error toast AND closes the editor, discarding what was typed. The sign is also locked to the current value's sign (`:257`), so an income series can never be overridden negative and vice versa. |
| Stat: "Per charge" with ±σ | `src/components/recurring/SeriesDetail.tsx:198-209` | Expected charge and its historical spread | **broken** — the number is `nextExpectedAmountCents` (the USER override when one exists, `recurring.ts:649`) but the ± is `amountCentsStddev`, the population stddev around the DETECTED mean (`recurring.ts:168`). Overriding rent to $1,150 on a series detected at $1,046 ± 12 renders "$1,150.00 ±12.00". |
| "Next expected" list rows (date + amount) | `src/components/recurring/SeriesDetail.tsx:237-249` | Show the next three projected occurrences | **broken** — rendered regardless of status. `projectOccurrences` (`recurring.ts:687`) has no status filter, so a DISMISSED, ENDED or MERGED-AWAY series still lists three future charges with amounts — money `forecast.ts:130`, `recurring-calendar.ts:96` and `recurring.ts:722` have all deliberately excluded. Rows are inert: no skip, no mark-paid, no calendar export. |
| Table-lens "vs expected" cell verdict "on plan" | `src/components/recurring/AmountHistoryChart.tsx:45-51` | Flag charges that match the expectation | **broken/confusing** — exact-cent equality (`r.amountCents === expectedCents`), while the calendar for the SAME series uses `classifyPostedAmount`'s max($1, 2%, 2σ) band (`recurring-calendar.ts:66-78`). On a variable bill this column reads as drift on every row while the calendar shows all green. |
| "Merge another series in" button → popover | `src/components/recurring/SeriesMembership.tsx:286-294` | Fold a duplicate series into this one | **broken** — irreversible: `mergeSeries` (`recurring-links.ts:176-186`) relinks the source's rows to the target, sets the source `status='ended'` with `mergedIntoId`, and a repo-wide grep shows NO unmerge path exists (`mergedIntoId` is only ever written at `recurring-links.ts:184`). The two-step confirm is the only protection. |
| Attach "Undo" toast action | `src/components/recurring/SeriesMembership.tsx:153-162` | Reverse an accidental attach | **broken** — rolls back by calling `detachFromSeriesAction` per id, which SETS `series_link_source='user'` (`recurring-links.ts:117`). The action already returned a lossless `UndoPatch` (`actions.ts:128`) the client throws away. A never-linked row attached and immediately undone is left permanently user-owned and skipped forever by detection (`recurring.ts:377`). |
| Detach "Undo" toast action | `src/components/recurring/SeriesMembership.tsx:40-49` | Restore a detached charge | **broken** — the inline comment claims "lossless: re-attaching restores the exact link (user-owned either way)" — false for a detection-owned row: it re-attaches via `attachToSeriesAction` which stamps 'user' (`recurring-links.ts:75`). `detachFromSeriesAction` returns the real lossless patch (`actions.ts:143`) and the client ignores it, unlike the transaction sheet which routes every mutation through `offerUndoToast` (`components/transactions/undo-toast.ts:12-27`). |
| Kind avatar (banknote/receipt/repeat/arrow-left-right/tag) | `src/components/recurring/SeriesDetail.tsx:102-104` | Show the series kind at a glance | **missing-state** — decorative only. `kind` drives whether the series is excluded from the forecast (`forecast.ts:135` skips transfer kinds) and which verb the sentence uses, but there is no control anywhere in the app to correct a mis-classified kind. |
| "Confirm" primary button (status=detected only) | `src/components/recurring/SeriesDetail.tsx:142-150` | Promote a detected suggestion to confirmed | **missing-state** — no pending/disabled state; `useTransition`'s `isPending` is discarded at `SeriesDetail.tsx:64` (`const [, startTransition]`). Also duplicated: the same Confirm exists in the ⋯ menu at `:155-157` whenever status!=='confirmed'. |
| Merge confirm "Merge in" / "Cancel" | `src/components/recurring/SeriesMembership.tsx:303-325` | Confirm an irreversible merge | **missing-state** — the sentence says "Its charges move here and it ends" but never says how many charges (the relinked count is only known after the fact, `:278`). No busy state — a double-click fires `mergeSeries` twice, the second throwing "Series has already been merged" (`recurring-links.ts:163`) into a red toast. |
| Attach candidate checkbox rows | `src/components/recurring/SeriesMembership.tsx:209-224` | Multi-select rows to attach | **missing-state** — date, description, amount only. No account, no category, no existing-series indicator — and no "select all", which the ledger's bulk bar has. |
| Attach empty-query fallback list | `src/components/recurring/SeriesMembership.tsx:204-207` | Suggest similar unlinked rows before typing | **missing-state** — with no query the search bands ±15% around the expected amount (`recurring-detail.ts:309-317`) — but ONLY if the series has an expected amount. When it is null the amount conditions are skipped entirely and the panel lists the 25 most recent unlinked rows in the whole ledger, under "No similar unlinked transactions." The band is never stated on screen. |
| Amount-history bars + recharts hover tooltip | `src/components/recurring/AmountHistoryChart.tsx:105-154` | Make price creep visible | **missing-state** — pointer-only: no keyboard scrub (unlike ScrubChart's `role=slider`), no click-through, no range pills, no brush, no focus/expand. Renders ALL occurrences, so a 5-year weekly series is ~260 slivers in a 176px box. |
| Per-row ⋯ menu "Actions for {description}" | `src/components/recurring/SeriesMembership.tsx:68-73` | Row verbs on a linked charge | **missing-state** — exactly one item: "Not part of this series". No open-transaction, no recategorize, no "same charge as…", no split view, while the ledger's row menu and TransactionSheet offer all of that. |
| Linked-transaction list as a whole | `src/components/recurring/SeriesMembership.tsx:57-78` | Full charge history | **missing-state** — unbounded and unpaginated (`recurring-detail.ts:164-178` selects every active linked row with no limit). A 5-year weekly series renders ~260 rows into the RSC payload and the DOM. No sort control, no date filter, no total. |
| Keyboard shortcuts on this surface | `src/components/recurring/SeriesDetail.tsx:52-71` | — | **missing-state** — none registered. Sibling surfaces push KeyScope bindings (ReviewInbox `r`, TransactionsLedger `x`/`escape`); this page — where the owner will chew through dozens of series — has no confirm/dismiss/next-series keys at all. |
| Status Badge (Detected / Confirmed / Dismissed / Ended) | `src/components/recurring/SeriesDetail.tsx:120` | State the series' lifecycle position | **undiscoverable** — no tooltip, no legend, no consequence stated. Nothing says dismissed/ended means "excluded from the forecast, calendar and upcoming list" (`forecast.ts:130`, `recurring-calendar.ts:96`, `recurring.ts:722`). |
| "Inactive" Badge | `src/components/recurring/SeriesDetail.tsx:122-124` | Warn that the series has gone quiet | **undiscoverable** — computed by `isSeriesActive` (`recurring.ts:669-679`). The page shows the verdict but never the input — `lastMatchedOn` is fetched (`recurring-detail.ts:252`) and never rendered. |
| Stat: "Confidence" (rounded %) | `src/components/recurring/SeriesDetail.tsx:211` | State how sure detection is | **undiscoverable** — the doctrine is "statistics, not a black box" (`recurring.ts:24-26`) yet this is exactly a black box: `0.5×gap-consistency + 0.5×amount-score` (`recurring.ts:172-175`) with neither input shown. `intervalDaysAvg`, `toleranceDays` and `amountCentsAvg` are all fetched (`recurring-detail.ts:247-251`) and never rendered. |
| Breadcrumb "Recurring" link | `src/components/recurring/SeriesDetail.tsx:97` | Return to the recurring index | **confusing** — hardcoded `/recurring` = the Upcoming tab, while the main entry points are the All tab (`AllSeriesView.tsx:142`) and the Calendar day sheet (`RecurringCalendar.tsx:125`). `RecurringTabs` hrefs are `/recurring?tab=…` (`RecurringTabs.tsx:23`) so the tab is a real, preservable URL param that is thrown away. |
| Category chip link → `/categories/[id]` | `src/components/recurring/SeriesDetail.tsx:133-137` | Jump to the category page | **confusing** — the chip is the MODAL category of the linked rows (`recurring-detail.ts:108-130`), a derived plurality, not a property of the series. Nothing says so, and the minority is hidden. |
| Stat: "Annualized" | `src/components/recurring/SeriesDetail.tsx:195-197` | Show the yearly cost of this series | **confusing** — rendered with `<Money>` WITHOUT `flow`, so it is unsigned and uncolored: an income series' $27k/yr and a bill's $27k/yr look identical. It is `|amount| × occurrences/year` by CADENCE (`recurring.ts:534-537`), not by the measured `intervalDaysAvg`, and nothing on screen says either. |
| Stat: "Cadence" | `src/components/recurring/SeriesDetail.tsx:210` | Restate the cadence | **confusing** — pure duplication: the cadence is already the first editable token of the sentence above, and this copy is not clickable. |
| Merge search input + candidate list | `src/components/recurring/SeriesMembership.tsx:330-357` | Pick the series to fold in | **confusing** — candidates are EVERY live series in the DB sorted by name (`recurring-detail.ts:217-228`), each row showing only `name` and `KIND_LABEL[kind]` (`:351-352`). No amount, no cadence, no account, no last-charge date. The whole list also ships in the RSC payload on every render whether or not the popover is opened. |
| Attach search input (200ms debounce) | `src/components/recurring/SeriesMembership.tsx:183-190` | Find unlinked rows to attach | **confusing** — results hard-capped at 25 (`recurring-detail.ts:273`) with NO truncation indication and no paging. Future-dated rows are excluded (`recurring-detail.ts:296`) even though `createSeriesFromTransaction` explicitly supports a future seed (`recurring-links.ts:328-342`). |
| Account name in the cadence sentence | `src/components/recurring/CadenceSentence.tsx:87` | Say which account the charge hits | **dead-end** — plain `<span>`. The merchant and category beside it are links; `seriesDetail` does not even return `accountId` (`recurring-detail.ts:150-153` selects only the name), so the link cannot be built without a service change. |
| Table-lens DataTable rows (Date / Amount / vs expected) | `src/components/recurring/AmountHistoryChart.tsx:91-103` | The tooltip's facts, all at once | **dead-end** — `DataTable` supports sortable headers, `rowHref` and `onRowClick` (`DataTable.tsx:26-41`) and this call site uses none of them; the row showing a $40 price jump gives you no way to open that transaction. |
| Table-lens "vs expected" signed delta | `src/components/recurring/AmountHistoryChart.tsx:49` | Show how far off the charge was | **confusing** — `\|amount\| − \|expected\|` rendered with `formatCentsSigned`: on a bill, being charged $10 MORE renders "+$10.00", a leading + that means money-in everywhere else (`Money.tsx:12`). |
| Linked-transaction row (date, description, account, amount) | `src/components/recurring/SeriesMembership.tsx:60-65` | Show the series' actual charges | **dead-end** — not a link, not clickable, no sheet, and no ledger URL filters by series. `linkSource` is selected and typed as "who owns this link" (`recurring-detail.ts:37-38`) and never displayed, and the row shows no paid/paid_different state even though the calendar computes exactly that per charge (`recurring-calendar.ts:66-78`). Cosmetic: `truncate` on an inline `<span>` (`:63`) is a no-op. |
| "← All recurring" footer link | `src/components/recurring/SeriesDetail.tsx:266-268` | Get back after a long scroll | **confusing** — labelled "All recurring" but points at `/recurring`, which renders the Upcoming tab (`page.tsx:20`). |
| Merchant chip link → `/merchants/[id]` | `src/components/recurring/SeriesDetail.tsx:126-131` | Jump to the merchant's learning record | sensible |
| Menu item "Confirm" | `src/components/recurring/SeriesDetail.tsx:155-157` | Confirm from any non-confirmed state | sensible — correctly hidden for a merged-away series (`setSeriesStatus` throws for that case, `recurring.ts:493`). |
| ⋯ "Series actions" menu trigger (arrow keys cycle, Home/End, Tab exits, Esc light-dismisses) | `src/components/recurring/SeriesDetail.tsx:151-165` | House the lifecycle verbs | sensible |
| Merged-into link → `/recurring/[target]` | `src/components/recurring/SeriesDetail.tsx:169-177` | Follow a merged-away series to where its charges live | sensible |
| Cadence token → popover radio menu of 6 cadences + "Use detected (x)" | `src/components/recurring/CadenceSentence.tsx:123-167` | Override the detected cadence, or hand it back | sensible — dotted underline + accent color marks an active override, arrow-key nav follows APG, reset is offered only when overridden. |
| Date token → popover with `<input type=date>` + Save + "Use detected" | `src/components/recurring/CadenceSentence.tsx:172-244` | Override the next expected date | sensible — draft re-syncs on open (`:188-190`) and a calendar-invalid date is rejected at both the zod boundary and the service (`actions.ts:96-99`, `recurring-detail.ts:355`). *Reset item does not name the detected date — see Change #6 on `/recurring`.* |
| Chart⇄Table lens ViewSwitcher | `src/components/recurring/SeriesDetail.tsx:221-227` | Show the amount history as numbers | sensible — URL-shareable (`?lens=table`) and persisted per surface (`hooks/useViewState.ts:40-57`). Note it disappears entirely when `amountHistory<2` (`:215`), so a persisted 'table' preference becomes invisible on sparse series. |
| "Linked transactions · N" heading | `src/components/recurring/SeriesDetail.tsx:253` | Count the series' charges | sensible — the e2e spec keys its assertions off this exact string (`zz-recurring-detail.spec.ts:23-26,48,56`); it is load-bearing. |
| "Find transactions to attach" button | `src/components/recurring/SeriesMembership.tsx:166-177` | Open the attach search | sensible — focus is returned to the trigger on close, guarded against the initial mount (`:101-106`). |
| "Attach N" button | `src/components/recurring/SeriesMembership.tsx:229-236` | Commit the attach | sensible — correctly disabled at zero selection. |
| Attach panel close ✕ | `src/components/recurring/SeriesMembership.tsx:191-198` | Close the search, clear state | sensible |

**Good**

1. The editable cadence sentence is the best idea on the page and one of the best in the app: the
   schedule stated in English with each fact a dotted-underline token that opens an editor, an
   accent-colored token marking an active override, and a "Use detected (monthly)" escape in every
   editor (`CadenceSentence.tsx:60-88, 153-165`).
2. Override columns are a correct architecture: detection keeps writing its own columns while
   `user_cadence` / `user_next_expected_on` / `user_amount_cents` shadow them
   (`schema/recurring.ts:42-46`), read user-first by `effectiveSeries` (`recurring.ts:642-651`) and
   honored by the forecast (`forecast.ts:136-137`). A user edit never fights the next detection run.
3. The merged-away lifecycle is thought through end-to-end: `setSeriesStatus` refuses to re-confirm a
   merged series with a stated reason (`recurring.ts:493-495`), the page hides that menu item
   (`SeriesDetail.tsx:155`), hides every reshaping control via `isLive` (`:256`), and shows a banner
   linking to where the charges went (`:169-177`). Detection forward-maps the dead identity to the
   live target instead of resurrecting it (`recurring.ts:412-422`).
4. Cadence-aware schedule wording: weekly/biweekly render as "on Fridays" and monthly-family as
   "around the 15th" (`labels.ts:76-85`).
5. The date override is validated twice — at the zod action boundary and again inside the service —
   with the reason written down ("a calendar-invalid date would poison every future projection",
   `actions.ts:96-99`, `recurring-detail.ts:353-357`).
6. The projection window is sized off the series' own step so an annual series still yields three
   occurrences instead of zero (`recurring-detail.ts:207-215`).
7. Attach search escapes LIKE wildcards with an explicit ESCAPE clause
   (`recurring-detail.ts:301-306`), matching the ledger's own query hygiene.
8. The lens is a real view dimension, not local state: URL-shareable, persisted, resolved server-side
   URL > persisted > default (`page.tsx:41-46`, `recurring-view-spec.ts`).
9. `AttachPanel` returns focus to its trigger on close, guarded so the initial closed mount doesn't
   steal focus (`SeriesMembership.tsx:99-106`).
10. The e2e spec drives the actual round-trip (detach → count drops → find → attach → count restored,
    `zz-recurring-detail.spec.ts:40-57`) and runs axe on the settled surface.

**Bad** (ranked)

1. **CRITICAL — Renaming a merchant-less series silently forks it on the next "Detect now".**
   Detection identifies a merchant-less group by `(merchantId IS NULL, accountId, name ===
   normalizedDescription)` (`recurring.ts:402, 408-410`). The rename control
   (`src/components/recurring/SeriesDetail.tsx:106-116`) writes an arbitrary name
   (`src/services/recurring-detail.ts:365-376`) and its docstring asserts it "does not affect
   grouping". Rename a cash-deposit series "ATM CASH DEPOSIT" on Chase Checking (confirmed, 30 linked
   charges) to "Paycheck (cash job)": on the next import or Detect now the group matches no existing
   series, a NEW series named "ATM CASH DEPOSIT" is created with `status='detected'`, and `tagGroup`
   (`recurring.ts:389-394`) re-tags all 30 detection-owned rows onto it. The renamed series is left
   with zero linked rows but keeps its stale stats (`recomputeSeriesStats` bails when `analyzeGroup`
   returns null, `recurring.ts:296-297`) — so "Paycheck" shows $1,046/charge and three future
   occurrences with no charges behind it, plus a duplicate suggestion card for the same money. Any
   hand-attached rows stay on the orphan (user-owned, skipped at `recurring.ts:377`), so the history
   is split in two.
2. **HIGH — A dead series (dismissed / ended / merged-away) still advertises "Next expected" money and
   an annualized cost.** `seriesDetail` calls `projectOccurrences` unconditionally
   (`src/services/recurring-detail.ts:211-215`) and `SeriesDetail` renders the card whenever the array
   is non-empty (`src/components/recurring/SeriesDetail.tsx:237-249`, plus Annualized at `:195-197`),
   with no status gate — while `forecast.ts:130`, `recurring-calendar.ts:96` and `recurring.ts:722`
   all filter to detected|confirmed. Merge "NETFLIX.COM" into "Netflix" and the source page shows the
   merged-away banner AND three future $22.99 charges AND "Annualized ~$275.88/yr" — the exact phantom
   money `setSeriesStatus`'s own comment says must never be resurrected (`recurring.ts:490-495`).
3. **HIGH — Attach/detach Undo is lossy and permanently ejects rows from detection, while the lossless
   patch sits unused in the response.** `attachToSeriesAction` and `detachFromSeriesAction` both
   return a server-captured lossless `UndoPatch` (`actions.ts:128, 143`) built from each row's prior
   `recurringSeriesId` AND `seriesLinkSource` (`recurring-links.ts:63-66, 113-115`). Both client
   handlers discard it and hand-roll an inverse from the forward action instead
   (`src/components/recurring/SeriesMembership.tsx:40-49, 153-162`), and both forward actions stamp
   `series_link_source='user'` (`recurring-links.ts:75, 117`). Detach one Spotify charge by mistake
   and immediately Undo: the row is back, but its ownership has flipped detected→user and detection
   now skips it forever (`recurring.ts:377`). The correct primitive exists one directory away
   (`components/transactions/undo-toast.ts:12-27`).
4. **HIGH — Merge is irreversible with no unmerge anywhere, chosen from an unfiltered alphabetical
   list showing only a name.** `mergeSeries` (`src/services/recurring-links.ts:136-190`) relinks every
   active row of the source to the target as user-owned, sets the source ended with `mergedIntoId`, and
   recomputes the target's stats over the union. `mergedIntoId` is written in exactly one place and
   read in seven — no inverse function, no action, no UI. The candidate list
   (`src/components/recurring/SeriesMembership.tsx:243-363`) renders only `name` and
   `KIND_LABEL[kind]` (`:351-352`). Two "Transfer to Savings" series (SoFi and Chase): pick the wrong
   one, read a confirm sentence naming neither the account nor the charge count, and 40 Chase
   transfers are now user-owned rows on the SoFi series with no path back short of hand-written SQL.
5. **HIGH — A series with zero linked charges still displays full statistics and a forecast.**
   `recomputeSeriesStats` deliberately leaves the last good stats in place when the current set is too
   small to analyze (`recurring.ts:296-297`). The detail page has no zero-row branch:
   `LinkedTransactions` renders "No linked transactions yet."
   (`src/components/recurring/SeriesMembership.tsx:53-55`) while the stat block above
   (`src/components/recurring/SeriesDetail.tsx:194-249`) still shows Annualized, Per charge ±σ and
   Confidence, and Next expected still lists three dated amounts.
6. **MEDIUM — The two most consequential buttons on the page have no confirmation and no undo; the
   least consequential one has both.** "End series" and "Not recurring" fire `setSeriesStatusAction`
   on a single menu click (`src/components/recurring/SeriesDetail.tsx:84-93, 151-165`) and immediately
   remove the series from the month forecast, the calendar and the 30-day upcoming list; their toasts
   carry no action (`:91`). Detaching one transaction gets an Undo toast; merging gets a two-step
   confirm. Open the ⋯ menu intending Confirm, arrow one item too far, press Enter — $1,900 of rent
   silently drops out of the projection with a neutral "Dismissed" toast.
7. **MEDIUM — "Per charge" pairs a user-overridden amount with a standard deviation measured around
   the detected mean.** `src/components/recurring/SeriesDetail.tsx:198-209`: the value is
   `effectiveSeries().nextExpectedAmountCents` (`recurring.ts:649`) and the ± is `amountCentsStddev`
   around `amountCentsAvg` (`recurring.ts:163-168, 181-183`). Rent detected at $1,046 ± $12,
   overridden to $1,150, renders "$1,150.00 ±12.00". Nothing distinguishes an overridden value from a
   detected one in the stat block at all — the sentence marks overrides in accent color; the stats do
   not.
8. **MEDIUM — Two different definitions of "the charge matched the expectation" inside one feature.**
   `src/components/recurring/AmountHistoryChart.tsx:36-53` says "on plan" only on exact cent equality;
   `recurring-calendar.ts:56-78` (an exported pure function) classifies the SAME charge against the
   same series using max($1, 2%, 2σ). An electricity bill averaging $142 ± $9 is a green ✓ every month
   on the calendar and shows a signed variance on every single row here.
9. **MEDIUM — Attach search silently truncates at 25 and mislabels its own empty state.**
   `searchAttachCandidates` hard-limits to `ATTACH_LIMIT=25`
   (`src/services/recurring-detail.ts:270-334`, `:273, :332`) with no total returned and no truncation
   notice. With no query it bands ±max(15%, $5) around the expected amount (`:309-317`) — but only
   when the series HAS an expected amount; when it is null the query degenerates to "the 25 most
   recent unlinked active rows in the entire ledger", still rendered under "No similar unlinked
   transactions." when empty (`src/components/recurring/SeriesMembership.tsx:201-224`, `:206`).
10. **MEDIUM — Any failure inside `seriesDetail` renders a 404 "not found".**
    `src/app/recurring/[id]/page.tsx:33-39` wraps the whole read in
    `try { seriesDetail(...) } catch { notFound() }`. Only a genuinely unknown id throws "Unknown
    recurring series" (`recurring-detail.ts:140`); a `DateParseError` from a poisoned date reaching
    `projectOccurrences`, a SQLITE_BUSY while the dev server holds the DB, or a drizzle failure all
    become the same page telling the owner his series does not exist.
11. **MEDIUM — The amount editor closes and discards the draft when parsing fails.** `commit()`
    catches the `MoneyParseError`, toasts, then calls `close()` outside the try/catch
    (`src/components/recurring/CadenceSentence.tsx:263-271`). Type "1 150", press Enter, get a red
    toast, and the popover is gone with what you typed. Every other inline editor
    (`InlineEditableText.tsx:74-78`) keeps the input open and renders the error inline with
    `role="alert"`.
12. **MEDIUM — No pending state on any mutation.** `SeriesDetail` discards `useTransition`'s
    `isPending` (`const [, startTransition]`, `src/components/recurring/SeriesDetail.tsx:63-76`) and
    `useViewState`'s `isPending` (`:65`), and every handler is a bare `void action().then(...)`. On a
    900ms round-trip the owner taps Confirm twice; the same pattern on "Merge in"
    (`SeriesMembership.tsx:317-323`) produces a red "Series has already been merged" on the second tap.
13. **MEDIUM — The attach search panel expands inside the card-header toolbar row.** `AttachPanel`'s
    open state returns a full search card (`src/components/recurring/SeriesMembership.tsx:179-239`)
    rendered as a flex item inside `<div className="flex flex-wrap items-center gap-2">`, itself the
    right-hand side of a `justify-between` header row shared with the h2 and the Merge button
    (`src/components/recurring/SeriesDetail.tsx:252-262`). It has no width class, so the input, the
    64-max-height result list and the Attach button are sized by whatever the flex row leaves over.
14. **LOW — Both "back" affordances land on the wrong tab.**
    `src/components/recurring/SeriesDetail.tsx:97, 266-268` both point at `/recurring`, which
    `page.tsx:20` resolves to `tab='upcoming'`, while the dominant inbound path is the All tab.
15. **LOW — The cadence sentence is ungrammatical for annual series.** The sentence composes
    `CADENCE_LABEL[cadence].toLowerCase()` (`src/components/recurring/CadenceSentence.tsx:124`) and
    `CADENCE_LABEL.annual` is "Annual" (`src/components/recurring/labels.ts:4-11`), producing "charges
    annual around the 12th". Semimonthly is worse: `schedulePhrase` only branches on
    weekday-vs-day-of-month (`labels.ts:76-85`), so a two-days-a-month series is described with a
    single ordinal.
16. **LOW — `linkSource` is fetched, typed and documented — and never rendered.**
    `SeriesLinkedTxn.linkSource` (`recurring-detail.ts:37-38, 171, 200`) is passed into
    `LinkedTransactions` and never displayed (`src/components/recurring/SeriesMembership.tsx:59-76`).
    It is the most consequential invisible fact on the page: a 'user'-owned row is permanently outside
    detection's grouping pool (`recurring.ts:377`).
17. **LOW — Unbounded payload.** `src/services/recurring-detail.ts:164-228`: all active linked rows
    with no limit (`:164-178`), a chart point per row (`:202-204`), and every live series as merge
    candidates whether or not the popover opens (`:217-228`) — plus the whole categories table loaded
    to resolve one modal category (`:180-192`).
18. **LOW — `truncate` on an inline span does nothing.**
    `src/components/recurring/SeriesMembership.tsx:60-65` applies `truncate` to an inline `<span>`
    inside a flex item; overflow does not apply to non-replaced inline boxes, so a long bank descriptor
    wraps to three lines. The attach-candidate list two blocks down gets this right
    (`min-w-0 flex-1 truncate`, `:219`).

**Change** (ranked)

1. **Gate the projection, the annualized cost and the stat block on the series being live.** (S) Wrap
   the Next-expected card and the Annualized stat in `isLive && !isMergedAway`, and for a non-live
   series state the consequence ("Ended — not counted in the forecast, calendar or upcoming list").
   Cheapest correct fix is a `projectionCounts: boolean` on `SeriesDetail` computed beside `isActive`
   (`recurring-detail.ts:253`) so the page never re-derives the status rule `forecast.ts:130` /
   `recurring-calendar.ts:96` / `recurring.ts:722` already share. Add a unit test asserting
   `seriesDetail` on an ended series reports `projectionCounts=false`.
2. **Route detach/attach undo through the existing lossless patch.** (S) Replace the hand-rolled
   inverses at `SeriesMembership.tsx:40-49` and `153-162` with
   `offerUndoToast(title, r.data.undo, onChanged)` from `components/transactions/undo-toast.ts:12`,
   exactly as the transaction sheet's SeriesLinkPanel does. Delete the false "lossless" comment at
   `:39` or make it true.
3. **Give End series / Not recurring the same ceremony as merge, plus undo.** (S) Add the two-step
   confirm the merge popover uses (`SeriesMembership.tsx:303-325`), state the consequence and the
   number affected ("3 projected charges totalling $296.97 will stop being forecast"), and put an Undo
   on the toast calling `setSeriesStatusAction` back to the prior status (already in `data.status` on
   the client).
4. **Preserve the tab on both back links, and add a pending state to every mutation.** (S) Accept
   `?from=all|calendar|upcoming` and build the breadcrumb/footer hrefs from it
   (`SeriesDetail.tsx:97, 266`). Stop discarding `isPending` at `SeriesDetail.tsx:64`, and add a
   `busy` guard to `MergeControl.merge` and `AttachPanel.attach` the way `LinkPanels.tsx:43,63` does.
5. **Keep the amount editor open on a parse error.** (S) Move `close()` inside the success path at
   `CadenceSentence.tsx:263-271` and render the error inline with `role="alert"`, matching
   `InlineEditableText.tsx:74-78`. Allow the sign to be changed (accept a leading − / parentheses
   instead of forcing sign from the current value at `:257`).
6. **Reconcile the table lens's "on plan" with the calendar's noise band.** (S) Replace the exact-cent
   comparison at `AmountHistoryChart.tsx:45` with
   `classifyPostedAmount(amount, expected, stddev)` (`recurring-calendar.ts:66-78`) so one definition
   serves the calendar, the day sheet and this table, and render the variance with an explicit
   direction word for expense series ("$10.00 more than expected").
7. **Fix the cadence sentence's adverbs and the semimonthly case.** (S) Add an adverb map beside
   `CADENCE_LABEL` (`labels.ts:4-11`) for sentence use, and for semimonthly derive both cluster days
   from the linked history (`isDayOfMonthBimodal` already finds them, `recurring.ts:77-91`).
   Distinguish an overridden token in the stat block, not just in the sentence.
8. **Replace the redundant Cadence stat tile.** (S) Swap `SeriesDetail.tsx:210` for "Charges to date"
   (count + total spent) or "Since" (first linked charge date) — both derivable from `linkedTxns` with
   no new query.
9. **Make renaming safe for merchant-less series.** (M) Add a `displayName` column and leave `name` as
   the immutable identity key, with effective-name resolution `displayName ?? name` in
   `listSeries`/`seriesDetail`/calendar/forecast labels. Until that lands, make `renameSeries`
   (`recurring-detail.ts:365-376`) reject or warn when `merchantId IS NULL` and surface a banner:
   "Renaming this series will split it on the next detection run — it has no merchant to group by."
   Fix the false docstring at `:365` either way.
10. **Show the evidence behind Confidence, Inactive and Per charge.** (M) The service already returns
    `intervalDaysAvg`, `toleranceDays`, `amountCentsAvg`, `amountCentsStddev`, `lastMatchedOn` and
    `detectedNextExpectedOn` (`recurring-detail.ts:247-252`) and the page renders none of the first
    five. Add a collapsible "How this was detected" block: median/average gap ±tolerance, amount mean
    ±σ, occurrence count, last matched date, and the confidence formula's two halves
    (`recurring.ts:172-175`). When the amount IS overridden, show the detected value beside it instead
    of a σ measured around a different mean.
11. **Paginate/window the linked list and the amount-history chart.** (M) Add `ChartRangePills`
    (`components/charts/ChartRangePills`) to the amount-history card and window both the bars and the
    table through the same slice; add a limit + "show all" to the linked list and a limit/offset to
    `recurring-detail.ts:164-178`.
12. **Fix the attach panel: placement, truncation notice, future rows, empty-query story.** (M)
    Render the open panel in the card body below the heading; return a total count from
    `searchAttachCandidates` and show "25 of 41 — refine your search"; drop the `lte(postedOn, today)`
    restriction (`recurring-detail.ts:296`); state the amount band in the panel and give the
    null-amount case its own copy.
13. **Make merge choosable and reversible.** (M) Show amount, cadence, account and last-charge date on
    each candidate (all available from `listSeries`), rank by similarity rather than alphabetically,
    state the charge count in the confirm sentence, and add either an `unmergeSeries` service or an
    `UndoPatch` of the relinked rows captured in `MergeResult` with Undo on the merge toast.
14. **Make the linked-transaction rows first-class.** (L) Link the description to the transaction
    (needs a `?txn=` deep link on `/transactions`, which does not exist — `TransactionsLedger` owns
    the sheet in local state — or an inline expander reusing `LedgerRowExpander`), show the category
    chip, show the paid / paid-different / missed badge via the exported `classifyPostedAmount`
    (`recurring-calendar.ts:66-78`), and show the link owner. Add a `series` filter in
    `services/transactions-query.ts:48` plus "See all N in the ledger".

**Add** (ranked)

1. **Make the Upcoming tab's rows link here.** (S) `UpcomingList.tsx:24-36` renders series names as
   plain text on the DEFAULT tab of `/recurring` while the All tab and the calendar day sheet both
   link (`AllSeriesView.tsx:58,142`; `RecurringCalendar.tsx:125`). One-line fix removing a dead end on
   the most-visited path into this page.
2. **Focus/expand for the amount-history chart.** (S) Wrap the card in `components/charts/ChartFocus`
   the way the Balance, Portfolio and Holding charts were wrapped in pass 22. The comment at
   `SeriesDetail.tsx:217-218` explicitly notes this card has no focus button.
3. **Notes / cancellation memory on the series.** (S) `recurring_series` has no notes column while
   transactions do. Add one and surface it: "cancel before the annual renewal on Mar 3", "this is
   Carson's card, he reimburses me".
4. **Export the trade/charge history.** (S) *(covered by the series-scoped ledger filter below; keep
   a CSV of `amountHistory` on the card as the cheap version.)*
5. **Series-scoped ledger filter and totals.** (M) Add `series` to `TxnFilters`/`filterConditions`
   (`services/transactions-query.ts:48`) so `/transactions?series=<id>` works, then put "See all 41
   charges · $2,438.59 total" on the linked-transactions card, plus lifetime-total and
   charges-per-year lines in the stat block.
6. **Price-change history as a narrative, not just bars.** (M) Derive change points from
   `amountHistory` (already on the page) and state them: "$9.99 → $12.99 on Mar 14, 2025 (+30%) ·
   $12.99 → $15.49 on Feb 2, 2026 (+19%) · you have paid $187.44 more than the original price since",
   with cumulative-paid-to-date beside Annualized.
7. **"Why this is recurring" panel — the detection audit trail.** (M) Every gap in days between
   consecutive charges with a ✓/✗ against `toleranceDays`, the amount mean/σ/CV against the 0.2
   stability threshold, and the confidence arithmetic. All inputs are on the client already
   (`amountHistory` gives the dates; `recurring-detail.ts:247-251` gives the stats) and the constants
   are exported (`MIN_OCCURRENCES`, `AMOUNT_STABILITY_CV_MAX`, `recurring.ts:33-36`).
8. **Kind and account correction.** (M) There is no control anywhere in the app to fix a
   mis-classified `kind` or a wrong `accountId`, yet kind decides whether the series is excluded from
   the forecast entirely (`forecast.ts:135`). Add `user_kind` as a fourth override column read by
   `effectiveSeries`, exposed as another token in the cadence sentence (the verb is already derived
   from kind, `labels.ts:88-90`).
9. **Keyboard flow and next/previous series navigation.** (M) Register a KeyScope
   (`lib/keyscope.ts`, `PRIORITIES.list`) with confirm/dismiss/edit-amount/attach keys — noting a
   plain `a` is currently swallowed app-wide by `ToastMnemonic` — plus ‹ / › to move through the All
   ordering (`recurring.ts:586-591`) without a round trip.
10. **Health strip: what this series costs relative to everything.** (M) Share of monthly fixed spend,
    rank among the owner's series by annualized cost, and this year vs last — all derivable from
    `listSeries` plus `recurring.ts:534-537`.
11. **Similar/duplicate-series detector on the page.** (M) `MergeControl` already fetches every live
    series (`recurring-detail.ts:217-228`); rank by name/merchant/amount/cadence similarity and
    surface a strong candidate proactively ("'NETFLIX.COM' looks like the same charge — merge?")
    instead of hiding it behind a button and an alphabetical list.
12. **Occurrence timeline: expected vs actual, with misses.** (L) The single biggest hole. The page
    shows past amounts (bars) and future dates (a list) as two unrelated blocks and never shows
    whether a past expectation was met. The calendar already computes the whole grammar per day —
    paid / paid_different / upcoming / missed — with a tuned noise band and a missed count
    (`recurring-calendar.ts:24-78, 120+`). Build a per-series timeline: one row per expected
    occurrence back through history, each matched to its posted charge or marked missed, with the
    variance and a link. `projectOccurrences` silently skips overdue occurrences
    (`recurring.ts:696`), so rent expected on the 1st that never arrived by the 10th shows only "next
    expected Aug 1" and the miss is structurally unsayable.
13. **Per-occurrence actions on the Next-expected list: skip, mark paid, snooze, one-off amount.** (L)
    The three projected rows (`SeriesDetail.tsx:241-247`) are inert text; a one-off skip ("I cancelled
    the gym for August") today requires either corrupting the cadence by hand-moving
    `next_expected_on` or ending the whole series. Add a `series_occurrence_overrides` exception table
    (seriesId, date, action skip|amount) read by `projectOccurrences` so the forecast and calendar
    honor it too.





---

<div id="sec-07c"></div>

> **▼ SECTION 07c — Page by page, part 3 of 3**

# Page-by-page dossier — part 3 of 3

Surfaces: `/categories/[id]`, `/merchants/[id]`, `/imports`, `/settings`.

Verdict legend: **broken** (does the wrong thing) · **dead-end** (shows a thing you cannot act on) ·
**missing-state** (a state the UI never handles) · **undiscoverable** (works, cannot be found or hit) ·
**confusing** (works, misreads) · **sensible** (keep).

---

## /categories/[id] — category detail

`src/app/categories/[id]/page.tsx` + `src/components/categories/**`, plus 6 borrowed components from `src/components/spending/**`.

**Purpose** — This is the "why is this number what it is?" page for a single spending or income bucket. The owner sees "Food $5,113" on /spending or "Housing 107% of budget" on /budgets, clicks it, and lands here to answer: how has this moved over the last year, which subcategory/merchant/recurring bill drives it, and which exact transactions make it up — with the ability to fix a miscategorized row on the spot (`src/components/spending/CategoryTxnPanel.tsx:21` → InlineCategorizeList → runCategoryCorrection). It is also the only surface in the app where a category's own identity can be edited: rename (`CategoryNameHeading.tsx:26`) and re-parent (`CategoryMoveMenu.tsx:64`). Given the owner just spent pass 24 hand-categorizing ~1,300 rows, this page is where he audits whether that work produced a sane taxonomy — and right now it is the weakest link in that loop.

**Connections**

- **READS**: `categoryDetailHeader` / `categoryMonthlyTrend` / `categorySubcategorySplit` / `seriesInCategory` / `categoryBudgetRef` (`src/services/category-detail.ts`), `categorySpending` (`src/services/analytics.ts:453` — the NET, both-signs path shared with budgets), `topMerchants` (`src/services/spending.ts:619` with `{categoryId}`), `moveDestinations` (`src/services/category-edit.ts:110`), `loadSpendingCategoryTxns` (`src/app/spending/actions.ts:56` → spendingTransactions, the identical predicate as the header number), `buildCategoryPickerOptions` over the full categories table (`page.tsx:89`).
- **WRITES**: `renameCategoryAction` / `moveCategoryAction` (`src/app/categories/actions.ts`) — both revalidate `/`, `/spending`, `/budgets`, `/transactions` and this page; and indirectly `transactions.categoryId` plus a newly created rule via `runCategoryCorrection` (`src/components/transactions/correct-category.ts:25-73`), which can create a rule and retro-apply it to N rows from an inline chip on this page.
- **INBOUND**: exactly four links exist app-wide — `SpendingCategoriesTable.tsx:105` and `:154`, `BudgetRow.tsx:77`, `SeriesDetail.tsx:134`. None carries the period, which is why both e2e specs that use this page manually re-append it (`e2e/zz-spending-categorize.spec.ts:21` and `e2e/visual.spec.ts:28` both do `${href}?period=2026`).
- **OUTBOUND**: /spending, the parent category, child categories, /transactions (trend bars, merchant rows, "View all"), /recurring/[id], /budgets.
- **NOT connected**: there is no /categories index (only `[id]/page.tsx` exists); the command palette routes every category to `/transactions?category=` instead of here (`src/services/command-index.ts:66`, with a stale comment saying "until /categories/[id] lands (Stage 3)" — it landed), and `src/services/command-index.test.ts:48` now pins that stale routing; ledger rows and the transaction sheet link to /merchants/[id] but never to a category page.

**Interactive inventory**

| element | file:line | intended | verdict |
|---|---|---|---|
| Category name — inline edit trigger | `src/components/categories/CategoryNameHeading.tsx:26` | click / Enter / Space to rename in place | **broken** — `editable` is gated only on `kind !== transfer\|system` (`page.tsx:116`), but `renameCategory` ALSO rejects IMPORT_HINT_ROOTS {Income, Cash & ATM, Fees, Investments} and 7 IMPORT_HINT_PATHS (`category-edit.ts:25-34, 156`). Renaming "Income" shows a pencil, accepts typing, then rolls back with a red toast. The move menu correctly hides itself for the same categories (`category-edit.ts:117`). |
| 12-month trend — bar hover | `src/components/spending/MonthlyTrendBars.tsx:29` | reveal the month's amount | **broken** — hover only swaps the fill. The amount and count exist ONLY in `aria-label` (line 23) — no `title`, no tooltip, no printed value. Sighted mouse and touch users can read no number off the app's only category chart. |
| 12-month trend — negative month rendering | `src/components/spending/MonthlyTrendBars.tsx:12-18` | draw the month's magnitude | **broken** — `max` starts at 0 and `heightPct = Math.max(2, negative) = 2`, so a net-credit month is indistinguishable from $0; if every month is non-positive, `max===0` and line 13 claims "No spending in the last 12 months." |
| Budget card — spent/of/remaining figures | `src/app/categories/[id]/page.tsx:158` | show budget health for this category | **broken** — `categoryBudgetRef` calls `budgetStatuses(db, today)` (`category-detail.ts:172`), so bounds are always TODAY's budget period regardless of the selected period. Probe confirms the card is period-invariant for all 6 seeded budgets. |
| Subcategories — amount | `src/app/categories/[id]/page.tsx:188` | show the child's flow | **broken** — `Math.abs(s.flowCents)`. A child that nets to an inflow renders as positive spend, and sorts last (`category-detail.ts:119` sorts on the signed value) so the biggest credit looks like the smallest expense. |
| Subcategories — missing residual row | `src/app/categories/[id]/page.tsx:183` | account for the parent total | **broken** — only direct CHILDREN are listed; rows filed on the parent itself are in the header total but in no row, so Σ list ≠ header with nothing on screen saying so. |
| Top merchants — merchant row link | `src/services/spending.ts:679` | see this merchant's transactions inside this category | **broken** — `ledgerHref({merchant,from,to})` — the category is DROPPED. Verified: the card emits `/transactions?merchant=<id>&from=…&to=…` with no category param, while the amount shown is subtree-scoped (`spending.ts:578-583`). |
| Top merchants — unlinked-group row link | `src/services/spending.ts:680` | see the unlinked group's transactions | **broken** — same scope loss, compounded: navigates by free-text `q=<humanized stripped key>` (LIKE match, `transactions-query.ts:113-121`), which is neither the grouping key nor category-bounded. |
| Transactions — correction toast "Apply to N" | `src/components/transactions/correct-category.ts:32` | offer to fix the whole merchant group | **broken** — when `rulePrompt.matchCount > 0` the server-captured `undo` patch is destructured and discarded (only used in the else branch at line 43), so a single mis-tag on a busy merchant has no one-click revert. |
| Unused SpendDelta import | `src/app/categories/[id]/page.tsx:32` | (nothing — dead) | **broken** — SpendDelta is imported and never rendered. It is exactly the month-over-month delta the /spending row shows for this category before you click in (`SpendingCategoriesTable.tsx:120`). |
| Headline flow amount ("Spent · July 2026  $5,113.18") | `src/app/categories/[id]/page.tsx:134` | the category's total for the selected period | **dead-end** — not a link. Every comparable number on /spending is (SpendingStatCards); the page's own biggest figure is inert. |
| Top merchants — coverage footnote | `src/components/spending/TopMerchantsCard.tsx:45` | state linkage honesty | **dead-end** — "N still grouped by name" is inert text with no link to those rows and no path to link them to a merchant. |
| Transactions — split-part row chip | `src/components/spending/InlineCategorizeList.tsx:52` | show that this row is one part of a split | **dead-end** — a non-interactive pill whose comment says the part is edited "in the transaction sheet" — with no link to that sheet, the parent transaction, or a filtered ledger. |
| Transactions — row body (date / description / account / amount) | `src/components/spending/InlineCategorizeList.tsx:47` | identify the transaction | **dead-end** — inert text. On /transactions the same row opens the transaction sheet (split, exclude, note, transfer link, merchant). Here the only verb is recategorize. |
| CategoryChip (hue + icon) | `src/app/categories/[id]/page.tsx:110` | show the category's visual identity | **missing-state** — `categories.color` and `categories.icon` drive the 12-hue design system everywhere, but no UI in the repo writes them (grep: only `db/seed.ts`). This page is the natural editor and offers nothing. |
| PeriodSelector — Next period | `src/components/spending/PeriodSelector.tsx:126` | page forward one period | **missing-state** — unbounded — page into 2031 and get $0.00 / 0 transactions with nothing saying you are past the end of the data; the chevron never disables. |
| PeriodSelector — "Apply range" submit | `src/components/spending/PeriodSelector.tsx:192` | navigate to the custom range | **missing-state** — the guard at line 87 silently does nothing on an invalid range — no message, no field error, the panel stays open. |
| 12-month trend — chart affordances | `src/components/spending/MonthlyTrendBars.tsx:11` | be the app's category chart | **missing-state** — no axes, no range pills, no scrub, no chart⇄table lens, no ChartFocus. `docs/future-ideas.md:88` names it: "MonthlyTrendBars \| /categories/[id] \| … \| everything (bare CSS bars + drill)". |
| Budget card — absent when no budget exists | `src/app/categories/[id]/page.tsx:149` | hide an irrelevant card | **missing-state** — no "Set a budget" CTA, though `createBudgetAction` exists (`src/app/budgets/actions.ts:30`) and this is exactly where the user decides they want one. |
| Budget card — on a subcategory page | `src/services/category-detail.ts:172` | show the governing budget | **missing-state** — matches `s.budget.categoryId === categoryId` EXACTLY, so "Food > Groceries" shows no budget even though the parent Food budget's spend includes these rows. |
| Subcategories — per-row metadata | `src/app/categories/[id]/page.tsx:184` | rank the children | **missing-state** — CategorySubRow carries `txnCount` (`category-detail.ts:113`) which is never rendered; no share bar, no MoM, no sparkline — all of which the /spending row you clicked DOES have (`SpendingCategoriesTable.tsx:113,116,120`). |
| Top merchants — card omitted for non-expense categories | `src/app/categories/[id]/page.tsx:87` | suppress a meaningless card | **missing-state** — income/transfer/investment pages just lose the card with no note and get nothing analogous (no "top payers", no source breakdown). |
| Recurring series — no forward view | `src/app/categories/[id]/page.tsx:204` | tell you what is coming | **missing-state** — rows carry `nextExpectedOn` but there is no "$X expected in this category over the next 30 days" roll-up and no link to /recurring filtered to this category. |
| Transactions — "View all {total} →" | `src/components/spending/InlineCategorizeList.tsx:70` | reach the full filtered ledger | **missing-state** — rendered only when `total > rows.length`, i.e. only above the `LIMIT = 100` cap (`spending/actions.ts:24`). For any category with ≤100 transactions in the period there is NO link from this page to its filtered ledger. |
| Transactions — load-failure fallback | `src/app/categories/[id]/page.tsx:217` | degrade on an action error | **missing-state** — "Could not load transactions." with no retry, no reason and no ledger fallback — while the totals above, computed from the same rows, still render. |
| Whole-page zero-activity state | `src/app/categories/[id]/page.tsx:143` | handle a category with no data in the period | **missing-state** — no EmptyState — you get $0.00 plus five independently-worded negations in five cards. /spending handles the same case with one EmptyState and a next-step hint (`spending/page.tsx:176-181`). |
| Page view/lens state | `src/app/categories/[id]/page.tsx:36` | let the user choose how to read the data | **missing-state** — no ViewSwitcher, no ViewSpec, no lens dimension, nothing persisted to `app_settings.viewPreferences` — unlike /spending, /investments, /accounts/[id], /recurring/[id] and the dashboard. |
| Keyboard shortcuts on this surface | `src/app/categories/[id]/page.tsx:45` | fast navigation | **missing-state** — no `useKeyScope` registration anywhere on this route (verified by grep) — no period paging, no jump-to-list, nothing. Five other surfaces register scopes. |
| "Move category" ⋯ menu trigger | `src/components/categories/CategoryMoveMenu.tsx:64` | re-parent this category | **undiscoverable** — renders the generic "more" glyph (`Menu.tsx:111`) so it reads as a verb menu but holds only destinations; and it returns null when destinations is empty (`CategoryMoveMenu.tsx:32`), so for a protected category the control silently vanishes with no explanation. |
| Reachability from the command palette | `src/services/command-index.ts:66` | find a category by name and open it | **undiscoverable** — every category item routes to `/transactions?category=<id>`, never here, behind a stale "until /categories/[id] lands (Stage 3)" comment — and `command-index.test.ts:48` now asserts that routing, so the test protects it. Merchants two lines above correctly get `/merchants/<id>`. |
| Reachability generally | `src/app/categories/actions.ts:1` | browse categories | **undiscoverable** — no /categories index route exists (the directory holds only `[id]/page.tsx` and `actions.ts`). Four inbound links app-wide; a ledger row or transaction sheet can reach /merchants/[id] but never a category page. |
| Breadcrumb "Spending" link | `src/app/categories/[id]/page.tsx:95` | return to the spending report you came from | **confusing** — hardcoded `href="/spending"` — drops the active period. Arrive from a Year view, click back, land on the current month. |
| Breadcrumb parent-category link | `src/app/categories/[id]/page.tsx:99` | go up one level | **confusing** — same period loss; also the only way up, since there is no /categories index. |
| Breadcrumb current-page label | `src/app/categories/[id]/page.tsx:105` | show where you are | **confusing** — hand-rolled `<nav><div>` with no `<ol>` and no `aria-current="page"`, while the shared `src/components/ui/Breadcrumbs.tsx` (used by /accounts/[id], /merchants/[id], /investments/[t]/[s], SeriesDetail) provides both. |
| Move-menu destination items | `src/components/categories/CategoryMoveMenu.tsx:59-62` | pick a new parent | **confusing** — bare category names with no "Move to …" prefix, no separator between "Top level" and the roots, no indication of the CURRENT parent (filtered out at `category-edit.ts:133`), and no confirmation — selecting re-parents immediately. |
| Raw category kind printed under the title | `src/app/categories/[id]/page.tsx:127` | say what type of category this is | **confusing** — prints `header.kind` verbatim — the lowercase DB enum "expense"/"income"/"transfer"/"investment"/"rewards"/"system". |
| Headline transaction count | `src/app/categories/[id]/page.tsx:135` | how many transactions make up the number | **confusing** — not a link, and counts DISTINCT PARENTS (`analytics.ts:463`) while the Transactions card's "View all N" counts split ALLOCATIONS (`spending/actions.ts:76`). Two different counts for the same set. |
| 12-month trend — bar link (one per month) | `src/components/spending/MonthlyTrendBars.tsx:21` | drill into that month | **confusing** — href is `ledgerHref({category,from,to})` (`category-detail.ts:77`), so a bar EJECTS you to /transactions rather than setting this page's period to that month — while the period control sits 40px above. |
| 12-month trend — window labelling | `src/app/categories/[id]/page.tsx:145` | give period context | **confusing** — heading is "12-month trend" with no end date; the window is always trailing-12-from-today while the header reports the SELECTED period, and no bar is highlighted to show the overlap. |
| Budget card — "Budgets →" link | `src/app/categories/[id]/page.tsx:173` | go manage this budget | **confusing** — href is the bare "/budgets" (`category-detail.ts:180`) — not deep-linked to this budget, and /budgets has no anchor or highlight for it. |
| Subcategories — row link | `src/app/categories/[id]/page.tsx:186` | drill into the child category | **confusing** — drops the period; and the service already computed a range-scoped href (`category-detail.ts:115`) which the page discards. |
| Recurring series — amount | `src/components/spending/CategorySeriesList.tsx:35` | show the series' typical amount | **confusing** — `Math.abs(amountCentsAvg)` with no direction and no scoping — the series' full average shows even when only part of that bill lands in this category (membership keys on the parent row's categoryId, `analytics.ts:100-107`). |
| Transactions — "Apply to N" action | `src/components/transactions/correct-category.ts:49` | create the rule and retro-apply it | **confusing** — a ledger-wide bulk mutation plus a permanent rule, fired from a small chip, with no preview of which rows will move and no warning that a rule is being created. |
| Transactions — empty state | `src/components/spending/InlineCategorizeList.tsx:26` | say there is nothing to show | **confusing** — "Nothing left to categorize here." is the /spending uncategorized-bucket sentence; on a quiet category it reads as "you finished the work" rather than "no transactions in this period". |
| Browser tab title | `src/app/categories/[id]/page.tsx:35` | identify the page | **confusing** — static `metadata = { title: "Category" }` — every category tab is titled "Category", which bites hardest here where two categories get compared side by side. |
| Category name — edit input (Enter/blur commit, Esc cancel, maxLength 60) | `src/components/ui/InlineEditableText.tsx:61-73` | commit or cancel the rename | **sensible** |
| Rename success toast + Undo | `src/hooks/useInlineEdit.ts:93-98` | one-click revert of a rename | **sensible** |
| Move Undo toast action | `src/components/categories/CategoryMoveMenu.tsx:46-53` | put the category back | **sensible** |
| Menu keyboard model (Arrow/Home/End cycle, Tab exits, Esc light-dismiss) | `src/components/ui/Menu.tsx:57-82` | APG menu behaviour | **sensible** |
| PeriodSelector — Day/Week/Month/Quarter/Year links | `src/components/spending/PeriodSelector.tsx:100-110` | change granularity, as URL state | **sensible** |
| PeriodSelector — Previous period | `src/components/spending/PeriodSelector.tsx:116` | page back one period | **sensible** |
| PeriodSelector — contextual reset ("This month") | `src/components/spending/PeriodSelector.tsx:137` | jump back to today's period | **sensible** |
| PeriodSelector — "Custom" disclosure button | `src/components/spending/PeriodSelector.tsx:147` | open the from/to panel | **sensible** |
| PeriodSelector — From / To date inputs | `src/components/spending/PeriodSelector.tsx:174,184` | type an arbitrary range | **sensible** |
| PeriodSelector — Escape / outside-click dismiss | `src/components/spending/PeriodSelector.tsx:66-83` | close the custom panel | **sensible** |
| Recurring series — row link | `src/components/spending/CategorySeriesList.tsx:20` | open the series detail | **sensible** |
| Transactions — per-row CategoryPicker chip | `src/components/spending/InlineCategorizeList.tsx:60` | recategorize without leaving the page | **sensible** |
| Transactions — picker search box + Arrow/Enter/Esc | `src/components/transactions/CategoryPicker.tsx:127` | find a category by typing | **sensible** |

**Good**

1. The header→list reconciliation is genuinely airtight: the headline number and the transaction list come from the SAME predicate — `categorySpending` (`analytics.ts:453`) and `loadSpendingCategoryTxns` both route through `spendingTransactions` (`analytics.ts:429`). This is the most valuable property on the page and must be protected from any future "optimized" aggregate.
2. The income sign handling is correct and honestly documented. `page.tsx:70-81` flips categorySpending's money-out convention for income kinds, relabels the header Received / Spent / Net, and the comment explains why transfer/investment/rewards/system keep the raw net rather than pretending. Verified by probe: without the flip the Income trend would be twelve negative bars.
3. `topMerchants` is correctly subtree-scoped for the category (`spending.ts:578-583` filters allocations to subtreeIds before summing) and split rows contribute only their in-subtree portion. The math is right — only the link is wrong.
4. `moveDestinations` (`category-edit.ts:110-142`) pre-computes only VALID destinations server-side (same kind, one-level depth, no sibling-name clash, no import-hint/transfer/system) so the menu can never offer a doomed choice, and `moveCategory` re-checks every one of them. This "never offer what the service would refuse" pattern is worth propagating.
5. Both write paths are value-returning ActionResults with real Undo (`categories/actions.ts:18,47`; `CategoryMoveMenu.tsx:44-55`; `useInlineEdit.ts:93-98`), matching the app-wide toast+undo contract instead of the fire-and-forget void actions /settings still uses.
6. The inline categorizer reuses the exact ledger machinery — CategoryPicker + `runCategoryCorrection` (`InlineCategorizeList.tsx:31`) — so correcting from here produces the identical rule prompt, blast-radius count and undo as correcting from the transaction sheet. Zero drift by construction.
7. Split-part rows are correctly refused inline editing (`InlineCategorizeList.tsx:52-58`) rather than silently recategorizing the parent — the splits doctrine is respected even though the UX dead-ends.
8. `seriesInCategory` (`category-detail.ts:141`) derives series membership from the ledger rather than inventing a category column on `recurring_series`, and the comment explains the parent-row-not-split-parts rule. This card is the one thing closing the loop back to /recurring.
9. The page is covered by axe in both themes and by full-page visual snapshots at every breakpoint (`e2e/a11y.spec.ts:51`, `e2e/visual.spec.ts:82`), dynamically resolved so a reseed does not break them.

**Bad** (ranked)

1. **[high] Top-merchant drill-down silently drops the category scope** — `src/services/spending.ts:679`. On `/categories/<Food>?period=2026` the card shows "Amazon $412.00, 9 transactions" computed only over the Food subtree (`spending.ts:578-583`). Its link is `/transactions?merchant=<amazonId>&from=2026-01-01&to=2026-12-31` with no category param (verified by running topMerchants against the DB and printing the hrefs). If Amazon also appears under Shopping and Household, the ledger opens showing $3,180 across 71 rows. The number and the list it opens are different sets, on a page whose entire premise is that they are the same. `transactions-query.ts:53` and `:80` already AND merchant with category, and `lib/ledger-href.ts:26` already accepts both, so the fix is one parameter.
2. **[high] The budget card reports a different period than the rest of the page** — `src/services/category-detail.ts:172`. `categoryBudgetRef` calls `budgetStatuses(db, refDate)` with refDate = today (`page.tsx:84`), and budgetStatuses derives bounds from refDate (`budgets.ts:160`) — never from the selected period. Go to `/categories/<Housing>?period=2025-03`: the header reads "Spent · March 2025 $1,890.00" and directly beneath it the budget card reads "$2,150.00 of $2,000.00 · $150.00 over" in red — July 2026's figures, labelled only "monthly budget for this category". Probe output confirms the card is period-invariant for all 6 seeded budgets.
3. **[high] The 12-month trend shows no readable number to anyone not using a screen reader** — `src/components/spending/MonthlyTrendBars.tsx:23`. Twelve bars whose amount and count live only in the `<Link>`'s aria-label. There is no title attribute, no tooltip and no printed value; hover only changes the fill (line 29). On the owner's phone — his stated primary viewing device — hover does not exist at all, so the app's only category-level chart is twelve coloured rectangles with two-digit month labels. Answering "how much did I spend on Food in March" requires clicking through to /transactions and summing by hand.
4. **[high] Rename is offered on categories the service will always reject** — `src/app/categories/[id]/page.tsx:116`. `editable = kind !== transfer && kind !== system`, but `renameCategory` additionally throws for IMPORT_HINT_ROOTS {Income, Cash & ATM, Fees, Investments} and 7 IMPORT_HINT_PATHS (`category-edit.ts:25-34, 156-158`). Open `/categories/<Income>`, click the title (pencil shows), type "Earnings", press Enter: optimistic update, then rollback plus a red toast. The move menu next to it correctly hides itself for exactly these categories (`category-edit.ts:117`), so two controls on the same header row disagree about what is editable. Four top-level categories are affected.
5. **[medium] Negative trend months are invisible, and an all-negative category claims it has no history** — `src/components/spending/MonthlyTrendBars.tsx:12`. `max = points.reduce((m,p) => Math.max(m, p.spentCents), 0)` and `heightPct = Math.max(2, (p.spentCents/max)*100)`. A month netting to an inflow (a $600 return in Shopping) draws a 2%-tall stub identical to a $0 month; if all 12 months net non-positive, `max === 0` and line 13 renders "No spending in the last 12 months." over real activity. Not reproducible on the e2e seed (probe: zero negative months after the page's sign flip at `page.tsx:81`) but directly reachable on the owner's real ledger, which carries Refunds & Reimbursements and gambling-payout rows.
6. **[medium] Subcategory amounts are rendered through Math.abs, destroying the sign** — `src/app/categories/[id]/page.tsx:188`. A child that nets to an inflow — Shopping > Returns at −$340 for the quarter — renders as "$340.00", visually identical to having spent $340 there, and sorts to the bottom because `category-detail.ts:119` sorts on the signed value. The `<Money flow>` variant that prints a sign and a semantic colour already exists (`Money.tsx:12`).
7. **[medium] The Subcategories list has no residual row, so it does not add up to the header** — `src/app/categories/[id]/page.tsx:183`. `categorySubcategorySplit` returns only direct children (`category-detail.ts:101`). Transactions filed directly on the parent are inside the header's subtree total but appear in no row: Food $5,113 with Groceries $2,900 + Restaurants $1,800 + Coffee $113 = $4,813 leaves $300 unaccounted for, with nothing on screen naming it. Zero residual on the current seed, but the owner's hand-categorized real DB is exactly where parent-level assignments accumulate.
8. **[medium] A single mis-tag on a busy merchant has no Undo** — `src/components/transactions/correct-category.ts:32`. `runCategoryCorrection` only calls `offerUndoToast` in the else branch (line 43). When `rulePrompt.matchCount > 0` the server-captured `undo` patch is destructured and thrown away and the toast offers "Apply to 24" instead. Recategorize one Whole Foods row on the Food page by mistake and the only visible action escalates the mistake to 24 rows plus a permanent rule; reverting the single row means finding it again in the ledger.
9. **[medium] No link to the filtered ledger unless the category has more than 100 transactions** — `src/components/spending/InlineCategorizeList.tsx:70`. "View all N →" renders only when `data.total > data.rows.length`, and the page is capped at `LIMIT = 100` (`spending/actions.ts:24`). For a category with 40 transactions in the period — the common case on a month view — the page offers no route at all to `/transactions?category=<id>&from&to`, so sorting, bulk-editing or opening a transaction sheet for these rows requires reconstructing the URL by hand.
10. **[medium] Every category-to-category link drops the selected period** — `src/app/categories/[id]/page.tsx:186`. The breadcrumb (`page.tsx:95`, `:99`) and every subcategory row hardcode a period-less href, as do all four inbound links (`SpendingCategoriesTable.tsx:105,154`; `BudgetRow.tsx:77`; `SeriesDetail.tsx:134`). Set the page to 2026 (Year), click "Groceries", land on the current month — the comparison you were making is gone. The service already computes a range-carrying href per child (`category-detail.ts:115`) and the page discards it. Both e2e specs that use this page work around the loss by re-appending `?period=2026` (`e2e/zz-spending-categorize.spec.ts:21`, `e2e/visual.spec.ts:28`).
11. **[medium] Split-part rows say where to edit them and give no way to get there** — `src/components/spending/InlineCategorizeList.tsx:52`. Lines 52-58 render a split part as an inert pill with the comment "its category is edited in the transaction sheet, not inline". There is no link to that sheet, no link to the parent transaction and no link to a filtered ledger. Split a $400 Costco charge across Groceries/Household, then visit the Groceries page: the row is declared editable elsewhere with no elsewhere to click.
12. **[medium] The page reports two different transaction counts for the same set** — `src/app/categories/[id]/page.tsx:135`. The header prints categorySpending's `txnCount = new Set(txns.map(t => t.id)).size`, i.e. distinct PARENT transactions (`analytics.ts:463`). The Transactions card prints loadSpendingCategoryTxns' `total = authoritative.length`, one entry per split ALLOCATION (`spending/actions.ts:76`). A category containing two 3-way splits shows "18 transactions" at the top and "View all 22 →" at the bottom, with no explanation.
13. **[medium] A category with no activity in the period produces five negations instead of an empty state** — `src/app/categories/[id]/page.tsx:143`. Header "$0.00 / 0 transactions", trend "No spending in the last 12 months.", Subcategories card silently absent (children filtered on `txnCount > 0`, `category-detail.ts:118`), Top merchants "No merchant spending in this period.", Series "No recurring series detected in this category yet.", Transactions "Nothing left to categorize here." — that last being the uncategorized-bucket copy, which reads as "you finished the work". /spending handles the identical situation with one EmptyState and a next-step hint (`spending/page.tsx:176-181`).
14. **[medium] Clicking a trend bar ejects you off the page instead of changing the period** — `src/components/spending/MonthlyTrendBars.tsx:21`. Each bar links to `ledgerHref({category, from, to})` (`category-detail.ts:77`), i.e. /transactions. Clicking March on a category's own trend leaves the page, losing the trend, the subcategory split, the merchants and the series; returning requires the browser back button. The period control that would do the right thing sits directly above the chart, and the page already accepts `?period=2025-03`.
15. **[low] The page prints the raw database enum for the category's kind** — `src/app/categories/[id]/page.tsx:127`. Renders `{header.kind}` verbatim, so the header's secondary line reads "Food · expense" or, for a transfer-kind category reached from a series chip, "Transfers · transfer". These are Drizzle column enum values, not copy — the clearest developer-data-dump tell on an otherwise carefully designed page.
16. **[low] Hand-rolled breadcrumb duplicates the shared component and loses aria-current** — `src/app/categories/[id]/page.tsx:94`. Lines 94-106 build a `<nav>` of `<Link>`s and `<Icon>`s with no `<ol>` and no `aria-current="page"` on the terminal item, while `src/components/ui/Breadcrumbs.tsx` — used by /accounts/[id], /merchants/[id], /investments/[t]/[s] and SeriesDetail — provides both. A screen-reader user on this route is not told which crumb is the current page.
17. **[low] Dead SpendDelta import marks the missing month-over-month feature** — `src/app/categories/[id]/page.tsx:32`. Imported and never rendered. SpendDelta is precisely the month-over-month delta the /spending row shows for this category before you click into it (`SpendingCategoriesTable.tsx:120`). The import is a fossil of the intended feature and will trip any no-unused-imports lint rule that gets turned on.
18. **[low] "Apply range" silently no-ops on an invalid custom range** — `src/components/spending/PeriodSelector.tsx:87`. `applyCustom` guards on `from && to && from <= to` and otherwise returns without state change. Set To = 2025-01-01 and From = 2026-01-01, press Apply: nothing happens, no message, the panel stays open. The min/max attributes (lines 176, 186) mitigate mouse pickers but not typed or pasted values.
19. **[low] Period paging has no upper bound and no end-of-data signal** — `src/components/spending/PeriodSelector.tsx:126`. `stepPeriodParams` will page to 2031-04. The resulting page renders $0.00, 0 transactions, an empty trend and four negation messages with nothing stating you are past the end of the imported ledger; the Next chevron never disables or changes appearance.
20. **[low] The two headline numbers are the only figures on the page that are not clickable** — `src/app/categories/[id]/page.tsx:134`. Lines 134 and 135 render the flow amount and the transaction count as plain spans. Every comparable figure elsewhere in the app is a link into its filtered list — SpendingStatCards, budget rows, heatmap cells, and the subcategory rows on this very page. The page's own biggest number violates the drill-down contract it otherwise upholds.

**Change** (ranked)

1. **Scope the top-merchant drill-downs to the category** *(S)* — thread the category through topMerchants' href construction: `ledgerHref({ merchant: g.id!, category: opts.categoryId, from, to })` and the same for the unlinked `q:` branch (`src/services/spending.ts:679-681`). `transactions-query.ts:53` and `:80` already compose merchant AND category, and `lib/ledger-href.ts:26` already accepts both, so this is a two-line change restoring the number↔list contract. Add a unit assertion that a category-scoped entry's href contains `category=`.
2. **Make the budget card follow the selected period, and label it** *(M)* — pass the page's period into `categoryBudgetRef` instead of today (`page.tsx:84` → `category-detail.ts:171`). Because a budget's own period (monthly/weekly/annual) may not match the viewed granularity, the safer shape is: keep `budgetStatuses(today)` but label the card explicitly with `status.bounds` ("July 2026 monthly budget") and, when the selected period differs, additionally show this category's spend for the SELECTED period against a pro-rated target. Never render a red over-budget badge for a period the user is not looking at.
3. **Print the numbers on the trend bars and give negatives their own treatment** *(M)* — in MonthlyTrendBars: (a) render the amount as visible compact text under or inside each bar in addition to the aria-label; (b) add `title=` for pointer hover; (c) compute the scale from `Math.max(...points.map(p => Math.abs(p.spentCents)))` so a negative month has real height, drawn below a zero baseline in `--negative` rather than clamped to 2% (lines 12-18); (d) replace the `max===0` early return with a genuine txnCount check so a net-credit year stops claiming there was no spending.
4. **Make the rename gate match the rename service** *(S)* — export the import-hint predicate from `category-edit.ts` (currently the private IMPORT_HINT_ROOTS / IMPORT_HINT_PATHS sets at lines 25-34) as `isRenameLocked(db, categoryId): { locked, reason }`, and drive both `page.tsx:116` and `moveDestinations` from it. When locked, render the plain `<h1>` plus a small lock affordance whose tooltip states the same reason string the service would have thrown. One predicate, two consumers, no dead-end pencil.
5. **Carry the period through every category link, in and out** *(M)* — add a `periodParams` helper (`period.key ? {period: key} : {from, to}`) and append it to the breadcrumb Spending and parent links (`page.tsx:95, 99`), the subcategory rows (`page.tsx:186` — at minimum stop discarding the range-scoped href the service already computes at `category-detail.ts:115`), and the four inbound links (`SpendingCategoriesTable.tsx:105,154`; `BudgetRow.tsx:77`; `SeriesDetail.tsx:134`). Then delete the manual `?period=2026` workaround from `e2e/zz-spending-categorize.spec.ts:21` and `e2e/visual.spec.ts:28` and let the specs prove the carry.
6. **Add a residual row and per-row metadata to the Subcategories card** *(M)* — render an explicit "Directly in {category}" row for header total − Σ children (`page.tsx:183-192`) so the list always adds up, render each child with `<Money flow>` instead of `Math.abs` (`page.tsx:188`), and add the `txnCount` the service already returns (`category-detail.ts:113`) plus a share bar and the SpendDelta already imported at `page.tsx:32`. This makes the card at least as informative as the /spending row that linked here.
7. **Restore Undo for single-row corrections** *(S)* — in `correct-category.ts:32-45` keep the server-captured undo patch alive in the rule-prompt branch: render a two-action toast ("Undo" plus "Apply to N") or offer Undo as the secondary action, so a mis-tag on a busy merchant is always one click from reverting. Today it is revertible only when the merchant has exactly one transaction.
8. **Always offer a route to the filtered ledger** *(S)* — render "View all N →" unconditionally (`InlineCategorizeList.tsx:70`), relabelled "Open in ledger →" when total ≤ the cap, and additionally make the header's transaction count (`page.tsx:135`) and flow amount (`page.tsx:134`) links to the same transactionsHref. Three of the page's exits currently exist only above 100 rows.
9. **Give the page a real empty state and rewrite the transaction-list copy** *(S)* — when `txnCount === 0` for the selected period render `<EmptyState>` (already used at `spending/page.tsx:176`) with the category name, the period, and a "Jump to the last period with activity" link computed from the trend data the page already has. Separately, add an `emptyLabel` prop to InlineCategorizeList so the category page says "No transactions in this category for {period}" instead of the uncategorized-bucket sentence at `InlineCategorizeList.tsx:26`.
10. **Make the trend bar set the period instead of leaving the page** *(M)* — change each bar's href from `ledgerHref` (`category-detail.ts:77`) to `/categories/{id}?period={month}` so clicking March re-scopes the page in place, and move the ledger drill to a secondary affordance (the new tooltip, or the header count). Highlight the bar(s) inside the currently selected period, and rename the heading to state its window ("Trailing 12 months to Jul 2026") so the trend and the header stop reading as two unrelated windows.
11. **Reconcile the two transaction counts** *(S)* — either have `loadSpendingCategoryTxns` report distinct-parent totals to match the header (`spending/actions.ts:76` vs `analytics.ts:463`), or label them differently in the UI ("18 transactions · 22 allocations"). Whichever is chosen, add a cross-reference comment at both sites so the next person does not "fix" one in isolation.
12. **Route the command palette and the transaction sheet to this page** *(S)* — change `command-index.ts:66` to href `/categories/${c.id}` (merchants two lines above already do the equivalent) and update the assertion at `command-index.test.ts:48` that currently pins the stale behaviour. Add a category link to the transaction sheet and the ledger row's category chip so the page is reachable from the ledger the way /merchants/[id] is.
13. **Use the shared Breadcrumbs component and a dynamic page title** *(S)* — replace the hand-rolled nav at `page.tsx:94-106` with `<Breadcrumbs items={[...]} />` to pick up `<ol>` semantics and `aria-current='page'`, and swap `export const metadata` (`page.tsx:35`) for `generateMetadata` returning the category name so twenty open tabs are distinguishable on a phone.
14. **Give split-part rows and transaction rows a way in** *(M)* — make the split-part pill (`InlineCategorizeList.tsx:52-58`) a link to the parent transaction in the ledger, and make the row body open the transaction sheet the way /transactions does — so split, exclude, note, transfer-link and merchant-view become reachable from here instead of only recategorize.
15. **Label the category kind in human words** *(S)* — map `header.kind` through a display table at `page.tsx:127` ("Expense category", "Income category", "Transfer — excluded from spending and income", "Investment activity"). For the excluded kinds, state the exclusion on the page: the header's "Net" label (`page.tsx:76`) currently gives no hint that these rows appear in neither the Spent nor the Earned totals anywhere else in the app.
16. **Use the dead SpendDelta import rather than deleting it** *(S)* — `page.tsx:32` imports SpendDelta unused. Since nothing may be removed, render it: show the month-over-month delta beside the headline number, computed from `resolvePeriod(stepPeriodParams(period,-1), today)` exactly as /spending does at `spending/page.tsx:87-89`.

**Add** (ranked)

1. **Period comparison: vs last period and vs the same period last year** *(M)* — beside the headline (`page.tsx:130-136`) show Δ vs the previous period and Δ vs the year-ago period, each as an amount, a percentage and a link to that period's page. The machinery exists: /spending computes `prevPeriod = resolvePeriod(stepPeriodParams(period,-1), today)` and diffs categoryBreakdown (`spending/page.tsx:87-89`), and SpendDelta — already imported here and unused at `page.tsx:32` — is the renderer with the correct inverted spend semantics. Overlay the comparison period as a ghost series on the trend the way `projection.reindexByPosition` does on /spending. **Why:** this is the single question the page exists to answer and cannot. The owner sees "Food $5,113" and must open a second tab on a different period to learn whether that is normal. Monarch, Copilot and YNAB all lead a category screen with the comparison, not the raw total.
2. **Set, edit and track a budget from the category page** *(M)* — when `categoryBudgetRef` returns null, render a "Set a monthly budget for {name}" card posting `createBudgetAction` (`src/app/budgets/actions.ts:30`) with a suggested amount from `predictBudgetableCategories` (`src/services/category-forecast.ts` — the same engine /budgets' PredictBudgets uses). When a budget exists, allow editing the amount in place via BudgetAmountEditor instead of bouncing to a bare /budgets link, and inherit the parent's budget on a subcategory page with a "governed by Food's $250" note. **Why:** the decision "I'm spending too much on this" happens here and nowhere else, and the page currently answers it with a link to a screen showing every other category. A subcategory page shows no budget at all even when its parent's budget is what constrains it.
3. **Bring MonthlyTrendBars up to chart parity** *(L)* — give the trend the kit the rest of the app got in passes 22-23: a y-axis via `lib/chart-axis.niceLinearTicks`, a range control (12M/24M/ALL) via ChartRangePills, a chart⇄table lens using the universal LENS_DIMENSION (`src/components/charts/chart-lens.ts`) APPENDED — never inserted — to a new CATEGORY_VIEW_SPEC, and ChartFocus (`src/components/charts/ChartFocus.tsx`) for expand. `docs/future-ideas.md:88` already names this exact row as the largest remaining parity gap ("everything (bare CSS bars + drill)") and roadmap item 5 is still open. **Why:** the owner explicitly wants ambitious data visualization and phone readability. This is the only chart in the app with none of the standard interactions, on the page where the most interesting time-series question lives.
4. **A /categories index route** *(M)* — `src/app/categories/` contains only `[id]/`. Add a browsable index listing every top-level category with its period spend, share, MoM delta, 12-month sparkline, budget status and subcategory count — reusing `categoryBreakdown` and `budgetStatuses`. Add it to NAV_ITEMS (`src/components/shell/nav-items.ts`), or at minimum make the palette's Categories group land there. **Why:** categories are the app's primary organizing concept and no screen lists them. The only way to reach one is to already know which you want and find it on /spending, /budgets or a series page — and the palette, the one global search, deliberately routes elsewhere (`command-index.ts:66`).
5. **Category identity editor (hue + icon)** *(M)* — make the CategoryChip in the header (`page.tsx:110`) an editable control: a 12-hue picker from `lib/category-palette` plus an icon picker over the validated IconName set, written through a guarded action alongside renameCategoryAction. CategoryChip already validates and degrades junk values (`CategoryChip.tsx:30-31`), so the write path is safe by construction. **Why:** the 12-hue category identity ramp is the backbone of the design system — it colours the donut, the Sankey, the heatmap dots and every chip — and it is entirely unwritable from the UI. This page shows the identity and is the only sensible place to change it.
6. **"What the app has learned about this category" panel** *(M)* — list the rules whose action targets this category (`services/rules-manager.renderRuleSentence` already renders them in prose), the merchants whose `default_category_id` points here (`services/merchants`), and a count of rows in this category by `categorizationSource` (rule / merchant_map / bank_category / claude / user). Each row links to the rule or the merchant. **Why:** after pass 24's seven guarded write passes the owner's central question is "why does this row keep landing here?". The answer lives in rules and merchant defaults and no screen shows them per-category — there is not even a /merchants index.
7. **Next-month forecast for this category** *(S)* — render `predictBudgetableCategories`' entry for this category — already surfaced read-only on the /spending table at `SpendingCategoriesTable.tsx:129-145` with basis, confidence and seasonal-adjustment flags — as a forward bar on the trend plus a line under the headline, gated to the current month exactly as /spending gates it (`spending/page.tsx:107`). **Why:** the /spending row you clicked to get here already shows "August 2026 ≈ $412 · high confidence". Clicking into the category LOSES it — the detail page is strictly poorer than the summary row.
8. **Largest transactions in this category** *(S)* — a "Biggest hits" card mirroring /spending's LargestPurchases, scoped to the subtree. `largestTransactions` (`src/services/spending.ts:710`) already exists and takes a range; it needs a categoryId option the way topMerchants has one (`spending.ts:624`). **Why:** "what drove the spike in March" is the natural follow-up to every trend bar, and today the only way to answer it is to page through an unsorted, uncapped-at-100 list.
9. **Day-level activity for this category** *(M)* — a category-scoped calendar/heatmap reusing `ui/CalendarGrid` the way SpendHeatmap does, showing which days in the selected period carried spend in this category, with the day-detail sheet pattern shipped in pass 23. **Why:** the owner already has this interaction on /spending and it is the fastest way to spot a burst. Scoped to one category it answers "was this one bad weekend or a steady drift?" — currently unanswerable without exporting the ledger.
10. **Sibling comparison on a subcategory page** *(S)* — when `header.isSubcategory`, show the other children of the same parent with their flows and this one highlighted — the inverse of the Subcategories card, using the same `categorySubcategorySplit(parentId, range)` call the page already makes for top-level categories. **Why:** a subcategory page is the emptiest state in the app: no subcategories card, no budget, and a parent link that drops the period. The one thing you want standing on "Groceries" is how it compares to "Restaurants".
11. **Merchant lifecycle inside the category** *(M)* — extend the Top merchants card with per-merchant MoM delta, a "new this period" badge, and a "stopped" section for merchants that were regulars and have gone quiet — all derivable from two topMerchants calls over adjacent ranges. **Why:** "where did the increase come from" is a merchant-level question, and the card shows a static ranking with no direction of travel.
12. **Bulk verbs on the transaction list** *(M)* — add selection plus the existing bulkEdit verbs (`src/services/bulk-edit.ts` — set category, mark reviewed, mark transfer, exclude) to this page's list, with the same server-recomputed id set and lossless UndoPatch the ledger uses (`bulk-edit.ts:100-184`). **Why:** the category page is where you notice 40 rows are in the wrong bucket; today fixing them is one chip click at a time, or navigating to /transactions and rebuilding the filter by hand — and below 100 rows there isn't even a link to do that.
13. **Keyboard scope for the surface** *(S)* — register a `useKeyScope` on this route (`lib/keyscope.ts` is already the app's mechanism): ‹ › for period paging, `t` to jump to the transaction list, `b` to open budgets, `/` to focus a category filter. **Why:** five other surfaces register scopes (palette, sheet, toast, review-inbox, txn-ledger). This one registers none (verified by grep), so on a desktop monitor the whole page is mouse-only.
14. **Archive and merge a category** *(L)* — `categories.isArchived` exists in the schema and is honoured by `buildCategoryPickerOptions` (`category-options.ts:20`) and `command-index.ts:53`, but no UI writes it — and there is no merge path at all. Add both here behind the same guard set moveCategory uses (transfer/system and import-hint excluded), with merge re-pointing `transactions.category_id` inside one transaction and a lossless undo patch. **Why:** a 67-category taxonomy accumulates dead buckets. A category can be renamed and re-parented but never retired or folded in, so the picker's option list only ever grows.
15. **A phone-first summary block above the fold** *(M)* — a compact top-of-page block — total, Δ vs last period, budget ring, biggest merchant, next expected recurring charge — rendering above the fold at 375px, with the existing cards below it as progressive detail. **Why:** the owner says he will view this from his phone. Today the first screenful is a breadcrumb, an editable title, a raw enum, a number and a five-pill period switcher — the actual answer starts around the third scroll.

---

## /merchants/[id] — merchant detail

`src/app/merchants/[id]/page.tsx`, `src/components/merchants/MerchantDefaultCategory.tsx`, `src/components/merchants/MerchantNameHeading.tsx`, `src/app/merchants/actions.ts`, `src/services/merchants.ts`; e2e `zz-zz-merchant-default.spec.ts` + `zz-inline-renames.spec.ts:71-92`.

**Purpose** — This is the owner's control panel for ONE entity in the learning layer — the place where he teaches the app "everything called this is that category." Its real job in his life is the tail of the categorization work he did over 24 passes: he lands here from a transaction he doesn't recognize or a recurring series, renames the merchant so future imports still resolve to it (renameMerchant preserves the old name as a contains-alias, `services/merchants.ts:289-301`), sets the merchant→category default so every FUTURE import auto-files it (`categorize.ts:205-220` merchant-map precedence), and optionally backfills the merchant's still-uncategorized rows in one gesture with a lossless undo (`services/merchants.ts:109-149`). Secondarily it is supposed to answer "how much do I actually give this merchant?" — today it answers that with exactly one number (calendar-YTD net, `page.tsx:46-50`) and five undated-context rows. The page's own header comment (`page.tsx:17-21`) admits it is "Stage-1 v1" and that alias editing, monthly-spend bars, linked recurring series and merge-into are follow-ups. Those follow-ups never shipped, so this is the least-built-out detail page in the app while sitting on the highest-leverage write in the app (a merchant default silently steers every future import).

**Connections**

- **READS**: `services/merchants.merchantSummary` (`services/merchants.ts:50-79`) — all ACTIVE transactions with this merchantId pulled into JS, then reduced (index `ix_transactions_merchant` exists, `db/schema/transactions.ts:76`); plus the full categories table for the picker (`page.tsx:57` → `components/transactions/category-options.ts:17-36`).
- **WRITES**: `setMerchantDefaultCategoryAction` → `merchants.default_category_id` + `mapping_source='user'` (`services/merchants.ts:98-101`); `applyMerchantDefaultAction` → `transactions.category_id`/`source='merchant_map'`/`confidence=1`/`needsReview=false` for NULL-category active rows only (`services/merchants.ts:135-147`); `renameMerchantAction` (`app/transactions/actions.ts:502-514`) → `merchants.canonical_name` + a new contains-alias row.
- **DOWNSTREAM**: the default is consumed by categorizeAll's merchant-map step (`categorize.ts:205-220`) on every import and every "Run categorization"; the alias is consumed by `matchAlias` (`categorize.ts:121-132`); Claude's classifier reuses merchants by canonicalName and deliberately never overwrites an existing default (`claude-categorize.ts:233-249`).
- **INBOUND LINKS (only three)**: the transaction sheet's "View merchant →" (`components/transactions/TransactionSheet.tsx:296-299`, a router.push), the recurring series detail chip (`components/recurring/SeriesDetail.tsx:126-131`), and the command palette's Merchants group (`services/command-index.ts:80-92`).
- **OUTBOUND LINKS (only two, both to the same place)**: `/transactions?merchant=<id>` (`page.tsx:64`) and `/transactions` (`page.tsx:85`). There is NO /merchants index — `src/app/merchants` contains only `[id]/page.tsx` and `actions.ts`, so the breadcrumb parent "Transactions" (`page.tsx:37`) is a fiction and the only enumeration of merchants in the whole app is ⌘K, which has no visible trigger anywhere in the shell (`components/shell/AppShell.tsx:50-59` renders only a tagline + ThemeToggle).

**Interactive inventory**

| element | file:line | intended | verdict |
|---|---|---|---|
| Busy guard on both mutations | `src/components/merchants/MerchantDefaultCategory.tsx:41, 63` | prevent double submit | **broken** — `setBusy(false)` lives only inside `.then` (lines 46, 67). Neither promise has a `.catch`. A rejected server action (offline, 500, RSC transport error) leaves busy=true permanently — the Apply button stays disabled (`Button.tsx:45`) and every subsequent category pick silently returns at line 41 with zero feedback. `useInlineEdit` handles exactly this case explicitly (`useInlineEdit.ts:80-83`). |
| "View all {N} →" link → `/transactions?merchant=<id>` | `src/app/merchants/[id]/page.tsx:63-68` | open the merchant-filtered ledger | **broken** — `filterConditions` honors `?merchant` (`services/transactions-query.ts:54`) but FiltersBar renders NO merchant control and NO merchant chip, `hasActiveFilters` omits `filters.merchant` (`FiltersBar.tsx:27-29`) so even the Reset link is hidden, and the GET form (`FiltersBar.tsx:31`) carries no hidden merchant input — so the user lands on a ledger that looks unfiltered and silently loses the merchant scope the instant they touch any other filter. Also a text-xs inline link with no padding: a ~14px tap target on the phone the owner says he'll use. |
| Category picker option rows (click / mousemove) | `src/components/transactions/CategoryPicker.tsx:152-176` | pick the default category | **dead-end** — the option list is built by `buildCategoryPickerOptions` (`category-options.ts:22-35`) and contains ONLY real categories. There is no "None / Clear default" option, and `pick()` only ever emits a string id (`CategoryPicker.tsx:82-86`). `setMerchantDefaultCategory` supports null (`services/merchants.ts:94-101`) and the action schema is `.nullable()` (`app/merchants/actions.ts:14`) — the capability exists and is unreachable. Once a default is set, the ONLY way to remove it is the 5-second Undo toast. |
| Rename error path (duplicate name) | `src/services/merchants.ts:281-286` | reject a rename that collides with an existing merchant | **dead-end** — throws `A merchant named "X" already exists`, surfaced as a red inline error (`InlineEditableText.tsx:74-78`) and the display rolls back. That is the exact moment the user wants to MERGE the two merchants, and there is no merge action anywhere in the app (grep: no merge/dedupe path touches the merchants table). The user is told no and given nothing. |
| Recent activity rows (5 × `<li>`) | `src/app/merchants/[id]/page.tsx:74-80` | recent context for this merchant | **dead-end** — plain `<li>` — not clickable, not focusable, no sheet, no expander. Everywhere else in the app a transaction row opens something (`TransactionsLedger.tsx:109` openId). They also omit the CATEGORY and the ACCOUNT, which is absurd on the one page whose entire job is deciding this merchant's category: you cannot see which of these five rows are miscategorized. Hard-capped at `RECENT_LIMIT=5` (`services/merchants.ts:17`) with no "show more". |
| Merchant name input (type, Enter commit, blur commit, Escape cancel, maxLength 80) | `src/components/ui/InlineEditableText.tsx:61-73` | commit a new canonical name via renameMerchantAction | **missing-state** — `renameMerchant` returns `aliasCreated` (`services/merchants.ts:257-258, 300`) and `MerchantNameHeading.tsx:31-33` throws it away. The single most important guarantee of the rename — "the old name is now a contains-alias so future imports still land here" — is never told to the user. The toast just says "Renamed to X" (`useInlineEdit` default describe, `InlineEditableText.tsx:53`). |
| Rename success toast + Undo | `src/hooks/useInlineEdit.ts` (describe → toast with Undo) | revert the rename | **missing-state** — undoing the rename renames the merchant back but does NOT remove the alias row that the first rename inserted (`services/merchants.ts:290-300` has no inverse). The alias silently persists, so after rename+undo the merchant permanently matches an extra pattern the user thinks they reverted. |
| "Default set to {label}" toast + Undo | `src/components/merchants/MerchantDefaultCategory.tsx:50-57` | revert to the previous default | **missing-state** — line 55 fires `setMerchantDefaultCategoryAction(...).then(refresh)` with no ok-check. If the restore fails the page refreshes and shows the NEW default while the user believes they undid it — the same call site checks `r.ok` two lines earlier (line 46). It also cannot restore the previous `mappingSource`: line 99 of `services/merchants.ts` always stamps 'user', so undoing a change to a seed-mapped merchant leaves it claiming to be user-mapped. |
| "No transactions." empty state | `src/app/merchants/[id]/page.tsx:70-71` | zero-data copy | **missing-state** — a merchant with zero active rows still renders "0 transactions", "+$0.00" for This year (`formatCentsSigned(0)` → "+$0.00", `lib/money.ts:80-83`) and a live "View all 0 →" link into an empty ledger. No explanation of why it is empty (all rows superseded? re-categorized away?) and no offer to delete/archive the orphan merchant. |
| Document title | `src/app/merchants/[id]/page.tsx:14` | browser tab / history label | **missing-state** — static `{ title: "Merchant" }`. Every merchant tab, every history entry and every phone tab-switcher card says "Merchant". No generateMetadata anywhere on the route (same flaw as `accounts/[id]:29` and `recurring/[id]:14`, so fixing it here is a pattern the other detail pages should copy). |
| "Apply to {N} uncategorized →" button | `src/components/merchants/MerchantDefaultCategory.tsx:86-90` | backfill the merchant's NULL-category active rows with the default | **undiscoverable** — rendered only when `defaultCategoryId && uncategorizedCount > 0`. So the single most actionable number on the page — how many of this merchant's rows are uncategorized (`services/merchants.ts:77`) — is invisible for every merchant that has no default yet. A merchant with 60 uncategorized rows and no default shows the user nothing at all. |
| Pencil glyph (opacity reveal on hover/focus) | `src/components/ui/InlineEditableText.tsx:111-128` | signal editability | **undiscoverable** — `opacity-0` until group-hover / group-focus-visible. On the owner's phone there is no hover, so the H1 looks like static text and the rename affordance is invisible on the primary viewing device. |
| Global ⌘K palette (only enumeration of merchants) | `src/services/command-index.ts:80-92` + `src/components/shell/AppShell.tsx:50-59` | jump to any merchant | **undiscoverable** — works, but has no visible trigger in the shell header, so on touch the merchant layer is reachable only by drilling a transaction sheet. The palette also serializes ALL merchants (no LIMIT, `command-index.ts:73-75`) into every navigation's RSC payload. |
| Breadcrumb "Transactions" link | `src/app/merchants/[id]/page.tsx:37` | go up to the parent surface | **confusing** — claims Transactions is this page's parent. The real parents are the transaction sheet (`TransactionSheet.tsx:296`), a recurring series (`SeriesDetail.tsx:127`) or ⌘K. Arriving from /recurring/[id], the breadcrumb offers no way back to the series. A merchant's true parent — a merchant index — returns 404 (`src/app/merchants` has no `page.tsx`). |
| "This year" figure (4xl signed Money) | `src/app/merchants/[id]/page.tsx:46-50` | how much this merchant costs him | **confusing** — non-interactive, no drill-down, and hard-wired to the CALENDAR year (`services/merchants.ts:65-68`). Every sibling detail page has a PeriodSelector (`categories/[id]/page.tsx:140`). In January this number is ~$0 and useless; it also can never be compared to last year. It is signed net (refunds included) rendered with `flow`, so a merchant that net-refunded shows a green +$X under the word "This year" with no label saying whether that is spend, net or income. |
| Category picker trigger button (chip, aria-label "Category: X. Change") | `src/components/transactions/CategoryPicker.tsx:103-117` (mounted at `MerchantDefaultCategory.tsx:85`) | open the default-category picker | **confusing** — when no default is set the chip reads "Uncategorized" (`CategoryPicker.tsx:116`). On a merchant page that reads as "this merchant's transactions are uncategorized", not "no default rule exists". Nothing on the page says a default is a FUTURE-import rule that leaves existing rows alone — the only explanation lives in a code comment (`MerchantDefaultCategory.tsx:15-19`). |
| "← All transactions" footer link | `src/app/merchants/[id]/page.tsx:85-87` | go back | **confusing** — duplicates the breadcrumb at line 37 — two links to the same unfiltered /transactions, neither of which returns the user to where they came from. Since the sheet's open state is component-local useState (`TransactionsLedger.tsx:109`), even the browser Back button drops the user on the ledger with the sheet closed. |
| Default-category `<section>` wrapper | `src/components/merchants/MerchantDefaultCategory.tsx:81-84` | group the rule control | **confusing** — a `<section>` with no accessible name (no aria-label, no heading) — it is not exposed as a region. The e2e has to locate it by text (`page.locator("section", { hasText: "Default category" })`, `zz-zz-merchant-default.spec.ts:31`), which is exactly the brittleness an accessible name would remove. |
| Page-level `<header>` stack | `src/app/merchants/[id]/page.tsx:46` + `src/components/merchants/MerchantNameHeading.tsx:23` | title block then hero figure | **confusing** — two sibling `<header>` elements back to back inside `<main>`. The title header is outside the space-y-6 stack and the figure header is inside it, so the vertical rhythm between the H1 and the hero number is set by mb-8 on one and nothing on the other — the hero number reads as a caption of the picker below it rather than as the page's headline metric. |
| Route error handling | `src/app/merchants/[id]/page.tsx:25-31` | 404 on an unknown merchant id | **confusing** — the bare `catch { notFound() }` swallows EVERY error from merchantSummary — a genuine DB failure renders as "this merchant does not exist". There is no `not-found.tsx` or `error.tsx` anywhere in `src/app`, so the fallback is Next's default 404 page with no link back into the app. |
| Breadcrumb current item "{merchant name}" | `src/components/ui/Breadcrumbs.tsx:25-27` | aria-current=page label | **sensible** |
| Merchant name inline-edit trigger (span role=button, tabIndex 0, click / Enter / Space) | `src/components/merchants/MerchantNameHeading.tsx:25-35` → `src/components/ui/InlineEditableText.tsx:90-106` | turn the H1 into an input to rename the merchant | **sensible** |
| "{N} transactions" subtitle | `src/app/merchants/[id]/page.tsx:42` | scale of this merchant | **sensible** |
| Category picker search input (role=combobox, ArrowUp/ArrowDown/Enter) | `src/components/transactions/CategoryPicker.tsx:128-146` | filter and keyboard-select a category | **sensible** |
| Category picker "No matching category" empty state | `src/components/transactions/CategoryPicker.tsx:150` | empty search result | **sensible** |
| Category picker Escape / light-dismiss | `src/components/transactions/CategoryPicker.tsx:57-60` | close without picking | **sensible** |
| "Nothing uncategorized to fill" toast | `src/components/merchants/MerchantDefaultCategory.tsx:71-73` | honest no-op feedback | **sensible** — unreachable in practice (the button only renders when the count is >0) but correct as a race guard. |
| "Categorized · {N}" toast + Undo (offerUndoToast → undoAction) | `src/components/merchants/MerchantDefaultCategory.tsx:75` | lossless revert of the backfill | **sensible** — the undo patch is server-captured per-row (`services/merchants.ts:124-134`) and the displayed N is exactly the mutated set — the same predicate produces both (`services/merchants.ts:77` vs `113-123`). This is the best-engineered control on the page. |
| Global `a` toast mnemonic | `src/components/shell/ToastMnemonic.tsx:16-24` | focus the newest action toast (i.e. the Undo on this page) | **sensible** — genuinely useful here; the two Undo affordances on this page are both reachable by pressing `a`. |

**Good**

1. The backfill's blast radius is honest end to end: the N in "Apply to N uncategorized" and the rows the mutation touches come from the SAME predicate (merchantId + status='active' + categoryId IS NULL) computed server-side twice — `services/merchants.ts:77` for the label, `services/merchants.ts:113-123` for the write. The button never lies about what it will do. Propagate this to every count-bearing button in the app.
2. The backfill never overwrites an existing categorization and carries a lossless per-row undo patch captured BEFORE the write (`services/merchants.ts:124-134`), pinned by a test that asserts a user-categorized sibling is untouched (`services/merchants.test.ts:313-336`). This is the correct shape for every destructive-ish bulk action.
3. Rename preserves the learning layer: the old canonical name becomes a `contains` alias inside the same transaction as the rename (`services/merchants.ts:289-301`), so a rename can never orphan future imports. The uniqueIndex on (pattern, matchType) plus onConflictDoNothing makes it idempotent.
4. Both mutations are value-returning ActionResult with try/catch → typed error strings (`app/merchants/actions.ts:22-48`), matching the app-wide toast pattern rather than throwing into the error boundary (contrast: `settings/actions.ts` returns void).
5. The e2e spec is deliberately non-destructive — it sets a default then Undoes it so the shared seed is left exactly as found (`e2e/zz-zz-merchant-default.spec.ts:39-41`), and it reaches the page the way a human does (open sheets until one resolves to a merchant, lines 16-27) rather than hard-coding an id.
6. `merchantSummary` is clock-injectable (`today: string = todayIso()`, `services/merchants.ts:53`) and tested for both the excluded-row and the future-year edge (`merchants.test.ts:93-124`). Pure-ish, deterministic, no hidden Date.now.
7. The inline-rename primitive is shared verbatim with accounts and categories (InlineEditableText + useInlineEdit), including optimistic display with rollback on a THROWN save and a monotonic generation guard (`useInlineEdit.ts:59-90`). Nothing is bespoke here.

**Bad** (ranked)

1. **[high] A merchant default cannot be cleared — the picker has no "None" option** — `src/components/merchants/MerchantDefaultCategory.tsx:85`. Owner sets Netflix's default to Entertainment, then months later decides Netflix should be reviewed case-by-case (it's now split between his and Carson's card). He opens `/merchants/<netflix>`, clicks the chip, and the listbox (`CategoryPicker.tsx:148-179`, options from `category-options.ts:22-35`) contains only real categories — no clear/none row. `pick()` can only emit a string (`CategoryPicker.tsx:82-86`). The service supports null (`services/merchants.ts:94-101`) and the action schema is `.nullable()` (`app/merchants/actions.ts:14`). He can change the rule but never remove it; the only exit is the 5-second Undo toast on the original set. Every subsequent import silently keeps auto-filing Netflix.
2. **[high] A rejected server action permanently bricks both controls (busy never resets)** — `src/components/merchants/MerchantDefaultCategory.tsx:41-67`. Owner is on his phone on cellular, taps a category in the picker, the tunnel drops and the server action rejects. `.then` never runs, so `setBusy(false)` at line 46 never fires. From that moment: the Apply button is disabled forever (`pending={busy}` → disabled, `Button.tsx:45`) and every further category pick returns silently at line 41. No toast, no spinner state, no error. The page looks alive and is inert until a full reload. Neither promise has a `.catch` (lines 44, 65) — the codebase's own inline-edit primitive handles exactly this case (`useInlineEdit.ts:80-83`).
3. **[high] "View all N →" drops the user on a ledger with an invisible, silently-droppable filter** — `src/components/transactions/FiltersBar.tsx:27-31`. Owner clicks "View all 47 →" (`page.tsx:63-68`) and lands on `/transactions?merchant=<id>`. `filterConditions` applies it (`transactions-query.ts:54`) but nothing on the page says so: FiltersBar has no merchant select and no merchant chip, and `hasActiveFilters` omits `filters.merchant` so the Reset link doesn't even appear. He then types a date into the From field and presses Filter — the GET form at `FiltersBar.tsx:31` posts only view/account/category/from/to/q, so the merchant scope vanishes. He now believes he is looking at "Netflix, Jan–Mar" and is actually looking at the ENTIRE ledger Jan–Mar, and any bulk action he takes there hits that whole set.
4. **[medium] The uncategorized count — the page's most actionable number — is hidden unless a default already exists** — `src/components/merchants/MerchantDefaultCategory.tsx:86`. A merchant Claude created with no default and 60 uncategorized rows renders: name, "60 transactions", a YTD figure, an "Uncategorized" chip, and five dead rows. `uncategorizedCount` is computed (`services/merchants.ts:77`) and passed in (`page.tsx:56`) but its only rendering is gated on `defaultCategoryId && uncategorizedCount > 0`. The owner cannot tell this merchant is the biggest hole in his ledger, which is precisely the merchant he most needs to act on.
5. **[medium] The Undo on "Default set to X" is fire-and-forget and can silently fail** — `src/components/merchants/MerchantDefaultCategory.tsx:55`. Owner mis-taps Entertainment instead of Subscriptions, hits Undo. Line 55 runs `setMerchantDefaultCategoryAction({merchantId, categoryId: defaultCategoryId}).then(refresh)` with no ok-check — if the merchant row was concurrently touched or the call errors, the page refreshes showing Entertainment while the toast has already disappeared and the user believes the revert landed. Nine lines earlier the same file checks `r.ok` and toasts the error (lines 46-49). It also always re-stamps `mappingSource='user'` (`services/merchants.ts:99`), so undoing a change to a seed-mapped merchant cannot restore its provenance.
6. **[medium] Backfilling N transactions does not revalidate the dashboard or budgets** — `src/app/merchants/actions.ts:41-43`. Owner sets Chipotle's default to Food > Dining and applies it to 38 uncategorized rows. `applyMerchantDefaultAction` revalidates `/merchants/<id>`, `/transactions` and `/spending` but NOT `/` or `/budgets`. He navigates to /budgets to see the effect and the Dining budget still shows the pre-backfill spend from the router cache — the same mutation done from the ledger revalidates `/` (`app/transactions/actions.ts:172-175`). Two write paths for the same category change with two different cache-invalidation sets.
7. **[medium] Recent activity omits category and account — on the page whose only job is categorization** — `src/app/merchants/[id]/page.tsx:74-80`. Owner is deciding whether Amazon should default to Shopping. The five rows show date, description, amount. They do NOT show each row's current category, so he cannot see that three of them are already user-categorized as Household and would be untouched by the backfill, nor which account they hit. The transaction sheet he came FROM shows more (siblings, a spend sparkline, per-account split — `TransactionSheet.tsx:262-320`). The destination page is strictly poorer than the popover that linked to it.
8. **[medium] The one number on the page is calendar-YTD net with no period control and no comparison** — `src/app/merchants/[id]/page.tsx:46-50`. On Jan 3 the hero figure reads "-$41.99" for a merchant the owner spent $2,400 at last year (`services/merchants.ts:65-68` filters `postedOn.slice(0,4) === current year`). There is no PeriodSelector, no trailing-12-months option, no prior-year comparison, no monthly bars — while /categories/[id] has all of them (`categories/[id]/page.tsx:140, 144-147`). And because it is a signed NET rendered with `flow` (`page.tsx:49`), a heavily-refunded merchant shows a green "+$X" under the neutral label "This year" with nothing saying whether that means income, net, or spend.
9. **[medium] Renaming into an existing merchant name is a hard dead end with no merge** — `src/services/merchants.ts:281-286`. Claude created both "AMAZON MKTPL" and "Amazon.com" (`claude-categorize.ts:233-249` reuses by canonicalName only). Owner opens the first, renames it to "Amazon.com" to unify them, and gets `A merchant named "Amazon.com" already exists` with the display rolled back. There is no merge action on this page or anywhere in the app — no path moves aliases + transactions from one merchant to another. His only recourse is hand-editing the DB, which is exactly what he did for 7 guarded writes in pass 24.
10. **[medium] Aliases — the thing that actually decides what lands on this merchant — are completely invisible** — `src/app/merchants/[id]/page.tsx:33-88`. Owner wonders why a random "SQ *COFFEE 4417" row got filed under this merchant. The answer is a `merchant_aliases` row (`schema/merchants.ts:26-39`) created either by his own earlier rename (`services/merchants.ts:290-299`) or by Claude (`claude-categorize.ts:249-253`). No service reads aliases for a merchant and nothing on this page lists them. He cannot see, add, edit, prioritize or delete an alias — the learning layer is write-only from the UI.
11. **[medium] No back-link to recurring series even though the schema models it** — `src/app/merchants/[id]/page.tsx:35-38`. `recurring_series.merchant_id` exists (`db/schema/recurring.ts:29`) and SeriesDetail links merchant→page (`SeriesDetail.tsx:126-131`), but the reverse is missing: no service returns series for a merchant and the page renders none. Owner arrives here from his Netflix series, sets the default, and has no way back to the series — the breadcrumb sends him to /transactions and the footer link sends him to /transactions. Round-trip broken in one direction only.
12. **[low] Every merchant tab is titled "Merchant"** — `src/app/merchants/[id]/page.tsx:14`. Static metadata. Owner opens Netflix, Amazon and Chipotle in three phone tabs to compare and the tab switcher shows three identical "Merchant" cards. Browser history is three indistinguishable entries. `generateMetadata` could return the canonical name from the same merchantSummary call.
13. **[low] Rename Undo does not remove the alias the rename created** — `src/services/merchants.ts:289-301`. Owner renames "NFLX DIGITAL" → "Netflix", sees it looks wrong, hits Undo. renameMerchant runs again in reverse, restoring the name — but the first call already inserted a permanent contains-alias for "NFLX DIGITAL" and the second call now inserts one for "Netflix". Two aliases exist that the user believes they reverted, and "Netflix" as a contains-alias will now capture unrelated descriptions.
14. **[low] Zero-transaction merchant renders "+$0.00" and a link to an empty ledger** — `src/app/merchants/[id]/page.tsx:63-71`. A merchant whose rows were all re-categorized away or superseded shows "0 transactions", hero "+$0.00" (`formatCentsSigned(0)` returns a plus sign, `lib/money.ts:80-83`), "No transactions.", and a live "View all 0 →" link that lands on an empty ledger. No explanation, no archive/delete offer.
15. **[low] Every navigation affordance on the page is a sub-20px touch target** — `src/app/merchants/[id]/page.tsx:63-87`. "View all N →" is text-xs with no padding (line 65), "← All transactions" is text-sm with no padding (line 85), the breadcrumb is text-xs (`Breadcrumbs.tsx:18`). On the phone the owner says he will view this from, none of the three reach a 44px target and two of them sit within a few pixels of each other's line boxes.

**Change** (ranked)

1. **Add a "No default" option to the picker on this surface** *(S)* — give CategoryPicker an optional `allowClear` prop that prepends a `{ id: null }` row (or accept a sentinel id) and widen `onPick` to `(id: string | null)`. `MerchantDefaultCategory.tsx:40-60` already handles null end to end (setDefaultSchema is `.nullable()`, `app/merchants/actions.ts:14`; `setMerchantDefaultCategory` clears both defaultCategoryId and mappingSource, `services/merchants.ts:99`). Purely additive — no other call site passes the prop, so the ledger/review/sheet pickers are unchanged.
2. **Add `.catch` to both mutations so a rejected action releases `busy` and toasts** *(S)* — `MerchantDefaultCategory.tsx:44` and `:65` — append `.catch(() => { setBusy(false); toast({ title: "Could not reach the server", tone: "negative" }); })`. Mirror `useInlineEdit.ts:80-83`, which already documents this app as seeing thrown saves on flaky wifi. Also check `r.ok` on the Undo path at line 55 before calling `refresh()`.
3. **Always show the uncategorized count, not just when a default exists** *(S)* — move the count out of the button label into a persistent line under the picker: "{N} of {txnCount} still uncategorized" as a link to `/transactions?merchant=<id>&category=uncategorized` (that filter value already exists, `transactions-query.ts:57-59`). Keep the Apply button exactly as-is when a default is set. `MerchantDefaultCategory.tsx:86-90`.
4. **Make the merchant filter visible and sticky on /transactions** *(M)* — two additive edits, both in `FiltersBar.tsx`: include `filters.merchant` in `hasActiveFilters` (lines 27-29) so Reset appears, and add `{filters.merchant ? <input type="hidden" name="merchant" value={filters.merchant} /> : null}` next to the existing view hidden input (line 32) so submitting the form preserves the scope. Then render a removable "Merchant: {name}" chip above the ledger. This makes `page.tsx:64` honest.
5. **Make the recent-activity rows real transaction rows** *(M)* — add categoryId → CategoryChip and the account name to MerchantTxnRow (`services/merchants.ts:19-26` already selects categoryId; add an accounts join like `similarTransactions` does at `merchants.ts:171`), and wrap each row so it opens the shared TransactionSheet — or at minimum link each to `/transactions?merchant=<id>` anchored on the row. `page.tsx:74-80`.
6. **Add a PeriodSelector and label the hero number** *(M)* — reuse `components/spending/PeriodSelector` with `basePath=/merchants/<id>` exactly as `categories/[id]/page.tsx:140` does, thread the resolved range into merchantSummary (it already takes an injectable `today`, `services/merchants.ts:53`), and replace the bare "This year" label with "{Spent|Received|Net} · {period.label}" using the same sign/kind logic as `categories/[id]/page.tsx:70-79`. Keep calendar-year as the default so nothing changes for an existing bookmark.
7. **Surface `aliasCreated` after a rename** *(S)* — `renameMerchantAction` (`app/transactions/actions.ts:502-514`) already receives `aliasCreated` from the service and drops it at line 510. Return it, and have `MerchantNameHeading.tsx:31-33` pass a `describe` into InlineEditableText that says "Renamed to X — future imports matching \"{oldName}\" still land here". One extra field, no behavior change.
8. **Give the page a real title and a real parent** *(S)* — add `generateMetadata` returning the canonical name (`page.tsx:14`), and make the breadcrumb context-aware: accept an optional `?from=` param so the sheet's router.push (`TransactionSheet.tsx:297`) and the series chip (`SeriesDetail.tsx:127`) can hand back a return href, falling back to Transactions. Also name the default-category `<section>` (aria-labelledby the existing label span, `MerchantDefaultCategory.tsx:81-84`) so it becomes a real region and the e2e can stop locating it by text.
9. **Revalidate the dashboard and budgets after the backfill** *(S)* — `app/merchants/actions.ts:41-43` — add `revalidatePath("/")` and `revalidatePath("/budgets")` so a category-changing mutation invalidates the same set the ledger's equivalent does (`app/transactions/actions.ts:172-175`).
10. **Stop pulling the whole merchant ledger into JS for four numbers** *(M)* — `merchantSummary` (`services/merchants.ts:58-77`) SELECTs every active row of the merchant then reduces in JS. For the owner's Robinhood-class merchants (1,837 rows) that is the whole set per render. Replace with three aggregate queries (count, SUM over the year range, COUNT WHERE category_id IS NULL) plus a LIMIT 5 for `recent` — `ix_transactions_merchant` already exists (`db/schema/transactions.ts:76`). Same outputs, same tests.
11. **Distinguish a real error from a missing merchant** *(S)* — `page.tsx:25-31` catches everything and 404s. Match on the service's "Unknown merchant" message (`services/merchants.ts:56`) for notFound() and rethrow anything else, and add an app-level `error.tsx` + `not-found.tsx` that link back into the app — today neither file exists anywhere under `src/app`.
12. **Enlarge the navigation affordances for touch** *(S)* — `page.tsx:63-68` and `:85-87` — give both links `px-2 py-1.5 -mx-2` negative-margin padding so they hit ~40px without changing layout, and drop the redundant footer link into the same row as "View all" or keep both but visually differentiate them (they currently point at the same URL modulo the filter).

**Add** (ranked)

1. **Merge merchant into another merchant** *(L)* — a `mergeMerchants(db, fromId, intoId)` service: repoint `transactions.merchant_id`, move `merchant_aliases` rows (onConflictDoNothing on the (pattern, matchType) unique index, `schema/merchants.ts:38`), add the losing merchant's canonicalName as a contains-alias on the survivor, repoint `recurring_series.merchant_id` (`schema/recurring.ts:29`), keep the survivor's default unless it is null, and return a lossless undo patch of every repointed row id. Surface it as a "Merge into…" control on this page AND as the recovery offer when a rename collides (`services/merchants.ts:286`) instead of a dead-end error. **Why:** Claude creates merchants by canonicalName (`claude-categorize.ts:233-249`) and the owner has 434+ of them. Duplicates are structurally guaranteed and there is currently ZERO way to fix one without hand-editing SQLite. Monarch, Copilot and Lunch Money all ship merchant merge as a first-class action; this is the single biggest functional hole on the surface.
2. **Aliases panel: list, add, delete, and "why did this row land here?"** *(M)* — a `merchantAliases(db, merchantId)` reader plus add/delete actions, rendered as a card listing pattern · matchType · priority · a live count of active rows currently matching it. Add an inline "test" field that shows which existing descriptions a candidate alias would capture BEFORE saving (reuse matchAlias, `categorize.ts:121-132`). Deleting an alias should show its blast radius the same way the backfill button does. **Why:** aliases are what actually route imports to this merchant, they are created invisibly by both rename and Claude, and the owner cannot see or undo a single one. This is the "what has the app learned?" screen the whole learning layer is missing.
3. **Spend-over-time chart with the app's chart engine (chart⇄table lens + focus)** *(M)* — feed a monthly (or daily, per the period) series for this merchant into ScrubChart via the same panel shape the other four consumers use, wired through ChartFocus + LENS_DIMENSION appended to a new MERCHANT_VIEW_SPEC (`chart-lens.ts:17-19` — append, never insert). Overlay a per-year comparison line. `txnHistory` already computes exactly this series for the sheet's sparkline (`services/txn-detail.ts:190-239`) — promote it. **Why:** the owner asked for ambitious visualization and every other detail surface has a chart. Right now the transaction SHEET shows a sparkline of this merchant's spend and the merchant PAGE shows nothing — the popover out-visualizes the page it links to.
4. **"Where this merchant hits" breakdown: by account, by category, by card** *(M)* — three small tables/donuts from the rows already loaded: spend by account (`txnHistory.byAccount` already computes it, `txn-detail.ts:235-238`), current category distribution across this merchant's rows (so the owner can see "38 Shopping, 4 Household, 60 uncategorized" before he sets a default), and largest single transactions with links. **Why:** the category distribution is the missing input to the page's central decision. Setting a default today is a blind bet — he cannot see that this merchant is already 90% consistently categorized, or that it's genuinely split across two categories and deserves a rule rather than a default.
5. **Recurring series section (the missing return leg)** *(S)* — a `seriesForMerchant(db, merchantId)` reader rendering the same CategorySeriesList component the category page uses (`categories/[id]/page.tsx:203-206`), each row linking to `/recurring/[id]` with next-due and amount. Plus an "unlinked but looks recurring" hint using the existing detection. **Why:** the FK exists (`schema/recurring.ts:29`) and the link is already one-directional (`SeriesDetail.tsx:127`). Completing the round trip costs one query and fixes the orphaned navigation for anyone who arrives from a series.
6. **A /merchants index — the learning layer's home screen** *(L)* — a sortable, searchable table: merchant · alias count · txn count · YTD spend · default category chip (inline-editable with the same picker) · uncategorized count · last seen. Default sort by uncategorized count DESC so the highest-leverage merchants surface first. Bulk "set default" for selected rows. Register it in `shell/nav-items.ts` so it appears in SideNav, MobileNav and the palette's Pages group. **Why:** `src/app/merchants` has no `page.tsx`, so /merchants is a 404 and the ONLY enumeration of 434 merchants is ⌘K — which has no visible trigger in the shell (`AppShell.tsx:50-59`) and is therefore unreachable on the phone the owner says he will use. There is currently no screen in the app that answers "what has the app learned, and where is it still ignorant?"
7. **Rule promotion from the merchant page** *(M)* — a "Make this a rule" control that turns the merchant default into a real `rules` row via the existing ruleFromCorrection machinery (`services/rule-corrections.ts:104-137`), with the count-then-apply preview (countRuleMatches / retroApplyRule share one predicate, `rule-corrections.ts:155-181`) so the owner can retroactively recategorize ALREADY-categorized rows — something the merchant default provably cannot do (categorizeAll only considers `category_id IS NULL`, `categorize.ts:176`). **Why:** the page's central promise ("set a default") silently applies only to future imports and NULL-category rows. When the owner realizes 200 old Amazon rows are filed wrong, this page offers him nothing — the retro-apply engine exists and is unreachable from here.
8. **Merchant notes + a "who/what is this" field** *(S)* — a free-text notes field on the merchant (new nullable column + inline-editable textarea), plus surfacing the raw description patterns actually seen so the owner can recognize a cryptic descriptor. **Why:** pass 24 was 16 questions of the owner reconstructing what merchants were (Wise = dad's money, Ingrid = Cancun reimbursement, StephanCodes = SwiftUI course). Every one of those answers currently lives only in a session memory file, not in the app. The merchant page is where that knowledge belongs.
9. **Archive / deactivate an orphan merchant** *(S)* — an `isArchived` flag (mirroring `categories.isArchived`, which `category-options.ts:20` already filters on) hiding the merchant from the palette index and the future /merchants table, with an undo. Never delete — the owner said don't delete anything. **Why:** Claude and imports create merchants that end up with zero active rows. They pollute the palette and the (future) index forever with no way to quiet them.
10. **First seen / last seen / average / cadence line** *(S)* — a one-line stat strip under the hero: first transaction date, last transaction date, count, average amount, median days between — all derivable from the rows merchantSummary already loads. **Why:** "am I still paying this?" and "is this a subscription?" are the two questions a merchant page should answer at a glance. Today the owner has to open the ledger and do the arithmetic himself.

---
## /imports

`src/app/imports/page.tsx` (216 lines, a pure Server Component with zero client code) + `src/app/imports/actions.ts` (35 lines) over `src/services/import/service.ts` (1014 lines). E2E: `e2e/zz-golden-path.spec.ts`.

**Purpose** — This is the front door of the whole app and the only place the owner's money data enters it. There is no Plaid and no bank API — every balance, every net-worth point, every category and forecast downstream is derived from files the owner personally downloads from Chase/SoFi/Capital One/Discover/Robinhood and drops here. Its job in his life is a monthly ritual: pull the new statements, drop them, and confirm that the app's numbers still tie to the bank's printed numbers to the cent (`page.tsx:74`). Its second job is the trust ledger — a permanent record of what has been ingested, what reconciled, and what did not. Today it does the first job with no feedback and the second job as a raw database dump: on his real DB it renders 88 file rows whose columns are filename / parser-id / count / status, and three green counters. It never answers the actual question he opens it to ask, which is "what am I missing?"

**Connections**

- **READS**: `import_files` left-joined to `transactions` for a per-file txn count (`page.tsx:34-49`), and `statement_periods` inner-joined to `accounts` for reconciliation state (`page.tsx:51-64`).
- **WRITES** via three server actions (`actions.ts`): `uploadStatementsAction` → `importStatementFiles` (`service.ts:339`), which sniffs → profiles → inserts canonical rows → writes `balance_anchors` + `statement_periods` → then runs `rebuildAccount`, `categorizeAll`, `detectTransfers`, `flagFuzzyDuplicates`, `reconcileAccounts` and rebuilds again (`service.ts:354-363`). `unimportFileAction` → `unimportFile` (`service.ts:962`) HARD-DELETES the file's transactions, anchors and periods. `acceptGapAction` → `acceptGap` (`service.ts:990`) un-quarantines rows and permanently stamps the period `accepted`. All three then `revalidatePath` seven routes (`actions.ts:7`).
- **OUTBOUND LINKS**: none — the page contains zero `<Link>` and zero `<a>`; it is a terminal node.
- **INBOUND LINKS**: only the nav entry (`src/components/shell/nav-items.ts:19`). Nothing on /accounts, /transactions, /dashboard or the quarantined ledger tab (`src/components/transactions/query.ts:9`) ever points a user here, and this page never points at them — despite quarantine being the single mechanism by which this page removes money from every analytic.

**Interactive inventory**

| element | file:line | intended | verdict |
|---|---|---|---|
| "un-import" button (one per file row) | `src/app/imports/page.tsx:198` | remove a file's contribution | **broken** — the most destructive control in the entire app, rendered as 8-pixel grey text with no confirm, no undo, no toast, and no count of what it will destroy. `unimportFile` HARD-DELETES transactions (`service.ts:974`) — including rows the owner hand-categorized with `categorization_source='user'`. Every other user-attribute carrier in the app is protected; the re-parse path even carries user categories forward (`service.ts:706`), and `docs/schema.md:94-95` promises attributes are preserved for re-attachment. Nothing in `unimportFile` does that. All 88 buttons share the identical accessible name "un-import". |
| "Accept as-is" button (one per gap) | `src/app/imports/page.tsx:138` | take the statement at face value; un-quarantine its rows | **broken** — irreversible with no confirmation and no undo. `reconcileAccounts` skips `accepted` periods permanently (`service.ts:822`), so importing the corrected statement later will NOT re-reconcile it unless the printed balances themselves changed (`service.ts:588-601`). It also can be a complete no-op that looks like it worked: `acceptGap` un-quarantines only rows whose `import_file_id` equals the period's own file (`service.ts:998-1009`) — if that file's rows were all `skippedOwned` by a higher-fidelity source, zero rows change, yet the gap disappears from the trust surface forever. All gap buttons share the identical accessible name "Accept as-is". |
| StatCard "Reconciled periods" | `src/app/imports/page.tsx:106` | count of periods that closed to the cent | **dead-end** — a number with no drill-down. Real DB: 105. There is no list of the 105, no way to see which accounts/months they cover, no link. The one place in the app where "reconciled to the cent" is proven is a green integer you cannot click. |
| StatCard "Value anchors (investment)" | `src/app/imports/page.tsx:110` | count of investment periods valued rather than reconciled | **dead-end** — real DB: 8. Not clickable, and `market_change_cents` — the whole point of a value anchor, computed at `service.ts:842` and selected at `page.tsx:59` — is never rendered anywhere on the page. |
| StatCard "Open gaps" | `src/app/imports/page.tsx:114` | count of unreconciled periods | **dead-end** — not clickable (the gap list below is the only route, and only exists when >0). Also: on the real DB 105 + 8 + 0 = 113, but there are 115 `statement_periods` — the two `not_applicable` periods are counted nowhere and listed nowhere, and `accepted` periods likewise vanish. The three cards silently fail to account for the population. |
| Gap row: account name + `periodStart → periodEnd` | `src/app/imports/page.tsx:129` | identify the unreconciled statement | **dead-end** — plain text. No link to `/accounts/[id]`, no link to `/transactions?account=…&from=…&to=…` to see the rows that failed to sum, no link to the file that produced it. To investigate a gap the owner must retype the dates into another surface by hand. |
| `RECONCILIATION_LABEL` map | `src/app/imports/page.tsx:24` | human labels + tones for all five reconciliation states | **dead-end** — declared and never referenced anywhere in the render (grep: line 24 is the only occurrence in the file). It is the only place in the codebase with copy for `accepted` ("gap accepted") and `not_applicable` ("no printed balances") — proof the design intended a full period list that was never built. |
| `format` column in the query | `src/app/imports/page.tsx:38` | csv/ofx/qfx/pdf badge | **dead-end** — selected and never rendered. Format is the fidelity ordering that drives every ownership/takeover decision (FORMAT_PRIORITY, `service.ts:30`) and it is invisible on the one page about files. |
| `importedAt` column in the query | `src/app/imports/page.tsx:42` | when the file was ingested | **dead-end** — selected, used for `orderBy desc` (`page.tsx:48`), and never rendered. The list is sorted by a date it refuses to show. |
| "Import" submit button | `src/app/imports/page.tsx:95` | run the import batch | **missing-state** — no pending state, no disabled state, no spinner, no progress. This is the only submit path in the app with no `useTransition`/toast wrapper — every other mutation surface uses one (`RulesManager.tsx:28`, `EditAccountSheet.tsx:59`, `PredictBudgets.tsx:26`). `importStatementFiles` is fully synchronous better-sqlite3 work: parse + insert + `rebuildAccount` × N + `categorizeAll` + `detectTransfers` + `flagFuzzyDuplicates` (an unindexed self-join over all 9,753 rows, `service.ts:878-889`) + `reconcileAccounts` + rebuild again. The golden-path spec budgets 30s for a 4-file batch (`zz-golden-path.spec.ts:38`). For a monthly drop the page is visually frozen and dead with no indication anything is happening. Double-click submits twice. |
| EmptyState "Nothing imported yet" | `src/app/imports/page.tsx:158` | first-run guidance | **missing-state** — prose only, no CTA, no example filenames, no per-institution "where to download this" guidance, no link to the upload card above it. First-run is the highest-stakes moment on this surface and it gets one paragraph. |
| Missing: any control to open a file's contributed rows | `src/components/transactions/query.ts:17-31` | answer "what did this file actually change?" | **missing-state** — `TxnFilters` has account/category/merchant/from/to/q/amount/flow/page — no `importFile`. There is no route from a file to its transactions anywhere in the app. |
| Missing: link to the quarantined ledger | `src/app/transactions/page.tsx:57` | see rows this page pulled out of analytics | **missing-state** — `/transactions?view=quarantined` exists and is the direct consequence of a gap on this page, yet the gap card only describes quarantine in prose (`page.tsx:150-153`) and never links to it. |
| Missing: re-parse / retry control | `src/services/import/service.ts:397` | re-run a bumped parser over an archived original | **missing-state** — the whole re-parse lifecycle is implemented and the original is archived at `import_files.storage_path`, but the only way to trigger it is to find the physical file on disk again and re-upload it. Same for retrying a `failed` file (`service.ts:391` explicitly allows re-import over a failed row). |
| Missing: download / open the archived original | `src/services/import/service.ts:258` | get back the source PDF | **missing-state** — `storagePath` is stored on every row and never surfaced. The owner's archive is a real, content-addressed, per-account folder tree (`data/statements/chase-checking-3522/` etc., 13 folders on his machine) that the product pretends does not exist. |
| Missing: any keyboard affordance or command-palette entry | `src/app/imports/page.tsx:1` | fast access | **missing-state** — the page has no `useKeyScope` (verified by grep), no shortcut, and `commandEntityGroups` (`src/services/command-index.ts`) indexes accounts/categories/merchants/holdings but not import files or statement periods. |
| Missing: /imports in the e2e a11y sweep | `e2e/a11y.spec.ts:8` | axe scan every screen | **missing-state** — ROUTES lists 12 paths; /imports is not one of them (verified). The page has never been axe-scanned. |
| Missing: /imports in the visual baseline sweep | `e2e/visual.spec.ts:9` | screenshot every screen at 320/768/1024/1440 × light/dark | **missing-state** — ROUTES lists 11 paths; /imports is not one of them (verified). The 5-column table has never been rendered at 320px in a test. The golden-path spec drives the upload but takes screenshots of /accounts and the account detail, never of /imports itself (`zz-golden-path.spec.ts:53-62`). |
| File name cell + native `title` tooltip | `src/app/imports/page.tsx:181` | show the file, truncated to 16rem, full name on hover | **undiscoverable** — truncation recovery is hover-only → unreachable on touch. And the filename is the ONLY identity: real rows read `20231110-statements-3522-.pdf` and `Statement_072026_4208.pdf`. Nothing tells you which account or institution that is. |
| Status cell + dot + native `title={f.error}` | `src/app/imports/page.tsx:186` | show parse status; expose the failure reason | **undiscoverable** — the error string is reachable ONLY as a hover tooltip — invisible on the phone, invisible to keyboard, invisible when copying. That string is the entire diagnostic output of the parser, including the load-bearing `Failed mid-import (un-import to clean up): …` message (`service.ts:629`) that tells the user rows were left committed in the DB. The CLI demo loader prints it properly (`scripts/demo/load-demo.ts:77`); the product hides it. |
| File input (`<input type="file" name="files" multiple required accept=".csv,.CSV,.ofx,.qfx,.QFX,.pdf">`) | `src/app/imports/page.tsx:86` | pick any mix of statement files for a batch import | **confusing** — bare browser file picker — no drag-and-drop zone, no client-side size/count/type validation, no preview of what was selected, no per-file remove. `accept` omits `.OFX`/`.PDF` (harmless, extensions match case-insensitively) but also omits any real gate: the 100mb server-action limit in `next.config.ts` means a whole batch is buffered in memory (`actions.ts:16-18`) before the first parse. React 19 resets the form after the action resolves, so after submit the user cannot see what he just uploaded. |
| Gap amount `<Money cents={p.gapCents ?? 0}>` | `src/app/imports/page.tsx:134` | state the exact discrepancy | **confusing** — rendered with `formatCents` (non-flow, `Money.tsx:14`), so a positive gap reads `$43.64` with no sign and no direction. `gap = ending − (beginning + total)` (`service.ts:850`) — positive means transactions are MISSING, negative means DOUBLE-COUNTED, and for a credit card the sign convention inverts mentally. Nothing on screen says which. The owner has to reconstruct the identity in his head to know whether to hunt for a missing row or a duplicate. |
| Files table scroll container (`max-h-[28rem] overflow-y-auto`) | `src/app/imports/page.tsx:167` | cap the ledger height | **confusing** — 88 real rows inside a 448px nested scroller with no fade/affordance, and (because overflow-y is non-visible) overflow-x computes to auto too, so it scrolls sideways on a phone with no indication. On the phone the owner says he'll use this from, a 5-column table inside a nested two-axis scroller inside the page scroller is the worst mobile pattern available. |
| Sticky `<thead>` — File / Profile / Txns / Status | `src/app/imports/page.tsx:169` | column headers | **confusing** — no sort controls, no `scope="col"`, no `<caption>`. Four columns for 88 rows with no sort, no filter, no search, no grouping. Import date and account/institution — the two things you'd sort by — aren't columns at all. |
| Profile cell (`f.parserProfile ?? "—"`) | `src/app/imports/page.tsx:184` | which parser handled the file | **confusing** — renders a raw internal id (`chase-checking-statement-pdf`, `capitalone-statement-pdf`). Pure developer data dump. `parserVersion` — the field that actually matters, because a bump triggers the re-parse lifecycle at `service.ts:397-405` — is never shown, so the owner can never tell which files are stale against the current parser. |
| Txns cell (`count(transactions.id)`) | `src/app/imports/page.tsx:185` | how many rows this file contributed | **confusing** — counts ALL statuses (no filter at `page.tsx:46`), so `superseded` and `excluded` rows inflate it. After any parser-version re-parse, the old file row survives with status Superseded and still displays its full old count next to the new file's count — the list appears to hold double the transactions. Separately, 4 real files legitimately show `0` with a green Parsed dot (discover-it-4741-statement-2024-08.pdf, sofi-statement-2026-06.pdf, 20230810-statements-3522-.pdf, 20231012-statements-3522-.pdf) and nothing distinguishes "contributed only balance anchors, correctly deferred to a better source" from "this file did nothing". |
| Implicit `<label>` wrapper "Statement files" | `src/app/imports/page.tsx:84` | label + click target for the input | **sensible** |
| Form submit via Enter key | `src/app/imports/page.tsx:83` | keyboard submit | **sensible** |
| Status dot `<span aria-hidden className="size-1.5 rounded-full …">` | `src/app/imports/page.tsx:188` | color-code status | **sensible** |
| PageHeader title + description | `src/app/imports/page.tsx:72` | explain the reconciliation contract | **sensible** |

**Good**

1. The reconciliation contract is real and it is stated on the page in plain language: "beginning + transactions = ending, to the cent, or it is flagged with its exact gap" (`page.tsx:74`). That is a genuinely differentiated promise — Monarch/Copilot/Mint cannot make it because they take a feed and never see a printed balance. Protect this framing; it is the product's actual thesis.
2. The gap card explains the consequence honestly and specifically: quarantined rows are out of every analytic until you fix or accept (`page.tsx:149-153`). It does not hide the failure and it does not silently guess. This honesty-first tone should be propagated to the states that currently have no copy at all (accepted, not_applicable, superseded).
3. `importStatementFiles` never silently drops a row — every non-insert path increments a named, visible counter (`skippedOwned`, `deduped`, `dedupedCrossFormat`, `supersededTakeover`, `quarantined`; `service.ts:41-58, 483, 544-546, 503`). The service is already instrumented for a world-class import receipt. The UI just throws it away.
4. Idempotency is genuinely safe and the copy says so truthfully (`page.tsx:80-82`): `(file_sha256, parser_version)` unique index + `skipped_duplicate` short-circuit (`service.ts:386-393`). Re-dropping a folder is a no-op. This removes the single biggest anxiety of file-based finance apps and deserves to be shown, not just asserted.
5. Format fidelity ordering (OFX < CSV < PDF, `service.ts:30`) with ownership skip and description-similarity takeover (`service.ts:659-693`) is a sophisticated, correct answer to "the same charge appears in three exports". Nothing else in the consumer category does this.
6. `archiveTo`/`relocateArchive` (`service.ts:258-302`) keeps every original, content-addressed, in a per-account folder — a real audit trail on disk (13 folders on the owner's machine). Also: `moveFile` handles EXDEV so a cross-device archive root doesn't abort a batch (`service.ts:271-279`), and the archive name is basename'd, control-stripped and truncated to 80 chars, neutralizing traversal and ENAMETOOLONG (`service.ts:410-414`).
7. Failure is contained per file, not per batch: a parse throw marks that one file `failed` with its cause and the loop continues (`service.ts:452-459`). One bad PDF cannot poison a 20-file drop.
8. The golden-path e2e drives the real browser through a real upload of real fixture files and asserts a relative increase in reconciled periods rather than an absolute count (`zz-golden-path.spec.ts:23-42`) — a well-built, non-brittle test. Keep this pattern.
9. `revalidatePath` fans out to all seven affected routes (`actions.ts:7`) so an import cannot leave a stale dashboard behind.

**Bad** (ranked)

1. **[critical] One-click un-import permanently destroys hand-categorized work with no confirm, no undo, and no statement of blast radius** — `src/app/imports/page.tsx:196-204` → `src/app/imports/actions.ts:23` → `src/services/import/service.ts:962-987`. The owner clicks the 8px grey "un-import" text (or fat-fingers it on his phone next to the status column). `unimportFileAction` fires immediately and `unimportFile` runs `tx.delete(transactions).where(eq(transactions.importFileId, id))` (`service.ts:974`) — a hard delete inside a transaction, no soft-delete, no snapshot (verified by reading the function). On the file that contributed 2,149 rows, that is 2,149 transactions gone in one click, including every row he hand-categorized with `categorization_source='user'` (pass 24 produced ~1,300 of those). There is no toast, no undo affordance (the app has a full undo-patch system — `ActionResult`/`BulkMutationData` in `src/app/transactions/action-types.ts:9` — that this page does not use), and no dialog. `docs/schema.md:94-95` promises user attributes are preserved for re-attachment where content-matchable; nothing in `unimportFile` does that, while the re-parse path at `service.ts:706` does. Recovery is a manual file copy from `data/backups`, which `src/app/settings/page.tsx:16-26` can only list, not restore.
2. **[high] The import result is computed in full and then thrown on the floor — a batch where nothing was inserted looks identical to a successful import** — `src/app/imports/actions.ts:13-21`. `importStatementFiles` returns `FileOutcome[]` with six per-file counters (`service.ts:41-58`). `uploadStatementsAction` does `await importStatementFiles(getDb(), inputs)` and discards the return value entirely (line 19, verified). The user is told nothing: not how many rows were inserted, not that 400 rows were `skippedOwned` because a higher-fidelity OFX already owned that date range, not that a takeover superseded 12 rows, not that a file failed. Concrete scenario: the owner drops November's Chase PDF after already having November's QFX. Every row is skipped as owned (`service.ts:482-484`), the file lands with status Parsed, the Txns column reads 0, and the page looks exactly like a successful import of new data. He has no way to know whether his November data is in the app. Four such 0-txn files already exist on his real DB. The CLI demo loader prints `fileName: error` for failures (`scripts/demo/load-demo.ts:77`); the product does not.
3. **[high] The page has no concept of missing data — two of the owner's accounts have had no statement in over two years and this surface reports only green** — `src/app/imports/page.tsx:51-64`. Queried against the owner's real DB: `Chase Checking`'s newest statement_period ends 2024-07-11 and `Discover`'s ends 2024-08-18, while SoFi/Robinhood/Capital One run to 2026-06/07. Today is 2026-07-27. /imports renders "Reconciled periods 105" in green (`page.tsx:108`) and "Open gaps 0" and says nothing else. There is no per-account last-statement date, no staleness indicator, no month-by-month coverage grid, no "you have no statement for Chase Checking since July 2024" warning. The one page whose entire job is data ingestion cannot tell the owner which data is missing — the single most important question he opens it to answer. Every competitor (Monarch, Copilot, Lunch Money, YNAB) surfaces a per-account "last updated / needs attention" state on its connections screen.
4. **[high] No pending state on the only long-running operation in the app — the page freezes for tens of seconds with zero feedback** — `src/app/imports/page.tsx:95-100`. The Import button is a bare submit inside `<form action={serverAction}>` in a Server Component. There is no `useFormStatus`, no `useTransition`, no disabled state, no spinner, no progress — this is the only mutation surface in the app without one (contrast `RulesManager.tsx:28`, `EditAccountSheet.tsx:59`, `PredictBudgets.tsx:26`, `ReviewInbox.tsx:47`, `TransactionsLedger.tsx:108`). The work is fully synchronous better-sqlite3: parse + insert + `rebuildAccount` per account (delete + reinsert years of daily_balances) + `categorizeAll` + `detectTransfers` + `flagFuzzyDuplicates` (an unindexed full-table self-join, `service.ts:878-889`) + `reconcileAccounts` + `rebuildAccount` again (`service.ts:354-363`). The golden-path spec allows 30 seconds for a four-file batch (`zz-golden-path.spec.ts:38`). Scenario: the owner drops his 12 monthly statements from his phone, sees nothing change, taps Import again, and now has two in-flight 100mb server actions against a single synchronous SQLite handle. Once hosted on a free tier this exceeds typical proxy timeouts outright.
5. **[high] Parser error text is reachable only as a native `title` tooltip — invisible on the phone the owner says he will use** — `src/app/imports/page.tsx:186-194`. `<td className="…" title={f.error ?? undefined}>`. A `failed` file shows a red dot and the word "Failed"; the actual reason — including `Failed mid-import (un-import to clean up): …` (`service.ts:629`), which is the ONLY notification that partial rows were committed and manual cleanup is required — exists only in a hover tooltip. Touch devices never fire it, keyboard users never reach it, and it cannot be selected or copied. Scenario: the owner drops a renamed Chase PDF, PDF profile routing is filename-only so it falls through to the generic `statementPdf` fallback and throws "No statement period found"; he sees a red dot labelled "Failed" on his phone and has no path to the cause, no retry button, and no idea whether transactions were left behind.
6. **[medium] "Accept as-is" is irreversible, unconfirmed, and can be a silent no-op that permanently hides a genuinely broken statement** — `src/app/imports/page.tsx:136-144` → `src/services/import/service.ts:990-1014, 822`. Clicking it fires `acceptGap` immediately. `reconcileAccounts` then skips `accepted` periods forever (`service.ts:822`), so re-importing the corrected statement will NOT re-reconcile unless the printed balances themselves differ (`service.ts:588-601`). There is no un-accept control anywhere. Worse: `acceptGap` un-quarantines only rows whose `import_file_id` equals the period's own file (verified at `service.ts:998-1009`) — if that file's rows were all `skippedOwned` by a higher-fidelity source, zero rows change status, yet the period flips to `accepted`, the gap leaves the Unreconciled list, and the "Open gaps" counter decrements. The trust surface now shows a clean bill of health for a statement that never reconciled and never will. And an accepted gap is invisible afterwards: `accepted` appears in no stat card and no list (the copy for it exists, unused, at `page.tsx:28`).
7. **[medium] The three stat cards do not account for the period population — the arithmetic visibly does not close** — `src/app/imports/page.tsx:66-121`. reconciled + value_anchor + gap are counted (lines 66-68); `accepted` and `not_applicable` are counted nowhere and listed nowhere. On the owner's real DB: 105 reconciled + 8 value anchors + 0 gaps = 113, against 115 rows in statement_periods (2 `not_applicable`). On a page whose stated contract is "to the cent", the summary row silently loses periods. Any `accepted` gap makes it worse — accepting a $200 discrepancy removes it from every visible number on the page with no residue.
8. **[medium] The file table omits the two identifying columns and renders internal ids instead** — `src/app/imports/page.tsx:34-49, 168-209`. Columns are File / Profile / Txns / Status (lines 171-175). `importedAt` is selected (line 42) and used to sort (line 48) but never displayed; `format` is selected (line 38) and never displayed; account and institution are never joined at all. Real rows read `20231110-statements-3522-.pdf` / `chase-checking-statement-pdf` / `14` / `Parsed`. Scenario: the owner scans 88 rows to find "the SoFi statement I imported last week" — he cannot sort by date (not shown), cannot filter by account (not present), cannot search (no input), and must decode account identity from raw bank filenames. The `Profile` column, meanwhile, shows a developer-facing parser id whose companion field `parserVersion` — the one that actually determines whether a file is stale against the current parser (`service.ts:397-405`) — is not shown.
9. **[medium] A file's transactions are unreachable from the file, in both directions** — `src/app/imports/page.tsx:185`. `TxnFilters` (`src/components/transactions/query.ts:17-31`) supports account/category/merchant/date/search/amount/flow/page and has no `importFile` dimension. There is no `/transactions?importFile=<id>` and no link from any file row. So the Txns count is an unauditable integer: the owner cannot answer "which 2,149 rows did this file bring in" before deciding whether to un-import it, and cannot answer "which file is responsible for this weird transaction" from the other side either. Combined with the un-import defect above, he is asked to authorize an irreversible delete of a set he is not permitted to see.
10. **[medium] /imports is excluded from both the a11y and the visual regression sweeps** — `e2e/a11y.spec.ts:8`. Verified: `a11y.spec.ts:8-23` enumerates 12 routes and `visual.spec.ts:9-22` enumerates 11; /imports is in neither. The golden-path spec drives an upload through the page but screenshots /accounts and the account detail instead (`zz-golden-path.spec.ts:53-62`). Consequence: the 5-column nested-scroll table at `page.tsx:167-209` has never been rendered at 320px in a test, the repeated identical accessible names ("Accept as-is" × N, "un-import" × 88) have never been axe-scanned, and the `<th>`s have no `scope` (lines 171-175). The one screen that the app's own doctrine calls "the trust layer" has zero automated UI coverage.
11. **[medium] The Txns count includes superseded and excluded rows, so a parser re-parse makes the ledger appear to double** — `src/app/imports/page.tsx:43-46`. `count(transactions.id)` over a left join with no status predicate. `supersedeFileContribution` marks the old file's rows `superseded` but leaves `import_file_id` intact (`service.ts:774-777`), and the new parser version creates a second `import_files` row (unique on sha+version, `imports.ts:42`). Scenario: a parser bump re-parses the Robinhood activity CSV — the table then shows the superseded row with 2,149 and the new row with 2,149, total 4,298, against 2,149 actual live rows. Nothing on the page reconciles that, and there is no filter to hide superseded files.
12. **[low] Dead code and dead schema on the surface: an unused label map, an unwritten column, and two unreachable statuses** — `src/app/imports/page.tsx:24-30`. `RECONCILIATION_LABEL` is declared and never referenced — and it is the only copy in the codebase for `accepted` ("gap accepted") and `not_applicable` ("no printed balances"). `importFiles.supersededBy` (`src/db/schema/imports.ts:36`) is declared with a self-FK and is never written or read anywhere in `src/`. `needs_claude` and `parsed_with_claude` have UI labels and tones (`page.tsx:18-19`) but nothing in the codebase ever sets them — there is no Claude-assisted parsing path. Two of the five status legends are permanently unreachable.
13. **[low] Repeated destructive controls share identical accessible names** — `src/app/imports/page.tsx:198-203`. 88 buttons named "un-import" (line 202) and N buttons named "Accept as-is" (line 142) with no `aria-label` disambiguation. A screen-reader user tabbing the ledger hears the same word 88 times with no way to know which file is focused; the row context (filename) is in a different cell and is itself truncated. For an irreversible hard delete this is a real safety problem, not a checklist item.

**Change** (ranked)

1. **Render the import receipt — stop discarding FileOutcome[]** *(M)* — change `uploadStatementsAction` (`actions.ts:13-21`) to return `ActionResult<FileOutcome[]>` (the type already exists at `src/app/transactions/action-types.ts:9`) and drive the form from a small client component using `useTransition` + `toast()`. Show, per file: inserted / deduped / dedupedCrossFormat / skippedOwned / supersededTakeover / quarantined, plus the accounts touched and periods created. Keep the last receipt on the page as a "Last import" SurfaceCard so it survives the toast. The counters already exist and are unit-asserted (`import.test.ts:82, 120, 283, 303, 318-320`); this is UI plumbing only. Highest value-per-line change on the surface.
2. **Give the Import button a pending state and a disabled state** *(S)* — wrap the form (`page.tsx:83-101`) in a client component using `useFormStatus`; disable the button, swap the label to a progress phrase naming the file count, and keep the selected filenames visible during the run. Guards against the double-submit and against the "is it doing anything?" freeze. Match the pattern already used at `EditAccountSheet.tsx:59` and `AddInstitution.tsx:17`.
3. **Put un-import behind a confirmation that states the blast radius, and add undo** *(L)* — convert the row button (`page.tsx:196-204`) into a client control that opens the existing `Sheet` with: filename, institution + account(s), number of transactions to be deleted, how many carry `categorization_source='user'`, how many periods and anchors die with it, and whether any accepted-gap state is lost. Require an explicit confirm. Then honor the `docs/schema.md:94-95` promise by having `unimportFile` capture user categories/notes/splits into a restorable patch (the app already has `UndoPatch` machinery in `src/services/bulk-edit.ts`) and offer "Undo" in the toast.
4. **Show import date, account, institution, format and parser version in the file table** *(M)* — `importedAt` (`page.tsx:42`) and `format` (`page.tsx:38`) are already selected and unrendered — render them. Add `parserVersion` to the select and show it beside the profile. Join through `statement_periods`/`transactions` (or `institutions` on `importFiles.institutionId`) to show which account(s) the file resolved to. This alone turns the ledger from a data dump into something scannable.
5. **Make the three stat cards complete and clickable** *(S)* — add `Accepted gaps` and `No printed balances` cards so the counts sum to `periods.length` (`page.tsx:66-68` currently loses 2 of 115 on the real DB), and make each card filter a full period list below. Use the already-written `RECONCILIATION_LABEL` map at `page.tsx:24-30` rather than deleting it.
6. **Lift the error string out of the `title` attribute** *(S)* — replace `title={f.error}` (`page.tsx:186`) with an expandable row / `Badge` + inline `<details>` showing the full message, selectable and touch-reachable, plus a "Retry import" affordance (`service.ts:391` already permits re-importing over a `failed` row). Same for the truncated filename at `page.tsx:181` — expose the full name on tap, not hover.
7. **State gap direction in words and link the gap to its evidence** *(M)* — render the gap with `flow` sign and a sentence: "printed ending is $43.64 HIGHER than the transactions sum — a debit is missing" vs "LOWER — a row is duplicated". Add links from each gap row (`page.tsx:127-147`) to `/accounts/[id]`, to `/transactions?account=…&from=…&to=…`, and to `/transactions?view=quarantined` (which already exists, `src/components/transactions/query.ts:9`) so the prose at `page.tsx:149-153` becomes navigable.
8. **Add sort, search and status/account filters to the file ledger** *(M)* — 88 rows today. Add sortable headers (date, txns, account, status), a text filter, and status chips including a "hide superseded" toggle. Persist through the existing URL-as-state `ViewSpec` system (`src/lib/view-state.ts`) so it is shareable and sticky like every other surface.
9. **Make the table responsive below `sm`** *(M)* — the 5-column table inside `max-h-[28rem] overflow-y-auto` (`page.tsx:167`) becomes a two-axis nested scroller on a phone. Below `sm`, render each file as a stacked card (name / account · date / status / actions). Then add `/imports` to `e2e/visual.spec.ts:9` (4 widths × 2 themes) and to `e2e/a11y.spec.ts:8`.
10. **Disambiguate repeated control names and fix table semantics** *(S)* — `aria-label={\`Un-import ${f.fileName}\`}` at `page.tsx:198` and `aria-label={\`Accept ${p.accountName} ${p.periodStart}–${p.periodEnd} as-is\`}` at `page.tsx:138`. Add `scope="col"` to the `<th>`s (`page.tsx:171-175`) and a visually-hidden `<caption>`.
11. **Filter the Txns count to live rows and show the breakdown** *(S)* — add `status IN ('active','quarantined','excluded')` to the join predicate at `page.tsx:46` so superseded rows stop inflating the count, and show `active / quarantined` split when quarantined > 0. Keep the superseded number available on the file detail rather than folded into one integer.
12. **Add a client-side pre-flight on the file input** *(M)* — before submitting (`page.tsx:86-93`), validate extension, per-file size and batch size in the browser, list the chosen files with a remove control, and warn on obvious problems (a renamed PDF that will fall through to the generic `statementPdf` fallback; a file already imported by sha). Cheap, and it prevents a 100mb in-memory batch (`actions.ts:16-18`) from being discovered as a failure minutes later.

**Add** (ranked)

1. **Statement coverage map — the answer to "what am I missing?"** *(L)* — a grid of account (rows) × month (columns) for the app's whole history, each cell colored by state: reconciled / value anchor / accepted gap / open gap / declared-range-only / nothing imported. Built from `statement_periods` joined to `accounts` (the query already at `page.tsx:51-64`, extended). Above it, a per-account strip: last statement end date, days stale, and the count of missing months since. Cells link to the period's file and to `/transactions?account=&from=&to=`. **Why:** on the owner's real DB, Chase Checking's newest period ends 2024-07-11 and Discover's ends 2024-08-18 — over two years stale, on today's date 2026-07-27 — while the page reports "Reconciled periods 105" in green and nothing else. He is currently making net-worth decisions on two accounts whose statements stopped two years ago and this surface actively reassures him. Every competitor puts account freshness on its connections screen; this is the single biggest missing feature on the page.
2. **Import receipt + import history** *(L)* — persist each batch's `FileOutcome[]` (`service.ts:41-58`) — a small `import_runs` table or a JSON blob — and render the last run as a receipt card: files, rows inserted, rows deduped, rows deferred to a higher-fidelity source, takeovers, quarantines, accounts touched, net effect on each account's balance. Keep a scrollable history of past runs. **Why:** today a batch where every row was `skippedOwned` is visually identical to a batch that imported 2,000 transactions (`actions.ts:19` discards everything). The owner cannot answer "did last month's drop actually land?" — the most basic question of a file-based finance app, and one Monarch/Copilot answer implicitly with a sync timestamp and a new-transaction count.
3. **File detail sheet with the full provenance chain** *(L)* — click a row → `Sheet` showing: institution, resolved account(s), format, sha256, parser profile + version (and whether a newer version exists), imported-at, archive path with a download link, the statement periods it created with their balances and reconciliation, the anchors it wrote, and its transactions via a new `importFile` filter on `/transactions`. Actions in the sheet: re-parse, download original, un-import (confirmed). **Why:** right now the file row is four opaque fields and one irreversible delete. Provenance is fully modelled in the DB (`storage_path`, `parser_version`, `statement_periods.import_file_id`, `balance_anchors.import_file_id`) and none of it is reachable. This is the audit trail that justifies calling the page a trust layer.
4. **Drag-and-drop dropzone with a per-file queue** *(L)* — a real drop target over the upload card (`page.tsx:77-102`) accepting a folder drop, showing each file as a queued chip with detected format, guessed institution, size, and live per-file status (queued → parsing → parsed/failed) streamed back from the server. Cancel individual files before submit. **Why:** the owner's ritual is downloading a folder of statements from five banks. Today he must use a native file picker, gets no preview, and after React 19 resets the form he cannot even see what he sent. This is the ergonomics every competitor's CSV importer ships with, and it makes the pending-state problem disappear as a side effect.
5. **Gap workbench** *(L)* — for each unreconciled period, an expandable panel showing: printed beginning, printed ending, replayed sum, the exact delta and its direction, the count and list of transactions in range (with a link to the ledger filtered to that account+window), the file that produced the period, and three explicit paths — import a corrected file, add a manual transaction to close it, or accept as-is. Add an un-accept control and a persistent "Accepted gaps" list showing the dollar amount each accepted period is carrying. **Why:** today a gap is a date range, a dollar figure with no sign, and a single irreversible button (`page.tsx:127-147`). The owner's only tool for a $43.64 discrepancy is to accept it — which permanently disables re-reconciliation (`service.ts:822`) and then erases all evidence that he did. This is the page's own headline promise and it currently has no workflow behind it.
6. **Parser-drift detector and one-click re-parse** *(M)* — compare each file's `parser_version` against the current `PROFILES` entry's version (`src/services/import/profiles/index.ts:21`) and surface "N files were parsed with an older parser". Offer re-parse from the archived original at `storage_path` — the supersede-then-reimport lifecycle already exists (`service.ts:397-405`) and already carries user categories forward (`service.ts:706`). **Why:** the whole re-parse lifecycle is implemented and completely unreachable from the product: the only way to trigger it is to locate the original file on disk and re-upload it by hand. Every parser improvement the owner ships is dead capital until he does that for 88 files.
7. **Statement-period timeline ribbon (the ambitious visualization)** *(L)* — a horizontal time axis per account with statement periods drawn as segments colored by reconciliation state, transaction density as a subtle histogram inside each segment, balance-anchor ticks where chain-grade anchors land, and visible white gaps where no statement exists. Brushable, and clicking a segment opens the file detail sheet. Reuse the app's existing chart vocabulary (`ScrubChart`'s coverage band, `lib/chart-axis.ts` day/month ticks) so it reads as part of the design system. **Why:** this is the owner's "think abstract" ask pointed at the one question the page cannot answer today. It makes two-year gaps physically visible rather than a number he has to notice is absent, and it turns the trust layer into the most striking screen in the app instead of the plainest.
8. **Per-account "connections" health card** *(M)* — for each account: last statement date, days stale, coverage % of days backed by a chain-grade anchor, open gap dollars, count of quarantined rows, and a "what to download next" hint (institution + the specific month missing). Rank by staleness so the worst account is first. **Why:** converts the page from a file log into an operations dashboard. It is the shape every competitor's Accounts/Connections screen takes, and the underlying data (anchors, periods, `daily_balances.basis`) already exists — `derivation.ts` even distinguishes `derived` from `gap`/`carried`/`derived_unverified`, which is a far richer coverage signal than any feed-based app can produce.
9. **Link the quarantine loop closed in both directions** *(S)* — from /imports: "N transactions quarantined" with a link to `/transactions?view=quarantined`. From the quarantined ledger tab (`src/app/transactions/page.tsx:57`): a link back to the statement period and file responsible. **Why:** quarantine is the mechanism by which this page removes money from every analytic, and today it is described only in prose (`page.tsx:150-153`) with no navigation. A user who notices his spending looks low has no route from the symptom to the cause.
10. **Add /imports to the command palette and the e2e sweeps** *(S)* — index import files and statement periods in `commandEntityGroups` (`src/services/command-index.ts`) so a filename or a month is searchable via ⌘K. Add `/imports` to `e2e/a11y.spec.ts:8` and `e2e/visual.spec.ts:9`, and extend the golden path (`zz-golden-path.spec.ts`) to screenshot the imports page itself and to assert the receipt copy once it exists. **Why:** 88 files with no search and no palette entry; a screen with zero axe coverage and zero visual baselines. Cheap, and it stops the surface from silently regressing every time a sibling page gets polished.
11. **Backup/restore hook on the destructive paths** *(M)* — before an un-import or an accept-gap, offer "snapshot first" using the existing `sqlite.backup()` machinery in `src/services/backup.ts`, and add a restore path (`src/app/settings/page.tsx:16-26` currently only lists backup filenames and sizes). **Why:** the app takes real online backups and has no way to use them. The two irreversible buttons on this page are exactly where that gap becomes expensive, and the owner has never rehearsed a recovery.

---

## /settings

`src/app/settings/page.tsx` (+ `actions.ts`, `rules-actions.ts`, `src/components/settings/RulesManager.tsx`).

**Purpose** — This is the owner's control room for the two things the app does automatically without asking him: spend his money on Claude API calls, and categorize his transactions by rule. Everything else in MoneyApp is derived from statements; this page holds the four knobs that are NOT derivable (AI budget, price-refresh cadence, the deposit size that trips a review flag, the Claude confidence floor), the precedence stack of automatic categorization rules, a receipt for AI spend, and proof that his SQLite file is being snapshotted. Given ~24 passes of hand-categorizing a real 20k-row ledger, the Rules card is the only place in the app that answers "what will the machine do to my data next time I import?" — and the Backups card is the only place that answers "if I break it, what do I have left?" It is also the page the /transactions header points at when it says "monthly cap reached — raise it in Settings" (`HeaderStrip.tsx:96`) and where TransactionSheet's "Manage →" link lands (`TransactionSheet.tsx:344`).

**Connections**

- **READS**: `app_settings` via `readSettings` (`services/settings.ts:50`) — all four thresholds plus backupRetention; `ai_calls` via `aiSpend` (`settings.ts:78`, two full-table scans); the rules table via `listRules` (`rules-manager.ts:146`), which for EVERY enabled rule runs `countRuleMatches` → `matchingRows` (`rule-corrections.ts:160`) = a full load of every `status='active'` transaction into JS; categories + accounts + merchants via `sentenceContext` (`rules-manager.ts:103`) to render rule sentences; `process.env.ANTHROPIC_API_KEY` (`page.tsx:34`); and the backups directory from disk via `defaultBackupsDir` (`client.ts:25`).
- **WRITES**: `writeSetting` × 4 (`actions.ts:24-27`) — no toast, no return value; and via RulesManager the rules table (`setRuleEnabled` / `moveRule` / `deleteRuleCapturing` / `restoreRule`, `rules-manager.ts:168-241`) plus the transactions table through `retroApplyRule` (`rule-corrections.ts:203`), which is a real bulk mutation of the ledger launched from Settings.
- **DOWNSTREAM CONSUMERS** of what this page sets: `aiMonthlyCapUsd` → `aiSpend().overCap` → hard-stops the Claude batch loop (`claude-categorize.ts:159`) and disables the Classify button (`HeaderStrip.tsx:84`); `priceStalenessHours` → `prices.ts:271` skip logic; `reviewCreditThresholdCents` → `categorize.ts:150` review flagging; `categorizationConfidenceMin` → NOTHING (see BAD, verified by repo-wide grep).
- `rules-actions.ts` revalidates /settings, /transactions and / on every mutation (`rules-actions.ts:29-32`).
- **INBOUND LINKS**: `nav-items.ts:25` and `TransactionSheet.tsx:344`. **OUTBOUND LINKS**: none — this page contains zero links to anywhere else in the app.

**Interactive inventory**

| element | file:line | intended | verdict |
|---|---|---|---|
| Input "AI monthly cap (USD)" | `src/app/settings/page.tsx:47` | set the hard monthly ceiling on Claude spend | **broken** — three defects in one control. (a) No `max` attribute, but settingsSchema caps at 1000 (`settings.ts:19`) — entering 2000 throws Zod out of the server action. (b) `step="0.5"` is enforced by the browser as a VALIDITY constraint, so typing 5.25 silently blocks submit with a native bubble. (c) Clearing the field submits `""` → `z.coerce.number()` = 0 → passes `min(0)` → cap becomes $0 → overCap is `0>=0` = true (`settings.ts:89`) → the Classify button is disabled forever (`HeaderStrip.tsx:84`). |
| "would change N" Badge | `src/components/settings/RulesManager.tsx:141` | live preview of the rule's blast radius | **broken** — N never decays. `retroApplyRule` (`rule-corrections.ts:216-224`) sets categoryId unconditionally, without comparing to the row's current category (verified by reading the loop), so a rule already fully applied still reports "would change 300". The badge advertises permanent pending work that does not exist. Not clickable — the one number a user most wants to drill into. |
| "applied N×" counter | `src/components/settings/RulesManager.tsx:142` | history of how often the rule fired | **broken** — inflated by no-op writes. `timesApplied += undoRows.length` (`rule-corrections.ts:244`) counts every row retroApplyRule touched, including rows whose category was already correct. Pressing "Re-apply 300" five times reports 1,500 applications and zero actual changes. |
| "Re-apply N" Button | `src/components/settings/RulesManager.tsx:163` | retroactively rewrite N transactions' categories | **broken** — a one-click bulk mutation of the real ledger with NO confirmation and no preview of which rows. It is the single most destructive control on the page and is styled as a quiet secondary button. It does return an Undo toast (`offerUndoToast`, `RulesManager.tsx:113`), but the toast is the only safety net and it lives in a corner. It also only appears when matchCount>0, and matchCount is permanently non-zero (see above), so it is always armed. |
| Delete IconButton | `src/components/settings/RulesManager.tsx:171` | remove the rule permanently | **broken** — NO confirmation, single click, 24×24px, immediately adjacent to two other 24px targets. The component's own doc comment claims "an accessible confirmation" (`RulesManager.tsx:23`) — the code has none. Undo exists via snapshot (`rules-manager.ts:192`) and does not auto-dismiss (`Toast.tsx:161`), which is the saving grace, but a mis-tap on a phone destroys a rule with no prompt. |
| "ANTHROPIC_API_KEY configured" status | `src/app/settings/page.tsx:103` | tell the user whether Claude is available | **broken** — `Boolean(process.env.ANTHROPIC_API_KEY)` — presence only, never validity. An expired or revoked key renders GREEN "configured" while every `classifyPendingMerchants` call rejects with a 401 that has no catch (`claude-categorize.ts:148` has try/finally, no catch) and surfaces as a Next error page. This is exactly the pass-24 "Claude button was failing" symptom, and this page actively told the owner the key was fine. There is no "Test connection" control. |
| Backups list items | `src/app/settings/page.tsx:122` | prove snapshots exist and show their size | **broken** — not interactive at all — no restore, no download, no reveal-in-Finder, no delete. And the ordering is wrong: `sort().reverse()` (`page.tsx:22-23`) puts `monthly-*` before `daily-*` lexicographically, then `slice(0,8)` keeps 8. With the default retention (14 daily + 6 monthly, `backup.ts:20`) the user sees all 6 monthlies and only the 2 newest of his 14 dailies. Filenames are shown raw; sizes are raw KB with no total. |
| `listBackups()` disk read | `src/app/settings/page.tsx:16` | enumerate .db files in the backups dir | **broken** — `fs.statSync` (`page.tsx:25`) is unguarded. If `prune()` removes a file between `readdirSync` and `statSync` (`backup.ts:102` runs on every boot and every maybeSnapshot), statSync throws ENOENT and — with no `error.tsx` anywhere under `src/app` — the entire /settings route 500s. |
| Input "Claude confidence minimum (0–1)" | `src/app/settings/page.tsx:56` | below this confidence, a Claude classification is flagged needsReview | **dead-end** — completely inert. `classifyMerchantsAction` calls `classifyPendingMerchants(getDb())` with no options (`transactions/actions.ts:150`), so the hard-coded default at `claude-categorize.ts:141` (0.8) always wins. Verified by repo-wide grep: `categorizationConfidenceMin` appears only in settings.ts, seed.ts and this page/actions. The user can move this number, see it persist, and change nothing. `step="0.05"` also makes 0.82 an invalid value. |
| "Weeks start Monday (ISO)" footnote | `src/app/settings/page.tsx:68` | disclose the week convention | **dead-end** — `weekStartsOn` is `z.literal("monday")` (`settings.ts:23`) — a setting that can only hold one value. Meanwhile CalendarGrid defaults weekStartsOn to 1 (`CalendarGrid.tsx:57`) and calendar-math supports 0-6. Stated as a preference, implemented as a constant. |
| Rules empty state | `src/components/settings/RulesManager.tsx:119` | explain that rules are born from corrections | **dead-end** — pure text with no CTA and no link to /transactions where a correction can be made. A user on a fresh DB reads a sentence and has nowhere to click. |
| AI spend headline "$X / $Y cap this month" | `src/app/settings/page.tsx:87` | show month-to-date Claude cost against the cap | **dead-end** — a number with no "why". `aiSpend` ALREADY computes `recent[]` — the last 10 calls with createdAt, purpose, model, batchSize and estCostUsd (`settings.ts:90-96`) — and the page throws every one of them away. The user cannot see what he paid for. There is also no progress bar, no prior-month comparison, and no note that the figures are display estimates from hard-coded per-MTok constants (`claude-categorize.ts:20-22`), not billed amounts. |
| Over-cap alert | `src/app/settings/page.tsx:93` | warn that Claude classification is paused | **dead-end** — `role=alert`, correct copy — but no "Raise cap to $X" one-click action and no link to /transactions where the blocked queue lives. It is a dead end in exactly the moment the user needs a next step. |
| Backups empty state | `src/app/settings/page.tsx:116` | explain that the first snapshot lands on next app start | **dead-end** — no "Back up now" button, even though `maybeSnapshot(sqlite, dir)` is a single call away (`boot.ts:20`). The user's only recourse is to restart the server. |
| Thresholds `<form>` (server action, no JS) | `src/app/settings/page.tsx:45` | submit all four thresholds to updateSettingsAction and revalidate /settings | **missing-state** — `updateSettingsAction` returns void (`actions.ts:16`). No pending state, no success toast, no dirty indicator, no error surface — every other mutation in the app uses the ActionResult+toast pattern (`rules-actions.ts:39`). After Save the page just re-renders identically; the user cannot tell it worked. |
| "Save settings" submit button | `src/app/settings/page.tsx:59` | persist all four thresholds | **missing-state** — plain `<button type=submit>` in a server component — no useFormStatus, no pending spinner, no disabled-while-saving. Double-click fires the action twice. Because the Inputs use `defaultValue`, any thrown Zod error also loses everything the user typed. |
| Page-level section anchors | `src/components/ui/SurfaceCard.tsx:8` | allow /settings#rules deep-links | **missing-state** — SurfaceCard accepts only children/className/style — no `id`. So TransactionSheet's "Manage →" link (`TransactionSheet.tsx:344`) drops the user at the top of the Thresholds form with no rule highlighted, no scroll, and no way back to the transaction he came from. On a phone that is a scroll past four inputs and an unbounded rule list. |
| Chevron-up IconButton (raise precedence) | `src/components/settings/RulesManager.tsx:148` | move the rule toward the top of the first-match-wins stack | **undiscoverable** — `size="sm"` renders size-6 = 24×24px (`Button.tsx:61`) — well under the 44px touch minimum, stacked vertically against a sibling chevron 24px away, on a page the owner says he views from a phone. Nothing on screen explains that "up" means "wins over the ones below it"; the only precedence explainer is one line of prose 60px higher up (`page.tsx:77`). |
| Chevron-down IconButton (lower precedence) | `src/components/settings/RulesManager.tsx:155` | move the rule down the stack | **undiscoverable** — same 24px target. Also: there is no drag handle, no keyboard reorder shortcut, and no way to jump a rule to top/bottom — with 30+ correction-born rules, moving one from position 28 to position 1 is 27 clicks and 27 server round-trips (each moveRuleAction revalidates three routes, `rules-actions.ts:29-32`). |
| Input "Price staleness (hours)" | `src/app/settings/page.tsx:50` | how long a cached quote counts as fresh before Refresh prices re-queries a provider | **confusing** — no hint explains what it governs or that only /investments "Refresh prices" reads it (`prices.ts:271`). Clearing the field coerces `""` to 0, fails `z.int().min(1)` (`actions.ts:11`) and throws — a DIFFERENT failure mode from the field directly above it, which silently accepts 0. |
| Input "Review deposits above (USD)" | `src/app/settings/page.tsx:53` | dollar size above which an inbound deposit into checking/savings is force-flagged for review | **confusing** — `step="10"` makes $225 an invalid value — the browser refuses to submit with no in-app explanation. Worse, the setting is FORWARD-ONLY: `categorize.ts:174-179` only visits rows with `category_id IS NULL`, so lowering it from $200 to $50 flags exactly zero existing transactions. Nothing on the page says so, and there is no "Re-scan with the new threshold" button. |
| Retention footnote "Backups keep 14 daily + 6 monthly" | `src/app/settings/page.tsx:68` | state the backup policy | **confusing** — reads `settings.backupRetention`, but `boot.ts:20` calls `maybeSnapshot(sqlite, dir)` with only two args, so `DEFAULT_RETENTION` (`backup.ts:20`) is what actually runs. The displayed policy and the executed policy are two different variables that happen to agree today. There is also no control to change it. |
| Rule sentence `<p>` | `src/components/settings/RulesManager.tsx:137` | render the rule as readable English | **confusing** — not clickable — there is no way to see WHICH transactions a rule matches. The seeded rule renders its raw regex verbatim: `conditionsPhrase` emits `matches /ATM\|CASH DEPOSIT/` (`rules-manager.ts:72`). That is a developer artifact in a sentence whose whole purpose is readability, and it sits on the rule that caused the app's largest data incident (the $52,625 ATM-deposit-as-Salary mislabel). |
| "Disable"/"Enable" Button | `src/components/settings/RulesManager.tsx:168` | toggle the rule out of the engine | **confusing** — state is shown three different ways at once (button verb, line-through text at `:137`, a "disabled" word at `:143`) and a disabled rule's matchCount is forced to 0 (`rules-manager.ts:161`) — so re-enabling it silently re-arms a Re-apply button whose N the user never saw. The toggle is a Button with text, not a switch role; a screen reader hears "Disable" with no state. |
| "N calls this month · $X all-time" | `src/app/settings/page.tsx:98` | volume + lifetime spend context | **confusing** — claims "Every call is logged with tokens and batch size" — true in `ai_calls` (`schema/ai.ts`) — while showing neither tokens nor batch size anywhere on this page. The sentence describes a table the UI declines to render. |
| Rules card heading + explainer | `src/app/settings/page.tsx:75` | frame the precedence model | **sensible** |
| Rule `<li>` (tabIndex=-1 focus target) | `src/components/settings/RulesManager.tsx:129` | receive focus after a move/delete re-render | **sensible** |
| Toast "Undo" action button | `src/components/ui/Toast.tsx:219` | revert a delete or a Re-apply | **sensible** |
| Toast "Dismiss" IconButton | `src/components/ui/Toast.tsx:231` | close the toast | **sensible** |

**Good**

1. The rule-as-sentence renderer is genuinely excellent product thinking. `renderRuleSentence` (`rules-manager.ts:95-101`) composes a full English sentence from conditions and actions with correct pluralization, money formatting, and category-path resolution — "When a transaction contains "NETFLIX", categorize it as Subscriptions." No competitor's rule UI reads that well. Propagate this pattern: budgets, recurring overrides and transfer links all have config that could be stated in one sentence instead of a form.
2. Delete gets a lossless Undo. `deleteRuleCapturing` (`rules-manager.ts:192`) captures conditions, actions, precedence AND timesApplied before deleting, and `restoreRule` re-creates all of it (`:207`). Most apps make rule deletion a one-way door. This is the right doctrine and `zz-rules-manager.spec.ts:41-55` pins it end-to-end.
3. Focus restoration after a list mutation. `focusAfterRef` + the `[rules]`-keyed effect (`RulesManager.tsx:31-38`) and `neighborId()` (`:69-72`) mean a delete lands focus on the surviving neighbor and a move lands focus back on the moved row. That is the kind of keyboard detail almost nobody ships; it belongs everywhere a list reorders.
4. `moveRule`'s equal-priority nudge (`rules-manager.ts:229-234`). Swapping two identical priority values would be a silent no-op; the code detects it and nudges by one instead. Correct, documented, and gap-agnostic.
5. One precedence order, enforced. `orderedRules` (`rules-manager.ts:142`) is the single ORDER BY that both listRules and moveRule consume, with the comment stating the invariant. This is exactly the discipline that prevents display/execution desync.
6. A disabled rule advertises no pending changes (`rules-manager.ts:159-161`) and `hasRowAction` (`:43-50`) correctly reports 0 for rename-only rules so the manager never promises a blast radius it cannot deliver. Honest by construction.
7. Every rules mutation revalidates the three surfaces a rule change can move — /settings, /transactions and / for the nav badge (`rules-actions.ts:29-32`). No stale badge after a rule toggle.
8. The honest empty-state copy on Backups ("crash-safe copies via SQLite's online backup API, never raw file copies", `page.tsx:117`) and the no-key copy ("the app fully works; unknown merchants queue for later", `:107`) both explain a limitation without hedging. That voice is right for this product.
9. /settings is in both gates: axe at 320/768/1024/1440 in light and dark (`a11y.spec.ts:19`) and visual baselines at all four widths in both themes (`visual.spec.ts:20`).

**Bad** (ranked)

1. **[critical] The API-key status light is presence-only and lies about the exact failure the owner already hit** — `src/app/settings/page.tsx:34,103-109`. Line 34 does `Boolean(process.env.ANTHROPIC_API_KEY)` and line 104 renders a green "ANTHROPIC_API_KEY configured". It never calls the API. With an expired/revoked/rate-limited key: Settings shows green, the user presses Classify on /transactions, `classifyPendingMerchants` (`claude-categorize.ts:126`) has try/finally but NO catch (`:148-283`), the SDK rejection propagates out of the awaited server action (`transactions/actions.ts:150`), and because there is no `error.tsx` anywhere under `src/app` the user gets a raw Next.js error screen. He then comes to Settings to diagnose it and Settings tells him the key is fine. This is the documented pass-24 incident, and this page is the reason it was hard to diagnose.
2. **[high] Clearing the AI cap field silently sets it to $0 and permanently disables Claude** — `src/app/settings/page.tsx:47` + `src/app/settings/actions.ts:10`. The input has no `required` (verified). Submitting it empty sends `""` → `z.coerce.number()` yields 0 → passes `.min(0)` → `writeSetting` stores 0. `aiSpend` then computes `overCap = monthUsd >= capUsd = 0 >= 0 = true` (`settings.ts:89`), which hard-disables the Classify button (`HeaderStrip.tsx:84`) and breaks the batch loop (`claude-categorize.ts:159-162`). The user sees "$0.00 / $0.00 cap this month" and a red alert with no explanation of what he did, and no way to distinguish "I overspent" from "I cleared a field".
3. **[high] Out-of-range and off-step values throw or are silently blocked — the form has no error path at all** — `src/app/settings/page.tsx:47,50,53,56` + `src/app/settings/actions.ts:9-22`. Three inconsistent failures from one form. (a) `aiMonthlyCapUsd` has no `max` attribute but settingsSchema caps at 1000 (`settings.ts:19`) — typing 2000 makes `formSchema.parse` throw inside a void-returning server action (`actions.ts:17`); with no `error.tsx` under `src/app` the whole route errors and every typed value is lost because the Inputs use `defaultValue`. (b) `step=` is being used as an arrow increment but the browser enforces it as validity: $225 in "Review deposits above" (step=10, line 53), 5.25 in the AI cap (step=0.5), and 0.82 in Claude confidence (step=0.05) all block submission with a native bubble and zero in-app response — the user presses Save and nothing happens. (c) Clearing "Price staleness" throws on `z.int().min(1)` while clearing the field directly above it silently succeeds.
4. **[high] "Claude confidence minimum" is a dead control that persists a value nothing reads** — `src/app/settings/page.tsx:55-57`. `classifyMerchantsAction` calls `classifyPendingMerchants(getDb())` with no options object (`src/app/transactions/actions.ts:150`), so `options.confidenceMin` is undefined and the hard-coded 0.8 at `claude-categorize.ts:141` always wins. A repo-wide grep for `categorizationConfidenceMin` returns only `settings.ts`, `seed.ts` and this page + its action (verified). Set it to 0.99 expecting everything to be flagged for review; the next Claude run flags exactly what it would have flagged at 0.8. The setting saves, persists, and re-renders — it just does nothing.
5. **[high] "would change N" never decays and "Re-apply N" counts no-op writes** — `src/services/rule-corrections.ts:216-224,244`. `retroApplyRule` sets categoryId unconditionally whenever the rule has one — it never compares to `row.categoryId` (verified by reading the loop) — so every matching row is written and pushed to `undoRows` regardless of whether anything changed. Consequence: (1) the Badge at `RulesManager.tsx:141` permanently reads "would change 300" on a rule already fully applied; (2) the toast at `:113` reports "Re-applied to 300" when zero categories actually moved; (3) `timesApplied += 300` on every press (`rule-corrections.ts:244`), so the "applied N×" history is fiction. Press Re-apply five times: the badge still says 300, the history says 1,500, and the ledger is unchanged.
6. **[high] "Re-apply N" is an unconfirmed bulk ledger mutation launched from a settings page** — `src/components/settings/RulesManager.tsx:163-167`. One click on a small secondary button rewrites categoryId, categorizationSource, categorizationConfidence and needsReview on every matching active non-user row (`rule-corrections.ts:216-224`), inside a single transaction. There is no confirmation dialog, no preview of the affected rows, and no way to inspect the match set first — the only recovery is the Undo toast. The seeded "ATM/cash deposit → Salary" rule (`seed.ts:212-216`) is the exact rule that mislabeled $52,625 of deposits as income; it sits enabled at the top of this list with a Re-apply button and no warning marker. User-set rows are protected (`excludeUserSet`, `rules-manager.ts:138`), but any future ATM deposit imported before the owner hand-fixes it is not.
7. **[high] Delete has no confirmation despite the component claiming one, at a 24px touch target on a phone** — `src/components/settings/RulesManager.tsx:171-177`. Fires `remove()` on a single click. The component's own doc comment at `:23` says every mutation ships "a lossless Undo and an accessible confirmation" — there is no confirmation anywhere in the file (verified). IconButton `size="sm"` is size-6 = 24×24px (`Button.tsx:61`), and it sits immediately beside a 24px chevron-down and a text Disable button in a `shrink-0` flex row. On the phone the owner says he will use, a thumb mis-tap between "Disable" and "Delete" destroys the rule. Undo exists and does not auto-dismiss (`Toast.tsx:161`), but it is a 12px link in a corner.
8. **[medium] Saving gives no feedback whatsoever** — `src/app/settings/page.tsx:59-64` + `src/app/settings/actions.ts:16`. `updateSettingsAction` returns `Promise<void>` and only calls revalidatePath (`actions.ts:16-29`), while every other mutation in the codebase returns ActionResult and raises a toast (`rules-actions.ts:39-48`, `accounts/actions.ts:119`, `budgets/actions.ts:61`). The Save button is a bare `<button type=submit>` with no useFormStatus, so there is no spinner, no disabled state, and no confirmation. Change the review threshold, press Save, and the page looks byte-identical afterwards. A double-click fires the action twice.
9. **[medium] Backups list hides 12 of the owner's 14 daily snapshots and offers no restore** — `src/app/settings/page.tsx:16-26,113-130`. `listBackups` sorts ascending then reverses (lines 22-23). Lexicographically `daily-…` < `monthly-…`, so reversing puts every monthly first. With the running retention of 14 daily + 6 monthly (`backup.ts:20`), `slice(0,8)` yields 6 monthlies and only the 2 newest dailies — the recovery points a user actually wants are the ones cut off. There is no restore, no download, no "Back up now", no total size, no age indicator, and no distinction drawn between daily and monthly. The card proves backups exist and gives the owner no way to use one.
10. **[medium] /settings is the most expensive page in the app, and it is the one with the least on it** — `src/services/rules-manager.ts:161` + `src/services/rule-corrections.ts:160`. `listRules` (`rules-manager.ts:146-166`) calls `previewRuleMatches` for every ENABLED rule, which calls `countRuleMatches` → `matchingRows` (`rule-corrections.ts:160-180`): a full `select … from transactions where status='active'` materialized into a JS array, then `.filter(ruleMatches)` — and `ruleMatches` compiles `new RegExp(cond.descriptionRegex, 'i')` per row (`categorize.ts:102`). On the owner's ~20k-row ledger with the two seeded rules that is 40k row objects and 20k regex compiles per page load; every rule born from a correction adds another full scan. `sentenceContext` additionally loads all categories, all accounts and all merchants (`rules-manager.ts:103-118`), and `aiSpend` scans `ai_calls` twice (`settings.ts:80-81`). On a hosted free tier this page times out before /investments does.
11. **[medium] Threshold changes are forward-only and the page never says so** — `src/app/settings/page.tsx:52-54`. `reviewCreditThresholdCents` is read at `categorize.ts:150` and applied only inside the loop over rows with `category_id IS NULL` (`categorize.ts:174-179, 261-266`). Lower it from $200 to $50 expecting a batch of deposits to appear in the review queue: zero rows are re-evaluated, the nav badge does not move, and nothing on Settings or /transactions explains why. There is no "Re-scan with the new threshold" action and no note that the value only affects future imports.
12. **[medium] The AI spend card discards the drill-down its own service already computed** — `src/app/settings/page.tsx:86-110` + `src/services/settings.ts:90-96`. `aiSpend` returns `recent[]` — the last 10 calls with createdAt, purpose, model, batchSize and estCostUsd (`settings.ts:75, 90-96`). The page renders none of it, then prints "Every call is logged with tokens and batch size" (`page.tsx:99-101`), describing data it refuses to show. The owner cannot answer "why is this month $3.40?". Worse, /transactions shows MORE about AI than Settings does: last-run classified count, needsReview count, cost, stopped/capReached flags and timestamp (`HeaderStrip.tsx:109-123`). The dedicated settings surface is strictly poorer than the incidental one.
13. **[medium] "Manage →" from a transaction lands nowhere useful — no anchor, no rule highlight, no way back** — `src/components/ui/SurfaceCard.tsx:1-6` + `src/components/transactions/TransactionSheet.tsx:344`. TransactionSheet links to bare `/settings`. SurfaceCard accepts only children/className/style so there is no `id` to target — `/settings#rules` cannot work today even if the link added it. The user arrives at the top of the Thresholds form, must scroll past four inputs, then visually scan an unbounded list of English sentences to find the rule he clicked from, with no highlight, no filter, no search box, and no back-link to the transaction. On a 375px screen that is several screenfuls.
14. **[medium] The rules list is unbounded, unsearchable and unsortable** — `src/components/settings/RulesManager.tsx:127-182`. RulesManager renders every row listRules returns with no search, no filter (enabled/disabled/has-matches), no pagination and no grouping. Rules are created one per correction via `ruleFromCorrection` (`rule-corrections.ts:104`), and the owner ran mass categorization passes — this list grows without bound. Combined with the per-rule full-table scan, adding rules makes the page both longer and quadratically slower, and moving a rule from position 30 to position 1 costs 29 clicks and 29 three-route revalidations (`rules-actions.ts:29-32`).
15. **[medium] The rules row does not survive a phone viewport** — `src/components/settings/RulesManager.tsx:135-146`. The row is `flex items-start justify-between gap-3` with a `min-w-0` text column and a `shrink-0` control cluster that contains two 24px chevrons, a "Re-apply 300" button, a "Disable" button and a 24px delete — roughly 200px of fixed width with no flex-wrap and no responsive stacking. At 375px that leaves ~130px for a sentence like "When a transaction is money in and matches /ATM|CASH DEPOSIT/ and is at least $200, categorize it as Income > Salary and set its merchant to Employer (cash)." The visual baseline at 320px (`visual.spec.ts:7,20`) was captured against two short seeded rules, so this is untested against real data.
16. **[low] listBackups can 500 the entire route** — `src/app/settings/page.tsx:16-26`. Line 25 calls `fs.statSync` inside a map with no try/catch. `prune()` (`backup.ts:102`) rmSync's expired snapshots on every boot and every maybeSnapshot call. A file removed between `readdirSync` (`:20`) and `statSync` (`:25`) throws ENOENT, and with no `error.tsx` anywhere under `src/app` the whole /settings page errors out — taking the rules manager and thresholds down with it, over a cosmetic file listing.
17. **[low] Persisted preferences the user can never see or reset** — `src/app/settings/actions.ts:38,73`. `dashboardLayout`, `viewPreferences` and `benchmarkSymbol` are all real, user-mutable, persisted settings (`settings.ts:31,39,46`) written by `saveDashboardLayoutAction` / `saveViewPreferenceAction` in this very actions.ts file and by `setBenchmarkAction` (`investments/actions.ts:129`). None appear on the Settings page. A sticky view preference on /spending or a rearranged dashboard is invisible and irreversible from here; the only recovery is to re-navigate every surface and toggle back by hand.
18. **[low] zz-wallets.spec.ts is not settings coverage** — `e2e/zz-wallets.spec.ts:9`. The spec never visits /settings — it drives /accounts, creates a cash wallet and adds a manual transaction (`:10-31`). Real /settings e2e coverage is exactly three tests in `zz-rules-manager.spec.ts` (toggle, reorder, delete+undo) plus the axe and visual gates. The Thresholds form has ZERO e2e coverage: nothing tests that Save persists, that an out-of-range value is handled, or that the AI spend card renders. The most dangerous control on the page, Re-apply, is also untested.

**Change** (ranked)

1. **Make the form fail visibly instead of throwing — convert updateSettingsAction to the ActionResult+toast pattern** *(M)* — give it a client wrapper like every other mutation (see `rules-actions.ts:39-48` and `RulesManager.tsx:46-54`): `safeParse` instead of `parse` (`actions.ts:17`), return `{ok:false, error}` with a per-field message, render it through Field's existing `error` prop (`Field.tsx:23,35-37`), keep the typed values via useState instead of defaultValue, add `useFormStatus` pending on the Save button (Button already supports `pending`, `Button.tsx:29`), and raise a "Settings saved" toast on success. Simultaneously fix the three input constraints: add `max="1000"` to aiMonthlyCapUsd to match settingsSchema (`settings.ts:19`), change `step="0.5"`/`"10"`/`"0.05"` to `step="any"` (or 0.01) so a legal value is never silently blocked, and add `required` to all four so an empty submit cannot coerce to 0.
2. **Make "would change N" truthful — skip no-op writes in retroApplyRule** *(S)* — in `rule-corrections.ts:216-224` only assign `set.categoryId` when `actions.categoryId !== row.categoryId` (and likewise merchantId at `:226`, recurringSeriesId at `:234`). The existing `if (Object.keys(set).length === 0) continue;` at `:238` then does the rest for free: affected stops counting no-ops, timesApplied stops inflating, and the Settings badge decays to 0 after a successful Re-apply. Mirror the same comparison inside matchingRows' filter (or in `previewRuleMatches`, `rules-manager.ts:132-139`) so the badge and the button agree — the invariant that countRuleMatches and retroApplyRule share one predicate (`rule-corrections.ts:154`) must be preserved.
3. **Make "Re-apply N" and "Delete" confirm, and make them thumb-sized** *(M)* — route both through a confirmation step that names the blast radius: "Re-apply will rewrite the category on N transactions. This is undoable." and "Delete "<rule name>"?". The component doc at `RulesManager.tsx:23` already promises this. Bump the IconButtons from `size="sm"` (24px, `Button.tsx:61`) to `size="md"` (32px) with a 44px hit area via padding on small viewports, and separate the destructive control from the reorder cluster instead of putting Delete 4px from chevron-down.
4. **Replace the presence check with a real API-key health check** *(M)* — add a value-returning `testClaudeKeyAction` that issues a 1-token `messages.create` against MODEL (claude-haiku-4-5-20251001, `claude-categorize.ts:18`) and returns `{ok, model, latencyMs}` or the provider's error message, rendered as a green/amber/red pill next to a "Test connection" button at `page.tsx:102-110`. Cache the last result in app_settings so a page load shows "verified 3h ago" without spending. Separately, wrap `classifyPendingMerchants`' batch loop in a catch (`claude-categorize.ts:148`) that records a failed claudeLastRun instead of letting the rejection escape the server action — that is the actual fix for the pass-24 failure, and Settings should display that failed run.
5. **Fix the backups list ordering and make the entries do something** *(M)* — split into two labeled groups (Daily / Monthly) parsed with the existing DAILY_RE and MONTHLY_RE (`backup.ts:29-30`) instead of one reversed lexicographic sort truncated at 8 (`page.tsx:22-24`) — the current ordering shows 6 monthlies and only 2 of 14 dailies. Render the date human-readably, add relative age ("today", "3 days ago"), show a total size, and wrap the statSync in try/catch so a pruned file cannot 500 the route (`page.tsx:25`). Add a "Back up now" button wired to `maybeSnapshot(getDbBundle().sqlite, defaultBackupsDir())` — one call, already imported by `boot.ts:20`.
6. **Give every threshold a hint that says what it governs and when it takes effect** *(S)* — Field already accepts a `hint` prop (`Field.tsx:23,38`) and the page passes none. Add one line each: AI cap → "Hard stop for Claude classification (`claude-categorize.ts:159`); the Classify button disables at the cap." Price staleness → "Refresh prices skips a provider call if the cached close is newer than this (`prices.ts:271`)." Review deposits → "Applies to NEWLY imported uncategorized deposits into checking/savings only — changing it does not re-scan existing transactions." That last sentence is the single highest-value string on the page.
7. **Make the rules list navigable at real scale** *(M)* — add a search box filtering on `rule.sentence`, filter chips for enabled/disabled/has-matches, and "move to top"/"move to bottom" actions alongside the chevrons (`topPriority` already exists at `rule-corrections.ts:89` for the top case). Give the SurfaceCard an `id` prop (`SurfaceCard.tsx:1-6`) so `/settings#rules` works, and change TransactionSheet's "Manage →" (`TransactionSheet.tsx:344`) to `/settings#rule-<id>` with a scroll-into-view + highlight on mount — the `data-rule-id` attribute is already on the `<li>` (`RulesManager.tsx:131`).
8. **Move the per-rule match count off the render path** *(M)* — `listRules` currently runs a full active-transactions scan per enabled rule on every page load (`rules-manager.ts:161` → `rule-corrections.ts:160`). Either (a) push the predicate into SQL — descriptionContains and accountIds/direction/amount are all expressible as WHERE clauses, leaving only regex and descriptionKey in JS; or (b) compute matchCount lazily behind a per-rule "Check matches" button using the existing value-returning action shape. Also hoist the `new RegExp` out of the per-row loop (`categorize.ts:102`) into a compiled-once map — that alone removes ~20k regex compilations per page load on the owner's ledger.
9. **Render the AI spend detail the service already returns** *(S)* — `aiSpend().recent` is 10 fully-populated call records that `page.tsx` never touches (`settings.ts:90-96`). Render them as a small table — date, purpose, model, batch size, estimated cost — under the headline, add a progress bar for monthUsd/capUsd, and label the figures "estimated from published per-MTok rates, not billed" (the constants are at `claude-categorize.ts:20-22`). Add a "Raise cap to $X" quick action inside the over-cap alert (`page.tsx:93-97`) and a link to /transactions so the alert is not a dead end.
10. **Stop advertising settings that cannot change anything** *(S)* — either wire `categorizationConfidenceMin` through — pass `{confidenceMin: readSettings(db).categorizationConfidenceMin}` at `transactions/actions.ts:150`, which is a one-line change since classifyPendingMerchants already accepts the option (`claude-categorize.ts:128,141`) — or mark the field as advisory. Same for `backupRetention`: pass it from `boot.ts:20` into maybeSnapshot's fourth parameter (`backup.ts:41`) and add the two fields to the form, or drop the retention sentence at `page.tsx:68` from claiming to reflect settings.
11. **Add an error boundary so a settings failure is recoverable** *(S)* — there is no `error.tsx` anywhere under `src/app` (verified by find). Add `src/app/settings/error.tsx` with a reset button, and ideally a root one — every throw path identified above (Zod out-of-range, ENOENT in listBackups, a settingsSchema parse failure in readSettings, `settings.ts:53`) currently takes the whole route to Next's default error screen with no recovery affordance.
12. **Cover the thresholds form and Re-apply in e2e** *(M)* — `zz-rules-manager.spec.ts` covers toggle/reorder/delete+undo; `zz-wallets.spec.ts` never visits /settings at all (`:9`). Add: save a threshold and assert it persists across a reload; submit an out-of-range cap and assert an inline error rather than an error page; press Re-apply on a rule and assert the badge decays to 0 afterwards (which will fail today — that is the point); and assert the AI spend card renders with zero ai_calls rows.

**Add** (ranked)

1. **Create and edit rules from this page** *(L)* — there is no way to author a rule anywhere in the app except by correcting a transaction (`ruleFromCorrection`, `rule-corrections.ts:104`), and no way to EDIT one at all — not the category, not the matched string, not the scope. Meanwhile `ruleConditionsSchema` supports accountIds, amountMin/MaxCents, direction and descriptionRegex, and `ruleActionsSchema` supports markTransfer, exclude, renameTo and markRecurringSeriesId (`schema/rules.ts:21-51`) — and renderRuleSentence already renders every one of them (`rules-manager.ts:63-93`). The manager can read a vocabulary it cannot write. Add a "New rule" button and an inline edit sheet that composes the full condition/action set, using the sentence renderer as a live preview above the form. `createRuleAction` already exists server-side (`transactions/actions.ts:438`) and is a partial starting point. **Why:** this is the single largest gap on the surface. The owner spent an entire pass hand-categorizing ~1,300 transactions because he could not express "every Wise transfer from dad is a Family pass-through" as a rule — he could only correct rows one at a time. A rule editor turns 24 passes of manual work into durable automation, and it is the one thing Monarch, Copilot, Lunch Money and YNAB all ship on day one.
2. **"Show the N transactions this rule matches" — a preview drill-down** *(M)* — make the "would change N" badge (`RulesManager.tsx:141`) a link or a disclosure that lists the actual matching rows, with their current category, before the user presses Re-apply. `matchingRows` (`rule-corrections.ts:160`) already returns the full row set — the service throws away everything but `.length` (`countRuleMatches`, `:189`). A `/transactions?rule=<id>` filter would work equally well and would reuse the ledger UI wholesale. **Why:** the app's stated doctrine is that every displayed number must be a visitable list. On this page a bulk mutation of the real ledger is fired blind against a count. After the ATM/Salary incident, the owner will not press Re-apply again without seeing the rows first — which means the feature is effectively unusable as shipped.
3. **Restore from a backup** *(L)* — the Backups card lists filenames and sizes (`page.tsx:121-128`) and nothing else. Add a per-row "Restore" with a hard typed confirmation, a pre-restore safety snapshot of the current file, and a summary of what the restore point contains (transaction count, latest transaction date, net worth on that date) so the user is choosing a state, not a filename. Add a "Download" too so a snapshot can leave the machine. **Why:** backups that cannot be restored from inside the app are not a backup feature, they are a directory listing. The owner runs guarded write scripts against his real DB routinely (the pass-24 ritual is backup + dry-run + delta-guard); the restore half of that ritual has never been rehearsed and lives entirely in his head. This is the highest-consequence missing button in the app.
4. **A "What the app has learned" section — the merchant map** *(L)* — there is no /merchants index route (only `src/app/merchants/[id]/`), so the entire learning layer — every merchant, its default category, its aliases, how many transactions it owns — is unreachable except by drilling into one transaction's sheet (`TransactionSheet.tsx:297`) or via the command palette, which has no visible trigger anywhere in the UI. Surface it here alongside Rules: a searchable table of merchants with default category, alias count, transaction count and last-seen date, with inline default-category editing (`setMerchantDefaultCategoryAction` already exists, `merchants/actions.ts:18`). **Why:** rules and the merchant map are the two halves of the same automation engine and precedence runs rule > merchant map (`categorize.ts:187-220`). The owner can inspect and reorder half of it and cannot see the other half at all — despite Claude having written ~434 merchant mappings into it during pass 24. He has no way to audit what Claude decided on his behalf.
5. **Data health / integrity panel** *(M)* — add a card that states, from data the services already compute: transaction count, active vs excluded vs quarantined vs superseded, categorization coverage % (CoverageStats, already rendered on /transactions), rows needing review (`review-count.ts:6`), open reconciliation gaps, accounts with no anchor in N days, `price_cache` max quotedOn vs today (the comprehension report found prices stale by 8 days while the UI labeled a move "Today"), and the DB file size and path. Each figure links to the surface that fixes it. **Why:** an investor's first question about a derived system is "how much of this is real?" Today that answer is scattered across five pages and one of the most important signals — that quotes are 8 days stale while a stat card says "Today" — is stated nowhere. Settings is the natural home for the honesty dashboard.
6. **Maintenance actions: rebuild balances, re-run categorization, refresh prices, re-detect recurring** *(M)* — every one of these already exists as a server action or service (`rebuildAllAccounts` in `derivation.ts`, `runCategorizationAction` in `transactions/actions.ts:122`, `refreshPricesAction` in `investments/actions.ts:81`, `detectNowAction` in `recurring/actions.ts:38`) but each is buried on its own page. Group them here with a last-run timestamp and a plain-English description of what each recomputes, plus a "Re-scan with the current review threshold" that closes the forward-only gap identified above. **Why:** `daily_balances` is a derived cache by doctrine — which means "rebuild the cache" is a first-class user operation, and there is currently no single place to perform it. When a number looks wrong, the owner's first instinct is Settings, and Settings offers him nothing.
7. **Appearance and display preferences** *(M)* — theme lives only as a toggle in the shell header (`AppShell.tsx:51-60`) with no persistence surface here; `dashboardLayout`, `viewPreferences` and `benchmarkSymbol` are all persisted (`settings.ts:31,39,46`) and invisible. Add an Appearance card: theme (light/dark/system), a "Reset dashboard layout" button, a "Clear sticky view preferences" button listing what is currently pinned per surface, and the benchmark symbol with its own picker. **Why:** a sticky view preference is a state the user set once and cannot see, remember, or undo. On a phone, a persisted dashboard mode from a desktop session silently changes what the first screen shows, and there is no path back except finding the original toggle.
8. **Export** *(M)* — add CSV/JSON export of transactions, categories, merchants, rules and balance anchors, plus a raw .db download. Nothing in the app currently lets data leave. **Why:** this is the owner's real financial history in a single local SQLite file with no restore path and no export. It is the lock-in question every competitor answers on their pricing page, and it is the second half of the backup story.
9. **Rule conflict and coverage diagnostics** *(M)* — since precedence is first-match-wins in ascending priority (`categorize.ts:187`), two rules can shadow each other invisibly. Add a diagnostic that flags: rules whose match set is a subset of a higher-precedence rule (permanently shadowed — the current UI shows them as active with a live match count), rules with matchCount 0 for 90 days (dead), rules whose action changes nothing on rows (`hasRowAction` false — `rules-manager.ts:43` already computes this but the UI only uses it to hide a button, never to explain why), and the ATM-style high-blast-radius rules that deserve a warning marker. **Why:** the seeded "ATM/cash deposit → Salary" rule (`seed.ts:212-216`) mislabeled $52,625 as income and took a full pass to unwind. It is still enabled, still at the top of this list, and carries no marker distinguishing it from a rule the owner wrote deliberately. The manager shows precedence but never shows consequence.
10. **Claude run history and live run state** *(S)* — `claudeRunStartedAt`, `claudeStopRequested` and `claudeLastRun` are real app_settings keys (`claude-categorize.ts:50-52`) surfaced only on /transactions (`HeaderStrip.tsx:103-123`). Show them here: whether a run is live, when it started, whether the last run stopped early or hit the cap, how many rows it classified and flagged, and — critically — whether it FAILED (which requires the catch proposed in CHANGE, since today a failure records nothing at all). **Why:** when the Claude button "was failing" in pass 24 there was no record anywhere of the attempt, the error, or the cost. Settings is where a user goes to find out why an automated system is not running, and it is currently silent about every run the app has ever made.
11. **Per-setting "what this affects" provenance links** *(S)* — next to each threshold, link the surfaces that consume it: AI cap → /transactions (the Classify button it gates); price staleness → /investments (Refresh prices); review threshold → `/transactions?view=review` (the queue it feeds). The page currently contains zero outbound links to anywhere in the app. **Why:** a settings page with no links out is a dead end by construction. Every knob here changes behavior somewhere else, and the user has to already know where.


---

<div id="sec-08"></div>

> **▼ SECTION 08 — The backlog — execution order**

# 08 — The backlog

One list. Most valuable first. **Execution follows this order.**

Value = (does it stop a wrong number or a data loss) × (does it happen on the owner's real data)
÷ effort, with a thumb on the scale for his stated goals: the phone is the primary device, it will
be hosted, and it must be beautiful and highly interactive.

- **Tags** — `[correctness]` truth or data safety · `[clarity]` the number is right, the screen isn't ·
  `[craft]` how it feels: perf, motion, touch, a11y · `[consistency]` one app not twelve ·
  `[feature]` net-new capability.
- **Size** — **S** ≤ half a day · **M** 1–3 days · **L** ≥ 3 days.
- Every item names the files it touches. `Blocked by:` means do the other one first or you will do
  the work twice.
- Cross-references: `#n` = defect register rank in `04-what-is-bad.md`; `C/L/K/S n` = row in
  `05-what-to-change.md`; `ADD n` = row in `06-what-to-add.md`.

---

## Phase 1 — Stop the bleeding (one week, and everything after it becomes safe to iterate on)

1. **[craft] (S) Gate `Popover`'s children on `open`.** One line: `{open && children}` in
   `src/components/ui/Popover.tsx:134`. The correct pattern is already written at
   `src/components/ui/CommandPalette.tsx:141`. Measured payoff on the real DB: `/transactions` drops
   from **4,647,518 bytes / 32,557 DOM nodes / 3,650 `role=option`** to roughly 259 KB and ~1,520
   nodes; it fixes 10 `CategoryPicker` sites plus `Menu`, `BudgetAmountEditor`, `BudgetRow`,
   `SeriesMembership` and three `CadenceSentence` editors at once. *Best effort-to-payoff item in the
   entire audit.* (#17, #B10, K1)

2. **[correctness] (S) Add the error/loading/not-found boundary layer.** Create
   `src/app/error.tsx`, `global-error.tsx`, `not-found.tsx`, `loading.tsx`, plus per-route
   `error.tsx` for `/accounts/[id]`, `/transactions`, `/imports`, `/settings`. Today a mistyped
   balance replaces the whole document with a Next error digest and loses every other field —
   confirmed live twice. `find src/app -name error.tsx` currently returns nothing. (#16, C1)

3. **[correctness] (S) Make `readSettings` fall back to `DEFAULT_SETTINGS`.**
   `src/services/settings.ts:50-54` runs a strict `.parse()` and is called unguarded from seven
   routes. (#16, C2) *Note: the "one bad view preference blacks out the app" claim was falsified —
   those two fields are already `.default()`-guarded. This is still correct-by-construction hygiene
   and costs one line.*

4. **[correctness] (M) Convert the 18 `Promise<void>` server actions to `ActionResult<T>` +
   `safeParse` + toast.** `accounts/actions.ts:31,57,72,84,94` · `investments/actions.ts:33,47` ·
   `settings/actions.ts:17` · `budgets/actions.ts:90` · `imports/actions.ts:19,23,30` ·
   `recurring/actions.ts:38,49`. The contract already exists at
   `src/app/transactions/action-types.ts:9` and `ui/Field.tsx:25` already ships an unused `error`
   slot passed at 0 of 42 call sites. (#16, C10) *Blocked by: nothing, but item 2 makes it safe to
   land incrementally.*

5. **[correctness] (M) One `useAction()` hook, and a `.catch` on every action call site.**
   New `src/hooks/useAction.ts` modelled on the sequence-guarded `hooks/useInlineEdit.ts:71-102`:
   pending in a `finally`, a `catch` that surfaces the server message, a stale-response guard.
   Then migrate the ~47 unguarded `.then(` sites (measured: 52 `.then(` vs 5 `.catch(` across
   `src/components` + `src/hooks`, all five catches in `LinkPanels.tsx`). (#3, C8, ADD 21)

6. **[correctness] (S) Make Undo verifiable.** Add the `else`/`catch` branch at
   `src/components/transactions/undo-toast.ts:22-26`, and stop `src/components/ui/Toast.tsx:223-226`
   dismissing the toast synchronously before `onAction()` resolves — the patch currently leaves
   client memory before the request settles. Same missing branch at `RulesManager.tsx:93`,
   `SeriesMembership.tsx:46`, `SplitEditor.tsx:70`. (#3, C9) *Blocked by: 5 (use the hook).*

7. **[correctness] (M) A `<Confirm>` primitive with a blast radius in money, on the eight
   irreversible actions.** The best destructive-action design in the codebase already exists and was
   never reused: the re-derive gate at `EditAccountSheet.tsx:150-155,199-214` (live region, plain
   English consequence, checkbox that resets). Adopt at: un-import (`imports/page.tsx:198` — "deletes
   2,149 transactions, 312 categorized by you"), accept gap, delete anchor
   (`accounts/[id]/page.tsx:246` — "turns 143 days from derived to gap"), archive account (`:272` —
   "net worth will read $11,020.45 higher"), delete rule, deactivate budget, end/dismiss series,
   merge series, and "Select all N" in `BulkActionBar.tsx:68-76`. (#1, #14, L13, ADD 20)

8. **[correctness] (M) Snapshot before every irreversible mutation.** New
   `withPreMutationSnapshot()` in `src/db/backup.ts` reusing the tmp+rename mechanism at `:63-78`;
   wrap `unimportFile` (`import/service.ts:962`), `acceptGap` (`:990`), `deleteAnchor`
   (`anchors.ts:60`), the `addManualAnchor` conflict branch (`anchors.ts:40`),
   `deleteManualTransaction` (`manual-transactions.ts:267`), `mergeSeries`
   (`recurring-links.ts:168`), `retroApplyRule` (`rule-corrections.ts:203`), and `bulkApplyByFilter`
   above a threshold (`bulk-edit.ts:187`). Snapshot cost on a 12.8 MB DB is milliseconds. (#1, #4,
   C28) *Blocked by: 7 (the confirm dialog is where you offer it).*

9. **[feature] (M) Restore from a backup, from inside the app.** `src/app/settings/page.tsx:113-130`
   lists filenames and can do nothing with them. Add per-row Restore behind a typed confirmation, a
   pre-restore safety snapshot, Download, "Back up now", and a per-snapshot summary (txn count,
   latest txn date, net worth that day) so he picks a state not a filename. Also fix the sort —
   `.sort().reverse()` puts every `monthly-*` before every `daily-*`, so `slice(0,8)` hides 12 of 14
   dailies — guard the `statSync` inside the `.map`, list the `pre-*` files and `-wal`/`-shm`
   siblings the directory actually holds (**80 files / 505 MB** vs UI copy "14 daily + 6 monthly"),
   and say which files retention governs. (#4, #91, C13, ADD 3)

10. **[correctness] (L) Preserve user attributes across re-parse and un-import.**
    `import/service.ts:396-405, 525, 548, 772-786`. Two independent bugs: `supersedeFileContribution`
    marks the `importFiles` row superseded so `coveredRanges` drops it from the ownership map, AND
    the takeover branch is gated on a *strictly lower* fidelity source so a same-format re-parse can
    never take over anyway. `migrateSplits` is imported and unreachable. `docs/schema.md:91-93`
    promises the opposite in writing and there is **zero** test coverage — add a test asserting a
    hand-categorized, noted, split row survives a parser-version bump. (#2, C27)

11. **[correctness] (M) One meaning for "Transfer".** `bulk-edit.ts:168-173` and `:285-292` set only
    `transferGroupId`; make them stamp the Transfers-kind category exactly as
    `transfer-links.ts:110-121` already does. **Do not** make analytics exclude on `transferGroupId`
    — a self-group has no counterparty and excluding it would hide a real outflow, which is precisely
    what the two-sided-evidence doctrine exists to prevent. Then extract the stale-leg cleanup at
    `transfer-links.ts:107-110` and call it from `import/service.ts:985` and
    `manual-transactions.ts:273`. (#5, C6, C25)

12. **[correctness] (M) Give the derived cache an invalidation it cannot forget.** Export
    `REPLAY_STATUSES` from `derivation.ts` and assert against it; rebuild after the two paths that
    change replay membership — the **quarantined → active** transition in `bulk-edit.ts:164-167` and
    `upsertHolding` in `holdings.ts:151`. Give `rebuildAllAccounts` (`derivation.ts:260`, currently
    **zero callers anywhere**) a callable home in /settings as "Rebuild derived balances". (#6, C22)

13. **[correctness] (S) Filter `upcomingOccurrences` and `forecast.fixedComponents` by
    `isSeriesActive`.** `recurring.ts:719-723` and `forecast.ts:126-130`; `recurring-calendar.ts:155`
    already does it and says why in a comment. On the real DB "Acme Corp (payroll)" — last matched 80
    days ago, biweekly — projects **+$5,886 of phantom income** into the 30-day window and flips the
    Forecast card's sign. Show the exclusions in a collapsed footer rather than hiding them. (#8,
    #B17, C15)

14. **[correctness] (S) One "next expected" date.** `listSeries` renders the stored
    `nextExpectedOn` verbatim (`recurring.ts:576, 642-651`) while the forecast rolls it forward via
    `projectOccurrences` (`forecast.ts:126-152`). Three series currently display a date in the past
    as "Next" — including `UBER *ONE` at 13 months stale, sitting in Suggestions at **100%
    confidence** asking to be confirmed. One line. (#85)

15. **[correctness] (M) Make the FiltersBar preserve every filter the URL supports.**
    `components/transactions/FiltersBar.tsx:27-32,45-52` — add hidden inputs for `merchant`, `flow`,
    `amountMin`, `amountMax`, include them in `hasActiveFilters` so a chip and Reset render, and
    populate the Category select from the full tree plus the `uncategorized|spending|income`
    sentinels so it stops displaying "All categories" while the ledger is filtered. Every drill-down
    in the app lands here. (#11, C21)

16. **[correctness] (S) Honour `startsOn` in budget status math.** `services/budgets.ts:160-165` —
    clamp to `max(bounds.start, b.startsOn)` and carry a `partialPeriod` flag the row can caption.
    Today a $50 Travel budget created this morning opens at "Over budget by 4798%", and the Predict
    sheet promises "a forecast of your **August** spending" then grades it against July. (#15, C14)

17. **[correctness] (S) Fix the dead merchant drill-downs.** `services/spending.ts:685-687` builds
    the unlinked-group href as a full-text `q` search for a *derived* string, while the ledger's `q`
    is a literal `LIKE` against raw/normalized description. **Measured: 330 of 627 groups (52.6%) open
    an empty ledger — $34,403.46 unreachable**, including his largest merchant-less payee.
    Correct fix: a first-class `descriptionKey` filter on `TxnFilters` that recomputes
    `strippedDescriptionKey` server-side — `review-inbox.ts:25-27` already does exactly this. The
    20-minute version: link with the longest literal token run. **Invisible on the demo DB, so no
    test can catch it today.** (#79)

18. **[correctness] (S) Close the two AI-path `source='user'` holes and stop the merchant-default
    contradiction.** Add `or(isNull(source), ne(source,'user'))` to the UPDATEs at
    `claude-categorize.ts:264-270` and `merchants.ts:115-122`, unified behind one exported
    `notUserOwned()` replacing four hand-written copies. Separately, `claude-categorize.ts:233-249`
    correctly refuses to overwrite a user-set merchant *default* and then stamps Claude's category on
    the transactions anyway — that is the live half. **Do not touch the rules path**: it is already
    clean (`{excludeUserSet:true}` + identical preview predicate) and is load-bearing over 2,515
    user-sourced rows. (#13, #40, C23)

19. **[correctness] (S) Catch the Claude run, and stop reporting a failure as a success.**
    `claude-categorize.ts:148` has `try`/`finally` and **no catch**, so a rejection escapes the
    server action; the `finally` then writes `claudeLastRun` from a half-populated `{ran:true}`
    object. Add a `failed` state to the run model. Gate `/transactions`' HeaderStrip button on the
    same `Boolean(process.env.ANTHROPIC_API_KEY)` `/settings:34` already computes, and label it
    "present" not "configured". Also: copy/symlink `.env` into git worktrees — **that is the actual
    root cause of the owner's open "the Claude button stopped working" bug**, not an expired key.
    (#26, #90, C24)

20. **[correctness] (S) Bound every date input and floor `deriveDailyRows`.** No date input in the
    app has a `max` and no schema bounds the year (`AnchorForm.tsx:17`, `CashWallets.tsx:164,272`,
    `HoldingForm.tsx:74`, `anchors.ts:17`, `manual-transactions.ts:27,177`, `holdings.ts:79`). A
    fat-fingered year makes `deriveCashSpans` (`derivation.ts:127-158`) emit one row per day between
    endpoints and `rebuildAccount:250-257` insert them one `.run()` at a time. A typed cap in the
    pure function protects every future caller including scripts. (#29, C26)

21. **[correctness] (S) Fix `retroApplyRule`'s no-op writes.** `rule-corrections.ts:216-234` assigns
    `set.categoryId` unconditionally, so the existing `if (Object.keys(set).length === 0) continue`
    guard at `:238` is never reached: the blast-radius badge never decays, `timesApplied` inflates,
    and "Re-applied to 300" is reported when zero categories moved. Guard each assignment on `!==`
    current value. (#40, C3)

22. **[correctness] (S) Clamp `filters.page` and fix the page-boundary day totals.** Clamp to
    `[1, pageCount]` in `components/transactions/query.ts:58` — live today,
    `?page=99999` returns 200 with "Page 99999 of 194 · 9688 transactions", the *filter* empty state
    and a working Previous. And compute `groupByDay` (`TransactionsLedger.tsx:65-82`) server-side over
    the full filtered set, or label the straddling group "partial — continues on next page". (#61,
    #B12, C5, C12)

23. **[correctness] (S) Stop the four remaining silent no-ops and the sign bugs.**
    `PeriodSelector.applyCustom:85-91` (returns with no navigation and no error while the button
    stays primary) · `ScrubChart.applyWindow:398-404` (silent bail on the <2-point rule — reuse the
    string `ScrubTable.tsx:147-149` already writes) · `CadenceSentence.commit:263-271` (`close()`
    outside the try/catch destroys the draft on a parse error; `InlineEditableText.tsx:74-78` does it
    right) · `formatCentsSigned` returning `+$0.00` (`lib/money.ts:80-83`, ~39 render sites). (#54,
    #76, C4, C19, C20)

---

## Phase 2 — Make it fast enough to host and to hold in one hand

24. **[craft] (M) Wrap the four hot service functions in React `cache()`.** Zero uses of `cache()`
    exist in `src/`. Targets: `analytics.activeTxnsInRange`, `analytics.loadCategoryIndex`,
    `in-flight.transferFloats` (the dashboard computes it **twice at 439ms each** —
    `dashboard.ts:117` and `dashboard-series.ts:77`), `portfolio.buildPortfolio` +
    `portfolioRealizedPl` (/investments builds them 4× and 5× per render). Behaviour-preserving, and
    doctrine-safe: it memoizes reads within one request, it does not persist anything derived.
    (#20, K16, ADD 34)

25. **[craft] (M) Lazy-load recharts behind one shared `next/dynamic` chunk.** There is no
    `next/dynamic` anywhere in the repo and recharts is emitted as **five** 380,657-byte chunks with
    zero cross-route cache reuse. Entry points: `ScrubChart.tsx:12`, `AllocationDonut`,
    `AmountHistoryChart`, `CashFlowChart`, `CashFlowGraph`. Measured −107 KB gz off /, /spending and
    /investments, and ~215 KB gz saved per session from de-duplication. The `loading` slot also gives
    charts the skeleton they don't have. (#19, K15)

26. **[craft] (M) Kill the two N+1s and the two page-load scans that grow with usage.**
    `portfolio.ts:864` does a single-row `price_cache` lookup per holding_event (119 → ~31
    statements measured on a 6-event DB; the owner has 1,991 events × 4 calls) — replace with one
    grouped query plus the binary search already written at `holding-detail.ts:233-248`.
    `manual-transactions.ts:63-97` runs 4–5 queries per account (/accounts 28 → ~8).
    `rules-manager.ts:161` runs a full active-transaction scan **per enabled rule** with a
    `new RegExp` compile per row. `categorize.ts:739-744` materializes every active row for two
    integers. (#20, K17, K19)

27. **[craft] (S) Stop /recurring computing all four tabs on every render.**
    `recurring/page.tsx:32-35` — `forecastCurrentMonth` alone measures 102–112ms, the app's most
    expensive per-row call, and one tab is rendered. Also give `listSeries` a `GROUP BY` count
    instead of loading every active row into JS (`recurring.ts:551-560`). Same class:
    `budgets/page.tsx:51-53` computes `budgetGuidanceCents` for every budget (82.3ms of ~159ms) to
    fill a hover popover, and `recurring-detail.ts:217-228` selects every live series as merge
    candidates whether or not the popover opens. (#77, K18)

28. **[craft] (S) Fix the six measured horizontal overflows.** Add `minmax(0,1fr)` /`min-w-0` at
    `page.tsx:217`, `investments/page.tsx:181`, `spending/page.tsx:214,240`,
    `categories/[id]/page.tsx:179`, `settings/page.tsx:84`, and on the `DataTable` wrapper itself
    (`ui/DataTable.tsx:175`) so every future consumer is protected. `grep "minmax(0" src` currently
    returns **exactly one hit**, at `lg:` only. Then make `ViewSwitcher.tsx:25` and
    `transactions/ViewTabs.tsx:23` wrap or scroll instead of escaping their card — today the
    dashboard's 6-option dimension (including Flow/Sankey) is literally unreachable on a phone.
    (#22, K2, K3)

29. **[craft] (S) Replace `touch-none` with `touch-pan-y` on the chart plot.**
    `ScrubChart.tsx:545` — a measured 208–256px dead band, 25–30% of the phone viewport, on four
    routes, for a drag gesture with no touch equivalent. Delete it from
    `ManagedAccounts.tsx:104`, whose HTML5 `dragstart` cannot fire from touch anyway. Pointer capture
    at `:417` still wins an intentional horizontal drag. (#53, K5)

30. **[craft] (S) Give `Button`/`IconButton` a coarse-pointer floor, and normalize the destructive
    clusters.** `ui/Button.tsx:19-21` and `:60-63` — add an `lg` size plus
    `pointer-coarse:min-h-11 min-w-11`; same for `ViewSwitcher.tsx:35` and `ChartRangePills.tsx:42`.
    ~6 lines moves the measured under-44px count from 709/1470 with zero call-site changes. Then fix
    the two clusters where an irreversible action is a sub-24px target beside a benign one:
    `RulesManager.tsx:148-177` and `BudgetRow.tsx:193-207`, and give the padding-less 14×14 reorder
    chevrons at `ManagedAccounts.tsx:114-131` a real hit area. (#24, K4, K33)

31. **[craft] (S) Wire the pending flags that are already computed.** `ViewSwitcher`'s `disabled`
    prop exists and is passed by 0 of 11 consumers; six `useViewState` consumers destructure
    `isPending` and throw it away (`CashFlowView.tsx:37`, `DashboardChartSection.tsx:90`,
    `BalanceChartPanel.tsx:87`, `SeriesDetail.tsx:65`, `HoldingChartPanel.tsx:98`,
    `PortfolioChartPanel.tsx:93`); 14 of 21 `useTransition` sites are `const [, startTransition]`.
    Then give every `<form action>` a pending submit via `useFormStatus` (**zero** usages today),
    starting with `imports/page.tsx:96` — a 30-second import that looks frozen and can be
    double-submitted into two 100 MB in-memory batches. (#18, K8, K9) *Blocked by: 33 (do it once,
    on the shared `Button`).*

32. **[craft] (S) Add the two missing `pointer-coarse:opacity-100`.** `ui/StatCard.tsx:45` and
    `ui/InlineEditableText.tsx:123` — `DataTable.tsx:65` already does it. Two words restore the
    drill-through signal on every stat card and the rename affordance on all four entity detail
    pages, on the device with no hover. (#71, K6)

---

## Phase 3 — Make it one app (the visible quality jump)

33. **[consistency] (M) Retire the 16 hand-rolled primary buttons onto `Button`.**
    `settings/page.tsx:61` · `imports/page.tsx:97` · `PeriodSelector.tsx:194` · `ReviewInbox.tsx:251`
    · `HeaderStrip.tsx:63` · `AnchorForm.tsx:26` · `AccountForm.tsx:62` · `BudgetForm.tsx:32` ·
    `PredictBudgets.tsx:101` · `SeriesDetail.tsx:146` · `CadenceSentence.tsx:235,320` ·
    `AllSeriesView.tsx:80` · `SeriesMembership.tsx:233,320` · `HoldingForm.tsx:79`. Eight geometries
    collapse to one; `pending`, `disabled:` and `active:` come free, closing "no pending state /
    double-submit / silent save" — filed as five separate bugs by five separate route audits. Add
    `active:` to the three variants that lack one. (#45, S5)

34. **[consistency] (S) Ship a type scale and apply it to headings first.** Add
    `--text-eyebrow/-body/-section/-title/-hero` to `globals.css` (which today defines **zero**
    typography and spacing tokens, in violation of the project's own web rule), then replace the
    **39** `<h2 className="text-sm font-medium">` section headings that are byte-identical to body
    copy. One mechanical pass gives every surface a visible three-level hierarchy for the first time;
    the dashboard hero already proves the proportions. (#44, S1)

35. **[consistency] (M) Migrate the 119 hardcoded sub-12px sizes onto the scale.** 102× `text-[11px]`,
    15× `text-[10px]`, 2× `text-[9px]` across 58 files. Worst: `SpendHeatmap.tsx:157` (10px money in a
    44px cell), `ForecastCard.tsx:84`, `AllSeriesView.tsx`, `PortfolioStats.tsx`. After this, raising
    the phone floor is a one-line token change. (#44, S3) *Blocked by: 34.*

36. **[craft] (S) Add `--shadow-card` as a theme-aware token.** `globals.css` beside
    `--shadow-overlay`, replacing the hardcoded `oklch(0% 0 0/0.04)` literal at `SurfaceCard.tsx:12`,
    `HeaderStrip.tsx:40`, `InstitutionCard.tsx:98`, `ManagedAccounts.tsx:71`. On a 0.19-lightness dark
    background a 4%-black shadow is arithmetically invisible, so dark mode currently has **no
    elevation model at all**. Add `--shadow-card-hover` for the drill-down lift the app lacks. (#46, S4)

37. **[consistency] (M) Make the period a first-class param carried on every cross-surface link.**
    One `periodParams()` in `lib/period.ts`, applied at `SpendingCategoriesTable.tsx:105,154` ·
    `BudgetRow.tsx:77` · `categories/[id]/page.tsx:95,186` · `SeriesDetail.tsx:134` ·
    `MonthlyTrendBars.tsx:21`; accepted on /budgets (`page.tsx:46`), /merchants/[id] and /accounts.
    `resolvePeriod` has exactly **two** route callers today. Then delete the `?period=2026`
    workarounds from `e2e/zz-spending-categorize.spec.ts:21` and `e2e/a11y.spec.ts:56` and let the
    specs assert the carry instead. (#9, S7)

38. **[consistency] (M) Route the remaining local state through the existing view-state system.**
    `lib/view-state.ts` + `useViewState.ts` already implement URL > persisted > default with only
    non-defaults in the URL. Migrate: `ChartFocus.tsx:67` (range), `SankeyChart.tsx:82`,
    `spending/page.tsx:220` (heatmap month — also deletes the `key={heatMonth}` remount hack),
    `RecurringCalendar.tsx:66`, the dashboard brushed window into `DashboardWindowProvider`,
    `PortfolioHoldingsTable.tsx:38-39`, `TopMovers.tsx:13`, and the open transaction sheet
    (`TransactionsLedger.tsx:109` → `?txn=`). Honour the append-only invariant at
    `chart-lens.ts:17-19`. (#33, S8, ADD 29)

39. **[consistency] (M) Retire the four raw `<table>`s onto `DataTable`.** `imports/page.tsx:168`
    (88 rows — gains sort, row links, caption, empty state), `accounts/[id]/page.tsx:227`,
    `AllSeriesView.tsx:114` (31 series — gains sort-by-annualized, the most-wanted affordance on that
    surface), `ForecastCard.tsx:80` (the only table in the app with **no** overflow wrapper at all).
    `DataTable` already has `aria-sort`, `rowHref` overlays and controlled URL sort state. (#72, S6, K27)

40. **[consistency] (S) Extract one `revalidateFor(kind)` map.** 87 `revalidatePath` calls across 8
    action files, hand-rolled and wrong in both directions. Measured holes: `recurring/actions.ts:33`
    (missing `/`, /budgets, /spending) · `budgets/actions.ts:98` (missing /categories/[id]) ·
    `merchants/actions.ts:41` (missing `/`, /budgets, while the identical mutation from the ledger
    revalidates `/`). `imports/actions.ts:7` already has the right idea. (#37, S9)

41. **[consistency] (M) One month-pager, one tolerance, one budget vocabulary.** Extract
    `useMonthPager` from the correct implementation (`PnlCalendar.tsx:44-69` — latest-request guard,
    `isPending`, negative toast) and adopt in `RecurringCalendar.tsx:70-76` and
    `SpendHeatmap.tsx:54-61` (which drops `!res.ok` entirely); bound all three and render "No
    activity in {month}". Export `classifyPostedAmount` (`recurring-calendar.ts:66-79`) and use it in
    `AmountHistoryChart.tsx:45` so "on plan" stops meaning two different things on two tabs of the
    same series. Reconcile `pace` vs `alert` (`budgets.ts:196,446`) so a budget is not green on
    /budgets and amber on /categories/[id], and make `categoryBudgetRef` return **all** of a
    category's budgets instead of `.find()`'s first. (#47, #55, #60, S11, S14, S15)

42. **[consistency] (S) Fix the detail-route identity layer.** `generateMetadata` on
    `/merchants/[id]`, `/investments/[t]/[s]` and `/categories/[id]` (three open tabs currently read
    "Merchant", "Holding", "Category"); use the shared `ui/Breadcrumbs` instead of
    `categories/[id]/page.tsx:94-106`'s hand-rolled nav; add `?from=` so `/merchants/[id]` stops
    claiming Transactions is always its parent and `/recurring/[id]`'s footer stops saying "All
    recurring" while linking to the Upcoming tab. Route palette categories to `/categories/[id]`
    (`command-index.ts:66` — the comment says "until Stage 3 lands"; it landed) and update
    `command-index.test.ts:48`, which currently pins the stale behaviour. (#56, #73, S13, S16)

---

## Phase 4 — Say what the numbers mean (this is where the product gets good)

43. **[clarity] (M) One `<AsOf day basis />` component, used everywhere a money figure appears.**
    Every value already exists and is discarded: `dashboard.ts:131`, `institution-groups.ts:169-170`,
    `derivation.ts:378-383` (both loaded and dropped by `ManagedAccounts.tsx:160-167`),
    `holding-detail.ts:298-301`, `portfolio.ts:536`. Then kill the four "today" lies —
    `InvestmentsTeaser.tsx:55`, `InstitutionCard.tsx:28`, `PositionCard.tsx:50`,
    `accounts/[id]/page.tsx:152` — and the dead ternary at `PortfolioStats.tsx:27`
    (`Today{overview.dayChangeVsDay ? "" : ""}`). Name the real comparison day. (#7, L1, L2)

44. **[clarity] (M) Report what the three bulk engines actually did.** `imports/actions.ts:19`
    discards a fully-populated `FileOutcome[]` with six counters *and* the only message that says
    partial rows were committed; `transactions/actions.ts:128-129` discards `categorizeAll` +
    `detectTransfers` stats; `recurring/actions.ts:38-41` discards `DetectionSummary`. Today a batch
    where every row was `skippedOwned` is pixel-identical to one that inserted 2,000 rows — and four
    files on the real DB imported **zero** transactions while the page reports "Open gaps 0". Badge
    `Txns 0` as a failure, exclude it from "Reconciled periods". (#36, #88, L3)

45. **[clarity] (M) Migrate the honesty vocabulary from `title=` to the built-and-unused `Tooltip`.**
    `ui/Tooltip.tsx` has **zero importers** and is complete (300ms hover intent, focus-visible,
    Escape, `aria-describedby`, `popover="manual"`). 35 `title=` sites carry the differentiating copy.
    Priority: `PortfolioStats.tsx:35,68,113` · `RealizedSalesList.tsx:51,60` · `PredictBudgets.tsx:178`
    · `PositionCard.tsx:67,72,75` · `PortfolioHoldingsTable.tsx:61,74,90` · `SpendingCategoriesTable.tsx:132`
    · `CashFlowChart.tsx:126`. Special case: `imports/page.tsx:186` puts the entire parser error string
    in a `title` — make that an expandable row, because it is the only place a failed import's cause
    is shown anywhere in the app. (#23, L10)

46. **[clarity] (S) State the GROSS / NET / uncategorized reconciliation on /spending.**
    `spending/page.tsx:88-97` — three denominators on one screen and the comment at `:91-94` still
    calls the gross total "the NET total". Every component is already loaded. Then make the
    `category=spending|income` predicate split-aware (`transactions-query.ts:58-81`) to match the
    named-category branch 12 lines below, so the Spent card's own drill-down stops over-counting split
    rows. (#10, L5, C7)

47. **[clarity] (M) Render the coverage the series already carries.** A ribbon under every balance
    chart: `coveredAccounts/totalAccounts/missingAccounts` per point, grey where partial, and a scrub
    tooltip reading "4 of 9 accounts". **87% of the hero curve is a partial sum and only the last
    point's flag is read** (`dashboard.ts:133`); for the first 402 days the line is drawn from **one
    account of nine**. Same fix stops `accountSeries:361` filtering gap days out of existence and then
    drawing a straight line across them on a categorical axis — keep the gap rows and render them.
    (#30, #82, ADD-blind-spots 4)

48. **[clarity] (M) Persist and render a review *reason* per row and per cluster.** Four independent
    producers write one boolean: `categorize.ts:261-266` (large deposit), `categorize.ts:631-644`
    (ambiguous transfer), `claude-categorize.ts` (low confidence), `import/service.ts:891-894`
    (suspected **duplicate** — which changes net worth, not categorization, and must not be clearable
    by the same "Confirm all" as a confidence wobble). Render on `ReviewInbox.tsx:186-209` and the
    ledger dot; the empty-state copy at `transactions/page.tsx:54-56` names only three of the four.
    Add a persisted `reviewDismissedAt` so detector pass 2 stops re-flagging rows the owner already
    cleared. And design the **empty** state — measured `needsReviewCount = 0` on the real DB, so that
    is the state he lives in, and it currently gets one sentence and no next action. (#25, L14, C31)

49. **[clarity] (M) Surface categorization provenance.** Add `categorizationSource` to
    `transactions/page.tsx:95-111` and `services/ledger-rows.ts:42-68`; render a source glyph on the
    row and a "Why this category" line in the sheet reusing the `suggestionReason` copy pattern at
    `TransactionSheet.tsx:32-36`. It is populated on 9,522 of 9,753 real rows and rendered nowhere,
    in an app whose pitch is auditability. (#27, L15, ADD 30)

50. **[clarity] (S) Render the numbers the pages already compute and discard.** Nine of them:
    `pace.points[].idealCents` as a third faint line so "Free to spend" can answer ahead/behind (and
    give it a negative branch — it renders "≈ −$4,538.72" today with no copy or colour for that
    case); `upcoming.netCents` as the strip headline and `beforePaycheck` even when 0;
    `accountName` on all three dashboard lists; the six SeriesDetail evidence fields
    (`recurring-detail.ts:247-252` — `lastMatchedOn`, `intervalDaysAvg`, `toleranceDays`,
    `amountCentsAvg`, `amountCentsStddev`, `detectedNextExpectedOn`), which is what makes "Confidence
    18%" falsifiable; `costCents` and `latestClose` on the holding page, so "Total return +$1,204"
    finally has a visible denominator; the 6-month `budgetGuidanceCents` delta on each budget row —
    which instantly surfaces that **8 of 10 budgets are >15% off their own actuals**; `txnCount` per
    category row; and the amount on the Excluded honesty bucket. (#58, #34, L4, L6, L7, L22, L23,
    L24, L21, #B18)

51. **[clarity] (S) Add an `action` slot to `EmptyState` and fill all nine dead ends.**
    `ui/EmptyState.tsx:3-6` is `{title, description}` with no children and no href. Sites:
    `transactions/page.tsx:199,217` · `imports/page.tsx:158` · `budgets/page.tsx:81` ·
    `recurring/page.tsx:65` · `spending/page.tsx:194` · `ReviewInbox.tsx:124` · `AllSeriesView.tsx:22`
    · the dashboard first-run cards (`page.tsx:124`, **zero interactive elements on the entire
    first-run screen**). Also derive "no accounts" from `listAccounts`, not from the last
    daily_balances point — today a user with five saved accounts is told "No accounts yet". (#39, L11)

52. **[clarity] (S) Give the twelve `&&`-gated sections an else branch.** Two are functional bugs, not
    cosmetics: `accounts/[id]/page.tsx:195` hides the "All transactions →" escape hatch exactly when
    an account has no *active* rows (confirmed live on Robinhood Crypto), and `page.tsx:188` renders
    blank space instead of ScrubChart's own "not enough history" copy. (#38, L12)

53. **[clarity] (S) Make the drill-down contract hold on the numbers that matter most.** The budget
    Spent figure (`BudgetRow.tsx:170-173` — `analytics.transactionsHref` already emits the exact URL),
    /budgets' missing page total (budgeted $6,799.00 vs actual $5,670.51, computed ten times and never
    summed), the dashboard's Assets/Liabilities and coverage warning, `PeriodActivityPanel.tsx:122`'s
    inert top-category chips, and /spending's Net + Savings-rate cards, which both open the identical
    whole-period list. Also scope the top-merchant href to the category on /categories/[id]
    (`spending.ts:679-681`). (#65, C36)

54. **[craft] (S) Add a route announcer and a focus anchor to the shell.** New
    `shell/RouteAnnouncer.tsx` mounted in `AppShell.tsx`; `#main` already carries `tabIndex={-1}` and
    `outline-none` at `:62-66` for exactly this. One component fixes silent navigation on all 15
    routes. While there: fix the two `aria-label`-on-a-`<span>` sites
    (`TransactionsLedger.tsx:300`, `RecentTransactions.tsx:75`) using the `LetterBadge` shape at
    `ui/Badge.tsx:44-53`, and stop `display:none` stripping the T/R badges from the accessibility tree
    below `md`. (#42, #50, #49, K7, K10)

55. **[clarity] (S) Correct the privacy line and disclose the egress.**
    `AppShell.tsx:46` prints "Local-first · your data never leaves this Mac" on all 15 routes while
    three outbound destinations exist, and what goes to Anthropic includes strings like
    `CARD PURCHASE LOVE PEACE CONVENIENC BRONX NY CARD 7782` — his card's last four and his ATM's
    street address. Change the line to "your statements stay on this Mac", and put a one-time
    disclosure plus a preview of the exact strings on the Run-categorization button. Render the 10
    populated AI call records `settings.ts:90-96` already returns, under a page that claims to log
    them. (#57, #89, L8)

---

## Phase 5 — The missing surfaces (the app's biggest holes)

56. **[feature] (L) "Money in, not income" + a transfer-integrity report.** **$93,004.29 across 4,587
    rows — 47% of the ledger — has no surface anywhere in the app.** `Gifts received` is $46,928.00
    in and $0.00 out across 35 hand-categorized rows; `Internal Transfer` nets +$46,806.37, which is
    impossible for internal transfers (740 paired rows net $0.00 — the detector is sound — while 250
    unpaired legs net +$46,806). Build: a "Money in, not income" section on /spending with its own
    total and drill-down; a per-transfer-category `paired net` vs `unpaired net` report listing the
    250 orphan legs (the doctrine says single-sided hints only *flag* — nothing renders the flags);
    and **one reconciliation page**: `Δ net worth = visible net + excluded net + market Δ + anchors`.
    Three sums, and it is the only thing that stops the app's two headline numbers contradicting each
    other by $116,514.75. (#80, blind-spots PART 2)

57. **[feature] (M) A pass-through band on the net-worth chart.** Add `passThroughCents` to
    `BridgedNetWorthPoint` alongside the existing `inTransitCents` pattern (`dashboard.ts:37-40`),
    drawn as a hatched sub-band, with the hero saying "$30,963 of this is pass-through". **Every one
    of the top eight single-day net-worth moves in the 1,426-point series is a `Family pass-through`
    row**, and his all-time peak of $116,015.17 is a $29,800 wire of his father's money that the app
    already knows isn't his. Zero deletion, one new field. (#81)

58. **[feature] (M) Closed positions.** `holdingRows` (`portfolio.ts:569`) should emit zero-quantity
    legs with realized activity, flagged `closed`, and `holdingDetail` should resolve a symbol with
    `quantityE8 = 0` — today `/investments/stock/GLD` 404s. This turns the header's "+$3,018.13 · 88
    sells" back into a sum of visible rows; **$1,076.71 across 24 legs and 45 sells is currently
    unreachable**, while `price_cache` still holds full history for 25 such symbols. (#32, #B2)

59. **[feature] (M) A statement coverage map and per-account staleness on /imports.** Extend the
    `statement_periods ⋈ accounts` query already at `imports/page.tsx:51-64` into account rows ×
    month columns for the whole history, each cell reconciled / value anchor / accepted gap / open gap
    / nothing imported, with per-account last statement date and days stale. On the real DB Chase
    Checking's newest period ends **2024-07-11** and Discover's **2024-08-18** while the page reports
    "Reconciled periods 105" in green. This also gives /imports its first inbound link from anywhere.
    (#28, ADD 16)

60. **[feature] (M) A freshness + coverage strip in the shell.** One persistent line above `main`:
    balances as of {date}, N days since last import, M accounts uncovered today (named), K open gaps,
    prices as of {date}, R rows awaiting review — each segment linking to the fix. `layout.tsx:22-46`
    already does two guarded DB reads. (#7, ADD 1) *Blocked by: 43 (build `<AsOf>` first).*

61. **[feature] (M) Export.** CSV of any filtered set (stream `matchingTransactionIds`,
    `transactions-query.ts:158`) and of every table; JSON of categories/merchants/rules/anchors; a raw
    `.db` download from /settings. `grep` finds **zero** export code in the repo — the app is a
    one-way sink holding five years of reconstructed history. Table stakes at tax time and the
    cheapest possible trust win. (ADD 2)

62. **[feature] (M) A visible ⌘K trigger, plus `/merchants` and `/categories` index routes.**
    `AppShell.tsx:50-59` is a wordmark, a static tagline and a theme toggle; the palette is the ONLY
    enumeration of merchants, categories, accounts and holdings and is keyboard-only — i.e. does not
    exist on his phone. Add a "Search… ⌘K" button and a mobile magnifier (**S**), then the two index
    routes with merge, alias panel and archive (**L**): Claude wrote ~434 merchant mappings on his
    behalf and there is no screen that shows them, while duplicate merchants are structurally
    guaranteed by `claude-categorize.ts:233-249`. (#51, #31, ADD 7, ADD 19, ADD 33)

63. **[feature] (M) `?series=`, `?importFile=`, `?source=` and `sort`/`dir` on the ledger.**
    `components/transactions/query.ts:17-31` + `transactions-query.ts:47-107`. Unlocks: every
    recurring number becoming a visitable list (the doctrine's own promise, honoured everywhere except
    the surface most likely to be wrong), an auditable /imports "Txns" count beside the un-import
    button, "why is this categorized as X" as a filter, and "what were my five biggest charges in
    June" — unanswerable today on the only full-ledger filter in the app. Pair with the filtered-set
    summary strip (total in/out/net/count/span, same predicate as the counts so it reconciles by
    construction). (#27, ADD 5, ADD 13)

64. **[feature] (M) Categorize from the report that tells you to categorize.** Wire the already-built
    `components/spending/InlineCategorizeList` and `loadSpendingCategoryTxns`
    (`spending/actions.ts:15-21`, whose own docstring calls it "the Spending page's inline
    categorizer") into /spending's Honesty card, each category row's expander and the largest-purchase
    sheet. It exists, has one consumer, and /spending cannot reach it — while categorization is his
    entire working pass. (#41, ADD 8)

65. **[feature] (L) A real rule editor with a match preview.** `RulesManager` reads a vocabulary it
    cannot write. Compose the full condition set (accountIds, amount range, direction, description
    regex) and action set (category, markTransfer, exclude, renameTo, series) that
    `renderRuleSentence` (`rules-manager.ts:63-93`) can already render, with the sentence as a live
    preview and the matching **rows** shown before Re-apply. He hand-categorized ~1,300 rows over a
    full pass because he could not express "every Wise transfer from dad is a Family pass-through" as
    a rule. Add a `reason` field to disabled rules — the exact rule that produced the $52,625
    phantom-income error sits disabled at the top of that list, one click from live, with no note
    saying why. (ADD 6, #40)

66. **[feature] (M) Missed occurrences, and a cancelled/paused/skip vocabulary.**
    `recurring-calendar.ts:24-78` already computes paid / paid_different / upcoming / **missed** per
    day and no surface says "missed". Add a per-series expected-vs-actual timeline with variance and a
    link to the charge; promote `ended` to "I cancelled this"; add a `recurring_skips` overlay honoured
    by projection and forecast; auto-pause when `isSeriesActive` goes false. Rent expected on the 1st
    with nothing posted by the 10th currently says "next expected Aug 1" and never mentions July.
    (ADD 12) *Blocked by: 13.*

67. **[feature] (M) Compare to the previous period, and to last year.** `/categories/[id]`
    (`SpendDelta` is imported and unused at `page.tsx:32`), `/spending` (the prior window is already
    computed at `page.tsx:87-90` and reduced to one ghost line, and the MoM delta is gated on
    `granularity === "month"` and hidden below `md`), the recurring calendar, and the dashboard hero.
    Two thirds of the plumbing is paid for on every render and thrown away. (#54, L4, S21, S22, ADD 26)

68. **[feature] (M) Account scope and a shared period bar on every analytical surface.** Promote
    `components/spending/PeriodSelector` to `components/ui` and mount on /budgets (whose
    `budgetPaceStatuses(db, refDate)` already accepts a historical date — so "did I hit my budget last
    month" is unanswerable purely because nothing passes one), /merchants/[id], /accounts,
    /investments and the dashboard. Add an account multi-select that scopes every aggregate;
    `portfolio.ts:191,240,252` already accept `accountIds` and nothing passes them. (ADD 4, ADD 9)
    *Blocked by: 37.*

69. **[feature] (M) Notes on every entity.** One nullable column plus the existing
    `InlineEditableText` on accounts, merchants, series, budgets, holdings and categories. "This is
    dad's money, it passes through" · "Citi promo run through Carson's account" · "$50 Travel is
    deliberate, Cancun was reimbursed". Pass 24 was 16 questions of him reconstructing what merchants
    were; every answer lives in a session-memory file instead of the app. Also extend search
    (`transactions-query.ts:111-122`) to cover notes and merchant names, which makes the existing
    notes feature stop being write-only. (ADD 28, ADD 36)

70. **[feature] (M) The escape hatches that are missing.** Expose `restore` and `clearTransfer` on
    `BulkActionBar.tsx:87-95` (the patch schema already supports both, and standing in the Excluded
    tab the only buttons are a no-op Exclude and Reviewed); wire the orphaned
    `deleteManualTransactionAction` (`cash-actions.ts:38-50`, **zero callers in the repository**);
    make `runCategoryCorrection` offer single-row undo instead of only "Apply to N"; add
    `unmergeSeries`, `unacceptGap`, `reactivateBudget`, and a merchant-default clear option to
    `CategoryPicker`. (#31, #62, #63)

---

## Phase 6 — Lock it in, then be ambitious

71. **[craft] (M) Extend the test gates to cover what this audit found.** (a) assert
    `document.documentElement.scrollWidth === clientWidth` at 390/768/1024/1440 for every route —
    `grep scrollWidth e2e/` currently returns **zero** and `toHaveScreenshot` clips the viewport, so
    overflow is invisible in a baseline; (b) add `/imports`, `/merchants/[id]`, `/recurring/[id]` to
    the axe and visual sweeps and run axe at a **phone width at least once** (it has only ever run at
    1280×720); (c) a second Playwright project with `hasTouch` so the `pointer-coarse` branches
    execute at all; (d) register the nine overlay states `interaction-states.spec.ts:15-22` promised
    and never got; (e) re-point `keyboard.spec.ts` off `/design/stage-0a` — the entire keyboard gate
    runs against a page users cannot reach, which is exactly why the a11y audit found the real routes
    lacking while the gate stayed green; (f) gate `/design/stage-0a` behind
    `NODE_ENV !== "production"` (it currently serves his real net worth, un-gated, in the build);
    (g) a perf budget: ≤300 KB gz JS, ≤3,000 DOM nodes, zero `[popover] [role=option]` before
    interaction. (#43, #92, K35, ADD 23) *Blocked by: 1, 25, 28 — write the gates after the fixes so
    they lock in a green state.*

72. **[craft] (M) Give charts a keyboard and screen-reader path.** New pure `stepSelection()` in
    `lib/scrub.ts` mirroring `stepScrubIndex`, wired into `ScrubChart.onKeyDown:370-375`, so the brush
    — the app's signature gesture on five surfaces — has a non-pointer route. Make the recharts
    drill-downs reachable on /spending (`CashFlowChart.tsx:97` gates `focusable` on month buckets, so
    the page's **default** period has zero keyboard chart interaction, and the Sankey ribbons are
    `aria-hidden` with `showTableToggle` false — unreachable by keyboard, screen reader **and**
    touch). Add a shared `<ChartDataTable className="sr-only">` inside every `<figure>`, fed by the
    same `chart-window.windowedPoints` slice `ScrubTable` already renders visibly. (#48, K31, K32,
    ADD 18)

73. **[craft] (M) Add the wide-screen tier the app has never used.** Breakpoint histogram is
    `sm 42, md 34, lg 12, xl 0, 2xl 0`; measured **1320px (52%) of a 2560px viewport is empty on every
    route**, main floating asymmetric to the sidebar. Lift `AppShell.tsx:32,65`'s `max-w-5xl` at 2xl
    into a context rail + wide canvas + detail rail for the four analytical routes; step chart heights
    past `sm:` (`ScrubChart.tsx:220` stops at `h-64`; `AllocationDonut.tsx:72` is a flat `h-44` from
    320 to 2560); add a density mode persisted beside `dashboardLayout` with a reset in Settings.
    Several route-level compromises exist only because of the cap. (#69, K30, ADD 19)

74. **[craft] (M) Motion that does work.** Define `--transition-ui`/`--transition-emphasis` and swap
    the **114** bare `transition-colors` sites (which specify no timing function and therefore ignore
    all six authored easing curves — three of which are dead, and a dead token is a lie about the
    system). Add hover lift on drill-down cards, `active:scale-[0.98]` on pills, a staggered bento
    entrance, `NumberRoll` count-up on stat tiles, a highlight flash on rows that just changed after
    an undo or bulk edit, and a shared-element morph from a table row into its sheet reusing the
    view-transition machinery `ChartFocus` already proved. (#71, S19, ADD 25)

75. **[feature] (L) The "why did it change" waterfall.** For any brushed window, decompose the delta
    into income, spending, market gains/losses, transfers in/out, pass-through and coverage drift,
    reconciling exactly to the delta the chart header already shows. Composes
    `services/period-activity.ts`, `portfolio-returns.decomposeValue` (which already produces the
    exact `netContributed + gains == value` identity, unit-tested) and `in-flight.transferFloats`.
    The chart says "+$24,759 (+28.8%)" and there is no way to ask why. Every input exists; nothing new
    needs deriving. Shared by the dashboard hero, `/accounts/[id]` and `/spending`. (ADD-amb 1)
    *Blocked by: 56 (the excluded-kinds buckets are half the waterfall).*

76. **[feature] (L) Provenance drawer + basis ribbon on `/accounts/[id]`.** The headline opens a
    drawer reconstructing the level: the winning anchor it replayed from (date, source, amount), the
    count and sum of transactions replayed since, whether the chain closed to the cent, and how many
    days are carried vs derived vs missing. Under the chart, a thin band with one segment per span,
    clickable to zoom. This is the product's single best idea — "daily_balances is a derived cache,
    truth is transactions + anchors" — and the page currently shows the cache and hides the
    derivation. It also fixes, visually, the fact that a manual anchor silently loses to a statement
    anchor and that an anchor on an investment account is accepted and never read. (#29, #30,
    ADD-amb 3) *Blocked by: 47.*

77. **[feature] (L) Net worth by composition over time — the abstract one.** A stacked-area /
    streamgraph of cash vs brokerage vs crypto vs debt as bands across two years, scrubbable on the
    same day axis, with the same coverage honesty (partial days soft, gaps not invented). Ships as a
    7th option appended to the existing `DASHBOARD_VIEW_SPEC` dimension, plus a per-institution
    variant on /accounts from the combined arrays `institution-groups.ts:196-205` already computes.
    Reuses `accountSeries` + `multi-series.alignOverDays`, so it costs **no new math**. This is the
    one that is both spectacular and truthful. (ADD-amb 4)

78. **[feature] (M) Contributions vs market gains over time, and overlay compare.**
    `decomposeValue` already produces the exact identity and is unit-tested — it just needs evaluating
    per day, turning today's single static `DecompositionBar` into a stacked area. And `ScrubChart`
    already supports named `overlays` with per-series coverage splitting and a legend
    (`:294-322, 669-696`), driven today by exactly one consumer: wire sibling-account compare on
    `/accounts/[id]`, 2–3 simultaneous benchmarks on `/investments`, and holding-vs-holding on the
    symbol page. The engine is built, tested and in production on one surface. (ADD-amb 6, ADD-amb 12)

79. **[feature] (L) Cash runway and a 14-day calendar with the projected low point.** "Liquid $X ·
    N days at your current burn" with a depletion sparkline, and a day-column strip flagging the
    paycheck and marking the tightest projected day. Inputs already exist: `latestBalances`,
    `cashFlow` spend rate, `upcomingOccurrences`, `forecast.ts:325-334`. Net worth includes an $88k
    portfolio and cannot tell him whether rent clears next week — the operative question on a variable
    cash income. Fix `beforePaycheck` while here: it windows on the next income occurrence, so for a
    **weekly** earner it is structurally $0.00 (window on `max(next paycheck, +14 days)`). (#B17,
    ADD-amb 5) *Blocked by: 13.*

80. **[feature] (M) The subscription audit.** A fourth /recurring tab ranking every subscription and
    bill by annualized cost (`recurring.ts:534-537`) with an amount-history sparkline, total
    monthly-equivalent burn, cost-since-first-charge, and price-creep detection ("$9.99 → $12.99 on
    Mar 14 (+30%) … you have paid $187.44 more than the original price"). He cannot currently answer
    "how much am I committed to per year?" without adding 31 numbers by hand. (ADD-amb 7)
    *Blocked by: 39 (sortable table).*

81. **[feature] (L) The budget visualization suite + re-predict existing budgets.** /budgets is the
    only major surface with **zero** data visualization (verified by grep: no ScrubChart, Sparkline,
    StatCard, lens or focus). Per row: a 12-month actual strip with the budget as a reference line and
    a hit-rate squares strip from `categoryMonthlyTrend`. Page level: budget-vs-actual with a
    chart⇄table lens and focus, and a radial burn dial. Plus `repredictBudgets(db)` running
    `predictBudgetableCategories` over the **budgeted** set, which `predictBudgets` deliberately
    excludes — which is why "Predict budgets" returns 3 rows, 2 at 0% confidence, while 8 of his 10
    budgets are >15% off their own actuals. Design the two bar extremes at the same time (108% over
    and 4,898% over are currently pixel-identical, and `aria-valuenow` disagrees with
    `aria-valuetext`). (#70, L19, ADD-amb 8) *Blocked by: 16, 50.*

82. **[feature] (L) A statement-period timeline ribbon on /imports.** A horizontal time axis per
    account, periods as segments coloured by reconciliation state, transaction density as a histogram
    inside each segment, anchor ticks where chain-grade anchors land, and **visible white where no
    statement exists** — brushable, with a segment opening the file detail sheet. Reuses `ScrubChart`'s
    coverage band and `lib/chart-axis.ts`. It is "think abstract" pointed at the one question the
    trust layer cannot answer, and it turns the plainest screen in the app into the most striking.
    (ADD-amb 9) *Blocked by: 59.*

83. **[feature] (L) The 3D layer, as progressive enhancement.** A WebGL net-worth composition ribbon
    or symbol×day P/L surface, consuming only the existing pure, DB-free, unit-tested math
    (`multi-series.alignOverDays`, `portfolio-returns.decomposeValue`, `sankey-layout`,
    `chart-axis.niceLinearTicks`, `chart-window.windowedPoints`). Ships as an appended option on an
    existing ViewSpec dimension, behind `next/dynamic` with `ssr:false`, with a 2D fallback for
    reduced-motion and low-memory devices. Budget: three.js core + a thin r3f slice ≈ 250 KB gz,
    while items 1 and 25 return more than that. **The real blockers are not bundle size** — they are
    iOS Safari OOM (`/transactions` holds 32,557 DOM nodes and 9,098 SVG paths before any GL context),
    main-thread contention (zero Suspense boundaries, so hydration starves the first frames) and touch
    orchestration. (ADD-amb 21) *Blocked by: 1, 24, 25, 29.*

84. **[feature] (L) Hosting, tracked as a decision rather than discovered on deploy day.**
    `src/middleware.ts:14-20` 403s every Host that is not localhost — correct today, a total outage
    the moment it is deployed, and nothing in the repo says so. Replace it with real auth; move the
    client-supplied `UndoPatch` server-side behind a short-lived token or HMAC
    (`transactions/actions.ts:477-495` + `bulk-edit.ts:204-257` currently accept arbitrary row writes
    plus a rule delete by id, shape-validated only) — harmless on loopback, a cross-tenant write
    primitive the day there are two users. And pick the runtime deliberately: `better-sqlite3` is
    native and synchronous and cannot run on edge, and the pass-13 Turso investigation priced the
    async rewrite at ~68 files. (#78, ADD 35) *Blocked by: 24, 27 (a 1.4s synchronous render is a
    free-tier timeout).*

---

## Deferred deliberately

- **Trade entry (Buy/Sell/Dividend) and a trade log** (`L`) — real, but the investments half is not
  statement-fed at all (`holding_events` is written only by the manual form; the import pipeline
  deliberately discards Robinhood holdings rows at `pdf-profile.ts:171`, and the script that built the
  1,991-event timeline is no longer in the repo). Decide the *architecture* question first: does the
  importer feed positions, or does the manual form stay the source? Everything else here is downstream
  of that answer. (ADD 15)
- **Tax lots and cost-basis reconciliation** (`L`) — unrealized P/L uses broker average cost while
  realized uses an average-cost walk at daily closes, and the two sit adjacent with nothing stopping a
  reader from adding them. Add the "these are not additive" line now (item 50); build lots later. (ADD 16)
- **Mutation log / operations log** (`L`), **anomaly engine** (`L`), **alert history and period-close
  digest** (`L`), **interest and APY** (`L`), **savings goals** (`L`), **`.ics` bill export and
  shareable snapshot** (`S`), **percentage helpers in the split editor** (`S`), **prev/next sibling
  navigation on detail routes** (`S`), **first-run guided path** (`L`), **integrity checker + soft
  delete + rehearsed restore drill** (`L`), **living design system specimen route** (`M`). All are
  real and all are in `06-what-to-add.md` with their reasoning; none of them changes a wrong number or
  loses data, so none of them outranks Phases 1–4.


---

<div id="sec-09"></div>

> **▼ SECTION 09 — Blind spots — measured against the real DB**

# 09 — Blind spots: what the other 28 agents missed

**Role:** completeness critic. Everything below was found by running the app against the
**owner's real 9,753-transaction database** and by executing its own service functions
against that data — not by reading code alone. Every number is measured. Every claim
carries a `file:line`.

## How this pass was run (so you can reproduce it)

```
sqlite3 ~/Desktop/Dev/MoneyApp/data/moneyapp.db ".backup /tmp/…/live.db"   # safe copy, never written
MONEYAPP_DB_PATH=/tmp/…/live.db MONEYAPP_BACKUPS_DIR=/tmp/…/backups npx next dev -p 3117
PROBE_DB=/tmp/…/live.db npx tsx probe*.ts     # calls the real services directly
```

Real DB: 9,753 transactions, 2022-08-25 → 2026-07-14, 9 accounts, 27 recurring series,
73 categories, 88 import files. Demo DB (`data/moneyapp.db` in this worktree, and
`data/e2e.db` which every e2e test runs against): 1,673 transactions.
**Several defects below are invisible on the demo DB by construction.** That is the point.

---

# PART 1 — Cross-surface number disagreements

This is the class the brief called highest-value and it is the class that fell between
every agent's assignment. Six confirmed. All measured on real data.

## B1 — CRITICAL: 330 of the 627 "Top merchants" rows open an **empty ledger**. $34,403.46 unreachable.

`topMerchants` groups merchant-less rows by `strippedDescriptionKey()` and then builds the
drill-down link as a **full-text search for the stripped key**:

```ts
// src/services/spending.ts:685-687
href: g.kind === "merchant"
  ? ledgerHref({ merchant: g.id!, … })
  : ledgerHref({ q: g.query!, … })          // g.query = humanizeDescriptionKey(strippedKey)
```

But the ledger's `q` is a literal `LIKE '%…%'` against `raw_description` /
`normalized_description` (`src/services/transactions-query.ts:114-121`). The stripped key is a
**transformed** string — `strippedDescriptionKey` removes dates, amounts, CUSIPs and long digit
runs and trims edge punctuation off every token (`src/lib/description-key.ts:79-98`). It is a
literal substring of the description **only when stripping happened to be a no-op**.

Worked example, straight from the DB:

| | value |
|---|---|
| `raw_description` | `Card Purchase 01/25 Love & Peace Convenienc Bronx NY Card 7782` |
| `normalized_description` | `CARD PURCHASE 01/25 LOVE & PEACE CONVENIENC BRONX NY CARD 7782` |
| link generated | `?q=CARD+PURCHASE+LOVE+PEACE+CONVENIENC+BRONX+NY+CARD+7782` |
| rows matched | **0** |

The date `01/25` and the `&` token are gone from the key but present in both stored columns.
This is the **standard Chase card descriptor**, so it hits essentially every Chase row without a
merchant link — and 5,155 of 9,688 active rows have `merchant_id IS NULL`.

**Measured across the whole ledger (probe3):**

```
UNLINKED MERCHANT GROUPS (all history): ok=297   DEAD=330 (52.6%)   dead total = $34,403.46
  DEAD  n=40    $480.22  "CARD PURCHASE LOVE PEACE CONVENIENC BRONX NY CARD 7782"
  DEAD  n=13    $833.63  "RECURRING CARD PURCHASE SIMPLEMOBILE*SERVICES 877-878-7908 FL CARD 7782"
  DEAD  n=7   $1,435.00  "ATM WITHDRAWAL 4780 3RD AVE BRONX NY CARD 7782"
  DEAD  n=3   $8,410.00  "CARD PURCHASE FORDHAM U ENR SVCS 718 NY CARD 7782"
  DEAD  n=1   $1,814.72  "RESIDENT DREAMCLOUD RESIDENTHOME"
```

The same builder feeds the `TopMerchantsCard` on **`/spending` and on every
`/categories/[id]`** (`src/app/categories/[id]/page.tsx:87`). His single largest merchant-less
payee — 40 transactions — is a dead link on both.

**Why no agent and no test caught it:** on `data/e2e.db` the same probe returns
`ok=5 DEAD=0`. The demo descriptors are clean, so the entire 243-test e2e suite is
structurally incapable of seeing this.

**Fix (one line, low risk):** stop searching for a derived string. Either (a) give the ledger a
first-class `descriptionKey` filter that recomputes `strippedDescriptionKey` server-side — the
review inbox already does exactly this for its `similar` clusters
(`src/services/review-inbox.ts:25-27`) — or (b) link with `q` set to the **longest literal
token run** of the key. (a) is correct; (b) is the 20-minute version.

## B2 — CRITICAL: `/investments` header Realized P/L is **$1,076.71 more** than the table under it.

| surface | value | source |
|---|---|---|
| Portfolio header: "Realized P/L **+$3,018.13** ≈ 88 sells" | `overview.realizedPlCents` | `src/components/investments/PortfolioStats.tsx:109` |
| Holdings table, Realized column, summed over its 9 rows | **+$1,941.42 / 43 sells** | `src/components/investments/PortfolioHoldingsTable.tsx:56-68` |
| **gap** | **$1,076.71 · 45 sells** | |

`portfolioRealizedPl` walks **every** `(account, assetType, symbol)` leg in `holding_events`
(`src/services/portfolio.ts:462-466`), including fully-closed positions. `holdingRows` returns
only legs with a **live quantity** (`src/services/portfolio.ts:556`). So more than half his
realized sells belong to **24 closed positions that have no row anywhere in the app**:

```
USAR +$504.22 (3)   GLD -$207.11 (5)   MRVL +$133.02   TSM -$99.36   NOW +$75.34
UUUU +$68.23   ADBE -$56.29   PYPL -$34.70   SLV -$30.13   GD -$16.32   … 24 legs, 45 sells
```

And they are not reachable by guessing either — **`/investments/stock/GLD` returns 404**
(verified live). `price_cache` still holds full daily history for 25 such symbols
(VEU, UBER, KO, NVDA, CVX, PM, BRK.B, GOOG, …), so the data to render them exists.

**Fix:** `holdingRows` should emit zero-quantity legs that have realized activity (flagged
`closed`), and `holdingDetail` should resolve a symbol with `quantityE8 = 0`. Additive, matches
"dont delete anything", and turns the header number back into a sum of visible rows.

## B3 — Two different "projected spending" for the same month, $635.48 apart, one click from each other.

| page | number | engine |
|---|---|---|
| `/` and `/spending` | "**$6,584.31 projected**" | linear pace: `$5,734.72 × 31/27` (`src/services/spending.ts`, `projectPace`) |
| `/recurring` "Forecast · July 2026" | "Projected spending **−$1,485.07**" (remaining) → **$7,219.79** total | 3-mo trailing avg + trend (`src/services/forecast.ts:157+`) |

Both are labelled "projected". Neither says which basis it uses in a way the other can be
compared against, and no surface reconciles them. The dashboard links to *both*.
`5,734.72 + 1,485.07 = 7,219.79` vs `6,584.31` — **Δ $635.48 (9.7%)**.

**Fix:** pick one engine for the headline "projected month spend" and label the other
explicitly as "remaining fixed + variable". `/recurring`'s "Show the math" table is the better
one — it is already fully inspectable — so promote it and have `/spending`'s pace chart draw
*that* projection as its target line.

## B4 — One page, one series, two "next expected" dates — and one of them is in the past.

On `/recurring` (verified in the live HTML):

* Forecast card: `Cash job (weekly pay) · Fixed (series) · 1 × $1,046.00 (weekly), **next 2026-07-30**`
* "All" tab, Inactive table, same series: `Next **Jul 23**` ← four days *before* today (2026-07-27)

Cause: `listSeries` renders the **stored** `nextExpectedOn` verbatim
(`effectiveSeries`, `src/services/recurring.ts:642-651` → `src/services/recurring.ts:576`),
while `forecastCurrentMonth` rolls it forward past `today` via `projectOccurrences`
(`src/services/forecast.ts:126-152`). Nothing ever writes the rolled value back.

**Three series currently display a past date as "Next"** (probe12):

```
Cash job (weekly pay)  next=2026-07-23  status=confirmed  active=false
UBER *ONE              next=2025-06-25  status=detected   active=false   ← 13 months stale
Rocket Money           next=2026-06-19  status=detected   active=false
```

`UBER *ONE` is simultaneously sitting in the **"Suggestions · 3 to review"** card at
**100% confidence** asking him to *Confirm* it. The same `nextExpectedOn` column feeds
`/categories/[id]`'s series list (`src/services/category-detail.ts:146`), so the stale date
propagates.

**Fix:** `listSeries` should call `projectOccurrences(toProjectable(s), today, …)[0]` for its
displayed next date, exactly like the forecast does. One line, and it makes the two halves of
`/recurring` agree.

## B5 — Two irreconcilable answers to "how much have I put into investments?"

| surface | number |
|---|---|
| `/investments`: "Net contributed **+$81,722.99** · in $145,310.02 · out $63,587.03" | NAV-flow walk |
| the ledger's own `Investment Contribution` category | **−$20,176.60** (in $117,004.50, out $137,181.10) |

**$101,899.59 apart.** Both are defensible (the portfolio walk counts security purchases inside
the brokerage; the category counts bank→broker cash moves), but nothing on either page says so,
and there is no link between them. This is the single most confusing pair of numbers in the app
for anyone who looks at both.

## B6 — Smaller but real, all confirmed in the live render

* **`/investments`: "Month P/L +$7,300.67" sits above "Total return +$7,245.59 all time."**
  July's gain exceeds the entire history's gain. Arithmetically possible; presented with no
  explanation, twelve inches apart.
* **The same page shows "Realized by sells −$765.31 · 2 sells" (July calendar) and
  "Realized P/L +$3,018.13 ≈ 88 sells" (header)** — opposite signs, no scope label on either.
* **A credit card's balance renders positive on its row and negative in its group header, on
  the same card.** `/accounts` shows `Capital One −$11,020.45` as the institution total and
  `Venture X · ····4208 **$11,020.45**` as the row, because `SubCard` negates liabilities to
  render a magnitude (`src/components/accounts/InstitutionCard.tsx:72`) while the header sums
  signed. Same on the dashboard.
* **The nine accounts appear in two different orders on two pages.** `/accounts` orders by
  `institutions.name, displayOrder, name` (`src/services/accounts.ts:80`); the `/transactions`
  account filter orders by `displayOrder, name` with no institution join
  (`src/app/transactions/page.tsx:81`), producing
  `Chase Sapphire, Discover, Robinhood Brokerage, SoFi Checking, SoFi Savings, Venture X,
  Chase Checking, …`.

---

# PART 2 — The $93,004.29 blind spot: half the ledger has no surface at all

This is the biggest structural finding of the audit and no agent owned it, because it is not on
any page — it is what is *missing* from every page.

**The app's two number systems disagree by $116,514.75 over the ledger's life and never mention it:**

```
cash-flow, all time (periodTotals)   earned $122,594.64   spent $159,414.90   net −$31,656.41
net worth, same window                $0.00 (2022-08-24) → $84,858.34 (2026-07-19)   +$84,858.34
```

The app says "you are $31,656 in the hole" and "you gained $84,858" and offers **no surface,
chart, table or drill-down that connects the two.** 100% of that gap lives in the four category
kinds analytics deliberately excludes (`src/services/analytics.ts:16-18`) — and **nothing else
in the app totals them either**:

| category | kind | rows | money in | money out | **net** |
|---|---|---:|---:|---:|---:|
| Buys | investment | 1,901 | $38,129.27 | $145,612.19 | −$107,482.92 |
| Sells | investment | 87 | $94,415.92 | $3,610.77 | +$90,805.15 |
| **Gifts received** | transfer | 35 | **$46,928.00** | **$0.00** | **+$46,928.00** |
| Internal Transfer | transfer | 990 | $268,949.18 | $222,142.81 | +$46,806.37 |
| **Family pass-through** | transfer | 23 | $115,661.66 | $84,698.22 | **+$30,963.44** |
| Investment Contribution | transfer | 292 | $117,004.50 | $137,181.10 | −$20,176.60 |
| Reimbursements | transfer | 719 | $16,485.72 | $14,528.50 | +$1,957.22 |
| Transfers / Loans / Rewards / Credit Card Payment / system | | 540 | | | +$3,203.63 |
| **TOTAL** | | **4,587 rows (47% of the ledger)** | | | **+$93,004.29** |

Three of these are not transfers in any meaningful sense:

1. **`Gifts received` — $46,928.00 in, $0.00 out, 35 rows, all hand-categorized (`source='user'`).**
   A category with a six-month-plus inflow and literally zero outflow is not a move between his
   own accounts. Because its parent is `Transfers` (kind=`transfer`), it is excluded from income
   everywhere. The app reports his all-time income as $122,594.64; $46,928 of money that
   arrived and stayed is in no total on any screen.
2. **`Internal Transfer` nets +$46,806.37 — which is impossible for internal transfers.** Split
   by pairing state, the story is exact:
   * **740 rows with a `transfer_group_id`: net $0.00.** The detector is sound.
   * **250 rows with no pair: $63,602.33 in / $16,795.96 out.** These are single legs whose
     counterparty is not in the ledger, hand-labelled "Internal Transfer" and thereby removed
     from income. No surface reports the imbalance.
3. **`Family pass-through` — see B7 below.**

**The gap is a missing concept, not a bug.** Today a row has exactly two destinations: *income*
(counts) or *transfer* (vanishes). There is no third state for "money that arrived, isn't
earnings, and isn't a move between my own accounts". 4,587 rows are in that third state.

**What to build (additive, and this is the highest-value ADD in the whole audit):**

* A **"Money in, not income"** section on `/spending` — gifts, reimbursements, loans, unpaired
  transfers — with its own total and drill-down. It answers "where did the other $93k go?"
* A **transfer-integrity report**: per transfer category, `paired net` vs `unpaired net` and the
  250 orphan legs, listed and clickable. The doctrine says single-sided hints only *flag* —
  but nothing renders the flags.
* The **net-worth waterfall** already on the ADD list, wired to *these* buckets:
  `visible net (−$31,656) + excluded net (+$93,004) + market value change + anchors = Δ net worth`.

## B7 — The hero net-worth chart's all-time high is $30,000 of his father's money, and the app already knows it isn't his.

Largest single-day net-worth moves in the entire 1,426-point series (probe8/probe9):

```
2026-05-06  +$29,904.00   coverage 9→9   inTransit $0.00   complete=true
2026-05-07  −$26,509.58
2026-03-04  −$22,466.43
2025-12-11  +$19,226.06
2026-03-03  +$18,463.02
```

**Every one of the top eight is a `Family pass-through` row.** On 2026-05-06 a $29,800 CHIPS
wire lands in Chase Checking and on 2026-05-07 $25,000 leaves as an international wire — both
hand-categorized `Family pass-through`, both correctly excluded from income and spending. The
chart shows net worth touching **$116,015.17** that day. That is his all-time peak and the
hero's peak marker will label it.

The in-flight bridge cannot help: this is not an internal transfer, so there is no
`transfer_group_id` to bridge. Measured, the bridge corrects **200 of 1,426 days** and its
corrections are $8.70, $47.17, $100.00 — it never touches a five-figure move.

**So the "this isn't my money" law is enforced in exactly one of the two number systems.**
Analytics honours `Family pass-through`; the balance/net-worth layer has never heard of it.

**Fix (additive):** give the net-worth series the same vocabulary — a `passThroughCents` band
on `BridgedNetWorthPoint` alongside the existing `inTransitCents`
(`src/services/dashboard.ts:37-40` already establishes the pattern), drawn as a hatched
sub-band with the hero saying "$30,963 of this is pass-through". Zero deletion, one new field.

---

# PART 3 — Failures that only exist when the app is running on real data

## B8 — 87% of the net-worth chart is a partial sum, and only the last point's honesty flag is read.

```
points 1426 (2022-08-24 → 2026-07-19)     incomplete days: 1238  (87%)
coverage histogram (accounts covered → days):
   1 → 402 days      2 → 26      4 → 293      5 → 173      6 → 17      7 → 254      8 → 73      9 → 188
```

For the first **402 days** the line is drawn from **one account of nine**. `netWorthSummary`
reads `complete` only off `series.at(-1)` (`src/services/dashboard.ts:133`), which today is
`true`, so the hero reports full coverage while 87% of the curve behind it is a different
number of accounts than the point beside it. Only **188 of 1,426 days** are what the axis label
implies.

**Fix:** the series already carries `coveredAccounts/totalAccounts/missingAccounts` per point.
Render coverage as a ribbon under the chart (grey where <9, solid where 9), and label the
scrub tooltip "4 of 9 accounts". Nothing to delete; the data is already in the payload.

## B9 — The portfolio's "as of" is a **Sunday**, its equity day-change column is all zeros, and the price cache contains a fabricated close.

```
AAPL  2026-07-17  333.739990234375  yahoo
AAPL  2026-07-19  333.74            yahoo     ← Sunday. No 07-18 row at all.
ETH   2026-07-18  1861.54 / 07-19   1871.25   coinbase   ← crypto really does trade weekends
```

`refreshPrices` writes "today's quote becomes today's close" (`src/services/prices.ts:378-391`),
so running it on a weekend stamps Friday's price with **Sunday's date and `source='yahoo'`** —
indistinguishable from a real quote. Consequence in the live render: `Day %` reads **+0.00% for
8 of the 9 holdings**, while the header proudly announces "**Today +$141.95 +0.16%**" — a number
that is 100% ETH (27,355.93 × 0.52% ≈ $142).

The whole app's "today" is 2026-07-19; the actual today is 2026-07-27. Eight days and a market
closure, unlabelled.

**Fix:** stamp carried/synthetic closes with a distinct `source` (`'carry'`), don't write a
close for a day the provider didn't trade, and have the day-change column render "—  market
closed" rather than "+0.00%".

## B10 — `/transactions` ships **4.65 MB of HTML** for 50 rows. 95% of it is invisible.

Measured live against the real DB:

```
/transactions            4,647,518 bytes   role="option" ×3,650   role="listbox" ×50
/transactions?view=review  240,974 bytes   (0 rows)
```

⇒ **88 KB of HTML per visible ledger row.** Each row renders a closed category picker
containing all **73** categories. Other agents said "95% invisible markup"; nobody put a number
on it, and the number is what makes it a P0 for a phone. `/` is 1.40 MB for the same reason —
it server-renders **all five dashboard view-modes' chart payloads** (Net worth / Assets / Owed /
Split / Accounts / Flow) when one is visible.

**Fix:** render the listbox on open (one shared portal instance keyed by row id). This is the
single biggest mobile win available and it deletes nothing users can see.

## B11 — Four statements imported **zero transactions** and the page reports "Open gaps 0".

```
88 import files · all status='parsed' · 4 produced 0 transactions
```

`/imports` renders them identically to successful ones — "Parsed", `Txns 0`, an `un-import`
link — under a header that promises *"Every statement must reconcile: beginning + transactions
= ending, to the cent, or it is flagged with its exact gap"* and a stat card reading
**"Open gaps 0"**. A statement that parsed to nothing is the most likely real failure mode of a
PDF pipeline, and it is the one state the page cannot express.

**Fix:** `Txns 0` is a failure, not a status. Badge it, exclude it from "Reconciled periods",
and let "Open gaps" count it.

## B12 — An out-of-range page shows the *filter* empty state and a live pager.

`GET /transactions?page=99999` (live, 200 OK) renders:

> **No matching transactions** — Nothing matches the current filters. Adjust them or reset to
> see everything.
> Page **99999 of 194** · 9688 transactions   [Previous] [Next]

The filters match 9,688 rows. The copy blames the filters, the pager prints an impossible
ordinal as fact, and `Previous` walks back one page at a time from 99,999.

**Fix:** clamp `page` to `[1, pageCount]` in `parseFilters` (`src/components/transactions/query.ts:58`)
— it already validates every other param.

---

# PART 4 — Fell between two agents (nobody owned these)

## B13 — The app prints a privacy promise on all 15 routes that is **false**.

```tsx
// src/components/shell/AppShell.tsx:46
Local-first · your data never leaves this Mac
```

Rendered in the persistent chrome of every page. Meanwhile:

| destination | what leaves | code |
|---|---|---|
| `api.anthropic.com` | normalized merchant descriptions, batched | `src/services/claude-categorize.ts:164` |
| Yahoo Finance | every holding symbol | `src/services/prices.ts:74` |
| `api.exchange.coinbase.com` | crypto symbols | `src/services/prices.ts:127,135` |

And the descriptions are not anonymous. `normalizeDescription` only strips 5+-digit runs
(`src/lib/normalize.ts:29`), so what is actually sent includes strings like
`CARD PURCHASE LOVE PEACE CONVENIENC BRONX NY CARD 7782` — **his card's last four and the street
address of his ATM**. `/transactions` currently offers "Classify **11** merchants with Claude".

Another agent noted "third parties' names leave the machine with no disclosure". The sharper
fact is that the app makes the opposite claim, in the header, permanently. Before hosting this
with auth, that line is a liability.

**Fix:** change the line to "Local-first · your statements stay on this Mac", and put a
one-time disclosure + a preview of the exact strings on the "Run categorization" button.

## B14 — Root cause of the owner's open "the Claude button stopped working" bug.

`.gitignore:12` ignores `.env*` (keeping only `.env.example`). Therefore:

```
~/Desktop/Dev/MoneyApp/.env                                       exists (188 B, Jul 10)
~/…/.claude/worktrees/app-polish-adversarial-review-e80abb/.env    DOES NOT EXIST
```

**Every dev server started from a git worktree has no `ANTHROPIC_API_KEY`.** With no key,
`classifyPendingMerchants` returns `{ ran: false }` immediately
(`src/services/claude-categorize.ts:131-135`) and the action redirects with a `no-api-key`
notice (`src/app/transactions/actions.ts:155-156`). The key itself is fine. This matches the
owner's memory note ("Claude button likely fails on an expired key") — it is neither expired
nor deleted; it is *absent from the worktree*.

Compounding it: `/settings` says "**No ANTHROPIC_API_KEY** — the app fully works" while
`/transactions`, on the same boot, renders "Run categorization · Classify 11 merchants with
Claude ≈ $0.01 est." with no hint. Two pages, one environment variable, no shared truth.

**Fix:** `git config --local` a symlink or copy `.env` into worktrees; and gate the
`/transactions` HeaderStrip button on the same `Boolean(process.env.ANTHROPIC_API_KEY)` that
`src/app/settings/page.tsx:34` already computes.

## B15 — The backups directory is **80 files / 505 MB** under a UI that promises 20.

`/settings` states: *"Backups keep 14 daily + 6 monthly snapshots."* Reality in
`~/Desktop/Dev/MoneyApp/data/backups`:

```
80 files · 505 MB
   15  daily-* / monthly-*          ← the only files retention governs
   65  pre-rh-cash-*, pre-sofi-replace-*, pre-stage3-backfill-*, pre-stage4a-*,
       and orphaned .db-wal / .db-shm siblings   ← grow forever, never listed, never pruned
```

Retention only prunes what it names. The ad-hoc `pre-*` snapshots (written by the guarded
real-DB write scripts) and every `-wal`/`-shm` sibling accumulate indefinitely, and the Settings
list filters them out — so the page describes 15 files while the directory holds 80 and half a
gigabyte. A first boot on a new day writes 2 × 12.8 MB.

**Fix:** list everything the directory contains with size and a total, and say which files
retention governs. (Restore is already on the register; this is about honesty of the list.)

## B16 — `/design/stage-0a` is a live route serving **his real net worth**, and it is the only page the keyboard test suite covers.

`GET /design/stage-0a` → **200, 341 KB**, titled *"Stage-0a design preview — real ledger rows,
new identity system. Sign-off gates the app-wide sweep,"* rendering **"This month $5,734.72"**
and **"Net worth $84,858.34"**. No env gate, no `noindex`, not in the nav, ships in the build.

Worse — and this is the answer to "the gap between what the 243 e2e tests assert and what a
human would notice", written by the test suite itself:

```ts
// e2e/keyboard.spec.ts:9
 * and Esc precedence — against the /design/stage-0a preview, the only surface …
// e2e/keyboard.spec.ts:18
const PREVIEW = "/design/stage-0a";
```

**The keyboard-grammar gate runs against a page users cannot reach.** That is precisely why the
a11y agent found the real routes lacking while the gate stayed green. `e2e/a11y.spec.ts:23`
scans it too, inflating the "all routes pass axe" claim by one route that is not a route.

**Fix:** either promote the preview's grammar to the real surfaces and point the spec at
`/transactions`, or gate the route behind `process.env.NODE_ENV !== "production"`. Do not
delete it — but it must not be the thing the gate proves.

## B17 — "Spending owed before your next paycheck" is structurally $0.00 for a weekly earner.

Live dashboard, real data: `beforePaycheck: $0.00 before 2026-07-30`.

`upcomingBills` finds the next income occurrence and sums the *bills dated on or before it*
(`src/services/dashboard.ts:151-161`). With a **weekly** income series the window is ≤7 days, so
the answer is $0.00 nearly always — the rent that matters ($2,285.70) falls on Aug 8, after the
next three paychecks. The widget is designed for a biweekly/monthly earner and silently degrades
to a constant for this user.

It is worse than useless here because the paycheck it anchors on is the **dead** `Cash job`
series (see B4): `/recurring` files it under **"Inactive 1"**, its calendar shows
**"Upcoming +$0.00"** for July, and the dashboard still projects **4 occurrences totalling
+$4,184** in the next 30 days. Measured (probe12):

```
Upcoming(30d): 10 occurrences, net +$1,818.11
   of which from INACTIVE series: 6 occurrences, +$4,173.01
```

**Fix:** window on `max(next paycheck, +14 days)` and label it "bills due before Aug 10"; and
apply `isSeriesActive` at both `upcomingOccurrences` and `fixedComponents` call sites (already
on the register as V1 — this is the real-data proof of how bad it is).

## B18 — "Free to spend ≈ −$4,538.72"

The dashboard's most decision-relevant number renders as a negative "free to spend"
(live HTML; `src/services/dashboard.ts:196-200`). "Free to spend" has no negative branch in
copy or colour. It should read **"Over by $4,538.72"** with the negative tone, and probably
should say what it is over *against*.

---

# PART 5 — Corrections: two register findings are **not true** on this database

I am the completeness critic; the register is also incomplete in the other direction.

* **"Transfers … spending is silently inflated in one direction."** Measured: all **1,166**
  rows carrying a `transfer_group_id` are also in a `transfer`-kind category. **Zero** rows are
  paired-but-spending-categorised, and **zero** are paired-but-uncategorised. The
  double-counting direction does not exist here. Only the *hiding* direction is real, and its
  size is Part 2 (1,403 transfer-category rows with no pair).
* **"The review queue … re-inflates after every import; the one journey with a finish line
  cannot be finished."** Measured: `needsReviewCount = 0`, `reviewInbox.totalCount = 0`,
  `clusterCount = 0`. He finished it. The dashboard correctly renders *"Nothing to review —
  every transaction is categorized and confirmed."* The *empty* state of the review queue is
  therefore the state he will live in — and it currently gets one sentence and no next action,
  which is the finding that should replace the old one.
* **"The `source='user'` shield has two holes."** Whatever is true of the AI paths, the
  **rules** path is clean and should not be "fixed": `retroApplyRule` filters with
  `{ excludeUserSet: true }` (`src/services/rule-corrections.ts:209`) and `previewRuleMatches`
  uses the identical predicate (`src/services/rules-manager.ts:138`), so the blast-radius badge
  and the write agree and neither can touch a hand-categorized row. Given that 35 of his
  `Gifts received` rows and 434 hand-categorized merchants carry `source='user'`, this shield is
  load-bearing — verify before touching it.

---

# PART 6 — Shallowest route, and what a deeper pass finds

**`/settings` got the thinnest audit** (one agent, bundled with rules). One live look at it on
real data produced two defects nobody listed — B14 (it contradicts `/transactions` about whether
the API key exists) and B15 (retention copy vs 80 files / 505 MB) — plus this, verified in the
live HTML:

The Rules card shows a **disabled** rule reading *"When a transaction is money in and matches
`/ATM|CASH DEPOSIT/` and is at least $200, categorize it as Income › Salary and set its merchant
to Employer (cash) · applied 3 × · disabled · [Enable]"*. That is the exact rule that produced
the $52,625 phantom-income error the owner spent a whole pass unwinding, sitting one click from
being live, with no note saying why it was turned off. `listRules` deliberately zeroes
`matchCount` for disabled rules (`src/services/rules-manager.ts:159-160`), so re-enabling it
shows a blast radius of nothing until the next import runs it. A disabled rule needs a reason
field and the Enable button needs to state what it will do on the next import.

**Second-thinnest: `/imports`** — B11 is the whole finding, and it is a *data-loss-shaped* one.

---

# PART 7 — Adds that are missing from the 130-item ADD list

Ranked by value to this owner, on this data.

1. **"Money in, not income" surface + transfer-integrity report.** $93,004.29 / 4,587 rows have
   no page. Nothing else on the ADD list covers it. (Part 2)
2. **A pass-through band on the net-worth chart.** His all-time high is his father's wire. (B7)
3. **Closed positions.** A `/investments` "Closed" tab and a `holdingDetail` that resolves
   `quantity = 0`, so the header's 88 sells are all reachable and `GET /investments/stock/GLD`
   stops 404-ing. (B2)
4. **A coverage ribbon under every balance chart**, driven by the `coveredAccounts` the series
   already carries. 87% of the hero curve needs it. (B8)
5. **"Markets were closed" state** for price-derived numbers, and a real `source='carry'` for
   synthetic closes. (B9)
6. **A `descriptionKey` filter on `/transactions`** — fixes B1 properly, and unlocks
   "every transaction shaped like this one" as a first-class, shareable URL for the 5,155
   merchant-less rows.
7. **One reconciliation page**: `Δ net worth = visible net + excluded net + market Δ + anchors`.
   It is the only thing that would make the app's two headline numbers stop contradicting
   each other, and it is three sums.

---

# Appendix — every measurement in one block

```
DB: 9,753 txns (9,688 active, 65 excluded) · 2022-08-25→2026-07-14 · 9 accounts · 73 categories
    27 recurring series (4 confirmed, 3 detected, 9 dismissed, 11 ended) · 88 import files

net worth (hero)              $84,858.34   asOf 2026-07-19  (assets 97,311.03 + liabilities −12,452.69) ✓
portfolio value               $88,968.58   = Σ holdingRows = allocationSlices total ✓
cash-flow all-time            earned $122,594.64 · spent $159,414.90 · net −$31,656.41
excluded kinds all-time       +$93,004.29 across 4,587 rows
Gifts received                +$46,928.00 in / $0.00 out / 35 rows / source='user'
Internal Transfer paired      740 rows, net $0.00        unpaired 250 rows, net +$46,806.37
Family pass-through           in $115,661.66 / out $84,698.22 / net +$30,963.44 / 23 rows
July 2026                     spent $5,734.72 · earned $150.00 · uncategorized $0.00 · excluded 1
projections for July          /spending $6,584.31   vs   /recurring $7,219.79   (Δ $635.48)
realized P/L                  header $3,018.13 / 88 sells   table $1,941.42 / 43   ghost $1,076.71 / 45 / 24 legs
unlinked merchant groups      627 total · 330 dead links · $34,403.46
net-worth series              1,426 points · 1,238 incomplete (87%) · bridge corrects 200 days
biggest daily jumps           top 8 are all Family pass-through
/transactions HTML            4,647,518 bytes · 3,650 role="option" · 50 listboxes · 73 categories
import files with 0 txns      4 of 88, all status='parsed', page reports "Open gaps 0"
backups                       80 files / 505 MB vs UI copy "14 daily + 6 monthly"
demo DB (what e2e runs on)    unlinked groups 5 · dead links 0 · pass-through rows 0
```

Categories reconcile exactly: for all 10 top-level expense categories in July,
`categoryBreakdown` (the `/spending` table) == `categorySpending` (the `/categories/[id]`
headline) == the row count the drill-down href actually returns. That contract holds. The
failures above are all *outside* it.


---

*End of dossier. 92 defects, 97 changes, 62 additions, 15 routes, 84 backlog items.
Every claim carries a `file:line`; every rejected claim is recorded in section 04.*
