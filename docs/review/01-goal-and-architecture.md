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
